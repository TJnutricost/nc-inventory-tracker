// Slice 8.1 correction: unavailable time is WAITLIST time. One request is cut into the part that is free (reserved) and the part that is not
// (waitlisted); waitlisted demand never makes time unavailable; every release path offers freed time to the first eligible waitlister.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');
const T = require('../src/timeRange');

let server, db, admin, waitlist;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  waitlist = require('../src/waitlist');
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const newAsset = async (name, extra = {}) => { const r = await admin.post('/api/assets', { name, tag: `PF-${++seq}`, available_to_request: true, ...extra }); assert.equal(r.status, 200); return r.body; };
async function makeLogin(name) {
  const email = `pf${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true, department: 'Marketing' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email };
}
const ask = (who, asset, s, e, t = []) => who.client.post(`/api/assets/${asset.id}/reservations`, { start_date: s, end_date: e, start_time: t[0] || null, end_time: t[1] || null });
const join = (who, asset, s, e, t = []) => who.client.post(`/api/assets/${asset.id}/waitlist`, { start_date: s, end_date: e, start_time: t[0] || null, end_time: t[1] || null });
const check = async (who, asset, s, e, t = []) => (await who.client.get(`/api/assets/${asset.id}/range-check?start_date=${s}&end_date=${e}${t[0] ? `&start_time=${t[0]}` : ''}${t[1] ? `&end_time=${t[1]}` : ''}`)).body;
const times = (rows) => rows.map((r) => [r.start_date, r.start_time, r.end_date, r.end_time]);
const phase = async (who, id) => (await who.client.get(`/api/waitlist/${id}`)).body.phase;
const rows = (table, assetId) => db.prepare(`SELECT * FROM ${table} WHERE asset_id = ?`).all(assetId);
const day = plus(14);

test('fully available request -> reservation only', async () => {
  const a = await newAsset('Free camera'); const me = await makeLogin('Free Asker');
  const r = await ask(me, a, day, plus(16));
  assert.equal(r.status, 200);
  assert.deepEqual(times(r.body.reserved), [[day, null, plus(16), null]]);
  assert.equal(r.body.waitlisted.length, 0);
  assert.equal(rows('waitlist_entries', a.id).length, 0);
});

test('fully unavailable request -> waitlist only (reserving it is refused, nothing is written; joining works)', async () => {
  const a = await newAsset('Taken camera'); const owner = await makeLogin('Taken Owner'); const me = await makeLogin('Taken Asker');
  assert.equal((await ask(owner, a, day, plus(16))).status, 200);
  const refused = await ask(me, a, plus(15), plus(15));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /waitlist/i);
  assert.equal(rows('reservations', a.id).length, 1, 'no reservation was created for the unavailable time');
  assert.equal((await check(me, a, plus(15), plus(15))).outcome, 'waitlist');
  const j = await join(me, a, plus(15), plus(15));
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(rows('reservations', a.id).length, 1);
  assert.equal(rows('waitlist_entries', a.id).length, 1);
});

test('partially available request -> reserved + waitlisted segments, linked by one request_group', async () => {
  const a = await newAsset('Split camera'); const owner = await makeLogin('Split Owner'); const me = await makeLogin('Split Asker');
  await ask(owner, a, day, day, ['08:00', '13:00']);
  const r = await ask(me, a, day, day, ['12:00', '14:00']);
  assert.equal(r.status, 200);
  assert.deepEqual(times(r.body.waitlisted), [[day, '12:00', day, '13:00']], '12-1 is waitlisted');
  assert.deepEqual(times(r.body.reserved), [[day, '13:00', day, '14:00']], '1-2 is reserved');
  assert.deepEqual(r.body.requested, { start_date: day, start_time: '12:00', end_date: day, end_time: '14:00' });
  const resv = db.prepare('SELECT request_group FROM reservations WHERE employee_id = ?').get(me.id);
  const wl = db.prepare('SELECT request_group FROM waitlist_entries WHERE employee_id = ?').get(me.id);
  assert.ok(resv.request_group);
  assert.equal(resv.request_group, wl.request_group, 'one request, one group');
  assert.equal(r.body.request_group, resv.request_group);
  assert.notEqual(db.prepare('SELECT request_group FROM reservations WHERE employee_id = ?').get(owner.id).request_group, resv.request_group, 'a different request is a different group');
});

test('8 AM-1 PM followed by 1 PM-5 PM -> reservation only, no waitlist (the boundary is adjacent)', async () => {
  const a = await newAsset('Adjacent camera'); const x = await makeLogin('Adj X'); const y = await makeLogin('Adj Y');
  await ask(x, a, day, day, ['08:00', '13:00']);
  const r = await ask(y, a, day, day, ['13:00', '17:00']);
  assert.equal(r.status, 200);
  assert.equal(r.body.waitlisted.length, 0);
  assert.deepEqual(times(r.body.reserved), [[day, '13:00', day, '17:00']]);
});

test('multi-day request with only one unavailable day splits around it', async () => {
  const a = await newAsset('Multi camera'); const owner = await makeLogin('Multi Owner'); const me = await makeLogin('Multi Asker');
  await ask(owner, a, plus(12), plus(12));
  const r = await ask(me, a, plus(10), plus(14));
  assert.deepEqual(times(r.body.reserved), [[plus(10), null, plus(11), null], [plus(13), null, plus(14), null]]);
  assert.deepEqual(times(r.body.waitlisted), [[plus(12), null, plus(12), null]]);
  // "unavailable through Jan 5, ask Jan 5-6": the checkout day is waitlisted, the next day reserved
  const out = await newAsset('Out camera'); const holder = await makeLogin('Out Holder');
  assert.equal((await admin.post(`/api/assets/${out.id}/checkout`, { employee_id: holder.id, assignment_type: 'checkout', due_date: plus(20) })).status, 200);
  const jan = await ask(me, out, plus(20), plus(21));
  assert.deepEqual(times(jan.body.waitlisted), [[plus(20), null, plus(20), null]]);
  assert.deepEqual(times(jan.body.reserved), [[plus(21), null, plus(21), null]]);
});

test('splitFree is pure: pieces cover the request exactly, touching blocks free, overlapping blocks merge', () => {
  const req = { start_date: day, start_time: '12:00', end_date: day, end_time: '14:00' };
  const k = (a, b) => ({ sk: `${day}T${a}`, ek: `${day}T${b}` });
  assert.deepEqual(T.splitFree(req, [k('08:00', '12:00')]), { free: [req], busy: [] }, 'a block that only touches leaves it free');
  assert.deepEqual(T.splitFree(req, [k('08:00', '13:00'), k('12:30', '13:30')]).busy, [{ start_date: day, start_time: '12:00', end_date: day, end_time: '13:30' }]);
  assert.deepEqual(T.splitFree(req, [k('00:00', '23:59')]).free, []);
  assert.deepEqual(T.splitFree(req, []).busy, []);
});

test('ordinary waitlist entries do not block availability or reservations; they may overlap each other and a reservation', async () => {
  const a = await newAsset('Demand camera'); const owner = await makeLogin('Demand Owner');
  const w1 = await makeLogin('Demand W1'); const w2 = await makeLogin('Demand W2'); const x = await makeLogin('Demand X');
  await ask(owner, a, day, plus(15));
  const e1 = (await join(w1, a, day, plus(15))).body; const e2 = (await join(w2, a, day, day)).body;
  assert.deepEqual([e1.phase, e2.phase], ['waiting', 'waiting'], 'two overlapping waitlists coexist');
  // a waiting entry over time that is free (as after a release that the sweep has not yet reached) blocks nobody
  db.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status, queue_seq) VALUES (?, ?, ?, ?, 'waiting', 99999)").run(a.id, w1.id, plus(30), plus(31));
  const r = await ask(x, a, plus(30), plus(31));
  assert.equal(r.status, 200);
  assert.equal(r.body.waitlisted.length, 0, 'waiting is demand, not possession');
});

test('an active hold blocks its exact interval (and not a minute more)', async () => {
  const a = await newAsset('Hold camera'); const owner = await makeLogin('Hold Owner'); const w = await makeLogin('Hold Waiter'); const x = await makeLogin('Hold X');
  const res = (await ask(owner, a, day, day, ['08:00', '17:00'])).body.reserved[0];
  const e = (await join(w, a, day, day, ['09:00', '11:00'])).body;
  await owner.client.post(`/api/reservations/${res.id}/cancel`, {});
  assert.equal(await phase(w, e.id), 'held');
  assert.equal((await check(x, a, day, day, ['11:00', '12:00'])).outcome, 'reserve', 'adjacent to the hold');
  const cut = await check(x, a, day, day, ['10:30', '11:30']);
  assert.equal(cut.outcome, 'partial');
  assert.deepEqual(times(cut.waitlisted), [[day, '10:30', day, '11:00']]);
  assert.equal((await check(x, a, day, day, ['09:00', '11:00'])).outcome, 'waitlist', 'the held interval itself');
});

test('an early return promotes the first eligible waitlisted segment; a partial request\'s waitlisted part is offered, its reserved part stays', async () => {
  const a = await newAsset('Return camera'); const holder = await makeLogin('Return Holder');
  const first = await makeLogin('Return First'); const second = await makeLogin('Return Second');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: holder.id, assignment_type: 'checkout', due_date: plus(5) })).status, 200);
  const r = await ask(first, a, plus(4), plus(7));
  assert.deepEqual(times(r.body.waitlisted), [[plus(4), null, plus(5), null]]);
  assert.deepEqual(times(r.body.reserved), [[plus(6), null, plus(7), null]]);
  const e1 = r.body.waitlisted[0];
  const e2 = (await join(second, a, plus(4), plus(5))).body;
  assert.deepEqual([await phase(first, e1.id), await phase(second, e2.id)], ['waiting', 'waiting']);
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, { assignment_id: undefined })).status, 200);
  assert.equal(await phase(first, e1.id), 'held', 'the first in line is offered the freed time');
  assert.equal(await phase(second, e2.id), 'waiting', 'FIFO: the second stays behind');
  assert.equal(rows('reservations', a.id).length, 1, 'nothing was reserved automatically');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outbox WHERE to_addr = ? AND subject LIKE 'Available for you%'").get(first.email).c, 1, 'and they got the existing availability email');
  // confirming runs the normal flow and keeps the request group
  const c = await first.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.reservation.request_group, r.body.request_group);
});

test('shortening a reservation re-evaluates the newly freed interval', async () => {
  const a = await newAsset('Shorten camera'); const owner = await makeLogin('Shorten Owner'); const w = await makeLogin('Shorten Waiter');
  const res = (await ask(owner, a, plus(10), plus(12))).body.reserved[0];
  const r = await ask(w, a, plus(11), plus(13));
  const entry = r.body.waitlisted[0];
  assert.deepEqual(times(r.body.waitlisted), [[plus(11), null, plus(12), null]]);
  assert.equal(await phase(w, entry.id), 'waiting');
  assert.equal((await owner.client.post(`/api/reservations/${res.id}/shorten`, { end_date: plus(10) })).status, 200);
  assert.equal(await phase(w, entry.id), 'held');
});

test('hold decline and hold expiry pass the freed time to the next waitlister', async () => {
  const a = await newAsset('Pass camera'); const owner = await makeLogin('Pass Owner'); const w1 = await makeLogin('Pass W1'); const w2 = await makeLogin('Pass W2');
  const res = (await ask(owner, a, day, day)).body.reserved[0];
  const e1 = (await join(w1, a, day, day)).body; const e2 = (await join(w2, a, day, day)).body;
  await owner.client.post(`/api/reservations/${res.id}/cancel`, {});
  assert.deepEqual([await phase(w1, e1.id), await phase(w2, e2.id)], ['held', 'waiting']);
  await w1.client.post(`/api/waitlist/${e1.id}/decline`, {});
  assert.equal(await phase(w2, e2.id), 'held');
  db.prepare("UPDATE waitlist_entries SET hold_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(e2.id);
  waitlist.sweep(db);
  assert.equal(await phase(w2, e2.id), 'expired');
});

test('approval can no longer double-book: time taken since submission is refused at approval', async () => {
  const a = await newAsset('Approve camera', { reservation_requires_approval: true });
  const x = await makeLogin('Approve X'); const y = await makeLogin('Approve Y');
  const p1 = (await ask(x, a, day, day)).body.reserved[0]; const p2 = (await ask(y, a, day, day)).body.reserved[0];
  assert.equal((await admin.post(`/api/reservations/${p1.id}/approve`, {})).status, 200);
  assert.equal((await admin.post(`/api/reservations/${p2.id}/approve`, {})).status, 409);
});

// ---------------------------------------------------------------- partial re-splitting of waitlist demand
// The same split a new request gets (T.splitFree) is re-run on waiting entries whenever time frees: the freed part is offered, the rest keeps waiting.
const wlRows = (employeeId, assetId) => db.prepare('SELECT * FROM waitlist_entries WHERE employee_id = ? AND asset_id = ? ORDER BY start_time, id').all(employeeId, assetId)
  .map((r) => [r.start_time, r.end_time, r.status]);

test('waitlisted 8-5 and only 1-5 frees: the first waitlister is offered 1-5 and 8-1 keeps waiting (shortening path)', async () => {
  const a = await newAsset('Resplit camera'); const owner = await makeLogin('Resplit Owner'); const w = await makeLogin('Resplit Waiter');
  const res = (await ask(owner, a, day, day, ['08:00', '17:00'])).body.reserved[0];
  const e = (await join(w, a, day, day, ['08:00', '17:00'])).body;
  const group = db.prepare('SELECT request_group, queue_seq FROM waitlist_entries WHERE id = ?').get(e.id);
  assert.equal((await owner.client.post(`/api/reservations/${res.id}/shorten`, { end_time: '13:00' })).status, 200);
  assert.deepEqual(wlRows(w.id, a.id), [['08:00', '13:00', 'waiting'], ['13:00', '17:00', 'held']]);
  const offered = (await w.client.get(`/api/waitlist/${e.id}`)).body;
  assert.deepEqual([offered.phase, offered.start_time, offered.end_time], ['held', '13:00', '17:00'], 'the same entry now holds the freed part');
  const pieces = db.prepare('SELECT queue_seq, request_group, queued_at FROM waitlist_entries WHERE employee_id = ?').all(w.id);
  assert.equal(new Set(pieces.map((p) => p.queue_seq)).size, 1, 'both pieces keep the original place in line');
  assert.equal(pieces[0].queue_seq, group.queue_seq);
  assert.equal(new Set(pieces.map((p) => p.request_group)).size, 1);
  assert.equal(rows('reservations', a.id).length, 1, 'nothing was reserved automatically');
  // the existing offer flow: confirming reserves exactly the offered part
  const c = await w.client.post(`/api/waitlist/${e.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.reservation.start_time, c.body.reservation.end_time, c.body.reservation.status], ['13:00', '17:00', 'confirmed']);
  assert.deepEqual(wlRows(w.id, a.id).filter((r) => r[2] === 'waiting'), [['08:00', '13:00', 'waiting']], 'the unavailable part is still waitlisted');
  // when the rest frees too it is offered as well
  assert.equal((await owner.client.post(`/api/reservations/${res.id}/cancel`, {})).status, 200);
  assert.deepEqual(wlRows(w.id, a.id).filter((r) => r[2] !== 'fulfilled'), [['08:00', '13:00', 'held']]);
});

