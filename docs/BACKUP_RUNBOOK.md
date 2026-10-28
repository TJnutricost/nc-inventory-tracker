# Backup and recovery runbook (Railway only)

Decision (owner, 2026-10-28): all backup infrastructure stays inside Railway for now. Applies to **Staging**; production gets the same setup when its environment is created. Detail of what was built and why: [docs/briefs/railway-backups.md](briefs/railway-backups.md).

## What is protected, and how

| Data | Where it lives | Backup layer 1 (fast restore) | Backup layer 2 (independent copy) |
|---|---|---|---|
| PostgreSQL (people, assets, assignments, history, settings, sessions) | `Postgres` service, `postgres-volume` | Railway **daily volume backup**, kept 6 days (enabled 2026-10-28) | **Daily `pg_dump`** (custom format, verified readable), **encrypted (AES-256-GCM)** before upload, in the backup bucket: newest of each of the last 14 days, 8 weeks, 6 months |
| Photos | `nc-inventory-uploads-staging` bucket | none (Railway buckets have no backups or versioning) | Daily copy of new/changed photos into the **backup bucket**: never deleted, overwritten photos keep every version |

Layer 2 is one Railway cron service, **`nc-backup`** (image: `Dockerfile.backup`, command `node scripts/backup-job.js`, schedule `30 7 * * *` UTC), writing to a second private bucket, **`nc-inventory-backups-staging`**. The live photo bucket is never changed by it (it only lists and reads).

Backup bucket layout: `db/nc-<UTC timestamp>.dump.enc`, `photos/<file name>@<etag>` (one object per version), `status/last-run.json`, `status/last-success.json`.

## Setting up the cron service (once per environment)

