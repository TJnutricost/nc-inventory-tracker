# PostgreSQL migration — Slice 5 overview (5A / 5B / 5C / 5D)

**Decisions:** D-46, D-47, D-48. **Status:** APPROVED (owner, 2026-10-14). **5A in progress** (`docs/briefs/postgresql-slice-5a-runtime-services.md`).

Slice 5 is **application integration, NOT the Railway cutover**. PostgreSQL stays local-only (Docker) until the staging cutover in Slice 7; the Railway staging configuration is unchanged.

| Slice | Scope | State |
|---|---|---|
| **5A** | Runtime services built and tested in isolation: shared mail core + SQLite / PG mail adapters, the effects notifier, the single-flight sweep scheduler, the asset-lock timeout and 503 busy errors, two 4C refinements. `server.js` is not touched; nothing is wired into the running app. | in progress |
| 5B | Temporary driver seam (`DB_DRIVER`, default sqlite): `server.js` becomes async and calls data modules through the seam; inline SQL (assets, people, auth, photos, dashboard, settings/import-export, overdue, sessions...) is extracted into modules verbatim for SQLite. Several smaller PRs, **proposed split (to be confirmed by the planner):** 5B-1 seam + already-modular routes; 5B-2 assets/photos/dashboard; 5B-3 people/auth/setup/sessions; 5B-4 settings/email/import-export/overdue/leftovers. All on SQLite, the whole suite green each time. | planned |
| 5C | PostgreSQL implementations of the 5B-extracted modules, with differential tests (same split). | planned |
| 5D | `DB_DRIVER=pg` switch: async boot + migrate, PG session store, notifier install, sweep timer; the whole existing suite on PG. Local Docker PostgreSQL only. | planned |

Then Slice 6 (seeds/tests, SQLite removal) and Slice 7 (staging cutover + tested backup/restore, the only slice that touches Railway). The temporary seam is removed at cutover; there is no permanent dual-database architecture (D-48).
