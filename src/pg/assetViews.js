// How assets are read and shown, on PostgreSQL (D-46, D-48, migration Slice 5C-2): the PG twin of src/assetViews.js (the asset list,
// the asset page, the scan lookup, an asset's open assignments, the fields a non-admin may see, the CSV export rows; read its comments
// for the rules). NOT used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel
// signatures, the same answers (keys, value types, order, LIMITs, the same 404); async, executor `q` first.
//
// Differences from SQLite (output identical):
//   - `?` -> `$n`; date('now') / datetime('now') -> TODAY / NOW (src/pg/time.js; compared as text, D-46). Ids that are not integers in
//     the column's range match nothing (src/pg/reservations.js toId), as on SQLite, instead of raising a PG 22P02.
//   - ASSET_LIST_SQL is the PostgreSQL text: group_concat(u.name, ', ') -> string_agg(u.name, ', ' ORDER BY s.id) (SQLite gives the
//     holders in assignment rowid order through idx_assign_open; PG's order is otherwise unspecified).
//   - The search's case-insensitive `col LIKE ?` (SQLite LIKE folds ASCII letters only) -> `lower(col) LIKE $n`: the token is already
//     lower-cased in JS and lower() under COLLATE "C" folds ASCII letters only, exactly like SQLite's LIKE, so the same rows match.
//     Non-ASCII letters are NOT folded on either engine: a stored 'Émile' is not found by 'émile' (JS lower-cases the typed 'Émile'
//     to 'émile' too, so it is not found by its own spelling on either engine); a stored 'émile' is found. Pre-existing, unchanged.
//     The scan lookup `tag = ? COLLATE NOCASE` -> `lower(tag) = lower($1 COLLATE "C")` (the Slice 3 case rule; ASCII-only folding on
//     both sides: a bare lower($1) would fold the code with the database's default collation, non-ASCII letters too, and miss a tag
//     like 'CAM-Ünï' scanned as 'cam-Ünï', which SQLite finds; 5C-2 finding).
//   - `catalog_node_id IN (...)` lists -> `= ANY($n::int[])`.
//   - SQLite's `COALESCE(ca.employee_id = r.user_id, 0)` (an integer 0/1) -> a CASE giving the same 0/1 integer.
//   - Ties get explicit tie-breakers equal to SQLite's scan (rowid) order: the list `ORDER BY a.updated_at DESC, a.id`, the holders
//     `ORDER BY s.checked_out_at, s.id`, the asset page's requests `ORDER BY r.created_at DESC, r.id`. (exportRows orders by the tag,
//     which is unique.)
//   - The catalog tree is loaded once per call (src/pg/catalog.js loadIndex) and walked synchronously (inIndex), and for the list the
//     viewer's own open assignments among the listed rows are read in ONE query instead of one per row: the same answers.
//   - A code or search text containing a NUL character (only possible through a hand-made URL) is answered as "no match" by
//     lookupCode; PostgreSQL text cannot hold NUL. (SQLite never matches such a tag either.) In the search, a NUL in a token is a
//     known difference: PostgreSQL rejects the statement (a 500) where SQLite cuts the LIKE pattern at the NUL.
// These are reads. A write path that decides from them (check-in's open assignments, carry-over (w); Slice 5C-5) must read them on its
// transaction client, under the asset lock.
const catalog = require('./catalog');
const availabilityLib = require('./availability');
const requestRules = require('./requests');
const reservationRules = require('./reservations');
const waitlistRules = require('./waitlist');
const reservationViews = require('./reservationViews');
const { capacity } = require('./assignments');
const { serialKey } = require('../serial');
const { ACTOR_JOIN, ACTOR_NAME } = require('./activityLog');
const { TODAY, NOW } = require('./time');

const { toId } = reservationRules;
const { inIndex } = catalog;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const rows = async (q, sql, params = []) => (await q.query(sql, params)).rows;

const openAssignments = async (q, assetId) => rows(q, `
  SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email, u.department AS user_department
  FROM assignments s JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
  WHERE s.asset_id = $1 AND s.returned_at IS NULL ORDER BY s.checked_out_at, s.id`, [toId(assetId)]);

// withCatalog over an already loaded catalog index (see src/assetViews.js withCatalog).
function catalogWith(index, a, user) {
  if (!('catalog_node_id' in a)) return a;
  const id = a.catalog_node_id;
  if (id === null || id === undefined) return { ...a, catalog_path: null };
  if (user.role !== 'admin' && !inIndex.isLive(index, id)) return { ...a, catalog_node_id: null, catalog_path: null };
  return { ...a, catalog_path: inIndex.pathText(index, id) };
}
// sanitizeAsset given the viewer's own open assignment of this asset (`mine`, or undefined).
function sanitizeWith(index, a, user, mine) {
  a = catalogWith(index, a, user);
  if (user.role === 'admin') return a;
  const { purchase_cost, vendor, notes, holder_names, ...rest } = a; // never other people's names
  if (!mine) delete rest.license_key;
  if ('due_date' in rest) rest.due_date = mine ? mine.due_date : null; // the list's MIN(due_date) spans every holder; show only the viewer's own
  return rest;
}

