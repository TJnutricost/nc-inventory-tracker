// Employee equipment requests on PostgreSQL: the PG twin of src/equipmentRequests.js (read its header for the lifecycle, the permanent / shared split and
// the 48-hour priority hold). Same names, parallel signatures (executor `q` first), the same rows, errors and audit events; every function is async.
//
// Locking (the 4B/5A rule: the asset row first, then the request row, never the other way round):
//   - writes that involve a unit (markReady, fulfill, decline / cancel / release from READY, the sweep) take lockAsset first. When the asset is only known
//     from the request, ONE unlocked `SELECT asset_id` finds it, the asset is locked, then the request is re-read FOR UPDATE and every check runs on that row.
//   - writes with no unit (create, review, approve, setPermanent) lock just the request row (create: the employee row, so two submissions of the same
//     equipment cannot both pass the duplicate check).
//   - claimByCheckout runs inside createAssignment's transaction, which already holds the asset lock.
// Email: none here; the routes send it after the write commits, as for the SQLite twin.
//
// SQL differences from SQLite: `datetime('now')` -> NOW (src/pg/time.js), `hold_expires_at = datetime('now', '+48 hours')` -> stampPlus, COUNT(*) is a bigint
// string (Number()), `hold_active` is a boolean (coerced), ids that are not integers in range find nothing.
const base = require('../equipmentRequests');
const reservations = require('./reservations');
const baseReservations = require('../reservations');
const assignments = require('./assignments');
const activityLog = require('./activityLog');
const T = require('../timeRange');
const time = require('./time');
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');

const { HOLD_HOURS, STATUSES, LABEL, LIVE, TERMINAL, TRANSITIONS, EMPLOYEE_CANCELLABLE, FIELD_MAX, TEXT_MAX, canTransition, track } = base;
const { httpError, when } = baseReservations;
const { toId } = reservations;
const { NOW } = time;
const HOLD_EXPIRY = time.stampPlus('statement_timestamp()', String(HOLD_HOURS * 3600));
const RELEASED = { asset_id: null, asset_label: null, ready_at: null };
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const waitlist = () => require('./waitlist'); // (lazily: it requires the reservations module)

