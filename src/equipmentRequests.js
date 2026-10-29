// Employee equipment requests (SQLite; docs/briefs/employee-reservations-requests.md). "I need a piece of equipment": one physical item per request,
// a category from the catalog or "Other", an optional brand / model, optional details, and a "permanent assignment" preference. It is the NEED that
// IT decides on; nothing here creates an asset, a reservation or an assignment by itself, and nothing is purchased.
//
//   submitted -> in_review -> approved -> ready -> fulfilled        declined (IT) and cancelled (the employee, or IT) are terminal
//   approved -> fulfilled   delivery of a permanent assignment (or a handover that needs no inventory item)
//   ready -> approved       the hold ended unclaimed (48 hours), or the employee declined the unit, or IT released it: the need stays approved
//
// The permanent-assignment preference is a SECOND, independent decision (permanent_decision approved | denied, NULL until IT decides). A request that
// asked for a permanent assignment and got it is fulfilled by delivering and assigning the item (assignments.createAssignment, admin only: rule D-15).
// Every other request (permanent denied, or never asked) is SHARED / TEMPORARY equipment: IT marks an eligible unit READY, which notifies the requester and
// starts a 48-hour PRIORITY HOLD on that unit (the row's own asset_id + hold_expires_at; one live hold per unit: idx_eqreq_ready_asset). For those 48 hours
// everyone else is blocked from reserving or checking the unit out (reservations.findBlockers 'priority_hold', assignments.createAssignment); an existing
// reservation or checkout is never overridden (the unit must be free to be marked ready). The hold is not a checkout, an assignment or a reservation:
// the requester reserves it or arranges a checkout under the usual rules. It is fulfilled when they check it out (assignments -> claimByCheckout), or when
// IT records the handover. When the hold ends unclaimed it is released and the waitlist re-evaluated. If the requester reserved that unit (pending or confirmed)
// during the hold, that reservation is their CLAIM: the request stays READY (claimed_reservation_id) and is NOT fulfilled (fulfilled = actually issued), and the
// reservation is protected by the normal rules after the 48 hours. A claim whose reservation is cancelled, declined or over returns the request to approved.
//
// Every status change goes through `move` (compare-and-set on the status) and writes an append-only row to equipment_request_events: that is the audit trail.
const reservations = require('./reservations');
const assignments = require('./assignments');
const activityLog = require('./activityLog');
const T = require('./timeRange');

const { httpError } = reservations;
const HOLD_HOURS = 48;
const STATUSES = ['submitted', 'in_review', 'approved', 'ready', 'fulfilled', 'declined', 'cancelled'];
const LABEL = { submitted: 'Submitted', in_review: 'In review', approved: 'Approved', ready: 'Ready', fulfilled: 'Fulfilled', declined: 'Declined', cancelled: 'Cancelled' };
const LIVE = ['submitted', 'in_review', 'approved', 'ready'];
const TERMINAL = ['fulfilled', 'declined', 'cancelled'];
const TRANSITIONS = {
  submitted: ['in_review', 'approved', 'declined', 'cancelled'],
  in_review: ['approved', 'declined', 'cancelled'],
  approved: ['ready', 'fulfilled', 'declined', 'cancelled'],
  ready: ['fulfilled', 'approved', 'declined', 'cancelled'],
  fulfilled: [], declined: [], cancelled: [],
};
const EMPLOYEE_CANCELLABLE = ['submitted', 'in_review', 'approved']; // before Ready; a Ready unit is declined instead
const canTransition = (from, to) => !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
// Going back to approved (hold ended, declined, released) forgets the unit: the events and the asset's activity keep the history.
const RELEASED = { asset_id: null, asset_label: null, ready_at: null };
const FIELD_MAX = 120; const TEXT_MAX = 1000;
// Where the request stands in the shared / permanent split: 'permanent' (approved: deliver and assign), 'shared' (denied or never asked), or null (asked, undecided).
const track = (r) => (!r.permanent_requested || r.permanent_decision === 'denied' ? 'shared' : r.permanent_decision === 'approved' ? 'permanent' : null);

const load = (db, id) => {
  const r = db.prepare('SELECT * FROM equipment_requests WHERE id = ?').get(Number(id));
  if (!r) throw httpError(404, 'Equipment request not found');
  return r;
};
const event = (db, id, actorAccountId, action, from, to, note) =>
  db.prepare('INSERT INTO equipment_request_events (request_id, actor_id, action, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)').run(id, actorAccountId ?? null, action, from, to, note || null);

