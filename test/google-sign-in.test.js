// Google sign-in (docs/briefs/google-sign-in.md): the real app, with Google's token endpoint replaced by a local fake that issues ID
// tokens (src/googleAuth.js `endpoints.token`), so no test reaches Google. Each simulated browser has its own cookie jar and its own
// client IP (X-Forwarded-For; the app trusts one proxy), so the per-IP refusal limiter of one test never reaches another.
// Runs on both drivers (npm run test:pg-suite).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { bootApp, startServer, stopServer, setupAdmin } = require('./helpers');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CALLBACK = 'http://localhost/auth/google/callback'; // APP_URL is http://localhost in the tests

let server; let db; let fake; let admin;
let respond; // (form) => { status, body }: what the fake token endpoint answers next
const exchanges = []; // every form the fake token endpoint received

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.not-checked`;

let ipSeq = 0;
// A browser: cookies kept, redirects not followed (the test reads Location), its own client IP.
function browser() {
  const ip = `10.0.0.${++ipSeq}`;
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const b = async (url, init = {}) => {
    const headers = { 'X-Forwarded-For': ip, ...(cookie && { Cookie: cookie }), ...init.headers };
    const res = await fetch(base + url, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, location: res.headers.get('location'), json };
  };
  b.cookie = () => cookie;
  b.me = async () => (await b('/api/me')).json?.user || null;
  return b;
}

// Starts a sign-in: the redirect to Google and its query.
async function begin(b) {
  const r = await b('/auth/google');
  assert.equal(r.status, 302);
  const url = new URL(r.location);
  return { url, p: Object.fromEntries(url.searchParams) };
}
// A whole round trip: Google answers with an ID token for `email` (claims overridable) and redirects back with the right state.
async function signIn(b, email, { claims = {}, query } = {}) {
  const { p } = await begin(b);
  respond = () => ({ status: 200, body: { id_token: idToken({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
    nonce: p.nonce, sub: '1', email, email_verified: true, hd: 'nutricost.com', ...claims,
  }) } });
  const r = await b(`/auth/google/callback?${new URLSearchParams(query ? query(p) : { state: p.state, code: 'the-code' })}`);
  return { r, p };
}
const refused = async (b, code, label) => {
  assert.equal(b.last.r.status, 302, label);
  assert.equal(b.last.r.location, `/#/login?error=${code}`, label);
  assert.equal(await b.me(), null, `${label}: not signed in`);
};

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      exchanges.push(form);
      const out = respond(form);
      res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  delete process.env.GOOGLE_HOSTED_DOMAIN;
  const booted = bootApp();
  db = booted.db;
  require('../src/googleAuth').endpoints.token = `http://127.0.0.1:${fake.address().port}/token`;
  server = await startServer(booted.app);
  ({ client: admin } = await setupAdmin(server)); // ada@nutricost.com, admin, work email = login email
  const person = async (body) => { const r = await admin.post('/api/users', { invite: false, ...body }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  await person({ name: 'Bea Invited', email: 'bea@nutricost.com' }); // a login, no password yet (invite pending)
  await person({ name: 'No Login', email: 'nolog@nutricost.com', login: false });
  await person({ name: 'Login Off', email: 'off@nutricost.com' });
  db.prepare("UPDATE accounts SET active = 0 WHERE login_email = 'off@nutricost.com'").run();
  const left = await person({ name: 'Left Company', email: 'left@nutricost.com' });
  assert.equal((await admin.put(`/api/users/${left.id}`, { active: false })).status, 200);
});
after(async () => {
  await stopServer(server);
  await new Promise((r) => fake.close(r));
});

test('Google sign-in is offered, and GET /auth/google sends the browser to Google with state, nonce and a PKCE S256 challenge', async () => {
  const b = browser();
  assert.deepEqual((await b('/api/auth-options')).json, { google: true });
  const { url, p } = await begin(b);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.client_id, CLIENT_ID);
  assert.equal(p.redirect_uri, CALLBACK);
  assert.deepEqual([p.response_type, p.scope, p.code_challenge_method, p.hd, p.prompt], ['code', 'openid email', 'S256', 'nutricost.com', 'select_account']);
  assert.ok(p.state.length >= 40 && p.nonce.length >= 40 && p.state !== p.nonce);
  assert.ok(b.cookie(), 'the pending sign-in is kept in a session');
});

test('a registered employee with a login signs in (even before setting a password): new session id, same session as a password login', async () => {
  const b = browser();
  const { p } = await begin(b);
  const before_ = b.cookie();
  exchanges.length = 0;
  b.last = await signIn(b, 'bea@nutricost.com');
  assert.equal(b.last.r.status, 302);
  assert.equal(b.last.r.location, '/#/home');
  assert.notEqual(b.cookie(), before_, 'the session id is regenerated at sign-in');
  const me = await b.me();
  assert.deepEqual([me.email, me.role, me.name, me.has_password], ['bea@nutricost.com', 'employee', 'Bea Invited', false]);
  assert.ok(me.last_login_at, 'the login is recorded');
  // what the app sent to Google's token endpoint
  const [form] = exchanges;
  assert.deepEqual([form.code, form.client_id, form.client_secret, form.redirect_uri, form.grant_type],
    ['the-code', CLIENT_ID, 'test-secret', CALLBACK, 'authorization_code']);
  assert.equal(crypto.createHash('sha256').update(form.code_verifier).digest('base64url'), b.last.p.code_challenge, 'the PKCE verifier matches its challenge');
  assert.notEqual(b.last.p.state, p.state, 'each sign-in has its own state');
});