const load = async (q, id, lock = false) => {
  const r = (await q.query(`SELECT * FROM equipment_requests WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [toId(id)])).rows[0];
  if (!r) throw httpError(404, 'Equipment request not found');
  return r;
};
const event = (q, id, actorAccountId, action, from, to, note) =>
  q.query('INSERT INTO equipment_request_events (request_id, actor_id, action, from_status, to_status, note) VALUES ($1, $2, $3, $4, $5, $6)', [id, actorAccountId ?? null, action, from, to, note || null]);

// Locks what a write on request `id` needs and returns the request, re-read under the lock: the unit first (when it has one, or `assetId` names it), then the row.
async function lockRequest(c, id, assetId = null) {
  const pre = (await c.query('SELECT asset_id FROM equipment_requests WHERE id = $1', [toId(id)])).rows[0];
  if (!pre) throw httpError(404, 'Equipment request not found');
  const first = assetId ?? pre.asset_id;
  if (first) await lockAsset(c, first);
  const r = await load(c, id, true);
  if (r.asset_id && r.asset_id !== first) await lockAsset(c, r.asset_id);
  return r;
}

async function move(c, r, to, { actor = null, action, note = null, set = {}, raw = [] }) {
  if (!canTransition(r.status, to)) {
    throw httpError(400, TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : `A ${LABEL[r.status].toLowerCase()} request can't become ${LABEL[to].toLowerCase()}.`);
  }
  const params = [to]; const sets = ['status = $1', `updated_at = ${NOW}`];
  for (const [k, v] of Object.entries(set)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  sets.push(...raw);
  if (TERMINAL.includes(to)) { params.push(actor ?? null); sets.push(`closed_at = ${NOW}`, `closed_by = $${params.length}`); }
  if (r.status === 'ready') sets.push('hold_expires_at = NULL', 'claimed_reservation_id = NULL'); // (leaving READY ends the hold and any claim)
  params.push(r.id, r.status);
  const info = await c.query(`UPDATE equipment_requests SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND status = $${params.length}`, params);
  if (!info.rowCount) throw httpError(409, 'This request was just updated by someone else. Reload and try again.');
  await event(c, r.id, actor, action, r.status, to, note);
  return load(c, r.id);
}
const requeue = (c, assetId) => waitlist().evaluateAsset(c, assetId);
const releasedNote = async (c, r, actor, action, details) => { if (r.asset_id) await activityLog.log(c, r.asset_id, actor, action, details, r.employee_id); };

// ---- employee: submit
async function create(q, v) {
  return inTransaction(q, async (c) => {
    const person = (await c.query('SELECT status FROM employees WHERE id = $1', [toId(v.employeeId)])).rows[0];
    if (!person) throw httpError(404, 'User not found');
    if (person.status !== 'active') throw httpError(400, "That person is inactive, so a request can't be made for them");
    // (no duplicate check: two identical monitors are two requests, one physical item each)
    const id = (await c.query(`INSERT INTO equipment_requests (employee_id, created_by, category, category_other, catalog_node_id, catalog_path, brand, model, details, permanent_requested)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [v.employeeId, v.createdBy ?? null, v.category, v.categoryOther ? 1 : 0, v.nodeId ?? null, v.catalogPath ?? null, v.brand ?? null, v.model ?? null, v.details ?? null, v.permanent ? 1 : 0])).rows[0].id;
    await event(c, id, v.createdBy, 'submitted', null, 'submitted', v.permanent ? 'Permanent assignment requested' : null);
    return load(c, id);
  });
}

// ---- reads
const SELECT = `SELECT r.*, e.name AS user_name, e.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, a.available_to_request AS asset_shared,
  (r.status = 'ready' AND r.hold_expires_at > ${NOW}) AS hold_active
  FROM equipment_requests r JOIN employees e ON e.id = r.employee_id LEFT JOIN assets a ON a.id = r.asset_id`;
const out = (r, user) => {
  const own = !!user.employee_id && r.employee_id === user.employee_id; const admin = user.role === 'admin';
  return {
    ...r, hold_expires_text: r.hold_expires_at ? T.fmtStamp(r.hold_expires_at) : null, status_label: LABEL[r.status],
    hold_active: !!r.hold_active, asset_shared: !!r.asset_shared,
    can_cancel: (own && EMPLOYEE_CANCELLABLE.includes(r.status)) || (admin && LIVE.includes(r.status)),
    can_decline_ready: own && r.status === 'ready',
    track: track(r),
  };
};

async function list(q, user, { status } = {}) {
  const where = []; const params = [];
  if (user.role !== 'admin') { params.push(user.employee_id); where.push(`r.employee_id = $${params.length}`); }
  if (status === 'open') where.push(`r.status IN (${LIVE.map((s) => `'${s}'`).join(',')})`);
  else if (status === 'closed') where.push(`r.status IN (${TERMINAL.map((s) => `'${s}'`).join(',')})`);
  return (await q.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('submitted','in_review','approved','ready') THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC LIMIT 500`, params)).rows.map((r) => out(r, user));
}
async function get(q, id, user) {
  const r = (await q.query(`${SELECT} WHERE r.id = $1`, [toId(id)])).rows[0];
  if (!r || (user.role !== 'admin' && r.employee_id !== user.employee_id)) throw httpError(404, 'Equipment request not found');
  const events = (await q.query(`SELECT ev.*, COALESCE(u.name, aa.login_email) AS actor_name FROM equipment_request_events ev
    LEFT JOIN accounts aa ON aa.id = ev.actor_id LEFT JOIN employees u ON u.id = aa.employee_id WHERE ev.request_id = $1 ORDER BY ev.id`, [r.id])).rows
    .map((ev) => ({ ...ev, actor_name: ev.actor_name || 'System', from_label: ev.from_status ? LABEL[ev.from_status] : null, to_label: LABEL[ev.to_status] }));
  const claim = r.claimed_reservation_id ? (await q.query('SELECT id, start_date, start_time, end_date, end_time, status FROM reservations WHERE id = $1', [r.claimed_reservation_id])).rows[0] : null;
  return { ...out(r, user), events, claim };
}
async function counts(q, user) {
  if (user.role === 'admin') return { attention: Number((await q.query("SELECT COUNT(*) c FROM equipment_requests WHERE status IN ('submitted','in_review','approved') OR (status = 'ready' AND claimed_reservation_id IS NOT NULL)")).rows[0].c) };
  if (!user.employee_id) return { attention: 0 };
  return { attention: Number((await q.query(`SELECT COUNT(*) c FROM equipment_requests WHERE employee_id = $1 AND status = 'ready' AND hold_expires_at > ${NOW}`, [user.employee_id])).rows[0].c) };
}

// ---- IT: decisions
async function review(q, id, { actorAccountId }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    return r.status === 'submitted' ? move(c, r, 'in_review', { actor: actorAccountId, action: 'opened' }) : r;
  });
}
function checkDecision(r, decision) {
  if (decision === undefined || decision === null || decision === '') return null;
  if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'The permanent assignment decision must be approved or denied.');
  if (!r.permanent_requested) throw httpError(400, 'This request did not ask for a permanent assignment.');
  return decision;
}
async function approve(q, id, { actorAccountId, note, permanentDecision, permanentNote }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    const decision = checkDecision(r, permanentDecision);
    const emp = (await c.query('SELECT status FROM employees WHERE id = $1', [r.employee_id])).rows[0];
    if (!emp || emp.status !== 'active') throw httpError(400, "That person is inactive, so this request can't be approved.");
    const set = { decision_note: note || r.decision_note || null, decided_by: actorAccountId ?? null };
    const raw = [`decided_at = ${NOW}`];
    if (decision) { set.permanent_decision = decision; set.permanent_note = permanentNote || null; }
    const moved = await move(c, r, 'approved', { actor: actorAccountId, action: 'approved', note, set, raw });
    if (decision) await event(c, r.id, actorAccountId, decision === 'approved' ? 'permanent_approved' : 'permanent_denied', 'approved', 'approved', permanentNote);
    return moved;
  });
}
async function setPermanent(q, id, { actorAccountId, decision, note }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'Choose approve or deny for the permanent assignment.');
    if (!r.permanent_requested) throw httpError(400, 'This request did not ask for a permanent assignment.');
    if (!['submitted', 'in_review', 'approved'].includes(r.status)) throw httpError(400, r.status === 'ready' ? 'The equipment is already on hold as shared equipment. Release it first.' : `This request is already ${LABEL[r.status].toLowerCase()}.`);
    const info = await c.query(`UPDATE equipment_requests SET permanent_decision = $1, permanent_note = $2, updated_at = ${NOW} WHERE id = $3 AND status = $4`, [decision, note || null, r.id, r.status]);
    if (!info.rowCount) throw httpError(409, 'This request was just updated by someone else. Reload and try again.');
    await event(c, r.id, actorAccountId, decision === 'approved' ? 'permanent_approved' : 'permanent_denied', r.status, r.status, note);
    return load(c, r.id);
  });
}
async function addNote(q, id, { actorAccountId, note }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    if (!note) throw httpError(400, 'Write a note first.');
    if (!LIVE.includes(r.status)) throw httpError(400, `This request is already ${LABEL[r.status].toLowerCase()}.`);
    await c.query(`UPDATE equipment_requests SET decision_note = $1, updated_at = ${NOW} WHERE id = $2`, [note, r.id]);
    await event(c, r.id, actorAccountId, 'note', r.status, r.status, note);
    return load(c, r.id);
  });
}
async function decline(q, id, { actorAccountId, note }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    const moved = await move(c, r, 'declined', { actor: actorAccountId, action: 'declined', note, set: { decision_note: note || r.decision_note || null, decided_by: actorAccountId ?? null } });
    if (r.status === 'ready') { await releasedNote(c, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} declined`); await requeue(c, r.asset_id); }
    return moved;
  });
}

// Ends the lapsed holds of one unit and settles its claims (the caller holds the lock and is in a transaction); see src/equipmentRequests.js expireDue.
async function expireDue(c, { assetId }) {
  const results = [];
  const today = await reservations.todayOf(c);
  for (const r of (await c.query(`SELECT * FROM equipment_requests WHERE status = 'ready' AND claimed_reservation_id IS NULL AND hold_expires_at <= ${NOW} AND asset_id = $1 ORDER BY id FOR UPDATE`, [assetId])).rows) {
    const claim = (await c.query("SELECT id FROM reservations WHERE asset_id = $1 AND employee_id = $2 AND status IN ('pending','confirmed') AND end_date >= $3 AND created_at >= $4 ORDER BY id LIMIT 1", [r.asset_id, r.employee_id, today, r.ready_at])).rows[0];
    if (claim) {
      await c.query(`UPDATE equipment_requests SET claimed_reservation_id = $1, updated_at = ${NOW} WHERE id = $2 AND status = 'ready'`, [claim.id, r.id]);
      await event(c, r.id, null, 'hold_claimed', 'ready', 'ready', `Reserved during the hold (reservation #${claim.id}); the reservation keeps the unit`);
      await releasedNote(c, r, null, 'priority_hold_claimed', `Equipment request #${r.id} · claimed by reservation #${claim.id}`);
      results.push({ request: await load(c, r.id), outcome: 'claimed' });
    } else {
      const moved = await move(c, r, 'approved', { actor: null, action: 'hold_expired', note: `The ${HOLD_HOURS}-hour priority hold ended unclaimed`, set: RELEASED });
      await releasedNote(c, r, null, 'priority_hold_expired', `Equipment request #${r.id} · hold ended unclaimed`);
      await requeue(c, r.asset_id);
      results.push({ request: moved, outcome: 'expired' });
    }
  }
  for (const r of (await c.query(`SELECT e.* FROM equipment_requests e JOIN reservations v ON v.id = e.claimed_reservation_id
    WHERE e.status = 'ready' AND (v.status NOT IN ('pending','confirmed') OR v.end_date < $1) AND e.asset_id = $2 ORDER BY e.id FOR UPDATE OF e`, [today, assetId])).rows) {
    const moved = await move(c, r, 'approved', { actor: null, action: 'claim_ended', note: 'The reservation ended before the equipment was issued', set: RELEASED });
    await releasedNote(c, r, null, 'priority_hold_expired', `Equipment request #${r.id} · its reservation ended`);
    await requeue(c, r.asset_id);
    results.push({ request: moved, outcome: 'claim_ended' });
  }
  return results;
}
// The sweep: one transaction per unit with a lapsed hold (the unit's lock first), so one busy unit never holds up the rest.
async function expireHolds(q) {
  const units = (await q.query(`SELECT DISTINCT asset_id FROM equipment_requests WHERE status = 'ready' AND (claimed_reservation_id IS NOT NULL OR hold_expires_at <= ${NOW}) ORDER BY asset_id`)).rows;
  const results = [];
  for (const { asset_id: assetId } of units) {
    results.push(...await inTransaction(q, async (c) => { await lockAsset(c, assetId); return expireDue(c, { assetId }); }));
  }
  return results;
}

