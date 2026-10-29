require('./env');
// TEMPORARY database driver seam (D-48; removed at the PostgreSQL cutover). DB_DRIVER is checked before anything opens a database:
// unset / 'sqlite' is the default; 'pg' (Slice 5D) runs on PostgreSQL; anything else stops the server with a clear error.
const dataSeam = require('./dataSeam');
const DB_DRIVER = dataSeam.resolveDriver();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
// Per driver. SQLite: src/db.js opens (and migrates) the database at require time; server.js takes only the handle, to bind it into the
// seam below, and the SQLite mailer. PostgreSQL (Slice 5D): the pool is created lazily (src/pg/pool.js, DATABASE_URL), nothing connects
// until boot() below migrates the schema; the mailer is the PostgreSQL one. Neither driver's code is loaded for the other.
// The settings are read and written through the seam (src/settings.js) since Slice 5B-4.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'); // (as src/db.js: uploads, tmp and the session secret live here for both drivers)
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
let db = null;
let pool = null;
let mailer;
if (DB_DRIVER === 'pg') {
  pool = require('./pg/pool').getPool();
  mailer = require('./pg/mailer').createPgMailer(pool);
} else {
  ({ db } = require('./db'));
  mailer = require('./mailer');
}
const { notify, APP_URL, mailConfigured, mailEnvelope, testRecipient } = mailer;
const { cleanSerial } = require('./serial');
const googleAuth = require('./googleAuth');
// The data modules with the database bound (`await data.waitlist.join({...})`). Since PostgreSQL migration Slice 5B-4 every route, the
// middleware, the session store and the timers reach the database ONLY through this (test/data-seam-ratchet.test.js); the modules' pure
// exports (constants, validators) are read through it too (`data.assignments.capacity`).
const data = dataSeam.open({ driver: DB_DRIVER, db, pool });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// Where photo files live: the volume (default) or a private S3 bucket when S3_BUCKET is set (src/photoStorage.js). Rows stay in the database.
const photoFiles = require('./photoStorage').fromEnv(process.env, UPLOAD_DIR);
const secureCookies = APP_URL.startsWith('https://');
if (process.env.NODE_ENV === 'production' && !secureCookies && !process.env.NC_NO_EXTERNAL_MAIL) {
  // Without an https APP_URL the session cookie is sent without Secure, HSTS is off and email links point at the wrong place.
  console.warn(`WARNING: APP_URL is ${APP_URL}. In production set it to the site's https address (e.g. https://it.nutricost.com).`);
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use('/api/import', express.text({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '2mb' }));
// A NUL character (U+0000) cannot be stored in PostgreSQL text, and no real input contains one: refuse it with a 400 before any route runs
// (Slice 5D-2, carry-over (as) / (at)), on both drivers, in the URL, a JSON body or a CSV body.
const hasNul = (v) => (typeof v === 'string' ? v.includes('\u0000')
  : Array.isArray(v) ? v.some(hasNul)
    : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => hasNul(k) || hasNul(x)) : false);
app.use('/api', (req, res, next) => (/%00/i.test(req.url) || hasNul(req.body) ? res.status(400).json({ error: 'That text contains a character that is not allowed.' }) : next()));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
// The Content-Security-Policy: our own scripts only (no inline script, no eval), so an HTML-escaping slip in the front end cannot
// run code. Inline style attributes are used throughout app.js, hence 'unsafe-inline' for styles only. blob:/data: images are
// photo previews and barcodes; blob: media is the camera scanner. HSTS only when the app is served over https (APP_URL).
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:", "media-src 'self' blob:",
  "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Liveness probe for the host's deployment health check. Deliberately before sessions and outside /api: no auth, no CSRF, no DB access, no diagnostics.
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// ---------- sessions (database-backed, through the seam) ----------
// The express-session store. Each method is ONE seam call (the SQL is in src/sessions.js since Slice 5B-3); the session's JSON, its
// expiry time and "an expired session is no session" stay here. The callback runs when the seam call settles (on SQLite a microtask,
// on PostgreSQL after the query; still before the response is written: express-session waits for save / touch / destroy before it ends
// the response). A failed call reaches the callback as its error. The same class serves both drivers (the PostgreSQL SQL is
// src/pg/sessions.js); the name is kept from before the seam.
class SqliteStore extends session.Store {
  get(sid, cb) {
    data.sessions.get(sid).then((row) => {
      let sess;
      try { sess = !row || row.expires < Date.now() ? null : JSON.parse(row.sess); } catch (err) { return cb(err); }
      cb(null, sess);
    }, cb);
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie?.maxAge ?? 30 * 864e5;
    data.sessions.set(sid, JSON.stringify(sess), Date.now() + maxAge).then(() => cb && cb(null), (err) => cb && cb(err));
  }
  destroy(sid, cb) { data.sessions.destroy(sid).then(() => cb && cb(null), (err) => cb && cb(err)); }
  // The rolling cookie only extends the expiry, and never re-creates a session row that was deleted meanwhile (deactivation, logout).
  touch(sid, sess, cb) {
    const maxAge = sess.cookie?.maxAge ?? 30 * 864e5;
    data.sessions.touch(sid, Date.now() + maxAge).then(() => cb && cb(null), (err) => cb && cb(err));
  }
}
setInterval(() => data.sessions.purgeExpired(Date.now()).catch((e) => console.error('[sessions:purge]', e.message)), 3600e3).unref();

let secret = process.env.SESSION_SECRET;
if (!secret) {
  const f = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  secret = fs.readFileSync(f, 'utf8').trim();
}
app.use(session({
  store: new SqliteStore(),
  secret,
  name: 'nc_assets',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 30 * 864e5 },
}));

// CSRF: state-changing API calls must come from our own fetch() (custom header can't be sent cross-site without CORS)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Bad request origin' });
  next();
});

// ---------- helpers ----------
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

// Identity model (Phase 1D): a session identifies an ACCOUNT (login + authorization; role lives here).
// An account optionally links to an EMPLOYEE (the person who holds equipment / makes requests).
// req.user deliberately has no plain `id`: use account_id when recording who ACTED, employee_id when
// referring to the PERSON (assignee / requester). The signed-in account: src/accounts.js currentUser (moved there verbatim in Slice 5B-3);
// the guards are async and reach it through the seam (Express 5 hands a rejection to the error handler).
async function auth(req, res, next) {
  const u = await data.accounts.currentUser(req.session.uid);
  if (!u) return res.status(401).json({ error: 'Please sign in' });
  req.user = u;
  next();
}
function admin(req, res, next) {
  return auth(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' })));
}
// The signed-in user as the UI sees it: `id` is the EMPLOYEE (person) id, null for an account with no employee record.
const publicMe = (u) => ({ first_name: u.first_name || null, last_name: u.last_name || null, can_self_checkout: !!u.can_self_checkout, id: u.employee_id, account_id: u.account_id, employee_id: u.employee_id, name: u.name, email: u.email, role: u.role, department: u.department, title: u.title, phone: u.phone, building: u.building || null, active: true, created_at: u.created_at, last_login_at: u.last_login_at, has_password: !!u.password_hash });

// A person (employee) with their optional account. `email` = where to reach them (work email, else login email). The SQL is in
// src/people.js (moved there verbatim in Slices 5B-2 and 5B-3).
const { HISTORY_LIMIT } = data.people;
const publicPerson = (p) => p && ({
  id: p.id, name: p.name, first_name: p.first_name || null, last_name: p.last_name || null, email: p.email, work_email: p.work_email, department: p.department, title: p.title, phone: p.phone,
  active: p.status === 'active', created_at: p.created_at,
  has_account: !!p.account_id, account_id: p.account_id || null, login_email: p.login_email || null,
  login_enabled: !!p.account_id && !!p.account_active, role: p.role || null,
  last_login_at: p.last_login_at || null, has_password: !!p.password_hash,
  can_self_checkout: !!p.can_self_checkout, building: p.building || null,
});
// First and last name are always separate (owner rule 2026-10-28); `name` stays as the display name, composed from them. A request that sends
// neither field is a legacy caller: `name` alone is accepted as it was and the parts stay NULL (a full name is never split). One part
// without the other is refused. Returns { name, firstName, lastName } or null when neither part was sent.
const NAME_MAX = 100;
function namePartsFrom(body) {
  const first = clean(body.first_name); const last = clean(body.last_name);
  if (!first && !last) return null;
  if (!first || !last) throw httpError(400, 'Enter both a first name and a last name');
  if (first.length > NAME_MAX || last.length > NAME_MAX) throw httpError(400, `A name can be at most ${NAME_MAX} characters`);
  return { name: `${first} ${last}`, firstName: first, lastName: last };
}
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const normEmail = (v) => { const c = clean(v); return c ? c.toLowerCase() : null; };

// The activity log (who did it: an account, shown by its employee's name or login email): src/activityLog.js (Slice 5B-2).

// Tokens belong to an ACCOUNT (password reset / invite); tokens.user_id holds the account id. A new token and its expiry (ISO string),
// generated here; storing it (replacing the account's previous one of the same purpose) is src/accounts.js replaceToken (Slice 5B-3).
function newToken(hours) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString();
  return { token, expiresAt };
}

// Serials are unique across the whole inventory (archived assets included) ignoring surrounding whitespace and letter case: see
// src/serial.js and src/assetRecords.js `assertSerialFree`. Asset tags: prefix + a number from a durable, ever-increasing counter
// (asset_tag_counter), claimed inside the asset's create transaction; `peekTag` only previews the next one (src/assetRecords.js).
// The employee asset-visibility contract, enforced on the server (hiding navigation is not access control): src/assetAccess.js.
const { capacity } = data.assignments;

// ---------- setup & auth ----------
// The SQL of these routes is in src/accounts.js and src/people.js (moved there verbatim in Slice 5B-3); bcrypt, the tokens, the session
// and the emails stay here, in the same order as before.
// A new session id for a sign-in (the old session is destroyed): no session id chosen before the sign-in survives it. The store
// answers asynchronously (Slice 5B-3), so a store failure reaches the error handler (a 500).
const newSession = (req) => new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
// Compared against when the email has no account or no password, so an unknown email takes as long as a wrong password.
const NO_ACCOUNT_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// The first-run setup makes whoever completes it the first admin, so on a fresh server it must not be open to anyone who finds the
// URL first. With SETUP_TOKEN set, the form needs that code; in production (NODE_ENV=production) without it, setup is closed (the
// first admin then comes from Google sign-in with GOOGLE_ADMIN_EMAILS, or IT sets SETUP_TOKEN). Local development is unchanged.
const setupRule = () => (process.env.SETUP_TOKEN ? 'code' : process.env.NODE_ENV === 'production' ? 'closed' : 'open');
const sameSecret = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); return crypto.timingSafeEqual(x, crypto.createHash('sha256').update(String(b)).digest()); };
app.get('/api/setup-needed', async (req, res) => {
  const needed = await data.accounts.accountCount() === 0;
  res.json(needed ? { needed, rule: setupRule() } : { needed });
});
app.post('/api/setup', wrap(async (req, res) => {
  if (await data.accounts.accountCount() > 0) throw httpError(400, 'Setup already completed');
  const rule = setupRule();
  if (rule === 'closed') throw httpError(403, 'Setup is turned off on this server. Ask whoever runs it to set SETUP_TOKEN, or sign in with Google.');
  if (rule === 'code' && !sameSecret(req.body.setup_code || '', process.env.SETUP_TOKEN)) throw httpError(403, 'The setup code is not correct.');
  const { email, password } = req.body;
  const parts = namePartsFrom(req.body);
  const name = parts ? parts.name : clean(req.body.name);
  if (!name || !clean(email) || !password || password.length < 8) throw httpError(400, 'First name, last name, email and a password of at least 8 characters are required');
  const hash = await bcrypt.hash(password, 10);
  const mail = normEmail(email);
  const accountId = await data.accounts.createFirstAdmin({ name, firstName: parts ? parts.firstName : null, lastName: parts ? parts.lastName : null, mail, hash });
  await newSession(req);
  req.session.uid = accountId;
  res.json({ ok: true });
}));

