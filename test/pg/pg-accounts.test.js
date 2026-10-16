// Slice 5C-3 (D-46, D-48): src/pg/accounts.js, differential against src/accounts.js, plus its transactions and the races it closes.
// Every fixture row is written to BOTH engines with the same ids (test-support/pg-twin.js); reads must give deep-equal results and
// writes deep-equal tables (test-support/pg-auth-support.js). Fixtures: active / inactive accounts, an inactive employee, an account
// without an employee, no password, admin vs employee, mixed-case / non-ASCII / padded emails, live / expired / other-purpose tokens.
// Where the route checks before it writes (setup's account count), the SQLite side is that route check + the SQLite write.
// Races (PostgreSQL only; test-support/pg-auth-support.js overlap): two simultaneous setups (exactly one admin), two resets with the
// same token (exactly one wins), two simultaneous invites (exactly one live token). Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const fx = require('../../test-support/pg-fixtures');
const { result, tables, overlap } = require('../../test-support/pg-auth-support');
const { withTransaction } = require('../../src/pg/transaction');

const sq = require('../../src/accounts');
const pg = require('../../src/pg/accounts');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const LATER = '2999-01-01T00:00:00.000Z';
const PAST = '2001-01-01T00:00:00.000Z';
// POST /api/setup's check before the write (src/server.js), on SQLite.
const sqSetup = (db, args) => { if (sq.accountCount(db) > 0) throw httpError(400, 'Setup already completed'); return sq.createFirstAdmin(db, args); };

