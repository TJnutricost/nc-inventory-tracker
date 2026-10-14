// src/pg/assignments.js (D-46, Slice 3): assignment creation on PostgreSQL. Ports the module-level scenarios of
// test/assignments.test.js (and the checkout guards of the reservation/waitlist tests), runs a scenario list against BOTH
// src/assignments.js (SQLite) and src/pg/assignments.js requiring identical outcomes, and proves the per-asset lock under
// real concurrency: seats are never oversold, one winner per single-seat asset, a duplicate holder is refused, a failure
// rolls everything back, and different assets do not wait for each other. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { buildSqliteReference } = require('../../test-support/pg-parity');
const fx = require('../../test-support/pg-fixtures');
const T = require('../../src/timeRange');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const pgTime = require('../../src/pg/time');
const sqliteAssignments = require('../../src/assignments');
const assignments = require('../../src/pg/assignments');
const requests = require('../../src/pg/requests');

const SEATS_FULL = 'All license seats are in use.';
const outcome = (p) => Promise.resolve().then(p).then((v) => ({ ok: v }), (e) => ({ status: e.status, message: e.message, code: e.code }));
const errOf = (o) => ({ status: o.status, message: o.message });

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Scenarios run on both engines. Each builds its own rows through `q` (fixtures) and returns the createAssignment input.
// ctx = { today, tomorrow, adminAccount, holder, other } built identically on both engines.
const SCENARIOS = [
  ['admin permanent (a submitted due date is dropped)', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'permanent', dueDate: c.tomorrow, dueTime: '10:00' })],
  ['default type is permanent', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true })],
  ['admin checkout with time, notes and condition', async (q, c) => ({ assetId: (await fx.insertAsset(q, { condition: 'Good' })).id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: ` ${c.tomorrow} `, dueTime: '14:30', notes: '  Request #7 ', condition: ' Scratched ' })],
  ['self checkout of a requestable asset', async (q, c) => ({ assetId: (await fx.insertAsset(q, { available_to_request: 1 })).id, employeeId: c.holder.id, actorAccountId: c.holderAccount.id, actorIsAdmin: false, type: 'checkout', dueDate: c.tomorrow })],
  ['non-admin permanent', async (q, c) => ({ assetId: (await fx.insertAsset(q, { available_to_request: 1 })).id, employeeId: c.holder.id, actorIsAdmin: false, type: 'permanent' })],
  ['unknown type', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorIsAdmin: true, type: 'loan' })],
  ['checkout without a return date', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: '  ' })],
  ['checkout with an impossible date', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: '2026-02-30' })],
  ['checkout with a bad time', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: c.tomorrow, dueTime: '24:00' })],
  ['unknown asset (and unknown employee: asset is checked first)', async () => ({ assetId: 999999, employeeId: 999999, actorIsAdmin: true })],
  ['unknown employee', async (q) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: 999999, actorIsAdmin: true })],
  ['archived asset', async (q, c) => ({ assetId: (await fx.insertAsset(q, { archived_at: '2026-01-01 00:00:00' })).id, employeeId: c.holder.id, actorIsAdmin: true })],
  ...['retired', 'lost', 'maintenance', 'disposed'].map((status) => [`asset marked ${status}`, async (q, c) => ({ assetId: (await fx.insertAsset(q, { status })).id, employeeId: c.holder.id, actorIsAdmin: true })]),
  ['non-admin, asset not in the requestable pool', async (q, c) => ({ assetId: (await fx.insertAsset(q)).id, employeeId: c.holder.id, actorIsAdmin: false, type: 'checkout', dueDate: c.tomorrow })],
  ['confirmed reservation 1-5 PM today, back at noon: allowed', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.today, start_time: '13:00', end_time: '17:00' });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: c.today, dueTime: '12:00' };
  }],
  ['confirmed reservation 1-5 PM today, back at 1:30 PM: 409 (admin wording)', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.today, start_time: '13:00', end_time: '17:00' });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: c.today, dueTime: '13:30' };
  }],
  ['confirmed reservation, back at 1:30 PM: 409 (employee wording)', async (q, c) => {
    const a = await fx.insertAsset(q, { available_to_request: 1 });
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.today, start_time: '13:00', end_time: '17:00' });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: false, type: 'checkout', dueDate: c.today, dueTime: '13:30' };
  }],
  ['date-only multi-day reservation blocks a permanent assignment', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: T.addDays(c.today, 5), end_date: T.addDays(c.today, 7) });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true, type: 'permanent' };
  }],
  ['own reservation never blocks; pending/cancelled reservations of others never block', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.holder.id, start_date: c.today });
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.today, status: 'pending' });
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.today, status: 'cancelled' });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: c.tomorrow };
  }],
  ['two reservations the same day, the untimed one is named first (NULL sorts first like SQLite)', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, start_time: '09:00', end_time: '10:00' });
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, end_time: '08:00' });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true, type: 'permanent' };
  }],
  ['another employee\'s waitlist hold tomorrow blocks a return tomorrow', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, status: 'held' });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: c.tomorrow };
  }],
  ['another employee\'s hold tomorrow does not block a return today', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, status: 'held' });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: c.today };
  }],
  ['an expired hold or a merely waiting entry never blocks', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, status: 'held', hold_expires_at: '2020-01-01 00:00:00' });
    await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: c.tomorrow };
  }],
  ['the hold owner checks out: the hold is fulfilled and logged', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.holder.id, start_date: c.tomorrow, start_time: '09:00', status: 'held' });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: c.tomorrow };
  }],
  ['a pending waitlist-born reservation of someone else blocks', async (q, c) => {
    const a = await fx.insertAsset(q);
    const w = await fx.insertWaitlistEntry(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, status: 'fulfilled' });
    await fx.insertReservation(q, { asset_id: a.id, employee_id: c.other.id, start_date: c.tomorrow, status: 'pending', waitlist_entry_id: w.id });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: T.addDays(c.today, 3) };
  }],
  ['the same employee cannot hold the asset twice', async (q, c) => {
    const a = await fx.insertAsset(q, { license_seats: 5 });
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.holder.id });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true };
  }],
  ['single seat taken (admin is told who has it)', async (q, c) => {
    const a = await fx.insertAsset(q);
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.other.id });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true };
  }],
  ['single seat taken (an employee is not told who)', async (q, c) => {
    const a = await fx.insertAsset(q, { available_to_request: 1 });
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.other.id });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: false, type: 'checkout', dueDate: c.tomorrow };
  }],
  ['multi-seat: the last free seat, then full', async (q, c) => {
    const a = await fx.insertAsset(q, { license_seats: 2 });
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.other.id });
    return { assetId: a.id, employeeId: c.holder.id, actorAccountId: c.adminAccount.id, actorIsAdmin: true };
  }],
  ['multi-seat full', async (q, c) => {
    const a = await fx.insertAsset(q, { license_seats: 2 });
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.other.id });
    await fx.insertAssignment(q, { asset_id: a.id, employee_id: c.third.id });
    return { assetId: a.id, employeeId: c.holder.id, actorIsAdmin: true };
  }],
];

