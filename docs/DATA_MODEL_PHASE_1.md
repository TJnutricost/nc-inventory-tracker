# Phase 1A — Data Model Audit & Target Design

**Status:** Audit complete. Target decisions **APPROVED** (2026-09-28) as the Phase 1 design. **Nothing in this document is implemented** — every item marked *Planned* is future work in Phase 1B–1G.
**Branch:** `feature/phase-1a-data-model-design` (from `stage` @ `054ab25`)
**Scope of this slice:** inspection + design + documentation only. No schema, behavior, migration, or test changes.

Method: read `src/db.js` (schema) and `src/server.js` (every code path), inspected the seeded dev DB, and
ran a throwaway probe against the real Express app (temp DB, not committed) to *confirm* each risk
below rather than infer it from docs. "Confirmed" = reproduced; "Read" = confirmed by reading code only.

---

## 1. Current schema summary (verified)

| Table | Key facts |
|---|---|
| `users` | `email` UNIQUE NOCASE; `role` admin/user; `active` flag; `password_hash` nullable. **No delete endpoint** — deactivate only. Conflates person + login + role. |
| `assets` | `tag` UNIQUE NOCASE NOT NULL; `serial` nullable, **non-unique** (plain index); `status` CHECK available/checked_out/maintenance/retired/lost; `category`, `location` free text; `license_seats` drives capacity; `cover_photo_id` **no FK**. **No custom-barcode column exists** (labels are Code 128 of the tag). |
| `assignments` | `asset_id` **ON DELETE CASCADE**; `user_id` NOT NULL (no action); `checked_out_by`/`returned_to` → users; `condition_out/in`, `due_date`, `returned_at`. **No uniqueness on open assignments.** |
| `photos` | `asset_id` CASCADE; files on local disk; `uploaded_by` → users. |
| `requests` | type equipment/return; status open/approved/denied/dropped_off/completed/cancelled; `asset_id` **SET NULL**; `user_id`, `created_by`, `resolved_by` → users. No "opened" marker. |
| `activity` | `asset_id` **ON DELETE CASCADE** (nullable); `actor_id`, `subject_user_id` → users; `action` free text; `details` free text. |
| `tokens` | `user_id` CASCADE (reset/invite tokens). |
| `sessions` | No FK; `uid` lives inside JSON `sess`; deactivation invalidates via `LIKE '%"uid":N}%'`. |
| `settings` | key/value; `categories` and `locations` are JSON arrays; `self_checkout` default `'1'`. |
| `outbox` | Email log; `to_addr` text, no FKs. |

Also: schema is `CREATE TABLE IF NOT EXISTS` with **no migration mechanism** — Phase 1 needs a versioned migration approach before any schema change (see 1B).

---

## 2. Confirmed findings (ranked)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **Deleting an asset destroys its assignment history and audit trail**, including while it is checked out. `DELETE /api/assets/:id` succeeded on a checked-out asset; afterwards 0 assignments, 0 activity rows (even the `created` event), photos gone, request `asset_id` → NULL. | Confirmed (probe) | **Critical** |
| F2 | **Cover photo can point at another asset's photo, or at a nonexistent id.** `PUT /assets/:id/cover` does no validation; returned 200 and stored both. A dangling id renders a blank thumbnail (the `COALESCE` fallback is skipped because the id is non-NULL). | Confirmed (probe) | High |
| F3 | **Serial numbers are not unique and lookup is first-match-wins.** Two assets with `SN1`/`sn1` both created; lookup silently returns id 1. A serial equal to another asset's tag is accepted; lookup resolves to the tag owner. | Confirmed (probe) | High |
| F4 | **Tag generation is `max(numeric suffix)+1` over existing rows** → (a) deleting the highest-numbered asset makes its tag **reusable** (identity reuse, compounds F1); (b) non-atomic under PostgreSQL / multi-instance; (c) `padStart(5)` and a changeable prefix make ordering ambiguous. **Within today's single Node process the create path is not raceable** (better-sqlite3 is synchronous and create computes+inserts in one tick); the `/api/next-tag` preview can go stale. Risk is real for Phase 2, latent now. | Read + probe (`next-tag` idempotent until insert) | High (for PG) |
| F5 | **DB permits multiple open assignments on a single-capacity asset**; only application code (`doCheckout`) prevents it. Raw insert of two open rows succeeded. | Confirmed (probe) | Medium |
| F6 | `lost` can be set on an asset that still has an open assignment. **Now the approved rule, not a defect** (keeps accountability for who had possession); the real gap is that `disposed`/archive guards don't exist yet. | Confirmed (probe) | Info |
| F7 | **Request lifecycle can't express "IT opened it".** `open` covers both untouched and being-worked. Employees can currently cancel equipment requests in `open`, `approved` or `dropped_off`. Approve/deny/cancel are check-then-write with no conditional `WHERE status=…`. | Read | Medium (blocks portal) |
| F8 | **`POST /api/requests` doesn't validate `asset_id`/`user_id` existence** → FK violation surfaces as a generic 500; any user can log a `requested` activity row against any asset id. | Read | Low |
| F9 | **Identity is tied to `users.id`**: assignments, requests, activity, photos all reference it; user cannot exist without being a login-capable row (`email` NOT NULL UNIQUE). | Read | Blocker for employee portal |
| F10 | Categories/locations are free text on `assets`; the settings list is advisory only (server accepts any string; renaming in Settings orphans existing values). | Read + dev DB | Low |
| F11 | Login rate limit and session invalidation are in-memory / `LIKE` on JSON. | Read | Tracked under Phase 4/5, not Phase 1 |

