// The SQLite mailer: a thin adapter over the shared mail core (src/mailCore.js, Slice 5A, D-48). Same exports and behavior as
// before the split (test/mail-golden.test.js holds every template, envelope, redirect and outbox row to the pre-refactor output
// byte for byte): notify.* are fire-and-forget and return undefined; with no transport, the outbox row is written before
// notify returns. The PostgreSQL adapter is src/pg/mailer.js.
const { db, getSettings } = require('./db');
const { createMailer } = require('./mailCore');

const mailer = createMailer({
  record: (r) => {
    db.prepare('INSERT INTO outbox (to_addr, subject, body, status, error, delivered_to) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.to_addr, r.subject, r.body, r.status, r.error, r.delivered_to);
  },
  adminEmails: () => db.prepare("SELECT login_email FROM accounts WHERE role='admin' AND active=1").all().map((r) => r.login_email),
  getSettings,
});

const { notify, APP_URL, mailConfigured, mailEnvelope, testRecipient, deliveryFor, setTransportForTests } = mailer;
module.exports = { notify, APP_URL, mailConfigured, mailEnvelope, testRecipient, deliveryFor, setTransportForTests };
