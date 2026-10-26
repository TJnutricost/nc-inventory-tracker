// Helpers for the Slice 5C-3 tests (accounts, sessions, people writes; test/pg/pg-accounts.test.js, pg-people-writes.test.js):
//   - result(fn): { ok } | { error: { status, message } } (an HTTP error) | { raw: true } (a database error: both engines word theirs
//     differently, so only THAT it failed is compared). Never throws.
//   - tables(tw): the auth tables of both twin engines, masked (module-written timestamps read each engine's clock), deep-equal checked.
//   - overlap(pool, sampler, first, second): a deterministic race. `first(client)` runs inside a transaction that stays OPEN until
//     `second(pool)` (started meanwhile) has either finished or is waiting on a lock; then the first commits. Without a lock in
//     `second`'s way it simply runs to the end against the first's uncommitted state (what an unguarded race would do).
// Only for tests.
const assert = require('node:assert/strict');
const { withTransaction } = require('../src/pg/transaction');
const { lockWaiters } = require('./pg-write-support');

async function result(fn) {
  try {
    return { ok: await fn() };
  } catch (err) {
    if (err && err.status !== undefined) return { error: { status: err.status, message: err.message } };
    return { raw: true };
  }
}

const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const mask = (row) => {
  const out = { ...row };
  for (const k of ['created_at', 'last_login_at']) if (k in out && out[k] !== null) out[k] = STAMP.test(out[k]) ? '<stamp>' : out[k];
  return out;
};
const AUTH_TABLES = { employees: 'id', accounts: 'id', tokens: 'token', sessions: 'sid' };
async function tables(tw, label) {
  const pg = {}; const sq = {};
  for (const [t, order] of Object.entries(AUTH_TABLES)) {
    pg[t] = (await tw.pg.query(`SELECT * FROM ${t} ORDER BY ${order}`)).rows.map(mask);
    sq[t] = tw.sqlite.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all().map(mask);
  }
  assert.deepEqual(pg, sq, `${label}: the tables agree`);
  return pg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overlap(pool, sampler, first, second, timeoutMs = 10000) {
  let release; const gate = new Promise((r) => { release = r; });
  let started; const firstDone = new Promise((r) => { started = r; });
  const a = result(() => withTransaction(async (c) => {
    try { return await first(c); } finally { started(); await gate; }
  }, pool));
  await firstDone;
  let settled = false;
  const b = result(() => second(pool)).finally(() => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (!settled && (await lockWaiters(sampler)) < 1) {
    if (Date.now() > deadline) { release(); throw new Error('overlap: the second operation neither finished nor waited on a lock'); }
    await sleep(10);
  }
  const blocked = !settled;
  release();
  return { first: await a, second: await b, blocked };
}

module.exports = { result, tables, overlap, mask };
