// The request list and the request writes on PostgreSQL (D-46, D-48, migration Slice 5C-4): the PG twin of src/requestRecords.js
// (GET /api/requests, POST /api/requests, POST /api/requests/:id/approve). NOT used by the running app yet (Slice 5D binds it to the
// driver seam under the same names). Same names, parallel signatures, the same rows and errors; async, executor `q` first. The route's
// checks before each call, the activity row of a new request and the emails stay in the routes, exactly as on SQLite.
//
// listRequests: the same filters, columns and aliases, then requestAccess.cancelBlock (`can_cancel`) and requests.withLifecycle from
// the PG twins, one row at a time (`q` may be a transaction client).
//   - `self_initiated` is a 0/1 NUMBER, as on SQLite (`COALESCE(ca.employee_id = r.user_id, 0)`): the PG boolean is cast to int.
//     cancelBlock reads it as given (`r.self_initiated ?? ...`), so no extra query per return request.
//   - Tie order (carry-over (aq)): SQLite sorts with a temp B-tree and keeps rows that tie on (live first, created_at DESC) in the order
//     its plan scanned them, and the plan depends on the viewer (measured, including the LIMIT 500 cut):
//       admin: SCAN requests (rowid order)                                  -> tie-breaker `r.id`
//       employee: idx_requests_employee_status (user_id, status) for r.user_id -> tie-breaker `r.status, r.id`
//     The twin adds exactly these (not `id DESC`: that is not what SQLite returns). r.status is COLLATE "C" (byte order, like BINARY).
//
// createEquipmentRequest: one INSERT ... RETURNING * (SQLite: INSERT, then read the row back), the same stored values and the same
// row. An unknown person / asset / account / catalog node is a foreign-key violation on BOTH engines (SQLite runs with
// foreign_keys = ON): a database error either way (a 500), never reached through the route, which checks the person, the asset and
// the catalog node first. No new refusal is added. Text containing a NUL character (message, needed_by, ...) cannot be stored on
// PostgreSQL: the INSERT fails (a 500) where SQLite stores it; only reachable through a hand-made request (the (as) / (at) policy:
// accepted for 5D unless the owner decides otherwise).
//
// approveRequest: the assignment (when an asset is attached) and the request's transition are ONE transaction: the caller's when `q`
// is a transaction client, else its own (isInTransaction(q) ? run(q) : withTransaction(run, q)); a failure anywhere rolls back
// everything (no assignment row, no asset status change, no activity row, the request unchanged). Steps:
//   1. lockAsset(asset)        the asset row (FOR UPDATE, the 5A lock timeout: 503 ASSET_BUSY, everything rolled back). Taken before
//                              createAssignment validates anything, as SQLite's BEGIN IMMEDIATE takes its lock first.
//   2. the request, re-read    still approvable (requests.canTransition)? If not, the transition's own 400 ('This request is already
//                              closed' / 'This request is not open') before any write: the message the route gives on SQLite.
//   3. createAssignment        joined to this transaction (src/pg/assignments.js; it locks the same asset again, a no-op, and re-checks
//                              archived, status, reservations, holds and seats under the lock).
//   4. the request row lock    SELECT ... FOR UPDATE, then requests.transition: it reads the request under that lock, so a request
//                              closed by a concurrent cancel / deny gets the transition's 400 (never a wrong write), and its UPDATE
//                              stays a compare-and-set.
//   Without an asset: step 4 only.
// Lock order: asset row -> assignment rows (createAssignment: assignments, held waitlist entries, the asset row it already holds) ->
// request row. It cannot deadlock against the 5A / 4B / 4C paths: reservations, waitlist actions, createAssignment, the photo writes
// (and check-in from 5C-5) all lock the asset FIRST and none of them locks a request row and then an asset; the request-only writes
// (deny, cancel / rescind, resolve, dropped-off, open) are one autocommit UPDATE each and never wait for an asset while holding a
// request row. The foreign-key checks of the INSERTs take KEY SHARE on employee / account rows, which the people / accounts writes'
// FOR NO KEY UPDATE locks do not conflict with.
//
// Races with the route's pre-reads (carry-over (ah)): the route reads the request, the person, the asset and the catalog subtree in
// separate seam calls before this transaction (moving them in is a route change, 5D). Under the locks above:
//   REFUSED, nothing written: the request cancelled / denied / approved / completed meanwhile (step 2 or 4: the transition's 400);
//     the asset checked out to someone else or its seats filled (createAssignment's 400); the asset archived, or marked retired /
//     lost / maintenance / disposed (createAssignment's 400); a confirmed reservation or another employee's live hold now overlapping
//     the checkout (createAssignment's 409); the person now already holding the asset (createAssignment's 400); the asset row busy
//     longer than the lock timeout (503 ASSET_BUSY).
//   ACCEPTED (as SQLite's approveRequest would, given the same arguments): the person deactivated meanwhile (createAssignment does not
//     check the person's status; the route does, before); the asset moved to another catalog entry after the route's subtree check;
//     the asset's own fields edited (name, notes, ...). These stay route-level checks for 5D.
const { canTransition, TERMINAL, LIVE, withLifecycle, transition } = require('./requests');
const { createAssignment } = require('./assignments');
const { cancelBlock } = require('./requestAccess');
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');
const { toId } = require('./reservations');
const activityLog = require('./activityLog');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// GET /api/requests. An employee sees only their own; `status` ('open' | 'closed') and `type` were validated by the route.
async function listRequests(q, user, { status, type } = {}) {
  const where = []; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const isAdmin = user.role === 'admin';
  if (!isAdmin) where.push(`r.user_id = ${p(toId(user.employee_id))}`);
  if (status === 'open') where.push("r.status IN ('open','approved','dropped_off')");
  else if (status === 'closed') where.push("r.status IN ('denied','completed','cancelled')");
  if (type) where.push(`r.type = ${p(type)}`);
  const { rows } = await q.query(`
    SELECT r.*, u.name AS user_name, u.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, COALESCE(c.name, ca.login_email) AS created_by_name, COALESCE(rv.name, ra.login_email) AS resolved_by_name,
      COALESCE((ca.employee_id = r.user_id)::int, 0) AS self_initiated
    FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN accounts ca ON ca.id = r.created_by LEFT JOIN employees c ON c.id = ca.employee_id
    LEFT JOIN accounts ra ON ra.id = r.resolved_by LEFT JOIN employees rv ON rv.id = ra.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('open','dropped_off','approved') THEN 0 ELSE 1 END, r.created_at DESC, ${isAdmin ? '' : 'r.status, '}r.id LIMIT 500`, params);
  const out = [];
  for (const r of rows) out.push({ ...r, can_cancel: LIVE.includes(r.status) && !(await cancelBlock(q, r, user)) });
  return withLifecycle(q, out);
}

