// PostgreSQL connection pool (D-46, migration Slice 2). NOT used by the running app yet: nothing outside src/pg/ and
// the PG tests imports this module; the app still runs on SQLite (src/db.js).
//   - The pool is created lazily on first use, from DATABASE_URL. Without DATABASE_URL it falls back to the local
//     Docker dev database (docker-compose.postgres.yml) — never in production, where DATABASE_URL is required.
//   - Every session runs with TimeZone=UTC (sent as a startup option, so it beats any server/database default).
//   - int8 values (COUNT(*), SUM over integers, bigint columns) come back as JS numbers, like better-sqlite3 returns
//     them, instead of node-pg's default strings. A value outside Number's safe-integer range fails the query
//     rather than silently losing precision.
const { Pool, types } = require('pg');
const { DEV_DATABASE_URL } = require('./local-url');

const INT8_OID = 20;

function parseInt8(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  return n;
}

const TYPE_OVERRIDES = {
  getTypeParser(oid, format) {
    if (oid === INT8_OID && format !== 'binary') return parseInt8;
    return types.getTypeParser(oid, format);
  },
};

const POOL_DEFAULTS = {
  max: 10,                        // the app is small; Railway's starter PostgreSQL allows far more connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // fail fast instead of hanging a request when the database is unreachable
};

// DATABASE_URL wins. Without it: the local dev database, except in production (fail loudly instead of guessing).
function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production (the local dev database default is for development only).');
  return DEV_DATABASE_URL;
}

// A new, independent pool for `connectionString`. The app uses getPool(); tests create one pool per test database.
function createPool(connectionString, overrides = {}) {
  const pool = new Pool({
    ...POOL_DEFAULTS,
    ...overrides,
    connectionString,
    options: '-c TimeZone=UTC',
    types: TYPE_OVERRIDES,
  });
  // An idle client losing its connection (server restart, network blip) must not crash the process; the pool
  // discards that client and the next checkout opens a fresh connection.
  pool.on('error', (err) => console.error(`PostgreSQL pool: idle client error: ${err.message}`));
  return pool;
}

let shared = null;

function getPool() {
  if (!shared) shared = createPool(resolveDatabaseUrl());
  return shared;
}

// Shorthand for a single statement outside any transaction.
function query(text, params) {
  return getPool().query(text, params);
}

// Ends the shared pool (if it was ever created). A later getPool() creates a new one.
async function close() {
  if (!shared) return;
  const pool = shared;
  shared = null;
  await pool.end();
}

module.exports = { getPool, createPool, query, close, resolveDatabaseUrl, parseInt8 };
