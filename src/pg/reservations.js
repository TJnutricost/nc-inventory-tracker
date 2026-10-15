// Asset reservations on PostgreSQL (D-46, migration Slice 4A: the READ half). The PG counterpart of src/reservations.js; NOT
// used by the running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages
// (read the header of src/reservations.js); every function is async and takes an executor `q` (a pg Pool or a transaction
// client) where the SQLite version takes `db`.
//
// Reads (Slice 4A): findBlockers, plan, hasOwnOverlap, hasOwnHold, loadAsset, emailOf, todayOf.
// Writes (Slice 4B): create, approve, decline, cancel, shorten, insertReservation, note. Ported statement for statement from
// src/reservations.js: same checks in the same order, same activity actions and wording, same order of writes.
//
// Writes: locking, transactions, effects (Slice 4B, D-47).
//   - Every write function joins a caller's transaction when given its client (the createAssignment pattern:
//     isInTransaction(q) ? run(q) : withTransaction(run, q)); a POOL passed from inside a transaction is refused as nesting by
//     withTransaction. Joined, its effects fire at that outer transaction's COMMIT (there is only one transaction). The caller
//     must not have read or written this asset's dependent rows before calling: the function takes the asset lock itself
//     (re-locking a row the same transaction already holds is a no-op).
//   - Lock first, re-read under the lock (Slice 2 ordering rule). create: the first statement after BEGIN is lockAsset, then
//     waitlist.classify on the transaction client, then the inserts. approve / decline / cancel / shorten: ONE unlocked
//     `SELECT asset_id FROM reservations WHERE id = $1` (only to learn which asset to lock; none -> 404), then lockAsset, then
//     the reservation is loaded AGAIN under the lock and every check runs against that fresh row. One asset per transaction.
//   - The compare-and-set UPDATEs (`... WHERE status = 'pending'`, rowCount 0 -> 409 "just updated by someone else") are kept.
//     Under the lock and the fresh re-read a locked writer can never reach them, so a concurrent loser gets the STATUS message
//     (400), exactly like SQLite's BEGIN IMMEDIATE serialization; the 409 remains as defense in depth against a writer that
//     skips the lock.
//   - insertReservation requires the asset lock (assertAssetLock, code ASSET_LOCK_REQUIRED).
//   - Email: none here. create registers `waitlist_joined` (one per distinct blocking reserver, only when something was
//     waitlisted) and `request_recorded` effects after its writes, in the order SQLite sent those emails; decline / cancel /
//     shorten re-evaluate the queue (waitlist.evaluateAsset), which registers `holds_owed` when it grants a hold. Effects fire
//     only after COMMIT, through the injected notifier (src/pg/effects.js).
//   - Accepted: an employee deactivated concurrently is not locked against (the outcome is simply "before" or "after");
//     lock_timeout and pool sizing are Slice 5 (a transaction waiting for an asset lock holds one of the pool's connections).
//
// Pure helpers (LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, whyBlocked, phaseOf, fmt, span, when) are
// imported from src/reservations.js and reserveEligibility from src/availability.js; neither touches a database at load time
// (src/reservations.js only requires its mailer lazily, inside the write paths, which this module never calls). They move
// here at cutover.
//
// SQL differences from SQLite (each one keeps the output identical):
//   - `ORDER BY start_date, start_time, id` -> `start_time NULLS FIRST` (SQLite sorts NULL first ascending, PostgreSQL last):
//     an untimed reservation/hold that starts the same day comes first, so the same blocker is named first.
//   - The open-assignment query had no ORDER BY in SQLite (rowid order in practice); it is `ORDER BY id` here.
//   - `datetime('now')` -> NOW from src/pg/time.js (same truncated UTC text, compared as text).
//   - Ids that are not integers in the column's range find nothing (SQLite) instead of raising a PG 22P02/22003.
//
// Consistency: these are multi-statement reads in READ COMMITTED, not one snapshot (SQLite effectively was one). They are
// advisory on their own. Concurrency rule for Slices 4B/4C: every write path takes the asset lock first (lockAsset, Slice 2)
// and then calls findBlockers / plan / hasOwnOverlap / hasOwnHold with its TRANSACTION CLIENT, so they re-read the dependent
// rows under the lock. Nothing here opens a transaction, so a call from inside a caller's transaction stays on that client.
const crypto = require('crypto');
const base = require('../reservations');
const T = require('../timeRange');
const { reserveEligibility } = require('../availability');
const time = require('./time');
const { withTransaction, lockAsset, isInTransaction, assertAssetLock } = require('./transaction');
const { registerEffect } = require('./effects');

const { LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, whyBlocked, phaseOf, fmt, span, when } = base;
const { NOW } = time;
const waitlist = () => require('./waitlist'); // (lazily: it requires this module)
const INT4_MAX = 2147483647;
// An id as the integer column accepts it, or null (PostgreSQL would raise 22P02/22003 where SQLite simply finds no row).
const toId = (v) => { const n = Number(v); return v !== null && v !== '' && typeof v !== 'boolean' && Number.isSafeInteger(n) && Math.abs(n) <= INT4_MAX ? n : null; };

const todayOf = (q) => time.today(q);

// Everything that makes this asset UNAVAILABLE for part or all of `range`, as [{ kind, row, sk, ek }] in time order (see
// src/reservations.js findBlockers). `excludeId` = the reservation being (re)checked; `ignoreHoldId` = the hold being confirmed.
async function findBlockers(q, asset, range, { today, excludeId = 0, ignoreHoldId = 0 } = {}) {
  const want = T.keysOf(range);
  const near = (rows) => rows.filter((r) => T.overlaps(want, T.keysOf(r)));
  const out = [];
  const resv = (await q.query(`SELECT * FROM reservations WHERE asset_id = $1 AND id <> $2 AND start_date <= $3 AND end_date >= $4
    AND (status = 'confirmed' OR (status = 'pending' AND waitlist_entry_id IS NOT NULL)) ORDER BY start_date, start_time NULLS FIRST, id`,
  [asset.id, toId(excludeId) ?? 0, range.end_date, range.start_date])).rows;
  for (const r of near(resv)) out.push({ kind: r.status === 'confirmed' ? 'reservation' : 'pending_hold', row: r, ...T.keysOf(r) });
  const holds = (await q.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' AND hold_expires_at > ${NOW} AND id <> $2 AND start_date <= $3 AND end_date >= $4
    ORDER BY start_date, start_time NULLS FIRST, id`, [asset.id, toId(ignoreHoldId) ?? 0, range.end_date, range.start_date])).rows;
  for (const h of near(holds)) out.push({ kind: 'hold', row: h, ...T.keysOf(h) });
  for (const a of (await q.query('SELECT * FROM assignments WHERE asset_id = $1 AND returned_at IS NULL ORDER BY id', [asset.id])).rows) {
    const bounded = a.assignment_type === 'checkout' && a.due_date && a.due_date >= today;
    const ek = bounded ? T.endKey(a.due_date, a.due_time) : T.INF_KEY;
    if (want.sk < ek) out.push({ kind: 'checkout', row: a, sk: '0000-01-01T00:00', ek });
  }
  return out.sort((x, y) => (x.sk < y.sk ? -1 : x.sk > y.sk ? 1 : 0));
}
// What the request would become: { blockers, free, busy } (free = ranges to reserve, busy = ranges to waitlist).
const plan = async (q, asset, range, opts) => { const blockers = await findBlockers(q, asset, range, opts); return { blockers, ...T.splitFree(range, blockers) }; };

const loadAsset = async (q, id) => (await q.query('SELECT * FROM assets WHERE id = $1', [toId(id)])).rows[0];
// A person's name / address for an email (their work email, else their active login).
const emailOf = async (q, employeeId) => {
  const r = (await q.query(`SELECT e.name, COALESCE(e.work_email, a.login_email) AS email, e.department FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id AND a.active = 1 WHERE e.id = $1`, [toId(employeeId)])).rows[0];
  return r || { name: '', email: null, department: null };
};

// Would this person be double-booking THEMSELVES?
const hasOwnOverlap = async (q, assetId, employeeId, range) =>
  (await q.query(`SELECT * FROM reservations WHERE asset_id = $1 AND employee_id = $2 AND status IN ('pending','confirmed') AND start_date <= $3 AND end_date >= $4`,
    [toId(assetId), toId(employeeId), range.end_date, range.start_date])).rows.some((r) => T.overlapsRows(r, range));
const hasOwnHold = async (q, assetId, employeeId, range) =>
  (await q.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND employee_id = $2 AND status = 'held' AND hold_expires_at > ${NOW} AND start_date <= $3 AND end_date >= $4`,
    [toId(assetId), toId(employeeId), range.end_date, range.start_date])).rows.some((r) => T.overlapsRows(r, range));

