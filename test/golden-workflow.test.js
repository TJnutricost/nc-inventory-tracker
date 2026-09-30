// Proves the core inventory lifecycle end-to-end over the real HTTP API, against
// an isolated throwaway SQLite DB (bootApp() below) — never ./data or ./data-dev:
//   scan/lookup -> assign -> re-scan -> check in -> re-scan, with history intact.
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
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.id);
  const c = makeClient(server);
  const r = await c.post('/api/reset', { token: tok.token, password: 'golden-employee-1' });
  assert.equal(r.status, 200);
  return { client: c, id: created.body.id, name: created.body.name };
}

test('golden path: lookup -> assign -> re-lookup -> check in -> re-lookup, with history intact', async () => {
  const TAG = 'NC-GOLDEN1';
  const employee = await makeEmployee('Golden Pathson', 'golden.pathson@nutricost.com');

  // STEP 1 — initial state
  const created = await admin.post('/api/assets', { name: 'Golden Path Laptop', category: 'Laptop', tag: TAG });
  assert.equal(created.status, 200);
  const assetId = created.body.id;
  assert.equal(created.body.tag, TAG);
  assert.equal(created.body.status, 'available');

  const initial = await admin.get(`/api/assets/${assetId}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.holders.length, 0, 'a freshly created asset must have no active assignment');

  // STEP 2 — scan/lookup, via the same endpoint the scanner and manual-entry UI use
  const lookup1 = await admin.get(`/api/assets/lookup/${TAG}`);
  assert.equal(lookup1.status, 200);
  assert.equal(lookup1.body.found, true);
  assert.equal(lookup1.body.id, assetId);
  const detail1 = await admin.get(`/api/assets/${lookup1.body.id}`);
  assert.equal(detail1.status, 200);
  assert.equal(detail1.body.asset.status, 'available');

  // STEP 3 — assign to the known employee
  const checkout = await admin.post(`/api/assets/${assetId}/checkout`, { user_id: employee.id });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const assignmentId = checkout.body.assignment.id;
  assert.equal(checkout.body.assignment.employee_id, employee.id);

  const afterAssign = await admin.get(`/api/assets/${assetId}`);
  assert.equal(afterAssign.body.asset.status, 'checked_out');
  assert.equal(afterAssign.body.holders.length, 1);
  assert.equal(afterAssign.body.holders[0].employee_id, employee.id);
  const checkedOutEntry = afterAssign.body.activity.find((a) => a.action === 'checked_out');
  assert.ok(checkedOutEntry, 'expected a checked_out activity entry');
  assert.equal(checkedOutEntry.subject_user_id, employee.id);

  // STEP 4 — re-scan after assignment
  const lookup2 = await admin.get(`/api/assets/lookup/${TAG}`);
  assert.equal(lookup2.body.found, true);
  assert.equal(lookup2.body.id, assetId);
  const detail2 = await admin.get(`/api/assets/${lookup2.body.id}`);
  assert.equal(detail2.body.holders.length, 1);
  assert.equal(detail2.body.holders[0].user_name, employee.name);

  // STEP 5 — check in
  const checkin = await admin.post(`/api/assets/${assetId}/checkin`, { condition: 'Good' });
  assert.equal(checkin.status, 200, JSON.stringify(checkin.body));

  const afterCheckin = await admin.get(`/api/assets/${assetId}`);
  assert.equal(afterCheckin.body.asset.status, 'available');
  assert.equal(afterCheckin.body.holders.length, 0);
  const checkedInEntry = afterCheckin.body.activity.find((a) => a.action === 'checked_in');
  assert.ok(checkedInEntry, 'expected a checked_in activity entry');

  // STEP 6 — final re-scan
  const lookup3 = await admin.get(`/api/assets/lookup/${TAG}`);
  assert.equal(lookup3.body.found, true);
  assert.equal(lookup3.body.id, assetId);
  const final = await admin.get(`/api/assets/${lookup3.body.id}`);
  assert.equal(final.body.asset.status, 'available');
  assert.equal(final.body.holders.length, 0);

  // Historical integrity: the completed assignment row must still exist, untouched by delete.
  const historyRow = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
  assert.ok(historyRow, 'the completed assignment must not be deleted on check-in');
  assert.equal(historyRow.employee_id, employee.id);
  assert.ok(historyRow.checked_out_at, 'checkout timestamp must be preserved');
  assert.ok(historyRow.returned_at, 'assignment must be closed (returned_at set), not removed');
  assert.equal(historyRow.condition_in, 'Good');

  const lifecycleEntries = final.body.activity.filter((a) => ['checked_out', 'checked_in'].includes(a.action));
  assert.equal(lifecycleEntries.length, 2, 'both checkout and check-in activity must remain visible in history');
});

test('looking up an unknown tag returns found:false', async () => {
  const r = await admin.get('/api/assets/lookup/NC-DOES-NOT-EXIST');
  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
});

test('checking in an asset with no active assignment fails safely', async () => {
  const created = await admin.post('/api/assets', { name: 'Never Checked Out', category: 'Other' });
  const r = await admin.post(`/api/assets/${created.body.id}/checkin`, {});
  assert.equal(r.status, 400);
});

test('a single-capacity asset cannot be double-assigned', async () => {
  const created = await admin.post('/api/assets', { name: 'Single Seat Item', category: 'Other' });
  const a = await makeEmployee('Alpha Employee', 'alpha.guard@nutricost.com');
  const b = await makeEmployee('Beta Employee', 'beta.guard@nutricost.com');

  const first = await admin.post(`/api/assets/${created.body.id}/checkout`, { user_id: a.id });
  assert.equal(first.status, 200);
  const second = await admin.post(`/api/assets/${created.body.id}/checkout`, { user_id: b.id });
  assert.equal(second.status, 400);

  const openCount = db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(created.body.id).c;
  assert.equal(openCount, 1, 'exactly one active assignment must exist, not two');
});