test('early return: the checkout\'s freed time is offered, the part still reserved by someone else keeps waiting', async () => {
  const a = await newAsset('Resplit return'); const holder = await makeLogin('Resplit Holder'); const owner = await makeLogin('Resplit After'); const w = await makeLogin('Resplit Returner');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: holder.id, assignment_type: 'checkout', due_date: plus(5), due_time: '13:00' })).status, 200);
  assert.equal((await ask(owner, a, plus(5), plus(5), ['13:00', '17:00'])).status, 200, 'reserved for after the due time');
  const e = (await join(w, a, plus(5), plus(5), ['08:00', '17:00'])).body; // checkout until 1, reservation from 1: all unavailable
  assert.equal(await phase(w, e.id), 'waiting');
  assert.equal((await admin.post(`/api/assets/${a.id}/checkin`, {})).status, 200);
  assert.deepEqual(wlRows(w.id, a.id), [['08:00', '13:00', 'held'], ['13:00', '17:00', 'waiting']]);
  assert.equal(rows('reservations', a.id).length, 1, 'nothing reserved automatically');
  // the offer carries the existing availability email
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outbox WHERE to_addr = ? AND subject LIKE 'Available for you%'").get(w.email).c, 1);
});

test('multiple waitlisters keep FIFO: the older entry is offered the freed part first, the younger waits behind its hold', async () => {
  const a = await newAsset('Resplit FIFO'); const owner = await makeLogin('FIFO Owner'); const older = await makeLogin('FIFO Older'); const younger = await makeLogin('FIFO Younger');
  const res = (await ask(owner, a, day, day, ['08:00', '17:00'])).body.reserved[0];
  const eOld = (await join(older, a, day, day, ['08:00', '17:00'])).body;
  const eYoung = (await join(younger, a, day, day, ['10:00', '16:00'])).body;
  await owner.client.post(`/api/reservations/${res.id}/shorten`, { end_time: '13:00' });
  assert.deepEqual(wlRows(older.id, a.id), [['08:00', '13:00', 'waiting'], ['13:00', '17:00', 'held']]);
  assert.equal(await phase(younger, eYoung.id), 'waiting', 'the younger entry\'s free 1-4 is inside the older hold');
  assert.deepEqual(wlRows(younger.id, a.id), [['10:00', '16:00', 'waiting']], 'and is not split: nothing of it is free');
  // the older holder lets go: the freed 1-5 goes to the younger entry, only for the part it asked for
  await older.client.post(`/api/waitlist/${eOld.id}/decline`, {});
  assert.deepEqual(wlRows(younger.id, a.id), [['10:00', '13:00', 'waiting'], ['13:00', '16:00', 'held']]);
  assert.deepEqual(wlRows(older.id, a.id).filter((r) => r[2] === 'waiting'), [['08:00', '13:00', 'waiting']], 'the older entry\'s unavailable part keeps its earlier place');
});

