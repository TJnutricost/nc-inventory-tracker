// Test support (not a test): runs the same seedDatabase() that `npm run seed:dev` runs, into the given (temporary) data dir.
// Usage: node test-support/seed-probe.js <data dir>
const { seedDatabase } = require('../scripts/seed-dev');
seedDatabase({ dataDir: process.argv[2], quiet: true }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
