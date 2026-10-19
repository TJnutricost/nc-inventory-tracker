// Slice 5D-2 (carry-over (ah)): the request create, resolve and dropped-off writes under concurrency on PostgreSQL. Skipped without PostgreSQL.
//   - a burst of creates racing an archive of the same asset: every request that exists has its 'requested' activity row (one write), and
//     none is created once the archive has committed (the recheck under the asset lock refuses it with the route's 400);
//   - concurrent resolves of one issue: exactly one wins, exactly one activity row, the others get the 400;
//   - concurrent dropped-offs of one return request: same;
//   - the session touch never re-creates a row, even in a burst against destroyForAccount.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const fx = require('../../test-support/pg-fixtures');
const records = require('../../src/pg/requestRecords');
const assetRecords = require('../../src/pg/assetRecords');
const sessions = require('../../src/pg/sessions');

const settled = (ps) => Promise.allSettled(ps);
const base = (emp, asset, extra = {}) => ({ forUser: emp.id, assetId: asset.id, category: null, message: 'm', neededBy: null, createdBy: null, wantedType: null, nodeId: null, catalogPath: null, assetLabel: null, ...extra });

describe('Slice 5D-2 concurrency on PostgreSQL', pgSuite(), () => {
  let tdb, pool;
  before(async () => { tdb = await createTestDatabase(); pool = tdb.pool; });
  after(() => tdb?.drop());

  test('creates racing an archive: no request without its activity row, none after the archive commits', async () => {
    const emp = await fx.insertEmployee(pool);
    const asset = await fx.insertAsset(pool);
    const creates = Array.from({ length: 12 }, () => records.createEquipmentRequest(pool, base(emp, asset, {
      recheck: { restrictToAvailable: false }, activity: { actorAccountId: null, details: 'race' },
    })));
    const archive = assetRecords.archiveAsset(pool, asset.id, { actorAccountId: null, reason: 'race' });
    const out = await settled([...creates, archive]);
    assert.equal(out.at(-1).status, 'fulfilled', String(out.at(-1).reason));
    for (const r of out.slice(0, -1)) if (r.status === 'rejected') assert.ok(r.reason.status === 400 && /archived/.test(r.reason.message), r.reason.message);
    const made = (await pool.query('SELECT COUNT(*)::int AS n FROM requests WHERE asset_id = $1', [asset.id])).rows[0].n;
    const logged = (await pool.query("SELECT COUNT(*)::int AS n FROM activity WHERE asset_id = $1 AND action = 'requested'", [asset.id])).rows[0].n;
    assert.equal(logged, made, 'one activity row per request');
    await assert.rejects(records.createEquipmentRequest(pool, base(emp, asset, { recheck: { restrictToAvailable: false }, activity: { actorAccountId: null, details: 'late' } })), (e) => e.status === 400);
  });

  test('concurrent resolves of one issue: one winner, one activity row', async () => {
    const emp = await fx.insertEmployee(pool);
    const asset = await fx.insertAsset(pool);
    const issue = await fx.insertRequest(pool, { type: 'issue', user_id: emp.id, asset_id: asset.id, status: 'open' });
    const act = { action: 'issue_resolved', details: 'x', actorAccountId: null, subjectUserId: emp.id };
    const out = await settled(Array.from({ length: 6 }, () => records.transitionLogged(pool, { id: issue.id, to: 'completed', opts: { actorIsAdmin: true }, activity: act })));
    assert.equal(out.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of out.filter((x) => x.status === 'rejected')) assert.equal(r.reason.status, 400);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM activity WHERE asset_id = $1 AND action = 'issue_resolved'", [asset.id])).rows[0].n, 1);
  });

  test('a failing activity insert rolls the status change back', async () => {
    const emp = await fx.insertEmployee(pool);
    const asset = await fx.insertAsset(pool);
    const ret = await fx.insertRequest(pool, { type: 'return', user_id: emp.id, asset_id: asset.id, status: 'open' });
    await assert.rejects(records.transitionLogged(pool, { id: ret.id, to: 'dropped_off', opts: {}, activity: { action: 'dropped_off', details: 'x', actorAccountId: 999999999, subjectUserId: emp.id, onlyIfAsset: true } }));
    assert.equal((await pool.query('SELECT status FROM requests WHERE id = $1', [ret.id])).rows[0].status, 'open', 'the request is unchanged');
    const ok = await records.transitionLogged(pool, { id: ret.id, to: 'dropped_off', opts: {}, activity: { action: 'dropped_off', details: 'x', actorAccountId: null, subjectUserId: emp.id, onlyIfAsset: true } });
    assert.equal(ok.request.status, 'dropped_off');
    assert.equal(ok.asset.id, asset.id);
  });

  test('a burst of touches against destroyForAccount never leaves a session behind', async () => {
    for (let i = 0; i < 20; i++) await sessions.set(pool, `burst-${i}`, '{"uid":4242}', Date.now() + 60000);
    await settled([sessions.destroyForAccount(pool, 4242), ...Array.from({ length: 20 }, (_, i) => sessions.touch(pool, `burst-${i}`, Date.now() + 120000))]);
    await sessions.destroyForAccount(pool, 4242);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE sid LIKE 'burst-%'")).rows[0].n, 0);
  });
});
