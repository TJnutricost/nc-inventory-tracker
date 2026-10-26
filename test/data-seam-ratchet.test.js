// Ratchet for the TEMPORARY database driver seam (D-48, PostgreSQL migration Slice 5B). Static checks only: no database is opened.
//
// MIGRATED lists every route in src/server.js that reaches the database ONLY through the seam (`data.<module>.<fn>`, src/dataSeam).
// The list only grows (5B-1 added the already-modular routes, 5B-2 assets/photos/dashboard/scan, 5B-3 people/auth/sessions, 5B-4 the
// rest: settings, outbox, activity, import/export, the request routes, next-tag, GET /api/me). For each listed route the handler must be
// async, must use `data.`, and must not touch `db`, prepare SQL, write SQL text, or call a data module / server.js-local database
// helper directly. A route that is not listed must not use `data.` at all (a half-migrated route is not allowed: list it once it is pure).
// Since Slice 5B-4 every route is either listed or has no database access at all (NO_OWN_SQL), and the whole of server.js is audited:
// no `db` use besides binding the seam, no SQL, no settings access and no data module outside the seam.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const MIGRATED = [
  // Slice 5B-1: routes whose database access was already entirely in the data modules (plus helpers extracted verbatim for them)
  'GET /api/availability',
  'POST /api/assets/:id/reservations',
  'POST /api/reservations/:id/approve',
  'POST /api/reservations/:id/decline',
  'POST /api/reservations/:id/cancel',
  'POST /api/reservations/:id/shorten',
  'GET /api/assets/:id/range-check',
  'GET /api/reservation-counts',
  'PUT /api/waitlist/:id',
  'POST /api/assets/:id/waitlist',
  'GET /api/waitlist',
  'GET /api/waitlist/:id',
  'POST /api/waitlist/:id/confirm',
  'POST /api/waitlist/:id/decline',
  'POST /api/waitlist/:id/cancel',
  'POST /api/catalog',
  'PUT /api/catalog/:id',
  'POST /api/catalog/:id/archive',
  'POST /api/catalog/:id/restore',
  'DELETE /api/catalog/:id',
  'POST /api/requests/:id/open',
  // Slice 5B-2: assets, photos, dashboard, scan, the employee actions on held equipment, and the reads 5B-1 deferred (inline SQL
  // extracted verbatim into src/assetViews.js, assetRecords.js, assetCustody.js, photoRecords.js, dashboard.js, catalogViews.js,
  // requestAccess.js, people.js, activityLog.js, and added to assetAccess.js / reservationViews.js)
  'GET /api/assets',
  'GET /api/assets/lookup/:code',
  'GET /api/assets/:id',
  'POST /api/assets',
  'PUT /api/assets/:id',
  'POST /api/assets/:id/archive',
  'DELETE /api/assets/:id',
  'POST /api/assets/:id/checkout',
  'POST /api/assets/:id/checkin',
  'POST /api/assets/:id/request-return',
  'POST /api/assets/:id/photos',
  'DELETE /api/photos/:id',
  'PUT /api/assets/:id/cover',
  'POST /api/assets/:id/my-return-request',
  'POST /api/assets/:id/report-issue',
  'POST /api/assets/:id/return-notice',
  'GET /api/dashboard',
  'GET /api/reservations',
  'GET /api/catalog/search',
  'GET /api/catalog',
  'POST /api/requests/:id/deny',
  'POST /api/requests/:id/cancel',
  // Slice 5B-3: people, authentication and sessions (inline SQL extracted verbatim into src/accounts.js and src/sessions.js, and added
  // to src/people.js). The auth middleware, the admin guard, the session store and its purge timer are checked separately below.
  'GET /api/setup-needed',
  'POST /api/setup',
  'POST /api/login',
  'POST /api/me/password',
  'PUT /api/me',
  'POST /api/forgot',
  'POST /api/reset',
  // Google sign-in (beside the password login): the callback looks the account up through the seam
  'GET /auth/google/callback',
  'GET /api/users',
  'POST /api/users',
  'POST /api/users/:id/account',
  'GET /api/users/:id',
  'PUT /api/users/:id',
  'PUT /api/users/:id/self-checkout',
  'POST /api/users/:id/invite',
  // Slice 5B-4: everything else (inline SQL extracted verbatim into src/settings.js (the SQL of src/db.js getSettings / setSetting),
  // src/outbox.js, src/overdue.js, src/requestRecords.js, and added to src/activityLog.js, src/assetViews.js, src/assetRecords.js,
  // src/people.js). The sweep timers are checked separately below.
  'GET /api/me',
  'GET /api/next-tag',
  'GET /api/requests',
  'POST /api/requests',
  'POST /api/requests/:id/approve',
  'POST /api/requests/:id/resolve',
  'POST /api/requests/:id/dropped-off',
  'GET /api/settings',
  'PUT /api/settings',
  'POST /api/settings/test-email',
  'GET /api/outbox',
  'GET /api/activity',
  'GET /api/export/assets.csv',
  'POST /api/import/assets',
];

