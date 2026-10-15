// How the equipment catalog is read (SQLite): the one tree every screen uses, and IT's catalog search. Extracted VERBATIM from
// src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL and the answers are unchanged; the database handle is the first
// argument, like the other data modules (server.js read `req.user` / `req.query`, now passed in). Reached through the temporary driver
// seam (src/dataSeam). IT's catalog EDITS are in src/catalogAdmin.js (5B-1). A PostgreSQL twin follows in Slice 5C.
const catalog = require('./catalog');

// One tree, one API, for every screen (phone drill-down, desktop columns, the asset form, the admin editor).
// Employees get only LIVE entries (not archived, no archived ancestor) and no admin-only counts; admins can ask for everything.
const heldByMe = (user) => (user.employee_id ? 'AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)' : '');

// GET /api/catalog/search. IT's catalog search: entries whose name, whole path or search keywords (own + ancestors') contain every word
// typed (`tokens`, already lower-cased and split by the route), shallowest first, each with its full path so an ambiguous match (an
// "EOS R5" under Camera > Canon) makes sense. Archived entries are included and flagged. Admin only.
function searchCatalog(db, tokens) {
  const { nodes } = catalog.loadIndex(db);
  const direct = new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c]));
  const hits = [];
  for (const n of nodes.values()) {
    const text = catalog.searchText(db, n.id);
    if (!tokens.every((t) => text.includes(t))) continue;
    const own = `${n.name} ${n.search_keywords || ''}`.toLowerCase();
    hits.push({ n, depth: catalog.depthOf(db, n.id), own: tokens.every((t) => own.includes(t)) });
  }
  hits.sort((a, b) => (b.own - a.own) || a.depth - b.depth || a.n.name.localeCompare(b.n.name));
  const results = hits.slice(0, 60).map(({ n }) => ({
    id: n.id, name: n.name, path: catalog.pathText(db, n.id), search_keywords: n.search_keywords || '', archived: !!n.archived_at || !catalog.isLive(db, n.id),
    asset_count: catalog.subtreeIds(db, n.id).reduce((t, i) => t + (direct.get(i) || 0), 0),
    via_keyword: !!n.search_keywords && tokens.some((t) => n.search_keywords.includes(t) && !n.name.toLowerCase().includes(t)),
  }));
  return { total: hits.length, results };
}

// GET /api/catalog. `includeArchived` is the raw `include_archived` query value (honoured for admins only).
function catalogTree(db, user, includeArchived) {
  const isAdmin = user.role === 'admin';
  const withArchived = isAdmin && includeArchived === '1';
  const { nodes, children } = catalog.loadIndex(db);
  // Per entry: assets filed directly under it that this viewer could get right now (the Browse contract: available, in the shared
  // pool for employees, not archived, not already theirs), then rolled up through the ancestors so a broad entry shows its whole subtree's count.
  const direct = new Map();
  for (const r of db.prepare(`SELECT a.catalog_node_id id, COUNT(*) c FROM assets a WHERE a.archived_at IS NULL AND a.status = 'available' AND a.catalog_node_id IS NOT NULL ${isAdmin ? '' : 'AND a.available_to_request = 1'} ${heldByMe(user)} GROUP BY a.catalog_node_id`)
    .all(...(user.employee_id ? [user.employee_id] : []))) direct.set(r.id, r.c);
  const availableIn = (id) => catalog.subtreeIds(db, id).filter((i) => isAdmin || catalog.isLive(db, i)).reduce((n, i) => n + (direct.get(i) || 0), 0);
  // Admin counts. asset_count = non-archived assets filed at the entry OR anywhere below it — exactly what
  // GET /api/assets?catalog_node=ID lists for an admin, so the number and the visible contents always agree.
  // direct_asset_count = assets filed at this very entry, archived ones included — what blocks a delete.
  const adminCounts = isAdmin ? {
    active: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
    assets: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
    requests: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM requests WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
  } : null;
  const out = [];
  for (const n of nodes.values()) {
    const live = catalog.isLive(db, n.id);
    if (!live && !withArchived) continue;
    const kids = (children.get(n.id) || []).filter((i) => isAdmin ? (withArchived || catalog.isLive(db, i)) : catalog.isLive(db, i));
    out.push({
      id: n.id, parent_id: n.parent_id, name: n.name, path: catalog.pathText(db, n.id), child_count: kids.length, available_count: availableIn(n.id),
      ...(isAdmin ? { search_keywords: n.search_keywords || '', archived_at: n.archived_at, live, asset_count: catalog.subtreeIds(db, n.id).reduce((t, i) => t + (adminCounts.active.get(i) || 0), 0), direct_asset_count: adminCounts.assets.get(n.id) || 0, request_count: adminCounts.requests.get(n.id) || 0 } : {}),
    });
  }
  return out;
}

module.exports = { heldByMe, searchCatalog, catalogTree };
