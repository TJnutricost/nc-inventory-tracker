// Loading a request and the rescind/cancel policy on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of
// src/requestAccess.js (read its comments for the policy). NOT used by the running app yet (Slice 5D binds it to the driver seam under
// the same names). Same names, parallel signatures, the same answers ({ status, msg } or null) and the same 404; async, executor `q`
// first. OPENED_MSG comes from src/requests.js (pure, through src/pg/requests.js).
//
// Differences from SQLite (output identical): `?` -> `$n`; ids that are not integers in the column's range find nothing (as on
// SQLite) instead of raising a PG 22P02.
// cancelBlock is a read: the transition itself re-checks the status (and `opened_at` for an employee's rescind) inside its UPDATE
// (src/pg/requests.js transition), so a request that changes between this check and the cancel gets a refusal, not a wrong write.
const { OPENED_MSG } = require('./requests');
const { toId } = require('./reservations');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

async function loadRequest(q, id) {
  const r = (await q.query('SELECT * FROM requests WHERE id = $1', [toId(Number(id))])).rows[0];
  if (!r) throw httpError(404, 'Request not found');
  return r;
}

const isSelfInitiated = async (q, r) => !!(await q.query('SELECT 1 FROM accounts WHERE id = $1 AND employee_id = $2', [toId(r.created_by), toId(r.user_id)])).rows[0];

// Returns null when `user` may cancel `r` in its current state, otherwise { status, msg } (see src/requestAccess.js).
async function cancelBlock(q, r, user) {
  const isAdmin = user.role === 'admin';
  if (!isAdmin && r.user_id !== user.employee_id) return { status: 403, msg: 'Not allowed' };
  if (r.type === 'equipment' && r.requested_assignment_type === 'permanent' && ['approved', 'completed'].includes(r.status)) {
    const assigned = r.asset_id && (await q.query('SELECT 1 FROM assignments WHERE asset_id = $1 AND employee_id = $2 AND notes = $3 LIMIT 1',
      [toId(r.asset_id), toId(r.user_id), `Request #${r.id}`])).rows[0];
    if (assigned || !isAdmin) return { status: 400, msg: 'IT has already approved this permanent assignment request, so it can no longer be cancelled. Ask IT if the equipment should come back.' };
  }
  if (!isAdmin && r.opened_at) return { status: 400, msg: OPENED_MSG };
  if (!isAdmin && r.type === 'return') {
    if (!(r.self_initiated ?? await isSelfInitiated(q, r))) return { status: 403, msg: 'Not allowed' };
    if (r.status !== 'open') return { status: 400, msg: "You've already told IT you dropped this off, so this can't be cancelled. Ask IT if that was a mistake." };
  }
  return null;
}

module.exports = { loadRequest, isSelfInitiated, cancelBlock };
