// People (SQLite): employees with their optional login account. Extracted VERBATIM from src/server.js in PostgreSQL migration Slices
// 5B-2 (getPerson, for check-out and request deny) and 5B-3 (the /api/users routes): the SQL and the transaction boundaries are
// unchanged; the database handle is the first argument, like the other data modules. Slice 5B-4 added `employeeStatus` (POST
// /api/requests); since then every route reaches this module through the seam. A PostgreSQL twin follows in Slice 5C.

// A person (employee) with their optional account. `email` = where to reach them (work email, else login email).
const PERSON_SQL = `
  SELECT e.*, COALESCE(e.work_email, a.login_email) AS email,
    a.id AS account_id, a.login_email, a.role, a.active AS account_active, a.password_hash, a.last_login_at
  FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id`;
const getPerson = (db, id) => db.prepare(`${PERSON_SQL} WHERE e.id = ?`).get(id);

const HISTORY_LIMIT = 200; // most recent returned assignments in a person's record (the employee History screen and the admin person page)

// GET /api/users: everyone, active first, by name, with how many assets each holds now.
const listPeople = (db) => db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM assignments s WHERE s.employee_id = p.id AND s.returned_at IS NULL) AS asset_count
    FROM (${PERSON_SQL}) p ORDER BY (p.status = 'active') DESC, p.name COLLATE NOCASE`).all();

// The email-in-use checks of the people routes (truthy when taken). `exceptId` is the employee / account being edited.
const workEmailTaken = (db, email) => db.prepare('SELECT 1 FROM employees WHERE work_email = ?').get(email);
const workEmailTakenByOther = (db, email, exceptId) => db.prepare('SELECT 1 FROM employees WHERE work_email = ? AND id != ?').get(email, exceptId);
const loginEmailTaken = (db, email) => db.prepare('SELECT 1 FROM accounts WHERE login_email = ?').get(email);
const loginEmailTakenByOther = (db, email, exceptAccountId) => db.prepare('SELECT 1 FROM accounts WHERE login_email = ? AND id != ?').get(email, exceptAccountId);

// POST /api/users: the employee and, when `wantsLogin`, its linked account (no password: the invite sets it), one transaction. The
// fields are cleaned by the route. Returns the new employee id.
function createPerson(db, { name, firstName = null, lastName = null, email, department, title, phone, building, wantsLogin, role }) {
  return db.transaction(() => {
    const empId = db.prepare('INSERT INTO employees (name, first_name, last_name, work_email, department, title, phone, building, can_self_checkout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(name, firstName, lastName, email, department, title, phone, building).lastInsertRowid;
    if (wantsLogin) db.prepare('INSERT INTO accounts (employee_id, login_email, role) VALUES (?, ?, ?)').run(empId, email, role);
    return empId;
  })();
}

// POST /api/users/:id/account: gives an existing employee (`p`, from getPerson) a login; a person with no work email gets this one.
function addAccount(db, p, { email, role }) {
  db.transaction(() => {
    if (!p.work_email) db.prepare('UPDATE employees SET work_email = ? WHERE id = ?').run(email, p.id);
    db.prepare('INSERT INTO accounts (employee_id, login_email, role) VALUES (?, ?, ?)').run(p.id, email, role);
  })();
}

// GET /api/users/:id: what the person holds now, and their most recent returns.
function personAssignments(db, id) {
  const current = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC`).all(id);
  const past = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NOT NULL ORDER BY s.returned_at DESC LIMIT ${HISTORY_LIMIT}`).all(id);
  return { current, past };
}

// PUT /api/users/:id: the person and, when they have one (`accountId`), their account, one transaction. The values are worked out and
// validated by the route (`active` is a boolean). Nothing here deletes a person; signing a deactivated account out is sessions.js.
function updatePerson(db, { id, name, firstName = null, lastName = null, workEmail, department, title, phone, building, active, accountId, loginEmail, role }) {
  db.transaction(() => {
    db.prepare('UPDATE employees SET name = ?, first_name = ?, last_name = ?, work_email = ?, department = ?, title = ?, phone = ?, building = ?, status = ? WHERE id = ?')
      .run(name, firstName, lastName, workEmail, department, title, phone, building, active ? 'active' : 'inactive', id);
    if (accountId) db.prepare('UPDATE accounts SET login_email = ?, role = ?, active = ? WHERE id = ?').run(loginEmail, role, active ? 1 : 0, accountId);
  })();
}

// PUT /api/users/:id/self-checkout: the per-employee self-checkout permission; never touches the employee's other fields.
function setSelfCheckout(db, id, enabled) { db.prepare('UPDATE employees SET can_self_checkout = ? WHERE id = ?').run(enabled ? 1 : 0, id); }

// PUT /api/me: the signed-in person's own details (anyone since 2026-10-27; admins only before). A blank name keeps the stored one; the fields are cleaned
// by the route.
function updateOwnProfile(db, employeeId, { name, firstName = null, lastName = null, phone, department, title, building }) {
  db.prepare('UPDATE employees SET name = COALESCE(?, name), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), phone = ?, department = ?, title = ?, building = ? WHERE id = ?')
    .run(name, firstName, lastName, phone, department, title, building, employeeId);
}

// POST /api/requests: the status of the person a request is for ({ status }, or undefined when there is no such employee).
const employeeStatus = (db, id) => db.prepare('SELECT status FROM employees WHERE id = ?').get(id);

module.exports = {
  PERSON_SQL, HISTORY_LIMIT, getPerson, listPeople, workEmailTaken, workEmailTakenByOther, loginEmailTaken, loginEmailTakenByOther,
  createPerson, addAccount, personAssignments, updatePerson, setSelfCheckout, updateOwnProfile, employeeStatus,
};
