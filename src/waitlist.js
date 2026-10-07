// Waitlist + availability holds (Phase 2, slice 8). A waitlist entry is one employee waiting for ONE physical asset over an inclusive range
// of calendar dates (YYYY-MM-DD, like reservations) with an OPTIONAL pickup time on the first date and an OPTIONAL return time on the last
// (slice 8.1, src/timeRange.js). Lifecycle (status -> what the screens call it):
//
//   waiting   Waitlisted      in the queue, FIFO by queue_seq (a strictly increasing key: joining takes the next one, and so does changing your dates)
//   held      Available for you until <time>      the employee holds the WHOLE requested range (dates AND times) until hold_expires_at
//   fulfilled Confirmed / Waiting for approval         they confirmed; a normal reservation now exists (reservations.waitlist_entry_id)
//   declined  No longer needed    left  Left waitlist    removed  Removed by IT    expired  Expired (hold ran out, or the dates passed)
//
// Rules:
//  * Unavailable time is waitlist time. One request is cut (reservations.create) into the part that is FREE (reserved) and the part that is NOT (a waitlist
//    entry per unavailable stretch, all sharing the request's `request_group`). The time is unavailable because of a CONFIRMED reservation, another team's
//    active hold, a waitlist-born reservation awaiting IT, or an open checkout. There is no "release request": joining never changes, asks for or
//    pressures anything about the reservation in the way. (The current reserver gets an informational email; nothing is required of them.)
//  * Waitlist entries are demand, not possession: they may overlap each other and any reservation, and never make time unavailable.
//  * Nothing is ever reserved automatically. Whenever time frees up, each waiting entry is re-split exactly like a new request (T.splitFree): the part of ITS
//    range that is now free is OFFERED a hold (see responseMinutes: 24 hours, 2 hours or 30 minutes by how soon it starts), oldest eligible first, and the part that is still unavailable stays waiting in the same place in line
//    (an entry waiting 8-5 when only 1-5 frees is offered 1-5; 8-1 keeps waiting). An older entry that is still blocked does not hold up a younger one whose
//    range is free; overlapping entries are served in FIFO order because each hold makes its time unavailable for the ones behind it. Time that touches
//    but does not overlap an entry's range (return 1:00 PM / pickup 1:00 PM) is not offered to it.
//    Every release path (cancel, shorten, decline, hold expiry/decline, an early return) re-runs this in its own transaction.
//  * Changing your requested dates (Edit dates) is asking for something new: the range is re-validated exactly like joining (it must still be entirely
//    unavailable) and the entry goes to the BACK of the line (a new queue_seq). Only a waiting entry can be edited, never one that is holding an offer.
//  * Confirming applies the normal reservation behaviour: confirmed at once, or pending IT approval when the asset requires it, with the same
//    times. The hold is the holder's PRIORITY, so the time is theirs unless it was taken some other way meanwhile (then the hold goes back to waiting).
//  * Declining, leaving, removal by IT and expiry all release the hold and offer the dates to the next eligible entry.
//  * Every write is one BEGIN IMMEDIATE transaction that re-reads what it depends on. An expired hold counts for nothing the moment it expires
//    (reservations.findBlockers compares hold_expires_at with now); the sweep (src/server.js, every minute) only records it and moves the queue.
//  * Emails are sent after the transaction commits, never inside it, and a mail problem can never undo or block a state change. The hold email
//    is claimed once per hold (hold_email_at), so re-evaluating never re-sends it.
const crypto = require('crypto');
const reservations = require('./reservations');
const T = require('./timeRange');
const { httpError, findBlockers, whyBlocked, validateRange, rangeOf, reserveEligibility, todayOf, note, loadAsset, emailOf, when } = reservations;

