// Slice 5C-4 (D-46, D-48): src/pg/requestRecords.js, differential against src/requestRecords.js, plus the approval transaction's
// rollback, lock order and races. Twin worlds (test-support/pg-twin.js) hold the same rows with the same ids on both engines.
//   - listRequests: admin (with and without an employee) and employee viewers, the status / type filters, self- vs IT-initiated
//     requests, created_by / resolved_by with and without an employee, `can_cancel` true and false, lifecycle, ties, > 500 rows
//     (inserted in DESCENDING id order, so PostgreSQL's physical order is the reverse of SQLite's rowid scan).
//   - createEquipmentRequest: the returned row equals the stored row on both engines; unknown ids fail on both (foreign keys);
//     NUL text (the (as) / (at) policy).
//   - approveRequest: with an asset (permanent / temporary, due date and time), without one, and the refusals (seats, someone else
//     holds it, archived, maintenance, reserved, missing return date, request closed / not open): same outcome AND the same tables,
//     nothing written by a refusal. The SQLite side of a refusal for a closed request is the route's check + the SQLite write (what
//     users see today), as in the 5C-3 tests.
//   - PostgreSQL only: the caller's transaction is joined; the statement order (asset lock first, assignment, then the request row);
//     the 5A lock timeout (503 ASSET_BUSY, nothing written, the lock taken before validation); deterministic two-operation races
//     (test-support/pg-auth-support.js overlap): two approves of one request, two requests for one single-unit asset, approve vs the
//     employee's rescind (both orders), approve vs a reservation on the same asset (both orders, no deadlock).
// Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const { result, overlap } = require('../../test-support/pg-auth-support');
const { blockAsset, spyPool, oneLine } = require('../../test-support/pg-write-support');
const fx = require('../../test-support/pg-fixtures');
const { withTransaction, setLockTimeout, BUSY_ASSET } = require('../../src/pg/transaction');
const pgTime = require('../../src/pg/time');

const sq = require('../../src/requestRecords');
const pg = require('../../src/pg/requestRecords');
const sqRequests = require('../../src/requests');
const sqAccess = require('../../src/requestAccess');
const pgRequests = require('../../src/pg/requests');
const pgReservations = require('../../src/pg/reservations');

const T1 = '2026-01-01 00:00:00';
const T2 = '2026-02-01 00:00:00';
const T3 = '2026-03-01 00:00:00';
const LATER = '2026-12-31 00:00:00';
const CLOSED = 'This request is already closed';
const NOT_OPEN = 'This request is not open';
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// module-written timestamps read each engine's clock a moment apart
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const STAMPS = new Set(['created_at', 'updated_at', 'checked_out_at', 'resolved_at', 'opened_at', 'closed_at']);
const mask = (v) => {
  if (Array.isArray(v)) return v.map(mask);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, STAMPS.has(k) && typeof x === 'string' && STAMP.test(x) ? '<stamp>' : mask(x)]));
};

// POST /api/requests/:id/approve on SQLite: the route's own status check on the request as it is now, then the write.
function sqRouteApprove(db, args) {
  const cur = sqAccess.loadRequest(db, args.request.id);
  if (!sqRequests.canTransition('equipment', cur.status, 'approved') && !sqRequests.canTransition('equipment', cur.status, 'completed')) {
    throw httpError(400, sqRequests.TERMINAL.includes(cur.status) ? CLOSED : NOT_OPEN);
  }
  return sq.approveRequest(db, args);
}

