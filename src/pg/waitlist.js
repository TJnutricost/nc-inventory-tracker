// Waitlist + availability holds on PostgreSQL (D-46, migration Slice 4A: the READ half). The PG counterpart of
// src/waitlist.js; NOT used by the running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and
// error statuses/messages (read the header of src/waitlist.js); every function is async and takes an executor `q` (a pg Pool
// or a transaction client) where the SQLite version takes `db`.
//
// Reads (Slice 4A): classify, rangeCheck, list, get, present, counts. Queue engine + entry helpers (Slice 4B): evaluateAsset
// (+ private freeParts, insertPiece, close), insertEntry, announceJoined. Slice 4C adds the actions (join, updateDates,
// confirmHold, declineHold, leave) and processDue / sweep / dispatchHoldEmails. src/pg/* never imports a mailer (D-47).
//
// Queue engine rules (Slice 4B), ported statement for statement from src/waitlist.js evaluateAsset:
//   - evaluateAsset, insertEntry, insertPiece and close need the asset lock on the transaction client (assertAssetLock, code
//     ASSET_LOCK_REQUIRED): a programming-error net, e.g. for the Slice 5 check-in route, which must lockAsset first.
//   - FIFO is literal: waiting entries are read `ORDER BY queue_seq, id` (NOT the list screens' `queue_seq, status, id`, which
//     only mirrors SQLite's index order for display); every other loop reads `ORDER BY id` (SQLite returned rowid order).
//     freeParts / plan re-read the blockers per entry on the client, after the previous grant, so each hold makes its time
//     unavailable for the entries behind it, and an older entry that is still blocked does not hold up a younger one.
//   - queue_seq is per asset, computed under the lock: MAX(queue_seq) + 1 over THIS asset's entries (SQLite: the whole table).
//     Order only ever matters within an asset; split pieces keep sharing their entry's queue_seq. No schema change.
//   - Two clocks, as in SQLite: the database clock for stored stamps and `hold_expires_at > NOW` (NOW / NOW_PLUS); the JS clock
//     (T.nowKey, APP_TIMEZONE, new Date().getUTCSeconds() in offerSeconds) for response tiers and interval ends. The
//     "available until" activity text is read with its own time.nowPlus(), exactly as SQLite runs a separate query.
//   - When at least one hold is granted, a `holds_owed` effect is registered (after the writes): only a TRIGGER for the
//     claim-based, at-most-once hold-email dispatch of Slice 4C, which is unchanged. It fires after COMMIT, never on rollback.
//   - announceJoined registers one `waitlist_joined` effect per distinct blocking reserver (SQLite emailed them after commit).
//
// Pure helpers come from src/reservations.js / src/timeRange.js (see src/pg/reservations.js). responseMinutes /
// RESPONSE_MINUTES are pure exports of src/waitlist.js and are re-exported from it unchanged. present()'s shaping is private
// there, so it is repeated below (held to the SQLite output by test/pg/pg-waitlist-read.test.js).
//
// SQL differences from SQLite (each one keeps the output identical):
//   - closed list `ORDER BY w.closed_at DESC, w.id DESC` -> `closed_at DESC NULLS LAST` (SQLite: NULL last descending).
//   - open / all list `ORDER BY w.asset_id, w.queue_seq` -> `..., w.status, w.id`. Pieces of a split entry share a queue_seq,
//     and SQLite returns such ties in the order of the index it scans (idx_waitlist_queue / idx_waitlist_employee, both with
//     `status` right after the equality columns): by status text ('held' before 'waiting', closed statuses interleaved
//     alphabetically), then rowid. That is made explicit here so the order is identical, not merely deterministic.
//   - `datetime('now')` -> NOW / time.now() (same truncated UTC text, compared as text).
//   - Ids that are not integers in the column's range find nothing (404, as on SQLite) instead of raising a PG 22P02/22003.
//   - list() reads "now" once for the whole list (SQLite read it once per row; the rows of one list can no longer straddle a
//     second boundary). get() / present() read it per call, as SQLite did.
//
// Consistency: multi-statement reads in READ COMMITTED, not one snapshot. classify()/rangeCheck() are advisory (the date
// sheet); Slices 4B/4C call classify() with their TRANSACTION CLIENT after taking the asset lock (lockAsset, Slice 2), so the
// decision is re-made under the lock. No transaction is opened here.
const base = require('../waitlist');
const T = require('../timeRange');
const reservations = require('./reservations');
const time = require('./time');
const { assertAssetLock } = require('./transaction');
const { registerEffect } = require('./effects');