async function context(q, today) {
  const holder = await fx.insertEmployee(q, { name: 'Hana Holder' });
  return {
    today, tomorrow: T.addDays(today, 1), holder,
    holderAccount: await fx.insertAccount(q, { employee_id: holder.id }),
    other: await fx.insertEmployee(q, { name: 'Omar Other' }),
    third: await fx.insertEmployee(q, { name: 'Tess Third' }),
    adminAccount: await fx.insertAccount(q, { role: 'admin' }),
  };
}

// What a successful call produced, without ids or clock values (those legitimately differ between the engines).
async function summary(q, result, input) {
  const { assignment: s, asset, employee } = result;
  const activity = (await q.query('SELECT action, details, actor_id IS NOT NULL AS by_actor FROM activity WHERE asset_id = $1 ORDER BY id', [input.assetId])).rows
    .map((r) => ({ ...r, by_actor: Boolean(r.by_actor) }));
  const holds = (await q.query('SELECT status, closed_at IS NOT NULL AS closed FROM waitlist_entries WHERE asset_id = $1 ORDER BY id', [input.assetId])).rows
    .map((r) => ({ ...r, closed: Boolean(r.closed) }));
  return {
    assignment: { type: s.assignment_type, due_date: s.due_date, due_time: s.due_time, notes: s.notes, condition_out: s.condition_out, returned_at: s.returned_at, by: s.checked_out_by === null ? null : 'actor', keys: Object.keys(s).sort() },
    asset: { status: asset.status, condition: asset.condition, keys: Object.keys(asset).sort() },
    employee: employee.name,
    activity,
    holds,
  };
}

