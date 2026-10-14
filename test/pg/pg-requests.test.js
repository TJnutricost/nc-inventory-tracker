// src/pg/requests.js (D-46, Slice 3): the request state machine on PostgreSQL. Ports the module-level scenarios of
// test/requests.test.js, test/request-integrity.test.js and test/lifecycle.test.js; checks every (type, from, to) move
// against SQLite (src/requests.js) for the same answer; and proves the compare-and-set under real concurrency: when two
// writers act on the same request at once exactly one wins and the loser gets the same 400 as on SQLite.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { buildSqliteReference } = require('../../test-support/pg-parity');
const fx = require('../../test-support/pg-fixtures');
const { withTransaction } = require('../../src/pg/transaction');
const sqliteRules = require('../../src/requests');
const rules = require('../../src/pg/requests');

const JUST_UPDATED = 'This request was just updated by someone else. Reload and try again.';
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const outcome = (p) => Promise.resolve().then(p).then((v) => ({ ok: v }), (e) => ({ status: e.status, message: e.message }));
const row = async (q, id) => (await q.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0];

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('PostgreSQL requests', pgSuite(), () => {
  let tdb; let pool; let admin; let emp; let empAccount; let asset;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    admin = await fx.insertAccount(pool, { role: 'admin' });
    emp = await fx.insertEmployee(pool, { name: 'Requester' });
    empAccount = await fx.insertAccount(pool, { employee_id: emp.id });
    asset = await fx.insertAsset(pool);
  });
  after(async () => { await tdb?.drop(); });

  const newRequest = (cols = {}) => fx.insertRequest(pool, { user_id: emp.id, ...cols });

  test('every (type, from, to) move gives the same answer and the same resulting row shape as SQLite', async () => {
    const sqlite = buildSqliteReference();
    const sq = fx.sqliteExecutor(sqlite);
    try {
      const sqEmp = await fx.insertEmployee(sq, { name: 'Requester' });
      const sqAdmin = await fx.insertAccount(sq, { role: 'admin' });
      const statuses = ['open', 'approved', 'denied', 'dropped_off', 'completed', 'cancelled'];
      let checked = 0;
      for (const [type, from] of Object.entries(rules.TRANSITIONS)) {
        for (const status of Object.keys(from)) {
          for (const to of statuses) {
            // A fresh asset each time: at most one live return request per asset and employee.
            const pgReq = await newRequest({ type, status, asset_id: (await fx.insertAsset(pool)).id });
            const sqReq = await fx.insertRequest(sq, { type, status, user_id: sqEmp.id, asset_id: (await fx.insertAsset(sq)).id });
            const opts = { actorAccountId: null, actorIsAdmin: true, note: 'n', setNote: true };
            const pgOut = await outcome(() => rules.transition(pool, pgReq.id, to, { ...opts, actorAccountId: admin.id }));
            const sqOut = await outcome(() => sqliteRules.transition(sqlite, sqReq.id, to, { ...opts, actorAccountId: sqAdmin.id }));
            const label = `${type}: ${status} -> ${to}`;
            assert.equal('ok' in pgOut, rules.canTransition(type, status, to), label);
            if ('ok' in pgOut) {
              assert.ok('ok' in sqOut, label);
              const shape = (r) => ({ status: r.status, resolution_note: r.resolution_note, resolved: r.resolved_at !== null, resolvedBySet: r.resolved_by !== null, opened: r.opened_at !== null, keys: Object.keys(r).sort() });
              assert.deepEqual(shape(pgOut.ok), shape(sqOut.ok), label);
              if (pgOut.ok.resolved_at) assert.match(pgOut.ok.resolved_at, STAMP);
            } else {
              assert.deepEqual(pgOut, sqOut, label);
            }
            checked += 1;
          }
        }
      }
      assert.equal(checked, (5 + 4 + 3) * 6, 'every from-state of every type, to every status');
    } finally {
      sqlite.close();
    }
  });

  test('closed requests are terminal; illegal moves, a stale status and an unknown id are refused with SQLite\'s messages', async () => {
    for (const status of ['denied', 'completed', 'cancelled']) {
      const r = await newRequest({ status });
      const frozen = await row(pool, r.id);
      for (const to of ['approved', 'denied', 'cancelled', 'completed', 'dropped_off', 'open']) {
        assert.deepEqual(await outcome(() => rules.transition(pool, r.id, to, { actorIsAdmin: true })), { status: 400, message: 'This request is already closed' });
      }
      assert.deepEqual(await row(pool, r.id), frozen, `a ${status} request is untouched`);
    }
    const open = await newRequest();
    assert.deepEqual(await outcome(() => rules.transition(pool, open.id, 'dropped_off')), { status: 400, message: 'This request is not open' });
    assert.deepEqual(await outcome(() => rules.transition(pool, 999999, 'cancelled')), { status: 404, message: 'Request not found' });
    assert.deepEqual(await outcome(() => rules.transition(pool, 'abc', 'cancelled')), { status: 404, message: 'Request not found' });
    const denied = await rules.transition(pool, open.id, 'denied', { actorAccountId: admin.id, note: 'n', setNote: true });
    assert.equal(denied.resolution_note, 'n');
    assert.deepEqual(await outcome(() => rules.transition(pool, open.id, 'completed')), { status: 400, message: 'This request is already closed' });
  });

  test('approving acknowledges once with who/when and the note; the request can still be completed with an asset', async () => {
    const r = await newRequest({ category: 'Headset' });
    const approved = await rules.transition(pool, r.id, 'approved', { actorAccountId: admin.id, actorIsAdmin: true, note: 'Ordered', setNote: true });
    assert.deepEqual([approved.status, approved.resolution_note, approved.resolved_by], ['approved', 'Ordered', admin.id]);
    assert.match(approved.resolved_at, STAMP);
    assert.match(approved.opened_at, STAMP);
    assert.deepEqual(await outcome(() => rules.transition(pool, r.id, 'approved', { actorIsAdmin: true })), { status: 400, message: 'This request is not open' });
    const done = await rules.transition(pool, r.id, 'completed', { actorAccountId: admin.id, actorIsAdmin: true, assetId: asset.id });
    assert.deepEqual([done.status, done.asset_id, done.resolution_note], ['completed', asset.id, 'Ordered'], 'no setNote: the first note survives');
    assert.equal(done.opened_at, approved.opened_at, 'opened_at is set once and never overwritten');
  });

  test('return requests: drop-off is not a resolution and happens once; completion records who and when', async () => {
    const ret = await newRequest({ type: 'return', asset_id: (await fx.insertAsset(pool)).id });
    const dropped = await rules.transition(pool, ret.id, 'dropped_off', { actorAccountId: empAccount.id });
    assert.deepEqual([dropped.status, dropped.resolved_at, dropped.resolved_by, dropped.opened_at], ['dropped_off', null, null, null]);
    assert.deepEqual(await outcome(() => rules.transition(pool, ret.id, 'dropped_off')), { status: 400, message: 'This request is not open' });
    assert.deepEqual(await outcome(() => rules.transition(pool, ret.id, 'denied', { actorIsAdmin: true })), { status: 400, message: 'This request is not open' });
    const done = await rules.transition(pool, ret.id, 'completed', { actorAccountId: admin.id, actorIsAdmin: true });
    assert.equal(done.status, 'completed');
    assert.ok(done.resolved_at && done.resolved_by === admin.id);
  });

  test('opened_at: set once, only by an admin action or openRequest, never for a closed request', async () => {
    const r = await newRequest();
    const viaEmployee = await rules.transition(pool, r.id, 'cancelled', { actorAccountId: empAccount.id, requireUnopened: true });
    assert.equal(viaEmployee.opened_at, null, 'an employee action does not open a request');

    const live = await newRequest();
    const opened = await rules.openRequest(pool, live.id);
    assert.match(opened.opened_at, STAMP);
    assert.equal((await rules.openRequest(pool, live.id)).opened_at, opened.opened_at, 'opening again changes nothing');
    assert.equal((await rules.openRequest(pool, r.id)).opened_at, null, 'a closed request is not opened');
    await assert.rejects(rules.openRequest(pool, 999999), (e) => e.status === 404 && e.message === 'Request not found');
    const ret = await newRequest({ type: 'return', asset_id: (await fx.insertAsset(pool)).id, status: 'dropped_off' });
    assert.match((await rules.openRequest(pool, ret.id)).opened_at, STAMP, 'dropped_off is still live');
  });

  test('rescind: allowed until IT opens the request (requireUnopened), then refused with OPENED_MSG', async () => {
    const r = await newRequest();
    await rules.openRequest(pool, r.id);
    assert.deepEqual(await outcome(() => rules.transition(pool, r.id, 'cancelled', { actorAccountId: empAccount.id, requireUnopened: true })), { status: 400, message: rules.OPENED_MSG });
    assert.equal((await row(pool, r.id)).status, 'open');
    const fresh = await newRequest();
    const rescinded = await rules.transition(pool, fresh.id, 'cancelled', { actorAccountId: empAccount.id, requireUnopened: true });
    assert.equal(rescinded.status, 'cancelled');
    assert.equal(rescinded.resolved_by, empAccount.id);
  });

  test('lifecycle: submitted, in_review, approved, dropped_off, denied, fulfilled, rescinded vs cancelled', async () => {
    const lc = (r) => rules.lifecycle(pool, r);
    const base = { user_id: emp.id };
    assert.equal(await lc({ ...base, status: 'open', opened_at: null }), 'submitted');
    assert.equal(await lc({ ...base, status: 'open', opened_at: '2026-01-01 00:00:00' }), 'in_review');
    assert.equal(await lc({ ...base, status: 'approved' }), 'approved');
    assert.equal(await lc({ ...base, status: 'dropped_off' }), 'dropped_off');
    assert.equal(await lc({ ...base, status: 'denied' }), 'denied');
    assert.equal(await lc({ ...base, status: 'completed' }), 'fulfilled');
    assert.equal(await lc({ ...base, status: 'cancelled', resolved_by: empAccount.id }), 'rescinded', 'cancelled by their own login');
    assert.equal(await lc({ ...base, status: 'cancelled', resolved_by: admin.id }), 'cancelled', 'cancelled by IT');
    assert.equal(await lc({ ...base, status: 'cancelled', resolved_by: null }), 'cancelled');
    assert.equal(await lc({ ...base, status: 'mystery' }), 'mystery');

    const a = await newRequest(); const b = await newRequest();
    await rules.transition(pool, a.id, 'cancelled', { actorAccountId: empAccount.id, requireUnopened: true });
    await rules.transition(pool, b.id, 'cancelled', { actorAccountId: admin.id, actorIsAdmin: true });
    const list = await rules.withLifecycle(pool, [await row(pool, a.id), await row(pool, b.id)]);
    assert.deepEqual(list.map((r) => [r.id, r.lifecycle]), [[a.id, 'rescinded'], [b.id, 'cancelled']]);
    const one = await rules.withLifecycle(pool, await row(pool, a.id));
    assert.equal(one.lifecycle, 'rescinded');
    assert.equal(one.id, a.id);
  });

  test('completeEquipmentRequests: permanent asks need a permanent assignment; NULL type is completed by either; only this person and asset', async () => {
    const who = await fx.insertEmployee(pool);
    const other = await fx.insertEmployee(pool);
    const a = await fx.insertAsset(pool);
    const perm = await newRequest({ user_id: who.id, asset_id: a.id, requested_assignment_type: 'permanent' });
    const temp = await newRequest({ user_id: who.id, asset_id: a.id, requested_assignment_type: 'checkout' });
    const any = await newRequest({ user_id: who.id, asset_id: a.id, status: 'approved' });
    const others = await newRequest({ user_id: other.id, asset_id: a.id });
    const done = await rules.completeEquipmentRequests(pool, { employeeId: who.id, assetId: a.id, assignmentType: 'checkout', actorAccountId: admin.id, actorIsAdmin: true });
    assert.equal(done, 2);
    const st = async (r) => (await row(pool, r.id)).status;
    assert.deepEqual([await st(perm), await st(temp), await st(any), await st(others)], ['open', 'completed', 'completed', 'open']);
    assert.equal(await rules.completeEquipmentRequests(pool, { employeeId: who.id, assetId: a.id, assignmentType: 'permanent', actorAccountId: admin.id, actorIsAdmin: true }), 1);
    assert.equal(await st(perm), 'completed');
    assert.match((await row(pool, perm.id)).opened_at, STAMP);
  });

  test('completeReturnRequests: completes the live (open or dropped off) return of that asset + employee, on a pool or a transaction client', async () => {
    const who = await fx.insertEmployee(pool);
    const a = await fx.insertAsset(pool); const b = await fx.insertAsset(pool);
    const ra = await newRequest({ type: 'return', user_id: who.id, asset_id: a.id, status: 'dropped_off' });
    const rb = await newRequest({ type: 'return', user_id: who.id, asset_id: b.id });
    assert.equal(await rules.completeReturnRequests(pool, { employeeId: who.id, assetId: a.id, actorAccountId: admin.id, actorIsAdmin: true }), 1);
    assert.equal((await row(pool, ra.id)).status, 'completed');
    assert.equal((await row(pool, rb.id)).status, 'open');
    await assert.rejects(withTransaction(async (c) => {
      assert.equal(await rules.completeReturnRequests(c, { employeeId: who.id, assetId: b.id, actorAccountId: admin.id }), 1);
      throw new Error('roll back');
    }, pool), /roll back/);
    assert.equal((await row(pool, rb.id)).status, 'open', 'rolled back with its transaction');
    assert.equal(await withTransaction((c) => rules.completeReturnRequests(c, { employeeId: who.id, assetId: b.id, actorAccountId: admin.id }), pool), 1);
    assert.equal((await row(pool, rb.id)).status, 'completed');
    assert.equal(await rules.completeReturnRequests(pool, { employeeId: who.id, assetId: b.id, actorAccountId: admin.id }), 0);
  });

  // Both writers read status 'open' before either writes (a third connection holds the row lock until both are waiting),
  // so this is the real race: the compare-and-set is all that decides it.
  async function race(r, first, second) {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [r.id]);
      const pids = [];
      const run = (fn) => withTransaction(async (c) => { pids.push((await c.query('SELECT pg_backend_pid() AS p')).rows[0].p); return fn(c); }, pool);
      const results = [outcome(() => run(first)), outcome(() => run(second))];
      await waitFor(async () => pids.length === 2
        && (await pool.query("SELECT COUNT(*) c FROM pg_stat_activity WHERE pid = ANY($1) AND wait_event_type = 'Lock'", [pids])).rows[0].c === 2, 'both writers to wait on the row');
      await holder.query('COMMIT');
      return Promise.all(results);
    } finally {
      holder.release();
    }
  }

  test('concurrent approve vs cancel: exactly one wins, the loser gets the "just updated" 400, the row is coherent (repeated)', async () => {
    const tally = { approve: 0, cancel: 0 };
    for (let i = 0; i < 10; i++) {
      const a = await fx.insertAsset(pool);
      const r = await newRequest({ asset_id: a.id, requested_assignment_type: 'permanent' });
      const approve = (c) => rules.transition(c, r.id, 'completed', { actorAccountId: admin.id, actorIsAdmin: true, assetId: a.id });
      const cancel = (c) => rules.transition(c, r.id, 'cancelled', { actorAccountId: admin.id, actorIsAdmin: true });
      const [x, y] = i % 2 ? await race(r, cancel, approve) : await race(r, approve, cancel);
      const [ap, ca] = i % 2 ? [y, x] : [x, y];
      const winners = [ap, ca].filter((o) => 'ok' in o);
      assert.equal(winners.length, 1, `exactly one wins (round ${i})`);
      const loser = 'ok' in ap ? ca : ap;
      assert.deepEqual(loser, { status: 400, message: JUST_UPDATED });
      const final = await row(pool, r.id);
      assert.equal(final.status, 'ok' in ap ? 'completed' : 'cancelled');
      tally['ok' in ap ? 'approve' : 'cancel'] += 1;
    }
    assert.equal(tally.approve + tally.cancel, 10);
  });

  test('concurrent approve vs the employee\'s rescind: one wins; a losing rescind is told IT opened it, a losing approve is told it was just updated', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await newRequest();
      const approve = (c) => rules.transition(c, r.id, 'approved', { actorAccountId: admin.id, actorIsAdmin: true });
      const rescind = (c) => rules.transition(c, r.id, 'cancelled', { actorAccountId: empAccount.id, requireUnopened: true });
      const [x, y] = i % 2 ? await race(r, rescind, approve) : await race(r, approve, rescind);
      const [ap, re] = i % 2 ? [y, x] : [x, y];
      assert.equal(['ok' in ap, 'ok' in re].filter(Boolean).length, 1);
      if ('ok' in ap) assert.deepEqual(re, { status: 400, message: rules.OPENED_MSG });
      else assert.deepEqual(ap, { status: 400, message: JUST_UPDATED });
      const final = await row(pool, r.id);
      assert.equal(final.status, 'ok' in ap ? 'approved' : 'cancelled');
      assert.equal(final.opened_at !== null, 'ok' in ap, 'opened only if the admin won');
    }
  });

  test('an unsynchronized burst of simultaneous closes on one request still yields exactly one winner', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await newRequest();
      const outcomes = await Promise.all(['denied', 'cancelled', 'completed', 'denied'].map((to) => outcome(() => rules.transition(pool, r.id, to, { actorAccountId: admin.id, actorIsAdmin: true }))));
      assert.equal(outcomes.filter((o) => 'ok' in o).length, 1, JSON.stringify(outcomes));
      for (const o of outcomes.filter((x) => !('ok' in x))) assert.ok([JUST_UPDATED, 'This request is already closed'].includes(o.message), o.message);
    }
    assert.equal(pool.waitingCount, 0);
  });
});
