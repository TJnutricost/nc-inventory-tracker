const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrate');
const migrations = require('../src/migrations');
const { createAssignment } = require('../src/assignments');
const { bootApp, startServer, stopServer, makeClient, setupAdmin } = require('./helpers');

let server, db, dir, admin;
before(async () => {
  const booted = bootApp();
  db = booted.db; dir = booted.dir;
  server = await startServer(booted.app);
  admin = (await setupAdmin(server)).client;
});
after(() => stopServer(server));

let seq = 0;
const newAsset = async (name, extra = {}) => (await admin.post('/api/assets', { available_to_request: true, name, tag: `AS-${++seq}`, ...extra })).body;
const newPerson = async (name) => (await admin.post('/api/users', { name, email: `p${++seq}@nutricost.com`, login: false })).body;
const assign = (asset, person, extra = {}) => admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: person.id, ...extra });
const count = (sql, ...p) => db.prepare(sql).get(...p).c;
const isoPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const loan = (extra = {}) => ({ assignment_type: 'checkout', due_date: isoPlus(7), ...extra }); // a checkout always needs a return date

// ---------------------------------------------------------------- assignment type
test('an admin can create a permanent assignment; it never carries a return date or time', async () => {
  const p = await newPerson('Perma Nent');
  const a = await newAsset('Desktop');
  const r = await assign(a, p, { due_date: isoPlus(5), due_time: '09:00' }); // sent with a permanent assignment: dropped
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.assignment.assignment_type, 'permanent');
  assert.deepEqual([r.body.assignment.due_date, r.body.assignment.due_time], [null, null]);
  assert.equal(r.body.assignment.employee_id, p.id);
  const explicit = await assign(await newAsset('Monitor'), p, { assignment_type: 'permanent' });
  assert.equal(explicit.body.assignment.assignment_type, 'permanent');
  const detail = (await admin.get(`/api/assets/${a.id}`)).body;
  assert.deepEqual([detail.holders[0].assignment_type, detail.holders[0].due_date, detail.holders[0].due_time], ['permanent', null, null]);
});

