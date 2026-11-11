// Teacher: account & credits, classes, question bank, pictures, exams, results.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings, parsePackages } = require('../settings');
const paypal = require('../paypal');
const { fail, str, int, bool, isUuid, randomCode, toCsv, parseCsv } = require('../util');
const { redeemCode, grantWith } = require('./codes');

const router = express.Router();
router.use(auth.requireRole('teacher', 'admin'));

const mine = async (table, id, teacherId, what) => {
  if (!isUuid(id)) throw fail(404, 'NOT_FOUND', what + ' not found.');
  const row = await db.one(`SELECT * FROM ${table} WHERE id = $1 AND teacher_id = $2`, [id, teacherId]);
  if (!row) throw fail(404, 'NOT_FOUND', what + ' not found.');
  return row;
};

// ───────── Account, codes, credits ─────────

/** Payment text without empty "Label:" lines; empty when nothing is filled in (then only the QR code is shown). */
function shownText(text) {
  return String(text || '').split(/\r?\n/).filter((l) => !/^[^:]{1,40}:\s*$/.test(l)).join('\n').trim();
}

/** The payment methods the admin turned on, with what teachers need to see for each. */
function paymentMethods(s) {
  if (!s.paymentsEnabled) return [];
  const pp = paypal.config();
  const m = [];
  if (s.bankEnabled) m.push({ id: 'bank', label: 'Bank transfer', details: shownText(s.bankDetails), qr: s.bankQr || null });
  if (s.paypalEnabled && (pp || s.paypalLink)) {
    m.push({ id: 'paypal', label: 'PayPal', link: s.paypalLink || '', checkout: pp ? { clientId: pp.clientId, sandbox: pp.sandbox } : null });
  }
  if (s.otherEnabled) m.push({ id: 'other', label: 'GCash / other', details: shownText(s.paymentInstructions), qr: s.otherQr || null });
  return m;
}

router.get('/account', async (req, res) => {
  const s = await getSettings();
  res.json({
    ok: true,
    user: auth.publicUser(req.user),
    ledger: await db.many('SELECT * FROM credit_ledger WHERE teacher_id = $1 ORDER BY at DESC LIMIT 50', [req.user.id]),
    requests: await db.many(`SELECT id, kind, credits, reference, message, status, method, amount, currency, proof_image_id, created_at, handled_at
      FROM credit_requests WHERE teacher_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]),
    paymentsEnabled: !!s.paymentsEnabled,
    packages: parsePackages(s.creditPackages),
    currency: s.currency,
    methods: paymentMethods(s),
    supportContact: s.supportContact,
  });
});

router.post('/redeem', async (req, res) => {
  const message = await redeemCode(req.user.id, req.body && req.body.code);
  res.json({ ok: true, message, user: auth.publicUser(await auth.userById(req.user.id)) });
});

router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const s = await getSettings();
  const kind = b.kind === 'access' ? 'access' : 'credits';
  const credits = kind === 'credits' ? int(b.credits, 0, 1, 10000) : 0;
  if (kind === 'credits' && !credits) throw fail(400, 'BAD_INPUT', 'Enter how many credits you need.');
  const days = kind === 'access' ? int(b.days, 0, 0, 3650) : 0;
  let method = null, amount = null;
  if (kind === 'credits') {
    const methods = paymentMethods(s).map((x) => x.id);
    method = methods.includes(b.method) ? b.method : null;
    if (methods.length && !method) throw fail(400, 'BAD_INPUT', 'Choose how you paid.');
    const pack = parsePackages(s.creditPackages).find((p) => p.credits === credits);
    amount = pack ? pack.price : null;
  }
  const reference = str(b.reference, 120) || null;
  if (kind === 'credits' && s.paymentsEnabled && !reference && !isUuid(b.proofImageId)) throw fail(400, 'BAD_INPUT', 'Enter the payment reference number, or attach a picture of your receipt.');
  let proof = null;
  if (isUuid(b.proofImageId)) proof = (await mine('images', b.proofImageId, req.user.id, 'Receipt picture')).id;
  const pending = await db.one(`SELECT count(*)::int AS n FROM credit_requests WHERE teacher_id = $1 AND status = 'pending'`, [req.user.id]);
  if (pending.n >= 5) throw fail(429, 'TOO_MANY', 'You already have 5 requests waiting. Please wait for the administrator.');
  await db.query(`INSERT INTO credit_requests (teacher_id, kind, credits, reference, message, method, amount, currency, proof_image_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [req.user.id, kind, credits, reference, ((days ? 'Requested ' + days + ' days. ' : '') + str(b.message, 1000)).trim() || null, method, amount, amount === null ? null : s.currency, proof]);
  res.json({ ok: true });
});

// The QR code a teacher scans to pay (only signed-in teachers can see it).
router.get('/payment-qr/:method', async (req, res) => {
  const s = await getSettings();
  const id = req.params.method === 'bank' ? (s.bankEnabled && s.bankQr) : req.params.method === 'other' ? (s.otherEnabled && s.otherQr) : null;
  const img = isUuid(id) ? await db.one('SELECT mime, data FROM images WHERE id = $1', [id]) : null;
  if (!img) throw fail(404, 'NOT_FOUND', 'No QR code.');
  res.set('Content-Type', img.mime).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(img.data));
});

// PayPal checkout: the teacher pays in a PayPal window and the credits are added at once.
async function paypalPackage(credits) {
  const s = await getSettings();
  if (!s.paymentsEnabled || !s.paypalEnabled || !paypal.config()) throw fail(400, 'PAYPAL_OFF', 'PayPal checkout is not available on this site.');
  const pack = parsePackages(s.creditPackages).find((p) => p.credits === Number(credits));
  if (!pack) throw fail(400, 'BAD_INPUT', 'Choose one of the credit packages.');
  return { s, pack };
}

router.post('/paypal/order', async (req, res) => {
  const { s, pack } = await paypalPackage(req.body && req.body.credits);
  const id = await paypal.createOrder({ teacherId: req.user.id, credits: pack.credits, price: pack.price, currency: s.currency, siteName: s.siteName });
  res.json({ ok: true, id });
});

router.post('/paypal/capture', async (req, res) => {
  const orderId = str(req.body && req.body.orderId, 64);
  if (!/^[A-Z0-9-]{5,64}$/i.test(orderId)) throw fail(400, 'BAD_INPUT', 'Unknown PayPal order.');
  const done = await db.one('SELECT teacher_id, credits FROM credit_requests WHERE paypal_order_id = $1', [orderId]);
  if (done) {
    if (done.teacher_id !== req.user.id) throw fail(404, 'NOT_FOUND', 'Unknown PayPal order.');
    return res.json({ ok: true, credits: done.credits, already: true, user: auth.publicUser(await auth.userById(req.user.id)) });
  }
  const c = await paypal.captureOrder(orderId);
  const [teacherId, creditsText] = String(c.customId).split(':');
  if (teacherId !== req.user.id) throw fail(404, 'NOT_FOUND', 'This PayPal payment belongs to another account.');
  if (c.status !== 'COMPLETED') {
    throw fail(402, 'PAYMENT_PENDING', c.status === 'PENDING'
      ? 'PayPal is still checking this payment. Your credits will be added by the administrator once it clears (PayPal order ' + orderId + ').'
      : 'PayPal did not complete the payment (' + (c.status || 'unknown') + '). No credits were added.');
  }
  const s = await getSettings();
  const credits = Number(creditsText);
  const pack = parsePackages(s.creditPackages).find((p) => p.credits === credits);
  // The price is checked against the package at the time of payment; a mismatch goes to the admin instead.
  const matches = pack && c.currency === s.currency && Math.abs(c.amount - pack.price) < 0.005;
  const added = await db.tx(async (t) => {
    const row = (await t.query(`INSERT INTO credit_requests (teacher_id, kind, credits, reference, message, method, amount, currency, paypal_order_id, status, handled_at)
      VALUES ($1, 'credits', $2, $3, $4, 'paypal', $5, $6, $7, $8, $9) ON CONFLICT (paypal_order_id) DO NOTHING RETURNING id`,
    [req.user.id, credits, c.captureId || orderId, matches ? 'Paid with PayPal checkout' : 'Paid with PayPal, but the amount did not match the package. Please check.',
      c.amount || null, c.currency || null, orderId, matches ? 'approved' : 'pending', matches ? new Date() : null])).rows[0];
    if (row && matches) await grantWith(t, req.user.id, { credits }, 'PayPal payment (' + (c.captureId || orderId) + ')');
    return row ? (matches ? credits : 0) : null;
  });
  if (added === 0) throw fail(409, 'CHECK_NEEDED', 'Payment received, but the amount did not match the package. The administrator will check it and add your credits.');
  res.json({ ok: true, credits, already: added === null, user: auth.publicUser(await auth.userById(req.user.id)) });
});

// ───────── Classes ─────────

async function newJoinCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(6);
    if (!(await db.one('SELECT 1 FROM classes WHERE join_code = $1', [code]))) return code;
  }
  throw fail(500, 'SERVER_ERROR', 'Could not create a class code. Try again.');
}

