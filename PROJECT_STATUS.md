# NC IT Inventory Tracker — Project Status

**Last Updated:** 2026-09-28  
**Project Status:** Early MVP / Prototype  
**Current Phase:** Baseline & Test Harness  
**Canonical Branch:** TBD  
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
- Scan asset barcodes using:
  - Mobile device camera
  - USB barcode scanner
  - Bluetooth barcode scanner
  - Manual entry
- Assign equipment to employees.
- Check equipment back in.
- Maintain assignment and activity history.
- Track asset lifecycle/status.
- Import and export inventory data.
- Eventually perform physical inventory audits/cycle counts.

The intended production architecture is currently:

**Browser / PWA → Railway-hosted application → Supabase**

Supabase is expected to provide:

- PostgreSQL database
- Asset photo storage
- Authentication
- Authorization / Row Level Security where appropriate

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

### Application
Railway

### Database
Supabase PostgreSQL

### File Storage
Supabase Storage

### Authentication
Supabase Auth

### Email
TBD

Potential options:

- Resend
- Postmark
- Existing SMTP if Railway plan/environment supports it

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

Current implementation uses custom authentication rather than Supabase Auth.

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

- [ ] Supabase project connected
- [ ] PostgreSQL schema created
- [ ] SQLite → PostgreSQL migration completed
- [ ] Supabase Storage integrated
- [ ] Supabase Auth integrated
- [ ] Railway deployment configured
- [ ] Railway health endpoint implemented
- [ ] Production environment variables documented
- [ ] Staging environment established
- [ ] Production environment established

## Testing

- [ ] Repeatable dummy-data seed (no seed script exists yet; test fixtures use ephemeral per-run temp DBs, not a persistent dev seed)
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

**Status:** Architecture decision required.

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

# 9. Initial Dummy Data Plan

Before Supabase migration, create a repeatable development dataset.

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

**Status:** NEXT

Goal:

Prove the current application works before replacing infrastructure.

### Tasks

- [ ] Confirm project runs locally from a clean checkout
- [ ] Confirm Node/package versions
- [ ] Confirm dependency installation
- [ ] Confirm database initialization
- [ ] Document local startup procedure
- [ ] Create deterministic dummy-data seed
- [ ] Create test users/employees
- [ ] Create test assets
- [x] Add minimal automated smoke tests — *already present (45 tests in `test/`); see correction in Section 6.*
- [ ] Verify current scanner workflow
- [ ] Verify assignment workflow
- [ ] Verify check-in workflow
- [ ] Verify asset photos
- [ ] Verify CSV import/export

### Golden Path

The following workflow must work before infrastructure migration:

**Asset exists → Scan asset → Open correct asset → Assign employee → Scan again → Confirm assignment → Check asset in → Scan again → Confirm available**

### Exit Criteria

Phase 0 is complete when the current SQLite version has a repeatable development environment and the golden workflow has been verified.

---

# 11. Phase 1 — Data Model Hardening

**Status:** Not Started

Before moving production data to PostgreSQL:

- [ ] Define employee/person model
- [ ] Define login/profile model
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

# 12. Phase 2 — Supabase PostgreSQL

**Status:** Not Started

- [ ] Create Supabase DEV project
- [ ] Establish migration workflow
- [ ] Convert SQLite schema to PostgreSQL
- [ ] Add constraints
- [ ] Add indexes
- [ ] Add foreign keys
- [ ] Add historical integrity rules
- [ ] Add seed data
- [ ] Replace `better-sqlite3` data access
- [ ] Preserve existing frontend/API behavior
- [ ] Run Supabase database advisors
- [ ] Verify database migration

---

# 13. Phase 3 — Supabase Storage

**Status:** Not Started

- [ ] Create private asset-photo bucket
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

Supabase Auth.

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

# 15. Phase 5 — Railway Staging

**Status:** Not Started

- [ ] Create Railway service
- [ ] Configure environment variables
- [ ] Configure Supabase connection
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

Goal:

Establish a repeatable, verified local version of the existing application without changing architecture.

Expected work:

1. Inspect repository state.
2. Confirm startup instructions.
3. Install dependencies.
4. Launch application.
5. Initialize SQLite database.
6. Document current database tables.
7. Confirm administrator login.
8. Confirm asset list loads.
9. Confirm scanner page loads.
10. Confirm asset CRUD works.
11. Record any runtime errors.
12. Do not migrate to Supabase yet.

After this passes, proceed to:

### Phase 0B — Deterministic Development Seed

Then:

### Phase 0C — Core Workflow Smoke Tests

Then:

### Phase 0D — Physical Scanner Verification

---

# 19. Decisions Log

## 2026-09-28 — Preserve Existing Application

Decision:

Do not rewrite the application from scratch.

Reason:

The existing source already contains most MVP workflows.

---

## 2026-09-28 — Preferred Production Architecture

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

# 20. Open Decisions

- [ ] Repository branching strategy
- [ ] Supabase organization/project naming
- [ ] Employee vs login-account schema
- [ ] Asset identifier schema
- [ ] Asset-tag numbering convention
- [ ] Asset lifecycle statuses
- [ ] Self-checkout behavior
- [ ] Email provider
- [ ] Production domain
- [ ] Barcode label dimensions/printer
- [ ] Whether QR codes are needed in addition to Code 128
- [ ] Inventory/cycle-count V1 scope

---

# 21. Current Milestone Summary

### Completed

- Existing source received
- Initial architecture audit completed
- Existing feature inventory completed
- Scanner implementation inspected
- Initial production risks identified
- Railway + Supabase architecture direction selected
- Development workflow established

### In Progress

- Project tracking setup

### Next

**Phase 0A — Local Baseline**

### Blocked

None currently.