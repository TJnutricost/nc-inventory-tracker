// PostgreSQL foundation (D-46, Slice 2): the per-file test database harness isolates parallel databases and cleans up.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase, listTestDatabases } = require('../../test-support/pg-harness');

describe('PostgreSQL per-file test database harness', pgSuite(), () => {
  test('two databases created in parallel are separate, migrated, and both dropped on teardown', async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      assert.notEqual(a.name, b.name);
      assert.match(a.name, /^nc_test_[0-9a-f]{16}$/);
      assert.equal((await a.pool.query('SELECT current_database() AS d')).rows[0].d, a.name);
      assert.equal((await b.pool.query('SELECT current_database() AS d')).rows[0].d, b.name);

      await a.pool.query("INSERT INTO settings (key, value) VALUES ('only_in_a', '1')");
      await b.pool.query("INSERT INTO employees (name) VALUES ('Only in B')");
      assert.equal((await a.pool.query("SELECT count(*) AS n FROM settings WHERE key = 'only_in_a'")).rows[0].n, 1);
      assert.equal((await b.pool.query("SELECT count(*) AS n FROM settings WHERE key = 'only_in_a'")).rows[0].n, 0);
      assert.equal((await a.pool.query('SELECT count(*) AS n FROM employees')).rows[0].n, 0);
      assert.equal((await b.pool.query('SELECT count(*) AS n FROM employees')).rows[0].n, 1);

      const listed = await listTestDatabases();
      assert.ok(listed.includes(a.name) && listed.includes(b.name));
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
    const after = await listTestDatabases();
    assert.ok(!after.includes(a.name) && !after.includes(b.name), 'both databases are gone');
    await a.drop(); // a second drop is a harmless no-op
  });

  test('drop() works even while a connection is still checked out (WITH (FORCE))', async () => {
    const tdb = await createTestDatabase({ migrate: false });
    const held = await tdb.pool.connect();
    held.on('error', () => {}); // the forced drop terminates this backend
    const name = tdb.name;
    try {
      await tdb.drop();
    } finally {
      held.release(true);
    }
    assert.ok(!(await listTestDatabases()).includes(name));
  });
});