async function markReady(q, id, { actorAccountId, assetId, note }) {
  const id2 = Number(assetId);
  if (!Number.isInteger(id2) || id2 < 1) {
    const r0 = await load(q, id);
    if (r0.status !== 'approved') throw httpError(400, r0.status === 'ready' ? 'This equipment is already ready for the employee.' : TERMINAL.includes(r0.status) ? `This request is already ${LABEL[r0.status].toLowerCase()}.` : 'Approve the request before marking equipment ready.');
    if (track(r0) === null) throw httpError(400, 'Decide the permanent assignment (approve or deny) before marking equipment ready.');
    if (track(r0) === 'permanent') throw httpError(400, 'A permanent assignment was approved: deliver and assign the equipment instead of putting it on hold.');
    throw httpError(400, 'Choose the equipment unit that is ready.');
  }
  return inTransaction(q, async (c) => {
    await lockAsset(c, id2);
    let r = await load(c, id, true);
    if (r.status !== 'approved') throw httpError(400, r.status === 'ready' ? 'This equipment is already ready for the employee.' : TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : 'Approve the request before marking equipment ready.');
    const t = track(r);
    if (t === null) throw httpError(400, 'Decide the permanent assignment (approve or deny) before marking equipment ready.');
    if (t === 'permanent') throw httpError(400, 'A permanent assignment was approved: deliver and assign the equipment instead of putting it on hold.');
    await expireDue(c, { assetId: id2 });
    r = await load(c, r.id);
    const asset = (await c.query('SELECT * FROM assets WHERE id = $1', [id2])).rows[0];
    if (!asset) throw httpError(404, 'Asset not found');
    const emp = (await c.query('SELECT status FROM employees WHERE id = $1', [r.employee_id])).rows[0];
    if (!emp || emp.status !== 'active') throw httpError(400, "That person is inactive, so equipment can't be held for them.");
    if (asset.archived_at) throw httpError(400, "This asset is archived and can't be held.");
    if (asset.status !== 'available') throw httpError(400, `This asset is ${asset.status === 'checked_out' ? 'checked out' : `marked ${asset.status}`}, so it can't be marked ready.`);
    if (assignments.capacity(asset) > 1) throw httpError(400, 'License seats can not be put on a priority hold.');
    if ((await c.query('SELECT 1 FROM assignments WHERE asset_id = $1 AND returned_at IS NULL', [asset.id])).rows.length) throw httpError(400, "This asset is checked out, so it can't be marked ready.");
    const today = await reservations.todayOf(c);
    const busy = (await c.query("SELECT * FROM reservations WHERE asset_id = $1 AND status = 'confirmed' AND start_date <= $2 AND end_date >= $2 ORDER BY start_date, id", [asset.id, today])).rows[0];
    if (busy) throw httpError(409, `This asset is reserved ${when(busy)}, and a priority hold never overrides a reservation. Choose another unit.`);
    if ((await c.query("SELECT id FROM equipment_requests WHERE asset_id = $1 AND status = 'ready' AND id <> $2", [asset.id, r.id])).rows.length) throw httpError(409, 'This asset is already on a priority hold for another request.');
    const moved = await move(c, r, 'ready', {
      actor: actorAccountId, action: 'ready', note,
      set: { asset_id: asset.id, asset_label: `${asset.tag} — ${asset.name}` },
      raw: [`ready_at = ${NOW}`, `hold_expires_at = ${HOLD_EXPIRY}`],
    });
    await activityLog.log(c, asset.id, actorAccountId, 'priority_hold', `Equipment request #${r.id} · ready for the employee, priority hold for ${HOLD_HOURS} hours`, r.employee_id);
    return moved;
  });
}

