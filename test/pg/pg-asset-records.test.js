// Slice 5C-5 (D-46, D-48): src/pg/assetRecords.js, differential against src/assetRecords.js, plus its transactions, locks and races.
// Twin worlds (test-support/pg-twin.js) hold the same rows with the same ids on both engines.
//   - The pure exports (FLAGS, ASSET_FIELDS, formatTag) equal the SQLite module's (no database needed).
//   - Reads / checks: tagExists and peekTag (NOCASE tags, ASCII-only folding (ap), taken numbers skipped, the tag_prefix setting),
//     assertSerialFree, resolveAssetNode.
//   - Writes: createAsset (issued / explicit tags, every refusal, the counter rolled back with a refused create, NaN / -0 numbers),
//     updateAsset, archiveAsset (404 / archived / open assignment), importAssets (every per-row outcome, the row numbering, the result,
//     the tables); a row that throws mid-file rolls the whole file back on both engines (no row, no counter movement, no activity).
//     The (as) / (at)-style differences: an unstorable license_seats value or a NUL fails on PostgreSQL (and rolls the import back).
//   - PostgreSQL only: one client per call and the lock statements first (spy); the caller's transaction joined; parallel creates and
//     imports never share a tag; explicit-tag / issued-number / serial races decided by the unique indexes with SQLite's 400; archive vs
//     check-out in both orders; the import vs a check-out in both orders and vs a create (no deadlock); the 5A lock timeout.
// Skipped without PostgreSQL (the pure-export check always runs).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const { result, overlap } = require('../../test-support/pg-auth-support');
const { blockAsset, spyPool, oneLine } = require('../../test-support/pg-write-support');
const fx = require('../../test-support/pg-fixtures');
const { withTransaction, setLockTimeout, BUSY_ASSET } = require('../../src/pg/transaction');
const { cleanSerial } = require('../../src/serial');

const sq = require('../../src/assetRecords');
const pg = require('../../src/pg/assetRecords');
const sqSettings = require('../../src/settings');
const pgSettings = require('../../src/pg/settings');
const pgAssignments = require('../../src/pg/assignments');

const T1 = '2026-01-01 00:00:00';
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const STAMPS = new Set(['created_at', 'updated_at', 'archived_at', 'checked_out_at', 'returned_at', 'resolved_at']);
const mask = (v) => {
  if (Array.isArray(v)) return v.map(mask);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, STAMPS.has(k) && typeof x === 'string' && STAMP.test(x) ? '<stamp>' : mask(x)]));
};
const TABLES = ['assets', 'activity', 'assignments', 'asset_tag_counter'];

// server.js `assetValues` (reads no database): what the routes pass as `v`.
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
function assetValues(body) {
  const v = {};
  for (const f of sq.ASSET_FIELDS) v[f] = ['purchase_cost', 'license_seats'].includes(f) ? num(body[f]) : clean(body[f]);
  v.serial = cleanSerial(body.serial);
  return v;
}
// POST /api/assets's `v` (name required, category / condition defaulted) and the create arguments.
const createArgs = (body, extra = {}) => {
  const v = assetValues(body); v.category = v.category || 'Other'; v.condition = v.condition || 'Good';
  return { tag: clean(body.tag), tagPrefix: 'NC-', status: 'available', nodeId: null, flags: [0, 0], v, actorAccountId: null, ...extra };
};
// The import's rows as server.js builds them (a fresh copy per engine: importAssets fills in defaults on `v`).
const importRows = (objs) => objs.map((o0) => {
  const o = { ...o0 };
  if (o.purchase_cost) o.purchase_cost = String(o.purchase_cost).replace(/[$,]/g, '');
  return { o, v: assetValues(o) };
});

test('the pure exports equal the SQLite module\'s (FLAGS, ASSET_FIELDS, formatTag)', () => {
  assert.deepEqual(pg.FLAGS, sq.FLAGS);
  assert.deepEqual(pg.ASSET_FIELDS, sq.ASSET_FIELDS);
  for (const [p, n] of [['NC-', 1], ['IT', 123456], ['', 0], ['x-', 99999]]) assert.equal(pg.formatTag(p, n), sq.formatTag(p, n));
});

