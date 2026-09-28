const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;

before(async () => {
  const { app, db: _db } = bootApp();
  db = _db;
  server = await startServer(app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

test('CSV export includes a header row and the assets that exist', async () => {
  await admin.post('/api/assets', { name: 'Exportable Thing', tag: 'NC-EXP1', purchase_cost: 42.5 });
  const r = await admin.get('/api/export/assets.csv');
  assert.equal(r.status, 200);
  // fetch's UTF-8 decoder strips the leading BOM the server sends; a real browser download keeps it.
  assert.match(r.text, /^tag,name,category/);
  assert.match(r.text, /NC-EXP1,Exportable Thing/);
});

test('a non-admin cannot export or import', async () => {
  const created = await admin.post('/api/users', { name: 'Ivy Import', email: 'ivy@nutricost.com' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose='reset'").get(created.body.id);
  const c = makeClient(server);
  await c.post('/api/reset', { token: tok.token, password: 'ivy-password-1' });
  assert.equal((await c.get('/api/export/assets.csv')).status, 403);
});

test('CSV import creates new assets and reports row errors', async () => {
  const csv = 'name,tag,category,purchase_cost\nImported Laptop,NC-IMP1,Laptop,"1,299.00"\n,NC-IMP2,Laptop,500\n';
  const r = await admin.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 1);
  assert.equal(r.body.errors.length, 1);

  const list = await admin.get('/api/assets?q=Imported');
  const found = list.body.find((a) => a.tag === 'NC-IMP1');
  assert.equal(found.purchase_cost, 1299);
});

test('CSV import updates an existing asset by tag instead of duplicating it', async () => {
  await admin.post('/api/assets', { name: 'Original Name', tag: 'NC-IMP-UPD', location: 'HQ - IT Room' });
  const csv = 'tag,name,location\nNC-IMP-UPD,Original Name,Warehouse\n';
  const r = await admin.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: csv });
  assert.equal(r.body.updated, 1);
  assert.equal(r.body.created, 0);

  const list = await admin.get('/api/assets?q=Original');
  const found = list.body.find((a) => a.tag === 'NC-IMP-UPD');
  assert.equal(found.location, 'Warehouse');
});

test('CSV import can assign an asset to an existing user by email', async () => {
  const created = await admin.post('/api/users', { name: 'Assignee Amy', email: 'amy@nutricost.com' });
  const csv = `name,tag,assigned_email\nAssigned Thing,NC-IMP-ASSIGN,amy@nutricost.com\n`;
  const r = await admin.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: csv });
  assert.equal(r.body.created, 1);

  const list = await admin.get('/api/assets?q=Assigned Thing');
  const found = list.body.find((a) => a.tag === 'NC-IMP-ASSIGN');
  assert.equal(found.status, 'checked_out');
  assert.equal(found.holder_names, 'Assignee Amy');
});

test('importing with only a header row (no data) is rejected', async () => {
  const r = await admin.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: 'name,tag\n' });
  assert.equal(r.status, 400);
});