const { RESPONSE_MINUTES, responseMinutes, offerSeconds } = base;
const { httpError, whyBlocked, validateRange, rangeOf, reserveEligibility, todayOf, loadAsset, toId, note, when } = reservations;
const { NOW, NOW_PLUS } = time;
const OPEN = ['waiting', 'held'];

// ---- queue engine (Slice 4B)
const loadEntry = async (q, id) => {
  const e = (await q.query('SELECT * FROM waitlist_entries WHERE id = $1', [toId(id)])).rows[0];
  if (!e) throw httpError(404, 'Waitlist entry not found');
  return e;
};
// Closes an open entry (the row `e`, so the asset lock can be checked). Returns the number of rows changed (0 or 1).
async function close(c, e, status, actorAccountId) {
  assertAssetLock(c, e.asset_id);
  return (await c.query(`UPDATE waitlist_entries SET status = $1, closed_at = ${NOW}, closed_by = $2, updated_at = ${NOW} WHERE id = $3 AND status IN ('waiting','held')`,
    [status, actorAccountId ?? null, e.id])).rowCount;
}

// What may this waiting entry be offered right now? null = nothing; otherwise the SAME split a new request gets.
async function freeParts(c, e, today) {
  if (e.start_date < today) return null;
  const asset = await loadAsset(c, e.asset_id);
  if (!reserveEligibility(asset).ok) return null;
  const emp = (await c.query('SELECT status FROM employees WHERE id = $1', [e.employee_id])).rows[0];
  if (!emp || emp.status !== 'active') return null;
  if (await reservations.hasOwnOverlap(c, e.asset_id, e.employee_id, e)) return null;
  return reservations.plan(c, asset, e, { today });
}