Not a problem (verified): user hard-delete is blocked by FKs (`FOREIGN KEY constraint failed`) and no endpoint exists; case-insensitive tag duplicates are rejected; retiring an asset with an open assignment is rejected.

---

## 3. Approved target decisions

Every subsection is **Approved / Planned (not implemented)** unless it says otherwise. The slice that delivers it is noted.

### 3.1 Employees and accounts (Phase 1D — implemented; see PROJECT_STATUS.md for the as-built schema and the notes below)

- **Current:** `users` is person + login + role + assignee at once (F9).
- **Approved model:**
  - `employees` — person / employment / inventory-assignee record: `id`, `name`, `work_email` (nullable, unique after normalization), `department`, `title`, `phone`, `status` (`active`/`inactive`), `created_at`.
  - `accounts` — login / application-authorization record: `id`, `employee_id` (nullable, **UNIQUE**, FK → employees, RESTRICT), `login_email`, `role` (`admin` | `employee`), `active`, `last_login_at`, local `password_hash` only while local auth exists, and nullable `auth_provider` / `auth_subject` placeholders (unique together when set).
  - An employee may exist **without** an account. An account links to **at most one** employee, and an employee has **at most one** account (for now). An admin may also be an employee.
  - **Roles:** `admin` and `employee`. Legacy `users.role = 'user'` → `employee`; `'admin'` → `admin`. Authorization depends on `accounts.role` only — never hostname.
  - "Who holds / requested / was affected" → `employee_id`. "Who performed this action" → `account_id`.
- **Future verified-login linking (auth-provider phase, not 1D):**
  - Normalize the verified email with trim + lowercase and match **only** against an existing employee `work_email`.
  - After linking, identity is the employee/account IDs — email changes must not break the link.
  - **Never auto-create** an employee for an unknown login. An **unmatched verified login is blocked** from application access and should eventually get a "contact IT / access not provisioned" page. No open registration.
- **Phase 1D scope:** introduce the tables; migrate each existing `users` row to 1 employee + 1 account, **keeping the old id as `employees.id`** so all history stays valid; update references; **preserve current login behavior** (local password login continues). No external auth-provider integration. Provider remains TBD.

### 3.2 Asset identity, serials, scanner lookup (Phase 1F; barcode model: no change)

- **Current:** `id` (internal), `tag` (unique, NOCASE), `serial` (nullable, non-unique, first-match lookup — F3). No barcode column; labels are Code 128 of the tag.
- **Approved:**
  - **Asset tag is the canonical/authoritative identifier.** Internal `id` is never printed.
  - **No custom barcode column and no `asset_identifiers` table.** Bluetooth, USB, phone-camera and (future) paired-phone scanners are *input methods*, not identifier types. Add another identifier model only when a real business requirement for a new identifier type exists. The Code 128 label continues to encode the tag.
  - **No hard global UNIQUE constraint on serial.** Instead:
    - Preserve the **raw** serial for display/history; derive a **normalized serial** for matching: trim, case-insensitive.
    - Conservative **placeholder set treated as missing** (not an identifier): empty, `N/A`, `NA`, `NONE`, `UNKNOWN`, `NO SERIAL`, `NOT AVAILABLE`, `-`.
    - **Duplicate normalized serials → warning on create/edit**; saving requires **explicit admin confirmation/override**.
    - **Before implementation, generate a duplicate-serial report** against real/current data (dev seed has none; production unknown).
  - **Lookup must never silently pick the first match.** Whenever one scanned value resolves to **more than one distinct asset** — duplicate serials, or a **cross-collision between one asset's tag and another's serial** — the API returns an **ambiguity result** listing the candidates, and the UI asks the operator to choose. (One asset matching by both tag and serial is not ambiguous.) Unknown code → existing "new barcode" flow.

