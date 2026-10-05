const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const rules = require('../src/requests');
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
const isoPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { available_to_request: true, name, tag: `RQ-${++seq}`, ...extra })).body;
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `rq${++seq}@nutricost.com`, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id };
}
const request = async (who, body) => { const r = await who.post('/api/requests', body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const asRow = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const asAdminRequest = (me, a, extra = {}) => request(me.client, { asset_id: a.id, category: a.category, requested_assignment_type: 'permanent', ...extra });

// A raw insert helper for the database-level rules (status defaults to a valid open equipment request).
let rawEmployee;
const rawInsert = (cols) => {
  rawEmployee ??= db.prepare("INSERT INTO employees (name) VALUES ('Raw Person')").run().lastInsertRowid;
  const row = { type: 'equipment', user_id: rawEmployee, ...cols };
  const keys = Object.keys(row);
  return db.prepare(`INSERT INTO requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
};

// ================================================================ database-level rules
test('database: an invalid status or type is rejected', () => {
  assert.throws(() => rawInsert({ status: 'in_review' }), /CHECK/);
  assert.throws(() => rawInsert({ status: 'OPEN' }), /CHECK/);
  assert.throws(() => rawInsert({ type: 'purchase' }), /CHECK/);
  assert.ok(rawInsert({}).lastInsertRowid, 'a plain open equipment request is fine');
});

test('database: a status that does not belong to the request type is rejected', () => {
  const t = "2026-01-01 00:00:00";
  assert.throws(() => rawInsert({ type: 'equipment', status: 'dropped_off' }), /CHECK/);
  assert.throws(() => rawInsert({ type: 'return', status: 'approved', resolved_at: t }), /CHECK/);
  assert.throws(() => rawInsert({ type: 'return', status: 'denied', resolved_at: t }), /CHECK/);
});

test('database: status and resolution timestamps cannot contradict each other', () => {
  const t = '2999-01-01 00:00:00';
  assert.throws(() => rawInsert({ status: 'open', resolved_at: t, created_at: '2998-01-01 00:00:00' }), /CHECK/, 'open but resolved');
  assert.throws(() => rawInsert({ type: 'return', status: 'dropped_off', resolved_at: t, created_at: '2998-01-01 00:00:00' }), /CHECK/, 'dropped off but resolved');
  for (const status of ['approved', 'denied', 'completed', 'cancelled']) {
    assert.throws(() => rawInsert({ status }), /CHECK/, `${status} needs a resolved_at`);
  }
  assert.throws(() => rawInsert({ status: 'completed', created_at: '2026-05-01 00:00:00', resolved_at: '2026-04-30 23:59:59' }), /CHECK/, 'resolved before created');
  assert.ok(rawInsert({ status: 'completed', created_at: '2026-05-01 00:00:00', resolved_at: '2026-05-01 00:00:00' }).lastInsertRowid, 'resolved the same second is fine');
});

test('database: updating a live request into a contradictory state is rejected too', () => {
  const id = rawInsert({}).lastInsertRowid;
  assert.throws(() => db.prepare("UPDATE requests SET status = 'completed' WHERE id = ?").run(id), /CHECK/, 'completed without resolved_at');
  assert.throws(() => db.prepare("UPDATE requests SET status = 'bogus' WHERE id = ?").run(id), /CHECK/);
  assert.equal(asRow(id).status, 'open');
});

test('database: requested_assignment_type only on equipment requests, and "permanent" always names an asset', () => {
  const asset = db.prepare("INSERT INTO assets (tag, name) VALUES ('RQ-RAW', 'raw')").run().lastInsertRowid;
  assert.throws(() => rawInsert({ requested_assignment_type: 'permanent' }), /CHECK/, 'permanent without an asset');
  assert.throws(() => rawInsert({ type: 'return', asset_id: asset, requested_assignment_type: 'checkout' }), /CHECK/, 'on a return request');
  assert.ok(rawInsert({ asset_id: asset, requested_assignment_type: 'permanent' }).lastInsertRowid);
  assert.ok(rawInsert({ requested_assignment_type: 'checkout' }).lastInsertRowid, 'a temporary ask may name no asset');
});

test('database: at most one live return request per asset and employee; a closed one does not block a new one', () => {
  const asset = db.prepare("INSERT INTO assets (tag, name) VALUES ('RQ-RET', 'ret')").run().lastInsertRowid;
  const first = rawInsert({ type: 'return', asset_id: asset }).lastInsertRowid;
  assert.throws(() => rawInsert({ type: 'return', asset_id: asset }), /UNIQUE/);
  db.prepare("UPDATE requests SET status = 'dropped_off' WHERE id = ?").run(first);
  assert.throws(() => rawInsert({ type: 'return', asset_id: asset }), /UNIQUE/, 'dropped off is still live');
  db.prepare("UPDATE requests SET status = 'completed', resolved_at = datetime('now'), resolved_by = NULL WHERE id = ?").run(first);
  assert.ok(rawInsert({ type: 'return', asset_id: asset }).lastInsertRowid);
});

test('the transition table only ever uses statuses the database accepts for that type', () => {
  for (const [type, from] of Object.entries(rules.TRANSITIONS)) {
    for (const [status, targets] of Object.entries(from)) {
      for (const s of [status, ...targets]) {
        const resolving = !['open', 'dropped_off'].includes(s);
        const id = rawInsert({ type, status: s, ...(resolving ? { resolved_at: '2999-01-01 00:00:00', created_at: '2998-01-01 00:00:00' } : {}), ...(type !== 'equipment' ? { asset_id: db.prepare("INSERT INTO assets (tag, name) VALUES (?, 'x')").run(`RQ-T${++seq}`).lastInsertRowid } : {}) }).lastInsertRowid;
        assert.equal(asRow(id).status, s);
      }
    }
  }
  for (const type of ['equipment', 'return', 'issue']) for (const t of rules.TERMINAL) {
    if (rules.TRANSITIONS[type][t]) assert.deepEqual(rules.TRANSITIONS[type][t], [], `${type}/${t} is terminal`);
  }
});

// ================================================================ transitions through the API
const closeAs = {
  denied: (r) => admin.post(`/api/requests/${r.id}/deny`, { note: 'no' }),
  cancelled: (r) => admin.post(`/api/requests/${r.id}/cancel`, {}),
  completed: async (r) => { const a = await newAsset('Closing asset'); return admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'checkout', due_date: isoPlus(3) }); },
};

test('a closed (denied / cancelled / completed) equipment request can never be approved, denied or cancelled again, and is left untouched', async () => {
  const me = await makeLogin('Closed Owner');
  for (const how of ['denied', 'cancelled', 'completed']) {
    const r = await request(me.client, { category: 'Monitor', message: `to be ${how}` });
    assert.equal((await closeAs[how](r)).status, 200, how);
    const frozen = JSON.stringify(asRow(r.id));
    assert.equal(asRow(r.id).status, how);
    const spare = await newAsset('Spare for closed');
    for (const [label, call] of [
      ['approve', () => admin.post(`/api/requests/${r.id}/approve`, { asset_id: spare.id })],
      ['approve (no asset)', () => admin.post(`/api/requests/${r.id}/approve`, {})],
      ['deny', () => admin.post(`/api/requests/${r.id}/deny`, { note: 'again' })],
      ['cancel (admin)', () => admin.post(`/api/requests/${r.id}/cancel`, {})],
      ['cancel (owner)', () => me.client.post(`/api/requests/${r.id}/cancel`, {})],
      ['dropped-off', () => me.client.post(`/api/requests/${r.id}/dropped-off`, {})],
    ]) {
      const res = await call();
      assert.equal(res.status, 400, `${how} request: ${label} must be refused`);
    }
    assert.equal(JSON.stringify(asRow(r.id)), frozen, `a ${how} request is byte-for-byte unchanged`);
    assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', spare.id), 0, 'and nothing was assigned');
  }
});

test('approving without an asset acknowledges the request once; it can still be completed, declined or cancelled, but not re-approved', async () => {
  const me = await makeLogin('Ack Person');
  const r = await request(me.client, { category: 'Headset' });
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { note: 'Ordered' })).status, 200);
  const approved = asRow(r.id);
  assert.deepEqual([approved.status, approved.resolution_note], ['approved', 'Ordered']);
  assert.ok(approved.resolved_at && approved.resolved_by);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { note: 'Ordered again' })).status, 400, 'no second approval');
  assert.equal(asRow(r.id).resolution_note, 'Ordered', 'the first note survives');
  const a = await newAsset('Headset asset');
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 200);
  const done = asRow(r.id);
  assert.deepEqual([done.status, done.asset_id], ['completed', a.id]);
});

test('only equipment requests can be declined; a return request is cancelled or completed, never "denied"', async () => {
  const holder = await makeLogin('Return Holder');
  const a = await newAsset('Held');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: holder.id })).status, 200);
  assert.equal((await admin.post(`/api/assets/${a.id}/request-return`, {})).status, 200);
  const ret = db.prepare("SELECT * FROM requests WHERE type = 'return' AND asset_id = ?").get(a.id);
  assert.equal((await admin.post(`/api/requests/${ret.id}/deny`, { note: 'x' })).status, 400);
  assert.equal((await admin.post(`/api/requests/${ret.id}/approve`, {})).status, 400);
  assert.equal(asRow(ret.id).status, 'open');
});

test('drop-off applies to return requests only, once, and a closed return request cannot be reopened', async () => {
  const holder = await makeLogin('Dropper');
  const eq = await request(holder.client, { category: 'Phone' });
  assert.equal((await holder.client.post(`/api/requests/${eq.id}/dropped-off`, {})).status, 400, 'an equipment request cannot be "dropped off"');
  assert.equal(asRow(eq.id).status, 'open');

  const a = await newAsset('Dropped asset');
  await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: holder.id });
  await admin.post(`/api/assets/${a.id}/request-return`, {});
  const ret = db.prepare("SELECT * FROM requests WHERE type = 'return' AND asset_id = ?").get(a.id);
  assert.equal((await holder.client.post(`/api/requests/${ret.id}/dropped-off`, {})).status, 200);
  assert.equal(asRow(ret.id).status, 'dropped_off');
  assert.equal(asRow(ret.id).resolved_at, null, 'dropped off is not a resolution');
  assert.equal((await holder.client.post(`/api/requests/${ret.id}/dropped-off`, {})).status, 400, 'not twice');
  // a return-notice while already dropped off leaves it alone
  assert.equal((await holder.client.post(`/api/assets/${a.id}/return-notice`, {})).status, 200);
  assert.equal(count("SELECT COUNT(*) c FROM requests WHERE type = 'return' AND asset_id = ?", a.id), 1);
  // IT checks it in: completed with who/when; nothing can move it afterwards
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  const done = asRow(ret.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.resolved_at && done.resolved_by);
  for (const path of ['dropped-off', 'cancel']) assert.equal((await admin.post(`/api/requests/${ret.id}/${path}`, {})).status, 400, path);
  assert.equal(asRow(ret.id).status, 'completed');
});

test('rescinding: an employee cancels only their OWN EQUIPMENT request; IT can cancel a return request; nothing is deleted', async () => {
  const a = await makeLogin('Rescinder A');
  const b = await makeLogin('Rescinder B');
  const r = await request(a.client, { category: 'Tablet' });
  const before = count('SELECT COUNT(*) c FROM requests');
  assert.equal((await b.client.post(`/api/requests/${r.id}/cancel`, {})).status, 403);
  assert.equal(asRow(r.id).status, 'open');
  assert.equal((await a.client.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
  const row = asRow(r.id);
  assert.deepEqual([row.status, row.user_id], ['cancelled', a.id]);
  assert.ok(row.resolved_at && row.resolved_by, 'who and when are recorded');
  assert.equal(count('SELECT COUNT(*) c FROM requests'), before, 'the request is kept');

  const held = await newAsset('Rescind return');
  await admin.post(`/api/assets/${held.id}/checkout`, { employee_id: a.id });
  await admin.post(`/api/assets/${held.id}/request-return`, {});
  const ret = db.prepare("SELECT * FROM requests WHERE type = 'return' AND asset_id = ?").get(held.id);
  assert.equal((await a.client.post(`/api/requests/${ret.id}/cancel`, {})).status, 403, 'the holder cannot cancel IT\'s return request');
  assert.equal((await admin.post(`/api/requests/${ret.id}/cancel`, {})).status, 200);
  assert.equal(asRow(ret.id).status, 'cancelled');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', held.id), 1, 'cancelling a return request does not return the asset');
});

test('a simultaneous approve and rescind cannot both win: the request ends in exactly one coherent state', async () => {
  for (let i = 0; i < 5; i++) {
    const me = await makeLogin(`Racer ${i}`);
    const a = await newAsset(`Race asset ${i}`);
    const r = await asAdminRequest(me, a);
    const [approve, cancel] = await Promise.all([
      admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id }),
      me.client.post(`/api/requests/${r.id}/cancel`, {}),
    ]);
    assert.deepEqual([approve.status, cancel.status].sort(), [200, 400], `exactly one succeeds (${approve.status}/${cancel.status})`);
    const row = asRow(r.id);
    const assigned = count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id);
    if (approve.status === 200) assert.deepEqual([row.status, assigned], ['completed', 1]);
    else assert.deepEqual([row.status, assigned], ['cancelled', 0]);
  }
});

test('the transition helper itself refuses illegal moves and a stale status, and reports an unknown id', () => {
  const id = rawInsert({}).lastInsertRowid;
  assert.throws(() => rules.transition(db, id, 'dropped_off'), (e) => e.status === 400);
  assert.throws(() => rules.transition(db, 999999, 'cancelled'), (e) => e.status === 404);
  rules.transition(db, id, 'denied', { actorAccountId: null, note: 'n', setNote: true });
  assert.throws(() => rules.transition(db, id, 'completed'), /already closed/);
  assert.equal(asRow(id).resolution_note, 'n');
  assert.equal(rules.canTransition('equipment', 'completed', 'open'), false);
  assert.equal(rules.canTransition('return', 'open', 'denied'), false);
});

// ================================================================ creating requests
test('creating a request: a client cannot choose its status, and the type is always equipment', async () => {
  const me = await makeLogin('Sneaky');
  const r = await me.client.post('/api/requests', { category: 'Monitor', status: 'completed', type: 'return', resolved_by: 1, resolved_at: '2020-01-01 00:00:00', resolution_note: 'done' });
  assert.equal(r.status, 200);
  const row = asRow(r.body.id);
  assert.deepEqual([row.type, row.status, row.resolved_at, row.resolved_by, row.resolution_note], ['equipment', 'open', null, null, null]);
});

test('creating a request: an inactive person or an archived asset is refused', async () => {
  const gone = (await admin.post('/api/users', { name: 'Went Inactive', login: false })).body;
  assert.equal((await admin.put(`/api/users/${gone.id}`, { name: gone.name, active: false })).status, 200);
  const before = count('SELECT COUNT(*) c FROM requests');
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', user_id: gone.id })).status, 400);
  const archived = await newAsset('Archived ask');
  assert.equal((await admin.post(`/api/assets/${archived.id}/archive`, {})).status, 200);
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', asset_id: archived.id })).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM requests'), before);
});

test('listing requests: only the known status filters and types are accepted', async () => {
  assert.equal((await admin.get('/api/requests?status=open')).status, 200);
  assert.equal((await admin.get('/api/requests?status=closed&type=return')).status, 200);
  assert.equal((await admin.get('/api/requests?status=bogus')).status, 400);
  assert.equal((await admin.get('/api/requests?type=purchase')).status, 400);
});

// ================================================================ permanent-assignment requests
test('approving a permanent request with no asset in the body still makes the permanent assignment for the requested asset', async () => {
  const me = await makeLogin('Perm Plain');
  const a = await newAsset('Perm desk', { category: 'Desktop' });
  const r = await asAdminRequest(me, a);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { note: 'Pick it up' })).status, 200);
  const asg = db.prepare('SELECT * FROM assignments WHERE asset_id = ?').get(a.id);
  assert.deepEqual([asg.assignment_type, asg.employee_id, asg.due_date, asg.returned_at], ['permanent', me.id, null, null]);
  const row = asRow(r.id);
  assert.deepEqual([row.status, row.asset_id, row.resolution_note], ['completed', a.id, 'Pick it up']);
});

test('a permanent request cannot be approved with different equipment, downgraded to a loan, or left "approved" with nothing assigned', async () => {
  const me = await makeLogin('Perm Strict');
  const wanted = await newAsset('Wanted', { category: 'Laptop' });
  const other = await newAsset('Something else', { category: 'Laptop' });
  const r = await asAdminRequest(me, wanted);
  const frozen = JSON.stringify(asRow(r.id));
  const different = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: other.id });
  assert.equal(different.status, 400);
  assert.match(different.body.error, /equipment that was requested/);
  const loan = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: wanted.id, assignment_type: 'checkout', due_date: isoPlus(5) });
  assert.equal(loan.status, 400);
  assert.match(loan.body.error, /permanent/);
  assert.equal(JSON.stringify(asRow(r.id)), frozen, 'still open and untouched');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id IN (?, ?)', wanted.id, other.id), 0);
});

test('a failed approval is atomic: the request stays open and no assignment is left behind', async () => {
  const holder = await makeLogin('Already Has It');
  const me = await makeLogin('Too Late');
  const a = await newAsset('Taken first');
  const r = await asAdminRequest(me, a);
  await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: holder.id }); // someone else got it first
  const res = await admin.post(`/api/requests/${r.id}/approve`, {});
  assert.equal(res.status, 400);
  assert.equal(asRow(r.id).status, 'open');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ?', a.id, me.id), 0);
});

test('approval is refused for an inactive person and for an archived asset; the request stays open', async () => {
  const gone = await makeLogin('Leaves Later');
  const a = await newAsset('For leaver');
  const r = await request(gone.client, { category: 'Monitor' });
  assert.equal((await admin.put(`/api/users/${gone.id}`, { name: 'Leaves Later', active: false })).status, 200);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'checkout', due_date: isoPlus(2) })).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
  assert.equal(asRow(r.id).status, 'open');

  const me = await makeLogin('Wants Archived');
  const arch = await newAsset('Archived later');
  const pr = await asAdminRequest(me, arch);
  await admin.post(`/api/assets/${arch.id}/archive`, {});
  assert.equal((await admin.post(`/api/requests/${pr.id}/approve`, {})).status, 400);
  assert.equal(asRow(pr.id).status, 'open');
  assert.equal((await admin.post(`/api/requests/${pr.id}/deny`, { note: 'asset retired' })).status, 200, 'but it can still be declined');
});

test('a temporary checkout does NOT complete an open permanent request; a permanent one does; an unspecified one is completed by either', async () => {
  const me = await makeLogin('Self Borrower');
  const a = await newAsset('Both ways', { category: 'Laptop' });
  const perm = await asAdminRequest(me, a);
  const loan = await me.client.post(`/api/assets/${a.id}/checkout`, { due_date: isoPlus(2) });
  assert.equal(loan.status, 200, JSON.stringify(loan.body));
  assert.equal(asRow(perm.id).status, 'open', 'the loan did not satisfy the permanent request');
  assert.equal(asRow(perm.id).resolved_at, null);
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  assert.equal(asRow(perm.id).status, 'open', 'returning the loan does not touch it either');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: me.id, assignment_type: 'permanent' })).status, 200);
  const done = asRow(perm.id);
  assert.deepEqual([done.status, done.asset_id], ['completed', a.id]);
  assert.ok(done.resolved_at && done.resolved_by);

  const b = await newAsset('Unspecified ask');
  const plain = await request(me.client, { asset_id: b.id, category: 'Monitor' });
  assert.equal((await admin.post(`/api/assets/${b.id}/checkout`, { employee_id: me.id, assignment_type: 'checkout', due_date: isoPlus(4) })).status, 200);
  assert.equal(asRow(plain.id).status, 'completed');
});

test('a direct checkout only closes the requests of the person it went to', async () => {
  const p = await makeLogin('Gets It');
  const q = await makeLogin('Still Waiting');
  const a = await newAsset('Shared ask');
  const forP = await request(p.client, { asset_id: a.id, category: 'Monitor' });
  const forQ = await request(q.client, { asset_id: a.id, category: 'Monitor' });
  await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: p.id });
  assert.equal(asRow(forP.id).status, 'completed');
  assert.equal(asRow(forQ.id).status, 'open');
});

test('once approval has created the permanent assignment, the request can no longer be cancelled by anyone and still reads "completed"', async () => {
  const me = await makeLogin('Approved Then Cancels');
  const a = await newAsset('Approved permanent laptop', { category: 'Laptop' });
  const r = await asAdminRequest(me, a);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { note: 'yours' })).status, 200);
  const frozen = JSON.stringify(asRow(r.id));
  assert.equal(asRow(r.id).status, 'completed');
  assert.equal((await me.client.post(`/api/requests/${r.id}/cancel`, {})).status, 400, 'the employee cannot rescind it');
  assert.equal((await admin.post(`/api/requests/${r.id}/cancel`, {})).status, 400, 'nor can IT turn it into "cancelled"');
  assert.equal(JSON.stringify(asRow(r.id)), frozen, 'history is untouched');
  const asg = db.prepare('SELECT * FROM assignments WHERE asset_id = ?').get(a.id);
  assert.deepEqual([asg.assignment_type, asg.employee_id, asg.returned_at], ['permanent', me.id, null], 'and the assignment stands');
});

test('a permanent request that is approved without an assignment (legacy row) cannot be rescinded by the employee; open ones still can', async () => {
  const me = await makeLogin('Legacy Approved');
  const a = await newAsset('Legacy approved asset', { category: 'Desktop' });
  const legacy = rawInsert({ user_id: me.id, asset_id: a.id, requested_assignment_type: 'permanent', status: 'approved', created_at: '2025-01-01 00:00:00', resolved_at: '2025-01-02 00:00:00' }).lastInsertRowid;
  const res = await me.client.post(`/api/requests/${legacy}/cancel`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already approved/);
  assert.equal(asRow(legacy).status, 'approved');
  // IT may still cancel it while no assignment exists...
  assert.equal((await admin.post(`/api/requests/${legacy}/cancel`, {})).status, 200);
  assert.equal(asRow(legacy).status, 'cancelled');
  // ...but not once an assignment made from that approval exists
  const b = await newAsset('Legacy approved + assigned', { category: 'Desktop' });
  const withAsg = rawInsert({ user_id: me.id, asset_id: b.id, requested_assignment_type: 'permanent', status: 'approved', created_at: '2025-01-01 00:00:00', resolved_at: '2025-01-02 00:00:00' }).lastInsertRowid;
  db.prepare("INSERT INTO assignments (asset_id, employee_id, assignment_type, notes) VALUES (?, ?, 'permanent', ?)").run(b.id, me.id, `Request #${withAsg}`);
  assert.equal((await admin.post(`/api/requests/${withAsg}/cancel`, {})).status, 400);
  assert.equal(asRow(withAsg).status, 'approved');
  // genuinely open permanent requests keep today's behavior (employee can rescind)
  const open = await asAdminRequest(me, await newAsset('Still open', { category: 'Desktop' }));
  assert.equal((await me.client.post(`/api/requests/${open.id}/cancel`, {})).status, 200);
  assert.equal(asRow(open.id).status, 'cancelled');
  // and an approved temporary / unspecified request can no longer be rescinded either: IT acting on it opened it
  const plain = await request(me.client, { category: 'Headset' });
  await admin.post(`/api/requests/${plain.id}/approve`, { note: 'ordered' });
  assert.equal((await me.client.post(`/api/requests/${plain.id}/cancel`, {})).status, 400);
  assert.equal(asRow(plain.id).status, 'approved');
});

// ================================================================ historical safety
test('archiving an asset keeps every request, assignment and activity row, and the requests still resolve to the asset', async () => {
  const me = await makeLogin('History Keeper');
  const a = await newAsset('History asset', { category: 'Laptop' });
  const r = await asAdminRequest(me, a);
  await admin.post(`/api/requests/${r.id}/approve`, {});
  await admin.post(`/api/assets/${a.id}/checkin`, { assignment_id: db.prepare('SELECT id FROM assignments WHERE asset_id = ?').get(a.id).id });
  const counts = () => [count('SELECT COUNT(*) c FROM requests WHERE asset_id = ?', a.id), count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', a.id)];
  const before = counts();
  assert.equal((await admin.post(`/api/assets/${a.id}/archive`, {})).status, 200);
  assert.equal((await admin.del(`/api/assets/${a.id}`)).status, 400, 'the DELETE alias archives; a second one is refused, not destructive');
  assert.deepEqual(counts().slice(0, 2), before.slice(0, 2));
  assert.equal(counts()[2], before[2] + 1, 'only the archive entry was added');
  const listed = (await admin.get('/api/requests?status=closed')).body.find((x) => x.id === r.id);
  assert.deepEqual([listed.asset_name, listed.asset_tag, listed.status], [a.name, a.tag, 'completed']);
});

test('deactivating an employee keeps their requests and history readable', async () => {
  const me = await makeLogin('Soon Inactive');
  const r = await request(me.client, { category: 'Keyboard' });
  assert.equal((await admin.put(`/api/users/${me.id}`, { name: 'Soon Inactive', active: false })).status, 200);
  const row = (await admin.get('/api/requests?status=open')).body.find((x) => x.id === r.id);
  assert.equal(row.user_name, 'Soon Inactive');
  assert.equal(row.status, 'open');
});

test('raw deletes cannot orphan or erase request history: employees, accounts and assets are all RESTRICTed', async () => {
  const me = await makeLogin('Referenced');
  const a = await newAsset('Referenced asset');
  const r = await asAdminRequest(me, a);
  await admin.post(`/api/requests/${r.id}/deny`, { note: 'ref' });
  const row = asRow(r.id);
  assert.throws(() => db.prepare('DELETE FROM employees WHERE id = ?').run(me.id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('DELETE FROM assets WHERE id = ?').run(a.id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('DELETE FROM accounts WHERE id = ?').run(row.resolved_by), /FOREIGN KEY/, 'the resolving account');
  assert.throws(() => db.prepare('DELETE FROM accounts WHERE id = ?').run(row.created_by), /FOREIGN KEY/, 'the creating account');
  assert.equal(asRow(r.id).status, 'denied');
  const fk = (col) => db.pragma('foreign_key_list(requests)').find((f) => f.from === col);
  for (const col of ['user_id', 'asset_id', 'created_by', 'resolved_by']) assert.equal(fk(col).on_delete, 'RESTRICT', col);
});

test('the application exposes no way to delete or edit a request outright', async () => {
  const me = await makeLogin('No Delete');
  const r = await request(me.client, { category: 'Dock' });
  for (const verb of ['delete', 'put']) {
    const res = await (verb === 'delete' ? me.client.del(`/api/requests/${r.id}`) : me.client.put(`/api/requests/${r.id}`, { status: 'completed' }));
    assert.equal(res.status, 404, verb);
  }
  assert.equal(asRow(r.id).status, 'open');
});

// ================================================================ migration 9 on existing data
const upTo = (n) => { const d = new Database(':memory:'); d.pragma('foreign_keys = ON'); runMigrations(d, migrations.filter((m) => m.id <= n)); return d; };
function legacy() {
  const d = upTo(8);
  d.prepare("INSERT INTO employees (name) VALUES ('E1'), ('E2')").run();
  d.prepare("INSERT INTO accounts (employee_id, login_email, role) VALUES (1, 'a@x.com', 'admin')").run();
  d.prepare("INSERT INTO assets (tag, name) VALUES ('L-1', 'one'), ('L-2', 'two')").run();
  return d;
}

test('migration 9: valid existing requests survive with ids, ordering, sequence and references intact', () => {
  const d = legacy();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id, category, message, created_by, created_at) VALUES ('equipment', 'open', 1, 1, 'Laptop', 'm', 1, '2025-01-01 00:00:00')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id, created_by, created_at, resolved_by, resolved_at, resolution_note, requested_assignment_type) VALUES ('equipment', 'completed', 2, 2, 1, '2025-01-02 00:00:00', 1, '2025-01-03 00:00:00', 'ok', 'permanent')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id, created_at) VALUES ('return', 'dropped_off', 2, 1, '2025-01-04 00:00:00')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, created_at, resolved_at) VALUES ('equipment', 'denied', 1, '2025-01-05 00:00:00', '2025-01-05 00:00:00')").run();
  d.prepare("INSERT INTO requests (type, status, user_id, created_at) VALUES ('equipment', 'open', 1, '2025-01-06 00:00:00')").run();
  d.prepare("DELETE FROM requests WHERE id = 5").run();
  const rows = d.prepare('SELECT * FROM requests ORDER BY id').all();
  const seqBefore = d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get().seq;
  assert.deepEqual(runMigrations(d, migrations.filter((m) => m.id <= 9)), [9]);
  assert.deepEqual(d.prepare('SELECT * FROM requests ORDER BY id').all(), rows, 'every row is identical');
  assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get().seq, seqBefore, 'ids are not reused');
  assert.equal(d.pragma('foreign_key_check').length, 0);
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  for (const idx of ['idx_requests_asset', 'idx_requests_employee_status', 'idx_requests_live_return']) assert.ok(d.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(idx), idx);
  assert.throws(() => d.prepare("UPDATE requests SET status = 'completed', resolved_at = NULL WHERE id = 1").run(), /CHECK/);
  assert.throws(() => d.prepare("DELETE FROM assets WHERE id = 1").run(), /FOREIGN KEY/);
});

