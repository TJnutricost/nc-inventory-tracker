// PostgreSQL migration Slice 5D-1: the app booted on DB_DRIVER=pg. Runs the REAL `node src/server.js` in a child process against a
// fresh, UNMIGRATED per-file test database (test-support/pg-harness.js; local only, never DATABASE_URL from the environment) and checks
// the runtime wiring end to end over HTTP: boot migrates the schema before listening, sessions live in PostgreSQL (and survive a
// restart), the PostgreSQL mailer writes the outbox, the effects notifier is installed (a reservation's after-commit email), the
// 5A lock timeout reaches the client as a 503, SIGTERM ends the process cleanly, a second boot applies nothing, and a boot that cannot
// reach the database exits 1 without listening. SQLite is never opened (no assets.db in the data directory). No email leaves:
// NC_NO_EXTERNAL_MAIL=1 and no SMTP settings.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');

const ROOT = path.join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Starts `node src/server.js`; resolves once it prints its banner (or rejects with its output when it exits first).
function startApp({ url, dataDir, port }) {
  const env = {
    ...process.env, DB_DRIVER: 'pg', DATABASE_URL: url, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test',
    NC_NO_EXTERNAL_MAIL: '1', SESSION_SECRET: 'pg-boot-test-secret', APP_URL: 'http://localhost',
  };
  for (const k of ['SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'MAIL_TEST_RECIPIENT']) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, out })));
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => { out += d; if (/running on http:\/\/localhost:\d+/.test(out)) resolve(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    exited.then(({ code }) => reject(new Error(`the app exited (${code}) before listening:\n${out}`)));
  });
  return { child, ready, exited, port, output: () => out };
}

// A cookie-aware JSON client (as test/helpers.js makeClient) that talks to whichever app process `target()` names, so one signed-in
// client can be pointed at the restarted process.
function client(target) {
  let cookie = '';
  async function req(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`http://127.0.0.1:${target().port}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (u) => req('GET', u), post: (u, b) => req('POST', u, b), put: (u, b) => req('PUT', u, b) };
}

async function stopApp(app) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return app.exited;
  app.child.kill('SIGTERM');
  return app.exited;
}

// Waits (up to `ms`) for an async condition; returns its last value.
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  let v;
  while (!(v = await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return v;
}

describe('Slice 5D-1: the app on DB_DRIVER=pg', pgSuite(), () => {
  let tdb, dataDir, app, admin;
  before(async () => {
    tdb = await createTestDatabase({ migrate: false });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pg-boot-'));
    app = startApp({ url: tdb.url, dataDir, port: await freePort() });
    await app.ready;
    admin = client(() => app);
  });
  after(async () => {
    if (app) await stopApp(app);
    await tdb?.drop();
  });

  test('boot migrates the empty database before listening; SQLite is never opened', async () => {
    const { rows } = await tdb.pool.query('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4]);
    assert.match(app.output(), /PostgreSQL: applied schema migration\(s\) 1, 2/);
    assert.match(app.output(), /database: PostgreSQL/);
    assert.equal(fs.existsSync(path.join(dataDir, 'assets.db')), false, 'no SQLite database file');
    assert.equal((await admin.get('/health')).status, 200);
  });

  test('setup and sign-in work, and the session is stored in PostgreSQL', async () => {
    assert.deepEqual((await admin.get('/api/setup-needed')).body, { needed: true, rule: 'open' });
    const r = await admin.post('/api/setup', { name: 'Ada Admin', email: 'ada@nutricost.com', password: 'correct-horse-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const me = await admin.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'admin');
    const { rows } = await tdb.pool.query('SELECT count(*)::int AS n FROM sessions');
    assert.ok(rows[0].n >= 1, 'a session row exists in PostgreSQL');
  });

  test('the PostgreSQL mailer records the outbox (an invite) and /api/settings answers its envelope', async () => {
    const before = (await tdb.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n;
    const r = await admin.post('/api/users', { name: 'Eve Employee', email: 'eve@nutricost.com', invite: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = await until(async () => {
      const q = await tdb.pool.query('SELECT to_addr, status FROM outbox ORDER BY id');
      return q.rows.length > before && q.rows;
    });
    assert.ok(rows, 'an outbox row was written');
    assert.deepEqual(rows.at(-1), { to_addr: 'eve@nutricost.com', status: 'logged' });
    const s = await admin.get('/api/settings');
    assert.equal(s.status, 200);
    assert.equal(typeof s.body.mailEnvelope, 'object', 'the envelope promise is resolved, not serialized as {}');
    assert.ok(s.body.mailEnvelope && s.body.mailEnvelope.from, JSON.stringify(s.body.mailEnvelope));
  });

  test('the effects notifier is installed: a reservation sends its after-commit email', async () => {
    const asset = await admin.post('/api/assets', { name: 'Boot Camera', tag: 'BOOT-1', available_to_request: true });
    assert.equal(asset.status, 200, JSON.stringify(asset.body));
    const adaRows = async () => (await tdb.pool.query('SELECT subject FROM outbox WHERE to_addr = $1 ORDER BY id', ['ada@nutricost.com'])).rows;
    const before = (await adaRows()).length;
    const r = await admin.post(`/api/assets/${asset.body.id}/reservations`, { start_date: plus(3), end_date: plus(4) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reserved.length, 1);
    const rows = await until(async () => { const q = await adaRows(); return q.length > before && q; });
    assert.ok(rows, 'the request_recorded email reached the outbox (the notifier is installed)');
    assert.match(rows.at(-1).subject, /Boot Camera/);
  });

  test('a held asset lock reaches the client as the 5A 503 (ASSET_BUSY), not a 500', async () => {
    const asset = (await admin.post('/api/assets', { name: 'Locked Laptop', tag: 'BOOT-2' })).body;
    const holder = await tdb.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [asset.id]);
      const r = await admin.put(`/api/assets/${asset.id}`, { ...asset, name: 'Locked Laptop 2' });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.match(r.body.error, /\S/);
      assert.doesNotMatch(r.body.error, /Something went wrong/);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  test('SIGTERM shuts down cleanly (exit 0); a second boot applies nothing and keeps the PostgreSQL session', async () => {
    const first = await stopApp(app);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /SIGTERM: shutting down/);
    const port = await freePort();
    app = startApp({ url: tdb.url, dataDir, port });
    await app.ready;
    assert.doesNotMatch(app.output(), /applied schema migration/);
    // the same cookie, against the restarted process (a new port): the session came from PostgreSQL
    assert.equal((await client(() => app).get('/api/me')).status, 401, 'a new client has no session');
    const me = await admin.get('/api/me');
    assert.equal(me.status, 200, 'the signed-in session survived the restart');
    assert.equal(me.body.user.email, 'ada@nutricost.com');
  });

  // A request in flight when SIGTERM arrives finishes on the pool before it is ended: the PUT waits on an asset lock held here, the
  // signal arrives, then the lock is released; the PUT must still answer 200 with its write committed, new connections are refused,
  // and the process exits 0 only afterwards.
  test('SIGTERM lets an in-flight request finish before the pool is closed', async () => {
    const asset = (await admin.post('/api/assets', { name: 'Drain Dock', tag: 'BOOT-3' })).body;
    const holder = await tdb.pool.connect();
    let put;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [asset.id]);
      put = admin.put(`/api/assets/${asset.id}`, { ...asset, name: 'Drain Dock 2' });
      await until(async () => (await tdb.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n > 0);
      app.child.kill('SIGTERM');
      await until(async () => /SIGTERM: shutting down/.test(app.output()));
      await assert.rejects(client(() => app).get('/health'), 'a new connection is refused while draining');
      assert.equal(app.child.exitCode, null, 'the process waits for the request in flight');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    const r = await put;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'Drain Dock 2');
    const { code, out } = await app.exited;
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /\[shutdown\]|Cannot use a pool after calling end/);
    assert.equal((await tdb.pool.query('SELECT name FROM assets WHERE id = $1', [asset.id])).rows[0].name, 'Drain Dock 2');
  });

  test('a boot that cannot reach PostgreSQL exits 1 without listening', async () => {
    const bad = startApp({ url: 'postgres://nobody:nothing@127.0.0.1:1/none', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pg-boot-bad-')), port: await freePort() });
    await assert.rejects(bad.ready, /exited \(1\) before listening/);
    const { code, out } = await bad.exited;
    assert.equal(code, 1);
    assert.match(out, /Startup failed:/);
  });
});
