require('./env');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const { db, DATA_DIR, getSettings, setSetting } = require('./db');
const { notify, APP_URL, mailConfigured, mailEnvelope, testRecipient } = require('./mailer');
const assignments = require('./assignments');
const requestRules = require('./requests');
const availabilityLib = require('./availability');
const catalog = require('./catalog');
const reservationRules = require('./reservations');
const waitlistRules = require('./waitlist');
const { cleanSerial, serialKey } = require('./serial');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const secureCookies = APP_URL.startsWith('https://');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use('/api/import', express.text({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ---------- sessions (SQLite-backed) ----------
class SqliteStore extends session.Store {
  get(sid, cb) {
    const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
    if (!row || row.expires < Date.now()) return cb(null, null);
    cb(null, JSON.parse(row.sess));
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie?.maxAge ?? 30 * 864e5;
    db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires')
      .run(sid, JSON.stringify(sess), Date.now() + maxAge);
    cb && cb(null);
  }
  destroy(sid, cb) { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3).unref();

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
// referring to the PERSON (assignee / requester).
function currentUser(req) {
  if (!req.session.uid) return null;
  return db.prepare(`
    SELECT a.id AS account_id, a.employee_id, a.role, a.login_email AS email, a.password_hash, a.last_login_at,
      COALESCE(e.name, a.login_email) AS name, e.department, e.title, e.phone, e.building, e.created_at, COALESCE(e.can_self_checkout, 0) AS can_self_checkout
    FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.id = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(req.session.uid) || null;
}
function auth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please sign in' });
  req.user = u;
  next();
}
function admin(req, res, next) {
  auth(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' })));
}
// The signed-in user as the UI sees it: `id` is the EMPLOYEE (person) id, null for an account with no employee record.
const publicMe = (u) => ({ can_self_checkout: !!u.can_self_checkout, id: u.employee_id, account_id: u.account_id, employee_id: u.employee_id, name: u.name, email: u.email, role: u.role, department: u.department, title: u.title, phone: u.phone, building: u.building || null, active: true, created_at: u.created_at, last_login_at: u.last_login_at, has_password: !!u.password_hash });

// A person (employee) with their optional account. `email` = where to reach them (work email, else login email).
const PERSON_SQL = `
  SELECT e.*, COALESCE(e.work_email, a.login_email) AS email,
    a.id AS account_id, a.login_email, a.role, a.active AS account_active, a.password_hash, a.last_login_at
  FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id`;
const getPerson = (id) => db.prepare(`${PERSON_SQL} WHERE e.id = ?`).get(id);
const publicPerson = (p) => p && ({
  id: p.id, name: p.name, email: p.email, work_email: p.work_email, department: p.department, title: p.title, phone: p.phone,
  active: p.status === 'active', created_at: p.created_at,
  has_account: !!p.account_id, account_id: p.account_id || null, login_email: p.login_email || null,
  login_enabled: !!p.account_id && !!p.account_active, role: p.role || null,
  last_login_at: p.last_login_at || null, has_password: !!p.password_hash,
  can_self_checkout: !!p.can_self_checkout, building: p.building || null,
});
// Who did it: an account, shown by its employee's name (or login email if unlinked).
const ACTOR_JOIN = 'LEFT JOIN accounts aa ON aa.id = ac.actor_id LEFT JOIN employees u ON u.id = aa.employee_id';
const ACTOR_NAME = 'COALESCE(u.name, aa.login_email) AS actor_name';
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const normEmail = (v) => { const c = clean(v); return c ? c.toLowerCase() : null; };

function log(assetId, actorAccountId, action, details, subjectEmployeeId = null) {
  db.prepare('INSERT INTO activity (asset_id, actor_id, subject_user_id, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(assetId, actorAccountId, subjectEmployeeId, action, details || null);
}
// Tokens belong to an ACCOUNT (password reset / invite); tokens.user_id holds the account id.
function makeToken(userId, purpose, hours) {
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = new Date(Date.now() + hours * 3600e3).toISOString();
  db.prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare('INSERT INTO tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, purpose, exp);
  return token;
}
const getAsset = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);

// Serials are unique across the whole inventory (archived assets included) ignoring surrounding whitespace and letter
// case; see src/serial.js. The UNIQUE index on assets.serial_normalized is the backstop; this gives a readable 400.
function assertSerialFree(serial, exceptAssetId = null) {
  const key = serialKey(serial);
  if (key === null) return;
  const other = db.prepare('SELECT id, tag, archived_at FROM assets WHERE serial_normalized = ?').all(key).find((o) => o.id !== exceptAssetId);
  if (other) throw httpError(400, `Serial number ${cleanSerial(serial)} is already used by asset ${other.tag}${other.archived_at ? ' (archived)' : ''}. Serial numbers must be unique, ignoring letter case and surrounding spaces.`);
}
const { capacity } = assignments;
const openAssignments = (assetId) => db.prepare(`
  SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email, u.department AS user_department
  FROM assignments s JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
  WHERE s.asset_id = ? AND s.returned_at IS NULL ORDER BY s.checked_out_at`).all(assetId);

const refreshStatus = (assetId) => assignments.refreshStatus(db, assetId);

// ---- asset tag issuance ----
// Generated tags are prefix + a number from a durable, ever-increasing counter (asset_tag_counter). The counter is
// independent of the prefix, is never lowered (archiving keeps tags reserved), and is claimed inside the same
// transaction that inserts the asset. peekTag() only previews the next number and consumes nothing.
const formatTag = (prefix, n) => prefix + String(n).padStart(5, '0');
const tagExists = (tag) => !!db.prepare('SELECT 1 FROM assets WHERE tag = ?').get(tag);
function peekTag() {
  const prefix = getSettings().tag_prefix;
  let n = db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n + 1;
  while (tagExists(formatTag(prefix, n))) n++;
  return formatTag(prefix, n);
}
function allocateTag() { // call only inside a transaction
  const prefix = getSettings().tag_prefix;
  for (;;) {
    db.prepare('UPDATE asset_tag_counter SET last_number = last_number + 1 WHERE id = 1').run();
    const tag = formatTag(prefix, db.prepare('SELECT last_number n FROM asset_tag_counter WHERE id = 1').get().n);
    if (!tagExists(tag)) return tag; // skip numbers already taken by manually chosen tags
  }
}

// Adds the readable catalog path to an asset row. An employee never learns about a catalog entry that is archived (or sits
// under an archived one): for them it is as if the asset were unmapped.
function withCatalog(a, user) {
  if (!('catalog_node_id' in a)) return a;
  const id = a.catalog_node_id;
  if (id === null || id === undefined) return { ...a, catalog_path: null };
  if (user.role !== 'admin' && !catalog.isLive(db, id)) return { ...a, catalog_node_id: null, catalog_path: null };
  return { ...a, catalog_path: catalog.pathText(db, id) };
}

// Fields a non-admin should not see
function sanitizeAsset(a, user) {
  if (!a) return a;
  a = withCatalog(a, user);
  if (user.role === 'admin') return a;
  const mine = db.prepare('SELECT due_date FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(a.id, user.employee_id);
  const { purchase_cost, vendor, notes, holder_names, ...rest } = a; // never other people's names
  if (!mine) delete rest.license_key;
  if ('due_date' in rest) rest.due_date = mine ? mine.due_date : null; // the list's MIN(due_date) spans every holder; show only the viewer's own
  return rest;
}

// Employee asset-visibility contract, enforced on the server (hiding navigation is not access control). An admin sees
// everything. An employee may see an asset only if they currently hold it (that follows the ASSIGNMENT: a desk computer assigned to
// them stays theirs whatever its flags), or it is in the shared pool and available to them: IT made it `available_to_request`, it is
// not archived, and its status is 'available' (a multi-seat license with a free seat stays 'available'; a full one is 'checked_out').
// Anything else — not shared, archived, in repair, lost, retired, held by someone else — is indistinguishable from "not found".
function canViewAsset(user, a) {
  if (!a) return false;
  if (user.role === 'admin') return true;
  if (!a.archived_at && a.status === 'available' && a.available_to_request) return true;
  return !!user.employee_id && !!db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(a.id, user.employee_id);
}
// The asset for this route, or a 404 when it doesn't exist OR this user may not see it.
function visibleAsset(req, id) {
  const a = getAsset(Number(id));
  if (!a || !canViewAsset(req.user, a)) throw httpError(404, 'Asset not found');
  return a;
}

// `user` = the employee receiving the asset; `actor` = the signed-in account performing it.
// The capacity check + insert + activity row are one immediate transaction (see assignments.js).
function doCheckout({ asset, user, actor, assignment_type, due_date, due_time, notes, condition }) {
  const { assignment } = assignments.createAssignment(db, {
    assetId: asset.id, employeeId: user.id, actorAccountId: actor.account_id, actorIsAdmin: actor.role === 'admin',
    type: assignment_type, dueDate: due_date, dueTime: due_time, notes, condition,
  });
  notify.checkedOut(user, getAsset(asset.id), assignment);
  if (actor.employee_id === user.id && actor.role !== 'admin') notify.selfCheckoutToAdmins(user, asset);
  return assignment;
}

// ---------- setup & auth ----------
app.get('/api/setup-needed', (req, res) => {
  res.json({ needed: db.prepare('SELECT COUNT(*) c FROM accounts').get().c === 0 });
});
app.post('/api/setup', wrap(async (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM accounts').get().c > 0) throw httpError(400, 'Setup already completed');
  const { name, email, password } = req.body;
  if (!clean(name) || !clean(email) || !password || password.length < 8) throw httpError(400, 'Name, email and a password of at least 8 characters are required');
  const hash = await bcrypt.hash(password, 10);
  const mail = normEmail(email);
  const accountId = db.transaction(() => {
    const emp = db.prepare("INSERT INTO employees (name, work_email, department) VALUES (?, ?, 'IT')").run(clean(name), mail).lastInsertRowid;
    return db.prepare("INSERT INTO accounts (employee_id, login_email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(emp, mail, hash).lastInsertRowid;
  })();
  req.session.uid = accountId;
  res.json({ ok: true });
}));

const loginAttempts = new Map();
app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${req.ip}|${email}`;
  const att = loginAttempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - att.t > 15 * 60e3) { att.n = 0; att.t = Date.now(); }
  if (att.n >= 10) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const u = db.prepare(`SELECT a.* FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.login_email = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(email);
  const ok = u && u.password_hash && (await bcrypt.compare(String(req.body.password || ''), u.password_hash));
  if (!ok) { att.n++; loginAttempts.set(key, att); throw httpError(401, 'Email or password is incorrect'); }
  loginAttempts.delete(key);
  db.prepare("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.uid = u.id; // the session identifies the ACCOUNT
    res.json({ ok: true });
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', auth, (req, res) => {
  const { it_email_name, it_contact_email, ...shared } = getSettings(); // the IT email identity is IT's to see (Settings), not part of every employee's session
  res.json({ user: publicMe(req.user), settings: req.user.role === 'admin' ? { ...shared, it_email_name, it_contact_email } : shared, mailConfigured: mailConfigured() });
});
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) throw httpError(400, 'New password must be at least 8 characters');
  if (req.user.password_hash && !(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw httpError(400, 'Current password is incorrect');
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), req.user.account_id);
  res.json({ ok: true });
}));
// Employee profile details are read-only (IT maintains them in People); only admins can edit their own. Passwords are separate.
app.put('/api/me', auth, (req, res) => {
  if (req.user.role !== 'admin') throw httpError(403, 'Your profile details are managed by IT. Ask IT to change them.');
  const { name, phone, department, title } = req.body;
  if (req.user.employee_id) {
    db.prepare('UPDATE employees SET name = COALESCE(?, name), phone = ?, department = ?, title = ? WHERE id = ?')
      .run(clean(name), clean(phone), clean(department), clean(title), req.user.employee_id);
  }
  res.json({ ok: true });
});

app.post('/api/forgot', (req, res) => {
  const a = db.prepare(`SELECT a.id, a.login_email, COALESCE(e.name, a.login_email) AS name FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.login_email = ? AND a.active = 1 AND (e.id IS NULL OR e.status = 'active')`).get(String(req.body.email || '').trim().toLowerCase());
  if (a) notify.passwordReset({ name: a.name, email: a.login_email }, `${APP_URL}/#/reset/${makeToken(a.id, 'reset', 1)}`);
  res.json({ ok: true }); // never reveal whether an account exists
});
app.post('/api/reset', wrap(async (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const t = db.prepare('SELECT * FROM tokens WHERE token = ?').get(String(token || ''));
  if (!t || t.expires_at < new Date().toISOString()) throw httpError(400, 'This link has expired. Ask for a new one.');
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), t.user_id);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(t.user_id);
  req.session.uid = t.user_id;
  res.json({ ok: true });
}));

// ---------- people (employees, with their optional login account) ----------
// /api/users is kept as the compatibility surface for the People screen; ids in it are EMPLOYEE ids.
// Future rule (not implemented — no external auth yet): a verified external login may link to a pre-provisioned
// employee by normalized (trim + lowercase) work email only; unknown logins never create an employee and are blocked.
// Admin only. Employees get no directory: no employee screen needs other people's names (self-checkout and requests always
// act as the signed-in employee), so exposing one would only leak who works here. Employees read their own record via
// GET /api/users/:id (which already refuses anyone else's).
app.get('/api/users', admin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM assignments s WHERE s.employee_id = p.id AND s.returned_at IS NULL) AS asset_count
    FROM (${PERSON_SQL}) p ORDER BY (p.status = 'active') DESC, p.name COLLATE NOCASE`).all();
  res.json(rows.map((r) => ({ ...publicPerson(r), asset_count: r.asset_count })));
});

// Creates the employee and, unless `login: false`, a linked login account (role admin|employee; legacy 'user' = employee).
app.post('/api/users', admin, (req, res) => {
  const name = clean(req.body.name); const email = normEmail(req.body.email);
  const wantsLogin = req.body.login !== false;
  if (!name) throw httpError(400, 'Name is required');
  if (email ? !isEmail(email) : wantsLogin) throw httpError(400, wantsLogin ? 'Name and a valid email are required' : 'That email address is not valid');
  if (email && db.prepare('SELECT 1 FROM employees WHERE work_email = ?').get(email)) throw httpError(400, 'A person with that email already exists');
  if (email && wantsLogin && db.prepare('SELECT 1 FROM accounts WHERE login_email = ?').get(email)) throw httpError(400, 'A login with that email already exists');
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const id = db.transaction(() => {
    const empId = db.prepare('INSERT INTO employees (name, work_email, department, title, phone, building) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, email, clean(req.body.department), clean(req.body.title), clean(req.body.phone), clean(req.body.building)).lastInsertRowid;
    if (wantsLogin) db.prepare('INSERT INTO accounts (employee_id, login_email, role) VALUES (?, ?, ?)').run(empId, email, role);
    return empId;
  })();
  const p = getPerson(id);
  if (wantsLogin && req.body.invite !== false) notify.welcome({ name: p.name, email: p.login_email }, `${APP_URL}/#/reset/${makeToken(p.account_id, 'reset', 24 * 7)}`);
  res.json(publicPerson(p));
});

