// People on PostgreSQL (D-46, D-48): the PG twin of src/people.js. The READS (a person with their optional login account, the People
// list, a person's assignments, the email-in-use checks, an employee's status) are migration Slice 5C-2; the WRITES (createPerson,
// addAccount, updatePerson, setSelfCheckout, updateOwnProfile, at the end of this file) are Slice 5C-3 (carry-overs (aa), (ab)). NOT
// used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures, the same
// rows; async, executor `q` first. The writes' transactions, locks and email checks are described above them.
//
// Differences from SQLite (output identical):
//   - `?` -> `$n`; ids that are not integers in the column's range find nothing (src/pg/reservations.js toId), as on SQLite.
//   - COLLATE NOCASE columns: `work_email = ?` / `login_email = ?` -> `lower(col) = lower($n COLLATE "C")` (the Slice 3 case rule;
//     under COLLATE "C" lower() folds ASCII letters only, exactly like NOCASE, and the unique lower(...) indexes serve these lookups).
//     The parameter needs the explicit COLLATE "C": a bare lower($n) folds with the database's default collation, which also folds
//     non-ASCII letters, so a stored 'ÉMILE@x' would be missed by 'Émile@X', which SQLite finds (5C-2 finding);
//     `ORDER BY p.name COLLATE NOCASE` -> `lower(p.name)`. `(p.status = 'active') DESC` sorts the same (true before false).
//   - The email-in-use checks return the row `{ '1': 1 }` (or undefined) exactly as better-sqlite3 does for `SELECT 1`.
//   - COUNT(*) comes back as a JS number (src/pg/pool.js int8 parser).
//   - Ties get explicit tie-breakers reproducing the order SQLite gives them (measured by the differential test): the People list
//     `..., lower(p.name), p.id`; a person's current assignments `s.assignment_type, s.checked_out_at DESC, s.id`; their history
//     `s.returned_at DESC, s.id DESC` (SQLite walks idx_assign_employee backwards; with the LIMIT, which rows make the cut on a tie
//     matters). These follow SQLite's current query plans; SQLite itself guarantees no tie order.
const { toId } = require('./reservations');
const base = require('../people');
const { withTransaction, isInTransaction } = require('./transaction');

const { PERSON_SQL, HISTORY_LIMIT } = base;
const one = async (q, sql, params) => (await q.query(sql, params)).rows[0];
const ONE = 'SELECT 1 AS "1"';

const getPerson = async (q, id) => one(q, `${PERSON_SQL} WHERE e.id = $1`, [toId(id)]);

// GET /api/users: everyone, active first, by name, with how many assets each holds now.
const listPeople = async (q) => (await q.query(`
    SELECT p.*, (SELECT COUNT(*) FROM assignments s WHERE s.employee_id = p.id AND s.returned_at IS NULL) AS asset_count
    FROM (${PERSON_SQL}) p ORDER BY (p.status = 'active') DESC, lower(p.name), p.id`)).rows;

// The email-in-use checks of the people routes (truthy when taken). `exceptId` is the employee / account being edited.
// SQLite's `id != ?`: a NULL exceptId matches nothing; one that is not an integer id excludes no row (the routes pass real ids).
const taken = async (q, table, col, email) => one(q, `${ONE} FROM ${table} WHERE lower(${col}) = lower($1 COLLATE "C") LIMIT 1`, [email]);
const takenByOther = async (q, table, col, email, exceptId) => (exceptId === null || exceptId === undefined ? undefined
  : one(q, `${ONE} FROM ${table} WHERE lower(${col}) = lower($1 COLLATE "C") AND ($2::int IS NULL OR id <> $2) LIMIT 1`, [email, toId(exceptId)]));
const workEmailTaken = async (q, email) => taken(q, 'employees', 'work_email', email);
const workEmailTakenByOther = async (q, email, exceptId) => takenByOther(q, 'employees', 'work_email', email, exceptId);
const loginEmailTaken = async (q, email) => taken(q, 'accounts', 'login_email', email);
const loginEmailTakenByOther = async (q, email, exceptAccountId) => takenByOther(q, 'accounts', 'login_email', email, exceptAccountId);