// How long an offer may sit unanswered depends on how soon the offered time STARTS, measured when the offer is made, in APP_TIMEZONE wall-clock:
//   starts more than 24 hours away      -> 24 hours       starts 4 to 24 hours away (both ends included) -> 2 hours
//   starts less than 4 hours away, or has already started -> 30 minutes
// (Future: a per-asset policy -- fast turnover / standard / extended -- where "standard" is exactly this.)
const RESPONSE_MINUTES = { far: 24 * 60, soon: 2 * 60, imminent: 30 };
function responseMinutes(piece, now = T.nowKey()) {
  const away = T.minutesBetween(now, T.startKey(piece.start_date, piece.start_time));
  return away > 24 * 60 ? RESPONSE_MINUTES.far : away >= 4 * 60 ? RESPONSE_MINUTES.soon : RESPONSE_MINUTES.imminent;
}
// How long an offer may actually stay open, in seconds: the tier's window, but never past the END of the offered interval (a date-only end is the end of that day).
// Only the 30-minute tier can ever be cut short (a piece 4+ hours away is always at least 4 hours long from now). <= 0 means the piece is already over: do not offer it.
// `secs` = seconds already elapsed in the current minute, so the cap lands on the interval's end exactly (T.nowKey is truncated to the minute).
function offerSeconds(piece, now = T.nowKey(), secs = new Date().getUTCSeconds()) {
  const left = T.minutesBetween(now, T.endKey(piece.end_date, piece.end_time)) * 60 - secs;
  return Math.min(responseMinutes(piece, now) * 60, left);
}
const OPEN = ['waiting', 'held'];
const mailer = () => require('./mailer'); // (looked up per call so a re-booted test app and the real one never mix)

const load = (db, id) => {
  const e = db.prepare('SELECT * FROM waitlist_entries WHERE id = ?').get(id);
  if (!e) throw httpError(404, 'Waitlist entry not found');
  return e;
};
const close = (db, id, status, actorAccountId) =>
  db.prepare("UPDATE waitlist_entries SET status = ?, closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('waiting','held')").run(status, actorAccountId ?? null, id).changes;

// What may this waiting entry be offered right now? null = nothing (the asset / person / dates no longer qualify); otherwise the SAME split a new request gets
// (reservations.plan -> T.splitFree): { free, busy } = the pieces of ITS range that are free now / still unavailable.
function freeParts(db, e, today) {
  if (e.start_date < today) return null;
  const asset = loadAsset(db, e.asset_id);
  if (!reserveEligibility(asset).ok) return null;
  const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(e.employee_id);
  if (!emp || emp.status !== 'active') return null;
  if (reservations.hasOwnOverlap(db, e.asset_id, e.employee_id, e)) return null;
  return reservations.plan(db, asset, e, { today });
}

