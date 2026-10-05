// Seeding must NEVER send real email, whatever SMTP credentials are configured (root cause: the seed scripts `delete`d SMTP_USER / SMTP_PASS and
// then loaded the app, whose src/env.js re-read the developer's .env and put them back). Proven here with real child processes, a .env-style file
// holding "credentials" for a fake SMTP server, and a count of connections that server received. The same fake server proves the normal
// (non-seed) mailer still delivers, and that "Send me a test email" sends exactly one message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, setupAdmin } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PROBE_MAIL = path.join(ROOT, 'test-support', 'mail-probe.js');
const PROBE_SEED = path.join(ROOT, 'test-support', 'seed-probe.js');
const SEED_VERIFY = path.join(ROOT, 'scripts', 'seed-verify.js');
const TEST_RECIPIENT = 'qa.inbox@nutricost.com';

// A just-enough SMTP server: counts connections and records each message's envelope recipients and body.
function fakeSmtp() {
  const state = { connections: 0, messages: [] };
  const server = net.createServer((sock) => {
    state.connections++;
    let buf = ''; let inData = false; let cur = { rcpt: [], body: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return;
          cur.body = buf.slice(0, i).replace(/=\r\n/g, ''); buf = buf.slice(i + 5); inData = false;
          state.messages.push(cur); cur = { rcpt: [], body: '' }; sock.write('250 queued\r\n'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (up.startsWith('AUTH')) sock.write('235 ok\r\n');
        else if (up.startsWith('RCPT TO:')) { cur.rcpt.push(/<([^>]+)>/.exec(line)[1]); sock.write('250 ok\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (up === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}
// A .env-style file with "credentials" for the fake server, like a developer's real .env.
function envFile(dir, port) {
  const f = path.join(dir, 'dev.env');
  fs.writeFileSync(f, [`SMTP_HOST=127.0.0.1`, `SMTP_PORT=${port}`, 'SMTP_USER=dev@nutricost.com', 'SMTP_PASS=app-password', 'MAIL_FROM="Nutricost IT <dev@nutricost.com>"', `MAIL_TEST_RECIPIENT=${TEST_RECIPIENT}`, ''].join('\n'));
  return f;
}
// Run a script in a child with a MINIMAL environment (no inherited SMTP / flags), so only the .env-style file can supply credentials.
function run(script, args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nc-mailsafe-'));
const outboxOf = (dataDir) => { const d = new Database(path.join(dataDir, 'assets.db'), { readonly: true }); try { return d.prepare('SELECT to_addr, status, delivered_to FROM outbox').all(); } finally { d.close(); } };

test('CONTROL: outside seed mode the real mailer delivers one message to the fake SMTP server, redirected to MAIL_TEST_RECIPIENT', async () => {
  const smtp = await fakeSmtp(); const dir = tmp();
  try {
    const r = await run(PROBE_MAIL, [dir, 'dana.ito@example.com'], { NC_ENV_FILE: envFile(dir, smtp.port) });
    assert.equal(r.code, 0, r.err);
    assert.equal(smtp.state.connections, 1);
    assert.equal(smtp.state.messages.length, 1);
    assert.deepEqual(smtp.state.messages[0].rcpt, [TEST_RECIPIENT], 'redirected');
    assert.match(smtp.state.messages[0].body, /DEV TEST MODE/);
    assert.ok(smtp.state.messages[0].body.includes('dana.ito@example.com'), 'intended recipient is visible');
    assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()), [{ to_addr: 'dana.ito@example.com', status: 'sent', delivered_to: TEST_RECIPIENT }]);
  } finally { await smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with NC_NO_EXTERNAL_MAIL=1 even the real mailer cannot reach the SMTP server, and does not read the .env file at all', async () => {
  const smtp = await fakeSmtp(); const dir = tmp();
  try {
    const r = await run(PROBE_MAIL, [dir, 'dana.ito@example.com'], { NC_ENV_FILE: envFile(dir, smtp.port), NC_NO_EXTERNAL_MAIL: '1' });
    assert.equal(r.code, 0, r.err);
    assert.equal(smtp.state.connections, 0);
    assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()), [{ to_addr: 'dana.ito@example.com', status: 'logged', delivered_to: null }], 'recorded, not sent, and no redirect (.env was never loaded)');
    // and credentials given directly in the environment are ignored too
    const r2 = await run(PROBE_MAIL, [dir, 'x@example.com'], { NC_NO_EXTERNAL_MAIL: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_TEST_RECIPIENT: TEST_RECIPIENT });
    assert.equal(r2.code, 0, r2.err);
    assert.equal(smtp.state.connections, 0);
  } finally { await smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seed:dev (seedDatabase) creates its accounts and invites but makes no connection to an SMTP server, even with credentials in .env', async () => {
  const smtp = await fakeSmtp(); const dir = tmp(); const data = path.join(dir, 'data');
  try {
    const r = await run(PROBE_SEED, [data], { NC_ENV_FILE: envFile(dir, smtp.port) }); // NOTE: no NC_NO_EXTERNAL_MAIL here: the seed must set it itself
    assert.equal(r.code, 0, r.err);
    assert.equal(smtp.state.connections, 0, 'no SMTP connection was attempted');
    assert.equal(smtp.state.messages.length, 0);
    const rows = outboxOf(data);
    assert.ok(rows.length >= 9, `seeding really did try to send invites (${rows.length} outbox rows)`);
    assert.deepEqual([...new Set(rows.map((x) => x.status))], ['logged'], 'every message was only recorded');
    assert.deepEqual([...new Set(rows.map((x) => x.delivered_to))], [null], 'nothing was redirected anywhere either');
  } finally { await smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seed:verify makes no connection to an SMTP server, even with credentials in .env', async () => {
  const smtp = await fakeSmtp(); const dir = tmp();
  try {
    const r = await run(SEED_VERIFY, [], { NC_ENV_FILE: envFile(dir, smtp.port), TMPDIR: dir });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /seed:verify OK/);
    assert.equal(smtp.state.connections, 0);
  } finally { await smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('"Send me a test email" sends exactly one message, redirected, and the redirect still works after seeding code has run', async () => {
  const keep = process.env.MAIL_TEST_RECIPIENT;
  const booted = bootApp(); const server = await startServer(booted.app);
  const mailer = require('../src/mailer'); const sent = [];
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  try {
    process.env.MAIL_TEST_RECIPIENT = TEST_RECIPIENT;
    const { client, admin } = await setupAdmin(server);
    const before = booted.db.prepare('SELECT COUNT(*) c FROM outbox').get().c;
    const r = await client.post('/api/settings/test-email', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'sent');
    assert.equal(sent.length, 1, 'exactly one message');
    assert.equal(sent[0].to, TEST_RECIPIENT);
    assert.match(sent[0].subject, new RegExp(`^\\[DEV for ${admin.email.replace('.', '\\.')}\\]`));
    assert.equal(booted.db.prepare('SELECT COUNT(*) c FROM outbox').get().c - before, 1, 'one outbox row');
    assert.equal(booted.db.prepare("SELECT delivered_to d FROM outbox WHERE to_addr = ? ORDER BY id DESC").get(admin.email).d, TEST_RECIPIENT);
  } finally {
    if (keep === undefined) delete process.env.MAIL_TEST_RECIPIENT; else process.env.MAIL_TEST_RECIPIENT = keep;
    mailer.setTransportForTests(null); await stopServer(server);
  }
});

test('the test harness itself never creates a real SMTP transport, so `npm test` cannot send mail from a developer machine', () => {
  const keep = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS, f: process.env.NC_NO_EXTERNAL_MAIL };
  try {
    process.env.SMTP_USER = 'dev@nutricost.com'; process.env.SMTP_PASS = 'app-password';
    bootApp();
    assert.equal(process.env.NC_NO_EXTERNAL_MAIL, '1');
    assert.equal(require('../src/mailer').mailConfigured(), false);
  } finally { for (const [k, v] of [['SMTP_USER', keep.u], ['SMTP_PASS', keep.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
