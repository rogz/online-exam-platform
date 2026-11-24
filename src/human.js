// "I'm not a robot" check for sign-up, without an outside service (no keys, nothing sent elsewhere).
// The browser gets a small puzzle: find the number n (0 … MAX) with sha256(salt + n) = hash. A person's browser solves it
// in a second or two while they tick the box; a spam robot that just posts the form can't. Each puzzle works once,
// for 10 minutes, and is signed so it can't be made up. Nothing is stored in the database.
const crypto = require('crypto');

const KEY = crypto.randomBytes(32); // new on every restart: a puzzle from before a restart simply asks for a new tick
const MAX = 60000;
const LIFE = 10 * 60000;
const used = new Map(); // signature → expiry (each puzzle counts once)

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (s) => crypto.createHmac('sha256', KEY).update(String(s)).digest('hex');

function challenge() {
  const salt = crypto.randomBytes(12).toString('hex') + '.' + (Date.now() + LIFE);
  const hash = sha256(salt + crypto.randomInt(0, MAX + 1));
  return { salt, hash, max: MAX, sig: sign(salt + '|' + hash) };
}

/** True when the answer is a real, unexpired, unused, solved puzzle. */
function verify(p) {
  if (!p || typeof p !== 'object') return false;
  const salt = String(p.salt || ''), hash = String(p.hash || ''), sig = String(p.sig || ''), n = Number(p.number);
  const exp = Number(salt.split('.')[1]);
  if (!exp || exp < Date.now() || !Number.isInteger(n) || n < 0 || n > MAX) return false;
  const want = Buffer.from(sign(salt + '|' + hash)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  if (sha256(salt + n) !== hash) return false;
  const now = Date.now();
  for (const [k, e] of used) if (e < now) used.delete(k);
  if (used.has(sig)) return false;
  used.set(sig, exp);
  return true;
}

/** At most `max` sign-ups per internet address per hour (a whole class at school shares one address, so this is generous). */
const recent = new Map();
function tooMany(ip, max) {
  const now = Date.now(), t = (recent.get(ip) || []).filter((x) => now - x < 3600000);
  if (t.length >= max) { recent.set(ip, t); return true; }
  t.push(now); recent.set(ip, t);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((x) => now - x < 3600000)) recent.delete(k);
  return false;
}

module.exports = { challenge, verify, tooMany, MAX };
