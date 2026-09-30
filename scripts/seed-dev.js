// Development-only seed for the Nutricost IT Assets app.
//
// Wipes and rebuilds an ISOLATED SQLite database (default ./data-dev) with a
// deterministic set of dummy users, assets and history, driven entirely
// through the real HTTP API (src/server.js) so business logic — tag
// generation, checkout/checkin, requests, activity logging, the invite/reset
// flow — is reused rather than re-implemented here.
//
// Never touches the normal ./data directory: see assertSafeDevDir.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DEV_DATA_DIR = path.join(ROOT, 'data-dev');
const DEV_PASSWORD = 'DevPass!2026';
const DEV_APP_URL = 'http://localhost:3179';

const ADMIN = { name: 'Dana Ito', email: 'dana.ito@example.com', department: 'IT', title: 'IT Manager' };

const USERS = [
  { name: 'Bailey Brooks', email: 'bailey.brooks@example.com', department: 'Marketing', title: 'Content Manager', building: 'Building 4' },
  { name: 'Casey Chen', email: 'casey.chen@example.com', department: 'Sales', title: 'Account Executive' },
  { name: 'Dakota Diaz', email: 'dakota.diaz@example.com', department: 'Engineering', title: 'Software Engineer' },
  { name: 'Emerson Ellis', email: 'emerson.ellis@example.com', department: 'Finance', title: 'Staff Accountant' },
  { name: 'Finley Flores', email: 'finley.flores@example.com', department: 'Customer Support', title: 'Support Specialist' },
  { name: 'Gray Garcia', email: 'gray.garcia@example.com', department: 'Engineering', title: 'QA Engineer' },
  { name: 'Harper Hughes', email: 'harper.hughes@example.com', department: 'Operations', title: 'Warehouse Lead', building: 'Warehouse 2' },
  { name: 'Indigo Ibarra', email: 'indigo.ibarra@example.com', department: 'Marketing', title: 'Designer' },
];
// An employee who exists only as an equipment assignee: no login account is ever created for them.
const NO_LOGIN_EMPLOYEE = { name: 'Jules Jaramillo', email: 'jules.jaramillo@example.com', department: 'Warehouse', title: 'Forklift Operator', login: false };

const LOCATIONS = ['HQ - IT Room', 'HQ - Office', 'Warehouse', 'Remote'];
const CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor', 'Broken'];

