// Authentication hardening before production (PROJECT_STATUS "Authentication hardening"): a new password signs the account out
// everywhere else, a reset and the first-run setup sign in on a NEW session id, and an unknown email is answered no faster than a
// wrong password (no account enumeration by timing). Runs on both drivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');
const { hashToken } = require('../src/tokenHash');

let server; let db;
const base = () => `http://127.0.0.1:${server.address().port}`;
const sid = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('nc_assets=')) || null;
// GET /api/me with a given cookie (a browser that kept an old session id)
// express-session holds back the last byte of a response until the session is saved, and fetch() resolves on the headers: read the whole
// body (`await r.text()`) before using a new cookie, or the next request can overtake the (asynchronous, PostgreSQL) session write.
const meWith = async (cookie) => (await fetch(base() + '/api/me', { headers: { Cookie: cookie } })).status;
const signIn = async (email, password) => {
  const c = makeClient(server);
  const r = await c.post('/api/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { c, cookie: sid(r) };
};

before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
});
after(() => stopServer(server));

test('setup signs the first admin in on a session id the browser did not choose', async () => {
  const pre = 'nc_assets=s%3Aattacker-chosen.sig';
  const r = await fetch(base() + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: pre },
    body: JSON.stringify({ name: 'Ada Admin', email: 'ada@nutricost.com', password: 'correct-horse-1' }) });
  assert.equal(r.status, 200);
  await r.text();
  const got = sid(r);
  assert.ok(got && got !== pre);
  assert.equal(await meWith(got), 200);
});

test('a password change signs out every other session of the account; this browser stays in on a new id', async () => {
  const phone = await signIn('ada@nutricost.com', 'correct-horse-1');
  const laptop = await signIn('ada@nutricost.com', 'correct-horse-1');
  assert.equal(await meWith(phone.cookie), 200);
  const r = await laptop.c.post('/api/me/password', { current: 'correct-horse-1', password: 'second-horse-2' });
  assert.equal(r.status, 200);
  assert.ok(sid(r) && sid(r) !== laptop.cookie, 'a new session id');
  assert.equal((await laptop.c.get('/api/me')).status, 200, 'the browser that changed it stays signed in');
  assert.equal(await meWith(laptop.cookie), 401, 'its old session id is gone');
  assert.equal(await meWith(phone.cookie), 401, 'the other device is signed out');
  // a wrong current password changes nothing and signs nobody out
  const again = await signIn('ada@nutricost.com', 'second-horse-2');
  assert.equal((await laptop.c.post('/api/me/password', { current: 'nope-nope-1', password: 'third-horse-3' })).status, 400);
  assert.equal(await meWith(again.cookie), 200);
});

test('a reset signs in on a new session id and signs out every other session of the account', async () => {
  const other = await signIn('ada@nutricost.com', 'second-horse-2');
  const admin = db.prepare('SELECT id FROM accounts WHERE login_email = ?').get('ada@nutricost.com');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(hashToken(token), admin.id, new Date(Date.now() + 3600e3).toISOString());
  const pre = 'nc_assets=s%3Aattacker-chosen.sig';
  const r = await fetch(base() + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: pre },
    body: JSON.stringify({ token, password: 'reset-horse-4' }) });
  assert.equal(r.status, 200);
  await r.text();
  assert.ok(sid(r) && sid(r) !== pre);
  assert.equal(await meWith(sid(r)), 200, 'signed in by the reset');
  assert.equal(await meWith(other.cookie), 401, 'the other session is signed out');
});

test('an unknown email is not answered measurably faster than a wrong password', async () => {
  const time = async (email) => {
    const t = process.hrtime.bigint();
    const r = await makeClient(server).post('/api/login', { email, password: 'wrong-password-9' });
    assert.equal(r.status, 401);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const known = []; const unknown = [];
  for (let i = 0; i < 5; i++) { known.push(await time('ada@nutricost.com')); unknown.push(await time(`nobody${i}@nutricost.com`)); }
  // both run one bcrypt compare (cost 10, tens of ms); before the fix an unknown email took about a millisecond
  assert.ok(median(unknown) > median(known) * 0.5, `unknown ${median(unknown).toFixed(1)} ms vs wrong password ${median(known).toFixed(1)} ms`);
});
