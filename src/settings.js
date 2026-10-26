// The settings table (SQLite), for the routes on the temporary driver seam. PostgreSQL migration Slice 5B-4 (D-48): the SQL and the
// parsing of src/db.js `getSettings` / `setSetting`, copied VERBATIM with the database handle as the first argument, like the other data
// modules (`await data.settings.getSettings()`). src/db.js is unchanged (no-touch): it still seeds the defaults at startup, and its own
// getSettings / setSetting stay for src/mailer.js (the SQLite mail adapter, not a route). The two copies must not drift:
// test/data-seam-remaining.test.js checks they read and write the same values. The PostgreSQL twin is src/pg/settings.js (same names,
// first argument `q`). Removed at the cutover with the other SQLite modules.

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
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
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

module.exports = { getSettings, setSetting };