// A piece of an entry that has been split keeps the entry's place in line (same queue_seq / queued_at / request_group /
// created_at), so splitting never costs priority. Returns the new row's id.
async function insertPiece(c, e, piece, held, seconds) {
  assertAssetLock(c, e.asset_id);
  const params = [e.asset_id, e.employee_id, piece.start_date, piece.start_time || null, piece.end_date, piece.end_time || null, held ? 'held' : 'waiting', e.created_by, e.created_at, e.queue_seq, e.queued_at, e.request_group];
  if (held) params.push(seconds);
  return (await c.query(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, status, created_by, created_at, queue_seq, queued_at, request_group, hold_started_at, hold_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${held ? `${NOW}, ${NOW_PLUS('$13')}` : 'NULL, NULL'}) RETURNING id`, params)).rows[0].id;
}

// Record lapsed holds / past ranges, then offer free time to waiting entries oldest-first (see src/waitlist.js). Needs the
// asset lock on the transaction client. Returns the ids of the entries / pieces that were granted a hold.
async function evaluateAsset(c, assetId) {
  assertAssetLock(c, assetId);
  const today = await todayOf(c);
  const lapsed = (await c.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND ((status = 'held' AND hold_expires_at <= ${NOW}) OR (status IN ('waiting','held') AND start_date < $2)) ORDER BY id`,
    [assetId, today])).rows;
  for (const e of lapsed) {
    if (await close(c, e, 'expired', null)) await note(c, assetId, null, 'waitlist_expired', `${when(e)}${e.status === 'held' ? ' · hold ran out' : ' · dates passed'}`, e.employee_id);
  }
  const granted = [];
  const nowKey = T.nowKey();
  // an open entry whose whole interval has now ended (a same-day time that has passed) can never be offered again
  for (const e of (await c.query("SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status IN ('waiting','held') ORDER BY id", [assetId])).rows) {
    if (T.endKey(e.end_date, e.end_time) <= nowKey && await close(c, e, 'expired', null)) await note(c, assetId, null, 'waitlist_expired', `${when(e)} · the time has passed`, e.employee_id);
  }
  const waiting = (await c.query("SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status = 'waiting' ORDER BY queue_seq, id", [assetId])).rows;
  for (const e of waiting) {
    const p = await freeParts(c, e, today);
    if (!p) continue;
    p.free = p.free.filter((f) => offerSeconds(f, nowKey) > 0); // (a freed piece that has already ended is not offered)
    if (!p.free.length) continue;
    const [first, ...more] = p.free;
    const secs = (piece) => Math.max(1, offerSeconds(piece, nowKey));
    const split = p.busy.length > 0 || more.length > 0;
    // the entry itself becomes the first free piece (held); every other piece is a new row with the same place in line
    const info = await c.query(`UPDATE waitlist_entries SET start_date = $1, start_time = $2, end_date = $3, end_time = $4, status = 'held', hold_started_at = ${NOW}, hold_expires_at = ${NOW_PLUS('$5')}, hold_email_at = NULL, updated_at = ${NOW} WHERE id = $6 AND status = 'waiting'`,
      [first.start_date, first.start_time || null, first.end_date, first.end_time || null, secs(first), e.id]);
    if (!info.rowCount) continue;
    granted.push(e.id);
    for (const piece of more) granted.push(await insertPiece(c, e, piece, true, secs(piece)));
    for (const piece of p.busy) await insertPiece(c, e, piece, false, 0);
    if (split) await note(c, assetId, null, 'waitlist_split', `${when(e)} → ${p.free.map((f) => when(f)).join(', ')} offered${p.busy.length ? `, ${p.busy.map((b) => when(b)).join(', ')} still waiting` : ''}`, e.employee_id);
    for (const piece of p.free) await note(c, assetId, null, 'waitlist_hold_started', `${when(piece)} · available until ${T.fmtStamp(await time.nowPlus(c, secs(piece)))}${split ? ' · the part of your waitlisted time that opened up' : ''}`, e.employee_id);
  }
  if (granted.length) registerEffect(c, { type: 'holds_owed', assetId: Number(assetId) });
  return granted;
}

