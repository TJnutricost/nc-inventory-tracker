// The login sessions table (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-3 (D-48): the SQL is
// unchanged; the database handle is the first argument, like the other data modules. server.js keeps the small express-session Store
// class (`SqliteStore`), which turns each of its callbacks into ONE call of the seam (`data.sessions.*`); the JSON encoding of a session,
// its expiry time and the "expired means no session" rule stay in that class, exactly as before. A PostgreSQL session store is Slice 5D.

// A stored session: { sess (JSON text), expires (ms since the epoch) }, or undefined.
const get = (db, sid) => db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);

// Creates or replaces a session. `sess` is the session as JSON text, `expires` the time (ms) it stops being valid.
function set(db, sid, sess, expires) {
  db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires')
    .run(sid, sess, expires);
}

function destroy(db, sid) { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); }

// The hourly clean-up: every session whose expiry time is before `now` (ms).
function purgeExpired(db, now) { db.prepare('DELETE FROM sessions WHERE expires < ?').run(now); }

// Signs an account out everywhere (PUT /api/users/:id deactivating a person). A session stores its account as the LAST key of its
// JSON (`..."uid":12}`), so the closing brace keeps account 1 from matching 12 or 100. (PostgreSQL needs its own form of this: 5C/5D.)
function destroyForAccount(db, accountId) { db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"uid":${accountId}}%`); }

module.exports = { get, set, destroy, purgeExpired, destroyForAccount };
