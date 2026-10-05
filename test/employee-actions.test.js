// Employee Actions V1 (Phase 2, slice 2): request equipment, request return, report an issue, rescind. Every rule here is
// enforced on the server — the UI only reflects `can_cancel` / `self_initiated`, it never decides.
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
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { available_to_request: true, name, tag: `EV-${++seq}`, category: 'Laptop', ...extra })).body;
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `ev${++seq}@nutricost.com`, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name };
}
const give = async (asset, who, extra = {}) => { const r = await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); };
const holds = (asset, who) => count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL', asset.id, who.id) === 1;
const returnRequest = (asset, who, message) => who.client.post(`/api/assets/${asset.id}/my-return-request`, { message });
const reportIssue = (asset, who, message) => who.client.post(`/api/assets/${asset.id}/report-issue`, { message });
const myRequests = async (who, q = '') => (await who.client.get('/api/requests' + q)).body;

// ---------------------------------------------------------------- request equipment (generic flow preserved)
test('an employee submits an equipment request for themselves and sees it with type, status, date and message', async () => {
  const me = await makeLogin('Req Maker');
  const made = await me.client.post('/api/requests', { category: 'Monitor', message: 'Second screen please' });
  assert.equal(made.status, 200);
  assert.equal(made.body.type, 'equipment');
  assert.equal(made.body.status, 'open');
  assert.equal(made.body.user_id, me.id);
  const seen = (await myRequests(me)).find((r) => r.id === made.body.id);
  assert.equal(seen.category, 'Monitor');
  assert.equal(seen.message, 'Second screen please');
  assert.ok(seen.created_at);
  assert.equal(seen.can_cancel, true, 'an untouched open request can be rescinded');
});

test('an employee cannot file a request on someone else\'s behalf, however the body is shaped', async () => {
  const me = await makeLogin('Spoofer');
  const other = await makeLogin('Spoofed');
  const made = await me.client.post('/api/requests', { category: 'Mouse', user_id: other.id });
  assert.equal(made.status, 200);
  assert.equal(made.body.user_id, me.id, 'user_id from an employee is ignored');
  assert.equal(count('SELECT COUNT(*) c FROM requests WHERE user_id = ?', other.id), 0);
});

test('an employee sees only their own requests and cannot cancel, resolve or drop off someone else\'s', async () => {
  const a = await makeLogin('Owner A');
  const b = await makeLogin('Intruder B');
  const asset = await newAsset('A laptop');
  await give(asset, a);
  const eq = (await a.client.post('/api/requests', { category: 'Dock' })).body;
  const ret = (await returnRequest(asset, a)).body;
  const iss = (await reportIssue(asset, a, 'Screen flickers')).body;

  const bSees = await myRequests(b);
  assert.deepEqual(bSees.filter((r) => [eq.id, ret.id, iss.id].includes(r.id)), [], 'B sees none of A\'s requests');
  assert.ok((await myRequests(a)).filter((r) => [eq.id, ret.id, iss.id].includes(r.id)).length === 3);

  for (const id of [eq.id, ret.id, iss.id]) {
    assert.equal((await b.client.post(`/api/requests/${id}/cancel`, {})).status, 403);
    assert.equal(row(id).status, 'open', 'and nothing changed');
  }
  assert.equal((await b.client.post(`/api/requests/${ret.id}/dropped-off`, {})).status, 403);
  assert.equal((await b.client.post(`/api/requests/${iss.id}/resolve`, {})).status, 403);
});

// ---------------------------------------------------------------- request return
test('an employee can request return of their own assigned asset; the assignment is NOT ended', async () => {
  const me = await makeLogin('Returner');
  const asset = await newAsset('Return me');
  await give(asset, me);
  const r = await returnRequest(asset, me, 'Upgrading soon');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.type, 'return');
  assert.equal(r.body.status, 'open');
  assert.equal(r.body.asset_id, asset.id);
  assert.equal(r.body.user_id, me.id);
  assert.equal(holds(asset, me), true, 'still assigned until IT checks it in');
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(asset.id).status, 'checked_out');
  const listed = (await myRequests(me)).find((x) => x.id === r.body.id);
  assert.equal(listed.self_initiated, 1, 'flagged as the employee\'s own ask, so the UI does not say "IT asked you"');
  assert.equal(listed.can_cancel, true);
  assert.equal(listed.asset_tag, asset.tag);
  const dash = (await me.client.get('/api/dashboard')).body.mine.find((m) => m.asset_id === asset.id);
  assert.equal(dash.return_status, 'open');
  assert.equal(dash.return_self, 1);
});

