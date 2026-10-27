// PostgreSQL Slice 7B: the safeguards that decide which database the migration tools may touch (src/pg/target.js and the
// mains of scripts/pg-copy.js, pg-verify.js, pg-backup.js, pg-restore.js). LOCAL PostgreSQL only: the "Railway staging" is
// a throwaway database and role on the local Docker server (nc_stage_sim_*), reached over loopback exactly as an SSH
// tunnel would appear. No Railway connection exists in this file.
//   - the pure rules (labels, redaction, flags, what is refused BEFORE any connection)
//   - a staging dry run writes nothing; --execute needs an interactive terminal and the exact phrase
//   - the local mode refuses a URL whose role is not the dev role (a tunnel looks like localhost)
//   - no password reaches the output
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { Client } = require('pg');
const { pgSuite, serverUrl } = require('../../test-support/pg-harness');
const { createFixture } = require('../../test-support/slice6-fixture');
const { DEV_DATABASE_URL } = require('../../src/pg/local-url');
const {
  parseToolArgs, resolveTarget, confirmWrite, confirmationPhrase, targetLabel, redact,
} = require('../../src/pg/target');
const { createPool } = require('../../src/pg/pool');
const copyTool = require('../../scripts/pg-copy');
const verifyTool = require('../../scripts/pg-verify');
const backupTool = require('../../scripts/pg-backup');
const restoreTool = require('../../scripts/pg-restore');

const STAGING = 'postgresql://stage_user:s3cret-pw@127.0.0.1:15432/railway';