// One waitlist row (the only place one is written). Needs the asset lock. `range` = { start_date, start_time, end_date, end_time }.
async function insertEntry(c, { assetId, employeeId, actorAccountId, range, requestGroup = null }) {
  assertAssetLock(c, assetId);
  const row = (await c.query(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, created_by, queue_seq, queued_at, request_group)
    VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries WHERE asset_id = $1), ${NOW}, $8) RETURNING *`,
  [assetId, employeeId, range.start_date, range.start_time || null, range.end_date, range.end_time || null, actorAccountId ?? null, requestGroup])).rows[0];
  await note(c, assetId, actorAccountId, 'waitlist_joined', when(range), employeeId);
  return row;
}
// Each distinct current reserver is told once, whatever the number of pieces (SQLite emailed them after its commit; here it
// is a `waitlist_joined` effect, fired after COMMIT). Call after the entries were written, on the transaction client.
function announceJoined(c, employeeId, assetId, entries, reservers) {
  const seen = new Set();
  for (const b of reservers) {
    if (seen.has(b.employee_id)) continue;
    seen.add(b.employee_id);
    const entry = entries.find((e) => T.overlapsRows(e, b)) || entries[0];
    registerEffect(c, { type: 'waitlist_joined', waiterEmployeeId: employeeId, assetId: Number(assetId), entry, reserver: b });
  }
}

// ---- the one question behind the date sheet, reserving, joining and editing (see src/waitlist.js classify)
async function classify(q, { assetId, employeeId, start, end, startTime, endTime, excludeEntryId = 0 }) {
  const today = await todayOf(q);
  const asset = await loadAsset(q, assetId);
  const el = reserveEligibility(asset);
  const no = (outcome, status, message, extra = {}) => ({ outcome, status, message, free: [], busy: [], reservers: [], requires_approval: !!(asset && asset.reservation_requires_approval), ...extra });
  if (!el.ok) return no('unavailable', el.hidden ? 404 : 400, el.reason);
  if (!employeeId) return no('unavailable', 403, "Your login isn't linked to an employee record. Ask IT.");
  const emp = (await q.query('SELECT status FROM employees WHERE id = $1', [toId(employeeId)])).rows[0];
  if (!emp || emp.status !== 'active') return no('unavailable', 400, 'Your account is not active.');
  let st; let et;
  try { st = T.cleanTime(startTime, 'pickup time'); et = T.cleanTime(endTime, 'return time'); validateRange(start, end, today, st, et); } catch (e) { return no('invalid', e.status || 400, e.message); }
  const range = rangeOf(start, end, st, et);
  const done = { start_time: st, end_time: et };
  if (await reservations.hasOwnOverlap(q, assetId, employeeId, range)) return no('own_reservation', 409, 'You already have a reservation for this item that overlaps those dates.', done);
  if (await reservations.hasOwnHold(q, assetId, employeeId, range)) return no('own_hold', 409, 'You have a priority hold on those dates. Confirm it under Requests > Reservations.', done);
  const mine = (await q.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND employee_id = $2 AND status IN ('waiting','held') AND id <> $3 AND start_date <= $4 AND end_date >= $5`,
    [toId(assetId), toId(employeeId), toId(excludeEntryId) ?? 0, end, start])).rows;
  if (mine.some((w) => T.overlapsRows(w, range))) return no('own_waitlist', 409, "You're already on the waitlist for this item for overlapping dates.", done);
  const p = await reservations.plan(q, asset, range, { today });
  const reservers = p.blockers.filter((o) => o.kind === 'reservation' && o.row.employee_id !== employeeId)
    .map((o) => ({ reservation_id: o.row.id, start_date: o.row.start_date, start_time: o.row.start_time, end_date: o.row.end_date, end_time: o.row.end_time, employee_id: o.row.employee_id }));
  const b = { ...done, free: p.free, busy: p.busy, reservers, requires_approval: !!asset.reservation_requires_approval };
  if (!p.busy.length) return { outcome: 'reserve', status: 409, message: 'Those dates are available. Reserve them instead of joining the waitlist.', ...b };
  if (!p.free.length) return { outcome: 'waitlist', status: 200, message: whyBlocked(p.blockers[0], today), ...b };
  return { outcome: 'partial', status: 409, message: 'Part of that time is available, so it can be reserved. The rest will be waitlisted.', ...b };
}
// Advisory (nothing is written): what the date sheet asks before it offers Reserve or Join waitlist.
async function rangeCheck(q, args) {
  const c = await classify(q, args);
  return { outcome: c.outcome, message: c.message, requires_approval: c.requires_approval, reserved: c.free, waitlisted: c.busy };
}

// ---- reading
const WAITLIST_SQL = `
  SELECT w.*, a.name AS asset_name, a.tag AS asset_tag, e.name AS employee_name, e.department AS employee_department,
    rv.id AS reservation_id, rv.status AS reservation_status
  FROM waitlist_entries w JOIN assets a ON a.id = w.asset_id JOIN employees e ON e.id = w.employee_id
  LEFT JOIN reservations rv ON rv.waitlist_entry_id = w.id`;