describe('PostgreSQL accounts twin (differential against src/accounts.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  const same = (label, name, ...args) => tw.same(label, (q) => pg[name](q, ...args), (db) => sq[name](db, ...args));
  // A write on both engines (same next ids), the same outcome, then the same tables.
  async function write(label, pgFn, sqFn) {
    await tw.syncSequences();
    const pgOut = await result(() => pgFn(tw.pg));
    const sqOut = await result(() => sqFn(tw.sqlite));
    assert.deepEqual(pgOut, sqOut, label);
    await tables(tw, label);
    return pgOut;
  }
  const token = async (row) => { await fx.insertRow(tw.pg, 'tokens', row); await fx.insertRow(tw.sq, 'tokens', row); };

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('first-run setup: zero accounts, a failing setup leaves nothing, then one admin; a second setup is refused', async () => {
    assert.deepEqual(await same('count empty', 'accountCount'), { ok: 0 });
    assert.deepEqual(await write('setup without an email (rolls back)', (q) => pg.createFirstAdmin(q, { name: 'Root', mail: null, hash: 'h' }),
      (db) => sqSetup(db, { name: 'Root', mail: null, hash: 'h' })), { raw: true });
    assert.equal((await tw.pg.query('SELECT COUNT(*) AS n FROM employees')).rows[0].n, 0, 'no half-created admin');
    const args = { name: 'Root Admin', mail: 'root@nutricost.com', hash: '$2b$10$root' };
    const made = await write('setup', (q) => pg.createFirstAdmin(q, args), (db) => sqSetup(db, args));
    assert.equal(typeof made.ok, 'number');
    assert.deepEqual(await same('count one', 'accountCount'), { ok: 1 });
    const t = await tables(tw, 'after setup');
    assert.deepEqual([t.employees[0].department, t.accounts[0].role, t.accounts[0].employee_id], ['IT', 'admin', t.employees[0].id]);
    assert.deepEqual(await write('second setup', (q) => pg.createFirstAdmin(q, args), (db) => sqSetup(db, args)),
      { error: { status: 400, message: 'Setup already completed' } });
    w.root = made.ok;
  });

  test('currentUser, loginAccount, resetAccount: active rules, ASCII-only case folding, odd ids and inputs', async () => {
    const ana = await tw.employee({ name: 'Ana', work_email: 'ana@nutricost.com', department: 'R&D', title: 'Lead', phone: '1', building: 'B2', can_self_checkout: 0 });
    const gone = await tw.employee({ name: 'Gone', status: 'inactive' });
    const emile = await tw.employee({ name: 'Émile' });
    const nologin = await tw.employee({ name: 'No Login' });
    w.ana = await tw.insert('accounts', { employee_id: ana.id, login_email: 'Ana.Admin@Nutricost.com', password_hash: 'h-ana', role: 'admin', last_login_at: '2026-01-02 03:04:05' });
    w.off = await tw.insert('accounts', { employee_id: nologin.id, login_email: 'off@nutricost.com', password_hash: 'h-off', active: 0 });
    w.gone = await tw.insert('accounts', { employee_id: gone.id, login_email: 'gone@nutricost.com', password_hash: 'h-gone' });
    w.emile = await tw.insert('accounts', { employee_id: emile.id, login_email: 'ÉMILE@nutricost.com', password_hash: 'h-emile' });
    w.robot = await tw.insert('accounts', { employee_id: null, login_email: 'robot@nutricost.com', role: 'admin' });
    const ids = [w.root, w.ana.id, w.off.id, w.gone.id, w.emile.id, w.robot.id, 999999, 0, null, undefined, '', 'abc', '1.5', 1.5, String(w.ana.id), 2 ** 40];
    for (const id of ids) await same(`currentUser ${id}`, 'currentUser', id);
    const me = (await same('ana', 'currentUser', w.ana.id)).ok;
    assert.deepEqual([me.name, me.email, me.building, me.can_self_checkout, me.last_login_at], ['Ana', 'Ana.Admin@Nutricost.com', 'B2', 0, '2026-01-02 03:04:05']);
    const robot = (await same('robot', 'currentUser', w.robot.id)).ok;
    assert.deepEqual([robot.name, robot.employee_id, robot.can_self_checkout, robot.created_at], ['robot@nutricost.com', null, 0, null]);
    for (const id of [w.off.id, w.gone.id, null]) assert.equal((await same(`nobody ${id}`, 'currentUser', id)).ok, null);

    const emails = ['ana.admin@nutricost.com', 'ANA.ADMIN@NUTRICOST.COM', 'Ana.Admin@Nutricost.com', ' ana.admin@nutricost.com', 'ana.admin@nutricost.com ',
      'off@nutricost.com', 'gone@nutricost.com', 'robot@nutricost.com', 'ÉMILE@NUTRICOST.COM', 'Émile@nutricost.com', 'émile@nutricost.com',
      'nobody@nutricost.com', '', 'ana.admin@nutricost.com\u0000', 'ana_admin@nutricost.com', '%@nutricost.com'];
    for (const e of emails) {
      await same(`login ${JSON.stringify(e)}`, 'loginAccount', e);
      await same(`reset ${JSON.stringify(e)}`, 'resetAccount', e);
    }
    assert.equal((await same('login fold', 'loginAccount', 'ana.admin@nutricost.com')).ok.id, w.ana.id);
    assert.equal((await same('non-ASCII same letter', 'loginAccount', 'Émile@nutricost.com')).ok.id, w.emile.id, 'É matches É, ASCII letters fold');
    assert.equal((await same('non-ASCII other letter', 'loginAccount', 'émile@nutricost.com')).ok, undefined, 'é is not É (NOCASE folds ASCII only)');
    assert.deepEqual((await same('reset robot', 'resetAccount', 'robot@nutricost.com')).ok, { id: w.robot.id, login_email: 'robot@nutricost.com', name: 'robot@nutricost.com' });
    for (const e of ['off@nutricost.com', 'gone@nutricost.com']) assert.equal((await same(`inactive ${e}`, 'loginAccount', e)).ok, undefined);
  });

  test('recordLogin and setPassword write the same rows', async () => {
    await write('recordLogin', (q) => pg.recordLogin(q, w.robot.id), (db) => sq.recordLogin(db, w.robot.id));
    const stamp = (await tw.pg.query('SELECT last_login_at FROM accounts WHERE id = $1', [w.robot.id])).rows[0].last_login_at;
    assert.match(stamp, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "the same text as SQLite's datetime('now')");
    await write('setPassword', (q) => pg.setPassword(q, w.robot.id, 'h-robot'), (db) => sq.setPassword(db, w.robot.id, 'h-robot'));
    await write('unknown ids change nothing', async (q) => { await pg.setPassword(q, 999999, 'x'); await pg.recordLogin(q, 'abc'); },
      (db) => { sq.setPassword(db, 999999, 'x'); sq.recordLogin(db, 'abc'); });
  });

  test('tokens: replaceToken replaces only that purpose, getToken is exact, completeReset sets the password and spends every token', async () => {
    await token({ token: 'old-ana', user_id: w.ana.id, purpose: 'reset', expires_at: LATER });
    await token({ token: 'invite-ana', user_id: w.ana.id, purpose: 'invite', expires_at: LATER });
    await token({ token: 'expired-off', user_id: w.off.id, purpose: 'reset', expires_at: PAST });
    await write('replaceToken', (q) => pg.replaceToken(q, w.ana.id, 'reset', 'Tok-Ana', LATER), (db) => sq.replaceToken(db, w.ana.id, 'reset', 'Tok-Ana', LATER));
    for (const t of ['Tok-Ana', 'tok-ana', 'TOK-ANA', 'old-ana', 'invite-ana', 'expired-off', '', 'Tok-Ana\u0000', 'Tok%']) await same(`getToken ${t}`, 'getToken', t);
    assert.deepEqual((await same('the new token', 'getToken', 'Tok-Ana')).ok, { token: 'Tok-Ana', user_id: w.ana.id, purpose: 'reset', expires_at: LATER });
    assert.equal((await same('the expired token is returned (the route checks expiry)', 'getToken', 'expired-off')).ok.expires_at, PAST);
    await write('completeReset', (q) => pg.completeReset(q, w.ana.id, 'h-new'), (db) => sq.completeReset(db, w.ana.id, 'h-new'));
    const t = await tables(tw, 'after reset');
    assert.equal(t.accounts.find((a) => a.id === w.ana.id).password_hash, 'h-new');
    assert.deepEqual(t.tokens.map((x) => x.token), ['expired-off'], "every token of the account is gone, another account's stays");
  });

  test('completeReset with no token left is refused and changes nothing; replaceToken is atomic (a failing INSERT keeps the old token)', async () => {
    assert.deepEqual(await result(() => pg.completeReset(tw.pg, w.ana.id, 'h-replay')), { error: { status: 400, message: 'This link has expired. Ask for a new one.' } });
    assert.equal((await tw.pg.query('SELECT password_hash FROM accounts WHERE id = $1', [w.ana.id])).rows[0].password_hash, 'h-new', 'the password change rolled back');
    await token({ token: 'keep-robot', user_id: w.robot.id, purpose: 'reset', expires_at: LATER });
    // 'expired-off' belongs to another account: the INSERT fails on the token primary key after the DELETE ran
    assert.deepEqual(await result(() => pg.replaceToken(tw.pg, w.robot.id, 'reset', 'expired-off', LATER)), { raw: true });
    assert.deepEqual((await tw.pg.query('SELECT token FROM tokens WHERE user_id = $1', [w.robot.id])).rows, [{ token: 'keep-robot' }], 'the DELETE rolled back');
    // inside a caller's transaction the twins use that transaction (and its rollback)
    await assert.rejects(withTransaction(async (c) => {
      await pg.replaceToken(c, w.robot.id, 'reset', 'in-tx', LATER);
      assert.equal((await pg.getToken(c, 'in-tx')).user_id, w.robot.id);
      throw new Error('caller rolls back');
    }, tw.pg), /caller rolls back/);
    assert.equal(await pg.getToken(tw.pg, 'in-tx'), undefined);
    assert.equal(await pg.getToken(tw.pg, 'keep-robot').then((r) => r.token), 'keep-robot');
  });
});

