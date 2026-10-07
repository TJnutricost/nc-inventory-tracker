// Asset reservations (Phase 2, slice 7; times added in slice 8.1). A reservation is a claim on ONE physical asset for a range of CALENDAR DATES,
// inclusive at both ends ("Oct 10 to Oct 12" holds the 10th, 11th and 12th), with an OPTIONAL pickup time on the first date and an OPTIONAL return
// time on the last (src/timeRange.js owns the storage and comparison rules). Dates are plain YYYY-MM-DD strings and times plain HH:MM wall-clock
// strings, so there is no timezone arithmetic; "today" is the server's date, like the rest of the app (see availability.js).
//
// SLICE 8.1 PRODUCT RULE: unavailable time is WAITLIST time, never reservation time. findBlockers() lists everything that makes the asset unavailable
// during a requested range (a confirmed reservation, an active hold, a waitlist-born reservation still awaiting IT, a checkout); T.splitFree() cuts the one
// range an employee asked for into the part that is FREE and the part that is NOT. The free pieces are reserved and the unavailable pieces are waitlisted,
// all from the same request (they share a `request_group`). A fully free request is only reserved; a fully unavailable one is only waitlisted (and is
// refused here, because that is what "Join waitlist" is for). Waitlist entries themselves are demand, not possession: they never block anyone.
// What still refuses: the asset or the person is ineligible, the dates are invalid or in the past, the SAME employee would double-book themselves.
//
//   status    pending    waiting for IT (the asset has "Require approval for reservations" on). Shown to its owner and IT only; it does not hold the time
//                        (unless it was made from a waitlist hold) and approving it is refused if the time has since been taken.
//             confirmed  scheduled: it shows on the calendar ("reserved" / "partially scheduled"), makes that time unavailable to everyone else (they are
//                        waitlisted for it) and keeps the waitlist from offering that time to the next person in line.
//             declined   IT said no.        cancelled  the employee (or IT) withdrew it.
//   pending -> confirmed | declined | cancelled      confirmed -> cancelled (or its END date/time shortened; never extended or moved)
//
// What may be reserved: a non-archived, single-seat asset in a lendable state (not repair / retired / lost / disposed) that IT has made
// `available_to_request`. What makes time unavailable is findBlockers() below: a CONFIRMED reservation, an
// ACTIVE hold, a pending reservation made from a waitlist hold, or an open checkout that is still out when the requested time starts (a permanent
// assignment, an overdue checkout, or a temporary checkout up to its due date AND due time). The time AFTER a checkout is due back is only "expected
// back" in the availability model, so it is not an overlap. Pending ordinary requests, waitlist entries that are merely waiting, and everything
// closed (cancelled, declined, expired, fulfilled, past) are not.
// If the asset is late, the reservation does not move; handling a late return against a reservation is not part of this slice.
//
// Integrity: every write (create, approve, shorten, cancel, decline) runs in ONE `BEGIN IMMEDIATE` transaction that re-reads the rows it
// depends on (SQLite allows one writer; the second waits, then sees the first), so the split into reserved and waitlisted time is computed against a
// consistent picture. Approval re-checks eligibility, the person, the start date and the whole range at approval time.
//
// Waitlist (slice 8, src/waitlist.js): an ACTIVE availability hold (a waitlist entry in status 'held' whose hold_expires_at is still in the
// future) makes its time unavailable exactly like a confirmed reservation does (it is what keeps the NEXT person in line from being offered the
// same time, and what sends anyone else who asks for it to the waitlist); an expired hold counts for nothing, even before the sweep has recorded it. Whenever time may
// have come free (cancel, shorten, decline) the queue is re-evaluated INSIDE the same transaction, so nobody can slip into the gap between the
// time freeing up and the next person in line being offered it.
const crypto = require('crypto');
const availability = require('./availability');
const T = require('./timeRange');
const { capacity } = require('./assignments');
const mailer = () => require('./mailer'); // (looked up per call so a re-booted test app and the real one never mix)
const waitlist = () => require('./waitlist'); // (lazily: it requires this module)

