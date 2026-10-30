# NC IT Inventory Tracker — Project Status

**Canonical tracker — keep it short.** Current state, remaining work and the rules future work must respect. Completed-slice implementation and QA reports live in [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md); the reasoning behind each durable decision (including superseded ones) is in [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md). Where they disagree, **this file wins**.

> **Agent guidance:** Read this file first. `docs/PROJECT_HISTORY.md` and `docs/PROJECT_DECISIONS.md` are reference material and should only be opened when historical context or decision rationale is needed.

**Last updated:** 2026-10-30 (reconciled through PR #69, merged into `stage` and deployed to Railway staging; the desktop carousel polish PR is open and pending merge; staging results below are owner-reported unless marked otherwise)

---

## Snapshot

| | |
|---|---|
| **Project status** | Feature-complete MVP running on **Railway Staging** with PostgreSQL 18. **No production environment, domain or email yet.** Readiness: functionally ready for real use on staging; launch blocked by the items under *Must complete before launch*. |
| **Staging** | Railway project "NC IT Scanner", Staging environment: app service from `stage` (PRs #64–#68 merged and deployed; owner-confirmed), `DB_DRIVER=pg` on the private `Postgres` service (sessions in PostgreSQL, `/health` passes, **PostgreSQL migration 005 applied successfully**). The old SQLite database and its snapshots are kept on `/data` until PostgreSQL is accepted. 20 `SMP-` sample assets and 4 login-less sample employees exist for QA, plus one **Staging QA employee** (`staging.qa.employee@example.com`, password login only, self-checkout/scanner OFF; password held by the owner; **remove after QA**). |
| **Production** | None. The Railway **production** environment holds an UNAPPLIED draft service (never deployed, no Volume): do not deploy it until the launch checklist below is done. |
| **Photo storage** | Code merged (#55): private S3-compatible bucket (`nc-inventory-uploads-staging`) when `S3_BUCKET` is set; the app streams every photo after its own access check. **Connected and tested on staging** (owner-confirmed; not independently re-verified in this refresh). |
| **Authentication** | **Google sign-in verified on staging after PR #68.** Google verifies identity only; access needs an **existing, active login of an active employee** (matched by exact email, any email domain). No forced `@nutricost.com`, no domain setting, and Google **never creates** people or logins (the 2026-10-27 first-sign-in auto-provisioning and the single-domain `hd` rule are **superseded**). Password login stays beside it, now with a show/hide toggle (visually approved). Limitation: the OAuth consent screen is **Internal**, so independently managed sister-company Workspace accounts are blocked by Google itself (see Google sign-in section). |
| **Branches** | `feature/*` → `stage` → `main`. **Branch protection is enabled** (GitHub repository rulesets, active, 2026-10-29): `stage` requires a pull request and the CI checks (`Tests (SQLite)`, `Tests (PostgreSQL)`) and blocks force-push and deletion; `main` requires a pull request and blocks force-push and deletion. `main` was last updated 2026-09-28; promoting is a deliberate release decision (Open Decisions). `integration/postgresql` is merged into `stage` and no longer separate. **No feature work is in progress**; the previous work branches are merged. |
| **Tests / CI** | GitHub Actions (#57) runs `npm test` (SQLite) and `npm run test:pg-suite` (`postgres:18`) on every PR and on pushes to `stage` / `main` / `integration/postgresql`; both checks are required on `stage`. Last local full runs (2026-10-29, before PR #68 merged): SQLite **1,093 / 1,093**; PostgreSQL suite **1,033 passing, 0 failing, 28 skipped**. |
| **Schema** | SQLite migrations **1–21** on `stage` (19 employee names + self-checkout default OFF, 20 hashed tokens, 21 `equipment_requests` / `equipment_request_events`); PostgreSQL **001–005** on `stage` and applied on Staging (005 = equipment requests). PR #68 has no schema change. |
| **Stack** | Node.js ≥ 20.12 · Express 5 · PostgreSQL 18 on staging (SQLite still the code default and the local dev default via the temporary `DB_DRIVER` seam) · vanilla-JS front end (no build step) · nodemailer SMTP · S3-compatible photo storage · Docker · PWA manifest/service worker |

**Verify any change with:** `npm test` · `npm run seed:verify` · `node --check public/app.js` (PostgreSQL work also: `npm run db:up`, then `npm run test:pg` / `npm run test:pg-suite`)
(`npm run seed:dev` rebuilds `./data-dev`; use `seed:verify` while a dev server has that DB open. Seeds and `npm test` never send real email.)

---

## Status by area

| Area | State |
|---|---|
| Railway PostgreSQL staging cutover | **Done.** Staging runs on PostgreSQL 18 (verified 2026-10-27). Slices 2–7 are merged; preflight/copy/verify/backup/restore scripts exist (`scripts/pg-*.js`). Leftover: staging SQLite files on `/data`; app (iad) and bucket (sjc) are in different regions. |
| Object storage for photos | **Built, merged (#55), connected and tested on staging** (owner-confirmed, not independently re-verified). Not yet exercised in production; **no automated bucket backup** (Railway buckets have none). |
| Google Workspace authentication | **Done on staging; revised by PR #68 and verified.** See the Authentication row and the Google sign-in section. Production needs its own redirect URI and Railway variables once a domain exists. Magic-link fallback and retiring the password login are not started. |
| Barcode scanning and labels | **Built.** Labels before assets (Print label / Create labels reserve numbers), scan-to-Add, USB/keyboard-wedge and camera scanning, scanner reliability V1 (#54), in-app multi-photo camera, mobile gallery (#56). Camera scanning passed real-iPhone QA over HTTPS (2026-10-27). **Hardware scanners (USB/Bluetooth) and a label printer are still unverified.** |
| Asset tag prefix | **Done** (#60). The prefix is set from Create labels; already-issued labels survive a prefix change (migration 18). The *production* prefix/format is still an open decision. |
| Locations management | **Done** (#62): Locations managed in-app (still no normalization of existing free-text locations). |
| Home KPIs and inventory UX | **Done** (#58, #61, #62, #63): All assets toolbar/filters, photo drop area, light/dark appearance, KPI cards navigate to filtered lists, "Checked out" means temporary checkouts, sidebar fixes. |
| CI/CD and testing | **CI done** (#57). **Security hardening done** (#59). **Branch protection enabled** on `stage` and `main` (see Branches). **No CD**: deploys are Railway auto-deploys from `stage`; there is no production pipeline. |
| Email | **Not configured on staging**: no SMTP, so email goes to the Outbox only. Google Workspace SMTP (App Password) is the only transport and is proven in development. |
| Employee import | **Done: merged (#64) and on staging.** Details under *Must complete before launch*; running the real roster through it is still open. |
| Employee reservations & equipment requests | **Done: merged (#67), deployed to staging and verified** (PostgreSQL 005 applied; an employee submitted an equipment request and IT received it; the staging QA employee exercised the employee side). See the section below. |
| Scanner access | **Permission-gated** (same branch): admins and employees with the self-checkout permission only; the scanner API answers 403 otherwise and the UI hides every entry point and never starts the camera. Browsing and requests stay open. **Every new employee starts with self-checkout OFF** (CSV and manual creation; also the database default; Google sign-in creates nobody). |

---

## Must complete before launch

These block go-live. Order is a recommendation.

1. **Employee CSV import** — **done: merged (#64) and on staging** (brief: `docs/briefs/employee-csv-import.md`). Admin-only *Import CSV* on People (separate **First name** / **Last name** columns, a combined name column is refused): template, preview of creates/updates/unchanged/left-out rows, explicit confirmation, idempotent re-import, results CSV, 2,000+ rows. Imported people have **no login** and **self-checkout OFF**; since PR #68 they cannot sign in with Google until IT gives them a login (the earlier "Google links them by work email" behaviour is **superseded**). Columns: first_name, last_name, work_email (required), department, job_title, location, phone; anything else (incl. Employee ID) is refused. Matching is by work email. **Schema:** migration 19 / PostgreSQL 003 adds `employees.first_name` / `last_name` (legacy names are never split; `name` stays as the display name for now) and makes new employees default to self-checkout OFF; applied on staging. Still open for launch: run the real roster through it on staging.
1b. **Bulk assignment import** (upcoming, not started; recorded 2026-10-28) — load the *existing* assignments (which employee holds which asset, permanent vs temporary) from a CSV so go-live starts with real holdings. Builds on the asset import (`assigned_email` checks an asset out today, temporary only by default) and the employee import; needs its own brief (preview, matching by tag/serial and work email, permanent vs temporary, due dates, history preservation, idempotency). Scope reminder: launch population only, **not** an HR synchronization platform or scheduled roster sync.
2. **Domain and production environment** — decide parent/admin/employee domains (Open Decisions); create the production Railway environment (app, PostgreSQL, bucket, variables) from a known-good `main`; production `APP_URL`, HTTPS and Google redirect URI; the first admin comes from first-run setup (`SETUP_TOKEN`, closed in production without it), **not** from Google (Google creates no logins; `GOOGLE_ADMIN_EMAILS` only promotes an existing login); decide promotion `stage` → `main`. If sister-company Workspace accounts must use Google sign-in, the OAuth audience must be changed deliberately (see Google sign-in section).
3. **Email configuration** — choose the production sending mailbox (shared IT mailbox vs individual identities, D-36); set SMTP secrets on staging and production; verify Workspace delivery, From/Reply-To and IT identity for invitations and waitlist emails. Unset `MAIL_TEST_RECIPIENT` in production.
4. **Backups** — **Railway-only (owner decision 2026-10-28); live on Staging and verified 2026-10-28** (PR #65; runbook `docs/BACKUP_RUNBOOK.md`, brief `docs/briefs/railway-backups.md`). Running automatically: Railway **daily volume backup** of the staging Postgres volume (6-day retention) and the **`nc-backup` cron service** (`30 7 * * *` UTC, restart policy never, region iad) that writes an **AES-256-GCM encrypted `pg_dump`** (14 daily / 8 weekly / 6 monthly kept) and add-only, versioned, checksum-verified photo copies to the private bucket `nc-inventory-backups-staging` (estimated cost under $1/month). **Verified on real Railway data (one supervised run, 2026-10-28 22:20 UTC):** the run exited OK (17 tables, 119 KB dump, 12/12 photos copied, 0 failed); the stored dump starts with the encryption header and contains no `PGDMP` marker or readable email; the dump was downloaded, decrypted with the key from the Railway variable and restored into a NEW empty local PostgreSQL 18 database (17 tables; migrations 1,2,3; 7 employees, 3 accounts, 23 assets); all 12 photos restored into an empty directory and each matches the live bucket object byte for byte (size and MD5); the live database and live bucket were only read and the staging app stayed healthy. Not verified: restored database vs the live database row for row (the live database is reachable only on Railway's private network; the automated PostgreSQL test does that comparison), and Railway's failure e-mail (see below). Still to do: (a) confirm Project Settings → Notifications has *Deployment failed/crashed* enabled for the owner (no webhook exists; the 22:00 UTC failed run on 2026-10-28 should have produced one: check the inbox), (b) ~~first scheduled 07:30 UTC run~~ **verified 2026-10-29: the first scheduled encrypted backup ran and was checked (owner-confirmed)**, (c) repeat for production when it exists, (d) monthly restore drill. Lessons: a cron service only runs on its schedule (Redeploy does not run it); the encryption key must be exactly 32 random bytes (base64) and variable changes must be deployed. Limitations (everything in one Railway account, no read-only bucket keys, no independent alerting) are in the runbook.
5. **Security and final QA** — close or consciously accept the open security items (below); final staging acceptance pass with real devices; production admin accounts; real inventory import plan and initial import; basic error monitoring/alerting.

**Open security items** (from the 2026-10-27 review; no high-severity issue found): ~~reset/invite tokens stored in plain text~~ **fixed (PR #66, merged and on Staging; PostgreSQL migration 4 applied):** `tokens.token` holds `sha256:<hex>` and outbox bodies no longer carry the link (`#/reset/[redacted]`). ~~Branch protection on `stage`/`main`~~ **enabled 2026-10-29** (rulesets; see Branches). Still open: `GOOGLE_ADMIN_EMAILS` re-promotes an existing login at every sign-in (clear it after bootstrap; consider removing the promotion); basic error monitoring/alerting; the Internal OAuth audience (limitation, not a defect).

## Employee Reservations & Equipment Requests (approved 2026-10-29; **PR #67 merged to `stage`, deployed to Staging and verified 2026-10-29**: PostgreSQL migration 005 applied, an employee submitted an equipment request and IT received it; brief: `docs/briefs/employee-reservations-requests.md`)

Two separate employee actions. **Reserve equipment** (renamed from "+ Request equipment") opens Browse and the existing reservation system unchanged (calendars, per-asset approval, waitlist; no scanner or self-checkout permission; a reservation never grants checkout). **Request equipment** is a new form: exactly one item, a searchable catalog category (brand / model are the levels under it) or Other, optional brand / model, optional details, and **Request permanent assignment** (default off); identical open requests are allowed (two monitors = two requests). **One Requests screen** for IT and employees: **Equipment | Returns | Reservations**, each with Open / Closed; Equipment lists the new equipment requests and the earlier item requests side by side (both tables stay as they are; nothing was converted), Returns holds returns and issue reports. In a request, IT's **Decisions** panel holds two independent decisions (equipment: Pending / Approve / Decline; permanent assignment, only when requested: Pending / Approve / Deny), saved together or one at a time; a note can be saved alone. Lifecycle `submitted → in review → approved → ready → fulfilled` (+ declined / cancelled), an append-only audit trail, server-enforced. Approved permanent = IT delivers and assigns (admin-only, D-15), fulfilled only then. Shared equipment: marking a unit **ready** notifies the requester and starts a **48-hour priority hold** that blocks everyone else (reserve and checkout, IT included) without overriding any existing reservation or checkout; it expires automatically, the employee can decline early, and a reservation made during the hold is a **claim** (the request stays Ready, the reservation protects only its own dates; Fulfilled only when the equipment is actually issued). Never automatic: nothing is purchased, created or assigned by submitting. **Schema:** migration 21 / PostgreSQL 005 (`equipment_requests`, `equipment_request_events`); applied on Railway staging.

## Google sign-in: identity by Google, access by the People/login directory (PR #68 merged to `stage` 2026-10-29; **verified on staging**)

* Replaces the single-domain rule: no `hd` hint, no domain setting (`GOOGLE_HOSTED_DOMAIN` removed; a first-draft `GOOGLE_ALLOWED_DOMAINS` was dropped before merge). A sign-in succeeds only for a valid token, a verified email, and that exact email being the login of an **active account of an active employee**. Google **never creates** an employee or login (`googleAccount`/`provisionGoogleAccount` removed on both drivers); no self-registration or approval queue. `GOOGLE_ADMIN_EMAILS` only promotes an already-authorized login (still re-promotes at every sign-in: clear it after bootstrap). Brief: `docs/briefs/google-sign-in.md` (Revision 2026-10-29).
* **Superseded behaviour (kept for history):** until PR #68 a first Google sign-in with a company-domain address created an employee login, and only `GOOGLE_HOSTED_DOMAIN` (default nutricost.com) could sign in (D-10 revised 2026-10-27). **Behaviour change:** the first admin of a NEW environment can no longer be created by `GOOGLE_ADMIN_EMAILS`; use first-run setup (`SETUP_TOKEN`) or have an existing admin add the person.
* **Verified on staging after PR #68 (owner-confirmed):** Google no longer forces `@nutricost.com`; sign-in requires an existing authorized account; the password show/hide toggle was visually approved.
* **Limitation:** the OAuth app is *Internal*, so Google admits only the project's own Workspace organization; **independently managed sister-company Workspace accounts are blocked by Google before they reach this app**, whatever logins exist here. That needs a deliberate OAuth change (External audience with this directory as the gate, or moving the domains into one Workspace organization). Not changed; no Google Cloud settings were touched.
* **Staging QA employee (provisioned 2026-10-29, Staging only):** `staging.qa.employee@example.com`, "Staging QA Employee", Employee, password login, self-checkout/scanner off, no assignments, title "TEST ACCOUNT - remove after QA", department "QA (temporary)". **Available for future QA; remove when no longer needed** (People → deactivate; delete the rows if ever needed). Password held by the owner only. Not Google-capable (not a real Google identity).
* The login form has a show/hide password eye toggle (merged in #68; no backend change).
* **Future work (not built):** HR onboarding integration to create/disable people and logins automatically; **refresh the IT Requests list and its notification badge when the browser tab regains focus**, so newly submitted employee requests appear without a manual page refresh.

## Catalog Model Detail & Navigation Improvements (built and visually approved 2026-10-30 on `feature/catalog-model-details-nav`; **PR #69 merged to `stage` and deployed to Railway staging**)

*Replaces the earlier "Grouped All Assets" plan.* The hierarchical catalog already grouped assets (Desktop → Apple → Mac Mini M2 → units); it was **not** rebuilt. Frontend-only (`public/app.js`, `public/app.css`): no API, schema or status changes, no new tests (browser-verified against a 263-unit QA model; `frontend-loads` and `catalog` tests pass).

* **Navigation:** a prominent "Back to <parent>" pill (44px target), the clickable breadcrumb trail directly under it and above the title, at every catalog depth; browser history and scroll-to-top unchanged.
* **Model detail (IT All assets, any selected entry with assets):** one **Statuses** dropdown (anchored menu on desktop, the app's bottom sheet on phones; no statistic tiles) built from the same list as the units below, each unit counted once: All units, Available, Permanently assigned, Temporarily checked out (with an overdue note), then Assigned + checked out (multi-seat units with both kinds of holder), In repair, Lost, Retired, Disposed, Other (only those with units). Reservations are not counted; counts never change with the selection. The API list is capped at 1,000 units (a note appears if reached).
* **Unit finder:** search by tag, serial number, assigned person or name; one row per unit with status and holder; opens the existing asset detail. Desktop: scrollable list (300 rows painted at once; search narrows). Phones (up to 899px): the page scrolls instead.
* **Status filter:** one selection at a time within the current scope (selecting it again or All units clears; combines with search; count line plus Clear filter; zero-match message). Phones hide the redundant heading and "Every asset filed in…" note.
* **Category cards:** one horizontally scrolling row at every level (never wrapped; swipe on phones with a partial next card visible, arrow buttons on desktop while it overflows), 16px above the Statuses control.
* **State:** the selected status and unit search live in the URL (`?unit=<status>&uq=<text>`, written with `replaceState`: no history entry per keystroke), are carried to the asset page and restored by browser Back and the on-page Back link, together with scroll position; another catalog entry's URL carries neither. Brief: none (small slice).
* Unchanged: Manage, Add, Labels, filters, the top-level All assets list, status-filtered views, search results and the employee Browse experience.

Future work (not part of this slice): refreshing the **IT Requests list and its notification badge when the tab regains focus**, and the **HR onboarding integration**. Also out of scope: onboarding packages, purchasing, production deployment.


**Desktop category carousel polish (visually approved 2026-10-30 on `feature/catalog-carousel-polish`; PR to `stage` open, pending merge, not deployed).** Frontend-only (`public/app.js`, `public/app.css`), desktop (900px+) only: the 44px prev/next arrows moved outside the card row (the page margin at 1440px+, a reserved 56px gutter inside the section below that) and hide at the scroll boundaries; a thin custom scrollbar (accessible `role="scrollbar"`, draggable thumb, clickable track, arrow/Home/End keys, synced with the row, hidden when the cards fit) sits below the cards. Phones are unchanged (no arrows, no bar, no gutter). One new source-level test in `test/catalog.test.js`.
## Important but nonblocking

- **Real-device QA** (iPhone Safari, Android Chrome, Firefox) of the calendar/reserve/waitlist sheets, Shorten calendar, search/Browse and the 320–375 px top bar; asset photo upload on mobile; cross-browser pass.
- **Scanner hardware QA**: USB and Bluetooth scanners, Android camera, barcode matrix (Code 128, QR, Code 39, UPC/EAN), failure cases; label printer and label dimensions (Open Decisions).
- Staging cleanup: remove the leftover SQLite files after PostgreSQL is accepted; custom domain on staging; logs/restart-behaviour review; unify regions if latency matters.
- **Google Workspace OAuth email connection** (Admin Settings → Email → *Connect Google Workspace*; no Google passwords stored). SMTP with an App Password works today; this replaces manual env/secret edits (D-35).
- Remove the temporary SQLite/PostgreSQL duplication and the `DB_DRIVER` seam (own slice after cutover acceptance, D-48); until then keep mirrored logic in sync (Workflow).
- Invitation-delivery messaging when mail is not configured (the UI should say nothing was delivered and offer the link).
- Overdue / hold-expiry emails beyond the existing sweeps; email IT for pending approvals; email the employee on approve/decline/cancel.

## Future improvements

- **Requests refresh on tab focus** (IT Requests list and badge, so new employee requests appear without a manual refresh) and **HR onboarding integration** (automatic creation/disabling of people and logins) — both future work, not part of the next slice.
- Admin employee/equipment **roster + CSV export** (permanent vs temporary separated).
- Max temporary-checkout / reservation policy; reservation follow-ups (admin-created/extended/moved, late return against next reservation, reservation → checkout conversion, no-show expiry, recurring); `APP_TIMEZONE`-aware "now".
- Per-asset waitlist response policy (Fast / Standard / Extended; Standard = D-45 tiers); defaults for new assets by category/node.
- Physical **inventory audits / cycle counts**; paired-phone scanner.
- Catalog: audit trail, bulk "map many assets to a node", drag-to-reorder, Grid/List/Columns views, split `available_to_request` into visibility and requestability.
- Search extras (fuzzy matching, ranking, highlighting, keywords on assets); People First/Last Name fields; magic-link fallback and retiring the password login.
- Location/category normalization (still free text); tag-correction workflow; unarchive endpoint and archived-assets UI.

---

## Workflow

- `PROJECT_STATUS.md` is the canonical tracker; every meaningful slice updates it before completion (short here, detail to PROJECT_HISTORY.md).
- Branches: feature/chore/docs **from `stage` → PR into `stage`**; never merge straight to `main`; promotion is a separate release decision. No documentation-only PRs for routine status updates: carry them with the next feature branch.
- **Until the temporary seam/duplication is removed (D-46, D-48):** a change to `settings`, `src/catalog.js`, `src/requests.js`, `src/assignments.js`, `src/availability.js`, `src/reservations.js` or `src/waitlist.js` logic, or to any module with a `src/pg/` twin, must be mirrored in the twin and its `test/pg/` differential test; PRs touching the database layer (`src/db.js`, `src/migrations.js`, SQL in routes/modules) are flagged to teammates.
- Roles: ChatGPT plans/reviews; **Claude Code is the default implementer**; Codex is a secondary implementer/reviewer.
- One focused slice at a time with scope, acceptance criteria, automated and manual verification, and a final report.
- Dummy/non-sensitive data until verified (seed users use `example.com`). No production infrastructure or data changes without explicit approval.
- Scanner functionality is verified on real devices, not assumed from desktop testing.
- Prefer incremental change over a rewrite; preserve historical equipment records.

---

## Completed major work

Merged into `stage` (PR numbers from the repository history). Detail: [PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md).

- **Foundation** — Phase 0 local baseline, dev seed, golden-workflow test, scanner desktop QA (#1–#3); Railway-first architecture docs (#4); Phase 1 data-model hardening (#5–#11): migrations, archive instead of delete, durable tags, employees/accounts split, assignment types and seat capacity, serial uniqueness, request-state integrity.
- **Phase 2 — Employee Portal V1** (#12–#24, D-44): employee read experience and actions, hierarchical catalog, mobile shell (real-iPhone QA passed), admin request workflow, availability calendar, reservations, waitlist with 24-hour holds and targeted emails, search/discoverability, optional pickup/return times, role-aware shell label.
- **PostgreSQL migration** (#29–#51, D-46–D-48): Slices 2–6 (modules, driver seam, twins, `DB_DRIVER=pg` runtime, data preflight/copy/verify, backup/restore) merged; Slice 7 staging cutover done and verified 2026-10-27. Details and the Slice 5 carry-over notes are archived in PROJECT_HISTORY.md Appendix C.
- **Google sign-in** (D-10, `c9cc421` and follow-ups): originally the first sign-in created an employee login (**superseded by #68: Google creates nobody; only an existing active login can sign in**); employees edit their own profile (D-21 revised).
- **Labels and assets** (2026-10-27): labels before assets, Create labels with reserved numbers, one All assets page with drill-down, status chips and CSV export; give-back flow; Back links everywhere.
- **Scanner reliability V1** (#54), **private S3 photo storage + in-app camera** (#55), **mobile gallery and iPhone camera fix** (#56).
- **CI** (#57), **UI Cleanup V1** (#58), **security hardening** (#59: CSP/HSTS, setup gate, auth-session fixes, rate limits, upload limits, dependency CVEs), **asset tag prefix** (#60), **appearance system** (#61), **inventory UX completion** (#62: Locations, Home KPI navigation, toolbar spacing, "Checked out" = temporary checkouts), **sidebar width fix** (#63).
- **2026-10-28 / 10-29 (all merged into `stage`, deployed to Staging):** **Employee CSV import** (#64: first/last names, scanner permission, self-checkout OFF by default); **Railway staging backups** (#65: encrypted dumps + photo copies, verified); **authentication token security** (#66: hashed reset/invite tokens, redacted outbox); **Employee reservations & equipment requests** (#67: Reserve vs Request equipment, one Requests screen, 48-hour priority hold, PostgreSQL 005); **Google authentication revision and password visibility** (#68: identity by Google, access by existing logins, no auto-creation, show/hide toggle).

---

## Technical debt

Only items that are still true. Resolved debt lives in PROJECT_HISTORY.md.

**Infrastructure / ops**
- Admin check-out and completion of its request are not atomic (D-48 point 8); correct before production.
- The waitlist sweep (60 s) and login rate limiting are in-process: fine for one instance; need a lock/job runner/shared store before multi-instance.
- "Today" is the server's **UTC** date everywhere (calendar, reservations, overdue, holds); hold deadlines in emails use `APP_TIMEZONE`.
- Temporary SQLite/PostgreSQL duplication (`src/pg/*` twins) and the `DB_DRIVER` seam (`src/dataSeam/`, 71 routes): removed in their own slice, not a dual-database architecture; do not build features on the seam.
- Google Workspace SMTP with an App Password is the only mail transport.
- A possible midnight fragility in `test/partial-fulfillment.test.js` (unverified; may be a fake-clock artifact).
- `GET /health` has no database ping (deliberate since #28).

**Reservations / waitlist / email**
- Reservation times are wall-clock in `APP_TIMEZONE`, compared as strings; "today" and the past-start check stay date-level; the checkout email prints `due_time` as raw `HH:MM`.
- A waitlisted piece is split only when time frees; the response window is global; the checkout form's due time is a native time input.
- No maximum reservation length or advance limit; a reservation does not convert to a checkout; a late return against a following reservation is not handled.
- Turning `available_to_request` off leaves confirmed reservations in place.
- Category/all-equipment calendars count held days as reserved but do not list waitlists.
- No pre-expiry hold reminder; no email when IT removes someone from a waitlist.
- CSV import/export do not carry the two reservation settings (imports default OFF).

**Catalog / search / data**
- No audit trail for catalog edits; alphabetical order only; `settings.categories` is dead data; asset `category` text is free text for assets with no catalog link.
- Search is `LIKE`-based (ASCII case-insensitive), no ranking.
- Multi-seat licenses with a permanent seat drop out of the admin broad-calendar pool; a >1000-asset scope is flagged truncated; past days are not shown on calendars.
- Location and category stay free text; legacy column names (`requests.user_id`, `activity.subject_user_id`, `tokens.user_id`); no tag-vs-serial collision check; no unarchive endpoint; no FK on `assets.cover_photo_id`.
- Production tag prefix/format undecided (prefixes with digits make legacy-tag inference ambiguous).

**Requests / UI**
- Request detail is a sheet, not a routable page; the state filter is client-side over a 500-row list; an IT-created return request starts as *Submitted*; three similar return routes are kept for compatibility; issue duplicate detection is exact-text only.
- An employee's open request for equipment that later becomes unavailable shows the name but cannot open the asset; Employee History has no filters/pagination beyond a 200-row window; the scanner overlay is not closed by route changes.
- Client-side sheet/date-picker logic has no DOM test harness (decisions are server-side and tested; rendering is browser QA only).

---

## Current product rules

Short and authoritative. The reasoning is in [PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) (ids in brackets).

**Repository and process**
- `stage` is the integration/default branch; `main` is release/stable; feature branches → `stage` → `main`. [D-02]
- Seeding and tests must **never** send external email, whatever SMTP variables are configured (`NC_NO_EXTERNAL_MAIL=1`). [D-39]
- Real mailbox credentials are **deployment secrets** (`.env` locally, Railway variables) and never go in the database or settings UI. Google Workspace OAuth is the planned replacement. [D-35, D-37]
- `MAIL_TEST_RECIPIENT` is a server-env-only dev redirect (fails closed); unset in production. The Outbox is a debug record, not proof of delivery. [D-38]
- IT email identity = display name + contact (Reply-To); From stays the verified sender unless `MAIL_ALLOW_IT_FROM=1`. [D-36]

**People, equipment, history**
- Employee/person records are independent of login accounts; an employee may never log in; an admin is a role on a person. [D-13]
- Assets are **archived, not destructively deleted**; history foreign keys are RESTRICT; requests snapshot their wording. [D-14]
- **Permanent assignments are admin-controlled** (server-enforced); employees ask via a request. A temporary checkout needs a return date. One active assignment per employee+asset. [D-15]
- **Self-checkout is a per-employee permission** (admin-granted; **default OFF for every new employee** since migration 19 / PostgreSQL 003; originally default ON, superseded); there is no global toggle. [D-16]
- Serial numbers are unique across the whole inventory (archived included), compared trimmed + case-insensitive; blank or `N/A` = no serial. Tags are monotonic, never reused, immutable. [D-17, D-18]
- Request lifecycle is derived from status + `opened_at`; an employee may rescind only until IT has opened it. [D-20]
- Employees see only their own data; the employee directory is admin-only; an employee may edit their own profile fields; an asset page is visible only if it is theirs or available + shared. [D-21]

**Catalog, search, discovery**
- The catalog is one generic tree; a node is live only if it and its ancestors are active; only live nodes reach employees. [D-23]
- `available_to_request` (default OFF) controls whether an asset is in the shared employee pool at all. [D-27]
- **Temporary availability must not remove otherwise-requestable equipment from search/discovery**: checked-out, reserved or held shared assets stay in Browse with their state and open their calendar; `available_to_request` OFF, archived, permanently assigned and the employee's own equipment stay out. [D-41]
- Search is token-wise over name/brand/model/category/tag/serial/location/catalog path/inherited **Search keywords**; holder names are IT-only. [D-40]

**Reservations and waitlist**
- **A ready equipment request holds its unit for its requester for 48 hours**: nobody else may reserve it (waitlist only) or check it out, IT included; it never overrides an existing reservation or checkout, is not a checkout / assignment / reservation, and expires or is declined back to the pool. A permanent assignment (approved separately by IT) is delivered, never held. [docs/briefs/employee-reservations-requests.md]
- Reservations are for **specific physical assets**, date-based and inclusive, with **optional, independent pickup/return times** (blank = the whole first/last day; half-open); times are `HH:MM` wall-clock in `APP_TIMEZONE`. Approval is **per asset** (default OFF); reserving needs no self-checkout permission. [D-27, D-33]
- **Unavailable time is waitlist time; there is no "Reserve anyway".** One requested range is **split**: the free part is reserved, the unavailable part is waitlisted, linked by `request_group`. **Waitlist entries are demand, not possession.** Approval is refused if the time was taken meanwhile. "Check out now" / scan checkout into someone else's confirmed reservation **or active waitlist hold** is refused (the hold owner's own checkout accepts the offer). No admin override. [D-45]
- The **waitlist is FIFO with time-limited offers/holds** (more than 24 h away: 24 h; 4–24 h: 2 h; under 4 h or started: 30 min; never outlives the offered interval); it **never auto-reserves**; confirming applies the normal reservation rules; expiry/decline/leave/removal pass the offer on. [D-28, D-45]
- **There is no release-request workflow.** [D-29] The blocking reserver gets an **informational email only**. [D-30] Employees can **edit waitlist dates but lose their queue position**; IT can remove an entry but never reorder or answer for an employee. [D-31, D-32]

**Navigation and UI**
- Contextually entered screens show a URL-backed Back link to their source (`from=` / `src=`), preserved through nested navigation; none when opened from the screen's own root. [D-42]
- Mobile shell: five bottom tabs for both roles; hamburger/drawer is admin-only. [D-43]
- Admin authorization is enforced by the backend, never by hostname or client state. [D-08, D-21]

---

## Open decisions

- Production domain: parent domain, admin subdomain and employee subdomain (TBD) — **launch blocker**.
- Production sending mailbox (shared IT mailbox vs individual identities), settled together with the Google Workspace OAuth work — **launch blocker**.
- **When to promote `stage` → `main`** — a deliberate release decision; `stage` being ahead is not itself a reason.
- Production asset-tag prefix/format (avoid digits in the prefix).
- Barcode label dimensions/printer; whether QR is needed alongside Code 128.
- Authentication provider for production beyond Google (magic-link fallback; when to retire the password login).
- Inventory / cycle-count V1 scope; paired-phone-scanner scope.
- Resolved: managed-PostgreSQL host (Railway, D-46); object-storage provider (Railway S3-compatible bucket); Railway access (confirmed).

---

## References

- [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md) — archive: original audit, Phase 0/1/2 slice reports, QA rounds, migrations, test-count evolution, and (Appendix C) the retired pause checkpoint, PostgreSQL slice entries and Slice 5 carry-overs
- [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) — durable decisions and superseded ones (`D-nn`)
- [docs/DATA_MODEL_PHASE_1.md](docs/DATA_MODEL_PHASE_1.md) — Phase 1 data-model design (as-built notes in PROJECT_HISTORY.md §11)
- [docs/briefs/](docs/briefs/) — per-slice briefs (PostgreSQL slices, Google sign-in, labels and assets)
- [README.md](README.md) — setup, running locally, email/SMTP configuration, seeding, testing on a real phone
- [.env.example](.env.example) — every environment variable
