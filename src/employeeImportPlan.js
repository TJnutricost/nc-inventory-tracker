// Employee CSV import, the PLAN (pure: no database, no I/O; shared by the SQLite module src/employeeImport.js and its PostgreSQL twin
// src/pg/employeeImport.js, so both engines decide exactly alike). docs/briefs/employee-csv-import.md has the rules.
//
// Rows are matched to existing employees by the normalized (trimmed, lower-cased) work email, the only identifier the employees table has.
// The plan never guesses: a row whose email also points at someone else (a login of another person, two stored employees that differ only
// in letter case) or that conflicts with another row of the same file is a conflict and is left out. It never touches status, role,
// accounts, assignments, history or the self-checkout permission of an existing employee; a blank cell never erases a stored value.
const MAX_ROWS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
// What an import may write (work_email is the match key). `name` is the display name composed from first_name + last_name; the existing
// column stays for compatibility, first_name / last_name are stored separately (migration 19).
const FIELDS = ['first_name', 'last_name', 'name', 'department', 'title', 'phone', 'building'];
const LIMITS = { first_name: 50, last_name: 50, name: 100, work_email: 254, department: 100, title: 100, phone: 40, building: 100 };
const LABEL = { first_name: 'first_name', last_name: 'last_name', name: 'Name', work_email: 'work_email', department: 'department', title: 'job_title', phone: 'phone', building: 'location' };

// The ONLY supported columns (header compared after lower-casing and turning runs of other characters into _, so "First name" works).
// Anything else, a combined name, an Employee ID (not stored by the application), or a column with no header, is refused: an unsupported
// column is never silently accepted or ignored.
const COLUMNS = { first_name: 'first_name', last_name: 'last_name', work_email: 'work_email', department: 'department', job_title: 'title', location: 'building', phone: 'phone' };
const COMBINED = new Set(['name', 'full_name', 'fullname', 'employee_name', 'display_name']); // refused, never split
const REQUIRED = ['first_name', 'last_name', 'work_email'];

const TEMPLATE = 'first_name,last_name,work_email,department,job_title,location,phone\r\n'
  + 'Ada,Lovelace,ada.lovelace@nutricost.com,IT,Systems Analyst,HQ,555-0100\r\n'
  + 'Grace,Hopper,grace.hopper@nutricost.com,Operations,Operations Manager,Warehouse,\r\n';

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const cell = (v) => String(v ?? '').trim();
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);

// The parsed CSV (array of arrays, header first) -> { rows: [{ line, first_name, last_name, work_email, ... }] }.
function rowsFromCsv(table) {
  if (table.length < 2) throw httpError(400, 'The file needs a header row and at least one employee.');
  if (table.length - 1 > MAX_ROWS) throw httpError(400, `The file has ${table.length - 1} rows; the limit is ${MAX_ROWS}. Split it and import in parts.`);
  const keys = table[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''));
  const combined = table[0].find((h, i) => COMBINED.has(keys[i]));
  if (combined !== undefined) throw httpError(400, `The "${String(combined).trim()}" column holds a combined name. Use separate first_name and last_name columns; names are never split automatically.`);
  const unsupported = table[0].map((h, i) => (COLUMNS[keys[i]] ? null : (String(h).trim() || '(no header)'))).filter(Boolean);
  if (unsupported.length) throw httpError(400, `Unsupported column${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')}. The columns are first_name, last_name, work_email, department, job_title, location, phone. Remove the others and try again.`);
  const fields = keys.map((k) => COLUMNS[k]);
  for (const need of REQUIRED) if (!fields.includes(need)) throw httpError(400, `The file needs a "${LABEL[need]}" column.`);
  const seen = new Set();
  for (const f of fields) { if (seen.has(f)) throw httpError(400, `Two columns mean "${LABEL[f]}". Keep one.`); seen.add(f); }
  const rows = table.slice(1).map((r, n) => {
    const o = { line: n + 2 };
    fields.forEach((f, i) => { o[f] = cell(r[i]); });
    return o;
  });
  return { rows };
}

// One row's own problems (null when fine) and its cleaned values.
function checkRow(r) {
  const v = {};
  for (const f of ['first_name', 'last_name', 'work_email', 'department', 'title', 'phone', 'building']) v[f] = cell(r[f]);
  v.work_email = normEmail(v.work_email);
  v.name = [v.first_name, v.last_name].filter(Boolean).join(' '); // stored in the one existing `name` column
  for (const f of Object.keys(LIMITS)) {
    if (hasControl(v[f])) return { v, error: `${LABEL[f]} has a control or line-break character.` };
    if (v[f].length > LIMITS[f]) return { v, error: `${LABEL[f]} is longer than ${LIMITS[f]} characters.` };
  }
  if (!v.first_name) return { v, error: 'first_name is required.' };
  if (!v.last_name) return { v, error: 'last_name is required.' };
  if (!v.work_email) return { v, error: 'work_email is required.' };
  if (!isEmail(v.work_email)) return { v, error: 'work_email is not a valid address.' };
  return { v, error: null };
}

