// src/pg/reservations.js writes + src/pg/waitlist.js evaluateAsset (D-46, D-47, Slice 4B). Every scenario is built identically
// on PostgreSQL and on the SQLite reference (pg-twin, same ids; sequences synced so module-written rows get the same ids too)
// and run through BOTH the SQLite module (src/reservations.js / src/waitlist.js) and its src/pg twin. The outcome (value or
// {status, message}) and the asset's whole resulting state (reservations, waitlist entries, activity, assignments, asset
// status) must be deep-equal after masking only what the two clocks / generators legitimately differ in (stamps, request_group
// UUIDs -> G1.., queue_seq -> rank within the asset). Ports the write-path scenarios of test/reservations.test.js,
// test/reservation-times.test.js, test/partial-fulfillment.test.js and test/waitlist.test.js (create / approve / decline /
// cancel / shorten / evaluateAsset), plus PG-only checks: response tiers, the compare-and-set 409 against a writer that skips
// the lock, rollback at the last write, and FK failures. Deterministic: dates are days ahead of the database's today, holds
// +/- 6 hours from the database clock, APP_TIMEZONE=UTC; the tier tests skip (with a message) within 15 minutes of UTC
// midnight. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, mask, groupNamer, dumpAsset, outcome } = require('../../test-support/pg-write-support');
const sqliteMail = prepareSqliteMail();

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const effects = require('../../src/pg/effects');
const sqliteReservations = require('../../src/reservations');
const sqliteWaitlist = require('../../src/waitlist');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');

const HOURS6 = 6 * 3600;
const STAMP_SECONDS = (s) => Date.parse(`${s.replace(' ', 'T')}Z`) / 1000;

