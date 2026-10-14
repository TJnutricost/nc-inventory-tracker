// PostgreSQL foundation (D-46, Slice 2): the PG baseline matches the final SQLite schema (migrations 1-17).
//   1. Structural parity (test-support/pg-parity.js): every table/column/default/nullability/PK/FK/CHECK/index compared;
//      any difference not on the allow-list fails, and so does an allow-list entry that matches nothing.
//   2. Behavioral parity: the same rows are inserted/deleted in both databases and must be accepted/rejected alike —
//      this proves CHECK *intent* (GLOB vs regex, TEXT comparisons under "C", NOCASE vs lower()) beyond the text match.
//   3. Fresh-database rows (tag counter, default catalog roots) and the TEXT timestamp default format match.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { ALLOW_LIST, buildSqliteReference, describeSqlite, describePg, compareSchemas } = require('../../test-support/pg-parity');

// Parent rows every probe can reference (explicit ids, identical in both databases).
const FIXTURES = [
  "INSERT INTO employees (id, name, work_email) VALUES (1, 'Probe Person', 'probe@example.com')",
  "INSERT INTO employees (id, name, work_email) VALUES (2, 'Second Person', NULL)",
  "INSERT INTO accounts (id, employee_id, login_email, role) VALUES (1, 1, 'probe@example.com', 'admin')",
  "INSERT INTO assets (id, tag, name, serial, serial_normalized) VALUES (1, 'NC-00001', 'Probe Laptop', 'SN1', 'sn1')",
];

const res = (cols, vals) => `INSERT INTO reservations (id, asset_id, employee_id, ${cols}) VALUES (100, 1, 1, ${vals})`;
const wl = (cols, vals) => `INSERT INTO waitlist_entries (id, asset_id, employee_id, ${cols}) VALUES (100, 1, 1, ${vals})`;
const reqRow = (id, cols, vals) => `INSERT INTO requests (id, user_id, ${cols}) VALUES (${id}, 1, ${vals})`;
const asg = (id, cols, vals) => `INSERT INTO assignments (id, asset_id, employee_id, ${cols}) VALUES (${id}, 1, 1, ${vals})`;

