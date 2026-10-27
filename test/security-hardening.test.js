// Security review 2026-10-27 (PROJECT_STATUS "Security review"): security headers, the first-run setup on a fresh production server,
// forgot-password limits that never cancel an invite, a per-IP cap on failed logins, and photo uploads limited to photo formats.
// Runs on both drivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient } = require('./helpers');

let server; let db;
const env = (vars, fn) => async () => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const SETUP = { name: 'Ada Admin', email: 'ada@nutricost.com', password: 'correct-horse-1' };

before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
});
after(() => stopServer(server));

test('every response carries the Content-Security-Policy (no inline script) and the other security headers', async () => {
  for (const url of ['/', '/api/setup-needed', '/app.js']) {
    const h = (await makeClient(server).get(url)).headers;
    assert.match(h.get('content-security-policy'), /script-src 'self';/, url);
    assert.doesNotMatch(h.get('content-security-policy'), /script-src[^;]*unsafe/, url);
    assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(h.get('strict-transport-security'), null, 'no HSTS when APP_URL is plain http (tests)');
  }
  const fs = require('fs'); const path = require('path');
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.doesNotMatch(pub('app.js'), /\son(click|load|error|change|input|submit)="/, 'no inline event handlers in rendered HTML');
  assert.doesNotMatch(pub('index.html'), /<script(?![^>]*\bsrc=)/, 'no inline <script> in index.html');
});

test('first-run setup: closed in production without SETUP_TOKEN; with it, only the right code works', async () => {
  const c = makeClient(server);
  await env({ NODE_ENV: 'production' }, async () => {
    assert.deepEqual((await c.get('/api/setup-needed')).body, { needed: true, rule: 'closed' });
    assert.equal((await c.post('/api/setup', SETUP)).status, 403);
  })();
  await env({ SETUP_TOKEN: 'open-sesame-2026' }, async () => {
    assert.equal((await c.get('/api/setup-needed')).body.rule, 'code');
    assert.equal((await c.post('/api/setup', SETUP)).status, 403);
    assert.equal((await c.post('/api/setup', { ...SETUP, setup_code: 'wrong' })).status, 403);
    assert.equal((await c.post('/api/setup', { ...SETUP, setup_code: 'open-sesame-2026' })).status, 200);
  })();
  assert.deepEqual((await c.get('/api/setup-needed')).body, { needed: false });
  assert.equal((await c.get('/api/me')).status, 200);
});

test('forgot-password never cancels a pending invite, sends at most 3 links per address, and caps requests per IP', async () => {
  const admin = makeClient(server);
  assert.equal((await admin.post('/api/login', { email: SETUP.email, password: SETUP.password })).status, 200);
  const p = await admin.post('/api/users', { name: 'New Hire', email: 'new.hire@nutricost.com', invite: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const tokens = () => db.prepare('SELECT purpose FROM tokens WHERE user_id = ? ORDER BY purpose').all(p.body.account_id).map((t) => t.purpose);
  assert.deepEqual(tokens(), ['reset'], 'the invite');
  const anon = makeClient(server);
  for (let i = 0; i < 5; i++) assert.deepEqual((await anon.post('/api/forgot', { email: 'new.hire@nutricost.com' })).body, { ok: true });
  assert.deepEqual(tokens(), ['forgot', 'reset'], 'the invite link still works beside the forgot link');
  const sent = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE to_addr = ? AND subject LIKE '%password%'").get('new.hire@nutricost.com').n;
  assert.equal(sent, 3, 'only 3 reset emails for one address in 15 minutes');
  let status = 200;
  for (let i = 0; i < 20 && status === 200; i++) status = (await anon.post('/api/forgot', { email: `someone${i}@nutricost.com` })).status;
  assert.equal(status, 429, 'the IP is capped');
});

test('photo uploads accept photo formats only (an SVG is refused, a PNG is kept)', async () => {
  const admin = makeClient(server);
  assert.equal((await admin.post('/api/login', { email: SETUP.email, password: SETUP.password })).status, 200);
  const asset = (await admin.post('/api/assets', { name: 'Photo test', category: 'Other' })).body;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const post = (buf, type, name) => { const fd = new FormData(); fd.append('photos', new Blob([buf], { type }), name); return admin.rawPost(`/api/assets/${asset.id}/photos`, { headers: { 'X-Requested-With': 'fetch' }, body: fd }); };
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM photos WHERE asset_id = ?').get(asset.id).n;
  assert.equal((await post(SVG, 'image/svg+xml', 'x.svg')).status, 400);
  assert.equal(count(), 0);
  assert.equal((await post(PNG, 'image/png', 'a.png')).status, 200);
  assert.equal(count(), 1);
});

test('failed logins are capped per IP across all emails (no password spraying)', async () => {
  const c = makeClient(server);
  let last;
  for (let i = 0; i < 100; i++) {
    last = await c.post('/api/login', { email: `spray${i}@nutricost.com`, password: 'Summer2026!' });
    assert.equal(last.status, 401, `attempt ${i}`);
  }
  assert.equal((await c.post('/api/login', { email: 'spray-next@nutricost.com', password: 'Summer2026!' })).status, 429);
});
