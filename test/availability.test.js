// Asset Availability Calendar V1 (Phase 2, slice 6): read-only, derived only from open assignments + asset status. One shared
// query serves global / catalog-node / single-asset scope. Employees get an anonymous, narrower view; admins get holders.
// Scope refinement: the broader the scope the more summarized the answer. A single asset is detailed (view 'asset'); a catalog
// subtree or everything is per-day counts (view 'summary'), plus — admins only — the open TEMPORARY checkouts. Never an asset list.
// Permanent assignments are not part of the broad ADMIN calendar at all: permanently assigned assets are outside its (schedulable) pool.
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
const todayIdx = Number(TODAY.slice(8)) - 1;
const todayCounts = async (who, q) => (await ok(who, `${q}${q ? '&' : '?'}month=${TODAY.slice(0, 7)}`)).days[todayIdx];
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
  const total = async (n) => (await ok(admin, `?node=${n.id}`)).total;
  assert.equal(await total(root), 3, 'root: itself + brand + model');
  assert.equal(await total(brand), 2);
  assert.equal(await total(model), 1);
  assert.equal(await total(other), 1);
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
  assert.ok(all.total >= 3, 'eligible assets from across the catalog are counted');
  void unlinked;
  const one = await ok(admin, `?asset=${ax.id}`);
  assert.deepEqual([one.view, one.scope.type, one.scope.id, one.assets.map((a) => a.id)], ['asset', 'asset', ax.id, [ax.id]]);
  void ay;
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
  // broad scopes: archived assets are not counted at all; repair/retired/lost/disposed are (as unavailable, admin-only "off")
  const bucket = await node(`Off bucket ${++seq}`);
  for (const a of [repair, retired, lost, disposed, arch]) db.prepare('UPDATE assets SET catalog_node_id = ? WHERE id = ?').run(bucket.id, a.id);
  const sum = await ok(admin, `?node=${bucket.id}`);
  assert.equal(sum.total, 4, 'archived assets are not part of node/global scopes');
  assert.deepEqual(sum.days[todayIdx], { available: 0, expected: 0, checked_out: 0, off: 4 });
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
  for (const q of [`?node=${n.id}`, `?asset=${a.id}`]) {
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
  assert.equal((await ok(me.client, `?node=${n.id}`)).total, 1, 'only the lendable-looking one is even counted');
  assert.equal((await ok(admin, `?node=${n.id}`)).total, 5, 'admins count repair/retired/lost/disposed too');
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
  assert.equal((await ok(admin, `?node=${n.id}`)).total, 1);
  void a;
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

// ---------------------------------------------------------------- scope refinement: summaries for broad scopes, detail for one asset
const hasKey = (o, k) => JSON.stringify(o).includes(`"${k}"`);

test('a catalog subtree answers with per-day counts only — never a list of its assets (employee and admin)', async () => {
  const me = await makeLogin('Summary Viewer');
  const holder = await makeLogin('Summary Holder');
  const root = await node(`Sum Root ${++seq}`);
  const child = await node('Sum Child', root.id);
  const free1 = await newAsset('Sum free 1', { catalog_node_id: root.id });
  const free2 = await newAsset('Sum free 2', { catalog_node_id: child.id });
  const loaned = await newAsset('Sum loaned', { catalog_node_id: child.id });
  await checkout(loaned, holder, { assignment_type: 'checkout', due_date: plus(3) });
  const perm = await newAsset('Sum permanent', { catalog_node_id: child.id });
  await checkout(perm, holder, { assignment_type: 'permanent' });
  void free1; void free2;
  for (const who of [me.client, admin]) {
    const body = await ok(who, `?node=${root.id}&month=${TODAY.slice(0, 7)}`);
    assert.equal(body.view, 'summary');
    assert.equal(body.total, who === admin ? 3 : 4, 'admin: schedulable pool (the permanently assigned asset is out); employee: unchanged');
    assert.equal(body.assets, undefined, 'no asset rows for a subtree');
    // (an admin's `events` may name the temporary loan; nothing else about the subtree is listed)
    for (const nm of ['Sum free 1', 'Sum free 2', 'Sum permanent']) assert.ok(!JSON.stringify(body).includes(nm), `${nm} is not listed`);
    if (who !== admin) assert.ok(!JSON.stringify(body).includes('Sum loaned'), 'an employee sees no asset names at all');
    // employees: unchanged (the permanent asset is just "unavailable"); admins: it is not in the calendar, only the temporary checkout is out
    assert.deepEqual(body.days[todayIdx], who === admin ? { available: 2, expected: 0, checked_out: 1, off: 0 } : { available: 2, expected: 0, unavailable: 2, off: 0 }, 'today');
  }
  // after the loan's due date the loaned laptop is only "expected back"; the permanent one stays unavailable
  const later = plus(5);
  const m = await ok(me.client, `?node=${root.id}&month=${later.slice(0, 7)}`);
  assert.deepEqual(m.days[Number(later.slice(8)) - 1], { available: 2, expected: 1, unavailable: 1, off: 0 });
  const am = await ok(admin, `?node=${root.id}&month=${later.slice(0, 7)}`);
  assert.deepEqual(am.days[Number(later.slice(8)) - 1], { available: 2, expected: 1, checked_out: 0, off: 0 }, 'admin: the loan is back-expected, so not "checked out" that day');
  // earlier days carry no counts
  const first = (await ok(me.client, `?node=${root.id}`)).days[0];
  if (TODAY.slice(8) > '01') assert.deepEqual(first, { available: 0, expected: 0, unavailable: 0, off: 0 });
});

test('employee summaries are anonymous: no events, holders, tags, ids or repair counts; "off" is admin-only and repair stays hidden', async () => {
  const me = await makeLogin('Anon Viewer');
  const holder = await makeLogin('Quiet Holder');
  const n = await node(`Anon ${++seq}`);
  const a = await newAsset('Anon laptop', { catalog_node_id: n.id });
  await newAsset('Anon repair', { catalog_node_id: n.id, status: 'maintenance' });
  await checkout(a, holder, { assignment_type: 'checkout', due_date: plus(7) });
  const body = await ok(me.client, `?node=${n.id}`);
  assert.equal(body.total, 1, 'the repair asset is not even counted');
  assert.equal(body.events, undefined);
  for (const leak of ['Quiet Holder', 'holder', 'assignment_id', 'events', 'Anon laptop', a.tag]) assert.ok(!JSON.stringify(body).includes(leak), leak);
  assert.equal(body.days[todayIdx].off, 0);
  // the admin view of the same node counts the repair asset as "off"
  const adminBody = await ok(admin, `?node=${n.id}`);
  assert.equal(adminBody.total, 2);
  assert.equal(adminBody.days[todayIdx].off, 1);
});

test('employees have no all-equipment calendar: it needs a catalog entry or an asset (admins keep the global one)', async () => {
  const me = await makeLogin('No Global');
  const r = await cal(me.client, '');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /category or an item/i);
  assert.equal((await cal(me.client, `?month=${TODAY.slice(0, 7)}`)).status, 400);
  const n = await node(`Ok node ${++seq}`);
  const a = await newAsset('Ok asset', { catalog_node_id: n.id });
  assert.equal((await cal(me.client, `?node=${n.id}`)).status, 200);
  assert.equal((await cal(me.client, `?asset=${a.id}`)).status, 200);
  assert.equal((await cal(admin, '')).status, 200);
  assert.equal((await ok(admin)).view, 'summary');
});

