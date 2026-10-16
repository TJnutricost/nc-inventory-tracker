// Reading the email outbox on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of src/outbox.js, for IT's Settings → Email
// screen. NOT used by the running app yet (Slice 5D binds it to the driver seam under the same names). Same names, parallel
// signatures, same rows; async, executor `q` first. Writing the outbox stays in the PG mailer (src/pg/mailer.js).

// The newest outbox row's delivery result (undefined when the outbox is empty, as on SQLite).
const latest = async (q) => (await q.query('SELECT status, error FROM outbox ORDER BY id DESC LIMIT 1')).rows[0];

// The 100 newest outbox rows (GET /api/outbox).
const recent = async (q) => (await q.query('SELECT id, to_addr, subject, status, error, delivered_to, created_at FROM outbox ORDER BY id DESC LIMIT 100')).rows;

module.exports = { latest, recent };
