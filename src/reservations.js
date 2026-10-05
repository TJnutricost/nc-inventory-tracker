// Asset reservations (Phase 2, slice 7). A reservation is a claim on ONE physical asset for a range of CALENDAR DATES, inclusive at
// both ends ("Oct 10 to Oct 12" holds the 10th, 11th and 12th). Dates are plain YYYY-MM-DD strings, never timestamps, so there is no
// timezone arithmetic; "today" is the server's date, like the rest of the app (see availability.js).
//
//   status    pending    waiting for IT (the asset has "Require approval for reservations" on). Blocks NOTHING.
//             confirmed  holds the dates: it blocks every other reservation and counts as "reserved" in availability.
//             declined   IT said no.        cancelled  the employee (or IT) withdrew it.
//   pending -> confirmed | declined | cancelled      confirmed -> cancelled (or its END date shortened; never extended or moved)
//
// What may be reserved: a non-archived, single-seat asset in a lendable state (not repair / retired / lost / disposed) that IT has made
// `available_to_request`. A date range is refused when it overlaps another CONFIRMED reservation or any day the asset is OCCUPIED by an
// assignment (a permanent assignment, a temporary checkout up to and including its due date, or an overdue checkout). The days AFTER a
// checkout's due date are only "expected back" in the availability model, so they may be reserved: that is what reserving ahead is for.
// If the asset is late, the reservation does not move; handling a late return against a reservation is not part of this slice.
//
// Integrity: every write (create, approve, shorten, cancel, decline) runs in ONE `BEGIN IMMEDIATE` transaction that re-reads the rows it
// depends on, so two simultaneous requests cannot both claim the same dates (SQLite allows one writer; the second waits, then sees the first).
// Approval re-checks the whole range at approval time and never overrides an existing confirmed reservation.
const availability = require('./availability');
const { capacity } = require('./assignments');

const LIVE = ['pending', 'confirmed'];
const MAX_DATE = '2100-12-31';
// 409 = the request is fine but the dates/asset can't be had right now; 400 = the request itself is wrong; 403/404 as elsewhere.
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const span = (s, e) => (s === e ? fmt(s) : `${fmt(s)} to ${fmt(e)}`);
const todayOf = (db) => db.prepare("SELECT date('now') d").get().d;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function validateRange(start, end, today) {
  if (!validDate(start) || !validDate(end)) throw httpError(400, 'Choose a start date and an end date.');
  if (end < start) throw httpError(400, "The end date can't be before the start date.");
  if (start < today) throw httpError(400, "A reservation can't start in the past.");
  if (end > MAX_DATE) throw httpError(400, 'Choose an end date before 2101.');
}

const { reserveEligibility } = availability; // shared with the single-asset calendar (which uses it to decide whether to offer Reserve)

// First thing standing in the way of [start, end] for this asset, or null. `excludeId` = the reservation being (re)checked.
function findConflict(db, asset, start, end, { excludeId = 0, today }) {
  const o = db.prepare(`SELECT start_date, end_date FROM reservations WHERE asset_id = ? AND status = 'confirmed' AND id <> ? AND start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1`)
    .get(asset.id, excludeId, end, start);
  if (o) return `It is already reserved ${span(o.start_date, o.end_date)}.`;
  const open = db.prepare('SELECT * FROM assignments WHERE asset_id = ? AND returned_at IS NULL').all(asset.id);
  if (open.length) {
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (availability.dayState(asset, open, d, today, []) === 'occupied') return `It is checked out on ${fmt(d)}.`;
    }
  }
  return null;
}

const note = (db, assetId, actorAccountId, action, details, employeeId) =>
  db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)').run(assetId, actorAccountId, employeeId, action, details);
const load = (db, id) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  if (!r) throw httpError(404, 'Reservation not found');
  return r;
};
const loadAsset = (db, id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);

