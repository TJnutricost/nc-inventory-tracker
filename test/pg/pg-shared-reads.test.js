// Slice 5C-1 (D-46, D-48): the PostgreSQL twins of the small shared helper modules extracted in 5B, differential against the SQLite
// originals: src/pg/activityLog.js, outbox.js, overdue.js, assetAccess.js, reservationViews.js, requestAccess.js. Every fixture row is
// written to BOTH engines with the same ids (test-support/pg-twin.js) and every call must give deep-equal results or the same
// { status, message } error: empty results, ordering and LIMITs, NULLs, unicode names, archived rows, admin vs employee visibility.
// Writes (activityLog.log, overdue.markNotified) run on both engines with synced sequences, then the rows are compared. Skipped
// without PostgreSQL; `npm run test:pg` requires it.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction } = require('../../src/pg/transaction');

const sq = {
  activityLog: require('../../src/activityLog'), outbox: require('../../src/outbox'), overdue: require('../../src/overdue'),
  assetAccess: require('../../src/assetAccess'), reservationViews: require('../../src/reservationViews'), requestAccess: require('../../src/requestAccess'),
};
const pg = {
  activityLog: require('../../src/pg/activityLog'), outbox: require('../../src/pg/outbox'), overdue: require('../../src/pg/overdue'),
  assetAccess: require('../../src/pg/assetAccess'), reservationViews: require('../../src/pg/reservationViews'), requestAccess: require('../../src/pg/requestAccess'),
};
const withoutStamp = ({ created_at, ...row }) => row; // (rows a module writes carry each engine's own clock)

