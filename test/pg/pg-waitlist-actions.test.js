// src/pg/waitlist.js actions (D-46, D-47, Slice 4C): join, updateDates, confirmHold, declineHold, leave and the per-asset due
// step, run on twin worlds (pg-twin, same ids; sequences synced so module-written rows get the same ids) through BOTH the SQLite
// module (src/waitlist.js) and its src/pg twin. The outcome (value or {status, message}), the asset's whole resulting state
// (reservations, waitlist entries, activity, assignments, asset status) and every entry as the screens present it (4A get(), for
// IT and for the entry's owner: phase, position, buttons) must be deep-equal after masking only what the two clocks / generators
// legitimately differ in (stamps, request_group UUIDs, queue_seq -> rank within the asset). The PostgreSQL side runs with the
// Slice 5 notifier mapping (holds_owed -> dispatchHoldEmails, hold_email recorded), so a hold it grants is claimed
// (hold_email_at) exactly as SQLite's dispatch claims it. Plus PG-only checks: per-asset queue_seq, the effects each action
// registers, request-path asset scoping, the gap between the committed due step and the main transaction (decision D4C-1, via the
// module's test seam), response tiers through processDue, and rollback at the last write. Fixture holds carry hold_email_at so
// SQLite's global dispatch has nothing extra to claim. Deterministic: dates are days ahead of the database's today, holds +/- 6
// hours from the database clock, APP_TIMEZONE=UTC; the tier test skips (with a message) within 15 minutes of UTC midnight.
// Skipped without PostgreSQL.
process.env.APP_TIMEZONE = 'UTC';
const { prepareSqliteMail, mask, groupNamer, dumpAsset, outcome, installHoldMailNotifier } = require('../../test-support/pg-write-support');
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
const waitlist = require('../../src/pg/waitlist');

const HOURS6 = 6 * 3600;
const ADMIN = { role: 'admin', employee_id: null };
const STAMP_SECONDS = (s) => Date.parse(`${s.replace(' ', 'T')}Z`) / 1000;
const LAPSED = '2026-01-01 00:00:00'; // a hold that ran out long ago (before any test date)

