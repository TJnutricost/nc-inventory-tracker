// Waitlist + availability holds + targeted emails + IT email identity (Phase 2, slice 8). Everything is enforced on the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, makeClient, setupAdmin, asReservation } = require('./helpers');

let server, db, admin, waitlist, mailer;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
  waitlist = require('../src/waitlist');
  mailer = require('../src/mailer');
});
after(() => stopServer(server));

let seq = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
async function newAsset(name, extra = {}) {
  const r = await admin.post('/api/assets', { name, tag: `WL-${++seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const email = `wl${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true, department: 'Marketing' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email };
}
const reserve = async (who, asset, start, end) => asReservation(await who.client.post(`/api/assets/${asset.id}/reservations`, { start_date: start, end_date: end }));
async function okReserve(who, asset, start, end) { const r = await reserve(who, asset, start, end); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const joinWl = (who, asset, start, end) => who.client.post(`/api/assets/${asset.id}/waitlist`, { start_date: start, end_date: end });
async function okJoin(who, asset, start, end) { const r = await joinWl(who, asset, start, end); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const entryOf = async (who, id) => (await (who.client || who).get(`/api/waitlist/${id}`)).body;
const phaseOf = async (who, id) => (await entryOf(who, id)).phase;
const mailsTo = (who, like = '%') => db.prepare('SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE ? ORDER BY id').all(who.email, like);
const tick = () => new Promise((r) => setTimeout(r, 25));
const expireHold = (id) => db.prepare("UPDATE waitlist_entries SET hold_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);

// A reserved asset with an owner and a waiting line: the usual stage.
async function stage({ approval = false } = {}) {
  const asset = await newAsset(`Camera ${++seq}`, approval ? { reservation_requires_approval: true } : {});
  const owner = await makeLogin('Olive Owner');
  const w1 = await makeLogin('Wade One');
  const w2 = await makeLogin('Wren Two');
  let resv;
  if (approval) { // the owner's reservation must be CONFIRMED to block: submit then approve
    const r = await okReserve(owner, asset, plus(10), plus(12));
    assert.equal((await admin.post(`/api/reservations/${r.id}/approve`, {})).status, 200);
    resv = r;
  } else resv = await okReserve(owner, asset, plus(10), plus(12));
  return { asset, owner, w1, w2, resv };
}

// ---------------------------------------------------------------- joining
test('joining: allowed only when ALL of the requested time is unavailable, with clear refusals otherwise', async () => {
  const { asset, owner, w1 } = await stage();
  const e = await okJoin(w1, asset, plus(10), plus(12));
  assert.equal(e.phase, 'waiting');
  assert.equal(e.mine, true);
  assert.equal(e.position, 1);
  assert.equal(e.asset_name, asset.name);
  assert.deepEqual([e.start_date, e.end_date], [plus(10), plus(12)]);
  // part of the time free: that is a reservation (the free time is reserved, the rest waitlisted), not a join
  const w3 = await makeLogin('Part Overlap');
  const mixed = await joinWl(w3, asset, plus(12), plus(15));
  assert.equal(mixed.status, 409);
  assert.match(mixed.body.error, /part of that time is available/i);
  assert.equal((await joinWl(w3, asset, plus(12), plus(12))).status, 200, 'the one taken day is a pure waitlist request');
  // free dates -> reserve instead
  const free = await joinWl(w1, asset, plus(20), plus(21));
  assert.equal(free.status, 409);
  assert.match(free.body.error, /available.*reserve/i);
  // duplicate / overlapping own entry
  assert.equal((await joinWl(w1, asset, plus(11), plus(11))).status, 409);
  // the owner cannot waitlist behind their own reservation
  assert.equal((await joinWl(owner, asset, plus(10), plus(12))).status, 409);
  // past dates, bad dates
  assert.equal((await joinWl(w1, asset, plus(-3), plus(-1))).status, 400);
  assert.equal((await joinWl(w1, asset, 'soon', plus(12))).status, 400);
  assert.equal((await joinWl(w1, asset, plus(12), plus(10))).status, 400);
  // an item that is checked out is unavailable too: its time is waitlist time even though nobody reserved it
  const out = await newAsset('Checked out only');
  const holder = await makeLogin('Holder');
  assert.equal((await admin.post(`/api/assets/${out.id}/checkout`, { employee_id: holder.id })).status, 200);
  assert.equal((await joinWl(w1, out, plus(1), plus(3))).status, 200);
  // an item that is not in the shared pool does not exist for employees
  const hidden = await newAsset('Not shared', { available_to_request: false });
  assert.equal((await joinWl(w1, hidden, plus(1), plus(2))).status, 404);
});

test('FIFO: the line is ordered by when people joined; each person sees their own position', async () => {
  const { asset, w1, w2 } = await stage();
  const a = await okJoin(w1, asset, plus(10), plus(12));
  const b = await okJoin(w2, asset, plus(11), plus(12));
  assert.equal((await entryOf(w1, a.id)).position, 1);
  assert.equal((await entryOf(w2, b.id)).position, 2);
});

test('the current reserver is untouched by someone joining, and there is no way to make them release anything', async () => {
  const { asset, owner, w1, resv } = await stage();
  const e = await okJoin(w1, asset, plus(10), plus(12));
  const mine = (await owner.client.get('/api/reservations')).body.find((r) => r.id === resv.id);
  assert.equal(mine.status, 'confirmed');
  assert.equal(mine.phase, 'upcoming');
  assert.equal(mine.end_date, plus(12));
  // the waiting employee has no power over it
  for (const url of ['cancel', 'shorten', 'approve', 'decline']) assert.notEqual((await w1.client.post(`/api/reservations/${resv.id}/${url}`, { end_date: plus(11) })).status, 200, url);
  assert.equal((await w1.client.post(`/api/reservations/${resv.id}/cancel`, {})).status, 403);
  // there is no release / request-release / transfer endpoint at all
  for (const url of ['release', 'release-request', 'request-release', 'transfer']) {
    assert.equal((await w1.client.post(`/api/reservations/${resv.id}/${url}`, {})).status, 404, url);
    assert.equal((await w1.client.post(`/api/waitlist/${e.id}/${url}`, {})).status, 404, url);
  }
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(resv.id).status, 'confirmed');
});

// ---------------------------------------------------------------- holds
test('when the dates free up the next person is offered a hold (24 hours for something days away); nothing is reserved automatically', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  assert.equal((await owner.client.post(`/api/reservations/${resv.id}/cancel`, {})).status, 200);
  const h = await entryOf(w1, e1.id);
  assert.equal(h.phase, 'held');
  assert.ok(h.hold_expires_at);
  assert.equal(h.can_confirm, true);
  assert.equal(h.can_decline, true);
  const hours = db.prepare('SELECT (julianday(hold_expires_at) - julianday(hold_started_at)) * 24 AS h FROM waitlist_entries WHERE id = ?').get(e1.id).h;
  assert.ok(Math.abs(hours - 24) < 0.01, `hold is 24 hours, got ${hours}`);
  assert.equal(await phaseOf(w2, e2.id), 'waiting');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ? AND status IN ('pending','confirmed')").get(asset.id).c, 0, 'no reservation was created');
});

test('an active hold makes its exact time unavailable: others are cut around it (free time reserved, held time waitlisted), the held person\'s own plain reserve points at Confirm; the calendar shows the days as held', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const outsider = await makeLogin('Out Sider');
  const refused = await reserve(outsider, asset, plus(11), plus(11));
  assert.equal(refused.status, 409, 'a hold is the next person\'s priority: that time is unavailable, so it can only be waitlisted');
  assert.match(refused.body.error, /priority hold/i);
  const partial = await reserve(w2, asset, plus(12), plus(14));
  assert.equal(partial.status, 200, 'the part outside the hold is reserved');
  assert.deepEqual(partial.body.group.reserved.map((r) => [r.start_date, r.end_date]), [[plus(13), plus(14)]]);
  assert.deepEqual(partial.body.group.waitlisted.map((x) => [x.start_date, x.end_date]), [[plus(12), plus(12)]], 'and the held day waits');
  const own = await reserve(w1, asset, plus(10), plus(12));
  assert.equal(own.status, 409);
  assert.match(own.body.error, /confirm/i);
  assert.equal((await reserve(outsider, asset, plus(15), plus(16))).status, 200, 'dates outside the hold are simply reserved');
  // the calendar: held days are taken for everyone; only the held person gets their entry id and deadline, and nobody else learns who holds
  const m = plus(10).slice(0, 7);
  const asOutsider = (await outsider.client.get(`/api/availability?asset=${asset.id}&month=${m}`)).body.assets[0];
  assert.equal(asOutsider.days[Number(plus(11).slice(8)) - 1], 'reserved');
  assert.deepEqual(asOutsider.holds.map((x) => ({ ...x })), [{ start: plus(10), start_time: null, end: plus(12), end_time: null, mine: false }]);
  assert.deepEqual(asOutsider.waitlist, []);
  const asHolder = (await w1.client.get(`/api/availability?asset=${asset.id}&month=${m}`)).body.assets[0];
  assert.equal(asHolder.holds[0].mine, true);
  assert.equal(asHolder.holds[0].id, e1.id);
  assert.ok(asHolder.holds[0].hold_expires_at);
  assert.equal(asHolder.waitlist.length, 1);
  const asAdmin = (await admin.get(`/api/availability?asset=${asset.id}&month=${m}`)).body.assets[0];
  assert.equal(asAdmin.holds[0].holder.name, 'Wade One');
  assert.equal(asAdmin.waitlist.length, 2, 'the holder and the person waitlisted behind the held day');
  assert.equal(asAdmin.reserve.allowed, false, 'IT does not reserve from the calendar');
});

test('an expired hold blocks nothing, even before the sweep has run', async () => {
  const { asset, owner, w1, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  expireHold(e1.id); // (no sweep yet)
  const outsider = await makeLogin('Quick Outsider');
  assert.equal((await reserve(outsider, asset, plus(10), plus(12))).status, 200);
  assert.equal(await phaseOf(w1, e1.id), 'expired');
});

// ---------------------------------------------------------------- confirm / decline / expire
test('confirming a hold creates a normal CONFIRMED reservation when the asset needs no approval', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const c = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.reservation.status, 'confirmed');
  assert.equal(c.body.entry.phase, 'confirmed');
  assert.equal(db.prepare('SELECT waitlist_entry_id w FROM reservations WHERE id = ?').get(c.body.reservation.id).w, e1.id);
  assert.equal(await phaseOf(w2, e2.id), 'waiting', 'the next person stays in line behind a confirmed reservation');
  assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 400, 'cannot confirm twice');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ? AND status = 'confirmed'").get(asset.id).c, 1);
});