// ---- writes (Slice 4B)
// Joins the caller's transaction when `q` is a transaction client, else opens one on the pool.
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));

const note = (q, assetId, actorAccountId, action, details, employeeId) =>
  q.query('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES ($1, $2, $3, $4, $5)', [assetId, actorAccountId ?? null, employeeId ?? null, action, details]);
const load = async (q, id) => {
  const r = (await q.query('SELECT * FROM reservations WHERE id = $1', [toId(id)])).rows[0];
  if (!r) throw httpError(404, 'Reservation not found');
  return r;
};
// The one unlocked read a reservation write may do before the lock: which asset to lock. Then lock it.
async function lockReservationAsset(c, id) {
  const row = (await c.query('SELECT asset_id FROM reservations WHERE id = $1', [toId(id)])).rows[0];
  if (!row) throw httpError(404, 'Reservation not found');
  return lockAsset(c, row.asset_id);
}

// The one place a reservation row is written, shared by create() and by confirming a waitlist hold (Slice 4C). Needs the
// asset lock; the caller has already done its own eligibility checks.
async function insertReservation(c, asset, { employeeId, actorAccountId, start, end, startTime = null, endTime = null, waitlistEntryId = null, requestGroup = null }) {
  assertAssetLock(c, asset.id);
  const needs = asset.reservation_requires_approval ? 1 : 0;
  const row = (await c.query(`INSERT INTO reservations (asset_id, employee_id, start_date, start_time, end_date, end_time, status, requires_approval, created_by, waitlist_entry_id, request_group)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [asset.id, employeeId, start, startTime, end, endTime, needs ? 'pending' : 'confirmed', needs, actorAccountId ?? null, waitlistEntryId, requestGroup])).rows[0];
  await note(c, asset.id, actorAccountId, needs ? 'reservation_requested' : 'reserved', `${when(rangeOf(start, end, startTime, endTime))}${needs ? ' · waiting for IT approval' : ''}${waitlistEntryId ? ' · from the waitlist' : ''}`, employeeId);
  return row;
}

// One request, one range -> reservation(s) for the free time and waitlist entries for the unavailable time (see
// src/reservations.js create). Returns { request_group, requested, reserved, waitlisted }. A request with NO free time is
// refused (409). The decision is waitlist.classify(), re-made here under the asset lock on the transaction client.
async function create(q, { assetId, employeeId, actorAccountId, start, end, startTime, endTime }) {
  const group = crypto.randomUUID();
  const run = async (c) => {
    const wl = waitlist();
    const key = toId(assetId);
    if (key === null || key < 1) throw httpError(404, 'Asset not found'); // (SQLite: classify finds no asset)
    let asset;
    try {
      asset = await lockAsset(c, key);
    } catch (err) {
      if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
      throw err;
    }
    const cl = await wl.classify(c, { assetId, employeeId, start, end, startTime, endTime });
    if (cl.outcome === 'waitlist') throw httpError(409, `${cl.message} Join the waitlist for that time instead.`);
    if (cl.outcome !== 'reserve' && cl.outcome !== 'partial') throw httpError(cl.status, cl.message);
    const requested = rangeOf(start, end, cl.start_time, cl.end_time);
    const reserved = [];
    for (const f of cl.free) reserved.push(await insertReservation(c, asset, { employeeId, actorAccountId, start: f.start_date, end: f.end_date, startTime: f.start_time, endTime: f.end_time, requestGroup: group }));
    const waitlisted = [];
    for (const b of cl.busy) waitlisted.push(await wl.insertEntry(c, { assetId: asset.id, employeeId, actorAccountId, range: b, requestGroup: group }));
    // after the writes: the emails SQLite sends after its commit, in the same order
    if (waitlisted.length) wl.announceJoined(c, employeeId, asset.id, waitlisted, cl.reservers);
    registerEffect(c, { type: 'request_recorded', employeeId, assetId: asset.id, requested, reserved, waitlisted });
    return { request_group: group, requested, reserved, waitlisted };
  };
  return inTransaction(q, run);
}

// IT approves a pending reservation. Eligibility, the person, the start date and the WHOLE range are checked again under the
// lock: if anything has taken that time (or the asset is no longer reservable) approval fails with 409 and the row stays pending.
async function approve(q, id, { actorAccountId, note: text }) {
  return inTransaction(q, async (c) => {
    const asset = await lockReservationAsset(c, id);
    const r = await load(c, id);
    if (r.status !== 'pending') throw httpError(400, r.status === 'cancelled' ? 'This reservation was cancelled.' : 'This reservation has already been decided.');
    const today = await todayOf(c);
    const el = reserveEligibility(asset);
    if (!el.ok) throw httpError(409, el.hidden ? "Can't approve: this item is no longer available to request." : `Can't approve: ${el.reason}`);
    const emp = (await c.query('SELECT status FROM employees WHERE id = $1', [r.employee_id])).rows[0];
    if (!emp || emp.status !== 'active') throw httpError(409, "Can't approve: that person is inactive.");
    if (r.start_date < today) throw httpError(409, "Can't approve: the start date has already passed. Decline it so they can book again.");
    const blocked = (await findBlockers(c, asset, r, { excludeId: r.id, today }))[0];
    if (blocked) throw httpError(409, `Can't approve: ${whyBlocked(blocked, today)} Decline it or ask the employee to choose other dates.`);
    const info = await c.query(`UPDATE reservations SET status = 'confirmed', decided_by = $1, decided_at = ${NOW}, decision_note = $2, updated_at = ${NOW} WHERE id = $3 AND status = 'pending'`,
      [actorAccountId ?? null, text || null, r.id]);
    if (!info.rowCount) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    await note(c, r.asset_id, actorAccountId, 'reservation_approved', `${when(r)}${text ? ` · ${text}` : ''}`, r.employee_id);
    return load(c, r.id);
  });
}

