// Asset availability calendar (Phase 2, slice 6): READ-ONLY, derived only from facts the system already stores. There are no
// reservations, bookings or holds in the data model, so nothing here predicts anything beyond what an open assignment says.
//
// One query/model serves every screen: scope = global | catalog node (its whole subtree) | one asset, for one calendar month.
//
// What each scope RETURNS follows its breadth (the broader the scope, the more summarized; the specific the scope, the more detail):
//   asset    view 'asset': that one asset in full (state per day, periods, holder for admins). The future home of reservation controls.
//   node /   view 'summary': per-day COUNTS. Admins also get `events`: the open TEMPORARY checkouts
//   global   (assignment_type 'checkout') that overlap the month, because those are the scheduling-relevant facts. Available assets
//            are never listed.
//            An EMPLOYEE's catalog-entry calendar (not global, which they can't ask for) also gets `assets`: the actual assets in that entry's
//            subtree with their day states, so "I need any camera" can see which cameras are free, reserved or out on a day and pick one
//            (reserving itself stays on the single-asset calendar). Capped at MAX_LIST rows; the counts always cover everything.
//   PERMANENT ASSIGNMENTS DO NOT EXIST IN THE BROAD CALENDARS. They are for shared / temporary-use equipment, so the asset pool is the
//   SCHEDULABLE pool: every in-scope asset that has no open permanent assignment (for admins and employees alike). A permanently assigned asset is not counted in the
//   total, the day states, the counts or the lists (it is inventory state, not a scheduling fact). Returning it puts it back in the pool.
//   (A single-asset calendar is unchanged: asked for directly, an admin still sees that one asset in full. Employees are unchanged too.)
//   Employees may not ask for the global scope at all (a company-wide calendar is not useful to them): they narrow to a catalog entry first.
//
// What an asset's day can be (for days from today on; earlier days are 'past' and carry no state):
//   available   a seat is free and nothing says otherwise. With no reservations, a free asset is simply free.
//   occupied    every seat is taken for that day: a PERMANENT assignment (open-ended, no return date), a temporary checkout up to
//               and including its due date, or a checkout whose due date has PASSED (overdue: still out, return date unknown).
//   expected    every seat is taken today but the temporary checkouts holding them are due back before that day. This is the
//               conservative middle state: a due date is a promise, not a booking, so these days are never called "available".
//   reserved    a CONFIRMED reservation covers the day (src/reservations.js) and nothing physically occupies the asset that day. It wins over
//               available / expected; an occupying assignment (permanent, checked out through its due date, overdue) wins over it.
//               Pending (waiting-for-approval) reservations never change a day. Reservations exist for single-seat assets only.
//   repair      status 'maintenance'. No end date is stored, so it is unavailable for every future day.
//   ineligible  status retired / lost / disposed (or archived, shown as 'archived'): not lendable, for every future day.
// Seats: a multi-seat asset (license_seats > 1) is available while ANY seat is free; the day is occupied only when all are taken.
//
// Employees see this anonymously and narrowly: only non-archived assets that IT made `available_to_request` and that are 'available' or
// 'checked_out', no holder, department, notes or assignment type — just occupied/expected/reserved date ranges. What an employee HOLDS is
// theirs regardless of that flag, but only for the single-asset calendar of that item: catalog/everything calendars never count an asset that
// is not `available_to_request`, so hidden equipment can't show up in their totals. Asset records stay
// governed by the existing visibility contract (GET /api/assets/:id is unchanged). Admins additionally get each period's holder.
const catalog = require('./catalog');
const { capacity } = require('./assignments');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const MAX_ASSETS = 1000; // same ceiling as the asset list
const MAX_EVENTS = 200; // open temporary checkouts returned to an admin's broad calendar
const MAX_LIST = 300; // asset rows returned to an employee's catalog-entry calendar
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
function dayState(asset, openAssignments, date, today, reservations = []) {
  if (date < today) return 'past';
  if (asset.archived_at) return 'archived';
  if (NOT_LENDABLE.includes(asset.status)) return 'ineligible';
  if (asset.status === 'maintenance') return 'repair';
  const seats = capacity(asset);
  const reserved = reservations.some((r) => r.start_date <= date && date <= r.end_date); // confirmed ones only (the caller passes just those)
  if (openAssignments.length < seats) return reserved ? 'reserved' : 'available'; // a seat nobody holds
  const holding = openAssignments.filter((a) => a.assignment_type === 'permanent' || !a.due_date || a.due_date < today || a.due_date >= date).length;
  return holding >= seats ? 'occupied' : reserved ? 'reserved' : 'expected';
}

// Can this asset take reservations at all? { ok } or { ok: false, reason, hidden } (hidden = an employee must not even learn it exists).
// Used by the reservation rules (src/reservations.js) and to tell the single-asset calendar whether to offer "Reserve".
function reserveEligibility(asset) {
  if (!asset || !asset.available_to_request) return { ok: false, reason: 'Asset not found', hidden: true };
  if (asset.archived_at) return { ok: false, reason: 'This item is archived and can\'t be reserved.' };
  if (['maintenance', ...NOT_LENDABLE].includes(asset.status)) return { ok: false, reason: 'This item is in repair or no longer lendable, so it can\'t be reserved.' };
  if (capacity(asset) > 1) return { ok: false, reason: 'Reservations are for single physical items, not multi-seat licenses.' };
  return { ok: true };
}