// POST /api/requests: the new equipment request (a permanent-assignment request only records the ask), returned as stored. Since Slice 5D-2
// (carry-over (ah)) it is ONE transaction (the caller's when `q` is a client): the asset row lock first (when an asset is attached; the 5A
// timeout gives 503 ASSET_BUSY), the route's person / asset checks again under it (`recheck`, see assertRequestable), the INSERT, and the
// 'requested' activity row (`activity`): an asset archived or taken meanwhile is refused, and a request never exists without its activity row.
async function createEquipmentRequest(q, { recheck, activity, ...v }) {
  const run = async (c) => {
    if (recheck) {
      if (v.assetId !== null && v.assetId !== undefined) {
        try { await lockAsset(c, v.assetId); } catch (err) {
          if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
          throw err;
        }
      }
      await assertRequestable(c, v, recheck);
    }
    const r = (await c.query(`INSERT INTO requests (type, user_id, asset_id, category, message, needed_by, created_by, requested_assignment_type, catalog_node_id, catalog_path, asset_label)
      VALUES ('equipment', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [v.forUser, v.assetId, v.category, v.message, v.neededBy, v.createdBy, v.wantedType, v.nodeId, v.catalogPath, v.assetLabel])).rows[0];
    if (activity) await activityLog.log(c, v.assetId, activity.actorAccountId, 'requested', activity.details, v.forUser);
    return r;
  };
  return isInTransaction(q) ? run(q) : withTransaction(run, q);
}

// The route's checks about the person and the asset, again inside the write's transaction (same refusals, same words).
async function assertRequestable(c, v, recheck) {
  const person = (await c.query('SELECT status FROM employees WHERE id = $1', [toId(v.forUser)])).rows[0];
  if (!person) throw httpError(404, 'User not found');
  if (person.status !== 'active') throw httpError(400, "That person is inactive, so a request can't be made for them");
  if (v.assetId === null || v.assetId === undefined) return;
  const asset = (await c.query('SELECT status, archived_at FROM assets WHERE id = $1', [toId(v.assetId)])).rows[0];
  if (!asset) throw httpError(404, 'Asset not found');
  if (asset.archived_at) throw httpError(400, "This asset is archived and can't be requested.");
  if (recheck.restrictToAvailable && (asset.status !== 'available'
    || (await c.query('SELECT 1 FROM assignments WHERE asset_id = $1 AND employee_id = $2 AND returned_at IS NULL', [toId(v.assetId), toId(v.forUser)])).rows[0])) throw httpError(404, 'Asset not found');
}

// resolve / dropped-off (Slice 5D-2, carry-over (ah)): the status change and its activity row in ONE transaction. Locks the request row
// first (it takes no asset lock, as before: the request-only writes never wait for an asset). Same `activity` / return as SQLite.
async function transitionLogged(q, { id, to, opts, activity }) {
  const run = async (c) => {
    await c.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [toId(id)]);
    const request = await transition(c, id, to, opts);
    const asset = request.asset_id == null ? undefined : (await c.query('SELECT * FROM assets WHERE id = $1', [toId(request.asset_id)])).rows[0];
    if (asset || !activity.onlyIfAsset) await activityLog.log(c, request.asset_id, activity.actorAccountId, activity.action, activity.details, activity.subjectUserId);
    return { request, asset };
  };
  return isInTransaction(q) ? run(q) : withTransaction(run, q);
}

// The transition's own refusal for a request that can no longer move to `to` (src/pg/requests.js transition, same wording).
async function assertApprovable(c, id, to) {
  const cur = (await c.query('SELECT type, status FROM requests WHERE id = $1', [toId(id)])).rows[0];
  if (!cur) throw httpError(404, 'Request not found');
  if (!canTransition(cur.type, cur.status, to)) throw httpError(400, TERMINAL.includes(cur.status) ? 'This request is already closed' : 'This request is not open');
}

// POST /api/requests/:id/approve: see the header. Returns the new assignment, or null.
async function approveRequest(q, { request: r, asset, employeeId, actorAccountId, assignmentType, dueDate, dueTime, note }) {
  const to = asset ? 'completed' : 'approved';
  const run = async (c) => {
    let made = null;
    if (asset) {
      try {
        await lockAsset(c, asset.id);
      } catch (err) {
        if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
        throw err;
      }
      await assertApprovable(c, r.id, to);
      made = (await createAssignment(c, {
        assetId: asset.id, employeeId, actorAccountId, actorIsAdmin: true,
        type: assignmentType, dueDate, dueTime, notes: `Request #${r.id}`,
      })).assignment;
    }
    await c.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [toId(r.id)]);
    await transition(c, r.id, to, { actorAccountId, actorIsAdmin: true, note, setNote: true, assetId: asset ? asset.id : null });
    return made;
  };
  return isInTransaction(q) ? run(q) : withTransaction(run, q);
}

module.exports = { listRequests, createEquipmentRequest, approveRequest, transitionLogged };
