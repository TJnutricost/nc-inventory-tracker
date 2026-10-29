// Reset / invitation tokens at rest on PostgreSQL (security hardening, 2026-10-28; PG migration 4, src/pg/accounts.js). Proved here:
//   - the migration hashes the tokens that were outstanding (the SQL digest equals src/tokenHash.js hashToken) so emailed links keep
//     working, strips the token from outbox bodies, leaves other links alone, and applies cleanly a second time (no hash of a hash)
//   - replaceToken stores only the hash; getToken finds a token by the raw value and not by the stored hash; completeReset still spends
//     it (single use); expiry stays the route's check on the returned row
// Local throwaway databases only; skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { runMigrations } = require('../../src/pg/migrate');
const pgMigrations = require('../../src/pg/migrations');
const accounts = require('../../src/pg/accounts');
const { hashToken } = require('../../src/tokenHash');

const LATER = '2999-01-01T00:00:00.000Z';
const PAST = '2001-01-01T00:00:00.000Z';

describe('PostgreSQL hashed reset / invitation tokens', pgSuite(), () => {
  let tdb; let pool;
  before(async () => {
    tdb = await createTestDatabase({ migrate: false });
    pool = tdb.pool;
    assert.deepEqual(await runMigrations(pool, pgMigrations.filter((m) => m.id <= 3)), [1, 2, 3]);
    await pool.query("INSERT INTO employees (name, work_email) VALUES ('Legacy One', 'legacy1@x.com')");
    await pool.query("INSERT INTO accounts (employee_id, login_email) VALUES (1, 'legacy1@x.com')");
    await pool.query("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('legacyRawToken0123456789abcdefgh', 1, 'reset', $1), ('legacyForgotToken0123456789abcdef', 1, 'forgot', $1)", [LATER]);
    await pool.query(`INSERT INTO outbox (to_addr, subject, body, status) VALUES
      ('legacy1@x.com', 'Welcome', '<a href="https://it.x/#/reset/legacyRawToken0123456789abcdefgh">Set</a>', 'sent'),
      ('a@x.com', 'Other', '<a href="https://it.x/#/asset/3">Asset</a>', 'sent')`);
  });
  after(async () => { await tdb?.drop(); });

  test('migration 4 hashes outstanding tokens with the digest the app uses, redacts outbox links, and is safe to apply again', async () => {
    assert.deepEqual(await runMigrations(pool, pgMigrations), [4, 5]);
    const rows = (await pool.query('SELECT token, purpose FROM tokens ORDER BY purpose')).rows;
    assert.deepEqual(rows, [
      { token: hashToken('legacyForgotToken0123456789abcdef'), purpose: 'forgot' },
      { token: hashToken('legacyRawToken0123456789abcdefgh'), purpose: 'reset' },
    ]);
    assert.deepEqual((await pool.query('SELECT body FROM outbox ORDER BY id')).rows.map((r) => r.body),
      ['<a href="https://it.x/#/reset/[redacted]">Set</a>', '<a href="https://it.x/#/asset/3">Asset</a>']);
    const migration = pgMigrations.find((m) => m.id === 4);
    await pool.query(require('fs').readFileSync(require('path').join(__dirname, '../../src/pg/schema', migration.file), 'utf8'));
    assert.deepEqual((await pool.query('SELECT token FROM tokens ORDER BY purpose')).rows.map((r) => r.token), rows.map((r) => r.token), 'a second run changes nothing');
  });

  test('an emailed legacy link still finds its token after the migration, once', async () => {
    const t = await accounts.getToken(pool, 'legacyRawToken0123456789abcdefgh');
    assert.deepEqual([t.user_id, t.purpose, t.expires_at], [1, 'reset', LATER]);
    assert.equal(await accounts.getToken(pool, t.token), undefined, 'the stored hash is not a usable token');
    await accounts.completeReset(pool, 1, 'h-new');
    assert.equal(await accounts.getToken(pool, 'legacyRawToken0123456789abcdefgh'), undefined, 'spent');
  });

  test('replaceToken stores only the hash and replaces that purpose; an expired token is returned for the route to refuse', async () => {
    await accounts.replaceToken(pool, 1, 'reset', 'brandNewRawToken', LATER);
    await accounts.replaceToken(pool, 1, 'reset', 'brandNewerRawToken', PAST);
    assert.deepEqual((await pool.query('SELECT token, expires_at FROM tokens WHERE user_id = 1')).rows, [{ token: hashToken('brandNewerRawToken'), expires_at: PAST }]);
    assert.equal(await accounts.getToken(pool, 'brandNewRawToken'), undefined, 'the replaced token is dead');
    assert.equal((await accounts.getToken(pool, 'brandNewerRawToken')).expires_at, PAST);
    assert.equal(await accounts.getToken(pool, 'brandNewerRawToken\u0000'), undefined, 'a NUL character finds nothing');
    const dump = JSON.stringify((await pool.query('SELECT * FROM tokens')).rows);
    assert.ok(!dump.includes('brandNewerRawToken'), 'no raw token in the table');
  });
});
