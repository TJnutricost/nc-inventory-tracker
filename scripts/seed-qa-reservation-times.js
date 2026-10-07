// QA fixtures for Slice 8.1 (optional reservation times / partial-day availability). DEVELOPMENT ONLY.
//
// Rebuilds an ISOLATED database at ./data-qa: the normal dev seed (scripts/seed-dev.js, reused untouched) plus eight clearly named "QA 8.1 · S<n>"
// assets, each set up for one manual-QA scenario, all created through the real HTTP API (so every rule and the activity log behave as in production).
// It never touches ./data or ./data-dev, so it is safe to run while `npm run dev` is using ./data-dev.
//
//   node scripts/seed-qa-reservation-times.js
//   DATA_DIR=./data-qa PORT=3001 npm start        (admin: dana.ito@example.com; every account shares the dev password)
//
// The dates are fixed (Oct 12-24 of QA_YEAR, default 2026) so reruns give identical scenarios. Reservations cannot start in the past, so once Oct 12 has
// passed, rerun with QA_YEAR=<next year>. Seeding never sends email (NC_NO_EXTERNAL_MAIL is set by seed-dev.js before the app loads).
'use strict';

const path = require('path');
const assert = require('assert/strict');
const seed = require('./seed-dev');

const QA_DATA_DIR = path.join(__dirname, '..', 'data-qa');
const YEAR = process.env.QA_YEAR || '2026';
const d = (mmdd) => `${YEAR}-${mmdd}`;
const emailOf = (name) => `${name.toLowerCase().replace(' ', '.')}@example.com`;

// name, scenario label (what the asset is for)
const ASSETS = [
  ['S1', 'Partial-day, non-overlapping'],
  ['S2', 'Partial overlap'],
  ['S3', 'Checked out now'],
  ['S4', 'Waitlist'],
  ['S5', 'Return-time-only'],
  ['S6', 'Pickup-time-only'],
  ['S7', 'Shortening'],
  ['S8', 'Multi-day with times'],
];

async function loginAs(server, name) {
  const c = seed.makeClient(server);
  await c.post('/api/login', { email: emailOf(name), password: seed.DEV_PASSWORD });
  return c;
}

