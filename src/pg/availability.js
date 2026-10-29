// Asset availability calendar on PostgreSQL (D-46, migration Slice 4A): the PG counterpart of src/availability.js. NOT used
// by the running app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages as
// src/availability.js (read its header for the rules); every function is async and takes an executor `q` (a pg Pool or a
// transaction client from withTransaction) where the SQLite version takes `db`.
//
// Pure helpers (monthWindow, periodsFor, dayState, reserveEligibility, checkoutEvents) are imported from src/availability.js,
// `capacity` from src/assignments.js and the time-range helpers from src/timeRange.js; none of them touches a database at
// load time, and they move here at cutover. summaryDays, eventOn, allCheckouts and the assetRow shaping are private there,
// so they are repeated below (the differential tests in test/pg/pg-availability.test.js hold them to the SQLite output).
//
// SQL differences from SQLite (each one keeps the output identical):
//   - `ORDER BY a.name COLLATE NOCASE, a.tag` -> `ORDER BY lower(a.name), lower(a.tag)`. assets.tag is a NOCASE column in
//     SQLite, so its plain ORDER BY is case-insensitive too. Under the baseline "C" collation lower() folds ASCII only and
//     orders the rest by byte, exactly like NOCASE.
//   - `IN (?, ?, …)` -> `= ANY($n::int[])`.
//   - waitlist rows `ORDER BY w.queue_seq` -> `w.queue_seq, w.status, w.id`: split pieces share a queue_seq, and SQLite returns
//     such ties in idx_waitlist_queue order (asset_id, status, …), i.e. 'held' before 'waiting', then rowid. Made explicit.
//   - `lapsed` is computed as 0/1 (CASE), never a PostgreSQL boolean, so it reads exactly like SQLite's comparison result.
//   - An asset id beyond the integer column's range is "Asset not found" (SQLite finds no row) instead of a PG 22003.
//
// Catalog: the tree is loaded once per call (src/pg/catalog loadIndex; cached for a pool, read fresh by a transaction client)
// and every path / liveness / subtree is resolved synchronously from that one index (catalog.inIndex).
//
// Consistency: availability() and todayStates() run several SELECTs on `q` in READ COMMITTED, so they are not one snapshot the
// way a SQLite read was. That is acceptable: the calendar is advisory, and every write (Slices 4B/4C) re-checks under the asset
// lock. No transaction is opened here; called with a transaction client, every statement runs on that client.
const base = require('../availability');
const T = require('../timeRange');
const { capacity } = require('../assignments');
const catalog = require('./catalog');
const time = require('./time');

const { monthWindow, periodsFor, dayState, reserveEligibility, checkoutEvents } = base;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const MAX_ASSETS = 1000;
const MAX_EVENTS = 200;
const MAX_LIST = 300;
const INT4_MAX = 2147483647;
const { NOW } = time;
const PRIORITY_END = '2100-12-31'; // a priority hold (ready equipment request) blocks every day, for everyone but its requester
const { inIndex } = catalog;

// Which assets this viewer may see in the calendar, for a scope. Returns { scope, assets[] }. `index` = an already loaded
// catalog index (internal callers pass theirs so the tree is read once per call).
async function resolveScope(q, { isAdmin, employeeId, nodeId, assetId }, index = null) {
  if (nodeId !== undefined && assetId !== undefined) throw httpError(400, 'Choose either a catalog entry or an asset, not both');
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const holds = (ph) => (employeeId ? `EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ${ph()} AND s.returned_at IS NULL)` : 'FALSE');
  const pool = "(a.archived_at IS NULL AND a.available_to_request = 1 AND a.status IN ('available','checked_out'))";

  if (assetId !== undefined) {
    const id = Number(assetId);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Choose a valid asset');
    if (id > INT4_MAX) throw httpError(404, 'Asset not found');
    const idParam = p(id);
    const visible = isAdmin ? 'TRUE' : `(${pool} OR ${holds(() => p(employeeId))})`;
    const a = (await q.query(`SELECT a.* FROM assets a WHERE a.id = ${idParam} AND ${visible}`, params)).rows[0];
    if (!a) throw httpError(404, 'Asset not found');
    return { scope: { type: 'asset', id: a.id, title: a.name, path: null }, assets: [a] };
  }

  let scope = { type: 'global', id: null, title: 'All equipment', path: null };
  const where = ['a.archived_at IS NULL', isAdmin ? 'TRUE' : pool];
  where.push("NOT EXISTS (SELECT 1 FROM assignments p WHERE p.asset_id = a.id AND p.returned_at IS NULL AND p.assignment_type = 'permanent')");
  if (nodeId !== undefined) {
    const id = Number(nodeId);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Choose a valid catalog entry');
    const idx = index || await catalog.loadIndex(q);
    if (!idx.nodes.has(id) || (!isAdmin && !inIndex.isLive(idx, id))) throw httpError(404, 'Catalog entry not found');
    const ids = inIndex.subtreeIds(idx, id).filter((i) => isAdmin || inIndex.isLive(idx, i));
    where.push(`a.catalog_node_id = ANY(${p(ids)}::int[])`);
    scope = { type: 'node', id, title: inIndex.getNode(idx, id).name, path: inIndex.pathText(idx, id) };
  }
  const assets = (await q.query(`SELECT a.* FROM assets a WHERE ${where.join(' AND ')} ORDER BY lower(a.name), lower(a.tag) LIMIT ${MAX_ASSETS + 1}`, params)).rows;
  if (assets.length > MAX_ASSETS) { assets.length = MAX_ASSETS; scope.truncated = true; }
  return { scope, assets };
}