async function fulfill(q, id, { actorAccountId, assetId, dueDate, dueTime, note, untracked = false }) {
  const given = assetId === undefined || assetId === null || assetId === '' ? null : toId(assetId);
  if (given === null && assetId !== undefined && assetId !== null && assetId !== '') throw httpError(404, 'Asset not found');
  return inTransaction(q, async (c) => {
    let r = await lockRequest(c, id, given);
    if (!['approved', 'ready'].includes(r.status)) throw httpError(400, TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : 'Approve the request before fulfilling it.');
    const t = track(r);
    if (t === null) throw httpError(400, 'Decide the permanent assignment (approve or deny) before fulfilling this request.');
    let asset = null;
    if (r.status === 'ready') {
      if (given !== null && given !== r.asset_id) throw httpError(400, 'The held unit is the one that was marked ready.');
      asset = (await c.query('SELECT * FROM assets WHERE id = $1', [r.asset_id])).rows[0];
    } else if (given !== null) {
      asset = (await c.query('SELECT * FROM assets WHERE id = $1', [given])).rows[0];
      if (!asset) throw httpError(404, 'Asset not found');
    }
    if (t === 'permanent' && !asset && !untracked) throw httpError(400, 'Choose the equipment that was delivered, or record it as not individually tracked.');
    if (t === 'shared' && !untracked && !(dueDate || '').trim()) throw httpError(400, 'Enter a return date to check the equipment out, or record it as handed over.');
    const set = {};
    if (asset && !untracked) {
      const made = await assignments.createAssignment(c, {
        assetId: asset.id, employeeId: r.employee_id, actorAccountId, actorIsAdmin: true,
        type: t === 'permanent' ? 'permanent' : 'checkout', dueDate, dueTime, notes: `Equipment request #${r.id}`,
      });
      const after = await load(c, r.id);
      if (after.status === 'fulfilled') { // the checkout was the claim on the ready unit (claimByCheckout)
        if (note) await event(c, r.id, actorAccountId, 'note', 'fulfilled', 'fulfilled', note);
        return after;
      }
      set.assignment_id = made.assignment.id;
      r = after;
    }
    if (asset) { set.asset_id = asset.id; set.asset_label = `${asset.tag} — ${asset.name}`; }
    return move(c, r, 'fulfilled', { actor: actorAccountId, action: set.assignment_id ? (t === 'permanent' ? 'assigned_permanently' : 'checked_out') : 'fulfilled', note, set });
  });
}

