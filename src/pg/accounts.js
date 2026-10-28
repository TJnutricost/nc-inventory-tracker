// Accounts and sign-in on PostgreSQL (D-46, D-48, migration Slice 5C-3): the PG twin of src/accounts.js (the signed-in account behind
// a session, first-run setup, login, passwords and the reset / invite tokens). NOT used by the running app yet (Slice 5D binds it to the
// driver seam under the same names). Same names, parallel signatures, the same rows and errors; async, executor `q` first. bcrypt, token
// generation, the session and the emails stay in the routes, exactly as on SQLite. This twin does NOT implement the authentication-
// hardening backlog (PROJECT_STATUS.md): it reproduces today's behavior and only makes the races safe.
//
// Transactions: createFirstAdmin, replaceToken and completeReset are each ONE transaction: a caller's transaction when `q` is a
// transaction client, else their own (the src/pg pattern: isInTransaction(q) ? run(q) : withTransaction(run, q)).
//
// Races closed (carry-overs (ab), (ac); on SQLite they were closed in practice by the single synchronous writer, or not at all):
//   - Setup: the route checks accountCount() before bcrypt (an await), then calls createFirstAdmin. Two simultaneous setups could both
//     see zero accounts and create two admins. createFirstAdmin therefore takes a transaction-level advisory lock (SETUP_LOCK_KEY) and
//     counts the accounts again under it: the second setup waits for the first to commit, then sees its account and gets the route's
//     refusal (400 'Setup already completed'). The route already refuses this case before calling, so it only answers the race.
//   - Reset token use: the route reads the token (getToken), checks its expiry, hashes the new password (an await), then calls
//     completeReset. completeReset sets the password and deletes the account's tokens in one transaction and REFUSES (the route's own
//     400 'This link has expired. Ask for a new one.', the password change rolled back) when it deleted no token: a second reset that
//     raced the first with the same token finds the tokens gone. Exactly one of two concurrent resets succeeds.
//   - replaceToken: DELETE + INSERT in one transaction, serialized per account by a row lock on the account (FOR NO KEY UPDATE) taken
//     first: without it, two concurrent invites could each delete the old token and each insert theirs (under READ COMMITTED the second
//     DELETE does not see the first's uncommitted INSERT), leaving two live links. SQLite ran the two statements without a transaction.
// Lock order (deadlock-free with src/pg/people.js): employee row -> account row -> its tokens. Nothing here locks an employee.
//
// Differences from SQLite (output identical for the calls the routes make):
//   - `?` -> `$n`; ids that are not integers in the column's range find nothing (src/pg/reservations.js toId), as on SQLite.
//   - login_email is COLLATE NOCASE on SQLite: `a.login_email = ?` -> `lower(a.login_email) = lower($1 COLLATE "C")`, ASCII letters
//     fold, non-ASCII letters do not, exactly like NOCASE (carry-over (ap): a bare lower($1) would fold them too). The unique index
//     accounts_login_email_lower_key serves the lookup.
//   - datetime('now') -> src/pg/time.js NOW (the same text). COUNT(*) comes back as a JS number (src/pg/pool.js int8 parser).
//   - An email or token containing a NUL character finds nothing (PostgreSQL text cannot hold NUL, the query would fail with a 500;
//     SQLite finds no row): loginAccount, resetAccount and getToken answer undefined, so login / forgot / reset answer as on SQLite.
//   - createFirstAdmin refuses when an account already exists (above); completeReset refuses when the account has no token (above);
//     replaceToken is atomic: a failing INSERT leaves the previous token in place (SQLite had already deleted it). None of these is
//     reachable through today's routes except by the races they close.
const { toId } = require('./reservations');
const { withTransaction, isInTransaction } = require('./transaction');
const { NOW } = require('./time');

const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const one = async (q, sql, params) => (await q.query(sql, params)).rows[0];
const hasNul = (v) => typeof v === 'string' && v.includes('\u0000');
const SETUP_LOCK_KEY = 4_651_201_400_019; // arbitrary constant (src/pg/migrate.js ...017, src/pg/sweep.js ...018)
const GOOGLE_LOCK_KEY = 46_512_020; // int4 class key of the per-address Google sign-in lock (the two-key advisory lock form)
const SETUP_DONE = 'Setup already completed'; // the route's refusal (src/server.js POST /api/setup)
const LINK_EXPIRED = 'This link has expired. Ask for a new one.'; // the route's refusal (src/server.js POST /api/reset)

// The active account (and its active employee, if any) with this login email, the SQLite NOCASE way.
const ACTIVE_LOGIN = `FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE lower(a.login_email) = lower($1 COLLATE "C") AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`;

// Identity model (Phase 1D): a session identifies an ACCOUNT; `uid` is the session's account id. A missing one, or an account /
// employee that is no longer active, is nobody (null).
async function currentUser(q, uid) {
  if (!uid) return null;
  return (await one(q, `
    SELECT a.id AS account_id, a.employee_id, a.role, a.login_email AS email, a.password_hash, a.last_login_at,
      COALESCE(e.name, a.login_email) AS name, e.first_name, e.last_name, e.department, e.title, e.phone, e.building, e.created_at, COALESCE(e.can_self_checkout, 0) AS can_self_checkout
    FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.id = $1 AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`, [toId(uid)])) || null;
}

