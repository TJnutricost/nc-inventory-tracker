# NC IT Inventory Tracker — Project History

> **Historical record. [PROJECT_STATUS.md](../PROJECT_STATUS.md) is authoritative for current project state and current product rules.** Where this file disagrees with it, PROJECT_STATUS.md (and the superseded-decision labels in [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md)) win.

This is the archive of everything that used to live in the single, very long `PROJECT_STATUS.md` (until 2026-10-05): the original audit, the phase and slice implementation reports, the QA findings and fixes, and the migration / test-count evolution. It is deliberately detailed. Nothing here is a to-do list.

**Conventions.** Headings keep the original section numbers (e.g. "11. Phase 1 — Data Model Hardening") so cross-references such as "see Section 11a" inside the old text still resolve. Statuses in slice headings were corrected on 2026-10-05 against the merged PR history (every slice below is merged into `stage`). Passages that were later replaced are marked **SUPERSEDED**. Boilerplate repeated in every slice report ("Remains FUTURE…", "Blockers: none…") was removed; the live future-work list is in PROJECT_STATUS.md.

**Not carried over verbatim (they live elsewhere now):** old sections 2–4 (workflow, working rules, branch strategy, stack) → PROJECT_STATUS.md; old 19 (decisions log) → PROJECT_DECISIONS.md; old 20 (open decisions) and 21 (milestone summary) → PROJECT_STATUS.md; the OAuth note, the role-aware label note and Slice 8.1 → PROJECT_STATUS.md.

## At a glance — merged work, migrations and test counts

| Work | PR | Migration | Tests after |
|---|---|---|---|
| Phase 0A–0D baseline, seed, golden workflow, scanner software QA | 0A merged directly; #1–#3 | 1 (baseline) | 55 |
| Railway-first architecture docs | #4 | — | — |
| Phase 1A audit / design | #5 | — | — |
| Phase 1B migration runner + integrity | #6 | 2 | 71 |
| Phase 1C archive, tag counter | #7 | 3, 4 | 89 |
| Phase 1D employees / accounts split (+ login/invite UX fix) | #8, #9 | 5 | 103 |
| Phase 1E assignments + historical integrity (+ QA follow-up) | #10 | 6, 7 | 153 |
| Phase 1 Foundation Closeout (serials, request integrity) | #11 | 8, 9 | 211 |
| Slice 1 Employee Access Contract + Read Experience | #12 | — | 230 |
| Slice 2 Employee Actions (+ `seed:verify` chore) | #13, #14 | 10 | 251 |
| Slice 3 Hierarchical Equipment Catalog | #15 | 11 | 289 |
| Slice 4 Mobile shell + responsive navigation | #16 | — | 291 |
| Slice 5 Admin Request Workflow | #17 | 12 | 321 |
| Slice 6 Availability Calendar (read-only) | #18 | — | 346 |
| Slice 6.1 Calendar scope refinement | #19 | — | 357 |
| Slice 7 Asset Reservations V1 | #20 | 13 | 385 |
| Slice 8 Waitlist + holds + targeted email (+ QA rounds) | #21 | 14, 15 | 434 |
| Search + discoverability | #22 | 16 | 447 |

## 1. Project Overview (original, 2026-09-28)

NC IT Inventory Tracker is an internal asset-management application for tracking company-owned IT equipment and other physical assets.

The system is intended to allow an equipment manager or administrator to:

- Create and maintain a library of company assets.
- Assign categories such as computers, monitors, keyboards, mice, TVs, appliances, photography/video equipment, networking equipment, and similar devices.
- Store asset information including:
  - Asset name
  - Category
  - Internal asset tag / custom barcode
  - Photos
  - Brand
  - Model
  - Serial number
  - Purchase information
  - Warranty information
  - Condition
  - Location
  - Notes
- Scan asset barcodes using (scanner strategy, revised 2026-09-28 — see Section 16 for QA status of each):
  - **Desktop USB barcode scanner** (keyboard-wedge) — implemented, software/desktop behavior verified in Phase 0D.
  - **Desktop Bluetooth barcode scanner** (keyboard-wedge) — implemented, same as above; physical-hardware QA still pending (Phase 0D, future QA).
  - **Manual entry** (typed tag/serial) — implemented and verified.
  - **Native phone-camera scanner** — implemented in the current admin app (`html5-qrcode`); real-device QA pending a secure HTTPS-accessible environment (Section 14a).
  - **Paired phone scanner (future concept)** — a phone acts as a dedicated wireless scanner input for a desktop/kiosk session (e.g. scanning on a paired phone feeds tag/serial values into an admin session running elsewhere), as a lower-friction alternative to a dedicated USB/Bluetooth scanner for staff without one. Not designed or implemented yet — noted here as a future direction alongside Employee Portal V1 (Section 8a), not committed scope.
- Assign equipment to employees.
- Check equipment back in.
- Maintain assignment and activity history.
- Track asset lifecycle/status.
- Import and export inventory data.
- Eventually perform physical inventory audits/cycle counts.

The intended production architecture is currently **Railway-first and provider-neutral where possible** (revised 2026-09-28 — see Section 19 Decisions Log; Supabase is no longer assumed):

**Browser / PWA → Railway-hosted application → managed PostgreSQL → object storage**

- **Application hosting:** Railway.
- **Database:** a managed PostgreSQL instance. **Railway PostgreSQL is the current preferred host**, but the data layer/migration work (Phase 2) is being described and built provider-neutrally, not tied to a specific vendor's client SDK or proprietary features.
- **Object/photo storage:** an S3-compatible object storage service. **Railway object storage (or another S3-compatible provider) is the current preferred direction**, described provider-neutrally for the same reason.
- **Authentication:** provider **TBD** (see Section 14 — Phase 4). Not assumed to be any specific vendor's auth product.
- **Authorization:** application/backend-enforced, independent of hosting provider or hostname (see Section 8a for the admin-vs-employee access model this applies to).
- Admin and employee portals (Section 8a) share this same backend, database, and authentication system — there is no separate stack per portal.


## 5. Audit Summary

> *Sections 5–9 are the original 2026-09-28 audit and planning notes. Their "Status" lines describe that moment; most items were later resolved (each entry says so where it was) and what is still open is tracked in [PROJECT_STATUS.md](../PROJECT_STATUS.md).*

The project is significantly more complete than a basic prototype.

The existing application already contains most of the core inventory-management workflows.

### Existing Features

#### Asset Management

- [x] Asset library
- [x] Asset names
- [x] Categories
- [x] Asset tags
- [x] Brand
- [x] Model
- [x] Serial number
- [x] Condition
- [x] Status
- [x] Location
- [x] Purchase information
- [x] Warranty information
- [x] Notes
- [x] Software-license related fields

#### Photos

- [x] Asset photo upload
- [x] Image resizing
- [x] Thumbnail generation
- [x] Cover photo selection

Current implementation uses local filesystem storage.

#### Barcode / Scanner

- [x] Mobile camera scanning implementation
- [x] USB/keyboard-wedge scanner support
- [x] Manual barcode input
- [x] Scan by asset tag
- [x] Scan by serial number
- [x] Unknown barcode → create asset flow
- [x] Barcode label generation
- [x] Code 128 label support

Supported scanning formats include:

- Code 128
- Code 39
- Code 93
- UPC
- EAN
- QR
- Data Matrix
- ITF
- Codabar

Real-device verification is still required.

#### Assignments

- [x] Assign asset to employee/user
- [x] Check asset in
- [x] Assignment history
- [x] Asset status updates
- [x] Return request workflow

#### Equipment Requests

- [x] Equipment request system
- [x] Approval
- [x] Denial
- [x] Dropoff/fulfillment flow

#### Users / Authentication

- [x] Admin role
- [x] Standard user role
- [x] Login
- [x] Invite flow
- [x] Password reset

Current implementation uses custom (bcrypt + session) authentication rather than the eventual shared authentication provider, which is currently TBD (see Section 14).

#### Other Features

- [x] Dashboard
- [x] Activity log
- [x] CSV import
- [x] CSV export
- [x] Email notification logic
- [x] Email fallback/outbox behavior
- [x] PWA manifest
- [x] Service worker
- [x] Docker deployment foundation


## 6. Not Yet Production Ready

> *Superseded by the "Priority Future Work", "Blockers" and "QA / Verification Outstanding" checklists in PROJECT_STATUS.md. Left as recorded on 2026-09-28; note that the CI / repository items were never done (there is no CI configuration in the repo) and the branch strategy item was settled (section 3a, now in PROJECT_STATUS.md and D-02).*

### Infrastructure

- [ ] Managed PostgreSQL project connected (Railway PostgreSQL preferred)
- [ ] PostgreSQL schema created
- [ ] SQLite → PostgreSQL migration completed
- [ ] Object storage integrated (Railway/S3-compatible preferred)
- [ ] Authentication provider integrated (provider TBD — see Section 14)
- [ ] Railway deployment configured
- [ ] Railway health endpoint implemented
- [ ] Production environment variables documented
- [ ] Staging environment established
- [ ] Production environment established

### Testing

- [x] Repeatable dummy-data seed — *`npm run seed:dev` (added 2026-09-28, Phase 0B); see Section 10 for details.*
- [x] Automated test suite — *Correction (Claude Code, 2026-09-28): already exists. `test/` has 5 files / 45 tests via Node's built-in test runner (`npm test`), all passing against the real Express app on a throwaway SQLite DB.*
- [x] API smoke tests — *covered: the suite boots the real app and drives it over HTTP with a cookie-aware client.*
- [x] Assignment lifecycle tests — *covered: `test/requests.test.js` exercises return-request → drop-off → check-in.*
- [ ] Scanner integration tests
- [ ] Mobile camera scanner testing
- [ ] USB barcode scanner testing
- [ ] Bluetooth barcode scanner testing
- [ ] Barcode label printer testing
- [ ] Photo upload testing on mobile
- [ ] Cross-browser verification
- [ ] Authentication/security testing
- [ ] Backup/restore testing

### CI / Repository

- [ ] Git workflow confirmed
- [ ] Canonical development branch confirmed
- [ ] CI checks configured
- [ ] Build verification automated
- [ ] Test verification automated


## 7. Known Issues / Architecture Risks

These were identified during the initial source audit.

### Asset Deletion

**Status:** Resolved in Phase 1C/1E (the text below is the original finding, kept for context). Assets are archived, never deleted; history foreign keys are RESTRICT.

Original finding: hard deletion could cascade-delete historical information such as assignments/activity.

#### Desired behavior

Normal administrative asset removal should use lifecycle states such as:

- Retired
- Disposed
- Archived
- Lost

Historical assignment/activity records should remain available.


### Serial Number Uniqueness

**Status:** Resolved in the Phase 1 Foundation Closeout (migration 8): serials are unique across the whole inventory, archived assets included, ignoring surrounding whitespace and letter case. This **supersedes the Phase 1A "warn + admin override" design** (see Section 11). The text below is the original finding, kept for context.

Original finding: serial numbers can be used by scanner lookup, but database uniqueness was not enforced, so duplicates could make scanner lookup ambiguous.

The final design had to also account for:

- Missing serials
- Generic manufacturer serials
- Invalid serial data
- Reused/duplicate identifiers


### Identifier Model

**Status:** Needs improvement.

An unknown scanned code currently tends to be treated as an asset tag.

Future asset identifiers may need explicit types such as:

- Internal asset tag
- Custom barcode
- Serial number
- Manufacturer barcode
- UPC
- QR identifier
- Other identifier


### Asset Tag Generation

**Status:** Needs hardening.

Current automatic asset-tag generation could produce a race condition if multiple users create equipment simultaneously.

PostgreSQL should generate/reserve identifiers atomically.


### Cover Photo Validation

**Status:** Needs correction.

The cover-photo operation should verify that the selected photo belongs to the asset being modified.


### Employee vs. Login Account

**Status:** Architecture decision required. Direction now formalized in Section 8a (Employee Portal V1) — this entry remains as the original audit note.

Currently user/account concepts are closely tied to equipment assignment.

Recommended future model:

#### Employee / Person
Represents the person who possesses equipment.

#### Login Account
Represents someone who can authenticate into the inventory application.

An employee should not be required to have an application login.

A login may optionally be linked to an employee record.


### Self Checkout

**Status:** Resolved in Phase 1E QA follow-up (2026-09-30): self-checkout is a **per-employee permission, default ON**, revocable by an admin; the former global setting is deprecated and ignored (see the Phase 1E section). Self-checkout is always a temporary checkout; permanent assignments are admin-only.


### Login Rate Limiting

**Status:** Needs production implementation.

Current rate limiting uses application/server memory and will not behave reliably across restarts or multiple server instances.


### Historical Integrity

**Status:** Addressed for Phase 1 (assignments/activity/requests RESTRICT, archive-first, request integrity checks — Phase 1E + Foundation Closeout). Remains a standing principle for every future schema change.

Assignment history, check-in/out history, lifecycle events, and audit records should be treated as durable historical data.

Future schema changes must preserve this principle.


### Assignment Mode + Admin Equipment Roster (approved future requirements, 2026-09-30)

**Status:** Assignment mode is **implemented in Phase 1E** (2026-09-30, see the Phase 1E section). The admin roster is **approved input only — not implemented**; the data model now supports it.

#### Assignment mode — input to Phase 1E (Assignment + Historical Integrity)

The system must distinguish two kinds of current equipment relationship:

1. **Permanent / ongoing assignment** — equipment primarily assigned to an employee for ongoing use: desktop computer, monitor, keyboard, mouse, dock, normal daily-use equipment.
2. **Temporary checkout** — temporary custody for a day, shoot, project or short period: cameras, lenses, lighting, photo/video equipment, TVs, other borrowed equipment.

Rules:

- The distinction belongs to the **assignment**, not permanently to the asset or category.
- Do **not** infer it from category alone; the same type of asset could be permanently assigned in one situation and temporarily checked out in another.
- Historical records must **preserve which mode was used**.
- Likely implementation: an assignment-level field such as `assignment_type` with values conceptually `permanent` / `checkout`. As built in Phase 1E: `assignments.assignment_type` (`permanent` / `checkout`), permanent is admin-only with no due date/time; a checkout requires a return date (`due_date`, optional `due_time`); legacy rows with a due date → `checkout`, otherwise `permanent`.

#### Admin employee/equipment roster — future admin reporting/UI (after the assignment model supports it)

An admin must be able to view a complete employee/equipment roster in a flat, spreadsheet/CSV-like format and ultimately export it to CSV. It should answer: who has what equipment; what is permanently assigned to each employee; what is only temporarily checked out; and which asset tags belong to those items. **Permanent assignments and temporary checkouts must be clearly separated.**

Conceptual columns (exact UI/export columns TBD): Employee, Department, Permanent equipment, Temporary checkouts, Asset tags, Checkout date, Return/due information where applicable.

Placement: the data-model portion (assignment mode) is done in Phase 1E; the report/UI/CSV export is later work that depends on it and is **not implemented**. See `docs/DATA_MODEL_PHASE_1.md` §3.4 and §4a.


## 8. Future Feature: Physical Inventory Audits

Not part of the current MVP implementation.

A future inventory/cycle-count mode should allow an administrator to begin an inventory session and walk through a building scanning assets.

Possible results:

- Found
- Missing
- Unexpected
- Wrong location
- Wrong assignee
- Duplicate scan
- Unknown asset

Potential workflow:

**Start Inventory Session → Select Location → Scan Equipment → Reconcile → Review Exceptions → Close Session**

This should be treated as a separate feature milestone after the core asset-management platform is stable.


## 8a. Future Architecture: Employee Portal V1

**Status (revised 2026-10-02):** Employee Portal V1 is now the **active Phase 2**, built incrementally on the employee interface that already exists inside the app (the employee and admin roles already see different navigation and screens; server-side authorization already exists for admin operations). It is **not** a separate app and the portal architecture is not being rebuilt. Progress and the slice sequence are in Section 11a. The original 2026-09-28 note below (planned *after* the PostgreSQL/auth foundation) is superseded; the shared infrastructure work (PostgreSQL, object storage, auth provider, Railway) is still planned, but later, and is no longer a prerequisite for Employee Portal V1.

### Domain / Application Split

**Revised 2026-09-28** — supersedes the earlier `admin.<domain>` / `<domain>` (root/apex) assumption. Current direction: both portals will likely live on separate subdomains of an **existing hosted parent domain/site**, not on a domain registered specifically for this project, and the employee portal is **not** assumed to live at the apex/root domain.

- **Admin portal:** `<admin-subdomain>.<parent-domain>` — hosts the IT/admin inventory-management application currently being built.
- **Employee portal:** `<employee-subdomain>.<parent-domain>` — a separate, employee-facing web experience (Employee Portal V1).
- Both hostnames are expected to be subdomains of an existing parent domain (not necessarily a new domain purchased for this project).
- Exact parent domain: **TBD**. Exact admin subdomain: **TBD**. Exact employee subdomain: **TBD**. DNS/CNAME/proxy/hosting details: **TBD**. None of this is being configured now (tracked in Section 20, Open Decisions).
- Both applications share the **same** backend, database, authentication system, and inventory data, whichever hosting/provider choices are ultimately made. There is no separate inventory database for the employee app.

**Future-design note — auth across two hostnames:** authentication/session design must support both portal hostnames; do not assume shared browser cookies across the two subdomains. Exact cookie/session/SSO behavior will be decided during Phase 4 (Authentication), not here.

### Employee Portal V1 — Planned Functionality

- Google sign-in
- Email/magic-link sign-in (fallback)
- My Equipment (assets currently assigned to the signed-in employee)
- View basic assignment history (their own)
- Request equipment
- Request return / check-in
- Report an equipment issue
- View their own request statuses
- Profile / account
- Sign out

### Employee vs. Login Account (Phase 1 data-model requirement)

*Duplicate of the section 7 entry and of Phase 1D; the durable rule is D-13 in [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).*

### Access Model (high-level, planning only)

**Admin:**
- Manage assets
- Scan inventory
- Assign / check in equipment
- Manage employees
- Manage requests
- Access administrative history/reporting

**Employee:**
- Access only their own employee/profile data
- Access equipment currently or historically assigned to them, as allowed
- Create/read their own equipment and return requests
- No inventory administration
- No browsing other employees
- No ability to grant themselves admin access

**Important:** admin authorization must be enforced independently of the `<admin-subdomain>.<parent-domain>` hostname — the hostname is a UX/routing convenience, not a security boundary.

### Employee Permission Model (2026-09-28 clarification)

The employee portal is intentionally **read/create oriented**, not general CRUD.

Employees **may**:
- Read their own employee/profile information
- Read equipment currently assigned to them
- Read their own permitted assignment history
- Read their own requests
- Create equipment requests
- Create return/check-in requests
- Create issue/problem reports
- Rescind an eligible request they themselves submitted (see Request Rescind / Opened Rule below)

Employees **may NOT**:
- Edit or delete assets
- Edit or delete assignments
- Reassign equipment
- Browse or edit other employees
- Modify administrative inventory fields
- Change their own role/permissions
- Edit submitted request contents after submission, unless a future explicitly approved workflow is added

"Rescind request" is a narrow workflow action and must **not** be treated as general UPDATE or DELETE permission.

### Request Rescind / Opened Rule (Phase 1 data-model/business-rule requirement, 2026-09-28)

Product rule: **an employee may rescind their own request only if IT has not opened/reviewed it yet.**

Preferred future behavior:
- A new employee request begins in a `submitted` / unopened state.
- The first administrative opening/review of the request records an `opened_at` timestamp and/or transitions it to an explicit `in_review` state.
- Once opened by IT, the employee can no longer rescind it.
- Rescinding must **not** delete the request.
- A rescinded request remains in historical/audit data with a state such as `rescinded_by_employee`, plus a rescinded timestamp.
- The backend must enforce rescind eligibility **atomically**, so a simultaneous IT-open / employee-rescind race cannot produce an invalid state.
- Exact request-status names will be finalized during the data-model hardening phase (Phase 1) — the names above are illustrative, not final.

### Authentication / Session Rules (2026-09-28 clarification)

- Both the admin portal and the employee portal **always** require authentication — there is no unauthenticated access to either.
- The employee portal may persist the authenticated session on the user's device/browser so the user can stay signed in, per the eventual product/session preference.
- Persistent login must still require a valid authenticated session — cached/local browser state is **never**, by itself, proof of authorization.
- Avoid designing broad offline caching of sensitive inventory data; session persistence and data caching are separate concerns and should not be conflated.
- Exact session duration, refresh behavior, and "remember me" UX will be finalized during the authentication phase (Phase 4), once a provider is chosen — not decided here.

### Admin Portal Rule (reinforced, 2026-09-28)

- `<admin-subdomain>.<parent-domain>` always requires authentication.
- Reaching `<admin-subdomain>.<parent-domain>` does **not** itself grant admin rights.
- Admin authorization must be determined by trusted application/backend authorization data, not by hostname, route, or client-side state.

### Auth Direction

- Planned shared authentication provider: **TBD** (revised 2026-09-28 — previously assumed to be Supabase Auth; no specific provider is assumed now, see Section 19 Decisions Log). Whatever provider is chosen will serve both the admin and employee portals.
- Google authentication is expected to be the primary employee login method, regardless of which provider is ultimately chosen.
- Email magic-link/passwordless login is expected as a fallback.
- Public/open employee self-registration should **not** be assumed.
- Preferred direction: **pre-provisioned** employees/accounts — only approved/known employees should gain employee-portal access.
- Exact onboarding/linking behavior (how an authenticated user gets matched to an existing employee record) will be finalized during the authentication/data-model phases (Phase 1 and Phase 4), not here.

### Repository Direction (future option, not current implementation)

- Keep admin and employee applications in the same repository for now.
- They may eventually become separate application surfaces/packages sharing backend/types/utilities.
- The repository is **not** to be restructured yet — this is a noted future option only.

### Roadmap Placement

*Superseded 2026-10-02:* Employee Portal V1 is the active Phase 2 and proceeds on the existing SQLite-backed app (Section 11a). The managed-PostgreSQL, object-storage and authentication work (Sections 12–14) stays on the roadmap as later infrastructure phases.


## 9. Initial Dummy Data Plan

Before the managed-PostgreSQL migration (Phase 2), create a repeatable development dataset.

Target:

**Approximately 40–50 assets**

**Approximately 8–10 employees**

Example equipment:

- Windows laptops
- MacBooks
- Desktop computers
- Dell monitors
- LG monitors
- Keyboards
- Mice
- Docking stations
- TVs
- iPhones
- iPads
- Printers
- Networking equipment
- Cameras
- Camera lenses
- Tripods
- Microphones
- Video lights
- Storage drives
- Appliances
- Miscellaneous equipment

Test data should deliberately include edge cases:

- Available asset
- Assigned asset
- In-repair asset
- Lost asset
- Retired asset
- Under-warranty asset
- Expired-warranty asset
- Missing serial number
- Long serial number
- Asset with photos
- Asset without photos
- Asset with purchase data
- Asset without purchase data
- Duplicate/ambiguous manufacturer barcode
- Unknown barcode

All dummy email addresses should use safe non-deliverable/test domains such as `example.com`.


## 10. Development Roadmap

### Phase 0 — Baseline & Test Harness

**Status:** IN PROGRESS — Phase 0A (local baseline), 0B (deterministic dev seed) and 0C (golden-workflow automation) complete; Phase 0D (physical scanner QA) partially complete — software/desktop scanner behavior verified, physical USB/Bluetooth/camera hardware verification still pending (not a failure, just not yet accessible), all 2026-09-28. CSV import/export and photo verification also remain open before Phase 0 can be called fully done.

