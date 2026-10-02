// Asset Availability Calendar V1 (Phase 2, slice 6): read-only, derived only from open assignments + asset status. One shared
// query serves global / catalog-node / single-asset scope. Employees get an anonymous, narrower view; admins get holders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const availability = require('../src/availability');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const node = async (name, parent_id = null) => { const r = await admin.post('/api/catalog', { name, parent_id }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
// (creating an asset ignores a non-default status, so a status is applied afterwards, as an admin edit would)
const newAsset = async (name, { status, ...extra } = {}) => {
  const r = await admin.post('/api/assets', { name, tag: `AV-${++seq}`, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (status) db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, r.body.id);
  return r.body;
};
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `av${++seq}@nutricost.com`, invite: true, department: 'Secret Dept' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name };
}
const checkout = async (asset, who, extra = {}) => { const r = await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.assignment; };
const cal = async (who, q = '') => who.get('/api/availability' + q);
const ok = async (who, q = '') => { const r = await cal(who, q); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const names = (body) => body.assets.map((a) => a.name).sort();
// the state of an asset on a date (fetches the month that date is in)
const stateOn = async (who, scopeQ, assetId, date) => {
  const body = await ok(who, `?${scopeQ}${scopeQ ? '&' : ''}month=${date.slice(0, 7)}`);
  const a = body.assets.find((x) => x.id === assetId);
  assert.ok(a, 'asset is in the scope');
  return a.days[Number(date.slice(8)) - 1];
};

// ---------------------------------------------------------------- scope: one shared model for global / node / asset
test('node scope covers the whole subtree and nothing else; deep nesting works; unrelated branches are excluded', async () => {
  const root = await node(`Scope Root ${++seq}`);
  const brand = await node('Brand', root.id);
  const model = await node('Model', brand.id);
  const other = await node(`Other Root ${seq}`);
  const aRoot = await newAsset('At root', { catalog_node_id: root.id });
  const aBrand = await newAsset('At brand', { catalog_node_id: brand.id });
  const aModel = await newAsset('At model', { catalog_node_id: model.id });
  const aOther = await newAsset('At other', { catalog_node_id: other.id });
  assert.deepEqual(names(await ok(admin, `?node=${root.id}`)), ['At brand', 'At model', 'At root']);
  assert.deepEqual(names(await ok(admin, `?node=${brand.id}`)), ['At brand', 'At model']);
  assert.deepEqual(names(await ok(admin, `?node=${model.id}`)), ['At model']);
  assert.deepEqual(names(await ok(admin, `?node=${other.id}`)), ['At other']);
  const scope = (await ok(admin, `?node=${model.id}`)).scope;
  assert.deepEqual([scope.type, scope.id, scope.title, scope.path], ['node', model.id, 'Model', `${root.name} > Brand > Model`]);
  void aRoot; void aBrand; void aModel; void aOther;
});

test('global scope includes eligible assets from across the catalog; asset scope returns exactly that asset', async () => {
  const x = await node(`Global X ${++seq}`); const y = await node(`Global Y ${seq}`);
  const ax = await newAsset('Global in X', { catalog_node_id: x.id });
  const ay = await newAsset('Global in Y', { catalog_node_id: y.id });
  const unlinked = await newAsset('Global unlinked', { category: 'Weird Thing' });
  const all = await ok(admin);
  assert.equal(all.scope.type, 'global');
  for (const a of [ax, ay, unlinked]) assert.ok(all.assets.some((r) => r.id === a.id), a.name);
  const one = await ok(admin, `?asset=${ax.id}`);
  assert.deepEqual([one.scope.type, one.scope.id, one.assets.map((a) => a.id)], ['asset', ax.id, [ax.id]]);
});

test('invalid or conflicting scope is rejected safely', async () => {
  assert.equal((await cal(admin, '?node=abc')).status, 400);
  assert.equal((await cal(admin, '?asset=abc')).status, 400);
  assert.equal((await cal(admin, '?node=999999')).status, 404);
  assert.equal((await cal(admin, '?asset=999999')).status, 404);
  assert.equal((await cal(admin, '?node=1&asset=1')).status, 400, 'one scope at a time');
  assert.equal((await cal(admin, '?month=2026-13')).status, 400);
  assert.equal((await cal(admin, '?month=nope')).status, 400);
  assert.equal((await cal(admin, '?month=1999-12')).status, 400);
  assert.equal((await makeClient(server).get('/api/availability')).status, 401, 'sign-in required');
});

// ---------------------------------------------------------------- availability semantics
test('a free, lendable asset is available on every day from today; earlier days carry no state', async () => {
  const a = await newAsset('Free laptop');
  const body = await ok(admin, `?asset=${a.id}&month=${TODAY.slice(0, 7)}`);
  const days = body.assets[0].days;
  assert.equal(days.length, body.last.slice(8) * 1);
  days.forEach((s, i) => assert.equal(s, `${TODAY.slice(0, 8)}${String(i + 1).padStart(2, '0')}` < TODAY ? 'past' : 'available', `day ${i + 1}`));
  assert.equal(body.assets[0].state, 'available');
});

test('an active permanent assignment makes the asset unavailable today and on every future day (no invented return date)', async () => {
  const me = await makeLogin('Permanent Holder');
  const a = await newAsset('Permanent laptop');
  await checkout(a, me, { assignment_type: 'permanent' });
  const q = `asset=${a.id}`;
  for (const d of [TODAY, plus(1), plus(40), plus(200)]) assert.equal(await stateOn(admin, q, a.id, d), 'occupied', d);
  const p = (await ok(admin, `?${q}`)).assets[0].periods;
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].kind, p[0].end, p[0].open_ended], ['occupied', null, true]);
});

