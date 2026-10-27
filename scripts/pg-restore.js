// PostgreSQL Slice 6C: restores a scripts/pg-backup.js file into an EMPTY PostgreSQL database
// (docs/briefs/postgresql-slice-6-data-migration.md).
//   DATABASE_URL=<local url> node scripts/pg-restore.js <in.dump>
//   DATABASE_URL=<tunnel url> node scripts/pg-restore.js <in.dump> --staging-tunnel --confirm-target <host:port/db> [--execute]
// Local dev database by default; the Railway staging tunnel needs --staging-tunnel and the exact target (src/pg/target.js).
// A staging restore is a DRY RUN (the dump is read back, the target is looked at read-only) unless --execute is given, and
// --execute makes the operator type a confirmation phrase in an interactive terminal.
// Exit code 0 = restored (or a clean dry run), 1 = refused or failed, 2 = usage error.
//   - Refuses a target that already has any table: a restore never merges into or overwrites data.
//   - pg_restore --single-transaction --exit-on-error: any error leaves the target as empty as it was.
//   - Afterwards the PostgreSQL migrations must have nothing left to apply (the backup carries schema_migrations).
const fs = require('fs');
const { createPool } = require('../src/pg/pool');
const { runMigrations } = require('../src/pg/migrate');
const { pgTool, run, listDump } = require('./pg-backup');
const { parseToolArgs, resolveTarget, assertStagingServer, confirmWrite, redact } = require('../src/pg/target');
const { resolveDatabaseUrl } = require('../src/pg/pool');

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

// Staging dry run: the dump must be readable and the target must hold no table; reads only, nothing is restored.
async function dryRun(file, databaseUrl) {
  const entries = await listDump(file, databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`);
      return { entries: entries.length, existing: rows.map((r) => r.table_name) };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main(argv, env = process.env, io = {}) {
  let opts;
  try {
    opts = parseToolArgs(argv);
  } catch (err) {
    console.error(`pg-restore: ${err.message}`);
    return 2;
  }
  if (opts.positional.length !== 1) {
    console.error('Usage: DATABASE_URL=<local url> node scripts/pg-restore.js <in.dump> [--staging-tunnel --confirm-target <host:port/db> [--execute]]');
    return 2;
  }
  const file = opts.positional[0];
  if (!fs.existsSync(file)) {
    console.error(`pg-restore: no such file: ${file}`);
    return 1;
  }
  const url = env.DATABASE_URL || resolveDatabaseUrl(env);
  let target;
  try {
    target = resolveTarget(url, opts, { write: true, who: 'pg-restore' });
  } catch (err) {
    console.error(redact(err.message, url));
    return 1;
  }
  try {
    if (target.mode === 'staging') {
      const pool = createPool(url);
      try {
        const server = await assertStagingServer(pool, target);
        console.log(`Connected to ${target.label} as ${server.role} (PostgreSQL ${server.major}).`);
      } finally {
        await pool.end();
      }
      const look = await dryRun(file, url);
      if (look.existing.length) {
        console.error(`pg-restore refuses: the target database is not empty (tables: ${look.existing.join(', ')}). Nothing was changed.`);
        return 1;
      }
      if (target.dryRun) {
        console.log(`DRY RUN against ${target.label}: nothing was written.\nThe dump is readable (${look.entries} entries) and the target is empty.\nTo restore, repeat the command with --execute (an interactive confirmation follows).`);
        return 0;
      }
      await confirmWrite(target, `About to RESTORE ${file} into the EMPTY Railway staging database.`, io);
    }
    const { tables } = await restore(file, url);
    console.log(`Restore OK: ${tables.length} tables (${tables.join(', ')}).`);
    return 0;
  } catch (err) {
    console.error(`pg-restore failed: ${redact(err.message, url)}`);
    return 1;
  }
}

module.exports = { restore, main, dryRun };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`pg-restore failed: ${redact(err.message, process.env.DATABASE_URL)}`);
      process.exitCode = 1;
    });
}
