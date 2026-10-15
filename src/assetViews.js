// How assets are read and shown (SQLite): the asset list (Browse / IT's inventory), the asset page, the scan lookup, an asset's open
// assignments, and the fields a non-admin may see. Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48):
// the SQL and the answers are unchanged; the database handle is the first argument, like the other data modules (server.js read
// `req.user` / `req.query`, which are now passed as `user` / `query`). Routes migrated to the temporary driver seam reach these through
// src/dataSeam (`await data.assetViews.listAssets(user, query)`); the routes not migrated yet keep ASSET_LIST_SQL and a thin bound
// `openAssignments(assetId)` alias in server.js. A PostgreSQL twin follows in Slice 5C.
const catalog = require('./catalog');
const availabilityLib = require('./availability');
const requestRules = require('./requests');
const reservationRules = require('./reservations');
const waitlistRules = require('./waitlist');
const reservationViews = require('./reservationViews');
const { capacity } = require('./assignments');
const { serialKey } = require('./serial');
const { ACTOR_JOIN, ACTOR_NAME } = require('./activityLog');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const openAssignments = (db, assetId) => db.prepare(`
  SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email, u.department AS user_department
  FROM assignments s JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
  WHERE s.asset_id = ? AND s.returned_at IS NULL ORDER BY s.checked_out_at`).all(assetId);

// Adds the readable catalog path to an asset row. An employee never learns about a catalog entry that is archived (or sits
// under an archived one): for them it is as if the asset were unmapped.
function withCatalog(db, a, user) {
  if (!('catalog_node_id' in a)) return a;
  const id = a.catalog_node_id;
  if (id === null || id === undefined) return { ...a, catalog_path: null };
  if (user.role !== 'admin' && !catalog.isLive(db, id)) return { ...a, catalog_node_id: null, catalog_path: null };
  return { ...a, catalog_path: catalog.pathText(db, id) };
}

// Fields a non-admin should not see
function sanitizeAsset(db, a, user) {
  if (!a) return a;
  a = withCatalog(db, a, user);
  if (user.role === 'admin') return a;
  const mine = db.prepare('SELECT due_date FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(a.id, user.employee_id);
  const { purchase_cost, vendor, notes, holder_names, ...rest } = a; // never other people's names
  if (!mine) delete rest.license_key;
  if ('due_date' in rest) rest.due_date = mine ? mine.due_date : null; // the list's MIN(due_date) spans every holder; show only the viewer's own
  return rest;
}

const ASSET_LIST_SQL = `
  SELECT a.*,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS seats_used,
    (SELECT group_concat(u.name, ', ') FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS holder_names,
    (SELECT MIN(s.due_date) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS due_date,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'permanent') AS permanent_holders,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'checkout') AS checkout_holders,
    (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
  FROM assets a`;

// GET /api/assets: the whole answer (the list, each row as this viewer may see it, and for employees what each asset is today).
function listAssets(db, user, query) {
  const where = []; const params = [];
  const isAdmin = user.role === 'admin';
  // Employees get ONE meaning for this list — "equipment I can get": in the shared pool (available_to_request), available, not archived, and not something I already
  // hold (that is My Equipment). So the status / holder filters below are admin tools and are ignored for employees; they
  // would otherwise be a way to probe other people's assignments (e.g. searching a multi-seat license by holder name).
  const { q, category } = query;
  const status = isAdmin ? query.status : undefined;
  const employeeFilter = isAdmin ? (query.employee_id || query.user_id) : undefined; // user_id kept as a compatibility alias
  if (typeof q === 'string' && q.trim()) {
    // Normalized, case-insensitive, token-wise: every word must match SOMEWHERE (substring) in any of the asset's tag, name, serial, brand, model, category,
    // location, or its catalog entry (the whole path and the search keywords of the entry and all its ancestors); IT also matches a holder's name.
    for (const token of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const ids = catalog.searchNodeIds(db, token, { liveOnly: !isAdmin });
      const cols = ['a.tag', 'a.name', 'a.serial', 'a.brand', 'a.model', 'a.location', 'a.category'];
      const like = `%${token.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}${ids.length ? ` OR a.catalog_node_id IN (${ids.join(',')})` : ''}${isAdmin
        ? " OR EXISTS (SELECT 1 FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL AND u.name LIKE ? ESCAPE '\\')" : ''})`);
      params.push(...cols.map(() => like)); if (isAdmin) params.push(like);
    }
  }
  if (category) { where.push('a.category = ?'); params.push(category); }
  if (query.catalog_node !== undefined && query.catalog_node !== '') {
    // Everything filed under a catalog entry or any of its descendants. Employees can only drill into live entries, and
    // only live descendants count for them (an archived sub-entry is invisible to them).
    const nodeId = Number(query.catalog_node);
    if (!Number.isInteger(nodeId) || !catalog.loadIndex(db).nodes.has(nodeId) || (!isAdmin && !catalog.isLive(db, nodeId))) throw httpError(404, 'Catalog entry not found');
    const ids = catalog.subtreeIds(db, nodeId).filter((i) => isAdmin || catalog.isLive(db, i));
    where.push(`a.catalog_node_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (status === 'overdue') { where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.due_date < date('now'))`); }
  else if (status === 'active') { where.push(`a.status NOT IN ('retired','lost','disposed')`); }
  else if (status) { where.push('a.status = ?'); params.push(status); }
  if (!(user.role === 'admin' && query.include_archived === '1')) where.push('a.archived_at IS NULL');
  if (employeeFilter) { where.push('EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)'); params.push(Number(employeeFilter)); }
  if (!isAdmin) {
    // The shared pool, for DISCOVERY: what IT made available_to_request, not archived, not already mine. Being checked out (temporarily), reserved or held does NOT
    // hide an asset (that is availability, shown on the row; the employee can open its calendar, reserve future days or join a waitlist). Equipment with a
    // permanent holder is still not part of the pool. `?available=1` narrows to what can be had right now (the "request this specific item" pickers).
    where.push(`a.available_to_request = 1 AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)
      AND (a.status = 'available' OR (a.status = 'checked_out' AND NOT EXISTS (SELECT 1 FROM assignments p WHERE p.asset_id = a.id AND p.returned_at IS NULL AND p.assignment_type = 'permanent')))`);
    params.push(user.employee_id);
    if (query.available === '1') where.push(`a.status = 'available'`);
  }
  const sql = `${ASSET_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.updated_at DESC LIMIT 1000`;
  const rows = db.prepare(sql).all(...params);
  const states = isAdmin ? null : availabilityLib.todayStates(db, rows); // employees: what each listed asset is today (see src/availability.js)
  return rows.map((a) => { const out = sanitizeAsset(db, a, user); if (states) { const t = states.get(a.id); out.avail_state = t.state; out.expected_back = t.expected_back; } return out; });
}

