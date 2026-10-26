// The effects notifier (Slice 5A, D-48 point 5; D-47 point 3, D4C-3): src/pg/notifier.js turns the after-commit effects of the
// PostgreSQL write paths into email through the PostgreSQL mailer (src/pg/mailer.js). Proved here, with the notifier INSTALLED
// (installNotifier(pool, createPgMailer(pool)), what Slice 5D will do at boot):
//   - parity: each effect type (request_recorded, waitlist_joined incl. `updated`, hold_email via holds_owed) produces in the
//     PostgreSQL `outbox` exactly the emails SQLite's flow writes to its outbox for the same scenario on the twin (recipient,
//     subject, body; only the hold's "until" stamp is masked; the 4C parity fixtures, now through the PG mailer);
//   - an email failure (a throwing transport, a throwing mailer) leaves committed rows untouched and is never retried;
//   - no email on rollback; no SMTP while an asset lock is held (a gated slow transport: a second transaction on the same asset
//     and FOR UPDATE NOWAIT succeed meanwhile);
//   - at most once: N concurrent dispatchers + a sweep with the notifier installed give ONE email and set hold_email_at once,
//     also with a throwing mailer; no holds_owed / hold_email loop (hold_email never dispatches, holds_owed only dispatches);
//   - unknown effects are logged and ignored; no address -> no email; uninstall restores the no-notifier behavior (nothing claimed).
// No real email: NC_NO_EXTERNAL_MAIL=1, outbox rows are 'logged' or go to fake transports. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, waitFor, spyPool } = require('../../test-support/pg-write-support');
const sqliteMail = prepareSqliteMail();

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { createTwin, FIXED } = require('../../test-support/pg-twin');
const T = require('../../src/timeRange');
const pgTime = require('../../src/pg/time');
const { withTransaction, lockAsset } = require('../../src/pg/transaction');
const effects = require('../../src/pg/effects');
const sqliteWaitlist = require('../../src/waitlist');
const sqliteReservations = require('../../src/reservations');
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');
const { createPgMailer } = require('../../src/pg/mailer');
const { createNotifier, installNotifier } = require('../../src/pg/notifier');

const HOURS6 = 6 * 3600;
const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); try { await fn(); } finally { console.error = orig; } return seen; };