// The one status change. `set` = extra columns (code-supplied names), `raw` = extra SQL fragments. Leaving READY always clears the hold; a terminal
// status records who closed it and when.
function move(db, r, to, { actor = null, action, note = null, set = {}, raw = [] }) {
  if (!canTransition(r.status, to)) {
    throw httpError(400, TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : `A ${LABEL[r.status].toLowerCase()} request can't become ${LABEL[to].toLowerCase()}.`);
  }
  const sets = ['status = ?', "updated_at = datetime('now')"]; const params = [to];
  for (const [k, v] of Object.entries(set)) { sets.push(`${k} = ?`); params.push(v); }
  sets.push(...raw);
  if (TERMINAL.includes(to)) { sets.push("closed_at = datetime('now')", 'closed_by = ?'); params.push(actor); }
  if (r.status === 'ready') sets.push('hold_expires_at = NULL', 'claimed_reservation_id = NULL'); // (leaving READY ends the hold and any claim)
  if (!db.prepare(`UPDATE equipment_requests SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...params, r.id, r.status).changes) {
    throw httpError(409, 'This request was just updated by someone else. Reload and try again.');
  }
  event(db, r.id, actor, action, r.status, to, note);
  return load(db, r.id);
}

// The unit's hold ended (or the request was closed): the dates it kept out of reach may now be offered to the waitlist.
const requeue = (db, assetId) => require('./waitlist').evaluateAsset(db, assetId);
const releasedNote = (db, r, actor, action, details) => { if (r.asset_id) activityLog.log(db, r.asset_id, actor, action, details, r.employee_id); };

// ---- employee: submit
// `v`: { employeeId, createdBy, category, categoryOther, nodeId, catalogPath, brand, model, details, permanent } (checked and snapshotted by the route).
function create(db, v) {
  return db.transaction(() => {
    const person = db.prepare('SELECT status FROM employees WHERE id = ?').get(v.employeeId);
    if (!person) throw httpError(404, 'User not found');
    if (person.status !== 'active') throw httpError(400, "That person is inactive, so a request can't be made for them");
    // (no duplicate check: two identical monitors are two requests, one physical item each)
    const id = db.prepare(`INSERT INTO equipment_requests (employee_id, created_by, category, category_other, catalog_node_id, catalog_path, brand, model, details, permanent_requested)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.employeeId, v.createdBy ?? null, v.category, v.categoryOther ? 1 : 0, v.nodeId ?? null, v.catalogPath ?? null, v.brand ?? null, v.model ?? null, v.details ?? null, v.permanent ? 1 : 0).lastInsertRowid;
    event(db, id, v.createdBy, 'submitted', null, 'submitted', v.permanent ? 'Permanent assignment requested' : null);
    return load(db, id);
  }).immediate();
}

// ---- reads
const FLAGS = (r, user) => {
  const own = !!user.employee_id && r.employee_id === user.employee_id; const admin = user.role === 'admin';
  return {
    hold_active: !!r.hold_active, asset_shared: !!r.asset_shared,
    can_cancel: (own && EMPLOYEE_CANCELLABLE.includes(r.status)) || (admin && LIVE.includes(r.status)),
    can_decline_ready: own && r.status === 'ready',
    track: track(r),
  };
};
const SELECT = `SELECT r.*, e.name AS user_name, e.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, a.available_to_request AS asset_shared,
  (r.status = 'ready' AND r.hold_expires_at > datetime('now')) AS hold_active
  FROM equipment_requests r JOIN employees e ON e.id = r.employee_id LEFT JOIN assets a ON a.id = r.asset_id`;
const out = (r, user) => ({ ...r, hold_expires_text: r.hold_expires_at ? T.fmtStamp(r.hold_expires_at) : null, status_label: LABEL[r.status], ...FLAGS(r, user) });

