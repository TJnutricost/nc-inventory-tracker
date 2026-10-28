// Railway cron entry: node scripts/backup-job.js   (docs/BACKUP_RUNBOOK.md). Exit 0 ok / 1 failed / 2 ok but a run was missed before it.
const { runBackup } = require('./backup-lib/job');
const { redact } = require('./backup-lib/config');

runBackup()
  .then((r) => { process.exitCode = r.exitCode; })
  .catch((e) => { console.error(`backup: FAILED: ${redact(e.message)}`); process.exitCode = 1; });
