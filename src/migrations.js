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
];
module.exports.BASELINE_SQL = BASELINE_SQL;
