// Connectivity check for the LOCAL development PostgreSQL (docker-compose.postgres.yml).
// Prints the server version and session time zone, then "connected". Reads and writes no application data.
// Refuses any host that is not local, so a Railway (or any remote) DATABASE_URL can never be used by accident.
// Nothing under src/ imports this file.
const DEFAULT_URL = 'postgresql://nc_dev:nc_dev@127.0.0.1:5433/nc_assets_dev';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Pure: true only when the connection string can reach nothing but a local TCP host.
// pg-connection-string (2.14.1) copies EVERY query parameter into the connection config first, and a `host` query
// parameter then overrides the URL's own host (`postgresql://u:p@localhost/db?host=remote` connects to "remote").
// `hostaddr` and `port` are passed through the same way. So the rule is strict:
//   - the protocol must be postgres: or postgresql: (not socket:)
//   - NO query parameters at all (the allow-list is empty; dev needs none)
//   - the hostname must be exactly localhost, 127.0.0.1 or ::1 (so an empty host, a "/..." or "%2F..." socket path
//     and every remote name are rejected)
function isLocalDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return false;
  if (parsed.search !== '' || [...parsed.searchParams.keys()].length > 0) return false;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return LOCAL_HOSTS.has(host);
}

async function main() {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  if (!isLocalDatabaseUrl(url)) {
    console.error('db-check refuses to connect: DATABASE_URL host is not localhost, 127.0.0.1 or ::1.');
    console.error('This script is for the local Docker database only (npm run db:up).');
    process.exit(1);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query('SHOW server_version');
    const tz = await client.query('SHOW TimeZone');
    console.log(`PostgreSQL ${rows[0].server_version}`);
    console.log(`Session time zone: ${tz.rows[0].TimeZone}`);
    console.log('connected');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`db-check failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { isLocalDatabaseUrl, DEFAULT_URL };
