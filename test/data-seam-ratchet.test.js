// Ratchet for the TEMPORARY database driver seam (D-48, PostgreSQL migration Slice 5B). Static checks only: no database is opened.
//
// MIGRATED lists every route in src/server.js that reaches the database ONLY through the seam (`data.<module>.<fn>`, src/dataSeam).
// The list only grows (5B-1 adds the already-modular routes; 5B-2..5B-4 add the rest). For each listed route the handler must be
// async, must use `data.`, and must not touch `db`, prepare SQL, write SQL text, or call a data module / server.js-local database
// helper directly. A route that is not listed must not use `data.` at all (a half-migrated route is not allowed: list it once it is pure).
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
];

// Direct database access a migrated handler must not contain.
const FORBIDDEN = [
  [/\bdb\b/, 'the SQLite handle `db`'],
  [/\.prepare\s*\(/, 'a prepared statement'],
  [/\.transaction\s*\(/, 'a transaction'],
  [/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\s+(\*|INTO|FROM|[a-z_])/, 'SQL text'],
  [/\bRESERVATION_SQL\b|\bPERSON_SQL\b|\bASSET_LIST_SQL\b/, 'a SQL fragment'],
  // the data modules, as server.js imports them (the seam is the only way in). `(?<![.\w$])`: `data.catalog.x` is the seam, `catalog.x` is not
  [/(?<![.\w$])(availabilityLib|reservationRules|waitlistRules|requestRules|catalog|assignments|assetAccess|reservationViews|catalogAdmin)\s*\./, 'a data module called directly'],
  // server.js-local helpers that run SQL (again: `data.assetAccess.reservableAsset(` is the seam, a bare `reservableAsset(` is not)
  [/(?<![.\w$])(getAsset|canViewAsset|visibleAsset|heldAsset|reservableAsset|reservationOut|reservationById|getPerson|loadRequest|cancelBlock|isSelfInitiated|log|refreshStatus|openAssignments|sanitizeAsset|withCatalog|peekTag|allocateTag|tagExists|makeToken|currentUser|catalogOut|syncAssetCategories|doCheckout|assertSerialFree)\s*\(/, 'a server.js helper that runs SQL'],
];

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
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(body, re, `${key}: uses ${what}; a migrated route reaches the database only through the seam`);
  }
});

test('ratchet: no route outside the list uses the seam (a half-migrated route is not allowed)', () => {
  const listed = new Set(MIGRATED);
  for (const r of all) {
    if (listed.has(r.key)) continue;
    assert.doesNotMatch(code(r.text), /\bdata\.\w+\.\w+/, `${r.key} uses the seam but is not listed in MIGRATED (and checked as pure)`);
  }
});

test('ratchet: server.js opens the seam once, after checking DB_DRIVER and before opening SQLite', () => {
  const body = code(src);
  assert.equal((body.match(/dataSeam\.open\(/g) || []).length, 1, 'the seam is opened once');
  assert.match(body, /const data = dataSeam\.open\(\{ driver: DB_DRIVER, db \}\)/);
  const resolveAt = body.indexOf('dataSeam.resolveDriver()');
  assert.ok(resolveAt > 0, 'DB_DRIVER is resolved at startup');
  assert.ok(resolveAt < body.indexOf("require('./db')"), 'DB_DRIVER is checked before src/db.js opens the SQLite database');
  assert.doesNotMatch(body, /require\(['"]\.\/pg\//, 'server.js does not load src/pg/* before Slice 5D');
});
