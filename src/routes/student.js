// Student: dashboard (all exams from all classes), joining and leaving classes.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings, fmtDate } = require('../settings');
const { fail, str, isUuid } = require('../util');

const router = express.Router();
router.use(auth.requireRole('student'));

function questionCount(x) {
  const ids = Array.isArray(x.question_ids) ? x.question_ids.length : 0;
  const topics = Array.isArray(x.topic_counts) ? x.topic_counts.reduce((s, t) => s + (Number(t.count) || 0), 0) : 0;
  if (topics) return Math.min(topics, ids);
  const types = x.options && Array.isArray(x.options.typePicks) ? x.options.typePicks.reduce((s, t) => s + (Number(t.count) || 0), 0) : 0;
  if (types) return Math.min(types, ids);
  if (x.pick_count > 0 && x.pick_count < ids) return x.pick_count;
  return ids;
}

router.get('/dashboard', async (req, res) => {
  const s = await getSettings();
  const now = new Date();
  const classes = await db.many(
    `SELECT c.id, c.name, c.section, u.name AS teacher_name FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN users u ON u.id = c.teacher_id
      WHERE e.student_id = $1 AND NOT c.archived ORDER BY c.name`, [req.user.id]);
  const exams = await db.many(
    `SELECT x.*, c.name AS class_name, c.section AS class_section, u.name AS teacher_name
       FROM exams x JOIN classes c ON c.id = x.class_id JOIN users u ON u.id = x.teacher_id
       JOIN enrollments e ON e.class_id = c.id AND e.student_id = $1
      WHERE x.published AND NOT c.archived ORDER BY x.start_at NULLS FIRST, x.created_at`, [req.user.id]);
  const attempts = exams.length ? await db.many(
    `SELECT * FROM attempts WHERE student_id = $1 AND exam_id = ANY($2::uuid[]) ORDER BY started_at`, [req.user.id, exams.map((x) => x.id)]) : [];
  const out = exams.map((x) => {
    const exam = core.examConfig(x);
    const mine = attempts.filter((a) => a.exam_id === x.id);
    const last = mine[mine.length - 1];
    const ws = core.windowStatus(exam, now);
    let state;
    if (last && last.status === 'IN_PROGRESS' && (!last.deadline || new Date(last.deadline) > now)) state = 'inprogress';
    else if (last && !last.allow_retake) state = 'completed';
    else if (ws === 'NOT_YET_OPEN') state = 'upcoming';
    else if (ws === 'CLOSED' && !(last && last.allow_retake)) state = 'expired';
    else state = 'open';
    const attempt = last ? {
      status: last.status === 'IN_PROGRESS' && state !== 'inprogress' ? 'EXPIRED' : last.status,
      startedAt: last.started_at, submittedAt: last.submitted_at, voidReason: last.void_reason, late: last.late,
      retakeAllowed: last.allow_retake,
      score: x.show_score ? last.score : null, maxScore: x.show_score ? last.max_score : null,
      percent: x.show_score ? last.percent : null, pendingEssays: x.show_score ? last.pending_essays : null,
    } : null;
    return {
      id: x.id, title: x.title, instructions: x.instructions, state,
      className: x.class_name + (x.class_section ? ' — ' + x.class_section : ''), teacherName: x.teacher_name,
      startAt: x.start_at, endAt: x.end_at, startText: fmtDate(x.start_at, s.timeZone), endText: fmtDate(x.end_at, s.timeZone),
      timeLimitMinutes: exam.limitMin, questionCount: questionCount(x),
      displayMode: exam.displayMode, allowBack: exam.allowBack, questionSeconds: exam.questionSeconds,
      faceMode: exam.faceMode, allowedDevices: exam.allowedDevices, requiresPassword: !!exam.password,
      blockCopyPaste: exam.options.blockCopyPaste, reconnectSeconds: exam.options.reconnectSeconds, focusWarnings: exam.options.focusWarnings, showScore: exam.showScore,
      attempt,
    };
  });
  res.json({ ok: true, classes, exams: out, serverNow: now.getTime() });
});

router.post('/join', async (req, res) => {
  const code = str(req.body && req.body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw fail(400, 'BAD_INPUT', 'Enter the class code from your teacher.');
  const c = await db.one('SELECT c.*, u.name AS teacher_name FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.join_code = $1', [code]);
  if (!c || c.archived) throw fail(404, 'BAD_CODE', 'No class has that code. Check it with your teacher.');
  await db.query('INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.id, req.user.id]);
  res.json({ ok: true, class: { id: c.id, name: c.name, section: c.section, teacherName: c.teacher_name } });
});

router.post('/leave', async (req, res) => {
  const id = req.body && req.body.classId;
  if (!isUuid(id)) throw fail(404, 'NOT_FOUND', 'Class not found.');
  await db.query('DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2', [id, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
