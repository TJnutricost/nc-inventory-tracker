# NC IT Inventory Tracker — Project Decisions

> Durable product and architecture decisions that future work must not accidentally violate. [PROJECT_STATUS.md](../PROJECT_STATUS.md) is authoritative for current state and carries the short "Current Product Rules" list; this file adds the *why* and the history of changes of mind. Implementation reports are in [PROJECT_HISTORY.md](PROJECT_HISTORY.md).

**How to read it.** Each decision has an id (`D-nn`, cited from the other docs), a date, a status and a short reason. **SUPERSEDED** entries are kept only where the history is useful, and each points to its replacement; nothing marked SUPERSEDED is current. A decision with no date is a standing principle.

## Superseded at a glance

| Old decision | Replaced by |
|---|---|
| D-06 Railway + Supabase | D-07 Railway-first, provider-neutral |
| `admin.<domain>` / apex-domain portals (inside D-08) | D-08 subdomains of an existing parent domain |
| Employee Portal planned *after* the PostgreSQL/auth foundation (D-09 history) | D-09 Employee Portal V1 is Phase 2 |
| Serials: warn + admin override (Phase 1A) | D-17 hard uniqueness on the normalized serial |
| Self-checkout: global setting; "default OFF for new databases" (Phase 1A/1B) | D-16 per-employee permission, default ON |
| Employee may cancel until the request is approved (Slice 2 rule) | D-20 rescind only until IT opens it (`opened_at`) |
| "Employees see availability windows, not identity" (2026-10-02 notes) | D-25 no requirement to hide identity |
| Waitlist + **release requests** to the current holder (original Slice 8 plan) | D-29 no release-request workflow |
| Employee Browse lists only available assets | D-41 discoverability is separate from availability |

---

## Process and repository

### D-01 Preserve the existing application — 2026-09-28 — active
Do not rewrite from scratch; the audited source already had most MVP workflows. Prefer incremental migration.

### D-02 Branch strategy: `stage` → `main` — 2026-09-28 — active
`stage` is the shared integration branch and the GitHub default. Short-lived feature/chore/docs branches are cut from `stage` and merged back into `stage` by pull request. `main` is the stable/release branch; ordinary work never goes straight to it, and promoting `stage` → `main` is a separate, deliberate, separately-approved step. (Reason: several contributors/agents work in parallel and `main` must stay deployable.) No branch protection or CI is configured yet.

### D-03 Implementation worker — 2026-09-28 — active
Claude Code is the default implementation worker (inspection, code, tests, migrations, running commands, updating the tracker). ChatGPT plans, supervises and reviews; Codex is a secondary implementer/reviewer.

### D-04 Baseline before migration — 2026-09-28 — satisfied
Establish a known-good local baseline and verify the scanner/assignment lifecycle before any infrastructure migration. Done in Phase 0.

### D-05 Tracking documents — 2026-10-05 — active
`PROJECT_STATUS.md` (concise current tracker) + `docs/PROJECT_HISTORY.md` (archive) + this file. Every meaningful slice updates PROJECT_STATUS.md; completed-slice implementation/QA detail goes to PROJECT_HISTORY.md. Slices stay small and are not combined with unrelated work.

## Infrastructure and architecture

### D-06 Railway + Supabase — 2026-09-28 — **SUPERSEDED by D-07 (same day)**
Originally Supabase for PostgreSQL, storage and auth with Railway for the app. Dropped to avoid vendor lock-in before Railway access or an auth provider was confirmed.

### D-07 Railway-first, provider-neutral — 2026-09-28 — active (nothing built yet)
Application hosting: Railway. Database: managed PostgreSQL, described and built provider-neutrally (Railway PostgreSQL preferred). Object storage: S3-compatible (Railway or another provider). Authentication: **TBD**, no provider assumed. Admin and employee portals share one backend, database and auth system. PostgreSQL backup **and a tested restore procedure** are a hard requirement before any real inventory is migrated. Phase naming is generic ("Managed PostgreSQL", "Object Storage") rather than vendor-named.

