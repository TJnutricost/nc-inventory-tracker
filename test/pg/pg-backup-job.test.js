// The daily backup job (scripts/backup-lib/job.js) against a real local PostgreSQL and two in-process S3 stand-ins (live bucket, backup bucket):
// the dump is uploaded and verified, restored into a NEW isolated database and compared with the source; photos are copied and restored;
// a second concurrent run does nothing; failures and missed runs are detected; no secret reaches the log; live data and the live bucket are
// never written. Needs PostgreSQL and pg_dump/pg_restore 18 (local or the postgres:18 Docker image); skipped otherwise.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pgSuite, createTestDatabase } = require('../../test-support/pg-harness');
const { startFakeS3 } = require('../../test-support/fake-s3');
const { pgTool } = require('../../scripts/pg-backup');
const { restore } = require('../../scripts/pg-restore');
const { runBackup, takeLock, EXIT } = require('../../scripts/backup-lib/job');
const { s3Store } = require('../../scripts/backup-lib/s3');
const { restorePhotos } = require('../../scripts/backup-lib/photos');
const { backupStore, status } = require('../../scripts/backup-tool');

const ENC_KEY = require('crypto').randomBytes(32).toString('base64');

function suiteOptions() {
  const base = pgSuite();
  if (base.skip) return base;
  try { pgTool('pg_dump', 'postgresql://u:p@127.0.0.1:5433/x'); return base; } catch (err) {
    if (process.env.NC_REQUIRE_PG === '1') throw err;
    return { skip: `backup job tests skipped: ${err.message}` };
  }
}

