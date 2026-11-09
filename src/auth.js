// Accounts, sessions and permissions.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { fail, sha256 } = require('./util');

const COOKIE = 'sid';
const SESSION_DAYS = 14;

const hashPassword = (pw) => bcrypt.hash(String(pw), 10);
const checkPassword = (pw, hash) => bcrypt.compare(String(pw), hash);

function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Use at least 8 characters for your password.';
  if (s.length > 200) return 'That password is too long.';
  return null;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function startSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

async function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Puts the signed-in user (or null) on req.user. */
async function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    req.user = await db.one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, [sha256(token)]);
  }
  next();
}

const requireUser = (req, res, next) => (req.user ? next() : next(fail(401, 'SIGNED_OUT', 'Please sign in.')));
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(fail(401, 'SIGNED_OUT', 'Please sign in.'));
  if (!roles.includes(req.user.role)) return next(fail(403, 'FORBIDDEN', 'You do not have access to this page.'));
  next();
};

/**
 * Blocks cross-site form posts: changes must come from this site's own pages,
 * which send an X-Requested-With header (other sites cannot add it).
 */
function sameSiteOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-Requested-With') === 'fetch') return next();
  next(fail(403, 'BAD_ORIGIN', 'This request was blocked. Reload the page and try again.'));
}

/** Simple sign-in throttle: 10 failed tries per email + address per 15 minutes. */
const tries = new Map();
function tooManyTries(key) {
  const now = Date.now();
  const t = (tries.get(key) || []).filter((x) => now - x < 15 * 60000);
  tries.set(key, t);
  return t.length >= 10;
}
function noteFailedTry(key) { (tries.get(key) || tries.set(key, []).get(key)).push(Date.now()); }

/** Teachers can publish when they have time-based access or credits; the admin always can. */
function teacherAccess(u) {
  const until = u.teacher_until ? new Date(u.teacher_until) : null;
  const timeOk = !!until && until > new Date();
  return {
    isAdmin: u.role === 'admin',
    until,
    timeOk,
    credits: Number(u.credits) || 0,
    canPublish: u.role === 'admin' || timeOk || Number(u.credits) > 0,
  };
}

function publicUser(u) {
  if (!u) return null;
  const out = { id: u.id, email: u.email, name: u.name, role: u.role, studentNo: u.student_no || '', school: u.school || '' };
  if (u.role !== 'student') {
    const a = teacherAccess(u);
    out.access = { until: a.until, timeOk: a.timeOk, credits: a.credits, canPublish: a.canPublish };
  }
  return out;
}

module.exports = {
  hashPassword, checkPassword, passwordProblem, startSession, endSession, loadUser,
  requireUser, requireRole, sameSiteOnly, tooManyTries, noteFailedTry, teacherAccess, publicUser,
};