describe('target rules (no database)', () => {
  test('parseToolArgs: flags, both --confirm-target forms, unknown options refused', () => {
    assert.deepEqual(parseToolArgs(['a.db']), { positional: ['a.db'], stagingTunnel: false, execute: false, confirmTarget: null });
    assert.deepEqual(parseToolArgs(['a.db', '--staging-tunnel', '--execute', '--confirm-target', 'h:1/d']),
      { positional: ['a.db'], stagingTunnel: true, execute: true, confirmTarget: 'h:1/d' });
    assert.equal(parseToolArgs(['--confirm-target=h:1/d']).confirmTarget, 'h:1/d');
    assert.throws(() => parseToolArgs(['--confirm-target']), /needs a value/);
    assert.throws(() => parseToolArgs(['--stagin-tunnel']), /unknown option/);
  });

  test('targetLabel has host:port/database and never credentials', () => {
    assert.equal(targetLabel(STAGING), '127.0.0.1:15432/railway');
    assert.equal(targetLabel('postgresql://u:p@LOCALHOST/db'), 'localhost:5432/db');
    assert.equal(targetLabel('postgresql://u:p@[::1]:7/db'), '[::1]:7/db');
    assert.equal(targetLabel('not a url'), null);
    assert.ok(!targetLabel(STAGING).includes('s3cret'));
  });

  test('redact removes the URL, the password and its encoded form from text', () => {
    const url = 'postgresql://u:p%40ss!word@127.0.0.1:1/d';
    const text = `connect failed ${url} and p@ss!word and p%40ss!word`;
    const out = redact(text, url);
    assert.ok(!/p%40ss|p@ss|postgresql:\/\//.test(out), out);
    assert.equal(redact('nothing secret', url), 'nothing secret');
  });

  test('local mode: the dev role on loopback only; any other role (a tunnel) is refused', () => {
    const ok = resolveTarget(DEV_DATABASE_URL, {}, { write: true });
    assert.deepEqual([ok.mode, ok.dryRun], ['local', false]);
    assert.throws(() => resolveTarget(STAGING, {}, { write: true, who: 'pg-copy' }), /dev-only role nc_dev.*--staging-tunnel --confirm-target 127\.0\.0\.1:15432\/railway/);
    assert.throws(() => resolveTarget('postgresql://nc_dev:x@db.example.com/d', {}), /loopback/);
    assert.throws(() => resolveTarget('postgresql://nc_dev:x@localhost/d?host=db.example.com', {}), /loopback|query/);
    assert.throws(() => resolveTarget(undefined, {}), /missing or not a valid/);
    assert.throws(() => resolveTarget(DEV_DATABASE_URL, { execute: true }), /only apply with --staging-tunnel/);
    assert.throws(() => resolveTarget(DEV_DATABASE_URL, { confirmTarget: 'x' }), /only apply with --staging-tunnel/);
  });

  test('staging tunnel: needs the exact confirmed target; a write is a dry run unless --execute', () => {
    const label = '127.0.0.1:15432/railway';
    assert.throws(() => resolveTarget(STAGING, { stagingTunnel: true }, { write: true }), /needs --confirm-target 127\.0\.0\.1:15432\/railway/);
    assert.throws(() => resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: '127.0.0.1:15432/other' }, { write: true }), /does not match/);
    assert.throws(() => resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: 'localhost:15432/railway' }, { write: true }), /does not match/);
    const dry = resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: label }, { write: true });
    assert.deepEqual([dry.mode, dry.dryRun, dry.label], ['staging', true, label]);
    const live = resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: label, execute: true }, { write: true });
    assert.equal(live.dryRun, false);
    const read = resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: label }, { write: false });
    assert.equal(read.dryRun, false, 'a read-only tool has no dry-run mode');
  });

  test('staging tunnel never allows a direct remote host, query parameters, or the local dev/test targets', () => {
    const opts = (label) => ({ stagingTunnel: true, confirmTarget: label });
    assert.throws(() => resolveTarget('postgresql://u:p@db.example.com:5432/railway', opts('db.example.com:5432/railway')), /loopback/);
    assert.throws(() => resolveTarget('postgresql://u:p@10.0.0.5:5432/railway', opts('10.0.0.5:5432/railway')), /loopback/);
    assert.throws(() => resolveTarget('postgresql://u:p@127.0.0.1:1/railway?sslmode=require', opts('127.0.0.1:1/railway')), /loopback|query/);
    assert.throws(() => resolveTarget('postgresql://u:p@127.0.0.1:1/railway?host=db.example.com', opts('127.0.0.1:1/railway')), /loopback|query/);
    assert.throws(() => resolveTarget('postgresql://nc_dev:nc_dev@127.0.0.1:5433/railway', opts('127.0.0.1:5433/railway')), /dev\/test database/);
    assert.throws(() => resolveTarget('postgresql://u:p@127.0.0.1:5433/nc_assets_dev', opts('127.0.0.1:5433/nc_assets_dev')), /dev\/test database/);
    assert.throws(() => resolveTarget('postgresql://u:p@127.0.0.1:5433/nc_test_0123456789abcdef', opts('127.0.0.1:5433/nc_test_0123456789abcdef')), /dev\/test database/);
  });

  test('confirmWrite: no TTY refuses; a wrong phrase refuses; the exact phrase passes; the summary names the target', async () => {
    const target = resolveTarget(STAGING, { stagingTunnel: true, confirmTarget: '127.0.0.1:15432/railway', execute: true }, { write: true });
    const tty = (line) => {
      const input = new PassThrough();
      input.isTTY = true;
      if (line !== null) input.end(`${line}\n`);
      return { input, output: new PassThrough() };
    };
    await assert.rejects(() => confirmWrite(target, 'x', { input: new PassThrough(), output: new PassThrough() }), /interactive terminal/);
    await assert.rejects(() => confirmWrite(target, 'x', tty('yes')), /did not match/);
    await assert.rejects(() => confirmWrite(target, 'x', tty('write staging 127.0.0.1:15432/railway')), /did not match/);
    const closed = tty(null);
    closed.input.end();
    await assert.rejects(() => confirmWrite(target, 'x', closed), /did not match/);
    const good = tty(confirmationPhrase(target));
    let shown = '';
    good.output.on('data', (d) => { shown += d; });
    await confirmWrite(target, 'About to WRITE rows', good);
    assert.match(shown, /127\.0\.0\.1:15432\/railway/);
    assert.ok(!shown.includes('s3cret'));
  });
});