describe('Railway backup job (PostgreSQL + S3 stand-ins)', suiteOptions(), () => {
  let live; let bak; let src; let dbs; let env; let logs; let realLog;
  const fresh = async (opts) => { const d = await createTestDatabase(opts); dbs.push(d); return d; };
  const base = (liveS3, bakS3, url) => ({
    DATABASE_URL: url,
    BACKUP_S3_BUCKET: bakS3.bucket, BACKUP_S3_ENDPOINT: bakS3.endpoint, BACKUP_S3_ACCESS_KEY_ID: 'BAKKEY', BACKUP_S3_SECRET_ACCESS_KEY: 'bak-secret-value', BACKUP_S3_FORCE_PATH_STYLE: '1',
    BACKUP_ENCRYPTION_KEY: ENC_KEY,
    S3_BUCKET: liveS3.bucket, S3_ENDPOINT: liveS3.endpoint, S3_ACCESS_KEY_ID: 'LIVEKEY', S3_SECRET_ACCESS_KEY: 'live-secret-value', S3_FORCE_PATH_STYLE: '1',
  });

  before(async () => {
    dbs = [];
    src = await fresh();
    await src.pool.query("INSERT INTO employees (name, first_name, last_name, work_email, can_self_checkout) VALUES ('Bea Backup', 'Bea', 'Backup', 'bea@example.com', 0)");
    await src.pool.query("INSERT INTO assets (tag, name, serial, serial_normalized) VALUES ('BK-1', 'Backup Laptop', 'SN-BK', 'sn-bk')");
    live = await startFakeS3({ bucket: 'live', accessKey: 'LIVEKEY', pageSize: 2 });
    bak = await startFakeS3({ bucket: 'bak', accessKey: 'BAKKEY', pageSize: 2 });
    const liveStore = s3Store({ bucket: 'live', endpoint: live.endpoint, accessKeyId: 'LIVEKEY', secretAccessKey: 'x', forcePathStyle: true });
    for (const n of ['p1.jpg', 'p2.jpg', 'p3.jpg']) await liveStore.put(`photos/${n}`, Buffer.from(`bytes of ${n}`));
    env = base(live, bak, src.url);
    logs = []; realLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  });
  after(async () => {
    console.log = realLog;
    await live.close(); await bak.close();
    await Promise.all(dbs.map((d) => d.drop()));
  });

  test('a run dumps and verifies the database, copies the photos and writes the status; nothing is written to the live bucket or the live database', async () => {
    const livePuts = live.stats.puts; const liveDeletes = live.stats.deletes;
    const before_ = (await src.pool.query('SELECT count(*)::int n FROM employees')).rows[0].n;
    const r = await runBackup(env);
    assert.equal(r.exitCode, EXIT.OK, JSON.stringify(r.status));
    assert.equal(r.status.ok, true);
    assert.match(r.status.db.key, /^db\/nc-\d{8}T\d{6}Z\.dump\.enc$/);
    assert.ok(r.status.db.tables > 10);
    assert.deepEqual([r.status.photos.copied, r.status.photos.failed.length], [3, 0]);
    assert.deepEqual([live.stats.puts, live.stats.deletes], [livePuts, liveDeletes], 'the live bucket was only read');
    assert.equal((await src.pool.query('SELECT count(*)::int n FROM employees')).rows[0].n, before_, 'the live database was only read');
    assert.ok([...bak.objects.keys()].includes('status/last-run.json') && bak.objects.has('status/last-success.json'));
    assert.equal(await status(backupStore(env), new Date(), () => {}), 0, 'status says healthy');
  });

  test('RESTORE: the dump goes into a NEW empty database and matches the source; the photos go into an empty directory', async () => {
    const store = backupStore(env);
    const key = (await store.list('db/'))[0].key;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rs-')), 'restored.dump');
    const stored = await store.get(key);
    assert.ok(!stored.includes(Buffer.from('PGDMP')) && !stored.includes(Buffer.from('bea@example.com')), 'the stored object is encrypted: no dump header, no readable data');
    assert.equal(await require('../../scripts/backup-tool').main(['decrypt', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dk-')), 'x.dump'), 'ignored'], { ...env, BACKUP_ENCRYPTION_KEY: ENC_KEY }).catch(() => 'threw'), 'threw', 'decrypt of a missing input file fails');
    await assert.rejects(require('../../scripts/backup-tool').main(['restore-db', path.join(path.dirname(file), 'wrong.dump'), '--key', key], { ...env, BACKUP_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('base64') }), /different key/);
    assert.equal(await require('../../scripts/backup-tool').main(['restore-db', file, '--key', key], env), 0); // downloads and DECRYPTS with the key from the environment
    assert.equal(fs.readFileSync(file).subarray(0, 5).toString(), 'PGDMP', 'the decrypted file is a pg_dump custom-format file');
    const target = await fresh({ migrate: false });
    await restore(file, target.url); // pg-restore refuses a non-empty or a non-local database
    const q = (db, sql) => db.pool.query(sql).then((r) => r.rows);
    for (const sql of ['SELECT name, first_name, last_name, work_email, can_self_checkout FROM employees ORDER BY id', 'SELECT tag, name, serial FROM assets ORDER BY id', 'SELECT id FROM schema_migrations ORDER BY id']) {
      assert.deepEqual(await q(target, sql), await q(src, sql), sql);
    }
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ph-')), 'photos');
    const r = await restorePhotos({ backup: store, toDir: dir, protect: ['live', 'bak'] });
    assert.deepEqual([r.restored, r.failed.length], [3, 0]);
    assert.equal(fs.readFileSync(path.join(dir, 'p2.jpg'), 'utf8'), 'bytes of p2.jpg');
    await assert.rejects(restore(file, src.url), /not empty|tables|already/i, 'restoring over a database that has data is refused');
  });

  test('a second run is incremental (no photo copied again) and a run that cannot get the lock does nothing', async () => {
    const puts = bak.stats.puts;
    const holder = await takeLock(src.url); // another backup is "running"
    const busy = await runBackup(env);
    assert.deepEqual([busy.skipped, busy.exitCode], [true, EXIT.OK]);
    assert.equal(bak.stats.puts, puts, 'the skipped run wrote nothing');
    await holder.release();
    const r = await runBackup(env);
    assert.equal(r.exitCode, EXIT.OK);
    assert.deepEqual([r.status.photos.copied, r.status.photos.skipped], [0, 3]);
  });

  test('a failure is reported (exit 1, status says why), no secret is logged, and last-success is not overwritten', async () => {
    const good = JSON.parse(bak.objects.get('status/last-success.json').body.toString());
    logs.length = 0;
    const bad = { ...env, DATABASE_URL: src.url };
    const r = await runBackup(bad, { dump: async () => { throw new Error(`pg_dump failed connecting to ${src.url} with bak-secret-value live-secret-value`); } });
    assert.equal(r.exitCode, EXIT.FAILED);
    const run = JSON.parse(bak.objects.get('status/last-run.json').body.toString());
    assert.equal(run.ok, false); assert.match(run.error, /pg_dump failed/);
    assert.deepEqual(JSON.parse(bak.objects.get('status/last-success.json').body.toString()).finishedAt, good.finishedAt, 'the last SUCCESS is untouched by a failed run');
    const all = logs.join('\n') + JSON.stringify(run);
    assert.ok(!/bak-secret-value|live-secret-value/.test(all), 'no secret in the log or the status object');
    assert.ok(!all.includes(new URL(src.url).password) || new URL(src.url).password === '', 'no database password');
    assert.equal(await status(backupStore(env), new Date(), () => {}), 1, 'status now reports the failure');
  });

  test('a missed day is detected: the run still backs up, then exits 2', async () => {
    const stale = new Date(Date.now() + 40 * 3600e3); // 40 h after the last success
    const r = await runBackup(env, { now: () => stale });
    assert.equal(r.exitCode, EXIT.MISSED);
    assert.equal(r.status.ok, true); assert.equal(r.status.missed, true); assert.match(r.status.warnings[0], /missed/);
  });

  test('a photo bucket that is not configured skips photos with a warning; a backup bucket equal to the live one is refused; old dumps are pruned only from db/', async () => {
    const r = await runBackup({ ...env, S3_BUCKET: undefined, S3_ENDPOINT: undefined, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined });
    assert.equal(r.exitCode, EXIT.OK); assert.equal(r.status.photos, null); assert.match(r.status.warnings.join(' '), /photos were not backed up/);
    await assert.rejects(runBackup({ ...env, BACKUP_S3_BUCKET: 'live', BACKUP_S3_ENDPOINT: live.endpoint }), /different bucket/);
    // 30 ancient dumps (one a day) + an unrelated object: only dumps beyond the policy go, nothing outside db/
    const store = backupStore(env);
    for (let i = 1; i <= 30; i++) await store.put(`db/nc-2025${String(1 + Math.floor((i - 1) / 28)).padStart(2, '0')}${String(1 + ((i - 1) % 28)).padStart(2, '0')}T000000Z.dump`, Buffer.from('old'));
    await store.put('db/keep-me.txt', Buffer.from('x'));
    const photosBefore = (await store.list('photos/')).length;
    const r2 = await runBackup(env);
    assert.ok(r2.status.db.pruned.some((k) => /^db\/nc-2025/.test(k)), 'the ancient dumps went');
    assert.ok(r2.status.db.pruned.every((k) => /^db\/nc-\d{8}T\d{6}Z\.dump(\.enc)?$/.test(k)), 'only dump keys are ever pruned (the extra same-day dumps of the earlier runs go too)');
    assert.ok((await store.list('db/')).some((o) => o.key === r2.status.db.key), 'the newest dump is always kept');
    assert.ok(await store.head('db/keep-me.txt'), 'a non-dump object is never pruned');
    assert.equal((await store.list('photos/')).length, photosBefore, 'photos are never pruned');
  });
});
