// A small S3 wrapper for the backup tooling (Railway buckets, or the in-process stand-in in tests). One store = one bucket + its own
// credentials. `readOnly(store)` hides every write, so the job can hold the LIVE bucket's credentials (Railway gives a bucket one
// read/write key, there is no read-only variant) while its code provably only reads from it.
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function s3Store(cfg) {
  const client = new S3Client({
    region: cfg.region || 'auto', endpoint: cfg.endpoint, forcePathStyle: !!cfg.forcePathStyle,
    // S3-compatible providers (Railway/Tigris) do not all accept the SDK's newer default checksum headers: only send them when required.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;
  const missing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404));
  return {
    bucket: Bucket, endpoint: cfg.endpoint,
    // Every object under `prefix`: { key, size, etag (unquoted), modified (Date) }, all pages.
    async list(prefix = '') {
      const out = []; let token;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size, etag: String(o.ETag || '').replace(/"/g, ''), modified: o.LastModified });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) { // the whole object as a Buffer, or null when it does not exist
      try { const r = await client.send(new GetObjectCommand({ Bucket, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch (e) { if (missing(e)) return null; throw e; }
    },
    async head(key) {
      try { const r = await client.send(new HeadObjectCommand({ Bucket, Key: key })); return { size: r.ContentLength, etag: String(r.ETag || '').replace(/"/g, '') }; } catch (e) { if (missing(e)) return null; throw e; }
    },
    async put(key, body, type = 'application/octet-stream') { await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: type })); },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket, Key: key })); },
  };
}

// Only list / get / head. Anything else is not there to call.
const readOnly = (store) => Object.freeze({ bucket: store.bucket, endpoint: store.endpoint, list: store.list, get: store.get, head: store.head });

module.exports = { s3Store, readOnly };
