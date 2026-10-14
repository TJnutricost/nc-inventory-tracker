// Loads every src/pg/*.js module in THIS (fresh) process and prints what ended up in require.cache, as JSON. Used by
// test/pg/pg-no-sqlite.test.js to prove src/pg/* never loads src/db.js, src/mailer.js or better-sqlite3 (D-46/D-47). Run it
// with DATA_DIR pointing at a path that does not exist: src/db.js would create it on load.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'pg');
const loaded = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
  require(path.join(dir, f));
  loaded.push(f);
}
process.stdout.write(JSON.stringify({ loaded, cache: Object.keys(require.cache) }));