describe('PostgreSQL listRequests (differential against src/requestRecords.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  const viewers = {};
  const FILTERS = [{}, { status: 'open' }, { status: 'closed' }, { type: 'equipment' }, { type: 'return' }, { type: 'issue' }, { status: 'open', type: 'return' }, { status: 'closed', type: 'equipment' }];
  const list = (label, user, f) => tw.same(label, (q) => pg.listRequests(q, user, f), (db) => sq.listRequests(db, user, f));

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.ana = await tw.employee({ name: 'Ana', department: 'IT' });
    w.ben = await tw.employee({ name: 'Ben', department: 'Ops' });
    w.cat = await tw.employee({ name: 'Cat' });
    w.anaAcc = await tw.insert('accounts', { employee_id: w.ana.id, login_email: 'ana@nutricost.com', role: 'admin' });
    w.benAcc = await tw.insert('accounts', { employee_id: w.ben.id, login_email: 'ben@nutricost.com', role: 'employee' });
    w.robot = await tw.insert('accounts', { employee_id: null, login_email: 'robot@nutricost.com', role: 'admin' });
    const cam = await tw.asset({ name: 'Camera', tag: 'CAM-1' });
    const lap = await tw.asset({ name: 'Laptop', tag: 'LAP-1' });
    const mon = await tw.asset({ name: 'Monitor', tag: 'MON-1' });
    const req = (cols) => tw.insert('requests', { type: 'equipment', status: 'open', created_at: T1, ...cols });
    const by = (acc, at = T3) => ({ resolved_by: acc.id, resolved_at: at });
    const ben = w.ben.id; const cat = w.cat.id;
    await req({ user_id: ben, created_by: w.benAcc.id, category: 'Cameras', message: 'self, cancellable' });
    await req({ user_id: ben, created_by: w.anaAcc.id, opened_at: T2, message: 'IT opened it: the employee may not rescind' });
    const perm = await req({ user_id: ben, created_by: w.benAcc.id, status: 'approved', requested_assignment_type: 'permanent', asset_id: cam.id, ...by(w.anaAcc) });
    await tw.assignment({ asset_id: cam.id, employee_id: ben, notes: `Request #${perm.id}` }); // assigned: nobody may cancel
    await req({ user_id: ben, created_by: w.benAcc.id, status: 'approved', requested_assignment_type: 'permanent', asset_id: lap.id, ...by(w.robot) });
    await req({ type: 'return', user_id: ben, asset_id: cam.id, created_by: w.benAcc.id });
    await req({ type: 'return', user_id: ben, asset_id: lap.id, created_by: w.anaAcc.id, created_at: T2 });
    await req({ type: 'return', status: 'dropped_off', user_id: ben, asset_id: mon.id, created_by: w.benAcc.id });
    await req({ type: 'issue', user_id: ben, asset_id: cam.id, created_by: null, message: 'no creator' });
    await req({ status: 'cancelled', user_id: ben, created_by: w.benAcc.id, ...by(w.benAcc) });
    await req({ status: 'cancelled', user_id: ben, created_by: w.benAcc.id, created_at: T2, ...by(w.anaAcc) });
    await req({ status: 'denied', user_id: cat, created_by: w.anaAcc.id, ...by(w.robot) });
    await req({ status: 'completed', user_id: cat, created_by: w.robot.id, asset_id: lap.id, ...by(w.anaAcc) });
    await req({ user_id: cat, created_by: w.anaAcc.id, category: 'Cameras', catalog_path: 'Cameras' });
    await req({ type: 'return', status: 'dropped_off', user_id: cat, asset_id: cam.id, created_by: null });
    viewers.admin = { role: 'admin', employee_id: w.ana.id, account_id: w.anaAcc.id };
    viewers.robot = { role: 'admin', employee_id: null, account_id: w.robot.id };
    viewers.ben = { role: 'employee', employee_id: ben, account_id: w.benAcc.id };
    viewers.cat = { role: 'employee', employee_id: cat, account_id: null };
    viewers.nobody = { role: 'employee', employee_id: null, account_id: w.robot.id };
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('every viewer x filter: the same rows, columns, order, self_initiated, can_cancel and lifecycle', async () => {
    for (const [who, user] of Object.entries(viewers)) {
      for (const f of FILTERS) await list(`${who} ${JSON.stringify(f)}`, user, f);
    }
    const all = (await list('admin, no filter object', viewers.admin, undefined)).ok;
    assert.equal(all.length, 14);
    assert.ok(all.every((r) => r.self_initiated === 0 || r.self_initiated === 1), 'self_initiated is a 0/1 number');
    assert.deepEqual([...new Set(all.map((r) => r.can_cancel))].sort(), [false, true]);
    const benRows = (await list('ben', viewers.ben, {})).ok;
    assert.ok(benRows.length > 0 && benRows.every((r) => r.user_id === w.ben.id), 'an employee sees only their own');
    assert.equal(benRows.filter((r) => r.can_cancel).length, 3, 'ben may cancel his unopened open request, his own return and his issue report');
    assert.ok(all.some((r) => r.lifecycle === 'rescinded') && all.some((r) => r.created_by_name === 'robot@nutricost.com') && all.some((r) => r.resolved_by_name === 'robot@nutricost.com'));
    assert.deepEqual((await list('nobody', viewers.nobody, {})).ok, []);
  });

  test('more than 500 rows: the same 500, ties in SQLite\'s plan order (admin: id; employee: status, id)', async () => {
    const statuses = ['open', 'approved', 'completed', 'cancelled', 'denied'];
    for (let i = 0; i < 700; i++) {
      const status = statuses[i % 5];
      const row = {
        id: 300000 - i, // descending ids: PostgreSQL's heap order is the reverse of the id order
        type: 'equipment', status, user_id: i % 4 ? w.ben.id : w.cat.id, created_by: i % 3 ? w.benAcc.id : w.anaAcc.id,
        created_at: [T1, T2, T1, T3][i % 4], resolved_by: status === 'open' ? null : (i % 2 ? w.benAcc.id : w.anaAcc.id), resolved_at: status === 'open' ? null : LATER,
      };
      await fx.insertRow(tw.pg, 'requests', row);
      await fx.insertRow(tw.sq, 'requests', row);
    }
    for (const who of ['admin', 'ben']) {
      for (const f of [{}, { status: 'open' }, { status: 'closed' }, { type: 'equipment' }]) {
        const out = (await list(`${who} ${JSON.stringify(f)} (700 more rows)`, viewers[who], f)).ok;
        if (!f.status) assert.equal(out.length, 500, 'LIMIT 500');
      }
    }
  });
});

