const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const { cleanSerial, serialKey } = require('../src/serial');
const { bootApp, startServer, stopServer, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const create = (serial, extra = {}) => admin.post('/api/assets', { name: `Serial asset ${++seq}`, tag: `SER-${seq}`, serial, ...extra });
const row = (id) => db.prepare('SELECT serial, serial_normalized FROM assets WHERE id = ?').get(id);
const lookup = async (code) => (await admin.get(`/api/assets/lookup/${encodeURIComponent(code)}`)).body;

// ---------------------------------------------------------------- the normalization rule itself
test('normalization: trim + lower-case the KEY only; blank is no serial; punctuation and inner spacing are untouched', () => {
  assert.equal(cleanSerial('  ABC123  '), 'ABC123');
  assert.equal(serialKey('  ABC123  '), 'abc123');
  for (const blank of [undefined, null, '', '   ', '\t\n ']) {
    assert.equal(cleanSerial(blank), null);
    assert.equal(serialKey(blank), null);
  }
  assert.equal(serialKey('AB-12/3 x'), 'ab-12/3 x');
  assert.notEqual(serialKey('ABC-123'), serialKey('ABC123'));
  assert.notEqual(serialKey('ABC 123'), serialKey('ABC123'));
  assert.notEqual(serialKey('ABC  123'), serialKey('ABC 123'), 'internal spacing is meaningful');
  assert.equal(serialKey(12345), '12345');
});

// ---------------------------------------------------------------- create
test('create: the stored serial keeps its case and punctuation; only surrounding whitespace goes', async () => {
  const r = await create('  Ab-12/3_x.Y  ');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.serial, 'Ab-12/3_x.Y');
  assert.deepEqual(row(r.body.id), { serial: 'Ab-12/3_x.Y', serial_normalized: 'ab-12/3_x.y' });
});

test('create: a duplicate serial is rejected, whether it differs by case, surrounding whitespace, or both', async () => {
  const first = await create('ABC123');
  assert.equal(first.status, 200);
  const before = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  for (const dup of ['ABC123', 'abc123', 'Abc123', '  ABC123  ', '\tabc123\n']) {
    const r = await create(dup);
    assert.equal(r.status, 400, `"${dup}" must conflict`);
    assert.match(r.body.error, new RegExp(first.body.tag));
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, before, 'no rejected create left a row behind');
});

test('create: a rejected duplicate does not burn a generated tag number', async () => {
  await create('COUNTER-1');
  const counter = () => db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n;
  const n = counter();
  const r = await admin.post('/api/assets', { name: 'No tag given', serial: 'counter-1' }); // tag omitted -> generated
  assert.equal(r.status, 400);
  assert.equal(counter(), n, 'the tag counter is rolled back with the failed create');
});

test('different punctuation or spacing is a different serial, not a duplicate', async () => {
  const a = await create('XYZ-900');
  const b = await create('XYZ900');
  const c = await create('XYZ 900');
  const d = await create('XYZ/900');
  for (const r of [a, b, c, d]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(new Set([a, b, c, d].map((r) => row(r.body.id).serial_normalized)).size, 4);
});

test('blank serials mean "no serial": any number of assets may have one, and it is stored as NULL', async () => {
  const made = [];
  for (const blank of [undefined, null, '', '   ', '\t']) made.push(await create(blank));
  for (const r of made) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(row(r.body.id), { serial: null, serial_normalized: null });
  }
});

test('create: a serial must be text or a number', async () => {
  assert.equal((await create({ x: 1 })).status, 400);
  assert.equal((await create(['A'])).status, 400);
  assert.equal((await create(true)).status, 400);
  assert.equal((await create(48151623)).status, 200);
  assert.equal((await create('48151623')).status, 400, 'a number and its text form are the same serial');
});

