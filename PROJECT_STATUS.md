# NC IT Inventory Tracker — Project Status

**Canonical tracker — keep it short.** Current state, next work and the rules future work must respect. Completed-slice implementation and QA reports live in [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md); the reasoning behind each durable decision (including superseded ones) is in [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md). Where they disagree, **this file wins**.

> **Agent guidance:** Read this file first. `docs/PROJECT_HISTORY.md` and `docs/PROJECT_DECISIONS.md` are reference material and should only be opened when historical context or decision rationale is needed.

**Last updated:** 2026-10-14 (PostgreSQL migration Slice 4B merged into `integration/postgresql` (#33, `1a50069`; commit `ac35778`); Slice 4C built: the waitlist actions, per-asset sweep and claim-based hold-email dispatch as parallel PG modules under `src/pg/`, unused by the app, which still runs on SQLite)

---

## Snapshot

| | |
|---|---|
| **Project status** | Early MVP / prototype. **Staging is deployed on Railway** (SQLite on a `/data` Volume). Railway PostgreSQL and the S3-compatible bucket are provisioned but **UNUSED**. No production environment yet. |
| **Current phase** | Phase 2 — Employee Portal V1 (built on the existing SQLite app; feature-complete through Slice 8.1 and the role-aware shell label) |
| **Active slice** | PostgreSQL migration, Slice 4C (for the temporary `integration/postgresql` branch): the waitlist actions in `src/pg/waitlist.js` (`join`, `updateDates`, `confirmHold`, `declineHold`, `leave`), `processDue` / `sweep` as one transaction per asset, and the claim-based, at-most-once hold-email dispatch (`dispatchHoldEmails`, `hold_email` effect, `emit` / `hasNotifier` in `src/pg/effects.js`), next to the untouched SQLite originals; differential tests and race tests checked against every serial SQLite order. Nothing in the app imports them; it still runs on SQLite. Awaiting review. |
| **Next slice** | PostgreSQL migration Slice 5 (`server.js` routes incl. sessions, the PG mailer behind the notifier, the sweep timer), on `integration/postgresql` (D-46, D-47). Slice 5 carry-overs are recorded in the migration plan below |
| **Canonical branch** | `stage` (shared integration + GitHub default). `main` is the stable/release branch. |
| **`main` vs `stage`** | Workflow is `feature/*` → `stage` → `main`. `main` was last updated 2026-09-28 (`fcbff1d`) and `stage` is well ahead, but that does **not** by itself mean a promotion is due: promoting is a deliberate release/staging decision (an **Open Decision**, below). |
| **Tests** | **550 tests** (`npm test` without PostgreSQL: the 21 PostgreSQL suites are skipped with a message; the two no-SQLite checks need no database and always run) · **708** with the local database up (`npm run db:up`). `npm run test:pg` runs only the 172 tests under `test/pg/` and **fails** if PostgreSQL is unavailable. The 3 time-sensitive hold-expiry tests in `test/partial-fulfillment.test.js` remain a **known flake** (a hold reads back as `expired` depending on when the suite runs; see Technical Debt); all passed on 2026-10-14. |
| **Schema** | **Migration 17** (optional `start_time` / `end_time` and a `request_group` link on `reservations` and `waitlist_entries`). Migrations 1–17 are in `src/migrations.js`. |
| **Stack** | Node.js ≥ 20.12 · Express 5 · SQLite (`better-sqlite3`) · vanilla-JS front end (no build step) · nodemailer SMTP · local-disk photos · Docker · PWA manifest/service worker |
| **Production** | None yet. A Railway **staging** service runs from `stage` (SQLite on `/data`). Railway PostgreSQL and object storage are provisioned, **not connected to the app**; no production Railway project or production auth yet (see Priority Future Work) |

**Verify any change with:** `npm test` · `npm run seed:verify` · `node --check public/app.js` (PostgreSQL work also: `npm run db:up` then `npm run test:pg`)
(`npm run seed:dev` rebuilds `./data-dev` — use `seed:verify` while a dev server has that DB open. Both seed commands, and `npm test`, never send real email.)

---

## Workflow

- [x] `PROJECT_STATUS.md` is the canonical tracker; every meaningful slice updates it before completion (keep reports short here, detail goes to PROJECT_HISTORY.md).
- [x] Branches: feature/chore/docs branch **from `stage` → PR into `stage`**. Never merge straight to `main`; promotion `stage` → `main` is a separate, deliberate release decision. (No CI or branch protection yet: future engineering work, see Priority Future Work.)
- [x] **PostgreSQL integration-branch rule (D-46):** small, safe prep slices go `feature/*` → `stage` as usual. Conversion work that cannot deploy in pieces goes on a temporary `integration/postgresql` branch, kept synced with `stage`; incomplete conversion code **never** merges to `stage`, and nothing merges straight to `main`. Any PR to `stage` that touches the database layer (`src/db.js`, `src/migrations.js`, SQL in routes/modules) must be flagged to teammates.
- [x] **Until the PostgreSQL cutover, mirror logic changes (D-46, Slices 3–4):** any change to `settings` (`src/db.js` defaults/getSettings/setSetting), `src/catalog.js`, `src/requests.js`, `src/assignments.js`, `src/availability.js`, `src/reservations.js` or `src/waitlist.js` logic must be mirrored in the matching `src/pg/` module (and its `test/pg/` tests), and a PR to `stage` touching them must be flagged. The duplication ends at cutover, when the SQLite originals are deleted.
- [x] Roles: ChatGPT plans/reviews; **Claude Code is the default implementer** (inspection, code, tests, migrations, tracker updates); Codex is a secondary implementer/reviewer.
- [x] One focused slice at a time, with scope, acceptance criteria, automated verification, manual verification and a final report. Do not combine unrelated features.
- [x] Dummy/non-sensitive data until verified (seed users use `example.com`). No production infrastructure or data changes without explicit approval.
- [x] Scanner functionality is verified on real devices, not assumed from desktop testing.
- [x] Prefer incremental change over a rewrite; preserve historical equipment records.

---

## Completed Major Work

Merged into `stage` (PR numbers from the repository history). Detail: [PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md).

**Foundation**
- [x] Phase 0 — local baseline, deterministic dev seed (`npm run seed:dev`), golden-workflow test, scanner software/desktop QA (#1–#3)
- [x] Railway-first, provider-neutral architecture decision docs (#4)
- [x] Phase 1 — Data Model Hardening (#5–#11): migration runner; archive instead of delete; durable monotonic tags; `employees` / `accounts` split; assignment type (permanent vs temporary checkout), transactional seat capacity, RESTRICT history FKs; per-employee self-checkout; serial normalization + uniqueness; request-state integrity (migrations 1–9)

**Phase 2 — Employee Portal V1**
- [x] Slice 1 — Employee access contract + read experience (#12)
- [x] Slice 2 — Employee actions: request return, report issue (#13, migration 10) · `seed:verify` isolated verification (#14)
- [x] Slice 3 — Hierarchical equipment catalog + specific-asset requests (#15, migration 11)
- [x] Slice 4 — Mobile shell + responsive navigation (#16) — real-iPhone QA passed
- [x] Slice 5 — Admin request workflow: derived lifecycle, `opened_at`, rescind-until-opened (#17, migration 12)
- [x] Slice 6 / 6.1 — Availability calendar (read-only) and scope refinement (#18, #19)
- [x] Slice 7 — Asset reservations V1: per-asset settings, approval, shorten, calendar discovery (#20, migration 13)
- [x] Slice 8 — Waitlist + 24-hour availability holds + targeted emails; employee Edit dates; admin waitlist view/badges; reserved-date sheet; shorten calendar; IT email identity; `MAIL_TEST_RECIPIENT`; seed/test email suppression; contextual Settings → Catalog Back (#21, migrations 14–15)
- [x] Search + discoverability — token search incl. catalog path and inherited Search keywords; catalog search; temporarily unavailable assets stay discoverable (#22, migration 16)
- [x] Documentation cleanup — concise tracker + history archive + decision log (#23)
- [x] Slice 8.1 — optional pickup/return times, partial-day calendar, unavailable time waitlisted + split requests (#24, migration 17)
- [x] Role-aware shell label (D-44) — top-bar subtitle "IT Admin" for admins, "Employee Portal" for everyone else (`feature/role-aware-shell-label`)

---

## Active Work

- [x] **Slice 8.1** — merged into `stage` (#24). Still needs real-device QA (below).
- [x] **PostgreSQL migration Slice 2 (foundation)** — merged into `integration/postgresql` (#30, `64c2aa0`). Detail: PROJECT_HISTORY.md.
- [x] **PostgreSQL migration Slice 3 (settings, catalog, requests, assignments as parallel PG modules)** — merged into `integration/postgresql` (#31, `c55f149`). Detail: PROJECT_HISTORY.md.
- [x] **PostgreSQL migration Slice 4A (availability + read side of reservations/waitlist)** — merged into `integration/postgresql` (#32, `66c562c`). Detail: PROJECT_HISTORY.md.
- [x] **PostgreSQL migration Slice 4B (reservation writes, queue engine, after-commit effects, concurrency)** — merged into `integration/postgresql` (#33, `1a50069`; commit `ac35778`). Detail: PROJECT_HISTORY.md.
- [ ] **PostgreSQL migration Slice 4C (waitlist actions, per-asset sweep, claim-based hold email, remaining concurrency)** — built on `feature/pg-slice-4c-waitlist-actions`, PR into `integration/postgresql` (never `stage`). Awaiting review. Brief: `docs/briefs/postgresql-slice-4c-waitlist-actions.md`; detail: PROJECT_HISTORY.md.

---

## Next

PostgreSQL migration Slice 5 (`server.js` routes incl. sessions on PostgreSQL, the PG mailer installed behind the effects notifier, the sweep timer; carry-overs (a)–(n) in the migration plan below) on `integration/postgresql`, after 4C is reviewed and merged (D-46, D-47). Other candidates are under Priority Future Work. Slice 8.1 follow-ups (past-time checks, edit/extend of reservations) are listed there and under Technical Debt.

---

## Priority Future Work

### Priority
- [ ] **Google Workspace OAuth email connection — PRIORITY.** *Current state:* **Google Workspace SMTP (App Password, configured through env vars / secrets) is the working transport today** and the only one in use. *Direction:* Admin Settings → Email → *Connect Google Workspace*, so an admin can authorize/change the sending mailbox **without manual `.env` / Railway-secret changes**; **no Google passwords stored by the app**; individual IT/admin identities stay individual employee/account identities (audit logs, personal notifications); the shared IT mailbox stays the operational sending/reply identity where appropriate. (Resend / Postmark were only early alternative-provider ideas and are **not** planned; see D-35.)

### Product / workflow
- [ ] Admin employee/equipment **roster + CSV export** (data model already supports it; permanent vs temporary clearly separated)
- [ ] **Max temporary-checkout / reservation policy** (per-asset maximum duration, maximum advance booking; none enforced today beyond end ≤ 2100)
- [ ] Reservation follow-ups: admin-created / extended / moved reservations; late return against the next reservation; reservation → checkout conversion and no-show expiry; recurring reservations; time-of-day-aware "not in the past" checks (needs an `APP_TIMEZONE`-aware "now")
- [ ] **Per-asset waitlist response policy** (Admin asset settings): *Fast turnover* / *Standard* / *Extended*. Standard = the global 24 h / 2 h / 30 min tiers already built (D-45); the other two are not designed. Not started.
- [ ] Admin **defaults for new assets** (`available_to_request`, approval) by category / catalog node
- [ ] More notifications, kept targeted: pre-expiry hold reminder; email the employee when IT removes them from a waitlist; email IT for a pending approval; email the employee on approve/decline/cancel (including reasons); issue-resolution / request-response emails; email IT when an employee starts a return request; overdue notices beyond the existing date-based sweep; an employee note when submitting a request or reservation
- [ ] Physical **inventory audits / cycle counts** (start session → select location → scan → reconcile → review exceptions)
- [ ] Catalog housekeeping: audit trail for catalog edits; bulk "map many assets to a node"; CSV import/export carrying the reservation settings

### Backlog — low priority / exploratory (not planned next work)
Kept so the ideas are not lost; none is scheduled and none has a design.
- [ ] Catalog/Browse desktop **Grid / List / Columns** views (presentation only)
- [ ] **Paired-phone scanner** concept (a phone as a wireless scanner for a desktop/kiosk session)
- [ ] Split `available_to_request` into separate **visibility** and **requestability** controls (today one flag does both)
- [ ] Catalog drag-to-reorder (alphabetical today)
- [ ] Search extras: fuzzy/typo tolerance and ranking, match highlighting, keywords on individual assets, `seed:dev` default keywords

### Infrastructure (PostgreSQL migration in progress, see the plan below)
- [ ] **Managed PostgreSQL** (Railway): **provisioned, not connected.** Decisions are recorded in D-46. Work: schema conversion, constraints/indexes/FKs, replace `better-sqlite3` access, preserve API behavior, verify migration, **tested backup/restore**. Notes carried from Phase 1: re-express TEXT-timestamp CHECKs on real timestamps (D-46 keeps TEXT timestamps initially), `AUTOINCREMENT` → identity, run migrations 8–9 pre-checks read-only against exported production data before cutover.
  - **PostgreSQL migration plan** (decisions: D-46; local database: `npm run db:up`, PostgreSQL 18): (1) prep and tooling, **done** (#29); (2) foundation: pool, transaction and asset-lock helpers, baseline schema, per-file test database harness, **done** (merged into `integration/postgresql`, #30); (3) settings, catalog, requests and assignments as parallel PG modules (`src/pg/`, `test/pg/`), **done** (merged into `integration/postgresql`, #31); (4) split into **4A** availability + the read side of reservations/waitlist (**done**, merged into `integration/postgresql`, #32), **4B** reservation writes + queue engine + after-commit effects + concurrency (**done**, merged into `integration/postgresql`, #33), **4C** waitlist actions + sweep + hold email + remaining concurrency (**built, awaiting review**) (D-47); (5) `server.js` routes incl. sessions; (6) seeds and remaining tests; (7) staging cutover with tested backup/restore.
  - **For Slice 5** (recorded in Slice 3): `server.js` sites that rely on SQLite case rules must become `lower(col) = lower($1)` (idiom fixed by `test/pg/pg-case-insensitive.test.js`) or an explicit collation: login lookups on `accounts.login_email` (L265, L306); people create/update email-exists checks on `employees.work_email` / `accounts.login_email` (L341–342, L362–363, L400–402); scan lookup `assets.tag = ? COLLATE NOCASE` (L508); `ORDER BY p.name COLLATE NOCASE` (L331); (`availability.js` `ORDER BY a.name COLLATE NOCASE` (L145) is done in Slice 4A as `lower(a.name), lower(a.tag)`). Also decide in Slice 5: the asset tag counter (`asset_tag_counter`), and whether the admin check-out and the completion of its request (today outside the assignment transaction, existing debt) run in one `withTransaction` (`src/pg/assignments.createAssignment` joins a caller's transaction when given its client). Pool sizing: a `createAssignment` waiting on a busy asset holds a pool connection (max 10), see PROJECT_HISTORY.md.
  - **For Slice 5** (recorded in Slice 4A): (a) the PG mailer must preserve D-35–D-39 (`NC_NO_EXTERNAL_MAIL`, fail-closed `MAIL_TEST_RECIPIENT`, From/Reply-To/`MAIL_ALLOW_IT_FROM`, outbox record) and be injected into the 4B/4C notifier seam (D-47); (b) the check-in route (`server.js` ~L700–715) must `lockAsset` first, before touching assignments and before `evaluateAsset`; every route that writes assignments, reservations or waitlist rows locks the asset first; (c) wire the waitlist sweep timer (~L1441) to the per-asset PG sweep; (d) `lock_timeout` and pool sizing (a transaction waiting on an asset lock holds one of the 10 pool connections); (e) routes keep their authorization (admin-only approve/decline; Reserve needs no self-checkout permission).
  - **For Slice 5** (recorded in Slice 4B): (f) install the notifier at startup (`setNotifier` in `src/pg/effects.js`), mapping `request_recorded` / `waitlist_joined` to the PG mailer (D-35–D-39) and `holds_owed` to the 4C `dispatchHoldEmails`; (g) check-in must `lockAsset` and then call `evaluateAsset` on the same transaction client (the `ASSET_LOCK_REQUIRED` guard enforces it); (h) a route that joins the reservation write functions to its own transaction must not read or write that asset's dependent rows before calling them (they take the asset lock themselves, first).
  - **For Slice 5** (recorded in Slice 4C): (i) the notifier installed with `setNotifier` maps `request_recorded` and `waitlist_joined` (incl. its optional `updated` flag, the "changed their waitlist request" wording) to the PG mailer, `holds_owed` to `waitlist.dispatchHoldEmails(pool)`, and `hold_email { entry }` to the PG mailer's `waitlistHold` (D-35–D-39); with no notifier installed nothing is claimed (D4C-2); (j) a single-flight guard for the 60-second sweep timer (a sweep still running when the next tick fires must not start a second one); (k) `lock_timeout` and pool sizing (each request-path action uses two short transactions: the asset's due step, then the action); (l) `server.js` calls the PG request-path functions (`join`, `updateDates`, `confirmHold`, `declineHold`, `leave`, and the 4B writes) with the pool and without reading that asset's dependent rows first; (m) check-in = `lockAsset` + `evaluateAsset` on one transaction client; (n) the cutover moves the shared pure helpers listed in the 4B report (`src/reservations.js` / `src/waitlist.js` / `src/availability.js` / `src/timeRange.js` exports used by `src/pg/*`) into `src/pg/`.
- [ ] **Object storage** (*bucket provisioned, not connected*; S3-compatible, private bucket; file naming + access policies; preserve thumbnails and cover photo; test mobile upload and image replacement/removal)
- [ ] **Production authentication** (provider TBD; Google sign-in + magic-link fallback; pre-provisioned employees only; define the authentication model and admin/employee authorization strategy; secure sessions; replace custom password/reset/invite flows; shared login rate limiting; test admin and standard-user permissions)
- [ ] **Railway staging** (*foundation begun 2026-10-13:* staging service exists with a Volume mounted at `/data`; first build failed on the Dockerfile `VOLUME` instruction, removed; second build reached `npm ci` and failed compiling `better-sqlite3` because the slim image lacked native build tools, so `python3`/`make`/`g++` are now installed before `npm ci`). **Staging is now deployed successfully** from the `stage` branch; the generated Railway HTTPS domain works (`APP_URL` set); SQLite persistence on the `/data` Volume (accounts + sessions) was verified across a redeploy. `GET /health` merged (#28) and the Railway health-check path is configured and verified. Still open: SMTP/production sending mailbox (see the email item above), custom domain, logs review, restart behavior. PostgreSQL, object storage and production readiness are **not** done and the app still uses SQLite
- [ ] **Production readiness**: security review, DB + storage backup strategy, restore procedure, error monitoring, audit logging, production admin accounts, real inventory import plan, final staging acceptance test, deployment, initial import
- [ ] **CI** (none configured; no branch protection): automated build + test verification. Future engineering work to address **before production/release maturity**; it is *not* a blocker for Slice 8.1 or day-to-day development.

---

## Blockers / External Dependencies

**There is no active blocker.** These are external dependencies that matter only when the matching task starts:

- [x] **Railway account/project access** — *available as of 2026-10-13* (staging service created, Volume mounted at `/data`). Previously recorded 2026-09-28 as no access.
- [ ] **HTTPS-accessible environment** — needed only for real phone-camera scanner QA (camera access requires HTTPS).
- [ ] **Physical scanner hardware** — USB / Bluetooth scanners exist at the company but were not on hand at the campus used for QA.

Email is not a blocker: Google Workspace SMTP works today (owner-confirmed real Gmail delivery in development); the OAuth connection is a priority improvement, not a prerequisite.

---

## Technical Debt

Only items that are still true. Resolved debt lives in PROJECT_HISTORY.md.

**Infrastructure / ops**
- [ ] Waitlist sweep (60 s timer) and login rate limiting are in-process memory: fine for one instance, need a lock/job runner/shared store before multi-instance deployment
- [ ] "Today" is the server's **UTC** date everywhere (calendar, reservations, overdue, holds); a late-evening local time can be a day off. Hold deadlines in emails use `APP_TIMEZONE` or the server zone
- [ ] Asset photos are served from local disk; the dev server must be restarted to pick up a new migration unless `npm run dev` (file watcher) is used
- [ ] Google Workspace SMTP with an App Password is the only mail transport (no password-less IP relay); mailbox credentials are changed by editing env vars / secrets until the OAuth connection exists
- [ ] **Temporary SQLite/PostgreSQL duplication (until cutover):** `src/pg/settings.js`, `catalog.js`, `requests.js`, `assignments.js`, `availability.js`, `reservations.js` and `waitlist.js` mirror the SQLite logic (see the Workflow rule); `src/pg/*` imports the pure helpers of `src/catalog.js`, `src/requests.js`, `src/assignments.js`, `src/availability.js`, `src/reservations.js`, `src/waitlist.js` and `src/timeRange.js`, which move into `src/pg/` at cutover
- [ ] **3 time-dependent hold-expiry tests are unreliable** in `test/partial-fulfillment.test.js` (a hold reads back as `expired`). On 2026-10-07 the suite was 531 total / 528 passing / 3 failing, and the same 3 failed on a clean `stage`; on 2026-10-13 (15:20 MDT) two runs passed 531/531. The result depends on when the suite runs, so do not treat a pass or a fail as meaningful until this is investigated. Not fixed in the D-44 slice

**Reservations / waitlist / email**
- [ ] Reservation times are wall-clock in `APP_TIMEZONE` and compared as strings; "today" and the past-start check stay date-level (a pickup time earlier today is accepted). The checkout email still prints its `due_time` as raw `HH:MM`
- [ ] A waitlisted piece is split by `splitFree` only when time frees; the response window is global (per-asset policy is future work above). The checkout form's due time is still a native time input, unlike the reservation sheets. Local DBs that applied the earlier migration 17 (e.g. `./data-dev`) need `npm run seed:dev`
- [ ] No maximum reservation length or advance limit; a reservation does not convert to the checkout; a late return against a following reservation is not handled
- [ ] Turning `available_to_request` off leaves existing confirmed reservations in place (IT cancels them if wanted)
- [ ] Category / all-equipment calendars count held days as reserved but do not list waitlists; catalog card counts say "N available" (available now) while the Browse list can show more rows
- [ ] No pre-expiry hold reminder; no email when IT removes someone from a waitlist
- [ ] CSV import/export do not carry the two reservation settings (imports default OFF)

**Catalog / search / data**
- [ ] No audit trail for catalog edits; alphabetical order only; `settings.categories` is dead data kept for compatibility; asset `category` text is free text for assets with no catalog link
- [ ] Search matching is SQLite `LIKE` (ASCII case-insensitive), no ranking
- [ ] Multi-seat licenses with a permanent seat drop out of the admin broad calendar pool; a >1000-asset scope is flagged truncated but shown only as "+"; past days are not shown on calendars
- [ ] Location and category stay **free text** (no normalization or validation against a list); deliberately deferred past Phase 1
- [ ] Tag-correction workflow; category/location length limits; legacy column names (`requests.user_id`, `activity.subject_user_id`, `tokens.user_id`); no tag-vs-serial collision check; no archived-assets UI / unarchive endpoint; no FK on `assets.cover_photo_id`
- [ ] Production tag prefix/format undecided (prefixes containing digits make legacy-tag inference ambiguous)

**Requests / UI**
- [ ] Request detail is a sheet, not a routable page; the state filter is client-side over a 500-row list; an IT-created return request starts as *Submitted*; `request-return` / `return-notice` / `my-return-request` are three similar routes kept for compatibility; issue duplicate detection is exact-text only; the admin direct check-out completes its request outside the assignment transaction
- [ ] An employee's open request for equipment that later becomes unavailable shows the name but cannot open the asset; Employee History has no filters or pagination beyond a 200-row window; the scanner overlay is not closed by route changes
- [ ] Client-side sheet/date-picker logic has no DOM test harness (the *decisions* it shows are server-side and tested; rendering is browser-QA only)

---

## Current Product Rules

Short and authoritative. The reasoning is in [PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) (ids in brackets).

**Repository and process**
- `stage` is the integration/default branch; `main` is release/stable; feature branches → `stage` → `main`. [D-02]
- Seeding and tests must **never** send external email, whatever SMTP variables are configured (`NC_NO_EXTERNAL_MAIL=1`). [D-39]
- Real mailbox credentials are **deployment secrets** (`.env` locally, Railway secrets later) and never go in the database or settings UI. Google Workspace OAuth is the planned replacement. [D-35, D-37]
- `MAIL_TEST_RECIPIENT` is a server-env-only dev redirect (fails closed); unset in production. The Outbox is a debug record, not proof of delivery. [D-38]
- IT email identity = display name + contact (Reply-To); From stays the verified sender unless `MAIL_ALLOW_IT_FROM=1`. [D-36]

**People, equipment, history**
- Employee/person records are independent of login accounts; an employee may never log in; an admin is a role on a person. [D-13]
- Assets are **archived, not destructively deleted**; history foreign keys are RESTRICT; requests snapshot their wording. [D-14]
- **Permanent assignments are admin-controlled** (server-enforced); employees ask via a request. A temporary checkout needs a return date. One active assignment per employee+asset. [D-15]
- **Self-checkout is a per-employee permission** (default ON, admin-revocable); there is no global toggle. [D-16]
- Serial numbers are unique across the whole inventory (archived included), compared trimmed + case-insensitive; blank or `N/A` = no serial. Tags are monotonic, never reused, immutable. [D-17, D-18]
- Request lifecycle is derived from status + `opened_at`; an employee may rescind only until IT has opened it. [D-20]
- Employees see only their own data; the employee directory is admin-only; the profile is read-only; an asset page is visible only if it is theirs or available + shared. [D-21]

**Catalog, search, discovery**
- The catalog is one generic tree; a node is live only if it and its ancestors are active; only live nodes reach employees. [D-23]
- `available_to_request` (default OFF) controls whether an asset is in the shared employee pool at all. [D-27]
- **Temporary availability must not remove otherwise-requestable equipment from search/discovery**: checked-out, reserved or held shared assets stay in Browse with their state and open their calendar; `available_to_request` OFF, archived, permanently assigned and the employee's own equipment stay out. [D-41]
- Search is token-wise over name/brand/model/category/tag/serial/location/catalog path/inherited **Search keywords** (stored on catalog entries); holder names are IT-only. [D-40]

**Reservations and waitlist**
- Reservations are for **specific physical assets**, date-based and inclusive, with **optional, independent pickup/return times** (blank = the whole first/last day; half-open, so a 1:00 PM return and a 1:00 PM pickup do not overlap); times are `HH:MM` wall-clock in `APP_TIMEZONE`. Approval is **per asset** (default OFF); reserving needs no self-checkout permission. [D-27, D-33]
- **Unavailable time is waitlist time; there is no "Reserve anyway".** Unavailable = a confirmed reservation, an active hold, a waitlist-born pending reservation, or a checkout. One requested range is **split**: the free part is reserved, the unavailable part is waitlisted (all free = reservation only; none free = waitlist only; mixed = both), linked by `request_group`. Adjacent times do not overlap. **Waitlist entries are demand, not possession** and never block anyone. Approval is refused if the time was taken meanwhile. Still refused: ineligible asset/person, invalid/past dates, the same employee double-booking themselves, and "Check out now" / scan checkout into someone else's confirmed reservation **or active waitlist hold** (only the held interval blocks; the hold owner's own checkout accepts the offer and closes the hold). No admin override. [D-45]
- The **waitlist is FIFO with time-limited offers/holds** over the requested dates *and times*; when time frees, each waiting entry is re-split like a new request: the freed part is offered with a **response window set by how soon that part starts** (more than 24 h away: 24 h; 4-24 h: 2 h; under 4 h or already started: 30 min; measured when the offer is made, in `APP_TIMEZONE`; an offer never outlives the end of the offered interval), the rest keeps waiting in the same place in line (every release path incl. an early return re-evaluates); it **never auto-reserves**; confirming applies the normal reservation rules; expiry/decline/leave/removal pass the offer on. A hold is priority for the offer, not a lock. [D-28, D-45]
- **There is no release-request workflow**; nobody can ask or pressure a reserver to give up dates. [D-29]
- The blocking reserver gets an **informational email only** ("no action needed"): no CTA, no nudge to shorten. [D-30]
- Employees can **edit waitlist dates but lose their queue position**; IT can remove an entry but never reorder or answer for an employee. [D-31, D-32]

**Navigation and UI**
- Contextually entered screens show a Back link to their source, URL-backed (`from=` / `src=`) and preserved through nested navigation; no browser-history-only behavior; none when opened from the screen's own root. [D-42]
- Mobile shell: five bottom tabs for both roles; hamburger/drawer is admin-only. [D-43]
- Admin authorization is enforced by the backend, never by hostname or client state. [D-08, D-21]

---

## QA / Verification Outstanding

- [ ] **Real-device QA** (iPhone Safari, Android Chrome, Firefox) of the newer flows: single-asset calendar + reserve/waitlist date sheet **including the Hour : Minutes + AM/PM time control and the split-request notice (Slice 8.1)**, Shorten calendar with a return time, Requests › Reservations, search/Browse rows, **the top bar at 320–375 px ("Employee Portal" / "IT Admin" label)**. Only the Slice 4 mobile shell is real-iPhone verified (Chrome on iPhone)
- [ ] **Scanner hardware QA**: USB scanner, Bluetooth scanner, phone camera over HTTPS (iPhone Safari/PWA, Android Chrome/PWA); barcode matrix (Code 128, QR, Code 39, UPC/EAN, manufacturer serial; small/large/angled/damaged/low-light/glare/duplicate/unknown); failure cases (camera denied/unavailable, unsupported browser, Enter suffix or not, network interruption, rapid duplicate scans)
- [ ] **Real email on the target environment**: Workspace delivery of the waitlist emails, From/Reply-To behavior, and IT-email identity on stage/production (Gmail delivery via `MAIL_TEST_RECIPIENT` was owner-confirmed in dev)
- [ ] No automated scanner integration tests exist beyond the lookup-endpoint and golden-workflow tests (scanning itself is manual/hardware QA)
- [ ] Manual checks never done: asset photo upload on mobile, CSV import/export against a live server, label printer, cross-browser pass
- [ ] Authentication/security testing and backup/restore testing (nothing to test until the infrastructure phases)
- [ ] Railway/staging QA once access exists

---

## Open Decisions

- [x] ~~Managed-PostgreSQL host~~ — resolved 2026-10-14: Railway PostgreSQL is provisioned (D-46)
- [ ] Object-storage provider · **authentication provider (TBD)**
- [ ] Production sending mailbox (shared IT mailbox vs individual identities) — to be settled together with the Google Workspace OAuth work
- [ ] Production domain: parent domain, admin subdomain and employee subdomain (all TBD)
- [ ] Production asset-tag prefix/format (avoid digits in the prefix)
- [ ] Barcode label dimensions/printer; whether QR is needed alongside Code 128
- [ ] Inventory / cycle-count V1 scope; paired-phone-scanner scope
- [ ] **When to promote `stage` → `main`** — a deliberate release/staging decision; the workflow stays `feature/*` → `stage` → `main`, and `stage` being many commits ahead is not itself a reason to promote
- [x] Railway access status — confirmed available 2026-10-13

---

## References

- [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md) — archive: original audit, Phase 0/1/2 slice reports, QA rounds, migrations and test-count evolution
- [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) — durable decisions and superseded ones (`D-nn`)
- [docs/DATA_MODEL_PHASE_1.md](docs/DATA_MODEL_PHASE_1.md) — Phase 1 data-model design (original 1A record; as-built notes are in PROJECT_HISTORY.md §11)
- [README.md](README.md) — setup, running locally, email/SMTP configuration, seeding, testing on a real phone
- [.env.example](.env.example) — every environment variable (SMTP, `MAIL_TEST_RECIPIENT`, `APP_TIMEZONE`, `MAIL_ALLOW_IT_FROM`)
