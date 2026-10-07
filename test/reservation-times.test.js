// Optional reservation times / partial-day availability (Phase 2, slice 8.1). Pickup and return times are OPTIONAL and independent; dates stay required.
// The calendar is NOT a lock: overlapping demand is recorded and WARNED about (availability_warning), never refused. Everything here is enforced on the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { bootApp, startServer, stopServer, makeClient, setupAdmin, asReservation } = require('./helpers');
const T = require('../src/timeRange');

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
  const r = await admin.post('/api/assets', { name, tag: `RT-${++seq}`, available_to_request: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function makeLogin(name) {
  const email = `rt${++seq}@nutricost.com`;
  const created = await admin.post('/api/users', { name, email, invite: true, department: 'Marketing' });
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.body.account_id);
  const client = makeClient(server);
  assert.equal((await client.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client, id: created.body.id, name, email };
}
// reserve / join with optional times: t = [pickup, return]
const body = (s, e, t = []) => ({ start_date: s, end_date: e, ...(t[0] !== undefined ? { start_time: t[0] } : {}), ...(t[1] !== undefined ? { end_time: t[1] } : {}) });
const reserve = async (who, asset, s, e, t) => asReservation(await who.client.post(`/api/assets/${asset.id}/reservations`, body(s, e, t)));
async function okReserve(who, asset, s, e, t) { const r = await reserve(who, asset, s, e, t); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const joinWl = (who, asset, s, e, t) => who.client.post(`/api/assets/${asset.id}/waitlist`, body(s, e, t));
async function okJoin(who, asset, s, e, t) { const r = await joinWl(who, asset, s, e, t); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const check = (who, asset, s, e, t = []) => who.client.get(`/api/assets/${asset.id}/range-check?start_date=${s}&end_date=${e}${t[0] ? `&start_time=${t[0]}` : ''}${t[1] ? `&end_time=${t[1]}` : ''}`);
const entryOf = async (who, id) => (await who.client.get(`/api/waitlist/${id}`)).body;
const mailsTo = (who, like = '%') => db.prepare('SELECT * FROM outbox WHERE to_addr = ? AND subject LIKE ? ORDER BY id').all(who.email, like);
const expireHold = (id) => db.prepare("UPDATE waitlist_entries SET hold_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
const assetCal = async (who, asset, m) => (await (who.client || who).get(`/api/availability?asset=${asset.id}&month=${m}`)).body.assets[0];
const checkout = async (asset, who, extra = {}) => { const r = await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: who.id, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.assignment; };
const rangeOf = (s, st, e, et) => ({ start_date: s, start_time: st, end_date: e, end_time: et });
const D = '2030-10-12'; // a fixed day for the pure-helper tests
const RAW_CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b(?! [AP]M)/; // a clock value that is NOT in "1:00 PM" form: a raw DB string (or one with seconds)
const tick = () => new Promise((r) => setTimeout(r, 40)); // mail is fire-and-forget: let the outbox catch up

// ================================================================ the pure rules (src/timeRange.js)
test('times are optional and independent: null / blank mean "no specific time"; bad clock values are refused; seconds are never stored', () => {
  for (const v of [undefined, null, '', '   ']) assert.equal(T.cleanTime(v), null, JSON.stringify(v));
  assert.equal(T.cleanTime('08:00'), '08:00');
  assert.equal(T.cleanTime('13:05'), '13:05');
  assert.equal(T.cleanTime('13:05:00'), '13:05', 'a client that sends seconds is normalized, nothing with seconds is stored');
  for (const bad of ['8:00', '24:00', '13:60', '1pm', '08:00:30', 7, {}, '13:5']) {
    assert.throws(() => T.cleanTime(bad, 'pickup time'), (e) => e.status === 400 && /valid pickup time/.test(e.message), JSON.stringify(bad));
  }
});

test('half-open comparison: 8-1 and 1-5 are ADJACENT, 8-1:01 and 1-5 OVERLAP; blank times expand to the start / end of the day', () => {
  const k = (s, st, e, et) => T.keysOf(rangeOf(s, st, e, et));
  const morning = k(D, '08:00', D, '13:00'); const afternoon = k(D, '13:00', D, '17:00');
  assert.equal(T.overlaps(morning, afternoon), false, 'touching at 1:00 PM is not overlapping');
  assert.equal(T.overlaps(afternoon, morning), false, 'and it is symmetric');
  assert.equal(T.overlaps(k(D, '08:00', D, '13:01'), afternoon), true);
  assert.equal(T.overlaps(k(D, '12:59', D, '17:00'), morning), true);
  // date-only = the whole day: overlaps any timed range that day, not the neighbouring days
  const allDay = k(D, null, D, null);
  assert.equal(T.overlaps(allDay, morning), true);
  assert.equal(T.overlaps(allDay, k(plus(1, D), null, plus(1, D), null)), false, 'the next day is a different day');
  assert.equal(T.overlaps(allDay, k(plus(-1, D), '23:00', D, '00:00')), false, 'a range ending at midnight starting the day does not overlap it');
  // pickup time only: needed from 1 PM through the rest of the day
  const pickupOnly = k(D, '13:00', D, null);
  assert.equal(T.overlaps(pickupOnly, k(D, '08:00', D, '13:00')), false, 'the morning is free');
  assert.equal(T.overlaps(pickupOnly, k(D, '08:00', D, '13:01')), true);
  assert.equal(T.overlaps(pickupOnly, k(D, '23:00', D, null)), true, 'through the end of the day');
  assert.equal(T.overlaps(pickupOnly, k(plus(1, D), null, plus(1, D), null)), false);
  // return time only: needed from the start of the day until 1 PM
  const returnOnly = k(D, null, D, '13:00');
  assert.equal(T.overlaps(returnOnly, k(D, '13:00', D, '17:00')), false);
  assert.equal(T.overlaps(returnOnly, k(D, '12:59', D, '17:00')), true);
  assert.equal(T.overlaps(returnOnly, k(D, '00:00', D, '00:01')), true);
});

test('multi-day ranges: the pickup time applies to the first day only, the return time to the last day only, days between are whole days', () => {
  const tripRange = rangeOf(D, '08:00', plus(2, D), '13:00'); // Oct 12 8 AM -> Oct 14 1 PM
  const trip = T.keysOf(tripRange);
  const k = (s, st, e, et) => T.keysOf(rangeOf(s, st, e, et));
  assert.equal(T.overlaps(trip, k(D, '06:00', D, '08:00')), false, 'first day: before the pickup is free');
  assert.equal(T.overlaps(trip, k(D, '07:59', D, '08:01')), true);
  assert.equal(T.overlaps(trip, k(plus(1, D), '02:00', plus(1, D), '03:00')), true, 'the middle day is occupied for the full day');
  assert.equal(T.overlaps(trip, k(plus(1, D), null, plus(1, D), null)), true);
  assert.equal(T.overlaps(trip, k(plus(2, D), '13:00', plus(2, D), '17:00')), false, 'last day: from the return time on is free');
  assert.equal(T.overlaps(trip, k(plus(2, D), '12:59', plus(2, D), '17:00')), true);
  // two multi-day ranges: overlapping, and merely sharing a day boundary
  assert.equal(T.overlaps(trip, k(plus(2, D), '09:00', plus(4, D), null)), true, 'both want the last day morning');
  assert.equal(T.overlaps(trip, k(plus(2, D), '13:00', plus(4, D), null)), false, 'the next trip starts exactly when this one returns');
  assert.equal(T.overlaps(trip, k(plus(-3, D), null, D, '08:00')), false, 'and one that returns exactly at pickup');
  // how each day of the trip looks on a calendar
  assert.deepEqual([D, plus(1, D), plus(2, D), plus(3, D)].map((d) => T.coverageOfDay(tripRange, d)), ['partial', 'full', 'partial', null]);
  assert.equal(T.coverageOfDay(rangeOf(D, null, D, null), D), 'full', 'date-only is a full day');
  assert.equal(T.coverageOfDay(rangeOf(D, '00:00', D, null), D), 'full', 'an explicit start-of-day pickup still covers the whole day');
  assert.equal(T.coverageOfDay(rangeOf(D, null, D, '13:00'), D), 'partial');
  assert.equal(T.coverageOfDay(rangeOf(D, '13:00', D, null), D), 'partial');
});

test('validation: a same-day range with both times must end STRICTLY after it starts; one time alone is fine; multi-day times are unconstrained', () => {
  assert.doesNotThrow(() => T.checkOrder(D, '08:00', D, '13:00'));
  for (const [a, b] of [['13:00', '13:00'], ['14:00', '13:00']]) assert.throws(() => T.checkOrder(D, a, D, b), (e) => e.status === 400 && /return time must be after the pickup time/i.test(e.message), `${a}->${b}`);
  assert.doesNotThrow(() => T.checkOrder(D, null, D, '13:00'), 'return only: start of the day through 1 PM');
  assert.doesNotThrow(() => T.checkOrder(D, '13:00', D, null), 'pickup only: 1 PM through the end of the day');
  assert.doesNotThrow(() => T.checkOrder(D, '23:59', D, null));
  assert.throws(() => T.checkOrder(D, null, D, '00:00'), (e) => e.status === 400, 'a return at 12:00 AM on the first day would end before it began');
  assert.doesNotThrow(() => T.checkOrder(D, '15:00', plus(1, D), '09:00'), 'a later return time on another day is fine even if the clock reads earlier');
  assert.doesNotThrow(() => T.checkOrder(D, null, plus(2, D), null));
});

test('words: readable, never raw HH:MM and never seconds; date-only text is exactly what it always was', () => {
  assert.equal(T.fmtTime('00:00'), '12:00 AM'); assert.equal(T.fmtTime('12:00'), '12:00 PM'); assert.equal(T.fmtTime('13:05'), '1:05 PM'); assert.equal(T.fmtTime('08:00:30'), '8:00 AM');
  const w = (...a) => T.when(rangeOf(...a));
  assert.equal(w(D, null, D, null), 'Oct 12, 2030');
  assert.equal(T.when(rangeOf(D, null, D, null), { allDay: true }), 'Oct 12, 2030 · All day');
  assert.equal(w(D, '08:00', D, null), 'Oct 12, 2030 · Pickup 8:00 AM');
  assert.equal(w(D, null, D, '13:00'), 'Oct 12, 2030 · Return by 1:00 PM');
  assert.equal(w(D, '08:00', D, '13:00'), 'Oct 12, 2030 · 8:00 AM – 1:00 PM');
  assert.equal(w(D, null, plus(2, D), null), 'Oct 12, 2030 to Oct 14, 2030', 'a date-only multi-day range reads as before');
  assert.equal(w(D, '08:00', plus(2, D), null), 'Oct 12, 2030 to Oct 14, 2030 · Pickup 8:00 AM');
  assert.equal(w(D, null, plus(2, D), '11:00'), 'Oct 12, 2030 to Oct 14, 2030 · Return by 11:00 AM');
  assert.equal(w(D, '13:00', plus(2, D), '11:00'), 'Oct 12, 2030, 1:00 PM to Oct 14, 2030, 11:00 AM');
  for (const t of [w(D, '08:00', D, '13:00'), w(D, '13:00', plus(2, D), '11:00')]) assert.doesNotMatch(t, RAW_CLOCK, t);
});

// ================================================================ storage, migration, API compatibility
test('migration 17 adds nullable start_time / end_time to both tables, leaves every existing row untouched (no synthetic times), and the format CHECK holds', () => {
  const { runMigrations } = require('../src/migrate'); const all = require('../src/migrations');
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rt-mig-')), 'assets.db'));
  runMigrations(d, all.filter((m) => m.id <= 16));
  d.prepare("INSERT INTO employees (name, status) VALUES ('Old Timer', 'active')").run();
  d.prepare("INSERT INTO assets (tag, name, status, available_to_request) VALUES ('OLD-1', 'Old camera', 'available', 1)").run();
  const emp = d.prepare('SELECT id FROM employees').get().id; const asset = d.prepare('SELECT id FROM assets').get().id;
  d.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, end_date, status, requires_approval) VALUES (?, ?, '2031-01-10', '2031-01-12', 'confirmed', 0)").run(asset, emp);
  d.prepare("INSERT INTO waitlist_entries (asset_id, employee_id, start_date, end_date) VALUES (?, ?, '2031-01-10', '2031-01-12')").run(asset, emp);
  const snapshot = (t) => d.prepare(`SELECT * FROM ${t}`).all();
  const beforeR = snapshot('reservations'); const beforeW = snapshot('waitlist_entries');
  assert.deepEqual(runMigrations(d, all.filter((m) => m.id <= 17)), [17]);
  for (const [t, was] of [['reservations', beforeR], ['waitlist_entries', beforeW]]) {
    const now = snapshot(t);
    assert.equal(now.length, 1);
    assert.deepEqual([now[0].start_time, now[0].end_time], [null, null], `${t}: an existing date-only row stays date-only`);
    for (const [k, v] of Object.entries(was[0])) assert.equal(now[0][k], v, `${t}.${k} is unchanged`);
  }
  // all four NULL / value combinations are valid (no CHECK ties the two together); malformed clocks are not
  const ins = (st, et) => d.prepare("INSERT INTO reservations (asset_id, employee_id, start_date, start_time, end_date, end_time, status, requires_approval) VALUES (?, ?, '2031-02-01', ?, '2031-02-02', ?, 'confirmed', 0)")
    .run(asset, emp, st, et);
  for (const [st, et] of [[null, null], ['08:00', null], [null, '13:00'], ['08:00', '13:00']]) assert.doesNotThrow(() => ins(st, et), `${st}/${et}`);
  for (const bad of ['9:00', '25:00', '24:00', '13:60', 'noon']) assert.throws(() => ins(bad, null), /CHECK/i, bad);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM pragma_table_info('waitlist_entries') WHERE name IN ('start_time','end_time')").get().c, 2);
  // the same migration adds the nullable request_group link (rows made from ONE request share it), with no backfill: old rows are not part of a split request
  for (const t of ['reservations', 'waitlist_entries']) {
    assert.equal(d.prepare(`SELECT COUNT(*) c FROM pragma_table_info('${t}') WHERE name = 'request_group'`).get().c, 1, t);
    assert.equal(d.prepare(`SELECT COUNT(*) c FROM ${t} WHERE request_group IS NOT NULL`).get().c, 0, `${t}: existing rows are not grouped`);
  }
});

test('the four time combinations are accepted and stored as given; a client that omits the fields still creates a normal date-only reservation', async () => {
  const a = await newAsset('Four combos'); const who = [];
  for (let i = 0; i < 5; i++) who.push(await makeLogin(`Combo ${i}`));
  const cases = [[undefined, undefined], ['08:00', undefined], [undefined, '13:00'], ['08:00', '13:00'], ['', '']];
  const expected = [[null, null], ['08:00', null], [null, '13:00'], ['08:00', '13:00'], [null, null]];
  for (let i = 0; i < cases.length; i++) {
    const r = await reserve(who[i], a, plus(20 + i * 3), plus(20 + i * 3), cases[i]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.start_time, r.body.end_time], expected[i], `case ${i}: returned`);
    const row = db.prepare('SELECT start_time, end_time FROM reservations WHERE id = ?').get(r.body.id);
    assert.deepEqual([row.start_time, row.end_time], expected[i], `case ${i}: stored (NULL, never a synthetic midnight / end of day)`);
  }
  // multi-day with optional times is fine, and an end time earlier on the clock than the start time is fine across days
  const multi = await reserve(who[0], a, plus(60), plus(62), ['15:00', '09:00']);
  assert.equal(multi.status, 200, JSON.stringify(multi.body));
  assert.deepEqual([multi.body.start_time, multi.body.end_time], ['15:00', '09:00']);
  // the response and the lists never show seconds, and an unspecified time is null, not ''
  const listed = (await who[0].client.get('/api/reservations')).body.find((x) => x.id === multi.body.id);
  assert.deepEqual([listed.start_time, listed.end_time], ['15:00', '09:00']);
});

test('invalid times are refused with a clear 400 and nothing is written: same-day end <= start, bad clock values', async () => {
  const a = await newAsset('Refusals'); const me = await makeLogin('Refused One');
  const before = db.prepare('SELECT COUNT(*) c FROM reservations').get().c;
  for (const [t, re] of [[['13:00', '13:00'], /return time must be after the pickup time/i], [['14:00', '13:00'], /return time must be after the pickup time/i],
    [['8am', undefined], /valid pickup time/i], [[undefined, '25:00'], /valid return time/i]]) {
    const r = await reserve(me, a, plus(30), plus(30), t);
    assert.equal(r.status, 400, JSON.stringify(t));
    assert.match(r.body.error, re);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservations').get().c, before);
  // the same ordering rule applies when joining a waitlist and in the advisory range-check
  assert.equal((await check(me, a, plus(30), plus(30), ['13:00', '13:00'])).body.outcome, 'invalid');
});

// ================================================================ overlap detection, warnings, and "never refuse"
test('adjacent reservations (return 1 PM / pickup 1 PM) are both reserved with NOTHING waitlisted; the calendar shows both', async () => {
  const a = await newAsset('Adjacent camera'); const bailey = await makeLogin('Bailey'); const gray = await makeLogin('Gray');
  const day = plus(12);
  const first = await reserve(bailey, a, day, day, ['08:00', '13:00']);
  assert.equal(first.body.group.waitlisted.length, 0);
  const seen = (await check(gray, a, day, day, ['13:00', '17:00'])).body;
  assert.deepEqual([seen.outcome, seen.reserved.length, seen.waitlisted.length], ['reserve', 1, 0], 'the range-check says all of it is free');
  const second = await reserve(gray, a, day, day, ['13:00', '17:00']);
  assert.equal(second.status, 200);
  assert.equal(second.body.group.waitlisted.length, 0, 'a shared 1:00 PM boundary is not an overlap');
  const cal = await assetCal(gray, a, day.slice(0, 7));
  assert.equal(cal.days[Number(day.slice(8)) - 1], 'partial', 'two partial entries that do not fill the day stay "partially scheduled"');
  assert.deepEqual(cal.reservations.map((r) => [r.start_time, r.end_time]).sort(), [['08:00', '13:00'], ['13:00', '17:00']]);
});

test('an overlapping request is CUT: the free time is reserved, the unavailable time is waitlisted; reservations never overlap on the calendar', async () => {
  const a = await newAsset('Overlap camera'); const owner = await makeLogin('Existing'); const late = await makeLogin('Newcomer');
  const day = plus(14);
  await okReserve(owner, a, day, day, ['08:00', '13:00']);
  const seen = (await check(late, a, day, day, ['12:00', '14:00'])).body;
  assert.equal(seen.outcome, 'partial');
  const r = await reserve(late, a, day, day, ['12:00', '14:00']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'confirmed');
  assert.deepEqual(r.body.group.reserved.map((x) => [x.start_time, x.end_time]), [['13:00', '14:00']]);
  assert.deepEqual(r.body.group.waitlisted.map((x) => [x.start_time, x.end_time, x.phase]), [['12:00', '13:00', 'waiting']]);
  const cal = await assetCal(admin, a, day.slice(0, 7));
  assert.deepEqual(cal.reservations.map((x) => [x.holder.name, x.start_time, x.end_time]).sort(), [['Existing', '08:00', '13:00'], ['Newcomer', '13:00', '14:00']], 'two reservations, back to back');
  assert.deepEqual(cal.waitlist.map((x) => [x.holder.name, x.start_time, x.end_time]), [['Newcomer', '12:00', '13:00']], 'the waitlisted part is demand, listed apart from the reservations');
  // 1:00 / 1:01: the smallest possible overlap is still cut off
  const third = await makeLogin('Edge Case');
  assert.equal((await reserve(third, a, plus(16), plus(16), ['08:00', '13:01'])).body.group.waitlisted.length, 0, 'nothing else on that day yet');
  const fourth = await makeLogin('Edge Case Two');
  const edge = (await reserve(fourth, a, plus(16), plus(16), ['13:00', '17:00'])).body.group;
  assert.deepEqual(edge.waitlisted.map((x) => [x.start_time, x.end_time]), [['13:00', '13:01']]);
  assert.deepEqual(edge.reserved.map((x) => [x.start_time, x.end_time]), [['13:01', '17:00']]);
});

test('a date-only request over a timed one (and the other way round) is cut around it; a date-only request on another day is just reserved', async () => {
  const a = await newAsset('All day camera'); const x = await makeLogin('Timed'); const y = await makeLogin('All Day'); const z = await makeLogin('Other Day');
  await okReserve(x, a, plus(18), plus(18), ['09:00', '10:00']);
  const allDay = await reserve(y, a, plus(18), plus(18));
  assert.equal(allDay.status, 200);
  assert.deepEqual(allDay.body.group.reserved.map((r) => [r.start_time, r.end_time]), [[null, '09:00'], ['10:00', null]], 'the morning and the evening are free');
  assert.deepEqual(allDay.body.group.waitlisted.map((r) => [r.start_time, r.end_time]), [['09:00', '10:00']]);
  assert.equal((await reserve(z, a, plus(19), plus(19))).body.group.waitlisted.length, 0);
});

test('a current checkout makes its time unavailable (waitlist time): permanent / overdue / due date; the time after a due TIME is free', async () => {
  const holder = await makeLogin('Holder'); const people = []; for (let i = 0; i < 8; i++) people.push(await makeLogin(`Asker ${i}`));
  const loan = await newAsset('Loaned camera');
  await checkout(loan, holder, { assignment_type: 'checkout', due_date: plus(5), due_time: '12:00' });
  assert.equal((await check(people[0], loan, plus(3), plus(4))).body.outcome, 'waitlist', 'while it is out');
  assert.equal((await reserve(people[0], loan, plus(3), plus(4))).status, 409, 'nothing to reserve');
  assert.equal((await reserve(people[1], loan, plus(5), plus(5), ['11:00', '12:00'])).status, 409, 'it is still out until noon on the due date');
  const onDue = await reserve(people[6], loan, plus(5), plus(5), ['11:00', '14:00']);
  assert.deepEqual(onDue.body.group.reserved.map((r) => [r.start_time, r.end_time]), [['12:00', '14:00']], 'due back at noon: from noon on it is only "expected back"');
  assert.deepEqual(onDue.body.group.waitlisted.map((r) => [r.start_time, r.end_time]), [['11:00', '12:00']]);
  assert.equal((await reserve(people[2], loan, plus(5), plus(5), ['14:00', '17:00'])).body.group.waitlisted.length, 0);
  assert.equal((await reserve(people[3], loan, plus(6), plus(7))).body.group.waitlisted.length, 0, 'the days after the due date');
  // a checkout with no due time is out through the end of its due date
  const loan2 = await newAsset('Loaned camera 2');
  await checkout(loan2, holder, { assignment_type: 'checkout', due_date: plus(5) });
  assert.equal((await reserve(people[4], loan2, plus(5), plus(5), ['17:00', '18:00'])).status, 409);
  // overdue = still out, return unknown
  const late = await newAsset('Overdue camera');
  await checkout(late, holder, { assignment_type: 'checkout', due_date: plus(3) });
  db.prepare('UPDATE assignments SET due_date = ? WHERE asset_id = ?').run(plus(-2), late.id);
  assert.equal((await reserve(people[5], late, plus(40), plus(41))).status, 409);
});

test('only CURRENT scheduled activity makes time unavailable: cancelled / declined / expired / fulfilled rows, ordinary pending requests, and waiting (not held) waitlist entries do not', async () => {
  const a = await newAsset('Closed rows camera'); const ghost = await makeLogin('Ghost'); const asker = await makeLogin('Asker');
  const day = plus(22); const mk = (status, extra = {}) => db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, start_time, end_date, end_time, status, requires_approval, decided_at, cancelled_at)
    VALUES (?, ?, ?, '08:00', ?, '17:00', ?, ?, ?, ?)`).run(a.id, ghost.id, day, day, status, status === 'pending' || status === 'declined' ? 1 : 0, ['declined'].includes(status) ? '2030-01-01' : null, status === 'cancelled' ? '2030-01-01' : null);
  mk('cancelled'); mk('declined'); mk('pending');
  for (const status of ['expired', 'left', 'removed', 'declined', 'waiting']) {
    db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, status, closed_at, queue_seq) VALUES (?, ?, ?, '08:00', ?, '17:00', ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM waitlist_entries))`)
      .run(a.id, ghost.id, day, day, status, status === 'waiting' ? null : '2030-01-01');
  }
  const r = await reserve(asker, a, day, day, ['09:00', '10:00']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.group.waitlisted.length, 0, 'none of those holds the time: a waiting entry is demand, not possession');
  // ... but a pending reservation that came from a waitlist hold does count (it keeps the time out of the queue until IT decides)
  const entry = db.prepare(`INSERT INTO waitlist_entries (asset_id, employee_id, start_date, start_time, end_date, end_time, status, closed_at, queue_seq) VALUES (?, ?, ?, '14:00', ?, '16:00', 'fulfilled', '2030-01-01', 9999)`).run(a.id, ghost.id, day, day).lastInsertRowid;
  db.prepare(`INSERT INTO reservations (asset_id, employee_id, start_date, start_time, end_date, end_time, status, requires_approval, waitlist_entry_id) VALUES (?, ?, ?, '14:00', ?, '16:00', 'pending', 1, ?)`).run(a.id, ghost.id, day, day, entry);
  const other = await makeLogin('Asker Two');
  const cut = (await reserve(other, a, day, day, ['15:00', '17:00'])).body.group;
  assert.deepEqual(cut.waitlisted.map((x) => [x.start_time, x.end_time]), [['15:00', '16:00']]);
  assert.deepEqual(cut.reserved.map((x) => [x.start_time, x.end_time]), [['16:00', '17:00']]);
});

test('what is STILL refused is not about calendars overlapping: the same employee double-booking themselves, and their own hold', async () => {
  const a = await newAsset('Self camera'); const me = await makeLogin('Self Booker');
  await okReserve(me, a, plus(24), plus(24), ['08:00', '13:00']);
  const again = await reserve(me, a, plus(24), plus(24), ['12:00', '14:00']);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already have a reservation/i);
  assert.equal((await reserve(me, a, plus(24), plus(24), ['13:00', '17:00'])).status, 200, 'but adjacent times are not the same booking');
  assert.equal((await check(me, a, plus(24), plus(24), ['09:00', '10:00'])).body.outcome, 'own_reservation');
});