test('freed time that only touches a waitlisted range (or does not reach it) is not held for that entry', async () => {
  const a = await newAsset('Resplit adjacent'); const owner = await makeLogin('Adj Owner'); const w = await makeLogin('Adj Waiter');
  const res = (await ask(owner, a, day, day, ['08:00', '17:00'])).body.reserved[0];
  const e = (await join(w, a, day, day, ['08:00', '10:00'])).body;
  await owner.client.post(`/api/reservations/${res.id}/shorten`, { end_time: '10:00' });
  assert.equal(await phase(w, e.id), 'waiting', '10-5 frees but the entry ends at 10:00: touching is not overlapping');
  assert.deepEqual(wlRows(w.id, a.id), [['08:00', '10:00', 'waiting']], 'and nothing was split');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE status = 'held' AND asset_id = ?").get(a.id).c, 0);
});

// ---------------------------------------------------------------- manual / scan checkout vs. waitlist holds
// A hold (and only a hold) makes its interval unavailable to a checkout; the hold's own employee checking it out in person accepts the offer.
async function heldToday(label) {
  const a = await newAsset(label); const owner = await makeLogin(`${label} Owner`); const waiter = await makeLogin(`${label} Waiter`); const other = await makeLogin(`${label} Other`);
  const res = (await ask(owner, a, TODAY, TODAY, ['08:00', '17:00'])).body.reserved[0];
  const entry = (await join(waiter, a, TODAY, TODAY, ['13:00', '17:00'])).body;
  await owner.client.post(`/api/reservations/${res.id}/cancel`, {});
  assert.equal(await phase(waiter, entry.id), 'held');
  return { a, waiter, other, entry };
}

