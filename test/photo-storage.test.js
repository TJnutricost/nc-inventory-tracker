// Photo files in a private S3 bucket (Railway Buckets), against an in-process S3 stand-in (test-support/fake-s3.js).
// The photo rows stay in the database; the bucket holds `photos/<name>.jpg` and `photos/<name>_t.jpg`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');
const { startFakeS3 } = require('../test-support/fake-s3');
const { fromEnv } = require('../src/photoStorage');

let s3, server, db, dir, admin;
const ENV = ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_FORCE_PATH_STYLE'];

before(async () => {
  s3 = await startFakeS3();
  Object.assign(process.env, { S3_BUCKET: s3.bucket, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY_ID: s3.accessKey, S3_SECRET_ACCESS_KEY: 'TESTSECRET', S3_REGION: 'auto', S3_FORCE_PATH_STYLE: '1' });
  const booted = bootApp();
  db = booted.db; dir = booted.dir;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(async () => { await stopServer(server); await s3.close(); ENV.forEach((k) => delete process.env[k]); });

async function makeEmployee(name, email) {
  const created = await admin.post('/api/users', { name, email, role: 'user', invite: true });
  const tok = require('./helpers').inviteToken(db, created.body.id);
  const c = makeClient(server);
  assert.equal((await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client: c, id: created.body.id };
}
const newAsset = async (name) => (await admin.post('/api/assets', { name, available_to_request: true })).body;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function multipart(files) {
  const boundary = '----ncPhotoBoundary';
  const parts = [];
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${f.name}"\r\nContent-Type: ${f.type || 'image/png'}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Requested-With': 'fetch' }, body: Buffer.concat(parts) };
}
const upload = (client, asset, files) => client.rawPost(`/api/assets/${asset.id}/photos`, multipart(files));
const photosOf = async (asset) => (await admin.get(`/api/assets/${asset.id}`)).body.photos;
const keysFor = (photos) => photos.flatMap((p) => [`photos/${p.filename}`, `photos/${p.thumb}`]);

test('several photos in one upload go to the bucket (not the volume); unreadable ones are reported, not silently dropped', async () => {
  const asset = await newAsset('Bucket multi');
  const jpg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } }).jpeg().toBuffer();
  const r = await upload(admin, asset, [{ name: 'a.png', data: png }, { name: 'b.jpg', data: jpg, type: 'image/jpeg' }, { name: 'fake.png', data: Buffer.from('this is not an image') }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ids.length, 2);
  assert.deepEqual(r.body.failed, ['fake.png'], 'the unreadable file is named in the answer');
  const photos = await photosOf(asset);
  assert.equal(photos.length, 2, 'metadata is in the database');
  for (const k of keysFor(photos)) assert.ok(s3.objects.has(k), `${k} is in the bucket`);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')), [], 'nothing was written to the volume');
  assert.equal(s3.stats.unsigned + s3.stats.wrongKey, 0, 'every request was signed with the configured key');
});

test('stored photos are real JPEGs: orientation applied, metadata stripped, size limited', async () => {
  const asset = await newAsset('Bucket orient');
  // 200x100 pixels flagged "rotate 90°" (EXIF orientation 6) with a copyright tag: it must come out upright (100x200) with no EXIF
  const tagged = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#36c' } }).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret-owner' } } }).toBuffer();
  assert.equal((await sharp(tagged).metadata()).orientation, 6);
  const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#393' } }).png().toBuffer();
  assert.equal((await upload(admin, asset, [{ name: 'o.jpg', data: tagged, type: 'image/jpeg' }, { name: 'big.png', data: big }])).status, 200);
  const [p1, p2] = await photosOf(asset);
  const full = await sharp(s3.objects.get(`photos/${p1.filename}`).body).metadata();
  assert.equal(full.format, 'jpeg');
  assert.deepEqual([full.width, full.height], [100, 200], 'upright');
  assert.equal(full.exif, undefined, 'EXIF removed');
  const thumb = await sharp(s3.objects.get(`photos/${p1.thumb}`).body).metadata();
  assert.deepEqual([thumb.width, thumb.height], [400, 400]);
  const bigOut = await sharp(s3.objects.get(`photos/${p2.filename}`).body).metadata();
  assert.ok(bigOut.width <= 1600 && bigOut.height <= 1600, 'resized to 1600px');
});

test('photos are served through the app with the same permissions; the bucket address and key never reach the browser', async () => {
  const viewer = await makeEmployee('Bucket Viewer', 'bucket.viewer@nutricost.com');
  const holder = await makeEmployee('Bucket Holder', 'bucket.holder@nutricost.com');
  const open = await newAsset('Bucket open');
  const theirs = await newAsset('Bucket theirs');
  assert.equal((await admin.post(`/api/assets/${theirs.id}/checkout`, { employee_id: holder.id, assignment_type: 'permanent' })).status, 200);
  await upload(admin, open, [{ name: 'o.png', data: png }]);
  await upload(admin, theirs, [{ name: 't.png', data: png }]);
  const [po] = await photosOf(open); const [pt] = await photosOf(theirs);

  const asAdmin = await admin.get(`/uploads/${po.filename}`);
  assert.equal(asAdmin.status, 200);
  assert.equal((await viewer.client.get(`/uploads/${po.filename}`)).status, 200, 'visible equipment');
  assert.equal((await viewer.client.get(`/uploads/${pt.filename}`)).status, 404, 'someone else\'s equipment');
  assert.equal((await viewer.client.get(`/uploads/${pt.thumb}`)).status, 404);
  assert.equal((await holder.client.get(`/uploads/${pt.filename}`)).status, 200, 'the holder');
  assert.equal((await makeClient(server).get(`/uploads/${po.filename}`)).status, 401, 'signed out');
  assert.equal((await viewer.client.get('/uploads/..%2f..%2fassets.db')).status, 404, 'no path tricks');
  assert.equal((await admin.get('/uploads/nothing-here.jpg')).status, 404);

  const hdr = asAdmin;
  assert.equal(hdr.headers.get('content-type'), 'image/jpeg');
  assert.match(hdr.headers.get('cache-control'), /private/);
  const page = JSON.stringify((await admin.get(`/api/assets/${open.id}`)).body) + JSON.stringify((await viewer.client.get(`/api/assets/${open.id}`)).body);
  for (const secret of [s3.endpoint, '127.0.0.1:' + s3.endpoint.split(':').pop(), 'TESTSECRET', s3.accessKey, s3.bucket]) assert.ok(!page.includes(secret), `${secret} is not in what browsers receive`);
});

test('deleting a photo removes the row and both bucket objects; the cover follows', async () => {
  const asset = await newAsset('Bucket delete');
  await upload(admin, asset, [{ name: '1.png', data: png }, { name: '2.png', data: png }]);
  const [p1, p2] = await photosOf(asset);
  assert.equal((await admin.put(`/api/assets/${asset.id}/cover`, { photo_id: p2.id })).status, 200);
  assert.equal((await admin.del(`/api/photos/${p2.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 200)); // the object removal is not awaited by the response
  const left = await photosOf(asset);
  assert.deepEqual(left.map((p) => p.id), [p1.id]);
  assert.ok(!s3.objects.has(`photos/${p2.filename}`) && !s3.objects.has(`photos/${p2.thumb}`), 'both objects are gone');
  assert.ok(s3.objects.has(`photos/${p1.filename}`), 'the other photo is untouched');
  assert.equal((await admin.get(`/uploads/${p2.filename}`)).status, 404);
  const view = (await admin.get(`/api/assets/${asset.id}`)).body;
  assert.ok(!view.asset.cover_photo_id || view.asset.cover_photo_id === p1.id, 'no cover pointing at a deleted photo');
  const other = await newAsset('Bucket other');
  assert.equal((await admin.put(`/api/assets/${other.id}/cover`, { photo_id: p1.id })).status, 400, 'a photo cannot be the cover of another asset');
});

test('a storage failure leaves no photo row and no stray object; a partly failed upload says which photo was lost', async () => {
  const a = await newAsset('Bucket fail all');
  const before = s3.objects.size;
  s3.fail.put = 50; // object writes keep failing (the SDK retries a 500 a few times first)
  const r = await upload(admin, a, [{ name: 'x.png', data: png }]);
  s3.fail.put = 0;
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /nothing was saved/i);
  assert.equal((await photosOf(a)).length, 0, 'no broken photo record');
  assert.equal(s3.objects.size, before, 'no orphaned object');

  const b = await newAsset('Bucket fail one');
  const seen = new Set();
  s3.fail.putIf = (key) => { if (key.endsWith('_t.jpg')) return false; seen.add(key); return seen.size === 2; }; // every attempt to write the second photo's full-size file
  const r2 = await upload(admin, b, [{ name: 'ok.png', data: png }, { name: 'lost.png', data: png }]);
  s3.fail.putIf = null;
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.ids.length, 1);
  assert.deepEqual(r2.body.failed, ['lost.png']);
  const photos = await photosOf(b);
  assert.equal(photos.length, 1);
  assert.equal(s3.objects.size, before + 2, 'only the saved photo\'s two objects exist');
});

test('a bucket read error is a 502, never a "not found"', async () => {
  const asset = await newAsset('Bucket read error');
  await upload(admin, asset, [{ name: 'r.png', data: png }]);
  const [p] = await photosOf(asset);
  s3.fail.get = 50;
  assert.equal((await admin.get(`/uploads/${p.filename}`)).status, 502);
  s3.fail.get = 0;
  assert.equal((await admin.get(`/uploads/${p.filename}`)).status, 200, 'and it recovers');
});

test('photos already on the volume (stored before the bucket was connected) are still served and listed', async () => {
  const asset = await newAsset('Bucket legacy');
  fs.writeFileSync(path.join(dir, 'uploads', 'legacy-1.jpg'), 'old-jpeg-bytes');
  db.prepare('INSERT INTO photos (asset_id, filename, thumb) VALUES (?, ?, ?)').run(asset.id, 'legacy-1.jpg', 'legacy-1_t.jpg');
  const r = await admin.get('/uploads/legacy-1.jpg');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'old-jpeg-bytes');
  assert.equal((await admin.get('/uploads/legacy-1_t.jpg')).status, 404, 'a file that exists nowhere is a 404');
});

test('half-configured S3 fails loudly instead of quietly using local files', () => {
  assert.equal(fromEnv({}, dir).kind, 'local');
  assert.throws(() => fromEnv({ S3_BUCKET: 'b' }, dir), /S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are missing/);
  assert.equal(fromEnv({ S3_BUCKET: 'b', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }, dir).kind, 's3');
});
