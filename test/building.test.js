const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
const row = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
const newPerson = (extra = {}) => admin.post('/api/users', { name: `Bldg Person ${++seq}`, email: `b${seq}@nutricost.com`, invite: false, ...extra });

test('an employee can be created with a free-text building, trimmed', async () => {
  const r = await newPerson({ building: '  Warehouse 2  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.building, 'Warehouse 2');
  assert.equal(row(r.body.id).building, 'Warehouse 2');
});

test('building is optional: omitted, blank and whitespace-only all store null', async () => {
  for (const extra of [{}, { building: '' }, { building: '   ' }]) {
    const r = await newPerson(extra);
    assert.equal(r.status, 200);
    assert.equal(r.body.building, null);
    assert.equal(row(r.body.id).building, null);
  }
});

test('building is free text: any value is stored as typed (no list, no validation)', async () => {
  for (const value of ['Building 4', 'HQ North', 'Annex (old Building 11)', '14']) {
    const r = await newPerson({ building: value });
    assert.equal(r.body.building, value);
  }
});

test('building can be edited, cleared, and survives unrelated edits and the detail API', async () => {
  const p = (await newPerson({ building: 'Building 4', department: 'Ops' })).body;
  const put = (body) => admin.put(`/api/users/${p.id}`, { name: p.name, email: p.email, ...body });

  assert.equal((await put({ department: 'Ops', building: ' HQ North ' })).body.building, 'HQ North');
  assert.equal((await admin.get(`/api/users/${p.id}`)).body.user.building, 'HQ North', 'person detail exposes it');
  assert.equal((await admin.get('/api/users')).body.find((x) => x.id === p.id).building, 'HQ North');

  assert.equal((await admin.put(`/api/users/${p.id}`, { department: 'Finance' })).body.building, 'HQ North', 'a client that does not send building leaves it alone');
  assert.equal((await put({ department: 'Ops', building: '' })).body.building, null, 'an empty string clears it');
});

test('building does not affect login, account or self-checkout behavior', async () => {
  const p = (await newPerson({ building: 'Building 9' })).body;
  assert.equal(p.has_account, true);
  assert.equal(p.login_enabled, true);
  assert.equal(p.can_self_checkout, true);
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'");
  assert.equal(tok.get(p.account_id), undefined, 'invite:false still sends no invite');
  const noLogin = (await admin.post('/api/users', { name: 'Bldg No Login', login: false, building: 'Warehouse 1' })).body;
  assert.deepEqual([noLogin.has_account, noLogin.building], [false, 'Warehouse 1']);
  await admin.put(`/api/users/${p.id}/self-checkout`, { enabled: false });
  assert.equal(row(p.id).building, 'Building 9', 'changing the permission leaves building alone');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?').get(p.id).c, 1);
});
