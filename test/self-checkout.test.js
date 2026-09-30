const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
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
const count = (sql, ...p) => db.prepare(sql).get(...p).c;
const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { name, tag: `SC-${++seq}`, ...extra })).body;
const DUE = '2099-01-01';
async function makeLogin(name) {
  const created = (await admin.post('/api/users', { name, email: `sc${++seq}@nutricost.com` })).body;
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.account_id);
  const c = makeClient(server);
  assert.equal((await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client: c, id: created.id };
}
const setSelf = (emp, enabled) => admin.put(`/api/users/${emp.id}/self-checkout`, { enabled });
const selfCheckout = (emp, asset, body = { due_date: DUE }) => emp.client.post(`/api/assets/${asset.id}/checkout`, body);

test('an employee defaults to self-checkout enabled, visible to admin and to the employee', async () => {
  const emp = await makeLogin('Default Enabled');
  assert.equal((await admin.get(`/api/users/${emp.id}`)).body.user.can_self_checkout, true);
  assert.equal((await emp.client.get('/api/me')).body.user.can_self_checkout, true);
  assert.equal(db.prepare('SELECT can_self_checkout FROM employees WHERE id = ?').get(emp.id).can_self_checkout, 1);
});

test('an enabled employee can self-check-out; it is always a temporary checkout needing a return date', async () => {
  const emp = await makeLogin('Enabled Sam');
  const a = await newAsset('Self Tripod');
  assert.equal((await selfCheckout(emp, a, {})).status, 400, 'return date required');
  const r = await selfCheckout(emp, a, { due_date: DUE, due_time: '09:30' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.assignment.assignment_type, r.body.assignment.employee_id, r.body.assignment.due_date, r.body.assignment.due_time], ['checkout', emp.id, DUE, '09:30']);
});

test('a disabled employee cannot self-check-out, gets friendly text, and nothing is created', async () => {
  const emp = await makeLogin('Disabled Dana');
  const a = await newAsset('Blocked Mic');
  assert.equal((await setSelf(emp, false)).body.can_self_checkout, false);
  assert.equal((await emp.client.get('/api/me')).body.user.can_self_checkout, false);
  for (const body of [{ due_date: DUE }, {}, { assignment_type: 'permanent' }, { assignment_type: 'checkout', due_date: DUE }]) {
    const r = await selfCheckout(emp, a, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.error, 'Self-checkout is not enabled for your account. Please request this item from IT.');
  }
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
  assert.equal((await setSelf(emp, true)).body.can_self_checkout, true);
  assert.equal((await selfCheckout(emp, a)).status, 200, 're-enabling restores it');
});

test('a disabled employee can still browse and submit requests, including a permanent-assignment request', async () => {
  const emp = await makeLogin('Requesting Riley');
  const a = await newAsset('Requested Monitor');
  await setSelf(emp, false);
  assert.equal((await emp.client.get('/api/assets')).body.some((x) => x.id === a.id), true, 'can still browse available equipment');
  assert.equal((await emp.client.get(`/api/assets/${a.id}`)).status, 200);
  const plain = await emp.client.post('/api/requests', { asset_id: a.id, category: 'Monitor', message: 'please' });
  assert.equal(plain.status, 200);
  const perm = await emp.client.post('/api/requests', { asset_id: a.id, category: 'Monitor', requested_assignment_type: 'permanent' });
  assert.equal(perm.status, 200);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
  // IT can still assign to them directly
  const assigned = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: emp.id, assignment_type: 'checkout', due_date: DUE });
  assert.equal(assigned.status, 200);
});

test("changing one employee's permission does not affect another", async () => {
  const [a, b] = [await makeLogin('Pair A'), await makeLogin('Pair B')];
  await setSelf(a, false);
  assert.equal((await selfCheckout(a, await newAsset('For A'))).status, 403);
  assert.equal((await selfCheckout(b, await newAsset('For B'))).status, 200);
  assert.equal(count('SELECT can_self_checkout c FROM employees WHERE id = ?', b.id), 1);
});