describe('PostgreSQL asset record checks and the next-tag preview (differential against src/assetRecords.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.a1 = await tw.asset({ tag: 'NC-00001', name: 'One', serial: 'SN-1', serial_normalized: 'sn-1' });
    w.a2 = await tw.asset({ tag: 'nc-00002', name: 'Two (lower-case tag)' });
    w.uni = await tw.asset({ tag: 'cam-Ünï', name: 'Non-ASCII tag' });
    w.old = await tw.asset({ tag: 'OLD-1', name: 'Old', serial: 'Arch-SN', serial_normalized: 'arch-sn', archived_at: T1 });
    w.live = await tw.node('Laptops');
    w.mac = await tw.node('Mac', { parent_id: w.live.id });
    w.gone = await tw.node('Retired', { archived_at: T1 });
    w.under = await tw.node('Under retired', { parent_id: w.gone.id });
    tw.invalidateCatalogs();
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('tagExists: NOCASE tags (ASCII letters folded only, as SQLite)', async () => {
    for (const tag of ['NC-00001', 'nc-00001', 'NC-00002', 'cam-Ünï', 'CAM-Ünï', 'CAM-ÜNÏ', 'nope', '']) {
      await tw.same(`tagExists ${tag}`, (q) => pg.tagExists(q, tag), (db) => sq.tagExists(db, tag));
    }
    assert.equal(await pg.tagExists(tw.pg, 'CAM-Ünï'), true);
    assert.equal(await pg.tagExists(tw.pg, 'CAM-ÜNÏ'), false, 'Ü / Ï are not folded (SQLite NOCASE folds ASCII only)');
  });

  test('peekTag: skips taken numbers (any case), follows the tag_prefix setting, consumes nothing', async () => {
    assert.equal((await tw.same('peek, default prefix', (q) => pg.peekTag(q), (db) => sq.peekTag(db))).ok, 'NC-00003');
    await pgSettings.setSetting(tw.pg, 'tag_prefix', 'nc-'); sqSettings.setSetting(tw.sqlite, 'tag_prefix', 'nc-');
    assert.equal((await tw.same('peek, prefix nc-', (q) => pg.peekTag(q), (db) => sq.peekTag(db))).ok, 'nc-00003');
    await pgSettings.setSetting(tw.pg, 'tag_prefix', 'NC-'); sqSettings.setSetting(tw.sqlite, 'tag_prefix', 'NC-');
    assert.deepEqual((await tw.pg.query('SELECT last_number FROM asset_tag_counter')).rows, [{ last_number: 0 }], 'nothing consumed');
  });

  test('assertSerialFree: free, used (live / archived, any case and spacing), the asset itself, blank and N/A', async () => {
    const cases = [['SN-2', null], [' sn-1 ', null], ['SN-1', w.a1.id], ['SN-1', w.a2.id], ['ARCH-SN', null], ['', null], [null, null], ['n/a', null]];
    for (const [serial, except] of cases) {
      await tw.same(`serial ${serial} except ${except}`, (q) => pg.assertSerialFree(q, serial, except), (db) => sq.assertSerialFree(db, serial, except));
    }
  });

  test('resolveAssetNode: unchanged, unlinked, invalid, unknown, archived (kept only when current), live', async () => {
    const cases = [
      [{}, w.mac.id], [{}, null], [{}, undefined], [{ catalog_node_id: null }, w.mac.id], [{ catalog_node_id: '' }, null], [{ catalog_node_id: 'abc' }, null],
      [{ catalog_node_id: 0 }, null], [{ catalog_node_id: 1.5 }, null], [{ catalog_node_id: 999999 }, null], [{ catalog_node_id: w.gone.id }, null],
      [{ catalog_node_id: w.gone.id }, w.gone.id], [{ catalog_node_id: w.under.id }, null], [{ catalog_node_id: String(w.mac.id) }, null], [{ catalog_node_id: w.live.id }, w.mac.id],
    ];
    for (const [body, current] of cases) {
      await tw.same(`node ${JSON.stringify(body)} current ${current}`, (q) => pg.resolveAssetNode(q, body, current), (db) => sq.resolveAssetNode(db, body, current));
    }
  });
});

