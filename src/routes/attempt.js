// The exam engine used by the exam page: start/resume, heartbeat, integrity events,
// answer locking, pictures, submit. Same rules as the Google Sheets version.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings, fmtDate } = require('../settings');
const { fail, str, isUuid } = require('../util');

const { STATUS, VIOLATION_LABELS, WARNABLE_EVENTS, PING_SLACK_MS } = core;
const router = express.Router();
router.use(auth.requireRole('student'));

// ───────── helpers (q = query function, inside or outside a transaction) ─────────

async function loadExam(q, examId, studentId) {
  if (!isUuid(examId)) throw fail(404, 'EXAM_NOT_FOUND', 'This exam was not found.');
  const x = (await q(
    `SELECT x.*, c.name AS class_name, c.section AS class_section, c.archived AS class_archived,
            EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = x.class_id AND e.student_id = $2) AS enrolled
       FROM exams x JOIN classes c ON c.id = x.class_id WHERE x.id = $1`, [examId, studentId])).rows[0];
  if (!x || !x.published || x.class_archived) throw fail(404, 'EXAM_NOT_FOUND', 'This exam was not found or is not open to students.');
  if (!x.enrolled) throw fail(403, 'NOT_ENROLLED', 'You are not in the class for this exam. Join the class with the code from your teacher.');
  return x;
}

async function loadPool(q, exam) {
  if (!exam.questionIds.length) throw fail(409, 'CONFIG', 'This exam has no questions yet. Please tell your teacher.');
  const rows = (await q('SELECT * FROM questions WHERE teacher_id = $1 AND id = ANY($2::uuid[])', [exam.teacherId, exam.questionIds])).rows;
  const byId = new Map(rows.map((r) => [r.id, core.questionFromRow(r)]));
  return exam.questionIds.map((id) => byId.get(id)).filter(Boolean);
}

async function lockAttempt(q, attemptId, studentId) {
  if (!isUuid(attemptId)) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found. Go back to My Exams and open the exam again.');
  const a = (await q('SELECT * FROM attempts WHERE id = $1 AND student_id = $2 FOR UPDATE', [attemptId, studentId])).rows[0];
  if (!a) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found. Go back to My Exams and open the exam again.');
  return a;
}

async function examOfAttempt(q, a) {
  const x = (await q('SELECT * FROM exams WHERE id = $1', [a.exam_id])).rows[0];
  return core.examConfig(x);
}

const logEvent = (q, attemptId, event, detail) =>
  q('INSERT INTO violations (attempt_id, event, detail) VALUES ($1, $2, $3)', [attemptId, event, str(detail, 500)]);

async function voidAttempt(q, a, event) {
  await q('UPDATE attempts SET status = $1, void_reason = $2, voided_at = now() WHERE id = $3', [STATUS.VOIDED, VIOLATION_LABELS[event], a.id]);
  a.status = STATUS.VOIDED; a.void_reason = VIOLATION_LABELS[event];
}

function blockedError(a) {
  switch (a.status) {
    case STATUS.VOIDED:
      return fail(409, 'VOIDED', 'Your exam was voided: ' + (a.void_reason || 'exam rules were broken') +
        '. Please inform your teacher about this event. Only your teacher can allow you to take it again.');
    case STATUS.SUBMITTED:
      return fail(409, 'ALREADY_SUBMITTED', 'You have already submitted this exam. Ask your teacher if you need to take it again.');
    case STATUS.EXPIRED:
      return fail(409, 'EXPIRED', 'The time for your attempt ran out before it was submitted. Please contact your teacher.');
    default:
      return fail(409, 'NOT_ACTIVE', 'This attempt can no longer be continued.');
  }
}

/** Voids the attempt if the page was out of contact too long. Returns false if voided. */
async function enforceGap(q, a, opts, now) {
  if (!(opts.reconnectSeconds > 0) || !a.last_seen) return true;
  const gap = now - new Date(a.last_seen);
  if (gap <= opts.reconnectSeconds * 1000 + PING_SLACK_MS) return true;
  await logEvent(q, a.id, 'CONNECTION_LOST', 'VOIDED: no contact for ' + Math.round(gap / 1000) + ' s (limit ' + opts.reconnectSeconds + ' s)');
  await voidAttempt(q, a, 'CONNECTION_LOST');
  return false;
}

