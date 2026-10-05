const nodemailer = require('nodemailer');
const addressparser = require('nodemailer/lib/addressparser');
const { db, getSettings } = require('./db');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
// The authenticated / provider-verified sender. Credentials (SMTP_USER / SMTP_PASS / MAIL_FROM) live ONLY in the environment, never in the
// database or the settings screen.
const senderAddress = () => {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || 'it@nutricost.com';
  const p = addressparser(raw).find((x) => x.address);
  return p ? p.address : raw;
};

// Who the mail is from. Settings -> "IT email" supplies a display name and an IT contact address:
//  * From   = display name + the verified sender address. The provider rejects (or rewrites) a From it has not verified, so we never fake one.
//  * Reply-To = the IT contact address, so replies reach the person who is acting as IT.
//  * Only when the operator states, in the environment, that the provider allows the IT address as a sender
//    (MAIL_ALLOW_IT_FROM=1, e.g. a Gmail "Send mail as" alias) does the IT contact address become the From address itself.
function mailEnvelope() {
  const { it_email_name: name, it_contact_email: contact } = getSettings();
  const sender = senderAddress();
  const address = contact && process.env.MAIL_ALLOW_IT_FROM === '1' ? contact : sender;
  return { from: { name, address }, replyTo: contact && contact.toLowerCase() !== address.toLowerCase() ? contact : undefined };
}

// Seeding and the test harness set NC_NO_EXTERNAL_MAIL=1 before loading the app. Then NO SMTP transport is ever created from the environment,
// whatever SMTP_USER / SMTP_PASS / MAIL_TEST_RECIPIENT say, so nothing they do can reach a mail server (messages are only recorded in the
// outbox). A test may still inject its own fake transport (setTransportForTests). A normal server never sets this.
const externalMailBlocked = () => process.env.NC_NO_EXTERNAL_MAIL === '1';
let transporter = null;
if (!externalMailBlocked() && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml, cta) {
  const button = cta
    ? `<p style="margin:28px 0 8px"><a href="${esc(cta.url)}" style="background:#0a58ca;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#111;padding:18px 24px;color:#fff;font-weight:800;letter-spacing:.08em;font-size:18px">NUTRICOST <span style="font-weight:500;letter-spacing:0;opacity:.7;font-size:14px">&nbsp;IT Assets</span></td></tr>
    <tr><td style="padding:28px 24px 24px">
      <h1 style="margin:0 0 14px;font-size:20px">${esc(title)}</h1>
      <div style="font-size:15px;line-height:1.55">${bodyHtml}</div>
      ${button}
    </td></tr>
    <tr><td style="padding:14px 24px;background:#f9fafb;color:#6b7280;font-size:12px">Nutricost IT &middot; This is an automated message from the IT Asset Tracker.</td></tr>
  </table></td></tr></table></body></html>`;
}

