// Asset reads and the employee asset-visibility contract on PostgreSQL (D-46, D-48, migration Slice 5C-1): the PG twin of
// src/assetAccess.js (read its comments for the contract, D-21). NOT used by the running app yet (Slice 5D binds it to the driver seam
// under the same names). Same names, parallel signatures, same rows, the same 404 / 400 errors with the same messages; every function
// is async and takes an executor `q` (a pg Pool or a transaction client) where the SQLite version takes `db`.
//
// Differences from SQLite (output identical):
//   - `?` -> `$n`; ids that are not integers in the column's range find nothing (as on SQLite) instead of raising a PG 22P02.
//   - holdsAsset returns the row `{ '1': 1 }` (or undefined) exactly as better-sqlite3 does for `SELECT 1` (the column is named "1").
// These are reads. A route that decides a WRITE from them (check-in, the photo upload, the custody actions) must re-check under the
// asset lock inside the write's transaction on PostgreSQL (carry-overs (w), (x); Slice 5C-5): passing that transaction's client
// here reads on it.
const { toId } = require('./reservations');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const getAsset = async (q, id) => (await q.query('SELECT * FROM assets WHERE id = $1', [toId(id)])).rows[0];

const holds = async (q, assetId, employeeId) => (await q.query('SELECT 1 AS "1" FROM assignments WHERE asset_id = $1 AND employee_id = $2 AND returned_at IS NULL LIMIT 1',
  [toId(assetId), toId(employeeId)])).rows[0];

// Employee asset-visibility contract (see src/assetAccess.js): admin everything; an employee only what they hold or what is in the
// shared pool, live and 'available'.
async function canViewAsset(q, user, a) {
  if (!a) return false;
  if (user.role === 'admin') return true;
  if (!a.archived_at && a.status === 'available' && a.available_to_request) return true;
  return !!user.employee_id && !!(await holds(q, a.id, user.employee_id));
}

// An employee may reserve anything the availability calendar shows them (see src/assetAccess.js).
async function reservableAsset(q, user, id) {
  const a = await getAsset(q, Number(id));
  if (!a) throw httpError(404, 'Asset not found');
  if (user.role === 'admin' || await canViewAsset(q, user, a)) return a;
  if (a.available_to_request && !a.archived_at && ['available', 'checked_out'].includes(a.status)) return a;
  throw httpError(404, 'Asset not found');
}

// The asset for this route, or a 404 when it doesn't exist OR this user may not see it.
async function visibleAsset(q, user, id) {
  const a = await getAsset(q, Number(id));
  if (!a || !(await canViewAsset(q, user, a))) throw httpError(404, 'Asset not found');
  return a;
}
// Employee actions on equipment they currently hold: visible AND checked out to the caller right now (invisible 404, else 400).
async function heldAsset(q, user, id) {
  const asset = await visibleAsset(q, user, id);
  const me = user.employee_id;
  if (!me || !(await holds(q, asset.id, me))) throw httpError(400, "This isn't checked out to you");
  return asset;
}
// Whether this employee holds this asset right now (the photo upload rule: IT or the holder).
const holdsAsset = async (q, assetId, employeeId) => holds(q, assetId, employeeId);

module.exports = { getAsset, canViewAsset, reservableAsset, visibleAsset, heldAsset, holdsAsset };
