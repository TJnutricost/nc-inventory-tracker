// Reservation / waitlist time ranges (Phase 2, slice 8.1). One place for how a (date, optional time) range is VALIDATED, COMPARED and WRITTEN
// in words, so reservations, holds, waitlist, availability, checkout and email can never drift apart.
//
// Storage (see migration 17): start_date / end_date are calendar days (YYYY-MM-DD); start_time / end_time are OPTIONAL wall-clock "HH:MM" in the
// business's time zone (APP_TIMEZONE), independently nullable. A reservation is "pickup on start_date [at start_time]" until "return on end_date [at
// end_time]". NULL is never rewritten into a stored value. Because dates and times are wall-clock in the SAME zone, comparing them needs no time
// zone arithmetic at all: they are ordered as plain strings (APP_TIMEZONE only matters when "now" is converted, and nothing here needs "now").
//
// Comparison semantics (internal only; nobody is shown these):
//   a blank pickup time  = the START of start_date            (key `${start_date}T00:00`)
//   a blank return time  = the END of end_date                (the start of the NEXT day, key `${end_date + 1 day}T00:00`)
//   a range is the half-open interval [startKey, endKey): 8:00-13:00 and 13:00-17:00 touch but do not overlap; 8:00-13:01 and 13:00-17:00 do.
//   For a multi-day range the pickup time applies only to the first day and the return time only to the last; days between are whole days.

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;
const DAY_MS = 864e5;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// A request's optional time field -> 'HH:MM' or null. '' / null / undefined mean "no specific time". Anything else that is not a valid
// 24-hour clock time is a 400 (`label` is the user-facing name: "pickup time" / "return time"). ':00' seconds from a client are dropped.
function cleanTime(v, label = 'time') {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw httpError(400, `Choose a valid ${label}.`);
  const s = v.trim();
  if (!s) return null;
  const m = TIME_RE.exec(s);
  if (!m) throw httpError(400, `Choose a valid ${label}.`);
  return `${m[1]}:${m[2]}`;
}

// The comparison keys (ISO-like strings that sort chronologically).
const startKey = (date, time) => `${date}T${time || '00:00'}`;
const endKey = (date, time) => (time ? `${date}T${time}` : `${addDays(date, 1)}T00:00`);
// {sk, ek} for any row/object carrying start_date/start_time/end_date/end_time (missing time fields = null: old rows, tests, callers).
const keysOf = (r) => ({ sk: startKey(r.start_date, r.start_time), ek: endKey(r.end_date, r.end_time) });
// Do two {sk, ek} ranges share any time? Touching at a boundary is NOT sharing.
const overlaps = (a, b) => a.sk < b.ek && b.sk < a.ek;
const overlapsRows = (a, b) => overlaps(keysOf(a), keysOf(b));

// The range must have a positive length: same-day with both times means return strictly after pickup; one time alone is always fine on a
// same-day range except a return at 00:00 (that would end before it began). Dates are assumed already validated.
function checkOrder(start, startTime, end, endTime) {
  if (endKey(end, endTime) > startKey(start, startTime)) return;
  if (startTime && endTime) throw httpError(400, 'The return time must be after the pickup time.');
  throw httpError(400, 'The return time must be after the start of the day. Choose a later time.');
}

// How a day relates to a range: 'full' (the range covers all 24 hours of it), 'partial' (some of it), or null (none).
function coverageOfDay(range, day) {
  const d = { sk: `${day}T00:00`, ek: `${addDays(day, 1)}T00:00` };
  const k = keysOf(range);
  if (!overlaps(k, d)) return null;
  return k.sk <= d.sk && k.ek >= d.ek ? 'full' : 'partial';
}

