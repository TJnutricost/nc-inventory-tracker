// Request state machine on PostgreSQL (D-46, migration Slice 3): the PG counterpart of src/requests.js. NOT used by the
// running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages (read the
// header of src/requests.js); every function is async and takes an executor `q` (a pg Pool or a transaction client) where
// the SQLite version takes `db`.
//
// The transition table and the pure helpers (TRANSITIONS, TERMINAL, LIVE, OPENED_MSG, canTransition) are imported from
// src/requests.js, which has no database imports; they move here at cutover.
//
// Concurrency: `transition` stays a compare-and-set (UPDATE ... WHERE id = $ AND status = <the status we validated>
// [AND opened_at IS NULL]); no row lock is taken. Under READ COMMITTED a second writer blocks on the first one's row lock,
// then re-checks its WHERE against the committed row: it matches 0 rows and gets the same 400 as on SQLite.
const base = require('../requests');
const { NOW } = require('./time');

const { TRANSITIONS, TERMINAL, LIVE, OPENED_MSG, canTransition } = base;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const isResolving = (to) => !['open', 'dropped_off'].includes(to);
// An id as the integer column accepts it, or null (SQLite simply finds no row for 'abc'; PostgreSQL would raise 22P02).
const INT4_MAX = 2147483647;
const toId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && Math.abs(n) <= INT4_MAX ? n : null; };

const getRequest = async (q, id) => (await q.query('SELECT * FROM requests WHERE id = $1', [toId(id)])).rows[0];

// Moves request `id` to `to`. `note` (when `setNote`) replaces resolution_note; `assetId` (optional) attaches an asset.
// Throws 404 (unknown), 400 (transition not allowed, or lost a race). Returns the updated row.
async function transition(q, id, to, { actorAccountId = null, note, setNote = false, assetId = null, actorIsAdmin = false, requireUnopened = false } = {}) {
  const r = await getRequest(q, id);
  if (!r) throw httpError(404, 'Request not found');
  if (!canTransition(r.type, r.status, to)) {
    throw httpError(400, TERMINAL.includes(r.status) ? 'This request is already closed' : 'This request is not open');
  }
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const sets = [`status = ${p(to)}`];
  if (isResolving(to)) sets.push(`resolved_by = ${p(actorAccountId)}`, `resolved_at = ${NOW}`);
  if (setNote) sets.push(`resolution_note = ${p(note ?? null)}`);
  if (assetId) sets.push(`asset_id = ${p(assetId)}`);
  if (actorIsAdmin) sets.push(`opened_at = COALESCE(opened_at, ${NOW})`); // acting on a request is opening it
  // `requireUnopened` (the employee's rescind) is part of the same UPDATE, so IT opening the request and the employee
  // rescinding it at the same moment cannot both win.
  const info = await q.query(`UPDATE requests SET ${sets.join(', ')} WHERE id = ${p(r.id)} AND status = ${p(r.status)}${requireUnopened ? ' AND opened_at IS NULL' : ''}`, params);
  if (!info.rowCount) {
    if (requireUnopened && (await getRequest(q, r.id))?.opened_at) throw httpError(400, OPENED_MSG);
    throw httpError(400, 'This request was just updated by someone else. Reload and try again.');
  }
  return getRequest(q, r.id);
}

// IT opens a live request (the admin detail view calls this; there are no GET side effects). Sets opened_at once; opening
// again, or opening a request that is already closed, changes nothing. Returns the row.
async function openRequest(q, id) {
  const r = await getRequest(q, id);
  if (!r) throw httpError(404, 'Request not found');
  await q.query(`UPDATE requests SET opened_at = ${NOW} WHERE id = $1 AND opened_at IS NULL AND status IN (${LIVE.map((_, i) => `$${i + 2}`).join(',')})`, [r.id, ...LIVE]);
  return getRequest(q, r.id);
}

// The lifecycle a person sees. `rescinded` needs to know the requester cancelled it themselves (resolved_by is their own login).
async function lifecycle(q, r) {
  switch (r.status) {
    case 'open': return r.opened_at ? 'in_review' : 'submitted';
    case 'approved': return 'approved';
    case 'dropped_off': return 'dropped_off';
    case 'denied': return 'denied';
    case 'completed': return 'fulfilled';
    case 'cancelled': {
      const by = r.resolved_by == null ? null : (await q.query('SELECT employee_id FROM accounts WHERE id = $1', [toId(r.resolved_by)])).rows[0];
      return by && by.employee_id === r.user_id ? 'rescinded' : 'cancelled';
    }
    default: return r.status;
  }
}
// One row at a time on purpose: `q` may be a transaction client, which runs one query at a time anyway.
async function withLifecycle(q, rows) {
  if (!Array.isArray(rows)) return { ...rows, lifecycle: await lifecycle(q, rows) };
  const out = [];
  for (const r of rows) out.push({ ...r, lifecycle: await lifecycle(q, r) });
  return out;
}

// A direct check-out fulfils the employee's open equipment requests for that asset — but only when it actually
// delivers what was asked: a request for a PERMANENT assignment is completed only by a permanent assignment (a temporary
// loan must not silently close it); an unspecified request (NULL type) is completed by either.
async function completeEquipmentRequests(q, { employeeId, assetId, assignmentType, actorAccountId, actorIsAdmin = false }) {
  const ids = (await q.query(`SELECT id FROM requests WHERE type = 'equipment' AND status IN ('open','approved') AND user_id = $1 AND asset_id = $2
    AND (requested_assignment_type IS NULL OR requested_assignment_type = $3) ORDER BY id`, [toId(employeeId), toId(assetId), assignmentType])).rows.map((r) => r.id);
  for (const id of ids) await transition(q, id, 'completed', { actorAccountId, actorIsAdmin });
  return ids.length;
}

// Checking an asset in completes the live return request for that asset + employee.
async function completeReturnRequests(q, { employeeId, assetId, actorAccountId, actorIsAdmin = false }) {
  const ids = (await q.query("SELECT id FROM requests WHERE type = 'return' AND status IN ('open','dropped_off') AND user_id = $1 AND asset_id = $2 ORDER BY id",
    [toId(employeeId), toId(assetId)])).rows.map((r) => r.id);
  for (const id of ids) await transition(q, id, 'completed', { actorAccountId, actorIsAdmin });
  return ids.length;
}

module.exports = { TRANSITIONS, TERMINAL, LIVE, OPENED_MSG, canTransition, transition, openRequest, lifecycle, withLifecycle, completeEquipmentRequests, completeReturnRequests };