async function seedQa() {
  await seed.seedDatabase({ dataDir: QA_DATA_DIR, quiet: true });

  const { app, db } = seed.bootApp(QA_DATA_DIR);
  const server = await seed.startServer(app);
  try {
    const admin = seed.makeClient(server);
    await admin.post('/api/login', { email: 'dana.ito@example.com', password: seed.DEV_PASSWORD });
    const people = {};
    for (const n of ['Bailey Brooks', 'Casey Chen', 'Dakota Diaz', 'Emerson Ellis', 'Finley Flores', 'Gray Garcia', 'Harper Hughes', 'Indigo Ibarra']) {
      people[n.split(' ')[0]] = { id: db.prepare('SELECT id FROM employees WHERE name = ?').get(n).id, api: await loginAs(server, n) };
    }

    // The QA assets: new, so no existing seeded asset's status, history or name is touched. Filed under the existing Camera category.
    const asset = {};
    for (const [key, label] of ASSETS) {
      const created = await admin.post('/api/assets', {
        name: `QA 8.1 · ${key} ${label}`, category: 'Camera', brand: 'QA', model: `${key} ${label}`, serial: `QA81-${key}`,
        condition: 'Good', location: 'HQ - IT Room', available_to_request: true, reservation_requires_approval: false,
        notes: `Slice 8.1 manual-QA fixture (${key}). Safe to delete.`,
      });
      asset[key] = created;
    }
    const reserve = (who, key, start, end, startTime, endTime) =>
      people[who].api.post(`/api/assets/${asset[key].id}/reservations`, { start_date: d(start), end_date: d(end), start_time: startTime, end_time: endTime });
    const waitlist = (who, key, start, end) => people[who].api.post(`/api/assets/${asset[key].id}/waitlist`, { start_date: d(start), end_date: d(end) });

    // S1: Bailey 8-1, Gray 1-5 on Oct 12. Adjacent, so both are reserved and nothing is waitlisted.
    const bailey = await reserve('Bailey', 'S1', '10-12', '10-12', '08:00', '13:00');
    const gray = await reserve('Gray', 'S1', '10-12', '10-12', '13:00', '17:00');
    assert.equal(bailey.waitlisted.length, 0);
    assert.equal(gray.waitlisted.length, 0, 'S1: adjacent times are not an overlap');

    // S2: Casey's confirmed 8-1 on Oct 13. The overlapping 12-2 request is left for the tester (Dakota) to make: 12-1 is waitlisted, 1-2 is reserved.
    const casey = await reserve('Casey', 'S2', '10-13', '10-13', '08:00', '13:00');
    assert.equal(casey.reserved[0].status, 'confirmed');

    // S3: held by Emerson until Oct 14 at 5:00 PM (a temporary checkout). The tester (Finley) asks for Oct 14 12:00 PM - 8:00 PM: 12-5 is waitlisted, 5-8 is reserved.
    await admin.post(`/api/assets/${asset.S3.id}/checkout`, { employee_id: people.Emerson.id, assignment_type: 'checkout', due_date: d('10-14'), due_time: '17:00', notes: 'QA 8.1 S3: checked out through Oct 14, 5:00 PM' });

    // S4: Harper has Oct 20-23 all day. Indigo joins first (Oct 21-22), then Gray (Oct 22-23): the two waitlist entries overlap each other (waiting is demand, not possession).
    const harper = await reserve('Harper', 'S4', '10-20', '10-23');
    assert.equal(harper.reserved[0].status, 'confirmed');
    const first = await waitlist('Indigo', 'S4', '10-21', '10-22');
    const second = await waitlist('Gray', 'S4', '10-22', '10-23');
    assert.equal(first.phase, 'waiting');
    assert.equal(second.phase, 'waiting');
    assert.equal(first.position, 1);
    assert.equal(second.position, 2, 'S4: Gray queues behind Indigo (overlapping ranges)');

    // S5-S8: one reservation each.
    await reserve('Casey', 'S5', '10-14', '10-14', undefined, '13:00');
    await reserve('Dakota', 'S6', '10-15', '10-15', '13:00', undefined);
    await reserve('Emerson', 'S7', '10-16', '10-16', '08:00', '17:00');
    await reserve('Finley', 'S8', '10-17', '10-19', '14:00', '11:00');

    // Read-only sanity check of what the testers will meet (writes nothing): Dakota asking for S2's overlap, Finley for S3's.
    const s2 = await people.Dakota.api.get(`/api/assets/${asset.S2.id}/range-check?start_date=${d('10-13')}&end_date=${d('10-13')}&start_time=12:00&end_time=14:00`);
    const s3 = await people.Finley.api.get(`/api/assets/${asset.S3.id}/range-check?start_date=${d('10-14')}&end_date=${d('10-14')}&start_time=12:00&end_time=20:00`);
    assert.equal(s2.outcome, 'partial');
    assert.deepEqual([s2.waitlisted[0].start_time, s2.waitlisted[0].end_time, s2.reserved[0].start_time, s2.reserved[0].end_time], ['12:00', '13:00', '13:00', '14:00']);
    assert.equal(s3.outcome, 'partial');
    assert.deepEqual([s3.waitlisted[0].start_time, s3.waitlisted[0].end_time, s3.reserved[0].start_time, s3.reserved[0].end_time], ['12:00', '17:00', '17:00', '20:00']);

    const tags = Object.fromEntries(Object.entries(asset).map(([k, a]) => [k, db.prepare('SELECT tag FROM assets WHERE id = ?').get(a.id).tag]));
    return { tags, ids: Object.fromEntries(Object.entries(asset).map(([k, a]) => [k, a.id])) };
  } finally {
    await seed.stopServer(server);
    db.close();
  }
}

if (require.main === module) {
  seedQa().then(({ tags, ids }) => {
    console.log(`QA 8.1 fixtures loaded into ${QA_DATA_DIR} (year ${YEAR}).`);
    for (const [key, label] of ASSETS) console.log(`  ${key}  ${tags[key]}  (asset id ${ids[key]})  ${label}`);
    console.log(`\nRun:  DATA_DIR=./data-qa PORT=3001 npm start`);
    console.log(`Login: dana.ito@example.com (admin) or <first>.<last>@example.com, password ${seed.DEV_PASSWORD}`);
  }).catch((err) => { console.error('QA seed failed:', err); process.exitCode = 1; });
}

module.exports = { seedQa, QA_DATA_DIR };
