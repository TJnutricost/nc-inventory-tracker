// PostgreSQL Slice 6B: the SQLite -> PostgreSQL data copy (scripts/pg-copy.js) and its verification (scripts/pg-verify.js),
// on local throwaway databases. The source is the deterministic dev seed (built once, in a child process, into a temp
// directory) plus rows the seed leaves out: photos, tokens, a waitlist hold and its reservation, a closed entry, a
// catalog node moved under a newer parent, an id gap, a session (never copied). Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { copy } = require('../../scripts/pg-copy');
const { verify } = require('../../scripts/pg-verify');
const { openReadOnly } = require('../../scripts/pg-preflight');
const sqliteSettings = require('../../src/settings');
const pgSettings = require('../../src/pg/settings');
const sqlitePeople = require('../../src/people');
const pgPeople = require('../../src/pg/people');

const ROOT = path.join(__dirname, '..', '..');
let dir;
let seeded;

function extraRows(db) {
  db.pragma('foreign_keys = ON');
  const photo = db.prepare("INSERT INTO photos (asset_id, filename, thumb, caption, uploaded_by) VALUES (2, 'p.jpg', 'p_t.jpg', 'Caption ✓ ünï', 1)").run().lastInsertRowid;
  db.prepare('UPDATE assets SET cover_photo_id = ?, purchase_cost = 1234.5678, notes = ? WHERE id = 2').run(photo, 'Notes with "quotes", emoji 🎧 and\nnew lines');
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('tok-abc', 1, 'invite', '2026-12-01 00:00:00')").run();
  db.prepare(`INSERT INTO waitlist_entries (id, asset_id, employee_id, start_date, end_date, status, hold_started_at, hold_expires_at, queue_seq, start_time, end_time, request_group)
    VALUES (900, 2, 2, '2026-11-10', '2026-11-12', 'held', '2026-10-26 10:00:00', '2026-10-27 10:00:00', 1, '09:00', '17:30', 'g1')`).run();
  db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status, closed_at, queue_seq)
    VALUES (2, 3, '2026-11-01', '2026-11-02', 'expired', '2026-10-20 08:00:00', 2)`).run();
  db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval, waitlist_entry_id, start_time, end_time, request_group)
    VALUES (2, 2, '2026-11-10', '2026-11-12', 'confirmed', 0, 900, '09:00', '17:30', 'g1')`).run();
  const zeta = db.prepare("INSERT INTO catalog_nodes (name, name_key) VALUES ('Zeta', 'zeta')").run().lastInsertRowid;
  db.prepare('UPDATE catalog_nodes SET parent_id = ? WHERE id = 2').run(zeta);
  db.prepare("INSERT INTO employees (id, name, status) VALUES (5000, 'High Id', 'active')").run();
  db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES ('s1', '{\"uid\":1}', ?)").run(Date.now() + 60_000);
}

// A fresh copy of the seeded database (with the extra rows unless clean: false), opened read-only.
function source({ extras = true, edit } = {}) {
  const file = path.join(dir, `src-${Math.random().toString(16).slice(2)}.db`);
  fs.copyFileSync(seeded, file);
  const db = new Database(file);
  if (extras) extraRows(db);
  if (edit) edit(db);
  db.close();
  return openReadOnly(file);
}

const countAll = async (pool) => {
  const out = {};
  for (const t of ['employees', 'accounts', 'catalog_nodes', 'assets', 'outbox', 'settings', 'asset_tag_counter']) out[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

describe('Slice 6B: SQLite -> PostgreSQL data copy', pgSuite(), () => {
  const dbs = [];
  const sources = [];
  const fresh = async () => { const d = await createTestDatabase(); dbs.push(d); return d; };
  const src = (opts) => { const s = source(opts); sources.push(s); return s; };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pgcopy-'));
    const dataDir = path.join(dir, 'seed');
    const res = spawnSync(process.execPath, ['-e', `require('./scripts/seed-dev').seedDatabase({ dataDir: ${JSON.stringify(dataDir)}, quiet: true }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NC_NO_EXTERNAL_MAIL: '1' } });
    assert.equal(res.status, 0, res.stderr);
    seeded = path.join(dir, 'seed.db');
    const db = new Database(path.join(dataDir, 'assets.db'));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.copyFileSync(path.join(dataDir, 'assets.db'), seeded);
  });
  after(async () => {
    for (const s of sources) if (s.open) s.close();
    await Promise.all(dbs.map((d) => d.drop()));
    fs.rmSync(dir, { recursive: true, force: true });
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
    assert.deepEqual((await tdb.pool.query('SELECT id FROM schema_migrations')).rows, [{ id: 1 }]);
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
