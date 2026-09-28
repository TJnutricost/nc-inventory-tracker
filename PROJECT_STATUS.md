# NC IT Inventory Tracker — Project Status

**Last Updated:** 2026-09-28  
**Project Status:** Early MVP / Prototype  
**Current Phase:** Baseline & Test Harness  
**Canonical Branch:** `stage` (shared integration / GitHub default branch); `main` is the stable/release branch — see Section 3a  
**Production Status:** Not deployed

---

## 1. Project Overview

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

---

# 2. Development Workflow

## Roles

### ChatGPT
Acts as:

- Project director
- Technical supervisor
- Architecture reviewer
- Task planner
- Code-review assistant
- QA planner
- Project-status coordinator

ChatGPT should generally define implementation slices and review results rather than directly performing the majority of implementation work.

### Claude Code
Preferred implementation worker.

Claude Code should be used by default for:

- Repository inspection
- Coding
- Refactoring
- Tests
- Migrations
- Running local commands
- Updating project files
- Updating this `PROJECT_STATUS.md`

### Codex / VS Code
Available as a secondary implementation/debugging tool.

Use when:

- Claude Code is blocked.
- A second implementation opinion is useful.
- Independent code review is useful.
- Specific tooling works better through Codex.

---

# 3. Working Rules

1. `PROJECT_STATUS.md` is the canonical project tracker.

2. Every meaningful development slice should update this file before completion.

3. Do not combine unrelated features into one implementation slice.

4. Each slice should have:
   - Defined scope
   - Acceptance criteria
   - Automated verification where practical
   - Manual verification steps
   - Final implementation report

5. Do not modify production infrastructure or production data without explicit approval.

6. Development and test data must use dummy/non-sensitive information until the application has been verified.

7. Preserve historical equipment records wherever possible.

8. Asset deletion should not silently destroy historical assignment/activity records.

9. Scanner functionality must be verified on real devices and not assumed functional based only on desktop/browser testing.

10. Prefer incremental migration over rewriting the application from scratch.

---

# 3a. Git Branch Strategy

**Established 2026-09-28.**

- **`stage`** — shared integration branch. This is the GitHub **default branch**. Short-lived feature/chore branches normally branch from `stage` and merge back into `stage`.
- **`main`** — stable/release branch. Ordinary feature branches are **not** merged directly into `main` unless explicitly instructed. Promotion from `stage` to `main` is a deliberate, separately-approved step.
- `stage` and `main` were created equal (both at commit `fcbff1d`, which includes Phase 0A + Phase 0B) and will diverge from here as `stage` accumulates new work ahead of the next approved promotion to `main`.
- Branch protection rules were explicitly **not** configured this slice (out of scope) — `stage` currently has no protection beyond what already existed on `main`.

---

# 4. Current Application Architecture

## Current Stack

The audited source currently uses approximately:

- Node.js
- Express
- SQLite
- `better-sqlite3`
- Server-rendered/static frontend application
- `html5-qrcode`
- Local filesystem asset photo storage
- Custom authentication/session implementation
- SMTP/email notification support
- Docker
- PWA support

## Proposed Production Stack

**Revised 2026-09-28 — Railway-first, provider-neutral; Supabase is no longer assumed. See Section 19 Decisions Log for why.**

### Application
Railway

### Database
Managed PostgreSQL, described and built provider-neutrally. **Railway PostgreSQL is the current preferred host.**

### File Storage
S3-compatible object storage, described provider-neutrally. **Railway object storage (or another S3-compatible provider) is the current preferred direction.**

### Authentication
**TBD.** No specific provider is assumed. Will be decided during Phase 4 (Section 14).

### Email
TBD

Potential options:

- Resend
- Postmark
- Existing SMTP if Railway plan/environment supports it

### Backup / Restore

PostgreSQL backup/restore is a hard requirement of the production data layer, independent of final host choice:

- Automated, regular backups of the production PostgreSQL database are required before any real inventory data is migrated in.
- A documented, tested restore procedure is required — an untested backup does not satisfy this requirement.
- Backup/restore approach should not depend on Supabase-specific tooling; it must work against whatever managed PostgreSQL host is chosen (Railway PostgreSQL currently preferred).
- This formalizes and supersedes the general "Database backup strategy" bullet already tracked in Section 17 (Phase 7 — Production Readiness).

