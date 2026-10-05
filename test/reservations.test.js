// Asset Reservations V1 (Phase 2, slice 7): two per-asset admin settings (available_to_request, reservation_requires_approval), the
// reservations table and its rules, employee visibility, and the calendar/checkout integration. Everything here is enforced on the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const node = async (name, parent_id = null) => { const r = await admin.post('/api/catalog', { name, parent_id }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
// (new assets default to NOT employee-requestable; these helpers opt in unless a test says otherwise)
async function newAsset(name, { status, requestable = true, ...extra } = {}) {
  const r = await admin.post('/api/assets', { name, tag: `RS-${++seq}`, ...(requestable ? { available_to_request: true } : {}), ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (status) db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, r.body.id);
  return r.body;
}
async function makeLogin(name, { selfCheckout = true } = {}) {
  const created = await admin.post('/api/users', { name, email: `rs${++seq}@nutricost.com`, invite: true, department: 'Marketing' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  if (!selfCheckout) assert.equal((await admin.put(`/api/users/${created.body.id}/self-checkout`, { enabled: false })).status, 200);
  return { client, id: created.body.id, name };
}
const checkout = async (asset, who, extra = {}) => { const r = await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.assignment; };
const reserve = (who, asset, start, end) => who.client.post(`/api/assets/${asset.id}/reservations`, { start_date: start, end_date: end });
async function okReserve(who, asset, start, end) { const r = await reserve(who, asset, start, end); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const cal = (who, q = '') => who.get('/api/availability' + q);
const month = (d) => d.slice(0, 7);
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// the one asset's per-day states for a month, as an employee/admin sees them
async function dayStates(who, asset, m = month(TODAY)) {
  const r = await cal(who.client || who, `?asset=${asset.id}&month=${m}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.assets[0].days;
}
const stateOn = async (who, asset, date) => (await dayStates(who, asset, month(date)))[Number(date.slice(8)) - 1];

// ---------------------------------------------------------------- settings
test('new assets default to NOT available to request and NOT requiring reservation approval; existing assets are not silently exposed', async () => {
  const a = await newAsset('Defaults laptop', { requestable: false });
  assert.equal(a.available_to_request, 0);
  assert.equal(a.reservation_requires_approval, 0);
  const row = db.prepare('SELECT available_to_request, reservation_requires_approval FROM assets WHERE id = ?').get(a.id);
  assert.deepEqual({ ...row }, { available_to_request: 0, reservation_requires_approval: 0 });
});

test('migration 13 adds both settings as OFF for every existing asset and creates the reservations table with its CHECKs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-resv-mig-'));
  const d = new Database(path.join(dir, 'assets.db'));
  d.pragma('foreign_keys = ON');
  const { runMigrations } = require('../src/migrate');
  const all = require('../src/migrations');
  runMigrations(d, all.filter((m) => m.id <= 12));
  d.prepare("INSERT INTO assets (tag, name) VALUES ('OLD-1', 'Existing desk computer')").run();
  assert.deepEqual(runMigrations(d, all), [13]);
  assert.deepEqual({ ...d.prepare("SELECT available_to_request a, reservation_requires_approval r FROM assets WHERE tag = 'OLD-1'").get() }, { a: 0, r: 0 });
  const emp = d.prepare("INSERT INTO employees (name) VALUES ('E')").run().lastInsertRowid;
  const asset = d.prepare("SELECT id FROM assets").get().id;
  const ins = (status, extra = '') => d.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval${extra ? ', decided_at' : ''}) VALUES (?, ?, '2030-01-10', '2030-01-12', ?, ?${extra ? ", datetime('now')" : ''})`).run(asset, emp, status, status === 'pending' || status === 'declined' ? 1 : 0);
  assert.doesNotThrow(() => ins('confirmed'));
  assert.doesNotThrow(() => ins('pending'));
  assert.throws(() => ins('bogus'), /CHECK/);
  assert.throws(() => d.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, '2030-01-12', '2030-01-10', 'confirmed', 0)").run(asset, emp), /CHECK/, 'end before start');
  assert.throws(() => d.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, 'soon', '2030-01-10', 'confirmed', 0)").run(asset, emp), /CHECK/, 'dates are YYYY-MM-DD');
  assert.throws(() => d.prepare("UPDATE assets SET available_to_request = 2 WHERE id = ?").run(asset), /CHECK/);
  assert.throws(() => d.prepare('DELETE FROM assets WHERE id = ?').run(asset), /FOREIGN KEY/, 'history is RESTRICTed');
  d.close();
});

test('admins can set each setting on create and edit; invalid values are refused; employees cannot touch them', async () => {
  const me = await makeLogin('Settings Employee');
  const created = await admin.post('/api/assets', { name: 'Both on', tag: `RS-${++seq}`, available_to_request: true, reservation_requires_approval: true });
  assert.equal(created.status, 200);
  assert.deepEqual([created.body.available_to_request, created.body.reservation_requires_approval], [1, 1]);
  const id = created.body.id;
  let r = await admin.put(`/api/assets/${id}`, { reservation_requires_approval: false });
  assert.deepEqual([r.body.available_to_request, r.body.reservation_requires_approval], [1, 0], 'toggling one leaves the other alone');
  r = await admin.put(`/api/assets/${id}`, { available_to_request: false });
  assert.deepEqual([r.body.available_to_request, r.body.reservation_requires_approval], [0, 0]);
  r = await admin.put(`/api/assets/${id}`, { name: 'Renamed' });
  assert.deepEqual([r.body.available_to_request, r.body.reservation_requires_approval, r.body.name], [0, 0, 'Renamed'], 'an edit that does not mention the flags keeps them');
  assert.equal((await admin.put(`/api/assets/${id}`, { available_to_request: 'maybe' })).status, 400);
  assert.equal((await admin.put(`/api/assets/${id}`, { reservation_requires_approval: 7 })).status, 400);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE asset_id = ? AND action = 'edited' AND details LIKE '%available to request%'").get(id), 'the change is in the history');
  // employees: no create, no edit
  assert.equal((await me.client.post('/api/assets', { name: 'x', available_to_request: true })).status, 403);
  assert.equal((await me.client.put(`/api/assets/${id}`, { available_to_request: true })).status, 403);
  assert.equal(db.prepare('SELECT available_to_request a FROM assets WHERE id = ?').get(id).a, 0);
});

// ---------------------------------------------------------------- employee visibility
test('an asset that is NOT available to request is invisible to employees everywhere (browse, search, counts, calendar, direct access, scan) but not to admins', async () => {
  const me = await makeLogin('Visibility Viewer');
  const n = await node(`Vis ${++seq}`);
  const on = await newAsset('Vis shared camera', { catalog_node_id: n.id });
  const off = await newAsset('Vis hidden desktop', { catalog_node_id: n.id, requestable: false });
  const ids = (rows) => rows.map((r) => r.id);
  // list, catalog filter, search
  assert.ok(ids((await me.client.get('/api/assets')).body).includes(on.id), 'ON asset appears');
  assert.ok(!ids((await me.client.get('/api/assets')).body).includes(off.id));
  assert.deepEqual(ids((await me.client.get(`/api/assets?catalog_node=${n.id}`)).body), [on.id]);
  assert.deepEqual(ids((await me.client.get('/api/assets?q=Vis%20hidden')).body), []);
  assert.deepEqual(ids((await me.client.get(`/api/assets?q=${off.tag}`)).body), []);
  assert.deepEqual(ids((await admin.get(`/api/assets?catalog_node=${n.id}`)).body).sort(), [on.id, off.id].sort(), 'admins see both');
  // catalog counts: employees count only the shared pool
  const emp = (await me.client.get('/api/catalog')).body.find((x) => x.id === n.id);
  assert.equal(emp.available_count, 1);
  // calendar: not counted, not reachable
  const sum = await cal(me.client, `?node=${n.id}`);
  assert.equal(sum.body.total, 1);
  assert.equal((await cal(me.client, `?asset=${off.id}`)).status, 404);
  assert.equal((await cal(me.client, `?asset=${on.id}`)).status, 200);
  assert.equal((await cal(admin, `?node=${n.id}`)).body.total, 2, 'admin calendar counts both');
  // direct access and every acquisition path
  assert.equal((await me.client.get(`/api/assets/${off.id}`)).status, 404);
  assert.equal((await me.client.get(`/api/assets/${on.id}`)).status, 200);
  assert.deepEqual((await me.client.get(`/api/assets/lookup/${off.tag}`)).body, { found: false, unavailable: true, code: off.tag });
  assert.equal((await me.client.get(`/api/assets/lookup/${on.tag}`)).body.found, true);
  assert.equal((await me.client.post(`/api/assets/${off.id}/checkout`, { due_date: plus(3) })).status, 404, 'no self-checkout');
  assert.equal((await reserve(me, off, plus(2), plus(3))).status, 404, 'no reservation');
  assert.equal((await me.client.post('/api/requests', { asset_id: off.id, message: 'please' })).status, 404, 'no specific request');
  assert.equal((await me.client.get(`/api/assets/${off.id}`)).status, 404);
  assert.equal((await admin.get(`/api/assets/${off.id}`)).status, 200);
  // the flag, not the status, is what hides it: turning it on makes it appear, off hides it again
  assert.equal((await admin.put(`/api/assets/${off.id}`, { available_to_request: true })).status, 200);
  assert.ok(ids((await me.client.get('/api/assets')).body).includes(off.id));
  assert.equal((await admin.put(`/api/assets/${off.id}`, { available_to_request: false })).status, 200);
  assert.ok(!ids((await me.client.get('/api/assets')).body).includes(off.id));
});

test('equipment ASSIGNED to an employee stays theirs when it is not available to request: My Equipment, asset page, return request, history; nobody else can find it; it stays hidden after check-in', async () => {
  const holder = await makeLogin('Desk Holder');
  const other = await makeLogin('Other Employee');
  const n = await node(`Desk ${++seq}`);
  const desk = await newAsset('Assigned desk computer', { catalog_node_id: n.id, requestable: false });
  await checkout(desk, holder, { assignment_type: 'permanent' });
  // the holder: My Equipment, asset detail, return request
  const dash = (await holder.client.get('/api/dashboard')).body;
  assert.ok(dash.mine.some((m) => m.asset_id === desk.id && m.assignment_type === 'permanent'), 'in My Equipment');
  const detail = await holder.client.get(`/api/assets/${desk.id}`);
  assert.equal(detail.status, 200, 'can open it');
  assert.equal(detail.body.is_mine, true);
  assert.equal(detail.body.reserve.allowed, false, 'but it is not offered for reservation');
  assert.equal((await cal(holder.client, `?asset=${desk.id}`)).status, 200, "its own single-asset calendar is the holder's");
  const ret = await holder.client.post(`/api/assets/${desk.id}/my-return-request`, { message: 'upgrading' });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.equal(ret.body.type, 'return');
  assert.equal((await holder.client.post(`/api/assets/${desk.id}/return-notice`, {})).status, 200, 'and they can say they dropped it off');
  // not discoverable by the holder through shared-pool discovery either (it is not part of the pool)
  assert.ok(!(await holder.client.get('/api/assets')).body.some((a) => a.id === desk.id));
  assert.equal((await cal(holder.client, `?node=${n.id}`)).body.total, 0, "broad calendars never count hidden equipment, even the holder's own");
  // another employee cannot discover it anywhere
  assert.ok(!(await other.client.get('/api/assets')).body.some((a) => a.id === desk.id));
  assert.deepEqual((await other.client.get('/api/assets?q=Assigned%20desk')).body, []);
  assert.equal((await other.client.get(`/api/assets/${desk.id}`)).status, 404);
  assert.equal((await cal(other.client, `?asset=${desk.id}`)).status, 404);
  assert.equal((await cal(other.client, `?node=${n.id}`)).body.total, 0);
  assert.equal((await other.client.get('/api/catalog')).body.find((x) => x.id === n.id).available_count, 0);
  // IT checks it in: history keeps it for the former holder, and it stays hidden from everyone while the flag is off
  assert.equal((await admin.post(`/api/assets/${desk.id}/checkin`, {})).status, 200);
  const hist = (await holder.client.get(`/api/users/${holder.id}`)).body;
  assert.ok(hist.past.some((p) => p.asset_id === desk.id), 'History still lists it');
  for (const who of [holder, other]) {
    assert.ok(!(await who.client.get('/api/assets')).body.some((a) => a.id === desk.id), 'hidden from discovery after check-in');
    assert.equal((await who.client.get(`/api/assets/${desk.id}`)).status, 404);
    assert.equal((await cal(who.client, `?asset=${desk.id}`)).status, 404);
  }
});

// ---------------------------------------------------------------- automatic reservations
test('a valid reservation on an asset that does not need approval is confirmed immediately and blocks those dates (inclusive of both ends)', async () => {
  const a = await newAsset('Auto camera');
  const me = await makeLogin('Auto Reserver'); const other = await makeLogin('Auto Other');
  const start = plus(10); const end = plus(12);
  const r = await okReserve(me, a, start, end);
  assert.deepEqual([r.status, r.requires_approval, r.start_date, r.end_date, r.employee_id, r.mine, r.phase], ['confirmed', 0, start, end, me.id, true, 'upcoming']);
  // inclusive: start, middle and end are reserved; the days around it are not
  const around = [plus(9), start, plus(11), end, plus(13)];
  for (const m of new Set(around.map(month))) void m;
  const states = []; for (const d of around) states.push(await stateOn(other, a, d));
  assert.deepEqual(states, ['available', 'reserved', 'reserved', 'reserved', 'available']);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity WHERE asset_id = ? AND action = 'reserved'").get(a.id).c, 1);
  // another employee cannot take any overlapping range ...
  for (const [s, e] of [[start, end], [plus(9), start], [end, plus(14)], [plus(11), plus(11)], [plus(5), plus(20)]]) {
    const x = await reserve(other, a, s, e);
    assert.equal(x.status, 409, `${s}..${e}`);
    assert.match(x.body.error, /already reserved/i);
  }
  // ... but the day before and the day after are fine, and adjacent ranges can both be confirmed
  await okReserve(other, a, plus(8), plus(9));
  await okReserve(other, a, plus(13), plus(15));
  assert.equal((await reserve(me, a, plus(11), plus(11))).status, 409, 'and not even the owner twice');
});

test('a confirmed reservation shows up in the single-asset calendar (reserved days, anonymous for employees, with the holder for IT) and in broad counts as a figure, never a list', async () => {
  const n = await node(`Cal ${++seq}`);
  const a = await newAsset('Cal camera', { catalog_node_id: n.id });
  await newAsset('Cal spare', { catalog_node_id: n.id });
  const me = await makeLogin('Cal Reserver'); const other = await makeLogin('Cal Viewer');
  const start = plus(4); const end = plus(6);
  await okReserve(me, a, start, end);
  const m = month(start); const idx = Number(start.slice(8)) - 1;
  const mineView = (await cal(me.client, `?asset=${a.id}&month=${m}`)).body.assets[0];
  const otherView = (await cal(other.client, `?asset=${a.id}&month=${m}`)).body.assets[0];
  const adminView = (await cal(admin, `?asset=${a.id}&month=${m}`)).body.assets[0];
  for (const v of [mineView, otherView, adminView]) assert.equal(v.days[idx], 'reserved');
  assert.deepEqual(otherView.reservations.map((x) => [x.start, x.end, x.status, x.mine, x.id]), [[start, end, 'confirmed', false, undefined]], 'anonymous: no id, no name');
  assert.ok(!JSON.stringify(otherView).includes('Cal Reserver'));
  assert.equal(mineView.reservations[0].mine, true);
  assert.equal(adminView.reservations[0].holder.name, 'Cal Reserver');
  // broad scope: a count, no reservations list, no controls
  const emp = (await cal(other.client, `?node=${n.id}&month=${m}`)).body;
  assert.deepEqual(emp.days[idx], { available: 1, expected: 0, unavailable: 0, reserved: 1, off: 0 });
  const adm = (await cal(admin, `?node=${n.id}&month=${m}`)).body;
  assert.deepEqual(adm.days[idx], { available: 1, expected: 0, checked_out: 0, reserved: 1, off: 0 });
  for (const body of [emp, adm]) {
    assert.equal(body.view, 'summary');
    assert.equal(body.reservations, undefined, 'no reservation list at this level');
    assert.equal(body.reserve, undefined, 'and no reservation controls');
  }
  assert.equal(adm.assets, undefined, 'IT: counts + temporary checkouts');
  // an employee's entry calendar lists the assets (so they can pick one), but the reservation on it stays anonymous and Reserve is not offered there
  assert.deepEqual(emp.assets.map((x) => x.name).sort(), ['Cal camera', 'Cal spare']);
  const camRow = emp.assets.find((x) => x.name === 'Cal camera');
  assert.equal(camRow.days[idx], 'reserved');
  assert.deepEqual(camRow.reservations.map((x) => [x.start, x.end, x.mine, x.id]), [[start, end, false, undefined]]);
  assert.ok(!JSON.stringify(emp).includes('Cal Reserver'));
  assert.ok(emp.assets.every((x) => x.reserve.allowed === false));
  // only the single-asset view offers Reserve, and only to an employee who may use it
  assert.equal(mineView.reserve.allowed, true);
  assert.equal(adminView.reserve.allowed, false, 'IT does not reserve through this flow');
});

test('reservation dates: reversed, past, missing and malformed ranges are refused on the server; starting today and a single day are fine', async () => {
  const a = await newAsset('Dates camera');
  const me = await makeLogin('Dates Reserver');
  const bad = [[plus(5), plus(3)], [plus(-1), plus(2)], [plus(-3), plus(-2)], ['2026-02-30', plus(3)], ['soon', plus(3)], [plus(3), 'later'], [undefined, plus(3)], [plus(3), undefined], ['', '']];
  for (const [s, e] of bad) assert.equal((await reserve(me, a, s, e)).status, 400, `${s}..${e}`);
  assert.equal((await reserve(me, a, plus(3), '2101-01-01')).status, 400, 'absurdly far');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservations WHERE asset_id = ?').get(a.id).c, 0, 'nothing was written');
  const today = await okReserve(me, a, TODAY, TODAY);
  assert.equal(today.phase, 'active', 'starts today = active today');
  assert.equal(await stateOn(me, a, TODAY), 'reserved');
  const one = await okReserve(me, a, plus(7), plus(7));
  assert.equal(one.start_date, one.end_date);
  assert.equal((await me.client.post(`/api/assets/${a.id}/reservations`, {})).status, 400);
});

// ---------------------------------------------------------------- approval-required reservations
test('approval-required: the reservation is PENDING, does not block anyone, and IT can approve it', async () => {
  const a = await newAsset('Approval camera', { reservation_requires_approval: true });
  const me = await makeLogin('Approval Reserver'); const rival = await makeLogin('Approval Rival');
  const r = await okReserve(me, a, plus(20), plus(22));
  assert.deepEqual([r.status, r.requires_approval, r.phase], ['pending', 1, 'pending']);
  // pending is not a hold: the dates still read available, and someone else may also submit (also pending)
  assert.equal(await stateOn(rival, a, plus(21)), 'available');
  const rivalPending = await okReserve(rival, a, plus(21), plus(23));
  assert.equal(rivalPending.status, 'pending');
  // the owner sees their own pending request on the calendar; others do not
  const own = (await cal(me.client, `?asset=${a.id}&month=${month(plus(20))}`)).body.assets[0];
  assert.deepEqual(own.reservations.map((x) => [x.status, x.mine]), [['pending', true]]);
  const theirs = (await cal(rival.client, `?asset=${a.id}&month=${month(plus(20))}`)).body.assets[0];
  assert.deepEqual(theirs.reservations.map((x) => [x.status, x.mine]), [['pending', true]], 'a rival sees only their own pending one');
  // an employee cannot decide
  assert.equal((await me.client.post(`/api/reservations/${r.id}/approve`, {})).status, 403);
  assert.equal((await me.client.post(`/api/reservations/${r.id}/decline`, {})).status, 403);
  // IT approves: confirmed now, and it blocks
  const ok = await admin.post(`/api/reservations/${r.id}/approve`, { note: 'Enjoy' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.status, ok.body.decision_note, ok.body.decided_by_name], ['confirmed', 'Enjoy', 'Ada Admin']);
  assert.equal(await stateOn(rival, a, plus(21)), 'reserved');
  assert.equal((await admin.post(`/api/reservations/${r.id}/approve`, {})).status, 400, 'cannot be approved twice');
});

test('approval re-checks the WHOLE range at approval time: a conflict prevents approval cleanly, and an existing confirmed reservation is never overridden', async () => {
  const a = await newAsset('Recheck camera', { reservation_requires_approval: true });
  const first = await makeLogin('Recheck First'); const second = await makeLogin('Recheck Second');
  const p1 = await okReserve(first, a, plus(30), plus(32));
  const p2 = await okReserve(second, a, plus(31), plus(33)); // overlaps p1; both are pending, so both are accepted at submission
  assert.equal((await admin.post(`/api/reservations/${p1.id}/approve`, {})).status, 200);
  const clash = await admin.post(`/api/reservations/${p2.id}/approve`, {});
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /can't approve.*already reserved/i);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(p2.id).status, 'pending', 'it stays pending for IT to decline');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(p1.id).status, 'confirmed', 'the confirmed one is untouched');
  assert.equal((await admin.post(`/api/reservations/${p2.id}/decline`, { note: 'Dates taken' })).status, 200);
  assert.equal((await admin.post(`/api/reservations/${p2.id}/approve`, {})).status, 400, 'a declined one cannot be approved');
  // a checkout that now occupies the dates also blocks approval
  const loaned = await newAsset('Recheck loaned camera', { reservation_requires_approval: true });
  const p3 = await okReserve(second, loaned, plus(40), plus(41));
  const holder = await makeLogin('Recheck Holder');
  await checkout(loaned, holder, { assignment_type: 'checkout', due_date: plus(41) }); // a PENDING reservation never blocks this
  const out = await admin.post(`/api/reservations/${p3.id}/approve`, {});
  assert.equal(out.status, 409);
  assert.match(out.body.error, /checked out/i);
  // a start date that has already passed cannot be approved
  const old = db.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, ?, ?, 'pending', 1)").run(a.id, second.id, plus(-2), plus(2)).lastInsertRowid;
  assert.equal((await admin.post(`/api/reservations/${old}/approve`, {})).status, 409);
  // turning "available to request" off before approval also stops it
  const b = await newAsset('Recheck off camera', { reservation_requires_approval: true });
  const pb = await okReserve(first, b, plus(50), plus(51));
  await admin.put(`/api/assets/${b.id}`, { available_to_request: false });
  assert.equal((await admin.post(`/api/reservations/${pb.id}/approve`, {})).status, 409);
});

test('the approval setting is a snapshot per reservation and per asset (no global rule)', async () => {
  const strict = await newAsset('Snapshot strict', { reservation_requires_approval: true });
  const lax = await newAsset('Snapshot lax');
  const me = await makeLogin('Snapshot Reserver');
  const p = await okReserve(me, strict, plus(60), plus(61));
  const c = await okReserve(me, lax, plus(60), plus(61));
  assert.deepEqual([p.status, c.status], ['pending', 'confirmed']);
  await admin.put(`/api/assets/${strict.id}`, { reservation_requires_approval: false });
  assert.deepEqual([db.prepare('SELECT status, requires_approval r FROM reservations WHERE id = ?').get(p.id).status, db.prepare('SELECT requires_approval r FROM reservations WHERE id = ?').get(p.id).r], ['pending', 1], 'the pending one still needs IT');
  const later = await okReserve(me, strict, plus(70), plus(71));
  assert.equal(later.status, 'confirmed', 'new ones follow the new setting');
});

// ---------------------------------------------------------------- conflicts with the rest of the model
test('what cannot be reserved: not-requestable, archived, repair/retired/lost/disposed, multi-seat licenses, and days an assignment occupies', async () => {
  const me = await makeLogin('Block Reserver');
  const off = await newAsset('Block off', { requestable: false });
  assert.equal((await reserve(me, off, plus(5), plus(6))).status, 404);
  for (const status of ['maintenance', 'retired', 'lost', 'disposed']) {
    const a = await newAsset(`Block ${status}`, { status });
    const r = await reserve(me, a, plus(5), plus(6));
    assert.ok([400, 404].includes(r.status), `${status}: ${r.status}`);
    // the server rule itself (an employee can't even see most of these, so check it directly as well)
    const rules = require('../src/reservations');
    assert.equal(rules.reserveEligibility(db.prepare('SELECT * FROM assets WHERE id = ?').get(a.id)).ok, false, status);
  }
  const arch = await newAsset('Block archived');
  assert.equal((await admin.post(`/api/assets/${arch.id}/archive`, {})).status, 200);
  assert.ok([400, 404].includes((await reserve(me, arch, plus(5), plus(6))).status));
  const seats = await newAsset('Block seats', { license_seats: 3 });
  const s = await reserve(me, seats, plus(5), plus(6));
  assert.equal(s.status, 400);
  assert.match(s.body.error, /single physical/i);
  // an admin cannot be used to slip past either: the rules are in the module, not the route
  const rules = require('../src/reservations');
  assert.throws(() => rules.create(db, { assetId: off.id, employeeId: me.id, actorAccountId: null, start: plus(5), end: plus(6) }), /not found/i);
});

test('a permanent assignment blocks every day; a temporary checkout blocks through its due date (inclusive) but the days AFTER it may be reserved; overdue blocks everything', async () => {
  const me = await makeLogin('Occupied Reserver'); const holder = await makeLogin('Occupied Holder');
  const perm = await newAsset('Occ permanent');
  await checkout(perm, holder, { assignment_type: 'permanent' });
  const r1 = await reserve(me, perm, plus(5), plus(6));
  assert.equal(r1.status, 409, 'a permanently held asset is occupied on every day (it is also left out of every broad calendar)');
  assert.match(r1.body.error, /checked out/i);
  const rules = require('../src/reservations');
  assert.throws(() => rules.create(db, { assetId: perm.id, employeeId: me.id, actorAccountId: null, start: plus(5), end: plus(6) }), /checked out/i);

  const loan = await newAsset('Occ loan');
  await checkout(loan, holder, { assignment_type: 'checkout', due_date: plus(5) });
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(loan.id);
  const create = (s, e) => { try { return rules.create(db, { assetId: loan.id, employeeId: me.id, actorAccountId: null, start: s, end: e }); } catch (e2) { return e2; } };
  void row;
  assert.equal(create(plus(2), plus(3)).status, 409, 'while it is out');
  assert.equal(create(plus(5), plus(7)).status, 409, 'the due date itself is still out');
  const after = create(plus(6), plus(8));
  assert.equal(after.status, 'confirmed', 'the day after the due date is only "expected back", so it can be reserved');
  assert.equal(await stateOn(me, loan, plus(6)), 'reserved', 'and the calendar says reserved there, not expected');
  assert.equal(await stateOn(admin, loan, plus(5)), 'occupied', 'but a physical checkout still wins on its own days');

  const late = await newAsset('Occ overdue');
  await checkout(late, holder, { assignment_type: 'checkout', due_date: plus(3) });
  db.prepare('UPDATE assignments SET due_date = ? WHERE asset_id = ?').run(plus(-2), late.id);
  assert.throws(() => rules.create(db, { assetId: late.id, employeeId: me.id, actorAccountId: null, start: plus(10), end: plus(11) }), /checked out/i);
});

test('Reserve does NOT depend on the self-checkout permission (that governs "Check out now" only); the asset\'s own eligibility still does', async () => {
  const auto = await newAsset('Perm reserve camera');
  const strict = await newAsset('Perm reserve strict', { reservation_requires_approval: true });
  const hidden = await newAsset('Perm reserve hidden', { requestable: false });
  const noSelf = await makeLogin('No Self Checkout', { selfCheckout: false });
  // sanity: this person really cannot check out now
  const co = await noSelf.client.post(`/api/assets/${auto.id}/checkout`, { due_date: plus(2) });
  assert.equal(co.status, 403);
  assert.match(co.body.error, /Self-checkout is not enabled/i);
  // ... but can reserve: confirmed right away, or pending approval, per the ASSET
  const r = await reserve(noSelf, auto, plus(5), plus(6));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'confirmed');
  const p = await reserve(noSelf, strict, plus(5), plus(6));
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.status, 'pending');
  // the UI is told Reserve is offered, on the asset page and on the single-asset calendar
  assert.equal((await noSelf.client.get(`/api/assets/${auto.id}`)).body.reserve.allowed, true);
  assert.equal((await cal(noSelf.client, `?asset=${auto.id}`)).body.assets[0].reserve.allowed, true);
  // the rest of the eligibility is unchanged: not available to request, repair, multi-seat, archived => still refused
  assert.equal((await reserve(noSelf, hidden, plus(5), plus(6))).status, 404);
  assert.equal((await noSelf.client.get(`/api/assets/${hidden.id}`)).status, 404);
  const seats = await newAsset('Perm reserve seats', { license_seats: 2 });
  assert.equal((await reserve(noSelf, seats, plus(5), plus(6))).status, 400);
  const repair = await newAsset('Perm reserve repair', { status: 'maintenance' });
  assert.ok([400, 404].includes((await reserve(noSelf, repair, plus(5), plus(6))).status));
  assert.equal((await noSelf.client.get(`/api/assets/${seats.id}`)).body.reserve.allowed, false);
  // an employee WITH the permission is unaffected, and an admin is still not offered the employee flow
  const withSelf = await makeLogin('With Self Checkout');
  assert.equal((await reserve(withSelf, auto, plus(8), plus(9))).status, 200);
  assert.equal((await withSelf.client.post(`/api/assets/${strict.id}/checkout`, { due_date: plus(2) })).status, 200, 'and can still check out now');
  assert.equal((await admin.get(`/api/assets/${auto.id}`)).body.reserve.allowed, false);
  // the rule is in the module too, not only the routes
  const rules = require('../src/reservations');
  const other = await makeLogin('Module Caller', { selfCheckout: false });
  assert.equal(rules.create(db, { assetId: auto.id, employeeId: other.id, actorAccountId: null, start: plus(20), end: plus(21) }).status, 'confirmed');
});

