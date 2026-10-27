// Where the asset photo FILES live (the photo rows, captions and covers stay in the database either way).
//
//   Local (default)   the uploads folder on the data volume (DATA_DIR/uploads), exactly as before.
//   S3                a private S3-compatible bucket (Railway Buckets), chosen by setting S3_BUCKET. Nothing is public: the app
//                     authorizes every request and streams the object to the browser, so no bucket credential or URL ever
//                     reaches a browser.
//
//   S3_BUCKET             the S3 bucket name        (Railway: ${{<bucket>.BUCKET}})
//   S3_ENDPOINT           the S3 API endpoint       (Railway: ${{<bucket>.ENDPOINT}})
//   S3_ACCESS_KEY_ID      (Railway: ${{<bucket>.ACCESS_KEY_ID}})
//   S3_SECRET_ACCESS_KEY  (Railway: ${{<bucket>.SECRET_ACCESS_KEY}})
//   S3_REGION             optional, default "auto"  (Railway: ${{<bucket>.REGION}})
//   S3_FORCE_PATH_STYLE   optional, "1" for a bucket that needs path-style URLs (older Railway buckets)
//
// With S3 on, a photo that is not in the bucket is still served from the local uploads folder if it is there (photos stored
// before the switch need no migration), and removing a photo removes both copies. Objects are keyed `photos/<file name>`.
const fs = require('fs');
const path = require('path');

const KEY_PREFIX = 'photos/';
const bare = (name) => {
  const n = path.basename(String(name));
  if (!n || n !== String(name) || n.includes('\0')) throw Object.assign(new Error('Bad photo name'), { status: 400 });
  return n;
};

function localStore(dir) {
  const file = (name) => path.join(dir, bare(name));
  return {
    kind: 'local',
    label: 'local volume',
    async put(name, buffer) { await fs.promises.writeFile(file(name), buffer); },
    async get(name) {
      let st; try { st = await fs.promises.stat(file(name)); } catch { return null; }
      if (!st.isFile()) return null;
      return { body: fs.createReadStream(file(name)), length: st.size };
    },
    async remove(name) { await fs.promises.rm(file(name), { force: true }); },
  };
}

function s3Store(cfg, dir) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle,
    // S3-compatible providers (Railway/Tigris) do not all accept the SDK's newer default checksum headers: only send them when required.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const key = (name) => KEY_PREFIX + bare(name);
  const missing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404));
  const legacy = localStore(dir);
  return {
    kind: 's3',
    label: `bucket ${cfg.bucket}`,
    async put(name, buffer) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key(name), Body: buffer, ContentType: 'image/jpeg' }));
    },
    async get(name) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key(name) }));
        return { body: r.Body, length: r.ContentLength };
      } catch (e) {
        if (!missing(e)) throw e;
        return legacy.get(name); // a photo stored on the volume before the bucket was connected
      }
    },
    async remove(name) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key(name) })); // (deleting a missing key is not an error)
      await legacy.remove(name);
    },
    async check() { await client.send(new HeadBucketCommand({ Bucket: cfg.bucket })); },
  };
}

// The store the environment asks for. Half-configured S3 is an error at startup, never a silent fall back to local files.
function fromEnv(env, uploadDir) {
  if (!env.S3_BUCKET) return localStore(uploadDir);
  const need = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (need.length) throw new Error(`S3_BUCKET is set but ${need.join(', ')} ${need.length > 1 ? 'are' : 'is'} missing: photo storage is not fully configured.`);
  return s3Store({
    bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION || 'auto', forcePathStyle: env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true',
  }, uploadDir);
}

module.exports = { fromEnv, localStore, s3Store };