// ---- first-run setup ----
const accountCount = async (q) => (await one(q, 'SELECT COUNT(*) AS c FROM accounts')).c;
// The first admin: one employee (department IT) and its admin account, one transaction, serialized against any other setup (above).
// Returns the account id (the new session's uid).
const createFirstAdmin = async (q, { name, firstName = null, lastName = null, mail, hash }) => inTransaction(q, async (c) => {
  await c.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);
  if ((await accountCount(c)) > 0) throw httpError(400, SETUP_DONE);
  const emp = (await one(c, "INSERT INTO employees (name, first_name, last_name, work_email, department) VALUES ($1, $2, $3, $4, 'IT') RETURNING id", [name, firstName, lastName, mail])).id;
  return (await one(c, "INSERT INTO accounts (employee_id, login_email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id", [emp, mail, hash])).id;
});

// ---- login ----
// The active account with this (normalized) login email, its employee (if any) active too; undefined otherwise.
const loginAccount = async (q, email) => (hasNul(email) ? undefined : one(q, `SELECT a.* ${ACTIVE_LOGIN}`, [email]));
// Google sign-in (D-10): the active account of the ACTIVE employee with this work email (SQLite NOCASE, as loginAccount); undefined if none.
const googleAccount = async (q, email) => (hasNul(email) ? undefined : one(q, `SELECT a.* FROM accounts a JOIN employees e ON e.id = a.employee_id
    WHERE lower(e.work_email) = lower($1 COLLATE "C") AND a.active = 1 AND e.status = 'active'`, [email]));
// Google sign-in, first time: the SQLite twin's rules, one transaction (a caller's when given its client). Two first sign-ins with the
// same address at once (two tabs) are serialized by a transaction advisory lock on the lower-cased address, so the second finds the
// first's login and signs into it; a concurrent admin create with the same address is caught by the unique indexes (23505: refused,
// null; signing in again then finds the login). Lock order as elsewhere: employee row -> account.
async function provisionGoogleAccount(q, { email, name }) {
  if (hasNul(email) || hasNul(name)) return null;
  try {
    return await inTransaction(q, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1, hashtext(lower($2 COLLATE "C")))', [GOOGLE_LOCK_KEY, email]);
      const e = await one(c, `SELECT e.id, e.status, a.id AS account_id, a.active FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id
        WHERE lower(e.work_email) = lower($1 COLLATE "C") FOR UPDATE OF e`, [email]);
      if (e && e.account_id) return e.status === 'active' && e.active === 1 ? e.account_id : null;
      if ((e && e.status !== 'active') || await one(c, 'SELECT 1 FROM accounts WHERE lower(login_email) = lower($1 COLLATE "C")', [email])) return null;
      const emp = e ? e.id : (await one(c, 'INSERT INTO employees (name, work_email, can_self_checkout) VALUES ($1, $2, 0) RETURNING id', [name, email])).id;
      return (await one(c, "INSERT INTO accounts (employee_id, login_email, role) VALUES ($1, $2, 'employee') RETURNING id", [emp, email])).id;
    });
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}
// GOOGLE_ADMIN_EMAILS (as SQLite): that login becomes an admin; never demotes; true when it changed the role.
const makeAdmin = async (q, accountId) => (await q.query("UPDATE accounts SET role = 'admin' WHERE id = $1 AND role <> 'admin'", [toId(accountId)])).rowCount === 1;
async function recordLogin(q, accountId) { await q.query(`UPDATE accounts SET last_login_at = ${NOW} WHERE id = $1`, [toId(accountId)]); }

// ---- passwords and tokens ----
// `hash` is the bcrypt hash of the new password.
async function setPassword(q, accountId, hash) { await q.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hash, toId(accountId)]); }

// POST /api/forgot: who a reset link goes to (same active-account rule as login); undefined if nobody.
const resetAccount = async (q, email) => (hasNul(email) ? undefined
  : one(q, `SELECT a.id, a.login_email, COALESCE(e.name, a.login_email) AS name ${ACTIVE_LOGIN}`, [email]));

// Tokens belong to an ACCOUNT (password reset / invite); tokens.user_id holds the account id. Issuing one replaces the account's previous
// token of the same purpose, atomically and one issue per account at a time (above). The route generates `token` and `expiresAt`.
async function replaceToken(q, userId, purpose, token, expiresAt) {
  const id = toId(userId);
  await inTransaction(q, async (c) => {
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [id]);
    await c.query('DELETE FROM tokens WHERE user_id = $1 AND purpose = $2', [id, purpose]);
    await c.query('INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)', [token, id, purpose, expiresAt]);
  });
}
const getToken = async (q, token) => (hasNul(token) ? undefined : one(q, 'SELECT * FROM tokens WHERE token = $1', [token]));
// POST /api/reset, after the token was checked: the new password, then every token of that account is gone (the link is single use).
// One transaction; no token left to delete means another reset used the link first: refused, nothing changed (above).
async function completeReset(q, accountId, hash) {
  const id = toId(accountId);
  await inTransaction(q, async (c) => {
    await setPassword(c, id, hash);
    const { rowCount } = await c.query('DELETE FROM tokens WHERE user_id = $1', [id]);
    if (rowCount === 0) throw httpError(400, LINK_EXPIRED);
  });
}

module.exports = { currentUser, accountCount, createFirstAdmin, loginAccount, googleAccount, provisionGoogleAccount, makeAdmin, recordLogin, setPassword, resetAccount, replaceToken, getToken, completeReset };
