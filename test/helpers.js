// Shared test harness: boots the real Express app against a throwaway SQLite DB
// (temp DATA_DIR) so tests never touch the real data/ directory, and gives each
// test a tiny cookie-aware HTTP client to exercise the API like the front end does.
//
// Driver-aware (Slice 5D-2): NC_TEST_DRIVER=pg boots the same app on DB_DRIVER=pg against a fresh local nc_test_<hex> database (created
// here, migrated by app.boot(), dropped by stopServer or at exit; never DATABASE_URL from the environment). `db` is then a synchronous
// better-sqlite3-shaped handle over that database (test-support/pg-sync.js), so tests that seed or read tables directly run unchanged.
// `isPg` tells a test which engine it is on (SQLite-only tests skip themselves with it). `npm run test:pg-suite` runs the suite this way.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const isPg = process.env.NC_TEST_DRIVER === 'pg';
const pgBooted = new Map(); // app -> { url, name, db, stop }

function pgDatabase() {
  const crypto = require('crypto');
  const { serverUrl, testDatabaseUrl, assertTestDatabaseName } = require('../test-support/pg-harness');
  const { createSyncSql, createSqliteLikeDb } = require('../test-support/pg-sync');
  const name = assertTestDatabaseName(`nc_test_${crypto.randomBytes(8).toString('hex')}`);
  const admin = createSyncSql(serverUrl());
  admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const url = testDatabaseUrl(serverUrl(), name);
  const entry = { name, url, db: null, admin, dropped: false };
  entry.drop = () => {
    if (entry.dropped) return;
    entry.dropped = true;
    try { entry.db && entry.db.close(); } catch { /* gone */ }
    try { admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } catch { /* best effort */ }
    admin.close();
  };
  process.on('exit', entry.drop);
  entry.makeDb = () => { entry.db = createSqliteLikeDb(url); return entry.db; };
  return entry;
}

function bootApp() {
  if (isPg) return bootAppPg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-assets-test-'));
  process.env.NC_NO_EXTERNAL_MAIL = '1'; // tests never read a developer's .env and never create a real SMTP transport (a test may inject a fake one)
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = 'test-secret-not-for-production';
  process.env.APP_URL = 'http://localhost';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  for (const mod of ['../src/db', '../src/mailer', '../src/server']) delete require.cache[require.resolve(mod)];
  const app = require('../src/server');
  const { db } = require('../src/db');
  return { app, db, dir };
}

function bootAppPg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-assets-test-'));
  const entry = pgDatabase();
  process.env.NC_NO_EXTERNAL_MAIL = '1';
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = 'test-secret-not-for-production';
  process.env.APP_URL = 'http://localhost';
  process.env.DB_DRIVER = 'pg';
  process.env.DATABASE_URL = entry.url;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  const src = path.join(__dirname, '..', 'src') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(src)) delete require.cache[k]; // a fresh pool, seam and server per boot
  const app = require('../src/server');
  pgBooted.set(app, entry);
  return { app, db: entry.makeDb(), dir };
}

async function startServer(app) {
  const entry = pgBooted.get(app);
  if (entry) entry.stop = (await app.boot()).stop; // PostgreSQL: migrate, install the notifier, start the sweep (before the first request)
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { server.ncApp = app; resolve(server); });
  });
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
  const entry = server.ncApp && pgBooted.get(server.ncApp);
  if (entry) {
    if (entry.stop) await entry.stop().catch(() => {});
    entry.drop();
  }
}

// Minimal cookie-jar fetch client. State-changing requests get the
// X-Requested-With header the app requires as a CSRF guard.
function makeClient(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function req(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(base + url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const sc of setCookie) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON (e.g. CSV/HTML) */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    get: (url) => req('GET', url),
    post: (url, body) => req('POST', url, body),
    put: (url, body) => req('PUT', url, body),
    del: (url) => req('DELETE', url),
    rawPost: async (url, { headers = {}, body }) => {
      const h = { ...headers };
      if (cookie) h['Cookie'] = cookie;
      const res = await fetch(base + url, { method: 'POST', headers: h, body });
      const text = await res.text();
      let json = text;
      try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
      return { status: res.status, body: json, text };
    },
  };
}

// Convenience: create the first admin via /api/setup and return a logged-in client.
async function setupAdmin(server, overrides = {}) {
  const c = makeClient(server);
  const admin = { name: 'Ada Admin', email: 'ada@nutricost.com', password: 'correct-horse-1', ...overrides };
  const r = await c.post('/api/setup', admin);
  if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
  return { client: c, admin };
}

// POST /api/assets/:id/reservations answers { request_group, requested, reserved: [...], waitlisted: [...] }: one request can become reservation(s) for the free
// time AND waitlist entries for the unavailable time. Most tests only want "the reservation", so this lets them keep treating the answer as the FIRST
// reservation (its fields at the top) with the whole answer under `.group`. A refusal passes through untouched.
const asReservation = (res) => (res.status === 200 && res.body && res.body.reserved ? { ...res, body: { ...res.body.reserved[0], group: res.body } } : res);

// For tests that exercise SQLite itself (its modules called with the better-sqlite3 handle, its triggers, files, error text): `test(name, { skip: skipOnPg }, fn)`.
const skipOnPg = isPg ? 'SQLite-specific: the PostgreSQL twin of this behaviour is covered by test/pg' : false;

module.exports = { isPg, skipOnPg, bootApp, startServer, stopServer, makeClient, setupAdmin, asReservation };
