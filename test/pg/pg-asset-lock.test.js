// The asset-lock guard and lock ordering of the Slice 4B write paths (D-46, D-47). holdsAssetLock() is true only inside the
// transaction that obtained the lock, only for that asset, and never leaks to the next transaction on a pooled client (proved
// with a pool of ONE connection, so the same client is reused); the protected helpers refuse to run without the lock
// (ASSET_LOCK_REQUIRED, a plain programming error); and a query spy shows, for every write path, that the asset's FOR UPDATE
// comes right after BEGIN (create) or right after the single id -> asset_id lookup (approve / decline / cancel / shorten),
// before any other read or write of protected state. Write functions join a caller's transaction; a pool passed from inside a
// transaction is refused as nesting. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { spyPool, oneLine } = require('../../test-support/pg-write-support');
const { syncSequences } = require('../../test-support/pg-twin');
const fx = require('../../test-support/pg-fixtures');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction, lockAsset, holdsAssetLock, assertAssetLock, isInTransaction } = require('../../src/pg/transaction');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');
const effects = require('../../src/pg/effects');

const LOCK_REQUIRED = (err) => err.code === 'ASSET_LOCK_REQUIRED' && err.status === undefined;
const FOR_UPDATE = 'SELECT * FROM assets WHERE id = $1 FOR UPDATE';
const LOOKUP = 'SELECT asset_id FROM reservations WHERE id = $1';