// Inside createAssignment's transaction (it holds the asset lock): the requester taking their ready unit in person is their claim on it.
async function claimByCheckout(c, { assetId, employeeId, actorAccountId, assignmentId }) {
  const r = (await c.query("SELECT * FROM equipment_requests WHERE asset_id = $1 AND employee_id = $2 AND status = 'ready' FOR UPDATE", [assetId, employeeId])).rows[0];
  if (!r) return null;
  return move(c, r, 'fulfilled', { actor: actorAccountId, action: 'checked_out', note: 'Checked out', set: { assignment_id: assignmentId } });
}

// ---- employee (and IT): closing it
async function cancel(q, id, { actorAccountId, employeeId, isAdmin }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    if (!isAdmin && r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (TERMINAL.includes(r.status)) throw httpError(400, `This request is already ${LABEL[r.status].toLowerCase()}.`);
    if (!isAdmin && !EMPLOYEE_CANCELLABLE.includes(r.status)) throw httpError(400, 'This equipment is ready for you. Decline it instead, or ask IT.');
    const moved = await move(c, r, 'cancelled', { actor: actorAccountId, action: isAdmin && r.employee_id !== employeeId ? 'cancelled_by_it' : 'cancelled' });
    if (r.status === 'ready') { await releasedNote(c, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} cancelled`); await requeue(c, r.asset_id); }
    return moved;
  });
}
async function releaseHold(q, id, { actorAccountId, employeeId, isAdmin }) {
  return inTransaction(q, async (c) => {
    const r = await lockRequest(c, id);
    const own = r.employee_id === employeeId;
    if (!isAdmin && !own) throw httpError(403, 'Not allowed');
    if (r.status !== 'ready') throw httpError(400, 'There is no ready equipment to decline on this request.');
    const moved = await move(c, r, 'approved', { actor: actorAccountId, action: own ? 'hold_declined' : 'hold_released', note: own ? 'The employee declined the unit' : 'IT released the hold', set: RELEASED });
    await releasedNote(c, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} · ${own ? 'declined by the employee' : 'released by IT'}`);
    await requeue(c, r.asset_id);
    return moved;
  });
}

module.exports = {
  HOLD_HOURS, STATUSES, LABEL, LIVE, TERMINAL, TRANSITIONS, EMPLOYEE_CANCELLABLE, FIELD_MAX, TEXT_MAX, canTransition, track,
  create, list, get, counts, review, approve, setPermanent, addNote, decline, expireHolds, markReady, fulfill, claimByCheckout, cancel, releaseHold,
};
