// Serial number normalization (Phase 1 Foundation Closeout).
//
// The serial the user typed is kept for display; only SURROUNDING whitespace is removed and a blank value means "no
// serial" (NULL). Matching and uniqueness use `serialKey`: the same value, lower-cased. Nothing else is touched —
// hyphens, slashes, internal spaces and every other character are meaningful ("ABC-123" and "ABC123" are different).
//
// The key is computed here, in the application, and stored in assets.serial_normalized (plain UNIQUE index). It is
// deliberately NOT a database expression/collation (lower(serial), COLLATE NOCASE): SQLite's lower()/NOCASE are
// ASCII-only while PostgreSQL's are locale/Unicode aware, so a DB-side rule would behave differently after the
// PostgreSQL migration. A stored column with one JS rule means identical behavior on both.
const cleanSerial = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const serialKey = (v) => {
  const s = cleanSerial(v);
  return s === null ? null : s.toLowerCase();
};

module.exports = { cleanSerial, serialKey };
