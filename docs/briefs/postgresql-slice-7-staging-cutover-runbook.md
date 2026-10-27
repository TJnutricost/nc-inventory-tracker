# PostgreSQL migration — Slice 7 (Railway staging cutover): runbook

**Decisions:** D-46, D-48. **Status:** DRAFT for owner review (Slice 7A, documentation only, 2026-10-26). **Nothing in this document has been executed.** Slice 7A changes no application code, script, Dockerfile, dependency or test configuration, makes no Railway access or change and runs no migration. Slice 7B+ (the cutover) starts only after the owner passes the gates below.

Base: `integration/postgresql` at `34cae91` (PR #51, Slice 6 complete: 6A `5778904`, 6B `984ffcf`, 6C `d8e86fa`). Read first: `PROJECT_STATUS.md`, `docs/briefs/postgresql-slice-6-data-migration.md` (owner decisions Q1–Q5, 6A/6B/6C as built).

## What is already decided (not reopened here)

- Staging only; production is out of scope. The production environment's unapplied draft service (branch `main`, no Volume) is **never deployed**.
- Source database: the Railway Staging Volume's `/data/assets.db` (Q5). Invalid `license_seats` are fixed at the source and never rounded; a database that still has them is refused (Q1). `sessions` are not copied, so everyone signs in again (Q2). `outbox` and `activity` are copied in full (Q3).
- Backup and restore must be tested and working before the staging cutover (D-46, mandatory).
- `integration/postgresql` → `stage` merges stay frozen until the cutover (D-46; #34 and #37 are historical exceptions, not precedents). `main` is never touched.
- **SQLite and seam removal come AFTER Slice 7**, as their own slice, together with seeds on PostgreSQL (Q4). Earlier text saying "at the cutover" is superseded. Until then SQLite stays in the code and stays the rollback path.

## Facts the plan depends on (verified in `34cae91`; re-verify at G1)

- `pg-copy`, `pg-backup` and `pg-restore` **refuse any `DATABASE_URL` that is not localhost / 127.0.0.1 / ::1** ("Railway is Slice 7"). `pg-preflight` opens SQLite read-only and has no network access. `pg-verify` reads SQLite and PostgreSQL.
- The Dockerfile copies only `src` and `public` (no `scripts/`) and installs no `pg_dump`. The tools cannot run inside the deployed image as it is.
- Photos are files in `$DATA_DIR/uploads` on the Volume; Slice 6 copies only the `photos` rows. The object-storage bucket is provisioned but unused and stays unused in Slice 7.
- Railway PostgreSQL is provisioned, empty and not connected to the app.

## Owner approval gates

Each gate is an explicit written "go" from the owner for the named step only. A "go" at one gate does not carry to the next, and a change of plan returns to the earlier gate. Nothing past a gate starts without it.

| Gate | The owner approves | Unlocks |
|---|---|---|
| **G1** | This runbook, the decisions in "Decisions to resolve" (at least D1–D4), and the scope of the tooling PR (7B) | Writing the tooling PR; still no Railway access |
| **G2** | Railway **read-only** access: inspect service config, variable **names**, deployments, Volume contents, Postgres state. Names exactly who acts and how. No variable values are displayed or recorded | The pre-cutover inventory (step 1) |
| **G3** | The **Volume-write permission** (below), if any is needed, for the named path and purpose only | The snapshot step |
| **G4** | The rehearsal: local Postgres, a snapshot, no Railway write | Rehearsal (step 3) |
| **G5** | The cutover window and the exact deployment steps, including the change of the staging service's source branch and its variables | The cutover (steps 4–6) |
| **G6** | **Go / no-go** on the QA results | Keeping staging on PostgreSQL, or rollback |
| **G7** | The separate SQLite / seam removal slice | Out of Slice 7 |

### Volume-write permission (G3)

The Volume is the only copy of staging's data and photos. The default is **no write to `/data`**.
- **Read-only (G2):** reading `assets.db`, `-wal`, `-shm` and listing `/data/uploads`.
- **Write (G3 only):** anything that creates, renames or deletes a file under `/data`, including a snapshot written next to the database. The owner names the path (for example `/data/snapshots/`) and the purpose. Preferred: write the snapshot to the container's ephemeral `/tmp` (not the Volume) and copy it out.
- Never allowed: modifying, moving or deleting `assets.db`, its `-wal` / `-shm`, or anything in `/data/uploads`; `rm`, `mv` or `cp` over existing files; mounting a different Volume at `/data`; deleting or recreating the Volume.
- Opening `assets.db` read-write by an ad-hoc tool is also a write (SQLite can checkpoint the WAL). Snapshot tools open it read-only or use the backup API.

## Runbook

### 0. Preconditions (all must be true; record each)

1. `integration/postgresql` HEAD is verified on GitHub and the working tree it is built from is clean; teammate work is preserved.
2. The suite is green on that HEAD (`npm test`, `npm run test:pg`, `npm run test:pg-suite`; since Slice 7B they work on Node 22 and 20.12+ through `test-support/run-tests.js`; the older `node --test test/` form did not start on Node 22.23), SQLite and with local PostgreSQL (`npm run db:up`): the PR #51 result was 949 passed, 0 failed, 1 cancelled on Node 22.23 with local PostgreSQL running, using `node --test 'test/**/*.test.js'` (the cancelled one is the known `harness.test.js` item).
3. `stage` is compared with `integration/postgresql` for hotfixes since the branch point; any hotfix is ported and verified first (D-48 point 9).
4. Staging mail is fail-closed (`NC_NO_EXTERNAL_MAIL` or `MAIL_TEST_RECIPIENT`) for the rehearsal, the cutover and QA; confirmed from variable names and, with the owner, values.
5. The owner has said whether staging data may be lost on rollback (decision D3).
6. No credential appears in chat, a commit, a log or a file in the repository. Railway reference variables are used; nothing is pasted.

### 1. Pre-cutover inventory (read-only, after G2)

Record (names and states, never secrets): the staging app service's source repository and **branch**, its deployment trigger and any "wait for CI" or auto-deploy setting, its variable **names**, its health-check path, the Volume (name, mount path, size), the Postgres service (version must be 18, empty, state) and its connection options, the bucket (empty), domains, and the last good deployment id (the rollback target). Check that the Postgres database has no tables.

### 2. WAL-consistent snapshot of staging SQLite

SQLite runs in WAL mode: a plain copy of `assets.db` can miss committed data that is only in `assets.db-wal`, and copying all three files while the app writes can still tear. A snapshot must come from SQLite itself.

- **Method:** the SQLite online backup API (better-sqlite3 `db.backup()`), or `VACUUM INTO`, opened read-only, writing to a path outside the Volume (`/tmp`) unless G3 names another. Never copy the raw files while the service runs. The script is a file, not an inline quoted argument. It runs through a Railway shell, which needs the same G2/G3 approvals and, because the image has no `scripts/`, the script is supplied through stdin or another approved route. **Unresolved (decision D7).**
- **Rehearsal snapshot:** online, no write freeze.
- **Final snapshot (cutover only):** first freeze writes, then snapshot. Freeze means the staging service is stopped or placed in maintenance for the whole window, so no row lands after the snapshot. Note the time.
- **After taking it, record:** size, SHA-256, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, schema version, and a row count per table, and check that the snapshot opens read-only and that its newest `activity` row is not older than the newest one seen in a read-only look at staging just before.
- **No test write to live SQLite, ever.** Snapshot validation never writes a probe row, checkpoints the WAL by hand or otherwise modifies the live database. The WAL-consistency of the method is proven only on a **local** WAL-mode fixture during the rehearsal (step 4), never on staging.
- **Handling:** the file may contain real names and email addresses. Keep it on an encrypted disk, never in the repository, never in chat or an artifact.

### 3. Preservation of SQLite, photos and backups

- The original `/data/assets.db`, `-wal` and `-shm` stay in place and untouched for the whole of Slice 7 and until the owner explicitly releases them in the later removal slice.
- Keep two off-Volume copies of the final snapshot and its SHA-256 (a second location chosen by the owner, decision D5). Keep the rehearsal snapshot until the owner says otherwise.
- Photos: `/data/uploads` stays untouched and the PostgreSQL-driver service keeps the **same Volume at `/data`**. Record the file count and total size before and after (read-only). Optionally archive a copy off the Volume (a G3-class decision if it writes anywhere on `/data`).
- Backups: the PostgreSQL backup (step 5) is taken with `pg-backup` and kept off Railway as well as wherever the owner chooses (D5). Dumps are not committed. Nothing is deleted after the cutover; retention is a later owner decision.

### 4. Rehearsal (after G4): local Postgres, no Railway write

1. Restore the rehearsal snapshot to a local file. Run `node scripts/pg-preflight.js <snapshot>`; exit ≠ 0 is a stop. Fix findings **at the source** (Q1) and take a new snapshot; never round or edit the copy.
2. `npm run db:up`; `DATABASE_URL=<local url> node scripts/pg-copy.js <snapshot>`; require "0 differences" from the built-in `pg-verify`.
3. `pg-backup`, restore into a new empty local database with `pg-restore`, `pg-verify` against the snapshot, start the app with `DB_DRIVER=pg` on the restored database, sign in and list assets.
4. Run the QA checklist (step 7) locally. Record timings (copy, backup, restore) to size the cutover window.

### 5. Target validation and data migration (after G5)

1. Freeze staging writes (step 2) and take the **final** snapshot; preflight it (clean or stop).
2. Validate the target: Postgres 18, empty, reachable through the approved tunnel (D1, below). The tools check the server's database, role and major version themselves. Whether the app's own pool needs SSL for the Railway URL has **not** been checked (the tools' tunnel connection uses no query parameters) and is verified at G5 before the driver switch.
3. Run the copy with the 7B tooling (see "Tunnel procedure"): first the DRY RUN, then, only with a fresh owner "go" at execution time, `--execute`. Require the copy's built-in verify to report 0 differences, `sessions` empty and every sequence past max(id).
4. Take `pg-backup` of the migrated Railway database, restore it into a **new, empty scratch database** (never over the live one), `pg-verify` the restored copy against the final snapshot and boot the app on it. This is the tested restore D-46 requires; if it fails, stop.

### 6. Deployment and environment controls (after G5)

The point is that no deployment happens that the owner has not approved, and that the one that does happens once.

- **Before changing anything,** document what triggers a staging deployment (a branch push, a variable change, a source change, a manual redeploy) from the inventory in step 1. Railway can redeploy on variable changes; stage them and apply them as one change.
- **Hold:** no push or merge to `stage` or `integration/postgresql` during the window. A push to the branch the staging service tracks deploys it (this happened with #37). If the service tracks `stage`, nothing lands on `stage`; if it is repointed, nothing lands on the new branch.
- **Branch strategy (decision D2, UNDECIDED):** the owner chooses at G1 or G5. Options, none preferred here: (a) temporarily repoint the **staging service's source branch** to `integration/postgresql` with no merge to `stage` (rollback: repoint to `stage`); (b) a second service on the integration branch (a Volume attaches to one service, so photos would need a copy); (c) another approach the owner names. This document does not choose; the steps above and below hold for any of them.
- **Variables:** add `DB_DRIVER=pg` and `DATABASE_URL` (as a reference variable); keep `DATA_DIR=/data`, `APP_URL`, mail guards and the health-check path. Record a before / after list of names with values redacted.
- **Order:** the data is migrated and verified first (step 5), then the branch and variables change as one approved deployment, then QA. Never switch the driver before the data is verified.
- **No other Railway changes:** the production environment, the bucket, domains and other services stay as they are.

### 7. Staging QA checklist (after the cutover deployment)

Record pass or fail with the time. Use only staging accounts; no real email leaves (mail guards on).

1. Boot and health: `/health` OK; logs show no migration, pool or SSL errors.
2. Auth: admin signs in; old sessions are gone (expected); invite and reset links work.
3. Data: asset, people, request, reservation, waitlist, outbox and activity counts equal the snapshot's; a few known assets, a person's history and the catalog tree read correctly.
4. Photos: an existing photo loads; upload, replace, remove and cover work; check on a phone.
5. Workflows: check-out and check-in; request create and approve; return request; reservation create, shorten, cancel; waitlist join and hold; the 60-second sweep runs once; overdue sweep.
6. Writes: the next asset tag, employee id and request id continue after the max (sequences).
7. Validation: a bad `license_seats` returns 400; a NUL in a body returns 400; CSV import and export.
8. Concurrency: a contended asset answers 503 `ASSET_BUSY`, not 500.
9. Mail: Outbox rows are written; nothing external is sent unless intended.
10. Restart: a redeploy and a restart keep all data.
11. The SQLite files and `/data/uploads` are unchanged (size, count, modification time of `assets.db`).

### 8. Rollback

- **Triggers:** any stop condition after step 6, or a no-go at G6.
- **Steps:** stop the staging service; revert the source branch and variables to the recorded pre-cutover values (the `stage` deployment on SQLite); redeploy; verify `/health` and a sign-in against SQLite. The original `/data/assets.db` and `/data/uploads` were never changed, so this is a clean revert.
- **Cost:** anything written to PostgreSQL after the cutover is **not carried back** to the SQLite service (no reverse copy is planned). Whether that loss is acceptable is the open owner decision D3, answered before G5. The PostgreSQL database and the dumps are left in place for diagnosis.
- **Rollback of a bad restore test:** drop the scratch database only; never the live one.

## Tunnel procedure (D1, tooling built in Slice 7B)

The Railway CLI's SSH tunnel makes the staging database answer on a **loopback** port of the owner's Mac. A host check alone would call it "local", so the tools do not rely on the host:

- **Default (no flag): local Docker only.** Loopback host AND the dev-only role `nc_dev`. A tunnelled URL (a different role) is refused with a message naming the flag.
- **`--staging-tunnel --confirm-target <host:port/database>`** (the exact target the tunnel exposes, read from the URL, never credentials). Refused before any connection when: the host is not loopback (a direct remote host is never allowed), the URL has query parameters, the role is `nc_dev`, the database is `nc_assets_dev` or `nc_test_*`, or the confirmation is missing or differs. After connecting it checks the server's `current_database()`, that the role is not the dev role and that the server is PostgreSQL 18.
- **Writes (`pg-copy`, `pg-restore`) are a dry run by default:** preflight, row counts, the target's state, the dump's readability; **nothing is written, not even the baseline migration.** Writing needs `--execute` AND an interactive terminal where the operator types `WRITE STAGING <host:port/database>`. A script, a pipe or an agent cannot supply it, which is the separate approval at execution time.
- **Reads (`pg-verify`, `pg-backup`)** need the flag and the confirmation, not `--execute`; `pg-backup` writes only a new local file.
- **Credentials** stay in `DATABASE_URL` in the operator's shell (not in files, not on a command line, not in chat). Output and errors show `host:port/database` only; the password is redacted from error text.

Order at execution (each step after its gate): start the tunnel (G2 read access, G5 for the write window) → `pg-copy <snapshot> --staging-tunnel --confirm-target …` (dry run, review) → `pg-copy … --execute` (type the phrase) → `pg-verify` → `pg-backup` → `pg-restore` into a **new empty** database to prove the restore → stop the tunnel. Nothing here changes Railway settings, deployments or the public network.

## Stop conditions

Stop, change nothing further and report if any of these happens. Resume only through the gate named.

- A preflight finding (back to the source fix, then a new snapshot).
- A `pg-verify` difference, a copy error, a failed or truncated backup, or a restore that does not verify or boot.
- A snapshot that is not WAL-consistent (by the local rehearsal proof) or whose checksum or integrity check fails; any step that would write to live SQLite.
- A copy of the Volume is needed that was not approved at G3, or any unexpected write to `/data`.
- Any tool is about to connect to a host the owner has not approved, or a credential would be printed or stored.
- The Postgres target is not empty, not version 18, or is not the one inventoried.
- An unexpected or unapproved deployment, or a deployment from a branch other than the approved one.
- Real email would be sent, or the mail guards are not confirmed.
- A boot error, an auth failure, photo 404s, or a QA item fails.
- The window runs out, or anything surprising appears.

## Go / no-go (G6)

**Go** only if all hold: zero preflight findings; 0 verify differences; the restore proven in rehearsal and again on the real database; every QA item passes; the SQLite files and photos are verifiably unchanged; the rollback path is confirmed to work (the last good deployment is still available); the owner approves. Any single failure is no-go and triggers the rollback.

## Decisions to resolve (open; none is decided here)

| # | Decision | Options / recommendation |
|---|---|---|
| **D1** | **PostgreSQL connection strategy.** **APPROVED 2026-10-27: the Railway CLI's SSH tunnel** (`railway connect --tunnel-only`) from the owner's Mac. No public TCP proxy, no Dockerfile change. Built in Slice 7B (see "Tunnel procedure"). | Still open inside it: the app's own connection (the private-network URL, and SSL if the app's pool needs it), and what the tunnel prints (port, credentials source), both known only when Railway is accessed after G2. |
| **D2** | Deployment branch strategy. **Undecided.** | Repoint the staging service's branch, a second service (photo copy needed), or another approach; no recommendation recorded. |
| **D3** | May data written to PostgreSQL after the cutover be lost on rollback? **Open owner decision.** | No recommendation recorded. The owner decides, and records the answer in writing before G5; no cutover without it. |
| **D4** | Who runs each step and with what Railway permissions | Needed at G2 and G3. |
| **D5** | Where the snapshot and dumps are kept, and for how long | Owner's choice of off-Railway location. |
| **D6** | The cutover window and whether staging users are told | Owner's choice. |
| **D7** | How the snapshot script runs against the Volume (the image has no `scripts/`) | A Railway shell with the script piped in, or a tooling change. Needs G2/G3. |
| **D8** | Fix `npm test` on Node 22.23 and the cancelled harness test before the cutover relies on them | **Done in Slice 7B** (built, awaiting review): 950 passed, 0 cancelled on Node 22.14 with local PostgreSQL. |

Outside Slice 7: SQLite and seam removal and seeds on PostgreSQL (own slice, after Slice 7, G7); production; object storage; authentication hardening.