### D-08 Portal hostnames — 2026-09-28 — active (hostnames TBD)
Both portals are expected to be subdomains of an existing hosted parent domain, not a domain bought for this project, and the employee portal is not assumed to be the apex. Exact domain/subdomains/DNS are TBD and nothing is configured. Authorization is enforced by the backend, never by hostname or client state; session design must not assume cookies are shared across the two hostnames. *(Supersedes the earlier `admin.<domain>` / apex assumption.)*

### D-09 Phase 2 is Employee Portal V1, not the PostgreSQL migration — 2026-10-02 — active
After Phase 1, build the employee portal incrementally on the existing employee interface (it is not a separate app and is not being rebuilt). PostgreSQL, object storage, the auth provider and Railway are later infrastructure phases and are not prerequisites. *(Replaces the 2026-09-28 plan to build the portal after the PostgreSQL/auth foundation.)*

### D-10 Authentication direction — 2026-09-28 — active (provider TBD)
One shared system for both portals. Google sign-in is the expected primary employee login with an email magic-link fallback. No open self-registration: employees/accounts are pre-provisioned, and a verified login links to an *existing* employee by normalized work email only (an unknown login never creates an employee and is blocked). Persistent sessions still require a valid authenticated session (cached browser state is never proof of authorization); no broad offline caching of sensitive data. Session duration and "remember me" are decided in the auth phase.

### D-11 Repository direction — 2026-09-28 — active
Keep admin and employee surfaces in one repository. Splitting into packages is a noted future option, not planned.

### D-12 Scanner strategy — 2026-09-28 — active
Four input methods, all implemented and feeding one backend lookup: desktop USB scanner, desktop Bluetooth scanner (both keyboard-wedge), manual entry, native phone-camera scanning. A **paired phone as a wireless scanner** for a desktop/kiosk session is a recorded future concept (low-priority backlog / exploratory), not designed or scheduled. Real-device verification is required, never assumed from desktop testing; phone-camera scanning needs an HTTPS environment.

## Data model and integrity

### D-13 Employee/person is separate from login account — 2026-09-28 (built Phase 1D) — active
`employees` are people/assignees and may never log in; `accounts` are logins with the role (`admin` / `employee`), at most one per employee, optionally linked. Assignee = employee, actor = account. IT can create and assign equipment to someone with no login. An admin is just a role on a person. A person is deactivated, never deleted.

### D-14 Archive-first historical integrity — 2026-09-28 / 2026-10-01 — standing principle
Assets are archived, never destructively deleted. Assignment, activity and request history is durable: history foreign keys are RESTRICT, no endpoint edits or deletes history, and requests keep the wording (path text, asset label) they were made with. Every future schema change must preserve this.

### D-15 Assignment mode — 2026-09-30 — active
The *assignment*, not the asset or category, is permanent or a temporary checkout, and history keeps the mode it was created with. Permanent assignments are admin-only (server-enforced; employees ask via a request). A temporary checkout requires a return date (time optional); a permanent one has neither. One active assignment per employee+asset; seat capacity (`license_seats`) is enforced inside the check-out transaction.

### D-16 Self-checkout is a per-employee permission, default ON — 2026-09-30 — active
Admin-revocable per employee; always a temporary checkout; a disabled employee can still browse, request and be assigned. There is no global toggle (the old global setting is deprecated and ignored). *(Supersedes the Phase 1A/1B plan that defaulted self-checkout OFF for new databases.)* Reserving does **not** need this permission (see D-27).

### D-17 Serial numbers: hard uniqueness on the normalized serial — 2026-10-01 — active
Stored as typed (surrounding whitespace trimmed); blank or exactly `N/A` means "no serial" (NULL). A computed `serial_normalized` (trim + lower-case) is `UNIQUE` across the whole inventory including archived assets. Nothing else is stripped (`ABC-123` ≠ `ABC123`). The key is computed in the app, not a DB collation (portable to PostgreSQL). *(Supersedes the Phase 1A "warn + admin override" and its longer placeholder list.)*

