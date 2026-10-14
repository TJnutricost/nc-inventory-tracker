// The local-only rule for PostgreSQL tooling (D-46). Every tool that creates, drops, resets or merely probes a database
// outside the running app (scripts/db-check.js, the per-file test harness) checks a URL with isLocalDatabaseUrl()
// BEFORE it opens any connection, so a Railway (or any remote) DATABASE_URL can never be used by accident.
// The app's own pool (src/pg/pool.js) does NOT apply this rule: in production it must reach the hosted database.

// Dev-only credentials from docker-compose.postgres.yml (public in this repo; never reuse them anywhere else).
const DEV_DATABASE_URL = 'postgresql://nc_dev:nc_dev@127.0.0.1:5433/nc_assets_dev';
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

// Throws (without connecting) unless the URL is local. `what` names the refusing tool in the message.
function assertLocalDatabaseUrl(url, what = 'This tool') {
  if (!isLocalDatabaseUrl(url)) {
    throw new Error(`${what} refuses to connect: the database URL host is not localhost, 127.0.0.1 or ::1 (or it has query parameters). It is for the local Docker database only (npm run db:up).`);
  }
  return url;
}

module.exports = { DEV_DATABASE_URL, isLocalDatabaseUrl, assertLocalDatabaseUrl };
