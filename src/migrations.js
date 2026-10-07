// Ordered, append-only list of schema migrations (see migrate.js). Never edit or reorder an
// applied migration; add a new one with the next id.

// 1: the schema as it existed before the migration runner. Every statement is IF NOT EXISTS,
// so it is a no-op on databases created by earlier versions and builds a fresh database.
const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  department TEXT,
  title TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  brand TEXT,
  model TEXT,
  serial TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','checked_out','maintenance','retired','lost')),
  condition TEXT DEFAULT 'Good',
  location TEXT,
  purchase_date TEXT,
  purchase_cost REAL,
  vendor TEXT,
  warranty_expires TEXT,
  license_key TEXT,
  license_seats INTEGER,
  license_expires TEXT,
  notes TEXT,
  cover_photo_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_serial ON assets(serial);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  checked_out_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_out_by INTEGER REFERENCES users(id),
  due_date TEXT,
  condition_out TEXT,
  notes TEXT,
  returned_at TEXT,
  returned_to INTEGER REFERENCES users(id),
  condition_in TEXT,
  return_notes TEXT,
  last_overdue_notice TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_open ON assignments(asset_id, returned_at);
CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id, returned_at);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  thumb TEXT NOT NULL,
  caption TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- type: 'equipment' = a user asks for equipment; 'return' = admin asks a user to turn something in
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('equipment','return')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','approved','denied','dropped_off','completed','cancelled')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  category TEXT,
  message TEXT,
  needed_by TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  subject_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_asset ON activity(asset_id, created_at);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

