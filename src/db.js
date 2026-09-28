const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'assets.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);

const DEFAULT_SETTINGS = {
  self_checkout: '1',          // users may check out available assets to themselves by scanning
  default_loan_days: '0',      // 0 = no due date by default
  tag_prefix: 'NC-',
  overdue_reminders: '1',
  categories: JSON.stringify([
    'Laptop', 'Desktop', 'Monitor', 'Keyboard & Mouse', 'Headset', 'Dock / Adapter',
    'Phone', 'Tablet', 'Printer / Scanner', 'Networking', 'Appliance', 'Software License', 'Other'
  ]),
  locations: JSON.stringify(['HQ - IT Room', 'HQ - Office', 'Warehouse', 'Remote']),
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return {
    self_checkout: out.self_checkout === '1',
    default_loan_days: Number(out.default_loan_days || 0),
    tag_prefix: out.tag_prefix || 'NC-',
    overdue_reminders: out.overdue_reminders === '1',
    categories: JSON.parse(out.categories || '[]'),
    locations: JSON.parse(out.locations || '[]'),
  };
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

module.exports = { db, DATA_DIR, getSettings, setSetting };
