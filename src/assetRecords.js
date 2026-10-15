// Writing asset records (SQLite): tag issuance, the serial-uniqueness check, the catalog entry of an asset write, and the create /
// edit / archive transactions. Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL and the
// transaction boundaries are unchanged; the database handle is the first argument, like the other data modules. Routes migrated to the
// temporary driver seam reach these through src/dataSeam (`await data.assetRecords.createAsset({...})`); the routes not migrated yet
// (CSV import, the next-tag preview) keep thin bound aliases in server.js. A PostgreSQL twin follows in Slice 5C.
const catalog = require('./catalog');
const { cleanSerial, serialKey } = require('./serial');
const { getAsset } = require('./assetAccess');
const { openAssignments } = require('./assetViews');
const { log } = require('./activityLog');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// The two per-asset reservation settings, and the editable asset fields (the validation of a body stays in server.js `assetValues`).
const FLAGS = ['available_to_request', 'reservation_requires_approval'];
const ASSET_FIELDS = ['name', 'category', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor',
  'warranty_expires', 'license_key', 'license_seats', 'license_expires', 'notes'];

// ---- asset tag issuance ----
// Generated tags are prefix + a number from a durable, ever-increasing counter (asset_tag_counter). The counter is
// independent of the prefix, is never lowered (archiving keeps tags reserved), and is claimed inside the same
// transaction that inserts the asset. (server.js `peekTag()` only previews the next number and consumes nothing.)
// `prefix` is the `tag_prefix` setting: server.js read it here with getSettings(); the settings move to the seam in Slice 5B-4, so
// until then the caller reads it and passes it in.
const formatTag = (prefix, n) => prefix + String(n).padStart(5, '0');
const tagExists = (db, tag) => !!db.prepare('SELECT 1 FROM assets WHERE tag = ?').get(tag);
function allocateTag(db, prefix) { // call only inside a transaction
  for (;;) {
    db.prepare('UPDATE asset_tag_counter SET last_number = last_number + 1 WHERE id = 1').run();
    const tag = formatTag(prefix, db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n);
    if (!tagExists(db, tag)) return tag; // skip numbers already taken by manually chosen tags
  }
}

// Serials are unique across the whole inventory (archived assets included) ignoring surrounding whitespace and letter
// case; see src/serial.js. The UNIQUE index on assets.serial_normalized is the backstop; this gives a readable 400.
function assertSerialFree(db, serial, exceptAssetId = null) {
  const key = serialKey(serial);
  if (key === null) return;
  const other = db.prepare('SELECT id, tag, archived_at FROM assets WHERE serial_normalized = ?').all(key).find((o) => o.id !== exceptAssetId);
  if (other) throw httpError(400, `Serial number ${cleanSerial(serial)} is already used by asset ${other.tag}${other.archived_at ? ' (archived)' : ''}. Serial numbers must be unique, ignoring letter case and surrounding spaces.`);
}

// The catalog entry for an asset write. Not in the body => unchanged. null/'' => unlinked. Otherwise it must be a live entry
// (an asset keeps its current entry even if that has since been archived, so editing other fields still works).
function resolveAssetNode(db, body, current) {
  if (!('catalog_node_id' in body)) return current ?? null;
  const raw = body.catalog_node_id;
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || !catalog.loadIndex(db).nodes.has(id)) throw httpError(400, 'Choose a valid catalog entry');
  if (id !== (current ?? null) && !catalog.isLive(db, id)) throw httpError(400, 'That catalog entry is archived. Choose an active one.');
  return id;
}

// POST /api/assets: the number claim + insert are one transaction: a failed create rolls the counter back, and two creates can't share a
// tag. `tag` is the tag the body asked for (cleaned; null = issue the next one), `v` the validated fields (server.js `assetValues`).
// Returns the new asset's id.
function createAsset(db, { tag: sentTag, tagPrefix, status, nodeId, flags, v, actorAccountId }) {
  const cols = ['tag', 'status', 'serial_normalized', 'catalog_node_id', ...FLAGS, ...ASSET_FIELDS];
  const create = db.transaction(() => {
    const tag = sentTag || allocateTag(db, tagPrefix);
    const used = db.prepare('SELECT archived_at FROM assets WHERE tag = ?').get(tag);
    if (used) throw httpError(400, used.archived_at ? `Tag ${tag} belongs to an archived asset and can't be reused` : `Tag ${tag} is already used by another asset`);
    assertSerialFree(db, v.serial);
    const info = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f]));
    log(db, info.lastInsertRowid, actorAccountId, 'created', `${tag} · ${v.name}`);
    return info.lastInsertRowid;
  });
  return create.immediate();
}

// PUT /api/assets/:id: the serial check and the update are one immediate transaction (the route logs the edit and refreshes the status
// after it, as before).
function updateAsset(db, { id, tag, status, nodeId, flags, v }) {
  db.transaction(() => {
    assertSerialFree(db, v.serial, id);
    db.prepare(`UPDATE assets SET tag = ?, status = ?, serial_normalized = ?, catalog_node_id = ?, ${FLAGS.map((f) => `${f} = ?`).join(', ')}, ${ASSET_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f]), id);
  }).immediate();
}

// POST /api/assets/:id/archive (and its DELETE alias). Assets are never permanently deleted: "delete" archives. The row, tag,
// assignments, activity, photos and requests all remain, and the tag stays reserved. The checks, then the archive + its activity row
// in one transaction, exactly as server.js ran them.
function archiveAsset(db, id, { actorAccountId, reason }) {
  const a = getAsset(db, Number(id));
  if (!a) throw httpError(404, 'Asset not found');
  if (a.archived_at) throw httpError(400, 'This asset is already archived.');
  if (openAssignments(db, a.id).length) throw httpError(400, 'Check this asset in before archiving it.');
  db.transaction(() => {
    db.prepare("UPDATE assets SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(a.id);
    log(db, a.id, actorAccountId, 'archived', `${a.tag} · ${a.name}${reason ? ` · ${reason}` : ''}`);
  })();
}

module.exports = { FLAGS, ASSET_FIELDS, formatTag, tagExists, allocateTag, assertSerialFree, resolveAssetNode, createAsset, updateAsset, archiveAsset };