// Routes with no database access at all, so they cannot use the seam (they are checked to stay that way): logout reaches the sessions
// only through express-session and the store (on the seam since 5B-3); GET /health is the host's liveness probe and deliberately touches
// no database (a database failure must not fail it: test/data-seam-remaining.test.js); the dev service-worker kill switch and the two
// vendored scripts are files. (GET /api/me was listed here until 5B-4 put the settings on the seam; it is in MIGRATED now.)
const NO_OWN_SQL = {
  'POST /api/logout': [],
  'GET /health': [],
  'GET /sw.js': [],
  'GET /vendor/html5-qrcode.min.js': [],
  'GET /vendor/JsBarcode.all.min.js': [],
  // Google sign-in: whether it is offered, and the redirect to Google (src/googleAuth.js; no database; the callback is in MIGRATED)
  'GET /api/auth-options': [],
  'GET /auth/google': [],
};

// Known, listed exceptions inside migrated routes: the exact text is removed before the checks below. Empty since Slice 5B-4 (the last
// one, `getSettings().tag_prefix` in POST /api/assets, went with the settings onto the seam). Nothing may be added here without the
// planner's approval.
const ALLOWED = {};

// Direct database access a migrated handler must not contain.
const FORBIDDEN = [
  [/\bdb\b/, 'the SQLite handle `db`'],
  [/\.prepare\s*\(/, 'a prepared statement'],
  [/\.transaction\s*\(/, 'a transaction'],
  [/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\s+(\*|INTO|FROM|[a-z_])/, 'SQL text'],
  [/\bRESERVATION_SQL\b|\bPERSON_SQL\b|\bASSET_LIST_SQL\b/, 'a SQL fragment'],
  // the data modules, as server.js imports them (the seam is the only way in). `(?<![.\w$])`: `data.catalog.x` is the seam, `catalog.x` is not
  [/(?<![.\w$])(availabilityLib|reservationRules|waitlistRules|requestRules|catalog|assignments|assetAccess|reservationViews|catalogAdmin|activityLog|people|assetViews|assetRecords|assetCustody|photoRecords|dashboard|catalogViews|requestAccess|accounts|sessions|settings|outbox|overdue|requestRecords)\s*\./, 'a data module called directly'],
  // server.js-local helpers that run SQL (again: `data.assetAccess.reservableAsset(` is the seam, a bare `reservableAsset(` is not)
  [/(?<![.\w$])(getAsset|canViewAsset|visibleAsset|heldAsset|reservableAsset|reservationOut|reservationById|getPerson|loadRequest|cancelBlock|isSelfInitiated|log|refreshStatus|openAssignments|sanitizeAsset|withCatalog|peekTag|allocateTag|tagExists|makeToken|currentUser|catalogOut|syncAssetCategories|doCheckout|assertSerialFree|resolveAssetNode|heldByMe|getSettings|setSetting|overdueSweep|waitlistSweep|listRequests|createEquipmentRequest|approveRequest|importAssets|exportRows|employeeStatus|dueAssignments|markNotified)\s*\(/, 'a server.js helper that runs SQL'],
];
const withoutAllowed = (key, body) => (ALLOWED[key] || []).reduce((b, text) => b.split(text).join(''), body);

// Every `app.<method>('<path>', ...)` call in server.js with its full source text (bracket-matched, skipping strings and comments).
function routes(src) {
  const out = [];
  const re = /\bapp\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    const open = src.indexOf('(', start);
    const end = matchParen(src, open) + 1;
    out.push({ key: `${m[1].toUpperCase()} ${m[2]}`, start, end, text: src.slice(start, end) });
  }
  return out;
}
function matchParen(src, open) {
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '(' || c === '{' || c === '[') stack.push(c);
    else if (c === ')' || c === '}' || c === ']') { stack.pop(); if (!stack.length) return i; }
  }
  throw new Error(`unbalanced route source at ${open}`);
}
function skipQuoted(src, i, q) { for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) return i; } return i; }
function skipTemplate(src, i) {
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i;
    else if (src[i] === '$' && src[i + 1] === '{') { const end = matchParen(src, i + 1); i = end; }
  }
  return i;
}
// The route's code without comments (a comment may mention `db` or a helper by name).
const code = (text) => text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const src = fs.readFileSync(SERVER, 'utf8');
const all = routes(src);

