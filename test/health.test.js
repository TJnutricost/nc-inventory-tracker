// GET /health is the host's liveness probe: public, minimal, no session, and nothing about the deployment leaks through it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, makeClient } = require('./helpers');

test('/health answers 200 { ok: true } with no login, no session cookie and no extra detail', async () => {
  const { app, db } = bootApp();
  const server = await startServer(app);
  try {
    const c = makeClient(server);
    const r = await c.get('/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(r.headers.get('set-cookie'), null, 'a probe must not create a session');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'a probe must not write to the database');
    // still public after the first admin exists (the app is past setup)
    await c.post('/api/setup', { name: 'Ada Admin', email: 'ada@nutricost.com', password: 'correct-horse-1' });
    const anon = makeClient(server);
    const r2 = await anon.get('/health');
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body, { ok: true });
  } finally {
    await stopServer(server);
  }
});
