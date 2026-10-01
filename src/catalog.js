// Equipment catalog: a generic parent/child tree (table catalog_nodes, migration 11). A root is a broad category; below it
// every category has whatever structure suits it (Laptop > Mac > MacBook Air, Camera > Sony > A7 IV). Nothing here knows
// what a level "means" — there are no brand/model/OS columns, only names and parents.
//
// Rules enforced here (the schema can only express some of them):
//   - sibling names are unique ignoring case and surrounding/repeated whitespace, archived siblings included
//   - a node can never become its own ancestor (checked on move; a CHECK only blocks parent_id = id)
//   - nodes are archived, not deleted; the one exception is delete of a node nothing refers to (fixing a typo)
//   - a node is "live" (visible to employees, assignable, requestable) only if it AND every ancestor is not archived
//   - renaming/moving never rewrites history: requests keep the path text they were made with (requests.catalog_path)
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const MAX_NAME = 100;
const SEP = ' > ';
const normName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (v) => normName(v).toLowerCase();

// The table is tiny (tens to low hundreds of rows), so the whole tree is read at once and kept until a catalog write
// invalidates it. Keyed on the db handle so a second database in the same process (tests, seeding) never sees stale data.
let cached = null;
function invalidate() { cached = null; }
function loadIndex(db) {
  if (cached && cached.db === db) return cached.index;
  const nodes = new Map(); const children = new Map();
  for (const n of db.prepare('SELECT id, parent_id, name, archived_at FROM catalog_nodes ORDER BY name_key, id').all()) {
    nodes.set(n.id, n);
    const k = n.parent_id ?? 0;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(n.id);
  }
  const index = { nodes, children };
  cached = { db, index };
  return index;
}

// Names from root to node, e.g. ['Camera', 'Sony', 'A7 IV']. null for an unknown id.
function pathNames(db, id) {
  const { nodes } = loadIndex(db);
  const out = []; const seen = new Set();
  for (let n = nodes.get(id); n; n = nodes.get(n.parent_id)) {
    if (seen.has(n.id)) break; // can't happen (cycles are refused), but never loop forever on bad data
    seen.add(n.id); out.unshift(n.name);
  }
  return out.length ? out : null;
}
const pathText = (db, id) => { const p = pathNames(db, id); return p ? p.join(SEP) : null; };
const rootOf = (db, id) => {
  const { nodes } = loadIndex(db);
  let n = nodes.get(id); const seen = new Set();
  while (n && n.parent_id !== null && !seen.has(n.id)) { seen.add(n.id); n = nodes.get(n.parent_id); }
  return n || null;
};
// Live = this node and all its ancestors are active.
function isLive(db, id) {
  const { nodes } = loadIndex(db);
  const seen = new Set();
  for (let n = nodes.get(id); n; n = nodes.get(n.parent_id)) {
    if (n.archived_at || seen.has(n.id)) return false;
    seen.add(n.id);
  }
  return nodes.has(id);
}
// The node and every descendant (archived included), as an array of ids.
function subtreeIds(db, id) {
  const { nodes, children } = loadIndex(db);
  if (!nodes.has(id)) return [];
  const out = []; const stack = [id];
  while (stack.length) { const n = stack.pop(); out.push(n); for (const c of children.get(n) || []) stack.push(c); }
  return out;
}
const depthOf = (db, id) => (pathNames(db, id) || []).length;

function getNode(db, id) {
  const n = loadIndex(db).nodes.get(id);
  if (!n) throw httpError(404, 'Catalog entry not found');
  return n;
}
function cleanName(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw httpError(400, 'Name must be text');
  const name = normName(raw);
  if (!name) throw httpError(400, 'Give it a name');
  if (name.length > MAX_NAME) throw httpError(400, `Names can be at most ${MAX_NAME} characters`);
  if (/[>›]/.test(name)) throw httpError(400, 'Names can’t contain “>” (it separates levels in a path)');
  return name;
}
function assertSiblingFree(db, parentId, name, exceptId = null) {
  const key = nameKey(name);
  const row = db.prepare('SELECT id, name, archived_at FROM catalog_nodes WHERE COALESCE(parent_id, 0) = ? AND name_key = ?').get(parentId ?? 0, key);
  if (row && row.id !== exceptId) {
    throw httpError(400, `“${row.name}” already exists here${row.archived_at ? ' (archived — restore it instead)' : ''}. Names must differ at the same level, ignoring capitals and extra spaces.`);
  }
}
// parent_id from a request body: undefined => not provided, null/'' => root, otherwise a positive integer.
function parseParent(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'Choose a valid parent');
  return n;
}

