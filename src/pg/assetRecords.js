// Writing asset records on PostgreSQL (D-46, D-48, migration Slice 5C-5): the PG twin of src/assetRecords.js (tag issuance, the
// serial check, the catalog entry of an asset write, create / edit / archive, the next-tag preview and the CSV import). NOT used by
// the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures, the same return
// values and the same errors (status + message); async, executor `q` first. The route's checks before each call and its emails stay
// in the routes, exactly as on SQLite.
//
// Pure exports: FLAGS, ASSET_FIELDS and formatTag are repeated here (src/assetRecords.js loads the SQLite data modules, which a twin
// must not import); test/pg/pg-asset-records.test.js checks they equal the SQLite ones.
//
// Differences from SQLite (outcomes identical unless listed):
//   - `?` -> `$n`; `datetime('now')` -> NOW (src/pg/time.js).
//   - Tags are COLLATE NOCASE on SQLite: every tag lookup is `lower(tag) = lower($1 COLLATE "C")` (carry-over (ap): under "C",
//     lower() folds ASCII letters only, like NOCASE; the unique index assets_tag_lower_key serves it).
//   - Numbers: a NaN binds as NULL (better-sqlite3 binds NaN as NULL; node-pg would send 'NaN', which a double column stores) and -0
//     as 0 (what SQLite returns). A license_seats value that is not a whole number in integer range (2.5, 1e10: SQLite stores it as
//     REAL / a big integer) cannot be stored in the PostgreSQL integer column: the statement fails (a 500; the whole CSV import is
//     rolled back). Only reachable with a hand-made request or a CSV cell like "2.5" seats; accepted for 5D like (as) / (at) unless
//     the owner decides otherwise. Text containing a NUL character (any field, or a tag) fails the same way ((as) / (at)).
//   - updateAsset on an id with no row: no lock is possible, the serial check and the UPDATE run as on SQLite (0 rows, no error).
//
// Transactions and locks (carry-overs (v), (x), (ai)). Each write is ONE transaction: the caller's when `q` is a transaction client,
// else its own (isInTransaction(q) ? run(q) : withTransaction(run, q)); any error rolls back everything (no asset row, no counter
// movement, no activity row).
//   createAsset   the tag counter claim (UPDATE asset_tag_counter ... RETURNING: the row lock serializes every blank-tag create and
//                 import until COMMIT, so two can never get the same number) -> the tag / serial checks -> INSERT -> activity row.
//                 A new row has nothing to lock. Uniqueness is enforced by the unique indexes (assets_tag_lower_key,
//                 idx_assets_serial_normalized), never by the pre-check alone: the INSERT runs under a SAVEPOINT; a concurrent create
//                 that committed the same tag / serial first makes it fail with 23505, the savepoint is rolled back and the checks
//                 are run again, now seeing the committed row: the same readable 400 SQLite gives the second create. An ISSUED
//                 (blank-tag) number that a concurrent explicit-tag create took meanwhile is simply skipped (the claim is retried,
//                 as allocateTag skips taken numbers), so the counter ends where SQLite's would.
//   updateAsset   lockAsset (the 5A timeout: 503 ASSET_BUSY) -> the serial check -> UPDATE, with the same SAVEPOINT backstop for a
//                 serial another asset's write committed meanwhile (the route's other pre-reads stay route-level for 5D, (ah)).
//   archiveAsset  lockAsset -> the row as locked (404 / already archived) -> its open assignments (carry-over (x): a check-out
//                 waits on the same lock, so it can't slip in between) -> UPDATE + activity row.
//   peekTag       a plain read (consumes nothing; may differ from the number a later create claims, as on SQLite).
//   importAssets  the WHOLE file and the active-employee read are ONE transaction (carry-over (ai)). It takes, in this order, the
//                 tag counter row (FOR UPDATE: claims nothing, so a rollback leaves it unchanged) and LOCK TABLE assets IN EXCLUSIVE
//                 MODE: plain reads go on, every other writer of asset rows (and every lockAsset, and the foreign-key checks of rows
//                 that reference an asset) waits until the import ends, which is what SQLite's single writer did. So no tag, serial,
//                 open assignment or catalog link it reads can change under it, and it needs no per-row pre-locks (rows can name
//                 assets in any order). The asset rows it assigns are still locked with lockAsset first (never waits: the table
//                 lock already excludes everyone). Per-row problems are reported in `errors` exactly as on SQLite; anything that
//                 throws (a database error, a NUL, an unstorable number, a 503) rolls the whole file back: no asset, assignment or
//                 activity row, no counter movement. A 23505 cannot happen inside it (no concurrent writer).
// Lock order: tag counter row -> assets (table lock for the import; one asset row for update / archive) -> that asset's dependent rows.
// No path takes an asset row and then the counter, and the import takes both before anything else, so it cannot deadlock against
// createAsset (counter, then its new row), the asset-locked writes (one asset row, then its assignments / reservations / waitlist /
// requests: 4B, 4C, 5C-4 approve, 5C-5 check-in and custody) or the catalog edits (5C-1: catalog table lock, then asset rows; the import
// only takes KEY SHARE on catalog rows). A waiting import holds one pool connection (as any lock wait). Remaining (no wrong write):
// two writers that insert the same tag AND the same serial crosswise can deadlock on the two unique indexes; PostgreSQL aborts one
// (a 500, rolled back).
const catalog = require('./catalog');
const { cleanSerial, serialKey } = require('../serial');
const { openAssignments } = require('./assetViews');
const { log } = require('./activityLog');
const { refreshStatus } = require('./assignments');
const { getSettings } = require('./settings');
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');
const { NOW } = require('./time');
const { toId } = require('./reservations');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim()); // (server.js `clean`)
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
// A value as better-sqlite3 would store it: NaN -> NULL, -0 -> 0 (see the header).
const bind = (v) => (typeof v === 'number' && (Number.isNaN(v) || Object.is(v, -0)) ? (Number.isNaN(v) ? null : 0) : v);

