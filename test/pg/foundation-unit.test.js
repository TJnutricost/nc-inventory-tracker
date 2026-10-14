// PostgreSQL foundation (D-46, Slice 2): checks that need NO database, so they run in plain `npm test` without Docker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');
const { isLocalDatabaseUrl, assertLocalDatabaseUrl, DEV_DATABASE_URL } = require('../../src/pg/local-url');
const { resolveDatabaseUrl, parseInt8 } = require('../../src/pg/pool');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const pgMigrations = require('../../src/pg/migrations');
const harness = require('../../test-support/pg-harness');
const { canon, globToRegex } = require('../../test-support/pg-parity');
const dbCheck = require('../../scripts/db-check');

const REMOTE_URLS = [
  'postgresql://u:p@db.example.com:5432/db',
  'postgresql://postgres:secret@roundhouse.proxy.rlwy.net:12345/railway',
  'postgresql://postgres:secret@postgres.railway.internal:5432/railway',
  'postgresql://u:p@localhost.evil.com:5432/db',
  'postgresql://u:p@localhost/db?host=remote.example.com',
  'postgresql://u:p@127.0.0.1/db?hostaddr=10.0.0.5',
  'postgresql://u:p@localhost/db?sslmode=disable',
  'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/db',
  'postgresql:///db',
  'not a url',
];

// Counts every pg connection attempt made while fn runs (Client.connect is what Pool uses too).
async function countConnects(fn) {
  const original = pg.Client.prototype.connect;
  let calls = 0;
  pg.Client.prototype.connect = function patched(...args) { calls++; return original.apply(this, args); };
  try {
    await fn();
  } finally {
    pg.Client.prototype.connect = original;
  }
  return calls;
}

test('db-check and the PG tooling share one local-only rule', () => {
  assert.equal(dbCheck.isLocalDatabaseUrl, isLocalDatabaseUrl);
  assert.equal(dbCheck.DEFAULT_URL, DEV_DATABASE_URL);
  assert.equal(isLocalDatabaseUrl(DEV_DATABASE_URL), true);
  for (const url of REMOTE_URLS) {
    assert.equal(isLocalDatabaseUrl(url), false, url);
    assert.throws(() => assertLocalDatabaseUrl(url, 'X'), /X refuses to connect/, url);
  }
});

test('the test harness refuses remote/Railway-style URLs for create, drop and probe, before any connection', async () => {
  for (const url of REMOTE_URLS) {
    const env = { TEST_DATABASE_URL: url };
    const calls = await countConnects(async () => {
      await assert.rejects(harness.createTestDatabase({ env }), /refuses to connect/, url);
      await assert.rejects(harness.dropTestDatabase('nc_test_0123456789abcdef', env), /refuses to connect/, url);
      assert.throws(() => harness.probePostgres(env), /refuses to connect/, url);
      assert.throws(() => harness.pgSuite(env), /refuses to connect/, url);
    });
    assert.equal(calls, 0, `no connection may be attempted for ${url}`);
  }
});

test('the harness does not read DATABASE_URL, so an exported Railway URL can never reach the tests', () => {
  const env = { DATABASE_URL: 'postgresql://postgres:secret@roundhouse.proxy.rlwy.net:12345/railway' };
  assert.equal(harness.serverUrl(env), DEV_DATABASE_URL);
});

test('the harness only creates/drops nc_test_<16 hex> databases, and test database URLs stay local', async () => {
  for (const name of ['nc_assets_dev', 'postgres', 'template1', 'nc_test_', 'nc_test_xyz', 'nc_test_0123456789ABCDEF', 'nc_test_0123456789abcdef"; DROP DATABASE x; --', '']) {
    const calls = await countConnects(() => assert.rejects(harness.dropTestDatabase(name), /only creates\/drops databases named nc_test_/, name));
    assert.equal(calls, 0);
  }
  const url = harness.testDatabaseUrl(DEV_DATABASE_URL, 'nc_test_0123456789abcdef');
  assert.equal(url, 'postgresql://nc_dev:nc_dev@127.0.0.1:5433/nc_test_0123456789abcdef');
  assert.equal(isLocalDatabaseUrl(url), true);
  assert.throws(() => harness.testDatabaseUrl('postgresql://u:p@db.example.com/x', 'nc_test_0123456789abcdef'), /refuses to connect/);
});

