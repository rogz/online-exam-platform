// Site-wide settings the admin can change (stored in the settings table).
const db = require('./db');

const DEFAULTS = {
  siteName: process.env.SITE_NAME || 'Exam Wizard',
  timeZone: process.env.TIME_ZONE || 'Asia/Manila',
  teacherSignup: true,                 // anyone may register as a teacher (then needs a code or credits to publish)
  studentSignup: true,
  // Credit packages, one per line: "credits = price" (e.g. "10 = 100"). Lines like "10 credits — ₱100" also work.
  paymentsEnabled: false,              // show "Buy credits" to teachers; when off they see "Request an access code"
  creditPackages: '10 = 100\n30 = 250\n100 = 750',
  currency: 'PHP',
  // Payment methods teachers can choose. Each one shows its own details.
  bankEnabled: false,
  bankDetails: 'Bank: \nAccount name: \nAccount number: ',
  paypalEnabled: false,
  paypalLink: '',                      // e.g. https://paypal.me/yourname (used when PayPal checkout keys are not set)
  otherEnabled: true,
  bankQr: '',                          // picture ids of the QR codes teachers scan to pay (uploaded in Site settings)
  otherQr: '',
  paymentInstructions: 'To buy credits, send payment by GCash to 09XX XXX XXXX (ABNJ Works), then submit a request with the reference number. Credits are added once the payment is confirmed.',
  supportContact: '',
};

async function getSettings() {
  const rows = await db.many('SELECT key, value FROM settings');
  const s = Object.assign({}, DEFAULTS);
  rows.forEach((r) => { if (r.key in DEFAULTS) s[r.key] = r.value; });
  return s;
}

async function saveSettings(patch) {
  if (patch.timeZone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(patch.timeZone) }); } catch (e) {
      const { fail } = require('./util');
      throw fail(400, 'BAD_INPUT', 'Unknown time zone "' + patch.timeZone + '". Use a name like Asia/Manila.');
    }
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue;
    let v = patch[key];
    if (typeof DEFAULTS[key] === 'boolean') v = v === true || v === 'true';
    else v = String(v).slice(0, 4000);
    if ((key === 'bankQr' || key === 'otherQr') && v && !/^[0-9a-f-]{36}$/i.test(v)) continue;
    if (key === 'currency') {
      v = v.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(v)) { const { fail } = require('./util'); throw fail(400, 'BAD_INPUT', 'The currency must be a 3-letter code such as PHP or USD.'); }
    }
    if (key === 'paypalLink' && v.trim() && !/^https:\/\/\S+$/i.test(v.trim()) && !/^\S+@\S+\.\S+$/.test(v.trim())) {
      const { fail } = require('./util'); throw fail(400, 'BAD_INPUT', 'The PayPal link must start with https:// (e.g. https://paypal.me/yourname) or be an email address.');
    }
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(v)]);
  }
  return getSettings();
}

/** "10 = 100" lines → [{ credits: 10, price: 100 }], sorted by credits. Lines that don't fit are ignored. */
function parsePackages(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(\d+)\s*(?:credits?)?\s*(?:=|:|—|–|-|for)\s*\D{0,6}?([\d,]+(?:\.\d{1,2})?)\s*\S{0,6}\s*$/i);
    if (!m) return;
    const credits = Number(m[1]), price = Number(m[2].replace(/,/g, ''));
    if (credits >= 1 && credits <= 10000 && price > 0 && price <= 1000000 && !out.some((p) => p.credits === credits)) out.push({ credits, price });
  });
  return out.sort((a, b) => a.credits - b.credits);
}

/** "Nov 10, 2026, 8:00 AM" in the site's time zone. */
function fmtDate(d, tz) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)) + ' (' + tz + ')';
}

module.exports = { getSettings, saveSettings, fmtDate, parsePackages, DEFAULTS };
