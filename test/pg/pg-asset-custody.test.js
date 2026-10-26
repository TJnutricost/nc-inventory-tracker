// Slice 5C-5 (D-46, D-48): src/pg/assetCustody.js, differential against src/assetCustody.js, plus its transactions, locks and races.
// Twin worlds (test-support/pg-twin.js) hold the same rows with the same ids on both engines. The SQLite side of each call is what
// users get today: the route's own pre-reads / guard (getAsset + openAssignments + the target for check-in, heldAsset for request
// return / report issue, visibleAsset for the return notice), then the SQLite write, in one event-loop turn.
//   - checkin: one holder / one of several, condition / notes / location / maintenance / lost -> available, the return request it
//     completes, the waitlist hold it grants (masked clock values), and the refusals (nothing open, a stale target): same outcome and
//     the same tables, nothing written by a refusal.
//   - requestReturnFrom, requestMyReturn, reportIssue, returnNotice: the rows they create / move, their activity rows, every refusal.
//   - PostgreSQL only: one client per call, the asset lock first (spy); parallel check-outs of one asset; check-in vs check-out (both
//     orders); a double check-in; check-in vs the employee's "dropped off" (both orders); duplicate return / issue requests and
//     return notices; the employee's request-return / report-issue and IT's request vs a check-in; the 5A lock timeout (503
//     ASSET_BUSY, nothing written); the hold email only after COMMIT, never after a rollback.
// Skipped without PostgreSQL.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, syncSequences } = require('../../test-support/pg-twin');
const { result, overlap } = require('../../test-support/pg-auth-support');
const { blockAsset, spyPool, oneLine } = require('../../test-support/pg-write-support');
const fx = require('../../test-support/pg-fixtures');
const { withTransaction, setLockTimeout, BUSY_ASSET } = require('../../src/pg/transaction');
const effects = require('../../src/pg/effects');

const sq = require('../../src/assetCustody');
const pg = require('../../src/pg/assetCustody');
const sqAccess = require('../../src/assetAccess');
const sqViews = require('../../src/assetViews');
const pgAccess = require('../../src/pg/assetAccess');
const pgViews = require('../../src/pg/assetViews');
const pgAssignments = require('../../src/pg/assignments');
const pgRequests = require('../../src/pg/requests');

const T1 = '2026-01-01 00:00:00';
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const STAMPS = new Set(['created_at', 'updated_at', 'checked_out_at', 'returned_at', 'resolved_at', 'opened_at', 'closed_at', 'hold_started_at', 'hold_expires_at']);
const mask = (v) => {
  if (Array.isArray(v)) return v.map(mask);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => {
    if (STAMPS.has(k) && typeof x === 'string' && STAMP.test(x)) return [k, '<stamp>'];
    if (k === 'details' && typeof x === 'string') return [k, x.replace(/available until .+?(?= · |$)/g, 'available until <stamp>')];
    return [k, mask(x)];
  }));
};
const TABLES = ['assets', 'assignments', 'requests', 'activity', 'waitlist_entries'];
const NOT_OUT = 'This asset is not checked out';
const CHOOSE = 'Choose which person is returning it';
const NOT_YOURS = "This isn't checked out to you";

// The check-in route's pre-reads (getAsset, openAssignments, the target), on either engine.
async function preRead(getAsset, openAssignments, q, assetId, assignmentId) {
  const asset = await getAsset(q, assetId);
  if (!asset) throw Object.assign(new Error('Asset not found'), { status: 404 });
  const open = await openAssignments(q, asset.id);
  if (!open.length) throw Object.assign(new Error(NOT_OUT), { status: 400 });
  const target = assignmentId ? open.find((o) => o.id === Number(assignmentId)) : open.length === 1 ? open[0] : null;
  if (!target) throw Object.assign(new Error(CHOOSE), { status: 400 });
  return { asset, target };
}
const sqPreRead = (db, assetId, assignmentId) => preRead((d, id) => sqAccess.getAsset(d, id), (d, id) => sqViews.openAssignments(d, id), db, assetId, assignmentId);
const pgPreRead = (q, assetId, assignmentId) => preRead(pgAccess.getAsset, pgViews.openAssignments, q, assetId, assignmentId);

