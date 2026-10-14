// Case-insensitive lookups on PostgreSQL (D-46, Slice 3). Fixes the idiom Slice 5 converts server.js to: SQLite's
// COLLATE NOCASE columns (assets.tag, accounts.login_email, employees.work_email) become `lower(col) = lower($1)` in
// PostgreSQL, backed by the baseline's UNIQUE lower() indexes. Under COLLATE "C" lower() folds ASCII letters only — the
// same rule as SQLite's NOCASE — so non-ASCII letters stay distinct on both. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { buildSqliteReference } = require('../../test-support/pg-parity');
const fx = require('../../test-support/pg-fixtures');

const LOOKUPS = [
  { table: 'assets', col: 'tag', index: 'assets_tag_lower_key', stored: 'NC-Ab12', variants: ['nc-ab12', 'NC-AB12', 'nC-aB12'], make: (q, v) => fx.insertAsset(q, { tag: v }) },
  { table: 'accounts', col: 'login_email', index: 'accounts_login_email_lower_key', stored: 'Pat.Smith@Nutricost.com', variants: ['pat.smith@nutricost.com', 'PAT.SMITH@NUTRICOST.COM'], make: (q, v) => fx.insertAccount(q, { login_email: v }) },
  { table: 'employees', col: 'work_email', index: 'idx_employees_work_email', stored: 'Lee.Wong@Nutricost.com', variants: ['lee.wong@nutricost.com', 'LEE.WONG@nutricost.COM'], make: (q, v) => fx.insertEmployee(q, { work_email: v }) },
];

describe('PostgreSQL case-insensitive lookup idiom (lower(col) = lower($1))', pgSuite(), () => {
  let tdb; let pool;
  before(async () => { tdb = await createTestDatabase(); pool = tdb.pool; });
  after(async () => { await tdb?.drop(); });

  for (const l of LOOKUPS) {
    test(`${l.table}.${l.col}: case variants find the row, the unique index rejects them, and the stored text keeps its case`, async () => {
      const row = await l.make(pool, l.stored);
      for (const v of l.variants) {
        const found = (await pool.query(`SELECT id, ${l.col} AS v FROM ${l.table} WHERE lower(${l.col}) = lower($1)`, [v])).rows;
        assert.deepEqual(found, [{ id: row.id, v: l.stored }], `lookup by ${v}`);
        assert.equal((await pool.query(`SELECT id FROM ${l.table} WHERE ${l.col} = $1`, [v])).rows.length, 0, 'a plain = stays case-sensitive (byte order), so it is NOT the idiom');
        await assert.rejects(l.make(pool, v), (err) => err.code === '23505' && err.constraint === l.index, `inserting ${v}`);
      }
      assert.equal((await pool.query(`SELECT id FROM ${l.table} WHERE lower(${l.col}) = lower($1)`, ['nobody-here'])).rows.length, 0);
    });
  }

  test('only ASCII letters fold, exactly like SQLite NOCASE (É and é stay different)', async () => {
    await fx.insertAsset(pool, { tag: 'NC-É1' });
    const pgFound = (await pool.query('SELECT tag FROM assets WHERE lower(tag) = lower($1)', ['nc-é1'])).rows.length;
    const pgDup = await fx.insertAsset(pool, { tag: 'nc-é1' }).then(() => 'inserted', (e) => e.code);
    const sqlite = buildSqliteReference();
    sqlite.prepare("INSERT INTO assets (tag, name) VALUES ('NC-É1', 'x')").run();
    const sqliteFound = sqlite.prepare('SELECT tag FROM assets WHERE tag = ? COLLATE NOCASE').all('nc-é1').length;
    let sqliteDup = 'inserted';
    try { sqlite.prepare("INSERT INTO assets (tag, name) VALUES ('nc-é1', 'y')").run(); } catch (e) { sqliteDup = e.code; }
    sqlite.close();
    assert.deepEqual({ found: pgFound, insert: pgDup }, { found: sqliteFound, insert: sqliteDup });
    assert.deepEqual({ found: pgFound, insert: pgDup }, { found: 0, insert: 'inserted' });
  });

  test('text search keeps ASCII-insensitive matching: lower() on both sides (or ILIKE) behaves like SQLite LIKE', async () => {
    await fx.insertAsset(pool, { tag: 'NC-SRCH1', name: 'MacBook Air M3' });
    const sqlite = buildSqliteReference();
    sqlite.prepare("INSERT INTO assets (tag, name) VALUES ('NC-SRCH1', 'MacBook Air M3')").run();
    for (const term of ['macbook', 'AIR', 'm3', 'Book a', 'pro']) {
      const like = sqlite.prepare("SELECT COUNT(*) c FROM assets WHERE name LIKE '%' || ? || '%'").get(term).c;
      const viaLower = (await pool.query("SELECT COUNT(*) c FROM assets WHERE lower(name) LIKE '%' || lower($1) || '%'", [term])).rows[0].c;
      const viaIlike = (await pool.query("SELECT COUNT(*) c FROM assets WHERE name ILIKE '%' || $1 || '%'", [term])).rows[0].c;
      assert.deepEqual([viaLower, viaIlike], [like, like], `term "${term}"`);
    }
    sqlite.close();
  });
});