### 3.3 Asset lifecycle and deletion (Phase 1C — implemented)

- **Current:** hard delete cascades and erases history (F1); status mixes lifecycle with derived availability.
- **Approved:**
  - Add status **`disposed`** and column **`archived_at`** (nullable). No `retired_at`/`deleted_at`/`disposed_at`; when/who/why lives in activity history.
  - Normal-UI **Delete becomes Archive**. History (assignments, activity, photos, requests) is retained. **No permanent-purge feature in normal UI.**
  - **Mistakenly created assets are archived**, not destroyed; the reason/context is captured in the activity entry (no new reason column for now).
  - Archived assets stay historically identifiable (still resolve by tag, flagged archived); hidden from default lists and dashboard counts.
  - **Existing tags are never reused** (see 3.5).
  - **`lost` MAY remain actively assigned** — keeping the assignment preserves accountability for who had possession. Becoming `lost` does not force check-in.
  - **`retired`, `disposed`, and archive require all active assignments to be resolved first** (the existing retire guard extends to the new terminal states and to archive).
- *Current behavior that already matches:* retire is refused with an open assignment; `lost` with an open assignment is already allowed (F6 is therefore **not a defect** — it is now the approved rule).

### 3.4 Assignment history and capacity (Phase 1E — implemented; as-built notes in PROJECT_STATUS.md. Deviations from the plan below: capacity reuses `license_seats` instead of a new `seat_capacity` column; the due field stays `due_date`)

- **Invariants (Approved / Planned):**
  1. Assignments are never deleted; they survive asset lifecycle changes (RESTRICT, not CASCADE) and account changes.
  2. Assignee is an **employee** (`employee_id`); the actor/checker-in is an **account** (`account_id`). Display names are read by join, never copied into assignments; the activity log stores a name snapshot for readability.
  3. Each row keeps assignee, checkout time/actor, return time/actor, condition out/in, due date, notes.
  4. A given employee cannot hold two simultaneous **active** assignments of the same asset: DB partial unique index on `(asset_id, employee_id) WHERE returned_at IS NULL`.
  5. **Capacity is not expressible as one unique index.** Physical assets have `seat_capacity = 1`; multi-seat software licenses may have `seat_capacity > 1`. Capacity is enforced **inside the assignment (check-out) transaction**: the transaction locks/serializes the asset row (`SELECT … FOR UPDATE` on PostgreSQL; a write-locking transaction on SQLite), counts active assignments, and only then inserts. **A global `UNIQUE(asset_id)` on active assignments is explicitly rejected** because it would break multi-seat licenses.
- `assets.seat_capacity INTEGER NOT NULL DEFAULT 1` is introduced in 1E; today's `license_seats` maps into it. No software-license redesign.
- **Assignment mode (Approved 2026-09-30 — IMPLEMENTED in Phase 1E as `assignments.assignment_type`; permanent is admin-only and has no due date/time; a checkout REQUIRES `due_date` (optional `due_time`); legacy rows with a due date → `checkout`, without → `permanent`; self check-out is always `checkout`). An employee can only REQUEST a permanent assignment — implemented minimally via nullable `requests.requested_assignment_type`; admin approval creates it (full request lifecycle remains 1G). Future, not implemented: per-asset maximum checkout duration:** every current equipment relationship is one of two kinds, and the kind belongs to the **assignment**, not to the asset or its category:
  - **Permanent / ongoing assignment** — equipment primarily assigned to an employee for ongoing use (desktop, monitor, keyboard, mouse, dock, other normal daily-use gear).
  - **Temporary checkout** — temporary custody for a day, shoot, project or short period (cameras, lenses, lighting, photo/video gear, TVs, other borrowed equipment).
  - Rules: the mode is **never inferred from category** (the same kind of asset may be permanently assigned in one case and checked out temporarily in another); **history preserves the mode that was used** (closed assignments keep it; it is not rewritten later); it is an assignment-level field. Likely shape: `assignments.assignment_type` with values conceptually `permanent` / `checkout` — **exact name, values, default for legacy rows, and whether a checkout requires a due date are decided during Phase 1E.** Interaction with the existing self-checkout and `due_date` behavior is also a 1E design point. The 1D migration and code do not touch this: today every assignment is undifferentiated.