test('a temporary checkout is occupied through its due date, then only EXPECTED back — never called available', async () => {
  const me = await makeLogin('Temp Holder');
  const a = await newAsset('Loaner laptop');
  const due = plus(5);
  await checkout(a, me, { assignment_type: 'checkout', due_date: due, due_time: '16:00' });
  const q = `asset=${a.id}`;
  assert.equal(await stateOn(admin, q, a.id, TODAY), 'occupied');
  assert.equal(await stateOn(admin, q, a.id, due), 'occupied', 'the due date itself is still out');
  assert.equal(await stateOn(admin, q, a.id, plus(6, TODAY)), 'expected');
  assert.equal(await stateOn(admin, q, a.id, plus(90)), 'expected', 'still only expected far in the future');
  const p = (await ok(admin, `?${q}`)).assets[0].periods;
  assert.deepEqual(p.map((x) => [x.kind, x.start === TODAY ? 'today' : x.start, x.end]), [['occupied', 'today', due], ['expected', plus(1, due), null]]);
  assert.equal(p[0].due_time, '16:00');
});

test('an overdue checkout stays occupied into the future: the return date has passed and nothing says when it will come back', async () => {
  const me = await makeLogin('Overdue Holder');
  const a = await newAsset('Overdue laptop');
  await checkout(a, me, { assignment_type: 'checkout', due_date: plus(3) });
  db.prepare("UPDATE assignments SET due_date = ? WHERE asset_id = ?").run(plus(-2), a.id);
  assert.equal(await stateOn(admin, `asset=${a.id}`, a.id, TODAY), 'occupied');
  assert.equal(await stateOn(admin, `asset=${a.id}`, a.id, plus(30)), 'occupied');
  const p = (await ok(admin, `?asset=${a.id}`)).assets[0].periods[0];
  assert.deepEqual([p.overdue, p.open_ended, p.end], [true, true, null]);
});

test('repair, retired, lost and disposed are unavailable on every future day, and archived assets are only shown when asked for directly', async () => {
  const repair = await newAsset('Repair laptop', { status: 'maintenance' });
  const retired = await newAsset('Retired laptop', { status: 'retired' });
  const lost = await newAsset('Lost laptop', { status: 'lost' });
  const disposed = await newAsset('Disposed laptop', { status: 'disposed' });
  const arch = await newAsset('Archived laptop');
  assert.equal((await admin.post(`/api/assets/${arch.id}/archive`, {})).status, 200);
  const expected = { [repair.id]: 'repair', [retired.id]: 'ineligible', [lost.id]: 'ineligible', [disposed.id]: 'ineligible' };
  for (const [id, s] of Object.entries(expected)) {
    for (const d of [TODAY, plus(60)]) assert.equal(await stateOn(admin, `asset=${id}`, Number(id), d), s, `${id} on ${d}`);
  }
  assert.equal(await stateOn(admin, `asset=${arch.id}`, arch.id, plus(2)), 'archived');
  const everything = await ok(admin);
  assert.ok(!everything.assets.some((a) => a.id === arch.id), 'archived assets are not part of global/node scopes');
  assert.ok(everything.assets.some((a) => a.id === repair.id), 'but repair/retired ones are, as unavailable');
});

