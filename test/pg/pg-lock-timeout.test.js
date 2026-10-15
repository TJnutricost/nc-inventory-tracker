// Lock timeout, pool checkout timeout and the 503s (Slice 5A, D-48 point 3; owner decision 2026-10-15: two codes). lockAsset
// (src/pg/transaction.js) sets a TRANSACTION-LOCAL lock_timeout right before its FOR UPDATE (default 5000 ms; NC_LOCK_TIMEOUT_MS;
// setLockTimeout in tests); PostgreSQL's 55P03 becomes status 503 / ASSET_BUSY / "This item is busy right now. Please try again
// in a moment."; a pool checkout timeout in withTransaction becomes 503 / DB_BUSY / "The system is busy right now. Please try
// again in a moment.". Proved here:
//   - a contender against a lock held on a third connection fails after about the (small) timeout with the exact 503, through
//     the write paths (reservations.create, the waitlist request path's due step), writing nothing and firing no effect;
//   - no leak: with a pool of ONE connection, `SHOW lock_timeout` is the previous value after lockAsset, after COMMIT, after
//     ROLLBACK and after the 55P03 error (a session value someone set is kept); the setting is set with is_local = true;
//   - uncontended locks are unaffected (even with a 1 ms timeout); a lock held on asset A never times out a write on asset B;
//   - 12 contenders on one locked asset with a pool of 10: every one ends in success or a 503 (ASSET_BUSY / DB_BUSY), none hangs,
//     pool and lock-waiter counts back to baseline, no deadlock;
//   - the sweep: one timed-out asset is reported in `failed` and the sweep continues with the next asset;
//   - only the checkout timeout is remapped (other connection errors pass through); setLockTimeout / NC_LOCK_TIMEOUT_MS.
// Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { blockAsset, lockWaiters, waitFor, isLockTimeoutSql } = require('../../test-support/pg-write-support');
const fx = require('../../test-support/pg-fixtures');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction, lockAsset, setLockTimeout, BUSY_ASSET, BUSY_DB, DEFAULT_LOCK_TIMEOUT_MS } = require('../../src/pg/transaction');
const effects = require('../../src/pg/effects');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');
const { createSweepScheduler } = require('../../src/pg/sweep');

const ASSET_MSG = 'This item is busy right now. Please try again in a moment.';
const DB_MSG = 'The system is busy right now. Please try again in a moment.';
const isBusy = (code, message) => (err) => err.status === 503 && err.code === code && err.message === message;
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.join(' ')); try { return { out: await fn(), seen }; } finally { console.error = orig; } };