test('migration 9: an empty requests table migrates cleanly', () => {
  const d = legacy();
  assert.deepEqual(runMigrations(d, migrations.filter((m) => m.id <= 9)), [9]);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM requests').get().c, 0);
});

test('migration 9: contradictory legacy requests abort it, are named with their ids, and nothing changes', () => {
  const d = legacy();
  const ins = d.prepare('INSERT INTO requests (type, status, user_id, asset_id, created_at, resolved_by, resolved_at, requested_assignment_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('equipment', 'open', 1, 1, '2025-01-01 00:00:00', 1, '2025-01-02 00:00:00', null);       // 1: open but resolved
  ins.run('equipment', 'completed', 1, 1, '2025-01-01 00:00:00', null, null, null);                 // 2: completed, no timestamp
  ins.run('equipment', 'denied', 1, 1, '2025-02-01 00:00:00', 1, '2025-01-01 00:00:00', null);      // 3: resolved before created
  ins.run('return', 'denied', 2, 2, '2025-01-01 00:00:00', 1, '2025-01-02 00:00:00', null);         // 4: wrong status for type
  ins.run('equipment', 'open', 2, null, '2025-01-01 00:00:00', null, null, 'permanent');            // 5: permanent, no asset
  ins.run('equipment', 'open', 2, 2, '2025-01-01 00:00:00', null, null, null);                      // 6: fine
  assert.throws(() => runMigrations(d, migrations.filter((m) => m.id <= 9)), (e) => {
    for (const id of [1, 2, 3, 4, 5]) assert.match(e.message, new RegExp(`request id [^;]*\\b${id}\\b`), `names request ${id}`);
    assert.match(e.message, /nothing was changed/);
    return true;
  });
  assert.equal(d.prepare('SELECT MAX(id) m FROM schema_migrations').get().m, 8);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM requests').get().c, 6, 'no request was repaired, merged or deleted');
  assert.equal(d.prepare('SELECT status FROM requests WHERE id = 1').get().status, 'open');
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
});

test('migration 9: duplicate live return requests abort it', () => {
  const d = legacy();
  d.prepare("INSERT INTO requests (type, status, user_id, asset_id) VALUES ('return', 'open', 2, 1), ('return', 'dropped_off', 2, 1)").run();
  assert.throws(() => runMigrations(d, migrations.filter((m) => m.id <= 9)), /more than one live return request/);
  assert.equal(d.prepare('SELECT MAX(id) m FROM schema_migrations').get().m, 8);
});