// ---------------------------------------------------------------- edit
test('edit: changing into another asset\'s serial (any case / padding) is rejected and leaves the asset unchanged', async () => {
  const a = (await create('EDIT-A')).body;
  const b = (await create('EDIT-B')).body;
  for (const dup of ['EDIT-A', 'edit-a', '  Edit-A ']) {
    const r = await admin.put(`/api/assets/${b.id}`, { name: b.name, serial: dup });
    assert.equal(r.status, 400, `"${dup}" must conflict`);
    assert.match(r.body.error, new RegExp(a.tag));
  }
  assert.deepEqual(row(b.id), { serial: 'EDIT-B', serial_normalized: 'edit-b' });
  // a rejected edit must not have changed any other field in the same request
  const r = await admin.put(`/api/assets/${b.id}`, { name: 'Renamed in a bad edit', serial: 'edit-a' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT name FROM assets WHERE id = ?').get(b.id).name, b.name);
});

test('edit: an asset can keep its own serial, change only its case, or move to a free one', async () => {
  const a = (await create('KEEP-ME')).body;
  assert.equal((await admin.put(`/api/assets/${a.id}`, { name: 'Same serial again', serial: 'KEEP-ME' })).status, 200);
  assert.equal((await admin.put(`/api/assets/${a.id}`, { serial: 'keep-me' })).status, 200);
  assert.deepEqual(row(a.id), { serial: 'keep-me', serial_normalized: 'keep-me' }, 'the case the user typed is what is stored');
  assert.equal((await admin.put(`/api/assets/${a.id}`, { serial: '  Moved-On  ' })).status, 200);
  assert.deepEqual(row(a.id), { serial: 'Moved-On', serial_normalized: 'moved-on' });
  // the old serial is free again for someone else
  assert.equal((await create('KEEP-ME')).status, 200);
});

test('edit: omitting serial keeps it; a blank serial clears it (and frees it)', async () => {
  const a = (await create('CLEAR-ME')).body;
  assert.equal((await admin.put(`/api/assets/${a.id}`, { name: 'Renamed only' })).status, 200);
  assert.equal(row(a.id).serial, 'CLEAR-ME');
  assert.equal((await admin.put(`/api/assets/${a.id}`, { serial: '   ' })).status, 200);
  assert.deepEqual(row(a.id), { serial: null, serial_normalized: null });
  assert.equal((await create('clear-me')).status, 200);
});

// ---------------------------------------------------------------- archived / history
test('an archived asset keeps its serial reserved: it blocks new assets and edits, and is still found by lookup', async () => {
  const old = (await create('Retired-Unit-7')).body;
  assert.equal((await admin.post(`/api/assets/${old.id}/archive`, {})).status, 200);
  const dup = await create('retired-unit-7');
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /archived/);
  const other = (await create('LIVE-ONE')).body;
  assert.equal((await admin.put(`/api/assets/${other.id}`, { serial: ' RETIRED-UNIT-7 ' })).status, 400);
  assert.deepEqual(await lookup('RETIRED-unit-7'), { found: true, id: old.id, archived: true });
  assert.deepEqual(row(old.id), { serial: 'Retired-Unit-7', serial_normalized: 'retired-unit-7' }, 'archiving does not touch the serial');
});

// ---------------------------------------------------------------- lookup
test('lookup: a serial is found regardless of case or surrounding spaces; unknown and blank codes are not found', async () => {
  const a = (await create('Look-Up-9')).body;
  for (const code of ['Look-Up-9', 'look-up-9', 'LOOK-UP-9', '  look-up-9  ']) {
    assert.deepEqual(await lookup(code), { found: true, id: a.id, archived: false }, `"${code}"`);
  }
  assert.equal((await lookup('lookup9')).found, false, 'punctuation is not stripped to find a match');
  assert.equal((await lookup('   ')).found, false);
  assert.equal((await lookup(a.tag.toLowerCase())).id, a.id, 'tag lookup is unchanged');
});

// ---------------------------------------------------------------- CSV import
const importCsv = (text) => admin.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body: text });