test('the normal next steps still work after a self-initiated return request: dropped off, then IT checks in', async () => {
  const me = await makeLogin('Full Cycle');
  const asset = await newAsset('Cycle laptop');
  await give(asset, me);
  const r = (await returnRequest(asset, me)).body;
  assert.equal((await me.client.post(`/api/requests/${r.id}/dropped-off`, {})).status, 200);
  assert.equal(row(r.id).status, 'dropped_off');
  assert.equal(holds(asset, me), true, 'dropped off is a claim, not a check-in');
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkin`, {})).status, 200);
  assert.equal(row(r.id).status, 'completed');
  assert.equal(holds(asset, me), false);
});

test('an employee cannot request return of an asset they do not hold: unassigned, someone else\'s, unknown, or via the admin route', async () => {
  const me = await makeLogin('Not The Holder');
  const holder = await makeLogin('The Holder');
  const free = await newAsset('Free laptop');
  const theirs = await newAsset('Their laptop');
  await give(theirs, holder);
  assert.equal((await returnRequest(free, me)).status, 400, 'available but not mine');
  assert.equal((await returnRequest(theirs, me)).status, 404, 'held by another: indistinguishable from not found');
  assert.equal((await me.client.post('/api/assets/999999/my-return-request', {})).status, 404);
  assert.equal((await me.client.post(`/api/assets/${theirs.id}/request-return`, { employee_id: holder.id })).status, 403, 'the IT-only route stays IT-only');
  assert.equal((await returnRequest(free, { client: makeClient(server) })).status, 401);
  assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'return' AND asset_id IN (?, ?)", free.id, theirs.id), 0);
});

test('conflicting return requests are refused: a second tap, IT already asked, or already dropped off', async () => {
  const me = await makeLogin('Dup Returner');
  const a1 = await newAsset('Dup one');
  const a2 = await newAsset('Dup two');
  const a3 = await newAsset('Dup three');
  for (const a of [a1, a2, a3]) await give(a, me);

  assert.equal((await returnRequest(a1, me)).status, 200);
  const again = await returnRequest(a1, me);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already been requested/);

  assert.equal((await admin.post(`/api/assets/${a2.id}/request-return`, { employee_id: me.id })).status, 200);
  assert.equal((await returnRequest(a2, me)).status, 400, 'IT already asked for this one');

  assert.equal((await me.client.post(`/api/assets/${a3.id}/return-notice`, {})).status, 200);
  const afterDrop = await returnRequest(a3, me);
  assert.equal(afterDrop.status, 400);
  assert.match(afterDrop.body.error, /already told IT/);

  for (const a of [a1, a2, a3]) assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'return' AND asset_id = ? AND status IN ('open','dropped_off')", a.id), 1, 'exactly one live return per asset');
  // and IT asking after the employee already did is the existing "already requested" refusal, not a second row
  assert.equal((await admin.post(`/api/assets/${a1.id}/request-return`, { employee_id: me.id })).status, 400);
});

test('a returned asset can be requested again later, and a closed return request does not block it', async () => {
  const me = await makeLogin('Round Trip');
  const asset = await newAsset('Round trip laptop');
  await give(asset, me);
  const first = (await returnRequest(asset, me)).body;
  assert.equal((await me.client.post(`/api/requests/${first.id}/cancel`, {})).status, 200);
  assert.equal((await returnRequest(asset, me)).status, 200, 'a cancelled return request frees the slot');
});

// ---------------------------------------------------------------- report issue
test('an employee reports an issue for their own asset; IT sees the issue, the asset and who reported it', async () => {
  const me = await makeLogin('Reporter');
  const asset = await newAsset('Flaky laptop', { category: 'Laptop' });
  await give(asset, me);
  const made = await reportIssue(asset, me, '  Keyboard types double letters  ');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.type, 'issue');
  assert.equal(made.body.status, 'open');
  assert.equal(made.body.asset_id, asset.id);
  assert.equal(made.body.user_id, me.id);
  assert.equal(made.body.message, 'Keyboard types double letters', 'trimmed');
  assert.equal(holds(asset, me), true, 'reporting an issue changes nothing about the assignment');

  const mine = (await myRequests(me, '?type=issue')).find((r) => r.id === made.body.id);
  assert.equal(mine.asset_name, 'Flaky laptop');
  assert.equal(mine.asset_tag, asset.tag);
  assert.equal(mine.can_cancel, true);
  assert.equal((await me.client.get('/api/dashboard')).body.mine.find((m) => m.asset_id === asset.id).open_issues, 1);

  const seenByIt = (await admin.get('/api/requests?type=issue&status=open')).body.find((r) => r.id === made.body.id);
  assert.equal(seenByIt.user_name, 'Reporter');
  assert.equal(seenByIt.asset_name, 'Flaky laptop');
  assert.equal(seenByIt.asset_tag, asset.tag);
  assert.equal(seenByIt.message, 'Keyboard types double letters');
  const dash = (await admin.get('/api/dashboard')).body;
  assert.ok(dash.openRequests.some((r) => r.id === made.body.id && r.type === 'issue'), 'issues land in the same needs-attention queue');
  assert.ok(dash.stats.open_requests >= 1);
  const detail = (await admin.get(`/api/assets/${asset.id}`)).body;
  assert.ok(detail.requests.some((r) => r.id === made.body.id), 'and on the asset page');
  assert.ok(detail.activity.some((a) => a.action === 'issue_reported' && /double letters/.test(a.details)));
});

test('an employee cannot report an issue for an unassigned, another employee\'s, unknown or already-returned asset', async () => {
  const me = await makeLogin('Bad Reporter');
  const holder = await makeLogin('Real Holder');
  const free = await newAsset('Unassigned thing');
  const theirs = await newAsset('Someone else\'s thing');
  await give(theirs, holder);
  assert.equal((await reportIssue(free, me, 'broken')).status, 400);
  assert.equal((await reportIssue(theirs, me, 'broken')).status, 404, 'invisible to me, so not found');
  assert.equal((await me.client.post('/api/assets/999999/report-issue', { message: 'x' })).status, 404);
  assert.equal((await reportIssue(free, { client: makeClient(server) }, 'x')).status, 401);
  assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'issue' AND asset_id IN (?, ?)", free.id, theirs.id), 0);
  // an asset you held and returned is no longer yours to report on
  const returned = await newAsset('Returned thing');
  await give(returned, me);
  assert.equal((await admin.post(`/api/assets/${returned.id}/checkin`, {})).status, 200);
  assert.equal((await reportIssue(returned, me, 'it was cracked')).status, 400);
});

test('an issue needs a real description: blank, whitespace, over-long and exact repeats are refused', async () => {
  const me = await makeLogin('Terse Reporter');
  const asset = await newAsset('Terse laptop');
  await give(asset, me);
  assert.equal((await reportIssue(asset, me, '')).status, 400);
  assert.equal((await reportIssue(asset, me, '   \n  ')).status, 400);
  assert.equal((await me.client.post(`/api/assets/${asset.id}/report-issue`, {})).status, 400);
  assert.equal((await reportIssue(asset, me, 'x'.repeat(1001))).status, 400);
  assert.equal((await reportIssue(asset, me, 'x'.repeat(1000))).status, 200);
  assert.equal((await reportIssue(asset, me, 'Battery drains fast')).status, 200);
  const repeat = await reportIssue(asset, me, 'Battery drains fast');
  assert.equal(repeat.status, 400, 'a double-submit does not create a second identical open issue');
  assert.equal((await reportIssue(asset, me, 'Battery swollen')).status, 200, 'a different problem is a new report');
  assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'issue' AND asset_id = ?", asset.id), 3);
});

test('an issue is an ordinary request to IT: cannot be approved or declined, only resolved or dismissed', async () => {
  const me = await makeLogin('Issue Lifecycle');
  const asset = await newAsset('Lifecycle laptop');
  await give(asset, me);
  const i1 = (await reportIssue(asset, me, 'Fan is loud')).body;
  assert.equal((await admin.post(`/api/requests/${i1.id}/approve`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${i1.id}/deny`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${i1.id}/dropped-off`, {})).status, 400);
  assert.equal(row(i1.id).status, 'open');

  const resolved = await admin.post(`/api/requests/${i1.id}/resolve`, { note: 'Cleaned the fan' });
  assert.equal(resolved.status, 200);
  const after = row(i1.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.resolution_note, 'Cleaned the fan');
  assert.ok(after.resolved_at && after.resolved_by);
  const closed = (await myRequests(me, '?status=closed')).find((r) => r.id === i1.id);
  assert.equal(closed.resolution_note, 'Cleaned the fan', 'the employee sees IT\'s note');
  assert.equal(closed.can_cancel, false);
  assert.equal((await admin.post(`/api/requests/${i1.id}/resolve`, {})).status, 400, 'resolving twice is refused');

  const i2 = (await reportIssue(asset, me, 'Hinge squeaks')).body;
  assert.equal((await admin.post(`/api/requests/${i2.id}/cancel`, {})).status, 200, 'IT can dismiss');
  assert.equal(row(i2.id).status, 'cancelled');
  const eq = (await me.client.post('/api/requests', { category: 'Mouse' })).body;
  assert.equal((await admin.post(`/api/requests/${eq.id}/resolve`, {})).status, 400, 'resolve is for issues only');
  assert.equal((await me.client.post(`/api/requests/${i2.id}/resolve`, {})).status, 403);
});

test('an issue survives the asset being checked in: it stays on the queue until IT resolves it', async () => {
  const me = await makeLogin('Issue After Return');
  const asset = await newAsset('Returned with issue');
  await give(asset, me);
  const iss = (await reportIssue(asset, me, 'Cracked corner')).body;
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkin`, {})).status, 200);
  assert.equal(row(iss.id).status, 'open', 'check-in completes the return request, never the issue');
  assert.ok((await admin.get('/api/requests?status=open&type=issue')).body.some((r) => r.id === iss.id));
});