router.get('/classes', async (req, res) => {
  res.json({ ok: true, classes: await db.many(
    `SELECT c.*, (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id)::int AS student_count,
            (SELECT count(*) FROM exams x WHERE x.class_id = c.id)::int AS exam_count
       FROM classes c WHERE c.teacher_id = $1 ORDER BY c.archived, c.created_at DESC`, [req.user.id]) });
});

router.post('/classes', async (req, res) => {
  const name = str(req.body && req.body.name, 120);
  if (!name) throw fail(400, 'BAD_INPUT', 'Enter a class name, e.g. EEE 150.');
  const row = await db.one('INSERT INTO classes (teacher_id, name, section, join_code) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.user.id, name, str(req.body.section, 120) || null, await newJoinCode()]);
  res.json({ ok: true, class: row });
});

router.post('/classes/:id', async (req, res) => {
  const c = await mine('classes', req.params.id, req.user.id, 'Class');
  const b = req.body || {};
  if (b.delete) {
    const n = await db.one('SELECT count(*)::int AS n FROM exams WHERE class_id = $1', [c.id]);
    if (n.n) throw fail(409, 'IN_USE', 'This class has exams. Archive it instead, or delete its exams first.');
    await db.query('DELETE FROM classes WHERE id = $1', [c.id]);
    return res.json({ ok: true, deleted: true });
  }
  await db.query('UPDATE classes SET name = $1, section = $2, archived = $3, join_code = $4 WHERE id = $5',
    [str(b.name, 120) || c.name, b.section === undefined ? c.section : str(b.section, 120) || null,
      b.archived === undefined ? c.archived : !!b.archived, b.newCode ? await newJoinCode() : c.join_code, c.id]);
  res.json({ ok: true, class: await db.one('SELECT * FROM classes WHERE id = $1', [c.id]) });
});

router.get('/classes/:id/students', async (req, res) => {
  const c = await mine('classes', req.params.id, req.user.id, 'Class');
  res.json({ ok: true, students: (await db.many(
    `SELECT u.id, u.name, u.email, u.student_no, e.joined_at, (SELECT updated_at FROM avatars a WHERE a.user_id = u.id) AS avatar_updated
       FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 ORDER BY u.name`, [c.id])).map((s) => Object.assign(s, { avatarUrl: auth.avatarUrl(s.id, s.avatar_updated) })) });
});

router.post('/classes/:id/students/:sid/remove', async (req, res) => {
  const c = await mine('classes', req.params.id, req.user.id, 'Class');
  if (!isUuid(req.params.sid)) throw fail(404, 'NOT_FOUND', 'Student not found.');
  await db.query('DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2', [c.id, req.params.sid]);
  res.json({ ok: true });
});

// ───────── Pictures ─────────

router.post('/images', express.json({ limit: '4mb' }), async (req, res) => {
  const m = String((req.body && req.body.dataUrl) || '').match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw fail(400, 'BAD_INPUT', 'That file is not a JPEG, PNG, GIF or WebP picture.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > core.MAX_IMAGE_BYTES) throw fail(413, 'TOO_LARGE', 'The picture is larger than 2 MB.');
  const row = await db.one('INSERT INTO images (teacher_id, mime, bytes, data) VALUES ($1,$2,$3,$4) RETURNING id, bytes', [req.user.id, m[1], bytes.length, bytes]);
  res.json({ ok: true, image: row });
});

router.get('/images/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(404, 'NOT_FOUND', 'Picture not found.');
  const img = await db.one('SELECT mime, data FROM images WHERE id = $1 AND teacher_id = $2', [req.params.id, req.user.id]);
  if (!img) throw fail(404, 'NOT_FOUND', 'Picture not found.');
  res.set('Content-Type', img.mime).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(img.data));
});

