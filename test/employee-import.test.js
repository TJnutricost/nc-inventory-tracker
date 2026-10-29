// Employee CSV import (docs/briefs/employee-csv-import.md) and the scanner permission boundary: admin-only routes, preview vs import,
// create / update / unchanged, duplicates and conflicts, idempotent re-import, what an import never touches (permissions, roles, accounts,
// assignments, history), new people start without self-checkout / scanner access, Google sign-in only admits an imported person once IT has given them a login,
// and the scanner API answers 403 without the permission. Runs on both drivers (npm run test:pg-suite).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { bootApp, startServer, stopServer, makeClient, setupAdmin, skipOnPg } = require('./helpers');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
let server; let db; let fake; let admin; let respond;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

before(async () => {
  fake = http.createServer((req, res) => { req.resume(); req.on('end', () => { const o = respond(); res.writeHead(o.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o.body)); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID; process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  delete process.env.GOOGLE_ADMIN_EMAILS;
  const booted = bootApp();
  db = booted.db;
  require('../src/googleAuth').endpoints.token = `http://127.0.0.1:${fake.address().port}/token`;
  server = await startServer(booted.app);
  ({ client: admin } = await setupAdmin(server));
});
after(async () => { await stopServer(server); fake.close(); });

const HDR = 'first_name,last_name,work_email,department,job_title,location,phone\r\n';
const post = (c, url, body) => c.rawPost(url, { headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'text/csv' }, body });
const preview = (csv, c = admin) => post(c, '/api/import/employees/preview', csv);
const run = (csv, q = '', c = admin) => post(c, '/api/import/employees' + q, csv);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const emp = (email) => one('SELECT * FROM employees WHERE lower(work_email) = ?', email);
const count = (sql, ...p) => one(sql, ...p).c;

let ipSeq = 100;
async function googleSignIn(email, claims = {}) {
  const ip = `10.1.0.${++ipSeq}`; let cookie = '';
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url) => {
    const res = await fetch(base + url, { headers: { 'X-Forwarded-For': ip, ...(cookie && { Cookie: cookie }) }, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, location: res.headers.get('location'), json };
  };
  const start = new URL((await call('/auth/google')).location).searchParams;
  respond = () => ({ status: 200, body: { id_token: `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, nonce: start.get('nonce'), sub: '1', email, email_verified: true, hd: 'nutricost.com', ...claims })}.x` } });
  const r = await call(`/auth/google/callback?${new URLSearchParams({ state: start.get('state'), code: 'c' })}`);
  return { r, me: async () => (await call('/api/me')).json?.user || null, get: call };
}

test('only an admin can use the import routes; the template is a CSV', async () => {
  const anon = makeClient(server);
  for (const [m, u] of [['get', '/api/import/employees/template.csv'], ['post', '/api/import/employees/preview'], ['post', '/api/import/employees']]) {
    const r = m === 'get' ? await anon.get(u) : await post(anon, u, HDR + 'A,Lastname,a@nutricost.com,,,,\r\n');
    assert.ok([401, 403].includes(r.status), `${u} anonymous: ${r.status}`);
  }
  const created = (await admin.post('/api/users', { name: 'Plain Employee', email: 'plain@nutricost.com', invite: false })).body;
  const emp1 = makeClient(server);
  const tok = db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(created.account_id);
  assert.ok(tok);
  db.prepare("UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE login_email = 'ada@nutricost.com') WHERE id = ?").run(created.account_id);
  assert.equal((await emp1.post('/api/login', { email: 'plain@nutricost.com', password: 'correct-horse-1' })).status, 200);
  assert.equal((await emp1.get('/api/import/employees/template.csv')).status, 403);
  assert.equal((await preview(HDR + 'A,Lastname,a@nutricost.com,,,,\r\n', emp1)).status, 403);
  assert.equal((await run(HDR + 'A,Lastname,a@nutricost.com,,,,\r\n', '', emp1)).status, 403);
  assert.equal(count("SELECT COUNT(*) c FROM employees WHERE work_email = 'a@nutricost.com'"), 0);
  const t = await admin.get('/api/import/employees/template.csv');
  assert.equal(t.status, 200);
  assert.match(t.headers.get('content-type'), /text\/csv/);
  assert.match(t.text, /^first_name,last_name,work_email,department,job_title,location,phone\r\n/);
});

test('preview writes nothing; the import creates people with no login and self-checkout OFF, and updates matched people only where the CSV has a value', async () => {
  const keep = (await admin.post('/api/users', { name: 'Old Name', email: 'keep@nutricost.com', department: 'Ops', title: 'Lead', phone: '555-1', login: false })).body;
  const before_ = count('SELECT COUNT(*) c FROM employees');
  const csv = HDR + 'New,Person,NEW@Nutricost.com,Sales,Rep,HQ,555-9\r\n'
    + 'New,Name,Keep@nutricost.com,,,Warehouse,\r\n'; // blank cells must not erase Ops / Lead / 555-1
  const p = await preview(csv);
  assert.equal(p.status, 200);
  assert.deepEqual([p.body.counts.create, p.body.counts.update, p.body.counts.unchanged, p.body.counts.excluded], [1, 1, 0, 0]);
  assert.equal(count('SELECT COUNT(*) c FROM employees'), before_, 'a preview writes nothing');
  assert.equal(emp('new@nutricost.com'), undefined);

  const r = await run(csv);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.counts.create, r.body.counts.update], [1, 1]);
  const made = emp('new@nutricost.com');
  assert.deepEqual([made.name, made.work_email, made.department, made.title, made.building, made.phone, made.status, made.can_self_checkout],
    ['New Person', 'new@nutricost.com', 'Sales', 'Rep', 'HQ', '555-9', 'active', 0], 'normalized email, active, self-checkout OFF');
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', made.id), 0, 'no login, no invite');
  const upd = emp('keep@nutricost.com');
  assert.equal(upd.id, keep.id);
  assert.deepEqual([upd.name, upd.department, upd.title, upd.phone, upd.building], ['New Name', 'Ops', 'Lead', '555-1', 'Warehouse']);
  assert.equal(count("SELECT COUNT(*) c FROM activity WHERE action = 'employees_imported'"), 1);
});

