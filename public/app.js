/* Nutricost IT Assets — front-end (vanilla JS, no build step) */
'use strict';

// ============================================================ utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, settings: null, mailConfigured: false, shell: false };
const isAdmin = () => S.me && S.me.role === 'admin';
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
  out: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 7l5 5-5 5M14 12H3"/>',
  in: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 17l-5-5 5-5M10 12h11"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
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
const LIFE_LABEL = { submitted: 'Submitted', in_review: 'In review', approved: 'Approved', dropped_off: 'Dropped off', fulfilled: 'Fulfilled', resolved: 'Resolved', denied: 'Declined', rescinded: 'Rescinded', withdrawn: 'Withdrawn', cancelled: 'Cancelled', dismissed: 'Dismissed' };
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
function sheet(html, { onOpen, wide } = {}) {
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" ${wide ? 'style="max-width:720px"' : ''}><div class="grab"></div>${html}</div>`;
  root.appendChild(wrap);
  const close = () => { wrap.remove(); document.body.style.overflow = ''; };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.body.style.overflow = 'hidden';
  const el = $('.sheet', wrap);
  onOpen && onOpen(el, close);
  const first = $('input:not([type=hidden]):not([type=checkbox]), select, textarea', el);
  if (first && window.matchMedia('(min-width: 700px)').matches) setTimeout(() => first.focus(), 50);
  return { el, close };
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
function openScanner({ title = 'Scan a barcode', hint = 'Point the camera at the barcode or QR code', onResult }) {
  const wrap = document.createElement('div');
  wrap.className = 'scanner';
  wrap.innerHTML = `
    <div class="sc-top"><button class="iconbtn" id="sc-close" aria-label="Close">${icon('x')}</button>
      <strong>${esc(title)}</strong><button class="iconbtn" id="sc-torch" aria-label="Flashlight" style="visibility:hidden">${icon('flash')}</button></div>
    <div class="sc-view"><div id="qr-reader"></div><div class="frame"><div class="laser"></div></div><div class="sc-hint">${esc(hint)}</div></div>
    <div class="sc-bottom"><form class="input-group" id="sc-form"><input id="sc-manual" placeholder="Or type the tag / serial number" autocomplete="off" autocapitalize="characters" enterkeyhint="go"><button class="btn primary">Go</button></form></div>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  let scanner = null; let done = false;
  const finish = async (code) => {
    if (done) return; done = true;
    try { navigator.vibrate && navigator.vibrate(60); } catch { /* */ }
    await stop();
    onResult(String(code).trim());
  };
  let starting = Promise.resolve();
  const stop = async () => {
    wrap.style.display = 'none'; document.body.style.overflow = '';
    await starting.catch(() => {});
    try { if (scanner && scanner.isScanning) await scanner.stop(); } catch { /* */ }
    try { scanner && scanner.clear(); } catch { /* */ }
    wrap.remove(); document.body.style.overflow = '';
  };
  $('#sc-close', wrap).onclick = () => { done = true; stop(); };
  $('#sc-form', wrap).onsubmit = (e) => { e.preventDefault(); const v = $('#sc-manual', wrap).value.trim(); if (v) finish(v); };
  const showErr = (msg) => { $('.sc-view', wrap).innerHTML = `<div class="sc-err"><div>${icon('camera')}<p style="margin-top:10px">${msg}</p><p class="small" style="opacity:.7">You can still type the tag below, or use a USB/Bluetooth barcode scanner.</p></div></div>`; setTimeout(() => $('#sc-manual', wrap)?.focus(), 50); };
  if (!window.isSecureContext) return showErr('The camera needs a secure (https://) connection.'), { close: stop };
  if (!window.Html5Qrcode) return showErr('Scanner is still loading — try again in a second.'), { close: stop };
  const F = window.Html5QrcodeSupportedFormats;
  const formats = [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX].filter((x) => x !== undefined);
  try {
    scanner = new window.Html5Qrcode('qr-reader', { formatsToSupport: formats, verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  } catch (e) { return showErr('Could not start the scanner.'), { close: stop }; }
  starting = scanner.start({ facingMode: 'environment' }, {
    fps: 12,
    qrbox: (w, h) => ({ width: Math.max(60, Math.floor(Math.min(w * 0.82, 380))), height: Math.max(60, Math.floor(Math.min(w * 0.46, 210, h * 0.5))) }),
    aspectRatio: window.innerHeight / window.innerWidth,
    videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
  }, (text) => finish(text), () => {});
  starting.then(() => {
    try {
      const caps = scanner.getRunningTrackCapabilities && scanner.getRunningTrackCapabilities();
      if (caps && caps.torch) {
        const b = $('#sc-torch', wrap); b.style.visibility = 'visible'; let on = false;
        b.onclick = () => { on = !on; scanner.applyVideoConstraints({ advanced: [{ torch: on }] }).catch(() => {}); };
      }
    } catch { /* */ }
  }).catch((err) => {
    const m = String(err && (err.message || err));
    showErr(/NotAllowed|Permission/i.test(m) ? 'Camera access was blocked. Allow camera access for this site in your browser settings.' : /NotFound|Requested device not found/i.test(m) ? 'No camera was found on this device.' : 'Could not open the camera.');
  });
  return { close: stop };
}

async function handleScannedCode(code, ctx = '') { // ctx: where the asset page should say it came from (the Scan page passes srcQ('scan'))
  try {
    const r = await api('GET', '/api/assets/lookup/' + encodeURIComponent(code));
    if (r.found) return go('#/asset/' + r.id + ctx);
    if (r.unavailable) return toast("That item isn't available right now. You can request something similar from IT.", true);
    if (isAdmin()) {
      const { el, close } = sheet(`<h2>New barcode</h2><p class="muted">No asset uses <strong class="mono">${esc(code)}</strong> yet. Want to tag a new asset with it?</p>
        <div class="stack" style="margin-top:16px"><button class="btn primary lg block" id="mk">${icon('plus')} Add a new asset with this tag</button>
        <button class="btn block" id="again">${icon('scan')} Scan again</button></div>`);
      $('#mk', el).onclick = () => { close(); go('#/new?tag=' + encodeURIComponent(code)); };
      $('#again', el).onclick = () => { close(); openScanner({ onResult: (c) => handleScannedCode(c, ctx) }); };
    } else toast(`No asset found for ${code}`, true);
  } catch (e) { fail(e); }
}

// ============================================================ shell / navigation
function navItems() {
  const req = S.badge || 0;
  const common = [
    { key: 'home', href: '#/home', label: 'Home', icon: 'home' },
    { key: 'assets', href: '#/assets', label: isAdmin() ? 'Assets' : 'Browse', icon: 'box' },
    { key: 'scan', href: '#/scan', label: 'Scan', icon: 'scan', scan: true },
    { key: 'requests', href: '#/requests', label: 'Requests', icon: 'inbox', badge: req },
    { key: 'account', href: '#/account', label: 'Profile', icon: 'user' }, // the signed-in person (My equipment / History / My profile / Sign out)
  ];
  const side = [
    { key: 'home', href: '#/home', label: 'Home', icon: 'home' },
    ...(isAdmin() ? [] : [{ key: 'equipment', href: '#/equipment', label: 'My equipment', icon: 'laptop' }]),
    { key: 'assets', href: '#/assets', label: isAdmin() ? 'All assets' : 'Browse equipment', icon: 'box' },
    { key: 'scan', href: '#/scan', label: 'Scan', icon: 'scan' },
    { key: 'requests', href: '#/requests', label: 'Requests', icon: 'inbox', badge: req },
    ...(isAdmin() ? [] : [{ key: 'history', href: '#/history', label: 'History', icon: 'history' }]),
  ];
  if (isAdmin()) side.push({ sep: true },
    { key: 'people', href: '#/people', label: 'People', icon: 'users' },
    { key: 'catalog', href: '#/catalog', label: 'Equipment catalog', icon: 'tag' },
    { key: 'calendar', href: '#/calendar', label: 'Calendar', icon: 'calendar' },
    { key: 'labels', href: '#/labels', label: 'Print labels', icon: 'printer' },
    { key: 'import', href: '#/import', label: 'Import / export', icon: 'upload' },
    { key: 'activity', href: '#/activity', label: 'Activity log', icon: 'history' },
    { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings' });
  side.push({ sep: true }, { key: 'profile', href: '#/profile', label: 'My profile', icon: 'user' });
  return { tabs: common, side };
}
// Mobile hamburger (admins only) = administering the system. The signed-in person's own destinations live under the Profile tab.
const adminMenuItems = () => [
  { key: 'people', href: '#/people', label: 'People', icon: 'users' },
  { key: 'catalog', href: '#/catalog', label: 'Equipment catalog', icon: 'tag' },
  { key: 'calendar', href: '#/calendar', label: 'Calendar', icon: 'calendar' },
  { key: 'labels', href: '#/labels', label: 'Print labels', icon: 'printer' },
  { key: 'import', href: '#/import', label: 'Import / export', icon: 'upload' },
  { key: 'activity', href: '#/activity', label: 'Activity log', icon: 'history' },
  { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings' },
];
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
  $('#app').innerHTML = `
    <header class="topbar">
      ${isAdmin() ? `<button type="button" class="iconbtn nav-toggle" id="nav-toggle" aria-label="Open administration menu" aria-haspopup="dialog">${icon('menu')}</button>` : ''}
      <a href="#/home" class="row" style="gap:10px"><img src="/logo-white.svg" alt="Nutricost" class="logo"><span class="app-name">IT Assets</span></a>
      <span class="spacer"></span>
      <a href="#/scan" class="iconbtn desk-only" title="Scan">${icon('scan')}</a>
      <div class="menu-wrap"><button type="button" class="avatar sm" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(S.me.name)}" style="background:var(--brand-accent);border:0;cursor:pointer">${esc(initials(S.me.name))}</button>
        <div class="menu" id="avatar-menu" role="menu" hidden><div class="menu-who"><strong>${esc(S.me.name)}</strong><div class="small muted">${esc(S.me.email || '')}</div></div>
          <a href="#/profile" role="menuitem">${icon('user')} My profile</a><button type="button" role="menuitem" id="signout">${icon('logout')} Sign out</button></div></div>
    </header>
    <div class="shell">
      <nav class="sidebar">${side.map((i) => i.sep ? '<div class="sep"></div>' : `<a href="${i.href}" data-key="${i.key}"${i.key === 'calendar' ? ' data-cal' : ''}>${icon(i.icon)}<span>${i.label}</span>${i.badge ? `<span class="count">${i.badge}</span>` : ''}</a>`).join('')}</nav>
      <main id="main"></main>
    </div>
    <nav class="tabbar">${tabs.map((t) => `<a href="${t.href}" data-key="${t.key}" class="${t.scan ? 'scan-tab' : ''}">${t.scan ? `<span class="scan-bubble">${icon('scan')}</span>` : icon(t.icon)}<span>${t.label}</span>${t.badge ? `<span class="badge-dot">${t.badge}</span>` : ''}</a>`).join('')}</nav>`;
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
  const tabKey = ACCOUNT_KEYS.includes(key) ? 'account' : key; // the Profile tab covers the person's own pages
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.key === tabKey));
  $$('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
}
async function refreshBadge() {
  try {
    const rows = await api('GET', '/api/requests?status=open');
    // For an employee the badge means "IT is waiting on you": a return IT asked for, not one they started themselves.
    let n = isAdmin() ? rows.filter((r) => r.status === 'open' || r.status === 'dropped_off').length : rows.filter((r) => r.type === 'return' && r.status === 'open' && !r.self_initiated).length;
    // IT: reservations waiting for approval + everyone currently on a waitlist. Employee: offers waiting for their answer. Active items only, never history.
    try { n += (await api('GET', '/api/reservation-counts')).attention; } catch { /* the badge is best-effort */ }
    S.badge = n;
    const tab = $('.tabbar a[data-key=requests]');
    if (tab) { $('.badge-dot', tab)?.remove(); if (n) tab.insertAdjacentHTML('beforeend', `<span class="badge-dot">${n}</span>`); }
    const side = $('.sidebar a[data-key=requests]');
    if (side) { $('.count', side)?.remove(); if (n) side.insertAdjacentHTML('beforeend', `<span class="count">${n}</span>`); }
  } catch { /* */ }
}
const main = () => $('#main');
const loading = () => { main().innerHTML = '<div class="spinner"></div>'; };
const backLink = (href, label = 'Back', exact = false) => `<a class="back" href="${href}"${exact ? '' : ' onclick="if(history.length>1){history.back();return false}"'}>${icon('back')}${esc(label)}</a>`;

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
  return { src, node: num('node'), id: num('id'), all: p.get('all') === '1', tab: ['open', 'closed'].includes(p.get('tab')) ? p.get('tab') : null, fromSettings: src === 'catalog' && p.get('from') === '#/settings' };
}
const ctxQuery = () => { const c = assetCtx(); return c ? srcQ(c.src, { node: c.node, id: c.id, all: c.all, tab: c.tab, from: c.fromSettings ? '#/settings' : null }) : ''; }; // carried on to the edit form and back
async function assetBackTarget() {
  const c = assetCtx();
  const fallback = { href: '#/assets', label: isAdmin() ? 'Assets' : 'Browse equipment', exact: false }; // existing behavior when there is no (valid) source
  if (!c) return fallback;
  // From the availability calendar: back to the same calendar (non-exact = browser Back, which also restores its month and day).
  if (c.src === 'calendar') return { href: `#/calendar${c.node ? '?node=' + c.node : ''}`, label: 'Calendar', exact: false };
  const fixed = { assets: ['#/assets', 'Assets'], equipment: ['#/equipment', 'My equipment'], history: ['#/history', 'History'], home: ['#/home', 'Home'], scan: ['#/scan', 'Scan'], activity: ['#/activity', 'Activity log'] };
  if (fixed[c.src]) return { href: fixed[c.src][0], label: fixed[c.src][1], exact: true };
  if (c.src === 'requests') return { href: `#/requests${c.tab ? '?tab=' + c.tab : ''}`, label: 'Requests', exact: true };
  if (c.src === 'person') { // an admin's employee page: back to that person, labelled with their real name
    if (!c.id) return { href: '#/people', label: 'People', exact: true };
    try { const u = (await api('GET', '/api/users/' + c.id)).user; return { href: `#/person/${c.id}`, label: u.name, exact: true }; } catch { return { href: '#/people', label: 'People', exact: true }; }
  }
  // catalog (admin) / browse (employee): back to the exact node, labelled with that node's real name
  const catFrom = (href) => (c.fromSettings ? `${href}${href.includes('?') ? '&' : '?'}from=${encodeURIComponent('#/settings')}` : href); // the catalog keeps its Settings source
  const root = c.src === 'catalog' ? { href: catFrom('#/catalog'), label: 'Equipment catalog' } : { href: c.all ? '#/assets?all=1' : '#/assets', label: c.all ? 'All equipment' : 'Browse equipment' };
  if (!c.node) return { ...root, exact: true };
  let rows = []; try { rows = await api('GET', '/api/catalog' + (c.src === 'catalog' ? '?include_archived=1' : '')); } catch { /* fall back to the root */ }
  const n = rows.find((r) => r.id === c.node);
  if (!n) return { ...root, exact: true };
  // Opened from a virtual "All in <name>" view (admin catalog &all=1; employee Browse, where an entry with children always shows its
  // whole branch): say so. The URL is the same real-entry route — "All in" is never a stored entry.
  const virtual = c.src === 'catalog' ? c.all : n.child_count > 0;
  return { href: c.src === 'catalog' ? catFrom(`#/catalog?node=${n.id}${c.all ? '&all=1' : ''}`) : `#/assets?node=${n.id}`, label: virtual ? `All in ${n.name}` : n.name, exact: true };
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
  [/^#\/scan$/, viewScan, { key: 'scan' }],
  [/^#\/requests$/, viewRequests, { key: 'requests' }],
  [/^#\/calendar$/, viewCalendar, { key: 'calendar' }],
  [/^#\/people$/, viewPeople, { key: 'people', admin: true }],
  [/^#\/person\/(\d+)$/, viewPerson, { key: 'people', admin: true }],
  [/^#\/labels$/, viewLabels, { key: 'labels', admin: true }],
  [/^#\/catalog$/, viewCatalog, { key: 'catalog', admin: true }],
  [/^#\/import$/, viewImport, { key: 'import', admin: true }],
  [/^#\/activity$/, viewActivity, { key: 'activity', admin: true }],
  [/^#\/settings$/, viewSettings, { key: 'settings', admin: true }],
  [/^#\/equipment$/, viewEquipment, { key: 'equipment', employee: true }],
  [/^#\/history$/, viewHistory, { key: 'history' }],
  [/^#\/profile$/, viewProfile, { key: 'profile' }],
  [/^#\/account$/, viewAccount, { key: 'account' }],
  [/^#\/more$/, () => go('#/account'), { key: 'account' }], // the old bottom-nav "More" page: bookmarks land on the Profile tab, which replaced its personal half
];
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
    if (!S.shell) { mountShell(); refreshBadge(); }
    setActive(opt.key);
    if (!silent) { window.scrollTo(0, 0); loading(); }
  } else S.shell = false;
  S.silent = !!silent;
  $('#sheet-root').innerHTML = ''; document.body.style.overflow = '';
  try { await view(...params); } catch (e) { if (main()) main().innerHTML = `<div class="empty">${icon('alert')}<p>${esc(e.message)}</p></div>`; else fail(e); }
}
async function loadMe() {
  const r = await api('GET', '/api/me');
  S.me = r.user; S.settings = r.settings; S.mailConfigured = r.mailConfigured;
}
// Route-backed drill-down screens (Browse equipment, Equipment catalog) keep their state in the hash query (#/catalog?node=12).
// A change that stays on the same screen is applied in place — no reload, no flicker — by the screen's own `S.soft.fn`; anything
// else goes through the normal router. Because the URL is the single source of truth, the sidebar link, breadcrumbs, the Back
// button, browser Back/Forward and a refresh all land on the same state, and nothing stale can survive.
window.addEventListener('hashchange', () => {
  const base = (location.hash || '').split('?')[0];
  if (S.soft && S.soft.base === base && $('#main')) { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; return S.soft.fn(); }
  route();
});

// ============================================================ auth views
function authPanel(inner) {
  $('#app').innerHTML = `<div class="auth"><div class="panel"><div class="brand"><img src="/logo.svg" alt="Nutricost"><div>IT Asset Tracker</div></div>${inner}</div></div>`;
}
async function viewLogin() {
  try { const s = await api('GET', '/api/setup-needed'); if (s.needed) return go('#/setup'); } catch { /* */ }
  authPanel(`<form class="form-grid" id="f">
    <label class="field"><span>Work email</span><input name="email" type="email" autocomplete="username" required placeholder="you@nutricost.com"></label>
    <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary lg block">Sign in</button>
    <a href="#/forgot" class="small" style="text-align:center">Forgot your password?</a></form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    busy($('button', e.target), async () => { await api('POST', '/api/login', fd); S.me = null; go('#/home'); });
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
  authPanel(`<form class="form-grid" id="f"><div><h2>Welcome! Let's get set up.</h2><p class="muted small" style="margin:6px 0 0">Create the first administrator account. You can invite everyone else afterwards.</p></div>
    <label class="field"><span>Your name</span><input name="name" required autocomplete="name"></label>
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
      <div class="actions"><a href="#/scan" class="btn primary lg">${icon('scan')} Scan</a><button class="btn lg" id="req">${icon('plus')} Request</button></div>
      <div class="card"><div class="card-head"><h2>My equipment</h2><span class="muted small">${d.mine.length} item${d.mine.length === 1 ? '' : 's'} · <a href="#/equipment">See all</a></span></div>${myEquipmentList(d.mine)}</div>
      ${d.myRequests.length ? `<div class="card"><div class="card-head"><h2>My requests</h2><a href="#/requests" class="small">See all</a></div><ul class="list">${d.myRequests.map((r) => `<li><div class="item"><div class="thumb">${icon('box')}</div><div class="grow"><div class="title">${esc(r.catalog_path ? crumbText(r.catalog_path) : (r.category || 'Equipment'))}${isPermReq(r) ? ' · Permanent assignment' : ''}</div><div class="sub truncate">${r.catalog_path ? (r.asset_id ? 'Specific: ' + esc(r.asset_label || '') : 'Any matching') + ' · ' : ''}${esc(r.message || '')} · ${fmtWhen(r.created_at)}</div></div>${reqPill(r)}</div></li>`).join('')}</ul></div>` : ''}
      </div>`;
    $('#req').onclick = () => requestEquipmentSheet();
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
  const p = qs();
  if (!isAdmin()) return viewBrowse(); // employees get the catalog card-grid browser
  const roots = await rootNames();
  const state = { q: p.get('q') || '', status: p.get('status') || '', category: p.get('category') || '' };
  const statuses = isAdmin()
    ? [['', 'All'], ['available', 'Available'], ['checked_out', 'Checked out'], ['overdue', 'Overdue'], ['maintenance', 'In repair'], ['lost', 'Lost'], ['retired', 'Retired'], ['disposed', 'Disposed']]
    : null; // employees have no status filters: Browse is simply the equipment they can get (their own is under My equipment)
  main().innerHTML = `<div class="page-head"><h1>${isAdmin() ? 'Assets' : 'Browse equipment'}</h1>${isAdmin() ? `<a href="#/new" class="btn primary desk-only">${icon('plus')} Add asset</a>${calendarLink()}` : ''}</div>
    <div class="stack">
      <div class="row"><div class="search grow">${icon('search')}<input id="q" type="search" placeholder="${isAdmin() ? 'Search name, brand, category, tag, serial, person…' : 'Search name, brand, category, tag, serial…'}" value="${esc(state.q)}" enterkeyhint="search"></div>
        <button class="btn" id="scanbtn" title="Scan">${icon('scan')}</button></div>
      ${statuses ? `<div class="row" style="gap:8px"><div class="chips grow" id="chips">${statuses.map(([v, l]) => `<button class="chip ${state.status === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>` : '<p class="small muted" style="margin:0">Equipment that is available to check out or request.</p>'}
      <select id="cat"><option value="">All categories</option>${roots.map((c) => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <div class="card" id="results"><div class="spinner"></div></div>
    </div>
    ${isAdmin() ? `<a href="#/new" class="btn primary lg fab">${icon('plus')} Add</a>` : ''}`;
  if (!isAdmin()) main().insertAdjacentHTML('beforeend', `<p class="small muted" style="margin-top:12px">Don't see what you need? <a href="#" id="reqlink">Send IT a request</a>.</p>`);
  const load = async () => {
    const u = new URLSearchParams();
    if (state.q) u.set('q', state.q);
    if (state.status && isAdmin()) u.set('status', state.status);
    if (state.category) u.set('category', state.category);
    history.replaceState(null, '', '#/assets' + (u.toString() && isAdmin() ? '?' + u.toString() : ''));
    try {
      const rows = await api('GET', '/api/assets?' + u.toString());
      const res = $('#results'); if (!res) return;
      res.innerHTML = rows.length ? `<div class="card-head"><span class="muted small">${rows.length} asset${rows.length === 1 ? '' : 's'}</span>${isAdmin() ? `<a class="small" href="/api/export/assets.csv">${'Export CSV'}</a>` : ''}</div><ul class="list">${rows.map((a) => {
        const st = assetStatus(a);
        const seats = a.license_seats > 1 ? ` · ${a.seats_used}/${a.license_seats} seats` : '';
        return `<li><a class="item" href="#/asset/${a.id}${srcQ('assets')}">${thumbHtml(a.thumb, a.category)}
          <div class="grow"><div class="title truncate">${esc(a.name)}</div>
          <div class="sub truncate"><span class="mono">${esc(a.tag)}</span>${a.holder_names && isAdmin() ? ' · ' + esc(a.holder_names) : ''}${seats}${!a.holder_names && a.location ? ' · ' + esc(a.location) : ''}</div></div>
          ${statusPill(a)}${icon('chev', 'chev')}</a></li>`;
      }).join('')}</ul>` : `<div class="empty">${icon('box')}<p>${state.q || state.status || state.category ? 'Nothing matches those filters.' : isAdmin() ? 'No assets yet. Tap <strong>Add</strong> or scan a barcode to get started.' : 'Nothing is available right now.'}</p></div>`;
    } catch (e) { fail(e); }
  };
  $('#q').oninput = debounce((e) => { state.q = e.target.value.trim(); load(); });
  $('#cat').onchange = (e) => { state.category = e.target.value; load(); };
  if ($('#chips')) $('#chips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; state.status = b.dataset.v; $$('.chip', $('#chips')).forEach((c) => c.classList.toggle('on', c === b)); load(); };
  $('#scanbtn').onclick = () => openScanner({ onResult: handleScannedCode });
  const rl = $('#reqlink'); if (rl) rl.onclick = (e) => { e.preventDefault(); requestEquipmentSheet(); };
  load();
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
        <button class="btn" id="scanbtn" title="Scan">${icon('scan')}</button></div>
      <p class="small muted" style="margin:0">Shared equipment. Something checked out or reserved right now is still listed: open it to see when it is free.</p>
      <div id="bn"></div>
      <div class="card" id="results" hidden></div>
    </div>
    <div class="browse-req" id="reqfoot"><span class="small muted">Don't see what you need?</span><button type="button" class="btn" data-reqit>${icon('send')} Send IT a request</button></div>`;
  const cur = () => byId.get(st.path[st.path.length - 1]);
  const availMeta = (n) => (n ? `${n} available` : 'None available');
  const renderNav = () => {
    const bn = $('#bn');
    const up = byId.get((cur() || {}).parent_id); // Back is the app's usual "‹ <where it goes>" link above the title; none at the top
    $('#backslot').innerHTML = st.path.length && !st.q ? backAnchor(hashFor(up ? up.id : null), up ? up.name : 'Browse equipment') : '';
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
    const state = !out ? statusPill(a) : a.avail_state === 'reserved' ? pill('reserved', 'Reserved') : pill('checked_out', 'Checked out');
    const when = out ? (a.expected_back ? ` · back ${fmtDate(a.expected_back)}` : a.avail_state === 'reserved' ? ' · see when it is free' : '') : (a.location ? ' · ' + esc(a.location) : '');
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
        : `<div class="empty">${icon('box')}<p>${st.q ? 'Nothing matches that search. Try a broader word such as “camera” or “laptop”, or send IT a request.' : 'No shared equipment is listed here yet.'}</p><button type="button" class="btn" data-reqit>${icon('send')} Send IT a request</button></div>`}`;
      $('#reqfoot').hidden = !list.length; // an empty list carries its own request button; the footer one would just repeat it
      const eb = $('[data-reqit]', box); if (eb) eb.onclick = () => requestEquipmentSheet();
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
  $('#scanbtn').onclick = () => openScanner({ onResult: handleScannedCode });
  $('#reqfoot [data-reqit]').onclick = () => requestEquipmentSheet(); // the same request flow as before (the empty-state button is wired when the list renders)
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

  main().innerHTML = `<div class="asset-bar"><div class="asset-bar-top">${backLink(backTo.href, backTo.label, backTo.exact)}${calendarLink({ asset: a.id })}</div>
      <div class="asset-id"><h1 class="truncate">${esc(a.name)}</h1><span class="mono muted">${esc(a.tag)}</span>${st === 'overdue' ? pill('overdue') : statusPill(a)}${multi ? `<span class="pill plain">${d.seats_used}/${d.capacity} seats</span>` : ''}</div></div>
    <div class="stack">
      ${photos.length ? `<div class="gallery">${photos.map((p, i) => `<div class="ph" data-ph="${p.id}"><img src="/uploads/${esc(p.thumb)}" data-full="/uploads/${esc(p.filename)}" alt="Photo of ${esc(a.name)}" loading="lazy">${i === 0 && photos.length > 1 ? '<span class="star">Cover</span>' : ''}</div>`).join('')}
        ${canPhoto ? `<label class="add-ph">${icon('camera')}<span>Add photo</span><input type="file" accept="image/*" multiple hidden id="ph-in"></label>` : ''}</div>`
        : canPhoto ? `<label class="no-photo"><div>${icon('camera')}<strong>Add a photo</strong><div class="small">Snap the device, its label, or any damage</div></div><input type="file" accept="image/*" multiple hidden id="ph-in"></label>` : ''}
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
  if (phIn) phIn.onchange = () => uploadPhotos(a.id, phIn.files).then(reload);
  $$('[data-ph]').forEach((el) => el.onclick = () => lightbox(d.photos.find((p) => p.id === Number(el.dataset.ph)), a, reload));
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
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

async function uploadPhotos(assetId, files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  Array.from(files).slice(0, 10).forEach((f) => fd.append('photos', f));
  toast('Uploading photo…');
  try { await api('POST', `/api/assets/${assetId}/photos`, fd); toast('Photo saved'); } catch (e) { fail(e); }
}
function lightbox(p, asset, reload) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="/uploads/${esc(p.filename)}" alt=""><div class="lb-bar">
    ${isAdmin() ? `<button class="iconbtn" id="lb-cover" title="Make cover photo">${icon('star')}</button><button class="iconbtn" id="lb-del" title="Delete photo">${icon('trash')}</button>` : ''}
    <button class="iconbtn" id="lb-x" title="Close">${icon('x')}</button></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.onclick = (e) => { if (e.target === el || e.target.closest('#lb-x')) close(); };
  const c = $('#lb-cover', el); if (c) c.onclick = async () => { await api('PUT', `/api/assets/${asset.id}/cover`, { photo_id: p.id }).catch(fail); close(); toast('Cover photo set'); reload(); };
  const d = $('#lb-del', el); if (d) d.onclick = async () => { close(); if (await confirmSheet('Delete photo?', 'This cannot be undone.', 'Delete', true)) { await api('DELETE', `/api/photos/${p.id}`).catch(fail); reload(); } };
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
async function viewAssetForm(id) {
  const editing = !!id;
  let a = { category: S.settings.categories[0] || 'Other', condition: 'Good', tag: qs().get('tag') || '' };
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
        ${!editing ? `<label class="field full"><span>Photos</span><label class="no-photo" style="aspect-ratio:auto;padding:18px"><div>${icon('camera')}<strong id="ph-label">Take or choose photos</strong></div><input type="file" name="photos" id="ph" accept="image/*" multiple hidden></label></label>` : ''}
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
  $$('[data-scan]').forEach((b) => b.onclick = () => openScanner({ title: b.dataset.scan === 'tag' ? 'Scan asset tag' : 'Scan serial number', onResult: (code) => { $(`[name=${b.dataset.scan}]`).value = code; toast('Scanned ' + code); } }));
  const ph = $('#ph'); if (ph) ph.onchange = () => { $('#ph-label').textContent = ph.files.length ? `${ph.files.length} photo${ph.files.length > 1 ? 's' : ''} selected` : 'Take or choose photos'; };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {}; for (const [k, v] of fd.entries()) if (k !== 'photos') body[k] = v;
    body.available_to_request = $('#atr').checked; body.reservation_requires_approval = $('#rra').checked; // (a disabled checkbox is not in FormData, so read both directly)
    busy($('#save'), async () => {
      const saved = await api(editing ? 'PUT' : 'POST', editing ? '/api/assets/' + id : '/api/assets', body);
      if (ph && ph.files.length) await uploadPhotos(saved.id, ph.files);
      toast(editing ? 'Saved' : `Added ${saved.tag}`);
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

// ============================================================ requests
async function viewRequests() {
  const state = { tab: ['open', 'closed', 'reservations'].includes(qs().get('tab')) ? qs().get('tab') : 'open', f: qs().get('state') || '' };
  main().innerHTML = `<div class="page-head"><h1>Requests</h1><button class="btn primary" id="new">${icon('plus')} ${isAdmin() ? 'New' : 'Request equipment'}</button></div>
    <div class="stack"><div class="row wrap" style="gap:10px"><div class="seg" id="seg"><button data-v="open">Open</button><button data-v="closed">Closed</button><button data-v="reservations">Reservations</button></div>
      ${isAdmin() ? '<select id="st" aria-label="Filter by state" style="width:auto;min-height:40px;padding:6px 10px;font-size:15px"></select>' : ''}</div><div id="list"><div class="spinner"></div></div></div>`;
  $('#new').onclick = async () => {
    if (!isAdmin()) return requestEquipmentSheet();
    const { el, close } = sheet(`<h2>New request</h2><div class="stack" style="margin-top:14px">
      <button class="btn lg block" id="n1">${icon('box')} Log an equipment request for someone</button>
      <button class="btn lg block" id="n2">${icon('send')} Ask someone to return an item</button></div>`);
    $('#n1', el).onclick = async () => { close(); const users = await getUsers(); const s = sheet(`<h2>Who is it for?</h2><div id="pp" style="margin-top:12px"></div>`); personPicker($('#pp', s.el), users, (u) => { s.close(); requestEquipmentSheet({ forUser: u }); }); };
    $('#n2', el).onclick = () => { close(); go('#/assets?status=checked_out'); toast('Open the item and tap “Request return”'); };
  };
  // Reservations (slice 7): a separate list, not a request type. IT sees every one (pending approvals first, with Approve / Decline);
  // an employee sees their own, with Cancel / Shorten. All rules come from the server.
  const syncResvLabel = (n) => { const b = $('#seg [data-v=reservations]'); if (b) b.innerHTML = `Reservations${n ? ` <span class="seg-count">${n}</span>` : ''}`; };
  const renderReservations = async () => {
    const [rows, wl] = await Promise.all([api('GET', '/api/reservations'), api('GET', '/api/waitlist')]); // (waitlist entries live here too, not in a product of their own)
    const list = $('#list'); if (!list) return;
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
    list.innerHTML = `<div class="stack">${adminV
      ? section('Waiting for approval', pending, 'Nothing is waiting for approval.') + section('Waitlist', activeWl, 'Nobody is on a waitlist.', drawWl) + section('Upcoming & active', live, 'No confirmed reservations ahead.')
      : `${offered.length ? section('Available for you', offered, '', drawWl) : ''}${section('Pending & upcoming', [...pending, ...live], 'No reservations yet. Open an item in Browse and choose Reserve.')}${queued.length ? section('Waitlist', queued, '', drawWl) : ''}`}${done.length ? section('Past & closed', done, '') : ''}${wlDone.length ? section('Past waitlist entries', wlDone, '', drawWl) : ''}</div>`;
    wireReservationActions(list, rows, () => renderReservations().catch(fail));
    wireWaitlistActions(list, wl, () => renderReservations().catch(fail));
  };
  const render = async () => {
    $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.tab));
    const stSel = $('#st'); if (stSel) stSel.style.display = state.tab === 'reservations' ? 'none' : '';
    if (state.tab === 'reservations') return renderReservations();
    api('GET', '/api/reservation-counts').then((c) => syncResvLabel(c.attention)).catch(() => {});
    const all = await api('GET', '/api/requests?status=' + state.tab);
    const list = $('#list'); if (!list) return;
    // IT's state filter: the tab's states with how many requests are in each. (Client-side over the same list; the lifecycle comes from the server.)
    const countOf = (k) => all.filter((r) => stateKey(r) === k).length;
    const states = (state.tab === 'open' ? OPEN_STATES : CLOSED_STATES).filter((k) => !ISSUE_ONLY_STATES.includes(k) || countOf(k) > 0);
    if (!states.includes(state.f)) state.f = '';
    const st = $('#st');
    if (st) st.innerHTML = `<option value="">All (${all.length})</option>${states.map((k) => `<option value="${k}"${state.f === k ? ' selected' : ''}>${LIFE_LABEL[k]} (${countOf(k)})</option>`).join('')}`;
    const rows = state.f ? all.filter((r) => stateKey(r) === state.f) : all;
    if (!rows.length) { list.innerHTML = `<div class="card"><div class="empty">${icon('inbox')}<p>${all.length ? `No ${LIFE_LABEL[state.f].toLowerCase()} requests.` : state.tab === 'open' ? 'No open requests.' : 'Nothing here yet.'}</p></div></div>`; return; }
    const find = (id) => all.find((r) => r.id === Number(id));
    const kindOf = (r) => (r.type === 'return' ? 'Return request' : r.type === 'issue' ? 'Issue report' : isPermReq(r) ? 'Permanent assignment request' : 'Equipment request');
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
    $$('[data-detail]', list).forEach((it) => {
      const open = () => openDetail(find(it.dataset.detail));
      it.onclick = (e) => { if (e.target.closest('a,button')) return; open(); };
      it.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === it) { e.preventDefault(); open(); } };
    });
    $$('[data-open]', list).forEach((b) => b.onclick = () => openDetail(find(b.dataset.open)));
    wireActions(list);
  };
  const keepUrl = () => history.replaceState(null, '', `#/requests?tab=${state.tab}${state.f ? '&state=' + state.f : ''}`);
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
const resvRange = (r) => (r.start_date === r.end_date ? fmtDate(r.start_date) : `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`);
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
  if (r.can_cancel && !itDeciding) acts.push(`<button class="btn sm" data-resv-cancel="${r.id}">Cancel${forAdmin && !r.mine ? ' reservation' : ''}</button>`);
  if (r.can_shorten) acts.push(`<button class="btn sm" data-resv-shorten="${r.id}">Shorten</button>`);
  const who = forAdmin ? `${esc(r.employee_name)}${r.employee_department ? ' · ' + esc(r.employee_department) : ''}` : '';
  const sub = [`${esc(resvRange(r))} · ${resvDays(r)} day${resvDays(r) === 1 ? '' : 's'}`, who, forAdmin && r.requires_approval ? 'approval required' : '', r.waitlist_entry_id ? 'from the waitlist' : '', showAsset ? `<span class="mono">${esc(r.asset_tag)}</span>` : ''].filter(Boolean).join(' · ');
  return `<li class="resv"><div class="item" style="align-items:flex-start"><div class="thumb">${icon('calendar')}</div><div class="grow">
    <div class="row spread" style="align-items:flex-start"><div>${asset}${asset ? '' : `<span class="title">${esc(resvRange(r))}</span>`}</div>${resvPill(r)}</div>
    <div class="sub">${asset ? sub : [resvDays(r) + ' day' + (resvDays(r) === 1 ? '' : 's'), who, forAdmin && r.requires_approval ? 'approval required' : ''].filter(Boolean).join(' · ')}</div>
    ${r.decision_note ? `<div class="small muted" style="margin-top:4px">IT: ${esc(r.decision_note)}</div>` : ''}
    ${acts.length ? `<div class="row wrap" style="margin-top:8px;gap:8px">${acts.join('')}</div>` : ''}</div></div></li>`;
}
// Shorten: the reservation's own days are shown on a calendar that is always visible (no pop-up date picker). Tap the new LAST day: days up to it are
// kept, the days after it are released (green). Only the end can move earlier, never the start or later (the server enforces it).
function shortenSheet(r, done) {
  const lastPick = isoAdd(r.end_date, -1); const first = r.shorten_min;
  let end = lastPick; let month = lastPick.slice(0, 7);
  const firstMonth = r.start_date.slice(0, 7); const lastMonth = r.end_date.slice(0, 7);
  const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
  const { el, close } = sheet(`<h2>Shorten this reservation</h2><p class="muted small" style="margin-top:0">${esc(r.asset_name)} · ${esc(resvRange(r))}. Tap the new last day. To keep it longer, make a new reservation.</p>
    <form id="f"><div class="card cal-card" style="box-shadow:none">
      <div class="cal-nav"><button type="button" class="iconbtn" id="sc-prev" aria-label="Previous month">${icon('back')}</button><h2 id="sc-month" aria-live="polite"></h2><button type="button" class="iconbtn" id="sc-next" aria-label="Next month">${icon('chev')}</button></div>
      <div class="cal-wd" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid" id="sc-grid"></div>
      <div class="cal-legend small muted"><span><i class="reserved"></i>Kept</span><span><i class="free"></i>Released</span></div></div>
      <p id="sc-sum" style="margin:12px 0 0"></p>
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Shorten</button></div></form>`);
  const paint = () => {
    const [y, mo] = month.split('-').map(Number);
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const cells = Array.from({ length: lead }, () => '<span class="cal-day blank" aria-hidden="true"></span>');
    for (let d = 1; d <= days; d++) {
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      const inRes = iso >= r.start_date && iso <= r.end_date; const can = iso >= first && iso <= lastPick;
      const cls = !inRes ? 'off' : iso === end ? 'edge' : iso < end ? 'inrange' : 'free';
      const label = !inRes ? 'not part of this reservation' : iso > end ? 'will be released' : iso === end ? 'new last day' : 'kept';
      cells.push(`<button type="button" class="cal-day ${cls}${can ? ' pick' : ''}" ${can ? `data-day="${iso}"` : 'disabled'} aria-label="${esc(fmtDate(iso))}: ${label}"><span class="d">${d}</span><span class="c"></span></button>`);
    }
    $('#sc-grid', el).innerHTML = cells.join('');
    $('#sc-month', el).textContent = monthName(month);
    $('#sc-prev', el).disabled = month <= firstMonth; $('#sc-next', el).disabled = month >= lastMonth;
    const n = Math.round((Date.parse(r.end_date + 'T00:00:00Z') - Date.parse(end + 'T00:00:00Z')) / 864e5);
    $('#sc-sum', el).innerHTML = `New last day: <strong>${esc(fmtDate(end))}</strong> <span class="muted small">· ${n} day${n === 1 ? '' : 's'} released (${esc(fmtDate(isoAdd(end, 1)))}${n > 1 ? ' – ' + esc(fmtDate(r.end_date)) : ''})</span>`;
  };
  $('#sc-grid', el).onclick = (e) => { const b = e.target.closest('[data-day]'); if (b) { end = b.dataset.day; paint(); } };
  $('#sc-prev', el).onclick = () => { month = shift(month, -1); paint(); };
  $('#sc-next', el).onclick = () => { month = shift(month, 1); paint(); };
  paint();
  // (the success message comes only after the server has finished: it names the range the reservation now has)
  $('#f', el).onsubmit = (e) => { e.preventDefault(); busy($('#go', el), async () => { const u = await api('POST', `/api/reservations/${r.id}/shorten`, { end_date: end }); close(); toast(`Reservation shortened to ${resvRange(u)}.`, false, 'ok'); done(); }); };
}
// Wires every reservation button under `root` (rows = the reservations drawn there). `reload` redraws the screen afterwards.
function wireReservationActions(root, rows, reload) {
  const find = (id) => rows.find((r) => r.id === Number(id));
  const each = (sel, key, fn) => $$(sel, root).forEach((b) => { b.onclick = (e) => { e.preventDefault(); fn(find(b.dataset[key]), b); }; });
  const after = (msg) => { toast(msg); refreshBadge(); reload(); };
  each('[data-resv-approve]', 'resvApprove', (r, b) => busy(b, async () => { await api('POST', `/api/reservations/${r.id}/approve`, {}); after('Approved'); }));
  each('[data-resv-decline]', 'resvDecline', (r) => noteSheet('Decline reservation', `${r.employee_name}'s request for ${r.asset_name} (${resvRange(r)}). Add a short reason (optional).`, 'Decline', 'e.g. Needed for a shoot that week',
    async (note) => { await api('POST', `/api/reservations/${r.id}/decline`, { note }); after('Declined'); }, true));
  each('[data-resv-cancel]', 'resvCancel', async (r) => {
    const mine = r.mine !== false && !isAdmin();
    if (!(await confirmSheet(mine ? 'Cancel this reservation?' : `Cancel ${r.employee_name}'s reservation?`, `${r.asset_name} · ${resvRange(r)}. The dates become available to others right away.`, 'Cancel reservation', true))) return;
    try { await api('POST', `/api/reservations/${r.id}/cancel`, {}); after('Reservation cancelled'); } catch (e) { fail(e); reload(); }
  });
  each('[data-resv-shorten]', 'resvShorten', (r) => shortenSheet(r, () => { refreshBadge(); reload(); }));
}

// ---- waitlist (slice 8): shown in the same Requests > Reservations list. First come, first served; nothing is ever reserved for you until
// you confirm an offer, and nobody can ask a current reserver to give anything up. The server decides the phase and which buttons apply.
const WL_LABEL = { waiting: 'Waitlisted', held: 'Available — confirm within 24 hours', confirmed: 'Confirmed', pending: 'Waiting for approval', declined: 'No longer needed', left: 'Left waitlist', removed: 'Removed by IT', expired: 'Expired', reservation_declined: 'Declined by IT', reservation_cancelled: 'Reservation cancelled' };
const WL_CLASS = { waiting: 'in_review', held: 'open', confirmed: 'approved', pending: 'open', reservation_declined: 'denied' };
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;
function waitlistItem(w, { admin: forAdmin }) {
  const days = resvDays(w);
  const asset = forAdmin ? `<a href="#/asset/${w.asset_id}${srcQ('requests', { tab: 'reservations' })}" class="title">${esc(w.asset_name)}</a>` : `<span class="title">${esc(w.asset_name)}</span>`;
  const sub = [`${esc(resvRange(w))} · ${days} day${days === 1 ? '' : 's'}`, forAdmin ? `${esc(w.employee_name)}${w.employee_department ? ' · ' + esc(w.employee_department) : ''}` : '',
    w.position && w.phase === 'waiting' ? `${ordinal(w.position)} in line` : '', `${w.phase === 'waiting' ? 'in line since' : 'joined'} ${fmtWhen(w.phase === 'waiting' ? w.queued_at : w.created_at)}`, `<span class="mono">${esc(w.asset_tag)}</span>`].filter(Boolean).join(' · ');
  const acts = [];
  if (w.can_confirm) acts.push(`<button class="btn sm primary" data-wl-confirm="${w.id}">Yes, I still need it</button><button class="btn sm" data-wl-decline="${w.id}">I don't need it</button>`);
  else if (w.can_leave) acts.push(`${w.can_edit ? `<button class="btn sm" data-wl-edit="${w.id}">Edit dates</button>` : ''}<button class="btn sm" data-wl-cancel="${w.id}">Leave waitlist</button>`);
  if (w.can_remove) acts.push(`<button class="btn sm danger" data-wl-remove="${w.id}">Remove</button>`);
  const hold = w.hold_expires_at ? `<div class="small" style="margin-top:4px"><strong>${forAdmin ? 'Held until' : 'Held for you until'} ${esc(fmtStamp(w.hold_expires_at))}.</strong> ${forAdmin ? 'If they do not answer, the next person in line is offered it.' : 'Confirm that you still need it, or let it go so the next person can have it.'}</div>` : '';
  return `<li class="resv"><div class="item" style="align-items:flex-start"><div class="thumb">${icon('calendar')}</div><div class="grow">
    <div class="row spread" style="align-items:flex-start"><div>${asset}</div>${pill(WL_CLASS[w.phase] || 'cancelled', WL_LABEL[w.phase] || w.phase)}</div>
    <div class="sub">${sub}</div>${hold}
    ${acts.length ? `<div class="row wrap" style="margin-top:8px;gap:8px">${acts.join('')}</div>` : ''}</div></div></li>`;
}
// ONE date sheet for everything that asks for a range of one item's dates: reserve it, join its waitlist, or change the dates of a waitlist
// entry (`entry`). It never decides anything itself: as the dates change it asks the server (GET /api/assets/:id/range-check) what that range
// means, so the button always says what will really happen: all free -> Reserve; blocked by a reservation -> Join waitlist; otherwise a reason.
// `reservedDay` = it was opened by tapping a day that is already reserved (the intro says so). Dates are plain calendar days, both included.
function rangeSheet({ asset, start, end, entry = null, reservedDay = false, today = localToday(), onDone }) {
  const edit = !!entry;
  const { el, close } = sheet(`<h2 id="rs-title">${edit ? 'Edit waitlist dates' : 'Choose your dates'}</h2>
    <p class="muted small" style="margin-top:0"><strong>${esc(asset.name)}</strong>${asset.tag ? ` <span class="mono">${esc(asset.tag)}</span>` : ''}. ${edit ? 'Change the days you are waiting for.' : reservedDay ? `<strong>${esc(fmtDate(start))} is already reserved.</strong> Choose the whole range you need. If any of it is reserved you can join the waitlist; if all of it is free you can reserve it.` : 'Choose the whole range you need. Both days are included.'}</p>
    <form class="form-grid" id="f"><div class="form-grid cols"><label class="field"><span>First day</span><input type="date" name="start_date" required min="${esc(today)}" value="${esc(start)}"></label>
      <label class="field"><span>Last day</span><input type="date" name="end_date" required min="${esc(start >= today ? start : today)}" value="${esc(end)}"></label></div>
      <div id="rs-note"></div>
      ${edit ? `<div class="banner warn">${icon('alert')}<div class="grow small"><strong>Changing your dates updates your place in line.</strong> You move behind anyone already waiting for the new dates.</div></div>` : ''}
      <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go" disabled>${edit ? 'Save new dates' : 'Continue'}</button></div></form>`);
  const f = $('#f', el); let tok = 0; let out = null;
  const paint = (r) => {
    out = r && r.outcome ? r : null;
    const o = out && out.outcome; const needs = out && out.requires_approval;
    const same = edit && f.start_date.value === entry.start_date && f.end_date.value === entry.end_date;
    let kind = 'info'; let text = 'Checking those dates…'; let label = edit ? 'Save new dates' : 'Continue'; let ok = false; let title = edit ? 'Edit waitlist dates' : 'Choose your dates';
    if (o === 'reserve') {
      if (edit) { text = 'All of these days are free right now, so there is nothing to wait for. Pick dates that are reserved to stay on the waitlist, or leave the waitlist and reserve these days from the calendar.'; kind = 'warn'; }
      else { title = needs ? 'Request this reservation?' : 'Reserve this item?'; text = `All of these days are free. ${needs ? 'IT must approve this reservation. It does not hold the dates until they do.' : 'This reservation is confirmed right away.'}`; label = needs ? 'Submit for approval' : 'Reserve'; ok = true; }
    } else if (o === 'waitlist') {
      title = edit ? 'Edit waitlist dates' : 'Join the waitlist';
      text = `${esc(out.message)} If the whole range opens up you will be offered it for 24 hours (first come, first served). The current reservation is not affected.`;
      label = edit ? 'Save new dates' : 'Join waitlist'; ok = !same;
      if (same) text = 'These are your current dates. Change them to update your waitlist entry.';
    } else if (o) { text = esc(out.message); kind = 'warn'; }
    if (!o) { text = 'Checking those dates…'; }
    $('#rs-title', el).textContent = title;
    $('#rs-note', el).innerHTML = `<div class="banner ${kind}">${icon(kind === 'warn' ? 'alert' : 'calendar')}<div class="grow small">${o === 'waitlist' || o === 'reserve' ? text : esc(text)}</div></div>`;
    const go = $('#go', el); go.textContent = label; go.disabled = !ok;
  };
  const check = async () => {
    const my = ++tok; const s0 = f.start_date.value; const e0 = f.end_date.value;
    if (!s0 || !e0) { out = null; $('#go', el).disabled = true; $('#rs-note', el).innerHTML = `<div class="banner warn">${icon('alert')}<div class="grow small">Choose a first day and a last day.</div></div>`; return; }
    paint(null);
    try { const r = await api('GET', `/api/assets/${asset.id}/range-check?start_date=${encodeURIComponent(s0)}&end_date=${encodeURIComponent(e0)}${edit ? '&entry_id=' + entry.id : ''}`); if (my === tok) paint(r); }
    catch (e) { if (my === tok) paint({ outcome: 'unavailable', message: e.message }); }
  };
  f.start_date.onchange = () => { if (f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; f.end_date.min = f.start_date.value; check(); };
  f.end_date.onchange = check;
  f.onsubmit = (e) => {
    e.preventDefault(); if (!out) return;
    const body = { start_date: f.start_date.value, end_date: f.end_date.value }; const o = out.outcome;
    busy($('#go', el), async () => {
      try {
        if (o === 'reserve' && !edit) { const r = await api('POST', `/api/assets/${asset.id}/reservations`, body); close(); toast(r.status === 'confirmed' ? 'Reserved' : 'Submitted for IT approval'); }
        else if (o === 'waitlist' && !edit) { await api('POST', `/api/assets/${asset.id}/waitlist`, body); close(); toast('You are on the waitlist'); }
        else if (o === 'waitlist' && edit) { await api('PUT', `/api/waitlist/${entry.id}`, body); close(); toast('Dates updated. You are now behind anyone already waiting for those dates.'); }
        else return;
      } catch (err) { fail(err); check(); return; } // (someone may have just changed things: the sheet re-asks the server)
      refreshBadge(); if (onDone) await onDone(body);
    });
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
  each('[data-wl-edit]', 'wlEdit', (w) => rangeSheet({ asset: { id: w.asset_id, name: w.asset_name, tag: w.asset_tag }, start: w.start_date, end: w.end_date, entry: w, onDone: reload }));
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
  const fixed = { '#/home': 'Home', '#/assets': admin ? 'All assets' : 'Browse equipment', '#/catalog': 'Equipment catalog', '#/requests': 'Requests', '#/people': 'People', '#/labels': 'Print labels', '#/import': 'Import / export', '#/activity': 'Activity log', '#/settings': 'Settings', '#/profile': 'My profile', '#/equipment': 'My equipment', '#/history': 'History', '#/scan': 'Scan', '#/account': 'Profile', '#/new': 'Add an asset' };
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
      const cls = { available: 'free', expected: 'expected', occupied: 'busy', reserved: 'reserved' }[s] || 'off';
      return { day, cls, text: '', label: `${fmtDate(day)}: ${DAY_WORD[s]}` };
    }
    const c = data.days[i]; const n = c.available; const e = c.expected; const total = data.total;
    const cls = !total ? 'off' : n === total ? 'free' : n > 0 ? 'mixed' : e > 0 ? 'expected' : 'busy';
    // "36" = available that day; "+2" = two more are expected back by then (a due date, not a guarantee)
    return { day, cls, text: total ? `${n}${e ? `<em>+${e}</em>` : ''}` : '', label: `${fmtDate(day)}: ${n} of ${total} available${e ? `, ${e} more expected back` : ''}` };
  };
  const DAY_WORD = { available: 'available', expected: 'expected back (not guaranteed)', occupied: 'unavailable', reserved: 'reserved', repair: 'in repair', ineligible: 'not lendable', archived: 'archived', past: 'past' };

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
    } else if (s === 'reserved') {
      for (const x of (a.reservations || []).filter((r) => r.status === 'confirmed' && r.start <= day && day <= r.end)) {
        parts.push(`Reserved ${x.start === x.end ? fmtDate(x.start) : fmtDate(x.start) + ' – ' + fmtDate(x.end)}${x.mine && !adminV ? ' · by you' : ''}${adminV && x.holder ? ' · ' + who(x) : ''}`);
      }
      // dates held for someone from the waitlist (a 24-hour offer): taken for everyone else, whoever the person is
      for (const x of (a.holds || []).filter((h) => h.start <= day && day <= h.end)) {
        parts.push(x.mine ? `Held for you until ${fmtStamp(x.hold_expires_at)}` : `On hold for a waitlisted team${adminV && x.hold_expires_at ? ' until ' + fmtStamp(x.hold_expires_at) : ''}${adminV && x.holder ? ' · ' + who(x) : ''}`);
      }
    } else parts.push(DAY_WORD[s].replace(/^./, (c) => c.toUpperCase()));
    // a request still waiting for IT does not hold the day; its owner (and IT) is reminded of it here
    for (const x of (a.reservations || []).filter((r) => r.status === 'pending' && r.start <= day && day <= r.end)) {
      parts.push(`${adminV ? 'Pending request' : 'Your request'} ${x.start === x.end ? fmtDate(x.start) : fmtDate(x.start) + ' – ' + fmtDate(x.end)} is waiting for IT approval${adminV && x.holder ? ' · ' + who(x) : ''}`);
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
      const rows = [[c.available, 'available', 'available'], [c.checked_out, 'checked out', 'occupied'], [c.expected, 'expected back', 'expected'], [c.reserved, 'reserved', 'reserved'], [c.off, 'in repair or not lendable', 'off']];
      return rows.filter(([n, , k]) => n || !['expected', 'reserved'].includes(k));
    }
    const rows = [[c.available, 'available', 'available'], [c.unavailable, 'checked out', 'occupied'], [c.expected, 'expected back', 'expected'], [c.reserved, 'reserved', 'reserved']];
    return rows.filter(([n, , k]) => n || !['expected', 'reserved'].includes(k));
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
  const GROUPS = [['available', 'Available'], ['reserved', 'Reserved'], ['occupied', 'Checked out'], ['expected', 'Expected back']];
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
        <p class="small muted" style="margin:10px 0 0">You will pick a start and an end date on the calendar. ${needs ? 'IT approves reservations for this item.' : 'Reservations for this item are confirmed right away.'} Need a day that is already reserved? Tap it to join the waitlist.</p></div>`;
    }
    const e0 = sel.end || sel.start;
    return `<div class="card pad cal-reserve"><h3 style="margin:0 0 6px">Reserve ${esc(a.name)}</h3>
      <p class="small muted" style="margin:0 0 10px">${!sel.start ? 'Tap the first day you need it.' : !sel.end ? 'Tap the last day, or tap the same day again for a single day. Both days are included.' : 'Both days are included. Tap another day to start over.'}</p>
      ${sel.start ? `<div class="cal-range"><strong>${esc(rangeText(sel.start, e0))}</strong><span class="muted small"> · ${nDays(sel.start, e0)} day${nDays(sel.start, e0) === 1 ? '' : 's'}${sel.end ? '' : ' so far'}</span></div>` : ''}
      <div class="row wrap" style="gap:8px;margin-top:12px"><button class="btn" id="resv-cancel">Cancel</button>${sel.start ? '<button class="btn" id="resv-clear">Clear dates</button>' : ''}<button class="btn primary" id="resv-go" ${sel.start ? '' : 'disabled'}>${needs ? 'Review request' : 'Review & reserve'}</button></div></div>`;
  };
  // Waitlist (slice 8). Offered when the day you are looking at is reserved by someone else (or held for another team). Joining changes nothing
  // for the current reserver; if the whole range you ask for frees up you get a 24-hour offer, first come, first served.
  const wlStatus = (w) => (w.phase === 'held' ? `held for you until ${fmtStamp(w.hold_expires_at)}` : 'waitlisted');
  const waitlistPanel = () => {
    const mineWl = (A[0].waitlist || []).filter((w) => w.mine);
    if (!mineWl.length) return '';
    return `<div class="card pad cal-reserve"><h3 style="margin:0 0 6px">Your waitlist</h3><div class="stack" style="gap:6px">${mineWl.map((w) => `<div class="small"><strong>${esc(rangeText(w.start, w.end))}</strong> · ${esc(wlStatus(w))}</div>`).join('')}<a class="small" href="#/requests?tab=reservations">${mineWl.some((w) => w.phase === 'held') ? 'Confirm or let go of your hold' : 'Edit dates or leave the waitlist'} →</a></div></div>`;
  };
  // IT: everyone in line for this asset, oldest first. (Informational: IT may remove an entry from Requests > Reservations, never reorder one.)
  const queueHtml = () => {
    const q = isAdmin() && A[0] && A[0].waitlist ? A[0].waitlist : [];
    if (!q.length) return '';
    return `<div class="card"><div class="card-head"><h2>Waitlist</h2><span class="muted small">${q.length}</span></div><ul class="list">${q.map((w, n) => `<li><a class="item" href="#/requests?tab=reservations"><div class="grow"><div class="title truncate">${n + 1}. ${esc(w.holder.name)}${w.holder.department ? ' · ' + esc(w.holder.department) : ''}</div>
      <div class="sub">${esc(rangeText(w.start, w.end))} · ${w.phase === 'held' ? `held until ${esc(fmtStamp(w.hold_expires_at))}` : 'waiting'} · joined ${esc(fmtWhen(w.created_at))}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>`;
  };
  // The one date sheet (see rangeSheet): reserve, or join the waitlist when the range is reserved. Afterwards the calendar reloads as it is now.
  const openRange = (s0, e0, reservedDay) => rangeSheet({ asset: A[0], start: s0, end: e0, reservedDay, today: data.today, onDone: async () => {
    sel.on = false; sel.start = sel.end = ''; stateCache.clear(); await go2(st.month);
    if (s0.slice(0, 7) === st.month) { st.day = s0; keepUrl(); paint(); }
  } });
  const panelHtml = () => {
    const day = st.day; const i = Number(day.slice(8)) - 1;
    const body = day < data.today ? passedHtml(day) : isSummary() ? summaryPanel(day, i) : assetPanel(day, i);
    return body + (canReserve ? reservePanel() + waitlistPanel() : '') + (isSummary() ? '' : queueHtml());
  };

  const gridHtml = () => {
    const [y, mo] = st.month.split('-').map(Number);
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const cells = Array.from({ length: lead }, () => '<span class="cal-day blank" aria-hidden="true"></span>');
    const range = sel.on && sel.start ? [sel.start, sel.end || sel.start] : null;
    for (let i = 0; i < monthDays; i++) {
      const c = cellInfo(i);
      const pick = sel.on && c.day >= data.today ? (['free', 'expected'].includes(c.cls) ? ' pick' : ' nopick') : '';
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
        <div class="cal-legend small muted"><span><i class="free"></i>Available</span>${isSummary() ? '<span><i class="mixed"></i>Some available</span>' : ''}<span><i class="expected"></i>Expected back</span><span><i class="reserved"></i>Reserved</span><span><i class="busy"></i>Unavailable</span>${isAdmin() ? '<span><i class="off"></i>Repair / not lendable</span>' : ''}</div>
      </div>
      <div id="calpanel"></div>
      <p class="small muted">Based on what is checked out right now. A due date is when something is expected back, not a booking, so those days are shown as <em>expected</em>, never as guaranteed${isSummary() ? ' (a “+2” on a day means two more are expected back by then)' : ''}. ${isAdmin() && isSummary() ? 'Permanently assigned equipment is not part of this calendar. ' : ''}Confirmed reservations hold their dates, and so do dates held for someone from the waitlist; a request still waiting for IT approval does not.</p>
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
  const takeable = (s0) => s0 === 'available' || s0 === 'expected'; // what the server accepts: expected-back days may be reserved, occupied/reserved ones may not
  const ensureMonths = async (s0, e0) => {
    for (let m = s0.slice(0, 7); m <= e0.slice(0, 7); m = monthShift(m, 1)) {
      if (!stateCache.has(m)) stateCache.set(m, (await api('GET', `/api/availability?asset=${want.asset}&month=${m}`)).assets[0].days);
    }
  };
  const firstTaken = (s0, e0) => { for (let d = s0; d <= e0; d = addDaysStr(d, 1)) if (!takeable(stateOf(d))) return d; return null; };
  const pickDay = async (day) => {
    if (day < data.today) return;
    if (!takeable(stateOf(day))) { toast(`${fmtDate(day)} isn't free to reserve.`, true); return; }
    if (!sel.start || sel.end || day < sel.start) { sel.start = day; sel.end = ''; return; }
    if (day === sel.start) { sel.end = day; return; }
    try { await ensureMonths(sel.start, day); } catch (e) { fail(e); return; }
    const taken = firstTaken(sel.start, day);
    if (taken) { // a reserved day inside the range: that is a waitlist question, not an error (the sheet explains); anything else is just taken
      if (stateOf(taken) === 'reserved') { sel.end = day; return 'conflict'; }
      toast(`${fmtDate(taken)} is already taken, so that range won't work. Pick a shorter one.`, true); return;
    }
    sel.end = day;
  };
  paint();
  $('#calprev').onclick = () => go2(monthShift(st.month, -1));
  $('#calnext').onclick = () => go2(monthShift(st.month, 1));
  $('#calgrid').onclick = async (e) => {
    const b = e.target.closest('[data-day]'); if (!b) return;
    st.day = b.dataset.day;
    // A day that is already reserved (by someone else) opens the date sheet right away: no warning, no scrolling. If a range was being picked
    // it is the end of that range. Your own reservation or hold is not "someone else's": that day just selects.
    const i = Number(st.day.slice(8)) - 1;
    const own = (A[0].holds || []).concat(A[0].reservations || []).some((x) => x.mine && x.start <= st.day && st.day <= x.end);
    if (canReserve && st.day >= data.today && A[0].days[i] === 'reserved' && !own) {
      const from = sel.on && sel.start && !sel.end && st.day > sel.start ? sel.start : st.day;
      if (from !== st.day) sel.end = st.day;
      keepUrl(); paint(); openRange(from, st.day, from === st.day); return;
    }
    let outcome = null;
    if (sel.on) outcome = await pickDay(st.day);
    keepUrl(); paint();
    if (outcome === 'conflict') { openRange(sel.start, sel.end, false); return; }
    const panel = $('#calpanel'); if (panel && panel.getBoundingClientRect().top > window.innerHeight - 120) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  main().innerHTML = `<div class="page-head"><h1>People</h1><button class="btn primary" id="add">${icon('plus')} Add person</button></div>
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
}
function personSheet(u, done) {
  const editing = !!u; u = u || { role: 'employee', has_account: true };
  const { el, close } = sheet(`<h2>${editing ? 'Edit person' : 'Add a person'}</h2>
    <form class="form-grid" id="f" style="margin-top:12px">
      <label class="field"><span>Full name *</span><input name="name" required value="${esc(u.name || '')}" autocomplete="off"></label>
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
    if (r.link) sheet(`<h2>Email isn't set up yet</h2><p class="muted">Send this link to ${esc(u.name)} yourself. It expires in 7 days.</p><input readonly value="${esc(r.link)}" onclick="this.select()"><div class="sheet-actions"><button class="btn primary" data-close>Done</button></div>`);
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
async function viewLabels() {
  const pre = (qs().get('ids') || '').split(',').filter(Boolean).map(Number);
  const all = await api('GET', '/api/assets');
  const selected = new Set(pre);
  main().innerHTML = `<div class="no-print">${pre.length === 1 ? backLink('#/asset/' + pre[0], 'Back') : ''}
    <div class="page-head"><h1>Print labels</h1><button class="btn primary" id="print">${icon('printer')} Print</button></div>
    <p class="muted small" style="margin-top:-6px">Sized for Avery 5160 / 8160 sheets (30 per page, 2⅝" × 1"). Works on most label printers too — set the paper size to your label.</p>
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
    $('#sheet').innerHTML = list.length ? list.map((a) => `<div class="label"><div class="l-top"><span>NUTRICOST IT</span><span>${esc(a.category)}</span></div><svg data-code="${esc(a.tag)}"></svg><div class="l-name">${esc(a.name)}</div></div>`).join('') : '<p class="muted no-print">Pick assets above to preview their labels.</p>';
    $$('#sheet svg[data-code]').forEach((svg) => { try { window.JsBarcode(svg, svg.dataset.code, { format: 'CODE128', height: 40, width: 1.6, margin: 0, fontSize: 12, font: 'monospace', textMargin: 1, displayValue: true }); } catch { /* */ } });
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
        <div class="form-grid cols"><label class="field"><span>Default loan length (days, 0 = none)</span><input name="default_loan_days" type="number" min="0" value="${s.default_loan_days}"></label>
        <label class="field"><span>Asset tag prefix</span><input name="tag_prefix" value="${esc(s.tag_prefix)}" class="mono"></label></div></div></div>
      <div class="card pad stack">
        <div class="set-head"><div class="field"><span>Categories &amp; equipment types</span><span class="small muted">Categories now live in the catalog, where each one can have brands, models and more below it.</span></div>
          <a class="btn" href="#/catalog?from=${encodeURIComponent('#/settings')}">${icon('tag')} Manage the equipment catalog</a></div>
        <label class="field"><span>Locations (one per line)</span><textarea name="locations" rows="6">${esc(s.locations.join('\n'))}</textarea></label></div>
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
    const body = { overdue_reminders: fd.has('overdue_reminders'), default_loan_days: fd.get('default_loan_days'), tag_prefix: fd.get('tag_prefix'),
      locations: fd.get('locations').split('\n'), it_email_name: fd.get('it_email_name'), it_contact_email: fd.get('it_contact_email') };
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
async function viewCatalog() {
  const st = { rows: [], archived: false, sel: null, all: false, assets: null, token: 0, search: '', found: null, searchToken: 0 };
  // The URL is the state: #/catalog (all categories), #/catalog?node=<id>, #/catalog?node=<id>&all=1 ("All in <name>", a browsing
  // view of the real entry <id>). Cards, breadcrumbs and Back navigate to those URLs; hashchange (S.soft) repaints in place.
  // Opened from Settings ("Manage the equipment catalog") the route carries `from=#/settings` (the same URL-backed `from` the calendar uses), and every
  // catalog URL built below keeps it, so going deeper and coming back to the top still offers "‹ Settings". From the sidebar there is no `from`, so no such link.
  const fromSettings = () => qs().get('from') === '#/settings';
  const hashFor = (id, all) => {
    const q = id ? [`node=${id}`, ...(all ? ['all=1'] : [])] : [];
    if (fromSettings()) q.push(`from=${encodeURIComponent('#/settings')}`);
    return '#/catalog' + (q.length ? '?' + q.join('&') : '');
  };
  main().innerHTML = `<div id="backslot"></div><div class="page-head"><h1 id="pagetitle">Equipment catalog</h1><span id="headact" class="row" style="gap:8px"></span></div>
    <div class="stack">
      <p class="muted small" style="margin:0">What people can request, and how assets are grouped. Open a category to see what is inside it; <strong>Manage</strong> changes its structure. Archive an entry to hide it from new requests without losing history.</p>
      <div class="search">${icon('search')}<input id="cq" type="search" placeholder="Search categories, brands, models, keywords…" enterkeyhint="search" autocomplete="off"></div>
      <label class="check"><input type="checkbox" id="showarch"><span>Show archived entries</span></label>
      <div id="ct"><div class="spinner"></div></div>
    </div>`;
  const byId = (id) => st.rows.find((r) => r.id === id);
  const kids = (id) => st.rows.filter((r) => r.parent_id === id && (st.archived || r.live));
  const countText = (n) => (n ? `${n} asset${n === 1 ? '' : 's'}` : 'No assets');
  const assetRow = (a, node) => {
    const rel = a.catalog_node_id !== node.id && a.catalog_path ? crumbText(a.catalog_path.split(' > ').slice(node.path.split(' > ').length).join(' > ')) : '';
    const extra = [a.model && !a.name.includes(a.model) ? a.model : '', a.location, rel].filter(Boolean).map(esc).join(' · ');
    return `<li><a class="item" href="#/asset/${a.id}${srcQ('catalog', { node: node.id, all: st.all, from: fromSettings() ? '#/settings' : null })}">${thumbHtml(a.thumb, a.category)}<div class="grow" style="min-width:0"><div class="title">${esc(a.name)}</div>
      <div class="sub" style="overflow-wrap:anywhere"><span class="mono">${esc(a.tag)}</span>${extra ? ' · ' + extra : ''}</div></div>${statusPill(a)}${icon('chev', 'chev')}</a></li>`;
  };
  // Search (admin): while there is text in the box the card grid steps aside for a list of matching entries, each with its full path; empty = the grid, unchanged.
  const renderFound = () => {
    const f = st.found;
    $('#pagetitle').textContent = 'Equipment catalog'; $('#backslot').innerHTML = ''; $('#headact').innerHTML = '';
    $('#ct').innerHTML = f === null ? '<div class="spinner"></div>' : f.results.length
      ? `<p class="small muted" style="margin:0 0 8px">${f.total} match${f.total === 1 ? '' : 'es'}${f.total > f.results.length ? ` · showing the first ${f.results.length}, so add a word to narrow it` : ''}</p>
        <div class="card"><ul class="list">${f.results.map((r) => `<li><a class="item" href="${hashFor(r.id)}" data-found="${r.id}"><div class="grow" style="min-width:0"><div class="title">${esc(r.name)}${r.archived ? ' <span class="pill plain">Archived</span>' : ''}</div>
          <div class="sub" style="overflow-wrap:anywhere">${esc(crumbText(r.path))}</div>
          <div class="sub">${r.asset_count ? `${r.asset_count} asset${r.asset_count === 1 ? '' : 's'}` : 'No assets'}${r.search_keywords ? ` · keywords: ${esc(r.search_keywords)}` : ''}${r.via_keyword ? ' · matched by keyword' : ''}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>`
      : `<div class="empty">${icon('tag')}<p>No catalog entry matches that. Try a broader word, a brand or a model.</p></div>`;
  };
  const runSearch = async () => {
    const mine = ++st.searchToken; const q = st.search;
    if (!q) { st.found = null; render(); return; }
    st.found = null; renderFound();
    try { const r = await api('GET', '/api/catalog/search?q=' + encodeURIComponent(q)); if (mine !== st.searchToken) return; st.found = r; } catch (e) { if (mine !== st.searchToken) return; st.found = { total: 0, results: [] }; fail(e); }
    renderFound();
  };
  const render = () => {
    if (st.search) return renderFound();
    const n = byId(st.sel); const ch = n ? kids(n.id) : kids(null);
    const inAll = !!n && st.all && ch.length > 0; // a category with nothing below it has no wider branch to show
    const chain = []; for (let x = n; x; x = byId(x.parent_id)) chain.unshift(x);
    const cards = [];
    if (n && ch.length) cards.push(cgCard({ attrs: 'data-all', name: `All in ${n.name}`, meta: countText(n.asset_count), kind: `all${inAll ? ' on' : ''}`, chev: false }));
    for (const c of ch) cards.push(cgCard({ attrs: `data-select="${c.id}"`, name: c.name, meta: `${countText(c.asset_count)}${c.child_count ? ` · ${c.child_count} ${c.child_count === 1 ? 'subcategory' : 'subcategories'}` : ''}`, kind: c.live ? '' : 'off', extra: c.archived_at ? ' <span class="pill plain">Archived</span>' : !c.live ? ' <span class="pill plain">Hidden</span>' : '' }));
    const list = st.assets;
    const direct = list && n ? list.filter((a) => a.catalog_node_id === n.id) : [];
    let below = '';
    if (n) {
      const shown = inAll ? list : direct;
      const title = inAll ? `All in ${n.name}` : ch.length ? `Filed directly in ${n.name}` : 'Assets';
      below = `<h3 class="ct-h">${esc(title)} <span class="muted">${list ? shown.length : ''}</span></h3>${list === null ? '<div class="spinner"></div>' : shown.length
        ? `${inAll ? `<p class="small muted ct-empty" style="margin-top:0">Every asset filed in ${esc(n.name)} or anywhere below it.</p>` : ''}<div class="card"><ul class="list">${shown.map((a) => assetRow(a, n)).join('')}</ul></div>`
        : `<p class="muted small ct-empty">${inAll ? 'No assets are filed in this branch yet.' : ch.length ? `Nothing is filed directly in ${esc(n.name)}.${list.length ? ` Open <strong>All in ${esc(n.name)}</strong> to see the ${list.length} asset${list.length === 1 ? '' : 's'} in this branch.` : ''}` : 'No assets are filed here yet. Open an asset and choose this entry in its Equipment catalog field.'}</p>`}`;
    }
    // Structural actions always belong to the REAL entry being viewed (also while its virtual "All in" view is open).
    const controls = n ? `<div class="row wrap" style="gap:8px;margin-bottom:12px"><button type="button" class="btn" data-manage="${n.id}">${icon('edit')} Manage</button><button type="button" class="btn primary" data-addsub="${n.id}" ${n.live ? '' : 'disabled'}>${icon('plus')} Add subcategory</button></div>` : '';
    // "Add category" only makes sense at the top; inside a category the contextual button is "+ Add subcategory" above.
    // Back = the app's usual "‹ <where it goes>" link above the title: out of "All in <name>" to the entry, else to the parent (or the root).
    $('#pagetitle').textContent = n ? n.name : 'Equipment catalog'; // the title is the real entry being viewed (stored name, no pluralizing)
    const up = n && !st.all ? byId(n.parent_id) : null;
    $('#backslot').innerHTML = n ? backAnchor(st.all ? hashFor(n.id) : hashFor(up ? up.id : null), st.all ? n.name : up ? up.name : 'Equipment catalog') : fromSettings() ? backAnchor('#/settings', 'Settings') : '';
    $('#headact').innerHTML = `${n ? '' : `<button class="btn primary" id="addroot">${icon('plus')} Add category</button>`}${calendarLink({ node: n ? n.id : null })}`;
    if (!n) $('#addroot').onclick = addRoot;
    $('#ct').innerHTML = `${n ? cgTop(chain, { allLabel: 'All categories', curAll: inAll }) : ''}${n && !n.live ? '<p class="small muted">Not visible to employees.</p>' : ''}${controls}
      ${cards.length ? `<div class="cg" role="group" aria-label="Categories">${cards.join('')}</div>` : n ? '' : `<div class="empty">${icon('tag')}<p>No categories yet. Tap <strong>Add category</strong> to start.</p></div>`}
      ${below}`;
  };
  const loadAssets = async () => {
    const mine = ++st.token; const id = st.sel;
    st.assets = null; render();
    if (!id) return;
    try {
      const list = await api('GET', `/api/assets?catalog_node=${id}`);
      if (mine !== st.token) return;
      st.assets = list.sort((a, b) => String(a.catalog_path || '').localeCompare(String(b.catalog_path || '')) || a.name.localeCompare(b.name));
    } catch (e) { if (mine !== st.token) return; st.assets = []; fail(e); }
    render();
  };
  // Read the URL into state; refetch the asset list only when the viewed entry changed.
  const apply = () => {
    if (!st.rows.length && !st.loaded) return;
    const p = qs(); const id = Number(p.get('node')); const prev = st.sel;
    st.sel = byId(id) ? id : null;
    st.all = !!st.sel && p.get('all') === '1';
    if (p.get('node') && !st.sel) history.replaceState(null, '', hashFor(null)); // unknown/stale node in the URL: fall back to the root
    if (st.sel !== prev || st.assets === null) loadAssets(); else render();
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
        <button type="button" class="btn lg block" data-act="add" ${r.live ? '' : 'disabled'}>${icon('plus')} Add an entry below “${esc(r.name)}”</button>
        <button type="button" class="btn lg block" data-act="rename">${icon('edit')} Rename</button>
        <button type="button" class="btn lg block" data-act="keywords">${icon('search')} Search keywords</button>
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
    const m = e.target.closest('[data-manage]'); if (m) return manage(Number(m.dataset.manage));
    const add = e.target.closest('[data-addsub]'); if (add) return addBelow(byId(Number(add.dataset.addsub)));
    const to = (h) => { go(h); window.scrollTo(0, 0); };
    if (e.target.closest('[data-all]')) return to(hashFor(st.sel, !st.all));
    const sel = e.target.closest('[data-select]'); if (sel) return to(hashFor(Number(sel.dataset.select)));
    const crumb = e.target.closest('[data-crumb]'); if (crumb) { const id = Number(crumb.dataset.crumb); return to(hashFor(id > 0 ? id : null)); }
  };
  $('#backslot').onclick = () => window.scrollTo(0, 0); // (the link itself navigates one step up)
  S.soft = { base: '#/catalog', fn: apply };
  await reload();
}

// ============================================================ profile
// The Profile tab: the signed-in person's own destinations (the personal half of the old "More"). Administration lives in the admin hamburger.
function viewAccount() {
  if (window.matchMedia('(min-width: 900px)').matches) return go('#/profile'); // the desktop sidebar already lists these
  const items = isAdmin() ? [
    ['#/profile', 'user', 'My profile', 'Your details and password'],
  ] : [
    ['#/equipment', 'laptop', 'My equipment', 'What is assigned or checked out to you'],
    ['#/history', 'history', 'History', 'Equipment you have had before'],
    ['#/profile', 'user', 'My profile', 'Your details and password'],
  ];
  main().innerHTML = `<div class="page-head"><h1>Profile</h1></div>
    <div class="card"><ul class="list">${items.map(([h, i, t, sub]) => `<li><a class="item" href="${h}"><div class="thumb">${icon(i)}</div><div class="grow"><div class="title">${t}</div><div class="sub">${sub}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>
    <button class="btn block lg" style="margin-top:16px" id="out">${icon('logout')} Sign out</button>`;
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
  const editable = isAdmin(); // employee profile details are read-only (IT maintains them); admins can edit their own
  const who = `<div class="row"><div class="avatar" style="width:52px;height:52px;font-size:18px;background:var(--brand-accent)">${esc(initials(u.name))}</div><div><strong>${esc(u.email)}</strong><div class="small muted">${u.role === 'admin' ? 'Administrator' : 'Employee'}</div></div></div>`;
  const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v ? esc(v) : '<span class="muted">—</span>'}</div>`).join('')}</div>`;
  const details = editable
    ? `<form class="card pad form-grid" id="p">${who}
      <label class="field"><span>Name</span><input name="name" value="${esc(u.name)}" required></label>
      <div class="form-grid cols"><label class="field"><span>Department</span><input name="department" value="${esc(u.department || '')}"></label><label class="field"><span>Job title</span><input name="title" value="${esc(u.title || '')}"></label></div>
      <label class="field"><span>Phone</span><input name="phone" type="tel" value="${esc(u.phone || '')}"></label>
      ${u.building ? `<div class="small muted">Building: ${esc(u.building)}</div>` : ''}
      <button class="btn primary" id="ps">Save</button></form>`
    : `<div class="card"><div class="card-body">${who}</div>${kv([['Name', u.name], ['Email', u.email], ['Department', u.department], ['Job title', u.title], ['Phone', u.phone], ['Building', u.building]])}
      <div class="card-body small muted" style="border-top:1px solid var(--line)">These details are managed by IT. Ask IT if anything needs changing.</div></div>`;
  main().innerHTML = `<div class="page-head"><h1>My profile</h1></div><div class="stack">
    ${details}
    <form class="card pad form-grid" id="pw"><h2>Change password</h2>
      <label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn" id="pws">Update password</button></form>
    <button class="btn block lg" id="out">${icon('logout')} Sign out</button></div>`;
  if (editable) $('#p').onsubmit = (e) => { e.preventDefault(); busy($('#ps'), async () => { await api('PUT', '/api/me', Object.fromEntries(new FormData(e.target))); await loadMe(); mountShell(); setActive('profile'); toast('Saved'); route(true); }); };
  $('#pw').onsubmit = (e) => { e.preventDefault(); busy($('#pws'), async () => { await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Password updated'); }); };
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