// ---------------------------------------------------------------- managing reservations
test('an employee can cancel their own reservation; nobody else (employee) can; the dates free up immediately; IT can cancel any', async () => {
  const a = await newAsset('Cancel camera');
  const me = await makeLogin('Cancel Owner'); const other = await makeLogin('Cancel Other');
  const r = await okReserve(me, a, plus(15), plus(17));
  assert.equal((await other.client.post(`/api/reservations/${r.id}/cancel`, {})).status, 403);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'confirmed');
  assert.equal(await stateOn(other, a, plus(16)), 'reserved');
  const c = await me.client.post(`/api/reservations/${r.id}/cancel`, {});
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.status, c.body.phase, c.body.can_cancel], ['cancelled', 'cancelled', false]);
  assert.equal(await stateOn(other, a, plus(16)), 'available', 'freed at once');
  await okReserve(other, a, plus(15), plus(17)); // and someone else can now have those dates
  assert.equal((await me.client.post(`/api/reservations/${r.id}/cancel`, {})).status, 400, 'already closed');
  const theirs = db.prepare("SELECT id FROM reservations WHERE employee_id = ? AND status = 'confirmed'").get(other.id).id;
  const byIt = await admin.post(`/api/reservations/${theirs}/cancel`, {});
  assert.equal(byIt.status, 200);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE asset_id = ? AND action = 'reservation_cancelled' AND details LIKE '%cancelled by IT%'").get(a.id));
  assert.equal((await me.client.post('/api/reservations/999999/cancel', {})).status, 404);
  // a pending one can be withdrawn too
  const strict = await newAsset('Cancel strict', { reservation_requires_approval: true });
  const p = await okReserve(me, strict, plus(15), plus(16));
  assert.equal((await me.client.post(`/api/reservations/${p.id}/cancel`, {})).status, 200);
  assert.equal((await admin.post(`/api/reservations/${p.id}/approve`, {})).status, 400, 'a cancelled request cannot be approved');
  // IT cannot CANCEL a pending reservation (it declines it); a confirmed one it can; the employee withdrawing their own pending one is fine
  const q = await okReserve(me, strict, plus(30), plus(31));
  const adminCancel = await admin.post(`/api/reservations/${q.id}/cancel`, {});
  assert.equal(adminCancel.status, 400);
  assert.match(adminCancel.body.error, /Decline it instead/);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(q.id).status, 'pending', 'unchanged');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity WHERE asset_id = ? AND action = 'reservation_cancelled' AND details LIKE ?").get(strict.id, `%${fmtDay(plus(30))}%`).c, 0, 'nothing was logged');
  const declined = await admin.post(`/api/reservations/${q.id}/decline`, { note: 'Not that week' });
  assert.equal(declined.status, 200, 'decline is the way');
  assert.equal(declined.body.decision_note, 'Not that week', 'notes still work');
  const q2 = await okReserve(me, strict, plus(30), plus(31));
  assert.equal((await admin.post(`/api/reservations/${q2.id}/approve`, {})).status, 200);
  assert.equal((await admin.post(`/api/reservations/${q2.id}/cancel`, {})).status, 200, 'once confirmed, IT may cancel it');
  const q3 = await okReserve(me, strict, plus(30), plus(31));
  assert.equal((await other.client.post(`/api/reservations/${q3.id}/cancel`, {})).status, 403, 'another employee still cannot');
  assert.equal((await me.client.post(`/api/reservations/${q3.id}/cancel`, {})).status, 200, 'the owner can withdraw their own pending request');
});

