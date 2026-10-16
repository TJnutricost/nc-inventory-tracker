// IT's catalog edits as the routes perform them, on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/catalogAdmin.js
// (the transactions around the src/pg/catalog.js writes, the category sync after a rename or move, and the entry as the editor gets it
// back). NOT used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures,
// the same answers and errors (statuses and messages of src/pg/catalog.js); async, executor `q` first.
//
// Transactions (SQLite: db.transaction(...).immediate()). createNode, and updateNode + the category sync, are each ONE transaction:
// a caller's transaction when `q` is a transaction client, else their own (the src/pg pattern: isInTransaction(q) ? run(q) :
// withTransaction(run, q)). A failure anywhere (a refused name, a bad parent, a failing sync) rolls the whole edit back.
//
// Serialization (closes a race SQLite's single writer prevented). BEGIN IMMEDIATE made catalog edits one at a time, so every check
// (the parent exists and is live, a move does not go under the node's own subtree, the sibling name is free) was decided on the tree
// the write then changed. Under READ COMMITTED two concurrent edits could each pass their check on the old tree: moving A under B
// and B under A at the same time would create a cycle; a child could be created under a parent being archived. So the FIRST statement
// of both transactions is `LOCK TABLE catalog_nodes IN SHARE ROW EXCLUSIVE MODE`: it conflicts with itself and with every other
// writer's ROW EXCLUSIVE lock on the table (archive, restore, delete in src/pg/catalog.js), never with readers (ACCESS SHARE) or with
// the FOR KEY SHARE / ROW SHARE an assets INSERT/UPDATE takes for its catalog_node_id foreign key. The checks then run on the
// committed tree, after any edit that went first. The sibling-name UNIQUE index stays as the backstop (src/pg/catalog.js).
// Lock order: the catalog table first, then the asset rows the category sync updates (one bulk UPDATE per entry; no asset-locked
// transaction ever waits on the catalog table, so the order cannot invert).
//
// Differences from SQLite (output identical): the tree is loaded once per call and walked synchronously (src/pg/catalog.js inIndex;
// the root walk below is src/pg/catalog.js rootOf over the loaded index); `usage` counts come back as JS numbers.
const catalog = require('./catalog');
const { withTransaction, isInTransaction } = require('./transaction');

const { inIndex, parseParent } = catalog;
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const LOCK_CATALOG = 'LOCK TABLE catalog_nodes IN SHARE ROW EXCLUSIVE MODE';

// The same walk as src/pg/catalog.js rootOf, over an already loaded index.
function rootIn({ nodes }, id) {
  let n = nodes.get(id); const seen = new Set();
  while (n && n.parent_id !== null && !seen.has(n.id)) { seen.add(n.id); n = nodes.get(n.parent_id); }
  return n || null;
}

// Keeps assets.category equal to the name of the root of the entry they are filed under, after a rename or move. History is never
// touched: requests keep the path text they were made with.
async function syncAssetCategories(q, nodeId) {
  const index = await catalog.loadIndex(q);
  for (const id of inIndex.subtreeIds(index, nodeId)) {
    const root = rootIn(index, id).name;
    await q.query('UPDATE assets SET category = $1 WHERE catalog_node_id = $2 AND category <> $3', [root, id, root]);
  }
}

async function catalogOut(q, id) {
  const index = await catalog.loadIndex(q);
  const n = inIndex.getNode(index, id);
  return { id: n.id, parent_id: n.parent_id, name: n.name, search_keywords: n.search_keywords || '', path: inIndex.pathText(index, n.id), archived_at: n.archived_at, live: inIndex.isLive(index, n.id), ...(await catalog.usage(q, n.id)) };
}

// POST /api/catalog: one transaction around the create (the caller has already parsed the parent). Returns the new id.
const createNode = async (q, { name, parentId, searchKeywords }) => inTransaction(q, async (c) => {
  await c.query(LOCK_CATALOG);
  return catalog.createNode(c, { name, parentId, searchKeywords });
});

// PUT /api/catalog/:id: the update and the category sync are one transaction. `parent` is the raw body value: it is parsed INSIDE the
// transaction, exactly where the SQLite version parses it (a bad value is a 400 and nothing is written).
async function updateNode(q, id, { name, parent, searchKeywords }) {
  await inTransaction(q, async (c) => {
    await c.query(LOCK_CATALOG);
    await catalog.updateNode(c, id, { name, parentId: parseParent(parent), searchKeywords });
    await syncAssetCategories(c, id);
  });
}

module.exports = { syncAssetCategories, catalogOut, createNode, updateNode };
