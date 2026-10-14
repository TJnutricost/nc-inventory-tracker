// Hold-email safety and the Slice 4C additions to src/pg/effects.js (D-47 point 3; decisions D4C-2, D4C-3). The PostgreSQL side
// runs with the notifier Slice 5 will install (holds_owed -> waitlist.dispatchHoldEmails(pool), hold_email -> a recorder in
// place of the PG mailer). Proved here: (1) at-most-once: concurrent dispatchers and sweeps over the same live hold produce
// exactly one hold_email and set hold_email_at once, including the deterministic interleavings the claim's two guards exist for
// (`hold_email_at IS NULL`, `status = 'held'`); re-evaluation never re-sends; (2) a throwing or rejecting notifier is logged,
// leaves committed rows as they are, and the claim stays (no retry, no duplicate); (3) [rollback: test/pg/pg-waitlist-actions];
// (4) a refused request that moved the queue still yields exactly one hold email; (5) no email work under the asset lock: a
// notifier blocked on a test-controlled gate does not stop another transaction on the same asset or a FOR UPDATE NOWAIT;
// (6) no notifier -> nothing claimed, then claimed once a notifier is installed; (7) parity: the effects of join / updateDates /
// a hold, rendered through src/mailer.js exactly as Slice 5's PG mailer will, are the emails SQLite's waitlist sends for the
// same scenario on the twin (recipients, subjects, bodies; only the hold's "until" stamp is masked). Plus emit / hasNotifier /
// deferUntil. Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, installHoldMailNotifier, waitFor } = require('../../test-support/pg-write-support');
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
const reservations = require('../../src/pg/reservations');
const waitlist = require('../../src/pg/waitlist');

const HOURS6 = 6 * 3600;
const LAPSED = '2026-01-01 00:00:00';
const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const quietly = async (fn) => { const orig = console.error; const seen = []; console.error = (...a) => seen.push(a.join(' ')); try { await fn(); } finally { console.error = orig; } return seen; };