test('an employee can shorten the END of their own confirmed reservation; never extend, never move the start; freed days become available', async () => {
  const a = await newAsset('Shorten camera');
  const me = await makeLogin('Shorten Owner'); const other = await makeLogin('Shorten Other');
  const r = await okReserve(me, a, plus(10), plus(14));
  assert.equal((await other.client.post(`/api/reservations/${r.id}/shorten`, { end_date: plus(12) })).status, 403);
  assert.equal(await stateOn(other, a, plus(14)), 'reserved');
  const s = await me.client.post(`/api/reservations/${r.id}/shorten`, { end_date: plus(12) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.start_date, s.body.end_date], [plus(10), plus(12)]);
  assert.equal(await stateOn(other, a, plus(12)), 'reserved', 'the new end day is still held');
  assert.equal(await stateOn(other, a, plus(13)), 'available', 'the removed days are free at once');
  await okReserve(other, a, plus(13), plus(14));
  // not extend, not same, not before the start, not invalid
  for (const [end, re] of [[plus(13), /only shorten/i], [plus(12), /already the end/i], [plus(9), /can't be before the start/i], ['nope', /valid end date/i], [undefined, /valid end date/i]]) {
    const x = await me.client.post(`/api/reservations/${r.id}/shorten`, { end_date: end });
    assert.equal(x.status, 400, String(end));
    assert.match(x.body.error, re);
  }
  assert.equal(db.prepare('SELECT start_date s, end_date e FROM reservations WHERE id = ?').get(r.id).e, plus(12));
  // shortening to the start day itself is allowed (a single day)
  assert.equal((await me.client.post(`/api/reservations/${r.id}/shorten`, { end_date: plus(10) })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE asset_id = ? AND action = 'reservation_shortened'").get(a.id));
  // only a CONFIRMED reservation can be shortened
  const strict = await newAsset('Shorten strict', { reservation_requires_approval: true });
  const p = await okReserve(me, strict, plus(20), plus(25));
  const px = await me.client.post(`/api/reservations/${p.id}/shorten`, { end_date: plus(22) });
  assert.equal(px.status, 400);
  assert.match(px.body.error, /waiting for IT/i);
  // an in-progress reservation can be shortened, but not into the past
  const live = db.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, ?, ?, 'confirmed', 0)").run((await newAsset('Shorten live')).id, me.id, plus(-2), plus(4)).lastInsertRowid;
  assert.equal((await me.client.post(`/api/reservations/${live}/shorten`, { end_date: plus(-1) })).status, 400);
  assert.equal((await me.client.post(`/api/reservations/${live}/shorten`, { end_date: TODAY })).status, 200);
});

test('reservation lists: an employee sees only their own (with server-computed actions); IT sees everyone with names; filters work', async () => {
  const a = await newAsset('List camera'); const strict = await newAsset('List strict', { reservation_requires_approval: true });
  const me = await makeLogin('List Owner'); const other = await makeLogin('List Other');
  const mine = await okReserve(me, a, plus(80), plus(82));
  const pend = await okReserve(other, strict, plus(80), plus(81));
  const empRows = (await me.client.get('/api/reservations')).body;
  assert.ok(empRows.some((r) => r.id === mine.id));
  assert.ok(!empRows.some((r) => r.id === pend.id), "not someone else's");
  assert.ok(empRows.every((r) => r.employee_id === me.id));
  const row = empRows.find((r) => r.id === mine.id);
  assert.deepEqual([row.asset_name, row.asset_tag, row.can_cancel, row.can_shorten, row.phase], ['List camera', a.tag, true, true, 'upcoming']);
  assert.equal(row.employee_department, undefined, 'employees get no extra people-data');
  const adm = (await admin.get('/api/reservations?status=open')).body;
  assert.ok([mine.id, pend.id].every((id) => adm.some((r) => r.id === id)));
  assert.equal(adm[0].status, 'pending', 'pending approvals come first');
  assert.equal(adm.find((r) => r.id === pend.id).employee_name, 'List Other');
  await me.client.post(`/api/reservations/${mine.id}/cancel`, {});
  assert.ok(!(await me.client.get('/api/reservations?status=open')).body.some((r) => r.id === mine.id));
  assert.ok((await me.client.get('/api/reservations?status=closed')).body.some((r) => r.id === mine.id));
  assert.equal((await me.client.get('/api/reservations?status=bogus')).status, 400);
  assert.equal((await makeClient(server).get('/api/reservations')).status, 401);
  // the asset page: an employee gets only their own; IT gets all
  const strictMine = await okReserve(me, strict, plus(90), plus(91));
  assert.deepEqual((await me.client.get(`/api/assets/${strict.id}`)).body.reservations.map((r) => r.id), [strictMine.id]);
  assert.equal((await admin.get(`/api/assets/${strict.id}`)).body.reservations.length, 2);
});

// ---------------------------------------------------------------- Check out now
test('"Check out now" respects another employee\'s confirmed reservation (any day it would still be out), but not before it starts; the owner is not blocked; IT must cancel first', async () => {
  const a = await newAsset('Checkout camera');
  const owner = await makeLogin('Checkout Owner'); const rival = await makeLogin('Checkout Rival');
  await okReserve(owner, a, plus(3), plus(5));
  // rival wants it now, returning on day 4: that runs into the reservation
  const clash = await rival.client.post(`/api/assets/${a.id}/checkout`, { due_date: plus(4) });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /reserved .* so it can't be checked out/i);
  assert.match(clash.body.error, /earlier return date/i);
  assert.equal((await rival.client.post(`/api/assets/${a.id}/checkout`, { due_date: plus(3) })).status, 409, 'returning on the first reserved day still clashes');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL').get(a.id).c, 0, 'nothing was created');
  // IT is held to the same rule, with advice
  const it = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: rival.id, assignment_type: 'checkout', due_date: plus(4) });
  assert.equal(it.status, 409);
  assert.match(it.body.error, /Cancel the reservation first/);
  const perm = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: rival.id, assignment_type: 'permanent' });
  assert.equal(perm.status, 409, 'a permanent assignment has no end, so it runs into the reservation too');
  // before the reservation starts is fine
  const early = await rival.client.post(`/api/assets/${a.id}/checkout`, { due_date: plus(2) });
  assert.equal(early.status, 200, JSON.stringify(early.body));
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  // the owner is not blocked by their own reservation
  const mine = await owner.client.post(`/api/assets/${a.id}/checkout`, { due_date: plus(5) });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  // a reservation that happens to be TODAY blocks today's checkout for everyone else
  const b = await newAsset('Checkout today camera');
  await okReserve(owner, b, TODAY, plus(1));
  assert.equal((await rival.client.post(`/api/assets/${b.id}/checkout`, { due_date: plus(7) })).status, 409);
  // cancelling the reservation releases it
  const resv = db.prepare("SELECT id FROM reservations WHERE asset_id = ?").get(b.id).id;
  assert.equal((await owner.client.post(`/api/reservations/${resv}/cancel`, {})).status, 200);
  assert.equal((await rival.client.post(`/api/assets/${b.id}/checkout`, { due_date: plus(7) })).status, 200);
  // and a PENDING reservation never blocks a checkout
  const c = await newAsset('Checkout pending camera', { reservation_requires_approval: true });
  await okReserve(owner, c, TODAY, plus(3));
  assert.equal((await rival.client.post(`/api/assets/${c.id}/checkout`, { due_date: plus(2) })).status, 200);
});