const LIVE = ['pending', 'confirmed'];
const MAX_DATE = '2100-12-31';
// 409 = the request is fine but the dates/asset can't be had right now; 400 = the request itself is wrong; 403/404 as elsewhere.
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const fmt = T.fmtDay;
const span = (s, e) => (s === e ? fmt(s) : `${fmt(s)} to ${fmt(e)}`); // (date-only wording; rows with times use T.when)
const when = T.when;
const todayOf = (db) => db.prepare("SELECT date('now') d").get().d;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// `startTime` / `endTime` (already cleaned: null or 'HH:MM') make the check time-aware: a same-day range must end after it starts.
function validateRange(start, end, today, startTime = null, endTime = null) {
  if (!validDate(start) || !validDate(end)) throw httpError(400, 'Choose a start date and an end date.');
  if (end < start) throw httpError(400, "The end date can't be before the start date.");
  if (start < today) throw httpError(400, "A reservation can't start in the past.");
  if (end > MAX_DATE) throw httpError(400, 'Choose an end date before 2101.');
  T.checkOrder(start, startTime, end, endTime);
}
const rangeOf = (start, end, startTime = null, endTime = null) => ({ start_date: start, start_time: startTime, end_date: end, end_time: endTime });

const { reserveEligibility } = availability; // shared with the single-asset calendar (which uses it to decide whether to offer Reserve)

