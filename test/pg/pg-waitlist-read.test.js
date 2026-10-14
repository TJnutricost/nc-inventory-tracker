// src/pg/waitlist.js reads (D-46, Slice 4A): list / get / present / counts on PostgreSQL. Ports the read-path scenarios of
// test/waitlist.test.js and test/partial-fulfillment.test.js to the module API, and runs them against BOTH engines (pg-twin,
// identical rows and ids) requiring deep-equal output: every phase (a lapsed hold reads 'expired'; fulfilled reads checked_out /
// pending / confirmed / reservation_declined / reservation_cancelled), position among overlapping open entries (adjacent times
// do not count, split pieces share a place), button flags, admin-only fields, list filters / orders / LIMIT 300, get's 404/403,
// and counts for IT and employees. Deterministic: holds +/- 6 hours from the database clock. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction } = require('../../src/pg/transaction');
const sqliteWaitlist = require('../../src/waitlist');
const waitlist = require('../../src/pg/waitlist');

const HOURS6 = 6 * 3600;

describe('PostgreSQL waitlist reads (differential against src/waitlist.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w; let users;
  const d = (n) => T.addDays(today, n);

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    const live = await tw.stamp(HOURS6); const lapsed = await tw.stamp(-HOURS6);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Waiter', department: 'Ops' });
    w.ben = await tw.employee({ name: 'Ben Waiter' });
    w.cy = await tw.employee({ name: 'Cy Waiter', department: 'Lab' });
    w.a1 = await tw.asset({ name: 'Camera A', tag: 'WL-1', available_to_request: 1 });
    w.a2 = await tw.asset({ name: 'Camera B', tag: 'WL-2', available_to_request: 1 });
    w.bulk = await tw.asset({ name: 'Bulk', tag: 'WL-3', available_to_request: 1 });
    const e = (cols) => tw.entry({ asset_id: w.a1.id, ...cols });
    w.e1 = await e({ employee_id: w.ana.id, start_date: d(2), end_date: d(4), queue_seq: 10, queued_at: '2026-02-01 10:00:00', request_group: 'g-1' });
    w.e2 = await e({ employee_id: w.ben.id, start_date: d(3), queue_seq: 11 });
    w.e3 = await e({ employee_id: w.ben.id, start_date: d(5), start_time: '00:00', queue_seq: 12 }); // touches e1's end: not overlapping
    w.e4 = await e({ employee_id: w.ana.id, start_date: d(6), status: 'held', hold_expires_at: live, hold_started_at: '2026-02-01 09:00:00', queue_seq: 13 });
    w.e5 = await e({ employee_id: w.ben.id, start_date: d(6), status: 'held', hold_expires_at: lapsed, queue_seq: 14 });
    w.e6a = await e({ employee_id: w.cy.id, start_date: d(3), start_time: '13:00', queue_seq: 9, request_group: 'g-6' });
    w.e6b = await e({ employee_id: w.cy.id, start_date: d(3), start_time: '08:00', end_time: '10:00', queue_seq: 9, request_group: 'g-6' });
    w.e6c = await e({ employee_id: w.cy.id, start_date: d(30), status: 'held', hold_expires_at: live, queue_seq: 9, request_group: 'g-6' }); // inserted last, listed first
    w.e7 = await e({ employee_id: w.ana.id, start_date: d(-3), queue_seq: 15 }); // open, dates passed, not swept yet
    const closedAt = (n) => `2026-03-0${n} 12:00:00`;
    const fulfilled = async (status, n) => {
      const f = await e({ employee_id: w.ana.id, start_date: d(20 + n), status: 'fulfilled', closed_at: closedAt(n), queue_seq: 20 + n });
      if (status) await tw.reservation({ asset_id: w.a1.id, employee_id: w.ana.id, start_date: d(20 + n), status, waitlist_entry_id: f.id });
      return f;
    };
    w.f1 = await fulfilled(null, 1);
    w.f2 = await fulfilled('pending', 2);
    w.f3 = await fulfilled('confirmed', 3);
    w.f4 = await fulfilled('declined', 4);
    w.f5 = await fulfilled('cancelled', 5);
    for (const [status, who] of [['declined', w.ana], ['left', w.ben], ['removed', w.ana], ['expired', w.cy]]) {
      w[status] = await e({ employee_id: who.id, start_date: d(1), status, closed_at: closedAt(6), queue_seq: 30 }); // same closed_at: id DESC breaks the tie
    }
    w.b1 = await tw.entry({ asset_id: w.a2.id, employee_id: w.ana.id, start_date: d(3), queue_seq: 1 });
    for (let i = 0; i < 310; i++) {
      await tw.entry({ asset_id: w.bulk.id, employee_id: i % 2 ? w.ben.id : w.cy.id, start_date: d(40 + (i % 5)), queue_seq: 1000 - Math.floor(i / 2) });
    }
    users = {
      admin: { role: 'admin', employee_id: null },
      adminAna: { role: 'admin', employee_id: w.ana.id },
      ana: { role: 'employee', employee_id: w.ana.id },
      ben: { role: 'employee', employee_id: w.ben.id },
      cy: { role: 'employee', employee_id: w.cy.id },
      nobody: { role: 'employee', employee_id: null },
    };
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('list, get and counts are identical for every viewer and filter', async () => {
    const ids = Object.values(w).filter((r) => r.queue_seq !== undefined).map((r) => r.id);
    for (const [who, user] of Object.entries(users)) {
      for (const status of [undefined, 'open', 'closed', 'bogus', '', 'OPEN']) {
        await tw.same(`list ${who} ${status}`, (q) => waitlist.list(q, user, { status }), (db) => sqliteWaitlist.list(db, user, { status }));
      }
      await tw.same(`list ${who} no options`, (q) => waitlist.list(q, user), (db) => sqliteWaitlist.list(db, user));
      for (const id of [...ids, String(w.e1.id), 999999, 'abc', '12abc', 2 ** 40]) {
        await tw.same(`get ${who} ${id}`, (q) => waitlist.get(q, id, user), (db) => sqliteWaitlist.get(db, id, user));
      }
      await tw.same(`counts ${who}`, (q) => waitlist.counts(q, user), (db) => sqliteWaitlist.counts(db, user));
    }
  });

  test('phases, positions, buttons and admin-only fields (explicit)', async () => {
    const get = (r, user = users.ana) => waitlist.get(pool, r.id, user);
    assert.equal((await get(w.e4)).phase, 'held');
    assert.equal((await get(w.e5, users.ben)).phase, 'expired', 'a lapsed hold reads expired before the sweep records it');
    assert.deepEqual(await Promise.all([w.f1, w.f2, w.f3, w.f4, w.f5].map(async (f) => (await get(f)).phase)),
      ['checked_out', 'pending', 'confirmed', 'reservation_declined', 'reservation_cancelled']);
    assert.equal((await get(w.e1)).position, 3, 'e1 behind both split pieces of e6 (queue 9) and itself; e2 (queue 11) is behind it');
    assert.equal((await get(w.e2, users.ben)).position, 4);
    assert.equal((await get(w.e3, users.ben)).position, 1, 'touching e1 at midnight is not overlapping');
    assert.equal((await get(w.e5, users.ben)).position, null, 'a lapsed hold has no place');
    assert.equal((await get(w.f3)).position, null);
    const held = await get(w.e4);
    assert.deepEqual([held.can_confirm, held.can_decline, held.can_leave, held.can_edit, held.can_remove], [true, true, true, false, false]);
    assert.equal(held.hold_expires_text, T.fmtStamp(held.hold_expires_at));
    assert.ok(!('employee_name' in held) && !('hold_started_at' in held), 'no admin fields for an employee');
    const asAdmin = await get(w.e4, users.admin);
    assert.deepEqual([asAdmin.mine, asAdmin.can_confirm, asAdmin.can_remove, asAdmin.employee_name, asAdmin.employee_department, asAdmin.hold_started_at],
      [false, false, true, 'Ana Waiter', 'Ops', '2026-02-01 09:00:00']);
    const waiting = await get(w.e1);
    assert.deepEqual([waiting.can_edit, waiting.can_leave, waiting.can_confirm, waiting.queued_at, waiting.request_group, waiting.hold_expires_at], [true, true, false, '2026-02-01 10:00:00', 'g-1', null]);
    assert.equal((await get(w.e2, users.ben)).queued_at, (await get(w.e2, users.ben)).created_at, 'queued_at falls back to created_at');
    await assert.rejects(get(w.e2, users.ana), { status: 403, message: 'Not allowed' });
    await assert.rejects(waitlist.get(pool, 999999, users.admin), { status: 404, message: 'Waitlist entry not found' });
    await assert.rejects(waitlist.get(pool, 'abc', users.admin), { status: 404, message: 'Waitlist entry not found' });
  });

  test('list filters, orders and the 300-row limit (explicit)', async () => {
    await assert.rejects(waitlist.list(pool, users.admin, { status: 'bogus' }), { status: 400, message: 'Status must be open or closed' });
    const closed = await waitlist.list(pool, users.admin, { status: 'closed' });
    assert.deepEqual(closed.slice(0, 4).map((r) => r.id), [w.expired.id, w.removed.id, w.left.id, w.declined.id], 'closed_at DESC, then id DESC');
    assert.equal(closed.at(-1).id, w.f1.id);
    const open = await waitlist.list(pool, users.ana, { status: 'open' });
    assert.ok(open.every((r) => r.mine && ['waiting', 'held', 'expired'].includes(r.phase)));
    const all = await waitlist.list(pool, users.admin);
    assert.equal(all.length, 300, 'LIMIT 300');
    const a1 = all.filter((r) => r.asset_id === w.a1.id).map((r) => r.id);
    assert.deepEqual(a1.slice(0, 4), [w.e6c.id, w.e6a.id, w.e6b.id, w.e1.id], 'asset, queue_seq, then status (held first) and id for split pieces, as SQLite');
    assert.deepEqual(await waitlist.list(pool, users.nobody), [], 'an unlinked employee sees nothing');
    const inTx = await withTransaction((c) => waitlist.list(c, users.ana), pool);
    assert.deepEqual(inTx, await waitlist.list(pool, users.ana), 'runs on a transaction client unchanged');
  });

  test('counts: IT attention = pending + active line; employees: their live holds', async () => {
    const admin = await waitlist.counts(pool, users.admin);
    const pending = (await pool.query("SELECT COUNT(*) c FROM reservations WHERE status = 'pending'")).rows[0].c;
    assert.equal(admin.pending, pending);
    assert.equal(admin.attention, admin.pending + admin.waitlist_active);
    assert.equal(typeof admin.waitlist_active, 'number');
    assert.deepEqual(await waitlist.counts(pool, users.ana), { pending: 0, waitlist_active: 4, held: 1, attention: 1 });
    assert.deepEqual(await waitlist.counts(pool, users.ben), { pending: 0, waitlist_active: 2 + 155, held: 0, attention: 0 }, 'the lapsed hold is not active');
    assert.deepEqual(await waitlist.counts(pool, users.nobody), { pending: 0, waitlist_active: 0, held: 0, attention: 0 });
  });
});
