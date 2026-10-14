// src/pg/catalog.js (D-46, Slice 3): the catalog tree on PostgreSQL. Ports the module-level scenarios of test/catalog.test.js,
// runs one operation script against BOTH src/catalog.js (SQLite) and src/pg/catalog.js and requires identical results and
// errors, and covers what is new on PostgreSQL: the cache across transactions (invalidated after commit, never holding
// rolled-back or uncommitted state, a racing load not stored) and the sibling-name race mapped to the same 400.
// Skipped without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { buildSqliteReference } = require('../../test-support/pg-parity');
const fx = require('../../test-support/pg-fixtures');
const { withTransaction } = require('../../src/pg/transaction');
const sqliteCatalog = require('../../src/catalog');
const catalog = require('../../src/pg/catalog');

const SIBLING = (name, archived = false) => `“${name}” already exists here${archived ? ' (archived — restore it instead)' : ''}. Names must differ at the same level, ignoring capitals and extra spaces.`;
const rejects400 = (p, message) => assert.rejects(p, (e) => e.status === 400 && (message === undefined || (message instanceof RegExp ? message.test(e.message) : e.message === message)));
const outcome = (p) => Promise.resolve().then(p).then((v) => ({ ok: v }), (e) => ({ status: e.status, message: e.message }));

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitingOnLock = async (pool, pid) => (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wait_event_type === 'Lock';

describe('PostgreSQL catalog', pgSuite(), () => {
  let tdb; let pool;
  before(async () => { tdb = await createTestDatabase(); pool = tdb.pool; });
  after(async () => { await tdb?.drop(); });

  test('a fresh database starts with the standard categories as live roots, sorted by name key', async () => {
    const { nodes, children } = await catalog.loadIndex(pool);
    const roots = (children.get(0) || []).map((id) => nodes.get(id).name);
    assert.equal(roots.length, 13);
    assert.deepEqual(roots, [...roots].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    const laptop = await catalog.findLiveByPath(pool, 'Laptop');
    assert.equal(await catalog.pathText(pool, laptop), 'Laptop');
    assert.equal(await catalog.isLive(pool, laptop), true);
  });

  test('roots, children and nesting: ids, paths, depth, root, subtree', async () => {
    const cam = await catalog.createNode(pool, { name: '  Camera  ' });
    assert.equal(typeof cam, 'number');
    const sony = await catalog.createNode(pool, { name: 'Sony', parentId: cam });
    const a7 = await catalog.createNode(pool, { name: 'A7   IV', parentId: sony });
    assert.deepEqual(await catalog.pathNames(pool, a7), ['Camera', 'Sony', 'A7 IV']);
    assert.equal(await catalog.pathText(pool, a7), 'Camera > Sony > A7 IV');
    assert.equal(await catalog.depthOf(pool, a7), 3);
    assert.equal((await catalog.rootOf(pool, a7)).id, cam);
    assert.deepEqual((await catalog.subtreeIds(pool, cam)).sort(), [cam, sony, a7].sort());
    assert.equal(await catalog.pathNames(pool, 999999), null);
    assert.equal(await catalog.rootOf(pool, 999999), null);
    assert.deepEqual(await catalog.subtreeIds(pool, 999999), []);
    await assert.rejects(catalog.getNode(pool, 999999), (e) => e.status === 404 && e.message === 'Catalog entry not found');
  });

  test('sibling names are unique ignoring case and whitespace, archived siblings included; other branches may reuse a name', async () => {
    const root = await catalog.createNode(pool, { name: 'Sib Root' });
    await catalog.createNode(pool, { name: 'Mac', parentId: root });
    await rejects400(catalog.createNode(pool, { name: '  mAC ', parentId: root }), SIBLING('Mac'));
    const old = await catalog.createNode(pool, { name: 'Old Model', parentId: root });
    await catalog.archiveNode(pool, old);
    await rejects400(catalog.createNode(pool, { name: 'old   model', parentId: root }), SIBLING('Old Model', true));
    const other = await catalog.createNode(pool, { name: 'Other Root' });
    assert.ok(await catalog.createNode(pool, { name: 'Mac', parentId: other }), 'another branch may reuse the name');
    await rejects400(catalog.createNode(pool, { name: 'SIB ROOT' }), SIBLING('Sib Root'), 'roots are siblings too');
  });

  test('names are validated: required, bounded, text only, no path separator', async () => {
    await rejects400(catalog.createNode(pool, { name: '   ' }), 'Give it a name');
    await rejects400(catalog.createNode(pool, {}), 'Give it a name');
    await rejects400(catalog.createNode(pool, { name: 'x'.repeat(101) }), 'Names can be at most 100 characters');
    await rejects400(catalog.createNode(pool, { name: 'Laptop > Mac' }), 'Names can’t contain “>” (it separates levels in a path)');
    await rejects400(catalog.createNode(pool, { name: 'Laptop › Mac' }), 'Names can’t contain “>” (it separates levels in a path)');
    await rejects400(catalog.createNode(pool, { name: 42 }), 'Name must be text');
    assert.ok(await catalog.createNode(pool, { name: 'y'.repeat(100) }), '100 characters is fine');
  });

  test('rename keeps identity and children; a colliding rename is refused; changing only the case of its own name is fine', async () => {
    const root = await catalog.createNode(pool, { name: 'Rename Root' });
    const a = await catalog.createNode(pool, { name: 'Alpha', parentId: root });
    const child = await catalog.createNode(pool, { name: 'Child', parentId: a });
    await catalog.createNode(pool, { name: 'Beta', parentId: root });
    const res = await catalog.updateNode(pool, a, { name: 'Alpha Two' });
    assert.deepEqual(res, { oldPath: 'Rename Root > Alpha', newPath: 'Rename Root > Alpha Two', wasRoot: false, isRoot: false });
    assert.equal(await catalog.pathText(pool, child), 'Rename Root > Alpha Two > Child');
    await rejects400(catalog.updateNode(pool, a, { name: 'beta' }), SIBLING('Beta'));
    assert.deepEqual(await catalog.updateNode(pool, a, { name: 'ALPHA two' }), { oldPath: 'Rename Root > Alpha Two', newPath: 'Rename Root > ALPHA two', wasRoot: false, isRoot: false });
    await assert.rejects(catalog.updateNode(pool, 999999, { name: 'x' }), (e) => e.status === 404);
  });

  test('moving: no cycles (self, child, deep descendant), no archived destination, sibling-unique, and the {oldPath,newPath,wasRoot,isRoot} answer', async () => {
    const top = await catalog.createNode(pool, { name: 'Move Top' });
    const mid = await catalog.createNode(pool, { name: 'Mid', parentId: top });
    const deep = await catalog.createNode(pool, { name: 'Deep', parentId: mid });
    const cycle = "A catalog entry can't be moved under itself or one of its own children.";
    await rejects400(catalog.updateNode(pool, top, { parentId: top }), cycle);
    await rejects400(catalog.updateNode(pool, top, { parentId: mid }), cycle);
    await rejects400(catalog.updateNode(pool, top, { parentId: deep }), cycle);
    await assert.rejects(catalog.updateNode(pool, mid, { parentId: 999999 }), (e) => e.status === 404);
    const parked = await catalog.createNode(pool, { name: 'Parked' });
    await catalog.archiveNode(pool, parked);
    await rejects400(catalog.updateNode(pool, mid, { parentId: parked }), 'That destination is archived. Restore it first.');
    const dest = await catalog.createNode(pool, { name: 'Dest' });
    await catalog.createNode(pool, { name: 'MID', parentId: dest });
    await rejects400(catalog.updateNode(pool, mid, { parentId: dest }), SIBLING('MID'));
    assert.deepEqual(await catalog.updateNode(pool, deep, { parentId: null }), { oldPath: 'Move Top > Mid > Deep', newPath: 'Deep', wasRoot: false, isRoot: true });
    assert.deepEqual(await catalog.updateNode(pool, deep, { parentId: dest, name: 'Deeper' }), { oldPath: 'Deep', newPath: 'Dest > Deeper', wasRoot: true, isRoot: false });
    assert.equal(await catalog.depthOf(pool, deep), 2);
  });

  test('archive hides the subtree (an archived ancestor makes descendants non-live); restore needs a live parent', async () => {
    const r = await catalog.createNode(pool, { name: 'Arch Root' });
    const c = await catalog.createNode(pool, { name: 'Arch Child', parentId: r });
    const g = await catalog.createNode(pool, { name: 'Arch Grand', parentId: c });
    await catalog.archiveNode(pool, r);
    assert.deepEqual([await catalog.isLive(pool, r), await catalog.isLive(pool, c), await catalog.isLive(pool, g)], [false, false, false]);
    assert.equal((await catalog.getNode(pool, g)).archived_at, null, 'descendants are not archived themselves');
    await rejects400(catalog.archiveNode(pool, r), 'Already archived');
    await rejects400(catalog.createNode(pool, { name: 'Under archived', parentId: c }), 'That parent is archived. Restore it first.');
    await catalog.archiveNode(pool, c);
    await rejects400(catalog.restoreNode(pool, c), 'Restore the parent first — it is archived.');
    await catalog.restoreNode(pool, r);
    assert.deepEqual([await catalog.isLive(pool, r), await catalog.isLive(pool, c), await catalog.isLive(pool, g)], [true, false, false]);
    await catalog.restoreNode(pool, c);
    assert.equal(await catalog.isLive(pool, g), true);
    await rejects400(catalog.restoreNode(pool, c), 'Not archived');
    assert.match((await pool.query('SELECT updated_at FROM catalog_nodes WHERE id = $1', [c])).rows[0].updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('usage and delete: a node with children, assets or requests cannot be deleted; an unused one can', async () => {
    const inUse = 'This entry is in use (it has children, assets or requests), so it can’t be deleted. Archive it instead.';
    const r = await catalog.createNode(pool, { name: 'Del Root' });
    const withAsset = await catalog.createNode(pool, { name: 'With asset', parentId: r });
    const withReq = await catalog.createNode(pool, { name: 'With request', parentId: r });
    const unused = await catalog.createNode(pool, { name: 'Unused', parentId: r });
    await fx.insertAsset(pool, { catalog_node_id: withAsset });
    const who = await fx.insertEmployee(pool);
    await fx.insertRequest(pool, { user_id: who.id, catalog_node_id: withReq });
    assert.deepEqual(await catalog.usage(pool, r), { children: 3, assets: 0, requests: 0 });
    assert.deepEqual(await catalog.usage(pool, withAsset), { children: 0, assets: 1, requests: 0 });
    assert.deepEqual(await catalog.usage(pool, withReq), { children: 0, assets: 0, requests: 1 });
    for (const id of [r, withAsset, withReq]) await rejects400(catalog.deleteNode(pool, id), inUse);
    await catalog.deleteNode(pool, unused);
    await assert.rejects(catalog.getNode(pool, unused), (e) => e.status === 404);
    await assert.rejects(catalog.deleteNode(pool, unused), (e) => e.status === 404);
  });

  test('search text covers the entry and every ancestor (names and keywords); keywords are normalized and bounded', async () => {
    const cam = await catalog.createNode(pool, { name: 'Imaging', searchKeywords: '#Camera, photography;  VIDEO\nphotography' });
    assert.equal((await catalog.getNode(pool, cam)).search_keywords, 'camera, photography, video');
    const body = await catalog.createNode(pool, { name: 'Bodies', parentId: cam, searchKeywords: ['mirrorless'] });
    const lens = await catalog.createNode(pool, { name: 'Lens Kit', parentId: body });
    assert.equal(await catalog.searchText(pool, lens), 'lens kit  bodies mirrorless imaging camera, photography, video');
    const hits = await catalog.searchNodeIds(pool, 'mirrorless');
    assert.deepEqual(hits.sort(), [body, lens].sort(), 'a child inherits its ancestors\' keywords');
    await catalog.archiveNode(pool, body);
    assert.deepEqual(await catalog.searchNodeIds(pool, 'mirrorless', { liveOnly: true }), []);
    assert.deepEqual((await catalog.searchNodeIds(pool, 'mirrorless')).sort(), [body, lens].sort(), 'admins still find archived entries');
    await catalog.restoreNode(pool, body);
    await rejects400(catalog.createNode(pool, { name: 'Kw long', searchKeywords: 'k'.repeat(41) }), 'Each search keyword can be at most 40 characters');
    await rejects400(catalog.createNode(pool, { name: 'Kw many', searchKeywords: Array.from({ length: 31 }, (_, i) => `k${i}`) }), 'Use at most 30 search keywords');
    await rejects400(catalog.createNode(pool, { name: 'Kw type', searchKeywords: 7 }), 'Search keywords must be text');
    await rejects400(catalog.updateNode(pool, cam, { searchKeywords: [1] }), 'Search keywords must be text');
    await catalog.updateNode(pool, cam, { searchKeywords: '' });
    assert.equal((await catalog.getNode(pool, cam)).search_keywords, null, 'blank clears them');
    await catalog.updateNode(pool, cam, { name: 'Imaging' });
    assert.equal((await catalog.getNode(pool, cam)).search_keywords, null, 'omitting keywords keeps them');
  });

  test('findLiveByPath: > or ›, case and whitespace insensitive, live only', async () => {
    const r = await catalog.createNode(pool, { name: 'Path Root' });
    const m = await catalog.createNode(pool, { name: 'Mac Book', parentId: r });
    const air = await catalog.createNode(pool, { name: 'Air', parentId: m });
    assert.equal(await catalog.findLiveByPath(pool, 'Path Root > Mac Book > Air'), air);
    assert.equal(await catalog.findLiveByPath(pool, '  path root›MAC   BOOK ›  air '), air);
    assert.equal(await catalog.findLiveByPath(pool, 'path root > mac book'), m);
    assert.equal(await catalog.findLiveByPath(pool, 'Path Root > Nope'), null);
    assert.equal(await catalog.findLiveByPath(pool, ''), null);
    assert.equal(await catalog.findLiveByPath(pool, null), null);
    assert.equal(await catalog.findLiveByPath(pool, 'Air'), null, 'paths start at a root');
    await catalog.archiveNode(pool, m);
    assert.equal(await catalog.findLiveByPath(pool, 'Path Root > Mac Book > Air'), null, 'an archived ancestor makes it non-live');
    await catalog.restoreNode(pool, m);
  });

  test('the same operation script gives identical results and errors on SQLite (src/catalog.js) and PostgreSQL', async () => {
    const fresh = await createTestDatabase();
    const sqlite = buildSqliteReference();
    try {
      const L = 1; // "Laptop" is id 1 in both fresh databases
      const script = [
        ['createNode', { name: 'Mac' , parentId: L }],
        ['createNode', { name: ' mac ', parentId: L }],
        ['createNode', { name: 'Windows', parentId: L, searchKeywords: 'pc, #Office' }],
        ['createNode', { name: 'Air', parentId: 14 }],
        ['createNode', { name: 'a>b' }],
        ['createNode', { name: 'Zed', parentId: 999 }],
        ['updateNode', 14, { name: 'macOS' }],
        ['updateNode', 14, { parentId: 16 }],
        ['updateNode', 16, { parentId: null }],
        ['updateNode', 15, { name: 'MACOS' }],
        ['archiveNode', 14],
        ['archiveNode', 14],
        ['createNode', { name: 'Pro', parentId: 16 }],
        ['restoreNode', 16],
        ['restoreNode', 14],
        ['isLive', 16], ['pathText', 16], ['pathNames', 16], ['depthOf', 16], ['subtreeIds', 14], ['searchText', 15],
        ['searchNodeIds', 'office'], ['findLiveByPath', 'laptop › MACOS > air'], ['usage', 1],
        ['deleteNode', 1], ['deleteNode', 16], ['getNode', 16], ['rootOf', 15],
        ['updateNode', 15, { searchKeywords: Array(31).fill('x').map((x, i) => x + i) }],
      ];
      const sqliteRun = []; const pgRun = [];
      for (const [fn, ...args] of script) {
        sqliteRun.push(await outcome(() => sqliteCatalog[fn](sqlite, ...args)));
        pgRun.push(await outcome(() => catalog[fn](fresh.pool, ...args)));
      }
      for (let i = 0; i < script.length; i++) assert.deepEqual(pgRun[i], sqliteRun[i], `step ${i}: ${script[i][0]} ${JSON.stringify(script[i].slice(1))}`);
      const cols = 'id, parent_id, name, name_key, search_keywords, archived_at IS NULL AS live';
      const norm = (rows) => rows.map((r) => ({ ...r, live: Boolean(r.live) }));
      assert.deepEqual(norm((await fresh.pool.query(`SELECT ${cols} FROM catalog_nodes ORDER BY id`)).rows), norm(sqlite.prepare(`SELECT ${cols} FROM catalog_nodes ORDER BY id`).all()));
    } finally {
      sqlite.close();
      await fresh.drop();
    }
  });

  test('cache: a write through the pool is visible to the very next read; a transaction sees its own writes; nothing stale after rollback', async () => {
    const before = await catalog.loadIndex(pool);
    assert.equal(await catalog.loadIndex(pool), before, 'a second read is served from the cache');
    const id = await catalog.createNode(pool, { name: 'Cache One' });
    const after1 = await catalog.loadIndex(pool);
    assert.notEqual(after1, before);
    assert.ok(after1.nodes.has(id));

    let txId;
    await assert.rejects(withTransaction(async (c) => {
      txId = await catalog.createNode(c, { name: 'Rolled Back', parentId: id });
      assert.equal(await catalog.pathText(c, txId), 'Cache One > Rolled Back', 'the transaction reads its own write');
      assert.equal((await catalog.loadIndex(pool)).nodes.has(txId), false, 'other connections do not see it');
      throw new Error('undo');
    }, pool), /undo/);
    assert.equal((await catalog.loadIndex(pool)).nodes.has(txId), false, 'rolled back: not in the cache');
    await assert.rejects(catalog.getNode(pool, txId), (e) => e.status === 404);
    assert.equal(await catalog.findLiveByPath(pool, 'Cache One > Rolled Back'), null);
  });

  test('cache: a pool read during a transaction may cache the old tree, but the commit invalidates it', async () => {
    let txId;
    await withTransaction(async (c) => {
      txId = await catalog.createNode(c, { name: 'Committed Later' });
      const seenOutside = await catalog.loadIndex(pool);
      assert.equal(seenOutside.nodes.has(txId), false);
      assert.equal(await catalog.loadIndex(pool), seenOutside, 'the pre-commit tree is cached for now');
    }, pool);
    assert.equal((await catalog.loadIndex(pool)).nodes.has(txId), true, 'after commit the next read sees the new node');
    assert.equal(await catalog.findLiveByPath(pool, 'committed later'), txId);
  });

  test('cache: a load that raced with an invalidation is returned but not stored (generation counter)', async () => {
    let release;
    let calls = 0;
    const fakePool = {
      async query() {
        calls += 1;
        if (calls === 1) await new Promise((r) => { release = r; });
        return { rows: [{ id: calls, parent_id: null, name: `n${calls}`, archived_at: null, search_keywords: null }] };
      },
    };
    const slow = catalog.loadIndex(fakePool);
    await waitFor(async () => release !== undefined, 'the slow load to start');
    catalog.invalidate(); // a write lands while the load is in flight
    release();
    assert.ok((await slow).nodes.has(1), 'the caller still gets its answer');
    const next = await catalog.loadIndex(fakePool);
    assert.equal(calls, 2, 'the raced load was not cached, so the tree is read again');
    assert.ok(next.nodes.has(2));
    assert.equal(await catalog.loadIndex(fakePool), next, 'a clean load is cached');
    assert.equal(calls, 2);
  });

  test('sibling-name race: the loser of two simultaneous creates (or a rename) gets the same 400 as the friendly check', async () => {
    const parent = await catalog.createNode(pool, { name: 'Race Parent' });
    for (const via of ['pool', 'transaction', 'rename']) {
      const name = `Racer ${via}`;
      let winnerId; let letCommit; let signal;
      const mayCommit = new Promise((r) => { letCommit = r; });
      const inserted = new Promise((r) => { signal = r; });
      const winner = withTransaction(async (c) => {
        winnerId = await catalog.createNode(c, { name, parentId: parent });
        signal();
        await mayCommit;
      }, pool);
      await inserted;
      // The loser's friendly check cannot see the uncommitted row, so it reaches the INSERT/UPDATE and waits on the unique index.
      let loserPid = null;
      const loser = via === 'pool'
        ? (async () => { const c = await pool.connect(); try { loserPid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p; return await catalog.createNode(c, { name: name.toUpperCase(), parentId: parent }); } finally { c.release(); } })()
        : withTransaction(async (c) => {
          loserPid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
          if (via === 'rename') {
            const mine = await catalog.createNode(c, { name: `${name} other`, parentId: parent });
            return catalog.updateNode(c, mine, { name: ` ${name.toLowerCase()} ` });
          }
          const id = await catalog.createNode(c, { name: name.toLowerCase(), parentId: parent });
          return id;
        }, pool);
      const settled = outcome(() => loser);
      await waitFor(async () => loserPid !== null && waitingOnLock(pool, loserPid), `the ${via} loser to wait on the unique index`);
      letCommit();
      await winner;
      const lost = await settled;
      assert.deepEqual(lost, { status: 400, message: SIBLING(name) }, via);
      assert.equal((await pool.query('SELECT COUNT(*) c FROM catalog_nodes WHERE parent_id = $1 AND name_key = $2', [parent, name.toLowerCase()])).rows[0].c, 1);
      assert.ok((await catalog.loadIndex(pool)).nodes.has(winnerId));
    }
    assert.equal(pool.waitingCount, 0);
  });
});
