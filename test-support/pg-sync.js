// A SYNCHRONOUS better-sqlite3-shaped handle over a PostgreSQL test database (Slice 5D-2, the driver-aware test harness). Many existing
// tests read and seed the database directly (`db.prepare(...).get()`, `db.exec(...)`) between HTTP calls; with NC_TEST_DRIVER=pg the harness
// gives them this instead of the SQLite handle. A worker thread owns one connection; the calling thread blocks on a SharedArrayBuffer
// until the worker answers, so the app's own pool (on the main thread) is not involved. Only for tests; it translates the SQLite dialect
// the tests use (`?` placeholders, PRAGMA, datetime('now'), julianday, INSERT OR IGNORE) and nothing more.
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');

function createSyncSql(url) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(path.join(__dirname, 'pg-sync-worker.js'), { workerData: { url, port: port2, sab }, transferList: [port2] });
  worker.unref();
  function call(msg) {
    Atomics.store(flag, 0, 0);
    worker.postMessage(msg);
    Atomics.wait(flag, 0, 0);
    const { message } = receiveMessageOnPort(port1);
    if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.code });
    return message.result;
  }
  return { query: (sql, params = []) => call({ sql, params }), close: () => { try { call({ close: true }); } catch { /* gone */ } } };
}

const NOW_TEXT = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

function translate(sql) {
  let out = ''; let n = 0; let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out
    .replace(/datetime\('now'\s*,\s*'([^']+)'\)/gi, (m, mod) => `to_char((now() at time zone 'utc') + interval '${mod}', 'YYYY-MM-DD HH24:MI:SS')`)
    .replace(/datetime\((?:'now')?\)/gi, NOW_TEXT)
    .replace(/julianday\(([^()]+)\)/gi, "(extract(epoch from ($1)::timestamp) / 86400.0)")
    .replace(/^(\s*)INSERT OR IGNORE INTO/i, '$1INSERT INTO')
    .replace(/^(\s*INSERT OR IGNORE[\s\S]*)$/i, '$1');
}

function createSqliteLikeDb(url) {
  const sync = createSyncSql(url);
  const hasId = new Map();
  const tableHasId = (table) => {
    if (!hasId.has(table)) hasId.set(table, sync.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id'", [table]).rows.length > 0);
    return hasId.get(table);
  };
  function run(sql, params) {
    if (/^\s*PRAGMA/i.test(sql)) return { rows: [], rowCount: 0 };
    let text = translate(sql);
    const ins = /^\s*INSERT\s+(OR\s+IGNORE\s+)?INTO\s+"?(\w+)"?/i.exec(sql);
    if (ins && /^\s*INSERT\s+OR\s+IGNORE/i.test(sql) && !/ON CONFLICT/i.test(text)) text += ' ON CONFLICT DO NOTHING';
    const wantsId = ins && !/RETURNING/i.test(text) && tableHasId(ins[2].toLowerCase());
    if (wantsId) text += ' RETURNING id';
    const res = sync.query(text, params.map((p) => (p === undefined ? null : p)));
    return { ...res, lastInsertRowid: wantsId && res.rows[0] ? res.rows[0].id : undefined };
  }
  const norm = (a) => (a.length === 1 && Array.isArray(a[0]) ? a[0] : a);
  const db = {
    prepare: (sql) => ({
      get: (...a) => run(sql, norm(a)).rows[0],
      all: (...a) => run(sql, norm(a)).rows,
      run: (...a) => { const r = run(sql, norm(a)); return { changes: r.rowCount, lastInsertRowid: r.lastInsertRowid }; },
    }),
    exec: (sql) => { for (const stmt of sql.split(/;\s*(?:\n|$)/).filter((s) => s.trim())) run(stmt, []); },
    pragma: () => undefined,
    transaction: (fn) => {
      const wrapped = (...args) => {
        sync.query('BEGIN');
        try { const r = fn(...args); sync.query('COMMIT'); return r; } catch (e) { try { sync.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
      };
      wrapped.immediate = wrapped; wrapped.deferred = wrapped; wrapped.exclusive = wrapped;
      return wrapped;
    },
    close: () => sync.close(),
    isPostgres: true,
  };
  return db;
}

module.exports = { createSyncSql, createSqliteLikeDb, translate };
