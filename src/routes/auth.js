// Sign up, sign in, sign out, profile.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { getSettings } = require('../settings');
const { fail, str, emailOk, isUuid } = require('../util');
const { redeemCode, grant } = require('./codes');

const router = express.Router();

router.get('/me', async (req, res) => {
  const s = await getSettings();
  res.json({ ok: true, user: auth.publicUser(req.user), site: { name: s.siteName, teacherSignup: s.teacherSignup, studentSignup: s.studentSignup, signupCredits: Number(s.signupCredits) || 0, passwordEmail: require('../mailer').enabled() } });
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
  const welcome = role === 'teacher' ? Math.max(0, Math.round(Number(s.signupCredits) || 0)) : 0;
  if (welcome) {
    await grant(user.id, { credits: welcome }, 'Welcome credits for new teachers');
    codeMessage = 'Welcome! You have ' + welcome + ' free credit' + (welcome === 1 ? '' : 's') + ': publish up to ' + welcome + ' exam' + (welcome === 1 ? '' : 's') + ' for free.';
  }
  if (role === 'teacher' && str(b.accessCode)) {
    const welcomeText = codeMessage ? ' ' + codeMessage : '';
    try { codeMessage = (await redeemCode(user.id, b.accessCode)) + welcomeText; } catch (e) { codeMessage = 'Your account was created, but the access code was not applied: ' + e.message + welcomeText; }
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
  let good = !!user && await auth.checkPassword(req.body.password, user.password_hash);
  // Temporary passwords from an admin (e.g. 5APE-CUB7) also work in small letters or with a space at the end.
  if (!good && user && user.must_change_password) good = await auth.checkPassword(String(req.body.password || '').trim().toUpperCase(), user.password_hash);
  if (!good) {
    auth.noteFailedTry(key);
    throw fail(401, 'BAD_LOGIN', 'The email or password is incorrect.');
  }
  auth.clearTries(email);
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
  // After signing in with a temporary password, the user only needs to choose a new one.
  if (!req.user.must_change_password && !(await auth.checkPassword(b.current, req.user.password_hash))) throw fail(400, 'BAD_INPUT', 'Your current password is incorrect.');
  const p = auth.passwordProblem(b.next);
  if (p) throw fail(400, 'BAD_INPUT', p);
  await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [await auth.hashPassword(b.next), req.user.id]);
  res.json({ ok: true });
});

// ───────── Forgot password (email link) ─────────
const crypto = require('crypto');
const mailer = require('../mailer');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const resetAsks = new Map(); // key → times (limits how often links can be requested)
function tooManyResets(key, max) {
  const now = Date.now(), t = (resetAsks.get(key) || []).filter((x) => now - x < 3600000);
  resetAsks.set(key, t);
  if (t.length >= max) return true;
  t.push(now); return false;
}

router.post('/forgot', async (req, res) => {
  if (!mailer.enabled()) throw fail(409, 'NO_EMAIL', 'Password reset by email is not set up on this site. Ask your teacher or the site administrator to reset your password.');
  const email = str(req.body && req.body.email, 200).toLowerCase();
  if (!emailOk(email)) throw fail(400, 'BAD_INPUT', 'Enter the email address you signed up with.');
  const done = { ok: true, message: 'If an account uses that email, we sent it a link to choose a new password. Check your inbox (and the Spam folder). The link works for 1 hour.' };
  if (tooManyResets('ip|' + req.ip, 20)) throw fail(429, 'SLOW_DOWN', 'Too many requests. Try again in an hour.');
  if (tooManyResets('email|' + email, 3)) return res.json(done); // don't flood one inbox, and don't say why
  const user = await db.one('SELECT id, name, email, disabled FROM users WHERE email = $1', [email]);
  if (user && !user.disabled) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [user.id, sha256(token)]);
    const s = await getSettings();
    const link = mailer.config().publicUrl + '/reset?token=' + token;
    try {
      await mailer.send({
        to: user.email,
        subject: s.siteName + ': choose a new password',
        text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset the password for your ${s.siteName} account.\n\nChoose a new password here (the link works once, for 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n`,
        html: `<p>Hi ${escHtml(user.name)},</p><p>Someone (hopefully you) asked to reset the password for your ${escHtml(s.siteName)} account.</p>
          <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#2f7bd1;color:#fff;border-radius:4px;text-decoration:none">Choose a new password</a></p>
          <p style="color:#666;font-size:13px">The link works once, for 1 hour. If you didn't ask for this, ignore this email; your password stays the same.</p>`,
      });
    } catch (e) {
      console.error('Password reset email failed:', e.message);
      throw fail(409, 'EMAIL_FAILED', 'The email could not be sent right now. Try again later, or ask your teacher or the site administrator to reset your password.');
    }
  }
  res.json(done);
});

router.post('/reset', async (req, res) => {
  const b = req.body || {};
  const row = /^[0-9a-f]{64}$/.test(String(b.token || '')) ? await db.one(
    `SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND NOT u.disabled`, [sha256(b.token)]) : null;
  if (!row) throw fail(400, 'BAD_LINK', 'This link has expired or was already used. Ask for a new one with "Forgot password?" on the sign-in page.');
  const p = auth.passwordProblem(b.password);
  if (p) throw fail(400, 'BAD_INPUT', p);
  await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [await auth.hashPassword(b.password), row.user_id]);
  await db.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [row.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id]); // sign out everywhere else
  auth.clearTries(row.email);
  await auth.startSession(res, row.user_id, req.secure);
  res.json({ ok: true, user: auth.publicUser(await auth.userById(row.user_id)) });
});

module.exports = router;
