// Asset availability calendar (Phase 2, slice 6): READ-ONLY, derived only from facts the system already stores. There are no
// reservations, bookings or holds in the data model, so nothing here predicts anything beyond what an open assignment says.
//
// One query/model serves every screen: scope = global | catalog node (its whole subtree) | one asset, for one calendar month.
//
// What an asset's day can be (for days from today on; earlier days are 'past' and carry no state):
//   available   a seat is free and nothing says otherwise. With no reservations, a free asset is simply free.
//   occupied    every seat is taken for that day: a PERMANENT assignment (open-ended, no return date), a temporary checkout up to
//               and including its due date, or a checkout whose due date has PASSED (overdue: still out, return date unknown).
//   expected    every seat is taken today but the temporary checkouts holding them are due back before that day. This is the
//               conservative middle state: a due date is a promise, not a booking, so these days are never called "available".
//   repair      status 'maintenance'. No end date is stored, so it is unavailable for every future day.
//   ineligible  status retired / lost / disposed (or archived, shown as 'archived'): not lendable, for every future day.
// Seats: a multi-seat asset (license_seats > 1) is available while ANY seat is free; the day is occupied only when all are taken.
//
// Employees see this anonymously and narrowly: only non-archived assets that are 'available' or 'checked_out' (plus anything they
// hold themselves), no holder, department, notes or assignment type — just occupied/expected date ranges. Asset records stay
// governed by the existing visibility contract (GET /api/assets/:id is unchanged). Admins additionally get each period's holder.
const catalog = require('./catalog');
const { capacity } = require('./assignments');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const MAX_ASSETS = 1000; // same ceiling as the asset list
const NOT_LENDABLE = ['retired', 'lost', 'disposed'];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const addDays = (iso, n) => isoDay(parseDay(iso) + n * 864e5);

// "2026-11" -> { month, first, last, days: ['2026-11-01', …] }. Anything else is a 400.
function monthWindow(month, today) {
  const m = month === undefined || month === '' ? today.slice(0, 7) : month;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || m < '2000-01' || m > '2100-12') throw httpError(400, 'Month must look like 2026-11');
  const first = `${m}-01`;
  const days = [];
  for (let d = first; d.slice(0, 7) === m; d = addDays(d, 1)) days.push(d);
  return { month: m, first, last: days[days.length - 1], days };
}

// One open assignment as the date range it occupies. A temporary checkout is occupied through its due date and then "expected
// back"; a permanent or overdue one has no known end.
function periodsFor(assignment, today) {
  const start = String(assignment.checked_out_at).slice(0, 10);
  const base = { start, assignment_type: assignment.assignment_type };
  if (assignment.assignment_type === 'checkout' && assignment.due_date && assignment.due_date >= today) {
    return [
      { ...base, end: assignment.due_date, kind: 'occupied', open_ended: false, overdue: false, due_time: assignment.due_time || null },
      { start: addDays(assignment.due_date, 1), end: null, kind: 'expected', open_ended: true, overdue: false, assignment_type: assignment.assignment_type },
    ];
  }
  return [{ ...base, end: null, kind: 'occupied', open_ended: true, overdue: assignment.assignment_type === 'checkout', due_time: null }];
}

// The state of one asset on one date (see the table above).
function dayState(asset, openAssignments, date, today) {
  if (date < today) return 'past';
  if (asset.archived_at) return 'archived';
  if (NOT_LENDABLE.includes(asset.status)) return 'ineligible';
  if (asset.status === 'maintenance') return 'repair';
  const seats = capacity(asset);
  if (openAssignments.length < seats) return 'available'; // a seat nobody holds
  const holding = openAssignments.filter((a) => a.assignment_type === 'permanent' || !a.due_date || a.due_date < today || a.due_date >= date).length;
  return holding >= seats ? 'occupied' : 'expected';
}