### D-18 Asset tags — 2026-09-28 — active
The tag is the canonical identifier: monotonic, never reused (a durable counter independent of the prefix), immutable once issued; a prefix change affects only future tags. Production prefix/format is still to be chosen (prefixes containing digits make legacy-tag inference ambiguous).

### D-19 Identifier model — 2026-09-28 — active
No barcode column and no identifier table: scanner types are input methods, not identifiers; labels are Code 128 of the tag. Unknown scanned codes resolve through tag, then normalized serial.

### D-20 Request lifecycle — 2026-10-02 — active
Request status stays in the existing columns; the user-facing lifecycle is *derived* (Submitted → In review → Approved → Fulfilled / Declined / Rescinded / Cancelled, plus Dropped off for returns). `requests.opened_at` is set by IT's first open or any admin action; **an employee may rescind only until IT has opened it** (atomically enforced, never a delete). Transitions are guarded in `src/requests.js` with DB CHECKs. *(Supersedes the Slice 2 rule that allowed cancelling until approval, and the 1A idea of new status values.)*

## Employee portal

### D-21 Employee visibility contract — 2026-10-02 — active
Enforced on the server, not by hidden navigation. An employee reads only their own profile, assignments, history and requests; the employee directory (`GET /api/users`) is admin-only; the profile is read-only (IT edits it). An asset *page* is visible to an employee only if they hold it or it is available, shared (`available_to_request`) and not archived; anything else is indistinguishable from "not found", including its photos. Admin authorization never depends on hostname.

### D-22 Employee portal scope — 2026-09-28 — active
Read/create oriented, not general CRUD: view own equipment and requests, request equipment, request a return, report an issue, rescind an eligible request, reserve, join waitlists. Employees cannot edit assets, assignments or other people, reassign equipment or grant themselves access.

### D-23 Equipment catalog model — 2026-10-01 — active
One generic parent/child tree (`catalog_nodes`) with no level-specific columns; sibling names unique ignoring case/spacing (archived included); no cycles; nodes are archived, not deleted (delete only if nothing refers to it); a node is *live* only if it and all ancestors are not archived, and only live nodes are visible, assignable or requestable for employees. Requests may name any level (category, model, or a specific asset) and snapshot the path text at request time. Nothing deeper than the root is inferred from legacy data.

### D-24 Categories — 2026-10-01 — active
`assets.category` stays free text for display/filter/import compatibility and is kept equal to the root catalog entry an asset is filed under; the catalog is the source of structure.

### D-25 Availability calendar and identity — 2026-10-02 — active
Principle: the broader the scope the more summarized the calendar; the more specific, the more detail. Employee calendars are anonymous (no holder names, departments or ids). **There is no requirement to hide an employee's identity from other employees when it is useful for coordination** (for example the blocking-reserver email names the waiting employee). *(Supersedes the earlier "availability windows, not identity" privacy rule.)*

### D-26 "Today" is the server's UTC date — standing limitation
Calendar, reservation, overdue and hold-start logic all use the server date; a late-evening local time can be a day off. Hold deadlines in email use `APP_TIMEZONE` (or the server zone).

## Reservations and waitlist

### D-27 Reservations — 2026-10-05 — active
A reservation claims **one specific physical asset** (single-seat only) for an inclusive range of calendar dates (no times until Slice 8.1). Approval is a **per-asset** setting (OFF by default: a valid reservation is confirmed at once; ON: pending IT approval, and approval re-checks the whole range). Only *confirmed* reservations (and active holds) block dates; a pending one blocks nothing. Employees may cancel their own and shorten (never extend or move) a confirmed one. `available_to_request` is **OFF by default** and existing assets were not silently exposed. "Check out now" needs the employee's self-checkout permission; **Reserve does not**. Global/category calendars never carry Reserve; it lives on the single-asset calendar.

