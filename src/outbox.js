// Reading the email outbox (SQLite) for IT's Settings → Email screen. Extracted VERBATIM from src/server.js in PostgreSQL migration
// Slice 5B-4 (D-48): the SQL is unchanged; the database handle is the first argument, like the other data modules. Writing the outbox
// stays in the mailer (src/mailer.js, the SQLite adapter; src/pg/mailer.js on PostgreSQL). A PostgreSQL twin follows in Slice 5C.

// The newest outbox row's delivery result (POST /api/settings/test-email reads it right after sending the test).
const latest = (db) => db.prepare('SELECT status, error FROM outbox ORDER BY id DESC LIMIT 1').get();

// The 100 newest outbox rows (GET /api/outbox).
const recent = (db) => db.prepare('SELECT id, to_addr, subject, status, error, delivered_to, created_at FROM outbox ORDER BY id DESC LIMIT 100').all();

module.exports = { latest, recent };
