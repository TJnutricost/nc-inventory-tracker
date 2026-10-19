// PostgreSQL migration Slice 5D-2: runtime correctness fixes, on BOTH drivers (SQLite by default; NC_TEST_DRIVER=pg runs the same file on
// PostgreSQL). (af) a rolling-cookie touch never re-creates a deleted session; (au) a fractional / out-of-range license_seats is a 400;
// (as)/(at) NUL-containing input is a 400; deadlocks (40P01) are a retryable 503; (ah) resolve / dropped-off / request create are one write.
const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isPg, bootApp, startServer, stopServer, setupAdmin, makeClient } = require('./helpers');

let app, db, server, admin, data;
before(async () => {
  ({ app, db } = bootApp());
  server = await startServer(app);
  admin = (await setupAdmin(server)).client;
  const seam = require('../src/dataSeam');
  data = isPg ? seam.open({ driver: 'pg', pool: require('../src/pg/pool').getPool() }) : seam.open({ driver: 'sqlite', db });
});
after(() => stopServer(server));

const count = async (table) => (isPg ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

test('(af) touch extends a live session but never re-creates a deleted one; set still creates', async () => {
  const sid = 'sess-af-1';
  await data.sessions.set(sid, '{"uid":7}', Date.now() + 1000);
  await data.sessions.touch(sid, Date.now() + 99999);
  assert.ok((await data.sessions.get(sid)).expires > Date.now() + 50000, 'a live session is extended');
  await data.sessions.destroyForAccount(7);
  assert.equal(await data.sessions.get(sid), undefined, 'deactivation deleted it');
  await data.sessions.touch(sid, Date.now() + 99999); // the in-flight request finishing
  assert.equal(await data.sessions.get(sid), undefined, 'the touch did not bring the session back');
});

test('(af) over HTTP: a request in flight when its session is deleted does not bring the session back', async () => {
  const c = makeClient(server);
  assert.equal((await c.post('/api/login', { email: 'ada@nutricost.com', password: 'correct-horse-1' })).status, 200);
  const before = await count('sessions');
  db.prepare('DELETE FROM sessions').run();
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal(await count('sessions'), 0, `no session row was re-created (had ${before})`);
  assert.equal((await admin.post('/api/login', { email: 'ada@nutricost.com', password: 'correct-horse-1' })).status, 200); // (the deleted rows included the admin's)
});

test('(au) license_seats: whole numbers in range are stored; 2.5, 1e10 and negatives are a 400 and write nothing', async () => {
  const ok = await admin.post('/api/assets', { name: 'Seats OK', license_seats: 5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.license_seats, 5);
  const before = await count('assets');
  for (const bad of [2.5, 1e10, '2.5', -1, '-1', -1e10]) {
    const r = await admin.post('/api/assets', { name: 'Seats bad', license_seats: bad });
    assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /whole number/);
  }
  assert.equal((await admin.put(`/api/assets/${ok.body.id}`, { ...ok.body, license_seats: 1.5 })).status, 400);
  assert.equal(db.prepare('SELECT license_seats AS s FROM assets WHERE id = ?').get(ok.body.id).s, 5, 'the stored value is unchanged');
  assert.equal(await count('assets'), before);
});

test('(au) a CSV with a fractional or negative seats value is refused with its row number and imports nothing', async () => {
  const before = await count('assets');
  for (const bad of ['2.5', '-1']) {
    const csv = `name,seats\nGood One,3\nBad One,${bad}\n`;
    const r = await admin.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body: csv });
    assert.equal(r.status, 400, r.text);
    assert.match(r.body.error, /Row 3: .*whole number/, bad);
    assert.equal(await count('assets'), before, 'the good row was not imported either');
  }
});

test('(as)/(at) NUL characters are a 400 in a body, the URL, a login and a CSV', async () => {
  const before = await count('assets');
  assert.equal((await admin.post('/api/assets', { name: 'a\u0000b' })).status, 400);
  assert.equal((await admin.post('/api/assets', { name: 'fine', notes: ['x', { deep: 'y\u0000' }] })).status, 400);
  assert.equal((await admin.get('/api/assets?q=a%00b')).status, 400);
  assert.equal((await makeClient(server).post('/api/login', { email: 'ada\u0000@nutricost.com', password: 'x' })).status, 400);
  const csv = await admin.rawPost('/api/import/assets', { headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'fetch' }, body: 'name\nBad\u0000Name\n' });
  assert.equal(csv.status, 400);
  assert.equal(await count('assets'), before);
  assert.equal((await admin.get('/api/assets?q=ordinary')).status, 200, 'ordinary input is untouched');
});

