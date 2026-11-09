// Sign up, sign in, sign out, profile.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { getSettings } = require('../settings');
const { fail, str, emailOk } = require('../util');
const { redeemCode } = require('./codes');

const router = express.Router();

router.get('/me', async (req, res) => {
  const s = await getSettings();
  res.json({ ok: true, user: auth.publicUser(req.user), site: { name: s.siteName, teacherSignup: s.teacherSignup, studentSignup: s.studentSignup } });
});

router.post('/register', async (req, res) => {
  const b = req.body || {};
  const role = b.role === 'teacher' ? 'teacher' : 'student';
  const s = await getSettings();
  if (role === 'teacher' && !s.teacherSignup) throw fail(403, 'CLOSED', 'Teacher sign-up is closed. Contact the site administrator.');
  if (role === 'student' && !s.studentSignup) throw fail(403, 'CLOSED', 'Student sign-up is closed.');
  const name = str(b.name, 120), email = str(b.email, 200).toLowerCase();
  if (!name) throw fail(400, 'BAD_INPUT', 'Enter your full name.');
  if (!emailOk(email)) throw fail(400, 'BAD_INPUT', 'Enter a valid email address.');
  const pwProblem = auth.passwordProblem(b.password);
  if (pwProblem) throw fail(400, 'BAD_INPUT', pwProblem);
  if (await db.one('SELECT 1 FROM users WHERE email = $1', [email])) throw fail(409, 'EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
  const hash = await auth.hashPassword(b.password);
  const user = await db.one(
    `INSERT INTO users (email, password_hash, name, role, student_no, school) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [email, hash, name, role, role === 'student' ? str(b.studentNo, 60) || null : null, str(b.school, 160) || null]);
  let codeMessage = null;
  if (role === 'teacher' && str(b.accessCode)) {
    try { codeMessage = await redeemCode(user.id, b.accessCode); } catch (e) { codeMessage = 'Your account was created, but the access code was not applied: ' + e.message; }
  }
  await auth.startSession(res, user.id, req.secure);
  const fresh = await db.one('SELECT * FROM users WHERE id = $1', [user.id]);
  res.json({ ok: true, user: auth.publicUser(fresh), codeMessage });
});

router.post('/login', async (req, res) => {
  const email = str(req.body && req.body.email, 200).toLowerCase();
  const key = email + '|' + req.ip;
  if (auth.tooManyTries(key)) throw fail(429, 'SLOW_DOWN', 'Too many sign-in attempts. Wait 15 minutes and try again.');
  const user = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !(await auth.checkPassword(req.body.password, user.password_hash))) {
    auth.noteFailedTry(key);
    throw fail(401, 'BAD_LOGIN', 'The email or password is incorrect.');
  }
  if (user.disabled) throw fail(403, 'DISABLED', 'This account has been disabled. Contact the site administrator.');
  await auth.startSession(res, user.id, req.secure);
  res.json({ ok: true, user: auth.publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await auth.endSession(req, res);
  res.json({ ok: true });
});

router.post('/profile', auth.requireUser, async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 120) || req.user.name;
  await db.query('UPDATE users SET name = $1, student_no = $2, school = $3 WHERE id = $4',
    [name, req.user.role === 'student' ? str(b.studentNo, 60) || null : req.user.student_no, str(b.school, 160) || null, req.user.id]);
  res.json({ ok: true, user: auth.publicUser(await db.one('SELECT * FROM users WHERE id = $1', [req.user.id])) });
});

router.post('/password', auth.requireUser, async (req, res) => {
  const b = req.body || {};
  if (!(await auth.checkPassword(b.current, req.user.password_hash))) throw fail(400, 'BAD_INPUT', 'Your current password is incorrect.');
  const p = auth.passwordProblem(b.next);
  if (p) throw fail(400, 'BAD_INPUT', p);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await auth.hashPassword(b.next), req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
