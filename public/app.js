/* Nutricost IT Assets — front-end (vanilla JS, no build step) */
'use strict';

// ============================================================ utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, settings: null, mailConfigured: false, shell: false };
const isAdmin = () => S.me && S.me.role === 'admin';
// The scanner (and its camera) is for IT and for employees with the self-checkout permission; the server enforces it too (403).
const canScan = () => !!S.me && (S.me.role === 'admin' || !!S.me.can_self_checkout);
const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const addDays = (n) => { const d = new Date(Date.now() + n * 864e5); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const parseDT = (s) => (!s ? null : s.length === 10 ? new Date(s + 'T12:00:00') : new Date(s.replace(' ', 'T') + 'Z'));
const fmtDate = (s) => { const d = parseDT(s); return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
const fmtStamp = (s) => { const d = parseDT(s); return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
const fmtWhen = (s) => {
  const d = parseDT(s); if (!d) return '';
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(s);
};
const isOverdue = (due) => due && due < localToday();
const money = (n) => (n == null ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const qs = () => new URLSearchParams((location.hash.split('?')[1]) || '');
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };

// Appearance: System (default; the OS decides through prefers-color-scheme, so it follows OS changes with no JS), Light or Dark.
// Stored in localStorage only. An explicit choice is the data-theme attribute on <html>; index.html sets it before first paint.
const THEME_KEY = 'nc-theme';
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const getTheme = () => { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } };
const applyTheme = () => { const t = getTheme(); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); };
const setTheme = (t) => { try { if (t === 'light' || t === 'dark') localStorage.setItem(THEME_KEY, t); else localStorage.removeItem(THEME_KEY); } catch { /* storage blocked: it still applies for this visit */ } if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); };
window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(); }); // another tab changed it

async function api(method, url, body, { raw } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (typeof body === 'string') { opts.body = body; opts.headers['Content-Type'] = 'text/csv'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me/password')) {
    S.me = null; S.shell = false;
    if (!/^#\/(login|forgot|reset|setup)/.test(location.hash)) location.hash = '#/login';
  }
  if (res.status === 404 && data && data.error === 'Not found') throw new Error("That action isn't available right now. Reload the page and try again."); // e.g. the page is newer than the server
  if (!res.ok) throw new Error((data && data.error) || (res.status === 403 ? "That isn't available from your account. Ask IT if you need it." : 'Something went wrong. Please try again.'));
  return data;
}

let toastTimer;
function toast(msg, isErr = false, kind = '') { // kind 'ok' = a green success toast (used where the result is worth confirming clearly)
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : kind ? ' ' + kind : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), msg.length > 40 ? 4500 : 2800); // (a longer message needs longer to read)
}
const fail = (e) => toast(e.message || String(e), true);

async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner" style="margin:0;width:18px;height:18px;border-width:2px"></span>'; }
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.label; } }
}

// ============================================================ icons
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.8 3.5 3 3.5 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5"/><path d="M4 4h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  archive: '<path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  out: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 7l5 5-5 5M14 12H3"/>',
  in: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 17l-5-5 5-5M10 12h11"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M9 20h6M12 16.5V20"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5v.01"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  dock: '<rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 12h.01M11 12h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L2 10l8-8z"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
};
const icon = (n, cls = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${P[n] || P.box}</svg>`;
const CAT_ICON = { Laptop: 'laptop', Desktop: 'desktop', Monitor: 'monitor', 'Keyboard & Mouse': 'keyboard', Headset: 'headphones', 'Dock / Adapter': 'dock', Phone: 'phone', Tablet: 'tablet', 'Printer / Scanner': 'printer', Networking: 'wifi', Appliance: 'plug', 'Software License': 'key' };
const catIcon = (c) => CAT_ICON[c] || (/laptop|notebook/i.test(c) ? 'laptop' : /monitor|display/i.test(c) ? 'monitor' : /license|software/i.test(c) ? 'key' : 'box');
const STATUS_LABEL = { available: 'Available', checked_out: 'Checked out', maintenance: 'In repair', retired: 'Retired', disposed: 'Disposed', lost: 'Lost', overdue: 'Overdue' };
const isPermReq = (r) => r.requested_assignment_type === 'permanent';
// The lifecycle a person sees (derived on the server from status + opened_at; see src/requests.js). One vocabulary for employees and IT.
// The card pill, the detail sheet and the state filter ALL read it through `stateKey`/`statusLabel` below, so they cannot disagree,
// and a raw database status ("completed", "cancelled", "denied") is never shown.
const LIFE_LABEL = { ready: 'Ready', submitted: 'Submitted', in_review: 'In review', approved: 'Approved', dropped_off: 'Dropped off', fulfilled: 'Fulfilled', resolved: 'Resolved', denied: 'Declined', rescinded: 'Rescinded', withdrawn: 'Withdrawn', cancelled: 'Cancelled', dismissed: 'Dismissed' };
const LIFE_CLASS = { submitted: 'open', in_review: 'in_review', approved: 'approved', dropped_off: 'dropped_off', fulfilled: 'completed', resolved: 'completed', denied: 'denied', rescinded: 'cancelled', withdrawn: 'cancelled', cancelled: 'cancelled', dismissed: 'cancelled' }; // pill colour
const OPEN_STATES = ['submitted', 'in_review', 'approved', 'dropped_off'];
const CLOSED_STATES = ['fulfilled', 'resolved', 'denied', 'rescinded', 'withdrawn', 'cancelled', 'dismissed'];
const ISSUE_ONLY_STATES = ['resolved', 'withdrawn', 'dismissed']; // issue reports' own words; offered in the filter only when there is one
// Fallback only for a row that arrives without `lifecycle` (a server older than this front end): map the status to the same words.
const LIFE_FROM_STATUS = { open: 'submitted', approved: 'approved', dropped_off: 'dropped_off', denied: 'denied', completed: 'fulfilled', cancelled: 'cancelled' };
// The state a request is in, in the words used everywhere: the lifecycle, except an issue report closes as Resolved / Withdrawn / Dismissed.
const stateKey = (r) => {
  const l = r.lifecycle || LIFE_FROM_STATUS[r.status];
  return r.type === 'issue' ? ({ fulfilled: 'resolved', rescinded: 'withdrawn', cancelled: 'dismissed' })[l] || l : l;
};
// The pill text. The one deliberate exception: a live return reads "Return requested" (IT asked / the employee asked to give it back).
const statusLabel = (r) => (r.type === 'return' && ['submitted', 'in_review'].includes(stateKey(r)) ? 'Return requested' : LIFE_LABEL[stateKey(r)] || 'Open');
const reqPill = (r) => pill(LIFE_CLASS[stateKey(r)] || 'open', statusLabel(r));
const requestIcon = (r) => (r.type === 'return' ? 'in' : r.type === 'issue' ? 'alert' : 'box'); // equipment request = package (the inbox/tray glyph is kept free for a future Inbox)
const TYPE_LABEL = { permanent: 'Permanent', checkout: 'Temporary checkout' };
const fmtClock = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m) return ''; const h = Number(m[1]); return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
// ---- optional time control: Hour (1-12), Minutes and AM/PM, each quick to pick AND typeable; blank until the person starts one. No native time input
// (it shows a default-looking time in some Chrome setups and makes people type AM/PM), no long list of every half hour.
// The real value lives in a hidden input named `name` ('HH:MM' or ''); `data-bad="1"` there means something was started that is not a whole time yet.
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
// hour text, minute text, 'AM' | 'PM' | '' -> { value: 'HH:MM' | '', bad }. All blank is a clean blank; anything started but not whole or valid is `bad`.
// AM or PM for "right now" in the business's zone (APP_TIMEZONE; the server sends it): what a NEW time defaults to once the person starts it.
function currentAmPm() {
  let hour;
  try { hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: S.appTimezone || undefined }).format(new Date())); } catch { hour = new Date().getHours(); }
  return hour % 24 < 12 ? 'AM' : 'PM';
}
function composeTime(h, m, ap) {
  const hh = String(h || '').trim(); const mm = String(m || '').trim();
  if (!hh && !mm && !ap) return { value: '', bad: false };
  if (!/^\d{1,2}$/.test(hh) || Number(hh) < 1 || Number(hh) > 12) return { value: '', bad: true };
  if (!/^\d{1,2}$/.test(mm) || Number(mm) > 59) return { value: '', bad: true };
  if (ap !== 'AM' && ap !== 'PM') return { value: '', bad: true };
  return { value: `${String((Number(hh) % 12) + (ap === 'PM' ? 12 : 0)).padStart(2, '0')}:${String(Number(mm)).padStart(2, '0')}`, bad: false };
}
const timeBox = (name, v = '', id = '') => {
  const m = /^(\d{2}):(\d{2})$/.exec(v || ''); const h = m ? Number(m[1]) : null;
  const part = (cls, label, ph, val, list) => `<div class="tpart"><input type="text" class="${cls}" inputmode="numeric" maxlength="2" autocomplete="off" role="combobox" aria-expanded="false" aria-label="${label}" placeholder="${ph}" value="${esc(val)}"><ul class="tbox-list" role="listbox" hidden>${list.map((x) => `<li role="option" data-v="${x}">${x}</li>`).join('')}</ul></div>`;
  return `<div class="tbox" data-tbox="${name}" role="group" aria-label="${name === 'start_time' ? 'Pickup' : 'Return'} time">${part('th', 'Hour', 'Hr', m ? String(h % 12 || 12) : '', HOURS)}<span class="tcolon">:</span>${part('tm', 'Minutes', 'Min', m ? m[2] : '', MINUTES)}
    <div class="tampm" role="group" aria-label="AM or PM"><button type="button" data-ap="AM" aria-pressed="${m && h < 12 ? 'true' : 'false'}">AM</button><button type="button" data-ap="PM" aria-pressed="${m && h >= 12 ? 'true' : 'false'}">PM</button></div>
    <input type="hidden" name="${name}" ${id ? `id="${id}"` : ''} value="${esc(v)}" data-bad="0"></div>`;
};
// Wires every .tbox under `root`; `onChange(name)` runs when its value or its half-started state changes (the hidden input also gets a 'change' event).
function wireTimeBoxes(root, onChange = () => {}) {
  $$('.tbox', root).forEach((box) => {
    const hid = $('input[type=hidden]', box); const th = $('.th', box); const tm = $('.tm', box); const ampm = $$('.tampm button', box);
    const ap = () => { const on = ampm.find((b) => b.getAttribute('aria-pressed') === 'true'); return on ? on.dataset.ap : ''; };
    const lists = $$('.tpart', box).map((part) => ({ input: $('input', part), list: $('.tbox-list', part) }));
    const closeAll = () => lists.forEach(({ input, list }) => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); $$('li.on', list).forEach((x) => x.classList.remove('on')); });
    const openList = (l) => { closeAll(); l.list.hidden = false; l.input.setAttribute('aria-expanded', 'true'); };
    let autoAp = false; // AM/PM was filled in by default (not chosen): taking the hour and minutes back out returns the whole time to blank
    const setAp = (v) => ampm.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.ap === v)));
    const sync = () => {
      if (!ap() && (th.value || tm.value)) { setAp(currentAmPm()); autoAp = true; }
      else if (autoAp && !th.value && !tm.value) { setAp(''); autoAp = false; }
      const { value, bad } = composeTime(th.value, tm.value, ap());
      const changed = hid.value !== value || hid.dataset.bad !== (bad ? '1' : '0');
      hid.value = value; hid.dataset.bad = bad ? '1' : '0';
      th.classList.toggle('bad', bad && !!th.value && !composeTime(th.value, '0', 'AM').value); tm.classList.toggle('bad', bad && !!tm.value && !composeTime('1', tm.value, 'AM').value);
      if (changed) { hid.dispatchEvent(new Event('change')); onChange(hid.name); }
    };
    // choosing an hour fills in :00 so the common case is two taps (hour, AM/PM)
    const afterHour = () => { if (!tm.value && composeTime(th.value, '0', 'AM').value) tm.value = '00'; };
    lists.forEach((l) => {
      const isHour = l.input === th;
      // entering a field selects what is in it, so typing replaces it (a filled-in "00" is overwritten, not appended to)
      // (a list opens only when the person clicks the field or presses an arrow key: never on its own, e.g. when a sheet opens)
      l.input.addEventListener('focus', () => { setTimeout(() => l.input.select(), 0); });
      l.input.addEventListener('click', () => { openList(l); l.input.select(); });
      l.input.addEventListener('input', () => {
        l.input.value = l.input.value.replace(/\D/g, '').slice(0, 2);
        if (isHour) { afterHour(); if (l.input.value.length === 2 || Number(l.input.value) > 1) { if (composeTime(th.value, '0', 'AM').value) tm.focus(); } }
        sync();
      });
      l.input.addEventListener('blur', () => { setTimeout(() => { if (!box.contains(document.activeElement)) closeAll(); }, 120); if (!isHour && l.input.value.length === 1) { l.input.value = l.input.value.padStart(2, '0'); sync(); } });
      l.list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li'); if (!li) return; e.preventDefault();
        l.input.value = li.dataset.v; if (isHour) afterHour(); closeAll(); sync(); if (isHour) tm.focus();
      });
      let at = -1;
      l.input.addEventListener('keydown', (e) => {
        const items = $$('li', l.list);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); if (l.list.hidden) openList(l);
          at = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((x, i) => x.classList.toggle('on', i === at)); items[at].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && !l.list.hidden && at >= 0) { e.preventDefault(); l.input.value = items[at].dataset.v; at = -1; if (isHour) afterHour(); closeAll(); sync(); if (isHour) tm.focus(); }
        else if (e.key === 'Escape' && !l.list.hidden) { e.preventDefault(); e.stopPropagation(); closeAll(); at = -1; }
      });
    });
    ampm.forEach((b) => b.addEventListener('click', () => { autoAp = false; setAp(b.dataset.ap); closeAll(); sync(); }));
    // a tap or click anywhere outside this control closes its lists (whatever focus did); the listener removes itself once the sheet is gone
    const outside = (e) => { if (!box.isConnected) document.removeEventListener('mousedown', outside, true); else if (!box.contains(e.target)) closeAll(); };
    document.addEventListener('mousedown', outside, true);
    box.clear = () => { th.value = ''; tm.value = ''; autoAp = false; setAp(''); closeAll(); sync(); };
  });
}
const typeText = (m) => `${esc(TYPE_LABEL[m.assignment_type] || TYPE_LABEL.permanent)}${m.assignment_type === 'checkout' && m.due_date ? ` · return by ${fmtDate(m.due_date)}${m.due_time ? ' ' + fmtClock(m.due_time) : ''}` : ''}`;
const pill = (status, label) => `<span class="pill ${esc(status)}">${esc(label || STATUS_LABEL[status] || status)}</span>`;
const CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor', 'Broken'];
const thumbHtml = (thumb, cat) => `<div class="thumb">${thumb ? `<img src="/uploads/${esc(thumb)}" alt="" loading="lazy">` : icon(catIcon(cat))}</div>`;
// Active assignments read by kind: permanent -> "Assigned", temporary checkout -> "Temporary checkout" (overdue still wins).
function statusPill(a) {
  const st = assetStatus(a);
  if (st !== 'checked_out') return pill(st);
  const out = [];
  if (a.permanent_holders) out.push(pill('checked_out', 'Assigned'));
  if (a.checkout_holders) out.push(pill('checked_out', 'Temporary checkout'));
  return out.length ? out.join(' ') : pill(st);
}
const assetStatus = (a) => (!['retired', 'lost', 'disposed'].includes(a.status) && isOverdue(a.due_date) ? 'overdue' : a.status);

// ============================================================ sheets (bottom modal)
// `closeX` adds a close button that stays in the sheet's top-right corner on phones while the content scrolls; `dirty` (a function) says whether there are unsaved
// changes: then every user dismissal (X, Close, tapping outside) asks before discarding them. close() itself never asks.
function sheet(html, { onOpen, wide, closeX, dirty } = {}) {
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet${closeX ? ' has-x' : ''}" role="dialog" aria-modal="true" ${wide ? 'style="max-width:720px"' : ''}><div class="grab"></div>${closeX ? `<div class="sheet-x-bar"><button type="button" class="sheet-x" data-close aria-label="Close">${icon('x')}</button></div>` : ''}${html}</div>`;
  root.appendChild(wrap);
  const close = () => { wrap.remove(); document.body.style.overflow = root.children.length ? 'hidden' : ''; }; // (a sheet may sit on top of another)
  const dismiss = () => {
    if (!dirty || !dirty()) return close();
    const s = sheet(`<h2>Discard changes?</h2><p class="muted small" style="margin-top:0">You have changes that are not saved. Closing now discards them.</p><div class="sheet-actions"><button type="button" class="btn" data-close>Keep editing</button><button type="button" class="btn danger" id="discard">Discard changes</button></div>`);
    $('#discard', s.el).onclick = () => { s.close(); close(); };
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) dismiss(); });
  document.body.style.overflow = 'hidden';
  const el = $('.sheet', wrap);
  onOpen && onOpen(el, close);
  const first = $('input:not([type=hidden]):not([type=checkbox]):not(.th):not(.tm), select, textarea', el);
  if (first && window.matchMedia('(min-width: 700px)').matches) setTimeout(() => first.focus(), 50);
  return { el, close };
}
// ============================================================ dropdown menus
// A button that opens a small menu (All assets: Add, Labels, Filter). Items are links ({ href }) or buttons ({ act }, handed to wireDropdowns'
// `acts`). Escape, a click outside, or focus leaving closes it; Arrow keys move between items.
function ddMenu({ id, label, ic, cls = 'btn', items, align = 'left', checked = null, up = false, sub = '' }) {
  const body = items.map((i) => {
    const on = checked !== null && i.v === checked;
    const inner = `${i.ic ? icon(i.ic) : ''}<span>${esc(i.label)}</span>${checked !== null ? (on ? icon('check', 'dd-tick') : '') : ''}`;
    return i.href
      ? `<a role="menuitem" href="${i.href}">${inner}</a>`
      : `<button type="button" role="${checked !== null ? 'menuitemradio' : 'menuitem'}" ${checked !== null ? `aria-checked="${on}"` : ''} data-act="${i.act}" ${i.v !== undefined ? `data-v="${esc(i.v)}"` : ''}>${inner}</button>`;
  }).join('');
  return `<div class="dd ${align === 'right' ? 'dd-right' : ''} ${up ? 'dd-up' : ''}" id="${id}"><button type="button" class="${cls} dd-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-menu">${ic ? icon(ic) : ''}<span class="dd-label">${esc(label)}</span>${sub ? `<span class="dd-sub">${esc(sub)}</span>` : ''}${icon('chev', 'dd-caret')}</button>
    <div class="menu dd-menu" id="${id}-menu" role="menu" aria-label="${esc(label)}" hidden>${body}</div></div>`;
}
function setDropdown(dd, open, focusFirst = false) {
  const m = $('.dd-menu', dd); const b = $('.dd-btn', dd); if (!m || !b) return;
  m.hidden = !open; b.setAttribute('aria-expanded', String(open)); dd.classList.toggle('open', open);
  if (open && focusFirst) ($('[role^=menuitem]', m) || m).focus();
}
function wireDropdowns(root, acts = {}) {
  $$('.dd', root).forEach((dd) => {
    const b = $('.dd-btn', dd);
    b.onclick = (e) => { const open = !dd.classList.contains('open'); $$('.dd.open').forEach((o) => o !== dd && setDropdown(o, false)); setDropdown(dd, open, open && e.detail === 0); };
    // (stopPropagation: the document-level arrow handler below would otherwise step on to the second item right away)
    b.onkeydown = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); $$('.dd.open').forEach((o) => o !== dd && setDropdown(o, false)); setDropdown(dd, true, true); } };
    $('.dd-menu', dd).onclick = (e) => {
      const it = e.target.closest('[role^=menuitem]'); if (!it) return;
      setDropdown(dd, false);
      if (it.dataset.act && acts[it.dataset.act]) acts[it.dataset.act](it.dataset.v, { keyboard: e.detail === 0 });
    };
  });
  if (wireDropdowns.done) return;
  wireDropdowns.done = true; // document-level listeners are registered once, however many pages are built
  document.addEventListener('click', (e) => { $$('.dd.open').forEach((dd) => { if (!dd.contains(e.target)) setDropdown(dd, false); }); });
  document.addEventListener('focusin', (e) => { $$('.dd.open').forEach((dd) => { if (!dd.contains(e.target)) setDropdown(dd, false); }); });
  document.addEventListener('keydown', (e) => {
    const dd = $('.dd.open'); if (!dd) return;
    if (e.key === 'Escape') { e.preventDefault(); setDropdown(dd, false); $('.dd-btn', dd).focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = $$('[role^=menuitem]', dd); if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)].focus();
  });
}
function confirmSheet(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const { el, close } = sheet(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`);
    $('#ok', el).onclick = () => { close(); resolve(true); };
    el.closest('.sheet-backdrop').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.classList.contains('sheet-backdrop')) resolve(false); });
  });
}

// ============================================================ barcode scanner
// One camera overlay at a time (a second would fight for the camera). html5-qrcode draws the only
// scan window (its shaded box) and decodes exactly that box, but it assumes its <video> shows the whole stream at the size it
// measured: .qr-reader is therefore left to size the video itself and the overlay only centres it (see .scanner in app.css).
let activeScanner = null;
let scanChain = Promise.resolve(); // every scanner's start / stop, one after another: a new camera never starts while the previous one is still being released
let scanSeq = 0;
function openScanner({ title = 'Scan a barcode', hint = 'Point the camera at the barcode or QR code', onResult }) {
  if (!canScan()) return; // never start the camera for someone without scanner access
  if (activeScanner) activeScanner.close();
  const readerId = 'qr-reader-' + (++scanSeq); // unique per overlay: the old one may still be on screen while it is released
  const wrap = document.createElement('div');
  wrap.className = 'scanner';
  wrap.innerHTML = `
    <div class="sc-top"><button class="iconbtn" id="sc-close" aria-label="Close">${icon('x')}</button>
      <strong>${esc(title)}</strong><button class="iconbtn" id="sc-torch" aria-label="Flashlight" style="visibility:hidden">${icon('flash')}</button></div>
    <div class="sc-view"><div id="${readerId}" class="qr-reader"></div><div class="sc-hint">${esc(hint)}</div></div>
    <div class="sc-bottom"><form class="input-group" id="sc-form"><input id="sc-manual" placeholder="Or type the tag / serial number" autocomplete="off" autocapitalize="characters" enterkeyhint="go"><button class="btn primary">Go</button></form></div>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  let scanner = null; let done = false; let failed = false; let closing = null; let restarts = 0;
  const enqueue = (fn) => (scanChain = scanChain.then(fn, fn));

  const showErr = (msg) => { failed = true; $('.sc-view', wrap).innerHTML = `<div class="sc-err"><div>${icon('camera')}<p style="margin-top:10px">${msg}</p><p class="small" style="opacity:.7">You can still type the tag below, or use a USB/Bluetooth barcode scanner.</p></div></div>`; setTimeout(() => $('#sc-manual', wrap)?.focus(), 50); };

  // Releases the camera: the library's stop(), then every track it may have left running (a failed stop() used to be swallowed
  // and left the camera on, so the next scanner could not get it).
  const release = async () => {
    const s = scanner; scanner = null;
    if (!s) return;
    const tracks = [...wrap.querySelectorAll('video')].flatMap((v) => (v.srcObject && v.srcObject.getTracks ? v.srcObject.getTracks() : []));
    try { if (s.isScanning) await s.stop(); } catch (e) { console.warn('Scanner stop failed:', e); }
    try { s.clear(); } catch { /* nothing rendered */ }
    tracks.forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
  };

  const begin = () => enqueue(async () => {
    if (done || failed || scanner) return;
    if (!window.isSecureContext) return showErr('The camera needs a secure (https://) connection.');
    if (!window.Html5Qrcode) return showErr('Scanner is still loading — try again in a second.');
    const F = window.Html5QrcodeSupportedFormats;
    const formats = [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX].filter((x) => x !== undefined);
    let s;
    try { s = new window.Html5Qrcode(readerId, { formatsToSupport: formats, verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } }); } catch (e) { console.warn('Scanner init failed:', e); return showErr('Could not start the scanner.'); }
    scanner = s;
    try {
      await s.start({ facingMode: 'environment' }, {
        fps: 12,
        // w x h is the video as it is really shown, so this box is both what is drawn and what is decoded.
        qrbox: (w, h) => ({ width: Math.max(60, Math.floor(Math.min(w * 0.82, 380))), height: Math.max(60, Math.floor(Math.min(w * 0.46, 210, h * 0.5))) }),
        videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      }, (text) => finish(text), () => {});
    } catch (err) {
      console.warn('Scanner start failed:', err);
      await release();
      const m = String(err && (err.message || err));
      return showErr(/NotAllowed|Permission/i.test(m) ? 'Camera access was blocked. Allow camera access for this site in your browser settings.' : /NotFound|Requested device not found/i.test(m) ? 'No camera was found on this device.' : 'Could not open the camera.');
    }
    try {
      const caps = s.getRunningTrackCapabilities && s.getRunningTrackCapabilities();
      const torch = $('#sc-torch', wrap);
      if (caps && caps.torch && torch) {
        torch.style.visibility = 'visible'; let on = false;
        torch.onclick = () => { on = !on; s.applyVideoConstraints({ advanced: [{ torch: on }] }).catch((e) => console.warn('Flashlight:', e)); };
      }
    } catch { /* no torch control */ }
    // The camera can be taken away while the overlay stays open (another app, a call): open a fresh one rather than show a frozen picture.
    const track = [...wrap.querySelectorAll('video')].map((v) => v.srcObject && v.srcObject.getVideoTracks && v.srcObject.getVideoTracks()[0]).find(Boolean);
    if (track) track.addEventListener('ended', () => { if (!done && scanner === s && restarts++ < 3) enqueue(release).then(begin); });
  });

  // iOS suspends the camera when the page goes to the background and the old stream never recovers: let go of it, open a new one on return.
  const onVisibility = () => { if (done) return; if (document.hidden) enqueue(release); else begin(); };
  const close = () => closing || (closing = (async () => {
    done = true; if (activeScanner === handle) activeScanner = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('hashchange', onRoute);
    wrap.style.display = 'none';
    await enqueue(release);
    wrap.remove();
    if (!$('.scanner')) document.body.style.overflow = ''; // (a newer overlay keeps the page locked)
  })());
  const finish = (code) => {
    if (done) return;
    done = true; // first result wins: later frames, the manual box and Close can no longer act
    try { navigator.vibrate && navigator.vibrate(60); } catch { /* */ }
    close().then(() => onResult(String(code).trim())).catch((e) => console.error('Scan result handler failed:', e));
  };
  document.addEventListener('visibilitychange', onVisibility);
  const route0 = location.hash.split('?')[0];
  const onRoute = () => { if (location.hash.split('?')[0] !== route0) close(); }; // a page change (Back, a link) must not leave the camera running behind the next page
  window.addEventListener('hashchange', onRoute);
  $('#sc-close', wrap).onclick = () => close();
  $('#sc-form', wrap).onsubmit = (e) => { e.preventDefault(); const v = $('#sc-manual', wrap).value.trim(); if (v) finish(v); };
  const handle = { close };
  activeScanner = handle;
  begin();
  return handle;
}

// A scanned (or typed, or keyboard-wedge) code opens its asset: lookup matches the asset tag, then the serial number. Any value is
// accepted; no tag format or prefix is assumed. One of our own labels printed before its asset opens Add asset with that tag (IT). Any
// other code no asset uses shows "No asset found for <code>" with Scan again, and for IT Add asset with the code as the serial number or
// as the tag (nothing is saved until they submit it). A failed lookup is an error, never "not found".
async function handleScannedCode(code, ctx = '') { // ctx: where the asset page should say it came from (the Scan page passes srcQ('scan'))
  let r;
  try { r = await api('GET', '/api/assets/lookup/' + encodeURIComponent(code)); } catch (e) { return fail(e); }
  if (r.found) return go('#/asset/' + r.id + ctx);
  if (r.unavailable) return toast("That item isn't available right now. You can request something similar from IT.", true);
  // IT: one of our labels printed before its asset (Create labels / Print label) goes straight to Add asset with that tag.
  if (r.issued && isAdmin()) return go('#/new?tag=' + encodeURIComponent(r.issued));
  // Anything else: "No asset found". For IT a maker's barcode is usually the serial number, so Add asset offers it as the serial first and
  // as the tag second (docs/briefs/labels-and-assets.md).
  const { el, close } = sheet(`<h2 style="overflow-wrap:anywhere">No asset found for <span class="mono">${esc(code)}</span></h2>
    ${isAdmin() ? '<p class="muted" style="margin:6px 0 0">A maker\'s barcode is usually the serial number.</p>' : ''}
    <div class="stack" style="margin-top:16px">${isAdmin() ? `<button class="btn primary lg block" id="mks">${icon('plus')} Add asset with this serial number</button>
    <button class="btn block" id="mk">${icon('tag')} Add asset with this as its tag</button>` : ''}
    <button class="btn block" id="again">${icon('scan')} Scan again</button></div>`);
  const mks = $('#mks', el);
  if (mks) mks.onclick = () => { close(); go('#/new?serial=' + encodeURIComponent(code)); };
  const mk = $('#mk', el);
  if (mk) mk.onclick = () => { close(); go('#/new?tag=' + encodeURIComponent(code)); };
  $('#again', el).onclick = () => { close(); openScanner({ onResult: (c) => handleScannedCode(c, ctx) }); };
}

// ============================================================ shell / navigation
function navItems() {
  const req = S.badge || 0;
  const common = [
    { key: 'home', href: '#/home', label: 'Home', icon: 'home' },
    { key: 'assets', href: '#/assets', label: isAdmin() ? 'Assets' : 'Browse', icon: 'box' },
    ...(canScan() ? [{ key: 'scan', href: '#/scan', label: 'Scan', icon: 'scan', scan: true }] : []),
    { key: 'requests', href: '#/requests', label: 'Requests', icon: 'inbox', badge: req },
    { key: 'account', href: '#/account', label: 'Profile', icon: 'user' }, // the signed-in person (My equipment / History / My profile / Sign out)
  ];
  const side = [
    { key: 'home', href: '#/home', label: 'Home', icon: 'home' },
    ...(isAdmin() ? [] : [{ key: 'equipment', href: '#/equipment', label: 'My equipment', icon: 'laptop' }]),
    { key: 'assets', href: '#/assets', label: isAdmin() ? 'All assets' : 'Browse equipment', icon: 'box' },
    // IT's labels live under All assets (docs/briefs/labels-and-assets.md): reprint for saved assets, or numbered blanks before them
    ...(isAdmin() ? [{ key: 'labels', href: '#/labels', label: 'Print labels', icon: 'printer', sub: true }, { key: 'labels-new', href: '#/labels/new', label: 'Create labels', icon: 'plus', sub: true },
      { key: 'locations', href: '#/locations', label: 'Locations', icon: 'pin', sub: true }] : []),
    ...(canScan() ? [{ key: 'scan', href: '#/scan', label: 'Scan', icon: 'scan' }] : []),
    { key: 'requests', href: '#/requests', label: 'Requests', icon: 'inbox', badge: req },
    ...(isAdmin() ? [] : [{ key: 'history', href: '#/history', label: 'History', icon: 'history' }]),
  ];
  if (isAdmin()) side.push({ sep: true },
    { key: 'people', href: '#/people', label: 'People', icon: 'users' },
    { key: 'calendar', href: '#/calendar', label: 'Calendar', icon: 'calendar' },
    { key: 'import', href: '#/import', label: 'Import / export', icon: 'upload' },
    { key: 'activity', href: '#/activity', label: 'Activity log', icon: 'history' });
  side.push({ sep: true }, { key: 'profile', href: '#/profile', label: 'My profile', icon: 'user' },
    ...(isAdmin() ? [{ key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings', foot: true }] : [])); // desktop: pinned to the bottom of the sidebar, above Appearance
  return { tabs: common, side };
}
// Mobile hamburger (admins only) = administering the system. The signed-in person's own destinations live under the Profile tab.
const adminMenuItems = () => [
  { key: 'people', href: '#/people', label: 'People', icon: 'users' },
  { key: 'locations', href: '#/locations', label: 'Locations', icon: 'pin' },
  { key: 'calendar', href: '#/calendar', label: 'Calendar', icon: 'calendar' },
  { key: 'labels', href: '#/labels', label: 'Print labels', icon: 'printer' },
  { key: 'labels-new', href: '#/labels/new', label: 'Create labels', icon: 'plus' },
  { key: 'import', href: '#/import', label: 'Import / export', icon: 'upload' },
  { key: 'activity', href: '#/activity', label: 'Activity log', icon: 'history' },
]; // (Settings is under the Profile tab and the avatar menu, with My profile)
// The drawer lives in #sheet-root like every other overlay, so the router's existing "clear overlays on navigation" also closes it.
function closeDrawer() {
  $('#sheet-root .drawer-backdrop')?.remove(); document.body.style.overflow = '';
}
function openDrawer() {
  if (!isAdmin() || $('#sheet-root .drawer-backdrop')) return;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop drawer-backdrop';
  wrap.innerHTML = `<nav class="drawer" role="dialog" aria-modal="true" aria-label="Administration" tabindex="-1">
    <div class="drawer-head"><strong class="grow">Administration</strong><button type="button" class="iconbtn" id="drawer-close" aria-label="Close menu">${icon('x')}</button></div>
    <div class="drawer-links">${adminMenuItems().map((i) => `<a href="${i.href}" data-key="${i.key}"${i.key === 'calendar' ? ' data-cal' : ''} class="${i.key === S.activeKey ? 'active' : ''}">${icon(i.icon)}<span>${i.label}</span></a>`).join('')}</div></nav>`;
  $('#sheet-root').appendChild(wrap);
  document.body.style.overflow = 'hidden';
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('#drawer-close') || e.target.closest('a')) closeDrawer(); }); // a link to the page you're already on fires no route change, so close explicitly
  $('.drawer', wrap).focus();
}
function mountShell() {
  const { tabs, side } = navItems();
  const sideLink = (i) => i.sep ? '<div class="sep"></div>' : `<a href="${i.href}" data-key="${i.key}"${i.sub ? ' class="sub"' : ''}${i.key === 'calendar' ? ' data-cal' : ''}>${icon(i.icon)}<span>${i.label}</span>${i.key === 'assets' && isAdmin() ? icon('chev', 'nav-caret') : ''}${i.badge ? `<span class="count">${i.badge}</span>` : ''}</a>`;
  $('#app').innerHTML = `
    <header class="topbar">
      ${isAdmin() ? `<button type="button" class="iconbtn nav-toggle" id="nav-toggle" aria-label="Open administration menu" aria-haspopup="dialog">${icon('menu')}</button>` : ''}
      <a href="#/home" class="row" style="gap:10px"><img src="/logo-white.png" alt="Nutricost" class="logo"><span class="app-name">${isAdmin() ? 'IT Admin' : 'Employee Portal'}</span></a>
      <span class="spacer"></span>
      ${canScan() ? `<a href="#/scan" class="iconbtn desk-only" title="Scan">${icon('scan')}</a>` : ''}
      <div class="menu-wrap"><button type="button" class="avatar sm" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(S.me.name)}" style="background:var(--brand-accent);border:0;cursor:pointer">${esc(initials(S.me.name))}</button>
        <div class="menu" id="avatar-menu" role="menu" hidden><div class="menu-who"><strong>${esc(S.me.name)}</strong><div class="small muted">${esc(S.me.email || '')}</div></div>
          <a href="#/profile" role="menuitem">${icon('user')} My profile</a>${isAdmin() ? `<a href="#/settings" role="menuitem">${icon('settings')} Settings</a>` : ''}<button type="button" role="menuitem" id="signout">${icon('logout')} Sign out</button></div></div>
    </header>
    <div class="shell">
      <nav class="sidebar" aria-label="Main"><div class="side-main">${side.filter((i) => !i.foot).map(sideLink).join('')}</div><div class="side-foot">${side.filter((i) => i.foot).map(sideLink).join('')}<div id="themeslot"></div></div></nav>
      <main id="main"></main>
    </div>
    <nav class="tabbar">${tabs.map((t) => `<a href="${t.href}" data-key="${t.key}" class="${t.scan ? 'scan-tab' : ''}">${t.scan ? `<span class="scan-bubble">${icon('scan')}</span>` : icon(t.icon)}<span>${t.label}</span>${t.badge ? `<span class="badge-dot">${t.badge}</span>` : ''}</a>`).join('')}</nav>`;
  const paintTheme = () => {
    const cur = getTheme();
    $('#themeslot').innerHTML = ddMenu({ id: 'ddtheme', label: 'Appearance', ic: 'sun', cls: 'side-link', up: true, checked: cur, sub: (THEMES.find(([v]) => v === cur) || THEMES[0])[1], items: THEMES.map(([v, l]) => ({ act: 'theme', v, label: l })) });
    // focus goes back to the button only after a keyboard choice (a mouse choice would otherwise show the keyboard focus ring)
    wireDropdowns($('#themeslot'), { theme: (v, how) => { setTheme(v); paintTheme(); if (how.keyboard) $('#ddtheme .dd-btn').focus(); } });
  };
  paintTheme();
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
  setTopbarH(); window.addEventListener('resize', setTopbarH);
  if (isAdmin()) $('#nav-toggle').onclick = openDrawer;
  const menu = $('#avatar-menu'); const btn = $('#avatar-btn');
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
  menu.onclick = (e) => { if (e.target.closest('a')) setMenu(false); };
  if (!S.menuWired) { // document-level listeners are registered once, however many times the shell is rebuilt
    S.menuWired = true;
    const live = () => ({ m: $('#avatar-menu'), b: $('#avatar-btn') });
    const closeLive = () => { const { m, b } = live(); if (m && !m.hidden) { m.hidden = true; b.setAttribute('aria-expanded', 'false'); } };
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeLive(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeLive(); closeDrawer(); } });
    window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => { if (e.matches) closeDrawer(); }); // the sidebar takes over on wide screens
  }
  $('#signout').onclick = () => { setMenu(false); logout(); };
  S.shell = true;
}
const ACCOUNT_KEYS = ['account', 'profile', 'equipment', 'history'];
function setActive(key) {
  S.activeKey = key;
  const tabKey = ACCOUNT_KEYS.includes(key) || key === 'settings' ? 'account' : key.startsWith('labels') || key === 'locations' ? 'assets' : key; // the Profile tab covers the person's own pages; the label pages sit under Assets
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.key === tabKey));
  $$('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
  $('.sidebar')?.classList.toggle('assets-open', ['assets', 'labels', 'labels-new', 'locations'].includes(key)); // All assets' sub-items show while you are in it
}
async function refreshBadge() {
  try {
    const rows = await api('GET', '/api/requests?status=open');
    // For an employee the badge means "IT is waiting on you": a return IT asked for, not one they started themselves.
    const live = (r) => r.status === 'open' || r.status === 'dropped_off';
    let returns = isAdmin() ? rows.filter((r) => r.type !== 'equipment' && live(r)).length : rows.filter((r) => r.type === 'return' && r.status === 'open' && !r.self_initiated).length;
    let equipment = isAdmin() ? rows.filter((r) => r.type === 'equipment' && live(r)).length : 0; // (the older item requests; the new ones are counted below)
    let reservations = 0;
    // IT: reservations waiting for approval + everyone currently on a waitlist. Employee: offers waiting for their answer. Active items only, never history.
    try { reservations = (await api('GET', '/api/reservation-counts')).attention; } catch { /* the badge is best-effort */ }
    // Equipment requests: IT = requests waiting on IT; an employee = equipment ready for them (its own sidebar entry; the Requests tab counts it too)
    try { equipment += (await api('GET', '/api/equipment-request-counts')).attention; } catch { /* best-effort */ }
    const n = returns + equipment + reservations;
    S.cnt = { equipment, returns, reservations }; S.badge = n;
    for (const [k, label] of [['equipment', 'Equipment'], ['returns', 'Returns'], ['reservations', 'Reservations']]) { const b = $(`#cats [data-v=${k}]`); if (b) b.innerHTML = `${label}${S.cnt[k] ? ` <span class="seg-count">${S.cnt[k]}</span>` : ''}`; }
    const tab = $('.tabbar a[data-key=requests]');
    if (tab) { $('.badge-dot', tab)?.remove(); if (n) tab.insertAdjacentHTML('beforeend', `<span class="badge-dot">${n}</span>`); }
    const put = (key, v) => { const a = $(`.sidebar a[data-key=${key}]`); if (a) { $('.count', a)?.remove(); if (v) a.insertAdjacentHTML('beforeend', `<span class="count">${v}</span>`); } };
    put('requests', n);
  } catch { /* */ }
}
const main = () => $('#main');
const loading = () => { main().innerHTML = '<div class="spinner"></div>'; };
const backLink = (href, label = 'Back', exact = false) => `<a class="back" href="${esc(href)}"${exact ? '' : ' data-hist'}>${icon('back')}${esc(label)}</a>`;
// A non-exact Back goes back in the browser history when there is one, else follows its href. (A listener, not an inline onclick:
// the Content-Security-Policy allows no inline script.)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.back[data-hist]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || history.length <= 1) return;
  e.preventDefault();
  history.back();
});
// A read-only link field selects all of itself on click, ready to copy.
document.addEventListener('click', (e) => { const f = e.target.closest && e.target.closest('input[data-select-all]'); if (f) f.select(); });

// ---- where an asset page was opened from ----
// Every link to an asset page from a list that matters carries its origin in the hash (#/asset/44?src=catalog&node=11), so the
// page's "‹ Back" can name and return to exactly where the person came from — without relying on browser history, which stays
// free to do its own thing. Only known source types and numeric node ids are accepted; the label shown is derived from real app
// data (a catalog node's stored name), never from query text. No source (a scan, a typed URL, an old link) = the old fallback.
const SRC_BY_ROLE = { admin: ['assets', 'catalog', 'requests', 'home', 'scan', 'person', 'activity', 'calendar'], employee: ['browse', 'equipment', 'history', 'requests', 'home', 'scan', 'calendar'] };
const srcQ = (src, extra = {}) => `?src=${src}${Object.entries(extra).filter(([, v]) => v).map(([k, v]) => `&${k}=${v === true ? 1 : encodeURIComponent(v)}`).join('')}`;
function assetCtx() {
  const p = qs(); const src = p.get('src');
  if (!(SRC_BY_ROLE[isAdmin() ? 'admin' : 'employee'] || []).includes(src)) return null;
  const num = (k) => { const n = Number(p.get(k)); return Number.isInteger(n) && n > 0 ? n : null; };
  // `from=#/settings` rides along only when the catalog itself was opened from Settings: the asset's Back then returns to the catalog WITH it.
  return { src, node: num('node'), id: num('id'), all: p.get('all') === '1', status: src === 'catalog' && STATUS_CHIPS.some(([v]) => v && v === p.get('status')) ? p.get('status') : null, tab: ['open', 'closed'].includes(p.get('tab')) ? p.get('tab') : null, fromSettings: src === 'catalog' && p.get('from') === '#/settings' };
}
const ctxQuery = () => { const c = assetCtx(); return c ? srcQ(c.src, { node: c.node, id: c.id, all: c.all, status: c.status, tab: c.tab, from: c.fromSettings ? '#/settings' : null }) : ''; }; // carried on to the edit form and back
async function assetBackTarget() {
  const c = assetCtx();
  const fallback = { href: '#/assets', label: isAdmin() ? 'Assets' : 'Browse equipment', exact: false }; // existing behavior when there is no (valid) source
  if (!c) return fallback;
  // From the availability calendar: back to the same calendar (non-exact = browser Back, which also restores its month and day).
  if (c.src === 'calendar') return { href: `#/calendar${c.node ? '?node=' + c.node : ''}`, label: 'Calendar', exact: false };
  const fixed = { assets: ['#/assets', isAdmin() ? 'All assets' : 'Assets'], equipment: ['#/equipment', 'My equipment'], history: ['#/history', 'History'], home: ['#/home', 'Home'], scan: ['#/scan', 'Scan'], activity: ['#/activity', 'Activity log'] };
  if (fixed[c.src]) return { href: fixed[c.src][0], label: fixed[c.src][1], exact: true };
  if (c.src === 'requests') return { href: `#/requests${c.tab ? '?tab=' + c.tab : ''}`, label: 'Requests', exact: true };
  if (c.src === 'person') { // an admin's employee page: back to that person, labelled with their real name
    if (!c.id) return { href: '#/people', label: 'People', exact: true };
    try { const u = (await api('GET', '/api/users/' + c.id)).user; return { href: `#/person/${c.id}`, label: u.name, exact: true }; } catch { return { href: '#/people', label: 'People', exact: true }; }
  }
  // catalog (admin) / browse (employee): back to the exact node, labelled with that node's real name
  // The catalog keeps its Settings source and its status filter (All assets > Filter), so Back lands on the same filtered list.
  const catFrom = (href) => { const x = [...(c.status ? [`status=${c.status}`] : []), ...(c.fromSettings ? [`from=${encodeURIComponent('#/settings')}`] : [])]; return x.length ? `${href}${href.includes('?') ? '&' : '?'}${x.join('&')}` : href; };
  // ('catalog' = IT's All assets page, which is the catalog drill-down since docs/briefs/labels-and-assets.md)
  const root = c.src === 'catalog' ? { href: catFrom('#/assets'), label: 'All assets' } : { href: c.all ? '#/assets?all=1' : '#/assets', label: c.all ? 'All equipment' : 'Browse equipment' };
  if (!c.node) return { ...root, exact: true };
  let rows = []; try { rows = await api('GET', '/api/catalog' + (c.src === 'catalog' ? '?include_archived=1' : '')); } catch { /* fall back to the root */ }
  const n = rows.find((r) => r.id === c.node);
  if (!n) return { ...root, exact: true };
  // Opened from a virtual "All in <name>" view (admin catalog &all=1; employee Browse, where an entry with children always shows its
  // whole branch): say so. The URL is the same real-entry route — "All in" is never a stored entry.
  const virtual = c.src === 'catalog' ? c.all : n.child_count > 0;
  return { href: c.src === 'catalog' ? catFrom(`#/assets?node=${n.id}${c.all ? '&all=1' : ''}`) : `#/assets?node=${n.id}`, label: virtual ? `All in ${n.name}` : n.name, exact: true };
}

// ============================================================ router
const ROUTES = [
  [/^#\/login$/, viewLogin, { pub: true }],
  [/^#\/forgot$/, viewForgot, { pub: true }],
  [/^#\/reset\/([\w-]+)$/, viewReset, { pub: true }],
  [/^#\/setup$/, viewSetup, { pub: true }],
  [/^#\/home$/, viewHome, { key: 'home' }],
  [/^#\/assets$/, viewAssets, { key: 'assets' }],
  [/^#\/asset\/(\d+)$/, viewAsset, { key: 'assets' }],
  [/^#\/asset\/(\d+)\/edit$/, viewAssetForm, { key: 'assets', admin: true }],
  [/^#\/new$/, viewAssetForm, { key: 'assets', admin: true }],
  [/^#\/scan$/, viewScan, { key: 'scan', scan: true }],
  [/^#\/requests$/, viewRequests, { key: 'requests' }],
  [/^#\/calendar$/, viewCalendar, { key: 'calendar' }],
  // the earlier separate screens now live under Requests (Equipment | Returns | Reservations); old links and emails land there
  [/^#\/my-reservations$/, () => { history.replaceState(null, '', '#/requests?cat=reservations'); return route(true); }, { key: 'requests' }],
  [/^#\/my-requests$/, () => { history.replaceState(null, '', '#/requests?cat=equipment'); return route(true); }, { key: 'requests' }],
  [/^#\/equipment-requests$/, () => { history.replaceState(null, '', '#/requests?cat=equipment'); return route(true); }, { key: 'requests' }],
  [/^#\/people$/, viewPeople, { key: 'people', admin: true }],
  [/^#\/person\/(\d+)$/, viewPerson, { key: 'people', admin: true }],
  [/^#\/labels$/, viewLabels, { key: 'labels', admin: true }],
  [/^#\/labels\/new$/, viewCreateLabels, { key: 'labels-new', admin: true }],
  [/^#\/locations$/, viewLocations, { key: 'locations', admin: true }],
  // The equipment catalog is All assets since docs/briefs/labels-and-assets.md: old links (bookmarks, Settings) land there, same entry
  [/^#\/catalog$/, () => { history.replaceState(null, '', '#/assets' + (location.hash.split('?')[1] ? '?' + location.hash.split('?')[1] : '')); return route(true); }, { key: 'assets', admin: true }],
  [/^#\/import$/, viewImport, { key: 'import', admin: true }],
  [/^#\/activity$/, viewActivity, { key: 'activity', admin: true }],
  [/^#\/settings$/, viewSettings, { key: 'settings', admin: true }],
  [/^#\/equipment$/, viewEquipment, { key: 'equipment', employee: true }],
  [/^#\/history$/, viewHistory, { key: 'history' }],
  [/^#\/profile$/, viewProfile, { key: 'profile' }],
  [/^#\/account$/, viewAccount, { key: 'account' }],
  [/^#\/more$/, () => go('#/account'), { key: 'account' }], // the old bottom-nav "More" page: bookmarks land on the Profile tab, which replaced its personal half
];
// ---- "‹ Back" on every page (owner, 2026-10-27) ----
// The trail of in-app pages: each entry is a page left for another one, with the title it showed (its h1), so "‹ Back" can say where it
// goes ("‹ Monitor", "‹ Dell Latitude 5440"). Following it (or browser Back) to the page on top of the trail pops it. Pages with their own
// contextual back link (an asset, a form, a catalog level) keep theirs; every other page gets this one (ensureBack, after its view).
S.trail = [];
// Top-level pages are named as in the menu (Home's h1 is a greeting); a page inside them (an asset, a person, a catalog level) by its title.
const PAGE_NAMES = () => ({ '#/home': 'Home', '#/assets': isAdmin() ? 'All assets' : 'Browse equipment', '#/scan': 'Scan', '#/requests': 'Requests', '#/people': 'People', '#/calendar': 'Calendar',
  '#/labels': 'Print labels', '#/labels/new': 'Create labels', '#/locations': 'Locations', '#/import': 'Import / export', '#/activity': 'Activity log', '#/settings': 'Settings', '#/profile': 'My profile',
  '#/equipment': 'My equipment', '#/history': 'History', '#/account': 'Profile', '#/new': 'Add an asset' });
function noteNavigation(next) {
  const cur = S.cur;
  S.cur = { hash: next };
  if (!cur || cur.hash === next) return;
  const top = S.trail.at(-1);
  if (top && top.hash === next) { S.trail.pop(); return; }
  const [base, query = ''] = cur.hash.split('?');
  const title = (!/(^|&)node=/.test(query) && PAGE_NAMES()[base]) || ($('#main h1') && $('#main h1').textContent.trim()) || 'Back';
  S.trail.push({ hash: cur.hash, label: title.length > 40 ? title.slice(0, 39) + '…' : title });
  if (S.trail.length > 30) S.trail.shift();
}
// The back link for a page without its own: the previous page, else Home (nothing on Home itself).
function autoBack() {
  const t = S.trail.at(-1);
  if (t) return backLink(t.hash, t.label, true);
  return (location.hash || '#/home').split('?')[0] === '#/home' ? '' : backLink('#/home', 'Home', true);
}
function ensureBack() {
  const m = main();
  if (!m || m.querySelector('.back')) return;
  const html = autoBack(); if (!html) return;
  const slot = m.querySelector('#backslot');
  if (slot) slot.innerHTML = html; else m.insertAdjacentHTML('afterbegin', `<div class="auto-back">${html}</div>`);
}
// A page that is opened fades in (a level / filter change on the same page: the lighter `soft` fade); nothing when the OS asks for
// reduced motion (CSS). The class is removed and re-added so the animation runs again each time.
function animateIn(el, kind = 'page') {
  if (!el) return;
  el.classList.remove('page-in', 'soft-in'); void el.offsetWidth; el.classList.add(kind === 'soft' ? 'soft-in' : 'page-in');
}

async function route(silent) {
  S.soft = null; // a route-backed screen registers itself again below
  const hash = (location.hash || '#/home').split('?')[0];
  const match = ROUTES.find(([re]) => re.test(hash));
  if (!match) return go('#/home');
  const [re, view, opt] = match;
  const params = hash.match(re).slice(1);
  if (!opt.pub) {
    if (!S.me) {
      try { await loadMe(); } catch { return go('#/login'); }
    }
    if (opt.admin && !isAdmin()) return go('#/home');
    if (opt.employee && isAdmin()) return go('#/home'); // the admin's own equipment stays on their Home
    if (opt.scan && !canScan()) return go('#/home'); // direct navigation to the scanner without access
    if (!S.shell) { mountShell(); refreshBadge(); }
    noteNavigation(location.hash || '#/home'); // (before the spinner replaces the page being left: its title names the way back)
    setActive(opt.key);
    if (!silent) { window.scrollTo(0, 0); loading(); }
  } else { S.shell = false; S.trail = []; S.cur = null; } // signed out / sign-in screens: a fresh trail
  S.silent = !!silent;
  $('#sheet-root').innerHTML = ''; document.body.style.overflow = '';
  try { await view(...params); } catch (e) { if (main()) main().innerHTML = `<div class="empty">${icon('alert')}<p>${esc(e.message)}</p></div>`; else fail(e); }
  if (!opt.pub) { ensureBack(); if (!silent) animateIn(main()); }
}
async function loadMe() {
  const r = await api('GET', '/api/me');
  S.me = r.user; S.settings = r.settings; S.mailConfigured = r.mailConfigured; S.appTimezone = r.appTimezone || '';
}
// Route-backed drill-down screens (Browse equipment, Equipment catalog) keep their state in the hash query (#/catalog?node=12).
// A change that stays on the same screen is applied in place — no reload, no flicker — by the screen's own `S.soft.fn`; anything
// else goes through the normal router. Because the URL is the single source of truth, the sidebar link, breadcrumbs, the Back
// button, browser Back/Forward and a refresh all land on the same state, and nothing stale can survive.
window.addEventListener('hashchange', () => {
  const base = (location.hash || '').split('?')[0];
  if (S.soft && S.soft.base === base && $('#main')) {
    $('#sheet-root').innerHTML = ''; document.body.style.overflow = '';
    noteNavigation(location.hash); // a level of the same page is a page of its own for "‹ Back"
    const r = S.soft.fn(); animateIn($('#ct') || main(), 'soft'); return r;
  }
  route();
});

// ============================================================ auth views
// Google's "G" mark, as its sign-in branding guidelines ask for on a "Sign in with Google" button.
const GOOGLE_MARK = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
function authPanel(inner) {
  $('#app').innerHTML = `<div class="auth"><div class="panel"><div class="brand"><img class="logo-light" src="/logo.png" alt="Nutricost"><img class="logo-dark" src="/logo-white.png" alt="" aria-hidden="true"><div>IT Asset Tracker</div></div>${inner}</div></div>`;
}
// Google sign-in (src/server.js /auth/google) comes back to #/login?error=<code> when it is refused.
const GOOGLE_ERRORS = {
  no_access: 'This Google account does not have access to this app. Ask IT to add you.',
  unverified: 'That Google account\'s email is not verified.',
  cancelled: 'Google sign-in was cancelled.',
  too_many: 'Too many attempts. Try again in 15 minutes.',
};
async function viewLogin() {
  try { const s = await api('GET', '/api/setup-needed'); if (s.needed && s.rule !== 'closed') return go('#/setup'); } catch { /* */ } // closed: the login page (first-run setup is closed in production without SETUP_TOKEN)
  let google = false;
  try { google = (await api('GET', '/api/auth-options')).google; } catch { /* the password form still works */ }
  const code = new URLSearchParams((location.hash.split('?')[1] || '')).get('error');
  const error = code ? GOOGLE_ERRORS[code] || 'Google sign-in did not work. Try again, or sign in with your password.' : '';
  authPanel(`${error ? `<div class="banner warn" style="margin-bottom:14px">${icon('alert')}<div>${esc(error)}</div></div>` : ''}
    ${google ? `<a href="/auth/google" class="btn lg block google-btn">${GOOGLE_MARK} Sign in with Google</a><div class="auth-or"><span>or</span></div>` : ''}
    <form class="form-grid" id="f">
    <label class="field"><span>Work email</span><input name="email" type="email" autocomplete="username" required placeholder="you@nutricost.com"></label>
    <label class="field"><span id="pw-label">Password</span><div class="pw-wrap"><input name="password" type="password" autocomplete="current-password" required aria-labelledby="pw-label">
      <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Show password" aria-pressed="false">${icon('eye')}</button></div></label>
    <button class="btn primary lg block">Sign in</button>
    <a href="#/forgot" class="small" style="text-align:center">Forgot your password?</a></form>`);
  $('#pw-toggle').onclick = (e) => { // show/hide the typed password; the value stays as typed
    const input = $('input[name=password]'); const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = icon(show ? 'eye-off' : 'eye');
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    e.currentTarget.setAttribute('aria-pressed', String(show));
  };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    busy($('button.primary', e.target), async () => { await api('POST', '/api/login', fd); S.me = null; go('#/home'); });
  };
}
function viewForgot() {
  authPanel(`<form class="form-grid" id="f"><p class="muted" style="margin:0">Enter your email and we'll send you a link to reset your password.</p>
    <label class="field"><span>Work email</span><input name="email" type="email" required></label>
    <button class="btn primary lg block">Send reset link</button><a href="#/login" class="small" style="text-align:center">Back to sign in</a></form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      await api('POST', '/api/forgot', Object.fromEntries(new FormData(e.target)));
      $('#f').innerHTML = `<div class="banner info">${icon('mail')}<div>If that email has an account, a reset link is on its way. Check your inbox.</div></div><a href="#/login" class="btn block">Back to sign in</a>`;
    });
  };
}
function viewReset(token) {
  authPanel(`<form class="form-grid" id="f"><h2>Set your password</h2>
    <label class="field"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
    <label class="field"><span>Confirm password</span><input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
    <button class="btn primary lg block">Save and sign in</button></form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.password !== fd.confirm) return toast('Passwords do not match', true);
    busy($('button', e.target), async () => { await api('POST', '/api/reset', { token, password: fd.password }); S.me = null; toast('Password saved'); go('#/home'); });
  };
}
async function viewSetup() {
  const s = await api('GET', '/api/setup-needed');
  if (!s.needed) return go('#/login');
  if (s.rule === 'closed') return authPanel(`<div><h2>Setup is turned off</h2><p class="muted small" style="margin:6px 0 0">This server has no accounts yet, and its first-run setup is off. Sign in with Google if your address is set up as an admin, or ask whoever runs the server for a setup code.</p></div><a class="btn primary lg block" href="#/login" style="margin-top:16px">Go to sign in</a>`);
  authPanel(`<form class="form-grid" id="f"><div><h2>Welcome! Let's get set up.</h2><p class="muted small" style="margin:6px 0 0">Create the first administrator account. You can invite everyone else afterwards.</p></div>
    ${s.rule === 'code' ? '<label class="field"><span>Setup code</span><input name="setup_code" required autocomplete="off"></label>' : ''}
    <div class="form-grid cols"><label class="field"><span>First name</span><input name="first_name" required autocomplete="given-name"></label><label class="field"><span>Last name</span><input name="last_name" required autocomplete="family-name"></label></div>
    <label class="field"><span>Work email</span><input name="email" type="email" required autocomplete="username"></label>
    <label class="field"><span>Password (8+ characters)</span><input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <button class="btn primary lg block">Create admin account</button></form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    busy($('button', e.target), async () => { await api('POST', '/api/setup', Object.fromEntries(new FormData(e.target))); S.me = null; go('#/home'); });
  };
}

// ============================================================ home
function myEquipmentList(mine) {
  if (!mine.length) return `<div class="empty">${icon('laptop')}<p>No equipment is checked out to you.</p></div>`;
  return `<ul class="list">${mine.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}${srcQ('home')}">${thumbHtml(m.thumb, m.category)}
    <div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub"><span class="mono">${esc(m.tag)}</span> · since ${fmtStamp(m.checked_out_at)} · ${typeText(m)}</div></div>
    ${m.return_status === 'open' ? pill('open', 'Return requested') : m.return_status === 'dropped_off' ? pill('dropped_off', 'Dropped off') : isOverdue(m.due_date) ? pill('overdue', 'Overdue') : ''}
    ${icon('chev', 'chev')}</a></li>`).join('')}</ul>`;
}
// Open return requests on the employee's own equipment: ones IT asked for (warning) and ones the employee started (info).
function returnBanners(mine, src = '') { // src: which screen shows the banner, so "View item" can say where it came from
  return mine.filter((m) => m.return_status === 'open').map((m) => m.return_self ? `
    <div class="banner info">${icon('in')}<div class="grow"><strong>You asked to return ${esc(m.asset_name)}</strong>
      <div class="small">Bring it to IT, then tap “I've dropped it off”. It stays assigned to you until IT checks it in.</div>
      <div class="row wrap" style="margin-top:10px"><button class="btn sm dark" data-dropoff="${m.return_request_id}">${icon('check')} I've dropped it off</button><button class="btn sm" data-withdraw="${m.return_request_id}">Cancel return request</button></div></div></div>` : `
    <div class="banner warn">${icon('alert')}<div class="grow"><strong>IT asked you to return ${esc(m.asset_name)}</strong>
      <div class="small">${m.return_by ? `Please return by ${fmtDate(m.return_by)}. ` : ''}${m.return_message ? esc(m.return_message) : ''}</div>
      <div class="row wrap" style="margin-top:10px"><button class="btn sm dark" data-dropoff="${m.return_request_id}">${icon('check')} I've dropped it off</button><a class="btn sm" href="#/asset/${m.asset_id}${src ? srcQ(src) : ''}">View item</a></div></div></div>`).join('');
}
function wireDropoffs(root) {
  $$('[data-dropoff]', root).forEach((b) => b.onclick = () => busy(b, async () => {
    await api('POST', `/api/requests/${b.dataset.dropoff}/dropped-off`, {});
    toast('Thanks! IT has been notified.'); refreshBadge(); route(true);
  }));
  $$('[data-withdraw]', root).forEach((b) => b.onclick = () => busy(b, async () => {
    await api('POST', `/api/requests/${b.dataset.withdraw}/cancel`, {});
    toast('Return request cancelled'); refreshBadge(); route(true);
  }));
}
// The two things an employee can do about equipment they hold. Both are re-checked on the server; hiding them is only tidiness.
const holdingActions = (m) => `<div class="row wrap" style="padding:0 16px 14px 16px;gap:8px">
  ${m.return_status ? '' : `<button class="btn sm" data-ask-return="${m.asset_id}" data-asset-name="${esc(m.asset_name)}">${icon('in')} Request return</button>`}
  <button class="btn sm" data-report-issue="${m.asset_id}" data-asset-name="${esc(m.asset_name)}" data-asset-tag="${esc(m.tag)}">${icon('alert')} Report issue</button>
  ${m.open_issues ? `<span class="small muted" style="align-self:center">${m.open_issues} open issue${m.open_issues === 1 ? '' : 's'} · <a href="#/requests">see Requests</a></span>` : ''}</div>`;
function wireHoldingActions(root) {
  $$('[data-ask-return]', root).forEach((b) => b.onclick = () => requestMyReturnSheet({ id: Number(b.dataset.askReturn), name: b.dataset.assetName }, () => route(true)));
  $$('[data-report-issue]', root).forEach((b) => b.onclick = () => reportIssueSheet({ id: Number(b.dataset.reportIssue), name: b.dataset.assetName, tag: b.dataset.assetTag }, () => route(true)));
}
async function viewHome() {
  const d = await api('GET', '/api/dashboard');
  const first = S.me.name.split(' ')[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  if (!isAdmin()) {
    main().innerHTML = `<div class="page-head"><h1>${greet}, ${esc(first)}</h1></div>
      <div class="stack">${returnBanners(d.mine, 'home')}
      <div class="actions home-actions${canScan() ? ' has-scan' : ''}">${canScan() ? `<a href="#/scan" class="btn primary lg scan-wide">${icon('scan')} <span>Scan</span></a>` : ''}<button class="btn ${canScan() ? '' : 'primary '}lg" id="reserve-eq">${icon('calendar')} <span>Reserve equipment</span></button><button class="btn lg" id="req">${icon('plus')} <span>Request equipment</span></button></div>
      <div class="card"><div class="card-head"><h2>My equipment</h2><span class="muted small">${d.mine.length} item${d.mine.length === 1 ? '' : 's'} · <a href="#/equipment">See all</a></span></div>${myEquipmentList(d.mine)}</div>
      ${d.myRequests.length ? `<div class="card"><div class="card-head"><h2>My requests</h2><a href="#/requests" class="small">See all</a></div><ul class="list">${d.myRequests.map((r) => `<li><div class="item"><div class="thumb">${icon('box')}</div><div class="grow"><div class="title">${esc(r.catalog_path ? crumbText(r.catalog_path) : (r.category || 'Equipment'))}${isPermReq(r) ? ' · Permanent assignment' : ''}</div><div class="sub truncate">${r.catalog_path ? (r.asset_id ? 'Specific: ' + esc(r.asset_label || '') : 'Any matching') + ' · ' : ''}${esc(r.message || '')} · ${fmtWhen(r.created_at)}</div></div>${reqPill(r)}</div></li>`).join('')}</ul></div>` : ''}
      </div>`;
    $('#req').onclick = () => requestNeedSheet();
    $('#reserve-eq').onclick = reserveEquipment;
    wireDropoffs(main());
    return;
  }
  const s = d.stats;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.n));
  main().innerHTML = `<div class="page-head"><h1>${greet}, ${esc(first)}</h1><a href="#/new" class="btn primary desk-only">${icon('plus')} Add asset</a></div>
    <div class="stack">
    ${!S.mailConfigured ? `<div class="banner info">${icon('mail')}<div class="grow small"><strong>Email notifications are not set up yet.</strong> Emails are being saved to the outbox instead. <a href="#/settings">Set up Gmail →</a></div></div>` : ''}
    ${returnBanners(d.mine, 'home')}
    <div class="grid stats">
      <a class="card stat" href="#/assets?status=active"><div class="n">${s.total}</div><div class="l">Active assets</div></a>
      <a class="card stat" href="#/assets?status=available"><div class="n">${s.available}</div><div class="l">Available</div></a>
      <a class="card stat" href="#/assets?status=checked_out"><div class="n">${s.checked_out}</div><div class="l">Checked out</div></a>
      <a class="card stat ${s.overdue ? 'alert' : ''}" href="#/assets?status=overdue"><div class="n">${s.overdue}</div><div class="l">Overdue</div></a>
    </div>
    <div class="actions"><a href="#/scan" class="btn primary lg">${icon('scan')} Scan</a><a href="#/new" class="btn lg">${icon('plus')} Add asset</a></div>
    <div class="grid two">
      <div class="card"><div class="card-head"><h2>Needs attention</h2><a href="#/requests" class="small">Requests</a></div>
        ${d.openRequests.length || d.overdue.length ? `<ul class="list">
          ${d.openRequests.map((r) => `<li><a class="item" href="${r.asset_id && r.type === 'return' ? '#/asset/' + r.asset_id + srcQ('home') : '#/requests'}"><div class="thumb">${icon(requestIcon(r))}</div>
            <div class="grow"><div class="title truncate">${r.type === 'return' ? `Return: ${esc(r.asset_name || '')}` : r.type === 'issue' ? `Issue: ${esc(r.asset_name || 'equipment')}` : isPermReq(r) ? `${esc(r.user_name)} requests permanent ${esc(r.asset_name || r.category || 'equipment')}` : `${esc(r.user_name)} needs ${esc(r.catalog_path ? crumbText(r.catalog_path) : (r.category || 'equipment'))}`}</div>
            <div class="sub truncate">${r.type === 'return' || r.type === 'issue' ? esc(r.user_name) + ' · ' : ''}${fmtWhen(r.created_at)}${r.message ? ' · ' + esc(r.message) : ''}</div></div>${reqPill(r)}</a></li>`).join('')}
          ${d.overdue.map((o) => `<li><a class="item" href="#/asset/${o.asset_id}${srcQ('home')}"><div class="thumb" style="color:var(--bad)">${icon('alert')}</div>
            <div class="grow"><div class="title truncate">${esc(o.asset_name)}</div><div class="sub">${esc(o.user_name)} · due ${fmtDate(o.due_date)}</div></div>${pill('overdue', 'Overdue')}</a></li>`).join('')}
        </ul>` : `<div class="empty">${icon('check')}<p>All caught up.</p></div>`}
      </div>
      <div class="card"><div class="card-head"><h2>By category</h2><span class="muted small">${s.users} people</span></div>
        <div style="padding:8px 0">${d.byCategory.length ? d.byCategory.map((c) => `<a class="cat-row" href="#/assets?category=${encodeURIComponent(c.category)}" style="color:inherit"><span class="truncate">${esc(c.category)}</span><strong style="text-align:right">${c.n}</strong><div class="bar"><i style="width:${(c.n / maxCat) * 100}%"></i></div></a>`).join('') : `<div class="empty"><p>No assets yet. <a href="#/new">Add your first one</a> or <a href="#/import">import a spreadsheet</a>.</p></div>`}</div>
        ${s.value ? `<div class="card-body small muted" style="border-top:1px solid var(--line)">Total purchase value: <strong style="color:var(--text)">${money(s.value)}</strong></div>` : ''}
      </div>
    </div>
    ${d.expiring.length ? `<div class="card"><div class="card-head"><h2>Expiring in 60 days</h2></div><ul class="list">${d.expiring.map((a) => `<li><a class="item" href="#/asset/${a.id}${srcQ('home')}"><div class="thumb">${icon(catIcon(a.category))}</div><div class="grow"><div class="title truncate">${esc(a.name)}</div><div class="sub">${a.license_expires ? `License expires ${fmtDate(a.license_expires)}` : ''}${a.license_expires && a.warranty_expires ? ' · ' : ''}${a.warranty_expires ? `Warranty ends ${fmtDate(a.warranty_expires)}` : ''}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>` : ''}
    ${d.mine.length ? `<div class="card"><div class="card-head"><h2>My equipment</h2></div>${myEquipmentList(d.mine)}</div>` : ''}
    <div class="card"><div class="card-head"><h2>Recent activity</h2><a href="#/activity" class="small">See all</a></div>${activityList(d.activity, true, 'home')}</div>
    </div>`;
  wireDropoffs(main());
}
const ACTION_LABEL = { created: 'Added', edited: 'Edited', checked_out: 'Checked out', checked_in: 'Checked in', return_requested: 'Return requested', dropped_off: 'Dropped off', photo_added: 'Photo added', archived: 'Archived', requested: 'Requested', issue_reported: 'Issue reported', issue_resolved: 'Issue resolved', reserved: 'Reserved', reservation_requested: 'Reservation requested', reservation_approved: 'Reservation approved', reservation_declined: 'Reservation declined', reservation_cancelled: 'Reservation cancelled', reservation_shortened: 'Reservation shortened', waitlist_joined: 'Joined waitlist', waitlist_hold_started: 'Availability hold started', waitlist_confirmed: 'Hold confirmed', waitlist_declined: 'Hold declined', waitlist_left: 'Left waitlist', waitlist_updated: 'Waitlist dates changed', waitlist_removed: 'Removed from waitlist', waitlist_expired: 'Waitlist entry expired' };
function activityList(rows, withAsset, src = '') {
  if (!rows.length) return `<div class="empty"><p>No activity yet.</p></div>`;
  return `<ul class="timeline">${rows.map((r) => `<li><span class="dot"></span><div class="grow"><div><strong>${esc(ACTION_LABEL[r.action] || r.action)}</strong>${withAsset && r.asset_id ? ` · <a href="#/asset/${r.asset_id}${src ? srcQ(src) : ''}">${esc(r.asset_name || '')} <span class="mono small">${esc(r.tag || '')}</span></a>` : ''}</div>
    <div class="small muted">${esc(r.details || '')}</div><div class="small muted">${esc(r.actor_name || 'System')} · ${fmtWhen(r.created_at)}</div></div></li>`).join('')}</ul>`;
}

// ============================================================ assets list
async function viewAssets() {
  return isAdmin() ? viewAdminAssets() : viewBrowse(); // IT: the catalog-style All assets page; employees: the catalog card-grid browser
}

// ============================================================ catalog card grid (shared by Browse and the admin catalog)
// Category navigation is a responsive grid of cards that wraps onto as many rows as it needs — never a scrolling strip, never a
// tree. Same drill-down model everywhere: pick a card to go one level deeper; breadcrumbs jump back up; Back on narrow screens.
// A level with child categories starts with the VIRTUAL "All in <name>" card: not a catalog entry, just "the whole branch".
const cgCard = ({ attrs, name, meta, kind = '', chev = true, extra = '' }) => `<button type="button" class="cg-card ${kind}" ${attrs}><span class="cg-name">${esc(name)}${extra}</span><span class="cg-meta">${meta}</span>${chev ? icon('chev', 'cg-chev') : kind.includes('on') ? icon('check', 'cg-chev') : ''}</button>`;
// Drill-down screens reuse the app's existing back-link (the `.back` style used on asset pages: "‹ Assets"), placed ABOVE the
// page title so the title never moves. It is a real link to the parent's URL, labelled with where it goes.
const backAnchor = (href, label) => `<a class="back" href="${href}">${icon('back')}${esc(label)}</a>`;
const cgTop = (chain, { allLabel, curAll, trailing = '' }) => `<div class="cc-top cg-top">
  <nav class="cc-crumbs" aria-label="Where you are"><button type="button" data-crumb="-1" class="${chain.length ? '' : 'cur'}">${esc(allLabel)}</button>${chain.map((c, i) => `<span aria-hidden="true">›</span><button type="button" data-crumb="${c.id}" class="${i === chain.length - 1 && !curAll ? 'cur' : ''}">${esc(c.name)}</button>`).join('')}${curAll ? `<span aria-hidden="true">›</span><button type="button" class="cur" aria-current="true">All in ${esc(chain[chain.length - 1].name)}</button>` : ''}</nav>${trailing}</div>`;

// ============================================================ employee Browse equipment
// Search stays on top (global, available equipment only). Below it: category cards -> drill down. What is listed is always
// the server's employee view (available, not archived, not already yours) — a card's count and its list use the same rule.
async function viewBrowse() {
  let rows = [];
  try { rows = await getCatalog(); } catch { /* an empty catalog just means search-only browsing */ }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kidsOf = (pid) => rows.filter((r) => (r.parent_id ?? null) === pid);
  const st = { q: qs().get('q') || '', path: [], everything: true, token: 0 };
  // State lives in the URL: #/assets?node=<id> (a category/entry). The Browse root IS "All equipment": it is the default selection and its list is
  // shown at once (no click needed). An old #/assets?all=1 link is the same thing and is tidied to #/assets.
  const hashFor = (id) => '#/assets' + (id ? `?node=${id}` : '');
  const fromHash = () => {
    const p = qs(); const id = Number(p.get('node'));
    st.path = [];
    if (byId.has(id)) for (let n = byId.get(id); n; n = byId.get(n.parent_id)) st.path.unshift(n.id);
    st.everything = !st.path.length; // at the top, All equipment is always the active selection
    if ((p.get('node') || p.get('all')) && !st.path.length) history.replaceState(null, '', '#/assets'); // unknown / hidden entry, or the old ?all=1: back to the plain root
  };
  main().innerHTML = `<div id="backslot"></div><div class="page-head"><h1 id="pagetitle">Browse equipment</h1><span id="headact"></span></div>
    <div class="stack">
      <div class="row"><div class="search grow">${icon('search')}<input id="q" type="search" placeholder="Search camera, laptop, brand, model, tag…" value="${esc(st.q)}" enterkeyhint="search"></div>
        ${canScan() ? `<button class="btn" id="scanbtn" title="Scan">${icon('scan')}</button>` : ''}</div>
      <p class="small muted" style="margin:0">Shared equipment. Open an item to see its availability calendar and reserve it. Something checked out or reserved right now is still listed: open it to see when it is free.</p>
      <div id="bn"></div>
      <div class="card" id="results" hidden></div>
    </div>
    <div class="browse-req" id="reqfoot"><span class="small muted">Don't see what you need?</span><button type="button" class="btn" data-reqit>${icon('plus')} Request equipment</button></div>`;
  const cur = () => byId.get(st.path[st.path.length - 1]);
  const availMeta = (n) => (n ? `${n} available` : 'None available');
  const renderNav = () => {
    const bn = $('#bn');
    const up = byId.get((cur() || {}).parent_id); // Back is the app's usual "‹ <where it goes>" link above the title; none at the top
    $('#backslot').innerHTML = st.path.length && !st.q ? backAnchor(hashFor(up ? up.id : null), up ? up.name : 'Browse equipment') : autoBack();
    $('#pagetitle').textContent = !st.q && cur() ? cur().name : 'Browse equipment'; // the screen IS the entry being viewed (same model as the admin catalog)
    // Availability for exactly what is on screen, but only once the catalog is narrowed: no calendar at the Browse root (or while searching,
    // which is global). A company-wide calendar is not useful to employees.
    $('#headact').innerHTML = !st.q && cur() ? calendarLink({ node: cur().id }) : '';
    if (st.q) { bn.innerHTML = ''; return; } // searching: the grid steps aside, results are global
    const c = cur(); const kids = c ? kidsOf(c.id) : kidsOf(null); const leaf = c && !kids.length;
    const chain = st.path.map((id) => byId.get(id));
    const cards = [];
    if (!c) cards.push(cgCard({ attrs: 'data-everything', name: 'All equipment', meta: 'Everything available', kind: 'all on', chev: false })); // the root's default (and only) state: selected
    else if (!leaf) cards.push(cgCard({ attrs: 'data-all', name: `All in ${c.name}`, meta: availMeta(c.available_count), kind: 'all on', chev: false }));
    // Only THIS entry's children. Never the top-level (or sibling) cards again: a leaf shows just its assets; going elsewhere is Back / a breadcrumb.
    for (const r of kids) cards.push(cgCard({ attrs: `data-id="${r.id}"`, name: r.name, meta: availMeta(r.available_count) }));
    bn.innerHTML = `${chain.length ? cgTop(chain, { allLabel: 'All equipment' }) : ''}${cards.length ? `<div class="cg" role="group" aria-label="Categories">${cards.join('')}</div>` : ''}`;
  };
  // Discoverable is not the same as available: a shared item that is checked out or reserved today is listed with its state, and opens its CALENDAR
  // (the asset page itself is only for what is available now) where the employee can see when it is free, reserve future days or join a waitlist.
  const rowHtml = (a) => {
    const seats = a.license_seats > 1 ? ` · ${a.seats_used}/${a.license_seats} seats` : '';
    const out = a.avail_state && a.avail_state !== 'available';
    const href = out ? calUrl({ asset: a.id, from: calendarSource() }) : `#/asset/${a.id}${srcQ('browse', { node: (cur() || {}).id })}`;
    const state = !out ? statusPill(a) : a.avail_state === 'reserved' ? pill('reserved', 'Reserved') : a.avail_state === 'partial' ? pill('reserved', 'Partly scheduled') : pill('checked_out', 'Checked out');
    const when = out ? (a.expected_back ? ` · back ${fmtDate(a.expected_back)}` : ['reserved', 'partial'].includes(a.avail_state) ? ' · see when it is free' : '') : (a.location ? ' · ' + esc(a.location) : '');
    return `<li><a class="item" href="${href}">${thumbHtml(a.thumb, a.category)}
      <div class="grow"><div class="title truncate">${esc(a.name)}</div>
      <div class="sub truncate"><span class="mono">${esc(a.tag)}</span>${seats}${when}</div></div>${state}${icon('chev', 'chev')}</a></li>`;
  };
  const load = async () => {
    const box = $('#results'); const mine = ++st.token;
    const c = cur(); const kids = c ? kidsOf(c.id) : [];
    // What is listed: a search (global), else the selected branch, else — at the top — All equipment (the default).
    const u = new URLSearchParams(); let label = '';
    if (st.q) { u.set('q', st.q); label = 'Search results'; }
    else if (c) { u.set('catalog_node', c.id); label = kids.length ? `All in ${c.name}` : crumbText(c.path); }
    else label = 'All equipment';
    box.hidden = false; box.innerHTML = '<div class="spinner"></div>';
    try {
      const list = await api('GET', '/api/assets?' + u.toString());
      if (mine !== st.token) return;
      box.innerHTML = `<div class="card-head"><span class="muted small">${esc(label)} · ${list.length} asset${list.length === 1 ? '' : 's'}</span></div>${list.length
        ? `<ul class="list">${list.map(rowHtml).join('')}</ul>`
        : `<div class="empty">${icon('box')}<p>${st.q ? 'Nothing matches that search. Try a broader word such as “camera” or “laptop”, or request it from IT.' : 'No shared equipment is listed here yet.'}</p><button type="button" class="btn" data-reqit>${icon('plus')} Request equipment</button></div>`}`;
      $('#reqfoot').hidden = !list.length; // an empty list carries its own request button; the footer one would just repeat it
      const eb = $('[data-reqit]', box); if (eb) eb.onclick = () => requestNeedSheet();
    } catch (e) { if (mine === st.token) fail(e); }
  };
  const go2 = () => { renderNav(); load(); };
  // Every move is a navigation to a URL; the hashchange handler (S.soft) then re-reads it and repaints in place.
  $('#bn').onclick = (e) => {
    const card = e.target.closest('[data-id]'); const crumb = e.target.closest('[data-crumb]');
    let target;
    if (e.target.closest('[data-everything]')) return; // the root already shows All equipment
    else if (e.target.closest('[data-all]')) return; // already showing the whole branch
    else if (card) target = hashFor(Number(card.dataset.id));
    else if (crumb) target = hashFor(Number(crumb.dataset.crumb) > 0 ? Number(crumb.dataset.crumb) : null);
    else return;
    go(target); window.scrollTo(0, 0);
  };
  $('#backslot').onclick = () => window.scrollTo(0, 0); // (the link itself navigates one step up)
  S.soft = { base: '#/assets', fn: () => { fromHash(); go2(); } };
  $('#q').oninput = debounce((e) => { st.q = e.target.value.trim(); go2(); });
  if ($('#scanbtn')) $('#scanbtn').onclick = () => openScanner({ onResult: handleScannedCode });
  $('#reqfoot [data-reqit]').onclick = () => requestNeedSheet(); // the same request flow as before (the empty-state button is wired when the list renders)
  fromHash(); go2();
}

// ============================================================ asset detail
async function viewAsset(id) {
  const [d, backTo] = await Promise.all([api('GET', '/api/assets/' + id), assetBackTarget()]);
  const a = d.asset;
  const admin = isAdmin();
  const st = !['retired', 'lost', 'disposed'].includes(a.status) && d.holders.some((h) => isOverdue(h.due_date)) ? 'overdue' : a.status;
  const canPhoto = admin || d.is_mine;
  const multi = d.capacity > 1;
  const seatsFree = d.capacity - d.seats_used;
  const myReturnReq = d.requests.find((r) => r.type === 'return' && r.user_id === S.me.id && r.status === 'open');
  const myIssues = d.requests.filter((r) => r.type === 'issue' && r.user_id === S.me.id);
  const cover = d.photos.find((p) => p.id === a.cover_photo_id) || d.photos[0];
  const photos = cover ? [cover, ...d.photos.filter((p) => p !== cover)] : [];
  const resv = d.reservations || []; // live reservations: IT sees all of them, an employee only their own
  // The employee's OWN existing activity for this asset, up front: green = reserved for me, amber = waiting / not guaranteed (nobody else's identity is ever shown)
  const mineResv = admin ? [] : resv.filter((r) => r.mine !== false && ['pending', 'confirmed'].includes(r.status));
  const mineWl = admin ? [] : (d.waitlist || []);
  const myActivity = mineResv.length || mineWl.length ? `<div class="my-activity">
    ${mineResv.filter((r) => r.status === 'confirmed').length ? `<span class="rs-sched ok"><strong>Your reservation</strong>${mineResv.filter((r) => r.status === 'confirmed').map((r) => `<span>${esc(resvRange(r))}</span>`).join('')}</span>` : ''}
    ${mineResv.filter((r) => r.status === 'pending').length ? `<span class="rs-sched wait"><strong>Your reservation request</strong>${mineResv.filter((r) => r.status === 'pending').map((r) => `<span>${esc(resvRange(r))} · waiting for IT approval</span>`).join('')}</span>` : ''}
    ${mineWl.length ? `<span class="rs-sched wait"><strong>Your waitlist</strong>${mineWl.map((w) => `<span>${esc(resvRange({ start_date: w.start_date, start_time: w.start_time, end_date: w.end_date, end_time: w.end_time }))}${w.phase === 'held' ? ` · available for you until ${esc(w.hold_expires_text || fmtStamp(w.hold_expires_at))}` : ''}</span>`).join('')}</span>` : ''}</div>` : '';
  // ---- action buttons
  let actions = '';
  if (a.archived_at) {
    actions = `<div class="banner info">${icon('box')}<div class="grow"><strong>This asset is archived.</strong> Its history is kept and its tag stays reserved.</div></div>`;
  } else if (admin) {
    const btns = [];
    if (['available', 'checked_out'].includes(a.status) && seatsFree > 0) btns.push(`<button class="btn primary lg" id="act-out">${icon('out')} Check out${multi ? ' a seat' : ''}</button>`);
    if (d.holders.length) btns.push(`<button class="btn ${seatsFree > 0 ? '' : 'primary'} lg" id="act-in">${icon('in')} Check in</button>`);
    if (d.holders.length) btns.push(`<button class="btn lg" id="act-ret">${icon('send')} Request return</button>`);
    btns.push(`<a class="btn lg" href="#/asset/${a.id}/edit${ctxQuery()}">${icon('edit')} Edit</a>`);
    btns.push(`<a class="btn lg" href="#/labels?ids=${a.id}">${icon('printer')} Print label</a>`);
    if (btns.length % 2) btns[btns.length - 1] = btns[btns.length - 1].replace('class="btn', 'class="full btn');
    actions = `<div class="actions">${btns.join('')}</div>`;
  } else {
    if (d.is_mine) {
      const reportBtn = `<button class="btn lg block" id="act-issue">${icon('alert')} Report an issue</button>`;
      const issueNote = myIssues.length ? `<div class="banner info">${icon('alert')}<div class="grow"><strong>You've reported ${myIssues.length === 1 ? 'an issue' : myIssues.length + ' issues'} with this item.</strong>
           <div class="small">${myIssues.map((i) => esc(i.message || '')).join(' · ')}</div><a class="small" href="#/requests">See Requests</a></div></div>` : '';
      actions = (myReturnReq
        ? (myReturnReq.self_initiated
          ? `<div class="banner info">${icon('in')}<div class="grow"><strong>You asked to return this.</strong><div class="small">Bring it to IT, then tap “I've dropped it off”. It stays assigned to you until IT checks it in.</div>
             <div class="row wrap" style="margin-top:10px"><button class="btn dark sm" data-dropoff="${myReturnReq.id}">${icon('check')} I've dropped it off</button><button class="btn sm" data-withdraw="${myReturnReq.id}">Cancel return request</button></div></div></div>`
          : `<div class="banner warn">${icon('alert')}<div class="grow"><strong>IT asked you to return this${myReturnReq.needed_by ? ` by ${fmtDate(myReturnReq.needed_by)}` : ''}.</strong>${myReturnReq.message ? `<div class="small">${esc(myReturnReq.message)}</div>` : ''}
             <button class="btn dark sm" style="margin-top:10px" data-dropoff="${myReturnReq.id}">${icon('check')} I've dropped it off</button></div></div>`)
        : d.requests.some((r) => r.type === 'return' && r.status === 'dropped_off' && r.user_id === S.me.id)
          ? `<div class="banner info">${icon('check')}<div>You've told IT you dropped this off. It'll come off your list once IT checks it in.</div></div>`
          : `<div class="actions"><button class="btn lg" id="act-ask-return">${icon('send')} Request return</button><button class="btn lg" id="act-return">${icon('in')} I'm returning this</button></div>`) + issueNote + reportBtn;
    } else if (a.status === 'available' && seatsFree > 0) {
      const canReserve = !!(d.reserve && d.reserve.allowed);
      // "Check out now" needs the self-checkout permission (otherwise "Request this"); "Reserve" does not: it needs only the asset's own eligibility.
      const primary = S.me.can_self_checkout
        ? `<button class="${canReserve ? '' : 'full '}btn primary lg" id="act-self">${icon('out')} Check out now</button>`
        : `<button class="${canReserve ? '' : 'full '}btn primary lg" id="act-request">${icon('box')} Request this</button>`;
      actions = `<div class="actions">${primary}${canReserve ? `<button class="btn lg" id="act-reserve">${icon('calendar')} Reserve</button>` : ''}</div>`;
    } else if (d.held_by_other || a.status !== 'available') {
      actions = `<div class="banner info">${icon('box')}<div class="grow">This item isn't available right now. <a href="#" id="act-similar">Request something similar</a></div></div>`;
    }
  }

  const kv = [
    ['Catalog', a.catalog_path ? esc(a.catalog_path.split(' > ').join(' › ')) : '', true], ['Category', a.category], ['Brand', a.brand], ['Model', a.model], ['Serial #', a.serial ? `<span class="mono">${esc(a.serial)}</span>` : '', true],
    ['Condition', a.condition], ['Location', a.location], ['Purchased', fmtDate(a.purchase_date)], ['Cost', admin ? money(a.purchase_cost) : ''],
    ['Vendor', admin ? a.vendor : ''], ['Available to request', admin ? (a.available_to_request ? 'Yes' : 'No — employees can\'t see it') : ''],
    ['Reservations', admin && a.available_to_request ? (a.reservation_requires_approval ? 'Need IT approval' : 'Confirmed automatically') : ''], ['Warranty ends', a.warranty_expires ? `${fmtDate(a.warranty_expires)}${a.warranty_expires < localToday() ? ' <span class="pill lost plain">Expired</span>' : ''}` : '', true],
  ].filter(([, v]) => v);

  const statusBadge = st === 'overdue' ? pill('overdue') : a.status === 'available' && d.upcoming && !admin ? pill('available', 'Available now') : statusPill(a);
  main().innerHTML = `<div class="asset-bar"><div class="asset-bar-top">${backLink(backTo.href, backTo.label, backTo.exact)}${calendarLink({ asset: a.id })}</div>
      <div class="asset-id"><h1 class="truncate">${esc(a.name)}</h1><span class="mono muted">${esc(a.tag)}</span>${statusBadge}${multi ? `<span class="pill plain">${d.seats_used}/${d.capacity} seats</span>` : ''}</div></div>
    <div class="stack">
      ${photos.length ? `<div class="gallery">${photos.map((p, i) => `<div class="ph" data-ph="${p.id}"><img src="/uploads/${esc(p.thumb)}" data-full="/uploads/${esc(p.filename)}" alt="Photo of ${esc(a.name)}" loading="lazy">${i === 0 && photos.length > 1 ? '<span class="star">Cover</span>' : ''}</div>`).join('')}
        ${canPhoto ? `<button type="button" class="add-ph" id="ph-cam">${icon('camera')}<span>Take photos</span></button><label class="add-ph">${icon('upload')}<span>Choose files</span><input type="file" accept="image/*" multiple hidden id="ph-in"></label>` : ''}</div>`
        : canPhoto ? `<div class="no-photo"><div>${icon('camera')}<strong>Add photos</strong><div class="small">Snap the device, its label, or any damage</div><div class="ph-actions"><button type="button" class="btn primary" id="ph-cam">${icon('camera')} Take photos</button><label class="btn">${icon('upload')} Choose files<input type="file" accept="image/*" multiple hidden id="ph-in"></label></div></div></div>` : ''}
      ${myActivity}
      ${actions}
      ${resv.length ? `<div class="card"><div class="card-head"><h2>${admin ? 'Reservations' : 'Your reservations'}</h2><span class="muted small">${resv.length}</span></div><ul class="list">${resv.map((r) => reservationItem(r, { admin, showAsset: false })).join('')}</ul></div>` : ''}
      ${d.holders.length ? `<div class="card"><div class="card-head"><h2>${multi ? 'Assigned to' : d.holders.every((h) => h.assignment_type === 'checkout') ? (admin ? 'Temporarily checked out to' : 'Temporarily checked out to you') : (admin ? 'Assigned to' : 'Assigned to you')}</h2></div><ul class="list">${d.holders.map((h) => `<li><div class="item">
          <div class="avatar">${esc(initials(h.user_name))}</div>
          <div class="grow">${admin ? `<a href="#/person/${h.employee_id}" class="title">${esc(h.user_name)}</a>` : `<div class="title">${esc(h.user_name)}</div>`}
          <div class="sub">${typeText(h)} · since ${fmtStamp(h.checked_out_at)}${h.user_department ? ` · ${esc(h.user_department)}` : ''}</div></div>
          ${isOverdue(h.due_date) ? pill('overdue', 'Overdue') : ''}
          ${admin && multi ? `<button class="btn sm" data-in="${h.id}">Check in</button>` : ''}</div></li>`).join('')}</ul></div>` : ''}
      ${d.requests.length && admin ? `<div class="card"><div class="card-head"><h2>Open requests</h2></div><ul class="list">${d.requests.map((r) => `<li><div class="item"><div class="thumb">${icon(requestIcon(r))}</div><div class="grow"><div class="title">${r.type === 'return' ? 'Return from ' : r.type === 'issue' ? 'Issue reported by ' : isPermReq(r) ? 'Permanent assignment requested by ' : 'Requested by '}${esc(r.user_name)}</div><div class="sub">${fmtWhen(r.created_at)}${r.needed_by ? ' · by ' + fmtDate(r.needed_by) : ''}${r.message ? ' · ' + esc(r.message) : ''}</div></div>${reqPill(r)}${r.type === 'issue' ? `<a class="btn sm" href="#/requests">Review</a>` : ''}</div></li>`).join('')}</ul></div>` : ''}
      ${a.license_key || a.license_expires || multi || a.category === 'Software License' ? `<div class="card"><div class="card-head"><h2>License</h2></div><div class="kv">
          ${a.license_key ? `<div class="k">Key</div><div class="v"><span class="license-key">${esc(a.license_key)}</span> <button class="iconbtn" style="width:32px;height:32px;display:inline-grid;vertical-align:middle" id="copykey" title="Copy">${icon('copy')}</button></div>` : ''}
          <div class="k">Seats</div><div class="v">${d.seats_used} used of ${d.capacity}</div>
          ${a.license_expires ? `<div class="k">Expires</div><div class="v">${fmtDate(a.license_expires)}${a.license_expires < localToday() ? ' <span class="pill lost plain">Expired</span>' : ''}</div>` : ''}
        </div></div>` : ''}
      ${kv.length ? `<div class="card"><div class="card-head"><h2>Details</h2></div><div class="kv">${kv.map(([k, v, html]) => `<div class="k">${k}</div><div class="v">${html ? v : esc(v)}</div>`).join('')}</div></div>` : ''}
      ${a.notes && admin ? `<div class="card pad"><h3 style="margin-bottom:6px">Notes</h3><div style="white-space:pre-wrap">${esc(a.notes)}</div></div>` : ''}
      ${admin ? `<div class="card"><div class="card-head"><h2>History</h2></div>${activityList(d.activity)}</div>
        ${a.archived_at ? '' : `<div class="row wrap" style="justify-content:center;padding:8px 0 4px">
          ${a.status !== 'maintenance' && !d.holders.length ? `<button class="btn sm" data-status="maintenance">${icon('wrench')} Mark in repair</button>` : ''}
          ${['maintenance', 'retired', 'lost'].includes(a.status) ? `<button class="btn sm" data-status="available">${icon('check')} Mark available</button>` : ''}
          ${a.status !== 'lost' ? `<button class="btn sm" data-status="lost">Mark lost</button>` : ''}
          ${a.status !== 'retired' && a.status !== 'disposed' && !d.holders.length ? `<button class="btn sm" data-status="retired">Retire</button>` : ''}
          ${a.status !== 'disposed' && !d.holders.length ? `<button class="btn sm" data-status="disposed">Mark disposed</button>` : ''}
          ${d.holders.length ? '' : `<button class="btn sm danger" id="del">${icon('archive')} Archive</button>`}</div>`}` : ''}
    </div>`;

  const reload = () => route(true);
  const phIn = $('#ph-in');
  if (phIn) phIn.onchange = () => { const files = Array.from(phIn.files); phIn.value = ''; uploadPhotos(a.id, files).then(reload); };
  $$('[data-ph]').forEach((el) => el.onclick = () => lightbox(photos, Math.max(0, photos.findIndex((p) => p.id === Number(el.dataset.ph))), a, reload)); // (photos: the gallery's order, cover first)
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#ph-cam', () => openPhotoCapture({ onDone: (files) => uploadPhotos(a.id, files).then(reload) }));
  on('#act-out', () => checkoutSheet(a, reload));
  on('#act-in', () => checkinSheet(a, d.holders, reload));
  on('#act-ret', () => requestReturnSheet(a, d.holders, reload));
  $$('[data-in]').forEach((b) => b.onclick = () => checkinSheet(a, d.holders.filter((h) => h.id === Number(b.dataset.in)), reload));
  on('#act-self', () => selfCheckoutSheet(a));
  on('#act-reserve', () => go(calUrl({ asset: a.id, reserve: true, from: calendarSource() }))); // the single-asset calendar is where dates are picked
  wireReservationActions(main(), resv, reload);
  on('#act-request', () => requestEquipmentSheet({ asset: a }));
  on('#act-similar', (e) => { e.preventDefault(); requestEquipmentSheet({ category: a.category }); });
  on('#act-ask-return', () => requestMyReturnSheet({ id: a.id, name: a.name }, reload));
  on('#act-issue', () => reportIssueSheet({ id: a.id, name: a.name, tag: a.tag }, reload));
  on('#act-return', async () => {
    const ok = await confirmSheet('Returning this item?', "Tap confirm once you've handed it to IT or left it at the IT drop-off. IT will check it in.", "I've dropped it off");
    if (!ok) return;
    try { await api('POST', `/api/assets/${a.id}/return-notice`, {}); toast('Thanks! IT has been notified.'); reload(); } catch (e) { fail(e); }
  });
  wireDropoffs(main());
  on('#copykey', () => { navigator.clipboard?.writeText(a.license_key).then(() => toast('License key copied')); });
  $$('[data-status]').forEach((b) => b.onclick = () => busy(b, async () => {
    await api('PUT', `/api/assets/${a.id}`, { status: b.dataset.status }); toast('Status updated'); reload();
  }));
  on('#del', async () => {
    if (!(await confirmSheet('Archive this asset?', `${a.tag} will be hidden from the asset list. Its history, photos and tag are kept, and the tag can't be reused.`, 'Archive', true))) return;
    try { await api('POST', `/api/assets/${a.id}/archive`, {}); toast('Asset archived'); go('#/assets'); } catch (e) { fail(e); }
  });
}

// Uploads photos to an asset and says exactly what happened: how many were saved and which were not (an upload that partly or wholly
// failed is never reported as saved). Resolves { saved, failed, error }; the toast is shown here.
async function uploadPhotos(assetId, files) {
  const all = Array.from(files || []);
  if (!all.length) return { saved: 0, failed: 0, error: null };
  const send = all.slice(0, 10);
  const fd = new FormData();
  send.forEach((f) => fd.append('photos', f));
  toast(`Uploading ${send.length} photo${send.length > 1 ? 's' : ''}…`);
  try {
    const r = await api('POST', `/api/assets/${assetId}/photos`, fd);
    const failed = (r.failed || []).length + (all.length - send.length);
    if (failed) toast(`${r.ids.length} of ${all.length} photo${all.length > 1 ? 's' : ''} saved. ${failed} not saved${(r.failed || []).length ? `: ${r.failed.join(', ')}` : ' (10 photos at a time)'}.`, true);
    else toast(r.ids.length > 1 ? `${r.ids.length} photos saved` : 'Photo saved');
    return { saved: r.ids.length, failed, error: null };
  } catch (e) { fail(e); return { saved: 0, failed: all.length, error: e.message || 'Upload failed' }; }
}

// In-app camera for photos: the pictures are taken from the live camera feed into memory (JPEG blobs), never saved to the phone's photo
// library. Several shots, each shown as a small preview that can be removed, then Done hands the files to onDone. The camera is released
// on Done, Close, a page change and when the page goes to the background. Choosing files remains the fallback where there is no camera.
let activeCapture = null;
function openPhotoCapture({ title = 'Take photos', max = 10, onDone }) {
  if (activeCapture) activeCapture.close();
  const wrap = document.createElement('div');
  wrap.className = 'pcap';
  wrap.innerHTML = `<div class="pc-top"><button class="iconbtn" id="pc-close" aria-label="Close">${icon('x')}</button><strong>${esc(title)}</strong><button class="btn primary sm" id="pc-done" disabled>Done</button></div>
    <div class="pc-view"><video playsinline muted autoplay></video><div class="pc-flash"></div><div class="pc-msg" hidden></div></div>
    <div class="pc-strip" id="pc-strip"></div>
    <div class="pc-bar"><span class="pc-count" id="pc-count"></span><button class="pc-shutter" id="pc-shot" aria-label="Take photo" disabled></button><span></span></div>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  const video = $('video', wrap);
  let stream = null; let shots = []; let done = false; let closing = false; let busyShot = false; let failedMsg = null;
  const update = () => {
    $('#pc-count', wrap).textContent = `${shots.length} / ${max}`;
    $('#pc-done', wrap).disabled = !shots.length;
    $('#pc-done', wrap).textContent = shots.length ? `Done (${shots.length})` : 'Done';
    $('#pc-shot', wrap).disabled = !stream || busyShot || shots.length >= max;
    $('#pc-strip', wrap).innerHTML = shots.map((s, i) => `<div class="pc-th"><img src="${s.url}" alt="Photo ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remove photo ${i + 1}">${icon('x')}</button></div>`).join('');
  };
  const showMsg = (text) => { const m = $('.pc-msg', wrap); m.hidden = false; m.innerHTML = `<div>${icon('camera')}<p>${esc(text)}</p><p class="small">You can still choose photos from your device.</p></div>`; };
  const stopStream = () => { if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } }); stream = null; } video.srcObject = null; };
  const start = async () => {
    if (done || stream || failedMsg) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { failedMsg = 'The camera needs a secure (https://) connection and a browser that supports it.'; return showMsg(failedMsg); }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (done) { s.getTracks().forEach((t) => t.stop()); return; } // closed while the permission prompt was open
      stream = s; video.srcObject = s; await video.play().catch(() => {});
      update();
    } catch (e) {
      const n = e && e.name;
      failedMsg = n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera access was blocked. Allow camera access for this site in your browser settings.' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera was found on this device.' : 'Could not open the camera.';
      console.warn('Photo camera failed:', e); showMsg(failedMsg); update();
    }
  };
  const release = () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); shots = []; };
  const close = () => {
    if (closing) return; closing = true; done = true;
    document.removeEventListener('visibilitychange', onVis); window.removeEventListener('hashchange', onRoute);
    stopStream(); release(); wrap.remove(); if (activeCapture === handle) activeCapture = null;
    if (!$('.scanner') && !$('.pcap')) document.body.style.overflow = '';
  };
  const route0 = location.hash.split('?')[0];
  const onRoute = () => { if (location.hash.split('?')[0] !== route0) close(); };
  const onVis = () => { if (done) return; if (document.hidden) stopStream(); else start().then(update); }; // iOS drops the camera in the background: take a fresh one on return
  $('#pc-shot', wrap).onclick = () => {
    if (!stream || busyShot || shots.length >= max || !video.videoWidth) return;
    busyShot = true; update();
    const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas'); c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    try { navigator.vibrate && navigator.vibrate(30); } catch { /* */ }
    const fl = $('.pc-flash', wrap); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
    c.toBlob((blob) => {
      busyShot = false;
      if (blob && !done) shots.push({ file: new File([blob], `photo-${Date.now()}-${shots.length + 1}.jpg`, { type: 'image/jpeg' }), url: URL.createObjectURL(blob) });
      else if (!blob) toast('Could not capture that photo. Try again.', true);
      update();
    }, 'image/jpeg', 0.9);
  };
  $('#pc-strip', wrap).onclick = (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; const [s] = shots.splice(Number(b.dataset.rm), 1); if (s) URL.revokeObjectURL(s.url); update(); };
  $('#pc-close', wrap).onclick = () => { if (shots.length && !confirm(`Discard ${shots.length} photo${shots.length > 1 ? 's' : ''}?`)) return; close(); };
  $('#pc-done', wrap).onclick = () => { const files = shots.map((s) => s.file); close(); if (files.length) onDone(files); };
  document.addEventListener('visibilitychange', onVis); window.addEventListener('hashchange', onRoute);
  const handle = { close }; activeCapture = handle;
  update(); start();
  return handle;
}

// Fullscreen photo viewer: a gallery over the asset's photos in the order the asset page shows them (cover first), opened on the photo
// that was tapped. Mobile: swipe left for the next photo and right for the previous one (the picture follows the finger). Desktop: Previous / Next
// arrows and the arrow keys; Esc closes. No wrap-around: the unavailable direction is hidden. Only the photo on screen is loaded at full
// size (plus its two neighbours once it has shown); every other slide waits empty, so opening the viewer downloads one full photo.
function lightbox(allPhotos, startIndex, asset, reload) {
  let photos = allPhotos.slice();
  let i = Math.min(Math.max(startIndex, 0), photos.length - 1);
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Photo viewer');
  el.innerHTML = `<div class="lb-stage"><div class="lb-track"></div></div>
    <div class="lb-count" aria-live="polite"></div>
    <button class="lb-nav lb-prev" id="lb-prev" aria-label="Previous photo">${icon('chev')}</button><button class="lb-nav lb-next" id="lb-next" aria-label="Next photo">${icon('chev')}</button>
    <div class="lb-bar">
    ${isAdmin() ? `<button class="iconbtn" id="lb-cover" title="Make cover photo" aria-label="Make cover photo">${icon('star')}</button><button class="iconbtn" id="lb-del" title="Delete photo" aria-label="Delete photo">${icon('trash')}</button>` : ''}
    <button class="iconbtn" id="lb-x" title="Close" aria-label="Close">${icon('x')}</button></div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  const stage = $('.lb-stage', el); const track = $('.lb-track', el);
  let width = stage.clientWidth || window.innerWidth; let drag = null; let dragged = false; let closed = false;

  const build = () => {
    track.innerHTML = photos.map((p, n) => `<div class="lb-slide" data-n="${n}"><div class="lb-load"><div class="spinner"></div></div></div>`).join('');
  };
  // A slide gets its full-size image only when it is the current photo or next to it.
  const fill = (n) => {
    const slide = track.children[n]; if (!slide || slide.dataset.loaded) return;
    slide.dataset.loaded = '1';
    const img = new Image(); img.alt = `Photo ${n + 1} of ${photos.length}`; img.draggable = false;
    img.onload = () => { slide.replaceChildren(img); if (n === i) { fill(n - 1); fill(n + 1); } };
    img.onerror = () => { slide.innerHTML = '<div class="lb-load small">This photo could not be loaded.</div>'; };
    img.src = '/uploads/' + photos[n].filename;
  };
  const place = (offset = 0, animate = false) => {
    track.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
    track.style.transform = `translate3d(${-i * width + offset}px,0,0)`;
  };
  const render = (animate = true) => {
    place(0, animate);
    $('.lb-count', el).textContent = photos.length > 1 ? `${i + 1} of ${photos.length}` : '';
    $('#lb-prev', el).hidden = i === 0 || photos.length < 2; $('#lb-next', el).hidden = i === photos.length - 1 || photos.length < 2;
    fill(i); if (track.children[i] && track.children[i].querySelector('img')) { fill(i - 1); fill(i + 1); }
  };
  const go = (to) => { if (to < 0 || to > photos.length - 1 || to === i) return; i = to; render(true); };

  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onRoute); window.removeEventListener('resize', onResize);
    el.remove(); if (!$('.scanner') && !$('.pcap') && !$('#sheet-root').children.length) document.body.style.overflow = '';
  };
  const route0 = location.hash.split('?')[0];
  const onRoute = () => { if (location.hash.split('?')[0] !== route0) close(); };
  const onKey = (e) => {
    if (el.style.display === 'none') return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(i - 1); else if (e.key === 'ArrowRight') go(i + 1);
  };
  const onResize = () => { width = stage.clientWidth || window.innerWidth; place(0, false); };

  // Swipe: horizontal drags move the track with the finger (resisting past the first / last photo); release decides. Vertical drags and pinch
  // are left to the browser (touch-action), and a swipe never counts as a tap on the backdrop.
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, on: false }; dragged = false; });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      drag.on = true; dragged = true; try { stage.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    const atEdge = (dx > 0 && i === 0) || (dx < 0 && i === photos.length - 1);
    place(atEdge ? dx / 4 : dx, false);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.on) return;
    const dx = e.clientX - d.x; const dt = Math.max(1, Date.now() - d.t);
    const far = Math.abs(dx) > width * 0.2; const quick = Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.45;
    if ((far || quick) && e.type === 'pointerup') go(dx < 0 ? i + 1 : i - 1); else place(0, true);
    setTimeout(() => { dragged = false; }, 0);
  };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

  el.onclick = (e) => {
    if (dragged) return;
    if (e.target.closest('#lb-x') || e.target === el || e.target === stage || e.target.classList.contains('lb-slide')) close();
  };
  $('#lb-prev', el).onclick = (e) => { e.stopPropagation(); go(i - 1); };
  $('#lb-next', el).onclick = (e) => { e.stopPropagation(); go(i + 1); };
  const c = $('#lb-cover', el);
  if (c) c.onclick = async () => { const p = photos[i]; await api('PUT', `/api/assets/${asset.id}/cover`, { photo_id: p.id }).catch(fail); close(); toast('Cover photo set'); reload(); };
  const d = $('#lb-del', el);
  if (d) d.onclick = async () => {
    const p = photos[i];
    el.style.display = 'none'; // the confirmation sheet sits below the viewer: step aside while it is open
    const yes = await confirmSheet('Delete photo?', 'This cannot be undone.', 'Delete', true);
    if (closed) return;
    document.body.style.overflow = 'hidden'; el.style.display = '';
    if (!yes) return;
    try { await api('DELETE', `/api/photos/${p.id}`); } catch (e) { return fail(e); }
    photos = photos.filter((x) => x.id !== p.id);
    if (!photos.length) { close(); reload(); return; }
    i = Math.min(i, photos.length - 1); // the next photo takes its place (the previous one when the last was deleted)
    build(); render(false); reload(); // the page behind is refreshed; the viewer stays on the photos that are left
  };

  document.addEventListener('keydown', onKey); window.addEventListener('hashchange', onRoute); window.addEventListener('resize', onResize);
  build(); render(false);
  $('#lb-x', el).focus({ preventScroll: true });
}

// ============================================================ action sheets
let usersCache = null;
async function getUsers(force) {
  if (!usersCache || force) usersCache = (await api('GET', '/api/users')).filter((u) => u.active !== false);
  return usersCache;
}
function personPicker(container, users, onPick, selectedId) {
  container.innerHTML = `<div class="search">${icon('search')}<input placeholder="Search people" id="pp-q" autocomplete="off"></div><div class="picker-list" id="pp-list"></div>`;
  const render = (q = '') => {
    const ql = q.toLowerCase();
    const list = users.filter((u) => !ql || u.name.toLowerCase().includes(ql) || (u.email || '').toLowerCase().includes(ql) || (u.department || '').toLowerCase().includes(ql));
    $('#pp-list', container).innerHTML = list.length ? list.map((u) => `<button type="button" data-id="${u.id}" class="${u.id === selectedId ? 'on' : ''}"><span class="avatar sm">${esc(initials(u.name))}</span><span class="grow"><strong>${esc(u.name)}</strong><br><span class="small muted">${esc(u.department || u.email || '')}</span></span>${u.id === selectedId ? icon('check', 'chev') : ''}</button>`).join('') : '<div class="empty small">No match</div>';
  };
  render();
  $('#pp-q', container).oninput = (e) => render(e.target.value);
  $('#pp-list', container).onclick = (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; selectedId = Number(b.dataset.id); onPick(users.find((u) => u.id === selectedId)); render($('#pp-q', container).value); };
}
// Employees never create a permanent assignment directly: they ask IT. Shows the approval notice, and only on
// "Send request" records a request (no assignment, no check-out). Resolves true when the request was sent.
async function requestPermanentAssignment(asset, message, catalogNodeId) {
  const ok = await confirmSheet('Permanent assignment requires approval', 'Permanent equipment assignments must be approved by IT.', 'Send request');
  if (!ok) return false;
  await api('POST', '/api/requests', { asset_id: asset.id, category: asset.category, catalog_node_id: catalogNodeId || undefined, message: message || undefined, requested_assignment_type: 'permanent' });
  toast('Request sent to IT. Nothing is assigned until IT approves it.');
  refreshBadge();
  return true;
}
// Return date (required) + time (optional) for a temporary checkout. "Today" just fills in today's date.
function returnFields() {
  const def = S.settings.default_loan_days;
  return `<div class="field"><span>Return date *</span><div class="row" style="gap:8px"><input type="date" name="due_date" min="${localToday()}" value="${def ? addDays(def) : ''}" required style="flex:1"><button type="button" class="btn sm" data-today>Today</button></div></div>
    <label class="field"><span>Return time <span class="muted">(optional)</span></span><input type="time" name="due_time"></label>`;
}
function wireReturnFields(el) {
  const btn = $('[data-today]', el); const date = $('input[name=due_date]', el);
  if (btn) btn.onclick = () => { date.value = localToday(); };
}
// Assignment type: Permanent (admin only, no return date/time) or Temporary checkout (return date required).
function assignTypeFields() {
  return `<div class="field"><span>Assignment type</span><div class="chips" data-type><button type="button" class="chip" data-t="permanent">Permanent</button><button type="button" class="chip on" data-t="checkout">Temporary checkout</button></div>
    <input type="hidden" name="assignment_type" value="checkout"><div class="small muted" data-type-hint style="margin-top:6px">Temporary custody. A return date is required.</div></div>
    <div data-due-wrap class="form-grid">${returnFields()}</div>`;
}
function wireAssignType(el) {
  const box = $('[data-type]', el); const wrap = $('[data-due-wrap]', el);
  const hidden = $('input[name=assignment_type]', el); const hint = $('[data-type-hint]', el);
  const inputs = $$('input', wrap);
  const setType = (t) => {
    hidden.value = t;
    $$('.chip', box).forEach((c) => c.classList.toggle('on', c.dataset.t === t));
    wrap.style.display = t === 'checkout' ? '' : 'none';
    inputs.forEach((i) => { i.disabled = t !== 'checkout'; if (t !== 'checkout') i.value = ''; });
    if (t === 'checkout' && S.settings.default_loan_days) $('input[name=due_date]', wrap).value = addDays(S.settings.default_loan_days);
    hint.textContent = t === 'checkout' ? 'Temporary custody. A return date is required.' : 'Ongoing equipment for this person.';
  };
  box.onclick = (e) => { const b = e.target.closest('.chip'); if (b) setType(b.dataset.t); };
  wireReturnFields(wrap);
  setType('checkout');
}
function wireDueChips(el) {
  const box = $('[data-due]', el); if (!box) return;
  const input = box.parentElement.querySelector('input[type=date]');
  box.onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; input.value = b.dataset.v; $$('.chip', box).forEach((c) => c.classList.toggle('on', c === b)); };
  input.oninput = () => $$('.chip', box).forEach((c) => c.classList.toggle('on', c.dataset.v === input.value));
}

async function checkoutSheet(asset, done, presetUser) {
  const users = await getUsers();
  let picked = presetUser || null;
  const { el, close } = sheet(`<h2>Check out</h2><p class="muted small" style="margin-top:0">${esc(asset.name)} · <span class="mono">${esc(asset.tag)}</span></p>
    <form class="form-grid" id="f">
      <div><div class="small muted" style="font-weight:650;margin-bottom:6px">Who is it going to?</div><div id="pp"></div></div>
      ${assignTypeFields()}
      <label class="field"><span>Condition</span><select name="condition">${CONDITIONS.map((c) => `<option ${c === (asset.condition || 'Good') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>Note (optional)</span><input name="notes" placeholder="e.g. includes charger and bag"></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go" ${picked ? '' : 'disabled'}>Check out</button></div>
    </form>`);
  const updateBtn = () => { const b = $('#go', el); b.disabled = !picked; b.textContent = picked ? `Check out to ${picked.name.split(' ')[0]}` : 'Choose a person'; };
  personPicker($('#pp', el), users, (u) => { picked = u; updateBtn(); }, picked?.id);
  updateBtn(); wireAssignType(el);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault(); if (!picked) return;
    const fd = Object.fromEntries(new FormData(e.target));
    busy($('#go', el), async () => {
      await api('POST', `/api/assets/${asset.id}/checkout`, { ...fd, employee_id: picked.id });
      close(); if (done) await done(); // the refresh (route) clears open sheets, so show the modal after it
      assignedSheet(asset, picked, fd);
    });
  };
}
// Employee self-checkout details for `a` (always a temporary checkout; permanent turns into a request to IT).
// "Scan barcode" reuses the app's one scanner (openScanner) and the same tag/serial lookup as everywhere else; a scan
// swaps the sheet to the scanned asset, so the return-date rules and the server's permission check stay the same.
function selfCheckoutSheet(a) {
  const back = () => (location.hash.split('?')[0] === `#/asset/${a.id}` ? route(true) : go('#/asset/' + a.id + ctxQuery()));
  const { el, close } = sheet(`<h2>Check this out to you?</h2><p class="muted small" style="margin-top:0">${esc(a.name)} (${esc(a.tag)}). IT will be notified.</p>
    <button type="button" class="btn sm" id="self-scan" style="margin-bottom:12px">${icon('scan')} Scan barcode</button>
    <form class="form-grid" id="f">
    <div class="field"><span>How long do you need it?</span><div class="chips" data-self-type><button type="button" class="chip on" data-t="checkout">Temporary checkout</button><button type="button" class="chip" data-t="permanent">Permanent</button></div>
      <div class="small muted" data-self-hint style="margin-top:6px">Borrow it and bring it back by the return date.</div></div>
    <div data-self-due class="form-grid">${returnFields()}</div>
    <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Check out now</button></div></form>`);
  wireReturnFields(el);
  $('#self-scan', el).onclick = () => openScanner({ title: 'Scan the item to check out', onResult: async (code) => {
    try {
      const r = await api('GET', '/api/assets/lookup/' + encodeURIComponent(code));
      if (r.unavailable) return toast("That item isn't available to check out right now. You can request it from IT.", true);
      if (!r.found) return toast(`No asset found for ${code}`, true);
      const d = await api('GET', '/api/assets/' + r.id);
      const n = d.asset;
      if (d.is_mine) return toast(`${n.name} is already checked out to you.`, true);
      if (n.archived_at || n.status !== 'available' || d.capacity - d.seats_used < 1) return toast(`${n.name} isn't available to check out right now. You can request it from IT.`, true);
      close(); selfCheckoutSheet(n);
    } catch (e) { fail(e); }
  } });
  let mode = 'checkout';
  const dueWrap = $('[data-self-due]', el);
  $('[data-self-type]', el).onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    mode = b.dataset.t;
    $$('[data-self-type] .chip', el).forEach((c) => c.classList.toggle('on', c === b));
    dueWrap.style.display = mode === 'checkout' ? '' : 'none';
    $$('input', dueWrap).forEach((i) => { i.disabled = mode !== 'checkout'; });
    $('[data-self-hint]', el).textContent = mode === 'checkout' ? 'Borrow it and bring it back by the return date.' : 'Permanent assignments must be approved by IT. You can send a request.';
    $('#go', el).textContent = mode === 'checkout' ? 'Check out now' : 'Request permanent assignment';
  };
  $('#f', el).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
    busy($('#go', el), async () => {
      if (mode === 'permanent') { if (await requestPermanentAssignment(a)) { close(); back(); } return; }
      await api('POST', `/api/assets/${a.id}/checkout`, { due_date: fd.due_date, due_time: fd.due_time }); close(); toast("It's yours! Check your email for details."); back();
    }); };
}
// Shown after an admin assigns equipment; the admin chooses where to go next (nothing redirects on its own).
function assignedSheet(asset, person, fd) {
  const kind = fd.assignment_type === 'permanent' ? 'Permanent' : `Temporary checkout · return by ${fmtDate(fd.due_date)}${fd.due_time ? ' ' + fmtClock(fd.due_time) : ''}`;
  const { el, close } = sheet(`<h2>Equipment assigned</h2>
    <div class="holder" style="margin:12px 0"><div class="thumb">${icon('check')}</div><div><strong>${esc(asset.name)}</strong> <span class="mono small muted">${esc(asset.tag)}</span><div class="small muted">Assigned to <strong>${esc(person.name)}</strong> · ${esc(kind)}</div></div></div>
    <div class="sheet-actions"><button type="button" class="btn" id="to-assets">Back to assets</button><button type="button" class="btn primary" id="to-person">View employee</button></div>`);
  $('#to-person', el).onclick = () => { close(); go('#/person/' + person.id); };
  $('#to-assets', el).onclick = () => { close(); go('#/assets'); };
}
function checkinSheet(asset, holders, done) {
  const { el, close } = sheet(`<h2>Check in</h2><p class="muted small" style="margin-top:0">${esc(asset.name)} · <span class="mono">${esc(asset.tag)}</span></p>
    <form class="form-grid" id="f">
      ${holders.length > 1 ? `<label class="field"><span>Returned by</span><select name="assignment_id">${holders.map((h) => `<option value="${h.id}">${esc(h.user_name)} (${esc(TYPE_LABEL[h.assignment_type])})</option>`).join('')}</select></label>`
        : `<input type="hidden" name="assignment_id" value="${holders[0].id}"><div class="holder"><div class="avatar">${esc(initials(holders[0].user_name))}</div><div><strong>${esc(holders[0].user_name)}</strong><div class="small muted">${typeText(holders[0])} · since ${fmtStamp(holders[0].checked_out_at)}</div></div></div>`}
      <label class="field"><span>Condition now</span><select name="condition">${CONDITIONS.map((c) => `<option ${c === (asset.condition || 'Good') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>Put it back at</span><input name="location" list="locs" value="${esc(asset.location || '')}"><datalist id="locs">${S.settings.locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></label>
      <label class="check"><input type="checkbox" name="to_maintenance"><span>Needs repair — mark it <strong>In repair</strong></span></label>
      <label class="field"><span>Note (optional)</span><input name="notes" placeholder="e.g. missing charger"></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Check in</button></div>
    </form>`);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.to_maintenance = !!fd.to_maintenance;
    busy($('#go', el), async () => { await api('POST', `/api/assets/${asset.id}/checkin`, fd); close(); toast('Checked in'); refreshBadge(); done && done(); });
  };
}
function requestReturnSheet(asset, holders, done) {
  const { el, close } = sheet(`<h2>Request return</h2><p class="muted small" style="margin-top:0">We'll email them and show a reminder in the app.</p>
    <form class="form-grid" id="f">
      ${holders.length > 1 ? `<label class="field"><span>From</span><select name="employee_id"><option value="">Everyone who has it (${holders.length})</option>${holders.map((h) => `<option value="${h.employee_id}">${esc(h.user_name)}</option>`).join('')}</select></label>`
        : `<input type="hidden" name="employee_id" value="${holders[0].employee_id}"><div class="holder"><div class="avatar">${esc(initials(holders[0].user_name))}</div><div><strong>${esc(holders[0].user_name)}</strong><div class="small muted">${esc(asset.name)} · ${esc(asset.tag)}</div></div></div>`}
      <label class="field"><span>Return by</span><div class="chips" data-due>${[[addDays(1), 'Tomorrow'], [addDays(3), '3 days'], [addDays(7), '1 week'], ['', 'No date']].map(([v, l], i) => `<button type="button" class="chip ${i === 2 ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
        <input type="date" name="needed_by" value="${addDays(7)}" min="${localToday()}" style="margin-top:8px"></label>
      <label class="field"><span>Message (optional)</span><textarea name="message" placeholder="e.g. Upgrading your laptop — please bring it to the IT room."></textarea></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icon('send')} Send request</button></div>
    </form>`);
  wireDueChips(el);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    busy($('#go', el), async () => { await api('POST', `/api/assets/${asset.id}/request-return`, Object.fromEntries(new FormData(e.target))); close(); toast('Return requested — email sent'); refreshBadge(); done && done(); });
  };
}
// Employee: ask to give back equipment they hold. Nothing is unassigned — IT checks it in once it is handed over.
function requestMyReturnSheet(asset, done) {
  const { el, close } = sheet(`<h2>Request return</h2><p class="muted small" style="margin-top:0">Let IT know you want to return <strong>${esc(asset.name)}</strong>. It stays assigned to you until IT checks it in.</p>
    <form class="form-grid" id="f">
      <label class="field"><span>Note for IT (optional)</span><textarea name="message" maxlength="500" placeholder="e.g. Getting a new laptop, leaving the company, no longer need it"></textarea></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icon('send')} Request return</button></div>
    </form>`);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    busy($('#go', el), async () => { await api('POST', `/api/assets/${asset.id}/my-return-request`, Object.fromEntries(new FormData(e.target))); close(); toast('Return requested. Drop it off with IT, then tap “I’ve dropped it off”.'); refreshBadge(); done && done(); });
  };
}
// Employee: a short description of what is wrong with equipment they hold. The asset is fixed, never chosen.
function reportIssueSheet(asset, done) {
  const { el, close } = sheet(`<h2>Report an issue</h2><p class="muted small" style="margin-top:0">Tell IT what is wrong. This does not change who has the item.</p>
    <form class="form-grid" id="f">
      <div class="holder">${icon('alert')}<div><strong>${esc(asset.name)}</strong>${asset.tag ? `<div class="small muted mono">${esc(asset.tag)}</div>` : ''}</div></div>
      <label class="field"><span>What's the problem?</span><textarea name="message" required maxlength="1000" placeholder="e.g. Screen flickers when I plug in the charger"></textarea></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icon('send')} Send to IT</button></div>
    </form>`);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    busy($('#go', el), async () => { await api('POST', `/api/assets/${asset.id}/report-issue`, Object.fromEntries(new FormData(e.target))); close(); toast('Issue sent to IT. You can follow it under Requests.'); refreshBadge(); done && done(); });
  };
}
// Request equipment. Picking ONE specific item (from its own page) keeps the simple sheet; everything else goes through the
// catalog: choose a level, then "any matching" or one specific available item.
function requestEquipmentSheet({ asset, category, forUser } = {}) {
  if (!asset) return requestFromCatalogSheet({ category, forUser });
  const { el, close } = sheet(`<h2>Request this item</h2><p class="muted small" style="margin-top:0">IT will get an email and follow up with you.</p>
    <form class="form-grid" id="f">
      <input type="hidden" name="asset_id" value="${asset.id}"><input type="hidden" name="category" value="${esc(asset.category)}"><div class="holder">${icon(catIcon(asset.category))}<div><strong>${esc(asset.name)}</strong><div class="small muted mono">${esc(asset.tag)}</div>${asset.catalog_path ? `<div class="small muted">${esc(asset.catalog_path.split(' > ').join(' › '))}</div>` : ''}</div></div>
      <label class="field"><span>Details</span><textarea name="message" placeholder="Anything IT should know?"></textarea></label>
      <label class="field"><span>Needed by (optional)</span><input type="date" name="needed_by" min="${localToday()}"></label>
      ${!forUser ? `<label class="check"><input type="checkbox" name="permanent"><span>I need this <strong>permanently</strong> (IT approves permanent assignments)</span></label>` : ''}
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icon('send')} Send to IT</button></div>
    </form>`);
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (forUser) fd.user_id = forUser.id;
    const permanent = !!fd.permanent; delete fd.permanent;
    if (permanent) { busy($('#go', el), async () => { if (await requestPermanentAssignment(asset, fd.message)) { close(); if (location.hash.startsWith('#/requests') || location.hash.startsWith('#/home')) route(true); } }); return; }
    busy($('#go', el), async () => { await api('POST', '/api/requests', fd); close(); toast('Request sent to IT'); refreshBadge(); if (location.hash.startsWith('#/requests') || location.hash.startsWith('#/home')) route(true); });
  };
}

// ============================================================ equipment catalog (shared by every screen)
// One tree and one API for phone and desktop. The tree is read whole (it is small) and cached only for the life of one screen.
const getCatalog = () => api('GET', '/api/catalog');
const rootNames = async () => { try { return (await getCatalog()).filter((n) => n.parent_id === null).map((n) => n.name); } catch { return S.settings.categories; } };
const crumbText = (path) => String(path || '').split(' > ').join(' › ');

// A drill-down chooser over the catalog. It is ONE implementation: it renders a column per level of the current path, and the
// stylesheet decides the presentation — on a phone only the deepest level is shown (big touch rows, a Back button and a
// breadcrumb); on a wide screen the levels sit side by side (Camera | Sony | A7 IV). Choosing a row selects that entry AND
// opens its children, so a person can stop at any level. onChange(id|null, entryRow|null) fires on every choice.
function mountCatalogChooser(root, rows, { value = null, onChange } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map();
  for (const r of rows) { const k = r.parent_id ?? 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r); }
  let path = [];
  for (let n = value && byId.get(value); n; n = byId.get(n.parent_id)) path.unshift(n.id);
  const render = (fromUser) => {
    const cols = [];
    for (let k = 0; k <= path.length; k++) {
      const list = kids.get(k === 0 ? 0 : path[k - 1]) || [];
      if (list.length) cols.push({ k, list });
    }
    const names = path.map((id) => byId.get(id).name);
    root.innerHTML = `<div class="cc">
      <div class="cc-top"><button type="button" class="cc-back" data-back ${path.length ? '' : 'hidden'} aria-label="Back">${icon('back')}<span>Back</span></button>
        <nav class="cc-crumbs" aria-label="Selected path"><button type="button" data-crumb="-1" class="${path.length ? '' : 'cur'}">All equipment</button>${names.map((n, i) => `<span aria-hidden="true">›</span><button type="button" data-crumb="${i}" class="${i === names.length - 1 ? 'cur' : ''}">${esc(n)}</button>`).join('')}</nav></div>
      <div class="cc-cols">${cols.map(({ k, list }, i) => `<div class="cc-col${i === cols.length - 1 ? ' cc-last' : ''}" role="group" aria-label="Level ${i + 1}">${list.map((r) => {
        const has = r.child_count > 0; const on = path[k] === r.id;
        return `<button type="button" class="cc-row${on ? ' on' : ''}" data-level="${k}" data-id="${r.id}" ${on ? 'aria-current="true"' : ''}><span class="cc-name">${esc(r.name)}</span><span class="cc-meta">${r.available_count ? `${r.available_count} available` : 'None available'}</span>${has ? icon('chev', 'chev') : (on ? icon('check', 'chev') : '')}</button>`;
      }).join('')}</div>`).join('')}</div>
    </div>`;
    const colsEl = $('.cc-cols', root);
    if (fromUser) { $$('.cc-col', root).forEach((c) => { c.scrollTop = 0; }); colsEl.scrollLeft = colsEl.scrollWidth; }
  };
  const emit = () => { const id = path[path.length - 1] ?? null; onChange && onChange(id, id ? byId.get(id) : null); };
  root.onclick = (e) => {
    const row = e.target.closest('.cc-row'); const crumb = e.target.closest('[data-crumb]'); const back = e.target.closest('[data-back]');
    if (row) path = [...path.slice(0, Number(row.dataset.level)), Number(row.dataset.id)];
    else if (crumb) path = path.slice(0, Number(crumb.dataset.crumb) + 1);
    else if (back) path = path.slice(0, -1);
    else return;
    render(true); emit();
  };
  render(false);
  if (path.length) emit(); // a pre-selected entry counts as chosen
  return { get id() { return path[path.length - 1] ?? null; } };
}

// The employee request flow over the catalog. ONE set of logic, two arrangements of the same pieces:
//   wide screens   one screen — the cascading columns on the left, and on the right (in the space the columns don't use) the
//                  request details for whatever level is selected: path, any-matching vs a specific item, notes, Send.
//                  Any level is requestable at once, with or without children — there is no "Continue".
//   narrow screens two steps — (1) drill through one level at a time, (2) the same details panel, full width.
// The server re-checks everything; nothing here decides what an employee may request.
async function requestFromCatalogSheet({ category, forUser } = {}) {
  let rows;
  try { rows = await getCatalog(); } catch (e) { return fail(e); }
  const startRoot = category && rows.find((r) => r.parent_id === null && r.name.toLowerCase() === String(category).toLowerCase());
  const st = { id: startRoot ? startRoot.id : null, row: startRoot || null, scope: 'any', assetId: null, items: null, itemsFor: null, message: '', needed_by: '' };
  const split = rows.length > 0 && window.matchMedia('(min-width: 900px)').matches;
  const { el, close } = sheet(`<div class="rq"><div class="rq-head"><h2 id="rq-title"></h2><p class="muted small" id="rq-sub" style="margin:2px 0 0"></p></div><div class="rq-body" id="rq-body"></div><div class="rq-foot" id="rq-foot"></div></div>`, { wide: true });
  el.classList.add('tall');
  if (split) el.classList.add('split');
  const T = (sel) => $(sel, el);
  const to = (path) => location.hash.startsWith(path);
  const done = () => { close(); toast('Request sent to IT'); refreshBadge(); if (to('#/requests') || to('#/home')) route(true); };
  let loadToken = 0;

  // The request-details panel for the selected level (or, when the catalog is empty, a plain "what do you need" field).
  const panelHtml = (r, inline) => `${r ? `<div class="rq-picked"><div class="grow"><div class="small muted">You are requesting</div><div class="rq-path">${esc(crumbText(r.path))}</div></div>${inline ? '' : '<button type="button" class="btn sm" id="rq-change">Change</button>'}</div>` : ''}
    <form class="form-grid" id="f" style="margin-top:14px">
      ${r ? `<fieldset class="rq-scope"><legend>How specific?</legend>
        <label class="rq-opt"><input type="radio" name="scope" value="any" ${st.scope === 'any' ? 'checked' : ''}><span><strong>Any matching asset</strong><br><span class="small muted">${r.available_count ? `${r.available_count} available right now. ` : 'None are free right now. '}IT will choose a suitable one.</span></span></label>
        <label class="rq-opt" id="rq-spec-opt"><input type="radio" name="scope" value="specific" ${st.scope === 'specific' ? 'checked' : ''} disabled><span><strong>A specific item</strong><br><span class="small muted" id="rq-spec-hint">Checking what is available…</span></span></label>
        <div class="picker-list rq-items" id="rq-items" hidden></div>
        <div class="rq-selected" id="rq-selected" hidden aria-live="polite"></div></fieldset>`
      : `<label class="field"><span>What do you need?</span><input name="category" required maxlength="120" placeholder="e.g. Second monitor, USB-C hub"></label>`}
      <label class="field"><span>Details</span><textarea name="message" placeholder="e.g. Second monitor for my desk, USB-C if possible">${esc(st.message)}</textarea></label>
      <label class="field"><span>Needed by (optional)</span><input type="date" name="needed_by" min="${localToday()}" value="${esc(st.needed_by)}"></label>
      <label class="check" id="rq-perm" hidden><input type="checkbox" name="permanent"><span>I need this <strong>permanently</strong> (IT approves permanent assignments)</span></label>
      ${inline ? `<div class="sheet-actions" style="margin-top:4px"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="go">${icon('send')} Send to IT</button></div>` : ''}
    </form>`;

  const paintItems = () => {
    const box = T('#rq-items'); const hint = T('#rq-spec-hint'); const opt = T('#rq-spec-opt input');
    if (!box || !hint || !st.items) return; // not rendered (yet), or the panel moved on
    if (st.items.length) {
      opt.disabled = false;
      hint.textContent = `Pick one of ${st.items.length === 60 ? '60+' : st.items.length} available`;
      // Whole row is the tap target; the right-hand "Select" / "Selected" pill says so out loud.
      box.innerHTML = st.items.map((a) => { const on = st.assetId === a.id; return `<button type="button" data-id="${a.id}" class="${on ? 'on' : ''}" aria-pressed="${on}">${thumbHtml(a.thumb, a.category)}<span class="grow"><strong>${esc(a.name)}</strong><br><span class="small muted"><span class="mono">${esc(a.tag)}</span>${a.condition ? ' · ' + esc(a.condition) : ''}${a.location ? ' · ' + esc(a.location) : ''}</span></span><span class="rq-pick${on ? ' on' : ''}">${on ? `${icon('check')} Selected` : 'Select'}</span></button>`; }).join('');
    } else { opt.disabled = true; hint.textContent = 'No individual items are available to pick right now.'; }
    syncScope();
  };
  const syncScope = () => {
    const f = T('#f'); if (!f || !f.scope) return;
    const specific = f.scope.value === 'specific' && !!st.items && st.items.length > 0;
    T('#rq-items').hidden = !specific;
    if (!specific) f.scope.value = 'any'; // (a specific item with nothing to pick can't stay selected)
    const perm = T('#rq-perm'); if (perm) perm.hidden = !(specific && st.assetId && !forUser);
    if (!specific) st.assetId = null; // back to "Any matching" forgets the specific choice
    // Summary of the choice, and no sending a "specific item" request until an item is really chosen.
    const chosen = specific && st.items.find((a) => a.id === st.assetId);
    const sum = T('#rq-selected'); sum.hidden = !specific;
    sum.innerHTML = chosen ? `<span class="rq-sel-ok">${icon('check')}</span><span><span class="small muted">Selected item</span><br><strong>${esc(chosen.name)}</strong> <span class="mono small muted">${esc(chosen.tag)}</span></span>` : '<span class="small muted">Choose an item from the list above.</span>';
    sum.classList.toggle('ok', !!chosen);
    const go = T('#go'); if (go) go.disabled = specific && !chosen;
  };
  // Available items under the selected level, fetched once per level (a stale answer for a level the person has left is dropped).
  const loadItems = async (r) => {
    if (st.itemsFor === r.id && st.items) return paintItems();
    const mine = ++loadToken; st.items = null; st.itemsFor = r.id;
    let list;
    try { list = (await api('GET', `/api/assets?catalog_node=${r.id}&status=available&available=1`)).slice(0, 60); } catch { list = []; }
    if (mine !== loadToken) return;
    st.items = list; paintItems();
  };
  const wirePanel = (onChange) => {
    const f = T('#f'); const r = st.row;
    f.addEventListener('input', (e) => { if (e.target.name === 'message') st.message = e.target.value; if (e.target.name === 'needed_by') st.needed_by = e.target.value; });
    if (r) {
      f.addEventListener('change', (e) => { if (e.target.name === 'scope') { st.scope = e.target.value; syncScope(); paintItems(); } }); // repaint: leaving "specific" must visibly forget the chosen row
      T('#rq-items').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; st.assetId = Number(b.dataset.id); paintItems(); };
      loadItems(r);
    }
    f.onsubmit = (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f));
      const body = { message: fd.message, needed_by: fd.needed_by };
      if (r) body.catalog_node_id = r.id; else body.category = fd.category;
      if (forUser) body.user_id = forUser.id;
      if (r && fd.scope === 'specific') {
        if (!st.assetId) return toast('Choose which item you want, or pick “Any matching asset”.', true);
        body.asset_id = st.assetId;
      }
      if (fd.permanent && body.asset_id) {
        const a = st.items.find((x) => x.id === body.asset_id);
        return busy(T('#go'), async () => { if (await requestPermanentAssignment(a, body.message, r.id)) { close(); if (to('#/requests') || to('#/home')) route(true); } });
      }
      busy(T('#go'), async () => { await api('POST', '/api/requests', body); done(); });
    };
  };
  const onChoose = (id, row) => { st.id = id; st.row = row; st.items = null; st.itemsFor = null; st.scope = 'any'; st.assetId = null; };

  // ---- wide: one screen
  const splitScreen = () => {
    T('#rq-title').textContent = forUser ? `Request equipment for ${forUser.name}` : 'Request equipment';
    T('#rq-sub').textContent = 'Choose a category and narrow down as far as you like — you can request at any level.';
    T('#rq-body').innerHTML = '<div class="rq-split"><div class="rq-left" id="cc-mount"></div><aside class="rq-right" id="rq-panel" aria-label="Request details"></aside></div>';
    T('#rq-foot').remove();
    const paintPanel = () => {
      const panel = T('#rq-panel');
      if (!st.row) { panel.innerHTML = '<div class="rq-hint">Choose a category on the left. The request form appears here.</div>'; return; }
      panel.innerHTML = panelHtml(st.row, true);
      wirePanel();
    };
    mountCatalogChooser(T('#cc-mount'), rows, { value: st.id, onChange: (id, row) => { onChoose(id, row); paintPanel(); } });
    paintPanel();
  };

  // ---- narrow: two steps
  const pickStep = () => {
    T('#rq-title').textContent = forUser ? `Request equipment for ${forUser.name}` : 'Request equipment';
    T('#rq-sub').textContent = rows.length ? 'Start broad, then narrow down. You can stop at any level.' : '';
    T('#rq-body').innerHTML = rows.length ? '<div id="cc-mount"></div>' : '<p class="muted">The equipment list is empty. Describe what you need on the next screen.</p>';
    T('#rq-foot').innerHTML = `<div class="rq-sel" id="rq-sel"></div><div class="sheet-actions" style="margin-top:10px"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="rq-next">Continue</button></div>`;
    const paint = () => {
      T('#rq-sel').innerHTML = st.row ? `<span class="muted small">Selected</span> <strong>${esc(crumbText(st.row.path))}</strong>` : '<span class="muted small">Choose what you need</span>';
      T('#rq-next').disabled = rows.length > 0 && !st.row;
    };
    if (rows.length) mountCatalogChooser(T('#cc-mount'), rows, { value: st.id, onChange: (id, row) => { onChoose(id, row); paint(); } });
    paint();
    T('#rq-next').onclick = detailStep;
  };
  const detailStep = () => {
    T('#rq-title').textContent = 'Request details';
    T('#rq-sub').textContent = '';
    T('#rq-body').innerHTML = panelHtml(st.row, false);
    T('#rq-foot').innerHTML = `<div class="sheet-actions" style="margin-top:0"><button type="button" class="btn" id="rq-back">${rows.length ? 'Back' : 'Cancel'}</button><button type="submit" form="f" class="btn primary" id="go">${icon('send')} Send to IT</button></div>`;
    T('#rq-back').onclick = rows.length ? pickStep : close;
    const ch = T('#rq-change'); if (ch) ch.onclick = pickStep;
    wirePanel();
  };

  if (split) splitScreen(); else if (rows.length) pickStep(); else detailStep();
}

async function assetPickerSheet({ title, filterCategory, catalogNode, onPick }) {
  const { el, close } = sheet(`<h2>${esc(title)}</h2>
    <div class="row" style="margin:12px 0 0"><div class="search grow">${icon('search')}<input id="ap-q" placeholder="Search available assets" autocomplete="off"></div><button class="btn" id="ap-scan" type="button">${icon('scan')}</button></div>
    <div class="picker-list" id="ap-list"><div class="spinner"></div></div>
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button></div>`);
  const load = async (q = '') => {
    const u = new URLSearchParams({ status: 'available', available: '1' }); if (q) u.set('q', q); else if (catalogNode) u.set('catalog_node', catalogNode); else if (filterCategory) u.set('category', filterCategory);
    let rows = await api('GET', '/api/assets?' + u).catch(() => []); // the requested catalog entry may have been archived since
    if (!rows.length && (filterCategory || catalogNode) && !q) rows = await api('GET', '/api/assets?status=available&available=1');
    $('#ap-list', el).innerHTML = rows.length ? rows.map((a) => `<button data-id="${a.id}">${thumbHtml(a.thumb, a.category)}<span class="grow"><strong>${esc(a.name)}</strong><br><span class="small muted"><span class="mono">${esc(a.tag)}</span> · ${esc(a.category)}${a.license_seats > 1 ? ` · ${a.license_seats - a.seats_used} seats free` : ''}</span></span></button>`).join('') : '<div class="empty small">No available assets match.</div>';
  };
  load();
  $('#ap-q', el).oninput = debounce((e) => load(e.target.value.trim()));
  $('#ap-list', el).onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) { close(); onPick(Number(b.dataset.id)); } };
  $('#ap-scan', el).onclick = () => openScanner({ onResult: async (code) => {
    const r = await api('GET', '/api/assets/lookup/' + encodeURIComponent(code)).catch(fail);
    if (r && r.found) { close(); onPick(r.id); } else toast(`No asset found for ${code}`, true);
  } });
}

// ============================================================ asset form
// The Add asset Photos area: a large dashed drop zone (drag files onto it on a desktop, tap it on a phone) that shows the chosen photos as
// thumbnails. The buttons stay under the thumbnails so more can always be added; photos are optional.
const photoDropHtml = () => `<div class="ph-drop" id="ph-drop" role="group" aria-label="Photos">
  <div class="ph-hero" id="ph-hero">${icon('camera')}<strong>Add photos</strong><span class="small muted">Snap the device, its label or any damage.<span class="ph-dd"> Drag photos here, or choose them.</span></span></div>
  <div class="ph-pending" id="ph-pending" aria-live="polite"></div>
  <div class="ph-actions"><button type="button" class="btn" id="ph-cam">${icon('camera')} Take photos</button><button type="button" class="btn" id="ph-pick">${icon('upload')} Choose files</button><input type="file" accept="image/*" multiple hidden id="ph" aria-label="Choose photos"></div>
  <div class="small muted ph-count" id="ph-count"></div></div>`;
async function viewAssetForm(id) {
  const editing = !!id;
  // #/new?tag=… (a scanned label) and #/new?serial=… (a scanned manufacturer barcode) fill those fields in
  let a = { category: S.settings.categories[0] || 'Other', condition: 'Good', tag: qs().get('tag') || '', serial: qs().get('serial') || '' };
  if (editing) a = (await api('GET', '/api/assets/' + id)).asset;
  const nextTag = editing ? null : (await api('GET', '/api/next-tag')).tag;
  const rootList = await rootNames();
  const cats = rootList.includes(a.category) ? rootList : [...rootList, a.category];
  const f = (name, label, attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(a[name] ?? '')}" ${attrs}></label>`;
  main().innerHTML = `${backLink(editing ? '#/asset/' + id + ctxQuery() : '#/assets', 'Cancel')}
    <div class="page-head"><h1>${editing ? 'Edit asset' : 'Add an asset'}</h1></div>
    <form id="f" class="stack" autocomplete="off">
      <div class="card pad"><fieldset class="form-grid cols"><legend>The basics</legend>
        <label class="field full"><span>Name *</span><input name="name" required value="${esc(a.name || '')}" placeholder="e.g. Dell Latitude 7440"></label>
        <label class="field full"><span>Equipment catalog</span><input type="hidden" name="catalog_node_id" id="cnode" value="${a.catalog_node_id || ''}">
          <div class="cat-pick"><button type="button" class="btn grow cat-pick-btn" id="cpick">${icon('tag')}<span id="cpath">${a.catalog_path ? esc(crumbText(a.catalog_path)) : 'Not set — choose where this belongs'}</span></button><button type="button" class="btn" id="cclear" ${a.catalog_node_id ? '' : 'hidden'} aria-label="Clear catalog entry">${icon('x')}</button></div>
          <span class="small muted">Pick the most specific entry that fits, e.g. Camera › Sony › A7 IV. The category follows the top level.</span></label>
        <label class="field"><span>Category</span><select name="category" id="cat">${cats.map((c) => `<option ${c === a.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        ${editing
          ? `<label class="field"><span>Asset tag</span><input value="${esc(a.tag)}" class="mono" disabled title="Asset tags can't be changed once created"></label>`
          : `<label class="field"><span>Asset tag</span><div class="input-group"><input name="tag" value="${esc(a.tag || '')}" placeholder="${nextTag ? `Auto: ${esc(nextTag)}` : ''}" class="mono" autocapitalize="characters"><button type="button" class="btn" data-scan="tag" title="Scan barcode">${icon('scan')}</button></div></label>`}
        ${!editing ? `<div class="field full"><span>Photos <span class="muted small">(optional, up to 10)</span></span>${photoDropHtml()}</div>` : ''}
        ${!editing ? `<div class="field full"><span>Label</span><div class="row wrap" style="gap:14px;align-items:center"><div class="label-preview" id="lprev"></div>
          <div class="grow" style="min-width:180px"><button type="button" class="btn" id="plabel">${icon('printer')} Print label</button><div class="small muted" id="lhint" style="margin-top:6px"></div></div></div></div>` : ''}
      </fieldset></div>
      <div class="card pad"><fieldset class="form-grid cols"><legend>Details</legend>
        ${f('brand', 'Brand', 'placeholder="Dell, Apple, Logitech…"')}${f('model', 'Model')}
        <label class="field"><span>Serial number</span><div class="input-group"><input name="serial" value="${esc(a.serial || '')}" class="mono"><button type="button" class="btn" data-scan="serial" title="Scan serial barcode">${icon('scan')}</button></div></label>
        <label class="field"><span>Condition</span><select name="condition">${CONDITIONS.map((c) => `<option ${c === a.condition ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field full"><span>Location</span><input name="location" list="locs" value="${esc(a.location || '')}"><datalist id="locs">${S.settings.locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></label>
      </fieldset></div>
      <div class="card pad" id="lic"><fieldset class="form-grid cols"><legend>Software license</legend>
        <label class="field full"><span>License key</span><input name="license_key" value="${esc(a.license_key || '')}" class="mono"></label>
        ${f('license_seats', 'Number of seats', 'type="number" min="1" inputmode="numeric" placeholder="1"')}${f('license_expires', 'Expires / renews', 'type="date"')}
      </fieldset></div>
      <div class="card pad"><fieldset class="form-grid cols"><legend>Purchase &amp; warranty</legend>
        ${f('purchase_date', 'Purchase date', 'type="date"')}${f('purchase_cost', 'Cost (USD)', 'type="number" step="0.01" min="0" inputmode="decimal"')}
        ${f('vendor', 'Vendor', 'placeholder="CDW, Amazon, Dell…"')}${f('warranty_expires', 'Warranty ends', 'type="date"')}
      </fieldset></div>
      <div class="card pad"><fieldset class="form-grid"><legend>Employee access</legend>
        <label class="check full"><input type="checkbox" id="atr" ${a.available_to_request ? 'checked' : ''}><span><strong>Available to request</strong><span class="small muted" style="display:block">Show this asset to employees and allow checkout, requests, and reservations.</span></span></label>
        <label class="check full" id="rra-wrap"><input type="checkbox" id="rra" ${a.reservation_requires_approval ? 'checked' : ''}><span><strong>Require approval for reservations</strong><span class="small muted" style="display:block">Reservations for this asset must be approved by IT.<span id="rra-hint"></span></span></span></label>
      </fieldset></div>
      <div class="card pad"><label class="field"><span>Notes (admins only)</span><textarea name="notes">${esc(a.notes || '')}</textarea></label></div>
      <button class="btn primary lg block" id="save">${editing ? 'Save changes' : 'Add asset'}</button>
    </form>`;
  // "Require approval" only matters while the asset is available to request, so it is dimmed (not hidden, not reset) when that is off.
  const syncAccess = () => { const on = $('#atr').checked; $('#rra').disabled = !on; $('#rra-wrap').classList.toggle('dim', !on); $('#rra-hint').textContent = on ? '' : ' Has no effect until “Available to request” is on.'; };
  $('#atr').onchange = syncAccess; syncAccess();
  const catSel = $('#cat');
  const toggleLic = () => { const show = catSel.value === 'Software License' || /license|software|subscription/i.test(catSel.value) || a.license_key || a.license_seats; $('#lic').classList.toggle('hidden', !show); };
  catSel.onchange = toggleLic; toggleLic();
  const setCatalog = (id, pathText) => {
    $('#cnode').value = id || '';
    $('#cpath').textContent = id ? crumbText(pathText) : 'Not set — choose where this belongs';
    $('#cclear').hidden = !id;
    if (id) { const top = pathText.split(' > ')[0]; if (![...catSel.options].some((o) => o.value === top)) catSel.add(new Option(top, top)); catSel.value = top; }
    catSel.disabled = !!id; toggleLic();
  };
  if (a.catalog_node_id) catSel.disabled = true;
  $('#cclear').onclick = () => setCatalog(null);
  $('#cpick').onclick = async () => {
    let rows; try { rows = await getCatalog(); } catch (e) { return fail(e); }
    let picked = null;
    const { el: sh, close } = sheet(`<div class="rq"><div class="rq-head"><h2>Equipment catalog</h2><p class="muted small" style="margin:2px 0 0">Choose the most specific entry for this asset.</p></div><div class="rq-body" id="cc-mount"></div>
      <div class="rq-foot"><div class="rq-sel" id="rq-sel"><span class="muted small">Choose an entry</span></div><div class="sheet-actions" style="margin-top:10px"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="cuse" disabled>Use this entry</button></div></div></div>`, { wide: true });
    sh.classList.add('tall');
    mountCatalogChooser($('#cc-mount', sh), rows, { value: Number($('#cnode').value) || null, onChange: (id, row) => { picked = row; $('#cuse', sh).disabled = !row; $('#rq-sel', sh).innerHTML = row ? `<span class="muted small">Selected</span> <strong>${esc(crumbText(row.path))}</strong>` : '<span class="muted small">Choose an entry</span>'; } });
    $('#cuse', sh).onclick = () => { if (picked) setCatalog(picked.id, picked.path); close(); };
  };
  $$('[data-scan]').forEach((b) => b.onclick = () => openScanner({ title: b.dataset.scan === 'tag' ? 'Scan asset tag' : 'Scan serial number', onResult: (code) => { const input = $(`[name=${b.dataset.scan}]`); input.value = code; input.dispatchEvent(new Event('input')); toast('Scanned ' + code); } }));
  // The label (new assets): the tag in the field, else the next free number (a preview: nothing is reserved by opening the form, so a
  // cancelled form gives the same number to the next one). Print label with an empty field reserves the next number for this asset first.
  if (!editing) {
    const tagIn = $('[name=tag]');
    const drawLabel = () => {
      const tag = tagIn.value.trim() || nextTag;
      $('#lprev').innerHTML = labelHtml({ tag, category: catSel.value, name: $('[name=name]').value.trim() });
      drawBarcodes($('#lprev'));
      $('#lhint').textContent = tagIn.value.trim() ? 'Prints this tag.' : `${nextTag} is the next free number. Printing reserves it for this asset.`;
    };
    for (const el of [tagIn, $('[name=name]')]) el.addEventListener('input', debounce(drawLabel, 200));
    catSel.addEventListener('change', drawLabel);
    $('#plabel').onclick = () => busy($('#plabel'), async () => {
      if (!tagIn.value.trim()) {
        const [tag] = (await api('POST', '/api/tags/claim', { count: 1 })).tags;
        if (tag !== nextTag) toast(`${nextTag} was just taken, so this asset gets ${tag}`);
        tagIn.value = tag;
      }
      drawLabel();
      printLabels([{ tag: tagIn.value.trim(), category: catSel.value, name: $('[name=name]').value.trim() }]);
    });
    drawLabel();
  }
  // Photos for a NEW asset wait here (taken in the app or chosen from the device) and are uploaded once the asset exists.
  const pending = [];
  const drawPending = () => {
    const box = $('#ph-pending'); if (!box) return;
    box.innerHTML = pending.map((p, i) => `<div class="pc-th"><img src="${p.url}" alt="Photo ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remove photo ${i + 1}">${icon('x')}</button></div>`).join('');
    const full = pending.length >= 10;
    $('#ph-drop').classList.toggle('has', pending.length > 0);
    $('#ph-cam').disabled = full; $('#ph-pick').disabled = full;
    $('#ph-count').textContent = !pending.length ? '' : full ? '10 of 10 photos. Remove one to add another.' : `${pending.length} of 10 photos. Add more, or remove any with the ✕.`;
  };
  const addPending = (files) => {
    const room = 10 - pending.length;
    Array.from(files).slice(0, room).forEach((f) => pending.push({ file: f, url: URL.createObjectURL(f) }));
    if (files.length > room) toast('Up to 10 photos at a time.', true);
    drawPending();
  };
  const ph = $('#ph');
  if (ph) {
    ph.onchange = () => { addPending(ph.files); ph.value = ''; };
    $('#ph-pick').onclick = () => ph.click();
    $('#ph-hero').onclick = () => { if (pending.length < 10) ph.click(); }; // anywhere in the empty area opens the chooser
    const drop = $('#ph-drop'); let depth = 0; // (dragenter/leave also fire for children, so count them)
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    drop.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.classList.add('drag'); });
    drop.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    drop.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('drag'); });
    drop.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; drop.classList.remove('drag');
      const imgs = Array.from(e.dataTransfer.files).filter((f) => /^image\//.test(f.type));
      if (!imgs.length) return toast('Only photos can be added here.', true);
      if (imgs.length < e.dataTransfer.files.length) toast('Skipped files that are not photos.', true);
      addPending(imgs);
    });
    drawPending();
  }
  const phCam = $('#ph-cam'); if (phCam) phCam.onclick = () => openPhotoCapture({ max: 10 - pending.length, onDone: addPending });
  const phBox = $('#ph-pending'); if (phBox) phBox.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; const [p] = pending.splice(Number(b.dataset.rm), 1); if (p) URL.revokeObjectURL(p.url); drawPending(); };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {}; for (const [k, v] of fd.entries()) if (k !== 'photos') body[k] = v;
    body.available_to_request = $('#atr').checked; body.reservation_requires_approval = $('#rra').checked; // (a disabled checkbox is not in FormData, so read both directly)
    busy($('#save'), async () => {
      const saved = await api(editing ? 'PUT' : 'POST', editing ? '/api/assets/' + id : '/api/assets', body);
      const up = pending.length ? await uploadPhotos(saved.id, pending.map((p) => p.file)) : null;
      if (up && up.failed) toast(`Added ${saved.tag}, but ${up.failed} of ${pending.length} photo${pending.length > 1 ? 's were' : ' was'} NOT saved. Open the asset to add ${up.failed > 1 ? 'them' : 'it'} again.`, true);
      else toast(editing ? 'Saved' : `Added ${saved.tag}`);
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      if (!editing) history.replaceState(null, '', '#/assets');
      go('#/asset/' + saved.id + (editing ? ctxQuery() : ''));
    });
  };
}

// ============================================================ scan
function viewScan() {
  const scanned = (c) => handleScannedCode(c, srcQ('scan'));
  main().innerHTML = `<div class="page-head"><h1>Scan</h1></div>
    <div class="stack">
      <button class="card pad" id="go" style="width:100%;border:0;cursor:pointer;text-align:center;padding:36px 16px;background:var(--brand-ink);color:#fff">
        <div style="width:72px;height:72px;margin:0 auto 12px;border-radius:50%;background:var(--brand-accent);display:grid;place-items:center">${icon('scan').replace('<svg', '<svg style="width:34px;height:34px"')}</div>
        <div style="font-size:18px;font-weight:700">Tap to scan a barcode</div><div class="small" style="opacity:.7;margin-top:4px">Asset tags, serial numbers and QR codes</div></button>
      <div class="card pad"><form id="m" class="stack"><label class="field"><span>Have a handheld scanner or want to type it?</span>
        <div class="input-group"><input id="code" placeholder="Scan or type a tag / serial" autocomplete="off" autocapitalize="characters" enterkeyhint="go" class="mono"><button class="btn primary">Find</button></div></label></form></div>
      <p class="small muted" style="text-align:center">${isAdmin() ? 'Scanning a barcode that isn’t in the system yet lets you tag a new asset with it.' : 'Scan any tagged item to see it, check it out or request it.'}</p>
    </div>`;
  $('#go').onclick = () => openScanner({ onResult: scanned });
  $('#m').onsubmit = (e) => { e.preventDefault(); const v = $('#code').value.trim(); if (v) scanned(v); };
  if (window.matchMedia('(min-width: 900px)').matches) $('#code').focus();
  else if (!S.silent && !$('.scanner')) openScanner({ onResult: scanned }); // phones: jump straight into the camera
}

// ============================================================ employee reservations + equipment requests
// Two separate employee actions (docs/briefs/employee-reservations-requests.md):
//   Reserve equipment  = Browse (the equipment tree): open a specific item, see its availability calendar, reserve it or join its waitlist. Needs no scanner / self-checkout permission.
//   Request equipment  = the form below: "I need a piece of equipment" (one item), decided by IT. Nothing is ordered, reserved or assigned automatically.
// My reservations and My requests are the employee's own views; IT works the Equipment requests queue. The server decides every rule (src/equipmentRequests.js);
// this code only draws state and calls the endpoints.
function reserveEquipment() { go('#/assets'); } // (function declarations: ROUTES, defined far above, refers to the views below)
const EQ_CLASS = { submitted: 'open', in_review: 'in_review', approved: 'approved', ready: 'reserved', fulfilled: 'completed', declined: 'denied', cancelled: 'cancelled' };
const eqPill = (r) => pill(EQ_CLASS[r.status] || 'open', r.status === 'ready' ? 'Ready' : r.status_label);
const eqWhat = (r) => [r.category, r.brand, r.model].filter(Boolean).join(' › ');
const eqPermText = (r) => (!r.permanent_requested ? 'Shared equipment' : r.permanent_decision === 'approved' ? 'Permanent assignment: approved' : r.permanent_decision === 'denied' ? 'Permanent assignment: not approved' : 'Permanent assignment requested');
const EQ_EVENT = { submitted: 'Request submitted', opened: 'IT opened the request', approved: 'Approved by IT', declined: 'Declined by IT', ready: 'Marked ready: 48-hour priority hold started', permanent_approved: 'Permanent assignment approved', permanent_denied: 'Permanent assignment not approved',
  hold_expired: 'Priority hold ended unclaimed', hold_claimed: 'Reservation made during the hold: it keeps the unit', claim_ended: 'The reservation ended before the equipment was issued', hold_declined: 'Employee declined the ready unit', hold_released: 'IT released the hold', claimed_by_reservation: 'Claimed by a reservation', checked_out: 'Checked out', assigned_permanently: 'Assigned permanently', fulfilled: 'Fulfilled', cancelled: 'Cancelled', cancelled_by_it: 'Cancelled by IT', note: 'Note added' };

// A compact, searchable dropdown (closed by default; the closed button shows the choice). `options` = [{ id, label }]; `extra` = rows pinned under the list
// ({ value, label }, e.g. Other); `custom` lets the typed text itself be chosen ("Use “…”"); `none` adds a "No preference" row. onChange gets
// { id, label } (a listed option), { custom: true, label } (typed text), { extra: value } or null (cleared). The list is short and scrolls inside itself.
function mountCombo(root, { options, value = null, placeholder = 'Choose…', searchPlaceholder = 'Search…', extra = [], custom = false, none = '', onChange }) {
  let cur = value; let open = false;
  const shown = () => (cur ? cur.label : '');
  root.innerHTML = `<div class="cb"><button type="button" class="cb-btn" aria-haspopup="listbox" aria-expanded="false"><span class="cb-val${cur ? '' : ' ph'}">${esc(shown() || placeholder)}</span>${icon('chev', 'cb-chev')}</button>
    <div class="cb-pop" hidden><div class="search">${icon('search')}<input type="search" class="cb-q" placeholder="${esc(searchPlaceholder)}" autocomplete="off" aria-label="${esc(searchPlaceholder)}"></div><ul class="cb-list" role="listbox"></ul></div></div>`;
  const btn = $('.cb-btn', root); const pop = $('.cb-pop', root); const q = $('.cb-q', root); const list = $('.cb-list', root);
  const rows = () => {
    const t = q.value.trim().toLowerCase();
    const hit = options.filter((o) => !t || o.label.toLowerCase().includes(t));
    const out = [];
    if (none && !t) out.push({ none: true, label: none });
    out.push(...hit.map((o) => ({ pick: o })));
    if (custom && q.value.trim() && !options.some((o) => o.label.toLowerCase() === t)) out.push({ typed: q.value.trim(), label: `Use “${q.value.trim()}”` });
    out.push(...extra.filter((x) => !t || x.label.toLowerCase().includes(t)).map((x) => ({ extra: x })));
    return out;
  };
  const paint = () => {
    const r = rows();
    list.innerHTML = r.length ? r.map((x, i) => `<li role="option" aria-selected="${!!(cur && x.pick && cur.id === x.pick.id)}"><button type="button" data-i="${i}">${esc(x.pick ? x.pick.label : x.label || x.extra.label)}</button></li>`).join('') : '<li class="cb-empty">Nothing matches</li>';
    list._rows = r;
  };
  const set = (v) => { cur = v; const s = $('.cb-val', root); s.textContent = shown() || placeholder; s.classList.toggle('ph', !cur); };
  const toggle = (on) => {
    open = on; pop.hidden = !on; btn.setAttribute('aria-expanded', String(on));
    if (on) { q.value = ''; paint(); list.scrollTop = 0; q.focus({ preventScroll: true }); }
  };
  const choose = (x) => {
    if (!x) return;
    const v = x.none ? null : x.pick ? { id: x.pick.id, label: x.pick.label } : x.typed ? { custom: true, label: x.typed } : { extra: x.extra.value, label: x.extra.label };
    set(v); toggle(false); btn.focus({ preventScroll: true }); onChange && onChange(v);
  };
  btn.onclick = () => toggle(!open);
  q.oninput = paint;
  q.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); toggle(false); btn.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose((list._rows || [])[0]); }
  };
  list.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) choose(list._rows[Number(b.dataset.i)]); };
  const outside = (e) => { if (!root.isConnected) document.removeEventListener('mousedown', outside, true); else if (open && !root.contains(e.target)) toggle(false); };
  document.addEventListener('mousedown', outside, true);
  return { set };
}

// The "Request equipment" form: a category from a compact searchable list (every catalog category, or Other = free text), optional brand and model (chosen from
// the catalog entries under the category, or typed), optional details, and the "Request permanent assignment" toggle (off by default). One item per request.
async function requestNeedSheet() {
  let rows = [];
  try { rows = await getCatalog(); } catch { /* the form still works with Other */ }
  const kids = (id) => rows.filter((r) => r.parent_id === id).map((r) => ({ id: r.id, label: r.name }));
  const roots = kids(null).filter((r) => r.label.toLowerCase() !== 'other'); // (the one "Other" below is the free-text choice)
  const st = { cat: null, other: !roots.length, brand: null, model: null };
  const { el, close } = sheet(`<h2>Request equipment</h2><p class="muted small" style="margin:2px 0 0">One item per request. IT reviews it and decides; nothing is ordered or assigned automatically.</p>
    <form class="form-grid eq-grid" id="f">
      <div class="field eq-full"><span>Category</span><div id="cb-cat"></div></div>
      <label class="field eq-full" id="cat-other" hidden><span>What kind of equipment?</span><input name="category_other" maxlength="120" placeholder="e.g. Standing desk converter" autocomplete="off"></label>
      <div class="field" id="slot-brand"></div><div class="field" id="slot-model"></div>
      <label class="field eq-full"><span>Additional details (optional)</span><textarea name="details" rows="3" maxlength="1000" placeholder="Anything IT should know?"></textarea></label>
      <label class="check eq-full"><input type="checkbox" name="permanent"><span><strong>Request permanent assignment</strong><br><span class="small muted">IT decides this separately. If it is not approved, you can still reserve the equipment as shared when it is ready.</span></span></label>
      <div class="sheet-actions eq-full"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icon('send')} Send to IT</button></div>
    </form>`);
  el.classList.add('eq-form');
  const f = $('#f', el);
  // Brand and model: a compact picker when the catalog has entries at that level, otherwise a plain optional text box. Typing is always allowed.
  const slot = (key, label, opts) => {
    const root = $(`#slot-${key}`, el);
    root.innerHTML = `<span>${label} (optional)</span><div id="cb-${key}"></div>`;
    if (opts.length) mountCombo($(`#cb-${key}`, root), { options: opts, value: st[key], placeholder: 'Any', searchPlaceholder: `Search or type a ${key}…`, custom: true, none: 'No preference', onChange: (v) => { st[key] = v; if (key === 'brand') { st.model = null; paintSlots(); } } });
    else { $(`#cb-${key}`, root).innerHTML = `<input name="${key}" maxlength="120" autocomplete="off" placeholder="Type a ${key}" value="${esc(st[key] ? st[key].label : '')}">`; $(`#cb-${key} input`, root).oninput = (e) => { st[key] = e.target.value.trim() ? { custom: true, label: e.target.value.trim() } : null; }; }
  };
  const paintSlots = () => {
    const brandOpts = !st.other && st.cat ? kids(st.cat.id) : [];
    slot('brand', 'Brand', brandOpts);
    slot('model', 'Model', st.brand && st.brand.id ? kids(st.brand.id) : []);
  };
  mountCombo($('#cb-cat', el), {
    options: roots, placeholder: 'Choose a category', searchPlaceholder: 'Search categories…', extra: [{ value: 'other', label: 'Other' }],
    onChange: (v) => {
      st.other = !!(v && v.extra === 'other'); st.cat = v && v.id ? v : null; st.brand = null; st.model = null;
      $('#cat-other', el).hidden = !st.other;
      if (st.other) $('#cat-other input', el).focus();
      paintSlots();
    },
  });
  if (!roots.length) { $('#cb-cat', el).innerHTML = '<div class="small muted">The equipment list is empty: describe what you need below.</div>'; $('#cat-other', el).hidden = false; }
  paintSlots();
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = { details: f.details.value, permanent: f.permanent.checked };
    if (st.other) { body.category_other = f.category_other.value.trim(); if (!body.category_other) return toast('Say what kind of equipment you need.', true); }
    else {
      if (!st.cat) return toast('Choose a category, or choose Other.', true);
      // the deepest catalog entry chosen; typed brand / model only fills a level the catalog choice left open
      body.catalog_node_id = (st.model && st.model.id) || (st.brand && st.brand.id) || st.cat.id;
    }
    if (st.brand && !st.brand.id) body.brand = st.brand.label;
    if (st.model && !st.model.id) body.model = st.model.label;
    busy($('#go', el), async () => { await api('POST', '/api/equipment-requests', body); close(); toast('Request sent to IT', false, 'ok'); refreshBadge(); go('#/my-requests'); });
  };
}

// How a request stands, in the words IT and employees see everywhere. The equipment decision and the permanent-assignment decision are INDEPENDENT.
const EQ_DECISION = { submitted: 'Submitted', in_review: 'In review', approved: 'Approved', ready: 'Approved', fulfilled: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };
const eqPermLabel = (r) => (!r.permanent_requested ? 'Not requested' : r.permanent_decision === 'approved' ? 'Approved' : r.permanent_decision === 'denied' ? 'Denied' : 'Pending decision');
// Ready is one of three things; an expired hold is never shown as active (hold_active is the server's clock, not the stored deadline).
const eqStage = (r) => (r.status !== 'ready' ? r.status_label : r.claimed_reservation_id ? 'Ready — claimed by reservation' : r.hold_active ? 'Ready — priority hold active' : 'Ready — no active priority hold');

// The request, its decisions, its history and what the viewer may do next. IT opening a submitted request moves it to In review (the server records it).
async function openEqDetail(id, { admin: asAdmin, reload }) {
  let r;
  try { r = await api('GET', '/api/equipment-requests/' + id); } catch (e) { return fail(e); }
  if (asAdmin && r.status === 'submitted') { try { r = await api('POST', `/api/equipment-requests/${id}/review`, {}); reload(); } catch { /* still show it */ } }
  const live = ['submitted', 'in_review', 'approved', 'ready'].includes(r.status);
  const first = (r.user_name || '').split(' ')[0] || 'the employee';
  const who = asAdmin ? r.user_name : 'You';
  const again = () => { reload(); openEqDetail(id, { admin: asAdmin, reload }); };
  const act = (verb, body = {}) => api('POST', `/api/equipment-requests/${id}/${verb}`, body);
  const unit = r.asset_label || 'the unit';
  const claimRange = r.claim ? resvRange(r.claim) : '';

  // ---- Decisions. Two independent decisions; picking an option only changes this screen: nothing is saved until "Save decisions".
  // Equipment: editable only while it is Submitted / In review (a saved approval is withdrawn with Cancel request, not toggled off).
  // Permanent assignment: editable until the equipment is issued or the unit is on hold; a saved answer is changed through "Edit decisions".
  const eEditable = asAdmin && ['submitted', 'in_review'].includes(r.status);
  const pEditable = asAdmin && r.permanent_requested && ['submitted', 'in_review', 'approved'].includes(r.status);
  const pSaved = r.permanent_decision === 'approved' ? 'approve' : r.permanent_decision === 'denied' ? 'deny' : 'pending';
  const sel = { e: 'pending', p: pSaved };
  const eText = r.status === 'declined' ? 'Declined' : r.status === 'cancelled' ? 'Cancelled' : ['approved', 'ready', 'fulfilled'].includes(r.status) ? '✓ Approved' : `Pending${r.status === 'in_review' ? ' (in review)' : ''}`;
  const pText = !r.permanent_requested ? 'Not requested' : r.permanent_decision === 'approved' ? '✓ Approved' : r.permanent_decision === 'denied' ? 'Denied' : 'Pending decision';
  const segHtml = (k, opts) => `<div class="dec-seg" role="radiogroup" data-k="${k}" style="--n:${opts.length}">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="false" data-v="${v}">${l}</button>`).join('')}</div>`;
  const dec = `<div class="dec"><h3>Decisions</h3>
    <div class="dec-row"><div class="lab">Equipment decision</div>
      ${eEditable ? segHtml('e', [['pending', 'Pending'], ['approve', 'Approve'], ['decline', 'Decline']]) : `<div class="dec-status">${esc(eText)}</div>`}
      ${asAdmin && !eEditable && ['approved', 'ready'].includes(r.status) ? '<div class="small muted">To withdraw an approval, use Cancel request below.</div>' : ''}</div>
    <div class="dec-row"><div class="lab">Permanent assignment decision</div>
      ${pEditable ? `<div id="p-ctl"${pSaved !== 'pending' ? ' hidden' : ''}>${segHtml('p', pSaved === 'pending' ? [['pending', 'Pending'], ['approve', 'Approve'], ['deny', 'Deny']] : [['approve', 'Approve'], ['deny', 'Deny']])}<div class="small muted" id="p-off" hidden>Not needed when the equipment request is declined.</div></div>
        <div id="p-done"${pSaved === 'pending' ? ' hidden' : ''}><div class="dec-status">${esc(pText)}</div><button type="button" class="btn sm" id="dec-edit" style="margin-top:8px">Edit decisions</button></div>`
      : `<div class="dec-status">${esc(pText)}</div>`}</div>
    ${asAdmin && live ? `<label class="field"><span>Note to ${esc(first)} (optional)</span><textarea name="note" id="dec-note" rows="2" maxlength="1000" placeholder="Optional. Saved in the history and shown to ${esc(first)}; it does not change any decision."></textarea></label>
    <button type="button" class="btn primary" id="dec-save" disabled>Save decisions</button>` : ''}
  </div>`;

  // ---- Actions, grouped. Fulfilment: how the equipment gets issued. Other: closing it. Never both a Decline and a Cancel.
  const fulfil = []; const other = [];
  if (!asAdmin) {
    if (r.status === 'ready' && r.hold_active && r.asset_shared) fulfil.push(`<button class="btn primary" id="a-reserve">${icon('calendar')} Reserve it</button>`);
    if (r.can_decline_ready) other.push('<button class="btn" id="a-declineready">Decline this equipment</button>');
    if (r.can_cancel) other.push('<button class="btn danger" id="a-cancel">Cancel request</button>');
  } else {
    if (r.status === 'approved' && r.track === 'shared') fulfil.push(`<button class="btn primary" id="a-ready">${icon('check')} Mark a unit ready (48-hour hold)</button><button class="btn" id="a-handed">Record as handed over (no inventory item)</button>`);
    if (r.status === 'approved' && r.track === 'permanent') fulfil.push(`<button class="btn primary" id="a-deliver">${icon('out')} Deliver &amp; assign permanently</button><button class="btn" id="a-handed">Record as delivered (not individually tracked)</button>`);
    if (r.status === 'ready') fulfil.push(`<button class="btn primary" id="a-checkout">${icon('out')} Issue to ${esc(first)}</button><button class="btn" id="a-handed">Record as handed over</button>`);
    if (r.status === 'ready') other.push(`<button class="btn" id="a-release">${r.hold_active ? 'End priority hold' : 'Return to Approved'}</button>`);
    if (['approved', 'ready'].includes(r.status)) other.push('<button class="btn danger" id="a-cancel">Cancel request</button>'); // (submitted / in review are declined above; fulfilled has no ordinary cancel)
  }
  const grp = (title, items) => (items.length ? `<div class="act-group"><h4>${title}</h4><div class="act-grid">${items.join('')}</div></div>` : '');
  const guide = !asAdmin || !live ? '' : r.status === 'submitted' || r.status === 'in_review' ? 'Decide the equipment request. If a permanent assignment was requested it is a separate decision: you can approve the equipment and deny permanent assignment.'
    : r.track === null ? 'The equipment is approved. Decide the permanent assignment before a unit can be readied or issued.'
    : r.status === 'approved' && r.track === 'permanent' ? 'Permanent assignment approved. Deliver the item and record the assignment. It is not put on hold and is not offered to anyone else.'
    : r.status === 'approved' ? `Shared equipment${r.permanent_requested ? ' (permanent assignment denied)' : ''}. Mark a unit ready to give ${first} a 48-hour priority hold. Reserving it is only a claim: the request is Fulfilled when the equipment is actually issued.` : '';
  const holdBox = r.status !== 'ready' ? '' : r.claimed_reservation_id
    ? `<div class="banner info">${icon('calendar')}<div class="grow small"><strong>Ready — claimed by reservation</strong><br>${esc(who)} reserved <strong>${esc(unit)}</strong>${claimRange ? ` for ${esc(claimRange)}` : ''}. The 48-hour priority hold has ended; the reservation protects only those dates. This request is Fulfilled when the equipment is actually issued.</div></div>`
    : r.hold_active
      ? `<div class="banner info">${icon('check')}<div class="grow small"><strong>48-hour priority hold active</strong><br>Priority: <strong>${esc(r.user_name)}</strong> · Unit: <strong>${esc(unit)}</strong><br>Hold ends: ${esc(r.hold_expires_text)}<br>Other employees cannot reserve or check out this unit until then. ${asAdmin ? 'Ending an unclaimed hold makes it generally available again.' : 'Reserve it, or ask IT to check it out.'}</div></div>`
      : `<div class="banner warn">${icon('alert')}<div class="grow small"><strong>Ready — no active priority hold</strong><br>The hold on <strong>${esc(unit)}</strong> has ended and nothing claimed it. The request returns to Approved shortly.</div></div>`;
  const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  let isDirty = () => false; // (set below, once the decision controls exist)
  const { el, close } = sheet(`<h2 style="overflow-wrap:anywhere">${esc(eqWhat(r))}</h2>
    <div class="row wrap" style="gap:8px;margin:4px 0 12px">${eqPill(r)}${r.status === 'ready' ? `<span class="small muted">${esc(eqStage(r))}</span>` : ''}</div>
    <div class="stack">
      ${holdBox}
      ${dec}
      <div class="kv">
        ${asAdmin ? row('Requested by', `${esc(r.user_name)}${r.user_department ? ' · ' + esc(r.user_department) : ''}`) : ''}
        ${row('Submitted', fmtWhen(r.created_at) + (r.category_other ? ' · category typed by the employee' : ''))}
        ${r.asset_label && r.status !== 'ready' ? row('Unit', esc(r.asset_label)) : ''}
        ${r.details ? row('Details', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.details)}</div>`) : ''}
        ${r.decision_note ? row('Note from IT', esc(r.decision_note)) : ''}
        ${r.permanent_note ? row('Permanent assignment note', esc(r.permanent_note)) : ''}
      </div>
      ${guide ? `<p class="small muted" style="margin:0">${esc(guide)}</p>` : ''}
      ${grp(asAdmin ? 'Fulfilment' : 'Your options', fulfil)}
      ${grp(asAdmin ? 'Other actions' : '', other)}
      ${asAdmin && r.status === 'approved' ? `<p class="small muted" style="margin:0">Not in inventory yet? <a href="#/new" id="a-new">Register the equipment</a>, then come back and pick it.</p>` : ''}
      <div><h3 style="margin:8px 0 4px;font-size:15px">History</h3><ul class="list">${r.events.map((ev) => `<li><div class="item"><div class="grow"><div class="title">${esc(EQ_EVENT[ev.action] || ev.action)}</div><div class="sub">${esc(ev.actor_name)} · ${fmtWhen(ev.created_at)}${ev.note ? ` · ${esc(ev.note)}` : ''}</div></div></div></li>`).join('')}</ul></div>
    </div>
    <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`, { closeX: true, dirty: () => isDirty() });
  const on = (sel2, fn) => { const b = $(sel2, el); if (b) b.onclick = (e) => fn(e.currentTarget); };
  const handled = (verb, body, msg) => (btn) => busy(btn, async () => { await act(verb, body); close(); toast(msg, false, 'ok'); refreshBadge(); again(); });
  const leave = () => close();
  const fresh = (verb, body, msg) => async (note) => { await act(verb, { ...body, note }); toast(msg, false, 'ok'); refreshBadge(); again(); };
  const confirmSheet = (title, text, label, onOk) => {
    leave();
    const s = sheet(`<h2>${esc(title)}</h2><p class="muted small" style="margin-top:0">${esc(text)}</p><div class="sheet-actions"><button type="button" class="btn" data-close>Keep it</button><button class="btn danger" id="go">${esc(label)}</button></div>`);
    $('#go', s.el).onclick = (e) => busy(e.currentTarget, async () => { await onOk(); s.close(); refreshBadge(); again(); });
  };

  // decision controls: choosing an option only repaints; "Save decisions" is the one mutation
  const permVisible = () => pEditable && !$('#p-ctl', el).hidden;
  const paint = () => {
    $$('.dec-seg', el).forEach((g) => $$('button', g).forEach((b) => {
      const k = g.dataset.k; const v = b.dataset.v; const onNow = sel[k] === v;
      b.classList.toggle('on', onNow); b.classList.toggle('ok', onNow && v === 'approve'); b.classList.toggle('no', onNow && (v === 'decline' || v === 'deny')); b.setAttribute('aria-checked', String(onNow));
    }));
    const declined = eEditable && sel.e === 'decline';
    if ($('#p-ctl', el)) { $('.dec-seg[data-k=p]', el).classList.toggle('off', declined); $('#p-off', el).hidden = !declined; }
    const save = $('#dec-save', el); if (!save) return;
    const pChange = permVisible() && !declined && sel.p !== 'pending' && sel.p !== pSaved;
    const hasNote = !!(($('#dec-note', el).value || '').trim());
    save.textContent = eEditable || permVisible() ? 'Save decisions' : 'Save note';
    save.disabled = !((eEditable && sel.e !== 'pending') || pChange || hasNote);
  };
  $$('.dec-seg', el).forEach((g) => g.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b || g.classList.contains('off')) return; sel[g.dataset.k] = b.dataset.v; paint(); }));
  on('#dec-edit', () => { $('#p-ctl', el).hidden = false; $('#p-done', el).hidden = true; paint(); });
  $('#dec-note', el)?.addEventListener('input', paint);
  on('#dec-save', () => {
    const note = ($('#dec-note', el).value || '').trim() || undefined;
    const pv = sel.p === 'approve' ? 'approved' : sel.p === 'deny' ? 'denied' : undefined;
    // a note and no decision change: just the note (no status or decision is touched)
    if (!(eEditable && sel.e !== 'pending') && !(permVisible() && sel.p !== 'pending' && sel.p !== pSaved)) return busy($('#dec-save', el), async () => { await act('note', { note }); close(); toast(`Note saved. ${first} has been told.`, false, 'ok'); refreshBadge(); again(); });
    if (eEditable && sel.e === 'decline') return confirmSheet('Decline equipment request', `${r.user_name} will be told and the request is closed. This can't be undone.`, 'Decline equipment request', async () => { await act('decline', { note }); toast('Equipment request declined', false, 'ok'); });
    if (eEditable && sel.e === 'approve') return busy($('#dec-save', el), async () => { await act('approve', { note, permanent_decision: permVisible() && pv && pv !== r.permanent_decision ? pv : undefined }); close(); toast('Decisions saved. They have been told.', false, 'ok'); refreshBadge(); again(); });
    busy($('#dec-save', el), async () => { await act('permanent', { decision: pv, note }); close(); toast('Decisions saved. They have been told.', false, 'ok'); refreshBadge(); again(); });
  });
  paint();
  isDirty = () => !!((eEditable && sel.e !== 'pending') || (permVisible() && sel.p !== 'pending' && sel.p !== pSaved) || (($('#dec-note', el)?.value || '').trim()));

  on('#a-reserve', () => { close(); go(calUrl({ asset: r.asset_id, reserve: true, from: '#/requests' })); });
  on('#a-declineready', handled('decline-ready', {}, 'Declined. The unit is available to others again.'));
  if (asAdmin) {
    on('#a-cancel', () => confirmSheet('Cancel request', r.status === 'ready'
      ? `This closes the request completely${r.hold_active ? ` and ends the priority hold: ${unit} becomes generally available again` : ''}. ${first} is told.${claimRange ? ` ${first}'s reservation (${claimRange}) is not cancelled.` : ' No reservation is cancelled.'}`
      : `This withdraws the approval and closes the request. ${first} is told.`, 'Cancel request', async () => { await act('cancel'); toast('Request cancelled', false, 'ok'); }));
  } else on('#a-cancel', handled('cancel', {}, 'Request cancelled'));
  on('#a-new', () => close());
  on('#a-release', () => confirmSheet(r.hold_active ? 'End priority hold' : 'Return to Approved',
    r.hold_active ? `Ending the priority hold makes ${unit} generally available again: other employees will be able to reserve and check it out. ${first} is told and the request stays approved. No reservation is cancelled.`
      : `${unit} is no longer under a priority hold. This returns the request to Approved${claimRange ? `; ${first}'s reservation (${claimRange}) stays in place` : ''}.`,
    r.hold_active ? 'End priority hold' : 'Return to Approved', async () => { await act('release'); toast(r.hold_active ? 'Priority hold ended' : 'Returned to Approved', false, 'ok'); }));
  const pick = (title, then) => { leave(); assetPickerSheet({ title, catalogNode: r.catalog_node_id, filterCategory: r.category_other ? undefined : r.category, onPick: then }); };
  on('#a-ready', () => pick(`Which unit is ready for ${first}?`, (assetId) => noteSheet('Mark unit ready', `${first} is told and the unit gets a 48-hour priority hold for them: nobody else can reserve or check it out meanwhile. Reserving it is only a claim; the request is Fulfilled when it is actually issued. Add a note (optional).`, 'Mark ready', 'e.g. Pick it up at the IT room', fresh('ready', { asset_id: assetId }, 'Marked ready. The 48-hour priority hold has started.'))));
  on('#a-deliver', () => pick(`Item delivered to ${first}`, (assetId) => noteSheet('Deliver & assign permanently', `The item is permanently assigned to ${r.user_name} and the request is fulfilled. Add a note (optional).`, 'Assign permanently', 'Optional note', fresh('fulfill', { asset_id: assetId }, 'Assigned permanently'))));
  on('#a-handed', () => { leave(); noteSheet('Record as handed over', 'Use this for equipment that is not individually inventoried, or was handed over outside the system. No assignment is created. Add a note (optional).', 'Mark fulfilled', 'Optional note', fresh('fulfill', { untracked: true }, 'Fulfilled')); });
  on('#a-checkout', () => {
    leave();
    const s = sheet(`<h2>Issue to ${esc(first)}</h2><p class="muted small" style="margin-top:0">${esc(r.asset_label || '')}: a temporary checkout. The request is Fulfilled once it is issued.</p>
      <form class="form-grid" id="f"><label class="field"><span>Return date</span><input type="date" name="due_date" required min="${localToday()}"></label>
        <label class="field"><span>Return time (optional)</span><input type="time" name="due_time"></label>
        <label class="field"><span>Note (optional)</span><input name="note" maxlength="1000"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Issue (check out)</button></div></form>`);
    $('#f', s.el).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); busy($('#go', s.el), async () => { await act('fulfill', fd); s.close(); toast('Issued. The request is fulfilled.', false, 'ok'); refreshBadge(); again(); }); };
  });
}

// One request in the Requests list (same card as the earlier requests; the click opens the detail sheet).
const eqCard = (r) => `<div class="card"><div class="item" data-eqd="${r.id}" tabindex="0" style="align-items:flex-start;cursor:pointer"><div class="thumb req-thumb">${icon('box')}</div><div class="grow">
  <div class="row spread" style="align-items:flex-start"><div class="title">${esc(eqWhat(r))}</div>${eqPill(r)}</div>
  <div class="sub">Equipment request · ${isAdmin() ? `<a href="#/person/${r.employee_id}">${esc(r.user_name)}</a>${r.user_department ? ' · ' + esc(r.user_department) : ''} · ` : ''}${fmtWhen(r.created_at)}</div>
  <div class="small" style="margin-top:4px">Equipment: <strong>${esc(EQ_DECISION[r.status])}</strong> · Permanent assignment: <strong>${esc(eqPermLabel(r))}</strong></div>
  ${r.status === 'ready' ? `<div class="small" style="margin-top:4px"><strong>${esc(eqStage(r))}</strong>${r.asset_label ? ` · ${esc(r.asset_label)}` : ''}${r.hold_active && !r.claimed_reservation_id ? ` · until ${esc(r.hold_expires_text)}` : ''}</div>` : ''}
  <div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm" data-eqopen="${r.id}">View details</button></div>
</div></div></div>`;

// ============================================================ requests
async function viewRequests() {
  // ONE Requests screen for IT and employees: Equipment | Returns | Reservations, each with Open / Closed. Equipment = the new equipment requests AND the
  // earlier item requests (both tables stay as they are; nothing is converted); Returns = returns and issue reports; Reservations = reservations + waitlist.
  const q0 = qs(); const oldTab = q0.get('tab');
  const state = { cat: ['equipment', 'returns', 'reservations'].includes(q0.get('cat')) ? q0.get('cat') : oldTab === 'reservations' ? 'reservations' : 'equipment', tab: ['open', 'closed'].includes(oldTab) ? oldTab : 'open', f: q0.get('state') || '' };
  main().innerHTML = `<div class="page-head"><h1>Requests</h1>${isAdmin() ? `<button class="btn primary" id="new">${icon('plus')} New</button>` : `<div class="row wrap" style="gap:8px"><button class="btn primary" id="reserve-eq">${icon('calendar')} Reserve equipment</button><button class="btn" id="need-eq">${icon('plus')} Request equipment</button></div>`}</div>
    <div class="stack"><div class="seg" id="cats" role="group" aria-label="Request type"><button data-v="equipment">Equipment</button><button data-v="returns">Returns</button><button data-v="reservations">Reservations</button></div>
      <div class="row wrap" style="gap:10px"><div class="seg" id="seg"><button data-v="open">Open</button><button data-v="closed">Closed</button></div>
      ${isAdmin() ? '<select id="st" aria-label="Filter by state" style="width:auto;min-height:40px;padding:6px 10px;font-size:15px"></select>' : ''}</div><div id="list"><div class="spinner"></div></div></div>`;
  if (!isAdmin()) { $('#reserve-eq').onclick = reserveEquipment; $('#need-eq').onclick = () => requestNeedSheet(); }
  if ($('#new')) $('#new').onclick = async () => {
    const { el, close } = sheet(`<h2>New request</h2><div class="stack" style="margin-top:14px">
      <button class="btn lg block" id="n1">${icon('box')} Log an equipment request for someone</button>
      <button class="btn lg block" id="n2">${icon('send')} Ask someone to return an item</button></div>`);
    $('#n1', el).onclick = async () => { close(); const users = await getUsers(); const s = sheet(`<h2>Who is it for?</h2><div id="pp" style="margin-top:12px"></div>`); personPicker($('#pp', s.el), users, (u) => { s.close(); requestEquipmentSheet({ forUser: u }); }); };
    $('#n2', el).onclick = () => { close(); go('#/assets?status=checked_out'); toast('Open the item and tap “Request return”'); };
  };
  // Reservations (slice 7): a separate list, not a request type. IT sees every one (pending approvals first, with Approve / Decline);
  // an employee sees their own, with Cancel / Shorten. All rules come from the server.
  const syncResvLabel = () => {}; // (the category counts are painted by refreshBadge)
  // The reservation + waitlist sections (their cards), shared by the Reservations tab and the All tab.
  const reservationCards = async () => {
    const [rows, wl] = await Promise.all([api('GET', '/api/reservations'), api('GET', '/api/waitlist')]); // (waitlist entries live here too, not in a product of their own)
    const adminV = isAdmin();
    const pending = rows.filter((r) => r.phase === 'pending');
    const live = rows.filter((r) => ['upcoming', 'active'].includes(r.phase));
    const done = rows.filter((r) => !['pending', 'upcoming', 'active'].includes(r.phase)).slice(0, 30);
    const offered = wl.filter((w) => w.phase === 'held');
    const queued = wl.filter((w) => w.phase === 'waiting');
    const activeWl = wl.filter((w) => w.phase === 'held' || w.phase === 'waiting'); // (server order: asset, then place in line)
    const wlDone = wl.filter((w) => !['held', 'waiting', 'confirmed', 'pending', 'reservation_declined', 'reservation_cancelled'].includes(w.phase)).slice(0, 30); // (a confirmed one is the reservation above)
    syncResvLabel(adminV ? pending.length + activeWl.length : offered.length);
    const section = (title, items, empty, draw = (r) => reservationItem(r, { admin: adminV, tab: 'reservations' })) => `<div class="card"><div class="card-head"><h2>${title}</h2><span class="muted small">${items.length}</span></div>${items.length
      ? `<ul class="list">${items.map(draw).join('')}</ul>` : `<div class="empty">${icon('calendar')}<p>${empty}</p></div>`}</div>`;
    const drawWl = (w) => waitlistItem(w, { admin: adminV });
    // Open = what still needs a decision or is ahead; Closed = past, declined and cancelled
    const html = state.tab === 'closed'
      ? `${section('Past & closed', done, 'Nothing closed yet.')}${wlDone.length ? section('Past waitlist entries', wlDone, '', drawWl) : ''}`
      : adminV
        ? section('Waiting for approval', pending, 'Nothing is waiting for approval.') + section('Waitlist', activeWl, 'Nobody is on a waitlist.', drawWl) + section('Upcoming & active', live, 'No confirmed reservations ahead.')
        : `${offered.length ? section('Available for you', offered, '', drawWl) : ''}${section('Pending & upcoming', [...pending, ...live], 'No reservations yet. Open an item in Browse and choose Reserve.')}${queued.length ? section('Waitlist', queued, '', drawWl) : ''}`;
    return { html, rows, wl };
  };
  const wireReservations = (list, { rows, wl }, reload) => { wireReservationActions(list, rows, reload); wireWaitlistActions(list, wl, reload); };
  const renderReservations = async () => {
    const data = await reservationCards();
    const list = $('#list'); if (!list) return;
    list.innerHTML = `<div class="stack">${data.html}</div>`;
    wireReservations(list, data, () => renderReservations().catch(fail));
  };
  const NEWKEY = { submitted: 'submitted', in_review: 'in_review', approved: 'approved', ready: 'ready', fulfilled: 'fulfilled', declined: 'denied', cancelled: 'cancelled' };
  const render = async () => {
    $$('#cats button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.cat));
    $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.tab));
    const stSel = $('#st'); if (stSel) stSel.style.display = state.cat === 'reservations' ? 'none' : '';
    refreshBadge(); // (also paints the counts on the category tabs)
    if (state.cat === 'reservations') return renderReservations();
    const isEq = state.cat === 'equipment';
    const legacy = (await api('GET', '/api/requests?status=' + state.tab)).filter((r) => (r.type === 'equipment') === isEq);
    const fresh = isEq ? (await api('GET', '/api/equipment-requests?status=' + state.tab)).map((n) => ({ __new: n, id: 'n' + n.id, created_at: n.created_at })) : [];
    const all = [...fresh, ...legacy].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const list = $('#list'); if (!list) return;
    // the state filter: this tab's states with how many are in each (client-side; the lifecycle comes from the server)
    const sk = (r) => (r.__new ? NEWKEY[r.__new.status] : stateKey(r));
    const countOf = (k) => all.filter((r) => sk(r) === k).length;
    const keys = isEq ? (state.tab === 'open' ? ['submitted', 'in_review', 'approved', 'ready'] : ['fulfilled', 'denied', 'rescinded', 'cancelled']) : (state.tab === 'open' ? OPEN_STATES : CLOSED_STATES).filter((k) => !ISSUE_ONLY_STATES.includes(k) || countOf(k) > 0);
    if (!keys.includes(state.f)) state.f = '';
    const st = $('#st');
    if (st) st.innerHTML = `<option value="">All (${all.length})</option>${keys.map((k) => `<option value="${k}"${state.f === k ? ' selected' : ''}>${LIFE_LABEL[k]} (${countOf(k)})</option>`).join('')}`;
    const rows = state.f ? all.filter((r) => sk(r) === state.f) : all;
    if (!rows.length) { list.innerHTML = `<div class="card"><div class="empty">${icon('inbox')}<p>${all.length ? `No ${LIFE_LABEL[state.f].toLowerCase()} requests.` : state.tab === 'open' ? `No open ${isEq ? 'equipment requests' : 'returns or issue reports'}.` : 'Nothing here yet.'}</p></div></div>`; return; }
    const find = (id) => legacy.find((r) => r.id === Number(id));
    const kindOf = (r) => (r.type === 'return' ? 'Return request' : r.type === 'issue' ? 'Issue report' : isPermReq(r) ? 'Permanent assignment request' : 'Item request');
    const titleOf = (r) => (r.type === 'return' ? `Return ${esc(r.asset_name || 'item')}` : r.type === 'issue' ? `Issue — ${esc(r.asset_name || 'item')}` : isPermReq(r) ? `Permanent assignment request — ${esc(r.asset_name || r.category || 'equipment')}` : `${esc(r.catalog_path ? crumbText(r.catalog_path) : (r.category || 'Equipment'))}${r.asset_name && !r.catalog_path ? ` — ${esc(r.asset_name)}` : ''}`);
    // What exactly was asked for: the catalog level as it was when the request was made, and whether any matching asset or
    // one specific item. (Older requests have only the free-text category.)
    // (asset_label is only ever written when a specific item was asked for; asset_id alone can also be the asset IT assigned.)
    const scopeOf = (r) => (r.type !== 'equipment' ? '' : r.asset_label ? `Specific asset: ${esc(r.asset_label)}` : r.catalog_path ? 'Any matching asset' : r.asset_id && r.status !== 'completed' ? `Specific asset: ${esc([r.asset_tag, r.asset_name].filter(Boolean).join(' — '))}` : '');
    const specific = (r) => r.type === 'equipment' && r.asset_id !== null && r.status !== 'completed'; // names one item, not yet fulfilled
    // The action buttons a request offers; used by both the list card and the detail sheet (wired by wireActions).
    const actionsFor = (r) => {
      const isRet = r.type === 'return'; const isIssue = r.type === 'issue'; const perm = isPermReq(r);
      if (!['open', 'approved', 'dropped_off'].includes(r.status)) return '';
      if (isAdmin() && isIssue) return `<button class="btn sm primary" data-resolve="${r.id}">${icon('check')} Mark resolved</button>${r.asset_id ? `<a class="btn sm" href="#/asset/${r.asset_id}${srcQ('requests', { tab: state.tab })}">View asset</a>` : ''}<button class="btn sm" data-cancel="${r.id}">Dismiss</button>`;
      // Employees: Cancel is offered only when the server says this exact request is still eligible (can_cancel). A return IT
      // asked for, or one already dropped off, is answered with "I've dropped it off" instead.
      if (!isAdmin()) {
        const cancel = r.can_cancel ? `<button class="btn sm" data-cancel="${r.id}">${isIssue ? 'Withdraw' : 'Cancel'}</button>` : '';
        const drop = isRet && r.status === 'open' ? `<button class="btn sm dark" data-dropoff="${r.id}">${icon('check')} I've dropped it off</button>` : '';
        return drop + cancel;
      }
      if (isAdmin() && perm && r.asset_id) return `<button class="btn sm primary" data-approve-perm="${r.id}">${icon('check')} Approve & assign permanently</button><button class="btn sm danger" data-deny="${r.id}">Decline</button>`;
      if (isAdmin() && !isRet) return `<button class="btn sm primary" data-fulfill="${r.id}">${icon('out')} ${specific(r) ? 'Assign ' + esc(r.asset_tag || 'this item') : 'Assign an asset'}</button>${r.status === 'open' ? `<button class="btn sm" data-approve="${r.id}">Approve</button>` : ''}<button class="btn sm danger" data-deny="${r.id}">Decline</button>`;
      if (isAdmin() && isRet) return `${r.asset_id ? `<a class="btn sm primary" href="#/asset/${r.asset_id}${srcQ('requests', { tab: state.tab })}">${icon('in')} Check in</a>` : ''}<button class="btn sm" data-cancel="${r.id}">Cancel request</button>`;
      return '';
    };
    // `before` runs first (the detail sheet closes itself so the action's own sheet isn't stacked on it).
    const wireActions = (root, before) => {
      const on = (sel, attr, fn) => $$(sel, root).forEach((b) => b.onclick = (e) => { before && before(); fn(find(b.dataset[attr]), e.currentTarget); });
      // Fulfilling hands over what was asked for: the requested item itself for a specific request, otherwise a pick from the
      // matching assets (the server re-checks the match and availability either way).
      const assign = (r, assetId) => {
        const { el, close } = sheet(`<h2>Assign & check out</h2><p class="muted small" style="margin-top:0">${esc(r.user_name)} will get an email with the details.</p>
          <form class="form-grid" id="f">${assignTypeFields()}<label class="field"><span>Note to ${esc(r.user_name.split(' ')[0])} (optional)</span><input name="note" placeholder="e.g. Pick it up at the IT room"></label>
          <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Check out</button></div></form>`);
        wireAssignType(el);
        $('#f', el).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
          busy($('#go', el), async () => { await api('POST', `/api/requests/${r.id}/approve`, { asset_id: assetId, assignment_type: fd.assignment_type, due_date: fd.due_date, due_time: fd.due_time, note: fd.note }); close(); toast('Assigned and checked out'); refreshBadge(); render(); }); };
      };
      on('[data-fulfill]', 'fulfill', (r) => (specific(r) ? assign(r, r.asset_id) : assetPickerSheet({ title: `Assign to ${r.user_name}`, filterCategory: r.category, catalogNode: r.catalog_node_id, onPick: (assetId) => assign(r, assetId) })));
      on('[data-approve-perm]', 'approvePerm', (r) => noteSheet('Approve permanent assignment', `${r.asset_name || 'This item'} will be permanently assigned to ${r.user_name}. Add a note for them (optional).`, 'Approve & assign', 'e.g. Pick it up at the IT room',
        async (note) => { await api('POST', `/api/requests/${r.id}/approve`, { asset_id: r.asset_id, assignment_type: 'permanent', note }); toast('Permanently assigned'); refreshBadge(); render(); }));
      on('[data-approve]', 'approve', (r) => noteSheet('Approve request', 'Let them know what happens next (optional).', 'Approve', 'e.g. Ordered — should arrive next week', async (note) => { await api('POST', `/api/requests/${r.id}/approve`, { note }); toast('Approved — they’ve been emailed'); refreshBadge(); render(); }));
      on('[data-deny]', 'deny', (r) => noteSheet('Decline request', 'Add a short reason (optional). They’ll get an email.', 'Decline', 'e.g. Please talk to your manager first', async (note) => { await api('POST', `/api/requests/${r.id}/deny`, { note }); toast('Declined'); refreshBadge(); render(); }, true));
      on('[data-resolve]', 'resolve', (r) => noteSheet('Mark issue resolved', `Add a short note about what was done (optional). ${r.user_name} will see it on their request.`, 'Mark resolved', 'e.g. Replaced the charger', async (note) => { await api('POST', `/api/requests/${r.id}/resolve`, { note }); toast('Marked resolved'); refreshBadge(); render(); }));
      on('[data-cancel]', 'cancel', (r, btn) => busy(btn, async () => { await api('POST', `/api/requests/${r.id}/cancel`, {}); toast(r.type === 'issue' ? 'Issue closed' : 'Cancelled'); refreshBadge(); render(); }));
      on('[data-dropoff]', 'dropoff', (r, btn) => busy(btn, async () => { await api('POST', `/api/requests/${r.id}/dropped-off`, {}); toast('Thanks! IT has been notified.'); refreshBadge(); render(); }));
    };
    // Full read-only view of a request (notes included) with the same actions, so IT can read before approving or declining.
    // IT viewing a request's detail opens it: the first time, the server records opened_at (Submitted -> In review) and from then
    // on the employee can no longer rescind it. Employees' views never call this, and a failure never blocks reading the request.
    const openDetail = async (r) => {
      let justOpened = false;
      if (isAdmin() && r.lifecycle === 'submitted') {
        try { const o = await api('POST', `/api/requests/${r.id}/open`, {}); r.opened_at = o.opened_at; r.lifecycle = o.lifecycle; justOpened = true; } catch { /* still show it */ }
      }
      const row = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
      const { el, close } = sheet(`<h2>${esc(kindOf(r))}</h2>
        <div class="row wrap" style="gap:8px;margin:2px 0 12px">${reqPill(r)}${isPermReq(r) ? '<span class="pill plain available">Permanent assignment</span>' : ''}</div>
        <div class="kv">
          ${r.type === 'equipment' ? row('Equipment request decision', esc({ submitted: 'Submitted', in_review: 'In review', approved: 'Approved', fulfilled: 'Approved · Fulfilled', denied: 'Declined', rescinded: 'Cancelled by the requester', cancelled: 'Cancelled' }[stateKey(r)] || statusLabel(r))) : ''}
          ${r.type === 'equipment' ? row('Permanent assignment decision', esc(r.requested_assignment_type === 'permanent' ? (r.status === 'completed' ? 'Approved and assigned' : r.status === 'denied' ? 'Denied' : 'Pending decision') : r.requested_assignment_type === 'checkout' ? 'Not requested (temporary checkout)' : 'Not recorded (this request predates the permanent-assignment option)')) : ''}
          ${row(r.type === 'issue' ? 'Reported by' : 'Requested by', `${isAdmin() ? `<a href="#/person/${r.user_id}" data-x>${esc(r.user_name)}</a>` : esc(r.user_name)}${r.user_department ? ' · ' + esc(r.user_department) : ''}`)}
          ${row(r.type === 'equipment' && r.status === 'completed' && !r.asset_label ? 'Assigned asset' : 'Asset', r.asset_id ? `${isAdmin() ? `<a href="#/asset/${r.asset_id}${srcQ('requests', { tab: state.tab })}" data-x>${esc(r.asset_name || '')}</a>` : esc(r.asset_name || '')} <span class="mono small muted">${esc(r.asset_tag || '')}</span>` : '')}
          ${row('Requested', r.catalog_path ? `<strong>${esc(crumbText(r.catalog_path))}</strong>` : '')}
          ${row('Scope', r.type === 'equipment' ? scopeOf(r) : '')}
          ${row('Category', r.catalog_path ? '' : esc(r.category || ''))}
          ${row(r.type === 'return' ? 'Return by' : 'Needed by', r.needed_by ? fmtDate(r.needed_by) : '')}
          ${row('Submitted', esc(fmtStamp(r.created_at)))}
          ${row('Opened by IT', r.opened_at ? esc(fmtStamp(r.opened_at)) : '')}
          ${row(r.type === 'issue' ? 'Description' : 'Notes', r.message ? `<div style="white-space:pre-wrap">${esc(r.message)}</div>` : '<span class="muted">No notes were added.</span>')}
          ${row('IT note', r.resolution_note ? `<div style="white-space:pre-wrap">${esc(r.resolution_note)}</div>` : '')}
          ${row(r.status === 'approved' ? 'Decision' : 'Closed', r.resolved_by_name && !['open', 'dropped_off'].includes(r.status) ? `${esc(statusLabel(r))} by ${esc(r.resolved_by_name)} · ${esc(fmtStamp(r.resolved_at))}` : '')}
        </div>
        <div class="row wrap" id="d-actions" style="margin-top:14px;gap:8px">${actionsFor(r)}</div>
        <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`);
      $$('[data-x]', el).forEach((a) => a.addEventListener('click', () => close()));
      wireActions($('#d-actions', el), close);
      if (justOpened) render().catch(() => {}); // the list behind the sheet now shows "In review"
    };
    list.innerHTML = `<div class="stack">${rows.map((r) => {
      if (r.__new) return eqCard(r.__new);
      const isRet = r.type === 'return';
      const btns = actionsFor(r);
      return `<div class="card"><div class="item" data-detail="${r.id}" tabindex="0" style="align-items:flex-start;cursor:pointer">
        <div class="thumb req-thumb">${icon(requestIcon(r))}</div>
        <div class="grow"><div class="row spread" style="align-items:flex-start"><div class="title">${titleOf(r)}</div>${reqPill(r)}</div>
          <div class="sub">${esc(kindOf(r))} · ${isAdmin() ? `<a href="#/person/${r.user_id}">${esc(r.user_name)}</a>${r.user_department ? ' · ' + esc(r.user_department) : ''} · ` : ''}${fmtWhen(r.created_at)}${r.needed_by ? ` · ${isRet ? 'return' : 'needed'} by ${fmtDate(r.needed_by)}` : ''}${r.asset_tag ? ` · <a class="mono" href="#/asset/${r.asset_id}${srcQ('requests', { tab: state.tab })}">${esc(r.asset_tag)}</a>` : ''}</div>
          ${scopeOf(r) && r.type === 'equipment' ? `<div class="small" style="margin-top:4px"><span class="scope-tag ${r.asset_id ? 'spec' : ''}">${scopeOf(r)}</span></div>` : ''}
          ${r.message ? `<div class="truncate" style="margin-top:6px">${esc(r.message)}</div>` : ''}
          ${r.resolution_note ? `<div class="small muted" style="margin-top:6px">IT: ${esc(r.resolution_note)}</div>` : ''}
          <div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm" data-open="${r.id}">View details</button>${btns}</div>
        </div></div></div>`;
    }).join('')}</div>`;
    const openNew = (id) => openEqDetail(Number(id), { admin: isAdmin(), reload: () => render().catch(() => {}) });
    $$('[data-eqd]', list).forEach((it) => {
      it.onclick = (e) => { if (e.target.closest('a,button')) return; openNew(it.dataset.eqd); };
      it.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === it) { e.preventDefault(); openNew(it.dataset.eqd); } };
    });
    $$('[data-eqopen]', list).forEach((b) => b.onclick = () => openNew(b.dataset.eqopen));
    $$('[data-detail]', list).forEach((it) => {
      const open = () => openDetail(find(it.dataset.detail));
      it.onclick = (e) => { if (e.target.closest('a,button')) return; open(); };
      it.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === it) { e.preventDefault(); open(); } };
    });
    $$('[data-open]', list).forEach((b) => b.onclick = () => openDetail(find(b.dataset.open)));
    wireActions(list);
  };
  const keepUrl = () => history.replaceState(null, '', `#/requests?cat=${state.cat}&tab=${state.tab}${state.f ? '&state=' + state.f : ''}`);
  $('#cats').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.cat = b.dataset.v; state.f = ''; keepUrl(); render().catch(fail); };
  $('#seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.v; state.f = ''; keepUrl(); render().catch(fail); };
  if ($('#st')) $('#st').onchange = (e) => { state.f = e.target.value; keepUrl(); render().catch(fail); };
  render();
}
function noteSheet(title, text, okLabel, placeholder, onOk, danger) {
  const { el, close } = sheet(`<h2>${esc(title)}</h2><p class="muted small" style="margin-top:0">${esc(text)}</p>
    <form id="f"><textarea name="note" placeholder="${esc(placeholder)}"></textarea><div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="go">${esc(okLabel)}</button></div></form>`);
  $('#f', el).onsubmit = (e) => { e.preventDefault(); busy($('#go', el), async () => { await onOk(e.target.note.value.trim()); close(); }); };
}

// ============================================================ reservations (Phase 2, slice 7)
// A reservation is one asset + an inclusive range of calendar dates. The server decides everything (phase, what may be cancelled or
// shortened, conflicts); these helpers only draw a row and call the endpoints. Employees reach theirs under Requests > Reservations and on
// the asset page; IT approves under Requests > Reservations.
const isoAdd = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// A reservation / waitlist range in words, with its optional pickup / return times (the server sends plain HH:MM; fmtClock makes them 1:00 PM and never touches
// a Date, so no browser time zone can move them). Same wording as src/timeRange.js `when`: "Oct 12, 2026 · 8:00 AM – 1:00 PM", "Oct 12, 2026 · Return by 1:00 PM",
// "Oct 12, 2026 – Oct 14, 2026 · Pickup 8:00 AM", "Oct 12, 2026, 8:00 AM – Oct 14, 2026, 1:00 PM". `allDay` says "All day" for a single date-only day.
const resvRange = (r, { allDay = false } = {}) => {
  const st = r.start_time ? fmtClock(r.start_time) : ''; const et = r.end_time ? fmtClock(r.end_time) : '';
  if (r.start_date === r.end_date) {
    const d = fmtDate(r.start_date);
    return st && et ? `${d} · ${st} – ${et}` : st ? `${d} · Pickup ${st}` : et ? `${d} · Return by ${et}` : allDay ? `${d} · All day` : d;
  }
  const a = fmtDate(r.start_date); const b = fmtDate(r.end_date);
  return st && et ? `${a}, ${st} – ${b}, ${et}` : st ? `${a} – ${b} · Pickup ${st}` : et ? `${a} – ${b} · Return by ${et}` : `${a} – ${b}`;
};
// The same range as the calendar reports it (start / end keys), and only the times when it is a single day on the day being looked at.
const calRange = (x, day) => {
  const r = { start_date: x.start, end_date: x.end, start_time: x.start_time, end_time: x.end_time };
  if (day && x.start === day && x.end === day) { const t = resvRange(r, { allDay: true }); return t.slice(t.indexOf(' · ') + 3); }
  return resvRange(r);
};
// comparison keys, as src/timeRange.js: blank pickup = start of the day, blank return = the end of the day (internal only)
const keyStart = (d, t) => `${d}T${t || '00:00'}`;
const keyEnd = (d, t) => (t ? `${d}T${t}` : `${isoAdd(d, 1)}T00:00`);
// days + duration for a list row: a multi-day range says how many days; a single day says its hours (or All day) and needs no count
const resvWhen = (r) => (r.start_date === r.end_date ? resvRange(r, { allDay: true }) : `${resvRange(r)} · ${resvDays(r)} days`);
const resvDays = (r) => Math.round((Date.parse(r.end_date + 'T00:00:00Z') - Date.parse(r.start_date + 'T00:00:00Z')) / 864e5) + 1;
const RESV_LABEL = { pending: 'Waiting for approval', upcoming: 'Reserved', active: 'Reserved · now', past: 'Past', declined: 'Declined', cancelled: 'Cancelled' };
const RESV_CLASS = { pending: 'open', upcoming: 'approved', active: 'approved', past: 'cancelled', declined: 'denied', cancelled: 'cancelled' };
const resvPill = (r) => pill(RESV_CLASS[r.phase] || 'open', RESV_LABEL[r.phase] || r.phase);
function reservationItem(r, { admin: forAdmin, showAsset = true, tab = '' } = {}) {
  const asset = showAsset ? (forAdmin ? `<a href="#/asset/${r.asset_id}${srcQ('requests', { tab })}" class="title">${esc(r.asset_name)}</a>` : `<span class="title">${esc(r.asset_name)}</span>`) : '';
  const acts = [];
  // IT's decision on a pending reservation is Approve or Decline, nothing else. Cancel appears once it is confirmed (Upcoming & active).
  // (An employee still sees Cancel on their own pending request: that is them withdrawing it.)
  const itDeciding = forAdmin && r.phase === 'pending';
  if (itDeciding) acts.push(`<button class="btn sm primary" data-resv-approve="${r.id}">Approve</button><button class="btn sm danger" data-resv-decline="${r.id}">Decline</button>`);
  // An employee's card is a summary: it opens Reservation details (click anywhere), and its one action is "Edit reservation", the way in to Shorten / Cancel
  // (cancelling is destructive, so it lives inside the details). IT's card keeps its own buttons.
  if (!forAdmin) { if (r.can_cancel || r.can_shorten) acts.push(`<button class="btn sm" data-resv-edit="${r.id}">Edit reservation</button>`); }
  else {
    if (r.can_cancel && !itDeciding) acts.push(`<button class="btn sm" data-resv-cancel="${r.id}">Cancel${!r.mine ? ' reservation' : ''}</button>`);
    if (r.can_shorten) acts.push(`<button class="btn sm" data-resv-shorten="${r.id}">Shorten</button>`);
  }
  const who = forAdmin ? `${esc(r.employee_name)}${r.employee_department ? ' · ' + esc(r.employee_department) : ''}` : '';
  const sub = [esc(resvWhen(r)), who, forAdmin && r.requires_approval ? 'approval required' : '', r.waitlist_entry_id ? 'from the waitlist' : '', showAsset ? `<span class="mono">${esc(r.asset_tag)}</span>` : ''].filter(Boolean).join(' · ');
  return `<li class="resv"><div class="item" ${forAdmin ? '' : `data-resv-detail="${r.id}" tabindex="0"`} style="align-items:flex-start${forAdmin ? '' : ';cursor:pointer'}"><div class="thumb">${icon('calendar')}</div><div class="grow">
    <div class="row spread" style="align-items:flex-start"><div>${asset}${asset ? '' : `<span class="title">${esc(resvRange(r, { allDay: true }))}</span>`}</div>${resvPill(r)}</div>
    <div class="sub">${asset ? sub : [r.start_date !== r.end_date ? resvDays(r) + ' days' : '', who, forAdmin && r.requires_approval ? 'approval required' : ''].filter(Boolean).join(' · ')}</div>
    ${r.decision_note ? `<div class="small muted" style="margin-top:4px">IT: ${esc(r.decision_note)}</div>` : ''}
    ${acts.length ? `<div class="row wrap" style="margin-top:8px;gap:8px">${acts.join('')}</div>` : ''}</div></div></li>`;
}
// Reservation details (employee): what is saved, and the way to manage it. Shorten reuses the existing sheet; Cancel is here, not on the card.
// (There is deliberately no extend: more time is a new reservation, so it is checked against everyone else's.)
function reservationSheet(r, { after, reload }) {
  const at = (d, t, none) => `${esc(fmtDate(d))} · ${t ? esc(fmtClock(t)) : `<span class="muted">${none}</span>`}`;
  const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  const { el, close } = sheet(`<h2>Reservation details</h2>
    <div class="kv" style="margin-top:8px">
      ${row('Asset', `${esc(r.asset_name)}${r.asset_tag ? ` <span class="mono muted">${esc(r.asset_tag)}</span>` : ''}`)}
      ${row('Status', `${resvPill(r)}${r.waitlist_entry_id ? ' <span class="muted small">from the waitlist</span>' : ''}`)}
      ${row('Pickup', at(r.start_date, r.start_time, 'no pickup time'))}
      ${row('Return', at(r.end_date, r.end_time, 'no return time'))}
      ${r.decision_note ? row('IT note', esc(r.decision_note)) : ''}
    </div>
    ${r.can_shorten || r.can_cancel ? `<div class="row wrap" style="margin-top:14px;gap:8px">${r.can_shorten ? '<button type="button" class="btn" id="rd-shorten">Shorten reservation</button>' : ''}${r.can_cancel ? '<button type="button" class="btn danger" id="rd-cancel">Cancel reservation</button>' : ''}</div>` : ''}
    <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`);
  const sh = $('#rd-shorten', el); if (sh) sh.onclick = () => { close(); shortenSheet(r, reload); };
  const ca = $('#rd-cancel', el); if (ca) ca.onclick = async () => {
    close();
    if (!(await confirmSheet(r.mine === false ? `Cancel ${r.employee_name}'s reservation?` : 'Cancel this reservation?', `${r.asset_name} · ${resvRange(r)}. The dates become available to others right away.`, 'Cancel reservation', true))) return;
    try { await api('POST', `/api/reservations/${r.id}/cancel`, {}); after('Reservation cancelled'); } catch (e) { fail(e); reload(); }
  };
}
// Shorten: the reservation's own days are shown on a calendar that is always visible (no pop-up date picker). Tap the new LAST day: days up to it are
// kept, the days after it are released (green). Slice 8.1: an optional RETURN TIME on that day releases only the rest of it ("Oct 12 all day" -> "Oct 12, return
// 1:00 PM"), so the current last day can be picked too. Only the end can move earlier, never the start or later (the server enforces it; this only keeps the button honest).
function shortenSheet(r, done) {
  const first = r.shorten_min;
  const was = keyEnd(r.end_date, r.end_time); const began = keyStart(r.start_date, r.start_time);
  let end = r.end_time || r.end_date <= first ? r.end_date : isoAdd(r.end_date, -1); let time = r.end_time || ''; // (a timed return opens AT its current value; a date-only one starts a day earlier with the time blank)
  let month = end.slice(0, 7);
  const firstMonth = r.start_date.slice(0, 7); const lastMonth = r.end_date.slice(0, 7);
  const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
  const { el, close } = sheet(`<h2>Shorten this reservation</h2><p class="muted small" style="margin-top:0">${esc(r.asset_name)} · ${esc(resvRange(r))}. Tap the new last day, and add a return time if you are done earlier that day. To keep it longer, make a new reservation.</p>
    <form id="f"><div class="card cal-card" style="box-shadow:none">
      <div class="cal-nav"><button type="button" class="iconbtn" id="sc-prev" aria-label="Previous month">${icon('back')}</button><h2 id="sc-month" aria-live="polite"></h2><button type="button" class="iconbtn" id="sc-next" aria-label="Next month">${icon('chev')}</button></div>
      <div class="cal-wd" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid" id="sc-grid"></div>
      <div class="cal-legend small muted"><span><i class="reserved"></i>Kept</span><span><i class="free"></i>Released</span></div></div>
      <div class="field" style="margin-top:12px"><span>Return time <span class="muted">(optional)</span> <button type="button" class="tclear" id="sc-clear" hidden>Clear</button></span>${timeBox('end_time', r.end_time || '', 'sc-time')}</div>
      <p id="sc-sum" style="margin:12px 0 0"></p>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Shorten</button></div></form>`);
  const paint = () => {
    const [y, mo] = month.split('-').map(Number);
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const cells = Array.from({ length: lead }, () => '<span class="cal-day blank" aria-hidden="true"></span>');
    for (let d = 1; d <= days; d++) {
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      const inRes = iso >= r.start_date && iso <= r.end_date; const can = iso >= first && iso <= r.end_date;
      const cls = !inRes ? 'off' : iso === end ? 'edge' : iso < end ? 'inrange' : 'free';
      const label = !inRes ? 'not part of this reservation' : iso > end ? 'will be released' : iso === end ? 'new last day' : 'kept';
      cells.push(`<button type="button" class="cal-day ${cls}${can ? ' pick' : ''}" ${can ? `data-day="${iso}"` : 'disabled'} aria-label="${esc(fmtDate(iso))}: ${label}"><span class="d">${d}</span><span class="c"></span></button>`);
    }
    $('#sc-grid', el).innerHTML = cells.join('');
    $('#sc-month', el).textContent = monthName(month);
    $('#sc-prev', el).disabled = month <= firstMonth; $('#sc-next', el).disabled = month >= lastMonth;
    $('#sc-clear', el).hidden = !time && !bad;
    const k = keyEnd(end, time); const ok = !bad && k < was && k > began;
    $('#go', el).disabled = !ok;
    const from = time ? `${fmtClock(time)} on ${fmtDate(end)}` : fmtDate(isoAdd(end, 1));
    const to = r.end_time ? `${fmtClock(r.end_time)} on ${fmtDate(r.end_date)}` : `the end of ${fmtDate(r.end_date)}`;
    $('#sc-sum', el).innerHTML = bad ? '<span class="muted small">Finish the return time (hour, minutes and AM or PM), or press Clear to leave it blank.</span>' : ok
      ? `New return: <strong>${esc(fmtDate(end))}${time ? `, ${esc(fmtClock(time))}` : ''}</strong> <span class="muted small">· frees up from ${esc(from)} until ${esc(to)}</span>`
      : `<span class="muted small">Choose an earlier return than ${esc(resvRange({ start_date: r.end_date, end_date: r.end_date, end_time: r.end_time }).replace(' · Return by ', ', '))}.</span>`;
  };
  $('#sc-grid', el).onclick = (e) => { const b = e.target.closest('[data-day]'); if (b) { end = b.dataset.day; paint(); } };
  $('#sc-prev', el).onclick = () => { month = shift(month, -1); paint(); };
  $('#sc-next', el).onclick = () => { month = shift(month, 1); paint(); };
  let bad = false; // a half-typed time: value is '' but the field is not blank
  wireTimeBoxes(el, () => { const h = $('#sc-time', el); time = h.value; bad = h.dataset.bad === '1'; paint(); });
  $('#sc-clear', el).onclick = () => { $('[data-tbox]', el).clear(); };
  paint();
  // (the success message comes only after the server has finished: it names the range the reservation now has)
  $('#f', el).onsubmit = (e) => { e.preventDefault(); busy($('#go', el), async () => { const u = await api('POST', `/api/reservations/${r.id}/shorten`, { end_date: end, end_time: time || null }); close(); toast(`Reservation shortened to ${resvRange(u)}.`, false, 'ok'); done(); }); };
}
// Wires every reservation button under `root` (rows = the reservations drawn there). `reload` redraws the screen afterwards.
function wireReservationActions(root, rows, reload) {
  const find = (id) => rows.find((r) => r.id === Number(id));
  const each = (sel, key, fn) => $$(sel, root).forEach((b) => { b.onclick = (e) => { e.preventDefault(); fn(find(b.dataset[key]), b); }; });
  const after = (msg) => { toast(msg); refreshBadge(); reload(); };
  each('[data-resv-approve]', 'resvApprove', (r, b) => busy(b, async () => { const u = await api('POST', `/api/reservations/${r.id}/approve`, {}); after('Approved'); }));
  each('[data-resv-decline]', 'resvDecline', (r) => noteSheet('Decline reservation', `${r.employee_name}'s request for ${r.asset_name} (${resvRange(r)}). Add a short reason (optional).`, 'Decline', 'e.g. Needed for a shoot that week',
    async (note) => { await api('POST', `/api/reservations/${r.id}/decline`, { note }); after('Declined'); }, true));
  each('[data-resv-cancel]', 'resvCancel', async (r) => {
    const mine = r.mine !== false && !isAdmin();
    if (!(await confirmSheet(mine ? 'Cancel this reservation?' : `Cancel ${r.employee_name}'s reservation?`, `${r.asset_name} · ${resvRange(r)}. The dates become available to others right away.`, 'Cancel reservation', true))) return;
    try { await api('POST', `/api/reservations/${r.id}/cancel`, {}); after('Reservation cancelled'); } catch (e) { fail(e); reload(); }
  });
  each('[data-resv-shorten]', 'resvShorten', (r) => shortenSheet(r, () => { refreshBadge(); reload(); }));
  // an employee's reservation card: click anywhere on it (not on a link or button) or press "Edit reservation" -> Reservation details
  const details = (r) => reservationSheet(r, { after, reload: () => { refreshBadge(); reload(); } });
  each('[data-resv-edit]', 'resvEdit', details);
  $$('[data-resv-detail]', root).forEach((c) => {
    const open = () => details(find(c.dataset.resvDetail));
    c.onclick = (e) => { if (e.target.closest('a,button')) return; open(); };
    c.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); open(); } };
  });
}

// ---- waitlist (slice 8): shown in the same Requests > Reservations list. First come, first served; nothing is ever reserved for you until
// you confirm an offer, and nobody can ask a current reserver to give anything up. The server decides the phase and which buttons apply.
const WL_LABEL = { waiting: 'Waitlisted', held: 'Available for you', confirmed: 'Confirmed', pending: 'Waiting for approval', declined: 'No longer needed', left: 'Left waitlist', removed: 'Removed by IT', expired: 'Expired', reservation_declined: 'Declined by IT', reservation_cancelled: 'Reservation cancelled', checked_out: 'Checked out' };
const WL_CLASS = { waiting: 'open', held: 'open', confirmed: 'approved', checked_out: 'approved', pending: 'open', reservation_declined: 'denied' };
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;
function waitlistItem(w, { admin: forAdmin }) {
  // The employee's own title opens the same "Edit waitlist dates" sheet as the Edit dates button (wireWaitlistActions handles every [data-wl-edit]); a held offer cannot be edited, so it stays plain.
  const asset = forAdmin ? `<a href="#/asset/${w.asset_id}${srcQ('requests', { tab: 'reservations' })}" class="title">${esc(w.asset_name)}</a>` : w.can_edit ? `<a href="#" class="title" data-wl-edit="${w.id}">${esc(w.asset_name)}</a>` : `<span class="title">${esc(w.asset_name)}</span>`;
  const sub = [esc(resvWhen(w)), forAdmin ? `${esc(w.employee_name)}${w.employee_department ? ' · ' + esc(w.employee_department) : ''}` : '',
    w.position && w.phase === 'waiting' ? `${ordinal(w.position)} in line` : '', `${w.phase === 'waiting' ? 'in line since' : 'joined'} ${fmtWhen(w.phase === 'waiting' ? w.queued_at : w.created_at)}`, `<span class="mono">${esc(w.asset_tag)}</span>`].filter(Boolean).join(' · ');
  const acts = [];
  if (w.can_confirm) acts.push(`<button class="btn sm primary" data-wl-confirm="${w.id}">Yes, I still need it</button><button class="btn sm" data-wl-decline="${w.id}">I don't need it</button>`);
  else if (w.can_leave) acts.push(`${w.can_edit ? `<button class="btn sm" data-wl-edit="${w.id}">Edit dates</button>` : ''}<button class="btn sm" data-wl-cancel="${w.id}">Leave waitlist</button>`);
  if (w.can_remove) acts.push(`<button class="btn sm danger" data-wl-remove="${w.id}">Remove</button>`);
  const hold = w.hold_expires_at ? `<div class="small" style="margin-top:4px"><strong>${forAdmin ? 'Offered until' : 'Available for you until'} ${esc(w.hold_expires_text || fmtStamp(w.hold_expires_at))}.</strong> ${forAdmin ? 'If they do not answer, the next person in line is offered it.' : 'Confirm that you still need it, or let it go so the next person can have it.'}</div>` : '';
  const cardClick = !forAdmin && w.can_edit ? ` data-wl-card="${w.id}" tabindex="0"` : ''; // (an offer being held cannot be edited, so that card is not a click target)
  return `<li class="resv"><div class="item"${cardClick} style="align-items:flex-start${cardClick ? ';cursor:pointer' : ''}"><div class="thumb">${icon('calendar')}</div><div class="grow">
    <div class="row spread" style="align-items:flex-start"><div>${asset}</div>${pill(WL_CLASS[w.phase] || 'cancelled', WL_LABEL[w.phase] || w.phase)}</div>
    <div class="sub">${sub}</div>${hold}
    ${acts.length ? `<div class="row wrap" style="margin-top:8px;gap:8px">${acts.join('')}</div>` : ''}</div></div></li>`;
}
// ONE date sheet for everything that asks for a range of one item's dates: reserve it, join its waitlist, or change the dates of a waitlist
// entry (`entry`). It never decides anything itself: as the dates or times change it asks the server (GET /api/assets/:id/range-check) what that range
// means, so the button always says what will really happen. Unavailable time is waitlist time, so there are exactly three answers:
//   all of it free        -> Reserve                      (the amber notice never appears)
//   part of it free       -> an amber notice that says what will be reserved and what will be waitlisted, and ONE Continue button
//   none of it free       -> an amber notice and Join waitlist (there is no way to reserve unavailable time)
// Pickup and return TIMES are optional and independent (blank = the whole first / last day).
// `reservedDay` = it was opened by tapping a day that is already 'reserved' (or 'partial' = only part of it is taken); `scheduledHtml` = what is on that day
// (the calendar's own blocks: the asset's schedule, the viewer's own reservation, the viewer's own waitlist), so the sheet says what is there.
// The time fields are `timeBox`es (type a time, or pick a common one; blank on open). Typing something that is not a whole time is never silently treated
// as "no time": the sheet says to finish it or clear it, and Continue stays off. Dates are plain calendar days, both included.
function rangeSheet({ asset, start, end, entry = null, reservedDay = false, scheduledHtml = '', today = localToday(), onDone }) {
  const edit = !!entry;
  const t0 = entry && entry.start_time || ''; const t1 = entry && entry.end_time || '';
  const timeField = (name, label, v) => `<div class="field"><span>${label} <span class="muted">(optional)</span> <button type="button" class="tclear" data-clear="${name}" ${v ? '' : 'hidden'}>Clear</button></span>${timeBox(name, v)}</div>`;
  const what = scheduledHtml;
  const intro = edit ? 'Change the days you are waiting for.'
    : reservedDay === 'partial' ? `<strong>${esc(fmtDate(start))} is partly scheduled.</strong>${what} Choose the time you need. We will reserve what is available and waitlist the rest.`
      : reservedDay ? `<strong>${esc(fmtDate(start))} is already scheduled.</strong>${what} Choose the time you need. Any time that is taken goes on the waitlist.`
        : 'Choose the whole range you need. Both days are included. Add a pickup or return time only if you need one.';
  const { el, close } = sheet(`<h2 id="rs-title">${edit ? 'Edit waitlist dates' : 'Choose your dates'}</h2>
    <p class="muted small" style="margin-top:0"><strong>${esc(asset.name)}</strong>${asset.tag ? ` <span class="mono">${esc(asset.tag)}</span>` : ''}. ${intro}</p>
    <form class="form-grid" id="f"><div class="rs-leg"><div class="rs-h">Pickup</div><div class="form-grid cols"><label class="field"><span>Start date</span><input type="date" name="start_date" required min="${esc(today)}" value="${esc(start)}"></label>
      ${timeField('start_time', 'Pickup time', t0)}</div></div>
      <div class="rs-leg"><div class="rs-h">Return</div><div class="form-grid cols"><label class="field"><span>End date</span><input type="date" name="end_date" required min="${esc(start >= today ? start : today)}" value="${esc(end)}"></label>
      ${timeField('end_time', 'Return time', t1)}</div></div>
      <div id="rs-note"></div>
      ${edit ? `<div class="banner warn">${icon('alert')}<div class="grow small"><strong>Changing your dates updates your place in line.</strong> You move behind anyone already waiting for the new dates.</div></div>` : ''}
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go" disabled>${edit ? 'Save new dates' : 'Continue'}</button></div></form>`);
  const f = $('#f', el); let tok = 0; let out = null;
  const timesOk = () => (f.start_date.value && f.end_date.value && f.start_date.value === f.end_date.value && f.start_time.value && f.end_time.value ? f.end_time.value > f.start_time.value : true);
  const partial = (n) => f[n].dataset.bad === '1'; // typed, but not a whole time (yet): the value is ''
  const syncClear = () => $$('[data-clear]', el).forEach((b) => { b.hidden = !f[b.dataset.clear].value && !partial(b.dataset.clear); });
  const note = (kind, html) => { $('#rs-note', el).innerHTML = !html ? '' : `<div class="banner ${kind}">${icon(kind === 'warn' ? 'alert' : 'calendar')}<div class="grow small">${html}</div></div>`; };
  const paint = (r) => {
    out = r && r.outcome ? r : null;
    const o = out && out.outcome; const needs = out && out.requires_approval;
    const same = edit && f.start_date.value === entry.start_date && f.end_date.value === entry.end_date && f.start_time.value === t0 && f.end_time.value === t1;
    let kind = 'info'; let html = 'Checking those dates…'; let label = edit ? 'Save new dates' : 'Continue'; let ok = false; let title = edit ? 'Edit waitlist dates' : 'Choose your dates';
    if (o === 'reserve' || o === 'partial') {
      if (edit) { html = 'Some or all of this time is free right now, so it cannot be waitlisted. Choose time that is already scheduled to stay on the waitlist, or leave the waitlist and reserve from the calendar.'; kind = 'warn'; }
      else if (o === 'reserve') {
        title = needs ? 'Request this reservation?' : 'Reserve this item?';
        html = `All of this time is free. ${needs ? 'IT must approve this reservation. It does not hold the dates until they do.' : 'This reservation is confirmed right away.'}`;
        label = needs ? 'Submit for approval' : 'Reserve'; ok = true;
      } else {
        title = 'Part of this time is unavailable'; kind = 'warn'; ok = true; label = needs ? 'Submit for approval' : 'Continue';
        // deliberately brief: no live breakdown while the person is still choosing times; the exact result is shown once it is saved
        html = `Part of this time is unavailable. Available time will be reserved, and overlapping time will be added to the waitlist.${needs ? ' IT approves reservations for this item.' : ''}`;
      }
    } else if (o === 'waitlist') {
      title = edit ? 'Edit waitlist dates' : 'Join the waitlist'; kind = 'warn';
      html = edit ? '' : `<strong>All of this time is already scheduled.</strong> ${esc(out.message)} Join the waitlist and, if the whole range opens up, you will be offered it (first come, first served) and given a limited time to confirm: up to 24 hours, less if it starts soon. Nobody's reservation is affected.`;
      label = edit ? 'Save new dates' : 'Join waitlist'; ok = !same; // (editing: the amber "changing your dates updates your place in line" warning is the one that matters; unchanged dates simply leave Save off)
    } else if (o) { html = esc(out.message); kind = 'warn'; }
    $('#rs-title', el).textContent = title;
    note(kind, html);
    const go = $('#go', el); go.textContent = label; go.disabled = !ok;
  };
  const check = async () => {
    const my = ++tok; const s0 = f.start_date.value; const e0 = f.end_date.value; syncClear();
    if (!s0 || !e0) { out = null; $('#go', el).disabled = true; note('warn', 'Choose a start date and an end date.'); return; }
    const half = ['start_time', 'end_time'].find(partial);
    if (half) { out = null; $('#go', el).disabled = true; note('warn', `Finish the ${half === 'start_time' ? 'pickup' : 'return'} time (hour, minutes and AM or PM), or press Clear to leave it blank.`); return; }
    if (!timesOk()) { out = null; $('#go', el).disabled = true; note('warn', 'The return time must be after the pickup time.'); return; }
    paint(null);
    const q = `start_date=${encodeURIComponent(s0)}&end_date=${encodeURIComponent(e0)}${f.start_time.value ? '&start_time=' + encodeURIComponent(f.start_time.value) : ''}${f.end_time.value ? '&end_time=' + encodeURIComponent(f.end_time.value) : ''}${edit ? '&entry_id=' + entry.id : ''}`;
    try { const r = await api('GET', `/api/assets/${asset.id}/range-check?${q}`); if (my === tok) paint(r); }
    catch (e) { if (my === tok) paint({ outcome: 'unavailable', message: e.message }); }
  };
  f.start_date.onchange = () => { if (f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; f.end_date.min = f.start_date.value; check(); };
  f.end_date.onchange = check;
  // re-check whenever a time's value OR its half-typed state changes (typing fires no change event until the time is whole)
  wireTimeBoxes(el, () => check());
  $$('[data-clear]', el).forEach((b) => { b.onclick = (e) => { e.preventDefault(); $(`[data-tbox="${b.dataset.clear}"]`, el).clear(); }; });
  // `kind`: 'reserve' (all or part free) | 'waitlist' (none free) | 'edit'. The request is re-decided by the server when it arrives.
  const send = (kind, btn) => {
    if (!out) return;
    const body = { start_date: f.start_date.value, end_date: f.end_date.value, start_time: f.start_time.value || null, end_time: f.end_time.value || null };
    busy(btn, async () => {
      try {
        if (kind === 'reserve') {
          const r = await api('POST', `/api/assets/${asset.id}/reservations`, body); close();
          const pend = r.reserved.some((x) => x.status === 'pending');
          toast(r.waitlisted.length ? `${pend ? 'Your reservation request was sent to IT' : 'Your reservation is confirmed'}. The rest is on your waitlist.` : pend ? 'Submitted for IT approval.' : 'Reserved.');
        }
        else if (kind === 'waitlist') { await api('POST', `/api/assets/${asset.id}/waitlist`, body); close(); toast('You are on the waitlist.'); }
        else { await api('PUT', `/api/waitlist/${entry.id}`, body); close(); toast('Dates updated. You are now behind anyone already waiting for those dates.'); }
      } catch (err) { fail(err); check(); return; } // (someone may have just changed things: the sheet re-asks the server)
      refreshBadge(); if (onDone) await onDone(body);
    });
  };
  f.onsubmit = (e) => {
    e.preventDefault(); if (!out || ['start_time', 'end_time'].some(partial)) return; const o = out.outcome;
    if ((o === 'reserve' || o === 'partial') && !edit) send('reserve', $('#go', el)); else if (o === 'waitlist') send(edit ? 'edit' : 'waitlist', $('#go', el));
  };
  check();
}
function wireWaitlistActions(root, rows, reload) {
  const find = (id) => rows.find((w) => w.id === Number(id));
  const each = (sel, key, fn) => $$(sel, root).forEach((b) => { b.onclick = (e) => { e.preventDefault(); fn(find(b.dataset[key]), b); }; });
  const after = (msg) => { toast(msg); refreshBadge(); reload(); };
  const call = async (path, msg) => { try { const r = await api('POST', path, {}); after(typeof msg === 'function' ? msg(r) : msg); } catch (e) { fail(e); refreshBadge(); reload(); } };
  each('[data-wl-confirm]', 'wlConfirm', (w, b) => busy(b, () => call(`/api/waitlist/${w.id}/confirm`, (r) => (r.reservation.status === 'confirmed' ? 'Reserved for you' : 'Submitted for IT approval'))));
  each('[data-wl-decline]', 'wlDecline', async (w) => {
    if (await confirmSheet("You don't need it?", `${w.asset_name} · ${resvRange(w)}. It will be offered to the next person in line.`, "I don't need it", true)) call(`/api/waitlist/${w.id}/decline`, 'Released. Thanks for letting us know');
  });
  const editWl = (w) => rangeSheet({ asset: { id: w.asset_id, name: w.asset_name, tag: w.asset_tag }, start: w.start_date, end: w.end_date, entry: w, onDone: reload });
  each('[data-wl-edit]', 'wlEdit', editWl);
  // the card itself opens the same Edit waitlist dates sheet (links and buttons inside it keep their own jobs)
  $$('[data-wl-card]', root).forEach((c) => {
    const open = () => editWl(find(c.dataset.wlCard));
    c.onclick = (e) => { if (e.target.closest('a,button')) return; open(); };
    c.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); open(); } };
  });
  each('[data-wl-cancel]', 'wlCancel', async (w) => {
    if (await confirmSheet('Leave the waitlist?', `${w.asset_name} · ${resvRange(w)}. You will lose your place in line.`, 'Leave waitlist', true)) call(`/api/waitlist/${w.id}/cancel`, 'You left the waitlist');
  });
  each('[data-wl-remove]', 'wlRemove', async (w) => {
    if (await confirmSheet(`Remove ${w.employee_name} from the waitlist?`, `${w.asset_name} · ${resvRange(w)}. ${w.phase === 'held' ? 'Their hold is released and the next person in line is offered the dates.' : 'They lose their place in line.'}`, 'Remove', true)) call(`/api/waitlist/${w.id}/cancel`, 'Removed from the waitlist');
  });
}

// ============================================================ availability calendar (read-only)
// ONE screen for everyone: #/calendar (everything) · #/calendar?node=<catalog id> (that entry and everything below it) ·
// #/calendar?asset=<id> (one asset), plus &month=YYYY-MM and &day=YYYY-MM-DD. The URL is the whole state, so refresh and deep links
// land on the same calendar. Like every non-root screen it has the app's "‹ <where it goes>" link above the title, and WHERE IT GOES
// is in the URL too: `from=<the hash route the person opened it from>` (e.g. from=#/catalog?node=3). Whatever opens a calendar —
// a header icon, the admin sidebar, the hamburger — fills `from` with the page being left (see the click handler below), so Back
// never depends on browser history or on JS state. A calendar opened without `from` (a typed or shared link) falls back to the
// role's list: Browse equipment / All assets. All availability rules live on the server (src/availability.js, GET /api/availability).
// WHAT THE SELECTED-DAY PANEL SHOWS FOLLOWS THE SCOPE (broader = more summarized): one asset -> that asset in detail (the future home of
// Check out now / Reserve); a catalog entry's subtree or all equipment -> counts only (employees) or counts + the day's temporary checkouts
// (admins). Employees have no all-equipment calendar: it starts from a catalog entry or an asset. An employee's catalog-entry calendar is a
// discovery bridge ("I need any camera"): the counts, then the actual assets of that entry's subtree grouped by state for the selected day
// (available, reserved, checked out). Each row opens THAT asset's calendar on the same day; reserving happens there, never on the list.
// RESERVING (slice 7) lives ONLY on the single-asset calendar, and only when the server says this viewer may (`reserve.allowed`): the same
// grid becomes a date picker (tap the first day, tap the last day), then a small confirmation sheet. Category / everything calendars never
// carry reservation controls. `&reserve=1` in the URL opens it in picking mode (the asset page's Reserve button goes there).
const calUrl = ({ node, asset, month, day, from, reserve } = {}) => {
  const p = new URLSearchParams();
  if (asset) p.set('asset', asset); else if (node) p.set('node', node);
  if (month) p.set('month', month);
  if (day) p.set('day', day);
  if (reserve && asset) p.set('reserve', '1');
  if (from) p.set('from', from);
  return '#/calendar' + (p.toString() ? '?' + p.toString() : '');
};
// Only an in-app hash route may be a Back target (never a login screen or anything that is not "#/…"; a calendar only in the one form below).
const CAL_FROM = /^#\/calendar\?node=\d+(&month=\d{4}-(0[1-9]|1[0-2]))?(&day=\d{4}-\d{2}-\d{2})?(&from=[\w=&%.,-]*)?$/;
const safeFrom = (v) => {
  if (typeof v !== 'string' || v.length > 300) return '';
  // The one calendar that may be a Back target: a catalog-entry calendar (how an asset's calendar returns to the category list it was opened from,
  // with its month and day). Its own `from` must itself be a plain in-app route, so calendars never chain.
  if (CAL_FROM.test(v)) { const inner = new URLSearchParams(v.split('?')[1]).get('from'); return !inner || (!/^#\/calendar\b/.test(inner) && safeFrom(inner)) ? v : ''; }
  return /^#\/[\w/.-]*(\?[\w=&%.,-]*)?$/.test(v) && !/^#\/(calendar|login|forgot|reset|setup|more)\b/.test(v) ? v : '';
};
// The calendar link on a screen. `href` is the plain scoped URL (it works if opened in a new tab); a click also stamps `from`
// with the page it is clicked on, at click time, so filters/drill-down state in that page's URL come back exactly.
const calendarLink = ({ node, asset } = {}) => `<a class="iconbtn cal-btn" href="${calUrl({ node, asset })}" data-cal data-node="${node || ''}" data-asset="${asset || ''}" aria-label="Availability calendar for this view" title="Availability calendar">${icon('calendar')}</a>`;
const calendarSource = () => (location.hash.startsWith('#/calendar') ? safeFrom(qs().get('from')) : safeFrom(location.hash)); // (from a calendar: keep its own source)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-cal]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(calUrl({ node: a.dataset.node, asset: a.dataset.asset, from: calendarSource() }));
});
// What the Back link says and where it goes, from the `from` route. Names come from real data (a catalog entry's name, an asset's
// or person's name), never from the URL text. Unknown routes still get a plain, working "Back".
async function calBackTarget(from, sc) {
  const admin = isAdmin();
  const fixed = { '#/home': 'Home', '#/assets': admin ? 'All assets' : 'Browse equipment', '#/catalog': 'All assets', '#/labels/new': 'Create labels', '#/locations': 'Locations', '#/requests': 'Requests', '#/people': 'People', '#/labels': 'Print labels', '#/import': 'Import / export', '#/activity': 'Activity log', '#/settings': 'Settings', '#/profile': 'My profile', '#/equipment': 'My equipment', '#/history': 'History', '#/scan': 'Scan', '#/account': 'Profile', '#/new': 'Add an asset' };
  if (!from) return { href: '#/assets', label: admin ? 'All assets' : 'Browse equipment' }; // a typed / shared link: the role's list
  const [path, query = ''] = from.split('?'); const q = new URLSearchParams(query);
  const node = Number(q.get('node'));
  try {
    if (path === '#/calendar' && Number.isInteger(node) && node > 0) { // back to a category's calendar (same month and day)
      const row = (await api('GET', '/api/catalog' + (admin ? '?include_archived=1' : ''))).find((n) => n.id === node);
      return { href: from, label: row ? `${row.name} calendar` : 'Calendar' };
    }
    if ((path === '#/catalog' || path === '#/assets') && Number.isInteger(node) && node > 0) {
      if (sc && sc.type === 'node' && sc.id === node) return { href: from, label: sc.title };
      const row = (await api('GET', '/api/catalog' + (admin ? '?include_archived=1' : ''))).find((n) => n.id === node);
      if (row) return { href: from, label: row.name };
    }
    let m;
    if ((m = path.match(/^#\/asset\/(\d+)(\/edit)?$/))) {
      if (sc && sc.type === 'asset' && sc.id === Number(m[1])) return { href: from, label: sc.title };
      return { href: from, label: (await api('GET', '/api/assets/' + m[1])).asset.name };
    }
    if ((m = path.match(/^#\/person\/(\d+)$/))) return { href: from, label: (await api('GET', '/api/users/' + m[1])).user.name };
  } catch { /* fall through to the generic label */ }
  return { href: from, label: fixed[path] || 'Back' };
}
async function viewCalendar() {
  if (!isAdmin()) setActive('assets'); // employees reach it from Browse, so Browse stays highlighted
  const p = qs();
  const today0 = localToday();
  const want = { node: p.get('node') || '', asset: p.get('asset') || '', month: /^\d{4}-(0[1-9]|1[0-2])$/.test(p.get('month') || '') ? p.get('month') : '', day: /^\d{4}-\d{2}-\d{2}$/.test(p.get('day') || '') ? p.get('day') : '', from: safeFrom(p.get('from')), reserve: p.get('reserve') === '1' };
  const st = { month: want.month || today0.slice(0, 7), day: want.day, data: null };
  const q = () => new URLSearchParams({ ...(want.asset ? { asset: want.asset } : want.node ? { node: want.node } : {}), month: st.month }).toString();
  const keepUrl = () => history.replaceState(null, '', calUrl({ node: want.node, asset: want.asset, month: st.month === today0.slice(0, 7) ? '' : st.month, day: st.day === defaultDay() ? '' : st.day, reserve: sel.on, from: want.from })); // (the default month/day are left out of the URL)
  const monthShift = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const monthTitle = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const MAX_AHEAD = 12; // months the arrows allow (the data only knows what is checked out today)

  let data; let A = []; let monthDays = 0;
  const isSummary = () => data.view === 'summary'; // broad scope (catalog subtree / everything): counts, not asset rows
  try { data = await api('GET', '/api/availability?' + q()); } catch (e) {
    const eb = await calBackTarget(want.from, null);
    main().innerHTML = `<div id="backslot">${backLink(eb.href, eb.label, true)}</div><div class="page-head"><h1>Calendar</h1></div><div class="card"><div class="empty">${icon('calendar')}<p>${esc(e.message)}</p><a class="btn" href="${isAdmin() ? '#/calendar' : '#/assets'}">${isAdmin() ? 'Open the full calendar' : 'Back to Browse'}</a></div></div>`;
    return;
  }
  st.data = data; st.month = data.month;
  const sc = data.scope;
  monthDays = Number(data.last.slice(8));
  const defaultDay = () => (st.month === data.today.slice(0, 7) ? data.today : data.first);
  if (!st.day || st.day.slice(0, 7) !== st.month) st.day = defaultDay();

  const back = await calBackTarget(want.from, sc); // always present: from the URL, else the role's list

  A = data.assets || [];
  // Reserving: offered only on the single-asset view, only when the server says so. `sel` = the range being picked (end '' = just the start so far).
  const canReserve = !isSummary() && !!(A[0] && A[0].reserve && A[0].reserve.allowed);
  const sel = { on: canReserve && want.reserve, start: '', end: '' };
  const stateCache = new Map(); // month -> this asset's day states, so a range can be checked across months
  const cacheMonth = () => { if (!isSummary() && A[0]) stateCache.set(data.month, A[0].days); };
  cacheMonth();
  const cellInfo = (i) => {
    const day = data.first.slice(0, 8) + String(i + 1).padStart(2, '0');
    if (day < data.today) return { day, cls: 'past', text: '', label: `${fmtDate(day)}: past` };
    if (!isSummary()) {
      const s = A[0].days[i];
      const cls = { available: 'free', expected: 'expected', occupied: 'busy', reserved: 'reserved', partial: 'partial' }[s] || 'off';
      return { day, cls, text: '', label: `${fmtDate(day)}: ${DAY_WORD[s]}` };
    }
    const c = data.days[i]; const n = c.available; const e = c.expected; const total = data.total;
    const cls = !total ? 'off' : n === total ? 'free' : n > 0 || c.partial > 0 ? 'mixed' : e > 0 ? 'expected' : 'busy';
    // "36" = available that day; "+2" = two more are expected back by then (a due date, not a guarantee)
    return { day, cls, text: total ? `${n}${e ? `<em>+${e}</em>` : ''}` : '', label: `${fmtDate(day)}: ${n} of ${total} available${e ? `, ${e} more expected back` : ''}` };
  };
  const DAY_WORD = { available: 'available', expected: 'expected back (not guaranteed)', occupied: 'unavailable', reserved: 'reserved', partial: 'partially scheduled', repair: 'in repair', ineligible: 'not lendable', archived: 'archived', past: 'past' };

  const periodsOn = (a, day, kind) => a.periods.filter((x) => x.kind === kind && x.start <= day && (!x.end || day <= x.end));
  const clock = (t) => (t ? ` ${fmtClock(t)}` : '');
  const detail = (a, day, i) => {
    const s = a.days[i]; const adminV = isAdmin();
    // (plain text: the whole row is already a link to the asset, and links must not nest)
    const who = (x) => (adminV && x.holder ? `${esc(x.holder.name)}${x.holder.department ? ' · ' + esc(x.holder.department) : ''}` : '');
    const parts = [];
    if (s === 'available') { if (a.seats) parts.push(`${a.seats.total - a.seats.used} of ${a.seats.total} seats free`); }
    else if (s === 'occupied') {
      for (const x of periodsOn(a, day, 'occupied')) {
        const when = x.overdue ? `past its return date — still out, return date unknown` : x.open_ended ? `no return date` : `until ${fmtDate(x.end)}${clock(x.due_time)}`;
        parts.push(`${a.mine && !adminV ? 'With you' : 'Out'} · ${when}${adminV ? ` · since ${fmtDate(x.start)}${x.assignment_type === 'permanent' ? ' · permanent' : ''}` : ''}${who(x) ? ' · ' + who(x) : ''}`);
      }
    } else if (s === 'expected') {
      const ends = periodsOn(a, day, 'expected').map((x) => addDaysStr(x.start, -1));
      parts.push(`Due back ${ends.length ? 'by ' + fmtDate(ends.sort()[0]) : 'before then'} — not guaranteed`);
      if (adminV) parts.push(...periodsOn(a, day, 'expected').map(who).filter(Boolean));
    } else if (s === 'reserved' || s === 'partial') { /* listed below, with every other entry on this day */
    } else parts.push(DAY_WORD[s].replace(/^./, (c) => c.toUpperCase()));
    // Every confirmed reservation and active hold on this day, with its hours. Overlapping ones are all listed (a day can hold several, and the calendar is not a lock).
    for (const x of (a.reservations || []).filter((r) => r.status === 'confirmed' && r.start <= day && day <= r.end)) {
      parts.push(`Reserved: ${esc(calRange(x, day))}${x.mine && !adminV ? ' · by you' : ''}${adminV && x.holder ? ' · ' + who(x) : ''}`);
    }
    // time held for someone from the waitlist (an offer that expires): scheduled for that team, whoever the person is
    for (const x of (a.holds || []).filter((h) => h.start <= day && day <= h.end)) {
      const t = esc(calRange(x, day));
      parts.push(x.mine ? `Available for you: ${t} until ${x.hold_expires_text || fmtStamp(x.hold_expires_at)}` : `On hold for a waitlisted team: ${t}${adminV && x.hold_expires_at ? ' until ' + (x.hold_expires_text || fmtStamp(x.hold_expires_at)) : ''}${adminV && x.holder ? ' · ' + who(x) : ''}`);
    }
    // a request still waiting for IT does not hold the day; its owner (and IT) is reminded of it here
    for (const x of (a.reservations || []).filter((r) => r.status === 'pending' && r.start <= day && day <= r.end)) {
      parts.push(`${adminV ? 'Pending request' : 'Your request'} ${esc(calRange(x))} is waiting for IT approval${adminV && x.holder ? ' · ' + who(x) : ''}`);
    }
    return parts;
  };
  const addDaysStr = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

  const dayTitle = (day) => new Date(Date.parse(day + 'T12:00:00Z')).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const passedHtml = (day) => `<div class="card pad"><strong>${esc(fmtDate(day))}</strong><p class="muted small" style="margin:6px 0 0">This day has passed. The calendar only looks forward from today.</p></div>`;

  // ONE asset: the detailed view. Name and tag, the date, and exactly what that day is for this asset (the place future reservation controls will live).
  const assetPanel = (day, i) => {
    const a = A[0]; const k = a.days[i];
    const word = k === 'expected' ? 'Expected back' : DAY_WORD[k].replace(/^./, (c) => c.toUpperCase()); // 'Available', 'Unavailable', 'In repair', 'Not lendable'…
    const lines = detail(a, day, i).filter((l) => l !== word); // the state is already the headline; keep only the extra detail (who/until/seats)
    return `<div class="card cal-asset"><div class="cal-asset-id"><div class="title">${esc(a.name)}${a.mine ? ' <span class="pill plain available">Yours</span>' : ''}</div>${a.tag ? `<div class="mono small muted">${esc(a.tag)}</div>` : ''}</div>
      <div class="cal-asset-day"><h2>${esc(dayTitle(day))}</h2><div class="cal-state"><span class="cal-dot ${k}"></span><strong>${esc(word)}</strong></div>
      ${lines.map((l) => `<p class="small muted" style="margin:4px 0 0">${l}</p>`).join('')}</div></div>`;
  };

  // A catalog subtree / everything: counts only. Never the assets themselves.
  const countRows = (c) => {
    if (isAdmin()) { // schedulable pool only (permanently assigned equipment is not part of this calendar): available · checked out · repair
      const rows = [[c.available, 'available', 'available'], [c.checked_out, 'checked out', 'occupied'], [c.expected, 'expected back', 'expected'], [c.reserved, 'reserved', 'reserved'], [c.partial, 'partially scheduled', 'partial'], [c.off, 'in repair or not lendable', 'off']];
      return rows.filter(([n, , k]) => n || !['expected', 'reserved', 'partial'].includes(k));
    }
    const rows = [[c.available, 'available', 'available'], [c.unavailable, 'checked out', 'occupied'], [c.expected, 'expected back', 'expected'], [c.reserved, 'reserved', 'reserved'], [c.partial, 'partially scheduled', 'partial']];
    return rows.filter(([n, , k]) => n || !['expected', 'reserved', 'partial'].includes(k));
  };
  const summaryPanel = (day, i) => {
    const c = data.days[i]; const adminV = isAdmin();
    const stats = data.total ? `<ul class="cal-counts">${countRows(c).map(([n, label, k]) => `<li><span class="cal-dot ${k}"></span><strong>${n}</strong> ${label}</li>`).join('')}</ul>` : `<div class="empty"><p>Nothing to show for this scope.</p></div>`;
    const hint = c.expected ? `<p class="small muted" style="margin:0 16px 12px">“Expected back” means a return date falls before this day. It is not a guarantee.</p>` : '';
    return `<div class="card"><div class="card-head"><h2>${esc(dayTitle(day))}</h2></div>${stats}${hint}</div>${adminV ? eventsHtml(day) : assetsHtml(day, i)}`;
  };
  // Employee, catalog-entry calendar: the actual assets for the selected day, grouped by state (the server already left out permanent
  // assignments, items not available to request, and everything outside this entry's subtree). A row opens that asset's own calendar on the
  // same day, with Back returning here; there is deliberately no Reserve button in the list.
  const GROUPS = [['available', 'Available'], ['reserved', 'Reserved'], ['partial', 'Partially scheduled'], ['occupied', 'Checked out'], ['expected', 'Expected back']];
  const calHere = () => calUrl({ node: want.node, month: st.month === today0.slice(0, 7) ? '' : st.month, day: st.day === defaultDay() ? '' : st.day, from: want.from });
  const assetsHtml = (day, i) => {
    if (!data.assets || !data.assets.length) return '';
    const from = safeFrom(calHere()); // (too long to be a safe Back target => the asset calendar falls back to Browse)
    const m = day.slice(0, 7);
    const groups = GROUPS.map(([k, label]) => [k, label, data.assets.filter((a) => a.days[i] === k)]).filter(([, , l]) => l.length);
    return `<div class="card cal-assets">${groups.map(([k, label, list]) => `<h3 class="ct-h" style="margin:14px 16px 4px">${label} <span class="muted">${list.length}</span></h3><ul class="list">${list.map((a) => {
      const sub = detail(a, day, i).filter((l) => l !== label);
      return `<li><a class="item" href="${calUrl({ asset: a.id, month: m === today0.slice(0, 7) ? '' : m, day, from })}"><span class="cal-dot ${k}"></span><div class="grow"><div class="title truncate">${esc(a.name)}${a.mine ? ' <span class="pill plain available">Yours</span>' : ''}</div>
        <div class="sub">${[a.tag ? `<span class="mono">${esc(a.tag)}</span>` : '', ...sub].filter(Boolean).join(' · ')}</div></div>${icon('chev', 'chev')}</a></li>`;
    }).join('')}</ul>`).join('')}${data.assets_truncated ? `<p class="small muted" style="margin:10px 16px 14px">Showing the first ${data.assets.length} items. Open a narrower category to see the rest.</p>` : ''}</div>`;
  };
  // Admin, broad scope: only what is scheduling-relevant — temporary checkouts out on that day (never available assets; permanent assignments are not in this calendar at all).
  const eventsOn = (day) => (data.events || []).filter((x) => x.start <= day && (x.overdue || day <= x.end));
  const eventsHtml = (day) => {
    const list = eventsOn(day); const SHOW = 25;
    const row = (x) => {
      const when = x.overdue ? 'past its return date, still out' : `until ${fmtDate(x.end)}${clock(x.due_time)}`;
      return `<li><a class="item" href="#/asset/${x.asset_id}${srcQ('calendar', { node: sc.type === 'node' ? sc.id : null })}"><span class="cal-dot ${x.overdue ? 'overdue' : 'occupied'}"></span><div class="grow"><div class="title truncate">${esc(x.name)}</div>
        <div class="sub">${[`<span class="mono">${esc(x.tag)}</span>`, esc(x.holder.name) + (x.holder.department ? ' · ' + esc(x.holder.department) : ''), `${when} · since ${esc(fmtDate(x.start))}`].join(' · ')}</div></div>${icon('chev', 'chev')}</a></li>`;
    };
    return `<div class="card"><div class="card-head"><h2>Temporary checkouts</h2><span class="muted small">${list.length}${data.events_truncated ? '+' : ''}</span></div>
      ${list.length ? `<ul class="list">${list.slice(0, SHOW).map(row).join('')}</ul>${list.length > SHOW ? `<p class="small muted" style="margin:10px 16px">+${list.length - SHOW} more. Narrow the calendar to a category to see fewer.</p>` : ''}` : `<div class="empty"><p>No temporary checkouts on this day.</p></div>`}</div>`;
  };

  // The reservation card under the single-asset day panel: a button to start, then the range being picked.
  const nDays = (s0, e0) => Math.round((Date.parse(e0 + 'T00:00:00Z') - Date.parse(s0 + 'T00:00:00Z')) / 864e5) + 1;
  const rangeText = (s0, e0) => (s0 === e0 ? fmtDate(s0) : `${fmtDate(s0)} – ${fmtDate(e0)}`);
  const reservePanel = () => {
    const a = A[0]; const needs = a.reserve.requires_approval;
    if (!sel.on) {
      return `<div class="card pad cal-reserve"><button class="btn primary lg block" id="resv-start">${icon('calendar')} Reserve this asset</button>
        <p class="small muted" style="margin:10px 0 0">You will pick a start and an end date on the calendar, then add a pickup or return time if you need one. ${needs ? 'IT approves reservations for this item.' : 'Reservations for this item are confirmed right away.'} Need a day that is already reserved? Tap it to join the waitlist.</p></div>`;
    }
    const e0 = sel.end || sel.start;
    return `<div class="card pad cal-reserve"><h3 style="margin:0 0 6px">Reserve ${esc(a.name)}</h3>
      <p class="small muted" style="margin:0 0 10px">${!sel.start ? 'Tap the first day you need it.' : !sel.end ? 'Tap the last day, or tap the same day again for a single day. Both days are included.' : 'Both days are included. Tap another day to start over.'}</p>
      ${sel.start ? `<div class="cal-range"><strong>${esc(rangeText(sel.start, e0))}</strong><span class="muted small"> · ${nDays(sel.start, e0)} day${nDays(sel.start, e0) === 1 ? '' : 's'}${sel.end ? '' : ' so far'}</span></div>` : ''}
      <div class="row wrap" style="gap:8px;margin-top:12px"><button class="btn" id="resv-cancel">Cancel</button>${sel.start ? '<button class="btn" id="resv-clear">Clear dates</button>' : ''}<button class="btn primary" id="resv-go" ${sel.start ? '' : 'disabled'}>${needs ? 'Review request' : 'Review & reserve'}</button></div></div>`;
  };
  // Waitlist (slice 8). Offered when the day you are looking at is reserved by someone else (or held for another team). Joining changes nothing
  // for the current reserver; if time you ask for frees up you get an offer with a limited time to confirm, first come, first served.
  const wlStatus = (w) => (w.phase === 'held' ? `available for you until ${w.hold_expires_text || fmtStamp(w.hold_expires_at)}` : 'waitlisted');
  const waitlistPanel = () => {
    const mineWl = (A[0].waitlist || []).filter((w) => w.mine);
    if (!mineWl.length) return '';
    return `<div class="card pad cal-reserve"><h3 style="margin:0 0 6px">Your waitlist</h3><div class="stack" style="gap:6px">${mineWl.map((w) => `<div class="small"><strong>${esc(resvRange({ start_date: w.start, start_time: w.start_time, end_date: w.end, end_time: w.end_time }))}</strong> · ${esc(wlStatus(w))}</div>`).join('')}<a class="small" href="#/requests?tab=reservations">${mineWl.some((w) => w.phase === 'held') ? 'Confirm or let go of your hold' : 'Edit dates or leave the waitlist'} →</a></div></div>`;
  };
  // IT: everyone in line for this asset, oldest first. (Informational: IT may remove an entry from Requests > Reservations, never reorder one.)
  const queueHtml = () => {
    const q = isAdmin() && A[0] && A[0].waitlist ? A[0].waitlist : [];
    if (!q.length) return '';
    return `<div class="card"><div class="card-head"><h2>Waitlist</h2><span class="muted small">${q.length}</span></div><ul class="list">${q.map((w, n) => `<li><a class="item" href="#/requests?tab=reservations"><div class="grow"><div class="title truncate">${n + 1}. ${esc(w.holder.name)}${w.holder.department ? ' · ' + esc(w.holder.department) : ''}</div>
      <div class="sub">${esc(resvRange({ start_date: w.start, start_time: w.start_time, end_date: w.end, end_time: w.end_time }))} · ${w.phase === 'held' ? `offered until ${esc(w.hold_expires_text || fmtStamp(w.hold_expires_at))}` : 'waiting'} · joined ${esc(fmtWhen(w.created_at))}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>`;
  };
  // The one date sheet (see rangeSheet): reserve, or join the waitlist when the range is reserved. Afterwards the calendar reloads as it is now.
  // What a day holds, in the words the sheet uses: the asset's own schedule, then THIS viewer's reservation / offer, then their waitlist (IT: everyone's waitlist).
  const dayHtml = (day) => {
    const a = A[0]; const i = Number(day.slice(8)) - 1;
    const lines = detail(a, day, i);
    const mineRe = / · by you$|^Available for you:|^Your request/;
    const strip = (l) => l.replace(/^Reserved: /, '').replace(/ · by you$/, '');
    const wl = (a.waitlist || []).filter((w) => w.phase !== 'held' && w.start <= day && day <= w.end)
      .map((w) => `${esc(calRange(w, day))}${isAdmin() && w.holder ? ' · ' + esc(w.holder.name) : ''}`);
    // neutral = what the asset already has; green = reserved for ME; amber = still waiting, not guaranteed
    return [['Current asset reservation', lines.filter((l) => !mineRe.test(l)).map(strip), ''], ['Your reservation', lines.filter((l) => mineRe.test(l)).map(strip), ' ok'], [isAdmin() ? 'Waitlist' : 'Your waitlist', wl, ' wait']]
      .filter(([, l]) => l.length).map(([h, l, c]) => `<span class="rs-sched${c}"><strong>${h}</strong>${l.map((x) => `<span>${x}</span>`).join('')}</span>`).join('');
  };
  // Read-only: the same detail for someone who cannot reserve here (IT, or an item that is not reservable).
  const daySheet = (day) => sheet(`<h2>${esc(dayTitle(day))}</h2><p class="muted small" style="margin-top:0"><strong>${esc(A[0].name)}</strong>${A[0].tag ? ` <span class="mono">${esc(A[0].tag)}</span>` : ''}</p>${dayHtml(day)}<div class="sheet-actions"><button type="button" class="btn primary" data-close>Close</button></div>`);
  const openRange = (s0, e0, reservedDay) => rangeSheet({ asset: A[0], start: s0, end: e0, reservedDay, scheduledHtml: reservedDay ? dayHtml(s0) : '', today: data.today, onDone: async () => {
    sel.on = false; sel.start = sel.end = ''; stateCache.clear(); await go2(st.month);
    if (s0.slice(0, 7) === st.month) { st.day = s0; keepUrl(); paint(); }
  } });
  const panelHtml = () => {
    const day = st.day; const i = Number(day.slice(8)) - 1;
    const body = day < data.today ? passedHtml(day) : isSummary() ? summaryPanel(day, i) : assetPanel(day, i);
    const prio = !isSummary() && A[0] && A[0].priority_hold;
    const prioNotice = prio ? `<div class="banner info">${icon('calendar')}<div class="grow small"><strong>On a priority hold</strong> for another employee until ${esc(prio.until_text)}. Reserving is paused for everyone else until then${canReserve ? ': you can join the waitlist for the dates you want' : ''}.</div></div>` : '';
    return prioNotice + body + (canReserve ? reservePanel() + waitlistPanel() : '') + (isSummary() ? '' : queueHtml());
  };

  const gridHtml = () => {
    const [y, mo] = st.month.split('-').map(Number);
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const cells = Array.from({ length: lead }, () => '<span class="cal-day blank" aria-hidden="true"></span>');
    const range = sel.on && sel.start ? [sel.start, sel.end || sel.start] : null;
    for (let i = 0; i < monthDays; i++) {
      const c = cellInfo(i);
      const pick = sel.on && c.day >= data.today ? (['off', 'past'].includes(c.cls) ? ' nopick' : ' pick') : '';
      const inR = range && c.day >= range[0] && c.day <= range[1];
      const edge = range && (c.day === range[0] || c.day === range[1]);
      cells.push(`<button type="button" class="cal-day ${c.cls}${pick}${inR ? ' inrange' : ''}${edge ? ' edge' : ''}${c.day === st.day ? ' sel' : ''}${c.day === data.today ? ' today' : ''}" data-day="${c.day}" aria-label="${esc(c.label)}${inR ? ', selected' : ''}" aria-pressed="${c.day === st.day}"><span class="d">${i + 1}</span><span class="c">${c.text}</span></button>`);
    }
    return cells.join('');
  };
  const nowMonth = data.today.slice(0, 7);
  const paint = () => {
    $('#calgrid').innerHTML = gridHtml();
    $('#calpanel').innerHTML = panelHtml();
    $('#calmonth').textContent = monthTitle(st.month);
    $('#calprev').disabled = st.month <= nowMonth;
    $('#calnext').disabled = st.month >= monthShift(nowMonth, MAX_AHEAD);
  };
  const subtitle = !isSummary() ? [A[0] && A[0].tag ? esc(A[0].tag) : '', A[0] && A[0].catalog_path ? esc(crumbText(A[0].catalog_path)) : ''].filter(Boolean).join(' · ') : `${sc.type === 'node' ? esc(crumbText(sc.path)) + ' · ' : ''}${data.total}${sc.truncated ? '+' : ''} asset${data.total === 1 ? '' : 's'}`;
  main().innerHTML = `<div id="backslot">${backLink(back.href, back.label, true)}</div><div class="page-head"><h1>${esc(sc.title)}</h1></div>
    <div class="cal-wrap stack">
      <p class="muted small" style="margin:0">Availability calendar${subtitle ? ' · ' + subtitle : ''}</p>
      <div class="card cal-card">
        <div class="cal-nav"><button type="button" class="iconbtn" id="calprev" aria-label="Previous month">${icon('back')}</button><h2 id="calmonth" aria-live="polite"></h2><button type="button" class="iconbtn" id="calnext" aria-label="Next month">${icon('chev')}</button></div>
        <div class="cal-wd" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid" id="calgrid"></div>
        <div class="cal-legend small muted"><span><i class="free"></i>Available</span>${isSummary() ? '<span><i class="mixed"></i>Some available</span>' : ''}<span><i class="expected"></i>Expected back</span><span><i class="reserved"></i>Reserved</span><span><i class="partial"></i>Partly scheduled</span><span><i class="busy"></i>Unavailable</span>${isAdmin() ? '<span><i class="off"></i>Repair / not lendable</span>' : ''}</div>
      </div>
      <div id="calpanel"></div>
      <p class="small muted">Based on what is checked out right now. A due date is when something is expected back, not a booking, so those days are shown as <em>expected</em>, never as guaranteed${isSummary() ? ' (a “+2” on a day means two more are expected back by then)' : ''}. ${isAdmin() && isSummary() ? 'Permanently assigned equipment is not part of this calendar. ' : ''}Confirmed reservations and dates held for someone from the waitlist show as reserved, or as partly scheduled when only part of the day is taken. That time is unavailable: ask for it and it goes on the waitlist, while any free time in your request is reserved. People waiting are not shown on the grid, only in the waitlist lists. A request still waiting for IT approval does not count.</p>
    </div>`;
  const go2 = async (month) => {
    st.month = month; st.day = '';
    try { data = await api('GET', '/api/availability?' + q()); } catch (e) { return fail(e); }
    st.data = data; st.month = data.month; st.day = defaultDay();
    A = data.assets || []; monthDays = Number(data.last.slice(8)); cacheMonth();
    keepUrl(); paint();
  };
  // ---- picking a range (single-asset calendar only)
  const stateOf = (d) => { const days = stateCache.get(d.slice(0, 7)); return days ? days[Number(d.slice(8)) - 1] : null; };
  const takeable = (s0) => ['available', 'expected', 'partial', 'reserved', 'occupied'].includes(s0); // anything lendable can be ASKED for (the server reserves what is free and waitlists the rest)
  const ensureMonths = async (s0, e0) => {
    for (let m = s0.slice(0, 7); m <= e0.slice(0, 7); m = monthShift(m, 1)) {
      if (!stateCache.has(m)) stateCache.set(m, (await api('GET', `/api/availability?asset=${want.asset}&month=${m}`)).assets[0].days);
    }
  };
  const hasReserved = (s0, e0) => { for (let d = s0; d <= e0; d = addDaysStr(d, 1)) if (stateOf(d) === 'reserved') return true; return false; };
  const pickDay = async (day) => {
    if (day < data.today) return;
    if (!takeable(stateOf(day))) { toast(`${fmtDate(day)} can't be reserved.`, true); return; }
    if (!sel.start || sel.end || day < sel.start) { sel.start = day; sel.end = ''; return; }
    if (day === sel.start) { sel.end = day; return; }
    try { await ensureMonths(sel.start, day); } catch (e) { fail(e); return; }
    sel.end = day;
    if (hasReserved(sel.start, day)) return 'conflict'; // a reserved day inside the range: open the sheet at once (it says what is reserved and what is free)
  };
  paint();
  $('#calprev').onclick = () => go2(monthShift(st.month, -1));
  $('#calnext').onclick = () => go2(monthShift(st.month, 1));
  // Tapping a day must never feel dead: when it opens no sheet, bring the day's detail panel into view and flash it so the eye lands on what is scheduled.
  const revealPanel = (day) => {
    const panel = $('#calpanel'); if (!panel) return;
    const k = A[0] ? A[0].days[Number(day.slice(8)) - 1] : null;
    if (!isSummary() && !['reserved', 'partial', 'occupied', 'expected'].includes(k) && panel.getBoundingClientRect().top <= window.innerHeight - 120) return;
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash');
  };
  $('#calgrid').onclick = async (e) => {
    const b = e.target.closest('[data-day]'); if (!b) return;
    st.day = b.dataset.day;
    // ANY scheduled or partly scheduled day opens the date sheet right away, whoever holds it (yours, someone else's, IT's view): it lists what is on the
    // day (the asset's schedule, your own reservation, your own waitlist). If a range was being picked it is the end of that range. Someone who cannot
    // reserve here gets the same detail, read-only.
    const i = isSummary() ? -1 : Number(st.day.slice(8)) - 1;
    if (!isSummary() && st.day >= data.today && ['reserved', 'partial'].includes(A[0].days[i])) {
      if (!canReserve) { keepUrl(); paint(); daySheet(st.day); return; }
      const from = sel.on && sel.start && !sel.end && st.day > sel.start ? sel.start : st.day;
      if (from !== st.day) sel.end = st.day;
      keepUrl(); paint(); openRange(from, st.day, from === st.day ? A[0].days[i] : false); return;
    }
    let outcome = null;
    if (sel.on) outcome = await pickDay(st.day);
    keepUrl(); paint();
    if (outcome === 'conflict') { openRange(sel.start, sel.end, false); return; }
    revealPanel(b.dataset.day);
  };
  $('#calpanel').onclick = (e) => {
    const b = e.target.closest('button'); if (!b || !canReserve) return;
    if (b.id === 'resv-start') { sel.on = true; sel.start = sel.end = ''; }
    else if (b.id === 'resv-cancel') { sel.on = false; sel.start = sel.end = ''; }
    else if (b.id === 'resv-clear') { sel.start = sel.end = ''; }
    else if (b.id === 'resv-go') { if (sel.start) openRange(sel.start, sel.end || sel.start, false); return; }
    else return;
    keepUrl(); paint();
  };
  keepUrl();
}

// ============================================================ people
async function viewPeople() {
  const users = await api('GET', '/api/users');
  usersCache = users.filter((u) => u.active);
  main().innerHTML = `<div class="page-head"><h1>People</h1><div class="row" style="gap:8px"><button class="btn" id="imp">${icon('upload')} Import CSV</button><button class="btn primary" id="add">${icon('plus')} Add person</button></div></div>
    <div class="stack"><div class="search">${icon('search')}<input id="q" type="search" placeholder="Search by name, email or department"></div>
    <div class="card" id="list"></div></div>`;
  const render = (q = '') => {
    const ql = q.toLowerCase();
    const rows = users.filter((u) => !ql || [u.name, u.email, u.department, u.title].some((x) => (x || '').toLowerCase().includes(ql)));
    $('#list').innerHTML = rows.length ? `<ul class="list">${rows.map((u) => `<li><a class="item" href="#/person/${u.id}" style="${u.active ? '' : 'opacity:.55'}">
      <div class="avatar">${esc(initials(u.name))}</div><div class="grow"><div class="title truncate">${esc(u.name)} ${u.role === 'admin' ? '<span class="pill checked_out plain" style="margin-left:4px">Admin</span>' : ''}${!u.has_account ? '<span class="pill plain" style="margin-left:4px">No login</span>' : u.can_self_checkout ? '<span class="pill available plain" style="margin-left:4px">Self-checkout</span>' : '<span class="pill lost plain" style="margin-left:4px">No self-checkout</span>'}${!u.active ? '<span class="pill plain" style="margin-left:4px">Inactive</span>' : ''}</div>
      <div class="sub truncate">${esc(u.department ? u.department + ' · ' : '')}${esc(u.email || 'No email')}</div></div>
      ${u.asset_count ? `<span class="pill plain">${u.asset_count} item${u.asset_count > 1 ? 's' : ''}</span>` : ''}${icon('chev', 'chev')}</a></li>`).join('')}</ul>` : `<div class="empty">${icon('users')}<p>No people found.</p></div>`;
  };
  render();
  $('#q').oninput = (e) => render(e.target.value.trim());
  $('#add').onclick = () => personSheet(null, (u) => go('#/person/' + u.id));
  $('#imp').onclick = () => employeeImportSheet(() => go('#/people'));
}

// Employee CSV import (docs/briefs/employee-csv-import.md): choose a file, see what would change, confirm. The server recomputes the plan when
// importing, so the file is simply sent again; nothing is kept between the two steps.
const IMPORT_ACTION = { create: 'New', update: 'Update', unchanged: 'Unchanged', invalid: 'Left out', duplicate: 'Left out', conflict: 'Left out' };
const IMPORT_FIELD = { first_name: 'First name', last_name: 'Last name', name: 'Display name', department: 'Department', title: 'Job title', phone: 'Phone', building: 'Location' };
function csvDownload(name, rows) { // (a cell that starts like a formula is neutralized, as in the asset export)
  const cellText = (v) => { const t = String(v ?? ''); const safe = /^[=+\-@]/.test(t) ? "'" + t : t; return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe; };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cellText).join(',')).join('\r\n')], { type: 'text/csv' })); a.download = name; a.click();
}
function employeeImportSheet(done) {
  const { el, close } = sheet(`<h2>Import employees from CSV</h2>
    <div id="imp-body" class="stack" style="margin-top:12px">
      <p class="muted" style="margin:0">Add or update many people at once. <strong>first_name</strong>, <strong>last_name</strong> and <strong>work_email</strong> are required (first and last name are always separate columns; a combined name column is refused); department, job_title, location and phone are optional. Any other column is refused. People already in the system are matched by work email and only get blank-safe updates.</p>
      <p class="small muted" style="margin:0">Imported people can sign in with their Google work account (no invite needed) and request equipment. They start <strong>without</strong> self-checkout or scanner access; turn it on per person under People. Importing never grants admin, never deactivates anyone, and never changes assignments or history.</p>
      <div class="row wrap"><a class="btn" href="/api/import/employees/template.csv" download>${icon('download')} Download template</a>
        <label class="btn primary">${icon('upload')} Choose CSV file<input type="file" accept=".csv,text/csv" id="imp-file" hidden></label></div>
    </div>`, { wide: true });
  const body = $('#imp-body', el);
  let text = '';
  const rowsTable = (rows) => `<div style="overflow:auto;max-height:320px;border:1px solid var(--line);border-radius:10px"><table class="small" style="width:100%;border-collapse:collapse">
    <thead><tr style="text-align:left"><th style="padding:6px 8px">Row</th><th>Action</th><th>First name</th><th>Last name</th><th>Work email</th><th>Details</th></tr></thead><tbody>${rows.map((r) => `<tr style="border-top:1px solid var(--line)">
      <td style="padding:6px 8px">${r.line}</td><td>${IMPORT_ACTION[r.action]}</td><td>${esc(r.first_name || '')}</td><td>${esc(r.last_name || '')}</td><td>${esc(r.work_email || '')}</td>
      <td>${r.message ? esc(r.message) : esc(Object.entries(r.changes).filter(([f]) => f !== 'name').map(([f, [a, b]]) => r.action === 'update' ? `${IMPORT_FIELD[f]}: ${a || '(blank)'} → ${b}` : `${IMPORT_FIELD[f]}: ${b}`).join('; '))}</td></tr>`).join('')}</tbody></table></div>`;
  const resultsCsv = (p, file) => csvDownload(file, [['Row', 'Result', 'First name', 'Last name', 'Work email', 'Details']].concat(p.rows.map((r) => [r.line, IMPORT_ACTION[r.action] + (r.action === 'unchanged' || r.action === 'create' || r.action === 'update' ? '' : ' (' + r.action + ')'), r.first_name, r.last_name, r.work_email, r.message || Object.entries(r.changes).filter(([f]) => f !== 'name').map(([f, [a, b]]) => `${IMPORT_FIELD[f]}: ${a || ''} -> ${b}`).join('; ')])));
  const showPreview = (p) => {
    const c = p.counts; const shown = p.rows.filter((r) => r.action !== 'unchanged'); const cap = 300;
    body.innerHTML = `<div class="row wrap" style="gap:8px"><span class="pill plain"><strong>${c.create}</strong> new</span><span class="pill plain"><strong>${c.update}</strong> updates</span><span class="pill plain"><strong>${c.unchanged}</strong> unchanged</span><span class="pill ${c.excluded ? 'checked_out' : 'plain'}"><strong>${c.excluded}</strong> left out</span></div>
      ${shown.length ? rowsTable(shown.slice(0, cap)) : '<p class="muted" style="margin:0">Nothing to change: everyone in this file is already up to date.</p>'}
      ${shown.length > cap ? `<p class="small muted" style="margin:0">Showing the first ${cap} of ${shown.length} rows; download the full results below.</p>` : ''}
      ${c.excluded ? `<label class="check"><input type="checkbox" id="imp-ack"><span>I've reviewed the ${c.excluded} row${c.excluded === 1 ? '' : 's'} that will be left out. Import the rest.</span></label>` : ''}
      <div class="sheet-actions"><button type="button" class="btn" id="imp-dl">${icon('download')} Download preview</button><button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn primary" id="imp-go" ${c.create + c.update === 0 || c.excluded ? 'disabled' : ''}>Import ${c.create + c.update} ${c.create + c.update === 1 ? 'person' : 'people'}</button></div>`;
    const go_ = $('#imp-go', el); const ack = $('#imp-ack', el);
    if (ack) ack.onchange = () => { go_.disabled = !(ack.checked && c.create + c.update > 0); };
    $('#imp-dl', el).onclick = () => resultsCsv(p, 'employee-import-preview.csv');
    go_.onclick = () => busy(go_, async () => {
      const q = `?create=${c.create}&update=${c.update}${c.excluded ? '&acknowledge=1' : ''}`;
      let r; try { r = await api('POST', '/api/import/employees' + q, text); } catch (e) { return fail(e); }
      usersCache = null;
      body.innerHTML = `<div class="banner info">${icon('check')}<div><strong>${r.counts.create} added, ${r.counts.update} updated, ${r.counts.unchanged} unchanged${r.counts.excluded ? `, ${r.counts.excluded} left out` : ''}.</strong>
        <div class="small muted">People added can now sign in with Google. Importing the same file again changes nothing.</div></div></div>
        <div class="sheet-actions"><button type="button" class="btn" id="imp-res">${icon('download')} Download results</button><button type="button" class="btn primary" id="imp-done">Done</button></div>`;
      $('#imp-res', el).onclick = () => resultsCsv(r, 'employee-import-results.csv');
      $('#imp-done', el).onclick = () => { close(); done && done(); };
    });
  };
  $('#imp-file', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 2 * 1024 * 1024) { e.target.value = ''; return fail(new Error('That file is too large (2 MB at most).')); }
    text = await f.text();
    body.innerHTML = '<div class="spinner" style="margin:10px 0"></div>';
    try { showPreview(await api('POST', '/api/import/employees/preview', text)); } catch (err) { fail(err); close(); }
  };
}
function personSheet(u, done) {
  const editing = !!u; u = u || { role: 'employee', has_account: true };
  const legacyName = editing && !u.first_name && !u.last_name; // a record from before separate names: never split, editable as it is
  const { el, close } = sheet(`<h2>${editing ? 'Edit person' : 'Add a person'}</h2>
    <form class="form-grid" id="f" style="margin-top:12px">
      <div class="form-grid cols"><label class="field"><span>First name ${legacyName ? '' : '*'}</span><input name="first_name" ${legacyName ? '' : 'required'} value="${esc(u.first_name || '')}" autocomplete="off"></label>
      <label class="field"><span>Last name ${legacyName ? '' : '*'}</span><input name="last_name" ${legacyName ? '' : 'required'} value="${esc(u.last_name || '')}" autocomplete="off"></label></div>
      ${legacyName ? `<div class="small muted" style="margin-top:-6px">Name on file: <strong>${esc(u.name)}</strong> (entered before first and last names were kept separately). Fill in both fields to replace it; leave them empty to keep it.</div>` : ''}
      <label class="field"><span>Work email <span id="em-req">*</span></span><input name="email" type="email" ${editing && !u.has_account ? '' : 'required'} value="${esc(u.email || '')}" autocomplete="off"></label>
      <div class="form-grid cols"><label class="field"><span>Department</span><input name="department" value="${esc(u.department || '')}" list="depts"></label>
      <label class="field"><span>Job title</span><input name="title" value="${esc(u.title || '')}"></label></div>
      <label class="field"><span>Phone</span><input name="phone" type="tel" value="${esc(u.phone || '')}"></label>
      <label class="field"><span>Building <span class="muted">(optional)</span></span><input name="building" value="${esc(u.building || '')}" autocomplete="off"></label>
      <label class="field"><span>Access</span><select name="role"><option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>Employee — sees their own equipment and can request equipment</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin — full access to manage assets &amp; people</option></select></label>
      ${!editing ? `<label class="check"><input type="checkbox" name="login" id="login" checked><span>Create login and send invite</span></label>` : ''}
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${editing ? 'Save' : 'Add person'}</button></div>
    </form><datalist id="depts">${['IT', 'Marketing', 'Operations', 'Sales', 'Finance', 'Customer Service', 'Warehouse', 'Product', 'HR'].map((d) => `<option value="${d}">`).join('')}</datalist>`);
  const loginBox = $('#login', el);
  if (loginBox) loginBox.onchange = () => {
    const on = loginBox.checked;
    $('[name=email]', el).required = on; $('#em-req', el).style.display = on ? '' : 'none';
    $('[name=role]', el).disabled = !on; // the role has no effect without a login; the selection is kept for when it's re-checked
  };
  $('#f', el).onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!editing) { fd.login = !!fd.login; fd.invite = fd.login; } // one checkbox: login account + invite email, or neither
    busy($('#go', el), async () => {
      const saved = await api(editing ? 'PUT' : 'POST', editing ? `/api/users/${u.id}` : '/api/users', fd);
      usersCache = null; close(); toast(editing ? 'Saved' : fd.invite ? `Added — invite sent to ${saved.email}` : fd.login ? 'Added' : 'Added (no login)'); done && done(saved);
    });
  };
}
async function viewPerson(id) {
  const d = await api('GET', '/api/users/' + id);
  const u = d.user;
  main().innerHTML = `${backLink('#/people', 'People')}
    <div class="card pad"><div class="row" style="align-items:flex-start"><div class="avatar" style="width:56px;height:56px;font-size:18px">${esc(initials(u.name))}</div>
      <div class="grow"><h1>${esc(u.name)}</h1><div class="muted">${esc([u.title, u.department].filter(Boolean).join(' · '))}</div>${u.building ? `<div class="small muted">Building: ${esc(u.building)}</div>` : ''}
      <div class="small" style="margin-top:4px">${u.email ? `<a href="mailto:${esc(u.email)}">${esc(u.email)}</a>` : '<span class="muted">No email</span>'}${u.phone ? ` · <a href="tel:${esc(u.phone)}">${esc(u.phone)}</a>` : ''}</div>
      <div class="row wrap" style="margin-top:8px;gap:6px">${u.role === 'admin' ? pill('checked_out', 'Admin') : ''}${u.has_account ? pill('available', 'Login access') : pill('retired', 'No login')}${!u.active ? pill('lost', 'Inactive') : ''}${u.has_account && !u.has_password ? pill('open', 'Invite pending') : ''}</div></div></div>
      ${u.has_account ? '' : '<div class="small muted" style="margin-top:10px">Self-checkout has no effect until they have a login.</div>'}
      <div class="row wrap" style="margin-top:14px;gap:8px"><button class="btn sm" id="edit">${icon('edit')} Edit</button>
        ${u.has_account ? `<button class="btn sm" id="invite">${icon('mail')} ${u.has_password ? 'Send password reset' : 'Resend invite'}</button>` : `<button class="btn sm" id="give-login">${icon('user')} Give login access</button>`}
        <button type="button" class="btn sm toggle ${u.can_self_checkout ? 'on' : ''}" id="selfco" aria-pressed="${u.can_self_checkout ? 'true' : 'false'}" title="Click to ${u.can_self_checkout ? 'turn off' : 'turn on'}">${icon(u.can_self_checkout ? 'check' : 'x')} Self-checkout ${u.can_self_checkout ? 'enabled' : 'disabled'}</button>
        ${u.id !== S.me.id ? `<button class="btn sm ${u.active ? 'danger' : ''}" id="toggle">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</div></div>
    <div class="section-title">Has now (${d.current.length})</div>
    <div class="card">${d.current.length ? `<ul class="list">${d.current.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}${srcQ('person', { id })}">${thumbHtml(m.thumb, m.category)}<div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub"><span class="mono">${esc(m.tag)}</span> · ${typeText(m)} · since ${fmtStamp(m.checked_out_at)}</div></div>${isOverdue(m.due_date) ? pill('overdue', 'Overdue') : ''}${icon('chev', 'chev')}</a></li>`).join('')}</ul>` : `<div class="empty"><p>Nothing checked out.</p></div>`}
      ${u.active ? `<div class="card-body" style="border-top:1px solid var(--line)"><button class="btn block" id="give">${icon('out')} Check out something to ${esc(u.name.split(' ')[0])}</button></div>` : ''}</div>
    ${d.past.length ? `<div class="section-title">Past equipment</div><div class="card"><ul class="list">${d.past.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}${srcQ('person', { id })}" style="min-height:0"><div class="grow"><div class="title truncate">${esc(m.asset_name)} <span class="mono small muted">${esc(m.tag)}</span></div><div class="sub">${typeText(m)} · ${fmtDate(m.checked_out_at)} → ${fmtDate(m.returned_at)}${m.condition_in ? ` · returned ${esc(m.condition_in)}` : ''}</div></div></a></li>`).join('')}</ul></div>` : ''}`;
  $('#edit').onclick = () => personSheet(u, () => route(true));
  const gl = $('#give-login');
  if (gl) gl.onclick = () => {
    const { el, close } = sheet(`<h2>Give ${esc(u.name)} a login</h2><form class="form-grid" id="gl" style="margin-top:12px">
      <label class="field"><span>Login email *</span><input name="email" type="email" required value="${esc(u.email || '')}"></label>
      <label class="field"><span>Access</span><select name="role"><option value="employee">Employee</option><option value="admin">Admin</option></select></label>
      <label class="check"><input type="checkbox" name="invite" checked><span>Email them an invite to set a password</span></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="glgo">Create login</button></div></form>`);
    $('#gl', el).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); fd.invite = !!fd.invite;
      busy($('#glgo', el), async () => { await api('POST', `/api/users/${u.id}/account`, fd); usersCache = null; close(); toast('Login created'); route(true); }); };
  };
  $('#selfco').onclick = (e) => busy(e.currentTarget, async () => {
    await api('PUT', `/api/users/${u.id}/self-checkout`, { enabled: !u.can_self_checkout });
    toast(u.can_self_checkout ? 'Self-checkout disabled' : 'Self-checkout enabled'); route(true);
  });
  const inv = $('#invite');
  if (inv) inv.onclick = (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', `/api/users/${u.id}/invite`, {});
    if (r.link) sheet(`<h2>Email isn't set up yet</h2><p class="muted">Send this link to ${esc(u.name)} yourself. It expires in 7 days.</p><input readonly value="${esc(r.link)}" data-select-all><div class="sheet-actions"><button class="btn primary" data-close>Done</button></div>`);
    else toast('Email sent');
  });
  const t = $('#toggle');
  if (t) t.onclick = async () => {
    if (u.active && !(await confirmSheet(`Deactivate ${u.name}?`, d.current.length ? `They still have ${d.current.length} item(s). They won't be able to sign in, but their equipment stays assigned until checked in.` : "They won't be able to sign in anymore.", 'Deactivate', true))) return;
    try { await api('PUT', `/api/users/${u.id}`, { ...u, active: !u.active }); usersCache = null; toast(u.active ? 'Deactivated' : 'Reactivated'); route(true); } catch (e) { fail(e); }
  };
  const g = $('#give');
  if (g) g.onclick = () => assetPickerSheet({ title: `Check out to ${u.name}`, onPick: async (assetId) => {
    const { asset } = await api('GET', '/api/assets/' + assetId);
    checkoutSheet(asset, () => route(true), u);
  } });
}

// ============================================================ labels
// One label (an Avery 5160 / 8160 cell, 2⅝" × 1"): the company line and category, the tag's Code 128 barcode, the name line (empty on a
// blank label, which gets its name when the asset is added). Barcodes are drawn once JsBarcode (a deferred script) is there.
const labelHtml = ({ tag, category = '', name = '' }) => `<div class="label"><div class="l-top"><span>NUTRICOST IT</span><span>${esc(category)}</span></div><svg data-code="${esc(tag)}"></svg><div class="l-name">${name ? esc(name) : '&nbsp;'}</div></div>`;
function drawBarcodes(root) {
  if (!window.JsBarcode) return setTimeout(() => drawBarcodes(root), 100);
  $$('svg[data-code]', root).forEach((svg) => { try { window.JsBarcode(svg, svg.dataset.code, { format: 'CODE128', height: 40, width: 1.6, margin: 0, fontSize: 12, font: 'monospace', textMargin: 1, displayValue: true }); } catch { /* */ } });
}
// Prints just these labels from any page (the Add asset form's Print label): a temporary sheet is the only thing on paper, then removed.
function printLabels(items) {
  const sheetEl = document.createElement('div');
  sheetEl.className = 'labels-sheet print-sheet';
  sheetEl.innerHTML = items.map(labelHtml).join('');
  document.body.appendChild(sheetEl);
  document.body.classList.add('printing-labels');
  const done = () => { sheetEl.remove(); document.body.classList.remove('printing-labels'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  const go_ = () => (window.JsBarcode ? (drawBarcodes(sheetEl), window.print()) : setTimeout(go_, 100));
  go_();
}

async function viewLabels() {
  const pre = (qs().get('ids') || '').split(',').filter(Boolean).map(Number);
  const all = await api('GET', '/api/assets');
  const selected = new Set(pre);
  main().innerHTML = `<div class="no-print">${pre.length === 1 ? backLink('#/asset/' + pre[0], 'Back') : ''}
    <div class="page-head"><h1>Print labels</h1><button class="btn primary" id="print">${icon('printer')} Print</button></div>
    <p class="muted small" style="margin-top:-6px">Labels for assets already added. Sized for Avery 5160 / 8160 sheets (30 per page, 2⅝" × 1"). Works on most label printers too — set the paper size to your label. Labels for devices not added yet: <a href="#/labels/new">Create labels</a>.</p>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><div class="search grow">${icon('search')}<input id="q" type="search" placeholder="Find assets to add"></div></div>
      <div class="row spread card-body small" style="padding:10px 16px"><span id="count"></span><span class="row"><a href="#" id="all">Select all shown</a> · <a href="#" id="none">Clear</a></span></div>
      <div class="picker-list" id="pick" style="border:0;border-top:1px solid var(--line);border-radius:0;margin:0;max-height:260px"></div></div>
    <div class="section-title">Preview</div></div>
    <div class="labels-sheet" id="sheet"></div>`;
  let shown = all;
  const renderPick = () => {
    $('#pick').innerHTML = shown.map((a) => `<button data-id="${a.id}" class="${selected.has(a.id) ? 'on' : ''}"><input type="checkbox" ${selected.has(a.id) ? 'checked' : ''} tabindex="-1" style="width:20px;height:20px;min-height:0;flex:none;pointer-events:none"><span class="grow"><strong>${esc(a.name)}</strong> <span class="mono small muted">${esc(a.tag)}</span></span></button>`).join('') || '<div class="empty small">No assets</div>';
    $('#count').textContent = `${selected.size} selected`;
  };
  const renderSheet = () => {
    const list = all.filter((a) => selected.has(a.id));
    $('#sheet').innerHTML = list.length ? list.map(labelHtml).join('') : '<p class="muted no-print">Pick assets above to preview their labels.</p>';
    drawBarcodes($('#sheet'));
  };
  const update = () => { renderPick(); renderSheet(); };
  $('#q').oninput = debounce((e) => { const q = e.target.value.toLowerCase(); shown = all.filter((a) => !q || a.name.toLowerCase().includes(q) || a.tag.toLowerCase().includes(q) || (a.category || '').toLowerCase().includes(q)); renderPick(); }, 150);
  $('#pick').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; const id = Number(b.dataset.id); selected.has(id) ? selected.delete(id) : selected.add(id); update(); };
  $('#all').onclick = (e) => { e.preventDefault(); shown.forEach((a) => selected.add(a.id)); update(); };
  $('#none').onclick = (e) => { e.preventDefault(); selected.clear(); update(); };
  $('#print').onclick = () => { if (!selected.size) return toast('Pick at least one asset', true); window.print(); };
  const waitJsb = () => (window.JsBarcode ? update() : setTimeout(waitJsb, 100));
  waitJsb();
}

// Create labels (docs/briefs/labels-and-assets.md): numbered labels printed BEFORE the assets exist. The numbers are claimed from the tag
// counter at once (POST /api/tags/claim), so none is ever given to another asset; stick one on each device and scan it: Add asset opens
// with that tag. The claimed sheet stays on screen to print again (a jammed printer) until the page is left. A browser does not say whether
// the print dialog printed or was cancelled, so after it closes the page asks; "Give the numbers back" (then or later on this page) returns
// them (POST /api/tags/release) so the next Create labels issues the same numbers, as long as nothing newer was issued and none is in use.
async function viewCreateLabels() {
  const saved = (await api('GET', '/api/settings')).tag_prefix;
  main().innerHTML = `<div class="no-print">${backLink('#/assets', 'All assets')}
    <div class="page-head"><h1>Create labels</h1></div>
    <p class="muted small" style="margin-top:-6px">Print numbered labels before the devices are in the system. Stick one on each device, then scan it: <strong>Add asset</strong> opens with that tag filled in. Each number is reserved as soon as the labels are created, so it is never given to another asset. If they don't print, give the numbers back and the next labels reuse them.</p>
    <form class="card pad form-grid" id="pf" novalidate><h2 style="margin:0">Asset tag prefix</h2>
      <div class="input-group" style="max-width:320px"><input name="prefix" value="${esc(saved)}" class="mono" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Asset tag prefix"><button class="btn" id="saveprefix" disabled>Save prefix</button></div>
      <div class="small" id="pnext" aria-live="polite"></div>
      <div class="small muted">Every new tag is this prefix plus the next number, for these labels and for Add asset's automatic numbering alike. Examples: <span class="mono">NC-</span>, <span class="mono">IT-</span>, <span class="mono">LAP-</span>, <span class="mono">MON-</span>. Numbers keep counting up in one sequence whatever the prefix. Changing it affects future tags only: tags on existing assets and labels already printed never change, and printed labels keep working. The example is a preview and reserves nothing.</div></form>
    <form class="card pad form-grid" id="f" style="margin-top:12px"><label class="field"><span>How many labels</span><input name="count" type="number" min="1" max="300" value="30" inputmode="numeric" required style="max-width:160px"></label>
      <div class="small muted">30 fill one Avery 5160 / 8160 sheet (2⅝" × 1"). Up to 300 at a time.</div>
      <button class="btn primary" id="go">${icon('printer')} Create &amp; print</button></form>
    <div id="done" style="margin-top:16px"></div></div>
    <div class="labels-sheet" id="sheet"></div>`;
  // The prefix: a draft is previewed (GET /api/next-tag?prefix=, which consumes nothing) and only a Save changes it. Create & print always
  // uses the saved prefix, so it waits while the draft differs.
  let current = saved, seq = 0;
  const draft = () => $('#pf').elements.prefix.value.trim().toUpperCase();
  const draftOk = () => /^[A-Z0-9._-]{1,10}$/.test(draft());
  const refresh = async () => {
    const mine = ++seq, d = draft(), dirty = d !== current;
    $('#saveprefix').disabled = !dirty || !draftOk();
    $('#go').disabled = dirty;
    if (!draftOk()) { $('#pnext').innerHTML = '<span class="muted">Use 1–10 letters, digits, dashes, dots or underscores.</span>'; return; }
    const { tag } = await api('GET', `/api/next-tag?prefix=${encodeURIComponent(d)}`);
    if (mine !== seq) return;
    $('#pnext').innerHTML = `Next tag: <strong class="mono">${esc(tag)}</strong>${dirty ? ' <span class="muted">· not saved yet. Save the prefix to use it; labels are created with the saved one.</span>' : ''}`;
  };
  $('#pf').elements.prefix.oninput = () => refresh().catch(() => {});
  $('#pf').onsubmit = (e) => {
    e.preventDefault();
    if ($('#saveprefix').disabled) return;
    busy($('#saveprefix'), async () => {
      const r = await api('PUT', '/api/settings', { tag_prefix: draft() });
      S.settings = r; current = r.tag_prefix; $('#pf').elements.prefix.value = current;
      await refresh();
      toast(`Asset tag prefix saved: ${current}. New tags use it; existing tags and printed labels are unchanged.`, false, 'ok');
    });
  };
  refresh().catch(() => {});
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const count = Number(new FormData(e.target).get('count'));
    busy($('#go'), async () => {
      const { tags } = await api('POST', '/api/tags/claim', { count });
      const range = `<span class="mono">${esc(tags[0])}</span>${tags.length > 1 ? ` – <span class="mono">${esc(tags.at(-1))}</span>` : ''}`;
      $('#sheet').innerHTML = tags.map((tag) => labelHtml({ tag })).join('');
      $('#done').innerHTML = `<div class="banner info">${icon('check')}<div class="grow"><strong>${tags.length} label${tags.length === 1 ? '' : 's'} reserved: ${range}</strong><div class="small">They stay below until you leave this page, if you need to print them again. Not printed or not needed? Give the numbers back and the next labels reuse them.</div></div>
        <div class="row wrap" style="gap:8px"><button type="button" class="btn" id="again">${icon('printer')} Print again</button><button type="button" class="btn" id="giveback">Give the numbers back</button></div></div>`;
      const reset = () => { $('#sheet').innerHTML = ''; $('#done').innerHTML = ''; window.removeEventListener('afterprint', ask); };
      const giveBack = async () => {
        await api('POST', '/api/tags/release', { tags });
        reset();
        toast(`Gave back ${tags.length === 1 ? tags[0] : `${tags[0]} – ${tags.at(-1)}`}. The next labels will use these numbers again.`, false, 'ok');
      };
      // after the print dialog closes (printed or cancelled: the browser does not say which), ask once
      const ask = () => {
        window.removeEventListener('afterprint', ask);
        const { el, close } = sheet(`<h2>Did the labels print?</h2><p class="muted">${tags.length} label${tags.length === 1 ? '' : 's'}: ${range}. If they did not print, or you don't need them, give the numbers back so the next labels reuse them.</p>
          <div class="sheet-actions"><button type="button" class="btn" id="no">Give the numbers back</button><button type="button" class="btn primary" data-close>Yes, keep them</button></div>`);
        $('#no', el).onclick = () => busy($('#no', el), async () => { await giveBack(); close(); });
      };
      $('#again').onclick = () => window.print();
      $('#giveback').onclick = () => busy($('#giveback'), giveBack);
      window.addEventListener('afterprint', ask);
      window.addEventListener('hashchange', () => window.removeEventListener('afterprint', ask), { once: true }); // left the page: never ask elsewhere
      const ready = () => (window.JsBarcode ? (drawBarcodes($('#sheet')), window.print()) : setTimeout(ready, 100));
      ready();
    });
  };
}

// ============================================================ locations
// Locations (under All assets, IT only): the managed list behind every asset's Location field. A rename rewrites the assets that carry the old
// name (server, one transaction); a location some asset uses cannot be removed, and names are unique ignoring letter case. Locations an asset
// carries that are not in the list (older free-text values) are listed apart and can be added to it; nothing is changed on the assets.
async function viewLocations() {
  const st = { data: await api('GET', '/api/locations') };
  const nAssets = (n) => `${n} asset${n === 1 ? '' : 's'}`;
  const apply = (d) => { st.data = d; S.settings.locations = d.locations.map((l) => l.name); paint(); }; // the asset forms read the list from S.settings
  const row = (l, i) => `<li class="item loc-row" data-i="${i}"><div class="grow"><div class="title">${esc(l.name)}</div>
      <div class="sub">${l.count ? `Used by ${nAssets(l.count)}` : 'Not used by any asset'}</div></div>
      <button type="button" class="btn sm" data-act="rename" aria-label="Rename ${esc(l.name)}">${icon('edit')} Rename</button>
      <button type="button" class="btn sm danger" data-act="remove" aria-label="Remove ${esc(l.name)}"${l.count ? ` disabled title="Reassign ${l.count === 1 ? 'that asset' : 'those assets'} first"` : ''}>${icon('trash')} Remove</button></li>`;
  const paint = () => {
    const { locations, unlisted } = st.data;
    $('#loclist').innerHTML = locations.length ? `<ul class="list">${locations.map(row).join('')}</ul>` : `<div class="empty">${icon('pin')}<p>No locations yet. Add the first one above.</p></div>`;
    $('#locunl').innerHTML = unlisted.length ? `<div class="section-title">Used by assets, not in the list</div><div class="card"><p class="small muted" style="margin:12px 16px 0">These locations were typed on assets before the list was managed. They are kept as they are; add one to the list to manage it.</p>
      <ul class="list">${unlisted.map((l, i) => `<li class="item" data-u="${i}"><div class="grow"><div class="title">${esc(l.name)}</div><div class="sub">Used by ${nAssets(l.count)}</div></div><button type="button" class="btn sm" data-act="adopt">${icon('plus')} Add to list</button></li>`).join('')}</ul></div>` : '';
    $('#loclist').insertAdjacentHTML('beforeend', locations.some((l) => l.count) ? '<p class="small muted" style="margin:0;padding:10px 16px">A location that assets use can\'t be removed: reassign those assets first (edit an asset and change its Location).</p>' : '');
  };
  main().innerHTML = `<div id="locpage"><div id="backslot">${backLink('#/assets', 'All assets', true)}</div><div class="page-head"><h1>Locations</h1></div>
    <p class="muted small" style="margin-top:-6px">The places an asset can be kept. Every asset's Location field suggests these. Renaming a location updates the assets that use it; a location with assets can't be removed.</p>
    <form class="card pad" id="locadd" style="margin-bottom:12px"><label class="field"><span>Add a location</span><div class="input-group"><input name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Warehouse - Dock 2"><button class="btn primary">${icon('plus')} Add</button></div></label></form>
    <div class="card" id="loclist"></div><div id="locunl"></div></div>`;
  paint();
  $('#locadd').onsubmit = (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    busy(e.target.querySelector('button'), async () => { apply(await api('POST', '/api/locations', { name: input.value })); input.value = ''; toast('Location added', false, 'ok'); });
  };
  $('#locpage').onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const li = b.closest('li');
    if (b.dataset.act === 'adopt') { const l = st.data.unlisted[Number(li.dataset.u)]; return busy(b, async () => { apply(await api('POST', '/api/locations', { name: l.name })); toast('Added to the list', false, 'ok'); }); }
    const l = st.data.locations[Number(li.dataset.i)];
    if (b.dataset.act === 'remove') {
      if (!(await confirmSheet(`Remove ${l.name}?`, 'No asset uses it. It will no longer be suggested on asset forms.', 'Remove', true))) return;
      return busy(b, async () => { apply(await api('DELETE', '/api/locations', { name: l.name })); toast('Location removed', false, 'ok'); });
    }
    const { el, close } = sheet(`<h2>Rename location</h2><form id="rn" class="form-grid"><label class="field"><span>Name</span><input name="to" maxlength="80" required autocomplete="off" value="${esc(l.name)}"></label>
      <p class="small muted" style="margin:0">${l.count ? `The ${nAssets(l.count)} using it will show the new name.` : 'No asset uses it yet.'}</p>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="rnok">Rename</button></div></form>`);
    $('#rn', el).onsubmit = (ev) => { ev.preventDefault(); busy($('#rnok', el), async () => { apply(await api('PUT', '/api/locations', { from: l.name, to: new FormData(ev.target).get('to') })); close(); toast('Location renamed', false, 'ok'); }); };
  };
}

// ============================================================ import / export
function viewImport() {
  main().innerHTML = `<div class="page-head"><h1>Import &amp; export</h1></div><div class="stack">
    <div class="card pad"><h2>Export</h2><p class="muted">Download every asset with its current holder, status and purchase details as a spreadsheet (CSV opens in Excel and Google Sheets).</p>
      <a class="btn primary" href="/api/export/assets.csv">${icon('download')} Download assets CSV</a></div>
    <div class="card pad"><h2>Import from a spreadsheet</h2>
      <p class="muted">Add many assets at once. Save your sheet as <strong>CSV</strong> with a header row. Recognized columns:</p>
      <p class="small mono" style="background:var(--surface-2);padding:10px;border-radius:10px;border:1px solid var(--line)">name*, tag, category, brand, model, serial, condition, location, purchase_date, purchase_cost, vendor, warranty_expires, license_key, license_seats, license_expires, notes, assigned_email</p>
      <p class="small muted">Rows with a tag that already exists update that asset. Leave <em>tag</em> blank to auto-number. <em>assigned_email</em> checks the asset out to that person (they must already be added under People). Dates as YYYY-MM-DD.</p>
      <div class="row wrap"><a class="btn" id="tpl" href="#">${icon('download')} Download template</a>
        <label class="btn primary">${icon('upload')} Choose CSV file<input type="file" accept=".csv,text/csv" id="file" hidden></label></div>
      <div id="result" style="margin-top:14px"></div></div></div>`;
  $('#tpl').onclick = (e) => {
    e.preventDefault();
    const csv = 'name,tag,category,brand,model,serial,condition,location,purchase_date,purchase_cost,vendor,warranty_expires,license_key,license_seats,license_expires,notes,assigned_email\r\nDell Latitude 7440,,Laptop,Dell,Latitude 7440,ABC1234,Good,HQ - IT Room,2025-01-15,1299.00,CDW,2028-01-15,,,,,\r\nMicrosoft 365 Business,,Software License,Microsoft,Business Standard,,,,2026-01-01,,Microsoft,,XXXXX-XXXXX,25,2027-01-01,Annual,\r\n';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'nutricost-assets-template.csv'; a.click();
  };
  $('#file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    $('#result').innerHTML = '<div class="spinner" style="margin:10px 0"></div>';
    try {
      const r = await api('POST', '/api/import/assets', text);
      $('#result').innerHTML = `<div class="banner info">${icon('check')}<div><strong>${r.created} added, ${r.updated} updated.</strong>${r.errors.length ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<div style="margin-top:8px"><a href="#/assets">View assets →</a></div></div></div>`;
    } catch (err) { $('#result').innerHTML = ''; fail(err); }
    e.target.value = '';
  };
}

// ============================================================ activity
async function viewActivity() {
  const rows = await api('GET', '/api/activity?limit=300');
  main().innerHTML = `<div class="page-head"><h1>Activity log</h1></div><div class="card">${activityList(rows, true, 'activity')}</div>`;
}

// ============================================================ settings
async function viewSettings() {
  const s = await api('GET', '/api/settings');
  const outbox = await api('GET', '/api/outbox');
  main().innerHTML = `<div class="page-head"><h1>Settings</h1></div>
    <form id="f" class="stack">
      <div class="card pad"><h2 style="margin-bottom:12px">Check-out rules</h2><div class="form-grid">
        <label class="check"><input type="checkbox" name="overdue_reminders" ${s.overdue_reminders ? 'checked' : ''}><span><strong>Email overdue reminders</strong><br><span class="small muted">Sent when an item passes its due date, then every 3 days.</span></span></label>
        <div class="form-grid cols"><label class="field"><span>Default loan length (days, 0 = none)</span><input name="default_loan_days" type="number" min="0" value="${s.default_loan_days}"></label></div></div></div>
      <div class="card pad stack">
        <div class="set-head"><div class="field"><span>Categories &amp; equipment types</span><span class="small muted">Categories now live in the catalog, where each one can have brands, models and more below it.</span></div>
          <a class="btn" href="#/assets?from=${encodeURIComponent('#/settings')}">${icon('tag')} Manage the equipment catalog</a></div>
        <div class="set-head"><div class="field"><span>Locations</span><span class="small muted">${s.locations.length} location${s.locations.length === 1 ? '' : 's'}, managed under All assets.</span></div>
          <a class="btn" href="#/locations">${icon('pin')} Manage locations</a></div></div>
      <div class="card pad"><h2 style="margin-bottom:4px">IT email</h2>
        <p class="small muted" style="margin:0 0 12px">How emails from this app identify IT (for example waitlist notices). Passwords, app passwords and API keys are never entered here; they stay in the server's environment.</p>
        <div class="form-grid cols"><label class="field"><span>Display name</span><input name="it_email_name" maxlength="80" required value="${esc(s.it_email_name)}"></label>
        <label class="field"><span>IT contact / reply-to email</span><input name="it_contact_email" type="email" autocomplete="off" placeholder="e.g. it@nutricost.com" value="${esc(s.it_contact_email)}"></label></div>
        <p class="small muted" style="margin:10px 0 0">Emails go out as <strong>${esc(s.mailEnvelope.from.name)} &lt;${esc(s.mailEnvelope.from.address)}&gt;</strong>${s.mailEnvelope.replyTo ? `; replies go to <strong>${esc(s.mailEnvelope.replyTo)}</strong>` : ''}. The From address is the server's verified sender; your contact address is used as Reply-To unless the server is set up to send from it.</p></div>
      <button class="btn primary lg block" id="save">Save settings</button>
    </form>
    <div class="section-title">Email notifications</div>
    <div class="card pad stack">
      ${s.mailTestRecipient ? `<div class="banner warn">${icon('alert')}<div><strong>Email test mode:</strong> all outgoing email is being redirected to <strong>${esc(s.mailTestRecipient)}</strong> instead of the real recipients. Subjects start with “[DEV for …]” and show who each message was meant for. This is set by <span class="mono">MAIL_TEST_RECIPIENT</span> on the server, not here.</div></div>` : ''}
      ${s.mailConfigured ? `<div class="banner info">${icon('check')}<div>Sending as <strong>${esc(s.mailEnvelope.from.name)} &lt;${esc(s.mailEnvelope.from.address)}&gt;</strong> via Gmail / Google Workspace.</div></div>`
        : `<div class="banner warn">${icon('alert')}<div><strong>Not configured.</strong> Emails are saved in the outbox below but not sent. Add your Google Workspace SMTP settings to the server's <span class="mono">.env</span> file (see README) and restart.</div></div>`}
      <div class="small muted">Links in emails point to <span class="mono">${esc(s.appUrl)}</span> (set with <span class="mono">APP_URL</span>).</div>
      <button class="btn" id="test">${icon('mail')} Send me a test email</button>
    </div>
    <div class="card" style="margin-top:12px"><div class="card-head"><h2>Outbox <span class="small muted">· development / debug record</span></h2><span class="small muted">Last 100</span></div>
      <p class="small muted" style="margin:0 16px 10px">A record of what the app tried to send. A row here does <strong>not</strong> mean anyone received an email. <strong>Not sent</strong> = email is not configured, so nothing was delivered outside the app. <strong>Sent</strong> = the mail server accepted it. <strong>Failed</strong> = it was rejected (hover for the reason).</p>
      ${outbox.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>${outbox.map((o) => `<tr><td class="small muted" style="white-space:nowrap">${fmtWhen(o.created_at)}</td><td class="small">${esc(o.to_addr)}${o.delivered_to ? `<div class="muted">${o.status === 'sent' ? 'delivered to' : 'would go to'} ${esc(o.delivered_to)} (test mode)</div>` : ''}</td><td>${esc(o.subject)}</td><td>${o.status === 'sent' ? pill('available', 'Sent') : o.status === 'failed' ? `<span title="${esc(o.error || '')}">${pill('lost', 'Failed')}</span>` : `<span title="Email is not configured, so no email was delivered outside the app.">${pill('retired', 'Not sent')}</span>`}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><p>No emails yet.</p></div>`}
    </div>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { overdue_reminders: fd.has('overdue_reminders'), default_loan_days: fd.get('default_loan_days'),
      it_email_name: fd.get('it_email_name'), it_contact_email: fd.get('it_contact_email') };
    busy($('#save'), async () => { S.settings = await api('PUT', '/api/settings', body); toast('Settings saved'); route(true); });
  };
  $('#test').onclick = (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', '/api/settings/test-email', {});
    if (r.status === 'sent') toast(`Test email sent to ${S.me.email}`); else if (r.status === 'failed') toast('Failed: ' + r.error, true); else toast('Email is not configured — saved to outbox', true);
    route(true);
  });
}

// ============================================================ admin: equipment catalog
// The same card-grid drill-down as Browse. Browsing and managing are separate: cards (and the breadcrumb) only navigate;
// "Manage" and "+ Add subcategory" act on the category you are inside. Inside a category the first card is the virtual
// "All in <name>" (browse-only: every non-archived asset in the branch, no management). Without it the page lists what is
// filed directly in the category.
// IT's All assets (docs/briefs/labels-and-assets.md): the equipment catalog drill-down (it replaced the separate Equipment catalog page)
// with the old All assets tools on top: one search box (assets by name, tag, serial, person, brand… and the catalog entries that match),
// the status chips, Add asset, the label pages and the scanner. Every level lists its assets under the cards, filtered by the status.
const ADMIN_STATUSES = [['', 'All'], ['available', 'Available'], ['checked_out', 'Checked out'], ['overdue', 'Overdue'], ['maintenance', 'In repair'], ['lost', 'Lost'], ['retired', 'Retired'], ['disposed', 'Disposed']];
// The Home 'Active assets' card links to ?status=active: a status the page filters by (everything not retired / lost / disposed) but the Filter menu
// does not offer, so it is recognised here and by the source-trail parser (line ~574) from one list.
const STATUS_CHIPS = [...ADMIN_STATUSES, ['active', 'Active']];
async function viewAdminAssets() {
  const st = { rows: [], archived: false, sel: null, all: false, assets: null, token: 0, search: qs().get('q') || '', found: null, searchToken: 0, status: '', page: 1, listOpen: false };
  // The URL is the state: #/assets (all categories), #/assets?node=<id>, #/assets?node=<id>&all=1 ("All in <name>", a browsing view of
  // the real entry <id>), each optionally &status=<chip> (the Home stat cards link to #/assets?status=overdue …). Cards, breadcrumbs and
  // Back navigate to those URLs; hashchange (S.soft) repaints in place. Opened from Settings ("Manage the equipment catalog") the route
  // carries `from=#/settings`, and every URL built below keeps it, so coming back to the top still offers "‹ Settings".
  const fromSettings = () => qs().get('from') === '#/settings';
  const hashFor = (id, all, status = st.status) => {
    const q = id ? [`node=${id}`, ...(all ? ['all=1'] : [])] : [];
    if (status) q.push(`status=${status}`);
    if (fromSettings()) q.push(`from=${encodeURIComponent('#/settings')}`);
    return '#/assets' + (q.length ? '?' + q.join('&') : '');
  };
  main().innerHTML = `<div id="backslot"></div><div class="page-head"><h1 id="pagetitle">All assets</h1><span id="headact" class="row" style="gap:8px"></span></div>
    <div class="stack">
      <div class="atools">
        <div class="atools-row">${ddMenu({ id: 'ddlabels', label: 'Labels', ic: 'tag', items: [{ href: '#/labels/new', label: 'Create labels', ic: 'plus' }, { href: '#/labels', label: 'Print labels', ic: 'printer' }] })}<div id="ddfilter-slot"></div></div>
        <div class="atools-row atools-find"><div class="search grow">${icon('search')}<input id="cq" type="search" aria-label="Search assets" placeholder="Search name, tag, serial, person, brand, category…" value="${esc(st.search)}" enterkeyhint="search" autocomplete="off"></div>
          <button class="btn" id="scanbtn" title="Scan" aria-label="Scan a barcode">${icon('scan')}</button></div>
        <div class="atools-act" id="toolact"></div>
      </div>
      <div class="fchips" id="fchips"></div>
      <label class="check" id="archrow"><input type="checkbox" id="showarch"><span>Show archived catalog entries</span></label>
      <div id="ct"><div class="spinner"></div></div>
    </div>
`;
  const statusLabel = () => (STATUS_CHIPS.find(([v]) => v === st.status) || ['', ''])[1];
  wireDropdowns($('.atools')); // Labels (static markup); Add and Filter are painted, and wired, as the page renders
  // The heading over a status-filtered list: "Overdue assets", "Checked out assets", "Assets in repair"…
  const filteredTitle = () => (st.status === 'maintenance' ? 'Assets in repair' : `${statusLabel()} assets`);
  // The status Filter: a dropdown on desktop, a bottom sheet on phones. The URL (?status=) stays the one source of truth; the button, the
  // menu's tick and the removable chip under the search all follow it.
  const phone = () => window.matchMedia('(max-width: 899px)').matches;
  const gotoStatus = (v) => go(hashFor(st.sel, st.all, v));
  const paintFilter = () => {
    $('#ddfilter-slot').innerHTML = ddMenu({ id: 'ddfilter', label: st.status ? 'Filter (1)' : 'Filter', ic: 'filter', cls: `btn${st.status ? ' active' : ''}`, checked: st.status, items: ADMIN_STATUSES.map(([v, l]) => ({ act: 'status', v, label: l })) });
    wireDropdowns($('#ddfilter-slot'), { status: gotoStatus });
    const b = $('#ddfilter .dd-btn'); const toggle = b.onclick;
    b.onclick = (e) => { if (phone()) return openFilterSheet(); toggle(e); }; // phones get the sheet instead of the popover
    $('#fchips').innerHTML = st.status ? `<button type="button" class="chip fchip" id="fclear" aria-label="Remove the ${esc(statusLabel())} filter">Status: ${esc(statusLabel())}${icon('x')}</button>` : '';
  };
  const openFilterSheet = () => {
    const { el, close } = sheet(`<h2>Filter by status</h2><div class="fsheet" role="radiogroup" aria-label="Status">${ADMIN_STATUSES.map(([v, l]) => `<button type="button" class="fopt${v === st.status ? ' on' : ''}" role="radio" aria-checked="${v === st.status}" data-v="${esc(v)}"><span>${esc(l)}</span>${v === st.status ? icon('check') : ''}</button>`).join('')}</div>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`);
    el.onclick = (e) => { const o = e.target.closest('[data-v]'); if (!o) return; close(); gotoStatus(o.dataset.v); };
  };
  // The header's blue Add menu. "Add category" is only offered at the top of the catalog (and not while searching); inside a category the
  // contextual button is "+ Add subcategory".
  const paintHead = ({ cat, node }) => {
    // Phones: in the header row. Desktop (>= 900px): the same Add menu and calendar link in the toolbar (CSS shows one of the two).
    const add = (id) => `${ddMenu({ id, label: 'Add', ic: 'plus', cls: 'btn primary', align: 'right', items: [{ href: '#/new', label: 'Add asset', ic: 'box' }, ...(cat ? [{ act: 'addroot', label: 'Add category', ic: 'tag' }] : [])] })}${node === undefined ? '' : calendarLink({ node })}`;
    $('#headact').innerHTML = add('ddadd');
    $('#toolact').innerHTML = add('ddadd2');
    for (const slot of ['#headact', '#toolact']) wireDropdowns($(slot), { addroot: () => addRoot() });
  };
  // Lists show PAGE assets at a time (owner, 2026-10-27); the page resets whenever the entry, the status chip or the search changes.
  const PAGE = 10;
  const pageOf = (list) => { st.page = Math.min(Math.max(1, st.page), Math.max(1, Math.ceil(list.length / PAGE))); return list.slice((st.page - 1) * PAGE, st.page * PAGE); };
  const pager = (total) => {
    const pages = Math.ceil(total / PAGE);
    if (pages <= 1) return '';
    const nums = [...new Set([1, st.page - 1, st.page, st.page + 1, pages])].filter((x) => x >= 1 && x <= pages).sort((a, b) => a - b);
    const btns = nums.map((x, i) => `${i && x - nums[i - 1] > 1 ? '<span class="muted">…</span>' : ''}<button type="button" class="chip ${x === st.page ? 'on' : ''}" data-page="${x}" ${x === st.page ? 'aria-current="page"' : ''}>${x}</button>`).join('');
    return `<nav class="pager" aria-label="Pages"><button type="button" class="btn sm" data-page="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>‹ Previous</button>
      <span class="pager-nums">${btns}</span><span class="small muted">${(st.page - 1) * PAGE + 1}–${Math.min(st.page * PAGE, total)} of ${total}</span>
      <button type="button" class="btn sm" data-page="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>Next ›</button></nav>`;
  };
  const listCard = (list, node) => `<div class="card"><ul class="list">${pageOf(list).map((a) => assetRow(a, node)).join('')}</ul></div>${pager(list.length)}`;
  const byId = (id) => st.rows.find((r) => r.id === id);
  const kids = (id) => st.rows.filter((r) => r.parent_id === id && (st.archived || r.live));
  const countText = (n) => (n ? `${n} asset${n === 1 ? '' : 's'}` : 'No assets');
  // One asset in a list. `node`: the entry being viewed (its path is left out of each row's path), or null at the top / in search results.
  const assetRow = (a, node) => {
    const rel = !a.catalog_path ? '' : !node ? crumbText(a.catalog_path) : a.catalog_node_id !== node.id ? crumbText(a.catalog_path.split(' > ').slice(node.path.split(' > ').length).join(' > ')) : '';
    const seats = a.license_seats > 1 ? `${a.seats_used}/${a.license_seats} seats` : '';
    const extra = [a.holder_names, seats, a.model && !a.name.includes(a.model) ? a.model : '', !a.holder_names ? a.location : '', rel].filter(Boolean).map(esc).join(' · ');
    return `<li><a class="item" href="#/asset/${a.id}${srcQ('catalog', { node: node ? node.id : null, all: st.all, status: st.status, from: fromSettings() ? '#/settings' : null })}">${thumbHtml(a.thumb, a.category)}<div class="grow" style="min-width:0"><div class="title">${esc(a.name)}</div>
      <div class="sub" style="overflow-wrap:anywhere"><span class="mono">${esc(a.tag)}</span>${extra ? ' · ' + extra : ''}</div></div>${statusPill(a)}${icon('chev', 'chev')}</a></li>`;
  };
  // Search: while there is text in the box the card grid steps aside for the matching assets (the old All assets search: name, tag, serial,
  // person, brand… within the status chip) and the matching catalog entries, each with its full path; empty = the grid, unchanged.
  const renderFound = () => {
    const f = st.found;
    $('#pagetitle').textContent = 'All assets'; $('#backslot').innerHTML = autoBack(); paintHead({ cat: false });
    if (f === null) { $('#ct').innerHTML = '<div class="spinner"></div>'; return; }
    const assets = f.assets.length
      ? `<p class="small muted" style="margin:0 0 8px">${f.assets.length} asset${f.assets.length === 1 ? '' : 's'}${st.status ? ` · ${esc(statusLabel())}` : ''}</p>${listCard(f.assets, null)}`
      : `<div class="empty">${icon('box')}<p>No asset matches that${st.status ? ` among ${esc(statusLabel())}` : ''}.</p></div>`;
    const entries = f.results.length
      ? `<h3 class="ct-h">Catalog entries <span class="muted">${f.total}</span></h3>${f.total > f.results.length ? `<p class="small muted" style="margin:0 0 8px">Showing the first ${f.results.length}, so add a word to narrow it.</p>` : ''}
        <div class="card"><ul class="list">${f.results.map((r) => `<li><a class="item" href="${hashFor(r.id)}" data-found="${r.id}"><div class="grow" style="min-width:0"><div class="title">${esc(r.name)}${r.archived ? ' <span class="pill plain">Archived</span>' : ''}</div>
          <div class="sub" style="overflow-wrap:anywhere">${esc(crumbText(r.path))}</div>
          <div class="sub">${r.asset_count ? `${r.asset_count} asset${r.asset_count === 1 ? '' : 's'}` : 'No assets'}${r.search_keywords ? ` · keywords: ${esc(r.search_keywords)}` : ''}${r.via_keyword ? ' · matched by keyword' : ''}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>`
      : '';
    $('#ct').innerHTML = `<h3 class="ct-h">Assets</h3>${assets}${entries}`;
  };
  const runSearch = async () => {
    const mine = ++st.searchToken; const q = st.search;
    st.page = 1;
    if (!q) { st.found = null; render(); return; }
    st.found = null; renderFound();
    const u = new URLSearchParams({ q }); if (st.status) u.set('status', st.status);
    try {
      const [entries, assets] = await Promise.all([api('GET', '/api/catalog/search?q=' + encodeURIComponent(q)), api('GET', '/api/assets?' + u)]);
      if (mine !== st.searchToken) return;
      st.found = { ...entries, assets };
    } catch (e) { if (mine !== st.searchToken) return; st.found = { total: 0, results: [], assets: [] }; fail(e); }
    renderFound();
  };
  const render = () => {
    if (st.search) return renderFound();
    const n = byId(st.sel); const ch = n ? kids(n.id) : kids(null);
    // A category with entries below it lists its whole branch right under its cards (owner, 2026-10-27: no extra "All in" click);
    // a subcategory card narrows it. A category with nothing below it lists what is filed in it.
    const inAll = !!n && ch.length > 0;
    const chain = []; for (let x = n; x; x = byId(x.parent_id)) chain.unshift(x);
    const filtered = !!st.status; // a status filter shows the matching assets straight away: no cards, no catalog controls
    const cards = [];
    if (!filtered && n && ch.length) cards.push(cgCard({ attrs: 'data-all', name: `All in ${n.name}`, meta: countText(n.asset_count), kind: `all${inAll ? ' on' : ''}`, chev: false }));
    if (!filtered) for (const c of ch) cards.push(cgCard({ attrs: `data-select="${c.id}"`, name: c.name, meta: `${countText(c.asset_count)}${c.child_count ? ` · ${c.child_count} ${c.child_count === 1 ? 'subcategory' : 'subcategories'}` : ''}`, kind: c.live ? '' : 'off', extra: c.archived_at ? ' <span class="pill plain">Archived</span>' : !c.live ? ' <span class="pill plain">Hidden</span>' : '' }));
    const list = st.assets;
    const direct = list && n ? list.filter((a) => a.catalog_node_id === n.id) : [];
    let below = '';
    if (filtered) {
      below = `<div class="card-head" style="padding:0;margin:0 0 8px"><h3 class="ct-h" style="margin:0">${esc(filteredTitle())} <span class="muted">${list ? list.length : ''}</span></h3>${n ? '' : '<a class="small" href="/api/export/assets.csv">Export CSV</a>'}</div>
        ${n ? `<p class="small muted" style="margin:0 0 8px">Within ${esc(crumbText(n.path))}</p>` : ''}
        ${list === null ? '<div class="spinner"></div>' : list.length ? listCard(list, n) : `<div class="empty">${icon('box')}<p>No ${esc(statusLabel().toLowerCase())} assets${n ? ' here' : ''}.</p></div>`}`;
    } else if (n) {
      const shown = inAll ? list : direct;
      const title = `${inAll ? `All in ${n.name}` : ch.length ? `Filed directly in ${n.name}` : 'Assets'}${st.status ? ` · ${statusLabel()}` : ''}`;
      below = `<h3 class="ct-h">${esc(title)} <span class="muted">${list ? shown.length : ''}</span></h3>${list === null ? '<div class="spinner"></div>' : shown.length
        ? `${inAll ? `<p class="small muted ct-empty" style="margin-top:0">Every asset filed in ${esc(n.name)} or anywhere below it. Pick a card above to narrow it.</p>` : ''}${listCard(shown, n)}`
        : `<p class="muted small ct-empty">${st.status ? `No ${esc(statusLabel().toLowerCase())} assets here.` : inAll ? 'No assets are filed in this branch yet.' : ch.length ? `Nothing is filed directly in ${esc(n.name)}.${list.length ? ` Open <strong>All in ${esc(n.name)}</strong> to see the ${list.length} asset${list.length === 1 ? '' : 's'} in this branch.` : ''}` : 'No assets are filed here yet. Open an asset and choose this entry in its Equipment catalog field.'}</p>`}`;
    } else { // the top: the cards, then every asset in a section that starts collapsed (it is long; the cards are the way in)
      const open = st.listOpen && !!list;
      below = `<div class="card-head acc-head" style="padding:0;margin:24px 0 8px"><button type="button" class="acc-btn" id="allbtn" aria-expanded="${open}" aria-controls="allpanel"><span class="acc-title">All assets <span class="muted">${list ? `(${list.length})` : ''}</span></span>${icon('chev', 'acc-caret')}</button><a class="small" href="/api/export/assets.csv">Export CSV</a></div>
        <div id="allpanel" ${open ? '' : 'hidden'}>${list === null ? '<div class="spinner"></div>' : list.length ? listCard(list, null)
          : `<div class="empty">${icon('box')}<p>No assets yet. Tap <strong>Add</strong>, scan a barcode, or create labels to get started.</p></div>`}</div>`;
    }
    // Structural actions always belong to the REAL entry being viewed (also while its virtual "All in" view is open).
    const controls = n && !filtered ? `<div class="row wrap" style="gap:8px;margin-bottom:12px"><button type="button" class="btn" data-manage="${n.id}">${icon('edit')} Manage</button><button type="button" class="btn primary" data-addsub="${n.id}" ${n.live ? '' : 'disabled'}>${icon('plus')} Add subcategory</button></div>` : '';
    // "Add category" only makes sense at the top; inside a category the contextual button is "+ Add subcategory" above.
    // Back = the app's usual "‹ <where it goes>" link above the title: out of "All in <name>" to the entry, else to the parent (or the root).
    $('#pagetitle').textContent = n ? n.name : 'All assets'; // the title is the real entry being viewed (stored name, no pluralizing)
    const up = n ? byId(n.parent_id) : null;
    $('#backslot').innerHTML = n ? backAnchor(hashFor(up ? up.id : null), up ? up.name : 'All assets') : fromSettings() ? backAnchor('#/settings', 'Settings') : autoBack();
    paintHead({ cat: !n && !filtered, node: n ? n.id : null });
    $('#archrow').classList.toggle('hidden', filtered);
    $('#ct').innerHTML = `${n && !filtered ? cgTop(chain, { allLabel: 'All categories', curAll: false }) : ''}${n && !n.live ? '<p class="small muted">Not visible to employees.</p>' : ''}${controls}
      ${cards.length ? `<div class="cg" role="group" aria-label="Categories">${cards.join('')}</div>` : n || filtered ? '' : `<div class="empty">${icon('tag')}<p>No categories yet. Tap <strong>Add category</strong> to start.</p></div>`}
      ${below}`;
  };
  const loadAssets = async () => {
    const mine = ++st.token; const id = st.sel;
    st.assets = null; render();
    const u = new URLSearchParams(); if (id) u.set('catalog_node', id); if (st.status) u.set('status', st.status);
    try {
      const list = await api('GET', '/api/assets?' + u);
      if (mine !== st.token) return;
      st.assets = id ? list.sort((a, b) => String(a.catalog_path || '').localeCompare(String(b.catalog_path || '')) || a.name.localeCompare(b.name)) : list;
    } catch (e) { if (mine !== st.token) return; st.assets = []; fail(e); }
    render();
  };
  // Read the URL into state; refetch the asset list only when the viewed entry changed.
  const apply = () => {
    if (!st.rows.length && !st.loaded) return;
    const p = qs(); const id = Number(p.get('node')); const prev = st.sel; const prevStatus = st.status;
    st.sel = byId(id) ? id : null;
    st.all = !!st.sel && p.get('all') === '1';
    st.status = STATUS_CHIPS.some(([v]) => v && v === p.get('status')) ? p.get('status') : '';
    paintFilter();
    if ((p.get('node') && !st.sel) || (p.get('status') && !st.status)) history.replaceState(null, '', hashFor(st.sel, st.all)); // unknown/stale node or status: tidy the URL
    if (st.search && st.status !== prevStatus) runSearch();
    if (st.sel !== prev || st.status !== prevStatus) st.page = 1;
    if (st.sel !== prev || st.status !== prevStatus || st.assets === null) loadAssets(); else render();
  };
  const reload = async () => {
    const was = byId(st.sel);
    st.rows = await api('GET', '/api/catalog?include_archived=1'); st.loaded = true;
    if (st.sel && !byId(st.sel)) { // the entry we were in no longer exists (deleted): step up to where it was
      st.sel = null; const up = was && byId(was.parent_id) ? was.parent_id : null;
      history.replaceState(null, '', hashFor(up));
    }
    st.assets = null; apply();
  };
  const nameSheet = ({ title, text, label, value = '', okLabel, onOk }) => {
    const { el, close } = sheet(`<h2>${esc(title)}</h2>${text ? `<p class="muted small" style="margin-top:0">${esc(text)}</p>` : ''}
      <form class="form-grid" id="f"><label class="field"><span>${esc(label)}</span><input name="name" required maxlength="100" value="${esc(value)}" autocomplete="off"></label>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">${esc(okLabel)}</button></div></form>`);
    setTimeout(() => $('input', el).select(), 60);
    $('#f', el).onsubmit = (e) => { e.preventDefault(); busy($('#go', el), async () => { await onOk(new FormData(e.target).get('name')); close(); }); };
  };
  const addBelow = (r) => nameSheet({ title: `Add below ${r.name}`, text: crumbText(r.path), label: 'Name', okLabel: 'Add', onOk: async (name) => { await api('POST', '/api/catalog', { name, parent_id: r.id }); await reload(); toast('Added'); } });
  const manage = (id) => {
    const r = byId(id); if (!r) return;
    const inUse = r.child_count > 0 || r.direct_asset_count > 0 || r.request_count > 0;
    const { el, close } = sheet(`<h2>${esc(r.name)}</h2>
      <div class="ct-path small"><span class="muted">Full path</span><div><strong>${esc(crumbText(r.path))}</strong></div>${r.live ? '' : '<div class="muted">Not visible to employees.</div>'}</div>
      ${r.search_keywords ? `<div class="small" style="margin:6px 0"><span class="muted">Search keywords</span> ${esc(r.search_keywords)}</div>` : ''}
      <div class="muted small" style="margin:6px 0 12px">${r.child_count} below it · ${r.direct_asset_count} asset${r.direct_asset_count === 1 ? '' : 's'} filed directly here · ${r.request_count} request${r.request_count === 1 ? '' : 's'} mention it</div>
      <div class="stack">
        <div style="display:grid;gap:8px;padding-bottom:4px"><button type="button" class="btn lg block" data-act="add" ${r.live ? '' : 'disabled'}>${icon('plus')} Add catalog item under “${esc(r.name)}”</button>
        <p class="small muted" style="margin:0">Creates a category, brand, model, or other grouping — not a physical asset.</p></div>
        <button type="button" class="btn lg block" data-act="rename">${icon('edit')} Rename</button>
        <button type="button" class="btn lg block" data-act="keywords">${icon('search')} ${r.search_keywords ? 'Edit' : 'Add'} search keywords</button>
        <button type="button" class="btn lg block" data-act="move">${icon('out')} Move to a different parent</button>
        ${r.archived_at ? `<button type="button" class="btn lg block" data-act="restore">${icon('in')} Restore</button>` : `<button type="button" class="btn lg block" data-act="archive">${icon('archive')} Archive</button>`}
        ${inUse ? `<p class="small muted" style="margin:0">It can't be deleted while it has entries below it, assets, or requests. Archive it instead.</p>` : `<button type="button" class="btn lg block danger" data-act="delete">${icon('trash')} Delete (nothing uses it)</button>`}
      </div>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`);
    const act = {
      add: () => { close(); addBelow(r); },
      keywords: () => {
        close();
        const { el: k, close: closeK } = sheet(`<h2>Search keywords</h2><p class="muted small" style="margin-top:0">${esc(crumbText(r.path))}. Extra words that should find this entry and everything filed below it, separated by commas, for example <em>camera, photography, video</em>. They only help search; they are not shown to employees.</p>
          <form class="form-grid" id="f"><label class="field"><span>Keywords</span><textarea name="kw" rows="3" maxlength="600" placeholder="camera, photography, video">${esc(r.search_keywords || '')}</textarea></label>
          <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Save</button></div></form>`);
        $('#f', k).onsubmit = (e) => { e.preventDefault(); busy($('#go', k), async () => { await api('PUT', `/api/catalog/${r.id}`, { search_keywords: new FormData(e.target).get('kw') }); closeK(); await reload(); toast('Search keywords saved'); }); };
      },
      rename: () => { close(); nameSheet({ title: 'Rename', text: 'Past requests keep the wording they were made with.', label: 'Name', value: r.name, okLabel: 'Save', onOk: async (name) => { await api('PUT', `/api/catalog/${r.id}`, { name }); await reload(); toast('Renamed'); } }); },
      move: () => {
        close();
        const bad = new Set([r.id]); let grew = true;
        while (grew) { grew = false; for (const x of st.rows) if (!bad.has(x.id) && bad.has(x.parent_id)) { bad.add(x.id); grew = true; } }
        const opts = st.rows.filter((x) => x.live && !bad.has(x.id));
        const { el: m, close: closeM } = sheet(`<h2>Move “${esc(r.name)}”</h2><p class="muted small" style="margin-top:0">Everything below it moves too. Pick the new parent.</p>
          <form class="form-grid" id="f"><label class="field"><span>New parent</span><select name="parent_id"><option value="">(top level — a category)</option>${opts.map((x) => `<option value="${x.id}" ${x.id === r.parent_id ? 'selected' : ''}>${esc(crumbText(x.path))}</option>`).join('')}</select></label>
          <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Move</button></div></form>`);
        $('#f', m).onsubmit = (e) => { e.preventDefault(); busy($('#go', m), async () => { await api('PUT', `/api/catalog/${r.id}`, { parent_id: new FormData(e.target).get('parent_id') || null }); closeM(); await reload(); toast('Moved'); }); };
      },
      archive: async () => { if (await confirmSheet(`Archive “${r.name}”?`, `It and everything below it will stop appearing for employees. Assets and past requests keep their history. You can restore it later.`, 'Archive')) { close(); await api('POST', `/api/catalog/${r.id}/archive`, {}); await reload(); toast('Archived'); } },
      restore: async () => { await api('POST', `/api/catalog/${r.id}/restore`, {}); close(); await reload(); toast('Restored'); },
      delete: async () => { if (await confirmSheet(`Delete “${r.name}”?`, 'Nothing uses it, so it can be removed completely. This cannot be undone.', 'Delete', true)) { close(); await api('DELETE', `/api/catalog/${r.id}`); await reload(); toast('Deleted'); } },
    };
    el.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) Promise.resolve(act[b.dataset.act]()).catch(fail); };
  };
  const addRoot = () => nameSheet({ title: 'Add a category', text: 'A broad top-level group, like Laptop, Camera or Audio.', label: 'Category name', okLabel: 'Add', onOk: async (name) => { await api('POST', '/api/catalog', { name }); await reload(); toast('Added'); } });
  $('#showarch').onchange = (e) => { st.archived = e.target.checked; render(); };
  $('#cq').oninput = debounce((e) => { st.search = e.target.value.trim(); runSearch(); });
  // Cards and breadcrumbs only navigate. Management is reached only through the explicit buttons.
  $('#ct').onclick = (e) => {
    const hit = e.target.closest('[data-found]');
    if (hit) { e.preventDefault(); st.search = ''; st.found = null; $('#cq').value = ''; go(hashFor(Number(hit.dataset.found))); window.scrollTo(0, 0); return; } // a search result opens that entry (the grid comes back)
    const acc = e.target.closest('#allbtn');
    if (acc) { st.listOpen = acc.getAttribute('aria-expanded') !== 'true'; acc.setAttribute('aria-expanded', String(st.listOpen)); $('#allpanel').hidden = !st.listOpen; return; } // no re-render, no reload
    const m = e.target.closest('[data-manage]'); if (m) return manage(Number(m.dataset.manage));
    const add = e.target.closest('[data-addsub]'); if (add) return addBelow(byId(Number(add.dataset.addsub)));
    const to = (h) => { go(h); window.scrollTo(0, 0); };
    const pg = e.target.closest('[data-page]');
    if (pg) { // the next page starts at the top of the list (below the sticky top bar)
      st.page = Number(pg.dataset.page); render();
      const card = $('#ct .pager')?.previousElementSibling;
      if (card) window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 120 });
      return;
    }
    if (e.target.closest('[data-all]')) return to(hashFor(st.sel)); // (the branch is already listed; the card marks it)
    const sel = e.target.closest('[data-select]'); if (sel) return to(hashFor(Number(sel.dataset.select)));
    const crumb = e.target.closest('[data-crumb]'); if (crumb) { const id = Number(crumb.dataset.crumb); return to(hashFor(id > 0 ? id : null)); }
  };
  $('#backslot').onclick = () => window.scrollTo(0, 0); // (the link itself navigates one step up)
  $('#fchips').onclick = (e) => { if (e.target.closest('#fclear')) gotoStatus(''); };
  if ($('#scanbtn')) $('#scanbtn').onclick = () => openScanner({ onResult: handleScannedCode });
  S.soft = { base: '#/assets', fn: apply };
  await reload();
  if (st.search) runSearch(); // #/assets?q=… (an old All assets link)
}

// ============================================================ profile
// The Profile tab: the signed-in person's own destinations (the personal half of the old "More"). Administration lives in the admin hamburger.
function viewAccount() {
  if (window.matchMedia('(min-width: 900px)').matches) return go('#/profile'); // the desktop sidebar already lists these
  const items = isAdmin() ? [
    ['#/profile', 'user', 'My profile', 'Your details and password'],
    ['#/settings', 'settings', 'Settings', 'Categories, locations, email and check-out rules'],
  ] : [
    ['#/equipment', 'laptop', 'My equipment', 'What is assigned or checked out to you'],
    ['#/history', 'history', 'History', 'Equipment you have had before'],
    ['#/profile', 'user', 'My profile', 'Your details and password'],
  ];
  main().innerHTML = `<div class="page-head"><h1>Profile</h1></div>
    <div class="card"><ul class="list">${items.map(([h, i, t, sub]) => `<li><a class="item" href="${h}"><div class="thumb">${icon(i)}</div><div class="grow"><div class="title">${t}</div><div class="sub">${sub}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>
    <div class="card pad" style="margin-top:16px"><div class="field"><span>Appearance</span>
      <div class="seg seg-full" id="themeseg" role="radiogroup" aria-label="Appearance">${THEMES.map(([v, l]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === getTheme()}" class="${v === getTheme() ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="small muted">System follows your device’s light or dark setting.</span></div></div>
    <button class="btn block lg" style="margin-top:16px" id="out">${icon('logout')} Sign out</button>`;
  $('#themeseg').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; setTheme(b.dataset.v); $$('#themeseg button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); };
  $('#out').onclick = logout;
}
async function logout() { await api('POST', '/api/logout', {}).catch(() => {}); S.me = null; S.shell = false; usersCache = null; go('#/login'); }
// My equipment: the signed-in employee's CURRENT assignments, split by kind. Same data as Home's "My equipment" card
// (GET /api/dashboard -> mine: only this employee's open assignments); no separate model or logic. Each row opens the
// asset through the normal employee-authorized detail flow (they hold it, so it is always allowed).
async function viewEquipment() {
  const d = await api('GET', '/api/dashboard');
  const perm = d.mine.filter((m) => m.assignment_type !== 'checkout');
  const temp = d.mine.filter((m) => m.assignment_type === 'checkout');
  const flag = (m) => (m.return_status === 'open' ? pill('open', 'Return requested') : m.return_status === 'dropped_off' ? pill('dropped_off', 'Dropped off') : isOverdue(m.due_date) ? pill('overdue', 'Overdue') : '');
  const detail = (m) => [m.category, [m.brand, m.model].filter(Boolean).join(' '), m.location].filter((v) => v && v !== m.asset_name).map(esc).join(' · ');
  const row = (m, sub, tail) => `<li><a class="item" href="#/asset/${m.asset_id}${srcQ('equipment')}">${thumbHtml(m.thumb, m.category)}
    <div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub truncate"><span class="mono">${esc(m.tag)}</span>${detail(m) ? ' · ' + detail(m) : ''}</div>
      <div class="sub">${sub}</div></div>${tail}${icon('chev', 'chev')}</a>${holdingActions(m)}</li>`;
  const group = (title, rows, empty, iconName) => `<div class="card"><div class="card-head"><h2>${title}</h2><span class="muted small">${rows.length} item${rows.length === 1 ? '' : 's'}</span></div>
    ${rows.length ? `<ul class="list">${rows.join('')}</ul>` : `<div class="empty">${icon(iconName)}<p>${empty}</p></div>`}</div>`;
  main().innerHTML = `<div class="page-head"><h1>My equipment</h1></div><div class="stack">${returnBanners(d.mine, 'equipment')}
    ${group('Permanent assignments', perm.map((m) => row(m, `Assigned since ${esc(fmtStamp(m.checked_out_at))}`, flag(m) || pill('checked_out', 'Assigned'))), 'No equipment is permanently assigned to you.', 'laptop')}
    ${group('Temporary checkouts', temp.map((m) => row(m, `Checked out ${esc(fmtStamp(m.checked_out_at))} · return by ${esc(fmtDate(m.due_date))}${m.due_time ? ' ' + esc(fmtClock(m.due_time)) : ''}`, flag(m))), 'You have nothing checked out temporarily.', 'out')}
    <p class="small muted" style="text-align:center">Looking for something else? <a href="#/assets">Browse equipment</a> · <a href="#/history">History</a></p></div>`;
  wireDropoffs(main());
  wireHoldingActions(main());
}

// Employee History: the signed-in employee's own assignments, newest first, from the same record the admin person page
// uses (GET /api/users/:id answers only for yourself when you aren't an admin). Read-only; past rows aren't links
// because an employee may only open equipment they hold or that is available.
async function viewHistory() {
  const head = `<div class="page-head"><h1>History</h1></div>`;
  if (!S.me.employee_id) { main().innerHTML = `${head}<div class="card"><div class="empty">${icon('history')}<p>Your login isn't linked to an employee record, so there is no equipment history. Ask IT.</p></div></div>`; return; }
  const d = await api('GET', '/api/users/' + S.me.employee_id);
  const rows = [...d.current.map((m) => ({ ...m, now: true })), ...d.past]
    .sort((a, b) => (b.checked_out_at || '').localeCompare(a.checked_out_at || '') || b.id - a.id);
  const item = (m) => {
    const body = `${m.now ? thumbHtml(m.thumb, m.category) : `<div class="thumb">${icon('box')}</div>`}
      <div class="grow"><div class="title truncate">${esc(m.asset_name)}</div>
        <div class="sub"><span class="mono">${esc(m.tag)}</span> · ${typeText(m)}</div>
        <div class="sub">Since ${esc(fmtStamp(m.checked_out_at))}${m.now ? '' : ` · Returned ${esc(fmtStamp(m.returned_at))}`}</div></div>
      ${m.now ? (isOverdue(m.due_date) ? pill('overdue', 'Overdue') : pill('checked_out', 'Current')) : ''}${m.now ? icon('chev', 'chev') : ''}`;
    return m.now ? `<li><a class="item" href="#/asset/${m.asset_id}${srcQ('history')}">${body}</a></li>` : `<li><div class="item">${body}</div></li>`;
  };
  main().innerHTML = `${head}<div class="stack"><div class="card">${rows.length
    ? `<ul class="list">${rows.map(item).join('')}</ul>`
    : `<div class="empty">${icon('history')}<p>No equipment history yet.</p></div>`}</div>
    ${d.past.length >= d.history_limit ? `<p class="small muted" style="text-align:center">Showing your ${d.history_limit} most recent returned items.</p>` : ''}</div>`;
}

function viewProfile() {
  const u = S.me;
  const who = `<div class="row"><div class="avatar" style="width:52px;height:52px;font-size:18px;background:var(--brand-accent)">${esc(initials(u.name))}</div><div><strong>${esc(u.email)}</strong><div class="small muted">${u.role === 'admin' ? 'Administrator' : 'Employee'}</div></div></div>`;
  // Everyone edits their own name, department, job title, phone and building (PUT /api/me); the email is IT's (People).
  const details = `<form class="card pad form-grid" id="p">${who}
      <div class="form-grid cols"><label class="field"><span>First name</span><input name="first_name" value="${esc(u.first_name || '')}" ${u.first_name ? 'required' : ''} autocomplete="given-name"></label><label class="field"><span>Last name</span><input name="last_name" value="${esc(u.last_name || '')}" ${u.last_name ? 'required' : ''} autocomplete="family-name"></label></div>
      ${u.first_name ? '' : `<div class="small muted" style="margin-top:-6px">Name on file: ${esc(u.name)}. Enter your first and last name to replace it.</div>`}
      <div class="form-grid cols"><label class="field"><span>Department</span><input name="department" value="${esc(u.department || '')}"></label><label class="field"><span>Job title</span><input name="title" value="${esc(u.title || '')}"></label></div>
      <label class="field"><span>Phone</span><input name="phone" type="tel" value="${esc(u.phone || '')}"></label>
      <label class="field"><span>Building <span class="muted">(optional)</span></span><input name="building" value="${esc(u.building || '')}" autocomplete="off"></label>
      <div class="small muted">Your email can only be changed by IT.</div>
      <button class="btn primary" id="ps">Save</button></form>`;
  main().innerHTML = `<div class="page-head"><h1>My profile</h1></div><div class="stack">
    ${details}
    <form class="card pad form-grid" id="pw"><h2>${u.has_password ? 'Change password' : 'Set a password'}</h2>
      ${u.has_password ? '' : '<div class="small muted">Optional: you sign in with Google. A password also lets you sign in with your email.</div>'}
      ${u.has_password ? '<label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>' : ''}
      <label class="field"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn" id="pws">Update password</button></form>
    <button class="btn block lg" id="out">${icon('logout')} Sign out</button></div>`;
  $('#p').onsubmit = (e) => { e.preventDefault(); busy($('#ps'), async () => { await api('PUT', '/api/me', Object.fromEntries(new FormData(e.target))); await loadMe(); mountShell(); setActive('profile'); toast('Saved'); route(true); }); };
  $('#pw').onsubmit = (e) => { e.preventDefault(); busy($('#pws'), async () => { await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast(u.has_password ? 'Password updated' : 'Password set'); await loadMe(); route(true); }); };
  $('#out').onclick = logout;
}

// ============================================================ boot
window.addEventListener('unhandledrejection', (e) => { if (/play\(\) request was interrupted/.test(e.reason && e.reason.message)) e.preventDefault(); });
// The service worker (installability + offline shell) is for deployed use. On a developer machine it is never registered, and one that
// an earlier build installed is removed together with its caches, so the page can only ever show the code the server is serving now.
if ('serviceWorker' in navigator && window.isSecureContext) {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => window.caches && caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))).catch(() => {});
  } else navigator.serviceWorker.register('/sw.js').catch(() => {});
}
setInterval(() => { if (S.me && document.visibilityState === 'visible') refreshBadge(); }, 60e3);
route();
