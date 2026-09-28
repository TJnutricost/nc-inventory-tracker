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

async function makeEmployee(name, email) {
  const created = await admin.post('/api/users', { name, email, role: 'user', invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.id);
  const c = makeClient(server);
  await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' });
  return { client: c, id: created.body.id };
}

test('an employee can ask for equipment, and admin approving it assigns and checks out an asset', async () => {
  const emp = await makeEmployee('Quinn Requester', 'quinn@nutricost.com');
  const req = await emp.client.post('/api/requests', { category: 'Monitor', message: 'Need a second monitor' });
  assert.equal(req.status, 200);
  assert.equal(req.body.status, 'open');

  const asset = (await admin.post('/api/assets', { name: 'Dell Monitor', tag: 'NC-REQ1' })).body;
  const approve = await admin.post(`/api/requests/${req.body.id}/approve`, { asset_id: asset.id });
  assert.equal(approve.status, 200);

  const assetView = await admin.get(`/api/assets/${asset.id}`);
  assert.equal(assetView.body.asset.status, 'checked_out');

  const list = await emp.client.get('/api/requests');
  const mine = list.body.find((r) => r.id === req.body.id);
  assert.equal(mine.status, 'completed');
});

test('denying a request notes the reason and closes it', async () => {
  const emp = await makeEmployee('Deny Me', 'deny@nutricost.com');
  const req = await emp.client.post('/api/requests', { category: 'Phone' });
  const deny = await admin.post(`/api/requests/${req.body.id}/deny`, { note: 'No budget this quarter' });
  assert.equal(deny.status, 200);
  const list = await emp.client.get('/api/requests');
  const mine = list.body.find((r) => r.id === req.body.id);
  assert.equal(mine.status, 'denied');
  assert.equal(mine.resolution_note, 'No budget this quarter');
});

test('a non-admin cannot approve or deny requests', async () => {
  const emp = await makeEmployee('Cant Approve', 'cant@nutricost.com');
  const req = await emp.client.post('/api/requests', { category: 'Keyboard' });
  const approve = await emp.client.post(`/api/requests/${req.body.id}/approve`, {});
  assert.equal(approve.status, 403);
});

test('an employee can cancel their own open request but not someone else\'s', async () => {
  const a = await makeEmployee('Owner A', 'ownera@nutricost.com');
  const b = await makeEmployee('Owner B', 'ownerb@nutricost.com');
  const req = await a.client.post('/api/requests', { category: 'Tablet' });

  const wrongCancel = await b.client.post(`/api/requests/${req.body.id}/cancel`, {});
  assert.equal(wrongCancel.status, 403);

  const ownCancel = await a.client.post(`/api/requests/${req.body.id}/cancel`, {});
  assert.equal(ownCancel.status, 200);
});

test('return-request → drop-off → check-in lifecycle', async () => {
  const emp = await makeEmployee('Holder Hank', 'hank@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'Loaner Laptop', tag: 'NC-RET-FLOW' })).body;
  await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: emp.id });

  const rr = await admin.post(`/api/assets/${asset.id}/request-return`, { message: 'Please bring it back' });
  assert.equal(rr.status, 200);
  assert.equal(rr.body.created, 1);

  // Asking twice while one is already open is a no-op error, not a duplicate
  const dup = await admin.post(`/api/assets/${asset.id}/request-return`, {});
  assert.equal(dup.status, 400);

  const droppedOff = await emp.client.post(`/api/assets/${asset.id}/return-notice`, { note: 'Left it at the front desk' });
  assert.equal(droppedOff.status, 200);

  const openRequests = await admin.get('/api/requests?status=open');
  const found = openRequests.body.find((r) => r.asset_id === asset.id);
  assert.equal(found.status, 'dropped_off');

  const holders = (await admin.get(`/api/assets/${asset.id}`)).body.holders;
  const checkin = await admin.post(`/api/assets/${asset.id}/checkin`, { assignment_id: holders[0].id });
  assert.equal(checkin.status, 200);

  const closed = await admin.get('/api/requests?status=closed');
  const nowClosed = closed.body.find((r) => r.asset_id === asset.id);
  assert.equal(nowClosed.status, 'completed');
});

test('a user cannot send a return-notice for an asset that is not theirs', async () => {
  const emp = await makeEmployee('Not Mine', 'notmine@nutricost.com');
  const asset = (await admin.post('/api/assets', { name: 'Untouched Asset', tag: 'NC-NOTMINE' })).body;
  const r = await emp.client.post(`/api/assets/${asset.id}/return-notice`, {});
  assert.equal(r.status, 400);
});
