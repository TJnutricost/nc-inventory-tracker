const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db;

before(async () => {
  const { app, db: _db } = bootApp();
  db = _db;
  server = await startServer(app);
});
after(() => stopServer(server));

test('setup-needed is true before any account exists', async () => {
  const c = makeClient(server);
  const r = await c.get('/api/setup-needed');
  assert.equal(r.status, 200);
  assert.equal(r.body.needed, true);
});

test('setup rejects a short password', async () => {
  const c = makeClient(server);
  const r = await c.post('/api/setup', { name: 'Ada', email: 'short@nutricost.com', password: '123' });
  assert.equal(r.status, 400);
});

test('setup creates the first admin and signs them in', async () => {
  const { client } = await setupAdmin(server);
  const me = await client.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.user.email, 'ada@nutricost.com');
});

test('setup cannot run twice', async () => {
  const c = makeClient(server);
  const r = await c.post('/api/setup', { name: 'Bob', email: 'bob@nutricost.com', password: 'another-password' });
  assert.equal(r.status, 400);
});

test('state-changing requests without the fetch marker header are rejected (CSRF guard)', async () => {
  const c = makeClient(server);
  const r = await c.rawPost('/api/login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ada@nutricost.com', password: 'correct-horse-1' }) });
  assert.equal(r.status, 403);
});

test('login fails with the wrong password', async () => {
  const c = makeClient(server);
  const r = await c.post('/api/login', { email: 'ada@nutricost.com', password: 'wrong-password' });
  assert.equal(r.status, 401);
});

test('login rate-limits repeated bad attempts', async () => {
  // Uses its own email so the lockout doesn't bleed into other tests' logins against ada@.
  const c = makeClient(server);
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/login', { email: 'rate-limit-target@nutricost.com', password: 'wrong-password' });
  assert.equal(last.status, 429);
});

test('login succeeds with the right password and /api/me reflects it', async () => {
  const c = makeClient(server);
  const r = await c.post('/api/login', { email: 'ada@nutricost.com', password: 'correct-horse-1' });
  assert.equal(r.status, 200);
  const me = await c.get('/api/me');
  assert.equal(me.body.user.email, 'ada@nutricost.com');
});

test('logout clears the session', async () => {
  const c = makeClient(server);
  await c.post('/api/login', { email: 'ada@nutricost.com', password: 'correct-horse-1' });
  await c.post('/api/logout');
  const me = await c.get('/api/me');
  assert.equal(me.status, 401);
});

test('/api/me requires auth', async () => {
  const c = makeClient(server);
  const r = await c.get('/api/me');
  assert.equal(r.status, 401);
});

test('forgot-password never reveals whether the account exists', async () => {
  const c = makeClient(server);
  const known = await c.post('/api/forgot', { email: 'ada@nutricost.com' });
  const unknown = await c.post('/api/forgot', { email: 'nobody@nutricost.com' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, unknown.body);
});

test('reset-password works with a freshly issued token and then invalidates it', async () => {
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('ada@nutricost.com');
  const crypto = require('node:crypto');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(admin.id);
  // Matches makeToken()'s own format: an ISO string, not SQLite's datetime().
  const exp = new Date(Date.now() + 3600e3).toISOString();
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(token, admin.id, exp);

  const c = makeClient(server);
  const r = await c.post('/api/reset', { token, password: 'brand-new-password' });
  assert.equal(r.status, 200);

  const reused = await c.post('/api/reset', { token, password: 'another-one-here' });
  assert.equal(reused.status, 400);

  const login = await makeClient(server).post('/api/login', { email: 'ada@nutricost.com', password: 'brand-new-password' });
  assert.equal(login.status, 200);
});

test('reset-password rejects an expired token', async () => {
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('ada@nutricost.com');
  const token = 'expired-token-123';
  const exp = new Date(Date.now() - 3600e3).toISOString();
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(token, admin.id, exp);
  const c = makeClient(server);
  const r = await c.post('/api/reset', { token, password: 'whatever-1234' });
  assert.equal(r.status, 400);
});
