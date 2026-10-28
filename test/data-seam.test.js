// The TEMPORARY database driver seam (D-48, PostgreSQL migration Slice 5B-1): DB_DRIVER handling, the SQLite binding, error
// pass-through, and that nothing here loads or touches PostgreSQL. Runs on SQLite only; never needs Docker and never sends email.
// The SQLite side of the temporary driver seam: it opens SQLite itself, so it does not run in the PostgreSQL pass (test/pg covers the PG side).
if (process.env.NC_TEST_DRIVER === 'pg') { require('node:test').test(`${require('path').basename(__filename)} (SQLite seam)`, { skip: 'SQLite seam; the PG side is covered by test/pg' }, () => {}); return; }
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { bootApp, startServer, stopServer, makeClient, setupAdmin, asReservation } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const seam = require('../src/dataSeam');
const { MODULES } = require('../src/dataSeam/sqlite');

let server, db, admin, data;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  data = seam.open({ db });
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
async function newAsset(extra = {}) {
  const r = await admin.post('/api/assets', { name: `Seam Camera ${++seq}`, tag: `SEAM-${seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const email = `seam${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true });
  const tok = require('./helpers').inviteToken(db, created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  const me = (await client.get('/api/me')).body;
  return { client, user: { role: 'employee', employee_id: me.employee_id, account_id: me.account_id } };
}
// The first parameter's name of a module function (`function f(db, ...)`, `(db, x) => ...`).
const firstParam = (f) => (String(f).match(/^(?:async\s*)?(?:function\s*[\w$]*\s*)?\(?\s*([\w$]*)/) || [])[1];
// Runs `code` in a fresh Node process from the repository root (never reads a developer's .env: NC_NO_EXTERNAL_MAIL=1).
function inChild(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seam-'));
  const childEnv = { ...process.env, NC_NO_EXTERNAL_MAIL: '1', DATA_DIR: dir, SESSION_SECRET: 'x', APP_URL: 'http://localhost', ...env };
  if (env.DB_DRIVER === undefined) delete childEnv.DB_DRIVER;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout.trim().split('\n').pop()), dir };
}
// What the child reports: the outcome and which PostgreSQL / SQLite code it loaded.
const REPORT = `
const sep = require('path').sep;
const loaded = Object.keys(require.cache);
report.pg = loaded.filter((k) => k.includes(sep + 'src' + sep + 'pg' + sep) || k.includes(sep + 'node_modules' + sep + 'pg' + sep));
report.sqliteDb = loaded.some((k) => k.endsWith(sep + 'src' + sep + 'db.js'));
console.log(JSON.stringify(report));`;

// ---------------------------------------------------------------- DB_DRIVER
test('DB_DRIVER: unset, empty or sqlite selects SQLite (the default)', () => {
  assert.equal(seam.DEFAULT_DRIVER, 'sqlite');
  for (const env of [{}, { DB_DRIVER: '' }, { DB_DRIVER: 'sqlite' }, { DB_DRIVER: ' sqlite ' }]) assert.equal(seam.resolveDriver(env), 'sqlite', JSON.stringify(env));
  assert.equal(data.driver, 'sqlite');
});

test('DB_DRIVER=pg selects PostgreSQL (Slice 5D); any other value is refused with a clear error', () => {
  for (const env of [{ DB_DRIVER: 'pg' }, { DB_DRIVER: ' pg ' }]) assert.equal(seam.resolveDriver(env), 'pg', JSON.stringify(env));
  for (const v of ['postgres', 'PG', 'mysql', 'sqlite3', 'Sqlite']) {
    assert.throws(() => seam.resolveDriver({ DB_DRIVER: v }), (e) => e.code === 'DB_DRIVER_INVALID' && e.message.includes(`DB_DRIVER="${v}" is not a known database driver`), v);
  }
  assert.throws(() => seam.open({ driver: 'pg', db }), /needs a node-postgres pool/, 'the SQLite handle is not a pool');
  assert.throws(() => seam.open({ driver: 'nope', db }), (e) => e.code === 'DB_DRIVER_INVALID');
  assert.throws(() => seam.open({ driver: 'sqlite' }), /needs the better-sqlite3 database handle/);
  assert.throws(() => seam.open({ driver: 'sqlite', db: {} }), /needs the better-sqlite3 database handle/);
});

test('the app refuses to start with an unknown DB_DRIVER before opening SQLite and without loading PostgreSQL code', () => {
  for (const [value, code] of [['bogus', 'DB_DRIVER_INVALID'], ['postgres', 'DB_DRIVER_INVALID']]) {
    const { out, dir } = inChild(`const report = {};
try { require('./src/server'); report.started = true; } catch (e) { report.code = e.code; report.message = e.message; }
${REPORT}`, { DB_DRIVER: value });
    assert.equal(out.started, undefined, `DB_DRIVER=${value} must not start the app`);
    assert.equal(out.code, code);
    assert.deepEqual(out.pg, [], `DB_DRIVER=${value} must not load src/pg/* or the pg package`);
    assert.equal(out.sqliteDb, false, 'the check runs before src/db.js opens the SQLite database');
    assert.equal(fs.existsSync(path.join(dir, 'assets.db')), false, 'no database file was created');
  }
});

// Slice 5D: with DB_DRIVER=pg the app module loads without touching SQLite and without connecting: the pool is lazy and only boot()
// (awaited before listen) migrates. A database that does not exist is fine here, since nothing connects.
test('DB_DRIVER=pg loads the app on the PostgreSQL seam without opening SQLite or connecting', () => {
  const { out, dir } = inChild(`const report = {};
const app = require('./src/server'); report.started = true; report.boot = typeof app.boot;
const pool = require('./src/pg/pool').getPool(); report.connections = pool.totalCount;
${REPORT}`, { DB_DRIVER: 'pg', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
  assert.equal(out.started, true);
  assert.equal(out.boot, 'function');
  assert.equal(out.connections, 0, 'loading the app opens no connection');
  assert.equal(out.sqliteDb, false, 'src/db.js is not loaded');
  assert.equal(fs.existsSync(path.join(dir, 'assets.db')), false, 'no SQLite database file was created');
  const sep = path.sep;
  assert.ok(out.pg.some((k) => k.endsWith(`${sep}src${sep}pg${sep}pool.js`)) && out.pg.some((k) => k.endsWith(`${sep}src${sep}pg${sep}mailer.js`)));
  for (const lazy of ['migrate.js', 'notifier.js', 'sweep.js']) assert.ok(!out.pg.some((k) => k.endsWith(`${sep}src${sep}pg${sep}${lazy}`)), `${lazy} waits for boot()`);
});

test('the app on the default driver, and the seam itself, load no PostgreSQL code (no pool, no connection, no migration)', () => {
  const app = inChild(`const report = {};
require('./src/server'); report.started = true;
${REPORT}`).out;
  assert.equal(app.started, true);
  assert.deepEqual(app.pg, []);
  const alone = inChild(`const report = {};
const Database = require('better-sqlite3');
const data = require('./src/dataSeam').open({ db: new Database(':memory:') });
report.modules = Object.keys(data);
${REPORT}`).out;
  assert.deepEqual(alone.pg, []);
  assert.equal(alone.sqliteDb, false, 'the seam does not open the app database by itself');
  assert.deepEqual(alone.modules.sort(), ['assetAccess', 'assignments', 'availability', 'catalog', 'catalogAdmin', 'driver', 'requests', 'reservationViews', 'reservations', 'waitlist',
    // Slice 5B-2
    'activityLog', 'people', 'assetViews', 'assetRecords', 'assetCustody', 'photoRecords', 'dashboard', 'catalogViews', 'requestAccess',
    // Slice 5B-3
    'accounts', 'sessions',
    // Slice 5B-4
    'settings', 'locations', 'outbox', 'overdue', 'requestRecords',
    // Employee CSV import
    'employeeImport'].sort());
});

// ---------------------------------------------------------------- binding
test('the seam binds exactly the functions whose first argument is the database; everything else passes through untouched', () => {
  for (const [name, [mod, dbFunctions]] of Object.entries(MODULES)) {
    const bound = data[name];
    assert.ok(Object.isFrozen(bound), `${name} is read-only`);
    for (const [key, value] of Object.entries(mod)) {
      if (typeof value === 'function' && firstParam(value) === 'db') assert.ok(dbFunctions.includes(key), `${name}.${key} takes the database first, so it must be bound`);
      if (dbFunctions.includes(key)) {
        assert.equal(firstParam(value), 'db', `${name}.${key} is bound but does not take the database first`);
        assert.notEqual(bound[key], value);
      } else {
        assert.equal(bound[key], value, `${name}.${key} passes through as the module's own export`);
      }
    }
    assert.deepEqual(Object.keys(bound).sort(), Object.keys(mod).sort(), `${name}: same export names as the module`);
  }
  // spot checks: pure helpers stay synchronous and identical
  assert.equal(data.catalog.parseParent, require('../src/catalog').parseParent);
  assert.equal(data.requests.TRANSITIONS, require('../src/requests').TRANSITIONS);
  assert.equal(data.reservations.LIVE, require('../src/reservations').LIVE);
  assert.equal(data.reservationViews.RESERVATION_SQL, require('../src/reservationViews').RESERVATION_SQL);
});

test('every bound function calls the module function of the same name with THIS database handle first and the arguments unchanged', async () => {
  for (const [name, [mod, dbFunctions]] of Object.entries(MODULES)) {
    for (const fn of dbFunctions) {
      const real = mod[fn];
      const marker = { fn };
      mod[fn] = (...args) => ({ args, marker });
      try {
        const p = data[name][fn]('a1', { b: 2 }, 3);
        assert.ok(p instanceof Promise, `${name}.${fn} returns a promise`);
        const out = await p;
        assert.equal(out.marker, marker, `${name}.${fn} calls ${name}.${fn}`);
        assert.equal(out.args[0], db, `${name}.${fn} passes the bound database handle first`);
        assert.deepEqual(out.args.slice(1), ['a1', { b: 2 }, 3]);
      } finally { mod[fn] = real; }
    }
  }
});

test('a bound function answers exactly what the module answers when called directly', async () => {
  const reservationRules = require('../src/reservations');
  const waitlistRules = require('../src/waitlist');
  const availabilityLib = require('../src/availability');
  const catalog = require('../src/catalog');
  const requestRules = require('../src/requests');
  const assetAccess = require('../src/assetAccess');
  const reservationViews = require('../src/reservationViews');
  const catalogAdmin = require('../src/catalogAdmin');
  const node = (await admin.post('/api/catalog', { name: `Seam Cameras ${++seq}` })).body;
  const asset = await newAsset({ catalog_node_id: node.id });
  const owner = await makeLogin('Sam Seam');
  const waiter = await makeLogin('Wally Seam');
  const r = asReservation(await owner.client.post(`/api/assets/${asset.id}/reservations`, { start_date: plus(5), end_date: plus(6) }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await waiter.client.post(`/api/assets/${asset.id}/waitlist`, { start_date: plus(5), end_date: plus(6) })).status, 200);
  const adminUser = { role: 'admin', employee_id: null, account_id: 1 };

  assert.deepEqual(await data.reservationViews.reservationById(r.body.id, owner.user), reservationViews.reservationById(db, r.body.id, owner.user));
  assert.deepEqual(await data.reservationViews.reservationById(r.body.id, adminUser), reservationViews.reservationById(db, r.body.id, adminUser));
  assert.deepEqual(await data.assetAccess.reservableAsset(waiter.user, asset.id), assetAccess.reservableAsset(db, waiter.user, asset.id));
  assert.equal(await data.assetAccess.canViewAsset(waiter.user, asset), assetAccess.canViewAsset(db, waiter.user, asset));
  for (const u of [owner.user, waiter.user, adminUser]) {
    assert.deepEqual(await data.waitlist.counts(u), waitlistRules.counts(db, u));
    assert.deepEqual(await data.waitlist.list(u, { status: 'open' }), waitlistRules.list(db, u, { status: 'open' }));
  }
  const scope = { isAdmin: false, employeeId: waiter.user.employee_id, assetId: String(asset.id), canReserve: true };
  assert.deepEqual(await data.availability.availability(scope), availabilityLib.availability(db, scope));
  assert.deepEqual(await data.waitlist.rangeCheck({ assetId: asset.id, employeeId: waiter.user.employee_id, start: plus(5), end: plus(5) }),
    waitlistRules.rangeCheck(db, { assetId: asset.id, employeeId: waiter.user.employee_id, start: plus(5), end: plus(5) }));
  assert.deepEqual(await data.catalogAdmin.catalogOut(node.id), catalogAdmin.catalogOut(db, node.id));
  assert.equal(await data.catalog.pathText(node.id), catalog.pathText(db, node.id));
  assert.equal(await data.reservations.todayOf(), reservationRules.todayOf(db));
  const rows = db.prepare('SELECT * FROM requests ORDER BY id').all();
  assert.deepEqual(await data.requests.withLifecycle(rows), requestRules.withLifecycle(db, rows));
});

// ---------------------------------------------------------------- errors and timing
test('an error passes through the seam unchanged: the same error object, status, code and message, as a rejection', async () => {
  const waitlistRules = require('../src/waitlist');
  const real = waitlistRules.counts;
  const err = Object.assign(new Error('Something specific'), { status: 409, code: 'SOME_CODE' });
  waitlistRules.counts = () => { throw err; };
  try {
    const p = data.waitlist.counts({}); // a synchronous throw becomes a rejection, never a throw at the call site
    assert.ok(p instanceof Promise);
    await assert.rejects(p, (e) => e === err && e.status === 409 && e.code === 'SOME_CODE' && e.message === 'Something specific');
  } finally { waitlistRules.counts = real; }
  // a real refusal from a module: what the route would have thrown synchronously before
  let direct;
  try { require('../src/reservations').approve(db, 987654, { actorAccountId: 1 }); } catch (e) { direct = e; }
  assert.ok(direct && direct.status === 404);
  await assert.rejects(data.reservations.approve(987654, { actorAccountId: 1 }), (e) => e.status === direct.status && e.message === direct.message && e.code === direct.code);
});

test('a module transaction still runs to completion inside one seam call, and chained seam calls never yield to other work on SQLite', async () => {
  const waitlistRules = require('../src/waitlist');
  let other = false;
  const t = setTimeout(() => { other = true; }, 0);
  setImmediate(() => { other = true; });
  // a write, then reads, the way a migrated route chains them
  const before = await data.reservations.todayOf();
  await data.waitlist.dispatchHoldEmails();
  await data.waitlist.counts({ role: 'admin', employee_id: null });
  await data.catalog.loadIndex();
  assert.equal(before, TODAY);
  assert.equal(other, false, 'no timer, I/O callback or other request ran between the seam calls');
  clearTimeout(t);
  // and the wrapper itself has no await before the module call: the module function has already run when the call returns
  const real = waitlistRules.counts;
  let ran = false;
  waitlistRules.counts = () => { ran = true; return 'x'; };
  try { const p = data.waitlist.counts({}); assert.equal(ran, true, 'ran synchronously inside the call'); assert.equal(await p, 'x'); } finally { waitlistRules.counts = real; }
});

test('HTTP: a migrated (async) route answers an error with exactly the body and status a synchronous route does', async () => {
  const waitlistRules = require('../src/waitlist');
  const requestRules = require('../src/requests');
  const asset = await newAsset();
  const realCounts = waitlistRules.counts; const realLifecycle = requestRules.withLifecycle;
  const realConsoleError = console.error;
  try {
    for (const err of [Object.assign(new Error('Short and stout'), { status: 418 }), new Error('internal detail that must not leak')]) {
      waitlistRules.counts = () => { throw err; }; // GET /api/reservation-counts: migrated, async
      requestRules.withLifecycle = () => { throw err; }; // GET /api/requests: synchronous until Slice 5B-4 migrated it (the last such route); the comparison still pins both bodies
      console.error = () => {}; // (the error handler logs 500s)
      const asyncRes = await admin.get('/api/reservation-counts');
      const syncRes = await admin.get('/api/requests');
      console.error = realConsoleError;
      assert.equal(asyncRes.status, err.status || 500);
      assert.equal(asyncRes.status, syncRes.status);
      assert.deepEqual(asyncRes.body, syncRes.body);
      assert.deepEqual(asyncRes.body, { error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  } finally {
    waitlistRules.counts = realCounts; requestRules.withLifecycle = realLifecycle; console.error = realConsoleError;
  }
});

test('HTTP: refusals from the data modules reach the client unchanged through the migrated routes', async () => {
  const waiter = await makeLogin('Rita Refused');
  // the module's own answer, called directly (nothing is written: each refusal happens before any write)
  const directError = (f) => { try { f(); } catch (e) { return e; } assert.fail('expected a refusal'); };
  const cases = [
    [() => admin.post('/api/reservations/987654/approve', {}), () => require('../src/reservations').approve(db, 987654, { actorAccountId: 1 })],
    [() => admin.post('/api/reservations/987654/decline', {}), () => require('../src/reservations').decline(db, 987654, { actorAccountId: 1 })],
    [() => waiter.client.post('/api/reservations/987654/cancel', {}), () => require('../src/reservations').cancel(db, 987654, { ...waiter.user, employeeId: waiter.user.employee_id, isAdmin: false })],
    [() => waiter.client.get('/api/waitlist/987654'), () => require('../src/waitlist').get(db, 987654, waiter.user)],
    [() => waiter.client.post('/api/waitlist/987654/confirm', {}), () => require('../src/waitlist').confirmHold(db, 987654, { employeeId: waiter.user.employee_id, actorAccountId: waiter.user.account_id })],
    [() => waiter.client.post('/api/assets/987654/reservations', { start_date: plus(1), end_date: plus(1) }), () => require('../src/assetAccess').reservableAsset(db, waiter.user, 987654)],
    [() => admin.del('/api/catalog/987654'), () => require('../src/catalog').deleteNode(db, 987654)],
    [() => admin.post('/api/requests/987654/open', {}), () => require('../src/requests').openRequest(db, 987654)],
    [() => admin.post('/api/catalog', { name: '' }), () => require('../src/catalogAdmin').createNode(db, { name: '', parentId: null })],
  ];
  for (const [viaHttp, direct] of cases) {
    const e = directError(direct);
    assert.ok(e.status >= 400 && e.status < 500, `a client refusal: ${e.message}`);
    const res = await viaHttp();
    assert.equal(res.status, e.status, e.message);
    assert.deepEqual(res.body, { error: e.message });
  }
});
