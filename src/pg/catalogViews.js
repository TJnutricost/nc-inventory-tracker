// How the equipment catalog is read, on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/catalogViews.js (the one
// tree every screen uses, and IT's catalog search; read its comments for the rules). NOT used by the running app yet (Slice 5D binds it
// to the driver seam under the same names). Same names, parallel signatures, the same answers (fields, counts, order); async,
// executor `q` first.
//
// Differences from SQLite (output identical):
//   - The tree is loaded ONCE per call (src/pg/catalog.js loadIndex: cached for the pool, read fresh through a transaction client)
//     and walked synchronously (src/pg/catalog.js inIndex for path / liveness / subtree; the search text and depth walks below are
//     the same walks as src/pg/catalog.js searchText / depthOf). The SQLite version calls the catalog helpers per node, each reading
//     its own cached index; the answers are the same.
//   - heldByMe(user) gives the PostgreSQL text: the placeholder is `$1` (SQLite: `?`), with the same single parameter (the employee id).
//   - COUNT(*) comes back as a JS number (src/pg/pool.js int8 parser), as better-sqlite3 returns it.
//   - Node order is the index order, `ORDER BY name_key, id` on both engines (COLLATE "C" = SQLite BINARY); the search ranks with the
//     same JS sort (localeCompare).
const catalog = require('./catalog');

const { inIndex } = catalog;

// Employees: not assets they already hold. `$1` is the employee id (only when the user has one).
const heldByMe = (user) => (user.employee_id ? 'AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = $1 AND s.returned_at IS NULL)' : '');

// The same walks as src/pg/catalog.js searchText / depthOf, over an already loaded index.
function searchTextIn({ nodes }, id) {
  const parts = []; const seen = new Set();
  for (let n = nodes.get(id); n && !seen.has(n.id); n = nodes.get(n.parent_id)) { seen.add(n.id); parts.push(n.name, n.search_keywords || ''); }
  return parts.join(' ').toLowerCase();
}
function depthIn({ nodes }, id) {
  let depth = 0; const seen = new Set();
  for (let n = nodes.get(id); n && !seen.has(n.id); n = nodes.get(n.parent_id)) { seen.add(n.id); depth += 1; }
  return depth;
}
const countsBy = async (q, sql, params = []) => new Map((await q.query(sql, params)).rows.map((r) => [r.id, r.c]));

// GET /api/catalog/search (admin only): entries whose name, whole path or search keywords contain every token, own matches first,
// then shallowest, then by name; at most 60, with the total.
async function searchCatalog(q, tokens) {
  const index = await catalog.loadIndex(q);
  const { nodes } = index;
  const direct = await countsBy(q, 'SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id');
  const hits = [];
  for (const n of nodes.values()) {
    const text = searchTextIn(index, n.id);
    if (!tokens.every((t) => text.includes(t))) continue;
    const own = `${n.name} ${n.search_keywords || ''}`.toLowerCase();
    hits.push({ n, depth: depthIn(index, n.id), own: tokens.every((t) => own.includes(t)) });
  }
  hits.sort((a, b) => (b.own - a.own) || a.depth - b.depth || a.n.name.localeCompare(b.n.name));
  const results = hits.slice(0, 60).map(({ n }) => ({
    id: n.id, name: n.name, path: inIndex.pathText(index, n.id), search_keywords: n.search_keywords || '', archived: !!n.archived_at || !inIndex.isLive(index, n.id),
    asset_count: inIndex.subtreeIds(index, n.id).reduce((t, i) => t + (direct.get(i) || 0), 0),
    via_keyword: !!n.search_keywords && tokens.some((t) => n.search_keywords.includes(t) && !n.name.toLowerCase().includes(t)),
  }));
  return { total: hits.length, results };
}

// GET /api/catalog. `includeArchived` is the raw `include_archived` query value (honoured for admins only).
async function catalogTree(q, user, includeArchived) {
  const isAdmin = user.role === 'admin';
  const withArchived = isAdmin && includeArchived === '1';
  const index = await catalog.loadIndex(q);
  const { nodes, children } = index;
  const isLive = (id) => inIndex.isLive(index, id);
  const subtreeIds = (id) => inIndex.subtreeIds(index, id);
  const direct = await countsBy(q, `SELECT a.catalog_node_id id, COUNT(*) c FROM assets a WHERE a.archived_at IS NULL AND a.status = 'available' AND a.catalog_node_id IS NOT NULL ${isAdmin ? '' : 'AND a.available_to_request = 1'} ${heldByMe(user)} GROUP BY a.catalog_node_id`,
    user.employee_id ? [user.employee_id] : []);
  const availableIn = (id) => subtreeIds(id).filter((i) => isAdmin || isLive(i)).reduce((n, i) => n + (direct.get(i) || 0), 0);
  const adminCounts = isAdmin ? {
    active: await countsBy(q, 'SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id'),
    assets: await countsBy(q, 'SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id'),
    requests: await countsBy(q, 'SELECT catalog_node_id id, COUNT(*) c FROM requests WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id'),
  } : null;
  const out = [];
  for (const n of nodes.values()) {
    const live = isLive(n.id);
    if (!live && !withArchived) continue;
    const kids = (children.get(n.id) || []).filter((i) => isAdmin ? (withArchived || isLive(i)) : isLive(i));
    out.push({
      id: n.id, parent_id: n.parent_id, name: n.name, path: inIndex.pathText(index, n.id), child_count: kids.length, available_count: availableIn(n.id),
      ...(isAdmin ? { search_keywords: n.search_keywords || '', archived_at: n.archived_at, live, asset_count: subtreeIds(n.id).reduce((t, i) => t + (adminCounts.active.get(i) || 0), 0), direct_asset_count: adminCounts.assets.get(n.id) || 0, request_count: adminCounts.requests.get(n.id) || 0 } : {}),
    });
  }
  return out;
}

module.exports = { heldByMe, searchCatalog, catalogTree };