### D-28 Waitlist: FIFO with 24-hour offers; never auto-reserve — 2026-10-05 — active
A waitlist entry is one employee, one specific asset, an inclusive date range, in FIFO order. When an entry's **entire** range is free it is offered a 24-hour hold (oldest eligible first; an older entry that is still blocked does not hold up a younger eligible one). The hold blocks everyone else. **The system never creates a reservation automatically**: the employee confirms (normal reservation rules apply, so ON-approval assets become pending) or declines; expiry, decline, leave and IT removal pass the offer to the next eligible entry. A pending reservation made from a hold keeps its place in line. Conflict and hold enforcement is server-side and transactional.

### D-29 No release-request workflow — 2026-10-05 — active
Nothing in the app asks, lets anyone ask, or pressures a current reserver to give up or shorten a reservation. *(Supersedes the original "Waitlist + Release Requests" plan and the 2026-10-02 release-request notes, which are kept only in PROJECT_HISTORY.md Appendix B.)* Teams may coordinate outside the app.

### D-30 The blocking reserver gets an informational email only — 2026-10-05 — active
When someone joins a waitlist (or edits their dates so it newly overlaps), the current confirmed reserver gets "Another team is waiting… No action is needed. Your reservation is unchanged." No release CTA, no suggestion to shorten, nothing required of them.

### D-31 Editing waitlist dates resets queue position — 2026-10-05 — active
Changing the requested dates is asking for something new: re-validated like joining, and the entry goes to the back of the line (a new strictly-increasing `queue_seq`). Only a *waiting* entry can be edited, never one holding an offer; only its owner.

### D-32 IT may remove a waitlist entry, never reorder it — 2026-10-05 — active
No manual priority changes; IT cannot confirm or decline for an employee.

### D-33 Time of day is optional and comes in Slice 8.1 — 2026-10-05 — active (not started)
Slice 8 is date-only. Optional start/end times and partial-day availability are Slice 8.1 and must make availability, conflict and waitlist-eligibility logic time-aware; nothing was designed yet beyond avoiding choices that would make it harder.

## Email and notifications

### D-34 Communication is email, not in-app messaging — 2026-10-05 — active
No chat or messaging product. Employees should eventually be able to leave a note when submitting a request/reservation, IT can leave reasons on decisions (stored today as `decision_note`), and those reasons can later appear in emails. Notifications stay targeted; there is no broad preference center.

### D-35 Existing SMTP transport, credentials only in the environment — 2026-10-05 — active
The existing nodemailer / Google Workspace SMTP mailer is reused (no second provider); it needs an App Password and only sends when `SMTP_USER` and `SMTP_PASS` are both set. SMTP passwords, app passwords, API keys and OAuth secrets live in `.env` locally and Railway secrets in deployment and **never** in the database or the settings UI (the settings API refuses credential-shaped keys). Password-less IP-relay SMTP is not supported by the current mailer. **Current email direction:** Google Workspace SMTP is the working transport today, and the Google Workspace OAuth connection (D-37) is the priority way to manage the mailbox later. *Resend and Postmark were only early (2026-09-28) alternative-provider ideas listed as "TBD"; they were never pursued and are not the planned provider. Historical / alternative research only.*

### D-36 IT email identity — 2026-10-05 — active
Settings stores only a display name and an IT contact / reply-to address. Mail is sent From the verified sender with the display name, with the contact as Reply-To; only `MAIL_ALLOW_IT_FROM=1` (operator asserts the provider allows it) makes the contact the From address. It applies to all app email.