- **Admin employee/equipment roster (Approved 2026-09-30 — future admin reporting/UI; NOT implemented):** see §4a. It depends on assignment mode, so the data-model portion is 1E and the report/export comes after 1E.

### 3.5 Asset-tag generation (Phase 1C — implemented for SQLite; PostgreSQL later)

- **Confirmed risk (F4):** `max(existing suffix) + 1` reissues the top tag after delete and is not atomic on PostgreSQL / multiple instances.
- **Approved:**
  - Keep the tag = prefix + numeric portion concept.
  - The numeric portion is **monotonic and never reused**. Archiving (or any removal of) the highest-numbered asset **does not lower** the sequence.
  - **Prefix changes apply only to future generated tags and do not reset the numeric sequence.** Example: `NC-00048` … prefix changes … next generated tag is `IT-00049`.
  - **Existing tags are immutable** unless a future explicit correction workflow is designed. (Today `PUT /api/assets/:id` allows editing the tag; Phase 1C closes that.)
- **Implementation direction:**
  - **Phase 1C (SQLite):** a durable high-water counter row updated inside the create transaction; the UNIQUE index on `tag` remains the final arbiter. `/api/next-tag` becomes a hint, not a reservation.
  - **Phase 2 (PostgreSQL):** a database-safe sequence/counter (`SEQUENCE`/`nextval` or atomic `UPDATE … RETURNING`). **No PostgreSQL sequences are built in Phase 1.**
  - Gaps are acceptable (a rolled-back create may burn a number).

### 3.6 Photos / cover photo

- **Confirmed:** F2 (cross-asset and dangling cover accepted).
- **Invariant:** a photo may only be the cover of the asset that owns it.
- **Enforce in both places:**
  - **Application:** validate `photo.asset_id === :id` (404/400 otherwise); clear cover to NULL allowed.
  - **Database (PostgreSQL):** `photos` gets `UNIQUE (id, asset_id)`; `assets` gets composite FK `(cover_photo_id, id) → photos(id, asset_id) ON DELETE SET NULL (cover_photo_id)` (PG ≥ 15 column-list form). SQLite can't add an FK to an existing column without a table rebuild, so in the SQLite era enforcement is app-only plus a data-repair query for any existing bad rows.
- No storage migration implied. **Impl:** *Straightforward* (app fix could ship independently of everything else).

### 3.7 Request lifecycle (Phase 1G)

- **Current:** one `open` state; employee cancel allowed through `approved`; no record of when IT first looked; transitions are check-then-write (F7).
- **Approved statuses:** `submitted`, `in_review`, `approved`, `denied`, `fulfilled`, `rescinded`, `cancelled`.

| Status | Meaning | Set by |
|---|---|---|
| `submitted` | Unopened by IT | employee (or IT on their behalf) |
| `in_review` | IT has opened/reviewed it (`opened_at`, `opened_by` recorded) | IT |
| `approved` | Approved, awaiting fulfilment | IT |
| `denied` | Terminal | IT |
| `fulfilled` | Terminal completion (was `completed`) | IT / system on check-out or check-in |
| `rescinded` | Withdrawn by the employee **before IT opened it** — terminal | employee |
| `cancelled` | Withdrawn by IT where appropriate — terminal | IT |

- **Employee:** may rescind **only from `submitted`**. Rescind is a **state transition, never a deletion**. Employees cannot freely edit or delete submitted requests (corrections = rescind + resubmit).
- **IT:** the first actual review/open action moves `submitted → in_review` and records `opened_at`/`opened_by`; IT may then approve or deny, and may cancel where appropriate. Once IT has opened it, **employee rescind is no longer permitted**.
- **Explicit action, no GET side effects:** opening is a controlled transition (e.g. `POST /api/requests/:id/open`, or equivalent); an ordinary GET/list must never mutate state.
- **Atomicity (required):** IT-open vs employee-rescind are conditional single-statement updates decided by rowcount, so exactly one wins and the loser gets a clear "already opened / already withdrawn" response:
  `UPDATE requests SET status='in_review', opened_at=…, opened_by=… WHERE id=? AND status='submitted'`
  `UPDATE requests SET status='rescinded', resolved_at=… WHERE id=? AND employee_id=? AND status='submitted'`.
  The same pattern applies to approve/deny/cancel. Identical in SQLite and PostgreSQL.
