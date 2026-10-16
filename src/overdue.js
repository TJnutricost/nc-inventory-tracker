// The overdue-reminder sweep's database side (SQLite). Extracted VERBATIM from src/server.js `overdueSweep` in PostgreSQL migration
// Slice 5B-4 (D-48): the SQL is unchanged; the database handle is the first argument, like the other data modules. The sweep itself (the
// `overdue_reminders` setting check, the order, the emails) and its timers stay in server.js. A PostgreSQL twin follows in Slice 5C.

// Open assignments past their due date, for active employees, not reminded in the last three days.
const dueAssignments = (db) => db.prepare(`
    SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email FROM assignments s
    JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
    WHERE s.returned_at IS NULL AND s.due_date IS NOT NULL AND s.due_date < date('now')
      AND (s.last_overdue_notice IS NULL OR s.last_overdue_notice <= date('now','-3 day')) AND u.status = 'active'`).all();

// Records that the reminder for this assignment went out today.
function markNotified(db, assignmentId) {
  db.prepare("UPDATE assignments SET last_overdue_notice = date('now') WHERE id = ?").run(assignmentId);
}

module.exports = { dueAssignments, markNotified };
