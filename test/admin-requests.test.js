// Admin Request Workflow V1 (Phase 2, slice 5): requests.opened_at, the derived lifecycle (Submitted / In review / Approved /
// Declined / Fulfilled / Rescinded), and IT's end-to-end handling of equipment, return and issue requests. Every rule is
// enforced on the server; the UI only reflects it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const requestRules = require('../src/requests');
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
const isoPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const count = (sql, ...p) => db.prepare(sql).get(...p).c;
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const node = async (name, parent_id = null) => { const r = await admin.post('/api/catalog', { name, parent_id }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const newAsset = async (name, extra = {}) => { const r = await admin.post('/api/assets', { available_to_request: true, name, tag: `AR-${++seq}`, category: 'Laptop', ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `ar${++seq}@nutricost.com`, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name };
}
const ask = async (who, body) => { const r = await who.client.post('/api/requests', body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const listFor = async (who) => (await who.client.get('/api/requests')).body;
const seen = async (who, id) => (await listFor(who)).find((r) => r.id === id);
const holds = (asset, who) => count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL', asset.id, who.id) === 1;
const give = async (asset, who) => { const r = await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, assignment_type: 'permanent' }); assert.equal(r.status, 200, JSON.stringify(r.body)); };

// ---------------------------------------------------------------- opened_at
test('opened_at starts null; the employee sees the request as Submitted', async () => {
  const me = await makeLogin('Opened Null');
  const r = await ask(me, { category: 'Headset', message: 'wired please' });
  assert.equal(row(r.id).opened_at, null);
  const mine = await seen(me, r.id);
  assert.equal(mine.lifecycle, 'submitted');
  assert.equal(mine.opened_at, null);
  assert.equal(mine.can_cancel, true);
});

test('listing requests has no side effects: only the explicit admin open sets opened_at', async () => {
  const me = await makeLogin('No Get Effects');
  const r = await ask(me, { category: 'Monitor' });
  await admin.get('/api/requests');
  await admin.get('/api/requests?status=open');
  await admin.get('/api/dashboard');
  assert.equal(row(r.id).opened_at, null);
});

test('the first admin open sets opened_at and moves the request to In review; later opens never overwrite it', async () => {
  const me = await makeLogin('First Open');
  const r = await ask(me, { category: 'Dock / Adapter' });
  const first = await admin.post(`/api/requests/${r.id}/open`, {});
  assert.equal(first.status, 200);
  assert.ok(first.body.opened_at, 'timestamp recorded');
  assert.equal(first.body.lifecycle, 'in_review');
  assert.equal(first.body.status, 'open', 'no new status value: it is still an open request');
  // make the stored time recognisable, then open again
  db.prepare("UPDATE requests SET opened_at = '2020-01-02 03:04:05' WHERE id = ?").run(r.id);
  const again = await admin.post(`/api/requests/${r.id}/open`, {});
  assert.equal(again.body.opened_at, '2020-01-02 03:04:05');
  assert.equal(row(r.id).opened_at, '2020-01-02 03:04:05');
  assert.equal((await seen(me, r.id)).lifecycle, 'in_review', 'the employee sees In review');
});

test('opening a request that is already closed changes nothing', async () => {
  const me = await makeLogin('Open Closed');
  const r = await ask(me, { category: 'Headset' });
  assert.equal((await me.client.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
  const res = await admin.post(`/api/requests/${r.id}/open`, {});
  assert.equal(res.status, 200);
  assert.equal(row(r.id).opened_at, null, 'a rescinded request was never opened by IT');
  assert.equal(res.body.lifecycle, 'rescinded');
  assert.equal((await admin.post('/api/requests/999999/open', {})).status, 404);
});

test('only an admin can open a request; an employee (even the owner) cannot, and nothing changes', async () => {
  const me = await makeLogin('Self Opener');
  const other = await makeLogin('Other Opener');
  const r = await ask(me, { category: 'Headset' });
  assert.equal((await me.client.post(`/api/requests/${r.id}/open`, {})).status, 403);
  assert.equal((await other.client.post(`/api/requests/${r.id}/open`, {})).status, 403);
  assert.equal((await makeClient(server).post(`/api/requests/${r.id}/open`, {})).status, 401);
  assert.equal(row(r.id).opened_at, null);
});

// ---------------------------------------------------------------- rescind
test('an employee can rescind before IT opens the request; it reads Rescinded and opened_at stays null', async () => {
  const me = await makeLogin('Early Rescinder');
  const r = await ask(me, { category: 'Webcam' });
  assert.equal((await me.client.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
  const final = await seen(me, r.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.lifecycle, 'rescinded');
  assert.equal(final.opened_at, null);
  assert.equal(final.can_cancel, false);
});

test('an employee cannot rescind once IT has opened the request — enforced by the server, status unchanged', async () => {
  const me = await makeLogin('Late Rescinder 2');
  const r = await ask(me, { category: 'Webcam' });
  await admin.post(`/api/requests/${r.id}/open`, {});
  assert.equal((await seen(me, r.id)).can_cancel, false, 'the server says so, the UI only reflects it');
  const res = await me.client.post(`/api/requests/${r.id}/cancel`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already opened/);
  assert.equal(row(r.id).status, 'open');
  assert.equal(row(r.id).resolved_at, null);
});

test('the rescind guard is part of the same UPDATE: a caller that skipped the policy check still cannot rescind an opened request', () => {
  const emp = db.prepare("INSERT INTO employees (name) VALUES ('Direct Caller')").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO requests (type, user_id, category, opened_at) VALUES ('equipment', ?, 'Headset', datetime('now'))").run(emp).lastInsertRowid;
  assert.throws(() => requestRules.transition(db, id, 'cancelled', { requireUnopened: true }), /already opened/);
  assert.equal(row(id).status, 'open');
  // IT (no requireUnopened) can still close it
  assert.equal(requestRules.transition(db, id, 'cancelled', { actorIsAdmin: true }).status, 'cancelled');
});

test('open-then-rescind and rescind-then-open both end in exactly one coherent state', async () => {
  const me = await makeLogin('Race Person');
  const a = await ask(me, { category: 'Headset' });
  await admin.post(`/api/requests/${a.id}/open`, {});
  assert.equal((await me.client.post(`/api/requests/${a.id}/cancel`, {})).status, 400);
  assert.deepEqual([row(a.id).status, !!row(a.id).opened_at], ['open', true]);
  const b = await ask(me, { category: 'Headset' });
  assert.equal((await me.client.post(`/api/requests/${b.id}/cancel`, {})).status, 200);
  await admin.post(`/api/requests/${b.id}/open`, {});
  assert.deepEqual([row(b.id).status, row(b.id).opened_at], ['cancelled', null]);
});

test('any admin action on a request also counts as opening it', async () => {
  const me = await makeLogin('Acted On');
  const denied = await ask(me, { category: 'Headset' });
  await admin.post(`/api/requests/${denied.id}/deny`, { note: 'no' });
  assert.ok(row(denied.id).opened_at, 'deny');
  const approved = await ask(me, { category: 'Headset' });
  await admin.post(`/api/requests/${approved.id}/approve`, {});
  assert.ok(row(approved.id).opened_at, 'approve');
  const dismissed = await ask(me, { category: 'Headset' });
  await admin.post(`/api/requests/${dismissed.id}/cancel`, {});
  assert.ok(row(dismissed.id).opened_at, 'IT cancelling (dismissing)');
  assert.equal((await seen(me, dismissed.id)).lifecycle, 'cancelled', 'cancelled by IT is not "rescinded"');
});

// ---------------------------------------------------------------- admin transitions
test('equipment: submitted -> in review -> approved -> fulfilled, with the right lifecycle at each step', async () => {
  const me = await makeLogin('Full Path');
  const asset = await newAsset('Full path laptop');
  const r = await ask(me, { category: 'Laptop' });
  assert.equal((await seen(me, r.id)).lifecycle, 'submitted');
  await admin.post(`/api/requests/${r.id}/open`, {});
  assert.equal((await seen(me, r.id)).lifecycle, 'in_review');
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { note: 'ok' })).status, 200);
  const approved = await seen(me, r.id);
  assert.deepEqual([approved.status, approved.lifecycle, approved.resolution_note, approved.can_cancel], ['approved', 'approved', 'ok', false]);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE employee_id = ?', me.id), 0, 'approval alone assigns nothing');
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: asset.id, assignment_type: 'checkout', due_date: isoPlus(7) })).status, 200);
  const done = await seen(me, r.id);
  assert.deepEqual([done.status, done.lifecycle, done.asset_id], ['completed', 'fulfilled', asset.id]);
  assert.ok(done.resolved_at && done.resolved_by_name, 'who and when are recorded');
});