// ================================================================ the waitlist and 24-hour holds
async function stageTimed({ approval = false } = {}) {
  const asset = await newAsset(`Timed camera ${++seq}`, approval ? { reservation_requires_approval: true } : {});
  const owner = await makeLogin('Olive Owner'); const w1 = await makeLogin('Wade One'); const w2 = await makeLogin('Wren Two');
  const day = plus(30);
  let resv = await okReserve(owner, asset, day, day, ['08:00', '17:00']);
  if (approval) assert.equal((await admin.post(`/api/reservations/${resv.id}/approve`, {})).status, 200);
  return { asset, owner, w1, w2, resv, day };
}

test('a waitlist entry keeps its pickup / return times in every combination, and the same ordering rule applies', async () => {
  const { asset, day } = await stageTimed();
  // a whole-day reservation, so every combination below is entirely unavailable
  const wholeDay = await newAsset('Whole day camera');
  await okReserve(await makeLogin('Whole Day Owner'), wholeDay, day, day);
  const who = [await makeLogin('W A'), await makeLogin('W B'), await makeLogin('W C'), await makeLogin('W D')];
  const cases = [[undefined, undefined], ['09:00', undefined], [undefined, '15:00'], ['09:00', '15:00']];
  for (let i = 0; i < cases.length; i++) {
    const e = await okJoin(who[i], wholeDay, day, day, cases[i]);
    assert.deepEqual([e.start_time, e.end_time], [cases[i][0] || null, cases[i][1] || null], `case ${i}`);
    const row = db.prepare('SELECT start_time, end_time FROM waitlist_entries WHERE id = ?').get(e.id);
    assert.deepEqual([row.start_time, row.end_time], [cases[i][0] || null, cases[i][1] || null], 'stored as given');
  }
  assert.equal((await joinWl(await makeLogin('W E'), wholeDay, day, day, ['15:00', '09:00'])).status, 400, 'end before start on one day');
  // part of the time free is a reservation request, not a join; a time that only touches the owner's 5 PM end is free
  const part = await joinWl(await makeLogin('W G'), asset, day, day, ['09:00', '18:00']);
  assert.equal(part.status, 409);
  assert.match(part.body.error, /part of that time is available/i);
  const free = await joinWl(await makeLogin('W F'), asset, day, day, ['17:00', '18:00']);
  assert.equal(free.status, 409);
  assert.match(free.body.error, /Reserve them instead/i);
});

