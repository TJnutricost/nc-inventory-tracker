const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  seedDatabase, assertSafeDevDir, buildAssetDefs, applySpecialCases, EXPECTED_ASSET_COUNT,
  bootApp, startServer, stopServer, makeClient,
  REAL_DATA_DIR, DEV_PASSWORD,
} = require('../scripts/seed-dev');

test('refuses to target the real application data directory', () => {
  assert.throws(() => assertSafeDevDir(REAL_DATA_DIR));
  assert.throws(() => assertSafeDevDir(path.join(REAL_DATA_DIR, '..')));
});

test('accepts an isolated dev-only directory', () => {
  assert.doesNotThrow(() => assertSafeDevDir(path.join(REAL_DATA_DIR, '..', 'data-dev')));
});

test('asset dataset is internally consistent before it ever hits the app', () => {
  const defs = buildAssetDefs();
  assert.equal(defs.length, EXPECTED_ASSET_COUNT);
  applySpecialCases(defs);
  assert.ok(defs.some((d) => d.serial === null), 'expected at least one asset with no serial');
  assert.ok(defs.some((d) => d.serial && d.serial.length > 30), 'expected at least one unusually long serial');
  assert.ok(defs.some((d) => d.status === 'maintenance'));
  assert.ok(defs.some((d) => d.status === 'retired'));
  assert.ok(defs.some((d) => d.status === 'lost'));
  assert.ok(defs.some((d) => d.license_seats > 1));
});

test('seeding the real ./data directory is refused even via the public entry point', async () => {
  await assert.rejects(() => seedDatabase({ dataDir: REAL_DATA_DIR, quiet: true }));
});

// The two tests below actually run the seed (against a throwaway temp dir, never
// against the repo's real ./data or ./data-dev) and are slower — they boot the
// real app and drive it over HTTP, same as the rest of the suite.
test('seeding produces the expected deterministic dataset, twice in a row, without duplicating data', async () => {
  const before = fs.existsSync(REAL_DATA_DIR) ? fs.statSync(path.join(REAL_DATA_DIR, 'assets.db')).mtimeMs : null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seed-test-'));
  const dataDir = path.join(dir, 'data-dev');
  try {
    const first = await seedDatabase({ dataDir, quiet: true });
    assert.equal(first.people, 10);
    assert.equal(first.accounts, 9);
    assert.equal(first.employeesWithoutLogin, 1);
    assert.equal(first.admins, 1);
    assert.equal(first.assets, EXPECTED_ASSET_COUNT);
    assert.equal(first.firstAssetTag, 'NC-00001');
    assert.equal(first.nextTag, `NC-${String(EXPECTED_ASSET_COUNT + 1).padStart(5, '0')}`);
    assert.ok(first.currentAssignments > 0);
    assert.ok(first.historicalAssignments > 0);
    assert.ok(first.permanentAssignments >= 3, 'expected permanent everyday equipment');
    assert.ok(first.temporaryCheckouts >= 1, 'expected at least one temporary checkout');
    assert.ok(first.requests > 0);
    assert.equal(first.devPassword, DEV_PASSWORD);

    const second = await seedDatabase({ dataDir, quiet: true });
    assert.deepEqual(
      { ...second, dataDir: undefined },
      { ...first, dataDir: undefined },
      'reseeding must not duplicate or drift the dataset',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (before !== null) {
    assert.equal(fs.statSync(path.join(REAL_DATA_DIR, 'assets.db')).mtimeMs, before, 'seeding must never touch the real data directory');
  }
});

test('a seeded admin can actually log in and see the known dataset over HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seed-test-'));
  const dataDir = path.join(dir, 'data-dev');
  try {
    const summary = await seedDatabase({ dataDir, quiet: true });

    // Reopen the just-seeded (already-populated) data dir as a fresh app instance,
    // the same way a developer would `npm start` against it after seeding.
    const { app } = bootApp(dataDir);
    const server = await startServer(app);
    try {
      const client = makeClient(server);
      await client.post('/api/login', { email: summary.adminEmail, password: DEV_PASSWORD });

      const me = await client.get('/api/me');
      assert.equal(me.user.role, 'admin');

      const lookup = await client.get(`/api/assets/lookup/${summary.firstAssetTag}`);
      assert.equal(lookup.found, true);

      const asset = await client.get(`/api/assets/${lookup.id}`);
      assert.ok(asset.holders.length >= 1, 'expected the well-used laptop to show a current holder');
      assert.ok(asset.activity.length >= 2, 'expected checkout/checkin history on the well-used laptop');
    } finally {
      await stopServer(server);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
