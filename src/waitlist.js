// Waitlist + availability holds (Phase 2, slice 8). A waitlist entry is one employee waiting for ONE physical asset over an inclusive range
// of calendar dates (YYYY-MM-DD, like reservations). Lifecycle (status -> what the screens call it):
//
//   waiting   Waitlisted      in the queue, FIFO by queue_seq (a strictly increasing key: joining takes the next one, and so does changing your dates)
//   held      Available — confirm within 24 hours      the employee holds the WHOLE range exclusively until hold_expires_at
//   fulfilled Confirmed / Waiting for approval         they confirmed; a normal reservation now exists (reservations.waitlist_entry_id)
//   declined  No longer needed    left  Left waitlist    removed  Removed by IT    expired  Expired (hold ran out, or the dates passed)
//
// Rules:
//  * You may join only when your dates are blocked by someone's CONFIRMED reservation or by another team's active hold. There is no
//    "release request": joining never changes, asks for or pressures anything about the reservation in the way. (The current reserver gets an
//    informational email; nothing is required of them.)
//  * Nothing is ever reserved automatically. When an entry's ENTIRE range is free it is OFFERED a 24-hour hold, oldest eligible first. An older
//    entry whose range is still blocked does not hold up a younger one whose range is free; overlapping entries are served in FIFO order
//    because each hold blocks the ones behind it.
//  * Changing your requested dates (Edit dates) is asking for something new: the range is re-validated exactly like joining and the entry
//    goes to the BACK of the line (a new queue_seq). Only a waiting entry can be edited, never one that is holding an offer.
//  * Confirming applies the normal reservation behaviour: confirmed at once, or pending IT approval when the asset requires it. A PENDING
//    reservation made from a hold keeps the dates out of the queue until IT decides.
//  * Declining, leaving, removal by IT and expiry all release the hold and offer the dates to the next eligible entry.
//  * Every write is one BEGIN IMMEDIATE transaction that re-reads what it depends on. An expired hold blocks nothing the moment it expires
//    (reservations.findConflict compares hold_expires_at with now); the sweep (src/server.js, every minute) only records it and moves the queue.
//  * Emails are sent after the transaction commits, never inside it, and a mail problem can never undo or block a state change. The hold email
//    is claimed once per hold (hold_email_at), so re-evaluating never re-sends it.
const reservations = require('./reservations');
const { httpError, findConflict, validateRange, reserveEligibility, todayOf, note, loadAsset, span } = reservations;

const HOLD_HOURS = 24;
const OPEN = ['waiting', 'held'];
const mailer = () => require('./mailer'); // (looked up per call so a re-booted test app and the real one never mix)

const load = (db, id) => {
  const e = db.prepare('SELECT * FROM waitlist_entries WHERE id = ?').get(id);
  if (!e) throw httpError(404, 'Waitlist entry not found');
  return e;
};
const emailOf = (db, employeeId) => {
  const r = db.prepare(`SELECT e.name, COALESCE(e.work_email, a.login_email) AS email, e.department FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id AND a.active = 1 WHERE e.id = ?`).get(employeeId);
  return r || { name: '', email: null, department: null };
};
const close = (db, id, status, actorAccountId) =>
  db.prepare("UPDATE waitlist_entries SET status = ?, closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('waiting','held')").run(status, actorAccountId ?? null, id).changes;

// May this waiting entry be offered a hold right now? (the ENTIRE range must be free for them)
function eligible(db, e, today) {
  if (e.start_date < today) return false;
  const asset = loadAsset(db, e.asset_id);
  if (!reserveEligibility(asset).ok) return false;
  const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(e.employee_id);
  if (!emp || emp.status !== 'active') return false;
  if (reservations.hasOwnOverlap(db, e.asset_id, e.employee_id, e.start_date, e.end_date)) return false;
  return !findConflict(db, asset, e.start_date, e.end_date, { today, forHold: true });
}

