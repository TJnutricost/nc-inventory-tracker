const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeTempDataDir } = require('../scripts/seed-verify');
const { DEV_DATA_DIR, REAL_DATA_DIR } = require('../scripts/seed-dev');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-verify.js');

test('seed:verify targets a temp directory outside ./data-dev and ./data', () => {
  const { base, dataDir } = makeTempDataDir();
  try {
    for (const protectedDir of [DEV_DATA_DIR, REAL_DATA_DIR]) {
      assert.ok(path.relative(protectedDir, dataDir).startsWith('..'), `${dataDir} must not be inside ${protectedDir}`);
    }
    assert.ok(dataDir.startsWith(fs.realpathSync(os.tmpdir())), 'expected a directory under the OS temp dir');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Runs the real script in a child process with its own TMPDIR so we can prove it cleans up after itself,
// and with DATA_DIR pointed at a decoy to prove the inherited environment can't redirect it.
test('seed:verify succeeds, leaves no temp files behind, and does not touch DATA_DIR from the environment', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nc-seed-verify-test-'));
  const decoy = path.join(tmp, 'decoy-data');
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'marker.txt'), 'untouched');
  fs.mkdirSync(scratch);
  try {
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, TMPDIR: scratch, DATA_DIR: decoy },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `seed:verify failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /seed:verify OK/);
    assert.deepEqual(fs.readdirSync(scratch), [], 'temporary seed directory was not cleaned up');
    assert.deepEqual(fs.readdirSync(decoy), ['marker.txt'], 'the inherited DATA_DIR must not be used');
    assert.equal(fs.readFileSync(path.join(decoy, 'marker.txt'), 'utf8'), 'untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seed:verify exits non-zero when it cannot complete', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nc-seed-verify-test-'));
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch);
  try {
    // An unwritable temp dir makes the very first step fail, which must surface as a failing exit code.
    fs.chmodSync(scratch, 0o500);
    const res = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TMPDIR: scratch }, encoding: 'utf8' });
    if (process.getuid && process.getuid() === 0) return; // root ignores directory permissions
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /seed:verify FAILED/);
  } finally {
    fs.chmodSync(scratch, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
