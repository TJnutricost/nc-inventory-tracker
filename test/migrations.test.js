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

test('fresh database: all migrations recorded, schema present, self-checkout defaults OFF', () => {
  const { db, getSettings } = loadDbModule(tmpDir());
  assert.deepEqual(applied(db), migrations.map((m) => m.id));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'assets'").get());
  assert.equal(getSettings().self_checkout, false);
  db.close();
});

test('pre-migration database upgrades in place: data kept, ON setting kept, bad cover cleared, not re-applied on restart', () => {
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
  assert.equal(mod.getSettings().self_checkout, true, 'existing ON setting must not be overwritten');
  const stamp = mod.db.prepare('SELECT applied_at FROM schema_migrations WHERE id = 2').get().applied_at;
  mod.db.prepare('UPDATE assets SET cover_photo_id = 1 WHERE id = 2').run(); // valid cover, must survive a restart
  mod.db.close();

  mod = loadDbModule(dir); // second startup
  assert.deepEqual(applied(mod.db), migrations.map((m) => m.id));
  assert.equal(mod.db.prepare('SELECT applied_at FROM schema_migrations WHERE id = 2').get().applied_at, stamp);
  assert.equal(mod.db.prepare('SELECT cover_photo_id FROM assets WHERE id = 2').get().cover_photo_id, 1);
  assert.equal(mod.getSettings().self_checkout, true);
  mod.db.close();
});

test('an existing database with self-checkout explicitly OFF stays OFF', () => {
  const dir = tmpDir();
  let mod = loadDbModule(dir);
  mod.setSetting('self_checkout', '0');
  mod.db.close();
  mod = loadDbModule(dir);
  assert.equal(mod.getSettings().self_checkout, false);
  mod.db.close();
});