// Record lapsed holds / past ranges, then offer free dates to waiting entries oldest-first. Call inside a BEGIN IMMEDIATE transaction.
function evaluateAsset(db, assetId) {
  const today = todayOf(db);
  const lapsed = db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND ((status = 'held' AND hold_expires_at <= datetime('now')) OR (status IN ('waiting','held') AND start_date < ?))`).all(assetId, today);
  for (const e of lapsed) {
    if (close(db, e.id, 'expired', null)) note(db, assetId, null, 'waitlist_expired', `${span(e.start_date, e.end_date)}${e.status === 'held' ? ' · hold ran out' : ' · dates passed'}`, e.employee_id);
  }
  const granted = [];
  const waiting = db.prepare("SELECT * FROM waitlist_entries WHERE asset_id = ? AND status = 'waiting' ORDER BY queue_seq").all(assetId);
  for (const e of waiting) {
    if (!eligible(db, e, today)) continue;
    const info = db.prepare(`UPDATE waitlist_entries SET status = 'held', hold_started_at = datetime('now'), hold_expires_at = datetime('now', ?), hold_email_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'waiting'`)
      .run(`+${HOLD_HOURS} hours`, e.id);
    if (!info.changes) continue;
    note(db, assetId, null, 'waitlist_hold_started', `${span(e.start_date, e.end_date)} · held ${HOLD_HOURS} hours`, e.employee_id);
    granted.push(e.id);
  }
  return granted;
}

// Every asset that has anyone in line (or a hold that may have run out).
function processDue(db) {
  const ids = db.prepare("SELECT DISTINCT asset_id FROM waitlist_entries WHERE status IN ('waiting','held')").all().map((r) => r.asset_id);
  if (!ids.length) return;
  db.transaction(() => { for (const id of ids) evaluateAsset(db, id); }).immediate();
}

// Send the "available for you" email for every live hold that has not had one. The claim is an atomic UPDATE, so two callers (a request and the
// sweep) can never both send it, and a failure to send is logged by the mailer and never retried into a duplicate.
function dispatchHoldEmails(db) {
  const rows = db.prepare(`SELECT w.id FROM waitlist_entries w WHERE w.status = 'held' AND w.hold_email_at IS NULL AND w.hold_expires_at > datetime('now')`).all();
  for (const { id } of rows) {
    try {
      if (!db.prepare("UPDATE waitlist_entries SET hold_email_at = datetime('now') WHERE id = ? AND status = 'held' AND hold_email_at IS NULL").run(id).changes) continue;
      const e = load(db, id);
      mailer().notify.waitlistHold(emailOf(db, e.employee_id), loadAsset(db, e.asset_id), e);
    } catch (err) { console.error('[waitlist:mail]', err.message); }
  }
}
function sweep(db) { processDue(db); dispatchHoldEmails(db); }

// ---- joining / editing dates
// The ONE question behind the join, edit and range-check endpoints: what would happen if this employee asked for this range of this asset?
//   reserve      every day is free: reserve it (a waitlist makes no sense)       waitlist  blocked by a confirmed reservation / another team's hold
//   blocked      not reserved by anyone but still unavailable (checked out...)   invalid / unavailable / own_reservation / own_waitlist  refusals
// `status` is the HTTP status the mutating endpoints answer with when the outcome is not `waitlist`. `excludeEntryId` = the entry being edited.
function classify(db, { assetId, employeeId, start, end, excludeEntryId = 0 }) {
  const today = todayOf(db);
  const asset = loadAsset(db, assetId);
  const el = reserveEligibility(asset);
  const no = (outcome, status, message) => ({ outcome, status, message, requires_approval: !!(asset && asset.reservation_requires_approval) });
  if (!el.ok) return no('unavailable', el.hidden ? 404 : 400, el.reason);
  if (!employeeId) return no('unavailable', 403, "Your login isn't linked to an employee record. Ask IT.");
  const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(employeeId);
  if (!emp || emp.status !== 'active') return no('unavailable', 400, 'Your account is not active.');
  try { validateRange(start, end, today); } catch (e) { return no('invalid', e.status || 400, e.message); }
  if (reservations.hasOwnOverlap(db, assetId, employeeId, start, end)) return no('own_reservation', 409, 'You already have a reservation for this item that overlaps those dates.');
  if (db.prepare(`SELECT 1 FROM waitlist_entries WHERE asset_id = ? AND employee_id = ? AND status IN ('waiting','held') AND id <> ? AND start_date <= ? AND end_date >= ?`).get(assetId, employeeId, excludeEntryId, end, start)) {
    return no('own_waitlist', 409, "You're already on the waitlist for this item for overlapping dates.");
  }
  const clash = findConflict(db, asset, start, end, { today });
  if (!clash) return no('reserve', 409, 'Those dates are available. Reserve them instead of joining the waitlist.');
  // The waitlist is for dates someone else has reserved (or is being held for another team), not for an item that is simply checked out.
  const blockers = db.prepare(`SELECT r.id AS reservation_id, r.start_date, r.end_date, r.employee_id FROM reservations r
    WHERE r.asset_id = ? AND r.status = 'confirmed' AND r.employee_id <> ? AND r.start_date <= ? AND r.end_date >= ? ORDER BY r.start_date, r.id`).all(assetId, employeeId, end, start);
  const held = db.prepare(`SELECT 1 FROM waitlist_entries WHERE asset_id = ? AND status = 'held' AND hold_expires_at > datetime('now') AND employee_id <> ? AND start_date <= ? AND end_date >= ?`).get(assetId, employeeId, end, start);
  if (!blockers.length && !held) return no('blocked', 409, "Those dates aren't reserved by anyone, so there is no waitlist for them (the item is checked out or unavailable then). Choose different dates.");
  return { outcome: 'waitlist', status: 200, message: clash, blockers, requires_approval: !!asset.reservation_requires_approval };
}
// Advisory (nothing is written): what the date sheet asks before it offers Reserve or Join waitlist. join / updateDates / create re-check inside their transaction.
function rangeCheck(db, args) {
  const c = classify(db, args);
  return { outcome: c.outcome, message: c.message, requires_approval: c.requires_approval };
}

function join(db, { assetId, employeeId, actorAccountId, start, end }) {
  let blockers = [];
  processDue(db); // (its own transaction: lapsed holds are recorded before we look at what is blocked)
  const entry = db.transaction(() => {
    const c = classify(db, { assetId, employeeId, start, end });
    if (c.outcome !== 'waitlist') throw httpError(c.status, c.message);
    blockers = c.blockers;
    const id = db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, created_by, queue_seq, queued_at)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries), datetime('now'))`).run(assetId, employeeId, start, end, actorAccountId).lastInsertRowid;
    note(db, assetId, actorAccountId, 'waitlist_joined', span(start, end), employeeId);
    return load(db, id);
  }).immediate();
  // After the commit: tell each distinct current reserver (once). Informational only; failures never touch the entry.
  try {
    const waiter = emailOf(db, employeeId);
    const asset = loadAsset(db, assetId);
    const seen = new Set();
    for (const b of blockers) {
      if (seen.has(b.employee_id)) continue;
      seen.add(b.employee_id);
      mailer().notify.waitlistJoined(emailOf(db, b.employee_id), waiter, asset, entry, b);
    }
  } catch (err) { console.error('[waitlist:mail]', err.message); }
  dispatchHoldEmails(db);
  return { entry, blockers: blockers.map((b) => b.reservation_id) };
}

