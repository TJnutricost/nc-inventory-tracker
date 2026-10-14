// PostgreSQL preparation (D-46): local tooling only. These tests never need Docker or a database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isLocalDatabaseUrl, DEFAULT_URL } = require('../scripts/db-check');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.postgres.yml'), 'utf8');
const composeCode = compose.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('db-check accepts only localhost, 127.0.0.1 and ::1', () => {
  assert.equal(isLocalDatabaseUrl(DEFAULT_URL), true);
  assert.equal(isLocalDatabaseUrl('postgresql://u:p@localhost:5433/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://u:p@127.0.0.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgres://u:p@[::1]:5433/db'), true);
});

test('db-check rejects remote hosts, including Railway-style ones', () => {
  for (const url of [
    'postgresql://u:p@db.example.com:5432/db',
    'postgresql://u:p@roundhouse.proxy.rlwy.net:12345/railway',
    'postgresql://u:p@postgres.railway.internal:5432/railway',
    'postgresql://u:p@localhost.evil.com:5432/db',
    'postgresql://u:p@127.0.0.1.evil.com:5432/db',
    'postgresql://localhost:p@remote.example.com:5432/db',
    '10.0.0.5',
    'postgresql://u:p@localhost/db?host=remote.example.com',
    'postgresql://u:p@localhost/db?HOST=remote.example.com',
    'postgresql://u:p@127.0.0.1/db?hostaddr=10.0.0.5',
    'postgresql://u:p@localhost/db?port=5432',
    'postgresql://u:p@localhost/db?service=prod',
    'postgresql://u:p@localhost/db?host=/var/run/postgresql',
    'postgresql://u:p@localhost/db?sslmode=disable',
    'postgresql:///db',
    'postgresql://u:p@/db',
    'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/db',
    'postgresql://u:p@%2fvar%2frun%2fpostgresql:5433/db',
    '/var/run/postgresql mydb',
    'socket://localhost/var/run/postgresql',
    'http://localhost:5433/db',
    'not a url',
    '',
  ]) {
    assert.equal(isLocalDatabaseUrl(url), false, url);
  }
});

test('the compose file publishes PostgreSQL on 127.0.0.1 only', () => {
  const ports = [...composeCode.matchAll(/^\s*-\s*"?([^"\n]*:\d+:\d+)"?\s*$/gm)].map((m) => m[1]);
  assert.ok(ports.length >= 1, 'expected a published port');
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:5433:5432$/, `port ${p} must bind to 127.0.0.1`);
  assert.doesNotMatch(composeCode, /0\.0\.0\.0/);
  assert.match(composeCode, /timezone=UTC/);
  assert.match(composeCode, /TZ:\s*UTC/);
  assert.match(composeCode, /healthcheck:/);
});

test('the compose file stays separate from the app: no assets service, no data volume', () => {
  assert.doesNotMatch(composeCode, /^\s*assets:/m);
  assert.doesNotMatch(composeCode, /\.\/data/);
  assert.doesNotMatch(composeCode, /:\/data\b/);
  assert.doesNotMatch(composeCode, /^\s*build:/m);
});