test('a multi-seat license is available while any seat is free, occupied only when every seat is taken', async () => {
  const a = await newAsset('Seat license', { license_seats: 2 });
  const p1 = await makeLogin('Seat One'); const p2 = await makeLogin('Seat Two');
  await checkout(a, p1, { assignment_type: 'permanent' });
  const q = `asset=${a.id}`;
  assert.equal(await stateOn(admin, q, a.id, plus(10)), 'available', 'one of two seats free');
  const one = (await ok(admin, `?${q}`)).assets[0];
  assert.deepEqual(one.seats, { total: 2, used: 1 });
  await checkout(a, p2, { assignment_type: 'checkout', due_date: plus(4) });
  assert.equal(await stateOn(admin, q, a.id, plus(2)), 'occupied');
  assert.equal(await stateOn(admin, q, a.id, plus(8)), 'expected', 'a seat is due back by then, but not guaranteed');
});

test('returning an asset frees it again', async () => {
  const me = await makeLogin('Returner');
  const a = await newAsset('Returned laptop');
  await checkout(a, me, { assignment_type: 'permanent' });
  assert.equal(await stateOn(admin, `asset=${a.id}`, a.id, plus(3)), 'occupied');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  assert.equal(await stateOn(admin, `asset=${a.id}`, a.id, plus(3)), 'available');
});

test('the pure day-state function agrees with the conservative rules', () => {
  const asset = { status: 'available', archived_at: null, license_seats: null };
  const perm = { assignment_type: 'permanent', due_date: null };
  const temp = { assignment_type: 'checkout', due_date: '2030-01-10' };
  const T = '2030-01-01';
  const s = (a, held, d) => availability.dayState(a, held, d, T);
  assert.equal(s(asset, [], '2029-12-31'), 'past');
  assert.equal(s(asset, [], T), 'available');
  assert.equal(s(asset, [perm], '2031-01-01'), 'occupied');
  assert.equal(s(asset, [temp], '2030-01-10'), 'occupied');
  assert.equal(s(asset, [temp], '2030-01-11'), 'expected');
  assert.equal(s({ ...asset, status: 'maintenance' }, [], T), 'repair');
  assert.equal(s({ ...asset, archived_at: 'x' }, [], T), 'archived');
  assert.deepEqual(availability.periodsFor({ checked_out_at: '2030-01-01 09:00:00', assignment_type: 'permanent' }, T).map((p) => p.open_ended), [true]);
});

// ---------------------------------------------------------------- privacy: employees
test('employee responses never expose who holds anything: no names, departments, emails, notes or ids of holders', async () => {
  const holder = await makeLogin('Zelda Holderson');
  const me = await makeLogin('Viewer Person');
  const n = await node(`Privacy Node ${++seq}`);
  const a = await newAsset('Private laptop', { catalog_node_id: n.id });
  await checkout(a, holder, { assignment_type: 'checkout', due_date: plus(7), notes: 'SECRET NOTE about Zelda' });
  for (const q of [`?node=${n.id}`, `?asset=${a.id}`, '']) {
    const r = await cal(me.client, q);
    assert.equal(r.status, 200, q);
    const text = JSON.stringify(r.body);
    for (const leak of ['Zelda', 'Holderson', 'Secret Dept', '@nutricost.com', 'SECRET NOTE', 'holder', 'department', 'assignment_id']) assert.ok(!text.includes(leak), `${q} leaks ${leak}`);
  }
  const mine = (await ok(me.client, `?asset=${a.id}`)).assets[0];
  assert.equal(mine.state, 'occupied');
  assert.deepEqual(mine.periods.map((p) => [p.kind, p.end]), [['occupied', plus(7)], ['expected', null]], 'known dates are shown');
  assert.equal(mine.tag, null, 'no tag for something they could not open anyway');
  assert.equal(mine.can_open, false);
  // the same calendar for an admin does carry the holder
  const adminView = (await ok(admin, `?asset=${a.id}`)).assets[0];
  assert.equal(adminView.periods[0].holder.name, 'Zelda Holderson');
  assert.equal(adminView.periods[0].holder.department, 'Secret Dept');
});