describe('PostgreSQL shared helper twins (differential against the SQLite modules)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);
  // Calls `name` of module `m` on both engines with the same arguments (after the handle) and requires the same outcome.
  const same = (label, m, name, ...args) => tw.same(label, (q) => pg[m][name](q, ...args), (db) => sq[m][name](db, ...args));

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Admin', work_email: 'ana@nutricost.com' });
    w.ben = await tw.employee({ name: 'Ben Borrower' });
    w.emile = await tw.employee({ name: 'Émile Ünïcode', work_email: 'Emile@Nutricost.com', department: 'R&D' });
    w.cy = await tw.employee({ name: 'Cy Inactive', status: 'inactive' });
    w.anaAcc = await tw.insert('accounts', { login_email: 'ana.login@nutricost.com', role: 'admin', employee_id: w.ana.id });
    w.benAcc = await tw.insert('accounts', { login_email: 'ben.login@nutricost.com', role: 'employee', employee_id: w.ben.id });
    w.emileAcc = await tw.insert('accounts', { login_email: 'emile.login@nutricost.com', role: 'employee', employee_id: w.emile.id });
    w.robot = await tw.insert('accounts', { login_email: 'unlinked@nutricost.com', role: 'admin', employee_id: null });
    w.admin = { role: 'admin', employee_id: w.ana.id, account_id: w.anaAcc.id };
    w.benUser = { role: 'employee', employee_id: w.ben.id, account_id: w.benAcc.id };
    w.emileUser = { role: 'employee', employee_id: w.emile.id, account_id: w.emileAcc.id };
    w.noPerson = { role: 'employee', employee_id: null, account_id: w.robot.id };

    w.pool = await tw.asset({ name: 'Shared camera', available_to_request: 1 });
    w.poolOut = await tw.asset({ name: 'Shared laptop (out)', available_to_request: 1, status: 'checked_out' });
    w.archived = await tw.asset({ name: 'Archived shared', available_to_request: 1, archived_at: '2026-01-02 00:00:00' });
    w.repair = await tw.asset({ name: 'In repair', available_to_request: 1, status: 'maintenance' });
    w.private = await tw.asset({ name: 'Private desk PC' });
    w.bensDesk = await tw.asset({ name: 'Ben desk PC', status: 'checked_out' });
    await tw.assignment({ asset_id: w.bensDesk.id, employee_id: w.ben.id });
    w.poolOutCheckout = await tw.checkout({ asset_id: w.poolOut.id, employee_id: w.emile.id, due_date: d(-5) });
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('assetAccess: getAsset, canViewAsset, holdsAsset for admin, holder, pool, archived, private, unknown and bad ids', async () => {
    for (const id of [w.pool.id, w.archived.id, 999999, 'abc', '42.5', null]) await same(`getAsset ${id}`, 'assetAccess', 'getAsset', id);
    const users = { admin: w.admin, ben: w.benUser, emile: w.emileUser, noPerson: w.noPerson };
    for (const a of [w.pool, w.poolOut, w.archived, w.repair, w.private, w.bensDesk, undefined]) {
      for (const [u, user] of Object.entries(users)) {
        const out = await same(`canViewAsset ${a?.name} as ${u}`, 'assetAccess', 'canViewAsset', user, a);
        assert.equal(typeof out.ok, 'boolean');
      }
    }
    assert.deepEqual(await same('holdsAsset held', 'assetAccess', 'holdsAsset', w.bensDesk.id, w.ben.id), { ok: { 1: 1 } });
    for (const [a, e] of [[w.bensDesk.id, w.emile.id], [w.pool.id, w.ben.id], [w.bensDesk.id, null]]) await same(`holdsAsset ${a}/${e}`, 'assetAccess', 'holdsAsset', a, e);
  });

  test('assetAccess: reservableAsset / visibleAsset / heldAsset give the same rows and the same 404 / 400 errors', async () => {
    const users = { admin: w.admin, ben: w.benUser, emile: w.emileUser, noPerson: w.noPerson };
    for (const a of [w.pool, w.poolOut, w.archived, w.repair, w.private, w.bensDesk]) {
      for (const [u, user] of Object.entries(users)) {
        for (const fn of ['reservableAsset', 'visibleAsset', 'heldAsset']) await same(`${fn} ${a.name} as ${u}`, 'assetAccess', fn, user, String(a.id));
      }
    }
    assert.deepEqual((await same('unknown', 'assetAccess', 'visibleAsset', w.admin, 'nope')).error, { status: 404, message: 'Asset not found' });
    assert.deepEqual((await same('not held', 'assetAccess', 'heldAsset', w.emileUser, w.pool.id)).error, { status: 400, message: "This isn't checked out to you" });
    assert.equal((await same('poolOut reservable for ben', 'assetAccess', 'reservableAsset', w.benUser, w.poolOut.id)).ok.id, w.poolOut.id);
  });

  test('activityLog: recent is empty, then newest first with actor names (unlinked login, unicode), asset name/tag, NULL asset and LIMIT', async () => {
    assert.deepEqual(await same('empty', 'activityLog', 'recent', 10), { ok: [] });
    await tw.insert('activity', { asset_id: w.pool.id, actor_id: w.anaAcc.id, action: 'created', details: 'one', created_at: '2026-01-01 00:00:00' });
    await tw.insert('activity', { asset_id: null, actor_id: w.robot.id, action: 'settings', details: null, created_at: '2026-01-01 00:00:01' });
    await tw.insert('activity', { asset_id: w.bensDesk.id, actor_id: w.emileAcc.id, subject_user_id: w.ben.id, action: 'checkout', details: 'Ünïcode détails', created_at: '2026-01-01 00:00:02' });
    await tw.insert('activity', { asset_id: w.archived.id, actor_id: null, action: 'archived', details: 'x', created_at: '2026-01-01 00:00:03' });
    const all = (await same('all', 'activityLog', 'recent', 50)).ok;
    assert.deepEqual(all.map((r) => r.action), ['archived', 'checkout', 'settings', 'created']);
    assert.deepEqual(all.map((r) => r.actor_name), [null, 'Émile Ünïcode', 'unlinked@nutricost.com', 'Ana Admin']);
    assert.deepEqual((await same('limit 2', 'activityLog', 'recent', 2)).ok.map((r) => r.action), ['archived', 'checkout']);
  });

  test('activityLog.log writes the same row on both engines (blank details -> NULL, default subject NULL), also on a transaction client', async () => {
    await syncSequences(pool, tw.sqlite, ['activity']);
    const args = [[w.pool.id, w.anaAcc.id, 'note', ''], [null, null, 'sweep', 'Ünïcode'], [w.bensDesk.id, w.benAcc.id, 'return_requested', 'why', w.ben.id]];
    for (const a of args) { await pg.activityLog.log(pool, ...a); sq.activityLog.log(tw.sqlite, ...a); }
    await withTransaction((c) => pg.activityLog.log(c, w.repair.id, w.anaAcc.id, 'in_tx', 'tx'), pool);
    sq.activityLog.log(tw.sqlite, w.repair.id, w.anaAcc.id, 'in_tx', 'tx');
    const pgRows = (await pool.query('SELECT * FROM activity ORDER BY id DESC LIMIT 4')).rows.map(withoutStamp);
    const sqRows = tw.sqlite.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 4').all().map(withoutStamp);
    assert.deepEqual(pgRows, sqRows);
    assert.deepEqual(pgRows.map((r) => [r.action, r.details, r.subject_user_id]), [['in_tx', 'tx', null], ['return_requested', 'why', w.ben.id], ['sweep', 'Ünïcode', null], ['note', null, null]]);
  });

  test('outbox: latest / recent on an empty outbox, then newest first, the listed columns only, at most 100', async () => {
    await same('latest empty', 'outbox', 'latest');
    assert.deepEqual(await same('recent empty', 'outbox', 'recent'), { ok: [] });
    for (let i = 0; i < 103; i++) {
      await tw.insert('outbox', { to_addr: `p${i}@nutricost.com`, subject: `Sübject ${i}`, body: 'b', status: i % 2 ? 'sent' : 'failed', error: i % 2 ? null : 'smtp down', delivered_to: i % 3 ? null : 'redirect@nutricost.com' });
    }
    assert.deepEqual((await same('latest', 'outbox', 'latest')).ok, { status: 'failed', error: 'smtp down' });
    const rows = (await same('recent', 'outbox', 'recent')).ok;
    assert.equal(rows.length, 100);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'to_addr', 'subject', 'status', 'error', 'delivered_to', 'created_at']);
    assert.equal(rows[0].subject, 'Sübject 102');
  });

  test('overdue: due checkouts for active employees, the 3-day reminder window, then markNotified on both engines', async () => {
    const mk = (cols) => tw.checkout({ asset_id: w.pool.id, employee_id: w.ben.id, returned_at: '2026-01-02 00:00:00', ...cols });
    // (returned rows never count; an active one per asset+employee, so the live ones go on different assets)
    await mk({ due_date: d(-9) });
    const a2 = await tw.asset({ name: 'Overdue 2' }); const a3 = await tw.asset({ name: 'Overdue 3' }); const a4 = await tw.asset({ name: 'Overdue 4' });
    const a5 = await tw.asset({ name: 'Due today' }); const a6 = await tw.asset({ name: 'Inactive holder' });
    await tw.checkout({ asset_id: a2.id, employee_id: w.ben.id, due_date: d(-2), last_overdue_notice: d(-3) });   // reminded 3 days ago: due again
    await tw.checkout({ asset_id: a3.id, employee_id: w.emile.id, due_date: d(-2), last_overdue_notice: d(-2) }); // reminded 2 days ago: not yet
    await tw.checkout({ asset_id: a4.id, employee_id: w.ana.id, due_date: d(-1) });
    await tw.checkout({ asset_id: a5.id, employee_id: w.ben.id, due_date: today });
    await tw.checkout({ asset_id: a6.id, employee_id: w.cy.id, due_date: d(-30) });
    const due = (await same('due', 'overdue', 'dueAssignments')).ok;
    assert.deepEqual(due.map((r) => [r.asset_id, r.user_name, r.user_email]), [
      [w.poolOut.id, 'Émile Ünïcode', 'Emile@Nutricost.com'], [a2.id, 'Ben Borrower', 'ben.login@nutricost.com'], [a4.id, 'Ana Admin', 'ana@nutricost.com']]);
    for (const r of due) { await pg.overdue.markNotified(pool, r.id); sq.overdue.markNotified(tw.sqlite, r.id); }
    assert.deepEqual(await same('after marking', 'overdue', 'dueAssignments'), { ok: [] });
    const marks = 'SELECT id, last_overdue_notice FROM assignments ORDER BY id';
    assert.deepEqual((await pool.query(marks)).rows, tw.sqlite.prepare(marks).all());
    assert.equal((await pool.query('SELECT last_overdue_notice v FROM assignments WHERE id = $1', [due[0].id])).rows[0].v, today);
  });

  test('reservationViews: reservationById and listReservations (open / closed / all) for admin and employees, ordering, LIMIT 300', async () => {
    const r = (cols) => tw.reservation({ asset_id: w.pool.id, employee_id: w.ben.id, ...cols });
    w.r = {};
    w.r.pending = await r({ start_date: d(5), status: 'pending' });
    w.r.future = await r({ start_date: d(3), end_date: d(4), start_time: '09:00', end_time: '17:00' });
    w.r.now = await r({ start_date: d(-1), end_date: d(1), employee_id: w.emile.id, decided_by: w.anaAcc.id, requires_approval: 1, decided_at: '2026-01-01 00:00:00' });
    w.r.past = await r({ start_date: d(-6), end_date: d(-4) });
    w.r.cancelled = await r({ start_date: d(8), status: 'cancelled' });
    w.r.declined = await r({ start_date: d(9), status: 'declined', decided_by: w.robot.id });
    w.r.endsToday = await r({ start_date: today, end_time: '10:00' });
    const users = { admin: w.admin, ben: w.benUser, emile: w.emileUser, noPerson: w.noPerson };
    for (const [u, user] of Object.entries(users)) {
      for (const st of ['open', 'closed', undefined]) await same(`list ${st} as ${u}`, 'reservationViews', 'listReservations', user, st);
      for (const res of Object.values(w.r)) await same(`byId ${res.id} as ${u}`, 'reservationViews', 'reservationById', res.id, user);
    }
    const open = (await same('open admin', 'reservationViews', 'listReservations', w.admin, 'open')).ok;
    assert.deepEqual(open.map((x) => x.id), [w.r.pending.id, w.r.now.id, w.r.endsToday.id, w.r.future.id], 'pending first, then by start date');
    assert.equal(open[1].decided_by_name, 'Ana Admin');
    const benView = (await same('ben all', 'reservationViews', 'listReservations', w.benUser, undefined)).ok;
    assert.ok(benView.length && benView.every((x) => x.mine && x.employee_department === undefined && x.decided_by_name === undefined), 'own rows only, admin fields hidden');
    const closed = (await same('closed', 'reservationViews', 'listReservations', w.admin, 'closed')).ok;
    assert.deepEqual(closed.map((x) => x.id), [w.r.declined.id, w.r.cancelled.id, w.r.past.id], 'newest end date first');
    for (let i = 0; i < 300; i++) await r({ start_date: d(20), employee_id: w.emile.id });
    assert.equal((await same('limit', 'reservationViews', 'listReservations', w.admin, undefined)).ok.length, 300);
    await same('reservationOut on a row', 'reservationViews', 'reservationOut', { ...w.r.future, start_time: '', end_time: '' }, w.benUser);
  });

  test('requestAccess: loadRequest (404 and bad ids) and cancelBlock for admin, the requester and someone else, every rule', async () => {
    for (const id of [999999, 'x', '']) assert.deepEqual((await same(`load ${id}`, 'requestAccess', 'loadRequest', id)).error, { status: 404, message: 'Request not found' });
    const req = (cols) => tw.insert('requests', { type: 'equipment', status: 'open', user_id: w.ben.id, created_by: w.benAcc.id, ...cols });
    const resolved = { resolved_at: '2026-01-01 00:00:00', created_at: '2026-01-01 00:00:00' };
    const q = {};
    q.open = await req({ message: 'Ünïcode need' });
    q.opened = await req({ opened_at: '2026-01-01 00:00:00' });
    q.permApproved = await req({ asset_id: w.private.id, requested_assignment_type: 'permanent', status: 'approved', ...resolved });
    q.permDone = await req({ asset_id: w.repair.id, requested_assignment_type: 'permanent', status: 'completed', ...resolved });
    await tw.insert('assignments', { asset_id: w.repair.id, employee_id: w.ben.id, assignment_type: 'permanent', notes: `Request #${q.permDone.id}`, returned_at: '2026-01-02 00:00:00' });
    q.returnMine = await req({ type: 'return', asset_id: w.bensDesk.id });
    q.returnByIt = await req({ type: 'return', asset_id: w.poolOut.id, created_by: w.anaAcc.id });
    q.returnDropped = await req({ type: 'return', asset_id: w.archived.id, status: 'dropped_off' });
    q.issue = await req({ type: 'issue', asset_id: w.bensDesk.id });
    const users = { admin: w.admin, ben: w.benUser, emile: w.emileUser };
    for (const [k, row] of Object.entries(q)) {
      const loaded = await same(`load ${k}`, 'requestAccess', 'loadRequest', String(row.id));
      assert.equal(loaded.ok.id, row.id);
      for (const [u, user] of Object.entries(users)) {
        await tw.same(`cancelBlock ${k} as ${u}`, async (p) => pg.requestAccess.cancelBlock(p, await pg.requestAccess.loadRequest(p, row.id), user),
          (db) => sq.requestAccess.cancelBlock(db, sq.requestAccess.loadRequest(db, row.id), user));
      }
      await same(`isSelfInitiated ${k}`, 'requestAccess', 'isSelfInitiated', loaded.ok);
    }
    await same('self_initiated flag wins', 'requestAccess', 'cancelBlock', { ...q.returnByIt, self_initiated: 1 }, w.benUser);
    const block = async (k, user) => pg.requestAccess.cancelBlock(pool, await pg.requestAccess.loadRequest(pool, q[k].id), user);
    assert.equal(await block('open', w.benUser), null);
    assert.equal((await block('returnByIt', w.benUser)).status, 403);
    assert.equal((await block('permDone', w.admin)).status, 400, 'the assignment it produced blocks even IT');
  });
});
