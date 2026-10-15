// Loading a request and the rescind/cancel policy (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2
// (D-48): the SQL and the rules are unchanged; the database handle is the first argument, like the other data modules. The request
// routes reach these through the temporary driver seam (src/dataSeam; the list, approve, resolve and dropped-off routes too since Slice
// 5B-4, and src/requestRecords.js listRequests uses `cancelBlock` for each row's `can_cancel`). A PostgreSQL twin follows in Slice 5C.
const requestRules = require('./requests');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

function loadRequest(db, id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id));
  if (!r) throw httpError(404, 'Request not found');
  return r;
}

const isSelfInitiated = (db, r) => !!db.prepare('SELECT 1 FROM accounts WHERE id = ? AND employee_id = ?').get(r.created_by, r.user_id);
// Rescind/cancel policy, one place for the route and for the `can_cancel` flag on the list. Returns null when `user` may
// cancel `r` in its current state, otherwise { status, msg }. (Status transitions themselves are guarded by requests.js.)
//
//   admin     any live request (IT's authority is unchanged)
//   employee  only their OWN request, and only while it is live and nothing has happened to it yet:
//               equipment  open | approved (a permanent request that IT already approved/assigned is final)
//               return     only one the employee started themselves, and only while 'open' — once they say they dropped
//                          it off, or when IT is the one who asked, they answer with "I've dropped it off", not a cancel
//               issue      open
//             AND IT must not have opened it yet (requests.opened_at, Phase 2 Slice 5): once IT has opened or acted on a
//             request the employee can no longer rescind it. The same condition is part of the UPDATE in requests.transition,
//             so IT opening it and the employee rescinding it at the same instant cannot both win.
function cancelBlock(db, r, user) {
  const isAdmin = user.role === 'admin';
  if (!isAdmin && r.user_id !== user.employee_id) return { status: 403, msg: 'Not allowed' };
  // Once IT's approval of a PERMANENT-assignment request has been acted on, it can't be rescinded (and history can never
  // read "cancelled" for a request whose approval made the assignment). Approval completes the request in the same
  // transaction as the assignment, so this only bites on an approved row (e.g. legacy data) — an employee may rescind a
  // permanent request only while it is still open; and nobody may cancel one that already produced its assignment.
  if (r.type === 'equipment' && r.requested_assignment_type === 'permanent' && ['approved', 'completed'].includes(r.status)) {
    const assigned = r.asset_id && db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND notes = ?').get(r.asset_id, r.user_id, `Request #${r.id}`);
    if (assigned || !isAdmin) return { status: 400, msg: 'IT has already approved this permanent assignment request, so it can no longer be cancelled. Ask IT if the equipment should come back.' };
  }
  if (!isAdmin && r.opened_at) return { status: 400, msg: requestRules.OPENED_MSG };
  if (!isAdmin && r.type === 'return') {
    if (!(r.self_initiated ?? isSelfInitiated(db, r))) return { status: 403, msg: 'Not allowed' };
    if (r.status !== 'open') return { status: 400, msg: "You've already told IT you dropped this off, so this can't be cancelled. Ask IT if that was a mistake." };
  }
  return null;
}

module.exports = { loadRequest, isSelfInitiated, cancelBlock };
