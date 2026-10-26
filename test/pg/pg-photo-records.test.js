// Slice 5C-1 (D-46, D-48): src/pg/photoRecords.js, differential against src/photoRecords.js on twin fixtures (same rows and ids on both
// engines): the photo rows, lookups by id / file, the cover set and clear, delete clearing the cover, an asset's updated_at. Then the
// PostgreSQL-only guarantee: setCover and deletePhoto serialize on the asset lock, so a photo deleted while a cover is being set can
// never be left as the asset's cover (on SQLite the route's check and write ran in one event-loop turn). Skipped without PostgreSQL;
// `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const { waitFor, lockWaiters } = require('../../test-support/pg-write-support');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const sq = require('../../src/photoRecords');
const pg = require('../../src/pg/photoRecords');

describe('PostgreSQL photo records (differential against src/photoRecords.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let w;
  const same = (label, name, ...args) => tw.same(label, (q) => pg[name](q, ...args), (db) => sq[name](db, ...args));
  const both = async (name, ...args) => { await pg[name](pool, ...args); sq[name](tw.sqlite, ...args); };
  const rows = async (sql) => [(await pool.query(sql)).rows, tw.sqlite.prepare(sql).all()];
  const coverOf = async (id) => (await pool.query('SELECT cover_photo_id FROM assets WHERE id = $1', [id])).rows[0].cover_photo_id;

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana' });
    w.acc = await tw.insert('accounts', { login_email: 'ana@nutricost.com', role: 'admin', employee_id: w.ana.id });
    w.cam = await tw.asset({ name: 'Camera' });
    w.other = await tw.asset({ name: 'Other' });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('addPhoto returns the same new ids; getPhoto / photoAsset / photoByFile find the same rows (and nothing for unknown or bad ids)', async () => {
    await syncSequences(pool, tw.sqlite, ['photos']);
    const add = (cols) => tw.same(`add ${cols.filename}`, (q) => pg.addPhoto(q, cols), (db) => sq.addPhoto(db, cols));
    w.p1 = (await add({ assetId: w.cam.id, filename: 'a.jpg', thumb: 'a_t.jpg', caption: 'Ünïcode caption', uploadedBy: w.acc.id })).ok;
    w.p2 = (await add({ assetId: w.cam.id, filename: 'b.jpg', thumb: 'b_t.jpg', caption: null, uploadedBy: null })).ok;
    w.p3 = (await add({ assetId: w.other.id, filename: 'c.jpg', thumb: 'c_t.jpg', caption: undefined, uploadedBy: w.acc.id })).ok;
    assert.deepEqual([typeof w.p1, w.p2, w.p3], ['number', w.p1 + 1, w.p1 + 2]);
    const [pgRows, sqRows] = await rows('SELECT id, asset_id, filename, thumb, caption, uploaded_by FROM photos ORDER BY id');
    assert.deepEqual(pgRows, sqRows);
    for (const id of [w.p1, w.p3, 999999, 'x', null]) { await same(`get ${id}`, 'getPhoto', id); await same(`asset of ${id}`, 'photoAsset', id); }
    for (const f of ['a.jpg', 'a_t.jpg', 'c_t.jpg', 'A.JPG', 'nope.jpg']) await same(`by file ${f}`, 'photoByFile', f);
  });

  test('setCover sets and clears; deletePhoto removes the row and the cover that pointed at it; touchAsset bumps updated_at', async () => {
    await both('setCover', w.cam.id, w.p2);
    assert.equal(await coverOf(w.cam.id), w.p2);
    await both('setCover', w.cam.id, null);
    assert.equal(await coverOf(w.cam.id), null);
    await both('setCover', w.cam.id, w.p1);
    await both('deletePhoto', w.p1);
    await both('deletePhoto', 999999); // (unknown: nothing changes, no error)
    const sql = 'SELECT id, cover_photo_id FROM assets ORDER BY id';
    assert.deepEqual(...await rows(sql));
    assert.equal(await coverOf(w.cam.id), null);
    assert.deepEqual(...await rows('SELECT id FROM photos ORDER BY id'));
    await pool.query("UPDATE assets SET updated_at = '2000-01-01 00:00:00' WHERE id = $1", [w.other.id]);
    await pg.touchAsset(pool, w.other.id);
    assert.notEqual((await pool.query('SELECT updated_at FROM assets WHERE id = $1', [w.other.id])).rows[0].updated_at, '2000-01-01 00:00:00');
  });

  test('setCover re-checks the photo under the asset lock: gone -> 404, another asset\'s -> 400 (the route\'s own messages)', async () => {
    await assert.rejects(pg.setCover(pool, w.cam.id, 999999), { status: 404, message: 'Photo not found' });
    await assert.rejects(pg.setCover(pool, w.cam.id, w.p3), { status: 400, message: 'That photo belongs to a different asset' });
    assert.equal(await coverOf(w.cam.id), null);
  });

  test('a photo deleted while its cover is being set is never left as the cover (both writes wait for the asset lock)', async () => {
    const photo = await pg.addPhoto(pool, { assetId: w.cam.id, filename: 'race.jpg', thumb: 'race_t.jpg', caption: null, uploadedBy: null });
    let reached; const atGate = new Promise((r) => { reached = r; });
    let open; const gate = new Promise((r) => { open = r; });
    // the delete holds the asset lock (joined transaction) and has deleted the row, not yet committed
    const deleting = withTransaction(async (c) => { await pg.deletePhoto(c, photo); reached(); await gate; }, pool);
    await atGate;
    let settled = false;
    const covering = pg.setCover(pool, w.cam.id, photo).then(() => ({ ok: true }), (err) => ({ err })).finally(() => { settled = true; });
    await waitFor(async () => settled || (await lockWaiters(pool)) >= 1, 'setCover to wait for the asset lock (or finish)');
    assert.equal(settled, false, 'setCover waits while the delete holds the asset lock');
    open();
    await deleting;
    const out = await covering;
    assert.deepEqual([out.err?.status, out.err?.message], [404, 'Photo not found']);
    assert.equal(await coverOf(w.cam.id), null);
    // and the other order: a cover set first is cleared by the delete that follows it
    const second = await pg.addPhoto(pool, { assetId: w.cam.id, filename: 'race2.jpg', thumb: 'race2_t.jpg', caption: null, uploadedBy: null });
    await withTransaction(async (c) => { await lockAsset(c, w.cam.id); await pg.setCover(c, w.cam.id, second); }, pool);
    assert.equal(await coverOf(w.cam.id), second);
    await pg.deletePhoto(pool, second);
    assert.equal(await coverOf(w.cam.id), null);
  });
});
