// Getting equipment back on PostgreSQL (D-46, D-48, migration Slice 5C-5): the PG twin of src/assetCustody.js (IT's check-in, IT asking
// a holder to return an asset, and the employee actions on equipment they hold: request return, report an issue, "I'm returning
// this"). NOT used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures,
// the same return values and the same errors (status + message); async, executor `q` first. The emails stay in the routes, after these
// return (after COMMIT), in the same order as before; the only effect registered here is check-in's `holds_owed` (waitlist
// evaluateAsset, dispatched after COMMIT and dropped on rollback, D-47).
//
// Every function is ONE transaction, the caller's when `q` is a transaction client, else its own (isInTransaction(q) ? run(q) :
// withTransaction(run, q)), and takes the ASSET ROW LOCK FIRST (lockAsset: the 5A timeout gives 503 ASSET_BUSY, everything rolled
// back), then reads and writes that asset's dependent rows. On SQLite these were atomic in practice (BEGIN IMMEDIATE, or synchronous
// statements in one event-loop turn together with the route's pre-reads); here the route's pre-reads are separate seam calls, so the
// state they decided on is read again under the lock (carry-overs (w), (x)):
//   checkin            the open assignments and the target are re-read on the locked asset: none open -> 400 'This asset is not
//                      checked out'; the target no longer open (checked in meanwhile) -> 400 'Choose which person is returning it'
//                      (the route's messages; a stale target is never "returned" twice). The 'lost' -> 'available' rule reads the
//                      status as locked. The live return requests it completes are locked (FOR UPDATE) before their transition, so a
//                      concurrent "dropped off" / cancel cannot turn the check-in into a compare-and-set failure: it waits, then
//                      sees the request completed (SQLite's order: check-in first). Then refreshStatus, completeReturnRequests and
//                      waitlist.evaluateAsset on the same client (carry-overs (b), (g), (m)): the freed time is offered in the same
//                      transaction.
//   requestReturnFrom  the holder is re-checked under the lock: a holder who returned it meanwhile is skipped (null, like a holder
//                      already asked; on SQLite the route would not have listed them). The live-request check and the INSERT are
//                      serialized by the lock (and backed by the unique index idx_requests_live_return), so concurrent requests
//                      never create a second live return request: the second gets null.
//   requestMyReturn,   the route's guard (assetAccess.heldAsset: visible AND held by the caller) is run again under the lock, with the
//   reportIssue        route's 404 / 400, before the duplicate check: an asset checked in meanwhile is refused as SQLite's route would
//                      have refused it, and two concurrent taps give one row and SQLite's 400 for the other. (A direct call with an
//                      asset the caller does not hold is refused here, where SQLite's module, behind its route, would insert.)
//                      reportIssue stores the category of the asset as locked.
//   returnNotice       the "checked out to you" check, the live return request (locked FOR UPDATE) and its transition / the INSERT,
//                      all under the lock.
// Assets are never deleted, so the 404 of a missing asset is unreachable through the routes. NUL in any text (notes, message, note):
// PostgreSQL cannot store it, the statement fails (a 500) and nothing is written, where SQLite stores it (the (as) / (at) policy,
// accepted for 5D unless the owner decides otherwise).
//
// Lock order: asset row -> its assignment rows -> its request rows -> its reservations / waitlist entries (evaluateAsset), the same as
// 5C-4's approve (asset -> assignments -> request) and the 4B / 4C writes (asset first). The writes that touch these rows WITHOUT the
// asset lock (request transitions: cancel / deny / resolve / dropped-off / open; the overdue mark on an assignment) are one autocommit
// UPDATE of one row each and never wait for anything while holding it, so no cycle is possible; the import (src/pg/assetRecords.js)
// takes the assets table lock before any asset row.
const { refreshStatus } = require('./assignments');
const requests = require('./requests');
const { evaluateAsset } = require('./waitlist');
const { log } = require('./activityLog');
const { heldAsset, holdsAsset } = require('./assetAccess');
const { openAssignments } = require('./assetViews');
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');
const { NOW } = require('./time');
const { toId } = require('./reservations');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const LIVE_RETURN = "type = 'return' AND asset_id = $1 AND user_id = $2 AND status IN ('open','dropped_off')";

// The asset row lock, first: the locked row, a 404 when there is none, 503 ASSET_BUSY unchanged.
async function lockedAsset(c, asset) {
  const key = toId(asset && asset.id);
  if (key === null || key < 1) throw httpError(404, 'Asset not found');
  try {
    return await lockAsset(c, key);
  } catch (err) {
    if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
    throw err;
  }
}