test('a temporary checkout requires a return date; the return time is optional', async () => {
  const p = await newPerson('Temp Borrower');
  const a = await newAsset('Lens');
  const missing = await assign(a, p, { assignment_type: 'checkout' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /return date/);
  assert.equal((await assign(a, p, { assignment_type: 'checkout', due_date: '' })).status, 400);
  assert.equal((await assign(a, p, { assignment_type: 'checkout', due_time: '10:00' })).status, 400, 'a time alone is not a return date');
  assert.equal((await assign(a, p, loan({ due_date: '2026-02-31' }))).status, 400);
  assert.equal((await assign(a, p, loan({ due_time: '25:99' }))).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);

  const due = isoPlus(14);
  const dateOnly = await assign(a, p, { assignment_type: 'checkout', due_date: due });
  assert.equal(dateOnly.status, 200, JSON.stringify(dateOnly.body));
  assert.deepEqual([dateOnly.body.assignment.assignment_type, dateOnly.body.assignment.due_date, dateOnly.body.assignment.due_time], ['checkout', due, null]);
  const b = await newAsset('Light');
  const sameDay = await assign(b, p, { assignment_type: 'checkout', due_date: isoPlus(0), due_time: '16:30' });
  assert.deepEqual([sameDay.body.assignment.due_date, sameDay.body.assignment.due_time], [isoPlus(0), '16:30']);
});

test('the database itself rejects a checkout without a return date and a permanent assignment with one', async () => {
  const p = await newPerson('Constraint Person');
  const a = await newAsset('Constraint Asset');
  const ins = (type, date, time) => () => db.prepare('INSERT INTO assignments (asset_id, employee_id, assignment_type, due_date, due_time) VALUES (?, ?, ?, ?, ?)').run(a.id, p.id, type, date, time);
  assert.throws(ins('checkout', null, null), /CHECK/);
  assert.throws(ins('checkout', null, '10:00'), /CHECK/);
  assert.throws(ins('permanent', '2099-01-01', null), /CHECK/);
  assert.throws(ins('permanent', null, '10:00'), /CHECK/);
});

test('the assignment type comes from the request, never from the asset category', async () => {
  const p = await newPerson('Category Agnostic');
  const laptopOnLoan = await newAsset('Loaner Laptop', { category: 'Laptop' });
  const cameraForever = await newAsset('Studio Camera', { category: 'Other' });
  assert.equal((await assign(laptopOnLoan, p, loan())).body.assignment.assignment_type, 'checkout');
  assert.equal((await assign(cameraForever, p)).body.assignment.assignment_type, 'permanent');
});

test('an unknown assignment type is rejected and nothing is assigned', async () => {
  const p = await newPerson('Bad Type');
  const a = await newAsset('Mouse');
  assert.equal((await assign(a, p, { assignment_type: 'forever' })).status, 400);
  assert.equal((await assign(a, p, { assignment_type: 'checkout', due_date: 'next tuesday' })).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
});

async function makeLogin(name, email) {
  const created = (await admin.post('/api/users', { name, email })).body;
  const tok = db.prepare("SELECT token FROM tokens WHERE user_id = ? AND purpose = 'reset'").get(created.account_id);
  const c = makeClient(server);
  assert.equal((await c.post('/api/reset', { token: tok.token, password: 'employee-password-1' })).status, 200);
  return { client: c, id: created.id };
}

test('a non-admin can never create a permanent assignment; self check-out is always a checkout', async () => {
  {
    const me = await makeLogin('Self Server', 'selfserve@nutricost.com');
    const a = await newAsset('Shared Tripod');
    const due = isoPlus(1);
    // explicitly asking for permanent (with or without a date) is refused on the server, and nothing is created
    assert.equal((await me.client.post(`/api/assets/${a.id}/checkout`, { assignment_type: 'permanent' })).status, 403);
    assert.equal((await me.client.post(`/api/assets/${a.id}/checkout`, { assignment_type: 'permanent', due_date: due })).status, 403);
    assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
    // no type given: it is a checkout, so it still needs a return date
    assert.equal((await me.client.post(`/api/assets/${a.id}/checkout`, {})).status, 400);
    const ok = await me.client.post(`/api/assets/${a.id}/checkout`, { due_date: due, due_time: '17:00' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.assignment.assignment_type, ok.body.assignment.due_date, ok.body.assignment.due_time], ['checkout', due, '17:00']);
    // a non-admin also cannot hand equipment to someone else, permanently or otherwise
    const other = await newPerson('Someone Else');
    const b = await newAsset('Other Tripod');
    const r = await me.client.post(`/api/assets/${b.id}/checkout`, { employee_id: other.id, ...loan() });
    assert.equal(r.body.assignment.employee_id, me.id, 'a non-admin always checks out to themself');
  }
});

// ---------------------------------------------------------------- history
test('check-in preserves type, due date, people, timestamps, conditions and actors', async () => {
  const p = await newPerson('History Keeper');
  const a = await newAsset('Gimbal');
  const due = isoPlus(3);
  const out = (await assign(a, p, { assignment_type: 'checkout', due_date: due, due_time: '14:30', condition: 'Good', notes: 'Weekend shoot' })).body.assignment;
  const back = await admin.post(`/api/assets/${a.id}/checkin`, { condition: 'Fair', notes: 'scuffed' });
  assert.equal(back.status, 200);

  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(out.id);
  assert.equal(row.asset_id, a.id);
  assert.equal(row.employee_id, p.id);
  assert.equal(row.assignment_type, 'checkout');
  assert.equal(row.due_date, due, 'the original due date survives check-in');
  assert.equal(row.due_time, '14:30', 'and so does the due time');
  assert.ok(row.checked_out_at && row.returned_at);
  assert.equal([row.condition_out, row.condition_in, row.return_notes, row.notes].join('|'), 'Good|Fair|scuffed|Weekend shoot');
  assert.ok(row.checked_out_by && row.returned_to);

  const person = (await admin.get(`/api/users/${p.id}`)).body;
  const past = person.past.find((x) => x.id === out.id);
  assert.deepEqual([past.assignment_type, past.due_date, past.due_time], ['checkout', due, '14:30']);
  const acts = (await admin.get(`/api/assets/${a.id}`)).body.activity;
  assert.match(acts.find((x) => x.action === 'checked_out').details, new RegExp(`Temporary checkout · return by ${due} 14:30`));
  assert.match(acts.find((x) => x.action === 'checked_in').details, new RegExp(`Temporary checkout · return was due ${due} 14:30`));
});

test('a permanent assignment keeps its type in history after check-in and archiving', async () => {
  const p = await newPerson('Archive Owner');
  const a = await newAsset('Retired Dock');
  const id = (await assign(a, p)).body.assignment.id;
  await admin.post(`/api/assets/${a.id}/checkin`, {});
  assert.equal((await admin.post(`/api/assets/${a.id}/archive`, {})).status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  assert.deepEqual([row.assignment_type, row.employee_id, row.due_date], ['permanent', p.id, null]);
  assert.equal((await admin.get(`/api/users/${p.id}`)).body.past.find((x) => x.id === id).assignment_type, 'permanent');
});

// ---------------------------------------------------------------- integrity + capacity
test('the same employee cannot hold the same asset twice, at the API or the database', async () => {
  const p = await newPerson('Double Dipper');
  const seats = await newAsset('Design Suite', { license_seats: 5 });
  assert.equal((await assign(seats, p)).status, 200);
  const again = await assign(seats, p);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already has this asset/);
  assert.throws(() => db.prepare("INSERT INTO assignments (asset_id, employee_id, assignment_type) VALUES (?, ?, 'permanent')").run(seats.id, p.id), /UNIQUE/);
  // once returned, the same person may take it again
  await admin.post(`/api/assets/${seats.id}/checkin`, {});
  assert.equal((await assign(seats, p, loan())).status, 200);
});

test('a single-capacity asset rejects a second active assignee', async () => {
  const [p, q] = [await newPerson('First Holder'), await newPerson('Second Holder')];
  const a = await newAsset('One Of One');
  assert.equal((await assign(a, p)).status, 200);
  const r = await assign(a, q, loan());
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Already checked out to First Holder/);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id), 1);
});