// GET /api/equipment-requests. An employee sees only their own; IT sees all. `status` ('open' | 'closed') was validated by the route.
function list(db, user, { status } = {}) {
  const where = []; const params = [];
  if (user.role !== 'admin') { where.push('r.employee_id = ?'); params.push(user.employee_id); }
  if (status === 'open') where.push(`r.status IN (${LIVE.map((s) => `'${s}'`).join(',')})`);
  else if (status === 'closed') where.push(`r.status IN (${TERMINAL.map((s) => `'${s}'`).join(',')})`);
  return db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('submitted','in_review','approved','ready') THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC LIMIT 500`).all(...params).map((r) => out(r, user));
}
// One request with its audit trail. The owner or IT; anyone else gets a 404.
function get(db, id, user) {
  const r = db.prepare(`${SELECT} WHERE r.id = ?`).get(Number(id));
  if (!r || (user.role !== 'admin' && r.employee_id !== user.employee_id)) throw httpError(404, 'Equipment request not found');
  const events = db.prepare(`SELECT ev.*, COALESCE(u.name, aa.login_email) AS actor_name FROM equipment_request_events ev
    LEFT JOIN accounts aa ON aa.id = ev.actor_id LEFT JOIN employees u ON u.id = aa.employee_id WHERE ev.request_id = ? ORDER BY ev.id`).all(r.id)
    .map((ev) => ({ ...ev, actor_name: ev.actor_name || 'System', from_label: ev.from_status ? LABEL[ev.from_status] : null, to_label: LABEL[ev.to_status] }));
  // the reservation that claimed the unit (shown in the detail so "claimed by reservation" can say which dates)
  const claim = r.claimed_reservation_id ? db.prepare('SELECT id, start_date, start_time, end_date, end_time, status FROM reservations WHERE id = ?').get(r.claimed_reservation_id) : null;
  return { ...out(r, user), events, claim };
}
// The numbers behind the Requests badge: IT = requests waiting on IT (submitted, in review, approved and not yet fulfilled); an employee = equipment ready for them.
function counts(db, user) {
  if (user.role === 'admin') return { attention: db.prepare("SELECT COUNT(*) c FROM equipment_requests WHERE status IN ('submitted','in_review','approved') OR (status = 'ready' AND claimed_reservation_id IS NOT NULL)").get().c };
  return { attention: user.employee_id ? db.prepare("SELECT COUNT(*) c FROM equipment_requests WHERE employee_id = ? AND status = 'ready' AND hold_expires_at > datetime('now')").get(user.employee_id).c : 0 };
}

// ---- IT: decisions
// IT opens a request (the detail view calls this): Submitted -> In review. A later call, or a request already past review, changes nothing.
function review(db, id, { actorAccountId }) {
  return db.transaction(() => {
    const r = load(db, id);
    return r.status === 'submitted' ? move(db, r, 'in_review', { actor: actorAccountId, action: 'opened' }) : r;
  }).immediate();
}

function checkDecision(r, decision) {
  if (decision === undefined || decision === null || decision === '') return null;
  if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'The permanent assignment decision must be approved or denied.');
  if (!r.permanent_requested) throw httpError(400, 'This request did not ask for a permanent assignment.');
  return decision;
}
// Approve the NEED. `permanentDecision` (optional) decides the permanent-assignment preference in the same step; it can also be decided on its own (setPermanent).
function approve(db, id, { actorAccountId, note, permanentDecision, permanentNote }) {
  return db.transaction(() => {
    const r = load(db, id);
    const decision = checkDecision(r, permanentDecision);
    const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(r.employee_id);
    if (!emp || emp.status !== 'active') throw httpError(400, "That person is inactive, so this request can't be approved.");
    const set = { decision_note: note || r.decision_note || null, decided_by: actorAccountId ?? null, decided_at: db.prepare("SELECT datetime('now') n").get().n };
    if (decision) { set.permanent_decision = decision; set.permanent_note = permanentNote || null; }
    const moved = move(db, r, 'approved', { actor: actorAccountId, action: 'approved', note, set });
    if (decision) event(db, r.id, actorAccountId, decision === 'approved' ? 'permanent_approved' : 'permanent_denied', 'approved', 'approved', permanentNote);
    return moved;
  }).immediate();
}
// IT's separate answer to "Request permanent assignment": possible until the request is delivered or closed.
function setPermanent(db, id, { actorAccountId, decision, note }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'Choose approve or deny for the permanent assignment.');
    if (!r.permanent_requested) throw httpError(400, 'This request did not ask for a permanent assignment.');
    if (!['submitted', 'in_review', 'approved'].includes(r.status)) throw httpError(400, r.status === 'ready' ? 'The equipment is already on hold as shared equipment. Release it first.' : `This request is already ${LABEL[r.status].toLowerCase()}.`);
    if (!db.prepare("UPDATE equipment_requests SET permanent_decision = ?, permanent_note = ?, updated_at = datetime('now') WHERE id = ? AND status = ?").run(decision, note || null, r.id, r.status).changes) {
      throw httpError(409, 'This request was just updated by someone else. Reload and try again.');
    }
    event(db, r.id, actorAccountId, decision === 'approved' ? 'permanent_approved' : 'permanent_denied', r.status, r.status, note);
    return load(db, r.id);
  }).immediate();
}
// IT leaves a note without deciding anything: it is recorded in the history and becomes the note the employee sees ("Note from IT"); no status or
// decision changes. (Approving or declining without a note keeps the latest note.)
function addNote(db, id, { actorAccountId, note }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (!note) throw httpError(400, 'Write a note first.');
    if (!LIVE.includes(r.status)) throw httpError(400, `This request is already ${LABEL[r.status].toLowerCase()}.`);
    db.prepare("UPDATE equipment_requests SET decision_note = ?, updated_at = datetime('now') WHERE id = ?").run(note, r.id);
    event(db, r.id, actorAccountId, 'note', r.status, r.status, note);
    return load(db, r.id);
  }).immediate();
}
function decline(db, id, { actorAccountId, note }) {
  return db.transaction(() => {
    const r = load(db, id);
    const moved = move(db, r, 'declined', { actor: actorAccountId, action: 'declined', note, set: { decision_note: note || r.decision_note || null, decided_by: actorAccountId ?? null } });
    if (r.status === 'ready') { releasedNote(db, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} declined`); requeue(db, r.asset_id); }
    return moved;
  }).immediate();
}

