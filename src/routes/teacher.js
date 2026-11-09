// Teacher: account & credits, classes, question bank, pictures, exams, results.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings } = require('../settings');
const { fail, str, int, bool, isUuid, randomCode, toCsv, parseCsv } = require('../util');
const { redeemCode } = require('./codes');

const router = express.Router();
router.use(auth.requireRole('teacher', 'admin'));

const mine = async (table, id, teacherId, what) => {
  if (!isUuid(id)) throw fail(404, 'NOT_FOUND', what + ' not found.');
  const row = await db.one(`SELECT * FROM ${table} WHERE id = $1 AND teacher_id = $2`, [id, teacherId]);
  if (!row) throw fail(404, 'NOT_FOUND', what + ' not found.');
  return row;
};

// ───────── Account, codes, credits ─────────

router.get('/account', async (req, res) => {
  const s = await getSettings();
  res.json({
    ok: true,
    user: auth.publicUser(req.user),
    ledger: await db.many('SELECT * FROM credit_ledger WHERE teacher_id = $1 ORDER BY at DESC LIMIT 50', [req.user.id]),
    requests: await db.many('SELECT * FROM credit_requests WHERE teacher_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]),
    paymentInstructions: s.paymentInstructions,
    creditPackages: s.creditPackages,
    supportContact: s.supportContact,
  });
});

router.post('/redeem', async (req, res) => {
  const message = await redeemCode(req.user.id, req.body && req.body.code);
  res.json({ ok: true, message, user: auth.publicUser(await db.one('SELECT * FROM users WHERE id = $1', [req.user.id])) });
});

router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'access' ? 'access' : 'credits';
  const credits = kind === 'credits' ? int(b.credits, 0, 1, 10000) : 0;
  if (kind === 'credits' && !credits) throw fail(400, 'BAD_INPUT', 'Enter how many credits you are buying.');
  const pending = await db.one(`SELECT count(*)::int AS n FROM credit_requests WHERE teacher_id = $1 AND status = 'pending'`, [req.user.id]);
  if (pending.n >= 5) throw fail(429, 'TOO_MANY', 'You already have 5 requests waiting. Please wait for the administrator.');
  await db.query('INSERT INTO credit_requests (teacher_id, kind, credits, reference, message) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, kind, credits, str(b.reference, 120) || null, str(b.message, 1000) || null]);
  res.json({ ok: true });
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
  res.json({ ok: true, students: await db.many(
    `SELECT u.id, u.name, u.email, u.student_no, e.joined_at FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 ORDER BY u.name`, [c.id]) });
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
  if (!q.code) q.code = await nextQuestionCode(teacherId);
  const clash = await db.one('SELECT id FROM questions WHERE teacher_id = $1 AND code = $2', [teacherId, q.code]);
  if (clash && clash.id !== id) throw fail(409, 'DUPLICATE', 'You already have a question with ID "' + q.code + '".');
  const vals = [q.code, q.type, q.text, JSON.stringify(q.choices), q.answer, q.points, q.topic, q.imageId, q.imageUrl];
  if (id) {
    return db.one(`UPDATE questions SET code=$1, type=$2, text=$3, choices=$4, answer=$5, points=$6, topic=$7, image_id=$8, image_url=$9, updated_at=now()
                    WHERE id = $10 AND teacher_id = $11 RETURNING *`, [...vals, id, teacherId]);
  }
  return db.one(`INSERT INTO questions (code, type, text, choices, answer, points, topic, image_id, image_url, teacher_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [...vals, teacherId]);
}

const questionOut = (r) => Object.assign(core.questionFromRow(r), { problems: core.validateQuestion(core.questionFromRow(r)), updatedAt: r.updated_at });

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
    answer: col('answer', 'correctanswer'), points: col('points', 'score'), topic: col('topic'), image: col('image', 'imageurl', 'picture') };
  if (ix.type < 0 || ix.text < 0) throw fail(400, 'BAD_INPUT', 'The first row must include at least "Type" and "Question" columns.');
  let created = 0, updated = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (ix[k] >= 0 ? r[ix[k]] : '');
    try {
      const q = questionInput({ code: get('code'), type: get('type'), text: get('text'), choices: get('choices'), answer: get('answer'),
        points: get('points'), topic: get('topic'), imageUrl: /^https?:\/\//i.test(String(get('image')).trim()) ? get('image') : '' });
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
  const out = [['QuestionID', 'Type', 'Question', 'Choices', 'Answer', 'Points', 'Topic', 'Image']].concat(
    rows.map((r) => [r.code, r.type, r.text, (r.choices || []).join(' | '), r.answer, r.points, r.topic, r.image_url || (r.image_id ? '(uploaded picture)' : '')]));
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
        if (a.credits < 1) throw fail(402, 'NO_CREDITS', 'You need an access code or 1 credit to publish this exam. Go to My Account to redeem a code or request credits.');
        await t.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [u.id]);
        await t.query('INSERT INTO credit_ledger (teacher_id, credits, reason) VALUES ($1, -1, $2)', [u.id, 'Published "' + x.title + '"']);
        charge = true;
      }
      await t.query('UPDATE exams SET published = true, published_at = COALESCE(published_at, now()), credit_spent = credit_spent OR $2, updated_at = now() WHERE id = $1', [x.id, charge || a.timeOk || a.isAdmin]);
      return charge;
    });
    return res.json({ ok: true, charged, exam: await db.one('SELECT * FROM exams WHERE id = $1', [x.id]), user: auth.publicUser(await db.one('SELECT * FROM users WHERE id = $1', [req.user.id])) });
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
            (SELECT count(*) FROM violations v WHERE v.attempt_id = a.id)::int AS event_count
       FROM attempts a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 ORDER BY u.name, a.started_at`, [x.id]);
  const notStarted = await db.many(
    `SELECT u.id, u.name, u.email, u.student_no FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.exam_id = $2 AND a.student_id = u.id) ORDER BY u.name`, [x.class_id, x.id]);
  res.json({ ok: true, exam: { id: x.id, title: x.title, published: x.published, showScore: x.show_score }, attempts, notStarted });
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
  });
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