test('equipment: deny, and no transition out of a closed state', async () => {
  const me = await makeLogin('Denied Person');
  const r = await ask(me, { category: 'Headset' });
  assert.equal((await admin.post(`/api/requests/${r.id}/deny`, { note: 'budget' })).status, 200);
  const d = await seen(me, r.id);
  assert.deepEqual([d.lifecycle, d.resolution_note, d.can_cancel], ['denied', 'budget', false], 'the employee sees the decision and the reason');
  for (const path of ['approve', 'deny', 'resolve', 'cancel']) {
    const res = await admin.post(`/api/requests/${r.id}/${path}`, {});
    assert.equal(res.status, 400, `${path} on a denied request`);
  }
  assert.equal(row(r.id).status, 'denied');
});

test('type-specific transitions: approve/deny only for equipment, resolve only for issues, cancel closes a return', async () => {
  const me = await makeLogin('Type Rules');
  const held = await newAsset('Type rules laptop');
  await give(held, me);
  const ret = (await me.client.post(`/api/assets/${held.id}/my-return-request`, {})).body;
  assert.equal((await admin.post(`/api/requests/${ret.id}/approve`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${ret.id}/deny`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${ret.id}/resolve`, {})).status, 400);
  const issue = (await me.client.post(`/api/assets/${held.id}/report-issue`, { message: 'Screen flickers' })).body;
  assert.equal((await admin.post(`/api/requests/${issue.id}/approve`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${issue.id}/deny`, {})).status, 400);
  const equip = await ask(me, { category: 'Headset' });
  assert.equal((await admin.post(`/api/requests/${equip.id}/resolve`, {})).status, 400);
  assert.equal((await admin.post('/api/requests/999999/approve', {})).status, 404);
  assert.deepEqual([row(ret.id).status, row(issue.id).status, row(equip.id).status], ['open', 'open', 'open']);
});

test('an employee cannot invoke any admin request action, and nothing changes', async () => {
  const me = await makeLogin('Not Admin');
  const asset = await newAsset('Not admin asset');
  const r = await ask(me, { category: 'Laptop' });
  for (const [path, body] of [['approve', { asset_id: asset.id, assignment_type: 'permanent' }], ['deny', {}], ['resolve', {}], ['open', {}]]) {
    assert.equal((await me.client.post(`/api/requests/${r.id}/${path}`, body)).status, 403, path);
  }
  assert.deepEqual([row(r.id).status, row(r.id).opened_at, row(r.id).asset_id], ['open', null, null]);
  assert.ok(!holds(asset, me));
});

// ---------------------------------------------------------------- fulfillment
test('fulfilling an equipment request creates the assignment through the normal lifecycle and completes the request together', async () => {
  const me = await makeLogin('Fulfilled Person');
  const asset = await newAsset('Fulfil laptop');
  const r = await ask(me, { category: 'Laptop', message: 'for travel' });
  const before = count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', asset.id);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: asset.id, assignment_type: 'checkout', due_date: isoPlus(5), due_time: '16:00' })).status, 200);
  const a = db.prepare('SELECT * FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me.id);
  assert.deepEqual([a.assignment_type, a.due_date, a.due_time, a.notes], ['checkout', isoPlus(5), '16:00', `Request #${r.id}`]);
  assert.equal(row(r.id).asset_id, asset.id);
  assert.equal(row(r.id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(asset.id).status, 'checked_out', 'asset status follows the assignment');
  assert.ok(count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', asset.id) > before, 'the check-out is in the activity log');
  assert.equal((await me.client.get(`/api/assets/${asset.id}`)).status, 200, 'the employee can open what they now hold');
});

test('a request for a specific asset can only be fulfilled with that asset', async () => {
  const me = await makeLogin('Specific Person');
  const wanted = await newAsset('Wanted laptop');
  const other = await newAsset('Other laptop');
  const r = await ask(me, { asset_id: wanted.id, category: 'Laptop' });
  assert.equal(row(r.id).asset_label, `${wanted.tag} — Wanted laptop`);
  const wrong = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: other.id, assignment_type: 'checkout', due_date: isoPlus(3) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /specific item/);
  assert.deepEqual([row(r.id).status, row(r.id).asset_id], ['open', wanted.id]);
  assert.ok(!holds(other, me) && !holds(wanted, me), 'nothing was assigned');
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: wanted.id, assignment_type: 'checkout', due_date: isoPlus(3) })).status, 200);
  assert.ok(holds(wanted, me) && !holds(other, me));
  assert.equal(row(r.id).status, 'completed');
});

