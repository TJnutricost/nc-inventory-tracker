# PostgreSQL migration — Slice 4 overview (4A / 4B / 4C)

**Decision:** D-46, D-47. **Status:** APPROVED (owner, 2026-10-14).

Availability + reservations + waitlist is ~970 lines of SQLite code with the hardest concurrency, so Slice 4 is delivered as three independently testable PRs, each from the latest `integration/postgresql`, each targeting `integration/postgresql`:

| Slice | Scope | Risk | Route |
|---|---|---|---|
| **4A** | `src/pg/availability.js`; READ side of reservations and waitlist (`findBlockers`, `plan`, `hasOwnOverlap`, `hasOwnHold`, `classify`, `rangeCheck`, `list`, `get`, `present`, `counts`); time-offset helper; differential tests | Low: no locks, no email, no writes | opus/medium |
| 4B | Reservation writes (`create`, `approve`, `decline`, `cancel`, `shorten`, `insertReservation`, `note`), the queue engine (`evaluateAsset`, `insertPiece`, `close`), `insertEntry`/`announceJoined`, the after-commit effects mechanism with an injected notifier, concurrency + lock-order tests | High | opus/high |
| 4C | Waitlist actions (`join`, `updateDates`, `confirmHold`, `declineHold`, `leave`), `processDue`/`sweep` as per-asset transactions, hold-email dispatch, email-safety tests, remaining concurrency tests | Medium | planned after 4B |

## 4B (opus/high): reservation writes + queue engine + effects
Every write path: take the asset id from a single unlocked lookup if needed (reservation/entry id → `asset_id`), then **`lockAsset` before any protected state decision or write, and re-read all relevant state under the lock**; one asset per transaction. `queue_seq` is computed per asset under the lock (no schema change). `create`/`approve`/`decline`/`cancel`/`shorten`/`insertReservation`/`note`; `evaluateAsset` (+ `insertPiece`, `close`); `insertEntry`/`announceJoined`. Effects: plain-data effects registered through `onTransactionEnd(client, …)`, fired only when `committed`, dispatched via an injected notifier (`setNotifier`), resolving recipient/asset through the pool after commit; never throws; no mailer import.

Tests: lock-order guard (a `client.query` spy shows the asset `FOR UPDATE` precedes protected reads/writes of every write path; the initial id→asset lookup is allowed); reserve vs reserve (one reserves, one waitlisted/split); reserve vs `createAssignment`; overlapping approvals; approve vs cancel (compare-and-set loser gets "just updated"); cancel/shorten promoting seeded waiters in FIFO order with correct re-split; rollback leaves no rows/activity/effects; no email on a failed transaction; slow notifier does not delay a second transaction on the same asset; pool returns to baseline. Operations that need 4C code (join, confirmHold, sweep) are tested in 4C, not forced into 4B.

## 4C: waitlist actions + sweep + hold email
Waitlist actions + `processDue` (own committed transaction, requested asset only on request paths; global `sweep` = one transaction per asset, ascending id) + global claim-based `dispatchHoldEmails` incl. the existing run-even-when-the-mutator-throws (`settling`) behavior.

Tests: join/`queue_seq` contention, `confirmHold` vs expiry, double confirm, cancel vs join, sweep vs request, sweep continues past one failing asset, at-most-once hold email (claim, no duplicate), failure to send never reverses state, no SMTP under lock. Reports any behavior difference rather than adjusting code to satisfy tests.

## Notes from 4A that 4B/4C must keep
- SQLite returns `queue_seq` ties (split pieces) in `idx_waitlist_queue` order: status text ('held' before 'waiting'), then rowid. The 4A read queries order `queue_seq, status, id` to match. `evaluateAsset` already orders `queue_seq, id` explicitly in SQLite; keep that literal order there.
- `findBlockers`, `plan`, `hasOwnOverlap`, `hasOwnHold` and `classify` take `q`: inside a 4B/4C write, pass the transaction client after `lockAsset`.
- Hold expiries are written with `NOW_PLUS('$n')` from `src/pg/time.js` (SQLite `datetime('now', '+N seconds')`).
