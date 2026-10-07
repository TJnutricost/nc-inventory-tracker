// Search + discoverability refinement: token / substring / case-insensitive search over name, brand, model, category, the WHOLE catalog path, inherited
// Search keywords, tag, serial and location (IT also by holder); the catalog search; and the employee rule that being temporarily out / reserved / held does
// not hide a shared asset from Browse. Authorization is unchanged: the asset page of an item someone else holds is still not theirs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin, t = {}, emp, owner, waiter, holder;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let seq = 0;
// (a fresh database already has the default root categories, e.g. Laptop: reuse an entry that exists)
const node = async (name, parent_id = null) => {
  const have = (await admin.get('/api/catalog')).body.find((n) => n.name === name && (n.parent_id ?? null) === parent_id);
  if (have) return have;
  const r = await admin.post('/api/catalog', { name, parent_id }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
};
const mk = async (name, extra = {}) => { const r = await admin.post('/api/assets', { name, tag: `SR-${++seq}`, available_to_request: true, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
async function login(name) {
  const email = `sr${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true, department: 'Marketing' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email };
}
const names = (rows) => rows.map((r) => r.name).sort();
const find = async (who, q, extra = '') => (await (who.client || who).get(`/api/assets?q=${encodeURIComponent(q)}${extra}`)).body;

before(async () => {
  const booted = bootApp(); db = booted.db; server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  emp = await login('Browse Employee'); owner = await login('Res Owner'); waiter = await login('Hold Waiter'); holder = await login('Zed Holder');
  // Camera > Mirrorless > Canon > R5 ; Camera > Sony > A7 IV ; Camera > Nikon > Z6 ; Camera > Fuji > X-T5 ; Laptop > Mac
  t.camera = await node('Camera'); t.mirrorless = await node('Mirrorless', t.camera.id); t.canon = await node('Canon', t.mirrorless.id); t.r5 = await node('R5', t.canon.id);
  t.sony = await node('Sony', t.camera.id); t.a7 = await node('A7 IV', t.sony.id);
  t.nikon = await node('Nikon', t.camera.id); t.z6 = await node('Z6', t.nikon.id);
  t.fuji = await node('Fuji', t.camera.id); t.xt5 = await node('X-T5', t.fuji.id);
  t.laptop = await node('Laptop'); t.mac = await node('Mac', t.laptop.id);
  // none of these asset NAMES contain the word "camera"
  t.r5a = await mk('Body One', { brand: 'Canon', model: 'EOS R5', serial: 'SERIAL-R5-777', location: 'Studio Shelf', catalog_node_id: t.r5.id });
  t.a7a = await mk('Body Two', { brand: 'Sony', model: 'A7 IV', catalog_node_id: t.a7.id });
  t.z6a = await mk('Body Three', { brand: 'Nikon', model: 'Z6', catalog_node_id: t.z6.id });
  t.xt5a = await mk('Body Four', { brand: 'Fuji', model: 'X-T5', catalog_node_id: t.xt5.id });
  t.hidden = await mk('Body Hidden', { brand: 'Canon', catalog_node_id: t.r5.id, available_to_request: false });
  t.perm = await mk('Body Permanent', { brand: 'Sony', catalog_node_id: t.a7.id });
  t.mine = await mk('Body Mine', { brand: 'Sony', catalog_node_id: t.a7.id });
  t.mac1 = await mk('Workhorse', { brand: 'Apple', model: 'MacBook Air', catalog_node_id: t.mac.id });
  const co = (a, who, extra) => admin.post(`/api/assets/${a.id}/checkout`, { employee_id: who.id, ...extra });
  assert.equal((await co(t.a7a, holder, { assignment_type: 'checkout', due_date: plus(5) })).status, 200); // temporarily out
  assert.equal((await co(t.perm, holder, { assignment_type: 'permanent' })).status, 200); // permanently held
  assert.equal((await co(t.mine, emp, { assignment_type: 'permanent' })).status, 200); // the employee's own
  // reserved today (confirmed)
  assert.equal((await owner.client.post(`/api/assets/${t.z6a.id}/reservations`, { start_date: TODAY, end_date: plus(1) })).status, 200);
  // held today: the owner reserves, the waiter joins, the owner cancels -> the waiter holds those days
  const r = await owner.client.post(`/api/assets/${t.xt5a.id}/reservations`, { start_date: TODAY, end_date: plus(2) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await waiter.client.post(`/api/assets/${t.xt5a.id}/waitlist`, { start_date: TODAY, end_date: plus(2) })).status, 200);
  assert.equal((await owner.client.post(`/api/reservations/${r.body.reserved[0].id}/cancel`, {})).status, 200);
  assert.equal(db.prepare("SELECT status FROM waitlist_entries WHERE asset_id = ?").get(t.xt5a.id).status, 'held');
});
after(() => stopServer(server));

// ---------------------------------------------------------------- matching (IT: All assets)
test('IT: a broad word finds assets through the catalog path and category even though no asset NAME contains it', async () => {
  const rows = await find(admin, 'camera');
  assert.deepEqual(names(rows), ['Body Four', 'Body Hidden', 'Body Mine', 'Body One', 'Body Permanent', 'Body Three', 'Body Two']);
  assert.ok(!rows.some((r) => r.name === 'Workhorse'));
  assert.deepEqual(names(await find(admin, 'CaMeRa')), names(rows), 'case-insensitive');
  assert.deepEqual(names(await find(admin, '  camera   ')), names(rows), 'surrounding spaces are ignored');
});
test('IT: ancestor / path names match (not just the category or the entry itself)', async () => {
  assert.deepEqual(names(await find(admin, 'mirrorless')), ['Body Hidden', 'Body One'], 'a middle level of the path');
  assert.deepEqual(names(await find(admin, 'canon')), ['Body Hidden', 'Body One']);
});
test('IT: brand, model, category, tag, serial and location match', async () => {
  assert.deepEqual(names(await find(admin, 'nikon')), ['Body Three'], 'brand');
  assert.deepEqual(names(await find(admin, 'macbook')), ['Workhorse'], 'model');
  assert.deepEqual(names(await find(admin, 'laptop')), ['Workhorse'], 'category (and path)');
  assert.deepEqual(names(await find(admin, t.z6a.tag.toLowerCase())), ['Body Three'], 'tag');
  assert.deepEqual(names(await find(admin, 'serial-r5')), ['Body One'], 'serial');
  assert.deepEqual(names(await find(admin, 'studio shelf')), ['Body One'], 'location (two words)');
  assert.deepEqual(names(await find(admin, 'zed holder')), ['Body Permanent', 'Body Two'], 'IT still finds by holder');
});
test('IT: every word must match somewhere (AND), in any order, and wildcards are literal', async () => {
  assert.deepEqual(names(await find(admin, 'canon camera')), ['Body Hidden', 'Body One']);
  assert.deepEqual(names(await find(admin, 'r5 canon')), ['Body Hidden', 'Body One']);
  assert.deepEqual(names(await find(admin, 'canon laptop')), []);
  assert.deepEqual(await find(admin, '%'), [], '% is not a wildcard');
  assert.deepEqual(await find(admin, '_'), [], '_ is not a wildcard');
  assert.equal((await admin.get('/api/assets?q=%20%20')).body.length >= 8, true, 'blank search = no search');
});

// ---------------------------------------------------------------- Search keywords
test('Search keywords: normalized, stored on the catalog entry, inherited by everything below it, and never required on assets', async () => {
  const put = (id, kw) => admin.put(`/api/catalog/${id}`, { search_keywords: kw });
  const r = await put(t.camera.id, ' #Photography ,  VIDEO ;photography\nMirror  Less ');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.search_keywords, 'photography, video, mirror less', 'trimmed, lower-cased, # dropped, de-duplicated, whitespace collapsed');
  assert.equal((await admin.get('/api/catalog?include_archived=1')).body.find((n) => n.id === t.camera.id).search_keywords, 'photography, video, mirror less');
  assert.equal(r.body.name, 'Camera', 'only the keywords changed');
  // inherited: the physical cameras beneath it are found by an alias none of their names/paths contain; the laptop is not
  assert.deepEqual(names(await find(admin, 'photography')), names(await find(admin, 'camera')));
  assert.deepEqual(names(await find(admin, 'video canon')), ['Body Hidden', 'Body One'], 'keyword + brand');
  assert.deepEqual(names(await find(admin, 'mirror less')), names(await find(admin, 'camera')), 'a multi-word keyword');
  assert.ok(!names(await find(admin, 'photography')).includes('Workhorse'));
  // clearing, validation
  assert.equal((await put(t.camera.id, '')).body.search_keywords, '');
  assert.deepEqual(await find(admin, 'photography'), []);
  assert.equal((await put(t.camera.id, 'x'.repeat(41))).status, 400);
  assert.equal((await put(t.camera.id, Array.from({ length: 31 }, (_, i) => `k${i}`).join(','))).status, 400);
  assert.equal((await put(t.camera.id, { a: 1 })).status, 400);
  assert.equal((await put(t.camera.id, ['photography', 5])).status, 400);
  assert.equal((await put(t.camera.id, ['Photography', ' video '])).body.search_keywords, 'photography, video', 'a list works too');
  // admin only
  assert.equal((await emp.client.put(`/api/catalog/${t.camera.id}`, { search_keywords: 'hack' })).status, 403);
  // can be set when an entry is created
  const made = await admin.post('/api/catalog', { name: 'Tripod', search_keywords: 'Support, Stand' });
  assert.equal(made.body.search_keywords, 'support, stand');
});

// ---------------------------------------------------------------- IT: catalog search
test('IT catalog search: matches name / path / keywords and shows the full path so ambiguous hits make sense', async () => {
  await admin.put(`/api/catalog/${t.camera.id}`, { search_keywords: 'photography, video' });
  const get = async (q) => (await admin.get(`/api/catalog/search?q=${encodeURIComponent(q)}`)).body;
  const cam = await get('camera');
  assert.ok(cam.total >= 10, 'the Camera entry and everything below it');
  assert.equal(cam.results[0].name, 'Camera', 'the entry itself first (shallowest / own-name match)');
  const r5 = cam.results.find((r) => r.name === 'R5');
  assert.equal(r5.path, 'Camera > Mirrorless > Canon > R5', 'full hierarchy, not just "R5"');
  assert.equal(r5.asset_count, 2);
  assert.equal(r5.archived, false);
  const kw = await get('photography');
  assert.equal(kw.results[0].name, 'Camera');
  assert.equal(kw.results[0].via_keyword, true, 'says it matched by keyword');
  assert.ok(kw.results.some((r) => r.path === 'Camera > Sony > A7 IV'), 'keywords reach the descendants');
  assert.deepEqual((await get('canon r5')).results.map((r) => r.path), ['Camera > Mirrorless > Canon > R5'], 'every word, in the path');
  assert.deepEqual((await get('')).results, []);
  assert.deepEqual((await get('zzz-nothing')).results, []);
  assert.equal((await emp.client.get('/api/catalog/search?q=camera')).status, 403, 'admin only');
  await admin.post(`/api/catalog/${t.fuji.id}/archive`, {});
  const fuji = (await get('fuji')).results.find((r) => r.name === 'Fuji');
  assert.equal(fuji.archived, true, 'archived entries are found and flagged');
  await admin.post(`/api/catalog/${t.fuji.id}/restore`, {});
});

// ---------------------------------------------------------------- Employee Browse
test('Employee: a broad word finds shared cameras even though none is named "camera"', async () => {
  const rows = await find(emp, 'camera');
  assert.deepEqual(names(rows), ['Body Four', 'Body One', 'Body Three', 'Body Two']);
  assert.deepEqual(names(await find(emp, 'photography')), names(rows), 'IT\'s keywords work for employees too');
  assert.deepEqual(names(await find(emp, 'mirrorless')), ['Body One']);
  assert.deepEqual(names(await find(emp, 'CANON R5')), ['Body One']);
  assert.deepEqual(names(await find(emp, 'serial-r5')), ['Body One']);
});
test('Employee: temporarily out, reserved today and held-for-someone assets are STILL listed, each with its state', async () => {
  const rows = await find(emp, 'camera');
  const by = (n) => rows.find((r) => r.name === n);
  assert.equal(by('Body One').avail_state, 'available');
  assert.equal(by('Body Two').avail_state, 'checked_out', 'temporarily checked out');
  assert.equal(by('Body Two').expected_back, plus(5), 'with when it is due back');
  assert.equal(by('Body Three').avail_state, 'reserved', 'confirmed reservation today');
  assert.equal(by('Body Four').avail_state, 'reserved', 'active availability hold today');
  assert.equal(by('Body Four').status, 'available', 'the asset itself is untouched: availability, not discoverability');
  // no one's identity in any of it
  const text = JSON.stringify(rows);
  for (const who of ['Zed Holder', 'Res Owner', 'Hold Waiter']) assert.ok(!text.includes(who), `no ${who}`);
  assert.ok(rows.every((r) => !('holder_names' in r)));
  // the same without a search (the Browse root lists them too)
  const all = (await emp.client.get('/api/assets')).body;
  for (const n of ['Body Two', 'Body Three', 'Body Four']) assert.ok(all.some((r) => r.name === n), `${n} in plain Browse`);
  // "what can I get right now" is still available
  assert.deepEqual(names((await emp.client.get('/api/assets?q=camera&available=1')).body), ['Body Four', 'Body One', 'Body Three'], 'out-on-loan drops out of the "available now" view');
});
test('Employee end to end: an INHERITED keyword finds a temporarily-out / reserved / held asset, shows its state, and opening it reaches the calendar (not a 404)', async () => {
  // "photography" is set only on the Camera ANCESTOR; none of these assets or their own entries carry it
  await admin.put(`/api/catalog/${t.camera.id}`, { search_keywords: 'photography, video' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM catalog_nodes WHERE id <> ? AND search_keywords IS NOT NULL AND search_keywords LIKE ?').get(t.camera.id, '%photography%').c, 0);
  const rows = await find(emp, 'photography');
  const want = { 'Body Two': 'checked_out', 'Body Three': 'reserved', 'Body Four': 'reserved', 'Body One': 'available' };
  for (const [name, state] of Object.entries(want)) {
    const a = rows.find((r) => r.name === name);
    assert.ok(a, `${name} found through the inherited keyword`);
    assert.equal(a.avail_state, state, `${name} is ${state}`);
    if (state !== 'available') {
      // the row's destination is the availability calendar: reachable, reservable, and no 404
      const cal = await emp.client.get(`/api/availability?asset=${a.id}`);
      assert.equal(cal.status, 200, `${name} calendar opens`);
      assert.equal(cal.body.assets[0].reserve.allowed, true);
      assert.equal(cal.body.assets[0].id, a.id);
    }
  }
  assert.equal(rows.find((r) => r.name === 'Body Two').expected_back, plus(5));
  assert.ok(!rows.some((r) => ['Body Hidden', 'Body Permanent', 'Body Mine', 'Workhorse'].includes(r.name)));
  // the asset PAGE is still not theirs (authorization unchanged), which is why the row goes to the calendar
  assert.equal((await emp.client.get(`/api/assets/${rows.find((r) => r.name === 'Body Two').id}`)).status, 404);
});
test('Employee: what must NOT appear still does not (not requestable, permanently held, own, other searches)', async () => {
  const all = names((await emp.client.get('/api/assets')).body);
  assert.ok(!all.includes('Body Hidden'), 'available_to_request OFF does not leak');
  assert.ok(!all.includes('Body Permanent'), 'a permanently assigned item is not in the shared pool');
  assert.ok(!all.includes('Body Mine'), 'their own equipment is My equipment, not Browse');
  assert.deepEqual(await find(emp, t.hidden.tag), [], 'not even by exact tag');
  assert.deepEqual(await find(emp, 'zed holder'), [], 'no probing holders by name');
  assert.deepEqual(await find(emp, 'Body Permanent'), []);
  // authorization is unchanged: listing is discovery; the asset page of something someone else holds is still not theirs
  assert.equal((await emp.client.get(`/api/assets/${t.a7a.id}`)).status, 404);
  assert.equal((await emp.client.get(`/api/assets/${t.hidden.id}`)).status, 404);
  // ... and its calendar (where they reserve / join a waitlist) is open to them
  const cal = await emp.client.get(`/api/availability?asset=${t.a7a.id}`);
  assert.equal(cal.status, 200);
  assert.equal(cal.body.assets[0].reserve.allowed, true);
});
test('Employee: keywords and the catalog admin search are not exposed to employees; archived entries do not widen their search', async () => {
  const cat = (await emp.client.get('/api/catalog')).body;
  assert.ok(cat.every((n) => !('search_keywords' in n)));
  // an archived catalog entry's keywords no longer make its assets findable by employees (only live entries are searched)
  await admin.put(`/api/catalog/${t.nikon.id}`, { search_keywords: 'zebraword' });
  assert.deepEqual(names(await find(emp, 'zebraword')), ['Body Three']);
  await admin.post(`/api/catalog/${t.nikon.id}/archive`, {});
  assert.deepEqual(await find(emp, 'zebraword'), []);
  assert.deepEqual(names(await find(admin, 'zebraword')), ['Body Three'], 'IT still finds it');
  await admin.post(`/api/catalog/${t.nikon.id}/restore`, {});
});

// ---------------------------------------------------------------- migration + front end
test('migration 16 adds catalog_nodes.search_keywords as an empty column for every existing entry', () => {
  const os = require('os'); const Database = require('better-sqlite3');
  const { runMigrations } = require('../src/migrate'); const all = require('../src/migrations');
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-srch-mig-')), 'assets.db'));
  runMigrations(d, all.filter((m) => m.id <= 15));
  d.prepare("INSERT INTO catalog_nodes (parent_id, name, name_key) VALUES (NULL, 'Camera', 'camera')").run();
  assert.deepEqual(runMigrations(d, all.filter((m) => m.id <= 16)), [16]);
  assert.equal(d.prepare('SELECT search_keywords k FROM catalog_nodes').get().k, null);
});
test('front end: Browse rows keep their state and open the calendar when not available now; the catalog gets a search and a Search keywords editor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const browse = src.slice(src.indexOf('async function viewBrowse()'), src.indexOf('// ============================================================ asset detail'));
  assert.match(browse, /const out = a\.avail_state && a\.avail_state !== 'available';/);
  assert.match(browse, /const href = out \? calUrl\(\{ asset: a\.id, from: calendarSource\(\) \}\)/);
  assert.match(browse, /pill\('reserved', 'Reserved'\) : a\.avail_state === 'partial' \? pill\('reserved', 'Partly scheduled'\) : pill\('checked_out', 'Checked out'\)/);
  assert.match(browse, /back \$\{fmtDate\(a\.expected_back\)\}/);
  // the request-this-item pickers still ask for what is available right now
  assert.equal((src.match(/available=1|available: '1'/g) || []).length, 3);
  const cat = src.slice(src.indexOf('async function viewCatalog()'));
  assert.match(cat, /id="cq" type="search"/);
  assert.match(cat, /\/api\/catalog\/search\?q=/);
  assert.match(cat, /data-act="keywords"/);
  assert.match(cat, /search_keywords: new FormData\(e\.target\)\.get\('kw'\)/);
  assert.match(cat, /if \(st\.search\) return renderFound\(\);/, 'an empty box leaves the card grid untouched');
});