// The two per-asset reservation settings, and the editable asset fields (the same lists as src/assetRecords.js).
const FLAGS = ['available_to_request', 'reservation_requires_approval'];
const ASSET_FIELDS = ['name', 'category', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor',
  'warranty_expires', 'license_key', 'license_seats', 'license_expires', 'notes'];

const TAG_IS = 'lower(tag) = lower($1 COLLATE "C")';
const TAG_KEY = 'assets_tag_lower_key';
const SERIAL_KEY = 'idx_assets_serial_normalized';

// ---- asset tag issuance (see src/assetRecords.js) ----
const formatTag = (prefix, n) => prefix + String(n).padStart(5, '0');
const tagExists = async (q, tag) => (await q.query(`SELECT 1 FROM assets WHERE ${TAG_IS}`, [tag])).rowCount > 0;
async function allocateTag(q, prefix) { // call only inside a transaction (the counter row stays locked until it ends)
  for (;;) {
    const n = (await q.query('UPDATE asset_tag_counter SET last_number = last_number + 1 WHERE id = 1 RETURNING last_number AS n')).rows[0].n;
    const tag = formatTag(prefix, n);
    if (!(await tagExists(q, tag))) return tag; // skip numbers already taken by manually chosen tags
  }
}

// Labels printed before the asset exists (see src/assetRecords.js): `count` numbers claimed in ONE transaction (a caller's when given its
// client); the counter row stays locked until it ends, so two claims (or a claim and a blank-tag create) never share a number.
async function claimTags(q, { prefix, count }) {
  return inTransaction(q, async (c) => {
    const tags = [];
    for (let i = 0; i < count; i++) tags.push(await allocateTag(c, prefix));
    return tags;
  });
}
// Give back a Create labels sheet (see src/assetRecords.js releaseTags): ONE transaction with the counter row locked first, so a claim or
// a blank-tag create running at the same moment either finishes first (then these are no longer the newest: refused) or waits.
async function releaseTags(q, { prefix, tags }) {
  return inTransaction(q, async (c) => {
    const nums = tags.map((t) => issuedNumber(prefix, t));
    if (!nums.length || nums.includes(null)) return { released: false, reason: 'not_ours' };
    const last = (await c.query('SELECT last_number AS n FROM asset_tag_counter WHERE id = 1 FOR UPDATE')).rows[0].n;
    if (Math.max(...nums) !== last) return { released: false, reason: 'newer' };
    for (const n of nums) if (await tagExists(c, formatTag(prefix, n))) return { released: false, reason: 'used' };
    await c.query('UPDATE asset_tag_counter SET last_number = $1 WHERE id = 1', [Math.min(...nums) - 1]);
    return { released: true };
  });
}
// One of our claimed, still unused labels (see src/assetRecords.js): the tag as issued, else null. A plain read.
async function issuedTag(q, code) {
  const prefix = (await getSettings(q)).tag_prefix;
  const n = issuedNumber(prefix, code);
  if (n === null || n > (await q.query('SELECT last_number AS n FROM asset_tag_counter WHERE id = 1')).rows[0].n) return null;
  const tag = formatTag(prefix, n);
  return (await tagExists(q, tag)) ? null : tag;
}
// (pure; repeated from src/assetRecords.js like formatTag)
function issuedNumber(prefix, code) {
  const c = String(code ?? '').trim();
  const digits = c.slice(prefix.length);
  if (c.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase() || !/^\d{1,9}$/.test(digits)) return null;
  const n = Number(digits);
  return n >= 1 && formatTag(prefix, n).toUpperCase() === c.toUpperCase() ? n : null;
}