// GET /api/assets/lookup/:code (the scanner): the asset whose tag (any letter case) or normalized serial is `code`, or nothing.
// Archived assets are still found (their tags stay reserved); the flag lets clients say so.
const lookupCode = (db, code) => db.prepare('SELECT id, archived_at FROM assets WHERE tag = ? COLLATE NOCASE').get(code)
  || (serialKey(code) && db.prepare('SELECT id, archived_at FROM assets WHERE serial_normalized = ?').get(serialKey(code)));

// GET /api/assets/:id: the asset page for an asset this user may see (the caller checked that: src/assetAccess.js visibleAsset).
function assetDetail(db, user, a) {
  const holders = openAssignments(db, a.id);
  const isMine = holders.some((h) => h.employee_id === user.employee_id);
  const isAdmin = user.role === 'admin';
  const photos = db.prepare('SELECT * FROM photos WHERE asset_id = ? ORDER BY id').all(a.id);
  const requests = db.prepare(`
    SELECT r.*, u.name AS user_name, COALESCE(ca.employee_id = r.user_id, 0) AS self_initiated FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN accounts ca ON ca.id = r.created_by
    WHERE r.asset_id = ? AND r.status IN ('open','dropped_off') ORDER BY r.created_at DESC`).all(a.id)
    .filter((r) => isAdmin || r.user_id === user.employee_id);
  const requestsOut = requestRules.withLifecycle(db, requests);
  // Live reservations on this asset: IT sees all of them; an employee only their own (who else reserved it is not theirs to read here).
  const reservations = db.prepare(`${reservationViews.RESERVATION_SQL} WHERE r.asset_id = ? AND r.status IN ('pending','confirmed') AND r.end_date >= date('now') ORDER BY r.start_date, r.id`).all(a.id)
    .filter((r) => isAdmin || r.employee_id === user.employee_id).map((r) => reservationViews.reservationOut(db, r, user));
  const reserve = { allowed: !isAdmin && !!user.employee_id && reservationRules.reserveEligibility(a).ok, requires_approval: !!a.reservation_requires_approval };
  // An employee's OWN open waitlist places for this asset (never anyone else's), and whether anything is scheduled from today on (display only: it changes no rule).
  const waitlist = isAdmin ? [] : waitlistRules.list(db, user, { status: 'open' }).filter((w) => w.asset_id === a.id);
  const upcoming = !!(db.prepare("SELECT 1 FROM reservations WHERE asset_id = ? AND status = 'confirmed' AND end_date >= date('now') LIMIT 1").get(a.id)
    || db.prepare("SELECT 1 FROM waitlist_entries WHERE asset_id = ? AND status = 'held' AND hold_expires_at > datetime('now') LIMIT 1").get(a.id));
  const activity = isAdmin ? db.prepare(`
    SELECT ac.*, ${ACTOR_NAME} FROM activity ac ${ACTOR_JOIN}
    WHERE ac.asset_id = ? ORDER BY ac.id DESC LIMIT 100`).all(a.id) : [];
  return {
    asset: { ...sanitizeAsset(db, a, user), permanent_holders: holders.filter((h) => h.assignment_type === 'permanent').length, checkout_holders: holders.filter((h) => h.assignment_type === 'checkout').length },
    holders: isAdmin ? holders : holders.filter((h) => h.employee_id === user.employee_id),
    held_by_other: !isAdmin && !isMine && holders.length >= capacity(a),
    seats_used: holders.length,
    capacity: capacity(a),
    is_mine: isMine,
    photos,
    requests: requestsOut,
    reservations,
    waitlist,
    upcoming,
    reserve,
    activity,
  };
}

module.exports = { ASSET_LIST_SQL, openAssignments, withCatalog, sanitizeAsset, listAssets, lookupCode, assetDetail };
