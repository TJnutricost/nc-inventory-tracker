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
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2800);
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
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
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
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
};
const icon = (n, cls = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${P[n] || P.box}</svg>`;
const CAT_ICON = { Laptop: 'laptop', Desktop: 'desktop', Monitor: 'monitor', 'Keyboard & Mouse': 'keyboard', Headset: 'headphones', 'Dock / Adapter': 'dock', Phone: 'phone', Tablet: 'tablet', 'Printer / Scanner': 'printer', Networking: 'wifi', Appliance: 'plug', 'Software License': 'key' };
const catIcon = (c) => CAT_ICON[c] || (/laptop|notebook/i.test(c) ? 'laptop' : /monitor|display/i.test(c) ? 'monitor' : /license|software/i.test(c) ? 'key' : 'box');
const STATUS_LABEL = { available: 'Available', checked_out: 'Checked out', maintenance: 'In repair', retired: 'Retired', disposed: 'Disposed', lost: 'Lost', overdue: 'Overdue' };
const isPermReq = (r) => r.requested_assignment_type === 'permanent';
const REQ_LABEL = { open: 'Pending', approved: 'Approved', denied: 'Declined', dropped_off: 'Dropped off', completed: 'Done', cancelled: 'Cancelled' };
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

async function handleScannedCode(code) {
  try {
    const r = await api('GET', '/api/assets/lookup/' + encodeURIComponent(code));
    if (r.found) return go('#/asset/' + r.id);
    if (r.unavailable) return toast("That item isn't available right now. You can request something similar from IT.", true);
    if (isAdmin()) {
      const { el, close } = sheet(`<h2>New barcode</h2><p class="muted">No asset uses <strong class="mono">${esc(code)}</strong> yet. Want to tag a new asset with it?</p>
        <div class="stack" style="margin-top:16px"><button class="btn primary lg block" id="mk">${icon('plus')} Add a new asset with this tag</button>
        <button class="btn block" id="again">${icon('scan')} Scan again</button></div>`);
      $('#mk', el).onclick = () => { close(); go('#/new?tag=' + encodeURIComponent(code)); };
      $('#again', el).onclick = () => { close(); openScanner({ onResult: handleScannedCode }); };
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
    { key: 'more', href: '#/more', label: 'More', icon: isAdmin() ? 'more' : 'user' },
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
    { key: 'labels', href: '#/labels', label: 'Print labels', icon: 'printer' },
    { key: 'import', href: '#/import', label: 'Import / export', icon: 'upload' },
    { key: 'activity', href: '#/activity', label: 'Activity log', icon: 'history' },
    { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings' });
  side.push({ sep: true }, { key: 'profile', href: '#/profile', label: 'My profile', icon: 'user' });
  return { tabs: common, side };
}
function mountShell() {
  const { tabs, side } = navItems();
  $('#app').innerHTML = `
    <header class="topbar">
      <a href="#/home" class="row" style="gap:10px"><img src="/logo-white.svg" alt="Nutricost" class="logo"><span class="app-name">IT Assets</span></a>
      <span class="spacer"></span>
      <a href="#/scan" class="iconbtn desk-only" title="Scan">${icon('scan')}</a>
      <div class="menu-wrap"><button type="button" class="avatar sm" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(S.me.name)}" style="background:var(--brand-accent);border:0;cursor:pointer">${esc(initials(S.me.name))}</button>
        <div class="menu" id="avatar-menu" role="menu" hidden><div class="menu-who"><strong>${esc(S.me.name)}</strong><div class="small muted">${esc(S.me.email || '')}</div></div>
          <a href="#/profile" role="menuitem">${icon('user')} My profile</a><button type="button" role="menuitem" id="signout">${icon('logout')} Sign out</button></div></div>
    </header>
    <div class="shell">
      <nav class="sidebar">${side.map((i) => i.sep ? '<div class="sep"></div>' : `<a href="${i.href}" data-key="${i.key}">${icon(i.icon)}<span>${i.label}</span>${i.badge ? `<span class="count">${i.badge}</span>` : ''}</a>`).join('')}</nav>
      <main id="main"></main>
    </div>
    <nav class="tabbar">${tabs.map((t) => `<a href="${t.href}" data-key="${t.key}" class="${t.scan ? 'scan-tab' : ''}">${t.scan ? `<span class="scan-bubble">${icon('scan')}</span>` : icon(t.icon)}<span>${t.label}</span>${t.badge ? `<span class="badge-dot">${t.badge}</span>` : ''}</a>`).join('')}</nav>`;
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
  setTopbarH(); window.addEventListener('resize', setTopbarH);
  const menu = $('#avatar-menu'); const btn = $('#avatar-btn');
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
  menu.onclick = (e) => { if (e.target.closest('a')) setMenu(false); };
  if (!S.menuWired) { // document-level listeners are registered once, however many times the shell is rebuilt
    S.menuWired = true;
    const live = () => ({ m: $('#avatar-menu'), b: $('#avatar-btn') });
    const closeLive = () => { const { m, b } = live(); if (m && !m.hidden) { m.hidden = true; b.setAttribute('aria-expanded', 'false'); } };
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeLive(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLive(); });
  }
  $('#signout').onclick = () => { setMenu(false); logout(); };
  S.shell = true;
}
function setActive(key) {
  $$('.tabbar a, .sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.key === key || (key && a.dataset.key === 'more' && ['people', 'labels', 'import', 'activity', 'settings', 'profile', 'history', 'equipment'].includes(key) && a.closest('.tabbar'))));
}
async function refreshBadge() {
  try {
    const rows = await api('GET', '/api/requests?status=open');
    const n = isAdmin() ? rows.filter((r) => r.status === 'open' || r.status === 'dropped_off').length : rows.filter((r) => r.type === 'return' && r.status === 'open').length;
    S.badge = n;
    const tab = $('.tabbar a[data-key=requests]');
    if (tab) { $('.badge-dot', tab)?.remove(); if (n) tab.insertAdjacentHTML('beforeend', `<span class="badge-dot">${n}</span>`); }
    const side = $('.sidebar a[data-key=requests]');
    if (side) { $('.count', side)?.remove(); if (n) side.insertAdjacentHTML('beforeend', `<span class="count">${n}</span>`); }
  } catch { /* */ }
}
const main = () => $('#main');
const loading = () => { main().innerHTML = '<div class="spinner"></div>'; };
const backLink = (href, label = 'Back') => `<a class="back" href="${href}" onclick="if(history.length>1){history.back();return false}">${icon('back')}${esc(label)}</a>`;

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
  [/^#\/people$/, viewPeople, { key: 'people', admin: true }],
  [/^#\/person\/(\d+)$/, viewPerson, { key: 'people', admin: true }],
  [/^#\/labels$/, viewLabels, { key: 'labels', admin: true }],
  [/^#\/import$/, viewImport, { key: 'import', admin: true }],
  [/^#\/activity$/, viewActivity, { key: 'activity', admin: true }],
  [/^#\/settings$/, viewSettings, { key: 'settings', admin: true }],
  [/^#\/equipment$/, viewEquipment, { key: 'equipment', employee: true }],
  [/^#\/history$/, viewHistory, { key: 'history' }],
  [/^#\/profile$/, viewProfile, { key: 'profile' }],
  [/^#\/more$/, viewMore, { key: 'more' }],
];
async function route(silent) {
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
window.addEventListener('hashchange', () => route());

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
  return `<ul class="list">${mine.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}">${thumbHtml(m.thumb, m.category)}
    <div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub"><span class="mono">${esc(m.tag)}</span> · since ${fmtStamp(m.checked_out_at)} · ${typeText(m)}</div></div>
    ${m.return_status === 'open' ? pill('open', 'Return requested') : m.return_status === 'dropped_off' ? pill('dropped_off', 'Dropped off') : isOverdue(m.due_date) ? pill('overdue', 'Overdue') : ''}
    ${icon('chev', 'chev')}</a></li>`).join('')}</ul>`;
}
function returnBanners(mine) {
  return mine.filter((m) => m.return_status === 'open').map((m) => `
    <div class="banner warn">${icon('alert')}<div class="grow"><strong>IT asked you to return ${esc(m.asset_name)}</strong>
      <div class="small">${m.return_by ? `Please return by ${fmtDate(m.return_by)}. ` : ''}${m.return_message ? esc(m.return_message) : ''}</div>
      <div class="row wrap" style="margin-top:10px"><button class="btn sm dark" data-dropoff="${m.return_request_id}">${icon('check')} I've dropped it off</button><a class="btn sm" href="#/asset/${m.asset_id}">View item</a></div></div></div>`).join('');
}
function wireDropoffs(root) {
  $$('[data-dropoff]', root).forEach((b) => b.onclick = () => busy(b, async () => {
    await api('POST', `/api/requests/${b.dataset.dropoff}/dropped-off`, {});
    toast('Thanks! IT has been notified.'); refreshBadge(); route(true);
  }));
}
async function viewHome() {
  const d = await api('GET', '/api/dashboard');
  const first = S.me.name.split(' ')[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  if (!isAdmin()) {
    main().innerHTML = `<div class="page-head"><h1>${greet}, ${esc(first)}</h1></div>
      <div class="stack">${returnBanners(d.mine)}
      <div class="actions"><a href="#/scan" class="btn primary lg">${icon('scan')} Scan</a><button class="btn lg" id="req">${icon('plus')} Request</button></div>
      <div class="card"><div class="card-head"><h2>My equipment</h2><span class="muted small">${d.mine.length} item${d.mine.length === 1 ? '' : 's'} · <a href="#/equipment">See all</a></span></div>${myEquipmentList(d.mine)}</div>
      ${d.myRequests.length ? `<div class="card"><div class="card-head"><h2>My requests</h2><a href="#/requests" class="small">See all</a></div><ul class="list">${d.myRequests.map((r) => `<li><div class="item"><div class="thumb">${icon('inbox')}</div><div class="grow"><div class="title">${esc(r.category || 'Equipment')}${isPermReq(r) ? ' · Permanent assignment' : ''}</div><div class="sub truncate">${esc(r.message || '')} · ${fmtWhen(r.created_at)}</div></div>${pill(r.status, REQ_LABEL[r.status])}</div></li>`).join('')}</ul></div>` : ''}
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
    ${returnBanners(d.mine)}
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
          ${d.openRequests.map((r) => `<li><a class="item" href="${r.asset_id && r.type === 'return' ? '#/asset/' + r.asset_id : '#/requests'}"><div class="thumb">${icon(r.type === 'return' ? 'in' : 'inbox')}</div>
            <div class="grow"><div class="title truncate">${r.type === 'return' ? `Return: ${esc(r.asset_name || '')}` : isPermReq(r) ? `${esc(r.user_name)} requests permanent ${esc(r.asset_name || r.category || 'equipment')}` : `${esc(r.user_name)} needs ${esc(r.category || 'equipment')}`}</div>
            <div class="sub truncate">${r.type === 'return' ? esc(r.user_name) + ' · ' : ''}${fmtWhen(r.created_at)}${r.message ? ' · ' + esc(r.message) : ''}</div></div>${pill(r.status, REQ_LABEL[r.status])}</a></li>`).join('')}
          ${d.overdue.map((o) => `<li><a class="item" href="#/asset/${o.asset_id}"><div class="thumb" style="color:var(--bad)">${icon('alert')}</div>
            <div class="grow"><div class="title truncate">${esc(o.asset_name)}</div><div class="sub">${esc(o.user_name)} · due ${fmtDate(o.due_date)}</div></div>${pill('overdue', 'Overdue')}</a></li>`).join('')}
        </ul>` : `<div class="empty">${icon('check')}<p>All caught up.</p></div>`}
      </div>
      <div class="card"><div class="card-head"><h2>By category</h2><span class="muted small">${s.users} people</span></div>
        <div style="padding:8px 0">${d.byCategory.length ? d.byCategory.map((c) => `<a class="cat-row" href="#/assets?category=${encodeURIComponent(c.category)}" style="color:inherit"><span class="truncate">${esc(c.category)}</span><strong style="text-align:right">${c.n}</strong><div class="bar"><i style="width:${(c.n / maxCat) * 100}%"></i></div></a>`).join('') : `<div class="empty"><p>No assets yet. <a href="#/new">Add your first one</a> or <a href="#/import">import a spreadsheet</a>.</p></div>`}</div>
        ${s.value ? `<div class="card-body small muted" style="border-top:1px solid var(--line)">Total purchase value: <strong style="color:var(--text)">${money(s.value)}</strong></div>` : ''}
      </div>
    </div>
    ${d.expiring.length ? `<div class="card"><div class="card-head"><h2>Expiring in 60 days</h2></div><ul class="list">${d.expiring.map((a) => `<li><a class="item" href="#/asset/${a.id}"><div class="thumb">${icon(catIcon(a.category))}</div><div class="grow"><div class="title truncate">${esc(a.name)}</div><div class="sub">${a.license_expires ? `License expires ${fmtDate(a.license_expires)}` : ''}${a.license_expires && a.warranty_expires ? ' · ' : ''}${a.warranty_expires ? `Warranty ends ${fmtDate(a.warranty_expires)}` : ''}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>` : ''}
    ${d.mine.length ? `<div class="card"><div class="card-head"><h2>My equipment</h2></div>${myEquipmentList(d.mine)}</div>` : ''}
    <div class="card"><div class="card-head"><h2>Recent activity</h2><a href="#/activity" class="small">See all</a></div>${activityList(d.activity, true)}</div>
    </div>`;
  wireDropoffs(main());
}
const ACTION_LABEL = { created: 'Added', edited: 'Edited', checked_out: 'Checked out', checked_in: 'Checked in', return_requested: 'Return requested', dropped_off: 'Dropped off', photo_added: 'Photo added', archived: 'Archived', requested: 'Requested' };
function activityList(rows, withAsset) {
  if (!rows.length) return `<div class="empty"><p>No activity yet.</p></div>`;
  return `<ul class="timeline">${rows.map((r) => `<li><span class="dot"></span><div class="grow"><div><strong>${esc(ACTION_LABEL[r.action] || r.action)}</strong>${withAsset && r.asset_id ? ` · <a href="#/asset/${r.asset_id}">${esc(r.asset_name || '')} <span class="mono small">${esc(r.tag || '')}</span></a>` : ''}</div>
    <div class="small muted">${esc(r.details || '')}</div><div class="small muted">${esc(r.actor_name || 'System')} · ${fmtWhen(r.created_at)}</div></div></li>`).join('')}</ul>`;
}

// ============================================================ assets list
async function viewAssets() {
  const p = qs();
  const state = { q: p.get('q') || '', status: p.get('status') || '', category: p.get('category') || '' };
  const statuses = isAdmin()
    ? [['', 'All'], ['available', 'Available'], ['checked_out', 'Checked out'], ['overdue', 'Overdue'], ['maintenance', 'In repair'], ['lost', 'Lost'], ['retired', 'Retired'], ['disposed', 'Disposed']]
    : null; // employees have no status filters: Browse is simply the equipment they can get (their own is under My equipment)
  main().innerHTML = `<div class="page-head"><h1>${isAdmin() ? 'Assets' : 'Browse equipment'}</h1>${isAdmin() ? `<a href="#/new" class="btn primary desk-only">${icon('plus')} Add asset</a>` : ''}</div>
    <div class="stack">
      <div class="row"><div class="search grow">${icon('search')}<input id="q" type="search" placeholder="${isAdmin() ? 'Search name, tag, serial, person…' : 'Search name, tag, serial…'}" value="${esc(state.q)}" enterkeyhint="search"></div>
        <button class="btn" id="scanbtn" title="Scan">${icon('scan')}</button></div>
      ${statuses ? `<div class="row" style="gap:8px"><div class="chips grow" id="chips">${statuses.map(([v, l]) => `<button class="chip ${state.status === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>` : '<p class="small muted" style="margin:0">Equipment that is available to check out or request.</p>'}
      <select id="cat"><option value="">All categories</option>${S.settings.categories.map((c) => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
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
        return `<li><a class="item" href="#/asset/${a.id}">${thumbHtml(a.thumb, a.category)}
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

// ============================================================ asset detail
async function viewAsset(id) {
  const d = await api('GET', '/api/assets/' + id);
  const a = d.asset;
  const admin = isAdmin();
  const st = !['retired', 'lost', 'disposed'].includes(a.status) && d.holders.some((h) => isOverdue(h.due_date)) ? 'overdue' : a.status;
  const canPhoto = admin || d.is_mine;
  const multi = d.capacity > 1;
  const seatsFree = d.capacity - d.seats_used;
  const myReturnReq = d.requests.find((r) => r.type === 'return' && r.user_id === S.me.id && r.status === 'open');
  const cover = d.photos.find((p) => p.id === a.cover_photo_id) || d.photos[0];
  const photos = cover ? [cover, ...d.photos.filter((p) => p !== cover)] : [];

  // ---- action buttons
  let actions = '';
  if (a.archived_at) {
    actions = `<div class="banner info">${icon('box')}<div class="grow"><strong>This asset is archived.</strong> Its history is kept and its tag stays reserved.</div></div>`;
  } else if (admin) {
    const btns = [];
    if (['available', 'checked_out'].includes(a.status) && seatsFree > 0) btns.push(`<button class="btn primary lg" id="act-out">${icon('out')} Check out${multi ? ' a seat' : ''}</button>`);
    if (d.holders.length) btns.push(`<button class="btn ${seatsFree > 0 ? '' : 'primary'} lg" id="act-in">${icon('in')} Check in</button>`);
    if (d.holders.length) btns.push(`<button class="btn lg" id="act-ret">${icon('send')} Request return</button>`);
    btns.push(`<a class="btn lg" href="#/asset/${a.id}/edit">${icon('edit')} Edit</a>`);
    btns.push(`<a class="btn lg" href="#/labels?ids=${a.id}">${icon('printer')} Print label</a>`);
    if (btns.length % 2) btns[btns.length - 1] = btns[btns.length - 1].replace('class="btn', 'class="full btn');
    actions = `<div class="actions">${btns.join('')}</div>`;
  } else {
    if (d.is_mine) {
      actions = myReturnReq
        ? `<div class="banner warn">${icon('alert')}<div class="grow"><strong>IT asked you to return this${myReturnReq.needed_by ? ` by ${fmtDate(myReturnReq.needed_by)}` : ''}.</strong>${myReturnReq.message ? `<div class="small">${esc(myReturnReq.message)}</div>` : ''}
           <button class="btn dark sm" style="margin-top:10px" data-dropoff="${myReturnReq.id}">${icon('check')} I've dropped it off</button></div></div>`
        : d.requests.some((r) => r.type === 'return' && r.status === 'dropped_off' && r.user_id === S.me.id)
          ? `<div class="banner info">${icon('check')}<div>You've told IT you dropped this off. It'll come off your list once IT checks it in.</div></div>`
          : `<button class="btn lg block" id="act-return">${icon('in')} I'm returning this</button>`;
    } else if (a.status === 'available' && seatsFree > 0) {
      actions = S.me.can_self_checkout
        ? `<button class="btn primary lg block" id="act-self">${icon('out')} Check out to me</button>`
        : `<button class="btn primary lg block" id="act-request">${icon('inbox')} Request this</button>`;
    } else if (d.held_by_other || a.status !== 'available') {
      actions = `<div class="banner info">${icon('box')}<div class="grow">This item isn't available right now. <a href="#" id="act-similar">Request something similar</a></div></div>`;
    }
  }

  const kv = [
    ['Category', a.category], ['Brand', a.brand], ['Model', a.model], ['Serial #', a.serial ? `<span class="mono">${esc(a.serial)}</span>` : '', true],
    ['Condition', a.condition], ['Location', a.location], ['Purchased', fmtDate(a.purchase_date)], ['Cost', admin ? money(a.purchase_cost) : ''],
    ['Vendor', admin ? a.vendor : ''], ['Warranty ends', a.warranty_expires ? `${fmtDate(a.warranty_expires)}${a.warranty_expires < localToday() ? ' <span class="pill lost plain">Expired</span>' : ''}` : '', true],
  ].filter(([, v]) => v);

  main().innerHTML = `<div class="asset-bar">${backLink('#/assets', 'Assets')}
      <div class="asset-id"><h1 class="truncate">${esc(a.name)}</h1><span class="mono muted">${esc(a.tag)}</span>${st === 'overdue' ? pill('overdue') : statusPill(a)}${multi ? `<span class="pill plain">${d.seats_used}/${d.capacity} seats</span>` : ''}</div></div>
    <div class="stack">
      ${photos.length ? `<div class="gallery">${photos.map((p, i) => `<div class="ph" data-ph="${p.id}"><img src="/uploads/${esc(p.thumb)}" data-full="/uploads/${esc(p.filename)}" alt="Photo of ${esc(a.name)}" loading="lazy">${i === 0 && photos.length > 1 ? '<span class="star">Cover</span>' : ''}</div>`).join('')}
        ${canPhoto ? `<label class="add-ph">${icon('camera')}<span>Add photo</span><input type="file" accept="image/*" multiple hidden id="ph-in"></label>` : ''}</div>`
        : canPhoto ? `<label class="no-photo"><div>${icon('camera')}<strong>Add a photo</strong><div class="small">Snap the device, its label, or any damage</div></div><input type="file" accept="image/*" multiple hidden id="ph-in"></label>` : ''}
      ${actions}
      ${d.holders.length ? `<div class="card"><div class="card-head"><h2>${multi ? 'Assigned to' : d.holders.every((h) => h.assignment_type === 'checkout') ? (admin ? 'Temporarily checked out to' : 'Temporarily checked out to you') : (admin ? 'Assigned to' : 'Assigned to you')}</h2></div><ul class="list">${d.holders.map((h) => `<li><div class="item">
          <div class="avatar">${esc(initials(h.user_name))}</div>
          <div class="grow">${admin ? `<a href="#/person/${h.employee_id}" class="title">${esc(h.user_name)}</a>` : `<div class="title">${esc(h.user_name)}</div>`}
          <div class="sub">${typeText(h)} · since ${fmtStamp(h.checked_out_at)}${h.user_department ? ` · ${esc(h.user_department)}` : ''}</div></div>
          ${isOverdue(h.due_date) ? pill('overdue', 'Overdue') : ''}
          ${admin && multi ? `<button class="btn sm" data-in="${h.id}">Check in</button>` : ''}</div></li>`).join('')}</ul></div>` : ''}
      ${d.requests.length && admin ? `<div class="card"><div class="card-head"><h2>Open requests</h2></div><ul class="list">${d.requests.map((r) => `<li><div class="item"><div class="thumb">${icon(r.type === 'return' ? 'in' : 'inbox')}</div><div class="grow"><div class="title">${r.type === 'return' ? 'Return from ' : isPermReq(r) ? 'Permanent assignment requested by ' : 'Requested by '}${esc(r.user_name)}</div><div class="sub">${fmtWhen(r.created_at)}${r.needed_by ? ' · by ' + fmtDate(r.needed_by) : ''}${r.message ? ' · ' + esc(r.message) : ''}</div></div>${pill(r.status, REQ_LABEL[r.status])}</div></li>`).join('')}</ul></div>` : ''}
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
  on('#act-request', () => requestEquipmentSheet({ asset: a }));
  on('#act-similar', (e) => { e.preventDefault(); requestEquipmentSheet({ category: a.category }); });
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
async function requestPermanentAssignment(asset, message) {
  const ok = await confirmSheet('Permanent assignment requires approval', 'Permanent equipment assignments must be approved by IT.', 'Send request');
  if (!ok) return false;
  await api('POST', '/api/requests', { asset_id: asset.id, category: asset.category, message: message || undefined, requested_assignment_type: 'permanent' });
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
  const back = () => (location.hash === `#/asset/${a.id}` ? route(true) : go('#/asset/' + a.id));
  const { el, close } = sheet(`<h2>Check this out to you?</h2><p class="muted small" style="margin-top:0">${esc(a.name)} (${esc(a.tag)}). IT will be notified.</p>
    <button type="button" class="btn sm" id="self-scan" style="margin-bottom:12px">${icon('scan')} Scan barcode</button>
    <form class="form-grid" id="f">
    <div class="field"><span>How long do you need it?</span><div class="chips" data-self-type><button type="button" class="chip on" data-t="checkout">Temporary checkout</button><button type="button" class="chip" data-t="permanent">Permanent</button></div>
      <div class="small muted" data-self-hint style="margin-top:6px">Borrow it and bring it back by the return date.</div></div>
    <div data-self-due class="form-grid">${returnFields()}</div>
    <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Check out to me</button></div></form>`);
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
    $('#go', el).textContent = mode === 'checkout' ? 'Check out to me' : 'Request permanent assignment';
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
function requestEquipmentSheet({ asset, category, forUser } = {}) {
  const { el, close } = sheet(`<h2>${asset ? 'Request this item' : 'Request equipment'}</h2><p class="muted small" style="margin-top:0">IT will get an email and follow up with you.</p>
    <form class="form-grid" id="f">
      ${asset ? `<input type="hidden" name="asset_id" value="${asset.id}"><input type="hidden" name="category" value="${esc(asset.category)}"><div class="holder">${icon(catIcon(asset.category))}<div><strong>${esc(asset.name)}</strong><div class="small muted mono">${esc(asset.tag)}</div></div></div>`
        : `<label class="field"><span>What do you need?</span><select name="category" required><option value="">Choose…</option>${S.settings.categories.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`}
      <label class="field"><span>Details</span><textarea name="message" placeholder="${asset ? 'Anything IT should know?' : 'e.g. Second monitor for my desk, USB-C if possible'}"></textarea></label>
      <label class="field"><span>Needed by (optional)</span><input type="date" name="needed_by" min="${localToday()}"></label>
      ${asset && !forUser ? `<label class="check"><input type="checkbox" name="permanent"><span>I need this <strong>permanently</strong> (IT approves permanent assignments)</span></label>` : ''}
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
async function assetPickerSheet({ title, filterCategory, onPick }) {
  const { el, close } = sheet(`<h2>${esc(title)}</h2>
    <div class="row" style="margin:12px 0 0"><div class="search grow">${icon('search')}<input id="ap-q" placeholder="Search available assets" autocomplete="off"></div><button class="btn" id="ap-scan" type="button">${icon('scan')}</button></div>
    <div class="picker-list" id="ap-list"><div class="spinner"></div></div>
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button></div>`);
  const load = async (q = '') => {
    const u = new URLSearchParams({ status: 'available' }); if (q) u.set('q', q); else if (filterCategory) u.set('category', filterCategory);
    let rows = await api('GET', '/api/assets?' + u);
    if (!rows.length && filterCategory && !q) rows = await api('GET', '/api/assets?status=available');
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
  const cats = S.settings.categories.includes(a.category) ? S.settings.categories : [...S.settings.categories, a.category];
  const f = (name, label, attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(a[name] ?? '')}" ${attrs}></label>`;
  main().innerHTML = `${backLink(editing ? '#/asset/' + id : '#/assets', 'Cancel')}
    <div class="page-head"><h1>${editing ? 'Edit asset' : 'Add an asset'}</h1></div>
    <form id="f" class="stack" autocomplete="off">
      <div class="card pad"><fieldset class="form-grid cols"><legend>The basics</legend>
        <label class="field full"><span>Name *</span><input name="name" required value="${esc(a.name || '')}" placeholder="e.g. Dell Latitude 7440"></label>
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
      <div class="card pad"><label class="field"><span>Notes (admins only)</span><textarea name="notes">${esc(a.notes || '')}</textarea></label></div>
      <button class="btn primary lg block" id="save">${editing ? 'Save changes' : 'Add asset'}</button>
    </form>`;
  const catSel = $('#cat');
  const toggleLic = () => { const show = catSel.value === 'Software License' || /license|software|subscription/i.test(catSel.value) || a.license_key || a.license_seats; $('#lic').classList.toggle('hidden', !show); };
  catSel.onchange = toggleLic; toggleLic();
  $$('[data-scan]').forEach((b) => b.onclick = () => openScanner({ title: b.dataset.scan === 'tag' ? 'Scan asset tag' : 'Scan serial number', onResult: (code) => { $(`[name=${b.dataset.scan}]`).value = code; toast('Scanned ' + code); } }));
  const ph = $('#ph'); if (ph) ph.onchange = () => { $('#ph-label').textContent = ph.files.length ? `${ph.files.length} photo${ph.files.length > 1 ? 's' : ''} selected` : 'Take or choose photos'; };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {}; for (const [k, v] of fd.entries()) if (k !== 'photos') body[k] = v;
    busy($('#save'), async () => {
      const saved = await api(editing ? 'PUT' : 'POST', editing ? '/api/assets/' + id : '/api/assets', body);
      if (ph && ph.files.length) await uploadPhotos(saved.id, ph.files);
      toast(editing ? 'Saved' : `Added ${saved.tag}`);
      if (!editing) history.replaceState(null, '', '#/assets');
      go('#/asset/' + saved.id);
    });
  };
}

// ============================================================ scan
function viewScan() {
  main().innerHTML = `<div class="page-head"><h1>Scan</h1></div>
    <div class="stack">
      <button class="card pad" id="go" style="width:100%;border:0;cursor:pointer;text-align:center;padding:36px 16px;background:var(--brand-ink);color:#fff">
        <div style="width:72px;height:72px;margin:0 auto 12px;border-radius:50%;background:var(--brand-accent);display:grid;place-items:center">${icon('scan').replace('<svg', '<svg style="width:34px;height:34px"')}</div>
        <div style="font-size:18px;font-weight:700">Tap to scan a barcode</div><div class="small" style="opacity:.7;margin-top:4px">Asset tags, serial numbers and QR codes</div></button>
      <div class="card pad"><form id="m" class="stack"><label class="field"><span>Have a handheld scanner or want to type it?</span>
        <div class="input-group"><input id="code" placeholder="Scan or type a tag / serial" autocomplete="off" autocapitalize="characters" enterkeyhint="go" class="mono"><button class="btn primary">Find</button></div></label></form></div>
      <p class="small muted" style="text-align:center">${isAdmin() ? 'Scanning a barcode that isn’t in the system yet lets you tag a new asset with it.' : 'Scan any tagged item to see it, check it out or request it.'}</p>
    </div>`;
  $('#go').onclick = () => openScanner({ onResult: handleScannedCode });
  $('#m').onsubmit = (e) => { e.preventDefault(); const v = $('#code').value.trim(); if (v) handleScannedCode(v); };
  if (window.matchMedia('(min-width: 900px)').matches) $('#code').focus();
  else if (!S.silent && !$('.scanner')) openScanner({ onResult: handleScannedCode }); // phones: jump straight into the camera
}

// ============================================================ requests
async function viewRequests() {
  const state = { tab: qs().get('tab') || 'open' };
  main().innerHTML = `<div class="page-head"><h1>Requests</h1><button class="btn primary" id="new">${icon('plus')} ${isAdmin() ? 'New' : 'Request equipment'}</button></div>
    <div class="stack"><div class="seg" id="seg"><button data-v="open">Open</button><button data-v="closed">Closed</button></div><div id="list"><div class="spinner"></div></div></div>`;
  $('#new').onclick = async () => {
    if (!isAdmin()) return requestEquipmentSheet();
    const { el, close } = sheet(`<h2>New request</h2><div class="stack" style="margin-top:14px">
      <button class="btn lg block" id="n1">${icon('inbox')} Log an equipment request for someone</button>
      <button class="btn lg block" id="n2">${icon('send')} Ask someone to return an item</button></div>`);
    $('#n1', el).onclick = async () => { close(); const users = await getUsers(); const s = sheet(`<h2>Who is it for?</h2><div id="pp" style="margin-top:12px"></div>`); personPicker($('#pp', s.el), users, (u) => { s.close(); requestEquipmentSheet({ forUser: u }); }); };
    $('#n2', el).onclick = () => { close(); go('#/assets?status=checked_out'); toast('Open the item and tap “Request return”'); };
  };
  const render = async () => {
    $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.tab));
    const rows = await api('GET', '/api/requests?status=' + state.tab);
    const list = $('#list'); if (!list) return;
    if (!rows.length) { list.innerHTML = `<div class="card"><div class="empty">${icon('inbox')}<p>${state.tab === 'open' ? 'No open requests.' : 'Nothing here yet.'}</p></div></div>`; return; }
    const find = (id) => rows.find((r) => r.id === Number(id));
    const kindOf = (r) => (r.type === 'return' ? 'Return request' : isPermReq(r) ? 'Permanent assignment request' : 'Equipment request');
    const titleOf = (r) => (r.type === 'return' ? `Return ${esc(r.asset_name || 'item')}` : isPermReq(r) ? `Permanent assignment request — ${esc(r.asset_name || r.category || 'equipment')}` : `${esc(r.category || 'Equipment')}${r.asset_name ? ` — ${esc(r.asset_name)}` : ''}`);
    // The action buttons a request offers; used by both the list card and the detail sheet (wired by wireActions).
    const actionsFor = (r) => {
      const isRet = r.type === 'return'; const perm = isPermReq(r);
      if (!['open', 'approved', 'dropped_off'].includes(r.status)) return '';
      if (isAdmin() && perm && r.asset_id) return `<button class="btn sm primary" data-approve-perm="${r.id}">${icon('check')} Approve & assign permanently</button><button class="btn sm danger" data-deny="${r.id}">Decline</button>`;
      if (isAdmin() && !isRet) return `<button class="btn sm primary" data-fulfill="${r.id}">${icon('out')} Assign an asset</button>${r.status === 'open' ? `<button class="btn sm" data-approve="${r.id}">Approve</button>` : ''}<button class="btn sm danger" data-deny="${r.id}">Decline</button>`;
      if (isAdmin() && isRet) return `${r.asset_id ? `<a class="btn sm primary" href="#/asset/${r.asset_id}">${icon('in')} Check in</a>` : ''}<button class="btn sm" data-cancel="${r.id}">Cancel request</button>`;
      if (!isRet) return `<button class="btn sm" data-cancel="${r.id}">Cancel</button>`;
      if (r.status === 'open') return `<button class="btn sm dark" data-dropoff="${r.id}">${icon('check')} I've dropped it off</button>`;
      return '';
    };
    // `before` runs first (the detail sheet closes itself so the action's own sheet isn't stacked on it).
    const wireActions = (root, before) => {
      const on = (sel, attr, fn) => $$(sel, root).forEach((b) => b.onclick = (e) => { before && before(); fn(find(b.dataset[attr]), e.currentTarget); });
      on('[data-fulfill]', 'fulfill', (r) => assetPickerSheet({ title: `Assign to ${r.user_name}`, filterCategory: r.category, onPick: (assetId) => {
        const { el, close } = sheet(`<h2>Assign & check out</h2><p class="muted small" style="margin-top:0">${esc(r.user_name)} will get an email with the details.</p>
          <form class="form-grid" id="f">${assignTypeFields()}<label class="field"><span>Note to ${esc(r.user_name.split(' ')[0])} (optional)</span><input name="note" placeholder="e.g. Pick it up at the IT room"></label>
          <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="go">Check out</button></div></form>`);
        wireAssignType(el);
        $('#f', el).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
          busy($('#go', el), async () => { await api('POST', `/api/requests/${r.id}/approve`, { asset_id: assetId, assignment_type: fd.assignment_type, due_date: fd.due_date, due_time: fd.due_time, note: fd.note }); close(); toast('Assigned and checked out'); refreshBadge(); render(); }); };
      } }));
      on('[data-approve-perm]', 'approvePerm', (r) => noteSheet('Approve permanent assignment', `${r.asset_name || 'This item'} will be permanently assigned to ${r.user_name}. Add a note for them (optional).`, 'Approve & assign', 'e.g. Pick it up at the IT room',
        async (note) => { await api('POST', `/api/requests/${r.id}/approve`, { asset_id: r.asset_id, assignment_type: 'permanent', note }); toast('Permanently assigned'); refreshBadge(); render(); }));
      on('[data-approve]', 'approve', (r) => noteSheet('Approve request', 'Let them know what happens next (optional).', 'Approve', 'e.g. Ordered — should arrive next week', async (note) => { await api('POST', `/api/requests/${r.id}/approve`, { note }); toast('Approved — they’ve been emailed'); refreshBadge(); render(); }));
      on('[data-deny]', 'deny', (r) => noteSheet('Decline request', 'Add a short reason (optional). They’ll get an email.', 'Decline', 'e.g. Please talk to your manager first', async (note) => { await api('POST', `/api/requests/${r.id}/deny`, { note }); toast('Declined'); refreshBadge(); render(); }, true));
      on('[data-cancel]', 'cancel', (r, btn) => busy(btn, async () => { await api('POST', `/api/requests/${r.id}/cancel`, {}); toast('Cancelled'); refreshBadge(); render(); }));
      on('[data-dropoff]', 'dropoff', (r, btn) => busy(btn, async () => { await api('POST', `/api/requests/${r.id}/dropped-off`, {}); toast('Thanks! IT has been notified.'); refreshBadge(); render(); }));
    };
    // Full read-only view of a request (notes included) with the same actions, so IT can read before approving or declining.
    const openDetail = (r) => {
      const row = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
      const { el, close } = sheet(`<h2>${esc(kindOf(r))}</h2>
        <div class="row wrap" style="gap:8px;margin:2px 0 12px">${pill(r.status, REQ_LABEL[r.status])}${isPermReq(r) ? '<span class="pill plain available">Permanent assignment</span>' : ''}</div>
        <div class="kv">
          ${row('Requested by', `${isAdmin() ? `<a href="#/person/${r.user_id}" data-x>${esc(r.user_name)}</a>` : esc(r.user_name)}${r.user_department ? ' · ' + esc(r.user_department) : ''}`)}
          ${row('Asset', r.asset_id ? `${isAdmin() ? `<a href="#/asset/${r.asset_id}" data-x>${esc(r.asset_name || '')}</a>` : esc(r.asset_name || '')} <span class="mono small muted">${esc(r.asset_tag || '')}</span>` : '')}
          ${row('Category', esc(r.category || ''))}
          ${row(r.type === 'return' ? 'Return by' : 'Needed by', r.needed_by ? fmtDate(r.needed_by) : '')}
          ${row('Submitted', esc(fmtStamp(r.created_at)))}
          ${row('Notes', r.message ? `<div style="white-space:pre-wrap">${esc(r.message)}</div>` : '<span class="muted">No notes were added.</span>')}
          ${row('IT note', r.resolution_note ? `<div style="white-space:pre-wrap">${esc(r.resolution_note)}</div>` : '')}
          ${row('Resolved', r.resolved_by_name && !['open', 'dropped_off'].includes(r.status) ? `${esc(REQ_LABEL[r.status])} by ${esc(r.resolved_by_name)} · ${esc(fmtStamp(r.resolved_at))}` : '')}
        </div>
        <div class="row wrap" id="d-actions" style="margin-top:14px;gap:8px">${actionsFor(r)}</div>
        <div class="sheet-actions"><button type="button" class="btn" data-close>Close</button></div>`);
      $$('[data-x]', el).forEach((a) => a.addEventListener('click', () => close()));
      wireActions($('#d-actions', el), close);
    };
    list.innerHTML = `<div class="stack">${rows.map((r) => {
      const isRet = r.type === 'return';
      const btns = actionsFor(r);
      return `<div class="card"><div class="item" data-detail="${r.id}" tabindex="0" style="align-items:flex-start;cursor:pointer">
        <div class="thumb">${icon(isRet ? 'in' : 'inbox')}</div>
        <div class="grow"><div class="row spread" style="align-items:flex-start"><div class="title">${titleOf(r)}</div>${pill(r.status, REQ_LABEL[r.status])}</div>
          <div class="sub">${isAdmin() ? `<a href="#/person/${r.user_id}">${esc(r.user_name)}</a>${r.user_department ? ' · ' + esc(r.user_department) : ''} · ` : ''}${fmtWhen(r.created_at)}${r.needed_by ? ` · ${isRet ? 'return' : 'needed'} by ${fmtDate(r.needed_by)}` : ''}${r.asset_tag ? ` · <a class="mono" href="#/asset/${r.asset_id}">${esc(r.asset_tag)}</a>` : ''}</div>
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
  $('#seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.v; history.replaceState(null, '', '#/requests?tab=' + state.tab); render().catch(fail); };
  render();
}
function noteSheet(title, text, okLabel, placeholder, onOk, danger) {
  const { el, close } = sheet(`<h2>${esc(title)}</h2><p class="muted small" style="margin-top:0">${esc(text)}</p>
    <form id="f"><textarea name="note" placeholder="${esc(placeholder)}"></textarea><div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="go">${esc(okLabel)}</button></div></form>`);
  $('#f', el).onsubmit = (e) => { e.preventDefault(); busy($('#go', el), async () => { await onOk(e.target.note.value.trim()); close(); }); };
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
    <div class="card">${d.current.length ? `<ul class="list">${d.current.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}">${thumbHtml(m.thumb, m.category)}<div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub"><span class="mono">${esc(m.tag)}</span> · ${typeText(m)} · since ${fmtStamp(m.checked_out_at)}</div></div>${isOverdue(m.due_date) ? pill('overdue', 'Overdue') : ''}${icon('chev', 'chev')}</a></li>`).join('')}</ul>` : `<div class="empty"><p>Nothing checked out.</p></div>`}
      ${u.active ? `<div class="card-body" style="border-top:1px solid var(--line)"><button class="btn block" id="give">${icon('out')} Check out something to ${esc(u.name.split(' ')[0])}</button></div>` : ''}</div>
    ${d.past.length ? `<div class="section-title">Past equipment</div><div class="card"><ul class="list">${d.past.map((m) => `<li><a class="item" href="#/asset/${m.asset_id}" style="min-height:0"><div class="grow"><div class="title truncate">${esc(m.asset_name)} <span class="mono small muted">${esc(m.tag)}</span></div><div class="sub">${typeText(m)} · ${fmtDate(m.checked_out_at)} → ${fmtDate(m.returned_at)}${m.condition_in ? ` · returned ${esc(m.condition_in)}` : ''}</div></div></a></li>`).join('')}</ul></div>` : ''}`;
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
  main().innerHTML = `<div class="page-head"><h1>Activity log</h1></div><div class="card">${activityList(rows, true)}</div>`;
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
      <div class="card pad"><div class="form-grid cols">
        <label class="field"><span>Categories (one per line)</span><textarea name="categories" rows="8">${esc(s.categories.join('\n'))}</textarea></label>
        <label class="field"><span>Locations (one per line)</span><textarea name="locations" rows="8">${esc(s.locations.join('\n'))}</textarea></label></div></div>
      <button class="btn primary lg block" id="save">Save settings</button>
    </form>
    <div class="section-title">Email notifications</div>
    <div class="card pad stack">
      ${s.mailConfigured ? `<div class="banner info">${icon('check')}<div>Sending from <strong>${esc(s.mailFrom)}</strong> via Gmail / Google Workspace.</div></div>`
        : `<div class="banner warn">${icon('alert')}<div><strong>Not configured.</strong> Emails are saved in the outbox below but not sent. Add your Google Workspace SMTP settings to the server's <span class="mono">.env</span> file (see README) and restart.</div></div>`}
      <div class="small muted">Links in emails point to <span class="mono">${esc(s.appUrl)}</span> (set with <span class="mono">APP_URL</span>).</div>
      <button class="btn" id="test">${icon('mail')} Send me a test email</button>
    </div>
    <div class="card" style="margin-top:12px"><div class="card-head"><h2>Outbox</h2><span class="small muted">Last 100</span></div>
      ${outbox.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>${outbox.map((o) => `<tr><td class="small muted" style="white-space:nowrap">${fmtWhen(o.created_at)}</td><td class="small">${esc(o.to_addr)}</td><td>${esc(o.subject)}</td><td>${o.status === 'sent' ? pill('available', 'Sent') : o.status === 'failed' ? `<span title="${esc(o.error || '')}">${pill('lost', 'Failed')}</span>` : pill('retired', 'Not sent')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><p>No emails yet.</p></div>`}
    </div>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { overdue_reminders: fd.has('overdue_reminders'), default_loan_days: fd.get('default_loan_days'), tag_prefix: fd.get('tag_prefix'),
      categories: fd.get('categories').split('\n'), locations: fd.get('locations').split('\n') };
    busy($('#save'), async () => { S.settings = await api('PUT', '/api/settings', body); toast('Settings saved'); });
  };
  $('#test').onclick = (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', '/api/settings/test-email', {});
    if (r.status === 'sent') toast(`Test email sent to ${S.me.email}`); else if (r.status === 'failed') toast('Failed: ' + r.error, true); else toast('Email is not configured — saved to outbox', true);
    route(true);
  });
}

// ============================================================ profile / more
function viewMore() {
  if (window.matchMedia('(min-width: 900px)').matches && !isAdmin()) return go('#/profile');
  const items = isAdmin() ? [
    ['#/people', 'users', 'People', 'Add employees, set admins, see who has what'],
    ['#/labels', 'printer', 'Print labels', 'Barcode stickers for your asset tags'],
    ['#/import', 'upload', 'Import / export', 'Bulk add from a spreadsheet, download CSV'],
    ['#/activity', 'history', 'Activity log', 'Every check-out, check-in and change'],
    ['#/settings', 'settings', 'Settings', 'Check-out rules, categories, email'],
    ['#/profile', 'user', 'My profile', 'Your details and password'],
  ] : [
    ['#/equipment', 'laptop', 'My equipment', 'What is assigned or checked out to you'],
    ['#/history', 'history', 'History', 'Equipment you have had before'],
    ['#/profile', 'user', 'My profile', 'Your details and password'],
  ];
  main().innerHTML = `<div class="page-head"><h1>${isAdmin() ? 'More' : 'Account'}</h1></div>
    <div class="card"><ul class="list">${items.map(([h, i, t, s]) => `<li><a class="item" href="${h}"><div class="thumb">${icon(i)}</div><div class="grow"><div class="title">${t}</div><div class="sub">${s}</div></div>${icon('chev', 'chev')}</a></li>`).join('')}</ul></div>
    <button class="btn block lg" style="margin-top:16px" id="out">${icon('logout')} Sign out</button>
    <p class="small muted" style="text-align:center;margin-top:16px">Tip: add this app to your home screen for one-tap scanning.</p>`;
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
  const row = (m, sub, tail) => `<li><a class="item" href="#/asset/${m.asset_id}">${thumbHtml(m.thumb, m.category)}
    <div class="grow"><div class="title truncate">${esc(m.asset_name)}</div><div class="sub truncate"><span class="mono">${esc(m.tag)}</span>${detail(m) ? ' · ' + detail(m) : ''}</div>
      <div class="sub">${sub}</div></div>${tail}${icon('chev', 'chev')}</a></li>`;
  const group = (title, rows, empty, iconName) => `<div class="card"><div class="card-head"><h2>${title}</h2><span class="muted small">${rows.length} item${rows.length === 1 ? '' : 's'}</span></div>
    ${rows.length ? `<ul class="list">${rows.join('')}</ul>` : `<div class="empty">${icon(iconName)}<p>${empty}</p></div>`}</div>`;
  main().innerHTML = `<div class="page-head"><h1>My equipment</h1></div><div class="stack">${returnBanners(d.mine)}
    ${group('Permanent assignments', perm.map((m) => row(m, `Assigned since ${esc(fmtStamp(m.checked_out_at))}`, flag(m) || pill('checked_out', 'Assigned'))), 'No equipment is permanently assigned to you.', 'laptop')}
    ${group('Temporary checkouts', temp.map((m) => row(m, `Checked out ${esc(fmtStamp(m.checked_out_at))} · return by ${esc(fmtDate(m.due_date))}${m.due_time ? ' ' + esc(fmtClock(m.due_time)) : ''}`, flag(m))), 'You have nothing checked out temporarily.', 'out')}
    <p class="small muted" style="text-align:center">Looking for something else? <a href="#/assets">Browse equipment</a> · <a href="#/history">History</a></p></div>`;
  wireDropoffs(main());
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
    return m.now ? `<li><a class="item" href="#/asset/${m.asset_id}">${body}</a></li>` : `<li><div class="item">${body}</div></li>`;
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
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => { if (S.me && document.visibilityState === 'visible') refreshBadge(); }, 60e3);
route();