describe('PostgreSQL hold-email dispatch and effects (Slice 4C)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);
  const req = (cols = {}) => tw.asset({ available_to_request: 1, ...cols });

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
    w.anaAcct = await tw.insert('accounts', { login_email: 'ana.login@example.com', role: 'employee', employee_id: w.ana.id });
    await tw.insert('accounts', { login_email: 'dee.login@example.com', role: 'employee', employee_id: w.dee.id });
    w.fayAcct = await tw.insert('accounts', { login_email: 'fay.login@example.com', role: 'employee', employee_id: w.fay.id });
  });
  afterEach(async () => { await effects.whenIdle(); effects.setNotifier(null); });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    tw?.close();
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  const ana = () => ({ employeeId: w.ana.id, actorAccountId: w.anaAcct.id });
  const row = async (id) => (await pool.query('SELECT status, hold_email_at, hold_expires_at FROM waitlist_entries WHERE id = $1', [id])).rows[0];
  const emailsFor = (rec, id) => rec.holdEmails.filter((e) => e.id === id);
  // A live hold whose email has not gone out yet (a grant whose trigger was lost, say).
  async function unclaimed(label) {
    const a = await req({ name: `Mail ${label}` });
    const h = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), queue_seq: 1 });
    await tw.syncSequences();
    return { a, h };
  }
  // A live hold (already emailed) with Fay waiting behind it: Ana leaving / declining grants Fay a hold.
  async function behind(label) {
    const a = await req({ name: `Mail ${label}` });
    const h = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
    await tw.syncSequences();
    return { a, h, f };
  }

  // (first in the file: the twin's SQLite side runs a GLOBAL processDue / dispatch, so it must not inherit the PG-only scenarios below)
  test('(7) parity: the effects, rendered by src/mailer.js, are the emails SQLite sends (join, updateDates `updated`, hold)', async () => {
    const mailer = require('../../src/mailer');
    const outbox = () => require('../../src/db').db;
    const lastId = () => outbox().prepare('SELECT COALESCE(MAX(id), 0) m FROM outbox').get().m;
    const since = (id) => outbox().prepare('SELECT to_addr, subject, body FROM outbox WHERE id > ? ORDER BY id').all(id);
    // what Slice 5's PG mailer will do with each effect (recipient and asset resolved through the pool, after commit)
    const render = async (e) => {
      const asset = async (id) => reservations.loadAsset(pool, id);
      if (e.type === 'request_recorded') mailer.notify.requestRecorded(await reservations.emailOf(pool, e.employeeId), await asset(e.assetId), e);
      else if (e.type === 'waitlist_joined') mailer.notify.waitlistJoined(await reservations.emailOf(pool, e.reserver.employee_id), await reservations.emailOf(pool, e.waiterEmployeeId), await asset(e.assetId), e.entry, e.reserver, { updated: !!e.updated });
      else if (e.type === 'hold_email') mailer.notify.waitlistHold(await reservations.emailOf(pool, e.entry.employee_id), await asset(e.entry.asset_id), e.entry);
    };
    const untilOf = (stamp) => (stamp ? T.fmtStamp(stamp) : null);
    const masked = (rows, stamps) => rows.map((r) => {
      let { subject, body } = r;
      for (const s of stamps) if (s) { subject = subject.split(s).join('<until>'); body = body.split(s).join('<until>'); }
      return { to: r.to_addr, subject, body };
    });
    const scenario = async (label, assetId, pgFn, sqFn) => {
      await tw.syncSequences();
      const rec = installHoldMailNotifier(pool);
      const before = lastId();
      await pgFn(pool);
      await effects.whenIdle();
      rec.uninstall();
      const mine = rec.seen.filter((e) => (e.type === 'hold_email' ? e.entry.asset_id : e.assetId) === assetId);
      for (const e of mine) await render(e);
      const fromPg = since(before);
      const mid = lastId();
      sqFn(tw.sqlite);
      const fromSqlite = since(mid);
      const pgStamps = mine.filter((e) => e.type === 'hold_email').map((e) => untilOf(e.entry.hold_expires_at));
      const sqStamps = tw.sqlite.prepare("SELECT hold_expires_at FROM waitlist_entries WHERE asset_id = ? AND status = 'held'").all(assetId).map((r) => untilOf(r.hold_expires_at));
      assert.deepEqual(masked(fromPg, pgStamps), masked(fromSqlite, sqStamps), `${label}: the same emails`);
      return fromPg.length;
    };
    const a = await req({ name: 'Parity join', serial: 'SN-1' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(4), end_date: d(5) });
    await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(6) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(9) });
    const args = { assetId: a.id, ...ana(), start: d(4), end: d(6) };
    assert.equal(await scenario('join: two reservers + the confirmation', a.id, (q) => waitlist.join(q, args), (db) => sqliteWaitlist.join(db, args)), 3);
    const entryId = (await pool.query('SELECT id FROM waitlist_entries WHERE asset_id = $1', [a.id])).rows[0].id;
    const upd = { ...ana(), start: d(9), end: d(9) };
    assert.equal(await scenario('updateDates: Ben was told already; nobody newly reached', a.id, (q) => waitlist.updateDates(q, entryId, upd), (db) => sqliteWaitlist.updateDates(db, entryId, upd)), 0);
    const b = await req({ name: 'Parity updated' });
    await tw.reservation({ asset_id: b.id, employee_id: w.ben.id, start_date: d(4) });
    await tw.reservation({ asset_id: b.id, employee_id: w.dee.id, start_date: d(6) });
    await tw.reservation({ asset_id: b.id, employee_id: w.fay.id, start_date: d(7) });
    const eb = await tw.entry({ asset_id: b.id, employee_id: w.ana.id, start_date: d(4), queue_seq: 1 });
    const upd2 = { ...ana(), start: d(6), end: d(7) };
    assert.equal(await scenario('updateDates: each newly reached reserver gets the "changed their waitlist request" notice', b.id, (q) => waitlist.updateDates(q, eb.id, upd2), (db) => sqliteWaitlist.updateDates(db, eb.id, upd2)), 2);
    const c = await req({ name: 'Parity hold', reservation_requires_approval: 1, category: 'Cameras' });
    const hc = await tw.entry({ asset_id: c.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 1 });
    await tw.entry({ asset_id: c.id, employee_id: w.fay.id, start_date: d(5), start_time: '09:00', end_time: '12:00', queue_seq: 2 });
    await tw.entry({ asset_id: c.id, employee_id: w.dee.id, start_date: d(5), start_time: '13:00', end_time: '14:00', queue_seq: 3 });
    assert.equal(await scenario('a decline grants two holds: two hold emails', c.id, (q) => waitlist.declineHold(q, hc.id, ana()), (db) => sqliteWaitlist.declineHold(db, hc.id, ana())), 2);
  });

  test('emit / hasNotifier / deferUntil', async () => {
    assert.equal(effects.hasNotifier(), false);
    const got = [];
    effects.setNotifier((e) => { got.push(e); });
    assert.equal(effects.hasNotifier(), true);
    assert.equal(await effects.emit({ type: 'x', n: 1 }), true);
    assert.deepEqual(got, [{ type: 'x', n: 1 }]);
    const errs = [];
    effects.setNotifier(() => { throw new Error('down'); });
    assert.equal(await effects.emit({ type: 'y' }, (err) => errs.push(err.message)), false, 'never throws');
    assert.deepEqual(errs, ['down']);
    const logged = await quietly(async () => { assert.equal(await effects.emit({ nope: 1 }), false, 'a malformed effect is refused without throwing'); });
    assert.ok(logged.some((l) => l.startsWith('[effects]')));
    effects.setNotifier(null);
    assert.equal(effects.hasNotifier(), false);
    // deferUntil: a committed transaction's effects wait for the promise; a rolled-back one fires nothing; a rejection releases too
    effects.setNotifier((e) => { got.push(e); });
    got.length = 0;
    assert.throws(() => effects.deferUntil(pool, Promise.resolve()), /inside withTransaction/);
    const gate = deferred();
    await withTransaction(async (c) => { effects.deferUntil(c, gate.promise); effects.registerEffect(c, { type: 'later' }); }, pool);
    await withTransaction(async (c) => { effects.registerEffect(c, { type: 'now' }); }, pool);
    await waitFor(() => got.length === 1, 'the ungated effect');
    assert.deepEqual(got.map((e) => e.type), ['now'], 'the gated one waits');
    gate.resolve();
    await effects.whenIdle();
    assert.deepEqual(got.map((e) => e.type), ['now', 'later']);
    const gate2 = deferred();
    await assert.rejects(withTransaction(async (c) => { effects.deferUntil(c, gate2.promise); effects.registerEffect(c, { type: 'rolled back' }); throw new Error('no'); }, pool), /no/);
    const gate3 = deferred();
    await withTransaction(async (c) => { effects.registerEffect(c, { type: 'after a rejection' }); effects.deferUntil(c, gate3.promise); }, pool);
    gate3.reject(new Error('the request failed'));
    gate2.resolve();
    await effects.whenIdle();
    assert.deepEqual(got.map((e) => e.type), ['now', 'later', 'after a rejection']);
    await withTransaction(async (c) => { effects.registerEffect(c, { type: 'ungated again' }); }, pool); // a reused client carries no gate
    await effects.whenIdle();
    assert.equal(got.at(-1).type, 'ungated again');
  });

  test('(1) at-most-once: concurrent dispatchers + a sweep send exactly one email; re-evaluation never re-sends', async () => {
    const { a, h } = await unclaimed('at most once');
    const rec = installHoldMailNotifier(pool);
    const counts = await Promise.all([...Array(5)].map(() => waitlist.dispatchHoldEmails(pool)).concat([waitlist.sweep(pool).then(() => null)]));
    await effects.whenIdle();
    assert.equal(counts.filter((n) => n !== null).reduce((x, y) => x + y, 0) >= 1, true);
    assert.equal(emailsFor(rec, h.id).length, 1, 'exactly one hold_email');
    const first = (await row(h.id)).hold_email_at;
    assert.ok(first);
    assert.equal(emailsFor(rec, h.id)[0].hold_email_at, first, 'the email carries the claimed row');
    await waitlist.processDue(pool, a.id);
    await waitlist.sweep(pool);
    assert.equal(await waitlist.dispatchHoldEmails(pool), 0);
    await effects.whenIdle();
    assert.equal(emailsFor(rec, h.id).length, 1, 'never re-sent');
    assert.equal((await row(h.id)).hold_email_at, first, 'claimed once');
  });

  test('(1) the claim\'s guards: another dispatcher claiming first, or the hold closing, between the scan and the claim', async () => {
    const rec = installHoldMailNotifier(pool);
    // a dispatcher whose scan is followed by `between()` before its claims run
    const interleaved = (between) => ({
      query: async (text, params) => {
        const r = await pool.query(text, params);
        if (/^SELECT id FROM waitlist_entries WHERE status = 'held' AND hold_email_at IS NULL/.test(text)) await between();
        return r;
      },
    });
    const x = await unclaimed('claimed first');
    let other = null;
    const mine = await waitlist.dispatchHoldEmails(interleaved(async () => { other = await waitlist.dispatchHoldEmails(pool); }));
    await effects.whenIdle();
    assert.ok(other >= 1, 'the other dispatcher claimed it');
    assert.equal(emailsFor(rec, x.h.id).length, 1, 'exactly one email: the late claim found hold_email_at set');
    assert.ok(mine >= 0);
    const y = await unclaimed('closed first');
    await waitlist.dispatchHoldEmails(interleaved(async () => { await pool.query("UPDATE waitlist_entries SET status = 'fulfilled', closed_at = $1 WHERE id = $2", [FIXED, y.h.id]); }));
    await effects.whenIdle();
    assert.equal(emailsFor(rec, y.h.id).length, 0, 'a hold that is no longer held is not emailed');
    assert.equal((await row(y.h.id)).hold_email_at, null);
  });

  test('(2) a throwing or rejecting notifier: logged, committed rows unchanged, the claim stays (no retry, no duplicate)', async () => {
    for (const [label, bad] of [['throws', () => { throw new Error('smtp down'); }], ['rejects', async () => { throw new Error('smtp rejected'); }]]) {
      const { a, h, f } = await behind(`fails ${label}`);
      const sent = [];
      effects.setNotifier((e) => {
        if (e.type === 'holds_owed') return waitlist.dispatchHoldEmails(pool);
        if (e.type === 'hold_email') { if (e.entry.asset_id === a.id) sent.push(e.entry.id); return bad(); }
        return undefined;
      });
      let left;
      const logged = await quietly(async () => {
        left = await waitlist.leave(pool, h.id, { ...ana(), isAdmin: false });
        await effects.whenIdle();
      });
      assert.equal(left.status, 'left', `${label}: the caller got its result`);
      assert.deepEqual(sent, [f.id]);
      assert.ok(logged.some((l) => l.startsWith('[waitlist:mail]') && l.includes('smtp')), `${label}: logged\n${logged.join('\n')}`);
      const fr = await row(f.id);
      assert.equal(fr.status, 'held', `${label}: the hold stands`);
      assert.ok(fr.hold_email_at, `${label}: the claim was not undone`);
      assert.equal((await row(h.id)).status, 'left');
      await waitlist.sweep(pool);
      await effects.whenIdle();
      assert.deepEqual(sent, [f.id], `${label}: never retried by the next sweep`);
      assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM waitlist_entries WHERE asset_id = $1', [a.id])).rows[0].c), 2);
    }
  });

  test('(4) a refused request that moved the queue still yields exactly one hold email to the next person', async () => {
    const a = await req({ name: 'Mail refused' });
    const h = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), status: 'held', hold_expires_at: LAPSED, hold_email_at: FIXED, queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
    await tw.syncSequences();
    const rec = installHoldMailNotifier(pool);
    await assert.rejects(waitlist.confirmHold(pool, h.id, ana()), { status: 409 });
    await effects.whenIdle();
    assert.deepEqual(rec.holdEmails.filter((e) => e.asset_id === a.id).map((e) => e.id), [f.id]);
    // the refused confirm whose own failure path re-offers the free part: one email, for the new piece
    const b = await req({ name: 'Mail refused 2', status: 'checked_out' });
    await tw.checkout({ asset_id: b.id, employee_id: w.ben.id, due_date: d(5) });
    const h2 = await tw.entry({ asset_id: b.id, employee_id: w.ana.id, start_date: d(5), end_date: d(6), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 1 });
    await tw.syncSequences();
    await assert.rejects(waitlist.confirmHold(pool, h2.id, ana()), { status: 409 });
    await effects.whenIdle();
    const mails = rec.holdEmails.filter((e) => e.asset_id === b.id);
    assert.equal(mails.length, 1);
    assert.deepEqual([mails[0].employee_id, mails[0].start_date, mails[0].end_date], [w.ana.id, d(6), d(6)]);
  });

  test('(5) no email work under the asset lock: a blocked notifier does not stop another transaction on the asset or a NOWAIT lock', async () => {
    const { a, h, f } = await behind('slow');
    const g = await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(8), status: 'held', hold_expires_at: await tw.stamp(HOURS6), hold_email_at: FIXED, queue_seq: 3 });
    await tw.syncSequences();
    const gate = deferred(); const entered = deferred();
    const seenRow = [];
    const rec = installHoldMailNotifier(pool, {
      onHoldEmail: async (entry) => {
        seenRow.push(await row(entry.id)); // committed and visible to another connection
        entered.resolve();
        await gate.promise;
      },
    });
    await waitlist.declineHold(pool, h.id, ana());
    await entered.promise; // the hold email is now being "sent" and is stuck
    assert.equal((await pool.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [a.id])).rows.length, 1, 'nobody holds the asset lock');
    const left = await waitlist.leave(pool, g.id, { employeeId: w.ben.id, actorAccountId: null, isAdmin: false });
    assert.equal(left.status, 'left', 'a second transaction on the same asset completed');
    assert.equal(await withTransaction(async (c) => { await lockAsset(c, a.id); return 'locked'; }, pool), 'locked');
    assert.deepEqual(rec.holdEmails.filter((e) => e.asset_id === a.id).map((e) => e.id), [f.id]);
    assert.deepEqual([seenRow[0].status, !!seenRow[0].hold_email_at], ['held', true]);
    gate.resolve();
    await effects.whenIdle();
  });

  test('(6) no notifier installed: nothing is claimed; once one is installed the hold is claimed and emailed once', async () => {
    const { a, h, f } = await behind('no notifier');
    effects.setNotifier(null);
    await waitlist.leave(pool, h.id, { ...ana(), isAdmin: false });
    await effects.whenIdle();
    assert.equal((await row(f.id)).status, 'held');
    assert.equal(await waitlist.dispatchHoldEmails(pool), 0);
    await waitlist.sweep(pool);
    assert.equal((await row(f.id)).hold_email_at, null, 'the claim was not burned');
    const rec = installHoldMailNotifier(pool);
    await waitlist.sweep(pool);
    await waitlist.sweep(pool);
    await effects.whenIdle();
    assert.deepEqual(rec.holdEmails.filter((e) => e.asset_id === a.id).map((e) => e.id), [f.id], 'claimed once');
    assert.ok((await row(f.id)).hold_email_at);
  });

});
