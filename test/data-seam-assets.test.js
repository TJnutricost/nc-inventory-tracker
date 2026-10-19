// PostgreSQL migration Slice 5B-2 on the TEMPORARY database driver seam (D-48): the asset, photo, dashboard and catalog-read routes now
// reach SQLite through src/dataSeam. These tests pin what the conversion must not change: the photo row / file / cover lifecycle (no
// other test deletes a photo), the refusals of the extracted helpers reaching the client unchanged, and the read views answering through
// the seam (and over HTTP) exactly what the extracted module answers when called directly. SQLite only; never sends email.
// The SQLite side of the temporary driver seam: it opens SQLite itself, so it does not run in the PostgreSQL pass (test/pg covers the PG side).
if (process.env.NC_TEST_DRIVER === 'pg') { require('node:test').test(`${require('path').basename(__filename)} (SQLite seam)`, { skip: 'SQLite seam; the PG side is covered by test/pg' }, () => {}); return; }
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, dir, admin, adminUser, data;
before(async () => {
  const booted = bootApp();
  ({ db, dir } = booted);
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  const me = (await admin.get('/api/me')).body.user;
  adminUser = { role: 'admin', employee_id: me.employee_id, account_id: me.account_id, name: me.name };
  data = require('../src/dataSeam').open({ db });
});
after(() => stopServer(server));

