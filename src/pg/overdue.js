// The overdue-reminder sweep's database side on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/overdue.js. NOT
// used by the running app yet (Slice 5D binds it to the driver seam under the same names; the sweep and its timer stay in server.js).
// Same names, parallel signatures, same rows; async, executor `q` first.
//
// Differences from SQLite (output identical):
//   - date('now') -> TODAY, date('now','-3 day') -> the same UTC date text three days earlier (src/pg/time.js; compared as text, D-46).
//   - The SQLite query has no ORDER BY (assignment rowid order in practice); here it is `ORDER BY s.id`, so the reminders go out in the
//     same order.
// Not changed here (5D, carry-over (aj)): two sweeps running at once could both pick the same assignment before either marks it;
// the overdue sweep needs a single-flight guard before more than one instance runs.
const { TODAY, dateOf } = require('./time');

const THREE_DAYS_AGO = dateOf("statement_timestamp() - interval '3 days'");

// Open assignments past their due date, for active employees, not reminded in the last three days.
const dueAssignments = async (q) => (await q.query(`
    SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email FROM assignments s
    JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
    WHERE s.returned_at IS NULL AND s.due_date IS NOT NULL AND s.due_date < ${TODAY}
      AND (s.last_overdue_notice IS NULL OR s.last_overdue_notice <= ${THREE_DAYS_AGO}) AND u.status = 'active'
    ORDER BY s.id`)).rows;

// Records that the reminder for this assignment went out today.
async function markNotified(q, assignmentId) {
  await q.query(`UPDATE assignments SET last_overdue_notice = ${TODAY} WHERE id = $1`, [assignmentId]);
}

module.exports = { dueAssignments, markNotified };