test('a single asset stays detailed for both roles: per-day states, periods, tag/name; admins also get the holder', async () => {
  const holder = await makeLogin('Detail Holder');
  const me = await makeLogin('Detail Viewer');
  const n = await node(`Detail ${++seq}`);
  const a = await newAsset('Detail laptop', { catalog_node_id: n.id });
  const due = plus(4);
  await checkout(a, holder, { assignment_type: 'checkout', due_date: due });
  const emp = await ok(me.client, `?asset=${a.id}`);
  const adm = await ok(admin, `?asset=${a.id}`);
  for (const body of [emp, adm]) {
    assert.equal(body.view, 'asset');
    assert.equal(body.assets.length, 1);
    assert.equal(body.assets[0].name, 'Detail laptop');
    assert.equal(body.assets[0].days.length, body.last.slice(8) * 1);
    assert.deepEqual(body.assets[0].periods.map((p) => p.kind), ['occupied', 'expected']);
    assert.equal(body.days, undefined, 'no summary counts for a single asset');
  }
  assert.equal(emp.assets[0].periods[0].holder, undefined);
  assert.equal(adm.assets[0].periods[0].holder.name, 'Detail Holder');
});

test('admin broad calendars list only TEMPORARY checkouts: not available assets, not permanent assignments', async () => {
  const holder = await makeLogin('Event Holder');
  const holder2 = await makeLogin('Event Holder Two');
  const n = await node(`Events ${++seq}`);
  const free = await newAsset('Ev free', { catalog_node_id: n.id });
  const perm = await newAsset('Ev permanent', { catalog_node_id: n.id });
  const temp = await newAsset('Ev temporary', { catalog_node_id: n.id });
  const overdue = await newAsset('Ev overdue', { catalog_node_id: n.id });
  const repair = await newAsset('Ev repair', { catalog_node_id: n.id, status: 'maintenance' });
  await checkout(perm, holder, { assignment_type: 'permanent' });
  const due = plus(2);
  await checkout(temp, holder2, { assignment_type: 'checkout', due_date: due, due_time: '09:30' });
  await checkout(overdue, holder, { assignment_type: 'checkout', due_date: plus(3) });
  db.prepare('UPDATE assignments SET due_date = ? WHERE asset_id = ?').run(plus(-1), overdue.id);
  void free; void repair;
  for (const q of [`?node=${n.id}`, '']) {
    const body = await ok(admin, q);
    const ev = body.events.filter((e) => [free, perm, temp, overdue, repair].some((x) => x.id === e.asset_id));
    assert.deepEqual(ev.map((e) => e.name).sort(), ['Ev overdue', 'Ev temporary'], `${q || 'global'}: only temporary checkouts`);
    assert.ok(!body.events.some((e) => e.asset_id === free.id || e.asset_id === perm.id || e.asset_id === repair.id));
    const t = ev.find((e) => e.name === 'Ev temporary');
    assert.deepEqual([t.start, t.end, t.due_time, t.overdue, t.holder.name], [TODAY, due, '09:30', false, 'Event Holder Two']);
    const o = ev.find((e) => e.name === 'Ev overdue');
    assert.deepEqual([o.end, o.overdue], [null, true], 'overdue is still out, no invented end');
    assert.equal(body.assets, undefined, 'and no asset rows');
  }
  // soonest-return order puts overdue first
  const nodeEvents = (await ok(admin, `?node=${n.id}`)).events;
  assert.deepEqual(nodeEvents.map((e) => e.name), ['Ev overdue', 'Ev temporary']);
  // scoped to a different branch: neither shows up
  const other = await node(`Events other ${seq}`);
  assert.deepEqual((await ok(admin, `?node=${other.id}`)).events, []);
});

