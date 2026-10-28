// Backup status and recovery (docs/BACKUP_RUNBOOK.md). Reads the BACKUP bucket only (BACKUP_S3_* variables); it never writes to the live
// database or the live bucket, and restores only into a local isolated database or an empty directory.
//   node scripts/backup-tool.js status                       exit 0 healthy, 1 never run / last run failed / older than 36 h
//   node scripts/backup-tool.js list                         the dumps in the backup and how many photos
//   node scripts/backup-tool.js fetch <key> <out-file>       download one object (any dump, or one photo version `photos/<name>@<etag>`)
//   node scripts/backup-tool.js decrypt <in.dump.enc> <out.dump>   decrypt a downloaded dump with BACKUP_ENCRYPTION_KEY (no bucket access needed)
//   node scripts/backup-tool.js restore-db <out.dump> [--key db/nc-...dump.enc] [--restore]
//                                                            download the newest (or the named) dump and DECRYPT it (BACKUP_ENCRYPTION_KEY); with --restore also load it into
//                                                            the LOCAL database in DATABASE_URL (empty, never Railway: pg-restore refuses it)
//   node scripts/backup-tool.js restore-photos <dir>         the newest version of every photo into an empty directory
const fs = require('fs');
const { s3Store } = require('./backup-lib/s3');
const { restorePhotos, PREFIX } = require('./backup-lib/photos');
const { planRetention, DUMP_KEY } = require('./backup-lib/retention');
const { STALE_HOURS, redact } = require('./backup-lib/config');
const { parseKey, decrypt } = require('./backup-lib/crypto');

function backupStore(env = process.env) {
  const need = ['BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].filter((k) => !env[`BACKUP_S3_${k}`]);
  if (need.length) throw new Error(`set ${need.map((k) => `BACKUP_S3_${k}`).join(', ')}`);
  return s3Store({ bucket: env.BACKUP_S3_BUCKET, endpoint: env.BACKUP_S3_ENDPOINT, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY, region: env.BACKUP_S3_REGION || 'auto', forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === '1' });
}
const readJson = async (store, key) => { const b = await store.get(key); try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } };
const age = (iso, now) => `${((now - new Date(iso)) / 36e5).toFixed(1)} h ago`;

async function status(store, now = new Date(), out = console.log) {
  const run = await readJson(store, 'status/last-run.json');
  const ok = await readJson(store, 'status/last-success.json');
  if (!run) { out('Backup status: NEVER RUN (no status object in the backup bucket).'); return 1; }
  out(`Last run:     ${run.finishedAt} (${age(run.finishedAt, now)}) ${run.ok ? 'OK' : `FAILED: ${run.error}`}${run.missed ? ' (a run was missed before it)' : ''}`);
  if (ok) out(`Last success: ${ok.finishedAt} (${age(ok.finishedAt, now)}), dump ${ok.db && ok.db.key}${ok.photos ? `, photos ${ok.photos.scanned} scanned / ${ok.photos.copied} copied` : ''}`);
  const stale = !ok || now - new Date(ok.finishedAt) > STALE_HOURS * 3600e3;
  if (!ok) out('No successful backup has ever completed.'); else if (stale) out(`STALE: the last success is older than ${STALE_HOURS} hours.`);
  return !run.ok || stale ? 1 : 0;
}

async function latestDump(store) {
  const keys = (await store.list('db/')).map((o) => o.key).filter((k) => DUMP_KEY.test(k)).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

async function main(argv, env = process.env) {
  const [cmd, ...args] = argv;
  if (cmd === 'decrypt' && args.length === 2) {
    if (fs.existsSync(args[1])) throw new Error(`${args[1]} already exists; choose a new file name`);
    const plain = decrypt(fs.readFileSync(args[0]), parseKey(env.BACKUP_ENCRYPTION_KEY));
    fs.writeFileSync(args[1], plain, { flag: 'wx', mode: 0o600 }); console.log(`Decrypted ${args[0]} to ${args[1]} (${plain.length} bytes).`); return 0;
  }
  const store = backupStore(env);
  if (cmd === 'status') return status(store);
  if (cmd === 'list') {
    const dumps = (await store.list('db/')).filter((o) => DUMP_KEY.test(o.key));
    for (const d of dumps) console.log(`${d.key}  ${d.size} bytes`);
    console.log(`${dumps.length} dump(s); ${(await store.list(PREFIX)).length} photo version(s)`);
    return 0;
  }
  if (cmd === 'fetch' && args.length === 2) {
    if (fs.existsSync(args[1])) throw new Error(`${args[1]} already exists; choose a new file name`);
    const b = await store.get(args[0]); if (!b) throw new Error(`no such object: ${args[0]}`);
    fs.writeFileSync(args[1], b, { flag: 'wx' }); console.log(`Wrote ${args[1]} (${b.length} bytes).`); return 0;
  }
  if (cmd === 'restore-db' && args.length >= 1) {
    const keyAt = args.indexOf('--key'); const key = keyAt >= 0 ? args[keyAt + 1] : await latestDump(store);
    if (!key) throw new Error('the backup bucket holds no database dump');
    if (fs.existsSync(args[0])) throw new Error(`${args[0]} already exists; choose a new file name`);
    const b = await store.get(key); if (!b) throw new Error(`no such dump: ${key}`);
    const plain = key.endsWith('.enc') ? decrypt(b, parseKey(env.BACKUP_ENCRYPTION_KEY)) : b; // authenticated: a wrong key or altered file fails here
    fs.writeFileSync(args[0], plain, { flag: 'wx', mode: 0o600 }); console.log(`Wrote ${args[0]} from ${key} (${plain.length} bytes, decrypted).`);
    if (args.includes('--restore')) { const r = await require('./pg-restore').main([args[0]], env); return r; } // local, empty database only
    console.log('Next: DATABASE_URL=<local, empty database> node scripts/pg-restore.js ' + args[0]);
    return 0;
  }
  if (cmd === 'restore-photos' && args.length === 1) {
    const r = await restorePhotos({ backup: store, toDir: args[0], protect: [env.S3_BUCKET, env.BACKUP_S3_BUCKET], log: console.log });
    console.log(`Restored ${r.restored} photo(s) (${r.bytes} bytes) into ${args[0]}; ${r.failed.length} failed.`);
    return r.failed.length ? 1 : 0;
  }
  console.error('Usage: backup-tool.js status | list | fetch <key> <out> | decrypt <in> <out> | restore-db <out.dump> [--key K] [--restore] | restore-photos <dir>');
  return 2;
}

module.exports = { status, main, backupStore, latestDump, planRetention };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }).catch((e) => { console.error(`backup-tool failed: ${redact(e.message)}`); process.exitCode = 1; });
}
