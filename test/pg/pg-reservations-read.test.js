// src/pg/reservations.js + src/pg/waitlist.js classify/rangeCheck (D-46, Slice 4A): the READ side of reservations on
// PostgreSQL. Ports the read-path scenarios of test/reservations.test.js, test/reservation-times.test.js and
// test/partial-fulfillment.test.js to the module API and runs every one against BOTH engines (pg-twin, identical rows and ids),
// requiring deep-equal output: findBlockers (each blocker kind, half-open adjacency, checkouts bounded by due date AND time,
// permanent / overdue unbounded, expired holds ignored), plan (T.splitFree free/busy pieces), hasOwnOverlap / hasOwnHold, every
// classify outcome with its status and message, reservers, excludeEntryId, rangeCheck, loadAsset, emailOf.
// Deterministic: dates relative to the database's today, holds +/- 6 hours from the database clock. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction } = require('../../src/pg/transaction');
const sqliteReservations = require('../../src/reservations');
const sqliteWaitlist = require('../../src/waitlist');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');

const HOURS6 = 6 * 3600;
const range = (start_date, start_time = null, end_date = start_date, end_time = null) => ({ start_date, start_time, end_date, end_time });

describe('PostgreSQL reservation reads (differential against src/reservations.js / src/waitlist.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    const live = await tw.stamp(HOURS6); const lapsed = await tw.stamp(-HOURS6);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Asker', work_email: 'ana@nutricost.com' });
    w.ben = await tw.employee({ name: 'Ben Booker', department: 'Sales' });
    w.cy = await tw.employee({ name: 'Cy Inactive', status: 'inactive' });
    w.dee = await tw.employee({ name: 'Dee Login' });
    await tw.insert('accounts', { login_email: 'dee@nutricost.com', role: 'employee', employee_id: w.dee.id });
    await tw.insert('accounts', { login_email: 'old-dee@nutricost.com', role: 'employee', employee_id: w.ben.id, active: 0 });
    const req = (cols) => tw.asset({ available_to_request: 1, ...cols });
    // X: one of every reservation / waitlist kind
    w.x = await req({ name: 'X mixed' });
    w.xConfirmed = await tw.reservation({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(3), start_time: '08:00', end_time: '13:00' });
    w.xHeldFrom = await tw.entry({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(5), status: 'fulfilled', queue_seq: 1 });
    w.xPendingHold = await tw.reservation({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(5), status: 'pending', waitlist_entry_id: w.xHeldFrom.id });
    await tw.reservation({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(6), status: 'pending' });
    await tw.reservation({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(7), status: 'cancelled' });
    await tw.reservation({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(7), status: 'declined' });
    w.xHold = await tw.entry({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(8), start_time: '09:00', end_time: '12:00', status: 'held', hold_expires_at: live, queue_seq: 2 });
    w.xLapsed = await tw.entry({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(9), status: 'held', hold_expires_at: lapsed, queue_seq: 3 });
    await tw.entry({ asset_id: w.x.id, employee_id: w.ben.id, start_date: d(10), queue_seq: 4 });
    w.xBenTwo = await tw.reservation({ asset_id: w.x.id, employee_id: w.dee.id, start_date: d(12), end_date: d(13) });
    // checkouts: bounded by due date AND time, permanent, overdue
    w.out = await req({ name: 'Out until 1 PM', status: 'checked_out' });
    await tw.checkout({ asset_id: w.out.id, employee_id: w.ben.id, due_date: d(4), due_time: '13:00' });
    w.outDay = await req({ name: 'Out until end of day', status: 'checked_out' });
    await tw.checkout({ asset_id: w.outDay.id, employee_id: w.ben.id, due_date: d(4) });
    w.perm = await req({ name: 'Permanent', status: 'checked_out' });
    await tw.assignment({ asset_id: w.perm.id, employee_id: w.ben.id });
    w.overdue = await req({ name: 'Overdue', status: 'checked_out' });
    await tw.checkout({ asset_id: w.overdue.id, employee_id: w.ben.id, due_date: d(-1) });
    // NULL ordering: same start date, an untimed and a 00:00 pickup have the SAME start key; SQLite names the NULL one first
    w.nul = await req({ name: 'Null order' });
    await tw.reservation({ asset_id: w.nul.id, employee_id: w.ben.id, start_date: d(3), start_time: '00:00', end_time: '10:00' });
    await tw.reservation({ asset_id: w.nul.id, employee_id: w.dee.id, start_date: d(3), end_time: '09:00' });
    w.nulH = await req({ name: 'Null order holds' });
    await tw.entry({ asset_id: w.nulH.id, employee_id: w.ben.id, start_date: d(3), start_time: '00:00', end_time: '10:00', status: 'held', hold_expires_at: live, queue_seq: 5 });
    await tw.entry({ asset_id: w.nulH.id, employee_id: w.dee.id, start_date: d(3), end_time: '09:00', status: 'held', hold_expires_at: live, queue_seq: 6 });
    // the asker's own rows
    w.own = await req({ name: 'Own rows', reservation_requires_approval: 1 });
    await tw.reservation({ asset_id: w.own.id, employee_id: w.ana.id, start_date: d(3), start_time: '08:00', end_time: '12:00' });
    await tw.entry({ asset_id: w.own.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: live, queue_seq: 7 });
    await tw.entry({ asset_id: w.own.id, employee_id: w.ana.id, start_date: d(6), status: 'held', hold_expires_at: lapsed, queue_seq: 8 });
    w.ownWait = await tw.entry({ asset_id: w.own.id, employee_id: w.ana.id, start_date: d(8), end_date: d(9), queue_seq: 9 });
    await tw.reservation({ asset_id: w.own.id, employee_id: w.ben.id, start_date: d(8), end_date: d(9) });
    // not reservable
    w.hidden = await tw.asset({ name: 'Hidden' });
    w.archived = await req({ name: 'Archived', archived_at: '2026-01-01 00:00:00' });
    w.repair = await req({ name: 'Repair', status: 'maintenance' });
    w.lost = await req({ name: 'Lost', status: 'lost' });
    w.seats = await req({ name: 'Seats', license_seats: 5 });
    w.free = await req({ name: 'Free' });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('findBlockers / plan / hasOwnOverlap / hasOwnHold give identical output', async () => {
    const ranges = [
      range(d(3), '13:00', d(3), '17:00'), range(d(3), '12:00', d(3), '14:00'), range(d(3)), range(d(2), null, d(11)), range(d(5)), range(d(6), null, d(7)),
      range(d(8), '12:00', d(8), '15:00'), range(d(8), '11:59'), range(d(9)), range(d(10)), range(d(4), '13:00'), range(d(4), '12:59', d(4), '13:01'), range(d(4)),
      range(d(5), null, d(5), '00:30'), range(d(0)), range(d(30), null, d(40)),
    ];
    const assets = [w.x, w.out, w.outDay, w.perm, w.overdue, w.nul, w.nulH, w.own, w.free];
    const optsList = [{}, { excludeId: w.xConfirmed.id }, { ignoreHoldId: w.xHold.id }, { excludeId: w.xPendingHold.id, ignoreHoldId: w.xHold.id }];
    let n = 0;
    for (const asset of assets) {
      for (const r of ranges) {
        for (const o of optsList) {
          const opts = { today, ...o };
          await tw.same(`findBlockers ${asset.name} ${JSON.stringify(r)} ${JSON.stringify(o)}`,
            (q) => reservations.findBlockers(q, asset, r, opts), (db) => sqliteReservations.findBlockers(db, asset, r, opts));
          await tw.same(`plan ${asset.name} ${JSON.stringify(r)}`, (q) => reservations.plan(q, asset, r, opts), (db) => sqliteReservations.plan(db, asset, r, opts));
          n += 2;
        }
        for (const who of [w.ana, w.ben, w.dee]) {
          await tw.same(`own ${asset.name} ${who.name}`, async (q) => [await reservations.hasOwnOverlap(q, asset.id, who.id, r), await reservations.hasOwnHold(q, asset.id, who.id, r)],
            (db) => [sqliteReservations.hasOwnOverlap(db, asset.id, who.id, r), sqliteReservations.hasOwnHold(db, asset.id, who.id, r)]);
        }
      }
    }
    assert.ok(n > 500);
  });

  test('blocker kinds, half-open adjacency and checkout ends (explicit)', async () => {
    const kinds = async (asset, r, o = {}) => (await reservations.findBlockers(pool, asset, r, { today, ...o })).map((b) => b.kind);
    assert.deepEqual(await kinds(w.x, range(d(2), null, d(11))), ['reservation', 'pending_hold', 'hold']);
    assert.deepEqual(await kinds(w.x, range(d(3), '13:00', d(3), '17:00')), [], 'return 1 PM / pickup 1 PM: no overlap');
    assert.deepEqual(await kinds(w.x, range(d(3), '12:59')), ['reservation']);
    assert.deepEqual(await kinds(w.x, range(d(9))), [], 'an expired-but-unswept hold counts for nothing');
    assert.deepEqual(await kinds(w.x, range(d(8)), { ignoreHoldId: w.xHold.id }), []);
    assert.deepEqual(await kinds(w.out, range(d(4), '13:00')), [], 'free from the due time');
    assert.deepEqual(await kinds(w.out, range(d(4), '12:00')), ['checkout']);
    assert.deepEqual(await kinds(w.outDay, range(d(4), '23:00')), ['checkout']);
    assert.deepEqual(await kinds(w.outDay, range(d(5))), []);
    assert.deepEqual(await kinds(w.perm, range(d(300))), ['checkout'], 'permanent: no known end');
    assert.deepEqual(await kinds(w.overdue, range(d(300))), ['checkout'], 'overdue: no known end');
    const p = await reservations.plan(pool, w.x, range(d(3), '06:00', d(3), '15:00'), { today });
    assert.deepEqual(p.free, [range(d(3), '06:00', d(3), '08:00'), range(d(3), '13:00', d(3), '15:00')]);
    assert.deepEqual(p.busy, [range(d(3), '08:00', d(3), '13:00')]);
    const nul = await reservations.findBlockers(pool, w.nul, range(d(3)), { today });
    assert.deepEqual(nul.map((b) => b.row.start_time), [null, '00:00'], 'NULL start_time first, like SQLite');
  });

  test('every classify outcome, status and message is identical (and rangeCheck)', async () => {
    const asks = [
      ['reserve', { assetId: w.free.id, employeeId: w.ana.id, start: d(2), end: d(3) }],
      ['reserve with times', { assetId: w.x.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '13:00', endTime: '17:00:00' }],
      ['partial', { assetId: w.x.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '06:00', endTime: '15:00' }],
      ['partial multi-day', { assetId: w.x.id, employeeId: w.ana.id, start: d(2), end: d(11) }],
      ['waitlist: reservation', { assetId: w.x.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '09:00', endTime: '10:00' }],
      ['waitlist: pending hold', { assetId: w.x.id, employeeId: w.ana.id, start: d(5), end: d(5) }],
      ['waitlist: hold', { assetId: w.x.id, employeeId: w.ana.id, start: d(8), end: d(8), startTime: '10:00', endTime: '11:00' }],
      ['waitlist: checkout until 1 PM', { assetId: w.out.id, employeeId: w.ana.id, start: d(4), end: d(4), startTime: '09:00', endTime: '10:00' }],
      ['waitlist: checkout end of day', { assetId: w.outDay.id, employeeId: w.ana.id, start: d(4), end: d(4) }],
      ['waitlist: permanent', { assetId: w.perm.id, employeeId: w.ana.id, start: d(4), end: d(4) }],
      ['waitlist: overdue', { assetId: w.overdue.id, employeeId: w.ana.id, start: d(4), end: d(4) }],
      ['waitlist: NULL-first naming (reservations)', { assetId: w.nul.id, employeeId: w.ana.id, start: d(3), end: d(3), endTime: '08:00' }],
      ['waitlist: NULL-first naming (holds)', { assetId: w.nulH.id, employeeId: w.ana.id, start: d(3), end: d(3), endTime: '08:00' }],
      ['partial around NULL-ordered blockers', { assetId: w.nul.id, employeeId: w.ana.id, start: d(3), end: d(3) }],
      ['reserve after a checkout (adjacent)', { assetId: w.out.id, employeeId: w.ana.id, start: d(4), end: d(5), startTime: '13:00' }],
      ['expired hold is free', { assetId: w.x.id, employeeId: w.ana.id, start: d(9), end: d(9) }],
      ['reservers: only others', { assetId: w.x.id, employeeId: w.dee.id, start: d(2), end: d(13) }],
      ['own reservation', { assetId: w.own.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '11:00' }],
      ['own reservation: adjacent is fine', { assetId: w.own.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '12:00', endTime: '14:00' }],
      ['own hold', { assetId: w.own.id, employeeId: w.ana.id, start: d(4), end: d(5) }],
      ['own lapsed hold is not a hold', { assetId: w.own.id, employeeId: w.ana.id, start: d(6), end: d(6) }],
      ['own waitlist', { assetId: w.own.id, employeeId: w.ana.id, start: d(9), end: d(9) }],
      ['own waitlist, excluded (editing that entry)', { assetId: w.own.id, employeeId: w.ana.id, start: d(9), end: d(9), excludeEntryId: w.ownWait.id }],
      ['excludeEntryId garbage', { assetId: w.own.id, employeeId: w.ana.id, start: d(9), end: d(9), excludeEntryId: 'abc' }],
      ['hidden asset', { assetId: w.hidden.id, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['unknown asset', { assetId: 999999, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['garbage asset id', { assetId: 'abc', employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['huge asset id', { assetId: 2 ** 40, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['string asset id', { assetId: String(w.free.id), employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['archived', { assetId: w.archived.id, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['repair', { assetId: w.repair.id, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['lost', { assetId: w.lost.id, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['multi-seat', { assetId: w.seats.id, employeeId: w.ana.id, start: d(2), end: d(2) }],
      ['no employee', { assetId: w.free.id, employeeId: null, start: d(2), end: d(2) }],
      ['inactive employee', { assetId: w.free.id, employeeId: w.cy.id, start: d(2), end: d(2) }],
      ['unknown employee', { assetId: w.free.id, employeeId: 999999, start: d(2), end: d(2) }],
      ['invalid: no dates', { assetId: w.free.id, employeeId: w.ana.id }],
      ['invalid: impossible date', { assetId: w.free.id, employeeId: w.ana.id, start: '2026-02-30', end: '2026-03-01' }],
      ['invalid: end before start', { assetId: w.free.id, employeeId: w.ana.id, start: d(3), end: d(2) }],
      ['invalid: past', { assetId: w.free.id, employeeId: w.ana.id, start: d(-1), end: d(2) }],
      ['invalid: after 2100', { assetId: w.free.id, employeeId: w.ana.id, start: d(2), end: '2101-01-01' }],
      ['invalid: bad time', { assetId: w.free.id, employeeId: w.ana.id, start: d(2), end: d(2), startTime: '25:00' }],
      ['invalid: return before pickup', { assetId: w.free.id, employeeId: w.ana.id, start: d(2), end: d(2), startTime: '14:00', endTime: '13:00' }],
      ['invalid: return at midnight', { assetId: w.free.id, employeeId: w.ana.id, start: d(2), end: d(2), endTime: '00:00' }],
      ['requires approval is reported', { assetId: w.own.id, employeeId: w.dee.id, start: d(20), end: d(20) }],
    ];
    const seen = new Set();
    for (const [label, args] of asks) {
      const c = await tw.same(`classify ${label}`, (q) => waitlist.classify(q, args), (db) => sqliteWaitlist.classify(db, args));
      await tw.same(`rangeCheck ${label}`, (q) => waitlist.rangeCheck(q, args), (db) => sqliteWaitlist.rangeCheck(db, args));
      seen.add(c.ok.outcome);
    }
    assert.deepEqual([...seen].sort(), ['invalid', 'own_hold', 'own_reservation', 'own_waitlist', 'partial', 'reserve', 'unavailable', 'waitlist']);
  });

  test('classify outcomes and messages (explicit)', async () => {
    const c = (args) => waitlist.classify(pool, { employeeId: w.ana.id, ...args });
    const r1 = await c({ assetId: w.free.id, start: d(2), end: d(3) });
    assert.deepEqual([r1.outcome, r1.status, r1.free.length, r1.busy.length], ['reserve', 409, 1, 0]);
    const wl = await c({ assetId: w.out.id, start: d(4), end: d(4), startTime: '09:00', endTime: '10:00' });
    assert.deepEqual([wl.outcome, wl.status, wl.message], ['waitlist', 200, `It is checked out until ${T.fmtDay(d(4))} at 1:00 PM.`]);
    assert.equal((await c({ assetId: w.perm.id, start: d(4), end: d(4) })).message, 'It is currently assigned.');
    assert.equal((await c({ assetId: w.overdue.id, start: d(4), end: d(4) })).message, 'It is checked out and overdue.');
    assert.equal((await c({ assetId: w.x.id, start: d(8), end: d(8), startTime: '10:00', endTime: '11:00' })).message, `It is on a priority hold for a waitlisted team ${T.when(range(d(8), '09:00', d(8), '12:00'))}.`);
    assert.equal((await c({ assetId: w.nul.id, start: d(3), end: d(3), endTime: '08:00' })).message, `It is already reserved ${T.when(range(d(3), null, d(3), '09:00'))}.`, 'the untimed reservation is named');
    const part = await c({ assetId: w.x.id, start: d(2), end: d(11) });
    assert.equal(part.outcome, 'partial');
    assert.deepEqual(part.reservers.map((r) => r.reservation_id), [w.xConfirmed.id]);
    const hidden = await c({ assetId: w.hidden.id, start: d(2), end: d(2) });
    assert.deepEqual([hidden.outcome, hidden.status, hidden.message], ['unavailable', 404, 'Asset not found']);
    assert.deepEqual([(await c({ assetId: w.own.id, start: d(4), end: d(5) })).outcome, (await c({ assetId: w.own.id, start: d(9), end: d(9) })).outcome], ['own_hold', 'own_waitlist']);
    assert.equal((await c({ assetId: w.own.id, start: d(9), end: d(9), excludeEntryId: w.ownWait.id })).outcome, 'waitlist');
    const rc = await waitlist.rangeCheck(pool, { assetId: w.x.id, employeeId: w.ana.id, start: d(3), end: d(3), startTime: '06:00', endTime: '15:00' });
    assert.deepEqual(Object.keys(rc), ['outcome', 'message', 'requires_approval', 'reserved', 'waitlisted']);
    assert.deepEqual([rc.reserved.length, rc.waitlisted.length], [2, 1]);
    const inTx = await withTransaction((tx) => waitlist.classify(tx, { assetId: w.x.id, employeeId: w.ana.id, start: d(2), end: d(11) }), pool);
    assert.deepEqual(inTx, part, 'classify runs on a transaction client unchanged');
  });

  test('loadAsset, emailOf, todayOf', async () => {
    for (const id of [w.free.id, String(w.free.id), 999999, 'abc', null, undefined, 2 ** 40]) {
      await tw.same(`loadAsset ${id}`, (q) => reservations.loadAsset(q, id), (db) => sqliteReservations.loadAsset(db, id));
    }
    for (const id of [w.ana.id, w.ben.id, w.dee.id, 999999, 'abc']) {
      await tw.same(`emailOf ${id}`, (q) => reservations.emailOf(q, id), (db) => sqliteReservations.emailOf(db, id));
    }
    assert.deepEqual(await reservations.emailOf(pool, w.dee.id), { name: 'Dee Login', email: 'dee@nutricost.com', department: null });
    assert.deepEqual(await reservations.emailOf(pool, w.ben.id), { name: 'Ben Booker', email: null, department: 'Sales' }, 'an inactive login is not used');
    await tw.same('todayOf', (q) => reservations.todayOf(q), (db) => sqliteReservations.todayOf(db));
  });
});
