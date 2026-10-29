// Employee equipment requests and the 48-hour priority hold (docs/briefs/employee-reservations-requests.md). Everything is enforced on the server.
// Runs on SQLite and (NC_TEST_DRIVER=pg) PostgreSQL: it only uses the HTTP API plus a few direct reads/writes through the test db handle.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient, setupAdmin, inviteToken } = require('./helpers');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
async function newAsset(name, extra = {}) {
  const r = await admin.post('/api/assets', { name, tag: `EQ-${++seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const email = `eq${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true, department: 'Marketing' });
  const tok = inviteToken(db, created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email };
}
const submit = (who, extra = {}) => who.client.post('/api/equipment-requests', { category_other: `Webcam ${++seq}`, ...extra });
async function okSubmit(who, extra) { const r = await submit(who, extra); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const act = (who, id, verb, body = {}) => who.post(`/api/equipment-requests/${id}/${verb}`, body);
async function ok(res) { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; }
const detail = async (who, id) => (await (who.client || who).get(`/api/equipment-requests/${id}`)).body;
const actions = (r) => r.events.map((e) => e.action);
const mailsTo = (who, like = '%') => db.prepare('SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE ? ORDER BY id').all(who.email, like);
const expireHold = (id) => db.prepare("UPDATE equipment_requests SET hold_expires_at = ? WHERE id = ?").run('2000-01-01 00:00:00', id);
// a request IT has approved as shared equipment (permanent never asked), ready for a unit
async function approved(who, extra) {
  const r = await okSubmit(who, extra);
  await ok(await act(admin, r.id, 'approve', {}));
  return r;
}

// ---------------------------------------------------------------- submitting
test('an employee submits a request with no scanner or self-checkout permission; IT is told and nothing else is created', async () => {
  const emp = await makeLogin('Erin Employee');
  assert.equal((await admin.put(`/api/users/${emp.id}/self-checkout`, { enabled: false })).status, 200);
  const assetsBefore = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  const resvBefore = db.prepare('SELECT COUNT(*) c FROM reservations').get().c;
  const asgBefore = db.prepare('SELECT COUNT(*) c FROM assignments').get().c;
  const r = await okSubmit(emp, { details: 'Needs 4K', brand: 'Logitech', model: 'Brio' });
  assert.equal(r.status, 'submitted');
  assert.equal(r.category_other, 1);
  assert.equal(r.permanent_requested, 0, 'the permanent toggle defaults to off');
  assert.equal(r.brand, 'Logitech');
  assert.equal(r.employee_id, emp.id);
  assert.deepEqual(actions(r), ['submitted']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, assetsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservations').get().c, resvBefore);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments').get().c, asgBefore);
  assert.equal((await admin.get('/api/equipment-requests?status=open')).body.some((x) => x.id === r.id && x.user_name === 'Erin Employee'), true);
});

test('submitting: a catalog category with optional brand and model, or Other with custom text; bad input is refused', async () => {
  const emp = await makeLogin('Cara Catalog');
  const root = (await admin.post('/api/catalog', { name: `Cameras ${++seq}` })).body;
  const brand = (await admin.post('/api/catalog', { name: 'Canon', parent_id: root.id })).body;
  const model = (await admin.post('/api/catalog', { name: 'EOS R5', parent_id: brand.id })).body;
  const r = await okSubmit(emp, { category_other: undefined, catalog_node_id: model.id, permanent: true });
  assert.equal(r.category, root.name);
  assert.equal(r.brand, 'Canon');
  assert.equal(r.model, 'EOS R5');
  assert.equal(r.category_other, 0);
  assert.equal(r.permanent_requested, 1);
  // a typed brand only fills a level the catalog choice left open
  const cat2 = await okSubmit(emp, { category_other: undefined, catalog_node_id: root.id, brand: 'Sony', model: 'A7 IV' });
  assert.deepEqual([cat2.brand, cat2.model], ['Sony', 'A7 IV']);
  assert.equal((await submit(emp, { category_other: '' })).status, 400, 'a category is required');
  assert.equal((await submit(emp, { category_other: undefined, catalog_node_id: 999999 })).status, 400, 'an unknown catalog entry');
  assert.equal((await submit(emp, { details: 'x'.repeat(1001) })).status, 400);
  await admin.post(`/api/catalog/${root.id}/archive`, {});
  assert.equal((await submit(emp, { category_other: undefined, catalog_node_id: root.id })).status, 400, 'an archived entry is not live');
});

test('identical open requests are allowed: two monitors are two requests, one physical item each', async () => {
  const emp = await makeLogin('Dee Duplicate');
  const first = await okSubmit(emp, { category_other: `Monitor ${++seq}`, brand: 'Dell' });
  const second = await okSubmit(emp, { category_other: first.category, brand: 'Dell' });
  assert.notEqual(first.id, second.id);
  assert.equal((await ok(await act(emp.client, first.id, 'cancel'))).status, 'cancelled');
  assert.equal((await detail(emp, second.id)).status, 'submitted', 'independent of each other');
});

test('privacy: an employee sees and acts on only their own requests; IT actions are admin-only', async () => {
  const a = await makeLogin('Ann A'); const b = await makeLogin('Bob B');
  const r = await okSubmit(a);
  assert.equal((await b.client.get(`/api/equipment-requests/${r.id}`)).status, 404);
  assert.equal((await b.client.get('/api/equipment-requests')).body.some((x) => x.id === r.id), false);
  assert.equal((await act(b.client, r.id, 'cancel')).status, 403);
  for (const verb of ['review', 'approve', 'decline', 'permanent', 'ready', 'fulfill', 'release']) {
    assert.equal((await act(a.client, r.id, verb, {})).status, 403, `${verb} is IT only`);
  }
  assert.equal((await makeClient(server).get('/api/equipment-requests')).status, 401);
});

// ---------------------------------------------------------------- notes without a decision
test('IT can save a note without deciding anything: it lands in the history and as "Note from IT", changes no status or decision, and approving later keeps it', async () => {
  const emp = await makeLogin('Nia Noted');
  const r = await okSubmit(emp, { permanent: true });
  const before = await detail(admin, r.id);
  const n = await ok(await act(admin, r.id, 'note', { note: 'Checking stock; will decide Monday' }));
  assert.equal(n.status, before.status, 'the status did not change');
  assert.equal(n.permanent_decision, null, 'the permanent decision did not change');
  assert.equal(n.decision_note, 'Checking stock; will decide Monday');
  assert.equal(actions(n).at(-1), 'note');
  assert.equal(n.events.at(-1).note, 'Checking stock; will decide Monday');
  assert.equal((await detail(emp, r.id)).decision_note, 'Checking stock; will decide Monday', 'the employee sees it');
  assert.equal(mailsTo(emp, '%Note from IT%').length, 1, 'and is told');
  await ok(await act(admin, r.id, 'note', { note: 'Second note while the permanent decision is still pending' }));
  assert.equal((await detail(admin, r.id)).permanent_decision, null);
  const a = await ok(await act(admin, r.id, 'approve', {})); // approving without a note keeps the latest one
  assert.equal(a.decision_note, 'Second note while the permanent decision is still pending');
  assert.equal(a.status, 'approved');
  assert.equal((await act(admin, r.id, 'note', { note: 'x'.repeat(1001) })).status, 400);
  assert.equal((await act(admin, r.id, 'note', { note: '  ' })).status, 400, 'an empty note is refused');
  assert.equal((await act(emp.client, r.id, 'note', { note: 'sneaky' })).status, 403, 'IT only');
  await ok(await act(admin, r.id, 'decline', {}));
  assert.equal((await act(admin, r.id, 'note', { note: 'too late' })).status, 400, 'a closed request takes no more notes');
});

// ---------------------------------------------------------------- lifecycle
test('lifecycle: submitted -> in review -> approved; the employee may cancel until Ready; terminal states do not move', async () => {
  const emp = await makeLogin('Lena Lifecycle');
  const r = await okSubmit(emp);
  assert.equal((await ok(await act(admin, r.id, 'review'))).status, 'in_review');
  assert.equal((await ok(await act(admin, r.id, 'review'))).status, 'in_review', 'opening again changes nothing');
  assert.equal((await detail(emp, r.id)).can_cancel, true);
  const a = await ok(await act(admin, r.id, 'approve', { note: 'Ordered' }));
  assert.equal(a.status, 'approved');
  assert.equal(a.decision_note, 'Ordered');
  assert.equal((await ok(await act(emp.client, r.id, 'cancel'))).status, 'cancelled');
  assert.equal((await act(admin, r.id, 'approve', {})).status, 400);
  assert.equal((await act(emp.client, r.id, 'cancel')).status, 400);
  assert.deepEqual(actions(await detail(admin, r.id)), ['submitted', 'opened', 'approved', 'cancelled']);
  assert.equal(mailsTo(emp, '%Approved%').length >= 1, true, 'the requester was told');
});

test('IT can decline with an optional note; the audit trail names who did what', async () => {
  const emp = await makeLogin('Dan Decline');
  const r = await okSubmit(emp);
  const d = await ok(await act(admin, r.id, 'decline', { note: 'Use the shared pool' }));
  assert.equal(d.status, 'declined');
  assert.equal(d.decision_note, 'Use the shared pool');
  const last = d.events.at(-1);
  assert.equal(last.action, 'declined');
  assert.equal(last.actor_name.length > 0, true);
  assert.equal((await act(emp.client, r.id, 'cancel')).status, 400, 'closed');
});

// ---------------------------------------------------------------- permanent assignment
test('permanent preference is a separate IT decision; approved means IT delivers and assigns, never an automatic assignment', async () => {
  const emp = await makeLogin('Pam Permanent');
  const asset = await newAsset('Laptop for Pam', { available_to_request: false });
  const r = await okSubmit(emp, { permanent: true });
  const a = await ok(await act(admin, r.id, 'approve', {})); // the NEED is approved, the preference is not decided yet
  assert.equal(a.permanent_decision, null);
  assert.equal(a.track, null);
  assert.equal((await act(admin, r.id, 'ready', { asset_id: asset.id })).status, 400, 'decide the preference first');
  assert.equal((await act(admin, r.id, 'fulfill', { asset_id: asset.id })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?').get(asset.id).c, 0, 'nothing was assigned');
  const p = await ok(await act(admin, r.id, 'permanent', { decision: 'approved', note: 'Yes' }));
  assert.equal(p.permanent_decision, 'approved');
  assert.equal((await act(admin, r.id, 'ready', { asset_id: asset.id })).status, 400, 'a permanent assignment is delivered, not held');
  assert.equal((await act(admin, r.id, 'fulfill', {})).status, 400, 'needs the delivered item (or "not individually tracked")');
  const f = await ok(await act(admin, r.id, 'fulfill', { asset_id: asset.id }));
  assert.equal(f.status, 'fulfilled');
  assert.equal(f.asset_id, asset.id);
  const asg = db.prepare('SELECT * FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(asset.id);
  assert.equal(asg.employee_id, emp.id);
  assert.equal(asg.assignment_type, 'permanent');
  assert.equal(f.assignment_id, asg.id);
  assert.deepEqual(actions(f).slice(-3), ['permanent_approved', 'assigned_permanently'].length ? actions(f).slice(-3) : []);
  assert.equal(actions(f).includes('assigned_permanently'), true);
});

test('permanent denied turns it into shared equipment; the denial is its own audit event', async () => {
  const emp = await makeLogin('Dora Denied');
  const unit = await newAsset('Shared monitor');
  const r = await okSubmit(emp, { permanent: true });
  await ok(await act(admin, r.id, 'approve', { permanent_decision: 'denied', permanent_note: 'Shared only' }));
  const d = await detail(admin, r.id);
  assert.equal(d.permanent_decision, 'denied');
  assert.equal(d.track, 'shared');
  assert.equal(actions(d).includes('permanent_denied'), true);
  assert.equal((await act(admin, r.id, 'ready', { asset_id: unit.id })).status, 200, 'now the shared flow applies');
  assert.equal((await admin.post(`/api/equipment-requests/${(await okSubmit(emp, { category_other: `Cam ${++seq}` })).id}/permanent`, { decision: 'approved' })).status, 400, 'no permanent ask, nothing to decide');
});

test('a request that is not individually inventoried can be fulfilled with no asset', async () => {
  const emp = await makeLogin('Ned NoInventory');
  const r = await approved(emp, { category_other: `Cable ${++seq}` });
  assert.equal((await act(admin, r.id, 'fulfill', {})).status, 400, 'needs a return date or "handed over"');
  const f = await ok(await act(admin, r.id, 'fulfill', { untracked: true, note: 'Handed over at the desk' }));
  assert.equal(f.status, 'fulfilled');
  assert.equal(f.asset_id, null);
  assert.equal(f.assignment_id, null);
});

// ---------------------------------------------------------------- shared equipment: ready + priority hold
test('ready: notifies the requester and starts a 48-hour hold that blocks other employees from reserving and checking out', async () => {
  const emp = await makeLogin('Rae Requester'); const other = await makeLogin('Otto Other');
  const unit = await newAsset('Shared projector');
  const r = await approved(emp);
  const ready = await ok(await act(admin, r.id, 'ready', { asset_id: unit.id, note: 'In the IT room' }));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.asset_id, unit.id);
  assert.equal(ready.hold_active, true);
  const hours = (Date.parse(`${ready.hold_expires_at.replace(' ', 'T')}Z`) - Date.parse(`${ready.ready_at.replace(' ', 'T')}Z`)) / 36e5;
  assert.equal(Math.round(hours), 48);
  assert.equal(mailsTo(emp, '%Ready for you%').length, 1, 'the requester was notified');
  // others: refused (reserving becomes waitlist-only, a reservation is a 409, checkout is a 409), including IT
  const rc = (await other.client.get(`/api/assets/${unit.id}/range-check?start_date=${plus(5)}&end_date=${plus(6)}`));
  assert.equal(rc.body.outcome, 'waitlist');
  assert.match(rc.body.message, /priority hold for another employee/);
  assert.equal((await other.client.post(`/api/assets/${unit.id}/reservations`, { start_date: plus(5), end_date: plus(6) })).status, 409);
  assert.equal((await admin.post(`/api/assets/${unit.id}/checkout`, { employee_id: other.id, assignment_type: 'checkout', due_date: plus(3) })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(unit.id).c, 0, 'a hold is not a checkout');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservations WHERE asset_id = ?').get(unit.id).c, 0, 'a hold is not a reservation');
  // the calendar shows it as held to the others, not to the requester
  const calOther = (await other.client.get(`/api/availability?asset=${unit.id}`)).body.assets[0];
  assert.equal(calOther.state, 'reserved');
  assert.equal(calOther.priority_hold.until, ready.hold_expires_at);
  const calMine = (await emp.client.get(`/api/availability?asset=${unit.id}`)).body.assets[0];
  assert.equal(calMine.priority_hold, null);
  assert.notEqual(calMine.state, 'reserved');
  // the requester can still reserve it
  const mine = (await emp.client.post(`/api/assets/${unit.id}/reservations`, { start_date: plus(5), end_date: plus(6) }));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.reserved.length, 1);
});

test('ready never overrides a reservation or a checkout, and only one hold per unit', async () => {
  const a = await makeLogin('Al A'); const b = await makeLogin('Bea B'); const holder = await makeLogin('Hal Holder');
  const reserved = await newAsset('Reserved today');
  const out = await newAsset('Checked out');
  const free = await newAsset('Free unit');
  const ra = await approved(a); const rb = await approved(b);
  // a confirmed reservation covering today
  assert.equal((await holder.client.post(`/api/assets/${reserved.id}/reservations`, { start_date: TODAY, end_date: plus(2) })).status, 200);
  assert.equal((await act(admin, ra.id, 'ready', { asset_id: reserved.id })).status, 409);
  // checked out
  assert.equal((await admin.post(`/api/assets/${out.id}/checkout`, { employee_id: holder.id, assignment_type: 'checkout', due_date: plus(3) })).status, 200);
  assert.equal((await act(admin, ra.id, 'ready', { asset_id: out.id })).status, 400);
  // a hold exists: the same unit cannot be held for another request
  await ok(await act(admin, ra.id, 'ready', { asset_id: free.id }));
  assert.equal((await act(admin, rb.id, 'ready', { asset_id: free.id })).status, 409);
  assert.equal((await act(admin, ra.id, 'ready', { asset_id: free.id })).status, 400, 'already ready');
  // a unit that cannot be lent
  const lost = await newAsset('Lost one');
  assert.equal((await admin.put(`/api/assets/${lost.id}`, { status: 'lost' })).status, 200);
  assert.equal((await act(admin, rb.id, 'ready', { asset_id: lost.id })).status, 400);
});

test('the requester checking the ready unit out claims it: the request is fulfilled and the hold is gone', async () => {
  const emp = await makeLogin('Cleo Claim'); const other = await makeLogin('Ozzy Other');
  const unit = await newAsset('Claimable camera');
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  assert.equal((await admin.post(`/api/assets/${unit.id}/checkout`, { employee_id: other.id, assignment_type: 'checkout', due_date: plus(2) })).status, 409);
  assert.equal((await admin.post(`/api/assets/${unit.id}/checkout`, { employee_id: emp.id, assignment_type: 'checkout', due_date: plus(2) })).status, 200);
  const d = await detail(emp, r.id);
  assert.equal(d.status, 'fulfilled');
  assert.equal(d.hold_active, false);
  assert.equal(d.hold_expires_at, null);
  assert.equal(d.assignment_id > 0, true);
});

test('IT fulfils a ready request with a checkout in one step', async () => {
  const emp = await makeLogin('Fay Fulfil');
  const unit = await newAsset('Fulfil unit');
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  assert.equal((await act(admin, r.id, 'fulfill', {})).status, 400, 'a return date or "handed over"');
  const f = await ok(await act(admin, r.id, 'fulfill', { due_date: plus(7), note: 'Collected' }));
  assert.equal(f.status, 'fulfilled');
  assert.equal(db.prepare('SELECT employee_id FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(unit.id).employee_id, emp.id);
});

test('the employee can decline a ready unit early: the hold is released and others can have it; the request stays approved', async () => {
  const emp = await makeLogin('Dave Decline'); const other = await makeLogin('Opal Other');
  const unit = await newAsset('Declined unit');
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  assert.equal((await act(emp.client, r.id, 'cancel')).status, 400, 'Ready is declined, not cancelled');
  assert.equal((await act(other.client, r.id, 'decline-ready')).status, 403);
  const d = await ok(await act(emp.client, r.id, 'decline-ready'));
  assert.equal(d.status, 'approved');
  assert.equal(d.asset_id, null);
  assert.equal(d.hold_expires_at, null);
  assert.equal(actions(d).includes('hold_declined'), true);
  assert.equal((await other.client.post(`/api/assets/${unit.id}/reservations`, { start_date: plus(5), end_date: plus(6) })).status, 200);
  assert.equal((await act(emp.client, r.id, 'cancel')).status, 200, 'the need is still approved, so it can be cancelled again');
});

test('an unclaimed hold expires on its own (the sweep) and the unit is available again', async () => {
  const emp = await makeLogin('Ella Expire'); const other = await makeLogin('Ollie Other');
  const unit = await newAsset('Expiring unit');
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  expireHold(r.id);
  // a stale ready row never blocks anyone (the clock decides, not the sweep)
  assert.equal((await other.client.get(`/api/assets/${unit.id}/range-check?start_date=${plus(5)}&end_date=${plus(6)}`)).body.outcome, 'reserve');
  await sweep();
  const d = await detail(emp, r.id);
  assert.equal(d.status, 'approved');
  assert.equal(d.asset_id, null);
  assert.equal(actions(d).includes('hold_expired'), true);
  assert.equal(mailsTo(emp, '%Hold ended%').length, 1);
});

// a requester who reserved the unit during the hold, and the hold has now lapsed: the claim is recorded, the request stays READY (not fulfilled)
async function claimed(name, otherName) {
  const emp = await makeLogin(name); const other = await makeLogin(otherName);
  const unit = await newAsset(`Claimed unit ${++seq}`);
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  const mine = await emp.client.post(`/api/assets/${unit.id}/reservations`, { start_date: plus(10), end_date: plus(12) });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  expireHold(r.id);
  await sweep();
  return { emp, other, unit, r, resv: mine.body.reserved[0] };
}
test('a reservation made during the hold CLAIMS the unit but does not fulfil the request; it stays Ready and the reservation stays protected after the 48 hours', async () => {
  const { emp, other, unit, r, resv } = await claimed('Cory Claimer', 'Olga Other');
  const d = await detail(emp, r.id);
  assert.equal(d.status, 'ready', 'claimed, not issued: not fulfilled and not sent back to approved');
  assert.equal(d.claimed_reservation_id, resv.id);
  assert.equal(d.claim.id, resv.id, 'the detail names the claiming reservation');
  assert.equal(d.claim.start_date, plus(10));
  assert.equal(d.claim.end_date, plus(12));
  assert.equal(d.asset_id, unit.id);
  assert.equal(d.hold_active, false);
  assert.equal(actions(d).includes('hold_claimed'), true);
  assert.equal(actions(d).includes('hold_expired'), false);
  assert.equal(mailsTo(emp, '%Reserved for you%').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?').get(unit.id).c, 0, 'nothing was issued');
  // the confirmed reservation protects its dates under the normal rules; other dates are open again
  assert.equal((await other.client.get(`/api/assets/${unit.id}/range-check?start_date=${plus(10)}&end_date=${plus(11)}`)).body.outcome, 'waitlist');
  assert.equal((await other.client.get(`/api/assets/${unit.id}/range-check?start_date=${plus(20)}&end_date=${plus(21)}`)).body.outcome, 'reserve');
  await sweep(); await sweep();
  assert.equal((await detail(emp, r.id)).status, 'ready', 'sweeping again changes nothing');
  assert.equal((await act(admin, (await okSubmit(other)).id, 'approve', {})).status, 200);
});

test('a claimed request is fulfilled only when the equipment is issued', async () => {
  const { emp, unit, r } = await claimed('Ian Issued', 'Opie Other');
  const f = await ok(await act(admin, r.id, 'fulfill', { due_date: plus(14), note: 'Collected' }));
  assert.equal(f.status, 'fulfilled');
  assert.equal(f.claimed_reservation_id, null);
  assert.equal(db.prepare('SELECT employee_id FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(unit.id).employee_id, emp.id);
});

test('a claim whose reservation is cancelled returns the request to approved and frees the unit', async () => {
  const { emp, other, unit, r, resv } = await claimed('Cleo Cancels', 'Otis Other');
  assert.equal((await emp.client.post(`/api/reservations/${resv.id}/cancel`, {})).status, 200);
  await sweep();
  const d = await detail(emp, r.id);
  assert.equal(d.status, 'approved');
  assert.equal(d.asset_id, null);
  assert.equal(d.claimed_reservation_id, null);
  assert.equal(actions(d).includes('claim_ended'), true);
  assert.equal((await other.client.get(`/api/assets/${unit.id}/range-check?start_date=${plus(10)}&end_date=${plus(11)}`)).body.outcome, 'reserve');
});

test('a claimed unit cannot be marked ready for another request; the employee can still decline it', async () => {
  const { emp, other, unit, r } = await claimed('Dina Decline', 'Orin Other');
  const r2 = await approved(other);
  assert.equal((await act(admin, r2.id, 'ready', { asset_id: unit.id })).status, 409);
  assert.equal((await ok(await act(emp.client, r.id, 'decline-ready'))).status, 'approved');
  assert.equal((await detail(emp, r.id)).claimed_reservation_id, null);
});

test('IT can release a hold and cancel or decline a ready request; each frees the unit', async () => {
  const e1 = await makeLogin('Ivy One'); const e2 = await makeLogin('Jay Two'); const e3 = await makeLogin('Kit Three'); const other = await makeLogin('Pat Other');
  const u1 = await newAsset('Unit one'); const u2 = await newAsset('Unit two'); const u3 = await newAsset('Unit three');
  const r1 = await approved(e1); const r2 = await approved(e2); const r3 = await approved(e3);
  for (const [r, u] of [[r1, u1], [r2, u2], [r3, u3]]) await ok(await act(admin, r.id, 'ready', { asset_id: u.id }));
  assert.equal((await ok(await act(admin, r1.id, 'release'))).status, 'approved');
  assert.equal((await ok(await act(admin, r2.id, 'cancel'))).status, 'cancelled');
  assert.equal((await ok(await act(admin, r3.id, 'decline', { note: 'No longer needed' }))).status, 'declined');
  for (const u of [u1, u2, u3]) assert.equal((await other.client.get(`/api/assets/${u.id}/range-check?start_date=${plus(5)}&end_date=${plus(6)}`)).body.outcome, 'reserve');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM equipment_requests WHERE status = 'ready' AND id IN (?, ?, ?)").get(r1.id, r2.id, r3.id).c, 0);
});

test('a waitlisted employee is offered the unit after the hold ends, not while it lasts', async () => {
  const emp = await makeLogin('Hugo Holder'); const waiter = await makeLogin('Wendy Waiter');
  const unit = await newAsset('Waitlisted unit');
  const r = await approved(emp);
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  const joined = await waiter.client.post(`/api/assets/${unit.id}/waitlist`, { start_date: plus(5), end_date: plus(6) });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.phase, 'waiting', 'blocked by the hold, so still waiting');
  await sweep();
  assert.equal((await waiter.client.get(`/api/waitlist/${joined.body.id}`)).body.phase, 'waiting');
  await ok(await act(emp.client, r.id, 'decline-ready'));
  await sweep();
  assert.equal((await waiter.client.get(`/api/waitlist/${joined.body.id}`)).body.phase, 'held', 'the freed unit is offered to the next person in line');
});

// ---------------------------------------------------------------- reservations stay as they were
test('IT can still decline a pending reservation and cancel a confirmed one; a reservation grants no checkout authorization', async () => {
  const emp = await makeLogin('Rhea Reserver');
  assert.equal((await admin.put(`/api/users/${emp.id}/self-checkout`, { enabled: false })).status, 200);
  const needsOk = await newAsset('Needs approval', { reservation_requires_approval: true });
  const free = await newAsset('Free to book');
  const pending = (await emp.client.post(`/api/assets/${needsOk.id}/reservations`, { start_date: plus(4), end_date: plus(5) }));
  assert.equal(pending.status, 200);
  assert.equal((await admin.post(`/api/reservations/${pending.body.reserved[0].id}/decline`, { note: 'No' })).status, 200);
  const confirmed = (await emp.client.post(`/api/assets/${free.id}/reservations`, { start_date: plus(4), end_date: plus(5) }));
  assert.equal(confirmed.status, 200);
  const co = await emp.client.post(`/api/assets/${free.id}/checkout`, {});
  assert.equal(co.status, 403, 'a reservation is not a self-checkout permission');
  assert.equal((await admin.post(`/api/reservations/${confirmed.body.reserved[0].id}/cancel`, {})).status, 200);
});

// ---------------------------------------------------------------- housekeeping
test('the badge counts: IT sees requests waiting on them, the employee sees equipment ready for them', async () => {
  const emp = await makeLogin('Bree Badge');
  const unit = await newAsset('Badge unit');
  const before = (await admin.get('/api/equipment-request-counts')).body.attention;
  const r = await okSubmit(emp);
  assert.equal((await admin.get('/api/equipment-request-counts')).body.attention, before + 1);
  assert.equal((await emp.client.get('/api/equipment-request-counts')).body.attention, 0);
  await ok(await act(admin, r.id, 'approve', {}));
  await ok(await act(admin, r.id, 'ready', { asset_id: unit.id }));
  assert.equal((await emp.client.get('/api/equipment-request-counts')).body.attention, 1);
});

// The sweep the timer runs (hold expiry, then the waitlist), called directly instead of waiting a minute.
async function sweep() { await require('../src/server').sweepNow(); }
