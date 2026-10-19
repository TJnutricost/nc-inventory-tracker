// The worker half of test-support/pg-sync.js: owns ONE PostgreSQL connection and answers { sql, params } messages, so the main thread can
// block (Atomics.wait) for a result without stopping the connection. Only for tests.
const { workerData, parentPort } = require('node:worker_threads');
const { Client, types } = require('pg');

const { url, port, sab } = workerData;
const flag = new Int32Array(sab);
const client = new Client({ connectionString: url, options: '-c TimeZone=UTC', types: {
  getTypeParser: (oid, format) => (oid === 20 && format !== 'binary' ? (v) => Number(v) : types.getTypeParser(oid, format)),
} });
const ready = client.connect();
client.on('error', () => {});

function reply(payload) {
  port.postMessage(payload);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

parentPort.on('message', async (msg) => {
  try {
    await ready;
    if (msg.close) { await client.end().catch(() => {}); reply({ result: null }); process.exit(0); }
    const res = await client.query(msg.sql, msg.params);
    reply({ result: { rows: res.rows, rowCount: res.rowCount } });
  } catch (err) {
    reply({ error: { message: err.message, code: err.code } });
  }
});
