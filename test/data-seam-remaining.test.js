// PostgreSQL migration Slice 5B-4 on the TEMPORARY database driver seam (D-48): settings, the outbox, the activity list, the CSV import /
// export, next-tag, the request list / create / approve / resolve / dropped-off and the sweeps now reach SQLite through src/dataSeam. These
// tests pin what the older suites do not already: the settings copy (src/settings.js) reads and writes exactly what src/db.js does and
// uses the handle it is bound to, employees vs IT on settings, the outbox / activity listings, the import's all-or-nothing transaction and
// its row errors, the tag preview with the prefix setting, the approval transaction, the request transitions, and the liveness probe
// with a failing database. SQLite only; never sends email (NC_NO_EXTERNAL_MAIL, set by the helpers).
// The SQLite side of the temporary driver seam: it opens SQLite itself, so it does not run in the PostgreSQL pass (test/pg covers the PG side).
if (process.env.NC_TEST_DRIVER === 'pg') { require('node:test').test(`${require('path').basename(__filename)} (SQLite seam)`, { skip: 'SQLite seam; the PG side is covered by test/pg' }, () => {}); return; }
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin, data;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  data = require('../src/dataSeam').open({ db });
});
after(() => stopServer(server));

let seq = 0;
const csvPost = (client, csv) => client.rawPost('/api/import/assets', { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/plain' }, body: csv });
async function newAsset(extra = {}) {
  const r = await admin.post('/api/assets', { name: `Rest Laptop ${++seq}`, tag: `REST-${seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const created = await admin.post('/api/users', { name, email: `rest${++seq}@nutricost.com`, invite: true });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, employeeId: created.body.id, accountId: created.body.account_id };
}
const statusOf = (id) => db.prepare('SELECT status FROM requests WHERE id = ?').get(id).status;
const activity = (assetId, action) => db.prepare('SELECT * FROM activity WHERE asset_id = ? AND action = ? ORDER BY id').all(assetId, action);

test('settings: src/settings.js reads and writes exactly what src/db.js does (the two copies cannot drift)', async () => {
  const dbjs = require('../src/db'); // the module the app opened (same DATA_DIR)
  assert.deepEqual(await data.settings.getSettings(), dbjs.getSettings());
  await data.settings.setSetting('categories', ['A', 'B']);
  await data.settings.setSetting('default_loan_days', '7');
  dbjs.setSetting('locations', ['Here']);
  assert.deepEqual(await data.settings.getSettings(), dbjs.getSettings());
  const raw = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  assert.equal(raw.categories, '["A","B"]'); assert.equal(raw.locations, '["Here"]'); assert.equal(raw.default_loan_days, '7');
  dbjs.setSetting('categories', JSON.parse(raw.categories)); // (unchanged)
});

test('settings: the seam reads and writes the settings of the database it is bound to, and no other', async () => {
  const other = new Database(':memory:');
  other.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('tag_prefix', 'MEM-')");
  const mem = require('../src/dataSeam').open({ db: other });
  const appPrefix = (await data.settings.getSettings()).tag_prefix;
  assert.equal((await mem.settings.getSettings()).tag_prefix, 'MEM-');
  await mem.settings.setSetting('it_email_name', 'Memory IT');
  assert.equal(other.prepare("SELECT value FROM settings WHERE key = 'it_email_name'").get().value, 'Memory IT');
  assert.equal((await data.settings.getSettings()).it_email_name, 'Nutricost IT', 'the app database is untouched');
  assert.equal((await data.settings.getSettings()).tag_prefix, appPrefix);
  other.close();
});

test('settings over HTTP: IT reads and saves them; an employee gets the shared ones only and can neither read nor change Settings', async () => {
  const saved = await admin.put('/api/settings', { it_email_name: '  Help Desk ', it_contact_email: ' IT@Nutricost.com ', default_loan_days: '-4', tag_prefix: '  ABCDEFGHIJKL ', categories: [' X ', '', 'Y'], overdue_reminders: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { ...(await data.settings.getSettings()) });
  assert.equal(saved.body.it_email_name, 'Help Desk'); assert.equal(saved.body.it_contact_email, 'it@nutricost.com');
  assert.equal(saved.body.default_loan_days, 0); assert.equal(saved.body.tag_prefix, 'ABCDEFGHIJ'); assert.deepEqual(saved.body.categories, ['X', 'Y']);
  assert.equal(saved.body.overdue_reminders, false);
  const got = (await admin.get('/api/settings')).body;
  assert.equal(got.tag_prefix, 'ABCDEFGHIJ'); assert.equal(got.mailConfigured, false); assert.equal(got.appUrl, 'http://localhost');
  // invalid input is refused BEFORE anything is saved (a credential-shaped key, or a bad contact email next to a valid change)
  assert.deepEqual((await admin.put('/api/settings', { smtp_pass: 'x', tag_prefix: 'NO-' })).body, { error: 'Email passwords, keys and secrets are not stored here. Set them in the server environment (see the README).' });
  assert.deepEqual((await admin.put('/api/settings', { it_contact_email: 'not an email', tag_prefix: 'NO-' })).body, { error: 'The IT contact email is not a valid email address.' });
  assert.equal((await data.settings.getSettings()).tag_prefix, 'ABCDEFGHIJ');
  // GET /api/me: everyone gets the shared settings; only IT gets the IT email identity
  const adminMe = (await admin.get('/api/me')).body.settings;
  assert.equal(adminMe.it_email_name, 'Help Desk'); assert.equal(adminMe.it_contact_email, 'it@nutricost.com');
  const emp = await makeLogin('Sett Employee');
  const empMe = (await emp.client.get('/api/me')).body;
  assert.equal(empMe.user.role, 'employee');
  assert.ok(!('it_email_name' in empMe.settings) && !('it_contact_email' in empMe.settings));
  assert.equal(empMe.settings.tag_prefix, 'ABCDEFGHIJ');
  for (const r of [await emp.client.get('/api/settings'), await emp.client.put('/api/settings', { tag_prefix: 'EMP-' }), await emp.client.get('/api/outbox'), await emp.client.get('/api/activity'), await emp.client.get('/api/next-tag')]) {
    assert.equal(r.status, 403); assert.deepEqual(r.body, { error: 'Admins only' });
  }
  assert.equal((await data.settings.getSettings()).tag_prefix, 'ABCDEFGHIJ');
  await admin.put('/api/settings', { tag_prefix: 'NC-', overdue_reminders: true, it_email_name: 'Nutricost IT', it_contact_email: '' });
});

test('next-tag previews the next number with the tag_prefix setting, consumes nothing, and skips taken tags', async () => {
  await admin.put('/api/settings', { tag_prefix: 'QA-' });
  const n = db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n;
  const fmt = (k) => `QA-${String(k).padStart(5, '0')}`;
  assert.deepEqual((await admin.get('/api/next-tag')).body, { tag: fmt(n + 1) });
  assert.deepEqual((await admin.get('/api/next-tag')).body, { tag: fmt(n + 1) }, 'a preview consumes nothing');
  await newAsset({ tag: fmt(n + 1) }); // a manually chosen tag takes that number
  assert.deepEqual((await admin.get('/api/next-tag')).body, { tag: fmt(n + 2) });
  const issued = await admin.post('/api/assets', { name: 'Blank tag' }); // a blank tag issues it with the same setting
  assert.equal(issued.body.tag, fmt(n + 2));
  await admin.put('/api/settings', { tag_prefix: 'NC-' });
});

test('outbox and activity: newest first, limited, with the same columns; test-email answers the newest outbox row', async () => {
  const sent = await admin.post('/api/settings/test-email', {});
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, db.prepare('SELECT status, error FROM outbox ORDER BY id DESC LIMIT 1').get());
  const ins = db.prepare("INSERT INTO outbox (to_addr, subject, body, status) VALUES (?, ?, 'b', 'logged')");
  for (let i = 0; i < 105; i++) ins.run(`o${i}@example.com`, `Subject ${i}`);
  const out = (await admin.get('/api/outbox')).body;
  assert.equal(out.length, 100);
  assert.deepEqual(Object.keys(out[0]).sort(), ['created_at', 'delivered_to', 'error', 'id', 'status', 'subject', 'to_addr']);
  assert.equal(out[0].subject, 'Subject 104');
  assert.deepEqual(out.map((o) => o.id), [...out.map((o) => o.id)].sort((a, b) => b - a));
  assert.deepEqual(out, await data.outbox.recent());
  const asset = await newAsset();
  await admin.put(`/api/assets/${asset.id}`, { location: 'Shelf 9' });
  const act = (await admin.get('/api/activity?limit=2')).body;
  assert.equal(act.length, 2);
  assert.equal(act[0].action, 'edited'); assert.equal(act[0].asset_name, asset.name); assert.equal(act[0].tag, asset.tag); assert.equal(act[0].actor_name, 'Ada Admin');
  assert.equal(act[1].action, 'created');
  assert.ok(act[0].id > act[1].id);
  assert.equal((await admin.get('/api/activity?limit=5000')).body.length, Math.min(1000, db.prepare('SELECT COUNT(*) c FROM activity').get().c), 'capped at 1000');
  assert.equal((await admin.get('/api/activity?limit=abc')).body.length, Math.min(200, db.prepare('SELECT COUNT(*) c FROM activity').get().c), 'default 200');
});

test('CSV import: row problems are reported with their row numbers and the other rows imported; export lists the live assets', async () => {
  const archived = await newAsset({ serial: 'ARCH-SER-1' });
  await admin.post(`/api/assets/${archived.id}/archive`, {});
  const csv = ['name,tag,serial,catalog_path,assigned_email',
    `Fine One,IMP-OK-1,IMP-SER-1,,`,
    `Archived,${archived.tag},,,`,
    `,IMP-NONAME,,,`,
    `Dup Serial,IMP-DUP,arch-ser-1,,`,
    `No Path,IMP-NOPATH,,Nowhere > Missing,`,
    `No User,IMP-NOUSER,,,ghost@example.com`].join('\n');
  const r = await csvPost(admin, csv);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { created: 3, updated: 0, errors: [
    `Row 3: tag ${archived.tag} belongs to an archived asset — skipped`,
    'Row 4: missing name',
    `Row 5: Serial number arch-ser-1 is already used by asset ${archived.tag} (archived) — skipped`,
    'Row 6: catalog path “Nowhere > Missing” doesn\'t match an active catalog entry — imported without a catalog link',
    'Row 7: no user with email ghost@example.com — imported unassigned',
  ] });
  for (const tag of ['IMP-OK-1', 'IMP-NOPATH', 'IMP-NOUSER']) assert.ok(db.prepare('SELECT 1 FROM assets WHERE tag = ?').get(tag), tag);
  for (const tag of ['IMP-NONAME', 'IMP-DUP']) assert.equal(db.prepare('SELECT 1 FROM assets WHERE tag = ?').get(tag), undefined, tag);
  const exp = await admin.get('/api/export/assets.csv');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /^text\/csv/);
  assert.ok(exp.text.startsWith('tag,name,category,status,'), exp.text.slice(0, 40)); // (fetch's text() drops the byte-order mark)
  assert.ok(exp.text.includes('IMP-OK-1,Fine One,Other,available,'));
  assert.ok(!exp.text.includes(`${archived.tag},`), 'archived assets are not exported');
  assert.equal(exp.text.split('\r\n').length - 1, (await data.assetViews.exportRows()).length);
});

test('CSV import is ONE transaction: a failure on a later row rolls back every row, the tag counter and the activity', async () => {
  const catalog = require('../src/catalog');
  const emp = await makeLogin('Import Holder');
  const email = db.prepare('SELECT work_email e FROM employees WHERE id = ?').get(emp.employeeId).e;
  const before = {
    assets: db.prepare('SELECT COUNT(*) c FROM assets').get().c, activity: db.prepare('SELECT COUNT(*) c FROM activity').get().c,
    assignments: db.prepare('SELECT COUNT(*) c FROM assignments').get().c, counter: db.prepare('SELECT last_number n FROM asset_tag_counter').get().n,
  };
  const real = catalog.findLiveByPath;
  catalog.findLiveByPath = (d, p) => { if (p === 'Boom') throw new Error('disk full'); return real(d, p); };
  const realError = console.error; console.error = () => {};
  let r;
  try {
    r = await csvPost(admin, ['name,catalog_path,assigned_email', `Rolled Back,,${email}`, 'Also Back,,', 'Explodes,Boom,'].join('\n'));
  } finally { catalog.findLiveByPath = real; console.error = realError; }
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Something went wrong. Please try again.' });
  assert.deepEqual({
    assets: db.prepare('SELECT COUNT(*) c FROM assets').get().c, activity: db.prepare('SELECT COUNT(*) c FROM activity').get().c,
    assignments: db.prepare('SELECT COUNT(*) c FROM assignments').get().c, counter: db.prepare('SELECT last_number n FROM asset_tag_counter').get().n,
  }, before, 'nothing of the file was kept');
  // the same file without the failing row imports (and assigns) normally
  const ok = await csvPost(admin, ['name,catalog_path,assigned_email', `Kept,,${email}`, 'Also Kept,,'].join('\n'));
  assert.deepEqual(ok.body, { created: 2, updated: 0, errors: [] });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE employee_id = ? AND returned_at IS NULL').get(emp.employeeId).c, 1);
  assert.equal(db.prepare('SELECT last_number n FROM asset_tag_counter').get().n, before.counter + 2);
});

test('approve: the assignment and the request completion are one transaction (a refused assignment leaves the request open)', async () => {
  const asset = await newAsset();
  const asker = await makeLogin('Asker Approve');
  const other = await makeLogin('Other Holder');
  const req = await asker.client.post('/api/requests', { asset_id: asset.id, message: 'Need it' });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.asset_label, `${asset.tag} — ${asset.name}`);
  assert.equal(activity(asset.id, 'requested').length, 1);
  // the asset goes to someone else meanwhile: approving with it is refused by createAssignment INSIDE the transaction
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: other.employeeId, assignment_type: 'permanent' })).status, 200);
  const refused = await admin.post(`/api/requests/${req.body.id}/approve`, { asset_id: asset.id, assignment_type: 'permanent' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(statusOf(req.body.id), 'open', 'the request was not completed without its assignment');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND employee_id = ?').get(asset.id, asker.employeeId).c, 0);
  // returned: now the approval assigns it and completes the request together
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkin`, {})).status, 200);
  const done = await admin.post(`/api/requests/${req.body.id}/approve`, { asset_id: asset.id, assignment_type: 'permanent', note: 'Here you go' });
  assert.deepEqual(done.body, { ok: true });
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.body.id);
  assert.equal(row.status, 'completed'); assert.equal(row.resolution_note, 'Here you go'); assert.ok(row.opened_at);
  assert.ok(db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND notes = ? AND returned_at IS NULL').get(asset.id, asker.employeeId, `Request #${row.id}`));
  // an "anything" request approved without an asset: approved, nothing assigned; approving again is refused
  const any = await asker.client.post('/api/requests', { category: 'Monitor', message: 'Any monitor' });
  assert.deepEqual((await admin.post(`/api/requests/${any.body.id}/approve`, {})).body, { ok: true });
  assert.equal(statusOf(any.body.id), 'approved');
  // the list: the employee sees only their own, each with can_cancel and its lifecycle
  const mine = (await asker.client.get('/api/requests')).body;
  assert.deepEqual(mine.map((x) => x.id).sort(), [req.body.id, any.body.id].sort());
  assert.deepEqual((await asker.client.get('/api/requests')).body, await data.requestRecords.listRequests({ role: 'employee', employee_id: asker.employeeId }, {}));
  assert.deepEqual((await asker.client.get('/api/requests?status=bogus')).body, { error: 'Status must be open or closed' });
});