test('permanent assignments are not in the broad admin calendar at all: not in the total, the counts, the day states or the lists — and returning one puts the asset back', async () => {
  const h1 = await makeLogin('Pool One'); const h2 = await makeLogin('Pool Two'); const h3 = await makeLogin('Pool Three');
  const n = await node(`Pool ${++seq}`);
  const [t1, t2, p1, p2, od, rep, fr] = [
    await newAsset('Pl temp 1', { catalog_node_id: n.id }), await newAsset('Pl temp 2', { catalog_node_id: n.id }),
    await newAsset('Pl perm 1', { catalog_node_id: n.id }), await newAsset('Pl perm 2', { catalog_node_id: n.id }),
    await newAsset('Pl overdue', { catalog_node_id: n.id }), await newAsset('Pl repair', { catalog_node_id: n.id, status: 'maintenance' }),
    await newAsset('Pl free', { catalog_node_id: n.id }),
  ];
  await checkout(t1, h1, { assignment_type: 'checkout', due_date: plus(2) });
  await checkout(t2, h2, { assignment_type: 'checkout', due_date: plus(6) });
  await checkout(p1, h1, { assignment_type: 'permanent' });
  await checkout(p2, h3, { assignment_type: 'permanent' });
  await checkout(od, h3, { assignment_type: 'checkout', due_date: plus(1) });
  db.prepare('UPDATE assignments SET due_date = ? WHERE asset_id = ?').run(plus(-3), od.id);
  void rep; void fr;
  const month = await ok(admin, `?node=${n.id}&month=${TODAY.slice(0, 7)}`);
  assert.equal(month.total, 5, '7 assets, 2 permanently assigned: the schedulable pool is 5');
  // today: t1, t2 and the overdue one are out; one in repair; one free. Nothing about permanent assignments.
  assert.deepEqual(month.days[todayIdx], { available: 1, expected: 0, checked_out: 3, off: 1 });
  assert.deepEqual(Object.keys(month.days[todayIdx]).sort(), ['available', 'checked_out', 'expected', 'off'], 'no unavailable and no permanent figure');
  assert.equal(month.days[todayIdx].checked_out, month.events.filter((e) => e.start <= TODAY && (e.overdue || TODAY <= e.end)).length, 'the count IS the list');
  assert.ok(!month.events.some((e) => [p1.id, p2.id].includes(e.asset_id)));
  assert.ok(!JSON.stringify(month).includes('Pl perm'));
  // three days on (the month may roll over, so ask for that month): t1 is due back (expected), t2 and the overdue one are still out
  const d3 = plus(3); const m3 = await ok(admin, `?node=${n.id}&month=${d3.slice(0, 7)}`);
  assert.deepEqual(m3.days[Number(d3.slice(8)) - 1], { available: 1, expected: 1, checked_out: 2, off: 1 });
  // the global calendar's total drops by exactly the permanently assigned assets, too
  const before = (await ok(admin)).total;
  const extra = await newAsset('Pl global perm');
  await checkout(extra, h2, { assignment_type: 'permanent' });
  assert.equal((await ok(admin)).total, before, 'a newly permanently assigned asset adds nothing to the global pool');
  // returning a permanent assignment puts the asset back
  assert.equal((await admin.post(`/api/assets/${p1.id}/checkin`, {})).status, 200);
  const back = await ok(admin, `?node=${n.id}&month=${TODAY.slice(0, 7)}`);
  assert.equal(back.total, 6);
  assert.equal(back.days[todayIdx].available, 2);
  // a single asset, asked for directly, is still shown in full (even a permanent one)
  const one = await ok(admin, `?asset=${p2.id}`);
  assert.deepEqual([one.view, one.assets[0].state], ['asset', 'occupied']);
});