// Everything that makes this asset UNAVAILABLE for part or all of `range` ({start_date, start_time, end_date, end_time}), as [{ kind, row, sk, ek }] in time
// order (empty = all of it is free). `sk` / `ek` are the half-open key interval it occupies (src/timeRange.js), so callers can cut the range around it. kind:
//   reservation    another CONFIRMED reservation                          hold            an ACTIVE waitlist hold (hold_expires_at still ahead)
//   pending_hold   a PENDING reservation made from a waitlist hold (it keeps its time out of the queue until IT decides)
//   checkout       an open assignment: a temporary checkout is out until its due date AND due time; a permanent assignment or an overdue checkout has no known end
// Waitlist entries that are merely waiting, ordinary pending requests and everything closed are NOT blockers: waiting is demand, not possession.
// `excludeId` = the reservation being (re)checked; `ignoreHoldId` = the waitlist hold being confirmed (it must not count against itself).
// Ranges are half-open: adjacent ranges (return 1:00 PM / pickup 1:00 PM) do not overlap.
function findBlockers(db, asset, range, { today, excludeId = 0, ignoreHoldId = 0 } = {}) {
  const want = T.keysOf(range);
  const near = (rows) => rows.filter((r) => T.overlaps(want, T.keysOf(r)));
  const out = [];
  const resv = db.prepare(`SELECT * FROM reservations WHERE asset_id = ? AND id <> ? AND start_date <= ? AND end_date >= ?
    AND (status = 'confirmed' OR (status = 'pending' AND waitlist_entry_id IS NOT NULL)) ORDER BY start_date, start_time, id`).all(asset.id, excludeId, range.end_date, range.start_date);
  for (const r of near(resv)) out.push({ kind: r.status === 'confirmed' ? 'reservation' : 'pending_hold', row: r, ...T.keysOf(r) });
  const holds = db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND status = 'held' AND hold_expires_at > datetime('now') AND id <> ? AND start_date <= ? AND end_date >= ?
    ORDER BY start_date, start_time, id`).all(asset.id, ignoreHoldId, range.end_date, range.start_date);
  for (const h of near(holds)) out.push({ kind: 'hold', row: h, ...T.keysOf(h) });
  for (const a of db.prepare('SELECT * FROM assignments WHERE asset_id = ? AND returned_at IS NULL').all(asset.id)) {
    const bounded = a.assignment_type === 'checkout' && a.due_date && a.due_date >= today; // otherwise: permanent / overdue = no known end
    const ek = bounded ? T.endKey(a.due_date, a.due_time) : T.INF_KEY;
    if (want.sk < ek) out.push({ kind: 'checkout', row: a, sk: '0000-01-01T00:00', ek });
  }
  return out.sort((x, y) => (x.sk < y.sk ? -1 : x.sk > y.sk ? 1 : 0));
}
// What the request would become: { blockers, free, busy } (free = ranges to reserve, busy = ranges to waitlist).
const plan = (db, asset, range, opts) => { const blockers = findBlockers(db, asset, range, opts); return { blockers, ...T.splitFree(range, blockers) }; };
// Why a blocker makes the time unavailable, in the words the screens use (never who has it).
function whyBlocked(b, today) {
  if (b.kind === 'hold') return `It is on a priority hold for a waitlisted team ${when(b.row)}.`;
  if (b.kind === 'pending_hold') return `A reservation from the waitlist is waiting for IT approval ${when(b.row)}.`;
  if (b.kind === 'checkout') {
    const a = b.row;
    if (a.assignment_type === 'checkout' && a.due_date && a.due_date >= today) return `It is checked out until ${fmt(a.due_date)}${a.due_time ? ` at ${T.fmtTime(a.due_time)}` : ''}.`;
    return a.assignment_type === 'checkout' ? 'It is checked out and overdue.' : 'It is currently assigned.';
  }
  return `It is already reserved ${when(b.row)}.`;
}

const note = (db, assetId, actorAccountId, action, details, employeeId) =>
  db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)').run(assetId, actorAccountId, employeeId, action, details);
const load = (db, id) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  if (!r) throw httpError(404, 'Reservation not found');
  return r;
};
const loadAsset = (db, id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
// A person's name / address for an email (their work email, else their active login).
const emailOf = (db, employeeId) => {
  const r = db.prepare(`SELECT e.name, COALESCE(e.work_email, a.login_email) AS email, e.department FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id AND a.active = 1 WHERE e.id = ?`).get(employeeId);
  return r || { name: '', email: null, department: null };
};
// After the commit: tell the requester what became of their request (what was reserved, what was waitlisted). Never throws.
function sendRecorded(db, employeeId, asset, summary) {
  try { mailer().notify.requestRecorded(emailOf(db, employeeId), asset, summary); } catch (err) { console.error('[reservation:mail]', err.message); }
}

// The employee submits. Confirmed at once, or pending IT approval, per the ASSET's setting. Reserving does NOT depend on the employee's
// self-checkout permission (that permission governs "Check out now" only); the gates are the asset's own: available_to_request ON and the
// normal eligibility rules, plus a linked, active employee.
// The one place a reservation row is written, shared by create() and by confirming a waitlist hold (src/waitlist.js). Must run inside a
// BEGIN IMMEDIATE transaction; the caller has already done its own eligibility checks.
function insertReservation(db, asset, { employeeId, actorAccountId, start, end, startTime = null, endTime = null, waitlistEntryId = null, requestGroup = null }) {
  const needs = asset.reservation_requires_approval ? 1 : 0;
  const id = db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, start_time, end_date, end_time, status, requires_approval, created_by, waitlist_entry_id, request_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(asset.id, employeeId, start, startTime, end, endTime, needs ? 'pending' : 'confirmed', needs, actorAccountId, waitlistEntryId, requestGroup).lastInsertRowid;
  note(db, asset.id, actorAccountId, needs ? 'reservation_requested' : 'reserved', `${when(rangeOf(start, end, startTime, endTime))}${needs ? ' · waiting for IT approval' : ''}${waitlistEntryId ? ' · from the waitlist' : ''}`, employeeId);
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
}
// Would this person be double-booking THEMSELVES? (a yes is refused: that is a mistake, not a scheduling question between teams)
const hasOwnOverlap = (db, assetId, employeeId, range) =>
  db.prepare(`SELECT * FROM reservations WHERE asset_id = ? AND employee_id = ? AND status IN ('pending','confirmed') AND start_date <= ? AND end_date >= ?`)
    .all(assetId, employeeId, range.end_date, range.start_date).some((r) => T.overlapsRows(r, range));
const hasOwnHold = (db, assetId, employeeId, range) =>
  db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND employee_id = ? AND status = 'held' AND hold_expires_at > datetime('now') AND start_date <= ? AND end_date >= ?`)
    .all(assetId, employeeId, range.end_date, range.start_date).some((r) => T.overlapsRows(r, range));