// Give an existing employee a login. Links by explicit employee id; never creates a second employee.
app.post('/api/users/:id/account', admin, (req, res) => {
  const p = getPerson(Number(req.params.id));
  if (!p) throw httpError(404, 'Person not found');
  if (p.account_id) throw httpError(400, 'This person already has a login.');
  const email = normEmail(req.body.email) || p.work_email;
  if (!email || !isEmail(email)) throw httpError(400, 'A valid login email is required');
  if (db.prepare('SELECT 1 FROM accounts WHERE login_email = ?').get(email)) throw httpError(400, 'A login with that email already exists');
  if (email !== p.work_email && db.prepare('SELECT 1 FROM employees WHERE work_email = ? AND id != ?').get(email, p.id)) throw httpError(400, 'That email belongs to another person');
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  db.transaction(() => {
    if (!p.work_email) db.prepare('UPDATE employees SET work_email = ? WHERE id = ?').run(email, p.id);
    db.prepare('INSERT INTO accounts (employee_id, login_email, role) VALUES (?, ?, ?)').run(p.id, email, role);
  })();
  const q = getPerson(p.id);
  if (req.body.invite !== false) notify.welcome({ name: q.name, email: q.login_email }, `${APP_URL}/#/reset/${makeToken(q.account_id, 'reset', 24 * 7)}`);
  res.json(publicPerson(q));
});
const HISTORY_LIMIT = 200; // most recent returned assignments in a person's record (the employee History screen and the admin person page)
app.get('/api/users/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role !== 'admin' && id !== req.user.employee_id) throw httpError(403, 'Not allowed');
  const u = getPerson(id);
  if (!u) throw httpError(404, 'User not found');
  const current = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC`).all(id);
  const past = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NOT NULL ORDER BY s.returned_at DESC LIMIT ${HISTORY_LIMIT}`).all(id);
  res.json({ user: publicPerson(u), current, past, history_limit: HISTORY_LIMIT });
});
// Updates the person and, when they have one, their account (role, login email, login enabled). Nothing here deletes a person.
app.put('/api/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const u = getPerson(id);
  if (!u) throw httpError(404, 'User not found');
  const role = req.body.role === 'admin' ? 'admin' : (req.body.role === 'employee' || req.body.role === 'user') ? 'employee' : u.role;
  const active = req.body.active === undefined ? u.status === 'active' : !!req.body.active;
  if (u.account_id && u.account_id === req.user.account_id && (role !== 'admin' || !active)) throw httpError(400, "You can't remove your own admin access");
  const email = normEmail(req.body.email);
  if (email && !isEmail(email)) throw httpError(400, 'That email address is not valid');
  const workEmail = email || u.work_email;
  if (email && email !== u.work_email && db.prepare('SELECT 1 FROM employees WHERE work_email = ? AND id != ?').get(email, id)) throw httpError(400, 'That email is already in use');
  const loginEmail = u.account_id ? (email || u.login_email) : null;
  if (u.account_id && loginEmail !== u.login_email && db.prepare('SELECT 1 FROM accounts WHERE login_email = ? AND id != ?').get(loginEmail, u.account_id)) throw httpError(400, 'That email is already in use');
  db.transaction(() => {
    // building keeps its value when the client doesn't send the field; an empty string clears it
    const building = req.body.building === undefined ? u.building : clean(req.body.building);
    db.prepare('UPDATE employees SET name = ?, work_email = ?, department = ?, title = ?, phone = ?, building = ?, status = ? WHERE id = ?')
      .run(clean(req.body.name) || u.name, workEmail, clean(req.body.department), clean(req.body.title), clean(req.body.phone), building, active ? 'active' : 'inactive', id);
    if (u.account_id) db.prepare('UPDATE accounts SET login_email = ?, role = ?, active = ? WHERE id = ?').run(loginEmail, role, active ? 1 : 0, u.account_id);
  })();
  if (!active && u.account_id) db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"uid":${u.account_id}}%`);
  res.json(publicPerson(getPerson(id)));
});
// Per-employee self-checkout permission (default on). Admin only; never touches the employee's other fields.
app.put('/api/users/:id/self-checkout', admin, (req, res) => {
  const p = getPerson(Number(req.params.id));
  if (!p) throw httpError(404, 'Person not found');
  if (typeof req.body.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
  db.prepare('UPDATE employees SET can_self_checkout = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, p.id);
  res.json(publicPerson(getPerson(p.id)));
});
app.post('/api/users/:id/invite', admin, (req, res) => {
  const u = getPerson(Number(req.params.id));
  if (!u) throw httpError(404, 'User not found');
  if (!u.account_id) throw httpError(400, 'This person has no login. Give them one first.');
  const link = `${APP_URL}/#/reset/${makeToken(u.account_id, 'reset', 24 * 7)}`;
  notify.welcome({ name: u.name, email: u.login_email }, link);
  res.json({ ok: true, link: mailConfigured() ? undefined : link });
});

// ---------- assets ----------
const ASSET_LIST_SQL = `
  SELECT a.*,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS seats_used,
    (SELECT group_concat(u.name, ', ') FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS holder_names,
    (SELECT MIN(s.due_date) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL) AS due_date,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'permanent') AS permanent_holders,
    (SELECT COUNT(*) FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.assignment_type = 'checkout') AS checkout_holders,
    (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb
  FROM assets a`;