describe('PostgreSQL assignments', pgSuite(), () => {
  let tdb; let pool; let today; let ctx;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    today = await pgTime.today(pool);
    ctx = await context(pool, today);
  });
  after(async () => {
    assert.equal(pool.waitingCount, 0, 'nobody is still waiting for a connection');
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });

  test('every scenario gives the same outcome on SQLite (src/assignments.js) and PostgreSQL', async () => {
    const sqlite = buildSqliteReference();
    const sq = fx.sqliteExecutor(sqlite);
    try {
      const sqCtx = await context(sq, today);
      for (const [name, build] of SCENARIOS) {
        const pgIn = await build(pool, ctx);
        const sqIn = await build(sq, sqCtx);
        const pgOut = await outcome(() => assignments.createAssignment(pool, pgIn));
        const sqOut = await outcome(() => sqliteAssignments.createAssignment(sqlite, sqIn));
        if ('ok' in sqOut) {
          assert.ok('ok' in pgOut, `${name}: PostgreSQL refused with ${pgOut.message}`);
          assert.deepEqual(await summary(pool, pgOut.ok, pgIn), await summary(sq, sqOut.ok, sqIn), name);
        } else {
          assert.deepEqual(errOf(pgOut), errOf(sqOut), name);
        }
      }
    } finally {
      sqlite.close();
    }
  });

  test('validation order and messages', async () => {
    const a = await fx.insertAsset(pool);
    const call = (input) => outcome(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.holder.id, actorIsAdmin: true, ...input }));
    assert.deepEqual(errOf(await call({ actorIsAdmin: false, type: 'permanent' })), { status: 403, message: 'Permanent assignments need IT approval. Send IT a request instead.' });
    assert.deepEqual(errOf(await call({ type: 'checkout' })), { status: 400, message: 'A temporary checkout needs a return date.' });
    assert.deepEqual(errOf(await call({ type: 'checkout', dueDate: '20261120' })), { status: 400, message: 'Return date must be a valid date.' });
    assert.deepEqual(errOf(await call({ type: 'checkout', dueDate: ctx.tomorrow, dueTime: '9:30' })), { status: 400, message: 'Return time must be a valid time (HH:MM).' });
    assert.deepEqual(errOf(await call({ type: 'forever' })), { status: 400, message: 'Assignment type must be permanent or checkout' });
    assert.deepEqual(errOf(await call({ assetId: 'abc' })), { status: 404, message: 'Asset not found' });
    assert.deepEqual(errOf(await call({ assetId: 999999, employeeId: 'nobody' })), { status: 404, message: 'Asset not found' });
    assert.deepEqual(errOf(await call({ employeeId: 'nobody' })), { status: 400, message: 'Choose who this is going to' });
    const archived = await fx.insertAsset(pool, { archived_at: '2026-01-01 00:00:00', status: 'retired' });
    assert.deepEqual(errOf(await call({ assetId: archived.id, employeeId: 999999 })), { status: 400, message: 'Choose who this is going to' }, 'employee before archived');
    assert.deepEqual(errOf(await call({ assetId: archived.id })), { status: 400, message: 'This asset is archived and can\'t be checked out.' }, 'archived before status');
    assert.equal((await pool.query('SELECT COUNT(*) c FROM assignments WHERE asset_id = $1', [a.id])).rows[0].c, 0, 'nothing was assigned');
  });

  test('permanent vs checkout rows, status, condition and activity text', async () => {
    const a = await fx.insertAsset(pool, { condition: 'Good' });
    const { assignment, asset, employee } = await assignments.createAssignment(pool, {
      assetId: a.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: '2026-11-20', dueTime: '14:30', notes: 'For the trip', condition: 'Fair',
    });
    assert.deepEqual([assignment.assignment_type, assignment.due_date, assignment.due_time, assignment.condition_out, assignment.notes, assignment.checked_out_by, assignment.returned_at],
      ['checkout', '2026-11-20', '14:30', 'Fair', 'For the trip', ctx.adminAccount.id, null]);
    assert.match(assignment.checked_out_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual([asset.status, asset.condition], ['checked_out', 'Fair']);
    assert.equal(employee.id, ctx.holder.id);
    const act = (await pool.query("SELECT * FROM activity WHERE asset_id = $1 AND action = 'checked_out'", [a.id])).rows;
    assert.equal(act.length, 1);
    assert.equal(act[0].details, 'To Hana Holder · Temporary checkout · return by 2026-11-20 14:30 · For the trip');
    assert.deepEqual([act[0].actor_id, act[0].subject_user_id], [ctx.adminAccount.id, ctx.holder.id]);

    const p = await fx.insertAsset(pool, { license_seats: 3, condition: 'New' });
    const perm = await assignments.createAssignment(pool, { assetId: p.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'permanent', dueDate: '2026-11-20' });
    assert.deepEqual([perm.assignment.due_date, perm.assignment.due_time, perm.assignment.condition_out, perm.asset.status], [null, null, 'New', 'available'], 'one of three seats');
    assert.equal((await pool.query("SELECT details FROM activity WHERE asset_id = $1 AND action = 'checked_out'", [p.id])).rows[0].details, 'To Hana Holder · Permanent');
  });

  test('refreshStatus follows the active count, leaves maintenance/retired alone, and accepts a transaction client', async () => {
    const a = await fx.insertAsset(pool, { license_seats: 2 });
    const s1 = await fx.insertAssignment(pool, { asset_id: a.id, employee_id: ctx.other.id });
    await assignments.refreshStatus(pool, a.id);
    assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status, 'available');
    await fx.insertAssignment(pool, { asset_id: a.id, employee_id: ctx.third.id });
    await withTransaction((c) => assignments.refreshStatus(c, a.id), pool);
    assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status, 'checked_out');
    await pool.query("UPDATE assignments SET returned_at = '2026-01-02 00:00:00' WHERE id = $1", [s1.id]);
    await assignments.refreshStatus(pool, a.id);
    assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status, 'available');
    const m = await fx.insertAsset(pool, { status: 'maintenance' });
    await assignments.refreshStatus(pool, m.id);
    assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [m.id])).rows[0].status, 'maintenance');
    await assignments.refreshStatus(pool, 999999); // unknown: nothing happens
  });

  test('time-aware reservation guard (noon return vs 1 PM pickup passes; overlap is 409; own reservation does not block)', async () => {
    const a = await fx.insertAsset(pool);
    const r = await fx.insertReservation(pool, { asset_id: a.id, employee_id: ctx.other.id, start_date: today, start_time: '13:00', end_time: '17:00' });
    const base = { assetId: a.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: today };
    assert.deepEqual(errOf(await outcome(() => assignments.createAssignment(pool, { ...base, employeeId: ctx.holder.id, dueTime: '13:01' }))),
      { status: 409, message: `This item is reserved ${T.when(r)}, so it can't be checked out through then. Cancel the reservation first, or choose an earlier return date.` });
    const ok = await assignments.createAssignment(pool, { ...base, employeeId: ctx.holder.id, dueTime: '13:00' });
    assert.equal(ok.assignment.due_time, '13:00', 'touching at 1:00 PM is not overlapping');
    const b = await fx.insertAsset(pool);
    await fx.insertReservation(pool, { asset_id: b.id, employee_id: ctx.other.id, start_date: today, start_time: '13:00', end_time: '17:00' });
    assert.ok(await assignments.createAssignment(pool, { ...base, assetId: b.id, employeeId: ctx.other.id, dueTime: '18:00' }), 'the reservation owner is not blocked by their own');
  });

  test('waitlist hold guard: another\'s hold blocks only its interval; the owner\'s checkout fulfils it with a waitlist_checked_out row', async () => {
    const a = await fx.insertAsset(pool);
    const hold = await fx.insertWaitlistEntry(pool, { asset_id: a.id, employee_id: ctx.other.id, start_date: ctx.tomorrow, start_time: '09:00', end_time: '12:00', status: 'held' });
    const base = { assetId: a.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'checkout' };
    assert.deepEqual(errOf(await outcome(() => assignments.createAssignment(pool, { ...base, dueDate: ctx.tomorrow, dueTime: '09:30' }))),
      { status: 409, message: `This item is being held for another employee ${T.when(hold)}, so it can't be checked out through then. Choose a return before the hold starts, or wait for the offer to be answered.` });
    assert.equal((await outcome(() => assignments.createAssignment(pool, { ...base, dueDate: ctx.tomorrow, dueTime: '09:00' }))).ok.assignment.due_time, '09:00', 'back exactly when the hold starts');

    const b = await fx.insertAsset(pool);
    const own = await fx.insertWaitlistEntry(pool, { asset_id: b.id, employee_id: ctx.holder.id, start_date: ctx.tomorrow, status: 'held' });
    await assignments.createAssignment(pool, { ...base, assetId: b.id, dueDate: T.addDays(today, 2) });
    const closed = (await pool.query('SELECT * FROM waitlist_entries WHERE id = $1', [own.id])).rows[0];
    assert.deepEqual([closed.status, closed.closed_by], ['fulfilled', ctx.adminAccount.id]);
    assert.match(closed.closed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const rows = (await pool.query('SELECT action, details, actor_id, subject_user_id FROM activity WHERE asset_id = $1 ORDER BY id', [b.id])).rows;
    assert.deepEqual(rows.map((r) => r.action), ['waitlist_checked_out', 'checked_out']);
    assert.equal(rows[0].details, `${T.when(own)} · checked out in person, so the availability offer is accepted`);
    assert.deepEqual([rows[0].actor_id, rows[0].subject_user_id], [ctx.adminAccount.id, ctx.holder.id]);
  });

  test('pending waitlist-born reservation guard', async () => {
    const a = await fx.insertAsset(pool);
    const w = await fx.insertWaitlistEntry(pool, { asset_id: a.id, employee_id: ctx.other.id, start_date: ctx.tomorrow, status: 'fulfilled' });
    const r = await fx.insertReservation(pool, { asset_id: a.id, employee_id: ctx.other.id, start_date: ctx.tomorrow, end_time: '12:00', status: 'pending', waitlist_entry_id: w.id });
    assert.deepEqual(errOf(await outcome(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: ctx.tomorrow }))),
      { status: 409, message: `This item is being held for another employee ${T.when(r)} (waiting for IT approval), so it can't be checked out through then.` });
    assert.ok(await assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.holder.id, actorIsAdmin: true, type: 'checkout', dueDate: today }), 'back before it starts');
  });

  test('inside an outer transaction it joins it (request approval): a later failure rolls back the assignment too', async () => {
    const a = await fx.insertAsset(pool);
    const r = await fx.insertRequest(pool, { user_id: ctx.holder.id, asset_id: a.id, requested_assignment_type: 'permanent' });
    await assert.rejects(withTransaction(async (c) => {
      await assignments.createAssignment(c, { assetId: a.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'permanent' });
      await requests.transition(c, r.id, 'completed', { actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, assetId: a.id });
      throw new Error('mail server exploded');
    }, pool), /exploded/);
    assert.equal((await pool.query('SELECT COUNT(*) c FROM assignments WHERE asset_id = $1', [a.id])).rows[0].c, 0);
    assert.equal((await pool.query('SELECT status FROM requests WHERE id = $1', [r.id])).rows[0].status, 'open');
    assert.equal((await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status, 'available');

    const made = await withTransaction(async (c) => {
      const m = await assignments.createAssignment(c, { assetId: a.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'permanent' });
      await requests.transition(c, r.id, 'completed', { actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, assetId: a.id });
      return m.assignment;
    }, pool);
    assert.equal(made.asset_id, a.id);
    assert.equal((await pool.query('SELECT status FROM requests WHERE id = $1', [r.id])).rows[0].status, 'completed');

    await assert.rejects(withTransaction(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.other.id, actorIsAdmin: true }), pool), /cannot be nested/,
      'passing the pool from inside a transaction is refused, not silently run outside it');
  });

  // ---------------------------------------------------------------- concurrency
  // Polls the active count on its own connection while a race runs; returns the highest value seen.
  function sampleActive(assetId) {
    const sampler = tdb.newPool({ max: 1 });
    let max = 0; let running = true;
    const loop = (async () => {
      while (running) {
        const c = (await sampler.query('SELECT COUNT(*) c FROM assignments WHERE asset_id = $1 AND returned_at IS NULL', [assetId])).rows[0].c;
        if (c > max) max = c;
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    return async () => { running = false; await loop; await sampler.end(); return max; };
  }

  test('(a) 9 simultaneous checkouts of a 3-seat license: exactly 3 succeed, the rest are told the seats are full (repeated)', async () => {
    const people = [];
    for (let i = 0; i < 9; i++) people.push(await fx.insertEmployee(pool, { name: `Seat Taker ${i}` }));
    for (let round = 0; round < 5; round++) {
      const lic = await fx.insertAsset(pool, { name: `License ${round}`, license_seats: 3 });
      const stop = sampleActive(lic.id);
      const results = await Promise.all(people.map((p) => outcome(() => assignments.createAssignment(pool, {
        assetId: lic.id, employeeId: p.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'permanent',
      }))));
      const maxSeen = await stop();
      const won = results.filter((r) => 'ok' in r);
      const lost = results.filter((r) => !('ok' in r));
      assert.equal(won.length, 3, `round ${round}: exactly three seats were handed out`);
      for (const l of lost) assert.deepEqual(errOf(l), { status: 400, message: SEATS_FULL });
      assert.ok(maxSeen <= 3, `round ${round}: the active count never exceeded the seats (max seen ${maxSeen})`);
      const db = (await pool.query("SELECT (SELECT COUNT(*) FROM assignments WHERE asset_id = $1 AND returned_at IS NULL) AS active, (SELECT COUNT(*) FROM activity WHERE asset_id = $1 AND action = 'checked_out') AS logged, (SELECT status FROM assets WHERE id = $1) AS status", [lic.id])).rows[0];
      assert.deepEqual(db, { active: 3, logged: 3, status: 'checked_out' });
      assert.deepEqual(won.map((w) => w.ok.asset.status).sort(), ['available', 'available', 'checked_out'], 'the third seat flips the asset to checked_out');
    }
  });

  test('(b) single-seat asset, 2 simultaneous callers: exactly one wins (repeated)', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await fx.insertAsset(pool);
      const results = await Promise.all([ctx.holder, ctx.other].map((p) => outcome(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: p.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true }))));
      const won = results.filter((r) => 'ok' in r);
      assert.equal(won.length, 1);
      const winner = won[0].ok.employee.name;
      assert.deepEqual(errOf(results.find((r) => !('ok' in r))), { status: 400, message: `Already checked out to ${winner}. Check it in first.` });
      assert.equal((await pool.query('SELECT COUNT(*) c FROM assignments WHERE asset_id = $1 AND returned_at IS NULL', [a.id])).rows[0].c, 1);
    }
  });

  test('(c) the same employee twice at once: one wins, the other is told they already have it (repeated)', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await fx.insertAsset(pool, { license_seats: 4 });
      const call = () => outcome(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true }));
      const results = await Promise.all([call(), call()]);
      assert.equal(results.filter((r) => 'ok' in r).length, 1);
      assert.deepEqual(errOf(results.find((r) => !('ok' in r))), { status: 400, message: 'Hana Holder already has this asset.' });
    }
  });

  test('(d) a failure mid-transaction rolls back the assignment, its activity, the hold closure and the status change', async () => {
    // A foreign-key failure (unknown actor account) at the INSERT.
    const a = await fx.insertAsset(pool, { condition: 'Good' });
    const fk = await outcome(() => assignments.createAssignment(pool, { assetId: a.id, employeeId: ctx.holder.id, actorAccountId: 999999, actorIsAdmin: true, condition: 'Dented' }));
    assert.equal(fk.code, '23503');
    // A failure at the very last statement, after the assignment, the hold closure, the condition and the status were written.
    const b = await fx.insertAsset(pool, { condition: 'Good' });
    const own = await fx.insertWaitlistEntry(pool, { asset_id: b.id, employee_id: ctx.holder.id, start_date: ctx.tomorrow, status: 'held' });
    await pool.query(`CREATE FUNCTION fail_checked_out() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'checked_out' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER fail_checked_out BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION fail_checked_out()');
    try {
      const late = await outcome(() => assignments.createAssignment(pool, { assetId: b.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true, type: 'checkout', dueDate: T.addDays(today, 3), condition: 'Dented' }));
      assert.match(late.message, /injected failure/);
    } finally {
      await pool.query('DROP TRIGGER fail_checked_out ON activity');
      await pool.query('DROP FUNCTION fail_checked_out()');
    }
    for (const asset of [a, b]) {
      const st = (await pool.query(`SELECT (SELECT COUNT(*) FROM assignments WHERE asset_id = $1) AS assignments, (SELECT COUNT(*) FROM activity WHERE asset_id = $1) AS activity,
        status, condition FROM assets WHERE id = $1`, [asset.id])).rows[0];
      assert.deepEqual(st, { assignments: 0, activity: 0, status: 'available', condition: 'Good' }, `asset ${asset.tag} is untouched`);
    }
    assert.equal((await pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [own.id])).rows[0].status, 'held', 'the hold is still open');
    assert.ok(await assignments.createAssignment(pool, { assetId: b.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true }), 'and the asset is still assignable');
  });

  test('(e) assignments on different assets proceed independently; the same asset waits for the lock', async () => {
    for (let round = 0; round < 3; round++) {
      const busy = await fx.insertAsset(pool);
      const free = await fx.insertAsset(pool);
      let release; let signal;
      const mayEnd = new Promise((r) => { release = r; });
      const locked = new Promise((r) => { signal = r; });
      const holder = withTransaction(async (c) => { await lockAsset(c, busy.id); signal(); await mayEnd; }, pool);
      await locked;
      try {
        const started = Date.now();
        const other = await assignments.createAssignment(pool, { assetId: free.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true });
        assert.equal(other.asset.status, 'checked_out', 'a different asset is assigned while the first is locked');
        assert.ok(Date.now() - started < 2000);

        let waiterPid = null;
        const waiter = withTransaction(async (c) => {
          waiterPid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
          return assignments.createAssignment(c, { assetId: busy.id, employeeId: ctx.holder.id, actorAccountId: ctx.adminAccount.id, actorIsAdmin: true });
        }, pool);
        await waitFor(async () => waiterPid !== null && (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [waiterPid])).rows[0]?.wait_event_type === 'Lock', 'the same-asset caller to wait on the lock');
        release();
        await holder;
        assert.equal((await waiter).asset.status, 'checked_out', 'and proceeds once the lock is released');
      } finally {
        release();
        await holder;
      }
    }
  });
});
