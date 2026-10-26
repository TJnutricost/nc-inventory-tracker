// PostgreSQL Slice 6C: restores a scripts/pg-backup.js file into an EMPTY PostgreSQL database
// (docs/briefs/postgresql-slice-6-data-migration.md).
//   DATABASE_URL=<local url> node scripts/pg-restore.js <in.dump>
// Local PostgreSQL only for now (src/pg/local-url.js). Exit code 0 = restored, 1 = refused or failed, 2 = usage error.
//   - Refuses a target that already has any table: a restore never merges into or overwrites data.
//   - pg_restore --single-transaction --exit-on-error: any error leaves the target as empty as it was.
//   - Afterwards the PostgreSQL migrations must have nothing left to apply (the backup carries schema_migrations).
const fs = require('fs');
const { createPool } = require('../src/pg/pool');
const { runMigrations } = require('../src/pg/migrate');
const { pgTool, run, listDump, targetUrl } = require('./pg-backup');

async function assertEmptyTarget(pool) {
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() ORDER BY table_name`);
  if (rows.length) {
    throw new Error(`Refusing to restore: the target database is not empty (tables: ${rows.map((r) => r.table_name).join(', ')}). Restore into a new, empty database. Nothing was changed.`);
  }
}

// Restores `file` into the empty database behind `databaseUrl`. Returns { tables } (the restored app tables).
async function restore(file, databaseUrl) {
  await listDump(file, databaseUrl); // a damaged file fails before anything is touched
  const pool = createPool(databaseUrl);
  try {
    await assertEmptyTarget(pool);
    const tool = pgTool('pg_restore', databaseUrl);
    const fd = fs.openSync(file, 'r');
    try {
      await run(tool, ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${tool.url}`], { stdin: fd });
    } finally {
      fs.closeSync(fd);
    }
    const pending = await runMigrations(pool);
    if (pending.length) throw new Error(`the restored database was missing migrations ${pending.join(', ')} (applied now); was the backup taken from this app?`);
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() ORDER BY table_name`);
    return { tables: rows.map((r) => r.table_name) };
  } finally {
    await pool.end();
  }
}

async function main(argv, env = process.env) {
  if (argv.length !== 1) {
    console.error('Usage: DATABASE_URL=<local url> node scripts/pg-restore.js <in.dump>');
    return 2;
  }
  if (!fs.existsSync(argv[0])) {
    console.error(`pg-restore: no such file: ${argv[0]}`);
    return 1;
  }
  const { tables } = await restore(argv[0], targetUrl(env, 'pg-restore'));
  console.log(`Restore OK: ${tables.length} tables (${tables.join(', ')}).`);
  return 0;
}

module.exports = { restore, main };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`pg-restore failed: ${err.message}`);
      process.exitCode = 1;
    });
}