// Attempt counters, 15-minute windows (in memory: one instance). Login: 10 failures per IP and email, and 100 per IP across all emails
// (no password spraying over every colleague's address; a shared office IP still has room). Forgot-password: 20 requests per IP, and
// at most 3 emails per address (more are answered the same way but not sent).
const loginAttempts = new Map();
const WINDOW = 15 * 60e3;
const attempts = (key) => {
  let a = loginAttempts.get(key);
  if (!a || Date.now() - a.t > WINDOW) { a = { n: 0, t: Date.now() }; loginAttempts.set(key, a); }
  return a;
};
setInterval(() => { const old = Date.now() - WINDOW; for (const [k, a] of loginAttempts) if (a.t < old) loginAttempts.delete(k); }, WINDOW).unref();
app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${req.ip}|${email}`;
  const att = attempts(key);
  const ipAtt = attempts(`${req.ip}|*`);
  if (att.n >= 10 || ipAtt.n >= 100) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const u = await data.accounts.loginAccount(email);
  const matches = await bcrypt.compare(String(req.body.password || ''), u?.password_hash || NO_ACCOUNT_HASH);
  const ok = !!(u && u.password_hash && matches);
  if (!ok) { att.n++; ipAtt.n++; throw httpError(401, 'Email or password is incorrect'); }
  loginAttempts.delete(key);
  await data.accounts.recordLogin(u.id);
  await newSession(req);
  req.session.uid = u.id; // the session identifies the ACCOUNT
  res.json({ ok: true });
}));
// (The store answers asynchronously since Slice 5B-3: a failure to delete the session is a 500, as when the store threw synchronously,
// never an "ok" that leaves the session signed in.)
app.post('/api/logout', (req, res, next) => req.session.destroy((err) => (err ? next(err) : res.json({ ok: true }))));

app.get('/api/me', auth, async (req, res) => {
  const { it_email_name, it_contact_email, ...shared } = await data.settings.getSettings(); // the IT email identity is IT's to see (Settings), not part of every employee's session
  // the zone a new optional time's AM/PM default is read in (APP_TIMEZONE, else the server's own zone): display only
  let appTimezone = process.env.APP_TIMEZONE || '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: appTimezone || undefined }); } catch { appTimezone = ''; }
  appTimezone = appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  res.json({ user: publicMe(req.user), settings: req.user.role === 'admin' ? { ...shared, it_email_name, it_contact_email } : shared, mailConfigured: mailConfigured(), appTimezone });
});
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) throw httpError(400, 'New password must be at least 8 characters');
  if (req.user.password_hash && !(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw httpError(400, 'Current password is incorrect');
  await data.accounts.setPassword(req.user.account_id, await bcrypt.hash(password, 10));
  // A new password signs the account out everywhere else; this browser stays signed in on a new session.
  await data.sessions.destroyForAccount(req.user.account_id);
  await newSession(req);
  req.session.uid = req.user.account_id;
  res.json({ ok: true });
}));
// Everyone edits their own name, phone, department, job title and building (owner decision 2026-10-27; employees could not before). The
// email (the login) stays IT's, in People. Passwords are separate.
app.put('/api/me', auth, async (req, res) => {
  const { name, phone, department, title, building } = req.body;
  const parts = namePartsFrom(req.body);
  if (req.user.employee_id) {
    // as in People: the building keeps its value when the client doesn't send the field; an empty string clears it
    await data.people.updateOwnProfile(req.user.employee_id, { name: parts ? parts.name : clean(name), firstName: parts ? parts.firstName : null, lastName: parts ? parts.lastName : null, phone: clean(phone), department: clean(department), title: clean(title),
      building: building === undefined ? req.user.building : clean(building) });
  }
  res.json({ ok: true });
});

app.post('/api/forgot', async (req, res) => {
  if (attempts(`${req.ip}|forgot`).n++ >= 20) throw httpError(429, 'Too many requests. Try again in 15 minutes.');
  const email = String(req.body.email || '').trim().toLowerCase();
  const a = attempts(`forgot|${email}`).n++ < 3 ? await data.accounts.resetAccount(email) : null;
  if (a) {
    const t = newToken(1);
    // Its own purpose: a forgot-password link never replaces a pending 7-day invite (purpose 'reset'); either link works once,
    // and setting the password removes every token of the account (completeReset).
    await data.accounts.replaceToken(a.id, 'forgot', t.token, t.expiresAt);
    notify.passwordReset({ name: a.name, email: a.login_email }, `${APP_URL}/#/reset/${t.token}`);
  }
  res.json({ ok: true }); // never reveal whether an account exists
});
app.post('/api/reset', wrap(async (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const t = await data.accounts.getToken(String(token || ''));
  if (!t || t.expires_at < new Date().toISOString()) throw httpError(400, 'This link has expired. Ask for a new one.');
  await data.accounts.completeReset(t.user_id, await bcrypt.hash(password, 10)); // the new password, then every token of the account is gone
  await data.sessions.destroyForAccount(t.user_id); // signed out everywhere else, as after a password change
  await newSession(req);
  req.session.uid = t.user_id;
  res.json({ ok: true });
}));

// ---------- Google sign-in (D-10; docs/briefs/google-sign-in.md) ----------
// Beside the password login, off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. src/googleAuth.js talks to Google and checks
// its answer (a verified address of the company domain). The account: an active employee's work email with an active login
// (src/accounts.js googleAccount); on a first sign-in one is made, role 'employee' (provisionGoogleAccount; owner decision 2026-10-27),
// unless IT turned that person or login off. An address in GOOGLE_ADMIN_EMAILS is made an admin. A success signs in exactly as
// POST /api/login does. Plain browser navigations outside /api (Google redirects back with a GET),
// so the CSRF header check does not apply; `state` (single use, kept in the session) and PKCE protect the round trip instead.
const google = googleAuth.config();
const GOOGLE_CALLBACK = `${APP_URL}/auth/google/callback`;
app.get('/api/auth-options', (req, res) => res.json({ google: !!google }));
app.get('/auth/google', (req, res, next) => {
  if (!google) return res.status(404).end();
  const { url, pending } = googleAuth.start(google, GOOGLE_CALLBACK);
  req.session.google = pending;
  req.session.save((err) => (err ? next(err) : res.redirect(url)));
});
app.get('/auth/google/callback', wrap(async (req, res) => {
  if (!google) return res.status(404).end();
  const pending = req.session.google;
  delete req.session.google; // single use, whatever happens next
  // Refusals share POST /api/login's limiter (per IP: 10 failures, then 15 minutes), so refused callbacks cannot run unbounded.
  const key = `${req.ip}|google`;
  const att = attempts(key);
  const refuse = (code) => { att.n++; res.redirect(`/#/login?error=${code}`); };
  if (att.n >= 10) return res.redirect('/#/login?error=too_many');
  let who;
  try {
    who = await googleAuth.finish(google, { pending, query: req.query, redirectUri: GOOGLE_CALLBACK });
  } catch (e) {
    if (!e.signInCode) throw e;
    if (e.signInCode === 'google' || e.signInCode === 'token') console.error('[google sign-in]', e.signInCode, e.message);
    return refuse(e.signInCode);
  }
  const found = await data.accounts.googleAccount(who.email);
  const accountId = found ? found.id : await data.accounts.provisionGoogleAccount(who);
  if (!accountId) return refuse('no_access');
  if (google.admins.has(who.email) && await data.accounts.makeAdmin(accountId)) console.log('[google sign-in] made an admin by GOOGLE_ADMIN_EMAILS:', who.email);
  loginAttempts.delete(key);
  await data.accounts.recordLogin(accountId);
  await newSession(req);
  req.session.uid = accountId; // the session identifies the ACCOUNT, as after a password login
  res.redirect('/#/home');
}));

// ---------- people (employees, with their optional login account) ----------
// /api/users is kept as the compatibility surface for the People screen; ids in it are EMPLOYEE ids.
// Future rule (not implemented — no external auth yet): a verified external login may link to a pre-provisioned
// employee by normalized (trim + lowercase) work email only; unknown logins never create an employee and are blocked.
// Admin only. Employees get no directory: no employee screen needs other people's names (self-checkout and requests always
// act as the signed-in employee), so exposing one would only leak who works here. Employees read their own record via
// GET /api/users/:id (which already refuses anyone else's).
app.get('/api/users', admin, async (req, res) => {
  const rows = await data.people.listPeople();
  res.json(rows.map((r) => ({ ...publicPerson(r), asset_count: r.asset_count })));
});

// Creates the employee and, unless `login: false`, a linked login account (role admin|employee; legacy 'user' = employee).
app.post('/api/users', admin, async (req, res) => {
  const parts = namePartsFrom(req.body);
  const name = parts ? parts.name : clean(req.body.name); const email = normEmail(req.body.email);
  const wantsLogin = req.body.login !== false;
  if (!name) throw httpError(400, 'First name and last name are required');
  if (email ? !isEmail(email) : wantsLogin) throw httpError(400, wantsLogin ? 'Name and a valid email are required' : 'That email address is not valid');
  if (email && await data.people.workEmailTaken(email)) throw httpError(400, 'A person with that email already exists');
  if (email && wantsLogin && await data.people.loginEmailTaken(email)) throw httpError(400, 'A login with that email already exists');
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const id = await data.people.createPerson({
    name, firstName: parts ? parts.firstName : null, lastName: parts ? parts.lastName : null, email, department: clean(req.body.department), title: clean(req.body.title), phone: clean(req.body.phone), building: clean(req.body.building), wantsLogin, role,
  });
  const p = await data.people.getPerson(id);
  if (wantsLogin && req.body.invite !== false) {
    const t = newToken(24 * 7);
    await data.accounts.replaceToken(p.account_id, 'reset', t.token, t.expiresAt);
    notify.welcome({ name: p.name, email: p.login_email }, `${APP_URL}/#/reset/${t.token}`);
  }
  res.json(publicPerson(p));
});