// The employee submits. Confirmed at once, or pending IT approval, per the ASSET's setting. Reserving does NOT depend on the employee's
// self-checkout permission (that permission governs "Check out now" only); the gates are the asset's own: available_to_request ON and the
// normal eligibility rules, plus a linked, active employee.
function create(db, { assetId, employeeId, actorAccountId, start, end }) {
  return db.transaction(() => {
    const today = todayOf(db);
    const asset = loadAsset(db, assetId);
    const el = reserveEligibility(asset);
    if (!el.ok) throw httpError(el.hidden ? 404 : 400, el.reason);
    if (!employeeId) throw httpError(403, "Your login isn't linked to an employee record. Ask IT.");
    const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(employeeId);
    if (!emp || emp.status !== 'active') throw httpError(400, 'Your account is not active.');
    validateRange(start, end, today);
    if (db.prepare(`SELECT 1 FROM reservations WHERE asset_id = ? AND employee_id = ? AND status IN ('pending','confirmed') AND start_date <= ? AND end_date >= ?`).get(assetId, employeeId, end, start)) {
      throw httpError(409, 'You already have a reservation for this item that overlaps those dates.');
    }
    const clash = findConflict(db, asset, start, end, { today });
    if (clash) throw httpError(409, `${clash} Choose different dates.`);
    const needs = asset.reservation_requires_approval ? 1 : 0;
    const id = db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(assetId, employeeId, start, end, needs ? 'pending' : 'confirmed', needs, actorAccountId).lastInsertRowid;
    note(db, assetId, actorAccountId, needs ? 'reservation_requested' : 'reserved', `${span(start, end)}${needs ? ' · waiting for IT approval' : ''}`, employeeId);
    return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  }).immediate();
}

// IT approves a pending reservation. The whole range is checked again NOW; if anything has taken those dates (or the asset is no
// longer reservable) approval fails with 409 and the row stays pending, for IT to decline.
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
    const clash = findConflict(db, asset, r.start_date, r.end_date, { excludeId: r.id, today });
    if (clash) throw httpError(409, `Can't approve: ${clash} Decline it or ask the employee to choose other dates.`);
    const info = db.prepare("UPDATE reservations SET status = 'confirmed', decided_by = ?, decided_at = datetime('now'), decision_note = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(actorAccountId, text || null, id);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    note(db, r.asset_id, actorAccountId, 'reservation_approved', `${span(r.start_date, r.end_date)}${text ? ` · ${text}` : ''}`, r.employee_id);
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
    note(db, r.asset_id, actorAccountId, 'reservation_declined', `${span(r.start_date, r.end_date)}${text ? ` · ${text}` : ''}`, r.employee_id);
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
    note(db, r.asset_id, actorAccountId, 'reservation_cancelled', `${span(r.start_date, r.end_date)}${isAdmin && r.employee_id !== employeeId ? ' · cancelled by IT' : ''}`, r.employee_id);
    return load(db, id);
  }).immediate();
}

// An employee moves the END of their own CONFIRMED reservation earlier. Never later, never the start: extending is a new reservation, because
// the extra days must be checked against everyone else's. The removed days are free the moment this commits.
function shorten(db, id, { actorAccountId, employeeId, newEnd }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (r.status === 'pending') throw httpError(400, 'This reservation is waiting for IT. Cancel it and submit a new one to change the dates.');
    if (r.status !== 'confirmed') throw httpError(400, 'This reservation is already closed.');
    const today = todayOf(db);
    if (!validDate(newEnd)) throw httpError(400, 'Choose a valid end date.');
    if (r.end_date < today) throw httpError(400, 'This reservation is already over.');
    if (newEnd === r.end_date) throw httpError(400, 'That is already the end date.');
    if (newEnd > r.end_date) throw httpError(400, "You can only shorten a reservation. To keep it longer, make a new reservation for the extra days.");
    if (newEnd < r.start_date) throw httpError(400, "The end date can't be before the start date. Cancel the reservation instead.");
    if (newEnd < today) throw httpError(400, "The end date can't be in the past.");
    const info = db.prepare("UPDATE reservations SET end_date = ?, updated_at = datetime('now') WHERE id = ? AND status = 'confirmed' AND end_date = ?").run(newEnd, id, r.end_date);
    if (!info.changes) throw httpError(409, 'This reservation was just updated by someone else. Reload and try again.');
    note(db, r.asset_id, actorAccountId, 'reservation_shortened', `${fmt(r.start_date)}: end ${fmt(r.end_date)} → ${fmt(newEnd)}`, r.employee_id);
    return load(db, id);
  }).immediate();
}

// Where a reservation stands today, in the words the screens use.
function phaseOf(r, today) {
  if (r.status !== 'confirmed') return r.status;
  return r.end_date < today ? 'past' : r.start_date <= today ? 'active' : 'upcoming';
}

module.exports = { LIVE, MAX_DATE, validDate, validateRange, reserveEligibility, findConflict, create, approve, decline, cancel, shorten, phaseOf, todayOf };