test('a timed hold keeps the requested interval, only overlapping time is held, and a request that merely touches it is fine', async () => {
  const { asset, owner, w1, resv, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']);
  assert.equal((await owner.client.post(`/api/reservations/${resv.id}/cancel`, {})).status, 200);
  const held = await entryOf(w1, e1.id);
  assert.equal(held.phase, 'held');
  assert.deepEqual([held.start_time, held.end_time], ['09:00', '11:00'], 'the offer is for exactly what they asked for, not the whole day');
  const cal = await assetCal(admin, asset, day.slice(0, 7));
  assert.deepEqual(cal.holds.map((h) => [h.start_time, h.end_time]), [['09:00', '11:00']]);
  assert.equal(cal.days[Number(day.slice(8)) - 1], 'partial', 'an hour-bounded hold does not take the whole day');
  const other = await makeLogin('Other Team');
  assert.equal((await check(other, asset, day, day, ['11:00', '13:00'])).body.outcome, 'reserve', 'adjacent to the hold: all free');
  const during = await check(other, asset, day, day, ['10:00', '12:00']);
  assert.equal(during.body.outcome, 'partial', 'overlapping the hold: the held hour is unavailable, the rest is free');
  const r = await reserve(other, asset, day, day, ['10:00', '12:00']);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.group.waitlisted.map((x) => [x.start_time, x.end_time]), [['10:00', '11:00']], 'only the held hour waits');
  assert.deepEqual(r.body.group.reserved.map((x) => [x.start_time, x.end_time]), [['11:00', '12:00']]);
});

