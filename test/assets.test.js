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

// Creates a regular employee account and returns a client already logged in as them,
// by reading the invite token straight out of the DB (no email transport in tests).
async function makeEmployee(name, email) {
  const created = await admin.post('/api/users', { name, email, role: 'user', invite: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.id);
  const c = makeClient(server);
  const r = await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' });
  assert.equal(r.status, 200);
  return { client: c, id: created.body.id };
}

test('a non-admin cannot create users', async () => {
  const { client } = await makeEmployee('Ezra Employee', 'ezra@nutricost.com');
  const r = await client.post('/api/users', { name: 'Sneaky', email: 'sneaky@nutricost.com' });
  assert.equal(r.status, 403);
});

test('creating a user with a duplicate email is rejected', async () => {
  const r = await admin.post('/api/users', { name: 'Dup', email: 'ezra@nutricost.com' });
  assert.equal(r.status, 400);
});

test('non-admins cannot create assets', async () => {
  const emp = await makeEmployee('Nora NoAccess', 'nora@nutricost.com');
  const r = await emp.client.post('/api/assets', { name: 'Sneaky Laptop' });
  assert.equal(r.status, 403);
});

test('creating an asset without a name is rejected', async () => {
  const r = await admin.post('/api/assets', { category: 'Laptop' });
  assert.equal(r.status, 400);
});

test('creating an asset auto-assigns the next tag and defaults', async () => {
  const r = await admin.post('/api/assets', { name: 'Dell Latitude 7440', category: 'Laptop' });
  assert.equal(r.status, 200);
  assert.match(r.body.tag, /^NC-\d{5}$/);
  assert.equal(r.body.status, 'available');
  assert.equal(r.body.condition, 'Good');
});

test('duplicate tags are rejected', async () => {
  const first = await admin.post('/api/assets', { name: 'Monitor A', tag: 'NC-DUP1' });
  assert.equal(first.status, 200);
  const second = await admin.post('/api/assets', { name: 'Monitor B', tag: 'NC-DUP1' });
  assert.equal(second.status, 400);
});

test('checkout, capacity, and check-in lifecycle', async () => {
  const emp = await makeEmployee('Val Vasquez', 'val@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'ThinkPad X1', tag: 'NC-LIFE1' })).body;

  // Admin checks it out to Val
  const co = await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: emp.id, due_date: '2099-01-01' });
  assert.equal(co.status, 200);

  // Single-seat asset: checking it out to a second person fails
  const other = await makeEmployee('Ollie Other', 'ollie@nutricost.com');
  const coBlocked = await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: other.id });
  assert.equal(coBlocked.status, 400);

  // Val cannot see purchase cost / vendor / notes (not admin), but does see the license key because it's her item
  const view = await emp.client.get(`/api/assets/${asset.id}`);
  assert.equal(view.status, 200);
  assert.equal('purchase_cost' in view.body.asset, false);
  assert.equal(view.body.is_mine, true);

  // Admin checks it back in
  const holders = (await admin.get(`/api/assets/${asset.id}`)).body.holders;
  const checkin = await admin.post(`/api/assets/${asset.id}/checkin`, { assignment_id: holders[0].id, condition: 'Good' });
  assert.equal(checkin.status, 200);

  const after = await admin.get(`/api/assets/${asset.id}`);
  assert.equal(after.body.asset.status, 'available');
  assert.equal(after.body.seats_used, 0);
});

test('a retired asset cannot be checked out', async () => {
  const emp = await makeEmployee('Rae Retired', 'rae@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'Old Printer', tag: 'NC-RET1' })).body;
  await admin.put(`/api/assets/${asset.id}`, { status: 'retired' });
  const r = await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: emp.id });
  assert.equal(r.status, 400);
});

test('self check-out works when enabled and is blocked when disabled', async () => {
  const emp = await makeEmployee('Sam Selfserve', 'sam@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'Spare Headset', tag: 'NC-SELF1' })).body;

  await admin.put('/api/settings', { self_checkout: true });
  const ok = await emp.client.post(`/api/assets/${asset.id}/checkout`, {});
  assert.equal(ok.status, 200);
  await admin.post(`/api/assets/${asset.id}/checkin`, { condition: 'Good' });

  await admin.put('/api/settings', { self_checkout: false });
  const blocked = await emp.client.post(`/api/assets/${asset.id}/checkout`, {});
  assert.equal(blocked.status, 403);
  await admin.put('/api/settings', { self_checkout: true }); // restore for later tests
});

test('license-seat assets allow concurrent holders up to capacity', async () => {
  const a = await makeEmployee('Lic One', 'lic1@nutricost.com');
  const b = await makeEmployee('Lic Two', 'lic2@nutricost.com');
  const c = await makeEmployee('Lic Three', 'lic3@nutricost.com');
  const license = (await admin.post('/api/assets', { name: 'Adobe CC', category: 'Software License', tag: 'NC-LIC1', license_seats: 2 })).body;

  assert.equal((await admin.post(`/api/assets/${license.id}/checkout`, { user_id: a.id })).status, 200);
  assert.equal((await admin.post(`/api/assets/${license.id}/checkout`, { user_id: b.id })).status, 200);
  const third = await admin.post(`/api/assets/${license.id}/checkout`, { user_id: c.id });
  assert.equal(third.status, 400);

  const view = await admin.get(`/api/assets/${license.id}`);
  assert.equal(view.body.seats_used, 2);
  assert.equal(view.body.asset.status, 'checked_out');
});

test('the legacy DELETE route archives instead of removing the asset', async () => {
  const asset = (await admin.post('/api/assets', { name: 'To Delete', tag: 'NC-DEL1' })).body;
  const del = await admin.del(`/api/assets/${asset.id}`);
  assert.equal(del.status, 200);
  const still = await admin.get(`/api/assets/${asset.id}`);
  assert.equal(still.status, 200);
  assert.ok(still.body.asset.archived_at);
});

test('a small uploaded photo is resized and gets a thumbnail', async () => {
  const asset = (await admin.post('/api/assets', { name: 'Photo Subject', tag: 'NC-PHOTO1' })).body;
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const boundary = '----ncTestBoundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await admin.rawPost(`/api/assets/${asset.id}/photos`, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Requested-With': 'fetch' },
    body,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ids.length, 1);

  const view = await admin.get(`/api/assets/${asset.id}`);
  assert.equal(view.body.photos.length, 1);
  assert.ok(view.body.photos[0].thumb);
});
