// Request state machine for the CURRENT workflow (Phase 1 Foundation Closeout). This is a guard, not a redesign: the
// statuses are the ones that already exist and the UI is unchanged.
//
//   equipment  open -> approved | completed | denied | cancelled      approved -> completed | denied | cancelled
//   return     open -> dropped_off | completed | cancelled            dropped_off -> completed | cancelled
//   issue      open -> completed (IT resolved it) | cancelled (the reporter withdrew it, or IT dismissed it)
//   denied / completed / cancelled are terminal: nothing moves out of them, and there is no edit or delete of a request.
//
// opened_at (Phase 2 Slice 5): NULL until IT first opens a live request, then set once and never overwritten. It is not a
// status. The user-facing lifecycle is DERIVED from status + opened_at (see `lifecycle`):
//   submitted   open, opened_at NULL          in_review  open, opened_at set
//   approved    approved                      dropped_off  (return) the employee says they handed it in
//   fulfilled   completed                     denied     denied
//   rescinded   cancelled by the requester    cancelled  cancelled by IT (dismissed / closed)
// An employee may rescind only while opened_at is NULL; any admin action on a request also sets it.
//
// Every status change goes through `transition`, which writes with `WHERE id = ? AND status = <the status we validated>`
// so two simultaneous actions (IT approves while the employee cancels) cannot both win. The table CHECKs added in
// migration 9 are the second line of defence: they make contradictory status/type/timestamp combinations impossible
// even for code that bypasses this module. (Transition rules need the previous row, which a CHECK cannot see and a
// trigger would not port to PostgreSQL, so they live here.)
const TRANSITIONS = {
  equipment: { open: ['approved', 'completed', 'denied', 'cancelled'], approved: ['completed', 'denied', 'cancelled'], denied: [], completed: [], cancelled: [] },
  return: { open: ['dropped_off', 'completed', 'cancelled'], dropped_off: ['completed', 'cancelled'], completed: [], cancelled: [] },
  issue: { open: ['completed', 'cancelled'], completed: [], cancelled: [] },
};
const TERMINAL = ['denied', 'completed', 'cancelled'];
const LIVE = ['open', 'approved', 'dropped_off']; // not yet closed (the "Open" tab)
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const OPENED_MSG = 'IT has already opened this request, so it can no longer be rescinded.';

const canTransition = (type, from, to) => !!(TRANSITIONS[type] && TRANSITIONS[type][from] && TRANSITIONS[type][from].includes(to));

// open / dropped_off are "not yet resolved" (no resolver, no timestamp); every other status records who and when.
const isResolving = (to) => !['open', 'dropped_off'].includes(to);

// Moves request `id` to `to`. `note` (when `setNote`) replaces resolution_note; `assetId` (optional) attaches an asset.
// Throws 404 (unknown), 400 (transition not allowed, or lost a race). Returns the updated row.
function transition(db, id, to, { actorAccountId = null, note, setNote = false, assetId = null, actorIsAdmin = false, requireUnopened = false } = {}) {
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
  if (actorIsAdmin) sets.push("opened_at = COALESCE(opened_at, datetime('now'))"); // acting on a request is opening it
  // `requireUnopened` (the employee's rescind) is part of the same UPDATE, so IT opening the request and the employee
  // rescinding it at the same moment cannot both win.
  const info = db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ? AND status = ?${requireUnopened ? ' AND opened_at IS NULL' : ''}`).run(...params, id, r.status);
  if (!info.changes) {
    if (requireUnopened && db.prepare('SELECT opened_at FROM requests WHERE id = ?').get(id)?.opened_at) throw httpError(400, OPENED_MSG);
    throw httpError(400, 'This request was just updated by someone else. Reload and try again.');
  }
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

// IT opens a live request (the admin detail view calls this; there are no GET side effects). Sets opened_at once; opening
// again, or opening a request that is already closed, changes nothing. Returns the row.
function openRequest(db, id) {
  const r = db.prepare('SELECT id FROM requests WHERE id = ?').get(id);
  if (!r) throw httpError(404, 'Request not found');
  db.prepare(`UPDATE requests SET opened_at = datetime('now') WHERE id = ? AND opened_at IS NULL AND status IN (${LIVE.map(() => '?').join(',')})`).run(id, ...LIVE);
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

// The lifecycle a person sees. `rescinded` needs to know the requester cancelled it themselves (resolved_by is their own login).
function lifecycle(db, r) {
  switch (r.status) {
    case 'open': return r.opened_at ? 'in_review' : 'submitted';
    case 'approved': return 'approved';
    case 'dropped_off': return 'dropped_off';
    case 'denied': return 'denied';
    case 'completed': return 'fulfilled';
    case 'cancelled': {
      const by = r.resolved_by == null ? null : db.prepare('SELECT employee_id FROM accounts WHERE id = ?').get(r.resolved_by);
      return by && by.employee_id === r.user_id ? 'rescinded' : 'cancelled';
    }
    default: return r.status;
  }
}
const withLifecycle = (db, rows) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, lifecycle: lifecycle(db, r) })) : { ...rows, lifecycle: lifecycle(db, rows) });

// A direct check-out fulfils the employee's open equipment requests for that asset — but only when it actually
// delivers what was asked: a request for a PERMANENT assignment is completed only by a permanent assignment (a temporary
// loan must not silently close it); an unspecified request (NULL type) is completed by either.
function completeEquipmentRequests(db, { employeeId, assetId, assignmentType, actorAccountId, actorIsAdmin = false }) {
  const ids = db.prepare(`SELECT id FROM requests WHERE type = 'equipment' AND status IN ('open','approved') AND user_id = ? AND asset_id = ?
    AND (requested_assignment_type IS NULL OR requested_assignment_type = ?)`).all(employeeId, assetId, assignmentType).map((r) => r.id);
  for (const id of ids) transition(db, id, 'completed', { actorAccountId, actorIsAdmin });
  return ids.length;
}

// Checking an asset in completes the live return request for that asset + employee.
function completeReturnRequests(db, { employeeId, assetId, actorAccountId, actorIsAdmin = false }) {
  const ids = db.prepare("SELECT id FROM requests WHERE type = 'return' AND status IN ('open','dropped_off') AND user_id = ? AND asset_id = ?")
    .all(employeeId, assetId).map((r) => r.id);
  for (const id of ids) transition(db, id, 'completed', { actorAccountId, actorIsAdmin });
  return ids.length;
}

module.exports = { TRANSITIONS, TERMINAL, LIVE, OPENED_MSG, canTransition, transition, openRequest, lifecycle, withLifecycle, completeEquipmentRequests, completeReturnRequests };