// One asset's full calendar row (asset scope, and an employee's catalog-entry list). Synchronous over the loaded catalog index.
function assetRow(index, a, held, resv, wl, { isAdmin, employeeId, today, win, canReserve, prio = null }) {
  const mine = !!employeeId && held.some((h) => h.employee_id === employeeId);
  const seatsTotal = capacity(a);
  const holds = wl.filter((w) => w.status === 'held' && !w.lapsed);
  const confirmed = [...resv.filter((r) => r.status === 'confirmed'), ...holds, ...(prio ? [{ start_date: today, end_date: PRIORITY_END, start_time: null, end_time: null }] : [])];
  const canOpen = isAdmin || mine || (!a.archived_at && a.status === 'available' && !!a.available_to_request);
  const periods = held.flatMap((h) => periodsFor(h, today).map((pd) => {
    const { assignment_type, ...pub } = pd;
    return isAdmin
      ? { ...pub, assignment_type, assignment_id: h.id, holder: { id: h.employee_id, name: h.holder_name, department: h.holder_department || null } }
      : { ...pub, mine: h.employee_id === employeeId };
  }));
  return {
    priority_hold: prio ? { until: prio.hold_expires_at, until_text: T.fmtStamp(prio.hold_expires_at) } : null,
    id: a.id, name: a.name, tag: canOpen ? a.tag : null, category: a.category, can_open: canOpen, mine,
    catalog_path: a.catalog_node_id && (isAdmin || inIndex.isLive(index, a.catalog_node_id)) ? inIndex.pathText(index, a.catalog_node_id) : null,
    status: isAdmin ? a.status : undefined, archived: isAdmin ? !!a.archived_at : undefined,
    state: dayState(a, held, today, today, confirmed),
    seats: seatsTotal > 1 ? { total: seatsTotal, used: held.length } : undefined,
    days: win.days.map((d) => dayState(a, held, d, today, confirmed)),
    periods,
    reservations: resv.filter((r) => isAdmin || r.status === 'confirmed' || r.employee_id === employeeId).map((r) => {
      const own = !!employeeId && r.employee_id === employeeId;
      const b = { start: r.start_date, start_time: r.start_time || null, end: r.end_date, end_time: r.end_time || null, status: r.status, mine: own };
      if (isAdmin) return { ...b, id: r.id, requires_approval: !!r.requires_approval, holder: { id: r.employee_id, name: r.holder_name, department: r.holder_department || null } };
      return own ? { ...b, id: r.id } : b;
    }),
    holds: holds.map((w) => {
      const own = !!employeeId && w.employee_id === employeeId;
      const b = { start: w.start_date, start_time: w.start_time || null, end: w.end_date, end_time: w.end_time || null, mine: own };
      if (isAdmin) return { ...b, id: w.id, hold_expires_at: w.hold_expires_at, hold_expires_text: T.fmtStamp(w.hold_expires_at), holder: { id: w.employee_id, name: w.holder_name, department: w.holder_department || null } };
      return own ? { ...b, id: w.id, hold_expires_at: w.hold_expires_at, hold_expires_text: T.fmtStamp(w.hold_expires_at) } : b;
    }),
    waitlist: wl.filter((w) => !w.lapsed && (isAdmin || w.employee_id === employeeId)).map((w) => {
      const b = { id: w.id, start: w.start_date, start_time: w.start_time || null, end: w.end_date, end_time: w.end_time || null, phase: w.status, mine: !!employeeId && w.employee_id === employeeId, created_at: w.created_at, hold_expires_at: w.status === 'held' ? w.hold_expires_at : null };
      return isAdmin ? { ...b, holder: { id: w.employee_id, name: w.holder_name, department: w.holder_department || null } } : b;
    }),
    reserve: { allowed: !!canReserve && reserveEligibility(a).ok, requires_approval: !!a.reservation_requires_approval },
  };
}

