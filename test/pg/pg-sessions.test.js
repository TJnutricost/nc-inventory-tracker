// Slice 5C-3 (D-46, D-48): src/pg/sessions.js, differential against src/sessions.js, and the session-store contract the express-session
// Store class in src/server.js relies on: get returns { sess, expires } with `expires` a JS number (the store's `row.expires <
// Date.now()`), or undefined; set is an upsert; destroy removes one session; purgeExpired removes exactly the rows with expires < now;
// destroyForAccount removes only that account's sessions (the closing-brace pattern: account 1 never matches 12, 100 or 112). Both
// engines get the same calls and must end with the same rows. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');

const sq = require('../../src/sessions');
const pg = require('../../src/pg/sessions');

// The SqliteStore.get rule of src/server.js: an expired row is no session.
const storeGet = (row, now) => (!row || row.expires < now ? null : JSON.parse(row.sess));
const sess = (uid, extra = {}) => JSON.stringify({ cookie: { originalMaxAge: 2592000000, httpOnly: true, path: '/' }, ...extra, ...(uid === undefined ? {} : { uid }) });

describe('PostgreSQL sessions twin (differential against src/sessions.js)', pgSuite(), () => {
  let tdb; let tw;
  // the same call on both engines, then the same rows
  async function both(label, name, ...args) {
    const pgOut = await pg[name](tw.pg, ...args);
    const sqOut = await sq[name](tw.sqlite, ...args);
    assert.deepEqual(pgOut, sqOut, label);
    const pgRows = (await tw.pg.query('SELECT * FROM sessions ORDER BY sid')).rows;
    assert.deepEqual(pgRows, tw.sqlite.prepare('SELECT * FROM sessions ORDER BY sid').all(), `${label}: the same rows`);
    return pgOut;
  }
  const sids = async () => (await tw.pg.query('SELECT sid FROM sessions ORDER BY sid')).rows.map((r) => r.sid);

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('get / set / destroy: missing is undefined, set upserts, expires comes back as a number', async () => {
    const now = Date.now();
    assert.equal(await both('missing', 'get', 'nope'), undefined);
    await both('set', 'set', 's-live', sess(7), now + 30 * 864e5);
    const row = await both('get', 'get', 's-live');
    assert.deepEqual(row, { sess: sess(7), expires: now + 30 * 864e5 });
    assert.equal(typeof row.expires, 'number');
    assert.deepEqual(storeGet(row, now).uid, 7);
    await both('upsert (rolling touch)', 'set', 's-live', sess(7, { n: 2 }), now + 31 * 864e5);
    assert.deepEqual(await both('get after upsert', 'get', 's-live'), { sess: sess(7, { n: 2 }), expires: now + 31 * 864e5 });
    await both('set expired', 'set', 's-old', sess(8), now - 1);
    assert.equal(storeGet(await both('get expired', 'get', 's-old'), now), null, 'an expired row is no session (the store rule, numbers compared)');
    await both('destroy', 'destroy', 's-old');
    await both('destroy missing', 'destroy', 's-old');
    assert.deepEqual(await sids(), ['s-live']);
  });

  test('purgeExpired removes exactly the rows that expired before now', async () => {
    const now = 1_800_000_000_000;
    for (const [sid, exp] of [['p-before', now - 1], ['p-at', now], ['p-after', now + 1], ['p-long-ago', 1]]) await both(`set ${sid}`, 'set', sid, sess(9), exp);
    await both('purge', 'purgeExpired', now);
    assert.deepEqual((await sids()).filter((s) => s.startsWith('p-')), ['p-after', 'p-at']);
    for (const s of ['p-after', 'p-at']) await both(`clean ${s}`, 'destroy', s);
  });

  test('destroyForAccount signs out only that account: 1 is not 12, 100, 112 or 21; the rest of the JSON does not matter', async () => {
    const rows = {
      'a-1': sess(1), 'a-1b': sess(1, { returnTo: '/x' }), 'a-1-flash': sess(undefined, { flash: { uid: 1 } }), 'a-1-upper': '{"UID":1}',
      'a-12': sess(12), 'a-100': sess(100), 'a-112': sess(112), 'a-21': sess(21), 'a-none': sess(undefined), 'a-1-not-last': '{"uid":1,"x":2}',
      'a-text': sess(5, { note: 'uid:1} "uid":1' }),
    };
    const exp = Date.now() + 864e5;
    for (const [sid, s] of Object.entries(rows)) await both(`set ${sid}`, 'set', sid, s, exp);
    await both('destroy account 1', 'destroyForAccount', 1);
    assert.deepEqual((await sids()).filter((s) => s.startsWith('a-')), ['a-1-not-last', 'a-100', 'a-112', 'a-12', 'a-21', 'a-none', 'a-text'],
      'only the sessions whose JSON ends in "uid":1} (the store always writes uid last; a nested {"uid":1} object matches on SQLite too)');
    await both('destroy account 12', 'destroyForAccount', 12);
    assert.deepEqual((await sids()).filter((s) => s.startsWith('a-')), ['a-1-not-last', 'a-100', 'a-112', 'a-21', 'a-none', 'a-text']);
    await both('destroy unknown account', 'destroyForAccount', 999);
    await both('destroy account 112', 'destroyForAccount', 112);
    assert.ok((await sids()).includes('a-100'));
  });
});
