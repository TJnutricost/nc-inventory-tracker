// After-commit effects (D-47, migration Slice 4B). The PostgreSQL write paths never send email themselves: they register
// plain-data effects on their transaction client, and the effects are handed to an injected notifier only AFTER that
// transaction has COMMITTED (dropped if it rolls back). This module imports no mailer and nothing from SQLite.
//
//   registerEffect(client, effect)  effect = { type, ... } (plain data: ids and row-shaped ranges, never a pool or a client).
//                                   Must be called inside withTransaction(), on that transaction's client, AFTER the writes it
//                                   describes have succeeded. Types (Slice 4B):
//                                     request_recorded { employeeId, assetId, requested, reserved, waitlisted }
//                                     waitlist_joined  { waiterEmployeeId, assetId, entry, reserver }   (one per distinct reserver)
//                                     holds_owed       { assetId }  a TRIGGER for the claim-based hold-email dispatch (Slice 4C);
//                                                      at most one per asset per transaction. A spurious or repeated one is
//                                                      harmless (nothing owed = nothing sent); a dropped one only delays the
//                                                      email to the next sweep.
//   setNotifier(fn | null)          fn(effect) may be sync or async; it resolves recipients / the asset itself (through its own
//                                   pool). Default and null: a no-op.
//   whenIdle()                      resolves once no dispatch is in flight (tests).
//
// Rules: one transaction's effects are dispatched in registration order, one after another; different transactions dispatch
// independently. Dispatch starts on a later turn of the event loop (setImmediate), after COMMIT and after the client went
// back to the pool, so the asset lock is long released and no caller ever waits for it. A throwing or rejecting notifier is
// logged ('[effects]') and never surfaces: an email problem can never undo or block committed state. A transaction joined
// by several write functions (an outer withTransaction) is one transaction: its effects fire once, at its COMMIT.
const { isInTransaction, onTransactionEnd } = require('./transaction');

const noop = () => {};
let notifier = noop;
const pending = new WeakMap(); // client -> effects registered in its current transaction
const inFlight = new Set();

function setNotifier(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('setNotifier(fn): fn must be a function or null');
  notifier = fn || noop;
}

function dispatch(list, fn) {
  const run = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (const effect of list) {
      try {
        await fn(effect);
      } catch (err) {
        console.error('[effects]', effect.type, err && err.message ? err.message : err);
      }
    }
  })();
  inFlight.add(run);
  run.finally(() => inFlight.delete(run));
}

function registerEffect(client, effect) {
  if (!client || !isInTransaction(client)) {
    throw new Error('registerEffect() must be called inside withTransaction(), with that transaction\'s client.');
  }
  if (!effect || typeof effect.type !== 'string') throw new TypeError('registerEffect(): an effect is a plain object with a string `type`');
  let list = pending.get(client);
  if (!list) {
    list = [];
    pending.set(client, list);
    // one flush per transaction; it runs once the transaction has ended (see onTransactionEnd)
    onTransactionEnd(client, ({ committed }) => {
      const effects = pending.get(client);
      pending.delete(client);
      if (committed && effects && effects.length) dispatch(effects, notifier);
    });
  }
  if (effect.type === 'holds_owed' && list.some((e) => e.type === 'holds_owed' && e.assetId === effect.assetId)) return;
  list.push(effect);
}

async function whenIdle() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

module.exports = { registerEffect, setNotifier, whenIdle };