// `now` = the database clock text for this presentation.
async function presentAt(q, w, user, now) {
  const isAdmin = user.role === 'admin';
  const mine = !!user.employee_id && w.employee_id === user.employee_id;
  const lapsed = w.status === 'held' && w.hold_expires_at <= now;
  let phase = lapsed ? 'expired' : w.status;
  if (w.status === 'fulfilled') phase = !w.reservation_id ? 'checked_out' : w.reservation_status === 'pending' ? 'pending' : w.reservation_status === 'declined' ? 'reservation_declined' : w.reservation_status === 'cancelled' ? 'reservation_cancelled' : 'confirmed';
  const live = OPEN.includes(w.status) && !lapsed;
  // your place among the open entries whose requested time overlaps yours (adjacent times do not count), you included
  const position = live ? (await q.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status IN ('waiting','held') AND start_date <= $2 AND end_date >= $3 AND queue_seq <= $4`,
    [w.asset_id, w.end_date, w.start_date, w.queue_seq])).rows.filter((o) => o.id === w.id || T.overlapsRows(o, w)).length : null;
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
// `phase` is what the screens say; the server also decides which buttons make sense, so the UI never guesses a rule.
const present = async (q, w, user) => presentAt(q, w, user, await time.now(q));

async function list(q, user, { status } = {}) {
  const isAdmin = user.role === 'admin';
  if (status !== undefined && !['open', 'closed'].includes(status)) throw httpError(400, 'Status must be open or closed');
  const where = []; const params = [];
  if (!isAdmin) { params.push(toId(user.employee_id ?? -1)); where.push(`w.employee_id = $${params.length}`); }
  if (status === 'open') where.push("w.status IN ('waiting','held')"); else if (status === 'closed') where.push("w.status NOT IN ('waiting','held')");
  const order = status === 'closed' ? 'w.closed_at DESC NULLS LAST, w.id DESC' : 'w.asset_id, w.queue_seq, w.status, w.id';
  const rows = (await q.query(`${WAITLIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`, params)).rows;
  const now = await time.now(q);
  const out = [];
  for (const w of rows) out.push(await presentAt(q, w, user, now));
  return out;
}
async function get(q, id, user) {
  const key = toId(id);
  const w = key === null ? undefined : (await q.query(`${WAITLIST_SQL} WHERE w.id = $1`, [key])).rows[0];
  if (!w) throw httpError(404, 'Waitlist entry not found');
  if (user.role !== 'admin' && w.employee_id !== user.employee_id) throw httpError(403, 'Not allowed');
  return present(q, w, user);
}

// What needs a person's attention in Requests > Reservations (see src/waitlist.js counts).
async function counts(q, user) {
  const one = async (sql, params) => (await q.query(sql, params)).rows[0].c;
  const live = await one(`SELECT COUNT(*) c FROM waitlist_entries WHERE status = 'waiting' OR (status = 'held' AND hold_expires_at > ${NOW})`);
  if (user.role === 'admin') {
    const pending = await one("SELECT COUNT(*) c FROM reservations WHERE status = 'pending'");
    return { pending, waitlist_active: live, held: 0, attention: pending + live };
  }
  const mine = toId(user.employee_id ?? -1);
  const held = await one(`SELECT COUNT(*) c FROM waitlist_entries WHERE employee_id = $1 AND status = 'held' AND hold_expires_at > ${NOW}`, [mine]);
  const active = await one(`SELECT COUNT(*) c FROM waitlist_entries WHERE employee_id = $1 AND (status = 'waiting' OR (status = 'held' AND hold_expires_at > ${NOW}))`, [mine]);
  return { pending: 0, waitlist_active: active, held, attention: held };
}

module.exports = { RESPONSE_MINUTES, responseMinutes, offerSeconds, classify, rangeCheck, counts, list, get, present, evaluateAsset, insertEntry, announceJoined, loadEntry };
