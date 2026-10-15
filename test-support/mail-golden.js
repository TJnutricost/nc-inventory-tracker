// Slice 5A mailer golden master: runs test-support/mail-golden-probe.js for every scenario in fresh processes and compacts the
// output (each distinct email body is stored once, keyed by its SHA-256, so the fixture stays small and the comparison stays
// byte-exact). Used by test/mail-golden.test.js (SQLite) and test/pg/pg-mailer.test.js (PostgreSQL). Only for tests.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE = path.join(__dirname, 'mail-golden-probe.js');
const SCENARIOS = ['logged', 'sent', 'allow_it_from', 'redirect', 'redirect_invalid', 'transport_fails', 'blocked'];
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'mail-golden.json');

// One scenario on one engine ('sqlite' with a throwaway data dir, or 'pg' with a local test database URL), in a clean child
// environment (no SMTP / MAIL_* variables from the parent: the probe sets the scenario's own).
function runProbe(scenario, engine, target) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mail-golden-'));
  try {
    const r = spawnSync(process.execPath, [PROBE, scenario, engine, engine === 'sqlite' ? path.join(scratch, 'data') : target], {
      cwd: scratch, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 26, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (r.status !== 0) throw new Error(`mail-golden-probe ${scenario} ${engine} failed: ${r.stderr || r.error}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Replaces every body / html string by `sha256:<hex>` and collects the texts in `bodies`.
function compact(out, bodies) {
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if ((key === 'body' || key === 'html') && typeof v === 'string') { const h = sha(v); bodies[h] = v; return `sha256:${h}`; }
    return v;
  };
  return walk(out);
}
function captureAll(engine, target) {
  const bodies = {}; const scenarios = {};
  for (const s of SCENARIOS) scenarios[s] = compact(runProbe(s, engine, typeof target === 'function' ? target(s) : target), bodies);
  return { scenarios, bodies };
}

module.exports = { SCENARIOS, FIXTURE, runProbe, compact, captureAll };
