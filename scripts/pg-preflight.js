// PostgreSQL Slice 6A: read-only preflight audit of a SQLite database before the SQLite -> PostgreSQL data copy
// (docs/briefs/postgresql-slice-6-data-migration.md). Lists every row that cannot be copied as stored into the
// PostgreSQL baseline (src/pg/schema/001_baseline.sql). Never writes: the file is opened read-only.
//   node scripts/pg-preflight.js <path/to/assets.db> [--json]
// Exit code 0 = nothing blocks the copy, 1 = findings (or the file cannot be audited), 2 = usage error.
// Not copied, so not audited (owner decisions Q2, 2026-10-26): `sessions`; `sqlite_sequence` (replaced by identity
// sequences); `schema_migrations` (checked for its version only).
const fs = require('fs');
const Database = require('better-sqlite3');
const migrations = require('../src/migrations');

const EXPECTED_MIGRATIONS = migrations.map((m) => m.id).sort((a, b) => a - b);
const SKIPPED_TABLES = new Set(['sessions', 'sqlite_sequence', 'schema_migrations']);
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
// The 5D-2 audit query for carry-over (au), kept verbatim (PROJECT_STATUS.md).
const LICENSE_SEATS_SQL = 'SELECT id, tag, license_seats FROM assets WHERE license_seats IS NOT NULL AND (license_seats <> CAST(license_seats AS INTEGER) OR license_seats < 0 OR license_seats > 2147483647)';
// SQLite storage classes each declared type may hold so the copy keeps the value as is. REAL takes integers too
// (double precision holds every value an int4/int8 column of this app stores).
const ALLOWED = { INTEGER: ['integer'], REAL: ['real', 'integer'], TEXT: ['text'] };

const q = (name) => `"${name.replace(/"/g, '""')}"`;

function auditTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((t) => t.name)
    .filter((name) => !SKIPPED_TABLES.has(name));
}

function rowKey(db, table) {
  const pk = db.prepare(`PRAGMA table_info(${q(table)})`).all().filter((c) => c.pk);
  return pk.length === 1 ? pk[0].name : 'rowid';
}

// Returns { ok, findings, counts }. Each finding: { check, table, column?, key?, value?, message }.
function preflight(db) {
  const findings = [];
  const add = (f) => findings.push(f);

  // 1. Schema version: exactly the SQLite migrations the PostgreSQL baseline was squashed from.
  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id);
  if (applied.join(',') !== EXPECTED_MIGRATIONS.join(',')) {
    add({ check: 'schema-version', table: 'schema_migrations', value: applied.join(','), message: `SQLite migrations applied: [${applied.join(', ')}]; the PostgreSQL baseline expects exactly [${EXPECTED_MIGRATIONS.join(', ')}]` });
  }

  // 2. license_seats that the PostgreSQL integer column cannot hold (carry-over (au)); fixed at the source (Q1).
  for (const r of db.prepare(LICENSE_SEATS_SQL).all()) {
    add({ check: 'license-seats', table: 'assets', column: 'license_seats', key: r.id, value: r.license_seats, message: `Asset ${r.tag} (id ${r.id}): license_seats ${r.license_seats} is not a whole number in 0..2,147,483,647; fix it in the app before the copy` });
  }

  const counts = {};
  for (const table of auditTables(db)) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;
    const key = rowKey(db, table);
    for (const col of db.prepare(`PRAGMA table_info(${q(table)})`).all()) {
      const type = col.type.toUpperCase();
      const allowed = ALLOWED[type];
      if (!allowed) {
        add({ check: 'unknown-type', table, column: col.name, value: col.type, message: `${table}.${col.name} has declared type "${col.type}", which this audit does not know` });
        continue;
      }
      const c = q(col.name);
      // 3. Storage class vs the PostgreSQL column (text in an integer column, a blob anywhere, ...).
      //    assets.license_seats is reported by check 2 alone.
      if (!(table === 'assets' && col.name === 'license_seats')) {
        const list = allowed.map((t) => `'${t}'`).join(', ');
        for (const r of db.prepare(`SELECT ${q(key)} AS k, ${c} AS v, typeof(${c}) AS t FROM ${q(table)} WHERE ${c} IS NOT NULL AND typeof(${c}) NOT IN (${list})`).all()) {
          add({ check: 'type', table, column: col.name, key: r.k, value: r.t === 'blob' ? '<blob>' : r.v, message: `${table}.${col.name} (${key} ${r.k}) stores a ${r.t} in a ${type} column` });
        }
      }
      // 4. Integer range: every INTEGER column is int4 on PostgreSQL (sessions.expires, the one bigint, is not copied).
      if (type === 'INTEGER' && !(table === 'assets' && col.name === 'license_seats')) {
        for (const r of db.prepare(`SELECT ${q(key)} AS k, ${c} AS v FROM ${q(table)} WHERE typeof(${c}) = 'integer' AND (${c} < ${INT4_MIN} OR ${c} > ${INT4_MAX})`).safeIntegers().all()) {
          add({ check: 'int-range', table, column: col.name, key: String(r.k), value: String(r.v), message: `${table}.${col.name} (${key} ${r.k}) = ${r.v} is outside the PostgreSQL integer range` });
        }
      }
      // 5. NUL (U+0000): PostgreSQL text cannot hold it. Searched byte-wise, since SQLite's text functions may stop at a NUL.
      if (type === 'TEXT') {
        for (const r of db.prepare(`SELECT ${q(key)} AS k FROM ${q(table)} WHERE typeof(${c}) = 'text' AND instr(CAST(${c} AS BLOB), x'00') > 0`).all()) {
          add({ check: 'nul', table, column: col.name, key: r.k, message: `${table}.${col.name} (${key} ${r.k}) contains a NUL character` });
        }
      }
    }
  }

  // 6. SQLite's own consistency checks.
  for (const r of db.prepare('PRAGMA foreign_key_check').all()) {
    if (SKIPPED_TABLES.has(r.table)) continue;
    add({ check: 'foreign-key', table: r.table, key: r.rowid, value: r.parent, message: `${r.table} rowid ${r.rowid} points to a missing ${r.parent} row` });
  }
  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
  if (integrity.join() !== 'ok') {
    for (const message of integrity) add({ check: 'integrity', message });
  }

  return { ok: findings.length === 0, findings, counts };
}

function openReadOnly(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

function report({ ok, findings, counts }) {
  const lines = ['Row counts (tables that will be copied):'];
  for (const [table, n] of Object.entries(counts)) lines.push(`  ${table.padEnd(20)} ${n}`);
  lines.push('');
  if (ok) {
    lines.push('Preflight OK: nothing blocks the copy.');
  } else {
    lines.push(`Preflight FAILED: ${findings.length} finding(s) block the copy.`);
    for (const f of findings) lines.push(`  [${f.check}] ${f.message}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const args = argv.filter((a) => a !== '--json');
  if (args.length !== 1) {
    console.error('Usage: node scripts/pg-preflight.js <path/to/assets.db> [--json]');
    return 2;
  }
  if (!fs.existsSync(args[0])) {
    console.error(`pg-preflight: no such file: ${args[0]}`);
    return 1;
  }
  const db = openReadOnly(args[0]);
  try {
    const result = preflight(db);
    console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : report(result));
    return result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`pg-preflight failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { preflight, openReadOnly, report, main, LICENSE_SEATS_SQL, EXPECTED_MIGRATIONS };
