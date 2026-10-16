# PostgreSQL migration — Slice 5 overview (5A / 5B / 5C / 5D)

**Decisions:** D-46, D-47, D-48. **Status:** APPROVED (owner, 2026-10-14). **5A merged** into `integration/postgresql` (#36, `1d4f94e`). **5B split CONFIRMED** (5B-1 to 5B-4 below). **5B-1 merged** (#38, `a30ea6a`; `docs/briefs/postgresql-slice-5b-1-driver-seam.md`). **5B-2 merged** (#39, `61005e8`; `docs/briefs/postgresql-slice-5b-2-assets-seam.md`). **5B-3 merged** (#40, `b55947b`; `docs/briefs/postgresql-slice-5b-3-auth-seam.md`). **5B-4 merged** (#41, `ab6293e`; `docs/briefs/postgresql-slice-5b-4-remaining-seam.md`): **5B is complete** (`server.js` reaches the database only through the seam). **5C split APPROVED** (five PRs, below). **5C-1 merged** (#43, `c7d431a`; `docs/briefs/postgresql-slice-5c-1-shared-helpers.md`). **5C-2 merged** (#44, `1ce305d`; `docs/briefs/postgresql-slice-5c-2-asset-reads.md`). **5C-3 built, awaiting review** (`docs/briefs/postgresql-slice-5c-3-accounts-sessions.md`). Next: 5C-4.

Slice 5 is **application integration, NOT the Railway cutover**. PostgreSQL stays local-only (Docker) until the staging cutover in Slice 7; the Railway staging configuration is unchanged.

| Slice | Scope | State |
|---|---|---|
| **5A** | Runtime services built and tested in isolation: shared mail core + SQLite / PG mail adapters, the effects notifier, the single-flight sweep scheduler, the asset-lock timeout and 503 busy errors, two 4C refinements. `server.js` is not touched; nothing is wired into the running app. | merged (#36) |
| 5B | Temporary driver seam (`DB_DRIVER`, default sqlite): `server.js` becomes async and calls data modules through the seam; inline SQL (assets, people, auth, photos, dashboard, settings/import-export, overdue, sessions...) is extracted into modules verbatim for SQLite. Several smaller PRs, **split confirmed:** **5B-1** seam + already-modular routes (availability, reservations, waitlist, catalog edits, request open); **5B-2** assets/photos/dashboard/scan/labels; **5B-3** people/auth/sessions (plus forgot / reset, moved here from 5B-4: they share the tokens table with invitations); **5B-4** settings/email/import-export/remaining (the request list/create/approve/resolve/dropped-off routes, `next-tag`, the sweep timers, `GET /api/me` once settings are on the seam). All on SQLite, the whole suite green each time. | **5B-1 merged** (#38, 21 routes); **5B-2 merged** (#39, 22 routes + `/uploads`, 43 on the seam); **5B-3 merged** (#40, 14 routes + the auth middleware, `/uploads` session lookup, session store and purge; 57 on the seam); **5B-4 built, awaiting review** (14 routes + the overdue / waitlist sweeps; 71 on the seam, the other 5 routes have no database access; `server.js` has no direct database access left). 5B complete once 5B-4 is merged |
| 5C | PostgreSQL implementations of the 5B-extracted modules (`src/pg/<same name>.js`, same names, parallel signatures, first argument `q`), with differential tests. Five PRs (see "Slice 5C plan" below). | **5C-1 merged** (#43); **5C-2 merged** (#44); **5C-3 built, awaiting review**; 5C-4, 5C-5 planned |
| 5D | `DB_DRIVER=pg` switch: async boot + migrate, PG session store, notifier install, sweep timer; the whole existing suite on PG. Local Docker PostgreSQL only. | planned |

Then Slice 6 (seeds/tests, SQLite removal) and Slice 7 (staging cutover + tested backup/restore, the only slice that touches Railway). The temporary seam is removed at cutover; there is no permanent dual-database architecture (D-48).

## Slice 5C plan (approved five-PR split)

Each PR adds `src/pg/<module>.js` twins (same names as the SQLite module, async, executor `q` first) with differential tests against the SQLite module; nothing is wired into the app (that is 5D). `test/pg/seam-parity.test.js` lists every seam function still without a twin (`MISSING`); each PR removes its entries, and the list must be empty when 5C ends.

| PR | Scope | Carry-overs |
|---|---|---|
| **5C-1** (merged, #43) | The shared helper modules: `activityLog`, `outbox`, `overdue`, `photoRecords`, `assetAccess`, `reservationViews`, `requestAccess`, `catalogViews`, `catalogAdmin`; plus the seam parity test. | (r), the helper part of (v), (ag) for outbox / overdue / `activityLog.recent` |
| **5C-2** (merged, #44) | Asset reads: `assetViews` (incl. `exportRows`), `dashboard`, the people reads (`getPerson`, `listPeople`, `personAssignments`, `employeeStatus`, and the four email-in-use checks, plain reads that the 5C-3 writes run inside their transaction). | (v), (ag) for `exportRows` / `employeeStatus` |
| **5C-3** (built) | `accounts`, `sessions`, the people writes (running the 5C-2 email-in-use checks inside their transactions). Security-sensitive. | (aa), (ab), (ac), (af) |
| 5C-4 | `requestRecords` (list, create, approve). | (ag), (ah) |
| 5C-5 | `assetRecords` (incl. `peekTag`, `importAssets` and the CSV import), `assetCustody`. | (v), (w), (x), (ai) |

**Gate before 5D:** every PostgreSQL race carry-over, (w), (x), (ab), (ac), (af), (ah) and (ai), is either closed in its 5C PR or explicitly accepted by the owner. **Not part of 5C:** authentication hardening (PROJECT_STATUS.md, Priority Future Work) is its own slice before the production cutover.
