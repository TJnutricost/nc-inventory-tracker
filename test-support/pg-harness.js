// Per-file PostgreSQL test database harness (D-46, migration Slice 2).
//
// Each test file creates its OWN throwaway database (nc_test_<16 hex>) on the LOCAL server, applies the PG baseline,
// and drops it on teardown, so test files can run in parallel (node --test runs files concurrently) without sharing
// state. Usage:
//   const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
//   describe('...', pgSuite(), () => {
//     let tdb;
//     before(async () => { tdb = await createTestDatabase(); });
//     after(async () => { await tdb?.drop(); });
//     ...tdb.pool / tdb.newPool() / tdb.url...
//   });
//
// Server URL: TEST_DATABASE_URL, else the local dev database (docker-compose.postgres.yml). DATABASE_URL is deliberately
// NOT read, so an exported Railway DATABASE_URL can never reach the tests.
// SAFETY: every create/drop/probe checks the URL with isLocalDatabaseUrl() (the same strict rule as `npm run db:check`:
// host exactly localhost/127.0.0.1/::1, postgres(ql): protocol, NO query parameters) BEFORE any connection is made, and
// drop only accepts names matching nc_test_<16 hex>, so it can never drop nc_assets_dev or any other database.
//
// Availability: with PostgreSQL unreachable, pgSuite() SKIPS the suite with a clear message (plain `npm test` passes
// without Docker). With NC_REQUIRE_PG=1 (`npm run test:pg`) it THROWS instead, so the run fails; it never skips.
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { DEV_DATABASE_URL, assertLocalDatabaseUrl } = require('../src/pg/local-url');
const { createPool } = require('../src/pg/pool');
const { runMigrations } = require('../src/pg/migrate');

const WHO = 'The PostgreSQL test harness';
const TEST_DB_NAME = /^nc_test_[0-9a-f]{16}$/;

function serverUrl(env = process.env) {
  return assertLocalDatabaseUrl(env.TEST_DATABASE_URL || DEV_DATABASE_URL, WHO);
}

function assertTestDatabaseName(name) {
  if (typeof name !== 'string' || !TEST_DB_NAME.test(name)) throw new Error(`${WHO} only creates/drops databases named nc_test_<16 hex>; refusing "${name}".`);
  return name;
}

// The URL of test database `name` on the same local server (same credentials), re-checked against the local rule.
function testDatabaseUrl(server, name) {
  assertTestDatabaseName(name);
  const u = new URL(assertLocalDatabaseUrl(server, WHO));
  u.pathname = `/${name}`;
  return assertLocalDatabaseUrl(u.toString(), WHO);
}

async function withServerClient(env, fn) {
  const client = new Client({ connectionString: serverUrl(env), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let probed = null;

// { ok: true } or { ok: false, reason }. Synchronous (a child process does the connecting) so test files can decide
// to skip while they register their tests. Refuses a non-local URL by throwing, without connecting.
function probePostgres(env = process.env) {
  if (probed && env === process.env) return probed;
  const url = serverUrl(env);
  const res = spawnSync(process.execPath, [path.join(__dirname, 'pg-probe.js'), url], { encoding: 'utf8', timeout: 15_000 });
  const result = res.status === 0
    ? { ok: true }
    : { ok: false, reason: (res.stderr || '').trim() || (res.error && res.error.message) || `probe exited with ${res.status}` };
  if (env === process.env) probed = result;
  return result;
}

function requirePostgres(env = process.env) {
  return env.NC_REQUIRE_PG === '1';
}

// Options for describe()/test(): run when PostgreSQL is reachable, otherwise skip (or throw under NC_REQUIRE_PG=1).
function pgSuite(env = process.env) {
  const p = probePostgres(env);
  if (p.ok) return {};
  if (requirePostgres(env)) throw new Error(`npm run test:pg requires the local PostgreSQL. ${p.reason}`);
  return { skip: `PostgreSQL tests skipped: ${p.reason} (npm run test:pg requires it)` };
}

// Creates nc_test_<random>, applies the PG migrations (unless migrate: false) and returns
//   { name, url, pool, newPool(overrides), drop() }.
// drop() ends every pool made through it and drops the database (WITH (FORCE)); it is safe to call more than once.
async function createTestDatabase({ migrate = true, env = process.env } = {}) {
  const server = serverUrl(env);
  const name = `nc_test_${crypto.randomBytes(8).toString('hex')}`;
  const url = testDatabaseUrl(server, name);
  await withServerClient(env, (c) => c.query(`CREATE DATABASE "${assertTestDatabaseName(name)}" TEMPLATE template0`));

  const pools = [];
  let dropped = false;
  const tdb = {
    name,
    url,
    pool: null,
    newPool(overrides) {
      const pool = createPool(url, overrides);
      pools.push(pool);
      return pool;
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      // pool.end() waits for checked-out clients, so a test that leaked one would hang teardown. Start the ends, drop
      // WITH (FORCE) (which terminates any remaining connection), then give the pools a moment to finish closing.
      const ending = Promise.all(pools.splice(0).map((p) => p.end().catch(() => {})));
      await dropTestDatabase(name, env);
      await Promise.race([ending, new Promise((r) => setTimeout(r, 1000).unref())]);
    },
  };
  tdb.pool = tdb.newPool();
  if (migrate) {
    try {
      await runMigrations(tdb.pool);
    } catch (err) {
      await tdb.drop().catch(() => {});
      throw err;
    }
  }
  return tdb;
}

async function dropTestDatabase(name, env = process.env) {
  assertTestDatabaseName(name);
  serverUrl(env);
  await withServerClient(env, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

// Names of nc_test_* databases currently on the local server (used by the harness's own isolation test).
async function listTestDatabases(env = process.env) {
  return withServerClient(env, async (c) => (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'nc\\_test\\_%' ORDER BY datname")).rows.map((r) => r.datname));
}

module.exports = {
  pgSuite,
  probePostgres,
  createTestDatabase,
  dropTestDatabase,
  listTestDatabases,
  testDatabaseUrl,
  assertTestDatabaseName,
  serverUrl,
};
