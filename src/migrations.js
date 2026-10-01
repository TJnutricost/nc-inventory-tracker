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
];
module.exports.BASELINE_SQL = BASELINE_SQL;