function resultFor(a, exam) {
  if (!exam.showScore) return { submitted: true, showScore: false };
  return { submitted: true, showScore: true, score: Number(a.score) || 0, maxScore: Number(a.max_score) || 0, percent: Number(a.percent) || 0, pendingEssays: Number(a.pending_essays) || 0 };
}

// ───────── actions ─────────

const actions = {
  async getExam(req) {
    const s = await getSettings();
    const x = await loadExam((sql, p) => db.query(sql, p), req.body.examId, req.user.id);
    const exam = core.examConfig(x);
    const pool = await loadPool((sql, p) => db.query(sql, p), exam);
    const sum = core.setSummary(exam, pool);
    const now = new Date();
    return {
      exam: {
        id: exam.id, title: exam.title, instructions: exam.instructions,
        className: x.class_name + (x.class_section ? ' — ' + x.class_section : ''),
        questionCount: sum.count, poolSize: sum.poolSize, totalPoints: sum.totalPoints, typeCounts: sum.typeCounts, topicBreakdown: sum.topicBreakdown,
        timeLimitMinutes: exam.limitMin,
        startMs: exam.start ? exam.start.getTime() : null, endMs: exam.end ? exam.end.getTime() : null,
        startText: fmtDate(exam.start, s.timeZone), endText: fmtDate(exam.end, s.timeZone), timeZone: s.timeZone,
        windowStatus: core.windowStatus(exam, now), serverNow: now.getTime(),
        displayMode: exam.displayMode, allowBack: exam.allowBack, questionSeconds: exam.questionSeconds,
        faceMode: exam.faceMode, cameraPreview: exam.cameraPreview, allowedDevices: exam.allowedDevices,
        requiresPassword: !!exam.password,
      },
      rules: exam.options,
      student: { name: req.user.name, id: req.user.student_no || req.user.email },
    };
  },

  async start(req) {
    const b = req.body;
    const env = b.env || {};
    const s = await getSettings(); // read before the transaction
    const out = await db.tx(async (t) => {
      const q = t.query;
      const x = await loadExam(q, b.examId, req.user.id);
      const exam = core.examConfig(x);
      const opts = exam.options;
      const pool = await loadPool(q, exam);
      await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]); // one start at a time per student
      const mine = (await q('SELECT * FROM attempts WHERE exam_id = $1 AND student_id = $2 ORDER BY started_at', [exam.id, req.user.id])).rows;
      const last = mine[mine.length - 1];
      const now = new Date();
      let attempt = null, resumed = false, isRetake = false;

      if (last) {
        if (last.status === STATUS.IN_PROGRESS) {
          if (!last.deadline || now <= new Date(last.deadline)) {
            // Reconnecting (page reloaded, browser crashed, connection lost)
            if (opts.reconnectSeconds > 0) {
              const ref = last.disconnected_at || last.last_seen || last.started_at;
              const gap = now - new Date(ref);
              const allowed = opts.reconnectSeconds * 1000 + (last.disconnected_at ? 0 : PING_SLACK_MS);
              if (gap > allowed) {
                await logEvent(q, last.id, 'CONNECTION_LOST', 'VOIDED: came back after ' + Math.round(gap / 1000) + ' s (limit ' + opts.reconnectSeconds + ' s)');
                await voidAttempt(q, last, 'CONNECTION_LOST');
                return { error: blockedError(last) };
              }
              if (last.reconnects >= opts.maxReconnects) {
                await logEvent(q, last.id, 'TOO_MANY_RECONNECTS', 'VOIDED: tried to reconnect ' + (last.reconnects + 1) + ' times (limit ' + opts.maxReconnects + ')');
                await voidAttempt(q, last, 'TOO_MANY_RECONNECTS');
                return { error: blockedError(last) };
              }
              await logEvent(q, last.id, 'RECONNECTED', 'Reconnect ' + (last.reconnects + 1) + ' of ' + opts.maxReconnects + ' after ' + Math.round(gap / 1000) + ' s');
              await q('UPDATE attempts SET reconnects = reconnects + 1, disconnected_at = NULL, last_seen = now() WHERE id = $1', [last.id]);
              last.reconnects += 1;
            }
            attempt = last; resumed = true;
          } else {
            await q('UPDATE attempts SET status = $1 WHERE id = $2', [STATUS.EXPIRED, last.id]);
            last.status = STATUS.EXPIRED;
          }
        }
        if (!attempt) {
          if (!last.allow_retake) return { error: blockedError(last) };
          isRetake = true;
        }
      }

      if (!attempt) {
        const ws = core.windowStatus(exam, now);
        if (ws === 'NOT_YET_OPEN') throw fail(409, 'NOT_YET_OPEN', 'This exam opens on ' + fmtDate(exam.start, s.timeZone) + '.');
        if (ws === 'CLOSED' && !isRetake) throw fail(409, 'CLOSED', 'This exam closed on ' + fmtDate(exam.end, s.timeZone) + '.');
        if (exam.password && str(b.password, 60).toLowerCase() !== exam.password.trim().toLowerCase()) {
          throw fail(403, 'WRONG_PASSWORD', b.password ? 'The exam password is incorrect.' : 'Enter the exam password from your teacher.');
        }
        const device = core.deviceOf(env);
        if (!core.deviceAllowed(exam.allowedDevices, device)) {
          throw fail(403, 'DEVICE_NOT_ALLOWED', exam.allowedDevices === 'TABLET'
            ? 'This exam must be taken on a computer or a tablet, not a phone.' : 'This exam must be taken on a laptop or desktop computer.');
        }
        if (device === 'computer') {
          if (env.isExtended === true) throw fail(409, 'SECOND_MONITOR', 'A second monitor is connected. Disconnect it before starting the exam.');
          if (opts.requireMonitorCheck && env.monitorCheck !== 'supported') {
            throw fail(409, 'UNSUPPORTED_BROWSER', 'Please open the exam in Google Chrome or Microsoft Edge on a laptop or desktop computer.');
          }
        }
        if (exam.faceMode !== 'OFF' && env.camera !== 'ok') {
          throw fail(409, 'CAMERA_REQUIRED', 'This exam requires your camera. Turn it on and make sure your face is visible.');
        }
        let deadline = exam.limitMin > 0 ? new Date(now.getTime() + exam.limitMin * 60000) : null;
        if (!isRetake && exam.end && (!deadline || exam.end < deadline)) deadline = exam.end;
        const id = crypto.randomUUID();
        const maxScore = core.attemptQuestions(exam, pool, id).reduce((s2, qq) => s2 + qq.points, 0);
        attempt = (await q(`INSERT INTO attempts (id, exam_id, student_id, status, started_at, deadline, max_score, is_retake, user_agent, device, last_seen)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$5) RETURNING *`,
          [id, exam.id, req.user.id, STATUS.IN_PROGRESS, now, deadline, maxScore, isRetake, str(env.userAgent, 300), device])).rows[0];
      }

      const deadline = attempt.deadline ? new Date(attempt.deadline) : null;
      const lockedIds = resumed && !exam.allowBack
        ? (await q('SELECT question_id FROM locked_answers WHERE attempt_id = $1 ORDER BY at', [attempt.id])).rows.map((r) => r.question_id) : [];
      return {
        result: {
          attemptId: attempt.id,
          studentId: req.user.student_no || req.user.email,
          studentName: req.user.name,
          resumed, reconnects: attempt.reconnects || 0, isRetake: !!attempt.is_retake,
          deadlineMs: deadline ? deadline.getTime() : null,
          remainingMs: deadline ? Math.max(0, deadline.getTime() - now.getTime()) : null,
          questions: core.attemptQuestions(exam, pool, attempt.id).map((qq) => core.publicQuestion(qq, exam, attempt.id)),
          lockedIds,
        },
      };
    });
    if (out.error) throw out.error;
    return out.result;
  },

  async ping(req) {
    return db.tx(async (t) => {
      const a = await lockAttempt(t.query, req.body.attemptId, req.user.id);
      if (a.status !== STATUS.IN_PROGRESS) return { status: a.status, reason: a.void_reason };
      const exam = await examOfAttempt(t.query, a);
      if (!(await enforceGap(t.query, a, exam.options, new Date()))) return { status: a.status, reason: a.void_reason };
      await t.query('UPDATE attempts SET last_seen = now(), disconnected_at = NULL WHERE id = $1', [a.id]);
      return { status: a.status };
    });
  },

  async disconnect(req) {
    return db.tx(async (t) => {
      const a = await lockAttempt(t.query, req.body.attemptId, req.user.id);
      if (a.status !== STATUS.IN_PROGRESS) return { status: a.status };
      const exam = await examOfAttempt(t.query, a);
      if (!(exam.options.reconnectSeconds > 0)) {
        await logEvent(t.query, a.id, 'PAGE_CLOSED', 'VOIDED: ' + str(req.body.detail || 'page closed', 200));
        await voidAttempt(t.query, a, 'PAGE_CLOSED');
        return { status: a.status };
      }
      await logEvent(t.query, a.id, 'DISCONNECTED', 'Page closed or reloaded. Has ' + exam.options.reconnectSeconds + ' s to reconnect.');
      await t.query('UPDATE attempts SET disconnected_at = now() WHERE id = $1', [a.id]);
      return { status: a.status };
    });
  },

  async violation(req) {
    return db.tx(async (t) => {
      const a = await lockAttempt(t.query, req.body.attemptId, req.user.id);
      const event = VIOLATION_LABELS[req.body.event] ? req.body.event : 'TAB_SWITCH';
      const detail = str(req.body.detail, 300);
      if (a.status !== STATUS.IN_PROGRESS) { await logEvent(t.query, a.id, event, detail); return { status: a.status, reason: a.void_reason }; }
      if (WARNABLE_EVENTS.includes(event) && !(a.warnings > 0)) {
        await logEvent(t.query, a.id, event, 'WARNING (1st offense): ' + detail);
        await t.query('UPDATE attempts SET warnings = 1 WHERE id = $1', [a.id]);
        return { status: a.status, warned: true };
      }
      await logEvent(t.query, a.id, event, (WARNABLE_EVENTS.includes(event) ? 'VOIDED (2nd offense): ' : 'VOIDED: ') + detail);
      await voidAttempt(t.query, a, event);
      return { status: a.status, reason: a.void_reason };
    });
  },

  /** A small JPEG from the camera at the moment it flagged something. Kept as proof for the teacher. */
  async snapshot(req) {
    const b = req.body;
    if (!isUuid(b.attemptId)) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found.');
    const a = await db.one('SELECT * FROM attempts WHERE id = $1 AND student_id = $2', [b.attemptId, req.user.id]);
    if (!a) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found.');
    const exam = await examOfAttempt((sql, p) => db.query(sql, p), a);
    if (exam.faceMode !== 'ALWAYS' || !exam.options.cameraSnapshots) return { saved: false };
    const recentlyVoided = a.status === STATUS.VOIDED && a.voided_at && Date.now() - new Date(a.voided_at).getTime() < 5 * 60000;
    if (a.status !== STATUS.IN_PROGRESS && !recentlyVoided) return { saved: false };
    const m = String(b.dataUrl || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw fail(400, 'BAD_INPUT', 'Bad picture.');
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length > 100 * 1024) throw fail(413, 'TOO_LARGE', 'Picture too large.');
    const n = await db.one('SELECT count(*)::int AS n FROM attempt_snapshots WHERE attempt_id = $1', [a.id]);
    if (n.n >= 10) return { saved: false };
    const event = VIOLATION_LABELS[b.event] ? b.event : 'CAMERA';
    await db.query('INSERT INTO attempt_snapshots (attempt_id, event, mime, bytes, data) VALUES ($1, $2, $3, $4, $5)', [a.id, event, 'image/jpeg', bytes.length, bytes]);
    return { saved: true };
  },

  async lockAnswer(req) {
    return db.tx(async (t) => {
      const a = await lockAttempt(t.query, req.body.attemptId, req.user.id);
      if (a.status !== STATUS.IN_PROGRESS) throw blockedError(a);
      const exam = await examOfAttempt(t.query, a);
      if (exam.allowBack) return { locked: false };
      const ids = core.attemptQuestions(exam, await loadPool(t.query, exam), a.id).map((qq) => qq.id);
      const qid = String(req.body.questionId || '');
      if (!ids.includes(qid)) throw fail(400, 'BAD_INPUT', 'Unknown question.');
      const v = req.body.value === undefined || req.body.value === null ? '' : String(req.body.value).slice(0, 20000);
      await t.query('INSERT INTO locked_answers (attempt_id, question_id, answer) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a.id, qid, v]);
      return { locked: true };
    });
  },

  async submit(req) {
    const out = await db.tx(async (t) => {
      const q = t.query;
      const a = await lockAttempt(q, req.body.attemptId, req.user.id);
      const exam = await examOfAttempt(q, a);
      if (a.status === STATUS.SUBMITTED) return { result: resultFor(a, exam) };
      if (a.status !== STATUS.IN_PROGRESS) return { error: blockedError(a) };
      const reported = Array.isArray(req.body.violations) ? req.body.violations : [];
      if (reported.length) {
        const v = reported[0] || {};
        const event = VIOLATION_LABELS[v.event] ? v.event : 'TAB_SWITCH';
        await logEvent(q, a.id, event, 'VOIDED: ' + str(v.detail, 300));
        await voidAttempt(q, a, event);
        return { error: blockedError(a) };
      }
      const now = new Date();
      if (!(await enforceGap(q, a, exam.options, now))) return { error: blockedError(a) };
      const late = !!a.deadline && now.getTime() > new Date(a.deadline).getTime() + exam.options.submitGraceSeconds * 1000;
      const questions = core.attemptQuestions(exam, await loadPool(q, exam), a.id);
      const answers = Object.assign({}, req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {});
      if (!exam.allowBack) {
        (await q('SELECT question_id, answer FROM locked_answers WHERE attempt_id = $1', [a.id])).rows.forEach((r) => { answers[r.question_id] = r.answer; });
      }
      let score = 0, max = 0, pending = 0;
      for (let i = 0; i < questions.length; i++) {
        const qq = questions[i];
        const g = core.gradeQuestion(qq, answers[qq.id]);
        max += qq.points;
        if (g.pending) pending++; else score += g.points;
        await q(`INSERT INTO responses (attempt_id, question_id, position, type, question_text, student_answer, correct_answer, is_correct, points_earned, max_points)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (attempt_id, question_id) DO NOTHING`,
          [a.id, qq.id, i, qq.type, qq.text, g.studentText, g.correctText, g.pending ? null : g.correct, g.pending ? null : g.points, qq.points]);
      }
      const percent = max ? Math.round(score / max * 10000) / 100 : 0;
      await q(`UPDATE attempts SET status = $1, submitted_at = $2, score = $3, max_score = $4, percent = $5, pending_essays = $6, late = $7 WHERE id = $8`,
        [STATUS.SUBMITTED, now, score, max, percent, pending, late, a.id]);
      Object.assign(a, { status: STATUS.SUBMITTED, score, max_score: max, percent, pending_essays: pending });
      return { result: resultFor(a, exam) };
    });
    if (out.error) throw out.error;
    return out.result;
  },
};

