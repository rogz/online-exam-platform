// Admin: teachers, students, access codes, credit requests, site settings.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { getSettings, saveSettings } = require('../settings');
const { fail, str, int, isUuid, randomCode, emailOk } = require('../util');
const { grant } = require('./codes');

const router = express.Router();
router.use(auth.requireRole('admin'));

router.get('/overview', async (req, res) => {
  const c = await db.one(`SELECT
      (SELECT count(*) FROM users WHERE role = 'teacher')::int AS teachers,
      (SELECT count(*) FROM users WHERE role = 'student')::int AS students,
      (SELECT count(*) FROM exams WHERE published)::int AS exams,
      (SELECT count(*) FROM attempts)::int AS attempts,
      (SELECT count(*) FROM credit_requests WHERE status = 'pending')::int AS pending_requests`);
  res.json({ ok: true, counts: c });
});

router.get('/users', async (req, res) => {
  const role = ['teacher', 'student', 'admin'].includes(req.query.role) ? req.query.role : 'teacher';
  const q = '%' + str(req.query.q, 100).toLowerCase() + '%';
  const rows = await db.many(
    `SELECT u.id, u.email, u.name, u.role, u.student_no, u.school, u.teacher_until, u.credits, u.disabled, u.created_at,
            (SELECT count(*) FROM exams e WHERE e.teacher_id = u.id)::int AS exam_count,
            (SELECT count(*) FROM classes c WHERE c.teacher_id = u.id)::int AS class_count
       FROM users u WHERE u.role = $1 AND (lower(u.email) LIKE $2 OR lower(u.name) LIKE $2)
      ORDER BY u.created_at DESC LIMIT 500`, [role, q]);
  res.json({ ok: true, users: rows });
});

router.post('/users/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  const u = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!u) throw fail(404, 'NOT_FOUND', 'User not found.');
  const b = req.body || {};
  if (b.credits || b.days) {
    if (u.role === 'student') throw fail(400, 'BAD_INPUT', 'Credits and access are for teachers.');
    await grant(u.id, { credits: int(b.credits, 0, -100000, 100000), days: int(b.days, 0, -3650, 3650) }, 'Admin: ' + (str(b.reason, 200) || 'manual change'));
  }
  if (b.disabled !== undefined) {
    if (u.id === req.user.id) throw fail(400, 'BAD_INPUT', 'You cannot disable your own account.');
    if (u.email === ownerEmail()) throw fail(403, 'OWNER', 'The site owner\'s account cannot be disabled.');
    await db.query('UPDATE users SET disabled = $1 WHERE id = $2', [!!b.disabled, u.id]);
    if (b.disabled) await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  }
  if (b.role && ['teacher', 'student'].includes(b.role) && u.role !== 'admin') {
    await db.query('UPDATE users SET role = $1 WHERE id = $2', [b.role, u.id]);
  }
  res.json({ ok: true, user: await db.one('SELECT id, email, name, role, teacher_until, credits, disabled FROM users WHERE id = $1', [u.id]) });
});

/** Sets a temporary password and returns it once, for the admin to pass on. */
// ───────── Admins ─────────

/** The site owner (ADMIN_EMAIL) can never be demoted or deleted by other admins. */
const ownerEmail = () => String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();

router.get('/admins', async (req, res) => {
  const rows = await db.many(`SELECT id, email, name, school, created_at, disabled FROM users WHERE role = 'admin' ORDER BY created_at`);
  res.json({ ok: true, admins: rows.map((u) => Object.assign(u, { isOwner: u.email === ownerEmail(), isMe: u.id === req.user.id })) });
});

/**
 * Adds an admin. An existing teacher with that email is promoted (keeping their classes and exams);
 * otherwise a new account is created with a temporary password, shown once.
 */
