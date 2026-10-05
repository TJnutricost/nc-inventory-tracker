// Shared test harness: boots the real Express app against a throwaway SQLite DB
// (temp DATA_DIR) so tests never touch the real data/ directory, and gives each
// test a tiny cookie-aware HTTP client to exercise the API like the front end does.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

function bootApp() {
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

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
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

module.exports = { bootApp, startServer, stopServer, makeClient, setupAdmin };