test('re-importing the same file is idempotent: nothing changes and nothing is logged', async () => {
  const csv = HDR + 'Idem,Potent,idem@nutricost.com,Ops,Tech,HQ,\r\n';
  assert.equal((await run(csv)).body.counts.create, 1);
  const snap = JSON.stringify(db.prepare('SELECT * FROM employees ORDER BY id').all());
  const logs = count("SELECT COUNT(*) c FROM activity WHERE action = 'employees_imported'");
  const again = await run(csv);
  assert.deepEqual([again.body.counts.create, again.body.counts.update, again.body.counts.unchanged], [0, 0, 1]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM employees ORDER BY id').all()), snap);
  assert.equal(count("SELECT COUNT(*) c FROM activity WHERE action = 'employees_imported'"), logs);
});

test('invalid rows, duplicates and conflicts are left out and never guessed; leaving rows out needs an explicit acknowledgement', async () => {
  const bob = (await admin.post('/api/users', { name: 'Bob Login', email: 'bob.work@nutricost.com', invite: false })).body;
  db.prepare("UPDATE employees SET work_email = 'bob.other@nutricost.com' WHERE id = ?").run(bob.id); // login email now differs from the work email
  const gone = (await admin.post('/api/users', { name: 'Gone Person', email: 'gone@nutricost.com', login: false })).body;
  await admin.put(`/api/users/${gone.id}`, { active: false });
  const csv = HDR + 'Good,One,good1@nutricost.com,,,,\r\n'
    + ',,noname@nutricost.com,,,,\r\n' // no name
    + 'Bad,Mail,not-an-email,,,,\r\n'
    + 'Dup,A,dup@nutricost.com,Ops,,,\r\n' + 'Dup,A,DUP@nutricost.com,Ops,,,\r\n' // identical: imported once
    + 'Clash,A,clash@nutricost.com,Ops,,,\r\n' + 'Clash,B,clash@nutricost.com,Sales,,,\r\n' // different: both left out
    + 'Login,Owner,bob.work@nutricost.com,,,,\r\n' // another person's login address
    + 'Gone,Back,gone@nutricost.com,,,,\r\n'; // inactive: never reactivated
  const p = (await preview(csv)).body;
  const by = (line) => p.rows.find((r) => r.line === line);
  assert.deepEqual(p.rows.map((r) => r.action), ['create', 'invalid', 'invalid', 'create', 'duplicate', 'conflict', 'conflict', 'conflict', 'conflict']);
  assert.match(by(7).message, /different details/);
  assert.match(by(9).message, /login of Bob Login/);
  assert.match(by(10).message, /inactive/);
  assert.equal(p.counts.excluded, 7);
  assert.equal((await run(csv)).status, 400, 'excluded rows need acknowledgement');
  assert.equal(emp('good1@nutricost.com'), undefined, 'nothing was written');
  assert.equal((await run(csv, '?create=9&update=0&acknowledge=1')).status, 409, 'the data is not what the preview showed');
  const ok = await run(csv, '?create=2&update=0&acknowledge=1');
  assert.equal(ok.status, 200, ok.text);
  assert.ok(emp('good1@nutricost.com') && emp('dup@nutricost.com'));
  assert.equal(emp('clash@nutricost.com'), undefined);
  assert.equal(emp('gone@nutricost.com').status, 'inactive');
  assert.equal(count('SELECT COUNT(*) c FROM employees WHERE lower(work_email) = ?', 'dup@nutricost.com'), 1);
});

test('file problems are refused before anything is read: no header columns, too many rows, too large', async () => {
  assert.equal((await preview('first_name,dept\r\nA,B\r\n')).status, 400);
  assert.equal((await preview('first_name,last_name,work_email\r\n')).status, 400);
  assert.equal((await preview('first_name,first_name,last_name,work_email\r\nA,B,C,a@nutricost.com\r\n')).status, 400);
  const many = HDR + Array.from({ length: 5001 }, (_, i) => `P,${i},p${i}@nutricost.com,,,,`).join('\r\n');
  assert.equal((await preview(many)).status, 400);
  assert.equal((await preview(`first_name,last_name,work_email\r\n${'x'.repeat(2 * 1024 * 1024 + 10)},y,a@nutricost.com`)).status, 400);
});

test('a combined name column is refused, never split; first and last name are each required and stored together in the one name field', async () => {
  for (const hdr of ['Name,work_email', 'Full Name,work_email', 'first_name,last_name,Name,work_email', 'Employee name,work_email']) {
    const r = await preview(`${hdr}\r\nAda Lovelace,ada.l@nutricost.com\r\n`);
    assert.equal(r.status, 400, hdr);
    assert.match(r.body.error, /first_name.*last_name/, hdr);
  }
  const only = await preview('first_name,work_email\r\nAda,ada.l@nutricost.com\r\n');
  assert.equal(only.status, 400); assert.match(only.body.error, /last_name/);
  const p = (await preview(HDR + 'Ada,,ada.l@nutricost.com,,,,\r\n,Lovelace,ada.m@nutricost.com,,,,\r\nMary Ann,O\'Neil,mary@nutricost.com,,,,\r\n')).body;
  assert.deepEqual(p.rows.map((r) => r.action), ['invalid', 'invalid', 'create']);
  assert.match(p.rows[0].message, /last_name is required/); assert.match(p.rows[1].message, /first_name is required/);
  assert.deepEqual([p.rows[2].first_name, p.rows[2].last_name, p.rows[2].name], ['Mary Ann', "O'Neil", "Mary Ann O'Neil"]);
  assert.equal(emp('ada.l@nutricost.com'), undefined);
  assert.equal((await run(HDR + 'Mary Ann,O\'Neil,mary@nutricost.com,,,,\r\n')).status, 200);
  assert.equal(emp('mary@nutricost.com').name, "Mary Ann O'Neil");
  assert.deepEqual([emp('mary@nutricost.com').first_name, emp('mary@nutricost.com').last_name], ['Mary Ann', "O'Neil"], 'stored separately as well as in the display name');
});

test('unsupported columns are refused, never silently ignored (Employee ID is not stored by the application)', async () => {
  for (const hdr of ['first_name,last_name,work_email,employee_id', 'first_name,last_name,work_email,Employee ID', 'first_name,last_name,work_email,manager', 'first_name,last_name,work_email,']) {
    const r = await preview(`${hdr}\r\nAda,Lovelace,ada.u@nutricost.com,1001\r\n`);
    assert.equal(r.status, 400, hdr);
    assert.match(r.body.error, /Unsupported column/, hdr);
  }
  assert.equal((await run('first_name,last_name,work_email,employee_id\r\nAda,Lovelace,ada.u@nutricost.com,1\r\n')).status, 400);
  assert.equal(emp('ada.u@nutricost.com'), undefined);
  // the template's own columns are exactly the supported ones; header spelling is flexible only in case and spaces
  assert.equal((await preview('First Name,LAST_NAME,Work Email,Department,Job Title,Location,Phone\r\nAda,Lovelace,ada.v@nutricost.com,IT,Analyst,HQ,1\r\n')).status, 200);
});

test('legacy people (a name with no first/last) are matched by email, never split, and get their parts from an import', async () => {
  const legacy = (await admin.post('/api/users', { name: 'Mary Ann Legacy', email: 'legacy@nutricost.com', login: false })).body;
  assert.deepEqual([legacy.name, legacy.first_name, legacy.last_name], ['Mary Ann Legacy', null, null], 'a legacy-only name is kept as it is and not split');
  const p = (await preview(HDR + 'Mary Ann,Legacy,legacy@nutricost.com,,,,\r\n')).body;
  assert.equal(p.rows[0].action, 'update');
  assert.deepEqual(Object.keys(p.rows[0].changes).sort(), ['first_name', 'last_name'], 'the display name already equals the parts, so only the parts change');
  assert.equal((await run(HDR + 'Mary Ann,Legacy,legacy@nutricost.com,,,,\r\n')).status, 200);
  const e = emp('legacy@nutricost.com');
  assert.deepEqual([e.name, e.first_name, e.last_name, e.id], ['Mary Ann Legacy', 'Mary Ann', 'Legacy', legacy.id]);
  assert.equal((await run(HDR + 'Mary Ann,Legacy,legacy@nutricost.com,,,,\r\n')).body.counts.unchanged, 1, 'idempotent');
});

test('every creation path starts with self-checkout OFF: manual and CSV; signing in with Google never opens the scanner, and never creates anyone', async () => {
  const manual = (await admin.post('/api/users', { first_name: 'Manny', last_name: 'Manual', email: 'manny@nutricost.com', invite: false })).body;
  assert.deepEqual([manual.name, manual.first_name, manual.last_name, manual.can_self_checkout], ['Manny Manual', 'Manny', 'Manual', false]);
  assert.equal((await admin.post('/api/users', { first_name: 'Only', email: 'only@nutricost.com' })).status, 400, 'both parts or neither');
  const peopleBefore = count('SELECT COUNT(*) c FROM employees');
  const unknown = await googleSignIn('brandnew@nutricost.com', { name: 'Brand New' }); // not in any roster: Google creates nobody
  assert.match(unknown.r.location, /error=no_access/); assert.equal(await unknown.me(), null);
  assert.equal(count('SELECT COUNT(*) c FROM employees'), peopleBefore, 'no employee was created by Google');
  const s = await googleSignIn('manny@nutricost.com'); // the manually created login
  assert.equal(s.r.location, '/#/home');
  const me = await s.me();
  assert.equal(me.can_self_checkout, false, 'a new employee has self-checkout OFF');
  assert.equal(count('SELECT can_self_checkout c FROM employees WHERE id = ?', me.employee_id), 0);
  assert.equal((await s.get('/api/assets/lookup/ANYTHING')).status, 403, 'and the scanner API refuses them');
  assert.equal((await s.get('/api/assets')).status, 200, 'browsing still works');
});

test('Add person / Edit person take separate names; a legacy record stays editable without a guessed split', async () => {
  const p = (await admin.post('/api/users', { first_name: 'Una', last_name: 'Edit', email: 'una@nutricost.com', login: false })).body;
  const r = await admin.put(`/api/users/${p.id}`, { first_name: 'Una', last_name: 'Edited', department: 'Ops' });
  assert.deepEqual([r.body.name, r.body.first_name, r.body.last_name, r.body.department], ['Una Edited', 'Una', 'Edited', 'Ops']);
  assert.equal((await admin.put(`/api/users/${p.id}`, { first_name: 'Solo' })).status, 400, 'one part without the other is refused');
  const old = (await admin.post('/api/users', { name: 'Old Fashioned Name', email: 'oldf@nutricost.com', login: false })).body;
  const keep = await admin.put(`/api/users/${old.id}`, { first_name: '', last_name: '', department: 'Ops' }); // the sheet's untouched legacy fields
  assert.deepEqual([keep.body.name, keep.body.first_name, keep.body.last_name, keep.body.department], ['Old Fashioned Name', null, null, 'Ops']);
  const set = await admin.put(`/api/users/${old.id}`, { first_name: 'Old', last_name: 'Fashioned' });
  assert.deepEqual([set.body.name, set.body.first_name, set.body.last_name], ['Old Fashioned', 'Old', 'Fashioned']);
  const people = (await admin.get('/api/users')).body;
  assert.ok(people.some((x) => x.id === old.id) && people.some((x) => x.id === p.id), 'both still listed');
});

test('2,500 rows import in one go and re-import unchanged', async () => {
  const csv = HDR + Array.from({ length: 2500 }, (_, i) => `Bulk,${i},bulk${i}@nutricost.com,Ops,Tech,HQ,`).join('\r\n');
  const t0 = Date.now();
  const r = await run(csv);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.counts.create, 2500);
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  assert.equal(count("SELECT COUNT(*) c FROM employees WHERE work_email LIKE 'bulk%@nutricost.com' AND can_self_checkout = 0"), 2500);
  assert.equal((await run(csv)).body.counts.unchanged, 2500);
});