router.post('/admins', async (req, res) => {
  const b = req.body || {};
  const email = str(b.email, 200).toLowerCase();
  if (!emailOk(email)) throw fail(400, 'BAD_INPUT', 'Enter a valid email address.');
  const existing = await db.one('SELECT id, role, name FROM users WHERE email = $1', [email]);
  if (existing) {
    if (existing.role === 'admin') throw fail(409, 'ALREADY_ADMIN', existing.name + ' is already an admin.');
    if (existing.role === 'student') throw fail(409, 'STUDENT', 'That email belongs to a student account. Use a teacher account or a new email.');
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [existing.id]);
    return res.json({ ok: true, promoted: true, name: existing.name });
  }
  const name = str(b.name, 120);
  if (!name) throw fail(400, 'BAD_INPUT', 'Enter the new admin\'s full name.');
  const temp = randomCode(4) + '-' + randomCode(4);
  await db.query(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`, [email, await auth.hashPassword(temp), name]);
  res.json({ ok: true, created: true, name, tempPassword: temp });
});

/** Removes admin rights: the person becomes a teacher again (their classes and exams stay). */
router.post('/admins/:id/remove', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  const u = await db.one('SELECT id, email, role FROM users WHERE id = $1', [req.params.id]);
  if (!u || u.role !== 'admin') throw fail(404, 'NOT_FOUND', 'Admin not found.');
  if (u.id === req.user.id) throw fail(400, 'BAD_INPUT', 'You cannot remove your own admin rights. Ask another admin.');
  if (u.email === ownerEmail()) throw fail(403, 'OWNER', 'The site owner\'s admin rights cannot be removed.');
  const n = await db.one(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled`);
  if (n.n <= 1) throw fail(400, 'LAST_ADMIN', 'This is the last admin.');
  await db.query(`UPDATE users SET role = 'teacher' WHERE id = $1`, [u.id]);
  res.json({ ok: true });
});

/** What deleting this user would also delete (shown before confirming). */
async function deletionImpact(id) {
  return db.one(`SELECT u.id, u.email, u.name, u.role,
      (SELECT count(*) FROM classes WHERE teacher_id = u.id)::int AS classes,
      (SELECT count(*) FROM exams WHERE teacher_id = u.id)::int AS exams,
      (SELECT count(*) FROM questions WHERE teacher_id = u.id)::int AS questions,
      (SELECT count(*) FROM attempts a JOIN exams x ON x.id = a.exam_id WHERE x.teacher_id = u.id)::int AS student_attempts,
      (SELECT count(*) FROM attempts WHERE student_id = u.id)::int AS own_attempts,
      (SELECT count(*) FROM enrollments WHERE student_id = u.id)::int AS enrollments
    FROM users u WHERE u.id = $1`, [id]);
}

router.get('/users/:id/impact', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  const impact = await deletionImpact(req.params.id);
  if (!impact) throw fail(404, 'NOT_FOUND', 'User not found.');
  res.json({ ok: true, impact });
});

/** Permanently deletes a user and everything that belongs to them. */
router.post('/users/:id/delete', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  const u = await deletionImpact(req.params.id);
  if (!u) throw fail(404, 'NOT_FOUND', 'User not found.');
  if (u.id === req.user.id) throw fail(400, 'BAD_INPUT', 'You cannot delete your own account.');
  if (u.role === 'admin') throw fail(400, 'BAD_INPUT', 'Admin accounts cannot be deleted here.');
  if (str(req.body && req.body.confirmEmail, 200).toLowerCase() !== u.email) {
    throw fail(400, 'BAD_INPUT', 'Type the user\'s email exactly to confirm.');
  }
  // Classes, exams, questions, pictures, attempts, answers, sessions and requests are removed with the account.
  await db.query('DELETE FROM users WHERE id = $1', [u.id]);
  res.json({ ok: true, deleted: u });
});

router.post('/users/:id/reset-password', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  const target = await db.one('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!target) throw fail(404, 'NOT_FOUND', 'User not found.');
  // Resetting an admin's password would hand over their account: only the site owner may do that.
  if (target.role === 'admin' && req.user.email !== ownerEmail()) throw fail(403, 'OWNER_ONLY', 'Only the site owner can reset an admin\'s password.');
  const temp = randomCode(4) + '-' + randomCode(4);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await auth.hashPassword(temp), req.params.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  res.json({ ok: true, tempPassword: temp });
});

