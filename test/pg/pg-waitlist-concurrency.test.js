// Concurrency of the Slice 4C waitlist actions and sweep (D-46, D-47), checked against the SERIAL-ORDER ORACLE (as in Slice 4B):
// each race runs 2-4 operations on one asset truly concurrently on PostgreSQL (all contenders are started while a third
// connection holds the asset lock, and released together once every one of them is queued on a lock), and the same operations
// run through the SQLite modules on a fresh reference with the same fixture in EVERY serial order. The PostgreSQL outcomes (per
// operation) and the asset's final rows (masked) must equal ONE of those serial SQLite outcomes. The PostgreSQL side runs with
// the Slice 5 notifier mapping (holds_owed -> dispatchHoldEmails), so the holds it grants are claimed like SQLite's. Fixture
// holds carry explicit past (lapsed) or far-future (live) stamps and hold_email_at, so nothing depends on the wall clock. On top
// of the oracle: no two live holds of one asset overlap, no two confirmed reservations overlap, queue_seq is distinct per asset,
// different assets never wait for each other, no deadlock, and the pool returns to baseline. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, createFixture, serialOracle, maskedRun, assertMatchesSerial, race, blockAsset, lockWaiters, waitFor, installHoldMailNotifier } = require('../../test-support/pg-write-support');
const sqliteMail = prepareSqliteMail();

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { syncSequences, FIXED } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const effects = require('../../src/pg/effects');
const sqliteReservations = require('../../src/reservations');
const sqliteWaitlist = require('../../src/waitlist');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');

const LAPSED = '2026-01-01 00:00:00';
const LIVE = '2999-12-31 00:00:00';