test('checkout across another employee\'s active hold is refused with a plain explanation (IT and self-checkout), and names nobody', async () => {
  const { a, other } = await heldToday('Hold checkout');
  const byIt = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: other.id, assignment_type: 'checkout', due_date: plus(1) });
  assert.equal(byIt.status, 409);
  assert.match(byIt.body.error, /being held for another employee/i);
  assert.doesNotMatch(byIt.body.error, /Hold checkout Waiter/);
  const self = await other.client.post(`/api/assets/${a.id}/checkout`, { due_date: TODAY, due_time: '15:00' });
  assert.equal(self.status, 409, 'a self-checkout / scan that runs into the held 1-5 PM');
  assert.match(self.body.error, /being held for another employee/i);
  assert.match(self.body.error, /1:00 PM/);
  assert.equal(rows('reservations', a.id).filter((r) => r.status === 'confirmed').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?').get(a.id).c, 0, 'nothing was checked out');
});

test('a hold blocks only its own interval: a checkout back before the hold starts is allowed', async () => {
  const { a, other, entry, waiter } = await heldToday('Hold edge');
  const early = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: other.id, assignment_type: 'checkout', due_date: TODAY, due_time: '12:00' });
  assert.equal(early.status, 200, JSON.stringify(early.body));
  assert.equal(await phase(waiter, entry.id), 'held', 'someone else\'s checkout does not touch the hold');
});

test('checkout by the hold owner is accepted and resolves the hold: no email confirmation needed, audit kept', async () => {
  const { a, waiter, entry } = await heldToday('Hold owner');
  const out = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: waiter.id, assignment_type: 'checkout', due_date: TODAY, due_time: '17:00' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const e = (await waiter.client.get(`/api/waitlist/${entry.id}`)).body;
  assert.equal(e.phase, 'checked_out');
  assert.deepEqual([e.can_confirm, e.can_decline, e.can_leave], [false, false, false]);
  assert.equal(db.prepare('SELECT status FROM waitlist_entries WHERE id = ?').get(entry.id).status, 'fulfilled');
  assert.ok(db.prepare('SELECT closed_at FROM waitlist_entries WHERE id = ?').get(entry.id).closed_at);
  assert.equal((await waiter.client.post(`/api/waitlist/${entry.id}/confirm`, {})).status, 400, 'nothing left to confirm');
  const trail = db.prepare("SELECT action FROM activity WHERE asset_id = ? ORDER BY id").all(a.id).map((r) => r.action);
  assert.ok(trail.includes('waitlist_joined') && trail.includes('waitlist_hold_started'), 'the earlier lifecycle is untouched');
  assert.ok(trail.includes('waitlist_checked_out') && trail.includes('checked_out'));
  assert.equal(rows('reservations', a.id).filter((r) => r.status === 'confirmed').length, 0, 'it is a checkout, not a reservation');
});

test('a merely waiting waitlist entry is not possession: it never blocks a checkout', async () => {
  const a = await newAsset('Waiting only'); const w = await makeLogin('Waiting Only Person'); const other = await makeLogin('Waiting Only Other');
  db.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status, queue_seq) VALUES (?, ?, ?, ?, 'waiting', 99998)").run(a.id, w.id, TODAY, plus(3));
  const out = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: other.id, assignment_type: 'checkout', due_date: plus(2) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
});

// ---------------------------------------------------------------- response windows: 24 h / 2 h / 30 min by how soon the offered time starts
const addMin = (key, n) => new Date(Date.parse(`${key}:00Z`) + n * 6e4).toISOString().slice(0, 16);
const slotAt = (offsetMin, lengthMin = 60) => { const k = addMin(T.nowKey(), offsetMin); const e = addMin(k, lengthMin); return [k.slice(0, 10), k.slice(11), e.slice(0, 10), e.slice(11)]; };
const holdMinutes = (id) => Math.round(db.prepare('SELECT (julianday(hold_expires_at) - julianday(hold_started_at)) * 1440 AS m FROM waitlist_entries WHERE id = ?').get(id).m);
// owner blocks everything for a few days; the waiter asks for a slot; the owner cancels: the slot is offered. Returns the minutes of the response window.
async function offeredWindow(label, slot) {
  const a = await newAsset(label); const owner = await makeLogin(`${label} Owner`); const w = await makeLogin(`${label} Waiter`);
  const res = (await ask(owner, a, TODAY, plus(5))).body.reserved[0];
  const [sd, st, ed, et] = slot;
  const e = await join(w, a, sd, ed, [st, et]);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  await owner.client.post(`/api/reservations/${res.id}/cancel`, {});
  assert.equal(await phase(w, e.body.id), 'held');
  return { a, w, owner, id: e.body.id, minutes: holdMinutes(e.body.id) };
}

test('responseMinutes is exact at every boundary: >24 h -> 24 h, 4 h to 24 h (both ends) -> 2 h, <4 h or already started -> 30 min', () => {
  const now = '2030-06-10T12:00';
  const w = (startKey) => waitlist.responseMinutes({ start_date: startKey.slice(0, 10), start_time: startKey.slice(11) }, now);
  assert.equal(w('2030-06-11T12:01'), 1440, 'one minute over 24 h');
  assert.equal(w('2030-06-11T12:00'), 120, 'exactly 24 h is in the 4-24 h tier');
  assert.equal(w('2030-06-11T11:59'), 120);
  assert.equal(w('2030-06-10T16:00'), 120, 'exactly 4 h is still the 2 h tier');
  assert.equal(w('2030-06-10T15:59'), 30, 'just under 4 h');
  assert.equal(w('2030-06-10T12:30'), 30);
  assert.equal(w('2030-06-10T12:00'), 30, 'starting right now');
  assert.equal(w('2030-06-10T09:00'), 30, 'already started');
  assert.equal(waitlist.responseMinutes({ start_date: '2030-06-12', start_time: null }, now), 1440, 'a date-only piece starts at 00:00');
  assert.equal(waitlist.responseMinutes({ start_date: '2030-06-10', start_time: null }, now), 30, 'a date-only piece today has already started');
});