module.exports = [
  { id: 1, name: 'baseline schema', up: (db) => db.exec(BASELINE_SQL) },
  {
    // A cover photo must exist and belong to its asset; clear any bad reference saved by the old endpoint.
    id: 2,
    name: 'clear invalid cover photo references',
    up: (db) => db.exec(`UPDATE assets SET cover_photo_id = NULL
      WHERE cover_photo_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.id = assets.cover_photo_id AND p.asset_id = assets.id)`),
  },
  {
    // Phase 1C: assets gain archived_at (nullable) and the 'disposed' status. SQLite can't alter a CHECK
    // constraint, so the table is rebuilt (copy → drop → rename) with foreign keys off, keeping every id,
    // and the AUTOINCREMENT high-water mark so asset ids are never reused either.
    id: 3,
    name: 'assets: archived_at and disposed status',
    disableForeignKeys: true,
    up: (db) => {
      const cols = 'id, tag, name, category, brand, model, serial, status, condition, location, purchase_date, purchase_cost, vendor, warranty_expires, license_key, license_seats, license_expires, notes, cover_photo_id, created_at, updated_at';
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assets'").get();
      db.exec(`
        CREATE TABLE assets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'Other',
          brand TEXT,
          model TEXT,
          serial TEXT,
          status TEXT NOT NULL DEFAULT 'available'
            CHECK (status IN ('available','checked_out','maintenance','retired','lost','disposed')),
          condition TEXT DEFAULT 'Good',
          location TEXT,
          purchase_date TEXT,
          purchase_cost REAL,
          vendor TEXT,
          warranty_expires TEXT,
          license_key TEXT,
          license_seats INTEGER,
          license_expires TEXT,
          notes TEXT,
          cover_photo_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived_at TEXT
        );
        INSERT INTO assets_new (${cols}) SELECT ${cols} FROM assets;
        DROP TABLE assets;
        ALTER TABLE assets_new RENAME TO assets;
        CREATE INDEX IF NOT EXISTS idx_assets_serial ON assets(serial);`);
      if (seq) {
        const upd = db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'assets'").run(seq.seq);
        if (!upd.changes) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('assets', ?)").run(seq.seq);
      }
    },
  },
  {
    // Phase 1C: durable high-water mark for generated tag numbers. It only ever goes up, is independent of the
    // tag prefix, and is not lowered by archiving. Seeded conservatively from every existing tag: the number of
    // any tag that is a non-numeric prefix followed by up to 8 trailing digits (ignoring pure-number/barcode-like
    // tags), plus what the old generator would have counted for the current prefix.
    id: 4,
    name: 'durable asset tag counter',
    up: (db) => {
      db.exec('CREATE TABLE asset_tag_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last_number INTEGER NOT NULL)');
      const row = db.prepare("SELECT value FROM settings WHERE key = 'tag_prefix'").get();
      const prefix = (row && row.value) || 'NC-';
      let max = 0;
      for (const { tag } of db.prepare('SELECT tag FROM assets').all()) {
        const m = /^\D+(\d{1,8})$/.exec(tag);
        if (m) max = Math.max(max, parseInt(m[1], 10));
        if (tag.toLowerCase().startsWith(prefix.toLowerCase())) {
          const n = parseInt(tag.slice(prefix.length), 10);
          if (!isNaN(n) && n > max) max = n;
        }
      }
      db.prepare('INSERT INTO asset_tag_counter (id, last_number) VALUES (1, ?)').run(max);
    },
  },
  {
    // Phase 1D: split the legacy `users` table (person + login in one row) into `employees` (people / assignees, may
    // never log in) and `accounts` (login + authorization, optionally linked to one employee). Every legacy user
    // becomes one employee AND one linked account, both keeping the legacy numeric id, so sessions, tokens and every
    // stored reference stay valid without rewriting a single id. References are then re-pointed by meaning:
    //   person   -> employees: assignments.user_id, requests.user_id, activity.subject_user_id
    //   actor    -> accounts:  assignments.checked_out_by/returned_to, requests.created_by/resolved_by,
    //                          photos.uploaded_by, activity.actor_id, tokens.user_id (reset/invite tokens)
    // (column names are unchanged for now; renaming is Phase 1E). The dependent tables are rebuilt with all other
    // constraints kept exactly as they were (assets still CASCADE — that is Phase 1E), then `users` is dropped.
    id: 5,
    name: 'split users into employees and accounts',
    disableForeignKeys: true,
    up: (db) => {
      const users = db.prepare('SELECT id, name, email FROM users').all();
      const seen = new Map();
      const dups = [];
      for (const u of users) {
        const k = u.email.trim().toLowerCase();
        if (seen.has(k)) dups.push(`${seen.get(k)} / ${u.id} (${k})`); else seen.set(k, u.id);
      }
      if (dups.length) throw new Error(`Cannot split users: duplicate emails after normalization (user ids): ${dups.join(', ')}. Resolve them manually; nothing was changed.`);
      const seqOf = (t) => (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t) || {}).seq || 0;
      const seqs = Object.fromEntries(['users', 'assignments', 'photos', 'requests', 'activity'].map((t) => [t, seqOf(t)]));

      db.exec(`
        CREATE TABLE employees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          work_email TEXT COLLATE NOCASE,
          department TEXT,
          title TEXT,
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX idx_employees_work_email ON employees(work_email) WHERE work_email IS NOT NULL;

        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER UNIQUE REFERENCES employees(id),
          login_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_login_at TEXT
        );

        INSERT INTO employees (id, name, work_email, department, title, phone, status, created_at)
          SELECT id, name, lower(trim(email)), department, title, phone, CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END, created_at FROM users;
        INSERT INTO accounts (id, employee_id, login_email, password_hash, role, active, created_at, last_login_at)
          SELECT id, id, lower(trim(email)), password_hash, CASE role WHEN 'admin' THEN 'admin' ELSE 'employee' END, active, created_at, last_login_at FROM users;

        CREATE TABLE assignments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES employees(id),
          checked_out_at TEXT NOT NULL DEFAULT (datetime('now')),
          checked_out_by INTEGER REFERENCES accounts(id),
          due_date TEXT,
          condition_out TEXT,
          notes TEXT,
          returned_at TEXT,
          returned_to INTEGER REFERENCES accounts(id),
          condition_in TEXT,
          return_notes TEXT,
          last_overdue_notice TEXT
        );
        INSERT INTO assignments_new SELECT id, asset_id, user_id, checked_out_at, checked_out_by, due_date, condition_out, notes, returned_at, returned_to, condition_in, return_notes, last_overdue_notice FROM assignments;
        DROP TABLE assignments;
        ALTER TABLE assignments_new RENAME TO assignments;
        CREATE INDEX idx_assign_open ON assignments(asset_id, returned_at);
        CREATE INDEX idx_assign_user ON assignments(user_id, returned_at);

        CREATE TABLE photos_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          thumb TEXT NOT NULL,
          caption TEXT,
          uploaded_by INTEGER REFERENCES accounts(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO photos_new SELECT id, asset_id, filename, thumb, caption, uploaded_by, created_at FROM photos;
        DROP TABLE photos;
        ALTER TABLE photos_new RENAME TO photos;

        CREATE TABLE requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('equipment','return')),
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','approved','denied','dropped_off','completed','cancelled')),
          user_id INTEGER NOT NULL REFERENCES employees(id),
          asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
          category TEXT,
          message TEXT,
          needed_by TEXT,
          created_by INTEGER REFERENCES accounts(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by INTEGER REFERENCES accounts(id),
          resolved_at TEXT,
          resolution_note TEXT
        );
        INSERT INTO requests_new SELECT id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note FROM requests;
        DROP TABLE requests;
        ALTER TABLE requests_new RENAME TO requests;

        CREATE TABLE activity_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
          actor_id INTEGER REFERENCES accounts(id),
          subject_user_id INTEGER REFERENCES employees(id),
          action TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO activity_new SELECT id, asset_id, actor_id, subject_user_id, action, details, created_at FROM activity;
        DROP TABLE activity;
        ALTER TABLE activity_new RENAME TO activity;
        CREATE INDEX idx_activity_asset ON activity(asset_id, created_at);

        CREATE TABLE tokens_new (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        INSERT INTO tokens_new SELECT token, user_id, purpose, expires_at FROM tokens;
        DROP TABLE tokens;
        ALTER TABLE tokens_new RENAME TO tokens;

        DROP TABLE users;`);

      // Keep every AUTOINCREMENT high-water mark so ids are never reused.
      const setSeq = db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?");
      const addSeq = db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      for (const [t, seq] of [['employees', seqs.users], ['accounts', seqs.users], ['assignments', seqs.assignments], ['photos', seqs.photos], ['requests', seqs.requests], ['activity', seqs.activity]]) {
        if (seq && !setSeq.run(seq, t).changes) addSeq.run(t, seq);
      }
    },
  },
  {
    // Phase 1E: assignment integrity + historical safety. Rebuilds three tables (keeping every id and AUTOINCREMENT mark):
    //   assignments: user_id -> employee_id (it has pointed at employees since 1D); new assignment_type
    //     ('permanent' | 'checkout', NOT NULL); history FKs become RESTRICT; a partial UNIQUE index forbids the SAME
    //     employee holding the SAME asset twice at once. Capacity (seats) is NOT a constraint here — it is enforced
    //     transactionally in src/assignments.js, so multi-seat assets keep working.
    //   requests.asset_id: SET NULL -> RESTRICT (a raw asset delete can no longer detach request history); new nullable
    //     requested_assignment_type marks an equipment request as a request for a PERMANENT assignment (NULL = unspecified).
    //   activity.asset_id: CASCADE -> RESTRICT (a raw asset delete can no longer erase the audit trail).
    // LEGACY RULE: a legacy assignment WITH a due_date becomes 'checkout' (it was evidently a loan); one WITHOUT
    // becomes 'permanent'. Category is never consulted. due_date is preserved as-is; legacy rows have no due_time.
    // A table CHECK keeps the invariant: permanent => no due date/time, checkout => a due date (time optional).
    id: 6,
    name: 'assignments: type, employee_id, active uniqueness; RESTRICT history FKs',
    disableForeignKeys: true,
    up: (db) => {
      const dups = db.prepare(`SELECT asset_id, user_id, COUNT(*) n FROM assignments WHERE returned_at IS NULL
        GROUP BY asset_id, user_id HAVING n > 1`).all();
      if (dups.length) {
        throw new Error(`Cannot enforce one active assignment per employee and asset: duplicates exist (asset id / employee id): ${dups.map((d) => `${d.asset_id}/${d.user_id}`).join(', ')}. Check the extras in manually; nothing was changed.`);
      }
      const seqOf = (t) => (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t) || {}).seq || 0;
      const seqs = Object.fromEntries(['assignments', 'requests', 'activity'].map((t) => [t, seqOf(t)]));

      db.exec(`
        CREATE TABLE assignments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
          assignment_type TEXT NOT NULL DEFAULT 'permanent' CHECK (assignment_type IN ('permanent','checkout')),
          checked_out_at TEXT NOT NULL DEFAULT (datetime('now')),
          checked_out_by INTEGER REFERENCES accounts(id),
          due_date TEXT,
          due_time TEXT,
          condition_out TEXT,
          notes TEXT,
          returned_at TEXT,
          returned_to INTEGER REFERENCES accounts(id),
          condition_in TEXT,
          return_notes TEXT,
          last_overdue_notice TEXT,
          CHECK ((assignment_type = 'permanent' AND due_date IS NULL AND due_time IS NULL)
              OR (assignment_type = 'checkout' AND due_date IS NOT NULL))
        );
        INSERT INTO assignments_new (id, asset_id, employee_id, assignment_type, checked_out_at, checked_out_by, due_date, condition_out, notes, returned_at, returned_to, condition_in, return_notes, last_overdue_notice)
          SELECT id, asset_id, user_id, CASE WHEN due_date IS NOT NULL THEN 'checkout' ELSE 'permanent' END, checked_out_at, checked_out_by, due_date, condition_out, notes, returned_at, returned_to, condition_in, return_notes, last_overdue_notice FROM assignments;
        DROP TABLE assignments;
        ALTER TABLE assignments_new RENAME TO assignments;
        CREATE INDEX idx_assign_open ON assignments(asset_id, returned_at);
        CREATE INDEX idx_assign_employee ON assignments(employee_id, returned_at);
        CREATE UNIQUE INDEX idx_assign_active_unique ON assignments(asset_id, employee_id) WHERE returned_at IS NULL;

        CREATE TABLE requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('equipment','return')),
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','approved','denied','dropped_off','completed','cancelled')),
          user_id INTEGER NOT NULL REFERENCES employees(id),
          asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
          category TEXT,
          message TEXT,
          needed_by TEXT,
          created_by INTEGER REFERENCES accounts(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by INTEGER REFERENCES accounts(id),
          resolved_at TEXT,
          resolution_note TEXT,
          requested_assignment_type TEXT CHECK (requested_assignment_type IN ('permanent','checkout'))
        );
        INSERT INTO requests_new (id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note)
          SELECT id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note FROM requests;
        DROP TABLE requests;
        ALTER TABLE requests_new RENAME TO requests;

        CREATE TABLE activity_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
          actor_id INTEGER REFERENCES accounts(id),
          subject_user_id INTEGER REFERENCES employees(id),
          action TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO activity_new SELECT id, asset_id, actor_id, subject_user_id, action, details, created_at FROM activity;
        DROP TABLE activity;
        ALTER TABLE activity_new RENAME TO activity;
        CREATE INDEX idx_activity_asset ON activity(asset_id, created_at);`);

      const setSeq = db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?');
      const addSeq = db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      for (const [t, seq] of Object.entries(seqs)) {
        if (seq && !setSeq.run(seq, t).changes) addSeq.run(t, seq);
      }
    },
  },
  {
    // Employee columns added after Phase 1E QA (plain ADD COLUMNs, no rebuild):
    //   can_self_checkout — self-checkout permission is per EMPLOYEE, default enabled for new employees and new databases.
    //   building          — optional free-text location note; no list, table or settings behind it.
    // The old global `self_checkout` setting (settings row, '1' = on; anything else = off, as the old code read it) is
    // consumed ONCE, here, to preserve its intent: if it was OFF every existing employee starts disabled, if it was ON or
    // absent they start enabled. After this migration nothing ever reads it again (it stays as unused, deprecated data).
    id: 7,
    name: 'employees: can_self_checkout and building',
    up: (db) => {
      const legacy = db.prepare("SELECT value FROM settings WHERE key = 'self_checkout'").get();
      db.exec(`ALTER TABLE employees ADD COLUMN can_self_checkout INTEGER NOT NULL DEFAULT 1 CHECK (can_self_checkout IN (0,1))`);
      db.exec('ALTER TABLE employees ADD COLUMN building TEXT');
      if (legacy && legacy.value !== '1') db.exec('UPDATE employees SET can_self_checkout = 0');
    },
  },
  {
    // Phase 1 Foundation Closeout: serial numbers become unique across the whole asset inventory (archived assets
    // included) once surrounding whitespace and letter case are ignored. `serial` keeps what the user typed (only
    // surrounding whitespace is trimmed; a blank or the exact placeholder "N/A", any case, becomes NULL); `serial_normalized` = trimmed + lower-cased, maintained by
    // src/serial.js on every write path, with a plain UNIQUE index (NULLs never collide). Nothing else is stripped:
    // "ABC-123" and "ABC123" stay different. The rule is inlined here on purpose — a migration must never change when
    // src/serial.js does. If existing assets already collide the migration REFUSES and lists them; it never merges,
    // deletes or renames anything. Plain ADD COLUMN + CREATE UNIQUE INDEX, no table rebuild, portable to PostgreSQL.
    id: 8,
    name: 'assets: normalized serial uniqueness',
    up: (db) => {
      const rows = db.prepare('SELECT id, tag, serial FROM assets WHERE serial IS NOT NULL ORDER BY id').all()
        .map((r) => {
          const trimmed = String(r.serial).trim();
          const serial = trimmed === '' || trimmed.toLowerCase() === 'n/a' ? null : trimmed;
          return { id: r.id, tag: r.tag, raw: r.serial, serial, key: serial === null ? null : serial.toLowerCase() };
        });
      const groups = new Map();
      for (const r of rows) if (r.key !== null) groups.set(r.key, [...(groups.get(r.key) || []), r]);
      const clashes = [...groups.entries()].filter(([, list]) => list.length > 1);
      if (clashes.length) {
        const detail = clashes.map(([key, list]) => `"${key}": ${list.map((r) => `${r.tag} (asset id ${r.id}, "${r.raw}")`).join(', ')}`).join('; ');
        throw new Error(`Cannot enforce unique serial numbers: these assets share a serial once whitespace and letter case are ignored — ${detail}. Correct or clear the duplicates manually (assets are never merged or deleted automatically); nothing was changed.`);
      }
      db.exec('ALTER TABLE assets ADD COLUMN serial_normalized TEXT');
      const set = db.prepare('UPDATE assets SET serial = ?, serial_normalized = ? WHERE id = ?');
      for (const r of rows) set.run(r.serial, r.key, r.id);
      db.exec('CREATE UNIQUE INDEX idx_assets_serial_normalized ON assets(serial_normalized)');
    },
  },
  {
    // Phase 1 Foundation Closeout: request integrity for the CURRENT workflow (no new statuses or screens).
    // Rebuilds `requests` (ids and the AUTOINCREMENT mark kept) to add table CHECKs that make contradictory rows
    // impossible, make every reference explicitly RESTRICT, and add two indexes:
    //   status/type   equipment: open|approved|denied|completed|cancelled; return: open|dropped_off|completed|cancelled
    //   timestamps    open/dropped_off => not resolved (resolved_at/resolved_by NULL); approved/denied/completed/
    //                 cancelled => resolved_at set; resolved_at is never before created_at
    //   assignment    requested_assignment_type only on equipment requests; 'permanent' needs an asset
    //   uniqueness    at most one live (open|dropped_off) return request per asset + employee (partial unique index)
    // Allowed transitions between statuses live in src/requests.js (a CHECK can't see the previous row, and a trigger
    // would not port to PostgreSQL). Existing rows are validated first; if any already contradict the rules the
    // migration REFUSES with their ids and changes nothing — no row is repaired, merged or deleted automatically.
    id: 9,
    name: 'requests: integrity checks, RESTRICT references, live return-request uniqueness',
    disableForeignKeys: true,
    up: (db) => {
      const violations = [
        ['invalid status for its type', "NOT ((type = 'equipment' AND status IN ('open','approved','denied','completed','cancelled')) OR (type = 'return' AND status IN ('open','dropped_off','completed','cancelled')))"],
        ['open/dropped_off but marked resolved', "status IN ('open','dropped_off') AND (resolved_at IS NOT NULL OR resolved_by IS NOT NULL)"],
        ['approved/denied/completed/cancelled but resolved_at missing', "status IN ('approved','denied','completed','cancelled') AND resolved_at IS NULL"],
        ['resolved before it was created', 'resolved_at IS NOT NULL AND resolved_at < created_at'],
        ['requested_assignment_type on a return request', "requested_assignment_type IS NOT NULL AND type <> 'equipment'"],
        ['permanent request without an asset', "requested_assignment_type = 'permanent' AND asset_id IS NULL"],
      ];
      const problems = [];
      for (const [why, where] of violations) {
        const ids = db.prepare(`SELECT id FROM requests WHERE ${where} ORDER BY id`).all().map((r) => r.id);
        if (ids.length) problems.push(`${why}: request id ${ids.join(', ')}`);
      }
      const dup = db.prepare(`SELECT asset_id, user_id, COUNT(*) n FROM requests WHERE type = 'return' AND status IN ('open','dropped_off')
        GROUP BY asset_id, user_id HAVING n > 1`).all();
      if (dup.length) problems.push(`more than one live return request for the same asset/employee: ${dup.map((d) => `${d.asset_id}/${d.user_id}`).join(', ')}`);
      if (problems.length) throw new Error(`Cannot enforce request integrity: ${problems.join('; ')}. Fix or close these requests manually; nothing was changed.`);

      const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get() || {}).seq || 0;
      db.exec(`
        CREATE TABLE requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('equipment','return')),
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','approved','denied','dropped_off','completed','cancelled')),
          user_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
          asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
          category TEXT,
          message TEXT,
          needed_by TEXT,
          created_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          resolved_at TEXT,
          resolution_note TEXT,
          requested_assignment_type TEXT CHECK (requested_assignment_type IN ('permanent','checkout')),
          CHECK ((type = 'equipment' AND status IN ('open','approved','denied','completed','cancelled'))
              OR (type = 'return' AND status IN ('open','dropped_off','completed','cancelled'))),
          CHECK ((status IN ('open','dropped_off') AND resolved_at IS NULL AND resolved_by IS NULL)
              OR (status IN ('approved','denied','completed','cancelled') AND resolved_at IS NOT NULL)),
          CHECK (resolved_at IS NULL OR resolved_at >= created_at),
          CHECK (requested_assignment_type IS NULL OR type = 'equipment'),
          CHECK (requested_assignment_type IS NULL OR requested_assignment_type <> 'permanent' OR asset_id IS NOT NULL)
        );
        INSERT INTO requests_new (id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note, requested_assignment_type)
          SELECT id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note, requested_assignment_type FROM requests;
        DROP TABLE requests;
        ALTER TABLE requests_new RENAME TO requests;
        CREATE INDEX idx_requests_asset ON requests(asset_id);
        CREATE INDEX idx_requests_employee_status ON requests(user_id, status);
        CREATE UNIQUE INDEX idx_requests_live_return ON requests(asset_id, user_id) WHERE type = 'return' AND status IN ('open','dropped_off');`);
      if (seq && !db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'requests'").run(seq).changes) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('requests', ?)").run(seq);
      }
    },
  },
  {
    // Phase 2 Slice 2 (Employee Actions V1): an employee can report an issue with equipment they hold. The smallest durable
    // design is a third request `type`, 'issue', riding the same table, queue and state machine — not a ticketing system.
    // Rebuilds `requests` (ids, AUTOINCREMENT mark, indexes kept) so the CHECKs accept it:
    //   issue statuses  open -> completed ("resolved" by IT) | cancelled (withdrawn); no approve/deny/dropped_off
    //   issue asset     an issue is always about one asset (asset_id NOT NULL for type 'issue')
    // Every other rule from migration 9 is unchanged, so the rebuild is a pure widening: no existing row can violate it.
    id: 10,
    name: "requests: add the 'issue' type (employee-reported equipment issues)",
    disableForeignKeys: true,
    up: (db) => {
      const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get() || {}).seq || 0;
      db.exec(`
        CREATE TABLE requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('equipment','return','issue')),
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','approved','denied','dropped_off','completed','cancelled')),
          user_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
          asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
          category TEXT,
          message TEXT,
          needed_by TEXT,
          created_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          resolved_at TEXT,
          resolution_note TEXT,
          requested_assignment_type TEXT CHECK (requested_assignment_type IN ('permanent','checkout')),
          CHECK ((type = 'equipment' AND status IN ('open','approved','denied','completed','cancelled'))
              OR (type = 'return' AND status IN ('open','dropped_off','completed','cancelled'))
              OR (type = 'issue' AND status IN ('open','completed','cancelled'))),
          CHECK ((status IN ('open','dropped_off') AND resolved_at IS NULL AND resolved_by IS NULL)
              OR (status IN ('approved','denied','completed','cancelled') AND resolved_at IS NOT NULL)),
          CHECK (resolved_at IS NULL OR resolved_at >= created_at),
          CHECK (requested_assignment_type IS NULL OR type = 'equipment'),
          CHECK (requested_assignment_type IS NULL OR requested_assignment_type <> 'permanent' OR asset_id IS NOT NULL),
          CHECK (type <> 'issue' OR asset_id IS NOT NULL)
        );
        INSERT INTO requests_new (id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note, requested_assignment_type)
          SELECT id, type, status, user_id, asset_id, category, message, needed_by, created_by, created_at, resolved_by, resolved_at, resolution_note, requested_assignment_type FROM requests;
        DROP TABLE requests;
        ALTER TABLE requests_new RENAME TO requests;
        CREATE INDEX idx_requests_asset ON requests(asset_id);
        CREATE INDEX idx_requests_employee_status ON requests(user_id, status);
        CREATE UNIQUE INDEX idx_requests_live_return ON requests(asset_id, user_id) WHERE type = 'return' AND status IN ('open','dropped_off');`);
      if (seq && !db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'requests'").run(seq).changes) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('requests', ?)").run(seq);
      }
    },
  },
  {
    // Phase 2 Slice 3 (Hierarchical Equipment Catalog): a generic parent/child tree of equipment types, admin-managed.
    //   catalog_nodes   id, parent_id (NULL = root = a broad category), name, name_key (normalized for sibling uniqueness),
    //                   archived_at (archive, never delete, once anything depends on a node), timestamps.
    //                   Sibling names are unique ignoring case/whitespace INCLUDING archived siblings, so a restore can never
    //                   collide. Cycles are prevented in src/catalog.js (a CHECK cannot see ancestors; it only blocks self-parent).
    //   assets.catalog_node_id      optional link from a physical asset to its most specific node. category/brand/model stay.
    //   requests.catalog_node_id    what was asked for (any level). Together with the two SNAPSHOT columns below it keeps a
    //   requests.catalog_path       request readable after a rename/move: the path text as it was at request time, and for a
    //   requests.asset_label        specific-asset request, "TAG — name" as it was then. asset_id set => specific asset;
    //                               asset_id NULL + catalog_node_id set => any matching asset.
    // Existing data: ONE root node per existing category (the settings category list, or the built-in defaults on a fresh
    // database, plus any category text found on assets), and every asset is linked to the root matching its own category text.
    // That is a lossless copy of what the data already says. Nothing deeper is inferred from brand/model (Apple is not "Mac",
    // Dell is not "Windows"): IT maps assets to deeper nodes themselves. Existing requests are untouched (category text kept).
    id: 11,
    name: 'equipment catalog: catalog_nodes, asset and request links',
    up: (db) => {
      db.exec(`
        CREATE TABLE catalog_nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES catalog_nodes(id) ON DELETE RESTRICT,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          name_key TEXT NOT NULL CHECK (length(name_key) > 0),
          archived_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (parent_id IS NULL OR parent_id <> id)
        );
        CREATE UNIQUE INDEX idx_catalog_sibling_name ON catalog_nodes(COALESCE(parent_id, 0), name_key);
        CREATE INDEX idx_catalog_parent ON catalog_nodes(parent_id);
        ALTER TABLE assets ADD COLUMN catalog_node_id INTEGER REFERENCES catalog_nodes(id) ON DELETE RESTRICT;
        CREATE INDEX idx_assets_catalog ON assets(catalog_node_id);
        ALTER TABLE requests ADD COLUMN catalog_node_id INTEGER REFERENCES catalog_nodes(id) ON DELETE RESTRICT;
        ALTER TABLE requests ADD COLUMN catalog_path TEXT;
        ALTER TABLE requests ADD COLUMN asset_label TEXT;
        CREATE INDEX idx_requests_catalog ON requests(catalog_node_id);`);

      const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
      const DEFAULT_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Keyboard & Mouse', 'Headset', 'Dock / Adapter', 'Phone', 'Tablet',
        'Printer / Scanner', 'Networking', 'Appliance', 'Software License', 'Other'];
      let configured = null;
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'categories'").get();
        if (row) configured = JSON.parse(row.value);
      } catch { /* a missing/odd settings row just means "use the defaults" */ }
      const names = [...(Array.isArray(configured) ? configured : DEFAULT_CATEGORIES),
        ...db.prepare('SELECT DISTINCT category FROM assets WHERE category IS NOT NULL ORDER BY category').all().map((r) => r.category)];
      const ins = db.prepare('INSERT INTO catalog_nodes (parent_id, name, name_key) VALUES (NULL, ?, ?)');
      const rootByKey = new Map();
      for (const raw of names) {
        const name = norm(raw); const key = name.toLowerCase();
        if (!name || rootByKey.has(key)) continue;
        rootByKey.set(key, ins.run(name, key).lastInsertRowid);
      }
      const link = db.prepare('UPDATE assets SET catalog_node_id = ? WHERE id = ?');
      for (const a of db.prepare('SELECT id, category FROM assets').all()) {
        const id = rootByKey.get(norm(a.category).toLowerCase());
        if (id) link.run(id, a.id);
      }
    },
  },
  {
    // Phase 2 Slice 5 (Admin Request Workflow V1): requests.opened_at — the moment IT first opened a LIVE request. NULL = nobody
    // in IT has looked at it ("Submitted"); set = IT has taken it up ("In review"). While it is NULL the employee may rescind;
    // once it is set they may not (enforced in src/requests.js + src/server.js, atomically). It is NOT a new status: the
    // user-facing lifecycle (Submitted / In review / Approved / Declined / Fulfilled / Rescinded) is derived from status +
    // opened_at in src/requests.js, so no CHECK or transition table had to change and no table rebuild is needed.
    // Backfill: a request that has already moved past 'open' was necessarily handled by IT (or by the employee's own
    // drop-off), so it counts as opened at its resolution time (else creation time) — it can't suddenly become rescindable.
    // Plain 'open' rows stay NULL (genuinely untouched). Returns an employee dropped off keep NULL: IT hasn't opened them.
    id: 12,
    name: 'requests: opened_at (IT has opened the request; ends employee rescind)',
    up: (db) => {
      db.exec('ALTER TABLE requests ADD COLUMN opened_at TEXT');
      // (a request the employee cancelled themselves was rescinded, not opened — it stays NULL)
      db.exec(`UPDATE requests SET opened_at = COALESCE(resolved_at, created_at)
        WHERE status IN ('approved','denied','completed')
           OR (status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = requests.resolved_by AND a.employee_id = requests.user_id))`);
    },
  },
  {
    // Phase 2 Slice 7 (Asset Reservations V1).
    //   assets.available_to_request           0/1, DEFAULT 0. Whether the asset is part of the employee-facing SHARED pool: employees can
    //                                         find it (Browse, search, catalog counts, calendar) and check it out, request or reserve it.
    //                                         It never hides equipment from the employee it is currently assigned to (that follows the
    //                                         assignment). EXISTING assets get 0 on purpose: nothing is silently exposed to employees;
    //                                         IT opts each asset in.
    //   assets.reservation_requires_approval  0/1, DEFAULT 0, per asset. 0 = a valid reservation confirms immediately; 1 = pending IT approval.
    //   reservations                          one row per reservation of ONE physical asset. start_date/end_date are calendar dates (YYYY-MM-DD),
    //                                         INCLUSIVE at both ends. status: pending (waiting for IT) | confirmed | declined | cancelled.
    //                                         requires_approval is a SNAPSHOT of the asset's setting at submission, so a later toggle can't
    //                                         change what a row means. Only confirmed rows block availability; a pending row blocks nothing.
    //                                         Overlap between confirmed rows is prevented by the application inside one BEGIN IMMEDIATE
    //                                         transaction (SQLite has no range-exclusion constraint); the CHECKs below keep each row coherent.
    id: 13,
    name: 'assets: available_to_request + reservation_requires_approval; reservations table',
    up: (db) => {
      db.exec(`
        ALTER TABLE assets ADD COLUMN available_to_request INTEGER NOT NULL DEFAULT 0 CHECK (available_to_request IN (0, 1));
        ALTER TABLE assets ADD COLUMN reservation_requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (reservation_requires_approval IN (0, 1));
        CREATE TABLE reservations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
          start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          status TEXT NOT NULL CHECK (status IN ('pending','confirmed','declined','cancelled')),
          requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
          created_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          decided_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          decided_at TEXT,
          decision_note TEXT,
          cancelled_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          cancelled_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (end_date >= start_date),
          CHECK (status <> 'pending' OR (requires_approval = 1 AND decided_at IS NULL)),
          CHECK (status <> 'declined' OR (requires_approval = 1 AND decided_at IS NOT NULL)),
          CHECK (status <> 'confirmed' OR requires_approval = 0 OR decided_at IS NOT NULL),
          CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
        );
        CREATE INDEX idx_reservations_asset ON reservations(asset_id, status, start_date);
        CREATE INDEX idx_reservations_employee ON reservations(employee_id, status);`);
    },
  },
  {
    // Phase 2 Slice 8 (Waitlist + availability holds).
    //   waitlist_entries   one row per employee waiting for ONE physical asset over an inclusive range of calendar dates (same date
    //                      semantics as reservations: YYYY-MM-DD strings, no times; Slice 8.1 will add optional times to both tables).
    //                      FIFO order is (created_at, id). status:
    //                        waiting    in the queue
    //                        held       has the 24-hour priority hold on the whole range (hold_expires_at); it blocks every OTHER
    //                                   employee from reserving those dates until it is confirmed, declined, left or expires
    //                        fulfilled  the employee confirmed the hold; the reservation made from it points back via
    //                                   reservations.waitlist_entry_id (pending or confirmed per the asset's approval setting)
    //                        declined   the employee said they no longer need it      left     the employee left the waitlist
    //                        removed    IT removed the entry                          expired  the hold ran out, or the dates passed
    //                      hold_email_at is set (once, atomically) when the hold email is claimed, so repeated evaluation never re-sends.
    //   reservations.waitlist_entry_id   the entry a reservation was created from (NULL for ordinary reservations). A PENDING reservation
    //                      made from a hold keeps its place in line: nobody else is offered a hold on those dates while it awaits IT.
    // Overlap/queue rules live in src/waitlist.js and run inside BEGIN IMMEDIATE transactions, like reservations.
    id: 14,
    name: 'waitlist_entries (waitlist + 24-hour availability holds); reservations.waitlist_entry_id',
    up: (db) => {
      db.exec(`
        CREATE TABLE waitlist_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
          start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','held','fulfilled','declined','left','removed','expired')),
          created_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          hold_started_at TEXT,
          hold_expires_at TEXT,
          hold_email_at TEXT,
          closed_at TEXT,
          closed_by INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (end_date >= start_date),
          CHECK (status <> 'held' OR (hold_started_at IS NOT NULL AND hold_expires_at IS NOT NULL)),
          CHECK (status IN ('waiting','held') OR closed_at IS NOT NULL)
        );
        CREATE INDEX idx_waitlist_asset ON waitlist_entries(asset_id, status, created_at);
        CREATE INDEX idx_waitlist_employee ON waitlist_entries(employee_id, status);
        ALTER TABLE reservations ADD COLUMN waitlist_entry_id INTEGER REFERENCES waitlist_entries(id) ON DELETE RESTRICT;`);
    },
  },
  {
    // Slice 8 follow-up (QA round 1).
    //   waitlist_entries.queue_seq   the FIFO key. Strictly increasing across the table: a new entry takes MAX + 1, and an employee who
    //                                CHANGES their requested dates takes a new MAX + 1 (they asked for something new, so they go to the back
    //                                of the line for it). created_at stays "when they first joined" and is not the order any more (it has
    //                                one-second resolution, which cannot order two things that happen in the same second). Existing rows
    //                                keep their relative order (queue_seq = id, which is creation order).
    //   waitlist_entries.queued_at   when the entry took its current place in line (join, or the last date change).
    //   outbox.delivered_to          set when MAIL_TEST_RECIPIENT redirected the message: the address it was actually addressed to
    //                                (to_addr always stays the INTENDED recipient). NULL = addressed to to_addr.
    id: 15,
    name: 'waitlist_entries.queue_seq/queued_at (FIFO key, reset on date change); outbox.delivered_to',
    up: (db) => {
      db.exec(`
        ALTER TABLE waitlist_entries ADD COLUMN queue_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE waitlist_entries ADD COLUMN queued_at TEXT;
        UPDATE waitlist_entries SET queue_seq = id, queued_at = created_at;
        CREATE INDEX idx_waitlist_queue ON waitlist_entries(asset_id, status, queue_seq);
        ALTER TABLE outbox ADD COLUMN delivered_to TEXT;`);
    },
  },
  {
    // Search + discoverability refinement.
    //   catalog_nodes.search_keywords   admin-managed aliases for a catalog entry, stored normalized as "camera, photography, video" (lower-case,
    //                                   comma-separated, de-duplicated; NULL = none). Kept on the CATALOG entry (not on every physical asset): an asset
    //                                   inherits the keywords of the entry it is filed under and of every ancestor, so tagging "Camera" once makes
    //                                   every camera beneath it findable by "photography". Only a search aid: it grants nothing and shows nowhere else.
    id: 16,
    name: 'catalog_nodes.search_keywords',
    up: (db) => { db.exec('ALTER TABLE catalog_nodes ADD COLUMN search_keywords TEXT;'); },
  },
  {
    // Phase 2 Slice 8.1 (Optional reservation times / partial-day availability, and partial fulfillment).
    //   reservations.start_time / end_time, waitlist_entries.start_time / end_time
    //       Optional wall-clock "HH:MM" (24-hour, no seconds) in the business's own time zone (APP_TIMEZONE), exactly like assignments.due_time.
    //       Both columns are INDEPENDENTLY nullable; all four combinations are valid (no CHECK ties them together):
    //         start_time NULL = picked up at the START of start_date      end_time NULL = returned at the END of end_date
    //       NULL is meaningful ("no specific time"), so existing rows stay date-only: NOTHING is rewritten into synthetic midnight / end-of-day
    //       values. Those only exist at comparison time (src/timeRange.js). Dates keep their meaning; a time applies to its own date only
    //       (pickup to the first date, return to the last; days in between are full days). Ordering of a same-day range (end after start) is a
    //       row-level rule SQLite cannot add to an existing table, so the application enforces it (src/timeRange.js checkOrder). Plain TEXT
    //       with a format CHECK is provider-neutral: PostgreSQL can take it as TIME (or keep TEXT) without reinterpreting any value.
    //   reservations.request_group / waitlist_entries.request_group
    //       Unavailable time is waitlist time, so ONE request for a range can become reservation row(s) for the free time AND waitlist row(s) for the
    //       unavailable time. Rows made from the same request carry the same opaque token, so they stay associated (the requested range is the union of
    //       the group's rows). NULL for rows that are not part of a split request. Plain TEXT (a UUID): no FK, no table, provider-neutral.
    id: 17,
    name: 'reservations / waitlist_entries: optional start_time + end_time, request_group',
    up: (db) => {
      const fmt = (c) => `CHECK (${c} IS NULL OR (${c} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${c} < '24:00'))`;
      for (const t of ['reservations', 'waitlist_entries']) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN start_time TEXT ${fmt('start_time')};
          ALTER TABLE ${t} ADD COLUMN end_time TEXT ${fmt('end_time')};
          ALTER TABLE ${t} ADD COLUMN request_group TEXT;
          CREATE INDEX idx_${t}_request_group ON ${t}(request_group);`);
      }
    },
  },
];
module.exports.BASELINE_SQL = BASELINE_SQL;