// ---------------------------------------------------------------- rescind / cancel
test('rescind: an employee can cancel their own untouched equipment request, but not one IT has approved (it was opened)', async () => {
  const me = await makeLogin('Rescinder');
  const open = (await me.client.post('/api/requests', { category: 'Headset' })).body;
  assert.equal((await me.client.post(`/api/requests/${open.id}/cancel`, {})).status, 200);
  const cancelled = row(open.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.resolved_at, 'cancellation is recorded, not deleted');
  assert.equal(cancelled.resolved_by, db.prepare('SELECT id FROM accounts WHERE employee_id = ?').get(me.id).id);

  const approved = (await me.client.post('/api/requests', { category: 'Webcam' })).body;
  assert.equal((await admin.post(`/api/requests/${approved.id}/approve`, { note: 'ordering' })).status, 200);
  assert.equal(row(approved.id).status, 'approved');
  assert.equal((await myRequests(me)).find((r) => r.id === approved.id).can_cancel, false, 'approving opened it');
  const late = await me.client.post(`/api/requests/${approved.id}/cancel`, {});
  assert.equal(late.status, 400);
  assert.match(late.body.error, /already opened/);
  assert.equal(row(approved.id).status, 'approved');
});

test('rescind: completed, declined and already-cancelled requests can never be cancelled, and the assignment they produced stays', async () => {
  const me = await makeLogin('Late Rescinder');
  const asset = await newAsset('Fulfilled laptop');
  const done = (await me.client.post('/api/requests', { category: 'Laptop' })).body;
  assert.equal((await admin.post(`/api/requests/${done.id}/approve`, { asset_id: asset.id, assignment_type: 'checkout', due_date: '2999-01-01' })).status, 200);
  assert.equal(row(done.id).status, 'completed');
  const denied = (await me.client.post('/api/requests', { category: 'Chair' })).body;
  assert.equal((await admin.post(`/api/requests/${denied.id}/deny`, {})).status, 200);
  const gone = (await me.client.post('/api/requests', { category: 'Desk' })).body;
  assert.equal((await me.client.post(`/api/requests/${gone.id}/cancel`, {})).status, 200);

  for (const r of [done, denied, gone]) {
    const before = row(r.id);
    assert.equal((await me.client.post(`/api/requests/${r.id}/cancel`, {})).status, 400);
    assert.deepEqual(row(r.id), before, 'untouched');
    assert.equal((await myRequests(me, '?status=closed')).find((x) => x.id === r.id).can_cancel, false);
  }
  assert.equal(holds(asset, me), true, 'cancelling a fulfilled request never undoes the assignment');
});

