// src/pg/time.js (D-46, Slice 3): PostgreSQL produces SQLite's exact TEXT "now" — 'YYYY-MM-DD HH:MM:SS' UTC, truncated to
// the second, one value per statement — and stored values compare as strings exactly as on SQLite.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { buildSqliteReference } = require('../../test-support/pg-parity');
const { withTransaction } = require('../../src/pg/transaction');
const pgTime = require('../../src/pg/time');
const fx = require('../../test-support/pg-fixtures');

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const utcNowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const secondsApart = (a, b) => Math.abs(Date.parse(`${a.replace(' ', 'T')}Z`) - Date.parse(`${b.replace(' ', 'T')}Z`)) / 1000;

describe('PostgreSQL time helpers (SQLite datetime/date(\'now\'))', pgSuite(), () => {
  let tdb; let pool;
  before(async () => { tdb = await createTestDatabase(); pool = tdb.pool; });
  after(async () => { await tdb?.drop(); });

  test('NOW and TODAY have SQLite\'s exact formats, in UTC, matching the clock', async () => {
    const [now, today] = [await pgTime.now(pool), await pgTime.today(pool)];
    assert.match(now, STAMP);
    assert.match(today, DAY);
    assert.ok(secondsApart(now, utcNowText()) <= 2, `${now} is the current UTC time`);
    assert.equal(today, now.slice(0, 10));
    const sqlite = buildSqliteReference();
    const ref = sqlite.prepare("SELECT datetime('now') AS n, date('now') AS d").get();
    assert.match(ref.n, STAMP, 'the SQLite reference uses the same shape');
    assert.equal(ref.n.length, now.length);
    sqlite.close();
  });

  test('fractions are truncated (not rounded) and the session time zone never leaks into the text', async () => {
    const at = "timestamptz '2026-03-08 09:59:59.999+00'";
    const { rows } = await pool.query(`SELECT ${pgTime.stampOf(at)} AS s, ${pgTime.dateOf("timestamptz '2026-03-08 23:30:00-07'")} AS d`);
    assert.equal(rows[0].s, '2026-03-08 09:59:59');
    assert.equal(rows[0].d, '2026-03-09', 'the UTC date, not the local one');
    await withTransaction(async (c) => {
      await c.query("SET LOCAL TimeZone = 'Pacific/Kiritimati'"); // UTC+14
      const r = (await c.query(`SELECT ${pgTime.NOW} AS n, ${pgTime.stampOf(at)} AS s`)).rows[0];
      assert.equal(r.s, '2026-03-08 09:59:59');
      assert.ok(secondsApart(r.n, utcNowText()) <= 2, 'NOW is still UTC under another session zone');
    }, pool);
  });

  test('one value per statement (like SQLite), a later statement in the same transaction gets a later time', async () => {
    const same = (await pool.query(`SELECT ${pgTime.NOW} AS a, pg_sleep(1.1)::text AS z, ${pgTime.NOW} AS b`)).rows[0];
    assert.equal(same.a, same.b, 'a single statement never straddles a second');
    const [first, second] = await withTransaction(async (c) => {
      const a = (await c.query(`SELECT ${pgTime.NOW} AS v`)).rows[0].v;
      await c.query('SELECT pg_sleep(1.1)');
      const b = (await c.query(`SELECT ${pgTime.NOW} AS v`)).rows[0].v;
      return [a, b];
    }, pool);
    assert.ok(second > first, `statement time advances inside a transaction (${first} -> ${second}); now() would not`);
  });

  test('the baseline column defaults write the same format as NOW when an INSERT omits the column', async () => {
    const e = await fx.insertEmployee(pool);
    const a = await fx.insertAsset(pool);
    const act = (await pool.query("INSERT INTO activity (asset_id, action) VALUES ($1, 'probe') RETURNING created_at", [a.id])).rows[0];
    const now = await pgTime.now(pool);
    for (const v of [e.created_at, a.created_at, a.updated_at, act.created_at]) {
      assert.match(v, STAMP);
      assert.ok(secondsApart(v, now) <= 2);
    }
    const inOne = (await pool.query(`INSERT INTO activity (asset_id, action, details) VALUES ($1, 'probe', ${pgTime.NOW}) RETURNING created_at, details`, [a.id])).rows[0];
    assert.equal(inOne.created_at, inOne.details, 'a default and NOW in one statement are the same text');
  });

  test('NOW_PLUS / nowPlus / stampPlus: SQLite datetime(base, \'+N seconds\') in the same truncated UTC text (Slice 4A)', async () => {
    const plus = await pgTime.nowPlus(pool, 3600);
    assert.match(plus, STAMP);
    assert.ok(Math.abs(secondsApart(plus, utcNowText()) - 3600) <= 2, `${plus} is an hour from now`);
    assert.match(await pgTime.nowPlus(pool, -90), STAMP);
    const { rows } = await pool.query(`SELECT ${pgTime.NOW_PLUS('$1')} AS a, ${pgTime.NOW} AS n, ${pgTime.NOW_PLUS('$2')} AS z`, [30, 0]);
    assert.equal(rows[0].z, rows[0].n, '+0 seconds is NOW (one statement time)');
    assert.equal(secondsApart(rows[0].a, rows[0].n), 30);
    // fractions: the sum is truncated to the second, never rounded, exactly like SQLite on the same inputs
    const sqlite = buildSqliteReference();
    const cases = [['2026-03-08 09:59:59.999', 0.5], ['2026-03-08 09:59:59.999', 1], ['2026-12-31 23:59:59.400', 0.7], ['2026-03-08 10:00:00.000', -0.25], ['2026-03-08 10:00:00.000', 86400 * 2]];
    for (const [base, secs] of cases) {
      const pg = (await pool.query(`SELECT ${pgTime.stampPlus(`timestamptz '${base}+00'`, '$1')} AS v`, [secs])).rows[0].v;
      const sq = sqlite.prepare('SELECT datetime(?, ?) AS v').get(base, `${secs >= 0 ? '+' : ''}${secs} seconds`).v;
      assert.equal(pg, sq, `${base} + ${secs}s`);
    }
    sqlite.close();
    // ordering against NOW: a hold written with NOW_PLUS(+N) is live, with NOW_PLUS(-N) lapsed, compared as text
    const asset = await fx.insertAsset(pool);
    const who = await fx.insertEmployee(pool);
    const ins = (start, secs) => pool.query(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status, hold_started_at, hold_expires_at)
      VALUES ($1, $2, $3, $3, 'held', ${pgTime.NOW}, ${pgTime.NOW_PLUS('$4')}) RETURNING id`, [asset.id, who.id, start, secs]);
    const live = (await ins('2026-12-01', 6 * 3600)).rows[0].id;
    await ins('2026-12-02', -6 * 3600);
    const ids = (await pool.query(`SELECT id FROM waitlist_entries WHERE asset_id = $1 AND hold_expires_at > ${pgTime.NOW}`, [asset.id])).rows.map((r) => r.id);
    assert.deepEqual(ids, [live]);
  });

  test('stored TEXT timestamps compare against NOW as strings, as on SQLite (hold_expires_at > now)', async () => {
    const asset = await fx.insertAsset(pool);
    const who = await fx.insertEmployee(pool);
    const later = (await pool.query(`SELECT ${pgTime.stampOf("statement_timestamp() + interval '1 hour'")} AS v`)).rows[0].v;
    const earlier = (await pool.query(`SELECT ${pgTime.stampOf("statement_timestamp() - interval '1 second'")} AS v`)).rows[0].v;
    const live = await fx.insertWaitlistEntry(pool, { asset_id: asset.id, employee_id: who.id, start_date: '2026-12-01', status: 'held', hold_expires_at: later });
    await fx.insertWaitlistEntry(pool, { asset_id: asset.id, employee_id: who.id, start_date: '2026-12-02', status: 'held', hold_expires_at: earlier });
    const pgIds = (await pool.query(`SELECT id FROM waitlist_entries WHERE asset_id = $1 AND hold_expires_at > ${pgTime.NOW}`, [asset.id])).rows.map((r) => r.id);
    assert.deepEqual(pgIds, [live.id], 'only the unexpired hold');

    // The same comparisons on SQLite give the same answers (byte-order TEXT on both sides).
    const sqlite = buildSqliteReference();
    const cases = [[later, '>'], [earlier, '>'], ['2026-01-01 00:00:00', '<'], ['2026-01-01 00:00:00', '>=']];
    const sqliteAns = cases.map(([v, op]) => sqlite.prepare(`SELECT (? ${op} datetime('now')) AS r`).get(v).r === 1);
    const pgAns = [];
    for (const [v, op] of cases) pgAns.push((await pool.query(`SELECT ($1::text COLLATE "C" ${op} ${pgTime.NOW}) AS r`, [v])).rows[0].r);
    assert.deepEqual(pgAns, sqliteAns);
    sqlite.close();
  });
});