// Ends the lapsed holds (of one unit, or of every unit) and settles the CLAIMS (the caller is in a transaction). A hold that lapsed with no claim goes back
// to approved. A reservation the requester made during the hold is their CLAIM: it is recorded (claimed_reservation_id), the request stays READY (it is not
// fulfilled: nothing has been issued) and the reservation is protected by the normal reservation rules from then on. A claim whose reservation was cancelled,
// declined or has ended without the equipment being issued no longer stands: the request goes back to approved. Each result is { request, outcome }:
// 'expired' | 'claimed' | 'claim_ended'.
function expireDue(db, { assetId = null } = {}) {
  const only = assetId ? ' AND asset_id = ?' : ''; const arg = assetId ? [assetId] : [];
  const results = [];
  for (const r of db.prepare(`SELECT * FROM equipment_requests WHERE status = 'ready' AND claimed_reservation_id IS NULL AND hold_expires_at <= datetime('now')${only} ORDER BY id`).all(...arg)) {
    const claim = db.prepare("SELECT id FROM reservations WHERE asset_id = ? AND employee_id = ? AND status IN ('pending','confirmed') AND end_date >= ? AND created_at >= ? ORDER BY id LIMIT 1").get(r.asset_id, r.employee_id, reservations.todayOf(db), r.ready_at);
    if (claim) {
      db.prepare("UPDATE equipment_requests SET claimed_reservation_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'ready'").run(claim.id, r.id);
      event(db, r.id, null, 'hold_claimed', 'ready', 'ready', `Reserved during the hold (reservation #${claim.id}); the reservation keeps the unit`);
      releasedNote(db, r, null, 'priority_hold_claimed', `Equipment request #${r.id} · claimed by reservation #${claim.id}`);
      results.push({ request: load(db, r.id), outcome: 'claimed' });
    } else {
      const moved = move(db, r, 'approved', { actor: null, action: 'hold_expired', note: `The ${HOLD_HOURS}-hour priority hold ended unclaimed`, set: RELEASED });
      releasedNote(db, r, null, 'priority_hold_expired', `Equipment request #${r.id} · hold ended unclaimed`);
      requeue(db, r.asset_id);
      results.push({ request: moved, outcome: 'expired' });
    }
  }
  for (const r of db.prepare(`SELECT e.* FROM equipment_requests e JOIN reservations v ON v.id = e.claimed_reservation_id
    WHERE e.status = 'ready' AND (v.status NOT IN ('pending','confirmed') OR v.end_date < ?)${only ? ' AND e.asset_id = ?' : ''} ORDER BY e.id`).all(reservations.todayOf(db), ...arg)) {
    const moved = move(db, r, 'approved', { actor: null, action: 'claim_ended', note: 'The reservation ended before the equipment was issued', set: RELEASED });
    releasedNote(db, r, null, 'priority_hold_expired', `Equipment request #${r.id} · its reservation ended`);
    requeue(db, r.asset_id);
    results.push({ request: moved, outcome: 'claim_ended' });
  }
  return results;
}
// The 60-second sweep: ends every lapsed hold. Returns what it did so the caller can tell the requesters.
function expireHolds(db) {
  return db.transaction(() => expireDue(db)).immediate();
}

