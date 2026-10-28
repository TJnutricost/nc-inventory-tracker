// Backup tooling that needs no database (docs/BACKUP_RUNBOOK.md): retention, photo copy/restore against the S3 stand-in, config checks and
// secret redaction, status. The job against a real PostgreSQL is test/pg/pg-backup-job.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeS3 } = require('../test-support/fake-s3');
const { s3Store, readOnly } = require('../scripts/backup-lib/s3');
const { planRetention, dumpKey, parseDumpKey } = require('../scripts/backup-lib/retention');
const { syncPhotos, restorePhotos, latestVersions, versionKey } = require('../scripts/backup-lib/photos');
const { parseConfig, redact } = require('../scripts/backup-lib/config');
const { status } = require('../scripts/backup-tool');

let live; let bak; let liveStore; let bakStore; let src;
const cfg = (s3, key) => ({ bucket: s3.bucket, endpoint: s3.endpoint, accessKeyId: key, secretAccessKey: 'secret', region: 'auto', forcePathStyle: true });
before(async () => {
  live = await startFakeS3({ bucket: 'live', accessKey: 'LIVEKEY', pageSize: 2 }); // pageSize 2: the listing must follow continuation tokens
  bak = await startFakeS3({ bucket: 'bak', accessKey: 'BAKKEY', pageSize: 2 });
  liveStore = s3Store(cfg(live, 'LIVEKEY')); bakStore = s3Store(cfg(bak, 'BAKKEY'));
  src = readOnly(liveStore);
});
after(async () => { await live.close(); await bak.close(); });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bk-'));

test('retention keeps the newest dump of each of the last 14 days, 8 weeks and 6 months, always the newest overall, and touches nothing else', () => {
  const at = (iso) => dumpKey(new Date(iso));
  assert.equal(at('2026-10-28T07:30:00Z'), 'db/nc-20261028T073000Z.dump.enc');
  assert.equal(parseDumpKey('db/nc-20261028T073000Z.dump.enc').toISOString(), '2026-10-28T07:30:00.000Z');
  assert.equal(parseDumpKey('db/other.dump'), null);
  const keys = [];
  for (let i = 0; i < 400; i++) keys.push(at(new Date(Date.UTC(2026, 9, 28, 7, 30) - i * 864e5).toISOString())); // one a day for 400 days
  keys.push(at('2026-10-28T01:00:00Z')); // a second dump the same day: only the newest of that day stays
  const { keep, prune } = planRetention([...keys, 'status/last-run.json', 'photos/a.jpg@x', 'db/notes.txt']);
  assert.ok(keep.includes(at('2026-10-28T07:30:00Z')) && !keep.includes(at('2026-10-28T01:00:00Z')));
  assert.equal(keep.filter((k) => k >= at('2026-10-15T00:00:00Z')).length >= 14, true, 'the last 14 days are all there');
  assert.ok(keep.length >= 14 && keep.length <= 14 + 8 + 6, `${keep.length} kept`);
  assert.ok(prune.length > 350);
  assert.ok(![...keep, ...prune].some((k) => !k.startsWith('db/nc-')), 'status, photos and unrelated keys are never listed for pruning');
  assert.deepEqual(planRetention(['db/nc-20260101T000000Z.dump']).keep, ['db/nc-20260101T000000Z.dump'], 'a single (old) dump is never pruned');
  assert.deepEqual(planRetention([]), { keep: [], prune: [] });
});

test('photos: new files are copied, unchanged files are not copied again, an overwritten file keeps its old version, deletions are not propagated, the live bucket is only read', async () => {
  const put = (k, v) => liveStore.put(k, Buffer.from(v));
  await put('photos/a.jpg', 'AAA'); await put('photos/b.jpg', 'BBB'); await put('photos/c.jpg', 'CCC'); await put('other/not-a-photo.txt', 'x');
  const writes = () => [live.stats.puts, live.stats.deletes];
  const base = writes(); // (the three puts above)
  let r = await syncPhotos({ source: src, backup: bakStore });
  assert.deepEqual([r.scanned, r.copied, r.skipped, r.failed.length], [3, 3, 0, 0], '3 photos, the non-photo object is out of scope');
  assert.deepEqual(writes(), base, 'nothing was written or deleted on the live bucket');
  const putsAfterFirst = bak.stats.puts;

  r = await syncPhotos({ source: src, backup: bakStore });
  assert.deepEqual([r.copied, r.skipped], [0, 3], 'unchanged photos are not copied again');
  assert.equal(bak.stats.puts, putsAfterFirst, 'no write to the backup either');

  await put('photos/a.jpg', 'AAA-EDITED'); // overwritten in place
  r = await syncPhotos({ source: src, backup: bakStore });
  assert.deepEqual([r.copied, r.skipped], [1, 2]);
  const bakKeys = (await bakStore.list('photos/')).map((o) => o.key);
  assert.equal(bakKeys.filter((k) => k.startsWith('photos/a.jpg@')).length, 2, 'both versions of a.jpg are recoverable');

  await liveStore.remove('photos/b.jpg'); // deleted from the live bucket
  r = await syncPhotos({ source: src, backup: bakStore });
  assert.deepEqual([r.scanned, r.copied], [2, 0]);
  assert.ok((await bakStore.list('photos/')).some((o) => o.key.startsWith('photos/b.jpg@')), 'its backup stays');
  assert.equal(bak.stats.deletes, 0, 'nothing was ever deleted from the backup bucket');
  assert.equal(typeof src.put, 'undefined'); assert.equal(typeof src.remove, 'undefined');
});

