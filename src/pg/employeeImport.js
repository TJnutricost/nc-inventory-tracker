// Employee CSV import on PostgreSQL: the twin of src/employeeImport.js (read its header). Same names, first argument `q` (a pool or a
// transaction client). The decisions are the same pure plan (src/employeeImportPlan.js). `apply` is ONE transaction: it locks the
// employees table against other writers (SHARE ROW EXCLUSIVE; readers are not blocked), recomputes the plan, then writes the inserts and
// the updates in bulk (one statement each, from arrays), so 2,000+ rows are a handful of round trips. The unique index on
// lower(work_email) is the backstop.
const plan = require('../employeeImportPlan');
const { withTransaction, isInTransaction } = require('./transaction');

const inTransaction = (q, run) => (isInTransaction(q) ? run(q) : withTransaction(run, q));

async function load(q) {
  const employees = (await q.query(`SELECT e.id, e.name, e.first_name, e.last_name, e.work_email, e.department, e.title, e.phone, e.building, e.status, a.login_email
    FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id ORDER BY e.id`)).rows;
  const loginsWithoutPerson = (await q.query('SELECT login_email FROM accounts WHERE employee_id IS NULL')).rows.map((r) => r.login_email);
  return { employees, loginsWithoutPerson };
}

async function preview(q, { rows }) { return plan.buildPlan(rows, await load(q)); }

async function apply(q, { rows, actorAccountId, acknowledge, expect }) {
  return inTransaction(q, async (c) => {
    await c.query('LOCK TABLE employees IN SHARE ROW EXCLUSIVE MODE');
    const p = plan.buildPlan(rows, await load(c));
    plan.checkConfirmed(p, { acknowledge, expect });
    const creates = p.rows.filter((r) => r.action === 'create');
    if (creates.length) {
      const v = (r, f) => (r.changes[f] ? r.changes[f][1] : null);
      await c.query(`INSERT INTO employees (name, first_name, last_name, work_email, department, title, phone, building, can_self_checkout)
        SELECT n, f, l, e, d, t, p, b, 0 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS x(n, f, l, e, d, t, p, b)`,
      [creates.map((r) => r.name), creates.map((r) => r.first_name), creates.map((r) => r.last_name), creates.map((r) => r.work_email), creates.map((r) => v(r, 'department')), creates.map((r) => v(r, 'title')),
        creates.map((r) => v(r, 'phone')), creates.map((r) => v(r, 'building'))]);
    }
    const updates = p.rows.filter((r) => r.action === 'update');
    if (updates.length) {
      // a field the CSV did not change keeps its stored value (COALESCE over a NULL "no change" marker)
      const nv = (r, f) => (r.changes[f] ? r.changes[f][1] : null);
      await c.query(`UPDATE employees SET name = COALESCE(x.n, employees.name), first_name = COALESCE(x.f, employees.first_name), last_name = COALESCE(x.l, employees.last_name),
          department = COALESCE(x.d, employees.department),
          title = COALESCE(x.t, employees.title), phone = COALESCE(x.p, employees.phone), building = COALESCE(x.b, employees.building)
        FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS x(id, n, f, l, d, t, p, b) WHERE employees.id = x.id`,
      [updates.map((r) => r.id), updates.map((r) => nv(r, 'name')), updates.map((r) => nv(r, 'first_name')), updates.map((r) => nv(r, 'last_name')), updates.map((r) => nv(r, 'department')), updates.map((r) => nv(r, 'title')),
        updates.map((r) => nv(r, 'phone')), updates.map((r) => nv(r, 'building'))]);
    }
    if (creates.length + updates.length) {
      await c.query('INSERT INTO activity (asset_id, actor_id, action, details) VALUES (NULL, $1, $2, $3)', [actorAccountId, 'employees_imported', plan.summaryText(p.counts)]);
    }
    return p;
  });
}

module.exports = { preview, apply, MAX_ROWS: plan.MAX_ROWS, MAX_BYTES: plan.MAX_BYTES, TEMPLATE: plan.TEMPLATE, rowsFromCsv: plan.rowsFromCsv, buildPlan: plan.buildPlan };
