// Equipment catalog on PostgreSQL (D-46, migration Slice 3): the PG counterpart of src/catalog.js. NOT used by the running
// app yet (Slice 5 switches server.js over). Same rules, names, return shapes and error statuses/messages as src/catalog.js
// (read its header for the rules); every function is async and takes an executor `q` (a pg Pool or a transaction client
// from withTransaction) where the SQLite version takes `db`.
//
// Pure helpers (SEP, MAX_NAME, normName, nameKey, normKeywords, parseParent) are imported from src/catalog.js, which has
// no database imports; they move here at cutover. cleanName is private there, so it is repeated below.
//
// Cache. The whole tree is read at once and kept until a catalog write invalidates it, keyed on the executor (the pool).
// It is NOT shared with src/catalog.js. Rules:
//   - Only an executor that is NOT inside withTransaction() is cached. A transaction client always reads the tree fresh
//     through itself, so it sees its own uncommitted writes and never stores them where other connections would read them.
//   - A write through a pool (autocommit) invalidates after its statement. A write through a transaction client
//     invalidates after that transaction ends (commit or rollback, via onTransactionEnd), so nothing caches pre-commit state
//     as current and nothing keeps rolled-back state.
//   - `generation` is bumped on every invalidation; a load that started before an invalidation is returned to its caller
//     but not stored, so a read that raced with a write cannot put the old tree back.
//
// Sibling-name uniqueness is check-then-write (for the friendly message), backed by the baseline's UNIQUE index
// idx_catalog_sibling_name on (COALESCE(parent_id, 0), name_key). A concurrent writer that slips between the check and the
// write gets a 23505 from that index; it is turned into the same 400 message assertSiblingFree gives.
const base = require('../catalog');
const { isInTransaction, onTransactionEnd } = require('./transaction');
const { NOW } = require('./time');

const { SEP, MAX_NAME, normName, nameKey, normKeywords, parseParent } = base;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const SIBLING_INDEX = 'idx_catalog_sibling_name';

// ---- cache
let generation = 0;
let cache = new WeakMap(); // executor -> { generation, index }
function invalidate() {
  generation += 1;
  cache = new WeakMap();
}

async function readIndex(q) {
  const nodes = new Map(); const children = new Map();
  for (const n of (await q.query('SELECT id, parent_id, name, archived_at, search_keywords FROM catalog_nodes ORDER BY name_key, id')).rows) {
    nodes.set(n.id, n);
    const k = n.parent_id ?? 0;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(n.id);
  }
  return { nodes, children };
}

async function loadIndex(q) {
  if (isInTransaction(q)) return readIndex(q);
  const hit = cache.get(q);
  if (hit && hit.generation === generation) return hit.index;
  const startedAt = generation;
  const index = await readIndex(q);
  if (startedAt === generation) cache.set(q, { generation, index });
  return index;
}

// After a write through `q`: invalidate now, and (in a transaction) again once it has committed or rolled back.
function written(q) {
  invalidate();
  if (isInTransaction(q)) onTransactionEnd(q, invalidate);
}

// ---- tree walks over a loaded index (synchronous; the exported versions load the index first)
function namesIn({ nodes }, id) {
  const out = []; const seen = new Set();
  for (let n = nodes.get(id); n; n = nodes.get(n.parent_id)) {
    if (seen.has(n.id)) break; // can't happen (cycles are refused), but never loop forever on bad data
    seen.add(n.id); out.unshift(n.name);
  }
  return out.length ? out : null;
}
const textIn = (index, id) => { const p = namesIn(index, id); return p ? p.join(SEP) : null; };
function liveIn({ nodes }, id) {
  const seen = new Set();
  for (let n = nodes.get(id); n; n = nodes.get(n.parent_id)) {
    if (n.archived_at || seen.has(n.id)) return false;
    seen.add(n.id);
  }
  return nodes.has(id);
}
function subtreeIn({ nodes, children }, id) {
  if (!nodes.has(id)) return [];
  const out = []; const stack = [id];
  while (stack.length) { const n = stack.pop(); out.push(n); for (const c of children.get(n) || []) stack.push(c); }
  return out;
}
function searchTextIn({ nodes }, id) {
  const parts = []; const seen = new Set();
  for (let n = nodes.get(id); n && !seen.has(n.id); n = nodes.get(n.parent_id)) { seen.add(n.id); parts.push(n.name, n.search_keywords || ''); }
  return parts.join(' ').toLowerCase();
}
function nodeIn(index, id) {
  const n = index.nodes.get(id);
  if (!n) throw httpError(404, 'Catalog entry not found');
  return n;
}