// Give an existing employee a login. Links by explicit employee id; never creates a second employee.
app.post('/api/users/:id/account', admin, async (req, res) => {
  const p = await data.people.getPerson(Number(req.params.id));
  if (!p) throw httpError(404, 'Person not found');
  if (p.account_id) throw httpError(400, 'This person already has a login.');
  const email = normEmail(req.body.email) || p.work_email;
  if (!email || !isEmail(email)) throw httpError(400, 'A valid login email is required');
  if (await data.people.loginEmailTaken(email)) throw httpError(400, 'A login with that email already exists');
  if (email !== p.work_email && await data.people.workEmailTakenByOther(email, p.id)) throw httpError(400, 'That email belongs to another person');
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  await data.people.addAccount(p, { email, role });
  const q = await data.people.getPerson(p.id);
  if (req.body.invite !== false) {
    const t = newToken(24 * 7);
    await data.accounts.replaceToken(q.account_id, 'reset', t.token, t.expiresAt);
    notify.welcome({ name: q.name, email: q.login_email }, `${APP_URL}/#/reset/${t.token}`);
  }
  res.json(publicPerson(q));
});
app.get('/api/users/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role !== 'admin' && id !== req.user.employee_id) throw httpError(403, 'Not allowed');
  const u = await data.people.getPerson(id);
  if (!u) throw httpError(404, 'User not found');
  const { current, past } = await data.people.personAssignments(id);
  res.json({ user: publicPerson(u), current, past, history_limit: HISTORY_LIMIT });
});
// Updates the person and, when they have one, their account (role, login email, login enabled). Nothing here deletes a person.
app.put('/api/users/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const u = await data.people.getPerson(id);
  if (!u) throw httpError(404, 'User not found');
  const role = req.body.role === 'admin' ? 'admin' : (req.body.role === 'employee' || req.body.role === 'user') ? 'employee' : u.role;
  const active = req.body.active === undefined ? u.status === 'active' : !!req.body.active;
  if (u.account_id && u.account_id === req.user.account_id && (role !== 'admin' || !active)) throw httpError(400, "You can't remove your own admin access");
  const email = normEmail(req.body.email);
  if (email && !isEmail(email)) throw httpError(400, 'That email address is not valid');
  const workEmail = email || u.work_email;
  if (email && email !== u.work_email && await data.people.workEmailTakenByOther(email, id)) throw httpError(400, 'That email is already in use');
  const loginEmail = u.account_id ? (email || u.login_email) : null;
  if (u.account_id && loginEmail !== u.login_email && await data.people.loginEmailTakenByOther(loginEmail, u.account_id)) throw httpError(400, 'That email is already in use');
  // building keeps its value when the client doesn't send the field; an empty string clears it
  const building = req.body.building === undefined ? u.building : clean(req.body.building);
  // Names: both parts replace the name; neither keeps the record as it is (a legacy record stays without parts); a legacy-only `name` that
  // changes the display name makes any stored parts stale, so they are cleared rather than left disagreeing.
  const parts = namePartsFrom(req.body);
  let personNames = { name: u.name, firstName: u.first_name || null, lastName: u.last_name || null };
  if (parts) personNames = parts;
  else if (clean(req.body.name) && clean(req.body.name) !== u.name) personNames = { name: clean(req.body.name), firstName: null, lastName: null };
  await data.people.updatePerson({
    id, ...personNames, workEmail, department: clean(req.body.department), title: clean(req.body.title), phone: clean(req.body.phone),
    building, active, accountId: u.account_id, loginEmail, role,
  });
  if (!active && u.account_id) await data.sessions.destroyForAccount(u.account_id); // signed out everywhere (only this account's sessions)
  res.json(publicPerson(await data.people.getPerson(id)));
});
// Per-employee self-checkout permission (default on). Admin only; never touches the employee's other fields.
app.put('/api/users/:id/self-checkout', admin, async (req, res) => {
  const p = await data.people.getPerson(Number(req.params.id));
  if (!p) throw httpError(404, 'Person not found');
  if (typeof req.body.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
  await data.people.setSelfCheckout(p.id, req.body.enabled);
  res.json(publicPerson(await data.people.getPerson(p.id)));
});
app.post('/api/users/:id/invite', admin, async (req, res) => {
  const u = await data.people.getPerson(Number(req.params.id));
  if (!u) throw httpError(404, 'User not found');
  if (!u.account_id) throw httpError(400, 'This person has no login. Give them one first.');
  // Without email, local development hands the admin the link to pass on. Production never returns (or issues) a usable link because
  // email is missing: a misconfigured mail setup must not turn this response into a way to read invitation tokens.
  if (!mailConfigured() && process.env.NODE_ENV === 'production') throw httpError(503, 'Email is not set up on this server, so no invitation was sent. Ask whoever runs it to configure email.');
  const t = newToken(24 * 7);
  await data.accounts.replaceToken(u.account_id, 'reset', t.token, t.expiresAt);
  const link = `${APP_URL}/#/reset/${t.token}`;
  notify.welcome({ name: u.name, email: u.login_email }, link);
  res.json({ ok: true, link: mailConfigured() ? undefined : link });
});

// ---------- assets ----------
// Reading assets (the list, the asset page, the scan lookup, the fields a non-admin may see) lives in src/assetViews.js, writing them
// (tags, serials, create / edit / archive) in src/assetRecords.js, getting them back in src/assetCustody.js: all moved there verbatim in
// Slice 5B-2. The routes check the request, call the seam and send the emails.

// Employees get ONE meaning for this list — "equipment I can get" (the shared pool, not their own); the status / holder filters are
// IT's tools and are ignored for employees. The query and its rules: src/assetViews.js listAssets.
app.get('/api/assets', auth, async (req, res) => {
  res.json(await data.assetViews.listAssets(req.user, req.query));
});

// Availability calendar (read-only): ?node=<catalog id> | ?asset=<asset id> | neither (everything), &month=YYYY-MM. The scope rules,
// the privacy narrowing for employees and the day states all live in src/availability.js. Not a way around asset visibility:
// GET /api/assets/:id is unchanged and employees still cannot open assets held by someone else.
app.get('/api/availability', auth, async (req, res) => {
  const q = req.query;
  res.json(await data.availability.availability({
    isAdmin: req.user.role === 'admin', employeeId: req.user.employee_id || null,
    nodeId: q.node === undefined || q.node === '' ? undefined : q.node,
    assetId: q.asset === undefined || q.asset === '' ? undefined : q.asset,
    month: typeof q.month === 'string' ? q.month : undefined,
    canReserve: req.user.role !== 'admin' && !!req.user.employee_id, // (not tied to self-checkout permission) only the single-asset view acts on it
  }));
});

app.get('/api/assets/lookup/:code', auth, async (req, res) => {
  // The scanner is for IT and for employees with the self-checkout permission (docs/briefs/employee-csv-import.md); nobody else may use it.
  if (req.user.role !== 'admin' && !req.user.can_self_checkout) throw httpError(403, 'Scanning is not enabled for your account. Browse equipment or ask IT.');
  const code = String(req.params.code).trim();
  // The tag (any letter case), else the normalized serial (src/assetViews.js lookupCode). Archived assets are still found (their tags
  // stay reserved); the flag lets clients say so.
  const a = await data.assetViews.lookupCode(code);
  // An employee only gets an id for assets they may open; for any other existing asset they learn just that it isn't
  // available (no id, no details), so the scanner can say so without exposing the record.
  if (a && !(await data.assetAccess.canViewAsset(req.user, await data.assetAccess.getAsset(a.id)))) return res.json({ found: false, unavailable: true, code });
  if (a) return res.json({ found: true, id: a.id, archived: !!a.archived_at });
  // IT only: a label we printed before its asset existed (Create labels, the Add asset form's Print label) opens Add asset with it.
  const issued = req.user.role === 'admin' ? await data.assetRecords.issuedTag(code) : null;
  res.json(issued ? { found: false, code, issued } : { found: false, code });
});

// Create labels / the Add asset form's Print label (docs/briefs/labels-and-assets.md): claims the next `count` tags from the counter, so
// the printed labels are never issued to another asset. Nothing else is written; the assets are added later by scanning the labels.
app.post('/api/tags/claim', admin, async (req, res) => {
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 300) throw httpError(400, 'Choose between 1 and 300 labels');
  const { tag_prefix } = await data.settings.getSettings();
  res.json({ tags: await data.assetRecords.claimTags({ prefix: tag_prefix, count }) });
});
// Create labels, when the sheet did not print or is not wanted: the claimed tags go back, so the next claim issues them again. Refused
// (409, nothing changed) once newer numbers were issued after them or one of them is on an asset: then the printed labels stay usable.
const RELEASE_REFUSED = {
  newer: 'Newer numbers were reserved after these, so they can no longer be given back. The printed labels still work: scan one to add its asset.',
  used: 'One of these labels is already on an asset, so the numbers can no longer be given back.',
  not_ours: 'These are not labels created here.',
};
app.post('/api/tags/release', admin, async (req, res) => {
  const tags = req.body.tags;
  if (!Array.isArray(tags) || !tags.length || tags.length > 300 || tags.some((t) => typeof t !== 'string')) throw httpError(400, 'Send the list of tags to give back');
  // Which prefix each tag was issued under is the claim's own record, not the current setting (the prefix may have changed since).
  const r = await data.assetRecords.releaseTags({ tags });
  if (!r.released) throw httpError(409, RELEASE_REFUSED[r.reason]);
  res.json({ released: tags.length });
});

// Preview only: creating an asset with a blank tag claims a number server-side, which may differ if others create first.
// (The `tag_prefix` setting, the counter and the taken-tag check: src/assetRecords.js peekTag, moved there verbatim in Slice 5B-4.)
// `?prefix=` previews an unsaved prefix (Create labels' draft) and changes nothing.
app.get('/api/next-tag', admin, async (req, res) => {
  const draft = typeof req.query.prefix === 'string' ? req.query.prefix.trim().slice(0, 10) : '';
  res.json({ tag: await data.assetRecords.peekTag(...(draft ? [draft] : [])) });
});

// The asset page: holders, photos, live requests and reservations, the employee's own waitlist places, IT's activity (src/assetViews.js
// assetDetail), for an asset this user may see (a 404 otherwise: src/assetAccess.js visibleAsset).
app.get('/api/assets/:id', auth, async (req, res) => {
  const a = await data.assetAccess.visibleAsset(req.user, req.params.id);
  res.json(await data.assetViews.assetDetail(req.user, a));
});

// The two per-asset reservation settings (admin only). Strictly boolean-ish so a typo can't silently turn something on.
const { FLAGS, ASSET_FIELDS } = data.assetRecords;
function flagValue(body, key, current) {
  const v = body[key];
  if (v === undefined) return current ? 1 : 0;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw httpError(400, `${key === 'available_to_request' ? 'Available to request' : 'Require approval for reservations'} must be on or off`);
}
function assetValues(body) {
  const v = {};
  for (const f of ['category', 'location']) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') throw httpError(400, `${f === 'category' ? 'Category' : 'Location'} must be text`);
  }
  if (body.serial !== undefined && body.serial !== null && !['string', 'number'].includes(typeof body.serial)) throw httpError(400, 'Serial number must be text');
  for (const f of ASSET_FIELDS) v[f] = ['purchase_cost', 'license_seats'].includes(f) ? num(body[f]) : clean(body[f]);
  v.serial = cleanSerial(body.serial); // trimmed; blank => no serial
  // Seats are a whole number that fits the database integer (Slice 5D-2, carry-over (au)): 2.5 or 1e10 is refused, never rounded. (Not a
  // number at all, NaN, stays NULL as before.)
  if (Number.isFinite(v.license_seats) ? !Number.isInteger(v.license_seats) || v.license_seats < 0 || v.license_seats > 2147483647 : v.license_seats === Infinity || v.license_seats === -Infinity) throw httpError(400, 'Seats must be a whole number (0 to 2,147,483,647)');
  return v;
}

// The catalog entry for an asset write (not in the body => unchanged; null/'' => unlinked; otherwise a live entry, or the asset's
// current one): src/assetRecords.js resolveAssetNode.

app.post('/api/assets', admin, async (req, res) => {
  const v = assetValues(req.body);
  if (!v.name) throw httpError(400, 'Give the asset a name');
  v.category = v.category || 'Other';
  v.condition = v.condition || 'Good';
  // No entry chosen: file the asset under the live top-level category its category text names (the same rule the migration
  // applied to existing assets), so a category's contents are complete. An unknown category is left unlinked — never invented.
  const nodeId = (await data.assetRecords.resolveAssetNode(req.body, null)) ?? (await data.catalog.findLiveByPath(v.category));
  if (nodeId !== null) v.category = (await data.catalog.rootOf(nodeId)).name; // the category text always follows the catalog root
  const status = ['maintenance', 'retired', 'lost'].includes(req.body.status) ? req.body.status : 'available';
  const flags = FLAGS.map((f) => flagValue(req.body, f, 0)); // both default OFF
  // Number claim + insert are one transaction: a failed create rolls the counter back, and two creates can't share a tag
  // (src/assetRecords.js createAsset). A blank tag issues the next number with the `tag_prefix` setting, read through the seam just
  // before the transaction (on SQLite in the same event-loop turn as the transaction, so the same value as when it was read inside it).
  const tag = clean(req.body.tag);
  const id = await data.assetRecords.createAsset({ tag, tagPrefix: tag ? null : (await data.settings.getSettings()).tag_prefix, status, nodeId, flags, v, actorAccountId: req.user.account_id });
  res.json(await data.assetAccess.getAsset(id));
});