describe('PostgreSQL effects notifier through the PG mailer (Slice 5A)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w; let mailer;
  const d = (n) => T.addDays(today, n);
  const req = (cols = {}) => tw.asset({ available_to_request: 1, ...cols });
  let uninstall = null;
  const install = (m = mailer) => { uninstall = installNotifier(pool, m); return uninstall; };

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Asker', department: 'Ops', work_email: 'ana@example.com' });
    w.ben = await tw.employee({ name: 'Ben Booker', work_email: 'ben@example.com' });
    w.dee = await tw.employee({ name: 'Dee Third' }); // reached through her login
    w.fay = await tw.employee({ name: 'Fay Fourth', department: 'Lab', work_email: 'fay@example.com' });
    w.zed = await tw.employee({ name: 'Zed NoMail' }); // no work email, no login: no address at all
    w.anaAcct = await tw.insert('accounts', { login_email: 'ana.login@example.com', role: 'employee', employee_id: w.ana.id });
    await tw.insert('accounts', { login_email: 'dee.login@example.com', role: 'employee', employee_id: w.dee.id });
    w.fayAcct = await tw.insert('accounts', { login_email: 'fay.login@example.com', role: 'employee', employee_id: w.fay.id });
    mailer = createPgMailer(pool);
    assert.equal(mailer.mailConfigured(), false, 'NC_NO_EXTERNAL_MAIL: no transport from the environment');
  });
  afterEach(async () => {
    await effects.whenIdle();
    if (uninstall) uninstall();
    uninstall = null;
    effects.setNotifier(null);
  });
  after(async () => {
    try {
      await effects.whenIdle();
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    } finally {
      tw?.close();
      await tdb?.drop();
      sqliteMail.cleanup();
    }
  });

  const ana = () => ({ employeeId: w.ana.id, actorAccountId: w.anaAcct.id });
  const row = async (id) => (await pool.query('SELECT status, hold_email_at, hold_expires_at FROM waitlist_entries WHERE id = $1', [id])).rows[0];
  // PostgreSQL outbox rows about one asset (its tag is in every subject these flows send)
  const mailFor = async (a) => (await pool.query("SELECT to_addr, subject, status, error, delivered_to FROM outbox WHERE subject LIKE '%(' || $1 || ')%' ORDER BY id", [a.tag])).rows;
  // A live hold (already emailed) with Fay waiting behind it: Ana leaving / declining grants Fay a hold.
  async function behind(label, cols = {}) {
    const a = await req({ name: `Notify ${label}` });
    const h = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2, ...cols });
    await tw.syncSequences();
    return { a, h, f };
  }
  async function unclaimed(label, employeeId = w.ana.id) {
    const a = await req({ name: `Notify ${label}` });
    const h = await tw.entry({ asset_id: a.id, employee_id: employeeId, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), queue_seq: 1 });
    await tw.syncSequences();
    return { a, h };
  }

  // (first in the file: the twin's SQLite side runs a GLOBAL processDue / dispatch, so it must not inherit the PG-only scenarios below)
  test('parity: each effect type, through the installed notifier and the PG mailer, writes the emails SQLite writes (request_recorded, waitlist_joined, updated, hold_email)', async () => {
    const sqdb = () => require('../../src/db').db;
    const sqLast = () => sqdb().prepare('SELECT COALESCE(MAX(id), 0) m FROM outbox').get().m;
    const sqSince = (id) => sqdb().prepare('SELECT to_addr, subject, body, status, error, delivered_to FROM outbox WHERE id > ? ORDER BY id').all(id);
    const pgLast = async () => Number((await pool.query('SELECT COALESCE(MAX(id), 0) m FROM outbox')).rows[0].m);
    const pgSince = async (id) => (await pool.query('SELECT to_addr, subject, body, status, error, delivered_to FROM outbox WHERE id > $1 ORDER BY id', [id])).rows;
    const masked = (rows, stamps) => rows.map((r) => {
      let { subject, body } = r;
      for (const s of stamps) { subject = subject.split(s).join('<until>'); body = body.split(s).join('<until>'); }
      return { ...r, subject, body };
    });
    const stampsOf = (rows) => rows.map((r) => T.fmtStamp(r.hold_expires_at));
    const scenario = async (label, assetId, pgFn, sqFn) => {
      await tw.syncSequences();
      install();
      const pgBefore = await pgLast();
      await pgFn(pool);
      await effects.whenIdle();
      uninstall(); uninstall = null;
      const fromPg = await pgSince(pgBefore);
      const pgStamps = stampsOf((await pool.query("SELECT hold_expires_at FROM waitlist_entries WHERE asset_id = $1 AND status = 'held'", [assetId])).rows);
      const mid = sqLast();
      sqFn(tw.sqlite);
      const fromSq = sqSince(mid);
      const sqStamps = stampsOf(tw.sqlite.prepare("SELECT hold_expires_at FROM waitlist_entries WHERE asset_id = ? AND status = 'held'").all(assetId));
      assert.deepEqual(masked(fromPg, pgStamps), masked(fromSq, sqStamps), `${label}: the same emails`);
      assert.ok(fromPg.every((r) => r.status === 'logged' && r.delivered_to === null), `${label}: recorded, nothing sent`);
      return fromPg.length;
    };
    // request_recorded: a plain reservation, confirmed and pending IT approval
    const r1 = await req({ name: 'Parity reserve', serial: 'SN-9', category: 'Cameras' });
    const res1 = { assetId: r1.id, ...ana(), start: d(3), end: d(4) };
    assert.equal(await scenario('create: confirmed', r1.id, (q) => reservations.create(q, res1), (db) => sqliteReservations.create(db, res1)), 1);
    const r2 = await req({ name: 'Parity approval', reservation_requires_approval: 1 });
    const res2 = { assetId: r2.id, employeeId: w.dee.id, actorAccountId: null, start: d(3), end: d(3), startTime: '09:00', endTime: '11:00' };
    assert.equal(await scenario('create: pending, Dee through her login', r2.id, (q) => reservations.create(q, res2), (db) => sqliteReservations.create(db, res2)), 1);
    // waitlist_joined (one per reserver) + request_recorded (the confirmation)
    const a = await req({ name: 'Parity join', serial: 'SN-1' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(4), end_date: d(5) });
    await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(6) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(9) });
    const args = { assetId: a.id, ...ana(), start: d(4), end: d(6) };
    assert.equal(await scenario('join: two reservers + the confirmation', a.id, (q) => waitlist.join(q, args), (db) => sqliteWaitlist.join(db, args)), 3);
    // waitlist_joined `updated`
    const b = await req({ name: 'Parity updated' });
    await tw.reservation({ asset_id: b.id, employee_id: w.ben.id, start_date: d(4) });
    await tw.reservation({ asset_id: b.id, employee_id: w.dee.id, start_date: d(6) });
    await tw.reservation({ asset_id: b.id, employee_id: w.fay.id, start_date: d(7) });
    const eb = await tw.entry({ asset_id: b.id, employee_id: w.ana.id, start_date: d(4), queue_seq: 1 });
    const upd = { ...ana(), start: d(6), end: d(7) };
    assert.equal(await scenario('updateDates: the "changed their waitlist request" notices', b.id, (q) => waitlist.updateDates(q, eb.id, upd), (db) => sqliteWaitlist.updateDates(db, eb.id, upd)), 2);
    // holds_owed -> dispatchHoldEmails -> hold_email -> waitlistHold (approval wording, a timed range)
    const c = await req({ name: 'Parity hold', reservation_requires_approval: 1, category: 'Cameras' });
    const hc = await tw.entry({ asset_id: c.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 1 });
    await tw.entry({ asset_id: c.id, employee_id: w.fay.id, start_date: d(5), start_time: '09:00', end_time: '12:00', queue_seq: 2 });
    await tw.entry({ asset_id: c.id, employee_id: w.dee.id, start_date: d(5), start_time: '13:00', end_time: '14:00', queue_seq: 3 });
    assert.equal(await scenario('a decline grants two holds: two hold emails', c.id, (q) => waitlist.declineHold(q, hc.id, ana()), (db) => sqliteWaitlist.declineHold(db, hc.id, ana())), 2);
  });

  test('createNotifier maps each effect type; hold_email never dispatches, holds_owed only dispatches (no loop); unknown types are logged and ignored', async () => {
    const calls = [];
    const fake = { notify: new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); } }) };
    const spy = spyPool(pool);
    const notifier = createNotifier(spy.pool, fake);
    const a = await req({ name: 'Notify map', tag: 'NM-1' });
    const entry = { id: 1, asset_id: a.id, employee_id: w.fay.id, start_date: d(5), end_date: d(5), hold_expires_at: FIXED };
    await notifier({ type: 'hold_email', entry });
    assert.deepEqual(calls.map((x) => x[0]), ['waitlistHold']);
    assert.deepEqual(calls[0].slice(1), [{ name: 'Fay Fourth', email: 'fay@example.com', department: 'Lab' }, await reservations.loadAsset(pool, a.id), entry]);
    assert.ok(!spy.log.some((s) => /hold_email_at/.test(s)), 'hold_email claims nothing and dispatches nothing');
    calls.length = 0; spy.log.length = 0;
    await notifier({ type: 'waitlist_joined', waiterEmployeeId: w.ana.id, assetId: a.id, entry, reserver: { employee_id: w.ben.id, start_date: d(5) }, updated: true });
    assert.deepEqual(calls.map((x) => [x[0], x[1].email, x[2].email, x.at(-1)]), [['waitlistJoined', 'ben@example.com', 'ana@example.com', { updated: true }]]);
    await notifier({ type: 'waitlist_joined', waiterEmployeeId: w.ana.id, assetId: a.id, entry, reserver: { employee_id: w.ben.id } });
    assert.deepEqual(calls.at(-1).at(-1), { updated: false });
    calls.length = 0;
    await notifier({ type: 'request_recorded', employeeId: w.dee.id, assetId: a.id, requested: { start_date: d(1) }, reserved: [], waitlisted: [{ start_date: d(1) }] });
    assert.deepEqual(calls.map((x) => [x[0], x[1].email, x[3]]), [['requestRecorded', 'dee.login@example.com', { requested: { start_date: d(1) }, reserved: [], waitlisted: [{ start_date: d(1) }] }]]);
    // unknown
    calls.length = 0;
    const logged = await quietly(async () => { assert.equal(await notifier({ type: 'no_such_effect' }), undefined); });
    assert.ok(logged.some((l) => l.startsWith('[notifier]') && l.includes('no_such_effect')), logged.join('\n'));
    assert.deepEqual(calls, []);
    // holds_owed: only the claim-based dispatch, never a direct send. Not installed: dispatchHoldEmails claims nothing.
    const { h } = await unclaimed('map owed');
    assert.equal(await notifier({ type: 'holds_owed', assetId: h.asset_id }), 0, 'no notifier installed: nothing claimed');
    assert.deepEqual(calls, [], 'holds_owed never sends directly');
    assert.equal((await row(h.id)).hold_email_at, null);
    // installed: holds_owed runs the claim (one UPDATE ... hold_email_at), and the email comes back as ONE hold_email effect
    effects.setNotifier(notifier);
    spy.log.length = 0;
    assert.equal(await notifier({ type: 'holds_owed', assetId: h.asset_id }), 1, 'claimed once');
    assert.deepEqual(calls, [], 'nothing sent directly by holds_owed itself');
    await effects.whenIdle();
    assert.ok(spy.log.some((s) => /^UPDATE waitlist_entries SET hold_email_at/.test(s)), 'it ran the claim-based dispatch');
    assert.deepEqual(calls.map((x) => [x[0], x[3].id]), [['waitlistHold', h.id]], 'one email, through hold_email');
    assert.equal(await notifier({ type: 'holds_owed', assetId: h.asset_id }), 0, 'a repeated trigger claims nothing');
    await effects.whenIdle();
    assert.equal(calls.length, 1);
  });

  test('a hold produces exactly one email and hold_email_at is set once: the request\'s trigger, then sweeps and dispatchers (no loop, no duplicate)', async () => {
    const { a, h, f } = await behind('once');
    install();
    await waitlist.declineHold(pool, h.id, ana());
    await effects.whenIdle();
    const first = (await row(f.id)).hold_email_at;
    assert.ok(first, 'claimed');
    assert.deepEqual((await mailFor(a)).map((r) => [r.to_addr, r.status]), [['fay@example.com', 'logged']]);
    assert.match((await mailFor(a))[0].subject, /^Available for you until /);
    await waitlist.sweep(pool);
    await Promise.all([waitlist.dispatchHoldEmails(pool), waitlist.dispatchHoldEmails(pool), waitlist.processDue(pool, a.id)]);
    await effects.whenIdle();
    assert.equal((await mailFor(a)).length, 1, 'never re-sent');
    assert.equal((await row(f.id)).hold_email_at, first, 'claimed once');
  });

  test('at most once under N concurrent dispatchers + a sweep with the notifier installed, also with a throwing mailer', async () => {
    const { a, h } = await unclaimed('concurrent');
    install();
    await Promise.all([...Array(6)].map(() => waitlist.dispatchHoldEmails(pool)).concat([waitlist.sweep(pool)]));
    await effects.whenIdle();
    assert.deepEqual((await mailFor(a)).map((r) => r.to_addr), ['ana@example.com'], 'exactly one email');
    assert.ok((await row(h.id)).hold_email_at);
    uninstall(); uninstall = null;
    // a mailer that throws: one attempt, logged, the claim stays, never retried
    const attempts = [];
    const throwing = { notify: { waitlistHold: (u, asset, entry) => { attempts.push(entry.id); throw new Error('mailer exploded'); } } };
    const x = await unclaimed('throwing mailer');
    install(throwing);
    const logged = await quietly(async () => {
      await Promise.all([...Array(6)].map(() => waitlist.dispatchHoldEmails(pool)).concat([waitlist.sweep(pool)]));
      await effects.whenIdle();
      await waitlist.sweep(pool);
      await effects.whenIdle();
    });
    assert.deepEqual(attempts, [x.h.id], 'one attempt, never retried');
    assert.ok(logged.some((l) => l.startsWith('[waitlist:mail]') && l.includes('mailer exploded')), logged.join('\n'));
    const xr = await row(x.h.id);
    assert.deepEqual([xr.status, !!xr.hold_email_at], ['held', true], 'the hold and its claim stand');
    assert.deepEqual(await mailFor(x.a), []);
  });

  test('an email failure leaves committed rows untouched: a throwing transport records `failed`, nothing is retried', async () => {
    const failing = createPgMailer(pool);
    failing.setTransportForTests({ sendMail: async () => { throw new Error('421 try later'); } });
    const { a, h, f } = await behind('transport fails');
    install(failing);
    let left;
    const logged = await quietly(async () => {
      left = await waitlist.leave(pool, h.id, { ...ana(), isAdmin: false });
      await effects.whenIdle();
    });
    assert.equal(left.status, 'left', 'the caller got its result');
    assert.ok(logged.some((l) => l.startsWith('[mail:error]') && l.includes('421')), logged.join('\n'));
    assert.deepEqual(await mailFor(a), [{ to_addr: 'fay@example.com', subject: (await mailFor(a))[0].subject, status: 'failed', error: '421 try later', delivered_to: null }]);
    const fr = await row(f.id);
    assert.deepEqual([fr.status, !!fr.hold_email_at, (await row(h.id)).status], ['held', true, 'left'], 'committed state stands');
    await quietly(async () => { await waitlist.sweep(pool); await effects.whenIdle(); });
    assert.equal((await mailFor(a)).length, 1, 'never retried');
  });

  test('no email on rollback; the same work committed emails once', async () => {
    const { a, h, f } = await behind('rollback');
    install();
    await assert.rejects(withTransaction(async (c) => {
      await waitlist.declineHold(c, h.id, ana());
      throw new Error('caller failed afterwards');
    }, pool), /caller failed/);
    await effects.whenIdle();
    assert.deepEqual(await mailFor(a), [], 'nothing sent');
    assert.deepEqual([(await row(h.id)).status, (await row(f.id)).status, (await row(f.id)).hold_email_at], ['held', 'waiting', null], 'nothing committed, nothing claimed');
    await withTransaction((c) => waitlist.declineHold(c, h.id, ana()), pool);
    await effects.whenIdle();
    assert.deepEqual((await mailFor(a)).map((r) => r.to_addr), ['fay@example.com']);
    assert.deepEqual([(await row(h.id)).status, (await row(f.id)).status], ['declined', 'held']);
  });

  test('no SMTP while an asset lock is held: a gated slow transport does not stop another transaction on the asset or a NOWAIT lock', async () => {
    const slow = createPgMailer(pool);
    const gate = deferred(); const entered = deferred();
    const delivered = [];
    slow.setTransportForTests({
      sendMail: async (m) => {
        // the hold is committed and visible to another connection while the message is "in flight"
        delivered.push({ to: m.to, row: await row(holdId()) });
        entered.resolve();
        await gate.promise;
      },
    });
    const { a, h, f } = await behind('slow smtp');
    const holdId = () => f.id;
    const g = await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(8), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 3 });
    await tw.syncSequences();
    install(slow);
    try {
      await waitlist.declineHold(pool, h.id, ana());
      await entered.promise; // the SMTP send is now stuck
      assert.equal((await pool.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [a.id])).rows.length, 1, 'nobody holds the asset lock');
      const left = await waitlist.leave(pool, g.id, { employeeId: w.ben.id, actorAccountId: null, isAdmin: false });
      assert.equal(left.status, 'left', 'a second transaction on the same asset completed');
      assert.equal(await withTransaction(async (c) => { await lockAsset(c, a.id); return 'locked'; }, pool), 'locked');
      assert.deepEqual(delivered.map((x) => [x.to, x.row.status, !!x.row.hold_email_at]), [['fay@example.com', 'held', true]]);
    } finally {
      gate.resolve(); // (also when an assertion failed: never leave the send stuck)
    }
    await effects.whenIdle();
    assert.deepEqual((await mailFor(a)).map((r) => [r.to_addr, r.status]), [['fay@example.com', 'sent']]);
  });

  test('a person with no email address gets nothing (as SQLite\'s send skips them); the hold stands', async () => {
    const { a, h, f } = await behind('no address');
    await pool.query('UPDATE waitlist_entries SET employee_id = $1 WHERE id = $2', [w.zed.id, f.id]);
    install();
    await waitlist.declineHold(pool, h.id, ana());
    await effects.whenIdle();
    assert.deepEqual(await mailFor(a), []);
    assert.equal((await row(f.id)).status, 'held');
  });

  test('uninstall restores the no-notifier behavior: nothing is claimed, nothing is mailed; reinstalled, the hold is mailed once', async () => {
    const un = install();
    assert.equal(effects.hasNotifier(), true);
    un(); uninstall = null;
    assert.equal(effects.hasNotifier(), false);
    const { a, h, f } = await behind('uninstalled');
    await waitlist.leave(pool, h.id, { ...ana(), isAdmin: false });
    await effects.whenIdle();
    await waitlist.sweep(pool);
    assert.equal(await waitlist.dispatchHoldEmails(pool), 0);
    assert.deepEqual([(await row(f.id)).status, (await row(f.id)).hold_email_at], ['held', null], 'the claim was not burned');
    assert.deepEqual(await mailFor(a), []);
    install();
    await waitlist.sweep(pool);
    await waitFor(async () => (await mailFor(a)).length === 1, 'the hold email');
    await effects.whenIdle();
    assert.deepEqual((await mailFor(a)).map((r) => r.to_addr), ['fay@example.com']);
  });
});
