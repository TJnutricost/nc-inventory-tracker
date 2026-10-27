// Which database a migration tool (scripts/pg-copy.js, pg-verify.js, pg-backup.js, pg-restore.js) may touch (D-46,
// Slice 7B). Two modes, chosen by an explicit flag, never by guessing:
//
//   LOCAL (default, no flag): the local Docker dev database only. The host must be loopback (src/pg/local-url.js) AND the
//     role must be the dev-only `nc_dev` (docker-compose.postgres.yml: "must NEVER be reused ... not on Railway"). The
//     second check exists because an SSH tunnel (`railway connect --tunnel-only`) makes a Railway database answer on
//     localhost: a host check alone would call a staging URL "local".
//
//   STAGING TUNNEL (`--staging-tunnel`): the approved connection strategy (D1): the Railway CLI's SSH tunnel to Railway
//     PostgreSQL, so the URL is still loopback. The flag NEVER permits a direct remote host (loopback only, no query
//     parameters), and needs ALL of:
//       - `--confirm-target <host:port/database>` equal to the URL's own target (the tunnel's port and the database name,
//         never credentials), so the operator has to read the target before anything connects;
//       - a role that is not the dev role and a database that is not nc_assets_dev / nc_test_* (the staging target is not
//         the local one by accident);
//       - after connecting: the server's current_database() equals the confirmed one, current_user is not the dev role and
//         the server is PostgreSQL 18 (the version the dump tools match).
//     Reads (verify, backup) then run. Writes (copy, restore) are a DRY RUN unless `--execute` is also given, and
//     `--execute` additionally needs an interactive terminal where the operator types the target-specific phrase: a
//     script, a pipe or an agent cannot supply it.
//
// Credentials are never printed: labels hold host:port/database only, and error text goes through redact().
const readline = require('node:readline');
const { isLocalDatabaseUrl, DEV_DATABASE_URL } = require('./local-url');

const DEV_USER = new URL(DEV_DATABASE_URL).username; // nc_dev
const DEV_DATABASE = new URL(DEV_DATABASE_URL).pathname.slice(1); // nc_assets_dev
const SERVER_MAJOR = 18;

const FLAGS = { '--staging-tunnel': 'stagingTunnel', '--execute': 'execute' };

