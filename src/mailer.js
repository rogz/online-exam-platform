// Sending email (password reset links). Off until these are set in the server's .env:
//   SMTP_HOST   e.g. smtp.gmail.com
//   SMTP_PORT   587 (default)
//   SMTP_USER   the email account, e.g. examwizard.noreply@gmail.com
//   SMTP_PASS   its password (for Gmail: an "app password", not the normal password)
//   MAIL_FROM   optional, e.g. "Exam Wizard <examwizard.noreply@gmail.com>" (default: SMTP_USER)
//   PUBLIC_URL  optional, the site address for links, e.g. https://quiz.karmsys.com (default: https:// + DOMAIN)
// SMTP_HOST=test keeps emails in memory (outbox) for the automated tests.
const nodemailer = require('nodemailer');

const outbox = [];
let transport = null, transportKey = '';

function config() {
  const host = process.env.SMTP_HOST || '';
  const publicUrl = (process.env.PUBLIC_URL || (process.env.DOMAIN ? 'https://' + process.env.DOMAIN : '')).replace(/\/+$/, '');
  if (!host || !publicUrl) return null;
  if (host !== 'test' && (!process.env.SMTP_USER || !process.env.SMTP_PASS)) return null;
  return {
    host, port: Number(process.env.SMTP_PORT) || 587, user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'exam-wizard@localhost', publicUrl,
  };
}

const enabled = () => !!config();

async function send({ to, subject, text, html }) {
  const c = config();
  if (!c) throw Object.assign(new Error('Email is not set up on this site.'), { status: 503, code: 'NO_EMAIL' });
  if (c.host === 'test') { outbox.push({ to, subject, text, html, at: Date.now() }); return; }
  const key = [c.host, c.port, c.user, c.pass].join('|');
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass } });
    transportKey = key;
  }
  await transport.sendMail({ from: c.from, to, subject, text, html });
}

module.exports = { config, enabled, send, outbox };