describe('PostgreSQL asset custody writes (differential against src/assetCustody.js)', pgSuite(), () => {
  let tdb; let tw; const w = {}; const u = {};
  async function sameTables(label) {
    const pgT = {}; const sqT = {};
    for (const t of TABLES) {
      pgT[t] = mask((await tw.pg.query(`SELECT * FROM ${t} ORDER BY id`)).rows);
      sqT[t] = mask(tw.sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    }
    assert.deepEqual(pgT, sqT, `${label}: the tables agree`);
    return pgT;
  }
  async function write(label, pgFn, sqFn) {
    await syncSequences(tw.pg, tw.sqlite);
    await syncSequences(tw.pg, tw.sqlite, ['requests']);
    const pgOut = mask(await result(() => pgFn(tw.pg)));
    const sqOut = mask(await result(() => sqFn(tw.sqlite)));
    assert.deepEqual(pgOut, sqOut, label);
    await sameTables(label);
    return pgOut;
  }
  async function refused(label, pgFn, sqFn, expected) {
    const before = await sameTables(`${label} (before)`);
    assert.deepEqual(await write(label, pgFn, sqFn), expected, label);
    assert.deepEqual(await sameTables(`${label} (after)`), before, `${label}: nothing written`);
  }
  // check-in through the route's pre-reads on SQLite; on PostgreSQL with the pre-read given (possibly stale)
  const checkinBoth = (label, assetId, opts = {}, { assignmentId, stale } = {}) => write(label,
    async (q) => pg.checkin(q, { ...(stale || await pgPreRead(q, assetId, assignmentId)), actorAccountId: w.itAcc.id, ...opts }),
    async (db) => sq.checkin(db, { ...(await sqPreRead(db, assetId, assignmentId)), actorAccountId: w.itAcc.id, ...opts }));
  const holderOf = async (q, getOpen, assetId, employeeId) => (await getOpen(q, assetId)).find((o) => o.employee_id === employeeId);

  before(async () => {
    tdb = await createTestDatabase();
    tw = await createTwin(tdb.pool);
    w.it = await tw.employee({ name: 'Ivy IT' });
    w.itAcc = await tw.insert('accounts', { employee_id: w.it.id, login_email: 'it@example.com', role: 'admin' });
    for (const n of ['ben', 'cara', 'dan', 'eve']) {
      w[n] = await tw.employee({ name: n[0].toUpperCase() + n.slice(1), work_email: `${n}@example.com` });
      w[`${n}Acc`] = await tw.insert('accounts', { employee_id: w[n].id, login_email: `${n}.login@example.com`, role: 'employee' });
      u[n] = { role: 'employee', employee_id: w[n].id, account_id: w[`${n}Acc`].id, name: w[n].name };
    }
    u.nobody = { role: 'employee', employee_id: null, account_id: w.itAcc.id, name: 'Nobody' };
    const held = async (cols, holders) => {
      const a = await tw.asset({ status: 'checked_out', ...cols });
      for (const h of holders) await tw.assignment({ asset_id: a.id, employee_id: h.id, checked_out_at: T1 });
      return a;
    };
    w.cam = await held({ tag: 'CAM-1', name: 'Camera', condition: 'Good' }, [w.ben]);
    w.lost = await held({ tag: 'LOST-1', name: 'Lost one', status: 'lost' }, [w.ben]);
    w.lic = await held({ tag: 'LIC-1', name: 'License', license_seats: 2 }, [w.ben, w.cara]);
    w.wait = await held({ tag: 'WAIT-1', name: 'Waited for', available_to_request: 1 }, [w.ben]);
    await tw.entry({ asset_id: w.wait.id, employee_id: w.dan.id, start_date: '2099-06-01', end_date: '2099-06-03', queue_seq: 1 });
    w.ret = await held({ tag: 'RET-1', name: 'Returnable', category: 'Laptops', available_to_request: 1 }, [w.ben]);
    w.ret2 = await held({ tag: 'RET-2', name: 'Second', category: 'Phones' }, [w.ben, w.cara]);
    w.shared = await tw.asset({ tag: 'SHR-1', name: 'Shared, not held', available_to_request: 1 });
    w.hidden = await tw.asset({ tag: 'HID-1', name: 'Hidden, not held' });
    w.free = await tw.asset({ tag: 'FREE-1', name: 'Nobody has it' });
    await sameTables('fixtures');
  });
  after(async () => { tw?.close(); await tdb?.drop(); });

  test('checkin: condition, notes, location; maintenance; lost -> available; one of several holders; the return request completed', async () => {
    await tw.insert('requests', { type: 'return', status: 'dropped_off', user_id: w.ben.id, asset_id: w.cam.id, created_by: w.benAcc.id, created_at: T1 });
    await checkinBoth('condition, notes, location', w.cam.id, { condition: 'Fair', notes: 'Scratched', location: 'Shelf 2', toMaintenance: undefined });
    await checkinBoth('lost comes back', w.lost.id, { condition: null, notes: null, location: null });
    const ben = (await pgViews.openAssignments(tw.pg, w.lic.id)).find((o) => o.employee_id === w.ben.id);
    await checkinBoth('one of two seats, to maintenance', w.lic.id, { condition: null, notes: null, location: null, toMaintenance: true }, { assignmentId: ben.id });
    const rows = (await tw.pg.query('SELECT tag, status, condition, location FROM assets WHERE id = ANY($1) ORDER BY id', [[w.cam.id, w.lost.id, w.lic.id]])).rows;
    assert.deepEqual(rows.map((r) => [r.tag, r.status, r.condition, r.location]), [['CAM-1', 'available', 'Fair', 'Shelf 2'], ['LOST-1', 'available', 'Good', null], ['LIC-1', 'maintenance', 'Good', null]]);
    assert.equal((await tw.pg.query('SELECT status FROM requests WHERE asset_id = $1', [w.cam.id])).rows[0].status, 'completed');
  });

  test('checkin offers the freed time to the waitlist in the same transaction (same rows, clock values masked)', async () => {
    await checkinBoth('a waiting entry gets its hold', w.wait.id, { condition: null, notes: null, location: null });
    assert.equal((await tw.pg.query('SELECT status FROM waitlist_entries WHERE asset_id = $1', [w.wait.id])).rows[0].status, 'held');
  });

  test('checkin refusals: nothing open, a target checked in meanwhile (stale pre-read): the route\'s 400s, nothing written', async () => {
    await refused('nothing open', (q) => pg.checkin(q, { asset: w.free, target: { id: 1 }, actorAccountId: w.itAcc.id }),
      (db) => sqPreRead(db, w.free.id), { error: { status: 400, message: NOT_OUT } });
    const cam = await tw.asset({ tag: 'CAM-9', name: 'Twice', status: 'checked_out' });
    const asg = await tw.assignment({ asset_id: cam.id, employee_id: w.eve.id });
    const stale = await pgPreRead(tw.pg, cam.id);
    await checkinBoth('the first check-in', cam.id, { condition: null, notes: 'first' });
    await refused('the same target again: refused, the first return is not overwritten', (q) => pg.checkin(q, { ...stale, actorAccountId: w.eve.id, notes: 'second' }),
      (db) => sqPreRead(db, cam.id), { error: { status: 400, message: NOT_OUT } });
    const lic = await tw.asset({ tag: 'LIC-9', name: 'Two seats', license_seats: 2, status: 'available' });
    const a1 = await tw.assignment({ asset_id: lic.id, employee_id: w.eve.id });
    await tw.assignment({ asset_id: lic.id, employee_id: w.dan.id });
    const staleSeat = await pgPreRead(tw.pg, lic.id, a1.id);
    await checkinBoth('the first seat', lic.id, {}, { assignmentId: a1.id });
    await refused('that seat again while another is open', (q) => pg.checkin(q, { ...staleSeat, actorAccountId: w.itAcc.id }),
      (db) => sqPreRead(db, lic.id, a1.id), { error: { status: 400, message: CHOOSE } });
    assert.equal((await tw.pg.query('SELECT return_notes FROM assignments WHERE id = $1', [asg.id])).rows[0].return_notes, 'first');
  });

  test('requestReturnFrom: the request + its activity row, null when one is live (IT or the employee asked first)', async () => {
    const both = (label, assetId, employeeId, extra) => write(label,
      async (q) => pg.requestReturnFrom(q, { asset: await pgAccess.getAsset(q, assetId), holder: await holderOf(q, pgViews.openAssignments, assetId, employeeId), actorAccountId: w.itAcc.id, ...extra }),
      async (db) => sq.requestReturnFrom(db, { asset: sqAccess.getAsset(db, assetId), holder: await holderOf(db, sqViews.openAssignments, assetId, employeeId), actorAccountId: w.itAcc.id, ...extra }));
    const made = await both('with a message and a date', w.ret2.id, w.ben.id, { message: 'Please', neededBy: '2099-01-01' });
    assert.deepEqual([made.ok.type, made.ok.status, made.ok.needed_by], ['return', 'open', '2099-01-01']);
    assert.deepEqual(await both('again: null', w.ret2.id, w.ben.id, { message: null, neededBy: null }), { ok: null });
    await both('the other holder, no date', w.ret2.id, w.cara.id, { message: null, neededBy: null });
    const acts = (await tw.pg.query("SELECT details FROM activity WHERE action = 'return_requested' AND asset_id = $1 ORDER BY id", [w.ret2.id])).rows.map((r) => r.details);
    assert.deepEqual(acts, ['From Ben · by 2099-01-01', 'From Cara']);
  });

  test('requestMyReturn / reportIssue: the new request as stored; duplicates and assets not held are refused (the route\'s guard); nothing written', async () => {
    const mine = (label, user, asset, message) => write(label, (q) => pg.requestMyReturn(q, user, asset, message),
      (db) => sq.requestMyReturn(db, user, sqAccess.heldAsset(db, user, asset.id), message));
    const issue = (label, user, asset, message) => write(label, (q) => pg.reportIssue(q, user, asset, message),
      (db) => sq.reportIssue(db, user, sqAccess.heldAsset(db, user, asset.id), message));
    const made = await mine('request return', u.ben, w.ret, 'Done with it');
    assert.deepEqual([made.ok.type, made.ok.status, made.ok.user_id, made.ok.created_by], ['return', 'open', w.ben.id, w.benAcc.id]);
    const again = (await mine('asked again', u.ben, w.ret, null)).error;
    assert.deepEqual(again, { status: 400, message: 'A return has already been requested for this item.' });
    await mine('IT asked first (ret2)', u.ben, w.ret2, null);
    await tw.pg.query("UPDATE requests SET status = 'dropped_off' WHERE asset_id = $1 AND user_id = $2", [w.ret.id, w.ben.id]);
    tw.sqlite.prepare("UPDATE requests SET status = 'dropped_off' WHERE asset_id = ? AND user_id = ?").run(w.ret.id, w.ben.id);
    assert.deepEqual((await mine('already dropped off', u.ben, w.ret, null)).error, { status: 400, message: "You've already told IT you dropped this off." });
    for (const [label, user, asset, expected] of [['shared, not held', u.ben, w.shared, { status: 400, message: NOT_YOURS }], ['hidden', u.ben, w.hidden, { status: 404, message: 'Asset not found' }], ['no employee record', u.nobody, w.shared, { status: 400, message: NOT_YOURS }]]) {
      await refused(`request return: ${label}`, (q) => pg.requestMyReturn(q, user, asset, null), (db) => sq.requestMyReturn(db, user, sqAccess.heldAsset(db, user, asset.id), null), { error: expected });
      await refused(`report issue: ${label}`, (q) => pg.reportIssue(q, user, asset, 'x'), (db) => sq.reportIssue(db, user, sqAccess.heldAsset(db, user, asset.id), 'x'), { error: expected });
    }
    const rep = await issue('report an issue', u.ben, w.ret, 'Screen flickers');
    assert.deepEqual([rep.ok.type, rep.ok.category, rep.ok.message], ['issue', 'Laptops', 'Screen flickers']);
    assert.deepEqual((await issue('the same issue again', u.ben, w.ret, 'Screen flickers')).error, { status: 400, message: "You've already reported this issue and it's still open." });
    await issue('a different issue', u.ben, w.ret, 'Fan noise');
    await issue('a long one (activity cut at 160)', u.cara, w.ret2, 'x'.repeat(200));
    assert.equal((await tw.pg.query("SELECT details FROM activity WHERE action = 'issue_reported' ORDER BY id DESC LIMIT 1")).rows[0].details, `${'x'.repeat(157)}…`);
  });

  test('returnNotice: not yours refused; a new dropped-off request, an open one moved to dropped off, a dropped-off one left as is', async () => {
    const notice = (label, user, asset, note) => write(label, (q) => pg.returnNotice(q, user, asset, note),
      (db) => sq.returnNotice(db, user, sqAccess.visibleAsset(db, user, asset.id), note));
    for (const [label, user] of [['not yours', u.dan], ['no employee record', u.nobody]]) {
      await refused(`return notice: ${label}`, (q) => pg.returnNotice(q, user, w.shared, null), (db) => sq.returnNotice(db, user, sqAccess.visibleAsset(db, user, w.shared.id), null), { error: { status: 400, message: NOT_YOURS } });
    }
    const fresh = await tw.asset({ tag: 'RN-1', name: 'Notice', status: 'checked_out' });
    await tw.assignment({ asset_id: fresh.id, employee_id: w.eve.id });
    await notice('no request yet: a dropped-off one (default text)', u.eve, fresh, null);
    await notice('dropped off already: only the activity row', u.eve, fresh, 'Left it at the desk');
    const asked = await tw.asset({ tag: 'RN-2', name: 'Asked', status: 'checked_out' });
    await tw.assignment({ asset_id: asked.id, employee_id: w.eve.id });
    await tw.insert('requests', { type: 'return', status: 'open', user_id: w.eve.id, asset_id: asked.id, created_by: w.itAcc.id, created_at: T1 });
    await notice('IT asked: moved to dropped off', u.eve, asked, 'On its way');
    const rows = (await tw.pg.query('SELECT asset_id, status, message FROM requests WHERE asset_id = ANY($1) ORDER BY id', [[fresh.id, asked.id]])).rows;
    assert.deepEqual(rows.map((r) => [r.asset_id, r.status, r.message]), [[fresh.id, 'dropped_off', 'Returned by user'], [asked.id, 'dropped_off', null]]);
  });
});

describe('PostgreSQL asset custody: statement order, lock timeout, races and the email after COMMIT', pgSuite(), () => {
  let tdb; let pool; let sampler; let admin; let admin2; let n = 0;
  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    sampler = tdb.newPool({ max: 2 });
    admin = await fx.insertAccount(pool, { role: 'admin' });
    admin2 = await fx.insertAccount(pool, { role: 'admin' });
  });
  after(async () => {
    setLockTimeout(null);
    effects.setNotifier(null);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    await tdb?.drop();
  });
  const person = async () => {
    const acc = await fx.insertAccount(pool);
    const e = (await pool.query('SELECT name FROM employees WHERE id = $1', [acc.employee_id])).rows[0];
    return { id: acc.employee_id, user: { role: 'employee', employee_id: acc.employee_id, account_id: acc.id, name: e.name }, name: e.name };
  };
  const asset = (cols = {}) => fx.insertAsset(pool, { tag: `CU-${++n}`, available_to_request: 1, ...cols });
  const give = async (a, p) => { await pgAssignments.createAssignment(pool, { assetId: a.id, employeeId: p.id, actorAccountId: admin.id, actorIsAdmin: true, type: 'permanent' }); };
  const checkout = (a, p) => (q) => pgAssignments.createAssignment(q, { assetId: a.id, employeeId: p.id, actorAccountId: admin.id, actorIsAdmin: true, type: 'permanent' });
  const checkin = (a, p, actor = admin) => async (q) => {
    const asset = await pgAccess.getAsset(pool, a.id);
    const target = (await pgViews.openAssignments(pool, a.id)).find((o) => o.employee_id === p.id);
    return pg.checkin(q, { asset, target, actorAccountId: actor.id, condition: null, notes: null, location: null });
  };
  const askFrom = (a, p) => async (q) => pg.requestReturnFrom(q, { asset: a, holder: { employee_id: p.id, user_name: p.name }, message: null, neededBy: null, actorAccountId: admin.id });
  const state = async (a) => ({
    open: (await pool.query('SELECT employee_id FROM assignments WHERE asset_id = $1 AND returned_at IS NULL ORDER BY id', [a.id])).rows.map((r) => r.employee_id),
    requests: (await pool.query('SELECT type, status FROM requests WHERE asset_id = $1 ORDER BY id', [a.id])).rows.map((r) => `${r.type}:${r.status}`),
    status: (await pool.query('SELECT status FROM assets WHERE id = $1', [a.id])).rows[0].status,
    activity: (await pool.query('SELECT action FROM activity WHERE asset_id = $1 ORDER BY id', [a.id])).rows.map((r) => r.action),
  });

  test('one client per call, the asset row lock first, the open assignments read after it', async () => {
    const p = await person(); const a = await asset(); await give(a, p);
    const run = async (fn) => {
      const spy = spyPool(pool);
      await fn(spy.pool);
      assert.deepEqual([...new Set(spy.calls.map((c) => c.client))], [1]);
      const sqls = spy.calls.map((c) => oneLine(c.sql));
      assert.deepEqual([sqls[0], sqls[1], sqls.at(-1)], ['BEGIN', 'SELECT * FROM assets WHERE id = $1 FOR UPDATE', 'COMMIT']);
      return sqls;
    };
    await run((q) => pg.reportIssue(q, p.user, a, 'Spy'));
    await run(askFrom(a, p));
    await run((q) => pg.returnNotice(q, p.user, a, null));
    const b = await asset(); await give(b, p);
    await run((q) => pg.requestMyReturn(q, p.user, b, null));
    const sqls = await run(checkin(a, p));
    const at = (re) => sqls.findIndex((s) => re.test(s));
    const order = [at(/^SELECT s\.\*, u\.name AS user_name/), at(/^UPDATE assignments SET returned_at/), at(/^SELECT id FROM requests WHERE type = 'return'.* FOR UPDATE$/), at(/^UPDATE requests SET/), at(/FROM waitlist_entries/)];
    assert.ok(order.every((i) => i > 1), sqls.join('\n'));
    assert.deepEqual(order, [...order].sort((x, y) => x - y), sqls.join('\n'));
  });

  test('parallel check-outs of one single-unit asset: exactly one wins, the others get SQLite\'s refusal', async () => {
    const a = await asset(); const people = [await person(), await person(), await person(), await person()];
    const outs = await Promise.all(people.map((p) => result(() => checkout(a, p)(pool))));
    const won = outs.filter((o) => 'ok' in o);
    assert.equal(won.length, 1);
    const winner = people[outs.findIndex((o) => 'ok' in o)];
    for (const o of outs.filter((x) => !('ok' in x))) assert.deepEqual(o, { error: { status: 400, message: `Already checked out to ${winner.name}. Check it in first.` } });
    assert.deepEqual((await state(a)).open, [winner.id]);
  });

  test('check-in vs check-out, both orders: the second waits for the asset lock, then sees the committed state', async () => {
    const p = await person(); const q2 = await person();
    const a = await asset(); await give(a, p);
    const one = await overlap(pool, sampler, checkin(a, p), checkout(a, q2));
    assert.deepEqual(['ok' in one.first, 'ok' in one.second, one.blocked], [true, true, true], JSON.stringify(one));
    assert.deepEqual(await state(a), { open: [q2.id], requests: [], status: 'checked_out', activity: ['checked_out', 'checked_out'] });
    const lic = await asset({ license_seats: 2 }); await give(lic, p);
    const two = await overlap(pool, sampler, checkout(lic, q2), checkin(lic, p));
    assert.deepEqual(['ok' in two.first, 'ok' in two.second, two.blocked], [true, true, true], JSON.stringify(two));
    assert.deepEqual((await state(lic)).open, [q2.id]);
    assert.equal((await state(lic)).status, 'available');
  });

  test('a double check-in of one assignment: the second is refused, the first return is kept (never overwritten)', async () => {
    const p = await person(); const p2 = await person();
    const a = await asset(); await give(a, p);
    const asg = (await pool.query('SELECT id FROM assignments WHERE asset_id = $1', [a.id])).rows[0].id;
    const one = await overlap(pool, sampler, checkin(a, p, admin), checkin(a, p, admin2));
    assert.deepEqual([one.second, one.blocked], [{ error: { status: 400, message: NOT_OUT } }, true]);
    assert.equal((await pool.query('SELECT returned_to FROM assignments WHERE id = $1', [asg])).rows[0].returned_to, admin.id);
    const lic = await asset({ license_seats: 2 }); await give(lic, p); await give(lic, p2);
    const two = await overlap(pool, sampler, checkin(lic, p, admin), checkin(lic, p, admin2));
    assert.deepEqual([two.second, two.blocked], [{ error: { status: 400, message: CHOOSE } }, true]);
    assert.deepEqual((await state(lic)).open, [p2.id]);
  });

  test('check-in vs the employee\'s "dropped off" of the return request, both orders: the check-in always completes it', async () => {
    const p = await person();
    const a = await asset(); await give(a, p);
    const r = await fx.insertRequest(pool, { type: 'return', user_id: p.id, asset_id: a.id, created_by: admin.id });
    const dropped = (q) => pgRequests.transition(q, r.id, 'dropped_off', { actorIsAdmin: false });
    const one = await overlap(pool, sampler, checkin(a, p), dropped);
    assert.ok('ok' in one.first && one.blocked && one.second.error.status === 400, JSON.stringify(one));
    assert.deepEqual((await state(a)).requests, ['return:completed']);
    const b = await asset(); await give(b, p);
    const r2 = await fx.insertRequest(pool, { type: 'return', user_id: p.id, asset_id: b.id, created_by: admin.id });
    const two = await overlap(pool, sampler, (q) => pgRequests.transition(q, r2.id, 'dropped_off', { actorIsAdmin: false }), checkin(b, p));
    assert.deepEqual(['ok' in two.first, two.second, two.blocked], [true, { ok: undefined }, true], 'the check-in waited on the request row, then completed it');
    assert.deepEqual(await state(b), { open: [], requests: ['return:completed'], status: 'available', activity: ['checked_out'] });
  });

  test('a return notice while IT cancels the open return request: the notice waits on the request row, then records a new dropped-off one', async () => {
    const p = await person();
    const a = await asset(); await give(a, p);
    const r = await fx.insertRequest(pool, { type: 'return', user_id: p.id, asset_id: a.id, created_by: admin.id });
    const cancel = (q) => pgRequests.transition(q, r.id, 'cancelled', { actorAccountId: admin.id, actorIsAdmin: true });
    const run = await overlap(pool, sampler, cancel, (q) => pg.returnNotice(q, p.user, a, 'Brought it back'));
    assert.deepEqual(['ok' in run.first, run.second, run.blocked], [true, { ok: undefined }, true], JSON.stringify(run));
    assert.deepEqual((await state(a)).requests, ['return:cancelled', 'return:dropped_off'], "SQLite's order: the cancel first, then the notice finds no live request");
  });

  test('duplicate return / issue requests and return notices at the same moment: one row, SQLite\'s answer for the second', async () => {
    const p = await person();
    const a = await asset(); await give(a, p);
    const it = await overlap(pool, sampler, askFrom(a, p), askFrom(a, p));
    assert.deepEqual([it.second, it.blocked], [{ ok: null }, true]);
    const b = await asset(); await give(b, p);
    const mine = await overlap(pool, sampler, (c) => pg.requestMyReturn(c, p.user, b, null), (q) => pg.requestMyReturn(q, p.user, b, null));
    assert.deepEqual([mine.second, mine.blocked], [{ error: { status: 400, message: 'A return has already been requested for this item.' } }, true]);
    const mixed = await overlap(pool, sampler, (c) => pg.requestMyReturn(c, p.user, a, null), askFrom(a, p));
    assert.deepEqual(mixed.first, { error: { status: 400, message: 'A return has already been requested for this item.' } }, '(IT asked already above)');
    const c2 = await asset(); await give(c2, p);
    const ask = await overlap(pool, sampler, askFrom(c2, p), (q) => pg.requestMyReturn(q, p.user, c2, null));
    assert.deepEqual([ask.second, ask.blocked], [{ error: { status: 400, message: 'A return has already been requested for this item.' } }, true]);
    const issue = await overlap(pool, sampler, (c) => pg.reportIssue(c, p.user, a, 'Broken'), (q) => pg.reportIssue(q, p.user, a, 'Broken'));
    assert.deepEqual([issue.second, issue.blocked], [{ error: { status: 400, message: "You've already reported this issue and it's still open." } }, true]);
    const d = await asset(); await give(d, p);
    const notice = await overlap(pool, sampler, (c) => pg.returnNotice(c, p.user, d, null), (q) => pg.returnNotice(q, p.user, d, null));
    assert.deepEqual([notice.second, notice.blocked], [{ ok: undefined }, true]);
    for (const x of [a, b, c2]) assert.equal((await state(x)).requests.filter((s) => s === 'return:open').length, 1, `one live return request on ${x.tag}`);
    assert.deepEqual((await state(a)).requests, ['return:open', 'issue:open']);
    assert.deepEqual((await state(d)).requests, ['return:dropped_off']);
    assert.deepEqual((await state(d)).activity, ['checked_out', 'dropped_off', 'dropped_off']);
  });

  test('the employee\'s request-return / report-issue and IT\'s request vs a check-in: refused / skipped after it, completed before it', async () => {
    const p = await person();
    const a = await asset(); await give(a, p);
    const one = await overlap(pool, sampler, checkin(a, p), (q) => pg.requestMyReturn(q, p.user, a, null));
    assert.deepEqual([one.second, one.blocked], [{ error: { status: 400, message: NOT_YOURS } }, true]);
    const b = await asset(); await give(b, p);
    const two = await overlap(pool, sampler, checkin(b, p), (q) => pg.reportIssue(q, p.user, b, 'Too late'));
    assert.deepEqual([two.second, two.blocked], [{ error: { status: 400, message: NOT_YOURS } }, true]);
    const c = await asset(); await give(c, p);
    const three = await overlap(pool, sampler, checkin(c, p), askFrom(c, p));
    assert.deepEqual([three.second, three.blocked], [{ ok: null }, true], 'the holder who returned it is skipped');
    for (const x of [a, b, c]) assert.deepEqual((await state(x)).requests, [], 'no request for an asset no longer held');
    const d = await asset(); await give(d, p);
    const four = await overlap(pool, sampler, (q) => pg.requestMyReturn(q, p.user, d, null), checkin(d, p));
    assert.deepEqual(['ok' in four.first, four.second, four.blocked], [true, { ok: undefined }, true]);
    assert.deepEqual((await state(d)).requests, ['return:completed']);
  });

  test('a busy asset: every custody write gives 503 ASSET_BUSY after the lock timeout and writes nothing', async () => {
    const p = await person();
    const a = await asset(); await give(a, p);
    const before = await state(a);
    const blocker = await blockAsset(pool, a.id);
    try {
      setLockTimeout(150);
      for (const fn of [checkin(a, p), askFrom(a, p), (q) => pg.requestMyReturn(q, p.user, a, null), (q) => pg.reportIssue(q, p.user, a, 'x'), (q) => pg.returnNotice(q, p.user, a, null)]) {
        assert.deepEqual(await result(() => fn(pool)), { error: { status: 503, message: BUSY_ASSET } });
      }
    } finally {
      setLockTimeout(null);
      await blocker.release();
    }
    assert.deepEqual(await state(a), before);
  });

  test('the hold a check-in grants is announced only after COMMIT, and never when the transaction rolls back', async () => {
    const seen = [];
    effects.setNotifier((e) => { seen.push(e); });
    try {
      const p = await person(); const waiter = await person();
      const hold = async () => {
        const a = await asset(); await give(a, p);
        await fx.insertWaitlistEntry(pool, { asset_id: a.id, employee_id: waiter.id, start_date: '2099-06-01', queue_seq: 1 });
        return a;
      };
      const a = await hold();
      await withTransaction(async (c) => {
        await checkin(a, p)(c);
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(seen, [], 'nothing before COMMIT');
      }, pool);
      await effects.whenIdle();
      assert.deepEqual(seen, [{ type: 'holds_owed', assetId: a.id }]);
      seen.length = 0;
      const b = await hold();
      await assert.rejects(withTransaction(async (c) => { await checkin(b, p)(c); throw new Error('a later step failed'); }, pool), /later step/);
      await effects.whenIdle();
      assert.deepEqual(seen, [], 'nothing after a rollback');
      assert.deepEqual([(await state(b)).open, (await pool.query('SELECT status FROM waitlist_entries WHERE asset_id = $1', [b.id])).rows[0].status], [[p.id], 'waiting']);
      const idle = await asset();
      assert.deepEqual(await result(() => pg.checkin(pool, { asset: idle, target: { id: 1 }, actorAccountId: admin.id })), { error: { status: 400, message: NOT_OUT } });
      await effects.whenIdle();
      assert.deepEqual(seen, [], 'nothing for a refused check-in');
    } finally {
      effects.setNotifier(null);
    }
  });
});