// A piece of an entry that has been split keeps the entry's place in line (same queue_seq / queued_at / request_group), so splitting never costs priority.
function insertPiece(db, e, piece, held, seconds) {
  return db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, status, created_by, created_at, queue_seq, queued_at, request_group, hold_started_at, hold_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${held ? "datetime('now'), datetime('now', ?)" : 'NULL, NULL'})`)
    .run(...[e.asset_id, e.employee_id, piece.start_date, piece.start_time || null, piece.end_date, piece.end_time || null, held ? 'held' : 'waiting', e.created_by, e.created_at, e.queue_seq, e.queued_at, e.request_group, ...(held ? [`+${seconds} seconds`] : [])]).lastInsertRowid;
}

// Record lapsed holds / past ranges, then offer free time to waiting entries oldest-first. Each waiting entry is re-run through the same partial-fulfillment split a
// new request gets: the part of its range that is free is OFFERED a hold, the part that is still unavailable stays waiting in the same place in line.
// (An entry whose whole range is free is simply offered whole.) Call inside a BEGIN IMMEDIATE transaction.
function evaluateAsset(db, assetId) {
  const today = todayOf(db);
  const lapsed = db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND ((status = 'held' AND hold_expires_at <= datetime('now')) OR (status IN ('waiting','held') AND start_date < ?))`).all(assetId, today);
  for (const e of lapsed) {
    if (close(db, e.id, 'expired', null)) note(db, assetId, null, 'waitlist_expired', `${when(e)}${e.status === 'held' ? ' · hold ran out' : ' · dates passed'}`, e.employee_id);
  }
  const granted = [];
  const nowKey = T.nowKey();
  // an open entry whose whole interval has now ended (a same-day time that has passed) can never be offered again
  for (const e of db.prepare("SELECT * FROM waitlist_entries WHERE asset_id = ? AND status IN ('waiting','held')").all(assetId)) {
    if (T.endKey(e.end_date, e.end_time) <= nowKey && close(db, e.id, 'expired', null)) note(db, assetId, null, 'waitlist_expired', `${when(e)} · the time has passed`, e.employee_id);
  }
  const waiting = db.prepare("SELECT * FROM waitlist_entries WHERE asset_id = ? AND status = 'waiting' ORDER BY queue_seq, id").all(assetId);
  for (const e of waiting) {
    const p = freeParts(db, e, today);
    if (!p) continue;
    p.free = p.free.filter((f) => offerSeconds(f, nowKey) > 0); // (a freed piece that has already ended is not offered)
    if (!p.free.length) continue;
    const [first, ...more] = p.free;
    const secs = (piece) => Math.max(1, offerSeconds(piece, nowKey));
    const split = p.busy.length > 0 || more.length > 0;
    // the entry itself becomes the first free piece (held); every other piece is a new row with the same place in line
    const info = db.prepare(`UPDATE waitlist_entries SET start_date = ?, start_time = ?, end_date = ?, end_time = ?, status = 'held', hold_started_at = datetime('now'), hold_expires_at = datetime('now', ?), hold_email_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'waiting'`)
      .run(first.start_date, first.start_time || null, first.end_date, first.end_time || null, `+${secs(first)} seconds`, e.id);
    if (!info.changes) continue;
    granted.push(e.id);
    for (const piece of more) granted.push(insertPiece(db, e, piece, true, secs(piece)));
    for (const piece of p.busy) insertPiece(db, e, piece, false, 0);
    if (split) note(db, assetId, null, 'waitlist_split', `${when(e)} → ${p.free.map((f) => when(f)).join(', ')} offered${p.busy.length ? `, ${p.busy.map((b) => when(b)).join(', ')} still waiting` : ''}`, e.employee_id);
    for (const piece of p.free) note(db, assetId, null, 'waitlist_hold_started', `${when(piece)} · available until ${T.fmtStamp(db.prepare("SELECT datetime('now', ?) t").get(`+${secs(piece)} seconds`).t)}${split ? ' · the part of your waitlisted time that opened up' : ''}`, e.employee_id);
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
// The ONE question behind the date sheet, reserving, joining and editing: what would happen if this employee asked for this range (dates + optional times)?
//   reserve      all of it is free: reserve it (a waitlist makes no sense)
//   partial      part is free and part is not: the free time is reserved and the unavailable time is waitlisted
//   waitlist     none of it is free: join the line
//   invalid / unavailable / own_reservation / own_waitlist / own_hold  refusals
// `free` / `busy` are the row-shaped ranges to reserve / waitlist; `reservers` are the other people's confirmed reservations in the way (told, once, that
// someone joined). `status` is the HTTP status the mutating endpoints answer with when the outcome is not the one they handle. `excludeEntryId` = the entry
// being edited. `start_time` / `end_time` come back cleaned (null or HH:MM) so callers write exactly what was judged.
function classify(db, { assetId, employeeId, start, end, startTime, endTime, excludeEntryId = 0 }) {
  const today = todayOf(db);
  const asset = loadAsset(db, assetId);
  const el = reserveEligibility(asset);
  const no = (outcome, status, message, extra = {}) => ({ outcome, status, message, free: [], busy: [], reservers: [], requires_approval: !!(asset && asset.reservation_requires_approval), ...extra });
  if (!el.ok) return no('unavailable', el.hidden ? 404 : 400, el.reason);
  if (!employeeId) return no('unavailable', 403, "Your login isn't linked to an employee record. Ask IT.");
  const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(employeeId);
  if (!emp || emp.status !== 'active') return no('unavailable', 400, 'Your account is not active.');
  let st; let et;
  try { st = T.cleanTime(startTime, 'pickup time'); et = T.cleanTime(endTime, 'return time'); validateRange(start, end, today, st, et); } catch (e) { return no('invalid', e.status || 400, e.message); }
  const range = rangeOf(start, end, st, et);
  const done = { start_time: st, end_time: et };
  if (reservations.hasOwnOverlap(db, assetId, employeeId, range)) return no('own_reservation', 409, 'You already have a reservation for this item that overlaps those dates.', done);
  // your own hold is not "someone else's": it points you at the confirm button instead of leaving you to wonder why the time is taken
  if (reservations.hasOwnHold(db, assetId, employeeId, range)) return no('own_hold', 409, 'You have a priority hold on those dates. Confirm it under Requests > Reservations.', done);
  const mine = db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND employee_id = ? AND status IN ('waiting','held') AND id <> ? AND start_date <= ? AND end_date >= ?`).all(assetId, employeeId, excludeEntryId, end, start);
  if (mine.some((w) => T.overlapsRows(w, range))) return no('own_waitlist', 409, "You're already on the waitlist for this item for overlapping dates.", done);
  const p = reservations.plan(db, asset, range, { today });
  const reservers = p.blockers.filter((o) => o.kind === 'reservation' && o.row.employee_id !== employeeId)
    .map((o) => ({ reservation_id: o.row.id, start_date: o.row.start_date, start_time: o.row.start_time, end_date: o.row.end_date, end_time: o.row.end_time, employee_id: o.row.employee_id }));
  const base = { ...done, free: p.free, busy: p.busy, reservers, requires_approval: !!asset.reservation_requires_approval };
  if (!p.busy.length) return { outcome: 'reserve', status: 409, message: 'Those dates are available. Reserve them instead of joining the waitlist.', ...base };
  if (!p.free.length) return { outcome: 'waitlist', status: 200, message: whyBlocked(p.blockers[0], today), ...base };
  return { outcome: 'partial', status: 409, message: 'Part of that time is available, so it can be reserved. The rest will be waitlisted.', ...base };
}
// Advisory (nothing is written): what the date sheet asks before it offers Reserve or Join waitlist. create / join / updateDates re-check inside their transaction.
// `reserved` / `waitlisted` = the pieces the request would become (empty when a refusal).
function rangeCheck(db, args) {
  const c = classify(db, args);
  return { outcome: c.outcome, message: c.message, requires_approval: c.requires_approval, reserved: c.free, waitlisted: c.busy };
}

// One waitlist row (the only place one is written). Inside a BEGIN IMMEDIATE transaction. `range` = { start_date, start_time, end_date, end_time }.
function insertEntry(db, { assetId, employeeId, actorAccountId, range, requestGroup = null }) {
  const id = db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, created_by, queue_seq, queued_at, request_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries), datetime('now'), ?)`)
    .run(assetId, employeeId, range.start_date, range.start_time || null, range.end_date, range.end_time || null, actorAccountId, requestGroup).lastInsertRowid;
  note(db, assetId, actorAccountId, 'waitlist_joined', when(range), employeeId);
  return load(db, id);
}
// After the commit: tell each distinct current reserver (once, whatever number of pieces). Informational only; a failure never touches an entry.
function announceJoined(db, employeeId, assetId, entries, reservers) {
  try {
    const waiter = emailOf(db, employeeId); const asset = loadAsset(db, assetId); const seen = new Set();
    for (const b of reservers) {
      if (seen.has(b.employee_id)) continue;
      seen.add(b.employee_id);
      const entry = entries.find((e) => T.overlapsRows(e, b)) || entries[0];
      mailer().notify.waitlistJoined(emailOf(db, b.employee_id), waiter, asset, entry, b);
    }
  } catch (err) { console.error('[waitlist:mail]', err.message); }
}