test('approval-required assets: confirming makes a PENDING reservation, the line does not move, and IT\'s decision then settles it', async () => {
  const { asset, owner, w1, w2, resv } = await stage({ approval: true });
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const c = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.reservation.status, 'pending');
  assert.equal(c.body.entry.phase, 'pending');
  waitlist.sweep(db);
  assert.equal(await phaseOf(w2, e2.id), 'waiting', 'a pending reservation made from a hold keeps its place: nobody else is offered those dates');
  // IT approves -> confirmed
  assert.equal((await admin.post(`/api/reservations/${c.body.reservation.id}/approve`, {})).status, 200);
  assert.equal(await phaseOf(w1, e1.id), 'confirmed');
  assert.equal(await phaseOf(w2, e2.id), 'waiting');
});

test('approval-required assets: when IT declines the reservation made from a hold, the dates go to the next in line', async () => {
  const { asset, owner, w1, w2, resv } = await stage({ approval: true });
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const c = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal((await admin.post(`/api/reservations/${c.body.reservation.id}/decline`, { note: 'no' })).status, 200);
  assert.equal(await phaseOf(w1, e1.id), 'reservation_declined');
  assert.equal(await phaseOf(w2, e2.id), 'held');
});

test('declining a hold releases it and the next eligible person is offered it', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const d = await w1.client.post(`/api/waitlist/${e1.id}/decline`, {});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.phase, 'declined');
  assert.equal(await phaseOf(w2, e2.id), 'held');
  assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/decline`, {})).status, 400, 'already closed');
  assert.equal(mailsTo(w2, 'Available for you%').length, 1);
});

test('an expired hold releases the dates and the next eligible person is offered them; a late confirm is refused', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(w1, e1.id), 'held');
  expireHold(e1.id);
  assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 409, 'too late');
  assert.equal(await phaseOf(w1, e1.id), 'expired');
  assert.equal(await phaseOf(w2, e2.id), 'held', 'the queue did not stay stuck behind the lapsed hold');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ? AND status IN ('pending','confirmed')").get(asset.id).c, 0);
});

test('the sweep alone moves the queue past an expired hold', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  expireHold(e1.id);
  waitlist.sweep(db);
  assert.equal(await phaseOf(w1, e1.id), 'expired');
  assert.equal(await phaseOf(w2, e2.id), 'held');
});

test('an older entry that is still wholly blocked does not hold up a younger one whose range is free', async () => {
  const asset = await newAsset(`Projector ${++seq}`);
  const o1 = await makeLogin('Owner One'); const o2 = await makeLogin('Owner Two');
  const old = await makeLogin('Older Waiter'); const young = await makeLogin('Younger Waiter');
  const r1 = await okReserve(o1, asset, plus(10), plus(12));
  await okReserve(o2, asset, plus(13), plus(14));
  const eOld = await okJoin(old, asset, plus(13), plus(14)); // blocked by owner two
  const eYoung = await okJoin(young, asset, plus(10), plus(12)); // blocked by owner one
  await o1.client.post(`/api/reservations/${r1.id}/cancel`, {});
  assert.equal(await phaseOf(old, eOld.id), 'waiting', 'still blocked by owner two');
  assert.equal(await phaseOf(young, eYoung.id), 'held');
});

test('overlapping entries are served in FIFO order, and entries for different dates can hold at the same time', async () => {
  const asset = await newAsset(`Tripod ${++seq}`);
  const o = await makeLogin('Big Owner');
  const a = await makeLogin('First A'); const b = await makeLogin('Second B'); const c = await makeLogin('Third C');
  const big = await okReserve(o, asset, plus(10), plus(20));
  const eA = await okJoin(a, asset, plus(10), plus(12));
  const eB = await okJoin(b, asset, plus(11), plus(12)); // inside A's range, younger
  const eC = await okJoin(c, asset, plus(16), plus(18)); // independent
  await o.client.post(`/api/reservations/${big.id}/cancel`, {});
  assert.equal(await phaseOf(a, eA.id), 'held');
  assert.equal(await phaseOf(b, eB.id), 'waiting', 'A is ahead and overlaps');
  assert.equal(await phaseOf(c, eC.id), 'held', 'C does not overlap anyone ahead');
});

test('shortening a reservation hands the freed days to the waitlist when the whole requested range is free', async () => {
  const { asset, owner, w1, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(12), plus(12));
  assert.equal(await phaseOf(w1, e1.id), 'waiting');
  assert.equal((await owner.client.post(`/api/reservations/${resv.id}/shorten`, { end_date: plus(11) })).status, 200);
  assert.equal(await phaseOf(w1, e1.id), 'held');
});

test('if the dates stop being reservable before the hold is confirmed, confirming is refused and the entry goes back in line', async () => {
  const { asset, owner, w1, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(asset.id);
  const r = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no longer available/i);
  assert.equal(await phaseOf(w1, e1.id), 'waiting');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ? AND status IN ('pending','confirmed')").get(asset.id).c, 0);
  db.prepare("UPDATE assets SET status = 'available' WHERE id = ?").run(asset.id);
  waitlist.sweep(db); // and when it is lendable again the line moves on its own
  assert.equal(await phaseOf(w1, e1.id), 'held');
});

// ---------------------------------------------------------------- leaving, ownership, admin
test('an employee can leave their own place; leaving a hold passes it on; nobody else can touch it', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  // another employee cannot read, confirm, decline or cancel it
  assert.equal((await w2.client.get(`/api/waitlist/${e1.id}`)).status, 403);
  assert.equal((await w2.client.post(`/api/waitlist/${e1.id}/cancel`, {})).status, 403);
  assert.equal((await w2.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 403);
  assert.equal((await w2.client.post(`/api/waitlist/${e1.id}/decline`, {})).status, 403);
  assert.equal(await phaseOf(w1, e1.id), 'waiting');
  assert.equal((await w2.client.get('/api/waitlist')).body.length, 1, 'a list shows only your own entries');
  // w1 leaves while waiting
  const left = await w1.client.post(`/api/waitlist/${e1.id}/cancel`, {});
  assert.equal(left.status, 200);
  assert.equal(left.body.phase, 'left');
  assert.equal(left.body.position, null);
  assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/cancel`, {})).status, 400, 'already closed');
  // w2 now gets the dates when they free up; leaving the hold passes it along
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(w2, e2.id), 'held');
  const w3 = await makeLogin('Late Third');
  // (a hold covers the dates, so w3 can queue behind it)
  const e3 = await okJoin(w3, asset, plus(10), plus(12));
  assert.equal((await w2.client.post(`/api/waitlist/${e2.id}/cancel`, {})).status, 200);
  assert.equal(await phaseOf(w3, e3.id), 'held');
});

