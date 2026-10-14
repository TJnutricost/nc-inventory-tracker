# Brief — PostgreSQL migration, Slice 2 of 7: Foundation

**Branch:** `integration/postgresql` (from `stage` @ `6ec5b11`, PR #29 merged). **Decision:** D-46. **Status:** APPROVED (owner, 2026-10-14). Ready for Builder.

## Goal
Add the PostgreSQL foundation as **new, unused modules** next to the existing SQLite code. After this slice the app still runs on SQLite, exactly as today; nothing in `server.js` or the existing feature modules switches over. Slices 3–6 build on these helpers.

## Out of scope (hard rules)
- No change to the working Railway database configuration, env vars, `Dockerfile`, or staging. Never connect to Railway PostgreSQL (only the local Docker database; keep the `db-check` local-only guard).
- No change to behavior, API shapes, or front end. No conversion of leaf modules, routes, sessions, or seeds (Slices 3–6). No data migration or cutover (Slice 7).
- Existing `src/db.js`, `src/migrate.js`, `src/migrations.js` (SQLite) are **not modified** except where noted; SQLite stays the runtime DB.
- No ORM. TEXT timestamps stay TEXT (D-46). No blanket overlap/exclusion constraints; per-asset row locking only.
- Flaky hold-expiry tests stay separate debt.

## Deliverables
1. **Pool module** (`src/pg/pool.js`): lazy `pg.Pool` from `DATABASE_URL` (default: local dev URL, dev only), session `TimeZone=UTC`, sane max/timeout, `close()`. **Approved: move `pg` to production `dependencies` now** (`package.json` + lockfile; nothing in the running app imports it yet).
2. **Transaction helper** (`withTransaction(fn)`): checkout client, `BEGIN`, run `fn(client)`, `COMMIT`/`ROLLBACK`, always release. Nested use rejected with a clear error (no savepoint magic). Mirrors the semantics of `db.transaction()` that Slice 3+ conversions rely on (all-or-nothing, exception → rollback, exception rethrown).
3. **Per-asset lock helper** (`lockAsset(client, assetId)`): `SELECT … FROM assets WHERE id = $1 FOR UPDATE`, must be called inside a transaction; returns the row or throws a not-found error. This replaces SQLite's `BEGIN IMMEDIATE` for reservation/waitlist/assignment integrity. Document the lock-ordering rule (always lock the asset row before touching dependent rows; one asset per transaction unless a documented order is used).
4. **Baseline schema** (`src/pg/schema/…`): a single PostgreSQL baseline equivalent to SQLite migrations 1–17 final state (27 `CREATE TABLE`s today), with: identity columns in place of `AUTOINCREMENT`; TEXT timestamps and their existing formats; constraints, FKs (RESTRICT history FKs preserved), unique indexes (serial normalization, durable monotonic tags), and CHECKs ported faithfully; TEXT-timestamp CHECKs kept as TEXT-format checks. Applied by a small PG migration runner (`schema_migrations`, one transaction per migration, baseline = migration 1) with a **fresh-database** path only (no production data exists in PG).
5. **Schema parity check**: a test/script that compares the PG baseline to the final SQLite schema table-by-table and column-by-column (names, nullability, defaults, uniques, FKs, CHECK intent), failing on any unexplained difference. Known intentional differences are listed in an allow-list with a reason each.
6. **Per-file test database harness** (`test-support/pg-harness.js` or similar): each test file creates its own throwaway database (`nc_test_<random>`) on the local server, applies the baseline, and drops it on teardown, so files can run in parallel without sharing state. **Approved: ALL database creation/deletion tooling (harness create/drop, any reset script) must refuse non-local hosts using the same strict rule as `isLocalDatabaseUrl` (no query-string overrides), checked before any connection is made, with tests proving remote/Railway-style URLs are rejected.** Tests that need PG **skip with a clear message** when the local database isn't reachable, so plain `npm test` still passes without Docker. **Approved: add an explicit `npm run test:pg` that runs the PG tests and FAILS (non-zero, clear message) when PostgreSQL is unavailable; it never skips.**
7. **Foundation tests** (new, PG-gated): pool connects with UTC; `withTransaction` commit/rollback/release-on-throw/nested rejection; `lockAsset` blocks a second transaction on the same asset until the first commits, does not block a different asset, and throws on a missing asset (concurrency test with two clients); baseline applies cleanly twice (idempotent runner); parity check passes; harness isolates two parallel databases and cleans up.
8. **Docs/tracker:** update `PROJECT_STATUS.md` (Active slice → Slice 2; test count; Next → Slice 3) and add a short PROJECT_HISTORY entry on this branch.

## Acceptance criteria
- `npm test` passes without Docker (PG tests skipped, 536 existing tests unchanged); with `npm run db:up` all new PG tests also pass.
- `git diff stage -- src/server.js src/db.js src/migrations.js src/migrate.js Dockerfile package.json` is empty (`package.json`/lockfile limited to the approved `pg` move and the `test:pg` script).
- The Railway staging app is unaffected: no env/config/Dockerfile change, `/health` unchanged.
- Parity check shows every SQLite table/column accounted for in the PG baseline.
- Lock concurrency test demonstrably serializes same-asset writers.

## Verification
- **Automated:** `npm test` (both with and without the local DB) · `npm run seed:verify` · `node --check public/app.js` · `npm run db:check`.
- **Manual (owner):** `npm run db:up`; run the PG tests; inspect the baseline with `psql` against `nc_assets_dev` only; confirm `npm run dev` still boots on SQLite.

## Decisions (approved)
1. `pg` is a production dependency now.
2. One PostgreSQL baseline schema (squashed) plus the parity check.
3. `npm run test:pg` is explicit and fails if PostgreSQL is unavailable.
4. All DB create/drop tooling is local-only guarded.
5. Railway Staging confirmed healthy by the owner; it stays untouched. Incomplete migration work never merges to `stage`; the owner merges PRs manually.

## Final report (Builder returns)
Files added/changed, test counts (with/without PG), parity-check allow-list with reasons, any deviation from this brief, and confirmation that the no-touch list above is untouched.
