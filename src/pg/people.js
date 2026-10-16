// People on PostgreSQL, the READ side (D-46, D-48, migration Slice 5C-2): the PG twin of the reads of src/people.js (a person with their
// optional login account, the People list, a person's assignments, the email-in-use checks, an employee's status). NOT used by the
// running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel signatures, the same rows; async,
// executor `q` first.
//
// The WRITES of src/people.js (createPerson, addAccount, updatePerson, setSelfCheckout, updateOwnProfile) are Slice 5C-3 (carry-overs
// (aa), (ab)): they are listed in test/pg/seam-parity.test.js MISSING until then. The email-in-use checks here are plain reads; on
// PostgreSQL the write routes must run them INSIDE the write's transaction (pass its client) or rely on the unique indexes, (ab).
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

module.exports = {
  PERSON_SQL, HISTORY_LIMIT, getPerson, listPeople, workEmailTaken, workEmailTakenByOther, loginEmailTaken, loginEmailTakenByOther,
  personAssignments, employeeStatus,
};
