// Slice 5C-2 (D-46, D-48): src/pg/assetViews.js, differential against src/assetViews.js. Every fixture row is written to BOTH engines
// with the same ids (test-support/pg-twin.js) and every call must give deep-equal results or the same { status, message } error: the
// empty database; the list for IT and employees (shared pool, held-by-me, permanent holders, archived rows and archived catalog
// entries, every filter, token search incl. catalog keywords, holder names, LIKE wildcards, mixed case and unicode); the scan lookup
// by tag / serial in odd case and whitespace; the asset page; the CSV export rows (commas, quotes, newlines); many rows with equal
// timestamps, so any ordering difference shows. Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');

const sq = require('../../src/assetViews');
const pg = require('../../src/pg/assetViews');

describe('PostgreSQL assetViews twin (differential against src/assetViews.js)', pgSuite(), () => {
  let tdb; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);
  const same = (label, name, ...args) => tw.same(label, (q) => pg[name](q, ...args), (db) => sq[name](db, ...args));
  const users = () => ({ admin: w.admin, ben: w.benUser, emile: w.emileUser, noPerson: w.noPerson });

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    today = await pgTime.today(tdb.pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Admin', work_email: 'ana@nutricost.com' });
    w.ben = await tw.employee({ name: 'Ben Borrower', department: 'Ops' });
    w.emile = await tw.employee({ name: 'Émile Ünïcode', work_email: 'Emile@Nutricost.com' });
    w.anaAcc = await tw.insert('accounts', { login_email: 'ana.login@nutricost.com', role: 'admin', employee_id: w.ana.id });
    w.benAcc = await tw.insert('accounts', { login_email: 'ben.login@nutricost.com', role: 'employee', employee_id: w.ben.id });
    w.emileAcc = await tw.insert('accounts', { login_email: 'emile.login@nutricost.com', role: 'employee', employee_id: w.emile.id });
    w.robot = await tw.insert('accounts', { login_email: 'unlinked@nutricost.com', role: 'admin', employee_id: null });
    w.admin = { role: 'admin', employee_id: w.ana.id, account_id: w.anaAcc.id };
    w.benUser = { role: 'employee', employee_id: w.ben.id, account_id: w.benAcc.id };
    w.emileUser = { role: 'employee', employee_id: w.emile.id, account_id: w.emileAcc.id };
    w.noPerson = { role: 'employee', employee_id: null, account_id: w.robot.id };
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('an empty database: no rows anywhere, no lookup match, the catalog filter 404s', async () => {
    for (const [u, user] of Object.entries(users())) {
      assert.deepEqual(await same(`empty list as ${u}`, 'listAssets', user, {}), { ok: [] });
      await same(`empty search as ${u}`, 'listAssets', user, { q: 'anything', status: 'overdue' });
    }
    assert.deepEqual(await same('empty export', 'exportRows'), { ok: [] });
    assert.deepEqual(await same('empty lookup', 'lookupCode', 'X-1'), { ok: undefined });
    assert.deepEqual((await same('no node', 'listAssets', w.admin, { catalog_node: '999999' })).error, { status: 404, message: 'Catalog entry not found' });
  });

  test('seed: the catalog, assets in every state, holders, photos, requests, reservations, waitlist places, activity', async () => {
    w.root = await tw.node('Laptops', { search_keywords: 'notebook' });
    w.mbp = await tw.node('MacBook Pro', { parent_id: w.root.id, search_keywords: 'mbp' });
    w.old = await tw.node('Old Models', { parent_id: w.root.id, archived_at: '2026-01-02 00:00:00', search_keywords: 'vintage' });
    w.oldKid = await tw.node('Retro Kid', { parent_id: w.old.id });
    tw.invalidateCatalogs();
    const A = (cols) => tw.asset({ category: 'Laptop', ...cols });
    w.cam = await A({ tag: 'CAM-Ünï', name: 'Shared Camera', brand: 'CaNoN', category: 'Camera', available_to_request: 1, catalog_node_id: w.mbp.id, serial: 'SN-AbC 123', serial_normalized: 'sn-abc 123', updated_at: '2026-03-01 00:00:00' });
    w.poolOut = await A({ name: 'Pool laptop (out)', available_to_request: 1, status: 'checked_out', catalog_node_id: w.root.id, location: '50% off shelf' });
    w.poolPerm = await A({ name: 'Pool laptop (permanent)', available_to_request: 1, status: 'checked_out' });
    w.archived = await A({ tag: 'ARCH-1', name: 'Archived laptop', available_to_request: 1, archived_at: '2026-01-02 00:00:00', serial: 'arch', serial_normalized: 'arch' });
    w.oldNode = await A({ name: 'Retro on archived entry', available_to_request: 1, catalog_node_id: w.oldKid.id, model: 'a_b' });
    w.repair = await A({ name: 'In repair', available_to_request: 1, status: 'maintenance', model: 'axb' });
    w.private = await A({ name: 'Private desk PC', category: 'Desktop' });
    w.license = await A({ name: 'Design suite, "Pro"\nlicense', category: 'Software', status: 'checked_out', available_to_request: 1, license_seats: 3, license_key: 'KEY-123',
      purchase_cost: 19.99, vendor: 'Vendor, Inc.', notes: 'line1\nline2, "quoted"', updated_at: '2026-02-01 00:00:00', reservation_requires_approval: 1 });
    // many rows with the SAME updated_at: SQLite's tie order must be reproduced exactly
    w.bulk = [];
    for (let i = 0; i < 25; i++) w.bulk.push(await A({ name: `Bulk ${String(25 - i).padStart(2, '0')}`, available_to_request: i % 2, tag: `BLK-${i}` }));
    await tw.assignment({ asset_id: w.poolPerm.id, employee_id: w.emile.id });
    await tw.checkout({ asset_id: w.poolOut.id, employee_id: w.emile.id, due_date: d(-2) });
    await tw.assignment({ asset_id: w.private.id, employee_id: w.ben.id });
    await tw.checkout({ asset_id: w.license.id, employee_id: w.emile.id, due_date: d(5), checked_out_at: '2026-01-05 00:00:00' });
    await tw.checkout({ asset_id: w.license.id, employee_id: w.ben.id, due_date: d(3) }); // same checked_out_at as the next one
    await tw.assignment({ asset_id: w.license.id, employee_id: w.ana.id });
    await tw.checkout({ asset_id: w.cam.id, employee_id: w.ben.id, due_date: d(-9), returned_at: '2026-01-03 00:00:00' }); // returned: never counts
    w.p1 = await tw.insert('photos', { asset_id: w.cam.id, filename: 'c1.jpg', thumb: 'c1_t.jpg' });
    w.p2 = await tw.insert('photos', { asset_id: w.cam.id, filename: 'c2.jpg', thumb: 'c2_t.jpg', caption: 'Ünï' });
    w.p3 = await tw.insert('photos', { asset_id: w.license.id, filename: 'l1.jpg', thumb: 'l1_t.jpg' });
    w.p4 = await tw.insert('photos', { asset_id: w.license.id, filename: 'l2.jpg', thumb: 'l2_t.jpg' });
    await tw.pg.query('UPDATE assets SET cover_photo_id = $1 WHERE id = $2', [w.p4.id, w.license.id]);
    tw.sqlite.prepare('UPDATE assets SET cover_photo_id = ? WHERE id = ?').run(w.p4.id, w.license.id);
    const req = (cols) => tw.insert('requests', { type: 'equipment', status: 'open', user_id: w.ben.id, created_by: w.benAcc.id, ...cols });
    await req({ type: 'issue', asset_id: w.license.id, message: 'Ünïcode issue' });
    await req({ type: 'return', asset_id: w.license.id, user_id: w.emile.id, created_by: w.anaAcc.id });
    await req({ type: 'return', asset_id: w.license.id, created_by: w.benAcc.id, status: 'dropped_off' });
    await req({ asset_id: w.license.id, user_id: w.emile.id, created_by: w.robot.id, opened_at: '2026-01-01 00:00:00' });
    await req({ asset_id: w.license.id, user_id: w.emile.id, created_by: null, created_at: '2026-01-04 00:00:00' });
    await req({ asset_id: w.license.id, status: 'cancelled', resolved_at: '2026-01-02 00:00:00', resolved_by: w.benAcc.id }); // not live
    const resv = (cols) => tw.reservation({ asset_id: w.cam.id, employee_id: w.ben.id, ...cols });
    await resv({ start_date: d(4), end_date: d(5) });
    await resv({ start_date: d(2), employee_id: w.emile.id, status: 'pending' });
    await resv({ start_date: d(-3), end_date: d(-2) }); // past
    await resv({ start_date: d(-1), end_date: today, start_time: '09:00', end_time: '12:00', employee_id: w.emile.id });
    await tw.entry({ asset_id: w.poolOut.id, employee_id: w.ben.id, start_date: d(1), queue_seq: 1 });
    await tw.entry({ asset_id: w.poolOut.id, employee_id: w.emile.id, start_date: d(1), queue_seq: 2 });
    await tw.entry({ asset_id: w.license.id, employee_id: w.ben.id, start_date: d(2), status: 'held', queue_seq: 1 });
    for (let i = 0; i < 105; i++) await tw.insert('activity', { asset_id: w.license.id, actor_id: [w.anaAcc.id, w.robot.id, null][i % 3], action: `act${i}`, details: i % 2 ? null : 'Ünï' });
  });

  test('listAssets: IT and employees, every filter and the search, identical rows and order (incl. 25 equal timestamps)', async () => {
    const queries = [
      {}, { q: 'cam' }, { q: 'CAM-ü' }, { q: 'cam-Ünï' }, { q: 'canon camera' }, { q: 'notebook' }, { q: 'mbp' }, { q: 'vintage' }, { q: 'retro' }, { q: 'émile' }, { q: 'ben' },
      { q: '50%' }, { q: 'a_b' }, { q: '\\' }, { q: 'sn-abc 123' }, { q: '  BULK   0 ' }, { q: 'a b c d e f g h i j' },
      { category: 'Laptop' }, { category: 'laptop' }, { catalog_node: String(w.root.id) }, { catalog_node: String(w.old.id) }, { catalog_node: 'abc' }, { catalog_node: '' },
      { status: 'overdue' }, { status: 'active' }, { status: 'maintenance' }, { status: 'checked_out', q: 'pool' }, { include_archived: '1' }, { include_archived: '1', q: 'arch' },
      { employee_id: String(w.ben.id) }, { user_id: String(w.emile.id) }, { employee_id: 'abc' }, { available: '1' }, { available: '1', q: 'bulk' },
    ];
    for (const [u, user] of Object.entries(users())) {
      for (const query of queries) await same(`list ${JSON.stringify(query)} as ${u}`, 'listAssets', user, query);
    }
    const all = (await same('admin all', 'listAssets', w.admin, {})).ok;
    assert.equal(all[0].id, w.cam.id, 'newest updated_at first');
    const lic = all.find((a) => a.id === w.license.id);
    assert.deepEqual([lic.seats_used, lic.holder_names, lic.permanent_holders, lic.checkout_holders, lic.thumb, lic.due_date], [3, 'Émile Ünïcode, Ben Borrower, Ana Admin', 1, 2, 'l2_t.jpg', d(3)]);
    assert.equal(all.find((a) => a.id === w.cam.id).thumb, 'c1_t.jpg', 'no cover: the first photo');
    assert.equal(all.find((a) => a.id === w.oldNode.id).catalog_path, 'Laptops > Old Models > Retro Kid');
    const ben = (await same('ben all', 'listAssets', w.benUser, {})).ok;
    const ids = ben.map((a) => a.id);
    for (const hidden of [w.license, w.private, w.poolPerm, w.archived, w.repair]) assert.ok(!ids.includes(hidden.id), `${hidden.name} is not in Ben's pool`);
    assert.ok(ids.includes(w.poolOut.id) && ids.includes(w.cam.id));
    const out = ben.find((a) => a.id === w.poolOut.id);
    assert.equal(out.holder_names, undefined); assert.equal(out.vendor, undefined); assert.equal(out.due_date, null);
    assert.equal(out.avail_state, 'checked_out'); assert.equal(out.expected_back, null, 'the only due date is in the past');
    assert.deepEqual([ben.find((a) => a.id === w.oldNode.id).catalog_node_id, ben.find((a) => a.id === w.oldNode.id).catalog_path], [null, null], 'archived entry hidden');
    assert.deepEqual((await same('vintage as ben', 'listAssets', w.benUser, { q: 'vintage' })).ok, [], 'an archived entry\'s keywords find nothing for employees');
    assert.deepEqual((await same('vintage as admin', 'listAssets', w.admin, { q: 'vintage' })).ok.map((a) => a.id), [w.oldNode.id]);
    assert.deepEqual((await same('holder search as admin', 'listAssets', w.admin, { q: 'borrower' })).ok.map((a) => a.id), [w.license.id, w.private.id]);
    assert.deepEqual((await same('holder search as emile', 'listAssets', w.emileUser, { q: 'borrower' })).ok, [], 'employees never match on holders');
    assert.deepEqual((await same('wildcard', 'listAssets', w.admin, { q: 'a_b' })).ok.map((a) => a.id), [w.oldNode.id], '_ is literal');
    assert.deepEqual((await same('unicode fold', 'listAssets', w.admin, { q: 'cam-Ünï' })).ok, [], 'non-ASCII letters are not case-folded (both engines)');
    assert.equal((await same('ascii fold', 'listAssets', w.admin, { q: 'CANON' })).ok[0].id, w.cam.id);
    assert.deepEqual((await same('archived node as ben', 'listAssets', w.benUser, { catalog_node: String(w.old.id) })).error, { status: 404, message: 'Catalog entry not found' });
  });

  test('lookupCode: tag in any ASCII case, normalized serial with spaces, archived assets, N/A, blanks, unicode, NUL', async () => {
    for (const code of ['cam-Ünï', 'CAM-Ünï', 'CAM-üNÏ', 'arch-1', 'ARCH', 'arch', ' SN-ABC 123 ', 'sn-abc 123', 'SN-AbC  123', 'n/a', 'N/A', '', '   ', 'blk-3', 'nope', 'a\u0000b', String(w.cam.id)]) {
      await same(`lookup ${JSON.stringify(code)}`, 'lookupCode', code);
    }
    assert.deepEqual((await same('tag case', 'lookupCode', 'cam-Ünï')).ok, { id: w.cam.id, archived_at: null });
    assert.deepEqual((await same('archived tag', 'lookupCode', 'arch-1')).ok, { id: w.archived.id, archived_at: '2026-01-02 00:00:00' });
    assert.deepEqual((await same('serial', 'lookupCode', ' SN-ABC 123 ')).ok, { id: w.cam.id, archived_at: null });
    assert.equal((await same('unicode case', 'lookupCode', 'CAM-üNÏ')).ok, undefined, 'non-ASCII letters must match exactly');
    assert.equal((await same('blank', 'lookupCode', '')).ok, null, 'serialKey(blank) is null, returned as is');
  });

  test('openAssignments, withCatalog, sanitizeAsset: holders in order, the viewer\'s own due date and license key only', async () => {
    for (const id of [w.license.id, w.cam.id, 999999, 'abc']) await same(`open ${id}`, 'openAssignments', id);
    const holders = (await same('license holders', 'openAssignments', w.license.id)).ok;
    assert.deepEqual(holders.map((h) => h.employee_id), [w.ben.id, w.ana.id, w.emile.id], 'checked_out_at, then id');
    assert.deepEqual(holders.map((h) => h.user_email), ['ben.login@nutricost.com', 'ana@nutricost.com', 'Emile@Nutricost.com']);
    const listRow = { ...w.license, due_date: d(3), holder_names: 'X, Y' };
    for (const [u, user] of Object.entries(users())) {
      for (const a of [w.license, w.cam, w.oldNode, w.private, listRow, { id: 1, name: 'no catalog column' }, null]) {
        await same(`sanitize ${a?.name} as ${u}`, 'sanitizeAsset', a, user);
        if (a) await same(`withCatalog ${a.name} as ${u}`, 'withCatalog', a, user);
      }
    }
    const emileView = (await same('emile holder', 'sanitizeAsset', listRow, w.emileUser)).ok;
    assert.deepEqual([emileView.license_key, emileView.due_date, emileView.vendor, emileView.holder_names], ['KEY-123', d(5), undefined, undefined]);
    assert.equal('license_key' in (await same('noPerson', 'sanitizeAsset', listRow, w.noPerson)).ok, false);
  });

  test('assetDetail: the asset page for IT, holders and other employees (requests, reservations, waitlist, upcoming, activity)', async () => {
    const assets = [w.cam, w.poolOut, w.poolPerm, w.archived, w.oldNode, w.repair, w.private, w.license, w.bulk[0]];
    for (const [u, user] of Object.entries(users())) {
      for (const a of assets) await same(`detail ${a.name} as ${u}`, 'assetDetail', user, a);
    }
    const it = (await same('license as IT', 'assetDetail', w.admin, w.license)).ok;
    assert.deepEqual([it.seats_used, it.capacity, it.is_mine, it.held_by_other, it.upcoming, it.holders.length, it.activity.length], [3, 3, true, false, true, 3, 100]);
    assert.equal(it.activity[0].action, 'act104');
    assert.deepEqual(it.requests.map((r) => [r.type, r.self_initiated, r.lifecycle]), [['equipment', 0, 'submitted'], ['issue', 1, 'submitted'], ['return', 0, 'submitted'], ['return', 1, 'dropped_off'], ['equipment', 0, 'in_review']]);
    assert.deepEqual(it.asset.purchase_cost, 19.99);
    const ben = (await same('license as Ben', 'assetDetail', w.benUser, w.license)).ok;
    assert.deepEqual([ben.holders.map((h) => h.employee_id), ben.requests.length, ben.activity, ben.waitlist.length, ben.reserve], [[w.ben.id], 2, [], 1, { allowed: false, requires_approval: true }]);
    const cam = (await same('camera as Emile', 'assetDetail', w.emileUser, w.cam)).ok;
    assert.deepEqual([cam.reservations.length, cam.photos.map((p) => p.id), cam.upcoming, cam.held_by_other], [2, [w.p1.id, w.p2.id], true, false]);
  });

  test('exportRows: every live asset by tag with its catalog path; commas, quotes and newlines come back unchanged', async () => {
    const rows = (await same('export', 'exportRows')).ok;
    assert.equal(rows.length, 32, "33 assets, one archived");
    assert.deepEqual(rows.map((r) => r.tag), [...rows.map((r) => r.tag)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'binary tag order');
    const lic = rows.find((r) => r.id === w.license.id);
    assert.deepEqual([lic.name, lic.notes, lic.vendor, lic.catalog_path, lic.holder_names], ['Design suite, "Pro"\nlicense', 'line1\nline2, "quoted"', 'Vendor, Inc.', '', 'Émile Ünïcode, Ben Borrower, Ana Admin']);
    assert.equal(rows.find((r) => r.id === w.oldNode.id).catalog_path, 'Laptops > Old Models > Retro Kid', 'IT export shows archived paths');
    assert.ok(!rows.some((r) => r.id === w.archived.id));
  });
});
