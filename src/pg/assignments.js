// Assignment creation on PostgreSQL (D-46, migration Slice 3): the PG counterpart of src/assignments.js. NOT used by the
// running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages (read the
// header of src/assignments.js); every function is async and takes an executor `q` where the SQLite version takes `db`.
//
// Pure helpers (ASSIGNMENT_TYPES, TYPE_LABEL, returnBy, capacity, normalizeType) are imported from src/assignments.js and
// the time-range helpers from src/timeRange.js; neither has database imports, and they move here at cutover. `clean` and
// `validDate` are private there, so they are repeated below.
//
// Capacity. SQLite runs the checks and the INSERT in one BEGIN IMMEDIATE transaction (one writer at a time for the whole
// database). Here createAssignment runs in withTransaction() and takes the per-asset row lock (lockAsset) FIRST, before it
// reads employees, reservations, waitlist holds or assignments (Slice 2 lock-ordering rule). A second createAssignment for
// the SAME asset waits on that lock until the first commits or rolls back, then reads the committed state, so seats can
// never be oversold; assignments on different assets do not wait for each other. idx_assign_active_unique still stops the
// same employee holding the same asset twice.
//
// Transactions. With a pool, createAssignment opens its own transaction (SQLite: db.transaction().immediate()). With a
// client that is already inside withTransaction() (the request-approval flow in server.js runs the assignment and the
// request's completion together), it joins that transaction: same all-or-nothing outcome as better-sqlite3's nested
// transaction, and withTransaction() itself refuses real nesting. In that case the caller must not have read or written
// rows of this asset before calling (the asset lock comes first).
//
// Pool pressure: a createAssignment waiting for a busy asset holds a pool connection while it waits (pool max is 10).
const T = require('../timeRange');
const base = require('../assignments');
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');
const { NOW, TODAY } = require('./time');

const { ASSIGNMENT_TYPES, TYPE_LABEL, returnBy, capacity, normalizeType } = base;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// An id as the integer column accepts it, or null (SQLite simply finds no row for 'abc'; PostgreSQL would raise 22P02).
const INT4_MAX = 2147483647;
const toId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && Math.abs(n) <= INT4_MAX ? n : null; };

// Keeps an available/checked_out asset's status in line with its active assignment count. Inside a transaction, pass its client.
async function refreshStatus(q, assetId) {
  const a = (await q.query('SELECT * FROM assets WHERE id = $1', [toId(assetId)])).rows[0];
  if (!a || !['available', 'checked_out'].includes(a.status)) return;
  const used = (await q.query('SELECT COUNT(*) c FROM assignments WHERE asset_id = $1 AND returned_at IS NULL', [a.id])).rows[0].c;
  const status = used >= capacity(a) ? 'checked_out' : 'available';
  await q.query(`UPDATE assets SET status = $1, updated_at = ${NOW} WHERE id = $2`, [status, a.id]);
}

