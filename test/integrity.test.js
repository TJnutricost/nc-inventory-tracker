const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const { app, db: _db } = bootApp();
  db = _db;
  server = await startServer(app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

const newAsset = async (name) => (await admin.post('/api/assets', { name })).body;
const addPhoto = (assetId) => db.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (?, 'p.jpg', 'p_t.jpg')").run(assetId).lastInsertRowid;
const cover = (assetId) => db.prepare('SELECT cover_photo_id c FROM assets WHERE id = ?').get(assetId).c;

test('cover photo: own photo succeeds, can be cleared', async () => {
  const a = await newAsset('Cover A'); const p = addPhoto(a.id);
  assert.equal((await admin.put(`/api/assets/${a.id}/cover`, { photo_id: p })).status, 200);
  assert.equal(cover(a.id), p);
  assert.equal((await admin.put(`/api/assets/${a.id}/cover`, { photo_id: null })).status, 200);
  assert.equal(cover(a.id), null);
});

test('cover photo: another asset\'s photo is rejected and the previous cover is kept', async () => {
  const a = await newAsset('Cover B'); const b = await newAsset('Cover C');
  const own = addPhoto(a.id); const foreign = addPhoto(b.id);
  await admin.put(`/api/assets/${a.id}/cover`, { photo_id: own });
  const r = await admin.put(`/api/assets/${a.id}/cover`, { photo_id: foreign });
  assert.equal(r.status, 400);
  assert.equal(cover(a.id), own);
});

test('cover photo: nonexistent, malformed photo and unknown asset are client errors; previous cover kept', async () => {
  const a = await newAsset('Cover D'); const own = addPhoto(a.id);
  await admin.put(`/api/assets/${a.id}/cover`, { photo_id: own });
  assert.equal((await admin.put(`/api/assets/${a.id}/cover`, { photo_id: 99999 })).status, 404);
  assert.equal((await admin.put(`/api/assets/${a.id}/cover`, { photo_id: 'abc' })).status, 400);
  assert.equal((await admin.put(`/api/assets/${a.id}/cover`, { photo_id: 1.5 })).status, 400);
  assert.equal((await admin.put('/api/assets/99999/cover', { photo_id: own })).status, 404);
  assert.equal(cover(a.id), own);
});

test('request creation: unknown asset/user → 404, malformed ids → 400, nothing saved', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM requests').get().c;
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', asset_id: 99999 })).status, 404);
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', user_id: 99999 })).status, 404);
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', asset_id: 'abc' })).status, 400);
  assert.equal((await admin.post('/api/requests', { category: 'Laptop', user_id: 'abc' })).status, 400);
  assert.equal((await admin.post('/api/requests', {})).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM requests').get().c, before);
});

test('request creation: valid requests (with and without an asset) still work', async () => {
  const a = await newAsset('Requested');
  const withAsset = await admin.post('/api/requests', { message: 'I need this one', asset_id: a.id });
  assert.equal(withAsset.status, 200);
  assert.equal(withAsset.body.asset_id, a.id);
  assert.equal((await admin.post('/api/requests', { category: 'Monitor' })).status, 200);
});

test('request approval: unknown or malformed asset id is a client error and the request stays open', async () => {
  const r = (await admin.post('/api/requests', { category: 'Phone' })).body;
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: 99999 })).status, 404);
  assert.equal((await admin.post(`/api/requests/${r.id}/approve`, { asset_id: 'abc' })).status, 400);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(r.id).status, 'open');
});

test('asset category/location: trimmed, and non-text values rejected', async () => {
  const ok = await admin.post('/api/assets', { name: 'Trim me', category: '  Laptop  ', location: '  Warehouse ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.category, 'Laptop');
  assert.equal(ok.body.location, 'Warehouse');
  assert.equal((await admin.post('/api/assets', { name: 'Bad', category: { x: 1 } })).status, 400);
  assert.equal((await admin.post('/api/assets', { name: 'Bad', location: ['HQ'] })).status, 400);
  assert.equal((await admin.put(`/api/assets/${ok.body.id}`, { category: 42 })).status, 400);
  assert.equal(db.prepare('SELECT category FROM assets WHERE id = ?').get(ok.body.id).category, 'Laptop');
});

test('self-checkout is a per-employee permission: the admin starts enabled and no global setting is exposed', async () => {
  const me = (await admin.get('/api/me')).body;
  assert.equal(me.user.can_self_checkout, true);
  assert.equal(me.settings.self_checkout, undefined);
});
