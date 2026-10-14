// Row fixtures for the PostgreSQL module tests (D-46, migration Slice 3). Small async helpers that INSERT one row and return
// it (RETURNING *), through any executor with .query(text, params): a harness pool, a transaction client, or — for the
// differential SQLite-vs-PostgreSQL tests — sqliteExecutor(db) over a better-sqlite3 database.
//
// Tags are explicit (FX-<n>); there is no tag counter here (that is Slice 5). Defaults satisfy the baseline CHECKs; pass
// any column to override. Use with the per-file harness: createTestDatabase() from test-support/pg-harness.js.
const { nameKey } = require('../src/catalog');

let seq = 0;
const next = () => ++seq;

async function insertRow(q, table, cols) {
  const keys = Object.keys(cols);
  const { rows } = await q.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(cols),
  );
  return rows[0];
}

const insertEmployee = (q, cols = {}) => { const n = next(); return insertRow(q, 'employees', { name: `Person ${n}`, ...cols }); };

async function insertAccount(q, cols = {}) {
  const n = next();
  const employee_id = cols.employee_id !== undefined ? cols.employee_id : (await insertEmployee(q)).id;
  return insertRow(q, 'accounts', { login_email: `fx${n}@nutricost.com`, role: 'employee', ...cols, employee_id });
}

const insertAsset = (q, cols = {}) => { const n = next(); return insertRow(q, 'assets', { tag: `FX-${n}`, name: `Asset ${n}`, ...cols }); };

const insertCatalogNode = (q, { name, parent_id = null, ...cols }) => insertRow(q, 'catalog_nodes', { parent_id, name, name_key: nameKey(name), ...cols });

// An open equipment request unless told otherwise; a resolving status gets resolved_at (same instant as created_at).
const RESOLVED = ['approved', 'denied', 'completed', 'cancelled'];
function insertRequest(q, cols) {
  const row = { type: 'equipment', status: 'open', ...cols };
  if (RESOLVED.includes(row.status) && row.resolved_at === undefined) {
    row.created_at ??= '2026-01-01 00:00:00';
    row.resolved_at = row.created_at;
  }
  return insertRow(q, 'requests', row);
}

// A confirmed reservation unless told otherwise. pending/declined need requires_approval = 1 (and declined a decided_at).
function insertReservation(q, cols) {
  const row = { status: 'confirmed', requires_approval: 0, ...cols };
  if (['pending', 'declined'].includes(row.status) && cols.requires_approval === undefined) row.requires_approval = 1;
  if (row.status === 'declined') row.decided_at ??= '2026-01-01 00:00:00';
  if (row.status === 'cancelled') row.cancelled_at ??= '2026-01-01 00:00:00';
  if (row.end_date === undefined) row.end_date = row.start_date;
  return insertRow(q, 'reservations', row);
}

// A waiting entry unless told otherwise. A held entry gets a hold window (expiring far in the future unless given);
// a closed status gets closed_at.
function insertWaitlistEntry(q, cols) {
  const row = { status: 'waiting', ...cols };
  if (row.end_date === undefined) row.end_date = row.start_date;
  if (row.status === 'held') {
    row.hold_started_at ??= '2026-01-01 00:00:00';
    row.hold_expires_at ??= '2999-12-31 00:00:00';
  }
  if (!['waiting', 'held'].includes(row.status)) row.closed_at ??= '2026-01-01 00:00:00';
  return insertRow(q, 'waitlist_entries', row);
}

// A permanent active assignment unless told otherwise (a checkout needs due_date).
const insertAssignment = (q, cols) => insertRow(q, 'assignments', { assignment_type: 'permanent', ...cols });

// An open TEMPORARY checkout (Slice 4A): due_date required, due_time optional; checked_out_at defaults to the column default
// (now) unless given, so a test can place the checkout's start in a month.
const insertCheckout = (q, cols) => {
  if (!cols.due_date) throw new Error('insertCheckout needs due_date');
  return insertRow(q, 'assignments', { assignment_type: 'checkout', ...cols });
};

// The DATABASE clock + `seconds` (may be negative), as SQLite datetime('now', '+N seconds') text, on either engine. Tests seed
// hold_expires_at with it so "live" / "lapsed" holds are relative to the clock the modules compare against (use generous margins).
async function dbStamp(q, seconds) {
  if (q.engine === 'sqlite') return (await q.query('SELECT datetime(\'now\', $1) AS v', [`${seconds >= 0 ? '+' : ''}${seconds} seconds`])).rows[0].v;
  return (await q.query(`SELECT ${require('../src/pg/time').NOW_PLUS('$1')} AS v`, [seconds])).rows[0].v;
}

// The node-pg executor shape over a better-sqlite3 database: $1..$n placeholders (may repeat) become positional ?s.
// Returns { rows, rowCount } like node-pg. Only for the differential tests' fixtures and probes.
function sqliteExecutor(db) {
  return {
    engine: 'sqlite',
    async query(text, params = []) {
      const order = [];
      const sql = text.replace(/\$(\d+)/g, (_, n) => { order.push(params[Number(n) - 1]); return '?'; });
      const stmt = db.prepare(sql);
      if (stmt.reader) { const rows = stmt.all(...order); return { rows, rowCount: rows.length }; }
      const info = stmt.run(...order);
      return { rows: [], rowCount: info.changes };
    },
  };
}

module.exports = {
  insertRow, insertEmployee, insertAccount, insertAsset, insertCatalogNode, insertRequest, insertReservation, insertWaitlistEntry, insertAssignment,
  insertCheckout, dbStamp, sqliteExecutor,
};
