// Writing asset records (SQLite): tag issuance, the serial-uniqueness check, the catalog entry of an asset write, and the create /
// edit / archive transactions. Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL and the
// transaction boundaries are unchanged; the database handle is the first argument, like the other data modules. Routes migrated to the
// temporary driver seam reach these through src/dataSeam (`await data.assetRecords.createAsset({...})`). Slice 5B-4 added the next-tag
// preview (`peekTag`) and the CSV import (`importAssets`), extracted verbatim the same way. A PostgreSQL twin follows in Slice 5C.
const catalog = require('./catalog');
const { cleanSerial, serialKey } = require('./serial');
const { getAsset } = require('./assetAccess');
const { openAssignments } = require('./assetViews');
const { log } = require('./activityLog');
const { refreshStatus } = require('./assignments');
const { getSettings } = require('./settings');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim()); // (server.js `clean`)

// The two per-asset reservation settings, and the editable asset fields (the validation of a body stays in server.js `assetValues`).
const FLAGS = ['available_to_request', 'reservation_requires_approval'];
const ASSET_FIELDS = ['name', 'category', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor',
  'warranty_expires', 'license_key', 'license_seats', 'license_expires', 'notes'];

// ---- asset tag issuance ----
// Generated tags are prefix + a number from a durable, ever-increasing counter (asset_tag_counter). The counter is
// independent of the prefix, is never lowered (archiving keeps tags reserved), and is claimed inside the same
// transaction that inserts the asset. (`peekTag` below only previews the next number and consumes nothing.)
// `prefix` is the `tag_prefix` setting, read by the caller (POST /api/assets through the seam's `settings.getSettings`, the CSV import
// inside its transaction) and passed in.
const formatTag = (prefix, n) => prefix + String(n).padStart(5, '0');
const tagExists = (db, tag) => !!db.prepare('SELECT 1 FROM assets WHERE tag = ?').get(tag);
function allocateTag(db, prefix) { // call only inside a transaction
  for (;;) {
    db.prepare('UPDATE asset_tag_counter SET last_number = last_number + 1 WHERE id = 1').run();
    const tag = formatTag(prefix, db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n);
    if (!tagExists(db, tag)) return tag; // skip numbers already taken by manually chosen tags
  }
}

