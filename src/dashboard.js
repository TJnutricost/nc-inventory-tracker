// The dashboard (SQLite): the signed-in person's equipment and open requests, and for IT the inventory statistics and work queues.
// Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL and the answer are unchanged; the database
// handle is the first argument, like the other data modules (server.js read `req.user`, now passed as `user`). Reached through the
// temporary driver seam (src/dataSeam). A PostgreSQL twin follows in Slice 5C.
const requestRules = require('./requests');
const { ACTOR_JOIN, ACTOR_NAME } = require('./activityLog');

function dashboard(db, user) {
  const mine = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial, a.location, a.brand, a.model, a.id AS asset_id,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb,
      (SELECT r.id FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_request_id,
      (SELECT r.status FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_status,
      (SELECT r.needed_by FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_by,
      (SELECT r.message FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_message,
      (SELECT COALESCE(ca.employee_id = r.user_id, 0) FROM requests r LEFT JOIN accounts ca ON ca.id = r.created_by WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_self,
      (SELECT r.id FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open' ORDER BY r.id DESC LIMIT 1) AS issue_request_id,
      (SELECT COUNT(*) FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open') AS open_issues
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC`).all(user.employee_id);
  const myRequests = db.prepare(`SELECT * FROM requests WHERE user_id = ? AND type = 'equipment' AND status IN ('open','approved') ORDER BY created_at DESC`).all(user.employee_id).map((r) => requestRules.withLifecycle(db, r));
  const out = { mine, myRequests };
  if (user.role === 'admin') {
    const c = (sql, ...p) => db.prepare(sql).get(...p).c;
    out.stats = {
      total: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL"),
      available: c("SELECT COUNT(*) c FROM assets WHERE status = 'available' AND archived_at IS NULL"),
      // Checked out = assets someone holds on a TEMPORARY checkout (a permanent assignment, e.g. a license seat, is not a checkout). The All assets
      // list for ?status=checked_out uses the same test (src/assetViews.js), so the card and its list agree.
      checked_out: c("SELECT COUNT(DISTINCT asset_id) c FROM assignments WHERE returned_at IS NULL AND assignment_type = 'checkout'"),
      maintenance: c("SELECT COUNT(*) c FROM assets WHERE status = 'maintenance' AND archived_at IS NULL"),
      overdue: c("SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL AND due_date < date('now')"),
      open_requests: c("SELECT COUNT(*) c FROM requests WHERE status IN ('open','approved','dropped_off')"),
      users: c("SELECT COUNT(*) c FROM employees WHERE status = 'active'"),
      value: db.prepare("SELECT COALESCE(SUM(purchase_cost),0) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL").get().c,
      warranty_soon: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND warranty_expires BETWEEN date('now') AND date('now','+60 day')"),
      licenses_soon: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND license_expires BETWEEN date('now') AND date('now','+60 day')"),
    };
    out.byCategory = db.prepare("SELECT category, COUNT(*) n FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL GROUP BY category ORDER BY n DESC").all();
    out.overdue = db.prepare(`
      SELECT s.*, a.name AS asset_name, a.tag, u.name AS user_name FROM assignments s
      JOIN assets a ON a.id = s.asset_id JOIN employees u ON u.id = s.employee_id
      WHERE s.returned_at IS NULL AND s.due_date < date('now') ORDER BY s.due_date LIMIT 20`).all();
    out.openRequests = db.prepare(`
      SELECT r.*, u.name AS user_name, a.name AS asset_name, a.tag AS asset_tag FROM requests r
      JOIN employees u ON u.id = r.user_id LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.status IN ('open','approved','dropped_off') ORDER BY r.created_at DESC LIMIT 20`).all().map((r) => requestRules.withLifecycle(db, r));
    out.expiring = db.prepare(`
      SELECT id, tag, name, category, warranty_expires, license_expires FROM assets
      WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND (warranty_expires BETWEEN date('now') AND date('now','+60 day') OR license_expires BETWEEN date('now') AND date('now','+60 day'))
      ORDER BY MIN(COALESCE(warranty_expires,'9999'), COALESCE(license_expires,'9999')) LIMIT 20`).all();
    out.activity = db.prepare(`
      SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
      ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
      ORDER BY ac.id DESC LIMIT 15`).all();
  }
  return out;
}

module.exports = { dashboard };