async function decline(q, id, { actorAccountId, note: text }) {
  return inTransaction(q, async (c) => {
    await lockReservationAsset(c, id);
    const r = await load(c, id);
    if (r.status !== 'pending') throw httpError(400, r.status === 'cancelled' ? 'This reservation was cancelled.' : 'This reservation has already been decided.');
    const info = await c.query(`UPDATE reservations SET status = 'declined', decided_by = $1, decided_at = ${NOW}, decision_note = $2, updated_at = ${NOW} WHERE id = $3 AND status = 'pending'`,
      [actorAccountId ?? null, text || null, r.id]);
    if (!info.rowCount) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    await note(c, r.asset_id, actorAccountId, 'reservation_declined', `${when(r)}${text ? ` · ${text}` : ''}`, r.employee_id);
    await waitlist().evaluateAsset(c, r.asset_id); // (a declined reservation made from a waitlist hold gives its dates back to the queue)
    return load(c, r.id);
  });
}

// An employee cancels their OWN live reservation while any part of it is still ahead; IT may cancel a CONFIRMED one.
async function cancel(q, id, { actorAccountId, employeeId, isAdmin }) {
  return inTransaction(q, async (c) => {
    await lockReservationAsset(c, id);
    const r = await load(c, id);
    if (!isAdmin && r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (!LIVE.includes(r.status)) throw httpError(400, 'This reservation is already closed.');
    if (isAdmin && r.status === 'pending') throw httpError(400, "A pending reservation can't be cancelled by IT. Decline it instead.");
    if (r.end_date < await todayOf(c)) throw httpError(400, 'This reservation is already over.');
    const info = await c.query(`UPDATE reservations SET status = 'cancelled', cancelled_by = $1, cancelled_at = ${NOW}, updated_at = ${NOW} WHERE id = $2 AND status IN ('pending','confirmed')`, [actorAccountId ?? null, r.id]);
    if (!info.rowCount) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    await note(c, r.asset_id, actorAccountId, 'reservation_cancelled', `${when(r)}${isAdmin && r.employee_id !== employeeId ? ' · cancelled by IT' : ''}`, r.employee_id);
    await waitlist().evaluateAsset(c, r.asset_id);
    return load(c, r.id);
  });
}

// An employee moves the END of their own CONFIRMED reservation earlier (see src/reservations.js shorten). The return time is
// validated before the transaction, as in SQLite, so error precedence is unchanged.
async function shorten(q, id, { actorAccountId, employeeId, newEnd, newEndTime }) {
  const endTime = T.cleanTime(newEndTime, 'return time');
  return inTransaction(q, async (c) => {
    await lockReservationAsset(c, id);
    const r = await load(c, id);
    if (r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (r.status === 'pending') throw httpError(400, 'This reservation is waiting for IT. Cancel it and submit a new one to change the dates.');
    if (r.status !== 'confirmed') throw httpError(400, 'This reservation is already closed.');
    const today = await todayOf(c);
    const endDate = newEnd === undefined || newEnd === null || newEnd === '' ? r.end_date : newEnd;
    if (!validDate(endDate)) throw httpError(400, 'Choose a valid end date.');
    if (r.end_date < today) throw httpError(400, 'This reservation is already over.');
    const was = T.endKey(r.end_date, r.end_time); const now = T.endKey(endDate, endTime);
    const timed = !!(r.end_time || endTime || r.start_time);
    if (now === was) throw httpError(400, timed ? 'That is already the return date and time.' : 'That is already the end date.');
    if (now > was) throw httpError(400, `You can only shorten a reservation. To keep it longer, make a new reservation for the extra ${timed ? 'time' : 'days'}.`);
    if (endDate < r.start_date) throw httpError(400, "The end date can't be before the start date. Cancel the reservation instead.");
    if (now <= T.startKey(r.start_date, r.start_time)) throw httpError(400, "The return can't be at or before the pickup. Cancel the reservation instead.");
    if (endDate < today) throw httpError(400, "The end date can't be in the past.");
    const info = await c.query(`UPDATE reservations SET end_date = $1, end_time = $2, updated_at = ${NOW} WHERE id = $3 AND status = 'confirmed' AND end_date = $4 AND end_time IS NOT DISTINCT FROM $5`,
      [endDate, endTime, r.id, r.end_date, r.end_time]);
    if (!info.rowCount) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    const at = (d, t) => `${fmt(d)}${t ? ` ${T.fmtTime(t)}` : ''}`;
    await note(c, r.asset_id, actorAccountId, 'reservation_shortened', `${fmt(r.start_date)}: end ${at(r.end_date, r.end_time)} → ${at(endDate, endTime)}`, r.employee_id);
    await waitlist().evaluateAsset(c, r.asset_id);
    return load(c, r.id);
  });
}

module.exports = {
  LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, reserveEligibility, findBlockers, plan, whyBlocked, hasOwnOverlap, hasOwnHold, loadAsset, emailOf,
  fmt, span, when, phaseOf, todayOf, toId,
  note, insertReservation, create, approve, decline, cancel, shorten,
};
