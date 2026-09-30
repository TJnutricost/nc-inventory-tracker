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
const { notify, APP_URL, mailConfigured } = require('./mailer');
const assignments = require('./assignments');

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
      COALESCE(e.name, a.login_email) AS name, e.department, e.title, e.phone, e.created_at, COALESCE(e.can_self_checkout, 0) AS can_self_checkout
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
const publicMe = (u) => ({ can_self_checkout: !!u.can_self_checkout, id: u.employee_id, account_id: u.account_id, employee_id: u.employee_id, name: u.name, email: u.email, role: u.role, department: u.department, title: u.title, phone: u.phone, active: true, created_at: u.created_at, last_login_at: u.last_login_at, has_password: !!u.password_hash });

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

// Fields a non-admin should not see
function sanitizeAsset(a, user) {
  if (!a) return a;
  if (user.role === 'admin') return a;
  const mine = db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(a.id, user.employee_id);
  const { purchase_cost, vendor, notes, ...rest } = a;
  if (!mine) delete rest.license_key;
  return rest;
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
  res.json({ user: publicMe(req.user), settings: getSettings(), mailConfigured: mailConfigured() });
});
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) throw httpError(400, 'New password must be at least 8 characters');
  if (req.user.password_hash && !(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw httpError(400, 'Current password is incorrect');
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), req.user.account_id);
  res.json({ ok: true });
}));
app.put('/api/me', auth, (req, res) => {
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
app.get('/api/users', auth, (req, res) => {
  // Everyone can see a minimal directory (names) — admins get details + counts
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM assignments s WHERE s.employee_id = p.id AND s.returned_at IS NULL) AS asset_count
    FROM (${PERSON_SQL}) p ORDER BY (p.status = 'active') DESC, p.name COLLATE NOCASE`).all();
  if (req.user.role !== 'admin') return res.json(rows.filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.name })));
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
    WHERE s.employee_id = ? AND s.returned_at IS NOT NULL ORDER BY s.returned_at DESC LIMIT 50`).all(id);
  res.json({ user: publicPerson(u), current, past });
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
  const { q, category, status } = req.query;
  const employeeFilter = req.query.employee_id || req.query.user_id; // user_id kept as a compatibility alias
  if (q) {
    where.push(`(a.tag LIKE ? OR a.name LIKE ? OR a.serial LIKE ? OR a.brand LIKE ? OR a.model LIKE ? OR a.location LIKE ?
      OR EXISTS (SELECT 1 FROM assignments s JOIN employees u ON u.id = s.employee_id WHERE s.asset_id = a.id AND s.returned_at IS NULL AND u.name LIKE ?))`);
    const like = `%${q}%`; params.push(like, like, like, like, like, like, like);
  }
  if (category) { where.push('a.category = ?'); params.push(category); }
  if (status === 'overdue') { where.push(`EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.returned_at IS NULL AND s.due_date < date('now'))`); }
  else if (status === 'active') { where.push(`a.status NOT IN ('retired','lost','disposed')`); }
  else if (status) { where.push('a.status = ?'); params.push(status); }
  if (!(req.user.role === 'admin' && req.query.include_archived === '1')) where.push('a.archived_at IS NULL');
  if (employeeFilter) { where.push('EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL)'); params.push(Number(employeeFilter)); }
  if (req.user.role !== 'admin') {
    // Users see what they hold and what's available to borrow
    where.push(`(a.status = 'available' OR EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id = a.id AND s.employee_id = ? AND s.returned_at IS NULL))`);
    params.push(req.user.employee_id);
  }
  const sql = `${ASSET_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.updated_at DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...params).map((a) => sanitizeAsset(a, req.user)));
});

app.get('/api/assets/lookup/:code', auth, (req, res) => {
  const code = String(req.params.code).trim();
  // Archived assets are still found (their tags stay reserved); the flag lets clients say so.
  const a = db.prepare('SELECT id, archived_at FROM assets WHERE tag = ? COLLATE NOCASE').get(code)
    || db.prepare('SELECT id, archived_at FROM assets WHERE serial = ? COLLATE NOCASE').get(code);
  res.json(a ? { found: true, id: a.id, archived: !!a.archived_at } : { found: false, code });
});

// Preview only: creating an asset with a blank tag claims a number server-side, which may differ if others create first.
app.get('/api/next-tag', admin, (req, res) => res.json({ tag: peekTag() }));

app.get('/api/assets/:id', auth, (req, res) => {
  const a = getAsset(Number(req.params.id));
  if (!a) throw httpError(404, 'Asset not found');
  const holders = openAssignments(a.id);
  const isMine = holders.some((h) => h.employee_id === req.user.employee_id);
  const isAdmin = req.user.role === 'admin';
  const photos = db.prepare('SELECT * FROM photos WHERE asset_id = ? ORDER BY id').all(a.id);
  const requests = db.prepare(`
    SELECT r.*, u.name AS user_name FROM requests r JOIN employees u ON u.id = r.user_id
    WHERE r.asset_id = ? AND r.status IN ('open','dropped_off') ORDER BY r.created_at DESC`).all(a.id)
    .filter((r) => isAdmin || r.user_id === req.user.employee_id);
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
    requests,
    activity,
  });
});

const ASSET_FIELDS = ['name', 'category', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor',
  'warranty_expires', 'license_key', 'license_seats', 'license_expires', 'notes'];
function assetValues(body) {
  const v = {};
  for (const f of ['category', 'location']) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') throw httpError(400, `${f === 'category' ? 'Category' : 'Location'} must be text`);
  }
  for (const f of ASSET_FIELDS) v[f] = ['purchase_cost', 'license_seats'].includes(f) ? num(body[f]) : clean(body[f]);
  return v;
}

app.post('/api/assets', admin, (req, res) => {
  const v = assetValues(req.body);
  if (!v.name) throw httpError(400, 'Give the asset a name');
  v.category = v.category || 'Other';
  v.condition = v.condition || 'Good';
  const status = ['maintenance', 'retired', 'lost'].includes(req.body.status) ? req.body.status : 'available';
  const cols = ['tag', 'status', ...ASSET_FIELDS];
  // Number claim + insert are one transaction: a failed create rolls the counter back, and two creates can't share a tag.
  const create = db.transaction(() => {
    const tag = clean(req.body.tag) || allocateTag();
    const used = db.prepare('SELECT archived_at FROM assets WHERE tag = ?').get(tag);
    if (used) throw httpError(400, used.archived_at ? `Tag ${tag} belongs to an archived asset and can't be reused` : `Tag ${tag} is already used by another asset`);
    const info = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(tag, status, ...ASSET_FIELDS.map((f) => v[f]));
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
  // Asset tags are immutable once created (a case-only difference is ignored). No retag workflow exists yet.
  const sentTag = clean(req.body.tag);
  if (sentTag && sentTag.toLowerCase() !== a.tag.toLowerCase()) throw httpError(400, "An asset's tag can't be changed once it's created.");
  const tag = a.tag;
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
  db.prepare(`UPDATE assets SET tag = ?, status = ?, ${ASSET_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(tag, status, ...ASSET_FIELDS.map((f) => v[f]), a.id);
  const changed = ['tag', 'status', ...ASSET_FIELDS].filter((f) => String((f === 'tag' ? tag : f === 'status' ? status : v[f]) ?? '') !== String(a[f] ?? ''));
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
  const asset = getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
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
  // Close any open equipment request from this user that named this asset
  db.prepare("UPDATE requests SET status='completed', resolved_by=?, resolved_at=datetime('now') WHERE type='equipment' AND status IN ('open','approved') AND user_id=? AND asset_id=?")
    .run(req.user.account_id, target.id, asset.id);
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
  db.prepare("UPDATE assignments SET returned_at = datetime('now'), returned_to = ?, condition_in = ?, return_notes = ? WHERE id = ?")
    .run(req.user.account_id, condition, clean(req.body.notes), target.id);
  if (condition) db.prepare('UPDATE assets SET condition = ? WHERE id = ?').run(condition, asset.id);
  if (req.body.to_maintenance) db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(asset.id);
  else if (asset.status === 'lost') db.prepare("UPDATE assets SET status = 'available' WHERE id = ?").run(asset.id);
  refreshStatus(asset.id);
  if (clean(req.body.location)) db.prepare('UPDATE assets SET location = ? WHERE id = ?').run(clean(req.body.location), asset.id);
  db.prepare("UPDATE requests SET status = 'completed', resolved_by = ?, resolved_at = datetime('now') WHERE type = 'return' AND asset_id = ? AND user_id = ? AND status IN ('open','dropped_off')")
    .run(req.user.account_id, asset.id, target.employee_id);
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
  if (!asset) { cleanup(); throw httpError(404, 'Asset not found'); }
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
app.use('/uploads', (req, res, next) => (currentUser(req) ? next() : res.status(401).end()),
  express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// ---------- requests ----------
app.get('/api/requests', auth, (req, res) => {
  const where = []; const params = [];
  if (req.user.role !== 'admin') { where.push('r.user_id = ?'); params.push(req.user.employee_id); }
  if (req.query.status === 'open') where.push("r.status IN ('open','approved','dropped_off')");
  else if (req.query.status === 'closed') where.push("r.status IN ('denied','completed','cancelled')");
  if (req.query.type) { where.push('r.type = ?'); params.push(req.query.type); }
  res.json(db.prepare(`
    SELECT r.*, u.name AS user_name, u.department AS user_department, a.name AS asset_name, a.tag AS asset_tag, COALESCE(c.name, ca.login_email) AS created_by_name, COALESCE(rv.name, ra.login_email) AS resolved_by_name
    FROM requests r JOIN employees u ON u.id = r.user_id
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN accounts ca ON ca.id = r.created_by LEFT JOIN employees c ON c.id = ca.employee_id
    LEFT JOIN accounts ra ON ra.id = r.resolved_by LEFT JOIN employees rv ON rv.id = ra.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN r.status IN ('open','dropped_off','approved') THEN 0 ELSE 1 END, r.created_at DESC LIMIT 500`).all(...params));
});
app.post('/api/requests', auth, (req, res) => {
  const category = clean(req.body.category);
  const message = clean(req.body.message);
  if (!category && !message) throw httpError(400, 'Tell IT what you need');
  const forUser = req.user.role === 'admin' && req.body.user_id ? Number(req.body.user_id) : req.user.employee_id;
  if (forUser === null) throw httpError(400, "Your login isn't linked to an employee record. Choose who the request is for.");
  const assetId = num(req.body.asset_id);
  const wantedType = clean(req.body.requested_assignment_type);
  if (wantedType && !assignments.ASSIGNMENT_TYPES.includes(wantedType)) throw httpError(400, 'Requested assignment type must be permanent or checkout');
  if (wantedType === 'permanent' && assetId === null) throw httpError(400, 'Choose the equipment you want assigned permanently');
  if (!Number.isInteger(forUser) || forUser < 1) throw httpError(400, 'Choose a valid person for this request');
  if (assetId !== null && (!Number.isInteger(assetId) || assetId < 1)) throw httpError(400, 'Choose a valid asset');
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(forUser)) throw httpError(404, 'User not found');
  if (assetId !== null && !getAsset(assetId)) throw httpError(404, 'Asset not found');
  // A permanent-assignment request only records the ask; nothing is assigned until an admin approves it.
  const info = db.prepare("INSERT INTO requests (type, user_id, asset_id, category, message, needed_by, created_by, requested_assignment_type) VALUES ('equipment', ?, ?, ?, ?, ?, ?, ?)")
    .run(forUser, assetId, category || (wantedType === 'permanent' ? getAsset(assetId).category : null), message, clean(req.body.needed_by), req.user.account_id, wantedType);
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
  if (assetId) log(assetId, req.user.account_id, 'requested', `${wantedType === 'permanent' ? 'Permanent assignment requested' : (message || category || 'Requested')}${wantedType === 'permanent' && message ? ` · ${message}` : ''}`, forUser);
  notify.equipmentRequested(getPerson(forUser), r);
  res.json(r);
});
function loadRequest(id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id));
  if (!r) throw httpError(404, 'Request not found');
  return r;
}
app.post('/api/requests/:id/approve', admin, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.type !== 'equipment' || !['open', 'approved'].includes(r.status)) throw httpError(400, 'This request is not open');
  const user = getPerson(r.user_id);
  let asset = null;
  const rawAssetId = num(req.body.asset_id);
  if (rawAssetId !== null && (!Number.isInteger(rawAssetId) || rawAssetId < 0)) throw httpError(400, 'Choose a valid asset');
  const assetId = rawAssetId || null;
  if (assetId) {
    asset = getAsset(assetId);
    if (!asset) throw httpError(404, 'Asset not found');
    doCheckout({ asset, user, actor: req.user, assignment_type: req.body.assignment_type || r.requested_assignment_type || undefined, due_date: req.body.due_date, due_time: req.body.due_time, notes: `Request #${r.id}` });
  }
  const status = asset ? 'completed' : 'approved';
  db.prepare("UPDATE requests SET status = ?, asset_id = COALESCE(?, asset_id), resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?")
    .run(status, assetId, req.user.account_id, clean(req.body.note), r.id);
  // When an asset is attached the checkout email already went out; only send the approval note if no asset yet or a note was added
  if (!asset || clean(req.body.note)) notify.requestResolved(user, { ...r, status, resolution_note: clean(req.body.note) }, asset);
  res.json({ ok: true });
});
app.post('/api/requests/:id/deny', admin, (req, res) => {
  const r = loadRequest(req.params.id);
  if (!['open', 'approved'].includes(r.status)) throw httpError(400, 'This request is not open');
  db.prepare("UPDATE requests SET status = 'denied', resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?").run(req.user.account_id, clean(req.body.note), r.id);
  if (r.type === 'equipment') notify.requestResolved(getPerson(r.user_id), { ...r, status: 'denied', resolution_note: clean(req.body.note) });
  res.json({ ok: true });
});
app.post('/api/requests/:id/cancel', auth, (req, res) => {
  const r = loadRequest(req.params.id);
  if (req.user.role !== 'admin' && (r.user_id !== req.user.employee_id || r.type !== 'equipment')) throw httpError(403, 'Not allowed');
  if (!['open', 'approved', 'dropped_off'].includes(r.status)) throw httpError(400, 'This request is already closed');
  db.prepare("UPDATE requests SET status = 'cancelled', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?").run(req.user.account_id, r.id);
  res.json({ ok: true });
});
app.post('/api/requests/:id/dropped-off', auth, (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.user_id !== req.user.employee_id && req.user.role !== 'admin') throw httpError(403, 'Not allowed');
  if (r.type !== 'return' || r.status !== 'open') throw httpError(400, 'This request is not open');
  db.prepare("UPDATE requests SET status = 'dropped_off' WHERE id = ?").run(r.id);
  const asset = getAsset(r.asset_id);
  if (asset) {
    log(asset.id, req.user.account_id, 'dropped_off', clean(req.body.note) || 'User says it was dropped off', r.user_id);
    notify.droppedOff(getPerson(r.user_id), asset);
  }
  res.json({ ok: true });
});
// A user can proactively say "I'm returning this" without being asked
app.post('/api/assets/:id/return-notice', auth, (req, res) => {
  const asset = getAsset(Number(req.params.id));
  if (!asset) throw httpError(404, 'Asset not found');
  const me = req.user.employee_id;
  const mine = me && db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(asset.id, me);
  if (!mine) throw httpError(400, "This isn't checked out to you");
  const existing = db.prepare("SELECT * FROM requests WHERE type='return' AND asset_id=? AND user_id=? AND status IN ('open','dropped_off')").get(asset.id, me);
  if (existing) db.prepare("UPDATE requests SET status='dropped_off' WHERE id = ?").run(existing.id);
  else db.prepare("INSERT INTO requests (type, status, user_id, asset_id, message, created_by) VALUES ('return', 'dropped_off', ?, ?, ?, ?)")
    .run(me, asset.id, clean(req.body.note) || 'Returned by user', req.user.account_id);
  log(asset.id, req.user.account_id, 'dropped_off', clean(req.body.note) || 'User returned it to IT', me);
  notify.droppedOff(req.user, asset);
  res.json({ ok: true });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, (req, res) => {
  const mine = db.prepare(`
    SELECT s.*, a.name AS asset_name, a.tag, a.category, a.serial, a.id AS asset_id,
      (SELECT thumb FROM photos p WHERE p.id = COALESCE(a.cover_photo_id, (SELECT MIN(id) FROM photos WHERE asset_id = a.id))) AS thumb,
      (SELECT r.id FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_request_id,
      (SELECT r.status FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_status,
      (SELECT r.needed_by FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_by,
      (SELECT r.message FROM requests r WHERE r.type='return' AND r.asset_id = a.id AND r.user_id = s.employee_id AND r.status IN ('open','dropped_off')) AS return_message
    FROM assignments s JOIN assets a ON a.id = s.asset_id
    WHERE s.employee_id = ? AND s.returned_at IS NULL ORDER BY s.assignment_type, s.checked_out_at DESC`).all(req.user.employee_id);
  const myRequests = db.prepare(`SELECT * FROM requests WHERE user_id = ? AND type = 'equipment' AND status IN ('open','approved') ORDER BY created_at DESC`).all(req.user.employee_id);
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
      WHERE r.status IN ('open','approved','dropped_off') ORDER BY r.created_at DESC LIMIT 20`).all();
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
app.get('/api/settings', admin, (req, res) => res.json({ ...getSettings(), mailConfigured: mailConfigured(), appUrl: APP_URL, mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || null }));
app.put('/api/settings', admin, (req, res) => {
  const b = req.body;
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
  res.json(db.prepare('SELECT id, to_addr, subject, status, error, created_at FROM outbox ORDER BY id DESC LIMIT 100').all());
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
  const cols = ['tag', 'name', 'category', 'status', 'holder_names', 'due_date', 'brand', 'model', 'serial', 'condition', 'location', 'purchase_date', 'purchase_cost', 'vendor', 'warranty_expires', 'license_seats', 'seats_used', 'license_expires', 'notes'];
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
  const alias = { asset_tag: 'tag', serial_number: 'serial', s_n: 'serial', type: 'category', manufacturer: 'brand', cost: 'purchase_cost', price: 'purchase_cost', warranty: 'warranty_expires', seats: 'license_seats', assigned_to: 'assigned_email', email: 'assigned_email' };
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
      let id;
      if (existing) {
        db.prepare(`UPDATE assets SET ${ASSET_FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...ASSET_FIELDS.map((f) => v[f]), existing.id);
        id = existing.id; updated++;
      } else {
        const cols = ['tag', ...ASSET_FIELDS];
        id = db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(tag || allocateTag(), ...ASSET_FIELDS.map((f) => v[f])).lastInsertRowid;
        log(id, req.user.account_id, 'created', 'Imported from CSV'); created++;
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

// ---------- static front-end ----------
const PUB = path.join(__dirname, '..', 'public');
app.get('/vendor/html5-qrcode.min.js', (req, res) => res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'), { maxAge: '7d' }));
app.get('/vendor/JsBarcode.all.min.js', (req, res) => res.sendFile(require.resolve('jsbarcode/dist/JsBarcode.all.min.js'), { maxAge: '7d' }));
app.use(express.static(PUB, { maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(PUB, 'index.html')));

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (25 MB max)' : err.message });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nutricost IT Assets running on http://localhost:${PORT}  (APP_URL=${APP_URL})`);
    console.log(mailConfigured() ? `Email: sending via ${process.env.SMTP_HOST || 'smtp.gmail.com'} as ${process.env.SMTP_USER}` : 'Email: NOT configured — messages are logged to the Outbox (Settings → Email).');
  });
}

module.exports = app;