// Same request shape as the Google Sheets version: { action, ...fields }.
// sendBeacon (page closing) cannot add headers, so it may post as text/plain for these two actions.
router.post('/', express.json({ type: ['application/json', 'text/plain'], limit: '2mb' }), async (req, res) => {
  const action = req.body && req.body.action;
  const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
  if (!fn) throw fail(400, 'BAD_ACTION', 'Unknown action.');
  if (req.get('X-Requested-With') !== 'fetch' && !['violation', 'disconnect'].includes(action)) {
    throw fail(403, 'BAD_ORIGIN', 'This request was blocked. Reload the page and try again.');
  }
  res.json(Object.assign({ ok: true }, await fn(req)));
});

/** A question's uploaded picture, only for the student's own active attempt. */
router.get('/:attemptId/image/:questionId', async (req, res) => {
  const a = isUuid(req.params.attemptId) && await db.one('SELECT * FROM attempts WHERE id = $1 AND student_id = $2', [req.params.attemptId, req.user.id]);
  if (!a || a.status !== STATUS.IN_PROGRESS) throw fail(404, 'NOT_FOUND', 'Picture not available.');
  const exam = await examOfAttempt((sql, p) => db.query(sql, p), a);
  const qq = core.attemptQuestions(exam, await loadPool((sql, p) => db.query(sql, p), exam), a.id).find((x) => x.id === req.params.questionId);
  if (!qq || !qq.imageId) throw fail(404, 'NOT_FOUND', 'Picture not available.');
  const img = await db.one('SELECT mime, data FROM images WHERE id = $1', [qq.imageId]);
  if (!img) throw fail(404, 'NOT_FOUND', 'Picture not available.');
  res.set('Content-Type', img.mime).set('Cache-Control', 'private, no-store').send(Buffer.from(img.data));
});

module.exports = router;
