// Reading a person (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration Slice 5B-2 (D-48): the SQL is unchanged;
// the database handle is the first argument, like the other data modules. Only the read the 5B-2 routes need (check-out, request
// deny) lives here; the people/auth routes themselves move in Slice 5B-3 and keep using PERSON_SQL and a thin bound `getPerson(id)`
// alias in server.js until then. A PostgreSQL twin follows in Slice 5C.

// A person (employee) with their optional account. `email` = where to reach them (work email, else login email).
const PERSON_SQL = `
  SELECT e.*, COALESCE(e.work_email, a.login_email) AS email,
    a.id AS account_id, a.login_email, a.role, a.active AS account_active, a.password_hash, a.last_login_at
  FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id`;
const getPerson = (db, id) => db.prepare(`${PERSON_SQL} WHERE e.id = ?`).get(id);

module.exports = { PERSON_SQL, getPerson };
