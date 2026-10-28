// PostgreSQL migration Slice 5B-3 on the TEMPORARY database driver seam (D-48): sign-in, the session store, the auth middleware and the
// people routes now reach SQLite through src/dataSeam. These tests pin the security behavior the conversion must not change, where the
// older suites (auth, people, employee-access, self-checkout) do not already: what a login stores and refuses, the session id renewed at
// sign-in, logout and expiry, the store finishing its work before the response, deactivation signing out ONLY that account, and the
// single-use reset / invite tokens. SQLite only; never sends email.
// The SQLite side of the temporary driver seam: it opens SQLite itself, so it does not run in the PostgreSQL pass (test/pg covers the PG side).
if (process.env.NC_TEST_DRIVER === 'pg') { require('node:test').test(`${require('path').basename(__filename)} (SQLite seam)`, { skip: 'SQLite seam; the PG side is covered by test/pg' }, () => {}); return; }
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { bootApp, startServer, stopServer, setupAdmin } = require('./helpers');
const { hashToken } = require('../src/tokenHash');

let server, db, base, admin, data;
before(async () => {
  const booted = bootApp();
  db = booted.db;
  server = await startServer(booted.app);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await setupAdmin(server)).client; // account 1 (Ada)
  data = require('../src/dataSeam').open({ db });
});
after(() => stopServer(server));

// One request with an explicit cookie (or none): the status, the body, and the session cookie the server set (if it set one).
async function call(method, url, { cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('nc_assets='));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie && setCookie.split(';')[0], setCookie };
}
const me = (cookie) => call('GET', '/api/me', { cookie });
const sidOf = (cookie) => decodeURIComponent(cookie.slice('nc_assets='.length)).slice(2).split('.')[0]; // s:<sid>.<signature>
const row = (sid) => db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
const sessionsOf = (accountId) => db.prepare('SELECT sid, sess FROM sessions').all().filter((r) => JSON.parse(r.sess).uid === accountId);