test('ratchet: the route scanner reads server.js correctly (each route ends before the next begins)', () => {
  assert.ok(all.length > 60, `found only ${all.length} routes`);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].end <= all[i].start, `${all[i - 1].key} runs into ${all[i].key}`);
  for (const r of all) assert.match(r.text, /\)$/, `${r.key} is not a complete app.<method>(...) call`);
});

test('ratchet: every migrated route exists exactly once in src/server.js', () => {
  assert.equal(new Set(MIGRATED).size, MIGRATED.length, 'MIGRATED lists a route twice');
  for (const key of MIGRATED) assert.equal(all.filter((r) => r.key === key).length, 1, `${key}: expected exactly one definition`);
});

test('ratchet: a migrated route is async, uses the seam and has no direct database access', () => {
  for (const key of MIGRATED) {
    const { text } = all.find((r) => r.key === key);
    const body = code(text);
    assert.match(body, /\basync\s*\(/, `${key}: the handler must be async (it awaits the seam)`);
    assert.match(body, /\bawait\s+data\.\w+\.\w+\(/, `${key}: the handler must reach the database through the seam (await data.<module>.<fn>(...))`);
    for (const text of ALLOWED[key] || []) assert.ok(body.includes(text), `${key}: the listed exception "${text}" is gone: remove it from ALLOWED`);
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(withoutAllowed(key, body), re, `${key}: uses ${what}; a migrated route reaches the database only through the seam`);
  }
});

test('ratchet: the routes with no database access (logout, /health, the static files) stay that way', () => {
  for (const [key, allowed] of Object.entries(NO_OWN_SQL)) {
    const found = all.filter((r) => r.key === key);
    assert.equal(found.length, 1, `${key}: expected exactly one definition`);
    let body = code(found[0].text);
    for (const text of allowed) { assert.ok(body.includes(text), `${key}: "${text}" is gone: update NO_OWN_SQL (and list the route in MIGRATED)`); body = body.split(text).join(''); }
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(body, re, `${key}: uses ${what}`);
  }
});

// The source of a function / class / middleware in server.js: from `marker` to the end of its first {...} block (or (...) call).
// The whole file without its full-line comments (`code()` is for one route: across the file a `//` inside a string, e.g. 'https://',
// would cut the rest of the line).
const srcCode = src.replace(/^[ \t]*\/\/[^\n]*$/gm, '');
function blockAt(marker, opener = '{') {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `${marker} exists in src/server.js`);
  assert.equal(src.indexOf(marker, at + 1), -1, `${marker} appears once`);
  return code(src.slice(at, matchParen(src, src.indexOf(opener, at)) + 1));
}

// The photo files (/uploads) are an app.use middleware, not a route: checked on its own (Slice 5B-2). Since Slice 5B-3 the session's
// account is read through the seam too, so there is no exception left.
test('ratchet: the /uploads access check reaches the database only through the seam (the session lookup included)', () => {
  const body = blockAt("app.use('/uploads'", '(');
  assert.match(body, /\basync\s*\(/);
  assert.match(body, /\bawait\s+data\.accounts\.currentUser\(req\.session\.uid\)/);
  assert.match(body, /\bawait\s+data\.photoRecords\.photoByFile\(/);
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(body, re, `/uploads uses ${what}`);
});

// Slice 5B-3: the auth middleware every protected route runs, the admin guard, the express-session store and its hourly purge.
test('ratchet: the auth middleware and the admin guard read the session\'s account only through the seam', () => {
  const auth = blockAt('async function auth(req, res, next)');
  assert.match(auth, /const u = await data\.accounts\.currentUser\(req\.session\.uid\);/);
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(auth, re, `auth uses ${what}`);
  const admin = blockAt('function admin(req, res, next)');
  assert.match(admin, /return auth\(req, res, /, 'the admin guard runs the auth middleware and returns its promise (a rejection reaches Express)');
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(admin, re, `admin uses ${what}`);
  assert.doesNotMatch(srcCode, /function currentUser\b|\bcurrentUser\(req\)/, 'no server.js-local session lookup is left');
});

test('ratchet: the session store and its purge timer reach the sessions table only through the seam', () => {
  const store = blockAt('class SqliteStore extends session.Store');
  for (const fn of ['get', 'set', 'destroy']) assert.match(store, new RegExp(`\\bdata\\.sessions\\.${fn}\\(`), `the store's ${fn} uses data.sessions.${fn}`);
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(store, re, `the session store uses ${what}`);
  assert.match(srcCode, /setInterval\(\(\) => data\.sessions\.purgeExpired\(Date\.now\(\)\)\.catch\(\(e\) => console\.error\('\[sessions:purge\]', e\.message\)\), 3600e3\)\.unref\(\);/,
    'the hourly purge goes through the seam (a failure is logged, Slice 5D)');
  // no SQL against the session, token or account tables is left in server.js
  assert.doesNotMatch(srcCode, /\b(FROM|INTO|UPDATE)\s+(sessions|tokens)\b/, 'server.js has no SQL on sessions or tokens');
  assert.doesNotMatch(srcCode, /\b(INTO|UPDATE)\s+accounts\b/, 'server.js writes no account rows itself');
});

test('ratchet: no route outside the list uses the seam (a half-migrated route is not allowed)', () => {
  const listed = new Set(MIGRATED);
  for (const r of all) {
    if (listed.has(r.key)) continue;
    assert.doesNotMatch(code(r.text), /\bdata\.\w+\.\w+/, `${r.key} uses the seam but is not listed in MIGRATED (and checked as pure)`);
  }
});

// Slice 5D: each driver's database code is loaded only on its own branch (the SQLite database and mailer, or the PostgreSQL pool and
// mailer); boot() loads the PostgreSQL runner, notifier and sweep scheduler, and nothing else of src/pg/* is required by server.js.
test('ratchet: server.js opens the seam once, after checking DB_DRIVER and loading only that driver', () => {
  const body = code(src);
  assert.equal((body.match(/dataSeam\.open\(/g) || []).length, 1, 'the seam is opened once');
  assert.match(body, /const data = dataSeam\.open\(\{ driver: DB_DRIVER, db, pool \}\)/);
  const resolveAt = body.indexOf('dataSeam.resolveDriver()');
  assert.ok(resolveAt > 0, 'DB_DRIVER is resolved at startup');
  assert.ok(resolveAt < body.indexOf("require('./db')"), 'DB_DRIVER is checked before src/db.js opens the SQLite database');
  const branch = blockAt("if (DB_DRIVER === 'pg') {\n  pool");
  assert.match(branch, /pool = require\('\.\/pg\/pool'\)\.getPool\(\);\s*mailer = require\('\.\/pg\/mailer'\)\.createPgMailer\(pool\);\s*\}$/);
  const sqliteBranch = body.slice(body.indexOf(branch) + branch.length, body.indexOf("const { notify, APP_URL"));
  assert.match(sqliteBranch, /^ else \{\s*\(\{ db \} = require\('\.\/db'\)\);\s*mailer = require\('\.\/mailer'\);\s*\}\s*$/);
  const pgRequires = [...body.matchAll(/require\(['"](\.\/pg\/[^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(pgRequires, ['./pg/mailer', './pg/migrate', './pg/notifier', './pg/pool', './pg/pool', './pg/sweep']);
  const bootPg = blockAt('async function bootPg()');
  for (const m of ['./pg/migrate', './pg/notifier', './pg/sweep']) assert.ok(bootPg.includes(`require('${m}')`), `${m} is loaded only by bootPg`);
});

// ---------------------------------------------------------------- Slice 5B-4: the final audit of server.js
// The whole file without comments: full-line ones, and trailing ones that follow whitespace (a `//` right after a quote or a colon, as in
// 'https://' or the dev service worker's text, is not a comment). server.js has no block comments (its `'*/*'` content type and a regex
// ending in `.*/` would fool a naive block-comment stripper), which the first check pins.
const allCode = src.replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/(\s)\/\/[^\n]*/g, '$1');
test('ratchet (5B-4): server.js has no block comments (the whole-file audit below strips line comments only)', () => {
  assert.doesNotMatch(src, /\/\*[\s*]/);
});

test('ratchet (5B-4): every route in server.js is either on the seam (MIGRATED) or has no database access (NO_OWN_SQL)', () => {
  const noSql = new Set(Object.keys(NO_OWN_SQL));
  for (const key of MIGRATED) assert.ok(!noSql.has(key), `${key} is in both lists`);
  for (const r of all) assert.ok(MIGRATED.includes(r.key) || noSql.has(r.key), `${r.key} is in neither MIGRATED nor NO_OWN_SQL`);
  assert.deepEqual(ALLOWED, {}, 'no listed exception is left inside a migrated route');
  assert.equal(MIGRATED.length + noSql.size, all.length);
});

test('ratchet (5B-4): server.js has no database access outside the seam (no db use, SQL, settings access or data module)', () => {
  // src/db.js: only the handle (to bind the seam) and the data directory; the settings come through the seam (src/settings.js)
  // (since Slice 5D the data directory is computed in server.js, as src/db.js does, so the PostgreSQL driver never loads src/db.js)
  const dbRequires = allCode.match(/^.*require\(['"]\.\/db['"]\).*$/gm) || [];
  assert.deepEqual(dbRequires.map((l) => l.trim()), ["({ db } = require('./db'));"], 'server.js takes only `db` from src/db.js');
  const dbLines = allCode.split('\n').filter((l) => /\bdb\b/.test(l)).map((l) => l.trim());
  assert.deepEqual(dbLines, ['let db = null;', "({ db } = require('./db'));", 'const data = dataSeam.open({ driver: DB_DRIVER, db, pool });'],
    'the SQLite handle is used only to open the seam');
  // the only local modules: the env loader, the seam, src/db.js (above), the mailers (the SQLite mail adapter, or the PostgreSQL one),
  // the pure serial helpers, the Google sign-in client (no database access) and, since Slice 5D, the PostgreSQL pool and boot services (checked in the test above)
  const locals = [...allCode.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)].map((m) => m[1]).filter((m) => !m.startsWith('./pg/')).sort();
  assert.deepEqual(locals, ['./dataSeam', './db', './env', './googleAuth', './mailer', './serial'], 'no data module is loaded by server.js (only the seam)');
  assert.doesNotMatch(allCode, /\.prepare\s*\(/, 'no prepared statement');
  assert.doesNotMatch(allCode, /\.transaction\s*\(/, 'no transaction');
  assert.doesNotMatch(allCode, /\b(db|database)\s*\.\s*(exec|pragma|prepare|transaction)\b/, 'no direct database call');
  assert.doesNotMatch(allCode, /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\s+(\*|INTO|FROM|[a-z_])/, 'no SQL text');
  assert.doesNotMatch(allCode, /(?<![.\w$])(getSettings|setSetting)\b/, 'no settings access except data.settings.*');
  for (const [re, what] of FORBIDDEN.slice(3)) {
    if (what === 'a server.js helper that runs SQL') continue; // (the sweeps are named functions here; checked on their own below)
    assert.doesNotMatch(allCode, re, `server.js uses ${what}`);
  }
});

test('ratchet (5B-4): the overdue and waitlist sweeps reach the database only through the seam and keep their timers', () => {
  const overdue = blockAt('async function overdueSweep()');
  assert.match(overdue, /await data\.settings\.getSettings\(\)/);
  assert.match(overdue, /await data\.overdue\.dueAssignments\(\)/);
  assert.match(overdue, /await data\.overdue\.markNotified\(s\.id\)/);
  const waitlist = blockAt('function waitlistSweep()');
  assert.match(waitlist, /data\.waitlist\.sweep\(\)\.catch\(/, 'the waitlist sweep goes through the seam and logs a failure');
  for (const [name, body] of [['overdueSweep', overdue], ['waitlistSweep', waitlist]]) {
    const inner = body.slice(body.indexOf('{'));
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(inner, re, `${name} uses ${what}`);
  }
  for (const timer of ['setInterval(overdueSweep, 3600e3).unref();', 'setTimeout(overdueSweep, 15e3).unref();',
    'setInterval(waitlistSweep, 60e3).unref();', 'setTimeout(waitlistSweep, 20e3).unref();']) {
    assert.equal(allCode.split(timer).length - 1, 1, `${timer} (unchanged interval, unref'd, once)`);
  }
  // Slice 5D: the SQLite waitlist timers run only on SQLite; on PostgreSQL boot() starts the single-flight scheduler (its own 60 s
  // interval, plus this one first run at 20 s) and the same overdue timers, once the schema is migrated.
  assert.match(allCode, /if \(DB_DRIVER !== 'pg'\) \{\s*setInterval\(waitlistSweep, 60e3\)\.unref\(\);\s*setTimeout\(waitlistSweep, 20e3\)\.unref\(\);\s*\}/);
  assert.match(allCode, /if \(DB_DRIVER !== 'pg'\) startOverdueTimer\(\);/);
  const bootPg = blockAt('async function bootPg()');
  assert.match(bootPg, /scheduler\.start\(\);\s*setTimeout\(\(\) => \{ scheduler\.tick\(\); \}, 20e3\)\.unref\(\);\s*startOverdueTimer\(\);/);
  assert.match(allCode, /const timer = setTimeout\(\(\) => \{ forced = true; server\.closeAllConnections\(\); \}, SHUTDOWN_GRACE_MS\);/,
    'the PostgreSQL shutdown grace timer (no database access)');
  assert.equal((allCode.match(/\bset(Interval|Timeout)\(/g) || []).length, 7,
    'no other timer (the four sweep timers, the hourly session purge, the first PostgreSQL sweep and the shutdown grace timer)');
});
