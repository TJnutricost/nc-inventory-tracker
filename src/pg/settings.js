// Settings on PostgreSQL (D-46, migration Slice 3): the PG counterpart of getSettings / setSetting and the default-settings
// seeding in src/db.js. NOT used by the running app yet (Slice 5 switches server.js over).
//
// src/db.js cannot be imported here (it opens SQLite and creates data/ at import time), so DEFAULT_SETTINGS is a copy.
// test/pg/pg-settings.test.js loads src/db.js under a temp DATA_DIR and asserts both produce the same settings on a fresh
// database, so the two cannot drift silently. Until cutover, a change to either copy must be made to both.
//
// Every function takes an executor `q`: a pg Pool or a transaction client (anything with .query).

const DEFAULT_SETTINGS = {
  default_loan_days: '0',      // 0 = no due date by default
  tag_prefix: 'NC-',
  overdue_reminders: '1',
  it_email_name: 'Nutricost IT',   // display name on outgoing email (never a credential; those stay in the server environment)
  it_contact_email: '',            // reply-to / IT contact address ('' = none)
  categories: JSON.stringify([
    'Laptop', 'Desktop', 'Monitor', 'Keyboard & Mouse', 'Headset', 'Dock / Adapter',
    'Phone', 'Tablet', 'Printer / Scanner', 'Networking', 'Appliance', 'Software License', 'Other'
  ]),
  locations: JSON.stringify(['HQ - IT Room', 'HQ - Office', 'Warehouse', 'Remote']),
};

// SQLite: INSERT OR IGNORE at startup. Existing values are never overwritten. Safe to run on every boot.
async function seedDefaultSettings(q) {
  const entries = Object.entries(DEFAULT_SETTINGS);
  const values = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  await q.query(`INSERT INTO settings (key, value) VALUES ${values} ON CONFLICT (key) DO NOTHING`, entries.flat());
}

async function getSettings(q) {
  const out = {};
  for (const r of (await q.query('SELECT key, value FROM settings')).rows) out[r.key] = r.value;
  return {
    default_loan_days: Number(out.default_loan_days || 0),
    tag_prefix: out.tag_prefix || 'NC-',
    overdue_reminders: out.overdue_reminders === '1',
    it_email_name: out.it_email_name || 'Nutricost IT',
    it_contact_email: out.it_contact_email || '',
    categories: JSON.parse(out.categories || '[]'),
    locations: JSON.parse(out.locations || '[]'),
  };
}

async function setSetting(q, key, value) {
  await q.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, typeof value === 'string' ? value : JSON.stringify(value)]);
}

module.exports = { DEFAULT_SETTINGS, seedDefaultSettings, getSettings, setSetting };