// GET /api/users/:id: what the person holds now, and their most recent returns.
async function personAssignments(q, id) {
  const key = toId(id);
  const current = (await q.query(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = $1 AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC, s.id`, [key])).rows;
  const past = (await q.query(`
    SELECT s.*, a.name AS asset_name, a.tag FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = $1 AND s.returned_at IS NOT NULL ORDER BY s.returned_at DESC, s.id DESC LIMIT ${HISTORY_LIMIT}`, [key])).rows;
  return { current, past };
}

// POST /api/requests: the status of the person a request is for ({ status }, or undefined when there is no such employee).
const employeeStatus = async (q, id) => one(q, 'SELECT status FROM employees WHERE id = $1', [toId(id)]);

// ---- the WRITES (Slice 5C-3) ----
// Transactions: createPerson (employee + optional account), addAccount (work email + account) and updatePerson (employee + account) are
// each ONE transaction: a caller's transaction when `q` is a transaction client, else their own (isInTransaction(q) ? run(q) :
// withTransaction(run, q)). A failure anywhere (a taken email, a refused role, a NOT NULL) rolls the whole write back.
//
// Email-in-use checks (carry-over (ab)). The routes run them before the write (src/server.js); on SQLite route + write were atomic in
// practice. Here each write runs the SAME checks again INSIDE its transaction, with the route's messages, and the baseline's unique
// indexes (idx_employees_work_email and accounts_login_email_lower_key on lower(...), the "C" collation folding ASCII letters only, like
// NOCASE) are the backstop: a concurrent writer that slips between the check and the INSERT / UPDATE makes it fail with 23505, which is
// turned into the same readable 400 (CLASH below), so the loser of two simultaneous creates with one email gets the route's message,
// never a 500. Give-a-login also re-checks, under the employee lock, that the person has no login yet (the route's 400 'This person
// already has a login.'; backstop: the UNIQUE accounts.employee_id), and uses the employee's work email as it is under that lock.
// updatePerson checks the values it writes (a work email / login email that is unchanged cannot be taken by another row: the indexes).
//
// Locks: addAccount and updatePerson lock the employee row first (FOR NO KEY UPDATE: it does not block foreign-key checks of other
// writers), then write the account. LOCK ORDER: employee -> account -> tokens (src/pg/accounts.js locks account -> tokens and never an
// employee), so concurrent updates of one person queue on the employee row and cannot deadlock.
// Differences from SQLite for direct calls the routes never make (they check first): the PG writes refuse a taken email with a 400
// where the SQLite module would throw its raw UNIQUE error.
const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const WORK_INDEX = 'idx_employees_work_email';
const LOGIN_INDEX = 'accounts_login_email_lower_key';
const EMPLOYEE_INDEX = 'accounts_employee_id_key';
const PERSON_EXISTS = 'A person with that email already exists';
const LOGIN_EXISTS = 'A login with that email already exists';
const OTHER_PERSON = 'That email belongs to another person';
const HAS_LOGIN = 'This person already has a login.';
const IN_USE = 'That email is already in use';
const CLASH = {
  create: { [WORK_INDEX]: PERSON_EXISTS, [LOGIN_INDEX]: LOGIN_EXISTS },
  addAccount: { [WORK_INDEX]: OTHER_PERSON, [LOGIN_INDEX]: LOGIN_EXISTS, [EMPLOYEE_INDEX]: HAS_LOGIN },
  update: { [WORK_INDEX]: IN_USE, [LOGIN_INDEX]: IN_USE },
};
// Runs `run`, turning a unique violation of one of `messages`' indexes into its readable 400 (the transaction still rolls back).
async function clashGuarded(messages, run) {
  try {
    return await run();
  } catch (err) {
    const message = err && err.code === '23505' && messages[err.constraint];
    if (message) throw Object.assign(httpError(400, message), { cause: err });
    throw err;
  }
}

// POST /api/users: the employee and, when `wantsLogin`, its linked account (no password: the invite sets it). The fields are cleaned by
// the route. Returns the new employee id.
const createPerson = async (q, { name, email, department, title, phone, building, wantsLogin, role }) => inTransaction(q, (c) => clashGuarded(CLASH.create, async () => {
  if (email && await workEmailTaken(c, email)) throw httpError(400, PERSON_EXISTS);
  if (email && wantsLogin && await loginEmailTaken(c, email)) throw httpError(400, LOGIN_EXISTS);
  const empId = (await one(c, 'INSERT INTO employees (name, work_email, department, title, phone, building) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [name, email, department, title, phone, building])).id;
  if (wantsLogin) await c.query('INSERT INTO accounts (employee_id, login_email, role) VALUES ($1, $2, $3)', [empId, email, role]);
  return empId;
}));

// POST /api/users/:id/account: gives an existing employee (`p`, from getPerson) a login; a person with no work email gets this one.
async function addAccount(q, p, { email, role }) {
  await inTransaction(q, (c) => clashGuarded(CLASH.addAccount, async () => {
    // (people are never deleted; an unknown p.id falls through to the account INSERT's foreign-key error, as on SQLite)
    const e = (await one(c, 'SELECT id, work_email FROM employees WHERE id = $1 FOR NO KEY UPDATE', [toId(p.id)])) || { id: p.id, work_email: p.work_email };
    if (await one(c, `${ONE} FROM accounts WHERE employee_id = $1`, [toId(e.id)])) throw httpError(400, HAS_LOGIN);
    if (await loginEmailTaken(c, email)) throw httpError(400, LOGIN_EXISTS);
    if (email !== e.work_email && await workEmailTakenByOther(c, email, e.id)) throw httpError(400, OTHER_PERSON);
    if (!e.work_email) await c.query('UPDATE employees SET work_email = $1 WHERE id = $2', [email, toId(e.id)]);
    await c.query('INSERT INTO accounts (employee_id, login_email, role) VALUES ($1, $2, $3)', [toId(e.id), email, role]);
  }));
}

// PUT /api/users/:id: the person and, when they have one (`accountId`), their account. The values are worked out and validated by the
// route (`active` is a boolean). Nothing here deletes a person; signing a deactivated account out is src/pg/sessions.js.
async function updatePerson(q, { id, name, workEmail, department, title, phone, building, active, accountId, loginEmail, role }) {
  const key = toId(id);
  await inTransaction(q, (c) => clashGuarded(CLASH.update, async () => {
    await c.query('SELECT 1 FROM employees WHERE id = $1 FOR NO KEY UPDATE', [key]);
    if (workEmail && await workEmailTakenByOther(c, workEmail, key)) throw httpError(400, IN_USE);
    if (accountId && await loginEmailTakenByOther(c, loginEmail, accountId)) throw httpError(400, IN_USE);
    await c.query('UPDATE employees SET name = $1, work_email = $2, department = $3, title = $4, phone = $5, building = $6, status = $7 WHERE id = $8',
      [name, workEmail, department, title, phone, building, active ? 'active' : 'inactive', key]);
    if (accountId) await c.query('UPDATE accounts SET login_email = $1, role = $2, active = $3 WHERE id = $4', [loginEmail, role, active ? 1 : 0, toId(accountId)]);
  }));
}

// PUT /api/users/:id/self-checkout: the per-employee self-checkout permission; never touches the employee's other fields.
async function setSelfCheckout(q, id, enabled) { await q.query('UPDATE employees SET can_self_checkout = $1 WHERE id = $2', [enabled ? 1 : 0, toId(id)]); }

// PUT /api/me (admins only; the route checks): an admin's own person details. A blank name keeps the stored one; the fields are cleaned
// by the route.
async function updateOwnProfile(q, employeeId, { name, phone, department, title }) {
  await q.query('UPDATE employees SET name = COALESCE($1, name), phone = $2, department = $3, title = $4 WHERE id = $5', [name, phone, department, title, toId(employeeId)]);
}

module.exports = {
  PERSON_SQL, HISTORY_LIMIT, getPerson, listPeople, workEmailTaken, workEmailTakenByOther, loginEmailTaken, loginEmailTakenByOther,
  createPerson, addAccount, personAssignments, updatePerson, setSelfCheckout, updateOwnProfile, employeeStatus,
};
