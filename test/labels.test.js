// Labels before assets (docs/briefs/labels-and-assets.md): POST /api/tags/claim reserves the next tags for printed labels, the scan lookup
// tells IT that a code is one of those labels (issued, unused), and an asset is then added with that tag. Runs on both drivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server; let db; let admin; let employee;

before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  ({ client: admin } = await setupAdmin(server));
  const p = await admin.post('/api/users', { name: 'Eve Employee', email: 'eve@nutricost.com', invite: false });
  db.prepare("UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE login_email = 'ada@nutricost.com') WHERE id = ?").run(p.body.account_id);
  employee = makeClient(server);
  assert.equal((await employee.post('/api/login', { email: 'eve@nutricost.com', password: 'correct-horse-1' })).status, 200);
});
after(() => stopServer(server));

const counter = () => db.prepare('SELECT last_number FROM asset_tag_counter WHERE id = 1').get().last_number;
const lookup = (c, code) => c.get('/api/assets/lookup/' + encodeURIComponent(code));

test('the next-tag preview consumes nothing; claiming reserves consecutive tags that the preview and later creates skip', async () => {
  const c0 = counter();
  const peek = (await admin.get('/api/next-tag')).body.tag;
  assert.equal((await admin.get('/api/next-tag')).body.tag, peek, 'opening the form twice shows the same number');
  assert.equal(counter(), c0);
  const r = await admin.post('/api/tags/claim', { count: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.tags.length, 3);
  assert.equal(r.body.tags[0], peek, 'the first claimed tag is the one the preview showed');
  assert.equal(counter(), c0 + 3);
  const made = await admin.post('/api/assets', { name: 'Blank-tag create', category: 'Other' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.ok(!r.body.tags.includes(made.body.tag), 'a blank-tag create never takes a claimed number');
});

test('a scanned claimed label is "issued" for IT until an asset uses it; then it is found', async () => {
  const [tag] = (await admin.post('/api/tags/claim', { count: 1 })).body.tags;
  assert.deepEqual((await lookup(admin, tag.toLowerCase())).body, { found: false, code: tag.toLowerCase(), issued: tag });
  assert.deepEqual((await lookup(employee, tag)).body, { found: false, code: tag }, 'employees are not told about labels');
  const made = await admin.post('/api/assets', { tag, name: 'Labelled first', category: 'Other' });
  assert.equal(made.status, 200);
  assert.equal(made.body.tag, tag);
  const found = (await lookup(admin, tag)).body;
  assert.deepEqual([found.found, found.id], [true, made.body.id]);
  // an unclaimed number, a different prefix or a random code: not issued
  const next = (await admin.get('/api/next-tag')).body.tag;
  for (const code of [next, 'XX-00001', 'SN-12345']) assert.equal((await lookup(admin, code)).body.issued, undefined, code);
});

test('claim: a count from 1 to 300, admins only', async () => {
  for (const count of [0, 301, 2.5, 'x', undefined]) assert.equal((await admin.post('/api/tags/claim', { count })).status, 400, String(count));
  assert.equal((await employee.post('/api/tags/claim', { count: 1 })).status, 403);
  const c0 = counter();
  assert.equal((await admin.post('/api/tags/claim', { count: 300 })).body.tags.length, 300);
  assert.equal(counter(), c0 + 300);
});

test('give back: the newest unused sheet returns and the next claim reuses its numbers; refused once newer numbers or an asset exist', async () => {
  const c0 = counter();
  const { tags } = (await admin.post('/api/tags/claim', { count: 4 })).body;
  assert.deepEqual((await admin.post('/api/tags/release', { tags })).body, { released: 4 });
  assert.equal(counter(), c0);
  assert.deepEqual((await admin.post('/api/tags/claim', { count: 4 })).body.tags, tags, 'the same numbers again');
  // a newer claim after them: refused, nothing changes
  const newer = (await admin.post('/api/tags/claim', { count: 1 })).body.tags;
  const c1 = counter();
  const r = await admin.post('/api/tags/release', { tags });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Newer numbers were reserved after these/);
  assert.equal(counter(), c1);
  // the newest sheet, but one of its labels is on an asset: refused
  assert.equal((await admin.post('/api/assets', { tag: newer[0], name: 'Uses the label', category: 'Other' })).status, 200);
  const used = await admin.post('/api/tags/release', { tags: newer });
  assert.equal(used.status, 409);
  assert.match(used.body.error, /already on an asset/);
  assert.equal(counter(), c1);
  // a blank-tag create after a claim makes it no longer the newest
  const sheet = (await admin.post('/api/tags/claim', { count: 2 })).body.tags;
  assert.equal((await admin.post('/api/assets', { name: 'Blank tag after the sheet', category: 'Other' })).status, 200);
  assert.equal((await admin.post('/api/tags/release', { tags: sheet })).status, 409);
});

test('give back: bad input is a 400, tags that are not ours a 409, employees a 403', async () => {
  for (const tags of [undefined, [], 'NC-00001', [1, 2], Array.from({ length: 301 }, () => 'NC-00001')]) assert.equal((await admin.post('/api/tags/release', { tags })).status, 400, JSON.stringify(tags)?.slice(0, 40));
  assert.equal((await admin.post('/api/tags/release', { tags: ['XX-00001'] })).status, 409);
  assert.equal((await employee.post('/api/tags/release', { tags: ['NC-00001'] })).status, 403);
});

test('prefix change NC- to IT-: previews, new labels and automatic numbers use IT-; old labels, old assets and manual tags are untouched', async () => {
  const num = (t) => t.slice(-5);
  const put = (body) => admin.put('/api/settings', body);
  assert.equal((await put({ tag_prefix: 'NC-' })).body.tag_prefix, 'NC-');
  const old = { custom: 'CAM-77', held: (await admin.post('/api/tags/claim', { count: 2 })).body.tags, unused: (await admin.post('/api/tags/claim', { count: 3 })).body.tags };
  assert.ok(old.held.every((t) => t.startsWith('NC-')));
  const oldAsset = (await admin.post('/api/assets', { tag: old.held[0], name: 'Labelled under NC-', category: 'Other' })).body;
  const manual = (await admin.post('/api/assets', { tag: old.custom, name: 'Manual tag', category: 'Other' })).body;
  assert.equal(manual.tag, old.custom);

  // a draft prefix is only previewed: nothing is claimed and the saved prefix does not move
  const c0 = counter();
  const next = Number(num((await admin.get('/api/next-tag')).body.tag));
  assert.equal((await admin.get('/api/next-tag?prefix=' + encodeURIComponent('LAP-'))).body.tag, `LAP-${String(next).padStart(5, '0')}`);
  assert.equal((await admin.get('/api/next-tag?prefix=' + encodeURIComponent('  MON-  '))).body.tag, `MON-${String(next).padStart(5, '0')}`);
  assert.equal((await admin.get('/api/next-tag?prefix=')).body.tag, `NC-${String(next).padStart(5, '0')}`, 'a blank draft previews the saved prefix');
  assert.equal(counter(), c0);
  assert.equal((await admin.get('/api/settings')).body.tag_prefix, 'NC-');
  assert.equal((await employee.get('/api/next-tag?prefix=IT-')).status, 403);

  // save IT-: saving alone claims nothing; checkout settings saved without a prefix leave it alone
  assert.equal((await put({ tag_prefix: 'IT-' })).body.tag_prefix, 'IT-');
  assert.equal(counter(), c0, 'changing the prefix claims no number');
  assert.equal((await put({ default_loan_days: 7, overdue_reminders: true })).body.tag_prefix, 'IT-', 'the checkout settings form no longer sends a prefix');
  assert.equal((await admin.get('/api/next-tag')).body.tag, `IT-${String(next).padStart(5, '0')}`, 'Add asset previews the IT- tag');
  assert.equal((await admin.get('/api/assets/lookup/' + encodeURIComponent(oldAsset.tag))).body.id, oldAsset.id, 'an old NC- asset still scans');
  assert.equal((await lookup(admin, old.custom)).body.found, true, 'a manual tag still scans');

  // new labels and automatic numbers use IT-
  const fresh = (await admin.post('/api/tags/claim', { count: 2 })).body.tags;
  assert.deepEqual(fresh, [`IT-${String(next).padStart(5, '0')}`, `IT-${String(next + 1).padStart(5, '0')}`]);
  const auto = (await admin.post('/api/assets', { name: 'Auto after the change', category: 'Other' })).body;
  assert.equal(auto.tag, `IT-${String(next + 2).padStart(5, '0')}`);

  // previously issued NC- labels (printed, no asset yet) still open Add asset; look-alikes that were never issued do not
  for (const tag of old.unused) assert.deepEqual((await lookup(admin, tag.toLowerCase())).body, { found: false, code: tag.toLowerCase(), issued: tag }, tag);
  assert.equal((await admin.post('/api/assets', { tag: old.unused[0], name: 'Scanned old label', category: 'Other' })).status, 200);
  for (const tag of fresh) assert.equal((await lookup(admin, tag)).body.issued, tag);
  for (const code of [`IT-${num(old.unused[1])}`, `NC-${num(fresh[0])}`, `IT-${String(next + 3).padStart(5, '0')}`, 'IT-00001']) assert.equal((await lookup(admin, code)).body.issued, undefined, code);

  // Give Back across the change: the old batch is not the newest, so it is refused and nothing moves; the new batch goes back alone
  const c1 = counter();
  const refused = await admin.post('/api/tags/release', { tags: old.unused.slice(1) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Newer numbers were reserved after these/);
  assert.equal(counter(), c1);
  assert.equal((await lookup(admin, old.unused[1])).body.issued, old.unused[1], 'the refused batch is still usable');
  assert.equal((await admin.post('/api/tags/release', { tags: ['NC-' + num(fresh[0]), 'NC-' + num(fresh[1])] })).status, 409, 'a prefix the batch was not issued under');
  assert.equal(counter(), c1);

  // a batch claimed under NC- and given back after the switch (nothing newer): works, and the numbers are reissued as IT-, never twice
  assert.equal((await put({ tag_prefix: 'NC-' })).body.tag_prefix, 'NC-');
  const sheet = (await admin.post('/api/tags/claim', { count: 2 })).body.tags;
  assert.ok(sheet.every((t) => t.startsWith('NC-')));
  assert.equal((await put({ tag_prefix: 'IT-' })).body.tag_prefix, 'IT-');
  assert.deepEqual((await admin.post('/api/tags/release', { tags: sheet })).body, { released: 2 });
  assert.equal((await lookup(admin, sheet[0])).body.issued, undefined, 'a given-back label is no longer issued');
  const again = (await admin.post('/api/tags/claim', { count: 2 })).body.tags;
  assert.deepEqual(again.map(num), sheet.map(num));
  assert.ok(again.every((t) => t.startsWith('IT-')));
  const tags = (await admin.get('/api/assets?include_archived=1')).body.map((a) => a.tag.toLowerCase());
  assert.equal(new Set(tags).size, tags.length, 'every asset tag is still unique');
  await put({ tag_prefix: 'NC-' });
});

test('front end: the asset tag prefix lives in Create labels (explicit save, live example) and is gone from Settings > Check-out rules', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const settings = src.slice(src.indexOf('async function viewSettings('), src.indexOf("$('#test').onclick"));
  assert.doesNotMatch(settings, /tag_prefix|Asset tag prefix/, 'Settings no longer shows or sends the prefix');
  assert.match(settings, /default_loan_days: fd\.get\('default_loan_days'\),\s+it_email_name:/, 'the checkout settings body is otherwise unchanged');
  const labels = src.slice(src.indexOf('async function viewCreateLabels('), src.indexOf('// ============================================================ import / export'));
  assert.match(labels, /Asset tag prefix/);
  assert.match(labels, /Save prefix/);
  assert.match(labels, /Add asset's automatic numbering/);
  assert.match(labels, /existing assets and labels already printed never change/);
  assert.match(labels, /\/api\/next-tag\?prefix=/, 'the live example previews the draft');
  assert.match(labels, /api\('PUT', '\/api\/settings', \{ tag_prefix: draft\(\) \}\)/, 'only the explicit Save writes the prefix');
  assert.match(labels, /\$\('#go'\)\.disabled = dirty/, 'Create & print waits for the draft to be saved');
  assert.match(labels, /id="giveback"/, 'Give Back is kept');
});

// Front-end wiring (a string-level guard like the other front-end tests; the screens are checked in a real browser).
test('front end: label pages under All assets, the catalog folded into All assets, the form label, and scans of our labels', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const side = src.slice(src.indexOf('const side = ['), src.indexOf('return { tabs: common, side };'));
  assert.match(side, /key: 'labels', href: '#\/labels', label: 'Print labels', icon: 'printer', sub: true \}, \{ key: 'labels-new', href: '#\/labels\/new', label: 'Create labels', icon: 'plus', sub: true \}/);
  assert.ok(side.indexOf("key: 'labels'") > side.indexOf("key: 'assets'") && side.indexOf("key: 'labels'") < side.indexOf("key: 'scan'"), 'right under All assets');
  assert.doesNotMatch(src, /label: 'Equipment catalog'/, 'no separate Equipment catalog menu item');
  assert.match(src, /\[\/\^#\\\/labels\\\/new\$\/, viewCreateLabels, \{ key: 'labels-new', admin: true \}\]/);
  assert.match(src, /\[\/\^#\\\/catalog\$\/, \(\) => \{ history\.replaceState\(null, '', '#\/assets'/, 'old catalog links land on All assets');
  assert.match(src, /return isAdmin\(\) \? viewAdminAssets\(\) : viewBrowse\(\);/);
  assert.doesNotMatch(src, /async function viewCatalog\(/);
  // All assets keeps the old list's tools: the status Filter (the Home cards link to them), Add asset, scan, CSV export
  const page = src.slice(src.indexOf('const ADMIN_STATUSES = ['), src.indexOf('// ============================================================ profile'));
  for (const s of ["['overdue', 'Overdue']", "href: '#/labels/new'", "href: '#/labels'", 'id="scanbtn"', '/api/export/assets.csv', "if (st.status) u.set('status', st.status)"]) assert.ok(page.includes(s), s);
  // the form: a label preview; Print label reserves a number only when the tag field is empty
  const form = src.slice(src.indexOf('async function viewAssetForm('), src.indexOf('// ============================================================ scan'));
  assert.match(form, /serial: qs\(\)\.get\('serial'\) \|\| ''/);
  assert.match(form, /if \(!tagIn\.value\.trim\(\)\) \{\s+const \[tag\] = \(await api\('POST', '\/api\/tags\/claim', \{ count: 1 \}\)\)\.tags;/);
  assert.doesNotMatch(form.slice(0, form.indexOf("$('#plabel').onclick")), /api\('POST', '\/api\/tags\/claim'/, 'opening the form reserves nothing');
  // scanning: our label opens Add asset with it; another unknown code is offered as the serial number first
  const scan = src.slice(src.indexOf('async function handleScannedCode('), src.indexOf('// ============================================================ shell'));
  assert.match(scan, /if \(r\.issued && isAdmin\(\)\) return go\('#\/new\?tag=' \+ encodeURIComponent\(r\.issued\)\);/);
  assert.ok(scan.indexOf("'#/new?serial='") > 0 && scan.indexOf('id="mks"') < scan.indexOf('id="mk"'), 'serial first, tag second');
  // Create labels asks after the print dialog closes and can give the numbers back
  const create = src.slice(src.indexOf('function viewCreateLabels()'), src.indexOf('// ============================================================ import / export'));
  assert.match(create, /window\.addEventListener\('afterprint', ask\)/);
  assert.match(create, /await api\('POST', '\/api\/tags\/release', \{ tags \}\)/);
  // every page gets a Back (the previous page, else Home); All assets has a caret for its sub-items; pages animate in
  assert.match(src, /if \(!opt\.pub\) \{ ensureBack\(\); if \(!silent\) animateIn\(main\(\)\); \}/);
  assert.match(src, /i\.key === 'assets' && isAdmin\(\) \? icon\('chev', 'nav-caret'\) : ''/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.sidebar\.assets-open \.nav-caret \{ transform: rotate\(90deg\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  #main\.page-in > \*/, 'no animation when the OS asks for less motion');
});
