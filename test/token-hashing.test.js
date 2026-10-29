// Reset / invitation tokens at rest (security hardening, 2026-10-28): the database holds a SHA-256 hash of each token, never the link's secret;
// expiry and single use are unchanged; the outbox and the console never carry a working link; tokens outstanding before the change keep
// working (migration 20, SQLite; migration 4 on PostgreSQL is in test/pg/pg-token-hashing.test.js). Runs on whichever driver the suite boots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');
const { hashToken, redactTokenLinks } = require('../src/tokenHash');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

const tokenOf = (link) => link.split('/#/reset/')[1];
const tokenRows = (accountId) => db.prepare('SELECT token, purpose, expires_at FROM tokens WHERE user_id = ?').all(accountId);
// Everything the database keeps as text in the two tables a link could leak into.
const storedText = () => JSON.stringify([db.prepare('SELECT * FROM tokens').all(), db.prepare('SELECT * FROM outbox').all()]);

// Records everything the app writes to the console while `fn` runs.
async function consoleDuring(fn) {
  const seen = []; const orig = {};
  for (const k of ['log', 'error', 'warn', 'info']) { orig[k] = console[k]; console[k] = (...a) => seen.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
  try { await fn(); } finally { Object.assign(console, orig); }
  return seen.join('\n');
}

async function newPerson(name, email) {
  const created = (await admin.post('/api/users', { name, email, role: 'employee', invite: false })).body;
  assert.ok(created.account_id, 'the person has a login');
  return created;
}

test('an invitation is stored as a SHA-256 hash; the link works once, the raw token and the stored value are never in the database', async () => {
  const p = await newPerson('Hash Invitee', 'hash.invitee@nutricost.com');
  let link;
  const logs = await consoleDuring(async () => {
    const r = await admin.post(`/api/users/${p.id}/invite`, {});
    assert.equal(r.status, 200);
    link = r.body.link; // (no mail transport in tests: the admin is handed the link)
  });
  const token = tokenOf(link);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, 'a 24-byte base64url token, as before');

  const [row] = tokenRows(p.account_id);
  assert.match(row.token, /^sha256:[0-9a-f]{64}$/);
  assert.equal(row.token, hashToken(token));
  assert.ok(Math.abs(Date.parse(row.expires_at) - (Date.now() + 7 * 864e5)) < 60e3, 'an invitation still lasts 7 days');
  assert.ok(!storedText().includes(token), 'the raw token is nowhere in tokens or outbox');
  assert.ok(!logs.includes(token), 'nor in the console');

  const c = makeClient(server);
  assert.equal((await c.post('/api/reset', { token: row.token, password: 'stored-value-pass-1' })).status, 400, 'the stored hash is not a usable token');
  assert.equal((await c.post('/api/reset', { token, password: 'invited-password-1' })).status, 200);
  assert.deepEqual(tokenRows(p.account_id), [], 'one use spends every token of the account');
  assert.equal((await makeClient(server).post('/api/reset', { token, password: 'second-use-pass-1' })).status, 400, 'single use');
  assert.equal((await makeClient(server).post('/api/login', { email: 'hash.invitee@nutricost.com', password: 'invited-password-1' })).status, 200);
});

test('an expired token is refused and the password does not change', async () => {
  const p = await newPerson('Hash Expired', 'hash.expired@nutricost.com');
  const token = 'expired-token-for-hash-test-1';
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(hashToken(token), p.account_id, new Date(Date.now() - 1000).toISOString());
  const r = await makeClient(server).post('/api/reset', { token, password: 'never-applied-1' });
  assert.deepEqual([r.status, r.body.error], [400, 'This link has expired. Ask for a new one.']);
  assert.equal(tokenRows(p.account_id).length, 1, 'an expired token is not consumed by a refused attempt');
});

test('a new invitation replaces the old one; the old link is dead, the new one works', async () => {
  const p = await newPerson('Hash Replace', 'hash.replace@nutricost.com');
  const first = tokenOf((await admin.post(`/api/users/${p.id}/invite`, {})).body.link);
  const second = tokenOf((await admin.post(`/api/users/${p.id}/invite`, {})).body.link);
  assert.notEqual(first, second);
  assert.equal(tokenRows(p.account_id).length, 1);
  assert.equal((await makeClient(server).post('/api/reset', { token: first, password: 'replaced-token-1' })).status, 400);
  assert.equal((await makeClient(server).post('/api/reset', { token: second, password: 'replacing-token-1' })).status, 200);
});

