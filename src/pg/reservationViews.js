// How a reservation is shown to a caller, on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/reservationViews.js.
// NOT used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures, the
// same answer (`phase`, `mine`, `can_cancel`, `can_shorten`, `shorten_min`, the admin-only fields hidden from employees); async,
// executor `q` first.
//
// RESERVATION_SQL is imported from src/reservationViews.js (plain SQL text, no placeholders; it loads only the pure helpers of
// src/reservations.js and src/timeRange.js, no database). It moves here at cutover.
//
// Differences from SQLite (output identical):
//   - `?` -> `$n`; "today" is the database's UTC date (src/pg/time.js TODAY, the src/pg/reservations.js `todayOf`).
//   - listReservations reads "today" ONCE and uses it for the open/closed filter and for every row (SQLite re-read date('now') per
//     row within the same instant); reservationOut / reservationById read it per call, as before.
//   - ORDER BY uses only NOT NULL columns (status, start_date, end_date, id), so NULL ordering cannot differ; text compares under
//     COLLATE "C" exactly like SQLite's BINARY.
const base = require('../reservationViews');
const timeRange = require('../timeRange');
const { LIVE, phaseOf, todayOf, toId } = require('./reservations');

const { RESERVATION_SQL } = base;

// The answer for one row, given today's date `t`.
function outWith(t, r, user) {
  const mine = !!user.employee_id && r.employee_id === user.employee_id;
  const live = LIVE.includes(r.status) && r.end_date >= t;
  const lastDay = r.start_date > t ? r.start_date : t; // the earliest end date a shortening may pick
  const admin = user.role === 'admin';
  return {
    ...r, start_time: r.start_time || null, end_time: r.end_time || null, phase: phaseOf(r, t), mine,
    can_cancel: live && (admin || mine),
    can_shorten: mine && r.status === 'confirmed' && r.end_date >= t && timeRange.canShorten(r, lastDay),
    shorten_min: lastDay,
    ...(admin ? {} : { employee_department: undefined, decided_by_name: undefined }),
  };
}

// (A missing row throws a TypeError, exactly as the SQLite version does; the routes only pass rows they have.)
async function reservationOut(q, r, user) {
  const t = await todayOf(q);
  return outWith(t, r, user);
}
async function reservationById(q, id, user) {
  const r = (await q.query(`${RESERVATION_SQL} WHERE r.id = $1`, [toId(id)])).rows[0];
  return reservationOut(q, r, user);
}

// GET /api/reservations: IT sees every reservation, an employee their own; `st` is 'open', 'closed' or undefined.
async function listReservations(q, user, st) {
  const isAdmin = user.role === 'admin';
  const t = await todayOf(q);
  const where = []; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (!isAdmin) where.push(`r.employee_id = ${p(toId(user.employee_id))}`);
  const open = () => `(r.status = 'pending' OR (r.status = 'confirmed' AND r.end_date >= ${p(t)}))`;
  if (st === 'open') where.push(open()); else if (st === 'closed') where.push(`NOT ${open()}`);
  const order = st === 'closed' ? 'r.end_date DESC, r.id DESC' : `CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.start_date, r.id`;
  const { rows } = await q.query(`${RESERVATION_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`, params);
  return rows.map((r) => outWith(t, r, user));
}

module.exports = { RESERVATION_SQL, reservationOut, reservationById, listReservations };