test('IT sees the whole line with names, hold deadlines and FIFO position; can remove an entry; cannot answer for an employee or reorder', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  const all = (await admin.get('/api/waitlist?status=open')).body.filter((x) => x.asset_id === asset.id);
  assert.deepEqual(all.map((x) => x.employee_name), ['Wade One', 'Wren Two']);
  assert.deepEqual(all.map((x) => x.position), [1, 2]);
  assert.ok(all[0].employee_department);
  assert.equal(all[0].can_remove, true);
  assert.equal(all[0].can_confirm, false);
  // an employee's list carries no one else's name
  const mine = (await w1.client.get('/api/waitlist')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].employee_name, undefined);
  assert.equal((await owner.client.get('/api/waitlist')).body.length, 0, 'the current reserver is not on a list just because someone waits');
  // IT cannot answer on the employee's behalf
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(admin, e1.id), 'held');
  assert.equal((await admin.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 403);
  assert.equal((await admin.post(`/api/waitlist/${e1.id}/decline`, {})).status, 403);
  const held = (await admin.get(`/api/waitlist/${e1.id}`)).body;
  assert.ok(held.hold_expires_at);
  // no reorder / priority endpoint exists
  assert.equal((await admin.put(`/api/waitlist/${e2.id}`, { position: 1 })).status, 403, 'IT cannot change anyone\'s entry, let alone its position');
  assert.equal((await admin.post(`/api/waitlist/${e2.id}/move`, { position: 1 })).status, 404);
  // IT removes the held entry: it closes as removed and the next person is offered the dates
  const rm = await admin.post(`/api/waitlist/${e1.id}/cancel`, {});
  assert.equal(rm.status, 200);
  assert.equal(rm.body.phase, 'removed');
  assert.equal(await phaseOf(w2, e2.id), 'held');
  assert.equal((await admin.post(`/api/waitlist/${e1.id}/cancel`, {})).status, 400, 'a closed entry cannot be removed again');
  assert.equal((await admin.get('/api/waitlist?status=closed')).body.some((x) => x.id === e1.id), true);
  assert.equal((await admin.get('/api/waitlist?status=bogus')).status, 400);
  // an employee cannot use the admin removal on someone else's entry
  assert.equal((await w1.client.post(`/api/waitlist/${e2.id}/cancel`, {})).status, 403);
});

// ---------------------------------------------------------------- emails
test('joining emails the current reserver once, informationally, with no release request; hold emails go to the held person only', async () => {
  const { asset, owner, w1, resv } = await stage();
  const second = await okReserve(owner, asset, plus(13), plus(15)); // a second, adjacent reservation by the same person must not double the email
  const before = mailsTo(owner, 'Another team%').length;
  const e1 = await okJoin(w1, asset, plus(10), plus(15));
  const mails = mailsTo(owner, 'Another team%');
  assert.equal(mails.length - before, 1, 'one email per distinct current reserver, even with two overlapping reservations');
  const body = mails[mails.length - 1].body;
  assert.match(body, /Wade One/);
  assert.match(body, /No action is needed/);
  assert.match(body, new RegExp(asset.tag));
  assert.doesNotMatch(body, /release|give up|hand over|transfer/i);
  assert.equal(mailsTo(w1, 'Another team%').length, 0, 'the person who joined is not told they are blocked');
  assert.equal(mailsTo(w1, 'Available for you%').length, 0);
  // the hold email
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(w1, e1.id), 'held', 'the freed part (the first reservation\'s days) is offered; the second reservation still blocks the rest');
  assert.equal(mailsTo(w1, 'Available for you%').length, 1);
  await owner.client.post(`/api/reservations/${second.id}/cancel`, {});
  assert.equal(mailsTo(w1, 'Available for you%').length, 2, 'and the rest is offered when it frees (one email per held piece)');
  assert.equal(mailsTo(owner, 'Available for you%').length, 0, 'the former reserver gets no hold email');
});

