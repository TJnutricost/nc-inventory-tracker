// Managed locations: GET/POST/PUT/DELETE /api/locations (admin only) over the `locations` setting and the assets that use each name. A rename
// rewrites the assets that carried the old name, a used location cannot be removed, names are unique ignoring letter case, and the old
// multiline Settings field no longer writes the list. Runs on both drivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server; let db; let admin; let employee;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  ({ client: admin } = await setupAdmin(server));
  const p = await admin.post('/api/users', { name: 'Eve Employee', email: 'eve@nutricost.com', invite: false });
  db.prepare("UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE login_email = 'ada@nutricost.com') WHERE id = ?").run(p.body.account_id);
  db.prepare("INSERT INTO settings (key, value) VALUES ('locations', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(['HQ - IT Room', 'HQ - Office', 'Warehouse', 'Remote'])); // (a fresh PostgreSQL test database has no default settings)
  employee = makeClient(server);
  assert.equal((await employee.post('/api/login', { email: 'eve@nutricost.com', password: 'correct-horse-1' })).status, 200);
});
after(() => stopServer(server));

const names = (o) => o.locations.map((l) => l.name);
const count = (o, name) => o.locations.find((l) => l.name === name)?.count;
const asset = async (name, location) => (await admin.post('/api/assets', { name, category: 'Other', location })).body;
const locationOf = async (id) => { const b = (await admin.get('/api/assets/' + id)).body; return (b.asset || b).location; };

test('the default list is shown with how many assets use each location; locations assets carry outside the list are shown apart', async () => {
  const o = (await admin.get('/api/locations')).body;
  assert.deepEqual(names(o), ['HQ - IT Room', 'HQ - Office', 'Warehouse', 'Remote']);
  assert.ok(o.locations.every((l) => l.count === 0));
  await asset('Wanderer', '  Garage ');
  await asset('Wanderer 2', 'garage');
  const after_ = (await admin.get('/api/locations')).body;
  assert.deepEqual(after_.unlisted, [{ name: 'Garage', count: 2 }], 'one entry, trimmed, case folded together; the assets are untouched');
  assert.deepEqual(names(after_), names(o));
});

test('add: trimmed, unique ignoring case, bounded; the asset forms read the new list from settings', async () => {
  const added = await admin.post('/api/locations', { name: '  Warehouse - Dock 2 ' });
  assert.equal(added.status, 200);
  assert.equal(names(added.body).at(-1), 'Warehouse - Dock 2');
  for (const name of ['warehouse', ' WAREHOUSE - dock 2', '', '   ', undefined, 'x'.repeat(81), 'two\nlines']) assert.equal((await admin.post('/api/locations', { name })).status, 400, JSON.stringify(name));
  assert.match((await admin.post('/api/locations', { name: 'remote' })).body.error, /already exists/);
  assert.ok((await admin.get('/api/settings')).body.locations.includes('Warehouse - Dock 2'));
  assert.ok((await employee.get('/api/me')).body.settings.locations.includes('Warehouse - Dock 2'), 'employees see the managed list in their asset forms');
  // an unlisted location can be adopted: nothing changes on the assets
  const adopted = await admin.post('/api/locations', { name: 'Garage' });
  assert.equal(count(adopted.body, 'Garage'), 2);
  assert.deepEqual(adopted.body.unlisted, []);
});

