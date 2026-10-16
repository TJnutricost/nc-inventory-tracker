// Slice 5C-3 (D-46, D-48): the WRITE twins of src/pg/people.js, differential against src/people.js, plus their transactions and races.
// The routes check emails before they write (src/server.js), so the SQLite side of each scenario is THAT route check + the SQLite write
// (the readable 400s users see today); the PostgreSQL side is the twin alone, which runs the same checks inside its transaction. Both
// must give the same outcome and leave the same tables (test-support/pg-auth-support.js). Fixtures: people with and without a login,
// an inactive person, a login without a person, mixed-case / non-ASCII / padded emails, admin vs employee. Rollback: a refused role
// half-way leaves nothing on either engine. Races (PostgreSQL only): two simultaneous creates with one email (one wins, the other gets
// the route's 400 via the unique index), the check runs on the caller's transaction, two give-a-logins for one person, concurrent
// updates of one person (no deadlock). Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const { result, tables, overlap } = require('../../test-support/pg-auth-support');
const { withTransaction } = require('../../src/pg/transaction');

const sq = require('../../src/people');
const pg = require('../../src/pg/people');
const pgAccounts = require('../../src/pg/accounts');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const PERSON_EXISTS = 'A person with that email already exists';
const LOGIN_EXISTS = 'A login with that email already exists';
const OTHER_PERSON = 'That email belongs to another person';
const HAS_LOGIN = 'This person already has a login.';
const IN_USE = 'That email is already in use';
const refused = (message) => ({ error: { status: 400, message } });

// The route checks before each write (src/server.js POST /api/users, POST /api/users/:id/account, PUT /api/users/:id), on SQLite.
const sqRoute = {
  createPerson(db, a) {
    if (a.email && sq.workEmailTaken(db, a.email)) throw httpError(400, PERSON_EXISTS);
    if (a.email && a.wantsLogin && sq.loginEmailTaken(db, a.email)) throw httpError(400, LOGIN_EXISTS);
    return sq.createPerson(db, a);
  },
  addAccount(db, p, { email, role }) {
    if (p.account_id) throw httpError(400, HAS_LOGIN);
    if (sq.loginEmailTaken(db, email)) throw httpError(400, LOGIN_EXISTS);
    if (email !== p.work_email && sq.workEmailTakenByOther(db, email, p.id)) throw httpError(400, OTHER_PERSON);
    return sq.addAccount(db, p, { email, role });
  },
  updatePerson(db, a) {
    const u = sq.getPerson(db, a.id);
    if (a.workEmail && a.workEmail !== u.work_email && sq.workEmailTakenByOther(db, a.workEmail, a.id)) throw httpError(400, IN_USE);
    if (u.account_id && a.loginEmail !== u.login_email && sq.loginEmailTakenByOther(db, a.loginEmail, u.account_id)) throw httpError(400, IN_USE);
    return sq.updatePerson(db, a);
  },
};

