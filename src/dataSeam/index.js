// TEMPORARY database driver seam (D-48, PostgreSQL migration Slice 5B). It exists only while the app moves from SQLite to PostgreSQL
// and is REMOVED at the cutover: there is no permanent dual-database architecture. Do not build features on it.
//
//   DB_DRIVER unset, empty or 'sqlite'  SQLite (the default)
//   DB_DRIVER=pg                        PostgreSQL (Slice 5D): src/server.js opens the pool, migrates, installs the notifier, starts the sweep
//   anything else                       refused at startup
//
// `open({ driver, db })` returns the data modules with the database handle bound: `await data.reservations.create({...})`,
// `await data.waitlist.join({...})`, ... with no handle argument; non-database exports pass through unchanged. Routes migrated to the
// seam (listed in test/data-seam-ratchet.test.js) reach the database only through it.
//
// The 'pg' driver is `open({ driver: 'pg', pool })` -> `./pg.js`, a sibling of `./sqlite.js` that binds the PostgreSQL pool to the SAME
// names from src/pg/<module>.js (parallel exports and signatures, first argument `q`), so no route changes.
// ./pg.js is loaded only for the 'pg' driver: the SQLite driver must not load src/pg/* or the `pg` package (test/data-seam.test.js checks it).
// (The directory is `dataSeam`, not `data`: `.gitignore` ignores every path named `data`, the SQLite data directory.)
const DEFAULT_DRIVER = 'sqlite';
const DRIVERS = ['sqlite', 'pg'];

function driverError(message, code) {
  return Object.assign(new Error(message), { code });
}

// Reads DB_DRIVER (from `env`, default process.env) and returns the driver name, or throws a clear startup error.
function resolveDriver(env = process.env) {
  const raw = env.DB_DRIVER;
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '' || value === 'sqlite') return DEFAULT_DRIVER;
  if (value === 'pg') return 'pg';
  throw driverError(`DB_DRIVER="${value}" is not a known database driver. Unset it (or set DB_DRIVER=sqlite) to run on SQLite.`, 'DB_DRIVER_INVALID');
}

// The data modules bound to one database. `driver` is a name returned by resolveDriver; for 'sqlite', `db` is src/db.js's handle; for 'pg',
// `pool` is the node-postgres pool (src/pg/pool.js getPool()).
function open({ driver = resolveDriver(), db, pool } = {}) {
  if (!DRIVERS.includes(driver)) resolveDriver({ DB_DRIVER: driver }); // throws the same clear error for anything unknown
  return driver === 'pg' ? require('./pg').bind(pool) : require('./sqlite').bind(db);
}

module.exports = { DEFAULT_DRIVER, resolveDriver, open };