app.get('/api/assets', auth, (req, res) => {
  const where = []; const params = [];
  const isAdmin = req.user.role === 'admin';
  // Employees get ONE meaning for this list — "equipment I can get": in the shared pool (available_to_request), available, not archived, and not something I already
  // hold (that is My Equipment). So the status / holder filters below are admin tools and are ignored for employees; they
  // would otherwise be a way to probe other people's assignments (e.g. searching a multi-seat license by holder name).
  const { q, category } = req.query;
  const status = isAdmin ? req.query.status : undefined;
  const employeeFilter = isAdmin ? (req.query.employee_id || req.query.user_id) : undefined; // user_id kept as a compatibility alias
  if (typeof q === 'string' && q.trim()) {
    // Normalized, case-insensitive, token-wise: every word must match SOMEWHERE (substring) in any of the asset's tag, name, serial, brand, model, category,
    // location, or its catalog entry (the whole path and the search keywords of the entry and all its ancestors); IT also matches a holder's name.
    for (const token of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const ids = catalog.searchNodeIds(db, token, { liveOnly: !isAdmin });
      const cols = ['a.tag', 'a.name', 'a.serial', 'a.brand', 'a.model', 'a.location', 'a.category'];
      const like = `%${token.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}${ids.length ? ` OR a.catalog_node_id IN (${ids.join(',')})` : ''}${isAdmin
        ? " OR EXISTS (SELECT 1 FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL AND u.name LIKE ? ESCAPE '\\')" : ''})`);
      params.push(...cols.map(() => like)); if (isAdmin) params.push(like);
    }
  }
  if (category) { where.push('a.category = ?'); params.push(category); }
  if (req.query.catalog_node !== undefined && req.query.catalog_node !== '') {
    // Everything filed under a catalog entry or any of its descendants. Employees can only drill into live entries, and
    // only live descendants count for them (an archived sub-entry is invisible to them).
    const nodeId = Number(req.query.catalog_node);
    if (!Number.isInteger(nodeId) || !catalog.loadIndex(db).nodes.has(nodeId) || (!isAdmin && !catalog.isLive(db, nodeId))) throw httpError(404, 'Catalog entry not found');
    const ids = catalog.subtreeIds(db, nodeId).filter((i) => isAdmin || catalog.isLive(db, i));
    where.push(`a.catalog_node_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (status === 'overdue') { where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.due_date < date('now'))`); }
  else if (status === 'active') { where.push(`a.status NOT IN ('retired','lost','disposed')`); }
  else if (status) { where.push('a.status = ?'); params.push(status); }
  if (!(req.user.role === 'admin' && req.query.include_archived === '1')) where.push('a.archived_at IS NULL');
  if (employeeFilter) { where.push('EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)'); params.push(Number(employeeFilter)); }
  if (!isAdmin) {
    // The shared pool, for DISCOVERY: what IT made available_to_request, not archived, not already mine. Being checked out (temporarily), reserved or held does NOT
    // hide an asset (that is availability, shown on the row; the employee can open its calendar, reserve future days or join a waitlist). Equipment with a
    // permanent holder is still not part of the pool. `?available=1` narrows to what can be had right now (the "request this specific item" pickers).
    where.push(`a.available_to_request = 1 AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)
      AND (a.status = 'available' OR (a.status = 'checked_out' AND NOT EXISTS (SELECT 1 FROM assignments p WHERE p.asset_id = a.id AND p.returned_at IS NULL AND p.assignment_type = 'permanent')))`);
    params.push(req.user.employee_id);
    if (req.query.available === '1') where.push(`a.status = 'available'`);
  }
  const sql = `${ASSET_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.updated_at DESC LIMIT 1000`;
  const rows = db.prepare(sql).all(...params);
  const states = isAdmin ? null : availabilityLib.todayStates(db, rows); // employees: what each listed asset is today (see src/availability.js)
  res.json(rows.map((a) => { const out = sanitizeAsset(a, req.user); if (states) { const t = states.get(a.id); out.avail_state = t.state; out.expected_back = t.expected_back; } return out; }));
});

// Availability calendar (read-only): ?node=<catalog id> | ?asset=<asset id> | neither (everything), &month=YYYY-MM. The scope rules,
// the privacy narrowing for employees and the day states all live in src/availability.js. Not a way around asset visibility:
// GET /api/assets/:id is unchanged and employees still cannot open assets held by someone else.
app.get('/api/availability', auth, (req, res) => {
  const q = req.query;
  res.json(availabilityLib.availability(db, {
    isAdmin: req.user.role === 'admin', employeeId: req.user.employee_id || null,
    nodeId: q.node === undefined || q.node === '' ? undefined : q.node,
    assetId: q.asset === undefined || q.asset === '' ? undefined : q.asset,
    month: typeof q.month === 'string' ? q.month : undefined,
    canReserve: req.user.role !== 'admin' && !!req.user.employee_id, // (not tied to self-checkout permission) only the single-asset view acts on it
  }));
});

app.get('/api/assets/lookup/:code', auth, (req, res) => {
  const code = String(req.params.code).trim();
  // Archived assets are still found (their tags stay reserved); the flag lets clients say so.
  const a = db.prepare('SELECT id, archived_at FROM assets WHERE tag = ? COLLATE NOCASE').get(code)
    || (serialKey(code) && db.prepare('SELECT id, archived_at FROM assets WHERE serial_normalized = ?').get(serialKey(code)));
  // An employee only gets an id for assets they may open; for any other existing asset they learn just that it isn't
  // available (no id, no details), so the scanner can say so without exposing the record.
  if (a && !canViewAsset(req.user, getAsset(a.id))) return res.json({ found: false, unavailable: true, code });
  res.json(a ? { found: true, id: a.id, archived: !!a.archived_at } : { found: false, code });
});

// Preview only: creating an asset with a blank tag claims a number server-side, which may differ if others create first.
app.get('/api/next-tag', admin, (req, res) => res.json({ tag: peekTag() }));

app.get('/api/assets/:id', auth, (req, res) => {
  const a = visibleAsset(req, req.params.id);
  const holders = openAssignments(a.id);
  const isMine = holders.some((h) => h.employee_id === req.user.employee_id);
  const isAdmin = req.user.role === 'admin';
  const photos = db.prepare('SELECT * FROM photos WHERE asset_id = ? ORDER BY id').all(a.id);
  const requests = db.prepare(`
    SELECT r.*, u.name AS user_name, COALESCE(ca.employee_id = r.user_id, 0) AS self_initiated FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN accounts ca ON ca.id = r.created_by
    WHERE r.asset_id = ? AND r.status IN ('open','dropped_off') ORDER BY r.created_at DESC`).all(a.id)
    .filter((r) => isAdmin || r.user_id === req.user.employee_id);
  const requestsOut = requestRules.withLifecycle(db, requests);
  // Live reservations on this asset: IT sees all of them; an employee only their own (who else reserved it is not theirs to read here).
  const reservations = db.prepare(`${RESERVATION_SQL} WHERE r.asset_id = ? AND r.status IN ('pending','confirmed') AND r.end_date >= date('now') ORDER BY r.start_date, r.id`).all(a.id)
    .filter((r) => isAdmin || r.employee_id === req.user.employee_id).map((r) => reservationOut(r, req.user));
  const reserve = { allowed: !isAdmin && !!req.user.employee_id && reservationRules.reserveEligibility(a).ok, requires_approval: !!a.reservation_requires_approval };
  const activity = isAdmin ? db.prepare(`
    SELECT ac.*, ${ACTOR_NAME} FROM activity ac ${ACTOR_JOIN}
    WHERE ac.asset_id = ? ORDER BY ac.id DESC LIMIT 100`).all(a.id) : [];
  res.json({
    asset: { ...sanitizeAsset(a, req.user), permanent_holders: holders.filter((h) => h.assignment_type === 'permanent').length, checkout_holders: holders.filter((h) => h.assignment_type === 'checkout').length },
    holders: isAdmin ? holders : holders.filter((h) => h.employee_id === req.user.employee_id),
    held_by_other: !isAdmin && !isMine && holders.length >= capacity(a),
    seats_used: holders.length,
    capacity: capacity(a),
    is_mine: isMine,
    photos,
    requests: requestsOut,
    reservations,
    reserve,
    activity,
  });
});

// The two per-asset reservation settings (admin only). Strictly boolean-ish so a typo can't silently turn something on.
const FLAGS = ['available_to_request', 'reservation_requires_approval'];
function flagValue(body, key, current) {
  const v = body[key];
  if (v === undefined) return current ? 1 : 0;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw httpError(400, `${key === 'available_to_request' ? 'Available to request' : 'Require approval for reservations'} must be on or off`);
}
const ASSET_FIELDS = ['name', 'category', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor',
  'warranty_expires', 'license_key', 'license_seats', 'license_expires', 'notes'];
function assetValues(body) {
  const v = {};
  for (const f of ['category', 'location']) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') throw httpError(400, `${f === 'category' ? 'Category' : 'Location'} must be text`);
  }
  if (body.serial !== undefined && body.serial !== null && !['string', 'number'].includes(typeof body.serial)) throw httpError(400, 'Serial number must be text');
  for (const f of ASSET_FIELDS) v[f] = ['purchase_cost', 'license_seats'].includes(f) ? num(body[f]) : clean(body[f]);
  v.serial = cleanSerial(body.serial); // trimmed; blank => no serial
  return v;
}

// The catalog entry for an asset write. Not in the body => unchanged. null/'' => unlinked. Otherwise it must be a live entry
// (an asset keeps its current entry even if that has since been archived, so editing other fields still works).
function resolveAssetNode(body, current) {
  if (!('catalog_node_id' in body)) return current ?? null;
  const raw = body.catalog_node_id;
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || !catalog.loadIndex(db).nodes.has(id)) throw httpError(400, 'Choose a valid catalog entry');
  if (id !== (current ?? null) && !catalog.isLive(db, id)) throw httpError(400, 'That catalog entry is archived. Choose an active one.');
  return id;
}

app.post('/api/assets', admin, (req, res) => {
  const v = assetValues(req.body);
  if (!v.name) throw httpError(400, 'Give the asset a name');
  v.category = v.category || 'Other';
  v.condition = v.condition || 'Good';
  // No entry chosen: file the asset under the live top-level category its category text names (the same rule the migration
  // applied to existing assets), so a category's contents are complete. An unknown category is left unlinked — never invented.
  const nodeId = resolveAssetNode(req.body, null) ?? catalog.findLiveByPath(db, v.category);
  if (nodeId !== null) v.category = catalog.rootOf(db, nodeId).name; // the category text always follows the catalog root
  const status = ['maintenance', 'retired', 'lost'].includes(req.body.status) ? req.body.status : 'available';
  const flags = FLAGS.map((f) => flagValue(req.body, f, 0)); // both default OFF
  const cols = ['tag', 'status', 'serial_normalized', 'catalog_node_id', ...FLAGS, ...ASSET_FIELDS];
  // Number claim + insert are one transaction: a failed create rolls the counter back, and two creates can't share a tag.
  const create = db.transaction(() => {
    const tag = clean(req.body.tag) || allocateTag();
    const used = db.prepare('SELECT archived_at FROM assets WHERE tag = ?').get(tag);
    if (used) throw httpError(400, used.archived_at ? `Tag ${tag} belongs to an archived asset and can't be reused` : `Tag ${tag} is already used by another asset`);
    assertSerialFree(v.serial);
    const info = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f]));
    log(info.lastInsertRowid, req.user.account_id, 'created', `${tag} · ${v.name}`);
    return info.lastInsertRowid;
  });
  res.json(getAsset(create.immediate()));
});

