// PostgreSQL Slice 6B: copies a SQLite database (schema at migration 17) into a fresh PostgreSQL database (baseline
// migration 1), keeping every id and every value as stored (docs/briefs/postgresql-slice-6-data-migration.md).
//   DATABASE_URL=<local url> node scripts/pg-copy.js <path/to/assets.db>
// Local PostgreSQL only for now (src/pg/local-url.js): the Railway target is a Slice 7 decision.
// Exit code 0 = copied and verified, 1 = refused or failed (the target is left as it was), 2 = usage error.
//   - The 6A preflight must pass first; the source is opened read-only.
//   - The target must be fresh: the baseline applied (it is applied here when the database is empty) and no app data
//     beyond the baseline's own seed rows (tag counter at 0, the 13 default catalog roots), which the copy replaces.
//   - ONE transaction: any error rolls everything back.
//   - Not copied (owner decisions 2026-10-26): `sessions` (everyone signs in again); `sqlite_sequence` and
//     `schema_migrations` (PostgreSQL keeps its own). `outbox` and `activity` are copied in full.
//   - Every identity sequence is advanced past the largest copied id, so the next insert gets max(id) + 1.
const fs = require('fs');
const { createPool, resolveDatabaseUrl } = require('../src/pg/pool');
const { isLocalDatabaseUrl } = require('../src/pg/local-url');
const { runMigrations } = require('../src/pg/migrate');
const { preflight, openReadOnly } = require('./pg-preflight');

// Foreign-key order (parents first). catalog_nodes references itself and is ordered parent-first below.
// assets.cover_photo_id has no foreign key, so assets can precede photos.
const COPY_TABLES = [
  { table: 'employees', key: 'id' },
  { table: 'accounts', key: 'id' },
  { table: 'catalog_nodes', key: 'id' },
  { table: 'assets', key: 'id' },
  { table: 'assignments', key: 'id' },
  { table: 'photos', key: 'id' },
  { table: 'requests', key: 'id' },
  { table: 'activity', key: 'id' },
  { table: 'tokens', key: 'token' },
  { table: 'waitlist_entries', key: 'id' },
  { table: 'reservations', key: 'id' },
  { table: 'outbox', key: 'id' },
  { table: 'settings', key: 'key' },
  { table: 'asset_tag_counter', key: 'id' },
  { table: 'issued_tag_ranges', key: 'id' },
];
const NOT_COPIED = ['sessions'];
const BASELINE_CATALOG_ROOTS = 13;
const CHUNK_ROWS = 500;

const q = (name) => `"${name.replace(/"/g, '""')}"`;

function columnsOf(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name);
}

// Rows in insert order. catalog_nodes: parents before children (a moved node can have a smaller id than its parent).
function sourceRows(sqlite, table, cols) {
  const list = cols.map(q).join(', ');
  if (table === 'catalog_nodes') {
    return sqlite.prepare(`WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM catalog_nodes WHERE parent_id IS NULL
        UNION ALL SELECT c.id, t.depth + 1 FROM catalog_nodes c JOIN tree t ON c.parent_id = t.id)
      SELECT ${cols.map((c) => `n.${q(c)}`).join(', ')} FROM tree JOIN catalog_nodes n ON n.id = tree.id ORDER BY tree.depth, n.id`).all();
  }
  return sqlite.prepare(`SELECT ${list} FROM ${q(table)} ORDER BY rowid`).all();
}

