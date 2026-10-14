// Concurrency of the Slice 4B write paths (D-46, D-47), checked against the SERIAL-ORDER ORACLE: each race runs 2-4 operations
// on one asset truly concurrently on PostgreSQL (all contenders are started while a third connection holds the asset lock,
// and released together once every one of them is queued on it), and the same operations run through the SQLite modules on a
// fresh reference with the same fixture in EVERY serial order. The PostgreSQL outcomes (per operation) and the asset's final
// rows (masked) must equal ONE of those serial SQLite outcomes: PostgreSQL may not refuse anything every serial order allows,
// nor allow anything no serial order allows. No hand-written "no overlaps ever" rule is assumed (SQLite permits several, see
// the brief's product safeguard); the one invariant asserted on top is the one the 4B paths guarantee from clean fixtures: no
// two CONFIRMED reservations of one asset overlap, and no two live holds overlap. Also: different assets do not wait for each
// other, no deadlock, and the pool returns to baseline. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, createFixture, serialOracle, maskedRun, assertMatchesSerial, race, blockAsset, lockWaiters, waitFor } = require('../../test-support/pg-write-support');
const sqliteMail = prepareSqliteMail();

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { syncSequences } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const effects = require('../../src/pg/effects');
const sqliteReservations = require('../../src/reservations');
const sqliteAssignments = require('../../src/assignments');
const reservations = require('../../src/pg/reservations');
const assignments = require('../../src/pg/assignments');

