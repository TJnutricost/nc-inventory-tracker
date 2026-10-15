// IT's catalog edits as the routes perform them (SQLite): the transactions around src/catalog.js writes, the category sync after a
// rename or move, and the entry as the editor gets it back. Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-1
// (D-48): the SQL and the transaction boundaries are unchanged; the database handle is the first argument, like the other data
// modules. Reached through the temporary driver seam (src/dataSeam). A PostgreSQL twin follows in Slice 5C.
const catalog = require('./catalog');

// Keeps assets.category (kept for display/filters/import) equal to the name of the root of the entry they are filed under,
// after a rename or move. History is never touched: requests keep the path text they were made with.
function syncAssetCategories(db, nodeId) {
  const upd = db.prepare('UPDATE assets SET category = ? WHERE catalog_node_id = ? AND category <> ?');
  for (const id of catalog.subtreeIds(db, nodeId)) { const root = catalog.rootOf(db, id).name; upd.run(root, id, root); }
}
const catalogOut = (db, id) => { const n = catalog.getNode(db, id); return { id: n.id, parent_id: n.parent_id, name: n.name, search_keywords: n.search_keywords || '', path: catalog.pathText(db, n.id), archived_at: n.archived_at, live: catalog.isLive(db, n.id), ...catalog.usage(db, n.id) }; };

// POST /api/catalog: one immediate transaction around the create (the caller has already parsed the parent).
const createNode = (db, { name, parentId, searchKeywords }) => db.transaction(() => catalog.createNode(db, { name, parentId, searchKeywords })).immediate();

// PUT /api/catalog/:id: the update and the category sync are one immediate transaction. `parent` is the raw body value: it is parsed
// INSIDE the transaction, exactly where server.js parsed it.
function updateNode(db, id, { name, parent, searchKeywords }) {
  db.transaction(() => { catalog.updateNode(db, id, { name, parentId: catalog.parseParent(parent), searchKeywords }); syncAssetCategories(db, id); }).immediate();
}

module.exports = { syncAssetCategories, catalogOut, createNode, updateNode };
