// The PostgreSQL mailer (Slice 5A, D-48 point 5): the shared mail core (src/mailCore.js) over a PostgreSQL adapter. Same templates,
// envelope, transport rules, MAIL_TEST_RECIPIENT redirect and outbox rows as the SQLite mailer (src/mailer.js); D-35 to D-39 hold
// unchanged (test/pg/pg-mailer.test.js runs the golden master of the SQLite mailer against it). NOT used by the running app yet
// (Slice 5D installs it behind the effects notifier, src/pg/notifier.js).
//
// createPgMailer(pool) -> { notify, APP_URL, mailConfigured, mailEnvelope (a promise), testRecipient, deliveryFor, setTransportForTests }
//   - outbox rows go into the PostgreSQL `outbox` table, one per recipient ('logged' / 'sent' / 'failed', delivered_to);
//   - the IT-wide notices go to the active admin accounts (`accounts`, ORDER BY id: SQLite's rowid order);
//   - the From display name and Reply-To come from src/pg/settings.js.
//   notify.* return a promise that never rejects (errors are logged '[mail]'). They run on the POOL, never inside a caller's
//   transaction, and are only ever called from after-commit effects: no email can precede a COMMIT, and no SMTP runs while an
//   asset lock is held.
const { createMailer } = require('../mailCore');
const settings = require('./settings');

function createPgMailer(pool) {
  return createMailer({
    record: (r) => pool.query('INSERT INTO outbox (to_addr, subject, body, status, error, delivered_to) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.to_addr, r.subject, r.body, r.status, r.error, r.delivered_to]),
    adminEmails: async () => (await pool.query("SELECT login_email FROM accounts WHERE role = 'admin' AND active = 1 ORDER BY id")).rows.map((r) => r.login_email),
    getSettings: () => settings.getSettings(pool),
  }, { awaitable: true });
}

module.exports = { createPgMailer };
