// The PostgreSQL mailer (Slice 5A, D-48 point 5; D-35 to D-39): src/pg/mailer.js createPgMailer(pool) is the shared mail core
// over a PostgreSQL adapter, and must send exactly what the SQLite mailer sends. Proved here:
//   - golden master: every notify.* template under every environment scenario (no transport, a fake transport, MAIL_ALLOW_IT_FROM,
//     the MAIL_TEST_RECIPIENT redirect, an invalid redirect failing closed, a throwing transport, NC_NO_EXTERNAL_MAIL with SMTP
//     credentials) gives the same recipients, subjects, bodies, outbox rows (status, error, delivered_to), transport envelope
//     (From / Reply-To), log lines, mailConfigured, envelope and deliveryFor as test/fixtures/mail-golden.json (the pre-refactor
//     SQLite mailer). The rows are read back from the PostgreSQL `outbox` table. The one intended difference: PG notify.* return
//     a promise (SQLite's return undefined).
//   - notify.* promises never reject: a failing outbox insert, a failing admin lookup, a throwing template are logged '[mail]'.
//   - the admin list is the active admins in id order; a recipient-less message writes nothing.
// Each golden scenario runs in a fresh child process (the transport is built from the environment when the mailer is created)
// against its own throwaway local database. No real email is ever sent. Skipped without PostgreSQL.
process.env.NC_NO_EXTERNAL_MAIL = '1';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { SCENARIOS, FIXTURE, runProbe, compact } = require('../../test-support/mail-golden');
const { createPgMailer } = require('../../src/pg/mailer');
const settings = require('../../src/pg/settings');

const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); try { await fn(); } finally { console.error = orig; } return seen; };

describe('PostgreSQL mailer == the SQLite golden master (Slice 5A)', pgSuite(), () => {
  for (const scenario of SCENARIOS) {
    test(`PG mailer == golden master: ${scenario}`, async () => {
      const tdb = await createTestDatabase();
      try {
        await tdb.pool.end(); // (the probe connects on its own; the harness pool is not needed)
        const bodies = {};
        const now = compact(runProbe(scenario, 'pg', tdb.url), bodies);
        const want = structuredClone(golden.scenarios[scenario]);
        for (const [i, call] of now.calls.entries()) {
          assert.equal(call.returned, 'promise', `${scenario}: ${call.label} returns a promise on PostgreSQL`);
          call.returned = want.calls[i].returned; // (SQLite: undefined, except notify.test) - the one intended difference
        }
        for (const [h, text] of Object.entries(bodies)) assert.equal(text, golden.bodies[h], `${scenario}: body ${h.slice(0, 12)} is a known golden body`);
        assert.deepEqual(now, want, scenario);
      } finally {
        await tdb.drop();
      }
    });
  }
});

describe('PostgreSQL mailer: never rejects, outbox rows in PostgreSQL (Slice 5A)', pgSuite(), () => {
  let tdb; let pool;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    await settings.seedDefaultSettings(pool);
    for (const [e, r, a] of [['b.admin@nutricost.com', 'admin', 1], ['a.admin@nutricost.com', 'admin', 1], ['off.admin@nutricost.com', 'admin', 0], ['emp@nutricost.com', 'employee', 1]]) {
      await pool.query('INSERT INTO accounts (login_email, role, active) VALUES ($1, $2, $3)', [e, r, a]);
    }
  });
  after(async () => {
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  const outbox = async () => (await pool.query('SELECT to_addr, subject, status, error, delivered_to FROM outbox ORDER BY id')).rows;
  const user = { name: 'Ana', email: 'ana@example.com' };
  const asset = { id: 1, name: 'Cam', tag: 'NC-1' };

  test('rows land in the PostgreSQL outbox; the IT-wide notices go to the active admins in id order; no address, no row', async () => {
    await pool.query('DELETE FROM outbox');
    const mailer = createPgMailer(pool);
    assert.equal(mailer.mailConfigured(), false, 'NC_NO_EXTERNAL_MAIL: no transport');
    assert.equal(await mailer.notify.droppedOff(user, asset), undefined);
    assert.equal(await mailer.notify.checkedIn({ name: 'Nobody', email: null }, asset), undefined);
    assert.deepEqual((await outbox()).map((r) => [r.to_addr, r.status]), [['b.admin@nutricost.com', 'logged'], ['a.admin@nutricost.com', 'logged']]);
  });

  test('notify.* promises never reject: a failing outbox insert, a failing admin lookup and a throwing template are logged', async () => {
    const broken = {
      query: async (text, params) => {
        if (/INSERT INTO outbox/.test(text)) throw new Error('outbox is down');
        if (/FROM accounts/.test(text)) throw new Error('accounts are down');
        return pool.query(text, params);
      },
    };
    const mailer = createPgMailer(broken);
    let results;
    const logged = await quietly(async () => {
      results = await Promise.allSettled([
        mailer.notify.checkedIn(user, asset), // the outbox insert fails
        mailer.notify.droppedOff(user, asset), // the admin lookup fails
        mailer.notify.checkedOut(null, asset, {}), // the template throws on a missing user
      ]);
    });
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assert.ok(logged.some((l) => l.startsWith('[mail]') && l.includes('outbox is down')), logged.join('\n'));
    assert.ok(logged.some((l) => l.startsWith('[mail]') && l.includes('accounts are down')), logged.join('\n'));
    assert.equal(logged.filter((l) => l.startsWith('[mail]')).length, 3, logged.join('\n'));
  });

  test('a throwing transport: outbox rows `failed` with the error, the promise resolves', async () => {
    await pool.query('DELETE FROM outbox');
    const mailer = createPgMailer(pool);
    mailer.setTransportForTests({ sendMail: async () => { throw new Error('421 try later'); } });
    const logged = await quietly(() => mailer.notify.checkedIn(user, asset));
    assert.deepEqual(await outbox(), [{ to_addr: 'ana@example.com', subject: 'Returned: Cam (NC-1)', status: 'failed', error: '421 try later', delivered_to: null }]);
    assert.ok(logged.some((l) => l.startsWith('[mail:error]')));
  });
});
