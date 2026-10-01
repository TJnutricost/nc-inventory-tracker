// Isolated seed verification for agents, CI and manual checks.
//
// Seeds the SAME deterministic dataset as `npm run seed:dev` (it reuses
// seedDatabase from ./seed-dev) but into a throwaway directory under the OS temp
// dir, then re-opens that database as a fresh app instance and checks that setup
// is complete and the documented admin login works. The temp directory is always
// removed afterwards. Exits non-zero on any failure.
//
// It never reads, writes, deletes, migrates or locks ./data-dev (or ./data), so
// it is safe to run while `DATA_DIR=./data-dev npm run dev` is live.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const {
  seedDatabase, assertSafeDevDir, bootApp, startServer, stopServer, makeClient,
  DEV_DATA_DIR, REAL_DATA_DIR, EXPECTED_ASSET_COUNT,
} = require('./seed-dev');

// The documented login (README.md). Literals on purpose: comparing the seed to its own
// constants could not notice them drifting from what the docs and the setup endpoint promise.
const DOCUMENTED_ADMIN_EMAIL = 'dana.ito@example.com';
const DOCUMENTED_PASSWORD = 'DevPass!2026';

function makeTempDataDir() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nc-seed-verify-'));
  const dataDir = path.join(base, 'data');
  for (const protectedDir of [DEV_DATA_DIR, REAL_DATA_DIR]) {
    const rel = path.relative(protectedDir, dataDir);
    if (!rel || !rel.startsWith('..')) throw new Error(`Refusing to verify: temp dir "${dataDir}" is inside "${protectedDir}".`);
  }
  assertSafeDevDir(dataDir);
  return { base, dataDir };
}

async function verifySeededDatabase(dataDir, summary) {
  assert.equal(summary.adminEmail, DOCUMENTED_ADMIN_EMAIL, 'seeded admin email differs from the documented login');
  assert.equal(summary.devPassword, DOCUMENTED_PASSWORD, 'seeded password differs from the documented login');
  assert.equal(summary.admins, 1, 'expected exactly one admin');
  assert.equal(summary.assets, EXPECTED_ASSET_COUNT, 'asset count differs from the seed definition');
  assert.equal(summary.firstAssetTag, 'NC-00001');

  // Reopen the already-populated data dir as a fresh app instance, as a developer would after seeding.
  const { app, db } = bootApp(dataDir);
  const server = await startServer(app);
  try {
    const client = makeClient(server);
    assert.equal((await client.get('/api/setup-needed')).needed, false, 'seeded database would redirect to /setup');
    await client.post('/api/login', { email: DOCUMENTED_ADMIN_EMAIL, password: DOCUMENTED_PASSWORD });
    const me = await client.get('/api/me');
    assert.equal(me.user.role, 'admin');
    assert.equal(me.user.email, DOCUMENTED_ADMIN_EMAIL);
    const lookup = await client.get(`/api/assets/lookup/${summary.firstAssetTag}`);
    assert.equal(lookup.found, true, 'first seeded asset tag was not found');
  } finally {
    await stopServer(server);
    db.close();
  }
}

async function main() {
  const { base, dataDir } = makeTempDataDir();
  console.log(`Isolated seed verification in temporary directory: ${dataDir}`);
  try {
    const summary = await seedDatabase({ dataDir, quiet: true });
    await verifySeededDatabase(dataDir, summary);
    console.log(`  Seeded:  ${summary.people} people (${summary.accounts} logins), ${summary.assets} assets, ${summary.requests} requests`);
    console.log(`  Verified: setup complete; ${DOCUMENTED_ADMIN_EMAIL} can log in as admin.`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    console.log('  Cleaned up temporary directory. ./data-dev was not touched.');
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log('seed:verify OK');
      process.exit(0);
    })
    .catch((err) => {
      console.error('seed:verify FAILED:', err);
      process.exit(1);
    });
}

module.exports = { main, makeTempDataDir, verifySeededDatabase };