const ASSET_GROUPS = [
  { category: 'Laptop', cost: 1400, vendor: 'CDW', items: [
    ['Dell', 'Latitude 5440'], ['Dell', 'Latitude 5440'],
    ['Lenovo', 'ThinkPad T14'], ['Lenovo', 'ThinkPad T14'],
    ['HP', 'EliteBook 840 G10'],
    ['Apple', 'MacBook Air M2'], ['Apple', 'MacBook Air M2'], ['Apple', 'MacBook Air M2'],
    ['Apple', 'MacBook Pro 14"'], ['Apple', 'MacBook Pro 14"'],
  ] },
  { category: 'Desktop', cost: 1100, vendor: 'CDW', items: [
    ['Dell', 'OptiPlex 7010'], ['Dell', 'OptiPlex 7010'],
    ['Apple', 'Mac Mini M2'], ['Apple', 'Mac Mini M2'],
  ] },
  { category: 'Monitor', cost: 260, vendor: 'B&H Photo', items: [
    ['Dell', 'P2422H'], ['Dell', 'P2422H'], ['Dell', 'P2422H'],
    ['LG', '27UL850-W'], ['LG', '27UL850-W'], ['LG', '27UL850-W'],
  ] },
  { category: 'Keyboard & Mouse', cost: 180, vendor: 'Amazon Business', items: [
    ['Logitech', 'MX Keys + MX Master 3S'], ['Logitech', 'MX Keys + MX Master 3S'],
    ['Apple', 'Magic Keyboard + Magic Mouse'], ['Apple', 'Magic Keyboard + Magic Mouse'],
  ] },
  { category: 'Headset', cost: 210, vendor: 'Amazon Business', items: [
    ['Jabra', 'Evolve2 65'], ['Jabra', 'Evolve2 65'], ['Logitech', 'Zone 300'],
  ] },
  { category: 'Dock / Adapter', cost: 230, vendor: 'CDW', items: [
    ['CalDigit', 'TS4'], ['CalDigit', 'TS4'], ['Anker', '565 USB-C Hub'],
  ] },
  { category: 'Phone', cost: 650, vendor: 'Verizon', items: [
    ['Apple', 'iPhone 13'], ['Apple', 'iPhone 13'], ['Apple', 'iPhone SE (3rd gen)'], ['Apple', 'iPhone SE (3rd gen)'],
  ] },
  { category: 'Tablet', cost: 450, vendor: 'Apple Business', items: [
    ['Apple', 'iPad (9th gen)'], ['Apple', 'iPad (9th gen)'], ['Apple', 'iPad Air'],
  ] },
  { category: 'Printer / Scanner', cost: 240, vendor: 'Amazon Business', items: [
    ['Brother', 'HL-L2350DW'], ['Epson', 'WorkForce ES-400'],
  ] },
  { category: 'Networking', cost: 190, vendor: 'CDW', items: [
    ['Ubiquiti', 'UniFi AP U6-Lite'], ['Netgear', 'GS308 Switch'], ['TP-Link', 'Archer AX55 Router'],
  ] },
  { category: 'Appliance', cost: 320, vendor: 'Amazon Business', items: [
    ['Danby', 'Mini Fridge DAR033'], ['Breville', 'Microwave BMO650'],
  ] },
  { category: 'Software License', cost: 0, vendor: null, items: [
    ['Microsoft', '365 Business Standard'], ['Adobe', 'Creative Cloud All Apps'],
  ] },
  { category: 'Other', cost: 900, vendor: 'B&H Photo', items: [
    ['Sony', 'a6400 Camera Body'], ['Rode', 'NT-USB Mic + Tripod Kit'],
  ] },
];
const EXPECTED_ASSET_COUNT = ASSET_GROUPS.reduce((n, g) => n + g.items.length, 0);