// { positional: [...], stagingTunnel, execute, confirmTarget } from argv. Unknown --flags are errors (no silent typo).
function parseToolArgs(argv) {
  const out = { positional: [], stagingTunnel: false, execute: false, confirmTarget: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS[arg]) out[FLAGS[arg]] = true;
    else if (arg === '--confirm-target') {
      if (i + 1 >= argv.length) throw new Error('--confirm-target needs a value: host:port/database');
      out.confirmTarget = argv[++i];
    } else if (arg.startsWith('--confirm-target=')) out.confirmTarget = arg.slice('--confirm-target='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

function parsed(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// "host:port/database": identifies a target without any credential. null for an unparsable URL.
function targetLabel(url) {
  const u = parsed(url);
  if (!u) return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return `${host.includes(':') ? `[${host}]` : host}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1))}`;
}

// Removes the URL, its password (raw and percent-encoded) and its username from text bound for a log.
function redact(text, ...urls) {
  let out = String(text);
  for (const url of urls) {
    const u = url && parsed(url);
    if (!u) continue;
    const secrets = [url, u.password, decodeURIComponent(u.password || '')].filter((s) => s && s.length >= 3);
    for (const secret of secrets) out = out.split(secret).join('***');
  }
  return out;
}

// Validates a URL for a tool BEFORE any connection. Returns { url, mode: 'local' | 'staging', label, dryRun }.
// `write` is true for tools that change the target (copy, restore); a staging write is a dry run unless --execute.
function resolveTarget(url, options = {}, { write = false, who = 'This tool' } = {}) {
  const { stagingTunnel = false, execute = false, confirmTarget = null } = options;
  const u = typeof url === 'string' ? parsed(url) : null;
  if (!u) throw new Error(`${who} refuses to continue: DATABASE_URL is missing or not a valid connection URL.`);
  if (!isLocalDatabaseUrl(url)) {
    throw new Error(`${who} refuses to connect: DATABASE_URL must be a loopback host (localhost, 127.0.0.1 or ::1, the Railway tunnel included) with no query parameters. A direct remote host is never allowed.`);
  }
  const user = decodeURIComponent(u.username);
  const database = decodeURIComponent(u.pathname.slice(1));
  const label = targetLabel(url);

  if (!stagingTunnel) {
    if (execute || confirmTarget !== null) throw new Error(`${who}: --execute and --confirm-target only apply with --staging-tunnel.`);
    if (user !== DEV_USER) {
      throw new Error(`${who} refuses to connect: the local mode needs the dev-only role ${DEV_USER} (docker-compose.postgres.yml). This URL uses another role, and a tunnelled Railway database also looks like localhost. For the Railway staging tunnel pass --staging-tunnel --confirm-target ${label}.`);
    }
    return { url, mode: 'local', label, dryRun: false };
  }

  if (user === DEV_USER || database === DEV_DATABASE || /^nc_test_/.test(database)) {
    throw new Error(`${who} refuses the staging tunnel: ${label} (role ${user}) is the local dev/test database, not a Railway staging target.`);
  }
  if (!user) throw new Error(`${who} refuses the staging tunnel: the URL has no role.`);
  if (confirmTarget === null) {
    throw new Error(`${who} needs --confirm-target ${label} to use the staging tunnel (the exact target, read before it is used). Nothing was contacted.`);
  }
  if (confirmTarget !== label) {
    throw new Error(`${who}: --confirm-target "${confirmTarget}" does not match the URL's target ${label}. Nothing was contacted.`);
  }
  return { url, mode: 'staging', label, dryRun: Boolean(write) && !execute };
}

// After connecting (a read): the server must be the confirmed database, not the dev role, PostgreSQL 18.
async function assertStagingServer(pool, target) {
  const { rows } = await pool.query('SELECT current_database() AS db, current_user AS usr, current_setting(\'server_version_num\')::int AS num');
  const { db, usr, num } = rows[0];
  const expected = target.label.slice(target.label.indexOf('/') + 1);
  if (db !== expected) throw new Error(`Connected to database "${db}", not the confirmed "${expected}". Nothing was changed.`);
  if (usr === DEV_USER) throw new Error(`Connected as the dev role ${DEV_USER}: this is not a Railway staging connection. Nothing was changed.`);
  const major = Math.floor(num / 10000);
  if (major !== SERVER_MAJOR) throw new Error(`The server is PostgreSQL ${major}, the tools match ${SERVER_MAJOR}. Nothing was changed; this needs an owner decision.`);
  return { database: db, role: usr, major };
}

// The sentence the operator types to authorize a staging write.
const confirmationPhrase = (target) => `WRITE STAGING ${target.label}`;

// Interactive gate for a staging write: needs a TTY on input, prints what is about to happen, and reads one line that
// must equal confirmationPhrase(target). Refuses (throws) otherwise, before anything is written.
async function confirmWrite(target, summary, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    throw new Error('A staging write needs an interactive terminal (the operator types the confirmation); this is not one. Nothing was changed.');
  }
  const phrase = confirmationPhrase(target);
  output.write(`\n${summary}\nTarget: ${target.label}\nTo continue type exactly: ${phrase}\n> `);
  const rl = readline.createInterface({ input, output, terminal: false });
  const answer = await new Promise((resolve) => {
    rl.once('line', resolve);
    rl.once('close', () => resolve(null));
  });
  rl.close();
  if (answer !== phrase) throw new Error('The confirmation did not match. Nothing was changed.');
}

module.exports = { parseToolArgs, resolveTarget, assertStagingServer, confirmWrite, confirmationPhrase, targetLabel, redact, DEV_USER };