// [label, expected outcome, statements...] — the outcome is for the LAST statement (earlier ones must succeed).
const PROBES = [
  ['reservation: valid dates', 'ok', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'confirmed', 0")],
  ['reservation: date missing a digit', 'reject', res("start_date, end_date, status, requires_approval", "'2026-1-14', '2026-10-15', 'confirmed', 0")],
  ['reservation: date with trailing text', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15x', 'confirmed', 0")],
  ['reservation: end before start', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-15', '2026-10-14', 'confirmed', 0")],
  ['reservation: start_time 23:59', 'ok', res("start_date, end_date, status, requires_approval, start_time", "'2026-10-14', '2026-10-14', 'confirmed', 0, '23:59'")],
  ['reservation: start_time 24:00', 'reject', res("start_date, end_date, status, requires_approval, start_time", "'2026-10-14', '2026-10-14', 'confirmed', 0, '24:00'")],
  ['reservation: start_time 9:30 (no leading zero)', 'reject', res("start_date, end_date, status, requires_approval, start_time", "'2026-10-14', '2026-10-14', 'confirmed', 0, '9:30'")],
  ['reservation: end_time 12:60', 'reject', res("start_date, end_date, status, requires_approval, end_time", "'2026-10-14', '2026-10-14', 'confirmed', 0, '12:60'")],
  ['reservation: end_time with seconds', 'reject', res("start_date, end_date, status, requires_approval, end_time", "'2026-10-14', '2026-10-14', 'confirmed', 0, '12:00:00'")],
  ['reservation: pending without approval', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'pending', 0")],
  ['reservation: pending with approval', 'ok', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'pending', 1")],
  ['reservation: declined without decided_at', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'declined', 1")],
  ['reservation: cancelled without cancelled_at', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'cancelled', 0")],
  ['reservation: unknown status', 'reject', res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'held', 0")],
  ['waitlist: waiting', 'ok', wl("start_date, end_date", "'2026-10-14', '2026-10-15'")],
  ['waitlist: held without hold times', 'reject', wl("start_date, end_date, status", "'2026-10-14', '2026-10-15', 'held'")],
  ['waitlist: closed without closed_at', 'reject', wl("start_date, end_date, status", "'2026-10-14', '2026-10-15', 'left'")],
  ['waitlist: end_time 07:30', 'ok', wl("start_date, end_date, end_time", "'2026-10-14', '2026-10-15', '07:30'")],
  ['waitlist: start_time 25:00', 'reject', wl("start_date, end_date, start_time", "'2026-10-14', '2026-10-15', '25:00'")],
  ['requests: open equipment request', 'ok', reqRow(100, 'type', "'equipment'")],
  ['requests: approved return request', 'reject', reqRow(100, 'type, status, resolved_at', "'return', 'approved', '2030-01-01 00:00:00'")],
  ['requests: issue without asset', 'reject', reqRow(100, 'type', "'issue'")],
  ['requests: open but resolved', 'reject', reqRow(100, 'type, resolved_at', "'equipment', '2030-01-01 00:00:00'")],
  ['requests: completed without resolved_at', 'reject', reqRow(100, 'type, status', "'equipment', 'completed'")],
  ['requests: resolved before created', 'reject', reqRow(100, 'type, status, resolved_at', "'equipment', 'completed', '2000-01-01 00:00:00'")],
  ['requests: permanent request without asset', 'reject', reqRow(100, 'type, requested_assignment_type', "'equipment', 'permanent'")],
  ['requests: assignment type on a return', 'reject', reqRow(100, 'type, asset_id, requested_assignment_type', "'return', 1, 'checkout'")],
  ['requests: second live return for the same asset/employee', 'reject',
    reqRow(100, 'type, asset_id', "'return', 1"), reqRow(101, 'type, asset_id, status', "'return', 1, 'dropped_off'")],
  ['requests: completed return next to a live one', 'ok',
    reqRow(100, 'type, asset_id', "'return', 1"), reqRow(101, 'type, asset_id, status, resolved_at', "'return', 1, 'completed', '2030-01-01 00:00:00'")],
  ['assignments: permanent with a due date', 'reject', asg(100, 'assignment_type, due_date', "'permanent', '2026-10-20'")],
  ['assignments: checkout without a due date', 'reject', asg(100, 'assignment_type', "'checkout'")],
  ['assignments: checkout with a due date', 'ok', asg(100, 'assignment_type, due_date', "'checkout', '2026-10-20'")],
  ['assignments: same employee holds the same asset twice', 'reject', asg(100, 'assignment_type', "'permanent'"), asg(101, 'assignment_type', "'permanent'")],
  ['assignments: returned + active for the same pair', 'ok', asg(100, 'assignment_type, returned_at', "'permanent', '2026-10-01 00:00:00'"), asg(101, 'assignment_type', "'permanent'")],
  ['assets: unknown status', 'reject', "INSERT INTO assets (id, tag, name, status) VALUES (100, 'NC-100', 'x', 'bogus')"],
  ['assets: disposed status', 'ok', "INSERT INTO assets (id, tag, name, status) VALUES (100, 'NC-100', 'x', 'disposed')"],
  ['assets: available_to_request = 2', 'reject', "INSERT INTO assets (id, tag, name, available_to_request) VALUES (100, 'NC-100', 'x', 2)"],
  ['assets: tag differing only in ASCII case', 'reject', "INSERT INTO assets (id, tag, name) VALUES (100, 'nc-00001', 'x')"],
  ['assets: tags differing only in non-ASCII case (NOCASE folds ASCII only)', 'ok',
    "INSERT INTO assets (id, tag, name) VALUES (100, 'É-1', 'x')", "INSERT INTO assets (id, tag, name) VALUES (101, 'é-1', 'x')"],
  ['assets: duplicate normalized serial', 'reject', "INSERT INTO assets (id, tag, name, serial_normalized) VALUES (100, 'NC-100', 'x', 'sn1')"],
  ['assets: two assets without serial', 'ok',
    "INSERT INTO assets (id, tag, name) VALUES (100, 'NC-100', 'x')", "INSERT INTO assets (id, tag, name) VALUES (101, 'NC-101', 'x')"],
  ['employees: work email differing only in case', 'reject', "INSERT INTO employees (id, name, work_email) VALUES (100, 'x', 'PROBE@Example.com')"],
  ['employees: several without work email', 'ok', "INSERT INTO employees (id, name) VALUES (100, 'x')", "INSERT INTO employees (id, name) VALUES (101, 'y')"],
  ['employees: can_self_checkout = 2', 'reject', "INSERT INTO employees (id, name, can_self_checkout) VALUES (100, 'x', 2)"],
  ['employees: unknown status', 'reject', "INSERT INTO employees (id, name, status) VALUES (100, 'x', 'gone')"],
  ['accounts: login email differing only in case', 'reject', "INSERT INTO accounts (id, login_email) VALUES (100, 'Probe@EXAMPLE.com')"],
  ['accounts: second account for one employee', 'reject', "INSERT INTO accounts (id, employee_id, login_email) VALUES (100, 1, 'other@example.com')"],
  ['accounts: legacy role "user"', 'reject', "INSERT INTO accounts (id, login_email, role) VALUES (100, 'r@example.com', 'user')"],
  ['catalog: blank name', 'reject', "INSERT INTO catalog_nodes (id, name, name_key) VALUES (100, '   ', 'x')"],
  ['catalog: empty name_key', 'reject', "INSERT INTO catalog_nodes (id, name, name_key) VALUES (100, 'x', '')"],
  ['catalog: root sibling name clash with a default root', 'reject', "INSERT INTO catalog_nodes (id, name, name_key) VALUES (100, 'LAPTOP', 'laptop')"],
  ['catalog: same name under a different parent', 'ok', "INSERT INTO catalog_nodes (id, parent_id, name, name_key) VALUES (100, 1, 'Laptop', 'laptop')"],
  ['catalog: node as its own parent', 'reject', "INSERT INTO catalog_nodes (id, parent_id, name, name_key) VALUES (100, 100, 'x', 'x')"],
  ['catalog: delete a node that has children', 'reject', "INSERT INTO catalog_nodes (id, parent_id, name, name_key) VALUES (100, 1, 'Mac', 'mac')", 'DELETE FROM catalog_nodes WHERE id = 1'],
  ['tag counter: second row', 'reject', 'INSERT INTO asset_tag_counter (id, last_number) VALUES (2, 0)'],
  ['FK: assignment for a missing employee', 'reject', asg(100, 'assignment_type', "'permanent'").replace('VALUES (100, 1, 1,', 'VALUES (100, 1, 999,')],
  ['FK RESTRICT: delete an asset with a reservation', 'reject',
    res("start_date, end_date, status, requires_approval", "'2026-10-14', '2026-10-15', 'confirmed', 0"), 'DELETE FROM assets WHERE id = 1'],
  ['FK RESTRICT: delete an asset with activity', 'reject', "INSERT INTO activity (id, asset_id, action) VALUES (100, 1, 'probe')", 'DELETE FROM assets WHERE id = 1'],
  ['FK NO ACTION: delete an account that checked something out', 'reject',
    asg(100, 'assignment_type, checked_out_by', "'permanent', 1"), 'DELETE FROM accounts WHERE id = 1'],
  ['FK CASCADE: delete an asset that only has photos', 'ok', "INSERT INTO photos (id, asset_id, filename, thumb) VALUES (100, 1, 'a.jpg', 'a_t.jpg')", 'DELETE FROM assets WHERE id = 1'],
  ['FK CASCADE: delete an account that only has tokens', 'ok',
    "INSERT INTO accounts (id, login_email) VALUES (100, 'tok@example.com')", "INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ('t', 100, 'invite', '2030-01-01')", 'DELETE FROM accounts WHERE id = 100'],
  ['sessions: epoch-millisecond expiry', 'ok', "INSERT INTO sessions (sid, sess, expires) VALUES ('s', '{}', 1760000000000)"],
];

const isConstraintError = { sqlite: (e) => /^SQLITE_CONSTRAINT/.test(e.code || ''), pg: (e) => /^23/.test(e.code || '') };

function runSqliteProbe(db, statements) {
  db.exec('SAVEPOINT probe');
  try {
    for (const [i, sql] of statements.entries()) {
      try {
        db.prepare(sql).run();
      } catch (e) {
        if (i === statements.length - 1 && isConstraintError.sqlite(e)) return 'reject';
        return `error: ${e.message}`;
      }
    }
    return 'ok';
  } finally {
    db.exec('ROLLBACK TO probe; RELEASE probe');
  }
}

async function runPgProbe(client, statements) {
  await client.query('BEGIN');
  try {
    for (const [i, sql] of statements.entries()) {
      try {
        await client.query(sql);
      } catch (e) {
        if (i === statements.length - 1 && isConstraintError.pg(e)) return 'reject';
        return `error: ${e.message}`;
      }
    }
    return 'ok';
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('PostgreSQL baseline ⇄ SQLite schema parity', pgSuite(), () => {
  let tdb;
  let sqlite;
  let client;
  before(async () => {
    tdb = await createTestDatabase();
    sqlite = buildSqliteReference();
    client = await tdb.pool.connect();
  });
  after(async () => {
    client?.release();
    sqlite?.close();
    await tdb?.drop();
  });

  test('structural parity: no unexplained difference, and every allow-list entry is still needed', async () => {
    const result = compareSchemas(describeSqlite(sqlite), await describePg(client));
    assert.deepEqual(result.unexplained, [], `unexplained differences:\n${result.unexplained.map((d) => `  [${d.kind}] ${d.table}${d.column ? `.${d.column}` : ''}: ${d.detail}`).join('\n')}`);
    assert.deepEqual(result.unusedAllowList, [], 'allow-list entries that match no difference must be removed');
    for (const entry of ALLOW_LIST) assert.ok(entry.reason && entry.reason.length > 20, `allow-list entry ${entry.kind} needs a reason`);
  });

  test('every SQLite table and column is accounted for in PostgreSQL', async () => {
    const s = describeSqlite(sqlite);
    const p = await describePg(client);
    const sqliteTables = Object.keys(s).filter((t) => t !== 'sqlite_sequence').sort();
    assert.deepEqual(Object.keys(p).sort(), sqliteTables);
    assert.equal(sqliteTables.length, 16, '15 app tables + schema_migrations');
    for (const t of sqliteTables) assert.deepEqual(p[t].columns.map((c) => c.name), s[t].columns.map((c) => c.name), t);
  });

  test('a fresh PostgreSQL database holds the same rows as a fresh SQLite one (tag counter, default catalog roots)', async () => {
    const cols = 'id, parent_id, name, name_key, archived_at, search_keywords';
    assert.deepEqual((await client.query(`SELECT ${cols} FROM catalog_nodes ORDER BY id`)).rows,
      sqlite.prepare(`SELECT ${cols} FROM catalog_nodes ORDER BY id`).all());
    assert.deepEqual((await client.query('SELECT id, last_number FROM asset_tag_counter')).rows,
      sqlite.prepare('SELECT id, last_number FROM asset_tag_counter').all());
    for (const t of ['employees', 'accounts', 'assets', 'assignments', 'requests', 'reservations', 'waitlist_entries', 'settings', 'sessions']) {
      assert.equal((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n, sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, t);
    }
  });

  test('TEXT timestamp defaults use SQLite\'s exact format and UTC', async () => {
    const pgNow = (await client.query("INSERT INTO outbox (to_addr, subject, body, status) VALUES ('a@example.com', 's', 'b', 'sent') RETURNING created_at")).rows[0].created_at;
    const sqliteNow = sqlite.prepare("SELECT datetime('now') AS t").get().t;
    for (const t of [pgNow, sqliteNow]) assert.match(t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(Math.abs(Date.parse(`${pgNow.replace(' ', 'T')}Z`) - Date.parse(`${sqliteNow.replace(' ', 'T')}Z`)) < 60_000, `${pgNow} vs ${sqliteNow}`);
    await client.query('DELETE FROM outbox');
  });

  test('behavioral parity: both databases accept and reject the same rows', async () => {
    for (const sql of FIXTURES) { sqlite.prepare(sql).run(); await client.query(sql); }
    const mismatches = [];
    for (const [label, expected, ...statements] of PROBES) {
      const s = runSqliteProbe(sqlite, statements);
      const p = await runPgProbe(client, statements);
      if (s !== expected || p !== expected) mismatches.push(`${label}: expected ${expected}, SQLite ${s}, PostgreSQL ${p}`);
    }
    assert.deepEqual(mismatches, []);
  });
});