app.put('/api/assets/:id', admin, async (req, res) => {
  const a = await data.assetAccess.getAsset(Number(req.params.id));
  if (!a) throw httpError(404, 'Asset not found');
  if (a.archived_at) throw httpError(400, 'This asset is archived and can\'t be edited.');
  const v = assetValues({ ...a, ...req.body });
  const nodeId = await data.assetRecords.resolveAssetNode(req.body, a.catalog_node_id);
  if (nodeId !== null) v.category = (await data.catalog.rootOf(nodeId)).name;
  // Asset tags are immutable once created (a case-only difference is ignored). No retag workflow exists yet.
  const sentTag = clean(req.body.tag);
  if (sentTag && sentTag.toLowerCase() !== a.tag.toLowerCase()) throw httpError(400, "An asset's tag can't be changed once it's created.");
  const tag = a.tag;
  const flags = FLAGS.map((f) => flagValue(req.body, f, a[f]));
  let status = a.status;
  if (req.body.status && req.body.status !== a.status) {
    const open = (await data.assetViews.openAssignments(a.id)).length;
    if (['maintenance', 'retired', 'lost', 'disposed'].includes(req.body.status)) {
      // `lost` may stay assigned (keeps accountability); the other states need the assignment resolved first.
      if (open && req.body.status !== 'lost') {
        throw httpError(400, ['retired', 'disposed'].includes(req.body.status)
          ? `Check this asset in before marking it ${req.body.status}.` : 'Check this asset in before changing its status');
      }
      status = req.body.status;
    } else if (['available', 'checked_out'].includes(req.body.status)) status = open >= capacity({ ...a, ...v }) ? 'checked_out' : 'available';
  }
  // The serial check and the update are one immediate transaction (src/assetRecords.js updateAsset); the edit is logged and the status
  // refreshed after it, as before.
  await data.assetRecords.updateAsset({ id: a.id, tag, status, nodeId, flags, v });
  const changed = ['tag', 'status', ...ASSET_FIELDS].filter((f) => String((f === 'tag' ? tag : f === 'status' ? status : v[f]) ?? '') !== String(a[f] ?? ''));
  if ((a.catalog_node_id ?? null) !== nodeId) changed.push('catalog');
  FLAGS.forEach((f, i) => { if (flags[i] !== (a[f] ? 1 : 0)) changed.push(f === 'available_to_request' ? `available to request ${flags[i] ? 'on' : 'off'}` : `reservation approval ${flags[i] ? 'required' : 'not required'}`); });
  if (changed.length) await data.activityLog.log(a.id, req.user.account_id, 'edited', changed.filter((f) => f !== 'license_key').join(', ') || 'license key');
  await data.assignments.refreshStatus(a.id);
  res.json(await data.assetAccess.getAsset(a.id));
});

// Assets are never permanently deleted: "delete" archives. The row, tag, assignments, activity, photos and
// requests all remain, and the tag stays reserved. The DELETE route is kept as an alias for compatibility.
// (The checks and the archive transaction: src/assetRecords.js archiveAsset.)
app.post('/api/assets/:id/archive', admin, async (req, res) => {
  await data.assetRecords.archiveAsset(req.params.id, { actorAccountId: req.user.account_id, reason: clean(req.body && req.body.reason) });
  res.json({ ok: true });
});
app.delete('/api/assets/:id', admin, async (req, res) => {
  await data.assetRecords.archiveAsset(req.params.id, { actorAccountId: req.user.account_id, reason: clean(req.body && req.body.reason) });
  res.json({ ok: true });
});

app.post('/api/assets/:id/checkout', auth, async (req, res) => {
  const asset = await data.assetAccess.visibleAsset(req.user, req.params.id);
  let target;
  if (req.user.role === 'admin') {
    target = await data.people.getPerson(Number(req.body.employee_id || req.body.user_id)); // user_id kept as a compatibility alias
    if (!target || target.status !== 'active') throw httpError(400, 'Choose who this is going to');
  } else {
    target = req.user.employee_id && await data.people.getPerson(req.user.employee_id);
    if (!target) throw httpError(403, "Your login isn't linked to an employee record. Ask IT.");
    // Permission is per employee (admin-controlled, default on). The old global setting is deprecated and ignored.
    if (!target.can_self_checkout) throw httpError(403, 'Self-checkout is not enabled for your account. Please request this item from IT.');
  }
  // Permanent assignments are admin-only (also enforced in createAssignment). A non-admin self check-out is always a
  // temporary checkout; explicitly asking for permanent is refused rather than silently changed.
  const assignment_type = req.user.role === 'admin' ? req.body.assignment_type : (req.body.assignment_type || 'checkout');
  // `target` = the employee receiving the asset; the signed-in account performs it. The capacity check + insert + activity row are one
  // immediate transaction (see assignments.js); the emails follow it. (Until Slice 5B-2 this was the server.js helper doCheckout.)
  const { assignment } = await data.assignments.createAssignment({
    assetId: asset.id, employeeId: target.id, actorAccountId: req.user.account_id, actorIsAdmin: req.user.role === 'admin',
    type: assignment_type, dueDate: req.body.due_date, dueTime: req.body.due_time, notes: req.body.notes, condition: req.body.condition,
  });
  notify.checkedOut(target, await data.assetAccess.getAsset(asset.id), assignment);
  if (req.user.employee_id === target.id && req.user.role !== 'admin') notify.selfCheckoutToAdmins(target, asset);
  // Close the employee's open equipment request for this asset — unless it asked for a permanent assignment and this
  // was a temporary checkout (a loan must not silently complete a request for something else). Not in the check-out's
  // transaction: existing debt, kept as is (D-48 point 8).
  await data.requests.completeEquipmentRequests({ employeeId: target.id, assetId: asset.id, assignmentType: assignment.assignment_type, actorAccountId: req.user.account_id, actorIsAdmin: req.user.role === 'admin' });
  res.json({ ok: true, assignment });
});

app.post('/api/assets/:id/checkin', admin, async (req, res) => {
  const asset = await data.assetAccess.getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const open = await data.assetViews.openAssignments(asset.id);
  if (!open.length) throw httpError(400, 'This asset is not checked out');
  const target = req.body.assignment_id ? open.find((o) => o.id === Number(req.body.assignment_id)) : open.length === 1 ? open[0] : null;
  if (!target) throw httpError(400, 'Choose which person is returning it');
  const condition = clean(req.body.condition);
  // Ending the assignment and completing the employee's return request succeed or fail together, and the freed time goes to the
  // waitlist in the same transaction (src/assetCustody.js checkin).
  await data.assetCustody.checkin({ asset, target, actorAccountId: req.user.account_id, condition, notes: clean(req.body.notes), toMaintenance: req.body.to_maintenance, location: clean(req.body.location) });
  await data.waitlist.dispatchHoldEmails();
  await data.activityLog.log(asset.id, req.user.account_id, 'checked_in', `From ${target.user_name} · ${data.assignments.TYPE_LABEL[target.assignment_type]}${target.due_date ? ` · return was due ${data.assignments.returnBy(target.due_date, target.due_time)}` : ''}${condition ? ` · condition ${condition}` : ''}${req.body.notes ? ` · ${req.body.notes}` : ''}`, target.employee_id);
  notify.checkedIn({ name: target.user_name, email: target.user_email }, asset);
  res.json({ ok: true });
});

app.post('/api/assets/:id/request-return', admin, async (req, res) => {
  const asset = await data.assetAccess.getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const open = await data.assetViews.openAssignments(asset.id);
  const wanted = req.body.employee_id || req.body.user_id; // user_id kept as a compatibility alias
  const targets = wanted ? open.filter((o) => o.employee_id === Number(wanted)) : open;
  if (!targets.length) throw httpError(400, 'Nobody currently has this asset');
  const created = [];
  for (const t of targets) {
    // the request + its activity row (src/assetCustody.js requestReturnFrom); null: one is already live for this holder
    const r = await data.assetCustody.requestReturnFrom({ asset, holder: t, message: clean(req.body.message), neededBy: clean(req.body.needed_by), actorAccountId: req.user.account_id });
    if (!r) continue;
    notify.returnRequested({ name: t.user_name, email: t.user_email }, asset, r);
    created.push(r);
  }
  if (!created.length) throw httpError(400, 'A return has already been requested');
  res.json({ ok: true, created: created.length });
});

