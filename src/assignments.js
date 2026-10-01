// Assignment creation with capacity enforced transactionally.
//
// An assignment is one employee holding one asset. `assignment_type` belongs to the ASSIGNMENT (never the asset or
// its category): 'permanent' = ongoing equipment (ADMIN ONLY; no due date/time), 'checkout' = temporary custody that
// REQUIRES a return date (due_date) and may carry a return time (due_time, HH:MM). Enforced here, on the server.
//
// Capacity: physical assets hold 1 (license_seats is NULL/≤1); multi-seat assets/licenses use license_seats. The
// count check and the INSERT run inside one BEGIN IMMEDIATE transaction, so two writers (even in separate
// processes) can't both pass the check. The partial unique index idx_assign_active_unique additionally stops the
// same employee holding the same asset twice; it is deliberately NOT a per-asset unique, which would break seats.
const ASSIGNMENT_TYPES = ['permanent', 'checkout'];
const TYPE_LABEL = { permanent: 'Permanent', checkout: 'Temporary checkout' };

// "2026-11-20" or "2026-11-20 14:30" — how a return date/time reads in activity text.
const returnBy = (date, time) => (time ? `${date} ${time}` : date);
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const capacity = (asset) => Math.max(1, Number(asset.license_seats) || 1);

function normalizeType(value) {
  if (value === undefined || value === null || value === '') return 'permanent';
  if (!ASSIGNMENT_TYPES.includes(value)) throw httpError(400, 'Assignment type must be permanent or checkout');
  return value;
}

// Keeps an available/checked_out asset's status in line with its active assignment count.
function refreshStatus(db, assetId) {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!a || !['available', 'checked_out'].includes(a.status)) return;
  const used = db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(assetId).c;
  const status = used >= capacity(a) ? 'checked_out' : 'available';
  db.prepare("UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, assetId);
}

// Creates the assignment, updates the asset and writes the activity row atomically.
// Returns { assignment, asset, employee }. Throws errors carrying an HTTP `status`.
function createAssignment(db, { assetId, employeeId, actorAccountId, actorIsAdmin, type, dueDate, dueTime, notes, condition }) {
  const assignmentType = normalizeType(type);
  if (assignmentType === 'permanent' && !actorIsAdmin) throw httpError(403, 'Permanent assignments need IT approval. Send IT a request instead.');
  let due = null; let time = null; // permanent: any submitted due date/time is dropped
  if (assignmentType === 'checkout') {
    due = clean(dueDate);
    if (!due) throw httpError(400, 'A temporary checkout needs a return date.');
    if (!validDate(due)) throw httpError(400, 'Return date must be a valid date.');
    time = clean(dueTime);
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw httpError(400, 'Return time must be a valid time (HH:MM).');
  }
  const cond = clean(condition);

  return db.transaction(() => {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset) throw httpError(404, 'Asset not found');
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) throw httpError(400, 'Choose who this is going to');
    if (asset.archived_at) throw httpError(400, 'This asset is archived and can\'t be checked out.');
    if (['retired', 'lost', 'maintenance', 'disposed'].includes(asset.status)) throw httpError(400, `This asset is marked ${asset.status} and can't be checked out.`);

    const open = db.prepare(`SELECT s.employee_id, e.name FROM assignments s JOIN employees e ON e.id = s.employee_id
      WHERE s.asset_id = ? AND s.returned_at IS NULL ORDER BY s.checked_out_at`).all(assetId);
    if (open.some((o) => o.employee_id === employeeId)) throw httpError(400, `${employee.name} already has this asset.`);
    if (open.length >= capacity(asset)) {
      // Only IT is told who holds it; anyone else just learns it isn't available.
      throw httpError(400, capacity(asset) > 1 ? 'All license seats are in use.' : actorIsAdmin ? `Already checked out to ${open[0].name}. Check it in first.` : "This item isn't available right now.");
    }

    const info = db.prepare(`INSERT INTO assignments (asset_id, employee_id, assignment_type, checked_out_by, due_date, due_time, notes, condition_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(assetId, employeeId, assignmentType, actorAccountId, due, time, clean(notes), cond || asset.condition);
    if (cond) db.prepare('UPDATE assets SET condition = ? WHERE id = ?').run(cond, assetId);
    refreshStatus(db, assetId);
    db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)')
      .run(assetId, actorAccountId, employeeId, 'checked_out',
        `To ${employee.name} · ${TYPE_LABEL[assignmentType]}${due ? ` · return by ${returnBy(due, time)}` : ''}${clean(notes) ? ` · ${clean(notes)}` : ''}`);
    return {
      assignment: db.prepare('SELECT * FROM assignments WHERE id = ?').get(info.lastInsertRowid),
      asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId),
      employee,
    };
  }).immediate();
}

module.exports = { ASSIGNMENT_TYPES, TYPE_LABEL, returnBy, capacity, normalizeType, refreshStatus, createAssignment };
