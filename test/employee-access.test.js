// Employee access contract + read experience (Phase 2, slice 1). The server — not hidden navigation — decides what an
// employee can read: their own profile, assignments, history and requests, plus equipment that is theirs or available.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createAssignment } = require('../src/assignments');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, dir, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db; dir = booted.dir;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const isoPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { name, tag: `EA-${++seq}`, category: 'Laptop', ...extra })).body;
async function makeLogin(name, extra = {}) {
  const created = await admin.post('/api/users', { name, email: `ea${++seq}@nutricost.com`, invite: true, ...extra });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email: created.body.email };
}
const give = (asset, who, extra = {}) => admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, ...extra });
const ids = (rows) => rows.map((r) => r.id);

// ---------------------------------------------------------------- the employee directory
test('there is no employee directory for employees: GET /api/users is admin-only', async () => {
  const me = await makeLogin('Dir Employee');
  await makeLogin('Dir Other');
  const denied = await me.client.get('/api/users');
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.text, /Dir Other/, 'and no names ride along with the refusal');
  assert.equal((await makeClient(server).get('/api/users')).status, 401);
  const rows = (await admin.get('/api/users')).body;
  assert.ok(rows.some((r) => r.name === 'Dir Other' && 'work_email' in r), 'admins still get the full list');
});