// Which assets this viewer may see in the calendar, for a scope. Returns { scope, assets[] }.
function resolveScope(db, { isAdmin, employeeId, nodeId, assetId }) {
  if (nodeId !== undefined && assetId !== undefined) throw httpError(400, 'Choose either a catalog entry or an asset, not both');
  const holds = employeeId ? 'EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)' : '0';
  const heldParams = employeeId ? [employeeId] : [];
  // employees: lendable-looking assets only (available or checked out, not archived), plus whatever they hold themselves
  const visible = isAdmin ? '1' : `((a.archived_at IS NULL AND a.status IN ('available','checked_out')) OR ${holds})`;
  const visibleParams = isAdmin ? [] : heldParams;

  if (assetId !== undefined) {
    const id = Number(assetId);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Choose a valid asset');
    const a = db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND ${visible}`).get(id, ...visibleParams);
    if (!a) throw httpError(404, 'Asset not found');
    return { scope: { type: 'asset', id: a.id, title: a.name, path: null }, assets: [a] };
  }

  let scope = { type: 'global', id: null, title: 'All equipment', path: null };
  // node / global scopes never list archived assets (an archived asset can still be asked for directly by an admin, above)
  const where = ['a.archived_at IS NULL', visible];
  const params = [...visibleParams];
  if (nodeId !== undefined) {
    const id = Number(nodeId);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Choose a valid catalog entry');
    if (!catalog.loadIndex(db).nodes.has(id) || (!isAdmin && !catalog.isLive(db, id))) throw httpError(404, 'Catalog entry not found');
    const ids = catalog.subtreeIds(db, id).filter((i) => isAdmin || catalog.isLive(db, i)); // employees: live entries only
    where.push(`a.catalog_node_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    scope = { type: 'node', id, title: catalog.getNode(db, id).name, path: catalog.pathText(db, id) };
  }
  // fetch one extra row to know whether the list was cut off
  const assets = db.prepare(`SELECT a.* FROM assets a WHERE ${where.join(' AND ')} ORDER BY a.name COLLATE NOCASE, a.tag LIMIT ${MAX_ASSETS + 1}`).all(...params);
  if (assets.length > MAX_ASSETS) { assets.length = MAX_ASSETS; scope.truncated = true; }
  return { scope, assets };
}

// The calendar for one scope and month. `viewer` = { isAdmin, employeeId }.
function availability(db, { isAdmin, employeeId = null, nodeId, assetId, month }) {
  const today = db.prepare("SELECT date('now') d").get().d;
  const win = monthWindow(month, today);
  const { scope, assets } = resolveScope(db, { isAdmin, employeeId, nodeId, assetId });

  const open = new Map(assets.map((a) => [a.id, []]));
  if (assets.length) {
    const rows = db.prepare(`SELECT s.*, e.name AS holder_name, e.department AS holder_department FROM assignments s JOIN employees e ON e.id = s.employee_id
      WHERE s.returned_at IS NULL AND s.asset_id IN (${assets.map(() => '?').join(',')}) ORDER BY s.checked_out_at, s.id`).all(...assets.map((a) => a.id));
    for (const r of rows) open.get(r.asset_id).push(r);
  }

  const out = assets.map((a) => {
    const held = open.get(a.id);
    const mine = !!employeeId && held.some((h) => h.employee_id === employeeId);
    const seatsTotal = capacity(a);
    // The tag is shown only where the viewer could already open the asset (an admin always; an employee: available, or theirs).
    const canOpen = isAdmin || mine || (!a.archived_at && a.status === 'available');
    const periods = held.flatMap((h) => periodsFor(h, today).map((p) => {
      const { assignment_type, ...pub } = p;
      return isAdmin
        ? { ...pub, assignment_type, assignment_id: h.id, holder: { id: h.employee_id, name: h.holder_name, department: h.holder_department || null } }
        : { ...pub, mine: h.employee_id === employeeId };
    }));
    return {
      id: a.id, name: a.name, tag: canOpen ? a.tag : null, category: a.category, can_open: canOpen, mine,
      catalog_path: a.catalog_node_id && (isAdmin || catalog.isLive(db, a.catalog_node_id)) ? catalog.pathText(db, a.catalog_node_id) : null,
      status: isAdmin ? a.status : undefined, archived: isAdmin ? !!a.archived_at : undefined,
      state: dayState(a, held, today, today),
      seats: seatsTotal > 1 ? { total: seatsTotal, used: held.length } : undefined,
      days: win.days.map((d) => dayState(a, held, d, today)),
      periods,
    };
  });
  return { scope, today, month: win.month, first: win.first, last: win.last, assets: out };
}

module.exports = { availability, monthWindow, periodsFor, dayState, resolveScope };