test('nowKey is the wall clock of APP_TIMEZONE (not the server\'s)', () => {
  const keep = process.env.APP_TIMEZONE;
  try {
    const at = new Date('2030-01-15T03:30:00Z');
    process.env.APP_TIMEZONE = 'Asia/Tokyo'; assert.equal(T.nowKey(at), '2030-01-15T12:30');
    process.env.APP_TIMEZONE = 'Pacific/Honolulu'; assert.equal(T.nowKey(at), '2030-01-14T17:30');
    process.env.APP_TIMEZONE = 'Not/AZone'; assert.equal(T.nowKey(at), '2030-01-15T03:30', 'an invalid zone falls back to UTC rather than throwing');
  } finally { if (keep === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = keep; }
});

test('an offer for time more than 24 hours away is a 24-hour window', async () => {
  const far = (await offeredWindow('Window far', [plus(4), null, plus(4), null])).minutes;
  assert.equal(far, 1440);
  assert.equal((await offeredWindow('Window 24h10', slotAt(24 * 60 + 10))).minutes, 1440, 'a little over 24 h away');
});

test('an offer 4 to 24 hours away is a 2-hour window (near the 24 h boundary too)', async () => {
  assert.equal((await offeredWindow('Window 10h', slotAt(10 * 60))).minutes, 120);
  assert.equal((await offeredWindow('Window 23h50', slotAt(23 * 60 + 50))).minutes, 120, 'a little under 24 h away');
  assert.equal((await offeredWindow('Window 4h10', slotAt(4 * 60 + 10))).minutes, 120, 'a little over 4 h away');
});

test('an offer under 4 hours away, or whose time has already started, is a 30-minute window', async () => {
  assert.equal((await offeredWindow('Window 3h50', slotAt(3 * 60 + 50))).minutes, 30);
  assert.equal((await offeredWindow('Window 30m', slotAt(30))).minutes, 30);
  assert.equal((await offeredWindow('Window started', [TODAY, null, TODAY, '23:59'])).minutes, 30, 'started at 00:00 today');
});

test('the window is set from the OFFERED piece: a partial hold uses the tier of the freed part, not of the whole waitlisted range', async () => {
  const a = await newAsset('Window partial'); const owner = await makeLogin('Window Partial Owner'); const w = await makeLogin('Window Partial Waiter');
  const res = (await ask(owner, a, TODAY, plus(5))).body.reserved[0];
  const e = (await join(w, a, TODAY, plus(5))).body; // the whole range has already started (TODAY 00:00)
  assert.equal((await owner.client.post(`/api/reservations/${res.id}/shorten`, { end_date: plus(2) })).status, 200);
  assert.deepEqual(wlRows(w.id, a.id).map((r) => r[2]).sort(), ['held', 'waiting']);
  assert.equal(holdMinutes(e.id), 1440, `the freed part starts ${plus(3)}, days away`);
  assert.equal(db.prepare("SELECT start_date FROM waitlist_entries WHERE id = ?").get(e.id).start_date, plus(3));
});

test('an offer that expires frees exactly its interval and the next FIFO waitlister is offered it at once, with its own window', async () => {
  const a = await newAsset('Window expiry'); const owner = await makeLogin('Window Exp Owner'); const w1 = await makeLogin('Window Exp W1'); const w2 = await makeLogin('Window Exp W2');
  const res = (await ask(owner, a, TODAY, plus(5))).body.reserved[0];
  const slot = slotAt(30);
  const e1 = (await join(w1, a, slot[0], slot[2], [slot[1], slot[3]])).body; const e2 = (await join(w2, a, slot[0], slot[2], [slot[1], slot[3]])).body;
  await owner.client.post(`/api/reservations/${res.id}/cancel`, {});
  assert.deepEqual([await phase(w1, e1.id), await phase(w2, e2.id)], ['held', 'waiting']);
  assert.equal(holdMinutes(e1.id), 30);
  db.prepare("UPDATE waitlist_entries SET hold_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(e1.id);
  waitlist.sweep(db);
  assert.deepEqual([await phase(w1, e1.id), await phase(w2, e2.id)], ['expired', 'held'], 'the next in line is offered it immediately');
  assert.equal(holdMinutes(e2.id), 30, 'and gets the tier that applies now');
  assert.equal(rows('reservations', a.id).filter((r) => r.status === 'confirmed').length, 0, 'nothing is reserved automatically');
});

test('the hold owner checking the item out in person still resolves a timed offer', async () => {
  const slot = slotAt(30);
  const { a, w, id } = await offeredWindow('Window checkout', slot);
  assert.equal(holdMinutes(id), 30);
  const out = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: w.id, assignment_type: 'checkout', due_date: plus(6) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(await phase(w, id), 'checked_out');
});

test('the offer says WHEN it ends, never "24 hours" in general: email, API text, and the screens', async () => {
  const { w, id } = await offeredWindow('Window wording', slotAt(30));
  await new Promise((res) => setTimeout(res, 60));
  const mail = db.prepare("SELECT subject, body FROM outbox WHERE to_addr = ? AND subject LIKE 'Available for you%' ORDER BY id DESC").get(w.email);
  assert.match(mail.subject, /^Available for you until .+ [A-Z]{2,5}: /, 'the expiry is in the subject');
  assert.match(mail.body, /Available for you until:<\/strong>/);
  assert.match(mail.body, /Confirm<\/strong> before /);
  assert.doesNotMatch(mail.body + mail.subject, /24 hours|24-hour|within 24/i);
  const e = (await w.client.get(`/api/waitlist/${id}`)).body;
  assert.ok(e.hold_expires_text && /\d/.test(e.hold_expires_text), 'the server hands the screen the expiry in APP_TIMEZONE');
  assert.match(src, /'Available for you until'\} \$\{esc\(w\.hold_expires_text/);
  assert.match(src, /held: 'Available for you',/);
  assert.doesNotMatch(src, /24-hour|within 24 hours|for 24 hours/);
});

// ---------------------------------------------------------------- an offer never outlives the interval it offers
const holdSeconds = (id) => Math.round(db.prepare('SELECT (julianday(hold_expires_at) - julianday(hold_started_at)) * 86400 AS s FROM waitlist_entries WHERE id = ?').get(id).s);
// a slot that started `agoMin` minutes ago and ends `leftMin` minutes from now (a start before today is clamped to the start of today: it has started either way)
const runningSlot = (agoMin, leftMin) => { const a = addMin(T.nowKey(), -agoMin); const e = addMin(T.nowKey(), leftMin); return a.slice(0, 10) < TODAY ? [TODAY, null, e.slice(0, 10), e.slice(11)] : [a.slice(0, 10), a.slice(11), e.slice(0, 10), e.slice(11)]; };

test('offerSeconds is the earlier of the tier window and the end of the offered interval', () => {
  const now = '2030-06-10T13:50';
  const o = (piece) => waitlist.offerSeconds({ start_time: null, end_time: null, ...piece }, now, 0);
  assert.equal(o({ start_date: '2030-06-10', start_time: '13:00', end_date: '2030-06-10', end_time: '14:00' }), 600, '1-2 PM, available at 1:50: 10 minutes, not the 30-minute tier');
  assert.equal(o({ start_date: '2030-06-10', start_time: '13:00', end_date: '2030-06-10', end_time: '14:20' }), 1800, '30 minutes remain: the tier is not cut');
  assert.equal(o({ start_date: '2030-06-10', start_time: '13:00', end_date: '2030-06-10', end_time: '16:00' }), 1800, 'a later end leaves the normal deadline unchanged');
  assert.equal(o({ start_date: '2030-06-10', start_time: '13:00', end_date: '2030-06-10', end_time: '13:50' }), 0, 'already over');
  assert.equal(waitlist.offerSeconds({ start_date: '2030-06-10', start_time: null, end_date: '2030-06-10', end_time: null }, '2030-06-10T23:45', 0), 900, 'date-only: through the end of that day');
  assert.equal(waitlist.offerSeconds({ start_date: '2030-06-10', start_time: '13:00', end_date: '2030-06-10', end_time: '14:00' }, now, 20), 580, 'the seconds already elapsed in this minute are taken off, so it ends exactly at 2:00');
  // a piece 4+ hours away is always at least 4 hours from its end, so the 2-hour and 24-hour tiers can never be cut short
  assert.equal(o({ start_date: '2030-06-10', start_time: '18:00', end_date: '2030-06-10', end_time: '18:45' }), 7200);
});

test('a 30-minute offer for an interval with only ~10 minutes left expires at the interval end', async () => {
  const { id } = await offeredWindow('Cap short', runningSlot(50, 10));
  const s = holdSeconds(id);
  assert.ok(s > 8 * 60 && s <= 10 * 60, `expires at the interval end, ~10 min away (got ${s}s), not after 30 minutes`);
  const e = db.prepare('SELECT end_date, end_time FROM waitlist_entries WHERE id = ?').get(id);
  assert.ok(e.end_time, 'the held piece keeps its concrete end');
});

test('a normal tier is unchanged when the interval ends later than the deadline', async () => {
  const { id } = await offeredWindow('Cap normal', runningSlot(10, 120));
  assert.equal(holdSeconds(id), 30 * 60);
  const far = await offeredWindow('Cap far', [plus(4), null, plus(4), null]);
  assert.equal(far.minutes, 1440, 'a day-long interval days away keeps its 24 hours');
});

test('a date-only interval ends at the end of its day, consistent with the time model', async () => {
  const { id } = await offeredWindow('Cap day', [TODAY, null, TODAY, null]);
  const s = holdSeconds(id);
  assert.ok(s <= 30 * 60 && s > 0);
});

test('confirming after the offered interval has ended is refused, and the entry ends', async (t) => {
  const earlier = addMin(T.nowKey(), -5);
  if (earlier.slice(0, 10) < TODAY) return t.skip('too close to midnight to express a time that has already passed today');
  const { w, id, a } = await offeredWindow('Cap late', runningSlot(50, 30));
  // the offered time is now over, while the (long) deadline has not been reached
  db.prepare("UPDATE waitlist_entries SET end_date = ?, end_time = ?, hold_expires_at = datetime('now', '+20 minutes') WHERE id = ?").run(earlier.slice(0, 10), earlier.slice(11), id);
  const c = await w.client.post(`/api/waitlist/${id}/confirm`, {});
  assert.equal(c.status, 409, JSON.stringify(c.body));
  assert.match(c.body.error, /expired|ended/i);
  assert.equal(db.prepare('SELECT status FROM waitlist_entries WHERE id = ?').get(id).status, 'expired');
  assert.equal(rows('reservations', a.id).filter((r) => r.status === 'confirmed').length, 0);
});

test('a waiting entry whose time has passed today is closed by the sweep, never offered', async (t) => {
  const earlier = addMin(T.nowKey(), -5);
  if (earlier.slice(0, 10) < TODAY) return t.skip('too close to midnight');
  const a = await newAsset('Cap waiting'); const owner = await makeLogin('Cap Waiting Owner'); const w = await makeLogin('Cap Waiting Waiter');
  await ask(owner, a, TODAY, plus(3));
  const e = (await join(w, a, TODAY, TODAY, ['00:00', '23:00'])).body;
  db.prepare('UPDATE waitlist_entries SET end_time = ? WHERE id = ?').run(earlier.slice(11), e.id);
  waitlist.sweep(db);
  assert.equal(await phase(w, e.id), 'expired');
});

// ---------------------------------------------------------------- asset detail: my own activity, "Available now"
test('asset detail lists the employee\'s OWN reservation and waitlist (never anyone else\'s) and says whether anything is scheduled', async () => {
  const a = await newAsset('Detail camera'); const owner = await makeLogin('Detail Owner'); const me = await makeLogin('Detail Me'); const other = await makeLogin('Detail Other');
  const quiet = (await me.client.get(`/api/assets/${a.id}`)).body;
  assert.deepEqual([quiet.upcoming, quiet.waitlist], [false, []], 'nothing scheduled yet');
  await ask(owner, a, day, day, ['08:00', '13:00']);
  await ask(other, a, day, day, ['09:00', '10:00']); // refused (taken): nothing of theirs
  const r = await ask(me, a, day, day, ['12:00', '14:00']);
  assert.equal(r.status, 200);
  const d = (await me.client.get(`/api/assets/${a.id}`)).body;
  assert.equal(d.upcoming, true, 'future scheduled activity exists (the page says "Available now" for a free item)');
  assert.deepEqual(d.reservations.map((x) => [x.start_time, x.end_time, x.status]), [['13:00', '14:00', 'confirmed']], 'only my reservation');
  assert.deepEqual(d.waitlist.map((x) => [x.start_time, x.end_time, x.phase]), [['12:00', '13:00', 'waiting']], 'only my waitlist');
  assert.doesNotMatch(JSON.stringify(d.waitlist) + JSON.stringify(d.reservations), /Detail Owner|Detail Other/);
  const theirs = (await owner.client.get(`/api/assets/${a.id}`)).body;
  assert.deepEqual(theirs.waitlist, [], 'the owner has no waitlist place and sees none of mine');
  assert.equal((await admin.get(`/api/assets/${a.id}`)).body.waitlist.length, 0, 'IT\'s page is unchanged');
});

test('front end: the asset page shows my reservation green and my waitlist amber, and "Available now" for a free item with scheduled activity', () => {
  const view = src.slice(src.indexOf('async function viewAsset('), src.indexOf('async function viewAssetForm('));
  assert.match(view, /<span class="rs-sched ok"><strong>Your reservation<\/strong>/);
  assert.match(view, /<span class="rs-sched wait"><strong>Your waitlist<\/strong>/);
  assert.match(view, /pill\('available', 'Available now'\)/);
  assert.match(view, /a\.status === 'available' && d\.upcoming && !admin/, 'a display change only');
  assert.match(view, /\$\{myActivity\}\s*\n\s*\$\{actions\}/, 'shown up front, above the actions');
});

// ---------------------------------------------------------------- front end (source level; rendering is browser QA)
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const sheetSrc = src.slice(src.indexOf('function rangeSheet('), src.indexOf('function wireWaitlistActions('));

test('front end: no "Reserve anyway" / "Request anyway" action exists anywhere', () => {
  assert.doesNotMatch(src, /Reserve anyway|Request anyway|rs-anyway/i);
  assert.doesNotMatch(src, /to fit around what is already there/, 'the old copy that made the employee solve availability is gone');
});

test('front end: the date sheet explains a split request in one notice with one action, and uses the amber warning (never the blue info or red error)', () => {
  assert.match(sheetSrc, /title = 'Part of this time is unavailable'; kind = 'warn'/);
  assert.match(sheetSrc, /title = edit \? 'Edit waitlist dates' : 'Join the waitlist'; kind = 'warn'/);
  assert.match(css, /\.banner\.warn \{ background: var\(--warn-soft\)/, 'the existing amber treatment');
  assert.match(css, /--warn: #b25e09; --warn-soft: #fff1dc;/, 'amber tokens');
  assert.match(sheetSrc, /Part of this time is unavailable\. Available time will be reserved, and overlapping time will be added to the waitlist\./, 'one concise notice while editing');
  assert.doesNotMatch(sheetSrc, /Will be reserved|Will be waitlisted|rs-result|rs-split|rs-yours|rangeLines/, 'no live green/amber breakdown in the draft form');
  assert.doesNotMatch(sheetSrc, /Reserved for you|Waitlisted for you/, 'nothing before submission implies it is already reserved');
  assert.match(sheetSrc, /label = edit \? 'Save new dates' : 'Join waitlist'; ok = !same;/, 'a fully unavailable range offers Join waitlist only');
});

test('front end: tapping a calendar day always shows its detail (a sheet, or the day panel scrolled into view and flashed)', () => {
  assert.match(src, /const revealPanel = \(day\) =>/);
  assert.match(src, /panel\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\);\s*\n\s*panel\.classList\.remove\('flash'\)/);
  assert.match(src, /revealPanel\(b\.dataset\.day\);/);
  assert.match(src, /scheduledHtml: reservedDay \? dayHtml\(s0\) : ''/, 'the sheet opened from a scheduled day lists what is on that day');
  assert.match(css, /#calpanel\.flash > \.card:first-child \{ animation: panel-flash/);
});

test('front end: ANY scheduled or partly scheduled day opens the same detail sheet, whoever holds it', () => {
  const click = src.slice(src.indexOf("$('#calgrid').onclick"), src.indexOf("$('#calpanel').onclick")).replace(/\/\/.*$/gm, ''); // (code only, no comments)
  assert.match(click, /\['reserved', 'partial'\]\.includes\(A\[0\]\.days\[i\]\)\) \{/);
  assert.doesNotMatch(click, /\bown\b|\.mine/, 'ownership no longer decides whether a sheet opens');
  assert.match(click, /if \(!canReserve\) \{ keepUrl\(\); paint\(\); daySheet\(st\.day\); return; \}/, 'IT / non-reservable: the same detail, read-only');
  const day = src.slice(src.indexOf('const dayHtml ='), src.indexOf('const daySheet ='));
  for (const h of ['Current asset reservation', 'Your reservation', "'Your waitlist'"]) assert.ok(day.includes(h), h);
  assert.match(day, /calRange\(w, day\)/, 'the waitlist portion is listed with its times');
});

test('front end: time fields are Hour : Minutes + AM/PM (pick or type), blank on open, and an incomplete time is never silently treated as blank', () => {
  const vm = require('node:vm');
  assert.doesNotMatch(sheetSrc, /type="time"/, 'no native time input');
  assert.match(src, /const HOURS = Array\.from\(\{ length: 12 \}/);
  assert.match(src, /const MINUTES = Array\.from\(\{ length: 12 \}, \(_, i\) => String\(i \* 5\)\.padStart\(2, '0'\)\)/, 'minutes: 00, 05 ... 55');
  assert.match(src, /placeholder="\$\{ph\}"/);
  assert.match(src, /part\('th', 'Hour', 'Hr', /); assert.match(src, /part\('tm', 'Minutes', 'Min', /);
  assert.match(src, /data-ap="AM"/); assert.match(src, /data-ap="PM"/);
  assert.match(sheetSrc, /Finish the \$\{half === 'start_time' \? 'pickup' : 'return'\} time \(hour, minutes and AM or PM\), or press Clear to leave it blank\./);
  assert.match(sheetSrc, /\['start_time', 'end_time'\]\.some\(partial\)\) return;/, 'and cannot be submitted');
  const shorten = src.slice(src.indexOf('function shortenSheet('), src.indexOf('// Wires every reservation button'));
  assert.match(shorten, /timeBox\('end_time', r\.end_time \|\| '', 'sc-time'\)/, 'Shorten opens AT the current return time');
  assert.match(shorten, /const ok = !bad && /);
  // the rule the control uses
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(`${src.slice(src.indexOf('function composeTime('), src.indexOf('const timeBox ='))}; this.composeTime = composeTime;`, ctx);
  const c = (...a) => JSON.parse(JSON.stringify(ctx.composeTime(...a)));
  assert.deepEqual(c('', '', ''), { value: '', bad: false }, 'nothing started = genuinely blank');
  assert.deepEqual(c('12', '00', 'PM'), { value: '12:00', bad: false });
  assert.deepEqual(c('12', '00', 'AM'), { value: '00:00', bad: false });
  assert.deepEqual(c('1', '30', 'PM'), { value: '13:30', bad: false });
  assert.deepEqual(c('9', '5', 'AM'), { value: '09:05', bad: false }, 'a custom typed minute');
  assert.deepEqual(c('11', '59', 'PM'), { value: '23:59', bad: false });
  for (const [h, m, ap] of [['1', '', ''], ['1', '30', ''], ['', '30', 'PM'], ['', '', 'PM'], ['13', '00', 'PM'], ['0', '00', 'AM'], ['1', '60', 'PM'], ['1', 'ab', 'PM'], ['1', '', 'PM']]) assert.deepEqual(c(h, m, ap), { value: '', bad: true }, `${h}:${m} ${ap} is started but not a whole time`);
});

test('front end: the day sheet shows the asset\'s schedule neutral, your reservation green and your waitlist amber (subtle, translucent)', () => {
  const day = src.slice(src.indexOf('const dayHtml ='), src.indexOf('const daySheet ='));
  assert.match(day, /\['Current asset reservation', .*?, ''\]/);
  assert.match(day, /\['Your reservation', .*?, ' ok'\]/);
  assert.match(day, /\[isAdmin\(\) \? 'Waitlist' : 'Your waitlist', wl, ' wait'\]/);
  assert.match(css, /\.rs-sched\.ok \{ background: color-mix\(in srgb, var\(--ok\) 13%, transparent\);/);
  assert.match(css, /\.rs-sched\.wait \{ background: color-mix\(in srgb, var\(--warn\) 13%, transparent\);/);
  assert.doesNotMatch(css.match(/\.rs-sched\.(ok|wait) \{[^}]*\}/g).join(''), /--bad|red/, 'never an error colour');
});

test('/api/me tells the screen which zone "now" is read in (APP_TIMEZONE, else the server zone), for the AM/PM default only', async () => {
  const keep = process.env.APP_TIMEZONE;
  const me = await makeLogin('Zone Person');
  try {
    process.env.APP_TIMEZONE = 'Asia/Tokyo';
    assert.equal((await me.client.get('/api/me')).body.appTimezone, 'Asia/Tokyo');
    process.env.APP_TIMEZONE = 'Not/AZone';
    const fallback = (await me.client.get('/api/me')).body.appTimezone;
    assert.ok(fallback && fallback !== 'Not/AZone', 'an invalid zone falls back to the server zone');
    delete process.env.APP_TIMEZONE;
    assert.equal((await me.client.get('/api/me')).body.appTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally { if (keep === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = keep; }
});

test('front end: new optional times default AM/PM from the business clock only once started; existing times load their saved AM/PM; nothing opens by itself', () => {
  const vm = require('node:vm');
  const ctl = src.slice(src.indexOf('function currentAmPm('), src.indexOf('const typeText = (m) =>'));
  assert.match(ctl, /if \(!ap\(\) && \(th\.value \|\| tm\.value\)\) \{ setAp\(currentAmPm\(\)\); autoAp = true; \}/, 'only after an hour or minute is entered');
  assert.match(ctl, /else if \(autoAp && !th\.value && !tm\.value\) \{ setAp\(''\); autoAp = false; \}/, 'taking it back out returns it to blank');
  assert.doesNotMatch(ctl, /addEventListener\('focus', \(\) => \{ openList/, 'a list never opens on focus');
  assert.match(ctl, /addEventListener\('click', \(\) => \{ openList\(l\)/);
  assert.match(src, /:not\(\.th\):not\(\.tm\), select, textarea/, 'a sheet never auto-focuses into a time field');
  // currentAmPm reads the clock in S.appTimezone
  const run = (tz, iso) => { const ctx = { S: { appTimezone: tz }, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [iso])); } } , Intl }; vm.createContext(ctx); vm.runInContext(`${src.slice(src.indexOf('function currentAmPm('), src.indexOf('function composeTime('))}; this.f = currentAmPm;`, ctx); return ctx.f(); };
  assert.equal(run('Asia/Tokyo', '2030-01-15T00:30:00Z'), 'AM', '9:30 AM in Tokyo');
  assert.equal(run('Asia/Tokyo', '2030-01-15T06:30:00Z'), 'PM', '3:30 PM in Tokyo');
  assert.equal(run('Pacific/Honolulu', '2030-01-15T06:30:00Z'), 'PM', '8:30 PM the evening before in Honolulu');
  assert.equal(run('Pacific/Honolulu', '2030-01-15T20:30:00Z'), 'AM', '10:30 AM in Honolulu');
  // an existing value loads its own AM/PM
  const box = src.slice(src.indexOf('const timeBox ='), src.indexOf('// Wires every .tbox'));
  assert.match(box, /aria-pressed="\$\{m && h < 12 \? 'true' : 'false'\}"/);
  assert.match(box, /aria-pressed="\$\{m && h >= 12 \? 'true' : 'false'\}"/);
});

test('front end: Requests has an All tab first for employees (their default), the waitlist title opens the same edit sheet, and the redundant notice is gone', () => {
  const view = src.slice(src.indexOf('async function viewRequests('), src.indexOf('function noteSheet('));
  assert.match(view, /const tabs = isAdmin\(\) \? \['open', 'closed', 'reservations'\] : \['all', 'open', 'closed', 'reservations'\];/, 'IT is unchanged');
  assert.match(view, /state = \{ tab: tabs\.includes\(qs\(\)\.get\('tab'\)\) \? qs\(\)\.get\('tab'\) : tabs\[0\]/, 'the first tab is the default');
  assert.match(view, /\$\{isAdmin\(\) \? '' : '<button data-v="all">All<\/button>'\}<button data-v="open">Open<\/button><button data-v="closed">Closed<\/button><button data-v="reservations">Reservations<\/button>/, 'the existing tabs are kept');
  assert.match(view, /\.\.\.\(await api\('GET', '\/api\/requests\?status=open'\)\), \.\.\.\(await api\('GET', '\/api\/requests\?status=closed'\)\)/, 'requests, open then closed');
  assert.match(view, /\$\{extra \? extra\.html : ''\}/, 'then the same reservation and waitlist cards');
  const wl = src.slice(src.indexOf('function waitlistItem('), src.indexOf('// ONE date sheet'));
  assert.match(wl, /w\.can_edit \? `<a href="#" class="title" data-wl-edit="\$\{w\.id\}">/, 'the title carries the same data-wl-edit as the Edit dates button');
  assert.match(wl, /<button class="btn sm" data-wl-edit="\$\{w\.id\}">Edit dates<\/button>/, 'and the button stays');
  assert.doesNotMatch(src, /These are your current dates/);
  assert.match(sheetSrc, /Changing your dates updates your place in line\./);
});

test('front end: reservation and waitlist cards open their details; Cancel and Shorten live inside Reservation details (there is no extend)', () => {
  const sheet = src.slice(src.indexOf('function reservationSheet('), src.indexOf('// Shorten: the reservation\'s own days'));
  assert.match(sheet, /<h2>Reservation details<\/h2>/);
  for (const k of ["'Asset'", "'Status'", "'Pickup'", "'Return'"]) assert.ok(sheet.includes(`row(${k}`), k);
  assert.match(sheet, /at\(r\.start_date, r\.start_time, 'no pickup time'\)/); assert.match(sheet, /at\(r\.end_date, r\.end_time, 'no return time'\)/);
  assert.match(sheet, /Shorten reservation<\/button>/); assert.match(sheet, /Cancel reservation<\/button>/);
  assert.match(sheet, /shortenSheet\(r, reload\)/, 'the existing Shorten flow');
  assert.match(sheet, /\/api\/reservations\/\$\{r\.id\}\/cancel/, 'cancel is confirmed first, then the existing endpoint');
  assert.doesNotMatch(sheet, /[Ee]xtend/, 'no extension in this slice');
  const wire = src.slice(src.indexOf('function wireReservationActions('), src.indexOf('// ---- waitlist (slice 8)'));
  assert.match(wire, /each\('\[data-resv-edit\]', 'resvEdit', details\)/, 'Edit reservation opens the same details');
  assert.match(wire, /if \(e\.target\.closest\('a,button'\)\) return;\s*open\(\);/, 'controls inside the card never trigger the card click');
  const wl = src.slice(src.indexOf('function wireWaitlistActions('), src.indexOf('// ============================================================ availability calendar'));
  assert.match(wl, /\$\$\('\[data-wl-card\]', root\)/, 'a waitlist card opens the existing Edit waitlist dates sheet');
  assert.match(src, /const cardClick = !forAdmin && w\.can_edit \?/, 'only while it can be edited');
});

test('front end: the desktop sidebar stays visible while the page scrolls, at the real top-bar height', () => {
  const rule = css.match(/\.sidebar \{ display: block;[^}]*\}/)[0];
  assert.match(rule, /position: sticky/);
  assert.match(rule, /align-self: flex-start/);
  assert.match(rule, /top: var\(--topbar-h, 56px\)/);
  assert.match(rule, /height: calc\(100vh - var\(--topbar-h, 56px\)\)/);
});