test('employees see only lendable-looking assets; repair, retired, lost, disposed and archived ones are invisible, and asking for one directly is a 404', async () => {
  const me = await makeLogin('Narrow Viewer');
  const n = await node(`Narrow ${++seq}`);
  const ok1 = await newAsset('Narrow ok', { catalog_node_id: n.id });
  const hidden = [
    await newAsset('Narrow repair', { catalog_node_id: n.id, status: 'maintenance' }),
    await newAsset('Narrow retired', { catalog_node_id: n.id, status: 'retired' }),
    await newAsset('Narrow lost', { catalog_node_id: n.id, status: 'lost' }),
    await newAsset('Narrow disposed', { catalog_node_id: n.id, status: 'disposed' }),
  ];
  const arch = await newAsset('Narrow archived', { catalog_node_id: n.id });
  await admin.post(`/api/assets/${arch.id}/archive`, {});
  assert.deepEqual(names(await ok(me.client, `?node=${n.id}`)), ['Narrow ok']);
  assert.deepEqual(names(await ok(admin, `?node=${n.id}`)), ['Narrow lost', 'Narrow disposed', 'Narrow ok', 'Narrow repair', 'Narrow retired'].sort());
  for (const a of [...hidden, arch]) assert.equal((await cal(me.client, `?asset=${a.id}`)).status, 404, a.name);
  assert.equal((await cal(me.client, `?asset=${ok1.id}`)).status, 200);
  // the tag is shown for what they could already open
  assert.equal((await ok(me.client, `?asset=${ok1.id}`)).assets[0].tag, ok1.tag);
});

test('an employee sees what they hold themselves, marked as theirs — and it stays visible even in repair', async () => {
  const me = await makeLogin('Holds One');
  const a = await newAsset('Mine laptop');
  await checkout(a, me, { assignment_type: 'permanent' });
  const view = (await ok(me.client, `?asset=${a.id}`)).assets[0];
  assert.deepEqual([view.mine, view.state, view.can_open], [true, 'occupied', true]);
  assert.equal(view.periods[0].mine, true);
  db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(a.id);
  assert.equal((await cal(me.client, `?asset=${a.id}`)).status, 200);
});

test('employees can only scope to live catalog entries; archived entries are a 404 for them but fine for admins', async () => {
  const me = await makeLogin('Live Only');
  const n = await node(`Soon archived ${++seq}`);
  const child = await node('Child', n.id);
  const a = await newAsset('In archived child', { catalog_node_id: child.id });
  assert.equal((await cal(me.client, `?node=${n.id}`)).status, 200);
  assert.equal((await admin.post(`/api/catalog/${n.id}/archive`, {})).status, 200);
  assert.equal((await cal(me.client, `?node=${n.id}`)).status, 404);
  assert.equal((await cal(me.client, `?node=${child.id}`)).status, 404, 'a live child of an archived parent is not live');
  assert.equal((await cal(admin, `?node=${n.id}`)).status, 200);
  assert.ok((await ok(admin, `?node=${n.id}`)).assets.some((x) => x.id === a.id));
});

test('the calendar does not widen asset access: asset pages and lists keep their rules', async () => {
  const holder = await makeLogin('Hidden Holder');
  const me = await makeLogin('Still Blocked');
  const a = await newAsset('Held elsewhere');
  await checkout(a, holder, { assignment_type: 'permanent' });
  assert.equal((await cal(me.client, `?asset=${a.id}`)).status, 200, 'its availability is anonymous and visible');
  assert.equal((await me.client.get(`/api/assets/${a.id}`)).status, 404, 'its record is still not');
  assert.ok(!(await me.client.get('/api/assets')).body.some((x) => x.id === a.id), 'and it is still not in the employee list');
});

