// The single-flight waitlist sweep scheduler (Slice 5A, D-48 point 4). NOT started by the running app yet (Slice 5D replaces
// the SQLite 60-second timer in server.js with it).
//
// createSweepScheduler({ pool, intervalMs = 60_000, run = waitlist.sweep, log = console }) -> { tick(), start(), stop() }
//   tick()  one sweep, if nobody else is sweeping. Never throws. Resolves to
//             { ran: true, result }                   the sweep ran (result: what run(pool) returned, { assets, failed } for waitlist.sweep)
//             { ran: true, error }                    the sweep ran and run() threw (logged '[sweep]')
//             { ran: false, reason: 'in_flight' }     this scheduler is already sweeping (in-process flag)
//             { ran: false, reason: 'locked' }        another scheduler (another app instance) holds the sweep lock
//             { ran: false, reason: 'error', error }  the dedicated connection or the lock query failed (logged)
//   start() an unref()'d setInterval calling tick() every intervalMs (no-op when already started)
//   stop()  clears it and waits for an in-flight sweep to finish
// Single flight, two layers: an in-process flag (a tick while one is running is skipped), plus a PostgreSQL SESSION-level
// advisory lock (pg_try_advisory_lock(SWEEP_LOCK_KEY)) taken on a DEDICATED pool connection and held for the whole sweep (the
// sweep itself runs on the pool's other connections), released in finally. If the unlock fails, that connection is destroyed
// instead of returned to the pool: a closed session frees its advisory locks.
const waitlist = require('./waitlist');

// Distinct from src/pg/migrate.js ADVISORY_LOCK_KEY (4_651_201_400_017, the schema runner); same arbitrary app-unique prefix.
const SWEEP_LOCK_KEY = 4_651_201_400_018;

function createSweepScheduler({ pool, intervalMs = 60_000, run = waitlist.sweep, log = console } = {}) {
  if (!pool) throw new TypeError('createSweepScheduler({ pool }): a pool is required');
  let inFlight = null;
  let timer = null;

  async function once() {
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      log.error('[sweep]', 'no connection for the sweep lock:', err.message);
      return { ran: false, reason: 'error', error: err.message };
    }
    let locked = false;
    let broken = null;
    // (pg-pool listens for errors only on IDLE clients: this one sits checked out with no query running while the sweep runs on
    // other connections, so a dropped session would otherwise be an unhandled 'error' event; it is destroyed instead of reused)
    const onError = (err) => { broken = err; log.error('[sweep]', 'sweep lock connection lost:', err.message); };
    client.on('error', onError);
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SWEEP_LOCK_KEY])).rows[0].ok === true;
      if (!locked) return { ran: false, reason: 'locked' };
      try {
        return { ran: true, result: await run(pool) };
      } catch (err) {
        log.error('[sweep]', err.message);
        return { ran: true, error: err.message };
      }
    } catch (err) {
      broken = err;
      log.error('[sweep]', 'sweep lock:', err.message);
      return { ran: false, reason: 'error', error: err.message };
    } finally {
      if (locked && !broken) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]); } catch (err) { broken = err; }
      }
      client.removeListener('error', onError);
      if (broken) client.on('error', () => {}); // (a destroyed connection may still report its own end)
      client.release(broken || undefined);
    }
  }

  function tick() {
    if (inFlight) return Promise.resolve({ ran: false, reason: 'in_flight' });
    inFlight = once().finally(() => { inFlight = null; });
    return inFlight;
  }
  function start() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, intervalMs);
    timer.unref();
  }
  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (inFlight) await inFlight;
  }
  return { tick, start, stop };
}

module.exports = { createSweepScheduler, SWEEP_LOCK_KEY };