// Which assets this viewer may see in the calendar, for a scope. Returns { scope, assets[] }.
function resolveScope(db, { isAdmin, employeeId, nodeId, assetId }) {
  if (nodeId !== undefined && assetId !== undefined) throw httpError(400, 'Choose either a catalog entry or an asset, not both');
  const holds = employeeId ? 'EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)' : '0';
  const heldParams = employeeId ? [employeeId] : [];
  // employees: the shared pool only (IT made it available_to_request; lendable-looking: available or checked out, not archived). One
  // asset asked for directly may also be something they HOLD, whatever its flag. Catalog / everything scopes never take that exception.
  const pool = "(a.archived_at IS NULL AND a.available_to_request = 1 AND a.status IN ('available','checked_out'))";
  const visible = isAdmin ? '1' : `(${pool} OR ${holds})`;
  const visibleParams = isAdmin ? [] : heldParams;
  const visibleBroad = isAdmin ? '1' : pool;

  if (assetId !== undefined) {
    const id = Number(assetId);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Choose a valid asset');
    const a = db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND ${visible}`).get(id, ...visibleParams);
    if (!a) throw httpError(404, 'Asset not found');
    return { scope: { type: 'asset', id: a.id, title: a.name, path: null }, assets: [a] };
  }

  let scope = { type: 'global', id: null, title: 'All equipment', path: null };
  // node / global scopes never list archived assets (an archived asset can still be asked for directly by an admin, above)
  const where = ['a.archived_at IS NULL', visibleBroad];
  const params = [];
  // broad scopes, for everyone: the schedulable pool only (see the header) — nothing with an open permanent assignment
  where.push("NOT EXISTS (SELECT 1 FROM assignments p WHERE p.asset_id = a.id AND p.returned_at IS NULL AND p.assignment_type = 'permanent')");
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

// One asset's full calendar row (asset scope only).
function assetRow(db, a, held, resv, { isAdmin, employeeId, today, win, canReserve }) {
  const mine = !!employeeId && held.some((h) => h.employee_id === employeeId);
  const seatsTotal = capacity(a);
  const confirmed = resv.filter((r) => r.status === 'confirmed');
  // The tag is shown only where the viewer could already open the asset (an admin always; an employee: available + shared, or theirs).
  const canOpen = isAdmin || mine || (!a.archived_at && a.status === 'available' && !!a.available_to_request);
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
    state: dayState(a, held, today, today, confirmed),
    seats: seatsTotal > 1 ? { total: seatsTotal, used: held.length } : undefined,
    days: win.days.map((d) => dayState(a, held, d, today, confirmed)),
    periods,
    // Reservations on this asset. Everyone sees the confirmed date ranges (employees anonymously: only whether one is theirs); a pending
    // one is shown to IT and to its owner only. `id` is given only where the viewer may act on it.
    reservations: resv.filter((r) => isAdmin || r.status === 'confirmed' || r.employee_id === employeeId).map((r) => {
      const own = !!employeeId && r.employee_id === employeeId;
      const base = { start: r.start_date, end: r.end_date, status: r.status, mine: own };
      if (isAdmin) return { ...base, id: r.id, requires_approval: !!r.requires_approval, holder: { id: r.employee_id, name: r.holder_name, department: r.holder_department || null } };
      return own ? { ...base, id: r.id } : base;
    }),
    // Whether THIS viewer is offered "Reserve" here (the server re-checks everything when they submit).
    reserve: { allowed: !!canReserve && reserveEligibility(a).ok, requires_approval: !!a.reservation_requires_approval },
  };
}

// Per-day counts for a broad scope.
//  `reserved` = assets a CONFIRMED reservation holds that day (counts only; broad calendars never list reservations).
//  Employees: available / expected / unavailable (every seat taken) / reserved / off. They never learn why something is unavailable, and never that
//  anything is in repair: the only such asset they can see is one they hold, which simply counts as unavailable.
//  Admins (schedulable pool only): available / expected / reserved / off (repair, retired, lost, disposed) count assets; checked_out counts the open
//  TEMPORARY assignments out on that day — exactly the assignments in `events`. There is no combined unavailable figure and no permanent figure.
function summaryDays(assets, openBy, resvBy, { isAdmin, today, win, events }) {
  return win.days.map((d) => {
    if (d < today) return isAdmin ? { available: 0, expected: 0, checked_out: 0, reserved: 0, off: 0 } : { available: 0, expected: 0, unavailable: 0, reserved: 0, off: 0 };
    const c = { available: 0, expected: 0, unavailable: 0, reserved: 0, off: 0 };
    for (const a of assets) {
      const s = dayState(a, openBy.get(a.id), d, today, resvBy.get(a.id));
      if (s === 'available') c.available++;
      else if (s === 'expected') c.expected++;
      else if (s === 'reserved') c.reserved++;
      else if (s === 'occupied') c.unavailable++;
      else if (isAdmin) c.off++;
      else c.unavailable++;
    }
    if (!isAdmin) return c;
    return { available: c.available, expected: c.expected, checked_out: events.filter((e) => eventOn(e, d)).length, reserved: c.reserved, off: c.off };
  });
}

// Is this open temporary checkout out on that day? (the one rule behind both the Checked out count and the day's list)
const eventOn = (e, day) => e.start <= day && (e.overdue || day <= e.end);

// Admin only: ALL open TEMPORARY checkouts that touch the month, soonest return first (overdue first). Only `assignment_type = 'checkout'`
// (the schema keeps it exact: a checkout always has a due date, a permanent one never does) of assets in the schedulable pool.
function allCheckouts(assets, openBy, { today, win }) {
  const out = [];
  for (const a of assets) {
    for (const h of openBy.get(a.id)) {
      if (h.assignment_type !== 'checkout') continue;
      const start = String(h.checked_out_at).slice(0, 10);
      const overdue = h.due_date < today;
      if (start > win.last || (!overdue && h.due_date < win.first)) continue; // nothing of it falls in this month
      out.push({
        assignment_id: h.id, asset_id: a.id, name: a.name, tag: a.tag,
        holder: { id: h.employee_id, name: h.holder_name, department: h.holder_department || null },
        start, end: overdue ? null : h.due_date, due_time: overdue ? null : h.due_time || null, overdue,
      });
    }
  }
  out.sort((x, y) => (x.overdue === y.overdue ? String(x.end).localeCompare(String(y.end)) || x.name.localeCompare(y.name) : x.overdue ? -1 : 1));
  return out;
}
// The list sent to the client is capped; the counts above are computed from the full list.
function checkoutEvents(assets, openBy, ctx) {
  const out = allCheckouts(assets, openBy, ctx);
  const truncated = out.length > MAX_EVENTS;
  if (truncated) out.length = MAX_EVENTS;
  return { events: out, events_truncated: truncated };
}

// The calendar for one scope and month. `viewer` = { isAdmin, employeeId }.
function availability(db, { isAdmin, employeeId = null, nodeId, assetId, month, canReserve = false }) {
  const today = db.prepare("SELECT date('now') d").get().d;
  const win = monthWindow(month, today);
  if (!isAdmin && nodeId === undefined && assetId === undefined) throw httpError(400, 'Choose a category or an item first. The calendar for all equipment is for IT.');
  const { scope, assets } = resolveScope(db, { isAdmin, employeeId, nodeId, assetId });

  const open = new Map(assets.map((a) => [a.id, []]));
  if (assets.length) {
    const rows = db.prepare(`SELECT s.*, e.name AS holder_name, e.department AS holder_department FROM assignments s JOIN employees e ON e.id = s.employee_id
      WHERE s.returned_at IS NULL AND s.asset_id IN (${assets.map(() => '?').join(',')}) ORDER BY s.checked_out_at, s.id`).all(...assets.map((a) => a.id));
    for (const r of rows) open.get(r.asset_id).push(r);
  }
  // live reservations that have not ended (pending ones only ever matter on the single-asset view)
  const resv = new Map(assets.map((a) => [a.id, []]));
  if (assets.length) {
    const rows = db.prepare(`SELECT r.*, e.name AS holder_name, e.department AS holder_department FROM reservations r JOIN employees e ON e.id = r.employee_id
      WHERE r.status IN ('pending','confirmed') AND r.end_date >= ? AND r.asset_id IN (${assets.map(() => '?').join(',')}) ORDER BY r.start_date, r.id`).all(today, ...assets.map((a) => a.id));
    for (const r of rows) resv.get(r.asset_id).push(r);
  }
  const head = { scope, today, month: win.month, first: win.first, last: win.last };

  if (scope.type === 'asset') {
    return { ...head, view: 'asset', assets: assets.map((a) => assetRow(db, a, open.get(a.id), resv.get(a.id), { isAdmin, employeeId, today, win, canReserve })) };
  }
  const confirmedBy = new Map([...resv].map(([id, list]) => [id, list.filter((r) => r.status === 'confirmed')]));
  const events = isAdmin ? allCheckouts(assets, open, { today, win }) : [];
  // an employee looking at a catalog entry: the actual assets too (anonymous rows, same shape as the single-asset view)
  const listed = !isAdmin && scope.type === 'node' ? assets.slice(0, MAX_LIST) : null;
  return {
    ...head, view: 'summary', total: assets.length,
    days: summaryDays(assets, open, confirmedBy, { isAdmin, today, win, events }),
    ...(isAdmin ? { events: events.slice(0, MAX_EVENTS), events_truncated: events.length > MAX_EVENTS } : {}),
    ...(listed ? { assets: listed.map((a) => assetRow(db, a, open.get(a.id), resv.get(a.id), { isAdmin, employeeId, today, win, canReserve: false })), assets_truncated: assets.length > MAX_LIST } : {}),
  };
}

module.exports = { availability, monthWindow, periodsFor, dayState, resolveScope, checkoutEvents, reserveEligibility };