// Serials are unique across the whole inventory (archived assets included), ignoring surrounding whitespace and letter case
// (src/serial.js: the key is computed in JS and stored, so both engines compare the same text exactly).
async function assertSerialFree(q, serial, exceptAssetId = null) {
  const key = serialKey(serial);
  if (key === null) return;
  const other = (await q.query('SELECT id, tag, archived_at FROM assets WHERE serial_normalized = $1', [key])).rows.find((o) => o.id !== exceptAssetId);
  if (other) throw httpError(400, `Serial number ${cleanSerial(serial)} is already used by asset ${other.tag}${other.archived_at ? ' (archived)' : ''}. Serial numbers must be unique, ignoring letter case and surrounding spaces.`);
}

// The catalog entry for an asset write (see src/assetRecords.js).
async function resolveAssetNode(q, body, current) {
  if (!('catalog_node_id' in body)) return current ?? null;
  const raw = body.catalog_node_id;
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || !(await catalog.loadIndex(q)).nodes.has(id)) throw httpError(400, 'Choose a valid catalog entry');
  if (id !== (current ?? null) && !(await catalog.isLive(q, id))) throw httpError(400, 'That catalog entry is archived. Choose an active one.');
  return id;
}

const tagUsedError = (tag, used) => httpError(400, used.archived_at ? `Tag ${tag} belongs to an archived asset and can't be reused` : `Tag ${tag} is already used by another asset`);
const tagRow = async (c, tag) => (await c.query(`SELECT archived_at FROM assets WHERE ${TAG_IS}`, [tag])).rows[0];

// Runs `write` under a savepoint. A unique violation (23505) means a concurrent transaction committed the same tag / serial first:
// the savepoint is rolled back (the transaction stays usable) and `recheck(constraint)` runs the readable check again, which now sees
// the committed row and throws SQLite's 400 (or returns 'retry'). If it finds nothing, the original error is rethrown.
async function underSavepoint(c, write, recheck) {
  await c.query('SAVEPOINT asset_write');
  try {
    const out = await write();
    await c.query('RELEASE SAVEPOINT asset_write');
    return { out };
  } catch (err) {
    if (err.code !== '23505') throw err;
    await c.query('ROLLBACK TO SAVEPOINT asset_write');
    if ((await recheck(err.constraint)) === 'retry') return { retry: true };
    throw err;
  }
}

// POST /api/assets: see the header. `tag` is the tag the body asked for (cleaned; null = issue the next one with `tagPrefix`).
// Returns the new asset's id.
async function createAsset(q, { tag: sentTag, tagPrefix, status, nodeId, flags, v, actorAccountId }) {
  const cols = ['tag', 'status', 'serial_normalized', 'catalog_node_id', ...FLAGS, ...ASSET_FIELDS];
  return inTransaction(q, async (c) => {
    for (;;) {
      let tag = null;
      const step = await underSavepoint(c, async () => {
        tag = sentTag || await allocateTag(c, tagPrefix);
        const used = await tagRow(c, tag);
        if (used) throw tagUsedError(tag, used);
        await assertSerialFree(c, v.serial);
        return (await c.query(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
          [tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f])].map(bind))).rows[0].id;
      }, async (constraint) => {
        if (constraint === TAG_KEY) {
          if (!sentTag) return 'retry'; // an issued number taken meanwhile by an explicit tag: claim the next one
          const used = await tagRow(c, tag);
          if (used) throw tagUsedError(tag, used);
        }
        if (constraint === SERIAL_KEY) await assertSerialFree(c, v.serial);
        return null;
      });
      if (step.retry) continue;
      await log(c, step.out, actorAccountId, 'created', `${tag} · ${v.name}`);
      return step.out;
    }
  });
}

