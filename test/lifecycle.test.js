const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const { app, db: _db } = bootApp();
  db = _db;
  server = await startServer(app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { name, ...extra })).body;
const newUser = async (name, email) => (await admin.post('/api/users', { name, email, invite: false })).body;
const row = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
const count = (sql, ...p) => db.prepare(sql).get(...p).c;

// ---------------------------------------------------------------- archive
test('archiving keeps the asset, its assignment history, activity, photos and request links', async () => {
  const u = await newUser('Archie Holder', 'archie@nutricost.com');
  const a = await newAsset('Archive Me', { tag: 'NC-ARC1' });
  await admin.post(`/api/assets/${a.id}/checkout`, { user_id: u.id });
  await admin.post(`/api/assets/${a.id}/checkin`, {});
  db.prepare("INSERT INTO photos (asset_id, filename, thumb) VALUES (?, 'a.jpg', 'a_t.jpg')").run(a.id);
  const req = (await admin.post('/api/requests', { message: 'about this one', asset_id: a.id, user_id: u.id })).body;
  const before = { asg: count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), act: count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', a.id) };

  const r = await admin.post(`/api/assets/${a.id}/archive`, { reason: 'Created by mistake' });
  assert.equal(r.status, 200);
  assert.ok(row(a.id).archived_at);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), before.asg);
  assert.equal(count('SELECT COUNT(*) c FROM activity WHERE asset_id = ? AND action != ?', a.id, 'archived'), before.act);
  assert.equal(count('SELECT COUNT(*) c FROM photos WHERE asset_id = ?', a.id), 1);
  assert.equal(db.prepare('SELECT asset_id FROM requests WHERE id = ?').get(req.id).asset_id, a.id);
  const arch = db.prepare("SELECT details FROM activity WHERE asset_id = ? AND action = 'archived'").get(a.id);
  assert.match(arch.details, /NC-ARC1/);
  assert.match(arch.details, /Created by mistake/);
});

test('archived assets are hidden from normal listings, dashboard counts and export, but reachable directly and by tag', async () => {
  const a = await newAsset('Hidden Thing', { tag: 'NC-HID1', purchase_cost: 100 });
  const statsBefore = (await admin.get('/api/dashboard')).body.stats;
  await admin.post(`/api/assets/${a.id}/archive`, {});
  assert.ok(!(await admin.get('/api/assets')).body.some((x) => x.id === a.id));
  assert.ok((await admin.get('/api/assets?include_archived=1')).body.some((x) => x.id === a.id));
  const statsAfter = (await admin.get('/api/dashboard')).body.stats;
  assert.equal(statsAfter.total, statsBefore.total - 1);
  assert.equal(statsAfter.available, statsBefore.available - 1);
  assert.ok(!(await admin.get('/api/export/assets.csv')).text.includes('NC-HID1'));
  const direct = await admin.get(`/api/assets/${a.id}`);
  assert.equal(direct.status, 200);
  assert.ok(direct.body.asset.archived_at);
  const lookup = (await admin.get('/api/assets/lookup/nc-hid1')).body;
  assert.deepEqual([lookup.found, lookup.id, lookup.archived], [true, a.id, true]);
});

test('an archived asset\'s history still resolves in the activity feed', async () => {
  const a = await newAsset('Feed Thing');
  await admin.post(`/api/assets/${a.id}/archive`, {});
  const feed = (await admin.get('/api/activity')).body.filter((r) => r.asset_id === a.id);
  assert.ok(feed.length >= 2);
  assert.equal(feed[0].asset_name, 'Feed Thing');
});

test('an archived tag can never be reused, by create or CSV import; archived assets can\'t be edited, re-archived or checked out', async () => {
  const a = await newAsset('Reserved', { tag: 'NC-RSV1' });
  await admin.post(`/api/assets/${a.id}/archive`, {});
  const dup = await admin.post('/api/assets', { name: 'Impostor', tag: 'nc-rsv1' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /archived/);
  const imp = await admin.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: 'tag,name\nNC-RSV1,Changed\n' });
  assert.equal(imp.body.updated, 0);
  assert.equal(imp.body.errors.length, 1);
  assert.equal(row(a.id).name, 'Reserved');
  assert.equal((await admin.put(`/api/assets/${a.id}`, { name: 'Edited' })).status, 400);
  assert.equal((await admin.post(`/api/assets/${a.id}/archive`, {})).status, 400);
  const u = await newUser('Nope User', 'nope@nutricost.com');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { user_id: u.id })).status, 400);
});