---

# 5. Audit Summary

The project is significantly more complete than a basic prototype.

The existing application already contains most of the core inventory-management workflows.

## Existing Features

### Asset Management

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

### Photos

- [x] Asset photo upload
- [x] Image resizing
- [x] Thumbnail generation
- [x] Cover photo selection

Current implementation uses local filesystem storage.

### Barcode / Scanner

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

### Assignments

- [x] Assign asset to employee/user
- [x] Check asset in
- [x] Assignment history
- [x] Asset status updates
- [x] Return request workflow

### Equipment Requests

- [x] Equipment request system
- [x] Approval
- [x] Denial
- [x] Dropoff/fulfillment flow

### Users / Authentication

- [x] Admin role
- [x] Standard user role
- [x] Login
- [x] Invite flow
- [x] Password reset

Current implementation uses custom (bcrypt + session) authentication rather than the eventual shared authentication provider, which is currently TBD (see Section 14).

### Other Features

- [x] Dashboard
- [x] Activity log
- [x] CSV import
- [x] CSV export
- [x] Email notification logic
- [x] Email fallback/outbox behavior
- [x] PWA manifest
- [x] Service worker
- [x] Docker deployment foundation

---

# 6. Not Yet Production Ready

## Infrastructure

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

## Testing

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

## CI / Repository

- [ ] Git workflow confirmed
- [ ] Canonical development branch confirmed
- [ ] CI checks configured
- [ ] Build verification automated
- [ ] Test verification automated

---

# 7. Known Issues / Architecture Risks

These were identified during the initial source audit.

## Asset Deletion

**Status:** Needs correction before production data.

Current hard deletion may cascade-delete historical information such as assignments/activity.

### Desired behavior

Normal administrative asset removal should use lifecycle states such as:

- Retired
- Disposed
- Archived
- Lost

Historical assignment/activity records should remain available.

---

## Serial Number Uniqueness

**Status:** Needs design decision.

Serial numbers can currently be used by scanner lookup, but database uniqueness is not strongly enforced.

Duplicate serial numbers could make scanner lookup ambiguous.

The final design must also account for:

- Missing serials
- Generic manufacturer serials
- Invalid serial data
- Reused/duplicate identifiers

---

## Identifier Model

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

---

## Asset Tag Generation

**Status:** Needs hardening.

Current automatic asset-tag generation could produce a race condition if multiple users create equipment simultaneously.

PostgreSQL should generate/reserve identifiers atomically.

---

## Cover Photo Validation

**Status:** Needs correction.

The cover-photo operation should verify that the selected photo belongs to the asset being modified.

---

## Employee vs. Login Account

**Status:** Architecture decision required. Direction now formalized in Section 8a (Employee Portal V1) — this entry remains as the original audit note.

Currently user/account concepts are closely tied to equipment assignment.

Recommended future model:

### Employee / Person
Represents the person who possesses equipment.

### Login Account
Represents someone who can authenticate into the inventory application.

An employee should not be required to have an application login.

A login may optionally be linked to an employee record.

---

## Self Checkout

**Status:** Needs product decision.

Current behavior includes self-checkout capability.

Likely desired default:

**OFF**

Primary workflow should initially be controlled by the equipment/IT administrator.

---

## Login Rate Limiting

**Status:** Needs production implementation.

Current rate limiting uses application/server memory and will not behave reliably across restarts or multiple server instances.

---

## Historical Integrity

**Status:** High priority.

Assignment history, check-in/out history, lifecycle events, and audit records should be treated as durable historical data.

Future schema changes must preserve this principle.

---

# 8. Future Feature: Physical Inventory Audits

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

---

# 8a. Future Architecture: Employee Portal V1

**Status:** Newly agreed direction, 2026-09-28. Not implemented. No employee UI, auth, schema, or directory changes have been made — this section is planning/documentation only.

To be scheduled as planned future work **after** the shared database/auth/backend foundation (Phases 2–4) is established — not the next phase after Phase 0/1. (Note 2026-09-28: that foundation is now Railway-first and provider-neutral, not assumed to be Supabase — see Section 19 Decisions Log.)