app.put('/api/assets/:id', admin, (req, res) => {
  const a = getAsset(Number(req.params.id));
  if (!a) throw httpError(404, 'Asset not found');
  if (a.archived_at) throw httpError(400, 'This asset is archived and can\'t be edited.');
  const v = assetValues({ ...a, ...req.body });
  const nodeId = resolveAssetNode(req.body, a.catalog_node_id);
  if (nodeId !== null) v.category = catalog.rootOf(db, nodeId).name;
  // Asset tags are immutable once created (a case-only difference is ignored). No retag workflow exists yet.
  const sentTag = clean(req.body.tag);
  if (sentTag && sentTag.toLowerCase() !== a.tag.toLowerCase()) throw httpError(400, "An asset's tag can't be changed once it's created.");
  const tag = a.tag;
  const flags = FLAGS.map((f) => flagValue(req.body, f, a[f]));
  let status = a.status;
  if (req.body.status && req.body.status !== a.status) {
    const open = openAssignments(a.id).length;
    if (['maintenance', 'retired', 'lost', 'disposed'].includes(req.body.status)) {
      // `lost` may stay assigned (keeps accountability); the other states need the assignment resolved first.
      if (open && req.body.status !== 'lost') {
        throw httpError(400, ['retired', 'disposed'].includes(req.body.status)
          ? `Check this asset in before marking it ${req.body.status}.` : 'Check this asset in before changing its status');
      }
      status = req.body.status;
    } else if (['available', 'checked_out'].includes(req.body.status)) status = open >= capacity({ ...a, ...v }) ? 'checked_out' : 'available';
  }
  db.transaction(() => {
    assertSerialFree(v.serial, a.id);
    db.prepare(`UPDATE assets SET tag = ?, status = ?, serial_normalized = ?, catalog_node_id = ?, ${FLAGS.map((f) => `${f} = ?`).join(', ')}, ${ASSET_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(tag, status, serialKey(v.serial), nodeId, ...flags, ...ASSET_FIELDS.map((f) => v[f]), a.id);
  }).immediate();
  const changed = ['tag', 'status', ...ASSET_FIELDS].filter((f) => String((f === 'tag' ? tag : f === 'status' ? status : v[f]) ?? '') !== String(a[f] ?? ''));
  if ((a.catalog_node_id ?? null) !== nodeId) changed.push('catalog');
  FLAGS.forEach((f, i) => { if (flags[i] !== (a[f] ? 1 : 0)) changed.push(f === 'available_to_request' ? `available to request ${flags[i] ? 'on' : 'off'}` : `reservation approval ${flags[i] ? 'required' : 'not required'}`); });
  if (changed.length) log(a.id, req.user.account_id, 'edited', changed.filter((f) => f !== 'license_key').join(', ') || 'license key');
  refreshStatus(a.id);
  res.json(getAsset(a.id));
});

// Assets are never permanently deleted: "delete" archives. The row, tag, assignments, activity, photos and
// requests all remain, and the tag stays reserved. The DELETE route is kept as an alias for compatibility.
function archiveAsset(req, res) {
  const a = getAsset(Number(req.params.id));
  if (!a) throw httpError(404, 'Asset not found');
  if (a.archived_at) throw httpError(400, 'This asset is already archived.');
  if (openAssignments(a.id).length) throw httpError(400, 'Check this asset in before archiving it.');
  const reason = clean(req.body && req.body.reason);
  db.transaction(() => {
    db.prepare("UPDATE assets SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(a.id);
    log(a.id, req.user.account_id, 'archived', `${a.tag} · ${a.name}${reason ? ` · ${reason}` : ''}`);
  })();
  res.json({ ok: true });
}
app.post('/api/assets/:id/archive', admin, archiveAsset);
app.delete('/api/assets/:id', admin, archiveAsset);

app.post('/api/assets/:id/checkout', auth, (req, res) => {
  const asset = visibleAsset(req, req.params.id);
  let target;
  if (req.user.role === 'admin') {
    target = getPerson(Number(req.body.employee_id || req.body.user_id)); // user_id kept as a compatibility alias
    if (!target || target.status !== 'active') throw httpError(400, 'Choose who this is going to');
  } else {
    target = req.user.employee_id && getPerson(req.user.employee_id);
    if (!target) throw httpError(403, "Your login isn't linked to an employee record. Ask IT.");
    // Permission is per employee (admin-controlled, default on). The old global setting is deprecated and ignored.
    if (!target.can_self_checkout) throw httpError(403, 'Self-checkout is not enabled for your account. Please request this item from IT.');
  }
  // Permanent assignments are admin-only (also enforced in createAssignment). A non-admin self check-out is always a
  // temporary checkout; explicitly asking for permanent is refused rather than silently changed.
  const assignment_type = req.user.role === 'admin' ? req.body.assignment_type : (req.body.assignment_type || 'checkout');
  const assignment = doCheckout({ asset, user: target, actor: req.user, assignment_type, due_date: req.body.due_date, due_time: req.body.due_time, notes: req.body.notes, condition: req.body.condition });
  // Close the employee's open equipment request for this asset — unless it asked for a permanent assignment and this
  // was a temporary checkout (a loan must not silently complete a request for something else).
  requestRules.completeEquipmentRequests(db, { employeeId: target.id, assetId: asset.id, assignmentType: assignment.assignment_type, actorAccountId: req.user.account_id, actorIsAdmin: req.user.role === 'admin' });
  res.json({ ok: true, assignment });
});

app.post('/api/assets/:id/checkin', admin, (req, res) => {
  const asset = getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const open = openAssignments(asset.id);
  if (!open.length) throw httpError(400, 'This asset is not checked out');
  const target = req.body.assignment_id ? open.find((o) => o.id === Number(req.body.assignment_id)) : open.length === 1 ? open[0] : null;
  if (!target) throw httpError(400, 'Choose which person is returning it');
  const condition = clean(req.body.condition);
  // Ending the assignment and completing the employee's return request succeed or fail together.
  db.transaction(() => {
    db.prepare("UPDATE assignments SET returned_at = datetime('now'), returned_to = ?, condition_in = ?, return_notes = ? WHERE id = ?")
      .run(req.user.account_id, condition, clean(req.body.notes), target.id);
    if (condition) db.prepare('UPDATE assets SET condition = ? WHERE id = ?').run(condition, asset.id);
    if (req.body.to_maintenance) db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(asset.id);
    else if (asset.status === 'lost') db.prepare("UPDATE assets SET status = 'available' WHERE id = ?").run(asset.id);
    refreshStatus(asset.id);
    if (clean(req.body.location)) db.prepare('UPDATE assets SET location = ? WHERE id = ?').run(clean(req.body.location), asset.id);
    requestRules.completeReturnRequests(db, { employeeId: target.employee_id, assetId: asset.id, actorAccountId: req.user.account_id, actorIsAdmin: true });
  }).immediate();
  log(asset.id, req.user.account_id, 'checked_in', `From ${target.user_name} · ${assignments.TYPE_LABEL[target.assignment_type]}${target.due_date ? ` · return was due ${assignments.returnBy(target.due_date, target.due_time)}` : ''}${condition ? ` · condition ${condition}` : ''}${req.body.notes ? ` · ${req.body.notes}` : ''}`, target.employee_id);
  notify.checkedIn({ name: target.user_name, email: target.user_email }, asset);
  res.json({ ok: true });
});

app.post('/api/assets/:id/request-return', admin, (req, res) => {
  const asset = getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const open = openAssignments(asset.id);
  const wanted = req.body.employee_id || req.body.user_id; // user_id kept as a compatibility alias
  const targets = wanted ? open.filter((o) => o.employee_id === Number(wanted)) : open;
  if (!targets.length) throw httpError(400, 'Nobody currently has this asset');
  const created = [];
  for (const t of targets) {
    if (db.prepare("SELECT 1 FROM requests WHERE type='return' AND asset_id=? AND user_id=? AND status IN ('open','dropped_off')").get(asset.id, t.employee_id)) continue;
    const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, message, needed_by, created_by) VALUES ('return', ?, ?, ?, ?, ?)")
      .run(t.employee_id, asset.id, clean(req.body.message), clean(req.body.needed_by), req.user.account_id);
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
    log(asset.id, req.user.account_id, 'return_requested', `From ${t.user_name}${r.needed_by ? ` · by ${r.needed_by}` : ''}`, t.employee_id);
    notify.returnRequested({ name: t.user_name, email: t.user_email }, asset, r);
    created.push(r);
  }
  if (!created.length) throw httpError(400, 'A return has already been requested');
  res.json({ ok: true, created: created.length });
});

// ---------- photos ----------
const upload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
app.post('/api/assets/:id/photos', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const asset = getAsset(Number(req.params.id));
  const cleanup = () => (req.files || []).forEach((f) => fs.rm(f.path, () => {}));
  if (!asset || !canViewAsset(req.user, asset)) { cleanup(); throw httpError(404, 'Asset not found'); }
  const holder = db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, req.user.employee_id);
  if (req.user.role !== 'admin' && !holder) { cleanup(); throw httpError(403, 'Only IT or the person holding this asset can add photos'); }
  if (!req.files?.length) throw httpError(400, 'No image received');
  const saved = [];
  for (const f of req.files) {
    const base = `${asset.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await sharp(f.path).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(UPLOAD_DIR, base + '.jpg'));
      await sharp(f.path).rotate().resize({ width: 400, height: 400, fit: 'cover' }).jpeg({ quality: 75 }).toFile(path.join(UPLOAD_DIR, base + '_t.jpg'));
    } catch (e) { fs.rm(f.path, () => {}); continue; }
    fs.rm(f.path, () => {});
    const info = db.prepare('INSERT INTO photos (asset_id, filename, thumb, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)')
      .run(asset.id, base + '.jpg', base + '_t.jpg', clean(req.body.caption), req.user.account_id);
    saved.push(info.lastInsertRowid);
  }
  if (!saved.length) throw httpError(400, "Couldn't read that image");
  log(asset.id, req.user.account_id, 'photo_added', `${saved.length} photo${saved.length > 1 ? 's' : ''}`);
  db.prepare("UPDATE assets SET updated_at = datetime('now') WHERE id = ?").run(asset.id);
  res.json({ ok: true, ids: saved });
}));
app.delete('/api/photos/:id', admin, (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
  if (!p) throw httpError(404, 'Photo not found');
  for (const f of [p.filename, p.thumb]) fs.rm(path.join(UPLOAD_DIR, f), () => {});
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  db.prepare('UPDATE assets SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(p.id);
  res.json({ ok: true });
});
app.put('/api/assets/:id/cover', admin, (req, res) => {
  const asset = getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const raw = req.body.photo_id;
  let photoId = null; // null/empty clears the cover
  if (raw !== undefined && raw !== null && raw !== '') {
    photoId = Number(raw);
    if (!Number.isInteger(photoId) || photoId < 1) throw httpError(400, 'Choose a valid photo');
    const photo = db.prepare('SELECT asset_id FROM photos WHERE id = ?').get(photoId);
    if (!photo) throw httpError(404, 'Photo not found');
    if (photo.asset_id !== asset.id) throw httpError(400, 'That photo belongs to a different asset');
  }
  db.prepare('UPDATE assets SET cover_photo_id = ? WHERE id = ?').run(photoId, asset.id);
  res.json({ ok: true });
});
// Photo files follow the asset's visibility: an employee can fetch a photo only if its asset is one they may see.
app.use('/uploads', (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).end();
  if (u.role === 'admin') return next();
  let file; try { file = path.basename(decodeURIComponent(req.path)); } catch { return res.status(404).end(); }
  const photo = db.prepare('SELECT asset_id FROM photos WHERE filename = ? OR thumb = ?').get(file, file);
  if (!photo || !canViewAsset(u, getAsset(photo.asset_id))) return res.status(404).end();
  next();
}, express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// ---------- reservations (Phase 2, slice 7) ----------
// Rules, transactions and conflict checks live in src/reservations.js. These routes only identify the caller and shape the answers.
// Employees reserve through the same visibility contract as everything else (an asset they can't see is a 404), and only manage their own.
const RESERVATION_SQL = `
  SELECT r.*, a.name AS asset_name, a.tag AS asset_tag, e.name AS employee_name, e.department AS employee_department,
    COALESCE(dn.name, da.login_email) AS decided_by_name
  FROM reservations r JOIN assets a ON a.id = r.asset_id JOIN employees e ON e.id = r.employee_id
  LEFT JOIN accounts da ON da.id = r.decided_by LEFT JOIN employees dn ON dn.id = da.employee_id`;
// `phase`, `can_cancel` and `can_shorten` are the server's own answers, so the UI never has to guess a rule.
function reservationOut(r, user) {
  const t = reservationRules.todayOf(db);
  const mine = !!user.employee_id && r.employee_id === user.employee_id;
  const live = reservationRules.LIVE.includes(r.status) && r.end_date >= t;
  const lastDay = r.start_date > t ? r.start_date : t; // the earliest end date a shortening may pick
  return {
    ...r, phase: reservationRules.phaseOf(r, t), mine,
    can_cancel: live && (user.role === 'admin' || mine),
    can_shorten: mine && r.status === 'confirmed' && r.end_date >= t && r.end_date > lastDay,
    shorten_min: lastDay,
    ...(user.role === 'admin' ? {} : { employee_department: undefined, decided_by_name: undefined }),
  };
}
const reservationById = (id, user) => reservationOut(db.prepare(`${RESERVATION_SQL} WHERE r.id = ?`).get(id), user);
app.get('/api/reservations', auth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const st = req.query.status;
  if (st !== undefined && !['open', 'closed'].includes(st)) throw httpError(400, 'Status must be open or closed');
  const t = reservationRules.todayOf(db);
  const where = []; const params = [];
  if (!isAdmin) { where.push('r.employee_id = ?'); params.push(req.user.employee_id); }
  const open = "(r.status = 'pending' OR (r.status = 'confirmed' AND r.end_date >= ?))";
  if (st === 'open') { where.push(open); params.push(t); } else if (st === 'closed') { where.push(`NOT ${open}`); params.push(t); }
  const order = st === 'closed' ? 'r.end_date DESC, r.id DESC' : `CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.start_date, r.id`;
  res.json(db.prepare(`${RESERVATION_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 300`).all(...params).map((r) => reservationOut(r, req.user)));
});
// An employee may reserve anything the availability calendar shows them: in the shared pool (available_to_request), not archived, 'available' OR
// currently 'checked_out' (reserving is how you claim FUTURE dates of an item someone has out now). This does not open the asset page or its
// record to them (canViewAsset / GET /api/assets/:id are unchanged); reservations.create still enforces every eligibility rule.
function reservableAsset(req, id) {
  const a = getAsset(Number(id));
  if (!a) throw httpError(404, 'Asset not found');
  if (req.user.role === 'admin' || canViewAsset(req.user, a)) return a;
  if (a.available_to_request && !a.archived_at && ['available', 'checked_out'].includes(a.status)) return a;
  throw httpError(404, 'Asset not found');
}
app.post('/api/assets/:id/reservations', auth, (req, res) => {
  const asset = reservableAsset(req, req.params.id);
  const r = reservationRules.create(db, {
    assetId: asset.id, employeeId: req.user.employee_id, actorAccountId: req.user.account_id,
    start: req.body.start_date, end: req.body.end_date,
  });
  res.json(reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/approve', admin, (req, res) => {
  const r = reservationRules.approve(db, Number(req.params.id), { actorAccountId: req.user.account_id, note: clean(req.body.note) });
  res.json(reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/decline', admin, (req, res) => {
  const r = reservationRules.decline(db, Number(req.params.id), { actorAccountId: req.user.account_id, note: clean(req.body.note) });
  waitlistRules.dispatchHoldEmails(db); // (declining may have offered the dates to the next person in line)
  res.json(reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/cancel', auth, (req, res) => {
  const r = reservationRules.cancel(db, Number(req.params.id), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, isAdmin: req.user.role === 'admin' });
  waitlistRules.dispatchHoldEmails(db);
  res.json(reservationById(r.id, req.user));
});
app.post('/api/reservations/:id/shorten', auth, (req, res) => {
  const r = reservationRules.shorten(db, Number(req.params.id), { actorAccountId: req.user.account_id, employeeId: req.user.employee_id, newEnd: req.body.end_date });
  waitlistRules.dispatchHoldEmails(db);
  res.json(reservationById(r.id, req.user));
});

// ---------- waitlist + availability holds (Phase 2, slice 8) ----------
// Rules live in src/waitlist.js. There is deliberately NO route that asks, or lets anyone ask, a current reserver to give anything up.
// An employee manages only their own entries; IT can see every entry and remove one, never reorder or answer for the employee.
// "What would happen if I asked for these dates?" for the date sheet: reserve (all free), waitlist (blocked by a reservation / hold) or a refusal. Writes nothing.
app.get('/api/assets/:id/range-check', auth, (req, res) => {
  const asset = reservableAsset(req, req.params.id);
  res.json(waitlistRules.rangeCheck(db, { assetId: asset.id, employeeId: req.user.employee_id, start: req.query.start_date, end: req.query.end_date, excludeEntryId: Number(req.query.entry_id) || 0 }));
});
app.get('/api/reservation-counts', auth, (req, res) => res.json(waitlistRules.counts(db, req.user)));
app.put('/api/waitlist/:id', auth, (req, res) => {
  const e = waitlistRules.updateDates(db, Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id, start: req.body.start_date, end: req.body.end_date });
  res.json(waitlistRules.get(db, e.id, req.user));
});
app.post('/api/assets/:id/waitlist', auth, (req, res) => {
  const asset = reservableAsset(req, req.params.id);
  const { entry } = waitlistRules.join(db, { assetId: asset.id, employeeId: req.user.employee_id, actorAccountId: req.user.account_id, start: req.body.start_date, end: req.body.end_date });
  res.json(waitlistRules.get(db, entry.id, req.user));
});
app.get('/api/waitlist', auth, (req, res) => res.json(waitlistRules.list(db, req.user, { status: req.query.status })));
app.get('/api/waitlist/:id', auth, (req, res) => res.json(waitlistRules.get(db, Number(req.params.id), req.user)));
app.post('/api/waitlist/:id/confirm', auth, (req, res) => {
  const { entry, reservation } = waitlistRules.confirmHold(db, Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id });
  res.json({ entry: waitlistRules.get(db, entry.id, req.user), reservation: reservationById(reservation.id, req.user) });
});
app.post('/api/waitlist/:id/decline', auth, (req, res) => {
  const e = waitlistRules.declineHold(db, Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id });
  res.json(waitlistRules.get(db, e.id, req.user));
});
app.post('/api/waitlist/:id/cancel', auth, (req, res) => {
  const e = waitlistRules.leave(db, Number(req.params.id), { employeeId: req.user.employee_id, actorAccountId: req.user.account_id, isAdmin: req.user.role === 'admin' });
  res.json(waitlistRules.get(db, e.id, req.user));
});