router.get('/users/:id/ledger', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'User not found.');
  res.json({ ok: true, ledger: await db.many('SELECT * FROM credit_ledger WHERE teacher_id = $1 ORDER BY at DESC LIMIT 200', [req.params.id]) });
});

// ───────── Access codes ─────────

router.get('/codes', async (req, res) => {
  const rows = await db.many(
    `SELECT c.*, COALESCE((SELECT json_agg(json_build_object('name', u.name, 'email', u.email, 'at', r.at) ORDER BY r.at)
                             FROM code_redemptions r JOIN users u ON u.id = r.user_id WHERE r.code = c.code), '[]') AS used_by
       FROM access_codes c ORDER BY c.created_at DESC LIMIT 1000`);
  res.json({ ok: true, codes: rows });
});

router.post('/codes', async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'credits' ? 'credits' : 'days';
  const amount = int(b.amount, 0, 1, 100000);
  if (!amount) throw fail(400, 'BAD_INPUT', kind === 'days' ? 'Enter the number of days.' : 'Enter the number of credits.');
  const count = int(b.count, 1, 1, 200);
  const maxUses = int(b.maxUses, 1, 1, 100000);
  const expires = b.expiresAt ? new Date(b.expiresAt) : null;
  if (expires && isNaN(expires)) throw fail(400, 'BAD_INPUT', 'The expiry date is not valid.');
  const created = [];
  for (let i = 0; i < count; i++) {
    const code = (kind === 'days' ? 'T' : 'C') + randomCode(3) + '-' + randomCode(4);
    await db.query('INSERT INTO access_codes (code, kind, amount, max_uses, expires_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [code, kind, amount, maxUses, expires, str(b.note, 200) || null, req.user.id]);
    created.push(code);
  }
  res.json({ ok: true, codes: created });
});

router.post('/codes/:code', async (req, res) => {
  await db.query('UPDATE access_codes SET active = $1 WHERE code = $2', [!!(req.body && req.body.active), str(req.params.code, 40)]);
  res.json({ ok: true });
});

// ───────── Credit requests ─────────

router.get('/requests', async (req, res) => {
  const rows = await db.many(
    `SELECT r.*, u.name AS teacher_name, u.email AS teacher_email, u.credits AS teacher_credits, u.teacher_until
       FROM credit_requests r JOIN users u ON u.id = r.teacher_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 500`);
  res.json({ ok: true, requests: rows });
});

router.post('/requests/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'Request not found.');
  const r = await db.one('SELECT * FROM credit_requests WHERE id = $1', [req.params.id]);
  if (!r) throw fail(404, 'NOT_FOUND', 'Request not found.');
  if (r.status !== 'pending') throw fail(409, 'DONE', 'This request was already handled.');
  const b = req.body || {};
  if (b.action === 'approve') {
    const credits = int(b.credits, r.credits, 0, 100000);
    const days = int(b.days, 0, 0, 3650);
    if (!credits && !days) throw fail(400, 'BAD_INPUT', 'Enter credits or days to give.');
    await grant(r.teacher_id, { credits, days }, 'Approved request' + (r.reference ? ' (ref ' + r.reference + ')' : ''));
    await db.query(`UPDATE credit_requests SET status = 'approved', credits = $1, handled_by = $2, handled_at = now() WHERE id = $3`, [credits, req.user.id, r.id]);
  } else {
    await db.query(`UPDATE credit_requests SET status = 'rejected', handled_by = $1, handled_at = now() WHERE id = $2`, [req.user.id, r.id]);
  }
  res.json({ ok: true });
});

// ───────── Settings ─────────

router.get('/settings', async (req, res) => res.json({ ok: true, settings: await getSettings() }));
router.post('/settings', async (req, res) => res.json({ ok: true, settings: await saveSettings(req.body || {}) }));

module.exports = router;
