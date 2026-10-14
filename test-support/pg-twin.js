// Lock-step "twin" worlds for the Slice 4A differential tests (D-46): every fixture row is written to a PostgreSQL test
// database AND an in-memory SQLite reference (buildSqliteReference) with the SAME explicit id and the SAME clock-like values,
// so a SQLite module and its src/pg twin can be run on the two and their outputs compared with deepEqual, ids included.
//
//   const tw = await createTwin(pool);           // tw.pg (pool), tw.sq (sqliteExecutor), tw.sqlite (better-sqlite3 db)
//   const a = await tw.insert('assets', { name: 'Camera', tag: 'C-1' });   // row as PostgreSQL returned it
//   await tw.same('label', (q, db) => pgModule.fn(q, ...), (db) => sqliteModule.fn(db, ...));
//
// created_at / updated_at / checked_out_at default to FIXED text (the column defaults would read each engine's clock a moment
// apart). Ids start at 100000, above anything the baselines seed. Only for tests.
const assert = require('node:assert/strict');
const { buildSqliteReference } = require('./pg-parity');
const fx = require('./pg-fixtures');
const pgTime = require('../src/pg/time');

const FIXED = '2026-01-01 00:00:00';
const STAMPED = ['created_at', 'updated_at', 'checked_out_at'];

// An outcome either way: { ok: value } or { error: { status, message } } (a non-HTTP error is rethrown: that is a bug).
async function outcome(fn) {
  try {
    return { ok: await fn() };
  } catch (err) {
    if (err.status === undefined) throw err;
    return { error: { status: err.status, message: err.message } };
  }
}

async function createTwin(pool, { firstId = 100000 } = {}) {
  const sqlite = buildSqliteReference();
  const sq = fx.sqliteExecutor(sqlite);
  let id = firstId;
  const columns = new Map();
  async function columnsOf(table) {
    if (!columns.has(table)) {
      const { rows } = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table]);
      columns.set(table, new Set(rows.map((r) => r.column_name)));
    }
    return columns.get(table);
  }
  const tw = {
    pg: pool, sq, sqlite,
    nextId: () => ++id,
    // One row into both engines (same id, same values). Returns the PostgreSQL row; the SQLite row is checked to be equal.
    async insert(table, cols) {
      const cs = await columnsOf(table);
      // never reuse an id a module write already took on either engine (Slice 4B: modules write rows between fixtures)
      const pgMax = Number((await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)).rows[0].m);
      const sqMax = sqlite.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${table}`).get().m;
      id = Math.max(id + 1, pgMax + 1, sqMax + 1);
      const row = { id, ...cols };
      for (const c of STAMPED) if (cs.has(c) && row[c] === undefined) row[c] = FIXED;
      const pgRow = await fx.insertRow(pool, table, row);
      const sqRow = await fx.insertRow(sq, table, row);
      assert.deepEqual(pgRow, sqRow, `twin ${table} rows agree`);
      return pgRow;
    },
    // The fixture helpers' defaults, applied to both engines.
    employee: (cols = {}) => tw.insert('employees', { name: `Person ${id + 1}`, ...cols }),
    asset: (cols = {}) => tw.insert('assets', { tag: `TW-${id + 1}`, name: `Asset ${id + 1}`, ...cols }),
    node: (name, cols = {}) => tw.insert('catalog_nodes', { parent_id: null, name, name_key: require('../src/catalog').nameKey(name), ...cols }),
    assignment: (cols) => tw.insert('assignments', { assignment_type: 'permanent', ...cols }),
    checkout: (cols) => tw.insert('assignments', { assignment_type: 'checkout', ...cols }),
    reservation(cols) {
      const row = { status: 'confirmed', requires_approval: 0, ...cols };
      if (['pending', 'declined'].includes(row.status) && cols.requires_approval === undefined) row.requires_approval = 1;
      if (row.status === 'declined') row.decided_at ??= FIXED;
      if (row.status === 'cancelled') row.cancelled_at ??= FIXED;
      row.end_date ??= row.start_date;
      return tw.insert('reservations', row);
    },
    entry(cols) {
      const row = { status: 'waiting', ...cols };
      row.end_date ??= row.start_date;
      if (row.status === 'held') { row.hold_started_at ??= FIXED; row.hold_expires_at ??= '2999-12-31 00:00:00'; }
      if (!['waiting', 'held'].includes(row.status)) row.closed_at ??= FIXED;
      return tw.insert('waitlist_entries', row);
    },
    // The database clock + seconds, as stored text (read once from PostgreSQL and written identically to both engines).
    stamp: (seconds) => pgTime.nowPlus(pool, seconds),
    // Slice 4B: fixtures carry explicit ids, which do not advance PostgreSQL's identity sequences. Before a module writes
    // rows, set every touched sequence so the next id is MAX(id) + 1, which is also what SQLite hands out: the two engines then
    // give module-written rows the same ids as long as both write the same rows in the same order. Call it again before
    // each write scenario (a PostgreSQL rollback consumes sequence values, a SQLite one does not).
    syncSequences: () => syncSequences(pool, sqlite),
    // Both catalog caches must forget the tree after fixtures add nodes.
    invalidateCatalogs() { require('../src/catalog').invalidate(); require('../src/pg/catalog').invalidate(); },
    // Runs the PostgreSQL and the SQLite version and requires identical outcomes (values or {status, message} errors). Reads only,
    // so a run that straddled UTC midnight (the two engines could disagree on "today") is simply repeated once.
    async same(label, pgFn, sqFn) {
      for (let attempt = 0; ; attempt++) {
        const before = await pgTime.today(pool);
        const pgOut = await outcome(() => pgFn(pool));
        const sqOut = await outcome(() => sqFn(sqlite));
        if (before !== await pgTime.today(pool) && attempt === 0) continue;
        assert.deepEqual(pgOut, sqOut, label);
        return pgOut;
      }
    },
    close: () => sqlite.close(),
  };
  return tw;
}

// Next id = one past the highest id either engine has used: PostgreSQL's MAX(id) and, for SQLite, MAX(rowid) or the
// AUTOINCREMENT high-water mark in sqlite_sequence. Both engines are then set to hand out exactly that id next. Without a
// SQLite database, PostgreSQL alone is set to MAX(id) + 1 (fixtures with explicit ids, then module writes).
const SEQUENCED = ['employees', 'accounts', 'assets', 'catalog_nodes', 'assignments', 'reservations', 'waitlist_entries', 'activity'];
async function syncSequences(pool, sqlite = null, tables = SEQUENCED) {
  for (const t of tables) {
    const pgMax = Number((await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`)).rows[0].m);
    let next = pgMax + 1;
    if (sqlite) {
      const sqMax = sqlite.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get().m;
      const seq = sqlite.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t);
      next = Math.max(next, sqMax + 1, seq ? seq.seq + 1 : 0);
      // (a plain rowid table cannot be raised; that only happens when a test wrote PostgreSQL-only rows, and a differential
      // comparison would then fail loudly on the ids it compares)
      if (seq) sqlite.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(next - 1, t);
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), $1, false)`, [next]);
  }
}

module.exports = { createTwin, outcome, syncSequences, FIXED };
