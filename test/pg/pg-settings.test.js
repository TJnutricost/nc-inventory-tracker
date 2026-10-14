// src/pg/settings.js (D-46, Slice 3): default seeding, getSettings typing and setSetting upserts on PostgreSQL, and parity
// with the SQLite original — src/db.js is loaded under a throwaway DATA_DIR (as the app tests do) and must produce exactly
// the same settings on a fresh database. Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { withTransaction } = require('../../src/pg/transaction');
const pgSettings = require('../../src/pg/settings');

// The SQLite original, on a throwaway database (never the real data/ directory).
function loadSqliteSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pg-settings-'));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../../src/db')];
  const mod = require('../../src/db');
  return { ...mod, cleanup: () => { mod.db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('PostgreSQL settings', pgSuite(), () => {
  let tdb; let pool; let sqlite;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sqlite = loadSqliteSettings();
  });
  after(async () => {
    sqlite?.cleanup();
    await tdb?.drop();
  });

  test('a fresh database seeded with the defaults reads exactly like a fresh SQLite database (values and raw rows)', async () => {
    assert.equal((await pool.query('SELECT COUNT(*) c FROM settings')).rows[0].c, 0, 'the baseline itself writes no settings');
    await pgSettings.seedDefaultSettings(pool);
    assert.deepEqual(await pgSettings.getSettings(pool), sqlite.getSettings());
    const pgRows = (await pool.query('SELECT key, value FROM settings ORDER BY key')).rows;
    const sqliteRows = sqlite.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    assert.deepEqual(pgRows, sqliteRows);
  });

  test('seeding again never overwrites a value (INSERT OR IGNORE -> ON CONFLICT DO NOTHING)', async () => {
    await pgSettings.setSetting(pool, 'tag_prefix', 'IT-');
    await pgSettings.seedDefaultSettings(pool);
    assert.equal((await pgSettings.getSettings(pool)).tag_prefix, 'IT-');
    await pgSettings.setSetting(pool, 'tag_prefix', 'NC-');
  });

  test('setSetting upserts strings as-is and anything else as JSON; getSettings types every field', async () => {
    const pairs = [
      ['default_loan_days', '14'], ['overdue_reminders', '0'], ['it_email_name', 'Help Desk'], ['it_contact_email', 'it@nutricost.com'],
      ['categories', ['Laptop', 'Camera']], ['locations', ['Lab']],
    ];
    for (const [k, v] of pairs) {
      await pgSettings.setSetting(pool, k, v);
      sqlite.setSetting(k, v);
    }
    const got = await pgSettings.getSettings(pool);
    assert.deepEqual(got, { default_loan_days: 14, tag_prefix: 'NC-', overdue_reminders: false, it_email_name: 'Help Desk', it_contact_email: 'it@nutricost.com', categories: ['Laptop', 'Camera'], locations: ['Lab'] });
    assert.deepEqual(got, sqlite.getSettings());
    assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'categories'")).rows[0].value, '["Laptop","Camera"]');

    await pgSettings.setSetting(pool, 'overdue_reminders', '1');
    sqlite.setSetting('overdue_reminders', '1');
    assert.equal((await pgSettings.getSettings(pool)).overdue_reminders, true);
    assert.equal((await pool.query("SELECT COUNT(*) c FROM settings WHERE key = 'overdue_reminders'")).rows[0].c, 1, 'an upsert, never a second row');
  });

  test('missing or blank values fall back exactly like SQLite (and an unknown key is ignored by getSettings)', async () => {
    for (const k of ['default_loan_days', 'tag_prefix', 'it_email_name', 'it_contact_email', 'categories', 'locations']) {
      await pgSettings.setSetting(pool, k, '');
      sqlite.setSetting(k, '');
    }
    await pgSettings.setSetting(pool, 'some_future_key', { a: 1 });
    sqlite.setSetting('some_future_key', { a: 1 });
    const got = await pgSettings.getSettings(pool);
    assert.deepEqual(got, sqlite.getSettings());
    assert.deepEqual([got.default_loan_days, got.tag_prefix, got.it_email_name, got.categories], [0, 'NC-', 'Nutricost IT', []]);
  });

  test('works on a transaction client, and a rolled-back setSetting leaves nothing behind', async () => {
    await assert.rejects(withTransaction(async (c) => {
      await pgSettings.setSetting(c, 'tag_prefix', 'TX-');
      assert.equal((await pgSettings.getSettings(c)).tag_prefix, 'TX-', 'visible inside its own transaction');
      throw new Error('roll back');
    }, pool), /roll back/);
    assert.equal((await pgSettings.getSettings(pool)).tag_prefix, 'NC-');
  });
});
