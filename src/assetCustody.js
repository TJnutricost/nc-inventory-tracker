// Getting equipment back (SQLite): IT's check-in transaction, IT asking a holder to return an asset, and the employee actions on
// equipment they hold (request return, report an issue, "I'm returning this"). Extracted VERBATIM from src/server.js in PostgreSQL
// migration Slice 5B-2 (D-48): the SQL and the transaction boundaries are unchanged; the database handle is the first argument, like the
// other data modules (values server.js read from `req` are passed in, already cleaned exactly as server.js cleaned them). Emails stay
// in the routes, after these return, in the same order as before. Reached through the temporary driver seam (src/dataSeam). A
// PostgreSQL twin follows in Slice 5C (check-in there must lock the asset first: see the Slice 5 carry-overs in PROJECT_STATUS.md).
const assignments = require('./assignments');
const requestRules = require('./requests');
const waitlistRules = require('./waitlist');
const { log } = require('./activityLog');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// POST /api/assets/:id/checkin: ending the assignment and completing the employee's return request succeed or fail together, and a
// return frees the time it was holding: the first eligible waitlisted employee is offered it, atomically (one immediate transaction).
// `asset` and `target` (the open assignment being ended) were read by the route; `notes` and `location` are cleaned.
function checkin(db, { asset, target, actorAccountId, condition, notes, toMaintenance, location }) {
  db.transaction(() => {
    db.prepare("UPDATE assignments SET returned_at = datetime('now'), returned_to = ?, condition_in = ?, return_notes = ? WHERE id = ?")
      .run(actorAccountId, condition, notes, target.id);
    if (condition) db.prepare('UPDATE assets SET condition = ? WHERE id = ?').run(condition, asset.id);
    if (toMaintenance) db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(asset.id);
    else if (asset.status === 'lost') db.prepare("UPDATE assets SET status = 'available' WHERE id = ?").run(asset.id);
    assignments.refreshStatus(db, asset.id);
    if (location) db.prepare('UPDATE assets SET location = ? WHERE id = ?').run(location, asset.id);
    requestRules.completeReturnRequests(db, { employeeId: target.employee_id, assetId: asset.id, actorAccountId, actorIsAdmin: true });
    waitlistRules.evaluateAsset(db, asset.id); // (a return frees the time it was holding: the first eligible waitlisted employee is offered it, atomically)
  }).immediate();
}

// POST /api/assets/:id/request-return, for one holder: IT's live 'return' request + its activity row, or null when one is already live
// for this asset + employee (the route skips that holder). The route emails the holder after each one, as before.
function requestReturnFrom(db, { asset, holder: t, message, neededBy, actorAccountId }) {
  if (db.prepare("SELECT 1 FROM requests WHERE type='return' AND asset_id=? AND user_id=? AND status IN ('open','dropped_off')").get(asset.id, t.employee_id)) return null;
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, message, needed_by, created_by) VALUES ('return', ?, ?, ?, ?, ?)")
    .run(t.employee_id, asset.id, message, neededBy, actorAccountId);
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
  log(db, asset.id, actorAccountId, 'return_requested', `From ${t.user_name}${r.needed_by ? ` · by ${r.needed_by}` : ''}`, t.employee_id);
  return r;
}

// "Request return": the employee asks to give a held asset back. Creates the same live 'return' request IT can create
// (status 'open', shown as "Return requested"); the assignment is NOT ended — it ends only when IT checks the asset in.
// The employee later taps "I've dropped it off" (existing). One live return request per asset + employee, so a second
// tap — or one while IT has already asked — is refused instead of creating a conflicting row. Returns the new request.
function requestMyReturn(db, user, asset, message) {
  const me = user.employee_id;
  const live = db.prepare("SELECT status FROM requests WHERE type = 'return' AND asset_id = ? AND user_id = ? AND status IN ('open','dropped_off')").get(asset.id, me);
  if (live) throw httpError(400, live.status === 'dropped_off' ? "You've already told IT you dropped this off." : 'A return has already been requested for this item.');
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, message, created_by) VALUES ('return', ?, ?, ?, ?)").run(me, asset.id, message, user.account_id);
  log(db, asset.id, user.account_id, 'return_requested', `${user.name} asked to return it${message ? ` · ${message}` : ''}`, me);
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
}

// "Report issue": a short description tied to one held asset. It is a request of type 'issue' in the same queue IT already
// works from (open -> resolved by IT, or withdrawn by the employee). No comments, attachments, priorities or SLAs.
// (The route checks the description first.) Returns the new request.
function reportIssue(db, user, asset, message) {
  const me = user.employee_id;
  if (db.prepare("SELECT 1 FROM requests WHERE type = 'issue' AND status = 'open' AND asset_id = ? AND user_id = ? AND message = ?").get(asset.id, me, message)) {
    throw httpError(400, "You've already reported this issue and it's still open.");
  }
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, category, message, created_by) VALUES ('issue', ?, ?, ?, ?, ?)").run(me, asset.id, asset.category, message, user.account_id);
  log(db, asset.id, user.account_id, 'issue_reported', message.length > 160 ? `${message.slice(0, 157)}…` : message, me);
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
}

// A user can proactively say "I'm returning this" without being asked (the route emails IT afterwards). `note` is cleaned.
function returnNotice(db, user, asset, note) {
  const me = user.employee_id;
  const mine = me && db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me);
  if (!mine) throw httpError(400, "This isn't checked out to you");
  const existing = db.prepare("SELECT * FROM requests WHERE type='return' AND asset_id=? AND user_id=? AND status IN ('open','dropped_off')").get(asset.id, me);
  if (existing) { if (existing.status === 'open') requestRules.transition(db, existing.id, 'dropped_off'); }
  else db.prepare("INSERT INTO requests (type, status, user_id, asset_id, message, created_by) VALUES ('return', 'dropped_off', ?, ?, ?, ?)")
    .run(me, asset.id, note || 'Returned by user', user.account_id);
  log(db, asset.id, user.account_id, 'dropped_off', note || 'User returned it to IT', me);
}

module.exports = { checkin, requestReturnFrom, requestMyReturn, reportIssue, returnNotice };
