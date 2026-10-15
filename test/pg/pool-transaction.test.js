// PostgreSQL foundation (D-46, Slice 2): pool, withTransaction and lockAsset against a real (local, throwaway) database.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { withTransaction, lockAsset, onTransactionEnd, setLockTimeout } = require('../../src/pg/transaction');

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settingValue = async (pool, key) => (await pool.query('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value;

describe('PostgreSQL pool, transactions and per-asset locks', pgSuite(), () => {
  let tdb;
  let pool;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    await pool.query("INSERT INTO assets (id, tag, name) VALUES (1, 'NC-00001', 'Laptop one'), (2, 'NC-00002', 'Laptop two')");
  });
  after(async () => { await tdb?.drop(); });

  test('sessions run in UTC, even when the database default is another time zone', async () => {
    await pool.query(`ALTER DATABASE "${tdb.name}" SET TimeZone = 'America/Denver'`);
    const raw = new Client({ connectionString: tdb.url });
    await raw.connect();
    try {
      assert.equal((await raw.query('SHOW TimeZone')).rows[0].TimeZone, 'America/Denver', 'a plain client gets the database default');
    } finally {
      await raw.end();
    }
    const fresh = tdb.newPool();
    assert.equal((await fresh.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC');
    assert.match((await fresh.query('SELECT now()::text AS t')).rows[0].t, /\+00$/);
    await fresh.end();
  });

  test('int8 results come back as JS numbers (COUNT(*), bigint), like better-sqlite3', async () => {
    const { rows } = await pool.query('SELECT count(*) AS n, 1760000000000::bigint AS ms FROM catalog_nodes');
    assert.equal(rows[0].n, 13);
    assert.equal(rows[0].ms, 1760000000000);
  });

  test('withTransaction commits and returns fn\'s value', async () => {
    const out = await withTransaction(async (c) => {
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_commit', 'yes')");
      return 'done';
    }, pool);
    assert.equal(out, 'done');
    assert.equal(await settingValue(pool, 'tx_commit'), 'yes');
  });

  test('withTransaction rolls back everything and rethrows the same error', async () => {
    const boom = new Error('boom');
    await assert.rejects(withTransaction(async (c) => {
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_rollback_1', 'x')");
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_rollback_2', 'x')");
      throw boom;
    }, pool), (err) => err === boom);
    assert.equal(await settingValue(pool, 'tx_rollback_1'), undefined);
    assert.equal(await settingValue(pool, 'tx_rollback_2'), undefined);

    await assert.rejects(withTransaction(async (c) => {
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_rollback_3', 'x')");
      await c.query("INSERT INTO assets (id, tag, name, status) VALUES (99, 'NC-99', 'x', 'bogus')"); // CHECK violation
    }, pool), (err) => err.code === '23514');
    assert.equal(await settingValue(pool, 'tx_rollback_3'), undefined);
  });

  test('withTransaction always releases its client (a one-connection pool keeps working after failures)', async () => {
    const one = tdb.newPool({ max: 1, connectionTimeoutMillis: 2000 });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(withTransaction(async (c) => { await c.query('SELECT 1'); throw new Error(`fail ${i}`); }, one), /fail/);
      await assert.rejects(withTransaction(async (c) => c.query('SELECT * FROM no_such_table'), one), /no_such_table/);
    }
    assert.equal(await withTransaction(async (c) => (await c.query('SELECT 42 AS v')).rows[0].v, one), 42);
    assert.equal(one.totalCount, one.idleCount, 'no client is still checked out');
    await one.end();
  });

  test('nested withTransaction is rejected and the outer transaction rolls back', async () => {
    await assert.rejects(withTransaction(async (c) => {
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_nested_outer', 'x')");
      await withTransaction(async (inner) => inner.query("INSERT INTO settings (key, value) VALUES ('tx_nested_inner', 'x')"), pool);
    }, pool), /cannot be nested/);
    assert.equal(await settingValue(pool, 'tx_nested_outer'), undefined);
    assert.equal(await settingValue(pool, 'tx_nested_inner'), undefined);
  });

  test('onTransactionEnd runs after COMMIT or ROLLBACK (once per fn, errors ignored) and only inside a transaction', async () => {
    const seen = [];
    const record = (info) => seen.push(info.committed);
    const visibleAtCallback = [];
    await withTransaction(async (c) => {
      await c.query("INSERT INTO settings (key, value) VALUES ('tx_end_commit', 'x')");
      onTransactionEnd(c, record);
      onTransactionEnd(c, record);
      onTransactionEnd(c, () => { throw new Error('ignored'); });
      onTransactionEnd(c, () => { visibleAtCallback.push(settingValue(pool, 'tx_end_commit')); });
      assert.deepEqual(seen, [], 'nothing runs before the transaction ends');
    }, pool);
    assert.deepEqual(seen, [true]);
    assert.equal(await visibleAtCallback[0], 'x', 'the commit is visible to other connections when the callback runs');
    await assert.rejects(withTransaction(async (c) => { onTransactionEnd(c, record); throw new Error('nope'); }, pool), /nope/);
    assert.deepEqual(seen, [true, false]);
    await withTransaction(async () => {}, pool);
    assert.deepEqual(seen, [true, false], 'callbacks belong to one transaction only');
    assert.throws(() => onTransactionEnd(pool, record), /inside withTransaction/);
  });

  test('lockAsset returns the row; a missing asset throws a 404 ASSET_NOT_FOUND error', async () => {
    const row = await withTransaction((c) => lockAsset(c, 2), pool);
    assert.equal(row.tag, 'NC-00002');
    await assert.rejects(withTransaction((c) => lockAsset(c, 999), pool), (err) => err.code === 'ASSET_NOT_FOUND' && err.status === 404);
    await assert.rejects(withTransaction((c) => lockAsset(c, 'abc'), pool), /invalid asset id/);
  });

  test('lockAsset serializes writers on the SAME asset: the second waits until the first commits', async () => {
    const events = [];
    let letACommit;
    const aMayCommit = new Promise((r) => { letACommit = r; });
    let signalALocked;
    const aLocked = new Promise((r) => { signalALocked = r; });

    const txA = withTransaction(async (c) => {
      await lockAsset(c, 1);
      events.push('A locked');
      signalALocked();
      await aMayCommit;
      await c.query("UPDATE assets SET name = 'renamed by A' WHERE id = 1");
      events.push('A committing');
    }, pool);
    await aLocked;

    let bPid = null;
    const txB = withTransaction(async (c) => {
      bPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const row = await lockAsset(c, 1);
      events.push('B locked');
      return row;
    }, pool);

    // B is provably blocked on a row lock (not just slow) while A still holds the asset.
    await waitFor(async () => bPid !== null
      && (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [bPid])).rows[0]?.wait_event_type === 'Lock', 'B to wait on the asset lock');
    assert.deepEqual(events, ['A locked']);

    letACommit();
    const [, bRow] = await Promise.all([txA, txB]);
    assert.deepEqual(events, ['A locked', 'A committing', 'B locked']);
    assert.equal(bRow.name, 'renamed by A', 'B reads the asset as A committed it');
  });

  test('lockAsset does not block a DIFFERENT asset, and a same-asset waiter can time out', async () => {
    let letAFinish;
    const aMayFinish = new Promise((r) => { letAFinish = r; });
    let signalALocked;
    const aLocked = new Promise((r) => { signalALocked = r; });
    const txA = withTransaction(async (c) => {
      await lockAsset(c, 1);
      signalALocked();
      await aMayFinish;
    }, pool);
    await aLocked;
    try {
      const other = await withTransaction(async (c) => {
        await c.query("SET LOCAL lock_timeout = '2s'");
        return lockAsset(c, 2);
      }, pool);
      assert.equal(other.id, 2);
      // (Slice 5A: lockAsset sets its own transaction-local timeout and answers 503 ASSET_BUSY, keeping the 55P03 as the cause)
      setLockTimeout(150);
      await assert.rejects(withTransaction(async (c) => lockAsset(c, 1), pool),
        (err) => err.status === 503 && err.code === 'ASSET_BUSY' && err.cause.code === '55P03'); // lock_not_available
    } finally {
      setLockTimeout(null);
      letAFinish();
      await txA;
    }
  });
});
