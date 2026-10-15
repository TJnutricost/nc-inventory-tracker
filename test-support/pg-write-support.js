// Support for the Slice 4B / 4C write tests (D-46, D-47): the SQLite-writer environment, masks and state dumps for comparing the
// two engines, a fixture recorder that replays the same rows into fresh SQLite references, the serial-order oracle for race
// tests, lock orchestration, a query spy and (4C) the recording notifier the Slice 5 wiring will mirror. Only for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { buildSqliteReference } = require('./pg-parity');
const fx = require('./pg-fixtures');
const { outcome, FIXED } = require('./pg-twin');

// ---- the SQLite writers (src/reservations.js create, …) email through src/mailer.js, which opens src/db.js. Point it at a
// throwaway directory and block external mail BEFORE the first SQLite write (the mailer is required lazily). Its outbox is
// then the record of what SQLite would have sent (with no transport, a send writes its outbox row synchronously).
function prepareSqliteMail() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pg4b-sqlite-'));
  process.env.DATA_DIR = dir;
  process.env.NC_NO_EXTERNAL_MAIL = '1';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.MAIL_TEST_RECIPIENT;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true })); // (also when the suite was skipped)
  return {
    outbox: () => require('../src/db').db.prepare('SELECT id, to_addr, subject FROM outbox ORDER BY id').all(),
    cleanup() {
      try { require('../src/db').db.close(); } catch { /* never opened */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- masks: values the two clocks / generators legitimately differ in
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const STAMP_KEYS = new Set(['created_at', 'updated_at', 'decided_at', 'cancelled_at', 'closed_at', 'queued_at', 'hold_started_at', 'hold_expires_at', 'hold_email_at', 'checked_out_at', 'returned_at']);
// request_group UUIDs become G1, G2, … in order of first appearance (shared-ness is kept, the random value is not)
function groupNamer() {
  const names = new Map();
  return (g) => {
    if (g === null || g === undefined) return g;
    if (!names.has(g)) names.set(g, `G${names.size + 1}`);
    return names.get(g);
  };
}
const maskDetails = (s) => (s === null || s === undefined ? s : String(s).replace(/available until .+?(?= · |$)/g, 'available until <stamp>'));
function maskStamp(v, key) {
  if (v === null || v === undefined) return v;
  assert.match(String(v), STAMP_RE, `${key} is a 'YYYY-MM-DD HH:MM:SS' stamp`);
  return '<stamp>';
}
// Deep mask. ctx: { group: groupNamer(), dropIds: false }. queue_seq is masked ('<seq>'): PostgreSQL numbers it per asset,
// SQLite across the table (D-47 / brief rule 6); dumpAsset keeps its ORDER as a rank instead.
function mask(value, ctx = {}) {
  const group = ctx.group || groupNamer();
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, walk(x)]));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (ctx.dropIds && k === 'id') continue;
      if (STAMP_KEYS.has(k)) out[k] = maskStamp(x, k);
      else if (k === 'request_group') out[k] = group(x);
      else if (k === 'queue_seq') out[k] = '<seq>';
      else if (k === 'details') out[k] = maskDetails(x);
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(value);
}

// Everything a write can change for one asset, masked. `relative`: module-written ids are dropped (rows keep their id order)
// and waitlist_entry_id points at the entry's position ('E1', …), for comparing against a SQLite database built separately.
async function dumpAsset(q, assetId, { relative = false, group = groupNamer() } = {}) {
  const all = async (sql) => (await q.query(sql, [assetId])).rows;
  const resv = await all('SELECT * FROM reservations WHERE asset_id = $1 ORDER BY id');
  const wl = await all('SELECT * FROM waitlist_entries WHERE asset_id = $1 ORDER BY id');
  const act = await all('SELECT action, details, actor_id, subject_user_id FROM activity WHERE asset_id = $1 ORDER BY id');
  const asg = await all('SELECT employee_id, assignment_type, due_date, due_time, returned_at, checked_out_by FROM assignments WHERE asset_id = $1 ORDER BY id');
  const asset = (await all('SELECT status FROM assets WHERE id = $1'))[0];
  const seqs = [...new Set(wl.map((w) => w.queue_seq))].sort((a, b) => a - b);
  const entryRef = new Map(wl.map((w, i) => [w.id, `E${i + 1}`]));
  const strip = (row) => { if (!relative) return row; const { id, ...rest } = row; return rest; };
  return mask({
    asset,
    reservations: resv.map((r) => strip({ ...r, waitlist_entry_id: relative && r.waitlist_entry_id !== null ? (entryRef.get(r.waitlist_entry_id) || `other:${r.waitlist_entry_id}`) : r.waitlist_entry_id })),
    waitlist: wl.map((w) => strip({ ...w, queue_rank: seqs.indexOf(w.queue_seq) + 1 })),
    activity: act,
    assignments: asg,
  }, { group });
}

