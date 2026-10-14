// Connectivity check for the LOCAL development PostgreSQL (docker-compose.postgres.yml).
// Prints the server version and session time zone, then "connected". Reads and writes no application data.
// Refuses any host that is not local, so a Railway (or any remote) DATABASE_URL can never be used by accident.
// Nothing under src/ imports this file. The local-only rule itself lives in src/pg/local-url.js (shared with the
// PostgreSQL test harness, so every create/drop/probe tool applies exactly the same rule).
const { isLocalDatabaseUrl, DEV_DATABASE_URL: DEFAULT_URL } = require('../src/pg/local-url');

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