test('a multi-seat asset allows assignments up to capacity and rejects one more', async () => {
  const a = await newAsset('Team License', { license_seats: 3, category: 'Software License' });
  const people = [await newPerson('Seat One'), await newPerson('Seat Two'), await newPerson('Seat Three'), await newPerson('Seat Four')];
  for (const p of people.slice(0, 3)) assert.equal((await assign(a, p)).status, 200);
  assert.equal((await admin.get(`/api/assets/${a.id}`)).body.asset.status, 'checked_out');
  const over = await assign(a, people[3]);
  assert.equal(over.status, 400);
  assert.match(over.body.error, /seats are in use/);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id), 3);
  // freeing a seat makes room again
  await admin.post(`/api/assets/${a.id}/checkin`, { assignment_id: (await admin.get(`/api/assets/${a.id}`)).body.holders[0].id });
  assert.equal((await assign(a, people[3])).status, 200);
});

test('concurrent HTTP assignment attempts cannot exceed capacity', async () => {
  const a = await newAsset('Contended Camera');
  const people = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => newPerson(`Racer ${i}`)));
  const results = await Promise.all(people.map((p) => assign(a, p, loan())));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, people.length - 1);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id), 1);
});

test('capacity is enforced across separate processes hitting the same database file', async () => {
  const a = await newAsset('Cross-process Seats', { license_seats: 2 });
  const people = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => newPerson(`Proc ${i}`)));
  const code = `
    const Database = require('better-sqlite3');
    const { createAssignment } = require(process.env.ASSIGN_MODULE);
    const d = new Database(process.env.DB_FILE, { timeout: 15000 });
    d.pragma('foreign_keys = ON');
    try { createAssignment(d, { assetId: Number(process.env.ASSET), employeeId: Number(process.env.EMP), actorAccountId: 1, actorIsAdmin: true, type: 'permanent' }); console.log('ok'); }
    catch (e) { console.log('rejected ' + e.message); }`;
  const run = (emp) => new Promise((resolve, reject) => execFile(process.execPath, ['-e', code], {
    env: { ...process.env, ASSIGN_MODULE: require.resolve('../src/assignments'), DB_FILE: path.join(dir, 'assets.db'), ASSET: String(a.id), EMP: String(emp.id) },
  }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()))));
  const out = await Promise.all(people.map(run));
  assert.equal(out.filter((o) => o === 'ok').length, 2, out.join(' / '));
  assert.equal(out.filter((o) => o.startsWith('rejected')).length, 4);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ? AND returned_at IS NULL', a.id), 2);
});

