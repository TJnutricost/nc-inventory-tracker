// Transaction + per-asset lock helpers (D-46, migration Slice 2). The PostgreSQL replacement for better-sqlite3's
// db.transaction() and for the BEGIN IMMEDIATE transactions that guard reservations, waitlist and assignments today.
//
// withTransaction(fn[, pool])
//   Checks out ONE client, runs BEGIN, awaits fn(client), then COMMIT; if fn throws (or COMMIT fails) it runs ROLLBACK
//   and rethrows the original error. The client is always released (a client whose ROLLBACK failed is destroyed, not
//   returned to the pool). Same contract as db.transaction(): all-or-nothing, an exception rolls back, the exception
//   propagates, fn's return value is returned. Every statement inside MUST use the `client` passed to fn: a query on
//   the pool would run on another connection, outside the transaction.
//   Nesting is REJECTED with an error (no savepoint emulation): a withTransaction() started anywhere inside fn's async
//   call chain would commit on its own connection, independently of the outer transaction, and could deadlock against
//   it or exhaust the pool. Slice 3+ conversions call shared helpers with the outer `client` instead.
//
// lockAsset(client, assetId)
//   SELECT * FROM assets WHERE id = $1 FOR UPDATE — must run inside withTransaction (on its client). Returns the asset
//   row; throws a 404 error (code ASSET_NOT_FOUND) if there is none. The row lock is held until COMMIT/ROLLBACK, so a
//   second transaction locking the same asset waits until the first ends, while other assets are unaffected.
//
//   LOCK-ORDERING RULE (keeps per-asset locking deadlock-free):
//     1. Lock the asset row FIRST, before reading or writing any row that depends on it (reservations, waitlist
//        entries, assignments, requests for that asset). Decisions read after the lock are then stable.
//     2. Lock ONE asset per transaction. A transaction that genuinely needs several assets must lock them in
//        ascending id order (and that code must document it); never lock a second asset after touching dependent rows.
//     3. Rows that are not under an asset (employees, accounts, settings, the tag counter) are not covered by this rule;
//        a transaction that needs them AND an asset takes the asset lock first.
//
// onTransactionEnd(client, fn)   (Slice 3)
//   Registers fn({ committed }) to run once the transaction on `client` has ended (after COMMIT or ROLLBACK, before the
//   client is released). Used by caches that must not trust state a transaction wrote until it is committed (or know it
//   never will be): src/pg/catalog.js invalidates its tree cache here. Registering the same fn twice runs it once; an
//   error thrown by fn is ignored (it must never turn a committed transaction into a failure).
//
// holdsAssetLock(client, assetId) / assertAssetLock(client, assetId)   (Slice 4B)
//   lockAsset() records, per client, the asset ids whose row lock it actually obtained (only after the FOR UPDATE
//   returned the row). holdsAssetLock() is true only inside that client's transaction and only for those ids. The record
//   is reset at BEGIN and cleared when the transaction ends (COMMIT, ROLLBACK, a failed ROLLBACK, any throw), before the
//   end callbacks run and before the client is released, so a pooled client reused by the next transaction never carries
//   a lock record across. assertAssetLock() throws a plain Error with code ASSET_LOCK_REQUIRED (never an HTTP-status
//   error) when the lock is missing: the programming-error net for the reservation/waitlist write helpers.
const { AsyncLocalStorage } = require('node:async_hooks');
const { getPool } = require('./pool');

const activeTransaction = new AsyncLocalStorage();
const clientsInTransaction = new WeakSet();
const endCallbacks = new WeakMap();
const assetLocks = new WeakMap(); // client -> Set of asset ids locked in its current transaction

async function withTransaction(fn, pool = getPool()) {
  if (typeof fn !== 'function') throw new TypeError('withTransaction(fn): fn must be a function');
  const outer = activeTransaction.getStore();
  if (outer && outer.open) {
    throw new Error('withTransaction() cannot be nested: pass the outer transaction\'s client to the inner code instead of starting a new transaction.');
  }
  const client = await pool.connect();
  // `open` is cleared when this transaction ends, so work fn merely scheduled (a timer, a deferred email) that starts
  // its own transaction later is not mistaken for nesting just because it inherited this async context.
  const scope = { open: true };
  let destroy = null;
  let committed = false;
  try {
    assetLocks.delete(client);
    await client.query('BEGIN');
    clientsInTransaction.add(client);
    const result = await activeTransaction.run(scope, () => fn(client));
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      destroy = rollbackErr; // the connection is in an unknown state: drop it instead of reusing it
    }
    throw err;
  } finally {
    scope.open = false;
    clientsInTransaction.delete(client);
    assetLocks.delete(client);
    const callbacks = endCallbacks.get(client) || [];
    endCallbacks.delete(client);
    for (const cb of callbacks) {
      try { cb({ committed }); } catch { /* see onTransactionEnd */ }
    }
    client.release(destroy || undefined);
  }
}

function isInTransaction(client) {
  return clientsInTransaction.has(client);
}

function onTransactionEnd(client, fn) {
  if (!client || !isInTransaction(client)) {
    throw new Error('onTransactionEnd() must be called inside withTransaction(), with that transaction\'s client.');
  }
  let list = endCallbacks.get(client);
  if (!list) endCallbacks.set(client, (list = []));
  if (!list.includes(fn)) list.push(fn);
}

async function lockAsset(client, assetId) {
  if (!client || !isInTransaction(client)) {
    throw new Error('lockAsset() must be called inside withTransaction(), with that transaction\'s client.');
  }
  const id = Number(assetId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`lockAsset(): invalid asset id ${assetId}`);
  const { rows } = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw Object.assign(new Error('Asset not found'), { status: 404, code: 'ASSET_NOT_FOUND' });
  let held = assetLocks.get(client);
  if (!held) assetLocks.set(client, (held = new Set()));
  held.add(id);
  return rows[0];
}

function holdsAssetLock(client, assetId) {
  if (!client || !isInTransaction(client)) return false;
  const held = assetLocks.get(client);
  return !!held && held.has(Number(assetId));
}

function assertAssetLock(client, assetId) {
  if (!holdsAssetLock(client, assetId)) {
    throw Object.assign(new Error(`This write needs the asset lock: call lockAsset(client, ${assetId}) inside withTransaction() first, and pass that client.`), { code: 'ASSET_LOCK_REQUIRED' });
  }
}

module.exports = { withTransaction, lockAsset, isInTransaction, onTransactionEnd, holdsAssetLock, assertAssetLock };
