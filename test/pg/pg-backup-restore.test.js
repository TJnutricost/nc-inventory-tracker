// PostgreSQL Slice 6C: backup (scripts/pg-backup.js) and restore (scripts/pg-restore.js), on local throwaway databases. The source is
// test-support/slice6-fixture.js copied with scripts/pg-copy.js. The round trip is proven three ways: the restored database verifies
// row by row against the SQLite source, its sequences continue, and the REAL app (`node src/server.js`, DB_DRIVER=pg) boots on it and
// signs the seeded admin in. Needs PostgreSQL and pg_dump/pg_restore 18 (local, or the postgres:18 Docker image); skipped otherwise.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createFixture, ADMIN_EMAIL, DEV_PASSWORD } = require('../../test-support/slice6-fixture');
const { copy } = require('../../scripts/pg-copy');
const { verify } = require('../../scripts/pg-verify');
const { backup, pgTool } = require('../../scripts/pg-backup');
const { restore } = require('../../scripts/pg-restore');

const ROOT = path.join(__dirname, '..', '..');

// pgSuite, plus a skip when no pg_dump 18 can be run (neither on PATH nor through Docker).
function suiteOptions() {
  const base = pgSuite();
  if (base.skip) return base;
  try {
    pgTool('pg_dump', 'postgresql://u:p@127.0.0.1:5433/x');
    return base;
  } catch (err) {
    if (process.env.NC_REQUIRE_PG === '1') throw err;
    return { skip: `backup/restore tests skipped: ${err.message}` };
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Boots `node src/server.js` on DB_DRIVER=pg against `url` (as test/pg/pg-boot.test.js); resolves once it listens.
async function startApp(url, dataDir) {
  const port = await freePort();
  const env = {
    ...process.env, DB_DRIVER: 'pg', DATABASE_URL: url, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test',
    NC_NO_EXTERNAL_MAIL: '1', SESSION_SECRET: 'pg-restore-test-secret', APP_URL: 'http://localhost',
  };
  for (const k of ['SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'MAIL_TEST_RECIPIENT']) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (/running on http:\/\/localhost:\d+/.test(out)) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`the app exited (${code}) before listening:\n${out}`)));
  });
  return { child, port, output: () => out };
}

async function stopApp(app) {
  if (app.child.exitCode !== null) return;
  const exited = new Promise((r) => app.child.on('exit', r));
  app.child.kill('SIGTERM');
  await exited;
}

describe('Slice 6C: PostgreSQL backup and restore', suiteOptions(), () => {
  const dbs = [];
  let fixture;
  let sqlite;
  let source;
  let dump;
  const fresh = async (opts) => { const d = await createTestDatabase(opts); dbs.push(d); return d; };

  before(async () => {
    fixture = createFixture();
    sqlite = fixture.source();
    source = await fresh();
    await copy(sqlite, source.pool);
    dump = path.join(fixture.dir, 'backup.dump');
    await backup(source.url, dump);
  });
  after(async () => {
    await Promise.all(dbs.map((d) => d.drop()));
    if (fixture) fixture.cleanup();
  });

  test('the backup is one non-empty file and leaves no partial file behind', () => {
    assert.ok(fs.statSync(dump).size > 0);
    assert.equal(fs.existsSync(`${dump}.partial`), false);
  });

  test('restore into an empty database: identical to the SQLite source, sequences continue, sessions stay empty', async () => {
    const target = await fresh({ migrate: false });
    const { tables } = await restore(dump, target.url);
    assert.equal(tables.length, 16);
    const result = await verify(sqlite, target.pool);
    assert.deepEqual(result.differences, []);
    const emp = await target.pool.query("INSERT INTO employees (name, status) VALUES ('After restore', 'active') RETURNING id");
    assert.equal(emp.rows[0].id, 5001);
  });

  test('the app boots on the restored database and signs the seeded admin in', async () => {
    const target = await fresh({ migrate: false });
    await restore(dump, target.url);
    const dataDir = fs.mkdtempSync(path.join(fixture.dir, 'app-'));
    const app = await startApp(target.url, dataDir);
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: DEV_PASSWORD }),
      });
      assert.equal(login.status, 200, await login.clone().text());
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const res = await fetch(`${base}/api/assets`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const assets = await res.json();
      const list = Array.isArray(assets) ? assets : assets.assets;
      const expected = sqlite.prepare('SELECT tag FROM assets WHERE id = 2').get().tag;
      assert.ok(list.some((a) => a.tag === expected), `asset ${expected} is listed`);
      assert.equal(fs.existsSync(path.join(dataDir, 'assets.db')), false, 'SQLite is never opened');
    } finally {
      await stopApp(app);
    }
  });

  test('refuses a target that already has tables; nothing changes', async () => {
    const target = await fresh();
    await assert.rejects(() => restore(dump, target.url), /not empty/);
    assert.equal(Number((await target.pool.query('SELECT COUNT(*) AS n FROM employees')).rows[0].n), 0);
  });

  test('a damaged backup is refused before the target is touched', async () => {
    const target = await fresh({ migrate: false });
    const broken = path.join(fixture.dir, 'broken.dump');
    const bytes = fs.readFileSync(dump);
    fs.writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 3)));
    await assert.rejects(() => restore(broken, target.url));
    const { rows } = await target.pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()");
    assert.equal(Number(rows[0].n), 0);
  });

  test('a backup that fails leaves no file', async () => {
    const out = path.join(fixture.dir, 'never.dump');
    await assert.rejects(() => backup('postgresql://nc_dev:nc_dev@127.0.0.1:5433/nc_test_does_not_exist', out));
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(`${out}.partial`), false);
  });
});