test('the admin Checked out count is not limited by the events list cap, and employees never get the split', async () => {
  const me = await makeLogin('Cap Viewer'); const h = await makeLogin('Cap Holder');
  const n = await node(`Cap ${++seq}`);
  const a = await newAsset('Cap loan', { catalog_node_id: n.id });
  await checkout(a, h, { assignment_type: 'checkout', due_date: plus(2) });
  const emp = await ok(me.client, `?node=${n.id}`);
  assert.deepEqual(Object.keys(emp.days[todayIdx]).sort(), ['available', 'expected', 'off', 'unavailable']);
  assert.equal((await ok(admin, `?node=${n.id}`)).days[todayIdx].checked_out, 1);
});

test('admin events respect the month window: a checkout due before the month, or starting after it, is not an event; open-ended overdue ones are', async () => {
  const holder = await makeLogin('Window Holder');
  const n = await node(`Window ${++seq}`);
  const a = await newAsset('Window loan', { catalog_node_id: n.id });
  await checkout(a, holder, { assignment_type: 'checkout', due_date: plus(3) });
  const thisMonth = (await ok(admin, `?node=${n.id}`)).events.map((e) => e.name);
  assert.deepEqual(thisMonth, ['Window loan']);
  const farLater = plus(120).slice(0, 7);
  assert.deepEqual((await ok(admin, `?node=${n.id}&month=${farLater}`)).events, [], 'it is back well before then (expected, not an event)');
  db.prepare('UPDATE assignments SET due_date = ? WHERE asset_id = ?').run(plus(-5), a.id);
  assert.deepEqual((await ok(admin, `?node=${n.id}&month=${farLater}`)).events.map((e) => e.name), ['Window loan'], 'overdue = still out, relevant to every future month');
});