test('import: a row whose serial belongs to another asset (any case) is skipped with a message; other rows still import', async () => {
  const owner = (await create('IMP-OWNED')).body;
  const r = await importCsv([
    'name,tag,serial',
    'Dup by case,IMP-1,imp-owned',
    'Dup by padding,IMP-2,"  IMP-OWNED "',
    'Fresh one,IMP-3,IMP-FRESH',
    'Same file dup,IMP-4,imp-fresh',
    'No serial,IMP-5,',
  ].join('\r\n'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 2);
  assert.equal(r.body.errors.length, 3);
  assert.match(r.body.errors[0], /Row 2.*imp-owned.*already used by asset SER-\d+ — skipped$/);
  assert.match(r.body.errors[2], /Row 5/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM assets WHERE tag IN ('IMP-1','IMP-2','IMP-4')").get().c, 0);
  assert.deepEqual(row(db.prepare("SELECT id FROM assets WHERE tag = 'IMP-3'").get().id), { serial: 'IMP-FRESH', serial_normalized: 'imp-fresh' });
  assert.equal(row(owner.id).serial, 'IMP-OWNED');
});

test('import: updating an existing asset by tag keeps its own serial valid, can change it, and refuses someone else\'s', async () => {
  const a = (await create('UPD-OLD')).body;
  const b = (await create('UPD-OTHER')).body;
  const r = await importCsv([
    'tag,serial',
    `${a.tag},upd-old`,       // own serial, different case: fine
    `${b.tag},UPD-OLD`,       // someone else's: skipped
    `${a.tag},`,              // blank on update keeps the stored serial
  ].join('\r\n'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.errors.length, 1);
  assert.equal(row(b.id).serial, 'UPD-OTHER');
  assert.deepEqual(row(a.id), { serial: 'upd-old', serial_normalized: 'upd-old' });
  const moved = await importCsv(`tag,serial\r\n${a.tag},UPD-NEW`);
  assert.equal(moved.body.errors.length, 0);
  assert.deepEqual(row(a.id), { serial: 'UPD-NEW', serial_normalized: 'upd-new' });
});

// ---------------------------------------------------------------- database backstop + consistency
test('the database itself refuses a duplicate normalized serial, while NULLs never collide', () => {
  const ins = db.prepare('INSERT INTO assets (tag, name, serial, serial_normalized) VALUES (?, ?, ?, ?)');
  ins.run('DB-1', 'one', 'Raw-1', 'raw-1');
  assert.throws(() => ins.run('DB-2', 'two', 'RAW-1', 'raw-1'), /UNIQUE/);
  ins.run('DB-3', 'blank 1', null, null);
  ins.run('DB-4', 'blank 2', null, null);
});

test('every asset row keeps serial and serial_normalized in step after all of the above', () => {
  const bad = db.prepare('SELECT id, tag, serial, serial_normalized FROM assets').all()
    .filter((a) => a.tag.startsWith('DB-') ? false : serialKey(a.serial) !== a.serial_normalized || (a.serial !== null && a.serial !== a.serial.trim()));
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- migration 8 on existing data
const upTo = (n) => { const d = new Database(':memory:'); d.pragma('foreign_keys = ON'); runMigrations(d, migrations.filter((m) => m.id <= n)); return d; };

test('migration 8: backfills the normalized serial, trims stored values, turns blanks into NULL, loses no asset', () => {
  const d = upTo(7);
  const ins = d.prepare('INSERT INTO assets (tag, name, serial) VALUES (?, ?, ?)');
  ins.run('M-1', 'padded', '  Abc-123 ');
  ins.run('M-2', 'plain', 'XyZ/9');
  ins.run('M-3', 'whitespace only', '   ');
  ins.run('M-4', 'empty string', '');
  ins.run('M-5', 'null', null);
  ins.run('M-6', 'similar but different', 'ABC123');
  const seqBefore = d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assets'").get().seq;
  assert.deepEqual(runMigrations(d, migrations.filter((m) => m.id <= 8)), [8]);
  const by = Object.fromEntries(d.prepare('SELECT tag, serial, serial_normalized FROM assets').all().map((r) => [r.tag, r]));
  assert.deepEqual(by['M-1'], { tag: 'M-1', serial: 'Abc-123', serial_normalized: 'abc-123' });
  assert.deepEqual(by['M-2'], { tag: 'M-2', serial: 'XyZ/9', serial_normalized: 'xyz/9' });
  for (const t of ['M-3', 'M-4', 'M-5']) assert.deepEqual([by[t].serial, by[t].serial_normalized], [null, null], t);
  assert.equal(by['M-6'].serial_normalized, 'abc123', '"ABC-123" and "ABC123" were NOT merged');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM assets').get().c, 6);
  assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assets'").get().seq, seqBefore);
  assert.throws(() => d.prepare("INSERT INTO assets (tag, name, serial_normalized) VALUES ('M-7', 'x', 'abc-123')").run(), /UNIQUE/);
  assert.equal(d.pragma('foreign_key_check').length, 0);
});

test('migration 8: existing normalized collisions abort it, list the assets, and change nothing', () => {
  const d = upTo(7);
  const ins = d.prepare('INSERT INTO assets (tag, name, serial) VALUES (?, ?, ?)');
  ins.run('C-1', 'first', 'SN100');
  ins.run('C-2', 'second', ' sn100 ');
  ins.run('C-3', 'archived twin', 'Sn100');
  ins.run('C-4', 'innocent', 'SN-100');
  d.prepare("UPDATE assets SET archived_at = datetime('now') WHERE tag = 'C-3'").run();
  assert.throws(() => runMigrations(d, migrations.filter((m) => m.id <= 8)), (e) => {
    assert.match(e.message, /Cannot enforce unique serial numbers/);
    for (const t of ['C-1', 'C-2', 'C-3']) assert.match(e.message, new RegExp(t));
    assert.doesNotMatch(e.message, /C-4/, 'a different serial is not reported');
    assert.match(e.message, /nothing was changed/);
    return true;
  });
  assert.equal(d.prepare('SELECT MAX(id) m FROM schema_migrations').get().m, 7, 'migration 8 was not recorded');
  assert.equal(d.pragma('table_info(assets)').some((c) => c.name === 'serial_normalized'), false, 'no half-applied column');
  assert.deepEqual(d.prepare('SELECT tag, serial FROM assets ORDER BY id').all().map((r) => r.serial), ['SN100', ' sn100 ', 'Sn100', 'SN-100'], 'no serial was altered, merged or discarded');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM assets').get().c, 4);
});