test('the old global self-checkout setting no longer controls authorization and is not exposed', async () => {
  const on = await makeLogin('Global Off Gabe');
  const off = await makeLogin('Global On Gia');
  await setSelf(off, false);
  db.prepare("INSERT INTO settings (key, value) VALUES ('self_checkout', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  assert.equal((await selfCheckout(on, await newAsset('Global off asset'))).status, 200, 'enabled employee works even with the legacy setting OFF');
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'self_checkout'").run();
  assert.equal((await selfCheckout(off, await newAsset('Global on asset'))).status, 403, 'disabled employee stays blocked with the legacy setting ON');
  await admin.put('/api/settings', { self_checkout: true });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'self_checkout'").get().value, '1', 'writes to the deprecated key are ignored');
  assert.equal((await admin.get('/api/settings')).body.self_checkout, undefined);
  assert.equal((await on.client.get('/api/me')).body.settings.self_checkout, undefined);
});

test('only an admin can change the permission, and only with a boolean', async () => {
  const emp = await makeLogin('Guarded Gus');
  assert.equal((await emp.client.put(`/api/users/${emp.id}/self-checkout`, { enabled: true })).status, 403);
  assert.equal((await admin.put(`/api/users/${emp.id}/self-checkout`, { enabled: 'no' })).status, 400);
  assert.equal((await admin.put('/api/users/999999/self-checkout', { enabled: false })).status, 404);
  const before = db.prepare('SELECT name, department, title, status FROM employees WHERE id = ?').get(emp.id);
  await setSelf(emp, false);
  assert.deepEqual(db.prepare('SELECT name, department, title, status FROM employees WHERE id = ?').get(emp.id), before, 'nothing else about the employee changes');
});

// ---------------------------------------------------------------- enable / disable round trip
test('an admin can disable and re-enable self-checkout; each change persists and targets the right employee', async () => {
  const [target, bystander] = [await makeLogin('Toggle Target'), await makeLogin('Toggle Bystander')];
  const read = async (emp) => (await admin.get(`/api/users/${emp.id}`)).body.user.can_self_checkout;
  assert.equal(await read(target), true);

  const off = await setSelf(target, false);
  assert.equal(off.status, 200);
  assert.deepEqual([off.body.id, off.body.can_self_checkout], [target.id, false], 'the response describes the employee that was changed');
  assert.equal(await read(target), false, 'persisted');
  assert.equal(await read(bystander), true, 'nobody else changed');

  const on = await setSelf(target, true);
  assert.equal(on.status, 200);
  assert.equal(on.body.can_self_checkout, true);
  assert.equal(await read(target), true, 'persisted');
  assert.equal(count('SELECT can_self_checkout c FROM employees WHERE id = ?', target.id), 1);
});

test("an employee cannot change another employee's (or their own) permission", async () => {
  const [a, b] = [await makeLogin('Perm Actor'), await makeLogin('Perm Victim')];
  await setSelf(b, false);
  assert.equal((await a.client.put(`/api/users/${b.id}/self-checkout`, { enabled: true })).status, 403);
  assert.equal(count('SELECT can_self_checkout c FROM employees WHERE id = ?', b.id), 0);
  await setSelf(a, false);
  assert.equal((await a.client.put(`/api/users/${a.id}/self-checkout`, { enabled: true })).status, 403, 'and cannot re-enable themselves');
  assert.equal(count('SELECT can_self_checkout c FROM employees WHERE id = ?', a.id), 0);
});

test('new employees default to self-checkout enabled, with or without a login', async () => {
  const withLogin = (await admin.post('/api/users', { name: 'New With Login', email: `nl${++seq}@nutricost.com`, invite: false })).body;
  const noLogin = (await admin.post('/api/users', { name: 'New No Login', login: false })).body;
  assert.equal(withLogin.can_self_checkout, true);
  assert.equal(noLogin.can_self_checkout, true);
  assert.equal(count('SELECT COUNT(*) c FROM employees WHERE id IN (?, ?) AND can_self_checkout = 1', withLogin.id, noLogin.id), 2);
});

// ---------------------------------------------------------------- migration 7: consume the legacy global setting once
function legacyDb(legacyValue) {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 6));
  if (legacyValue !== undefined) old.prepare("INSERT INTO settings (key, value) VALUES ('self_checkout', ?)").run(legacyValue);
  old.prepare("INSERT INTO employees (name) VALUES ('Legacy A'), ('Legacy B')").run();
  return old;
}
const flags = (d) => d.prepare('SELECT can_self_checkout c FROM employees ORDER BY id').all().map((r) => r.c);

