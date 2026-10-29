# Employee Reservations & Equipment Requests

Owner-requested 2026-10-29. Built on `feature/employee-reservations-requests` (from `stage`), one cohesive feature. **Approved 2026-10-29** after visual QA; delivered in one PR to `stage`.

## Two separate employee actions

- **Reserve equipment** (renamed from "+ Request equipment") opens Browse, the equipment tree: pick a specific item, see its availability calendar, reserve it or join its waitlist. It is the **existing** reservation system, unchanged: asset selection, per-asset approval, dates and times, the split into reserved and waitlisted time, the FIFO waitlist with timed offers. Unavailable time is waitlist time only. A reservation never grants checkout authorization, and none of this needs the scanner or self-checkout permission (D-27). IT declines pending reservations and cancels confirmed ones through the existing transitions (Requests > Reservations).
- **Request equipment** (new) is "I need a piece of equipment": exactly one physical item, a category from the catalog (any level; brand and model are the levels under it) or **Other** (free text), optional custom brand / model text (it only fills a level the catalog choice left open), optional details, and **Request permanent assignment** (default off, any category). It never purchases anything and never creates an asset, reservation or assignment.

## One Requests screen

There is ONE top-level **Requests** entry for IT and employees, with **Equipment | Returns | Reservations** tabs and Open / Closed inside each (old links such as `#/my-requests`, `#/my-reservations` and `#/equipment-requests`, and the emails, redirect there). The tab counts add up to the one Requests badge, so nothing is counted twice.

- **Equipment** lists the new equipment requests AND the earlier item requests (the older `requests` table: "Request this" on an asset page, IT-logged requests). Both tables are untouched and nothing was converted; the older requests keep their own approve / assign / decline actions and detail, labelled "Item request". Their detail shows "Not recorded (this request predates the permanent-assignment option)" rather than inventing a preference.
- **Returns** holds return requests and issue reports. **Reservations** keeps the existing cards (approvals, cancel, shorten, waitlist), split into Open and Closed.
- Why two tables: the older `requests` table assumes "approve = assign this asset now"; its statuses and CHECKs cannot hold an independent permanent decision, brand/model, Other, Ready or a priority hold.

## IT decisions and notes

A request's **Decisions** panel holds two independent decisions: **equipment** (Pending / Approve / Decline) and **permanent assignment** (only when requested: Pending / Approve / Deny). Choosing an option changes nothing until **Save decisions**; either can be saved while the other stays Pending, with an optional note. Saved results show as statuses; a saved permanent decision is changed through **Edit decisions**, a saved equipment approval is withdrawn with **Cancel request** (never toggled off). A **note can be saved on its own** (`POST .../note`): it goes to the history as "Note added", becomes the employee's "Note from IT", is emailed, and changes no status or decision. Actions are grouped (Fulfilment / Other actions) and Decline and Cancel never appear together: Submitted / In review = Decline (a decision option), Approved or Ready = Cancel request, Fulfilled = none. **End priority hold** is separate and cancels no reservation. On phones request sheets have a close X (44px, pinned while scrolling) that asks before discarding unsaved changes.

## Lifecycle (server-enforced, `src/equipmentRequests.js`)

`submitted -> in_review -> approved -> ready -> fulfilled`; `approved -> fulfilled` (permanent delivery, or a handover that needs no inventory item); `declined` and `cancelled` are terminal. `ready -> approved` when the hold ends unclaimed, the employee declines the unit, or IT releases it (the need stays approved). The employee cancels their own request until Ready and declines a Ready unit; IT can cancel or decline any live request. Every change is a compare-and-set and an append-only row in `equipment_request_events` (the audit trail, shown in the detail sheet); holds also write to the asset's activity log.

## Permanent assignment is a second decision

`permanent_decision` (approved | denied | undecided) is IT's answer to the preference, independent of approving the need (same step or later). Approved: IT delivers and records the assignment through `assignments.createAssignment` (admin only, D-15) and the request is fulfilled only then; no hold, no public availability. Denied or never requested = shared / temporary equipment. Nothing is ready or fulfilled while a requested preference is undecided.