test('rename: the assets carrying the old name (any case, archived too) follow it in one step; the order is kept; duplicates are refused', async () => {
  const a = await asset('Keeps up', 'Warehouse');
  const b = await asset('Case variant', ' warehouse');
  const c = await asset('Archived one', 'WAREHOUSE');
  assert.equal((await admin.post(`/api/assets/${c.id}/archive`, {})).status, 200);
  const other = await asset('Elsewhere', 'Remote');
  const before = (await admin.get('/api/locations')).body;
  assert.equal(count(before, 'Warehouse'), 3);
  const i = names(before).indexOf('Warehouse');
  const r = await admin.put('/api/locations', { from: 'warehouse', to: 'Warehouse - Main' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(names(r.body)[i], 'Warehouse - Main', 'renamed in place');
  assert.equal(count(r.body, 'Warehouse - Main'), 3);
  for (const x of [a, b, c]) assert.equal(await locationOf(x.id), 'Warehouse - Main');
  assert.equal(await locationOf(other.id), 'Remote');
  // a case-only rename is allowed, a name another entry has is not, an unknown source is a 404; nothing moves on a refusal
  assert.equal((await admin.put('/api/locations', { from: 'Warehouse - Main', to: 'WAREHOUSE - MAIN' })).status, 200);
  const dup = await admin.put('/api/locations', { from: 'WAREHOUSE - MAIN', to: 'remote' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
  assert.equal((await admin.put('/api/locations', { from: 'Nowhere', to: 'Else' })).status, 404);
  assert.equal((await admin.put('/api/locations', { from: 'Remote', to: '  ' })).status, 400);
  assert.equal(await locationOf(a.id), 'WAREHOUSE - MAIN');
  assert.equal(await locationOf(other.id), 'Remote');
});

test('remove: refused (409, nothing changes) while an asset uses the location; allowed once none does', async () => {
  const cur = (await admin.get('/api/locations')).body;
  const used = cur.locations.find((l) => l.count > 0);
  const refused = await admin.del('/api/locations', { name: used.name });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Reassign (that asset|those assets) to another location first/);
  assert.deepEqual((await admin.get('/api/locations')).body, cur);
  assert.equal((await admin.del('/api/locations', { name: 'Nowhere' })).status, 404);
  // reassign the only user of 'Remote', then it can go
  const holder = await asset('Remote only', 'Remote');
  assert.equal((await admin.del('/api/locations', { name: 'Remote' })).status, 409);
  const edit = await admin.put(`/api/assets/${holder.id}`, { name: 'Remote only', category: 'Other', location: 'HQ - Office' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const other = (await admin.get('/api/locations')).body.locations.find((l) => l.name === 'Remote');
  if (other.count === 0) {
    const gone = await admin.del('/api/locations', { name: 'remote' });
    assert.equal(gone.status, 200);
    assert.ok(!names(gone.body).includes('Remote'));
  }
  const unused = (await admin.post('/api/locations', { name: 'Temp bench' })).body;
  assert.equal(count(unused, 'Temp bench'), 0);
  assert.ok(!names((await admin.del('/api/locations', { name: 'Temp bench' })).body).includes('Temp bench'));
});

test('admin only; the old Settings field no longer writes the list; other settings still save', async () => {
  for (const [method, body] of [['get'], ['post', { name: 'X' }], ['put', { from: 'a', to: 'b' }], ['delete', { name: 'a' }]]) {
    assert.equal((await employee[method === 'delete' ? 'del' : method]('/api/locations', body)).status, 403, method);
  }
  const before = (await admin.get('/api/settings')).body.locations;
  const put = await admin.put('/api/settings', { locations: ['Only this'], default_loan_days: 5 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.locations, before, 'a locations array in the Settings body is ignored');
  assert.equal(put.body.default_loan_days, 5);
});

test('front end: Locations under All assets (desktop) and under People in the hamburger (phone); Settings links to it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const side = src.slice(src.indexOf('const side = ['), src.indexOf('return { tabs: common, side };'));
  assert.match(side, /key: 'labels-new', href: '#\/labels\/new', label: 'Create labels', icon: 'plus', sub: true \},\s+\{ key: 'locations', href: '#\/locations', label: 'Locations', icon: 'pin', sub: true \}/, 'beneath the label links');
  const menu = src.slice(src.indexOf('const adminMenuItems = () => ['), src.indexOf('// The drawer lives in #sheet-root'));
  assert.ok(menu.indexOf("key: 'people'") < menu.indexOf("key: 'locations'") && menu.indexOf("key: 'locations'") < menu.indexOf("key: 'calendar'"), 'directly beneath People');
  assert.match(src, /\[\/\^#\\\/locations\$\/, viewLocations, \{ key: 'locations', admin: true \}\]/);
  assert.match(src, /\['assets', 'labels', 'labels-new', 'locations'\]\.includes\(key\)/, 'the All assets submenu stays open on the page');
  const settings = src.slice(src.indexOf('async function viewSettings('), src.indexOf("$('#test').onclick"));
  assert.doesNotMatch(settings, /name="locations"|locations:/);
  const page = src.slice(src.indexOf('async function viewLocations('), src.indexOf('// ============================================================ import / export'));
  for (const s of ['/api/locations', "'DELETE'", "'PUT'", 'Reassign', 'S.settings.locations = ']) assert.ok(page.includes(s), s);
});

test('front end: the Home cards open the filtered All assets lists (Active, Available, Checked out, Overdue), with no category cards', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const s of ['href="#/assets?status=active"', 'href="#/assets?status=available"', 'href="#/assets?status=checked_out"', 'href="#/assets?status=overdue"']) assert.ok(src.includes(s), s);
  assert.match(src, /const STATUS_CHIPS = \[\.\.\.ADMIN_STATUSES, \['active', 'Active'\]\]/);
  assert.ok(!/ADMIN_STATUSES\.some\(\(\[v\]\) => v && v === p\.get\('status'\)\)/.test(src), 'every status parser accepts the Active card');
  assert.match(src, /const filtered = !!st\.status; \/\/ a status filter shows the matching assets straight away: no cards/);
});

test('the lists the Home cards open hold what the cards count', async () => {
  const dash = (await admin.get('/api/dashboard')).body.stats;
  for (const [status, n] of [['active', dash.total], ['available', dash.available]]) {
    const rows = (await admin.get('/api/assets?status=' + status)).body;
    assert.equal(rows.length, n, status);
  }
  assert.equal((await admin.get('/api/assets?status=checked_out')).body.length, dash.checked_out);
  assert.equal((await admin.get('/api/assets?status=overdue')).body.length, dash.overdue);
});
