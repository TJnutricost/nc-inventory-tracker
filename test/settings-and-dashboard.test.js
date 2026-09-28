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

test('settings round-trip: categories, locations, tag prefix, loan days', async () => {
  const put = await admin.put('/api/settings', {
    categories: ['Laptop', 'Custom Category'],
    locations: ['Remote'],
    tag_prefix: 'ZZ-',
    default_loan_days: 14,
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.categories, ['Laptop', 'Custom Category']);
  assert.equal(put.body.tag_prefix, 'ZZ-');
  assert.equal(put.body.default_loan_days, 14);

  const nextTag = await admin.get('/api/next-tag');
  assert.match(nextTag.body.tag, /^ZZ-\d{5}$/);
});

test('a checkout with no explicit due date picks one up from the default-loan-days setting', async () => {
  await admin.put('/api/settings', { default_loan_days: 7 });
  const created = await admin.post('/api/users', { name: 'Default Due', email: 'defaultdue@nutricost.com' });
  const asset = (await admin.post('/api/assets', { name: 'Loaner', tag: 'ZZ-DUE1' })).body;
  const co = await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: created.body.id });
  assert.equal(co.status, 200);
  assert.ok(co.body.assignment.due_date, 'expected a due date to be set automatically');
});

test('a non-admin cannot read or change settings', async () => {
  const created = await admin.post('/api/users', { name: 'No Settings', email: 'nosettings@nutricost.com' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose='reset'").get(created.body.id);
  const c = makeClient(server);
  await c.post('/api/reset', { token: tok.token, password: 'no-settings-1' });
  assert.equal((await c.get('/api/settings')).status, 403);
  assert.equal((await c.put('/api/settings', { tag_prefix: 'HACK-' })).status, 403);
});

test('overdue assignments show up in the dashboard stats and asset filter', async () => {
  const created = await admin.post('/api/users', { name: 'Overdue Owner', email: 'overdue@nutricost.com' });
  const asset = (await admin.post('/api/assets', { name: 'Overdue Thing', tag: 'ZZ-OVERDUE1' })).body;
  await admin.post(`/api/assets/${asset.id}/checkout`, { user_id: created.body.id, due_date: '2000-01-01' });

  const dash = await admin.get('/api/dashboard');
  assert.ok(dash.body.stats.overdue >= 1);
  assert.ok(dash.body.overdue.some((o) => o.tag === 'ZZ-OVERDUE1'));

  const filtered = await admin.get('/api/assets?status=overdue');
  assert.ok(filtered.body.some((a) => a.tag === 'ZZ-OVERDUE1'));
});

test('an email notification is logged to the outbox when SMTP is not configured', async () => {
  const created = await admin.post('/api/users', { name: 'Mail Target', email: 'mailtarget@nutricost.com' });
  assert.equal(created.status, 200);
  const outbox = await admin.get('/api/outbox');
  const found = outbox.body.find((m) => m.to_addr === 'mailtarget@nutricost.com');
  assert.ok(found, 'expected the welcome email to be recorded in the outbox');
  assert.equal(found.status, 'logged');
});

test('test-email endpoint records an attempt in the outbox', async () => {
  const r = await admin.post('/api/settings/test-email', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'logged');
});

test('deactivating a user signs them out and blocks future logins', async () => {
  const created = await admin.post('/api/users', { name: 'Soon Gone', email: 'soongone@nutricost.com' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose='reset'").get(created.body.id);
  const c = makeClient(server);
  await c.post('/api/reset', { token: tok.token, password: 'soon-gone-1' });
  assert.equal((await c.get('/api/me')).status, 200);

  await admin.put(`/api/users/${created.body.id}`, { active: false });
  assert.equal((await c.get('/api/me')).status, 401);

  const loginAttempt = await makeClient(server).post('/api/login', { email: 'soongone@nutricost.com', password: 'soon-gone-1' });
  assert.equal(loginAttempt.status, 401);
});

test('an admin cannot demote or deactivate their own account', async () => {
  const me = await admin.get('/api/me');
  const demote = await admin.put(`/api/users/${me.body.user.id}`, { role: 'user' });
  assert.equal(demote.status, 400);
  const deactivate = await admin.put(`/api/users/${me.body.user.id}`, { active: false });
  assert.equal(deactivate.status, 400);
});