### D-37 Shared IT mailbox vs individual IT identities; Google Workspace OAuth — 2026-10-05 — PRIORITY future (not implemented)
Admin Settings → Email → Connect Google Workspace: an admin authorizes/changes the sending mailbox through Google's OAuth consent flow with no manual `.env` / Railway-secret edits and no Google passwords stored by the app. Individual IT admins stay individual employee/account identities (audit log, personal notifications); the shared IT mailbox remains the operational sending/reply identity where appropriate. This would replace the App Password setup.

### D-38 `MAIL_TEST_RECIPIENT` development redirect — 2026-10-05 — active
Server-environment only (never in Settings): every message is physically addressed to one test address with `[DEV for <intended>]` in the subject and a banner in the body; From/Reply-To and business logic are unchanged and the stored employee address is never altered; the outbox keeps the intended recipient plus `delivered_to`. An invalid value **fails closed** (nothing is sent). Unset = normal delivery. Production must not set it unless deliberately.

### D-39 Seeding and tests never send external email — 2026-10-05 — standing rule
`NC_NO_EXTERNAL_MAIL=1`, set by the seed scripts and the test harness before the app loads, makes the app skip `.env` and never create an SMTP transport. (Root cause of the incident: deleting `SMTP_*` from the environment is not enough, because loading the app re-reads `.env`.) Regression-tested with a fake SMTP server. The Outbox is a development/debug record, not proof of delivery.

## Search, discoverability and navigation

### D-40 Search — 2026-10-05 — active
Normalized, case-insensitive, token-wise substring matching (every word must match somewhere) over tag, name, serial, brand, model, category, location, the whole catalog path and inherited **Search keywords**; IT also by holder name, employees never. Search keywords are stored on the **catalog entry** (comma-separated aliases, normalized, no `#`), inherited by every asset beneath it, and never required on individual assets. No search service or dependency; no fuzzy/AI search.

### D-41 Discoverability is not availability — 2026-10-05 — active
A shared (`available_to_request`) asset that is temporarily checked out, reserved or held **stays visible** in employee Browse and search, shown with its state (Available / Reserved / Checked out · back date) and opening its availability calendar. Still excluded: `available_to_request` OFF, archived or not-lendable, permanently assigned equipment, and the employee's own (My equipment). Authorization is unchanged (the asset page of an item someone else holds is still not theirs).

### D-42 Contextual, URL-backed Back navigation — 2026-10-02 — standing rule
Every screen reached from another carries its source in the URL (`from=` for the calendar and catalog, `src=` for the asset page) and shows the lightweight `.back` link to it, preserved through nested navigation. Never rely on browser history alone, and add no Back link when the screen was opened from its own root (e.g. the sidebar).

### D-43 Mobile shell — 2026-10-02 — active
Five bottom tabs for both roles (Home · Browse/Assets · centred Scan · Requests · Profile). The hamburger/drawer exists for admins only and holds administration only; employees have none. Real-iPhone QA of this shell passed (Chrome on iPhone).

### D-44 Role-aware shell label — 2026-10-05 — future polish (pending)
Replace the generic "IT Assets" subtitle: admin → "IT Admin", employee → "Employee Portal" (preferred wording).

---

## Reconciliation notes (2026-10-05)

Recorded while consolidating the tracker; none changes a product decision.

1. **Production email provider — settled by the owner.** The old open-decision list read "Resend / Postmark / existing SMTP". Current direction: Google Workspace SMTP works today; the Google Workspace OAuth connection is priority future work (D-35, D-37). Resend/Postmark are historical / alternative-provider research only, not planned.
2. **Railway access — not re-confirmed.** "No Railway access, no completion date" was last recorded 2026-09-28 and nothing since confirms or clears it. It is not treated as an active blocker until a deployment/staging task actually needs access.
3. **`stage` → `main` promotion — open decision.** The workflow stays `feature/*` → `stage` → `main`. `main` was last updated 2026-09-28 and `stage` is many merged PRs ahead, but that alone does not mean a promotion is due; it is a deliberate release/staging decision (D-02).
