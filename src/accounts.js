// Accounts and sign-in (SQLite): the signed-in account behind a session, first-run setup, login, passwords and the reset / invite
// tokens. Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-3 (D-48): the SQL and the transaction boundaries are
// unchanged; the database handle is the first argument, like the other data modules. bcrypt hashing and comparing, token generation,
// the session itself and the emails stay in the routes, in the same order as before. A PostgreSQL twin follows in Slice 5C.

// Identity model (Phase 1D): a session identifies an ACCOUNT (login + authorization; role lives here). An account optionally links to an
// EMPLOYEE. The signed-in user deliberately has no plain `id`: account_id records who ACTED, employee_id refers to the PERSON.
// `uid` is the session's account id (req.session.uid); a missing one, or an account / employee that is no longer active, is nobody.
function currentUser(db, uid) {
  if (!uid) return null;
  return db.prepare(`
    SELECT a.id AS account_id, a.employee_id, a.role, a.login_email AS email, a.password_hash, a.last_login_at,
      COALESCE(e.name, a.login_email) AS name, e.department, e.title, e.phone, e.building, e.created_at, COALESCE(e.can_self_checkout, 0) AS can_self_checkout
    FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.id = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(uid) || null;
}

// ---- first-run setup ----
const accountCount = (db) => db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
// The first admin: one employee (department IT) and its admin account, one transaction. `name` is cleaned and `email` normalized by the
// route; `hash` is the bcrypt hash. Returns the account id (the new session's uid).
function createFirstAdmin(db, { name, mail, hash }) {
  return db.transaction(() => {
    const emp = db.prepare("INSERT INTO employees (name, work_email, department) VALUES (?, ?, 'IT')").run(name, mail).lastInsertRowid;
    return db.prepare("INSERT INTO accounts (employee_id, login_email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(emp, mail, hash).lastInsertRowid;
  })();
}

// ---- login ----
// The active account with this (normalized) login email, its employee (if any) active too; undefined otherwise.
const loginAccount = (db, email) => db.prepare(`SELECT a.* FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.login_email = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(email);
function recordLogin(db, accountId) { db.prepare("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?").run(accountId); }

// ---- passwords and tokens ----
// `hash` is the bcrypt hash of the new password.
function setPassword(db, accountId, hash) { db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, accountId); }

// POST /api/forgot: who a reset link goes to (same active-account rule as login); undefined if nobody.
const resetAccount = (db, email) => db.prepare(`SELECT a.id, a.login_email, COALESCE(e.name, a.login_email) AS name FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.login_email = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(email);

// Tokens belong to an ACCOUNT (password reset / invite); tokens.user_id holds the account id. Issuing one replaces the account's previous
// token of the same purpose (two statements, as before). The route generates `token` and its expiry (`expiresAt`, an ISO string).
function replaceToken(db, userId, purpose, token, expiresAt) {
  db.prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare('INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, purpose, expiresAt);
}
const getToken = (db, token) => db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
// POST /api/reset, after the token was checked: the new password, then every token of that account is gone (the link is single use).
// The two statements run back to back as before (not a transaction; on PostgreSQL the token check and this belong in one: 5C).
function completeReset(db, accountId, hash) {
  setPassword(db, accountId, hash);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(accountId);
}

module.exports = { currentUser, accountCount, createFirstAdmin, loginAccount, recordLogin, setPassword, resetAccount, replaceToken, getToken, completeReset };
