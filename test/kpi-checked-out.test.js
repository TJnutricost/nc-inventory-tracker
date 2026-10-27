// Home "Checked out" = assets on a TEMPORARY checkout. A permanent assignment (a license seat, or equipment IT assigned for good) is not a
// checkout. The card (GET /api/dashboard stats.checked_out) and its list (GET /api/assets?status=checked_out) share that one definition;
// Available keeps respecting the remaining seats of a multi-seat license. No status or assignment data is changed by any of this.
// Runs on both drivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, startServer, stopServer, setupAdmin } = require('./helpers');

let server; let admin;
before(async () => { const b = bootApp(); server = await startServer(b.app); ({ client: admin } = await setupAdmin(server)); });
after(() => stopServer(server));

const person = async (n) => (await admin.post('/api/users', { name: `Holder ${n}`, email: `holder${n}@nutricost.com`, invite: false })).body.id;
const make = async (body) => (await admin.post('/api/assets', { category: 'Other', ...body })).body;
const stats = async () => (await admin.get('/api/dashboard')).body.stats;
const ids = async (status) => (await admin.get('/api/assets?status=' + status)).body.map((a) => a.id).sort((a, b) => a - b);
const give = (asset, user, extra) => admin.post(`/api/assets/${asset.id}/checkout`, { user_id: user, ...extra });
const FUTURE = '2099-01-01';

test('a multi-seat license with permanent assignments is Available, not Checked out; the card and its list agree', async () => {
  const base = await stats();
  const before = { out: await ids('checked_out'), avail: await ids('available') };
  const lic = await make({ name: 'Microsoft 365 Business Standard', license_seats: 25 });
  for (let n = 1; n <= 3; n++) assert.equal((await give(lic, await person(n), { assignment_type: 'permanent' })).status, 200);
  const row = (await admin.get('/api/assets?status=available')).body.find((a) => a.id === lic.id);
  assert.ok(row, 'still Available: 22 of 25 seats remain');
  assert.equal(row.status, 'available');
  const s = await stats();
  assert.equal(s.checked_out, base.checked_out, 'three permanent seats are not checkouts');
  assert.equal(s.available, base.available + 1);
  assert.deepEqual(await ids('checked_out'), before.out, 'and the list does not include it');
  assert.equal((await ids('checked_out')).length, s.checked_out, 'card = list');
  assert.equal((await ids('available')).length, s.available);
  assert.ok((await ids('active')).includes(lic.id), 'it is still an active asset');
});

test('a temporary checkout of one seat adds it to Checked out (and keeps it Available while seats remain); permanent seats beside it do not matter', async () => {
  const lic = await make({ name: 'Mixed license', license_seats: 5 });
  await give(lic, await person(11), { assignment_type: 'permanent' });
  const base = await stats();
  assert.ok(!(await ids('checked_out')).includes(lic.id));
  assert.equal((await give(lic, await person(12), { assignment_type: 'checkout', due_date: FUTURE })).status, 200);
  const s = await stats();
  assert.equal(s.checked_out, base.checked_out + 1, 'one temporary checkout');
  assert.ok((await ids('checked_out')).includes(lic.id));
  assert.ok((await ids('available')).includes(lic.id), 'seats remain, so it is also Available');
  assert.equal((await ids('checked_out')).length, s.checked_out);
  // a second temporary checkout of the same asset is still ONE asset on the card
  await give(lic, await person(13), { assignment_type: 'checkout', due_date: FUTURE });
  assert.equal((await stats()).checked_out, s.checked_out);
  assert.equal((await ids('checked_out')).length, s.checked_out);
});

test('single-seat equipment: a temporary checkout is Checked out; a permanent assignment is neither Checked out nor Available (it stays Active)', async () => {
  const temp = await make({ name: 'Loaner laptop' });
  const perm = await make({ name: 'Assigned laptop' });
  const base = await stats();
  assert.equal((await give(temp, await person(21), { assignment_type: 'checkout', due_date: FUTURE })).status, 200);
  assert.equal((await give(perm, await person(22), { assignment_type: 'permanent' })).status, 200);
  const s = await stats();
  assert.equal(s.checked_out, base.checked_out + 1);
  assert.equal(s.available, base.available - 2, 'both are in use, so neither is available');
  const out = await ids('checked_out');
  assert.ok(out.includes(temp.id) && !out.includes(perm.id));
  assert.ok(!(await ids('available')).some((id) => id === temp.id || id === perm.id));
  assert.ok((await ids('active')).includes(perm.id));
  assert.equal(out.length, s.checked_out);
  // overdue still follows temporary checkouts only
  const late = await make({ name: 'Late laptop' });
  await give(late, await person(23), { assignment_type: 'checkout', due_date: '2000-01-01' });
  const s2 = await stats();
  assert.equal(s2.overdue, s.overdue + 1);
  assert.equal((await ids('overdue')).length, s2.overdue);
  assert.equal(s2.checked_out, s.checked_out + 1);
});

test('returning a temporary checkout takes the asset off Checked out; the permanent seat beside it is untouched', async () => {
  const lic = await make({ name: 'Return license', license_seats: 4 });
  await give(lic, await person(31), { assignment_type: 'permanent' });
  await give(lic, await person(32), { assignment_type: 'checkout', due_date: FUTURE });
  assert.ok((await ids('checked_out')).includes(lic.id));
  const detail = (await admin.get('/api/assets/' + lic.id)).body;
  const open = (detail.holders || (detail.asset && detail.asset.holders) || []);
  const temp = open.find((h) => h.assignment_type === 'checkout');
  assert.ok(temp, 'the detail lists the temporary holder');
  assert.equal((await admin.post(`/api/assets/${lic.id}/checkin`, { assignment_id: temp.id || temp.assignment_id })).status, 200);
  assert.ok(!(await ids('checked_out')).includes(lic.id));
  const after_ = (await admin.get('/api/assets/' + lic.id)).body;
  assert.equal((after_.holders || (after_.asset && after_.asset.holders) || []).filter((h) => h.assignment_type === 'permanent').length, 1, 'the permanent seat is still assigned');
});