test('photo restore: the newest version of every photo (deleted ones included) goes into an empty directory; non-empty or protected destinations are refused', async () => {
  const d = path.join(dir(), 'restored');
  const r = await restorePhotos({ backup: bakStore, toDir: d, protect: ['live', 'bak'] });
  assert.deepEqual([r.restored, r.failed.length], [3, 0]);
  assert.deepEqual(fs.readdirSync(d).sort(), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.equal(fs.readFileSync(path.join(d, 'a.jpg'), 'utf8'), 'AAA-EDITED', 'the newest version');
  assert.equal(fs.readFileSync(path.join(d, 'b.jpg'), 'utf8'), 'BBB', 'a photo deleted from the live bucket is restorable');
  await assert.rejects(restorePhotos({ backup: bakStore, toDir: d }), /not empty/);
  await assert.rejects(restorePhotos({ backup: bakStore, toStore: liveStore, protect: ['live', 'bak'] }), /live or the backup bucket/);
  const test = await startFakeS3({ bucket: 'restore-test', accessKey: 'RKEY' });
  try {
    const r2 = await restorePhotos({ backup: bakStore, toStore: s3Store(cfg(test, 'RKEY')), protect: ['live', 'bak'] });
    assert.equal(r2.restored, 3);
    assert.deepEqual([...test.objects.keys()].sort(), ['photos/a.jpg', 'photos/b.jpg', 'photos/c.jpg']);
  } finally { await test.close(); }
  assert.equal((await latestVersions(bakStore)).get('a.jpg').etag.length, 32);
});

test('a copy that does not match its checksum is reported and the run continues', async () => {
  const l2 = await startFakeS3({ bucket: 'l2', accessKey: 'K2' }); const b2 = await startFakeS3({ bucket: 'b2', accessKey: 'K3' });
  try {
    const ls = s3Store(cfg(l2, 'K2')); const bs = s3Store(cfg(b2, 'K3'));
    await ls.put('photos/good.jpg', Buffer.from('good')); await ls.put('photos/bad.jpg', Buffer.from('bad'));
    const real = ls.get;
    const lying = { ...readOnly(ls), get: async (k) => (k.endsWith('bad.jpg') ? Buffer.from('BAD') : real(k)) }; // same length, other bytes
    const r = await syncPhotos({ source: lying, backup: bs });
    assert.deepEqual([r.copied, r.failed.length], [1, 1]);
    assert.match(r.failed[0].error, /checksum/);
    assert.equal(await bs.head(versionKey('bad.jpg', (await ls.list('photos/')).find((o) => o.key.endsWith('bad.jpg')).etag)), null, 'the bad copy is not stored');
  } finally { await l2.close(); await b2.close(); }
});

test('configuration: all backup settings are required, the backup bucket must differ from the live one, secrets never appear in messages', () => {
  const ok = { DATABASE_URL: 'postgresql://u:pw-secret-1@h:5432/db', BACKUP_S3_BUCKET: 'bak', BACKUP_S3_ENDPOINT: 'https://e', BACKUP_S3_ACCESS_KEY_ID: 'BAKID1234', BACKUP_S3_SECRET_ACCESS_KEY: 'BAKSECRET-xyz', BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    S3_BUCKET: 'live', S3_ENDPOINT: 'https://e', S3_ACCESS_KEY_ID: 'LIVEID1234', S3_SECRET_ACCESS_KEY: 'LIVESECRET-abc' };
  assert.equal(parseConfig(ok).source.bucket, 'live');
  assert.equal(parseConfig({ ...ok, S3_BUCKET: undefined }).source, null, 'photos are optional');
  assert.throws(() => parseConfig({ ...ok, DATABASE_URL: undefined }), /DATABASE_URL/);
  assert.throws(() => parseConfig({ ...ok, BACKUP_S3_SECRET_ACCESS_KEY: '' }), /BACKUP_S3_SECRET_ACCESS_KEY/);
  assert.throws(() => parseConfig({ ...ok, BACKUP_S3_BUCKET: 'live' }), /different bucket/);
  assert.throws(() => parseConfig({ ...ok, BACKUP_S3_ACCESS_KEY_ID: 'LIVEID1234' }), /different/, 'the same credentials are refused too');
  const leaked = redact(`pg_dump failed for postgresql://u:pw-secret-1@h:5432/db using BAKSECRET-xyz and LIVESECRET-abc, key BAKID1234`, ok);
  assert.ok(!/pw-secret-1|BAKSECRET|LIVESECRET|BAKID1234/.test(leaked), leaked);
  assert.ok(!/postgresql:\/\/[^:]+:[^[]/.test(redact('postgres://a:b-pass@host/x', {})), 'a URL password is removed even when it is not in the environment');
});

test('status: never run, healthy, failed and stale are told apart', async () => {
  const s2 = await startFakeS3({ bucket: 'st', accessKey: 'SK' });
  try {
    const store = s3Store(cfg(s2, 'SK')); const lines = []; const out = (l) => lines.push(l);
    assert.equal(await status(store, new Date(), out), 1); assert.match(lines[0], /NEVER RUN/);
    const put = (k, o) => store.put(k, Buffer.from(JSON.stringify(o)));
    const finished = '2026-10-28T08:00:00.000Z';
    await put('status/last-run.json', { finishedAt: finished, ok: true }); await put('status/last-success.json', { finishedAt: finished, ok: true, db: { key: 'db/x' } });
    assert.equal(await status(store, new Date('2026-10-28T20:00:00Z'), out), 0, '12 h old: healthy');
    assert.equal(await status(store, new Date('2026-10-30T20:00:00Z'), out), 1, '60 h old: stale');
    await put('status/last-run.json', { finishedAt: '2026-10-29T08:00:00.000Z', ok: false, error: 'boom' });
    assert.equal(await status(store, new Date('2026-10-29T09:00:00Z'), out), 1, 'last run failed');
    assert.ok(lines.some((l) => /FAILED: boom/.test(l)));
  } finally { await s2.close(); }
});

test('dump encryption: round trip, fresh nonce, wrong key, tampering and a missing/invalid key are all refused', () => {
  const { parseKey, encrypt, decrypt } = require('../scripts/backup-lib/crypto');
  const { parseConfig } = require('../scripts/backup-lib/config');
  const key = parseKey(Buffer.alloc(32, 1).toString('base64'));
  const plain = Buffer.from('PGDMP-secret-employee-data');
  const blob = encrypt(plain, key);
  assert.ok(!blob.includes(Buffer.from('secret-employee-data')));
  assert.deepEqual(decrypt(blob, key), plain);
  assert.ok(!encrypt(plain, key).equals(blob), 'a new random nonce for every file');
  assert.deepEqual(parseKey(Buffer.alloc(32, 1).toString('hex')), key, 'hex works too');
  assert.throws(() => decrypt(blob, parseKey(Buffer.alloc(32, 2).toString('base64'))), /different key/);
  for (const at of [3, 7, 20, blob.length - 20, blob.length - 1]) { const t = Buffer.from(blob); t[at] ^= 1; assert.throws(() => decrypt(t, key), /different key|corrupt|not an encrypted/, `byte ${at}`); }
  assert.throws(() => decrypt(blob.subarray(0, blob.length - 1), key), /corrupt/);
  assert.throws(() => decrypt(Buffer.from('plain dump'), key), /not an encrypted/);
  for (const bad of ['', 'short', Buffer.alloc(16).toString('base64')]) assert.throws(() => parseKey(bad), /32 random bytes/);
  const env = { DATABASE_URL: 'postgresql://u:pw-secret-1@h:5432/db', BACKUP_S3_BUCKET: 'b', BACKUP_S3_ENDPOINT: 'https://e', BACKUP_S3_ACCESS_KEY_ID: 'IDIDID', BACKUP_S3_SECRET_ACCESS_KEY: 'SECRETSECRET' };
  assert.throws(() => parseConfig(env), /BACKUP_ENCRYPTION_KEY is not set/);
  assert.throws(() => parseConfig({ ...env, BACKUP_ENCRYPTION_KEY: 'nope' }), /32 random bytes/);
});
