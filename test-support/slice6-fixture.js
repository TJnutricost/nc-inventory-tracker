// PostgreSQL Slice 6 test fixture: a SQLite source database for the data copy (scripts/pg-copy.js) and the backup/restore
// round trip. The deterministic dev seed is built once, in a child process, into a temp directory; `source()` returns a
// read-only copy of it, by default plus the rows the seed leaves out: a photo + cover, a token, a held waitlist entry
// (id 900) and its reservation, a closed entry, a catalog node moved under a newer parent, an employee id 5000, a session
// (never copied), a real and non-ASCII / emoji / newline text.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { openReadOnly } = require('../scripts/pg-preflight');

const ROOT = path.join(__dirname, '..');
const DEV_PASSWORD = 'DevPass!2026';
const ADMIN_EMAIL = 'dana.ito@example.com';

function extraRows(db) {
  db.pragma('foreign_keys = ON');
  const photo = db.prepare("INSERT INTO photos (asset_id, filename, thumb, caption, uploaded_by) VALUES (2, 'p.jpg', 'p_t.jpg', 'Caption ✓ ünï', 1)").run().lastInsertRowid;
  db.prepare('UPDATE assets SET cover_photo_id = ?, purchase_cost = 1234.5678, notes = ? WHERE id = 2').run(photo, 'Notes with "quotes", emoji 🎧 and\nnew lines');
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('tok-abc', 1, 'invite', '2026-12-01 00:00:00')").run();
  db.prepare(`INSERT INTO waitlist_entries (id, asset_id, employee_id, start_date, end_date, status, hold_started_at, hold_expires_at, queue_seq, start_time, end_time, request_group)
    VALUES (900, 2, 2, '2026-11-10', '2026-11-12', 'held', '2026-10-26 10:00:00', '2026-10-27 10:00:00', 1, '09:00', '17:30', 'g1')`).run();
  db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status, closed_at, queue_seq)
    VALUES (2, 3, '2026-11-01', '2026-11-02', 'expired', '2026-10-20 08:00:00', 2)`).run();
  db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval, waitlist_entry_id, start_time, end_time, request_group)
    VALUES (2, 2, '2026-11-10', '2026-11-12', 'confirmed', 0, 900, '09:00', '17:30', 'g1')`).run();
  const zeta = db.prepare("INSERT INTO catalog_nodes (name, name_key) VALUES ('Zeta', 'zeta')").run().lastInsertRowid;
  db.prepare('UPDATE catalog_nodes SET parent_id = ? WHERE id = 2').run(zeta);
  db.prepare("INSERT INTO employees (id, name, status) VALUES (5000, 'High Id', 'active')").run();
  db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES ('s1', '{\"uid\":1}', ?)").run(Date.now() + 60_000);
}

// Seeds once; returns { dir, source(opts), cleanup() }. source({ extras = true, edit }) opens a fresh read-only copy.
function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-slice6-'));
  const dataDir = path.join(dir, 'seed');
  const res = spawnSync(process.execPath, ['-e', `require('./scripts/seed-dev').seedDatabase({ dataDir: ${JSON.stringify(dataDir)}, quiet: true }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NC_NO_EXTERNAL_MAIL: '1' } });
  assert.equal(res.status, 0, res.stderr);
  const seeded = path.join(dir, 'seed.db');
  const db = new Database(path.join(dataDir, 'assets.db'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  fs.copyFileSync(path.join(dataDir, 'assets.db'), seeded);

  const opened = [];
  return {
    dir,
    source({ extras = true, edit } = {}) {
      const file = path.join(dir, `src-${Math.random().toString(16).slice(2)}.db`);
      fs.copyFileSync(seeded, file);
      const w = new Database(file);
      if (extras) extraRows(w);
      if (edit) edit(w);
      w.close();
      const ro = openReadOnly(file);
      opened.push(ro);
      return ro;
    },
    cleanup() {
      for (const s of opened) if (s.open) s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { createFixture, DEV_PASSWORD, ADMIN_EMAIL };