// An account with a chosen id (to test 1 vs 12 vs 100), its employee, and a known password.
const PW = 'seam-auth-password-1';
const HASH = bcrypt.hashSync(PW, 4);
function account(id, { role = 'employee' } = {}) {
  const email = `acct${id}@nutricost.com`;
  const employeeId = Number(db.prepare('INSERT INTO employees (name, work_email) VALUES (?, ?)').run(`Person ${id}`, email).lastInsertRowid);
  db.prepare('INSERT INTO accounts (id, employee_id, login_email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(id, employeeId, email, HASH, role);
  return { id, employeeId, email };
}
async function login(email, { password = PW, cookie } = {}) {
  const r = await call('POST', '/api/login', { cookie, body: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie;
}

test('setup only works once: afterwards it is refused and changes nothing', async () => {
  assert.deepEqual((await call('GET', '/api/setup-needed')).body, { needed: false });
  const accounts = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  const r = await call('POST', '/api/setup', { body: { name: 'Mallory', email: 'mallory@nutricost.com', password: 'mallory-password-1' } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Setup already completed' });
  assert.equal(r.cookie, undefined, 'no session');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts').get().c, accounts);
});

test('login: the session is stored before the answer arrives, with the same cookie, and later requests use it', async () => {
  const a = account(40);
  const before = Date.now();
  const r = await call('POST', '/api/login', { body: { email: a.email, password: PW } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.match(r.setCookie, /; Path=\//);
  assert.match(r.setCookie, /; HttpOnly/);
  assert.match(r.setCookie, /; SameSite=Lax/);
  assert.doesNotMatch(r.setCookie, /; Secure/, 'APP_URL is http:// in the tests');
  const stored = row(sidOf(r.cookie));
  assert.ok(stored, 'the session row exists as soon as the answer is in');
  assert.equal(JSON.parse(stored.sess).uid, a.id, 'the session identifies the ACCOUNT');
  assert.ok(stored.expires >= before + 30 * 864e5 - 5000 && stored.expires <= Date.now() + 30 * 864e5, '30-day session');
  assert.ok(db.prepare('SELECT last_login_at FROM accounts WHERE id = ?').get(a.id).last_login_at, 'the login is recorded');
  for (let i = 0; i < 2; i++) {
    const m = await me(r.cookie);
    assert.equal(m.status, 200);
    assert.equal(m.body.user.account_id, a.id);
  }
  // rolling: each answer renews the expiry (the store's touch), again before the answer arrives
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() + 60e3, sidOf(r.cookie));
  assert.equal((await me(r.cookie)).status, 200);
  assert.ok(row(sidOf(r.cookie)).expires > Date.now() + 29 * 864e5, 'the expiry was pushed out again');
});

test('login refusals: wrong password, unknown email, deactivated account, deactivated employee: one answer, no session', async () => {
  const wrong = account(41);
  const noLogin = account(42); db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(noLogin.id);
  const gone = account(43); db.prepare("UPDATE employees SET status = 'inactive' WHERE id = ?").run(gone.employeeId);
  const sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  for (const [email, password] of [[wrong.email, 'not-the-password'], ['nobody-here@nutricost.com', PW], [noLogin.email, PW], [gone.email, PW]]) {
    const r = await call('POST', '/api/login', { body: { email, password } });
    assert.equal(r.status, 401, email);
    assert.deepEqual(r.body, { error: 'Email or password is incorrect' }, email);
    assert.equal(r.cookie, undefined, `${email}: no session cookie`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, sessions, 'no session stored');
  // a session of a since-deactivated account or employee no longer signs anyone in
  const later = account(44);
  const cookie = await login(later.email);
  db.prepare("UPDATE employees SET status = 'inactive' WHERE id = ?").run(later.employeeId);
  assert.equal((await me(cookie)).status, 401);
  assert.deepEqual((await call('GET', '/api/assets', { cookie })).body, { error: 'Please sign in' });
});

test('login renews the session id: the session from before is destroyed, never reused', async () => {
  const a = account(45); const b = account(46);
  const first = await login(a.email);
  const second = await login(b.email, { cookie: first }); // signing in on a browser that already has a session
  assert.notEqual(sidOf(second), sidOf(first));
  assert.equal(row(sidOf(first)), undefined, 'the old session row is gone');
  assert.equal((await me(first)).status, 401, 'the old cookie signs nobody in');
  assert.equal((await me(second)).body.user.account_id, b.id);
});

test('logout deletes the stored session before answering; the old cookie no longer works', async () => {
  const a = account(47);
  const cookie = await login(a.email);
  const r = await call('POST', '/api/logout', { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.cookie, undefined, 'no new session is handed out');
  assert.equal(row(sidOf(cookie)), undefined, 'the row is gone as soon as the answer is in');
  assert.equal((await me(cookie)).status, 401);
});

test('an expired session is refused, and the purge deletes only expired sessions', async () => {
  const a = account(48); const b = account(49);
  const old = await login(a.email); const live = await login(b.email);
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() - 1000, sidOf(old));
  const r = await me(old);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Please sign in' });
  assert.equal(JSON.parse(row(sidOf(old)).sess).uid, a.id, 'refused, not revived (still the expired row)');
  assert.equal((await me(live)).status, 200);
  await data.sessions.purgeExpired(Date.now()); // what the hourly timer runs
  assert.equal(row(sidOf(old)), undefined, 'the expired session is purged');
  assert.ok(row(sidOf(live)), 'a live session is kept');
  assert.equal((await me(live)).status, 200);
});

test('password change: a wrong current password changes nothing; afterwards only the new password signs in, on a new session', async () => {
  const a = account(51);
  const cookie = await login(a.email);
  const wrong = await call('POST', '/api/me/password', { cookie, body: { current: 'not-it', password: 'brand-new-password-51' } });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { error: 'Current password is incorrect' });
  await login(a.email); // still the old one
  const ok = await call('POST', '/api/me/password', { cookie, body: { current: PW, password: 'brand-new-password-51' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/login', { body: { email: a.email, password: PW } })).status, 401, 'the old password is dead');
  await login(a.email, { password: 'brand-new-password-51' });
  // (security hardening 2026-10-27) the browser that changed it stays signed in on a NEW session id; the old id and every other session are gone
  assert.ok(ok.cookie && ok.cookie !== cookie);
  assert.equal((await me(ok.cookie)).status, 200);
  assert.equal((await me(cookie)).status, 401);
});

test('reset / invite tokens: a new one replaces the last of its kind, a forgot link never replaces an invite, a reset uses up every token of the account, expired ones do nothing', async () => {
  const a = account(52);
  const tokens = () => db.prepare('SELECT token, purpose, expires_at FROM tokens WHERE user_id = ? ORDER BY token').all(a.id);
  assert.equal((await admin.post(`/api/users/${a.employeeId}/invite`, {})).status, 200);
  const [invite1] = tokens();
  assert.equal((await admin.post(`/api/users/${a.employeeId}/invite`, {})).status, 200);
  const [invite2] = tokens();
  assert.equal(tokens().length, 1, 'one live token per purpose');
  assert.notEqual(invite2.token, invite1.token);
  assert.ok(Math.abs(Date.parse(invite2.expires_at) - (Date.now() + 7 * 864e5)) < 60e3, 'an invite lasts 7 days');
  assert.deepEqual((await call('POST', '/api/forgot', { body: { email: a.email } })).body, { ok: true });
  // (security hardening 2026-10-27) the forgot link has its own purpose: the pending invite stays valid beside it
  const reset = tokens().find((t) => t.purpose === 'forgot');
  const resetRaw = require('./helpers').inviteToken(db, a.id, 'forgot').token; // (tokens are stored hashed: swap in one the test knows)
  assert.deepEqual(tokens().map((t) => t.purpose).sort(), ['forgot', 'reset']);
  assert.ok(tokens().some((t) => t.token === invite2.token), 'the invite survives');
  assert.ok(Math.abs(Date.parse(reset.expires_at) - (Date.now() + 3600e3)) < 60e3, 'a reset link lasts 1 hour');
  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'other', ?)").run(hashToken('other-purpose-52'), a.id, reset.expires_at);

  const expiredLink = { error: 'This link has expired. Ask for a new one.' };
  assert.deepEqual((await call('POST', '/api/reset', { body: { token: invite1.token, password: 'replaced-password-52' } })).body, expiredLink, 'a replaced token is dead');
  const used = await call('POST', '/api/reset', { body: { token: resetRaw, password: 'reset-password-52' } });
  assert.equal(used.status, 200);
  assert.equal(JSON.parse(row(sidOf(used.cookie)).sess).uid, a.id, 'the reset signs the account in (stored before the answer)');
  assert.deepEqual(tokens(), [], 'every token of the account is gone');
  const again = await call('POST', '/api/reset', { body: { token: resetRaw, password: 'second-use-password' } });
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, expiredLink, 'single use');
  await login(a.email, { password: 'reset-password-52' });
  assert.equal((await call('POST', '/api/login', { body: { email: a.email, password: PW } })).status, 401);

  db.prepare("INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(hashToken('expired-52'), a.id, new Date(Date.now() - 1000).toISOString());
  const expired = await call('POST', '/api/reset', { body: { token: 'expired-52', password: 'never-applied-52' } });
  assert.deepEqual([expired.status, expired.body, expired.cookie], [400, expiredLink, undefined]);
  await login(a.email, { password: 'reset-password-52' }); // unchanged
});

test('a failing session store answers 500 (generic body) on load, sign-in and sign-out, as when it threw synchronously', async () => {
  const sessions = require('../src/sessions');
  const a = account(53);
  const cookie = await login(a.email);
  const realConsoleError = console.error;
  const generic = { error: 'Something went wrong. Please try again.' };
  for (const fn of ['get', 'destroy']) {
    const real = sessions[fn];
    sessions[fn] = () => { throw new Error(`disk I/O error (${fn})`); };
    console.error = () => {};
    try {
      const r = fn === 'get' ? await me(cookie) : await call('POST', '/api/logout', { cookie });
      assert.equal(r.status, 500, fn);
      assert.deepEqual(r.body, generic, fn);
      if (fn === 'destroy') {
        const relog = await call('POST', '/api/login', { cookie, body: { email: a.email, password: PW } }); // regenerate destroys first
        assert.equal(relog.status, 500);
        assert.deepEqual(relog.body, generic);
      }
    } finally { sessions[fn] = real; console.error = realConsoleError; }
  }
  assert.equal((await me(cookie)).status, 200, 'the failed logout left the session as it was (and said so)');
});

// Last: it deactivates Ada (account 1), the setup admin.
test('deactivating a person signs out ONLY their account (1 vs 12 vs 100 vs 112), on every device, for good', async () => {
  const actor = account(50, { role: 'admin' });
  const a12 = account(12); const a100 = account(100); const a112 = account(112);
  const ada = await login('ada@nutricost.com', { password: 'correct-horse-1' });
  const adaId = (await me(ada)).body.user.employee_id;
  const it = await login(actor.email);
  const c12 = [await login(a12.email), await login(a12.email)]; // two devices
  const c100 = await login(a100.email); const c112 = await login(a112.email);
  const deactivate = (employeeId, active = false) => call('PUT', `/api/users/${employeeId}`, { cookie: it, body: { active } });

  assert.equal((await deactivate(adaId)).status, 200);
  assert.equal(sessionsOf(1).length, 0, 'every session of account 1 is gone');
  assert.equal((await me(ada)).status, 401);
  for (const c of [...c12, c100, c112, it]) assert.equal((await me(c)).status, 200, 'accounts 12, 100, 112 and 50 stay signed in');

  assert.equal((await deactivate(a12.employeeId)).status, 200);
  assert.equal(sessionsOf(12).length, 0);
  for (const c of c12) assert.equal((await me(c)).status, 401);
  for (const c of [c100, c112, it]) assert.equal((await me(c)).status, 200, 'accounts 100, 112 and 50 stay signed in');

  // reactivating does not bring an old session back; editing an active person signs nobody out
  assert.equal((await deactivate(a12.employeeId, true)).status, 200);
  for (const c of c12) assert.equal((await me(c)).status, 401);
  assert.equal((await call('PUT', `/api/users/${a100.employeeId}`, { cookie: it, body: { name: 'Renamed 100' } })).status, 200);
  assert.equal((await me(c100)).status, 200);
  assert.equal(sessionsOf(100).length, 1);
});