test('the Google email is matched trimmed and case-insensitively; an admin keeps the admin role', async () => {
  const b = browser();
  b.last = await signIn(b, ' Bea@Nutricost.COM ');
  assert.equal((await b.me()).email, 'bea@nutricost.com');
  const a = browser();
  a.last = await signIn(a, 'ada@nutricost.com');
  assert.equal((await a.me()).role, 'admin');
});

test('nobody is signed in or created for an unknown email, a person without a login, a disabled login or a person who left', async () => {
  const before_ = db.prepare('SELECT (SELECT COUNT(*) FROM employees) AS e, (SELECT COUNT(*) FROM accounts) AS a').get();
  for (const email of ['stranger@nutricost.com', 'nolog@nutricost.com', 'off@nutricost.com', 'left@nutricost.com']) {
    const b = browser();
    b.last = await signIn(b, email);
    await refused(b, 'not_registered', email);
  }
  assert.deepEqual(db.prepare('SELECT (SELECT COUNT(*) FROM employees) AS e, (SELECT COUNT(*) FROM accounts) AS a').get(), before_);
});

test('ID tokens that fail a check are refused: domain, unverified email, issuer, audience, expiry, nonce', async () => {
  const cases = [
    ['domain', { hd: 'evil.com' }, 'another Workspace'],
    ['domain', { hd: undefined }, 'a personal Google account (no hd)'],
    ['domain', { email: 'bea@gmail.com' }, 'hd right but the email elsewhere'],
    ['unverified', { email_verified: false }, 'unverified email'],
    ['token', { iss: 'https://evil.example' }, 'issuer'],
    ['token', { aud: 'someone-else.apps.googleusercontent.com' }, 'audience'],
    ['token', { aud: [CLIENT_ID, 'other'], azp: 'other' }, 'several audiences, not authorized for us'],
    ['token', { exp: Math.floor(Date.now() / 1000) - 1 }, 'expired'],
    ['token', { nonce: 'not-the-nonce' }, 'nonce'],
  ];
  for (const [code, claims, label] of cases) {
    const b = browser();
    b.last = await signIn(b, 'bea@nutricost.com', { claims });
    await refused(b, code, label);
  }
});

test('Google errors, a cancelled sign-in and a broken token are refused without signing in', async () => {
  const b = browser();
  const { p } = await begin(b);
  respond = () => ({ status: 400, body: { error: 'invalid_grant' } });
  b.last = { r: await b(`/auth/google/callback?state=${p.state}&code=bad`) };
  await refused(b, 'google', 'token endpoint error');

  const c = browser();
  const { p: q } = await begin(c);
  respond = () => ({ status: 200, body: { id_token: 'not-a-jwt' } });
  c.last = { r: await c(`/auth/google/callback?state=${q.state}&code=x`) };
  await refused(c, 'token', 'malformed ID token');

  const d = browser();
  d.last = await signIn(d, 'bea@nutricost.com', { query: (x) => ({ state: x.state, error: 'access_denied' }) });
  await refused(d, 'cancelled', 'the person pressed cancel at Google');
});

test('state: a wrong one, none started, or a replayed callback is refused (single use)', async () => {
  const b = browser();
  b.last = await signIn(b, 'bea@nutricost.com', { query: () => ({ state: 'forged', code: 'x' }) });
  await refused(b, 'state', 'forged state');

  const c = browser();
  c.last = { r: await c('/auth/google/callback?state=anything&code=x') };
  await refused(c, 'state', 'no sign-in started in this browser');

  const d = browser();
  const ok = await signIn(d, 'bea@nutricost.com');
  assert.equal(ok.r.location, '/#/home');
  await d('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } });
  d.last = { r: await d(`/auth/google/callback?state=${ok.p.state}&code=the-code`) };
  await refused(d, 'state', 'the same callback again');
});

test('refusals are rate-limited per IP (10, then 15 minutes); a success resets the count', async () => {
  const b = browser();
  for (let i = 0; i < 10; i++) { b.last = await signIn(b, 'stranger@nutricost.com'); await refused(b, 'not_registered', `refusal ${i + 1}`); }
  b.last = await signIn(b, 'bea@nutricost.com');
  await refused(b, 'too_many', 'the 11th try, even a good one');
  const c = browser();
  for (let i = 0; i < 9; i++) c.last = await signIn(c, 'stranger@nutricost.com');
  c.last = await signIn(c, 'bea@nutricost.com');
  assert.equal(c.last.r.location, '/#/home');
  await c('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } });
  c.last = await signIn(c, 'stranger@nutricost.com');
  await refused(c, 'not_registered', 'counting starts again after a success');
});

test('the password login still works beside Google', async () => {
  const b = browser();
  const r = await b('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ email: 'ada@nutricost.com', password: 'correct-horse-1' }) });
  assert.equal(r.status, 200);
  assert.equal((await b.me()).email, 'ada@nutricost.com');
});

test('a sign-in that took longer than 10 minutes at Google is refused (unit: src/googleAuth.js finish)', async () => {
  const g = require('../src/googleAuth');
  const cfg = g.config({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 's' });
  const { pending } = g.start(cfg, CALLBACK, 0);
  await assert.rejects(g.finish(cfg, { pending, query: { state: pending.state, code: 'x' }, redirectUri: CALLBACK, now: 10 * 60e3 + 1 }), (e) => e.signInCode === 'state');
  assert.equal(g.config({ GOOGLE_CLIENT_ID: CLIENT_ID }), null, 'off without the secret');
  assert.equal(g.config({ GOOGLE_CLIENT_ID: ' ', GOOGLE_CLIENT_SECRET: 's' }), null, 'off with a blank id');
  assert.equal(g.config({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_HOSTED_DOMAIN: ' Example.COM ' }).domain, 'example.com');
});
