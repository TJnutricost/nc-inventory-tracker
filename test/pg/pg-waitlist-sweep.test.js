// The Slice 4C sweep and the lock ordering of the waitlist actions (D-46, D-47 point 2). A query spy (per checkout, with
// parameters) shows that the global sweep runs ONE transaction per asset in ascending asset id order, each opening with that
// asset's FOR UPDATE and never taking a second asset lock; that a failure on one asset (an injected trigger) is logged and
// reported in `failed` without rolling back or skipping the others, and the sweep never throws; that concurrent sweeps neither
// deadlock nor offer anything twice; and that every new request path does at most ONE unlocked id -> asset lookup, then runs
// its due step and its main transaction each opening with the asset's FOR UPDATE (one asset per transaction), with nothing
// else outside a transaction. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { spyPool, oneLine, installHoldMailNotifier } = require('../../test-support/pg-write-support');
const { syncSequences } = require('../../test-support/pg-twin');
const fx = require('../../test-support/pg-fixtures');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const effects = require('../../src/pg/effects');
const waitlist = require('../../src/pg/waitlist');

const FOR_UPDATE = 'SELECT * FROM assets WHERE id = $1 FOR UPDATE';
const LOOKUP = 'SELECT asset_id FROM waitlist_entries WHERE id = $1';
const SCAN = "SELECT DISTINCT asset_id FROM waitlist_entries WHERE status IN ('waiting','held') ORDER BY asset_id";
const LAPSED = '2026-01-01 00:00:00';
const LIVE = '2999-12-31 00:00:00';
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.join(' ')); try { await fn(); } finally { console.error = orig; } return seen; };

// The spy's statements grouped per checkout (= per transaction here), plus the statements run on the pool itself.
function transactions(calls) {
  const out = new Map();
  for (const c of calls) {
    if (!c.client) continue;
    if (!out.has(c.client)) out.set(c.client, []);
    out.get(c.client).push({ sql: oneLine(c.sql), params: c.params });
  }
  return [...out.values()];
}
const onPool = (calls) => calls.filter((c) => !c.client).map((c) => oneLine(c.sql));
// Every transaction: BEGIN, the asset's FOR UPDATE, ..., COMMIT/ROLLBACK, with no second FOR UPDATE. Returns the locked ids.
function assertLockFirst(txs, label) {
  return txs.map((tx) => {
    const sqls = tx.map((s) => s.sql);
    assert.equal(sqls[0], 'BEGIN', `${label}: BEGIN\n${sqls.join('\n')}`);
    assert.equal(sqls[1], FOR_UPDATE, `${label}: the asset lock is the first statement of the transaction\n${sqls.join('\n')}`);
    assert.equal(sqls.filter((s) => s === FOR_UPDATE).length, 1, `${label}: one asset per transaction`);
    assert.ok(['COMMIT', 'ROLLBACK'].includes(sqls.at(-1)), `${label}: ends`);
    return Number(tx[1].params[0]);
  });
}