// ───────── Question bank ─────────

function questionInput(b) {
  const type = core.normType(b.type) || str(b.type, 10).toUpperCase();
  const choices = type === 'MC'
    ? (Array.isArray(b.choices) ? b.choices : String(b.choices || '').split('|')).map((c) => str(c, 1000)).filter(Boolean).slice(0, 10)
    : [];
  const imageUrl = str(b.imageUrl, 2000) || null;
  if (imageUrl && !core.externalImageUrl(imageUrl)) throw fail(400, 'BAD_INPUT', 'The picture link must start with https://');
  return {
    code: str(b.code, 60),
    type,
    text: str(b.text, 10000),
    choices,
    answer: type === 'TF' ? (core.parseTF(b.answer) === null ? str(b.answer, 10) : (core.parseTF(b.answer) ? 'TRUE' : 'FALSE')) : str(b.answer, 4000),
    points: Number(b.points) > 0 ? Math.min(1000, Number(b.points)) : 1,
    topic: str(b.topic, 120),
    imageId: isUuid(b.imageId) ? b.imageId : null,
    imageUrl: b.imageId ? null : imageUrl,
    folderId: isUuid(b.folderId) ? b.folderId : null,
  };
}

async function nextQuestionCode(teacherId) {
  const rows = await db.many(`SELECT code FROM questions WHERE teacher_id = $1 AND code ~ '^Q[0-9]+$'`, [teacherId]);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(1))), 0);
  return 'Q' + String(max + 1).padStart(3, '0');
}

