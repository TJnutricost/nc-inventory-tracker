// TEMPORARY database driver seam (D-48, PostgreSQL migration Slice 5B). It exists only while the app moves from SQLite to PostgreSQL
// and is REMOVED at the cutover: there is no permanent dual-database architecture. Do not build features on it.
//
//   DB_DRIVER unset, empty or 'sqlite'  SQLite (the default and, until Slice 5D, the only working driver)
//   DB_DRIVER=pg                        refused at startup: the PostgreSQL driver is wired into the app in Slice 5D
//   anything else                       refused at startup
//
// `open({ driver, db })` returns the data modules with the database handle bound: `await data.reservations.create({...})`,
// `await data.waitlist.join({...})`, ... with no handle argument; non-database exports pass through unchanged. Routes migrated to the
// seam (listed in test/data-seam-ratchet.test.js) reach the database only through it.
//
// For Slice 5C/5D: the 'pg' driver becomes `open({ driver: 'pg', pool })` -> a `./pg.js` sibling of `./sqlite.js` that binds the
// PostgreSQL pool to the SAME names from src/pg/<module>.js (parallel exports and signatures, first argument `q`), so no route changes.
// Until then this directory must not load src/pg/* or the `pg` package (test/data-seam.test.js checks it).
// (The directory is `dataSeam`, not `data`: `.gitignore` ignores every path named `data`, the SQLite data directory.)
const DEFAULT_DRIVER = 'sqlite';

function driverError(message, code) {
  return Object.assign(new Error(message), { code });
}

// Reads DB_DRIVER (from `env`, default process.env) and returns the driver name, or throws a clear startup error.
function resolveDriver(env = process.env) {
  const raw = env.DB_DRIVER;
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '' || value === 'sqlite') return DEFAULT_DRIVER;
  if (value === 'pg') {
    throw driverError('DB_DRIVER=pg is not available yet: the PostgreSQL driver is wired into the app in PostgreSQL migration Slice 5D. '
      + 'Unset DB_DRIVER (or set DB_DRIVER=sqlite) to run on SQLite.', 'DB_DRIVER_NOT_WIRED');
  }
  throw driverError(`DB_DRIVER="${value}" is not a known database driver. Unset it (or set DB_DRIVER=sqlite) to run on SQLite.`, 'DB_DRIVER_INVALID');
}

// The data modules bound to one database. `driver` is a name returned by resolveDriver; for 'sqlite', `db` is src/db.js's handle.
function open({ driver = resolveDriver(), db } = {}) {
  if (driver !== DEFAULT_DRIVER) resolveDriver({ DB_DRIVER: driver }); // throws the same clear error for 'pg' and for anything unknown
  return require('./sqlite').bind(db);
}

module.exports = { DEFAULT_DRIVER, resolveDriver, open };
