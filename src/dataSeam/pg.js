// TEMPORARY (D-48): the PostgreSQL side of the database driver seam (see ./index.js). Removed at the PostgreSQL cutover.
//
// Binds the pool to the SAME module and function names as the SQLite side (src/dataSeam/sqlite.js MODULES is the one list of them;
// test/pg/seam-parity.test.js checks that every name has an async twin in src/pg/<module>.js with the same pure exports). A bound
// function is `(...args) => twin(pool, ...args)`: it returns the twin's own promise, so a rejection carries the twin's error unchanged
// (status, code, message), and each twin opens its own transaction / takes its own asset lock as it was written to (5C), with the POOL
// as the executor. Pure exports (constants, validators, ...) are read through from the twin, as they are from the SQLite module.
//
// Not bound, on purpose (no route calls them through the seam; test/pg/seam-parity.test.js KNOWN_DIFFERENCES): `reservations.sendRecorded`
// (absent on PostgreSQL: the after-commit `request_recorded` effect sends that email) and `waitlist.announceJoined` (synchronous there).
const { MODULES } = require('./sqlite');

const NOT_BOUND = new Set(['reservations.sendRecorded', 'waitlist.announceJoined']);

function bindModule(pool, name, dbFunctions) {
  const twin = require(`../pg/${name}`);
  const out = {};
  for (const key of Object.keys(twin)) {
    if (dbFunctions.includes(key)) continue;
    // pure export: read through to the twin (a getter, so it is always the twin's current value)
    Object.defineProperty(out, key, { enumerable: true, get: () => twin[key] });
  }
  for (const fn of dbFunctions) {
    if (NOT_BOUND.has(`${name}.${fn}`)) continue;
    if (typeof twin[fn] !== 'function') throw new Error(`data seam: ${name}.${fn} is not a function of src/pg/${name}.js`);
    Object.defineProperty(out, fn, { enumerable: true, value: (...args) => twin[fn](pool, ...args) });
  }
  return Object.freeze(out);
}

function bind(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('data seam: the PostgreSQL driver needs a node-postgres pool (src/pg/pool.js getPool())');
  }
  const data = { driver: 'pg' };
  for (const [name, [, dbFunctions]] of Object.entries(MODULES)) data[name] = bindModule(pool, name, dbFunctions);
  return Object.freeze(data);
}

module.exports = { bind, NOT_BOUND };
