// Request state machine for the CURRENT workflow (Phase 1 Foundation Closeout). This is a guard, not a redesign: the
// statuses are the ones that already exist and the UI is unchanged.
//
//   equipment  open -> approved | completed | denied | cancelled      approved -> completed | denied | cancelled
//   return     open -> dropped_off | completed | cancelled            dropped_off -> completed | cancelled
//   denied / completed / cancelled are terminal: nothing moves out of them, and there is no edit or delete of a request.
//
// Every status change goes through `transition`, which writes with `WHERE id = ? AND status = <the status we validated>`
// so two simultaneous actions (IT approves while the employee cancels) cannot both win. The table CHECKs added in
// migration 9 are the second line of defence: they make contradictory status/type/timestamp combinations impossible
// even for code that bypasses this module. (Transition rules need the previous row, which a CHECK cannot see and a
// trigger would not port to PostgreSQL, so they live here.)
const TRANSITIONS = {
  equipment: { open: ['approved', 'completed', 'denied', 'cancelled'], approved: ['completed', 'denied', 'cancelled'], denied: [], completed: [], cancelled: [] },
  return: { open: ['dropped_off', 'completed', 'cancelled'], dropped_off: ['completed', 'cancelled'], completed: [], cancelled: [] },
};
const TERMINAL = ['denied', 'completed', 'cancelled'];
const LIVE = ['open', 'approved', 'dropped_off']; // not yet closed (the "Open" tab)
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const canTransition = (type, from, to) => !!(TRANSITIONS[type] && TRANSITIONS[type][from] && TRANSITIONS[type][from].includes(to));

// open / dropped_off are "not yet resolved" (no resolver, no timestamp); every other status records who and when.
const isResolving = (to) => !['open', 'dropped_off'].includes(to);

// Moves request `id` to `to`. `note` (when `setNote`) replaces resolution_note; `assetId` (optional) attaches an asset.
// Throws 404 (unknown), 400 (transition not allowed, or lost a race). Returns the updated row.
function transition(db, id, to, { actorAccountId = null, note, setNote = false, assetId = null } = {}) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!r) throw httpError(404, 'Request not found');
  if (!canTransition(r.type, r.status, to)) {
    throw httpError(400, TERMINAL.includes(r.status) ? 'This request is already closed' : 'This request is not open');
  }
  const sets = ['status = ?']; const params = [to];
  if (isResolving(to)) {
    sets.push('resolved_by = ?', "resolved_at = datetime('now')");
    params.push(actorAccountId);
  }
  if (setNote) { sets.push('resolution_note = ?'); params.push(note ?? null); }
  if (assetId) { sets.push('asset_id = ?'); params.push(assetId); }
  const info = db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...params, id, r.status);
  if (!info.changes) throw httpError(400, 'This request was just updated by someone else. Reload and try again.');
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

// A direct check-out fulfils the employee's open equipment requests for that asset — but only when it actually
// delivers what was asked: a request for a PERMANENT assignment is completed only by a permanent assignment (a temporary
// loan must not silently close it); an unspecified request (NULL type) is completed by either.
function completeEquipmentRequests(db, { employeeId, assetId, assignmentType, actorAccountId }) {
  const ids = db.prepare(`SELECT id FROM requests WHERE type = 'equipment' AND status IN ('open','approved') AND user_id = ? AND asset_id = ?
    AND (requested_assignment_type IS NULL OR requested_assignment_type = ?)`).all(employeeId, assetId, assignmentType).map((r) => r.id);
  for (const id of ids) transition(db, id, 'completed', { actorAccountId });
  return ids.length;
}

// Checking an asset in completes the live return request for that asset + employee.
function completeReturnRequests(db, { employeeId, assetId, actorAccountId }) {
  const ids = db.prepare("SELECT id FROM requests WHERE type = 'return' AND status IN ('open','dropped_off') AND user_id = ? AND asset_id = ?")
    .all(employeeId, assetId).map((r) => r.id);
  for (const id of ids) transition(db, id, 'completed', { actorAccountId });
  return ids.length;
}

module.exports = { TRANSITIONS, TERMINAL, LIVE, canTransition, transition, completeEquipmentRequests, completeReturnRequests };