test('forgot-password: the stored token is a hash, the outbox keeps the email without a working link, and nothing is logged', async () => {
  const p = await newPerson('Hash Forgot', 'hash.forgot@nutricost.com');
  const logs = await consoleDuring(async () => {
    assert.equal((await makeClient(server).post('/api/forgot', { email: 'hash.forgot@nutricost.com' })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150)); // (the email is fire-and-forget; PostgreSQL writes the outbox row asynchronously)
  });
  const [row] = tokenRows(p.account_id);
  assert.equal(row.purpose, 'forgot');
  assert.match(row.token, /^sha256:[0-9a-f]{64}$/);
  const mail = db.prepare("SELECT body, to_addr FROM outbox WHERE to_addr = 'hash.forgot@nutricost.com' ORDER BY id DESC").get();
  assert.ok(mail, 'the reset email was recorded');
  assert.match(mail.body, /#\/reset\/\[redacted\]/);
  assert.doesNotMatch(mail.body, /#\/reset\/(?!\[redacted\])[A-Za-z0-9_-]/);
  assert.doesNotMatch(logs, /#\/reset\//);
});

test('redactTokenLinks removes the token from a link and leaves everything else alone', () => {
  const html = '<a href="https://it.example.test/#/reset/AbC_-123xyz">Set</a> and <a href="https://it.example.test/#/asset/7">asset</a>';
  assert.equal(redactTokenLinks(html), '<a href="https://it.example.test/#/reset/[redacted]">Set</a> and <a href="https://it.example.test/#/asset/7">asset</a>');
  assert.equal(redactTokenLinks('no links here'), 'no links here');
});

test('migration 20: outstanding tokens are hashed in place (their links keep working), outbox bodies lose their links, re-running changes nothing', () => {
  const migrations = require('../src/migrations');
  const { runMigrations } = require('../src/migrate');
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 19));
  old.prepare("INSERT INTO employees (name, work_email) VALUES ('Legacy One', 'legacy1@x.com')").run();
  old.prepare("INSERT INTO accounts (employee_id, login_email) VALUES (1, 'legacy1@x.com')").run();
  const live = new Date(Date.now() + 3600e3).toISOString();
  old.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('legacyRawToken0123456789abcdefgh', 1, 'reset', ?), ('legacyForgotToken0123456789abcdef', 1, 'forgot', ?)").run(live, live);
  old.prepare("INSERT INTO outbox (to_addr, subject, body, status) VALUES ('legacy1@x.com', 'Welcome', '<a href=\"https://it.x/#/reset/legacyRawToken0123456789abcdefgh\">Set</a>', 'sent'), ('a@x.com', 'Other', '<a href=\"https://it.x/#/asset/3\">Asset</a>', 'sent')").run();

  assert.deepEqual(runMigrations(old, migrations), [20, 21]);
  const accounts = require('../src/accounts');
  const row = accounts.getToken(old, 'legacyRawToken0123456789abcdefgh');
  assert.deepEqual([row.user_id, row.purpose, row.expires_at, row.token], [1, 'reset', live, hashToken('legacyRawToken0123456789abcdefgh')], 'the emailed link still finds its token');
  assert.equal(accounts.getToken(old, 'legacyForgotToken0123456789abcdef').purpose, 'forgot');
  assert.deepEqual(old.prepare("SELECT COUNT(*) c FROM tokens WHERE token NOT LIKE 'sha256:%'").get(), { c: 0 }, 'no raw token is left');
  assert.deepEqual(old.prepare('SELECT body FROM outbox ORDER BY id').all().map((r) => r.body),
    ['<a href="https://it.x/#/reset/[redacted]">Set</a>', '<a href="https://it.x/#/asset/3">Asset</a>']);
  accounts.completeReset(old, 1, 'hash');
  assert.equal(accounts.getToken(old, 'legacyRawToken0123456789abcdefgh'), undefined, 'a migrated token is still single use');

  old.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, 1, 'reset', ?)").run(hashToken('fresh'), live);
  require('../src/migrations').find((m) => m.id === 20).up(old); // (applying the data step again must not hash a hash)
  assert.equal(accounts.getToken(old, 'fresh').user_id, 1);
});

test('invite without email: development returns the link to the admin only; production refuses and issues nothing; employees and signed-out users get nothing', async () => {
  const p = await newPerson('Hash NoMail', 'hash.nomail@nutricost.com');
  const bystander = await newPerson('Hash Bystander', 'hash.bystander@nutricost.com');
  await admin.post(`/api/users/${bystander.id}/invite`, {});
  const bystanderToken = tokenOf((await admin.post(`/api/users/${bystander.id}/invite`, {})).body.link);
  const emp = makeClient(server);
  assert.equal((await emp.post('/api/reset', { token: bystanderToken, password: 'bystander-pass-1' })).status, 200);
  assert.equal((await emp.post(`/api/users/${p.id}/invite`, {})).status, 403, 'an employee cannot invite');
  const anon = await makeClient(server).post(`/api/users/${p.id}/invite`, {});
  assert.ok([401, 403].includes(anon.status) && !anon.body.link, 'a signed-out user gets no link');
  assert.equal(tokenRows(p.account_id).length, 0, 'refused calls issue no token');

  const dev = await admin.post(`/api/users/${p.id}/invite`, {});
  assert.match(dev.body.link, /#\/reset\//, 'local development keeps the copy-the-link fallback');

  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const q = await newPerson('Hash Prod', 'hash.prod@nutricost.com');
    const prod = await admin.post(`/api/users/${q.id}/invite`, {});
    assert.equal(prod.status, 503);
    assert.equal(prod.body.link, undefined);
    assert.ok(!JSON.stringify(prod.body).includes('#/reset/'));
    assert.equal(tokenRows(q.account_id).length, 0, 'no token is issued when it could not be sent');
  } finally { process.env.NODE_ENV = env; }
});
