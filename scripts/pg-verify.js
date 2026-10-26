// PostgreSQL Slice 6B: compares a SQLite database with the PostgreSQL database it was copied into
// (scripts/pg-copy.js; docs/briefs/postgresql-slice-6-data-migration.md). Read-only on both sides.
//   DATABASE_URL=<local url> node scripts/pg-verify.js <path/to/assets.db>
// Exit code 0 = identical, 1 = differences (or it cannot verify), 2 = usage error.
// Per copied table: the same row count and every row equal column by column, matched by primary key; every identity
// sequence past the largest id; `sessions` empty on the target (not copied).
const fs = require('fs');
const { createPool, resolveDatabaseUrl } = require('../src/pg/pool');
const { isLocalDatabaseUrl } = require('../src/pg/local-url');
const { openReadOnly } = require('./pg-preflight');
const { COPY_TABLES, NOT_COPIED, identitySequences } = require('./pg-copy');

const MAX_DIFFS_PER_TABLE = 20;
const q = (name) => `"${name.replace(/"/g, '""')}"`;

// better-sqlite3 and the app's pg pool both return int4 / int8 / float8 as JS numbers and text as strings, so values
// compare with ===; anything else (a Buffer, a bigint, a Date) is a type difference in itself.
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
const show = (v) => (typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}...` : v) : String(v));

async function verify(sqlite, pool) {
  const tables = {};
  const differences = [];
  for (const { table, key } of COPY_TABLES) {
    const cols = sqlite.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name);
    const src = sqlite.prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`).all();
    const dst = (await pool.query(`SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`)).rows;
    tables[table] = { sqlite: src.length, pg: dst.length };
    if (src.length !== dst.length) differences.push(`${table}: ${src.length} row(s) in SQLite, ${dst.length} in PostgreSQL`);
    const byKey = new Map(dst.map((r) => [r[key], r]));
    let shown = 0;
    for (const row of src) {
      const other = byKey.get(row[key]);
      if (!other) {
        if (shown++ < MAX_DIFFS_PER_TABLE) differences.push(`${table} ${key}=${show(row[key])}: missing in PostgreSQL`);
        continue;
      }
      for (const c of cols) {
        if (!same(row[c], other[c]) && shown++ < MAX_DIFFS_PER_TABLE) {
          differences.push(`${table} ${key}=${show(row[key])}.${c}: SQLite ${show(row[c])} (${typeof row[c]}), PostgreSQL ${show(other[c])} (${typeof other[c]})`);
        }
      }
    }
  }
  for (const table of NOT_COPIED) {
    const n = Number((await pool.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
    if (n > 0) differences.push(`${table}: expected empty on PostgreSQL (not copied), found ${n} row(s)`);
  }
  for (const { table, seq } of await identitySequences(pool)) {
    const { rows } = await pool.query(`SELECT (SELECT MAX(id) FROM ${q(table)}) AS max, last_value, is_called FROM ${seq}`);
    const next = rows[0].is_called ? Number(rows[0].last_value) + 1 : Number(rows[0].last_value);
    const max = rows[0].max === null ? 0 : rows[0].max;
    if (next <= max) differences.push(`${table}: the next generated id would be ${next}, but ids up to ${max} exist`);
  }
  return { ok: differences.length === 0, tables, differences };
}

function report({ ok, tables, differences }) {
  const lines = ['Rows (SQLite / PostgreSQL):'];
  for (const [table, n] of Object.entries(tables)) lines.push(`  ${table.padEnd(20)} ${n.sqlite} / ${n.pg}`);
  lines.push('');
  if (ok) lines.push('Verify OK: every copied row is identical and every sequence is past the copied ids.');
  else {
    lines.push(`Verify FAILED: ${differences.length} difference(s).`);
    for (const d of differences) lines.push(`  ${d}`);
  }
  return lines.join('\n');
}

async function main(argv, env = process.env) {
  if (argv.length !== 1) {
    console.error('Usage: DATABASE_URL=<local url> node scripts/pg-verify.js <path/to/assets.db>');
    return 2;
  }
  if (!fs.existsSync(argv[0])) {
    console.error(`pg-verify: no such file: ${argv[0]}`);
    return 1;
  }
  const url = env.DATABASE_URL || resolveDatabaseUrl(env);
  if (!isLocalDatabaseUrl(url)) {
    console.error('pg-verify refuses to connect: DATABASE_URL host is not localhost, 127.0.0.1 or ::1.');
    return 1;
  }
  const sqlite = openReadOnly(argv[0]);
  const pool = createPool(url);
  try {
    const result = await verify(sqlite, pool);
    console.log(report(result));
    return result.ok ? 0 : 1;
  } finally {
    sqlite.close();
    await pool.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`pg-verify failed: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { verify, report, main };