test('resolve and dropped-off: the status change and its activity row; refusals unchanged', async () => {
  const emp = await makeLogin('Holder Transitions');
  const asset = await newAsset();
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: emp.employeeId, assignment_type: 'permanent' })).status, 200);
  const issue = await emp.client.post(`/api/assets/${asset.id}/report-issue`, { message: 'Screen flickers' });
  assert.equal(issue.status, 200, JSON.stringify(issue.body));
  const issueId = db.prepare("SELECT id FROM requests WHERE type = 'issue' AND asset_id = ?").get(asset.id).id;
  assert.deepEqual((await emp.client.post(`/api/requests/${issueId}/resolve`, {})).body, { error: 'Admins only' });
  assert.deepEqual((await admin.post(`/api/requests/${issueId}/dropped-off`, {})).body, { error: 'This request is not open' });
  assert.deepEqual((await admin.post(`/api/requests/${issueId}/resolve`, { note: 'Replaced cable' })).body, { ok: true });
  assert.equal(statusOf(issueId), 'completed');
  assert.deepEqual(activity(asset.id, 'issue_resolved').map((a) => [a.details, a.subject_user_id]), [['Replaced cable', emp.employeeId]]);
  assert.deepEqual((await admin.post(`/api/requests/${issueId}/resolve`, {})).body, { error: 'This request is already closed' });
  // IT asks for it back; the holder says it was dropped off
  assert.equal((await admin.post(`/api/assets/${asset.id}/request-return`, {})).status, 200);
  const retId = db.prepare("SELECT id FROM requests WHERE type = 'return' AND asset_id = ?").get(asset.id).id;
  const stranger = await makeLogin('Not The Holder');
  assert.deepEqual((await stranger.client.post(`/api/requests/${retId}/dropped-off`, {})).body, { error: 'Not allowed' });
  assert.deepEqual((await admin.post(`/api/requests/${retId}/resolve`, {})).body, { error: 'Only issue reports can be marked resolved' });
  assert.deepEqual((await emp.client.post(`/api/requests/${retId}/dropped-off`, { note: 'At the IT desk' })).body, { ok: true });
  assert.equal(statusOf(retId), 'dropped_off');
  assert.deepEqual(activity(asset.id, 'dropped_off').map((a) => a.details), ['At the IT desk']);
  assert.deepEqual((await emp.client.post(`/api/requests/${retId}/dropped-off`, {})).body, { error: 'This request is not open' });
  assert.equal(activity(asset.id, 'dropped_off').length, 1, 'a refused transition writes no activity');
  assert.deepEqual((await admin.post('/api/requests/987654/resolve', {})).body, { error: 'Request not found' });
});

