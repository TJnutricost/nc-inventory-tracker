// PostgreSQL Slice 6A: the read-only preflight audit (scripts/pg-preflight.js). Needs no PostgreSQL: it audits SQLite files.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const { preflight, openReadOnly, main, EXPECTED_MIGRATIONS } = require('../scripts/pg-preflight');

let dir, file, db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-preflight-'));
  file = path.join(dir, 'assets.db');
  db = new Database(file);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
});
afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const addAsset = (extra = {}) => {
  const row = { tag: `PF-${++seq}`, name: `Asset ${seq}`, category: 'Laptop', status: 'available', ...extra };
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row).lastInsertRowid;
};
const audit = () => {
  db.close();
  const ro = openReadOnly(file);
  try { return preflight(ro); } finally { ro.close(); }
};
const checks = (result) => result.findings.map((f) => `${f.check}:${f.table || ''}.${f.column || ''}`).sort();

test('a clean, fully migrated database passes and reports row counts', () => {
  addAsset({ license_seats: 5, purchase_cost: 199.99 });
  const result = audit();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
  assert.equal(result.counts.assets, 1);
  assert.equal(result.counts.asset_tag_counter, 1);
  assert.equal('sessions' in result.counts, false, 'sessions are not copied (Q2), so not audited');
  assert.equal('schema_migrations' in result.counts, false);
});

test('the expected schema version is every SQLite migration (1..18)', () => {
  assert.deepEqual(EXPECTED_MIGRATIONS, Array.from({ length: 19 }, (_, i) => i + 1));
  db.prepare('DELETE FROM schema_migrations WHERE id = 18').run();
  const result = audit();
  assert.equal(result.ok, false);
  assert.deepEqual(checks(result), ['schema-version:schema_migrations.']);
});

test('license_seats: fractional, negative and out-of-range values are each reported once (carry-over (au))', () => {
  addAsset({ license_seats: 2.5 });
  addAsset({ license_seats: -1 });
  addAsset({ license_seats: 1e10 });
  addAsset({ license_seats: 0 });
  addAsset({ license_seats: 2147483647 });
  const result = audit();
  assert.deepEqual(checks(result), ['license-seats:assets.license_seats', 'license-seats:assets.license_seats', 'license-seats:assets.license_seats']);
  assert.deepEqual(result.findings.map((f) => f.value).sort((a, b) => a - b), [-1, 2.5, 1e10]);
});

test('a value whose storage class does not fit its PostgreSQL column is reported', () => {
  addAsset({ purchase_cost: 'cheap' });
  addAsset({ cover_photo_id: 1.5 });
  addAsset({ notes: Buffer.from([1, 2, 3]) });
  const result = audit();
  assert.deepEqual(checks(result), ['type:assets.cover_photo_id', 'type:assets.notes', 'type:assets.purchase_cost']);
  assert.equal(result.findings.find((f) => f.column === 'notes').value, '<blob>');
});

test('an integer outside the int4 range is reported (BigInt-safe)', () => {
  addAsset({ cover_photo_id: 3_000_000_000 });
  addAsset({ cover_photo_id: -2_147_483_649 });
  addAsset({ cover_photo_id: 2_147_483_647 });
  const result = audit();
  assert.deepEqual(checks(result), ['int-range:assets.cover_photo_id', 'int-range:assets.cover_photo_id']);
  assert.deepEqual(result.findings.map((f) => f.value).sort(), ['-2147483649', '3000000000']);
});

test('a NUL character anywhere in a text value is reported', () => {
  addAsset({ notes: 'before\u0000after' });
  addAsset({ name: '\u0000' });
  addAsset({ notes: 'no nul here' });
  const result = audit();
  assert.deepEqual(checks(result), ['nul:assets.name', 'nul:assets.notes']);
});

test('a dangling foreign key is reported', () => {
  const id = addAsset();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (?, 'a.jpg', 'a_t.jpg')").run(Number(id) + 1000);
  const result = audit();
  assert.deepEqual(checks(result), ['foreign-key:photos.']);
});

test('sessions are not audited (not copied)', () => {
  db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES ('s1', ?, ?)").run('x\u0000y', Date.now());
  assert.equal(audit().ok, true);
});

test('the audit never writes: the file is byte-identical afterwards', () => {
  addAsset({ license_seats: 2.5 });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const before = fs.readFileSync(file);
  const ro = openReadOnly(file);
  assert.throws(() => ro.prepare('DELETE FROM assets').run(), /readonly/i);
  preflight(ro);
  ro.close();
  assert.ok(before.equals(fs.readFileSync(file)));
});

test('CLI: exit 0 when clean, 1 with findings or a missing file, 2 on usage error', () => {
  addAsset();
  db.close();
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(main([file]), 0);
    assert.equal(main([]), 2);
    assert.equal(main([path.join(dir, 'missing.db')]), 1);
    db = new Database(file);
    addAsset({ license_seats: 2.5 });
    db.close();
    assert.equal(main([file, '--json']), 1);
  } finally {
    console.log = log;
    console.error = err;
  }
});
