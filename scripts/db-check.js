// Connectivity check for the LOCAL development PostgreSQL (docker-compose.postgres.yml).
// Prints the server version and session time zone, then "connected". Reads and writes no application data.
// Refuses any host that is not local, so a Railway (or any remote) DATABASE_URL can never be used by accident.
// Nothing under src/ imports this file.
const DEFAULT_URL = 'postgresql://nc_dev:nc_dev@127.0.0.1:5433/nc_assets_dev';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Pure: true only when the connection string's host is localhost, 127.0.0.1 or ::1.
function isLocalDatabaseUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
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
