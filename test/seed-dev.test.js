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
    assert.ok(first.selfCheckoutEnabled >= 1, 'expected login-enabled employees with self-checkout on');
    assert.ok(first.selfCheckoutDisabled >= 1, 'expected a login-enabled employee with self-checkout off');
    assert.ok(first.requests > 0);
    assert.ok(first.catalogRoots >= 15, 'standard roots plus Camera and Lens');
    assert.ok(first.catalogNodes >= 35, 'a real multi-level hierarchy, not just roots');
    assert.ok(first.assetsBelowCatalogRoot >= 15, 'a good share of assets are mapped to deep model nodes');
    assert.ok(first.catalogRequests >= 2, 'one any-matching and one specific-asset catalog request');
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

// Regression: the seeded admin must satisfy the REAL setup contract (POST /api/setup needs a password of 8+ characters)
// and must be exactly the documented login. These use literals on purpose — comparing the seed to its own constant
// can't notice the constant being edited to something the app rejects (a 7-character password made the seed fail with
// "POST /api/setup -> 400" and left a data-dev that redirected to /setup).
test('the documented seeded admin (dana.ito@example.com / DevPass!2026) is created, can log in, and /setup is not offered', async () => {
  assert.equal(DEV_PASSWORD, 'DevPass!2026');
  assert.ok(DEV_PASSWORD.length >= 8, 'must satisfy the setup endpoint\'s minimum password length');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seed-test-'));
  const dataDir = path.join(dir, 'data-dev');
  try {
    const summary = await seedDatabase({ dataDir, quiet: true });
    assert.equal(summary.adminEmail, 'dana.ito@example.com');
    const server = await startServer(bootApp(dataDir).app);
    try {
      const client = makeClient(server);
      assert.equal((await client.get('/api/setup-needed')).needed, false, 'the seeded database must not send the browser to /setup');
      await client.post('/api/login', { email: 'dana.ito@example.com', password: 'DevPass!2026' });
      const me = await client.get('/api/me');
      assert.equal(me.user.role, 'admin');
      assert.equal(me.user.email, 'dana.ito@example.com');
    } finally {
      await stopServer(server);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The seed has to demonstrate the catalog meaningfully: deep paths, an unmapped-below-root asset, and a held asset that the
// employee request flow must not offer.
test('the seeded catalog supports the employee request flow: deep path, one available A7 IV, the loaned one hidden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seed-test-'));
  const dataDir = path.join(dir, 'data-dev');
  try {
    await seedDatabase({ dataDir, quiet: true });
    const server = await startServer(bootApp(dataDir).app);
    try {
      const admin = makeClient(server);
      await admin.post('/api/login', { email: 'dana.ito@example.com', password: DEV_PASSWORD });
      const tree = await admin.get('/api/catalog');
      const byPath = (p) => tree.find((n) => n.path === p);
      assert.ok(byPath('Laptop > Mac > MacBook Air > M2'));
      assert.ok(byPath('Laptop > Windows > Dell > Latitude 5440'));
      assert.ok(byPath('Camera > Sony > A7 IV'));
      assert.ok(byPath('Lens > Canon RF > 24-70mm F2.8'));

      const emp = makeClient(server);
      await emp.post('/api/login', { email: 'emerson.ellis@example.com', password: DEV_PASSWORD });
      const a7 = (await emp.get('/api/catalog')).find((n) => n.path === 'Camera > Sony > A7 IV');
      assert.equal(a7.available_count, 1, 'two bodies exist, one is on loan');
      const offered = await emp.get(`/api/assets?catalog_node=${a7.id}`);
      assert.equal(offered.length, 1);
      assert.ok(!('holder_names' in offered[0]), 'no holder information for an employee');
      const camera = (await emp.get('/api/catalog')).find((n) => n.path === 'Camera');
      assert.ok((await emp.get(`/api/assets?catalog_node=${camera.id}`)).length >= 4, 'the whole subtree is browsable');
    } finally {
      await stopServer(server);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