test('overdue sweep data: the overdue assignments of active employees, until reminded today', async () => {
  const emp = await makeLogin('Late Returner');
  const asset = await newAsset();
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: emp.employeeId, assignment_type: 'checkout', due_date: new Date(Date.now() + 864e5).toISOString().slice(0, 10) })).status, 200);
  const id = db.prepare('SELECT id FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(asset.id).id;
  db.prepare('UPDATE assignments SET due_date = ? WHERE id = ?').run(yesterday, id);
  const due = (await data.overdue.dueAssignments()).find((s) => s.id === id);
  assert.ok(due); assert.equal(due.user_name, 'Late Returner'); assert.match(due.user_email, /@nutricost\.com$/);
  await data.overdue.markNotified(id);
  assert.equal((await data.overdue.dueAssignments()).find((s) => s.id === id), undefined, 'reminded today: not again for three days');
});

// Last: closes the database. The liveness probe has no database access by design (it is in the ratchet's NO_OWN_SQL), so a failing
// database does not fail it, while every route that needs the database answers the generic 500.
test('GET /health answers ok with a failing database; database routes answer the generic 500', async () => {
  const realError = console.error; console.error = () => {};
  try {
    db.close();
    const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { ok: true });
    for (const r of [await admin.get('/api/me'), await admin.get('/api/settings'), await admin.get('/api/next-tag')]) {
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'Something went wrong. Please try again.' });
    }
  } finally { console.error = realError; }
});