async function saveQuestion(teacherId, q, id) {
  const problems = core.validateQuestion(q);
  if (problems.length) throw fail(400, 'BAD_INPUT', 'Please fix: ' + problems.join('; ') + '.');
  if (q.imageId && !(await db.one('SELECT 1 FROM images WHERE id = $1 AND teacher_id = $2', [q.imageId, teacherId]))) {
    throw fail(400, 'BAD_INPUT', 'That picture was not found. Upload it again.');
  }
  if (q.folderId && !(await db.one('SELECT 1 FROM question_folders WHERE id = $1 AND teacher_id = $2', [q.folderId, teacherId]))) {
    throw fail(400, 'BAD_INPUT', 'That folder was not found.');
  }
  if (!q.code) q.code = await nextQuestionCode(teacherId);
  const clash = await db.one('SELECT id FROM questions WHERE teacher_id = $1 AND code = $2', [teacherId, q.code]);
  if (clash && clash.id !== id) throw fail(409, 'DUPLICATE', 'You already have a question with ID "' + q.code + '".');
  const vals = [q.code, q.type, q.text, JSON.stringify(q.choices), q.answer, q.points, q.topic, q.imageId, q.imageUrl, q.folderId];
  if (id) {
    return db.one(`UPDATE questions SET code=$1, type=$2, text=$3, choices=$4, answer=$5, points=$6, topic=$7, image_id=$8, image_url=$9, folder_id=$10, updated_at=now()
                    WHERE id = $11 AND teacher_id = $12 RETURNING *`, [...vals, id, teacherId]);
  }
  return db.one(`INSERT INTO questions (code, type, text, choices, answer, points, topic, image_id, image_url, folder_id, teacher_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...vals, teacherId]);
}

const questionOut = (r) => Object.assign(core.questionFromRow(r), { problems: core.validateQuestion(core.questionFromRow(r)), updatedAt: r.updated_at, folderId: r.folder_id || null });

// ───────── Question folders ─────────

router.get('/folders', async (req, res) => {
  res.json({ ok: true, folders: await db.many(
    `SELECT f.id, f.name, f.parent_id, (SELECT count(*) FROM questions q WHERE q.folder_id = f.id)::int AS question_count
       FROM question_folders f WHERE f.teacher_id = $1 ORDER BY lower(f.name)`, [req.user.id]) });
});

async function folderNameCheck(teacherId, parentId, name, exceptId) {
  if (!name) throw fail(400, 'BAD_INPUT', 'Enter a folder name.');
  const clash = await db.one(`SELECT 1 FROM question_folders WHERE teacher_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3) AND id IS DISTINCT FROM $4`,
    [teacherId, parentId, name, exceptId || null]);
  if (clash) throw fail(409, 'DUPLICATE', 'There is already a folder named "' + name + '" here.');
}

router.post('/folders', async (req, res) => {
  const name = str(req.body && req.body.name, 100);
  const parentId = isUuid(req.body && req.body.parentId) ? req.body.parentId : null;
  if (parentId) await mine('question_folders', parentId, req.user.id, 'Folder');
  await folderNameCheck(req.user.id, parentId, name);
  res.json({ ok: true, folder: await db.one('INSERT INTO question_folders (teacher_id, parent_id, name) VALUES ($1, $2, $3) RETURNING *', [req.user.id, parentId, name]) });
});

router.post('/folders/:id', async (req, res) => {
  const f = await mine('question_folders', req.params.id, req.user.id, 'Folder');
  const b = req.body || {};
  if (b.delete) {
    // Nothing is lost: questions and subfolders move up to the parent folder
    await db.tx(async (t) => {
      await t.query('UPDATE questions SET folder_id = $1 WHERE folder_id = $2', [f.parent_id, f.id]);
      await t.query('UPDATE question_folders SET parent_id = $1 WHERE parent_id = $2', [f.parent_id, f.id]);
      await t.query('DELETE FROM question_folders WHERE id = $1', [f.id]);
    });
    return res.json({ ok: true, deleted: true });
  }
  let parentId = f.parent_id;
  if (b.parentId !== undefined) {
    parentId = isUuid(b.parentId) ? b.parentId : null;
    if (parentId) {
      await mine('question_folders', parentId, req.user.id, 'Folder');
      // A folder cannot go inside itself or one of its own subfolders
      for (let cur = parentId; cur;) {
        if (cur === f.id) throw fail(400, 'BAD_INPUT', 'A folder cannot be moved into itself or one of its subfolders.');
        cur = (await db.one('SELECT parent_id FROM question_folders WHERE id = $1', [cur]) || {}).parent_id;
      }
    }
  }
  const name = b.name === undefined ? f.name : str(b.name, 100);
  await folderNameCheck(req.user.id, parentId, name, f.id);
  res.json({ ok: true, folder: await db.one('UPDATE question_folders SET name = $1, parent_id = $2 WHERE id = $3 RETURNING *', [name, parentId, f.id]) });
});

/** Moves several questions into a folder (or out of all folders with folderId null). */
router.post('/questions/move', async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).filter(isUuid).slice(0, 5000);
  const folderId = isUuid(req.body && req.body.folderId) ? req.body.folderId : null;
  if (!ids.length) throw fail(400, 'BAD_INPUT', 'Select questions to move.');
  if (folderId) await mine('question_folders', folderId, req.user.id, 'Folder');
  const r = await db.query('UPDATE questions SET folder_id = $1, updated_at = now() WHERE teacher_id = $2 AND id = ANY($3::uuid[])', [folderId, req.user.id, ids]);
  res.json({ ok: true, moved: r.rowCount !== undefined ? r.rowCount : r.affectedRows });
});

/** Finds or creates folders from a path like "EEE 150/Midterm". Returns the last folder's id. */
async function folderFromPath(teacherId, path, cache) {
  const parts = String(path || '').split('/').map((p) => str(p, 100)).filter(Boolean);
  let parent = null;
  for (let i = 0; i < parts.length; i++) {
    const key = parts.slice(0, i + 1).join('/').toLowerCase();
    if (cache.has(key)) { parent = cache.get(key); continue; }
    const found = await db.one(`SELECT id FROM question_folders WHERE teacher_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)`, [teacherId, parent, parts[i]]);
    parent = found ? found.id : (await db.one('INSERT INTO question_folders (teacher_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id', [teacherId, parent, parts[i]])).id;
    cache.set(key, parent);
  }
  return parent;
}

async function folderPaths(teacherId) {
  const fs = await db.many('SELECT id, name, parent_id FROM question_folders WHERE teacher_id = $1', [teacherId]);
  const byId = new Map(fs.map((f) => [f.id, f]));
  const path = (id) => { const out = []; for (let f = byId.get(id), n = 0; f && n < 50; f = byId.get(f.parent_id), n++) out.unshift(f.name); return out.join('/'); };
  return path;
}

router.get('/questions', async (req, res) => {
  const rows = await db.many('SELECT * FROM questions WHERE teacher_id = $1 ORDER BY code', [req.user.id]);
  res.json({ ok: true, questions: rows.map(questionOut) });
});

router.post('/questions', async (req, res) => {
  res.json({ ok: true, question: questionOut(await saveQuestion(req.user.id, questionInput(req.body || {}))) });
});

/** Import from CSV with the same columns as the Google Sheet: QuestionID, Type, Question, Choices, Answer, Points, Topic, Image. */
router.post('/questions/import', express.json({ limit: '5mb' }), async (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length < 2) throw fail(400, 'BAD_INPUT', 'The file has no questions. The first row must be the column names.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = { code: col('questionid', 'id', 'code'), type: col('type'), text: col('question', 'text'), choices: col('choices', 'options'),
    answer: col('answer', 'correctanswer'), points: col('points', 'score'), topic: col('topic'), image: col('image', 'imageurl', 'picture'), folder: col('folder') };
  const targetFolder = isUuid(req.body && req.body.folderId) ? req.body.folderId : null;
  if (targetFolder) await mine('question_folders', targetFolder, req.user.id, 'Folder');
  const folderCache = new Map();
  if (ix.type < 0 || ix.text < 0) throw fail(400, 'BAD_INPUT', 'The first row must include at least "Type" and "Question" columns.');
  let created = 0, updated = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (ix[k] >= 0 ? r[ix[k]] : '');
    try {
      const q = questionInput({ code: get('code'), type: get('type'), text: get('text'), choices: get('choices'), answer: get('answer'),
        points: get('points'), topic: get('topic'), imageUrl: /^https?:\/\//i.test(String(get('image')).trim()) ? get('image') : '' });
      q.folderId = String(get('folder')).trim() ? await folderFromPath(req.user.id, get('folder'), folderCache) : targetFolder;
      const existing = q.code ? await db.one('SELECT id FROM questions WHERE teacher_id = $1 AND code = $2', [req.user.id, q.code]) : null;
      await saveQuestion(req.user.id, q, existing && existing.id);
      if (existing) updated++; else created++;
    } catch (e) {
      errors.push('Row ' + (i + 1) + ': ' + e.message);
    }
  }
  res.json({ ok: true, created, updated, errors });
});

router.post('/questions/:id', async (req, res) => {
  const q = await mine('questions', req.params.id, req.user.id, 'Question');
  if (req.body && req.body.delete) {
    const used = await db.many(`SELECT title FROM exams WHERE teacher_id = $1 AND question_ids @> $2::jsonb`, [req.user.id, JSON.stringify([q.id])]);
    if (used.length) throw fail(409, 'IN_USE', 'This question is used in: ' + used.map((e) => e.title).join(', ') + '. Remove it from those exams first.');
    await db.query('DELETE FROM questions WHERE id = $1', [q.id]);
    return res.json({ ok: true, deleted: true });
  }
  res.json({ ok: true, question: questionOut(await saveQuestion(req.user.id, questionInput(req.body || {}), q.id)) });
});

router.get('/questions/export.csv', async (req, res) => {
  const rows = await db.many('SELECT * FROM questions WHERE teacher_id = $1 ORDER BY code', [req.user.id]);
  const path = await folderPaths(req.user.id);
  const out = [['QuestionID', 'Type', 'Question', 'Choices', 'Answer', 'Points', 'Topic', 'Image', 'Folder']].concat(
    rows.map((r) => [r.code, r.type, r.text, (r.choices || []).join(' | '), r.answer, r.points, r.topic, r.image_url || (r.image_id ? '(uploaded picture)' : ''), r.folder_id ? path(r.folder_id) : '']));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="question-bank.csv"').send(toCsv(out));
});

// ───────── Exams ─────────

function examInput(b) {
  const date = (v) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw fail(400, 'BAD_INPUT', 'A date is not valid.'); return d; };
  const displayMode = b.displayMode === 'ONE' ? 'ONE' : 'ALL';
  const questionSeconds = displayMode === 'ONE' ? int(b.questionSeconds, 0, 0, 36000) : 0;
  const topicCounts = (Array.isArray(b.topicCounts) ? b.topicCounts : [])
    .map((t) => ({ topic: str(t.topic, 120), count: int(t.count, 0, 0, 10000) })).filter((t) => t.topic && t.count > 0);
  return {
    classId: b.classId,
    title: str(b.title, 200),
    instructions: str(b.instructions, 5000),
    questionIds: (Array.isArray(b.questionIds) ? b.questionIds : []).filter(isUuid).filter((v, i, a) => a.indexOf(v) === i),
    start: date(b.startAt),
    end: date(b.endAt),
    limitMin: Math.max(0, Math.min(10000, Number(b.timeLimitMinutes) || 0)),
    shuffleQ: bool(b.shuffleQuestions, true),
    shuffleC: bool(b.shuffleChoices, true),
    showScore: bool(b.showScore, true),
    displayMode,
    allowBack: displayMode === 'ONE' ? bool(b.allowBack, true) && !(questionSeconds > 0) : true,
    questionSeconds,
    pickCount: topicCounts.length ? 0 : int(b.pickCount, 0, 0, 10000),
    topicCounts,
    faceMode: ['START', 'ALWAYS'].includes(b.faceMode) ? b.faceMode : 'OFF',
    cameraPreview: bool(b.cameraPreview, true),
    allowedDevices: ['TABLET', 'ANY'].includes(b.allowedDevices) ? b.allowedDevices : 'COMPUTER',
    password: str(b.password, 60) || null,
    options: core.examOptions(b.options),
  };
}

/** Problems that stop an exam from being saved or published. */
async function examProblems(teacherId, e, forPublish) {
  const p = [];
  if (!e.title) p.push('enter a title');
  if (!isUuid(e.classId) || !(await db.one('SELECT 1 FROM classes WHERE id = $1 AND teacher_id = $2', [e.classId, teacherId]))) p.push('choose a class');
  if (e.start && e.end && e.end <= e.start) p.push('the closing time must be after the opening time');
  const qs = e.questionIds.length ? await db.many('SELECT * FROM questions WHERE teacher_id = $1 AND id = ANY($2::uuid[])', [teacherId, e.questionIds]) : [];
  if (qs.length !== e.questionIds.length) p.push('some selected questions no longer exist');
  if (forPublish) {
    if (!qs.length) p.push('select at least one question');
    qs.map(core.questionFromRow).forEach((q) => { const pr = core.validateQuestion(q); if (pr.length) p.push('question ' + q.code + ': ' + pr.join(', ')); });
  }
  if (e.pickCount > qs.length && qs.length) p.push('"questions per student" (' + e.pickCount + ') is more than the ' + qs.length + ' selected');
  e.topicCounts.forEach((tc) => {
    const n = qs.filter((q) => core.normTopic(q.topic) === core.normTopic(tc.topic)).length;
    if (tc.count > n) p.push('topic "' + tc.topic + '": ' + tc.count + ' requested but only ' + n + ' selected');
  });
  return p;
}

const examCols = (e) => [e.classId, e.title, e.instructions, JSON.stringify(e.questionIds), e.start, e.end, e.limitMin, e.shuffleQ, e.shuffleC, e.showScore,
  e.displayMode, e.allowBack, e.questionSeconds, e.pickCount, JSON.stringify(e.topicCounts), e.faceMode, e.cameraPreview, e.allowedDevices, e.password, JSON.stringify(e.options)];

router.get('/exams', async (req, res) => {
  res.json({ ok: true, exams: await db.many(
    `SELECT x.id, x.title, x.class_id, c.name AS class_name, c.section AS class_section, x.start_at, x.end_at, x.time_limit_min,
            jsonb_array_length(x.question_ids) AS question_count, x.pick_count, x.topic_counts, x.published, x.face_mode, x.display_mode,
            x.allowed_devices, x.updated_at,
            (SELECT count(*) FROM attempts a WHERE a.exam_id = x.id)::int AS attempt_count,
            (SELECT count(*) FROM attempts a WHERE a.exam_id = x.id AND a.status = 'SUBMITTED')::int AS submitted_count
       FROM exams x JOIN classes c ON c.id = x.class_id WHERE x.teacher_id = $1 ORDER BY x.created_at DESC`, [req.user.id]) });
});

router.get('/exams/:id', async (req, res) => {
  res.json({ ok: true, exam: await mine('exams', req.params.id, req.user.id, 'Exam') });
});

router.post('/exams', async (req, res) => {
  const e = examInput(req.body || {});
  const p = await examProblems(req.user.id, e, false);
  if (p.length) throw fail(400, 'BAD_INPUT', 'Please fix: ' + p.join('; ') + '.');
  const row = await db.one(`INSERT INTO exams (class_id, title, instructions, question_ids, start_at, end_at, time_limit_min, shuffle_q, shuffle_c, show_score,
      display_mode, allow_back, question_seconds, pick_count, topic_counts, face_mode, camera_preview, allowed_devices, password, options, teacher_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`, [...examCols(e), req.user.id]);
  res.json({ ok: true, exam: row });
});

router.post('/exams/:id', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  const b = req.body || {};
  if (b.delete) {
    const n = await db.one('SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1', [x.id]);
    if (n.n && !b.confirmDeleteResults) throw fail(409, 'HAS_RESULTS', 'This exam has ' + n.n + ' attempt(s). Deleting it also deletes those results.');
    await db.query('DELETE FROM exams WHERE id = $1', [x.id]);
    return res.json({ ok: true, deleted: true });
  }
  if (b.duplicate) {
    const copy = await db.one(`INSERT INTO exams (teacher_id, class_id, title, instructions, question_ids, start_at, end_at, time_limit_min, shuffle_q, shuffle_c, show_score,
        display_mode, allow_back, question_seconds, pick_count, topic_counts, face_mode, camera_preview, allowed_devices, password, options)
      SELECT teacher_id, class_id, title || ' (copy)', instructions, question_ids, start_at, end_at, time_limit_min, shuffle_q, shuffle_c, show_score,
        display_mode, allow_back, question_seconds, pick_count, topic_counts, face_mode, camera_preview, allowed_devices, password, options
      FROM exams WHERE id = $1 RETURNING *`, [x.id]);
    return res.json({ ok: true, exam: copy });
  }
  if (b.publish !== undefined) {
    if (!b.publish) {
      await db.query('UPDATE exams SET published = false, updated_at = now() WHERE id = $1', [x.id]);
      return res.json({ ok: true, exam: await db.one('SELECT * FROM exams WHERE id = $1', [x.id]) });
    }
    const e = examInput({
      classId: x.class_id, title: x.title, instructions: x.instructions, questionIds: x.question_ids, startAt: x.start_at, endAt: x.end_at,
      timeLimitMinutes: x.time_limit_min, displayMode: x.display_mode, allowBack: x.allow_back, questionSeconds: x.question_seconds,
      pickCount: x.pick_count, topicCounts: x.topic_counts, options: x.options,
    });
    const p = await examProblems(req.user.id, e, true);
    if (p.length) throw fail(400, 'BAD_INPUT', 'Before publishing, please fix: ' + p.join('; ') + '.');
    const charged = await db.tx(async (t) => {
      const u = (await t.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
      const ex = (await t.query('SELECT credit_spent FROM exams WHERE id = $1 FOR UPDATE', [x.id])).rows[0];
      const a = auth.teacherAccess(u);
      let charge = false;
      if (!ex.credit_spent && !a.isAdmin && !a.timeOk) {
        if (a.credits < 1) throw fail(402, 'NO_CREDITS', 'You need an access code or 1 credit to publish this exam. Go to My account to redeem an access code or request one.');
        await t.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [u.id]);
        await t.query('INSERT INTO credit_ledger (teacher_id, credits, reason) VALUES ($1, -1, $2)', [u.id, 'Published "' + x.title + '"']);
        charge = true;
      }
      await t.query('UPDATE exams SET published = true, published_at = COALESCE(published_at, now()), credit_spent = credit_spent OR $2, updated_at = now() WHERE id = $1', [x.id, charge || a.timeOk || a.isAdmin]);
      return charge;
    });
    return res.json({ ok: true, charged, exam: await db.one('SELECT * FROM exams WHERE id = $1', [x.id]), user: auth.publicUser(await auth.userById(req.user.id)) });
  }
  const e = examInput(b);
  const p = await examProblems(req.user.id, e, x.published);
  if (p.length) throw fail(400, 'BAD_INPUT', 'Please fix: ' + p.join('; ') + '.');
  const row = await db.one(`UPDATE exams SET class_id=$1, title=$2, instructions=$3, question_ids=$4, start_at=$5, end_at=$6, time_limit_min=$7, shuffle_q=$8,
      shuffle_c=$9, show_score=$10, display_mode=$11, allow_back=$12, question_seconds=$13, pick_count=$14, topic_counts=$15, face_mode=$16,
      camera_preview=$17, allowed_devices=$18, password=$19, options=$20, updated_at=now() WHERE id = $21 RETURNING *`, [...examCols(e), x.id]);
  res.json({ ok: true, exam: row });
});

// ───────── Results ─────────

router.get('/exams/:id/results', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  const attempts = await db.many(
    `SELECT a.*, u.name AS student_name, u.email AS student_email, u.student_no,
            (SELECT count(*) FROM violations v WHERE v.attempt_id = a.id)::int AS event_count,
            (SELECT updated_at FROM avatars av WHERE av.user_id = u.id) AS avatar_updated
       FROM attempts a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 ORDER BY u.name, a.started_at`, [x.id]);
  attempts.forEach((a) => { a.avatarUrl = auth.avatarUrl(a.student_id, a.avatar_updated); });
  const notStarted = await db.many(
    `SELECT u.id, u.name, u.email, u.student_no, (SELECT updated_at FROM avatars av WHERE av.user_id = u.id) AS avatar_updated
       FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.exam_id = $2 AND a.student_id = u.id) ORDER BY lower(u.name)`, [x.class_id, x.id]);
  notStarted.forEach((s) => { s.avatarUrl = auth.avatarUrl(s.id, s.avatar_updated); });
  res.json({ ok: true, exam: { id: x.id, title: x.title, published: x.published, showScore: x.show_score }, attempts, notStarted });
});

// ───────── Preview: the teacher tries the exam as a student would. Nothing is saved. ─────────

async function previewPool(req) {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  const exam = core.examConfig(x);
  const rows = exam.questionIds.length ? await db.many('SELECT * FROM questions WHERE teacher_id = $1 AND id = ANY($2::uuid[])', [req.user.id, exam.questionIds]) : [];
  const byId = new Map(rows.map((r) => [r.id, core.questionFromRow(r)]));
  return { x, exam, pool: exam.questionIds.map((id) => byId.get(id)).filter(Boolean) };
}

router.get('/exams/:id/preview', async (req, res) => {
  const { x, exam, pool } = await previewPool(req);
  const asStudent = req.query.mode === 'student';
  const seed = 'preview:' + str(req.query.seed, 40);
  const qs = asStudent ? core.attemptQuestions(exam, pool, seed) : pool;
  const cls = await db.one('SELECT name, section FROM classes WHERE id = $1', [x.class_id]);
  res.json({
    ok: true,
    exam: {
      id: x.id, title: exam.title, instructions: exam.instructions, published: x.published,
      className: cls ? cls.name + (cls.section ? ' — ' + cls.section : '') : '',
      timeLimitMinutes: exam.limitMin, displayMode: exam.displayMode, allowBack: exam.allowBack, faceMode: exam.faceMode,
      hasPassword: !!exam.password, poolSize: pool.length, summary: core.setSummary(exam, pool),
    },
    questions: qs.map((q) => {
      const p = core.publicQuestion(q, asStudent ? exam : Object.assign({}, exam, { shuffleChoices: false }), seed);
      if (q.imageId) p.image = { src: '/api/teacher/images/' + q.imageId };
      return Object.assign(p, { code: q.code, topic: q.topic, problems: core.validateQuestion(q) });
    }),
  });
});

router.post('/exams/:id/preview/check', async (req, res) => {
  const { pool } = await previewPool(req);
  const answers = (req.body && typeof req.body.answers === 'object' && req.body.answers) || {};
  const ids = Array.isArray(req.body && req.body.questionIds) ? req.body.questionIds.map(String) : pool.map((q) => q.id);
  const results = {};
  let score = 0, max = 0, pending = 0;
  pool.filter((q) => ids.includes(q.id)).forEach((q) => {
    const g = core.gradeQuestion(q, answers[q.id]);
    results[q.id] = { correct: g.correct, pending: g.pending, points: g.points, max: q.points, yourAnswer: g.studentText, correctAnswer: g.correctText };
    score += g.points; max += q.points; if (g.pending) pending++;
  });
  res.json({ ok: true, results, score, max, pending });
});

router.get('/exams/:id/attempts/:aid', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  if (!isUuid(req.params.aid)) throw fail(404, 'NOT_FOUND', 'Attempt not found.');
  const a = await db.one(`SELECT a.*, u.name AS student_name, u.email AS student_email, u.student_no FROM attempts a JOIN users u ON u.id = a.student_id
                           WHERE a.id = $1 AND a.exam_id = $2`, [req.params.aid, x.id]);
  if (!a) throw fail(404, 'NOT_FOUND', 'Attempt not found.');
  res.json({
    ok: true, attempt: a,
    responses: await db.many('SELECT * FROM responses WHERE attempt_id = $1 ORDER BY position', [a.id]),
    events: await db.many('SELECT * FROM violations WHERE attempt_id = $1 ORDER BY at', [a.id]),
    snapshots: await db.many('SELECT id, event, bytes, at FROM attempt_snapshots WHERE attempt_id = $1 ORDER BY at', [a.id]),
  });
});

router.get('/exams/:id/attempts/:aid/snapshots/:sid', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  if (!isUuid(req.params.aid) || !isUuid(req.params.sid)) throw fail(404, 'NOT_FOUND', 'Picture not found.');
  const img = await db.one(`SELECT s.mime, s.data FROM attempt_snapshots s JOIN attempts a ON a.id = s.attempt_id
                             WHERE s.id = $1 AND a.id = $2 AND a.exam_id = $3`, [req.params.sid, req.params.aid, x.id]);
  if (!img) throw fail(404, 'NOT_FOUND', 'Picture not found.');
  res.set('Content-Type', img.mime).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(img.data));
});

router.post('/exams/:id/attempts/:aid', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  if (!isUuid(req.params.aid)) throw fail(404, 'NOT_FOUND', 'Attempt not found.');
  const a = await db.one('SELECT * FROM attempts WHERE id = $1 AND exam_id = $2', [req.params.aid, x.id]);
  if (!a) throw fail(404, 'NOT_FOUND', 'Attempt not found.');
  const b = req.body || {};
  if (b.allowRetake !== undefined) {
    await db.query('UPDATE attempts SET allow_retake = $1 WHERE id = $2', [!!b.allowRetake, a.id]);
  }
  if (b.grade) {
    // b.grade = { questionId: points or null }
    for (const [qid, pts] of Object.entries(b.grade)) {
      if (!isUuid(qid)) continue;
      const r = await db.one('SELECT max_points FROM responses WHERE attempt_id = $1 AND question_id = $2', [a.id, qid]);
      if (!r) continue;
      const v = pts === null || pts === '' ? null : Math.max(0, Math.min(Number(r.max_points), Number(pts)));
      if (v !== null && !Number.isFinite(v)) throw fail(400, 'BAD_INPUT', 'Points must be a number.');
      await db.query('UPDATE responses SET points_earned = $1, is_correct = CASE WHEN $1::float8 IS NULL THEN is_correct ELSE $1::float8 >= max_points END WHERE attempt_id = $2 AND question_id = $3', [v, a.id, qid]);
    }
    await db.query(`UPDATE attempts SET
        score = (SELECT COALESCE(sum(points_earned), 0) FROM responses WHERE attempt_id = $1),
        max_score = (SELECT COALESCE(sum(max_points), 0) FROM responses WHERE attempt_id = $1),
        pending_essays = (SELECT count(*) FROM responses WHERE attempt_id = $1 AND points_earned IS NULL),
        percent = CASE WHEN (SELECT sum(max_points) FROM responses WHERE attempt_id = $1) > 0
                       THEN round(((SELECT COALESCE(sum(points_earned), 0) FROM responses WHERE attempt_id = $1)
                             / (SELECT sum(max_points) FROM responses WHERE attempt_id = $1) * 100)::numeric, 2)::float8 ELSE 0 END
      WHERE id = $1`, [a.id]);
  }
  res.json({ ok: true, attempt: await db.one('SELECT * FROM attempts WHERE id = $1', [a.id]) });
});

router.get('/exams/:id/export.csv', async (req, res) => {
  const x = await mine('exams', req.params.id, req.user.id, 'Exam');
  let out;
  if (req.query.detail) {
    const rows = await db.many(`SELECT u.name, u.student_no, u.email, a.status, r.position, r.type, r.question_text, r.student_answer, r.correct_answer, r.is_correct, r.points_earned, r.max_points
        FROM responses r JOIN attempts a ON a.id = r.attempt_id JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 ORDER BY u.name, a.started_at, r.position`, [x.id]);
    out = [['Student', 'Student No.', 'Email', 'Status', 'No.', 'Type', 'Question', 'Answer', 'Correct answer', 'Correct?', 'Points', 'Max points']]
      .concat(rows.map((r) => [r.name, r.student_no, r.email, r.status, r.position + 1, r.type, r.question_text, r.student_answer, r.correct_answer,
        r.is_correct === null ? '' : r.is_correct ? 'Yes' : 'No', r.points_earned === null ? 'to grade' : r.points_earned, r.max_points]));
  } else {
    const rows = await db.many(`SELECT u.name, u.student_no, u.email, a.* FROM attempts a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 ORDER BY u.name, a.started_at`, [x.id]);
    out = [['Student', 'Student No.', 'Email', 'Status', 'Score', 'Max', 'Percent', 'Essays to grade', 'Started', 'Submitted', 'Late', 'Void reason', 'Warnings', 'Reconnects', 'Device', 'Retake']]
      .concat(rows.map((r) => [r.name, r.student_no, r.email, r.status, r.score, r.max_score, r.percent, r.pending_essays, r.started_at, r.submitted_at,
        r.late ? 'Yes' : '', r.void_reason, r.warnings, r.reconnects, r.device, r.is_retake ? 'Yes' : '']));
  }
  const name = x.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'exam';
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}${req.query.detail ? '-answers' : '-results'}.csv"`).send(toCsv(out));
});

module.exports = router;