// ---- a fixture recorder: rows with explicit ids and fixed clock columns, applied to any executor (PostgreSQL once, a fresh
// SQLite reference per serial order). Ids come from one process-wide counter so recorders never collide in one database.
const STAMP_COLS = { employees: ['created_at'], accounts: ['created_at'], assets: ['created_at', 'updated_at'], reservations: ['created_at', 'updated_at'], waitlist_entries: ['created_at', 'updated_at'], assignments: ['checked_out_at'] };
let nextFixtureId = 500000;
function createFixture() {
  const rows = [];
  const add = (table, cols) => {
    const row = { id: ++nextFixtureId, ...cols };
    for (const c of STAMP_COLS[table] || []) if (row[c] === undefined) row[c] = FIXED;
    rows.push([table, row]);
    return row;
  };
  const f = {
    rows,
    employee: (cols = {}) => add('employees', { name: `Person ${nextFixtureId + 1}`, ...cols }),
    account: (cols) => add('accounts', { login_email: `fx${nextFixtureId + 1}@nutricost.com`, role: 'employee', ...cols }),
    asset: (cols = {}) => add('assets', { tag: `OR-${nextFixtureId + 1}`, name: `Asset ${nextFixtureId + 1}`, available_to_request: 1, ...cols }),
    assignment: (cols) => add('assignments', { assignment_type: 'permanent', ...cols }),
    reservation(cols) {
      const row = { status: 'confirmed', requires_approval: 0, ...cols };
      if (['pending', 'declined'].includes(row.status) && cols.requires_approval === undefined) row.requires_approval = 1;
      if (row.status === 'declined') row.decided_at ??= FIXED;
      if (row.status === 'cancelled') row.cancelled_at ??= FIXED;
      row.end_date ??= row.start_date;
      return add('reservations', row);
    },
    entry(cols) {
      const row = { status: 'waiting', ...cols };
      row.end_date ??= row.start_date;
      if (row.status === 'held') { row.hold_started_at ??= FIXED; row.hold_expires_at ??= '2999-12-31 00:00:00'; }
      if (!['waiting', 'held'].includes(row.status)) row.closed_at ??= FIXED;
      return add('waitlist_entries', row);
    },
    async apply(q) { for (const [table, row] of rows) await fx.insertRow(q, table, row); },
  };
  return f;
}

