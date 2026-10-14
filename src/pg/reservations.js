// Asset reservations on PostgreSQL (D-46, migration Slice 4A: the READ half). The PG counterpart of src/reservations.js; NOT
// used by the running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages
// (read the header of src/reservations.js); every function is async and takes an executor `q` (a pg Pool or a transaction
// client) where the SQLite version takes `db`.
//
// Slice 4A has the reads only: findBlockers, plan, hasOwnOverlap, hasOwnHold, loadAsset, emailOf, todayOf. Slice 4B adds the
// writes to THIS file (create, approve, decline, cancel, shorten, insertReservation, note) without changing anything here.
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
const base = require('../reservations');
const T = require('../timeRange');
const { reserveEligibility } = require('../availability');
const time = require('./time');

const { LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, whyBlocked, phaseOf, fmt, span, when } = base;
const { NOW } = time;
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

module.exports = {
  LIVE, MAX_DATE, httpError, validDate, validateRange, rangeOf, reserveEligibility, findBlockers, plan, whyBlocked, hasOwnOverlap, hasOwnHold, loadAsset, emailOf,
  fmt, span, when, phaseOf, todayOf, toId,
};
