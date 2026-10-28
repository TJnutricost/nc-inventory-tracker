// Employee CSV import on PostgreSQL (src/pg/employeeImport.js): the same decisions as src/employeeImport.js on twin worlds (plan and
// stored result), plus the PostgreSQL-only guarantees: a failure part-way rolls everything back, and two imports at once never
// double-insert a person. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const sq = require('../../src/employeeImport');
const pg = require('../../src/pg/employeeImport');

const HDR = 'First name,Last name,Work email,Department,Job title,Location,Phone';
const table = (...lines) => [HDR.split(','), ...lines.map((l) => l.split(','))];

describe('PostgreSQL employee import (differential against src/employeeImport.js)', pgSuite(), () => {
  let tdb; let tw;
  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    for (const [name, mail, status] of [['Ann Active', 'ann@x.com', 'active'], ['Ivy Inactive', 'ivy@x.com', 'inactive']]) {
      tw.sqlite.prepare('INSERT INTO employees (name, work_email, department, status) VALUES (?, ?, ?, ?)').run(name, mail, 'Ops', status);
      await tdb.pool.query('INSERT INTO employees (name, work_email, department, status) VALUES ($1, $2, $3, $4)', [name, mail, 'Ops', status]);
    }
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  const rows = () => sq.rowsFromCsv(table('New,One,NEW@x.com,Ops,,HQ,', 'Ann,Renamed,ann@x.com,,Lead,,', 'Ivy,Back,ivy@x.com,,,,', 'Bad,Row,nope,,,,', 'D,Dee,d@x.com,,,,', 'D,Dee,d@x.com,,,,')).rows;
  const stored = {
    pg: async () => (await tdb.pool.query('SELECT name, work_email, department, title, building, status, can_self_checkout FROM employees ORDER BY work_email')).rows,
    sq: () => tw.sqlite.prepare('SELECT name, work_email, department, title, building, status, can_self_checkout FROM employees ORDER BY work_email').all(),
  };

  test('preview and import give the same plan and the same stored people on both engines', async () => {
    const a = await pg.preview(tdb.pool, { rows: rows() }); const b = sq.preview(tw.sqlite, { rows: rows() });
    assert.deepEqual(a, b);
    const ra = await pg.apply(tdb.pool, { rows: rows(), actorAccountId: null, acknowledge: true });
    const rb = sq.apply(tw.sqlite, { rows: rows(), actorAccountId: null, acknowledge: true });
    assert.deepEqual(ra, rb);
    assert.deepEqual(await stored.pg(), stored.sq());
    assert.ok((await stored.pg()).filter((e) => ['new@x.com', 'd@x.com'].includes(e.work_email)).every((e) => e.can_self_checkout === 0));
  });

  test('refusals match: excluded rows need acknowledgement, a stale preview is a 409', async () => {
    const fresh = sq.rowsFromCsv(table('Zed,Z,zed@x.com,,,,', 'Bad,Row,nope,,,,')).rows;
    for (const [args, status] of [[{ rows: fresh }, 400], [{ rows: fresh, acknowledge: true, expect: { create: 5, update: 0 } }, 409]]) {
      await assert.rejects(pg.apply(tdb.pool, args), (e) => e.status === status);
      assert.throws(() => sq.apply(tw.sqlite, args), (e) => e.status === status);
    }
  });

  test('a failure part-way rolls the whole import back', async () => {
    await tdb.pool.query(`CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Boom Person' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await tdb.pool.query('CREATE TRIGGER boom BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION boom()');
    const before_ = (await stored.pg()).length;
    await assert.rejects(pg.apply(tdb.pool, { rows: sq.rowsFromCsv(table('Fine,One,fine@x.com,,,,', 'Boom,Person,boom@x.com,,,,')).rows, actorAccountId: null }), /boom/);
    await tdb.pool.query('DROP TRIGGER boom ON employees');
    assert.equal((await stored.pg()).length, before_);
    assert.equal((await tdb.pool.query("SELECT COUNT(*)::int n FROM activity WHERE action = 'employees_imported' AND details LIKE '%1 created%'")).rows[0].n, 0);
  });

  test('two imports of the same new people at once: each person is created once', async () => {
    const r = () => sq.rowsFromCsv(table('Race,One,race1@x.com,,,,', 'Race,Two,race2@x.com,,,,')).rows;
    const out = await Promise.all([pg.apply(tdb.pool, { rows: r(), actorAccountId: null }), pg.apply(tdb.pool, { rows: r(), actorAccountId: null })]);
    assert.deepEqual(out.map((p) => p.counts.create).sort(), [0, 2], 'the second one waited, then found them');
    assert.equal((await tdb.pool.query("SELECT COUNT(*)::int n FROM employees WHERE work_email LIKE 'race%@x.com'")).rows[0].n, 2);
  });
});