test('archiving an unknown asset is a 404', async () => {
  assert.equal((await admin.post('/api/assets/99999/archive', {})).status, 404);
});

// ---------------------------------------------------------------- terminal guards
test('an assigned asset cannot be archived, retired or disposed, but can be marked lost; nothing is checked in silently', async () => {
  const u = await newUser('Holly Holder', 'holly@nutricost.com');
  const a = await newAsset('Held Laptop');
  await admin.post(`/api/assets/${a.id}/checkout`, { user_id: u.id });
  const open = () => count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id);

  const arch = await admin.post(`/api/assets/${a.id}/archive`, {});
  assert.equal(arch.status, 400);
  assert.match(arch.body.error, /check this asset in/i);
  const ret = await admin.put(`/api/assets/${a.id}`, { status: 'retired' });
  assert.equal(ret.status, 400);
  assert.match(ret.body.error, /check this asset in/i);
  assert.equal((await admin.put(`/api/assets/${a.id}`, { status: 'disposed' })).status, 400);
  assert.equal((await admin.del(`/api/assets/${a.id}`)).status, 400);
  assert.equal(row(a.id).archived_at, null);
  assert.equal(row(a.id).status, 'checked_out');
  assert.equal(open(), 1);

  const lost = await admin.put(`/api/assets/${a.id}`, { status: 'lost' });
  assert.equal(lost.status, 200);
  assert.equal(row(a.id).status, 'lost');
  assert.equal(open(), 1, 'a lost asset keeps its assignment');
});

test('disposed is a valid status once nothing is assigned, and disposed assets cannot be checked out', async () => {
  const a = await newAsset('Old Server');
  const r = await admin.put(`/api/assets/${a.id}`, { status: 'disposed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'disposed');
  const u = await newUser('Dee Poser', 'dee@nutricost.com');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { user_id: u.id })).status, 400);
  const active = (await admin.get('/api/assets?status=active')).body;
  assert.ok(!active.some((x) => x.id === a.id));
  assert.equal(db.prepare("SELECT status FROM assets WHERE id = ?").get(a.id).status, 'disposed');
});

// ---------------------------------------------------------------- tag immutability
test('a normal edit cannot change an asset tag, but other edits still work and re-sending the same tag is fine', async () => {
  const a = await newAsset('Fixed Tag', { tag: 'NC-FIX1' });
  const bad = await admin.put(`/api/assets/${a.id}`, { tag: 'NC-FIX2', name: 'Renamed' });
  assert.equal(bad.status, 400);
  assert.equal(row(a.id).tag, 'NC-FIX1');
  assert.equal(row(a.id).name, 'Fixed Tag', 'a rejected edit changes nothing');
  const ok = await admin.put(`/api/assets/${a.id}`, { tag: 'nc-fix1', name: 'Renamed', location: 'Warehouse' });
  assert.equal(ok.status, 200);
  assert.equal(row(a.id).tag, 'NC-FIX1');
  assert.equal(row(a.id).name, 'Renamed');
  assert.equal((await admin.put(`/api/assets/${a.id}`, { name: 'Renamed Again' })).status, 200);
});

// ---------------------------------------------------------------- tag issuance
test('archiving the highest-numbered asset does not free its number', async () => {
  const a = await newAsset('Top Asset');
  await admin.post(`/api/assets/${a.id}/archive`, {});
  const b = await newAsset('Next Asset');
  const n = (t) => parseInt(t.match(/(\d+)$/)[1], 10);
  assert.equal(n(b.tag), n(a.tag) + 1);
});