test('an import never changes permissions, roles, accounts, assignments or history of existing people', async () => {
  const mk = async (name, email) => (await admin.post('/api/users', { name, email, invite: false })).body;
  const on = await mk('Keeps On', 'on@nutricost.com');
  const off = await mk('Keeps Off', 'off2@nutricost.com');
  const boss = await mk('Other Admin', 'boss@nutricost.com');
  await admin.put(`/api/users/${on.id}/self-checkout`, { enabled: true });
  await admin.put(`/api/users/${off.id}/self-checkout`, { enabled: false });
  await admin.put(`/api/users/${boss.id}`, { role: 'admin' });
  const asset = (await admin.post('/api/assets', { name: 'Held Laptop', tag: 'IMP-1', available_to_request: true })).body;
  assert.equal((await admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: on.id, assignment_type: 'checkout', due_date: '2099-01-01' })).status, 200);
  const snap = () => JSON.stringify([
    db.prepare('SELECT id, can_self_checkout, status FROM employees WHERE id IN (?, ?, ?) ORDER BY id').all(on.id, off.id, boss.id),
    db.prepare('SELECT id, employee_id, role, active, login_email FROM accounts ORDER BY id').all(),
    db.prepare('SELECT * FROM assignments ORDER BY id').all(), db.prepare('SELECT COUNT(*) c FROM requests').get(), db.prepare("SELECT COUNT(*) c FROM activity WHERE action <> 'employees_imported'").get(),
  ]);
  const before_ = snap();
  const r = await run(HDR + 'Renamed,On,on@nutricost.com,Finance,,,\r\nRenamed,Off,off2@nutricost.com,Finance,,,\r\nRenamed,Boss,boss@nutricost.com,Finance,,,\r\n');
  assert.deepEqual([r.body.counts.update, r.body.counts.create], [3, 0]);
  assert.equal(snap(), before_);
  assert.equal(emp('on@nutricost.com').name, 'Renamed On');
  assert.equal(emp('on@nutricost.com').can_self_checkout, 1, 'an existing permission is kept');
  assert.equal(emp('off2@nutricost.com').can_self_checkout, 0);
});