function assetLine(a) {
  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin:10px 0">
    <strong>${esc(a.name)}</strong><br><span style="color:#6b7280;font-size:13px">Tag ${esc(a.tag)}${a.serial ? ' &middot; S/N ' + esc(a.serial) : ''}${a.category ? ' &middot; ' + esc(a.category) : ''}</span></div>`;
}

// DEV / TEST ONLY: with MAIL_TEST_RECIPIENT set in the SERVER ENVIRONMENT (never in the database or the settings screen), every outgoing message
// is physically addressed to that one address instead of its real recipient, with the intended recipient kept in plain sight ("[DEV for
// x@y.com]" in the subject and a banner at the top of the body). The outbox keeps to_addr = the intended recipient and records delivered_to.
// Nothing else changes: the employee's stored address, who is notified and when, From / Reply-To. An INVALID value fails closed: nothing is
// sent to anyone (a typo must never leak test mail to real people).
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
const testRecipient = () => (process.env.MAIL_TEST_RECIPIENT || '').trim() || null;
const devBanner = (intended, actual) => `<div style="background:#fff3cd;border:1px solid #e0c36a;color:#5c4a00;padding:10px 14px;margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"><strong>DEV TEST MODE.</strong> This email was intended for <strong>${esc(intended)}</strong> and was redirected to <strong>${esc(actual)}</strong>.</div>`;

// What actually goes out for one intended recipient (pure, so it can be tested without a transport).
function deliveryFor(addr, subject, html) {
  const redirect = testRecipient();
  if (!redirect) return { to: addr, subject, html, deliveredTo: null };
  if (!EMAIL_RE.test(redirect)) return { invalid: true, to: addr, subject, html, deliveredTo: null };
  const banner = devBanner(addr, redirect);
  const body = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + banner) : banner + html;
  return { to: redirect, subject: `[DEV for ${addr}] ${subject}`, html: body, deliveredTo: redirect };
}

async function send(to, subject, html) {
  if (!to) return;
  const list = Array.isArray(to) ? to.filter(Boolean) : [to];
  if (!list.length) return;
  const record = db.prepare('INSERT INTO outbox (to_addr, subject, body, status, error, delivered_to) VALUES (?, ?, ?, ?, ?, ?)');
  for (const addr of list) {
    const d = deliveryFor(addr, subject, html);
    if (d.invalid) {
      console.error('[mail:error] MAIL_TEST_RECIPIENT is not a valid email address; nothing was sent');
      record.run(addr, subject, html, 'failed', 'MAIL_TEST_RECIPIENT is not a valid email address, so nothing was sent', null);
      continue;
    }
    if (!transporter) {
      record.run(addr, d.subject, d.html, 'logged', null, d.deliveredTo);
      console.log(`[mail:not-configured] to=${addr} subject="${d.subject}"`);
      continue;
    }
    try {
      await transporter.sendMail({ ...mailEnvelope(), to: d.to, subject: d.subject, html: d.html });
      record.run(addr, d.subject, d.html, 'sent', null, d.deliveredTo);
    } catch (err) {
      console.error('[mail:error]', err.message);
      record.run(addr, d.subject, d.html, 'failed', err.message, d.deliveredTo);
    }
  }
}

function adminEmails() {
  return db.prepare("SELECT login_email FROM accounts WHERE role='admin' AND active=1").all().map((r) => r.login_email);
}

const rangeText = (s, e) => (s === e ? fmtDate(s) : `${fmtDate(s)} to ${fmtDate(e)}`);
// A stored UTC timestamp ('YYYY-MM-DD HH:MM:SS') for a person: in APP_TIMEZONE if set (an IANA name such as America/Denver), else the server's zone.
function fmtDateTime(ts) {
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try { return d.toLocaleString('en-US', { ...opts, timeZone: process.env.APP_TIMEZONE || undefined }); } catch { return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
}
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T12:00:00' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// Fire-and-forget wrappers so a mail problem never breaks a request
const fire = (p) => { Promise.resolve(p).catch((e) => console.error('[mail]', e)); };

const notify = {
  welcome(user, link) {
    fire(send(user.email, 'Your Nutricost IT Assets account',
      layout(`Welcome, ${user.name}`, `<p>An account has been created for you on the Nutricost IT Asset Tracker. Use it to see the equipment assigned to you, request new equipment and respond to return requests.</p><p>Click below to set your password. This link expires in 7 days.</p>`,
        { url: link, label: 'Set my password' })));
  },
  passwordReset(user, link) {
    fire(send(user.email, 'Reset your Nutricost IT Assets password',
      layout('Password reset', `<p>Someone (hopefully you) asked to reset your password. This link expires in 1 hour. If you didn't ask for this you can ignore this email.</p>`,
        { url: link, label: 'Reset password' })));
  },
  checkedOut(user, asset, assignment) {
    fire(send(user.email, `Checked out to you: ${asset.name} (${asset.tag})`,
      layout('Equipment checked out to you', `<p>Hi ${esc(user.name)}, the following item is now assigned to you:</p>${assetLine(asset)}
        ${assignment.due_date ? `<p><strong>Due back:</strong> ${fmtDate(assignment.due_date)}${assignment.due_time ? ` at ${esc(assignment.due_time)}` : ''}</p>` : ''}
        <p>Please take good care of it and let IT know right away if anything happens to it.</p>`,
        { url: `${APP_URL}/#/asset/${asset.id}`, label: 'View in IT Assets' })));
  },
  selfCheckoutToAdmins(user, asset) {
    fire(send(adminEmails(), `Self check-out: ${asset.tag} → ${user.name}`,
      layout('Self check-out', `<p>${esc(user.name)} checked out the following item to themselves:</p>${assetLine(asset)}`,
        { url: `${APP_URL}/#/asset/${asset.id}`, label: 'View asset' })));
  },
  checkedIn(user, asset) {
    fire(send(user.email, `Returned: ${asset.name} (${asset.tag})`,
      layout('Return received', `<p>Thanks ${esc(user.name)} — IT has received this item back from you:</p>${assetLine(asset)}<p>It is no longer assigned to you.</p>`)));
  },
  returnRequested(user, asset, req) {
    fire(send(user.email, `Please return: ${asset.name} (${asset.tag})`,
      layout('IT has asked you to return equipment', `<p>Hi ${esc(user.name)}, please turn in the following item to IT${req.needed_by ? ` by <strong>${fmtDate(req.needed_by)}</strong>` : ''}:</p>${assetLine(asset)}
        ${req.message ? `<p style="background:#f3f4f6;border-radius:8px;padding:10px 12px"><em>${esc(req.message)}</em></p>` : ''}
        <p>Once you've dropped it off, tap <strong>“I've dropped it off”</strong> in the app so IT knows to look for it.</p>`,
        { url: `${APP_URL}/#/home`, label: 'Open IT Assets' })));
  },
  droppedOff(user, asset) {
    fire(send(adminEmails(), `Dropped off: ${asset.tag} from ${user.name}`,
      layout('Equipment dropped off', `<p>${esc(user.name)} says they've dropped off this item. Scan it to check it in:</p>${assetLine(asset)}`,
        { url: `${APP_URL}/#/asset/${asset.id}`, label: 'Check it in' })));
  },
  equipmentRequested(user, req) {
    const perm = req.requested_assignment_type === 'permanent';
    fire(send(adminEmails(), `${perm ? 'Permanent assignment request' : 'Equipment request'} from ${user.name}: ${req.catalog_path || req.category || 'Equipment'}`,
      layout(perm ? 'New permanent assignment request' : 'New equipment request', `<p><strong>${esc(user.name)}</strong>${user.department ? ` (${esc(user.department)})` : ''} is requesting${perm ? ' a <strong>permanent assignment</strong> of' : ''}: <strong>${esc(req.catalog_path || req.category || 'Equipment')}</strong>${req.catalog_path ? (req.asset_label ? `<br>Specific item: ${esc(req.asset_label)}` : '<br>Any matching item') : ''}</p>
        ${req.message ? `<p style="background:#f3f4f6;border-radius:8px;padding:10px 12px">${esc(req.message)}</p>` : ''}
        ${req.needed_by ? `<p><strong>Needed by:</strong> ${fmtDate(req.needed_by)}</p>` : ''}`,
        { url: `${APP_URL}/#/requests`, label: 'Review request' })));
  },
  requestResolved(user, req, asset) {
    const approved = req.status === 'approved' || req.status === 'completed';
    fire(send(user.email, `Your equipment request was ${approved ? 'approved' : 'declined'}`,
      layout(approved ? 'Request approved' : 'Request declined', `<p>Hi ${esc(user.name)}, your request for <strong>${esc(req.catalog_path || req.category || 'equipment')}</strong> was ${approved ? 'approved' : 'declined'}.</p>
        ${asset ? `<p>Assigned item:</p>${assetLine(asset)}` : ''}
        ${req.resolution_note ? `<p style="background:#f3f4f6;border-radius:8px;padding:10px 12px">${esc(req.resolution_note)}</p>` : ''}`,
        { url: `${APP_URL}/#/home`, label: 'Open IT Assets' })));
  },
  overdue(user, asset, assignment) {
    fire(send(user.email, `Overdue: ${asset.name} (${asset.tag})`,
      layout('Equipment overdue', `<p>Hi ${esc(user.name)}, this item was due back on <strong>${fmtDate(assignment.due_date)}</strong>:</p>${assetLine(asset)}<p>Please return it to IT as soon as possible, or reply to this email if you need more time.</p>`,
        { url: `${APP_URL}/#/home`, label: 'Open IT Assets' })));
  },
  // Waitlist (slice 8). Targeted notices only: the current reserver is told, informationally, that another team is waiting; the next person in
  // line is told the item is theirs to confirm for 24 hours. Neither email asks anyone to give anything up.
  waitlistJoined(blocker, waiter, asset, entry, resv, { updated = false } = {}) {
    fire(send(blocker.email, `Another team is waiting for ${asset.name} (${asset.tag})`,
      layout('Another team is waiting for this equipment', `<p>Hi ${esc(blocker.name)}, just so you know: <strong>${esc(waiter.name)}</strong>${waiter.department ? ` (${esc(waiter.department)})` : ''} ${updated ? 'changed their waitlist request, and it now overlaps the item you have reserved.' : 'joined the waitlist for the item you have reserved.'}</p>${assetLine(asset)}
        <p><strong>Your reservation:</strong> ${esc(rangeText(resv.start_date, resv.end_date))}<br><strong>They are waiting for:</strong> ${esc(rangeText(entry.start_date, entry.end_date))}</p>
        <p><strong>No action is needed.</strong> Your reservation is unchanged. If you would like to coordinate with them, you can reach out to ${esc(waiter.name)}${waiter.email ? ` at ${esc(waiter.email)}` : ''}; otherwise, carry on as planned.</p>`,
        { url: `${APP_URL}/#/requests?tab=reservations`, label: 'View my reservations' })));
  },
  waitlistHold(user, asset, entry) {
    const needsApproval = !!asset.reservation_requires_approval;
    fire(send(user.email, `Available for you: ${asset.name} (${asset.tag}) — please confirm within 24 hours`,
      layout('The equipment you were waiting for is available', `<p>Hi ${esc(user.name)}, good news: the item you were waiting for is free for your dates, and we are holding it for you.</p>${assetLine(asset)}
        <p><strong>Your dates:</strong> ${esc(rangeText(entry.start_date, entry.end_date))}<br><strong>Held for you until:</strong> ${esc(fmtDateTime(entry.hold_expires_at))}</p>
        <p><strong>Do you still need it?</strong> Open the app and choose <strong>Confirm</strong> to ${needsApproval ? 'send your reservation to IT for approval' : 'reserve it'}, or <strong>Decline</strong> if you no longer need it. If you don't answer by then, the hold is released and the next person in line is offered the item.</p>`,
        { url: `${APP_URL}/#/requests?tab=reservations`, label: 'Confirm or decline' })));
  },
  test(to) {
    return send(to, 'Nutricost IT Assets — test email', layout('Email is working', '<p>If you can read this, email notifications are configured correctly.</p>'));
  },
};

// Tests swap the SMTP transport for a fake one (so From / Reply-To and failures can be checked without a mail server).
const setTransportForTests = (t) => { transporter = t; };

module.exports = { notify, APP_URL, mailConfigured: () => !!transporter, mailEnvelope, testRecipient, deliveryFor, setTransportForTests };