describe('PostgreSQL reservation writes + queue engine (differential against src/reservations.js / src/waitlist.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Asker', department: 'Ops', work_email: 'ana@example.com' });
    w.ben = await tw.employee({ name: 'Ben Booker', work_email: 'ben@example.com' });
    w.cy = await tw.employee({ name: 'Cy Inactive', status: 'inactive' });
    w.dee = await tw.employee({ name: 'Dee Third', work_email: 'dee@example.com' });
    w.anaAcct = await tw.insert('accounts', { login_email: 'ana.login@example.com', role: 'employee', employee_id: w.ana.id });
    w.benAcct = await tw.insert('accounts', { login_email: 'ben.login@example.com', role: 'employee', employee_id: w.ben.id });
    w.admin = await tw.insert('accounts', { login_email: 'it@example.com', role: 'admin' });
  });
  after(async () => {
    effects.setNotifier(null);
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0, 'nobody is still waiting for a connection');
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    tw?.close();
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  const req = (cols = {}) => tw.asset({ available_to_request: 1, ...cols });
  // One differential step: same call on both engines, same outcome, same resulting state of `assetIds`.
  async function same(label, pgFn, sqFn, assetIds) {
    await tw.syncSequences();
    const pgRaw = await outcome(() => pgFn(pool));
    const sqRaw = await outcome(() => sqFn(tw.sqlite));
    const gp = groupNamer(); const gs = groupNamer();
    const pg = { out: mask(pgRaw, { group: gp }), state: [] };
    const sq = { out: mask(sqRaw, { group: gs }), state: [] };
    for (const id of assetIds) {
      pg.state.push(await dumpAsset(pool, id, { group: gp }));
      sq.state.push(await dumpAsset(tw.sq, id, { group: gs }));
    }
    assert.deepEqual(pg, sq, label);
    return pgRaw;
  }
  const create = (label, args, assetIds = [args.assetId]) => same(`create: ${label}`, (q) => reservations.create(q, args), (db) => sqliteReservations.create(db, args), assetIds);
  const call = (fn, label, id, opts, assetIds) => same(`${fn}: ${label}`, (q) => reservations[fn](q, id, opts), (db) => sqliteReservations[fn](db, id, opts), assetIds);
  const evaluate = (label, assetId) => same(`evaluateAsset: ${label}`,
    (q) => withTransaction(async (c) => { await lockAsset(c, assetId); return waitlist.evaluateAsset(c, assetId); }, q),
    (db) => sqliteWaitlist.evaluateAsset(db, assetId), [assetId]);
  const ana = () => ({ employeeId: w.ana.id, actorAccountId: w.anaAcct.id });

  test('create: reserve, pending, waitlist refusal, partial split, adjacency and every refusal are identical', async () => {
    const free = await req({ name: 'Free' });
    const r1 = await create('all free -> confirmed', { assetId: free.id, ...ana(), start: d(3), end: d(4) });
    assert.equal(r1.ok.reserved[0].status, 'confirmed');
    const appr = await req({ name: 'Approval', reservation_requires_approval: 1 });
    const r2 = await create('all free, approval ON -> pending', { assetId: appr.id, ...ana(), start: d(3), end: d(3), startTime: '09:00', endTime: '11:00' });
    assert.equal(r2.ok.reserved[0].status, 'pending');
    const taken = await req({ name: 'Taken' });
    await tw.reservation({ asset_id: taken.id, employee_id: w.ben.id, start_date: d(3), end_date: d(5) });
    const r3 = await create('all unavailable -> 409 join the waitlist', { assetId: taken.id, ...ana(), start: d(4), end: d(4) });
    assert.equal(r3.error.status, 409);
    assert.match(r3.error.message, /Join the waitlist for that time instead\.$/);
    const timed = await req({ name: 'Timed' });
    await tw.reservation({ asset_id: timed.id, employee_id: w.ben.id, start_date: d(3), start_time: '08:00', end_time: '13:00' });
    const r4 = await create('partial 6-15 around 8-13 -> two reserved + one waitlisted, one request group', { assetId: timed.id, ...ana(), start: d(3), end: d(3), startTime: '06:00', endTime: '15:00' });
    assert.deepEqual([r4.ok.reserved.length, r4.ok.waitlisted.length], [2, 1]);
    assert.ok([...r4.ok.reserved, ...r4.ok.waitlisted].every((x) => x.request_group === r4.ok.request_group));
    await create('adjacent 13-17 after 8-13 -> reservation only', { assetId: timed.id, employeeId: w.dee.id, actorAccountId: w.admin.id, start: d(3), end: d(3), startTime: '13:00', endTime: '17:00' });
    const t2 = await req({ name: 'Timed 2' });
    await tw.reservation({ asset_id: t2.id, employee_id: w.ben.id, start_date: d(3), start_time: '08:00', end_time: '13:00' });
    const r6 = await create('12-14 vs 8-13 -> 12-13 waitlisted, 13-14 reserved', { assetId: t2.id, ...ana(), start: d(3), end: d(3), startTime: '12:00', endTime: '14:00' });
    assert.deepEqual([r6.ok.waitlisted[0].start_time, r6.ok.waitlisted[0].end_time, r6.ok.reserved[0].start_time, r6.ok.reserved[0].end_time], ['12:00', '13:00', '13:00', '14:00']);
    const days = await req({ name: 'Days' });
    await tw.reservation({ asset_id: days.id, employee_id: w.ben.id, start_date: d(5) });
    await tw.reservation({ asset_id: days.id, employee_id: w.dee.id, start_date: d(7) });
    await tw.reservation({ asset_id: days.id, employee_id: w.ben.id, start_date: d(9) });
    await create('date-only d4-d9 around three days of two reservers', { assetId: days.id, ...ana(), start: d(4), end: d(9) });
    const kinds = await req({ name: 'Blocker kinds' });
    const born = await tw.entry({ asset_id: kinds.id, employee_id: w.ben.id, start_date: d(4), status: 'fulfilled', queue_seq: 1 });
    await tw.reservation({ asset_id: kinds.id, employee_id: w.ben.id, start_date: d(4), status: 'pending', waitlist_entry_id: born.id });
    await tw.entry({ asset_id: kinds.id, employee_id: w.dee.id, start_date: d(6), status: 'held', hold_expires_at: await tw.stamp(HOURS6), queue_seq: 2 });
    await tw.entry({ asset_id: kinds.id, employee_id: w.dee.id, start_date: d(8), status: 'held', hold_expires_at: await tw.stamp(-HOURS6), queue_seq: 3 });
    await tw.entry({ asset_id: kinds.id, employee_id: w.dee.id, start_date: d(5), queue_seq: 4 });
    await tw.reservation({ asset_id: kinds.id, employee_id: w.dee.id, start_date: d(5), status: 'pending' });
    await create('a waitlist-born pending + an active hold block; an expired hold, a waiting entry, an ordinary pending do not', { assetId: kinds.id, ...ana(), start: d(3), end: d(9) });
    const out = await req({ name: 'Checked out', status: 'checked_out' });
    await tw.checkout({ asset_id: out.id, employee_id: w.ben.id, due_date: d(4), due_time: '13:00' });
    await create('checkout until d4 1 PM: pickup at 1 PM is free', { assetId: out.id, ...ana(), start: d(4), end: d(5), startTime: '13:00' });
    await create('checkout until d4 1 PM: d3-d5 is split at the due time', { assetId: out.id, employeeId: w.dee.id, actorAccountId: w.admin.id, start: d(3), end: d(6) });
  });

  test('create: every refusal is identical (status, message, nothing written)', async () => {
    const free = await req({ name: 'Refusals' });
    const own = await req({ name: 'Own rows' });
    await tw.reservation({ asset_id: own.id, employee_id: w.ana.id, start_date: d(3), start_time: '08:00', end_time: '12:00' });
    await tw.entry({ asset_id: own.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), queue_seq: 1 });
    await tw.entry({ asset_id: own.id, employee_id: w.ana.id, start_date: d(8), queue_seq: 2 });
    await tw.reservation({ asset_id: own.id, employee_id: w.ben.id, start_date: d(8) });
    const hidden = await tw.asset({ name: 'Hidden' });
    const archived = await req({ name: 'Archived', archived_at: '2026-01-01 00:00:00' });
    const repair = await req({ name: 'Repair', status: 'maintenance' });
    const seats = await req({ name: 'Seats', license_seats: 3 });
    const base = { ...ana(), start: d(3), end: d(3) };
    const cases = [
      ['hidden asset', { ...base, assetId: hidden.id }], ['unknown asset', { ...base, assetId: 999999 }], ['garbage asset id', { ...base, assetId: 'abc' }],
      ['asset id 0', { ...base, assetId: 0 }], ['asset id out of range', { ...base, assetId: 2 ** 40 }], ['archived', { ...base, assetId: archived.id }],
      ['repair', { ...base, assetId: repair.id }], ['multi-seat', { ...base, assetId: seats.id }], ['no employee', { ...base, assetId: free.id, employeeId: null }],
      ['inactive employee', { ...base, assetId: free.id, employeeId: w.cy.id }], ['no dates', { assetId: free.id, ...ana() }],
      ['end before start', { ...base, assetId: free.id, end: d(2) }], ['past start', { ...base, assetId: free.id, start: d(-1) }],
      ['after 2100', { ...base, assetId: free.id, end: '2101-01-01' }], ['bad time', { ...base, assetId: free.id, startTime: '7am' }],
      ['return before pickup', { ...base, assetId: free.id, startTime: '14:00', endTime: '13:00' }],
      ['own reservation overlap', { ...base, assetId: own.id, startTime: '11:00' }], ['own hold', { ...base, assetId: own.id, start: d(5), end: d(5) }],
      ['own waitlist', { ...base, assetId: own.id, start: d(8), end: d(8) }],
    ];
    for (const [label, args] of cases) {
      const r = await create(label, args, [free.id, own.id]);
      assert.ok(r.error, `${label} is refused`);
    }
    assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM reservations WHERE asset_id = $1', [free.id])).rows[0].c), 0);
  });

  test('approve: success, every error branch, the whole-range re-check (identical)', async () => {
    const a = await req({ name: 'Approve', reservation_requires_approval: 1 });
    const p1 = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(10), status: 'pending' });
    const p1b = await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(10), status: 'pending' }); // overlapping ordinary pending: allowed
    const ok = await call('approve', 'pending -> confirmed, with a note', p1.id, { actorAccountId: w.admin.id, note: 'Enjoy' }, [a.id]);
    assert.equal(ok.ok.status, 'confirmed');
    const blocked = await call('approve', 'the overlapping pending one is now blocked: 409, stays pending', p1b.id, { actorAccountId: w.admin.id }, [a.id]);
    assert.equal(blocked.error.status, 409);
    await call('approve', 'already decided', p1.id, { actorAccountId: w.admin.id }, [a.id]);
    const cancelled = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(12), status: 'cancelled' });
    await call('approve', 'cancelled', cancelled.id, { actorAccountId: w.admin.id }, [a.id]);
    const declined = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(12), status: 'declined' });
    await call('approve', 'declined', declined.id, { actorAccountId: w.admin.id }, [a.id]);
    for (const id of [999999, 'abc', null]) await call('approve', `unknown id ${id}`, id, { actorAccountId: w.admin.id }, [a.id]);
    const inactive = await tw.reservation({ asset_id: a.id, employee_id: w.cy.id, start_date: d(14), status: 'pending' });
    await call('approve', 'inactive person', inactive.id, { actorAccountId: w.admin.id }, [a.id]);
    const started = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(-1), end_date: d(1), status: 'pending' });
    await call('approve', 'start passed', started.id, { actorAccountId: w.admin.id }, [a.id]);
    const arch = await req({ name: 'Archived since', reservation_requires_approval: 1, archived_at: '2026-01-01 00:00:00' });
    const pa = await tw.reservation({ asset_id: arch.id, employee_id: w.ana.id, start_date: d(5), status: 'pending' });
    await call('approve', 'asset archived since', pa.id, { actorAccountId: w.admin.id }, [arch.id]);
    const hid = await tw.asset({ name: 'Hidden since', reservation_requires_approval: 1 });
    const ph = await tw.reservation({ asset_id: hid.id, employee_id: w.ana.id, start_date: d(5), status: 'pending' });
    await call('approve', 'asset no longer requestable', ph.id, { actorAccountId: w.admin.id }, [hid.id]);
    const co = await req({ name: 'Checked out since', reservation_requires_approval: 1, status: 'checked_out' });
    await tw.checkout({ asset_id: co.id, employee_id: w.ben.id, due_date: d(6), due_time: '10:00' });
    const pco = await tw.reservation({ asset_id: co.id, employee_id: w.ana.id, start_date: d(6), status: 'pending' });
    await call('approve', 'a checkout now covers the start', pco.id, { actorAccountId: w.admin.id }, [co.id]);
    const after = await tw.reservation({ asset_id: co.id, employee_id: w.ana.id, start_date: d(6), start_time: '10:00', status: 'pending' });
    await call('approve', 'a pickup at the due time is fine', after.id, { actorAccountId: w.admin.id }, [co.id]);
  });

  test('decline: success, errors, and a declined waitlist-born reservation gives its dates back to the queue (identical)', async () => {
    const a = await req({ name: 'Decline', reservation_requires_approval: 1 });
    const p = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(10), status: 'pending' });
    await call('decline', 'pending -> declined, with a note', p.id, { actorAccountId: w.admin.id, note: 'Not this week' }, [a.id]);
    await call('decline', 'twice', p.id, { actorAccountId: w.admin.id }, [a.id]);
    const conf = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(11) });
    await call('decline', 'a confirmed one', conf.id, { actorAccountId: w.admin.id }, [a.id]);
    const born = await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(12), status: 'fulfilled', queue_seq: 1 });
    const bp = await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(12), status: 'pending', waitlist_entry_id: born.id });
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(12), queue_seq: 2 });
    const r = await call('decline', 'waitlist-born pending: the next waiter is offered the dates', bp.id, { actorAccountId: w.admin.id }, [a.id]);
    assert.equal(r.ok.status, 'declined');
    const held = (await pool.query("SELECT employee_id FROM waitlist_entries WHERE asset_id = $1 AND status = 'held'", [a.id])).rows;
    assert.deepEqual(held.map((h) => h.employee_id), [w.dee.id]);
  });

  test('cancel: own / other / IT on confirmed / IT on pending / closed / over, and the queue moves (identical)', async () => {
    const a = await req({ name: 'Cancel' });
    const mine = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), end_date: d(6) });
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(5), queue_seq: 1 });
    await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(4), end_date: d(6), queue_seq: 2 });
    await call('cancel', "someone else's", mine.id, { actorAccountId: w.benAcct.id, employeeId: w.ben.id, isAdmin: false }, [a.id]);
    const r = await call('cancel', 'own confirmed: cancelled, the line is re-split and offered FIFO', mine.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, isAdmin: false }, [a.id]);
    assert.equal(r.ok.status, 'cancelled');
    await call('cancel', 'already closed', mine.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, isAdmin: false }, [a.id]);
    const other = await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(20) });
    await call('cancel', 'IT cancels a confirmed one (· cancelled by IT)', other.id, { actorAccountId: w.admin.id, employeeId: null, isAdmin: true }, [a.id]);
    const pend = await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(21), status: 'pending' });
    await call('cancel', 'IT on a pending one -> decline it instead', pend.id, { actorAccountId: w.admin.id, employeeId: null, isAdmin: true }, [a.id]);
    await call('cancel', 'the employee withdraws their own pending one', pend.id, { actorAccountId: w.benAcct.id, employeeId: w.ben.id, isAdmin: false }, [a.id]);
    const over = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(-3), end_date: d(-1) });
    await call('cancel', 'already over', over.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, isAdmin: false }, [a.id]);
    const itOwn = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(22) });
    await call('cancel', 'an admin who is the holder (no "by IT")', itOwn.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, isAdmin: true }, [a.id]);
    await call('cancel', 'unknown', 999999, { actorAccountId: w.admin.id, employeeId: null, isAdmin: true }, [a.id]);
  });

  test('shorten: every branch incl. NULL / non-NULL end_time guards, and the freed time is offered (identical)', async () => {
    const a = await req({ name: 'Shorten' });
    const r = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), end_date: d(7) });
    const by = { actorAccountId: w.anaAcct.id, employeeId: w.ana.id };
    await call('shorten', 'same end', r.id, { ...by, newEnd: d(7) }, [a.id]);
    await call('shorten', 'later', r.id, { ...by, newEnd: d(8) }, [a.id]);
    await call('shorten', 'before the start', r.id, { ...by, newEnd: d(4) }, [a.id]);
    await call('shorten', 'invalid date', r.id, { ...by, newEnd: '2026-02-30' }, [a.id]);
    await call('shorten', 'invalid time (checked before the reservation is read)', 999999, { ...by, newEndTime: '25:00' }, [a.id]);
    await call('shorten', "someone else's", r.id, { actorAccountId: w.benAcct.id, employeeId: w.ben.id, newEnd: d(6) }, [a.id]);
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(7), queue_seq: 1 });
    await call('shorten', 'earlier date (NULL end_time): d7 freed and offered', r.id, { ...by, newEnd: d(6) }, [a.id]);
    await call('shorten', 'earlier time on a date-only end: return 13:00', r.id, { ...by, newEndTime: '13:00' }, [a.id]);
    await call('shorten', 'earlier time again (non-NULL end_time guard)', r.id, { ...by, newEndTime: '09:30' }, [a.id]);
    await call('shorten', 'same date and time', r.id, { ...by, newEndTime: '09:30' }, [a.id]);
    const timed = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(10), start_time: '09:00', end_time: '17:00' });
    await call('shorten', 'at the pickup', timed.id, { ...by, newEndTime: '09:00' }, [a.id]);
    await call('shorten', 'timed: later time', timed.id, { ...by, newEndTime: '18:00' }, [a.id]);
    await call('shorten', 'timed: earlier', timed.id, { ...by, newEndTime: '12:00' }, [a.id]);
    const running = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(-2), end_date: d(3) });
    await call('shorten', 'into the past', running.id, { ...by, newEnd: d(-1) }, [a.id]);
    await call('shorten', 'running: to today', running.id, { ...by, newEnd: today }, [a.id]);
    const pend = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(30), status: 'pending' });
    await call('shorten', 'pending', pend.id, { ...by, newEnd: d(30) }, [a.id]);
    const closed = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(31), status: 'cancelled' });
    await call('shorten', 'closed', closed.id, { ...by, newEnd: d(31) }, [a.id]);
    const over = await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(-5), end_date: d(-2) });
    await call('shorten', 'already over', over.id, { ...by, newEnd: d(-3) }, [a.id]);
  });

  test('evaluateAsset: whole / partial / multi-piece offers, FIFO, ties by id, skips and closes (identical)', async () => {
    const lapsed = await tw.stamp(-HOURS6); const live = await tw.stamp(HOURS6);
    const whole = await req({ name: 'Q whole' });
    await tw.entry({ asset_id: whole.id, employee_id: w.ana.id, start_date: d(5), end_date: d(6), queue_seq: 1 });
    await evaluate('whole range free: offered whole', whole.id);
    await evaluate('again: nothing new (no double offer)', whole.id);
    const part = await req({ name: 'Q partial' });
    await tw.reservation({ asset_id: part.id, employee_id: w.ben.id, start_date: d(6), start_time: '08:00', end_time: '12:00' });
    await tw.entry({ asset_id: part.id, employee_id: w.ana.id, start_date: d(6), queue_seq: 1, queued_at: '2026-02-01 00:00:00', request_group: 'rg-part' });
    await evaluate('two free pieces + one busy piece keep the place in line', part.id);
    const fifo = await req({ name: 'Q FIFO' });
    await tw.reservation({ asset_id: fifo.id, employee_id: w.ben.id, start_date: d(7) });
    await tw.entry({ asset_id: fifo.id, employee_id: w.ana.id, start_date: d(7), queue_seq: 1 }); // older, blocked
    await tw.entry({ asset_id: fifo.id, employee_id: w.dee.id, start_date: d(8), queue_seq: 2 }); // younger, free
    await tw.entry({ asset_id: fifo.id, employee_id: w.ben.id, start_date: d(8), end_date: d(9), queue_seq: 3 }); // overlaps dee's: served after
    await evaluate('an older blocked entry does not hold up a younger one; overlapping entries FIFO', fifo.id);
    const order = await req({ name: 'Q order' });
    await tw.entry({ asset_id: order.id, employee_id: w.dee.id, start_date: d(9), queue_seq: 20 }); // lower id, later in line
    await tw.entry({ asset_id: order.id, employee_id: w.ana.id, start_date: d(9), queue_seq: 10 }); // higher id, earlier in line
    await tw.entry({ asset_id: order.id, employee_id: w.ben.id, start_date: d(10), queue_seq: 30 });
    await tw.entry({ asset_id: order.id, employee_id: w.dee.id, start_date: d(10), queue_seq: 30 }); // tie: lower id first
    await evaluate('queue_seq decides, not id; queue_seq ties by id', order.id);
    const ag = (await pool.query("SELECT employee_id, start_date FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' ORDER BY start_date", [order.id])).rows;
    assert.deepEqual(ag.map((x) => x.employee_id), [w.ana.id, w.ben.id]);
    const closes = await req({ name: 'Q closes' });
    await tw.entry({ asset_id: closes.id, employee_id: w.ana.id, start_date: d(4), status: 'held', hold_expires_at: lapsed, queue_seq: 1 });
    await tw.entry({ asset_id: closes.id, employee_id: w.dee.id, start_date: d(-2), queue_seq: 2 });
    await tw.entry({ asset_id: closes.id, employee_id: w.ben.id, start_date: d(4), queue_seq: 3 });
    await tw.entry({ asset_id: closes.id, employee_id: w.cy.id, start_date: d(5), queue_seq: 4 }); // inactive: skipped
    await tw.entry({ asset_id: closes.id, employee_id: w.dee.id, start_date: d(6), status: 'held', hold_expires_at: live, queue_seq: 5 });
    await tw.entry({ asset_id: closes.id, employee_id: w.ana.id, start_date: d(6), queue_seq: 6 }); // blocked by dee's live hold
    await tw.reservation({ asset_id: closes.id, employee_id: w.ana.id, start_date: d(8) });
    await tw.entry({ asset_id: closes.id, employee_id: w.ana.id, start_date: d(8), queue_seq: 7 }); // own reservation: skipped
    await evaluate('lapsed hold and passed dates closed; the freed time goes to the next eligible entry', closes.id);
    const inel = await req({ name: 'Q ineligible', status: 'maintenance' });
    await tw.entry({ asset_id: inel.id, employee_id: w.ana.id, start_date: d(5), queue_seq: 1 });
    await evaluate('ineligible asset: nothing offered', inel.id);
  });

  test('evaluateAsset: an entry whose interval has ended today is closed (identical)', async (t) => {
    const nowKey = T.nowKey();
    if (nowKey.slice(11) < '00:16' || nowKey.slice(0, 10) !== today) return t.skip('within 15 minutes of UTC midnight (or the clocks disagree on the date): the "time has passed" case needs a minute of today behind us');
    const a = await req({ name: 'Q ended' });
    await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: today, start_time: '00:00', end_time: '00:01', queue_seq: 1 });
    await evaluate('the time has passed', a.id);
    assert.equal((await pool.query('SELECT status FROM waitlist_entries WHERE asset_id = $1', [a.id])).rows[0].status, 'expired');
  });

  // ---- PostgreSQL-only checks

  test('response tiers: 24 h / 2 h / 30 min by how soon the piece starts, capped at the end of the interval', async (t) => {
    const now = Date.now();
    const keyAt = (ms) => T.nowKey(new Date(ms));
    const startOfUtcDay = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    if (now - startOfUtcDay < 15 * 60e3 || startOfUtcDay + 864e5 - now < 15 * 60e3) return t.skip('within 15 minutes of UTC midnight: tier margins cannot be guaranteed');
    const held = async (start, end, label) => {
      const a = await req({ name: `Tier ${label}` });
      await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: start.slice(0, 10), start_time: start.slice(11) === '00:00' ? null : start.slice(11), end_date: end.slice(0, 10), end_time: end.slice(11), queue_seq: 1 });
      await tw.syncSequences();
      await withTransaction(async (c) => { await lockAsset(c, a.id); await waitlist.evaluateAsset(c, a.id); }, pool);
      const row = (await pool.query("SELECT hold_started_at, hold_expires_at FROM waitlist_entries WHERE asset_id = $1 AND status = 'held'", [a.id])).rows[0];
      assert.ok(row, `${label}: a hold was granted`);
      return STAMP_SECONDS(row.hold_expires_at) - STAMP_SECONDS(row.hold_started_at);
    };
    assert.equal(await held(`${d(3)}T09:00`, `${d(3)}T17:00`, '24h'), 24 * 3600, 'starts more than 24 h away');
    assert.equal(await held(keyAt(now + 10 * 3600e3), keyAt(now + 14 * 3600e3), '2h'), 2 * 3600, 'starts 4-24 h away');
    assert.equal(await held(keyAt(now + 3600e3), keyAt(now + 3 * 3600e3), '30m'), 30 * 60, 'starts within 4 h');
    if (keyAt(now + 11 * 60e3).slice(0, 10) === keyAt(now).slice(0, 10)) {
      const endKey = keyAt(now + 11 * 60e3);
      const secs = await held(keyAt(now), endKey, 'capped');
      const expected = (Date.parse(`${endKey}:00Z`) - Date.now()) / 1000;
      assert.ok(Math.abs(secs - expected) <= 3, `capped at the end of the interval (${secs}s vs ~${Math.round(expected)}s)`);
      assert.ok(secs < 30 * 60);
    }
  });

  test('the compare-and-set guards still answer 409 against a writer that skips the asset lock (defense in depth)', async () => {
    const a = await req({ name: 'CAS', reservation_requires_approval: 1 });
    let day = 40;
    await tw.syncSequences();
    // a client whose next matching UPDATE is preceded by a non-locking writer on another connection
    const sneak = async (pattern, sneakSql, id, run) => withTransaction(async (c) => {
      const original = c.query;
      let done = false;
      c.query = async function q(text, params) {
        if (!done && typeof text === 'string' && pattern.test(text)) { done = true; await pool.query(sneakSql, [id]); }
        return original.call(this, text, params);
      };
      try { return await run(c); } finally { c.query = original; }
    }, pool).then((v) => ({ ok: v }), (e) => ({ status: e.status, message: e.message }));
    const SNEAK_CANCEL = "UPDATE reservations SET status = 'cancelled', cancelled_at = '2026-01-01 00:00:00' WHERE id = $1";
    const JUST = { status: 409, message: 'This reservation was just updated by someone else. Reload and try again.' };
    const p1 = await fx(a, 'pending');
    assert.deepEqual(await sneak(/^UPDATE reservations SET status = 'confirmed'/, SNEAK_CANCEL, p1.id, (c) => reservations.approve(c, p1.id, { actorAccountId: w.admin.id })), JUST);
    const p2 = await fx(a, 'pending');
    assert.deepEqual(await sneak(/^UPDATE reservations SET status = 'declined'/, SNEAK_CANCEL, p2.id, (c) => reservations.decline(c, p2.id, { actorAccountId: w.admin.id })), JUST);
    const c1 = await fx(a, 'confirmed');
    assert.deepEqual(await sneak(/^UPDATE reservations SET status = 'cancelled'/, SNEAK_CANCEL, c1.id, (c) => reservations.cancel(c, c1.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id })), JUST);
    const c2 = await fx(a, 'confirmed');
    assert.deepEqual(await sneak(/^UPDATE reservations SET end_date/, "UPDATE reservations SET end_time = '15:00' WHERE id = $1", c2.id, (c) => reservations.shorten(c, c2.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, newEndTime: '16:00' })), JUST);
    const after = (await pool.query('SELECT id, status, end_time FROM reservations WHERE id = ANY($1::int[]) ORDER BY id', [[p1.id, p2.id, c1.id, c2.id]])).rows;
    assert.deepEqual(after.map((r) => r.status), ['cancelled', 'cancelled', 'cancelled', 'confirmed'], 'only the sneaky writes landed');
    assert.equal(after[3].end_time, '15:00');
    // (an approval asset: pending rows, and confirmed rows that were decided; each on its own day)
    async function fx(asset, status) {
      return (await pool.query('INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval, decided_at) VALUES ($1, $2, $3, $3, $4, 1, $5) RETURNING *',
        [asset.id, w.ana.id, d(day++), status, status === 'pending' ? null : '2026-01-01 00:00:00'])).rows[0];
    }
  });

  test('rollback: a failure at the LAST write of create / cancel / shorten leaves nothing behind and fires no effect', async () => {
    const fired = [];
    effects.setNotifier((e) => { fired.push(e); });
    await pool.query("CREATE OR REPLACE FUNCTION nc_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    let n = 0;
    const failOn = async (assetId, action, details) => {
      const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const name = `nc_fail_${++n}`;
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON activity FOR EACH ROW WHEN (NEW.asset_id = ${Number(assetId)} AND NEW.action = ${lit(action)} AND NEW.details = ${lit(details)}) EXECUTE FUNCTION nc_test_fail()`);
      return () => pool.query(`DROP TRIGGER ${name} ON activity`);
    };
    const snapshot = async (assetId) => ({
      r: (await pool.query('SELECT id, status, end_date, end_time FROM reservations WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      w: (await pool.query('SELECT id, status, start_date, start_time, end_date, end_time, hold_expires_at FROM waitlist_entries WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      a: (await pool.query('SELECT id FROM activity WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      s: (await pool.query('SELECT status, updated_at FROM assets WHERE id = $1', [assetId])).rows,
    });
    // create: reserve 6-8 and 13-15, waitlist 8-13 (the last write is the waitlist_joined note)
    const a = await req({ name: 'Rollback create' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(3), start_time: '08:00', end_time: '13:00' });
    await tw.syncSequences();
    let drop = await failOn(a.id, 'waitlist_joined', T.when({ start_date: d(3), start_time: '08:00', end_date: d(3), end_time: '13:00' }));
    let before = await snapshot(a.id);
    await assert.rejects(reservations.create(pool, { assetId: a.id, ...ana(), start: d(3), end: d(3), startTime: '06:00', endTime: '15:00' }), /injected failure/);
    assert.deepEqual(await snapshot(a.id), before, 'create: nothing written');
    await drop();
    // cancel: frees d5 for two waiters (the last write is the second waitlist_hold_started note)
    const b = await req({ name: 'Rollback cancel' });
    const rb = await tw.reservation({ asset_id: b.id, employee_id: w.ana.id, start_date: d(5), end_date: d(6) });
    await tw.entry({ asset_id: b.id, employee_id: w.dee.id, start_date: d(5), queue_seq: 1 });
    await tw.entry({ asset_id: b.id, employee_id: w.ben.id, start_date: d(6), queue_seq: 2 });
    await tw.syncSequences();
    // (hold notes carry a clock stamp in their details, so the trigger matches the last write's action and employee instead)
    const name = `nc_fail_${++n}`;
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON activity FOR EACH ROW WHEN (NEW.asset_id = ${b.id} AND NEW.action = 'waitlist_hold_started' AND NEW.subject_user_id = ${w.ben.id}) EXECUTE FUNCTION nc_test_fail()`);
    before = await snapshot(b.id);
    await assert.rejects(reservations.cancel(pool, rb.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id }), /injected failure/);
    assert.deepEqual(await snapshot(b.id), before, 'cancel: still confirmed, nobody held, no activity');
    // shorten on the same asset: frees d6 (the last write is the hold note for ben)
    await assert.rejects(reservations.shorten(pool, rb.id, { actorAccountId: w.anaAcct.id, employeeId: w.ana.id, newEnd: d(5) }), /injected failure/);
    assert.deepEqual(await snapshot(b.id), before, 'shorten: unchanged');
    await pool.query(`DROP TRIGGER ${name} ON activity`);
    // FK failure: an actor account that does not exist
    const c = await req({ name: 'Rollback FK' });
    await tw.syncSequences();
    before = await snapshot(c.id);
    await assert.rejects(reservations.create(pool, { assetId: c.id, employeeId: w.ana.id, actorAccountId: 99999999, start: d(3), end: d(3) }), (err) => err.code === '23503');
    assert.deepEqual(await snapshot(c.id), before, 'FK failure: nothing written');
    await effects.whenIdle();
    assert.deepEqual(fired, [], 'no effect from any failed transaction');
    effects.setNotifier(null);
  });
});
