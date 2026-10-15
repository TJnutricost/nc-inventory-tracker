// The single-flight sweep scheduler (Slice 5A, D-48 point 4): src/pg/sweep.js createSweepScheduler. No real 60-second waits:
// the tests call tick() and gate run() on test-controlled promises. Proved here:
//   - in-process single flight: a second tick while the first is running is skipped ({ ran: false, reason: 'in_flight' });
//   - across instances: two schedulers on two pools (two app instances) racing: exactly one runs, the other gets `locked`;
//   - the session advisory lock is released after a successful sweep, after a throwing run(), and when the holding connection is
//     killed (the dead connection is destroyed, not returned; a closed session frees the lock);
//   - stop() waits for an in-flight sweep; start() runs ticks on an unref()'d timer; tick() never throws (a throwing run, no
//     connection); the dedicated connection always goes back (pool baseline); the real waitlist.sweep runs through tick();
//   - the lock key is distinct from the schema runner's.
// Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { waitFor } = require('../../test-support/pg-write-support');
const { createSweepScheduler, SWEEP_LOCK_KEY } = require('../../src/pg/sweep');
const fx = require('../../test-support/pg-fixtures');

const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const silent = () => { const lines = []; return { lines, error: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')) }; };
// A run() that signals when it started and waits for the test to let it finish.
// (every gate and scheduler a test made is opened / stopped after it, so a failing assertion can never leave a sweep hanging)
const openGates = [];
const schedulers = [];
function gatedRun() {
  const started = deferred(); const gate = deferred();
  let calls = 0;
  const run = async () => { calls++; started.resolve(); await gate.promise; return { assets: [], failed: [] }; };
  openGates.push(gate);
  return { run, started: started.promise, finish: () => gate.resolve(), calls: () => calls };
}
const make = (opts) => { const s = createSweepScheduler(opts); schedulers.push(s); return s; };

describe('PostgreSQL single-flight sweep scheduler (Slice 5A)', pgSuite(), () => {
  let tdb; let pool; let pool2; let sampler;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    pool2 = tdb.newPool(); // a second app instance
    sampler = tdb.newPool({ max: 1 });
  });
  afterEach(async () => {
    for (const g of openGates.splice(0)) g.resolve();
    await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  });
  after(async () => {
    try {
      for (const p of [pool, pool2]) {
        assert.equal(p.waitingCount, 0);
        assert.equal(p.idleCount, p.totalCount, 'every client was released');
      }
      assert.equal(await sweepLockHolders(), 0, 'nobody holds the sweep lock');
    } finally {
      await tdb?.drop();
    }
  });
  // Sessions of THIS test database holding the sweep advisory lock (a bigint key: classid = high 32 bits, objid = low 32 bits).
  const sweepLockHolders = async () => Number((await sampler.query(
    `SELECT COUNT(*) AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
     WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()
       AND ((l.classid::bigint << 32) | l.objid::bigint) = $1`, [SWEEP_LOCK_KEY])).rows[0].n);
  const holderPid = async () => (await sampler.query(
    `SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
     WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()
       AND ((l.classid::bigint << 32) | l.objid::bigint) = $1`, [SWEEP_LOCK_KEY])).rows[0]?.pid;
  const baseline = (p) => { assert.equal(p.waitingCount, 0); assert.equal(p.idleCount, p.totalCount, 'the dedicated connection went back'); };

  test('the sweep lock key is a documented constant distinct from the schema runner\'s advisory lock key', () => {
    const migrateSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pg', 'migrate.js'), 'utf8');
    const runnerKey = Number(/const ADVISORY_LOCK_KEY = ([\d_]+);/.exec(migrateSrc)[1].replace(/_/g, ''));
    assert.equal(runnerKey, 4_651_201_400_017);
    assert.equal(SWEEP_LOCK_KEY, 4_651_201_400_018);
    assert.notEqual(SWEEP_LOCK_KEY, runnerKey);
    assert.ok(Number.isSafeInteger(SWEEP_LOCK_KEY));
  });

  test('in-process single flight: a tick while one is running is skipped; the lock is held for the whole sweep and released after', async () => {
    const g = gatedRun();
    const s = make({ pool, run: g.run, log: silent() });
    const first = s.tick();
    await g.started;
    assert.equal(await sweepLockHolders(), 1, 'the advisory lock is held while the sweep runs');
    assert.deepEqual(await s.tick(), { ran: false, reason: 'in_flight' });
    assert.deepEqual(await s.tick(), { ran: false, reason: 'in_flight' });
    g.finish();
    assert.deepEqual(await first, { ran: true, result: { assets: [], failed: [] } });
    assert.equal(g.calls(), 1);
    assert.equal(await sweepLockHolders(), 0, 'released after a successful sweep');
    baseline(pool);
    // and the next tick runs again
    const g2 = gatedRun();
    const s2 = make({ pool, run: g2.run, log: silent() });
    const t = s2.tick(); g2.finish();
    assert.equal((await t).ran, true);
  });

  test('two schedulers on two pools (two instances) racing: exactly one runs, the other gets `locked`', async () => {
    const g1 = gatedRun(); const g2 = gatedRun();
    const s1 = make({ pool, run: g1.run, log: silent() });
    const s2 = make({ pool: pool2, run: g2.run, log: silent() });
    const [t1, t2] = [s1.tick(), s2.tick()];
    await Promise.race([g1.started, g2.started]);
    const [winner, loserTick] = g1.calls() ? [g1, t2] : [g2, t1];
    assert.deepEqual(await loserTick, { ran: false, reason: 'locked' });
    winner.finish();
    const results = await Promise.all([t1, t2]);
    assert.deepEqual(results.map((r) => r.ran).sort(), [false, true], 'exactly one ran');
    assert.equal(g1.calls() + g2.calls(), 1, 'run() was called once in all');
    assert.equal(await sweepLockHolders(), 0);
    // once released, the other instance can sweep
    const g3 = gatedRun();
    const s3 = make({ pool: pool2, run: g3.run, log: silent() });
    const t3 = s3.tick(); g3.finish();
    assert.equal((await t3).ran, true);
    baseline(pool); baseline(pool2);
  });

  test('a throwing run() never throws out of tick(); the lock is released and the connection returned', async () => {
    const log = silent();
    const s = make({ pool, run: async () => { throw new Error('sweep exploded'); }, log });
    assert.deepEqual(await s.tick(), { ran: true, error: 'sweep exploded' });
    assert.ok(log.lines.some((l) => l.startsWith('[sweep]') && l.includes('sweep exploded')));
    assert.equal(await sweepLockHolders(), 0, 'released after a throwing run');
    baseline(pool);
    // no connection at all: tick() still resolves
    const noConn = { connect: async () => { throw new Error('timeout exceeded when trying to connect'); } };
    const log2 = silent();
    assert.deepEqual(await make({ pool: noConn, run: async () => assert.fail('must not run'), log: log2 }).tick(),
      { ran: false, reason: 'error', error: 'timeout exceeded when trying to connect' });
    assert.ok(log2.lines.some((l) => l.startsWith('[sweep]')));
    assert.throws(() => createSweepScheduler({}), /a pool is required/);
  });

  test('the lock is freed when the holding connection is killed: the dead connection is destroyed, not reused; another instance sweeps', async () => {
    const g = gatedRun();
    const log = silent();
    const s = make({ pool, run: g.run, log });
    const t = s.tick();
    await g.started;
    const pid = await holderPid();
    assert.ok(pid, 'a session holds the sweep lock');
    const totalBefore = pool.totalCount;
    await sampler.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(async () => (await sweepLockHolders()) === 0, 'the killed session to free the lock');
    // another instance can sweep while the first one's run() is still going
    const g2 = gatedRun();
    const other = make({ pool: pool2, run: g2.run, log: silent() });
    const t2 = other.tick(); g2.finish();
    assert.equal((await t2).ran, true, 'the lock was free');
    g.finish();
    const r = await t;
    assert.equal(r.ran, true, 'the sweep itself finished (it ran on other connections)');
    assert.ok(log.lines.some((l) => l.startsWith('[sweep]')), log.lines.join('\n'));
    assert.equal(pool.totalCount, totalBefore - 1, 'the dead connection was destroyed, not returned');
    baseline(pool); baseline(pool2);
    // the pool still works and the same scheduler sweeps again (run g's gate is already open)
    assert.equal((await s.tick()).ran, true);
    assert.equal(g.calls(), 2);
    assert.equal(await sweepLockHolders(), 0);
  });

  test('stop() waits for an in-flight sweep; start() ticks on an unref()\'d timer and stop() ends it', async () => {
    const g = gatedRun();
    const s = make({ pool, run: g.run, log: silent() });
    const t = s.tick();
    await g.started;
    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false, 'stop() is still waiting for the sweep');
    g.finish();
    await stopping;
    assert.equal(stopped, true);
    assert.equal((await t).ran, true);
    // start(): a short interval, the timer does not keep the process alive, stop() clears it
    let runs = 0;
    const timed = make({ pool, intervalMs: 10, run: async () => { runs++; return { assets: [], failed: [] }; }, log: silent() });
    const realSetInterval = global.setInterval;
    let unrefd = false;
    global.setInterval = (...a) => { const h = realSetInterval(...a); const u = h.unref.bind(h); h.unref = () => { unrefd = true; return u(); }; return h; };
    try { timed.start(); timed.start(); } finally { global.setInterval = realSetInterval; }
    assert.equal(unrefd, true, 'the timer is unref()\'d');
    await waitFor(() => runs >= 2, 'two timed sweeps');
    await timed.stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runs, after, 'no tick after stop()');
    assert.equal(await sweepLockHolders(), 0);
    baseline(pool);
  });

  test('the real waitlist.sweep runs through tick() and reports { assets, failed }', async () => {
    const asset = await fx.insertRow(pool, 'assets', { tag: 'SW-1', name: 'Sweep me' });
    const emp = await fx.insertRow(pool, 'employees', { name: 'Sweeper' });
    await fx.insertRow(pool, 'waitlist_entries', { asset_id: asset.id, employee_id: emp.id, start_date: '2026-01-02', end_date: '2026-01-02', status: 'waiting', queue_seq: 1 });
    const orig = console.error; console.error = () => {};
    let r;
    try { r = await make({ pool, log: silent() }).tick(); } finally { console.error = orig; }
    assert.equal(r.ran, true);
    assert.deepEqual(r.result, { assets: [asset.id], failed: [] });
    assert.equal((await pool.query('SELECT status FROM waitlist_entries WHERE asset_id = $1', [asset.id])).rows[0].status, 'expired', 'the past range was recorded');
    baseline(pool);
  });
});
