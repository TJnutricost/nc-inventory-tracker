// The daily backup run (Railway cron service, scripts/backup-job.js). Lives under scripts/ because it is tooling, not the running app
// (the app's modules never import pg directly: test/pg/foundation-unit.test.js). One run: take the lock, dump the database to a file, encrypt it (AES-256-GCM, crypto.js), upload it to the
// backup bucket, prune old dumps, copy new/changed photos, write the status objects. See docs/BACKUP_RUNBOOK.md.
//   - Overlap: the run holds a PostgreSQL advisory lock for its whole duration; a second run that cannot get it exits without doing anything.
//   - Detection: `status/last-run.json` and `status/last-success.json` in the backup bucket; a run that finds the last success older than
//     STALE_HOURS did the work but exits 2 (so Railway shows it failed once: a run was missed); any failure exits 1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseConfig, redact, STALE_HOURS } = require('./config');
const { s3Store, readOnly } = require('./s3');
const { dumpKey, planRetention } = require('./retention');
const { syncPhotos } = require('./photos');
const { encrypt } = require('./crypto');

const LOCK_KEY = 5_100_731_001; // pg_try_advisory_lock key of the backup job (nothing else uses it)
const EXIT = { OK: 0, FAILED: 1, MISSED: 2 };

async function takeLock(databaseUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
  if (!rows[0].got) { await client.end(); return null; }
  return { release: async () => { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } finally { await client.end(); } } };
}

async function readJson(store, key) { const b = await store.get(key); try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } }

// deps (all optional, for tests): { dump(url, file) -> { bytes, tables }, lock(url), stores(cfg) -> { source, backup }, now() }
async function runBackup(env = process.env, deps = {}) {
  const log = (m) => console.log(redact(m, env));
  const now = deps.now || (() => new Date());
  const cfg = parseConfig(env);
  const stores = deps.stores ? deps.stores(cfg) : { backup: s3Store(cfg.backup), source: cfg.source ? readOnly(s3Store(cfg.source)) : null };
  const dump = deps.dump || ((url, file) => require('../pg-backup').backup(url, file));
  const lock = await (deps.lock || takeLock)(cfg.databaseUrl);
  if (!lock) { log('backup: another backup is running; nothing done'); return { exitCode: EXIT.OK, skipped: true }; }

  const started = now();
  const status = { startedAt: started.toISOString(), finishedAt: null, ok: false, missed: false, db: null, photos: null, warnings: [], error: null };
  const tmp = path.join(os.tmpdir(), `nc-backup-${process.pid}-${started.getTime()}.dump`);
  try {
    const last = await readJson(stores.backup, 'status/last-success.json');
    if (last && started - new Date(last.finishedAt) > STALE_HOURS * 3600e3) {
      status.missed = true; status.warnings.push(`the last successful backup finished ${last.finishedAt}: a run was missed`);
      log(`backup: WARNING ${status.warnings[0]}`);
    }
    // 1. database
    const key = dumpKey(started);
    const d = await dump(cfg.databaseUrl, tmp);
    const body = encrypt(fs.readFileSync(tmp), cfg.encryptionKey); // only the encrypted file is ever uploaded
    await stores.backup.put(key, body);
    const head = await stores.backup.head(key);
    if (!head || head.size !== body.length) throw new Error(`the uploaded dump ${key} does not match the local file`);
    status.db = { key, bytes: body.length, tables: d.tables, pruned: [] };
    log(`backup: database dump ${key} (${body.length} bytes, ${d.tables} tables with data) encrypted, uploaded and verified`);
    const plan = planRetention((await stores.backup.list('db/')).map((o) => o.key), started);
    for (const k of plan.prune) { await stores.backup.remove(k); status.db.pruned.push(k); }
    if (plan.prune.length) log(`backup: pruned ${plan.prune.length} old dump(s); ${plan.keep.length} kept`);
    // 2. photos
    if (stores.source) {
      status.photos = await syncPhotos({ source: stores.source, backup: stores.backup, log });
      log(`backup: photos scanned ${status.photos.scanned}, copied ${status.photos.copied}, unchanged ${status.photos.skipped}, failed ${status.photos.failed.length}`);
      if (status.photos.failed.length) throw new Error(`${status.photos.failed.length} photo(s) could not be backed up`);
    } else { status.warnings.push('no live photo bucket is configured: photos were not backed up'); log('backup: no live photo bucket configured; photos skipped'); }
    status.ok = true;
  } catch (e) {
    status.error = redact(e.message, env);
    log(`backup: FAILED: ${status.error}`);
  } finally {
    fs.rmSync(tmp, { force: true });
    status.finishedAt = now().toISOString();
    try {
      await stores.backup.put('status/last-run.json', Buffer.from(JSON.stringify(status, null, 2)), 'application/json');
      if (status.ok) await stores.backup.put('status/last-success.json', Buffer.from(JSON.stringify(status, null, 2)), 'application/json');
    } catch (e) { log(`backup: could not write the status object: ${redact(e.message, env)}`); status.ok = false; status.error = status.error || 'status object not written'; }
    await lock.release().catch(() => {});
  }
  return { exitCode: !status.ok ? EXIT.FAILED : status.missed ? EXIT.MISSED : EXIT.OK, status };
}

module.exports = { runBackup, takeLock, EXIT, LOCK_KEY };
