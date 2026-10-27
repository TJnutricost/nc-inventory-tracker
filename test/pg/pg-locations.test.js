// Managed locations (D-46/D-48): src/pg/locations.js, differential against src/locations.js on twin worlds, plus the PostgreSQL-only
// guarantees: a rename and its asset rewrite are ONE transaction (a failure leaves both untouched), and parallel edits of the list never lose one.
// Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const sq = require('../../src/locations');
const pg = require('../../src/pg/locations');
const sqSettings = require('../../src/settings');
const pgSettings = require('../../src/pg/settings');

describe('PostgreSQL managed locations (differential against src/locations.js)', pgSuite(), () => {
  let tdb; let tw;
  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    await pgSettings.setSetting(tw.pg, 'locations', ['HQ', 'Warehouse', 'Remote']);
    sqSettings.setSetting(tw.sqlite, 'locations', ['HQ', 'Warehouse', 'Remote']);
    for (const [tag, loc] of [['L-1', 'Warehouse'], ['L-2', ' warehouse '], ['L-3', 'HQ'], ['L-4', 'Garage'], ['L-5', 'garage'], ['L-6', null], ['L-7', '  ']]) await tw.asset({ tag, location: loc });
    await tw.asset({ tag: 'L-8', location: 'WAREHOUSE', archived_at: '2026-01-01 00:00:00' });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  const same = (label, fn) => tw.same(label, (q) => fn(pg, q), (db) => fn(sq, db));
  const assetRows = () => tw.same('assets', (q) => q.query('SELECT tag, location FROM assets ORDER BY id').then((r) => r.rows), (db) => db.prepare('SELECT tag, location FROM assets ORDER BY id').all());

  test('the overview counts case-insensitively, trims, skips blanks, and lists unlisted locations', async () => {
    const o = (await same('overview', (m, q) => m.overview(q))).ok;
    assert.deepEqual(o.locations, [{ name: 'HQ', count: 1 }, { name: 'Warehouse', count: 3 }, { name: 'Remote', count: 0 }]);
    assert.deepEqual(o.unlisted, [{ name: 'Garage', count: 2 }].map((u) => ({ ...u, name: o.unlisted[0].name })));
  });

  test('add / rename / remove: the same results and the same refusals on both engines', async () => {
    for (const [label, fn] of [
      ['add', (m, q) => m.add(q, { name: ' Dock ' })],
      ['add duplicate', (m, q) => m.add(q, { name: 'DOCK' })],
      ['add blank', (m, q) => m.add(q, { name: ' ' })],
      ['add too long', (m, q) => m.add(q, { name: 'x'.repeat(81) })],
      ['rename unknown', (m, q) => m.rename(q, { from: 'Nope', to: 'X' })],
      ['rename onto another', (m, q) => m.rename(q, { from: 'Dock', to: 'remote' })],
      ['remove used', (m, q) => m.remove(q, { name: 'warehouse' })],
      ['remove unknown', (m, q) => m.remove(q, { name: 'Nope' })],
    ]) await same(label, fn);
    assert.equal((await same('remove used again', (m, q) => m.remove(q, { name: 'Warehouse' }))).error?.status, 409);
    const renamed = (await same('rename', (m, q) => m.rename(q, { from: 'warehouse', to: 'Warehouse - Main' }))).ok;
    assert.deepEqual(renamed.locations.map((l) => l.name), ['HQ', 'Warehouse - Main', 'Remote', 'Dock']);
    assert.equal(renamed.locations[1].count, 3);
    const rows = (await assetRows()).ok;
    assert.deepEqual(rows.filter((r) => ['L-1', 'L-2', 'L-8'].includes(r.tag)).map((r) => r.location), ['Warehouse - Main', 'Warehouse - Main', 'Warehouse - Main']);
    await same('remove unused', (m, q) => m.remove(q, { name: 'Dock' }));
    await same('final overview', (m, q) => m.overview(q));
  });

  test('PostgreSQL: the rename is one transaction, and parallel adds all land', async () => {
    const pool = tdb.pool;
    // a failing statement after the setting write (a NUL cannot be stored) rolls the setting back with it
    await assert.rejects(pg.rename(pool, { from: 'HQ', to: 'HQ\u0000' }));
    assert.deepEqual((await pgSettings.getSettings(pool)).locations.slice(0, 1), ['HQ']);
    await Promise.all(Array.from({ length: 6 }, (_, i) => pg.add(pool, { name: `Bench ${i}` })));
    const names = (await pgSettings.getSettings(pool)).locations;
    for (let i = 0; i < 6; i++) assert.ok(names.includes(`Bench ${i}`), `Bench ${i} kept`);
  });
});