describe('PostgreSQL createAsset, updateAsset, archiveAsset and importAssets (differential against src/assetRecords.js)', pgSuite(), () => {
  let tdb; let tw; const w = {};
  async function sameTables(label) {
    const pgT = {}; const sqT = {};
    for (const t of TABLES) {
      pgT[t] = mask((await tw.pg.query(`SELECT * FROM ${t} ORDER BY id`)).rows);
      sqT[t] = mask(tw.sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    }
    assert.deepEqual(pgT, sqT, `${label}: the tables agree`);
    return pgT;
  }
  async function write(label, pgFn, sqFn) {
    await syncSequences(tw.pg, tw.sqlite);
    const pgOut = mask(await result(() => pgFn(tw.pg)));
    const sqOut = mask(await result(() => sqFn(tw.sqlite)));
    assert.deepEqual(pgOut, sqOut, label);
    await sameTables(label);
    return pgOut;
  }
  async function refused(label, pgFn, sqFn, expected) {
    const before = await sameTables(`${label} (before)`);
    const out = await write(label, pgFn, sqFn);
    assert.deepEqual(out, expected, label);
    assert.deepEqual(await sameTables(`${label} (after)`), before, `${label}: nothing written`);
  }
  const create = (label, args) => write(label, (q) => pg.createAsset(q, args), (db) => sq.createAsset(db, args));
  const update = (label, args) => write(label, (q) => pg.updateAsset(q, args), (db) => sq.updateAsset(db, args));
  const archive = (label, id, opts) => write(label, (q) => pg.archiveAsset(q, id, opts), (db) => sq.archiveAsset(db, id, opts));
  const importBoth = (label, objs) => write(label, (q) => pg.importAssets(q, { rows: importRows(objs), actorAccountId: w.anaAcc.id }),
    (db) => sq.importAssets(db, { rows: importRows(objs), actorAccountId: w.anaAcc.id }));
  const counter = async () => (await tw.pg.query('SELECT last_number FROM asset_tag_counter')).rows[0].last_number;
  // the asset as the route's PUT would pass it: the row's fields under the body, then the update arguments
  const editArgs = (a, body) => ({ id: a.id, tag: a.tag, status: a.status, nodeId: a.catalog_node_id, flags: [a.available_to_request, a.reservation_requires_approval], v: assetValues({ ...a, ...body }) });

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.ana = await tw.employee({ name: 'Ana', work_email: 'ana@example.com' });
    w.anaAcc = await tw.insert('accounts', { employee_id: w.ana.id, login_email: 'ana.login@example.com', role: 'admin' });
    w.ben = await tw.employee({ name: 'Ben', work_email: 'ben@example.com' });
    w.cara = await tw.employee({ name: 'Cara', work_email: 'cara@example.com' });
    await tw.insert('accounts', { employee_id: w.cara.id, login_email: 'cara.login@example.com', role: 'employee' });
    w.dan = await tw.employee({ name: 'Dan', work_email: 'dan@example.com', status: 'inactive' });
    w.eve = await tw.employee({ name: 'Eve', work_email: 'shared@example.com' });
    w.fay = await tw.employee({ name: 'Fay' });
    await tw.insert('accounts', { employee_id: w.fay.id, login_email: 'SHARED@example.com', role: 'employee' }); // a later employee wins the shared key
    w.laptops = await tw.node('Laptops');
    w.mac = await tw.node('Mac', { parent_id: w.laptops.id });
    w.a1 = await tw.asset({ tag: 'NC-00001', name: 'One', serial: 'SN-1', serial_normalized: 'sn-1', brand: 'Acme', purchase_cost: 10 });
    w.a2 = await tw.asset({ tag: 'nc-00002', name: 'Two' });
    w.old = await tw.asset({ tag: 'OLD-1', name: 'Old', serial: 'Arch-SN', serial_normalized: 'arch-sn', archived_at: T1 });
    w.held = await tw.asset({ tag: 'HELD-1', name: 'Held', status: 'checked_out' });
    await tw.assignment({ asset_id: w.held.id, employee_id: w.ben.id });
    tw.invalidateCatalogs();
    await sameTables('fixtures');
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('createAsset: issued and explicit tags, the activity row; refusals write nothing and leave the counter where it was', async () => {
    const issued = await create('issued tag (skips NC-00001 and nc-00002)', createArgs({ name: 'Laptop', serial: ' New-SN ' }, { actorAccountId: w.anaAcc.id }));
    assert.equal((await tw.pg.query('SELECT tag FROM assets WHERE id = $1', [issued.ok])).rows[0].tag, 'NC-00003');
    assert.equal(await counter(), 3);
    await create('explicit tag, catalog entry, flags, status', createArgs({ tag: 'MY-1', name: 'Mine', category: 'Laptops' }, { nodeId: w.mac.id, flags: [1, 0], status: 'maintenance' }));
    await create('numbers as SQLite stores them: NaN -> NULL, -0 -> 0, Infinity', createArgs({ tag: 'NUM-1', name: 'Numbers', purchase_cost: '-0', license_seats: 'n/a' }));
    await create('Infinity cost', createArgs({ tag: 'NUM-2', name: 'Inf', purchase_cost: '1e999' }));
    assert.deepEqual((await tw.pg.query("SELECT purchase_cost, license_seats FROM assets WHERE tag IN ('NUM-1', 'NUM-2') ORDER BY tag")).rows, [{ purchase_cost: 0, license_seats: null }, { purchase_cost: Infinity, license_seats: null }]);
    await refused('explicit tag used (other case)', (q) => pg.createAsset(q, createArgs({ tag: 'my-1', name: 'X' })), (db) => sq.createAsset(db, createArgs({ tag: 'my-1', name: 'X' })),
      { error: { status: 400, message: 'Tag my-1 is already used by another asset' } });
    await refused('explicit tag of an archived asset', (q) => pg.createAsset(q, createArgs({ tag: 'old-1', name: 'X' })), (db) => sq.createAsset(db, createArgs({ tag: 'old-1', name: 'X' })),
      { error: { status: 400, message: "Tag old-1 belongs to an archived asset and can't be reused" } });
    const serialUsed = createArgs({ name: 'X', serial: 'ARCH-SN' });
    await refused('issued tag + a serial in use (archived): the counter is rolled back', (q) => pg.createAsset(q, serialUsed), (db) => sq.createAsset(db, serialUsed),
      { error: { status: 400, message: 'Serial number ARCH-SN is already used by asset OLD-1 (archived). Serial numbers must be unique, ignoring letter case and surrounding spaces.' } });
    assert.equal(await counter(), 3);
  });

  test('createAsset: values PostgreSQL cannot store (license_seats 2.5, NUL) fail there and write nothing; SQLite stores them ((as) / (at))', async () => {
    const before = await sameTables('before');
    for (const body of [{ name: 'Half seat', license_seats: '2.5' }, { name: 'a\u0000b' }, { tag: 'T\u0000', name: 'NUL tag' }]) {
      assert.deepEqual(await result(() => pg.createAsset(tw.pg, createArgs(body))), { raw: true }, JSON.stringify(body));
      tw.sqlite.exec('SAVEPOINT probe');
      assert.equal(typeof sq.createAsset(tw.sqlite, createArgs(body)), 'number');
      tw.sqlite.exec('ROLLBACK TO probe; RELEASE probe');
    }
    assert.deepEqual(await sameTables('after'), before);
  });

  test('updateAsset: fields and serial; a serial of another asset is refused (nothing written); its own serial and a missing id are fine', async () => {
    await update('edit fields, own serial in another case', editArgs(w.a1, { brand: 'Globex', serial: 'sn-1', purchase_cost: 99.5, notes: 'n' }));
    await update('new serial, catalog, flags', { ...editArgs(w.a2, { serial: 'SN-2' }), nodeId: w.laptops.id, flags: [1, 1], status: 'maintenance' });
    const stolen = editArgs(w.a2, { serial: ' SN-1 ' });
    await refused('serial of another asset', (q) => pg.updateAsset(q, stolen), (db) => sq.updateAsset(db, stolen),
      { error: { status: 400, message: 'Serial number SN-1 is already used by asset NC-00001. Serial numbers must be unique, ignoring letter case and surrounding spaces.' } });
    for (const id of [999999, 'abc', 0]) {
      await refused(`missing id ${id}: no row, no error`, (q) => pg.updateAsset(q, { ...editArgs(w.a2, {}), id }), (db) => sq.updateAsset(db, { ...editArgs(w.a2, {}), id }), { ok: undefined });
    }
  });

  test('archiveAsset: 404 / already archived / open assignment refused with nothing written; archives with its activity row', async () => {
    for (const id of [999999, 'abc', '', 0, -1, 1.5]) {
      await refused(`missing ${id}`, (q) => pg.archiveAsset(q, id, {}), (db) => sq.archiveAsset(db, id, {}), { error: { status: 404, message: 'Asset not found' } });
    }
    await refused('already archived', (q) => pg.archiveAsset(q, w.old.id, {}), (db) => sq.archiveAsset(db, w.old.id, {}), { error: { status: 400, message: 'This asset is already archived.' } });
    await refused('checked out', (q) => pg.archiveAsset(q, String(w.held.id), {}), (db) => sq.archiveAsset(db, String(w.held.id), {}), { error: { status: 400, message: 'Check this asset in before archiving it.' } });
    const gone = await tw.asset({ tag: 'GONE-1', name: 'Gone' });
    await archive('with a reason', String(gone.id), { actorAccountId: w.anaAcc.id, reason: 'Broken' });
    const gone2 = await tw.asset({ tag: 'GONE-2', name: 'Gone too' });
    await archive('without a reason', gone2.id, { actorAccountId: w.anaAcc.id, reason: null });
    const rows = (await tw.pg.query("SELECT details FROM activity WHERE action = 'archived' ORDER BY id")).rows.map((r) => r.details);
    assert.deepEqual(rows, ['GONE-1 · Gone · Broken', 'GONE-2 · Gone too']);
  });

  test('importAssets: every per-row outcome, the row numbering, the result and the tables are the same', async () => {
    const out = await importBoth('a mixed file', [
      { tag: '', name: 'New Laptop', category: 'Laptops', serial: 'IMP-1', assigned_email: 'Ben@Example.com' },
      { tag: 'nc-00001', name: '', brand: 'Dell', serial: '' },
      { tag: 'old-1', name: 'Revive' },
      { tag: 'NEW-2', name: '' },
      { tag: 'NEW-3', name: 'Dup serial', serial: 'imp-1' },
      { tag: 'NEW-4', name: 'Mac', catalog_path: ' laptops  >  MAC ', assigned_email: 'cara.login@example.com' },
      { tag: 'NEW-5', name: 'Nowhere', catalog_path: 'No > Such', assigned_email: 'nobody@example.com' },
      { tag: 'NEW-6', name: 'Inactive', assigned_email: 'dan@example.com' },
      { tag: 'held-1', name: 'Held renamed', assigned_email: 'ben@example.com' },
      { tag: '', name: 'Cost', purchase_cost: '$1,200.50', license_seats: '3', category: 'Unknown cat' },
      { tag: '', name: 'Junk numbers', purchase_cost: 'TBD', license_seats: 'n/a', condition: 'Fair' },
      { tag: 'NEW-7', name: 'Shared key', assigned_email: 'shared@example.com' },
      { tag: 'NEW-7', name: 'Same tag again', serial: 'NEW-7-SN' },
    ]);
    assert.deepEqual([out.ok.created, out.ok.updated], [7, 3]);
    assert.deepEqual(out.ok.errors, [
      'Row 4: tag old-1 belongs to an archived asset — skipped',
      'Row 5: missing name',
      'Row 6: Serial number imp-1 is already used by asset NC-00004 — skipped',
      'Row 8: catalog path “No > Such” doesn\'t match an active catalog entry — imported without a catalog link',
      'Row 8: no user with email nobody@example.com — imported unassigned',
      'Row 9: no user with email dan@example.com — imported unassigned',
    ]);
    const held = (await tw.pg.query("SELECT a.tag, s.employee_id FROM assignments s JOIN assets a ON a.id = s.asset_id WHERE s.returned_at IS NULL ORDER BY s.id")).rows;
    assert.deepEqual(held.map((r) => [r.tag, r.employee_id]), [['HELD-1', w.ben.id], ['NC-00004', w.ben.id], ['NEW-4', w.cara.id], ['NEW-7', w.fay.id]], 'no double assignment; the later employee wins a shared key');
  });

  test('importAssets: a row that throws mid-file rolls the WHOLE file back on both engines (no row, no counter movement, no activity)', async () => {
    const before = await sameTables('before the failing file');
    const failing = () => {
      const rows = importRows([{ tag: '', name: 'First, issued' }, { tag: 'OK-1', name: 'Second' }, { tag: 'BAD-1', name: 'Third' }, { tag: 'NEVER', name: 'Fourth' }]);
      Object.defineProperty(rows[2].o, 'tag', { get() { throw new Error('a row that cannot be read'); } });
      return rows;
    };
    await syncSequences(tw.pg, tw.sqlite);
    assert.deepEqual(await result(() => pg.importAssets(tw.pg, { rows: failing(), actorAccountId: w.anaAcc.id })), { raw: true });
    assert.deepEqual(await result(() => sq.importAssets(tw.sqlite, { rows: failing(), actorAccountId: w.anaAcc.id })), { raw: true });
    assert.deepEqual(await sameTables('after the failing file'), before, 'nothing written, the counter unchanged');
    // PostgreSQL only: a value it cannot store (license_seats 2.5) in the third row, after an issued tag and an assignment
    const c0 = await counter();
    const bad = importRows([{ tag: '', name: 'Issued', assigned_email: 'ana@example.com' }, { tag: 'OK-2', name: 'Fine' }, { tag: 'HALF', name: 'Half seat', license_seats: '2.5' }]);
    assert.deepEqual(await result(() => pg.importAssets(tw.pg, { rows: bad, actorAccountId: w.anaAcc.id })), { raw: true });
    assert.equal(await counter(), c0);
    const pgNow = mask((await tw.pg.query('SELECT * FROM assets ORDER BY id')).rows);
    assert.deepEqual(pgNow, before.assets, 'no asset row');
    assert.deepEqual(mask((await tw.pg.query('SELECT * FROM activity ORDER BY id')).rows), before.activity, 'no activity row');
  });

  test('importAssets joins the caller\'s transaction: rolled back with it', async () => {
    const before = await sameTables('before');
    await assert.rejects(withTransaction(async (c) => {
      const out = await pg.importAssets(c, { rows: importRows([{ tag: '', name: 'Joined' }]), actorAccountId: w.anaAcc.id });
      assert.equal(out.created, 1);
      throw new Error('a later step of the caller failed');
    }, tw.pg), /a later step/);
    assert.deepEqual(await sameTables('after'), before);
  });
});

describe('PostgreSQL asset records: statement order, lock timeout and races', pgSuite(), () => {
  let tdb; let pool; let sampler; let admin; let n = 0;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
    admin = await fx.insertAccount(pool, { role: 'admin' });
  });
  after(async () => {
    setLockTimeout(null);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  const asset = (cols = {}) => fx.insertAsset(pool, { tag: `RR-${++n}`, ...cols });
  const counter = async () => (await pool.query('SELECT last_number FROM asset_tag_counter')).rows[0].last_number;
  const tagOf = async (id) => (await pool.query('SELECT tag FROM assets WHERE id = $1', [id])).rows[0].tag;
  const row = async (id) => (await pool.query('SELECT * FROM assets WHERE id = $1', [id])).rows[0];
  const activity = async (id) => (await pool.query('SELECT action FROM activity WHERE asset_id = $1 ORDER BY id', [id])).rows.map((r) => r.action);
  const checkout = (a, employeeId) => (q) => pgAssignments.createAssignment(q, { assetId: a.id, employeeId, actorAccountId: admin.id, actorIsAdmin: true, type: 'permanent' });
  const person = async (cols = {}) => (await fx.insertAccount(pool, cols)).employee_id;
  const edit = (a, body) => ({ id: a.id, tag: a.tag, status: a.status, nodeId: null, flags: [0, 0], v: assetValues({ ...a, ...body }) });

  test('one client per call; the counter claim, the table lock and the asset lock come first', async () => {
    const statements = async (fn) => {
      const spy = spyPool(pool);
      await fn(spy.pool);
      assert.deepEqual([...new Set(spy.calls.map((c) => c.client))], [1], 'every statement on the one transaction client');
      return spy.calls.map((c) => oneLine(c.sql));
    };
    const made = await statements((q) => pg.createAsset(q, createArgs({ name: 'Spy' })));
    assert.deepEqual(made.slice(0, 3), ['BEGIN', 'SAVEPOINT asset_write', 'UPDATE asset_tag_counter SET last_number = last_number + 1 WHERE id = 1 RETURNING last_number AS n']);
    assert.equal(made.at(-1), 'COMMIT');
    const imp = await statements((q) => pg.importAssets(q, { rows: importRows([{ tag: '', name: 'Spy import' }]), actorAccountId: admin.id }));
    assert.deepEqual(imp.slice(0, 3), ['BEGIN', 'SELECT last_number FROM asset_tag_counter WHERE id = 1 FOR UPDATE', 'LOCK TABLE assets IN EXCLUSIVE MODE']);
    const a = await asset();
    for (const fn of [(q) => pg.archiveAsset(q, a.id, { actorAccountId: admin.id }), (q) => pg.updateAsset(q, edit(a, { notes: 'x' }))]) {
      const sqls = await statements(fn);
      assert.deepEqual(sqls.slice(0, 2), ['BEGIN', 'SELECT * FROM assets WHERE id = $1 FOR UPDATE']);
    }
  });

  test('createAsset joins the caller\'s transaction: rolled back with it (no row, no counter movement)', async () => {
    const c0 = await counter();
    const rows0 = (await pool.query('SELECT COUNT(*)::int AS n FROM assets')).rows[0].n;
    await assert.rejects(withTransaction(async (c) => { await pg.createAsset(c, createArgs({ name: 'Joined' })); throw new Error('later step'); }, pool), /later step/);
    assert.deepEqual([await counter(), (await pool.query('SELECT COUNT(*)::int AS n FROM assets')).rows[0].n], [c0, rows0]);
  });

  test('parallel creates and imports never share a tag: the counter row serializes the claims', async () => {
    const c0 = await counter();
    const creates = Array.from({ length: 6 }, (_, i) => pg.createAsset(pool, createArgs({ name: `Parallel ${i}` })));
    const imports = [1, 2].map((k) => pg.importAssets(pool, { rows: importRows([{ tag: '', name: `Imp ${k}a` }, { tag: '', name: `Imp ${k}b` }]), actorAccountId: admin.id }));
    const ids = await Promise.all(creates);
    const outs = await Promise.all(imports);
    assert.deepEqual(outs.map((o) => o.created), [2, 2]);
    const tags = (await pool.query("SELECT tag FROM assets WHERE name LIKE 'Parallel %' OR name LIKE 'Imp %' ORDER BY tag")).rows.map((r) => r.tag);
    assert.equal(new Set(tags).size, 10);
    assert.equal(await counter(), c0 + 10);
    assert.deepEqual(tags, Array.from({ length: 10 }, (_, i) => pg.formatTag('NC-', c0 + 1 + i)), 'consecutive numbers, none lost');
    assert.equal(ids.length, 6);
  });

  test('explicit-tag, issued-number and serial races: decided by the unique indexes, with the 400 SQLite gives the second', async () => {
    const same = await overlap(pool, sampler, (c) => pg.createAsset(c, createArgs({ tag: 'RACE-1', name: 'First' })), (q) => pg.createAsset(q, createArgs({ tag: 'race-1', name: 'Second' })));
    assert.deepEqual([same.second, same.blocked], [{ error: { status: 400, message: 'Tag race-1 is already used by another asset' } }, true]);
    // an explicit tag equal to the next issued number, committed while a blank-tag create waits: the number is skipped, as allocateTag does
    const next = pg.formatTag('NC-', (await counter()) + 1);
    const issued = await overlap(pool, sampler, (c) => pg.createAsset(c, createArgs({ tag: next, name: 'Explicit' })), (q) => pg.createAsset(q, createArgs({ name: 'Issued' })));
    assert.ok('ok' in issued.second && issued.blocked, JSON.stringify(issued));
    assert.equal(await tagOf(issued.second.ok), pg.formatTag('NC-', Number(next.slice(3)) + 1));
    assert.equal(await counter(), Number(next.slice(3)) + 1);
    const serial = await overlap(pool, sampler, (c) => pg.createAsset(c, createArgs({ tag: 'SER-1', name: 'A', serial: 'RACE-SN' })), (q) => pg.createAsset(q, createArgs({ tag: 'SER-2', name: 'B', serial: ' race-sn ' })));
    assert.deepEqual([serial.second, serial.blocked], [{ error: { status: 400, message: 'Serial number race-sn is already used by asset SER-1. Serial numbers must be unique, ignoring letter case and surrounding spaces.' } }, true]);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM assets WHERE tag = 'SER-2'")).rows[0].n, 0);
    const x = await asset(); const y = await asset();
    const upd = await overlap(pool, sampler, (c) => pg.updateAsset(c, edit(x, { serial: 'U-SN' })), (q) => pg.updateAsset(q, edit(y, { serial: 'u-sn' })));
    assert.deepEqual([upd.second, upd.blocked], [{ error: { status: 400, message: `Serial number u-sn is already used by asset ${x.tag}. Serial numbers must be unique, ignoring letter case and surrounding spaces.` } }, true]);
    assert.equal((await row(y.id)).serial, null, 'the loser wrote nothing');
  });

  test('archive vs check-out, both orders, and two archives: one asset lock, one winner, SQLite\'s refusal for the other', async () => {
    const p = await person();
    const a = await asset();
    const one = await overlap(pool, sampler, (c) => pg.archiveAsset(c, a.id, { actorAccountId: admin.id }), checkout(a, p));
    assert.deepEqual([one.second, one.blocked], [{ error: { status: 400, message: 'This asset is archived and can\'t be checked out.' } }, true]);
    const b = await asset();
    const two = await overlap(pool, sampler, checkout(b, p), (q) => pg.archiveAsset(q, b.id, { actorAccountId: admin.id }));
    assert.deepEqual([two.second, two.blocked], [{ error: { status: 400, message: 'Check this asset in before archiving it.' } }, true]);
    assert.deepEqual([(await row(b.id)).archived_at, await activity(b.id)], [null, ['checked_out']]);
    const c = await asset();
    const three = await overlap(pool, sampler, (cl) => pg.archiveAsset(cl, c.id, {}), (q) => pg.archiveAsset(q, c.id, {}));
    assert.deepEqual([three.second, three.blocked], [{ error: { status: 400, message: 'This asset is already archived.' } }, true]);
    assert.deepEqual(await activity(c.id), ['archived']);
  });

  test('the import vs a check-out of an asset in the file (both orders) and vs a create: no deadlock, a consistent result', async () => {
    await fx.insertEmployee(pool, { name: 'Ben Import', work_email: 'ben.import@example.com' });
    const cara = await person();
    const a = await asset();
    const file = (x) => ({ rows: importRows([{ tag: x.tag, name: 'In the file', assigned_email: 'ben.import@example.com' }]), actorAccountId: admin.id });
    const one = await overlap(pool, sampler, (c) => pg.importAssets(c, file(a)), checkout(a, cara));
    assert.ok(one.blocked, 'the check-out waited for the import');
    assert.deepEqual(one.second, { error: { status: 400, message: 'Already checked out to Ben Import. Check it in first.' } });
    const b = await asset();
    const two = await overlap(pool, sampler, checkout(b, cara), (q) => pg.importAssets(q, file(b)));
    assert.ok(two.blocked, 'the import waited for the check-out');
    assert.deepEqual(two.second.ok, { created: 0, updated: 1, errors: [] });
    assert.deepEqual((await pool.query('SELECT employee_id FROM assignments WHERE asset_id = $1', [b.id])).rows.map((r) => r.employee_id), [cara], 'not assigned twice');
    const c0 = await counter();
    const three = await overlap(pool, sampler, (c) => pg.importAssets(c, { rows: importRows([{ tag: '', name: 'Imported first' }]), actorAccountId: admin.id }), (q) => pg.createAsset(q, createArgs({ name: 'Created second' })));
    assert.ok(three.blocked && 'ok' in three.second, JSON.stringify(three));
    assert.deepEqual([await tagOf(three.second.ok), await counter()], [pg.formatTag('NC-', c0 + 2), c0 + 2]);
  });

  test('a busy asset: archive and update give 503 ASSET_BUSY after the lock timeout and write nothing', async () => {
    const a = await asset({ notes: 'before' });
    const blocker = await blockAsset(pool, a.id);
    try {
      setLockTimeout(150);
      assert.deepEqual(await result(() => pg.archiveAsset(pool, a.id, { actorAccountId: admin.id })), { error: { status: 503, message: BUSY_ASSET } });
      assert.deepEqual(await result(() => pg.updateAsset(pool, edit(a, { notes: 'after' }))), { error: { status: 503, message: BUSY_ASSET } });
    } finally {
      setLockTimeout(null);
      await blocker.release();
    }
    const now = await row(a.id);
    assert.deepEqual([now.archived_at, now.notes, await activity(a.id)], [null, 'before', []]);
  });
});