// POST /api/assets/:id/checkin: see the header. `asset` and `target` (the open assignment being ended) were read by the route; `notes`
// and `location` are cleaned.
async function checkin(q, { asset, target, actorAccountId, condition, notes, toMaintenance, location }) {
  await inTransaction(q, async (c) => {
    const a = await lockedAsset(c, asset);
    const open = await openAssignments(c, a.id);
    if (!open.length) throw httpError(400, 'This asset is not checked out');
    const t = open.find((o) => o.id === Number(target && target.id));
    if (!t) throw httpError(400, 'Choose which person is returning it');
    await c.query(`UPDATE assignments SET returned_at = ${NOW}, returned_to = $1, condition_in = $2, return_notes = $3 WHERE id = $4`,
      [actorAccountId ?? null, condition ?? null, notes ?? null, t.id]);
    if (condition) await c.query('UPDATE assets SET condition = $1 WHERE id = $2', [condition, a.id]);
    if (toMaintenance) await c.query("UPDATE assets SET status = 'maintenance' WHERE id = $1", [a.id]);
    else if (a.status === 'lost') await c.query("UPDATE assets SET status = 'available' WHERE id = $1", [a.id]);
    await refreshStatus(c, a.id);
    if (location) await c.query('UPDATE assets SET location = $1 WHERE id = $2', [location, a.id]);
    await c.query(`SELECT id FROM requests WHERE ${LIVE_RETURN} ORDER BY id FOR UPDATE`, [a.id, t.employee_id]);
    await requests.completeReturnRequests(c, { employeeId: t.employee_id, assetId: a.id, actorAccountId, actorIsAdmin: true });
    await evaluateAsset(c, a.id); // (a return frees the time it was holding: the first eligible waitlisted employee is offered it, atomically)
  });
}

// POST /api/assets/:id/request-return, for one holder: IT's live 'return' request + its activity row, or null when one is already live
// for this asset + employee, or the holder no longer has it (the route skips that holder). The route emails the holder after each one.
async function requestReturnFrom(q, { asset, holder: t, message, neededBy, actorAccountId }) {
  return inTransaction(q, async (c) => {
    const a = await lockedAsset(c, asset);
    if (!(await holdsAsset(c, a.id, t.employee_id))) return null;
    if ((await c.query(`SELECT 1 FROM requests WHERE ${LIVE_RETURN}`, [a.id, toId(t.employee_id)])).rowCount) return null;
    const r = (await c.query("INSERT INTO requests (type, user_id, asset_id, message, needed_by, created_by) VALUES ('return', $1, $2, $3, $4, $5) RETURNING *",
      [t.employee_id, a.id, message ?? null, neededBy ?? null, actorAccountId ?? null])).rows[0];
    await log(c, a.id, actorAccountId, 'return_requested', `From ${t.user_name}${r.needed_by ? ` · by ${r.needed_by}` : ''}`, t.employee_id);
    return r;
  });
}

// "Request return": the employee asks to give a held asset back (the assignment is NOT ended; see src/assetCustody.js). One live return
// request per asset + employee. Returns the new request.
async function requestMyReturn(q, user, asset, message) {
  return inTransaction(q, async (c) => {
    const a = await lockedAsset(c, asset);
    await heldAsset(c, user, a.id);
    const me = user.employee_id;
    const live = (await c.query(`SELECT status FROM requests WHERE ${LIVE_RETURN}`, [a.id, toId(me)])).rows[0];
    if (live) throw httpError(400, live.status === 'dropped_off' ? "You've already told IT you dropped this off." : 'A return has already been requested for this item.');
    const r = (await c.query("INSERT INTO requests (type, user_id, asset_id, message, created_by) VALUES ('return', $1, $2, $3, $4) RETURNING *",
      [me, a.id, message ?? null, user.account_id ?? null])).rows[0];
    await log(c, a.id, user.account_id, 'return_requested', `${user.name} asked to return it${message ? ` · ${message}` : ''}`, me);
    return r;
  });
}

// "Report issue": a short description tied to one held asset, a request of type 'issue' (see src/assetCustody.js). The route checks the
// description first. Returns the new request.
async function reportIssue(q, user, asset, message) {
  return inTransaction(q, async (c) => {
    const a = await lockedAsset(c, asset);
    await heldAsset(c, user, a.id);
    const me = user.employee_id;
    if ((await c.query("SELECT 1 FROM requests WHERE type = 'issue' AND status = 'open' AND asset_id = $1 AND user_id = $2 AND message = $3", [a.id, toId(me), message])).rowCount) {
      throw httpError(400, "You've already reported this issue and it's still open.");
    }
    const r = (await c.query("INSERT INTO requests (type, user_id, asset_id, category, message, created_by) VALUES ('issue', $1, $2, $3, $4, $5) RETURNING *",
      [me, a.id, a.category, message, user.account_id ?? null])).rows[0];
    await log(c, a.id, user.account_id, 'issue_reported', message.length > 160 ? `${message.slice(0, 157)}…` : message, me);
    return r;
  });
}

// A user can proactively say "I'm returning this" without being asked (the route emails IT afterwards). `note` is cleaned.
async function returnNotice(q, user, asset, note) {
  await inTransaction(q, async (c) => {
    const a = await lockedAsset(c, asset);
    const me = user.employee_id;
    const mine = me && await holdsAsset(c, a.id, me);
    if (!mine) throw httpError(400, "This isn't checked out to you");
    const existing = (await c.query(`SELECT * FROM requests WHERE ${LIVE_RETURN} FOR UPDATE`, [a.id, toId(me)])).rows[0];
    if (existing) { if (existing.status === 'open') await requests.transition(c, existing.id, 'dropped_off'); }
    else {
      await c.query("INSERT INTO requests (type, status, user_id, asset_id, message, created_by) VALUES ('return', 'dropped_off', $1, $2, $3, $4)",
        [me, a.id, note || 'Returned by user', user.account_id ?? null]);
    }
    await log(c, a.id, user.account_id, 'dropped_off', note || 'User returned it to IT', me);
  });
}

module.exports = { checkin, requestReturnFrom, requestMyReturn, reportIssue, returnNotice };