describe('PostgreSQL createEquipmentRequest and approveRequest (differential against src/requestRecords.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  const WRITE_TABLES = ['requests', 'assignments', 'assets', 'activity', 'waitlist_entries'];
  async function sameTables(label) {
    const pgT = {}; const sqT = {};
    for (const t of WRITE_TABLES) {
      pgT[t] = mask((await tw.pg.query(`SELECT * FROM ${t} ORDER BY id`)).rows);
      sqT[t] = mask(tw.sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    }
    assert.deepEqual(pgT, sqT, `${label}: the tables agree`);
    return pgT;
  }
  async function write(label, pgFn, sqFn) {
    await syncSequences(tw.pg, tw.sqlite);
    await syncSequences(tw.pg, tw.sqlite, ['requests']);
    const pgOut = mask(await result(() => pgFn(tw.pg)));
    const sqOut = mask(await result(() => sqFn(tw.sqlite)));
    assert.deepEqual(pgOut, sqOut, label);
    await sameTables(label);
    return pgOut;
  }
  async function refused(label, args, expected) {
    const before = await sameTables(`${label} (before)`);
    const out = await write(label, (q) => pg.approveRequest(q, args), (db) => sqRouteApprove(db, args));
    assert.deepEqual(out.error && (expected.message ? out.error : { status: out.error.status }), expected, label);
    assert.deepEqual(await sameTables(`${label} (after)`), before, `${label}: nothing written`);
  }
  const create = (label, args) => write(label, (q) => pg.createEquipmentRequest(q, args), (db) => sq.createEquipmentRequest(db, args));
  const approve = (label, args) => write(label, (q) => pg.approveRequest(q, args), (db) => sqRouteApprove(db, args));
  const req = (cols) => tw.insert('requests', { type: 'equipment', status: 'open', created_at: T1, created_by: w.benAcc.id, ...cols });
  const args = (r, asset, employeeId, extra = {}) => ({ request: r, asset, employeeId, actorAccountId: w.anaAcc.id, assignmentType: undefined, dueDate: undefined, dueTime: undefined, note: null, ...extra });
  const base = { assetId: null, category: null, message: null, neededBy: null, wantedType: null, nodeId: null, catalogPath: null, assetLabel: null };

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.ana = await tw.employee({ name: 'Ana' });
    w.anaAcc = await tw.insert('accounts', { employee_id: w.ana.id, login_email: 'ana@nutricost.com', role: 'admin' });
    for (const n of ['ben', 'cara', 'dan', 'hana', 'eve']) w[n] = await tw.employee({ name: n[0].toUpperCase() + n.slice(1) });
    w.benAcc = await tw.insert('accounts', { employee_id: w.ben.id, login_email: 'ben@nutricost.com', role: 'employee' });
    w.node = await tw.node('Cameras');
    w.cam = await tw.asset({ name: 'Camera', tag: 'CAM-1', catalog_node_id: w.node.id, available_to_request: 1 });
    w.cam2 = await tw.asset({ name: 'Camera 2', tag: 'CAM-2' });
    w.lic = await tw.asset({ name: 'License', tag: 'LIC-1', license_seats: 2 });
    w.busy = await tw.asset({ name: 'Busy', tag: 'BSY-1', status: 'checked_out' });
    await tw.assignment({ asset_id: w.busy.id, employee_id: w.hana.id });
    w.arch = await tw.asset({ name: 'Old', tag: 'OLD-1', archived_at: T1 });
    w.maint = await tw.asset({ name: 'Broken', tag: 'BRK-1', status: 'maintenance' });
    w.resv = await tw.asset({ name: 'Booked', tag: 'BKD-1' });
    await tw.reservation({ asset_id: w.resv.id, employee_id: w.cara.id, start_date: '2026-01-01', end_date: '2999-12-31' });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('createEquipmentRequest: the row as stored (read-back equality), unknown ids fail on both engines, NUL text', async () => {
    const full = await create('specific item, catalog entry, temporary', {
      ...base, forUser: w.ben.id, assetId: w.cam.id, category: 'Cameras', message: 'For the shoot', neededBy: '2099-03-01', createdBy: w.benAcc.id,
      wantedType: 'checkout', nodeId: w.node.id, catalogPath: 'Cameras', assetLabel: 'CAM-1 — Camera',
    });
    assert.deepEqual(mask((await tw.pg.query('SELECT * FROM requests WHERE id = $1', [full.ok.id])).rows[0]), full.ok, 'returned = stored');
    assert.deepEqual([full.ok.status, full.ok.type, full.ok.resolved_at, full.ok.opened_at], ['open', 'equipment', null, null]);
    await create('category only, IT on behalf', { ...base, forUser: w.cara.id, category: 'Laptops', createdBy: w.anaAcc.id });
    await create('permanent assignment request', { ...base, forUser: w.dan.id, assetId: w.lic.id, category: 'Licenses', wantedType: 'permanent', createdBy: w.anaAcc.id, assetLabel: 'LIC-1 — License' });
    const before = await sameTables('before the failing inserts');
    assert.deepEqual(await create('unknown person', { ...base, forUser: 999999, category: 'X', createdBy: w.anaAcc.id }), { raw: true });
    assert.deepEqual(await create('unknown asset', { ...base, forUser: w.ben.id, assetId: 999999, category: 'X', createdBy: w.anaAcc.id }), { raw: true });
    assert.deepEqual(await create('permanent without an asset (CHECK)', { ...base, forUser: w.ben.id, wantedType: 'permanent', createdBy: w.anaAcc.id }), { raw: true });
    assert.deepEqual(await sameTables('after the failing inserts'), before);
    // (as)/(at): a NUL character cannot be stored on PostgreSQL (a 500); SQLite stores it. Only through a hand-made request.
    const nul = { ...base, forUser: w.ben.id, message: 'a\u0000b', createdBy: w.benAcc.id };
    assert.deepEqual(await result(() => pg.createEquipmentRequest(tw.pg, nul)), { raw: true });
    tw.sqlite.exec('SAVEPOINT nul');
    assert.equal(sq.createEquipmentRequest(tw.sqlite, nul).message, 'a\u0000b');
    tw.sqlite.exec('ROLLBACK TO nul; RELEASE nul');
    await sameTables('after the NUL probe');
  });

  test('approveRequest: permanent and temporary assignments complete the request; without an asset it is approved', async () => {
    const q1 = await req({ user_id: w.ben.id, requested_assignment_type: 'permanent', asset_id: w.cam.id, asset_label: 'CAM-1 — Camera' });
    const perm = await approve('permanent, with a note', args(q1, w.cam, w.ben.id, { assignmentType: 'permanent', dueDate: '2099-01-01', note: 'Enjoy' }));
    assert.deepEqual([perm.ok.assignment_type, perm.ok.due_date, perm.ok.notes], ['permanent', null, `Request #${q1.id}`], 'a permanent assignment drops the due date');
    const q2 = await req({ user_id: w.ben.id, category: 'Licenses' });
    const loan = await approve('temporary with date and time', args(q2, w.lic, w.ben.id, { assignmentType: 'checkout', dueDate: ' 2099-01-15 ', dueTime: '17:00' }));
    assert.deepEqual([loan.ok.assignment_type, loan.ok.due_date, loan.ok.due_time], ['checkout', '2099-01-15', '17:00']);
    const q3 = await req({ user_id: w.cara.id, category: 'Licenses' });
    assert.deepEqual(await approve('no asset: approved', args(q3, null, w.cara.id, { note: 'Ordered' })), { ok: null });
    await approve('an approved request completed later (the last seat)', args({ ...q3, status: 'approved' }, w.lic, w.cara.id, { assignmentType: 'checkout', dueDate: '2099-02-01' }));
    const rows = (await tw.pg.query('SELECT id, status, asset_id, resolution_note FROM requests WHERE id = ANY($1) ORDER BY id', [[q1.id, q2.id, q3.id]])).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.asset_id, r.resolution_note]), [['completed', w.cam.id, 'Enjoy'], ['completed', w.lic.id, null], ['completed', w.lic.id, null]]);
    assert.deepEqual((await tw.pg.query('SELECT status FROM assets WHERE id = ANY($1) ORDER BY id', [[w.cam.id, w.lic.id]])).rows.map((r) => r.status), ['checked_out', 'checked_out']);
  });

  test('refused approvals: the same status and message as SQLite, and nothing written (assignments, asset status, request, activity)', async () => {
    const open = (cols = {}) => req({ user_id: w.dan.id, category: 'Any', ...cols });
    await refused('no seat left', args(await open(), w.lic, w.dan.id, { assignmentType: 'checkout', dueDate: '2099-01-01' }), { status: 400, message: 'All license seats are in use.' });
    await refused('someone else holds it', args(await open(), w.busy, w.dan.id), { status: 400, message: 'Already checked out to Hana. Check it in first.' });
    await refused('the person already holds it', args(await req({ user_id: w.ben.id }), w.cam, w.ben.id), { status: 400, message: 'Ben already has this asset.' });
    await refused('archived', args(await open(), w.arch, w.dan.id), { status: 400, message: 'This asset is archived and can\'t be checked out.' });
    await refused('maintenance', args(await open(), w.maint, w.dan.id), { status: 400, message: 'This asset is marked maintenance and can\'t be checked out.' });
    await refused('reserved by someone else', args(await open(), w.resv, w.dan.id, { assignmentType: 'permanent' }), { status: 409 });
    await refused('temporary without a return date', args(await open(), w.cam2, w.dan.id, { assignmentType: 'checkout' }), { status: 400, message: 'A temporary checkout needs a return date.' });
    await refused('invalid return time', args(await open(), w.cam2, w.dan.id, { assignmentType: 'checkout', dueDate: '2099-01-01', dueTime: '25:00' }), { status: 400, message: 'Return time must be a valid time (HH:MM).' });
    // the request changed since the route read it (passed stale): the route's own message on SQLite, the transition's on PostgreSQL
    const closed = await open({ status: 'completed', resolved_at: T3 });
    await refused('request already completed (asset free)', args({ ...closed, status: 'open' }, w.cam2, w.dan.id), { status: 400, message: CLOSED });
    const cancelled = await open({ status: 'cancelled', resolved_at: T3 });
    await refused('request cancelled AND the asset taken: the request message first', args({ ...cancelled, status: 'open' }, w.busy, w.dan.id), { status: 400, message: CLOSED });
    const approved = await open({ status: 'approved', resolved_at: T3, resolved_by: w.anaAcc.id });
    await refused('approved request approved again without an asset', args(approved, null, w.dan.id), { status: 400, message: NOT_OPEN });
  });

  test("approveRequest joins the caller's transaction: committed with it, or rolled back with it", async () => {
    const r = await req({ user_id: w.eve.id, category: 'Cameras' });
    const a = args(r, w.cam2, w.eve.id, { assignmentType: 'checkout', dueDate: '2099-05-01' });
    const before = await sameTables('before the joined rollback');
    await assert.rejects(withTransaction(async (c) => {
      const made = await pg.approveRequest(c, a);
      assert.equal((await c.query('SELECT COUNT(*) AS n FROM assignments WHERE id = $1', [made.id])).rows[0].n, 1, 'visible inside the caller\'s transaction');
      throw new Error('a later step of the caller failed');
    }, tw.pg), /a later step/);
    assert.deepEqual(await sameTables('after the joined rollback'), before, 'nothing written');
    const made = await write('joined and committed', (pool) => withTransaction((c) => pg.approveRequest(c, a), pool), (db) => sqRouteApprove(db, a));
    assert.equal(made.ok.employee_id, w.eve.id);
  });
});

