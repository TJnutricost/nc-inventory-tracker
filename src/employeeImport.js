// Employee CSV import (SQLite): the database side of docs/briefs/employee-csv-import.md. The decisions are the pure plan in
// src/employeeImportPlan.js (shared with the PostgreSQL twin src/pg/employeeImport.js: same names, first argument `q`). `preview` only
// reads. `apply` recomputes the plan INSIDE one immediate transaction, so what is written is what was decided against the data as it
// is at that moment; anything that throws rolls everything back. It inserts people (active, NO login, self-checkout OFF) and updates the
// five profile fields of people it matched; it never touches accounts, roles, status, the self-checkout permission, assignments, requests
// or history.
const plan = require('./employeeImportPlan');

function load(db) {
  return {
    employees: db.prepare(`SELECT e.id, e.name, e.first_name, e.last_name, e.work_email, e.department, e.title, e.phone, e.building, e.status, a.login_email
      FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id ORDER BY e.id`).all(),
    loginsWithoutPerson: db.prepare('SELECT login_email FROM accounts WHERE employee_id IS NULL').all().map((r) => r.login_email),
  };
}

const preview = (db, { rows }) => plan.buildPlan(rows, load(db));

function apply(db, { rows, actorAccountId, acknowledge, expect }) {
  return db.transaction(() => {
    const p = plan.buildPlan(rows, load(db));
    plan.checkConfirmed(p, { acknowledge, expect });
    const insert = db.prepare('INSERT INTO employees (name, first_name, last_name, work_email, department, title, phone, building, can_self_checkout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)');
    for (const r of p.rows) {
      if (r.action === 'create') {
        const v = (f) => (r.changes[f] ? r.changes[f][1] : null);
        insert.run(r.name, r.first_name, r.last_name, r.work_email, v('department'), v('title'), v('phone'), v('building'));
      } else if (r.action === 'update') {
        const f = Object.keys(r.changes);
        db.prepare(`UPDATE employees SET ${f.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...f.map((k) => r.changes[k][1]), r.id);
      }
    }
    if (p.counts.create + p.counts.update > 0) {
      db.prepare('INSERT INTO activity (asset_id, actor_id, action, details) VALUES (NULL, ?, ?, ?)').run(actorAccountId, 'employees_imported', plan.summaryText(p.counts));
    }
    return p;
  }).immediate();
}

module.exports = { preview, apply, MAX_ROWS: plan.MAX_ROWS, MAX_BYTES: plan.MAX_BYTES, TEMPLATE: plan.TEMPLATE, rowsFromCsv: plan.rowsFromCsv, buildPlan: plan.buildPlan };