describe('PostgreSQL asset-lock guard and lock ordering (Slice 4B)', pgSuite(), () => {
  let tdb; let pool; let today; let ana; let anaAcct; let admin;
  const d = (n) => T.addDays(today, n);
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    today = await pgTime.today(pool);
    ana = await fx.insertEmployee(pool, { name: 'Ana Locker' });
    anaAcct = await fx.insertAccount(pool, { employee_id: ana.id });
    admin = await fx.insertAccount(pool, { role: 'admin', employee_id: null });
  });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });

  test('holdsAssetLock: per transaction, per asset, cleared at COMMIT / ROLLBACK / a throw, never carried by a reused client', async () => {
    const one = tdb.newPool({ max: 1 });
    const a1 = await fx.insertAsset(pool); const a2 = await fx.insertAsset(pool);
    let first;
    await withTransaction(async (c) => {
      first = c;
      assert.equal(holdsAssetLock(c, a1.id), false, 'not before lockAsset');
      await lockAsset(c, a1.id);
      assert.equal(holdsAssetLock(c, a1.id), true);
      assert.equal(holdsAssetLock(c, String(a1.id)), true, 'the id may be given as text');
      assert.equal(holdsAssetLock(c, a2.id), false, 'the lock of asset 1 says nothing about asset 2');
      assertAssetLock(c, a1.id);
      assert.throws(() => assertAssetLock(c, a2.id), LOCK_REQUIRED);
    }, one);
    assert.equal(holdsAssetLock(first, a1.id), false, 'false outside a transaction');
    await withTransaction(async (c) => {
      assert.equal(c, first, 'the pool of one reuses the same client');
      assert.equal(holdsAssetLock(c, a1.id), false, 'a committed transaction\'s lock record is gone');
    }, one);
    await assert.rejects(withTransaction(async (c) => { await lockAsset(c, a1.id); throw new Error('boom'); }, one), /boom/);
    await withTransaction(async (c) => {
      assert.equal(c, first);
      assert.equal(holdsAssetLock(c, a1.id), false, 'cleared after a throw / ROLLBACK');
    }, one);
    await assert.rejects(withTransaction(async (c) => { await lockAsset(c, 999999); }, one), { code: 'ASSET_NOT_FOUND' });
    await withTransaction(async (c) => {
      assert.equal(holdsAssetLock(c, 999999), false, 'a lock that found no row is never recorded');
      await assert.rejects(c.query('SELECT 1/0'), /division by zero/); // the transaction is now aborted...
    }, one).catch(() => {}); // ...so COMMIT fails and it rolls back
    await withTransaction(async (c) => assert.equal(holdsAssetLock(c, a1.id), false), one);
    assert.equal(holdsAssetLock(pool, a1.id), false, 'a pool never holds a lock');
  });

  test('the protected helpers refuse to run without the right asset lock (ASSET_LOCK_REQUIRED)', async () => {
    const a1 = await fx.insertAsset(pool, { available_to_request: 1 }); const a2 = await fx.insertAsset(pool);
    await fx.insertWaitlistEntry(pool, { asset_id: a1.id, employee_id: ana.id, start_date: d(5), queue_seq: 1 });
    await assert.rejects(waitlist.evaluateAsset(pool, a1.id), LOCK_REQUIRED, 'with a pool');
    await assert.rejects(withTransaction((c) => waitlist.evaluateAsset(c, a1.id), pool), LOCK_REQUIRED, 'in a transaction that has not locked');
    await assert.rejects(withTransaction(async (c) => { await lockAsset(c, a2.id); await waitlist.evaluateAsset(c, a1.id); }, pool), LOCK_REQUIRED, 'with another asset locked');
    const range = { start_date: d(6), start_time: null, end_date: d(6), end_time: null };
    await assert.rejects(withTransaction((c) => waitlist.insertEntry(c, { assetId: a1.id, employeeId: ana.id, actorAccountId: anaAcct.id, range }), pool), LOCK_REQUIRED);
    await assert.rejects(withTransaction((c) => reservations.insertReservation(c, a1, { employeeId: ana.id, actorAccountId: anaAcct.id, start: d(6), end: d(6) }), pool), LOCK_REQUIRED);
    await assert.rejects(withTransaction(async (c) => { await lockAsset(c, a2.id); await reservations.insertReservation(c, a1, { employeeId: ana.id, start: d(6), end: d(6) }); }, pool), LOCK_REQUIRED);
    assert.throws(() => effects.registerEffect(pool, { type: 'holds_owed', assetId: a1.id }), /inside withTransaction/);
    assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM waitlist_entries WHERE asset_id = $1', [a1.id])).rows[0].c), 1, 'nothing was written');
    // with the lock, the same helpers work
    const granted = await withTransaction(async (c) => { await lockAsset(c, a1.id); return waitlist.evaluateAsset(c, a1.id); }, pool);
    assert.equal(granted.length, 1);
  });

  test('every write path takes the asset FOR UPDATE first (pool path: BEGIN, [id -> asset lookup], FOR UPDATE, ...)', async () => {
    const asset = await fx.insertAsset(pool, { available_to_request: 1, reservation_requires_approval: 1 });
    await syncSequences(pool);
    const runs = {};
    const spied = async (name, fn) => { const s = spyPool(pool); runs[name] = { result: await fn(s.pool), log: s.log.map(oneLine) }; return runs[name].result; };
    const by = { employeeId: ana.id, actorAccountId: anaAcct.id };
    const made = await spied('create', (p) => reservations.create(p, { assetId: asset.id, ...by, start: d(3), end: d(3) }));
    const id1 = made.reserved[0].id;
    await spied('approve', (p) => reservations.approve(p, id1, { actorAccountId: admin.id }));
    await spied('shorten', (p) => reservations.shorten(p, id1, { ...by, newEndTime: '12:00' }));
    await spied('cancel', (p) => reservations.cancel(p, id1, { ...by }));
    const id2 = (await reservations.create(pool, { assetId: asset.id, ...by, start: d(4), end: d(4) })).reserved[0].id;
    await spied('decline', (p) => reservations.decline(p, id2, { actorAccountId: admin.id }));
    for (const [name, { log }] of Object.entries(runs)) {
      assert.equal(log[0], 'BEGIN', name);
      const lockAt = log.indexOf(FOR_UPDATE);
      if (name === 'create') assert.equal(lockAt, 1, `${name}: the first statement after BEGIN is the asset lock\n${log.join('\n')}`);
      else assert.deepEqual([log[1], lockAt], [LOOKUP, 2], `${name}: only the id -> asset lookup precedes the lock\n${log.join('\n')}`);
      assert.equal(log.at(-1), 'COMMIT', name);
      assert.equal(log.filter((s) => s === FOR_UPDATE).length, 1, `${name}: one asset per transaction`);
    }
  });

  test('joined to a caller\'s transaction: same ordering on the caller\'s client; a pool from inside a transaction is nesting', async () => {
    const asset = await fx.insertAsset(pool, { available_to_request: 1 });
    await syncSequences(pool);
    const log = [];
    const result = await withTransaction(async (c) => {
      const original = c.query;
      c.query = function spied(text, ...rest) { log.push(oneLine(typeof text === 'string' ? text : text.text)); return original.call(this, text, ...rest); };
      try {
        const r = await reservations.create(c, { assetId: asset.id, employeeId: ana.id, actorAccountId: anaAcct.id, start: d(5), end: d(5) });
        assert.ok(isInTransaction(c));
        assert.equal(holdsAssetLock(c, asset.id), true, 'still locked until the caller commits');
        await reservations.cancel(c, r.reserved[0].id, { employeeId: ana.id, actorAccountId: anaAcct.id });
        return r;
      } finally { c.query = original; }
    }, pool);
    assert.equal(log[0], FOR_UPDATE, 'create joined: its first statement is the lock');
    const second = log.indexOf(LOOKUP);
    assert.equal(log[second + 1], FOR_UPDATE, 'cancel joined: lookup, then the (re-)lock');
    assert.ok(!log.includes('BEGIN') && !log.includes('COMMIT'), 'no transaction of their own');
    assert.equal((await pool.query('SELECT status FROM reservations WHERE id = $1', [result.reserved[0].id])).rows[0].status, 'cancelled');
    await assert.rejects(withTransaction(() => reservations.create(pool, { assetId: asset.id, employeeId: ana.id, start: d(6), end: d(6) }), pool), /cannot be nested/);
    await assert.rejects(withTransaction(() => reservations.cancel(pool, result.reserved[0].id, { employeeId: ana.id }), pool), /cannot be nested/);
  });
});
