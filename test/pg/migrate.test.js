// PostgreSQL foundation (D-46, Slice 2): the PG migration runner and the baseline, on local throwaway databases.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { runMigrations } = require('../../src/pg/migrate');
const pgMigrations = require('../../src/pg/migrations');

const APP_TABLES = ['accounts', 'activity', 'asset_tag_counter', 'assets', 'assignments', 'catalog_nodes', 'employees', 'outbox',
  'photos', 'requests', 'reservations', 'schema_migrations', 'sessions', 'settings', 'tokens', 'waitlist_entries'];

const tablesOf = async (pool) => (await pool.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
)).rows.map((r) => r.table_name);

describe('PostgreSQL migration runner + baseline', pgSuite(), () => {
  const dbs = [];
  const fresh = async (opts) => { const d = await createTestDatabase(opts); dbs.push(d); return d; };
  after(async () => { await Promise.all(dbs.map((d) => d.drop())); });

  test('the baseline applies cleanly, and running the migrations again is a no-op', async () => {
    const tdb = await fresh({ migrate: false });
    assert.deepEqual(await runMigrations(tdb.pool), [1]);
    assert.deepEqual(await tablesOf(tdb.pool), APP_TABLES);
    assert.deepEqual(await runMigrations(tdb.pool), []);
    assert.deepEqual(await runMigrations(tdb.pool), []);
    const { rows } = await tdb.pool.query('SELECT id, name, applied_at FROM schema_migrations');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, pgMigrations[0].name);
    assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual((await tdb.pool.query('SELECT id, last_number FROM asset_tag_counter')).rows, [{ id: 1, last_number: 0 }]);
  });

  test('two runners starting at once on a fresh database apply the baseline exactly once', async () => {
    const tdb = await fresh({ migrate: false });
    const second = tdb.newPool();
    const results = await Promise.all([runMigrations(tdb.pool), runMigrations(second)]);
    assert.deepEqual(results.map((r) => r.join()).sort(), ['', '1']);
    assert.equal((await tdb.pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, 1);
  });

  test('fresh databases only: the baseline refuses a database that already has tables, and changes nothing', async () => {
    const tdb = await fresh({ migrate: false });
    await tdb.pool.query('CREATE TABLE assets (id integer)');
    await assert.rejects(runMigrations(tdb.pool), /not fresh \(existing tables: assets\)/);
    assert.deepEqual(await tablesOf(tdb.pool), ['assets', 'schema_migrations']);
    assert.equal((await tdb.pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, 0);
  });

  test('a failing migration rolls back completely and leaves no schema_migrations row', async () => {
    const tdb = await fresh();
    const broken = [...pgMigrations, { id: 2, name: 'broken on purpose', sql: 'CREATE TABLE half_done (id integer); SELECT 1 / 0;' }];
    await assert.rejects(runMigrations(tdb.pool, broken), /migration 2 \(broken on purpose\) failed: division by zero/);
    assert.equal((await tdb.pool.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
    assert.deepEqual((await tdb.pool.query('SELECT id FROM schema_migrations ORDER BY id')).rows, [{ id: 1 }]);
    assert.deepEqual(await runMigrations(tdb.pool), [], 'the database is still at the baseline and usable');
  });

  test('invalid migration lists are rejected before touching the database', async () => {
    const tdb = await fresh();
    await assert.rejects(runMigrations(tdb.pool, [{ id: 1, name: 'a', sql: '' }, { id: 1, name: 'b', sql: '' }]), /duplicate migration id: 1/);
    await assert.rejects(runMigrations(tdb.pool, [{ id: 0, name: 'zero', sql: '' }]), /Invalid or duplicate migration id: 0/);
  });
});