// IT: this unit is ready for the requester. Starts the 48-hour priority hold (notifying the requester is the route's job, after this commits).
function markReady(db, id, { actorAccountId, assetId, note }) {
  return db.transaction(() => {
    let r = load(db, id);
    if (r.status !== 'approved') throw httpError(400, r.status === 'ready' ? 'This equipment is already ready for the employee.' : TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : 'Approve the request before marking equipment ready.');
    const t = track(r);
    if (t === null) throw httpError(400, 'Decide the permanent assignment (approve or deny) before marking equipment ready.');
    if (t === 'permanent') throw httpError(400, 'A permanent assignment was approved: deliver and assign the equipment instead of putting it on hold.');
    const id2 = Number(assetId);
    if (!Number.isInteger(id2) || id2 < 1) throw httpError(400, 'Choose the equipment unit that is ready.');
    expireDue(db, { assetId: id2 });
    r = load(db, r.id);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id2);
    if (!asset) throw httpError(404, 'Asset not found');
    const emp = db.prepare('SELECT status FROM employees WHERE id = ?').get(r.employee_id);
    if (!emp || emp.status !== 'active') throw httpError(400, "That person is inactive, so equipment can't be held for them.");
    if (asset.archived_at) throw httpError(400, "This asset is archived and can't be held.");
    if (asset.status !== 'available') throw httpError(400, `This asset is ${asset.status === 'checked_out' ? 'checked out' : `marked ${asset.status}`}, so it can't be marked ready.`);
    if (assignments.capacity(asset) > 1) throw httpError(400, 'License seats can not be put on a priority hold.');
    if (db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(asset.id)) throw httpError(400, "This asset is checked out, so it can't be marked ready.");
    const today = reservations.todayOf(db);
    const busy = db.prepare("SELECT * FROM reservations WHERE asset_id = ? AND status = 'confirmed' AND start_date <= ? AND end_date >= ? ORDER BY start_date, id").get(asset.id, today, today);
    if (busy) throw httpError(409, `This asset is reserved ${reservations.when(busy)}, and a priority hold never overrides a reservation. Choose another unit.`);
    const other = db.prepare("SELECT id FROM equipment_requests WHERE asset_id = ? AND status = 'ready' AND id <> ?").get(asset.id, r.id);
    if (other) throw httpError(409, 'This asset is already on a priority hold for another request.');
    const label = `${asset.tag} — ${asset.name}`;
    const moved = move(db, r, 'ready', {
      actor: actorAccountId, action: 'ready', note,
      set: { asset_id: asset.id, asset_label: label },
      raw: ["ready_at = datetime('now')", `hold_expires_at = datetime('now', '+${HOLD_HOURS} hours')`],
    });
    activityLog.log(db, asset.id, actorAccountId, 'priority_hold', `Equipment request #${r.id} · ready for the employee, priority hold for ${HOLD_HOURS} hours`, r.employee_id);
    return moved;
  }).immediate();
}

