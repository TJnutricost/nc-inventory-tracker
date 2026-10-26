// Slice 5C-1 (D-46, D-48): src/pg/catalogViews.js and src/pg/catalogAdmin.js, differential against src/catalogViews.js /
// src/catalogAdmin.js on twin fixtures (same rows and ids on both engines): the tree for admin / employee (archived entries, counts,
// assets the employee already holds, unicode names), IT's search (ranking, keywords, the 60 cap), catalogOut, create and update with the
// category sync and their errors. Then the PostgreSQL-only guarantees: create and update + sync are ONE transaction (a failing sync
// rolls the rename back; a caller's transaction is joined), and concurrent edits are serialized (two crossing moves cannot make a
// cycle). Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const { waitFor, lockWaiters } = require('../../test-support/pg-write-support');
const { withTransaction } = require('../../src/pg/transaction');
const sqViews = require('../../src/catalogViews');
const sqAdmin = require('../../src/catalogAdmin');
const pgViews = require('../../src/pg/catalogViews');
const pgAdmin = require('../../src/pg/catalogAdmin');
const pgCatalog = require('../../src/pg/catalog');

describe('PostgreSQL catalog views and edits (differential against src/catalogViews.js / src/catalogAdmin.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let w;
  const users = {};
  const assetsSql = 'SELECT id, category, catalog_node_id FROM assets ORDER BY id';
  const sameAssets = async (label) => assert.deepEqual((await pool.query(assetsSql)).rows, tw.sqlite.prepare(assetsSql).all(), label);
  // A write on both engines (sequences synced first, so new rows get the same ids), outcomes compared; then the trees must agree.
  async function bothWrite(label, pgFn, sqFn) {
    await syncSequences(pool, tw.sqlite, ['catalog_nodes']);
    const out = await tw.same(label, pgFn, sqFn);
    await tw.same(`${label}: tree after`, (q) => pgViews.catalogTree(q, users.admin, '1'), (db) => sqViews.catalogTree(db, users.admin, '1'));
    await sameAssets(`${label}: assets after`);
    return out;
  }

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana' });
    w.ben = await tw.employee({ name: 'Ben' });
    users.admin = { role: 'admin', employee_id: w.ana.id };
    users.ben = { role: 'employee', employee_id: w.ben.id };
    users.noPerson = { role: 'employee', employee_id: null };
    w.camera = await tw.node('Camera', { search_keywords: 'photo video' });
    w.canon = await tw.node('Canon', { parent_id: w.camera.id });
    w.r5 = await tw.node('EOS R5', { parent_id: w.canon.id, search_keywords: 'mirrorless' });
    w.sony = await tw.node('Sony', { parent_id: w.camera.id });
    w.oldCam = await tw.node('Old film', { parent_id: w.camera.id, archived_at: '2026-01-01 00:00:00' });
    w.under = await tw.node('Under archived', { parent_id: w.oldCam.id });
    w.laptop = await tw.node('Notebooks');
    w.mac = await tw.node('Mac', { parent_id: w.laptop.id });
    w.ecran = await tw.node('Écran Ünïcode', { parent_id: w.laptop.id, search_keywords: 'monitor' });
    w.attic = await tw.node('attic', { archived_at: '2026-01-01 00:00:00' });
    const a = (node, cols = {}) => tw.asset({ catalog_node_id: node.id, category: 'Camera', available_to_request: 1, ...cols });
    w.a1 = await a(w.r5);
    w.a2 = await a(w.r5, { status: 'checked_out' });
    w.a3 = await a(w.canon, { available_to_request: 0 });
    w.a4 = await a(w.sony, { archived_at: '2026-01-02 00:00:00' });
    w.a5 = await a(w.under);
    w.a6 = await a(w.mac, { category: 'Notebooks' });
    w.a7 = await a(w.mac, { category: 'Stale text' });
    w.held = await a(w.ecran, { category: 'Notebooks' });
    await tw.checkout({ asset_id: w.held.id, employee_id: w.ben.id, due_date: '2999-01-01' });
    await tw.insert('requests', { type: 'equipment', status: 'open', user_id: w.ben.id, catalog_node_id: w.mac.id });
    tw.invalidateCatalogs();
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('catalogTree: admin with and without archived entries, employees (live only, shared assets, not their own), no-person employee', async () => {
    for (const [u, user] of Object.entries(users)) {
      for (const inc of ['1', undefined, '0']) await tw.same(`tree ${u} ${inc}`, (q) => pgViews.catalogTree(q, user, inc), (db) => sqViews.catalogTree(db, user, inc));
    }
    const benTree = await pgViews.catalogTree(pool, users.ben, '1');
    assert.ok(!benTree.some((n) => [w.oldCam.id, w.under.id, w.attic.id].includes(n.id)), 'no archived entries (or under one) for employees');
    assert.equal(benTree.find((n) => n.id === w.ecran.id).available_count, 0, 'the asset Ben holds is not offered to him');
    const adminTree = await pgViews.catalogTree(pool, users.admin, '1');
    assert.deepEqual(adminTree.find((n) => n.id === w.camera.id), {
      id: w.camera.id, parent_id: null, name: 'Camera', path: 'Camera', child_count: 3, available_count: 3, search_keywords: 'photo video', archived_at: null, live: true,
      asset_count: 4, direct_asset_count: 0, request_count: 0,
    });
  });

  test('searchCatalog: tokens over path and inherited keywords, own matches first then shallowest, archived flagged, no hits, the 60 cap', async () => {
    for (const tokens of [['canon'], ['camera', 'r5'], ['mirrorless'], ['photo'], ['écran'], ['monitor', 'notebooks'], ['nothing-matches'], ['under'], ['a']]) {
      await tw.same(`search ${tokens}`, (q) => pgViews.searchCatalog(q, tokens), (db) => sqViews.searchCatalog(db, tokens));
    }
    const { results } = await pgViews.searchCatalog(pool, ['photo']);
    assert.equal(results[0].id, w.camera.id, 'the entry whose own keywords match comes first');
    for (let i = 0; i < 70; i++) await tw.node(`Bulk ${String(i).padStart(2, '0')}`, { parent_id: w.attic.id });
    tw.invalidateCatalogs();
    const bulk = await tw.same('search bulk', (q) => pgViews.searchCatalog(q, ['bulk']), (db) => sqViews.searchCatalog(db, ['bulk']));
    assert.deepEqual([bulk.ok.total, bulk.ok.results.length, bulk.ok.results[0].archived], [70, 60, true]);
  });

  test('catalogOut and createNode: the same entry back, the same refusals (sibling clash ignoring case/space, archived parent, bad names, 404)', async () => {
    for (const id of [w.camera.id, w.under.id, w.mac.id]) await tw.same(`out ${id}`, (q) => pgAdmin.catalogOut(q, id), (db) => sqAdmin.catalogOut(db, id));
    assert.deepEqual((await tw.same('out unknown', (q) => pgAdmin.catalogOut(q, 999999), (db) => sqAdmin.catalogOut(db, 999999))).error, { status: 404, message: 'Catalog entry not found' });
    const create = (label, args) => bothWrite(label, (q) => pgAdmin.createNode(q, args), (db) => sqAdmin.createNode(db, args));
    const made = await create('create under Canon', { name: '  EOS   R6 ', parentId: w.canon.id, searchKeywords: 'Ünïcode, Body' });
    await tw.same('out new', (q) => pgAdmin.catalogOut(q, made.ok), (db) => sqAdmin.catalogOut(db, made.ok));
    await create('create root', { name: 'Phones' });
    for (const [label, args] of [['clash', { name: 'eos r5', parentId: w.canon.id }], ['archived parent', { name: 'X', parentId: w.oldCam.id }],
      ['blank', { name: '  ' }], ['arrow', { name: 'A > B' }], ['not text', { name: 5 }], ['unknown parent', { name: 'Y', parentId: 999999 }]]) {
      assert.equal((await create(label, args)).error.status, label === 'unknown parent' ? 404 : 400, label);
    }
  });

  test('updateNode: rename and move keep assets.category in step with the root; the same refusals; nothing changes on a refusal', async () => {
    const update = (label, id, args) => bothWrite(label, (q) => pgAdmin.updateNode(q, id, args), (db) => sqAdmin.updateNode(db, id, args));
    await update('rename a root', w.camera.id, { name: 'Cameras' });
    assert.equal((await pool.query('SELECT category FROM assets WHERE id = $1', [w.a1.id])).rows[0].category, 'Cameras');
    await update('move Sony to Notebooks', w.sony.id, { parent: String(w.laptop.id) });
    await update('move Mac to the top', w.mac.id, { parent: '' });
    await update('keywords only', w.r5.id, { searchKeywords: 'mirrorless, 8K' });
    for (const [label, id, args] of [['under itself', w.camera.id, { parent: String(w.r5.id) }], ['bad parent', w.canon.id, { parent: 'abc' }],
      ['archived destination', w.canon.id, { parent: String(w.attic.id) }], ['sibling clash (archived)', w.canon.id, { name: 'OLD  FILM' }], ['unknown', 999999, { name: 'Z' }]]) {
      assert.ok((await update(label, id, args)).error, label);
    }
    await tw.same('out moved', (q) => pgAdmin.catalogOut(q, w.sony.id), (db) => sqAdmin.catalogOut(db, w.sony.id));
  });

  test('createNode / updateNode are ONE transaction: a failing category sync rolls the rename back; a caller transaction is joined', async () => {
    await pool.query(`CREATE FUNCTION nc_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await pool.query("CREATE TRIGGER nc_test_boom BEFORE UPDATE OF category ON assets FOR EACH ROW WHEN (NEW.category = 'Boom') EXECUTE FUNCTION nc_test_boom()");
    const before = (await pool.query('SELECT * FROM catalog_nodes ORDER BY id')).rows;
    await assert.rejects(pgAdmin.updateNode(pool, w.laptop.id, { name: 'Boom', searchKeywords: 'changed' }), /boom/);
    assert.deepEqual((await pool.query('SELECT * FROM catalog_nodes ORDER BY id')).rows, before, 'the rename was rolled back with the failed sync');
    assert.equal((await pgAdmin.catalogOut(pool, w.laptop.id)).name, 'Notebooks', 'and the tree cache does not keep the rolled-back name');
    assert.equal((await pool.query("SELECT COUNT(*) n FROM assets WHERE category = 'Boom'")).rows[0].n, 0);
    // joined: everything rolls back with the caller's transaction
    await assert.rejects(withTransaction(async (c) => {
      const id = await pgAdmin.createNode(c, { name: 'Tablet', parentId: w.laptop.id });
      await pgAdmin.updateNode(c, w.ecran.id, { name: 'Display' });
      assert.equal((await pgAdmin.catalogOut(c, id)).path, 'Notebooks > Tablet', 'visible inside the caller transaction');
      throw new Error('caller fails');
    }, pool), /caller fails/);
    assert.deepEqual((await pool.query('SELECT * FROM catalog_nodes ORDER BY id')).rows, before);
    assert.equal(await pgCatalog.pathText(pool, w.ecran.id), 'Notebooks > Écran Ünïcode');
    await pool.query('DROP TRIGGER nc_test_boom ON assets');
  });

  test('concurrent edits are serialized: two crossing moves (A under B, B under A) cannot both pass the check, so no cycle', async () => {
    const A = (await pgAdmin.createNode(pool, { name: 'Cross A' })); const B = (await pgAdmin.createNode(pool, { name: 'Cross B' }));
    let reached; const atGate = new Promise((r) => { reached = r; });
    let open; const gate = new Promise((r) => { open = r; });
    const first = withTransaction(async (c) => { await pgAdmin.updateNode(c, A, { parent: String(B) }); reached(); await gate; }, pool);
    await atGate;
    let settled = false;
    const second = pgAdmin.updateNode(pool, B, { parent: String(A) }).then(() => ({ ok: true }), (err) => ({ err })).finally(() => { settled = true; });
    await waitFor(async () => settled || (await lockWaiters(pool)) >= 1, 'the second edit to wait for the catalog lock (or finish)');
    assert.equal(settled, false, 'the second edit waits while the first is uncommitted');
    open();
    await first;
    const out = await second;
    assert.equal(out.err?.status, 400);
    assert.equal(out.err.message, "A catalog entry can't be moved under itself or one of its own children.");
    const rows = (await pool.query('SELECT id, parent_id FROM catalog_nodes WHERE id IN ($1, $2) ORDER BY id', [A, B])).rows;
    assert.deepEqual(rows, [{ id: A, parent_id: B }, { id: B, parent_id: null }]);
  });
});
