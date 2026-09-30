const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');

let server, db, admin;
before(async () => {
  const { app, db: _db } = bootApp();
  db = _db;
  server = await startServer(app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

const count = (sql, ...p) => db.prepare(sql).get(...p).c;
async function loginAs(email, password) {
  const c = makeClient(server);
  const r = await c.post('/api/login', { email, password });
  return { c, status: r.status };
}
async function withLogin(name, email, role = 'employee') {
  const created = (await admin.post('/api/users', { name, email, role, invite: true })).body;
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.account_id);
  const c = makeClient(server);
  await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' });
  return { c, person: created };
}

// ---------------------------------------------------------------- auth / identity
test('setup creates a linked employee + admin account; /api/me combines person and account', async () => {
  const me = (await admin.get('/api/me')).body.user;
  assert.equal(me.role, 'admin');
  assert.equal(me.email, 'ada@nutricost.com');
  assert.equal(me.name, 'Ada Admin');
  assert.ok(me.id && me.account_id && me.employee_id === me.id);
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(me.account_id);
  assert.equal(acct.employee_id, me.employee_id);
  assert.equal(acct.role, 'admin');
  assert.equal(db.prepare('SELECT name FROM employees WHERE id = ?').get(me.employee_id).name, 'Ada Admin');
});

test('an employee login gets the employee role and cannot use admin endpoints', async () => {
  const { c, person } = await withLogin('Eve Employee', 'eve@nutricost.com');
  const me = (await c.get('/api/me')).body.user;
  assert.equal(me.role, 'employee');
  assert.equal(me.id, person.id);
  assert.equal((await c.get('/api/settings')).status, 403);
  assert.equal((await c.post('/api/users', { name: 'X', email: 'x@nutricost.com' })).status, 403);
  assert.equal((await c.get(`/api/users/${(await admin.get('/api/me')).body.user.id}`)).status, 403);
  assert.equal((await c.get(`/api/users/${person.id}`)).status, 200);
});

test('legacy role value "user" is accepted and means employee', async () => {
  const p = (await admin.post('/api/users', { name: 'Legacy Role', email: 'legacyrole@nutricost.com', role: 'user', invite: false })).body;
  assert.equal(p.role, 'employee');
});

// ---------------------------------------------------------------- employee without login
test('IT can create an employee with no login: no account row, assignable, cannot sign in', async () => {
  const accountsBefore = count('SELECT COUNT(*) c FROM accounts');
  const tokensBefore = count('SELECT COUNT(*) c FROM tokens');
  const outboxBefore = count('SELECT COUNT(*) c FROM outbox');
  // the Add-person sheet's unchecked "Create login and send invite" sends login:false, invite:false (and no role)
  const p = await admin.post('/api/users', { name: 'Nolan NoLogin', email: 'nolan@nutricost.com', department: 'Warehouse', login: false, invite: false });
  assert.equal(p.status, 200);
  assert.equal(p.body.has_account, false);
  assert.equal(p.body.role, null);
  assert.equal(count('SELECT COUNT(*) c FROM accounts'), accountsBefore);
  assert.equal(count('SELECT COUNT(*) c FROM tokens'), tokensBefore, 'no invite token');
  assert.equal(count('SELECT COUNT(*) c FROM outbox'), outboxBefore, 'no invite email');
  assert.equal(count('SELECT COUNT(*) c FROM employees WHERE id = ?', p.body.id), 1);

  const asset = (await admin.post('/api/assets', { name: 'Handheld Scanner' })).body;
  const co = await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: p.body.id });
  assert.equal(co.status, 200);
  const detail = (await admin.get(`/api/users/${p.body.id}`)).body;
  assert.equal(detail.current.length, 1);
  assert.equal((await admin.get(`/api/assets/${asset.id}`)).body.holders[0].user_name, 'Nolan NoLogin');

  assert.equal((await loginAs('nolan@nutricost.com', 'anything-at-all-1')).status, 401);
  assert.equal((await admin.post(`/api/users/${p.body.id}/invite`, {})).status, 400, 'no login, so nothing to invite');
  const list = (await admin.get('/api/users')).body;
  assert.ok(list.some((u) => u.id === p.body.id && u.has_account === false));
});

