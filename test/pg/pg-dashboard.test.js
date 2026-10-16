// Slice 5C-2 (D-46, D-48): src/pg/dashboard.js, differential against src/dashboard.js. Every fixture row is written to BOTH engines with
// the same ids (test-support/pg-twin.js) and the dashboard must be deep-equal for IT, an employee and a login without a person: the
// empty database, then every statistic (counts as numbers, the purchase-cost total with float costs, the 60-day windows at their
// edges), the category counts with ties, the overdue / open request / expiring / activity queues with their LIMITs and equal
// timestamps, and the employee's own equipment with its return / issue request columns. Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');

const sq = require('../../src/dashboard');
const pg = require('../../src/pg/dashboard');

describe('PostgreSQL dashboard twin (differential against src/dashboard.js)', pgSuite(), () => {
  let tdb; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);
  const same = (label, user) => tw.same(label, (q) => pg.dashboard(q, user), (db) => sq.dashboard(db, user));

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    today = await pgTime.today(tdb.pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Admin' });
    w.ben = await tw.employee({ name: 'Ben Borrower' });
    w.emile = await tw.employee({ name: 'Émile Ünïcode', work_email: 'Emile@Nutricost.com' });
    w.cy = await tw.employee({ name: 'Cy Inactive', status: 'inactive' });
    w.anaAcc = await tw.insert('accounts', { login_email: 'ana@nutricost.com', role: 'admin', employee_id: w.ana.id });
    w.benAcc = await tw.insert('accounts', { login_email: 'ben@nutricost.com', role: 'employee', employee_id: w.ben.id });
    w.robot = await tw.insert('accounts', { login_email: 'robot@nutricost.com', role: 'admin', employee_id: null });
    w.admin = { role: 'admin', employee_id: w.ana.id, account_id: w.anaAcc.id };
    w.benUser = { role: 'employee', employee_id: w.ben.id, account_id: w.benAcc.id };
    w.robotAdmin = { role: 'admin', employee_id: null, account_id: w.robot.id };
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('an empty database: zero counts (numbers), value 0, empty queues', async () => {
    const out = (await same('empty admin', w.admin)).ok;
    assert.deepEqual(out.stats, { total: 0, available: 0, checked_out: 0, maintenance: 0, overdue: 0, open_requests: 0, users: 3, value: 0, warranty_soon: 0, licenses_soon: 0 });
    assert.deepEqual([out.mine, out.myRequests, out.byCategory, out.overdue, out.openRequests, out.expiring, out.activity], [[], [], [], [], [], [], []]);
    await same('empty employee', w.benUser);
    await same('empty unlinked admin', w.robotAdmin);
  });

  test('every aggregate, queue and the employee\'s own equipment match SQLite', async () => {
    const A = (cols) => tw.asset(cols);
    // costs whose plain float sum differs from SQLite's compensated one (0.1 + 0.2 + 0.3), integers, NULLs, an archived and a retired one
    w.a1 = await A({ category: 'Laptop', purchase_cost: 0.1, warranty_expires: today });
    w.a2 = await A({ category: 'Laptop', purchase_cost: 0.2, warranty_expires: d(60), status: 'checked_out' });
    w.a3 = await A({ category: 'Monitor', purchase_cost: 0.3, warranty_expires: d(61), license_expires: d(10), status: 'checked_out' });
    w.a4 = await A({ category: 'Monitor', purchase_cost: 1200, license_expires: d(-1), status: 'maintenance' });
    w.a5 = await A({ category: 'Camera', purchase_cost: null, warranty_expires: d(30), license_expires: d(5), status: 'checked_out' });
    w.a6 = await A({ category: 'Camera', purchase_cost: 19.99, warranty_expires: d(1), archived_at: '2026-01-02 00:00:00' });
    w.a7 = await A({ category: 'Ünïcode', purchase_cost: 5.55, status: 'retired', warranty_expires: d(2) });
    w.a8 = await A({ category: 'Software', purchase_cost: 33.33, license_expires: '2026-13-99' }); // not a real date: compared as text
    for (let i = 0; i < 22; i++) await A({ category: i % 2 ? 'Bulk A' : 'Bulk B', warranty_expires: d(i % 3), purchase_cost: i % 4 ? 0.07 : null });
    // assignments: overdue (equal due dates), due today (not overdue), returned, multi-holder on one asset
    await tw.checkout({ asset_id: w.a2.id, employee_id: w.ben.id, due_date: d(-1) });
    await tw.checkout({ asset_id: w.a3.id, employee_id: w.ben.id, due_date: d(-1) });
    await tw.assignment({ asset_id: w.a5.id, employee_id: w.ben.id });
    await tw.checkout({ asset_id: w.a5.id, employee_id: w.emile.id, due_date: d(-30) });
    await tw.checkout({ asset_id: w.a1.id, employee_id: w.emile.id, due_date: today });
    await tw.checkout({ asset_id: w.a4.id, employee_id: w.ben.id, due_date: d(-5), returned_at: '2026-01-03 00:00:00' });
    for (let i = 0; i < 22; i++) await tw.checkout({ asset_id: (await A({ category: 'Overdue' })).id, employee_id: w.cy.id, due_date: d(-2) });
    // requests: Ben's return requests (by IT and by himself), issues, equipment requests with equal created_at, every status
    const req = (cols) => tw.insert('requests', { type: 'equipment', status: 'open', user_id: w.ben.id, created_by: w.benAcc.id, ...cols });
    await req({ type: 'return', asset_id: w.a2.id, created_by: w.anaAcc.id, needed_by: d(3), message: 'Ünï return' });
    await req({ type: 'return', asset_id: w.a3.id, status: 'dropped_off' });
    await req({ type: 'return', asset_id: w.a5.id, created_by: null });
    await req({ type: 'issue', asset_id: w.a2.id });
    await req({ type: 'issue', asset_id: w.a2.id, message: 'second' });
    await req({ type: 'issue', asset_id: w.a3.id, status: 'completed', resolved_at: '2026-01-02 00:00:00' });
    await req({ status: 'approved', resolved_at: '2026-01-02 00:00:00' });
    await req({ opened_at: '2026-01-01 00:00:00' });
    await req({ created_at: '2026-01-05 00:00:00', category: 'Laptop' });
    await req({ status: 'cancelled', resolved_at: '2026-01-02 00:00:00', resolved_by: w.benAcc.id });
    await req({ status: 'approved', resolved_at: '2026-01-02 00:00:00' }); // after an open one with the same created_at
    for (let i = 0; i < 20; i++) await req({ user_id: w.emile.id, created_by: w.robot.id, asset_id: i % 2 ? w.a1.id : null });
    for (let i = 0; i < 20; i++) await tw.insert('activity', { asset_id: i % 4 ? w.a1.id : null, actor_id: [w.anaAcc.id, w.robot.id, null][i % 3], action: `act${i}` });

    for (const [u, user] of Object.entries({ admin: w.admin, ben: w.benUser, robotAdmin: w.robotAdmin, emile: { role: 'employee', employee_id: w.emile.id } })) await same(`dashboard as ${u}`, user);
    const out = (await same('admin', w.admin)).ok;
    assert.deepEqual(Object.values(out.stats).map((v) => typeof v), Array(10).fill('number'));
    assert.deepEqual(out.stats, { total: 50, available: 46, checked_out: 26, maintenance: 1, overdue: 25, open_requests: 29, users: 3, value: out.stats.value, warranty_soon: 25, licenses_soon: 2 });
    assert.ok(Math.abs(out.stats.value - 1235.05) < 1e-9 && String(out.stats.value) === '1235.05', `a correctly rounded total, as SQLite gives (${out.stats.value})`);
    assert.deepEqual([out.overdue.length, out.openRequests.length, out.expiring.length, out.activity.length], [20, 20, 20, 15]);
    assert.deepEqual(out.byCategory.slice(0, 4).map((c) => `${c.category}:${c.n}`), ['Overdue:22', 'Bulk B:11', 'Bulk A:11', 'Monitor:2'], 'tied counts in SQLite\'s order');
    const ben = (await same('ben', w.benUser)).ok;
    assert.equal(ben.stats, undefined);
    assert.deepEqual(ben.mine.map((m) => [m.asset_id, m.return_status, m.return_self, m.issue_request_id !== null, m.open_issues]),
      [[w.a2.id, 'open', 0, true, 2], [w.a3.id, 'dropped_off', 1, false, 0], [w.a5.id, 'open', 0, false, 0]], 'checkouts first, equal checked_out_at by id');
    assert.deepEqual(ben.myRequests.map((r) => [r.status, r.lifecycle]), [['open', 'submitted'], ['approved', 'approved'], ['approved', 'approved'], ['open', 'in_review']], 'equal created_at: approved before open (SQLite\'s index order), then by id');
  });
});
