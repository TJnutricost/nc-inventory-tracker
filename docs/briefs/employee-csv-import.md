# Employee CSV import (and the scanner permission)

Owner-requested 2026-10-28. One admin-only feature, built on `feature/employee-csv-import`, delivered in one PR with the status refresh.

## Goal

An admin loads the company roster (2,000+ people) from a CSV so that each person can sign in with their Google Workspace account and request equipment, without invitations or passwords.

## What the existing system already does (reused, not changed)

- People are `employees`; a login is an optional `accounts` row (D-13).
- **Google sign-in never creates a login** (revised 2026-10-29: it matches an existing active login's email only; see `docs/briefs/google-sign-in.md`). The import creates people (and logins/invites exactly as before); a person imported without a login cannot sign in with Google until IT gives them one. (Written 2026-10-26, when Google sign-in still linked by work email.)
- Permissions: `employees.can_self_checkout` (per employee, D-16), admin = role on an account. Permanent assignments stay admin-only.

## CSV

Columns, and only these: `first_name`, `last_name`, `work_email` (all required), `department`, `job_title`, `location` (the existing `building` field), `phone`. A combined `Name` / `Full name` column is refused and never split. **Any other column, including `Employee ID`, is refused with a 400 that names it; nothing is silently ignored.** Header spelling is flexible only in case and spaces (`First Name` = `first_name`).

## Decisions

0. **First and last name are stored separately (permanent project rule).** Migration 19 (SQLite, rebuilt table) / 003 (PostgreSQL) adds nullable `employees.first_name` and `last_name`. `name` stays as the display name every existing consumer reads: it is composed `"First Last"` whenever the parts are set. Existing rows keep both parts NULL: a full name is **never split automatically**, and such legacy people stay viewable and editable (the Edit sheet shows the name on file and leaves the parts optional; filling both replaces it, one alone is refused). Add person, Edit person, My profile and first-run setup use two inputs; the API takes `first_name` + `last_name` (a legacy caller that sends only `name` is still accepted, parts stay NULL). Sorting and display keep using `name`; moving every consumer to the parts and dropping `name` is a later, separate step.
1. **Match key = normalized work email** (trimmed, lower-cased). There is no stored employee id, so the template has none.
2. **Create**: new employee, `active`, **no account, `can_self_checkout = 0`** (explicit in the insert, and now also the column default). **Update** (matched person): first name, last name (and so the display name), department, job title, phone and location (the `building` field) only where the CSV cell is non-blank; a blank cell never erases a value. **Never touched**: status, role, accounts, passwords, sessions, self-checkout permission, assignments, requests, reservations, waitlist, history.
3. **Never guess.** A row is left out when: required field missing/invalid; the same email appears twice with identical data (the first is imported, the rest are "duplicate"); the same email appears with different data (all of them are conflicts); the email is the login of a different person or of a login with no person; two stored people differ only in email letter case; the matched person is inactive (imports never reactivate).
4. **Preview, then confirm.** `POST /api/import/employees/preview` returns the plan (create / update / unchanged / left out, with per-row changes and reasons) and writes nothing. `POST /api/import/employees` takes the same file again and **recomputes the plan inside its transaction**; it requires `acknowledge=1` when any rows would be left out, and `create` / `update` counts from the preview (409 if the data moved meanwhile). Nothing is stored between the two calls.
5. **One transaction.** SQLite: `BEGIN IMMEDIATE`. PostgreSQL: `LOCK TABLE employees IN SHARE ROW EXCLUSIVE MODE`, then bulk `INSERT ... unnest` / `UPDATE ... unnest`. Any failure rolls everything back. Re-importing the same file changes nothing and logs nothing (idempotent). One `activity` row (`employees_imported`, no asset) records a changing import.
6. **Limits**: 2 MB, 5,000 rows, field lengths (name/department/title/location 100, phone 40, email 254), no control characters.
7. **Results** are downloadable as CSV from the preview and the completion screen (generated in the browser; formula-looking cells are neutralized like the asset export).
8. **Admin only** (`admin` middleware, 403 for employees, 401 anonymous). Template: `GET /api/import/employees/template.csv`.

## Scanner permission (additional requirement)

Reuses `can_self_checkout`; no new permission. **Who may scan = admins + employees with self-checkout.**

- Server: `GET /api/assets/lookup/:code` (the scanner's API) answers **403** to an employee without the permission; checkout already did. Browsing, asset pages, requests and reservations stay open to every signed-in employee.
- Client: `canScan()` hides the Scan tab, sidebar item, top-bar icon, Home Scan button and the Browse scan button; `#/scan` redirects to Home; `openScanner` returns before touching the camera.
- **Every creation path starts with self-checkout OFF**: CSV import, manual Add person, and Google sign-in (first-time auto-provisioning, D-10). Application inserts say `0` explicitly and the database default is `0` (migration 19 / 003), so a path that forgets still lands safe. Google sign-in alone never grants scanner access; IT turns it on per person. Existing employees keep what they have (the migration copies every value).

## Code map

- `src/employeeImportPlan.js` pure rules (CSV → rows → plan), shared by both drivers.
- `src/employeeImport.js` (SQLite) and `src/pg/employeeImport.js` (twin) on the temporary seam as `data.employeeImport.{preview,apply}`.
- Routes in `src/server.js`; UI: *Import CSV* on People (`employeeImportSheet` in `public/app.js`).
- Tests: `test/employee-import.test.js` (both drivers), `test/pg/pg-employee-import.test.js`; seam ratchet/parity lists updated.

## Known limits / follow-ups

- `name` is still the display name and the sort key (a person sorts by first name, as before). Consumers of `name` (emails, lists, history) are unchanged; migrating them to the parts is a later step.
- The first admin made by `/api/setup` and people made by Google auto-provisioning have first/last NULL (Google's `given_name` / `family_name` are not read yet).
- No stored employee-number column; no deactivation or "missing from file" handling, no HR sync or scheduled roster sync, by design. **Bulk assignment import is upcoming** (see PROJECT_STATUS).
- Running migration 19 / 003 on shared Railway staging or production needs the owner's approval; it was only run on local and test databases.