describe('PostgreSQL waitlist sweep and lock ordering (Slice 4C)', pgSuite(), () => {
  let tdb; let pool; let today; let ana; let anaAcct; let fay; let fayAcct; let ben;
  const d = (n) => T.addDays(today, n);
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    today = await pgTime.today(pool);
    ana = await fx.insertEmployee(pool, { name: 'Ana Sweep' });
    anaAcct = await fx.insertAccount(pool, { employee_id: ana.id });
    fay = await fx.insertEmployee(pool, { name: 'Fay Sweep' });
    fayAcct = await fx.insertAccount(pool, { employee_id: fay.id });
    ben = await fx.insertEmployee(pool, { name: 'Ben Sweep' });
  });
  afterEach(async () => { await effects.whenIdle(); effects.setNotifier(null); });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });

  const asset = () => fx.insertAsset(pool, { available_to_request: 1 });
  const entry = (cols) => fx.insertWaitlistEntry(pool, { end_date: cols.start_date, ...cols });
  const status = async (id) => (await pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [id])).rows[0].status;
  // An asset with a lapsed hold and someone waiting behind it (the sweep has something to record and to offer).
  async function due() {
    const a = await asset();
    const h = await entry({ asset_id: a.id, employee_id: ana.id, start_date: d(5), status: 'held', hold_started_at: LAPSED, hold_expires_at: LAPSED, hold_email_at: LAPSED, queue_seq: 1 });
    const f = await entry({ asset_id: a.id, employee_id: fay.id, start_date: d(5), queue_seq: 2 });
    return { a, h, f };
  }

  test('the sweep: one transaction per asset, ascending asset id, each locking its asset first and only it; then the hold emails, outside any transaction', async () => {
    const xs = [await due(), await due(), await due()];
    await syncSequences(pool);
    installHoldMailNotifier(pool);
    const s = spyPool(pool);
    const result = await waitlist.sweep(s.pool);
    assert.deepEqual(result.failed, []);
    for (const x of xs) assert.ok(result.assets.includes(x.a.id));
    const txs = transactions(s.calls);
    const locked = assertLockFirst(txs, 'sweep');
    assert.deepEqual(locked, result.assets, 'one transaction per asset, in the scan\'s order');
    assert.deepEqual(locked, [...locked].sort((x, y) => x - y), 'ascending asset id');
    assert.ok(txs.every((tx) => tx.at(-1).sql === 'COMMIT'));
    const loose = onPool(s.calls);
    assert.equal(loose[0], SCAN, 'the unlocked scan only picks the assets');
    assert.ok(loose.slice(1).every((q) => q.startsWith('SELECT id FROM waitlist_entries WHERE status = \'held\' AND hold_email_at IS NULL') || q.startsWith('UPDATE waitlist_entries SET hold_email_at')),
      `outside a transaction: only the scan and the hold-email claims\n${loose.join('\n')}`);
    await effects.whenIdle();
    for (const x of xs) assert.deepEqual([await status(x.h.id), await status(x.f.id)], ['expired', 'held']);
  });

  test('a failing asset is logged and reported, and neither rolls back nor stops the others; the sweep never throws', async () => {
    const [x1, x2, x3] = [await due(), await due(), await due()];
    await syncSequences(pool);
    await pool.query("CREATE OR REPLACE FUNCTION nc_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    await pool.query(`CREATE TRIGGER nc_fail_sweep BEFORE INSERT ON activity FOR EACH ROW WHEN (NEW.asset_id = ${x2.a.id} AND NEW.action = 'waitlist_hold_started') EXECUTE FUNCTION nc_test_fail()`);
    let result;
    const logged = await quietly(async () => { result = await waitlist.sweep(pool); });
    await pool.query('DROP TRIGGER nc_fail_sweep ON activity');
    assert.deepEqual(result.failed, [{ assetId: x2.a.id, message: 'injected failure' }]);
    assert.ok(logged.some((l) => l.startsWith('[waitlist:sweep]') && l.includes(`asset ${x2.a.id}`) && l.includes('injected failure')), logged.join('\n'));
    assert.deepEqual([await status(x1.h.id), await status(x1.f.id)], ['expired', 'held'], 'the asset before it committed');
    assert.deepEqual([await status(x3.h.id), await status(x3.f.id)], ['expired', 'held'], 'the asset after it still ran');
    assert.deepEqual([await status(x2.h.id), await status(x2.f.id)], ['held', 'waiting'], 'the failing asset rolled back as a whole (its expiry too)');
    assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM activity WHERE asset_id = $1', [x2.a.id])).rows[0].c), 0);
    const again = await waitlist.sweep(pool);
    assert.deepEqual(again.failed, []);
    assert.deepEqual([await status(x2.h.id), await status(x2.f.id)], ['expired', 'held'], 'the next sweep records it');
    // a sweep whose scan itself fails still resolves
    const broken = { query: async () => { throw new Error('connection lost'); }, connect: async () => { throw new Error('connection lost'); } };
    let r;
    const logged2 = await quietly(async () => { r = await waitlist.sweep(broken); });
    assert.deepEqual(r, { assets: [], failed: [{ assetId: null, message: 'connection lost' }] });
    assert.ok(logged2.some((l) => l.startsWith('[waitlist:sweep]')));
  });

  test('concurrent sweeps over several assets: no deadlock, nothing offered twice, every asset settled', async () => {
    const xs = [];
    for (let i = 0; i < 4; i++) {
      const x = await due();
      x.g = await entry({ asset_id: x.a.id, employee_id: ben.id, start_date: d(5), end_date: d(6), queue_seq: 3 });
      xs.push(x);
    }
    await syncSequences(pool);
    const results = await Promise.all([waitlist.sweep(pool), waitlist.sweep(pool), waitlist.sweep(pool)]);
    for (const r of results) assert.deepEqual(r.failed, []);
    for (const x of xs) {
      assert.deepEqual([await status(x.h.id), await status(x.f.id)], ['expired', 'held']);
      const offers = (await pool.query("SELECT subject_user_id, COUNT(*)::int n FROM activity WHERE asset_id = $1 AND action = 'waitlist_hold_started' GROUP BY subject_user_id ORDER BY 1", [x.a.id])).rows;
      assert.ok(offers.every((o) => o.n === 1), `asset ${x.a.id}: each offer made once`);
      assert.equal(Number((await pool.query("SELECT COUNT(*) c FROM activity WHERE asset_id = $1 AND action = 'waitlist_expired'", [x.a.id])).rows[0].c), 1, 'the lapse recorded once');
    }
  });

  test('processDue(pool, assetId) handles that asset only; processDue(pool) every asset with an open entry', async () => {
    const x = await due(); const y = await due();
    await syncSequences(pool);
    const s = spyPool(pool);
    assert.deepEqual(await waitlist.processDue(s.pool, x.a.id), { assets: [x.a.id], failed: [] });
    assert.deepEqual(assertLockFirst(transactions(s.calls), 'processDue(asset)'), [x.a.id]);
    assert.deepEqual(onPool(s.calls), [], 'no scan for one asset');
    assert.deepEqual([await status(x.h.id), await status(y.h.id)], ['expired', 'held']);
    let r;
    await quietly(async () => { r = await waitlist.processDue(pool, 999999); });
    assert.deepEqual(r.failed.map((f) => f.assetId), [999999], 'an asset that does not exist is reported, not thrown');
  });

  test('every waitlist action: at most one unlocked id -> asset lookup, then the due step and the main transaction, each opening with the asset lock', async () => {
    const a = await asset();
    await fx.insertReservation(pool, { asset_id: a.id, employee_id: ben.id, start_date: d(3), end_date: d(8), status: 'confirmed', requires_approval: 0 });
    await syncSequences(pool);
    const runs = {};
    const spied = async (name, fn) => { const s = spyPool(pool); runs[name] = { result: await fn(s.pool), calls: s.calls }; return runs[name].result; };
    const joined = await spied('join', (p) => waitlist.join(p, { assetId: a.id, employeeId: ana.id, actorAccountId: anaAcct.id, start: d(4), end: d(4) }));
    await spied('updateDates', (p) => waitlist.updateDates(p, joined.entry.id, { employeeId: ana.id, actorAccountId: anaAcct.id, start: d(5), end: d(5) }));
    await spied('leave', (p) => waitlist.leave(p, joined.entry.id, { employeeId: ana.id, actorAccountId: anaAcct.id, isAdmin: false }));
    const b = await asset();
    const h = await entry({ asset_id: b.id, employee_id: ana.id, start_date: d(5), status: 'held', hold_started_at: LAPSED, hold_expires_at: LIVE, hold_email_at: LAPSED, queue_seq: 1 });
    const h2 = await entry({ asset_id: b.id, employee_id: fay.id, start_date: d(7), status: 'held', hold_started_at: LAPSED, hold_expires_at: LIVE, hold_email_at: LAPSED, queue_seq: 2 });
    await spied('confirmHold', (p) => waitlist.confirmHold(p, h.id, { employeeId: ana.id, actorAccountId: anaAcct.id }));
    await spied('declineHold', (p) => waitlist.declineHold(p, h2.id, { employeeId: fay.id, actorAccountId: fayAcct.id }));
    for (const [name, { calls }] of Object.entries(runs)) {
      const loose = onPool(calls);
      assert.deepEqual(loose, name === 'join' ? [] : [LOOKUP], `${name}: outside a transaction only the id -> asset lookup`);
      if (name !== 'join') assert.equal(calls[0].sql, LOOKUP, `${name}: the lookup comes first`);
      const txs = transactions(calls);
      assert.equal(txs.length, 2, `${name}: the due step, then the action`);
      const locked = assertLockFirst(txs, name);
      assert.deepEqual(locked, name === 'join' || name === 'updateDates' || name === 'leave' ? [a.id, a.id] : [b.id, b.id], `${name}: the same asset, twice`);
      assert.ok(txs.every((tx) => tx.at(-1).sql === 'COMMIT'), name);
    }
    // a refused request: the due step still commits, the main transaction rolls back
    const s = spyPool(pool);
    await assert.rejects(waitlist.confirmHold(s.pool, h.id, { employeeId: ana.id, actorAccountId: anaAcct.id }), { status: 400 });
    const txs = transactions(s.calls);
    assertLockFirst(txs, 'refused confirm');
    assert.deepEqual(txs.map((tx) => tx.at(-1).sql), ['COMMIT', 'ROLLBACK']);
  });
});