- **Types:** `equipment`, `return` (existing; `return` keeps its employee "dropped off" signal), and a future `issue` report reusing the same states. Only the schema/status groundwork is in scope for Phase 1; the issue-report feature is not.
- **History:** every transition writes an activity row (3.10).
- **Migration mapping:** `open→submitted`, `completed→fulfilled`, others unchanged.

### 3.8 Self-checkout (Phase 1B)

- **Current:** `self_checkout` default `'1'` (**ON**) at `src/db.js:140` via `INSERT OR IGNORE`. Code paths: `POST /api/assets/:id/checkout` non-admin branch (`src/server.js:415`), `notify.selfCheckoutToAdmins` (`:157`, `mailer.js:91`), `PUT /api/settings` (`:655`), front-end action gating (`public/app.js:528`) and the Settings checkbox (`:1031`); tests at `test/assets.test.js:105-113`.
- **Approved:** default for **NEW databases becomes OFF**. **Existing databases/settings must not be silently overwritten** by startup (`INSERT OR IGNORE` already preserves stored values). *Implemented in Phase 1B (2026-09-28): new databases default OFF; existing values are preserved.* Test fixtures that assume the ON default must set it explicitly.

### 3.9 Categories / locations

- **Current:** free-text columns on `assets`; suggestion lists in `settings` JSON.
- **Recommendation:** **no normalization before PostgreSQL.** No workflow today needs an FK (no per-location logic, rename-with-cascade, or category-specific fields beyond `Software License`). Cheap hardening instead: server-side validate `category` against the configured list on create/update/import, and warn on Settings renames that would orphan in-use values. Revisit `locations` as a table when physical inventory audits (Section 8) need location-scoped counts.
- **Impl:** *Straightforward*; no approval unless we want strict rather than advisory validation.

### 3.10 Activity / audit history (Phase 1E)

- **Retention (Approved):** asset, assignment, request and activity history is retained **indefinitely** by default; revisit only if the company supplies a formal retention/deletion policy. **No event sourcing.**
- **Current gaps:** cascade-deleted with the asset (F1); actor/subject reference mutable rows with no snapshot; no link to a request; `edited` logs field names, not values; `action` is unconstrained free text.
- **Approved direction:** keep the single append-only `activity` table and make it durable:
  - `asset_id` nullable and **RESTRICT**; add nullable `request_id`; subject = `employee_id`; actor = `account_id`; `actor_label` name snapshot at write time.
  - Controlled action list: `asset_created`, `checked_out`, `checked_in`, `status_changed`, `archived`, `identifier_changed`, `edited`, `photo_added`, `request_submitted`, `request_opened`, `request_approved`, `request_denied`, `request_fulfilled`, `request_rescinded`, `request_cancelled`, `return_requested`, `dropped_off`.
  - Small JSON `changes` (`{"field":[old,new]}`) only for status, tag, serial, location, condition and holder changes; never license keys.
  - Written in the same transaction as the change; no update/delete endpoints.
- **Semantics:** `account_id` = who acted; `employee_id` = the person affected/assignee.

### 3.11 Cascade review

| FK | Current | Class | Target / note |
|---|---|---|---|
| `assignments.asset_id → assets` | CASCADE | **CHANGE** | RESTRICT. Root of F1. |
| `assignments.user_id → users` | no action | **KEEP** | RESTRICT, repointed to `employees.id`. |
| `assignments.checked_out_by / returned_to → users` | no action | **KEEP** (repoint) | RESTRICT to `accounts.id`; accounts are deactivated, never deleted. If account deletion is ever needed → SET NULL + `actor_label` snapshot. |
| `photos.asset_id → assets` | CASCADE | **KEEP** | Dependent data, not business history; only fires on the (rare, restricted) purge. File cleanup remains an app duty. |
| `photos.uploaded_by → users` | no action | **KEEP** | RESTRICT to accounts. |
| `requests.asset_id → assets` | SET NULL | **CHANGE** | RESTRICT (a request must not silently lose the asset it was about). |
| `requests.user_id / created_by / resolved_by` | no action | **KEEP** (repoint) | employee / account RESTRICT. |
| `activity.asset_id → assets` | CASCADE | **CHANGE** | RESTRICT. Audit must outlive everything. |
| `activity.actor_id / subject_user_id` | no action | **KEEP** (repoint) | RESTRICT + snapshot label. |
| `assets.cover_photo_id` | **no FK** | **CHANGE** | Composite FK (3.6). |
| `tokens.user_id → users` | CASCADE | **KEEP** | Ephemeral credentials; repoint to `accounts`. |
| `sessions.sess` (uid in JSON) | none | **NEEDS DISCUSSION** | Owned by the auth phase (Phase 4); LIKE-based invalidation should go. |
| `outbox` | none | **KEEP** | Log table; stores address text. |