// ---- splitting a requested range into the part that is free and the part that is not (slice 8.1 correction)
// `blocks` = [{ sk, ek }] of whatever makes the asset unavailable (reservations, holds, checkouts). Anything may overlap, touch or lie outside the request.
// Returns { free, busy }: the request cut into row-shaped ranges ({start_date, start_time, end_date, end_time}) in time order, every piece with a positive
// length, together covering the request exactly. Touching is not overlapping, so a block that ends at 1:00 PM leaves a request that starts at 1:00 PM free.
const INF_KEY = '9999-12-31T99:99';
const lastMinuteDay = (key) => addDays(key.slice(0, 10), -1);
function rowOfKeys(sk, ek, req) {
  const reqK = keysOf(req);
  const startOnReq = sk === reqK.sk; const endOnReq = ek === reqK.ek; // (the user's own boundary values are kept as typed)
  const [sd, st] = [sk.slice(0, 10), sk.slice(11)]; const [ed, et] = [ek.slice(0, 10), ek.slice(11)];
  return {
    start_date: startOnReq ? req.start_date : sd, start_time: startOnReq ? req.start_time || null : st === '00:00' ? null : st,
    end_date: endOnReq ? req.end_date : et === '00:00' ? lastMinuteDay(ek) : ed, end_time: endOnReq ? req.end_time || null : et === '00:00' ? null : et,
  };
}
function splitFree(range, blocks) {
  const want = keysOf(range);
  const cut = blocks.map((b) => ({ sk: b.sk < want.sk ? want.sk : b.sk, ek: b.ek > want.ek ? want.ek : b.ek })).filter((b) => b.sk < b.ek).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
  const busy = [];
  for (const b of cut) { const last = busy[busy.length - 1]; if (last && b.sk <= last.ek) { if (b.ek > last.ek) last.ek = b.ek; } else busy.push({ ...b }); }
  const free = []; let at = want.sk;
  for (const b of busy) { if (at < b.sk) free.push({ sk: at, ek: b.sk }); at = b.ek; }
  if (at < want.ek) free.push({ sk: at, ek: want.ek });
  const rows = (list) => list.map((p) => rowOfKeys(p.sk, p.ek, range));
  return { free: rows(free), busy: rows(busy) };
}

const minutes = (key) => Date.parse(`${key}:00Z`) / 6e4;
// Whole minutes from key `a` to key `b` (both wall-clock keys in the same zone; negative when b is earlier).
const minutesBetween = (a, b) => minutes(b) - minutes(a);

// "Now" as a wall-clock key in the business's zone (APP_TIMEZONE, else the server's zone): the only place this module needs a clock. It is what a response
// window is measured against, because reservation times are wall-clock in that same zone.
function nowKey(date = new Date()) {
  const parts = (tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  let p; try { p = parts(process.env.APP_TIMEZONE || undefined); } catch { p = parts('UTC'); }
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
// A stored UTC timestamp ('YYYY-MM-DD HH:MM:SS') for a person, in APP_TIMEZONE (else the server's zone): "Wed, Oct 7, 2:30 PM MDT".
function fmtStamp(ts) {
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try { return d.toLocaleString('en-US', { ...opts, timeZone: process.env.APP_TIMEZONE || undefined }); } catch { return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
}
// Is there a strictly shorter, still-positive end for this range (on or after `earliestDay`, the first day a shortening may land on)? The server's
// "may this reservation be shortened at all" answer, so the UI never guesses.
function canShorten(r, earliestDay) {
  const floor = [startKey(r.start_date, r.start_time), `${earliestDay}T00:00`].sort().pop(); // the later of the two
  return minutes(endKey(r.end_date, r.end_time)) - minutes(floor) > 1;
}

// ---- words (the same wording everywhere on the server: activity notes, email). The browser mirrors these in public/app.js (fmtClock / resvRange).
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// '13:00' -> '1:00 PM'. Pure string arithmetic: never a Date, so no time zone can move it.
function fmtTime(t) {
  const m = /^(\d{2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
// Oct 12, 2026 · All day | Oct 12, 2026 · Pickup 8:00 AM | Oct 12, 2026 · Return by 1:00 PM | Oct 12, 2026 · 8:00 AM – 1:00 PM
// Oct 12, 2026 to Oct 14, 2026 · Return by 1:00 PM | Oct 12, 2026, 8:00 AM to Oct 14, 2026, 1:00 PM
// `allDay` (emails) says "All day" for a single date-only day; the default keeps date-only text exactly as it always was (activity notes, tests).
function when(r, { allDay = false } = {}) {
  const { start_date: s, end_date: e } = r; const st = r.start_time || null; const et = r.end_time || null;
  if (s === e) {
    if (st && et) return `${fmtDay(s)} · ${fmtTime(st)} – ${fmtTime(et)}`;
    if (st) return `${fmtDay(s)} · Pickup ${fmtTime(st)}`;
    if (et) return `${fmtDay(s)} · Return by ${fmtTime(et)}`;
    return allDay ? `${fmtDay(s)} · All day` : fmtDay(s);
  }
  if (st && et) return `${fmtDay(s)}, ${fmtTime(st)} to ${fmtDay(e)}, ${fmtTime(et)}`;
  const base = `${fmtDay(s)} to ${fmtDay(e)}`;
  if (st) return `${base} · Pickup ${fmtTime(st)}`;
  if (et) return `${base} · Return by ${fmtTime(et)}`;
  return base;
}

module.exports = { httpError, cleanTime, startKey, endKey, keysOf, overlaps, overlapsRows, checkOrder, coverageOfDay, canShorten, splitFree, INF_KEY, minutesBetween, nowKey, fmtStamp, fmtTime, fmtDay, when, addDays };