test('self-checkout of an asset that is not available to request is refused even if the asset id is known; IT can still assign it', async () => {
  const off = await newAsset('Selfcheckout hidden', { requestable: false });
  const me = await makeLogin('Selfcheckout Employee');
  assert.equal((await me.client.post(`/api/assets/${off.id}/checkout`, { due_date: plus(2) })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?').get(off.id).c, 0);
  await checkout(off, me, { assignment_type: 'checkout', due_date: plus(2) }); // IT may
  // the rule is also in the assignment code itself, not only the route
  const { createAssignment } = require('../src/assignments');
  const spare = await newAsset('Selfcheckout hidden 2', { requestable: false });
  assert.throws(() => createAssignment(db, { assetId: spare.id, employeeId: me.id, actorAccountId: null, actorIsAdmin: false, type: 'checkout', dueDate: plus(2) }), /not found/i);
});

// ---------------------------------------------------------------- hardening
test('reservation endpoints need a sign-in, a same-origin header, and refuse bad ids', async () => {
  const a = await newAsset('Hardening camera');
  const anon = makeClient(server);
  assert.equal((await anon.post(`/api/assets/${a.id}/reservations`, { start_date: plus(2), end_date: plus(3) })).status, 401, 'sign-in required');
  for (const path of ['approve', 'decline', 'cancel', 'shorten']) assert.equal((await anon.post(`/api/reservations/1/${path}`, {})).status, 401, path);
  const noHeader = await makeLogin('No Header');
  assert.equal((await noHeader.client.rawPost(`/api/assets/${a.id}/reservations`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start_date: plus(2), end_date: plus(3) }) })).status, 403, 'the same-origin header is required');
  const me = await makeLogin('Hardening Employee');
  assert.equal((await me.client.post('/api/assets/999999/reservations', { start_date: plus(2), end_date: plus(3) })).status, 404);
  assert.equal((await admin.post('/api/reservations/999999/approve', {})).status, 404);
  assert.equal((await admin.post('/api/reservations/abc/approve', {})).status, 404);
});