// Adds the readable catalog path to an asset row (an employee never learns about an archived catalog entry).
async function withCatalog(q, a, user) {
  if (!('catalog_node_id' in a)) return a;
  return catalogWith(await catalog.loadIndex(q), a, user);
}

// Fields a non-admin should not see
async function sanitizeAsset(q, a, user) {
  if (!a) return a;
  const index = await catalog.loadIndex(q);
  if (user.role === 'admin') return sanitizeWith(index, a, user, undefined);
  const mine = (await rows(q, 'SELECT due_date FROM assignments WHERE asset_id = $1 AND employee_id = $2 AND returned_at IS NULL', [toId(a.id), toId(user.employee_id)]))[0];
  return sanitizeWith(index, a, user, mine);
}

const ASSET_LIST_SQL = `
  SELECT a.*,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS seats_used,
    (SELECT string_agg(u.name, ', ' ORDER BY s.id) FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS holder_names,
    (SELECT MIN(s.due_date) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS due_date,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'permanent') AS permanent_holders,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'checkout') AS checkout_holders,
    (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
  FROM assets a`;

// GET /api/assets (see src/assetViews.js listAssets for every rule).
async function listAssets(q, user, query) {
  const where = []; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const isAdmin = user.role === 'admin';
  const { q: text, category } = query;
  const status = isAdmin ? query.status : undefined;
  const employeeFilter = isAdmin ? (query.employee_id || query.user_id) : undefined; // user_id kept as a compatibility alias
  const index = await catalog.loadIndex(q);
  const isLive = (id) => inIndex.isLive(index, id);
  if (typeof text === 'string' && text.trim()) {
    for (const token of text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const ids = await catalog.searchNodeIds(q, token, { liveOnly: !isAdmin });
      const cols = ['a.tag', 'a.name', 'a.serial', 'a.brand', 'a.model', 'a.location', 'a.category'];
      const like = p(`%${token.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(${cols.map((c) => `lower(${c}) LIKE ${like} ESCAPE '\\'`).join(' OR ')}${ids.length ? ` OR a.catalog_node_id = ANY(${p(ids)}::int[])` : ''}${isAdmin
        ? ` OR EXISTS (SELECT 1 FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL AND lower(u.name) LIKE ${like} ESCAPE '\\')` : ''})`);
    }
  }
  if (category) where.push(`a.category = ${p(category)}`);
  if (query.catalog_node !== undefined && query.catalog_node !== '') {
    const nodeId = Number(query.catalog_node);
    if (!Number.isInteger(nodeId) || !index.nodes.has(nodeId) || (!isAdmin && !isLive(nodeId))) throw httpError(404, 'Catalog entry not found');
    const ids = inIndex.subtreeIds(index, nodeId).filter((i) => isAdmin || isLive(i));
    where.push(`a.catalog_node_id = ANY(${p(ids)}::int[])`);
  }
  if (status === 'overdue') where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.due_date < ${TODAY})`);
  else if (status === 'checked_out') where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'checkout')`); // the Home card's definition: a temporary checkout (see src/dashboard.js)
  else if (status === 'active') where.push(`a.status NOT IN ('retired','lost','disposed')`);
  else if (status) where.push(`a.status = ${p(status)}`);
  if (!(user.role === 'admin' && query.include_archived === '1')) where.push('a.archived_at IS NULL');
  if (employeeFilter) where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ${p(toId(Number(employeeFilter)))} AND s.returned_at IS NULL)`);
  if (!isAdmin) {
    where.push(`a.available_to_request = 1 AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ${p(toId(user.employee_id))} AND s.returned_at IS NULL)
      AND (a.status = 'available' OR (a.status = 'checked_out' AND NOT EXISTS (SELECT 1 FROM assignments p WHERE p.asset_id = a.id AND p.returned_at IS NULL AND p.assignment_type = 'permanent')))`);
    if (query.available === '1') where.push(`a.status = 'available'`);
  }
  const list = await rows(q, `${ASSET_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.updated_at DESC, a.id LIMIT 1000`, params);
  if (isAdmin) return list.map((a) => sanitizeWith(index, a, user, undefined));
  const states = await availabilityLib.todayStates(q, list); // employees: what each listed asset is today (see src/availability.js)
  const mine = new Map();
  if (list.length && toId(user.employee_id) !== null) {
    for (const r of await rows(q, 'SELECT asset_id, due_date FROM assignments WHERE employee_id = $1 AND returned_at IS NULL AND asset_id = ANY($2::int[])', [toId(user.employee_id), list.map((a) => a.id)])) mine.set(r.asset_id, r);
  }
  return list.map((a) => { const out = sanitizeWith(index, a, user, mine.get(a.id)); const t = states.get(a.id); out.avail_state = t.state; out.expected_back = t.expected_back; return out; });
}

// GET /api/assets/lookup/:code (the scanner): the asset whose tag (any letter case) or normalized serial is `code`, or nothing.
// Archived assets are still found (their tags stay reserved); the flag lets clients say so.
async function lookupCode(q, code) {
  const usable = (v) => !String(v).includes('\0');
  const byTag = usable(code) ? (await rows(q, 'SELECT id, archived_at FROM assets WHERE lower(tag) = lower($1 COLLATE "C")', [String(code)]))[0] : undefined;
  if (byTag) return byTag;
  const key = serialKey(code);
  return key && (usable(key) ? (await rows(q, 'SELECT id, archived_at FROM assets WHERE serial_normalized = $1', [key]))[0] : undefined);
}

// GET /api/assets/:id: the asset page for an asset this user may see (the caller checked that: src/pg/assetAccess.js visibleAsset).
async function assetDetail(q, user, a) {
  const holders = await openAssignments(q, a.id);
  const isMine = holders.some((h) => h.employee_id === user.employee_id);
  const isAdmin = user.role === 'admin';
  const photos = await rows(q, 'SELECT * FROM photos WHERE asset_id = $1 ORDER BY id', [a.id]);
  const requests = (await rows(q, `
    SELECT r.*, u.name AS user_name, CASE WHEN ca.employee_id = r.user_id THEN 1 ELSE 0 END AS self_initiated FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN accounts ca ON ca.id = r.created_by
    WHERE r.asset_id = $1 AND r.status IN ('open','dropped_off') ORDER BY r.created_at DESC, r.id`, [a.id]))
    .filter((r) => isAdmin || r.user_id === user.employee_id);
  const requestsOut = await requestRules.withLifecycle(q, requests);
  // Live reservations on this asset: IT sees all of them; an employee only their own.
  const reservations = [];
  for (const r of await rows(q, `${reservationViews.RESERVATION_SQL} WHERE r.asset_id = $1 AND r.status IN ('pending','confirmed') AND r.end_date >= ${TODAY} ORDER BY r.start_date, r.id`, [a.id])) {
    if (isAdmin || r.employee_id === user.employee_id) reservations.push(await reservationViews.reservationOut(q, r, user));
  }
  const reserve = { allowed: !isAdmin && !!user.employee_id && reservationRules.reserveEligibility(a).ok, requires_approval: !!a.reservation_requires_approval };
  // An employee's OWN open waitlist places for this asset (never anyone else's), and whether anything is scheduled from today on.
  const waitlist = isAdmin ? [] : (await waitlistRules.list(q, user, { status: 'open' })).filter((w) => w.asset_id === a.id);
  const upcoming = !!((await rows(q, `SELECT 1 FROM reservations WHERE asset_id = $1 AND status = 'confirmed' AND end_date >= ${TODAY} LIMIT 1`, [a.id]))[0]
    || (await rows(q, `SELECT 1 FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' AND hold_expires_at > ${NOW} LIMIT 1`, [a.id]))[0]);
  const activity = isAdmin ? await rows(q, `
    SELECT ac.*, ${ACTOR_NAME} FROM activity ac ${ACTOR_JOIN}
    WHERE ac.asset_id = $1 ORDER BY ac.id DESC LIMIT 100`, [a.id]) : [];
  return {
    asset: { ...await sanitizeAsset(q, a, user), permanent_holders: holders.filter((h) => h.assignment_type === 'permanent').length, checkout_holders: holders.filter((h) => h.assignment_type === 'checkout').length },
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

// GET /api/export/assets.csv: every live asset by tag, each with its catalog path ('' when unlinked).
async function exportRows(q) {
  const list = await rows(q, `${ASSET_LIST_SQL} WHERE a.archived_at IS NULL ORDER BY a.tag`);
  const index = await catalog.loadIndex(q);
  for (const r of list) r.catalog_path = r.catalog_node_id ? inIndex.pathText(index, r.catalog_node_id) : '';
  return list;
}

module.exports = { ASSET_LIST_SQL, openAssignments, withCatalog, sanitizeAsset, listAssets, lookupCode, assetDetail, exportRows };
