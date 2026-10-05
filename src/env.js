// Load .env from the project root if present (Node 20.12+ built-in loader).
//
// NOT when NC_NO_EXTERNAL_MAIL=1: the seed scripts and the test harness set it before loading the app, and then no local .env is read at all.
// (process.loadEnvFile only fills variables that are NOT already set, so a script that merely `delete`s SMTP_USER / SMTP_PASS from the
// environment and then loads the app gets them straight back from .env. That is how seeding once sent real mail.)
// NC_ENV_FILE points at a different file (used by the tests to prove exactly this).
const path = require('path');
const fs = require('fs');
const f = process.env.NC_ENV_FILE || path.join(__dirname, '..', '.env');
if (process.env.NC_NO_EXTERNAL_MAIL !== '1' && fs.existsSync(f) && typeof process.loadEnvFile === 'function') process.loadEnvFile(f);