// Throws unless the target holds nothing but the baseline (and its seed rows).
async function assertFreshTarget(client) {
  const problems = [];
  for (const { table } of COPY_TABLES.concat(NOT_COPIED.map((table) => ({ table })))) {
    const n = Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
    if (table === 'asset_tag_counter') {
      const { rows } = await client.query('SELECT id, last_number FROM asset_tag_counter');
      if (rows.length !== 1 || rows[0].id !== 1 || rows[0].last_number !== 0) problems.push('asset_tag_counter is not the baseline row (1, 0)');
    } else if (table === 'catalog_nodes') {
      const { rows } = await client.query('SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE parent_id IS NULL AND id <= $1) AS roots FROM catalog_nodes', [BASELINE_CATALOG_ROOTS]);
      if (Number(rows[0].n) !== BASELINE_CATALOG_ROOTS || Number(rows[0].roots) !== BASELINE_CATALOG_ROOTS) problems.push('catalog_nodes is not the 13 baseline roots');
    } else if (n > 0) {
      problems.push(`${table} has ${n} row(s)`);
    }
  }
  const migrations = (await client.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map((r) => r.id);
  if (migrations.join(',') !== '1,2') problems.push(`schema_migrations is [${migrations.join(', ')}], expected [1, 2]`);
  if (problems.length) {
    throw new Error(`Refusing to copy: the target database is not fresh (${problems.join('; ')}). Nothing was changed.`);
  }
}

async function insertRows(client, table, cols, rows) {
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS);
    const params = [];
    const tuples = chunk.map((row) => `(${cols.map((c) => { params.push(row[c]); return `$${params.length}`; }).join(', ')})`);
    await client.query(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

// The identity sequence of each copied table that has one: [{ table, seq }].
async function identitySequences(executor) {
  const { rows } = await executor.query(`SELECT table_name AS table, pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
    FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id' AND is_identity = 'YES'`);
  const copied = new Set(COPY_TABLES.map((t) => t.table));
  return rows.filter((r) => copied.has(r.table) && r.seq);
}

// Sets each identity sequence so the next generated id is max(id) + 1 (1 for an empty table).
async function advanceSequences(client) {
  const advanced = {};
  for (const { table, seq } of await identitySequences(client)) {
    const max = (await client.query(`SELECT MAX(id) AS max FROM ${q(table)}`)).rows[0].max;
    if (max === null) await client.query('SELECT setval($1::regclass, 1, false)', [seq]);
    else await client.query('SELECT setval($1::regclass, $2, true)', [seq, max]);
    advanced[table] = max === null ? 0 : max;
  }
  return advanced;
}

// Copies `sqlite` (an open better-sqlite3 handle) into the database behind `pool`. Returns { copied: {table: n}, sequences }.
async function copy(sqlite, pool) {
  const check = preflight(sqlite);
  if (!check.ok) {
    const first = check.findings.slice(0, 5).map((f) => f.message).join('; ');
    throw new Error(`Refusing to copy: the preflight found ${check.findings.length} problem(s) (${first}). Run scripts/pg-preflight.js for the full list. Nothing was changed.`);
  }
  await runMigrations(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await assertFreshTarget(client);
      await client.query('DELETE FROM asset_tag_counter');
      await client.query('DELETE FROM catalog_nodes');
      const copied = {};
      for (const { table } of COPY_TABLES) {
        const cols = columnsOf(sqlite, table);
        const rows = sourceRows(sqlite, table, cols);
        const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;
        if (rows.length !== total) throw new Error(`${table}: ${total - rows.length} row(s) are not reachable from a root (a cycle in parent_id?)`);
        await insertRows(client, table, cols, rows);
        copied[table] = rows.length;
      }
      const sequences = await advanceSequences(client);
      await client.query('COMMIT');
      return { copied, sequences };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

async function main(argv, env = process.env) {
  if (argv.length !== 1) {
    console.error('Usage: DATABASE_URL=<local url> node scripts/pg-copy.js <path/to/assets.db>');
    return 2;
  }
  if (!fs.existsSync(argv[0])) {
    console.error(`pg-copy: no such file: ${argv[0]}`);
    return 1;
  }
  const url = env.DATABASE_URL || resolveDatabaseUrl(env);
  if (!isLocalDatabaseUrl(url)) {
    console.error('pg-copy refuses to connect: DATABASE_URL host is not localhost, 127.0.0.1 or ::1 (the Railway copy is Slice 7).');
    return 1;
  }
  const { verify, report } = require('./pg-verify');
  const sqlite = openReadOnly(argv[0]);
  const pool = createPool(url);
  try {
    const { copied } = await copy(sqlite, pool);
    for (const [table, n] of Object.entries(copied)) console.log(`  copied ${table.padEnd(20)} ${n}`);
    const result = await verify(sqlite, pool);
    console.log(report(result));
    return result.ok ? 0 : 1;
  } finally {
    sqlite.close();
    await pool.end();
  }
}

// Exported before main runs: scripts/pg-verify.js requires this module back (it shares the table list).
module.exports = { copy, main, identitySequences, COPY_TABLES, NOT_COPIED };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`pg-copy failed: ${err.message}`);
      process.exitCode = 1;
    });
}