test('pool URL: DATABASE_URL wins; the local dev default is development-only', () => {
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://a:b@h:1/d' }), 'postgresql://a:b@h:1/d');
  assert.equal(resolveDatabaseUrl({}), DEV_DATABASE_URL);
  assert.equal(resolveDatabaseUrl({ NODE_ENV: 'development' }), DEV_DATABASE_URL);
  assert.throws(() => resolveDatabaseUrl({ NODE_ENV: 'production' }), /DATABASE_URL is required in production/);
  assert.equal(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://a:b@h:1/d' }), 'postgresql://a:b@h:1/d');
});

test('int8 values parse to safe JS integers and refuse precision loss', () => {
  assert.equal(parseInt8('0'), 0);
  assert.equal(parseInt8('1760000000000'), 1760000000000);
  assert.equal(parseInt8('-42'), -42);
  assert.equal(parseInt8(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseInt8('9007199254740993'), RangeError);
});

// A fake pool/client pair that records statements, so transaction semantics are checked without a database.
function fakePool({ failOn } = {}) {
  const log = [];
  const pool = {
    log,
    released: [],
    async connect() {
      const client = {
        async query(sql) {
          log.push(sql);
          if (failOn && failOn === sql) throw new Error(`${sql} failed`);
          return { rows: [] };
        },
        release(err) { pool.released.push(err === undefined ? 'ok' : 'destroyed'); },
      };
      return client;
    },
  };
  return pool;
}

test('withTransaction (fake pool): BEGIN/COMMIT, ROLLBACK + rethrow, always released, ROLLBACK failure destroys the client', async () => {
  const ok = fakePool();
  assert.equal(await withTransaction(async (c) => { await c.query('X'); return 7; }, ok), 7);
  assert.deepEqual(ok.log, ['BEGIN', 'X', 'COMMIT']);
  assert.deepEqual(ok.released, ['ok']);

  const failing = fakePool();
  const boom = new Error('boom');
  await assert.rejects(withTransaction(async () => { throw boom; }, failing), (err) => err === boom);
  assert.deepEqual(failing.log, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(failing.released, ['ok']);

  const commitFails = fakePool({ failOn: 'COMMIT' });
  await assert.rejects(withTransaction(async () => {}, commitFails), /COMMIT failed/);
  assert.deepEqual(commitFails.log, ['BEGIN', 'COMMIT', 'ROLLBACK']);

  const rollbackFails = fakePool({ failOn: 'ROLLBACK' });
  await assert.rejects(withTransaction(async () => { throw boom; }, rollbackFails), (err) => err === boom);
  assert.deepEqual(rollbackFails.released, ['destroyed']);
});

test('withTransaction (fake pool): nesting is rejected; work scheduled inside may start its own transaction later', async () => {
  const pool = fakePool();
  await assert.rejects(
    withTransaction(async () => withTransaction(async () => {}, pool), pool),
    /cannot be nested/,
  );
  assert.deepEqual(pool.log, ['BEGIN', 'ROLLBACK']);

  let later;
  await withTransaction(async () => {
    later = new Promise((resolve) => setImmediate(() => resolve(withTransaction(async () => 'ran later', pool))));
  }, pool);
  assert.equal(await later, 'ran later');
});

test('lockAsset refuses to run outside withTransaction', async () => {
  const fakeClient = { query: async () => ({ rows: [{ id: 1 }] }) };
  await assert.rejects(lockAsset(fakeClient, 1), /must be called inside withTransaction/);
  await assert.rejects(lockAsset(undefined, 1), /must be called inside withTransaction/);
});

test('PG migration list: baseline is migration 1 and its SQL file exists', () => {
  assert.equal(pgMigrations[0].id, 1);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'src', 'pg', 'schema', pgMigrations[0].file)));
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pg', 'schema', pgMigrations[0].file), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // no SQLite-only syntax, and no blanket overlap/exclusion constraints (D-46: per-asset row locking instead)
  assert.doesNotMatch(code, /\bAUTOINCREMENT\b|datetime\(|\bGLOB\b|\bNOCASE\b|\bEXCLUDE\b/i);
});

test('nothing in the running app imports the PostgreSQL modules or pg (the app stays on SQLite)', () => {
  const srcDir = path.join(__dirname, '..', '..', 'src');
  const files = fs.readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith('.js') && !f.startsWith(`pg${path.sep}`));
  assert.ok(files.includes('server.js') && files.includes('db.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
    assert.doesNotMatch(code, /require\(\s*['"](pg|pg\/.*|\.\.?\/pg(\/.*)?)['"]\s*\)/, `${f} must not import pg yet`);
  }
});

test('parity canonicalization: casts, ANY(ARRAY), GLOB and the UTC-now default', () => {
  assert.equal(globToRegex('[0-9][0-9]:[0-5][0-9]'), '^[0-9][0-9]:[0-5][0-9]$');
  assert.equal(canon("status IN ('a','b')"), canon("(status = ANY (ARRAY['a'::text, 'b'::text]))"));
  assert.equal(canon("d GLOB '[0-9]-x'"), canon("(d ~ '^[0-9]-x$'::text)"));
  assert.equal(canon("datetime('now')"), '<utc-now-text>');
  assert.equal(canon("to_char((statement_timestamp() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD HH24:MI:SS'::text)"), '<utc-now-text>');
  assert.notEqual(canon("x = 'Good'"), canon("x = 'good'"));
  assert.notEqual(canon("status IN ('a','b')"), canon("status IN ('a','c')"));
});