describe('PostgreSQL people write twins (differential against the routes on src/people.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  async function write(label, name, ...args) {
    await tw.syncSequences();
    const pgOut = await result(() => pg[name](tw.pg, ...args));
    const sqOut = await result(() => (sqRoute[name] || sq[name])(tw.sqlite, ...args));
    assert.deepEqual(pgOut, sqOut, label);
    await tables(tw, label);
    return pgOut;
  }
  const person = (id) => sq.getPerson(tw.sqlite, id);
  const base = { department: null, title: null, phone: null, building: null };

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.ana = await tw.employee({ name: 'Ana', work_email: 'ana@nutricost.com' });
    w.anaAcc = await tw.insert('accounts', { employee_id: w.ana.id, login_email: 'ana.login@nutricost.com', role: 'admin' });
    w.emile = await tw.employee({ name: 'Émile', work_email: 'ÉMILE@nutricost.com' });
    w.bare = await tw.employee({ name: 'Bare', work_email: null });
    w.old = await tw.employee({ name: 'Old', work_email: 'old@nutricost.com', status: 'inactive' });
    w.robot = await tw.insert('accounts', { employee_id: null, login_email: 'robot@nutricost.com', role: 'admin' });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('createPerson: with and without a login, ASCII-only folding of taken emails, a refused role rolls everything back', async () => {
    const made = await write('with login', 'createPerson', { ...base, name: 'New One', email: 'new.one@nutricost.com', department: 'Ops', building: 'B1', wantsLogin: true, role: 'admin' });
    assert.equal(typeof made.ok, 'number');
    await write('no login, no email', 'createPerson', { ...base, name: 'Temp', email: null, wantsLogin: false, role: 'employee' });
    await write('no login, a login-only email', 'createPerson', { ...base, name: 'Robot Owner', email: 'robot@nutricost.com', wantsLogin: false, role: 'employee' });
    await write('padded email is another email', 'createPerson', { ...base, name: 'Pad', email: ' ana@nutricost.com', wantsLogin: false, role: 'employee' });
    assert.deepEqual(await write('work email taken (case folds)', 'createPerson', { ...base, name: 'X', email: 'ANA@nutricost.com', wantsLogin: true, role: 'employee' }), refused(PERSON_EXISTS));
    assert.deepEqual(await write('inactive person keeps the email', 'createPerson', { ...base, name: 'X', email: 'old@nutricost.com', wantsLogin: false, role: 'employee' }), refused(PERSON_EXISTS));
    assert.deepEqual(await write('login email taken', 'createPerson', { ...base, name: 'X', email: 'Ana.Login@nutricost.com', wantsLogin: true, role: 'employee' }), refused(LOGIN_EXISTS));
    assert.deepEqual(await write('non-ASCII same letter is taken', 'createPerson', { ...base, name: 'X', email: 'Émile@NUTRICOST.com', wantsLogin: false, role: 'employee' }), refused(PERSON_EXISTS));
    await write('non-ASCII other letter is free (NOCASE folds ASCII only)', 'createPerson', { ...base, name: 'Emile 2', email: 'émile@nutricost.com', wantsLogin: false, role: 'employee' });
    const before = await tables(tw, 'before rollback');
    assert.deepEqual(await write('refused role (rolls back)', 'createPerson', { ...base, name: 'Half', email: 'half@nutricost.com', wantsLogin: true, role: 'boss' }), { raw: true });
    assert.deepEqual(await tables(tw, 'after rollback'), before, 'no half-created person');
  });

  test('addAccount: a person without a work email gets it, one with gets only the login; the route refusals; rollback', async () => {
    await write('no work email', 'addAccount', person(w.bare.id), { email: 'bare@nutricost.com', role: 'employee' });
    assert.equal(person(w.bare.id).work_email, 'bare@nutricost.com');
    await write('keeps the work email', 'addAccount', person(w.emile.id), { email: 'emile.login@nutricost.com', role: 'admin' });
    assert.deepEqual(await write('already has a login', 'addAccount', person(w.ana.id), { email: 'ana2@nutricost.com', role: 'employee' }), refused(HAS_LOGIN));
    const old = person(w.old.id);
    assert.deepEqual(await write('login taken', 'addAccount', old, { email: 'ROBOT@nutricost.com', role: 'employee' }), refused(LOGIN_EXISTS));
    assert.deepEqual(await write("another person's work email", 'addAccount', old, { email: 'ana@nutricost.com', role: 'employee' }), refused(OTHER_PERSON));
    const temp = (await tw.pg.query("SELECT id FROM employees WHERE name = 'Temp'")).rows[0].id;
    const before = await tables(tw, 'before rollback');
    assert.deepEqual(await write('refused role (rolls back the work email too)', 'addAccount', person(temp), { email: 'temp@nutricost.com', role: 'boss' }), { raw: true });
    assert.deepEqual(await tables(tw, 'after rollback'), before);
    await write('own work email as the login', 'addAccount', old, { email: 'old@nutricost.com', role: 'employee' });
  });

  test('updatePerson: fields, role, deactivation, case-only changes; taken emails refused; a refused role rolls back', async () => {
    const ana = person(w.ana.id);
    const args = (p, over = {}) => ({ id: p.id, name: p.name, workEmail: p.work_email, ...base, active: p.status === 'active', accountId: p.account_id, loginEmail: p.login_email, role: p.role || 'employee', ...over });
    await write('fields + role', 'updatePerson', args(ana, { name: 'Ana B', department: 'IT', title: 'Boss', phone: '5', building: 'HQ', role: 'employee' }));
    await write('case-only change of own emails', 'updatePerson', args(person(w.ana.id), { workEmail: 'ANA@nutricost.com', loginEmail: 'ANA.LOGIN@nutricost.com' }));
    await write('deactivate (person and login)', 'updatePerson', args(person(w.ana.id), { active: false }));
    assert.deepEqual([person(w.ana.id).status, person(w.ana.id).account_active], ['inactive', 0]);
    await write('reactivate', 'updatePerson', args(person(w.ana.id), { active: true }));
    const bareP = person(w.bare.id);
    assert.deepEqual(await write("work email of another", 'updatePerson', args(bareP, { workEmail: 'Old@nutricost.com', loginEmail: 'bare@nutricost.com' })), refused(IN_USE));
    assert.deepEqual(await write("login email of another", 'updatePerson', args(bareP, { loginEmail: 'robot@nutricost.com' })), refused(IN_USE));
    await write('login email unlike the work email', 'updatePerson', args(person(w.emile.id), { name: 'Émile Z' }));
    const temp = person((await tw.pg.query("SELECT id FROM employees WHERE name = 'Temp'")).rows[0].id);
    await write('no account at all', 'updatePerson', args(temp, { workEmail: 'temp2@nutricost.com', accountId: null, loginEmail: null }));
    const before = await tables(tw, 'before rollback');
    assert.deepEqual(await write('refused role (rolls back the person too)', 'updatePerson', args(person(w.ana.id), { name: 'Never', role: 'boss' })), { raw: true });
    assert.deepEqual(await tables(tw, 'after rollback'), before);
  });

  test('setSelfCheckout and updateOwnProfile', async () => {
    await write('self-checkout off', 'setSelfCheckout', w.ana.id, false);
    await write('self-checkout on', 'setSelfCheckout', w.ana.id, true);
    await write('self-checkout off again', 'setSelfCheckout', w.bare.id, false);
    await write('unknown id', 'setSelfCheckout', 'abc', true);
    await write('profile', 'updateOwnProfile', w.ana.id, { name: 'Ana C', phone: '9', department: null, title: 'T' });
    await write('blank name keeps the name', 'updateOwnProfile', w.ana.id, { name: null, phone: null, department: 'D', title: null });
    assert.equal(person(w.ana.id).name, 'Ana C');
  });
});

