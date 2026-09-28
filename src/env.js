// Load .env from the project root if present (Node 20.12+ built-in loader)
const path = require('path');
const fs = require('fs');
const f = path.join(__dirname, '..', '.env');
if (fs.existsSync(f) && typeof process.loadEnvFile === 'function') process.loadEnvFile(f);
