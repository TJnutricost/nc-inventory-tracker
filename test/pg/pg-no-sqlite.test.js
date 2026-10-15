// D-46 / D-47 (Slice 4A): src/pg/* must never load SQLite. src/reservations.js and src/waitlist.js require their mailer lazily,
// and the mailer requires src/db.js, which opens SQLite and creates the data directory on load; the PG modules import only the
// pure exports of those files. This loads every src/pg/*.js module in a FRESH child process (a clean require.cache) and checks
// that src/db.js, src/mailer.js and better-sqlite3 were never loaded and that no data directory was created. Slice 4B: this
// covers the reservation/waitlist write paths and src/pg/effects.js (notifications are injected, never imported). Slice 5A: the
// PG mailer, notifier and sweep scheduler, and the shared mail core they load (src/mailCore.js), never load SQLite either, and
// the mail core loads nodemailer only when it builds a transport.
// Needs no database, so it runs under plain `npm test` too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

test('every src/pg module loads without SQLite, the mailer or a data directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pg-load-'));
  const dataDir = path.join(scratch, 'data-must-not-exist');
  try {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'test-support', 'pg-load-probe.js')], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000, env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(res.status, 0, res.stderr);
    const { loaded, cache } = JSON.parse(res.stdout);
    for (const m of ['availability.js', 'reservations.js', 'waitlist.js', 'effects.js', 'transaction.js', 'time.js', 'catalog.js', 'assignments.js', 'requests.js', 'settings.js', 'mailer.js', 'notifier.js', 'sweep.js']) {
      assert.ok(loaded.includes(m), `src/pg/${m} was loaded`);
    }
    const rel = cache.map((k) => path.relative(ROOT, k).split(path.sep).join('/'));
    assert.ok(!rel.includes('src/db.js'), 'src/db.js is not loaded');
    assert.ok(!rel.includes('src/mailer.js'), 'src/mailer.js is not loaded');
    assert.ok(!rel.some((k) => k.includes('node_modules/better-sqlite3/')), 'better-sqlite3 is not loaded');
    assert.ok(!rel.some((k) => k.includes('node_modules/nodemailer/')), 'no mail transport is loaded');
    assert.ok(rel.includes('src/reservations.js') && rel.includes('src/waitlist.js'), 'the pure SQLite-side exports were loaded (the probe really ran)');
    assert.ok(rel.includes('src/mailCore.js'), 'the shared mail core was loaded (through src/pg/mailer.js)');
    assert.equal(fs.existsSync(dataDir), false, 'no data directory was created');
    assert.equal(fs.existsSync(path.join(scratch, 'data')), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('src/pg/effects.js imports nothing but the transaction helpers (no mailer, no SQLite)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'pg', 'effects.js'), 'utf8');
  const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(required, ['./transaction']);
});

test('src/mailCore.js imports no database module: only the time helpers, and nodemailer lazily', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mailCore.js'), 'utf8');
  const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(required, ['./timeRange', 'nodemailer', 'nodemailer/lib/addressparser']);
  assert.match(src, /const nodemailer = \(\) => require\('nodemailer'\)/, 'nodemailer is required inside a function, not at load');
});
