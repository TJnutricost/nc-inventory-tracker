// The activity log (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL is unchanged;
// the database handle is the first argument, like the other data modules. Routes migrated to the temporary driver seam reach `log`
// through src/dataSeam (`await data.activityLog.log(...)`); the routes not migrated yet keep calling it through a thin bound alias in
// server.js (`log(assetId, ...)`). A PostgreSQL twin follows in Slice 5C.

// Who did it: an account, shown by its employee's name (or login email if unlinked).
const ACTOR_JOIN = 'LEFT JOIN accounts aa ON aa.id = ac.actor_id LEFT JOIN employees u ON u.id = aa.employee_id';
const ACTOR_NAME = 'COALESCE(u.name, aa.login_email) AS actor_name';

function log(db, assetId, actorAccountId, action, details, subjectEmployeeId = null) {
  db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(assetId, actorAccountId, subjectEmployeeId, action, details || null);
}

module.exports = { ACTOR_JOIN, ACTOR_NAME, log };