test('the hold email carries asset, tag, dates, expiry and the confirm instruction, and is sent exactly once however often the queue is re-evaluated', async () => {
  const { asset, owner, w1, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  for (let i = 0; i < 4; i++) { waitlist.sweep(db); waitlist.processDue(db); waitlist.dispatchHoldEmails(db); }
  await w1.client.get('/api/waitlist'); await w1.client.get(`/api/waitlist/${e1.id}`);
  const mails = mailsTo(w1, 'Available for you%');
  assert.equal(mails.length, 1, 'no duplicates');
  const b = mails[0].body;
  assert.match(mails[0].subject, new RegExp(asset.tag));
  assert.match(b, new RegExp(asset.name));
  assert.match(b, new RegExp(`Tag ${asset.tag}`));
  assert.match(b, /Available for you until/);
  assert.match(b, /Confirm/);
  assert.match(b, /Decline/);
  assert.match(b, /next person in line/);
  assert.doesNotMatch(b, /24 hours|24-hour/, 'the window is stated as a time, not a fixed 24 hours');
  assert.match(b, /#\/requests\?tab=reservations/);
  assert.equal(mails[0].status, 'logged'); // (no SMTP in tests)
  // a fresh hold (after an expiry) is a new event and does get its own email
  const w2 = await makeLogin('Next Waiter');
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  assert.equal(await phaseOf(w2, e2.id), 'waiting');
  expireHold(e1.id); waitlist.sweep(db); waitlist.sweep(db);
  assert.equal(await phaseOf(w2, e2.id), 'held');
  assert.equal(mailsTo(w2, 'Available for you%').length, 1);
  assert.equal(mailsTo(w1, 'Available for you%').length, 1);
});

test('the hold email for an approval-required asset says it goes to IT', async () => {
  const { asset, owner, w1, resv } = await stage({ approval: true });
  await okJoin(w1, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.match(mailsTo(w1, 'Available for you%')[0].body, /IT for approval/);
});

test('an email problem never changes waitlist or reservation state (a throwing hook, and a failing SMTP transport)', async () => {
  // 1. the notification hooks themselves blow up
  const { notify } = mailer;
  const saved = { j: notify.waitlistJoined, h: notify.waitlistHold };
  notify.waitlistJoined = () => { throw new Error('boom: joined'); };
  notify.waitlistHold = () => { throw new Error('boom: hold'); };
  try {
    const { asset, owner, w1, resv } = await stage();
    const e1 = await okJoin(w1, asset, plus(10), plus(12));
    assert.equal(await phaseOf(w1, e1.id), 'waiting', 'joined despite the failed notice');
    assert.equal((await owner.client.post(`/api/reservations/${resv.id}/cancel`, {})).status, 200);
    assert.equal(await phaseOf(w1, e1.id), 'held', 'the hold exists despite the failed email');
    const c = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
    assert.equal(c.status, 200);
    assert.equal(c.body.reservation.status, 'confirmed');
  } finally { notify.waitlistJoined = saved.j; notify.waitlistHold = saved.h; }
  // 2. a real transport that rejects every message: recorded as failed in the outbox, state intact
  mailer.setTransportForTests({ sendMail: async () => { throw new Error('smtp down'); } });
  try {
    const { asset, owner, w1, resv } = await stage();
    const e1 = await okJoin(w1, asset, plus(10), plus(12));
    await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
    await tick();
    assert.equal(await phaseOf(w1, e1.id), 'held');
    assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 200);
    await tick();
    const failed = mailsTo(w1, 'Available for you%');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 'failed');
    assert.match(failed[0].error, /smtp down/);
    waitlist.sweep(db); await tick();
    assert.equal(mailsTo(w1, 'Available for you%').length, 1, 'a failed send is not retried into duplicates');
  } finally { mailer.setTransportForTests(null); }
});

// ---------------------------------------------------------------- IT email identity
test('IT email settings: stored through the existing settings API, validated on the server, all-or-nothing', async () => {
  const g = (await admin.get('/api/settings')).body;
  assert.equal(g.it_email_name, 'Nutricost IT');
  assert.equal(g.it_contact_email, '');
  const ok = await admin.put('/api/settings', { it_email_name: '  Nutricost IT Desk ', it_contact_email: ' IT.Contact@Example.com ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.it_email_name, 'Nutricost IT Desk');
  assert.equal(ok.body.it_contact_email, 'it.contact@example.com');
  assert.equal((await admin.get('/api/settings')).body.it_contact_email, 'it.contact@example.com', 'persisted');
  for (const bad of ['nope', 'a@b', 'a b@c.com', 'a@b.com,c@d.com', 'x@y.com\r\nBcc: z@z.com', '<a@b.com>', 'a@b.com;c@d.com', 42, ['a@b.com'], { a: 1 }]) {
    const r = await admin.put('/api/settings', { it_contact_email: bad, it_email_name: 'Should Not Save' });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  for (const bad of ['', '   ', 'x'.repeat(81), 'Evil\r\nBcc: a@b.com', 'A <b>', 'Say "hi"', null, 7]) {
    assert.equal((await admin.put('/api/settings', { it_email_name: bad })).status, 400, JSON.stringify(bad));
  }
  const after = (await admin.get('/api/settings')).body;
  assert.equal(after.it_email_name, 'Nutricost IT Desk', 'a rejected request saved nothing, including its valid half');
  assert.equal(after.it_contact_email, 'it.contact@example.com');
  // clearing the contact address is allowed; unrelated settings still work in the same call
  const clr = await admin.put('/api/settings', { it_contact_email: '', tag_prefix: 'ZZ-' });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.it_contact_email, '');
  assert.equal(clr.body.tag_prefix, 'ZZ-');
  await admin.put('/api/settings', { tag_prefix: 'NC-', it_email_name: 'Nutricost IT' });
});

test('IT email settings are admin-only and are not part of an employee\'s session data', async () => {
  const emp = await makeLogin('Plain Employee');
  assert.equal((await emp.client.put('/api/settings', { it_email_name: 'Hacked' })).status, 403);
  assert.equal((await emp.client.get('/api/settings')).status, 403);
  const me = (await emp.client.get('/api/me')).body;
  assert.equal(me.settings.it_email_name, undefined);
  assert.equal(me.settings.it_contact_email, undefined);
  assert.ok(me.settings.tag_prefix, 'the shared settings are still there');
  assert.ok((await admin.get('/api/me')).body.settings.it_email_name, 'IT sees it');
});

test('credentials can never be stored through the settings API', async () => {
  for (const key of ['smtp_pass', 'SMTP_PASSWORD', 'gmail_password', 'app_password', 'api_key', 'apiKey', 'oauth_client_secret', 'client_secret', 'smtp_user', 'mail_token', 'credentials']) {
    const r = await admin.put('/api/settings', { [key]: 'hunter2-super-secret', it_email_name: 'Nutricost IT' });
    assert.equal(r.status, 400, key);
    assert.match(r.body.error, /environment/);
  }
  const keys = db.prepare('SELECT key FROM settings').all().map((r) => r.key);
  assert.deepEqual(keys.filter((k) => /pass|secret|token|key|smtp|credential|oauth/i.test(k)), [], 'no credential-like row exists');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes('hunter2'), false);
  const body = JSON.stringify((await admin.get('/api/settings')).body);
  assert.equal(body.includes('hunter2'), false);
  assert.equal(/SMTP_PASS|pass/i.test(Object.keys((await admin.get('/api/settings')).body).join(' ')), false, 'the settings API exposes no password field');
});

test('From / Reply-To: the verified sender stays the From address; the IT contact is the Reply-To; an operator flag may promote it', async () => {
  const keep = { MAIL_FROM: process.env.MAIL_FROM, SMTP_USER: process.env.SMTP_USER, MAIL_ALLOW_IT_FROM: process.env.MAIL_ALLOW_IT_FROM };
  const sent = [];
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  try {
    process.env.MAIL_FROM = '"Old Name" <verified@nutricost.com>';
    delete process.env.MAIL_ALLOW_IT_FROM;
    await admin.put('/api/settings', { it_email_name: 'IT Desk', it_contact_email: 'me@nutricost.com' });
    assert.deepEqual(mailer.mailEnvelope(), { from: { name: 'IT Desk', address: 'verified@nutricost.com' }, replyTo: 'me@nutricost.com' });
    await mailer.notify.test('someone@nutricost.com');
    assert.deepEqual(sent[0].from, { name: 'IT Desk', address: 'verified@nutricost.com' }, 'never a From the provider has not verified');
    assert.equal(sent[0].replyTo, 'me@nutricost.com');
    process.env.MAIL_ALLOW_IT_FROM = '1';
    assert.deepEqual(mailer.mailEnvelope(), { from: { name: 'IT Desk', address: 'me@nutricost.com' }, replyTo: undefined });
    delete process.env.MAIL_ALLOW_IT_FROM;
    await admin.put('/api/settings', { it_contact_email: 'VERIFIED@nutricost.com' });
    assert.equal(mailer.mailEnvelope().replyTo, undefined, 'no Reply-To when it is the same mailbox as the sender');
    await admin.put('/api/settings', { it_contact_email: '' });
    assert.equal(mailer.mailEnvelope().replyTo, undefined);
    delete process.env.MAIL_FROM; process.env.SMTP_USER = 'smtpuser@nutricost.com';
    assert.equal(mailer.mailEnvelope().from.address, 'smtpuser@nutricost.com');
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    mailer.setTransportForTests(null);
    await admin.put('/api/settings', { it_email_name: 'Nutricost IT', it_contact_email: '' });
  }
});

// ---------------------------------------------------------------- migration
test('migration 14 adds waitlist_entries and reservations.waitlist_entry_id without disturbing existing reservations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wl-mig-'));
  const d = new Database(path.join(dir, 'assets.db'));
  d.pragma('foreign_keys = ON');
  const { runMigrations } = require('../src/migrate');
  const all = require('../src/migrations');
  runMigrations(d, all.filter((m) => m.id <= 13));
  const emp = d.prepare("INSERT INTO employees (name) VALUES ('E')").run().lastInsertRowid;
  const asset = d.prepare("INSERT INTO assets (tag, name, available_to_request) VALUES ('M-1', 'Thing', 1)").run().lastInsertRowid;
  d.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, '2030-01-10', '2030-01-12', 'confirmed', 0)").run(asset, emp);
  assert.deepEqual(runMigrations(d, all.filter((m) => m.id <= 14)), [14]);
  assert.equal(d.prepare('SELECT waitlist_entry_id w FROM reservations').get().w, null);
  const ins = (status, extra = '') => d.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date, status${extra ? ', hold_started_at, hold_expires_at' : ''}) VALUES (?, ?, '2030-01-10', '2030-01-12', ?${extra ? ", datetime('now'), datetime('now','+24 hours')" : ''})`).run(asset, emp, status);
  assert.doesNotThrow(() => ins('waiting'));
  assert.doesNotThrow(() => ins('held', true));
  assert.throws(() => ins('held'), /CHECK/, 'a hold must carry its timestamps');
  assert.throws(() => ins('bogus'), /CHECK/);
  assert.throws(() => ins('expired'), /CHECK/, 'a closed entry must say when it closed');
  assert.throws(() => d.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date) VALUES (?, ?, '2030-01-12', '2030-01-10')").run(asset, emp), /CHECK/);
  assert.throws(() => d.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date) VALUES (?, ?, 'soon', '2030-01-10')").run(asset, emp), /CHECK/);
  assert.equal(d.prepare('SELECT status FROM waitlist_entries ORDER BY id LIMIT 1').get().status, 'waiting', 'default status');
});

// ================================================================ QA round 1
test('migration 15 gives existing waitlist rows a FIFO key in their creation order and adds outbox.delivered_to', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wl-mig15-'));
  const d = new Database(path.join(dir, 'assets.db'));
  d.pragma('foreign_keys = ON');
  const { runMigrations } = require('../src/migrate');
  const all = require('../src/migrations');
  runMigrations(d, all.filter((m) => m.id <= 14));
  const emp = d.prepare("INSERT INTO employees (name) VALUES ('E')").run().lastInsertRowid;
  const asset = d.prepare("INSERT INTO assets (tag, name, available_to_request) VALUES ('M-1', 'Thing', 1)").run().lastInsertRowid;
  const ins = () => d.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date) VALUES (?, ?, '2030-01-10', '2030-01-12')").run(asset, emp).lastInsertRowid;
  const a = ins(); const b = ins();
  d.prepare("INSERT INTO outbox (to_addr, subject, body, status) VALUES ('x@y.com', 's', 'b', 'logged')").run();
  assert.deepEqual(runMigrations(d, all.filter((m) => m.id <= 15)), [15]);
  const rows = d.prepare('SELECT id, queue_seq, queued_at, created_at FROM waitlist_entries ORDER BY queue_seq').all();
  assert.deepEqual(rows.map((r) => r.id), [a, b]);
  assert.deepEqual(rows.map((r) => r.queue_seq), [a, b]);
  assert.equal(rows[0].queued_at, rows[0].created_at);
  assert.equal(d.prepare('SELECT delivered_to d FROM outbox').get().d, null);
});

test('range-check tells the date sheet what a range means (reserve / waitlist / refusals) and never writes anything', async () => {
  const { asset, owner, w1 } = await stage();
  const check = (who, a, s0, e0, extra = '') => who.client.get(`/api/assets/${a.id}/range-check?start_date=${s0}&end_date=${e0}${extra}`);
  const count = () => ({ r: db.prepare('SELECT COUNT(*) c FROM reservations').get().c, w: db.prepare('SELECT COUNT(*) c FROM waitlist_entries').get().c });
  const before = count();
  const free = (await check(w1, asset, plus(20), plus(21))).body;
  assert.equal(free.outcome, 'reserve');
  assert.deepEqual([free.reserved.length, free.waitlisted.length], [1, 0], 'nothing else scheduled: all of it is reserved');
  assert.equal(free.requires_approval, false);
  assert.equal(free.overlap, undefined, 'there is no "warn and record anyway" any more');
  const taken = (await check(w1, asset, plus(10), plus(10))).body;
  assert.equal(taken.outcome, 'waitlist', 'tapping a reserved day: all of it is unavailable, so it is a waitlist question');
  assert.deepEqual([taken.reserved.length, taken.waitlisted.length], [0, 1]);
  assert.match(taken.message, /already reserved/i);
  const cut = (await check(w1, asset, plus(9), plus(13))).body;
  assert.equal(cut.outcome, 'partial', 'a range that only partly overlaps is cut around the reservation');
  assert.deepEqual(cut.reserved.map((r) => [r.start_date, r.end_date]), [[plus(9), plus(9)], [plus(13), plus(13)]]);
  assert.deepEqual(cut.waitlisted.map((r) => [r.start_date, r.end_date]), [[plus(10), plus(12)]]);
  assert.equal((await check(w1, asset, plus(12), plus(10))).body.outcome, 'invalid');
  assert.equal((await check(w1, asset, plus(-2), plus(1))).body.outcome, 'invalid');
  assert.equal((await check(w1, asset, 'x', 'y')).body.outcome, 'invalid');
  assert.equal((await check(owner, asset, plus(11), plus(11))).body.outcome, 'own_reservation');
  const out = await newAsset('Only checked out');
  assert.equal((await admin.post(`/api/assets/${out.id}/checkout`, { employee_id: (await makeLogin('Borrower')).id })).status, 200);
  const onlyOut = (await check(w1, out, plus(1), plus(2))).body;
  assert.equal(onlyOut.outcome, 'waitlist', 'nobody has reserved it, but it is checked out: unavailable time is waitlist time');
  const hidden = await newAsset('Not shared', { available_to_request: false });
  assert.equal((await check(w1, hidden, plus(1), plus(2))).status, 404);
  const appr = await newAsset('Needs approval', { reservation_requires_approval: true });
  assert.equal((await check(w1, appr, plus(1), plus(2))).body.requires_approval, true);
  await okJoin(w1, asset, plus(10), plus(12));
  assert.equal((await check(w1, asset, plus(11), plus(11))).body.outcome, 'own_waitlist');
  assert.deepEqual(count(), { r: before.r, w: before.w + 1 }, 'only the one real join was written');
});

test('tapping a reserved date: reserved time is never double-booked; a range that only partly overlaps is cut; joining the waitlist is the only call that creates no reservation', async () => {
  const { asset, w1 } = await stage();
  const n = () => db.prepare("SELECT COUNT(*) c FROM reservations WHERE asset_id = ?").get(asset.id).c;
  const before = n();
  const rival = await makeLogin('Tap Rival 1');
  assert.equal((await reserve(rival, asset, plus(10), plus(10))).status, 409, 'wholly reserved: refused (join the waitlist instead)');
  const r2 = await reserve(await makeLogin('Tap Rival 2'), asset, plus(11), plus(13));
  assert.deepEqual([r2.body.group.reserved.map((x) => x.start_date), r2.body.group.waitlisted.map((x) => x.start_date)], [[plus(13)], [plus(11)]]);
  const r3 = await reserve(await makeLogin('Tap Rival 3'), asset, plus(9), plus(10));
  assert.deepEqual([r3.body.group.reserved.map((x) => x.start_date), r3.body.group.waitlisted.map((x) => x.start_date)], [[plus(9)], [plus(10)]]);
  assert.equal(n(), before + 2, 'only the free days were reserved');
  const mid = n();
  const e = await okJoin(w1, asset, plus(10), plus(10));
  assert.equal(e.phase, 'waiting');
  assert.equal(n(), mid, 'joining the waitlist is not a reservation');
});

test('Edit dates: the owner changes a waiting entry; the new range is validated on the server exactly like joining', async () => {
  const { asset, owner, w1 } = await stage();
  await okReserve(owner, asset, plus(14), plus(16));
  const e = await okJoin(w1, asset, plus(10), plus(12));
  const edit = (id, s0, e0, who = w1) => who.client.put(`/api/waitlist/${id}`, { start_date: s0, end_date: e0 });
  const ok = await edit(e.id, plus(14), plus(15));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.start_date, ok.body.end_date, ok.body.phase], [plus(14), plus(15), 'waiting']);
  assert.equal(ok.body.can_edit, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM waitlist_entries WHERE asset_id = ? AND employee_id = ?').get(asset.id, w1.id).c, 1, 'edited in place, not duplicated');
  // refusals
  assert.equal((await edit(e.id, plus(14), plus(15))).status, 400, 'nothing changed');
  assert.equal((await edit(e.id, plus(20), plus(21))).status, 409, 'free dates: reserve instead');
  assert.equal((await edit(e.id, plus(-2), plus(1))).status, 400, 'past');
  assert.equal((await edit(e.id, plus(16), plus(14))).status, 400, 'end before start');
  assert.equal((await edit(e.id, 'x', 'y')).status, 400, 'not dates');
  assert.equal((await w1.client.put(`/api/waitlist/${e.id}`, {})).status, 400, 'missing dates');
  assert.deepEqual([(await entryOf(w1, e.id)).start_date, (await entryOf(w1, e.id)).end_date], [plus(14), plus(15)], 'refused edits changed nothing');
  // only checked out, never reserved: no waitlist for it
  const out = await newAsset('Edit checked out');
  assert.equal((await admin.post(`/api/assets/${out.id}/checkout`, { employee_id: (await makeLogin('Borrower2')).id })).status, 200);
  assert.equal((await edit(e.id, plus(1), plus(2))).status, 409);
  // overlapping with their OWN other entry on the same asset
  const second = await okJoin(w1, asset, plus(10), plus(12));
  assert.equal((await edit(e.id, plus(11), plus(14))).status, 409);
  assert.equal((await edit(second.id, plus(14), plus(16))).status, 409, 'the other way round too');
  // a closed entry cannot be edited
  await w1.client.post(`/api/waitlist/${second.id}/cancel`, {});
  assert.equal((await edit(second.id, plus(10), plus(11))).status, 400);
  assert.equal((await edit(999999, plus(10), plus(11))).status, 404);
});

test('Edit dates resets FIFO: the entry goes to the back of the line for the new range, even within the same second', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  assert.equal((await entryOf(w1, e1.id)).position, 1);
  assert.equal((await entryOf(w2, e2.id)).position, 2);
  // w1 narrows their range (still reserved): they asked for something new, so they go behind w2
  assert.equal((await w1.client.put(`/api/waitlist/${e1.id}`, { start_date: plus(10), end_date: plus(11) })).status, 200);
  assert.equal((await entryOf(w2, e2.id)).position, 1);
  assert.equal((await entryOf(w1, e1.id)).position, 2);
  const seq = (id) => db.prepare('SELECT queue_seq q FROM waitlist_entries WHERE id = ?').get(id).q;
  assert.ok(seq(e1.id) > seq(e2.id));
  assert.equal(db.prepare('SELECT created_at c FROM waitlist_entries WHERE id = ?').get(e1.id).c.length > 0, true, 'created_at still records when they first joined');
  // and the queue really serves w2 first
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(w2, e2.id), 'held');
  assert.equal(await phaseOf(w1, e1.id), 'waiting');
  // the admin's list is in the same order
  const line = (await admin.get('/api/waitlist?status=open')).body.filter((x) => x.asset_id === asset.id).map((x) => x.employee_name);
  assert.deepEqual(line, ['Wren Two', 'Wade One']);
});

test('Edit dates: moving into a range others already wait for puts you behind them', async () => {
  const { asset, owner, w1, w2 } = await stage();
  await okReserve(owner, asset, plus(14), plus(16));
  const first = await okJoin(w2, asset, plus(14), plus(16));
  const mine = await okJoin(w1, asset, plus(10), plus(12));
  assert.equal((await w1.client.put(`/api/waitlist/${mine.id}`, { start_date: plus(14), end_date: plus(16) })).status, 200);
  assert.equal((await entryOf(w1, mine.id)).position, 2);
  assert.equal((await entryOf(w2, first.id)).position, 1);
});

test('Edit dates is the owner\'s alone: another employee, IT and a held entry are all refused', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  assert.equal((await w2.client.put(`/api/waitlist/${e1.id}`, { start_date: plus(10), end_date: plus(11) })).status, 403);
  assert.equal((await owner.client.put(`/api/waitlist/${e1.id}`, { start_date: plus(10), end_date: plus(11) })).status, 403);
  assert.equal((await admin.put(`/api/waitlist/${e1.id}`, { start_date: plus(10), end_date: plus(11) })).status, 403);
  assert.equal((await entryOf(w1, e1.id)).end_date, plus(12));
  assert.equal((await entryOf(w1, e1.id)).can_edit, true);
  assert.equal((await entryOf(admin, e1.id)).can_edit, false);
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal(await phaseOf(w1, e1.id), 'held');
  const r = await w1.client.put(`/api/waitlist/${e1.id}`, { start_date: plus(10), end_date: plus(11) });
  assert.equal(r.status, 400, 'an offer is answered, not edited');
  assert.equal((await entryOf(w1, e1.id)).can_edit, false);
});

test('the Reservations badge counts ACTIVE items only: IT = pending approvals + people in line; an employee = offers awaiting them', async () => {
  const counts = async (c) => (await (c.client || c).get('/api/reservation-counts')).body;
  const { asset, owner, w1, w2, resv } = await stage();
  const a0 = await counts(admin);
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  const a1 = await counts(admin);
  assert.equal(a1.waitlist_active - a0.waitlist_active, 2);
  assert.equal(a1.attention - a0.attention, 2);
  assert.equal(a1.attention, a1.pending + a1.waitlist_active);
  assert.deepEqual(await counts(w1), { pending: 0, waitlist_active: 1, held: 0, attention: 0 }, 'waiting alone needs nothing from the employee');
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal((await counts(w1)).held, 1);
  assert.equal((await counts(w1)).attention, 1);
  assert.equal((await counts(w2)).attention, 0);
  assert.equal((await counts(admin)).attention, a1.attention, 'a hold is still an active entry');
  // history never counts: declined / left / expired / fulfilled entries drop out
  await w1.client.post(`/api/waitlist/${e1.id}/decline`, {});
  await w2.client.post(`/api/waitlist/${e2.id}/cancel`, {});
  const a2 = await counts(admin);
  assert.equal(a2.waitlist_active, a0.waitlist_active, 'closed entries are not counted');
  expireHold(db.prepare('SELECT id FROM waitlist_entries WHERE status = ? LIMIT 1').get('held')?.id || 0);
  // a pending reservation adds to IT's count
  const appr = await newAsset('Counts approval', { reservation_requires_approval: true });
  const before = (await counts(admin)).attention;
  await okReserve(w1, appr, plus(30), plus(31));
  assert.equal((await counts(admin)).attention, before + 1);
  assert.equal((await counts(w1)).attention, 0);
});

test('shortening a reservation answers with the resulting range, so the screen can confirm it', async () => {
  const { asset, owner, resv } = await stage();
  const r = await owner.client.post(`/api/reservations/${resv.id}/shorten`, { end_date: plus(11) });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.start_date, r.body.end_date, r.body.status], [plus(10), plus(11), 'confirmed']);
  assert.equal((await owner.client.post(`/api/reservations/${resv.id}/shorten`, { end_date: plus(11) })).status, 400, 'a failed shorten is an error, never a success');
  assert.equal(db.prepare('SELECT end_date e FROM reservations WHERE id = ?').get(resv.id).e, plus(11));
  assert.ok(asset.id);
});

// ---------------------------------------------------------------- MAIL_TEST_RECIPIENT
test('MAIL_TEST_RECIPIENT redirects every message, keeps the intended recipient visible, and changes nothing else', async () => {
  const keep = process.env.MAIL_TEST_RECIPIENT;
  const sent = [];
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  try {
    await admin.put('/api/settings', { it_email_name: 'IT Desk', it_contact_email: 'it-reply@nutricost.com' });
    process.env.MAIL_TEST_RECIPIENT = 'qa.tester@nutricost.com';
    const { asset, owner, w1, resv } = await stage();
    sent.length = 0;
    const e1 = await okJoin(w1, asset, plus(10), plus(12));
    await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
    await tick();
    assert.equal(await phaseOf(w1, e1.id), 'held', 'business logic is identical');
    // 1. the informational notice, meant for the owner
    const notice = sent.find((m) => /Another team/.test(m.subject));
    assert.equal(notice.to, 'qa.tester@nutricost.com');
    assert.equal(notice.subject.startsWith(`[DEV for ${owner.email}] `), true, notice.subject);
    assert.match(notice.html, /DEV TEST MODE/);
    assert.ok(notice.html.includes(owner.email), 'the intended recipient is in the body');
    assert.ok(notice.html.indexOf('DEV TEST MODE') < notice.html.indexOf('Another team is waiting'), 'banner first');
    // 2. the hold email, meant for w1
    const hold = sent.find((m) => /Available for you/.test(m.subject) && m.subject.includes(w1.email));
    assert.equal(hold.to, 'qa.tester@nutricost.com');
    assert.match(hold.subject, new RegExp(`^\\[DEV for ${w1.email.replace('.', '\\.')}\\]`));
    assert.equal(hold.replyTo, 'it-reply@nutricost.com', 'IT identity still applies');
    assert.deepEqual(hold.from.name, 'IT Desk');
    assert.equal(sent.some((m) => m.to === owner.email || m.to === w1.email), false, 'nothing reached a real recipient');
    // the outbox keeps the INTENDED recipient and says where it really went
    const row = db.prepare("SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE '%Available for you%' ORDER BY id DESC").get(w1.email);
    assert.equal(row.delivered_to, 'qa.tester@nutricost.com');
    assert.equal(row.status, 'sent');
    assert.match(row.subject, /^\[DEV for /);
    // the employee's own address is untouched
    assert.equal(db.prepare('SELECT login_email e FROM accounts WHERE employee_id = ?').get(w1.id).e, w1.email);
    // the admin settings screen is told, and it cannot be set from there
    const st = (await admin.get('/api/settings')).body;
    assert.equal(st.mailTestRecipient, 'qa.tester@nutricost.com');
    await admin.put('/api/settings', { mail_test_recipient: 'attacker@evil.com' });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE '%test%' OR value LIKE '%evil%'").get().c, 0);
    assert.equal((await admin.get('/api/settings')).body.mailTestRecipient, 'qa.tester@nutricost.com');
    assert.equal((await emp(w1).get('/api/settings')).status, 403, 'employees never see it');
  } finally {
    if (keep === undefined) delete process.env.MAIL_TEST_RECIPIENT; else process.env.MAIL_TEST_RECIPIENT = keep;
    mailer.setTransportForTests(null);
    await admin.put('/api/settings', { it_email_name: 'Nutricost IT', it_contact_email: '' });
  }
});
const emp = (who) => who.client;

test('without MAIL_TEST_RECIPIENT nothing is redirected or prefixed; an invalid value fails closed', async () => {
  const keep = process.env.MAIL_TEST_RECIPIENT;
  const sent = [];
  mailer.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  try {
    delete process.env.MAIL_TEST_RECIPIENT;
    assert.equal(mailer.testRecipient(), null);
    assert.equal((await admin.get('/api/settings')).body.mailTestRecipient, null);
    const { asset, owner, w1 } = await stage();
    sent.length = 0;
    await okJoin(w1, asset, plus(10), plus(12));
    await tick();
    assert.equal(sent.length, 2, 'the reserver is told, and the person who joined gets their own confirmation');
    assert.equal(sent.filter((m) => m.to === owner.email).length, 1);
    for (const m of sent) { assert.doesNotMatch(m.subject, /DEV/); assert.doesNotMatch(m.html, /DEV TEST MODE/); }
    assert.equal(db.prepare("SELECT delivered_to d FROM outbox WHERE to_addr = ? AND subject LIKE 'Another team%'").get(owner.email).d, null);
    // a typo must never leak test mail to real people
    process.env.MAIL_TEST_RECIPIENT = 'not an address';
    sent.length = 0;
    await mailer.notify.test('real.person@nutricost.com');
    await tick();
    assert.equal(sent.length, 0, 'nothing was sent anywhere');
    const row = db.prepare("SELECT * FROM outbox WHERE to_addr = 'real.person@nutricost.com' ORDER BY id DESC").get();
    assert.equal(row.status, 'failed');
    assert.match(row.error, /MAIL_TEST_RECIPIENT/);
  } finally {
    if (keep === undefined) delete process.env.MAIL_TEST_RECIPIENT; else process.env.MAIL_TEST_RECIPIENT = keep;
    mailer.setTransportForTests(null);
  }
});

test('in test mode without SMTP the outbox still shows what would have happened, and a failing transport still leaves the waitlist intact', async () => {
  const keep = process.env.MAIL_TEST_RECIPIENT;
  try {
    process.env.MAIL_TEST_RECIPIENT = 'qa.tester@nutricost.com';
    const { asset, owner, w1, resv } = await stage();
    const e1 = await okJoin(w1, asset, plus(10), plus(12));
    const logged = db.prepare("SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE '%Another team%' ORDER BY id DESC").get(owner.email);
    assert.equal(logged.status, 'logged', 'not configured: nothing was delivered');
    assert.equal(logged.delivered_to, 'qa.tester@nutricost.com');
    mailer.setTransportForTests({ sendMail: async () => { throw new Error('535 auth failed'); } });
    await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
    await tick();
    assert.equal(await phaseOf(w1, e1.id), 'held');
    assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 200);
    const failed = db.prepare("SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE '%Available for you%'").get(w1.email);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.delivered_to, 'qa.tester@nutricost.com');
  } finally {
    if (keep === undefined) delete process.env.MAIL_TEST_RECIPIENT; else process.env.MAIL_TEST_RECIPIENT = keep;
    mailer.setTransportForTests(null);
  }
});

test('a refused late confirm still sends the next person their hold email right away (not at the next sweep)', async () => {
  const { asset, owner, w1, w2, resv } = await stage();
  const e1 = await okJoin(w1, asset, plus(10), plus(12));
  const e2 = await okJoin(w2, asset, plus(10), plus(12));
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  expireHold(e1.id);
  assert.equal((await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {})).status, 409);
  assert.equal(await phaseOf(w2, e2.id), 'held');
  assert.equal(mailsTo(w2, 'Available for you%').length, 1, 'emailed by the request that moved the queue');
});

// ================================================================ QA round 2
test('Edit dates emails only a current reserver the NEW range newly overlaps; those already told are not told again; a mail failure changes nothing', async () => {
  const { asset, owner, w1 } = await stage(); // owner holds +10..+12
  const second = await makeLogin('Second Owner');
  await okReserve(second, asset, plus(13), plus(22)); // directly after the owner's, so the widened range below is wholly unavailable
  const e = await okJoin(w1, asset, plus(10), plus(12));
  assert.equal(mailsTo(owner, 'Another team%').length, 1, 'told when the entry was created');
  assert.equal(mailsTo(second, 'Another team%').length, 0, 'not overlapped yet');
  // widening to reach the second owner: only the second owner is newly overlapped
  assert.equal((await w1.client.put(`/api/waitlist/${e.id}`, { start_date: plus(10), end_date: plus(22) })).status, 200);
  assert.equal(mailsTo(owner, 'Another team%').length, 1, 'already told: no repeat');
  const n = mailsTo(second, 'Another team%');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /changed their waitlist request/);
  assert.match(n[0].body, /No action is needed/);
  assert.doesNotMatch(n[0].body, /release|give up|transfer/i);
  assert.equal(mailsTo(w1, 'Another team%').length, 0);
  // an edit that reaches nobody new sends nothing
  assert.equal((await w1.client.put(`/api/waitlist/${e.id}`, { start_date: plus(11), end_date: plus(21) })).status, 200);
  assert.equal(mailsTo(owner, 'Another team%').length, 1);
  assert.equal(mailsTo(second, 'Another team%').length, 1);
  // moving to a range that overlaps only the first owner (who overlapped the old range too) sends nothing either
  // a failing hook never undoes the edit
  const { notify } = mailer; const saved = notify.waitlistJoined;
  notify.waitlistJoined = () => { throw new Error('boom'); };
  try {
    const third = await makeLogin('Third Owner'); await okReserve(third, asset, plus(23), plus(31));
    assert.equal((await w1.client.put(`/api/waitlist/${e.id}`, { start_date: plus(11), end_date: plus(31) })).status, 200);
    assert.equal((await entryOf(w1, e.id)).end_date, plus(31));
  } finally { notify.waitlistJoined = saved; }
});

test('front end: contextual Back from Settings to the catalog, the Settings section layout, the Shorten calendar, the amber FIFO warning and the green toast', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const catalog = src.slice(src.indexOf('async function viewCatalog()'), src.indexOf('async function viewCatalog()') + 12000);
  // Settings stamps the source into the route; the sidebar does not
  assert.match(src, /<a class="btn" href="#\/catalog\?from=\$\{encodeURIComponent\('#\/settings'\)\}">/);
  assert.match(src, /key: 'catalog', href: '#\/catalog', label: 'Equipment catalog'/, 'the sidebar link is the plain root');
  assert.doesNotMatch(src, /<a class="btn" href="#\/catalog">/);
  // the catalog keeps it on every URL it builds, and shows Back only when it is there
  assert.match(catalog, /const fromSettings = \(\) => qs\(\)\.get\('from'\) === '#\/settings'/);
  assert.match(catalog, /if \(fromSettings\(\)\) q\.push\(`from=\$\{encodeURIComponent\('#\/settings'\)\}`\)/);
  assert.match(catalog, /: fromSettings\(\) \? backAnchor\('#\/settings', 'Settings'\) : ''/);
  assert.doesNotMatch(catalog, /history\.replaceState\(null, '', '#\/catalog'\)/, 'even the stale-node fallback keeps the source');
  // Settings layout: a header row (title + description, then the action), Locations kept
  assert.match(src, /<div class="set-head"><div class="field"><span>Categories &amp; equipment types<\/span>/);
  assert.match(src, /name="locations"/);
  assert.match(css, /\.set-head \{ display: flex; flex-wrap: wrap;/);
  // Shorten: an always-visible calendar instead of a date input; success is a green toast naming the result
  const shorten = src.slice(src.indexOf('function shortenSheet('), src.indexOf('// Wires every reservation button'));
  assert.match(shorten, /id="sc-grid"/);
  assert.doesNotMatch(shorten, /type="date"/);
  assert.match(shorten, /toast\(`Reservation shortened to \$\{resvRange\(u\)\}\.`, false, 'ok'\)/);
  assert.match(css, /#toast\.ok \{ background: #12805c; color: #fff; \}/);
  // Edit dates: the FIFO warning is an amber banner
  const range = src.slice(src.indexOf('function rangeSheet('), src.indexOf('function wireWaitlistActions('));
  assert.match(range, /<div class="banner warn">\$\{icon\('alert'\)\}<div class="grow small"><strong>Changing your dates updates your place in line\./);
});

test('front end: an asset opened from a catalog that came from Settings carries `from=#/settings` out and back; no `from` means nothing is added', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // out: the catalog's asset links stamp it (only when the catalog has it)
  assert.match(src, /srcQ\('catalog', \{ node: node\.id, all: st\.all, from: fromSettings\(\) \? '#\/settings' : null \}\)/);
  // context: read only for src=catalog and only the one whitelisted value; carried to the edit form and its Cancel/Save return
  assert.match(src, /fromSettings: src === 'catalog' && p\.get\('from'\) === '#\/settings'/);
  assert.match(src, /from: c\.fromSettings \? '#\/settings' : null \}\) : ''; \}?;?/);
  // back: the catalog root AND the exact node both get it appended, via one helper; employee Browse is untouched
  const back = src.slice(src.indexOf('async function assetBackTarget()'), src.indexOf('// ============================================================ router'));
  assert.match(back, /const catFrom = \(href\) => \(c\.fromSettings \? `\$\{href\}\$\{href\.includes\('\?'\) \? '&' : '\?'\}from=\$\{encodeURIComponent\('#\/settings'\)\}` : href\)/);
  assert.match(back, /const root = c\.src === 'catalog' \? \{ href: catFrom\('#\/catalog'\)/);
  assert.match(back, /c\.src === 'catalog' \? catFrom\(`#\/catalog\?node=\$\{n\.id\}\$\{c\.all \? '&all=1' : ''\}`\) : `#\/assets\?node=\$\{n\.id\}`/);
  // srcQ drops null extras, so a catalog without `from` produces exactly the old URL
  assert.match(src, /Object\.entries\(extra\)\.filter\(\(\[, v\]\) => v\)/);
});