test('checked "Create login and send invite": employee + linked account with the chosen role, and one invite', async () => {
  const outboxBefore = count('SELECT COUNT(*) c FROM outbox');
  const r = await admin.post('/api/users', { name: 'Ivy Invited', email: 'ivy@nutricost.com', role: 'admin', login: true, invite: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.has_account, true);
  assert.equal(r.body.role, 'admin');
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', r.body.id), 1);
  assert.equal(count("SELECT COUNT(*) c FROM tokens WHERE user_id = ? AND purpose = 'reset'", r.body.account_id), 1, 'invite token issued');
  assert.equal(count('SELECT COUNT(*) c FROM outbox'), outboxBefore + 1, 'one invite email');
});

test('an employee with no login and no email is allowed; a bad email is not', async () => {
  const p = await admin.post('/api/users', { name: 'Mailless Mo', login: false });
  assert.equal(p.status, 200);
  assert.equal(p.body.email, null);
  assert.equal((await admin.post('/api/users', { name: 'Bad Mail', email: 'nope', login: false })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Needs Mail' })).status, 400, 'a login needs an email');
});

test('a request can be raised for a no-login employee, and history stays linked to the person', async () => {
  const p = (await admin.post('/api/users', { name: 'Quiet Quinn', email: 'quiet@nutricost.com', login: false })).body;
  const r = await admin.post('/api/requests', { user_id: p.id, category: 'Monitor' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user_id, p.id);
  const list = (await admin.get('/api/requests')).body.find((x) => x.id === r.body.id);
  assert.equal(list.user_name, 'Quiet Quinn');
  assert.equal(list.created_by_name, 'Ada Admin', 'the actor is the admin account, shown by its employee name');
});

// ---------------------------------------------------------------- account linking
test('an existing employee can be given exactly one login, without duplicating the person', async () => {
  const p = (await admin.post('/api/users', { name: 'Linda Linked', email: 'linda@nutricost.com', login: false })).body;
  const empBefore = count('SELECT COUNT(*) c FROM employees');
  const r = await admin.post(`/api/users/${p.id}/account`, { role: 'employee', invite: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, p.id);
  assert.equal(r.body.has_account, true);
  assert.equal(r.body.login_email, 'linda@nutricost.com');
  assert.equal(count('SELECT COUNT(*) c FROM employees'), empBefore, 'no second employee');
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', p.id), 1);
  const again = await admin.post(`/api/users/${p.id}/account`, { role: 'admin' });
  assert.equal(again.status, 400, 'at most one account per employee');
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', p.id), 1);
});

test('linking validates the login email: required, well-formed, unique', async () => {
  const noMail = (await admin.post('/api/users', { name: 'No Mail Nate', login: false })).body;
  assert.equal((await admin.post(`/api/users/${noMail.id}/account`, {})).status, 400);
  assert.equal((await admin.post(`/api/users/${noMail.id}/account`, { email: 'not-an-email' })).status, 400);
  assert.equal((await admin.post(`/api/users/${noMail.id}/account`, { email: 'ada@nutricost.com' })).status, 400, 'login email already used');
  const other = (await admin.post('/api/users', { name: 'Other Person', email: 'otherperson@nutricost.com', login: false })).body;
  assert.equal((await admin.post(`/api/users/${noMail.id}/account`, { email: 'otherperson@nutricost.com' })).status, 400, 'belongs to another employee');
  assert.equal((await admin.post('/api/users/99999/account', { email: 'ghost@nutricost.com' })).status, 404);
  const ok = await admin.post(`/api/users/${noMail.id}/account`, { email: 'Nate.Login@Nutricost.com', role: 'admin', invite: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.login_email, 'nate.login@nutricost.com');
  assert.equal(ok.body.role, 'admin');
  assert.equal(ok.body.work_email, 'nate.login@nutricost.com', 'a person with no work email adopts the login email');
  assert.ok(other.id);
});

test('duplicate person or login emails are rejected case-insensitively on create', async () => {
  await admin.post('/api/users', { name: 'First Fred', email: 'fred@nutricost.com', login: false });
  assert.equal((await admin.post('/api/users', { name: 'Second Fred', email: ' FRED@nutricost.com ', login: false })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Third Fred', email: 'fred@nutricost.com' })).status, 400);
});

// ---------------------------------------------------------------- deactivation keeps the person
test('deactivating disables the login and keeps the person and their assignments', async () => {
  const { c, person } = await withLogin('Dexter Deactivate', 'dexter@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'Dex Laptop' })).body;
  await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: person.id });
  const r = await admin.put(`/api/users/${person.id}`, { name: 'Dexter Deactivate', email: 'dexter@nutricost.com', role: 'employee', active: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false);
  assert.equal((await c.get('/api/me')).status, 401, 'existing session is signed out');
  assert.equal((await loginAs('dexter@nutricost.com', 'employee-password-1')).status, 401);
  assert.equal(count('SELECT COUNT(*) c FROM employees WHERE id = ?', person.id), 1);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE user_id = ? AND returned_at IS NULL', person.id), 1);
  const back = await admin.put(`/api/users/${person.id}`, { name: 'Dexter Deactivate', email: 'dexter@nutricost.com', role: 'employee', active: true });
  assert.equal(back.body.active, true);
  assert.equal((await loginAs('dexter@nutricost.com', 'employee-password-1')).status, 200);
});

test('an admin cannot demote or deactivate their own account', async () => {
  const me = (await admin.get('/api/me')).body.user;
  assert.equal((await admin.put(`/api/users/${me.id}`, { role: 'employee' })).status, 400);
  assert.equal((await admin.put(`/api/users/${me.id}`, { active: false })).status, 400);
});

// ---------------------------------------------------------------- migration
function preSplitDb(dir) {
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const old = new Database(path.join(dir, 'assets.db'));
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 4)); // the schema Phase 1C left behind
  return old;
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-split-'));
function loadDb(dir) {
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/db')];
  return require('../src/db');
}

test('pre-1D database: every user becomes one employee + one linked account with the same id; everything else survives', async () => {
  const dir = tmpDir();
  const old = preSplitDb(dir);
  const hash = bcrypt.hashSync('legacy-password-1', 4);
  const u = old.prepare('INSERT INTO users (id, name, email, password_hash, role, department, title, phone, active, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  u.run(1, 'Old Admin', 'Old.Admin@Nutricost.com', hash, 'admin', 'IT', 'Manager', '555-0001', 1, '2025-01-01 10:00:00', '2025-06-01 09:00:00');
  u.run(2, 'Old Employee', 'old.emp@nutricost.com', hash, 'user', 'Sales', null, null, 1, '2025-02-01 10:00:00', null);
  u.run(5, 'Gone Person', 'gone@nutricost.com', null, 'user', null, null, null, 0, '2025-03-01 10:00:00', null);
  old.prepare("INSERT INTO assets (tag, name) VALUES ('NC-00001', 'Laptop'), ('NC-00002', 'Phone')").run();
  old.prepare("INSERT INTO assignments (asset_id, user_id, checked_out_by, returned_at, returned_to) VALUES (1, 2, 1, '2025-05-01 00:00:00', 1)").run();
  old.prepare('INSERT INTO assignments (asset_id, user_id, checked_out_by) VALUES (2, 2, 1)').run();
  old.prepare("INSERT INTO photos (asset_id, filename, thumb, uploaded_by) VALUES (1, 'a.jpg', 'a_t.jpg', 2)").run();
  old.prepare("INSERT INTO requests (type, user_id, asset_id, created_by, resolved_by) VALUES ('equipment', 2, 1, 2, 1)").run();
  old.prepare("INSERT INTO activity (asset_id, actor_id, subject_user_id, action) VALUES (1, 1, 2, 'checked_out')").run();
  old.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('tok123', 2, 'reset', '2999-01-01T00:00:00.000Z')").run();
  old.prepare("INSERT INTO sessions (sid, sess, expires) VALUES ('s1', '{\"uid\":2}', 9999999999999)").run();
  old.prepare("DELETE FROM users WHERE id = 5").run(); old.prepare("INSERT INTO users (id, name, email, role, active) VALUES (5, 'Gone Person', 'gone@nutricost.com', 'user', 0)").run();
  const usersSeq = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq;
  old.close();

  const mod = loadDb(dir);
  const d = mod.db;
  assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'users'").get().c, 0, 'users is gone: no second source of truth');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM employees').get().c, 3);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM accounts').get().c, 3);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM accounts WHERE employee_id IS NULL').get().c, 0);

  const a1 = d.prepare('SELECT * FROM accounts WHERE id = 1').get();
  assert.deepEqual([a1.employee_id, a1.role, a1.login_email, a1.active, a1.last_login_at], [1, 'admin', 'old.admin@nutricost.com', 1, '2025-06-01 09:00:00']);
  assert.ok(bcrypt.compareSync('legacy-password-1', a1.password_hash), 'password hash carried over untouched');
  const a2 = d.prepare('SELECT * FROM accounts WHERE id = 2').get();
  assert.deepEqual([a2.employee_id, a2.role], [2, 'employee'], 'legacy "user" becomes "employee"');
  const a5 = d.prepare('SELECT * FROM accounts WHERE id = 5').get();
  assert.deepEqual([a5.active, a5.password_hash], [0, null]);
  const e1 = d.prepare('SELECT * FROM employees WHERE id = 1').get();
  assert.deepEqual([e1.name, e1.work_email, e1.department, e1.title, e1.phone, e1.status, e1.created_at], ['Old Admin', 'old.admin@nutricost.com', 'IT', 'Manager', '555-0001', 'active', '2025-01-01 10:00:00']);
  assert.equal(d.prepare('SELECT status FROM employees WHERE id = 5').get().status, 'inactive');

  assert.equal(d.prepare('SELECT COUNT(*) c FROM assignments WHERE user_id = 2').get().c, 2);
  assert.deepEqual({ ...d.prepare('SELECT checked_out_by, returned_to FROM assignments WHERE id = 1').get() }, { checked_out_by: 1, returned_to: 1 });
  assert.equal(d.prepare('SELECT uploaded_by FROM photos').get().uploaded_by, 2);
  assert.deepEqual({ ...d.prepare('SELECT user_id, created_by, resolved_by FROM requests').get() }, { user_id: 2, created_by: 2, resolved_by: 1 });
  assert.deepEqual({ ...d.prepare('SELECT actor_id, subject_user_id FROM activity').get() }, { actor_id: 1, subject_user_id: 2 });
  assert.equal(d.prepare("SELECT user_id FROM tokens WHERE token = 'tok123'").get().user_id, 2);
  assert.equal(d.prepare('SELECT sess FROM sessions').get().sess, '{"uid":2}', 'existing sessions untouched, and uid still names the same account');
  assert.equal(d.pragma('foreign_key_check').length, 0);
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  for (const t of ['employees', 'accounts']) assert.equal(d.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t).seq, usersSeq, `${t} keeps the legacy id high-water mark`);
  const fks = (t) => d.pragma(`foreign_key_list(${t})`).map((f) => `${f.from}->${f.table}`).sort();
  assert.deepEqual(fks('assignments'), ['asset_id->assets', 'checked_out_by->accounts', 'returned_to->accounts', 'user_id->employees']);
  assert.deepEqual(fks('requests'), ['asset_id->assets', 'created_by->accounts', 'resolved_by->accounts', 'user_id->employees']);
  assert.deepEqual(fks('activity'), ['actor_id->accounts', 'asset_id->assets', 'subject_user_id->employees']);
  assert.deepEqual(fks('tokens'), ['user_id->accounts']);
  assert.deepEqual(fks('photos'), ['asset_id->assets', 'uploaded_by->accounts']);
  const stamp = d.prepare('SELECT applied_at FROM schema_migrations WHERE id = 5').get().applied_at;
  d.close();

  // second startup: idempotent, and the migrated credentials really work over HTTP
  const again = loadDb(dir);
  assert.equal(again.db.prepare('SELECT applied_at FROM schema_migrations WHERE id = 5').get().applied_at, stamp);
  assert.equal(again.db.prepare('SELECT COUNT(*) c FROM employees').get().c, 3);
  again.db.close();
  process.env.DATA_DIR = dir; process.env.SESSION_SECRET = 'test-secret-not-for-production'; process.env.APP_URL = 'http://localhost';
  for (const m of ['../src/db', '../src/mailer', '../src/server']) delete require.cache[require.resolve(m)];
  const app = require('../src/server');
  const srv = await startServer(app);
  try {
    const adminC = makeClient(srv); const empC = makeClient(srv);
    assert.equal((await adminC.post('/api/login', { email: 'old.admin@nutricost.com', password: 'legacy-password-1' })).status, 200);
    assert.equal((await empC.post('/api/login', { email: 'old.emp@nutricost.com', password: 'legacy-password-1' })).status, 200);
    assert.equal((await makeClient(srv).post('/api/login', { email: 'gone@nutricost.com', password: 'x' })).status, 401);
    const ma = (await adminC.get('/api/me')).body.user;
    assert.deepEqual([ma.id, ma.account_id, ma.role, ma.name, ma.email], [1, 1, 'admin', 'Old Admin', 'old.admin@nutricost.com']);
    const me = (await empC.get('/api/me')).body.user;
    assert.deepEqual([me.id, me.role], [2, 'employee']);
    assert.equal((await empC.get('/api/settings')).status, 403);
    assert.equal((await adminC.get('/api/settings')).status, 200);
    const dash = (await empC.get('/api/dashboard')).body;
    assert.equal(dash.mine.length, 1, 'legacy assignment still shows for the migrated employee');
    const list = (await adminC.get('/api/users')).body;
    assert.equal(list.length, 3);
  } finally {
    await stopServer(srv);
    require('../src/db').db.close();
  }
});

test('the split refuses to run (and changes nothing) if two users collide after email normalization', () => {
  const dir = tmpDir();
  const old = preSplitDb(dir);
  old.prepare("INSERT INTO users (name, email) VALUES ('One', 'dup@nutricost.com'), ('Two', ' DUP@nutricost.com')").run();
  old.close();
  assert.throws(() => loadDb(dir), /duplicate emails/);
  const check = new Database(path.join(dir, 'assets.db'));
  assert.equal(check.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'users'").get().c, 1);
  assert.equal(check.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('employees','accounts')").get().c, 0);
  assert.equal(check.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE id = 5').get().c, 0);
  check.close();
});