// ---------------------------------------------------------------- own profile vs other people
test('an employee reads their own person record but never another employee\'s; admins read any', async () => {
  const a = await makeLogin('Own Record A', { building: 'Building 7' });
  const b = await makeLogin('Own Record B');
  const own = await a.client.get(`/api/users/${a.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.user.name, 'Own Record A');
  assert.equal(own.body.user.building, 'Building 7');
  const other = await a.client.get(`/api/users/${b.id}`);
  assert.equal(other.status, 403);
  assert.doesNotMatch(other.text, /Own Record B/);
  assert.equal((await a.client.get('/api/users/999999')).status, 403, 'an unknown id is refused the same way (no probing)');
  assert.equal((await admin.get(`/api/users/${b.id}`)).status, 200);
  assert.equal((await admin.get(`/api/users/${a.id}`)).status, 200);
});

test('employees cannot change anyone\'s person record, create people, or touch the admin tools', async () => {
  const me = await makeLogin('Not Admin');
  const target = await makeLogin('Target Person');
  const a = await newAsset('Admin only asset');
  const calls = [
    ['PUT', `/api/users/${target.id}`, { name: 'Hacked' }],
    ['PUT', `/api/users/${me.id}`, { role: 'admin' }],
    ['PUT', `/api/users/${me.id}/self-checkout`, { enabled: true }],
    ['POST', '/api/users', { name: 'Sneaky', email: 'sneaky-ea@nutricost.com' }],
    ['POST', `/api/users/${target.id}/invite`, {}],
    ['GET', '/api/settings'], ['PUT', '/api/settings', { tag_prefix: 'X-' }],
    ['GET', '/api/outbox'], ['GET', '/api/activity'], ['GET', '/api/export/assets.csv'], ['GET', '/api/next-tag'],
    ['PUT', `/api/assets/${a.id}`, { name: 'Edited' }], ['POST', `/api/assets/${a.id}/archive`, {}], ['DELETE', `/api/assets/${a.id}`],
    ['POST', '/api/assets', { name: 'New thing' }],
    ['POST', `/api/assets/${a.id}/checkin`, {}], ['POST', `/api/assets/${a.id}/request-return`, {}],
  ];
  for (const [method, url, body] of calls) {
    const r = await ({ GET: () => me.client.get(url), POST: () => me.client.post(url, body), PUT: () => me.client.put(url, body), DELETE: () => me.client.del(url) })[method]();
    assert.equal(r.status, 403, `${method} ${url} must be admin-only`);
  }
  const imp = await me.client.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body: 'name\r\nSneaky' });
  assert.equal(imp.status, 403);
  assert.equal(db.prepare('SELECT name FROM assets WHERE id = ?').get(a.id).name, 'Admin only asset');
  assert.equal(db.prepare('SELECT name FROM employees WHERE id = ?').get(target.id).name, 'Target Person');
});

// ---------------------------------------------------------------- history
test('an employee\'s own history lists their current and returned assignments with type and timestamps; never anyone else\'s', async () => {
  const me = await makeLogin('History Owner');
  const other = await makeLogin('History Other');
  const perm = await newAsset('Hist permanent');
  const loan = await newAsset('Hist loan');
  const open = await newAsset('Hist open loan');
  const theirs = await newAsset('Hist theirs');
  await give(perm, me);
  await give(loan, me, { assignment_type: 'checkout', due_date: isoPlus(3), due_time: '14:30' });
  await give(theirs, other);
  for (const a of [perm, loan]) await admin.post(`/api/assets/${a.id}/checkin`, { condition: 'Good' });
  await give(open, me, { assignment_type: 'checkout', due_date: isoPlus(9) });

  const r = await me.client.get(`/api/users/${me.id}`);
  assert.equal(r.status, 200);
  const past = r.body.past;
  assert.deepEqual(past.map((p) => p.asset_name).sort(), ['Hist loan', 'Hist permanent']);
  for (const p of past) {
    for (const f of ['asset_name', 'tag', 'assignment_type', 'checked_out_at', 'returned_at', 'due_date', 'due_time']) assert.ok(f in p, `history rows carry ${f}`);
    assert.ok(p.checked_out_at && p.returned_at);
  }
  const histLoan = past.find((p) => p.asset_name === 'Hist loan');
  assert.deepEqual([histLoan.assignment_type, histLoan.due_date, histLoan.due_time], ['checkout', isoPlus(3), '14:30']);
  assert.equal(past.find((p) => p.asset_name === 'Hist permanent').assignment_type, 'permanent');
  assert.deepEqual(r.body.current.map((c) => c.asset_name), ['Hist open loan']);
  assert.ok(r.body.history_limit >= 50);
  assert.doesNotMatch(r.text, /Hist theirs|History Other/, "nothing of the other employee's equipment or name");

  assert.equal((await me.client.get(`/api/users/${other.id}`)).status, 403, 'not the other employee\'s history');
  assert.equal((await other.client.get(`/api/users/${me.id}`)).status, 403);
  assert.equal((await admin.get(`/api/users/${me.id}`)).body.past.length, 2, 'admin still sees it');
});

test('the History screen is wired for employees: route, nav entry, own-record API, no other-employee data', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /\[\/\^#\\\/history\$\/, viewHistory, \{ key: 'history' \}\]/, 'route');
  assert.match(src, /async function viewHistory\(\)/);
  const view = src.slice(src.indexOf('async function viewHistory()'), src.indexOf('function viewProfile()'));
  assert.match(view, /'\/api\/users\/' \+ S\.me\.employee_id/, 'reads only the signed-in employee\'s own record');
  for (const field of ['asset_name', 'tag', 'checked_out_at', 'returned_at', 'typeText']) assert.ok(view.includes(field), field);
  assert.match(src, /\.\.\.\(isAdmin\(\) \? \[\] : \[\{ key: 'history', href: '#\/history'/, 'desktop nav entry for employees only');
  assert.match(src, /\['#\/history', 'history', 'History'/, 'mobile Profile tab entry');
});

// ---------------------------------------------------------------- requests
test('an employee sees and cancels only their own requests', async () => {
  const a = await makeLogin('Req A');
  const b = await makeLogin('Req B');
  const ra = (await a.client.post('/api/requests', { category: 'Monitor', message: 'A needs a monitor' })).body;
  const rb = (await b.client.post('/api/requests', { category: 'Phone', message: 'B needs a phone' })).body;
  const mine = (await a.client.get('/api/requests')).body;
  assert.deepEqual(ids(mine).includes(ra.id), true);
  assert.equal(ids(mine).includes(rb.id), false);
  assert.ok(mine.every((r) => r.user_id === a.id));
  assert.equal((await a.client.get('/api/requests?status=open')).body.some((r) => r.id === rb.id), false);
  assert.equal((await a.client.post(`/api/requests/${rb.id}/cancel`, {})).status, 403);
  assert.equal((await a.client.post(`/api/requests/${rb.id}/approve`, {})).status, 403);
  assert.equal((await a.client.post(`/api/requests/${rb.id}/deny`, {})).status, 403);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(rb.id).status, 'open');
  // the dashboard feed is own-only too
  const dash = (await a.client.get('/api/dashboard')).body;
  assert.ok(dash.myRequests.every((r) => r.user_id === a.id));
  assert.equal(dash.stats, undefined, 'no admin stats for an employee');
});

test('an employee can only request equipment they are able to see', async () => {
  const me = await makeLogin('Req Visible');
  const holder = await makeLogin('Req Holder');
  const free = await newAsset('Free to ask for');
  const taken = await newAsset('Held by someone');
  const gone = await newAsset('Archived ask');
  await give(taken, holder);
  await admin.post(`/api/assets/${gone.id}/archive`, {});
  assert.equal((await me.client.post('/api/requests', { asset_id: free.id, category: 'Laptop' })).status, 200);
  for (const a of [taken, gone]) assert.equal((await me.client.post('/api/requests', { asset_id: a.id, category: 'Laptop' })).status, 404, a.name);
  assert.equal((await me.client.post('/api/requests', { category: 'Laptop', message: 'any laptop' })).status, 200, 'category-only requests are unaffected');
  assert.equal((await admin.post('/api/requests', { asset_id: taken.id, user_id: me.id, category: 'Laptop' })).status, 200, 'IT can log one for any asset');
});

// ---------------------------------------------------------------- asset detail / list / lookup / photos
test('asset detail: available and own equipment are readable (sanitized); everything else is "not found"', async () => {
  const me = await makeLogin('Asset Viewer');
  const other = await makeLogin('Asset Other');
  const available = await newAsset('Open laptop', { purchase_cost: 1234, vendor: 'CDW', notes: 'secret note', license_key: 'KEY-1', serial: 'EA-SER-1' });
  const mineAsset = await newAsset('My laptop', { purchase_cost: 999, vendor: 'Dell', notes: 'my private note', license_key: 'MY-KEY' });
  const theirs = await newAsset('Their laptop');
  const archived = await newAsset('Archived laptop');
  const repair = await newAsset('Repair laptop');
  const lost = await newAsset('Lost laptop', { status: 'lost' });
  const retired = await newAsset('Retired laptop', { status: 'retired' });
  await give(mineAsset, me);
  await give(theirs, other);
  await admin.post(`/api/assets/${archived.id}/archive`, {});
  await admin.put(`/api/assets/${repair.id}`, { status: 'maintenance' });

  const open = await me.client.get(`/api/assets/${available.id}`);
  assert.equal(open.status, 200);
  assert.equal(open.body.asset.name, 'Open laptop');
  for (const hidden of ['purchase_cost', 'vendor', 'notes', 'license_key']) assert.equal(hidden in open.body.asset, false, `${hidden} is not shown for equipment you don't hold`);
  assert.deepEqual(open.body.holders, []);
  assert.equal(open.body.activity.length, 0, 'no audit trail for employees');

  const own = await me.client.get(`/api/assets/${mineAsset.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.is_mine, true);
  assert.equal(own.body.asset.license_key, 'MY-KEY', 'the key of equipment you hold');
  for (const hidden of ['purchase_cost', 'vendor', 'notes']) assert.equal(hidden in own.body.asset, false, hidden);
  assert.deepEqual(own.body.holders.map((h) => h.employee_id), [me.id]);

  for (const [label, a] of [['held by someone else', theirs], ['archived', archived], ['in repair', repair], ['lost', lost], ['retired', retired]]) {
    const r = await me.client.get(`/api/assets/${a.id}`);
    assert.equal(r.status, 404, `${label} must look like it doesn't exist`);
    assert.doesNotMatch(r.text, /Asset Other|laptop/i, `${label}: nothing leaks in the refusal`);
  }
  assert.equal((await me.client.get('/api/assets/999999')).status, 404, 'a missing id gives the identical answer');

  // admin behavior is intact
  for (const a of [available, mineAsset, theirs, archived, repair, lost, retired]) assert.equal((await admin.get(`/api/assets/${a.id}`)).status, 200, a.name);
  const adminView = (await admin.get(`/api/assets/${theirs.id}`)).body;
  assert.equal(adminView.holders[0].user_name, 'Asset Other');
});

test('a returned asset stops being visible to its former holder unless it is available again', async () => {
  const me = await makeLogin('Former Holder');
  const next = await makeLogin('Next Holder');
  const a = await newAsset('Passed along');
  await give(a, me);
  assert.equal((await me.client.get(`/api/assets/${a.id}`)).status, 200);
  await admin.post(`/api/assets/${a.id}/checkin`, {});
  assert.equal((await me.client.get(`/api/assets/${a.id}`)).status, 200, 'available again: visible like to anyone');
  await give(a, next);
  assert.equal((await me.client.get(`/api/assets/${a.id}`)).status, 404, 'now someone else\'s');
});

test('Browse (the asset list) is "equipment I can get" for employees: available only, never their own or anyone else\'s', async () => {
  const me = await makeLogin('List Viewer');
  const other = await makeLogin('List Co-holder');
  const seats = await newAsset('Shared license', { category: 'Software License', license_seats: 3 });
  const myseat = await newAsset('My seat license', { category: 'Software License', license_seats: 3 });
  const free = await newAsset('List free');
  const theirs = await newAsset('List theirs');
  const mineAsset = await newAsset('List mine');
  const repair = await newAsset('List repair');
  const gone = await newAsset('List archived');
  await give(seats, other);
  await give(myseat, me);
  await give(theirs, other);
  await give(mineAsset, me);
  await admin.put(`/api/assets/${repair.id}`, { status: 'maintenance' });
  await admin.post(`/api/assets/${gone.id}/archive`, {});
  const rows = (await me.client.get('/api/assets')).body;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('List free') && names.includes('Shared license'), 'available equipment, including a multi-seat license with a free seat');
  for (const hidden of ['List theirs', 'List mine', 'My seat license', 'List repair', 'List archived']) assert.equal(names.includes(hidden), false, `${hidden} is not in Browse`);
  assert.ok(rows.every((r) => r.status === 'available'));
  assert.doesNotMatch(JSON.stringify(rows), /List Co-holder/, 'no other employee\'s name anywhere in the list');
  assert.ok(rows.every((r) => !('holder_names' in r) && !('purchase_cost' in r) && !('vendor' in r) && !('notes' in r)));
  assert.equal(rows.find((r) => r.name === 'Shared license').due_date, null);
  // the status / holder filters are admin tools: for an employee they change nothing and can't surface anything extra
  const same = JSON.stringify(ids(rows));
  for (const qs of ['?status=checked_out', '?status=overdue', '?status=maintenance', '?status=lost', '?include_archived=1', `?employee_id=${other.id}`, `?user_id=${other.id}`, `?employee_id=${me.id}`]) {
    assert.equal(JSON.stringify(ids((await me.client.get(`/api/assets${qs}`)).body)), same, `${qs} is ignored for employees`);
  }
  // searching by a holder's name must not reveal that they hold something
  assert.equal((await me.client.get('/api/assets?q=List%20Co-holder')).body.length, 0, 'no probing holders by name');
  assert.ok((await me.client.get('/api/assets?q=Shared')).body.some((r) => r.name === 'Shared license'), 'ordinary search still works');
  assert.ok((await me.client.get('/api/assets?category=Software%20License')).body.every((r) => r.category === 'Software License'), 'category filter still works');
  // admin list is unchanged
  const adminRows = (await admin.get('/api/assets')).body;
  assert.ok(adminRows.find((r) => r.name === 'List theirs').holder_names.includes('List Co-holder'));
  assert.ok((await admin.get(`/api/assets?q=List%20Co-holder`)).body.some((r) => r.name === 'List theirs'), 'admins can still search by holder');
  assert.ok((await admin.get('/api/assets?status=maintenance')).body.some((r) => r.name === 'List repair'));
});