// ---------- equipment catalog ----------
// One tree, one API, for every screen (phone drill-down, desktop columns, the asset form, the admin editor).
// Employees get only LIVE entries (not archived, no archived ancestor) and no admin-only counts; admins can ask for everything.
const heldByMe = (user) => (user.employee_id ? 'AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)' : '');
// IT's catalog search: entries whose name, whole path or search keywords (own + ancestors') contain every word typed, shallowest first, each with its full path so
// an ambiguous match (an "EOS R5" under Camera > Canon) makes sense. Archived entries are included and flagged. Admin only.
app.get('/api/catalog/search', admin, (req, res) => {
  const tokens = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return res.json({ total: 0, results: [] });
  const { nodes } = catalog.loadIndex(db);
  const direct = new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c]));
  const hits = [];
  for (const n of nodes.values()) {
    const text = catalog.searchText(db, n.id);
    if (!tokens.every((t) => text.includes(t))) continue;
    const own = `${n.name} ${n.search_keywords || ''}`.toLowerCase();
    hits.push({ n, depth: catalog.depthOf(db, n.id), own: tokens.every((t) => own.includes(t)) });
  }
  hits.sort((a, b) => (b.own - a.own) || a.depth - b.depth || a.n.name.localeCompare(b.n.name));
  const results = hits.slice(0, 60).map(({ n }) => ({
    id: n.id, name: n.name, path: catalog.pathText(db, n.id), search_keywords: n.search_keywords || '', archived: !!n.archived_at || !catalog.isLive(db, n.id),
    asset_count: catalog.subtreeIds(db, n.id).reduce((t, i) => t + (direct.get(i) || 0), 0),
    via_keyword: !!n.search_keywords && tokens.some((t) => n.search_keywords.includes(t) && !n.name.toLowerCase().includes(t)),
  }));
  res.json({ total: hits.length, results });
});
app.get('/api/catalog', auth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const withArchived = isAdmin && req.query.include_archived === '1';
  const { nodes, children } = catalog.loadIndex(db);
  // Per entry: assets filed directly under it that this viewer could get right now (the Browse contract: available, in the shared
  // pool for employees, not archived, not already theirs), then rolled up through the ancestors so a broad entry shows its whole subtree's count.
  const direct = new Map();
  for (const r of db.prepare(`SELECT a.catalog_node_id id, COUNT(*) c FROM assets a WHERE a.archived_at IS NULL AND a.status = 'available' AND a.catalog_node_id IS NOT NULL ${isAdmin ? '' : 'AND a.available_to_request = 1'} ${heldByMe(req.user)} GROUP BY a.catalog_node_id`)
    .all(...(req.user.employee_id ? [req.user.employee_id] : []))) direct.set(r.id, r.c);
  const availableIn = (id) => catalog.subtreeIds(db, id).filter((i) => isAdmin || catalog.isLive(db, i)).reduce((n, i) => n + (direct.get(i) || 0), 0);
  // Admin counts. asset_count = non-archived assets filed at the entry OR anywhere below it — exactly what
  // GET /api/assets?catalog_node=ID lists for an admin, so the number and the visible contents always agree.
  // direct_asset_count = assets filed at this very entry, archived ones included — what blocks a delete.
  const adminCounts = isAdmin ? {
    active: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE archived_at IS NULL AND catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
    assets: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM assets WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
    requests: new Map(db.prepare('SELECT catalog_node_id id, COUNT(*) c FROM requests WHERE catalog_node_id IS NOT NULL GROUP BY catalog_node_id').all().map((r) => [r.id, r.c])),
  } : null;
  const out = [];
  for (const n of nodes.values()) {
    const live = catalog.isLive(db, n.id);
    if (!live && !withArchived) continue;
    const kids = (children.get(n.id) || []).filter((i) => isAdmin ? (withArchived || catalog.isLive(db, i)) : catalog.isLive(db, i));
    out.push({
      id: n.id, parent_id: n.parent_id, name: n.name, path: catalog.pathText(db, n.id), child_count: kids.length, available_count: availableIn(n.id),
      ...(isAdmin ? { search_keywords: n.search_keywords || '', archived_at: n.archived_at, live, asset_count: catalog.subtreeIds(db, n.id).reduce((t, i) => t + (adminCounts.active.get(i) || 0), 0), direct_asset_count: adminCounts.assets.get(n.id) || 0, request_count: adminCounts.requests.get(n.id) || 0 } : {}),
    });
  }
  res.json(out);
});
// Keeps assets.category (kept for display/filters/import) equal to the name of the root of the entry they are filed under,
// after a rename or move. History is never touched: requests keep the path text they were made with.
function syncAssetCategories(nodeId) {
  const upd = db.prepare('UPDATE assets SET category = ? WHERE catalog_node_id = ? AND category <> ?');
  for (const id of catalog.subtreeIds(db, nodeId)) { const root = catalog.rootOf(db, id).name; upd.run(root, id, root); }
}
const catalogOut = (id) => { const n = catalog.getNode(db, id); return { id: n.id, parent_id: n.parent_id, name: n.name, search_keywords: n.search_keywords || '', path: catalog.pathText(db, n.id), archived_at: n.archived_at, live: catalog.isLive(db, n.id), ...catalog.usage(db, n.id) }; };
app.post('/api/catalog', admin, (req, res) => {
  const parentId = catalog.parseParent(req.body.parent_id);
  const id = db.transaction(() => catalog.createNode(db, { name: req.body.name, parentId: parentId ?? null, searchKeywords: req.body.search_keywords })).immediate();
  res.json(catalogOut(id));
});
app.put('/api/catalog/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => { catalog.updateNode(db, id, { name: req.body.name, parentId: catalog.parseParent(req.body.parent_id), searchKeywords: req.body.search_keywords }); syncAssetCategories(id); }).immediate();
  res.json(catalogOut(id));
});
app.post('/api/catalog/:id/archive', admin, (req, res) => { const id = Number(req.params.id); catalog.archiveNode(db, id); res.json(catalogOut(id)); });
app.post('/api/catalog/:id/restore', admin, (req, res) => { const id = Number(req.params.id); catalog.restoreNode(db, id); res.json(catalogOut(id)); });
app.delete('/api/catalog/:id', admin, (req, res) => { catalog.deleteNode(db, Number(req.params.id)); res.json({ ok: true }); });

