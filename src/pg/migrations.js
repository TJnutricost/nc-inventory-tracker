// Ordered, append-only list of PostgreSQL schema migrations (see src/pg/migrate.js). Never edit or reorder an applied
// migration; add a new one with the next id. Each is { id, name, file } (a .sql file under src/pg/schema/).
// Migration 1 is the squashed baseline = the final state of SQLite migrations 1-17 (D-46). There is no SQLite-to-PG
// upgrade path here: PostgreSQL databases are created fresh (production data arrives with the Slice 7 data copy).
module.exports = [
  { id: 1, name: 'baseline schema (SQLite migrations 1-17, final state)', file: '001_baseline.sql' },
  { id: 2, name: 'issued_tag_ranges (SQLite migration 18)', file: '002_issued_tag_ranges.sql' },
  { id: 3, name: 'employees: first_name, last_name, can_self_checkout default 0 (SQLite migration 19)', file: '003_employee_names_self_checkout_default.sql' },
];
