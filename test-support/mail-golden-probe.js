// Test support (not a test), Slice 5A golden master of the mailer. Run in a FRESH process per scenario (the transport is built
// from the environment when the mailer is created):
//   node test-support/mail-golden-probe.js <scenario> sqlite <data dir>
//   node test-support/mail-golden-probe.js <scenario> pg <local test database url>
// Sets the scenario's environment, creates the same admin accounts and IT-email settings through the engine, calls EVERY
// notify.* with fixed fixtures (one at a time, waiting for each to finish), and prints JSON: mailConfigured, APP_URL, the
// envelope, testRecipient, deliveryFor samples, the outbox rows (to_addr, subject, body, status, error, delivered_to), what the
// fake transport received (from, replyTo, to, subject, html) and the [mail...] log lines. test/mail-golden.test.js compares the
// SQLite output with test/fixtures/mail-golden.json; test/pg/pg-mailer.test.js compares the PostgreSQL output with it.
// No real email: no scenario has a reachable SMTP server; scenarios that need a transport inject a fake one.
const [scenario, engine, target] = process.argv.slice(2);

const SCENARIOS = {
  // no transport at all: every message is recorded as 'logged'
  logged: { env: {} },
  // a fake transport that accepts everything; From = display name + verified sender, Reply-To = IT contact
  sent: { env: { MAIL_FROM: '"Nutricost IT" <sender@nutricost.com>' }, transport: 'ok' },
  // the operator allows the IT contact address as the From address
  allow_it_from: { env: { SMTP_USER: 'smtp-user@nutricost.com', MAIL_ALLOW_IT_FROM: '1' }, transport: 'ok', unblocked: true }, // (SMTP_USER without SMTP_PASS: still no transport)
  // DEV redirect to one address (subject prefix + banner, delivered_to recorded)
  redirect: { env: { MAIL_TEST_RECIPIENT: 'dev-inbox@nutricost.com' }, transport: 'ok' },
  // an invalid redirect fails closed: nothing is sent, every row 'failed'
  redirect_invalid: { env: { MAIL_TEST_RECIPIENT: 'not an address' }, transport: 'ok' },
  // the transport throws: rows 'failed' with the error
  transport_fails: { env: {}, transport: 'fail' },
  // NC_NO_EXTERNAL_MAIL=1 with SMTP credentials pointing at a closed local port: no transport is ever built from them
  blocked: { env: { NC_NO_EXTERNAL_MAIL: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'u@nutricost.com', SMTP_PASS: 'p' } },
};

const sc = SCENARIOS[scenario];
if (!sc || !['sqlite', 'pg'].includes(engine) || !target) {
  console.error('usage: mail-golden-probe.js <scenario> sqlite|pg <data dir | database url>');
  process.exit(2);
}
for (const k of ['MAIL_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT', 'MAIL_TEST_RECIPIENT', 'MAIL_ALLOW_IT_FROM', 'NC_NO_EXTERNAL_MAIL']) delete process.env[k];
if (!sc.unblocked && !sc.env.NC_NO_EXTERNAL_MAIL) process.env.NC_NO_EXTERNAL_MAIL = '1'; // (a fake transport is injected below; nothing is ever built from the environment)
Object.assign(process.env, sc.env, { APP_URL: 'https://assets.example.test/', APP_TIMEZONE: 'UTC', TZ: 'UTC' });