// Runs `fn` with console.log / console.error captured; returns { code, out } (out = both, in order).
async function capture(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { code: await fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const ttyWith = (line) => {
  const input = new PassThrough();
  input.isTTY = true;
  input.end(`${line}\n`);
  return { input, output: new PassThrough() };
};

describe('tools against a local stand-in for the tunnelled staging database', pgSuite(), () => {
  const hex = crypto.randomBytes(6).toString('hex');
  const role = `nc_stage_sim_${hex}`;
  const password = `pw-${crypto.randomBytes(8).toString('hex')}`;
  const dbNames = [`nc_stage_sim_a_${hex}`, `nc_stage_sim_b_${hex}`];
  let fixture;
  let sqliteFile;
  let tmp;
  const port = new URL(DEV_DATABASE_URL).port;
  const server = () => new Client({ connectionString: serverUrl(), connectionTimeoutMillis: 5000 });
  const urlOf = (db) => `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
  const flags = (db, ...more) => ['--staging-tunnel', '--confirm-target', targetLabel(urlOf(db)), ...more];
  const envOf = (db) => ({ ...process.env, DATABASE_URL: urlOf(db) });

  async function tableCount(db) {
    const pool = createPool(urlOf(db));
    try {
      return (await pool.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;
    } finally {
      await pool.end();
    }
  }

  before(async () => {
    fixture = createFixture();
    sqliteFile = fixture.source().name;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-stage-sim-'));
    const c = server();
    await c.connect();
    try {
      await c.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      for (const db of dbNames) await c.query(`CREATE DATABASE "${db}" OWNER "${role}"`);
    } finally {
      await c.end();
    }
  });

  after(async () => {
    const c = server();
    await c.connect();
    try {
      for (const db of dbNames) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await c.end();
    }
    fixture?.cleanup();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('without the flag the tunnel-looking URL is refused before any connection (copy, verify, backup, restore)', async () => {
    const [a] = dbNames;
    for (const run of [
      () => copyTool.main([sqliteFile], envOf(a)),
      () => verifyTool.main([sqliteFile], envOf(a)),
      () => backupTool.main([path.join(tmp, 'x.dump')], envOf(a)),
      () => restoreTool.main([path.join(tmp, 'x.dump')], envOf(a)),
    ]) {
      const { code, out } = await capture(run);
      // restore checks its input file first; the others refuse the target. Either way: nothing connected, no secret.
      assert.equal(code, 1, out);
      assert.ok(!out.includes(password), out);
    }
    assert.match((await capture(() => copyTool.main([sqliteFile], envOf(a)))).out, /dev-only role nc_dev/);
    assert.equal(await tableCount(a), 0);
  });

  test('staging flag without the right confirmation, and --execute without the flag: refused, nothing written', async () => {
    const [a] = dbNames;
    let r = await capture(() => copyTool.main([sqliteFile, '--staging-tunnel'], envOf(a)));
    assert.equal(r.code, 1);
    assert.match(r.out, /needs --confirm-target/);
    r = await capture(() => copyTool.main([sqliteFile, '--staging-tunnel', '--confirm-target', `127.0.0.1:${port}/${dbNames[1]}`], envOf(a)));
    assert.equal(r.code, 1);
    assert.match(r.out, /does not match/);
    r = await capture(() => copyTool.main([sqliteFile, '--execute'], envOf(a)));
    assert.equal(r.code, 1);
    assert.match(r.out, /only apply with --staging-tunnel/);
    r = await capture(() => copyTool.main([sqliteFile, '--nope'], envOf(a)));
    assert.equal(r.code, 2);
    assert.equal(await tableCount(a), 0);
    assert.ok(!r.out.includes(password));
  });

  test('dry run on an empty target reports the plan and writes NOTHING (not even the baseline)', async () => {
    const [a] = dbNames;
    const { code, out } = await capture(() => copyTool.main([sqliteFile, ...flags(a)], envOf(a)));
    assert.equal(code, 0, out);
    assert.match(out, /DRY RUN against 127\.0\.0\.1:\d+\/nc_stage_sim_a_/);
    assert.match(out, /Preflight: clean/);
    assert.match(out, /baseline migration would be applied first/);
    assert.match(out, /Rows that would be copied/);
    assert.ok(!out.includes(password));
    assert.equal(await tableCount(a), 0);
  });

  test('--execute without an interactive terminal, or with a wrong phrase: refused, nothing written', async () => {
    const [a] = dbNames;
    let r = await capture(() => copyTool.main([sqliteFile, ...flags(a, '--execute')], envOf(a), { input: new PassThrough(), output: new PassThrough() }));
    assert.equal(r.code, 1);
    assert.match(r.out, /interactive terminal/);
    r = await capture(() => copyTool.main([sqliteFile, ...flags(a, '--execute')], envOf(a), ttyWith('go ahead')));
    assert.equal(r.code, 1);
    assert.match(r.out, /did not match/);
    assert.equal(await tableCount(a), 0);
  });

  test('--execute with the exact phrase copies and verifies; the password never appears', async () => {
    const [a] = dbNames;
    const phrase = `WRITE STAGING ${targetLabel(urlOf(a))}`;
    const { code, out } = await capture(() => copyTool.main([sqliteFile, ...flags(a, '--execute')], envOf(a), ttyWith(phrase)));
    assert.equal(code, 0, out);
    assert.match(out, /Verify OK/);
    assert.ok(!out.includes(password));
    assert.ok(await tableCount(a) > 10);
  });

  test('after the copy: a dry run refuses a non-fresh target (exit 1); verify reads it; a second --execute never asks', async () => {
    const [a] = dbNames;
    let r = await capture(() => copyTool.main([sqliteFile, ...flags(a)], envOf(a)));
    assert.equal(r.code, 1);
    assert.match(r.out, /NOT fresh/);
    r = await capture(() => copyTool.main([sqliteFile, ...flags(a, '--execute')], envOf(a), ttyWith('irrelevant')));
    assert.equal(r.code, 1, 'refused on the read-only look, before the operator is asked');
    assert.match(r.out, /NOT fresh/);
    r = await capture(() => verifyTool.main([sqliteFile, ...flags(a)], envOf(a)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /read-only/);
    assert.match(r.out, /Verify OK/);
    assert.ok(!r.out.includes(password));
  });

  test('the server-side identity check refuses a database other than the confirmed one', async () => {
    const { assertStagingServer } = require('../../src/pg/target');
    const pool = createPool(urlOf(dbNames[1]));
    try {
      const target = { label: `127.0.0.1:${port}/${dbNames[0]}` };
      await assert.rejects(() => assertStagingServer(pool, target), /not the confirmed/);
      const ok = await assertStagingServer(pool, { label: `127.0.0.1:${port}/${dbNames[1]}` });
      assert.equal(ok.role, role);
      assert.equal(ok.major, 18);
    } finally {
      await pool.end();
    }
  });

  test('backup of the staging stand-in (read-only) and a restore dry run / refused execute into the empty second database', async () => {
    const [a, b] = dbNames;
    const dump = path.join(tmp, 'staging.dump');
    let r = await capture(() => backupTool.main([dump, ...flags(a)], envOf(a)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Backup OK/);
    assert.ok(!r.out.includes(password));
    assert.ok(fs.existsSync(dump));

    r = await capture(() => restoreTool.main([dump, ...flags(b)], envOf(b)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DRY RUN/);
    assert.equal(await tableCount(b), 0, 'the dry run restored nothing');

    r = await capture(() => restoreTool.main([dump, ...flags(b, '--execute')], envOf(b), { input: new PassThrough(), output: new PassThrough() }));
    assert.equal(r.code, 1);
    assert.match(r.out, /interactive terminal/);
    assert.equal(await tableCount(b), 0);

    r = await capture(() => restoreTool.main([dump, ...flags(a)], envOf(a)));
    assert.equal(r.code, 1);
    assert.match(r.out, /not empty/);
  });

  test('--execute restore with the exact phrase restores into the empty database, and it verifies against SQLite', async () => {
    const [, b] = dbNames;
    const dump = path.join(tmp, 'staging.dump');
    const phrase = `WRITE STAGING ${targetLabel(urlOf(b))}`;
    let r = await capture(() => restoreTool.main([dump, ...flags(b, '--execute')], envOf(b), ttyWith(phrase)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Restore OK/);
    assert.ok(!r.out.includes(password));
    r = await capture(() => verifyTool.main([sqliteFile, ...flags(b)], envOf(b)));
    assert.equal(r.code, 0, r.out);
  });
});
