// Test support (not a test): behaves like a server start-up that sends ONE "test email" through the real mailer, then prints the outbox.
// Usage: node test-support/mail-probe.js <data dir> <recipient>
require('../src/env'); // exactly what src/server.js does first
process.env.DATA_DIR = process.argv[2];
const { notify } = require('../src/mailer');
const { db } = require('../src/db');
notify.test(process.argv[3]).then(() => {
  console.log(JSON.stringify(db.prepare('SELECT to_addr, status, delivered_to FROM outbox').all()));
  process.exit(0);
});
