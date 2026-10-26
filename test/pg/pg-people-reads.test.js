// Slice 5C-2 (D-46, D-48): the read twins of src/pg/people.js, differential against src/people.js. Every fixture row is written to
// BOTH engines with the same ids (test-support/pg-twin.js) and every call must give deep-equal results: the People list (active first,
// names in SQLite's NOCASE order incl. mixed case, unicode and equal names), a person with and without a login, the email-in-use checks
// (ASCII letters fold, non-ASCII letters do not, exactly like SQLite's NOCASE), a person's current equipment and the 200 most recent
// returns (equal timestamps across the LIMIT), an employee's status; unknown and malformed ids. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');

const sq = require('../../src/people');
const pg = require('../../src/pg/people');

describe('PostgreSQL people read twins (differential against src/people.js)', pgSuite(), () => {
  let tdb; let tw; let w;
  const same = (label, name, ...args) => tw.same(label, (q) => pg[name](q, ...args), (db) => sq[name](db, ...args));

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w = {};
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('an empty database: no people, nothing found, no email taken', async () => {
    assert.deepEqual(await same('empty list', 'listPeople'), { ok: [] });
    for (const fn of ['getPerson', 'employeeStatus']) await same(`${fn} empty`, fn, 1);
    assert.deepEqual(await same('assignments empty', 'personAssignments', 1), { ok: { current: [], past: [] } });
    assert.equal((await same('work email empty', 'workEmailTaken', 'a@b.c')).ok, undefined);
  });

  test('listPeople, getPerson, employeeStatus: active first, NOCASE name order with ties, accounts joined, counts as numbers', async () => {
    const names = ['bob', 'Bob', 'ana', 'Émile', 'émile', 'Zed', '_under', 'Ana', 'bob', 'Ünï'];
    w.people = [];
    for (const [i, name] of names.entries()) {
      w.people.push(await tw.employee({ name, status: i % 4 === 3 ? 'inactive' : 'active', work_email: i % 3 ? `P${i}.Mixed@Nutricost.com` : null, department: i % 2 ? 'R&D' : null }));
    }
    w.accA = await tw.insert('accounts', { login_email: 'Login.One@Nutricost.com', role: 'admin', employee_id: w.people[0].id, last_login_at: '2026-01-02 03:04:05', password_hash: 'x' });
    w.accB = await tw.insert('accounts', { login_email: 'ÉMILE@nutricost.com', role: 'employee', employee_id: w.people[3].id, active: 0 });
    w.robot = await tw.insert('accounts', { login_email: 'robot@nutricost.com', role: 'admin', employee_id: null });
    w.assets = [];
    for (let i = 0; i < 4; i++) w.assets.push(await tw.asset({ name: `Kit ${i}` }));
    await tw.assignment({ asset_id: w.assets[0].id, employee_id: w.people[0].id });
    await tw.checkout({ asset_id: w.assets[1].id, employee_id: w.people[0].id, due_date: '2026-02-01' });
    await tw.checkout({ asset_id: w.assets[2].id, employee_id: w.people[3].id, due_date: '2026-01-04', returned_at: '2026-01-03 00:00:00' });
    const list = (await same('list', 'listPeople')).ok;
    assert.deepEqual(list.map((p) => p.name), ['_under', 'ana', 'bob', 'Bob', 'bob', 'Zed', 'Ünï', 'émile', 'Ana', 'Émile'], 'active first, ASCII-folded byte order, equal names by id');
    assert.deepEqual(list.filter((p) => p.status === 'active').length, 8);
    assert.equal(list.find((p) => p.id === w.people[0].id).asset_count, 2);
    assert.equal(list.find((p) => p.id === w.people[3].id).asset_count, 0);
    for (const id of [...w.people.map((p) => p.id), 999999, 'abc', null, '1.5', String(w.people[1].id)]) {
      await same(`getPerson ${id}`, 'getPerson', id);
      await same(`employeeStatus ${id}`, 'employeeStatus', id);
    }
    const p0 = (await same('p0', 'getPerson', w.people[0].id)).ok;
    assert.deepEqual([p0.email, p0.account_id, p0.login_email, p0.role, p0.account_active, p0.last_login_at], ['Login.One@Nutricost.com', w.accA.id, 'Login.One@Nutricost.com', 'admin', 1, '2026-01-02 03:04:05']);
    const p1 = (await same('p1', 'getPerson', w.people[1].id)).ok;
    assert.deepEqual([p1.email, p1.account_id, p1.role], ['P1.Mixed@Nutricost.com', null, null]);
    assert.deepEqual((await same('inactive status', 'employeeStatus', w.people[3].id)).ok, { status: 'inactive' });
  });

  test('the email-in-use checks: ASCII case folds, non-ASCII does not, the edited row is excluded', async () => {
    const emails = ['p1.mixed@nutricost.com', 'P1.MIXED@NUTRICOST.COM', 'p1.mixed@nutricost.co', 'login.one@nutricost.com', 'LOGIN.ONE@NUTRICOST.COM',
      'ÉMILE@NUTRICOST.COM', 'Émile@Nutricost.com', 'émile@nutricost.com', 'robot@nutricost.com', '', null, undefined];
    const empIds = [w.people[1].id, w.people[2].id, null, 'abc'];
    const accIds = [w.accA.id, w.accB.id, null];
    for (const e of emails) {
      await same(`work ${e}`, 'workEmailTaken', e);
      await same(`login ${e}`, 'loginEmailTaken', e);
      for (const id of empIds) await same(`work ${e} except ${id}`, 'workEmailTakenByOther', e, id);
      for (const id of accIds) await same(`login ${e} except ${id}`, 'loginEmailTakenByOther', e, id);
    }
    assert.deepEqual((await same('work fold', 'workEmailTaken', 'P1.MIXED@nutricost.COM')).ok, { 1: 1 });
    assert.deepEqual((await same('login fold, same non-ASCII', 'loginEmailTaken', 'Émile@NUTRICOST.COM')).ok, { 1: 1 }, 'É matches É; only ASCII letters fold');
    assert.equal((await same('login non-ASCII', 'loginEmailTaken', 'émile@nutricost.com')).ok, undefined, 'é is not É');
    assert.equal((await same('own row', 'workEmailTakenByOther', 'p1.mixed@nutricost.com', w.people[1].id)).ok, undefined);
    assert.deepEqual((await same('other row', 'workEmailTakenByOther', 'p1.mixed@nutricost.com', w.people[2].id)).ok, { 1: 1 });
  });

  test('personAssignments: current by type then newest, the 200 most recent returns with equal timestamps across the LIMIT', async () => {
    const who = w.people[2];
    const kit = [];
    for (let i = 0; i < 6; i++) kit.push(await tw.asset({ name: `Held ${i}`, category: 'Ünï' }));
    await tw.insert('photos', { asset_id: kit[0].id, filename: 'a.jpg', thumb: 'a_t.jpg' });
    await tw.checkout({ asset_id: kit[0].id, employee_id: who.id, due_date: '2026-03-01', checked_out_at: '2026-01-05 00:00:00' });
    await tw.checkout({ asset_id: kit[1].id, employee_id: who.id, due_date: '2026-03-01' }); // equal checked_out_at with the next two
    await tw.assignment({ asset_id: kit[2].id, employee_id: who.id });
    await tw.checkout({ asset_id: kit[3].id, employee_id: who.id, due_date: '2026-03-02' });
    for (let i = 0; i < 230; i++) {
      await tw.checkout({ asset_id: kit[4 + (i % 2)].id, employee_id: who.id, due_date: '2026-01-02', returned_at: i % 5 ? '2026-01-02 00:00:00' : `2026-01-0${3 + (i % 3)} 00:00:00` });
    }
    for (const id of [who.id, w.people[0].id, w.people[3].id, 999999, 'x']) await same(`assignments ${id}`, 'personAssignments', id);
    const { current, past } = (await same('who', 'personAssignments', who.id)).ok;
    assert.deepEqual(current.map((s) => s.asset_id), [kit[0].id, kit[1].id, kit[3].id, kit[2].id]);
    assert.equal(current[0].thumb, 'a_t.jpg');
    assert.equal(past.length, 200);
  });
});
