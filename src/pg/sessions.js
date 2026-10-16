// The login sessions table on PostgreSQL (D-46, D-48, migration Slice 5C-3): the PG twin of src/sessions.js. NOT used by the running
// app yet: Slice 5D binds it to the driver seam under the same names, behind the same small express-session Store class in server.js
// (the session's JSON encoding, its expiry time and "an expired row is no session" stay in that class). Same names, parallel
// signatures, the same rows; async, executor `q` first. Single statements, no transaction needed.
//
// Differences from SQLite (output identical; no schema change: `sess` is text and `expires` bigint in the baseline):
//   - `?` -> `$n`; `expires` (bigint) comes back as a JS number (src/pg/pool.js int8 parser), so the store's `row.expires < Date.now()`
//     compares numbers exactly as on SQLite.
//   - `set` is the same upsert (ON CONFLICT (sid) DO UPDATE).
//   - destroyForAccount keeps SQLite's closing-brace pattern `%"uid":N}%` (a session stores its account as the LAST key of its JSON,
//     so account 1 never matches 12 or 100), as a bound parameter (an integer id holds no LIKE wildcard). SQLite's LIKE folds ASCII
//     letters; ILIKE on the "C"-collated column folds ASCII letters only, the same match (carry-over (ad): no new column needed).
//   - The deactivated-session re-save (carry-over (af), auth-hardening backlog item (d)) is NOT changed: as on SQLite, a request that
//     was already past `auth` when its account was deactivated re-saves its session at the end (`set` upserts the row again);
//     currentUser still refuses an inactive account. Deciding that is Slice 5D / the hardening slice.
const one = async (q, sql, params) => (await q.query(sql, params)).rows[0];

// A stored session: { sess (JSON text), expires (ms since the epoch) }, or undefined.
const get = async (q, sid) => one(q, 'SELECT sess, expires FROM sessions WHERE sid = $1', [sid]);

// Creates or replaces a session. `sess` is the session as JSON text, `expires` the time (ms) it stops being valid.
async function set(q, sid, sess, expires) {
  await q.query('INSERT INTO sessions (sid, sess, expires) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
    [sid, sess, expires]);
}

async function destroy(q, sid) { await q.query('DELETE FROM sessions WHERE sid = $1', [sid]); }

// The hourly clean-up: every session whose expiry time is before `now` (ms).
async function purgeExpired(q, now) { await q.query('DELETE FROM sessions WHERE expires < $1', [now]); }

// Signs an account out everywhere (PUT /api/users/:id deactivating a person): only that account's sessions (pattern above).
async function destroyForAccount(q, accountId) { await q.query('DELETE FROM sessions WHERE sess ILIKE $1', [`%"uid":${accountId}}%`]); }

module.exports = { get, set, destroy, purgeExpired, destroyForAccount };