test('a failure part-way rolls the whole import back', { skip: skipOnPg }, async () => {
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON employees WHEN NEW.name = 'Boom Person' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const before_ = count('SELECT COUNT(*) c FROM employees');
  const logs = count("SELECT COUNT(*) c FROM activity WHERE action = 'employees_imported'");
  const r = await run(HDR + 'Fine,Before,fine.before@nutricost.com,,,,\r\nBoom,Person,boom@nutricost.com,,,,\r\n');
  assert.equal(r.status, 500);
  db.exec('DROP TRIGGER boom');
  assert.equal(count('SELECT COUNT(*) c FROM employees'), before_, 'the first row is not left behind');
  assert.equal(count("SELECT COUNT(*) c FROM activity WHERE action = 'employees_imported'"), logs);
});

test('an imported person has no login, so Google refuses them; once IT gives them one they sign in (no invite, no password) as an employee', async () => {
  assert.equal((await run(HDR + 'Gina,Google,gina@nutricost.com,Ops,,,\r\n')).status, 200);
  const g = emp('gina@nutricost.com');
  const refused = await googleSignIn('gina@nutricost.com');
  assert.match(refused.r.location, /error=no_access/); assert.equal(await refused.me(), null);
  assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', g.id), 0, 'Google made no login');
  assert.equal((await admin.post(`/api/users/${g.id}/account`, { invite: false })).status, 200, 'IT gives them a login');
  const s = await googleSignIn('gina@nutricost.com');
  assert.equal(s.r.location, '/#/home', 'signed in');
  const me = await s.me();
  assert.deepEqual([me.employee_id, me.role, me.can_self_checkout], [g.id, 'employee', false], 'linked to the imported person; not admin; no self-checkout');
  assert.equal(count('SELECT COUNT(*) c FROM employees WHERE lower(work_email) = ?', 'gina@nutricost.com'), 1, 'no second person was made');
  assert.equal((await s.get('/api/assets')).status, 200, 'browsing equipment works');
  assert.equal(count('SELECT COUNT(*) c FROM tokens WHERE user_id = (SELECT id FROM accounts WHERE employee_id = ?)', g.id), 0, 'no invitation');
});

