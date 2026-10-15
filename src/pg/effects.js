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
//                                   Slice 4C: waitlist_joined may carry `updated: true` (updateDates: the waiter changed their
//                                   dates and now overlaps this reserver), and
//                                     hold_email       { entry }   one "available for you" email owed for this hold (the entry row
//                                                      as claimed). Never registered: waitlist.dispatchHoldEmails claims the
//                                                      hold (hold_email_at) OUTSIDE any transaction and hands it over with emit().
//   setNotifier(fn | null)          fn(effect) may be sync or async; it resolves recipients / the asset itself (through its own
//                                   pool). Default and null: a no-op.
//   hasNotifier()                   (Slice 4C) true when a notifier is installed (dispatchHoldEmails claims nothing without one).
//   emit(effect[, onError])         (Slice 4C) delivers ONE effect to the notifier now, outside any transaction (the caller has
//                                   already committed what it describes). Never throws or rejects: a failing notifier is
//                                   reported to onError(err) if given, else logged ('[effects]'). Returns a promise of true
//                                   (delivered) / false; tracked by whenIdle().
//   deferUntil(client, promise)     (Slice 4C) inside a transaction: if it commits, its effects are dispatched only once `promise`
//                                   has settled (resolved or rejected), instead of right after COMMIT. The waitlist request
//                                   paths use it for their separately committed due step, so the hold emails it triggers go
//                                   out after the request's main transaction has ended (as SQLite dispatched at the end of the
//                                   request): a hold the request itself then confirms or leaves is never emailed. Nothing is
//                                   delayed beyond that, and a rolled-back transaction still fires nothing.
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
const gates = new WeakMap(); // client -> promise its current transaction's effects wait for (deferUntil)
const inFlight = new Set();

function setNotifier(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('setNotifier(fn): fn must be a function or null');
  notifier = fn || noop;
}

function dispatch(list, fn, gate = null) {
  const run = (async () => {
    if (gate) await gate.then(noop, noop);
    await new Promise((resolve) => setImmediate(resolve));
    for (const effect of list) {
      try {
        await fn(effect);
      } catch (err) {
        console.error('[effects]', effect.type, err && err.message ? err.message : err);
      }
    }
  })();
  track(run);
}
function track(run) {
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
      const gate = gates.get(client) || null;
      pending.delete(client);
      gates.delete(client);
      if (committed && effects && effects.length) dispatch(effects, notifier, gate);
    });
  }
  if (effect.type === 'holds_owed' && list.some((e) => e.type === 'holds_owed' && e.assetId === effect.assetId)) return;
  list.push(effect);
}

function deferUntil(client, promise) {
  if (!client || !isInTransaction(client)) {
    throw new Error('deferUntil() must be called inside withTransaction(), with that transaction\'s client.');
  }
  if (!promise || typeof promise.then !== 'function') throw new TypeError('deferUntil(client, promise): promise must be a promise');
  gates.set(client, promise);
  onTransactionEnd(client, clearGate(client));
}
// (one callback per client, so registering twice runs it once; it drops the gate of a transaction that registered no effect)
const clearers = new WeakMap();
function clearGate(client) {
  if (!clearers.has(client)) clearers.set(client, () => { if (!pending.has(client)) gates.delete(client); });
  return clearers.get(client);
}

const hasNotifier = () => notifier !== noop;

function emit(effect, onError) {
  const fn = notifier;
  const run = (async () => {
    try {
      if (!effect || typeof effect.type !== 'string') throw new TypeError('emit(): an effect is a plain object with a string `type`');
      await fn(effect);
      return true;
    } catch (err) {
      if (onError) { try { onError(err); } catch { /* never surfaces */ } } else console.error('[effects]', effect && effect.type, err && err.message ? err.message : err);
      return false;
    }
  })();
  track(run);
  return run;
}

async function whenIdle() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

module.exports = { registerEffect, setNotifier, hasNotifier, emit, deferUntil, whenIdle };