test('the capacity check and insert run in a single BEGIN IMMEDIATE transaction', async () => {
  const a = await newAsset('Mode Probe');
  const p = await newPerson('Mode Prober');
  const modes = [];
  const spy = {
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => {
      const tx = db.transaction(fn);
      const plain = () => { modes.push('deferred'); return tx(); };
      plain.immediate = () => { modes.push('immediate'); return tx.immediate(); };
      return plain;
    },
  };
  createAssignment(spy, { assetId: a.id, employeeId: p.id, actorAccountId: 1, actorIsAdmin: true });
  assert.deepEqual(modes, ['immediate']);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 1);
});

test('a failed assignment leaves no partial state (no row, no status change, no activity)', async () => {
  const a = await newAsset('Atomic Asset');
  const [p, q] = [await newPerson('Atomic One'), await newPerson('Atomic Two')];
  await assign(a, p);
  const before = { act: count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', a.id), status: db.prepare('SELECT status FROM assets WHERE id = ?').get(a.id).status };
  assert.equal((await assign(a, q)).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', a.id), before.act);
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(a.id).status, before.status);
});

// ---------------------------------------------------------------- history foreign keys
test('raw deletes that would erase history are blocked by RESTRICT', async () => {
  const p = await newPerson('Protected Person');
  const a = await newAsset('Protected Asset');
  await assign(a, p);
  await admin.post(`/api/assets/${a.id}/checkin`, {});
  await admin.post('/api/requests', { asset_id: a.id, user_id: p.id, message: 'about this' });

  assert.throws(() => db.prepare('DELETE FROM assets WHERE id = ?').run(a.id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('DELETE FROM employees WHERE id = ?').run(p.id), /FOREIGN KEY/);
  // each of assignments / activity / requests blocks the asset delete on its own
  for (const [table, keep] of [['assignments', ['activity', 'requests']], ['activity', ['assignments', 'requests']], ['requests', ['assignments', 'activity']]]) {
    db.exec('PRAGMA foreign_keys = OFF');
    const saved = keep.map((t) => db.prepare(`SELECT * FROM ${t} WHERE asset_id = ?`).all(a.id));
    for (const t of keep) db.prepare(`DELETE FROM ${t} WHERE asset_id = ?`).run(a.id);
    db.exec('PRAGMA foreign_keys = ON');
    try {
      assert.throws(() => db.prepare('DELETE FROM assets WHERE id = ?').run(a.id), /FOREIGN KEY/, `${table} must block deleting its asset`);
    } finally {
      db.exec('PRAGMA foreign_keys = OFF');
      keep.forEach((t, i) => { for (const r of saved[i]) { const cols = Object.keys(r); db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(r)); } });
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  assert.equal(count('SELECT COUNT(*) c FROM assets WHERE id = ?', a.id), 1);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 1);
  assert.ok(count('SELECT COUNT(*) c FROM activity WHERE asset_id = ?', a.id) >= 3);
});

test('history foreign keys are declared ON DELETE RESTRICT and the database is clean', () => {
  const onDelete = (table, col) => db.pragma(`foreign_key_list(${table})`).find((f) => f.from === col).on_delete;
  assert.equal(onDelete('assignments', 'asset_id'), 'RESTRICT');
  assert.equal(onDelete('assignments', 'employee_id'), 'RESTRICT');
  assert.equal(onDelete('activity', 'asset_id'), 'RESTRICT');
  assert.equal(onDelete('requests', 'asset_id'), 'RESTRICT');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.ok(!db.pragma('table_info(assignments)').some((c) => c.name === 'user_id'), 'assignments.user_id is now employee_id');
});

// ---------------------------------------------------------------- legacy migration
test('migrating a pre-1E database: a legacy due date means checkout, none means permanent; history is kept', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-1e-'));
  const old = new Database(path.join(tmp, 'legacy.db'));
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 5));
  old.prepare("INSERT INTO employees (name, work_email) VALUES ('Legacy One', 'one@nutricost.com'), ('Legacy Two', 'two@nutricost.com')").run();
  old.prepare("INSERT INTO accounts (employee_id, login_email, role) VALUES (1, 'one@nutricost.com', 'admin')").run();
  old.prepare("INSERT INTO assets (tag, name, category) VALUES ('L-1', 'Open Laptop', 'Laptop'), ('L-2', 'Returned Phone', 'Phone'), ('L-3', 'Dated Camera', 'Laptop'), ('L-4', 'Returned Loan', 'Other')").run();
  old.prepare("INSERT INTO assignments (asset_id, user_id, checked_out_by, checked_out_at) VALUES (1, 1, 1, '2025-01-01 09:00:00')").run();
  old.prepare("INSERT INTO assignments (asset_id, user_id, checked_out_by, checked_out_at, returned_at, returned_to, condition_in) VALUES (2, 2, 1, '2025-02-01 09:00:00', '2025-03-01 09:00:00', 1, 'Good')").run();
  old.prepare("INSERT INTO assignments (asset_id, user_id, checked_out_by, due_date) VALUES (3, 2, 1, '2025-12-01')").run();
  old.prepare("INSERT INTO assignments (asset_id, user_id, checked_out_by, due_date, returned_at, returned_to) VALUES (4, 1, 1, '2025-04-01', '2025-03-30 09:00:00', 1)").run();
  old.prepare("INSERT INTO activity (asset_id, actor_id, subject_user_id, action) VALUES (1, 1, 1, 'checked_out')").run();
  old.prepare("INSERT INTO requests (type, user_id, asset_id) VALUES ('equipment', 2, 3)").run();
  const assignSeq = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assignments'").get().seq;

  assert.deepEqual(runMigrations(old, migrations.filter((m) => m.id <= 6)), [6]);
  const rows = old.prepare('SELECT * FROM assignments ORDER BY id').all();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.assignment_type), ['permanent', 'permanent', 'checkout', 'checkout'], 'decided by due_date alone, never by category');
  assert.deepEqual(rows.map((r) => r.due_date), [null, null, '2025-12-01', '2025-04-01'], 'legacy due dates are preserved');
  assert.ok(rows.every((r) => r.due_time === null), 'legacy rows have no due time');
  assert.deepEqual(rows.map((r) => r.employee_id), [1, 2, 2, 1], 'the person reference is carried over as employee_id');
  assert.equal(rows[1].returned_at, '2025-03-01 09:00:00');
  assert.equal(rows[1].condition_in, 'Good');
  assert.equal(old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'assignments'").get().seq, assignSeq);
  assert.equal(old.prepare('SELECT COUNT(*) c FROM activity').get().c, 1);
  assert.equal(old.prepare('SELECT asset_id FROM requests').get().asset_id, 3);
  assert.equal(old.pragma('foreign_key_check').length, 0);
  assert.equal(old.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_assign_active_unique'").get());
  assert.throws(() => old.prepare('INSERT INTO assignments (asset_id, employee_id) VALUES (1, 1)').run(), /UNIQUE/);
  assert.throws(() => old.prepare("INSERT INTO assignments (asset_id, employee_id, assignment_type) VALUES (2, 1, 'loaner')").run(), /CHECK/);
  old.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a legacy database with no assignments at all still migrates cleanly', () => {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 5));
  assert.deepEqual(runMigrations(old, migrations.filter((m) => m.id <= 6)), [6]);
  assert.equal(old.prepare('SELECT COUNT(*) c FROM assignments').get().c, 0);
  assert.equal(old.pragma('foreign_key_check').length, 0);
});

