const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrate');
const migrations = require('./migrations');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'assets.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

runMigrations(db, migrations);

const DEFAULT_SETTINGS = {
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