test('every reservation write runs inside one IMMEDIATE transaction that re-reads what it depends on (the only protection against two writers claiming the same dates)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'reservations.js'), 'utf8');
  for (const fn of ['create', 'approve', 'decline', 'cancel', 'shorten']) {
    const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf('\n}\n', src.indexOf(`function ${fn}(`)));
    assert.match(body, /db\.transaction\(\(\) => \{/, fn);
    assert.match(body, /\}\)\.immediate\(\);/, `${fn} is BEGIN IMMEDIATE`);
  }
  const assign = fs.readFileSync(path.join(__dirname, '..', 'src', 'assignments.js'), 'utf8');
  assert.match(assign, /FROM reservations WHERE asset_id = \? AND status = 'confirmed'/, 'checkout checks reservations inside its own immediate transaction');
  // sequential proof of the invariant: two confirmed reservations can never overlap through the API
  return (async () => {
    const a = await newAsset('Race camera');
    const x = await makeLogin('Race X'); const y = await makeLogin('Race Y');
    const results = await Promise.all([reserve(x, a, plus(100), plus(103)), reserve(y, a, plus(102), plus(105))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ? AND status = 'confirmed'").get(a.id).c, 1);
  })();
});

test('front end: Reserve and the reservation tools exist only where they belong', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const view = src.slice(src.indexOf('async function viewCalendar()'), src.indexOf('// ============================================================ people'));
  // the summary (category / everything) panel never carries reservation controls
  const summary = view.slice(view.indexOf('const summaryPanel ='), view.indexOf('const nDays ='));
  assert.doesNotMatch(summary, /<button|resv-|Reserve this|data-resv/, 'broad calendars stay read-only: no reservation control anywhere in the count panel, the asset list or the admin list');
  // the single-asset panel offers it only when the server says so
  assert.match(view, /A\[0\]\.reserve && A\[0\]\.reserve\.allowed/);
  assert.match(view, /\/reservations`/);
});

test('front end: employee Browse starts on All equipment for real (selected AND listed, no click), and "Send IT a request" is a button using the unchanged request flow', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const browse = src.slice(src.indexOf('async function viewBrowse()'), src.indexOf('// ============================================================ asset detail'));
  // the root is "All equipment" by default: initial state, derived on every URL read, always drawn selected, list loaded for it
  assert.match(browse, /everything: true, token: 0/);
  assert.match(browse, /st\.everything = !st\.path\.length/);
  assert.match(browse, /attrs: 'data-everything', name: 'All equipment', meta: 'Everything available', kind: 'all on'/);
  assert.doesNotMatch(browse, /box\.hidden = true/, 'the list is never left hidden at the root');
  assert.match(browse, /else label = 'All equipment';/, 'the root lists All equipment through the same /api/assets call');
  assert.doesNotMatch(browse, /hashFor\(null, !st\.everything\)/, 'clicking the selected card no longer toggles the list off');
  assert.match(browse, /if \(e\.target\.closest\('\[data-everything\]'\)\) return;/);
  assert.match(browse, /const hashFor = \(id\) => '#\/assets' \+ \(id \? `\?node=\$\{id\}` : ''\);/, 'back to the root is the plain #/assets');
  // category navigation is untouched
  assert.match(browse, /else if \(card\) target = hashFor\(Number\(card\.dataset\.id\)\)/);
  assert.match(browse, /else if \(crumb\) target = hashFor\(/);
  // the request CTA: real buttons (footer + empty state), no tiny inline link, same sheet
  assert.doesNotMatch(browse, /<a href="#" id="reqlink">/);
  assert.equal((browse.match(/<button type="button" class="btn" data-reqit>/g) || []).length, 2, 'footer and empty state');
  assert.equal((browse.match(/onclick = \(\) => requestEquipmentSheet\(\)/g) || []).length, 2, 'both open the existing request sheet');
  assert.match(browse, /\$\('#reqfoot'\)\.hidden = !list\.length/, 'the footer button steps aside when the empty state already has one');
});

test('front end: the asset page offers Reserve next to either "Check out now" or "Request this" (it does not depend on self-checkout permission)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const asset = src.slice(src.indexOf('async function viewAsset(id)'), src.indexOf('const kv = ['));
  assert.match(asset, /id="act-self"/);
  assert.match(asset, /id="act-request"/);
  assert.match(asset, /actions = `<div class="actions">\$\{primary\}\$\{canReserve \? `<button class="btn lg" id="act-reserve">/);
  assert.match(asset, /const canReserve = !!\(d\.reserve && d\.reserve\.allowed\)/, 'Reserve follows only the server\'s answer');
  assert.doesNotMatch(asset.slice(asset.indexOf('const canReserve')), /canReserve\s*=.*can_self_checkout/);
});

test('front end: a picked range is one block: every day light violet, first and last day strong violet, with an accessible focus ring', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.cal-day\.inrange \{ background: var\(--resv-range\); color: var\(--resv-range-ink\); \}/);
  assert.match(css, /\.cal-day\.edge \{ background: var\(--resv\); color: var\(--resv-edge-ink\); \}/);
  assert.ok(css.indexOf('.cal-day.inrange {') < css.indexOf('.cal-day.edge {'), 'the strong end days win over the light fill');
  assert.match(css, /\.cal-day\.sel \{[^}]*box-shadow/, 'the viewed-day ring stays');
  assert.doesNotMatch(css.match(/\.cal-day\.sel \{[^}]*\}/)[0], /background/, 'the ring never replaces the range fill');
  assert.match(css, /\.cal-day:focus-visible \{ outline: 2px solid var\(--text\)/, 'keyboard focus stays visible');
  assert.match(css, /--resv-range: #[0-9a-f]{6};[^\n]*\n/, 'light-theme tokens');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{[\s\S]*--resv-range: #[0-9a-f]{6}; --resv-range-ink/, 'dark-theme tokens');
});

test('an employee can reserve FUTURE days of an item someone else has out right now (the category-calendar bridge), without that opening the asset page', async () => {
  const camera = await newAsset('Bridge camera');
  const holder = await makeLogin('Bridge Holder'); const me = await makeLogin('Bridge Reserver');
  await checkout(camera, holder, { assignment_type: 'checkout', due_date: plus(5) });
  // visible in the calendar and reservable for days after its return date ...
  assert.equal((await cal(me.client, `?asset=${camera.id}`)).status, 200);
  assert.equal((await cal(me.client, `?asset=${camera.id}`)).body.assets[0].reserve.allowed, true);
  const during = await reserve(me, camera, plus(3), plus(7));
  assert.equal(during.status, 409, 'not on days it is out');
  const after = await reserve(me, camera, plus(6), plus(8));
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.status, 'confirmed');
  // ... but the existing contract stands: the asset page / record of an item someone else holds is still not theirs
  assert.equal((await me.client.get(`/api/assets/${camera.id}`)).status, 404);
  assert.ok(!(await me.client.get('/api/assets')).body.some((a) => a.id === camera.id), 'and Browse still lists only what is available now');
  // the pool rules still apply: not in the shared pool / repair / archived are refused (not found)
  const off = await newAsset('Bridge off', { requestable: false });
  await checkout(off, holder, { assignment_type: 'checkout', due_date: plus(5) });
  assert.equal((await reserve(me, off, plus(6), plus(7))).status, 404);
  const repair = await newAsset('Bridge repair', { status: 'maintenance' });
  assert.equal((await reserve(me, repair, plus(6), plus(7))).status, 404, 'in repair: not part of what employees may see');
});

test('front end: a pending reservation offers IT only Approve (primary, no icon) and Decline (red); Cancel appears once it is confirmed; employees can still withdraw their own pending one', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('const isoAdd ='), src.indexOf('function shortenSheet('));
  const ctx = { esc: (v) => String(v ?? ''), fmtDate: (d) => d, srcQ: () => '', icon: (n) => `<svg data-icon="${n}"></svg>`, pill: (k, l) => `<span class="pill ${k}">${l}</span>` };
  vm.createContext(ctx);
  vm.runInContext(`${block}; this.reservationItem = reservationItem;`, ctx);
  const row = { id: 7, asset_id: 3, asset_name: 'Sony FX3', asset_tag: 'NC-1', employee_name: 'Casey', start_date: '2030-01-10', end_date: '2030-01-12', requires_approval: 1, decision_note: null };
  const buttons = (html) => [...html.matchAll(/<button class="([^"]*)" (data-resv-[a-z]+)="\d+">([\s\S]*?)<\/button>/g)].map((m) => ({ cls: m[1], act: m[2], label: m[3].trim() }));
  // IT, pending (even though the server says the row can be cancelled)
  const pending = buttons(ctx.reservationItem({ ...row, phase: 'pending', status: 'pending', can_cancel: true, mine: false }, { admin: true }));
  assert.deepEqual(pending.map((b) => [b.act, b.label]), [['data-resv-approve', 'Approve'], ['data-resv-decline', 'Decline']], 'Approve | Decline only: no Cancel, no icon');
  assert.match(pending[0].cls, /\bprimary\b/);
  assert.match(pending[1].cls, /\bdanger\b/);
  assert.doesNotMatch(ctx.reservationItem({ ...row, phase: 'pending', status: 'pending', can_cancel: true }, { admin: true }), /data-icon="check"|Cancel/);
  // IT, confirmed: Cancel reservation is there
  const live = buttons(ctx.reservationItem({ ...row, phase: 'upcoming', status: 'confirmed', can_cancel: true, mine: false }, { admin: true }));
  assert.deepEqual(live.map((b) => b.label), ['Cancel reservation']);
  // the employee's own pending request can still be withdrawn; their confirmed one can be cancelled and shortened
  assert.deepEqual(buttons(ctx.reservationItem({ ...row, phase: 'pending', status: 'pending', can_cancel: true, mine: true }, { admin: false })).map((b) => b.label), ['Cancel']);
  assert.deepEqual(buttons(ctx.reservationItem({ ...row, phase: 'upcoming', status: 'confirmed', can_cancel: true, can_shorten: true, mine: true }, { admin: false })).map((b) => b.label), ['Cancel', 'Shorten']);
  // and the server enforces the same split (IT declines a pending reservation; it cannot cancel it)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'reservations.js'), 'utf8'), /if \(!LIVE\.includes\(r\.status\)\) throw httpError\(400, 'This reservation is already closed\.'\)/);
});