test('the pure helper only ever returns temporary assignments, whatever else is open', () => {
  const asset = { id: 1, name: 'X', tag: 'T-1' };
  const rows = [
    { id: 1, asset_id: 1, employee_id: 5, assignment_type: 'permanent', due_date: null, checked_out_at: '2030-01-01 09:00:00', holder_name: 'P' },
    { id: 2, asset_id: 1, employee_id: 6, assignment_type: 'checkout', due_date: '2030-01-10', checked_out_at: '2030-01-02 09:00:00', holder_name: 'Q' },
  ];
  const win = availability.monthWindow('2030-01', '2030-01-05');
  const { events } = availability.checkoutEvents([asset], new Map([[1, rows]]), { today: '2030-01-05', win });
  assert.deepEqual(events.map((e) => [e.assignment_id, e.holder.name]), [[2, 'Q']]);
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
  assert.match(src, /\$\('#headact'\)\.innerHTML = !st\.q && cur\(\) \? calendarLink\(\{ node: cur\(\)\.id \}\) : ''/, 'employee Browse: calendar only inside a catalog entry');
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

test('front end: employee Browse has no Calendar action at the root or while searching; nested entries and single assets keep theirs', () => {
  const src = appSrc();
  const browse = src.slice(src.indexOf('async function viewBrowse()'), src.indexOf('// ============================================================ admin'));
  const line = browse.match(/\$\('#headact'\)\.innerHTML = [^\n]*/)[0];
  assert.match(line, /!st\.q && cur\(\) \? calendarLink\(\{ node: cur\(\)\.id \}\) : ''/);
  assert.doesNotMatch(browse, /calendarLink\(\)/, 'never an unscoped calendar from Browse');
  assert.match(src, /\$\{calendarLink\(\{ asset: a\.id \}\)\}/, 'asset pages keep it');
  // the same expression, evaluated: root / search -> nothing, any entry -> a node-scoped link
  const vm = require('node:vm');
  const run = (q, curVal) => vm.runInNewContext(`(${line.replace("$('#headact').innerHTML = ", '').replace(/;$/, '')})`, { st: { q }, cur: () => curVal, calendarLink: ({ node }) => `CAL:${node}` });
  assert.equal(run('', undefined), '', 'Browse root');
  assert.equal(run('lap', { id: 3 }), '', 'a search is global');
  assert.equal(run('', { id: 3 }), 'CAL:3', 'a category');
  assert.equal(run('', { id: 12 }), 'CAL:12', 'a deep model entry');
});

test('front end: the selected-day panel follows the scope — asset detail for one asset, counts for a subtree, temporary checkouts only for admins', () => {
  const src = appSrc();
  const view = src.slice(src.indexOf('async function viewCalendar()'), src.indexOf('// ============================================================ people'));
  assert.match(view, /const isSummary = \(\) => data\.view === 'summary'/);
  assert.match(view, /return isSummary\(\) \? summaryPanel\(day, i\) : assetPanel\(day, i\)/);
  // a subtree/global panel never iterates assets: it reads counts, and (admins) events
  const summary = view.slice(view.indexOf('const countRows ='), view.indexOf('const panelHtml ='));
  assert.doesNotMatch(summary, /\bA\b\.(map|filter)|\bA\.length|data\.assets/, 'no per-asset rows in a summary');
  assert.match(summary, /\[c\.available, 'available', 'available'\], \[c\.unavailable, 'unavailable', 'occupied'\], \[c\.expected, 'expected back', 'expected'\]/, 'employees: generic unavailable');
  const adminRows = summary.slice(summary.indexOf('if (isAdmin())'), summary.indexOf('const rows = [[c.available, \'available\', \'available\'], [c.unavailable'));
  assert.match(adminRows, /\[c\.checked_out, 'checked out', 'occupied'\]/, 'admins: checked out');
  assert.doesNotMatch(adminRows.replace(/\/\/[^\n]*/g, ''), /unavailable|permanent/i, 'no combined Unavailable total and no permanent figure in the admin rows');
  assert.match(summary, /adminV \? eventsHtml\(day\) : ''/, 'only admins get the day\'s temporary checkouts');
  assert.match(summary, /Temporary checkouts/);
  assert.doesNotMatch(summary, /Reserve|reserve/, 'no reservation controls yet');
  assert.doesNotMatch(view, />\s*Reserve\s*</, 'no Reserve button');
  // the single-asset panel names the asset and its tag
  const one = view.slice(view.indexOf('const assetPanel ='), view.indexOf('// A catalog subtree / everything'));
  assert.match(one, /esc\(a\.name\)/);
  assert.match(one, /esc\(a\.tag\)/);
  assert.match(one, /dayTitle\(day\)/);
  // URL-backed scope/day/month/source and the Back link are untouched
  assert.match(view, /history\.replaceState\(null, '', calUrl\(\{ node: want\.node, asset: want\.asset,[^\n]*from: want\.from \}\)\)/);
});
