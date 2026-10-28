// PostgreSQL Slice 6B: the SQLite -> PostgreSQL data copy (scripts/pg-copy.js) and its verification (scripts/pg-verify.js),
// on local throwaway databases. The source is test-support/slice6-fixture.js (the dev seed plus the rows it leaves out).
// Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createFixture } = require('../../test-support/slice6-fixture');
const { copy } = require('../../scripts/pg-copy');
const { verify } = require('../../scripts/pg-verify');
const sqliteSettings = require('../../src/settings');
const pgSettings = require('../../src/pg/settings');
const sqlitePeople = require('../../src/people');
const pgPeople = require('../../src/pg/people');

const countAll = async (pool) => {
  const out = {};
  for (const t of ['employees', 'accounts', 'catalog_nodes', 'assets', 'outbox', 'settings', 'asset_tag_counter']) out[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

describe('Slice 6B: SQLite -> PostgreSQL data copy', pgSuite(), () => {
  const dbs = [];
  let fixture;
  const fresh = async () => { const d = await createTestDatabase(); dbs.push(d); return d; };
  const src = (opts) => fixture.source(opts);

  before(() => { fixture = createFixture(); });
  after(async () => {
    await Promise.all(dbs.map((d) => d.drop()));
    if (fixture) fixture.cleanup();
  });

  test('copies every table exactly (ids, text, reals, NULLs), drops sessions, and verifies clean', async () => {
    const tdb = await fresh();
    const sqlite = src();
    const { copied } = await copy(sqlite, tdb.pool);
    assert.equal(copied.waitlist_entries, 2);
    assert.equal(copied.reservations, 1);
    assert.equal(copied.photos, 1);
    assert.equal(copied.tokens, 1);
    const result = await verify(sqlite, tdb.pool);
    assert.deepEqual(result.differences, []);
    assert.equal(result.ok, true);
    assert.equal(Number((await tdb.pool.query('SELECT COUNT(*) AS n FROM sessions')).rows[0].n), 0);
    assert.deepEqual((await tdb.pool.query('SELECT id FROM schema_migrations')).rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { rows } = await tdb.pool.query('SELECT purchase_cost, notes, cover_photo_id FROM assets WHERE id = 2');
    assert.equal(rows[0].purchase_cost, 1234.5678);
    assert.equal(rows[0].notes, 'Notes with "quotes", emoji 🎧 and\nnew lines');
  });

  test('the baseline seed rows are replaced, not kept beside the copied ones', async () => {
    const tdb = await fresh();
    const sqlite = src();
    await copy(sqlite, tdb.pool);
    const n = (t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const counts = await countAll(tdb.pool);
    assert.equal(counts.catalog_nodes, n('catalog_nodes'));
    assert.equal(counts.asset_tag_counter, 1);
    assert.deepEqual((await tdb.pool.query('SELECT last_number FROM asset_tag_counter')).rows[0].last_number,
      sqlite.prepare('SELECT last_number FROM asset_tag_counter').get().last_number);
  });

  test('identity sequences continue after the copied ids (incl. an id gap)', async () => {
    const tdb = await fresh();
    await copy(src(), tdb.pool);
    const emp = await tdb.pool.query("INSERT INTO employees (name, status) VALUES ('Next', 'active') RETURNING id");
    assert.equal(emp.rows[0].id, 5001);
    const entry = await tdb.pool.query("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date) VALUES (3, 3, '2026-12-01', '2026-12-02') RETURNING id");
    assert.equal(entry.rows[0].id, 902);
    const photo = await tdb.pool.query("INSERT INTO photos (asset_id, filename, thumb) VALUES (3, 'q.jpg', 'q_t.jpg') RETURNING id");
    assert.equal(photo.rows[0].id, 2);
  });

  test('the copied data reads the same through the app modules (settings, a person with assignments)', async () => {
    const tdb = await fresh();
    const sqlite = src();
    await copy(sqlite, tdb.pool);
    assert.deepEqual(await pgSettings.getSettings(tdb.pool), sqliteSettings.getSettings(sqlite));
    const person = sqlite.prepare('SELECT employee_id AS id FROM assignments GROUP BY employee_id ORDER BY COUNT(*) DESC LIMIT 1').get().id;
    assert.deepEqual(await pgPeople.personAssignments(tdb.pool, person), sqlitePeople.personAssignments(sqlite, person));
  });

  test('refuses a source the preflight rejects; the target stays fresh', async () => {
    const tdb = await fresh();
    const dirty = src({ edit: (db) => db.prepare('UPDATE assets SET license_seats = 2.5 WHERE id = 1').run() });
    await assert.rejects(() => copy(dirty, tdb.pool), /preflight found 1 problem/);
    assert.equal((await countAll(tdb.pool)).employees, 0);
    await copy(src(), tdb.pool); // still fresh: a clean copy goes through
  });

  test('refuses a target that already has data; nothing changes', async () => {
    const tdb = await fresh();
    await copy(src(), tdb.pool);
    const before = await countAll(tdb.pool);
    await assert.rejects(() => copy(src(), tdb.pool), /not fresh/);
    assert.deepEqual(await countAll(tdb.pool), before);
  });

  test('a failure mid-copy rolls everything back', async () => {
    const tdb = await fresh();
    const failing = {
      query: (...a) => tdb.pool.query(...a),
      async connect() {
        const client = await tdb.pool.connect();
        const real = client.query.bind(client);
        client.query = (sql, ...rest) => (typeof sql === 'string' && sql.startsWith('INSERT INTO "outbox"') ? Promise.reject(new Error('boom')) : real(sql, ...rest));
        const release = client.release.bind(client);
        client.release = (...a) => { client.query = real; return release(...a); };
        return client;
      },
    };
    await assert.rejects(() => copy(src(), failing), /boom/);
    const counts = await countAll(tdb.pool);
    assert.equal(counts.employees, 0);
    assert.equal(counts.catalog_nodes, 13, 'the baseline roots are back');
    await copy(src(), tdb.pool);
  });

  test('verify reports a changed value, a missing row, a stray session and a lagging sequence', async () => {
    const tdb = await fresh();
    const sqlite = src();
    await copy(sqlite, tdb.pool);
    await tdb.pool.query("UPDATE assets SET name = 'Changed' WHERE id = 3");
    await tdb.pool.query('DELETE FROM outbox WHERE id = (SELECT MAX(id) FROM outbox)');
    await tdb.pool.query("INSERT INTO sessions (sid, sess, expires) VALUES ('x', '{}', 1)");
    await tdb.pool.query("SELECT setval(pg_get_serial_sequence('employees', 'id'), 10, true)");
    const { ok, differences } = await verify(sqlite, tdb.pool);
    assert.equal(ok, false);
    const text = differences.join('\n');
    assert.match(text, /assets id=3\.name: SQLite .* PostgreSQL "Changed"/);
    assert.match(text, /outbox: \d+ row\(s\) in SQLite, \d+ in PostgreSQL/);
    assert.match(text, /outbox id=\d+: missing in PostgreSQL/);
    assert.match(text, /sessions: expected empty/);
    assert.match(text, /employees: the next generated id would be 11, but ids up to 5000 exist/);
  });
});