test('previewing the next tag consumes nothing; creating claims exactly that number', async () => {
  const p1 = (await admin.get('/api/next-tag')).body.tag;
  const p2 = (await admin.get('/api/next-tag')).body.tag;
  assert.equal(p1, p2);
  assert.equal((await newAsset('Claims Preview')).tag, p1);
  assert.notEqual((await admin.get('/api/next-tag')).body.tag, p1);
});

test('near-simultaneous creates all receive distinct tags', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admin.post('/api/assets', { name: `Parallel ${i}` })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.tag)).size, 12);
});

test('a failed create does not burn a number or leave a duplicate possibility', async () => {
  await admin.post('/api/assets', { name: 'Taken', tag: 'NC-TAKEN' });
  const before = (await admin.get('/api/next-tag')).body.tag;
  assert.equal((await admin.post('/api/assets', { name: 'Dup', tag: 'NC-TAKEN' })).status, 400);
  assert.equal((await admin.get('/api/next-tag')).body.tag, before);
  assert.equal((await newAsset('After failure')).tag, before);
});

test('generation skips numbers already taken by manually chosen tags', async () => {
  const next = (await admin.get('/api/next-tag')).body.tag;
  await admin.post('/api/assets', { name: 'Manual squatter', tag: next });
  const made = await newAsset('Auto after squatter');
  assert.notEqual(made.tag, next);
  assert.equal(new Set([made.tag, next]).size, 2);
});

test('changing the prefix keeps the numeric sequence and does not free old-prefix tags', async () => {
  const last = await newAsset('Before prefix change', { tag: 'NC-PFX1' });
  const seq = (await newAsset('Sequence marker')).tag;
  const n = parseInt(seq.match(/(\d+)$/)[1], 10);
  await admin.put('/api/settings', { tag_prefix: 'IT-' });
  const after = await newAsset('After prefix change');
  assert.equal(after.tag, 'IT-' + String(n + 1).padStart(5, '0'));
  await admin.put('/api/settings', { tag_prefix: 'NC-' });
  assert.equal((await admin.post('/api/assets', { name: 'Old prefix reuse', tag: last.tag })).status, 400);
});

function bootAt(dir) {
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = 'test-secret-not-for-production';
  process.env.APP_URL = 'http://localhost';
  for (const mod of ['../src/db', '../src/mailer', '../src/server']) delete require.cache[require.resolve(mod)];
  const app = require('../src/server');
  return { app, db: require('../src/db').db };
}

test('the tag counter survives an application restart and archiving', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-restart-'));
  let boot = bootAt(dir);
  let srv = await startServer(boot.app);
  let c = (await setupAdmin(srv)).client;
  const t1 = (await c.post('/api/assets', { name: 'One' })).body;
  const t2 = (await c.post('/api/assets', { name: 'Two' })).body;
  await c.post(`/api/assets/${t2.id}/archive`, {});
  const last = boot.db.prepare('SELECT last_number n FROM asset_tag_counter').get().n;
  await stopServer(srv); boot.db.close();

  boot = bootAt(dir);
  srv = await startServer(boot.app);
  c = makeClient(srv);
  await c.post('/api/login', { email: 'ada@nutricost.com', password: 'correct-horse-1' });
  assert.equal(boot.db.prepare('SELECT last_number n FROM asset_tag_counter').get().n, last);
  const t3 = (await c.post('/api/assets', { name: 'Three' })).body;
  assert.notEqual(t3.tag, t1.tag);
  assert.notEqual(t3.tag, t2.tag);
  assert.equal(parseInt(t3.tag.match(/(\d+)$/)[1], 10), last + 1);
  await stopServer(srv); boot.db.close();
});

test('existing manual tag lookup and duplicate-tag rejection still work', async () => {
  const a = await newAsset('Manual', { tag: 'NC-MAN1', serial: 'SER-MAN-1' });
  assert.equal((await admin.get('/api/assets/lookup/NC-MAN1')).body.id, a.id);
  assert.equal((await admin.get('/api/assets/lookup/ser-man-1')).body.id, a.id);
  assert.deepEqual((await admin.get('/api/assets/lookup/NOPE-000')).body, { found: false, code: 'NOPE-000' });
  assert.equal((await admin.post('/api/assets', { name: 'Dup', tag: 'NC-MAN1' })).status, 400);
});
