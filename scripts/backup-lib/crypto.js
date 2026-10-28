// Authenticated encryption of database dumps before they leave the job (AES-256-GCM, Node's built-in crypto; no extra dependency).
// File layout: "NCBK1" (5 bytes magic/version) | key id (4 bytes: first bytes of SHA-256 of the key, only to say "wrong key" clearly) |
// nonce (12 random bytes) | ciphertext | GCM tag (16 bytes). The 9-byte header is authenticated as additional data, so any change to the
// header, the ciphertext or the tag makes decryption fail instead of returning altered data. The key is BACKUP_ENCRYPTION_KEY: 32 random
// bytes, base64 or 64 hex characters (generate: `openssl rand -base64 32`). A fresh nonce per file keeps one key safe for years of daily dumps.
const crypto = require('crypto');

const MAGIC = Buffer.from('NCBK1');
const HEADER = MAGIC.length + 4;
const NONCE = 12;
const TAG = 16;

function parseKey(text) {
  const t = String(text || '').trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) key = Buffer.from(t, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) key = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 random bytes as base64 or 64 hex characters (openssl rand -base64 32)');
  return key;
}
const keyId = (key) => crypto.createHash('sha256').update(key).digest().subarray(0, 4);

function encrypt(plain, key) {
  const nonce = crypto.randomBytes(NONCE);
  const header = Buffer.concat([MAGIC, keyId(key)]);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(header);
  return Buffer.concat([header, nonce, c.update(plain), c.final(), c.getAuthTag()]);
}

function decrypt(blob, key) {
  if (blob.length < HEADER + NONCE + TAG || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted backup file (missing NCBK1 header)');
  const header = blob.subarray(0, HEADER);
  if (!header.subarray(MAGIC.length).equals(keyId(key))) throw new Error('this backup was encrypted with a different key than BACKUP_ENCRYPTION_KEY');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(HEADER, HEADER + NONCE));
  d.setAAD(header);
  d.setAuthTag(blob.subarray(blob.length - TAG));
  try { return Buffer.concat([d.update(blob.subarray(HEADER + NONCE, blob.length - TAG)), d.final()]); } catch { throw new Error('decryption failed: the file is corrupt or has been altered'); }
}

module.exports = { parseKey, encrypt, decrypt };
