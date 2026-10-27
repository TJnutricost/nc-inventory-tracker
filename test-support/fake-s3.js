// A tiny in-process S3 stand-in for tests (path-style: /<bucket>/<key>): PUT, GET, HEAD, DELETE of objects and HEAD of the bucket.
// It checks that every request is SigV4-signed and carries the expected access key, but does not verify signatures. Only for tests.
const http = require('http');

function startFakeS3({ bucket = 'test-bucket', accessKey = 'TESTKEY' } = {}) {
  const objects = new Map(); // key -> { body: Buffer, type }
  const stats = { puts: 0, gets: 0, deletes: 0, unsigned: 0, wrongKey: 0 };
  const fail = { put: 0, get: 0, putIf: null }; // put/get > 0: the next N requests answer 500; putIf(key, nth) -> true fails that PUT
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('AWS4-HMAC-SHA256')) { stats.unsigned++; res.writeHead(403).end(); return; }
      if (!auth.includes(`Credential=${accessKey}/`)) { stats.wrongKey++; res.writeHead(403).end(); return; }
      const url = new URL(req.url, 'http://x');
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      if (parts[0] !== bucket) { res.writeHead(404).end(); return; }
      const key = parts.slice(1).join('/');
      if (!key) { res.writeHead(req.method === 'HEAD' ? 200 : 400).end(); return; }
      if (req.method === 'PUT') {
        stats.puts++;
        if (fail.put > 0 || (fail.putIf && fail.putIf(key, stats.puts))) { if (fail.put > 0) fail.put--; res.writeHead(500).end(); return; }
        // aws-chunked bodies carry chunk framing; the SDK sends a plain body for a Buffer over http, so keep it as is
        objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] });
        res.writeHead(200, { ETag: '"fake"' }).end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        stats.gets++;
        if (fail.get > 0) { fail.get--; res.writeHead(500).end(); return; }
        const o = objects.get(key);
        if (!o) { res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
        res.writeHead(200, { 'Content-Type': o.type || 'application/octet-stream', 'Content-Length': o.body.length });
        res.end(req.method === 'HEAD' ? undefined : o.body);
      } else if (req.method === 'DELETE') {
        stats.deletes++; objects.delete(key); res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    endpoint: `http://127.0.0.1:${server.address().port}`, bucket, accessKey, objects, stats, fail,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeS3 };
