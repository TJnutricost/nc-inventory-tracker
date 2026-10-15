// After-commit effects (D-47, Slice 4B): src/pg/effects.js and the effects the write paths register. Effects fire only after
// COMMIT (the row is visible and the asset lock is free while the notifier runs), in registration order, exactly once; a
// refused or rolled-back transaction fires nothing; a throwing or rejecting notifier never surfaces and never touches
// committed state; inside a caller's transaction they fire once at ITS commit; holds_owed fires only when a hold was granted
// and at most once per asset per transaction; a slow notifier never holds the lock (a second transaction on the same asset
// completes while the notifier is blocked on a test-controlled gate: no timers or sleeps); and the emails the effects stand
// for are the emails SQLite sends for the same create (its mailer's outbox: same people, same kinds, same ranges, same order).
// Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, outcome } = require('../../test-support/pg-write-support');
const sqliteMail = prepareSqliteMail();

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const effects = require('../../src/pg/effects');
const sqliteReservations = require('../../src/reservations');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.join(' ')); try { await fn(); } finally { console.error = orig; } return seen; };

describe('PostgreSQL after-commit effects (Slice 4B)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);
  const req = (cols = {}) => tw.asset({ available_to_request: 1, ...cols });

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Asker', department: 'Ops', work_email: 'ana@example.com' });
    w.ben = await tw.employee({ name: 'Ben Booker', work_email: 'ben@example.com' });
    w.dee = await tw.employee({ name: 'Dee Third' }); // no work email: reached through her login
    w.eve = await tw.employee({ name: 'Eve No Email' }); // no email at all
    w.anaAcct = await tw.insert('accounts', { login_email: 'ana.login@example.com', role: 'employee', employee_id: w.ana.id });
    await tw.insert('accounts', { login_email: 'dee.login@example.com', role: 'employee', employee_id: w.dee.id });
  });
  afterEach(async () => { await effects.whenIdle(); effects.setNotifier(null); });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    tw?.close();
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  test('the module: needs a transaction, plain objects, a function or null notifier; order, once, only on COMMIT', async () => {
    assert.throws(() => effects.registerEffect(pool, { type: 'x' }), /inside withTransaction/);
    assert.throws(() => effects.setNotifier('mailer'), TypeError);
    await withTransaction(async (c) => assert.throws(() => effects.registerEffect(c, { nope: 1 }), TypeError), pool);
    const got = [];
    effects.setNotifier((e) => { got.push(e); });
    await withTransaction(async (c) => {
      effects.registerEffect(c, { type: 'a', n: 1 });
      effects.registerEffect(c, { type: 'holds_owed', assetId: 7 });
      effects.registerEffect(c, { type: 'b', n: 2 });
      effects.registerEffect(c, { type: 'holds_owed', assetId: 7 }); // at most one per asset per transaction
      effects.registerEffect(c, { type: 'holds_owed', assetId: 8 });
      assert.deepEqual(got, [], 'nothing before COMMIT');
    }, pool);
    assert.deepEqual(got, [], 'nothing synchronously at COMMIT either: dispatch starts on a later turn');
    await effects.whenIdle();
    assert.deepEqual(got, [{ type: 'a', n: 1 }, { type: 'holds_owed', assetId: 7 }, { type: 'b', n: 2 }, { type: 'holds_owed', assetId: 8 }]);
    await assert.rejects(withTransaction(async (c) => { effects.registerEffect(c, { type: 'c' }); throw new Error('rolled back'); }, pool), /rolled back/);
    await effects.whenIdle();
    assert.equal(got.length, 4, 'a rolled-back transaction fires nothing');
    await withTransaction(async (c) => effects.registerEffect(c, { type: 'next' }), pool);
    await effects.whenIdle();
    assert.deepEqual(got.at(-1), { type: 'next' }, 'the next transaction starts with an empty list');
    effects.setNotifier(null);
    await withTransaction(async (c) => effects.registerEffect(c, { type: 'nobody listens' }), pool); // the default no-op
    await effects.whenIdle();
  });

  test('create: waitlist_joined per distinct reserver, then request_recorded, after COMMIT with the lock free; a refusal fires nothing', async () => {
    const a = await req({ name: 'Effects create' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(4) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(6) });
    await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(8) });
    await tw.syncSequences();
    const seen = [];
    effects.setNotifier(async (e) => {
      // after COMMIT: the rows are visible to another connection, and nobody holds the asset lock
      const rows = Number((await pool.query('SELECT COUNT(*) c FROM reservations WHERE asset_id = $1 AND employee_id = $2', [a.id, w.ana.id])).rows[0].c);
      const free = await pool.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [a.id]).then(() => true, () => false);
      seen.push({ e, rows, free });
    });
    const r = await reservations.create(pool, { assetId: a.id, employeeId: w.ana.id, actorAccountId: w.anaAcct.id, start: d(3), end: d(9) });
    await effects.whenIdle();
    assert.deepEqual(seen.map((s) => s.e.type), ['waitlist_joined', 'waitlist_joined', 'request_recorded']);
    assert.ok(seen.every((s) => s.rows === r.reserved.length && s.free), 'dispatched after COMMIT, with the asset lock released');
    assert.deepEqual(seen.map((s) => s.e.reserver && s.e.reserver.employee_id), [w.ben.id, w.dee.id, undefined], 'Ben once although he has two reservations in the way');
    assert.deepEqual(seen[0].e.entry, r.waitlisted[0]);
    assert.deepEqual(seen[1].e.entry, r.waitlisted[2], 'the entry that overlaps that reserver');
    assert.deepEqual(seen[2].e, { type: 'request_recorded', employeeId: w.ana.id, assetId: a.id, requested: r.requested, reserved: r.reserved, waitlisted: r.waitlisted }, 'describes exactly what was written');
    seen.length = 0;
    const refused = await outcome(() => reservations.create(pool, { assetId: a.id, employeeId: w.ana.id, actorAccountId: w.anaAcct.id, start: d(4), end: d(4) }));
    assert.equal(refused.error.status, 409);
    await effects.whenIdle();
    assert.deepEqual(seen, [], 'a refused create fires nothing');
  });

  test('a throwing or rejecting notifier never surfaces and never touches committed state', async () => {
    const a = await req({ name: 'Effects throw' });
    await tw.syncSequences();
    for (const bad of [() => { throw new Error('smtp down'); }, async () => { throw new Error('smtp rejected'); }]) {
      effects.setNotifier(bad);
      let r;
      const logged = await quietly(async () => {
        r = await reservations.create(pool, { assetId: a.id, employeeId: w.ana.id, actorAccountId: w.anaAcct.id, start: d(3), end: d(3) }).catch((e) => e);
        await effects.whenIdle();
      });
      assert.ok(!(r instanceof Error), 'the caller got its result');
      assert.ok(logged.some((l) => l.startsWith('[effects] request_recorded')), 'the failure was logged');
      assert.equal((await pool.query('SELECT status FROM reservations WHERE id = $1', [r.reserved[0].id])).rows[0].status, 'confirmed', 'committed state stands');
      await pool.query("UPDATE reservations SET status = 'cancelled', cancelled_at = '2026-01-01 00:00:00' WHERE id = $1", [r.reserved[0].id]);
    }
  });

  test('inside a caller\'s transaction: everything fires once at its COMMIT, nothing if it rolls back; holds_owed only on a grant, once per asset', async () => {
    const got = [];
    effects.setNotifier((e) => { got.push(e.type); });
    const a = await req({ name: 'Effects outer' });
    await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), queue_seq: 1 });
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(6), queue_seq: 2 });
    await tw.syncSequences();
    const by = { employeeId: w.ana.id, actorAccountId: w.anaAcct.id };
    // rolled back: create + cancel in one transaction, then a failure
    await assert.rejects(withTransaction(async (c) => {
      const r = await reservations.create(c, { assetId: a.id, ...by, start: d(5), end: d(6) });
      await reservations.cancel(c, r.reserved[0].id, by);
      throw new Error('caller failed afterwards');
    }, pool), /caller failed/);
    await effects.whenIdle();
    assert.deepEqual(got, [], 'nothing fires when the outer transaction rolls back');
    assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM reservations WHERE asset_id = $1', [a.id])).rows[0].c), 0);
    // committed: the cancel grants TWO holds (two waiters): one holds_owed
    await withTransaction(async (c) => {
      const r = await reservations.create(c, { assetId: a.id, ...by, start: d(5), end: d(6) });
      await reservations.cancel(c, r.reserved[0].id, by);
      assert.deepEqual(got, [], 'not before the outer COMMIT');
    }, pool);
    await effects.whenIdle();
    assert.deepEqual(got, ['request_recorded', 'holds_owed']);
    assert.equal(Number((await pool.query("SELECT COUNT(*) c FROM waitlist_entries WHERE asset_id = $1 AND status = 'held'", [a.id])).rows[0].c), 2);
    // two grants in two evaluations of one transaction: still one holds_owed
    got.length = 0;
    const b = await req({ name: 'Effects twice' });
    await tw.entry({ asset_id: b.id, employee_id: w.ben.id, start_date: d(5), queue_seq: 1 });
    await tw.syncSequences();
    await withTransaction(async (c) => {
      await lockAsset(c, b.id);
      assert.equal((await waitlist.evaluateAsset(c, b.id)).length, 1);
      await waitlist.insertEntry(c, { assetId: b.id, employeeId: w.dee.id, actorAccountId: null, range: { start_date: d(7), end_date: d(7) } });
      assert.equal((await waitlist.evaluateAsset(c, b.id)).length, 1);
      assert.equal((await waitlist.evaluateAsset(c, b.id)).length, 0);
    }, pool);
    await effects.whenIdle();
    assert.deepEqual(got, ['holds_owed']);
    // a release with nobody waiting: no holds_owed
    got.length = 0;
    const r = await reservations.create(pool, { assetId: b.id, ...by, start: d(20), end: d(20) });
    await reservations.cancel(pool, r.reserved[0].id, by);
    await effects.whenIdle();
    assert.deepEqual(got, ['request_recorded'], 'cancel granted nothing, so it owes no hold email');
  });

  test('a slow notifier never holds the asset lock: a second transaction on the same asset completes while it is blocked', async () => {
    const a = await req({ name: 'Effects slow' });
    await tw.syncSequences();
    const gate = deferred(); const entered = deferred();
    const done = [];
    effects.setNotifier(async (e) => { entered.resolve(); await gate.promise; done.push(e.type); });
    const by = { employeeId: w.ana.id, actorAccountId: w.anaAcct.id };
    const first = await reservations.create(pool, { assetId: a.id, ...by, start: d(3), end: d(3) });
    await entered.promise; // the notifier is now running and blocked
    const second = await reservations.create(pool, { assetId: a.id, ...by, start: d(4), end: d(4) }); // same asset, completes
    assert.equal(second.reserved[0].status, 'confirmed');
    const third = await withTransaction(async (c) => { await lockAsset(c, a.id); return 'locked'; }, pool);
    assert.equal(third, 'locked');
    assert.deepEqual(done, [], 'the notifier is still blocked');
    gate.resolve();
    await effects.whenIdle();
    assert.deepEqual(done, ['request_recorded', 'request_recorded']);
    assert.ok(first.reserved[0].id < second.reserved[0].id);
  });

  test('the effects are the emails SQLite sends for the same create (people, kinds, ranges, order)', async () => {
    const resolve = async (e) => {
      if (e.type === 'request_recorded') return { to: (await reservations.emailOf(pool, e.employeeId)).email, kind: 'request_recorded', range: T.when(e.requested, { allDay: true }) };
      if (e.type === 'waitlist_joined') return { to: (await reservations.emailOf(pool, e.reserver.employee_id)).email, kind: 'waitlist_joined', range: T.when(e.entry, { allDay: true }) };
      return null;
    };
    const kindOf = (subject) => (/^Another team is waiting/.test(subject) ? 'waitlist_joined' : 'request_recorded');
    const scenario = async (label, requester, rows, args) => {
      const a = await req({ name: `Mail ${label}`, ...(args.asset || {}) });
      for (const r of rows) await tw.reservation({ asset_id: a.id, ...r });
      await tw.syncSequences();
      const call = { assetId: a.id, employeeId: requester.id, actorAccountId: w.anaAcct.id, start: args.start, end: args.end, startTime: args.startTime, endTime: args.endTime };
      const pgEffects = [];
      effects.setNotifier((e) => { pgEffects.push(e); });
      await reservations.create(pool, call);
      await effects.whenIdle();
      const fromPg = [];
      for (const e of pgEffects) { const m = await resolve(e); if (m && m.to) fromPg.push(m); }
      const before = sqliteMail.outbox().length;
      sqliteReservations.create(tw.sqlite, call);
      const fromSqlite = sqliteMail.outbox().slice(before).map((m) => ({ to: m.to_addr, kind: kindOf(m.subject), id: m.id }));
      const bodies = require('../../src/db').db.prepare('SELECT id, body FROM outbox WHERE id > ? ORDER BY id').all(fromSqlite[0] ? fromSqlite[0].id - 1 : 1e12);
      assert.deepEqual(fromPg.map(({ to, kind }) => ({ to, kind })), fromSqlite.map(({ to, kind }) => ({ to, kind })), `${label}: same emails`);
      fromPg.forEach((m, i) => assert.ok(bodies[i].body.includes(m.range), `${label}: email ${i + 1} is about ${m.range}`));
      return fromPg.length;
    };
    assert.equal(await scenario('all free', w.ana, [], { start: d(3), end: d(4) }), 1);
    assert.equal(await scenario('pending (approval)', w.ana, [], { start: d(3), end: d(3), asset: { reservation_requires_approval: 1 } }), 1);
    assert.equal(await scenario('partial, two reservers (one twice), one reached by login', w.ana,
      [{ employee_id: w.ben.id, start_date: d(4) }, { employee_id: w.ben.id, start_date: d(6) }, { employee_id: w.dee.id, start_date: d(8) }], { start: d(3), end: d(9) }), 3);
    assert.equal(await scenario('a reserver with no email gets nothing', w.ana, [{ employee_id: w.eve.id, start_date: d(4), start_time: '08:00', end_time: '12:00' }],
      { start: d(4), end: d(4), startTime: '06:00', endTime: '14:00' }), 1);
    assert.equal(await scenario('a requester with no email gets nothing', w.eve, [{ employee_id: w.ben.id, start_date: d(5) }], { start: d(4), end: d(6) }), 1);
  });
});