## Shared equipment: the 48-hour priority hold

IT picks an eligible unit (any existing inventory unit or newly registered equipment; no asset is needed before approval) and marks it **Ready**: the requester is notified and a 48-hour hold starts on that unit (the request row itself: `asset_id` + `hold_expires_at`; one live hold per unit by a partial unique index).

- Everyone else is blocked from reserving the unit (it becomes waitlist-only: `reservations.findBlockers` kind `priority_hold`) and from checking it out, IT included (`assignments.createAssignment`, 409). The requester is never blocked by it and can reserve it or have IT / themselves (with the permission) check it out under the usual rules.
- It never overrides what exists: a unit that is checked out, not available, archived, multi-seat, already held, or covered by a confirmed reservation today cannot be marked ready.
- A hold is not a checkout, assignment or reservation. The requester checking the unit out fulfils the request (`claimByCheckout`). IT can also check it out to them from the request, or record a handover.
- Unclaimed holds expire after 48 hours (the 60-second sweep; a lapsed hold stops blocking the moment the clock passes it). The unit goes back to everyone and the waitlist is re-evaluated. If the requester reserved the unit during the hold, that is a **claim, not fulfilment**: the request stays **Ready** (`claimed_reservation_id`) with the reservation protected by the normal rules after the 48 hours, and it is **Fulfilled only when the equipment is issued** (checkout, permanent assignment or recorded handover). If the claiming reservation is cancelled, declined or over, the request returns to Approved and the unit is freed.
- The employee can decline early (releases the hold at once).

## Safety

- Identical open requests are allowed (two monitors = two requests); each is exactly one physical item. No quantities or bundles.
- All permissions and transitions are server-side; an employee sees and acts only on their own; IT actions are admin-only (403).
- SQLite and PostgreSQL: migration **21** / PostgreSQL **005** (`equipment_requests`, `equipment_request_events`), a PG twin `src/pg/equipmentRequests.js` on the seam (asset lock first, then the request row), the new tables added to `scripts/pg-copy.js`. Changes to `findBlockers`, `createAssignment`, `availability` and the waitlist's `plan` / `confirmHold` calls are mirrored in their `src/pg/` twins.
- Email uses the existing mailer (outbox when not configured): IT is told of a new request; the requester of approval, permanent decision, ready (with the hold deadline), decline, fulfilment, release and expiry. Nothing waits on official email setup.

## Not in this slice

Grouped All Assets (next approved feature), onboarding packages, purchasing, production deployment.

## Staging migration and deployment sequence (nothing here has been run on Railway)

The schema change is additive: SQLite migration 21 and PostgreSQL migration 5 (`005_equipment_requests.sql`) create `equipment_requests` and `equipment_request_events` with their indexes. No existing table, column or row is altered. On PostgreSQL the app applies pending migrations itself at boot (`src/pg/migrate.js`, advisory-locked), so there is no separate migration command.

1. Owner approves and merges the PR into `stage` (CI green: `npm test` and `npm run test:pg-suite`).
2. Before the merge, make sure a fresh backup exists (the `nc-backup` cron service and the daily volume backup are live; an on-demand run is optional, see `docs/BACKUP_RUNBOOK.md`).
3. Railway auto-deploys `stage`. The new build boots, applies PostgreSQL migration 5 and logs `PostgreSQL: applied schema migration(s) 5`. Confirm `/health` is 200 and `schema_migrations` lists 1 to 5.
4. Smoke test on staging with sample accounts: an employee submits a request (Home > Request equipment), IT sees it under Requests > Equipment, approves it, marks a unit ready (a `SMP-` sample asset), a second employee cannot reserve it, then End priority hold / cancel to clean up.
5. Rollback: the tables are additive, so redeploying the previous build works unchanged (it simply ignores them); there is no destructive down-migration. Do not drop the tables once real requests exist.
6. `scripts/pg-copy.js` already lists both tables, so a future SQLite-to-PostgreSQL copy carries them. There is no production environment yet.
7. Local development SQLite databases (`./data-dev`, `./data-qa`) migrate to 21 automatically at startup.
