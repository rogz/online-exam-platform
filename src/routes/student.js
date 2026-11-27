// Student: dashboard (all exams from all classes), joining and leaving classes.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings, fmtDate } = require('../settings');
const { fail, str, isUuid, cleanCode } = require('../util');

const router = express.Router();
router.use(auth.requireRole('student'));

function questionCount(x) {
  const ids = Array.isArray(x.question_ids) ? x.question_ids.length : 0;
  const topics = Array.isArray(x.topic_counts) ? x.topic_counts.reduce((s, t) => s + (Number(t.count) || 0), 0) : 0;
  const types = x.options && Array.isArray(x.options.typePicks) ? x.options.typePicks.reduce((s, t) => s + (Number(t.count) || 0), 0) : 0;
  if (topics || types) return Math.min(topics + types, ids); // per topic first, then per type from the rest
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
  const pkgs = exams.length ? await db.many('SELECT exam_id, downloaded_at, synced_at FROM offline_packages WHERE student_id = $1', [req.user.id]) : [];
  const attempts = exams.length ? await db.many(
    `SELECT * FROM attempts WHERE student_id = $1 AND exam_id = ANY($2::uuid[]) ORDER BY started_at`, [req.user.id, exams.map((x) => x.id)]) : [];
  const ranks = {};
  for (const x of exams) {
    const o = core.examOptions(x.options);
    const last = attempts.filter((a) => a.exam_id === x.id).pop();
    if (x.show_score && o.showRank && last && last.status === 'SUBMITTED') {
      const r = await core.rankOf((sql, p) => db.query(sql, p), x.id, req.user.id);
      if (r) ranks[x.id] = { rank: r.rank, total: r.total, mean: r.mean, median: r.median, sd: r.sd, percentile: r.percentile, current: r.pending || !x.end_at || new Date(x.end_at) > now };
    }
  }
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
      rank: ranks[x.id] || null,
    } : null;
    const pkg = pkgs.find((p) => p.exam_id === x.id);
    return {
      id: x.id, title: x.title, instructions: x.instructions, state,
      className: x.class_name + (x.class_section ? ' — ' + x.class_section : ''), teacherName: x.teacher_name,
      startAt: x.start_at, endAt: x.end_at, startText: fmtDate(x.start_at, s.timeZone), endText: fmtDate(x.end_at, s.timeZone),
      timeLimitMinutes: exam.limitMin, questionCount: questionCount(x),
      displayMode: exam.displayMode, allowBack: exam.allowBack, questionSeconds: exam.questionSeconds,
      faceMode: exam.faceMode, allowedDevices: exam.allowedDevices, requiresPassword: !!exam.password,
      blockCopyPaste: exam.options.blockCopyPaste, reconnectSeconds: exam.options.reconnectSeconds, focusWarnings: exam.options.focusWarnings, showScore: exam.showScore,
      attempt, offline: exam.options.offlineMode, questionTotal: questionCount(x), downloadedAt: pkg ? pkg.downloaded_at : null,
    };
  });
  res.json({ ok: true, classes, exams: out, serverNow: now.getTime() });
});

router.post('/join', async (req, res) => {
  const typed = cleanCode(req.body && req.body.code, 40);
  const code = typed.replace(/[^A-Z0-9]/g, '');
  if (!code) throw fail(400, 'BAD_INPUT', 'Enter the class code from your teacher.');
  const c = await db.one('SELECT c.*, u.name AS teacher_name FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.join_code = $1', [code]);
  if (!c || c.archived) {
    // say what looks wrong, so the student can fix it without the teacher
    const odd = Array.from(typed.replace(/-/g, '')).filter((ch) => !/[A-Z0-9]/.test(ch));
    console.warn('Class code not found:', JSON.stringify(Array.from(String(req.body && req.body.code || '').slice(0, 20)).map((ch) => ch.codePointAt(0).toString(16))));
    if (odd.length) throw fail(404, 'BAD_CODE', 'The code has a character that is not a plain letter or number (' + odd.slice(0, 3).join(' ') + '). Switch your keyboard to English (ABC) and type the code again.');
    if (code.length !== 6) throw fail(404, 'BAD_CODE', 'Class codes have 6 letters and numbers; you typed ' + code.length + '. Check it with your teacher.');
    if (/[O0I1L]/.test(code)) throw fail(404, 'BAD_CODE', 'Class codes never use the letters O, I or L or the numbers 0 or 1. Check that character with your teacher.');
    throw fail(404, 'BAD_CODE', c && c.archived ? 'That class has been closed by the teacher.' : 'No class has that code. Check it with your teacher.');
  }
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
