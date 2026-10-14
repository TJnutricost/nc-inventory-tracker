// Can the LOCAL PostgreSQL test server be reached? Used two ways:
//   - by pg-harness.js probePostgres(), as a child process (so the check can run synchronously while a test file loads)
//   - by `npm run test:pg`, before the PG tests, so an unavailable database fails with ONE clear message
// URL: argv[2], else TEST_DATABASE_URL, else the local dev database. Exit codes:
//   0 reachable · 2 unreachable (reason on stderr) · 3 refused: the URL is not local (no connection was attempted)
// It runs SELECT 1 on the server's own database and touches nothing else.
const { isLocalDatabaseUrl, DEV_DATABASE_URL } = require('../src/pg/local-url');

const url = process.argv[2] || process.env.TEST_DATABASE_URL || DEV_DATABASE_URL;
if (!isLocalDatabaseUrl(url)) {
  console.error('Refusing to connect: the PostgreSQL test URL is not localhost, 127.0.0.1 or ::1 (or it has query parameters). PG tests only ever use the local Docker database.');
  process.exit(3);
}
const where = (() => { const u = new URL(url); return `${u.hostname}:${u.port || 5432}${u.pathname}`; })();
const { Client } = require('pg');
const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
client.connect()
  .then(() => client.query('SELECT 1'))
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`PostgreSQL is not reachable at ${where} (${err.message || err.code || String(err)}). Start the local database with: npm run db:up`);
    process.exit(2);
  });
