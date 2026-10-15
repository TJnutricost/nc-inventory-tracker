# PostgreSQL migration — Slice 5 overview (5A / 5B / 5C / 5D)

**Decisions:** D-46, D-47, D-48. **Status:** APPROVED (owner, 2026-10-14). **5A merged** into `integration/postgresql` (#36, `1d4f94e`). **5B split CONFIRMED** (5B-1 to 5B-4 below). **5B-1 merged** (#38, `a30ea6a`; `docs/briefs/postgresql-slice-5b-1-driver-seam.md`). **5B-2 built, awaiting review** (`docs/briefs/postgresql-slice-5b-2-assets-seam.md`). Next: 5B-3.

Slice 5 is **application integration, NOT the Railway cutover**. PostgreSQL stays local-only (Docker) until the staging cutover in Slice 7; the Railway staging configuration is unchanged.

| Slice | Scope | State |
|---|---|---|
| **5A** | Runtime services built and tested in isolation: shared mail core + SQLite / PG mail adapters, the effects notifier, the single-flight sweep scheduler, the asset-lock timeout and 503 busy errors, two 4C refinements. `server.js` is not touched; nothing is wired into the running app. | merged (#36) |
| 5B | Temporary driver seam (`DB_DRIVER`, default sqlite): `server.js` becomes async and calls data modules through the seam; inline SQL (assets, people, auth, photos, dashboard, settings/import-export, overdue, sessions...) is extracted into modules verbatim for SQLite. Several smaller PRs, **split confirmed:** **5B-1** seam + already-modular routes (availability, reservations, waitlist, catalog edits, request open); **5B-2** assets/photos/dashboard/scan/labels; **5B-3** people/auth/sessions; **5B-4** settings/email/import-export/remaining (the request list/create/approve/resolve/dropped-off routes, `next-tag`, the sweep timers). All on SQLite, the whole suite green each time. | **5B-1 merged** (#38, 21 routes); **5B-2 built, awaiting review** (22 routes + `/uploads`, 43 on the seam); 5B-3, 5B-4 planned |
| 5C | PostgreSQL implementations of the 5B-extracted modules, with differential tests (same split). | planned |
| 5D | `DB_DRIVER=pg` switch: async boot + migrate, PG session store, notifier install, sweep timer; the whole existing suite on PG. Local Docker PostgreSQL only. | planned |

Then Slice 6 (seeds/tests, SQLite removal) and Slice 7 (staging cutover + tested backup/restore, the only slice that touches Railway). The temporary seam is removed at cutover; there is no permanent dual-database architecture (D-48).
