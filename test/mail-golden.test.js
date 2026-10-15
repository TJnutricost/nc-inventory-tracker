// Slice 5A golden master (D-35 to D-39, D-48 point 5): src/mailer.js, now a thin SQLite adapter over src/mailCore.js, must
// produce byte-for-byte what the pre-refactor mailer produced (test/fixtures/mail-golden.json, captured from it at 7d5f0f4):
// for every notify.* template under every environment scenario (no transport, a fake transport, MAIL_ALLOW_IT_FROM, the
// MAIL_TEST_RECIPIENT redirect, an invalid redirect failing closed, a throwing transport, NC_NO_EXTERNAL_MAIL with SMTP
// credentials): recipients, subjects, bodies, outbox rows (status, error, delivered_to), what the transport received (From /
// Reply-To), the log lines, mailConfigured, the envelope and deliveryFor. Each scenario runs in a fresh process with a
// throwaway DATA_DIR; nothing can reach a mail server. Needs no PostgreSQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SCENARIOS, FIXTURE, runProbe, compact } = require('../test-support/mail-golden');

const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

for (const scenario of SCENARIOS) {
  test(`SQLite mailer == golden master: ${scenario}`, () => {
    const bodies = {};
    const now = compact(runProbe(scenario, 'sqlite'), bodies);
    for (const [h, text] of Object.entries(bodies)) assert.equal(text, golden.bodies[h], `${scenario}: body ${h.slice(0, 12)} is a known golden body`);
    assert.deepEqual(now, golden.scenarios[scenario], scenario);
  });
}