const sameValues = (a, b) => FIELDS.every((f) => a[f] === b[f]);

// rows: from rowsFromCsv. existing: { employees: [{ id, name, work_email, department, title, phone, building, status, login_email }],
// loginsWithoutPerson: [login_email] } as stored. Returns the plan; every input row appears once, in order.
function buildPlan(rows, existing) {
  const byEmail = new Map(); // lower(work_email) -> employees
  for (const e of existing.employees) if (e.work_email) { const k = normEmail(e.work_email); (byEmail.get(k) || byEmail.set(k, []).get(k)).push(e); }
  const byLogin = new Map(); // lower(login_email) -> the employee it belongs to, or null when the login has no person
  for (const e of existing.employees) if (e.login_email) byLogin.set(normEmail(e.login_email), e);
  for (const l of existing.loginsWithoutPerson || []) byLogin.set(normEmail(l), null);

  const checked = rows.map((r) => ({ line: r.line, ...checkRow(r) }));
  const firstOf = new Map(); // email -> checked rows (valid ones) with it
  for (const c of checked) if (!c.error) (firstOf.get(c.v.work_email) || firstOf.set(c.v.work_email, []).get(c.v.work_email)).push(c);

  const out = checked.map((c) => {
    const base = { line: c.line, first_name: c.v.first_name, last_name: c.v.last_name, name: c.v.name, work_email: c.v.work_email, action: null, changes: {}, message: '' };
    if (c.error) return { ...base, action: 'invalid', message: c.error };
    const group = firstOf.get(c.v.work_email);
    if (group.length > 1) {
      const lines = group.map((g) => g.line).join(', ');
      if (!group.every((g) => sameValues(g.v, group[0].v))) return { ...base, action: 'conflict', message: `Rows ${lines} use this email with different details. Fix the file.` };
      if (group[0] !== c) return { ...base, action: 'duplicate', message: `Same as row ${group[0].line}; imported once.` };
    }
    const found = byEmail.get(c.v.work_email) || [];
    if (found.length > 1) return { ...base, action: 'conflict', message: 'More than one existing person has this email (differing only in letter case). Merge them in People first.' };
    if (!found.length) {
      if (byLogin.has(c.v.work_email)) {
        const owner = byLogin.get(c.v.work_email);
        return { ...base, action: 'conflict', message: owner ? `This address is the login of ${owner.name}, whose work email is different. Fix it in People.` : 'This address is a login that is not linked to a person. Fix it in People.' };
      }
      return { ...base, action: 'create', changes: Object.fromEntries(FIELDS.filter((f) => c.v[f]).map((f) => [f, [null, c.v[f]]])) };
    }
    const e = found[0];
    if (e.status !== 'active') return { ...base, id: e.id, action: 'conflict', message: 'This person is inactive. Imports never reactivate anyone; do it in People.' };
    const changes = {};
    for (const f of FIELDS) if (c.v[f] && c.v[f] !== (e[f] ?? '')) changes[f] = [e[f] ?? null, c.v[f]];
    return { ...base, id: e.id, action: Object.keys(changes).length ? 'update' : 'unchanged', changes };
  });

  const count = (a) => out.filter((r) => r.action === a).length;
  const counts = { create: count('create'), update: count('update'), unchanged: count('unchanged'), invalid: count('invalid'), duplicate: count('duplicate'), conflict: count('conflict') };
  counts.excluded = counts.invalid + counts.duplicate + counts.conflict;
  return { rows: out, counts, total: out.length };
}

// The admin's confirmation, checked against the plan recomputed inside the write: excluded rows need an explicit acknowledgement, and
// what is about to change must be what the preview showed (otherwise the data moved in between: preview again).
function checkConfirmed(plan, { acknowledge, expect } = {}) {
  if (plan.counts.excluded > 0 && !acknowledge) throw httpError(400, 'Some rows will be left out. Review them and confirm to import the rest.');
  if (expect && (expect.create !== plan.counts.create || expect.update !== plan.counts.update)) {
    throw httpError(409, 'The people changed since the preview. Preview the file again before importing.');
  }
}
const summaryText = (c) => `Employee CSV import: ${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.excluded} left out`;

module.exports = { MAX_ROWS, MAX_BYTES, FIELDS, TEMPLATE, rowsFromCsv, buildPlan, checkConfirmed, summaryText, httpError };
