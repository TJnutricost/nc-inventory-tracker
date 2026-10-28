# Railway backups (staging launch readiness)

Owner decision 2026-10-28: keep all backup infrastructure inside Railway; no other provider.

## Findings (Railway docs and CLI, 2026-10-28)
- **Postgres volume backups** (daily 6 days, weekly 27 days, monthly 89 days; incremental, billed at volume rates) live with the volume: wiping the volume deletes them, restore only into the same project and environment. Managed from the dashboard or `railway postgres pitr schedule|backup`. **Point-in-time recovery** (pgBackRest to a Railway bucket) is available on our `postgres-ssl:18` image; not enabled (extra bucket + egress; launch needs daily granularity).
- **Buckets** (Tigris-backed, $0.015/GB-month, free egress and API calls): no backups, no versioning, no lifecycle rules; a deleted bucket is restorable for 52 hours. One read/write key per bucket.

## Built
- `scripts/backup-lib/*`, `scripts/backup-job.js` (cron entry), `scripts/backup-tool.js` (status, list, fetch, restore), `Dockerfile.backup` (Node + PostgreSQL 18 client, no native builds), `docs/BACKUP_RUNBOOK.md`.
- Reuses `scripts/pg-backup.js` (dump + read-back check) and `scripts/pg-restore.js` (local, empty database only). No change to either.
- Photos: backup key `photos/<name>@<etag>` (ETag = MD5): unchanged files are skipped by key, an overwritten file becomes a new key (old version kept), nothing is deleted, every copy is checksum-verified, the live bucket is passed to the job read-only.
- Retention: 14 days / 8 weeks / 6 months of dumps (pure function, newest always kept, only `db/nc-*.dump.enc` can be deleted)
- Encryption: dumps are encrypted with AES-256-GCM (`scripts/backup-lib/crypto.js`, key `BACKUP_ENCRYPTION_KEY`) before upload; the key needs an off-Railway recovery copy (runbook).
- Overlap: PostgreSQL advisory lock. Detection: exit codes 1 (failed) and 2 (a day was missed), status objects, `status` command.
- Credentials: Railway references only; backup and live bucket keys are separate and the app never receives the backup key; the job redacts every secret from logs and status.

## Not built / owner steps
Create the backup bucket and the `nc-backup` cron service in Railway (needs the code on a pushed branch), configure failure notifications, run the first real restore drill. See the runbook.