// The asset row lock for an existing asset: 404 when there is no such asset (lockAsset's ASSET_NOT_FOUND), 503 ASSET_BUSY unchanged.
async function lockOr404(c, id) {
  const key = toId(id);
  if (key === null || key < 1) throw httpError(404, 'Asset not found');
  try {
    return await lockAsset(c, key);
  } catch (err) {
    if (err.code === 'ASSET_NOT_FOUND') throw httpError(404, 'Asset not found');
    throw err;
  }
}

// PUT /api/assets/:id: see the header (the route logs the edit and refreshes the status after it, as before).
async function updateAsset(q, { id, tag, status, nodeId, flags, v }) {
  return inTransaction(q, async (c) => {
    const key = toId(id);
    if (key !== null && key >= 1) {
      try {
        await lockAsset(c, key);
      } catch (err) {
        if (err.code !== 'ASSET_NOT_FOUND') throw err; // (no row: SQLite updates nothing and says nothing; so does this)
      }
    }
    await underSavepoint(c, async () => {
      await assertSerialFree(c, v.serial, id);
      await c.query(`UPDATE assets SET tag = $1, status = $2, serial_normalized = $3, catalog_node_id = $4, ${FLAGS.map((f, i) => `${f} = $${i + 5}`).join(', ')}, ${ASSET_FIELDS.map((f, i) => `${f} = $${i + 5 + FLAGS.length}`).join(', ')}, updated_at = ${NOW} WHERE id = $${5 + FLAGS.length + ASSET_FIELDS.length}`,
        [tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f]), key].map(bind));
    }, async (constraint) => {
      if (constraint === SERIAL_KEY) await assertSerialFree(c, v.serial, id);
      return null;
    });
  });
}

// POST /api/assets/:id/archive (and its DELETE alias): see the header. The checks run on the row as locked.
async function archiveAsset(q, id, { actorAccountId, reason }) {
  const key = toId(Number(id));
  return inTransaction(q, async (c) => {
    const a = await lockOr404(c, key);
    if (a.archived_at) throw httpError(400, 'This asset is already archived.');
    if ((await openAssignments(c, a.id)).length) throw httpError(400, 'Check this asset in before archiving it.');
    await c.query(`UPDATE assets SET archived_at = ${NOW}, updated_at = ${NOW} WHERE id = $1`, [a.id]);
    await log(c, a.id, actorAccountId, 'archived', `${a.tag} · ${a.name}${reason ? ` · ${reason}` : ''}`);
  });
}

// GET /api/next-tag. Preview only: consumes nothing (the `tag_prefix` setting is read here, as on SQLite).
async function peekTag(q) {
  const prefix = (await getSettings(q)).tag_prefix;
  let n = (await q.query('SELECT last_number AS n FROM asset_tag_counter WHERE id = 1')).rows[0].n + 1;
  while (await tagExists(q, formatTag(prefix, n))) n++;
  return formatTag(prefix, n);
}

