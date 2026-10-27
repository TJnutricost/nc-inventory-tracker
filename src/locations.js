// Managed locations (SQLite). The list is the existing `locations` setting (a JSON array in the settings table, read by every Location
// field through /api/settings and /api/me); assets keep their free-text `location` column, so no schema changes. A location is "used" by
// the assets whose trimmed location equals its name ignoring ASCII letter case (the same rule on both engines: lower() folds ASCII only,
// like asciiKey below). Everything here is ONE transaction: the setting and, on a rename, every asset row that carried the old name.
// The PostgreSQL twin is src/pg/locations.js (same names, first argument `q`).
const { getSettings, setSetting } = require('./settings');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const asciiKey = (s) => String(s).trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
const MAX = 80;
function cleanName(v) {
  const name = String(v ?? '').trim();
  if (!name) throw httpError(400, 'Enter a location name.');
  if (name.length > MAX) throw httpError(400, `A location name can be at most ${MAX} characters.`);
  if (/[\r\n\t]/.test(name)) throw httpError(400, 'A location name is a single line of text.');
  return name;
}
const usedBy = (n) => `${n} asset${n === 1 ? '' : 's'}`;

// { locations: [{ name, count }] in the managed order, unlisted: [{ name, count }] } where unlisted are locations some asset carries
// that are not in the list (older free-text values): kept as they are, and offered for adding to the list.
function overviewFrom(list, rows) {
  const counts = new Map(rows.map((r) => [r.k, r]));
  const listed = new Set(list.map(asciiKey));
  return {
    locations: list.map((name) => ({ name, count: counts.get(asciiKey(name))?.n ?? 0 })),
    unlisted: rows.filter((r) => !listed.has(r.k)).map((r) => ({ name: r.name, count: r.n })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}
const usageRows = (db) => db.prepare("SELECT lower(trim(location)) AS k, MIN(trim(location)) AS name, COUNT(*) AS n FROM assets WHERE trim(location) <> '' GROUP BY lower(trim(location))").all();
const overview = (db) => overviewFrom(getSettings(db).locations, usageRows(db));

function add(db, { name }) {
  const n = cleanName(name);
  return db.transaction(() => {
    const list = getSettings(db).locations;
    if (list.some((l) => asciiKey(l) === asciiKey(n))) throw httpError(400, `A location named ${list.find((l) => asciiKey(l) === asciiKey(n))} already exists.`);
    setSetting(db, 'locations', [...list, n]);
    return overview(db);
  }).immediate();
}

// Renames in place (the order is kept) and rewrites every asset that carried the old name, archived ones included, so no asset is left behind.
function rename(db, { from, to }) {
  const n = cleanName(to);
  return db.transaction(() => {
    const list = getSettings(db).locations;
    const i = list.findIndex((l) => asciiKey(l) === asciiKey(from));
    if (i < 0) throw httpError(404, 'That location is not in the list.');
    if (list.some((l, j) => j !== i && asciiKey(l) === asciiKey(n))) throw httpError(400, `A location named ${list.find((l, j) => j !== i && asciiKey(l) === asciiKey(n))} already exists.`);
    const next = list.slice(); next[i] = n;
    setSetting(db, 'locations', next);
    db.prepare("UPDATE assets SET location = ? WHERE lower(trim(location)) = ?").run(n, asciiKey(from));
    return overview(db);
  }).immediate();
}

// Only a location no asset uses can go; otherwise 409 and nothing changes.
function remove(db, { name }) {
  return db.transaction(() => {
    const list = getSettings(db).locations;
    const i = list.findIndex((l) => asciiKey(l) === asciiKey(name));
    if (i < 0) throw httpError(404, 'That location is not in the list.');
    const used = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE lower(trim(location)) = ?").get(asciiKey(list[i])).n;
    if (used) throw httpError(409, `${list[i]} is used by ${usedBy(used)}. Reassign ${used === 1 ? 'that asset' : 'those assets'} to another location first, then remove it.`);
    setSetting(db, 'locations', list.filter((_, j) => j !== i));
    return overview(db);
  }).immediate();
}

module.exports = { asciiKey, overviewFrom, overview, add, rename, remove };