test('migration 7: legacy global OFF disables every existing employee, once', () => {
  const old = legacyDb('0');
  assert.deepEqual(runMigrations(old, migrations), [7]);
  assert.deepEqual(flags(old), [0, 0]);
  old.prepare("INSERT INTO employees (name) VALUES ('Hired Later')").run();
  assert.deepEqual(flags(old), [0, 0, 1], 'employees added afterwards default to enabled');
  assert.equal(old.prepare("SELECT value FROM settings WHERE key = 'self_checkout'").get().value, '0', 'the old row is left as unused data');
  assert.equal(old.pragma('foreign_key_check').length, 0);
});

test('migration 7: legacy global ON enables every existing employee', () => {
  const old = legacyDb('1');
  assert.deepEqual(runMigrations(old, migrations), [7]);
  assert.deepEqual(flags(old), [1, 1]);
});

test('migration 7: no legacy setting means existing employees are enabled; the flag is validated', () => {
  const old = legacyDb(undefined);
  assert.deepEqual(runMigrations(old, migrations), [7]);
  assert.deepEqual(flags(old), [1, 1]);
  assert.throws(() => old.prepare('UPDATE employees SET can_self_checkout = 2').run(), /CHECK/);
  assert.ok(old.pragma('table_info(employees)').some((c) => c.name === 'building' && c.notnull === 0), 'building is nullable');
});

test('after migration the legacy global value never matters again, in either direction', async () => {
  const ok = await makeLogin('Legacy Ignored Ok');
  const blocked = await makeLogin('Legacy Ignored Blocked');
  await setSelf(blocked, false);
  for (const value of ['0', '1', 'true', 'garbage']) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('self_checkout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
    assert.equal((await selfCheckout(ok, await newAsset(`L-ok ${value}`))).status, 200, `enabled employee works with legacy=${value}`);
    assert.equal((await selfCheckout(blocked, await newAsset(`L-no ${value}`))).status, 403, `disabled employee blocked with legacy=${value}`);
  }
});

// ---------------------------------------------------------------- People list data
test('the People data carries self-checkout state for login holders, and no-login people stay intact', async () => {
  const withLogin = await makeLogin('People Row Login');
  const off = await makeLogin('People Row Off');
  await setSelf(off, false);
  const none = (await admin.post('/api/users', { name: 'People Row None', login: false })).body;
  const rows = (await admin.get('/api/users')).body;
  const row = (id) => rows.find((r) => r.id === id);
  assert.deepEqual([row(withLogin.id).has_account, row(withLogin.id).can_self_checkout], [true, true]);
  assert.deepEqual([row(off.id).has_account, row(off.id).can_self_checkout], [true, false]);
  assert.deepEqual([row(none.id).has_account, row(none.id).login_enabled, row(none.id).role], [false, false, null]);
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', none.id), 0, 'still no account for a no-login person');
  // the employee directory (non-admin) stays minimal
  assert.deepEqual(Object.keys((await withLogin.client.get('/api/users')).body[0]).sort(), ['id', 'name']);
});

// ---------------------------------------------------------------- stale-UI guard
test("the app's own JS/CSS/HTML are always revalidated, so a browser can't keep running older UI code", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const f of ['/app.js', '/app.css', '/sw.js']) {
    const r = await fetch(base + f);
    assert.equal(r.headers.get('cache-control'), 'no-cache', f);
    assert.ok(r.headers.get('etag'), `${f} still has an ETag so revalidation is a cheap 304`);
  }
  // one-time bust for browsers that cached the old assets under the previous 1h max-age
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /\/app\.js\?v=/);
  assert.match(html, /\/app\.css\?v=/);
  assert.equal((await fetch(base + '/app.js?v=anything')).headers.get('cache-control'), 'no-cache');
});