describe('PostgreSQL accounts twin under concurrency', pgSuite(), () => {
  let tdb; let pool; let sampler;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
  });
  after(async () => {
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  const accountId = async (email) => (await pool.query('SELECT id FROM accounts WHERE login_email = $1', [email])).rows[0].id;

  test('two simultaneous setups: the second waits for the first and is refused; exactly one admin', async () => {
    const r = await overlap(pool, sampler,
      (c) => pg.createFirstAdmin(c, { name: 'First', mail: 'first@nutricost.com', hash: 'h1' }),
      (q) => pg.createFirstAdmin(q, { name: 'Second', mail: 'second@nutricost.com', hash: 'h2' }));
    assert.equal(typeof r.first.ok, 'number');
    assert.deepEqual(r.second, { error: { status: 400, message: 'Setup already completed' } });
    assert.ok(r.blocked, 'the second setup waited for the first');
    assert.deepEqual((await pool.query('SELECT login_email, role FROM accounts')).rows, [{ login_email: 'first@nutricost.com', role: 'admin' }]);
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM employees')).rows[0].n, 1, 'the refused setup left no employee');
  });

  test('two resets with the same token: exactly one succeeds, the other gets the expired-link refusal and changes nothing', async () => {
    const id = await accountId('first@nutricost.com');
    await pg.replaceToken(pool, id, 'reset', 'once', LATER);
    const [a, b] = [await pg.getToken(pool, 'once'), await pg.getToken(pool, 'once')]; // both requests read the token first
    assert.ok(a && b);
    const r = await overlap(pool, sampler, (c) => pg.completeReset(c, a.user_id, 'h-a'), (q) => pg.completeReset(q, b.user_id, 'h-b'));
    assert.deepEqual([r.first, r.second], [{ ok: undefined }, { error: { status: 400, message: 'This link has expired. Ask for a new one.' } }]);
    assert.equal((await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id])).rows[0].password_hash, 'h-a');
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM tokens')).rows[0].n, 0);
    // and without a forced overlap: two at once, still exactly one
    await pg.replaceToken(pool, id, 'reset', 'twice', LATER);
    const outs = await Promise.all([result(() => pg.completeReset(pool, id, 'h-c')), result(() => pg.completeReset(pool, id, 'h-d'))]);
    assert.equal(outs.filter((o) => 'ok' in o).length, 1, JSON.stringify(outs));
  });

  test('two simultaneous invites for one account leave exactly one live token (the later one)', async () => {
    const id = await accountId('first@nutricost.com');
    await pg.replaceToken(pool, id, 'reset', 'r0', LATER);
    const r = await overlap(pool, sampler, (c) => pg.replaceToken(c, id, 'reset', 'r1', LATER), (q) => pg.replaceToken(q, id, 'reset', 'r2', LATER));
    assert.deepEqual([r.first, r.second, r.blocked], [{ ok: undefined }, { ok: undefined }, true]);
    assert.deepEqual((await pool.query('SELECT token FROM tokens WHERE user_id = $1', [id])).rows, [{ token: 'r2' }]);
    const many = await Promise.all(['m1', 'm2', 'm3', 'm4'].map((t) => result(() => pg.replaceToken(pool, id, 'reset', t, LATER))));
    assert.ok(many.every((o) => 'ok' in o));
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM tokens WHERE user_id = $1', [id])).rows[0].n, 1);
  });
});
