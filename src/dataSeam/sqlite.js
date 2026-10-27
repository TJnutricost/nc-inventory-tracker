// TEMPORARY (D-48): the SQLite side of the database driver seam (see ./index.js). Removed at the PostgreSQL cutover.
//
// Binds the better-sqlite3 handle into the data modules so a route writes `await data.waitlist.join({...})` instead of
// `waitlistRules.join(db, {...})`. Each bound function is an async wrapper that calls the existing SYNCHRONOUS module function and
// runs it to completion with no await inside: the transaction, its atomicity and its errors are exactly what they are without the seam
// (a throw becomes a rejection carrying the SAME error object: status, code and message unchanged). Pure exports (constants,
// validators, TRANSITIONS, ...) pass through untouched and stay synchronous.
//
// The function is looked up on the module at CALL time, the way `waitlistRules.join(db, ...)` always was, so nothing about which code
// runs changes. Slice 5D binds the PostgreSQL pool to the same names (src/pg/<module>.js has the same exports and parallel signatures).
//
// Interleaving: a wrapper settles without waiting for any I/O, so `await` on it resumes as a microtask. A route that chains several
// seam calls (write, then read the row back) therefore still runs in ONE event-loop turn on SQLite: no other request, timer or sweep
// can run between those calls, exactly as when the route was synchronous (test/data-seam.test.js checks it). On PostgreSQL (5D) each
// await really yields; the read-backs after a write are then separate statements, which 5C/5D must take into account.
const MODULES = {
  // module name -> [the module, the exports whose first argument is the database handle]
  availability: [require('../availability'), ['todayStates', 'availability', 'resolveScope']],
  reservations: [require('../reservations'), ['findBlockers', 'plan', 'insertReservation', 'hasOwnOverlap', 'hasOwnHold', 'note', 'loadAsset', 'emailOf', 'sendRecorded', 'create', 'approve', 'decline', 'cancel', 'shorten', 'todayOf']],
  waitlist: [require('../waitlist'), ['classify', 'insertEntry', 'announceJoined', 'evaluateAsset', 'processDue', 'dispatchHoldEmails', 'sweep', 'rangeCheck', 'counts', 'list', 'get', 'join', 'updateDates', 'confirmHold', 'declineHold', 'leave']],
  catalog: [require('../catalog'), ['searchText', 'searchNodeIds', 'loadIndex', 'pathNames', 'pathText', 'rootOf', 'isLive', 'subtreeIds', 'depthOf', 'getNode', 'createNode', 'updateNode', 'archiveNode', 'restoreNode', 'usage', 'deleteNode', 'findLiveByPath']],
  requests: [require('../requests'), ['transition', 'openRequest', 'lifecycle', 'withLifecycle', 'completeEquipmentRequests', 'completeReturnRequests']],
  assignments: [require('../assignments'), ['refreshStatus', 'createAssignment']],
  // extracted verbatim from server.js in Slice 5B-1 for the routes migrated to the seam
  // (assetAccess and reservationViews gained functions in 5B-2: visibleAsset/heldAsset/holdsAsset, listReservations)
  assetAccess: [require('../assetAccess'), ['getAsset', 'canViewAsset', 'reservableAsset', 'visibleAsset', 'heldAsset', 'holdsAsset']],
  reservationViews: [require('../reservationViews'), ['reservationOut', 'reservationById', 'listReservations']],
  catalogAdmin: [require('../catalogAdmin'), ['syncAssetCategories', 'catalogOut', 'createNode', 'updateNode']],
  // extracted verbatim from server.js in Slice 5B-2 (assets, photos, dashboard, scan, and the 5B-1 deferred reads)
  activityLog: [require('../activityLog'), ['log', 'recent']], // (recent: 5B-4)
  people: [require('../people'), ['getPerson', // (5B-3 below, then employeeStatus 5B-4)
    'listPeople', 'workEmailTaken', 'workEmailTakenByOther', 'loginEmailTaken', 'loginEmailTakenByOther', 'createPerson', 'addAccount',
    'personAssignments', 'updatePerson', 'setSelfCheckout', 'updateOwnProfile', 'employeeStatus']],
  assetViews: [require('../assetViews'), ['openAssignments', 'withCatalog', 'sanitizeAsset', 'listAssets', 'lookupCode', 'assetDetail', 'exportRows']], // (exportRows: 5B-4)
  assetRecords: [require('../assetRecords'), ['tagExists', 'allocateTag', 'assertSerialFree', 'resolveAssetNode', 'createAsset', 'updateAsset', 'archiveAsset',
    'peekTag', 'importAssets']], // (peekTag, importAssets: 5B-4)
  assetCustody: [require('../assetCustody'), ['checkin', 'requestReturnFrom', 'requestMyReturn', 'reportIssue', 'returnNotice']],
  photoRecords: [require('../photoRecords'), ['addPhoto', 'touchAsset', 'getPhoto', 'deletePhoto', 'photoAsset', 'setCover', 'photoByFile']],
  dashboard: [require('../dashboard'), ['dashboard']],
  catalogViews: [require('../catalogViews'), ['searchCatalog', 'catalogTree']],
  requestAccess: [require('../requestAccess'), ['loadRequest', 'isSelfInitiated', 'cancelBlock']],
  // extracted verbatim from server.js in Slice 5B-3 (people, authentication, sessions; people.js gained the /api/users functions)
  accounts: [require('../accounts'), ['currentUser', 'accountCount', 'createFirstAdmin', 'loginAccount', 'googleAccount', 'provisionGoogleAccount', 'makeAdmin', 'recordLogin', 'setPassword', 'resetAccount', 'replaceToken', 'getToken', 'completeReset']],
  sessions: [require('../sessions'), ['get', 'set', 'touch', 'destroy', 'purgeExpired', 'destroyForAccount']],
  // Slice 5B-4: settings (the SQL of src/db.js getSettings / setSetting, copied verbatim: src/db.js is unchanged), the outbox and the
  // overdue sweep, the request list / create / approve (extracted verbatim from server.js; additions to activityLog, people, assetViews,
  // assetRecords above). Since 5B-4 server.js reaches the database only through this seam.
  settings: [require('../settings'), ['getSettings', 'setSetting']],
  outbox: [require('../outbox'), ['latest', 'recent']],
  overdue: [require('../overdue'), ['dueAssignments', 'markNotified']],
  requestRecords: [require('../requestRecords'), ['listRequests', 'createEquipmentRequest', 'approveRequest', 'transitionLogged']],
};

function bindModule(db, name, mod, dbFunctions) {
  const out = {};
  for (const key of Object.keys(mod)) {
    if (dbFunctions.includes(key)) continue;
    // pure export: read through to the module (a getter, so it is always the module's current value)
    Object.defineProperty(out, key, { enumerable: true, get: () => mod[key] });
  }
  for (const fn of dbFunctions) {
    if (typeof mod[fn] !== 'function') throw new Error(`data seam: ${name}.${fn} is not a function of src/${name}.js`);
    // async + no await: the synchronous module function runs to completion inside this call
    Object.defineProperty(out, fn, { enumerable: true, value: async (...args) => mod[fn](db, ...args) });
  }
  return Object.freeze(out);
}

function bind(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('data seam: the SQLite driver needs the better-sqlite3 database handle (src/db.js `db`)');
  }
  const data = { driver: 'sqlite' };
  for (const [name, [mod, dbFunctions]] of Object.entries(MODULES)) data[name] = bindModule(db, name, mod, dbFunctions);
  return Object.freeze(data);
}

module.exports = { bind, MODULES };