// POST /api/import/assets: see the header and src/assetRecords.js importAssets (`rows` = the file's data rows in order, each
// { o: the row by column name, v: the validated fields }; "Row N" counts the header as row 1). Returns { created, updated, errors }.
async function importAssets(q, { rows, actorAccountId }) {
  return inTransaction(q, async (c) => {
    let created = 0, updated = 0; const errors = [];
    await c.query('SELECT last_number FROM asset_tag_counter WHERE id = 1 FOR UPDATE');
    await c.query('LOCK TABLE assets IN EXCLUSIVE MODE');
    // assigned_email matches an active employee by work email (or their login email); a later employee wins a shared key, in id order
    // (SQLite scans employees in rowid order: measured).
    const users = new Map();
    for (const u of (await c.query("SELECT e.id, e.name, e.work_email, a.login_email FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id WHERE e.status = 'active' ORDER BY e.id")).rows) {
      for (const k of [u.work_email, u.login_email]) if (k) users.set(k.toLowerCase(), u);
    }
    for (let idx = 0; idx < rows.length; idx++) {
      const { o, v } = rows[idx];
      const tag = clean(o.tag);
      const existing = tag ? (await c.query(`SELECT * FROM assets WHERE ${TAG_IS}`, [tag])).rows[0] : null;
      if (existing && existing.archived_at) { errors.push(`Row ${idx + 2}: tag ${tag} belongs to an archived asset — skipped`); continue; }
      if (!v.name && !existing) { errors.push(`Row ${idx + 2}: missing name`); continue; }
      if (!existing) { v.category = v.category || 'Other'; v.condition = v.condition || 'Good'; }
      // A serial that belongs to a different asset (already in the inventory, archived or not, or earlier in this file) skips just
      // this row; an update that leaves the serial blank keeps the stored one.
      try {
        await assertSerialFree(c, v.serial, existing ? existing.id : null);
      } catch (e) {
        if (e.status === undefined) throw e;
        errors.push(`Row ${idx + 2}: ${e.message.split('. ')[0]} — skipped`); continue;
      }
      let id;
      if (existing) {
        await c.query(`UPDATE assets SET ${ASSET_FIELDS.map((f, i) => `${f} = COALESCE($${i + 1}, ${f})`).join(', ')}, serial_normalized = COALESCE($${ASSET_FIELDS.length + 1}, serial_normalized), updated_at = ${NOW} WHERE id = $${ASSET_FIELDS.length + 2}`,
          [...ASSET_FIELDS.map((f) => v[f]), serialKey(v.serial), existing.id].map(bind));
        id = existing.id; updated++;
      } else {
        const cols = ['tag', 'serial_normalized', ...ASSET_FIELDS];
        const newTag = tag || await allocateTag(c, (await getSettings(c)).tag_prefix);
        id = (await c.query(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
          [newTag, serialKey(v.serial), ...ASSET_FIELDS.map((f) => v[f])].map(bind))).rows[0].id;
        await log(c, id, actorAccountId, 'created', 'Imported from CSV'); created++;
        const home = clean(o.catalog_path) ? null : await catalog.findLiveByPath(c, v.category); // same default as a manual create (the category's root), unless the row named a path
        if (home) await c.query('UPDATE assets SET catalog_node_id = $1, category = $2 WHERE id = $3', [home, (await catalog.rootOf(c, home)).name, id]);
      }
      // catalog_path ("Laptop > Mac > MacBook Air") must match an active entry exactly (ignoring case/spacing); otherwise the row is
      // still imported but the link is left alone and the row is reported — nothing is guessed.
      const cpath = clean(o.catalog_path);
      if (cpath) {
        const nid = await catalog.findLiveByPath(c, cpath);
        if (nid) await c.query('UPDATE assets SET catalog_node_id = $1, category = $2 WHERE id = $3', [nid, (await catalog.rootOf(c, nid)).name, id]);
        else errors.push(`Row ${idx + 2}: catalog path “${cpath}” doesn't match an active catalog entry — imported without a catalog link`);
      }
      const em = clean(o.assigned_email)?.toLowerCase();
      if (em && users.has(em) && !(await openAssignments(c, id)).length) {
        const u = users.get(em);
        await lockAsset(c, id); // (the assignment rule: asset lock first; never waits under the table lock)
        await c.query("INSERT INTO assignments (asset_id, employee_id, assignment_type, checked_out_by, notes) VALUES ($1, $2, 'permanent', $3, $4)", [id, u.id, actorAccountId ?? null, 'Imported']);
        await refreshStatus(c, id);
        await log(c, id, actorAccountId, 'checked_out', `To ${u.name} (import)`, u.id);
      } else if (em && !users.has(em)) errors.push(`Row ${idx + 2}: no user with email ${em} — imported unassigned`);
    }
    return { created, updated, errors };
  });
}

module.exports = { FLAGS, ASSET_FIELDS, formatTag, issuedNumber, tagExists, allocateTag, claimTags, releaseTags, issuedTag, assertSerialFree, resolveAssetNode, createAsset, updateAsset, archiveAsset, peekTag, importAssets };