test('rescind: an approved permanent request that produced an assignment cannot be cancelled by the employee or by IT', async () => {
  const me = await makeLogin('Permanent Rescinder');
  const asset = await newAsset('Permanent laptop');
  const perm = (await me.client.post('/api/requests', { asset_id: asset.id, category: 'Laptop', requested_assignment_type: 'permanent' })).body;
  assert.equal((await myRequests(me)).find((r) => r.id === perm.id).can_cancel, true, 'still rescindable while only open');
  assert.equal((await admin.post(`/api/requests/${perm.id}/approve`, {})).status, 200);
  assert.equal(row(perm.id).status, 'completed');
  assert.equal((await me.client.post(`/api/requests/${perm.id}/cancel`, {})).status, 400);
  assert.equal((await admin.post(`/api/requests/${perm.id}/cancel`, {})).status, 400);
  assert.equal(holds(asset, me), true);
});

test('rescind: a self-initiated return request can be withdrawn while open — but not once dropped off, and never IT\'s own request', async () => {
  const me = await makeLogin('Return Rescinder');
  const a1 = await newAsset('Change of heart');
  const a2 = await newAsset('Already dropped');
  const a3 = await newAsset('IT asked');
  for (const a of [a1, a2, a3]) await give(a, me);

  const mine = (await returnRequest(a1, me)).body;
  assert.equal((await me.client.post(`/api/requests/${mine.id}/cancel`, {})).status, 200);
  assert.equal(row(mine.id).status, 'cancelled');
  assert.equal(holds(a1, me), true, 'withdrawing the request leaves the assignment alone');

  const dropped = (await returnRequest(a2, me)).body;
  await me.client.post(`/api/requests/${dropped.id}/dropped-off`, {});
  assert.equal((await myRequests(me)).find((r) => r.id === dropped.id).can_cancel, false);
  assert.equal((await me.client.post(`/api/requests/${dropped.id}/cancel`, {})).status, 400);
  assert.equal(row(dropped.id).status, 'dropped_off');
  assert.equal((await me.client.post(`/api/assets/${a2.id}/return-notice`, {})).status, 200, 'the existing flow for a dropped-off asset is unchanged');

  await admin.post(`/api/assets/${a3.id}/request-return`, { employee_id: me.id });
  const itAsked = db.prepare("SELECT * FROM requests WHERE type = 'return' AND asset_id = ?").get(a3.id);
  const listed = (await myRequests(me)).find((r) => r.id === itAsked.id);
  assert.equal(listed.self_initiated, 0);
  assert.equal(listed.can_cancel, false, 'the employee answers IT\'s request by dropping it off, not by cancelling it');
  assert.equal((await me.client.post(`/api/requests/${itAsked.id}/cancel`, {})).status, 403);
  assert.equal(row(itAsked.id).status, 'open');
});

