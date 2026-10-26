// The request list and the request writes server.js still ran inline (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL
// migration Slice 5B-4 (D-48): the SQL and the transaction boundaries are unchanged; the database handle is the first argument, like the
// other data modules. The routes check the request, call these through the temporary driver seam (`await data.requestRecords.*`) and
// send the emails, in the same order as before. A PostgreSQL twin follows in Slice 5C.
const requestRules = require('./requests');
const assignments = require('./assignments');
const requestAccess = require('./requestAccess');
const activityLog = require('./activityLog');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// GET /api/requests. An employee sees only their own; `status` ('open' | 'closed') and `type` were validated by the route.
// `self_initiated`: the employee started this themselves (vs. IT asking). `can_cancel`: the server's own answer to
// "may this viewer cancel it right now", so the UI never has to guess the rule.
function listRequests(db, user, { status, type } = {}) {
  const where = []; const params = [];
  if (user.role !== 'admin') { where.push('r.user_id = ?'); params.push(user.employee_id); }
  if (status === 'open') where.push("r.status IN ('open','approved','dropped_off')");
  else if (status === 'closed') where.push("r.status IN ('denied','completed','cancelled')");
  if (type) { where.push('r.type = ?'); params.push(type); }
  const rows = db.prepare(`
    SELECT r.*, u.name AS user_name, u.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, COALESCE(c.name, ca.login_email) AS created_by_name, COALESCE(rv.name, ra.login_email) AS resolved_by_name,
      COALESCE(ca.employee_id = r.user_id, 0) AS self_initiated
    FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN accounts ca ON ca.id = r.created_by LEFT JOIN employees c ON c.id = ca.employee_id
    LEFT JOIN accounts ra ON ra.id = r.resolved_by LEFT JOIN employees rv ON rv.id = ra.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('open','dropped_off','approved') THEN 0 ELSE 1 END, r.created_at DESC LIMIT 500`).all(...params);
  return requestRules.withLifecycle(db, rows.map((r) => ({ ...r, can_cancel: requestRules.LIVE.includes(r.status) && !requestAccess.cancelBlock(db, r, user) })));
}

// POST /api/requests: the new equipment request (a permanent-assignment request only records the ask; nothing is assigned until an admin
// approves it), read back as stored. The checks before it, the activity row and the email stay in the route.
function createEquipmentRequest(db, { recheck, activity, ...v }) {
  return db.transaction(() => {
    if (recheck) assertRequestable(db, v, recheck);
    const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, category, message, needed_by, created_by, requested_assignment_type, catalog_node_id, catalog_path, asset_label) VALUES ('equipment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.forUser, v.assetId, v.category, v.message, v.neededBy, v.createdBy, v.wantedType, v.nodeId, v.catalogPath, v.assetLabel);
    if (activity) activityLog.log(db, v.assetId, activity.actorAccountId, 'requested', activity.details, v.forUser);
    return db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
  }).immediate();
}

// Slice 5D-2 (carry-over (ah)): the route's checks about the person and the asset, run again in the write's own transaction, so a person
// deactivated or an asset archived / taken between the route's reads and the insert is refused. `recheck.restrictToAvailable` (an employee
// picking a specific item under a catalog choice) also re-checks that the item is still available and not already theirs.
function assertRequestable(db, v, recheck) {
  const person = db.prepare('SELECT status FROM employees WHERE id = ?').get(v.forUser);
  if (!person) throw httpError(404, 'User not found');
  if (person.status !== 'active') throw httpError(400, "That person is inactive, so a request can't be made for them");
  if (v.assetId === null || v.assetId === undefined) return;
  const asset = db.prepare('SELECT status, archived_at FROM assets WHERE id = ?').get(v.assetId);
  if (!asset) throw httpError(404, 'Asset not found');
  if (asset.archived_at) throw httpError(400, "This asset is archived and can't be requested.");
  if (recheck.restrictToAvailable && (asset.status !== 'available'
    || db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(v.assetId, v.forUser))) throw httpError(404, 'Asset not found');
}

// resolve / dropped-off (Slice 5D-2, carry-over (ah)): the status change and its activity row in ONE transaction (they were two steps).
// `activity` = { action, details, actorAccountId, subjectUserId, onlyIfAsset }: with onlyIfAsset the row is written only when the request's
// asset still exists (dropped-off). Returns { request, asset } (asset: the request's asset row or undefined); the emails stay in the route.
function transitionLogged(db, { id, to, opts, activity }) {
  return db.transaction(() => {
    const request = requestRules.transition(db, id, to, opts);
    const asset = request.asset_id == null ? undefined : db.prepare('SELECT * FROM assets WHERE id = ?').get(request.asset_id);
    if (asset || !activity.onlyIfAsset) activityLog.log(db, request.asset_id, activity.actorAccountId, activity.action, activity.details, activity.subjectUserId);
    return { request, asset };
  }).immediate();
}

// POST /api/requests/:id/approve: the assignment (if an asset is attached) and the request's completion (or approval, with no asset)
// succeed or fail together, in ONE immediate transaction; the emails go out only after it commits (in the route). Availability, archived
// and seat rules are enforced by createAssignment inside it. Returns the new assignment, or null.
function approveRequest(db, { request: r, asset, employeeId, actorAccountId, assignmentType, dueDate, dueTime, note }) {
  return db.transaction(() => {
    const made = asset ? assignments.createAssignment(db, {
      assetId: asset.id, employeeId, actorAccountId, actorIsAdmin: true,
      type: assignmentType, dueDate, dueTime, notes: `Request #${r.id}`,
    }).assignment : null;
    requestRules.transition(db, r.id, asset ? 'completed' : 'approved', { actorAccountId, actorIsAdmin: true, note, setNote: true, assetId: asset ? asset.id : null });
    return made;
  }).immediate();
}

module.exports = { listRequests, createEquipmentRequest, approveRequest, transitionLogged };