test('the queue is time-aware and still FIFO: non-overlapping entries are both offered at once; overlapping ones wait behind the older', async () => {
  const { asset, owner, w1, w2, resv, day } = await stageTimed();
  const w3 = await makeLogin('Wyn Three');
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']);
  const e2 = await okJoin(w2, asset, day, day, ['13:00', '15:00']); // no overlap with e1
  const e3 = await okJoin(w3, asset, day, day, ['10:00', '14:00']); // overlaps both, and is the youngest
  assert.deepEqual([e1, e2, e3].map((e) => e.position), [1, 1, 3].map((n, i) => [1, 1, 3][i]), 'position counts only overlapping entries');
  assert.equal((await entryOf(w3, e3.id)).position, 3);
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal((await entryOf(w1, e1.id)).phase, 'held');
  assert.equal((await entryOf(w2, e2.id)).phase, 'held', 'the afternoon does not wait for the morning');
  const mid = await entryOf(w3, e3.id);
  assert.deepEqual([mid.phase, mid.start_time, mid.end_time], ['held', '11:00', '13:00'], 'only the time BETWEEN the two older holds is offered');
  const rest = () => db.prepare('SELECT start_time, end_time, status FROM waitlist_entries WHERE employee_id = ? AND id <> ? ORDER BY start_time').all(w3.id, e3.id).map((r) => [r.start_time, r.end_time, r.status]);
  assert.deepEqual(rest(), [['10:00', '11:00', 'waiting'], ['13:00', '14:00', 'waiting']], 'the two ends keep waiting in the same place in line');
  // each older holder lets go: the piece that frees is offered to the next in line
  await w1.client.post(`/api/waitlist/${e1.id}/decline`, {});
  assert.deepEqual(rest(), [['10:00', '11:00', 'held'], ['13:00', '14:00', 'waiting']]);
  await w2.client.post(`/api/waitlist/${e2.id}/decline`, {});
  assert.deepEqual(rest(), [['10:00', '11:00', 'held'], ['13:00', '14:00', 'held']], 'now the whole interval has been offered to the next in line');
});