test('deadlock (40P01) and serialization (40001) failures answer a retryable 503; other errors are unchanged', () => {
  const handler = app.router.stack[app.router.stack.length - 1].handle;
  const run = (err) => {
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const log = console.error; console.error = () => {};
    try { handler(err, {}, res, () => {}); } finally { console.error = log; }
    return res;
  };
  for (const code of ['40P01', '40001']) {
    const r = run(Object.assign(new Error('deadlock detected'), { code }));
    assert.equal(r.code, 503);
    assert.equal(r.body.retryable, true);
    assert.equal(r.headers['Retry-After'], '1');
    assert.doesNotMatch(r.body.error, /deadlock/);
  }
  assert.equal(run(new Error('boom')).code, 500);
  assert.equal(run(Object.assign(new Error('nope'), { status: 400 })).code, 400);
});

let seq = 0;
async function employee(name) {
  const created = await admin.post('/api/users', { name, email: `rc${++seq}@nutricost.com`, invite: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id };
}

test('(ah) resolve and dropped-off write the status and the activity row together; refusals write neither', async () => {
  const emp = await employee('RC Emp');
  const asset = (await admin.post('/api/assets', { name: 'Resolve Cam', available_to_request: true })).body;
  const acts = (action) => db.prepare('SELECT COUNT(*) AS n FROM activity WHERE action = ?').get(action).n;
  // an issue / return request made directly, as the employee routes would
  const req = db.prepare("INSERT INTO requests (type, user_id, asset_id, status) VALUES ('issue', ?, ?, 'open')");
  const issueId = req.run(emp.id, asset.id).lastInsertRowid;
  const before = acts('issue_resolved');
  assert.equal((await admin.post(`/api/requests/${issueId}/resolve`, { note: 'fixed' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(issueId).status, 'completed');
  assert.equal(acts('issue_resolved'), before + 1);
  assert.equal((await admin.post(`/api/requests/${issueId}/resolve`, {})).status, 400, 'already closed');
  assert.equal(acts('issue_resolved'), before + 1, 'a refusal writes no activity row');
  const retId = db.prepare("INSERT INTO requests (type, user_id, asset_id, status) VALUES ('return', ?, ?, 'open')").run(emp.id, asset.id).lastInsertRowid;
  const d0 = acts('dropped_off');
  assert.equal((await emp.client.post(`/api/requests/${retId}/dropped-off`, { note: 'left it' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(retId).status, 'dropped_off');
  assert.equal(acts('dropped_off'), d0 + 1);
  assert.equal((await emp.client.post(`/api/requests/${retId}/dropped-off`, {})).status, 400);
  assert.equal(acts('dropped_off'), d0 + 1);
});

test('(ah) a new request and its activity row are one write, and an asset archived meanwhile is refused', async () => {
  const emp = await employee('RC Emp Two');
  const asset = (await admin.post('/api/assets', { name: 'Request Cam', available_to_request: true })).body;
  const acts = () => db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'requested'").get().n;
  const a0 = acts();
  const made = await emp.client.post('/api/requests', { asset_id: asset.id, message: 'please' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(acts(), a0 + 1);
  // the module-level guard: the same call with the asset archived after the route's reads is refused and writes nothing
  db.prepare('UPDATE assets SET archived_at = ? WHERE id = ?').run('2026-01-01 00:00:00', asset.id);
  const r0 = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  await assert.rejects(data.requestRecords.createEquipmentRequest({
    forUser: emp.id, assetId: asset.id, category: null, message: 'late', neededBy: null, createdBy: null, wantedType: null, nodeId: null, catalogPath: null, assetLabel: null,
    recheck: { restrictToAvailable: false }, activity: { actorAccountId: null, details: 'late' },
  }), (e) => e.status === 400 && /archived/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, r0);
  assert.equal(acts(), a0 + 1);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photoForm = (caption) => { const fd = new FormData(); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'a.png'); fd.append('caption', caption); return fd; };
const files = (dir) => { try { return fs.readdirSync(path.join(process.env.DATA_DIR, dir)).filter((f) => !f.startsWith('.')); } catch { return []; } };
const settle = () => new Promise((r) => setTimeout(r, 300)); // (fs.rm of the temp upload is not awaited by the route)

test('(as) a NUL in a multipart photo caption is a 400 before any file or row is made, and the temp upload is removed', async () => {
  const asset = (await admin.post('/api/assets', { name: 'Photo Cam' })).body;
  const post = (caption) => admin.rawPost(`/api/assets/${asset.id}/photos`, { headers: { 'X-Requested-With': 'fetch' }, body: photoForm(caption) });
  const photos = () => db.prepare('SELECT COUNT(*) AS n FROM photos WHERE asset_id = ?').get(asset.id).n;
  const up0 = files('uploads').length;
  const bad = await post('nice\u0000caption');
  assert.equal(bad.status, 400, bad.text);
  await settle();
  assert.equal(photos(), 0, 'no photo row');
  assert.equal(files('uploads').length, up0, 'no permanent image file');
  assert.deepEqual(files('tmp'), [], 'the temporary upload was removed');
  const ok = await post('nice caption');
  assert.equal(ok.status, 200, ok.text);
  await settle();
  assert.equal(photos(), 1, 'a normal caption still works');
  assert.deepEqual(files('tmp'), []);
});