test('Google refuses an imported person who is inactive, and an unverified email', async () => {
  assert.equal((await run(HDR + 'Ian,Inactive,ian@nutricost.com,,,,\r\n')).status, 200);
  const ian = emp('ian@nutricost.com');
  assert.equal((await admin.post(`/api/users/${ian.id}/account`, { invite: false })).status, 200);
  await admin.put(`/api/users/${ian.id}`, { active: false });
  let s = await googleSignIn('ian@nutricost.com');
  assert.match(s.r.location, /error=/); assert.equal(await s.me(), null);
  assert.equal((await run(HDR + 'Vera,Verified,vera@nutricost.com,,,,\r\n')).status, 200);
  assert.equal((await admin.post(`/api/users/${emp('vera@nutricost.com').id}/account`, { invite: false })).status, 200);
  s = await googleSignIn('vera@nutricost.com', { email_verified: false });
  assert.match(s.r.location, /error=unverified/); assert.equal(await s.me(), null);
});

test('scanner boundary: without the permission the scanner API and self-checkout answer 403; with it, and for admins, they work; browsing stays open', async () => {
  const asset = (await admin.post('/api/assets', { name: 'Scan Me', tag: 'SCN-1', available_to_request: true })).body;
  const login = async (email, on) => {
    const p = (await admin.post('/api/users', { name: email, email, invite: false })).body;
    db.prepare("UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE login_email = 'ada@nutricost.com') WHERE id = ?").run(p.account_id);
    await admin.put(`/api/users/${p.id}/self-checkout`, { enabled: on });
    const c = makeClient(server);
    assert.equal((await c.post('/api/login', { email, password: 'correct-horse-1' })).status, 200);
    return c;
  };
  const blocked = await login('noscan@nutricost.com', false);
  const allowed = await login('canscan@nutricost.com', true);
  assert.equal((await blocked.get('/api/assets/lookup/SCN-1')).status, 403);
  assert.equal((await blocked.post(`/api/assets/${asset.id}/checkout`, { due_date: '2099-01-01' })).status, 403);
  assert.equal((await blocked.get('/api/assets')).status, 200);
  assert.equal((await blocked.get(`/api/assets/${asset.id}`)).status, 200);
  assert.equal((await blocked.get('/api/dashboard')).status, 200);
  assert.equal((await blocked.get('/api/me')).body.user.can_self_checkout, false);
  const ok = await allowed.get('/api/assets/lookup/SCN-1');
  assert.deepEqual([ok.status, ok.body.found], [200, true]);
  assert.equal((await admin.get('/api/assets/lookup/SCN-1')).status, 200);
  await admin.put(`/api/users/${(await blocked.get('/api/me')).body.user.id}/self-checkout`, { enabled: true });
  assert.equal((await blocked.get('/api/assets/lookup/SCN-1')).status, 200, 'granting the permission opens the scanner');
});