test('a specific-asset request that was approved first is still fulfilled only with the requested asset', async () => {
  const me = await makeLogin('Approved Specific');
  const wanted = await newAsset('Approved wanted');
  const other = await newAsset('Approved other');
  const r = await ask(me, { asset_id: wanted.id, category: 'Laptop' });
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, {})).status, 200);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: other.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 400);
  assert.equal(row(r.id).status, 'approved');
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: wanted.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 200);
  assert.equal(row(r.id).status, 'completed');
});

test('an "any matching" request is fulfilled with any asset filed under the requested catalog entry — and only those', async () => {
  const me = await makeLogin('Any Matching');
  const cam = await node(`Cam AR ${++seq}`);
  const sony = await node('Sony', cam.id);
  const canon = await node('Canon', cam.id);
  const sonyBody = await newAsset('Sony body', { catalog_node_id: sony.id });
  const canonBody = await newAsset('Canon body', { catalog_node_id: canon.id });
  const laptop = await newAsset('Not a camera'); // filed under the Laptop root by its category
  const r = await ask(me, { catalog_node_id: sony.id });
  assert.equal(row(r.id).asset_id, null, 'any matching asset');
  const bad = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: canonBody.id, assignment_type: 'checkout', due_date: isoPlus(2) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /part of the equipment that was requested/);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: laptop.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 400);
  assert.equal(row(r.id).status, 'open');
  assert.ok(!holds(canonBody, me) && !holds(laptop, me));
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: sonyBody.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 200);
  assert.deepEqual([row(r.id).status, row(r.id).asset_id, row(r.id).asset_label], ['completed', sonyBody.id, null], 'the request still reads as "any matching"; the chosen asset is recorded');
  // a request for the broad parent accepts an asset from any branch below it
  const broad = await ask(me, { catalog_node_id: cam.id });
  assert.equal((await admin.post(`/api/requests/${broad.id}/approve`, { asset_id: canonBody.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 200);
});

test('an unavailable, archived or in-repair asset cannot fulfil a request, and nothing is left half-done', async () => {
  const me = await makeLogin('Unavailable');
  const holder = await makeLogin('Holder');
  const taken = await newAsset('Taken laptop');
  await give(taken, holder);
  const repair = await newAsset('Repair laptop', { status: 'maintenance' });
  const archived = await newAsset('Archived laptop');
  assert.equal((await admin.post(`/api/assets/${archived.id}/archive`, {})).status, 200);
  const r = await ask(me, { category: 'Laptop' });
  const assignmentsBefore = count('SELECT COUNT(*) c FROM assignments');
  for (const a of [taken, repair, archived]) {
    const res = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'checkout', due_date: isoPlus(2) });
    assert.equal(res.status, 400, a.name);
  }
  assert.equal(row(r.id).status, 'open');
  assert.equal(row(r.id).asset_id, null);
  assert.equal(count('SELECT COUNT(*) c FROM assignments'), assignmentsBefore);
  assert.ok(holds(taken, holder), 'the existing holder is untouched');
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(repair.id).status, 'maintenance');
});