// ---- reads
const pathNames = async (q, id) => namesIn(await loadIndex(q), id);
const pathText = async (q, id) => textIn(await loadIndex(q), id);
async function rootOf(q, id) {
  const { nodes } = await loadIndex(q);
  let n = nodes.get(id); const seen = new Set();
  while (n && n.parent_id !== null && !seen.has(n.id)) { seen.add(n.id); n = nodes.get(n.parent_id); }
  return n || null;
}
const isLive = async (q, id) => liveIn(await loadIndex(q), id);
const subtreeIds = async (q, id) => subtreeIn(await loadIndex(q), id);
const searchText = async (q, id) => searchTextIn(await loadIndex(q), id);
async function searchNodeIds(q, token, { liveOnly = false } = {}) {
  const index = await loadIndex(q);
  const out = [];
  for (const id of index.nodes.keys()) if ((!liveOnly || liveIn(index, id)) && searchTextIn(index, id).includes(token)) out.push(id);
  return out;
}
const depthOf = async (q, id) => (namesIn(await loadIndex(q), id) || []).length;
const getNode = async (q, id) => nodeIn(await loadIndex(q), id);

// ---- validation
function cleanName(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw httpError(400, 'Name must be text');
  const name = normName(raw);
  if (!name) throw httpError(400, 'Give it a name');
  if (name.length > MAX_NAME) throw httpError(400, `Names can be at most ${MAX_NAME} characters`);
  if (/[>›]/.test(name)) throw httpError(400, 'Names can’t contain “>” (it separates levels in a path)');
  return name;
}
const siblingMessage = (row) => `“${row.name}” already exists here${row.archived_at ? ' (archived — restore it instead)' : ''}. Names must differ at the same level, ignoring capitals and extra spaces.`;
async function assertSiblingFree(q, parentId, name, exceptId = null) {
  const key = nameKey(name);
  const row = (await q.query('SELECT id, name, archived_at FROM catalog_nodes WHERE COALESCE(parent_id, 0) = $1 AND name_key = $2', [parentId ?? 0, key])).rows[0];
  if (row && row.id !== exceptId) throw httpError(400, siblingMessage(row));
}
const isSiblingClash = (err) => err && err.code === '23505' && err.constraint === SIBLING_INDEX;

// Runs one INSERT/UPDATE that may hit idx_catalog_sibling_name because another writer created the same sibling name after
// our check. Turns that into the assertSiblingFree message. In a transaction the failed statement would abort the whole
// transaction, so it runs under a savepoint; rolling back to it keeps the transaction usable for reading the clashing row.
async function siblingGuarded(q, parentId, name, exceptId, run) {
  const tx = isInTransaction(q);
  if (tx) await q.query('SAVEPOINT catalog_sibling');
  try {
    const result = await run();
    if (tx) await q.query('RELEASE SAVEPOINT catalog_sibling');
    return result;
  } catch (err) {
    if (tx) await q.query('ROLLBACK TO SAVEPOINT catalog_sibling');
    if (!isSiblingClash(err)) throw err;
    await assertSiblingFree(q, parentId, name, exceptId);
    throw httpError(400, siblingMessage({ name: normName(name) })); // the clashing row vanished again meanwhile
  }
}

// ---- writes
async function createNode(q, { name, parentId = null, searchKeywords }) {
  const clean = cleanName(name);
  const keywords = normKeywords(searchKeywords);
  if (parentId !== null) {
    const index = await loadIndex(q);
    nodeIn(index, parentId);
    if (!liveIn(index, parentId)) throw httpError(400, 'That parent is archived. Restore it first.');
  }
  await assertSiblingFree(q, parentId, clean);
  const { rows } = await siblingGuarded(q, parentId, clean, null,
    () => q.query('INSERT INTO catalog_nodes (parent_id, name, name_key, search_keywords) VALUES ($1, $2, $3, $4) RETURNING id', [parentId, clean, nameKey(clean), keywords]));
  written(q);
  return Number(rows[0].id);
}

