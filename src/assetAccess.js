// Asset reads and the employee asset-visibility contract (SQLite). Extracted VERBATIM from src/server.js in PostgreSQL migration
// Slice 5B-1 (D-48): the SQL is unchanged; the only difference is that the database handle is the first argument, like the other data
// modules (src/reservations.js, src/waitlist.js, ...). Routes migrated to the temporary driver seam reach these through src/dataSeam
// (`await data.assetAccess.reservableAsset(user, id)`); the routes not migrated yet keep calling them synchronously through thin
// bound aliases in server.js (`getAsset(id)`, `canViewAsset(user, a)`). A PostgreSQL twin follows in Slice 5C.
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const getAsset = (db, id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);

// Employee asset-visibility contract, enforced on the server (hiding navigation is not access control). An admin sees
// everything. An employee may see an asset only if they currently hold it (that follows the ASSIGNMENT: a desk computer assigned to
// them stays theirs whatever its flags), or it is in the shared pool and available to them: IT made it `available_to_request`, it is
// not archived, and its status is 'available' (a multi-seat license with a free seat stays 'available'; a full one is 'checked_out').
// Anything else — not shared, archived, in repair, lost, retired, held by someone else — is indistinguishable from "not found".
function canViewAsset(db, user, a) {
  if (!a) return false;
  if (user.role === 'admin') return true;
  if (!a.archived_at && a.status === 'available' && a.available_to_request) return true;
  return !!user.employee_id && !!db.prepare('SELECT 1 FROM assignments WHERE asset_id = ? AND employee_id = ? AND returned_at IS NULL').get(a.id, user.employee_id);
}

// An employee may reserve anything the availability calendar shows them: in the shared pool (available_to_request), not archived, 'available' OR
// currently 'checked_out' (reserving is how you claim FUTURE dates of an item someone has out now). This does not open the asset page or its
// record to them (canViewAsset / GET /api/assets/:id are unchanged); reservations.create still enforces every eligibility rule.
// (server.js passed `req`; only `req.user` was ever read, so the signed-in user is passed as `user`.)
function reservableAsset(db, user, id) {
  const a = getAsset(db, Number(id));
  if (!a) throw httpError(404, 'Asset not found');
  if (user.role === 'admin' || canViewAsset(db, user, a)) return a;
  if (a.available_to_request && !a.archived_at && ['available', 'checked_out'].includes(a.status)) return a;
  throw httpError(404, 'Asset not found');
}

module.exports = { getAsset, canViewAsset, reservableAsset };