describe('PostgreSQL reservation writes under concurrency (serial-order oracle)', pgSuite(), () => {
  let tdb; let pool; let sampler; let today;
  const d = (n) => T.addDays(today, n);
  const report = [];

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
    today = await pgTime.today(pool);
  });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0, 'nobody is still waiting for a connection');
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    assert.equal(await lockWaiters(sampler), 0, 'no lock waiter left behind');
    console.log(`[oracle] ${report.join(' | ')}`);
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  // A fixture with people and an admin account; `build(f, p)` adds the race's own asset and rows.
  function world(build) {
    const f = createFixture();
    const p = {};
    p.e = [1, 2, 3, 4].map((n) => f.employee({ name: `Racer ${n}` }));
    p.e.forEach((e) => { e.work_email = `racer${e.id}@example.com`; }); // unique across worlds in one database
    p.acct = p.e.map((e) => f.account({ employee_id: e.id }));
    p.admin = f.account({ role: 'admin' });
    build(f, p);
    return { f, p };
  }
  // Runs the race on PostgreSQL and checks it against every serial SQLite order. Returns the PostgreSQL outcomes.
  async function oracleRace(label, { f }, assetId, ops) {
    await f.apply(pool);
    await syncSequences(pool);
    const raw = await race(pool, sampler, assetId, ops.map((op) => () => op.pg(pool)));
    const pgRun = await maskedRun(pool, raw, [assetId]);
    const serial = await serialOracle(f, [assetId], ops);
    const orders = assertMatchesSerial(pgRun, serial, label);
    const distinct = new Set(serial.map((s) => JSON.stringify({ outs: s.outs, state: s.state }))).size;
    report.push(`${label}: ${serial.length} orders, ${distinct} distinct outcomes, PG = order ${orders.map((o) => o.join('')).join('/')}`);
    await assertInvariants(assetId);
    return raw;
  }
  async function assertInvariants(assetId) {
    const confirmed = (await pool.query("SELECT * FROM reservations WHERE asset_id = $1 AND status = 'confirmed'", [assetId])).rows;
    for (let i = 0; i < confirmed.length; i++) for (let j = i + 1; j < confirmed.length; j++) assert.ok(!T.overlapsRows(confirmed[i], confirmed[j]), `confirmed reservations ${confirmed[i].id} and ${confirmed[j].id} overlap`);
    const holds = (await pool.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' AND hold_expires_at > ${pgTime.NOW}`, [assetId])).rows;
    for (let i = 0; i < holds.length; i++) for (let j = i + 1; j < holds.length; j++) assert.ok(!T.overlapsRows(holds[i], holds[j]), `live holds ${holds[i].id} and ${holds[j].id} overlap (the same time offered twice)`);
  }
  const createOp = (args) => ({ pg: (q) => reservations.create(q, args), sq: (db) => sqliteReservations.create(db, args) });
  const op = (fn, id, opts) => ({ pg: (q) => reservations[fn](q, id, opts), sq: (db) => sqliteReservations[fn](db, id, opts) });

  test('(a) four simultaneous overlapping creates, approval OFF: equals a serial order; no overlapping confirmed reservations', async () => {
    let asset;
    const wd = world((f) => { asset = f.asset({ name: 'Race A' }); });
    const { p } = wd;
    const raw = await oracleRace('a: 4 creates', wd, asset.id, [
      createOp({ assetId: asset.id, employeeId: p.e[0].id, actorAccountId: p.acct[0].id, start: d(3), end: d(5) }),
      createOp({ assetId: asset.id, employeeId: p.e[1].id, actorAccountId: p.acct[1].id, start: d(4), end: d(6) }),
      createOp({ assetId: asset.id, employeeId: p.e[2].id, actorAccountId: p.acct[2].id, start: d(5), end: d(5), startTime: '13:00', endTime: '17:00' }),
      createOp({ assetId: asset.id, employeeId: p.e[3].id, actorAccountId: p.acct[3].id, start: d(2), end: d(3) }),
    ]);
    assert.ok(raw.some((r) => r.ok), 'someone reserved');
  });

  test('(a) four simultaneous overlapping creates, approval ON: all pending, exactly as SQLite (pending holds no time)', async () => {
    let asset;
    const wd = world((f) => { asset = f.asset({ name: 'Race A2', reservation_requires_approval: 1 }); });
    const { p } = wd;
    const raw = await oracleRace('a: 4 creates, approval', wd, asset.id, p.e.map((e, i) => createOp({ assetId: asset.id, employeeId: e.id, actorAccountId: p.acct[i].id, start: d(3), end: d(4) })));
    assert.ok(raw.every((r) => r.ok && r.ok.reserved.length === 1 && r.ok.reserved[0].status === 'pending'));
  });

  test('(b) create vs createAssignment on the same asset and overlapping time', async () => {
    let asset;
    const wd = world((f) => { asset = f.asset({ name: 'Race B' }); });
    const { p } = wd;
    const checkout = { assetId: asset.id, employeeId: p.e[1].id, actorAccountId: p.admin.id, actorIsAdmin: true, type: 'checkout', dueDate: d(1) };
    const raw = await oracleRace('b: create vs checkout', wd, asset.id, [
      createOp({ assetId: asset.id, employeeId: p.e[0].id, actorAccountId: p.acct[0].id, start: today, end: d(1) }),
      { pg: (q) => assignments.createAssignment(q, checkout), sq: (db) => sqliteAssignments.createAssignment(db, checkout) },
    ]);
    assert.equal(raw.filter((r) => r.ok).length, 1, 'exactly one of them got the time');
  });

  test('(c) two approvals of overlapping pending reservations: one approved, the other 409 and still pending', async () => {
    let asset; let r1; let r2;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Race C', reservation_requires_approval: 1 });
      r1 = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(3), end_date: d(4), status: 'pending' });
      r2 = f.reservation({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(4), end_date: d(5), status: 'pending' });
    });
    const by = { actorAccountId: wd.p.admin.id };
    const raw = await oracleRace('c: approve vs approve', wd, asset.id, [op('approve', r1.id, by), op('approve', r2.id, by)]);
    assert.equal(raw.filter((r) => r.ok).length, 1);
    const lost = raw.find((r) => r.error);
    assert.equal(lost.error.status, 409);
    assert.match(lost.error.message, /^Can't approve: It is already reserved/);
  });

  test('(d) approve vs cancel, cancel vs cancel, approve vs decline: the loser gets the status message (400), not "just updated"', async () => {
    const run = async (label, status, ops) => {
      let asset; let r;
      const wd = world((f, p) => {
        asset = f.asset({ name: `Race D ${label}`, reservation_requires_approval: 1 });
        r = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(6), status, ...(status === 'confirmed' ? { requires_approval: 1, decided_at: '2026-01-01 00:00:00' } : {}) });
      });
      const raw = await oracleRace(`d: ${label}`, wd, asset.id, ops(r, wd.p));
      for (const x of raw.filter((o) => o.error)) {
        assert.equal(x.error.status, 400, `${label}: the loser gets a status message (${x.error.message})`);
        assert.notEqual(x.error.message, 'This reservation was just updated by someone else. Reload and try again.');
      }
      return raw;
    };
    const own = (p) => ({ actorAccountId: p.acct[0].id, employeeId: p.e[0].id, isAdmin: false });
    // approve vs the employee's cancel: cancel first -> approve answers "This reservation was cancelled."; approve first -> the
    // employee then cancels the now confirmed reservation, and both succeed. Both are serial SQLite outcomes (oracle-checked).
    const r1 = await run('approve vs cancel', 'pending', (r, p) => [op('approve', r.id, { actorAccountId: p.admin.id }), op('cancel', r.id, own(p))]);
    assert.ok(r1[1].ok, 'the cancel always succeeds');
    if (r1[0].error) assert.equal(r1[0].error.message, 'This reservation was cancelled.');
    const r2 = await run('cancel vs cancel', 'confirmed', (r, p) => [op('cancel', r.id, own(p)), op('cancel', r.id, own(p))]);
    assert.deepEqual(r2.filter((x) => x.error).map((x) => x.error.message), ['This reservation is already closed.']);
    const r3 = await run('approve vs decline', 'pending', (r, p) => [op('approve', r.id, { actorAccountId: p.admin.id }), op('decline', r.id, { actorAccountId: p.admin.id })]);
    assert.deepEqual(r3.filter((x) => x.error).map((x) => x.error.message), ['This reservation has already been decided.']);
  });

  test('(e) two releases on one asset with people waiting: FIFO promotions, correct re-split, never the same time offered twice', async () => {
    let asset; let r1; let r2;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Race E' });
      r1 = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), end_date: d(6) });
      r2 = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(8), end_date: d(9) });
      f.entry({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(5), end_date: d(8), queue_seq: 1 }); // spans both
      f.entry({ asset_id: asset.id, employee_id: p.e[2].id, start_date: d(6), queue_seq: 2 });
      f.entry({ asset_id: asset.id, employee_id: p.e[3].id, start_date: d(9), queue_seq: 3 });
    });
    const own = { actorAccountId: wd.p.acct[0].id, employeeId: wd.p.e[0].id, isAdmin: false };
    await oracleRace('e: cancel vs cancel', wd, asset.id, [op('cancel', r1.id, own), op('cancel', r2.id, own)]);
    const held = (await pool.query("SELECT employee_id, start_date, end_date FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' ORDER BY start_date", [asset.id])).rows;
    assert.ok(held.length >= 2, 'the freed time was offered');
  });

  test('(e) three operations: cancel + shorten + a new create racing for the freed time (3! serial orders)', async () => {
    let asset; let r1; let r2;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Race E3' });
      r1 = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), end_date: d(6) });
      r2 = f.reservation({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(8), end_date: d(10) });
      f.entry({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(6), queue_seq: 1 });
      f.entry({ asset_id: asset.id, employee_id: p.e[2].id, start_date: d(9), end_date: d(10), queue_seq: 2 });
    });
    const { p } = wd;
    const own = { actorAccountId: p.acct[0].id, employeeId: p.e[0].id };
    await oracleRace('e: cancel + shorten + create', wd, asset.id, [
      op('cancel', r1.id, { ...own, isAdmin: false }),
      op('shorten', r2.id, { ...own, newEnd: d(8) }),
      createOp({ assetId: asset.id, employeeId: p.e[3].id, actorAccountId: p.acct[3].id, start: d(6), end: d(9) }),
    ]);
  });

  test('(f) different assets proceed independently: a held lock on A does not delay a write on B', async () => {
    let a; let b;
    const wd = world((f) => { a = f.asset({ name: 'Race F-A' }); b = f.asset({ name: 'Race F-B' }); });
    await wd.f.apply(pool);
    await syncSequences(pool);
    const blocker = await blockAsset(pool, a.id);
    let onA;
    try {
      onA = reservations.create(pool, { assetId: a.id, employeeId: wd.p.e[0].id, actorAccountId: wd.p.acct[0].id, start: d(3), end: d(3) });
      await waitFor(async () => (await lockWaiters(sampler)) >= 1, 'the write on A to wait');
      const onB = await reservations.create(pool, { assetId: b.id, employeeId: wd.p.e[1].id, actorAccountId: wd.p.acct[1].id, start: d(3), end: d(3) });
      assert.equal(onB.reserved[0].status, 'confirmed', 'B completed while A was locked');
      assert.equal(await lockWaiters(sampler), 1, 'A is still waiting');
    } finally {
      await blocker.release();
    }
    assert.equal((await onA).reserved[0].status, 'confirmed', 'A completed once released');
  });
});