*(Status as recorded 2026-09-28. Phase 0's software baseline was completed; physical-hardware scanner QA (USB, Bluetooth, phone camera) is still open and is tracked in PROJECT_STATUS.md.)*

Goal:

Prove the current application works before replacing infrastructure.

#### Tasks

- [x] Confirm project runs locally from a clean checkout — *verified 2026-09-28: `npm ci` clean install + `node src/server.js` booted with no errors.*
- [x] Confirm Node/package versions — *Node v26.8.2, npm 11.19.1 (package.json requires Node >=20.12 — satisfied).*
- [x] Confirm dependency installation — *`npm ci` succeeded, 96 packages, `package-lock.json` unchanged.*
- [x] Confirm database initialization — *fresh SQLite DB auto-created 11 tables on first boot (see Section 21 verification log).*
- [x] Document local startup procedure — *README Quick Start verified accurate against actual behavior; no changes needed.*
- [x] Create deterministic dummy-data seed — *`npm run seed:dev`, added 2026-09-28 (Phase 0B); see Section 10 log.*
- [x] Create test users/employees — *9 seeded people (1 admin), persisted in `./data-dev` via `npm run seed:dev`.*
- [x] Create test assets — *48 seeded assets, tags `NC-00001`–`NC-00048`.*
- [x] Add minimal automated smoke tests — *already present (45 tests in `test/`); see correction in Section 6.*
- [ ] Verify current scanner workflow — *surface-level only so far (scanner page, JS libraries, manual input, lookup endpoint — see Section 21). Physical device / full scan-to-checkout flow not yet verified. Seeded tags (e.g. `NC-00025`) are now available to test against once a device is available.*
- [x] Verify assignment workflow — *manually verified 2026-09-28 against a live server started on the seeded dataset: checkouts, an overdue assignment, and a multi-seat license checkout all showed correctly via the API and dashboard.*
- [x] Verify check-in workflow — *manually verified 2026-09-28: check-in and the full request → drop-off → check-in flow both confirmed against a live server on seeded data.*
- [ ] Verify asset photos — *not exercised this slice.*
- [ ] Verify CSV import/export — *covered by the automated suite; not yet manually exercised against a live server.*

#### Golden Path

The following workflow must work before infrastructure migration:

**Asset exists → Scan asset → Open correct asset → Assign employee → Scan again → Confirm assignment → Check asset in → Scan again → Confirm available**

**Status (2026-09-28):** the business-logic half of this path is now proven end-to-end by an automated integration test (`test/golden-workflow.test.js`, Phase 0C) — lookup, assignment, re-lookup, check-in, final re-lookup, and historical integrity all pass against the real Express app. The remaining piece is the literal "scan" step on physical hardware (camera / USB / Bluetooth), which is Phase 0D and has not started.

#### Exit Criteria

Phase 0 is complete when the current SQLite version has a repeatable development environment and the golden workflow has been verified — the backend/API leg is now verified (Phase 0C); physical-device scanning verification (Phase 0D) is still required to close this out.


## 18. Phase 0A–0D detail logs (formerly "Current Priority")

**Update 2026-10-02:** the active priority is **Phase 2 — Employee Portal V1** (Section 11a), starting with slice 1 (Employee Access Contract + Read Experience, implemented), then slice 2 (Employee Actions). The Phase 0 detail below is historical.

### Next Development Slice

#### Phase 0A — Local Baseline

**Status:** COMPLETE (verification-only scope) — 2026-09-28, Claude Code.

Goal:

Establish a repeatable, verified local version of the existing application without changing architecture.

Expected work:

1. [x] Inspect repository state.
2. [x] Confirm startup instructions.
3. [x] Install dependencies.
4. [x] Launch application.
5. [x] Initialize SQLite database.
6. [x] Document current database tables.
7. [x] Confirm administrator login.
8. [x] Confirm asset list loads.
9. [x] Confirm scanner page loads.
10. [x] Confirm asset CRUD works.
11. [x] Record any runtime errors. — *none found.*
12. [x] Do not migrate to Supabase yet. — *not touched.*

#### Phase 0A Verification Log (2026-09-28, Claude Code)

All verification was run against an isolated `DATA_DIR` (a scratch temp directory) and port 3179, so the real local `data/` directory was never touched — confirmed by unchanged file timestamps on `data/assets.db` and `data/.session-secret` before/after. A pre-existing developer instance of the app was already running locally (`node src/server.js`, PID 27573, started 08:53 that day) throughout this work and was left untouched.

**Environment**
- Node v26.8.2, npm 11.19.1 (engines requires Node >=20.12 — satisfied)
- Install: `npm ci` (lockfile-backed clean install) — 96 packages, 0 vulnerabilities, `package-lock.json` unchanged (verified by checksum before/after)
- Note: npm printed `install-scripts` warning that `better-sqlite3`'s `node-gyp rebuild` postinstall script was not run under this npm's script-allow policy. Not a blocker — the package ships prebuilt native binaries (`prebuilds/darwin-arm64.node`, etc.) and both the fresh boot and the full test suite worked correctly against it.
- Start command: `node src/server.js` (or `npm start`); dev watch mode: `npm --watch`
- Default port: 3000 (`PORT` env var)
- Required env vars: none strictly required to boot — `SESSION_SECRET` self-generates and persists to `<DATA_DIR>/.session-secret` if unset; `APP_URL` defaults are not set (affects secure-cookie flag and email links); SMTP vars are optional (mail falls back to the in-app Outbox when unset, confirmed working)
- SQLite DB path: `<DATA_DIR>/assets.db` (default `DATA_DIR` = `./data`)
- Upload/photo path: `<DATA_DIR>/uploads`

**Automated test baseline**
- Command: `npm test` (`node --test test/`)
- Test files: 5 (`assets`, `auth`, `import-export`, `requests`, `settings-and-dashboard`)
- Tests: 45 run, 45 passed, 0 failed, 0 warnings — matches the prior audit's expected baseline, reconfirmed after the clean `npm ci` install.

**Fresh database boot**
- Server started cleanly with no errors or warnings against an empty `DATA_DIR`.
- Tables auto-created on first boot: `activity, assets, assignments, outbox, photos, requests, sessions, settings, sqlite_sequence, tokens, users` (matches schema in `src/db.js`).

**Runtime smoke check (manual, via HTTP against the isolated instance)**
- `/api/setup-needed`, `/api/setup` (create first admin), `/api/login`, `/api/me`, `/api/dashboard`, `/api/assets`, `/api/users`, `/api/requests`, `/api/next-tag` — all 200 after auth.
- Note: non-GET requests require header `X-Requested-With: fetch` (a lightweight CSRF guard in `src/server.js`) or they return `403 Bad request origin` — this is intentional existing behavior, not a bug; documented here since it wasn't obvious from the README.
- Static/SPA surfaces all 200: `/`, `/app.js`, `/app.css`, `/manifest.webmanifest`, `/sw.js`, `/icon-192.png`, `/logo.svg`, and the SPA catch-all route `/scan`.
- Scanner vendor libraries served correctly: `/vendor/html5-qrcode.min.js`, `/vendor/JsBarcode.all.min.js` (200, `text/javascript`).

**Basic asset runtime check (temporary data only, cleaned up)**
- Create → `POST /api/assets` → 200, auto-assigned tag `NC-00001`.
- Read → `GET /api/assets/:id` → 200, includes activity log entry for creation.
- Update → `PUT /api/assets/:id` → 200.
- Tag lookup → `GET /api/assets/lookup/NC-00001` → `{"found":true}`.
- Serial lookup → `GET /api/assets/lookup/<serial>` → `{"found":true}`.
- Cleanup → `DELETE /api/assets/:id` → 200; follow-up `GET` → 404 confirms removal.
- All temporary records lived only in the isolated throwaway DB; nothing persisted to real dev data.

**Scanner surface check (no physical device)**
- Scanner page loads (SPA route `/scan` → 200).
- `html5-qrcode` and `jsbarcode` libraries load successfully.
- Manual/keyboard entry input exists in the UI (`#sc-manual` field in `public/app.js`, auto-focused so USB/Bluetooth "keyboard wedge" scanners work without a camera).
- Barcode/tag lookup endpoint (`/api/assets/lookup/:code`) reachable and functioning.
- Deferred to later scanner QA slice: physical camera behavior, real USB/Bluetooth hardware, print-label round-trip, low-light/glare/damaged-barcode cases.

**Documentation**
- README Quick Start (`npm install` → `cp .env.example .env` → `npm start` → `http://localhost:3000` → first-visit admin setup) matches actual verified behavior exactly. No README changes made.

**Issues found**
- Technical debt: `better-sqlite3` postinstall (`node-gyp rebuild`) is being skipped by npm's script-allow policy on this machine; currently harmless because prebuilt binaries are used, but worth a deliberate `npm install-scripts approve better-sqlite3` (or equivalent) decision before relying on this in CI/production images where the target platform might lack a matching prebuild.
- No blockers. No bugs found in this slice beyond the previously-logged known issues (Section 7), which were not re-tested here.

After this passes, proceed to:

#### Phase 0B — Deterministic Development Seed

**Status:** COMPLETE (implementation-only scope) — 2026-09-28, Claude Code. Not merged/pushed; left on `chore/phase-0b-dev-seed` for review.

**Implementation.** `scripts/seed-dev.js` (`npm run seed:dev`) wipes and rebuilds an isolated `./data-dev` SQLite database, driving the real app over HTTP through the same boot/client pattern as `test/helpers.js` — so all business logic (tag generation, checkout/check-in, requests, activity logging, the invite/reset flow) is reused rather than re-implemented. No new dependencies were added.

**Safety.** `assertSafeDevDir()` refuses to run if the resolved target equals the real `./data` directory or the repo root, checked before anything is deleted. The default target (`./data-dev`) is added to `.gitignore`. The script always prints the exact path it's operating on. There is no `--force` or equivalent override.

**Idempotency.** Each run fully wipes and rebuilds the target directory before reseeding — running `npm run seed:dev` twice in a row produces byte-for-byte identical row counts (verified by `test/seed-dev.test.js`, which also asserts the real `./data` directory's `assets.db` mtime is unchanged after seeding).

**Seeded dataset** (see Section 21 for the full breakdown): 9 users (1 admin), 48 assets (`NC-00001`–`NC-00048`), 9 current + 4 historical assignments, 5 requests spanning equipment/return types and open/approved/denied/dropped-off/completed statuses. Coverage includes: a missing serial, an unusually long serial, one asset each in `maintenance`/`retired`/`lost`, purchase/warranty info present and absent, an active and an expired warranty, a software license with partial seat usage (3 of 25), and one asset (`NC-00001`) with two completed historical assignments plus a third currently open — matching every explicit coverage requirement from the Phase 0B brief. No duplicate serial numbers were introduced (that's deliberately deferred to Phase 1 per the brief).

**Dev login:** `dana.ito@example.com` / `DevPass!2026` — every seeded account shares that password (development-only, printed by the script, documented in the README).

**Verification:** `test/seed-dev.test.js` added (6 new tests: safety-guard rejection, dataset shape, real-`./data` non-modification, idempotency, and a live-HTTP check that a seeded admin can log in and see correct holder/history data). Full suite: 51/51 passing (45 prior + 6 new). Manually re-ran `npm run seed:dev` twice from a clean checkout and booted the real server against `./data-dev` on an isolated port — admin login, dashboard, asset/user lists, tag lookup, `/next-tag` (correctly returns `NC-00049` after seeding), and both a currently-held and a previously-returned asset's history all verified correct.

**Deferred / explicitly out of scope this slice:** photo seeding (per the brief — not a blocker), a scripted second admin or deactivated user (not requested), Supabase/Postgres work, fixing the known hard-delete/serial-uniqueness/identifier-model issues from Section 7 (unchanged, not re-tested).

**Issues found:** none. No blockers, no new bugs. One documentation note, not a defect: the dashboard's `checked_out` stat counts distinct assets with an open assignment (regardless of the asset's own `status` column), so a multi-seat license asset with partial usage appears in both the `available` and `checked_out` buckets simultaneously — this is pre-existing `src/server.js` dashboard behavior (unrelated to this slice) and is not an "impossible state": the asset's `status` column correctly stays `available` while capacity remains.

Then:

#### Phase 0C — Core Workflow Smoke Tests

**Status:** COMPLETE (golden-path automation scope) — 2026-09-28, Claude Code. Not merged/pushed; left on `chore/phase-0c-golden-workflow` (branched from `stage`) for review.

**What was added.** `test/golden-workflow.test.js` (4 new tests, using the existing `test/helpers.js` harness — an isolated throwaway SQLite DB per run, never `./data` or `./data-dev`), driving the real Express app over HTTP exactly the way the front end does:

1. **Golden path, full lifecycle in one test:** create asset (`NC-GOLDEN1`, initially `available`, no holder) → scan/lookup via `GET /api/assets/lookup/:code` (`found:true`, correct id) → assign via `POST /api/assets/:id/checkout` (asset flips to `checked_out`, holder is the correct employee, `checked_out` activity entry recorded) → re-lookup by the same tag (still resolves, detail now shows the holder) → check in via `POST /api/assets/:id/checkin` (asset back to `available`, no holder, `checked_in` activity recorded) → final re-lookup (still resolves, still available). **Historical integrity** is asserted directly against the `assignments` row: the completed assignment is *not* deleted — it's still present with `checked_out_at`, `returned_at`, `user_id` and `condition_in` all intact, and both lifecycle activity entries remain visible.
2. **Guard cases** (3 small, targeted tests, not exhaustive business-rule coverage): an unknown tag lookup returns `found:false`; checking in an asset with no active assignment returns `400` rather than corrupting state; checking out an already-checked-out single-capacity asset is rejected with exactly one active assignment row remaining (no duplicate).

No new npm script was added — `node --test test/golden-workflow.test.js` already runs it in isolation cleanly, and adding `verify:golden` on top would have been redundant per the brief's own guidance.

**Verification:** ran the new file alone (4/4 passing), then the full suite (`npm test`): **55/55 passing** (51 prior + 4 new). Confirmed via file mtimes that neither `./data` nor `./data-dev` were touched by the run. Since the golden-workflow test already drives the real Express app over HTTP end-to-end — not a mock — this doubles as the runtime verification the brief asked for; no separate manual curl session was needed or performed (per the brief's own "prefer progress over redundant verification" guidance).

**Deferred / explicitly out of scope this slice:** physical scanner hardware (camera, USB, Bluetooth, label printer) — Phase 0D; CSV import/export and photo-upload verification; any fix to the pre-existing known issues in Section 7 (hard delete, serial uniqueness, etc.) — none were newly exposed by this slice.

**Issues found:** none. No blockers, no bugs, no new technical debt.

Then:

#### Phase 0D — Physical Scanner Verification

**Status:** PARTIAL — software/desktop-scanner baseline verified 2026-09-28 by Claude Code; physical hardware scanning (USB, Bluetooth, phone camera) is NOT YET TESTED / BLOCKED, carried forward. Not merged/pushed; left on `chore/phase-0d-physical-scanner-qa` (branched from `stage`) for review.

**Environment.** `npm test` baseline reconfirmed (55/55 passing) before any testing. `npm run seed:dev` reconfirmed the deterministic dataset (9 users, 48 assets, tags `NC-00001`–`NC-00048`). App started against `./data-dev` on an isolated port (3181); real `./data/assets.db` and `.session-secret` timestamps confirmed unchanged before and after this entire slice.

**Known test assets selected** (state recorded 2026-09-28, before any test mutation):

| Tag | Name | Status | Serial | Current holder |
|---|---|---|---|---|
| `NC-00001` | Dell Latitude 5440 | `checked_out` | `LAP-1000` | Indigo Ibarra |
| `NC-00011` | Dell OptiPlex 7010 | `available` | `DES-1010` | — |
| `NC-00035` | Apple iPad (9th gen) | `available` | `TAB-1034` | — |
| `NC-00048` | Rode NT-USB Mic + Tripod Kit | `available` | `OTH-1047` | — |

**Physical barcode.** Opened the app's real, unmodified label page (`#/labels?ids=1`, no new barcode-generation code) in an actual browser (Chrome via chrome-devtools MCP) and visually confirmed the rendered Code 128 label for `NC-00001`: barcode + displayed text "NC-00001" + "Dell Latitude 5440" + category "Laptop", all matching the seeded asset exactly. Label is real and print-ready (Avery 5160/8160 layout); it has not yet been physically printed, since no scanner hardware is currently available to scan a printout.

**USB / keyboard-wedge scanner:** **NOT YET TESTED — hardware unavailable.** No USB scanner hardware was available this session.

**Bluetooth scanner:** **NOT TESTED — hardware unavailable at current location.** Per the project owner: the company owns Bluetooth keyboard-wedge scanners, but none are on hand at this campus. Not a failure or blocker — carried forward as future QA when the hardware is accessible.

**Phone camera:** **BLOCKED — environment requirement.** Precheck found no existing safe HTTPS-accessible path to the app: `docker-compose.yml` only exposes plain HTTP on port 3000, and no reverse proxy, mkcert, or tunnel tooling is installed/configured. Per scope restrictions, no tunnel was created and Railway was not deployed. This blocks only the phone-camera leg; it is being carried forward as an explicit staging/Railway-phase prerequisite, not treated as a failure. See Section 8 exit-status note below, and Section 14a for the underlying Railway-access dependency.

**Software-level scanner-lookup verification (no physical hardware required — the same backend lookup path and, for manual entry, the exact same UI the wedge-scanner code path uses):**
- **Manual/wedge-equivalent entry — PASS.** On the real Scan page, the "type it" input is confirmed auto-focused (matches the README's claim about wedge scanners). Typed `NC-00001` + `Enter` (the literal keystroke sequence a wedge scanner sends) correctly navigated to the Dell Latitude 5440 detail page, showing status "Checked out" and holder "Indigo Ibarra" — exactly matching the recorded state above.
- **Unknown barcode — PASS.** Typed an unseeded code (`NC-99999-UNKNOWN`) + `Enter` on the Scan page: the app did not mismatch it to any existing asset, and correctly offered "Add a new asset with this tag." Dismissed via "Scan again" without creating a record — asset count confirmed unchanged (48 before and after).
- **Rapid/repeated lookups — PASS.** Looked up `NC-00001` 10 times in quick succession via the same lookup endpoint the scanner uses. All 10 resolved correctly and identically; the asset's activity-log count (6) and the total asset count (48) were confirmed unchanged before vs. after — no duplicate records, assignments, or side effects from repeated lookups.
- **Serial-number physical lookup:** deferred — there's currently no scanner hardware to scan a printed serial barcode with, so this was not attempted (per the brief's own guidance to skip/defer rather than add new barcode-generation code for it).

**Bugs found:** none.

**Issues:**
- **Blocker:** none.
- **Bug:** none.
- **Technical debt:** none new.
- **Future QA (explicitly carried forward, not failures):** physical printing of the `NC-00001` label and a real hardware scan of that printout; serial-number barcode physical lookup. Real-world scanner testing by the project owner is currently expected to be **phone-camera based**, once an HTTPS staging environment exists (blocked on that environment — revisit during the Railway/staging phase). USB/Bluetooth barcode-scanner hardware testing remains future QA **only if** that physical hardware becomes available (the company owns Bluetooth keyboard-wedge scanners, not on hand at this campus) — lack of that hardware is **not** treated as a blocker for Phase 0D or Phase 0.

**Phase 0 exit status (2026-09-28):** the local baseline (0A), deterministic seed (0B), and golden workflow (0C) are all verified, and the software/desktop side of scanner behavior (manual entry, unknown-code handling, rapid-lookup safety, label generation) now passes as well. **Phase 0's software/desktop-scanner baseline is complete.** Phase 0 as a whole is **not yet fully closed**, because physical-device scanning — USB, Bluetooth, and phone camera — remains genuinely unverified on real hardware; USB/Bluetooth await hardware access, and phone camera additionally awaits a secure HTTPS-accessible environment. These are carried forward explicitly, not marked complete.


## 11. Phase 1 — Data Model Hardening

**Status: Phase 1 is COMPLETE (2026-10-01)** — Phases 1A–1E plus the **Foundation Closeout** (below). There is no Phase 1F/1G: serial normalization and the *current-workflow* request hardening were done in the closeout; the full request-lifecycle redesign is explicitly future work (see "Moved to future phases"). The Phase 1A section below is the original audit/design as approved on 2026-09-28; where it says "Planned", the sections after it record what was actually built (and the Foundation Closeout supersedes its serial and request decisions). Full design detail: [`docs/DATA_MODEL_PHASE_1.md`](DATA_MODEL_PHASE_1.md).

#### Phase 1A — Audit & Design (2026-09-28, `feature/phase-1a-data-model-design`; merged via PR #5)

*(Written at the 1A design stage: "implementation not started" and every "Planned" below was subsequently built in 1B–1E and the Foundation Closeout; the as-built sections that follow are authoritative.)*

**Design phase complete; target decisions APPROVED. Implementation: NOT STARTED (Phase 1B–1G are Planned).** Full detail: [`docs/DATA_MODEL_PHASE_1.md`](DATA_MODEL_PHASE_1.md).

**Confirmed findings** (reproduced with a throwaway probe unless noted): F1 asset delete cascade-erases assignments/activity/photos, even while checked out (critical); F2 cover photo accepts foreign/nonexistent photo ids; F3 serials non-unique and lookup first-match-wins, incl. tag/serial cross-collision; F4 `nextTag()` is max+1 so the top tag is reissued after removal and isn't atomic on PostgreSQL (*read + probe*); F5 DB allows multiple open assignments on a single-capacity asset; F7 requests lack an "opened by IT" state, employees can cancel through `approved` (*read*); F8 request asset/user ids unvalidated → 500 (*read*); F9 everything keys on `users.id` (*read*). No custom-barcode column exists; labels are Code 128 of the tag.

**Approved Phase 1 target decisions** (all Planned / not implemented):

- **Employees/accounts:** separate `employees` (person/assignee, may have no login) and `accounts` (login/authorization; optional unique link; at most one account per employee; admin may also be an employee). Roles `admin`/`employee` (legacy `user`→`employee`). Future verified login: normalize email (trim+lowercase), match only an existing employee work email, link by IDs thereafter, never auto-create employees; unmatched login is blocked ("contact IT"); no open registration. Auth provider remains TBD.
- **Serials:** no hard global unique constraint. Keep raw value, match on normalized (trim, case-insensitive), conservative placeholder set (empty, N/A, NA, NONE, UNKNOWN, NO SERIAL, NOT AVAILABLE, `-`) treated as missing. Duplicates warn and need explicit admin override; duplicate-serial report on real data first. Lookup **never** silently picks the first match — any value resolving to multiple distinct assets (incl. tag/serial collisions) returns an ambiguity result. Tag is canonical.
- **Identifiers:** no barcode column, no `asset_identifiers` table; scanner types are input methods, not identifiers; Code 128 keeps encoding the tag.
- **Lifecycle:** add `disposed` and `archived_at`; Delete→Archive; history retained; no UI purge; mistaken assets archived with reason in activity. `lost` may stay assigned; retired/disposed/archive require assignments resolved.
- **Tags:** monotonic, never reused (archiving the top asset doesn't lower the sequence); prefix change affects only future tags and doesn't reset the number (`NC-00048` → `IT-00049`); existing tags immutable; SQLite durable high-water counter now, PostgreSQL-safe sequence/counter in Phase 2 (none built in Phase 1).
- **Assignments:** unique active `(asset_id, employee_id)`; `seat_capacity` enforced inside the check-out transaction with asset-row locking; no global `UNIQUE(asset_id)` (multi-seat licenses); assignee = employee, actor = account.
- **Requests:** `submitted`, `in_review`, `approved`, `denied`, `fulfilled`, `rescinded`, `cancelled`; employee may rescind only from `submitted` (a transition, never a delete); IT's explicit open action sets `opened_at` and ends rescind; open-vs-rescind must be atomic; no GET side effects.
- **Self-checkout:** default becomes OFF for NEW databases (currently ON, `src/db.js:140`); existing settings not overwritten.
- **Audit:** indefinite retention by default; single append-only activity table, no event sourcing; history FKs RESTRICT.
- **Categories/locations:** stay free text; light server-side validation.

**Remaining unresolved:** duplicate-serial report results; tag-correction workflow (deferred); session/`sessions` design (Phase 4); auth provider, unmatched-login experience and `issue` request scope (out of Phase 1); concrete production tag prefix/width.

#### Phase 1B — Migration Foundation + Immediate Integrity Fixes (implemented 2026-09-28, `feature/phase-1b-migration-integrity`; merged via PR #6)

- **Migration runner (implemented):** `src/migrate.js` + ordered list in `src/migrations.js`; `schema_migrations(id, name, applied_at)`; each migration runs once, in id order, in its own transaction with its bookkeeping row (failure leaves no trace); runs automatically at startup and is idempotent. Migration 1 = the pre-existing baseline schema (all `IF NOT EXISTS`, so fresh and existing databases both work, nothing rebuilt); migration 2 clears invalid cover-photo references.
- **Cover-photo ownership (implemented):** `PUT /api/assets/:id/cover` requires an existing asset (404), a well-formed photo id (400), an existing photo (404) and a photo owned by that asset (400); null/empty clears. Failed requests leave the previous cover intact.
- **Request reference validation (implemented):** `POST /api/requests` returns 400 for malformed asset/user ids and 404 for unknown ones; approve returns 400/404 for a bad `asset_id`. No request lifecycle change (Phase 1G).
- **Self-checkout (implemented):** default is OFF for NEW databases; startup still uses `INSERT OR IGNORE`, so existing values (ON or OFF) are never overwritten.
- **Category/location (implemented, minimal):** `assetValues()` (create, edit, CSV import) rejects non-text values with 400; trimming was already done by `clean()`.
- **Deferred:** category/location *length limits* (no existing convention; would be arbitrary) and validating category against the configured list (would affect existing/imported data) — left for a later hygiene slice.
- **Tests added:** 16 (`test/migrations.test.js`, `test/integrity.test.js`); suite is 71 passing / 0 failing.
- **Known limitation → resolved in Phase 1C:** SQLite can't toggle `PRAGMA foreign_keys` inside a transaction, so table rebuilds need a runner option. Phase 1C's `assets` rebuild made that necessary, so the runner gained `disableForeignKeys` (see Phase 1C below). Phase 1E's rebuilds reuse it.
- **Not touched:** Archive/`archived_at`/`disposed`, tag sequencing, employee/account split, assignment model, serial handling, request states, PostgreSQL/Railway/auth.

#### Phase 1C — Asset Lifecycle + Durable Tag Issuance (implemented 2026-09-28, `feature/phase-1c-asset-lifecycle-tags`; merged via PR #7)

- **Archive replaces Delete:** `POST /api/assets/:id/archive` (optional `reason`, recorded in the `archived` activity entry) sets the new nullable `assets.archived_at`. The asset row, tag, assignments, activity, photos and request links all remain; photo files are no longer removed. `DELETE /api/assets/:id` is kept as an alias with archive semantics. No purge path exists. UI: "Delete" → "Archive" with wording that says history is kept and the tag can't be reused; archived assets show a banner and no admin actions.
- **Visibility:** archived assets are excluded from the asset list (admin-only `?include_archived=1` shows them), `status=active`, dashboard counts/value/expiry lists and the CSV export. Direct fetch by id and tag/serial lookup still find them (`lookup` adds `archived: true`, so the scanner opens the asset instead of offering "new barcode"). Archived assets can't be edited, re-archived, checked out, or updated by CSV import (row reported as an error).
- **`disposed` status added** (DB CHECK, API, filter chip, pill, "Mark disposed" button); excluded from "active" counts; can't be checked out.
- **Active-assignment rules:** `lost` allowed while assigned (assignment kept); `retired`, `disposed` and archive are refused with a 400 ("Check this asset in before …"); nothing is checked in silently. `maintenance` keeps its previous behavior (also requires check-in).
- **Tag immutability:** `PUT /api/assets/:id` rejects a different tag with 400 (a case-only difference is ignored); the edit form shows the tag as a disabled field. No retag workflow.
- **Durable monotonic tags:** new `asset_tag_counter` (single row, `last_number`), independent of the prefix, never lowered. Creating an asset with a blank tag claims the next number and inserts in one immediate transaction (a failed create rolls the claim back; numbers already taken by manual tags are skipped; the unique `tag` index remains the final arbiter). Prefix changes apply to future tags only (`NC-00048` → `IT-00049`). CSV import uses the same allocator. Width/format unchanged (5-digit padding). Creating with an archived asset's tag fails with a specific message.
- **`GET /api/next-tag` is now a preview only** and consumes nothing; the browser never sends the previewed tag (it's just the placeholder), so the create request stays server-authoritative. **No API/UI contract change was required** beyond the disabled tag field in edit mode; the previewed number can differ from the assigned one if another create happens first (the saved tag is what's shown).
- **Counter seeding (migration 4):** max of (a) the trailing number of every existing tag of the form non-numeric-prefix + up to 8 digits, whatever its prefix (so historical/other-prefix tags like `OLD-00120` count), and (b) what the old generator counted for the current prefix. Pure-number/barcode-like tags and tags with digits in the prefix are ignored, so a scanned UPC can't blow up numbering; if anything is missed, the skip-if-taken loop still prevents reuse of an existing tag. Existing tags are never renamed.
- **Migrations:** 3 rebuilds `assets` (adds `archived_at`, adds `disposed` to the status CHECK) preserving all ids, rows and the AUTOINCREMENT mark, using the new runner option `disableForeignKeys` (FK enforcement off around the transaction, `foreign_key_check` must pass, enforcement always restored). 4 creates and seeds the counter. Verified on a copy of the dev database.
- **Tests added:** 18 — `test/lifecycle.test.js` (16: archive preservation/visibility/reservation, assignment guards, `disposed`, tag immutability, tag issuance incl. restart, prefix change, preview, concurrency) and `test/migrations.test.js` (2: 1B→1C upgrade with child rows/ids/counter seeding, and the `disableForeignKeys` runner option). Suite: 89 passing / 0 failing. One existing test ("deleting an asset removes it") was rewritten to assert the DELETE alias archives.
- **Deferred / notes:** no Archived-assets UI or unarchive endpoint (admin can list with `include_archived`); tag-correction workflow; assignments/activity/requests FKs are still CASCADE/SET NULL (Phase 1E), so DB-level protection against a raw hard delete is not yet in place — the application no longer offers one. Not touched: employee/account split, seat capacity, audit schema, serial normalization, request states, PostgreSQL/Railway/auth.

#### Phase 1D — Employee / Account Split (implemented 2026-09-28, `feature/phase-1d-employee-account-split`; merged via PR #8, login/invite UX fix PR #9)

- **Final schema** (migration 5; `users` no longer exists):
  - `employees(id, name, work_email NOCASE nullable + unique partial index, department, title, phone, status active|inactive, created_at)` — a person / equipment assignee; may never log in.
  - `accounts(id, employee_id UNIQUE nullable → employees, login_email UNIQUE NOCASE, password_hash, role admin|employee, active, created_at, last_login_at)` — login + authorization. Role lives only here. At most one account per employee. `auth_provider`/`auth_subject` placeholders were **not** added (nothing uses them; add when a provider is chosen).
- **Legacy migration (exact):** each `users` row → one employee and one account **with the same numeric id** (`employee.id = account.id = old user id`), `employee_id` linking them. Email → `lower(trim(email))` for both `work_email` and `login_email` (if two users collide after normalization the migration aborts with the ids listed and changes nothing — none exist in dev data). `role`: `admin`→`admin`, `user`→`employee`. `active` → `accounts.active` and `employees.status` (`active`/`inactive`). Password hash, timestamps, department/title/phone carried over. Dependent tables rebuilt with all other constraints unchanged (assets FKs still CASCADE/SET NULL — Phase 1E), AUTOINCREMENT marks preserved, `foreign_key_check` enforced by the runner, then `users` dropped. Sessions (`uid`) and tokens are untouched and still resolve because account id = legacy user id.
- **References by meaning (column names unchanged for now — rename is Phase 1E):**
  - PERSON → `employees`: `assignments.user_id`, `requests.user_id`, `activity.subject_user_id`.
  - ACTOR → `accounts`: `assignments.checked_out_by`, `assignments.returned_to`, `requests.created_by`, `requests.resolved_by`, `photos.uploaded_by`, `activity.actor_id`, and `tokens.user_id` (reset/invite tokens belong to accounts).
- **Login/session:** login is by `accounts.login_email` + `password_hash` (unchanged credentials); the session `uid` is the **account** id; access requires `accounts.active` and (if linked) `employees.status = 'active'`. `req.user` intentionally has no plain `id` (`account_id` = who acted, `employee_id` = the person). `/api/me` returns the combined identity (`id` = employee id, `account_id`, name from the employee, email/role from the account); an account with no employee has `id: null` and cannot hold equipment. Authorization is `accounts.role` only. No auth provider, OAuth or magic link added. Future rule (documented in code, not implemented): a verified external login links to a pre-provisioned employee by normalized work email only; unknown logins never create an employee and are blocked.
- **Employee without login (works):** `POST /api/users` with `login:false` creates only an employee (email optional). Such a person appears in People and every assignee picker, can receive assets, requests can be raised for them, and cannot sign in (no account row exists; no fake credentials).
- **Add a login to an existing employee:** `POST /api/users/:id/account {email?, role, invite}` links by explicit employee id; 400 if they already have one, on a bad/duplicate login email, or if the email belongs to a different employee; never creates an employee. UI: "Give login access" button on the person page; the Add-person sheet has one checkbox, "Create login and send invite" (default on; when unchecked only the employee is created, no invite is sent, and the Access dropdown is disabled).
- **Compatibility endpoints retained:** `/api/users`, `/api/users/:id` (+`/invite`, +`/account`) — now backed by employees + accounts; ids are **employee** ids; role input `user` is accepted as `employee`; output roles are `admin`/`employee`. `PUT` toggling `active` disables/enables both the account and the person's active status and signs the account out; nothing deletes a person or their history (there is still no delete).
- **Seed:** now 10 people (9 with logins, 1 admin) plus **Jules Jaramillo, an employee with no login**, who holds one assigned keyboard/mouse; reseeding stays deterministic.
- **Verified on a copy of `data-dev`:** 9 employees, 9 accounts, 0 unlinked employees, 0 accounts without an employee, `foreign_key_check` clean, `users` table gone, migrations 1–5 applied, 13 assignments intact. Real `data/` not touched.
- **Tests added:** 14 in `test/people.test.js` (migration incl. FK shapes/ids/roles/credentials/idempotence/duplicate-email refusal; identity and role authorization; employee without account; account linking and validation; deactivation keeps the person), seed/auth tests adjusted. Suite: 103 passing / 0 failing.
- **Deferred:** People screen polish (no dedicated employee-vs-account views, no bulk tools); an employee lifecycle beyond active/inactive (no archive/offboarding workflow); separate employee-email vs login-email editing in the UI (editing email updates both); renaming legacy `user_id` columns and history-safe/RESTRICT FKs (Phase 1E); external-auth linking and the "access not provisioned" page (auth phase).
- **Newly approved future requirements (2026-09-30, documentation only — 1D code/schema unchanged):** assignment mode (permanent vs temporary checkout, an assignment-level field preserved in history) is recorded as input to **Phase 1E**; an admin employee/equipment roster with CSV export is recorded as later admin reporting work that depends on it. See "Assignment Mode + Admin Equipment Roster" (next to "Historical Integrity") and `docs/DATA_MODEL_PHASE_1.md` §3.4/§4a. Neither is implemented; 1D assignments remain undifferentiated.

#### Phase 1E — Assignment + Historical Integrity (implemented, 2026-09-30, `feature/phase-1e-assignment-integrity`; merged into `stage` via PR #10)

- **Assignment type:** `assignments.assignment_type TEXT NOT NULL DEFAULT 'permanent' CHECK IN ('permanent','checkout')` (`checkout` = "Temporary checkout" in the UI). It belongs to the **assignment** — never to the asset or category (a camera in category `Other` can be permanent; a laptop can be a checkout). History keeps the value it was created with; check-in never rewrites it. API: `assignment_type` on `POST /api/assets/:id/checkout` and `POST /api/requests/:id/approve` (omitted = `permanent` for an admin; an unknown value = 400). **Permanent assignments are admin-only, enforced on the server** (route + `createAssignment`, not just the UI): a non-admin who asks for `permanent` gets **403** and nothing is created; a non-admin self check-out with no type is always a `checkout`, and non-admins can only check out to themselves. Employees may never directly permanently assign equipment to themselves. CSV-import assignments are `permanent` (admin route).
- **Legacy rule (migration 6, exact):** a legacy assignment **with a non-null `due_date` → `checkout`**; **without → `permanent`**. Decided by `due_date` alone — never by asset category. Legacy `due_date` values are preserved; legacy rows have no `due_time`. (Reasoning: a due date is the one reliable sign the old system recorded a loan.) A table CHECK now guarantees the invariant for every row: `permanent ⇒ due_date and due_time NULL`; `checkout ⇒ due_date NOT NULL`.
- **Return date / time:** reuses the existing `assignments.due_date` (date-only) and adds nullable `due_time` (`HH:MM`). **Temporary checkout: `due_date` REQUIRED (400 without it, or if malformed), `due_time` optional** — so multi-day, same-day and few-hours checkouts all fit with no special state (a same-day return is just `due_date = today`). **Permanent: both always `NULL`** (submitted values are dropped). The `default_loan_days` setting no longer makes the server invent a date; it only pre-fills the return-date field in the UI. Check-in leaves date and time on the row; activity reads `To X · Temporary checkout · return by 2026-11-20 14:30` and `From X · Temporary checkout · return was due 2026-11-20 14:30`; the check-out email adds "at HH:MM". No new overdue notifications (existing sweep is date-based and unchanged).
- **UI:** Check-out sheet and the request "Assign & check out" sheet have an *Assignment type* control — **Permanent** (default) / **Temporary checkout**. Temporary shows **Return date \*** (required) with a **Today** button that just fills in today's date, and **Return time** (optional); Permanent hides, clears and disables both. Employee self check-out now opens a small sheet asking for the required return date (and optional time) — it has no type chooser. "Permanent" / "Temporary checkout · return by <date> <time>" is shown on asset holders, Home, the person page (current + past), the check-in sheet and in activity details.
- **`user_id` → `employee_id`:** the database column is now `assignments.employee_id` (index `idx_assign_employee`); all internal SQL uses it and API responses expose `employee_id` (no `user_id` on assignment rows). **Compatibility aliases retained (input only):** `user_id` is still accepted as the person in the checkout body, the request-return body and the `GET /api/assets?user_id=` filter (`employee_id` preferred and used by the UI and seed). `requests.user_id` and `activity.subject_user_id` are **not** renamed — request lifecycle is Phase 1G and the audit schema is untouched.
- **Active-assignment protection:** partial unique index `idx_assign_active_unique ON assignments(asset_id, employee_id) WHERE returned_at IS NULL` — the same employee can't hold the same asset twice at once. It is deliberately not a per-asset unique (that would break multi-seat assets).
- **Capacity (design):** no new concept — `assets.license_seats` already is the seat capacity (`capacity = max(1, license_seats)`: physical assets 1, multi-seat licenses >1), so no `seat_capacity` column was added. Assignment creation (`createAssignment` in `src/assignments.js`) runs in one `BEGIN IMMEDIATE` transaction: load asset → check state → count active assignments → reject if `>= capacity` (or same employee already holds it) → insert assignment → update asset condition/status → write the `checked_out` activity row. Failure rolls everything back. The write lock is taken before the count, so concurrent writers (even separate processes) can't both pass. Shared seats needed no redesign.
- **Historical FK safety (migration 6, rebuild tables, `disableForeignKeys` runner option, runner's `foreign_key_check` enforced, ids and AUTOINCREMENT marks kept):** `assignments.asset_id` CASCADE → **RESTRICT**; `assignments.employee_id` → **RESTRICT**; `activity.asset_id` CASCADE → **RESTRICT**; `requests.asset_id` SET NULL → **RESTRICT**. A raw `DELETE` of an asset or employee that has history now fails. No user-facing hard-delete exists (assets archive). Not changed: `photos.asset_id` stays CASCADE (photos are attachments, not history; nothing can reach that path because every asset has activity rows), the other `requests`/`activity`/`tokens` references, and there is still no FK on `assets.cover_photo_id`. The migration aborts with the offending ids, changing nothing, if legacy data already contains a duplicate active (asset, employee) pair.
- **Check-in history verified:** employee, asset, type, checkout and return timestamps, due date, `condition_out/in`, notes, `checked_out_by`/`returned_to` accounts all persist on the closed row; activity text now includes type and due date. Assignments also survive asset archive.
- **Admin roster dependency now supported by the data model (roster itself NOT built):** every assignment row carries type, employee, asset, checkout date, due date and return info; `/api/users/:id` returns `current`/`past` with `assignment_type`/`due_date`; asset list rows add `permanent_holders` / `checkout_holders`; `GET /api/assets?employee_id=` filters by holder. A future roster needs no further assignment-schema change.
- **Seed:** reseeds deterministically (48 assets, 10 people). Bailey has permanent everyday gear (MacBook Air, monitor, a Microsoft 365 seat); temporary checkouts: Emerson's Sony camera (category `Other`, due 2026-12-15), Dakota's overdue laptop loan, Indigo's laptop loan. Seed now yields 9 permanent / 3 temporary current assignments. Seed summary prints the split.
- **Tests:** new `test/assignments.test.js` (30) and `test/self-checkout.test.js` (8, see QA follow-up below): admin-only permanent (API + 403 for non-admins, friendly message), self-checkout always checkout, required return date (missing/empty/time-only/invalid date/invalid time → 400), optional return time incl. same-day, permanent drops date/time, DB CHECK constraints, category independence, history preservation incl. due date/time and archive, duplicate-employee rejection (API + DB), capacity-1, multi-seat up to/over capacity, concurrent HTTP attempts, multi-process attempts, `BEGIN IMMEDIATE` assertion, atomic failure, RESTRICT raw-delete blocks, FK declarations + clean `foreign_key_check`, legacy migration (due date → checkout, none → permanent, category ignored, dates/ids/sequence preserved, empty legacy table, refusal on duplicates), employee-without-login assignment/picker, roster-foundation fields, and the employee permanent-assignment request path (request created instead of assignment, validation, cancel, admin approval creates the permanent assignment, non-admin cannot approve, denial creates none, new nullable column, front-end source guarantees). Existing tests updated for `employee_id` and the new rules. Suite: **140 passing / 0 failing** (baseline was 103).
- **Employee permanent-assignment request (minimal, reuses the existing request model):** employees can never reach the server's 403 in normal use. In the self check-out sheet the employee picks *Temporary checkout* (default, return date required) or *Permanent*; choosing Permanent turns the button into "Request permanent assignment" and, on submit, shows a modal — **"Permanent assignment requires approval" / "Permanent equipment assignments must be approved by IT."** with **Send request** / **Cancel**. Cancel closes the modal and creates nothing; Send request posts an equipment request and confirms "Request sent to IT. Nothing is assigned until IT approves it." — no assignment, no check-out. The "Request this" sheet has an equivalent *I need this permanently* checkbox that goes through the same modal. **Representation:** one new nullable column, `requests.requested_assignment_type` (`permanent` | `checkout`, NULL = unspecified/legacy; added inside migration 6's existing `requests` rebuild); `POST /api/requests` accepts `requested_assignment_type` (`permanent` requires `asset_id`; unknown value = 400) and sets the category from the asset when omitted. Admins see "Permanent assignment request — <asset>" on the Requests page, Home and the asset page, get a distinct email subject, and the request page offers **Approve & assign permanently** (calls the existing `POST /api/requests/:id/approve` with the asset, which creates the permanent assignment — no due date/time — with the admin as actor, and completes the request) or **Decline** (existing deny; creates nothing). Approval remains admin-only; the existing 403 guard on direct permanent check-outs is kept (its message is friendly text: "Permanent assignments need IT approval. Send IT a request instead."), and the UI's generic error fallback never shows a bare status code. No request lifecycle/states were changed.
- **Manual check (latest, toggle/badge pass):** verified in a real browser on a fresh server: People list shows `Self-checkout` / `No self-checkout` (no `Login access`); the toggle end to end for one employee (enabled → green/check, employee has "Check out to me"; disabled from the admin profile → neutral/X, People list `No self-checkout`, persists across refresh, employee loses direct check-out but "Request this" still submits; re-enabled → green/check, People list `Self-checkout`, persists, employee regains "Check out to me"). Earlier passes: the owner's first real-browser pass produced the QA follow-up; after the fixes the flows were re-verified in a real browser against the seeded `data-dev` on a fresh server: admin check-out sheet/success modal/sticky header/status tags, request detail sheet, avatar menu, permanent-request modal (Cancel creates nothing), the People list badges, profile login/self-checkout details, **Disable then Enable self-checkout with page refresh confirming persistence (no "Not found")**, Add/Edit person with Building (persisted after refresh), Settings has no global self-checkout control, and the employee portal (enabled employee gets "Check out to me"; disabled employee gets only "Request this" and can still submit a request). Not re-exercised: mobile widths/iOS safe area.
- **QA follow-up to 1E (2026-09-30; migration 7; migrations 1–6 untouched):**
  - **Self-checkout is a per-employee permission.** `employees.can_self_checkout INTEGER NOT NULL DEFAULT 1 CHECK IN (0,1)` (migration 7, plain `ADD COLUMN`). New employees and new databases start **enabled**; existing employees inherit the old global preference once (next bullet); an admin can turn it off per employee with `PUT /api/users/:id/self-checkout {enabled: boolean}` (admin only; changes nothing else about the person). `POST /api/assets/:id/checkout` for a non-admin now requires the employee's flag (else 403 "Self-checkout is not enabled for your account. Please request this item from IT."); an enabled self check-out is still always a temporary checkout with a required return date. A disabled employee can still browse, submit requests and request a permanent assignment; the UI shows only "Request this" for them, so the 403 is reachable only by a forged/direct API call. Employees without a login keep the stored flag; it has no effect until they have access. `/api/users/:id` and `/api/me` expose `can_self_checkout`.
  - **Deprecated global `self_checkout` setting — consumed only by migration 7.** Legacy format: row `settings.self_checkout`, value `'1'` = on, anything else = off (how the old code read it). **Migration 7 reads it once:** legacy OFF → every existing employee migrates with `can_self_checkout = 0`; legacy ON or row absent → `1`. After that nothing reads it: authorization uses only `employees.can_self_checkout`, `getSettings()`/`/api/settings`/`/api/me` no longer expose it, `PUT /api/settings` ignores it, it is gone from the Settings UI, and new databases don't seed it. The old row is left as unused, deprecated data (safe to delete later). **No global toggle or hidden master switch exists**; an emergency kill switch would be a separate product decision. Consequence: an install whose global setting was OFF keeps those employees disabled (admin re-enables per person); one whose setting was ON keeps them enabled. Production email configuration remains future work (dev Outbox behavior unchanged).
  - **UI:** the **People list** emphasizes checkout permission: a compact `Self-checkout` / `No self-checkout` badge for people with a login (no `Login access` badge — that is profile-level detail), plus the existing `Admin`, `Inactive` and `No login` badges (a person with no login shows `No login` instead of a self-checkout badge, since the flag has no effect for them). The **person profile** keeps `Login access` / `No login` and a **stateful toggle button** (the only indicator of the permission — there is no separate "Self-checkout: Enabled/Disabled" text line; people with no login also get a short note that it has no effect until they have a login) (`aria-pressed`): enabled = green with a checkmark, label "Self-checkout enabled"; disabled = neutral with an X, "Self-checkout disabled"; clicking flips the permission. It also shows **Building** (plain text line next to title/department) when set. Other QA items unchanged: request badge `Open` → **Pending** (presentation only); admin check-out/approve sheets default to **Temporary checkout**; active assignments read **Assigned** / **Temporary checkout** (overdue still Overdue); "since …" includes time; compact **sticky asset header**; **"Equipment assigned"** modal with *View employee* / *Back to assets*; **request detail sheet** (notes readable before approve/deny); **avatar menu** (My profile, Sign out). The UI maps the server's bare `Not found` to a friendly "That action isn't available right now. Reload the page and try again." so a newer page against an older server never shows a raw error.
  - **Building (optional free-text employee metadata):** `employees.building TEXT NULL`, added in migration 7. Free text only — no dropdown, list, table or Settings entry; Nutricost has 14+ buildings and IT types whatever applies. Trimmed on save; blank/whitespace stores `NULL`. `POST /api/users` and `PUT /api/users/:id` accept `building` (an update that omits the field leaves it unchanged; an empty string clears it). Field present in Add person and Edit person; shown on the person profile only (not a badge, not on the People list). It has no effect on login, account or permission behavior.
  - **Stale UI after updates (root cause of the People list still showing "Login access"):** the People-list source was already correct; the browser was running an older `app.js`. The server sent `Cache-Control: public, max-age=3600` for the app's own JS/CSS, so a browser that had loaded an earlier build kept using it, unrevalidated, for up to an hour (verified in a real browser: the stale script was delivered from the HTTP cache with `transferSize 0` while the server and Cache Storage held the new one). Fix: `html/js/css` now always revalidate (`Cache-Control: no-cache`, ETag kept so it is a cheap 304), and `index.html` references `app.js?v=1e3` / `app.css?v=1e3` once so browsers holding the old cached copies fetch fresh ones immediately (index.html itself was already no-cache). After this, a normal reload picks up new UI code; no hard refresh needed.
  - **Self-checkout "Not found" bug (root cause):** the page called the correct route (`PUT /api/users/:id/self-checkout`), but the dev server being used (`npm start`, no file watching, started at 13:34) predated the route, so the `/api` catch-all answered `{"error":"Not found"}`. Not a frontend or route-definition bug: it reproduces only against a process started before the change, and a fresh server toggles both directions and persists (verified in a real browser). Restart the server after pulling (or use `npm run dev`, which watches files).
  - **Scan barcode in employee self-checkout:** the self check-out sheet (`selfCheckoutSheet`) has a secondary **Scan barcode** button that opens the app's single existing scanner (`openScanner`, camera + type-the-tag box) and resolves the code with the existing `/api/assets/lookup/:code`; a found, available asset (not already theirs, not archived, seat free) reopens the same sheet for the scanned asset, so the temporary-checkout rules (return date required, time optional) and the server's per-employee permission check are unchanged. Unknown codes show the existing "No asset found for …" toast; unavailable assets get a friendly message. No second scanner was built.
  - **Seed:** Harper Hughes has self-checkout off (8 login employees on, 1 off); Jules Jaramillo remains the no-login person; Bailey Brooks has Building `Building 4` and Harper `Warehouse 2`; permanent and temporary examples remain (9 permanent / 3 temporary current assignments).
  - **Tests:** `test/self-checkout.test.js` (16) — default enabled, enabled employee can self-checkout (temporary, return date required), disabled employee blocked incl. direct/permanent attempts and friendly message, disabled employee can still request (plain and permanent) and be assigned by IT, per-employee isolation, enable/disable round trip with persistence and correct target, employees can't change anyone's (or their own) permission, new employees default enabled, migration 7 for legacy OFF / ON / absent (+ later hires enabled, flag validated), legacy value ignored at runtime in both directions, People data (self-checkout state, no-login intact). `test/building.test.js` (5) — create with/without, trim/blank→null, free text, edit/clear/preserve-when-omitted and detail API, no effect on login/account/permission. Old global-setting tests were rewritten to the per-employee model. Suite: **153 passing / 0 failing**.
- **Deferred / not done in 1E:** `seat_capacity` column (reused `license_seats`); durable audit/activity schema improvements (§3.10) and the cover-photo FK; reclassifying legacy assignments; overdue notifications for checkouts; the admin roster screen and CSV export; serial normalization (1F); request lifecycle (1G); renaming `requests.user_id` / `activity.subject_user_id`.

**Approved future requirements recorded during Phase 1E (2026-09-30) — NOT implemented:**

- **Max temporary-checkout duration (policy):** some assets will have an admin-controlled maximum temporary checkout duration (e.g. hours, days, weeks, or unlimited/no maximum). Exact field, policy semantics and admin UI are **not decided**. Phase 1E only requires a return date; it enforces no maximum.
- **Equipment reservation (approved future requirement, 2026-09-30 — NOT implemented; expanded 2026-10-02 with the availability calendar, waitlist and release-request rules in Section 11a; no tables, fields, APIs or UI exist for it):** employees should eventually be able to reserve equipment for future use. Desired UX: a **Reserve for future** checkbox/action on checkout; when selected, a required **Pickup date** appears **above** Return date, and Return date stays required. The future reservation design must decide: overlapping reservation conflicts; interaction with current checkouts; what happens if an asset is not returned before a reservation starts; admin override/cancel; when a reservation becomes an active checkout; no-show / pickup-expiration behavior; and notifications/reminders.
- **Future request-lifecycle states (deferred, not implemented; today: open/approved/denied/dropped_off/completed/cancelled, with `open` displayed as "Pending"):** Submitted → In Review → Approved → Denied → Fulfilled, plus Rescinded / Cancelled as already planned. Exact state implementation belongs to Phase 1G.
- **Email delivery (future infrastructure):** real email delivery/provider configuration is still future work. The development Outbox behavior (messages logged when SMTP is not configured) is acceptable for now; no provider was configured.
- **Permanent-assignment request:** a minimal version is now implemented in 1E on the existing request model (see "Employee permanent-assignment request" above). The full request lifecycle (states, richer approval, employee-facing tracking) remains Phase 1G.

#### Phase 1 Foundation Closeout — serial integrity, request integrity, historical safety (implemented 2026-10-01, `fix/phase-1-foundation-closeout`; merged via PR #11)

**Migrations 8 and 9** (1–7 untouched). Suite: **211 passing / 0 failing** (baseline 154; +24 `test/serial.test.js`, +33 `test/request-integrity.test.js`; two existing tests made migration-count-agnostic / given valid legacy fixtures). `npm run seed:dev` unchanged: 10 people, 48 assets, 12 current + 4 historical assignments, 5 requests.

- **Serial normalization + uniqueness (migration 8).** `assets.serial` keeps what the user typed — only **surrounding whitespace is trimmed**, and a blank/whitespace-only value **or the exact placeholder `N/A` (any case)** is stored as **NULL** (no serial) — that one value only, not a list (`NA`, `None`, `Unknown`, `N/A-1` … are ordinary serials). New column `assets.serial_normalized` (= trimmed + lower-cased) with a plain **`UNIQUE` index** (NULLs never collide). Uniqueness covers the **whole inventory including archived assets**. Nothing else is stripped: `ABC-123`, `ABC123`, `ABC 123` and `ABC/123` are different serials; `ABC123`, `abc123` and `  ABC123  ` conflict. The rule lives in one place (`src/serial.js`) and is applied by every write path: create, edit, CSV import (a conflicting row is skipped with a message, the rest import; an update with a blank serial keeps the stored one) and scanner lookup (matches `serial_normalized`, so case/space-insensitive and index-backed). Conflicts return 400 naming the asset that owns the serial (and "(archived)"). A rejected create rolls back its generated tag number. A serial must be text or a number. **Existing data:** migration 8 trims stored serials, blanks → NULL, backfills the key, and **refuses to run if any assets already collide** — it lists them (tag, asset id, raw serial), changes nothing and never merges, deletes or renames an asset. *Decisions:* (1) this **supersedes the 1A "duplicates warn + admin override" design** with hard uniqueness, and **narrows the 1A placeholder list to the single value `N/A`** (restored after review): it means "no serial" on create, edit, CSV import (an `N/A` on an update keeps the stored serial, like a blank), migration 8 (legacy `N/A` rows become NULL instead of colliding) and scanner lookup (scanning `N/A` finds nothing). Other guessed placeholders were deliberately not added; (2) the key is computed in the app and stored, **not** a DB expression/collation (`lower()` / `COLLATE NOCASE` are ASCII-only in SQLite but Unicode/locale-aware in PostgreSQL, so a DB-side rule would change meaning after the migration); (3) a serial equal to another asset's *tag* is still allowed — lookup deterministically prefers the tag; (4) no duplicate-serial *report* was needed on real data: the local `data/` database has no assets, and the migration itself is the collision report for any database it runs on.
- **Request integrity (current workflow only; no new statuses, screens or UX).** `src/requests.js` holds the allowed transitions and is the **only** code that changes a request's status: *equipment* `open → approved | completed | denied | cancelled`, `approved → completed | denied | cancelled`; *return* `open → dropped_off | completed | cancelled`, `dropped_off → completed | cancelled`; `denied` / `completed` / `cancelled` are **terminal** (no endpoint edits or deletes a request, and nothing moves out of a terminal state — API tests verify a closed request is byte-for-byte unchanged by every action). Each change is a conditional `UPDATE … WHERE id = ? AND status = <validated status>`, so a simultaneous IT-approve and employee-rescind produce exactly one winner (tested). **Migration 9** rebuilds `requests` (ids/sequence kept) with table CHECKs: status valid for the type (a return request can't be `approved`/`denied`, an equipment request can't be `dropped_off`); `open`/`dropped_off` ⇒ no `resolved_at`/`resolved_by`; `approved`/`denied`/`completed`/`cancelled` ⇒ `resolved_at` set; `resolved_at` never before `created_at`; `requested_assignment_type` only on equipment requests and `permanent` requires an asset; explicit `ON DELETE RESTRICT` on all four references (`user_id`, `asset_id`, `created_by`, `resolved_by`); a partial unique index allowing at most one **live** (open/dropped_off) return request per asset + employee; and two plain indexes. Like migrations 6–8 it validates existing rows first and **refuses with the offending request ids** (nothing repaired or deleted) if any already contradict the rules. Server behavior fixed: a client can't choose a status/type on create; request creation refuses an inactive person or an archived asset; list filters accept only `open|closed` and `equipment|return` (else 400); `deny` is equipment-only; re-approving an already-approved request is refused; approving for an inactive person is refused.
- **Permanent-assignment request behavior.** Approving a request for a *permanent* assignment now always makes exactly that assignment: for the requested asset (a different `asset_id` → 400), as `permanent` (a `checkout` override → 400), and it can no longer end as "approved" with nothing assigned (omitting `asset_id` uses the requested one). The assignment and the request's completion are one transaction (a failed assignment leaves the request open and nothing behind); emails go out after commit. A direct **temporary** checkout no longer silently completes an open *permanent* request (a permanent checkout does; an unspecified request is completed by either); a direct checkout still only affects the receiving employee's requests. The UI already sent the right values, so it is unchanged.
- **Rescind rule as supported today (unchanged).** An employee may cancel only their **own equipment** request while it is live (`open` or `approved`); IT may cancel any live request, including return requests; cancelling records who/when and keeps the row. **Exception — permanent-assignment requests:** approval creates the assignment and completes the request in one step, so an approved permanent request is `completed` and terminal; a permanent request that is somehow still `approved` (legacy data) can't be rescinded by the employee, and nobody can cancel one that already produced its assignment — history never reads "cancelled" after the assignment exists. Open permanent requests can still be rescinded. The stricter product rule — *rescind only until IT has "opened" it* (`submitted`/`in_review`/`opened_at`) — needs the new states and is part of the **future request-lifecycle UX**, not this slice.
- **Historical / FK safety audit.** Verified (tests) that no application path deletes an asset, employee, account, assignment or request (asset "delete" archives; people are deactivated; no request/assignment endpoint deletes or edits history), and that raw `DELETE`s are blocked by RESTRICT/NO ACTION foreign keys: `assignments.asset_id/employee_id`, `activity.asset_id`, `requests.asset_id/user_id/created_by/resolved_by` (explicit RESTRICT), plus the accounts/employees references (default NO ACTION, which also rejects the delete). Archiving keeps requests/assignments/activity and requests still resolve to the archived asset; deactivating an employee keeps their requests readable. **Left as is, deliberately:** `photos.asset_id` ON DELETE CASCADE (photos are attachments; unreachable because every asset has activity rows), `tokens.user_id` CASCADE (disposable credentials), no FK on `assets.cover_photo_id` (validated in the application), and open equipment requests for an asset that is later archived stay open (they can't be approved against the archived asset; IT can decline or assign different equipment).
- **PostgreSQL follow-ups (nothing PostgreSQL-specific was built).** The new schema avoids SQLite-only features: plain `UNIQUE` index on an app-computed column, partial unique index (supported by PostgreSQL), ordinary CHECKs (no `IS NOT`/SQLite quirks), explicit RESTRICT. For Phase 2: the TEXT timestamps (`datetime('now')`, compared as strings in the `resolved_at >= created_at` CHECK) become `timestamptz` defaults — re-express that CHECK on real timestamps; `AUTOINCREMENT` becomes identity/sequences; the transition rules could additionally get a PostgreSQL trigger for defence in depth (the application layer is the portable guard today); migrations 8–9's pre-checks should be run (read-only) against the exported production data before cutover.

**Phase 1 summary (1A–1E + Closeout):**

- **1A** audit + approved target design. **1B** migration runner (`schema_migrations`, transactional, FK-safe rebuilds) + immediate fixes (cover-photo ownership, request reference validation, category/location text checks). **1C** archive instead of delete, `disposed` status, immutable tags, durable monotonic tag counter. **1D** `users` split into `employees` (people/assignees, may have no login) and `accounts` (login/authorization). **1E** assignment type (permanent vs temporary checkout, admin-only permanent), return date/time, one active assignment per employee+asset, transactional seat capacity, RESTRICT history FKs, employee permanent-assignment request, per-employee self-checkout, building field. **Foundation Closeout** serial normalization + uniqueness, request-state integrity, permanent-request approval correctness, historical-safety verification.
- Schema is now migrations 1–9; 211 automated tests; deterministic dev seed.

**Moved to future phases (NOT Phase 1 blockers):**

- Admin employee/equipment roster + CSV export (the data model supports it: Section 7)
- Future reservations (pickup date / reserve-for-future; see the 1E future-requirements notes)
- Max checkout duration (per-asset policy)
- Paired mobile scanner (Section 19)
- Phone-camera HTTPS QA (needs the HTTPS staging environment — Phase 5/6)
- Railway hosting, managed PostgreSQL, object storage (Phases 2, 3, 5)
- Production email delivery (Outbox logging is acceptable until then)
- Final auth provider (Phase 4)
- ~~Full request lifecycle UX (submitted / in review / fulfilled / rescinded states, "opened by IT" rescind cutoff, employee-facing tracking)~~ — delivered by Phase 2 Slice 5 (Section 11a)
- Notifications / reminders (e.g. checkout overdue notices beyond the existing date-based sweep)

Smaller known debt carried forward (not blockers): tag-correction workflow; category/location length limits; renaming `requests.user_id` / `activity.subject_user_id` / `tokens.user_id`; a tag-vs-serial collision check; no Archived-assets UI / unarchive endpoint; no foreign key on `assets.cover_photo_id`.

- [x] Define employee/person model — *Phase 1D*
- [x] Define login/profile model — *Phase 1D (external-auth linking is Phase 4)*
- [x] Define asset identifier model — *tag is canonical; serial unique & normalized; no identifier table (Closeout, 1A decision)*
- [x] Resolve serial duplicate behavior — *hard uniqueness, case/whitespace-insensitive (Closeout)*
- [x] Replace destructive asset deletion — *Phase 1C*
- [x] Preserve historical records — *Phase 1E + Closeout*
- [x] Make asset-tag generation concurrency safe — *Phase 1C (durable counter, one transaction)*
- [x] Fix cover-photo ownership validation — *Phase 1B*
- [x] Confirm lifecycle statuses — *Phase 1C*
- [ ] Confirm location model — *free text; deferred past Phase 1*
- [ ] Confirm category model — *free text; deferred past Phase 1*
- [x] Confirm self-checkout policy — *per-employee permission (1E QA follow-up)*


## 11a. Phase 2 — Employee Portal V1 (complete through the Search refinement; current state is in PROJECT_STATUS.md)

**Direction (2026-10-02):** Phase 2 is **Employee Portal V1**, building on the existing employee interface — not the PostgreSQL migration. Sequence: **(1) Employee Access Contract + Read Experience → (2) Employee Actions → (3) Later workflow expansion.** The infrastructure items below are *future work, not part of this phase*: full request-lifecycle redesign, admin roster/CSV, reservations, max checkout duration, paired mobile scanner, production auth provider, Google/magic-link sign-in, Railway/PostgreSQL/object storage, production email, notifications/reminders.

#### Slice 1 — Employee Access Contract + Read Experience (**COMPLETE** — merged to `stage` via PR #12, 2026-10-02)

Tests: baseline 211 → **230 passing / 0 failing**. No schema change, no new migration. What exists today (reconciled): employees already had their own navigation (Home with a *My equipment* card and *My requests*, Browse, Scan, Requests, Account/My profile), self-checkout (per-employee permission), permanent-assignment requests, return/drop-off, and password change; admins have the full tool set. This slice formalizes and tests what an employee may read, and adds a dedicated **My equipment** destination, History and Building.

**Employee visibility policy (enforced on the server, not by hidden navigation):**
- *May see:* their own profile (`GET /api/users/:id` for their own employee id), their own current assignments and assignment history, their own requests, and **assets that are theirs or available** — an employee can open an asset (`GET /api/assets/:id`), see it in lists, scan it, request it or self-check it out only if they currently hold it, **or** it is not archived and has status `available` (a multi-seat license with a free seat stays `available`). Asset details are sanitized for employees (no purchase cost, vendor, notes, audit trail; license key only for equipment they hold; never another holder's name).
- *Must not see:* another employee's profile, assignments, history or requests (403); the admin tools/settings/import/export/outbox/activity (403, already true and now covered by tests); any other asset — archived, in repair, lost, retired, disposed, or held by someone else — which is indistinguishable from "not found" (404), including the photo files for such assets (`/uploads/*` now follows the asset's visibility) and including through actions (self-checkout, return notice, photo upload, creating a request for it). Scanner lookup returns an id only for assets they may open; for any other existing asset it returns `{found:false, unavailable:true}` (no id, no details) so the scanner can say "isn't available right now". The "already checked out to <name>" message is shown to IT only; employees just see "isn't available".
- *Admin behavior is unchanged.*

**Employee directory — restricted.** `GET /api/users` was returning every active employee's name to any signed-in user. The audit found **no employee workflow uses it**: self-checkout and requests always act as the signed-in employee, and the only callers (assign-to picker, "log a request for someone", People) are admin screens. It is now **admin-only** (employees get 403); employees read only their own record. No new directory feature was created.

**History (new employee screen, `#/history`).** Read-only list of the employee's own assignments, newest first: equipment name, asset tag, type (*Permanent* / *Temporary checkout*, with "return by" date/time), since (check-out timestamp), returned timestamp, and a *Current* / *Overdue* marker for open ones. It uses the existing record (`GET /api/users/:id`, own id only) — no second history model, no duplicated assignment logic. Reachable from the desktop sidebar, the mobile Account page and a link on Home. Past rows aren't links (a returned asset may no longer be available to open); current rows link to the asset. The returned-history window is now the most recent **200** (was 50; also applies to the admin person page); the screen says so if it is reached.

**Profile.** `/api/me` now includes `building`. The employee **My profile** shows name, email, department, job title, phone and **Building** read-only, with a note that IT manages them; password change, avatar menu and sign-out are unchanged. **Behavior change to note:** employees previously could edit their own name/department/title/phone through the profile form (`PUT /api/me`); per the "profile is read-only for this slice" requirement that is now **admin-only** (employees get 403; IT edits people on the People screen). Admins keep their editable profile form.

**Employee navigation & My equipment (dedicated destination).** Manual QA found that an employee's current equipment lived behind a "Mine" filter inside Browse. Now: desktop sidebar **Home · My equipment · Browse equipment · Scan · Requests · History — separator — My profile**; on mobile the tab bar is unchanged and **My equipment** (then History, My profile) is on the Account page (More tab — superseded in Slice 4: now the **Profile** tab), plus a "See all" link on Home's My-equipment card. **My equipment** (`#/equipment`, employees only; an admin is redirected to Home, their own equipment stays there) shows only the signed-in employee's *active* assignments from the existing dashboard data (no new model/endpoint logic), in two groups: **Permanent assignments** (name, tag, category/model/location, "Assigned since", *Assigned* status) and **Temporary checkouts** (name, tag, details, checked-out time, **return by** date/time, *Overdue*), each with its own empty state; return-request banners / "Return requested" / "Dropped off" markers behave as before; every row opens the normal employee-authorized asset page. **Browse equipment** now means "equipment I can get": for employees the list is always *available, not archived, and not already held by me* (their own equipment, other people's, repair/lost/retired/disposed and archived assets never appear); the "Mine" and "All"/status chips are gone for employees (they would only duplicate this rule), and the status / holder / `employee_id` / `include_archived` query filters are ignored server-side for employees; searching can no longer match a holder's name (it could previously reveal who holds a multi-seat license). Search, category filter, scanner, self-checkout permissions, requests and asset-detail authorization are unchanged. Admin navigation, Assets list and filters are unchanged. Related small fixes: an employee's request detail no longer links to an asset page they may not be allowed to open; the scanner shows a friendly "isn't available right now" message for unavailable equipment.

**Tests:** `test/employee-access.test.js` (own vs other profile/history/requests, My equipment data and nav/Browse wiring, directory, admin-only endpoints, available/own/unavailable/archived asset detail, list sanitization, lookup, photo files, action leakage, Building and read-only profile, front-end wiring); one assertion in `test/self-checkout.test.js` updated (the minimal employee directory it pinned is gone). Seed unchanged.

**Technical debt / follow-ups (not blockers):** `held_by_other` and "not available" branches in the asset page are now rarely reachable for employees (kept, harmless); an employee's open request for equipment that later becomes unavailable shows the name but can't open the asset; asset photos are still served from local disk (object storage is later); History has no filters/pagination beyond the 200-row window; Employee Actions (slice 2) will decide what, if anything, employees may edit.

#### Slice 2 — Employee Actions V1 (**COMPLETE** — implemented 2026-10-02, `feature/employee-actions-v1`; merged via PR #13; seed:verify chore PR #14)

Tests: baseline 230 → **251 passing / 0 failing** (`test/employee-actions.test.js`: 21 new; one existing guard test in `test/request-integrity.test.js` extended to cover the `issue` type). One new migration (**10**). `npm run seed:dev` unchanged and verified; browser-checked against the seed as an employee and as an admin.

**Audit (before any change).** `requests` had types `equipment` / `return`, statuses `open|approved|denied|dropped_off|completed|cancelled` with per-type CHECKs, a single live-return unique index (asset + employee), and a transition guard in `src/requests.js`. There is **no `opened_at` / `in_review`** (those are the future lifecycle in Section 11 / `DATA_MODEL_PHASE_1.md` §3.7). Employee cancel was: own *equipment* request, live (`open|approved`), except a permanent request IT already approved. Return requests could only be created by IT (`POST /api/assets/:id/request-return`, admin); an employee could only say "I'm returning this" (`return-notice`, creates a `dropped_off` row). My equipment had no actions.

**Request equipment — unchanged (generic flow preserved).** `POST /api/requests` always files for the signed-in employee (a `user_id` in an employee's body is ignored). Employees see only their own requests with type, status, submitted time, asset reference when one exists, and message. No catalog/model redesign.

**Request return (new, employee-initiated).** `POST /api/assets/:id/my-return-request` (employee; the IT-only `request-return` route is untouched). The asset must be visible to and **currently held by the caller** (else 404 if invisible / 400 if visible but not theirs). It creates the *same* live `return` request IT can create (status `open`, shown as **Return requested**); the assignment is **not ended** — it ends only when IT checks the asset in, which completes the request as before. The existing **I've dropped it off** step follows. No second assignment/return model. The partial unique index plus an explicit check refuse a second live return request (second tap, IT already asked, or already dropped off). Whether a return request was the employee's own is derived (`created_by` account belongs to the requesting employee → `self_initiated`), so the UI says "You asked to return…" rather than "IT asked you to return…" and the employee's badge counts only requests IT is waiting on them for. Primary location: **My equipment** (a *Request return* button on each row); also on the asset page next to the existing *I'm returning this*.

**Report issue (new).** `POST /api/assets/:id/report-issue` — held-by-caller only, required message (≤1000 chars; blank and exact open duplicates refused), asset set from the route. **Design decision:** the current request model *can* represent it safely, so an issue is a **third request `type`, `'issue'`**, in the same table, queue and state machine — not a new table or ticketing system. Migration 10 rebuilds `requests` (ids, AUTOINCREMENT mark, indexes, every migration-9 CHECK kept) to widen `type` and add `issue → open|completed|cancelled` and `issue ⇒ asset_id NOT NULL`. Lifecycle: `open → completed` (IT **Mark resolved** with an optional note shown to the employee as *Resolved*) or `cancelled` (employee **Withdraw**, or IT **Dismiss**). Never approved/declined/dropped off. IT sees it in Requests, Needs attention, the open-request count and the asset page, with employee and asset context; activity records `issue_reported` / `issue_resolved`. An issue stays open if the asset is checked in (IT resolves it). **Not built (future):** comments, attachments, priority, SLA, email notification, categories.

**Rescind rule actually implemented (server-enforced, one function `cancelBlock`, exposed to the UI as `can_cancel`) — SUPERSEDED by Slice 5 (`opened_at`; an employee can no longer rescind once IT has opened or approved a request).** No `opened_at`-style "IT has started processing" marker exists and adding one is the lifecycle redesign that was explicitly out of scope, so the rule is expressed with the statuses that exist: an employee may cancel **only their own** request **while it is live and nothing has happened to it**: *equipment* `open|approved` (existing behaviour; a permanent request IT approved/assigned is final); *return* only one **they started**, only while `open` (not once dropped off, never one IT asked for — they answer that with *I've dropped it off*); *issue* while `open`. Completed / declined / cancelled are terminal; another employee's request is 403. IT may cancel any live request (unchanged; still can't cancel a permanent request that produced its assignment). **Limitation → future lifecycle work:** an employee can still rescind an `open` equipment request IT is already looking at, because "opened by IT" is not recorded; the full `submitted → in_review(opened_at) → …` model (Section 11 / §3.7) remains future.

**Requests page.** Each row now shows a type caption (*Equipment / Return / Issue report*), the asset (tag) when there is one, submitted time, status (type-aware: *Return requested*, *Open → Resolved* for issues), the short description, IT's note, and only the actions the server says are allowed (*Cancel / Withdraw*, *I've dropped it off*). Detail sheet reads "Reported by / Description" for issues. Admin: *Mark resolved · View asset · Dismiss* on issues; everything else as before. No new visual system.

**Technical debt / blockers found:** none blocking. Notes: employees get no email/notification for issue resolution or an IT response (notifications are future); a self-initiated return request does not email IT (IT sees it in Requests/badge; "dropped off" still emails IT as before); `request-return`/`return-notice`/`my-return-request` are three similarly named routes kept deliberately for compatibility (could be consolidated with the lifecycle work); issue duplicate detection is exact-text only.


**Dev tooling note — isolated seed verification (`chore/isolated-seed-verification`).** `npm run seed:dev` rebuilds `./data-dev`, which breaks a `npm run dev` watcher that has that database open. `npm run seed:verify` (`scripts/seed-verify.js`) reuses `seedDatabase` from `seed-dev.js` against a temp directory under the OS temp dir, re-opens it as a fresh app, checks `/setup` is not offered and the documented admin login works, removes the directory, and exits non-zero on failure. `seed:dev` is unchanged. Use `seed:verify` for automated/agent verification; reserve `seed:dev` for an intentional local rebuild with the dev server stopped. Suite: 251 → 254 (`test/seed-verify.test.js`).

#### Slice 3 — Hierarchical Equipment Catalog + Specific Requests V1 (**COMPLETE** — implemented 2026-10-01, `feature/hierarchical-equipment-catalog`; merged via PR #15)

*(Where this report says Browse lists only available items, that was superseded by the Search + Discoverability refinement: Browse now also lists temporarily unavailable shared assets.)*

Tests: baseline 254 → **289 passing / 0 failing** after the QA corrections below (`test/catalog.test.js`: 34 new; one seed test added; one FK-list assertion in `test/people.test.js` extended for the new `requests.catalog_node_id`). One new migration (**11**). `npm run seed:verify` passes (55 assets, 7 requests). Browser-checked on a phone viewport (390×844) and desktop (1280×800) against an isolated seeded copy — the developer's `data-dev` was not rebuilt.

**Audit findings.** `assets.category` is NOT NULL free text (default `Other`) with free-text `brand`/`model` — kept untouched as compatibility/display/import data. Categories came from a settings list (`settings.categories`), used by the Browse filter, the asset form and the request form. `requests` already carried a free-text `category`, an optional `asset_id` (RESTRICT FK) and `requested_assignment_type`; nothing recorded *how specific* an ask was. CSV import/export keys on column names (category/brand/model; unknown columns ignored). Employee visibility (Slice 1: available, not archived, not already held) lives in `canViewAsset`/`GET /api/assets`.

**Schema (migration 11).** `catalog_nodes(id, parent_id → catalog_nodes RESTRICT, name, name_key, archived_at, created_at, updated_at)` — a generic parent/child tree; no level-specific columns. `name_key` = trimmed, whitespace-collapsed, lower-cased name; a unique index on `(COALESCE(parent_id,0), name_key)` makes sibling names unique ignoring case/spacing, **archived siblings included** (so a restore can never collide). `CHECK (parent_id <> id)` blocks self-parent; real cycle prevention (move under own descendant) is in `src/catalog.js` because a CHECK cannot see ancestors. Added `assets.catalog_node_id` (RESTRICT FK, optional, indexed) and `requests.catalog_node_id` (RESTRICT FK) + two snapshots `requests.catalog_path` and `requests.asset_label`. No sort-order column (siblings sort alphabetically; no drag-and-drop). No table rebuild was needed (plain `ADD COLUMN`).

**Existing data / migration behavior.** One **root** node per existing category — the settings list (or the built-in defaults on a brand-new database) plus any category text found on assets, de-duplicated ignoring case/spacing — and every asset is linked to the root matching its own category text. That copies what the data already says. **Nothing deeper is inferred** (Apple is not "Mac", Dell is not "Windows"); IT maps assets to deeper nodes. Existing requests are untouched. `category/brand/model` stay on assets. `settings.categories` stays in the database/API for compatibility but nothing in the UI uses it any more (the Settings textarea was replaced by a link to the catalog; Browse filter and asset form read the catalog roots).

**Rules (server-enforced, `src/catalog.js`).** Names required, ≤100 chars, may not contain `>` (the path separator). Cycles refused on move (self, child, deep descendant). A node is **live** only if it and every ancestor are not archived; employees get live nodes only; new children / assets / requests need a live target; restore needs a live parent. Delete exists only for an entry nothing refers to (no children, assets or requests) — otherwise archive (FK RESTRICT is the backstop). Renaming or moving a root/branch re-syncs `assets.category` to the root name; **requests are never rewritten**.

**API.** `GET /api/catalog` (any signed-in user; employees get live entries with `path`, `child_count`, `available_count` only; admins may add `?include_archived=1` and get `archived_at/live/asset_count/request_count`). Admin only: `POST /api/catalog`, `PUT /api/catalog/:id` (rename and/or move), `POST …/archive`, `POST …/restore`, `DELETE /api/catalog/:id`. `GET /api/assets?catalog_node=ID` filters a whole subtree (employee: live entries only, plus the existing Browse contract). Assets accept `catalog_node_id` (admin); the category text then follows the root. Asset payloads carry `catalog_path`.

**Requests.** `POST /api/requests` accepts `catalog_node_id` (any level). `asset_id` absent → **any matching asset**; present → **specific asset**, which must be filed under the chosen node, and for an employee must be available, not archived and not already theirs — anything else (held by someone else, in repair, archived) is refused with a 404/400 that does not reveal the holder. The server derives `category` (root name), `catalog_path` (full path text *at request time*) and `asset_label` (`TAG — name` at request time); none of these are read from the request body. A legacy payload (free-text `category`/message, or one particular asset from its page) still works; an asset-page request records the asset's catalog position automatically. Approval, permanent requests, return requests, issue reports, rescind rules and the state machine are **unchanged**. Admin "Assign an asset" now lists available assets under the requested catalog entry. Emails show the requested path and "any matching / specific item".

**UI.** *Employee* — Request equipment is a two-step sheet: (1) drill through the catalog, (2) choose **Any matching asset** or **A specific item** (list of the available assets beneath the choice; permanent option when a specific item is chosen). Mobile-first: ONE chooser implementation renders a column per level and CSS shows only the deepest level on a narrow screen (≥60px touch rows, an obvious Back button, tappable breadcrumb, selection summary and Continue pinned at the bottom); on ≥700px the same markup becomes cascading columns (Camera | Sony | A7 IV). Choosing an entry selects it and opens its children, so a person can stop at any level. Requests rows (employee and admin) show the requested path and an *Any matching asset* / *Specific asset: TAG — name* tag. *Admin* — new **Equipment catalog** page (sidebar + More — Slice 4: the admin hamburger): expandable nested list, Add category, per-entry Manage sheet (full path, add child, rename, move, archive/restore, delete when unused), Show archived. Asset create/edit has an **Equipment catalog** field using the same chooser; asset detail shows the path.

**CSV.** Export gains a trailing `catalog_path` column (readable `Laptop > Mac > MacBook Air`); every existing column is unchanged. Import accepts an optional `catalog_path` (alias `catalog`): an exact path (ignoring case/spacing) to a *live* entry links the asset (and syncs its category); an unmatched path is **reported per row and the row still imports without a link** — nothing is guessed. Old files with no such column import exactly as before.

**Seed.** `seed:dev` now builds a 44-entry demonstration catalog through the real API (Laptop → Mac/Windows → family/brand → model; Desktop, Monitor, Camera → Sony/Canon/Nikon → model; Lens → mount → lens), adds 7 camera/lens assets (tags NC-00049…NC-00055; earlier tags unchanged), maps 26 assets to deep model nodes (the HP laptop stays filed at the Laptop root and the Sony a6400 under Other, to show coexistence), loans one of the two Sony A7 IV bodies out (the request flow must not offer it), and files an any-matching and a specific-asset catalog request. Now 55 assets, 7 requests, 13 current / 4 historical assignments (9 permanent / 4 temporary).

**QA correction (same PR, 2026-10-01) — two UX fixes; schema/model unchanged.**
- **Employee Request equipment, wide screens (≥900px):** one screen instead of two. Cascading columns sit on the left (sized to their content — no reserved blank area); the request form (selected path, *Any matching asset* / *A specific item* + available items, Details, Needed by, Send) fills the space on the right and follows the selection. Any level is requestable immediately, with or without children — there is no Continue. Phones keep the one-level-at-a-time drill-down with the separate details step. Same chooser, same `GET /api/catalog` and `GET /api/assets?catalog_node=` on both.
- **Admin Equipment catalog is an explorer:** clicking a category *inspects* it; **Manage** (and **+ Add subcategory**) are explicit buttons and the only way into structural edits. (Presentation superseded by the category card grid below — the first cut's tree + split-pane was removed.)
- **API:** no new endpoint. `GET /api/catalog` (admin) `asset_count` now means non-archived assets at the entry *or any descendant* — exactly what `GET /api/assets?catalog_node=ID` lists for an admin, so a count always equals the visible contents (tested for every node); the old direct figure is now `direct_asset_count` (archived included — it is what blocks a delete). Employee payloads still carry no admin counts.
- **Related fix found in QA:** an asset created (or CSV-imported) without a catalog entry is now filed under the live root named by its category text — the same rule migration 11 applied — so a category's contents are complete (an unknown category stays unlinked; a CSV row that names an unmatched path is still left unlinked and reported).

**Category card grid (UX decision, same PR) — replaces the chip strip and the admin split-pane/tree.** Employee Browse equipment and the admin Equipment catalog both navigate the catalog as a **responsive card grid** that wraps onto as many rows as needed (CSS `auto-fill`: 1 card on very narrow phones, 2 on phones, ~3–4+ on wider screens; no horizontal scrolling anywhere). Same drill-down model and same APIs (`GET /api/catalog`, `GET /api/assets?catalog_node=`) on every screen: tap a card to go one level deeper, breadcrumbs jump back, a Back button shows on narrow screens. Cards show the name, the count (employees: *N available*, the server's employee figure; admins: *N assets · N subcategories*) and a chevron.
- **Virtual "All in <name>"** (no schema, no endpoint, never stored in `catalog_nodes`; label is always `All in` + the entry's name — no pluralization): the first card at any level that has child categories; it is the existing subtree filter. *Employee Browse:* the top level offers *All equipment* (shows the full available list only when chosen) and the categories; inside a category *All in <name>* is active on arrival and lists every employee-visible available asset in the branch (held, archived, repair, lost, retired never appear; the count on a card equals the list, tested); children are further cards; a leaf shows its sibling cards. *Search* stays on top: while it has text the grid steps aside and results are global, still the available-only employee view (verified: a loaned/held asset is not found by tag, name or holder name).
- **Admin catalog:** root = category cards (*Add category*). Inside a category: breadcrumb, **Manage** and **+ Add subcategory** (acting on that category), then the cards (*All in <name>* first) and, below, the assets for the scope — what is filed directly in the category, or with *All in <name>* every non-archived asset in the branch with its sub-path (browse-only: no Manage/Add controls in that view). Cards and breadcrumbs only navigate; opening a category never opens Manage. An asset row opens the normal asset page.
- **Request flow:** unchanged hierarchy workflow. The *A specific item* list is now clearer: whole row is the tap target with an explicit *Select* / *✓ Selected* pill, a selected-item summary appears under the list, **Send to IT is disabled until an actual item is chosen**, and switching back to *Any matching asset* clears the choice (the row visibly deselects).

**Navigation correction (same PR) — real in-app Back, URL-backed drill-down, contextual Add.** Both drill-down screens keep their state in the hash query, so the URL is the single source of truth: Browse equipment `#/assets` · `#/assets?node=<id>` · `#/assets?all=1` (All equipment); admin catalog `#/catalog` · `#/catalog?node=<id>` · `#/catalog?node=<id>&all=1` (the virtual "All in <name>", a browsing view of the real entry). Cards, breadcrumb segments and **Back** all navigate to those URLs; a small hook in the existing hash router (`S.soft`, no router library, no routing rewrite) repaints the screen in place when only the query changes, and anything else goes through the normal router. Consequences: **Back** (the app's existing lightweight `.back` link — the same one asset pages use, e.g. "‹ Assets" — placed above the page title so the title never moves, a real link to the parent's URL, labelled with where it goes: "‹ Camera", "‹ Equipment catalog", "‹ Browse equipment"; apart from Manage / Add subcategory since it is navigation, not an action; absent at the root) goes one step up — out of *All in <name>* to the entry, then parent by parent to the root (A7 IV → Sony → Camera → All categories / All equipment); the sidebar *Equipment catalog* / *Browse equipment* link always lands on the root, even from a nested view (the old state no longer survives anywhere); browser Back/Forward walk the catalog trail instead of jumping to an unrelated page; a refresh or deep link to a nested URL restores it; an unknown/hidden node in the URL falls back to the root; deleting the entry you are inside steps up to its parent. **Contextual Add (admin):** the root shows **+ Add category**; inside any category (including its *All in <name>* view) the button is **+ Add subcategory** and creates under that real entry; Manage stays separate and also acts on the real entry.

**Employee Browse is a page-per-level drill-down, same model as the admin catalog:** `#/assets` is the top-level category grid; `#/assets?node=<id>` renders THAT entry as the whole page (title = its stored name, "‹ <parent or Browse equipment>" above it, breadcrumb, then only its own child cards — *All in <name>* first — and its assets). The top-level and sibling cards are never shown again below the root; a leaf shows just its available assets. Search stays under the title and is global while it has text; clearing it returns to the entry in the URL.

**Context-aware titles and asset Back (same PR).** The admin catalog page title is the **real current entry's stored name** (root: *Equipment catalog*; inside: *Appliance*, *Camera*, *Sony*, *A7 IV*; the virtual *All in <name>* keeps the real entry's name as the title, with the scope shown in the breadcrumb). The asset page's "‹ Back" now reflects **how the person got there**: lists that open assets add their origin to the link — `#/asset/44?src=catalog&node=11` (also `&all=1`), `src=assets`, `src=browse&node=…`, `src=equipment`, `src=history`, `src=requests&tab=…`, `src=home`, `src=scan`, `src=person&id=…` (admin person page → "‹ <person name>"), `src=activity` — and the page resolves a real link and label from it ("‹ Appliance", "‹ Assets", "‹ Sony", "‹ My equipment", "‹ History", "‹ Requests"). It does **not** use browser history. Only the known source types for the viewer's role and numeric node ids are accepted (an admin-only source for an employee, junk or unknown ids are ignored); the label comes from the stored node name, never from query text. No/invalid source → the existing fallback (admin "‹ Assets", employee "‹ Browse equipment"). The origin survives a refresh, and carries into the asset's Edit form (Cancel/Save return to the same asset page with the same origin). Opened from a virtual *All in <name>* view the label says so ("‹ All in Camera", "‹ All in Sony" in Browse where an entry with children always shows its whole branch; "‹ All equipment" from the top-level list) while the URL stays the same real-entry `all=1`/`node=` route — nothing is stored. The Scan page, admin person pages, the Activity log (and the Home activity feed) and the return-request banner (it keeps Home or My equipment) all tag their origin too. Only links from the Scan page are tagged for scanning — the scan buttons on Browse/All assets stay source-less (fallback). Still fallback (no source): typed URLs, old links, scan buttons on other screens, the asset-page "View asset" links from other contexts not listed here.

**Future (NOT implemented): desktop view preferences.** Catalog/Browse on desktop may later offer **Grid** (current default), **List** and **Columns** views. This must be presentation only — the same catalog data, routes (`?node=`) and behavior; no separate data or logic per view.

**Technical debt / follow-ups (not blockers).** No audit trail for catalog edits (only the asset's `edited … catalog` row); no drag-and-drop reorder (alphabetical); catalog `available_count` counts the Browse contract only (no reservations); `settings.categories` is dead data kept for compatibility (safe to drop later); an employee can still rescind an `open` request IT may already be looking at (needs the `opened_at` lifecycle work); asset-side `category` text is still free text for assets with no catalog link; no bulk "map many assets to a node" UI beyond CSV; the dev server must be restarted to pick up migration 11.


#### Slice 4 — Mobile Shell + Responsive Navigation V1 (**COMPLETE** — implemented 2026-10-02, `feature/mobile-shell-responsive-nav`; merged via PR #16; **real-iPhone QA passed**)

Front-end only — no schema, API, role or authorization change. Tests: **291 passing / 0 failing** (289 → 291: one new nav-structure test; two existing source-inspection tests that pinned the old "More" page now pin the Profile page entries). `npm run seed:verify` passes.

**Navigation (revised after real-phone review — different secondary navigation per role).** The bottom tab bar is now **five tabs for both roles: Home · Browse (admin: Assets) · Scan (raised, now truly centred) · Requests · Profile**. The old "More" tab and page are gone; `#/more` redirects to the new Profile page so old bookmarks still land somewhere sensible.
- **Profile tab (`#/account`, `viewAccount()`)** = the signed-in person. *Employee:* My equipment, History, My profile, Sign out. *Admin:* My profile, Sign out. No administration destinations. It lights up for its own pages too (`#/equipment`, `#/history`, `#/profile`). On desktop (≥900px) `#/account` just goes to `#/profile` since the sidebar already lists these.
- **Hamburger = administering the system, admins only.** Employees get **no hamburger at all** (the button is not rendered and `openDrawer()` refuses for non-admins). For admins a top-left button (under 900px) opens a drawer holding exactly People, Equipment catalog, Print labels, Import / export, Activity log, Settings — no My profile, no Sign out, no identity block (the header just says "Administration"). The drawer is **flush with the left screen edge** (`.sheet-backdrop.drawer-backdrop`: the earlier version was centred by the generic sheet-backdrop rule, leaving a gutter) and slides in from the edge. It reuses the existing overlay mechanics (`#sheet-root`, `.sheet-backdrop`, body scroll lock), so the router's normal "clear overlays on navigation" also closes it; it also closes on backdrop tap, Escape, a link tap and when the viewport widens to the desktop layout.
- The desktop sidebar, avatar menu and all role/route guards (`admin:` / `employee:` route options, server-side checks) are unchanged — navigation chrome only. Verified: an employee still gets 403 from `/api/users`.

**Shell / scrolling / safe areas.** Normal document scrolling is unchanged (no app-shell scroll container): the header is `position: sticky`, the tab bar `position: fixed`, and `main` carries bottom padding for the tab bar + `env(safe-area-inset-bottom)`. Added: left/right `env(safe-area-inset-*)` on the header, content and tab bar (landscape notch); `dvh` alongside `vh` for sheets, lightbox and the sign-in/boot screens; the mobile `.shell` no longer forces `min-height: 100vh - 56px` (that made short pages scroll on phones whose browser bar is expanded) — it now applies only with the desktop sidebar. Top safe-area padding was already present and is `0` in a normal browser tab.

**Responsive fixes found by auditing every employee and admin screen at 390px (horizontal-overflow scan + visual check).** (1) **Admin Home was 772px wide on a 390px screen** — `.grid` had no explicit column, so its single auto column grew to its widest nowrap content; `.grid`/`.grid.stats`/`.grid.two` now use `minmax(0, 1fr)` columns (this one was real, visible horizontal scrolling). (2) A long status pill ("Return requested") squeezed list-row titles to a few letters; at ≤480px pills in list rows may wrap onto two lines. All other audited screens had no horizontal overflow and were left alone.

**Intentionally NOT changed.** No redesign; the catalog card grid, page-per-level drill-down, `.back` links, page titles and contextual asset Back (Slice 3) are untouched. The asset-detail sticky title bar (under the header) is still tall on phones. The scanner overlay is not closed by route changes (existing behaviour). No PWA/standalone/Add-to-Home-Screen work: the pre-existing manifest, service worker and Apple meta tags are untouched, and the old "add this app to your home screen" tip that lived on the More page was dropped with it.

**README.** Added a "Testing on a real phone" section (LAN IP, `DATA_DIR=./data-dev PORT=3000 npm run dev`, firewall prompt, camera scanning still needs HTTPS, don't `seed:dev` just for this).

**Verification performed.** `npm test` (291/0); `npm run seed:verify`; `node --check public/app.js`; Chrome (DevTools emulation) at 390×844 as admin (Dana) and employee (Bailey) against a scratch copy of the dev seed: horizontal-overflow scan of every route for both roles; admin drawer contents, position (left: 0) and open/close paths; Profile page contents per role, Profile tab active state on its pages, `#/more` redirect, no hamburger for employees, Sign out; five tabs fit at 390px and 320px, Scan centred at 195px; sticky header and bottom tab bar while scrolling; sheets; Browse drill-down and asset Back; 898px (hamburger + tab bar) and 1280px (sidebar, no hamburger, no tab bar). The author's own checks were emulation only; the physical-device review is recorded below.

**Real-iPhone QA (Slice 4) — PASSED (user, 2026-10-02).** Confirmed on a physical iPhone: employee Profile tab and its grouping of personal destinations; admin hamburger holding administration only; admin drawer flush with the left edge; five-item bottom nav (labels, raised centred Scan); safe-area spacing; Chrome's browser UI collapses normally on longer pages, so no fullscreen/standalone or other browser-chrome workaround is needed. Only Chrome on the iPhone was reported; Safari-specific and Firefox behaviour were not separately reported.



#### Slice 5 — Admin Request Workflow V1 (**COMPLETE** — implemented 2026-10-02, `feature/admin-request-workflow-v1`; merged via PR #17; UI approved from browser screenshots, no real-device QA)

Tests: 291 → **321 passing / 0 failing** (`test/admin-requests.test.js`: 30 new; two existing rescind tests updated for the new rule). `npm run seed:verify` passes. One new migration (**12**). Browser-checked (Chrome DevTools emulation) at 390×844 and 1280×800 against a scratch copy of the dev seed (migration 12 ran on it): admin queue + state filter, opening a detail (Submitted → In review), the assign-an-asset flow, the specific-asset button, the employee Closed view, desktop queue, and pill/filter/detail wording (including a simulated older server). The user reviewed the resulting screenshots and approved the UI. **No real-device (iPhone/Safari/Firefox) QA was performed for this slice.**

**Audit (before any change).** `requests` already had the types `equipment` / `return` / `issue`, statuses `open|approved|denied|dropped_off|completed|cancelled` (per-type CHECKs), a transition table in `src/requests.js`, an approve/deny/resolve/cancel API, an admin Requests screen with Open/Closed tabs and a detail sheet, and Slice 3's catalog snapshot columns (`catalog_node_id`, `catalog_path`, `asset_label`). It lacked the "IT has opened this" marker and any user-facing lifecycle vocabulary, so most of this slice is a lifecycle layer over the existing model, not a new model.

**Lifecycle — derived, no new status value.** `submitted` = `open` with `opened_at` NULL · `in_review` = `open` with `opened_at` set · `approved` · `fulfilled` = `completed` · `denied` (shown "Declined") · `rescinded` = `cancelled` by the requester's own login · `cancelled` = closed/dismissed by IT · plus the return-only `dropped_off`. Computed in `src/requests.js` (`lifecycle`/`withLifecycle`) and returned as `lifecycle` on request rows (list, dashboard, asset page). Rationale: the DB CHECKs, transition table, live-return unique index and every existing query keep working; "in review" is a fact (IT opened it), not a second thing to keep in sync. Closed/cancelled/denied/completed keep their meaning; labels adapt for issues ("Resolved" / "Withdrawn" / "Dismissed") and returns ("Return requested").

**Schema (migration 12).** `requests.opened_at TEXT`. Backfill: rows already `approved|denied|completed`, and `cancelled` rows NOT cancelled by the requester's own login, get `opened_at = COALESCE(resolved_at, created_at)` so nothing handled by IT becomes rescindable; plain `open` rows and employee-rescinded rows stay NULL. No table rebuild.

**`opened_at` rules (server-enforced).** New requests start NULL. `POST /api/requests/:id/open` (admin only; **no GET side effects**) sets it once on a live request; repeats and closed requests are no-ops (never overwritten). Any admin action (approve, deny, resolve, cancel/dismiss, admin check-in completing a return, admin-triggered drop-off) also sets it (`transition(..., { actorIsAdmin })`, `COALESCE(opened_at, now)`). An employee's rescind is refused in `cancelBlock` (`can_cancel` is false) **and** the UPDATE itself carries `AND opened_at IS NULL` (`requireUnopened`), so IT opening and the employee rescinding at the same moment cannot both win. **Behaviour change:** an employee can no longer rescind an *approved* request (approval opens it).

**Admin workflow.** *Queue* (`#/requests`, evolved not replaced): Open/Closed tabs kept; admins get a state filter (All + Submitted / In review / Approved / Dropped off on Open; Fulfilled / Declined / Rescinded / Cancelled on Closed, each with a count; kept in the URL as `?tab=…&state=…`); every card and the detail show the lifecycle pill. *Detail* (the existing sheet — viewing it as an admin calls `/open`, so Submitted flips to In review and the list behind updates): requester, type, catalog path as requested, any-matching vs specific asset (`asset_label` snapshot), notes, status, submitted time, **Opened by IT**, IT note and who/when resolved; after fulfilment the row reads *Assigned asset*. *Actions by type and state:* **equipment** — Approve, Decline, and Assign (fulfil) which approves and assigns in one step (an open request may be fulfilled directly; approval is not a prerequisite — kept because direct check-out has always worked this way); **return** — Check in (the existing check-in, which completes the request), Cancel; **issue** — Mark resolved (with note), Dismiss. Invalid transitions stay rejected by the transition table (e.g. approving a denied request, approving a return, resolving an equipment request).

**Fulfilment rules (new server checks in `POST /api/requests/:id/approve`).** A request that named one item can only be fulfilled with that item (the UI skips the picker and offers *Assign <tag>*); an *any matching* request needs an asset filed under the requested catalog entry (its subtree), else 400 with the requested path; requests with no catalog entry (older, category-only) are not catalog-checked. Availability, archived/in-repair/retired/lost, seat capacity and "this person already has it" remain createAssignment's rules; the assignment and the request's completion are one `BEGIN IMMEDIATE` transaction (tested with a forced failure: the assignment rolls back). **Check-in is now one transaction** with completing the employee's return request (it wasn't before); tested the same way.

**Employee-facing.** Same Requests/Home screens, now with the shared vocabulary (Submitted → In review → Approved → Fulfilled / Declined / Rescinded), IT's note, an *Opened by IT* row in the detail, and Cancel/Withdraw offered only while the server says the request is still unopened. Privacy unchanged (own requests only; every admin action 403s for employees — tested).

**Presentation (approved).** One vocabulary everywhere — card pill, detail sheet and state filter all read the same mapping (`stateKey`/`statusLabel` in `public/app.js`); a raw database status is never displayed, even for a row from an older server that lacks `lifecycle`. Equipment/return: Submitted · In review · Approved · Dropped off (returns) · Fulfilled · Declined · Rescinded (requester cancelled) · Cancelled (IT closed). Issue reports close as Resolved / Withdrawn / Dismissed; their filter options appear only when such a report exists. A live return's pill reads "Return requested" (the one deliberate exception to the filter's wording). The detail's closing row is "Closed" (or "Decision" when approved). Icons: equipment request = the existing `box` glyph (the tray/inbox glyph is reserved for a future Inbox), issue = warning triangle, return = return arrow; on phones (<700px) the request-card icon block is removed outright (`display: none`) so the text uses the full row; desktop keeps it.

**Technical debt / follow-ups (not blockers).** (1) The admin direct check-out (`POST /api/assets/:id/checkout`) still ends one request via `completeEquipmentRequests` outside the assignment's transaction (the request-based fulfilment path is atomic; this one's emails are sent inside `doCheckout`, so wrapping it needs the notifications moved after commit). (2) Request detail is a sheet, not a routable page (no deep link to one request). (3) The state filter is client-side over the existing 500-row list. (4) A return request IT creates starts as *Submitted* until an admin opens it. (5) The scanner overlay is still not closed by route changes (Slice 4 note). (6) An older-server fallback cannot tell *Rescinded* from *Cancelled* (shows Cancelled) — only relevant if the front end and server are ever out of step.




#### Slice 6 — Asset Availability Calendar V1 (**COMPLETE** — implemented 2026-10-02, `feature/asset-availability-calendar-v1`; merged via PR #18; read-only; no real-device QA)

Tests: 321 → **346 passing / 0 failing** (`test/availability.test.js`: 19 new, including a stubbed run of the real Back-resolution code for every entry point; two existing source-inspection tests updated for the new, intended Calendar nav item and origin). `npm run seed:verify` passes. **No schema change, no migration.** Browser-checked (Chrome DevTools emulation) at 390×844 and 1280×900 against a scratch copy of the dev seed with extra check-outs and a Camera › Sony › A7 IV tree: employee Browse root / nested node / deep model / single asset, admin global / catalog-scoped / asset-scoped, month navigation, refresh and Back. **No real-device (iPhone/Safari/Firefox) QA.**

**What exists in the data (audit).** Availability can only be derived from: open `assignments` (`checked_out_at`, `returned_at IS NULL`, `assignment_type` permanent | checkout; a checkout has a required `due_date` and optional `due_time`, a permanent one has none), `assets.status` (available | checked_out | maintenance | retired | lost | disposed), `assets.archived_at`, and seat capacity (`license_seats`). There are **no reservations, bookings or holds**, so nothing here looks further ahead than an open assignment says. History (returned assignments) is not shown: the calendar only looks forward from today.

**Availability rules (one model, `src/availability.js`).** Per asset and per day from today on (earlier days are `past`, no state):
- `available` — a seat is free (no open assignment, or fewer than the seat count). With no reservations a free asset is free.
- `occupied` — every seat is taken for that day: a **permanent** assignment (open-ended, no invented return date); a **temporary checkout through its due date** (the due date itself is still out); or an **overdue** checkout (due date passed — still out, return date unknown, so occupied into the future).
- `expected` — every seat is taken today but the checkouts holding them are due back before that day. The conservative middle state: a due date is a promise, not a booking, so these days are **never** called available (shown as "Expected back", dashed, and as "+N" on a multi-asset day).
- `repair` (status maintenance — no end date is stored, so unavailable for all future days), `ineligible` (retired / lost / disposed) and `archived` — unavailable on every future day.
- Multi-seat assets are available while any seat is free, occupied only when all are taken.
Aggregate days (several assets) show "available count" and "+expected count".

**API.** `GET /api/availability` — `?node=<catalog id>` (that entry and its whole subtree, via the existing `catalog.subtreeIds`), or `?asset=<id>`, or neither (everything); `&month=YYYY-MM` (default current). Both node and asset → 400; non-numeric → 400; unknown/hidden → 404; bad month → 400; signed-in required. Returns the scope (type/id/title/path), `today`, the month window and, per asset, its state today, a `days[]` state per day of the month, and `periods[]` (occupied / expected ranges). One shared function serves global, node and asset scope; no per-screen logic. Node/global scopes never list archived assets (an admin may ask for one asset directly); capped at 1000 assets like the asset list.

**Privacy.** *Employees* get an anonymous, narrower view: only non-archived assets that are `available` or `checked_out` (plus anything they hold), live catalog entries only, **no holder name, department, email, notes, assignment type or ids**, tag shown only where they could already open the asset, "Yours" marked; repair/retired/lost/disposed/archived assets are absent and requesting one directly is a 404. This is a new, deliberately anonymous surface: **`GET /api/assets/:id` and the employee asset list are unchanged** (an employee still cannot open an asset someone else holds). *Admins* additionally get each period's holder (name, department), assignment type and dates, repair/ineligible assets, and rows link to the asset page.

**UI.** One route `#/calendar` for both roles (month grid + a selected-day panel listing assets by state; mobile-first, 7-column grid readable at 390px, no horizontal overflow; legend and an honest footnote). URL-backed: `?node=` / `?asset=` / `&month=` / `&day=` (defaults omitted). **Contextual Back (product rule: every non-root screen reached from another has the lightweight `.back` link above its title):** the calendar carries its source route in the URL as `from=<hash route>` (e.g. `#/calendar?node=7&from=%23%2Fcatalog%3Fnode%3D7`). Every entry point — header icons, the admin sidebar item and the hamburger item — is a `data-cal` link; one delegated click handler stamps `from` with the page being left, *at click time* (so Browse drill-down, catalog "All in", All-assets filters and an asset's own origin come back exactly), and keeps the existing `from` when Calendar is clicked while already on a calendar. Back is a plain link to `from` (never browser history), so it survives refresh and month/day changes (`replaceState`, `from` preserved). Labels come from real data: a catalog entry's / asset's / person's name, else the page name. `from` is accepted only if it is an in-app hash route (never `#/calendar`, `#/login`, other schemes or oversize values). A calendar with no (or invalid) `from` — typed/shared link — falls back by role: **Browse equipment** (employee) / **All assets** (admin). The error screen has the same Back. Assets opened from a calendar row return to that calendar (browser Back keeps month/day). Back per entry: Browse root → *Browse equipment*; Browse node → *<node>*; employee/admin asset → *<asset>* (its own context preserved); Equipment catalog root → *Equipment catalog*; catalog node → *<node>*; All assets → *All assets* (filter kept); sidebar/hamburger → the page it was clicked on (e.g. *Requests*, *People*, *<person>*). Entry points: employee **Browse** header (right of the title, above search — **from Slice 6.1 only inside a catalog entry: none at the Browse root**; in a category = its subtree, on a leaf/model = that model); admin **Equipment catalog** header (same, at every level; action order *Add category | calendar icon*); admin **All assets** header (opens the global calendar); **asset detail** (a small icon in the top row, both roles — scopes to that asset); admin **sidebar** and **mobile hamburger** "Calendar" (opens globally). Employees get no nav item for it. Assets opened from the calendar return to it. The month arrows allow the current month through 12 months ahead.

**Wording (late change).** The employee self-checkout action now reads **"Check out now"** (was "Check out to me") on the asset page and in the self-checkout sheet; behaviour, API and permissions are unchanged, and admin wording is untouched. Earlier QA notes in this file keep the old label as historical record. **Approved direction for a later slice (NOT implemented here):** asset detail offers *Check out now* + *Reserve*; Reserve only for a specific physical asset; only the single-asset calendar may support selecting a future start/end; global, category and model calendars stay read-only and never show Reserve.

**Dev-environment fix (found during Slice 6; repeated "I had to restart the server to see my change").** Root causes, all verified: (1) the dev server was being started with `npm start` (plain `node src/server.js`, no file watcher) — and the README's dev-dataset instructions said to; (2) Express 5 passes a listen failure to the `app.listen` callback, which printed the *success* banner and exited 0 — so starting `npm run dev` while an older process still held the port looked like it worked, but the browser kept talking to the old process; (3) the service worker (registered on localhost, a secure context) is network-first with a cached-shell fallback, so whenever the dev server was restarting or down the page silently showed OLD code. Static files themselves were already served from disk with `no-cache` + ETag, and a plain reload with a live server did pick up changes. Fixes: `npm run dev` now sets `NODE_ENV=development` (with `node --watch`); in dev the server sends `Cache-Control: no-store` for everything under `public/` and serves `/sw.js` as a self-removing kill switch; the page never registers the service worker on localhost and removes one an earlier build installed (plus its caches); a taken port now prints a clear error with an `lsof` hint and exits 1 (no false banner); `npm start` outside production prints a note that it does not auto-restart; README now says `npm run dev`. Production (`NODE_ENV=production`) caching and the real service worker are unchanged (tested). Verified live on `npm run dev`: a backend edit restarted the server by itself (child PID changed, API 200); a frontend text edit appeared on a plain reload of the same tab with no restart and no new window, and reverted the same way; an already-installed old service worker and its cache were removed by ordinary reloads; with the server down the tab shows the browser's connection error instead of a stale app. Tests: `test/dev-mode.test.js` (6).

**Remaining manual QA.** The user reviewed and approved the calendar UI from browser screenshots; it has **not** been exercised on a real device (iPhone/Safari/Firefox): month grid and day panel at phone width, the "+N expected back" cell wording, and the header/asset-page icon placement are the things to look at there.

**Technical debt / follow-ups (not blockers).** (1) Because there are no reservations, a future day only changes through due dates — the global calendar is mostly flat; real forward-looking availability needs the (separate, future) reservations model. (2) The date "today" is the server's UTC date, like the existing overdue logic (a late-evening local time can be a day off). (3) Past days are not shown (no history view). (4) A capped 1000-asset scope is flagged `truncated` but the UI only shows a "+" on the count. (5) Employee view hides repair/ineligible assets entirely by design (matches the existing visibility contract) so they cannot learn an item is in repair.




#### Slice 6.1 — Calendar UX / Scope Refinement (**COMPLETE** — 2026-10-02, `fix/calendar-scope-refinement`; merged via PR #19; read-only)

Tests: 346 → **357 passing / 0 failing** (`test/availability.test.js`: existing scope tests updated, 11 new). `npm run seed:verify` passes; `node --check public/app.js` passes. **No schema change, no migration.** Browser-checked (Chrome DevTools emulation, 1280×900 and 390×844, scratch copy of the dev seed + Camera › Sony › A7 IV tree with temporary/permanent/repair assets): employee Browse root / category / deep model / single asset, admin global / catalog-scoped / single-asset, plus the preserved entry points. **No real-device QA.**

**Principle.** The broader the calendar scope, the more summarized it is; the more specific, the more detail. The selected-day panel no longer turns into another inventory list.

**How temporary vs permanent is represented (audited, reliable — no new logic invented).** `assignments.assignment_type` is `NOT NULL`, `CHECK IN ('permanent','checkout')`; a table CHECK enforces *permanent ⇒ `due_date` and `due_time` NULL* and *checkout ⇒ `due_date` NOT NULL*. Legacy rows were classified once by the Phase 1 migration (a due date ⇒ checkout, none ⇒ permanent). A *current* assignment is `returned_at IS NULL`. "Temporary / currently checked out" therefore means exactly `assignment_type = 'checkout'` and open; "permanent" is `assignment_type = 'permanent'`. Overdue = open checkout whose `due_date` is before today (still out, return date unknown).

**Employee.** *Browse root has no Calendar action* (also hidden while searching, which is global). Calendar remains from any catalog entry downward (category, brand, model) and from a single asset's page. Server-side the employee all-equipment calendar no longer exists: `GET /api/availability` with neither `node` nor `asset` is a **400** for employees ("Choose a category or an item first…"), so a typed/stale `#/calendar` link lands on the existing error screen with *Back to Browse*. Admins keep the global calendar.

**(Employee catalog-entry calendars were refined again in Slice 7, see "Category calendar discovery bridge" there: they now also list the entry's actual assets for the selected day. Admin behaviour below is unchanged, and permanent assignments are now left out of the employee pool too.)** **Subtree / global scope = summary only.** Response `view: 'summary'`: `total` and `days[]` of per-day counts, **no asset rows** (employees: `{available, expected, unavailable, off}`; admins: `{available, expected, checked_out, off}`). Panel shows e.g. *October 14 · 8 available · 3 unavailable* (+ *N expected back* when a return date falls before that day). **Permanent assignments are not in the broad admin calendar at all** (product rule, 2026-10-02: the calendar is for shared / temporary-use equipment). Its asset pool is the **schedulable pool**: every in-scope, non-archived asset with **no open permanent assignment** (a `NOT EXISTS` on `assignments` with `assignment_type = 'permanent'` and `returned_at IS NULL`, in the scope query itself, so the total, day states, counts, lists and the 1000-asset cap all use it; returning the permanent assignment puts the asset back). Admin summary categories: **available · checked out** (the open temporary checkout assignments out on that day — exactly the Temporary checkouts list below) **· in repair or not lendable** (+ *expected back* when > 0); no combined "unavailable" and no "permanently assigned" figure. Seeded dev data: global pool 55 → **48** assets (7 permanently assigned assets excluded). Future reservations will add *Reserved*. Not changed: employees (generic *unavailable*, still counting such assets), and a single-asset calendar (an admin asking for one permanent asset directly still gets its full detail). Known edge: a multi-seat license with one permanent seat is excluded from the broad pool as a whole. Employee counts are anonymous (no names, tags, ids, holders) and never reveal repair: a repair/retired/lost/disposed/archived asset is not counted for employees (only an item the employee holds can appear, as unavailable). Month grid cells are unchanged (available count, "+N expected back").

**Single asset = detailed.** Response `view: 'asset'` (unchanged shape: state per day, periods, holder for admins). Panel: asset name + tag, the date, then the state (*Available / Unavailable / Expected back / In repair / Not lendable*) and the extra detail (until when, since when, admin: holder, permanent flag, seats). **This panel is where Slice 7's Check out now / Reserve / date-range controls will live. None exist yet.**

**Admin global and admin catalog-node scope = scheduling-focused.** Same `summary` counts, plus `events[]`: only the open **temporary checkouts** (`assignment_type = 'checkout'`) that touch the month — holder, tag, since, until (+ time) or *past its return date, still out* — soonest return first, overdue first, capped at 200 (`events_truncated`); the panel lists the ones out on the selected day (max 25 shown, "+N more"). **Excluded:** available assets, permanent assignments (inventory state, not calendar events), repair/retired/lost/disposed (counted in the summary only; no end date is stored, so listing them on every day would be noise), expected-back periods after the due date. Admin single-asset keeps full detail. Existing URL-backed scope/month/day/`from`, contextual Back, admin sidebar/hamburger entry, All-assets action, catalog action order (*Add category | Calendar*) and "Check out now" wording are unchanged and re-verified. Also fixed a stray "· ·" in the single-asset subtitle when the tag is hidden from an employee.

**Product decision recorded (2026-10-02) — employee identity.** There is **no requirement to hide an employee's identity from other employees** when knowing who has / reserved shared company equipment is useful, especially for the future **waitlist, release-request and coordination** workflow. This **supersedes the "employees see availability windows, not the identity" privacy rule** in the "Future — Asset Availability Calendar + Reservations" notes below *for that future work*. It is **not** acted on here: the calendar stays anonymous for employees today (holder identity for employees is a deliberate, separate UI/privacy decision for Slices 7–8, not a side effect of this refinement).

**Architecture preserved for Slice 7 (NOT implemented).** *Asset Reservations V1:* specific physical assets only; per-asset **"Require approval for reservations"** toggle, default **OFF** (OFF = reservation confirms automatically, ON = pending IT approval); date-range selection from the **single-asset** calendar; cancel/shorten own reservation; confirmed reservations affect availability. Global/category/model calendars stay discovery/availability views and never carry Reserve. *Slice 8 — Waitlist + Release Requests (the **release-request part was SUPERSEDED**; see D-29 in PROJECT_DECISIONS.md):* waitlist for unavailable dates; current holder/reserver identity may be visible; the holder is notified when someone joins the waitlist; release/shorten workflow. The `view: 'asset'` vs `'summary'` split in `GET /api/availability` is the seam: reservations add periods/states to the asset view and fold into the summary counts via the same day-state function.

**Needs UI review / follow-ups.** (1) Wording: *checked out* / *expected back* / *in repair or not lendable* (admin), *unavailable* (employee). (2) Multi-seat licenses with a permanent seat drop out of the admin broad pool (see above). (3) Employee all-equipment calendar is blocked server-side as well as hidden. (4) Real-device (iPhone/Safari/Firefox) QA still outstanding.



#### Slice 7 — Asset Reservations V1 (**COMPLETE** — implemented 2026-10-05, `feature/asset-reservations-v1`; merged via PR #20)

*(Statements below that Browse "still lists only what is available now" were superseded by the Search + Discoverability refinement. The "no waitlist / release requests / email" scope note is Slice 7 only: Slice 8 added the waitlist and targeted emails and dropped release requests.)*

Tests: 357 → **385 passing / 0 failing** (new `test/reservations.test.js`: 27 tests; existing availability tests updated; ~50 existing test assets now opt in with `available_to_request: true`, see below). `npm run seed:verify` passes; `node --check public/app.js` passes. Browser-checked (Chrome DevTools emulation, 1280×900 and 390×844, scratch copy of the dev seed): employee asset page → Reserve → pick range → confirmation sheet → confirmed; approval-required camera → pending → admin Approve; Requests › Reservations (both roles); Shorten; admin asset form, admin asset page, admin global / catalog-scoped / single-asset calendars; no horizontal overflow on the new screens at 390px. **No real-device (iPhone/Safari/Firefox) QA.**

**Schema (migration 13, no table rebuild).** `assets.available_to_request INTEGER NOT NULL DEFAULT 0 CHECK IN (0,1)`; `assets.reservation_requires_approval INTEGER NOT NULL DEFAULT 0 CHECK IN (0,1)`; new table `reservations` (id, asset_id RESTRICT, employee_id RESTRICT = the person, start_date, end_date `YYYY-MM-DD` GLOB-checked, `status` pending | confirmed | declined | cancelled, `requires_approval` SNAPSHOT of the asset setting at submission, created_by / decided_by / cancelled_by → accounts RESTRICT, decided_at, decision_note, cancelled_at, timestamps; CHECKs: end ≥ start, pending ⇒ requires_approval & undecided, declined ⇒ decided, confirmed ⇒ auto or decided, cancelled ⇒ cancelled_at). **Defaults, exactly: `available_to_request = OFF (0)` and `reservation_requires_approval = OFF (0)`, for new AND existing assets** — the migration deliberately does not expose any existing inventory to employees; IT opts each asset in. Activity actions added: `reserved`, `reservation_requested`, `reservation_approved`, `reservation_declined`, `reservation_cancelled`, `reservation_shortened`.

**Settings (admin only).** Both are on the existing asset add/edit form (card "Employee access": *Available to request* — "Show this asset to employees and allow checkout, requests, and reservations."; *Require approval for reservations* — "Reservations for this asset must be approved by IT.", dimmed with a hint while the first is off). `POST/PUT /api/assets` accept booleans (anything else → 400); an edit that doesn't mention them keeps them; changes are written to the asset history. Employees cannot set them (admin routes). Shown to IT on the asset page (Details). No separate settings page and no employee-visible toggle.

**Visibility semantics (enforced on the server).** `available_to_request = OFF` removes an asset from the employee-facing SHARED pool: Browse list, catalog-subtree results, search (incl. by tag/serial), catalog `available_count`s, the employee calendar (category and single-asset), the scanner lookup ("unavailable"), direct asset/photo access (404), specific-asset requests, self-checkout (also refused inside `createAssignment`) and reservations. Admin views are unchanged. **It never hides equipment assigned to the employee** (clarification received during the slice): My Equipment, permanent assignments, the asset page, Return request / "I'm returning this", report issue and History all follow the ASSIGNMENT. Held OFF assets are the one exception to the pool rule and only for that item's own single-asset calendar: category / everything calendars never count an OFF asset, even the holder's. After check-in an OFF asset is hidden again. The existing contract that an employee cannot open an asset someone else holds is unchanged.

**Reservation model and states.** One reservation = ONE physical asset (single-seat only; multi-seat licenses are refused) + an inclusive range of calendar dates ("Oct 10–Oct 12" holds the 10th, 11th and 12th); plain date strings, server "today" (UTC, like the rest of the app). States: `pending` (only when the asset requires approval; holds NOTHING), `confirmed` (holds the dates), `declined`, `cancelled`. No other state was needed (an elapsed confirmed reservation is shown as *Past* by date, not by a status). Server-side `phase` (pending / upcoming / active / past / declined / cancelled), `can_cancel`, `can_shorten` and `shorten_min` are returned on every row so the UI never guesses a rule.

**Automatic vs approval-required (per ASSET, snapshot per reservation; no global rule).** Approval OFF → a valid conflict-free reservation is created `confirmed` immediately. Approval ON → created `pending`; it does not block anyone (others may submit overlapping ones, also pending). IT Approve **re-checks the whole range at approval time** (still requestable and lendable, requester active, start not past, no confirmed overlap, no occupying checkout) and otherwise fails cleanly with 409 leaving the row pending for IT to decline; an existing confirmed reservation is never overridden. Decline records an optional note. Toggling the asset's setting later does not change an existing row.

**Conflict rules and transactions.** Refused (409/400/404, never just a disabled button): not `available_to_request` (404, indistinguishable from absent), archived, repair / retired / lost / disposed, multi-seat, malformed / reversed / past-start range or end after 2100, an overlap with another CONFIRMED reservation, an overlap with the same employee's own live reservation on that asset, and any day the asset is OCCUPIED by an assignment (permanent, temporary checkout through its due date inclusive, overdue). The days AFTER a checkout's due date are only "expected back" in the availability model, so they CAN be reserved (that is what reserving ahead is for). Every write (create, approve, decline, cancel, shorten) runs in ONE `BEGIN IMMEDIATE` transaction that re-reads what it depends on, so two simultaneous requests cannot both claim the same dates (SQLite has a single writer; there is no range-exclusion constraint, so the application rule + the row CHECKs are the guard). Tested sequentially and with parallel requests in one Node process (which serialize), plus a source check that each write is immediate; a true multi-process race is not exercised.

**Check out now.** `createAssignment` (the one place every checkout goes through) refuses (409) a temporary checkout whose span [today, return date] — or a permanent assignment (no end) — runs into ANOTHER employee's confirmed reservation, with a message that suggests an earlier return date; the reserving employee is not blocked by their own reservation; a pending reservation never blocks; IT is held to the same rule (message says to cancel the reservation first). Self-checkout of an asset that is not `available_to_request` is a 404 (route and `createAssignment`). No reservation-to-checkout "conversion" exists: a reservation simply stays confirmed (the checkout then shows as occupied on its own days).

**Availability / calendars.** New day state `reserved` (a confirmed reservation covers the day and nothing physically occupies it): it wins over available / expected, and an occupying assignment wins over it. Pending requests never change a day (shown only to their owner and to IT, as a line in the day detail). Broad calendars (category / everything) stay read-only and gain only a `reserved` COUNT (employees and admins); they never list reservations and never carry Reserve. The **single-asset calendar is the only place with reservation controls**: the server returns `reserve.allowed` per viewer (a linked employee and an eligible asset; independent of the self-checkout permission; never for IT); the same grid becomes a date picker (tap first day, tap last day; same day twice = single day; blocked days can't be picked; the range is checked across months), then a confirmation sheet (asset, tag, start, end, length, and "confirmed right away" vs "IT must approve"), then submit. `&reserve=1` opens it in picking mode. URL-backed month/day/source and contextual Back are unchanged. Employees see reserved ranges anonymously (only whether one is theirs); IT sees the holder.

**Employee reservation management.** Requests › **Reservations** tab (and a card on the asset page): view, **cancel** own live reservation (any time until it is over; pending ones too), **shorten the END date** of own CONFIRMED reservation (never extend, never move the start, never into the past; freed days are available at once; "to keep it longer, make a new reservation"). Employees cannot touch anyone else's (403) and cannot approve or decline.

**Admin reservation workflow.** The same Requests › **Reservations** tab, extended: "Waiting for approval" (exactly two actions: **Approve** — primary button, no icon — and **Decline** — red, with an optional reason; no Cancel while it is pending), "Upcoming & active" (an approved reservation moves here and **Cancel reservation** is available from then on), "Past & closed"; the tab shows a pending count and the Requests nav badge now includes reservations waiting for IT. Asset page: a Reservations card for that asset (with the same actions); Details show *Available to request* and the approval setting. Auto-confirmed reservations are visible there and in the tab. **IT may also cancel a CONFIRMED reservation** (a pending one is declined, never cancelled by IT: the server rejects it with "Decline it instead"; the employee can still withdraw their own pending request) (not literally requested; needed so a conflicting reservation can be cleared before a checkout, and the Check out now message points to it). IT does not create reservations on behalf of employees in V1.

**Category calendar discovery bridge (same slice; product clarification: "I need ANY camera").** An EMPLOYEE's catalog-entry calendar keeps the day's counts (now available · checked out · expected back · reserved) and ALSO lists the actual assets of that entry's subtree for the selected day, grouped Available → Reserved → Checked out → Expected back, as compact tappable rows (name, tag where the employee could already open the asset, and the day's detail such as "Reserved Oct 12 – Oct 14" or "Out · until Dec 1"). Excluded: permanently assigned equipment (now left out of the employee pool and counts too, the same schedulable pool IT's broad calendar uses), assets that are not `available_to_request`, repair / not-lendable assets (employees never see them), and everything outside the entry's subtree. The list is server-side (`assets` on the employee node response, capped at 300 rows with a "showing the first N" note; counts always cover everything; anonymous: no holders, reservations only flag "mine"). Each row opens THAT asset's single-asset calendar on the SAME day (month and day carried in the URL), and Back returns to the category calendar ("<entry> calendar", same month/day); reserving stays on the single-asset calendar only: there is no Reserve button in the list. `safeFrom` now accepts exactly one calendar form as a Back target (a catalog-entry calendar whose own `from` is a plain route), so calendars never chain. The Browse root still has no Calendar action and the company-wide employee calendar stays closed. Admin broad calendars are unchanged (counts + temporary checkouts, no asset list). **To make that bridge work, an employee may now reserve an item that is currently checked out by someone else** (the reservation endpoint accepts anything the calendar shows: shared pool, not archived, available or checked out; refused days are still the days it is out): this closes technical-debt item (1) below. The asset page / record of an item another person holds remains a 404 (visibility contract unchanged).

**Browse UI addendum (same slice).** (1) *All equipment is now the real default of employee Browse*: at the root it is drawn selected and its list (the employee-visible, requestable assets) renders immediately, with no click; returning to the root (breadcrumb, Back, sidebar) restores it; clicking the selected card is a no-op (it no longer toggles the list off); an old `#/assets?all=1` link is tidied to `#/assets`; category / entry navigation is unchanged. Admin was checked for the same mismatch and needed no change (the admin asset list shows "All" selected with its list on load; the admin catalog root is a category grid with no "All equipment" card). (2) *"Send IT a request" is a real secondary button* (existing `.btn` style, same request sheet and flow): in the empty state of a list (nothing available / no search match) and as a footer button under a non-empty list, instead of a tiny inline link. **Future note (NOT implemented): request and reservation workflows are expected to integrate with email / Gmail notifications later; no email behaviour was added or changed here.**

**Future communication direction (recorded, NOT implemented; no email integration and no in-app messaging platform in Slice 7).** Request and reservation communication is expected to use **email**, not an in-app messaging system. Product direction to preserve: employees should be able to leave a **note when submitting** a request or reservation where appropriate; IT should be able to leave **notes / reasons on decisions** (the optional note on Approve / Decline and the cancellation actions already stores `decision_note`, which is the hook); and **decline and cancellation reasons can later be included in the email notifications**. Today the reason is stored and shown in the app only (e.g. "IT: …" on the reservation row), and the Requests badge remains how IT notices new work.

**Other decisions made in this slice.** **Permission rule (confirmed by the product owner): "Check out now" requires the employee's existing self-checkout permission; "Reserve" does NOT.** Reserve needs only `available_to_request = ON` and the normal reservation eligibility (not archived, lendable, single-seat) plus a linked active employee; an employee without self-checkout sees *Request this* and *Reserve* on an eligible asset, and a reservation is still confirmed or sent for approval per the asset's setting (covered by a server test). (An earlier cut of this slice wrongly tied Reserve to self-checkout; removed.) Conflict responses use HTTP 409. The dev seed now opts everything except the desktops into the shared pool (so hidden desk computers are demonstrable) and makes the Sony FX3 approval-required; existing tests that need employee-visible assets create them with `available_to_request: true`.

**Needs UI review.** Reserve button next to Check out now on the asset page; the picking states (a picked range is ONE block: every day filled light violet, the first and last day strong violet, taken days dimmed; keyboard focus ring kept; checked in light and dark themes) and the new violet "reserved" hue, distinct from the blue "expected back"; the confirmation sheet and Requests › Reservations layout; "Reservations" tab placement on the Requests page; calendar footnote wording.

**Technical debt / discovered work (not blockers).** (1) *(Resolved in this slice by the category-calendar bridge: employees can reserve future days of an item someone else has out. They still cannot open that item's asset page, and Browse still lists only items available now.)* (2) No notifications of any kind (no email to IT for a pending approval, none to the employee on approve/decline/cancel): IT relies on the Requests badge. (3) No maximum reservation length or advance limit (only end ≤ 2100). (4) A reservation does not "convert" to the checkout, and a late return against a following reservation is not handled (the reservation stays; the calendar shows the physical checkout as occupied). (5) Turning `available_to_request` off leaves existing confirmed reservations in place (they keep blocking and stay visible to their owner and IT); IT cancels them if wanted. (6) CSV import / export do not carry the two new settings (imports default OFF). (7) Employee Browse still lists only currently-available items (unchanged). (8) "Today" is the server's UTC date. (9) No admin-created reservations or admin extension / move.

**Future admin defaults (recorded, NOT implemented).** Admins may eventually set defaults for newly added assets (default `available_to_request`, default approval requirement), possibly at category / catalog-node / model level. Current hard defaults stay: `available_to_request = OFF`, `reservation_requires_approval = OFF`. Future work may also split `available_to_request` into "employee-visible" and "employee-requestable"; deliberately NOT done now (one flag controls both).

**(SUPERSEDED by the Slice 8 section below: the product owner dropped the release-request workflow. Original note kept for history.) Slice 8 — Waitlist + Release Requests.** An employee can join a waitlist for unavailable reserved dates; employee identity does not need to be hidden (consistent with the Slice 6.1 decision); the current holder / reserver may see who is waiting; they should eventually be notified that someone is waiting; the current holder may voluntarily shorten / release their reservation (the Shorten action from this slice is the building block). It will need the visibility change in debt item (1).



#### Slice 8 — Waitlist + Availability Holds + Targeted Email Notifications (**COMPLETE** — 2026-10-05, `feature/waitlist-holds-notifications`; merged via PR #21)

*(Final test count after the two QA rounds below: 434 passing / 0 failing at merge.)*

Tests: 385 → **412 passing / 0 failing** at first implementation, **425 after QA round 1 (see below)** (new `test/waitlist.test.js`: 27 tests then; one assertion in `test/reservations.test.js` scoped to migrations ≤ 13). `npm run seed:verify` passes; `node --check public/app.js` passes. Browser-checked (Chrome DevTools, scratch copy of the dev seed, 1280 and 390 px, as Casey/employee and Dana/admin): employee calendar → reserved day → *Join waitlist* sheet → entry; Requests › Reservations *Waitlisted* row; current reserver cancels → *Available — confirm within 24 hours* row with Yes / No buttons and Requests badge; confirm → *Reserved · from the waitlist*; admin Waitlist section (FIFO, names, hold deadline, Remove); Settings › IT email save + From/Reply-To preview. No console errors. **No iPhone/Safari QA.**

**Product rules (as built).** Waitlists are for ONE specific physical asset and an inclusive date range. **There is no release-request workflow:** nothing in the app asks, lets anyone ask, or pressures a current reserver to give anything up (no such route exists). Joining never changes the blocking reservation. Employee identity is not hidden. Nothing is ever reserved automatically.

**Lifecycle.** An employee may join when the requested range is blocked by someone's **confirmed** reservation (or by another team's active hold, so they queue behind it). Refused with a clear 409 when the dates are actually free ("reserve instead"), when the item is only checked out and nobody reserved it, when they already have an overlapping reservation or waitlist entry, or for past/invalid dates. States (`waitlist_entries.status` → what screens say): `waiting` Waitlisted · `held` *Available — confirm within 24 hours* · `fulfilled` → Confirmed / Waiting for approval (from the reservation made) · `declined` No longer needed · `left` Left waitlist · `removed` Removed by IT · `expired` Expired. **FIFO** = `(created_at, id)`. When dates may have freed (cancel, shorten, IT declines a waitlist-born reservation, hold declined/left/removed/expired, or the sweep) the queue is evaluated inside the same `BEGIN IMMEDIATE` transaction: each *waiting* entry, oldest first, whose **entire** range is free (confirmed reservations, other holds, open checkouts, asset still reservable, employee active, no own overlapping reservation) is granted a **24-hour hold** (`HOLD_HOURS`). An older entry whose range is still blocked does **not** freeze a younger eligible one; overlapping entries are served in FIFO order because each hold blocks the ones behind it; non-overlapping entries can hold at the same time. **A hold blocks every other reservation attempt** (`reservations.findConflict` and `create`/`approve`), the held person's own plain reserve is pointed at *Confirm*, and the calendar shows held days as reserved (anonymous to others; the held person gets their entry id + deadline, IT the person). An **expired hold blocks nothing the instant it expires** (compared with the DB clock), even before the sweep records it, so it can never permanently block the queue. **Confirm** re-checks everything transactionally and applies the normal reservation rules (confirmed at once, or *pending* when `reservation_requires_approval` is ON); if the dates are no longer reservable the confirm returns 409 and the entry goes back to *waiting* (or *expired* if the start has passed). A **pending** reservation made from a hold keeps its place: nobody else is offered those dates until IT approves (kept) or declines (dates go to the next in line). **Decline / leave / IT removal / expiry** release the hold and offer the dates to the next eligible entry. IT can **remove** any open entry; IT cannot reorder, confirm or decline for anyone (no such routes).

**Schema (migration 14).** New table `waitlist_entries` (asset_id/employee_id RESTRICT, start_date/end_date GLOB + `end >= start`, `status` CHECK, `hold_started_at`, `hold_expires_at`, `hold_email_at`, `closed_at`, `closed_by`, CHECKs: a hold carries its timestamps, a closed entry says when it closed; indexes on asset/status/created and employee/status) and `reservations.waitlist_entry_id` (nullable FK, RESTRICT). No table rebuild; existing reservations untouched. Dates stay plain `YYYY-MM-DD` with overlap logic in few places, so Slice 8.1 can add optional times without redesign.

**API.** `POST /api/assets/:id/waitlist`, `GET /api/waitlist[?status=open|closed]` (own for employees, all for IT), `GET /api/waitlist/:id`, `POST /api/waitlist/:id/{confirm,decline,cancel}` (confirm/decline: the owner only; cancel: the owner leaves, IT removes; others 403). Entries carry server-decided `phase`, `position`, `hold_expires_at`, `can_confirm/can_decline/can_leave/can_remove`. `GET /api/availability` single-asset rows gain `holds`, `waitlist` (IT: everyone; employee: own) and hold days count as `reserved`. Code: `src/waitlist.js` (rules), `src/reservations.js` (holds block; `insertReservation` shared; queue re-evaluated on cancel/shorten/decline), `src/availability.js`, routes in `src/server.js`. A **sweep every 60 s** (and 20 s after start) records lapsed holds, moves the queue (this is what notices a check-in or an asset-setting change) and sends any hold email still owed.

**Emails (targeted; no broad notification system).** Transport **reused, nothing added**: the existing `src/mailer.js` (nodemailer over Google Workspace SMTP, env-configured `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `APP_URL`; unsent mail is logged to the `outbox` table when SMTP is not configured). Two new `notify` templates: **(1) `waitlistJoined`** to each distinct *confirmed* reserver whose reservation overlaps: "Another team is waiting for X", who + dates, **"No action is needed. Your reservation is unchanged."**, optional contact with the waiter; no release CTA. **(2) `waitlistHold`** to the held employee: asset, tag, dates, **hold deadline** (in `APP_TIMEZONE`, new optional env var, else server zone), confirm / decline instruction, says it goes to IT when approval is required; link `#/requests?tab=reservations`. Sent **after** the transaction commits, never inside it; an email failure (throwing hook or rejecting SMTP) never changes state (tested). **No duplicates:** the hold email is claimed once per hold with an atomic `UPDATE ... hold_email_at IS NULL`, so repeated evaluation/sweeps never re-send; a failed send is recorded as `failed` in the outbox and not retried into duplicates. A fresh hold after an expiry is a new event and is emailed.

**IT email identity (Settings › "IT email").** Two settings in the existing `settings` key/value table via the existing `GET/PUT /api/settings` (`it_email_name`, default "Nutricost IT"; `it_contact_email`, default empty = none). Validated server-side (name required, ≤ 80 chars, no control characters / quotes / angle brackets; email trimmed + lower-cased, valid single address, ≤ 254, no whitespace/commas/semicolons/brackets; all-or-nothing). **Credentials are never stored there:** the settings API rejects any key that looks like a password / secret / token / API key / SMTP / OAuth setting with a 400 pointing at the server environment; those stay in env vars / Railway secrets. Sending: **From = display name + the verified sender address** (`MAIL_FROM`/`SMTP_USER`), **Reply-To = the IT contact**, because the provider may reject a From it has not verified. Only if the operator sets `MAIL_ALLOW_IT_FROM=1` (provider permits it, e.g. a Gmail "Send mail as" alias) does the contact address become the From. The identity applies to **all** app email (one code path), not only waitlist mail. The two keys are returned to admins only (stripped from an employee's `/api/me`).

**Decisions made autonomously (flag if you disagree).** Joining is also allowed against another team's active hold (they queue behind it). The informational blocker email goes only to reservers with a *confirmed* overlapping reservation. IT removal does not email the employee. Employees' Requests badge now also counts waitlist holds awaiting their answer. Reservation rows made from a hold say "from the waitlist". Check-ins / asset-setting changes are picked up by the sweep (≤ 60 s) rather than inline.

**Technical debt / follow-up.** (1) No real SMTP send was exercised (tests use a fake transport; local run logs to the outbox); Google Workspace delivery of the new mails and the From/Reply-To behaviour need a real send on stage. (2) Hold-expiry wording uses the server zone or `APP_TIMEZONE`, not each reader's zone. (3) No reminder email before a hold expires; no email to the employee when IT removes them; no email to the current reserver when the waitlist later empties. (4) Calendar summary views (category/all) count held days as reserved but do not list waitlists. (5) The sweep is an in-process timer: fine for one instance, needs a job runner/lock if the app ever runs multiple instances. (6) Waitlist ranges are not auto-trimmed; an entry expires when its start date passes.

**Left for Slice 8.1.** Everything time-of-day (see below). Not built here: optional start/end times, 1 PM release, partial-day / split reservations, recurring reservations, max duration, Gmail mailbox sync, in-app messaging, notification preferences, arbitrary transfer.

#### Slice 8 — QA round 1 corrections (2026-10-05, same branch; merged in PR #21)

Tests: 412 → **425 passing / 0 failing** (`test/waitlist.test.js` now 40 tests; one source-text test in `test/reservations.test.js` follows the reservation POST into the shared sheet). `npm run seed:verify` and `node --check public/app.js` pass. Browser-checked (Chrome DevTools, scratch copy of the dev seed, `MAIL_TEST_RECIPIENT` on, 1280 and 390 px): reserved-day click, sheet adapting reserve ↔ waitlist, join, Edit dates, shorten confirmation, admin tab/nav badge, Settings test-mode banner + Outbox wording. **Not verified: a real SMTP delivery** (no credentials were available; see below).

**Reserved-date UX (root cause of the QA complaint).** Tapping a reserved day only selected it and, in picking mode, showed a red "isn't free" toast; the click handler then scrolled the page down to a separate Waitlist card holding the Join button. Now **tapping a day reserved by someone else immediately opens ONE reusable date sheet** (`rangeSheet` in `public/app.js`): no toast, no scrolling, the clicked day preselected, an intro that says "*<date> is already reserved*, choose the whole range you need". The sheet asks the server what the chosen range means after every date change (**`GET /api/assets/:id/range-check`**, advisory, writes nothing; shares `classify()` with join/edit so the answer can't drift) and the button follows: all free → **Reserve** (or *Submit for approval*), blocked by a reservation/hold → **Join waitlist**, otherwise a clear reason with the button disabled (invalid dates, you already hold those days, checked out with no reservation, item unavailable). The normal "Review & reserve" flow now opens the same sheet (the old separate review sheet is gone). While picking a range, tapping a reserved day as the end of the range, or picking an end beyond one, opens the sheet for that full range instead of an error. Your own reservation/hold days just select. The calendar's old inline Join card now only lists *your own* waitlist places.

**Edit dates (employee waitlist).** Requests › Reservations › Waitlist row: **Edit dates** + Leave waitlist (only while *Waitlisted*; an offer is answered, not edited). Opens the same sheet prefilled; the sheet always says **"Changing your dates updates your place in line."** `PUT /api/waitlist/:id` (owner only; another employee and IT get 403) re-validates exactly like joining (eligibility, past/invalid dates, own overlapping reservation or other waitlist entry, and the range must still be blocked by a reservation/hold, otherwise 409 "reserve instead"). **FIFO reset:** the entry takes a new `queue_seq` (strictly increasing key, migration 15) so it goes behind everyone already waiting for the new range; `created_at` stays "first joined", `queued_at` ("in line since") is what the row shows. `queue_seq` replaces `(created_at, id)` as the order everywhere (queue evaluation, position, lists, calendar), fixing same-second ties. Edits do not email anyone (a different reserver newly overlapped is not notified; debt).

**Admin awareness.** New `GET /api/reservation-counts` (server-computed, active items only): IT `attention` = reservations waiting for approval + entries currently *waiting or held*; employee `attention` = offers awaiting their answer. It drives both the Requests nav badge and the Reservations tab count. Closed/expired/declined/left/fulfilled entries never count. No read receipts (the badge stays while entries are active, by design).

**Shorten confirmation.** After the server transaction succeeds the toast reads "Reservation shortened to <resulting range>." (from the API's response; a failed shorten is an error, never a success). Toasts longer than 40 characters now stay 4.5 s. (The earlier toast existed but was short and easy to miss; not reproduced as missing.)

**Real SMTP / `MAIL_TEST_RECIPIENT`.** Existing mailer (unchanged transport) reads exactly: `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default 465, implicit TLS; others STARTTLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (default `SMTP_USER`), `APP_URL`, plus `MAIL_ALLOW_IT_FROM`, `APP_TIMEZONE` (Slice 8) and new `MAIL_TEST_RECIPIENT`. **It only sends when both `SMTP_USER` and `SMTP_PASS` are set**; Google Workspace therefore needs an **App Password** (2-Step Verification on; admin must allow App passwords) for the sending mailbox. **A password-less IP-allow-listed SMTP relay is NOT supported by the current mailer** (the README used to claim it was; corrected). Credentials stay in `.env` / Railway secrets, never the DB. **`MAIL_TEST_RECIPIENT=<address>` (server environment only; not editable in Settings):** every outgoing message is addressed to that one address; subject becomes `[DEV for <intended>] <subject>`, a yellow banner naming the intended and actual recipient is injected at the top of the body; From / Reply-To / IT identity unchanged; business logic and stored employee addresses untouched; outbox `to_addr` keeps the *intended* recipient and new `outbox.delivered_to` records the redirect. An **invalid** value fails closed: nothing is sent to anyone and the outbox row is `failed`. Unset = normal delivery, byte-for-byte as before. Settings shows "Email test mode: all outgoing email is being redirected to <address>."

**Outbox clarity.** Settings › Outbox is labelled "development / debug record" with an explanation: a row never means anyone received an email; *Not sent* = email isn't configured so nothing left the app; *Sent* = the mail server accepted it; *Failed* = rejected (hover for the reason); redirected rows show "delivered to / would go to <test address> (test mode)".

**Bug found and fixed while testing.** A refused late *Confirm* (hold already expired) had already moved the queue and offered the dates to the next person, but their hold email waited for the next sweep. Every waitlist mutator now dispatches owed hold emails even when it throws (regression test added).

**Technical debt added.** Edit dates sends no email to a reserver newly overlapped by the new range. Client-side sheet logic (which button shows) has no DOM test harness; the *decision* it shows is server-side and tested (`range-check`), the rendering is browser-QA'd only. No real SMTP delivery has been exercised yet.

**Needs your manual QA.** (1) Real send: your own `SMTP_USER`/`SMTP_PASS` + `MAIL_TEST_RECIPIENT`, then trigger a waitlist join and a hold and confirm both arrive in your inbox with the `[DEV for …]` subject and banner, correct From name and Reply-To. (2) The sheet on a real phone (date inputs, keyboard). (3) Tap-through on Safari.

#### Slice 8 — QA round 2 (2026-10-05, same branch; merged in PR #21)

Tests: **425 → 433 passing / 0 failing** at the time of writing (434 at merge). `npm run seed:verify` and `node --check public/app.js` pass. Real Gmail delivery with `MAIL_TEST_RECIPIENT` was confirmed by the product owner; **that configuration was not changed**.

**Seeding sent real email: root cause.** `scripts/seed-dev.js` (and `test/helpers.js`) tried to disable mail by `delete process.env.SMTP_USER / SMTP_PASS` and then loading `src/server.js`. Its first line is `src/env.js`, which calls `process.loadEnvFile('.env')`; that loader fills every variable that is **not currently set**, so the deleted credentials (and `MAIL_TEST_RECIPIENT`) came straight back from the developer's `.env`. Seeding then created ~10 accounts, each sending an invite through the real transport, redirected to the one test inbox. The test harness had the same latent problem (`npm test` on a machine with a real `.env`).

**Guarantee (automatic, nothing to remember).** A process-level flag **`NC_NO_EXTERNAL_MAIL=1`**, set by `scripts/seed-dev.js` (at import and again in `bootApp`, so `seed:dev` and `seed:verify`, which reuses it) and by `test/helpers.js` **before the app is loaded**: (1) `src/env.js` does not read `.env` at all; (2) `src/mailer.js` never creates an SMTP transport from the environment, whatever `SMTP_*` / `MAIL_FROM` / `MAIL_TEST_RECIPIENT` say (a test may still inject a fake transport). Messages are still recorded in the outbox as `logged` ("Not sent"). A normal server never sets the flag, so runtime behaviour is unchanged: Send me a test email → one real message, waitlist and hold emails send, `MAIL_TEST_RECIPIENT` redirect works. (`NC_ENV_FILE` can point `src/env.js` at a different env file; used by the tests.)

**Regression coverage (`test/seed-mail-safety.test.js`, real child processes + a fake SMTP server that counts connections, credentials supplied through an env file exactly like a developer's `.env`).** `seedDatabase()` (what `seed:dev` runs) and the real `scripts/seed-verify.js` make **0** SMTP connections while still creating their invites (≥ 9 outbox rows, all `logged`, none redirected); a **control** run of the real mailer outside seed mode makes exactly 1 connection and delivers 1 message to the redirect address; with the flag set the real mailer makes 0 even with credentials directly in the environment; "Send me a test email" sends exactly one message (one outbox row, redirected, `[DEV for …]`); the harness itself never creates a real transport. Confirmed the seed tests **fail** (1 connection) when the fix is removed.

**Contextual Back: Settings → Equipment catalog.** The Settings button now links to `#/catalog?from=%23%2Fsettings` (the same URL-backed `from` convention the calendar uses; no browser-history trick). The catalog reads it, shows the lightweight `.back` link **"‹ Settings"** at its root, and every catalog URL it builds (cards, breadcrumbs, back links, stale-node fallback) keeps `from`, so drilling down and returning to the top still offers Settings. Opened from the sidebar there is no `from`, so no Settings link. Only `#/settings` is accepted as a source (whitelist). Known limit: opening an asset from inside the catalog and coming back uses the asset page's existing `src=catalog` return, which does not carry `from`.

**Settings layout.** The catalog section is now a header row (new `.set-head`: title + description on the left, "Manage the equipment catalog" on the right, wrapping so the button drops below on narrow screens) above the Locations field, replacing the cramped title/button/description stack.

**Prior QA polish, all in this branch.** Amber `banner warn` FIFO notice in Edit waitlist dates ("Changing your dates updates your place in line."); **Shorten reservation** now shows an always-visible calendar in the sheet (reservation days; tap the new last day; kept days vs released days in green; month arrows when it spans months; summary "New last day … N days released") instead of a pop-up date input; the successful-shorten toast is **green** (`toast(msg, false, 'ok')`) and names the resulting range; **Edit dates emails a current reserver the new range newly overlaps** (only people the old range did not already reach; no repeat to ones already told; informational wording "changed their waitlist request… No action is needed"; failure never undoes the edit). Reserved-day sheet, FIFO reset, admin badge and test-recipient redirect from round 1 are untouched.

#### Search + Discoverability Refinement (**COMPLETE** — 2026-10-05, `feature/search-discoverability`; merged via PR #22)

Small enhancement before Slice 8.1. Tests **434 → 447 passing / 0 failing** (new `test/search.test.js`: 13 tests; three older assertions of the "Browse is available-only" list contract updated on purpose). Browser-checked (Chrome DevTools, 1280 and 390 px, freshly seeded scratch DB, IT and an employee). No real-device QA.

**Root causes.** *Admin All assets:* `GET /api/assets?q=` only did `LIKE` on the asset's own tag / name / serial / brand / model / location (+ holder name): it never looked at `category` or the **catalog path**, so "camera" matched only "Sony a6400 Camera Body" (the one asset whose *name* contains it; the Canon R5, Sony A7 IV, Nikon Z8… live under Camera > … but never say "camera"). *Employee Browse:* the same search, **plus** a pool filter of `status = 'available'`, so anything temporarily checked out disappeared from Browse entirely: the only camera whose name contained "camera" was the a6400, which happened to be on loan → zero results. Discoverability was being decided by transient availability.

**Matching (one rule on every surface).** Normalized, case-insensitive, **token-wise**: the query is split on whitespace and EVERY word must match somewhere (substring), in any order. LIKE wildcards in the query are literal (`%`, `_` are escaped). An asset matches a word through: **tag, name, serial, brand, model, category, location**, or its **catalog entry** (the entry's full path = all ancestor names, and the **Search keywords** of the entry and all its ancestors). IT also matches the **holder's name** (employees never can: no probing who holds what). Employees search only **live** catalog entries (an archived entry's names/keywords do not widen their search). No new dependency or search service.

**Search keywords.** Migration **16**: `catalog_nodes.search_keywords TEXT` (nullable). Stored **on the catalog entry**, not on every physical asset, because the catalog already is the hierarchy: tagging "Camera" once ("photography, video") makes every camera beneath it findable by those words (inheritance is by ancestor lookup at search time, not copied). Normalization (`catalog.normKeywords`): accepts text or a list split on commas / semicolons / new lines; a leading `#` is ignored (nobody types one); trimmed, whitespace-collapsed, lower-cased, de-duplicated, ≤ 40 chars each, ≤ 30 per entry; stored as `"photography, video"`; empty = NULL. Called "Search keywords" everywhere. Edited in the catalog **Manage** sheet (new "Search keywords" button + a plain comma-separated field) via `PUT /api/catalog/:id { search_keywords }` (also accepted on create); admin-only, and not returned to employees. No tagging/taxonomy system.

**Fields searched, per surface.**
- *Admin → All assets:* tag, name, serial, brand, model, category, location, holder name, + catalog path and inherited keywords. (Same status / category filters and layout as before.)
- *Employee → Browse:* tag, name, serial, brand, model, category, location, + catalog path and inherited keywords of **live** entries. Never holders.
- *Admin → Equipment catalog (new search box):* `GET /api/catalog/search?q=` over each entry's name, **whole path** and own + ancestors' keywords (all words must match); archived entries included and flagged; shallowest / own-name matches first; ≤ 60 shown with the total; each result shows its full path (e.g. "Camera › Mirrorless › Canon › R5"), asset count, keywords and "matched by keyword". Empty box = the normal card grid, unchanged; a result opens that entry.

**Discoverability vs availability (employee Browse).** The employee list is now the **shared pool for discovery**: `available_to_request = 1`, not archived, not already theirs, and either `available` **or** `checked_out` **without a permanent holder**. So a temporarily checked-out, reserved-today or held asset is listed and searchable. Unchanged exclusions: `available_to_request = OFF`, archived, repair / retired / lost / disposed, permanently assigned equipment, and the employee's own equipment (My equipment). Each row says what it is **today** (`avail_state`: *Available · Reserved · Checked out*, from the availability day-state function: a confirmed reservation or an active waitlist hold covering today = Reserved; `expected_back` = the earliest temporary-checkout due date, never who has it), using the existing pill terminology (new violet "Reserved" pill matching the calendar). A row that is not available now **opens its availability calendar** (with Back to Browse) where the employee can see when it is free, reserve future days or join a waitlist; the asset page itself is still only for what is available now (`canViewAsset` is **unchanged**: an item someone else holds is still a 404 there). `GET /api/assets?available=1` keeps the old "can I get it right now" view and the "request this specific item" pickers use it. Catalog card counts still say "N available" (available now).

**Verified end to end (employee).** An inherited keyword ("photography", set only on the Camera ancestor) finds a temporarily checked-out, a reserved-today and a held asset for an employee, each with the right state (Checked out · back <date> / Reserved), and opening one goes to its availability calendar (Reserve offered, Back to Browse), not a 404. Automated (`Employee end to end…` in `test/search.test.js`) and in the browser.

**Left for later.** Fuzzy / typo-tolerant or ranked search; search-as-you-type highlighting; keywords on individual assets; searching catalog nodes by their assets' serials/tags; a search box inside the employee catalog drill-down beyond Browse's existing one; seeding default keywords into `seed:dev`.


#### Slice 8.1 — Optional reservation times / partial-day availability (**IMPLEMENTED** — 2026-10-05, `feature/reservation-times`; awaiting review)

Tests **447 → 482 passing / 0 failing** (new `test/reservation-times.test.js`: 35 tests; existing assertions rewritten on purpose where they encoded "overlap = refusal" or an exact summary shape). `npm run seed:verify` and `node --check public/app.js` pass. Browser-checked in Chrome (1280 px and a true 390 px emulation, freshly seeded scratch DB outside the repo, a seeded employee and IT). No real-device QA, no Firefox/Safari.

**Schema.** Migration **17**: nullable `start_time` / `end_time` TEXT on `reservations` and `waitlist_entries` (format CHECK `HH:MM`, < 24:00). All four NULL/value combinations are valid; no CHECK ties them together; existing rows stay NULL/NULL (nothing rewritten). The same-day ordering rule cannot be added to an existing SQLite table, so the application enforces it. Provider-neutral (PostgreSQL can keep TEXT or take TIME).

**One module.** `src/timeRange.js` owns validation (`cleanTime`, `checkOrder`), comparison (`startKey` / `endKey` / `overlaps`, half-open), per-day coverage (`full` / `partial`), `canShorten` and the server-side wording (`when`, `fmtTime`). The browser mirrors the wording in `resvRange` / `calRange` (pure string maths, no `Date`).

**Rules changed (D-45).** `findConflict` (first blocker as a refusal string) became `findOverlaps` (a detector returning what is scheduled). `create`, `approve` and `confirmHold` no longer refuse for overlap and report `availability_warning`; `range-check` returns `overlap`; the old `blocked` outcome is gone (a checkout-only overlap is now `reserve` with a warning). Still refused: self-double-booking, own hold, invalid/past, ineligible. `createAssignment`'s reservation guard became time-aware (still a refusal).

**Waitlist / holds.** Entries and holds carry the times; eligibility ("whole requested time is free"), queue position and the Edit-dates reset use time-aware overlap, so non-overlapping times in one day are offered at once while overlapping ones stay FIFO. Confirming keeps the times (pending/approved too). Shortening (`end_date` optional, new `end_time`) re-evaluates the queue in the same transaction.

**Calendar.** New day state `partial` ("Partially scheduled"); summary counts gain `partial`; Browse's today-state gains `partial`; every confirmed reservation and hold on a day is listed with its hours. Any lendable future day can be asked for (previously reserved/checked-out days could not be picked). Admin reservation rows carry `overlaps_other`.

**UI.** The existing date sheet gained Pickup / Return date + optional time (side by side, also at 390 px, with Clear). Overlap shows the existing confirm-sheet pattern: "Availability not guaranteed" / "This asset has other activity scheduled during part or all of your requested time. You can still submit your request, but availability cannot be guaranteed." / Cancel · Continue; no overlap = no extra step. When a reservation or hold is in the way the sheet offers Join waitlist (unchanged) and **Reserve anyway**. Shorten gained an optional Return time.

**Email.** Existing waitlist emails now print times. New: a requester confirmation (`requestRecorded`: reservation recorded / request received / on the waitlist) with "Requested: …" and, only on overlap, "Availability notice: This asset has other activity scheduled during part or all of your requested time. Your reservation|request has been recorded, but availability cannot be guaranteed." SMTP, `MAIL_TEST_RECIPIENT` and the transport are untouched.

**Bugs found and fixed while browser-testing.** Hidden buttons stayed visible (`.btn[hidden]`); a refusal message was HTML-escaped twice in the date sheet (`You&#39;re`; that one pre-dated this slice); the time field misaligned when its Clear link wrapped.

**Technical debt added.** "Today" and past-time checks are date-level only (a pickup time earlier today is accepted). The existing checkout email still prints its `due_time` raw (`at 13:00`; untouched, outside this slice). The date sheet and Shorten sheet rendering have no DOM test harness (decisions are server-side and tested; wording helpers are tested through `vm`). A waitlist entry cannot be created for a checkout-only conflict (nothing to wait behind): the employee reserves with a warning instead.

**Correction, 2026-10-07 (browser QA found "Reserve anyway" wrong).** D-45 was rewritten: unavailable time is waitlist time. `findOverlaps` became `findBlockers` (+ `plan`); `T.splitFree` cuts a request into free/busy ranges; `reservations.create` reserves the free pieces and waitlists the busy ones in one transaction (`waitlist.classify` is the single decision, now `reserve` / `partial` / `waitlist` / refusals; `insertEntry`, `announceJoined`). Migration 17 was edited in place (still unpushed) to add `request_group` + indexes on both tables. `approve` and `confirmHold` re-check for blockers again; `/checkin` re-evaluates the waitlist in its own transaction. UI: "Reserve anyway" and the blue "Availability not guaranteed" confirm are gone; the date sheet shows one amber notice (partial) or Join waitlist (none free); tapping a calendar day reveals its detail; the sidebar's sticky offset follows the real top-bar height. Email: one confirmation listing Requested / Reserved / Waitlisted. Follow-up: `waitlist.evaluateAsset` re-splits each waiting entry with `reservations.plan` (the same `splitFree`): the freed part is held, the unavailable part stays waiting at the same `queue_seq`; no schema change. Checkout (`createAssignment`, used by manual, scan and request fulfilment) now refuses to run across another employee's active hold or waitlist-born pending reservation, and the hold owner's own checkout closes their hold (`fulfilled`, phase `checked_out`, activity `waitlist_checked_out`). Response windows are now tiered by how soon the offered piece starts (`waitlist.responseMinutes`, `T.nowKey` / `T.fmtStamp` in APP_TIMEZONE; no schema change; `hold_expires_text` served to the screens; email subject/body say "Available for you until <time>"). Tests **482 → 530** (new `test/partial-fulfillment.test.js`; overlap-warning tests rewritten). Local DBs that already applied the old migration 17 (e.g. `./data-dev`) lack `request_group`: rebuild with `npm run seed:dev` (`./data-qa` was rebuilt).

## Appendix A — Archived roadmap checklists (sections 12–17)

*Original 2026-09-28 / 2026-10-02 infrastructure checklists, kept verbatim. The still-open items are condensed into the "Priority Future Work" and "QA / Verification Outstanding" checklists of [PROJECT_STATUS.md](../PROJECT_STATUS.md).*

## 12. Future Infrastructure — Managed PostgreSQL Migration (formerly "Phase 2")

*(Renamed 2026-09-28, was "Phase 2 — Supabase PostgreSQL" — see Section 19 Decisions Log. Railway PostgreSQL is the current preferred host; tasks below are written provider-neutrally so they hold regardless of final host.)*

**Status:** Not Started — **no longer the active Phase 2** (see Section 11a); remains planned as later infrastructure work.

- [ ] Create a DEV PostgreSQL instance (Railway PostgreSQL preferred)
- [ ] Establish migration workflow
- [ ] Convert SQLite schema to PostgreSQL
- [ ] Add constraints
- [ ] Add indexes
- [ ] Add foreign keys
- [ ] Add historical integrity rules
- [ ] Add seed data
- [ ] Replace `better-sqlite3` data access
- [ ] Preserve existing frontend/API behavior
- [ ] Run available database advisors/linters for the chosen host
- [ ] Verify database migration
- [ ] Establish and test backup/restore procedure (see Section 4 "Backup / Restore")


## 13. Phase 3 — Object Storage Migration

*(Renamed 2026-09-28, was "Phase 3 — Supabase Storage" — see Section 19 Decisions Log. Railway object storage, or another S3-compatible provider, is the current preferred direction; tasks below are written provider-neutrally.)*

**Status:** Not Started

- [ ] Create a private asset-photo bucket (S3-compatible object storage)
- [ ] Define file naming strategy
- [ ] Define access policies
- [ ] Replace local filesystem upload storage
- [ ] Preserve thumbnail behavior
- [ ] Preserve cover-photo behavior
- [ ] Test mobile photo upload
- [ ] Test image replacement/removal


## 14. Phase 4 — Authentication

**Status:** Not Started

Preferred direction:

**TBD.** No specific authentication provider is assumed as of 2026-09-28 (previously Supabase Auth — see Section 19 Decisions Log for why that assumption was dropped). The admin and employee portals (Section 8a) will share one authentication system, whatever it turns out to be.

Tasks:

- [ ] Define authentication model
- [ ] Define admin authorization
- [ ] Define employee/login relationship
- [ ] Replace custom password storage
- [ ] Replace custom reset flow where appropriate
- [ ] Replace custom invite flow where appropriate
- [ ] Implement secure sessions
- [ ] Define RLS/access strategy
- [ ] Test admin permissions
- [ ] Test standard-user permissions


## 14a. External Dependency: Railway Access

**Status:** Recorded 2026-09-28. External dependency / staging blocker — not a blocker on current development.

- The project team does not currently have Railway account/project access.
- An administrator is setting up Railway access.
- There is currently no confirmed completion date.

**NOT blocked by this:**
- Phase 1 — Data Model Hardening
- Provider-neutral architecture work
- Local PostgreSQL migration/development
- Automated testing

**Blocked by this (deferred until Railway access exists):**
- Creating Railway services
- Railway PostgreSQL provisioning
- Railway object-storage provisioning
- Railway staging deployment
- Production/staging domain and HTTPS verification
- Real phone-camera scanner QA that requires an HTTPS-accessible environment (see Section 10, Phase 0D — this is the same HTTPS dependency noted there)

No Railway resources were created and no workaround was attempted for the missing access.


## 15. Phase 5 — Railway Staging

**Status:** Not Started — additionally blocked on Railway account/project access not yet being available to the team (see Section 14a). No confirmed completion date for that access as of 2026-09-28.

- [ ] Create Railway service
- [ ] Configure environment variables
- [ ] Configure database connection (to whichever managed PostgreSQL host is chosen — Railway PostgreSQL preferred)
- [ ] Add `/health` endpoint
- [ ] Configure deployment health check
- [ ] Configure domain/HTTPS
- [ ] Configure email provider
- [ ] Verify logs
- [ ] Verify restart behavior
- [ ] Verify deployment process


## 16. Phase 6 — Scanner QA

**Status:** Not Started

Test using actual hardware.

### Mobile

- [ ] iPhone Safari
- [ ] iPhone installed PWA
- [ ] Android Chrome
- [ ] Android installed PWA

### Physical Scanners

- [ ] USB scanner
- [ ] Bluetooth scanner

### Barcode Tests

- [ ] Code 128
- [ ] QR
- [ ] Code 39
- [ ] UPC/EAN
- [ ] Manufacturer serial barcode
- [ ] Small barcode
- [ ] Large barcode
- [ ] Angled barcode
- [ ] Damaged barcode
- [ ] Low light
- [ ] Glare
- [ ] Duplicate barcode
- [ ] Unknown barcode

### Failure Cases

- [ ] Camera permission denied
- [ ] Camera unavailable
- [ ] Unsupported browser
- [ ] Scanner sends Enter suffix
- [ ] Scanner does not send Enter suffix
- [ ] Network interruption
- [ ] Duplicate rapid scans


## 17. Phase 7 — Production Readiness

**Status:** Not Started

- [ ] Security review
- [ ] Database backup strategy
- [ ] Storage backup strategy
- [ ] Restore procedure
- [ ] Error monitoring
- [ ] Audit logging
- [ ] Production admin accounts
- [ ] Real inventory import plan
- [ ] Final staging acceptance test
- [ ] Production deployment
- [ ] Initial real-world inventory import



## Appendix B — Future requirements recorded 2026-10-02 (SUPERSEDED)

> **Superseded.** The availability calendar (Slice 6), reservations (Slice 7), waitlist + holds (Slice 8) and the hierarchical catalog with specific-asset requests (Slice 3) were built. The **release-request workflow described below was dropped** by the product owner (see D-29 in [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md)); the "identity need not be exposed" notes were superseded by the 2026-10-02 identity decision (D-25). Kept for history only.


These extend the existing reservation note in Section 11 (Phase 1E "Equipment reservation") and belong to later Employee Portal V1 work (after slice 2, Employee Actions). No tables, fields, APIs or UI exist for any of them.

##### Future — Asset Availability Calendar + Reservations

> **Update (Slice 6):** the **read-only availability calendar** (current check-outs and due dates only, anonymous for employees, holders for admins) is implemented — see Slice 6 above. Everything below that involves *reserving*, *conflicts*, *waitlists* and notifications is still future work.

Employees should eventually be able to view **future availability** for reservable/shared equipment — cameras, lenses, audio gear and other production equipment.

- **Employee-facing privacy rule:** employees see **availability windows, not the identity** of whoever holds or has reserved the asset — e.g. *Available*, *Unavailable*, *Reserved*. Admin/IT may see the actual holder / reservation owner. **(Superseded for future reservation/waitlist work by the 2026-10-02 product decision in Slice 6.1: there is no requirement to hide identity from other employees when it is useful. The calendar itself remains anonymous until that is deliberately designed.)**
- **Planned capabilities:** asset-level availability calendar; **Reserve for future**; required pickup date/time window as appropriate; required return date/time; overlapping-reservation prevention; current-checkout vs future-reservation conflict handling; admin override/cancel; late-return conflict handling; no-show / pickup expiration; reminders/notifications (later).
- **Waitlist:** if the requested period is unavailable, an employee may join a waitlist / availability queue and may be notified if the requested slot opens.
- **Release request / conflict resolution:** because marketing schedules change dynamically, an unavailable window may optionally let an employee ask the current holder (or a future reservation holder) to **release the asset earlier**.
  - The requester's identity need not be exposed to the holder.
  - The holder receives a simple request such as: *"This equipment is needed during part of your current checkout/reservation. Can you release it by [date]?"*
  - The holder may explicitly **accept or decline**; **silence changes nothing**.
  - The system must **never automatically shorten or cancel** an existing checkout or reservation.
  - If accepted, availability is updated and the waitlisted/requesting employee may be notified.
  - Admin retains visibility and override authority.
- **Dependencies/open design points:** a reservation concept distinct from an assignment; per-asset "reservable" flag; interaction with max checkout duration (also future) and the existing temporary-checkout return date; notification/email infrastructure (also future). The earlier Phase 1E open questions (overlap conflicts, late returns, when a reservation becomes a checkout, no-show expiry, admin override) still apply.

##### Future — Detailed Equipment Catalog + Specific Asset Requests

Today's Request Equipment flow uses broad categories (computer, laptop, keyboard, …). Long term, employees should be able to request at three levels:

1. **Category** — Camera, Lens, Laptop, Audio, …
2. **Model / equipment type** — e.g. Sony A7 IV, Canon RF 24-70mm, MacBook Pro 16"
3. **Specific physical asset** — e.g. CAM-004, "Sony A7 IV — Body 2"

- **Request modes:** *"Any matching asset is fine"* and *"I need this specific asset"*.
- **Catalog direction:** admin-managed categories; admin-managed model/equipment groupings; **avoid a permanently hardcoded category list** (categories are currently free text plus a settings list); use inventory/catalog data where practical; product/model photos and useful details/specs.
- **Integration:** a specific-asset request integrates with the future availability calendar / reservation system.
- **Long-term flow:** Equipment Catalog → Model / Equipment Type → Specific Asset → Availability Calendar → Reserve / Request → Waitlist if unavailable → Optional release request.
- Relationship to existing work: builds on, and does not replace, the current permanent-assignment request and request-integrity rules (Phase 1); the full request-lifecycle redesign remains separate future work.