// One request, one range -> reservation(s) for the free time and waitlist entries for the unavailable time (see the header). Returns
// { request_group, requested, reserved: [reservation rows], waitlisted: [waitlist rows] }. A request with NO free time is refused (409): that is the
// waitlist endpoint's job. The decision is waitlist.classify(), the same one the date sheet asks (GET range-check), re-run here inside the transaction.
function create(db, { assetId, employeeId, actorAccountId, start, end, startTime, endTime }) {
  const wl = waitlist();
  const group = crypto.randomUUID();
  let reserved = []; let waitlisted = []; let requested; let reservers = [];
  db.transaction(() => {
    const c = wl.classify(db, { assetId, employeeId, start, end, startTime, endTime });
    if (c.outcome === 'waitlist') throw httpError(409, `${c.message} Join the waitlist for that time instead.`);
    if (c.outcome !== 'reserve' && c.outcome !== 'partial') throw httpError(c.status, c.message);
    const asset = loadAsset(db, assetId);
    requested = rangeOf(start, end, c.start_time, c.end_time);
    reserved = c.free.map((f) => insertReservation(db, asset, { employeeId, actorAccountId, start: f.start_date, end: f.end_date, startTime: f.start_time, endTime: f.end_time, requestGroup: group }));
    waitlisted = c.busy.map((b) => wl.insertEntry(db, { assetId, employeeId, actorAccountId, range: b, requestGroup: group }));
    reservers = c.reservers;
  }).immediate();
  if (waitlisted.length) wl.announceJoined(db, employeeId, assetId, waitlisted, reservers);
  sendRecorded(db, employeeId, loadAsset(db, assetId), { requested, reserved, waitlisted });
  return { request_group: group, requested, reserved, waitlisted };
}

// Time may have come free: let the waitlist offer it (inside the caller's transaction; src/waitlist.js is required lazily because it
// requires this module).
const requeue = (db, assetId) => require('./waitlist').evaluateAsset(db, assetId);

// IT approves a pending reservation. Eligibility, the person, the start date and the WHOLE range are checked again NOW: if anything has taken that time (or the
// asset is no longer reservable) approval fails with 409 and the row stays pending, for IT to decline.
function approve(db, id, { actorAccountId, note: text }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (r.status !== 'pending') throw httpError(400, r.status === 'cancelled' ? 'This reservation was cancelled.' : 'This reservation has already been decided.');
    const today = todayOf(db);
    const asset = loadAsset(db, r.asset_id);
    const el = reserveEligibility(asset);
    if (!el.ok) throw httpError(409, el.hidden ? "Can't approve: this item is no longer available to request." : `Can't approve: ${el.reason}`);
    const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(r.employee_id);
    if (!emp || emp.status !== 'active') throw httpError(409, "Can't approve: that person is inactive.");
    if (r.start_date < today) throw httpError(409, "Can't approve: the start date has already passed. Decline it so they can book again.");
    const blocked = findBlockers(db, asset, r, { excludeId: r.id, today })[0];
    if (blocked) throw httpError(409, `Can't approve: ${whyBlocked(blocked, today)} Decline it or ask the employee to choose other dates.`);
    const info = db.prepare("UPDATE reservations SET status = 'confirmed', decided_by = ?, decided_at = datetime('now'), decision_note = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(actorAccountId, text || null, id);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    note(db, r.asset_id, actorAccountId, 'reservation_approved', `${when(r)}${text ? ` · ${text}` : ''}`, r.employee_id);
    return load(db, id);
  }).immediate();
}

