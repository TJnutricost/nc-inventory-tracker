// Minimal versioned migration runner for PostgreSQL — the counterpart of src/migrate.js (SQLite). Each migration is
// { id, name, file } (or { id, name, sql }); ids are positive integers applied once, in ascending order, each inside its
// own transaction together with its schema_migrations row (so a failed migration leaves no trace).
//   - Concurrent runners are serialized by a session advisory lock, so two processes starting at once apply each
//     migration exactly once.
//   - Fresh databases only: the FIRST migration (the baseline) refuses to run when the schema already contains any
//     table other than schema_migrations. There is no path that adopts or upgrades an existing schema.
const fs = require('fs');
const path = require('path');
const defaultMigrations = require('./migrations');

const SCHEMA_DIR = path.join(__dirname, 'schema');
const ADVISORY_LOCK_KEY = 4_651_201_400_017; // arbitrary constant, unique to this app's schema runner

const SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY,
  name text COLLATE "C" NOT NULL,
  applied_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
)`;

function sortedMigrations(migrations) {
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (!Number.isInteger(m.id) || m.id < 1 || (i > 0 && m.id === sorted[i - 1].id)) throw new Error(`Invalid or duplicate migration id: ${m.id}`);
    if (typeof m.sql !== 'string' && typeof m.file !== 'string') throw new Error(`Migration ${m.id} has neither sql nor file`);
  }
  return sorted;
}

function migrationSql(m) {
  return typeof m.sql === 'string' ? m.sql : fs.readFileSync(path.join(SCHEMA_DIR, m.file), 'utf8');
}

async function assertFreshSchema(client) {
  const { rows } = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name <> 'schema_migrations' ORDER BY table_name`);
  if (rows.length) {
    throw new Error(`Refusing to apply the PostgreSQL baseline: this database is not fresh (existing tables: ${rows.map((r) => r.table_name).join(', ')}). The baseline only builds an empty database; nothing was changed.`);
  }
}

// Applies every pending migration; returns the ids it ran ([] when the database is already current).
async function runMigrations(pool, migrations = defaultMigrations) {
  const sorted = sortedMigrations(migrations);
  const client = await pool.connect();
  let broken = null;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(SCHEMA_MIGRATIONS_SQL);
      const applied = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
      const ran = [];
      for (const m of sorted) {
        if (applied.has(m.id)) continue;
        const sql = migrationSql(m);
        await client.query('BEGIN');
        try {
          if (applied.size === 0 && ran.length === 0) await assertFreshSchema(client);
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch((rollbackErr) => { broken = rollbackErr; });
          throw new Error(`PostgreSQL migration ${m.id} (${m.name}) failed: ${err.message}`, { cause: err });
        }
        ran.push(m.id);
      }
      return ran;
    } finally {
      if (!broken) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch((err) => { broken = err; });
    }
  } finally {
    client.release(broken || undefined);
  }
}

module.exports = { runMigrations, SCHEMA_MIGRATIONS_SQL };