describe('PostgreSQL approveRequest: lock order, lock timeout and races', pgSuite(), () => {
  let tdb; let pool; let sampler; let adminAcc; let n = 0;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
    adminAcc = await fx.insertAccount(pool, { role: 'admin' });
  });
  after(async () => {
    setLockTimeout(null);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  // A fresh person (with a login) and a single-unit asset; `request(person)` makes an open "any matching" request.
  const person = async () => { const acc = await fx.insertAccount(pool); return { id: acc.employee_id, account: acc.id }; };
  const asset = () => fx.insertAsset(pool, { tag: `RC-${++n}`, available_to_request: 1 });
  const request = (p, cols = {}) => fx.insertRequest(pool, { user_id: p.id, created_by: p.account, ...cols });
  const args = (r, a, p, extra = {}) => ({ request: r, asset: a, employeeId: p.id, actorAccountId: adminAcc.id, assignmentType: 'permanent', note: null, ...extra });
  const state = async (r, a) => ({
    request: (await pool.query('SELECT status FROM requests WHERE id = $1', [r.id])).rows[0].status,
    assignments: a ? (await pool.query('SELECT employee_id FROM assignments WHERE asset_id = $1 ORDER BY id', [a.id])).rows.map((x) => x.employee_id) : null,
    asset: a ? (await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status : null,
    activity: a ? (await pool.query('SELECT action FROM activity WHERE asset_id = $1 ORDER BY id', [a.id])).rows.map((x) => x.action) : null,
  });
  const rescind = (r, p) => (q) => pgRequests.transition(q, r.id, 'cancelled', { actorAccountId: p.account, actorIsAdmin: false, requireUnopened: true });

  test('one transaction, one client: the asset lock first, then the assignment, then the request row', async () => {
    const p = await person(); const a = await asset(); const r = await request(p);
    const spy = spyPool(pool);
    await pg.approveRequest(spy.pool, args(r, a, p));
    const sqls = spy.calls.map((c) => oneLine(c.sql));
    assert.deepEqual([...new Set(spy.calls.map((c) => c.client))], [1], 'every statement on the one transaction client');
    assert.deepEqual([sqls[0], sqls[1], sqls.at(-1)], ['BEGIN', 'SELECT * FROM assets WHERE id = $1 FOR UPDATE', 'COMMIT']);
    const at = (re) => { const i = sqls.findIndex((s) => re.test(s)); assert.ok(i > 0, String(re)); return i; };
    const order = [at(/^SELECT type, status FROM requests/), at(/^INSERT INTO assignments/), at(/^SELECT id FROM requests WHERE id = \$1 FOR UPDATE$/), at(/^UPDATE requests SET/)];
    assert.deepEqual(order, [...order].sort((x, y) => x - y), sqls.join('\n'));
  });

  test('a busy asset: 503 ASSET_BUSY after the lock timeout, nothing written; the lock comes before validation (as BEGIN IMMEDIATE)', async () => {
    const p = await person(); const a = await asset(); const r = await request(p);
    const blocker = await blockAsset(pool, a.id);
    try {
      setLockTimeout(150);
      assert.deepEqual(await result(() => pg.approveRequest(pool, args(r, a, p))), { error: { status: 503, message: BUSY_ASSET } });
      assert.deepEqual(await result(() => pg.approveRequest(pool, args(r, a, p, { assignmentType: 'checkout' }))), { error: { status: 503, message: BUSY_ASSET } }, 'waits for the lock even with no return date');
    } finally {
      setLockTimeout(null);
      await blocker.release();
    }
    assert.deepEqual(await state(r, a), { request: 'open', assignments: [], asset: 'available', activity: [] });
  });

  test('two simultaneous approves of one request: one wins, the other gets the 400 SQLite gives, nothing half-written', async () => {
    const p = await person(); const a = await asset(); const b = await asset();
    const same = await request(p);
    const r1 = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(same, a, p)), (q) => pg.approveRequest(q, args(same, a, p)));
    assert.deepEqual([r1.second, r1.blocked], [{ error: { status: 400, message: CLOSED } }, true], 'waited on the asset, then saw the request closed');
    assert.deepEqual(await state(same, a), { request: 'completed', assignments: [p.id], asset: 'checked_out', activity: ['checked_out'] });
    // with a different asset each: the second gets its own asset at once, then waits on the request row and rolls its assignment back
    const any = await request(p); const c2 = await asset();
    const r2 = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(any, b, p)), (q) => pg.approveRequest(q, args(any, c2, p)));
    assert.deepEqual([r2.second, r2.blocked], [{ error: { status: 400, message: CLOSED } }, true]);
    assert.deepEqual((await state(any, c2)), { request: 'completed', assignments: [], asset: 'available', activity: [] }, 'the loser wrote nothing');
    // without an asset: the request row lock serializes them
    const plain = await request(p);
    const r3 = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(plain, null, p)), (q) => pg.approveRequest(q, args(plain, null, p)));
    assert.deepEqual([r3.first, r3.second, r3.blocked], [{ ok: null }, { error: { status: 400, message: NOT_OPEN } }, true]);
  });

  test("two requests for one single-unit asset: one wins, the other gets createAssignment's refusal", async () => {
    const p = await person(); const p2 = await person(); const a = await asset();
    const name = (await pool.query('SELECT name FROM employees WHERE id = $1', [p.id])).rows[0].name;
    const ra = await request(p); const rb = await request(p2);
    const r = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(ra, a, p)), (q) => pg.approveRequest(q, args(rb, a, p2)));
    assert.deepEqual([r.second, r.blocked], [{ error: { status: 400, message: `Already checked out to ${name}. Check it in first.` } }, true]);
    assert.deepEqual(await state(rb, a), { request: 'open', assignments: [p.id], asset: 'checked_out', activity: ['checked_out'] });
  });

  test("approve vs the employee's rescind of that request: one winner either way, a consistent final state", async () => {
    const p = await person(); const a = await asset(); const r = await request(p);
    const first = await overlap(pool, sampler, rescind(r, p), (q) => pg.approveRequest(q, args(r, a, p)));
    assert.deepEqual(['ok' in first.first, first.second, first.blocked], [true, { error: { status: 400, message: CLOSED } }, true], 'waited on the request row, then saw it cancelled');
    assert.deepEqual(await state(r, a), { request: 'cancelled', assignments: [], asset: 'available', activity: [] }, 'the approval wrote nothing');
    const b = await asset(); const r2 = await request(p);
    const second = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(r2, b, p)), rescind(r2, p));
    assert.deepEqual([second.second, second.blocked], [{ error: { status: 400, message: sqRequests.OPENED_MSG } }, true]);
    assert.deepEqual(await state(r2, b), { request: 'completed', assignments: [p.id], asset: 'checked_out', activity: ['checked_out'] });
  });

  test('approve vs a reservation on the same asset: both finish in either order (no deadlock), one of them refused', async () => {
    const today = await pgTime.today(pool);
    const reserve = (a, p) => (q) => pgReservations.create(q, { assetId: a.id, employeeId: p.id, actorAccountId: p.account, start: today, end: today });
    const reservations = async (a) => (await pool.query("SELECT COUNT(*) AS n FROM reservations WHERE asset_id = $1 AND status = 'confirmed'", [a.id])).rows[0].n;
    const p = await person(); const p2 = await person();
    const a = await asset(); const r = await request(p);
    const one = await overlap(pool, sampler, reserve(a, p2), (q) => pg.approveRequest(q, args(r, a, p)));
    assert.ok('ok' in one.first && one.blocked, JSON.stringify(one));
    assert.equal(one.second.error.status, 409);
    const s = await state(r, a);
    assert.deepEqual([await reservations(a), s.request, s.assignments, s.asset, s.activity.includes('checked_out')], [1, 'open', [], 'available', false]);
    const b = await asset(); const r2 = await request(p);
    const two = await overlap(pool, sampler, (c) => pg.approveRequest(c, args(r2, b, p)), reserve(b, p2));
    assert.ok('ok' in two.first && two.blocked, JSON.stringify(two));
    assert.equal(two.second.error.status, 409);
    assert.deepEqual([await reservations(b), (await state(r2, b)).assignments], [0, [p.id]]);
  });
});