// ---------- photos ----------
const PHOTO_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'gif', 'tiff']);
const upload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
// (Only the photo rows are in src/photoRecords.js, moved there verbatim in Slice 5B-2; the files go through src/photoStorage.js.)
app.post('/api/assets/:id/photos', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const cleanup = () => (req.files || []).forEach((f) => fs.rm(f.path, () => {}));
  // multer has already stored the uploads in the temp directory: a NUL in a text field (the caption) is refused before anything permanent
  // is made (the JSON guard above does not see multipart fields).
  if (hasNul(req.body)) { cleanup(); throw httpError(400, 'That text contains a character that is not allowed.'); }
  const asset = await data.assetAccess.getAsset(Number(req.params.id));
  if (!asset || !(await data.assetAccess.canViewAsset(req.user, asset))) { cleanup(); throw httpError(404, 'Asset not found'); }
  const holder = await data.assetAccess.holdsAsset(asset.id, req.user.employee_id);
  if (req.user.role !== 'admin' && !holder) { cleanup(); throw httpError(403, 'Only IT or the person holding this asset can add photos'); }
  if (!req.files?.length) throw httpError(400, 'No image received');
  const saved = []; const unreadable = []; const notStored = [];
  for (const f of req.files) {
    const label = f.originalname || 'photo';
    const base = `${asset.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    let full; let thumb;
    try { // the real image content is decoded here (the declared type is not trusted); rotate() applies the orientation, and no metadata is kept
      // Only photo formats reach the decoders (no SVG, PDF or other exotic inputs), and at most 100 megapixels (a 48 MP phone photo fits).
      const img = () => sharp(f.path, { limitInputPixels: 100e6 });
      if (!PHOTO_FORMATS.has((await img().metadata()).format)) throw new Error('not a photo format');
      full = await img().rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      thumb = await img().rotate().resize({ width: 400, height: 400, fit: 'cover' }).jpeg({ quality: 75 }).toBuffer();
    } catch (e) { unreadable.push(label); continue; } finally { fs.rm(f.path, () => {}); }
    try {
      await photoFiles.put(base + '.jpg', full);
      await photoFiles.put(base + '_t.jpg', thumb);
      saved.push(await data.photoRecords.addPhoto({ assetId: asset.id, filename: base + '.jpg', thumb: base + '_t.jpg', caption: clean(req.body.caption), uploadedBy: req.user.account_id }));
    } catch (e) { // no photo row without its files, and no files without their row
      console.error(`[photos] could not store ${label} for asset ${asset.id}:`, e.message);
      notStored.push(label);
      await Promise.all([base + '.jpg', base + '_t.jpg'].map((n) => photoFiles.remove(n).catch(() => {})));
    }
  }
  if (!saved.length) throw httpError(notStored.length ? 502 : 400, notStored.length ? 'Photo storage is unavailable right now, so nothing was saved. Please try again.' : "Couldn't read that image");
  await data.activityLog.log(asset.id, req.user.account_id, 'photo_added', `${saved.length} photo${saved.length > 1 ? 's' : ''}`);
  await data.photoRecords.touchAsset(asset.id);
  res.json({ ok: true, ids: saved, failed: [...unreadable, ...notStored] }); // a partly failed upload says which photos were not saved
}));
app.delete('/api/photos/:id', admin, async (req, res) => {
  const p = await data.photoRecords.getPhoto(Number(req.params.id));
  if (!p) throw httpError(404, 'Photo not found');
  await data.photoRecords.deletePhoto(p.id); // the row (and any cover that pointed at it) first: a failed file removal leaves an unlisted file, never a broken photo
  for (const f of [p.filename, p.thumb]) photoFiles.remove(f).catch((e) => console.error(`[photos] could not remove ${f}:`, e.message));
  res.json({ ok: true });
});
app.put('/api/assets/:id/cover', admin, async (req, res) => {
  const asset = await data.assetAccess.getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const raw = req.body.photo_id;
  let photoId = null; // null/empty clears the cover
  if (raw !== undefined && raw !== null && raw !== '') {
    photoId = Number(raw);
    if (!Number.isInteger(photoId) || photoId < 1) throw httpError(400, 'Choose a valid photo');
    const photo = await data.photoRecords.photoAsset(photoId);
    if (!photo) throw httpError(404, 'Photo not found');
    if (photo.asset_id !== asset.id) throw httpError(400, 'That photo belongs to a different asset');
  }
  await data.photoRecords.setCover(asset.id, photoId);
  res.json({ ok: true });
});
// Photo files follow the asset's visibility: an employee can fetch a photo only if its asset is one they may see. (The signed-in
// account comes from the session, read through the seam like the auth middleware since Slice 5B-3.) The file is then streamed from
// the photo store: the bucket stays private and its address and credentials never reach the browser.
app.use('/uploads', async (req, res) => {
  const u = await data.accounts.currentUser(req.session.uid);
  if (!u) return res.status(401).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  let file; try { file = path.basename(decodeURIComponent(req.path)); } catch { return res.status(404).end(); }
  if (u.role !== 'admin') {
    const photo = await data.photoRecords.photoByFile(file);
    if (!photo || !(await data.assetAccess.canViewAsset(u, await data.assetAccess.getAsset(photo.asset_id)))) return res.status(404).end();
  }
  let f;
  try { f = await photoFiles.get(file); } catch (e) { console.error(`[photos] could not read ${file}:`, e.message); return res.status(502).end(); }
  if (!f) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=2592000, immutable' });
  if (f.length !== undefined) res.set('Content-Length', String(f.length));
  f.body.on('error', () => res.destroy());
  f.body.pipe(res);
});

// ---------- reservations (Phase 2, slice 7) ----------
// Rules, transactions and conflict checks live in src/reservations.js. These routes only identify the caller and shape the answers.
// Employees reserve through the same visibility contract as everything else (an asset they can't see is a 404), and only manage their own.
// How a reservation is shown (`phase`, `can_cancel`, `can_shorten`, ...) and the reservation list live in src/reservationViews.js
// (moved there verbatim in Slices 5B-1 and 5B-2).
// Several reads in a row, in order, stopping at the first failure (exactly like the synchronous .map they replace).
async function mapInOrder(items, fn) { const out = []; for (const x of items) out.push(await fn(x)); return out; }
app.get('/api/reservations', auth, async (req, res) => {
  const st = req.query.status;
  if (st !== undefined && !['open', 'closed'].includes(st)) throw httpError(400, 'Status must be open or closed');
  res.json(await data.reservationViews.listReservations(req.user, st));
});
// Who may reserve which asset: src/assetAccess.js `reservableAsset` (moved there verbatim in Slice 5B-1).
app.post('/api/assets/:id/reservations', auth, async (req, res) => {
  const asset = await data.assetAccess.reservableAsset(req.user, req.params.id);
  // One request -> the free time reserved and the unavailable time waitlisted (src/reservations.js create). The answer says what each part became.
  const r = await data.reservations.create({
    assetId: asset.id, employeeId: req.user.employee_id, actorAccountId: req.user.account_id,
    start: req.body.start_date, end: req.body.end_date, startTime: req.body.start_time, endTime: req.body.end_time,
  });
  res.json({ request_group: r.request_group, requested: r.requested, reserved: await mapInOrder(r.reserved, (x) => data.reservationViews.reservationById(x.id, req.user)), waitlisted: await mapInOrder(r.waitlisted, (w) => data.waitlist.get(w.id, req.user)) });
});
app.post('/api/reservations/:id/approve', admin, async (req, res) => {
  const r = await data.reservations.approve(Number(req.params.id), { actorAccountId: req.user.account_id, note: clean(req.body.note) });
  res.json(await data.reservationViews.reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/decline', admin, async (req, res) => {
  const r = await data.reservations.decline(Number(req.params.id), { actorAccountId: req.user.account_id, note: clean(req.body.note) });
  await data.waitlist.dispatchHoldEmails(); // (declining may have offered the dates to the next person in line)
  res.json(await data.reservationViews.reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/cancel', auth, async (req, res) => {
  const r = await data.reservations.cancel(Number(req.params.id), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, isAdmin: req.user.role === 'admin' });
  await data.waitlist.dispatchHoldEmails();
  res.json(await data.reservationViews.reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/shorten', auth, async (req, res) => {
  const r = await data.reservations.shorten(Number(req.params.id), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, newEnd: req.body.end_date, newEndTime: req.body.end_time });
  await data.waitlist.dispatchHoldEmails();
  res.json(await data.reservationViews.reservationById(r.id, req.user));
});

// ---------- waitlist + availability holds (Phase 2, slice 8) ----------
// Rules live in src/waitlist.js. There is deliberately NO route that asks, or lets anyone ask, a current reserver to give anything up.
// An employee manages only their own entries; IT can see every entry and remove one, never reorder or answer for the employee.
// "What would happen if I asked for these dates?" for the date sheet: reserve (all free), waitlist (blocked by a reservation / hold) or a refusal. Writes nothing.
app.get('/api/assets/:id/range-check', auth, async (req, res) => {
  const asset = await data.assetAccess.reservableAsset(req.user, req.params.id);
  res.json(await data.waitlist.rangeCheck({ assetId: asset.id, employeeId: req.user.employee_id, start: req.query.start_date, end: req.query.end_date, startTime: req.query.start_time, endTime: req.query.end_time, excludeEntryId: Number(req.query.entry_id) || 0 }));
});
app.get('/api/reservation-counts', auth, async (req, res) => res.json(await data.waitlist.counts(req.user)));
app.put('/api/waitlist/:id', auth, async (req, res) => {
  const e = await data.waitlist.updateDates(Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id, start: req.body.start_date, end: req.body.end_date, startTime: req.body.start_time, endTime: req.body.end_time });
  res.json(await data.waitlist.get(e.id, req.user));
});
app.post('/api/assets/:id/waitlist', auth, async (req, res) => {
  const asset = await data.assetAccess.reservableAsset(req.user, req.params.id);
  const { entry } = await data.waitlist.join({ assetId: asset.id, employeeId: req.user.employee_id, actorAccountId: req.user.account_id, start: req.body.start_date, end: req.body.end_date, startTime: req.body.start_time, endTime: req.body.end_time });
  res.json(await data.waitlist.get(entry.id, req.user));
});
app.get('/api/waitlist', auth, async (req, res) => res.json(await data.waitlist.list(req.user, { status: req.query.status })));
app.get('/api/waitlist/:id', auth, async (req, res) => res.json(await data.waitlist.get(Number(req.params.id), req.user)));
app.post('/api/waitlist/:id/confirm', auth, async (req, res) => {
  const { entry, reservation } = await data.waitlist.confirmHold(Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id });
  res.json({ entry: await data.waitlist.get(entry.id, req.user), reservation: await data.reservationViews.reservationById(reservation.id, req.user) });
});
app.post('/api/waitlist/:id/decline', auth, async (req, res) => {
  const e = await data.waitlist.declineHold(Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id });
  res.json(await data.waitlist.get(e.id, req.user));
});
app.post('/api/waitlist/:id/cancel', auth, async (req, res) => {
  const e = await data.waitlist.leave(Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id, isAdmin: req.user.role === 'admin' });
  res.json(await data.waitlist.get(e.id, req.user));
});

// ---------- equipment catalog ----------
// One tree, one API, for every screen (phone drill-down, desktop columns, the asset form, the admin editor).
// Employees get only LIVE entries (not archived, no archived ancestor) and no admin-only counts; admins can ask for everything.
// The tree and IT's catalog search live in src/catalogViews.js (moved there verbatim in Slice 5B-2).
// IT's catalog search: entries whose name, whole path or search keywords (own + ancestors') contain every word typed, shallowest first, each with its full path so
// an ambiguous match (an "EOS R5" under Camera > Canon) makes sense. Archived entries are included and flagged. Admin only.
app.get('/api/catalog/search', admin, async (req, res) => {
  const tokens = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return res.json({ total: 0, results: [] });
  res.json(await data.catalogViews.searchCatalog(tokens));
});
app.get('/api/catalog', auth, async (req, res) => {
  res.json(await data.catalogViews.catalogTree(req.user, req.query.include_archived));
});
// IT's catalog edits: the transactions, the category sync after a rename or move (assets.category follows the catalog root) and the entry
// as the editor gets it back live in src/catalogAdmin.js (moved there verbatim in Slice 5B-1).
app.post('/api/catalog', admin, async (req, res) => {
  const parentId = data.catalog.parseParent(req.body.parent_id);
  const id = await data.catalogAdmin.createNode({ name: req.body.name, parentId: parentId ?? null, searchKeywords: req.body.search_keywords });
  res.json(await data.catalogAdmin.catalogOut(id));
});
app.put('/api/catalog/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  await data.catalogAdmin.updateNode(id, { name: req.body.name, parent: req.body.parent_id, searchKeywords: req.body.search_keywords });
  res.json(await data.catalogAdmin.catalogOut(id));
});
app.post('/api/catalog/:id/archive', admin, async (req, res) => { const id = Number(req.params.id); await data.catalog.archiveNode(id); res.json(await data.catalogAdmin.catalogOut(id)); });
app.post('/api/catalog/:id/restore', admin, async (req, res) => { const id = Number(req.params.id); await data.catalog.restoreNode(id); res.json(await data.catalogAdmin.catalogOut(id)); });
app.delete('/api/catalog/:id', admin, async (req, res) => { await data.catalog.deleteNode(Number(req.params.id)); res.json({ ok: true }); });

// ---------- requests ----------
// The list query, the new request's insert and the approval transaction: src/requestRecords.js; loading a request and the rescind/cancel
// policy: src/requestAccess.js (moved there verbatim in Slices 5B-2 and 5B-4). The routes check the request, call the seam in the same
// order as before and send the emails.
app.get('/api/requests', auth, async (req, res) => {
  if (req.query.status !== undefined && !['open', 'closed'].includes(req.query.status)) throw httpError(400, 'Status must be open or closed');
  if (req.query.type !== undefined && !['equipment', 'return', 'issue'].includes(req.query.type)) throw httpError(400, 'Type must be equipment, return or issue');
  // An employee sees only their own; each row says whether this viewer may cancel it (`can_cancel`) and who started it (`self_initiated`).
  res.json(await data.requestRecords.listRequests(req.user, { status: req.query.status, type: req.query.type }));
});
app.post('/api/requests', auth, async (req, res) => {
  let category = clean(req.body.category);
  const message = clean(req.body.message);
  let nodeId = null; // what was asked for in the catalog (any level); asset_id set as well => a specific item, else "any matching"
  if (req.body.catalog_node_id !== undefined && req.body.catalog_node_id !== null && req.body.catalog_node_id !== '') {
    nodeId = Number(req.body.catalog_node_id);
    if (!Number.isInteger(nodeId) || nodeId < 1 || !(await data.catalog.isLive(nodeId))) throw httpError(400, 'Choose equipment from the catalog list');
  }
  if (!category && !message && nodeId === null) throw httpError(400, 'Tell IT what you need');
  const forUser = req.user.role === 'admin' && req.body.user_id ? Number(req.body.user_id) : req.user.employee_id;
  if (forUser === null) throw httpError(400, "Your login isn't linked to an employee record. Choose who the request is for.");
  const assetId = num(req.body.asset_id);
  const wantedType = clean(req.body.requested_assignment_type);
  if (wantedType && !data.assignments.ASSIGNMENT_TYPES.includes(wantedType)) throw httpError(400, 'Requested assignment type must be permanent or checkout');
  if (wantedType === 'permanent' && assetId === null) throw httpError(400, 'Choose the equipment you want assigned permanently');
  if (!Number.isInteger(forUser) || forUser < 1) throw httpError(400, 'Choose a valid person for this request');
  if (assetId !== null && (!Number.isInteger(assetId) || assetId < 1)) throw httpError(400, 'Choose a valid asset');
  const forPerson = await data.people.employeeStatus(forUser);
  if (!forPerson) throw httpError(404, 'User not found');
  if (forPerson.status !== 'active') throw httpError(400, 'That person is inactive, so a request can\'t be made for them');
  const wanted = assetId === null ? null : await data.assetAccess.getAsset(assetId);
  if (assetId !== null && (!wanted || !(await data.assetAccess.canViewAsset(req.user, wanted)))) throw httpError(404, 'Asset not found'); // an employee can only ask for equipment they can see
  if (wanted && wanted.archived_at) throw httpError(400, 'This asset is archived and can\'t be requested.');
  let restrictedPick = false;
  if (wanted && nodeId !== null) {
    restrictedPick = true;
    // A specific item picked under a catalog selection: it must really be filed under that entry, and an employee may only
    // pick what they could get anyway (available, not archived, not theirs already) — never something someone else holds.
    if (req.user.role !== 'admin' && (wanted.status !== 'available' || await data.assetAccess.holdsAsset(wanted.id, forUser))) throw httpError(404, 'Asset not found');
    if (!(await data.catalog.subtreeIds(nodeId)).includes(wanted.catalog_node_id)) throw httpError(400, "That item isn't part of the equipment you chose.");
  } else if (wanted && wanted.catalog_node_id && await data.catalog.isLive(wanted.catalog_node_id)) {
    nodeId = wanted.catalog_node_id; // asked for one particular item (e.g. from its page): record where it sits in the catalog
  }
  // Snapshots, so the request still reads the same after a rename, a move or an asset edit.
  const catalogPath = nodeId !== null ? await data.catalog.pathText(nodeId) : null;
  if (nodeId !== null) category = (await data.catalog.rootOf(nodeId)).name;
  const assetLabel = wanted ? `${wanted.tag} — ${wanted.name}` : null;
  // A permanent-assignment request only records the ask; nothing is assigned until an admin approves it. The person / asset checks run again
  // inside the write (one transaction with the insert and its activity row since Slice 5D-2): an asset archived or taken after the reads
  // above is refused, and a request never exists without its activity row.
  const r = await data.requestRecords.createEquipmentRequest({
    forUser, assetId, category: category || (wantedType === 'permanent' ? wanted.category : null), message, neededBy: clean(req.body.needed_by),
    createdBy: req.user.account_id, wantedType, nodeId, catalogPath, assetLabel,
    recheck: { restrictToAvailable: !!wanted && req.user.role !== 'admin' && restrictedPick },
    activity: assetId ? { actorAccountId: req.user.account_id, details: `${wantedType === 'permanent' ? 'Permanent assignment requested' : (message || catalogPath || category || 'Requested')}${wantedType === 'permanent' && message ? ` · ${message}` : ''}` } : null,
  });
  notify.equipmentRequested(await data.people.getPerson(forUser), r);
  res.json(r);
});
// IT opens a request (the admin detail view calls this when it is shown). Sets opened_at once — that is what ends the
// employee's right to rescind — and is a no-op on later calls and on closed requests. Admin only; never a GET side effect.
app.post('/api/requests/:id/open', admin, async (req, res) => {
  const r = await data.requests.openRequest(Number(req.params.id));
  res.json(await data.requests.withLifecycle(r));
});
app.post('/api/requests/:id/approve', admin, async (req, res) => {
  const r = await data.requestAccess.loadRequest(req.params.id);
  if (r.type !== 'equipment') throw httpError(400, 'This request is not open');
  if (!data.requests.canTransition('equipment', r.status, 'approved') && !data.requests.canTransition('equipment', r.status, 'completed')) {
    throw httpError(400, data.requests.TERMINAL.includes(r.status) ? 'This request is already closed' : 'This request is not open');
  }
  const user = await data.people.getPerson(r.user_id);
  if (!user || user.status !== 'active') throw httpError(400, 'That person is inactive, so this request can\'t be approved');
  const rawAssetId = num(req.body.asset_id);
  if (rawAssetId !== null && (!Number.isInteger(rawAssetId) || rawAssetId < 0)) throw httpError(400, 'Choose a valid asset');
  let assetId = rawAssetId || null;
  let assignmentType = req.body.assignment_type || r.requested_assignment_type || undefined;
  if (r.requested_assignment_type === 'permanent') {
    // Approving a request for a PERMANENT assignment means making exactly that assignment: for the requested asset, as
    // permanent. It can't be "approved" with nothing assigned, with different equipment, or downgraded to a loan.
    if (assetId !== null && assetId !== r.asset_id) throw httpError(400, 'A permanent assignment request can only be approved for the equipment that was requested.');
    if (req.body.assignment_type && req.body.assignment_type !== 'permanent') throw httpError(400, 'A permanent assignment request can only be approved as a permanent assignment. Decline it or ask for a temporary checkout instead.');
    assetId = r.asset_id;
    assignmentType = 'permanent';
  }
  const asset = assetId ? await data.assetAccess.getAsset(assetId) : null;
  if (assetId && !asset) throw httpError(404, 'Asset not found');
  // Fulfilling (an asset is attached) must hand over what was asked for. A request that named one item (asset_id is only
  // ever set on an unfulfilled request when a specific item was requested) is fulfilled with that item and no other; an
  // "any matching" request takes any asset filed under the catalog entry that was asked for. Availability, archived and
  // seat rules are enforced by createAssignment inside the transaction below.
  if (asset && r.asset_id !== null && asset.id !== r.asset_id) throw httpError(400, `This request is for a specific item (${r.asset_label || 'the one that was requested'}). It can only be fulfilled with that item.`);
  if (asset && r.asset_id === null && r.catalog_node_id !== null && !(await data.catalog.subtreeIds(r.catalog_node_id)).includes(asset.catalog_node_id)) {
    throw httpError(400, `That asset isn't part of the equipment that was requested${r.catalog_path ? ` (${r.catalog_path})` : ''}. Choose a matching asset.`);
  }
  const note = clean(req.body.note);
  // The assignment (if any) and the request's completion succeed or fail together (ONE immediate transaction: src/requestRecords.js
  // approveRequest); emails go out only after commit.
  const assignment = await data.requestRecords.approveRequest({
    request: r, asset, employeeId: user.id, actorAccountId: req.user.account_id,
    assignmentType, dueDate: req.body.due_date, dueTime: req.body.due_time, note,
  });
  if (assignment) notify.checkedOut(user, await data.assetAccess.getAsset(asset.id), assignment);
  // When an asset is attached the checkout email already went out; only send the approval note if no asset yet or a note was added
  if (!asset || note) notify.requestResolved(user, { ...r, status: asset ? 'completed' : 'approved', resolution_note: note }, asset);
  res.json({ ok: true });
});
app.post('/api/requests/:id/deny', admin, async (req, res) => {
  const r = await data.requestAccess.loadRequest(req.params.id);
  if (r.type !== 'equipment') throw httpError(400, 'Only equipment requests can be declined. Cancel a return request instead.');
  const note = clean(req.body.note);
  await data.requests.transition(r.id, 'denied', { actorAccountId: req.user.account_id, actorIsAdmin: true, note, setNote: true });
  notify.requestResolved(await data.people.getPerson(r.user_id), { ...r, status: 'denied', resolution_note: note });
  res.json({ ok: true });
});
// Resolves an issue report. Issues have no approve/deny: IT either resolves one (here) or dismisses it (cancel). The status change and
// the activity row are ONE transaction since Slice 5D-2 (src/requestRecords.js transitionLogged).
app.post('/api/requests/:id/resolve', admin, async (req, res) => {
  const r = await data.requestAccess.loadRequest(req.params.id);
  if (r.type !== 'issue') throw httpError(400, 'Only issue reports can be marked resolved');
  await data.requestRecords.transitionLogged({
    id: r.id, to: 'completed', opts: { actorAccountId: req.user.account_id, actorIsAdmin: true, note: clean(req.body.note), setNote: true },
    activity: { action: 'issue_resolved', details: clean(req.body.note) || 'Marked resolved', actorAccountId: req.user.account_id, subjectUserId: r.user_id },
  });
  res.json({ ok: true });
});
// Rescind/cancel policy, one place for the route and for the `can_cancel` flag on the list: src/requestAccess.js cancelBlock (admin:
// any live request; an employee: only their own, while live and before IT has opened it; see the table there).
// Rescind/cancel: the person who made a request may cancel their own while it is still eligible (see cancelBlock); IT may
// cancel any live request. A cancelled request stays in history — nothing is deleted.
app.post('/api/requests/:id/cancel', auth, async (req, res) => {
  const r = await data.requestAccess.loadRequest(req.params.id);
  const block = await data.requestAccess.cancelBlock(r, req.user);
  if (block) throw httpError(block.status, block.msg);
  const isIT = req.user.role === 'admin';
  await data.requests.transition(r.id, 'cancelled', { actorAccountId: req.user.account_id, actorIsAdmin: isIT, requireUnopened: !isIT });
  res.json({ ok: true });
});
// The status change and (if the asset still exists) the activity row in ONE transaction since Slice 5D-2; the email after it.
app.post('/api/requests/:id/dropped-off', auth, async (req, res) => {
  const r = await data.requestAccess.loadRequest(req.params.id);
  if (r.user_id !== req.user.employee_id && req.user.role !== 'admin') throw httpError(403, 'Not allowed');
  if (r.type !== 'return') throw httpError(400, 'This request is not open');
  const { asset } = await data.requestRecords.transitionLogged({
    id: r.id, to: 'dropped_off', opts: { actorIsAdmin: req.user.role === 'admin' },
    activity: { action: 'dropped_off', details: clean(req.body.note) || 'User says it was dropped off', actorAccountId: req.user.account_id, subjectUserId: r.user_id, onlyIfAsset: true },
  });
  if (asset) {
    notify.droppedOff(await data.people.getPerson(r.user_id), asset);
  }
  res.json({ ok: true });
});
// ---------- employee equipment requests ----------
// "I need a piece of equipment" (src/equipmentRequests.js): one physical item per request, decided by IT, never an automatic purchase, asset, reservation or
// assignment. Any signed-in employee may submit and follow their own (no scanner / self-checkout permission); IT decides, readies and fulfils. The rules and the
// audit trail live in the module; these routes check the input, identify the caller and send the emails after each write commits.
const eqLabel = (r) => [r.category, r.brand, r.model].filter(Boolean).join(' › ');
async function eqTell(r, headline, detail) {
  try { const p = await data.people.getPerson(r.employee_id); if (p) notify.equipmentNeedUpdate(p, r, headline, detail); } catch (e) { console.error('[equipment-request:mail]', e.message); }
}
const eqNote = (v) => {
  const s = clean(v);
  if (s && s.length > data.equipmentRequests.TEXT_MAX) throw httpError(400, `Please keep notes under ${data.equipmentRequests.TEXT_MAX} characters`);
  return s;
};
const eqId = (req) => Number(req.params.id);
app.get('/api/equipment-requests', auth, async (req, res) => {
  if (req.query.status !== undefined && !['open', 'closed'].includes(req.query.status)) throw httpError(400, 'Status must be open or closed');
  res.json(await data.equipmentRequests.list(req.user, { status: req.query.status }));
});
app.get('/api/equipment-request-counts', auth, async (req, res) => res.json(await data.equipmentRequests.counts(req.user)));
app.post('/api/equipment-requests', auth, async (req, res) => {
  const me = req.user.employee_id;
  if (!me) throw httpError(400, "Your login isn't linked to an employee record. Ask IT.");
  const b = req.body || {};
  const limited = (v, label, max) => {
    const s = clean(v);
    if (s && s.length > max) throw httpError(400, `${label} is too long (up to ${max} characters).`);
    return s;
  };
  const { FIELD_MAX, TEXT_MAX } = data.equipmentRequests;
  const details = limited(b.details, 'Additional details', TEXT_MAX);
  let category; let categoryOther = false; let nodeId = null; let catalogPath = null; let brand = null; let model = null;
  if (b.catalog_node_id !== undefined && b.catalog_node_id !== null && b.catalog_node_id !== '') {
    // a category (and optionally a brand and model) chosen from the catalog: any live level; the names are snapshotted so the request reads the same later
    nodeId = Number(b.catalog_node_id);
    if (!Number.isInteger(nodeId) || nodeId < 1 || !(await data.catalog.isLive(nodeId))) throw httpError(400, 'Choose equipment from the catalog list, or Other.');
    const names = await data.catalog.pathNames(nodeId);
    category = names[0]; brand = names[1] || null; model = names.length > 2 ? names.slice(2).join(' › ') : null;
    catalogPath = await data.catalog.pathText(nodeId);
  } else {
    category = limited(b.category_other, 'The category', FIELD_MAX);
    if (!category) throw httpError(400, 'Choose a category, or choose Other and say what you need.');
    categoryOther = true;
  }
  // typed brand / model text only fills a level the catalog choice left open
  const customBrand = limited(b.brand, 'The brand', FIELD_MAX); const customModel = limited(b.model, 'The model', FIELD_MAX);
  if (!brand) brand = customBrand;
  if (!model) model = customModel;
  const r = await data.equipmentRequests.create({ employeeId: me, createdBy: req.user.account_id, category, categoryOther, nodeId, catalogPath, brand, model, details, permanent: b.permanent === true || b.permanent === 'true' || b.permanent === 1 });
  notify.equipmentNeedSubmitted(await data.people.getPerson(me), r);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
app.get('/api/equipment-requests/:id', auth, async (req, res) => res.json(await data.equipmentRequests.get(eqId(req), req.user)));
// IT opens a request (Submitted -> In review). Admin only; never a GET side effect.
app.post('/api/equipment-requests/:id/review', admin, async (req, res) => {
  await data.equipmentRequests.review(eqId(req), { actorAccountId: req.user.account_id });
  res.json(await data.equipmentRequests.get(eqId(req), req.user));
});
// Approve the NEED; the permanent-assignment preference is decided separately (here, in the same step, or later on /permanent).
app.post('/api/equipment-requests/:id/approve', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.approve(eqId(req), { actorAccountId: req.user.account_id, note, permanentDecision: clean(req.body.permanent_decision) || undefined, permanentNote: eqNote(req.body.permanent_note) });
  await eqTell(r, 'Approved', `IT approved the need.${r.permanent_decision === 'approved' ? ' Your permanent assignment was approved too: IT will deliver it.' : r.permanent_decision === 'denied' ? ' The permanent assignment was not approved, so it will be shared equipment you can reserve.' : ''}${note ? ` Note from IT: ${note}` : ''}`);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
app.post('/api/equipment-requests/:id/permanent', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.setPermanent(eqId(req), { actorAccountId: req.user.account_id, decision: clean(req.body.decision), note });
  await eqTell(r, r.permanent_decision === 'approved' ? 'Permanent assignment approved' : 'Permanent assignment not approved', r.permanent_decision === 'approved' ? 'IT will deliver the equipment and assign it to you.' : `IT did not approve a permanent assignment, so this will be shared equipment you can reserve.${note ? ` Note from IT: ${note}` : ''}`);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
// A note without a decision: recorded in the history, shown to the employee as "Note from IT" and emailed; nothing else changes.
app.post('/api/equipment-requests/:id/note', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.addNote(eqId(req), { actorAccountId: req.user.account_id, note });
  await eqTell(r, 'Note from IT', note);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
app.post('/api/equipment-requests/:id/decline', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.decline(eqId(req), { actorAccountId: req.user.account_id, note });
  await data.waitlist.dispatchHoldEmails(); // (declining a ready request frees its unit, which may have been offered to the next person in line)
  await eqTell(r, 'Declined', `IT declined this request.${note ? ` Note from IT: ${note}` : ''}`);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
// A unit is ready: notify the requester and start their 48-hour priority hold on it.
app.post('/api/equipment-requests/:id/ready', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.markReady(eqId(req), { actorAccountId: req.user.account_id, assetId: num(req.body.asset_id), note });
  const d = await data.equipmentRequests.get(r.id, req.user);
  await eqTell(d, 'Ready for you', `${d.asset_label} is ready. It is on a priority hold for you until ${d.hold_expires_text} (${data.equipmentRequests.HOLD_HOURS} hours): reserve it, or ask IT to check it out. Nobody else can reserve or check it out meanwhile.${note ? ` Note from IT: ${note}` : ''}`);
  res.json(d);
});
// Issued: a permanent assignment delivered, a checkout, or a handover that needs no inventory item.
app.post('/api/equipment-requests/:id/fulfill', admin, async (req, res) => {
  const note = eqNote(req.body.note);
  const r = await data.equipmentRequests.fulfill(eqId(req), { actorAccountId: req.user.account_id, assetId: num(req.body.asset_id), dueDate: clean(req.body.due_date), dueTime: clean(req.body.due_time), note, untracked: req.body.untracked === true || req.body.untracked === 'true' });
  await data.waitlist.dispatchHoldEmails();
  await eqTell(r, 'Fulfilled', `Your equipment has been issued.${note ? ` Note from IT: ${note}` : ''}`);
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
app.post('/api/equipment-requests/:id/cancel', auth, async (req, res) => {
  const r = await data.equipmentRequests.cancel(eqId(req), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, isAdmin: req.user.role === 'admin' });
  await data.waitlist.dispatchHoldEmails();
  if (req.user.role === 'admin' && r.employee_id !== req.user.employee_id) await eqTell(r, 'Cancelled', 'IT cancelled this request.');
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
// The employee declines the ready unit: the hold ends, the unit goes back to everyone, the request stays approved.
app.post('/api/equipment-requests/:id/decline-ready', auth, async (req, res) => {
  const r = await data.equipmentRequests.releaseHold(eqId(req), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, isAdmin: false });
  await data.waitlist.dispatchHoldEmails();
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
app.post('/api/equipment-requests/:id/release', admin, async (req, res) => {
  const r = await data.equipmentRequests.releaseHold(eqId(req), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, isAdmin: true });
  await data.waitlist.dispatchHoldEmails();
  await eqTell(r, 'Hold released', 'IT released the priority hold on your equipment. Your request is still approved; IT will let you know when a unit is ready.');
  res.json(await data.equipmentRequests.get(r.id, req.user));
});
// The sweep: priority holds that ran out unclaimed go back to approved (or fulfilled, when the employee reserved the unit meanwhile). Never throws.
async function expireEquipmentHolds() {
  try {
    for (const { request, outcome } of await data.equipmentRequests.expireHolds()) {
      if (outcome === 'claimed') await eqTell(request, 'Reserved for you', 'The priority hold ended, and your reservation keeps the unit for you. IT will issue it to you.');
      else if (outcome === 'claim_ended') await eqTell(request, 'Reservation ended', 'Your reservation ended before the equipment was issued. Your request is still approved: ask IT to hold a unit for you again.');
      else await eqTell(request, 'Hold ended', `The ${data.equipmentRequests.HOLD_HOURS}-hour priority hold ended without a claim and the unit is available to everyone again. Your request is still approved: ask IT to hold a unit for you again.`);
    }
  } catch (e) { console.error('[equipment-request:hold-sweep]', e.message); }
}

// ---- employee actions on equipment they currently hold (Phase 2, Slice 2) ----
// The asset must be visible to the caller AND checked out to the caller right now (src/assetAccess.js heldAsset). Anything else is
// refused on the server; a hidden button is never the authorization. (A visible-but-not-held asset is a 400, an invisible one a 404.)
// The requests they create: src/assetCustody.js (moved there verbatim in Slice 5B-2).
// "Request return": the employee asks to give a held asset back. Creates the same live 'return' request IT can create
// (status 'open', shown as "Return requested"); the assignment is NOT ended — it ends only when IT checks the asset in.
// One live return request per asset + employee: a second tap — or one while IT has already asked — is refused.
app.post('/api/assets/:id/my-return-request', auth, async (req, res) => {
  const asset = await data.assetAccess.heldAsset(req.user, req.params.id);
  res.json(await data.assetCustody.requestMyReturn(req.user, asset, clean(req.body.message)));
});
// "Report issue": a short description tied to one held asset. It is a request of type 'issue' in the same queue IT already
// works from (open -> resolved by IT, or withdrawn by the employee). No comments, attachments, priorities or SLAs.
const ISSUE_MAX = 1000;
app.post('/api/assets/:id/report-issue', auth, async (req, res) => {
  const asset = await data.assetAccess.heldAsset(req.user, req.params.id);
  const message = clean(req.body.message);
  if (!message) throw httpError(400, 'Describe the issue so IT knows what is wrong');
  if (message.length > ISSUE_MAX) throw httpError(400, `Please keep the description under ${ISSUE_MAX} characters`);
  res.json(await data.assetCustody.reportIssue(req.user, asset, message));
});
// A user can proactively say "I'm returning this" without being asked
app.post('/api/assets/:id/return-notice', auth, async (req, res) => {
  const asset = await data.assetAccess.visibleAsset(req.user, req.params.id);
  await data.assetCustody.returnNotice(req.user, asset, clean(req.body.note));
  notify.droppedOff(req.user, asset);
  res.json({ ok: true });
});

// ---------- dashboard ----------
// The signed-in person's equipment and requests; for IT the statistics and queues (src/dashboard.js, moved there verbatim in Slice 5B-2).
app.get('/api/dashboard', auth, async (req, res) => {
  res.json(await data.dashboard.dashboard(req.user));
});

// ---------- settings, email, import/export ----------
// On the seam since Slice 5B-4: the settings (src/settings.js, the SQL of src/db.js getSettings / setSetting), the outbox (src/outbox.js),
// IT's activity list (src/activityLog.js recent), the CSV export query (src/assetViews.js exportRows) and the import transaction
// (src/assetRecords.js importAssets). Validation, the CSV text and the emails stay here.
app.get('/api/settings', admin, async (req, res) => res.json({ ...(await data.settings.getSettings()), mailConfigured: mailConfigured(), appUrl: APP_URL, mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || null, mailEnvelope: await mailEnvelope(), mailTestRecipient: testRecipient() }));
// The IT email identity is just a display name and a contact address. Anything credential-shaped is refused outright: passwords, app
// passwords, API keys and OAuth secrets belong in the server environment (SMTP_PASS etc.), never in the database or this screen.
const CREDENTIAL_KEY = /pass(word)?|secret|token|api[_-]?key|smtp|credential|oauth/i;
function itEmailSettings(b) {
  const out = {};
  if (b.it_email_name !== undefined) {
    const v = typeof b.it_email_name === 'string' ? b.it_email_name.trim() : '';
    if (!v || v.length > 80 || /[\x00-\x1f\x7f<>"]/.test(v)) throw httpError(400, 'The IT email display name is required (up to 80 characters, without quotes or angle brackets).');
    out.it_email_name = v;
  }
  if (b.it_contact_email !== undefined) {
    if (typeof b.it_contact_email !== 'string') throw httpError(400, 'The IT contact email must be an email address.');
    const v = b.it_contact_email.trim().toLowerCase();
    if (v && (v.length > 254 || !isEmail(v) || /[\s,;<>"]/.test(v))) throw httpError(400, 'The IT contact email is not a valid email address.');
    out.it_contact_email = v; // '' clears it
  }
  return out;
}
// Each setting is its own write, in this order, as before (no transaction); the answer is the settings read back.
app.put('/api/settings', admin, async (req, res) => {
  const b = req.body;
  if (Object.keys(b).some((k) => CREDENTIAL_KEY.test(k))) throw httpError(400, 'Email passwords, keys and secrets are not stored here. Set them in the server environment (see the README).');
  const it = itEmailSettings(b); // validate everything new BEFORE anything is saved
  for (const [k, v] of Object.entries(it)) await data.settings.setSetting(k, v);
  if (b.overdue_reminders !== undefined) await data.settings.setSetting('overdue_reminders', b.overdue_reminders ? '1' : '0');
  if (b.default_loan_days !== undefined) await data.settings.setSetting('default_loan_days', String(Math.max(0, parseInt(b.default_loan_days, 10) || 0)));
  if (b.tag_prefix !== undefined) await data.settings.setSetting('tag_prefix', String(b.tag_prefix).trim().slice(0, 10));
  if (Array.isArray(b.categories)) await data.settings.setSetting('categories', b.categories.map((s) => String(s).trim()).filter(Boolean));
  // (`locations` is no longer written here: the managed list below is the one source of truth, and it refuses to drop a used location)
  res.json(await data.settings.getSettings());
});
// Managed locations (Locations under All assets): the `locations` setting plus the assets that use each name. IT only. Every write answers with the
// refreshed overview; a rename rewrites the assets that carried the old name in the same transaction, and a location some asset uses cannot be removed.
app.get('/api/locations', admin, async (req, res) => res.json(await data.locations.overview()));
app.post('/api/locations', admin, async (req, res) => res.json(await data.locations.add({ name: req.body.name })));
app.put('/api/locations', admin, async (req, res) => res.json(await data.locations.rename({ from: req.body.from, to: req.body.to })));
app.delete('/api/locations', admin, async (req, res) => res.json(await data.locations.remove({ name: req.body.name })));
app.post('/api/settings/test-email', admin, wrap(async (req, res) => {
  await notify.test(req.user.email);
  const last = await data.outbox.latest();
  res.json(last);
}));
app.get('/api/outbox', admin, async (req, res) => {
  res.json(await data.outbox.recent());
});
app.get('/api/activity', admin, async (req, res) => {
  res.json(await data.activityLog.recent(Math.min(1000, Number(req.query.limit) || 200)));
});

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
app.get('/api/export/assets.csv', admin, async (req, res) => {
  const rows = await data.assetViews.exportRows(); // every live asset by tag, each with its catalog path ('' when unlinked)
  const cols = ['tag', 'name', 'category', 'status', 'holder_names', 'due_date', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor', 'warranty_expires', 'license_seats', 'seats_used', 'license_expires', 'notes', 'catalog_path'];
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nutricost-assets-${today()}.csv"`);
  res.send('﻿' + csv);
});

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
app.post('/api/import/assets', admin, async (req, res) => {
  const rows = parseCsv(String(req.body || ''));
  if (rows.length < 2) throw httpError(400, 'The file needs a header row and at least one asset');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''));
  const alias = { asset_tag: 'tag', serial_number: 'serial', s_n: 'serial', type: 'category', manufacturer: 'brand', cost: 'purchase_cost', price: 'purchase_cost', warranty: 'warranty_expires', seats: 'license_seats', assigned_to: 'assigned_email', email: 'assigned_email', catalog: 'catalog_path' };
  const keys = header.map((h) => alias[h] || h);
  // Each data row by column name, with its fields validated (`assetValues` reads no database and cannot refuse a CSV row: every cell is
  // text). Done here, before the seam call, instead of row by row inside the transaction: the same values either way.
  const items = rows.slice(1).map((r, n) => {
    const o = {}; keys.forEach((k, i) => { o[k] = r[i]; });
    if (o.purchase_cost) o.purchase_cost = String(o.purchase_cost).replace(/[$,]/g, '');
    try { return { o, v: assetValues(o) }; } catch (e) { if (e.status === 400) e.message = `Row ${n + 2}: ${e.message}`; throw e; } // (nothing imported)
  });
  // The active employees (for assigned_email), then the WHOLE file in ONE transaction, exactly as before (src/assetRecords.js
  // importAssets): a row with a problem is skipped or imported partly and reported in `errors`; anything that throws rolls it all back.
  res.json(await data.assetRecords.importAssets({ rows: items, actorAccountId: req.user.account_id }));
});

// ---------- employee CSV import (admin only; docs/briefs/employee-csv-import.md) ----------
// Preview (reads only) and import take the same CSV text; the import recomputes its plan inside its transaction. It creates people with no
// login (they sign in with Google, which links them by work email) and self-checkout OFF, and updates profile fields of matched people.
const employeeImportPlan = require('./employeeImportPlan'); // (pure: the template and the CSV rules; no database)
const employeeCsv = (req) => {
  const text = String(req.body || '');
  if (text.length > data.employeeImport.MAX_BYTES) throw httpError(400, 'That file is too large (2 MB at most).');
  return data.employeeImport.rowsFromCsv(parseCsv(text));
};
app.get('/api/import/employees/template.csv', admin, (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="employee-import-template.csv"').send(employeeImportPlan.TEMPLATE);
});
app.post('/api/import/employees/preview', admin, async (req, res) => {
  const { rows } = employeeCsv(req);
  res.json(await data.employeeImport.preview({ rows }));
});
app.post('/api/import/employees', admin, async (req, res) => {
  const { rows } = employeeCsv(req);
  const expect = req.query.create !== undefined ? { create: Number(req.query.create), update: Number(req.query.update) } : undefined;
  const result = await data.employeeImport.apply({ rows, actorAccountId: req.user.account_id, acknowledge: req.query.acknowledge === '1', expect });
  res.json(result);
});

// ---------- overdue reminders ----------
// The query and the "reminded today" mark: src/overdue.js (moved there verbatim in Slice 5B-4). The setting check, the order (each email,
// then its mark) and the emails stay here; the timers keep their intervals.
async function overdueSweep() {
  // (Since Slice 5D a failure is logged, never an unhandled rejection: a lost connection is a routine error on PostgreSQL.)
  try {
    if (!(await data.settings.getSettings()).overdue_reminders) return;
    const rows = await data.overdue.dueAssignments();
    for (const s of rows) {
      const a = await data.assetAccess.getAsset(s.asset_id);
      notify.overdue({ name: s.user_name, email: s.user_email }, a, s);
      await data.overdue.markNotified(s.id);
    }
  } catch (e) { console.error('[overdue:sweep]', e.message); }
}
function startOverdueTimer() {
  setInterval(overdueSweep, 3600e3).unref();
  setTimeout(overdueSweep, 15e3).unref();
}
if (DB_DRIVER !== 'pg') startOverdueTimer(); // (on PostgreSQL boot() starts it, once the schema is migrated)

// ---------- waitlist sweep ----------
// Records holds that ran out, offers free dates to the next person in line (this is what notices a check-in or a changed asset setting, which
// do not touch the waitlist directly) and sends any hold email still owed. Idempotent, so running it often is harmless. Through the seam
// since Slice 5B-4 (on SQLite the sweep still runs to completion inside the call; a failure is logged, as before). The PostgreSQL
// single-flight scheduler (src/pg/sweep.js) replaces this timer on PostgreSQL (started by boot() below, with the same first run at 20 s).
async function waitlistSweep() { await expireEquipmentHolds(); return data.waitlist.sweep().catch((e) => console.error('[waitlist:sweep]', e.message)); } // (a ready equipment request's priority hold ends first: it frees its unit for the queue)
if (DB_DRIVER !== 'pg') {
  setInterval(waitlistSweep, 60e3).unref();
  setTimeout(waitlistSweep, 20e3).unref();
}

// ---------- static front-end ----------
const PUB = path.join(__dirname, '..', 'public');
// Local development (`npm run dev` sets NODE_ENV=development; production images set NODE_ENV=production). In dev the browser must
// never be able to hold on to old front-end code: nothing under public/ is cached at all, and the service worker is replaced by a
// "kill switch" that removes itself and its caches from any browser that already installed one (the real worker is network-first
// with a cached-shell fallback, which silently shows OLD code whenever the dev server is restarting or down). Production is unchanged.
const DEV = process.env.NODE_ENV === 'development';
if (DEV) {
  app.get('/sw.js', (req, res) => {
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(`// dev kill switch: removes the service worker and its caches (see src/server.js)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: 'window' })).then((cs) => cs.forEach((c) => c.navigate(c.url)))));
`);
  });
}
app.get('/vendor/html5-qrcode.min.js', (req, res) => res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'), { maxAge: '7d' }));
app.get('/vendor/JsBarcode.all.min.js', (req, res) => res.sendFile(require.resolve('jsbarcode/dist/JsBarcode.all.min.js'), { maxAge: '7d' }));
// The app's own html/js/css always revalidate (ETag => cheap 304): a 1h max-age kept stale UI code running in browsers after updates.
app.use(express.static(PUB, { maxAge: '1h', setHeaders: (res, p) => {
  if (DEV) res.setHeader('Cache-Control', 'no-store'); // dev: every request goes to the disk, no validators needed, nothing is kept
  else if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
} }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(PUB, 'index.html')));

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (25 MB max)' : err.message });
  // A PostgreSQL deadlock (40P01) or serialization failure (40001) aborted this request's transaction and rolled it back: nothing was written,
  // and the same request can simply be sent again (Slice 5D-2). There is no retry system; the client is told it may retry.
  if (err.code === '40P01' || err.code === '40001') {
    console.error('[retryable]', err.code, err.message);
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'The system is busy right now. Please try again in a moment.', retryable: true });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
});

// ---------- boot ----------
// SQLite is ready when this module loads (src/db.js migrated it). PostgreSQL needs async work first: boot() migrates the schema, installs
// the effects notifier (the after-commit emails of the PostgreSQL write paths, src/pg/notifier.js) and starts the single-flight waitlist
// sweep (src/pg/sweep.js, every 60 s, first run at 20 s) and the overdue timer. Idempotent (a second call returns the first result).
// It resolves to `{ stop }`, which stops the sweep timer, waits for a sweep in flight, uninstalls the notifier and ends the pool.
// The PostgreSQL driver must be booted before the first request; `require.main` does it below and awaits it before listen.
let booting = null;
function boot() {
  if (!booting) booting = DB_DRIVER === 'pg' ? bootPg() : Promise.resolve({ stop: async () => {} });
  return booting;
}
async function bootPg() {
  const { runMigrations } = require('./pg/migrate');
  const { installNotifier } = require('./pg/notifier');
  const { createSweepScheduler } = require('./pg/sweep');
  const ran = await runMigrations(pool);
  if (ran.length) console.log(`PostgreSQL: applied schema migration(s) ${ran.join(', ')}`);
  const uninstall = installNotifier(pool, mailer);
  const scheduler = createSweepScheduler({ pool, run: async () => { await expireEquipmentHolds(); return data.waitlist.sweep(); } });
  scheduler.start();
  setTimeout(() => { scheduler.tick(); }, 20e3).unref();
  startOverdueTimer();
  return { stop: async () => { await scheduler.stop(); uninstall(); await require('./pg/pool').close(); } };
}
app.boot = boot;
app.sweepNow = async () => { await expireEquipmentHolds(); await data.waitlist.sweep(); }; // (what the timer runs; tests call it instead of waiting a minute)

function listen({ stop }) {
  // (Express 5 hands a listen failure to this callback as `err`; it must not print the success banner then. The 'error' handler below reports it.)
  const server = app.listen(PORT, (err) => {
    if (err) return;
    console.log(`Nutricost IT Assets running on http://localhost:${PORT}  (APP_URL=${APP_URL}, database: ${DB_DRIVER === 'pg' ? 'PostgreSQL' : 'SQLite'})`);
    if (DEV) console.log('Dev mode: this server restarts itself when backend files change; the browser caches nothing and no service worker is kept. Just refresh the page.');
    else if (process.env.npm_lifecycle_event === 'start' && process.env.NODE_ENV !== 'production') console.log('Note: `npm start` does NOT restart on code changes. For development use `npm run dev` (auto-restart, no stale browser cache).');
    console.log(mailConfigured() ? `Email: sending via ${process.env.SMTP_HOST || 'smtp.gmail.com'} as ${process.env.SMTP_USER}` : 'Email: NOT configured — messages are logged to the Outbox (Settings → Email).');
    console.log(`Photos: stored on the ${photoFiles.label}`);
    if (photoFiles.check) photoFiles.check().catch((e) => console.error(`Photos: the bucket check FAILED (${e.name}: ${e.message}); uploads and photo downloads will fail until it is fixed.`));
  });
  // Another server already owns this port: say so plainly. (Otherwise the browser keeps talking to the OLD process, which looks exactly like "my change didn't show up".)
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`\nPort ${PORT} is already in use by another process, so THIS server did not start and the browser is still talking to the old one.\nFind it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN   then stop it (kill <PID>) and start again, or choose another port with PORT=<number>.\n`);
    process.exit(1);
  });
  // PostgreSQL: on SIGTERM / SIGINT stop taking connections and let the requests in flight finish (idle keep-alive connections are closed
  // at once; after SHUTDOWN_GRACE_MS the rest are cut and the exit code is 1), THEN stop the sweep (waiting for one in flight), uninstall
  // the notifier and end the pool, and exit: a request never loses the pool halfway. (SQLite keeps Node's default signal handling.)
  if (DB_DRIVER === 'pg') {
    const SHUTDOWN_GRACE_MS = 10_000;
    let stopping = false;
    const drain = () => new Promise((resolve) => {
      let forced = false;
      const timer = setTimeout(() => { forced = true; server.closeAllConnections(); }, SHUTDOWN_GRACE_MS);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(forced); });
      server.closeIdleConnections();
    });
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal}: shutting down`);
      let code = 0;
      if (await drain()) { console.error(`[shutdown] requests still running after ${SHUTDOWN_GRACE_MS / 1000} s were cut off`); code = 1; }
      try { await stop(); } catch (e) { console.error('[shutdown]', e.message); code = 1; }
      process.exit(code);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

if (require.main === module) {
  boot().then(listen, (err) => {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = app;