// ---------------------------------------------------------------- front end: URL-backed scope, source and Back
const appSrc = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// The real helper code (URL building, safeFrom, calBackTarget) run against a stubbed api, so labels/destinations are asserted for real.
function loadBackHelpers({ admin }) {
  const vm = require('node:vm');
  const src = appSrc();
  const block = src.slice(src.indexOf('const calUrl ='), src.indexOf('async function viewCalendar()'));
  const calls = [];
  const ctx = {
    URLSearchParams, isAdmin: () => admin, qs: () => new URLSearchParams(''), go: () => {}, document: { addEventListener: () => {} }, location: { hash: '' }, icon: () => '',
    api: async (method, url) => {
      calls.push(url);
      if (url.startsWith('/api/catalog')) return [{ id: 7, name: 'Appliance' }, { id: 9, name: 'A7 IV' }];
      if (url === '/api/assets/5') return { asset: { name: 'Dell Latitude 5440' } };
      if (url === '/api/users/3') return { user: { name: 'Casey Chen' } };
      throw new Error('not found');
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}; this.h = { calUrl, safeFrom, calBackTarget, calendarLink };`, ctx);
  return { h: ctx.h, calls };
}

test('front end: Back target for every way into the calendar — label says where it goes, destination is the source route from the URL', async () => {
  const emp = loadBackHelpers({ admin: false }).h;
  const adm = loadBackHelpers({ admin: true }).h;
  const node = (id, title) => ({ type: 'node', id, title });
  const asset = (id, title) => ({ type: 'asset', id, title });
  const back = async (h, from, sc) => { const r = await h.calBackTarget(from, sc); return [r.label, r.href]; };
  // employee
  assert.deepEqual(await back(emp, '#/assets', { type: 'global' }), ['Browse equipment', '#/assets'], 'Browse root');
  assert.deepEqual(await back(emp, '#/assets?node=7', node(7, 'Appliance')), ['Appliance', '#/assets?node=7'], 'Browse nested node (name from the scope)');
  assert.deepEqual(await back(emp, '#/assets?node=9', { type: 'global' }), ['A7 IV', '#/assets?node=9'], 'Browse node (name looked up)');
  assert.deepEqual(await back(emp, '#/asset/5?src=browse&node=7', asset(5, 'Dell Latitude 5440')), ['Dell Latitude 5440', '#/asset/5?src=browse&node=7'], 'asset detail keeps its own context');
  assert.deepEqual(await back(emp, '', { type: 'global' }), ['Browse equipment', '#/assets'], 'direct link: employee fallback');
  // admin
  assert.deepEqual(await back(adm, '#/catalog', { type: 'global' }), ['Equipment catalog', '#/catalog'], 'catalog root');
  assert.deepEqual(await back(adm, '#/catalog?node=7', node(7, 'Appliance')), ['Appliance', '#/catalog?node=7'], 'catalog node');
  assert.deepEqual(await back(adm, '#/catalog?node=9&all=1', { type: 'global' }), ['A7 IV', '#/catalog?node=9&all=1'], 'catalog "All in" view is preserved');
  assert.deepEqual(await back(adm, '#/assets', { type: 'global' }), ['All assets', '#/assets'], 'All assets');
  assert.deepEqual(await back(adm, '#/assets?status=checked_out', { type: 'global' }), ['All assets', '#/assets?status=checked_out'], 'All assets keeps its filter');
  assert.deepEqual(await back(adm, '#/asset/5?src=catalog&node=7', asset(5, 'Dell Latitude 5440')), ['Dell Latitude 5440', '#/asset/5?src=catalog&node=7'], 'asset detail');
  assert.deepEqual(await back(adm, '#/asset/5', { type: 'global' }), ['Dell Latitude 5440', '#/asset/5'], 'sidebar from an asset page: asset name looked up');
  assert.deepEqual(await back(adm, '#/person/3', { type: 'global' }), ['Casey Chen', '#/person/3'], 'sidebar from a person page');
  for (const [from, label] of [['#/home', 'Home'], ['#/people', 'People'], ['#/requests', 'Requests'], ['#/settings', 'Settings'], ['#/activity', 'Activity log'], ['#/labels', 'Print labels'], ['#/import', 'Import / export']]) {
    assert.deepEqual(await back(adm, from, { type: 'global' }), [label, from], `sidebar from ${from}`);
  }
  assert.deepEqual(await back(adm, '', { type: 'global' }), ['All assets', '#/assets'], 'direct link: admin fallback');
  assert.deepEqual(await back(adm, '#/asset/999', { type: 'global' }), ['Back', '#/asset/999'], 'an unresolvable name still gets a working Back');
});

test('front end: only an in-app hash route can be a Back target; calendar links carry the scope, and the source is stamped at click time', () => {
  const { h } = loadBackHelpers({ admin: true });
  for (const ok of ['#/assets', '#/assets?node=12', '#/catalog?node=3&all=1', '#/asset/5?src=browse&node=7', '#/person/3', '#/assets?status=checked_out']) assert.equal(h.safeFrom(ok), ok, ok);
  for (const bad of ['', undefined, null, 'https://evil.example/', 'javascript:alert(1)', '//evil', '#/calendar?node=1', '#/login', '#/more', '#/assets?node=<script>', '#/x'.padEnd(400, 'a')]) assert.equal(h.safeFrom(bad), '', String(bad).slice(0, 30));
  // the URL carries scope, month, day and the source
  assert.equal(h.calUrl({ node: 7, from: '#/catalog?node=7' }), '#/calendar?node=7&from=%23%2Fcatalog%3Fnode%3D7');
  assert.equal(h.calUrl({ asset: 5, month: '2026-11', day: '2026-11-15', from: '#/asset/5' }), '#/calendar?asset=5&month=2026-11&day=2026-11-15&from=%23%2Fasset%2F5');
  assert.equal(h.calUrl({}), '#/calendar');
  const link = h.calendarLink({ node: 7 });
  assert.match(link, /href="#\/calendar\?node=7"/);
  assert.match(link, /data-cal data-node="7" data-asset=""/);
  const src = appSrc();
  // one delegated click handler stamps `from` for every calendar link (header icons, sidebar, hamburger)
  assert.match(src, /e\.target\.closest\('a\[data-cal\]'\)/);
  assert.match(src, /go\(calUrl\(\{ node: a\.dataset\.node, asset: a\.dataset\.asset, from: calendarSource\(\) \}\)\)/);
  assert.equal((src.match(/data-cal/g) || []).length >= 4, true);
});

test('front end: the calendar has one route for both roles, keeps month/day/source in the URL, always renders a Back link, and every entry point exists', () => {
  const src = appSrc();
  assert.match(src, /\[\/\^#\\\/calendar\$\/, viewCalendar, \{ key: 'calendar' \}\]/);
  assert.doesNotMatch(src.match(/\[\/\^#\\\/calendar\$\/[^\n]*/)[0], /admin: true|employee: true/);
  const view = src.slice(src.indexOf('async function viewCalendar()'), src.indexOf('// ============================================================ people'));
  for (const key of ["p.get('node')", "p.get('asset')", "p.get('month')", "p.get('day')", "p.get('from')"]) assert.ok(view.includes(key), key);
  assert.doesNotMatch(view, /want\.src|p\.get\('src'\)/, 'the old src marker is gone');
  assert.match(view, /history\.replaceState\(null, '', calUrl\(\{ node: want\.node, asset: want\.asset,[^\n]*from: want\.from \}\)\)/, 'month/day changes keep the source');
  assert.match(view, /<div id="backslot">\$\{backLink\(back\.href, back\.label, true\)\}<\/div><div class="page-head">/, 'the Back link sits above the title, as a plain link (not browser history)');
  assert.match(view, /const back = await calBackTarget\(want\.from, sc\)/);
  assert.match(view, /backLink\(eb\.href, eb\.label, true\)/, 'even the error screen has a Back');
  // entry points: Browse (employee), catalog + All assets (admin), asset detail (both), admin sidebar + hamburger
  assert.match(src, /\$\('#headact'\)\.innerHTML = calendarLink\(\{ node: st\.q \? null : \(cur\(\) \|\| \{\}\)\.id \}\)/);
  assert.match(src, /\$\{calendarLink\(\{ asset: a\.id \}\)\}/);
  assert.match(src, /<a href="#\/new" class="btn primary desk-only">\$\{icon\('plus'\)\} Add asset<\/a>\$\{calendarLink\(\)\}/, 'admin All assets header');
  // catalog header order: Add category first, then the calendar icon
  assert.match(src, /\$\{n \? '' : `<button class="btn primary" id="addroot">\$\{icon\('plus'\)\} Add category<\/button>`\}\$\{calendarLink\(\{ node: n \? n\.id : null \}\)\}/);
  assert.equal((src.match(/key: 'calendar', href: '#\/calendar', label: 'Calendar', icon: 'calendar'/g) || []).length, 2, 'sidebar + hamburger');
  assert.match(src, /data-key="\$\{i\.key\}"\$\{i\.key === 'calendar' \? ' data-cal' : ''\}/, 'sidebar and hamburger links are stamped too');
  const tabs = src.slice(src.indexOf('const common = ['), src.indexOf('const side = ['));
  assert.doesNotMatch(tabs, /calendar/i, 'no bottom-tab entry');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8'), /\.cal-day\b/);
});