const logs = [];
for (const level of ['log', 'error']) {
  const orig = console[level];
  console[level] = (...a) => { const line = a.map((x) => (x instanceof Error ? `Error: ${x.message}` : String(x))).join(' '); if (/^\[mail/.test(line)) logs.push(line); else orig(...a); };
}

const user = { name: 'Ana <Asker>', email: 'ana@example.com', department: 'Ops & Co' };
const noMail = { name: 'Eve NoMail', email: null, department: null };
const asset = { id: 7, name: 'Camera "X"', tag: 'NC-0007', serial: 'SN-1', category: 'Cameras', reservation_requires_approval: 0 };
const assetApproval = { id: 8, name: 'Lab Scope', tag: 'NC-0008', serial: null, category: null, reservation_requires_approval: 1 };
const entry = { start_date: '2026-11-03', start_time: '08:00', end_date: '2026-11-03', end_time: '13:00', hold_expires_at: '2026-11-01 15:30:00' };
const entryDays = { start_date: '2026-11-03', start_time: null, end_date: '2026-11-05', end_time: '13:00', hold_expires_at: '2026-11-02 09:05:00' };
const resv = { start_date: '2026-11-02', start_time: null, end_date: '2026-11-04', end_time: null };
const piece = (s, e, status) => ({ start_date: s, start_time: null, end_date: e, end_time: null, status });
const CALLS = [
  ['welcome', (n) => n.welcome(user, 'https://assets.example.test/#/set-password?t=abc')],
  ['passwordReset', (n) => n.passwordReset(user, 'https://assets.example.test/#/reset?t=def')],
  ['checkedOut', (n) => n.checkedOut(user, asset, { due_date: '2026-11-03', due_time: '17:00' })],
  ['checkedOut no due', (n) => n.checkedOut(user, assetApproval, { due_date: null })],
  ['selfCheckoutToAdmins', (n) => n.selfCheckoutToAdmins(user, asset)],
  ['checkedIn', (n) => n.checkedIn(user, asset)],
  ['returnRequested', (n) => n.returnRequested(user, asset, { needed_by: '2026-11-05', message: 'Please <return> it' })],
  ['returnRequested bare', (n) => n.returnRequested(user, asset, {})],
  ['droppedOff', (n) => n.droppedOff(user, asset)],
  ['equipmentRequested permanent', (n) => n.equipmentRequested(user, { requested_assignment_type: 'permanent', catalog_path: 'Laptops > Mac', asset_label: 'MBP 14', message: 'need it', needed_by: '2026-11-10' })],
  ['equipmentRequested any', (n) => n.equipmentRequested({ name: 'Ben', email: 'ben@example.com' }, { requested_assignment_type: 'temporary', catalog_path: 'Monitors', category: null })],
  ['equipmentRequested legacy', (n) => n.equipmentRequested({ name: 'Ben', email: 'ben@example.com' }, { category: 'Headset' })],
  ['requestResolved approved', (n) => n.requestResolved(user, { status: 'approved', catalog_path: 'Laptops > Mac', resolution_note: 'Pick up at IT' }, asset)],
  ['requestResolved declined', (n) => n.requestResolved(user, { status: 'declined', category: 'Phone' }, null)],
  ['overdue', (n) => n.overdue(user, asset, { due_date: '2026-10-30' })],
  ['waitlistJoined', (n) => n.waitlistJoined(user, { name: 'Fay', email: 'fay@example.com', department: 'Lab' }, asset, entry, resv)],
  ['waitlistJoined updated', (n) => n.waitlistJoined(user, { name: 'Fay', email: null, department: null }, asset, entryDays, resv, { updated: true })],
  ['waitlistHold', (n) => n.waitlistHold(user, asset, entry)],
  ['waitlistHold approval', (n) => n.waitlistHold(user, assetApproval, entryDays)],
  ['requestRecorded confirmed', (n) => n.requestRecorded(user, asset, { requested: resv, reserved: [piece('2026-11-02', '2026-11-04', 'confirmed')] })],
  ['requestRecorded pending', (n) => n.requestRecorded(user, assetApproval, { requested: resv, reserved: [piece('2026-11-02', '2026-11-04', 'pending')] })],
  ['requestRecorded waitlisted', (n) => n.requestRecorded(user, asset, { requested: resv, waitlisted: [piece('2026-11-02', '2026-11-04')] })],
  ['requestRecorded partial pending', (n) => n.requestRecorded(user, assetApproval, { requested: resv, reserved: [piece('2026-11-02', '2026-11-02', 'pending'), piece('2026-11-04', '2026-11-04', 'pending')], waitlisted: [piece('2026-11-03', '2026-11-03')] })],
  ['requestRecorded partial confirmed', (n) => n.requestRecorded(user, asset, { requested: resv, reserved: [piece('2026-11-02', '2026-11-02', 'confirmed')], waitlisted: [piece('2026-11-03', '2026-11-04')] })],
  ['no address', (n) => n.checkedIn(noMail, asset)],
  ['test', (n) => n.test('it-test@example.com')],
];

const drain = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  const sent = [];
  let mailer; let outboxRows; let done = async () => {};
  if (engine === 'sqlite') {
    process.env.DATA_DIR = target;
    mailer = require('../src/mailer');
    const { db, setSetting } = require('../src/db');
    const acct = db.prepare('INSERT INTO accounts (login_email, role, active) VALUES (?, ?, ?)');
    acct.run('admin.one@nutricost.com', 'admin', 1); acct.run('employee@nutricost.com', 'employee', 1);
    acct.run('admin.gone@nutricost.com', 'admin', 0); acct.run('admin.two@nutricost.com', 'admin', 1);
    setSetting('it_email_name', 'Nutricost IT Desk'); setSetting('it_contact_email', 'it-desk@nutricost.com');
    outboxRows = async () => db.prepare('SELECT to_addr, subject, body, status, error, delivered_to FROM outbox ORDER BY id').all();
  } else {
    const { createPool } = require('../src/pg/pool');
    const { assertLocalDatabaseUrl } = require('../src/pg/local-url');
    const pool = createPool(assertLocalDatabaseUrl(target, 'mail-golden-probe'));
    const settings = require('../src/pg/settings');
    await settings.seedDefaultSettings(pool);
    for (const [e, r, a] of [['admin.one@nutricost.com', 'admin', 1], ['employee@nutricost.com', 'employee', 1], ['admin.gone@nutricost.com', 'admin', 0], ['admin.two@nutricost.com', 'admin', 1]]) {
      await pool.query('INSERT INTO accounts (login_email, role, active) VALUES ($1, $2, $3)', [e, r, a]);
    }
    await settings.setSetting(pool, 'it_email_name', 'Nutricost IT Desk'); await settings.setSetting(pool, 'it_contact_email', 'it-desk@nutricost.com');
    mailer = require('../src/pg/mailer').createPgMailer(pool);
    outboxRows = async () => (await pool.query('SELECT to_addr, subject, body, status, error, delivered_to FROM outbox ORDER BY id')).rows;
    done = () => pool.end();
  }
  const out = { scenario, mailConfigured: mailer.mailConfigured(), APP_URL: mailer.APP_URL };
  if (sc.transport === 'ok') mailer.setTransportForTests({ sendMail: async (m) => { sent.push({ from: m.from, replyTo: m.replyTo === undefined ? '<undefined>' : m.replyTo, to: m.to, subject: m.subject, html: m.html }); } });
  if (sc.transport === 'fail') mailer.setTransportForTests({ sendMail: async () => { throw new Error('550 mailbox unavailable'); } });
  out.mailConfiguredAfter = mailer.mailConfigured();
  out.envelope = await mailer.mailEnvelope();
  out.testRecipient = mailer.testRecipient();
  out.deliveryFor = mailer.deliveryFor('x@example.com', 'Subject', '<html><body class="a">Hi</body></html>');
  out.deliveryForNoBody = mailer.deliveryFor('x@example.com', 'S', 'plain');
  out.calls = [];
  for (const [label, call] of CALLS) {
    const rows = (await outboxRows()).length; const sentBefore = sent.length; const logsBefore = logs.length;
    const r = call(mailer.notify);
    if (r && typeof r.then === 'function') await r;
    await drain();
    out.calls.push({ label, returned: r === undefined ? 'undefined' : typeof r.then === 'function' ? 'promise' : typeof r, rows: (await outboxRows()).slice(rows), sent: sent.slice(sentBefore), logs: logs.slice(logsBefore) });
  }
  await done();
  process.stdout.write(JSON.stringify(out), () => process.exit(0)); // (exit only once the pipe has the whole output)
})().catch((err) => { console.error(err); process.exit(1); });