test('fulfillment is all-or-nothing: if closing the request fails, the assignment is rolled back', async () => {
  const me = await makeLogin('Rollback');
  const asset = await newAsset('Rollback laptop');
  const r = await ask(me, { category: 'Laptop' });
  db.exec("CREATE TRIGGER ar_force_fail BEFORE UPDATE ON requests WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  try {
    const res = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: asset.id, assignment_type: 'checkout', due_date: isoPlus(2) });
    assert.ok(res.status >= 400);
  } finally { db.exec('DROP TRIGGER ar_force_fail'); }
  assert.equal(row(r.id).status, 'open');
  assert.ok(!holds(asset, me), 'no assignment without a fulfilled request');
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(asset.id).status, 'available');
});

test('fulfilling cannot create a second open assignment of the same asset to the same person', async () => {
  const me = await makeLogin('Already Has');
  const asset = await newAsset('Already has laptop');
  await give(asset, me);
  const r = await ask(me, { category: 'Laptop' });
  const res = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: asset.id, assignment_type: 'permanent' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already has this asset/);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL', asset.id, me.id), 1);
  assert.equal(row(r.id).status, 'open');
});

test('a permanent-assignment request is still approved only as that exact permanent assignment', async () => {
  const me = await makeLogin('Permanent Person');
  const a = await newAsset('Perm wanted');
  const b = await newAsset('Perm other');
  const r = await ask(me, { asset_id: a.id, category: 'Laptop', requested_assignment_type: 'permanent' });
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: b.id })).status, 400);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 400);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'permanent' })).status, 200);
  assert.equal(db.prepare("SELECT assignment_type t FROM assignments WHERE asset_id = ? AND employee_id = ?").get(a.id, me.id).t, 'permanent');
  assert.equal(row(r.id).status, 'completed');
});

