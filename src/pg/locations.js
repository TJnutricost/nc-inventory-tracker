// Managed locations on PostgreSQL: the twin of src/locations.js (read that header). Same names, first argument `q` (a pool or a
// transaction client); each write is ONE transaction with the `locations` settings row locked first, so two edits of the list never
// overwrite each other.
const { getSettings, setSetting } = require('./settings');
const { withTransaction, isInTransaction } = require('./transaction');
const { asciiKey, overviewFrom } = require('../locations'); // (pure)

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const MAX = 80;
function cleanName(v) {
  const name = String(v ?? '').trim();
  if (!name) throw httpError(400, 'Enter a location name.');
  if (name.length > MAX) throw httpError(400, `A location name can be at most ${MAX} characters.`);
  if (/[\r\n\t]/.test(name)) throw httpError(400, 'A location name is a single line of text.');
  return name;
}
const usedBy = (n) => `${n} asset${n === 1 ? '' : 's'}`;

const usageRows = async (q) => (await q.query("SELECT lower(trim(location)) AS k, MIN(trim(location)) AS name, COUNT(*)::int AS n FROM assets WHERE trim(location) <> '' GROUP BY lower(trim(location))")).rows;
const overview = async (q) => overviewFrom((await getSettings(q)).locations, await usageRows(q));
const lockList = (c) => c.query("SELECT value FROM settings WHERE key = 'locations' FOR UPDATE");

async function add(q, { name }) {
  const n = cleanName(name);
  return inTransaction(q, async (c) => {
    await lockList(c);
    const list = (await getSettings(c)).locations;
    if (list.some((l) => asciiKey(l) === asciiKey(n))) throw httpError(400, `A location named ${list.find((l) => asciiKey(l) === asciiKey(n))} already exists.`);
    await setSetting(c, 'locations', [...list, n]);
    return overview(c);
  });
}

async function rename(q, { from, to }) {
  const n = cleanName(to);
  return inTransaction(q, async (c) => {
    await lockList(c);
    const list = (await getSettings(c)).locations;
    const i = list.findIndex((l) => asciiKey(l) === asciiKey(from));
    if (i < 0) throw httpError(404, 'That location is not in the list.');
    if (list.some((l, j) => j !== i && asciiKey(l) === asciiKey(n))) throw httpError(400, `A location named ${list.find((l, j) => j !== i && asciiKey(l) === asciiKey(n))} already exists.`);
    const next = list.slice(); next[i] = n;
    await setSetting(c, 'locations', next);
    await c.query('UPDATE assets SET location = $1 WHERE lower(trim(location)) = $2', [n, asciiKey(from)]);
    return overview(c);
  });
}

async function remove(q, { name }) {
  return inTransaction(q, async (c) => {
    await lockList(c);
    const list = (await getSettings(c)).locations;
    const i = list.findIndex((l) => asciiKey(l) === asciiKey(name));
    if (i < 0) throw httpError(404, 'That location is not in the list.');
    const used = (await c.query('SELECT COUNT(*)::int AS n FROM assets WHERE lower(trim(location)) = $1', [asciiKey(list[i])])).rows[0].n;
    if (used) throw httpError(409, `${list[i]} is used by ${usedBy(used)}. Reassign ${used === 1 ? 'that asset' : 'those assets'} to another location first, then remove it.`);
    await setSetting(c, 'locations', list.filter((_, j) => j !== i));
    return overview(c);
  });
}

module.exports = { asciiKey, overviewFrom, overview, add, rename, remove };
