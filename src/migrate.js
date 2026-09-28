// Minimal versioned migration runner. Each migration is { id, name, up(db) }; ids are
// positive integers applied once, in ascending order, each inside its own transaction
// together with its schema_migrations row (so a failed migration leaves no trace).
function runMigrations(db, migrations) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (!Number.isInteger(m.id) || m.id < 1 || (i > 0 && m.id === sorted[i - 1].id)) throw new Error(`Invalid or duplicate migration id: ${m.id}`);
  }
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const ran = [];
  for (const m of sorted) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
    })();
    ran.push(m.id);
  }
  return ran;
}

module.exports = { runMigrations };
