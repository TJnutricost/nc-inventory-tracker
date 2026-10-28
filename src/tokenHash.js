// Reset / invitation tokens are stored as hashes, never as the link's secret (the `tokens.token` column holds `sha256:<hex>`). A token is 24
// random bytes, so a plain SHA-256 is enough (nothing to brute-force, no password to stretch) and, unlike an HMAC, it does not depend on a
// server secret that may be rotated. Both drivers (src/accounts.js, src/pg/accounts.js) hash here, so the routes keep handling the raw token.
// Migration 20 (SQLite) / 4 (PostgreSQL) converts the tokens that were outstanding when this shipped with the same function, so their links
// keep working; `sha256(convert_to(token, 'UTF8'))` in the PostgreSQL migration is the same digest of the same bytes.
const crypto = require('crypto');

const PREFIX = 'sha256:';
const hashToken = (token) => PREFIX + crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

// The invitation / reset link is `#/reset/<token>`: its token never goes into the outbox (that table keeps what each email said, not a
// working link) or a log line. The email that is actually sent is not touched.
const redactTokenLinks = (html) => String(html).replace(/(#\/reset\/)[A-Za-z0-9_-]+/g, '$1[redacted]');

module.exports = { PREFIX, hashToken, redactTokenLinks };