test('the front end hides every scanner entry point and the camera without access, and guards the #/scan route', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /const canScan = \(\) => !!S\.me && \(S\.me\.role === 'admin' \|\| !!S\.me\.can_self_checkout\)/);
  assert.match(src, /function openScanner\([^)]*\) \{\n  if \(!canScan\(\)\) return;/, 'the camera is never started without access');
  assert.equal((src.match(/canScan\(\) \? \[\{ key: 'scan'/g) || []).length, 2, 'bottom tab and sidebar');
  assert.match(src, /\$\{canScan\(\) \? `<a href="#\/scan" class="iconbtn desk-only"/, 'top bar');
  assert.match(src, /opt\.scan && !canScan\(\)\) return go\('#\/home'\)/, 'direct navigation');
  assert.match(src, /\[\/\^#\\\/scan\$\/, viewScan, \{ key: 'scan', scan: true \}\]/);
});

test('the front end enters names as separate First name / Last name fields everywhere, never one Full name input', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/<span>Full name/.test(src) && !/<span>Your name<\/span>/.test(src) && !/<span>Name<\/span><input name="name" value="\$\{esc\(u\.name\)\}"/.test(src), 'no combined name input is left');
  assert.equal((src.match(/name="first_name"/g) || []).length, 3, 'setup, person sheet, profile');
  assert.equal((src.match(/name="last_name"/g) || []).length, 3);
});

test('an imported person is only ever an employee: no import creates an account or role, Google creates none, and signing in never elevates them', async () => {
  const csv = HDR + 'Elena,Employee,elena@nutricost.com,IT,Administrator,HQ,\r\nAlex,Admin,admin.like@nutricost.com,IT,Admin,,\r\n'; // admin-looking details change nothing
  const accountsBefore = count('SELECT COUNT(*) c FROM accounts'); const adminsBefore = count("SELECT COUNT(*) c FROM accounts WHERE role = 'admin'");
  assert.equal((await run(csv)).status, 200);
  assert.equal(count('SELECT COUNT(*) c FROM accounts'), accountsBefore, 'the import creates no login at all, so no role');
  assert.equal(count("SELECT COUNT(*) c FROM accounts WHERE role = 'admin'"), adminsBefore, 'no admin was added');
  for (const [email, name] of [['elena@nutricost.com', 'Elena Employee'], ['admin.like@nutricost.com', 'Alex Admin']]) {
    const none = await googleSignIn(email, { name });
    assert.match(none.r.location, /error=no_access/, 'no login yet: refused, nothing created');
    assert.equal(count('SELECT COUNT(*) c FROM accounts WHERE employee_id = ?', emp(email).id), 0, 'Google made no login');
    assert.equal((await admin.post(`/api/users/${emp(email).id}/account`, { invite: false })).status, 200, 'IT gives them an employee login');
    const g = await googleSignIn(email, { name });
    assert.equal(g.r.location, '/#/home');
    const me = await g.me();
    assert.deepEqual([me.role, me.can_self_checkout, me.first_name, me.last_name], ['employee', false, name.split(' ')[0], name.split(' ')[1]]);
    assert.equal(one('SELECT role r FROM accounts WHERE employee_id = ?', me.employee_id).r, 'employee');
    for (const url of ['/api/users', '/api/import/employees/template.csv', '/api/activity', '/api/settings']) assert.equal((await g.get(url)).status, 403, `${email} cannot use ${url}`);
    assert.equal((await g.get('/api/assets/lookup/X')).status, 403, 'no scanner');
  }
  // an admin who wants an imported person to be an admin has to do it in People, deliberately
  const target = emp('elena@nutricost.com');
  assert.equal((await admin.put(`/api/users/${target.id}`, { role: 'admin' })).body.role, 'admin');
});
