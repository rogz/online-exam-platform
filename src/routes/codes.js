// Access codes and credits (used by teacher and admin routes).
const db = require('../db');
const { fail, str } = require('../util');

/** Applies an access code to a teacher. Returns a sentence describing what was added. */
async function redeemCode(userId, rawCode) {
  const code = str(rawCode, 40).toUpperCase().replace(/\s+/g, '');
  if (!code) throw fail(400, 'BAD_INPUT', 'Enter an access code.');
  return db.tx(async (t) => {
    const c = (await t.query('SELECT * FROM access_codes WHERE code = $1 FOR UPDATE', [code])).rows[0];
    if (!c || !c.active) throw fail(404, 'BAD_CODE', 'That access code is not valid.');
    if (c.expires_at && new Date(c.expires_at) < new Date()) throw fail(410, 'CODE_EXPIRED', 'That access code has expired.');
    if (c.uses >= c.max_uses) throw fail(410, 'CODE_USED', 'That access code has already been used.');
    if ((await t.query('SELECT 1 FROM code_redemptions WHERE code = $1 AND user_id = $2', [code, userId])).rows.length) {
      throw fail(409, 'CODE_USED', 'You have already used this access code.');
    }
    const u = (await t.query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || u.role === 'student') throw fail(403, 'FORBIDDEN', 'Access codes are for teacher accounts.');
    await t.query('UPDATE access_codes SET uses = uses + 1 WHERE code = $1', [code]);
    await t.query('INSERT INTO code_redemptions (code, user_id) VALUES ($1, $2)', [code, userId]);
    if (c.kind === 'days') {
      await t.query(`UPDATE users SET teacher_until = GREATEST(COALESCE(teacher_until, now()), now()) + ($1 || ' days')::interval WHERE id = $2`, [String(c.amount), userId]);
      await t.query('INSERT INTO credit_ledger (teacher_id, days, reason) VALUES ($1, $2, $3)', [userId, c.amount, 'Access code ' + code]);
      return 'Access code applied: ' + c.amount + ' day' + (c.amount === 1 ? '' : 's') + ' of full access.';
    }
    await t.query('UPDATE users SET credits = credits + $1 WHERE id = $2', [c.amount, userId]);
    await t.query('INSERT INTO credit_ledger (teacher_id, credits, reason) VALUES ($1, $2, $3)', [userId, c.amount, 'Access code ' + code]);
    return 'Access code applied: ' + c.amount + ' credit' + (c.amount === 1 ? '' : 's') + ' added.';
  });
}

/** Admin adds credits and/or days of access to a teacher. */
async function grant(teacherId, amounts, reason) {
  return db.tx((t) => grantWith(t, teacherId, amounts, reason));
}

/** Same as grant(), inside a transaction you already have. */
async function grantWith(t, teacherId, { credits = 0, days = 0 }, reason) {
  if (credits) await t.query('UPDATE users SET credits = GREATEST(0, credits + $1) WHERE id = $2', [credits, teacherId]);
  if (days > 0) await t.query(`UPDATE users SET teacher_until = GREATEST(COALESCE(teacher_until, now()), now()) + ($1 || ' days')::interval WHERE id = $2`, [String(days), teacherId]);
  if (days < 0) await t.query(`UPDATE users SET teacher_until = teacher_until - ($1 || ' days')::interval WHERE id = $2`, [String(-days), teacherId]);
  await t.query('INSERT INTO credit_ledger (teacher_id, credits, days, reason) VALUES ($1, $2, $3, $4)', [teacherId, credits, days, reason]);
}

module.exports = { redeemCode, grant, grantWith };