## Domain / Application Split

**Revised 2026-09-28** — supersedes the earlier `admin.<domain>` / `<domain>` (root/apex) assumption. Current direction: both portals will likely live on separate subdomains of an **existing hosted parent domain/site**, not on a domain registered specifically for this project, and the employee portal is **not** assumed to live at the apex/root domain.

- **Admin portal:** `<admin-subdomain>.<parent-domain>` — hosts the IT/admin inventory-management application currently being built.
- **Employee portal:** `<employee-subdomain>.<parent-domain>` — a separate, employee-facing web experience (Employee Portal V1).
- Both hostnames are expected to be subdomains of an existing parent domain (not necessarily a new domain purchased for this project).
- Exact parent domain: **TBD**. Exact admin subdomain: **TBD**. Exact employee subdomain: **TBD**. DNS/CNAME/proxy/hosting details: **TBD**. None of this is being configured now (tracked in Section 20, Open Decisions).
- Both applications share the **same** backend, database, authentication system, and inventory data, whichever hosting/provider choices are ultimately made. There is no separate inventory database for the employee app.

**Future-design note — auth across two hostnames:** authentication/session design must support both portal hostnames; do not assume shared browser cookies across the two subdomains. Exact cookie/session/SSO behavior will be decided during Phase 4 (Authentication), not here.

## Employee Portal V1 — Planned Functionality

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

## Employee vs. Login Account (Phase 1 data-model requirement)

This formalizes, and is the authoritative source for, the direction noted informally in Section 7 ("Employee vs. Login Account") and the corresponding task in Section 11 (Phase 1 — Data Model Hardening):

- An employee/person record **must** be independent from an application login account.
- IT must be able to create and assign equipment to an employee who has never logged into the system.
- A user of the eventual shared authentication provider (TBD) **may optionally** link to an employee record.
- A verified employee login should link to the existing employee record rather than create a duplicate employee record.
- Admin users may also be linked to employee records (an admin is not architecturally distinct from "a person," just a role/permission).

## Access Model (high-level, planning only)

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

## Employee Permission Model (2026-09-28 clarification)

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

## Request Rescind / Opened Rule (Phase 1 data-model/business-rule requirement, 2026-09-28)

Product rule: **an employee may rescind their own request only if IT has not opened/reviewed it yet.**

Preferred future behavior:
- A new employee request begins in a `submitted` / unopened state.
- The first administrative opening/review of the request records an `opened_at` timestamp and/or transitions it to an explicit `in_review` state.
- Once opened by IT, the employee can no longer rescind it.
- Rescinding must **not** delete the request.
- A rescinded request remains in historical/audit data with a state such as `rescinded_by_employee`, plus a rescinded timestamp.
- The backend must enforce rescind eligibility **atomically**, so a simultaneous IT-open / employee-rescind race cannot produce an invalid state.
- Exact request-status names will be finalized during the data-model hardening phase (Phase 1) — the names above are illustrative, not final.

## Authentication / Session Rules (2026-09-28 clarification)

- Both the admin portal and the employee portal **always** require authentication — there is no unauthenticated access to either.
- The employee portal may persist the authenticated session on the user's device/browser so the user can stay signed in, per the eventual product/session preference.
- Persistent login must still require a valid authenticated session — cached/local browser state is **never**, by itself, proof of authorization.
- Avoid designing broad offline caching of sensitive inventory data; session persistence and data caching are separate concerns and should not be conflated.
- Exact session duration, refresh behavior, and "remember me" UX will be finalized during the authentication phase (Phase 4), once a provider is chosen — not decided here.

## Admin Portal Rule (reinforced, 2026-09-28)

- `<admin-subdomain>.<parent-domain>` always requires authentication.
- Reaching `<admin-subdomain>.<parent-domain>` does **not** itself grant admin rights.
- Admin authorization must be determined by trusted application/backend authorization data, not by hostname, route, or client-side state.

## Auth Direction

