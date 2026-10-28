// Backup configuration from the environment (Railway variables). Nothing here is ever printed: errors and logs go through redact().
//   DATABASE_URL                     the database to dump (Railway: the private URL, ${{Postgres.DATABASE_URL}})
//   BACKUP_S3_BUCKET / _ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _REGION / _FORCE_PATH_STYLE
//                                    the SECOND (backup) bucket, referenced from that bucket's own variables
//   BACKUP_ENCRYPTION_KEY            32 random bytes (base64 or hex): every dump is encrypted with it (AES-256-GCM) before upload; required
//   S3_BUCKET / S3_ENDPOINT / ...    the LIVE photo bucket, the same variables the app uses (optional: without S3_BUCKET photos are skipped)
const STALE_HOURS = 36;

const flag = (v) => v === '1' || v === 'true';
function storeCfg(env, p, label) {
  const need = ['BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].filter((k) => !env[`${p}${k}`]);
  if (need.length) throw new Error(`${label}: ${need.map((k) => p + k).join(', ')} ${need.length > 1 ? 'are' : 'is'} not set`);
  return { bucket: env[`${p}BUCKET`], endpoint: env[`${p}ENDPOINT`], accessKeyId: env[`${p}ACCESS_KEY_ID`], secretAccessKey: env[`${p}SECRET_ACCESS_KEY`], region: env[`${p}REGION`] || 'auto', forcePathStyle: flag(env[`${p}FORCE_PATH_STYLE`]) };
}

function parseConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const backup = storeCfg(env, 'BACKUP_S3_', 'backup bucket');
  const source = env.S3_BUCKET ? storeCfg(env, 'S3_', 'live photo bucket') : null;
  // the backup must never be the bucket it protects (same name on the same endpoint, or the same credentials)
  if (source && ((source.bucket === backup.bucket && source.endpoint === backup.endpoint) || source.accessKeyId === backup.accessKeyId)) {
    throw new Error('the backup bucket must be a different bucket, with different credentials, from the live photo bucket');
  }
  const { parseKey } = require('./crypto');
  if (!env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY is not set (dumps are never uploaded unencrypted)');
  return { databaseUrl: env.DATABASE_URL, backup, source, encryptionKey: parseKey(env.BACKUP_ENCRYPTION_KEY) };
}

// Removes every secret value (and the password inside a URL) from a message before it is logged.
function redact(text, env = process.env) {
  let out = String(text);
  const secrets = [];
  for (const k of ['DATABASE_URL', 'BACKUP_ENCRYPTION_KEY', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY_ID', 'PGPASSWORD']) if (env[k]) secrets.push(env[k]);
  try { const u = new URL(env.DATABASE_URL); if (u.password) secrets.push(decodeURIComponent(u.password), u.password); } catch { /* not a URL */ }
  for (const s of secrets.filter((x) => x && x.length >= 4)) out = out.split(s).join('[redacted]');
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[redacted]@');
}

module.exports = { STALE_HOURS, parseConfig, redact };