// ---------------------------------------------------------------- returns
test('return request: the employee drops it off, IT checks it in, and the request is Fulfilled together with the assignment ending', async () => {
  const me = await makeLogin('Returner');
  const asset = await newAsset('Return laptop');
  await give(asset, me);
  const ret = (await me.client.post(`/api/assets/${asset.id}/my-return-request`, { message: 'upgrading' })).body;
  assert.equal((await seen(me, ret.id)).lifecycle, 'submitted');
  await admin.post(`/api/requests/${ret.id}/open`, {});
  assert.equal((await me.client.post(`/api/requests/${ret.id}/cancel`, {})).status, 400, 'IT has it now');
  assert.equal((await me.client.post(`/api/requests/${ret.id}/dropped-off`, {})).status, 200);
  assert.equal((await seen(me, ret.id)).lifecycle, 'dropped_off');
  assert.ok(holds(asset, me), 'still assigned until IT checks it in');
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkin`, { assignment_id: db.prepare('SELECT id FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me.id).id, condition: 'Good' })).status, 200);
  assert.ok(!holds(asset, me));
  const done = await seen(me, ret.id);
  assert.deepEqual([done.status, done.lifecycle], ['completed', 'fulfilled']);
  assert.ok(done.opened_at && done.resolved_at);
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(asset.id).status, 'available');
});

test('check-in is all-or-nothing with its return request', async () => {
  const me = await makeLogin('Checkin Rollback');
  const asset = await newAsset('Checkin rollback laptop');
  await give(asset, me);
  const ret = (await admin.post(`/api/assets/${asset.id}/request-return`, { employee_id: me.id })).body;
  assert.equal(ret.ok, true);
  db.exec("CREATE TRIGGER ar_force_fail2 BEFORE UPDATE ON requests WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  try {
    const res = await admin.post(`/api/assets/${asset.id}/checkin`, {});
    assert.ok(res.status >= 400);
  } finally { db.exec('DROP TRIGGER ar_force_fail2'); }
  assert.ok(holds(asset, me), 'the assignment did not end without its request being completed');
  assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'return' AND asset_id = ? AND status = 'open'", asset.id), 1);
});

// ---------------------------------------------------------------- issues
test('issue report: opened by IT, then resolved with a note the employee sees; or withdrawn only before IT opens it', async () => {
  const me = await makeLogin('Reporter');
  const asset = await newAsset('Issue laptop');
  await give(asset, me);
  const issue = (await me.client.post(`/api/assets/${asset.id}/report-issue`, { message: 'Keyboard sticks' })).body;
  assert.equal((await seen(me, issue.id)).lifecycle, 'submitted');
  await admin.post(`/api/requests/${issue.id}/open`, {});
  const mine = await seen(me, issue.id);
  assert.deepEqual([mine.lifecycle, mine.can_cancel], ['in_review', false]);
  assert.equal((await me.client.post(`/api/requests/${issue.id}/cancel`, {})).status, 400, 'cannot withdraw once IT has it');
  assert.equal((await admin.post(`/api/requests/${issue.id}/resolve`, { note: 'Replaced keyboard' })).status, 200);
  const done = await seen(me, issue.id);
  assert.deepEqual([done.status, done.lifecycle, done.resolution_note], ['completed', 'fulfilled', 'Replaced keyboard']);
  // an untouched issue may still be withdrawn; one IT dismisses reads "cancelled", not "rescinded"
  const second = (await me.client.post(`/api/assets/${asset.id}/report-issue`, { message: 'Hinge squeaks' })).body;
  assert.equal((await me.client.post(`/api/requests/${second.id}/cancel`, {})).status, 200);
  assert.equal((await seen(me, second.id)).lifecycle, 'rescinded');
  const third = (await me.client.post(`/api/assets/${asset.id}/report-issue`, { message: 'Fan noise' })).body;
  assert.equal((await admin.post(`/api/requests/${third.id}/cancel`, {})).status, 200);
  assert.equal((await seen(me, third.id)).lifecycle, 'cancelled');
});

// ---------------------------------------------------------------- privacy & employee view
test('employees only ever see their own requests, with the final state; admins see everyone', async () => {
  const a = await makeLogin('Private A');
  const b = await makeLogin('Private B');
  const ra = await ask(a, { category: 'Headset', message: 'A secret' });
  const rb = await ask(b, { category: 'Monitor' });
  await admin.post(`/api/requests/${ra.id}/deny`, { note: 'not this quarter' });
  const aSees = await listFor(a);
  assert.ok(aSees.some((r) => r.id === ra.id) && !aSees.some((r) => r.id === rb.id));
  const bSees = await listFor(b);
  assert.ok(bSees.some((r) => r.id === rb.id) && !bSees.some((r) => r.id === ra.id));
  assert.equal(JSON.stringify(bSees).includes('A secret'), false);
  assert.equal(aSees.find((r) => r.id === ra.id).lifecycle, 'denied');
  assert.equal(aSees.find((r) => r.id === ra.id).resolution_note, 'not this quarter');
  const adminSees = (await admin.get('/api/requests')).body;
  assert.ok([ra.id, rb.id].every((id) => adminSees.some((r) => r.id === id)));
  assert.equal(adminSees.find((r) => r.id === rb.id).lifecycle, 'submitted');
  // employee cannot touch or rescind someone else's
  assert.equal((await b.client.post(`/api/requests/${ra.id}/cancel`, {})).status, 403);
});

test('Home shows the lifecycle for the employee\'s open requests and for IT\'s open queue', async () => {
  const me = await makeLogin('Home Lifecycle');
  const r = await ask(me, { category: 'Headset' });
  await admin.post(`/api/requests/${r.id}/open`, {});
  const mine = (await me.client.get('/api/dashboard')).body.myRequests.find((x) => x.id === r.id);
  assert.equal(mine.lifecycle, 'in_review');
  const queue = (await admin.get('/api/dashboard')).body.openRequests.find((x) => x.id === r.id);
  assert.equal(queue.lifecycle, 'in_review');
});

// ---------------------------------------------------------------- lifecycle derivation + migration
test('lifecycle() maps status + opened_at (+ who cancelled) onto the user-facing states', () => {
  const emp = db.prepare("INSERT INTO employees (name) VALUES ('Life Cycle')").run().lastInsertRowid;
  const l = (r) => requestRules.lifecycle(db, { user_id: emp, resolved_by: null, opened_at: null, ...r });
  assert.equal(l({ status: 'open' }), 'submitted');
  assert.equal(l({ status: 'open', opened_at: '2026-01-01 00:00:00' }), 'in_review');
  assert.equal(l({ status: 'approved' }), 'approved');
  assert.equal(l({ status: 'dropped_off' }), 'dropped_off');
  assert.equal(l({ status: 'denied' }), 'denied');
  assert.equal(l({ status: 'completed' }), 'fulfilled');
  assert.equal(l({ status: 'cancelled' }), 'cancelled');
  // 'rescinded' = the requester's own login did the cancelling
  const created = db.prepare("INSERT INTO accounts (login_email, employee_id, role) VALUES ('lifecycle@example.com', ?, 'employee')").run(emp);
  assert.equal(l({ status: 'cancelled', resolved_by: created.lastInsertRowid }), 'rescinded');
});

test('migration 12 adds opened_at; requests that were already handled count as opened, untouched ones stay null', () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d, migrations.filter((m) => m.id < 12));
  d.prepare("INSERT INTO employees (name) VALUES ('Old Employee')").run();
  d.prepare("INSERT INTO accounts (login_email, employee_id, role) VALUES ('old@example.com', 1, 'employee')").run();
  const ins = d.prepare("INSERT INTO requests (type, status, user_id, category, created_at, resolved_at, resolved_by) VALUES ('equipment', ?, 1, 'Headset', '2025-01-01 00:00:00', ?, ?)");
  ins.run('open', null, null);
  ins.run('approved', '2025-01-02 00:00:00', null);
  ins.run('denied', '2025-01-03 00:00:00', null);
  ins.run('completed', '2025-01-04 00:00:00', null);
  ins.run('cancelled', '2025-01-05 00:00:00', null);   // closed by IT (or unknown): counts as handled
  ins.run('cancelled', '2025-01-06 00:00:00', 1);      // the employee's own login cancelled it: a rescind, never opened
  runMigrations(d, migrations);
  const got = d.prepare('SELECT status, resolved_by rb, opened_at FROM requests ORDER BY id').all().map((r) => [r.status, r.rb, r.opened_at]);
  assert.deepEqual(got, [
    ['open', null, null], ['approved', null, '2025-01-02 00:00:00'], ['denied', null, '2025-01-03 00:00:00'],
    ['completed', null, '2025-01-04 00:00:00'], ['cancelled', null, '2025-01-05 00:00:00'], ['cancelled', 1, null],
  ]);
  assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.deepEqual(runMigrations(d, migrations), [], 'idempotent');
});

test('front end: pill, detail and state filter share one vocabulary, and a raw database status is never shown', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('const LIFE_LABEL ='), src.indexOf('const requestIcon ='));
  const ctx = { pill: (cls, label) => ({ cls, label }) };
  vm.createContext(ctx);
  vm.runInContext(`${block}; this.api = { LIFE_LABEL, OPEN_STATES, CLOSED_STATES, ISSUE_ONLY_STATES, stateKey, statusLabel, reqPill };`, ctx);
  const { LIFE_LABEL, OPEN_STATES, CLOSED_STATES, ISSUE_ONLY_STATES, stateKey, statusLabel, reqPill } = ctx.api;
  const label = (type, lifecycle) => statusLabel({ type, lifecycle, status: 'RAW' });
  // exact mapping (type x lifecycle -> words)
  assert.deepEqual(
    ['equipment', 'return', 'issue'].map((ty) => ['submitted', 'in_review', 'approved', 'dropped_off', 'fulfilled', 'denied', 'rescinded', 'cancelled'].map((l) => label(ty, l))),
    [
      ['Submitted', 'In review', 'Approved', 'Dropped off', 'Fulfilled', 'Declined', 'Rescinded', 'Cancelled'],
      ['Return requested', 'Return requested', 'Approved', 'Dropped off', 'Fulfilled', 'Declined', 'Rescinded', 'Cancelled'],
      ['Submitted', 'In review', 'Approved', 'Dropped off', 'Resolved', 'Declined', 'Withdrawn', 'Dismissed'],
    ]);
  // the pill, the filter key and the filter option label agree for every closed state (live returns excepted: "Return requested")
  for (const ty of ['equipment', 'return', 'issue']) {
    for (const l of ['submitted', 'in_review', 'approved', 'dropped_off', 'fulfilled', 'denied', 'rescinded', 'cancelled']) {
      const r = { type: ty, lifecycle: l };
      assert.ok([...OPEN_STATES, ...CLOSED_STATES].includes(stateKey(r)), `${ty}/${l} has a filter state`);
      if (!(ty === 'return' && ['submitted', 'in_review'].includes(l))) assert.equal(statusLabel(r), LIFE_LABEL[stateKey(r)], `${ty}/${l}: pill = filter label`);
    }
  }
  assert.deepEqual([...ISSUE_ONLY_STATES], ['resolved', 'withdrawn', 'dismissed']);
  assert.ok(ISSUE_ONLY_STATES.every((k) => CLOSED_STATES.includes(k)));
  // a row with NO lifecycle (a server older than this front end) still reads in the same words, never "completed"/"cancelled"/"denied"
  const fallback = { open: 'Submitted', approved: 'Approved', dropped_off: 'Dropped off', completed: 'Fulfilled', denied: 'Declined', cancelled: 'Cancelled' };
  for (const [status, words] of Object.entries(fallback)) assert.equal(statusLabel({ type: 'equipment', status }), words, status);
  assert.equal(statusLabel({ type: 'issue', status: 'completed' }), 'Resolved');
  assert.equal(statusLabel({ type: 'issue', status: 'cancelled' }), 'Dismissed');
  assert.equal(reqPill({ type: 'equipment', status: 'completed' }).label, 'Fulfilled');
  // nothing in the pill path can print the status column
  assert.doesNotMatch(block, /r\.status\s*\)|\|\| r\.status/);
  // the filter and its counts both go through stateKey; the detail's pill is the same reqPill
  assert.match(src, /all\.filter\(\(r\) => stateKey\(r\) === k\)/);
  assert.match(src, /all\.filter\(\(r\) => stateKey\(r\) === state\.f\)/);
  assert.doesNotMatch(src, /pill\(r\.status/);
  assert.equal((src.match(/\$\{reqPill\(r\)\}/g) || []).length >= 4, true, 'cards, detail and Home lists all use reqPill');
  // the server still reports the underlying lifecycle: no new status or lifecycle value for issues
  assert.equal(requestRules.lifecycle(db, { status: 'completed', user_id: 1, resolved_by: null, opened_at: null, type: 'issue' }), 'fulfilled');
});
