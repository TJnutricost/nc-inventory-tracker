// SQLite-identical "now" for PostgreSQL (D-46, migration Slice 3). The ONE place src/pg/* produces the current time.
//
// D-46: timestamps stay TEXT in the same formats, so every stored value and every string comparison
// (hold_expires_at > now, resolved_at >= created_at, ...) behaves exactly as on SQLite:
//   NOW    = SQLite datetime('now') -> 'YYYY-MM-DD HH:MM:SS'  UTC, second precision, fraction TRUNCATED (not rounded)
//   TODAY  = SQLite date('now')     -> 'YYYY-MM-DD'           UTC
// Both are SQL expressions to splice into a statement (they are constants, never user input).
//
// Which clock: statement_timestamp(), the time the current statement started. That is SQLite's rule for 'now' (one value
// for the whole statement, so `archived_at = NOW, updated_at = NOW` can never straddle a second, and a later statement
// in the same transaction gets a later time) and it is what the baseline column defaults use
// (src/pg/schema/001_baseline.sql), so an INSERT that omits created_at and one that writes NOW agree. now() /
// CURRENT_TIMESTAMP would be wrong (frozen at transaction start); clock_timestamp() would change within one statement.
// `AT TIME ZONE 'UTC'` makes the text UTC regardless of the session TimeZone (the pool also forces UTC).

const stampOf = (expr) => `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
const dateOf = (expr) => `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

const NOW = stampOf('statement_timestamp()');
const TODAY = dateOf('statement_timestamp()');

// SQLite datetime(<base>, '+N seconds'): `base` plus N seconds (an SQL expression, typically a $n placeholder; may be
// fractional or negative), in the same truncated UTC text. NOW_PLUS('$2') is datetime('now', '+N seconds') with N in $2:
// what hold_expires_at is written with (Slice 4B/4C), so `hold_expires_at > NOW` keeps comparing as text exactly as on SQLite.
const stampPlus = (base, secondsSql) => stampOf(`(${base}) + make_interval(secs => (${secondsSql})::double precision)`);
const NOW_PLUS = (secondsSql) => stampPlus('statement_timestamp()', secondsSql);

// The values themselves, read through executor `q` (a pool or a transaction client).
const now = async (q) => (await q.query(`SELECT ${NOW} AS v`)).rows[0].v;
const today = async (q) => (await q.query(`SELECT ${TODAY} AS v`)).rows[0].v;
const nowPlus = async (q, seconds) => (await q.query(`SELECT ${NOW_PLUS('$1')} AS v`, [seconds])).rows[0].v;

module.exports = { NOW, TODAY, NOW_PLUS, now, today, nowPlus, stampOf, dateOf, stampPlus };
