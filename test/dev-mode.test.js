// Local-dev reliability: `npm run dev` must never leave a developer looking at old code. Two rules are pinned here:
//   1. in dev (NODE_ENV=development) the browser caches nothing under public/ and the service worker is a self-removing kill switch;
//      in production nothing about caching or the real service worker changes;
//   2. a server that cannot get its port must say so and exit non-zero — it must NOT print the "running" banner (Express 5 hands a
//      listen failure to the app.listen callback, which used to print it), because then the old process on that port keeps answering
//      and every change looks like it "didn't show up".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawnSync } = require('node:child_process');
const { bootApp, startServer, stopServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');

test('dev mode: nothing under public/ is cacheable, and /sw.js is a kill switch that removes the worker and its caches', async () => {
  process.env.NODE_ENV = 'development'; // read once, when src/server.js is loaded
  const { app } = bootApp();
  const server = await startServer(app);
  try {
    const port = server.address().port;
    const get = async (u) => { const r = await fetch(`http://127.0.0.1:${port}${u}`); return { status: r.status, cache: r.headers.get('cache-control'), text: await r.text() }; };
    for (const u of ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest']) {
      const r = await get(u);
      assert.equal(r.status, 200, u);
      assert.equal(r.cache, 'no-store', `${u} must not be cached in dev`);
    }
    const sw = await get('/sw.js');
    assert.equal(sw.status, 200);
    assert.equal(sw.cache, 'no-store');
    assert.match(sw.text, /registration\.unregister\(\)/, 'removes itself');
    assert.match(sw.text, /caches\.delete/, 'and its caches');
    assert.doesNotMatch(sw.text, /SHELL|caches\.match/, 'and is not the real, cache-serving worker');
  } finally { await stopServer(server); delete process.env.NODE_ENV; }
});

test('production mode is unchanged: html/js/css revalidate (no-cache + ETag), the real service worker is served', async () => {
  process.env.NODE_ENV = 'production';
  const { app } = bootApp();
  const server = await startServer(app);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.ok(res.headers.get('etag'), 'validators are kept so revalidation is a cheap 304');
    // a plain conditional GET (what a browser sends on reload) is answered 304 — raw http, because fetch() adds its own cache headers
    const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/app.js', headers: { 'If-None-Match': res.headers.get('etag') } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(status, 304);
    const img = await fetch(`http://127.0.0.1:${port}/icon.svg`);
    assert.match(img.headers.get('cache-control') || '', /max-age=3600/, 'other static files keep their 1h cache');
    const sw = await (await fetch(`http://127.0.0.1:${port}/sw.js`)).text();
    assert.match(sw, /const SHELL = /);
    assert.doesNotMatch(sw, /registration\.unregister/);
  } finally { await stopServer(server); delete process.env.NODE_ENV; }
});

test('the dev script runs the file watcher with NODE_ENV=development; the README tells developers to use it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'NODE_ENV=development node --watch src/server.js');
  assert.equal(pkg.scripts.start, 'node src/server.js', '`npm start` stays the plain production start');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /DATA_DIR=\.\/data-dev PORT=3000 npm start/, 'the dev dataset must not be started with a command that never restarts');
  assert.match(readme, /DATA_DIR=\.\/data-dev PORT=3000 npm run dev/);
});

test('the browser side never registers the service worker on a developer machine, and removes one an earlier build installed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('// The service worker (installability'));
  assert.match(block, /localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]/);
  assert.match(block, /getRegistrations\(\)\.then\(\(rs\) => Promise\.all\(rs\.map\(\(r\) => r\.unregister\(\)\)\)\)/);
  assert.match(block, /caches\.keys\(\)/);
  assert.match(block, /else navigator\.serviceWorker\.register\('\/sw\.js'\)/, 'any other host (the deployed app) still registers it');
});

test('a server that cannot get its port reports it, exits non-zero and never prints the "running" banner', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, r)); // dual-stack, like the app itself
  const port = blocker.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-port-test-'));
  try {
    const run = spawnSync(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, new RegExp(`Port ${port} is already in use`));
    assert.match(run.stderr, /lsof -nP -iTCP:/);
    assert.doesNotMatch(run.stdout, /running on/, 'no false success banner');
  } finally { blocker.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the dev server announces itself, and plain `npm start` outside production says it does not auto-restart', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  assert.match(src, /if \(DEV\) console\.log\('Dev mode: this server restarts itself/);
  assert.match(src, /npm_lifecycle_event === 'start' && process\.env\.NODE_ENV !== 'production'/);
  assert.match(src, /app\.listen\(PORT, \(err\) => \{\s*if \(err\) return;/);
});