// Labels printed before the asset exists (docs/briefs/labels-and-assets.md): Create labels, and Print label in the Add asset form.
// `count` numbers are claimed from the same counter in ONE transaction (allocateTag: manually used tags skipped), so a printed label is
// never issued to another asset. `prefix` is the `tag_prefix` setting, read by the caller. Returns the tags in order. The claim also
// records the numbers it issued and the prefix they were issued under (issued_tag_ranges), because the prefix can change later while
// the printed labels cannot: recognising a label (issuedTag) and giving a sheet back (releaseTags) read that record, never the current prefix.
function claimTags(db, { prefix, count }) {
  return db.transaction(() => {
    const tags = Array.from({ length: count }, () => allocateTag(db, prefix));
    const nums = tags.map((t) => issuedNumber(prefix, t));
    db.prepare('INSERT INTO issued_tag_ranges (prefix, first_number, last_number) VALUES (?, ?, ?)').run(prefix, Math.min(...nums), Math.max(...nums));
    return tags;
  })();
}
// The issued number `tag` stands for: its number when some claim issued exactly `<its prefix><number>` (any letter case), else null.
const claimedNumber = (db, tag) => {
  for (const r of db.prepare('SELECT prefix, first_number, last_number FROM issued_tag_ranges ORDER BY id DESC').all()) {
    const n = issuedNumber(r.prefix, tag);
    if (n !== null && n >= r.first_number && n <= r.last_number) return n;
  }
  return null;
};
// Create labels changed its mind (the sheet did not print, or is not wanted): give the numbers back so the next claim issues them again.
// Only safe while they are the newest numbers and still unused, so ONE transaction checks that the counter still ends at the highest of
// `tags`, that every tag was issued by a claim (under whatever prefix it had then, which may not be the current one) and that no asset
// uses one, then lowers the counter to just below the lowest and trims the record to match. Claims never interleave (one transaction
// each), so when the highest is still the counter's last, every number from the lowest up belongs to this sheet or to nobody.
// Returns { released: true } or { released: false, reason }; nothing changes when refused.
function releaseTags(db, { tags }) {
  return db.transaction(() => {
    const nums = tags.map((t) => claimedNumber(db, t));
    if (!nums.length || nums.includes(null)) return { released: false, reason: 'not_ours' };
    const last = db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n;
    if (Math.max(...nums) !== last) return { released: false, reason: 'newer' };
    if (tags.some((t) => tagExists(db, String(t).trim()))) return { released: false, reason: 'used' };
    const low = Math.min(...nums);
    db.prepare('UPDATE asset_tag_counter SET last_number = ? WHERE id = 1').run(low - 1);
    db.prepare('DELETE FROM issued_tag_ranges WHERE first_number >= ?').run(low);
    db.prepare('UPDATE issued_tag_ranges SET last_number = ? WHERE last_number >= ?').run(low - 1, low);
    return { released: true };
  })();
}
// `code` as one of our claimed, still unused labels: `<the prefix it was claimed under><the 5-digit number>` (any letter case), the
// number recorded as issued by a claim and no asset using it. Returns the tag as printed, else null. Not the current prefix: a batch
// printed before a prefix change stays recognised, and a code that only looks like one of ours (another prefix, or a number no claim
// issued) is not.
function issuedTag(db, code) {
  for (const r of db.prepare('SELECT prefix, first_number, last_number FROM issued_tag_ranges ORDER BY id DESC').all()) {
    const n = issuedNumber(r.prefix, code);
    if (n === null || n < r.first_number || n > r.last_number) continue;
    const tag = formatTag(r.prefix, n);
    return tagExists(db, tag) ? null : tag;
  }
  return null;
}
// The number in `code` when it is exactly formatTag(prefix, n) ignoring letter case and surrounding spaces, else null (pure).
function issuedNumber(prefix, code) {
  const c = String(code ?? '').trim();
  const digits = c.slice(prefix.length);
  if (c.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase() || !/^\d{1,9}$/.test(digits)) return null;
  const n = Number(digits);
  return n >= 1 && formatTag(prefix, n).toUpperCase() === c.toUpperCase() ? n : null;
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

// ---- Slice 5B-4: the tag preview and the CSV import (extracted verbatim from server.js) ----

// GET /api/next-tag. Preview only: consumes nothing (a blank-tag create claims a number inside its transaction, which may differ if others
// create first). The `tag_prefix` setting is read here, as server.js `peekTag()` did; `prefix` (Create labels' unsaved draft) previews that
// prefix instead and still consumes nothing.
function peekTag(db, prefix = getSettings(db).tag_prefix) {
  let n = db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n + 1;
  while (tagExists(db, formatTag(prefix, n))) n++;
  return formatTag(prefix, n);
}

// POST /api/import/assets. `rows` = the file's data rows in order, each { o: the row by column name, v: the validated fields } (server.js
// parses the CSV and runs `assetValues` on each row, which reads no database and cannot refuse a CSV row: every cell is text). The active
// employees are read first, outside the transaction, then the WHOLE file is one transaction, exactly as before: a row with a problem
// (archived tag, missing name, serial in use, unknown catalog path or email) is skipped or imported partly and reported in `errors`
// ("Row N" counts the header as row 1); anything that throws rolls the whole file back. A blank tag issues the next number with the
// `tag_prefix` setting read at that moment, inside the transaction (as server.js `allocateTag()` did).
function importAssets(db, { rows, actorAccountId }) {
  let created = 0, updated = 0; const errors = [];
  // assigned_email matches an active employee by work email (or their login email); no login is needed to receive equipment.
  const users = new Map();
  for (const u of db.prepare("SELECT e.id, e.name, e.work_email, a.login_email FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id WHERE e.status = 'active'").all()) {
    for (const k of [u.work_email, u.login_email]) if (k) users.set(k.toLowerCase(), u);
  }
  const tx = db.transaction(() => {
    rows.forEach(({ o, v }, idx) => {
      const tag = clean(o.tag);
      const existing = tag ? db.prepare('SELECT * FROM assets WHERE tag = ?').get(tag) : null;
      if (existing && existing.archived_at) { errors.push(`Row ${idx + 2}: tag ${tag} belongs to an archived asset — skipped`); return; }
      if (!v.name && !existing) { errors.push(`Row ${idx + 2}: missing name`); return; }
      if (!existing) { v.category = v.category || 'Other'; v.condition = v.condition || 'Good'; }
      // A serial that belongs to a different asset (already in the inventory, archived or not, or earlier in this file)
      // skips just this row; an update that leaves the serial blank keeps the stored one.
      try { assertSerialFree(db, v.serial, existing ? existing.id : null); } catch (e) { errors.push(`Row ${idx + 2}: ${e.message.split('. ')[0]} — skipped`); return; }
      let id;
      if (existing) {
        db.prepare(`UPDATE assets SET ${ASSET_FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ')}, serial_normalized = COALESCE(?, serial_normalized), updated_at = datetime('now') WHERE id = ?`)
          .run(...ASSET_FIELDS.map((f) => v[f]), serialKey(v.serial), existing.id);
        id = existing.id; updated++;
      } else {
        const cols = ['tag', 'serial_normalized', ...ASSET_FIELDS];
        id = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(tag || allocateTag(db, getSettings(db).tag_prefix), serialKey(v.serial), ...ASSET_FIELDS.map((f) => v[f])).lastInsertRowid;
        log(db, id, actorAccountId, 'created', 'Imported from CSV'); created++;
        const home = clean(o.catalog_path) ? null : catalog.findLiveByPath(db, v.category); // same default as a manual create (the category's root), unless the row named a path
        if (home) db.prepare('UPDATE assets SET catalog_node_id = ?, category = ? WHERE id = ?').run(home, catalog.rootOf(db, home).name, id);
      }
      // catalog_path ("Laptop > Mac > MacBook Air") must match an active entry exactly (ignoring case/spacing); otherwise the
      // row is still imported but the link is left alone and the row is reported — nothing is guessed.
      const cpath = clean(o.catalog_path);
      if (cpath) {
        const nid = catalog.findLiveByPath(db, cpath);
        if (nid) db.prepare('UPDATE assets SET catalog_node_id = ?, category = ? WHERE id = ?').run(nid, catalog.rootOf(db, nid).name, id);
        else errors.push(`Row ${idx + 2}: catalog path “${cpath}” doesn't match an active catalog entry — imported without a catalog link`);
      }
      const em = clean(o.assigned_email)?.toLowerCase();
      if (em && users.has(em) && !openAssignments(db, id).length) {
        const u = users.get(em);
        db.prepare("INSERT INTO assignments (asset_id, employee_id, assignment_type, checked_out_by, notes) VALUES (?, ?, 'permanent', ?, ?)").run(id, u.id, actorAccountId, 'Imported');
        refreshStatus(db, id);
        log(db, id, actorAccountId, 'checked_out', `To ${u.name} (import)`, u.id);
      } else if (em && !users.has(em)) errors.push(`Row ${idx + 2}: no user with email ${em} — imported unassigned`);
    });
  });
  tx();
  return { created, updated, errors };
}

module.exports = { FLAGS, ASSET_FIELDS, formatTag, issuedNumber, tagExists, allocateTag, claimTags, releaseTags, issuedTag, assertSerialFree, resolveAssetNode, createAsset, updateAsset, archiveAsset, peekTag, importAssets };