// ---- serial-order oracle
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((x, i) => { for (const p of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}
// An operation's outcome, masked for comparison: { ok: summary } or { error: { status, message } }.
const summarize = (o, group) => ('ok' in o ? { ok: mask(o.ok, { group, dropIds: true }) } : o);

// Runs `ops` (each { sq: (db) => result }) through the SQLite modules in EVERY serial order, each on a fresh reference with
// the fixture applied. Returns [{ order, outs, state }] — outs[i] is op i's masked outcome, state the masked dumps.
async function serialOracle(fixture, assetIds, ops) {
  const results = [];
  for (const order of permutations(ops.map((_, i) => i))) {
    const db = buildSqliteReference();
    try {
      const q = fx.sqliteExecutor(db);
      await fixture.apply(q);
      const raw = new Array(ops.length);
      for (const i of order) raw[i] = await outcome(() => ops[i].sq(db));
      const group = groupNamer();
      const outs = raw.map((o) => summarize(o, group));
      const state = [];
      for (const id of assetIds) state.push(await dumpAsset(q, id, { relative: true, group }));
      results.push({ order, outs, state });
    } finally {
      db.close();
    }
  }
  return results;
}
// The PostgreSQL concurrent run, masked the same way.
async function maskedRun(q, raw, assetIds) {
  const group = groupNamer();
  const outs = raw.map((o) => summarize(o, group));
  const state = [];
  for (const id of assetIds) state.push(await dumpAsset(q, id, { relative: true, group }));
  return { outs, state };
}
// The acceptance oracle: the PostgreSQL concurrent outcome must equal ONE serial SQLite outcome. Returns the matching orders.
function assertMatchesSerial(pgRun, serial, label) {
  const same = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
  const matches = serial.filter((s) => same({ outs: s.outs, state: s.state }, pgRun));
  if (!matches.length) {
    assert.deepEqual(pgRun, { outs: serial[0].outs, state: serial[0].state }, `${label}: the PostgreSQL run equals no serial SQLite order (diff shown against order ${serial[0].order})`);
  }
  return matches.map((m) => m.order);
}

// ---- lock orchestration
async function waitFor(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// Holds asset `id`'s row lock on its own connection until release().
async function blockAsset(pool, id) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [id]);
  return { pid: c.processID, async release() { await c.query('COMMIT'); c.release(); } };
}
const lockWaiters = async (sampler) => Number((await sampler.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n);
// Starts every fn while the asset is locked by a third connection, waits until all of them are queued on a lock, then lets
// them go. Returns their outcomes (in fn order). The order PostgreSQL then grants the lock in is ITS choice: the oracle
// accepts any serial order.
async function race(pool, sampler, assetId, fns) {
  const blocker = await blockAsset(pool, assetId);
  let runs;
  try {
    runs = fns.map((fn) => outcome(fn));
    await waitFor(async () => (await lockWaiters(sampler)) >= fns.length, `${fns.length} contenders to wait on asset ${assetId}`);
  } finally {
    await blocker.release();
  }
  return Promise.all(runs);
}

// ---- query spy: a pool whose clients record every statement's SQL text (in order) while checked out. (Slice 4C: `calls` keeps
// { sql, params, client } per statement as well; client is a per-checkout number, 0 for statements run on the pool itself.)
// (Slice 5A) lockAsset's own two lock_timeout statements around its FOR UPDATE are part of the lock, not reads of protected
// state, so they are not recorded (isLockTimeoutSql); test/pg/pg-lock-timeout.test.js checks them directly.
const isLockTimeoutSql = (sql) => /^SELECT (current_setting\('lock_timeout'\)|set_config\('lock_timeout')/.test(String(sql));
function spyPool(pool) {
  const log = [];
  const calls = [];
  let checkouts = 0;
  return {
    log,
    calls,
    pool: {
      async connect() {
        const client = await pool.connect();
        const n = ++checkouts;
        const own = Object.prototype.hasOwnProperty.call(client, 'query');
        const original = client.query;
        client.query = function spied(text, ...rest) {
          const sql = typeof text === 'string' ? text : text && text.text;
          if (isLockTimeoutSql(sql)) return original.call(this, text, ...rest);
          log.push(sql);
          calls.push({ sql, params: Array.isArray(rest[0]) ? rest[0] : (text && text.values) || [], client: n });
          return original.call(this, text, ...rest);
        };
        const release = client.release;
        client.release = function released(...args) {
          if (own) client.query = original; else delete client.query;
          client.release = release;
          return release.apply(this, args);
        };
        return client;
      },
      // (Slice 4C) statements run on the pool itself, outside any checked-out client: the unlocked id -> asset lookups and scans
      query: (text, ...rest) => {
        const sql = typeof text === 'string' ? text : text && text.text;
        log.push(sql);
        calls.push({ sql, params: Array.isArray(rest[0]) ? rest[0] : [], client: 0 });
        return pool.query(text, ...rest);
      },
    },
  };
}

// ---- (Slice 4C) the notifier Slice 5 will install, with a recorder in place of the PG mailer: holds_owed -> dispatchHoldEmails(pool),
// hold_email -> recorded (and `onHoldEmail(entry)` awaited, e.g. a gate or a failure); every effect is kept in `seen`.
function installHoldMailNotifier(pool, { onHoldEmail = null, onEffect = null } = {}) {
  const effects = require('../src/pg/effects');
  const waitlist = require('../src/pg/waitlist');
  const rec = { seen: [], holdEmails: [] };
  effects.setNotifier(async (e) => {
    rec.seen.push(e);
    if (onEffect) await onEffect(e);
    if (e.type === 'holds_owed') await waitlist.dispatchHoldEmails(pool);
    else if (e.type === 'hold_email') {
      rec.holdEmails.push(e.entry);
      if (onHoldEmail) await onHoldEmail(e.entry);
    }
  });
  rec.uninstall = () => effects.setNotifier(null);
  return rec;
}
const oneLine = (sql) => String(sql).replace(/\s+/g, ' ').trim();

module.exports = {
  prepareSqliteMail, STAMP_RE, mask, maskDetails, groupNamer, dumpAsset, createFixture, permutations, serialOracle, maskedRun, assertMatchesSerial,
  waitFor, blockAsset, lockWaiters, race, spyPool, isLockTimeoutSql, oneLine, outcome, installHoldMailNotifier,
};
