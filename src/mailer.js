const nodemailer = require('nodemailer');
const { db } = require('./db');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'it@nutricost.com';

let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
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

async function send(to, subject, html) {
  if (!to) return;
  const list = Array.isArray(to) ? to.filter(Boolean) : [to];
  if (!list.length) return;
  for (const addr of list) {
    const ins = db.prepare('INSERT INTO outbox (to_addr, subject, body, status) VALUES (?, ?, ?, ?)');
    if (!transporter) {
      ins.run(addr, subject, html, 'logged');
      console.log(`[mail:not-configured] to=${addr} subject="${subject}"`);
      continue;
    }
    try {
      await transporter.sendMail({ from: FROM, to: addr, subject, html });
      ins.run(addr, subject, html, 'sent');
    } catch (err) {
      console.error('[mail:error]', err.message);
      db.prepare('INSERT INTO outbox (to_addr, subject, body, status, error) VALUES (?, ?, ?, ?, ?)')
        .run(addr, subject, html, 'failed', err.message);
    }
  }
}

function adminEmails() {
  return db.prepare("SELECT login_email FROM accounts WHERE role='admin' AND active=1").all().map((r) => r.login_email);
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
  test(to) {
    return send(to, 'Nutricost IT Assets — test email', layout('Email is working', '<p>If you can read this, email notifications are configured correctly.</p>'));
  },
};

module.exports = { notify, APP_URL, mailConfigured: () => !!transporter };