// Per-day counts for a broad scope (see src/availability.js).
function summaryDays(assets, openBy, resvBy, { isAdmin, today, win, events }) {
  return win.days.map((d) => {
    if (d < today) return isAdmin ? { available: 0, expected: 0, checked_out: 0, reserved: 0, partial: 0, off: 0 } : { available: 0, expected: 0, unavailable: 0, reserved: 0, partial: 0, off: 0 };
    const c = { available: 0, expected: 0, unavailable: 0, reserved: 0, partial: 0, off: 0 };
    for (const a of assets) {
      const s = dayState(a, openBy.get(a.id), d, today, resvBy.get(a.id));
      if (s === 'available') c.available++;
      else if (s === 'expected') c.expected++;
      else if (s === 'reserved') c.reserved++;
      else if (s === 'partial') c.partial++;
      else if (s === 'occupied') c.unavailable++;
      else if (isAdmin) c.off++;
      else c.unavailable++;
    }
    if (!isAdmin) return c;
    return { available: c.available, expected: c.expected, checked_out: events.filter((e) => eventOn(e, d)).length, reserved: c.reserved, partial: c.partial, off: c.off };
  });
}

const eventOn = (e, day) => e.start <= day && (e.overdue || day <= e.end);

function allCheckouts(assets, openBy, { today, win }) {
  const out = [];
  for (const a of assets) {
    for (const h of openBy.get(a.id)) {
      if (h.assignment_type !== 'checkout') continue;
      const start = String(h.checked_out_at).slice(0, 10);
      const overdue = h.due_date < today;
      if (start > win.last || (!overdue && h.due_date < win.first)) continue;
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

const byAsset = (assets, rows) => {
  const m = new Map(assets.map((a) => [a.id, []]));
  for (const r of rows) m.get(r.asset_id).push(r);
  return m;
};

// The calendar for one scope and month. `viewer` = { isAdmin, employeeId }.
async function availability(q, { isAdmin, employeeId = null, nodeId, assetId, month, canReserve = false }) {
  const today = await time.today(q);
  const win = monthWindow(month, today);
  if (!isAdmin && nodeId === undefined && assetId === undefined) throw httpError(400, 'Choose a category or an item first. The calendar for all equipment is for IT.');
  const index = await catalog.loadIndex(q);
  const { scope, assets } = await resolveScope(q, { isAdmin, employeeId, nodeId, assetId }, index);

  const ids = assets.map((a) => a.id);
  const many = async (sql, params) => (assets.length ? (await q.query(sql, params)).rows : []);
  const open = byAsset(assets, await many(`SELECT s.*, e.name AS holder_name, e.department AS holder_department FROM assignments s JOIN employees e ON e.id = s.employee_id
    WHERE s.returned_at IS NULL AND s.asset_id = ANY($1::int[]) ORDER BY s.checked_out_at, s.id`, [ids]));
  const resv = byAsset(assets, await many(`SELECT r.*, e.name AS holder_name, e.department AS holder_department FROM reservations r JOIN employees e ON e.id = r.employee_id
    WHERE r.status IN ('pending','confirmed') AND r.end_date >= $1 AND r.asset_id = ANY($2::int[]) ORDER BY r.start_date, r.id`, [today, ids]));
  const wl = byAsset(assets, await many(`SELECT w.*, CASE WHEN w.status = 'held' AND w.hold_expires_at <= ${NOW} THEN 1 ELSE 0 END AS lapsed, e.name AS holder_name, e.department AS holder_department
    FROM waitlist_entries w JOIN employees e ON e.id = w.employee_id
    WHERE w.status IN ('waiting','held') AND w.end_date >= $1 AND w.asset_id = ANY($2::int[]) ORDER BY w.queue_seq, w.status, w.id`, [today, ids]));
  const prio = new Map();
  for (const r of await many(`SELECT * FROM equipment_requests WHERE status = 'ready' AND hold_expires_at > ${NOW} AND asset_id = ANY($1::int[])`, [ids])) prio.set(r.asset_id, r);
  const prioFor = (id) => { const p = prio.get(id); return p && p.employee_id !== employeeId ? p : null; };
  const head = { scope, today, month: win.month, first: win.first, last: win.last };

  if (scope.type === 'asset') {
    return { ...head, view: 'asset', assets: assets.map((a) => assetRow(index, a, open.get(a.id), resv.get(a.id), wl.get(a.id), { isAdmin, employeeId, today, win, canReserve, prio: prioFor(a.id) })) };
  }
  const confirmedBy = new Map([...resv].map(([id, list]) => [id, [...list.filter((r) => r.status === 'confirmed'), ...wl.get(id).filter((w) => w.status === 'held' && !w.lapsed), ...(prioFor(id) ? [{ start_date: today, end_date: PRIORITY_END, start_time: null, end_time: null }] : [])]]));
  const events = isAdmin ? allCheckouts(assets, open, { today, win }) : [];
  const listed = !isAdmin && scope.type === 'node' ? assets.slice(0, MAX_LIST) : null;
  return {
    ...head, view: 'summary', total: assets.length,
    days: summaryDays(assets, open, confirmedBy, { isAdmin, today, win, events }),
    ...(isAdmin ? { events: events.slice(0, MAX_EVENTS), events_truncated: events.length > MAX_EVENTS } : {}),
    ...(listed ? { assets: listed.map((a) => assetRow(index, a, open.get(a.id), resv.get(a.id), wl.get(a.id), { isAdmin, employeeId, today, win, canReserve: false, prio: prioFor(a.id) })), assets_truncated: assets.length > MAX_LIST } : {}),
  };
}

// What each asset is TODAY, for the employee Browse list (see src/availability.js). Returns Map(asset id -> { state, expected_back }).
async function todayStates(q, assets) {
  const out = new Map();
  if (!assets.length) return out;
  const today = await time.today(q);
  const ids = assets.map((a) => a.id);
  const open = new Map(ids.map((i) => [i, []])); const block = new Map(ids.map((i) => [i, []]));
  for (const r of (await q.query('SELECT asset_id, assignment_type, due_date, checked_out_at FROM assignments WHERE returned_at IS NULL AND asset_id = ANY($1::int[])', [ids])).rows) open.get(r.asset_id).push(r);
  for (const r of (await q.query("SELECT asset_id, start_date, start_time, end_date, end_time FROM reservations WHERE status = 'confirmed' AND start_date <= $1 AND end_date >= $1 AND asset_id = ANY($2::int[])", [today, ids])).rows) block.get(r.asset_id).push(r);
  for (const r of (await q.query(`SELECT asset_id, start_date, start_time, end_date, end_time FROM waitlist_entries WHERE status = 'held' AND hold_expires_at > ${NOW} AND start_date <= $1 AND end_date >= $1 AND asset_id = ANY($2::int[])`, [today, ids])).rows) block.get(r.asset_id).push(r);
  for (const r of (await q.query(`SELECT asset_id FROM equipment_requests WHERE status = 'ready' AND hold_expires_at > ${NOW} AND asset_id = ANY($1::int[])`, [ids])).rows) block.get(r.asset_id).push({ start_date: today, end_date: today, start_time: null, end_time: null });
  for (const a of assets) {
    const s = dayState(a, open.get(a.id), today, today, block.get(a.id));
    const state = s === 'available' ? 'available' : s === 'reserved' ? 'reserved' : s === 'partial' ? 'partial' : s === 'occupied' ? 'checked_out' : 'unavailable';
    const dues = open.get(a.id).filter((h) => h.assignment_type === 'checkout' && h.due_date && h.due_date >= today).map((h) => h.due_date).sort();
    out.set(a.id, { state, expected_back: state === 'checked_out' && dues.length ? dues[0] : null });
  }
  return out;
}

module.exports = { todayStates, availability, monthWindow, periodsFor, dayState, resolveScope, checkoutEvents, reserveEligibility };
