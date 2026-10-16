## Slice brief: PostgreSQL migration Slice 5C-5 (PG twins of assetRecords + assetCustody)
Route: model=opus effort=high
Base: origin/integration/postgresql (git fetch first; expected head 5b6212d = PR #46 / 5C-4 merged). Branch feature/pg-slice-5c-5-asset-records-custody via `git switch -c ... origin/integration/postgresql`, or preferably a separate worktree in the scratchpad with node_modules symlinked (as 5C-3/5C-4 did) so the main checkout, its untracked files (graphify-out/, .DS_Store) and any stash are left alone. PR into integration/postgresql ONLY. NEVER merge. No stage/main, no Railway, no git --pager. Status: APPROVED by owner 2026-10-16.

Read first: docs/briefs/postgresql-slice-5c-4*.md, 5c-3, 5c-2, 5c-1 (the pattern to repeat exactly: header comments, `q` executor first, `isInTransaction(q) ? run(q) : withTransaction(run, q)`, differential-test style, seam parity test), the "Slice 5C plan" in docs/briefs/postgresql-slice-5-overview.md, PROJECT_STATUS.md carry-overs (v), (w), (x), (ai) (and (ah), (aa), (ap) for context), and the existing twins src/pg/transaction.js (withTransaction, lockAsset), assignments.js (createAssignment), assetAccess.js, availability.js, activityLog.js, mailer.js/outbox.js/effects.js (email-after-commit), catalogAdmin.js (tag/category helpers).

Goal: `src/pg/assetRecords.js` and `src/pg/assetCustody.js`, PG twins of src/assetRecords.js (asset create, update, archive, `peekTag`, tag generation/uniqueness, `importAssets` and the CSV import) and src/assetCustody.js (checkout, check-in, returns, custody and issue-related operations; whatever it exports). Same exported names, parallel signatures (executor `q` first where SQLite takes `db`), same return shapes, same error statuses/messages. SQLite stays the active runtime; NOTHING is wired into server.js, src/dataSeam/** or the SQLite modules; PG code is not loaded by the running app. No user-facing behavior change. No PG runtime cutover.

Requirements:
- Preserve SQLite behavior and product rules exactly; measure SQLite where unclear and match it (or report).
- ONE transaction each, joining a caller's client when given one, else `withTransaction`: asset create (tag counter claim + insert + activity), asset update (serial check + update), archive (open-assignment check + update + activity), check-in (everything up to the availability re-evaluation), checkout/return operations, the whole CSV import.
- Asset-level locking preserved: every custody write does `lockAsset` first, then the rest (assignment rows, request rows). State the lock order and why it cannot deadlock against 5A/4B/4C/5C-4 paths. 5A lock timeout -> 503 ASSET_BUSY propagates unchanged and rolls everything back.
- (w) check-in: the pre-reads (`getAsset`, `openAssignments`, the target assignment) happen INSIDE the asset-locked transaction, after `lockAsset`.
- (x) check-then-insert races (IT's per-holder return request `requestReturnFrom`, employee request-return / report-issue / return-notice duplicate checks, PUT's serial check, archive's open-assignment check): run inside the write transaction under the asset lock, or rely on a constraint; no duplicate request/assignment/custody row can result from concurrent calls.
- (ai) CSV import: the active-employee read and the full file are ONE transaction; any row failure (or lock/timeout/constraint error) rolls back the WHOLE import, leaving zero rows, zero tag-counter movement, zero activity. Same per-row validation messages, same row-numbering, same result shape as SQLite. Tag generation under concurrency: two simultaneous creates/imports never get the same tag; uniqueness enforced by counter claim + unique constraint, not a pre-check. Port `peekTag` as a plain read.
- Duplicate assignment / custody races prevented: two concurrent checkouts of the same single-seat asset -> exactly one succeeds, the other gets SQLite's refusal.
- Email-after-commit preserved: any notification/outbox effect is queued/sent only after COMMIT (use the existing effects/outbox twin mechanism); a rolled-back transaction sends nothing.
- NUL-in-text inputs: follow the (as)/(at) policy (accept and document). Case-insensitive tag/serial comparisons: follow (ap) (`COLLATE "C"` on the parameter).
- If a twin needs a schema change or a behavior/product decision, STOP, set build.json blocked and report the options. Do NOT change the schema. Do not expand scope (no people writes, no route/seam wiring, no 5D work).

Tests (new test/pg/pg-asset-records.test.js and test/pg/pg-asset-custody.test.js, reusing test-support/pg-fixtures.js / pg-parity.js): focused differential SQLite vs PG with identical fixtures for each function (success, every refusal path, return shapes, activity rows, status changes); CSV import success, per-row failure with full rollback verified, and a mid-import forced failure; concurrency tests on PG (parallel checkouts of one asset, parallel creates/imports for tag uniqueness, check-in vs checkout, archive vs checkout, duplicate return/issue requests, lock timeout -> ASSET_BUSY with nothing written); email-after-commit (sent only on commit, nothing on rollback). Update test/pg/seam-parity.test.js so `MISSING` is EMPTY: every SQLite seam module/export has its PG twin with no exceptions.

Docs: add docs/briefs/postgresql-slice-5c-5-asset-records-custody.md (design, lock order, race outcomes, header-documented deviations) and update PROJECT_STATUS.md / overview table (5C-5 built, (v), (w), (x), (ai) status; note 5C is complete pending review).

Verification: full existing test suite green (SQLite untouched), new PG tests green against the local PG harness, `graphify update .` after changes. Never launch a visible browser.

Report: when done, open the PR (target integration/postgresql, title "feat(pg): PostgreSQL Slice 5C-5 - ..."), set build.json done, and write ~/.claude/relay/nutricost-it-scan/report.json (shape `{id:"report-<ms>",kind:"report",at:<ms>,title,route:null,text:<markdown>}`) from your own session text: what was built, race outcomes, deviations, test counts, genuine blockers. End commits with the Co-Authored-By line from the session reminder.

---

## As built (2026-10-16)

The fifth and last 5C PR. Twins `src/pg/assetRecords.js` (`FLAGS`, `ASSET_FIELDS`, `formatTag`, `tagExists`, `allocateTag`, `assertSerialFree`, `resolveAssetNode`, `createAsset`, `updateAsset`, `archiveAsset`, `peekTag`, `importAssets`) and `src/pg/assetCustody.js` (`checkin`, `requestReturnFrom`, `requestMyReturn`, `reportIssue`, `returnNotice`: everything the SQLite module exports; the check-out itself is `assignments.createAssignment`, twinned since Slice 3). Same names, async, executor `q` first, the same return values and errors. Every write is ONE transaction, the caller's when `q` is a transaction client (`isInTransaction(q) ? run(q) : withTransaction(run, q)`). Nothing is wired into `server.js`, `src/dataSeam/` or the SQLite modules; no schema change; no existing `src/pg` module changed. The headers of both twins hold the full design; this is the summary.

### Design

| Function | Transaction (in this order) |
|---|---|
| `createAsset` | (blank tag) the counter claim `UPDATE asset_tag_counter ... RETURNING` -> the tag / serial checks -> `INSERT ... RETURNING id` -> activity row. The claim + checks + INSERT run under a SAVEPOINT: a unique violation (23505) from a concurrent create that committed the same tag / serial first rolls back to the savepoint and re-runs the readable check (SQLite's 400 for the second); an issued number taken meanwhile by an explicit tag is skipped (claim retried). |
| `updateAsset` | `lockAsset` -> serial check -> UPDATE (same SAVEPOINT backstop for the serial). A missing id: nothing to lock, 0 rows, no error (as SQLite). |
| `archiveAsset` | `lockAsset` -> 404 / already archived / open assignments, all on the locked row -> UPDATE + activity row. |
| `peekTag` | A plain read. |
| `importAssets` | The tag counter row `FOR UPDATE` (claims nothing) -> `LOCK TABLE assets IN EXCLUSIVE MODE` -> the active employees (ordered by id, SQLite's measured scan order) -> every row, as on SQLite. Plain reads go on; every other writer of asset rows, every `lockAsset` and every foreign-key check on an asset waits until the import ends (SQLite's single writer). Assigned rows still take `lockAsset` (never waits under the table lock). Anything that throws rolls the whole file back: no row, no counter movement, no activity. |
| `checkin` | `lockAsset` -> the open assignments and the target re-read on the locked asset (none open: 400 'This asset is not checked out'; target no longer open: 400 'Choose which person is returning it') -> the assignment UPDATE -> condition / maintenance / lost -> available (status as locked) -> `refreshStatus` -> location -> the live return requests locked `FOR UPDATE` -> `completeReturnRequests` -> `waitlist.evaluateAsset` (its `holds_owed` effect fires after COMMIT only). |
| `requestReturnFrom` | `lockAsset` -> the holder still holds it? (else null: skipped) -> a live return request? (null) -> `INSERT ... RETURNING *` -> activity. |
| `requestMyReturn`, `reportIssue` | `lockAsset` -> the route's guard `assetAccess.heldAsset` run again (404 / 400, the route's errors) -> the duplicate check (400) -> `INSERT ... RETURNING *` -> activity (`reportIssue` stores the category as locked). |
| `returnNotice` | `lockAsset` -> "checked out to you" (400) -> the live return request `FOR UPDATE` -> its transition to dropped off, or the INSERT -> activity. |

### Lock order and why it cannot deadlock

Tag counter row -> assets (the table lock for the import; one asset row for update / archive / check-in / custody) -> that asset's assignment rows -> its request rows -> its reservations / waitlist entries. This is 5C-4's order (asset -> assignments -> request) and the 4B / 4C rule (asset first). No path takes an asset row and then the counter; the import takes the counter and the table lock before anything else, and `createAsset` holds the counter and only its own new row. The writes that touch dependent rows WITHOUT the asset lock (request transitions: cancel / deny / resolve / dropped-off / open; the overdue mark) are one autocommit UPDATE of one row each and never wait for anything while holding it. Tested without deadlock: archive vs check-out (both orders), check-in vs check-out (both orders), check-in vs dropped-off (both orders), the import vs a check-out (both orders) and vs a create. Remaining (no wrong write): two writers inserting the same tag AND the same serial crosswise can deadlock on the two unique indexes; PostgreSQL aborts one (a 500, rolled back).

### Race outcomes (carry-overs (w), (x), (ai))

| Race | Outcome |
|---|---|
| Two check-outs of one single-unit asset | One wins; the others get `createAssignment`'s 400 (Slice 3, re-tested). |
| Check-in vs check-out | The second waits for the asset lock and sees the committed state (both succeed where seats allow). |
| Two check-ins of one assignment | The second gets the route's 400; the first return (returned_at / returned_to) is never overwritten. |
| Check-in vs the employee's "dropped off" | Both orders: the check-in completes the return request (dropped off first: the check-in waits on the request row, then completes it; check-in first: the transition gets a 400). |
| Two `requestReturnFrom` / `requestMyReturn` / `reportIssue` (same text) / `returnNotice` | One row; the second gets SQLite's answer (null / the 400 / only an activity row). Backed by `idx_requests_live_return` for return requests. |
| Request return / report issue / IT's request vs a check-in | Check-in first: refused with the route's 400 "This isn't checked out to you" (IT's request: the holder is skipped, null); request first: the check-in completes it. |
| Archive vs check-out | Archive first: 'This asset is archived and can't be checked out.'; check-out first: 'Check this asset in before archiving it.' |
| Two creates with one explicit tag / one serial; two updates to one serial | Decided by the unique indexes; the second gets SQLite's 400 (with the first asset's tag). |
| An explicit tag equal to the next issued number vs a blank-tag create | The issued create skips the number (as `allocateTag` does). |
| Parallel creates and imports | Distinct, consecutive numbers (the counter row serializes the claims). |
| Lock timeout on any asset-locked write | 503 `ASSET_BUSY`, nothing written. |

### Deviations (header-documented)

- `requestMyReturn` / `reportIssue` re-run the route's `heldAsset` guard under the lock, and `requestReturnFrom` skips a holder who no longer holds the asset: a direct call with an asset the caller does not hold is refused / skipped here, where SQLite's module (always behind its route) would insert.
- `checkin` re-validates the target under the lock; a check-in IT started with a single open assignment still checks in exactly that assignment if a second holder appeared meanwhile (SQLite's route, run after that check-out, would have asked "Choose which person is returning it").
- Numbers: NaN binds as NULL and -0 as 0 (what SQLite stores). A `license_seats` value that is not a whole number in integer range (2.5, 1e10) cannot be stored in the PostgreSQL integer column: a 500 (and the whole import rolled back) where SQLite stores it. New carry-over (au), accepted for 5D like (as) / (at) unless the owner decides otherwise.
- NUL in any text (tag, name, notes, message, note): a 500, nothing written ((as) / (at)).
- The import holds `EXCLUSIVE` on `assets` for its duration: concurrent asset-locked writes wait (up to the 5 s lock timeout, then 503 `ASSET_BUSY`); the LOCK TABLE itself has no timeout (it waits for the in-flight asset transactions, which are short and bounded by their own lock timeouts).

### Not changed (route-level, 5D)

The routes' emails and the check-in's `checked_in` activity row stay after the call; `dispatchHoldEmails` after check-in becomes the `holds_owed` effect. PUT's other pre-reads (its open-assignment count for the status, the catalog root) and `POST /api/assets`'s `tag_prefix` read stay separate seam calls ((ah)).
