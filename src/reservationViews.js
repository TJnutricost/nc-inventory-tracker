// How a reservation is shown to a caller (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-1 (D-48):
// the SQL and the answer are unchanged; the database handle is the first argument, like the other data modules. Routes reach
// `reservationById` / `listReservations` through the temporary driver seam (src/dataSeam); since Slice 5B-2 no route in server.js
// uses RESERVATION_SQL or `reservationOut` directly (the asset page reads them in src/assetViews.js). A PostgreSQL twin follows in 5C.
const reservationRules = require('./reservations');
const timeRange = require('./timeRange');

const RESERVATION_SQL = `
  SELECT r.*, a.name AS asset_name, a.tag AS asset_tag, e.name AS employee_name, e.department AS employee_department,
    COALESCE(dn.name, da.login_email) AS decided_by_name
  FROM reservations r JOIN assets a ON a.id = r.asset_id JOIN employees e ON e.id = r.employee_id
  LEFT JOIN accounts da ON da.id = r.decided_by LEFT JOIN employees dn ON dn.id = da.employee_id`;
// `phase`, `can_cancel` and `can_shorten` are the server's own answers, so the UI never has to guess a rule.
function reservationOut(db, r, user) {
  const t = reservationRules.todayOf(db);
  const mine = !!user.employee_id && r.employee_id === user.employee_id;
  const live = reservationRules.LIVE.includes(r.status) && r.end_date >= t;
  const lastDay = r.start_date > t ? r.start_date : t; // the earliest end date a shortening may pick
  const admin = user.role === 'admin';
  return {
    ...r, start_time: r.start_time || null, end_time: r.end_time || null, phase: reservationRules.phaseOf(r, t), mine,
    can_cancel: live && (admin || mine),
    // (slice 8.1) a shortening may move the end DATE earlier or only the end TIME earlier on the last day, so the server answers whether any room is left
    can_shorten: mine && r.status === 'confirmed' && r.end_date >= t && timeRange.canShorten(r, lastDay),
    shorten_min: lastDay,
    ...(admin ? {} : { employee_department: undefined, decided_by_name: undefined }),
  };
}
const reservationById = (db, id, user) => reservationOut(db, db.prepare(`${RESERVATION_SQL} WHERE r.id = ?`).get(id), user);

// GET /api/reservations (added in Slice 5B-2, again VERBATIM from src/server.js): IT sees every reservation, an employee their own;
// `st` is 'open', 'closed' or undefined (the route has already refused anything else).
function listReservations(db, user, st) {
  const isAdmin = user.role === 'admin';
  const t = reservationRules.todayOf(db);
  const where = []; const params = [];
  if (!isAdmin) { where.push('r.employee_id = ?'); params.push(user.employee_id); }
  const open = "(r.status = 'pending' OR (r.status = 'confirmed' AND r.end_date >= ?))";
  if (st === 'open') { where.push(open); params.push(t); } else if (st === 'closed') { where.push(`NOT ${open}`); params.push(t); }
  const order = st === 'closed' ? 'r.end_date DESC, r.id DESC' : `CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.start_date, r.id`;
  return db.prepare(`${RESERVATION_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`).all(...params).map((r) => reservationOut(db, r, user));
}

module.exports = { RESERVATION_SQL, reservationOut, reservationById, listReservations };