describe('PostgreSQL waitlist actions and sweep under concurrency (serial-order oracle)', pgSuite(), () => {
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
    effects.setNotifier(null);
    assert.equal(pool.waitingCount, 0, 'nobody is still waiting for a connection');
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    assert.equal(await lockWaiters(sampler), 0, 'no lock waiter left behind');
    console.log(`[oracle] ${report.join(' | ')}`);
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  // Racers e[0..3] (with accounts), a reserver and an IT account; `build(f, p)` adds the race's own asset and rows.
  function world(build) {
    const f = createFixture();
    const p = {};
    p.e = [1, 2, 3, 4].map((n) => f.employee({ name: `Racer ${n}` }));
    p.res = f.employee({ name: 'Reserver' });
    [...p.e, p.res].forEach((e) => { e.work_email = `wl${e.id}@example.com`; });
    p.acct = p.e.map((e) => f.account({ employee_id: e.id }));
    p.admin = f.account({ role: 'admin' });
    build(f, p);
    return { f, p };
  }
  const by = (p, i) => ({ employeeId: p.e[i].id, actorAccountId: p.acct[i].id });
  // a fixture hold: live (its email already went out) or lapsed
  const hold = (f, cols, expires = LIVE) => f.entry({ status: 'held', hold_expires_at: expires, hold_email_at: FIXED, ...cols });

  async function oracleRace(label, { f }, assetId, ops) {
    await f.apply(pool);
    await syncSequences(pool);
    const rec = installHoldMailNotifier(pool);
    let raw;
    try {
      raw = await race(pool, sampler, assetId, ops.map((op) => () => op.pg(pool)));
      await effects.whenIdle();
    } finally { rec.uninstall(); }
    const pgRun = await maskedRun(pool, raw, [assetId]);
    const serial = await serialOracle(f, [assetId], ops);
    const orders = assertMatchesSerial(pgRun, serial, label);
    const distinct = new Set(serial.map((s) => JSON.stringify({ outs: s.outs, state: s.state }))).size;
    report.push(`${label}: ${serial.length} orders, ${distinct} distinct, PG = ${orders.map((o) => o.join('')).join('/')}`);
    await assertInvariants(assetId);
    return raw;
  }
  async function assertInvariants(assetId) {
    const confirmed = (await pool.query("SELECT * FROM reservations WHERE asset_id = $1 AND status = 'confirmed'", [assetId])).rows;
    for (let i = 0; i < confirmed.length; i++) for (let j = i + 1; j < confirmed.length; j++) assert.ok(!T.overlapsRows(confirmed[i], confirmed[j]), `confirmed reservations ${confirmed[i].id} and ${confirmed[j].id} overlap`);
    const holds = (await pool.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' AND hold_expires_at > ${pgTime.NOW}`, [assetId])).rows;
    for (let i = 0; i < holds.length; i++) for (let j = i + 1; j < holds.length; j++) assert.ok(!T.overlapsRows(holds[i], holds[j]), `live holds ${holds[i].id} and ${holds[j].id} overlap (the same time offered twice)`);
    const seqs = (await pool.query('SELECT id, queue_seq, request_group FROM waitlist_entries WHERE asset_id = $1', [assetId])).rows;
    const bySeq = new Map();
    for (const r of seqs) { if (!bySeq.has(r.queue_seq)) bySeq.set(r.queue_seq, new Set()); bySeq.get(r.queue_seq).add(r.request_group); }
    for (const [seq, groups] of bySeq) assert.equal(groups.size, 1, `queue_seq ${seq} is shared only by pieces of one request`);
  }
  // Operation pairs. Outcomes that carry module-written ids are summarized so the oracle compares meaning, not ids.
  const wl = (fn, ...args) => ({ pg: (q) => waitlist[fn](q, ...args), sq: (db) => sqliteWaitlist[fn](db, ...args) });
  const confirmOp = (id, opts) => ({
    pg: async (q) => { const r = await waitlist.confirmHold(q, id, opts); return { entry: r.entry.status, reservation: r.reservation.status }; },
    sq: (db) => { const r = sqliteWaitlist.confirmHold(db, id, opts); return { entry: r.entry.status, reservation: r.reservation.status }; },
  });
  const sweepOp = { pg: async (q) => { await waitlist.sweep(q); return null; }, sq: (db) => { sqliteWaitlist.sweep(db); return null; } };
  const cancelOp = (id, opts) => ({ pg: (q) => reservations.cancel(q, id, opts), sq: (db) => sqliteReservations.cancel(db, id, opts) });

  test('(a) four simultaneous joins on one asset: distinct per-asset queue_seq, a serial order, FIFO afterwards', async () => {
    let asset; let r;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Join race' });
      r = f.reservation({ asset_id: asset.id, employee_id: p.res.id, start_date: d(3), end_date: d(8) });
    });
    const { p } = wd;
    const raw = await oracleRace('a: 4 joins', wd, asset.id, [
      wl('join', { assetId: asset.id, ...by(p, 0), start: d(4), end: d(4) }),
      wl('join', { assetId: asset.id, ...by(p, 1), start: d(4), end: d(5) }),
      wl('join', { assetId: asset.id, ...by(p, 2), start: d(5), end: d(5), startTime: '10:00', endTime: '12:00' }),
      wl('join', { assetId: asset.id, ...by(p, 3), start: d(3), end: d(6) }),
    ]);
    assert.ok(raw.every((x) => x.ok), 'everyone joined');
    const rows = (await pool.query('SELECT employee_id, queue_seq FROM waitlist_entries WHERE asset_id = $1 ORDER BY queue_seq', [asset.id])).rows;
    assert.deepEqual(rows.map((x) => x.queue_seq), [1, 2, 3, 4], 'distinct, per asset, gapless');
    // FIFO afterwards: the reservation is cancelled; the first in line is offered its time, overlapping later ones wait
    await reservations.cancel(pool, r.id, { employeeId: p.res.id, actorAccountId: null, isAdmin: false });
    const first = (await pool.query('SELECT status FROM waitlist_entries WHERE asset_id = $1 AND queue_seq = 1', [asset.id])).rows;
    assert.deepEqual(first.map((x) => x.status), ['held'], 'the oldest entry is offered first');
    await assertInvariants(asset.id);
  });

  test('(a) join vs join by the same person: the second is refused (own waitlist)', async () => {
    let asset;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Join twice' });
      f.reservation({ asset_id: asset.id, employee_id: p.res.id, start_date: d(3), end_date: d(8) });
    });
    const raw = await oracleRace('a: join vs join, same person', wd, asset.id, [
      wl('join', { assetId: asset.id, ...by(wd.p, 0), start: d(4), end: d(4) }),
      wl('join', { assetId: asset.id, ...by(wd.p, 0), start: d(4), end: d(5) }),
    ]);
    assert.deepEqual(raw.filter((x) => x.error).map((x) => x.error), [{ status: 409, message: "You're already on the waitlist for this item for overlapping dates." }]);
  });

  test('(b) confirmHold vs confirmHold: one reservation, the loser gets "already closed" (400)', async () => {
    let asset; let h;
    const wd = world((f, p) => { asset = f.asset({ name: 'Double confirm' }); h = hold(f, { asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 }); });
    const raw = await oracleRace('b: confirm vs confirm', wd, asset.id, [confirmOp(h.id, by(wd.p, 0)), confirmOp(h.id, by(wd.p, 0))]);
    assert.deepEqual(raw.filter((x) => x.error).map((x) => x.error), [{ status: 400, message: 'This waitlist entry is already closed.' }]);
    assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM reservations WHERE asset_id = $1', [asset.id])).rows[0].c), 1);
  });

  test('(c) confirmHold vs declineHold / leave by the same person', async () => {
    for (const other of ['declineHold', 'leave']) {
      let asset; let h;
      const wd = world((f, p) => {
        asset = f.asset({ name: `Confirm vs ${other}` });
        h = hold(f, { asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
        f.entry({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(5), queue_seq: 2 });
      });
      const raw = await oracleRace(`c: confirm vs ${other}`, wd, asset.id, [confirmOp(h.id, by(wd.p, 0)), wl(other, h.id, { ...by(wd.p, 0), isAdmin: false })]);
      assert.equal(raw.filter((x) => x.ok).length, 1, `${other}: exactly one wins`);
      assert.deepEqual(raw.find((x) => x.error).error, { status: 400, message: 'This waitlist entry is already closed.' });
    }
  });

  test('(d) confirmHold vs the sweep: a lapsed hold is 409 expired in both orders; a live hold is confirmed and the sweep is a no-op', async () => {
    let asset; let h;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Confirm vs sweep lapsed' });
      h = hold(f, { asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 }, LAPSED);
      f.entry({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(5), queue_seq: 2 });
    });
    const raw = await oracleRace('d: confirm vs sweep, lapsed', wd, asset.id, [confirmOp(h.id, by(wd.p, 0)), sweepOp]);
    assert.deepEqual(raw[0].error, { status: 409, message: 'This hold has expired. The item was offered to the next person in line.' });
    let a2; let h2;
    const wd2 = world((f, p) => {
      a2 = f.asset({ name: 'Confirm vs sweep live' });
      h2 = hold(f, { asset_id: a2.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a2.id, employee_id: p.e[1].id, start_date: d(5), queue_seq: 2 });
    });
    const raw2 = await oracleRace('d: confirm vs sweep, live', wd2, a2.id, [confirmOp(h2.id, by(wd2.p, 0)), sweepOp]);
    assert.deepEqual(raw2[0].ok, { entry: 'fulfilled', reservation: 'confirmed' });
  });

  test('(e) cancel (4B) vs join on the same asset', async () => {
    let asset; let r;
    const wd = world((f, p) => { asset = f.asset({ name: 'Cancel vs join' }); r = f.reservation({ asset_id: asset.id, employee_id: p.res.id, start_date: d(5) }); });
    await oracleRace('e: cancel vs join', wd, asset.id, [
      cancelOp(r.id, { employeeId: wd.p.res.id, actorAccountId: null, isAdmin: false }),
      wl('join', { assetId: asset.id, ...by(wd.p, 0), start: d(5), end: d(5) }),
    ]);
  });

  test('(f) leave vs leave (owner and IT), updateDates vs leave, updateDates vs a release that grants a hold', async () => {
    let asset; let e1;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Leave vs remove' });
      f.reservation({ asset_id: asset.id, employee_id: p.res.id, start_date: d(5), end_date: d(6) });
      e1 = f.entry({ asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
    });
    const raw = await oracleRace('f: leave vs IT remove', wd, asset.id, [
      wl('leave', e1.id, { ...by(wd.p, 0), isAdmin: false }), wl('leave', e1.id, { employeeId: null, actorAccountId: wd.p.admin.id, isAdmin: true }),
    ]);
    assert.deepEqual(raw.filter((x) => x.error).map((x) => x.error.message), ['This waitlist entry is already closed.']);
    let a2; let e2;
    const wd2 = world((f, p) => {
      a2 = f.asset({ name: 'Edit vs leave' });
      f.reservation({ asset_id: a2.id, employee_id: p.res.id, start_date: d(5), end_date: d(6) });
      e2 = f.entry({ asset_id: a2.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a2.id, employee_id: p.e[1].id, start_date: d(6), queue_seq: 2 });
    });
    await oracleRace('f: updateDates vs leave', wd2, a2.id, [
      wl('updateDates', e2.id, { ...by(wd2.p, 0), start: d(6), end: d(6) }), wl('leave', e2.id, { ...by(wd2.p, 0), isAdmin: false }),
    ]);
    let a3; let e3; let r3;
    const wd3 = world((f, p) => {
      a3 = f.asset({ name: 'Edit vs release' });
      r3 = f.reservation({ asset_id: a3.id, employee_id: p.res.id, start_date: d(5), end_date: d(6) });
      e3 = f.entry({ asset_id: a3.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a3.id, employee_id: p.e[1].id, start_date: d(6), queue_seq: 2 });
    });
    await oracleRace('f: updateDates vs cancel (grants holds)', wd3, a3.id, [
      wl('updateDates', e3.id, { ...by(wd3.p, 0), start: d(6), end: d(6) }), cancelOp(r3.id, { employeeId: wd3.p.res.id, actorAccountId: null, isAdmin: false }),
    ]);
  });

  test('(g) the sweep vs requests on the same asset; sweep vs sweep (no double offer); a three-way race', async () => {
    let asset;
    const wd = world((f, p) => {
      asset = f.asset({ name: 'Sweep vs join' });
      hold(f, { asset_id: asset.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 }, LAPSED);
      f.entry({ asset_id: asset.id, employee_id: p.e[1].id, start_date: d(5), queue_seq: 2 });
    });
    await oracleRace('g: sweep vs join (a lapsed hold)', wd, asset.id, [sweepOp, wl('join', { assetId: asset.id, ...by(wd.p, 2), start: d(5), end: d(5) })]);
    let a2; let h2;
    const wd2 = world((f, p) => {
      a2 = f.asset({ name: 'Sweep vs leave' });
      h2 = hold(f, { asset_id: a2.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a2.id, employee_id: p.e[1].id, start_date: d(5), queue_seq: 2 });
      hold(f, { asset_id: a2.id, employee_id: p.e[2].id, start_date: d(7), queue_seq: 3 }, LAPSED);
      f.entry({ asset_id: a2.id, employee_id: p.e[3].id, start_date: d(7), queue_seq: 4 });
    });
    await oracleRace('g: sweep vs leave', wd2, a2.id, [sweepOp, wl('leave', h2.id, { ...by(wd2.p, 0), isAdmin: false })]);
    let a3;
    const wd3 = world((f, p) => {
      a3 = f.asset({ name: 'Sweep vs sweep' });
      f.entry({ asset_id: a3.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a3.id, employee_id: p.e[1].id, start_date: d(5), end_date: d(6), queue_seq: 2 });
      hold(f, { asset_id: a3.id, employee_id: p.e[2].id, start_date: d(8), queue_seq: 3 }, LAPSED);
      f.entry({ asset_id: a3.id, employee_id: p.e[3].id, start_date: d(8), queue_seq: 4 });
    });
    await oracleRace('g: sweep vs sweep', wd3, a3.id, [sweepOp, sweepOp]);
    const offers = (await pool.query("SELECT subject_user_id, COUNT(*)::int n FROM activity WHERE asset_id = $1 AND action = 'waitlist_hold_started' GROUP BY subject_user_id", [a3.id])).rows;
    assert.ok(offers.every((o) => o.n === 1), 'nobody was offered the same time twice');
    let a4; let h4;
    const wd4 = world((f, p) => {
      a4 = f.asset({ name: 'Three-way' });
      h4 = hold(f, { asset_id: a4.id, employee_id: p.e[0].id, start_date: d(5), queue_seq: 1 });
      f.entry({ asset_id: a4.id, employee_id: p.e[1].id, start_date: d(5), end_date: d(6), queue_seq: 2 });
      f.reservation({ asset_id: a4.id, employee_id: p.res.id, start_date: d(6) });
    });
    await oracleRace('g: leave + join + sweep', wd4, a4.id, [
      wl('leave', h4.id, { ...by(wd4.p, 0), isAdmin: false }), wl('join', { assetId: a4.id, ...by(wd4.p, 2), start: d(5), end: d(6) }), sweepOp,
    ]);
  });

  test('(h) different assets proceed independently: a held lock on A does not delay a join or a confirm on B', async () => {
    let a; let b; let hb;
    const wd = world((f, p) => {
      a = f.asset({ name: 'Indep A' }); b = f.asset({ name: 'Indep B' });
      f.reservation({ asset_id: a.id, employee_id: p.res.id, start_date: d(3) });
      f.reservation({ asset_id: b.id, employee_id: p.res.id, start_date: d(3) });
      hb = hold(f, { asset_id: b.id, employee_id: p.e[2].id, start_date: d(9), queue_seq: 1 });
    });
    await wd.f.apply(pool);
    await syncSequences(pool);
    const blocker = await blockAsset(pool, a.id);
    let onA;
    try {
      onA = waitlist.join(pool, { assetId: a.id, ...by(wd.p, 0), start: d(3), end: d(3) });
      await waitFor(async () => (await lockWaiters(sampler)) >= 1, 'the join on A to wait');
      const onB = await waitlist.join(pool, { assetId: b.id, ...by(wd.p, 1), start: d(3), end: d(3) });
      assert.equal(onB.entry.status, 'waiting', 'B completed while A was locked');
      const conf = await waitlist.confirmHold(pool, hb.id, by(wd.p, 2));
      assert.equal(conf.reservation.status, 'confirmed');
      assert.equal(await lockWaiters(sampler), 1, 'A is still waiting');
    } finally {
      await blocker.release();
    }
    assert.equal((await onA).entry.status, 'waiting', 'A completed once released');
  });
});
