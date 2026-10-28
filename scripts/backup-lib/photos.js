// Photo backup: copies the live bucket's `photos/` objects into the backup bucket and restores them. Rules:
//   - Each backup object is keyed `photos/<name>@<etag>`: the live object's ETag (its MD5) is part of the key. A file that is the same
//     as last time already exists there and is NOT copied again; a file that was overwritten has a new ETag, so it is copied under a NEW
//     key and the old version stays recoverable.
//   - Nothing is ever deleted or overwritten in the backup, and nothing is written to the live bucket (it is passed read-only), so a photo
//     deleted from the live bucket stays in the backup.
//   - Every copy is checked: the MD5 of the bytes read must equal the live ETag (single-part uploads; a multipart ETag, "<md5>-<n>", is
//     verified by size only).
//   - A photo that fails is counted and reported, and the run continues with the rest.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'photos/';
const versionKey = (name, etag) => `${PREFIX}${name}@${etag}`;
const parseVersionKey = (key) => {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length); const at = rest.lastIndexOf('@');
  return at > 0 && at < rest.length - 1 ? { name: rest.slice(0, at), etag: rest.slice(at + 1) } : null;
};
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// source: a READ-ONLY store (scripts/backup-lib/s3.js readOnly), backup: a store. -> { scanned, copied, skipped, failed: [{ key, error }], bytes }
async function syncPhotos({ source, backup, log = () => {} }) {
  const live = await source.list(PREFIX);
  const have = new Set((await backup.list(PREFIX)).map((o) => o.key));
  const result = { scanned: live.length, copied: 0, skipped: 0, failed: [], bytes: 0 };
  for (const obj of live) {
    const name = obj.key.slice(PREFIX.length);
    if (!name || name.endsWith('/')) { result.scanned--; continue; }
    const target = versionKey(name, obj.etag);
    if (have.has(target)) { result.skipped++; continue; }
    try {
      const body = await source.get(obj.key);
      if (!body) throw new Error('the object disappeared while copying');
      if (body.length !== obj.size) throw new Error(`read ${body.length} bytes, expected ${obj.size}`);
      if (/^[0-9a-f]{32}$/.test(obj.etag) && md5(body) !== obj.etag) throw new Error('checksum does not match the live object');
      await backup.put(target, body);
      result.copied++; result.bytes += body.length;
    } catch (e) {
      result.failed.push({ key: obj.key, error: e.message });
      log(`photos: ${obj.key} failed: ${e.message}`);
    }
  }
  return result;
}

// The newest backed-up version of every photo: Map name -> { key, etag, size, modified }.
async function latestVersions(backup) {
  const latest = new Map();
  for (const o of await backup.list(PREFIX)) {
    const v = parseVersionKey(o.key); if (!v) continue;
    const cur = latest.get(v.name);
    if (!cur || o.modified > cur.modified || (+o.modified === +cur.modified && o.key > cur.key)) latest.set(v.name, { key: o.key, etag: v.etag, size: o.size, modified: o.modified });
  }
  return latest;
}

// Restores the newest version of every photo into an ISOLATED destination: a local directory (must not exist or be empty) or a store whose
// bucket is not one of `protect` (the live and the backup bucket). Files are written as `<name>` (directory) / `photos/<name>` (store).
async function restorePhotos({ backup, toDir, toStore, protect = [], log = () => {} }) {
  if (!!toDir === !!toStore) throw new Error('restore photos into a directory OR a test bucket, not both');
  if (toStore && protect.some((b) => b && b === toStore.bucket)) throw new Error(`refusing to restore into ${toStore.bucket}: it is the live or the backup bucket`);
  if (toDir) {
    if (fs.existsSync(toDir) && fs.readdirSync(toDir).length) throw new Error(`refusing to restore into ${toDir}: it is not empty`);
    fs.mkdirSync(toDir, { recursive: true });
  }
  const latest = await latestVersions(backup);
  const result = { restored: 0, failed: [], bytes: 0 };
  for (const [name, v] of [...latest].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    try {
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) throw new Error('unsafe photo name');
      const body = await backup.get(v.key);
      if (!body) throw new Error('missing in the backup');
      if (/^[0-9a-f]{32}$/.test(v.etag) && md5(body) !== v.etag) throw new Error('the backed-up bytes do not match their checksum');
      if (toDir) fs.writeFileSync(path.join(toDir, name), body, { flag: 'wx' }); else await toStore.put(`${PREFIX}${name}`, body);
      result.restored++; result.bytes += body.length;
    } catch (e) { result.failed.push({ key: v.key, error: e.message }); log(`restore: ${v.key} failed: ${e.message}`); }
  }
  return result;
}

module.exports = { PREFIX, versionKey, parseVersionKey, syncPhotos, latestVersions, restorePhotos };