test('rescind: an employee can withdraw their own open issue, not a resolved one', async () => {
  const me = await makeLogin('Issue Rescinder');
  const asset = await newAsset('Withdrawn issue laptop');
  await give(asset, me);
  const i1 = (await reportIssue(asset, me, 'Might be the cable')).body;
  assert.equal((await me.client.post(`/api/requests/${i1.id}/cancel`, {})).status, 200);
  assert.equal(row(i1.id).status, 'cancelled');
  const i2 = (await reportIssue(asset, me, 'Definitely broken')).body;
  await admin.post(`/api/requests/${i2.id}/resolve`, {});
  assert.equal((await me.client.post(`/api/requests/${i2.id}/cancel`, {})).status, 400);
  assert.equal(row(i2.id).status, 'completed');
});

// ---------------------------------------------------------------- admin behaviour intact
test('admin: still sees every employee\'s requests with employee and asset context, and can cancel any live request', async () => {
  const a = await makeLogin('Admin View A');
  const b = await makeLogin('Admin View B');
  const asset = await newAsset('Admin view laptop');
  await give(asset, a);
  const eq = (await b.client.post('/api/requests', { category: 'Monitor', message: 'for b' })).body;
  const ret = (await returnRequest(asset, a)).body;
  const iss = (await reportIssue(asset, a, 'Dead pixel')).body;
  const all = (await admin.get('/api/requests?status=open')).body;
  for (const r of [eq, ret, iss]) assert.ok(all.some((x) => x.id === r.id), `admin sees #${r.id}`);
  const issRow = all.find((x) => x.id === iss.id);
  assert.equal(issRow.user_name, 'Admin View A');
  assert.equal(issRow.asset_tag, asset.tag);
  assert.equal(all.find((x) => x.id === eq.id).can_cancel, true);
  assert.equal((await admin.get('/api/requests?type=bogus')).status, 400);
  assert.equal((await admin.get('/api/requests?type=return')).body.every((r) => r.type === 'return'), true);
  for (const r of [eq, ret, iss]) assert.equal((await admin.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
});

test('admin: the IT-only return request route and the existing approve/deny workflow behave as before', async () => {
  const me = await makeLogin('Unchanged Flow');
  const asset = await newAsset('Unchanged laptop');
  const spare = await newAsset('Unchanged spare');
  await give(asset, me);
  const asked = await admin.post(`/api/assets/${asset.id}/request-return`, { employee_id: me.id, message: 'upgrade' });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.created, 1);
  const r = db.prepare("SELECT * FROM requests WHERE type = 'return' AND asset_id = ?").get(asset.id);
  assert.equal(r.created_by, db.prepare("SELECT id FROM accounts WHERE role = 'admin'").get().id, 'IT-created');
  assert.equal((await myRequests(me)).find((x) => x.id === r.id).self_initiated, 0);
  const eq = (await me.client.post('/api/requests', { category: 'Dock' })).body;
  assert.equal((await admin.post(`/api/requests/${eq.id}/approve`, { asset_id: spare.id, assignment_type: 'checkout', due_date: '2999-01-01' })).status, 200);
  assert.equal(row(eq.id).status, 'completed');
  const eq2 = (await me.client.post('/api/requests', { category: 'Dock' })).body;
  assert.equal((await admin.post(`/api/requests/${eq2.id}/deny`, { note: 'no' })).status, 200);
});

// ---------------------------------------------------------------- migration 10
const upTo = (n) => { const d = new Database(':memory:'); d.pragma('foreign_keys = ON'); runMigrations(d, migrations.filter((m) => m.id <= n)); return d; };

test('migration 10: existing requests survive unchanged, then issues are accepted — but only with an asset and a valid status', () => {
  const d = upTo(9);
  d.prepare("INSERT INTO employees (name) VALUES ('E1'), ('E2')").run();
  d.prepare("INSERT INTO accounts (employee_id, login_email, role) VALUES (1, 'a@x.com', 'admin')").run();
  d.prepare("INSERT INTO assets (tag, name) VALUES ('M-1', 'one'), ('M-2', 'two')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id, category, message, created_by, created_at) VALUES ('equipment', 'open', 1, 1, 'Laptop', 'm', 1, '2025-01-01 00:00:00')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id, created_at) VALUES ('return', 'dropped_off', 2, 1, '2025-01-04 00:00:00')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, created_at, resolved_at) VALUES ('equipment', 'denied', 1, '2025-01-05 00:00:00', '2025-01-05 00:00:00')").run();
  const rows = d.prepare('SELECT * FROM requests ORDER BY id').all();
  const seqBefore = d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get().seq;
  assert.throws(() => d.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('issue', 1, 1)").run(), /CHECK/, 'not accepted before the migration');

  assert.deepEqual(runMigrations(d, migrations.filter((m) => m.id <= 10)), [10]);
  assert.deepEqual(d.prepare('SELECT * FROM requests ORDER BY id').all(), rows, 'every row is identical');
  assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get().seq, seqBefore, 'ids are not reused');
  assert.equal(d.pragma('foreign_key_check').length, 0);
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  for (const idx of ['idx_requests_asset', 'idx_requests_employee_status', 'idx_requests_live_return']) assert.ok(d.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(idx), idx);

  d.prepare("INSERT INTO requests (type, user_id, asset_id, message) VALUES ('issue', 1, 2, 'broken')").run();
  assert.throws(() => d.prepare("INSERT INTO requests (type, user_id, message) VALUES ('issue', 1, 'no asset')").run(), /CHECK/, 'an issue is always about an asset');
  assert.throws(() => d.prepare("INSERT INTO requests (type, status, user_id, asset_id, resolved_at) VALUES ('issue', 'approved', 1, 2, datetime('now'))").run(), /CHECK/, 'issues are never approved');
  assert.throws(() => d.prepare("INSERT INTO requests (type, status, user_id, asset_id) VALUES ('issue', 'dropped_off', 1, 2)").run(), /CHECK/);
  assert.throws(() => d.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('ticket', 1, 2)").run(), /CHECK/, 'still a closed set of types');
  d.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('issue', 1, 2), ('issue', 1, 2)").run();
  assert.throws(() => d.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('return', 2, 1)").run(), /UNIQUE/, 'the live-return uniqueness survived the rebuild');
});