// ---------- requests ----------
app.get('/api/requests', auth, (req, res) => {
  const where = []; const params = [];
  if (req.user.role !== 'admin') { where.push('r.user_id = ?'); params.push(req.user.employee_id); }
  if (req.query.status !== undefined && !['open', 'closed'].includes(req.query.status)) throw httpError(400, 'Status must be open or closed');
  if (req.query.type !== undefined && !['equipment', 'return', 'issue'].includes(req.query.type)) throw httpError(400, 'Type must be equipment, return or issue');
  if (req.query.status === 'open') where.push("r.status IN ('open','approved','dropped_off')");
  else if (req.query.status === 'closed') where.push("r.status IN ('denied','completed','cancelled')");
  if (req.query.type) { where.push('r.type = ?'); params.push(req.query.type); }
  // `self_initiated`: the employee started this themselves (vs. IT asking). `can_cancel`: the server's own answer to
  // "may this viewer cancel it right now", so the UI never has to guess the rule.
  const rows = db.prepare(`
    SELECT r.*, u.name AS user_name, u.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, COALESCE(c.name, ca.login_email) AS created_by_name, COALESCE(rv.name, ra.login_email) AS resolved_by_name,
      COALESCE(ca.employee_id = r.user_id, 0) AS self_initiated
    FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN accounts ca ON ca.id = r.created_by LEFT JOIN employees c ON c.id = ca.employee_id
    LEFT JOIN accounts ra ON ra.id = r.resolved_by LEFT JOIN employees rv ON rv.id = ra.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('open','dropped_off','approved') THEN 0 ELSE 1 END, r.created_at DESC LIMIT 500`).all(...params);
  res.json(requestRules.withLifecycle(db, rows.map((r) => ({ ...r, can_cancel: requestRules.LIVE.includes(r.status) && !cancelBlock(r, req.user) }))));
});
app.post('/api/requests', auth, (req, res) => {
  let category = clean(req.body.category);
  const message = clean(req.body.message);
  let nodeId = null; // what was asked for in the catalog (any level); asset_id set as well => a specific item, else "any matching"
  if (req.body.catalog_node_id !== undefined && req.body.catalog_node_id !== null && req.body.catalog_node_id !== '') {
    nodeId = Number(req.body.catalog_node_id);
    if (!Number.isInteger(nodeId) || nodeId < 1 || !catalog.isLive(db, nodeId)) throw httpError(400, 'Choose equipment from the catalog list');
  }
  if (!category && !message && nodeId === null) throw httpError(400, 'Tell IT what you need');
  const forUser = req.user.role === 'admin' && req.body.user_id ? Number(req.body.user_id) : req.user.employee_id;
  if (forUser === null) throw httpError(400, "Your login isn't linked to an employee record. Choose who the request is for.");
  const assetId = num(req.body.asset_id);
  const wantedType = clean(req.body.requested_assignment_type);
  if (wantedType && !assignments.ASSIGNMENT_TYPES.includes(wantedType)) throw httpError(400, 'Requested assignment type must be permanent or checkout');
  if (wantedType === 'permanent' && assetId === null) throw httpError(400, 'Choose the equipment you want assigned permanently');
  if (!Number.isInteger(forUser) || forUser < 1) throw httpError(400, 'Choose a valid person for this request');
  if (assetId !== null && (!Number.isInteger(assetId) || assetId < 1)) throw httpError(400, 'Choose a valid asset');
  const forPerson = db.prepare('SELECT status FROM employees WHERE id = ?').get(forUser);
  if (!forPerson) throw httpError(404, 'User not found');
  if (forPerson.status !== 'active') throw httpError(400, 'That person is inactive, so a request can\'t be made for them');
  const wanted = assetId === null ? null : getAsset(assetId);
  if (assetId !== null && (!wanted || !canViewAsset(req.user, wanted))) throw httpError(404, 'Asset not found'); // an employee can only ask for equipment they can see
  if (wanted && wanted.archived_at) throw httpError(400, 'This asset is archived and can\'t be requested.');
  if (wanted && nodeId !== null) {
    // A specific item picked under a catalog selection: it must really be filed under that entry, and an employee may only
    // pick what they could get anyway (available, not archived, not theirs already) — never something someone else holds.
    if (req.user.role !== 'admin' && (wanted.status !== 'available' || db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(wanted.id, forUser))) throw httpError(404, 'Asset not found');
    if (!catalog.subtreeIds(db, nodeId).includes(wanted.catalog_node_id)) throw httpError(400, "That item isn't part of the equipment you chose.");
  } else if (wanted && wanted.catalog_node_id && catalog.isLive(db, wanted.catalog_node_id)) {
    nodeId = wanted.catalog_node_id; // asked for one particular item (e.g. from its page): record where it sits in the catalog
  }
  // Snapshots, so the request still reads the same after a rename, a move or an asset edit.
  const catalogPath = nodeId !== null ? catalog.pathText(db, nodeId) : null;
  if (nodeId !== null) category = catalog.rootOf(db, nodeId).name;
  const assetLabel = wanted ? `${wanted.tag} — ${wanted.name}` : null;
  // A permanent-assignment request only records the ask; nothing is assigned until an admin approves it.
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, category, message, needed_by, created_by, requested_assignment_type, catalog_node_id, catalog_path, asset_label) VALUES ('equipment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(forUser, assetId, category || (wantedType === 'permanent' ? wanted.category : null), message, clean(req.body.needed_by), req.user.account_id, wantedType, nodeId, catalogPath, assetLabel);
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
  if (assetId) log(assetId, req.user.account_id, 'requested', `${wantedType === 'permanent' ? 'Permanent assignment requested' : (message || catalogPath || category || 'Requested')}${wantedType === 'permanent' && message ? ` · ${message}` : ''}`, forUser);
  notify.equipmentRequested(getPerson(forUser), r);
  res.json(r);
});
function loadRequest(id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id));
  if (!r) throw httpError(404, 'Request not found');
  return r;
}
// IT opens a request (the admin detail view calls this when it is shown). Sets opened_at once — that is what ends the
// employee's right to rescind — and is a no-op on later calls and on closed requests. Admin only; never a GET side effect.
app.post('/api/requests/:id/open', admin, (req, res) => {
  const r = requestRules.openRequest(db, Number(req.params.id));
  res.json(requestRules.withLifecycle(db, r));
});
app.post('/api/requests/:id/approve', admin, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.type !== 'equipment') throw httpError(400, 'This request is not open');
  if (!requestRules.canTransition('equipment', r.status, 'approved') && !requestRules.canTransition('equipment', r.status, 'completed')) {
    throw httpError(400, requestRules.TERMINAL.includes(r.status) ? 'This request is already closed' : 'This request is not open');
  }
  const user = getPerson(r.user_id);
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
  const asset = assetId ? getAsset(assetId) : null;
  if (assetId && !asset) throw httpError(404, 'Asset not found');
  // Fulfilling (an asset is attached) must hand over what was asked for. A request that named one item (asset_id is only
  // ever set on an unfulfilled request when a specific item was requested) is fulfilled with that item and no other; an
  // "any matching" request takes any asset filed under the catalog entry that was asked for. Availability, archived and
  // seat rules are enforced by createAssignment inside the transaction below.
  if (asset && r.asset_id !== null && asset.id !== r.asset_id) throw httpError(400, `This request is for a specific item (${r.asset_label || 'the one that was requested'}). It can only be fulfilled with that item.`);
  if (asset && r.asset_id === null && r.catalog_node_id !== null && !catalog.subtreeIds(db, r.catalog_node_id).includes(asset.catalog_node_id)) {
    throw httpError(400, `That asset isn't part of the equipment that was requested${r.catalog_path ? ` (${r.catalog_path})` : ''}. Choose a matching asset.`);
  }
  const note = clean(req.body.note);
  // The assignment (if any) and the request's completion succeed or fail together; emails go out only after commit.
  const assignment = db.transaction(() => {
    const made = asset ? assignments.createAssignment(db, {
      assetId: asset.id, employeeId: user.id, actorAccountId: req.user.account_id, actorIsAdmin: true,
      type: assignmentType, dueDate: req.body.due_date, dueTime: req.body.due_time, notes: `Request #${r.id}`,
    }).assignment : null;
    requestRules.transition(db, r.id, asset ? 'completed' : 'approved', { actorAccountId: req.user.account_id, actorIsAdmin: true, note, setNote: true, assetId: asset ? asset.id : null });
    return made;
  }).immediate();
  if (assignment) notify.checkedOut(user, getAsset(asset.id), assignment);
  // When an asset is attached the checkout email already went out; only send the approval note if no asset yet or a note was added
  if (!asset || note) notify.requestResolved(user, { ...r, status: asset ? 'completed' : 'approved', resolution_note: note }, asset);
  res.json({ ok: true });
});
app.post('/api/requests/:id/deny', admin, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.type !== 'equipment') throw httpError(400, 'Only equipment requests can be declined. Cancel a return request instead.');
  const note = clean(req.body.note);
  requestRules.transition(db, r.id, 'denied', { actorAccountId: req.user.account_id, actorIsAdmin: true, note, setNote: true });
  notify.requestResolved(getPerson(r.user_id), { ...r, status: 'denied', resolution_note: note });
  res.json({ ok: true });
});
// Resolves an issue report. Issues have no approve/deny: IT either resolves one (here) or dismisses it (cancel).
app.post('/api/requests/:id/resolve', admin, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.type !== 'issue') throw httpError(400, 'Only issue reports can be marked resolved');
  requestRules.transition(db, r.id, 'completed', { actorAccountId: req.user.account_id, actorIsAdmin: true, note: clean(req.body.note), setNote: true });
  log(r.asset_id, req.user.account_id, 'issue_resolved', clean(req.body.note) || 'Marked resolved', r.user_id);
  res.json({ ok: true });
});
const isSelfInitiated = (r) => !!db.prepare('SELECT 1 FROM accounts WHERE id = ? AND employee_id = ?').get(r.created_by, r.user_id);
// Rescind/cancel policy, one place for the route and for the `can_cancel` flag on the list. Returns null when `user` may
// cancel `r` in its current state, otherwise { status, msg }. (Status transitions themselves are guarded by requests.js.)
//
//   admin     any live request (IT's authority is unchanged)
//   employee  only their OWN request, and only while it is live and nothing has happened to it yet:
//               equipment  open | approved (a permanent request that IT already approved/assigned is final)
//               return     only one the employee started themselves, and only while 'open' — once they say they dropped
//                          it off, or when IT is the one who asked, they answer with "I've dropped it off", not a cancel
//               issue      open
//             AND IT must not have opened it yet (requests.opened_at, Phase 2 Slice 5): once IT has opened or acted on a
//             request the employee can no longer rescind it. The same condition is part of the UPDATE in requests.transition,
//             so IT opening it and the employee rescinding it at the same instant cannot both win.
function cancelBlock(r, user) {
  const isAdmin = user.role === 'admin';
  if (!isAdmin && r.user_id !== user.employee_id) return { status: 403, msg: 'Not allowed' };
  // Once IT's approval of a PERMANENT-assignment request has been acted on, it can't be rescinded (and history can never
  // read "cancelled" for a request whose approval made the assignment). Approval completes the request in the same
  // transaction as the assignment, so this only bites on an approved row (e.g. legacy data) — an employee may rescind a
  // permanent request only while it is still open; and nobody may cancel one that already produced its assignment.
  if (r.type === 'equipment' && r.requested_assignment_type === 'permanent' && ['approved', 'completed'].includes(r.status)) {
    const assigned = r.asset_id && db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND notes = ?').get(r.asset_id, r.user_id, `Request #${r.id}`);
    if (assigned || !isAdmin) return { status: 400, msg: 'IT has already approved this permanent assignment request, so it can no longer be cancelled. Ask IT if the equipment should come back.' };
  }
  if (!isAdmin && r.opened_at) return { status: 400, msg: requestRules.OPENED_MSG };
  if (!isAdmin && r.type === 'return') {
    if (!(r.self_initiated ?? isSelfInitiated(r))) return { status: 403, msg: 'Not allowed' };
    if (r.status !== 'open') return { status: 400, msg: "You've already told IT you dropped this off, so this can't be cancelled. Ask IT if that was a mistake." };
  }
  return null;
}
// Rescind/cancel: the person who made a request may cancel their own while it is still eligible (see cancelBlock); IT may
// cancel any live request. A cancelled request stays in history — nothing is deleted.
app.post('/api/requests/:id/cancel', auth, (req, res) => {
  const r = loadRequest(req.params.id);
  const block = cancelBlock(r, req.user);
  if (block) throw httpError(block.status, block.msg);
  const isIT = req.user.role === 'admin';
  requestRules.transition(db, r.id, 'cancelled', { actorAccountId: req.user.account_id, actorIsAdmin: isIT, requireUnopened: !isIT });
  res.json({ ok: true });
});
app.post('/api/requests/:id/dropped-off', auth, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.user_id !== req.user.employee_id && req.user.role !== 'admin') throw httpError(403, 'Not allowed');
  if (r.type !== 'return') throw httpError(400, 'This request is not open');
  requestRules.transition(db, r.id, 'dropped_off', { actorIsAdmin: req.user.role === 'admin' });
  const asset = getAsset(r.asset_id);
  if (asset) {
    log(asset.id, req.user.account_id, 'dropped_off', clean(req.body.note) || 'User says it was dropped off', r.user_id);
    notify.droppedOff(getPerson(r.user_id), asset);
  }
  res.json({ ok: true });
});
// ---- employee actions on equipment they currently hold (Phase 2, Slice 2) ----
// The asset must be visible to the caller AND checked out to the caller right now. Anything else is refused on the server;
// a hidden button is never the authorization. (A visible-but-not-held asset is a 400, an invisible one a 404.)
function heldAsset(req) {
  const asset = visibleAsset(req, req.params.id);
  const me = req.user.employee_id;
  if (!me || !db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me)) {
    throw httpError(400, "This isn't checked out to you");
  }
  return asset;
}
// "Request return": the employee asks to give a held asset back. Creates the same live 'return' request IT can create
// (status 'open', shown as "Return requested"); the assignment is NOT ended — it ends only when IT checks the asset in.
// The employee later taps "I've dropped it off" (existing). One live return request per asset + employee, so a second
// tap — or one while IT has already asked — is refused instead of creating a conflicting row.
app.post('/api/assets/:id/my-return-request', auth, (req, res) => {
  const asset = heldAsset(req);
  const me = req.user.employee_id;
  const live = db.prepare("SELECT status FROM requests WHERE type = 'return' AND asset_id = ? AND user_id = ? AND status IN ('open','dropped_off')").get(asset.id, me);
  if (live) throw httpError(400, live.status === 'dropped_off' ? "You've already told IT you dropped this off." : 'A return has already been requested for this item.');
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, message, created_by) VALUES ('return', ?, ?, ?, ?)").run(me, asset.id, clean(req.body.message), req.user.account_id);
  log(asset.id, req.user.account_id, 'return_requested', `${req.user.name} asked to return it${clean(req.body.message) ? ` · ${clean(req.body.message)}` : ''}`, me);
  res.json(db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid));
});
// "Report issue": a short description tied to one held asset. It is a request of type 'issue' in the same queue IT already
// works from (open -> resolved by IT, or withdrawn by the employee). No comments, attachments, priorities or SLAs.
const ISSUE_MAX = 1000;
app.post('/api/assets/:id/report-issue', auth, (req, res) => {
  const asset = heldAsset(req);
  const me = req.user.employee_id;
  const message = clean(req.body.message);
  if (!message) throw httpError(400, 'Describe the issue so IT knows what is wrong');
  if (message.length > ISSUE_MAX) throw httpError(400, `Please keep the description under ${ISSUE_MAX} characters`);
  if (db.prepare("SELECT 1 FROM requests WHERE type = 'issue' AND status = 'open' AND asset_id = ? AND user_id = ? AND message = ?").get(asset.id, me, message)) {
    throw httpError(400, "You've already reported this issue and it's still open.");
  }
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, category, message, created_by) VALUES ('issue', ?, ?, ?, ?, ?)").run(me, asset.id, asset.category, message, req.user.account_id);
  log(asset.id, req.user.account_id, 'issue_reported', message.length > 160 ? `${message.slice(0, 157)}…` : message, me);
  res.json(db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid));
});
// A user can proactively say "I'm returning this" without being asked
app.post('/api/assets/:id/return-notice', auth, (req, res) => {
  const asset = visibleAsset(req, req.params.id);
  const me = req.user.employee_id;
  const mine = me && db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me);
  if (!mine) throw httpError(400, "This isn't checked out to you");
  const existing = db.prepare("SELECT * FROM requests WHERE type='return' AND asset_id=? AND user_id=? AND status IN ('open','dropped_off')").get(asset.id, me);
  if (existing) { if (existing.status === 'open') requestRules.transition(db, existing.id, 'dropped_off'); }
  else db.prepare("INSERT INTO requests (type, status, user_id, asset_id, message, created_by) VALUES ('return', 'dropped_off', ?, ?, ?, ?)")
    .run(me, asset.id, clean(req.body.note) || 'Returned by user', req.user.account_id);
  log(asset.id, req.user.account_id, 'dropped_off', clean(req.body.note) || 'User returned it to IT', me);
  notify.droppedOff(req.user, asset);
  res.json({ ok: true });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, (req, res) => {
  const mine = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial, a.location, a.brand, a.model, a.id AS asset_id,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb,
      (SELECT r.id FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_request_id,
      (SELECT r.status FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_status,
      (SELECT r.needed_by FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_by,
      (SELECT r.message FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_message,
      (SELECT COALESCE(ca.employee_id = r.user_id, 0) FROM requests r LEFT JOIN accounts ca ON ca.id = r.created_by WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_self,
      (SELECT r.id FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open' ORDER BY r.id DESC LIMIT 1) AS issue_request_id,
      (SELECT COUNT(*) FROM requests r WHERE r.type='issue' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status = 'open') AS open_issues
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC`).all(req.user.employee_id);
  const myRequests = db.prepare(`SELECT * FROM requests WHERE user_id = ? AND type = 'equipment' AND status IN ('open','approved') ORDER BY created_at DESC`).all(req.user.employee_id).map((r) => requestRules.withLifecycle(db, r));
  const out = { mine, myRequests };
  if (req.user.role === 'admin') {
    const c = (sql, ...p) => db.prepare(sql).get(...p).c;
    out.stats = {
      total: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL"),
      available: c("SELECT COUNT(*) c FROM assets WHERE status = 'available' AND archived_at IS NULL"),
      checked_out: c("SELECT COUNT(DISTINCT asset_id) c FROM assignments WHERE returned_at IS NULL"),
      maintenance: c("SELECT COUNT(*) c FROM assets WHERE status = 'maintenance' AND archived_at IS NULL"),
      overdue: c("SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL AND due_date < date('now')"),
      open_requests: c("SELECT COUNT(*) c FROM requests WHERE status IN ('open','approved','dropped_off')"),
      users: c("SELECT COUNT(*) c FROM employees WHERE status = 'active'"),
      value: db.prepare("SELECT COALESCE(SUM(purchase_cost),0) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL").get().c,
      warranty_soon: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND warranty_expires BETWEEN date('now') AND date('now','+60 day')"),
      licenses_soon: c("SELECT COUNT(*) c FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND license_expires BETWEEN date('now') AND date('now','+60 day')"),
    };
    out.byCategory = db.prepare("SELECT category, COUNT(*) n FROM assets WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL GROUP BY category ORDER BY n DESC").all();
    out.overdue = db.prepare(`
      SELECT s.*, a.name AS asset_name, a.tag, u.name AS user_name FROM assignments s
      JOIN assets a ON a.id = s.asset_id JOIN employees u ON u.id = s.employee_id
      WHERE s.returned_at IS NULL AND s.due_date < date('now') ORDER BY s.due_date LIMIT 20`).all();
    out.openRequests = db.prepare(`
      SELECT r.*, u.name AS user_name, a.name AS asset_name, a.tag AS asset_tag FROM requests r
      JOIN employees u ON u.id = r.user_id LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.status IN ('open','approved','dropped_off') ORDER BY r.created_at DESC LIMIT 20`).all().map((r) => requestRules.withLifecycle(db, r));
    out.expiring = db.prepare(`
      SELECT id, tag, name, category, warranty_expires, license_expires FROM assets
      WHERE status NOT IN ('retired','lost','disposed') AND archived_at IS NULL AND (warranty_expires BETWEEN date('now') AND date('now','+60 day') OR license_expires BETWEEN date('now') AND date('now','+60 day'))
      ORDER BY MIN(COALESCE(warranty_expires,'9999'), COALESCE(license_expires,'9999')) LIMIT 20`).all();
    out.activity = db.prepare(`
      SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
      ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
      ORDER BY ac.id DESC LIMIT 15`).all();
  }
  res.json(out);
});

// ---------- settings, email, import/export ----------
app.get('/api/settings', admin, (req, res) => res.json({ ...getSettings(), mailConfigured: mailConfigured(), appUrl: APP_URL, mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || null, mailEnvelope: mailEnvelope(), mailTestRecipient: testRecipient() }));
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
app.put('/api/settings', admin, (req, res) => {
  const b = req.body;
  if (Object.keys(b).some((k) => CREDENTIAL_KEY.test(k))) throw httpError(400, 'Email passwords, keys and secrets are not stored here. Set them in the server environment (see the README).');
  const it = itEmailSettings(b); // validate everything new BEFORE anything is saved
  for (const [k, v] of Object.entries(it)) setSetting(k, v);
  if (b.overdue_reminders !== undefined) setSetting('overdue_reminders', b.overdue_reminders ? '1' : '0');
  if (b.default_loan_days !== undefined) setSetting('default_loan_days', String(Math.max(0, parseInt(b.default_loan_days, 10) || 0)));
  if (b.tag_prefix !== undefined) setSetting('tag_prefix', String(b.tag_prefix).trim().slice(0, 10));
  if (Array.isArray(b.categories)) setSetting('categories', b.categories.map((s) => String(s).trim()).filter(Boolean));
  if (Array.isArray(b.locations)) setSetting('locations', b.locations.map((s) => String(s).trim()).filter(Boolean));
  res.json(getSettings());
});
app.post('/api/settings/test-email', admin, wrap(async (req, res) => {
  await notify.test(req.user.email);
  const last = db.prepare('SELECT status, error FROM outbox ORDER BY id DESC LIMIT 1').get();
  res.json(last);
}));
app.get('/api/outbox', admin, (req, res) => {
  res.json(db.prepare('SELECT id, to_addr, subject, status, error, delivered_to, created_at FROM outbox ORDER BY id DESC LIMIT 100').all());
});
app.get('/api/activity', admin, (req, res) => {
  res.json(db.prepare(`
    SELECT ac.*, ${ACTOR_NAME}, a.name AS asset_name, a.tag FROM activity ac
    ${ACTOR_JOIN} LEFT JOIN assets a ON a.id = ac.asset_id
    ORDER BY ac.id DESC LIMIT ?`).all(Math.min(1000, Number(req.query.limit) || 200)));
});

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
app.get('/api/export/assets.csv', admin, (req, res) => {
  const rows = db.prepare(`${ASSET_LIST_SQL} WHERE a.archived_at IS NULL ORDER BY a.tag`).all();
  const cols = ['tag', 'name', 'category', 'status', 'holder_names', 'due_date', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor', 'warranty_expires', 'license_seats', 'seats_used', 'license_expires', 'notes', 'catalog_path'];
  for (const r of rows) r.catalog_path = r.catalog_node_id ? catalog.pathText(db, r.catalog_node_id) : '';
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
app.post('/api/import/assets', admin, (req, res) => {
  const rows = parseCsv(String(req.body || ''));
  if (rows.length < 2) throw httpError(400, 'The file needs a header row and at least one asset');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''));
  const alias = { asset_tag: 'tag', serial_number: 'serial', s_n: 'serial', type: 'category', manufacturer: 'brand', cost: 'purchase_cost', price: 'purchase_cost', warranty: 'warranty_expires', seats: 'license_seats', assigned_to: 'assigned_email', email: 'assigned_email', catalog: 'catalog_path' };
  const keys = header.map((h) => alias[h] || h);
  let created = 0, updated = 0; const errors = [];
  // assigned_email matches an active employee by work email (or their login email); no login is needed to receive equipment.
  const users = new Map();
  for (const u of db.prepare("SELECT e.id, e.name, e.work_email, a.login_email FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id WHERE e.status = 'active'").all()) {
    for (const k of [u.work_email, u.login_email]) if (k) users.set(k.toLowerCase(), u);
  }
  const tx = db.transaction(() => {
    rows.slice(1).forEach((r, idx) => {
      const o = {}; keys.forEach((k, i) => { o[k] = r[i]; });
      if (o.purchase_cost) o.purchase_cost = String(o.purchase_cost).replace(/[$,]/g, '');
      const v = assetValues(o);
      const tag = clean(o.tag);
      const existing = tag ? db.prepare('SELECT * FROM assets WHERE tag = ?').get(tag) : null;
      if (existing && existing.archived_at) { errors.push(`Row ${idx + 2}: tag ${tag} belongs to an archived asset — skipped`); return; }
      if (!v.name && !existing) { errors.push(`Row ${idx + 2}: missing name`); return; }
      if (!existing) { v.category = v.category || 'Other'; v.condition = v.condition || 'Good'; }
      // A serial that belongs to a different asset (already in the inventory, archived or not, or earlier in this file)
      // skips just this row; an update that leaves the serial blank keeps the stored one.
      try { assertSerialFree(v.serial, existing ? existing.id : null); } catch (e) { errors.push(`Row ${idx + 2}: ${e.message.split('. ')[0]} — skipped`); return; }
      let id;
      if (existing) {
        db.prepare(`UPDATE assets SET ${ASSET_FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ')}, serial_normalized = COALESCE(?, serial_normalized), updated_at = datetime('now') WHERE id = ?`)
          .run(...ASSET_FIELDS.map((f) => v[f]), serialKey(v.serial), existing.id);
        id = existing.id; updated++;
      } else {
        const cols = ['tag', 'serial_normalized', ...ASSET_FIELDS];
        id = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(tag || allocateTag(), serialKey(v.serial), ...ASSET_FIELDS.map((f) => v[f])).lastInsertRowid;
        log(id, req.user.account_id, 'created', 'Imported from CSV'); created++;
        const home = clean(o.catalog_path) ? null : catalog.findLiveByPath(db, v.category); // same default as a manual create (the category's root), unless the row named a path
        if (home) db.prepare('UPDATE assets SET catalog_node_id = ?, category = ? WHERE id = ?').run(home, catalog.rootOf(db, home).name, id);
      }
      // catalog_path ("Laptop > Mac > MacBook Air") must match an active entry exactly (ignoring case/spacing); otherwise the
      // row is still imported but the link is left alone and the row is reported — nothing is guessed.
      const cpath = clean(o.catalog_path);
      if (cpath) {
        const nid = catalog.findLiveByPath(db, cpath);
        if (nid) db.prepare('UPDATE assets SET catalog_node_id = ?, category = ? WHERE id = ?').run(nid, catalog.rootOf(db, nid).name, id);
        else errors.push(`Row ${idx + 2}: catalog path “${cpath}” doesn't match an active catalog entry — imported without a catalog link`);
      }
      const em = clean(o.assigned_email)?.toLowerCase();
      if (em && users.has(em) && !openAssignments(id).length) {
        const u = users.get(em);
        db.prepare("INSERT INTO assignments (asset_id, employee_id, assignment_type, checked_out_by, notes) VALUES (?, ?, 'permanent', ?, ?)").run(id, u.id, req.user.account_id, 'Imported');
        refreshStatus(id);
        log(id, req.user.account_id, 'checked_out', `To ${u.name} (import)`, u.id);
      } else if (em && !users.has(em)) errors.push(`Row ${idx + 2}: no user with email ${em} — imported unassigned`);
    });
  });
  tx();
  res.json({ created, updated, errors });
});

// ---------- overdue reminders ----------
function overdueSweep() {
  if (!getSettings().overdue_reminders) return;
  const rows = db.prepare(`
    SELECT s.*, u.name AS user_name, COALESCE(u.work_email, ac.login_email) AS user_email FROM assignments s
    JOIN employees u ON u.id = s.employee_id LEFT JOIN accounts ac ON ac.employee_id = u.id
    WHERE s.returned_at IS NULL AND s.due_date IS NOT NULL AND s.due_date < date('now')
      AND (s.last_overdue_notice IS NULL OR s.last_overdue_notice <= date('now','-3 day')) AND u.status = 'active'`).all();
  for (const s of rows) {
    const a = getAsset(s.asset_id);
    notify.overdue({ name: s.user_name, email: s.user_email }, a, s);
    db.prepare("UPDATE assignments SET last_overdue_notice = date('now') WHERE id = ?").run(s.id);
  }
}
setInterval(overdueSweep, 3600e3).unref();
setTimeout(overdueSweep, 15e3).unref();

// ---------- waitlist sweep ----------
// Records holds that ran out, offers free dates to the next person in line (this is what notices a check-in or a changed asset setting, which
// do not touch the waitlist directly) and sends any hold email still owed. Idempotent, so running it often is harmless.
function waitlistSweep() { try { waitlistRules.sweep(db); } catch (e) { console.error('[waitlist:sweep]', e.message); } }
setInterval(waitlistSweep, 60e3).unref();
setTimeout(waitlistSweep, 20e3).unref();

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
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  // (Express 5 hands a listen failure to this callback as `err`; it must not print the success banner then. The 'error' handler below reports it.)
  const server = app.listen(PORT, (err) => {
    if (err) return;
    console.log(`Nutricost IT Assets running on http://localhost:${PORT}  (APP_URL=${APP_URL})`);
    if (DEV) console.log('Dev mode: this server restarts itself when backend files change; the browser caches nothing and no service worker is kept. Just refresh the page.');
    else if (process.env.npm_lifecycle_event === 'start' && process.env.NODE_ENV !== 'production') console.log('Note: `npm start` does NOT restart on code changes. For development use `npm run dev` (auto-restart, no stale browser cache).');
    console.log(mailConfigured() ? `Email: sending via ${process.env.SMTP_HOST || 'smtp.gmail.com'} as ${process.env.SMTP_USER}` : 'Email: NOT configured — messages are logged to the Outbox (Settings → Email).');
  });
  // Another server already owns this port: say so plainly. (Otherwise the browser keeps talking to the OLD process, which looks exactly like "my change didn't show up".)
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`\nPort ${PORT} is already in use by another process, so THIS server did not start and the browser is still talking to the old one.\nFind it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN   then stop it (kill <PID>) and start again, or choose another port with PORT=<number>.\n`);
    process.exit(1);
  });
}

module.exports = app;