test('expiry releases a timed hold to the next entry; confirming keeps the times; approval-required keeps them through IT', async () => {
  const { asset, owner, w1, w2, resv, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']);
  const e2 = await okJoin(w2, asset, day, day, ['09:30', '10:30']);
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  assert.equal((await entryOf(w1, e1.id)).phase, 'held');
  expireHold(e1.id); waitlist.sweep(db);
  assert.equal((await entryOf(w1, e1.id)).phase, 'expired');
  const next = await entryOf(w2, e2.id);
  assert.equal(next.phase, 'held', 'the next in line is offered it');
  assert.deepEqual([next.start_time, next.end_time], ['09:30', '10:30']);
  const ok = await w2.client.post(`/api/waitlist/${e2.id}/confirm`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.reservation.start_time, ok.body.reservation.end_time, ok.body.reservation.status], ['09:30', '10:30', 'confirmed']);
  // an approval-required asset: the pending reservation carries the times, and so does the approved one
  const s = await stageTimed({ approval: true });
  const f1 = await okJoin(s.w1, s.asset, s.day, s.day, ['09:00', '12:00']);
  await s.owner.client.post(`/api/reservations/${s.resv.id}/cancel`, {});
  const c = await s.w1.client.post(`/api/waitlist/${f1.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.reservation.status, c.body.reservation.start_time, c.body.reservation.end_time], ['pending', '09:00', '12:00']);
  const appr = await admin.post(`/api/reservations/${c.body.reservation.id}/approve`, {});
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  assert.deepEqual([appr.body.status, appr.body.start_time, appr.body.end_time], ['confirmed', '09:00', '12:00']);
  assert.equal(db.prepare('SELECT end_time FROM reservations WHERE id = ?').get(c.body.reservation.id).end_time, '12:00');
});

test('a hold cannot be overlapped by anyone else (a rival is cut around it), so confirming it always works and keeps its exact times', async () => {
  const { asset, owner, w1, resv, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']);
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  const rival = await makeLogin('Rival');
  const cut = await reserve(rival, asset, day, day, ['10:00', '12:00']);
  assert.equal(cut.status, 200);
  assert.deepEqual(cut.body.group.waitlisted.map((x) => [x.start_time, x.end_time]), [['10:00', '11:00']], 'the held hour is not available to the rival');
  const c = await w1.client.post(`/api/waitlist/${e1.id}/confirm`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.reservation.start_time, c.body.reservation.end_time], ['09:00', '11:00']);
  assert.equal(c.body.availability_warning, undefined);
});

test('Edit dates: changing only the TIMES is a new request: the entry goes to the back of the line; unchanged dates and times are refused', async () => {
  const { asset, w1, w2, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']);
  const e2 = await okJoin(w2, asset, day, day, ['09:00', '11:00']);
  const seqOf = (id) => db.prepare('SELECT queue_seq q FROM waitlist_entries WHERE id = ?').get(id).q;
  const was = seqOf(e1.id);
  const edit = (id, who, s, e, t) => who.client.put(`/api/waitlist/${id}`, body(s, e, t));
  assert.equal((await edit(e1.id, w1, day, day, ['09:00', '11:00'])).status, 400, 'nothing changed');
  const r = await edit(e1.id, w1, day, day, ['09:00', '12:00']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.start_time, r.body.end_time], ['09:00', '12:00']);
  assert.ok(seqOf(e1.id) > was && seqOf(e1.id) > seqOf(e2.id), 'back of the line');
  assert.equal((await entryOf(w1, e1.id)).position, 2);
  assert.equal((await edit(e1.id, w1, day, day, ['12:00', '12:00'])).status, 400, 'the ordering rule applies to edits too');
});

// ================================================================ shortening
test('shorten: all day -> a return time, timed -> an earlier return, multi-day -> a return time; never later, never at/before the pickup', async () => {
  const a = await newAsset('Shorten timed'); const me = await makeLogin('Shortener');
  const shorten = (id, b) => me.client.post(`/api/reservations/${id}/shorten`, b);
  // Oct 12 all day -> Oct 12 return at 1 PM
  const r1 = await okReserve(me, a, plus(40), plus(40));
  const s1 = await shorten(r1.id, { end_date: plus(40), end_time: '13:00' });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.deepEqual([s1.body.start_time, s1.body.end_time], [null, '13:00']);
  assert.equal(db.prepare('SELECT end_time FROM reservations WHERE id = ?').get(r1.id).end_time, '13:00');
  // ... and then earlier still; the same time / later are refused
  assert.equal((await shorten(r1.id, { end_date: plus(40), end_time: '12:00' })).status, 200);
  for (const [b, re] of [[{ end_time: '12:00' }, /already the return/i], [{ end_time: '14:00' }, /only shorten/i], [{ end_date: plus(40) }, /only shorten/i], [{ end_time: '00:00' }, /at or before the pickup/i]]) {
    const x = await shorten(r1.id, b); assert.equal(x.status, 400, JSON.stringify(b)); assert.match(x.body.error, re, JSON.stringify(b));
  }
  // 8 AM -> 5 PM becomes 8 AM -> 1 PM; the pickup can never be reached
  const r2 = await okReserve(me, a, plus(41), plus(41), ['08:00', '17:00']);
  assert.equal((await shorten(r2.id, { end_time: '08:00' })).status, 400, 'a return at the pickup time');
  const s2 = await shorten(r2.id, { end_time: '13:00' });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.deepEqual([s2.body.start_date, s2.body.start_time, s2.body.end_time], [plus(41), '08:00', '13:00'], 'the pickup is untouched');
  // a multi-day reservation: same dates, earlier return time on the last day; or an earlier date (end of that day)
  const r3 = await okReserve(me, a, plus(43), plus(45));
  const s3 = await shorten(r3.id, { end_date: plus(45), end_time: '11:00' });
  assert.deepEqual([s3.status, s3.body.end_date, s3.body.end_time], [200, plus(45), '11:00']);
  const s3b = await shorten(r3.id, { end_date: plus(44) });
  assert.deepEqual([s3b.status, s3b.body.end_date, s3b.body.end_time], [200, plus(44), null], 'an earlier DATE with no time = the end of that day (a later clock time than before is fine)');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE asset_id = ? AND action = 'reservation_shortened' AND details LIKE '%1:00 PM%'").get(a.id), 'the log reads in plain times');
});

test('can_shorten is the server\'s answer: true while there is room to return earlier (by date or by time), false when there is none', async () => {
  const a = await newAsset('Shorten flag'); const me = await makeLogin('Flag Owner');
  const flag = async (id) => (await me.client.get('/api/reservations')).body.find((r) => r.id === id).can_shorten;
  const roomy = await okReserve(me, a, plus(50), plus(50));
  assert.equal(await flag(roomy.id), true, 'a single all-day reservation can still be cut to a time');
  db.prepare("UPDATE reservations SET start_time = '08:00', end_time = '08:01' WHERE id = ?").run(roomy.id);
  assert.equal(await flag(roomy.id), false, 'one minute long: nothing left to give back');
});

test('shortening frees the period at once and the waitlist is re-evaluated: the next in line is offered exactly the freed time, FIFO intact', async () => {
  const { asset, owner, w1, w2, resv, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['14:00', '17:00']);
  const e2 = await okJoin(w2, asset, day, day, ['14:30', '16:00']); // younger, overlaps e1
  assert.equal((await entryOf(w1, e1.id)).phase, 'waiting');
  const cut = await owner.client.post(`/api/reservations/${resv.id}/shorten`, { end_time: '13:00' });
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  const first = await entryOf(w1, e1.id);
  assert.equal(first.phase, 'held', 'the post-1 PM period is free from that reservation, so the older entry is offered it');
  assert.deepEqual([first.start_time, first.end_time], ['14:00', '17:00']);
  assert.equal((await entryOf(w2, e2.id)).phase, 'waiting', 'FIFO: the younger overlapping entry stays behind the hold');
  const cal = await assetCal(owner, asset, day.slice(0, 7));
  assert.deepEqual(cal.reservations.map((r) => [r.start_time, r.end_time]), [['08:00', '13:00']], 'the calendar shows the shortened reservation immediately');
});

test('check-out is time-aware too: returning at noon is fine when another team picks up at 1 PM; 2 PM is not (a physical-possession guard, still a refusal)', async () => {
  const a = await newAsset('Checkout guard'); const other = await makeLogin('Picker'); const borrower = await makeLogin('Borrower');
  await okReserve(other, a, plus(8), plus(8), ['13:00', '17:00']);
  const tooLate = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: borrower.id, assignment_type: 'checkout', due_date: plus(8), due_time: '14:00' });
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.body.error, /1:00 PM/);
  const ok = await admin.post(`/api/assets/${a.id}/checkout`, { employee_id: borrower.id, assignment_type: 'checkout', due_date: plus(8), due_time: '12:00' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await admin.post(`/api/assets/${(await newAsset('No due time guard')).id}/checkout`, { employee_id: borrower.id, assignment_type: 'checkout', due_date: plus(8) })).status, 200, 'an asset nobody reserved');
});

// ================================================================ calendar, lists, Browse
test('the calendar: date-only = reserved, a time that cuts the day = partially scheduled, several overlapping entries are all listed; counts report partial', async () => {
  const n = (await admin.post('/api/catalog', { name: `Cal ${++seq}` })).body;
  const a = await newAsset('Partial cal', { catalog_node_id: n.id }); const x = await makeLogin('Cal X'); const y = await makeLogin('Cal Y'); const z = await makeLogin('Cal Z');
  const d1 = plus(60); const d2 = plus(61);
  await okReserve(x, a, d1, d1);
  await okReserve(y, a, d2, d2, ['09:00', '12:00']);
  await okReserve(z, a, d2, d2, ['11:00', '14:00']);
  const m = d1.slice(0, 7); const cal = await assetCal(x, a, m);
  assert.equal(cal.days[Number(d1.slice(8)) - 1], 'reserved');
  assert.equal(cal.days[Number(d2.slice(8)) - 1], 'partial');
  assert.equal(cal.reservations.filter((r) => r.start === d2).length, 2, 'overlapping reservations both appear (anonymous for employees)');
  assert.ok(cal.reservations.every((r) => !r.holder), 'employees never see who');
  assert.ok(cal.reservations.filter((r) => r.start === d2).every((r) => r.start_time && r.end_time), 'with their times');
  const emp = (await x.client.get(`/api/availability?node=${n.id}&month=${m}`)).body.days;
  assert.deepEqual([emp[Number(d1.slice(8)) - 1].reserved, emp[Number(d1.slice(8)) - 1].partial], [1, 0]);
  assert.deepEqual([emp[Number(d2.slice(8)) - 1].reserved, emp[Number(d2.slice(8)) - 1].partial, emp[Number(d2.slice(8)) - 1].available], [0, 1, 0], 'partial is its own figure and is never counted as available');
  const adm = (await admin.get(`/api/availability?node=${n.id}&month=${m}`)).body.days;
  assert.equal(adm[Number(d2.slice(8)) - 1].partial, 1);
});

test('an asset partly scheduled TODAY stays discoverable in Browse with its own state (Search + Discoverability is untouched)', async () => {
  const a = await newAsset('Browse partial camera'); const me = await makeLogin('Browser'); const viewer = await makeLogin('Viewer');
  await okReserve(me, a, TODAY, TODAY, ['09:00', '10:00']);
  const row = (await viewer.client.get('/api/assets')).body.find((r) => r.id === a.id);
  assert.ok(row, 'still listed');
  assert.equal(row.avail_state, 'partial');
  assert.ok((await viewer.client.get('/api/assets?q=Browse%20partial')).body.some((r) => r.id === a.id), 'and found by search');
  const whole = await newAsset('Browse whole-day camera');
  await okReserve(me, whole, TODAY, TODAY);
  assert.equal((await viewer.client.get('/api/assets')).body.find((r) => r.id === whole.id).avail_state, 'reserved');
});

test('the lists show times: employee reservations, admin reservations and waitlist rows', async () => {
  const a = await newAsset('List camera'); const me = await makeLogin('Lister'); const other = await makeLogin('Lister Two');
  const day = plus(70);
  const r1 = await okReserve(me, a, day, plus(72), ['08:00', '13:00']);
  const r2 = await okReserve(other, a, plus(72), plus(72), ['13:00', '14:00']);
  const mine = (await me.client.get('/api/reservations')).body.find((r) => r.id === r1.id);
  assert.deepEqual([mine.start_time, mine.end_time], ['08:00', '13:00']);
  const adm = (await admin.get('/api/reservations')).body;
  assert.deepEqual([adm.find((r) => r.id === r1.id).overlaps_other, adm.find((r) => r.id === r2.id).overlaps_other], [undefined, undefined], 'reservations cannot overlap any more, so there is no overlap flag');
  assert.deepEqual([adm.find((r) => r.id === r2.id).start_time, adm.find((r) => r.id === r2.id).end_time], ['13:00', '14:00']);
  const e = await okJoin(await makeLogin('Lister Three'), a, day, day, ['09:00', '10:00']);
  assert.deepEqual([e.start_time, e.end_time], ['09:00', '10:00']);
  const wl = (await admin.get('/api/waitlist')).body.find((w) => w.id === e.id);
  assert.deepEqual([wl.start_time, wl.end_time], ['09:00', '10:00']);
  assert.equal((await (await makeLogin('Lister Four')).client.get('/api/reservations')).body.length, 0);
});

test('existing all-day clients are unaffected: no time fields in, null time fields out; the original outcomes and messages still hold', async () => {
  const a = await newAsset('Legacy camera'); const me = await makeLogin('Legacy'); const other = await makeLogin('Legacy Two');
  const r = await okReserve(me, a, plus(90), plus(92));
  assert.deepEqual([r.start_date, r.end_date, r.start_time, r.end_time, r.status], [plus(90), plus(92), null, null, 'confirmed']);
  assert.equal((await check(other, a, plus(91), plus(91))).body.outcome, 'waitlist');
  assert.equal((await check(other, a, plus(93), plus(94))).body.outcome, 'reserve');
  assert.equal((await reserve(me, a, plus(91), plus(91))).status, 409, 'own double-booking message unchanged');
  const e = await okJoin(other, a, plus(91), plus(91));
  assert.deepEqual([e.start_time, e.end_time], [null, null]);
});

// ================================================================ email
const lastMail = (who, like) => { const m = mailsTo(who, like).pop(); return m && { ...m, html: m.body }; }; // (call `await tick()` after the action that sends it)
const NOT_GUARANTEED = "Availability for the waitlisted portion is not guaranteed. We'll notify you if it becomes available.";
const textOf = (html) => html.replace(/<br>/g, '\n').replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('the requester gets a confirmation: times in plain words (all-day, pickup only, return only, both, multi-day), no seconds and no raw HH:MM', async () => {
  const a = await newAsset('Mail camera');
  const cases = [
    [[undefined, undefined], plus(100), plus(100), 'Requested:</strong> ' + T.when(rangeOf(plus(100), null, plus(100), null), { allDay: true }), /· All day/],
    [['08:00', undefined], plus(101), plus(101), null, /Pickup 8:00 AM/],
    [[undefined, '13:00'], plus(102), plus(102), null, /Return by 1:00 PM/],
    [['08:00', '13:00'], plus(103), plus(103), null, /8:00 AM – 1:00 PM/],
    [[undefined, '11:00'], plus(104), plus(106), null, /to .*· Return by 11:00 AM/],
  ];
  for (const [t, s, e, , re] of cases) {
    const who = await makeLogin('Mailer');
    await okReserve(who, a, s, e, t); await tick();
    const m = lastMail(who, 'Reservation recorded%');
    assert.ok(m, 'a confirmation was sent');
    assert.match(m.html, re);
    assert.doesNotMatch(m.html.replace(/<[^>]*>/g, ' '), RAW_CLOCK, 'no raw HH:MM (and so no seconds)');
    assert.doesNotMatch(m.html, /Waitlisted|not guaranteed/, 'nothing was waitlisted: no notice');
  }
});

test('the confirmation lists what was requested, what was reserved and what was waitlisted; the not-guaranteed note appears only with waitlisted time', async () => {
  const a = await newAsset('Notice camera'); const first = await makeLogin('Notice First'); const second = await makeLogin('Notice Second');
  const day = plus(110);
  await okReserve(first, a, day, day, ['08:00', '13:00']); await tick();
  const m1 = textOf(lastMail(first, 'Reservation recorded%').html);
  assert.match(m1, /Requested: .*8:00 AM – 1:00 PM\nReserved: .*8:00 AM – 1:00 PM/);
  assert.doesNotMatch(m1, /Waitlisted|not guaranteed/);
  // partly available: 12-2 against 8-1 -> 12-1 waitlisted, 1-2 reserved
  await okReserve(second, a, day, day, ['12:00', '14:00']); await tick();
  const part = lastMail(second, 'Part of your reservation is confirmed%');
  assert.ok(part, 'a different subject says it was only partly confirmed');
  const t2 = textOf(part.html);
  assert.match(t2, /Requested: .*12:00 PM – 2:00 PM\nReserved: .*1:00 PM – 2:00 PM\nWaitlisted: .*12:00 PM – 1:00 PM/);
  assert.ok(t2.includes(NOT_GUARANTEED), 'the exact sentence');
  assert.equal(mailsTo(second, 'Reservation recorded%').length, 0, 'one email for the whole request, not one per part');
  // fully unavailable: waitlist only
  const w = await makeLogin('Notice Waiter');
  await okJoin(w, a, day, day, ['09:00', '10:00']); await tick();
  const t3 = textOf(lastMail(w, "You're on the waitlist%").html);
  assert.match(t3, /Requested: .*9:00 AM – 10:00 AM\nWaitlisted: .*9:00 AM – 10:00 AM/);
  assert.doesNotMatch(t3, /Reserved:/);
  assert.ok(t3.includes(NOT_GUARANTEED));
  // approval-required: the available time is "sent to IT for approval", and a pending request holds nothing, so two of them do not wait on each other
  const strict = await newAsset('Notice strict', { reservation_requires_approval: true });
  const p1 = await makeLogin('Pending One'); const p2 = await makeLogin('Pending Two');
  await okReserve(p1, strict, day, day); await tick();
  const t4 = textOf(lastMail(p1, 'Reservation request received%').html);
  assert.match(t4, /Sent to IT for approval: /);
  assert.doesNotMatch(t4, /Waitlisted|not guaranteed/);
  await okReserve(p2, strict, day, day); await tick();
  assert.doesNotMatch(textOf(lastMail(p2, 'Reservation request received%').html), /Waitlisted/);
  // checked out: that time is waitlist time too
  const loaned = await newAsset('Notice loan'); const holder = await makeLogin('Notice Holder'); const asker = await makeLogin('Notice Asker');
  await checkout(loaned, holder, { assignment_type: 'checkout', due_date: plus(115) });
  await okJoin(asker, loaned, plus(113), plus(114)); await tick();
  assert.ok(textOf(lastMail(asker, "You're on the waitlist%").html).includes(NOT_GUARANTEED));
});

test('times in email are wall-clock: APP_TIMEZONE never shifts them (no per-user or server-local conversion)', async () => {
  const keep = process.env.APP_TIMEZONE;
  const a = await newAsset('Zone camera');
  try {
    const texts = [];
    for (const tz of ['Pacific/Honolulu', 'Asia/Tokyo', undefined]) {
      if (tz) process.env.APP_TIMEZONE = tz; else delete process.env.APP_TIMEZONE;
      const who = await makeLogin('Zoner');
      await okReserve(who, a, plus(120 + texts.length), plus(120 + texts.length), ['08:00', '13:00']); await tick();
      texts.push(lastMail(who, 'Reservation recorded%').html.match(/Requested:<\/strong> ([^<]*)</)[1].replace(/^[A-Za-z]{3} \d+, \d{4}/, ''));
    }
    assert.deepEqual(texts, [' · 8:00 AM – 1:00 PM', ' · 8:00 AM – 1:00 PM', ' · 8:00 AM – 1:00 PM']);
  } finally { if (keep === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = keep; }
});

test('the existing waitlist emails carry the times: the reserver is told both ranges, the held person is told their exact interval', async () => {
  const { asset, owner, w1, resv, day } = await stageTimed();
  const e1 = await okJoin(w1, asset, day, day, ['09:00', '11:00']); await tick();
  const told = lastMail(owner, 'Another team%');
  assert.match(told.html, /8:00 AM – 5:00 PM/, 'their own reservation, with its times');
  assert.match(told.html, /9:00 AM – 11:00 AM/, 'what the other team is waiting for');
  await owner.client.post(`/api/reservations/${resv.id}/cancel`, {});
  waitlist.dispatchHoldEmails(db); await tick();
  const hold = lastMail(w1, 'Available for you%');
  assert.match(hold.html, /Your dates:<\/strong> [^<]*9:00 AM – 11:00 AM/);
  void e1;
});

// ================================================================ front end (source / helper level; rendering is browser QA)
test('front end: the date sheet has optional Pickup and Return time fields and reuses the existing sheet pattern', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sheet = src.slice(src.indexOf('function rangeSheet('), src.indexOf('function wireWaitlistActions('));
  assert.match(sheet, /timeField\('start_time', 'Pickup time', t0\)/);
  assert.match(sheet, /timeField\('end_time', 'Return time', t1\)/);
  assert.match(sheet, /<span class="muted">\(optional\)<\/span>/, 'both are clearly optional');
  assert.match(sheet, /\$\{timeBox\(name, v\)\}/, 'a typed + list combobox, not a native time input');
  assert.doesNotMatch(sheet, /type="time"/);
  assert.doesNotMatch(sheet, /enable times|type="checkbox"/i, 'no "enable times" switch');
  assert.doesNotMatch(src, /OVERLAP_TITLE|OVERLAP_TEXT|Availability not guaranteed/, 'the old "record it anyway" warning is gone');
  assert.match(sheet, /start_time: f\.start_time\.value \|\| null, end_time: f\.end_time\.value \|\| null/, 'blank = null, never a made-up time');
});

test('front end: ranges are written by ONE helper in plain 12-hour words (no seconds, no raw HH:MM, no Date/time-zone arithmetic)', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pick = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const block = `${pick('const fmtClock =', '\nconst typeText')}\n${pick('const isoAdd =', '\nconst resvDays')}\n${pick('const resvDays =', '\nconst RESV_LABEL')}`;
  const ctx = { fmtDate: (d) => ({ '2030-10-12': 'Oct 12, 2030', '2030-10-14': 'Oct 14, 2030' })[d] };
  vm.createContext(ctx);
  vm.runInContext(`${block}; this.resvRange = resvRange; this.resvWhen = resvWhen; this.calRange = calRange; this.fmtClock = fmtClock;`, ctx);
  const R = (st, et, e = '2030-10-12') => ({ start_date: '2030-10-12', start_time: st, end_date: e, end_time: et });
  assert.equal(ctx.resvRange(R(null, null)), 'Oct 12, 2030');
  assert.equal(ctx.resvRange(R(null, null), { allDay: true }), 'Oct 12, 2030 · All day');
  assert.equal(ctx.resvRange(R('08:00', null)), 'Oct 12, 2030 · Pickup 8:00 AM');
  assert.equal(ctx.resvRange(R(null, '13:00')), 'Oct 12, 2030 · Return by 1:00 PM');
  assert.equal(ctx.resvRange(R('08:00', '13:00')), 'Oct 12, 2030 · 8:00 AM – 1:00 PM');
  assert.equal(ctx.resvRange(R('13:00', '11:00', '2030-10-14')), 'Oct 12, 2030, 1:00 PM – Oct 14, 2030, 11:00 AM');
  assert.equal(ctx.resvRange(R(null, '11:00', '2030-10-14')), 'Oct 12, 2030 – Oct 14, 2030 · Return by 11:00 AM');
  assert.equal(ctx.resvRange(R('08:00', null, '2030-10-14')), 'Oct 12, 2030 – Oct 14, 2030 · Pickup 8:00 AM');
  assert.equal(ctx.resvWhen(R(null, null, '2030-10-14')), 'Oct 12, 2030 – Oct 14, 2030 · 3 days');
  assert.equal(ctx.resvWhen(R('08:00', '13:00')), 'Oct 12, 2030 · 8:00 AM – 1:00 PM', 'a single day shows its hours, no day count');
  assert.equal(ctx.calRange({ start: '2030-10-12', end: '2030-10-12', start_time: '08:00', end_time: '13:00' }, '2030-10-12'), '8:00 AM – 1:00 PM', 'on its own day only the hours');
  assert.equal(ctx.calRange({ start: '2030-10-12', end: '2030-10-12', start_time: null, end_time: null }, '2030-10-12'), 'All day');
  assert.equal(ctx.fmtClock('00:00'), '12:00 AM'); assert.equal(ctx.fmtClock('12:30'), '12:30 PM');
});

test('front end: the calendar names partial days, lists every entry on a day, lets any lendable day be asked for, and Shorten takes an optional return time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(src, /partial: 'partially scheduled'/);
  assert.match(src, /<span><i class="partial"><\/i>Partly scheduled<\/span>/);
  assert.match(css, /\.cal-day\.partial \{/);
  assert.match(src, /parts\.push\(`Reserved: \$\{esc\(calRange\(x, day\)\)\}/, 'every confirmed reservation on the day is listed, whatever the day\'s state');
  assert.match(src, /const takeable = \(s0\) => \['available', 'expected', 'partial', 'reserved', 'occupied'\]\.includes\(s0\)/, 'any lendable day can be asked for: the server reserves what is free and waitlists the rest');
  const shorten = src.slice(src.indexOf('function shortenSheet('), src.indexOf('// Wires every reservation button'));
  assert.match(shorten, /timeBox\('end_time', r\.end_time \|\| '', 'sc-time'\)/, 'Shorten opens AT the current return time');
  assert.match(shorten, /\{ end_date: end, end_time: time \|\| null \}/);
  assert.match(shorten, /keyEnd\(end, time\)/, 'the button is only live for a genuinely earlier return');
  const raw = src.slice(src.indexOf('function reservationItem('), src.indexOf('function shortenSheet('));
  assert.doesNotMatch(raw, /start_time\}|end_time\}/, 'a reservation row never prints a raw DB time');
});