test('My equipment data: an employee\'s dashboard lists only their own active assignments, permanent and temporary, with details', async () => {
  const me = await makeLogin('Equip Owner');
  const other = await makeLogin('Equip Other');
  const perm = await newAsset('Eq permanent', { brand: 'Dell', model: 'U2723', location: 'Desk 12', category: 'Monitor' });
  const loan = await newAsset('Eq loan', { location: 'IT Room' });
  const returned = await newAsset('Eq returned');
  const theirs = await newAsset('Eq theirs');
  await give(perm, me);
  await give(loan, me, { assignment_type: 'checkout', due_date: isoPlus(4), due_time: '16:00' });
  await give(returned, me);
  await admin.post(`/api/assets/${returned.id}/checkin`, {});
  await give(theirs, other);
  const mine = (await me.client.get('/api/dashboard')).body.mine;
  assert.deepEqual(mine.map((m) => m.asset_name).sort(), ['Eq loan', 'Eq permanent'], 'only own, only active (not returned, not others\')');
  assert.ok(mine.every((m) => m.employee_id === me.id));
  const p = mine.find((m) => m.asset_name === 'Eq permanent');
  assert.deepEqual([p.assignment_type, p.tag, p.location, p.brand, p.model, p.due_date], ['permanent', perm.tag, 'Desk 12', 'Dell', 'U2723', null]);
  assert.ok(p.checked_out_at);
  const l = mine.find((m) => m.asset_name === 'Eq loan');
  assert.deepEqual([l.assignment_type, l.due_date, l.due_time], ['checkout', isoPlus(4), '16:00']);
  assert.doesNotMatch(JSON.stringify(mine), /Eq theirs|Equip Other/);
  assert.equal((await me.client.get(`/api/assets/${perm.id}`)).status, 200, 'each row opens through the normal detail flow');
  assert.equal((await me.client.get(`/api/assets/${theirs.id}`)).status, 404);
  assert.deepEqual((await other.client.get('/api/dashboard')).body.mine.map((m) => m.asset_name), ['Eq theirs']);
});

