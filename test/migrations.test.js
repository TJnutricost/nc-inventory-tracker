const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');

const memDb = () => new Database(':memory:');
const applied = (db) => db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id);

test('runner applies pending migrations in id order on a fresh database and records them', () => {
  const db = memDb();
  const order = [];
  const list = [
    { id: 3, name: 'c', up: () => order.push(3) },
    { id: 1, name: 'a', up: (d) => { order.push(1); d.exec('CREATE TABLE t (x)'); } },
    { id: 2, name: 'b', up: () => order.push(2) },
  ];
  assert.deepEqual(runMigrations(db, list), [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(applied(db), [1, 2, 3]);
});

test('runner applies each migration once; a second run is a no-op', () => {
  const db = memDb();
  let calls = 0;
  const list = [{ id: 1, name: 'once', up: () => { calls++; } }];
  runMigrations(db, list);
  assert.deepEqual(runMigrations(db, list), []);
  assert.equal(calls, 1);
  assert.deepEqual(applied(db), [1]);
});

test('runner applies only newly added migrations to an already-migrated database', () => {
  const db = memDb();
  runMigrations(db, [{ id: 1, name: 'one', up: () => {} }]);
  assert.deepEqual(runMigrations(db, [{ id: 1, name: 'one', up: () => { throw new Error('reapplied'); } }, { id: 2, name: 'two', up: () => {} }]), [2]);
});

test('a failing migration is rolled back and not recorded', () => {
  const db = memDb();
  const list = [{ id: 1, name: 'bad', up: (d) => { d.exec('CREATE TABLE half (x)'); throw new Error('boom'); } }];
  assert.throws(() => runMigrations(db, list), /boom/);
  assert.deepEqual(applied(db), []);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'half'").get().c, 0);
});

test('duplicate migration ids are rejected', () => {
  assert.throws(() => runMigrations(memDb(), [{ id: 1, name: 'a', up() {} }, { id: 1, name: 'b', up() {} }]), /duplicate/i);
});

function loadDbModule(dir) {
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/db')];
  return require('../src/db');
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mig-'));

test('fresh database: all migrations recorded, schema present, no global self-checkout setting', () => {
  const { db, getSettings } = loadDbModule(tmpDir());
  assert.deepEqual(applied(db), migrations.map((m) => m.id));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'assets'").get());
  assert.equal(getSettings().self_checkout, undefined, 'the global self-checkout setting is deprecated and no longer exposed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'self_checkout'").get().c, 0, 'and is not seeded');
  assert.ok(db.pragma('table_info(employees)').some((c) => c.name === 'can_self_checkout'));
  db.close();
});

test('pre-migration database upgrades in place: data kept, deprecated setting row left alone, bad cover cleared, not re-applied on restart', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  // Build a database exactly as the pre-runner app left it (baseline schema, no schema_migrations table).
  const old = new Database(path.join(dir, 'assets.db'));
  old.pragma('foreign_keys = ON');
  old.exec(migrations.BASELINE_SQL);
  old.prepare("INSERT INTO settings (key, value) VALUES ('self_checkout', '1')").run();
  old.prepare("INSERT INTO assets (tag, name, cover_photo_id) VALUES ('NC-00001', 'Keep me', 999)").run();
  old.prepare("INSERT INTO assets (tag, name) VALUES ('NC-00002', 'Other')").run();
  old.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (2, 'x.jpg', 'x_t.jpg')").run();
  old.prepare('UPDATE assets SET cover_photo_id = 1 WHERE id = 1').run(); // cross-asset cover
  assert.equal(old.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'schema_migrations'").get().c, 0);
  old.close();

  let mod = loadDbModule(dir);
  assert.deepEqual(applied(mod.db), migrations.map((m) => m.id));
  assert.equal(mod.db.prepare('SELECT name FROM assets WHERE id = 1').get().name, 'Keep me');
  assert.equal(mod.db.prepare('SELECT cover_photo_id FROM assets WHERE id = 1').get().cover_photo_id, null);
  assert.equal(mod.db.prepare("SELECT value FROM settings WHERE key = 'self_checkout'").get().value, '1', 'the deprecated row is left untouched, just unused');
  const stamp = mod.db.prepare('SELECT applied_at FROM schema_migrations WHERE id = 2').get().applied_at;
  mod.db.prepare('UPDATE assets SET cover_photo_id = 1 WHERE id = 2').run(); // valid cover, must survive a restart
  mod.db.close();

  mod = loadDbModule(dir); // second startup
  assert.deepEqual(applied(mod.db), migrations.map((m) => m.id));
  assert.equal(mod.db.prepare('SELECT applied_at FROM schema_migrations WHERE id = 2').get().applied_at, stamp);
  assert.equal(mod.db.prepare('SELECT cover_photo_id FROM assets WHERE id = 2').get().cover_photo_id, 1);
  mod.db.close();
});

test('Phase 1C upgrade: assets table rebuilt without losing data, ids or child rows; counter seeded above every existing number', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  // A database as Phase 1B left it: baseline schema + migrations 1 and 2 recorded.
  const old = new Database(path.join(dir, 'assets.db'));
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 2));
  old.prepare("INSERT INTO users (name, email) VALUES ('U', 'u@x.com')").run();
  const ins = old.prepare('INSERT INTO assets (tag, name) VALUES (?, ?)');
  for (const t of ['NC-00001', 'NC-00048', 'OLD-00120', 'NC-DUP1', '012345678905123', 'NC-12ABC']) ins.run(t, 'Asset ' + t);
  old.prepare("INSERT INTO assets (tag, name) VALUES ('NC-TEMP', 'high id then deleted')").run();
  old.prepare("DELETE FROM assets WHERE tag = 'NC-TEMP'").run(); // AUTOINCREMENT mark stays above max(id)
  old.prepare('INSERT INTO assignments (asset_id, user_id) VALUES (2, 1)').run();
  old.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (2, 'p.jpg', 'p_t.jpg')").run();
  old.prepare("INSERT INTO activity (asset_id, action) VALUES (2, 'created')").run();
  old.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('equipment', 1, 2)").run();
  const seqBefore = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assets'").get().seq;
  old.close();

  const { db, getSettings } = loadDbModule(dir);
  assert.deepEqual(applied(db), migrations.map((m) => m.id));
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys back on after the rebuild');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, 6);
  assert.equal(db.prepare("SELECT id FROM assets WHERE tag = 'NC-00048'").get().id, 2);
  assert.ok(db.pragma('table_info(assets)').some((c) => c.name === 'archived_at'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE archived_at IS NOT NULL').get().c, 0, 'nothing archived by the upgrade');
  for (const [tbl, n] of [['assignments', 1], ['photos', 1], ['activity', 1], ['requests', 1]]) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${tbl}`).get().c, n, `${tbl} rows survive the rebuild`);
  }
  assert.equal(db.prepare('SELECT asset_id FROM requests').get().asset_id, 2);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assets'").get().seq, seqBefore);
  assert.equal(db.prepare("INSERT INTO assets (tag, name) VALUES ('NC-NEW', 'n')").run().lastInsertRowid, seqBefore + 1, 'asset ids are still never reused');
  // 'disposed' is now a legal status
  db.prepare("UPDATE assets SET status = 'disposed' WHERE tag = 'NC-NEW'").run();
  // OLD-00120 (other prefix) wins; barcode-like and digit-in-prefix tags are ignored; NC-12ABC counted by the old generator rule
  assert.equal(db.prepare('SELECT last_number n FROM asset_tag_counter').get().n, 120);
  assert.equal(getSettings().tag_prefix, 'NC-');
  db.close();
});

test('a disableForeignKeys migration runs with enforcement off, is rejected if it leaves violations, and always restores enforcement', () => {
  const db = memDb();
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id))');
  let during;
  runMigrations(db, [{ id: 1, name: 'ok', disableForeignKeys: true, up: (d) => { during = d.pragma('foreign_keys', { simple: true }); d.exec('DROP TABLE p; CREATE TABLE p (id INTEGER PRIMARY KEY)'); } }]);
  assert.equal(during, 0);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.throws(() => runMigrations(db, [{ id: 2, name: 'bad', disableForeignKeys: true, up: (d) => d.exec('INSERT INTO c (pid) VALUES (42)') }]), /foreign key violation/);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM c').get().c, 0);
  assert.deepEqual(applied(db), [1]);
});