function assertSafeDevDir(dataDir) {
  const resolved = path.resolve(dataDir);
  if (resolved === path.resolve(REAL_DATA_DIR)) {
    throw new Error(`Refusing to seed: target "${resolved}" is the normal application data directory.`);
  }
  if (resolved === path.resolve(ROOT) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to seed: target "${resolved}" is not a dedicated data directory.`);
  }
}

// ---------- minimal HTTP boot/client (same shape as test/helpers.js) ----------
function bootApp(dataDir) {
  process.env.DATA_DIR = dataDir;
  process.env.SESSION_SECRET = 'dev-seed-session-secret-not-for-production';
  process.env.APP_URL = DEV_APP_URL;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  for (const mod of ['../src/db', '../src/mailer', '../src/server']) delete require.cache[require.resolve(mod)];
  const app = require('../src/server');
  const { db } = require('../src/db');
  return { app, db };
}
function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
function makeClient(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function req(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const sc of setCookie) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
    return json;
  }
  return { get: (u) => req('GET', u), post: (u, b) => req('POST', u, b), put: (u, b) => req('PUT', u, b), del: (u) => req('DELETE', u) };
}

// ---------- dataset construction ----------
function buildAssetDefs() {
  const defs = [];
  let i = 0;
  for (const group of ASSET_GROUPS) {
    for (const [brand, model] of group.items) {
      const purchaseYear = 2023 + (i % 3); // 2023..2025
      const purchaseMonth = String(1 + (i % 12)).padStart(2, '0');
      const purchaseDay = String(1 + (i % 27)).padStart(2, '0');
      const noPurchaseInfo = i % 11 === 4; // a handful of hand-me-down items
      const warrantyPhase = i % 3; // 0=none, 1=active, 2=expired
      defs.push({
        name: `${brand} ${model}`,
        category: group.category,
        brand,
        model,
        serial: `${group.category.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${String(1000 + i)}`,
        condition: CONDITIONS[i % CONDITIONS.length],
        location: LOCATIONS[i % LOCATIONS.length],
        purchase_date: noPurchaseInfo ? null : `${purchaseYear}-${purchaseMonth}-${purchaseDay}`,
        purchase_cost: noPurchaseInfo ? null : group.cost + (i % 5) * 15,
        vendor: noPurchaseInfo ? null : group.vendor,
        warranty_expires: warrantyPhase === 0 ? null : warrantyPhase === 1 ? '2027-08-01' : '2024-03-01',
        notes: null,
      });
      i++;
    }
  }
  return defs;
}

// Mutates specific defs in place to guarantee the coverage Phase 0B asked for:
// a missing serial, an unusually long serial, one of each non-available status,
// and software-license seat usage.
function applySpecialCases(defs) {
  const nth = (name, index) => defs.filter((d) => d.name === name)[index];

  nth('Apple Magic Keyboard + Magic Mouse', 0).serial = null;
  nth('Anker 565 USB-C Hub', 0).serial = 'SN-ANKER-565-USBCHUB-0000000001234567890-REV-B-LONG';

  const maintenanceMonitor = nth('Dell P2422H', 1);
  maintenanceMonitor.status = 'maintenance';
  maintenanceMonitor.condition = 'Fair';
  maintenanceMonitor.notes = 'Flickering backlight — sent for repair.';

  const retiredDesktop = nth('Dell OptiPlex 7010', 1);
  retiredDesktop.status = 'retired';
  retiredDesktop.condition = 'Poor';
  retiredDesktop.notes = 'Retired: replaced by a newer desktop.';

  const lostPhone = nth('Apple iPhone SE (3rd gen)', 0);
  lostPhone.status = 'lost';
  lostPhone.condition = 'Poor';
  lostPhone.notes = 'Reported lost by last holder; not yet resolved.';

  Object.assign(nth('Microsoft 365 Business Standard', 0), {
    license_key: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', license_seats: 25, license_expires: '2027-01-01',
    purchase_date: '2024-01-01', purchase_cost: 4200, vendor: 'Microsoft',
  });
  Object.assign(nth('Adobe Creative Cloud All Apps', 0), {
    license_key: 'ADBE-XXXX-XXXX-XXXX', license_seats: 10, license_expires: '2027-03-01',
    purchase_date: '2024-03-01', purchase_cost: 3000, vendor: 'Adobe',
  });

  return {
    wellUsedLaptop: nth('Dell Latitude 5440', 0),
    assignedMacBookAir: nth('Apple MacBook Air M2', 0),
    assignedIphone: nth('Apple iPhone 13', 0),
    overdueLaptop: nth('Lenovo ThinkPad T14', 0),
    assignedIpad: nth('Apple iPad (9th gen)', 0),
    assignedHeadset: nth('Jabra Evolve2 65', 0),
    msLicense: nth('Microsoft 365 Business Standard', 0),
    availableOptiplex: nth('Dell OptiPlex 7010', 0),
    everydayMonitor: nth('Dell P2422H', 0),
    productionCamera: nth('Sony a6400 Camera Body', 0), // category 'Other': type is per-assignment, never per-category
  };
}

async function checkout(admin, asset, user, opts = {}) {
  return admin.post(`/api/assets/${asset.id}/checkout`, { employee_id: user.id, assignment_type: 'permanent', ...opts });
}
async function checkoutThenCheckin(admin, asset, user, checkinOpts = {}) {
  await checkout(admin, asset, user);
  return admin.post(`/api/assets/${asset.id}/checkin`, checkinOpts);
}

async function seedDatabase({ dataDir = DEV_DATA_DIR, quiet = false } = {}) {
  assertSafeDevDir(dataDir);
  const log = quiet ? () => {} : (...a) => console.log(...a);

  log(`Seeding development database at: ${dataDir}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const { app, db } = bootApp(dataDir);
  const server = await startServer(app);
  try {
    const admin = makeClient(server);
    const resetClient = makeClient(server);

    await admin.post('/api/setup', { name: ADMIN.name, email: ADMIN.email, password: DEV_PASSWORD });

    const createdUsers = [];
    for (const u of USERS) {
      createdUsers.push(await admin.post('/api/users', u));
    }
    for (const u of createdUsers) {
      const invite = await admin.post(`/api/users/${u.id}/invite`, {});
      const token = invite.link.split('/reset/')[1];
      await resetClient.post('/api/reset', { token, password: DEV_PASSWORD });
    }

    const jules = await admin.post('/api/users', NO_LOGIN_EMPLOYEE);

    const defs = buildAssetDefs();
    if (defs.length !== EXPECTED_ASSET_COUNT) throw new Error(`Asset def count drifted: ${defs.length} vs ${EXPECTED_ASSET_COUNT}`);
    const special = applySpecialCases(defs);

    const idByDef = new Map();
    for (const def of defs) {
      const created = await admin.post('/api/assets', def);
      idByDef.set(def, created);
    }
    const assetFor = (def) => idByDef.get(def);

    const [bailey, casey, dakota, emerson, finley, , harper, indigo] = createdUsers;
    const gray = createdUsers[5];

    // Self-checkout is per employee and defaults ON; Harper's is revoked so both behaviors are testable without touching Settings.
    await admin.put(`/api/users/${harper.id}/self-checkout`, { enabled: false });

    // Permanent everyday equipment (bailey: laptop + monitor + a software seat below) and temporary checkouts
    // (dakota's overdue laptop loan, indigo's laptop loan, emerson's production camera).
    await checkout(admin, assetFor(special.assignedMacBookAir), bailey);
    await checkout(admin, assetFor(special.everydayMonitor), bailey);
    await checkout(admin, assetFor(special.assignedIphone), casey);
    await checkout(admin, assetFor(special.overdueLaptop), dakota, { assignment_type: 'checkout', due_date: '2026-01-15' });
    await checkout(admin, assetFor(special.assignedIpad), gray);
    await checkout(admin, assetFor(special.assignedHeadset), harper);

    const msAsset = assetFor(special.msLicense);
    await checkout(admin, msAsset, bailey);
    await checkout(admin, msAsset, casey);
    await checkout(admin, msAsset, dakota);

    const wellUsed = assetFor(special.wellUsedLaptop);
    await checkoutThenCheckin(admin, wellUsed, emerson, { condition: 'Good' });
    await checkoutThenCheckin(admin, wellUsed, finley, { condition: 'Fair' });
    await checkout(admin, wellUsed, indigo, { assignment_type: 'checkout', due_date: '2027-01-01' });
    await checkout(admin, assetFor(special.productionCamera), emerson, { assignment_type: 'checkout', due_date: '2026-12-15', notes: 'Product shoot' });

    await checkout(admin, assetFor(defs.find((d) => d.category === 'Keyboard & Mouse')), jules);

    await checkoutThenCheckin(admin, assetFor(special.availableOptiplex), harper, { condition: 'Good' });

    await admin.post('/api/requests', { user_id: emerson.id, category: 'Monitor', message: 'Need a second monitor for my desk.' });
    const approvable = await admin.post('/api/requests', { user_id: finley.id, category: 'Headset', message: 'Starting a new remote role, need a headset.' });
    const spareHeadset = defs.filter((d) => d.name === 'Jabra Evolve2 65')[1];
    await admin.post(`/api/requests/${approvable.id}/approve`, { asset_id: assetFor(spareHeadset).id });
    const toDeny = await admin.post('/api/requests', { user_id: indigo.id, category: 'Other', message: 'Requesting a company drone.' });
    await admin.post(`/api/requests/${toDeny.id}/deny`, { note: 'Not a supported equipment category.' });

    const macBookAirId = assetFor(special.assignedMacBookAir).id;
    await admin.post(`/api/assets/${macBookAirId}/request-return`, { message: 'Please return by end of quarter — reassigning to a new hire.' });

    const ipadId = assetFor(special.assignedIpad).id;
    await admin.post(`/api/assets/${ipadId}/request-return`, { message: 'Please drop this off at the IT room.' });
    const openReturnReqs = await admin.get('/api/requests?type=return&status=open');
    const ipadReturnReq = openReturnReqs.find((r) => r.asset_id === ipadId);
    await admin.post(`/api/requests/${ipadReturnReq.id}/dropped-off`, {});
    await admin.post(`/api/assets/${ipadId}/checkin`, { condition: 'Good' });

    const nextTag = await admin.get('/api/next-tag');
    const firstAsset = db.prepare('SELECT tag FROM assets ORDER BY id LIMIT 1').get();

    const summary = {
      dataDir,
      people: db.prepare('SELECT COUNT(*) c FROM employees').get().c,
      accounts: db.prepare('SELECT COUNT(*) c FROM accounts').get().c,
      admins: db.prepare("SELECT COUNT(*) c FROM accounts WHERE role = 'admin'").get().c,
      employeesWithoutLogin: db.prepare('SELECT COUNT(*) c FROM employees e WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.employee_id = e.id)').get().c,
      assets: db.prepare('SELECT COUNT(*) c FROM assets').get().c,
      currentAssignments: db.prepare('SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL').get().c,
      historicalAssignments: db.prepare('SELECT COUNT(*) c FROM assignments WHERE returned_at IS NOT NULL').get().c,
      selfCheckoutEnabled: db.prepare('SELECT COUNT(*) c FROM employees e JOIN accounts a ON a.employee_id = e.id WHERE e.can_self_checkout = 1').get().c,
      selfCheckoutDisabled: db.prepare('SELECT COUNT(*) c FROM employees e JOIN accounts a ON a.employee_id = e.id WHERE e.can_self_checkout = 0').get().c,
      permanentAssignments: db.prepare("SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL AND assignment_type = 'permanent'").get().c,
      temporaryCheckouts: db.prepare("SELECT COUNT(*) c FROM assignments WHERE returned_at IS NULL AND assignment_type = 'checkout'").get().c,
      requests: db.prepare('SELECT COUNT(*) c FROM requests').get().c,
      firstAssetTag: firstAsset && firstAsset.tag,
      nextTag: nextTag.tag,
      adminEmail: ADMIN.email,
      devPassword: DEV_PASSWORD,
    };
    return summary;
  } finally {
    await stopServer(server);
    db.close();
  }
}

if (require.main === module) {
  seedDatabase({ dataDir: DEV_DATA_DIR })
    .then((s) => {
      console.log('');
      console.log('Seed complete.');
      console.log(`  Data dir:               ${s.dataDir}`);
      console.log(`  People:                 ${s.people} (${s.accounts} with a login, ${s.admins} admin, ${s.employeesWithoutLogin} without a login)`);
      console.log(`  Assets:                 ${s.assets} (tags ${s.firstAssetTag} .. next unused ${s.nextTag})`);
      console.log(`  Current assignments:    ${s.currentAssignments}`);
      console.log(`  Historical assignments: ${s.historicalAssignments}`);
      console.log(`  Permanent / temporary:  ${s.permanentAssignments} / ${s.temporaryCheckouts}`);
      console.log(`  Self-checkout on/off:   ${s.selfCheckoutEnabled} / ${s.selfCheckoutDisabled} (logins; Harper Hughes is off)`);
      console.log(`  Requests:               ${s.requests}`);
      console.log('');
      console.log(`  Admin login:  ${s.adminEmail} / ${s.devPassword}`);
      console.log(`  All seeded accounts share that password.`);
      console.log('');
      console.log(`  Start against this data with:  DATA_DIR=${s.dataDir} PORT=3000 npm start`);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exitCode = 1;
    });
}

module.exports = {
  seedDatabase, assertSafeDevDir, buildAssetDefs, applySpecialCases,
  bootApp, startServer, stopServer, makeClient,
  REAL_DATA_DIR, DEV_DATA_DIR, DEV_PASSWORD, DEV_APP_URL, EXPECTED_ASSET_COUNT,
};