test('front end: employee navigation has My equipment (desktop + mobile Profile tab), Browse has no "Mine" filter, admin nav is unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const nav = src.slice(src.indexOf('function navItems()'), src.indexOf('function mountShell()'));
  const side = nav.slice(nav.indexOf('const side = ['));
  const order = ['home', 'equipment', 'assets', 'scan', 'requests', 'history'].map((k) => side.indexOf(`key: '${k}'`));
  assert.ok(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'employee sidebar order: Home, My equipment, Browse equipment, Scan, Requests, History');
  assert.match(nav, /\.\.\.\(isAdmin\(\) \? \[\] : \[\{ key: 'equipment', href: '#\/equipment', label: 'My equipment'/, 'employees only');
  assert.match(nav, /key: 'people'[\s\S]*key: 'settings'/, 'admin sidebar items still there');
  assert.match(src, /\[\/\^#\\\/equipment\$\/, viewEquipment, \{ key: 'equipment', employee: true \}\]/);
  assert.match(src, /\['#\/equipment', 'laptop', 'My equipment'/, 'mobile Profile tab entry');
  assert.doesNotMatch(src, /'Mine'/, 'the Mine filter is gone');
  assert.doesNotMatch(src, /employee_id', S\.me\.id/, 'Browse no longer queries by holder');
  const view = src.slice(src.indexOf('async function viewEquipment()'), src.indexOf('// Employee History:'));
  for (const bit of ['/api/dashboard', 'Permanent assignments', 'Temporary checkouts', 'No equipment is permanently assigned to you.', 'You have nothing checked out temporarily.', "href=\"#/asset/${m.asset_id}${srcQ('equipment')}\"", 'isOverdue(m.due_date)', 'fmtClock(m.due_time)']) assert.ok(view.includes(bit), bit);
});

test('front end: mobile nav — five tabs incl. Profile for everyone; hamburger is admin-only and holds administration only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const keys = (t) => [...t.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  const labels = (t) => [...t.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  // bottom tab bar: the same five for both roles (Browse/Assets naming is the existing role switch)
  const tabs = src.slice(src.indexOf('const common = ['), src.indexOf('const side = ['));
  assert.deepEqual(keys(tabs), ['home', 'assets', 'scan', 'requests', 'account']);
  assert.match(tabs, /label: isAdmin\(\) \? 'Assets' : 'Browse'/);
  assert.match(tabs, /key: 'account', href: '#\/account', label: 'Profile', icon: 'user'/);
  assert.match(tabs, /key: 'scan'[^\n]*scan: true/, 'raised Scan treatment kept');
  assert.doesNotMatch(src, /viewMore|label: 'More'/, 'the More page/tab is gone');
  // admin hamburger: exactly the administration destinations — nothing personal, no Sign out
  const menu = src.slice(src.indexOf('const adminMenuItems = () => ['), src.indexOf('// The drawer lives in #sheet-root'));
  assert.deepEqual(labels(menu), ['People', 'Equipment catalog', 'Calendar', 'Print labels', 'Import / export', 'Activity log', 'Settings']);
  const drawer = src.slice(src.indexOf('function openDrawer()'), src.indexOf('function mountShell()'));
  assert.doesNotMatch(drawer, /My profile|Sign out|logout/, 'no personal/account actions in the admin hamburger');
  assert.match(drawer, /if \(!isAdmin\(\)/, 'the drawer refuses to open for a non-admin');
  // the hamburger button and its handler exist only for admins
  assert.match(src, /\$\{isAdmin\(\) \? `<button type="button" class="iconbtn nav-toggle" id="nav-toggle"/);
  assert.match(src, /if \(isAdmin\(\)\) \$\('#nav-toggle'\)\.onclick = openDrawer;/);
  // Profile page: personal destinations only, per role; administration is never listed there
  const account = src.slice(src.indexOf('function viewAccount()'), src.indexOf('async function logout()'));
  const [adminItems, employeeItems] = account.slice(account.indexOf('const items = isAdmin() ? ['), account.indexOf('main().innerHTML')).split('] : [');
  const hrefs = (t) => [...t.matchAll(/\['(#\/\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(hrefs(adminItems), ['#/profile']);
  assert.deepEqual(hrefs(employeeItems), ['#/equipment', '#/history', '#/profile']);
  assert.match(account, /id="out"[\s\S]*\$\('#out'\)\.onclick = logout/, 'Sign out lives on the Profile page');
  assert.doesNotMatch(account, /#\/(people|catalog|labels|import|activity|settings)/, 'no administration in Profile');
  // routing: Profile route, old More bookmarks redirect there, and the role guards on admin/employee routes are unchanged
  assert.match(src, /\[\/\^#\\\/account\$\/, viewAccount, \{ key: 'account' \}\]/);
  assert.match(src, /\[\/\^#\\\/more\$\/, \(\) => go\('#\/account'\)/);
  assert.match(src, /\[\/\^#\\\/people\$\/, viewPeople, \{ key: 'people', admin: true \}\]/);
  assert.match(src, /\[\/\^#\\\/equipment\$\/, viewEquipment, \{ key: 'equipment', employee: true \}\]/);
  assert.match(src, /if \(opt\.admin && !isAdmin\(\)\) return go\('#\/home'\)/);
  // desktop: the sidebar is untouched (it still lists People…Settings for admins) and the hamburger/tab bar are hidden by CSS
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /min-width: 900px\) \{\n  \.shell[\s\S]*?\.topbar \.nav-toggle \{ display: none; \}\n  \.tabbar \{ display: none; \}/);
});

test('scanner lookup: an employee gets an id only for assets they may open; others just report "unavailable"', async () => {
  const me = await makeLogin('Scanner');
  const other = await makeLogin('Scanned Holder');
  const free = await newAsset('Scan free', { serial: 'EA-SCAN-1' });
  const theirs = await newAsset('Scan theirs', { serial: 'EA-SCAN-2' });
  const gone = await newAsset('Scan archived');
  await give(theirs, other);
  await admin.post(`/api/assets/${gone.id}/archive`, {});
  assert.deepEqual((await me.client.get(`/api/assets/lookup/${free.tag}`)).body, { found: true, id: free.id, archived: false });
  assert.equal((await me.client.get('/api/assets/lookup/ea-scan-1')).body.id, free.id);
  for (const code of [theirs.tag, 'EA-SCAN-2', gone.tag]) {
    const r = (await me.client.get(`/api/assets/lookup/${code}`)).body;
    assert.deepEqual(r, { found: false, unavailable: true, code }, code);
  }
  assert.deepEqual((await me.client.get('/api/assets/lookup/NOPE-NOPE')).body, { found: false, code: 'NOPE-NOPE' });
  assert.deepEqual((await admin.get(`/api/assets/lookup/${theirs.tag}`)).body, { found: true, id: theirs.id, archived: false }, 'admin lookup unchanged');
  assert.equal((await admin.get(`/api/assets/lookup/${gone.tag}`)).body.archived, true);
});

test('photo files follow asset visibility: readable for available/own equipment, 404 otherwise; admin reads all', async () => {
  const me = await makeLogin('Photo Viewer');
  const other = await makeLogin('Photo Holder');
  const open = await newAsset('Photo open');
  const theirs = await newAsset('Photo theirs');
  await give(theirs, other);
  const put = (asset, name) => {
    fs.writeFileSync(path.join(dir, 'uploads', `${name}.jpg`), 'jpeg-bytes');
    fs.writeFileSync(path.join(dir, 'uploads', `${name}_t.jpg`), 'thumb-bytes');
    db.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (?, ?, ?)").run(asset.id, `${name}.jpg`, `${name}_t.jpg`);
  };
  put(open, 'ea-open'); put(theirs, 'ea-theirs');
  assert.equal((await me.client.get('/uploads/ea-open.jpg')).status, 200);
  assert.equal((await me.client.get('/uploads/ea-open_t.jpg')).status, 200);
  assert.equal((await me.client.get('/uploads/ea-theirs.jpg')).status, 404);
  assert.equal((await me.client.get('/uploads/ea-theirs_t.jpg')).status, 404);
  assert.equal((await me.client.get('/uploads/no-such-file.jpg')).status, 404);
  assert.equal((await me.client.get('/uploads/..%2f..%2fassets.db')).status, 404, 'no path tricks');
  assert.equal((await other.client.get('/uploads/ea-theirs.jpg')).status, 200, 'the holder can see their own');
  assert.equal((await admin.get('/uploads/ea-theirs.jpg')).status, 200);
  assert.equal((await makeClient(server).get('/uploads/ea-open.jpg')).status, 401);
});

test('employee actions on assets they cannot see are "not found" and never reveal who holds it', async () => {
  const me = await makeLogin('Actor');
  const holder = await makeLogin('Secret Holder');
  const theirs = await newAsset('Actor target');
  await give(theirs, holder);
  const checkout = await me.client.post(`/api/assets/${theirs.id}/checkout`, { due_date: isoPlus(2) });
  assert.equal(checkout.status, 404);
  assert.doesNotMatch(checkout.text, /Secret Holder/);
  assert.equal((await me.client.post(`/api/assets/${theirs.id}/return-notice`, {})).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ?').get(theirs.id, me.id).c, 0);
  // even when the capacity check itself trips for a non-admin, the holder's name is not in the message
  assert.throws(
    () => createAssignment(db, { assetId: theirs.id, employeeId: me.id, actorAccountId: null, actorIsAdmin: false, type: 'checkout', dueDate: isoPlus(2) }),
    (e) => e.status === 400 && !/Secret Holder/.test(e.message),
  );
  assert.throws(
    () => createAssignment(db, { assetId: theirs.id, employeeId: me.id, actorAccountId: null, actorIsAdmin: true, type: 'checkout', dueDate: isoPlus(2) }),
    /Secret Holder/,
  );
});

test('self-checkout of available equipment still works', async () => {
  const me = await makeLogin('Self Ok');
  const a = await newAsset('Self ok asset');
  const r = await me.client.post(`/api/assets/${a.id}/checkout`, { due_date: isoPlus(2) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await me.client.get('/api/dashboard')).body.mine.length, 1);
});

// ---------------------------------------------------------------- profile + building
test('/api/me carries Building (null when unset) and the profile is read-only for employees', async () => {
  const withB = await makeLogin('Profile Bldg', { building: 'Building 4', department: 'Sales', title: 'Rep', phone: '555-0100' });
  const without = await makeLogin('Profile No Bldg');
  const me = (await withB.client.get('/api/me')).body.user;
  assert.deepEqual([me.building, me.department, me.title, me.phone, me.name], ['Building 4', 'Sales', 'Rep', '555-0100', 'Profile Bldg']);
  assert.equal((await without.client.get('/api/me')).body.user.building, null);
  const adminMe = (await admin.get('/api/me')).body.user;
  assert.ok('building' in adminMe);

  const edit = await withB.client.put('/api/me', { name: 'Renamed Self', department: 'IT', title: 'Boss', phone: '1' });
  assert.equal(edit.status, 403);
  assert.deepEqual(db.prepare('SELECT name, department, title, phone, building FROM employees WHERE id = ?').get(withB.id), { name: 'Profile Bldg', department: 'Sales', title: 'Rep', phone: '555-0100', building: 'Building 4' });
  assert.equal((await admin.put('/api/me', { name: 'Ada Admin', department: 'IT' })).status, 200, 'an admin can still edit their own');
  // an employee can still change their own password
  assert.equal((await withB.client.post('/api/me/password', { current: 'employee-password-1', password: 'another-password-2' })).status, 200);
  assert.equal((await withB.client.get('/api/me')).status, 200);
});

test('front end: the employee profile renders Building read-only and the admin keeps the edit form', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const view = src.slice(src.indexOf('function viewProfile()'), src.indexOf('// ============================================================ boot'));
  assert.match(view, /\['Building', u\.building\]/);
  assert.match(view, /const editable = isAdmin\(\)/);
  assert.match(view, /if \(editable\) \$\('#p'\)\.onsubmit/, 'only the admin form submits to PUT /api/me');
  assert.match(view, /id="out"/, 'sign out is kept');
  assert.match(src, /id="signout"/, 'avatar menu sign out is kept');
});
