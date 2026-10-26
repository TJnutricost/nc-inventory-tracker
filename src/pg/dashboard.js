// The dashboard on PostgreSQL (D-46, D-48, migration Slice 5C-2): the PG twin of src/dashboard.js (the signed-in person's equipment
// and open requests, and for IT the inventory statistics and work queues). NOT used by the running app yet (Slice 5D binds it to the
// driver seam under the same name). Same name, parallel signature, the same answer (keys, numbers as JS numbers, order, LIMITs);
// async, executor `q` first.
//
// Differences from SQLite (output identical):
//   - `?` -> `$n`; date('now') -> TODAY, date('now','+60 day') -> the UTC date 60 days later (src/pg/time.js; compared as text, D-46).
//   - COUNT(*) comes back as a JS number (src/pg/pool.js int8 parser), as better-sqlite3 returns it.
//   - `value` (the total purchase cost): SQLite sums the REAL column with compensated (Kahan-Babuska) summation, PostgreSQL's float8
//     sum adds plainly, so 0.1 + 0.2 + 0.3 could differ in the last bit. The sum is taken over numeric (each cost's 15-significant-digit
//     decimal value, exact addition) and returned as float8, which gives SQLite's correctly rounded totals for money-like values; 0
//     (a number) when nothing is costed, as COALESCE(SUM(...), 0) gives on SQLite.
//   - SQLite's `COALESCE(ca.employee_id = r.user_id, 0)` (an integer 0/1) -> a CASE giving the same 0/1 integer.
//   - SQLite's two-argument scalar MIN(x, y) in the expiring list's ORDER BY -> LEAST(x, y) (both arguments are never NULL here).
//   - Ties get explicit tie-breakers reproducing the order SQLite gives them (its scan order, measured by the differential test), so
//     equal timestamps, dates or counts list identically: mine `..., s.id`; myRequests `created_at DESC, status, id` (SQLite reads them
//     through idx_requests_employee_status, 'approved' before 'open'); openRequests `created_at DESC, r.id`; byCategory
//     `n DESC, category DESC` (SQLite emits tied groups in descending category order); overdue `due_date, s.id`; expiring `..., id`.
//     These follow SQLite's current query plans; SQLite itself guarantees no tie order. The return-request subqueries can match at most one row
//     (the idx_requests_live_return unique index), so they cannot raise PostgreSQL's "more than one row" error.
const requestRules = require('./requests');
const { ACTOR_JOIN, ACTOR_NAME } = require('./activityLog');
const { TODAY, dateOf } = require('./time');

const IN_60_DAYS = dateOf("statement_timestamp() + interval '60 days'");
const LIVE_ASSET = "status NOT IN ('retired','lost','disposed') AND archived_at IS NULL";

async function dashboard(q, user) {
  const rows = async (sql, params = []) => (await q.query(sql, params)).rows;
  const me = user.employee_id ?? null;
  const mine = await rows(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial, a.location, a.brand, a.model, a.id AS asset_id,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb,
      (SELECT r.id FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_request_id,
      (SELECT r.status FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_status,
      (SELECT r.needed_by FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_by,
      (SELECT r.message FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_message,
      (SELECT CASE WHEN ca.employee_id = r.user_id THEN 1 ELSE 0 END FROM requests r LEFT JOIN accounts ca ON ca.id = r.created_by WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_self,
      (SELECT r.id FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open' ORDER BY r.id DESC LIMIT 1) AS issue_request_id,
      (SELECT COUNT(*) FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open') AS open_issues
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = $1 AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC, s.id`, [me]);
  const myRequests = await requestRules.withLifecycle(q,
    await rows(`SELECT * FROM requests WHERE user_id = $1 AND type = 'equipment' AND status IN ('open','approved') ORDER BY created_at DESC, status, id`, [me]));
  const out = { mine, myRequests };
  if (user.role === 'admin') {
    const c = async (sql) => (await rows(sql))[0].c;
    out.stats = {
      total: await c(`SELECT COUNT(*) c FROM assets WHERE ${LIVE_ASSET}`),
      available: await c("SELECT COUNT(*) c FROM assets WHERE status = 'available' AND archived_at IS NULL"),
      checked_out: await c('SELECT COUNT(DISTINCT asset_id) c FROM assignments WHERE returned_at IS NULL'),
      maintenance: await c("SELECT COUNT(*) c FROM assets WHERE status = 'maintenance' AND archived_at IS NULL"),
      overdue: await c(`SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL AND due_date < ${TODAY}`),
      open_requests: await c("SELECT COUNT(*) c FROM requests WHERE status IN ('open','approved','dropped_off')"),
      users: await c("SELECT COUNT(*) c FROM employees WHERE status = 'active'"),
      value: await c(`SELECT COALESCE(SUM(purchase_cost::numeric), 0)::float8 c FROM assets WHERE ${LIVE_ASSET}`),
      warranty_soon: await c(`SELECT COUNT(*) c FROM assets WHERE ${LIVE_ASSET} AND warranty_expires BETWEEN ${TODAY} AND ${IN_60_DAYS}`),
      licenses_soon: await c(`SELECT COUNT(*) c FROM assets WHERE ${LIVE_ASSET} AND license_expires BETWEEN ${TODAY} AND ${IN_60_DAYS}`),
    };
    out.byCategory = await rows(`SELECT category, COUNT(*) n FROM assets WHERE ${LIVE_ASSET} GROUP BY category ORDER BY n DESC, category DESC`);
    out.overdue = await rows(`
      SELECT s.*, a.name AS asset_name, a.tag, u.name AS user_name FROM assignments s
      JOIN assets a ON a.id = s.asset_id JOIN employees u ON u.id = s.employee_id
      WHERE s.returned_at IS NULL AND s.due_date < ${TODAY} ORDER BY s.due_date, s.id LIMIT 20`);
    out.openRequests = await requestRules.withLifecycle(q, await rows(`
      SELECT r.*, u.name AS user_name, a.name AS asset_name, a.tag AS asset_tag FROM requests r
      JOIN employees u ON u.id = r.user_id LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.status IN ('open','approved','dropped_off') ORDER BY r.created_at DESC, r.id LIMIT 20`));
    out.expiring = await rows(`
      SELECT id, tag, name, category, warranty_expires, license_expires FROM assets
      WHERE ${LIVE_ASSET} AND (warranty_expires BETWEEN ${TODAY} AND ${IN_60_DAYS} OR license_expires BETWEEN ${TODAY} AND ${IN_60_DAYS})
      ORDER BY LEAST(COALESCE(warranty_expires,'9999'), COALESCE(license_expires,'9999')), id LIMIT 20`);
    out.activity = await rows(`
      SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
      ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
      ORDER BY ac.id DESC LIMIT 15`);
  }
  return out;
}

module.exports = { dashboard };
