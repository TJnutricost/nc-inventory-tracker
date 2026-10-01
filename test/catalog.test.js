// Hierarchical equipment catalog + specific requests (Phase 2, slice 3). Rules are enforced on the server; the UI only
// reflects them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const catalogLib = require('../src/catalog');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const count = (sql, ...p) => db.prepare(sql).get(...p).c;
const node = async (name, parent_id = null) => { const r = await admin.post('/api/catalog', { name, parent_id }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const rootId = (name) => db.prepare('SELECT id FROM catalog_nodes WHERE parent_id IS NULL AND name_key = ?').get(name.toLowerCase()).id;
const newAsset = async (name, extra = {}) => { const r = await admin.post('/api/assets', { name, tag: `CT-${++seq}`, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `ct${++seq}@nutricost.com`, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name };
}
// Builds Camera(root) > Sony > A7 IV, plus a second brand, once per call with unique names.
async function cameraTree(tag) {
  const camera = await node(`Cam ${tag}`);
  const sony = await node('Sony', camera.id);
  const a7 = await node('A7 IV', sony.id);
  const canon = await node('Canon', camera.id);
  const r5 = await node('R5', canon.id);
  return { camera, sony, a7, canon, r5 };
}

// ---------------------------------------------------------------- the tree itself
test('a fresh database starts with the standard categories as root nodes', async () => {
  const roots = (await admin.get('/api/catalog')).body.filter((n) => n.parent_id === null).map((n) => n.name);
  for (const c of ['Laptop', 'Desktop', 'Monitor', 'Keyboard & Mouse', 'Other']) assert.ok(roots.includes(c), c);
});

test('roots, children and unlimited-practical nesting; each node reports its full path', async () => {
  const root = await node('Deep Root');
  let parent = root; const ids = [root.id];
  for (let i = 1; i <= 15; i++) { parent = await node(`Level ${i}`, parent.id); ids.push(parent.id); }
  assert.equal(parent.path, ['Deep Root', ...Array.from({ length: 15 }, (_, i) => `Level ${i + 1}`)].join(' > '));
  const all = (await admin.get('/api/catalog')).body;
  assert.equal(all.find((n) => n.id === ids[0]).parent_id, null);
  assert.equal(all.find((n) => n.id === ids[5]).parent_id, ids[4]);
  assert.equal(catalogLib.subtreeIds(db, root.id).length, 16);
});

test('sibling names are unique ignoring case and whitespace (archived siblings included); other branches may reuse a name', async () => {
  const a = await node('Dupe Root A'); const b = await node('Dupe Root B');
  await node('Sony', a.id);
  for (const name of ['sony', '  SONY ', 'So  ny'.replace('So  ny', 'Sony')]) {
    const r = await admin.post('/api/catalog', { name, parent_id: a.id });
    assert.equal(r.status, 400, name);
  }
  assert.equal((await admin.post('/api/catalog', { name: ' dupe   root a' })).status, 400, 'roots are siblings of each other');
  assert.equal((await admin.post('/api/catalog', { name: 'Sony', parent_id: b.id })).status, 200, 'same name under a different parent is fine');
  const arch = await node('Old Brand', a.id);
  await admin.post(`/api/catalog/${arch.id}/archive`, {});
  const r = await admin.post('/api/catalog', { name: 'old brand', parent_id: a.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /archived/);
});

test('names are validated: required, bounded, no path separator', async () => {
  assert.equal((await admin.post('/api/catalog', { name: '   ' })).status, 400);
  assert.equal((await admin.post('/api/catalog', {})).status, 400);
  assert.equal((await admin.post('/api/catalog', { name: 'x'.repeat(101) })).status, 400);
  assert.equal((await admin.post('/api/catalog', { name: 'A > B' })).status, 400);
  assert.equal((await admin.post('/api/catalog', { name: 'Ghost', parent_id: 999999 })).status, 404);
  assert.equal((await admin.post('/api/catalog', { name: 'Bad', parent_id: 'abc' })).status, 400);
});

test('rename keeps identity and children; a rename that collides with a sibling is refused', async () => {
  const t = await cameraTree('rn');
  const r = await admin.put(`/api/catalog/${t.sony.id}`, { name: 'Sony Alpha' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, t.sony.id);
  assert.equal(r.body.path, `${t.camera.name} > Sony Alpha`);
  const a7 = (await admin.get('/api/catalog')).body.find((n) => n.id === t.a7.id);
  assert.equal(a7.path, `${t.camera.name} > Sony Alpha > A7 IV`, 'children follow the rename');
  assert.equal((await admin.put(`/api/catalog/${t.sony.id}`, { name: 'canon' })).status, 400);
});

test('moving a node cannot create a cycle (self, child, or deep descendant), and respects sibling uniqueness', async () => {
  const t = await cameraTree('cy');
  assert.equal((await admin.put(`/api/catalog/${t.camera.id}`, { parent_id: t.camera.id })).status, 400);
  assert.equal((await admin.put(`/api/catalog/${t.camera.id}`, { parent_id: t.sony.id })).status, 400);
  assert.equal((await admin.put(`/api/catalog/${t.camera.id}`, { parent_id: t.a7.id })).status, 400);
  assert.equal((await admin.put(`/api/catalog/${t.sony.id}`, { parent_id: t.a7.id })).status, 400);
  assert.equal(count('SELECT parent_id p FROM catalog_nodes WHERE id = ?', t.camera.id) === null, false);
  assert.equal(db.prepare('SELECT parent_id FROM catalog_nodes WHERE id = ?').get(t.camera.id).parent_id, null, 'nothing moved');
  // a legitimate move works and the subtree follows
  const other = await node('Move Target');
  const ok = await admin.put(`/api/catalog/${t.sony.id}`, { parent_id: other.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.path, 'Move Target > Sony');
  assert.equal((await admin.get('/api/catalog')).body.find((n) => n.id === t.a7.id).path, 'Move Target > Sony > A7 IV');
  // the schema itself refuses a self-parent even if the code were bypassed
  assert.throws(() => db.prepare('UPDATE catalog_nodes SET parent_id = id WHERE id = ?').run(t.canon.id), /CHECK/);
  // move to root; collision at the destination is refused
  await node('Sony', other.id).catch(() => {});
  const dup = await admin.put(`/api/catalog/${t.canon.id}`, { parent_id: other.id, name: 'Sony' });
  assert.equal(dup.status, 400);
});

test('archive hides a node and its subtree from employees; restore needs a live parent; admins can still see everything', async () => {
  const t = await cameraTree('ar');
  const emp = await makeLogin('Catalog Reader');
  const idsFor = async (c) => (await c.get('/api/catalog')).body.map((n) => n.id);
  assert.ok((await idsFor(emp.client)).includes(t.a7.id));
  assert.equal((await admin.post(`/api/catalog/${t.sony.id}/archive`, {})).status, 200);
  const seen = await idsFor(emp.client);
  assert.ok(seen.includes(t.camera.id) && seen.includes(t.canon.id));
  assert.ok(!seen.includes(t.sony.id), 'archived node hidden');
  assert.ok(!seen.includes(t.a7.id), 'its children are hidden with it');
  assert.ok((await admin.get('/api/catalog')).body.every((n) => n.id !== t.sony.id), 'admin default list is active-only too');
  const full = (await admin.get('/api/catalog?include_archived=1')).body;
  assert.equal(full.find((n) => n.id === t.sony.id).live, false);
  assert.equal(full.find((n) => n.id === t.a7.id).live, false, 'a child of an archived node is not live');
  assert.equal((await admin.post(`/api/catalog/${t.sony.id}/archive`, {})).status, 400, 'already archived');
  assert.equal((await admin.post('/api/catalog', { name: 'New Model', parent_id: t.sony.id })).status, 400, 'no new children under an archived node');
  // restore the child first -> refused, then the parent -> ok
  await admin.post(`/api/catalog/${t.a7.id}/archive`, {});
  assert.equal((await admin.post(`/api/catalog/${t.a7.id}/restore`, {})).status, 400, 'parent still archived');
  assert.equal((await admin.post(`/api/catalog/${t.sony.id}/restore`, {})).status, 200);
  assert.equal((await admin.post(`/api/catalog/${t.a7.id}/restore`, {})).status, 200);
  assert.ok((await idsFor(emp.client)).includes(t.a7.id));
  assert.equal((await admin.post(`/api/catalog/${t.a7.id}/restore`, {})).status, 400, 'not archived');
});

test('a referenced node cannot be deleted (children, assets or requests); an unused one can', async () => {
  const t = await cameraTree('dl');
  assert.equal((await admin.del(`/api/catalog/${t.camera.id}`)).status, 400, 'has children');
  const asset = await newAsset('Sony A7 IV Body', { catalog_node_id: t.a7.id });
  assert.equal((await admin.del(`/api/catalog/${t.a7.id}`)).status, 400, 'has an asset');
  assert.throws(() => db.prepare('DELETE FROM catalog_nodes WHERE id = ?').run(t.a7.id), /FOREIGN KEY/, 'the schema backs the rule up');
  const emp = await makeLogin('Req Holder');
  assert.equal((await emp.client.post('/api/requests', { catalog_node_id: t.r5.id })).status, 200);
  assert.equal((await admin.del(`/api/catalog/${t.r5.id}`)).status, 400, 'a request refers to it');
  const spare = await node('Spare', t.camera.id);
  assert.equal((await admin.del(`/api/catalog/${spare.id}`)).status, 200);
  assert.equal(count('SELECT COUNT(*) c FROM catalog_nodes WHERE id = ?', spare.id), 0);
  assert.ok(asset.id);
});

// ---------------------------------------------------------------- admin vs employee on the catalog
test('employees can read the live catalog but cannot create, rename, move, archive, restore or delete', async () => {
  const t = await cameraTree('sec');
  const emp = await makeLogin('Not An Admin');
  const read = await emp.client.get('/api/catalog');
  assert.equal(read.status, 200);
  assert.ok(read.body.find((n) => n.id === t.a7.id));
  const sample = read.body.find((n) => n.id === t.a7.id);
  for (const k of ['archived_at', 'asset_count', 'request_count', 'live']) assert.ok(!(k in sample), `employee payload must not carry ${k}`);
  assert.equal((await emp.client.get('/api/catalog?include_archived=1')).body.length, read.body.length, 'include_archived is ignored for employees');
  assert.equal((await emp.client.post('/api/catalog', { name: 'Hack' })).status, 403);
  assert.equal((await emp.client.put(`/api/catalog/${t.sony.id}`, { name: 'Hack' })).status, 403);
  assert.equal((await emp.client.post(`/api/catalog/${t.sony.id}/archive`, {})).status, 403);
  assert.equal((await emp.client.post(`/api/catalog/${t.sony.id}/restore`, {})).status, 403);
  assert.equal((await emp.client.del(`/api/catalog/${t.sony.id}`)).status, 403);
  assert.equal(db.prepare('SELECT name FROM catalog_nodes WHERE id = ?').get(t.sony.id).name, 'Sony');
  assert.equal((await makeClient(server).get('/api/catalog')).status, 401);
});

// ---------------------------------------------------------------- assets <-> catalog
test('an admin assigns an asset to a catalog node; the path shows and the category text follows the root', async () => {
  const t = await cameraTree('as');
  const asset = await newAsset('Sony A7 IV Body 1', { category: 'Other', catalog_node_id: t.a7.id });
  assert.equal(asset.catalog_node_id, t.a7.id);
  assert.equal(asset.category, t.camera.name, 'category is derived from the root, whatever was sent');
  const detail = (await admin.get(`/api/assets/${asset.id}`)).body.asset;
  assert.equal(detail.catalog_path, `${t.camera.name} > Sony > A7 IV`);
  // re-point it, then unlink it; brand/model/category are never lost by editing
  const edit = await admin.put(`/api/assets/${asset.id}`, { catalog_node_id: t.r5.id, brand: 'Sony', model: 'A7 IV' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.catalog_node_id, t.r5.id);
  assert.equal(edit.body.brand, 'Sony');
  assert.equal((await admin.put(`/api/assets/${asset.id}`, { catalog_node_id: null })).body.catalog_node_id, null);
  assert.equal(db.prepare('SELECT category FROM assets WHERE id = ?').get(asset.id).category, t.camera.name, 'unlinking keeps the existing category text');
  assert.ok(count("SELECT COUNT(*) c FROM activity WHERE asset_id = ? AND action = 'edited' AND details LIKE '%catalog%'", asset.id) >= 1);
});

test('assets can only be linked to real, active nodes; an employee cannot assign', async () => {
  const t = await cameraTree('av');
  assert.equal((await admin.post('/api/assets', { name: 'X', catalog_node_id: 999999 })).status, 400);
  assert.equal((await admin.post('/api/assets', { name: 'X', catalog_node_id: 'abc' })).status, 400);
  const asset = await newAsset('Linked Camera', { catalog_node_id: t.a7.id });
  await admin.post(`/api/catalog/${t.canon.id}/archive`, {});
  assert.equal((await admin.put(`/api/assets/${asset.id}`, { catalog_node_id: t.r5.id })).status, 400, 'archived entries cannot be newly assigned');
  await admin.post(`/api/catalog/${t.sony.id}/archive`, {});
  assert.equal((await admin.put(`/api/assets/${asset.id}`, { notes: 'still editable' })).status, 200, 'an asset on an archived entry stays editable');
  assert.equal((await admin.get(`/api/assets/${asset.id}`)).body.asset.catalog_path, `${t.camera.name} > Sony > A7 IV`, 'admins still see the path');
  const emp = await makeLogin('No Assign');
  assert.equal((await emp.client.put(`/api/assets/${asset.id}`, { catalog_node_id: t.camera.id })).status, 403);
});

test('renaming a root keeps the assets\' category text in step; history is not rewritten', async () => {
  const root = await node('Audio Old');
  const sub = await node('Mics', root.id);
  const asset = await newAsset('Boom Mic', { catalog_node_id: sub.id });
  assert.equal(asset.category, 'Audio Old');
  await admin.put(`/api/catalog/${root.id}`, { name: 'Audio' });
  assert.equal(db.prepare('SELECT category FROM assets WHERE id = ?').get(asset.id).category, 'Audio');
  const found = (await admin.get('/api/assets?category=Audio')).body.find((a) => a.id === asset.id);
  assert.ok(found, 'the Browse category filter keeps working after a rename');
});

test('assets can be filtered by catalog subtree; employees only get live entries and only what they could get anyway', async () => {
  const t = await cameraTree('fl');
  const a1 = await newAsset('Sony A7 IV #1', { catalog_node_id: t.a7.id });
  const a2 = await newAsset('Sony A7 IV #2', { catalog_node_id: t.a7.id });
  const r5 = await newAsset('Canon R5 #1', { catalog_node_id: t.r5.id });
  const holder = await makeLogin('Holder One');
  const emp = await makeLogin('Browser One');
  await admin.post(`/api/assets/${a1.id}/checkout`, { employee_id: holder.id, assignment_type: 'permanent' });
  const ids = async (c, node) => (await c.get(`/api/assets?catalog_node=${node}`)).body.map((a) => a.id).sort((x, y) => x - y);
  assert.deepEqual(await ids(admin, t.camera.id), [a1.id, a2.id, r5.id], 'admin sees the whole subtree, held or not');
  assert.deepEqual(await ids(emp.client, t.camera.id), [a2.id, r5.id], 'employee does not see the held asset');
  assert.deepEqual(await ids(emp.client, t.a7.id), [a2.id]);
  const asEmp = (await emp.client.get(`/api/assets?catalog_node=${t.a7.id}`)).body[0];
  assert.equal(asEmp.catalog_path, `${t.camera.name} > Sony > A7 IV`);
  assert.ok(!('holder_names' in asEmp));
  await admin.post(`/api/catalog/${t.sony.id}/archive`, {});
  assert.equal((await emp.client.get(`/api/assets?catalog_node=${t.sony.id}`)).status, 404, 'archived entry is not a thing to employees');
  assert.deepEqual(await ids(emp.client, t.camera.id), [r5.id], 'assets under an archived sub-entry drop out of the employee subtree; the other branch stays');
  assert.equal((await emp.client.get('/api/assets?catalog_node=999999')).status, 404);
  assert.equal((await emp.client.get('/api/assets?catalog_node=abc')).status, 404);
});

test('available counts per node cover the employee\'s subtree and exclude held assets', async () => {
  const t = await cameraTree('cn');
  const a1 = await newAsset('Counted A7 #1', { catalog_node_id: t.a7.id });
  await newAsset('Counted A7 #2', { catalog_node_id: t.a7.id });
  await newAsset('Counted R5', { catalog_node_id: t.r5.id });
  const emp = await makeLogin('Counter');
  await admin.post(`/api/assets/${a1.id}/checkout`, { employee_id: emp.id, assignment_type: 'permanent' });
  const by = async (c) => Object.fromEntries((await c.get('/api/catalog')).body.map((n) => [n.id, n.available_count]));
  const mine = await by(emp.client);
  assert.equal(mine[t.a7.id], 1, 'an asset I already hold is not "available to me"');
  assert.equal(mine[t.camera.id], 2);
  const adm = await by(admin);
  assert.equal(adm[t.a7.id], 1, 'checked-out assets are not available for anyone');
});

// ---------------------------------------------------------------- employee requests against the catalog
test('an employee requests a broad node: "any matching", with a path snapshot and the root as the category', async () => {
  const t = await cameraTree('rq1');
  const emp = await makeLogin('Broad Asker');
  const made = await emp.client.post('/api/requests', { catalog_node_id: t.camera.id, message: 'Any camera is fine' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.catalog_node_id, t.camera.id);
  assert.equal(made.body.catalog_path, t.camera.name);
  assert.equal(made.body.category, t.camera.name);
  assert.equal(made.body.asset_id, null, 'no specific asset = any matching');
  assert.equal(made.body.asset_label, null);
  const row = (await emp.client.get('/api/requests')).body.find((r) => r.id === made.body.id);
  assert.equal(row.catalog_path, t.camera.name);
});

test('an employee requests a deeper model node, optionally with a specific available asset beneath it', async () => {
  const t = await cameraTree('rq2');
  const a1 = await newAsset('A7 IV Body One', { catalog_node_id: t.a7.id });
  const emp = await makeLogin('Deep Asker');
  const any = await emp.client.post('/api/requests', { catalog_node_id: t.a7.id });
  assert.equal(any.status, 200);
  assert.equal(any.body.catalog_path, `${t.camera.name} > Sony > A7 IV`);
  assert.equal(any.body.asset_id, null);
  const specific = await emp.client.post('/api/requests', { catalog_node_id: t.a7.id, asset_id: a1.id, message: 'This one please' });
  assert.equal(specific.status, 200, JSON.stringify(specific.body));
  assert.equal(specific.body.asset_id, a1.id);
  assert.equal(specific.body.asset_label, `${a1.tag} — A7 IV Body One`);
  // a specific asset under a broader selection is fine as long as it is filed beneath it
  const broad = await emp.client.post('/api/requests', { catalog_node_id: t.sony.id, asset_id: a1.id });
  assert.equal(broad.status, 200);
  assert.equal(broad.body.catalog_path, `${t.camera.name} > Sony`);
  // …but not under a different branch
  const wrong = await emp.client.post('/api/requests', { catalog_node_id: t.canon.id, asset_id: a1.id });
  assert.equal(wrong.status, 400);
});

test('a specific asset held by someone else, unavailable, archived or already mine cannot be requested through the selector', async () => {
  const t = await cameraTree('rq3');
  const held = await newAsset('Held A7', { catalog_node_id: t.a7.id });
  const repair = await newAsset('Repair A7', { catalog_node_id: t.a7.id });
  const archived = await newAsset('Archived A7', { catalog_node_id: t.a7.id });
  const mine = await newAsset('My A7', { catalog_node_id: t.a7.id });
  const other = await makeLogin('Other Holder'); const emp = await makeLogin('Sneaky Asker');
  await admin.post(`/api/assets/${held.id}/checkout`, { employee_id: other.id, assignment_type: 'permanent' });
  await admin.put(`/api/assets/${repair.id}`, { status: 'maintenance' });
  await admin.post(`/api/assets/${archived.id}/archive`, {});
  await admin.post(`/api/assets/${mine.id}/checkout`, { employee_id: emp.id, assignment_type: 'permanent' });
  for (const a of [held, repair, archived, mine]) {
    const r = await emp.client.post('/api/requests', { catalog_node_id: t.a7.id, asset_id: a.id });
    assert.ok([400, 404].includes(r.status), `${a.name}: ${r.status}`);
    assert.ok(!r.text.includes('Other Holder'), 'the refusal must not leak who holds it');
  }
  assert.equal(count('SELECT COUNT(*) c FROM requests WHERE user_id = ?', emp.id), 0);
  // the specific-asset list the UI offers never contains them either
  const offered = (await emp.client.get(`/api/assets?catalog_node=${t.a7.id}`)).body.map((a) => a.id);
  assert.deepEqual(offered, []);
});

test('request payloads cannot smuggle a different catalog path, category or someone else\'s identity', async () => {
  const t = await cameraTree('rq4');
  const emp = await makeLogin('Forger'); const victim = await makeLogin('Victim');
  const r = await emp.client.post('/api/requests', {
    catalog_node_id: t.a7.id, category: 'Laptop', catalog_path: 'Laptop > Mac > MacBook Pro', asset_label: 'NC-00001 — Fake', user_id: victim.id,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user_id, emp.id);
  assert.equal(r.body.category, t.camera.name, 'category is derived from the chosen node');
  assert.equal(r.body.catalog_path, `${t.camera.name} > Sony > A7 IV`, 'path is derived from the node, never taken from the body');
  assert.equal(r.body.asset_label, null);
  // unknown / archived / junk nodes are refused
  for (const bad of [999999, 'abc', 0, -1]) assert.equal((await emp.client.post('/api/requests', { catalog_node_id: bad })).status, 400, String(bad));
  await admin.post(`/api/catalog/${t.sony.id}/archive`, {});
  assert.equal((await emp.client.post('/api/requests', { catalog_node_id: t.a7.id })).status, 400, 'a node under an archived parent is not requestable');
});

test('requesting one particular asset from its own page records its catalog position without a chooser', async () => {
  const t = await cameraTree('rq5');
  const a = await newAsset('Page A7', { catalog_node_id: t.a7.id });
  const emp = await makeLogin('Page Asker');
  const r = await emp.client.post('/api/requests', { asset_id: a.id, category: 'Camera', message: 'Please' });
  assert.equal(r.status, 200);
  assert.equal(r.body.catalog_node_id, t.a7.id);
  assert.equal(r.body.catalog_path, `${t.camera.name} > Sony > A7 IV`);
  assert.equal(r.body.asset_id, a.id);
});

test('admin can log a catalog request on behalf of an employee; an employee cannot', async () => {
  const t = await cameraTree('rq6');
  const emp = await makeLogin('On Behalf');
  const r = await admin.post('/api/requests', { user_id: emp.id, catalog_node_id: t.sony.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.user_id, emp.id);
  assert.equal(r.body.catalog_path, `${t.camera.name} > Sony`);
  const seen = (await admin.get('/api/requests')).body.find((x) => x.id === r.body.id);
  assert.equal(seen.catalog_path, `${t.camera.name} > Sony`, 'admin Requests carries the same hierarchy');
});

// ---------------------------------------------------------------- history integrity
test('renaming or moving catalog nodes does not change what an existing request says', async () => {
  const t = await cameraTree('hi');
  const a = await newAsset('History A7', { catalog_node_id: t.a7.id, name: 'History A7' });
  const emp = await makeLogin('History Asker');
  const made = (await emp.client.post('/api/requests', { catalog_node_id: t.a7.id, asset_id: a.id })).body;
  await admin.put(`/api/catalog/${t.camera.id}`, { name: 'Cinema Gear' });
  await admin.put(`/api/catalog/${t.sony.id}`, { name: 'Sony Alpha' });
  const dest = await node('Elsewhere');
  await admin.put(`/api/catalog/${t.a7.id}`, { parent_id: dest.id, name: 'A7 Mark IV' });
  await admin.put(`/api/assets/${a.id}`, { name: 'Renamed Body' });
  const mine = (await emp.client.get('/api/requests')).body.find((r) => r.id === made.id);
  assert.equal(mine.catalog_path, `${t.camera.name} > Sony > A7 IV`, 'the words at request time are kept');
  assert.equal(mine.category, t.camera.name);
  assert.equal(mine.asset_label, `${a.tag} — History A7`);
  assert.equal(mine.catalog_node_id, t.a7.id, 'the stable id still points at the (renamed, moved) node');
  assert.equal(catalogLib.pathText(db, t.a7.id), 'Elsewhere > A7 Mark IV');
  const adm = (await admin.get('/api/requests')).body.find((r) => r.id === made.id);
  assert.equal(adm.catalog_path, mine.catalog_path);
});

// ---------------------------------------------------------------- regressions
test('legacy requests still work: free-text category, message only, permanent, return and issue', async () => {
  const emp = await makeLogin('Legacy User');
  const legacy = await emp.client.post('/api/requests', { category: 'Monitor', message: 'Second screen' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.catalog_node_id, null);
  assert.equal(legacy.body.catalog_path, null);
  assert.equal(legacy.body.category, 'Monitor');
  assert.equal((await emp.client.post('/api/requests', { message: 'Only a message' })).status, 200);
  assert.equal((await emp.client.post('/api/requests', {})).status, 400, 'something must be said');
  const asset = await newAsset('Permanent Candidate');
  const perm = await emp.client.post('/api/requests', { asset_id: asset.id, category: 'Laptop', requested_assignment_type: 'permanent' });
  assert.equal(perm.status, 200, JSON.stringify(perm.body));
  assert.equal((await admin.post(`/api/requests/${perm.body.id}/approve`, { asset_id: asset.id, assignment_type: 'permanent' })).status, 200);
  const done = db.prepare('SELECT status FROM requests WHERE id = ?').get(perm.body.id);
  assert.equal(done.status, 'completed');
  assert.equal((await emp.client.post(`/api/assets/${asset.id}/report-issue`, { message: 'Screen flickers' })).status, 200);
  assert.equal((await emp.client.post(`/api/assets/${asset.id}/my-return-request`, {})).status, 200);
  assert.equal((await admin.post(`/api/requests/${legacy.body.id}/deny`, { note: 'no' })).status, 200);
});

test('a catalog request is approved/fulfilled through the unchanged admin flow', async () => {
  const t = await cameraTree('fu');
  const a = await newAsset('Fulfil A7', { catalog_node_id: t.a7.id });
  const emp = await makeLogin('Fulfil Me');
  const r = (await emp.client.post('/api/requests', { catalog_node_id: t.a7.id })).body;
  const ok = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, assignment_type: 'permanent' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = db.prepare('SELECT status, asset_id, catalog_path FROM requests WHERE id = ?').get(r.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.asset_id, a.id, 'the assigned asset is attached');
  assert.equal(after.catalog_path, `${t.camera.name} > Sony > A7 IV`);
  assert.equal((await emp.client.post(`/api/requests/${r.id}/cancel`, {})).status, 400, 'closed requests stay closed');
});

test('employees can still cancel their own catalog request while it is untouched (rescind rules unchanged)', async () => {
  const t = await cameraTree('rs');
  const emp = await makeLogin('Rescinder'); const other = await makeLogin('Not Mine');
  const r = (await emp.client.post('/api/requests', { catalog_node_id: t.sony.id })).body;
  assert.equal((await other.client.post(`/api/requests/${r.id}/cancel`, {})).status, 403);
  assert.equal((await emp.client.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
});

// ---------------------------------------------------------------- CSV
test('CSV export carries a readable catalog_path column at the END, and import maps exact paths without guessing', async () => {
  const t = await cameraTree('csv');
  const a = await newAsset('CSV Camera', { catalog_node_id: t.a7.id });
  const csv = (await admin.get('/api/export/assets.csv')).text.replace(/^﻿/, '');
  const header = csv.split('\r\n')[0].split(',');
  assert.equal(header[header.length - 1], 'catalog_path');
  assert.ok(csv.includes(`${t.camera.name} > Sony > A7 IV`));
  assert.deepEqual(header.slice(0, 5), ['tag', 'name', 'category', 'status', 'holder_names'], 'existing columns are untouched');

  // an OLD file with no catalog column still imports exactly as before
  const old = await admin.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body: 'name,category,brand,model\nOld Style Laptop,Laptop,Dell,Latitude' });
  assert.equal(old.status, 200, old.text);
  assert.equal(old.body.created, 1);
  assert.deepEqual(old.body.errors, []);

  const body = [
    'tag,name,catalog_path',
    `${a.tag},,  ${t.camera.name.toUpperCase()}  >  sony > a7 iv`,
    'CT-NEW-1,Brand New Camera,' + `${t.camera.name} > Canon > R5`,
    'CT-NEW-2,Mystery Camera,Camera > Nonexistent > Thing',
    'CT-NEW-3,Plain Camera,',
  ].join('\n');
  const res = await admin.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.created, 3);
  assert.equal(res.body.updated, 1);
  assert.equal(res.body.errors.length, 1);
  assert.match(res.body.errors[0], /Row 4.*Nonexistent.*doesn't match/);
  const get = (tag) => db.prepare('SELECT catalog_node_id n, category c FROM assets WHERE tag = ?').get(tag);
  assert.equal(get(a.tag).n, t.a7.id);
  assert.equal(get('CT-NEW-1').n, t.r5.id);
  assert.equal(get('CT-NEW-1').c, t.camera.name);
  assert.equal(get('CT-NEW-2').n, null, 'an unmatched path is reported, not guessed');
  assert.equal(get('CT-NEW-3').n, null);
});

// ---------------------------------------------------------------- migration 11 on an existing database
test('migration 11 turns existing categories into root nodes and links each asset to the root matching its own category — nothing deeper', () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d, migrations.filter((m) => m.id < 11));
  d.prepare("INSERT INTO settings (key, value) VALUES ('categories', ?)").run(JSON.stringify(['Laptop', 'Camera ', 'laptop', 'Printer / Scanner']));
  const ins = d.prepare("INSERT INTO assets (tag, name, category, brand, model) VALUES (?, ?, ?, ?, ?)");
  ins.run('T-1', 'Dell Latitude', 'Laptop', 'Dell', 'Latitude 5440');
  ins.run('T-2', 'MacBook Air', 'Laptop', 'Apple', 'MacBook Air M2');
  ins.run('T-3', 'Sony Body', 'Camera', 'Sony', 'A7 IV');
  ins.run('T-4', 'Legacy Thing', 'Weird  Gadget', null, null);
  ins.run('T-5', 'Spacey Laptop', ' laptop ', null, null);
  d.prepare("INSERT INTO employees (name) VALUES ('Old Employee')").run();
  d.prepare("INSERT INTO requests (type, user_id, category, message) VALUES ('equipment', 1, 'Laptop', 'old request')").run();

  runMigrations(d, migrations);
  const nodes = d.prepare('SELECT id, parent_id, name FROM catalog_nodes ORDER BY name_key').all();
  assert.deepEqual(nodes.map((n) => n.name), ['Camera', 'Laptop', 'Printer / Scanner', 'Weird Gadget'], 'one root per distinct category (case/whitespace-insensitive), including categories only found on assets');
  assert.ok(nodes.every((n) => n.parent_id === null), 'no hierarchy is invented below the roots');
  const link = Object.fromEntries(d.prepare('SELECT a.tag, n.name FROM assets a LEFT JOIN catalog_nodes n ON n.id = a.catalog_node_id').all().map((r) => [r.tag, r.name]));
  assert.deepEqual(link, { 'T-1': 'Laptop', 'T-2': 'Laptop', 'T-3': 'Camera', 'T-4': 'Weird Gadget', 'T-5': 'Laptop' });
  const kept = d.prepare("SELECT category, brand, model FROM assets WHERE tag = 'T-2'").get();
  assert.deepEqual({ ...kept }, { category: 'Laptop', brand: 'Apple', model: 'MacBook Air M2' }, 'category/brand/model are untouched');
  const req = d.prepare('SELECT category, catalog_node_id, catalog_path, asset_label FROM requests').get();
  assert.deepEqual({ ...req }, { category: 'Laptop', catalog_node_id: null, catalog_path: null, asset_label: null }, 'existing requests are untouched');
  assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.deepEqual(runMigrations(d, migrations), [], 'idempotent');
});

test('on a brand-new database migration 11 seeds the built-in category list as roots', () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d, migrations);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM catalog_nodes WHERE parent_id IS NULL').get().c, 13);
});