// Creates the assignment, updates the asset and writes the activity row atomically.
// Returns { assignment, asset, employee }. Throws errors carrying an HTTP `status`.
async function createAssignment(q, { assetId, employeeId, actorAccountId, actorIsAdmin, type, dueDate, dueTime, notes, condition }) {
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
  const assetKey = toId(assetId);
  const employeeKey = toId(employeeId);
  const actor = actorAccountId ?? null;

  const run = async (c) => {
    // The asset row lock comes first: everything below is decided on state no other assignment of this asset can change.
    if (assetKey === null || assetKey < 1) throw httpError(404, 'Asset not found');
    let asset;
    try {
      asset = await lockAsset(c, assetKey);
    } catch (err) {
      if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
      throw err;
    }
    const employee = (await c.query('SELECT * FROM employees WHERE id = $1', [employeeKey])).rows[0];
    if (!employee) throw httpError(400, 'Choose who this is going to');
    if (asset.archived_at) throw httpError(400, 'This asset is archived and can\'t be checked out.');
    if (['retired', 'lost', 'maintenance', 'disposed'].includes(asset.status)) throw httpError(400, `This asset is marked ${asset.status} and can't be checked out.`);
    if (!actorIsAdmin && !asset.available_to_request) throw httpError(404, 'Asset not found'); // not in the employee-facing pool
    // Slice 8.1: time-aware. A checkout is out from now until its return date AND time (a permanent one has no end); it clashes only with a confirmed
    // reservation of someone else that starts before then. Returning at 12:00 on the day another team picks up at 1:00 PM is fine.
    const today = (await c.query(`SELECT ${TODAY} AS d`)).rows[0].d;
    const out = { sk: `${today}T00:00`, ek: due ? T.endKey(due, time) : '9999-12-31T99:99' };
    // NULLS FIRST: SQLite sorts NULL first in ascending order, PostgreSQL last. The first match names the clash in the message.
    const reserved = (await c.query(`SELECT * FROM reservations WHERE asset_id = $1 AND status = 'confirmed' AND employee_id <> $2
      AND end_date >= $3 AND ($4::text IS NULL OR start_date <= $4) ORDER BY start_date, start_time NULLS FIRST, id`, [asset.id, employee.id, today, due])).rows
      .find((r) => T.overlaps(out, T.keysOf(r)));
    if (reserved) {
      const range = reserved.start_time || reserved.end_time ? T.when(reserved) : reserved.start_date === reserved.end_date ? reserved.start_date : `${reserved.start_date} to ${reserved.end_date}`;
      throw httpError(409, `This item is reserved ${range}, so it can't be checked out through then.${actorIsAdmin ? ' Cancel the reservation first, or choose an earlier return date.' : ' Choose an earlier return date, or reserve it for later.'}`);
    }

    // A waitlist HOLD is someone's priority for its exact interval (a merely waiting entry is only demand and never blocks). Another employee may not check the
    // asset out across a held interval; the hold's own employee may, and that physical checkout is their acceptance of the offer, so it closes the hold below.
    // Only the held interval counts: a checkout that is back before the hold starts is not blocked by it.
    const holds = (await c.query(`SELECT * FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' AND hold_expires_at > ${NOW}
      AND ($2::text IS NULL OR start_date <= $2) AND end_date >= $3 ORDER BY start_date, start_time NULLS FIRST, id`, [asset.id, due, today])).rows
      .filter((h) => T.overlaps(out, T.keysOf(h)));
    const others = holds.find((h) => h.employee_id !== employee.id);
    if (others) {
      throw httpError(409, `This item is being held for another employee ${T.when(others)}, so it can't be checked out through then.${actorIsAdmin ? ' Choose a return before the hold starts, or wait for the offer to be answered.' : ' Choose an earlier return date, or reserve it for later.'}`);
    }
    const pendingHold = (await c.query(`SELECT * FROM reservations WHERE asset_id = $1 AND status = 'pending' AND waitlist_entry_id IS NOT NULL AND employee_id <> $2
      AND end_date >= $3 AND ($4::text IS NULL OR start_date <= $4) ORDER BY start_date, id`, [asset.id, employee.id, today, due])).rows // SQLite: idx_reservations_asset order
      .find((r) => T.overlaps(out, T.keysOf(r)));
    if (pendingHold) throw httpError(409, `This item is being held for another employee ${T.when(pendingHold)} (waiting for IT approval), so it can't be checked out through then.`);

    const open = (await c.query(`SELECT s.employee_id, e.name FROM assignments s JOIN employees e ON e.id = s.employee_id
      WHERE s.asset_id = $1 AND s.returned_at IS NULL ORDER BY s.checked_out_at, s.id`, [asset.id])).rows;
    if (open.some((o) => o.employee_id === employee.id)) throw httpError(400, `${employee.name} already has this asset.`);
    if (open.length >= capacity(asset)) {
      // Only IT is told who holds it; anyone else just learns it isn't available.
      throw httpError(400, capacity(asset) > 1 ? 'All license seats are in use.' : actorIsAdmin ? `Already checked out to ${open[0].name}. Check it in first.` : "This item isn't available right now.");
    }

    const assignment = (await c.query(`INSERT INTO assignments (asset_id, employee_id, assignment_type, checked_out_by, due_date, due_time, notes, condition_out)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [asset.id, employee.id, assignmentType, actor, due, time, clean(notes), cond || asset.condition])).rows[0];
    // The hold owner is physically taking the item: that accepts their availability offer, so resolve it now (no email confirmation needed afterwards).
    for (const h of holds) {
      const closed = await c.query(`UPDATE waitlist_entries SET status = 'fulfilled', closed_at = ${NOW}, closed_by = $1, updated_at = ${NOW} WHERE id = $2 AND status = 'held'`, [actor, h.id]);
      if (closed.rowCount) {
        await c.query('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
          [asset.id, actor, employee.id, 'waitlist_checked_out', `${T.when(h)} · checked out in person, so the availability offer is accepted`]);
      }
    }
    if (cond) await c.query('UPDATE assets SET condition = $1 WHERE id = $2', [cond, asset.id]);
    await refreshStatus(c, asset.id);
    await c.query('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
      [asset.id, actor, employee.id, 'checked_out',
        `To ${employee.name} · ${TYPE_LABEL[assignmentType]}${due ? ` · return by ${returnBy(due, time)}` : ''}${clean(notes) ? ` · ${clean(notes)}` : ''}`]);
    return {
      assignment,
      asset: (await c.query('SELECT * FROM assets WHERE id = $1', [asset.id])).rows[0],
      employee,
    };
  };
  return isInTransaction(q) ? run(q) : withTransaction(run, q);
}

module.exports = { ASSIGNMENT_TYPES, TYPE_LABEL, returnBy, capacity, normalizeType, refreshStatus, createAssignment };