// "Join waitlist": the WHOLE range is unavailable. (A range with any free time is reserved, and only its unavailable part waitlisted, by reservations.create.)
function join(db, { assetId, employeeId, actorAccountId, start, end, startTime, endTime }) {
  processDue(db); // (its own transaction: lapsed holds are recorded before we look at what is blocked)
  let entry; let reservers = [];
  db.transaction(() => {
    const c = classify(db, { assetId, employeeId, start, end, startTime, endTime });
    if (c.outcome !== 'waitlist') throw httpError(c.status, c.message);
    reservers = c.reservers;
    entry = insertEntry(db, { assetId, employeeId, actorAccountId, range: c.busy[0], requestGroup: crypto.randomUUID() });
  }).immediate();
  announceJoined(db, employeeId, assetId, [entry], reservers);
  reservations.sendRecorded(db, employeeId, loadAsset(db, assetId), { requested: entry, reserved: [], waitlisted: [entry] });
  dispatchHoldEmails(db);
  return { entry };
}

// The owner changes the dates (and/or times) of a WAITING entry. Same rules as joining, and the entry goes to the back of the line for the new range.
function updateDates(db, id, { employeeId, actorAccountId, start, end, startTime, endTime }) {
  processDue(db);
  let newly = []; let waiterAsset = null;
  const entry = db.transaction(() => {
    const e = load(db, id);
    if (!employeeId || e.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (e.status === 'held') throw httpError(400, "You've been offered this item. Confirm or decline the offer; dates can't be changed while it is held for you.");
    if (e.status !== 'waiting') throw httpError(400, 'This waitlist entry is already closed.');
    const st = T.cleanTime(startTime, 'pickup time'); const et = T.cleanTime(endTime, 'return time');
    if (e.start_date === start && e.end_date === end && (e.start_time || null) === st && (e.end_time || null) === et) throw httpError(400, 'Those are already your dates.');
    const c = classify(db, { assetId: e.asset_id, employeeId, start, end, startTime: st, endTime: et, excludeEntryId: e.id });
    if (c.outcome !== 'waitlist') throw httpError(c.status, c.message);
    // Reservers the OLD range already overlapped were told when it was joined; only people the new range newly reaches get a notice.
    const told = new Set(db.prepare(`SELECT * FROM reservations WHERE asset_id = ? AND status = 'confirmed' AND employee_id <> ? AND start_date <= ? AND end_date >= ?`)
      .all(e.asset_id, employeeId, e.end_date, e.start_date).filter((r) => T.overlapsRows(r, e)).map((r) => r.employee_id));
    newly = c.reservers.filter((b) => !told.has(b.employee_id));
    const info = db.prepare(`UPDATE waitlist_entries SET start_date = ?, start_time = ?, end_date = ?, end_time = ?, queue_seq = (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries), queued_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'waiting'`).run(start, c.start_time, end, c.end_time, id);
    if (!info.changes) throw httpError(409, 'This entry was just updated. Reload and try again.');
    note(db, e.asset_id, actorAccountId, 'waitlist_updated', `${when(e)} → ${when(rangeOf(start, end, c.start_time, c.end_time))} · back of the line`, employeeId);
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
// Confirming never fails because of an overlap: the hold is the holder's priority, and another team may have recorded an overlapping request since (the
// calendar is not a lock). What still ends it: the asset can't be reserved, the person is inactive, the start has passed, or they would double-book
// themselves. The result says whether something else overlaps the confirmed time, so the screen can mention availability isn't guaranteed.
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
      : e.start_date < today ? 'the start date has passed' : T.endKey(e.end_date, e.end_time) <= T.nowKey() ? 'that time has already ended' : reservations.hasOwnOverlap(db, e.asset_id, employeeId, e) ? 'you already have a reservation for those dates' : null;
    // the hold is priority, so nothing else should be in the way; if something somehow is (a checkout, an approval), the hold goes back to waiting
    const taken = clash ? null : findBlockers(db, asset, e, { today, ignoreHoldId: e.id })[0];
    if (clash || taken) {
      // The dates can't be had after all: give the hold back (or close it if the dates are gone) and let the queue move; report it afterwards.
      if (e.start_date < today || T.endKey(e.end_date, e.end_time) <= T.nowKey()) close(db, e.id, 'expired', null);
      else db.prepare("UPDATE waitlist_entries SET status = 'waiting', hold_started_at = NULL, hold_expires_at = NULL, hold_email_at = NULL, updated_at = datetime('now') WHERE id = ?").run(e.id);
      evaluateAsset(db, e.asset_id);
      failure = `Those dates are no longer available: ${clash || whyBlocked(taken, today).replace(/\.$/, '').replace(/^It is /, 'it is ')}. ${e.start_date < today || T.endKey(e.end_date, e.end_time) <= T.nowKey() ? 'Your waitlist entry has ended.' : "You're still on the waitlist."}`;
      return;
    }
    reservation = reservations.insertReservation(db, asset, { employeeId, actorAccountId, start: e.start_date, end: e.end_date, startTime: e.start_time, endTime: e.end_time, waitlistEntryId: e.id, requestGroup: e.request_group });
    close(db, e.id, 'fulfilled', actorAccountId);
    note(db, e.asset_id, actorAccountId, 'waitlist_confirmed', `${when(e)}${reservation.status === 'pending' ? ' · waiting for IT approval' : ''}`, employeeId);
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
    note(db, e.asset_id, actorAccountId, 'waitlist_declined', when(e), employeeId);
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
    note(db, e.asset_id, actorAccountId, own ? 'waitlist_left' : 'waitlist_removed', `${when(e)}${own ? '' : ' · removed by IT'}`, e.employee_id);
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
  if (w.status === 'fulfilled') phase = !w.reservation_id ? 'checked_out' : w.reservation_status === 'pending' ? 'pending' : w.reservation_status === 'declined' ? 'reservation_declined' : w.reservation_status === 'cancelled' ? 'reservation_cancelled' : 'confirmed';
  const live = OPEN.includes(w.status) && !lapsed;
  // your place among the open entries whose requested time overlaps yours (adjacent times do not count), you included
  const position = live ? db.prepare(`SELECT * FROM waitlist_entries WHERE asset_id = ? AND status IN ('waiting','held') AND start_date <= ? AND end_date >= ? AND queue_seq <= ?`)
    .all(w.asset_id, w.end_date, w.start_date, w.queue_seq).filter((o) => o.id === w.id || T.overlapsRows(o, w)).length : null;
  const out = {
    id: w.id, asset_id: w.asset_id, asset_name: w.asset_name, asset_tag: w.asset_tag, start_date: w.start_date, start_time: w.start_time || null, end_date: w.end_date, end_time: w.end_time || null,
    request_group: w.request_group || null, phase, mine, created_at: w.created_at, queued_at: w.queued_at || w.created_at, position,
    hold_expires_at: phase === 'held' ? w.hold_expires_at : null, hold_expires_text: phase === 'held' ? T.fmtStamp(w.hold_expires_at) : null,
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

module.exports = { RESPONSE_MINUTES, responseMinutes, offerSeconds, classify, insertEntry, announceJoined, evaluateAsset, processDue, dispatchHoldEmails, sweep, rangeCheck, counts, list, get,
  join: settling(join), updateDates: settling(updateDates), confirmHold: settling(confirmHold), declineHold: settling(declineHold), leave: settling(leave) };