let seq = 0;
async function newAsset(extra = {}) {
  const r = await admin.post('/api/assets', { name: `Seam Asset ${++seq}`, tag: `SA-${seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const email = `seam-assets${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  const me = (await client.get('/api/me')).body.user;
  return { client, user: { role: 'employee', employee_id: me.employee_id, account_id: me.account_id, name: me.name } };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function upload(client, assetId, files = 1) {
  const boundary = '----ncSeamBoundary';
  const parts = [];
  for (let i = 0; i < files; i++) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="p${i}.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return client.rawPost(`/api/assets/${assetId}/photos`, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Requested-With': 'fetch' }, body: Buffer.concat(parts) });
}
const uploads = (f) => path.join(dir, 'uploads', f);
const settle = () => new Promise((res) => setTimeout(res, 50)); // fs.rm callbacks

test('photos: upload, cover, delete and the /uploads check behave exactly as before the move to the seam', async () => {
  const asset = await newAsset();
  const up = await upload(admin, asset.id, 2);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.ok, true);
  assert.equal(up.body.ids.length, 2);
  const [p1, p2] = up.body.ids;
  const rows = db.prepare('SELECT * FROM photos WHERE asset_id = ? ORDER BY id').all(asset.id);
  assert.deepEqual(rows.map((r) => r.id), [p1, p2]);
  for (const r of rows) { assert.ok(fs.existsSync(uploads(r.filename))); assert.ok(fs.existsSync(uploads(r.thumb))); assert.equal(r.uploaded_by, adminUser.account_id); }
  const act = db.prepare("SELECT details FROM activity WHERE asset_id = ? AND action = 'photo_added'").all(asset.id);
  assert.deepEqual(act, [{ details: '2 photos' }]);

  // cover: the list shows the cover's thumbnail; a cover from another asset or an unknown photo is refused
  assert.deepEqual((await admin.put(`/api/assets/${asset.id}/cover`, { photo_id: p2 })).body, { ok: true });
  assert.equal(db.prepare('SELECT cover_photo_id c FROM assets WHERE id = ?').get(asset.id).c, p2);
  const listed = (await admin.get('/api/assets')).body.find((a) => a.id === asset.id);
  assert.equal(listed.thumb, rows[1].thumb);
  const other = await newAsset();
  assert.deepEqual(await admin.put(`/api/assets/${other.id}/cover`, { photo_id: p2 }).then((r) => [r.status, r.body]), [400, { error: 'That photo belongs to a different asset' }]);
  assert.deepEqual(await admin.put(`/api/assets/${asset.id}/cover`, { photo_id: 987654 }).then((r) => [r.status, r.body]), [404, { error: 'Photo not found' }]);

  // an employee who can see the asset but does not hold it may not add photos; they can fetch its files (it is in the shared pool)
  const emp = await makeLogin('Pat Photo');
  assert.deepEqual(await upload(emp.client, asset.id).then((r) => [r.status, r.body]), [403, { error: 'Only IT or the person holding this asset can add photos' }]);
  assert.equal((await emp.client.get(`/uploads/${rows[0].thumb}`)).status, 200);

  // delete: the row, the cover that pointed at it and the files go; the other photo stays; a second delete is a 404
  assert.deepEqual((await admin.del(`/api/photos/${p2}`)).body, { ok: true });
  await settle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(p2).c, 0);
  assert.equal(db.prepare('SELECT cover_photo_id c FROM assets WHERE id = ?').get(asset.id).c, null);
  assert.equal(fs.existsSync(uploads(rows[1].filename)), false);
  assert.equal(fs.existsSync(uploads(rows[1].thumb)), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(p1).c, 1);
  assert.equal((await admin.get('/api/assets')).body.find((a) => a.id === asset.id).thumb, rows[0].thumb, 'the list falls back to the first photo');
  assert.deepEqual(await admin.del(`/api/photos/${p2}`).then((r) => [r.status, r.body]), [404, { error: 'Photo not found' }]);
  assert.equal((await emp.client.get(`/uploads/${rows[1].thumb}`)).status, 404, 'a deleted photo is not served');
});

test('refusals from the extracted 5B-2 helpers reach the client unchanged through the migrated routes', async () => {
  const emp = await makeLogin('Rita Refused');
  const visible = await newAsset();
  const directError = (f) => { try { f(); } catch (e) { return e; } assert.fail('expected a refusal'); };
  const cases = [
    [() => admin.post('/api/assets/987654/archive', {}), () => require('../src/assetRecords').archiveAsset(db, 987654, { actorAccountId: 1 })],
    [() => admin.del('/api/assets/987654'), () => require('../src/assetRecords').archiveAsset(db, 987654, { actorAccountId: 1 })],
    [() => admin.post('/api/assets', { name: 'Twin', tag: visible.tag }), () => require('../src/assetRecords').createAsset(db, { tag: visible.tag, status: 'available', nodeId: null, flags: [0, 0], v: { name: 'Twin' }, actorAccountId: 1 })],
    [() => admin.put(`/api/assets/${visible.id}`, { catalog_node_id: 987654 }), () => require('../src/assetRecords').resolveAssetNode(db, { catalog_node_id: 987654 }, null)],
    [() => admin.get('/api/assets?catalog_node=987654'), () => require('../src/assetViews').listAssets(db, adminUser, { catalog_node: '987654' })],
    [() => emp.client.get('/api/assets/987654'), () => require('../src/assetAccess').visibleAsset(db, emp.user, 987654)],
    [() => emp.client.post(`/api/assets/${visible.id}/my-return-request`, {}), () => require('../src/assetAccess').heldAsset(db, emp.user, visible.id)],
    [() => emp.client.post(`/api/assets/${visible.id}/return-notice`, {}), () => require('../src/assetCustody').returnNotice(db, emp.user, visible, null)],
    [() => admin.post('/api/requests/987654/deny', {}), () => require('../src/requestAccess').loadRequest(db, 987654)],
    [() => emp.client.post('/api/requests/987654/cancel', {}), () => require('../src/requestAccess').loadRequest(db, 987654)],
  ];
  for (const [viaHttp, direct] of cases) {
    const e = directError(direct);
    assert.ok(e.status >= 400 && e.status < 500, `a client refusal: ${e.message}`);
    const res = await viaHttp();
    assert.equal(res.status, e.status, e.message);
    assert.deepEqual(res.body, { error: e.message });
  }
});

test('the read views answer through the seam, and over HTTP, exactly what the extracted modules answer directly', async () => {
  const assetViews = require('../src/assetViews');
  const dashboard = require('../src/dashboard');
  const catalogViews = require('../src/catalogViews');
  const reservationViews = require('../src/reservationViews');
  const emp = await makeLogin('Vera Views');
  const node = (await admin.post('/api/catalog', { name: `Seam Views ${++seq}`, search_keywords: 'viewfinder' })).body;
  const mineAsset = await newAsset({ catalog_node_id: node.id, serial: `SER-${seq}` });
  const poolAsset = await newAsset({ catalog_node_id: node.id });
  assert.equal((await admin.post(`/api/assets/${mineAsset.id}/checkout`, { employee_id: emp.user.employee_id, assignment_type: 'checkout', due_date: '2099-01-01' })).status, 200);
  const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  assert.equal((await emp.client.post(`/api/assets/${poolAsset.id}/reservations`, { start_date: day, end_date: day })).status, 200);
  assert.equal((await emp.client.post(`/api/assets/${mineAsset.id}/report-issue`, { message: 'Hinge is loose' })).status, 200);

  for (const [u, client] of [[adminUser, admin], [emp.user, emp.client]]) {
    const isAdmin = u.role === 'admin';
    const q = { q: 'seam' };
    assert.deepEqual(await data.assetViews.listAssets(u, q), assetViews.listAssets(db, u, q));
    assert.deepEqual((await client.get('/api/assets?q=seam')).body, JSON.parse(JSON.stringify(assetViews.listAssets(db, u, q))));
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(isAdmin ? poolAsset.id : mineAsset.id);
    assert.deepEqual(await data.assetViews.assetDetail(u, a), assetViews.assetDetail(db, u, a));
    assert.deepEqual((await client.get(`/api/assets/${a.id}`)).body, JSON.parse(JSON.stringify(assetViews.assetDetail(db, u, a))));
    assert.deepEqual((await client.get('/api/dashboard')).body, JSON.parse(JSON.stringify(dashboard.dashboard(db, u))));
    assert.deepEqual(await data.dashboard.dashboard(u), dashboard.dashboard(db, u));
    assert.deepEqual((await client.get('/api/catalog')).body, catalogViews.catalogTree(db, u, undefined));
    assert.deepEqual((await client.get('/api/reservations?status=open')).body, JSON.parse(JSON.stringify(reservationViews.listReservations(db, u, 'open'))));
    assert.deepEqual(await data.reservationViews.listReservations(u, undefined), reservationViews.listReservations(db, u, undefined));
  }
  assert.deepEqual((await admin.get('/api/catalog/search?q=viewfinder')).body, catalogViews.searchCatalog(db, ['viewfinder']));
  assert.deepEqual((await admin.get('/api/catalog?include_archived=1')).body, catalogViews.catalogTree(db, adminUser, '1'));
  // the scanner: the tag in any letter case, then the serial; an employee is told only that an asset they can't open is unavailable
  assert.deepEqual(await data.assetViews.lookupCode(mineAsset.tag.toLowerCase()), assetViews.lookupCode(db, mineAsset.tag.toLowerCase()));
  assert.deepEqual((await admin.get(`/api/assets/lookup/${encodeURIComponent(mineAsset.tag.toLowerCase())}`)).body, { found: true, id: mineAsset.id, archived: false });
  assert.deepEqual((await admin.get(`/api/assets/lookup/ser-${mineAsset.serial.slice(4)}`)).body, { found: true, id: mineAsset.id, archived: false });
  const outsider = await makeLogin('Otto Outsider');
  assert.deepEqual((await outsider.client.get(`/api/assets/lookup/${mineAsset.tag}`)).body, { found: false, unavailable: true, code: mineAsset.tag });
  assert.deepEqual((await outsider.client.get('/api/assets/lookup/NO-SUCH-CODE')).body, { found: false, code: 'NO-SUCH-CODE' });
});
