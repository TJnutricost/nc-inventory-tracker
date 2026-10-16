// Seam parity (D-48, PostgreSQL migration Slice 5C-1): every module the temporary driver seam binds on SQLite (MODULES in
// src/dataSeam/sqlite.js) must have a PostgreSQL twin src/pg/<module>.js with the SAME names, so Slice 5D's src/dataSeam/pg.js can bind
// the pool to them unchanged. For each module and each database-first function listed there: the twin exports a function of that name,
// async (an AsyncFunction; the few pre-existing non-async twins are listed in NOT_ASYNC and checked to return a promise); and every
// pure export of the SQLite module exists on the twin too. Needs no database, so it runs under plain `npm test`.
//
// MISSING is the explicit list of names that have NO twin yet. The test fails both ways: a name not in MISSING without a twin, and a
// name in MISSING that now HAS one (remove it from the list when its twin lands, so the list only ever shrinks). THE LIST MUST BE EMPTY
// BY THE END OF SLICE 5C. Owners (the approved 5C split, docs/briefs/postgresql-slice-5-overview.md):
//   5C-4 request records ..... requestRecords (ag, ah)
//   5C-5 asset records ....... assetRecords (incl. the 5B-4 peekTag / importAssets), assetCustody (v, w, x, ai)
// (5C-1 added activityLog (incl. the 5B-4 `recent`), outbox, overdue, photoRecords, assetAccess, reservationViews, requestAccess,
// catalogViews, catalogAdmin; settings already had its twin, src/pg/settings.js, since Slice 3. 5C-2 added assetViews (incl. the 5B-4
// `exportRows`), dashboard, and the people reads: getPerson, listPeople, personAssignments, employeeStatus and the four email-in-use
// checks. 5C-3 added accounts, sessions and the people writes: createPerson, addAccount, updatePerson, setSelfCheckout,
// updateOwnProfile.)
//
// KNOWN_DIFFERENCES are deliberate, pre-existing (Slices 4B/4C) gaps that are NOT twins and never will be; 5D's binding must not bind
// them: no route calls them through the seam (the SQLite modules call them internally).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { MODULES } = require('../../src/dataSeam/sqlite');

const MISSING = {
  requestRecords: { slice: '5C-4', names: ['listRequests', 'createEquipmentRequest', 'approveRequest'] },
  assetRecords: { slice: '5C-5', names: ['tagExists', 'allocateTag', 'assertSerialFree', 'resolveAssetNode', 'createAsset', 'updateAsset', 'archiveAsset', 'peekTag', 'importAssets'] },
  assetCustody: { slice: '5C-5', names: ['checkin', 'requestReturnFrom', 'requestMyReturn', 'reportIssue', 'returnNotice'] },
};

const KNOWN_DIFFERENCES = {
  'reservations.sendRecorded': 'absent on PostgreSQL: reservations.create registers a `request_recorded` effect after COMMIT instead of emailing (D-47, Slice 4B)',
  'waitlist.announceJoined': 'synchronous on PostgreSQL: it only registers `waitlist_joined` effects on the transaction client, no query (D-47, Slice 4B)',
};
// Pre-existing twins that are plain functions returning the executor's promise (not `async`); each is called with a stub executor.
const NOT_ASYNC = { 'reservations.note': (fn, q) => fn(q, 1, 1, 'x', 'y', null), 'reservations.todayOf': (fn, q) => fn(q) };

const twinFile = (name) => path.join(ROOT, 'src', 'pg', `${name}.js`);
const missingSet = new Set(Object.entries(MISSING).flatMap(([m, { names }]) => names.map((n) => `${m}.${n}`)));
const stubExecutor = () => ({ query: async () => ({ rows: [{ v: '2026-01-01' }], rowCount: 1 }) });

test('MISSING and KNOWN_DIFFERENCES name only real seam functions', () => {
  for (const key of [...missingSet, ...Object.keys(KNOWN_DIFFERENCES)]) {
    const [m, fn] = key.split('.');
    assert.ok(MODULES[m], `${key}: no module "${m}" in src/dataSeam/sqlite.js MODULES`);
    assert.ok(MODULES[m][1].includes(fn), `${key}: "${fn}" is not a database function of ${m} in MODULES (stale entry)`);
  }
  for (const [m, { names }] of Object.entries(MISSING)) assert.equal(new Set(names).size, names.length, `MISSING.${m} lists a name twice`);
});

test('every seam database function has an async PostgreSQL twin of the same name, or is listed in MISSING', async () => {
  const problems = [];
  for (const [name, [, dbFunctions]] of Object.entries(MODULES)) {
    const exists = fs.existsSync(twinFile(name));
    const pg = exists ? require(twinFile(name)) : {};
    for (const fn of dbFunctions) {
      const key = `${name}.${fn}`;
      if (KNOWN_DIFFERENCES[key]) continue;
      const has = typeof pg[fn] === 'function';
      if (missingSet.has(key)) {
        if (has) problems.push(`${key} now has a PostgreSQL twin: remove it from MISSING`);
        continue;
      }
      if (!exists) { problems.push(`${key}: src/pg/${name}.js does not exist`); continue; }
      if (!has) { problems.push(`${key}: src/pg/${name}.js does not export a function "${fn}"`); continue; }
      if (pg[fn].constructor.name === 'AsyncFunction') continue;
      if (!NOT_ASYNC[key]) { problems.push(`${key}: the twin is not async (make it an async function)`); continue; }
      const out = NOT_ASYNC[key](pg[fn], stubExecutor());
      if (!(out instanceof Promise)) problems.push(`${key}: the twin does not return a promise`);
      else await out;
    }
  }
  assert.deepEqual(problems, []);
});

test('every pure export of a twinned SQLite module exists on its PostgreSQL twin', () => {
  const problems = [];
  for (const [name, [mod, dbFunctions]] of Object.entries(MODULES)) {
    if (!fs.existsSync(twinFile(name))) continue; // (a whole module still in MISSING: checked once its twin lands)
    const pg = require(twinFile(name));
    for (const key of Object.keys(mod).filter((k) => !dbFunctions.includes(k))) {
      if (!(key in pg)) problems.push(`${name}.${key} (pure export) is missing from src/pg/${name}.js`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a module with no twin file is listed in MISSING in full (no partly-listed missing file)', () => {
  for (const [name, [, dbFunctions]] of Object.entries(MODULES)) {
    if (fs.existsSync(twinFile(name))) continue;
    assert.deepEqual([...(MISSING[name]?.names || [])].sort(), [...dbFunctions].sort(), `src/pg/${name}.js is missing: MISSING.${name} must list all its functions`);
  }
});
