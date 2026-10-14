// src/pg/availability.js (D-46, Slice 4A): the availability calendar on PostgreSQL. Builds ONE world of assets, catalog
// entries, assignments, reservations and waitlist holds identically on PostgreSQL and on the SQLite reference (pg-twin) and
// requires availability() / resolveScope() / todayStates() to give deep-equal output (or the same {status, message} error) for
// every scope, viewer and month; then checks the ported scenarios of test/availability.test.js explicitly on the PG output
// (every day state, seats, anonymity, the schedulable pool, truncation, holds counting only while hold_expires_at > NOW).
// Deterministic: dates are relative to the database's today, hold expiries are +/- 6 hours from the database clock, and
// nothing here reads the JS clock. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction } = require('../../src/pg/transaction');
const sqliteAvailability = require('../../src/availability');
const availability = require('../../src/pg/availability');

const addMonths = (month, n) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const HOURS6 = 6 * 3600;

describe('PostgreSQL availability (differential against src/availability.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    const live = await tw.stamp(HOURS6); const lapsed = await tw.stamp(-HOURS6);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Viewer', department: 'Ops' });
    w.ben = await tw.employee({ name: 'Ben Other', department: 'Sales' });
    w.cy = await tw.employee({ name: 'Cy Third' });
    w.cameras = await tw.node('Cameras');
    w.dslr = await tw.node('DSLR', { parent_id: w.cameras.id });
    w.old = await tw.node('Old', { parent_id: w.cameras.id, archived_at: '2026-01-01 00:00:00' });
    w.laptops = await tw.node('Laptops');
    w.bulk = await tw.node('Bulk');
    tw.invalidateCatalogs();
    const cam = (cols) => tw.asset({ catalog_node_id: w.dslr.id, available_to_request: 1, ...cols });
    // names chosen so byte order and NOCASE order differ ('Beta' < 'alpha' by byte), plus non-ASCII and a NOCASE tag tie-break
    w.free = await cam({ name: 'alpha free', tag: 'CAM-1', category: 'Camera' });
    w.perm = await cam({ name: 'Beta permanent', tag: 'CAM-2', status: 'checked_out' });
    await tw.assignment({ asset_id: w.perm.id, employee_id: w.ben.id });
    w.out = await cam({ name: 'gamma out', tag: 'CAM-3', status: 'checked_out' });
    await tw.checkout({ asset_id: w.out.id, employee_id: w.ben.id, due_date: d(3), due_time: '13:00', checked_out_at: `${d(-2)} 09:00:00` });
    w.overdue = await cam({ name: 'Delta overdue', tag: 'CAM-4', status: 'checked_out' });
    await tw.checkout({ asset_id: w.overdue.id, employee_id: w.ben.id, due_date: d(-2), checked_out_at: `${d(-9)} 09:00:00` });
    w.booked = await cam({ name: 'epsilon booked', tag: 'CAM-5', reservation_requires_approval: 1 });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ben.id, start_date: d(2), end_date: d(4) });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ben.id, start_date: d(6), start_time: '13:00', end_time: '17:00' });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ana.id, start_date: d(8), status: 'pending' });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ben.id, start_date: d(9), status: 'pending' });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ben.id, start_date: d(10), status: 'cancelled' });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ana.id, start_date: d(11), end_time: '10:00' });
    await tw.reservation({ asset_id: w.booked.id, employee_id: w.ana.id, start_date: d(-5), end_date: d(-3) });
    w.held = await cam({ name: 'zeta held', tag: 'CAM-6' });
    w.liveHold = await tw.entry({ asset_id: w.held.id, employee_id: w.ben.id, start_date: d(1), end_date: d(2), status: 'held', hold_expires_at: live, queue_seq: 1 });
    w.lapsedHold = await tw.entry({ asset_id: w.held.id, employee_id: w.ben.id, start_date: d(5), status: 'held', hold_expires_at: lapsed, queue_seq: 2 });
    w.anaHold = await tw.entry({ asset_id: w.held.id, employee_id: w.ana.id, start_date: d(12), start_time: '09:00', status: 'held', hold_expires_at: live, queue_seq: 3 });
    await tw.entry({ asset_id: w.held.id, employee_id: w.ana.id, start_date: d(7), queue_seq: 5 });
    await tw.entry({ asset_id: w.held.id, employee_id: w.ben.id, start_date: d(7), start_time: '08:00', end_time: '12:00', queue_seq: 4 });
    await tw.entry({ asset_id: w.held.id, employee_id: w.ben.id, start_date: d(7), start_time: '13:00', queue_seq: 4 }); // a split piece: same queue_seq
    // a later-inserted HELD piece with the same queue_seq: SQLite lists it before the waiting pieces (status, then rowid)
    w.pieceHold = await tw.entry({ asset_id: w.held.id, employee_id: w.ben.id, start_date: d(13), status: 'held', hold_expires_at: live, queue_seq: 4 });
    await tw.entry({ asset_id: w.held.id, employee_id: w.cy.id, start_date: d(8), status: 'left' });
    w.repair = await cam({ name: 'Eta repair', tag: 'CAM-7', status: 'maintenance' });
    w.retired = await cam({ name: 'theta retired', tag: 'CAM-8', status: 'retired' });
    w.archived = await cam({ name: 'Iota archived', tag: 'CAM-9', archived_at: '2026-01-01 00:00:00' });
    w.seats = await cam({ name: 'kappa seats', tag: 'CAM-10', license_seats: 3 });
    await tw.checkout({ asset_id: w.seats.id, employee_id: w.ben.id, due_date: d(2), checked_out_at: `${d(-1)} 09:00:00` });
    await tw.assignment({ asset_id: w.seats.id, employee_id: w.cy.id, assignment_type: 'checkout', due_date: d(20), checked_out_at: `${d(-1)} 10:00:00` });
    w.full = await cam({ name: 'Lambda full', tag: 'CAM-11', license_seats: 2, status: 'checked_out' });
    await tw.checkout({ asset_id: w.full.id, employee_id: w.ben.id, due_date: d(1), checked_out_at: `${d(-1)} 09:00:00` });
    await tw.checkout({ asset_id: w.full.id, employee_id: w.cy.id, due_date: d(4), due_time: '09:30', checked_out_at: `${d(-1)} 09:00:00` });
    w.hidden = await cam({ name: 'mu hidden', tag: 'CAM-12', available_to_request: 0 });
    w.inOld = await tw.asset({ name: 'nu in archived entry', tag: 'CAM-13', catalog_node_id: w.old.id, available_to_request: 1 });
    w.mine = await cam({ name: 'xi mine', tag: 'CAM-14', available_to_request: 0, status: 'checked_out' });
    await tw.checkout({ asset_id: w.mine.id, employee_id: w.ana.id, due_date: d(5), checked_out_at: `${d(-1)} 09:00:00` });
    w.nonAscii = await cam({ name: 'Éclair', tag: 'CAM-15' });
    w.nonAscii2 = await cam({ name: 'éclair', tag: 'CAM-16' });
    w.zed = await cam({ name: 'Zed', tag: 'CAM-17' });
    w.tieB = await cam({ name: 'Same name', tag: 'FX-B' }); // byte order would put FX-B before fx-a
    w.tieA = await cam({ name: 'same NAME', tag: 'fx-a' });
    w.tieC = await cam({ name: 'Same name', tag: 'fx-c' });
    w.laptop = await tw.asset({ name: 'Laptop one', tag: 'LAP-1', catalog_node_id: w.laptops.id, available_to_request: 1 });
    w.nodeless = await tw.asset({ name: 'no entry', tag: 'NOE-1', available_to_request: 1 });
    w.offPool = await tw.asset({ name: 'off pool', tag: 'OFF-1', catalog_node_id: w.laptops.id, status: 'lost' });
    // Bulk: 1001 requestable assets (MAX_ASSETS 1000 + 1) with 201 open temporary checkouts (MAX_EVENTS 200 + 1)
    for (let i = 1; i <= 1001; i++) {
      const a = await tw.asset({ name: `Bulk ${String(1002 - i).padStart(4, '0')}`, tag: `BLK-${i}`, catalog_node_id: w.bulk.id, available_to_request: 1 });
      // (i = 1 is 'Bulk 1001', the asset the 1000 cap cuts off, so it carries no checkout)
      if (i >= 2 && i <= 202) await tw.checkout({ asset_id: a.id, employee_id: w.ben.id, due_date: d(1 + (i % 9)), checked_out_at: `${d(-1)} 09:00:00` });
    }
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  const pgAv = (args) => (q) => availability.availability(q, args);
  const sqAv = (args) => (db) => sqliteAvailability.availability(db, args);
  const viewers = () => ({
    admin: { isAdmin: true, employeeId: null },
    ana: { isAdmin: false, employeeId: w.ana.id },
    anaReserve: { isAdmin: false, employeeId: w.ana.id, canReserve: true },
    unlinked: { isAdmin: false, employeeId: null },
  });

  test('every scope, viewer and month gives identical output (or the identical error)', async () => {
    const months = [undefined, '', today.slice(0, 7), addMonths(today.slice(0, 7), 1), addMonths(today.slice(0, 7), -1)];
    const assetIds = Object.values(w).filter((r) => r.tag && !r.tag.startsWith('BLK')).map((r) => r.id);
    const scopes = [
      {}, { nodeId: w.cameras.id }, { nodeId: w.dslr.id }, { nodeId: w.old.id }, { nodeId: w.laptops.id }, { nodeId: String(w.cameras.id) },
      { nodeId: 999999 }, { nodeId: 'x' }, { nodeId: 0 }, { nodeId: w.cameras.id, assetId: w.free.id },
      ...assetIds.map((assetId) => ({ assetId })), { assetId: String(w.free.id) }, { assetId: 'abc' }, { assetId: 0 }, { assetId: -3 }, { assetId: 1.5 },
      { assetId: 999999 }, { assetId: 1e10 }, { assetId: 2147483648 },
    ];
    let compared = 0;
    for (const [who, v] of Object.entries(viewers())) {
      for (const scope of scopes) {
        for (const month of who === 'admin' || scope.assetId === w.booked.id || scope.nodeId === w.cameras.id ? months : [undefined]) {
          const args = { ...v, ...scope, month };
          await tw.same(`${who} ${JSON.stringify(scope)} ${month}`, pgAv(args), sqAv(args));
          compared++;
        }
      }
    }
    for (const month of ['2026-13', 'abc', '1999-12', '2101-01', '2026-1', 202611]) {
      const args = { isAdmin: true, month };
      const out = await tw.same(`bad month ${month}`, pgAv(args), sqAv(args));
      assert.deepEqual(out.error, { status: 400, message: 'Month must look like 2026-11' });
    }
    assert.ok(compared > 200, `${compared} calls compared`);
  });

  test('truncation: 1000 assets, 200 events, 300 listed rows; the cut follows the NOCASE name order', async () => {
    const admin = await tw.same('admin bulk', pgAv({ isAdmin: true, nodeId: w.bulk.id }), sqAv({ isAdmin: true, nodeId: w.bulk.id }));
    assert.equal(admin.ok.total, 1000);
    assert.equal(admin.ok.scope.truncated, true);
    assert.equal(admin.ok.events.length, 200);
    assert.equal(admin.ok.events_truncated, true);
    const emp = await tw.same('employee bulk', pgAv({ isAdmin: false, employeeId: w.ana.id, nodeId: w.bulk.id }), sqAv({ isAdmin: false, employeeId: w.ana.id, nodeId: w.bulk.id }));
    assert.equal(emp.ok.assets.length, 300);
    assert.equal(emp.ok.assets_truncated, true);
    assert.equal(emp.ok.assets[0].name, 'Bulk 0001', 'name order, not insertion order');
    const scope = await tw.same('resolveScope bulk', (q) => availability.resolveScope(q, { isAdmin: true, nodeId: w.bulk.id }), (db) => sqliteAvailability.resolveScope(db, { isAdmin: true, nodeId: w.bulk.id }));
    assert.equal(scope.ok.assets.length, 1000);
    assert.equal(scope.ok.assets.at(-1).name, 'Bulk 1000', 'Bulk 1001 is the one cut off');
  });

  test('ordering: lower(name) then lower(tag), exactly SQLite NOCASE (ASCII folding only, bytes for the rest)', async () => {
    const out = await tw.same('cameras order', (q) => availability.resolveScope(q, { isAdmin: true, nodeId: w.cameras.id }), (db) => sqliteAvailability.resolveScope(db, { isAdmin: true, nodeId: w.cameras.id }));
    const names = out.ok.assets.map((a) => `${a.name}|${a.tag}`);
    assert.ok(names.indexOf('alpha free|CAM-1') < names.indexOf('Beta permanent|CAM-2') || !names.includes('Beta permanent|CAM-2'));
    assert.ok(names.indexOf('alpha free|CAM-1') < names.indexOf('Delta overdue|CAM-4'), 'case-insensitive: alpha before Delta');
    assert.deepEqual(names.filter((n) => /^same name\|/i.test(n)), ['same NAME|fx-a', 'Same name|FX-B', 'Same name|fx-c'], 'the NOCASE tag breaks the tie');
    const tail = names.slice(-2);
    assert.deepEqual(tail, ['Éclair|CAM-15', 'éclair|CAM-16'], 'non-ASCII is not folded and sorts after ASCII by byte');
  });

  test('todayStates (Browse list): available / checked_out with expected_back / reserved / partial / unavailable', async () => {
    const sqAssets = (ids) => tw.sqlite.prepare(`SELECT * FROM assets WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
    const pgAssets = async (ids) => (await pool.query('SELECT * FROM assets WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
    const ids = Object.values(w).filter((r) => r.tag).map((r) => r.id);
    const out = await tw.same('todayStates', async (q) => availability.todayStates(q, await pgAssets(ids)), (db) => sqliteAvailability.todayStates(db, sqAssets(ids)));
    const s = out.ok;
    assert.deepEqual(s.get(w.free.id), { state: 'available', expected_back: null });
    assert.deepEqual(s.get(w.out.id), { state: 'checked_out', expected_back: d(3) });
    assert.deepEqual(s.get(w.overdue.id), { state: 'checked_out', expected_back: null });
    assert.deepEqual(s.get(w.repair.id), { state: 'unavailable', expected_back: null });
    assert.deepEqual(s.get(w.full.id), { state: 'checked_out', expected_back: d(1) });
    assert.deepEqual(await availability.todayStates(pool, []), new Map());
    // a confirmed reservation over all of today, a hold over part of it, an EXPIRED hold over all of it
    const r = await tw.asset({ name: 'today reserved', tag: 'TD-1', available_to_request: 1 });
    await tw.reservation({ asset_id: r.id, employee_id: w.ben.id, start_date: today });
    const p = await tw.asset({ name: 'today partial', tag: 'TD-2', available_to_request: 1 });
    await tw.entry({ asset_id: p.id, employee_id: w.ben.id, start_date: today, start_time: '23:59', status: 'held', hold_expires_at: await tw.stamp(HOURS6) });
    const x = await tw.asset({ name: 'today lapsed hold', tag: 'TD-3', available_to_request: 1 });
    await tw.entry({ asset_id: x.id, employee_id: w.ben.id, start_date: today, status: 'held', hold_expires_at: await tw.stamp(-HOURS6) });
    const more = await tw.same('todayStates 2', async (q) => availability.todayStates(q, await pgAssets([r.id, p.id, x.id])), (db) => sqliteAvailability.todayStates(db, sqAssets([r.id, p.id, x.id])));
    assert.deepEqual([...more.ok.values()].map((v) => v.state), ['reserved', 'partial', 'available']);
  });

  test('every day state on the single-asset calendar (admin)', async () => {
    const row = async (asset, month) => (await availability.availability(pool, { isAdmin: true, assetId: asset.id, month })).assets[0];
    const dayOf = (r, day, month) => (day.slice(0, 7) === month ? r.days[Number(day.slice(8)) - 1] : undefined);
    const month = today.slice(0, 7);
    const check = async (asset, day, state) => {
      const m = day.slice(0, 7);
      const r = await row(asset, m);
      assert.equal(dayOf(r, day, m), state, `${asset.name} on ${day}`);
    };
    await check(w.free, today, 'available');
    await check(w.free, d(-1), 'past');
    await check(w.out, d(3), 'occupied');
    await check(w.out, d(4), 'expected');
    await check(w.overdue, d(30), 'occupied');
    await check(w.booked, d(3), 'reserved');
    await check(w.booked, d(6), 'partial');
    await check(w.booked, d(8), 'available'); // a pending reservation never changes a day
    await check(w.held, d(1), 'reserved'); // an active hold counts like a confirmed reservation
    await check(w.held, d(5), 'available'); // an expired-but-unswept hold counts for nothing
    await check(w.held, d(12), 'partial');
    await check(w.repair, d(1), 'repair');
    await check(w.retired, d(1), 'ineligible');
    await check(w.archived, d(1), 'archived');
    await check(w.seats, d(1), 'available'); // 2 of 3 seats taken
    await check(w.full, d(1), 'occupied');
    await check(w.full, d(2), 'expected'); // one seat due back on d(1): every seat still taken today
    const seats = await row(w.seats, month);
    assert.deepEqual(seats.seats, { total: 3, used: 2 });
    const held = await row(w.held, month);
    assert.deepEqual(held.holds.map((h) => h.id), [w.liveHold.id, w.anaHold.id, w.pieceHold.id]);
    assert.ok(!held.waitlist.some((e) => e.id === w.lapsedHold.id), 'a lapsed hold is not in the line');
    assert.equal(held.waitlist[0].id, w.liveHold.id, 'FIFO by queue_seq');
    assert.deepEqual(held.waitlist.slice(2, 5).map((e) => [e.id === w.pieceHold.id, e.phase]), [[true, 'held'], [false, 'waiting'], [false, 'waiting']], 'queue_seq ties: the held piece first');
    const booked = await row(w.booked, month);
    assert.equal(booked.reserve.requires_approval, true);
    assert.ok(booked.reservations.every((r) => r.holder && r.id), 'IT sees every reservation with its holder');
  });

  test('employees: anonymous, narrowed, no hidden assets, no repair, no global calendar', async () => {
    const emp = { isAdmin: false, employeeId: w.ana.id };
    await assert.rejects(availability.availability(pool, emp), { status: 400, message: 'Choose a category or an item first. The calendar for all equipment is for IT.' });
    const node = await availability.availability(pool, { ...emp, nodeId: w.cameras.id });
    const listed = node.assets.map((a) => a.id);
    for (const hidden of [w.hidden, w.repair, w.retired, w.archived, w.perm, w.inOld, w.mine]) assert.ok(!listed.includes(hidden.id), `${hidden.name} is not listed`);
    assert.equal(node.total, listed.length);
    assert.ok(!('events' in node));
    for (const a of node.assets) {
      for (const p of a.periods) assert.ok(!('holder' in p) && !('assignment_type' in p));
      for (const r of a.reservations) assert.ok(!('holder' in r));
      for (const h of a.holds) assert.ok(!('holder' in h));
      assert.equal(a.status, undefined);
      assert.equal(a.reserve.allowed, false, 'the catalog list never offers Reserve');
    }
    const booked = node.assets.find((a) => a.id === w.booked.id);
    assert.ok(booked.reservations.some((r) => r.status === 'pending' && r.mine && r.id), 'own pending reservation, with its id');
    assert.ok(!booked.reservations.some((r) => r.status === 'pending' && !r.mine), "someone else's pending reservation is not shown");
    assert.ok(booked.reservations.filter((r) => !r.mine).every((r) => !('id' in r)), "no ids on other people's reservations");
    const gamma = node.assets.find((a) => a.id === w.out.id);
    assert.equal(gamma.tag, null, "a checked-out asset's tag is not shown to an employee");
    await assert.rejects(availability.availability(pool, { ...emp, nodeId: w.old.id }), { status: 404, message: 'Catalog entry not found' });
    await assert.rejects(availability.availability(pool, { ...emp, assetId: w.hidden.id }), { status: 404, message: 'Asset not found' });
    await assert.rejects(availability.availability(pool, { ...emp, assetId: w.repair.id }), { status: 404, message: 'Asset not found' });
    const mine = await availability.availability(pool, { ...emp, assetId: w.mine.id });
    assert.equal(mine.assets[0].mine, true, 'an asset the employee holds is visible to them directly');
    assert.equal(mine.assets[0].tag, 'CAM-14');
    const offer = await availability.availability(pool, { ...emp, assetId: w.free.id, canReserve: true });
    assert.equal(offer.assets[0].reserve.allowed, true);
    const ownHold = (await availability.availability(pool, { ...emp, assetId: w.held.id })).assets[0];
    assert.deepEqual(ownHold.holds.filter((h) => h.mine).map((h) => h.id), [w.anaHold.id]);
    assert.ok(ownHold.waitlist.every((e) => e.mine), 'an employee sees only their own places in line');
  });

  test('broad calendars leave permanently assigned assets out; admin events and per-day counts', async () => {
    const g = await availability.availability(pool, { isAdmin: true, nodeId: w.cameras.id });
    assert.equal(g.view, 'summary');
    assert.ok(!g.events.some((e) => e.asset_id === w.perm.id));
    const ev = g.events.find((e) => e.asset_id === w.overdue.id);
    assert.deepEqual([ev.overdue, ev.end, ev.due_time], [true, null, null]);
    assert.equal(g.events[0].overdue, true, 'overdue first');
    const todayCounts = g.days[Number(today.slice(8)) - 1];
    assert.deepEqual(Object.keys(todayCounts), ['available', 'expected', 'checked_out', 'reserved', 'partial', 'off']);
    const scopeIds = (await availability.resolveScope(pool, { isAdmin: true, nodeId: w.cameras.id })).assets.map((a) => a.id);
    assert.ok(!scopeIds.includes(w.perm.id) && !scopeIds.includes(w.archived.id));
    assert.ok(scopeIds.includes(w.repair.id) && scopeIds.includes(w.inOld.id), 'admins see repair and archived entries');
    const gl = await availability.availability(pool, { isAdmin: true });
    assert.equal(gl.scope.type, 'global');
  });

  test('works on a transaction client (and with a fresh catalog read inside it)', async () => {
    const viaPool = await availability.availability(pool, { isAdmin: true, nodeId: w.cameras.id });
    const viaTx = await withTransaction((c) => availability.availability(c, { isAdmin: true, nodeId: w.cameras.id }), pool);
    assert.deepEqual(viaTx, viaPool);
  });
});