---

## 4. Approved Phase 1 slice order

Ordered to minimize schema churn: cheap fixes and the migration runner first, then lifecycle, then the identity split, then history hardening built on the split, then identifiers, then requests. Each slice is independently reviewable/mergeable into `stage`. If a sub-slice proves necessary, it is reported before scope expands. **All Planned — none started.**

### Phase 1B — Migration Foundation + Immediate Integrity Fixes — **IMPLEMENTED** (see PROJECT_STATUS.md; category/location length limits and list-membership validation deferred)
- **Goal:** migration runner; cover-photo ownership validation (F2, incl. repairing bad rows); invalid request `asset_id`/`user_id` → proper 4xx not 500 (F8); self-checkout default OFF for new DBs; small category/location input validation if it fits cleanly.
- **Affects:** `src/db.js` (runner, default), `PUT /assets/:id/cover`, `POST /requests`, asset create/update/import validation, tests/seed that assume self-checkout ON.
- **User-visible:** foreign/missing cover photo is rejected; clear errors on bad request input; new installs start with self-checkout off.
- **Tests:** runner idempotent on fresh + existing DB; cover own/foreign/missing/clear; request bad ids → 400; fresh DB default OFF while an existing DB's stored value is preserved; category validation.
- **Risk:** low. No major model rewrite.

### Phase 1C — Asset Lifecycle + Durable Tag Issuance — **IMPLEMENTED** (see PROJECT_STATUS.md)
- **Goal:** Archive replaces Delete; `archived_at`; `disposed`; terminal-state assignment guards (retired/disposed/archive need no active assignments; `lost` may stay assigned); monotonic never-reused tags via durable high-water counter; prefix changes don't reset numbers; tags immutable.
- **Affects:** `assets` (+ counter table), asset endpoints/filters/dashboard, activity, UI Delete→Archive with reason.
- **User-visible:** "Archive" with reason; archived hidden by default with a filter; tag field read-only after creation.
- **Tests:** archive preserves assignments/activity/photos/requests; guards; lost-while-assigned allowed; tag not reissued after archiving the top asset; prefix change continues the number; tag edit refused; dashboard counts.
- **Risk:** medium (touches many queries). Depends on 1B.

### Phase 1D — Employee / Account Split — **IMPLEMENTED** (as-built details in PROJECT_STATUS.md; `auth_provider`/`auth_subject` placeholders intentionally not added yet)
- **Goal:** `employees` + `accounts`; migrate `users` 1:1 keeping ids; update references; preserve current local login; roles `admin`/`employee`; IT can create employees with no account and assign to them.
- **Affects:** `users` → two tables, all joins on `users`, People/Accounts admin UI, CSV import `assigned_email`, seed script, mailer recipients, sessions (`uid` → account).
- **User-visible:** "Users" becomes people with optional login; assets assignable to no-login people. Login behaves as today.
- **Tests:** migration preserves every assignment/request/activity link; no-login employee assignable; one account ↔ at most one employee and vice versa; role mapping `user→employee`; admin authz independent of employee link/hostname; golden-workflow test still green.
- **Risk:** highest (large surface, no external auth). Depends on 1C (and 1B runner).