// The owner changes the dates of a WAITING entry. Same rules as joining, and the entry goes to the back of the line for the new range.
function updateDates(db, id, { employeeId, actorAccountId, start, end }) {
  processDue(db);
  let newly = []; let waiterAsset = null;
  const entry = db.transaction(() => {
    const e = load(db, id);
    if (!employeeId || e.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (e.status === 'held') throw httpError(400, "You've been offered this item. Confirm or decline the offer; dates can't be changed while it is held for you.");
    if (e.status !== 'waiting') throw httpError(400, 'This waitlist entry is already closed.');
    if (e.start_date === start && e.end_date === end) throw httpError(400, 'Those are already your dates.');
    const c = classify(db, { assetId: e.asset_id, employeeId, start, end, excludeEntryId: e.id });
    if (c.outcome !== 'waitlist') throw httpError(c.status, c.message);
    // Reservers the OLD range already overlapped were told when it was joined; only people the new range newly reaches get a notice.
    const told = new Set(db.prepare(`SELECT DISTINCT employee_id FROM reservations WHERE asset_id = ? AND status = 'confirmed' AND employee_id <> ? AND start_date <= ? AND end_date >= ?`)
      .all(e.asset_id, employeeId, e.end_date, e.start_date).map((r) => r.employee_id));
    newly = c.blockers.filter((b) => !told.has(b.employee_id));
    const info = db.prepare(`UPDATE waitlist_entries SET start_date = ?, end_date = ?, queue_seq = (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries), queued_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'waiting'`).run(start, end, id);
    if (!info.changes) throw httpError(409, 'This entry was just updated. Reload and try again.');
    note(db, e.asset_id, actorAccountId, 'waitlist_updated', `${span(e.start_date, e.end_date)} → ${span(start, end)} · back of the line`, employeeId);
    waiterAsset = e.asset_id;
    return load(db, id);
  }).immediate();
  // After the commit, like joining: tell each distinct current reserver the new range NEWLY overlaps (informational; a failure never touches the entry).
  try {
    const waiter = emailOf(db, employeeId); const asset = loadAsset(db, waiterAsset); const seen = new Set();
    for (const b of newly) {
      if (seen.has(b.employee_id)) continue;
      seen.add(b.employee_id);
      mailer().notify.waitlistJoined(emailOf(db, b.employee_id), waiter, asset, entry, b, { updated: true });
    }
  } catch (err) { console.error('[waitlist:mail]', err.message); }
  return entry;
}

// ---- the held employee's two answers
function confirmHold(db, id, { employeeId, actorAccountId }) {
  processDue(db);
  let failure = null; let reservation = null;
  db.transaction(() => {
    const e = load(db, id);
    if (e.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (e.status === 'expired') throw httpError(409, 'This hold has expired. The item was offered to the next person in line.');
    if (e.status !== 'held') throw httpError(400, e.status === 'waiting' ? "You haven't been offered this item yet." : 'This waitlist entry is already closed.');
    const today = todayOf(db);
    const asset = loadAsset(db, e.asset_id);
    const el = reserveEligibility(asset);
    const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(employeeId);
    const clash = !el.ok ? "this item can't be reserved right now" : !emp || emp.status !== 'active' ? 'your account is not active'
      : e.start_date < today ? 'the start date has passed' : reservations.hasOwnOverlap(db, e.asset_id, employeeId, e.start_date, e.end_date) ? 'you already have a reservation for those dates'
      : findConflict(db, asset, e.start_date, e.end_date, { today, ignoreHoldId: e.id });
    if (clash) {
      // The dates can't be had after all: give the hold back (or close it if the dates are gone) and let the queue move; report it afterwards.
      if (e.start_date < today) close(db, e.id, 'expired', null);
      else db.prepare("UPDATE waitlist_entries SET status = 'waiting', hold_started_at = NULL, hold_expires_at = NULL, hold_email_at = NULL, updated_at = datetime('now') WHERE id = ?").run(e.id);
      evaluateAsset(db, e.asset_id);
      failure = `Those dates are no longer available: ${clash}. ${e.start_date < today ? 'Your waitlist entry has ended.' : "You're still on the waitlist."}`;
      return;
    }
    reservation = reservations.insertReservation(db, asset, { employeeId, actorAccountId, start: e.start_date, end: e.end_date, waitlistEntryId: e.id });
    close(db, e.id, 'fulfilled', actorAccountId);
    note(db, e.asset_id, actorAccountId, 'waitlist_confirmed', `${span(e.start_date, e.end_date)}${reservation.status === 'pending' ? ' · waiting for IT approval' : ''}`, employeeId);
  }).immediate();
  dispatchHoldEmails(db);
  if (failure) throw httpError(409, failure);
  return { entry: load(db, id), reservation };
}

function declineHold(db, id, { employeeId, actorAccountId }) {
  processDue(db);
  db.transaction(() => {
    const e = load(db, id);
    if (e.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (e.status === 'expired') throw httpError(409, 'This hold has already expired.');
    if (e.status !== 'held') throw httpError(400, e.status === 'waiting' ? "You haven't been offered this item yet. Use Leave waitlist instead." : 'This waitlist entry is already closed.');
    if (!close(db, id, 'declined', actorAccountId)) throw httpError(409, 'This entry was just updated. Reload and try again.');
    note(db, e.asset_id, actorAccountId, 'waitlist_declined', span(e.start_date, e.end_date), employeeId);
    evaluateAsset(db, e.asset_id);
  }).immediate();
  dispatchHoldEmails(db);
  return load(db, id);
}

// The employee leaves their own place in line; IT may remove an entry (it can never reorder one).
function leave(db, id, { employeeId, actorAccountId, isAdmin }) {
  processDue(db);
  db.transaction(() => {
    const e = load(db, id);
    const own = !!employeeId && e.employee_id === employeeId;
    if (!own && !isAdmin) throw httpError(403, 'Not allowed');
    if (!OPEN.includes(e.status)) throw httpError(400, 'This waitlist entry is already closed.');
    if (!close(db, id, own ? 'left' : 'removed', actorAccountId)) throw httpError(409, 'This entry was just updated. Reload and try again.');
    note(db, e.asset_id, actorAccountId, own ? 'waitlist_left' : 'waitlist_removed', `${span(e.start_date, e.end_date)}${own ? '' : ' · removed by IT'}`, e.employee_id);
    evaluateAsset(db, e.asset_id);
  }).immediate();
  dispatchHoldEmails(db);
  return load(db, id);
}

// ---- reading
const WAITLIST_SQL = `
  SELECT w.*, a.name AS asset_name, a.tag AS asset_tag, e.name AS employee_name, e.department AS employee_department,
    rv.id AS reservation_id, rv.status AS reservation_status
  FROM waitlist_entries w JOIN assets a ON a.id = w.asset_id JOIN employees e ON e.id = w.employee_id
  LEFT JOIN reservations rv ON rv.waitlist_entry_id = w.id`;

// `phase` is what the screens say; the server also decides which buttons make sense, so the UI never guesses a rule.
function present(db, w, user) {
  const isAdmin = user.role === 'admin';
  const mine = !!user.employee_id && w.employee_id === user.employee_id;
  const now = db.prepare("SELECT datetime('now') n").get().n;
  const lapsed = w.status === 'held' && w.hold_expires_at <= now;
  let phase = lapsed ? 'expired' : w.status;
  if (w.status === 'fulfilled') phase = w.reservation_status === 'pending' ? 'pending' : w.reservation_status === 'declined' ? 'reservation_declined' : w.reservation_status === 'cancelled' ? 'reservation_cancelled' : 'confirmed';
  const live = OPEN.includes(w.status) && !lapsed;
  const position = live ? db.prepare(`SELECT COUNT(*) c FROM waitlist_entries WHERE asset_id = ? AND status IN ('waiting','held') AND start_date <= ? AND end_date >= ? AND queue_seq <= ?`)
    .get(w.asset_id, w.end_date, w.start_date, w.queue_seq).c : null;
  const out = {
    id: w.id, asset_id: w.asset_id, asset_name: w.asset_name, asset_tag: w.asset_tag, start_date: w.start_date, end_date: w.end_date,
    phase, mine, created_at: w.created_at, queued_at: w.queued_at || w.created_at, position,
    hold_expires_at: phase === 'held' ? w.hold_expires_at : null,
    reservation_id: w.reservation_id || null,
    can_confirm: mine && phase === 'held', can_decline: mine && phase === 'held',
    can_leave: mine && live, can_remove: isAdmin && live, can_edit: mine && phase === 'waiting',
  };
  if (isAdmin) Object.assign(out, { employee_id: w.employee_id, employee_name: w.employee_name, employee_department: w.employee_department || null, hold_started_at: w.hold_started_at });
  return out;
}

function list(db, user, { status } = {}) {
  const isAdmin = user.role === 'admin';
  if (status !== undefined && !['open', 'closed'].includes(status)) throw httpError(400, 'Status must be open or closed');
  const where = []; const params = [];
  if (!isAdmin) { where.push('w.employee_id = ?'); params.push(user.employee_id ?? -1); }
  // "open" = still in line or holding; a fulfilled entry lives on as its reservation (shown in the closed list for reference)
  if (status === 'open') where.push("w.status IN ('waiting','held')"); else if (status === 'closed') where.push("w.status NOT IN ('waiting','held')");
  const order = status === 'closed' ? 'w.closed_at DESC, w.id DESC' : 'w.asset_id, w.queue_seq';
  return db.prepare(`${WAITLIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`).all(...params).map((w) => present(db, w, user));
}
function get(db, id, user) {
  const w = db.prepare(`${WAITLIST_SQL} WHERE w.id = ?`).get(id);
  if (!w) throw httpError(404, 'Waitlist entry not found');
  if (user.role !== 'admin' && w.employee_id !== user.employee_id) throw httpError(403, 'Not allowed');
  return present(db, w, user);
}

// What needs a person's attention in Requests > Reservations (drives the badge and tab count; ACTIVE entries only, never history).
//   IT: reservations waiting for approval + everyone currently in line or holding.   Employee: offers waiting for their answer.
function counts(db, user) {
  const live = db.prepare(`SELECT COUNT(*) c FROM waitlist_entries WHERE status = 'waiting' OR (status = 'held' AND hold_expires_at > datetime('now'))`).get().c;
  if (user.role === 'admin') {
    const pending = db.prepare("SELECT COUNT(*) c FROM reservations WHERE status = 'pending'").get().c;
    return { pending, waitlist_active: live, held: 0, attention: pending + live };
  }
  const mine = user.employee_id ?? -1;
  const held = db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE employee_id = ? AND status = 'held' AND hold_expires_at > datetime('now')").get(mine).c;
  const active = db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE employee_id = ? AND (status = 'waiting' OR (status = 'held' AND hold_expires_at > datetime('now')))").get(mine).c;
  return { pending: 0, waitlist_active: active, held, attention: held };
}

// Every mutator ends by sending any hold email now owed, EVEN WHEN IT THROWS: a request that is refused (say a late confirm) may still have moved
// the queue on the way in (processDue), and the next person must hear about their hold now, not at the next sweep.
const settling = (fn) => (db, ...rest) => { try { return fn(db, ...rest); } finally { dispatchHoldEmails(db); } };

module.exports = { HOLD_HOURS, evaluateAsset, processDue, dispatchHoldEmails, sweep, rangeCheck, counts, list, get,
  join: settling(join), updateDates: settling(updateDates), confirmHold: settling(confirmHold), declineHold: settling(declineHold), leave: settling(leave) };
