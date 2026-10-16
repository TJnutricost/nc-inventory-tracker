// Asset photo rows on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/photoRecords.js. NOT used by the running app
// yet (Slice 5D binds it to the driver seam under the same names). Only the database statements live here; the upload handling
// (multer, sharp, the files on disk) stays in the routes. Same names, parallel signatures, same rows; async, executor `q` first.
//
// Differences from SQLite (output identical): `?` -> `$n`, lastInsertRowid -> RETURNING id, datetime('now') -> NOW (src/pg/time.js);
// ids that are not integers in the column's range find nothing (as on SQLite) instead of raising a PostgreSQL 22P02.
//
// The cover race (carry-over (t)/(x) style, closed here). PUT /api/assets/:id/cover checks `photoAsset` (the photo exists and is this
// asset's) and then calls `setCover`; DELETE /api/photos/:id deletes the row and then clears any cover that pointed at it. On
// synchronous SQLite each route ran in one event-loop turn, so a delete could never land between the cover check and its write. On
// PostgreSQL it could, leaving `cover_photo_id` pointing at a deleted photo (there is no FK on it). So both writes serialize on the
// ASSET lock (src/pg/transaction.js lockAsset, the Slice 2 ordering rule: the asset row first):
//   - setCover(q, assetId, photoId) with a photo: lockAsset(assetId), then re-checks the photo under the lock (gone -> 404
//     'Photo not found', another asset's -> 400 'That photo belongs to a different asset': the route's own messages), then writes.
//     Clearing the cover (null) needs no check and takes no lock (one UPDATE, as before).
//   - deletePhoto(q, id): learns the photo's asset (one unlocked read), lockAsset, then the DELETE and the cover clear in ONE
//     transaction (on SQLite two statements, no transaction; nothing observable changes except that a crash can no longer leave
//     the cover pointing at a deleted row). A photo that does not exist: the two statements run as before (they change nothing).
//   Both join a caller's transaction when given its client (the src/pg pattern: isInTransaction(q) ? run(q) : withTransaction(run, q)).
//   The asset lock can answer 503 ASSET_BUSY (lock timeout) and 404 ASSET_NOT_FOUND (an asset that does not exist; SQLite's UPDATE
//   simply changed nothing; the route has already loaded the asset).
const { withTransaction, lockAsset, isInTransaction } = require('./transaction');
const { NOW } = require('./time');
const { toId } = require('./reservations');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));

// POST /api/assets/:id/photos, for each image that was converted: its row. Returns the new photo's id.
const addPhoto = async (q, { assetId, filename, thumb, caption, uploadedBy }) => Number((await q.query(
  'INSERT INTO photos (asset_id, filename, thumb, caption, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
  [assetId, filename, thumb, caption ?? null, uploadedBy ?? null])).rows[0].id);
// ... and after them, the asset counts as updated.
const touchAsset = async (q, assetId) => { await q.query(`UPDATE assets SET updated_at = ${NOW} WHERE id = $1`, [toId(assetId)]); };

// DELETE /api/photos/:id: the row, then (after the route removed the files) its deletion and the cover that pointed at it.
const getPhoto = async (q, id) => (await q.query('SELECT * FROM photos WHERE id = $1', [toId(id)])).rows[0];
async function deletePhoto(q, id) {
  const photoId = toId(id);
  return inTransaction(q, async (c) => {
    const owner = (await c.query('SELECT asset_id FROM photos WHERE id = $1', [photoId])).rows[0];
    if (owner) await lockAsset(c, owner.asset_id);
    await c.query('DELETE FROM photos WHERE id = $1', [photoId]);
    await c.query('UPDATE assets SET cover_photo_id = NULL WHERE cover_photo_id = $1', [photoId]);
  });
}

// PUT /api/assets/:id/cover: which asset a photo belongs to, and the cover itself (null clears it).
const photoAsset = async (q, photoId) => (await q.query('SELECT asset_id FROM photos WHERE id = $1', [toId(photoId)])).rows[0];
async function setCover(q, assetId, photoId) {
  if (photoId === null || photoId === undefined) {
    await q.query('UPDATE assets SET cover_photo_id = $1 WHERE id = $2', [null, toId(assetId)]);
    return;
  }
  await inTransaction(q, async (c) => {
    const asset = await lockAsset(c, assetId);
    const photo = (await c.query('SELECT asset_id FROM photos WHERE id = $1', [toId(photoId)])).rows[0];
    if (!photo) throw httpError(404, 'Photo not found');
    if (photo.asset_id !== asset.id) throw httpError(400, 'That photo belongs to a different asset');
    await c.query('UPDATE assets SET cover_photo_id = $1 WHERE id = $2', [photoId, asset.id]);
  });
}

// /uploads: the photo a requested file (full size or thumbnail) belongs to. (`ORDER BY id LIMIT 1`: SQLite's .get() returns the
// first row in rowid order; file names are unique in practice.)
const photoByFile = async (q, file) => (await q.query('SELECT asset_id FROM photos WHERE filename = $1 OR thumb = $1 ORDER BY id LIMIT 1', [file])).rows[0];

module.exports = { addPhoto, touchAsset, getPhoto, deletePhoto, photoAsset, setCover, photoByFile };
