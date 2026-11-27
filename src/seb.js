// Safe Exam Browser (SEB) for Strict exams. https://safeexambrowser.org — free, Windows / Mac / iPad.
//
// How it works:
// 1. The student clicks "Open in Safe Exam Browser": a sebs:// link to /seb/<examId>.seb, a settings file this site makes
//    (start page = the exam, camera allowed, quit link). SEB opens it full screen and locks the computer.
// 2. On every page it loads, SEB sends X-SafeExamBrowser-ConfigKeyHash = sha256(page URL + Config Key). The Config Key is
//    a sha256 of the settings file (as JSON, keys sorted, without "originatorVersion"), so the site can work it out too:
//    a match proves the page was opened in SEB with exactly our settings.
// 3. When the exam page (/exam?id=…) is opened that way, the site sets a signed cookie for that exam. Starting a Strict
//    exam needs that cookie. Pages and checks here don't touch the database.
//
// "verified" = the Config Key matched. "detected" = SEB's name is in the browser's user agent and it sent its headers, but
// the key didn't match (e.g. a different SEB version computes it differently). The admin decides in Site settings whether
// "detected" is enough (until the key has been confirmed with a real SEB, it is).
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KEY = crypto.createHash('sha256').update('exam-wizard-seb:' + (process.env.SEB_SECRET || process.env.DATABASE_URL || 'local')).digest();
const sign = (s) => crypto.createHmac('sha256', KEY).update(String(s)).digest('hex').slice(0, 32);

/** The site's own address as SEB sees it (https://quiz.example.com). */
function baseUrl(req) { return req.protocol + '://' + req.get('host'); }

/** The settings file's contents for one exam (or for the test page when examId is 'check'). */
function settings(base, examId) {
  return {
    originatorVersion: 'Exam Wizard',
    startURL: examId === 'check' ? base + '/seb-check' : base + '/exam?id=' + examId,
    quitURL: base + '/seb-quit',
    quitURLConfirm: false,
    sendBrowserExamKey: true,
    allowQuit: true,
    browserWindowAllowReload: true,
    showReloadButton: true,
    showTaskBar: true,
    allowVideoCapture: true,  // the exam camera
    allowAudioCapture: false,
    allowSpellCheck: false,
    URLFilterEnable: false,
  };
}

/** SEB's Config Key: sha256 of the settings as compact JSON with keys sorted (ignoring case), without originatorVersion. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).filter((k) => k !== 'originatorVersion')
      .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; })
      .forEach((k) => { out[k] = sortDeep(v[k]); });
    return out;
  }
  return v;
}
function configKey(obj) { return sha256(JSON.stringify(sortDeep(obj))); }

/** The settings file as XML (a plist, which SEB opens without a password). */
function plist(obj) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const val = (v) => (typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : Number.isInteger(v) ? '<integer>' + v + '</integer>' : '<string>' + esc(v) + '</string>');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' + Object.keys(obj).map((k) => '  <key>' + esc(k) + '</key>\n  ' + val(obj[k]) + '\n').join('') + '</dict>\n</plist>\n';
}

/** The sebs:// (or seb:// on plain http) link that opens an exam's settings file in SEB. */
function launchUrl(req, examId) {
  const base = baseUrl(req);
  return base.replace(/^http/, 'seb') + '/seb/' + examId + '.seb';
}

/** What a page request shows about SEB: 'verified', 'detected' or null. */
function check(req, examId) {
  const ua = String(req.get('user-agent') || '');
  const hash = String(req.get('x-safeexambrowser-configkeyhash') || '').toLowerCase();
  const rhash = req.get('x-safeexambrowser-requesthash');
  if (hash) {
    const url = baseUrl(req) + req.originalUrl;
    if (hash === sha256(url + configKey(settings(baseUrl(req), examId)))) return 'verified';
  }
  if (/\bSEB\//.test(ua) && (hash || rhash)) return 'detected';
  return null;
}

const cookieName = (examId) => 'ewseb_' + String(examId).replace(/-/g, '').slice(0, 12);
const TTL_MS = 12 * 3600 * 1000;

/** On the exam page: remember for 12 hours that this browser is SEB (signed, only for this exam). */
function rememberPage(req, res, examId) {
  const level = check(req, examId);
  if (!level) return null;
  const exp = Date.now() + TTL_MS;
  res.cookie(cookieName(examId), level + '.' + exp + '.' + sign(examId + '|' + level + '|' + exp),
    { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: TTL_MS, path: '/' });
  return level;
}

/** What the cookie says for this exam: 'verified', 'detected' or null. */
function fromCookie(req, examId) {
  const raw = req.cookies ? req.cookies[cookieName(examId)] : parseCookie(req.get('cookie'))[cookieName(examId)];
  if (!raw) return null;
  const [level, exp, sig] = String(raw).split('.');
  if (!['verified', 'detected'].includes(level) || !(Number(exp) > Date.now())) return null;
  const want = Buffer.from(sign(examId + '|' + level + '|' + exp)), got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? level : null;
}
function parseCookie(h) {
  const out = {};
  String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

/** True when the browser says it is SEB (for showing the "Quit" button and skipping checks SEB does itself). */
const isSebAgent = (ua) => /\bSEB\//.test(String(ua || ''));

module.exports = { settings, configKey, plist, launchUrl, check, rememberPage, fromCookie, baseUrl, isSebAgent, sha256 };