- Planned shared authentication provider: **TBD** (revised 2026-09-28 — previously assumed to be Supabase Auth; no specific provider is assumed now, see Section 19 Decisions Log). Whatever provider is chosen will serve both the admin and employee portals.
- Google authentication is expected to be the primary employee login method, regardless of which provider is ultimately chosen.
- Email magic-link/passwordless login is expected as a fallback.
- Public/open employee self-registration should **not** be assumed.
- Preferred direction: **pre-provisioned** employees/accounts — only approved/known employees should gain employee-portal access.
- Exact onboarding/linking behavior (how an authenticated user gets matched to an existing employee record) will be finalized during the authentication/data-model phases (Phase 1 and Phase 4), not here.

## Repository Direction (future option, not current implementation)

- Keep admin and employee applications in the same repository for now.
- They may eventually become separate application surfaces/packages sharing backend/types/utilities.
- The repository is **not** to be restructured yet — this is a noted future option only.

## Roadmap Placement

Employee Portal V1 is planned future work, sequenced **after** the shared database/auth/backend foundation is established (i.e., after Phase 2 — Managed PostgreSQL Migration, Phase 3 — Object Storage Migration, and Phase 4 — Authentication in Section 10's roadmap). It is not scheduled ahead of, or in place of, any current Phase 0 work.

---

# 9. Initial Dummy Data Plan

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

---

# 10. Development Roadmap

## Phase 0 — Baseline & Test Harness

**Status:** IN PROGRESS — Phase 0A (local baseline), 0B (deterministic dev seed) and 0C (golden-workflow automation) complete; Phase 0D (physical scanner QA) partially complete — software/desktop scanner behavior verified, physical USB/Bluetooth/camera hardware verification still pending (not a failure, just not yet accessible), all 2026-09-28. CSV import/export and photo verification also remain open before Phase 0 can be called fully done.

Goal:

Prove the current application works before replacing infrastructure.

### Tasks

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

### Golden Path

The following workflow must work before infrastructure migration:

**Asset exists → Scan asset → Open correct asset → Assign employee → Scan again → Confirm assignment → Check asset in → Scan again → Confirm available**

**Status (2026-09-28):** the business-logic half of this path is now proven end-to-end by an automated integration test (`test/golden-workflow.test.js`, Phase 0C) — lookup, assignment, re-lookup, check-in, final re-lookup, and historical integrity all pass against the real Express app. The remaining piece is the literal "scan" step on physical hardware (camera / USB / Bluetooth), which is Phase 0D and has not started.

### Exit Criteria

Phase 0 is complete when the current SQLite version has a repeatable development environment and the golden workflow has been verified — the backend/API leg is now verified (Phase 0C); physical-device scanning verification (Phase 0D) is still required to close this out.

---

# 11. Phase 1 — Data Model Hardening

**Status:** Phase 1A (audit + target design) complete and **approved** — 2026-09-28. Phase 1B–1G implementation **not started**; nothing below is implemented. Full detail: [`docs/DATA_MODEL_PHASE_1.md`](docs/DATA_MODEL_PHASE_1.md).

### Phase 1A — Audit & Design (2026-09-28, `feature/phase-1a-data-model-design`)

**Design phase complete; target decisions APPROVED. Implementation: NOT STARTED (Phase 1B–1G are Planned).** Full detail: [`docs/DATA_MODEL_PHASE_1.md`](docs/DATA_MODEL_PHASE_1.md).

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

### Phase 1B — Migration Foundation + Immediate Integrity Fixes (implemented, 2026-09-28, `feature/phase-1b-migration-integrity`; reviewed; committed and pushed, not yet merged)

- **Migration runner (implemented):** `src/migrate.js` + ordered list in `src/migrations.js`; `schema_migrations(id, name, applied_at)`; each migration runs once, in id order, in its own transaction with its bookkeeping row (failure leaves no trace); runs automatically at startup and is idempotent. Migration 1 = the pre-existing baseline schema (all `IF NOT EXISTS`, so fresh and existing databases both work, nothing rebuilt); migration 2 clears invalid cover-photo references.
- **Cover-photo ownership (implemented):** `PUT /api/assets/:id/cover` requires an existing asset (404), a well-formed photo id (400), an existing photo (404) and a photo owned by that asset (400); null/empty clears. Failed requests leave the previous cover intact.
- **Request reference validation (implemented):** `POST /api/requests` returns 400 for malformed asset/user ids and 404 for unknown ones; approve returns 400/404 for a bad `asset_id`. No request lifecycle change (Phase 1G).
- **Self-checkout (implemented):** default is OFF for NEW databases; startup still uses `INSERT OR IGNORE`, so existing values (ON or OFF) are never overwritten.
- **Category/location (implemented, minimal):** `assetValues()` (create, edit, CSV import) rejects non-text values with 400; trimming was already done by `clean()`.
- **Deferred:** category/location *length limits* (no existing convention; would be arbitrary) and validating category against the configured list (would affect existing/imported data) — left for a later hygiene slice.
- **Tests added:** 16 (`test/migrations.test.js`, `test/integrity.test.js`); suite is 71 passing / 0 failing.
- **Known limitation → resolved in Phase 1C:** SQLite can't toggle `PRAGMA foreign_keys` inside a transaction, so table rebuilds need a runner option. Phase 1C's `assets` rebuild made that necessary, so the runner gained `disableForeignKeys` (see Phase 1C below). Phase 1E's rebuilds reuse it.
- **Not touched:** Archive/`archived_at`/`disposed`, tag sequencing, employee/account split, assignment model, serial handling, request states, PostgreSQL/Railway/auth.

### Phase 1C — Asset Lifecycle + Durable Tag Issuance (implemented, 2026-09-28, `feature/phase-1c-asset-lifecycle-tags`; pending review/merge)

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

**Phase 1 sequence (1B merged; 1C implemented on its branch; rest Planned):** 1B Migration Foundation + Immediate Integrity Fixes → 1C Asset Lifecycle + Durable Tag Issuance → 1D Employee/Account Split → 1E Assignment + Historical Integrity → 1F Serial Normalization + Lookup Ambiguity → 1G Request Lifecycle.

- [ ] Define employee/person model — *must be independent of login account; see Section 8a*
- [ ] Define login/profile model — *a user of the eventual shared auth provider (TBD) optionally links to an employee record; see Section 8a*
- [ ] Define asset identifier model
- [ ] Resolve serial duplicate behavior
- [ ] Replace destructive asset deletion
- [ ] Preserve historical records
- [ ] Make asset-tag generation concurrency safe
- [ ] Fix cover-photo ownership validation
- [ ] Confirm lifecycle statuses
- [ ] Confirm location model
- [ ] Confirm category model
- [ ] Confirm self-checkout policy

---

# 12. Phase 2 — Managed PostgreSQL Migration

*(Renamed 2026-09-28, was "Phase 2 — Supabase PostgreSQL" — see Section 19 Decisions Log. Railway PostgreSQL is the current preferred host; tasks below are written provider-neutrally so they hold regardless of final host.)*

**Status:** Not Started

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

---

# 13. Phase 3 — Object Storage Migration

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

---

# 14. Phase 4 — Authentication

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

---

# 14a. External Dependency: Railway Access

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

---

# 15. Phase 5 — Railway Staging

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

---

# 16. Phase 6 — Scanner QA

**Status:** Not Started

Test using actual hardware.

## Mobile

- [ ] iPhone Safari
- [ ] iPhone installed PWA
- [ ] Android Chrome
- [ ] Android installed PWA

## Physical Scanners

- [ ] USB scanner
- [ ] Bluetooth scanner

## Barcode Tests

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

## Failure Cases

- [ ] Camera permission denied
- [ ] Camera unavailable
- [ ] Unsupported browser
- [ ] Scanner sends Enter suffix
- [ ] Scanner does not send Enter suffix
- [ ] Network interruption
- [ ] Duplicate rapid scans

---

# 17. Phase 7 — Production Readiness

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

---

# 18. Current Priority

## Next Development Slice

### Phase 0A — Local Baseline

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

### Phase 0A Verification Log (2026-09-28, Claude Code)

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

### Phase 0B — Deterministic Development Seed

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

### Phase 0C — Core Workflow Smoke Tests

**Status:** COMPLETE (golden-path automation scope) — 2026-09-28, Claude Code. Not merged/pushed; left on `chore/phase-0c-golden-workflow` (branched from `stage`) for review.

**What was added.** `test/golden-workflow.test.js` (4 new tests, using the existing `test/helpers.js` harness — an isolated throwaway SQLite DB per run, never `./data` or `./data-dev`), driving the real Express app over HTTP exactly the way the front end does:

1. **Golden path, full lifecycle in one test:** create asset (`NC-GOLDEN1`, initially `available`, no holder) → scan/lookup via `GET /api/assets/lookup/:code` (`found:true`, correct id) → assign via `POST /api/assets/:id/checkout` (asset flips to `checked_out`, holder is the correct employee, `checked_out` activity entry recorded) → re-lookup by the same tag (still resolves, detail now shows the holder) → check in via `POST /api/assets/:id/checkin` (asset back to `available`, no holder, `checked_in` activity recorded) → final re-lookup (still resolves, still available). **Historical integrity** is asserted directly against the `assignments` row: the completed assignment is *not* deleted — it's still present with `checked_out_at`, `returned_at`, `user_id` and `condition_in` all intact, and both lifecycle activity entries remain visible.
2. **Guard cases** (3 small, targeted tests, not exhaustive business-rule coverage): an unknown tag lookup returns `found:false`; checking in an asset with no active assignment returns `400` rather than corrupting state; checking out an already-checked-out single-capacity asset is rejected with exactly one active assignment row remaining (no duplicate).

No new npm script was added — `node --test test/golden-workflow.test.js` already runs it in isolation cleanly, and adding `verify:golden` on top would have been redundant per the brief's own guidance.

**Verification:** ran the new file alone (4/4 passing), then the full suite (`npm test`): **55/55 passing** (51 prior + 4 new). Confirmed via file mtimes that neither `./data` nor `./data-dev` were touched by the run. Since the golden-workflow test already drives the real Express app over HTTP end-to-end — not a mock — this doubles as the runtime verification the brief asked for; no separate manual curl session was needed or performed (per the brief's own "prefer progress over redundant verification" guidance).

**Deferred / explicitly out of scope this slice:** physical scanner hardware (camera, USB, Bluetooth, label printer) — Phase 0D; CSV import/export and photo-upload verification; any fix to the pre-existing known issues in Section 7 (hard delete, serial uniqueness, etc.) — none were newly exposed by this slice.

**Issues found:** none. No blockers, no bugs, no new technical debt.

Then:

### Phase 0D — Physical Scanner Verification

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

---

# 19. Decisions Log

## 2026-09-28 — Preserve Existing Application

Decision:

Do not rewrite the application from scratch.

Reason:

The existing source already contains most MVP workflows.

---

## 2026-09-28 — Preferred Production Architecture

**⚠ SUPERSEDED later the same day — see "2026-09-28 — Railway-First, Provider-Neutral Architecture" below. Kept here for history, not current direction.**

Direction:

**Railway + Supabase**

Supabase intended for:

- PostgreSQL
- Storage
- Authentication

Railway intended for:

- Node/Express application hosting

Final implementation details remain subject to testing.

---

## 2026-09-28 — Railway-First, Provider-Neutral Architecture

Decision:

Supersede the earlier same-day "Railway + Supabase" direction above. Supabase is no longer assumed as the database, storage, or authentication provider.

New direction:

- **Application hosting:** Railway (unchanged).
- **Database:** managed PostgreSQL, described and built provider-neutrally. **Railway PostgreSQL is the current preferred host.**
- **Object/photo storage:** S3-compatible object storage, described provider-neutrally. **Railway object storage (or another S3-compatible provider) is the current preferred direction.**
- **Authentication:** **TBD** — no specific provider assumed. Will be decided during Phase 4.
- Admin and employee portals (Section 8a) share one backend, one database, and one authentication system, independent of which specific vendor is chosen for each.
- Roadmap phases renamed accordingly: "Phase 2 — Supabase PostgreSQL" → "Phase 2 — Managed PostgreSQL Migration"; "Phase 3 — Supabase Storage" → "Phase 3 — Object Storage Migration" (Section 10).

Reason:

Avoid hard-locking the data layer and auth system to one vendor's proprietary client/SDK before the team has confirmed Railway account access (see Section 14a) or made a deliberate auth-provider choice. Provider-neutral design keeps local development, automated testing, and Phase 1 data-model work fully unblocked regardless of when external infrastructure access lands.

---

## 2026-09-28 — Implementation Worker

Decision:

Use **Claude Code by default** for implementation.

ChatGPT will primarily supervise, plan, review, and coordinate.

Codex remains available as a secondary worker/reviewer.

---

## 2026-09-28 — Migration Order

Decision:

Do not start with Supabase migration.

First establish a known-good local baseline and verify the scanner/assignment lifecycle.

---

## 2026-09-28 — Git Branch Strategy

Decision:

Adopt `stage` (shared integration branch, set as the GitHub default) → `main` (stable/release branch) as the repository flow. Feature/chore branches branch from and merge back into `stage`; promotion from `stage` to `main` is a separate, deliberate step, not automatic.

Reason:

Multiple contributors/agents (Claude Code, Codex) working in parallel need a shared integration point that isn't the release branch, so `main` stays deployable.

---

## 2026-09-28 — Scanner Strategy, Including a Future Paired-Phone Concept

Decision:

Formalize the current scanner strategy as four input methods — desktop USB barcode scanner, desktop Bluetooth barcode scanner, manual entry, and native phone-camera scanning — all already implemented, feeding the same backend lookup path. Additionally, record a **future** concept: a **paired phone scanner**, where a phone acts as a dedicated wireless scanner input for a desktop/kiosk session, as a lower-friction alternative to owning a dedicated USB/Bluetooth scanner.

Reason:

Staff without a dedicated barcode scanner still need a fast, low-friction way to scan equipment; a paired-phone input could serve that need without requiring native phone-camera scanning during every session. Not designed or scoped yet — recorded here as a direction to revisit, not committed work (see Section 1 for where this sits alongside the four implemented methods).

---

## 2026-09-28 — Portal Hostname Direction Revised

Decision:

Supersede the earlier `admin.<domain>` / `<domain>` (root/apex) assumption in Section 8a. Both the admin and employee portals are now expected to live on separate subdomains of an **existing hosted parent domain/site**, not a domain registered specifically for this project. The employee portal is explicitly **not** assumed to live at the apex/root domain. Exact parent domain, admin subdomain, and employee subdomain are each individually TBD; no DNS/CNAME/proxy configuration has been done.

Reason:

The earlier `<domain>` assumption implied a dedicated root domain for this project; the actual plan is to host both portals under an existing parent site the organization already has, which changes how hostnames (and eventually auth/session/cookie scope across them — see Section 8a's auth note) need to be designed. Recorded now, before Phase 4 authentication design, so that work doesn't bake in the wrong hostname assumption.

---

# 20. Open Decisions

- [x] Repository branching strategy — *resolved 2026-09-28: `stage` (integration/default) → `main` (release), see Section 3a.*
- [ ] Final managed-PostgreSQL host / project naming — *Railway PostgreSQL currently preferred (revised 2026-09-28, was "Supabase organization/project naming"); see Section 19.*
- [ ] Final object storage provider — *Railway/S3-compatible currently preferred; see Section 19.*
- [ ] Final authentication provider — *TBD, revised 2026-09-28 (was assumed to be Supabase Auth); see Section 14 and Section 19.*
- [x] Employee vs login-account schema — *resolved (approved) 2026-09-28; implementation Planned in Phase 1D. See `docs/DATA_MODEL_PHASE_1.md` §3.1.*
- [x] Asset identifier / serial policy — *resolved 2026-09-28: no identifier table or barcode column; normalized-serial warning + ambiguity handling, Phase 1F.*
- [ ] Concrete production asset-tag prefix/width — *numbering rules approved (monotonic, never reused, prefix change doesn't reset); the production prefix value is a setting. **Caveat:** prefixes containing digits (e.g. `NC2-`) make legacy-tag high-water inference ambiguous, because counter seeding parses trailing digits from existing tags (Phase 1C migration 4 ignores tags with digits in the prefix). Resolve the final production prefix/format before any future migration or reseeding logic depends on parsing historical tags. The allocator is intentionally not redesigned for this.*
- [x] Asset lifecycle statuses — *resolved 2026-09-28: `disposed` + `archived_at`, Archive replaces Delete, Phase 1C.*
- [x] Request status set / rescind rule — *resolved 2026-09-28, Phase 1G.*
- [x] Self-checkout behavior — *resolved 2026-09-28: default OFF for new databases (Phase 1B); existing settings untouched.*
- [ ] Duplicate-serial report against real data (before Phase 1F)
- [ ] Email provider
- [ ] Production domain — *revised 2026-09-28: parent domain, admin subdomain, and employee subdomain are each individually TBD; expected to be subdomains of an existing hosted parent domain rather than a new domain; DNS/CNAME/proxy/hosting details also TBD; see Section 8a.*
- [ ] Barcode label dimensions/printer
- [ ] Whether QR codes are needed in addition to Code 128
- [ ] Inventory/cycle-count V1 scope
- [ ] Paired-phone-scanner concept — design/scope not started; see Section 19.

---

# 21. Current Milestone Summary

### Completed

- Existing source received
- Initial architecture audit completed
- Existing feature inventory completed
- Scanner implementation inspected
- Initial production risks identified
- Production architecture direction selected: Railway-first, provider-neutral for database/storage, authentication TBD (initially "Railway + Supabase," revised same day 2026-09-28 — see Section 19 Decisions Log)
- Development workflow established
- Project tracking setup (`PROJECT_STATUS.md` committed on `chore/phase-0a-local-baseline`, merged into `main` via reviewed PR)
- Phase 0A — Local Baseline verification (clean install, fresh-DB boot, runtime smoke check, asset CRUD, scanner surface check — see Section 10 log; 2026-09-28)
- Phase 0B — Deterministic Development Seed (`npm run seed:dev`; 9 users, 48 assets, full history/requests coverage; 6 new automated tests; merged into `main` via PR #1; 2026-09-28)
- Git branch strategy established: `stage` (shared integration, GitHub default branch) → `main` (stable/release) — see Section 3a; `stage` created and pushed, GitHub default branch changed via `gh repo edit`, 2026-09-28
- Phase 0C — Golden Workflow Automation (`test/golden-workflow.test.js`; full lookup → assign → re-lookup → check-in → re-lookup lifecycle + historical-integrity assertions + 3 guard cases; 55/55 suite passing — see Section 10 log; 2026-09-28, merged into `stage`)
- Phase 0D — Physical Scanner QA, software/desktop baseline (label generation verified visually in a real browser; manual/wedge-equivalent entry, unknown-barcode handling, and rapid-repeat lookup safety all verified against the seeded dataset — see Section 10 log; 2026-09-28, merged into `stage`)
- Infrastructure architecture revised to Railway-first / provider-neutral: PostgreSQL and object storage no longer assume Supabase (Railway currently preferred for both), authentication provider set to TBD, roadmap Phases 2–3 renamed accordingly, Railway-access external dependency recorded (Section 14a), scanner strategy formalized including a future paired-phone-scanner concept, and PostgreSQL backup/restore made an explicit requirement — see Section 19 Decisions Log; 2026-09-28, on `docs/railway-first-architecture`, branched from `stage`

### In Progress

- Phase 1A — Data Model Audit & Target Design: audit complete and target decisions approved on `feature/phase-1a-data-model-design` (documentation only); implementation not started; see Section 11 and `docs/DATA_MODEL_PHASE_1.md`
- Phase 0 golden path — business-logic/API leg fully proven (Phase 0C); software/desktop scanner behavior verified (Phase 0D); the literal physical-hardware scan (USB, Bluetooth, camera) is what remains

### Next

Physical hardware scanner QA, when available: USB scanner, Bluetooth scanner (company hardware exists, not on hand at current campus), and phone camera (blocked on secure HTTPS access — revisit during Railway/staging). Also still open from Phase 0's task list: CSV import/export and photo-upload verification.

### Blocked

- Phone-camera scanner QA — blocked on a secure HTTPS-accessible staging/dev environment (no tunnel was created, per scope restrictions). Not a Phase 0D failure; carried forward as a Railway/staging-phase prerequisite.