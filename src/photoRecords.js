// Asset photo rows (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): only the database
// statements live here, unchanged; the upload handling (multer, sharp, the files on disk) stays in the routes. The database handle is
// the first argument, like the other data modules. Reached through the temporary driver seam (src/dataSeam). A PostgreSQL twin follows
// in Slice 5C.

// POST /api/assets/:id/photos, for each image that was converted: its row. Returns the new photo's id.
const addPhoto = (db, { assetId, filename, thumb, caption, uploadedBy }) => db.prepare('INSERT INTO photos (asset_id, filename, thumb, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)')
  .run(assetId, filename, thumb, caption, uploadedBy).lastInsertRowid;
// ... and after them, the asset counts as updated.
const touchAsset = (db, assetId) => { db.prepare("UPDATE assets SET updated_at = datetime('now') WHERE id = ?").run(assetId); };

// DELETE /api/photos/:id: the row, then (after the route removed the files) its deletion and the cover that pointed at it, as two
// statements exactly as before (no transaction).
const getPhoto = (db, id) => db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
function deletePhoto(db, id) {
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  db.prepare('UPDATE assets SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(id);
}

// PUT /api/assets/:id/cover: which asset a photo belongs to, and the cover itself (null clears it).
const photoAsset = (db, photoId) => db.prepare('SELECT asset_id FROM photos WHERE id = ?').get(photoId);
const setCover = (db, assetId, photoId) => { db.prepare('UPDATE assets SET cover_photo_id = ? WHERE id = ?').run(photoId, assetId); };

// /uploads: the photo a requested file (full size or thumbnail) belongs to.
const photoByFile = (db, file) => db.prepare('SELECT asset_id FROM photos WHERE filename = ? OR thumb = ?').get(file, file);

module.exports = { addPhoto, touchAsset, getPhoto, deletePhoto, photoAsset, setCover, photoByFile };