describe('PostgreSQL lock timeout, pool checkout timeout and the 503s (Slice 5A)', pgSuite(), () => {
  let tdb; let pool; let sampler; let today; let emp; let seen;
  const d = (n) => T.addDays(today, n);
  const asset = (name) => fx.insertRow(pool, 'assets', { tag: `LT-${name}`, name, available_to_request: 1 });
  const count = async (table, assetId) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = $1`, [assetId])).rows[0].n);
  const baseline = (p) => { assert.equal(p.waitingCount, 0, 'nobody waits for a connection'); assert.equal(p.idleCount, p.totalCount, 'every client was released'); };

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 3 }); // blockers and pg_stat_activity samples, outside the pool under test
    today = await pgTime.today(pool);
    emp = await fx.insertRow(pool, 'employees', { name: 'Lock Tester', work_email: 'lock@example.com' });
  });
  afterEach(async () => {
    setLockTimeout(null);
    await effects.whenIdle();
    effects.setNotifier(null);
  });
  after(async () => {
    try {
      baseline(pool);
      assert.equal(await lockWaiters(sampler), 0);
    } finally {
      await tdb?.drop();
    }
  });

  test('the defaults and the messages are the approved ones', () => {
    assert.equal(DEFAULT_LOCK_TIMEOUT_MS, 5000);
    assert.equal(BUSY_ASSET, ASSET_MSG);
    assert.equal(BUSY_DB, DB_MSG);
    assert.equal(setLockTimeout(null), 5000, 'no NC_LOCK_TIMEOUT_MS: 5 s');
  });

  test('a contender against a held lock gets 503 ASSET_BUSY after about the timeout, through the write paths; nothing written, no effects', async () => {
    const a = await asset('contended');
    const entry = await fx.insertRow(pool, 'waitlist_entries', { asset_id: a.id, employee_id: emp.id, start_date: d(5), end_date: d(5), status: 'waiting', queue_seq: 1 });
    seen = [];
    effects.setNotifier((e) => { seen.push(e); });
    const activityBefore = await count('activity', a.id);
    const blocker = await blockAsset(sampler, a.id);
    try {
      setLockTimeout(150);
      const t0 = Date.now();
      await assert.rejects(reservations.create(pool, { assetId: a.id, employeeId: emp.id, actorAccountId: null, start: d(3), end: d(3) }), isBusy('ASSET_BUSY', ASSET_MSG));
      const waited = Date.now() - t0;
      assert.ok(waited >= 120 && waited < 3000, `failed after about the timeout (${waited} ms)`);
      // the waitlist request path: its due step (lockOr404) is the first lock
      await assert.rejects(waitlist.join(pool, { assetId: a.id, employeeId: emp.id, actorAccountId: null, start: d(7), end: d(7) }), isBusy('ASSET_BUSY', ASSET_MSG));
      await assert.rejects(waitlist.leave(pool, entry.id, { employeeId: emp.id, actorAccountId: null, isAdmin: false }), isBusy('ASSET_BUSY', ASSET_MSG));
      // the 55P03 is kept as the cause
      await assert.rejects(withTransaction((c) => lockAsset(c, a.id), pool), (err) => err.code === 'ASSET_BUSY' && err.cause && err.cause.code === '55P03');
    } finally {
      await blocker.release();
    }
    await effects.whenIdle();
    assert.equal(await count('reservations', a.id), 0, 'no reservation');
    assert.equal(await count('waitlist_entries', a.id), 1, 'no waitlist row');
    assert.equal((await pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [entry.id])).rows[0].status, 'waiting', 'nobody left');
    assert.equal(await count('activity', a.id), activityBefore, 'no activity');
    assert.deepEqual(seen, [], 'no effects');
    baseline(pool);
    // once free, the same write goes through
    const r = await reservations.create(pool, { assetId: a.id, employeeId: emp.id, actorAccountId: null, start: d(3), end: d(3) });
    assert.equal(r.reserved.length, 1);
  });

  test('no leak: with ONE pooled connection, lock_timeout is the previous value after lockAsset, COMMIT, ROLLBACK and the 55P03; set with is_local', async () => {
    const one = tdb.newPool({ max: 1 });
    const a = await asset('leak');
    const show = async (q) => (await q.query('SHOW lock_timeout')).rows[0].lock_timeout;
    const pids = new Set();
    const pidOf = async (q) => { const p = (await q.query('SELECT pg_backend_pid() AS p')).rows[0].p; pids.add(p); return p; };
    setLockTimeout(150);
    assert.equal(await show(one), '0', 'the server default');
    // commit
    const sql = [];
    await withTransaction(async (c) => {
      await pidOf(c);
      const original = c.query;
      c.query = function spied(text, ...rest) { const s = typeof text === 'string' ? text : text.text; if (isLockTimeoutSql(s)) sql.push([s, rest[0]]); return original.call(this, text, ...rest); };
      try { await lockAsset(c, a.id); } finally { c.query = original; }
      assert.equal(await show(c), '0', 'the next statement in the same transaction runs without the asset timeout');
    }, one);
    assert.equal(await show(one), '0', 'after COMMIT');
    assert.equal(sql.length, 2);
    assert.match(sql[0][0], /set_config\('lock_timeout', \$1, true\)/, 'transaction-local (is_local = true)');
    assert.deepEqual(sql[0][1], ['150ms']);
    assert.match(sql[1][0], /set_config\('lock_timeout', \$1, true\)/);
    // rollback
    await assert.rejects(withTransaction(async (c) => { await pidOf(c); await lockAsset(c, a.id); throw new Error('rolled back'); }, one), /rolled back/);
    assert.equal(await show(one), '0', 'after ROLLBACK');
    // the 55P03
    const blocker = await blockAsset(sampler, a.id);
    try {
      await assert.rejects(withTransaction(async (c) => { await pidOf(c); return lockAsset(c, a.id); }, one), isBusy('ASSET_BUSY', ASSET_MSG));
    } finally {
      await blocker.release();
    }
    assert.equal(await show(one), '0', 'after the 55P03');
    // a session value someone set on this connection is kept (lockAsset restores what was there)
    await one.query("SET lock_timeout = '7s'");
    await withTransaction(async (c) => { await pidOf(c); await lockAsset(c, a.id); assert.equal(await show(c), '7s'); }, one);
    assert.equal(await show(one), '7s');
    await one.query('RESET lock_timeout');
    assert.equal(pids.size, 1, 'every transaction ran on the same pooled connection');
    baseline(one);
    await one.end();
  });

  test('uncontended locks are unaffected (even with a 1 ms timeout); a lock held on A never times out a write on B', async () => {
    const a = await asset('A'); const b = await asset('B');
    setLockTimeout(1);
    assert.equal((await withTransaction((c) => lockAsset(c, b.id), pool)).id, b.id);
    setLockTimeout(100);
    const blocker = await blockAsset(sampler, a.id);
    try {
      const r = await reservations.create(pool, { assetId: b.id, employeeId: emp.id, actorAccountId: null, start: d(4), end: d(4) });
      assert.equal(r.reserved.length, 1, 'B is written while A is locked');
      await assert.rejects(withTransaction((c) => lockAsset(c, a.id), pool), isBusy('ASSET_BUSY', ASSET_MSG));
    } finally {
      await blocker.release();
    }
    baseline(pool);
  });

  test('12 contenders on one locked asset with a pool of 10: each ends in success or a 503, none hangs, back to baseline, no deadlock', async () => {
    const a = await asset('twelve');
    // (1) the lock is never released in time: 10 checked-out contenders time out on the lock (ASSET_BUSY), the 2 waiting for a
    //     connection time out on the checkout (DB_BUSY)
    const ten = tdb.newPool({ max: 10, connectionTimeoutMillis: 200 });
    setLockTimeout(1500);
    let blocker = await blockAsset(sampler, a.id);
    let outs;
    try {
      outs = await Promise.allSettled([...Array(12)].map(() => withTransaction(async (c) => { await lockAsset(c, a.id); return 'ok'; }, ten)));
    } finally {
      await blocker.release();
    }
    const codes = outs.map((o) => (o.status === 'fulfilled' ? 'ok' : `${o.reason.status} ${o.reason.code}`));
    assert.deepEqual(codes.filter((c) => c === '503 ASSET_BUSY').length, 10, codes.join(', '));
    assert.deepEqual(codes.filter((c) => c === '503 DB_BUSY').length, 2, codes.join(', '));
    for (const o of outs) assert.ok([ASSET_MSG, DB_MSG].includes(o.reason.message));
    baseline(ten);
    assert.equal(await lockWaiters(sampler), 0);
    // (2) released while they wait (the defaults: 5 s lock timeout, 5 s checkout): all 12 succeed, one at a time
    setLockTimeout(null);
    const ten2 = tdb.newPool({ max: 10 });
    blocker = await blockAsset(sampler, a.id);
    let runs;
    try {
      runs = [...Array(12)].map((_, i) => withTransaction(async (c) => {
        await lockAsset(c, a.id);
        await c.query('UPDATE assets SET notes = $1 WHERE id = $2', [`contender ${i}`, a.id]);
        return 'ok';
      }, ten2));
      await waitFor(async () => (await lockWaiters(sampler)) >= 10, '10 contenders queued on the lock');
      assert.equal(ten2.waitingCount, 2, 'two wait for a connection');
    } finally {
      await blocker.release();
    }
    const outs2 = await Promise.allSettled(runs);
    assert.deepEqual(outs2.map((o) => (o.status === 'fulfilled' ? o.value : `${o.reason.status} ${o.reason.code}`)), Array(12).fill('ok'));
    baseline(ten2);
    assert.equal(await lockWaiters(sampler), 0);
    await Promise.all([ten.end(), ten2.end()]);
  });

  test('the sweep: a timed-out asset is reported in `failed` and the sweep continues (also through the scheduler)', async () => {
    const a = await asset('sweep busy'); const b = await asset('sweep free');
    const past = '2026-01-02';
    const ea = await fx.insertRow(pool, 'waitlist_entries', { asset_id: a.id, employee_id: emp.id, start_date: past, end_date: past, status: 'waiting', queue_seq: 1 });
    const eb = await fx.insertRow(pool, 'waitlist_entries', { asset_id: b.id, employee_id: emp.id, start_date: past, end_date: past, status: 'waiting', queue_seq: 1 });
    const status = async (id) => (await pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [id])).rows[0].status;
    setLockTimeout(100);
    const blocker = await blockAsset(sampler, a.id);
    let result; let logged;
    try {
      ({ out: result, seen: logged } = await quietly(() => waitlist.sweep(pool)));
    } finally {
      await blocker.release();
    }
    assert.ok(result.assets.includes(a.id) && result.assets.includes(b.id));
    assert.deepEqual(result.failed, [{ assetId: a.id, message: ASSET_MSG }]);
    assert.ok(logged.some((l) => l.startsWith('[waitlist:sweep]') && l.includes(ASSET_MSG)));
    assert.deepEqual([await status(ea.id), await status(eb.id)], ['waiting', 'expired'], 'A untouched, B swept');
    // through the scheduler, A now free: recorded
    const tick = await quietly(() => createSweepScheduler({ pool, log: { error() {} } }).tick());
    assert.deepEqual(tick.out.result.failed, []);
    assert.equal(await status(ea.id), 'expired');
    baseline(pool);
  });

  test('only the pool CHECKOUT timeout becomes DB_BUSY; other connection errors pass through; setLockTimeout / NC_LOCK_TIMEOUT_MS', async () => {
    const timeoutPool = { connect: async () => { throw new Error('timeout exceeded when trying to connect'); } };
    await assert.rejects(withTransaction(async () => assert.fail('never runs'), timeoutPool), (err) => isBusy('DB_BUSY', DB_MSG)(err) && /timeout exceeded/.test(err.cause.message));
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    await assert.rejects(withTransaction(async () => assert.fail('never runs'), { connect: async () => { throw refused; } }), (err) => err === refused && err.status === undefined);
    // setLockTimeout
    assert.equal(setLockTimeout(250), 250);
    for (const bad of [0, -1, 1.5, 'abc', '']) assert.throws(() => setLockTimeout(bad), TypeError);
    const saved = process.env.NC_LOCK_TIMEOUT_MS;
    try {
      process.env.NC_LOCK_TIMEOUT_MS = '1234';
      assert.equal(setLockTimeout(null), 1234, 'NC_LOCK_TIMEOUT_MS');
      process.env.NC_LOCK_TIMEOUT_MS = 'soon';
      assert.equal(setLockTimeout(null), 5000, 'an invalid NC_LOCK_TIMEOUT_MS falls back to the default');
    } finally {
      if (saved === undefined) delete process.env.NC_LOCK_TIMEOUT_MS; else process.env.NC_LOCK_TIMEOUT_MS = saved;
      setLockTimeout(null);
    }
  });
});
