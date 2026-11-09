// Site-wide settings the admin can change (stored in the settings table).
const db = require('./db');

const DEFAULTS = {
  siteName: process.env.SITE_NAME || 'OnlineQuiz',
  timeZone: process.env.TIME_ZONE || 'Asia/Manila',
  teacherSignup: true,                 // anyone may register as a teacher (then needs a code or credits to publish)
  studentSignup: true,
  paymentInstructions: 'To buy credits, send payment by GCash to 09XX XXX XXXX (ABNJ Works), then submit a request with the reference number. Credits are added once the payment is confirmed.',
  creditPackages: '1 credit = publish 1 exam\n10 credits — ₱100\n30 credits — ₱250',
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
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(v)]);
  }
  return getSettings();
}

/** "Nov 10, 2026, 8:00 AM" in the site's time zone. */
function fmtDate(d, tz) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)) + ' (' + tz + ')';
}

module.exports = { getSettings, saveSettings, fmtDate, DEFAULTS };