// Renames and/or moves a node. Returns { oldPath, newPath, wasRoot, isRoot } so the caller can keep assets.category in step for roots.
async function updateNode(q, id, { name, parentId, searchKeywords }) {
  const index = await loadIndex(q);
  const node = nodeIn(index, id);
  const keywords = searchKeywords === undefined ? node.search_keywords : normKeywords(searchKeywords);
  const newName = name === undefined ? node.name : cleanName(name);
  const newParent = parentId === undefined ? node.parent_id : parentId;
  if (newParent !== node.parent_id) {
    if (newParent !== null) {
      nodeIn(index, newParent);
      if (subtreeIn(index, id).includes(newParent)) throw httpError(400, "A catalog entry can't be moved under itself or one of its own children.");
      if (!liveIn(index, newParent)) throw httpError(400, 'That destination is archived. Restore it first.');
    }
  }
  await assertSiblingFree(q, newParent, newName, id);
  const oldPath = textIn(index, id);
  await siblingGuarded(q, newParent, newName, id,
    () => q.query(`UPDATE catalog_nodes SET name = $1, name_key = $2, parent_id = $3, search_keywords = $4, updated_at = ${NOW} WHERE id = $5`, [newName, nameKey(newName), newParent, keywords, id]));
  written(q);
  return { oldPath, newPath: await pathText(q, id), wasRoot: node.parent_id === null, isRoot: newParent === null };
}

async function archiveNode(q, id) {
  const n = await getNode(q, id);
  if (n.archived_at) throw httpError(400, 'Already archived');
  await q.query(`UPDATE catalog_nodes SET archived_at = ${NOW}, updated_at = ${NOW} WHERE id = $1`, [id]);
  written(q);
}
async function restoreNode(q, id) {
  const index = await loadIndex(q);
  const n = nodeIn(index, id);
  if (!n.archived_at) throw httpError(400, 'Not archived');
  if (n.parent_id !== null && !liveIn(index, n.parent_id)) throw httpError(400, 'Restore the parent first — it is archived.');
  await q.query(`UPDATE catalog_nodes SET archived_at = NULL, updated_at = ${NOW} WHERE id = $1`, [id]);
  written(q);
}

// What depends on a node: children, assets linked to it, requests that name it.
async function usage(q, id) {
  const one = async (sql) => (await q.query(sql, [id])).rows[0].c;
  return {
    children: await one('SELECT COUNT(*) c FROM catalog_nodes WHERE parent_id = $1'),
    assets: await one('SELECT COUNT(*) c FROM assets WHERE catalog_node_id = $1'),
    requests: await one('SELECT COUNT(*) c FROM requests WHERE catalog_node_id = $1'),
  };
}
async function deleteNode(q, id) {
  await getNode(q, id);
  const u = await usage(q, id);
  if (u.children || u.assets || u.requests) {
    throw httpError(400, 'This entry is in use (it has children, assets or requests), so it can’t be deleted. Archive it instead.');
  }
  await q.query('DELETE FROM catalog_nodes WHERE id = $1', [id]);
  written(q);
}

// Resolves "Laptop > Mac > MacBook Air" (case/whitespace-insensitive; > or › between levels) to a LIVE node id, or null.
async function findLiveByPath(q, text) {
  const parts = String(text ?? '').split(/\s*[>›]\s*/).map(nameKey).filter(Boolean);
  if (!parts.length) return null;
  const index = await loadIndex(q);
  const { nodes, children } = index;
  let level = children.get(0) || []; let found = null;
  for (const part of parts) {
    found = level.map((i) => nodes.get(i)).find((n) => nameKey(n.name) === part);
    if (!found) return null;
    level = children.get(found.id) || [];
  }
  return found && liveIn(index, found.id) ? found.id : null;
}

module.exports = {
  SEP, MAX_NAME, normName, nameKey, normKeywords, searchText, searchNodeIds, invalidate, loadIndex, pathNames, pathText, rootOf, isLive, subtreeIds, depthOf, getNode,
  parseParent, createNode, updateNode, archiveNode, restoreNode, usage, deleteNode, findLiveByPath,
};