function createNode(db, { name, parentId = null }) {
  const clean = cleanName(name);
  if (parentId !== null) {
    getNode(db, parentId);
    if (!isLive(db, parentId)) throw httpError(400, 'That parent is archived. Restore it first.');
  }
  assertSiblingFree(db, parentId, clean);
  const id = db.prepare('INSERT INTO catalog_nodes (parent_id, name, name_key) VALUES (?, ?, ?)').run(parentId, clean, nameKey(clean)).lastInsertRowid;
  invalidate();
  return Number(id);
}

// Renames and/or moves a node. Returns { oldPath, newPath } so the caller can keep assets.category in step for roots.
function updateNode(db, id, { name, parentId }) {
  const node = getNode(db, id);
  const newName = name === undefined ? node.name : cleanName(name);
  const newParent = parentId === undefined ? node.parent_id : parentId;
  if (newParent !== node.parent_id) {
    if (newParent !== null) {
      getNode(db, newParent);
      if (subtreeIds(db, id).includes(newParent)) throw httpError(400, "A catalog entry can't be moved under itself or one of its own children.");
      if (!isLive(db, newParent)) throw httpError(400, 'That destination is archived. Restore it first.');
    }
  }
  assertSiblingFree(db, newParent, newName, id);
  const oldPath = pathText(db, id);
  db.prepare("UPDATE catalog_nodes SET name = ?, name_key = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?").run(newName, nameKey(newName), newParent, id);
  invalidate();
  return { oldPath, newPath: pathText(db, id), wasRoot: node.parent_id === null, isRoot: newParent === null };
}

function archiveNode(db, id) {
  const n = getNode(db, id);
  if (n.archived_at) throw httpError(400, 'Already archived');
  db.prepare("UPDATE catalog_nodes SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  invalidate();
}
function restoreNode(db, id) {
  const n = getNode(db, id);
  if (!n.archived_at) throw httpError(400, 'Not archived');
  if (n.parent_id !== null && !isLive(db, n.parent_id)) throw httpError(400, 'Restore the parent first — it is archived.');
  db.prepare("UPDATE catalog_nodes SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  invalidate();
}

// What depends on a node: children, assets linked to it, requests that name it.
function usage(db, id) {
  const one = (sql) => db.prepare(sql).get(id).c;
  return {
    children: one('SELECT COUNT(*) c FROM catalog_nodes WHERE parent_id = ?'),
    assets: one('SELECT COUNT(*) c FROM assets WHERE catalog_node_id = ?'),
    requests: one('SELECT COUNT(*) c FROM requests WHERE catalog_node_id = ?'),
  };
}
function deleteNode(db, id) {
  getNode(db, id);
  const u = usage(db, id);
  if (u.children || u.assets || u.requests) {
    throw httpError(400, 'This entry is in use (it has children, assets or requests), so it can’t be deleted. Archive it instead.');
  }
  db.prepare('DELETE FROM catalog_nodes WHERE id = ?').run(id);
  invalidate();
}

// Resolves "Laptop > Mac > MacBook Air" (case/whitespace-insensitive; > or › between levels) to a LIVE node id, or null.
function findLiveByPath(db, text) {
  const parts = String(text ?? '').split(/\s*[>›]\s*/).map(nameKey).filter(Boolean);
  if (!parts.length) return null;
  const { nodes, children } = loadIndex(db);
  let level = children.get(0) || []; let found = null;
  for (const part of parts) {
    found = level.map((i) => nodes.get(i)).find((n) => nameKey(n.name) === part);
    if (!found) return null;
    level = children.get(found.id) || [];
  }
  return found && isLive(db, found.id) ? found.id : null;
}

module.exports = {
  SEP, MAX_NAME, normName, nameKey, invalidate, loadIndex, pathNames, pathText, rootOf, isLive, subtreeIds, depthOf, getNode,
  parseParent, createNode, updateNode, archiveNode, restoreNode, usage, deleteNode, findLiveByPath,
};