describe('PostgreSQL people writes under concurrency', pgSuite(), () => {
  let tdb; let pool; let sampler;
  const create = (q, name, email, wantsLogin = true) => pg.createPerson(q, { name, email, department: null, title: null, phone: null, building: null, wantsLogin, role: 'employee' });
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
  });
  after(async () => {
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

  test('two simultaneous creates with one email: one wins, the other gets the readable 400 (work email, then login email)', async () => {
    const r = await overlap(pool, sampler, (c) => create(c, 'First', 'same@nutricost.com'), (q) => create(q, 'Second', 'same@nutricost.com'));
    assert.equal(typeof r.first.ok, 'number');
    assert.deepEqual([r.second, r.blocked], [refused(PERSON_EXISTS), true], 'the INSERT waited on the unique index, then its 23505 became the route message');
    assert.equal(await count("SELECT COUNT(*) AS n FROM employees WHERE name = 'Second'"), 0);
    // a login taken by a concurrent give-a-login: the person INSERT passes, the account INSERT clashes
    const holder = await create(pool, 'Holder', 'holder@nutricost.com', false);
    const h = await pg.getPerson(pool, holder);
    const r2 = await overlap(pool, sampler, (c) => pg.addAccount(c, h, { email: 'shared@nutricost.com', role: 'employee' }), (q) => create(q, 'Late', 'shared@nutricost.com'));
    assert.deepEqual([r2.first, r2.second, r2.blocked], [{ ok: undefined }, refused(LOGIN_EXISTS), true]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM employees WHERE name = 'Late'"), 0, 'the person INSERT rolled back with it');
    const all = await Promise.all(['a', 'b', 'c', 'd'].map((n) => result(() => create(pool, `Rush ${n}`, 'rush@nutricost.com'))));
    assert.equal(all.filter((o) => 'ok' in o).length, 1);
    assert.ok(all.filter((o) => !('ok' in o)).every((o) => o.error && o.error.status === 400), JSON.stringify(all));
  });

  test('the unique indexes the 23505 translation names exist (a renamed index would silently turn the race into a 500)', async () => {
    const names = (await pool.query("SELECT conname AS n FROM pg_constraint WHERE conrelid = 'accounts'::regclass UNION SELECT indexname FROM pg_indexes WHERE tablename IN ('accounts', 'employees')")).rows.map((r) => r.n);
    for (const n of ['idx_employees_work_email', 'accounts_login_email_lower_key', 'accounts_employee_id_key']) assert.ok(names.includes(n), n);
  });

  test("the email checks run on the caller's transaction: they see its own rows and refuse before any statement fails", async () => {
    await withTransaction(async (c) => {
      await create(c, 'Tx One', 'tx@nutricost.com');
      assert.deepEqual(await result(() => create(c, 'Tx Two', 'TX@nutricost.com')), refused(PERSON_EXISTS));
      assert.deepEqual((await c.query('SELECT 1 AS ok')).rows, [{ ok: 1 }], 'the transaction is still usable (no failed statement)');
      const id = (await c.query("SELECT id FROM employees WHERE name = 'Tx One'")).rows[0].id;
      assert.deepEqual(await result(() => pg.updatePerson(c, { id, name: 'Tx One', workEmail: 'same@nutricost.com', department: null, title: null, phone: null, building: null, active: true, accountId: null, loginEmail: null, role: 'employee' })), refused(IN_USE));
      await c.query('SELECT 1');
    }, pool);
  });

  test('two give-a-logins for one person: the second waits on the person and is refused', async () => {
    const id = await create(pool, 'Twice', null, false);
    const p = await pg.getPerson(pool, id);
    const r = await overlap(pool, sampler, (c) => pg.addAccount(c, p, { email: 'twice1@nutricost.com', role: 'employee' }), (q) => pg.addAccount(q, p, { email: 'twice2@nutricost.com', role: 'admin' }));
    assert.deepEqual([r.first, r.second, r.blocked], [{ ok: undefined }, refused(HAS_LOGIN), true]);
    const after = await pg.getPerson(pool, id);
    assert.deepEqual([after.work_email, after.login_email], ['twice1@nutricost.com', 'twice1@nutricost.com']);
  });

  test('concurrent updates of one person (and invites / resets of its account) queue on the person row: no deadlock, every one applies', async () => {
    const id = await create(pool, 'Busy', 'busy@nutricost.com');
    const p = await pg.getPerson(pool, id);
    const upd = (n) => () => pg.updatePerson(pool, { id, name: `Busy ${n}`, workEmail: 'busy@nutricost.com', department: `D${n}`, title: null, phone: null, building: null, active: true, accountId: p.account_id, loginEmail: 'busy@nutricost.com', role: n % 2 ? 'admin' : 'employee' });
    const ops = [];
    for (let n = 0; n < 8; n++) {
      ops.push(upd(n));
      if (n % 3 === 0) ops.push(() => pgAccounts.replaceToken(pool, p.account_id, 'reset', `busy-${n}`, '2999-01-01T00:00:00.000Z'));
    }
    const outs = await Promise.all(ops.map((op) => result(op)));
    assert.ok(outs.every((o) => 'ok' in o), JSON.stringify(outs));
    const final = await pg.getPerson(pool, id);
    assert.match(final.name, /^Busy \d$/);
    assert.equal(final.department, `D${final.name.slice(-1)}`, 'one update applied as a whole');
    assert.equal(await count('SELECT COUNT(*) AS n FROM tokens WHERE user_id = $1', [p.account_id]), 1);
  });
});