function decline(db, id, { actorAccountId, note: text }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (r.status !== 'pending') throw httpError(400, r.status === 'cancelled' ? 'This reservation was cancelled.' : 'This reservation has already been decided.');
    const info = db.prepare("UPDATE reservations SET status = 'declined', decided_by = ?, decided_at = datetime('now'), decision_note = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(actorAccountId, text || null, id);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    note(db, r.asset_id, actorAccountId, 'reservation_declined', `${when(r)}${text ? ` · ${text}` : ''}`, r.employee_id);
    requeue(db, r.asset_id); // (a declined reservation made from a waitlist hold gives its dates back to the queue)
    return load(db, id);
  }).immediate();
}

// An employee cancels (withdraws) their OWN live reservation, pending or confirmed, while any part of it is still ahead; IT may cancel a CONFIRMED one
// (a pending one is declined, not cancelled). The dates free up at once.
function cancel(db, id, { actorAccountId, employeeId, isAdmin }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (!isAdmin && r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (!LIVE.includes(r.status)) throw httpError(400, 'This reservation is already closed.');
    // IT's decision on a PENDING reservation is Approve or Decline; cancelling is for a confirmed one. (The employee withdrawing their own pending request is a cancel and stays allowed.)
    if (isAdmin && r.status === 'pending') throw httpError(400, "A pending reservation can't be cancelled by IT. Decline it instead.");
    if (r.end_date < todayOf(db)) throw httpError(400, 'This reservation is already over.');
    const info = db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')").run(actorAccountId, id);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    note(db, r.asset_id, actorAccountId, 'reservation_cancelled', `${when(r)}${isAdmin && r.employee_id !== employeeId ? ' · cancelled by IT' : ''}`, r.employee_id);
    requeue(db, r.asset_id);
    return load(db, id);
  }).immediate();
}

// An employee moves the END of their own CONFIRMED reservation earlier: an earlier return DATE, an earlier return TIME, or both ("Oct 12 all day" ->
// "Oct 12, return 1:00 PM"). Never later, never the start: extending is a new reservation, because the extra time must be warned against everyone
// else's. `newEnd` (a date) defaults to the current end date; `newEndTime` blank = the end of that day. The freed time is free the moment this
// commits, and the waitlist is re-evaluated in the same transaction.
function shorten(db, id, { actorAccountId, employeeId, newEnd, newEndTime }) {
  const endTime = T.cleanTime(newEndTime, 'return time');
  return db.transaction(() => {
    const r = load(db, id);
    if (r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (r.status === 'pending') throw httpError(400, 'This reservation is waiting for IT. Cancel it and submit a new one to change the dates.');
    if (r.status !== 'confirmed') throw httpError(400, 'This reservation is already closed.');
    const today = todayOf(db);
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
    const info = db.prepare("UPDATE reservations SET end_date = ?, end_time = ?, updated_at = datetime('now') WHERE id = ? AND status = 'confirmed' AND end_date = ? AND end_time IS ?").run(endDate, endTime, id, r.end_date, r.end_time);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    const at = (d, t) => `${fmt(d)}${t ? ` ${T.fmtTime(t)}` : ''}`;
    note(db, r.asset_id, actorAccountId, 'reservation_shortened', `${fmt(r.start_date)}: end ${at(r.end_date, r.end_time)} → ${at(endDate, endTime)}`, r.employee_id);
    requeue(db, r.asset_id);
    return load(db, id);
  }).immediate();
}

// Where a reservation stands today, in the words the screens use.
function phaseOf(r, today) {
  if (r.status !== 'confirmed') return r.status;
  return r.end_date < today ? 'past' : r.start_date <= today ? 'active' : 'upcoming';
}

module.exports = { LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, reserveEligibility, findBlockers, plan, whyBlocked, insertReservation, hasOwnOverlap, hasOwnHold, note, loadAsset, emailOf, sendRecorded, fmt, span, when, create, approve, decline, cancel, shorten, phaseOf, todayOf };
