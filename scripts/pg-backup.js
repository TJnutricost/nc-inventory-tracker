// PostgreSQL Slice 6C: backs up a PostgreSQL database to one file with pg_dump (custom format, compressed), proven to
// restore by scripts/pg-restore.js (docs/briefs/postgresql-slice-6-data-migration.md).
//   DATABASE_URL=<local url> node scripts/pg-backup.js <out.dump>
// Local PostgreSQL only for now (src/pg/local-url.js): backing up Railway is a Slice 7 decision.
// Exit code 0 = written and readable, 1 = failed (no file is left behind), 2 = usage error.
//   - pg_dump must be major version 18 (the server's). A local `pg_dump` 18 on PATH (or in $PG_BIN) is used; otherwise
//     the `postgres:18` Docker image runs it, reaching a local server through host.docker.internal.
//   - The password goes in PGPASSWORD, never on a command line.
//   - The dump is written to <out>.partial and renamed only after `pg_restore --list` has read it back.
//   - --no-owner --no-privileges: the backup restores into any database, whoever owns it.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveDatabaseUrl } = require('../src/pg/pool');
const { isLocalDatabaseUrl } = require('../src/pg/local-url');

const PG_MAJOR = 18;
const DOCKER_IMAGE = `postgres:${PG_MAJOR}`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// { url (no password), password }: the password travels in PGPASSWORD.
function splitPassword(url) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), password };
}

// How to run a PostgreSQL client tool: { cmd, args, url, env }. `url` is rewritten for Docker when needed.
function pgTool(name, databaseUrl, env = process.env) {
  const { url, password } = splitPassword(databaseUrl);
  const toolEnv = { ...env, PGPASSWORD: password };
  const local = env.PG_BIN ? path.join(env.PG_BIN, name) : name;
  const version = spawnSync(local, ['--version'], { encoding: 'utf8' });
  const major = version.status === 0 && /\b(\d+)(?:\.\d+)?/.exec(version.stdout);
  if (major && Number(major[1]) === PG_MAJOR) return { cmd: local, args: [], url, env: toolEnv };
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status !== 0) {
    throw new Error(`${name} ${PG_MAJOR} was not found (PATH or PG_BIN) and Docker is not running to provide it.`);
  }
  const u = new URL(url);
  if (LOCAL_HOSTS.has(u.hostname)) u.hostname = 'host.docker.internal';
  return {
    cmd: 'docker',
    args: ['run', '--rm', '-i', '--add-host=host.docker.internal:host-gateway', '-e', 'PGPASSWORD', DOCKER_IMAGE, name],
    url: u.toString(),
    env: toolEnv,
  };
}

// Runs a tool; stdin/stdout may be file descriptors. Resolves { stdout, stderr } or rejects with the tool's stderr.
function run(tool, args, { stdin = 'ignore', stdout = 'pipe' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.cmd, [...tool.args, ...args], { env: tool.env, stdio: [stdin, stdout, 'pipe'] });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(`${args[0] || tool.cmd} failed (exit ${code}): ${err.trim()}`))));
  });
}

// The entries of a dump, by `pg_restore --list` (reads the file back, so a truncated dump fails here).
async function listDump(file, databaseUrl) {
  const tool = pgTool('pg_restore', databaseUrl);
  const fd = fs.openSync(file, 'r');
  try {
    const { stdout } = await run(tool, ['--list'], { stdin: fd });
    return stdout.split('\n').filter((l) => l && !l.startsWith(';'));
  } finally {
    fs.closeSync(fd);
  }
}

// Writes the backup of `databaseUrl` to `file`. Returns { file, bytes, tables } (tables = TABLE DATA entries).
async function backup(databaseUrl, file) {
  const tool = pgTool('pg_dump', databaseUrl);
  const partial = `${file}.partial`;
  const fd = fs.openSync(partial, 'w');
  try {
    try {
      await run(tool, ['--format=custom', '--no-owner', '--no-privileges', tool.url], { stdout: fd });
    } finally {
      fs.closeSync(fd);
    }
    const entries = await listDump(partial, databaseUrl);
    const tables = entries.filter((l) => / TABLE DATA /.test(l)).length;
    if (tables === 0) throw new Error('the dump has no table data');
    fs.renameSync(partial, file);
    return { file, bytes: fs.statSync(file).size, tables };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

function targetUrl(env, who) {
  const url = env.DATABASE_URL || resolveDatabaseUrl(env);
  if (!isLocalDatabaseUrl(url)) throw new Error(`${who} refuses to connect: DATABASE_URL host is not localhost, 127.0.0.1 or ::1 (Railway is Slice 7).`);
  return url;
}

async function main(argv, env = process.env) {
  if (argv.length !== 1) {
    console.error('Usage: DATABASE_URL=<local url> node scripts/pg-backup.js <out.dump>');
    return 2;
  }
  if (fs.existsSync(argv[0])) {
    console.error(`pg-backup: ${argv[0]} already exists; choose a new file name.`);
    return 1;
  }
  const { file, bytes, tables } = await backup(targetUrl(env, 'pg-backup'), argv[0]);
  console.log(`Backup OK: ${file} (${bytes} bytes, ${tables} tables with data).`);
  return 0;
}

module.exports = { backup, listDump, pgTool, run, targetUrl, PG_MAJOR };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`pg-backup failed: ${err.message}`);
      process.exitCode = 1;
    });
}