### Phase 1E — Assignment + Historical Integrity — **IMPLEMENTED** (migration 6; see PROJECT_STATUS.md. Not done: `seat_capacity` column, §3.10 audit improvements, cover-photo FK)
- **Goal:** history-safe FKs (assignments/activity/requests → assets RESTRICT; cover-photo FK path); assignments reference employees, actors reference accounts; active `(asset_id, employee_id)` unique index; `seat_capacity` with transactional capacity enforcement; durable activity/audit improvements (3.10); **assignment mode** — an assignment-level permanent-vs-checkout distinction that history preserves (3.4; approved 2026-09-30, exact field name TBD in 1E, not inferred from category).
- **Affects:** `assignments`, `activity`, `requests`, `assets` (SQLite table rebuilds), `log()` and `doCheckout`.
- **User-visible:** none directly; richer activity entries. (Whether check-out/assign flows expose the mode is decided in 1E.)
- **Tests:** asset with history can't be hard-deleted at DB level; same employee can't hold an asset twice; capacity 1 vs multi-seat enforced in-transaction; every audited action writes a row with actor snapshot and employee subject; assignment mode is stored per assignment, is not derived from category, survives check-in unchanged, and legacy rows get the chosen default.
- **Risk:** medium-high (table rebuilds). Depends on 1D.
- **Runner prerequisite:** already delivered in Phase 1C (`disableForeignKeys` migration option: FKs off around the transaction, `foreign_key_check`, always re-enabled); reuse it for these table rebuilds.

### Phase 1F — Serial Normalization + Lookup Ambiguity
- **Goal:** duplicate-serial report first; normalized serial + placeholder handling; duplicate warning with explicit admin override; ambiguous scanner/API response; tag↔serial cross-collision handling.
- **Affects:** `assets.serial` (+ normalized value), `/api/assets/lookup`, asset form, CSV import (duplicates reported), scan UI chooser.
- **User-visible:** duplicate-serial warning/confirm; a "which one?" chooser when a scan is ambiguous.
- **Tests:** normalization (trim/case/placeholders → missing); warning + override path; lookup ambiguity for dup serials and tag/serial collisions; single-asset tag+serial match not ambiguous; no first-match fallback anywhere.
- **Risk:** medium. Depends on the duplicate report over real data.

### Phase 1G — Request Lifecycle
- **Goal:** approved status model; `opened_at`/`opened_by`; explicit open action; employee rescind (from `submitted` only); IT cancel; atomic conditional transitions; activity per transition.
- **Affects:** `requests`, request endpoints, admin request detail, employee-side cancel→rescind, dashboard/open-request queries.
- **User-visible:** employees can withdraw only untouched requests; IT sees opened time.
- **Tests:** rescind ok from `submitted`; refused after open; open-vs-rescind race (exactly one wins); rescind never deletes; GET doesn't mutate; timestamps/history preserved; approve/deny/cancel/fulfil transitions; return-request flow unchanged.
- **Risk:** medium. Depends on 1E (and 1D employee identity).

### 4a. Future work after Phase 1E (approved 2026-09-30, not scheduled into a Phase 1 slice) — Admin employee/equipment roster
- **Requirement:** an admin can view a complete employee/equipment roster in a flat, spreadsheet/CSV-like layout and export it to CSV. It must make it easy to answer: who has what equipment; what is permanently assigned to each employee; what is only temporarily checked out; and which asset tags belong to those items. **Permanent assignments and temporary checkouts must be clearly separated.**
- **Conceptual columns (final UI and export columns TBD):** Employee; Department; Permanent equipment; Temporary checkouts; Asset tags; Checkout date; Return/due information where applicable.
- **Dependency:** needs the assignment-mode field from Phase 1E, so it cannot be built correctly before then. The data-model portion is recorded under 1E; this report/UI/export is separate later work. Not implemented in 1D.

---

## 5. Remaining unresolved decisions

Only these remain open (none block Phase 1B):

1. **Duplicate-serial report results** (1F): what real data contains; may inform the placeholder list.
2. **Correction workflow for a wrongly issued tag** (deferred): tags are immutable until such a workflow is designed.
3. **Session invalidation / `sessions` FK design** — belongs to the authentication phase (Phase 4).
4. **Final auth provider, unmatched-login "access not provisioned" experience, and the future `issue` request feature scope** — out of Phase 1 implementation scope.
5. **Asset-tag prefix/format for production** (e.g. whether to keep `NC-` and 5-digit width) — convention is approved; the concrete production value is a setting.

Resolved and removed from the open list: employee/account model and roles, serial policy, lifecycle statuses and `lost` rule, request statuses and rescind rule, self-checkout default, tag issuance rules, barcode/identifier model, audit retention, assignment capacity design.

## 6. Out of scope / unchanged in this slice

No production code, schema, migration, or test changes. Rate limiting, session store, storage migration, auth provider, Railway provisioning, PostgreSQL migration, portal UI and scanner features are untouched.
