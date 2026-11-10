// Sign up, sign in, sign out, profile.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { getSettings } = require('../settings');
const { fail, str, emailOk, isUuid } = require('../util');
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
  const fresh = await auth.userById(user.id);
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
  res.json({ ok: true, user: auth.publicUser(await auth.userById(user.id)) });
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
  res.json({ ok: true, user: auth.publicUser(await auth.userById(req.user.id)) });
});

/** Profile picture: the page sends a small square JPEG (it crops and shrinks it first). */
router.post('/avatar', auth.requireUser, express.json({ limit: '1mb' }), async (req, res) => {
  const m = String((req.body && req.body.dataUrl) || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw fail(400, 'BAD_INPUT', 'That file is not a JPEG, PNG or WebP picture.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 300 * 1024) throw fail(413, 'TOO_LARGE', 'The picture is too large. Try a smaller one.');
  await db.query(`INSERT INTO avatars (user_id, mime, data, updated_at) VALUES ($1, $2, $3, now())
                  ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [req.user.id, m[1], bytes]);
  res.json({ ok: true, user: auth.publicUser(await auth.userById(req.user.id)) });
});

router.post('/avatar/remove', auth.requireUser, async (req, res) => {
  await db.query('DELETE FROM avatars WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true, user: auth.publicUser(await auth.userById(req.user.id)) });
});

/** Anyone signed in can see profile pictures (links only appear next to people they share a class with). */
router.get('/avatar/:id', auth.requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'No picture.');
  const a = await db.one('SELECT mime, data FROM avatars WHERE user_id = $1', [req.params.id]);
  if (!a) throw fail(404, 'NOT_FOUND', 'No picture.');
  res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(a.data));
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
