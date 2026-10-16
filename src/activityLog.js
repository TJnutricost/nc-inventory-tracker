// The activity log (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL is unchanged;
// the database handle is the first argument, like the other data modules. Routes reach it through the temporary driver seam
// (`await data.activityLog.log(...)`; since Slice 5B-4 every route, and the server.js `log` alias is gone). Slice 5B-4 added `recent`
// (IT's activity list, GET /api/activity, extracted verbatim the same way). A PostgreSQL twin follows in Slice 5C.

// Who did it: an account, shown by its employee's name (or login email if unlinked).
const ACTOR_JOIN = 'LEFT JOIN accounts aa ON aa.id = ac.actor_id LEFT JOIN employees u ON u.id = aa.employee_id';
const ACTOR_NAME = 'COALESCE(u.name, aa.login_email) AS actor_name';

function log(db, assetId, actorAccountId, action, details, subjectEmployeeId = null) {
  db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(assetId, actorAccountId, subjectEmployeeId, action, details || null);
}

// IT's activity list: the newest `limit` rows (the route caps it), with who did it and the asset.
function recent(db, limit) {
  return db.prepare(`
    SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
    ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
    ORDER BY ac.id DESC LIMIT ?`).all(limit);
}

module.exports = { ACTOR_JOIN, ACTOR_NAME, log, recent };
