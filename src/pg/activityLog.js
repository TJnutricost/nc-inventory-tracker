// The activity log on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/activityLog.js. NOT used by the running app
// yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures, same rows; every function is async
// and takes an executor `q` (a pg Pool or a transaction client from withTransaction) where the SQLite version takes `db`.
//
// The SQL fragments ACTOR_JOIN / ACTOR_NAME are imported from src/activityLog.js (plain text, no placeholders, no database imports):
// the other twins splice them exactly as their SQLite modules do. They move here at cutover.
// Differences from SQLite (output identical): `?` -> `$n`; an undefined actor / subject binds NULL explicitly.
const base = require('../activityLog');

const { ACTOR_JOIN, ACTOR_NAME } = base;

async function log(q, assetId, actorAccountId, action, details, subjectEmployeeId = null) {
  await q.query('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
    [assetId ?? null, actorAccountId ?? null, subjectEmployeeId ?? null, action, details || null]);
}

// IT's activity list: the newest `limit` rows (the route caps it), with who did it and the asset.
async function recent(q, limit) {
  return (await q.query(`
    SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
    ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
    ORDER BY ac.id DESC LIMIT $1`, [limit])).rows;
}

module.exports = { ACTOR_JOIN, ACTOR_NAME, log, recent };