1. Create the backup bucket in the environment (any name; private by default; same region as the app if possible).
2. Create a service from this repo (branch `stage`), **Settings → Build → Dockerfile path `Dockerfile.backup`**, **Cron schedule `30 7 * * *`**, start command `node scripts/backup-job.js`, restart policy **never**.
3. Variables (use Railway references, never paste secrets):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (private network URL)
   - `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION` = `${{<backup bucket>.BUCKET}}`, `.ENDPOINT`, `.ACCESS_KEY_ID`, `.SECRET_ACCESS_KEY`, `.REGION` (add `BACKUP_S3_FORCE_PATH_STYLE=1` only if the bucket's Credentials tab says path-style)
   - `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` = references to the **live** photo bucket (same names the app uses). Leave `S3_BUCKET` unset to skip photos.
   - `BACKUP_ENCRYPTION_KEY` = the dump encryption key (see *Encryption key* below). The job refuses to run without it; dumps are never uploaded unencrypted. **Only the `nc-backup` service gets it.**
   - **The app service must NOT get any `BACKUP_S3_*` variable**: the application can then never read or delete a backup.
4. Deploy once and run it (Deployments → Redeploy, or wait for the schedule). Check the logs (see Monitoring) and `status`.
5. Failure visibility (Railway-native, no external service): Project **Settings → Notifications** → enable *Deployment crashed/failed* (email to project members; Slack/Discord/webhook optional). A failed run (exit 1) or a run that follows a missed day (exit 2) is a failed deployment of `nc-backup`, so it raises that notification. Also glance at the service's Deployments list: one green deployment per day.

## Encryption key

Every dump is encrypted before it leaves the job: AES-256-GCM (authenticated: a wrong key, a corrupt file or a tampered file fails to decrypt instead of producing data), a fresh random nonce per file. The photos are copied as they are (they already sit in a private Railway bucket and hold no personal data beyond equipment pictures).

- **Generate once:** `openssl rand -base64 32`. Put it in Railway as `BACKUP_ENCRYPTION_KEY` on `nc-backup` only (Variables → New Variable, or a sealed variable). Never in the repo, the app service, chat or a ticket.
- **Keep a recovery copy OUTSIDE Railway. This is mandatory:** without the key every dump is unreadable, and if the key lives only in the Railway project it is lost together with the project. Store it in the company password manager (e.g. a shared vault entry named "Nutricost IT Scanner backup encryption key" readable by two IT admins) and, optionally, printed in the office safe. Check once after setup that the stored value decrypts a real dump (drill below).
- **Rotation:** set a new `BACKUP_ENCRYPTION_KEY`; new dumps use it, old dumps still need the old key. Keep every retired key in the password manager until the last dump made with it has been pruned (about 6 months). Each file records a 4-byte key fingerprint, so the tool tells you "different key" rather than failing mysteriously.
- **Compromise of the key** alone exposes nothing (the dumps are in a private bucket); a compromise of both the key and the backup bucket exposes the employee data of every retained dump. Rotate, and treat it as a data incident.

## Monitoring

- Railway → `nc-backup` → Deployments: each daily run is one deployment; **Failed** means the backup did not complete.
- Exit codes: `0` ok, `1` failed (the log and `status/last-run.json` say why), `2` this run worked but a previous run was missed (the last success was older than 36 hours).
- Overlap: a run holds a PostgreSQL advisory lock for its whole duration; a second run that cannot get it exits `0` without doing anything. Railway also does not start a cron run while the previous one is still running.
- `status` (from any machine with the `BACKUP_S3_*` values): `npm run backup:tool -- status` prints the last run and last success and exits `1` if there is no success, the last run failed, or the last success is older than 36 hours.
- Logs never contain credentials or connection strings (everything is redacted before it is written).

## Recovery: database

Never restore over live data. Restore into a **new, empty** database, check it, then decide what to do with it.

**A. From the independent dump (works even if the Railway volume is gone)**
1. `npm run backup:tool -- list` to see the dumps. Download and decrypt the newest (or one with `--key db/nc-….dump.enc`): `BACKUP_ENCRYPTION_KEY=<key from the password manager> npm run backup:tool -- restore-db /tmp/restore.dump` (also needs the `BACKUP_S3_*` values). Offline from a downloaded file: `BACKUP_ENCRYPTION_KEY=… node scripts/backup-tool.js decrypt db-file.dump.enc /tmp/restore.dump` (needs no bucket access). The decrypted file is written owner-only; delete it after the restore.
2. Isolated test restore on your machine (local Docker PostgreSQL 18, `npm run db:up`, then create an empty database): `DATABASE_URL=postgresql://…@127.0.0.1:5433/<empty db> node scripts/pg-restore.js /tmp/restore.dump` (the script refuses a non-local or non-empty database). Or in one step: add `--restore` to `restore-db` with `DATABASE_URL` set to that empty local database.
3. Check it: `psql` the row counts, or boot the app on it (`DB_DRIVER=pg DATABASE_URL=<that db> node src/server.js`) and sign in.
4. Real recovery into Railway (only after the owner approves): create a **new** Postgres service in the project, then `pg_restore --no-owner --no-privileges --dbname "<new service URL>" /tmp/restore.dump` with PostgreSQL 18 client tools (the script above is deliberately local-only; this is the one manual step), point the app's `DATABASE_URL` at the new service, redeploy, verify `/health`, then retire the old service later.

**B. From a Railway volume backup (fastest, same project/environment only)**
Postgres service → **Backups** tab → pick the date → **Restore**. Railway stages a change that mounts a NEW volume (named by the backup date) and keeps the old one unmounted. Review it under *Details*; **Deploy** only if you want to switch. Nothing is overwritten until you deploy. CLI equivalents: `railway postgres pitr backup list|create|restore --service Postgres -e Staging`.

## Recovery: photos

1. List: `npm run backup:tool -- list` (counts versions). One specific version: `npm run backup:tool -- fetch "photos/<name>@<etag>" /tmp/<name>`.
2. Restore the newest version of every photo (including ones deleted from the live bucket) into an **empty** directory: `npm run backup:tool -- restore-photos /tmp/photos-restored` (refuses a non-empty directory; every file is checked against its checksum).
3. To put them into a bucket, restore into a NEW bucket (never the live or the backup one; the code refuses those): create `nc-inventory-uploads-restore` and upload the directory under the `photos/` prefix with any S3 client, then point the app's `S3_*` at it. Photo rows in the database reference file names only, so nothing else changes.

## Restore drill (monthly, and before go-live)

Run A.1–A.3 and photo steps 1–2 against the newest backup into a local empty database/directory; confirm people/asset counts and that a few photos open. Record the date in PROJECT_STATUS.md. Last drill: automated test run on 2026-10-28 (`test/pg/pg-backup-job.test.js`: restores the dump into a new database and compares it, restores photos into an empty directory); first real-bucket drill is due after the cron service's first successful run.

## Retention

Database dumps: newest of each of the last 14 days, 8 ISO weeks and 6 months (about 28 objects), pruned by the job after each successful upload; the newest dump is never pruned and only `db/nc-*.dump.enc` keys (and old plain `.dump` ones) are ever deleted. Photos: kept indefinitely (the job never deletes). Railway volume backups: 6 days (daily schedule).

## Limitations of Railway-only backups

- Everything is in **one Railway project/account**: an account compromise, a billing suspension or deleting the project removes the database, the live bucket **and** the backups together. The cheapest next step when it matters is a periodic manual download of the newest dump and photo archive to company storage (`backup:tool restore-db` / `restore-photos`).
- Railway volume backups are lost if the volume is wiped, restore only into the same project and environment, and are kept 6 days.
- A Railway bucket's key is read/write (no read-only keys): the job's code only reads the live bucket, but anyone with access to the project's variables can use either key. Restrict project access.
- No bucket versioning or lifecycle: versions are kept by the job's own key scheme; a person with the backup key can delete backups.
- The job runs `pg_dump` with the database's main credentials (no separate read-only role yet).
- Dumps are encrypted with a key that lives in Railway **and** must have a copy in the company password manager; losing both makes the dumps unreadable. Photos are not separately encrypted (Railway encrypts buckets at rest).
- The dump is read into memory before upload: fine for tens of MB; revisit (streaming/multipart) if a dump grows past several hundred MB.
- Failure alerts rely on Railway's own deployment notifications; there is no independent dead-man's switch, so a deleted cron service or disabled notifications is not noticed until someone runs `status`.
- A run that is skipped because the lock is busy exits 0, so a lock that is stuck would be noticed only by the 36-hour staleness check.