describe('PostgreSQL waitlist actions (differential against src/waitlist.js)', pgSuite(), () => {
  let tdb; let pool; let tw; let today; let w;
  const d = (n) => T.addDays(today, n);

  before(async () => {
    tdb = await createTestDatabase();
    pool = tdb.pool;
    tw = await createTwin(pool);
    today = await pgTime.today(pool);
    w = {};
    w.ana = await tw.employee({ name: 'Ana Asker', department: 'Ops', work_email: 'ana@example.com' });
    w.ben = await tw.employee({ name: 'Ben Booker', work_email: 'ben@example.com' });
    w.cy = await tw.employee({ name: 'Cy Inactive', status: 'inactive' });
    w.dee = await tw.employee({ name: 'Dee Third', work_email: 'dee@example.com' });
    w.fay = await tw.employee({ name: 'Fay Fourth', work_email: 'fay@example.com' });
    w.anaAcct = await tw.insert('accounts', { login_email: 'ana.login@example.com', role: 'employee', employee_id: w.ana.id });
    w.fayAcct = await tw.insert('accounts', { login_email: 'fay.login@example.com', role: 'employee', employee_id: w.fay.id });
    w.admin = await tw.insert('accounts', { login_email: 'it@example.com', role: 'admin' });
    // a closed entry far back in another asset's line: queue_seq is per asset, so it must never leak into these assets' numbers
    const elsewhere = await tw.asset({ name: 'Elsewhere', available_to_request: 1 });
    await tw.entry({ asset_id: elsewhere.id, employee_id: w.ben.id, start_date: '2026-01-05', status: 'left', queue_seq: 1000 });
  });
  afterEach(async () => { await effects.whenIdle(); effects.setNotifier(null); waitlist.setGapHookForTests(null); });
  after(async () => {
    await effects.whenIdle();
    assert.equal(pool.waitingCount, 0, 'nobody is still waiting for a connection');
    assert.equal(pool.idleCount, pool.totalCount, 'every client was released');
    tw?.close();
    await tdb?.drop();
    sqliteMail.cleanup();
  });

  const req = (cols = {}) => tw.asset({ available_to_request: 1, ...cols });
  // a fixture hold (hold_email_at set: its email went out when it was granted)
  const held = (cols) => tw.entry({ status: 'held', hold_email_at: FIXED, ...cols });
  const live = () => tw.stamp(HOURS6);
  const shown = (o) => {
    const m = mask(o);
    if (m.ok && m.ok.hold_expires_text) m.ok.hold_expires_text = '<text>';
    return m;
  };
  // One differential step: same call on both engines, same outcome, same resulting state and presentation of `assetIds`.
  // Returns the PostgreSQL outcome plus the effects its notifier saw.
  async function same(label, pgFn, sqFn, assetIds) {
    await tw.syncSequences();
    const rec = installHoldMailNotifier(pool);
    let pgRaw;
    try {
      pgRaw = await outcome(() => pgFn(pool));
      await effects.whenIdle();
    } finally { rec.uninstall(); }
    const sqRaw = await outcome(() => sqFn(tw.sqlite));
    const gp = groupNamer(); const gs = groupNamer();
    const pg = { out: mask(pgRaw, { group: gp }), state: [], shown: [] };
    const sq = { out: mask(sqRaw, { group: gs }), state: [], shown: [] };
    for (const id of assetIds) {
      pg.state.push(await dumpAsset(pool, id, { group: gp }));
      sq.state.push(await dumpAsset(tw.sq, id, { group: gs }));
      for (const e of (await pool.query('SELECT id, employee_id FROM waitlist_entries WHERE asset_id = $1 ORDER BY id', [id])).rows) {
        for (const user of [ADMIN, { role: 'employee', employee_id: e.employee_id }]) {
          pg.shown.push(shown(await outcome(() => waitlist.get(pool, e.id, user))));
          sq.shown.push(shown(await outcome(() => sqliteWaitlist.get(tw.sqlite, e.id, user))));
        }
      }
    }
    assert.deepEqual(pg, sq, label);
    return { ...pgRaw, effects: ours(rec.seen, assetIds) };
  }
  const join = (label, args, assetIds = [args.assetId]) => same(`join: ${label}`, (q) => waitlist.join(q, args), (db) => sqliteWaitlist.join(db, args), assetIds);
  const act = (fn, label, id, opts, assetIds) => same(`${fn}: ${label}`, (q) => waitlist[fn](q, id, opts), (db) => sqliteWaitlist[fn](db, id, opts), assetIds);
  const due = (label, assetId) => same(`processDue: ${label}`, async (q) => { await waitlist.processDue(q, assetId); return null; }, (db) => { sqliteWaitlist.sweep(db); return null; }, [assetId]); // (SQLite's processDue never emails: its sweep does)
  const ana = () => ({ employeeId: w.ana.id, actorAccountId: w.anaAcct.id });
  const fay = () => ({ employeeId: w.fay.id, actorAccountId: w.fayAcct.id });
  const types = (r) => r.effects.map((e) => e.type);
  // The effects about these assets (the dispatch is global: it also claims holds other tests left unclaimed)
  const ours = (seen, assetIds) => seen.filter((e) => assetIds.includes(e.type === 'hold_email' ? e.entry.asset_id : e.assetId));
  const statusOf = async (id) => (await pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [id])).rows[0].status;

  test('join: success with effects in SQLite\'s order, every refusal, lapsed holds recorded before the decision (identical)', async () => {
    const a = await req({ name: 'Join' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(3), end_date: d(5) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(6), end_time: '10:00' });
    await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(6), start_time: '10:00', end_time: '17:00' });
    const r = await join('whole range unavailable, two reservers (Ben twice)', { assetId: a.id, ...ana(), start: d(4), end: d(6), startTime: null, endTime: '17:00' });
    assert.deepEqual(types(r), ['waitlist_joined', 'waitlist_joined', 'request_recorded']);
    assert.deepEqual(r.effects.slice(0, 2).map((e) => [e.reserver.employee_id, e.waiterEmployeeId, e.updated]), [[w.ben.id, w.ana.id, undefined], [w.dee.id, w.ana.id, undefined]]);
    assert.deepEqual(r.effects[2], { type: 'request_recorded', employeeId: w.ana.id, assetId: a.id, requested: r.ok.entry, reserved: [], waitlisted: [r.ok.entry] });
    assert.equal(r.ok.entry.queue_seq, 1, 'queue_seq is per asset');
    const r2 = await join('a second person behind her', { assetId: a.id, ...fay(), start: d(3), end: d(3) });
    assert.equal(r2.ok.entry.queue_seq, 2);
    await join('own waitlist', { assetId: a.id, ...ana(), start: d(5), end: d(5) });
    await join('free: reserve instead (409)', { assetId: a.id, ...ana(), start: d(8), end: d(8) });
    await join('part free: partial (409)', { assetId: a.id, ...fay(), start: d(6), end: d(8) });
    await join('own reservation', { assetId: a.id, employeeId: w.dee.id, actorAccountId: null, start: d(6), end: d(6) });
    const timed = await req({ name: 'Join timed' });
    await tw.reservation({ asset_id: timed.id, employee_id: w.ben.id, start_date: d(3), start_time: '08:00', end_time: '13:00' });
    await join('9-12 inside 8-13', { assetId: timed.id, ...ana(), start: d(3), end: d(3), startTime: '09:00', endTime: '12:00' });
    await join('12-14 across the end: partial', { assetId: timed.id, ...fay(), start: d(3), end: d(3), startTime: '12:00', endTime: '14:00' });
    await join('13-17 adjacent to 8-13: free', { assetId: timed.id, ...fay(), start: d(3), end: d(3), startTime: '13:00', endTime: '17:00' });
    const own = await req({ name: 'Join own hold' });
    await held({ asset_id: own.id, employee_id: w.ana.id, start_date: d(10), hold_expires_at: await live(), queue_seq: 1 });
    await join('own hold', { assetId: own.id, ...ana(), start: d(10), end: d(10) });
    await join('someone else\'s live hold blocks: waitlisted behind it', { assetId: own.id, ...fay(), start: d(10), end: d(10) });
    const lapsed = await req({ name: 'Join lapsed' });
    await held({ asset_id: lapsed.id, employee_id: w.ana.id, start_date: d(5), hold_expires_at: LAPSED, queue_seq: 1 });
    const rl = await join('a lapsed hold is recorded (committed) first; the time is then free (409)', { assetId: lapsed.id, ...fay(), start: d(5), end: d(5) });
    assert.equal(rl.error.status, 409);
    assert.equal(await statusOf((await pool.query('SELECT id FROM waitlist_entries WHERE asset_id = $1', [lapsed.id])).rows[0].id), 'expired', 'the refused request still moved the queue');
    const hidden = await tw.asset({ name: 'Hidden' });
    const archived = await req({ name: 'Archived', archived_at: FIXED });
    const repair = await req({ name: 'Repair', status: 'maintenance' });
    const seats = await req({ name: 'Seats', license_seats: 3 });
    const base = { ...ana(), start: d(4), end: d(4) };
    const cases = [
      ['hidden asset', { ...base, assetId: hidden.id }], ['unknown asset', { ...base, assetId: 999999 }], ['garbage asset id', { ...base, assetId: 'abc' }],
      ['asset id 0', { ...base, assetId: 0 }], ['asset id out of range', { ...base, assetId: 2 ** 40 }], ['archived', { ...base, assetId: archived.id }],
      ['repair', { ...base, assetId: repair.id }], ['multi-seat', { ...base, assetId: seats.id }], ['no employee', { ...base, assetId: a.id, employeeId: null }],
      ['inactive employee', { ...base, assetId: a.id, employeeId: w.cy.id }], ['no dates', { assetId: a.id, ...ana() }],
      ['end before start', { ...base, assetId: a.id, end: d(2) }], ['past start', { ...base, assetId: a.id, start: d(-1) }],
      ['after 2100', { ...base, assetId: a.id, end: '2101-01-01' }], ['bad time', { ...base, assetId: a.id, startTime: '7am' }],
      ['return before pickup', { ...base, assetId: a.id, startTime: '14:00', endTime: '13:00' }],
    ];
    for (const [label, args] of cases) {
      const x = await join(label, args, [a.id]);
      assert.ok(x.error, `${label} is refused`);
      assert.deepEqual(x.effects, [], `${label}: no effect`);
    }
  });

  test('updateDates: back of the line (per-asset queue_seq), the `updated` notice only for newly reached reservers, every refusal (identical)', async () => {
    const a = await req({ name: 'Edit dates' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), end_date: d(6) });
    await tw.reservation({ asset_id: a.id, employee_id: w.dee.id, start_date: d(8) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ana.id, start_date: d(12) });
    const e1 = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), queue_seq: 1 });
    await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
    const e3 = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(9), status: 'left', queue_seq: 3 });
    await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(8), end_date: d(8), start_time: '06:00', end_time: '07:00', queue_seq: 4 }); // blocked by Dee's day
    const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(10), hold_expires_at: await live(), queue_seq: 5 });
    const by = ana();
    const call = (label, id, opts) => act('updateDates', label, id, opts, [a.id]);
    await call('unknown entry', 999999, { ...by, start: d(6), end: d(6) });
    await call('garbage id', 'x', { ...by, start: d(6), end: d(6) });
    await call("someone else's", e1.id, { ...fay(), start: d(6), end: d(6) });
    await call('no employee', e1.id, { employeeId: null, actorAccountId: w.admin.id, start: d(6), end: d(6) });
    await call('held: confirm or decline first', h.id, { ...by, start: d(11), end: d(11) });
    await call('closed', e3.id, { ...by, start: d(6), end: d(6) });
    await call('bad time', e1.id, { ...by, start: d(5), end: d(5), startTime: '7am' });
    await call('already your dates', e1.id, { ...by, start: d(5), end: d(5) });
    await call('already your dates (times given as empty)', e1.id, { ...by, start: d(5), end: d(5), startTime: '', endTime: '' });
    await call('now partly free: partial', e1.id, { ...by, start: d(6), end: d(7) });
    await call('free: reserve', e1.id, { ...by, start: d(7), end: d(7) });
    await call('past start', e1.id, { ...by, start: d(-1), end: d(5) });
    await call('own reservation', e1.id, { ...by, start: d(12), end: d(12) });
    await call('own hold', e1.id, { ...by, start: d(10), end: d(10) });
    await call('own waitlist (overlaps her 6-7 AM entry)', e1.id, { ...by, start: d(8), end: d(8) });
    const r1 = await call('d5 -> d6: still Ben (told when she joined): back of the line, nobody newly told', e1.id, { ...by, start: d(6), end: d(6) });
    assert.deepEqual(types(r1), [], 'no notice');
    assert.equal(r1.ok.queue_seq, 6, 'MAX(queue_seq) + 1 over THIS asset');
    const r2 = await call('d6 -> d8 8 AM-5 PM: Dee newly reached: one `updated` notice', e1.id, { ...by, start: d(8), end: d(8), startTime: '08:00', endTime: '17:00' });
    assert.deepEqual(r2.effects, [{ type: 'waitlist_joined', waiterEmployeeId: w.ana.id, assetId: a.id, entry: r2.ok, reserver: r2.effects[0].reserver, updated: true }]);
    assert.equal(r2.effects[0].reserver.employee_id, w.dee.id);
    assert.equal(r2.ok.queue_seq, 7);
  });

  test('confirmHold: confirmed / pending, over a blocker -> back to waiting + 409 after COMMIT, every refusal (identical)', async () => {
    const c1 = await req({ name: 'Confirm' });
    const h1 = await held({ asset_id: c1.id, employee_id: w.ana.id, start_date: d(5), start_time: '13:00', end_time: '15:00', request_group: 'rg-confirm', hold_expires_at: await live(), queue_seq: 1 });
    const f1 = await tw.entry({ asset_id: c1.id, employee_id: w.fay.id, start_date: d(5), start_time: '13:00', end_time: '15:00', queue_seq: 2 });
    const call = (label, id, opts, assetId) => act('confirmHold', label, id, opts, [assetId]);
    // (an unknown id is refused before any due step: SQLite still ran its global processDue first, so every fixture here is
    // settled - nothing due - before such a call, or the two engines would legitimately differ on the other assets)
    await call('unknown entry', 999999, ana(), c1.id);
    await call("someone else's", h1.id, fay(), c1.id);
    await call('not offered yet', f1.id, fay(), c1.id);
    const ok = await call('confirmed: a reservation in the same request group', h1.id, ana(), c1.id);
    assert.equal(ok.ok.reservation.status, 'confirmed');
    assert.equal(ok.ok.entry.status, 'fulfilled');
    assert.equal(ok.ok.reservation.waitlist_entry_id, h1.id);
    assert.deepEqual(ok.effects, [], 'confirming sends nothing itself');
    await call('twice: closed', h1.id, ana(), c1.id);

    const c2 = await req({ name: 'Confirm approval', reservation_requires_approval: 1 });
    const h2 = await held({ asset_id: c2.id, employee_id: w.ana.id, start_date: d(6), hold_expires_at: await live(), queue_seq: 1 });
    const p = await call('approval ON: pending, "· waiting for IT approval"', h2.id, ana(), c2.id);
    assert.equal(p.ok.reservation.status, 'pending');

    const c3 = await req({ name: 'Confirm lapsed' });
    const h3 = await held({ asset_id: c3.id, employee_id: w.ana.id, start_date: d(7), hold_expires_at: LAPSED, queue_seq: 1 });
    const f3 = await tw.entry({ asset_id: c3.id, employee_id: w.fay.id, start_date: d(7), queue_seq: 2 });
    const x3 = await call('lapsed: 409 expired, the next person is offered it (and emailed)', h3.id, ana(), c3.id);
    assert.equal(x3.error.message, 'This hold has expired. The item was offered to the next person in line.');
    assert.deepEqual(types(x3), ['holds_owed', 'hold_email']);
    assert.equal(x3.effects[1].entry.id, f3.id);
    await call('the next person confirms', f3.id, fay(), c3.id);

    const c4 = await req({ name: 'Confirm over checkout', status: 'checked_out' });
    await tw.checkout({ asset_id: c4.id, employee_id: w.ben.id, due_date: d(5), due_time: '12:00' });
    const h4 = await held({ asset_id: c4.id, employee_id: w.ana.id, start_date: d(5), end_date: d(6), hold_expires_at: await live(), queue_seq: 1 });
    const x4 = await call('a checkout recorded meanwhile: back to waiting, the free part re-offered, 409 after COMMIT', h4.id, ana(), c4.id);
    assert.equal(x4.error.status, 409);
    assert.match(x4.error.message, /^Those dates are no longer available: it is /);

    const c5 = await req({ name: 'Confirm over reservation' });
    const h5 = await held({ asset_id: c5.id, employee_id: w.ana.id, start_date: d(7), hold_expires_at: await live(), queue_seq: 1 });
    await tw.reservation({ asset_id: c5.id, employee_id: w.ben.id, start_date: d(7) });
    await call('a confirmed reservation in the way: back to waiting', h5.id, ana(), c5.id);

    const c6 = await req({ name: 'Confirm born pending', reservation_requires_approval: 1 });
    const born = await tw.entry({ asset_id: c6.id, employee_id: w.ben.id, start_date: d(8), status: 'fulfilled', queue_seq: 1 });
    await tw.reservation({ asset_id: c6.id, employee_id: w.ben.id, start_date: d(8), status: 'pending', waitlist_entry_id: born.id });
    const h6 = await held({ asset_id: c6.id, employee_id: w.ana.id, start_date: d(8), hold_expires_at: await live(), queue_seq: 2 });
    await call('a waitlist-born reservation awaiting IT in the way', h6.id, ana(), c6.id);

    const c7 = await req({ name: 'Confirm repair' });
    const h7 = await held({ asset_id: c7.id, employee_id: w.ana.id, start_date: d(9), hold_expires_at: await live(), queue_seq: 1 });
    await tw.syncSequences();
    await pool.query("UPDATE assets SET status = 'maintenance' WHERE id = $1", [c7.id]);
    tw.sqlite.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(c7.id);
    await call("the item went to repair: can't be reserved right now", h7.id, ana(), c7.id);

    const c8 = await req({ name: 'Confirm inactive' });
    const h8 = await held({ asset_id: c8.id, employee_id: w.cy.id, start_date: d(9), hold_expires_at: await live(), queue_seq: 1 });
    await call('the holder is inactive', h8.id, { employeeId: w.cy.id, actorAccountId: null }, c8.id);

    const c9 = await req({ name: 'Confirm own overlap' });
    await tw.reservation({ asset_id: c9.id, employee_id: w.ana.id, start_date: d(9), status: 'pending', requires_approval: 1 });
    const h9 = await held({ asset_id: c9.id, employee_id: w.ana.id, start_date: d(9), hold_expires_at: await live(), queue_seq: 1 });
    await call('she already has a reservation for those dates', h9.id, ana(), c9.id);

    const c10 = await req({ name: 'Confirm passed' });
    const h10 = await held({ asset_id: c10.id, employee_id: w.ana.id, start_date: d(-1), end_date: d(2), hold_expires_at: await live(), queue_seq: 1 });
    await call('the start has passed: closed by the due step, 409 expired', h10.id, ana(), c10.id);

    const c11 = await req({ name: 'Confirm promoted' });
    await held({ asset_id: c11.id, employee_id: w.ben.id, start_date: d(4), hold_expires_at: LAPSED, queue_seq: 1 });
    const f11 = await tw.entry({ asset_id: c11.id, employee_id: w.ana.id, start_date: d(4), queue_seq: 2 });
    const y = await call('waiting behind a lapsed hold: the due step offers it, so confirming works', f11.id, ana(), c11.id);
    assert.equal(y.ok.reservation.status, 'confirmed');
  });

  test('declineHold: the next eligible entry is offered FIFO with the partial re-split, every refusal (identical)', async () => {
    const a = await req({ name: 'Decline' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), start_time: '08:00', end_time: '12:00' });
    const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), start_time: '12:00', end_time: '17:00', hold_expires_at: await live(), queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), start_time: '08:00', end_time: '17:00', queue_seq: 2 });
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(5), start_time: '13:00', end_time: '14:00', queue_seq: 3 });
    const call = (label, id, opts) => act('declineHold', label, id, opts, [a.id]);
    await call('unknown', 999999, ana());
    await call("someone else's", h.id, fay());
    await call('not offered yet: use Leave', f.id, fay());
    const r = await call('declined: Fay is offered 12-5 (8-12 keeps her place), Dee waits behind her', h.id, ana());
    assert.equal(r.ok.status, 'declined');
    assert.deepEqual(types(r), ['holds_owed', 'hold_email']);
    assert.equal(r.effects[1].entry.employee_id, w.fay.id);
    await call('closed', h.id, ana());
    const b = await req({ name: 'Decline lapsed' });
    const hb = await held({ asset_id: b.id, employee_id: w.ana.id, start_date: d(6), hold_expires_at: LAPSED, queue_seq: 1 });
    await call('lapsed: 409 already expired', hb.id, ana());
  });

  test('leave: own waiting / own held / IT removal / IT owner / not allowed / closed, and the queue moves (identical)', async () => {
    const a = await req({ name: 'Leave' });
    const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), hold_expires_at: await live(), queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
    const g = await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(5), end_date: d(6), queue_seq: 3 });
    const k = await tw.entry({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), queue_seq: 4 });
    const call = (label, id, opts) => act('leave', label, id, opts, [a.id]);
    await call("someone else's (the due step offers Dee d6)", f.id, { ...ana(), isAdmin: false });
    await call('unknown (the asset is settled now)', 999999, { ...ana(), isAdmin: false });
    await call('no employee, not IT', f.id, { employeeId: null, actorAccountId: null, isAdmin: false });
    const r = await call('own hold left: Fay is offered it', h.id, { ...ana(), isAdmin: false });
    assert.equal(r.ok.status, 'left');
    assert.deepEqual(types(r), ['holds_owed', 'hold_email']);
    const x = await call('IT removes Fay (· removed by IT): Dee is offered d5-d6', f.id, { employeeId: null, actorAccountId: w.admin.id, isAdmin: true });
    assert.equal(x.ok.status, 'removed');
    await call('own waiting entry left: nothing to offer (Dee holds d5)', k.id, { employeeId: w.ben.id, actorAccountId: null, isAdmin: false });
    await call('an admin who owns it leaves (not "removed")', g.id, { employeeId: w.dee.id, actorAccountId: w.admin.id, isAdmin: true });
    await call('closed', h.id, { ...ana(), isAdmin: false });
  });

  test('the due step: FIFO, an older blocked entry does not hold up a younger one, partial pieces keep their place (identical)', async () => {
    const a = await req({ name: 'Due FIFO' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(7) });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(9), start_time: '08:00', end_time: '12:00' });
    await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(7), queue_seq: 1 }); // older, blocked
    await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(8), queue_seq: 2 }); // younger, free
    await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(8), end_date: d(9), queue_seq: 3 }); // overlaps Dee's: d9 afternoon only
    await due('FIFO with a partial re-split', a.id);
    const held2 = (await pool.query("SELECT employee_id, start_date, start_time FROM waitlist_entries WHERE asset_id = $1 AND status = 'held' ORDER BY id", [a.id])).rows;
    assert.deepEqual(held2.map((x) => x.employee_id), [w.dee.id, w.fay.id, w.fay.id], 'Dee d8; Fay the two free parts of d9 (before 8 and after 12)');
    await due('again: no double offer', a.id);
  });

  test('response tiers and the end-of-interval cap through processDue (24 h / 2 h / 30 min)', async (t) => {
    const now = Date.now();
    const keyAt = (ms) => T.nowKey(new Date(ms));
    const startOfUtcDay = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    if (now - startOfUtcDay < 15 * 60e3 || startOfUtcDay + 864e5 - now < 15 * 60e3) return t.skip('within 15 minutes of UTC midnight: tier margins cannot be guaranteed');
    const window = async (start, end, label) => {
      const a = await req({ name: `Tier ${label}` });
      await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: start.slice(0, 10), start_time: start.slice(11) === '00:00' ? null : start.slice(11), end_date: end.slice(0, 10), end_time: end.slice(11), queue_seq: 1 });
      await tw.syncSequences();
      assert.deepEqual(await waitlist.processDue(pool, a.id), { assets: [a.id], failed: [] });
      const row = (await pool.query("SELECT hold_started_at, hold_expires_at FROM waitlist_entries WHERE asset_id = $1 AND status = 'held'", [a.id])).rows[0];
      assert.ok(row, `${label}: a hold was granted`);
      return STAMP_SECONDS(row.hold_expires_at) - STAMP_SECONDS(row.hold_started_at);
    };
    assert.equal(await window(`${d(3)}T09:00`, `${d(3)}T17:00`, '24h'), 24 * 3600);
    assert.equal(await window(keyAt(now + 10 * 3600e3), keyAt(now + 14 * 3600e3), '2h'), 2 * 3600);
    assert.equal(await window(keyAt(now + 3600e3), keyAt(now + 3 * 3600e3), '30m'), 30 * 60);
    if (keyAt(now + 11 * 60e3).slice(0, 10) === keyAt(now).slice(0, 10)) {
      const endKey = keyAt(now + 11 * 60e3);
      const secs = await window(keyAt(now), endKey, 'capped');
      const expected = (Date.parse(`${endKey}:00Z`) - Date.now()) / 1000;
      assert.ok(Math.abs(secs - expected) <= 3, `capped at the end of the interval (${secs}s vs ~${Math.round(expected)}s)`);
    }
  });

  test('request paths are asset-scoped: only the requested asset\'s due step runs, it commits before the main transaction, the sweep records the rest', async () => {
    const twoAssets = async (label) => {
      const x = await req({ name: `Scope ${label}` });
      const hx = await held({ asset_id: x.id, employee_id: w.ana.id, start_date: d(5), hold_expires_at: LAPSED, queue_seq: 1 });
      const fx = await tw.entry({ asset_id: x.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
      return { x, hx, fx };
    };
    const A = await twoAssets('A'); const B = await twoAssets('B');
    await tw.syncSequences();
    const rec = installHoldMailNotifier(pool);
    const refused = await outcome(() => waitlist.confirmHold(pool, A.hx.id, { employeeId: w.dee.id, actorAccountId: null })); // not hers
    assert.equal(refused.error.status, 403);
    await effects.whenIdle();
    assert.deepEqual([await statusOf(A.hx.id), await statusOf(A.fx.id)], ['expired', 'held'], 'A moved although the request was refused');
    assert.deepEqual([await statusOf(B.hx.id), await statusOf(B.fx.id)], ['held', 'waiting'], 'B untouched (its lapsed hold counts for nothing, but is not recorded)');
    const emailed = () => ours(rec.seen, [A.x.id, B.x.id]).filter((e) => e.type === 'hold_email').map((e) => e.entry.id);
    assert.deepEqual(emailed(), [A.fx.id], 'A\'s new hold was emailed');
    const swept = await waitlist.sweep(pool);
    assert.ok(swept.assets.includes(A.x.id) && swept.assets.includes(B.x.id));
    assert.deepEqual(swept.failed, []);
    await effects.whenIdle();
    assert.deepEqual([await statusOf(B.hx.id), await statusOf(B.fx.id)], ['expired', 'held'], 'the sweep recorded B');
    assert.deepEqual(emailed(), [A.fx.id, B.fx.id], 'each hold emailed once');
  });

  test('the gap (decision D4C-1): a hold that runs out between the committed due step and the main transaction is never confirmed / declined / left', async () => {
    const run = async (fn, opts, expected) => {
      const a = await req({ name: `Gap ${fn}` });
      const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), hold_expires_at: await live(), queue_seq: 1 });
      const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(5), queue_seq: 2 });
      await tw.syncSequences();
      let gaps = 0;
      waitlist.setGapHookForTests(async (assetId) => {
        gaps++;
        assert.equal(assetId, a.id);
        await pool.query('UPDATE waitlist_entries SET hold_expires_at = $1 WHERE id = $2', [LAPSED, h.id]); // the clock passed the expiry
      });
      const r = await outcome(() => waitlist[fn](pool, h.id, opts));
      waitlist.setGapHookForTests(null);
      assert.equal(gaps, 1);
      assert.deepEqual(r, { error: expected }, `${fn}: SQLite's own answer for an expired hold`);
      assert.equal(Number((await pool.query('SELECT COUNT(*) c FROM reservations WHERE asset_id = $1', [a.id])).rows[0].c), 0, `${fn}: no reservation`);
      // the refused main transaction rolled its lapse record back: the hold counts for nothing and the next due step records it
      assert.equal(await statusOf(h.id), 'held');
      assert.equal((await waitlist.get(pool, h.id, ADMIN)).phase, 'expired');
      await waitlist.processDue(pool, a.id);
      assert.deepEqual([await statusOf(h.id), await statusOf(f.id)], ['expired', 'held']);
      const notes = (await pool.query("SELECT details FROM activity WHERE asset_id = $1 AND action = 'waitlist_expired'", [a.id])).rows;
      assert.deepEqual(notes.map((n) => n.details), [`${T.when({ start_date: d(5), end_date: d(5) })} · hold ran out`]);
    };
    await run('confirmHold', ana(), { status: 409, message: 'This hold has expired. The item was offered to the next person in line.' });
    await run('declineHold', ana(), { status: 409, message: 'This hold has already expired.' });
    await run('leave', { ...ana(), isAdmin: false }, { status: 400, message: 'This waitlist entry is already closed.' });
    // a request that succeeds in the gap commits the lapse record with it, then moves the queue
    const a = await req({ name: 'Gap success' });
    const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(6), hold_expires_at: await live(), queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(6), queue_seq: 2 });
    const g = await tw.entry({ asset_id: a.id, employee_id: w.dee.id, start_date: d(6), queue_seq: 3 });
    await tw.syncSequences();
    waitlist.setGapHookForTests(() => pool.query('UPDATE waitlist_entries SET hold_expires_at = $1 WHERE id = $2', [LAPSED, h.id]));
    const left = await waitlist.leave(pool, f.id, { ...fay(), isAdmin: false });
    waitlist.setGapHookForTests(null);
    assert.equal(left.status, 'left');
    assert.deepEqual([await statusOf(h.id), await statusOf(g.id)], ['expired', 'held'], 'recorded and the next person offered, in one commit');
  });

  test('joined to a caller\'s transaction: the due step runs on the caller\'s client, everything commits or rolls back with it', async () => {
    const a = await req({ name: 'Joined' });
    await held({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), hold_expires_at: LAPSED, queue_seq: 1 });
    const f = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), queue_seq: 2 });
    await tw.syncSequences();
    const rec = installHoldMailNotifier(pool);
    await assert.rejects(withTransaction(async (c) => {
      const r = await waitlist.confirmHold(c, f.id, ana()); // Ben's lapsed hold recorded, Ana offered, then confirmed: one transaction
      assert.equal(r.reservation.status, 'confirmed');
      throw new Error('caller failed afterwards');
    }, pool), /caller failed/);
    await effects.whenIdle();
    assert.deepEqual(ours(rec.seen, [a.id]), [], 'nothing fires when the caller rolls back');
    assert.equal(await statusOf(f.id), 'waiting', 'nothing committed');
    const r = await withTransaction((c) => waitlist.confirmHold(c, f.id, ana()), pool);
    await effects.whenIdle();
    assert.equal(r.reservation.status, 'confirmed');
    assert.deepEqual(ours(rec.seen, [a.id]).map((e) => e.type), ['holds_owed'], 'one trigger at the caller\'s COMMIT (the hold was confirmed before any claim, so no email)');
    await assert.rejects(withTransaction(() => waitlist.join(pool, { assetId: a.id, ...fay(), start: d(5), end: d(5) }), pool), /cannot be nested/);
    await assert.rejects(withTransaction(() => waitlist.leave(pool, f.id, { ...ana(), isAdmin: false }), pool), /cannot be nested/);
    await assert.rejects(withTransaction((c) => waitlist.dispatchHoldEmails(c), pool), /outside any transaction/);
    await assert.rejects(withTransaction((c) => waitlist.processDue(c), pool), /pass the pool/);
    rec.uninstall();
  });

  test('rollback: a failure at the LAST write of join / updateDates / confirmHold / declineHold / leave leaves nothing behind and fires no effect; FK failure', async () => {
    const rec = installHoldMailNotifier(pool);
    await pool.query("CREATE OR REPLACE FUNCTION nc_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    let n = 0;
    const failOn = async (where) => {
      const name = `nc_fail_${++n}`;
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON activity FOR EACH ROW WHEN (${where}) EXECUTE FUNCTION nc_test_fail()`);
      return () => pool.query(`DROP TRIGGER ${name} ON activity`);
    };
    const snapshot = async (assetId) => ({
      r: (await pool.query('SELECT * FROM reservations WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      w: (await pool.query('SELECT * FROM waitlist_entries WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      a: (await pool.query('SELECT id FROM activity WHERE asset_id = $1 ORDER BY id', [assetId])).rows,
      s: (await pool.query('SELECT status, updated_at FROM assets WHERE id = $1', [assetId])).rows,
    });
    const attempt = async (label, assetId, where, fn) => {
      await tw.syncSequences();
      const drop = await failOn(`NEW.asset_id = ${Number(assetId)} AND ${where}`);
      const before = await snapshot(assetId);
      await assert.rejects(fn(), /injected failure/, label);
      await effects.whenIdle();
      assert.deepEqual(await snapshot(assetId), before, `${label}: nothing written`);
      await drop();
    };
    const a = await req({ name: 'Rollback actions' });
    await tw.reservation({ asset_id: a.id, employee_id: w.ben.id, start_date: d(5), end_date: d(8) });
    const e = await tw.entry({ asset_id: a.id, employee_id: w.ana.id, start_date: d(5), queue_seq: 1 });
    const h = await held({ asset_id: a.id, employee_id: w.ana.id, start_date: d(10), hold_expires_at: await live(), queue_seq: 2 });
    await tw.entry({ asset_id: a.id, employee_id: w.fay.id, start_date: d(10), queue_seq: 3 });
    // (the last write of join / updateDates / confirmHold is their own note; of decline / leave, the next person's hold note)
    await attempt('join', a.id, "NEW.action = 'waitlist_joined'", () => waitlist.join(pool, { assetId: a.id, ...fay(), start: d(6), end: d(6) }));
    await attempt('updateDates', a.id, "NEW.action = 'waitlist_updated'", () => waitlist.updateDates(pool, e.id, { ...ana(), start: d(7), end: d(7) }));
    await attempt('confirmHold', a.id, "NEW.action = 'waitlist_confirmed'", () => waitlist.confirmHold(pool, h.id, ana()));
    await attempt('declineHold', a.id, `NEW.action = 'waitlist_hold_started' AND NEW.subject_user_id = ${w.fay.id}`, () => waitlist.declineHold(pool, h.id, ana()));
    await attempt('leave', a.id, `NEW.action = 'waitlist_hold_started' AND NEW.subject_user_id = ${w.fay.id}`, () => waitlist.leave(pool, h.id, { ...ana(), isAdmin: false }));
    await tw.syncSequences();
    const before = await snapshot(a.id);
    await assert.rejects(waitlist.join(pool, { assetId: a.id, employeeId: w.fay.id, actorAccountId: 99999999, start: d(6), end: d(6) }), (err) => err.code === '23503');
    assert.deepEqual(await snapshot(a.id), before, 'FK failure: nothing written');
    await effects.whenIdle();
    assert.deepEqual(rec.seen, [], 'no effect (no hold_email, waitlist_joined, request_recorded, holds_owed) from any failed transaction');
    rec.uninstall();
  });

  test('the lapse step and the queue engine still refuse to run without the asset lock', async () => {
    const a = await req({ name: 'Guard' });
    await tw.syncSequences();
    const LOCK_REQUIRED = (err) => err.code === 'ASSET_LOCK_REQUIRED';
    await assert.rejects(withTransaction((c) => waitlist.evaluateAsset(c, a.id), pool), LOCK_REQUIRED);
    await withTransaction(async (c) => { await lockAsset(c, a.id); assert.deepEqual(await waitlist.evaluateAsset(c, a.id), []); }, pool);
  });
});