test('the migration refuses, changing nothing, if legacy data already has a duplicate active assignment', () => {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  runMigrations(old, migrations.filter((m) => m.id <= 5));
  old.prepare("INSERT INTO employees (name) VALUES ('Dup Person')").run();
  old.prepare("INSERT INTO assets (tag, name) VALUES ('D-1', 'Dup')").run();
  old.prepare('INSERT INTO assignments (asset_id, user_id) VALUES (1, 1)').run();
  old.prepare('INSERT INTO assignments (asset_id, user_id) VALUES (1, 1)').run();
  assert.throws(() => runMigrations(old, migrations), /duplicates exist/);
  assert.ok(old.pragma('table_info(assignments)').some((c) => c.name === 'user_id'), 'the old table is untouched');
  assert.equal(old.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE id = 6').get().c, 0);
});

// ---------------------------------------------------------------- people picker / roster foundation
test('an employee without a login can be picked and assigned, and both kinds show on their page', async () => {
  const p = await newPerson('No Login Nate');
  const picker = (await admin.get('/api/users')).body;
  assert.ok(picker.some((x) => x.id === p.id && x.has_account === false), 'no-login employees appear in the assignee picker');
  const desk = await newAsset('Nate Desktop');
  const cam = await newAsset('Nate Camera');
  await assign(desk, p);
  await assign(cam, p, { assignment_type: 'checkout', due_date: isoPlus(2) });
  const detail = (await admin.get(`/api/users/${p.id}`)).body;
  assert.deepEqual(detail.current.map((c) => c.assignment_type).sort(), ['checkout', 'permanent']);
  assert.equal(detail.current.find((c) => c.assignment_type === 'checkout').due_date, isoPlus(2));
  assert.equal((await admin.get('/api/users')).body.find((x) => x.id === p.id).asset_count, 2);
});

test('list and detail responses expose what a future roster needs to split permanent vs temporary', async () => {
  const p = await newPerson('Roster Reader');
  const perm = await newAsset('Roster Monitor');
  const temp = await newAsset('Roster Lens');
  await assign(perm, p);
  await assign(temp, p, loan());
  const list = (await admin.get(`/api/assets?employee_id=${p.id}`)).body;
  const byName = Object.fromEntries(list.map((a) => [a.name, a]));
  assert.deepEqual([byName['Roster Monitor'].permanent_holders, byName['Roster Monitor'].checkout_holders], [1, 0]);
  assert.deepEqual([byName['Roster Lens'].permanent_holders, byName['Roster Lens'].checkout_holders], [0, 1]);
  assert.equal((await admin.get(`/api/assets?user_id=${p.id}`)).body.length, 2, 'user_id query param still works as an alias');
  const dash = (await admin.get('/api/dashboard')).body;
  assert.ok(Array.isArray(dash.mine));
});

// ---------------------------------------------------------------- employee permanent-assignment request
const asRow = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const requestPermanent = (client, asset, extra = {}) => client.post('/api/requests', { asset_id: asset.id, category: asset.category, requested_assignment_type: 'permanent', ...extra });

test('an employee cannot directly create a permanent assignment, and the refusal is friendly text, not a status code', async () => {
  {
    const me = await makeLogin('Direct Attempt', 'directattempt@nutricost.com');
    const a = await newAsset('Direct Attempt Dock');
    const r = await me.client.post(`/api/assets/${a.id}/checkout`, { assignment_type: 'permanent' });
    assert.equal(r.status, 403, 'the server guard stays for forged/direct API calls');
    assert.match(r.body.error, /need IT approval/);
    assert.doesNotMatch(r.body.error, /403|forbidden/i);
    assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
  }
});

test('an employee asking for a permanent assignment creates a REQUEST, never an assignment', async () => {
  const me = await makeLogin('Permanent Asker', 'permanentasker@nutricost.com');
  const a = await newAsset('Asked-For Desktop', { category: 'Desktop' });
  const r = await requestPermanent(me.client, a, { message: 'My desk machine died' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = asRow(r.body.id);
  assert.deepEqual([row.type, row.status, row.user_id, row.asset_id, row.requested_assignment_type], ['equipment', 'open', me.id, a.id, 'permanent']);
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0, 'no assignment yet');
  assert.equal((await admin.get(`/api/assets/${a.id}`)).body.asset.status, 'available', 'not checked out');
  const act = (await admin.get(`/api/assets/${a.id}`)).body.activity.find((x) => x.action === 'requested');
  assert.match(act.details, /Permanent assignment requested/);
  // the admin can see it is specifically a permanent-assignment request; the employee sees their own
  const adminView = (await admin.get('/api/requests?status=open')).body.find((x) => x.id === r.body.id);
  assert.equal(adminView.requested_assignment_type, 'permanent');
  assert.equal(adminView.asset_tag, a.tag);
  assert.equal((await me.client.get('/api/requests')).body.find((x) => x.id === r.body.id).requested_assignment_type, 'permanent');
  assert.ok(db.prepare("SELECT body FROM outbox WHERE subject LIKE 'Permanent assignment request%' ORDER BY id DESC").get(), 'admins are emailed that it is a permanent request');
});

test('a permanent-assignment request must name the asset and use a valid type', async () => {
  const me = await makeLogin('Sloppy Asker', 'sloppyasker@nutricost.com');
  assert.equal((await me.client.post('/api/requests', { category: 'Desktop', requested_assignment_type: 'permanent' })).status, 400);
  assert.equal((await me.client.post('/api/requests', { category: 'Desktop', requested_assignment_type: 'forever' })).status, 400);
  const plain = await me.client.post('/api/requests', { category: 'Desktop', message: 'any desktop' });
  assert.equal(asRow(plain.body.id).requested_assignment_type, null, 'an ordinary request is unchanged');
});

test('cancelling a permanent-assignment request creates no assignment', async () => {
  const me = await makeLogin('Canceller', 'canceller@nutricost.com');
  const a = await newAsset('Cancelled Monitor');
  const r = (await requestPermanent(me.client, a)).body;
  assert.equal((await me.client.post(`/api/requests/${r.id}/cancel`, {})).status, 200);
  assert.equal(asRow(r.id).status, 'cancelled');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
});

test('admin approval of a permanent request creates the permanent assignment (no due date/time); employees cannot approve', async () => {
  const me = await makeLogin('Approved Person', 'approvedperson@nutricost.com');
  const a = await newAsset('Approved Laptop', { category: 'Laptop' });
  const r = (await requestPermanent(me.client, a)).body;
  assert.equal((await me.client.post(`/api/requests/${r.id}/approve`, { asset_id: a.id })).status, 403, 'only an admin approves');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);

  // approval names the asset and leaves the type out: it follows the request (permanent)
  const ok = await admin.post(`/api/requests/${r.id}/approve`, { asset_id: a.id, due_date: isoPlus(3), due_time: '10:00' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const asg = db.prepare('SELECT * FROM assignments WHERE asset_id = ?').get(a.id);
  assert.deepEqual([asg.assignment_type, asg.employee_id, asg.due_date, asg.due_time, asg.returned_at], ['permanent', me.id, null, null, null]);
  assert.equal(asRow(r.id).status, 'completed');
  assert.equal((await admin.get(`/api/assets/${a.id}`)).body.asset.status, 'checked_out');
  assert.ok(asg.checked_out_by && asg.checked_out_by !== me.id, 'the approving admin is the recorded actor');
});

test('denying a permanent request creates no assignment', async () => {
  const me = await makeLogin('Denied Person', 'deniedperson@nutricost.com');
  const a = await newAsset('Denied Phone');
  const r = (await requestPermanent(me.client, a)).body;
  assert.equal((await admin.post(`/api/requests/${r.id}/deny`, { note: 'Use a loaner for now' })).status, 200);
  assert.equal(asRow(r.id).status, 'denied');
  assert.equal(count('SELECT COUNT(*) c FROM assignments WHERE asset_id = ?', a.id), 0);
  assert.equal((await admin.get(`/api/assets/${a.id}`)).body.asset.status, 'available');
});

test('requests gained only one nullable column, and legacy requests keep NULL', () => {
  const col = db.pragma('table_info(requests)').find((c) => c.name === 'requested_assignment_type');
  assert.ok(col && col.notnull === 0);
  assert.throws(() => db.prepare("UPDATE requests SET requested_assignment_type = 'forever' WHERE id = (SELECT MIN(id) FROM requests)").run(), /CHECK/);
});

// The UI is a plain browser script with no DOM test harness here, so these pin its source-level guarantees.
test('front end: employees are sent to the approval notice instead of a permanent check-out, and never see a bare status code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function requestPermanentAssignment'), src.indexOf('// Return date (required)'));
  assert.match(fn, /Permanent assignment requires approval/);
  assert.match(fn, /Permanent equipment assignments must be approved by IT\./);
  assert.match(fn, /'Send request'/);
  assert.ok(fn.indexOf('if (!ok) return false') > -1 && fn.indexOf('if (!ok) return false') < fn.indexOf('/api/requests'), 'Cancel returns before anything is created');
  assert.match(fn, /requested_assignment_type: 'permanent'/);
  // the self check-out submit path: permanent goes through the request helper; its checkout POST never carries assignment_type
  const self = src.slice(src.indexOf('function selfCheckoutSheet'), src.indexOf('// Shown after an admin assigns equipment;'));
  assert.match(self, /mode === 'permanent'\) \{ if \(await requestPermanentAssignment\(a\)\)/);
  const checkoutCall = /api\('POST', `\/api\/assets\/\$\{a\.id\}\/checkout`, (\{[^}]*\})\)/.exec(self);
  assert.ok(checkoutCall && !/assignment_type/.test(checkoutCall[1]));
  assert.doesNotMatch(src, /Request failed \(\$\{res\.status\}\)/, 'no bare status codes in user-facing errors');
});

test('front end: the self-checkout sheet offers Scan barcode through the one existing scanner and lookup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal((src.match(/function openScanner\(/g) || []).length, 1, 'there is still exactly one scanner implementation');
  const self = src.slice(src.indexOf('function selfCheckoutSheet'), src.indexOf('// Shown after an admin assigns equipment;'));
  assert.match(self, /Scan barcode/);
  assert.match(self, /openScanner\(\{/);
  assert.match(self, /\/api\/assets\/lookup\//, 'resolved with the existing tag/serial lookup');
  assert.match(self, /No asset found for/, 'unknown codes use the existing friendly message');
  assert.match(self, /close\(\); selfCheckoutSheet\(n\)/, 'a found, available asset reopens the same sheet for the scanned asset');
  assert.match(self, /available to check out right now/, 'unavailable assets get a friendly message');
  assert.match(self, /returnFields\(\)/, 'the same return-date fields (date required) are used');
});