// IT: the equipment has been issued. Permanent (approved) -> delivered and assigned permanently (admin-only rule, via createAssignment). Shared ->
// checked out (a return date) or recorded as handed over. `untracked` records fulfilment with no assignment (an item that is not individually inventoried,
// or one handed over outside the system). The employee checking a ready unit out themselves fulfils it through claimByCheckout instead.
function fulfill(db, id, { actorAccountId, assetId, dueDate, dueTime, note, untracked = false }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (!['approved', 'ready'].includes(r.status)) throw httpError(400, TERMINAL.includes(r.status) ? `This request is already ${LABEL[r.status].toLowerCase()}.` : 'Approve the request before fulfilling it.');
    const t = track(r);
    if (t === null) throw httpError(400, 'Decide the permanent assignment (approve or deny) before fulfilling this request.');
    let asset = null;
    if (r.status === 'ready') {
      if (assetId !== undefined && assetId !== null && assetId !== '' && Number(assetId) !== r.asset_id) throw httpError(400, 'The held unit is the one that was marked ready.');
      asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(r.asset_id);
    } else if (assetId !== undefined && assetId !== null && assetId !== '') {
      asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(assetId));
      if (!asset) throw httpError(404, 'Asset not found');
    }
    if (t === 'permanent' && !asset && !untracked) throw httpError(400, 'Choose the equipment that was delivered, or record it as not individually tracked.');
    if (t === 'shared' && !untracked && !(dueDate || '').trim()) throw httpError(400, 'Enter a return date to check the equipment out, or record it as handed over.');
    const set = {};
    if (asset && !untracked) {
      const made = assignments.createAssignment(db, {
        assetId: asset.id, employeeId: r.employee_id, actorAccountId, actorIsAdmin: true,
        type: t === 'permanent' ? 'permanent' : 'checkout', dueDate, dueTime, notes: `Equipment request #${r.id}`,
      });
      const after = load(db, r.id);
      if (after.status === 'fulfilled') { // the checkout was the claim on the ready unit (claimByCheckout)
        if (note) event(db, r.id, actorAccountId, 'note', 'fulfilled', 'fulfilled', note);
        return after;
      }
      set.assignment_id = made.assignment.id;
    }
    if (asset) { set.asset_id = asset.id; set.asset_label = `${asset.tag} — ${asset.name}`; }
    return move(db, r, 'fulfilled', { actor: actorAccountId, action: set.assignment_id ? (t === 'permanent' ? 'assigned_permanently' : 'checked_out') : 'fulfilled', note, set });
  }).immediate();
}

// Inside createAssignment's transaction: the requester taking their ready unit in person is their claim on it.
function claimByCheckout(db, { assetId, employeeId, actorAccountId, assignmentId }) {
  const r = db.prepare("SELECT * FROM equipment_requests WHERE asset_id = ? AND employee_id = ? AND status = 'ready'").get(assetId, employeeId);
  if (!r) return null;
  return move(db, r, 'fulfilled', { actor: actorAccountId, action: 'checked_out', note: 'Checked out', set: { assignment_id: assignmentId } });
}

// ---- employee (and IT): closing it
// The employee cancels their own request until it is Ready (a Ready unit is declined instead); IT may cancel any live request.
function cancel(db, id, { actorAccountId, employeeId, isAdmin }) {
  return db.transaction(() => {
    const r = load(db, id);
    if (!isAdmin && r.employee_id !== employeeId) throw httpError(403, 'Not allowed');
    if (TERMINAL.includes(r.status)) throw httpError(400, `This request is already ${LABEL[r.status].toLowerCase()}.`);
    if (!isAdmin && !EMPLOYEE_CANCELLABLE.includes(r.status)) throw httpError(400, 'This equipment is ready for you. Decline it instead, or ask IT.');
    const moved = move(db, r, 'cancelled', { actor: actorAccountId, action: isAdmin && r.employee_id !== employeeId ? 'cancelled_by_it' : 'cancelled' });
    if (r.status === 'ready') { releasedNote(db, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} cancelled`); requeue(db, r.asset_id); }
    return moved;
  }).immediate();
}
// The employee declines the ready unit (or IT releases it): the hold ends, the unit goes back to everyone, the need stays approved.
function releaseHold(db, id, { actorAccountId, employeeId, isAdmin }) {
  return db.transaction(() => {
    const r = load(db, id);
    const own = r.employee_id === employeeId;
    if (!isAdmin && !own) throw httpError(403, 'Not allowed');
    if (r.status !== 'ready') throw httpError(400, 'There is no ready equipment to decline on this request.');
    const moved = move(db, r, 'approved', { actor: actorAccountId, action: own ? 'hold_declined' : 'hold_released', note: own ? 'The employee declined the unit' : 'IT released the hold', set: RELEASED });
    releasedNote(db, r, actorAccountId, 'priority_hold_released', `Equipment request #${r.id} · ${own ? 'declined by the employee' : 'released by IT'}`);
    requeue(db, r.asset_id);
    return moved;
  }).immediate();
}

module.exports = {
  HOLD_HOURS, STATUSES, LABEL, LIVE, TERMINAL, TRANSITIONS, EMPLOYEE_CANCELLABLE, FIELD_MAX, TEXT_MAX, canTransition, track,
  create, list, get, counts, review, approve, setPermanent, addNote, decline, expireHolds, markReady, fulfill, claimByCheckout, cancel, releaseHold,
};
