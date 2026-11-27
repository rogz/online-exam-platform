// The exam engine used by the exam page: start/resume, heartbeat, integrity events,
// answer locking, pictures, submit. Same rules as the Google Sheets version.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const core = require('../exam-core');
const { getSettings, fmtDate } = require('../settings');
const { fail, str, isUuid } = require('../util');
const snapshots = require('../snapshots');
const offline = require('../offline');

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
  return core.applyPoints(exam, exam.questionIds.map((id) => byId.get(id)).filter(Boolean));
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

const fmtGap = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? s + ' s' : Math.round(s / 60) + ' min'; };

/** True when the request comes from the exam page that is still open (it lost only the internet, not the page). */
const samePage = (a, opts, token) => opts.keepGoingOffline && !!a.page_token && typeof token === 'string' && token === a.page_token;

/**
 * Voids the attempt if the page was out of contact too long. Returns false if voided.
 * With "keep going offline", the same open page may come back after any gap: it is logged as time offline instead.
 */
async function enforceGap(q, a, opts, now, token) {
  if (!a.last_seen) return true;
  const gap = now - new Date(a.last_seen);
  if (samePage(a, opts, token)) {
    if (gap > 45000) {
      await logEvent(q, a.id, 'OFFLINE', 'No internet for about ' + fmtGap(gap) + '; the exam page stayed open and kept checking.');
      await q('UPDATE attempts SET offline_ms = offline_ms + $1 WHERE id = $2', [Math.round(gap), a.id]);
      a.offline_ms = Number(a.offline_ms || 0) + gap;
    }
    return true;
  }
  if (!(opts.reconnectSeconds > 0)) return true;
  if (gap <= opts.reconnectSeconds * 1000 + PING_SLACK_MS) return true;
  await logEvent(q, a.id, 'CONNECTION_LOST', 'VOIDED: no contact for ' + Math.round(gap / 1000) + ' s (limit ' + opts.reconnectSeconds + ' s)');
  await voidAttempt(q, a, 'CONNECTION_LOST');
  return false;
}

function resultFor(a, exam) {
  if (!exam.showScore) return { submitted: true, showScore: false };
  return { submitted: true, showScore: true, score: Number(a.score) || 0, maxScore: Number(a.max_score) || 0, percent: Number(a.percent) || 0, pendingEssays: Number(a.pending_essays) || 0 };
}

/**
 * Grades the answers and marks the attempt submitted (used by the student's submit, and by the teacher's
 * "submit the saved answers" / "upload an answer file" for a student whose device failed).
 */
async function questionsOfAttempt(q, exam, a) {
  if (!Array.isArray(a.fixed_question_ids)) return core.attemptQuestions(exam, await loadPool(q, exam), a.id);
  const rows = (await q('SELECT * FROM questions WHERE teacher_id = $1 AND id = ANY($2::uuid[])', [exam.teacherId, a.fixed_question_ids])).rows;
  const byId = new Map(core.applyPoints(exam, rows.map(core.questionFromRow)).map((x) => [x.id, x]));
  return a.fixed_question_ids.map((id) => byId.get(id)).filter(Boolean);
}

async function gradeAttempt(q, a, exam, rawAnswers, o) {
  const questions = await questionsOfAttempt(q, exam, a);
  const answers = Object.assign({}, rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers) ? rawAnswers : {});
  if (!exam.allowBack) {
    (await q('SELECT question_id, answer FROM locked_answers WHERE attempt_id = $1', [a.id])).rows.forEach((r) => { answers[r.question_id] = r.answer; });
  }
  let score = 0, max = 0, pending = 0;
  for (let i = 0; i < questions.length; i++) {
    const qq = questions[i];
    const g = core.gradeQuestion(qq, answers[qq.id]);
    max += qq.points;
    if (g.pending) pending++; else score += g.points;
    await q(`INSERT INTO responses (attempt_id, question_id, position, type, question_text, student_answer, correct_answer, is_correct, points_earned, max_points, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (attempt_id, question_id) DO NOTHING`,
      [a.id, qq.id, i, qq.type, qq.text, g.studentText, g.correctText, g.pending ? null : g.correct, g.pending ? null : g.points, qq.points, g.note || '']);
  }
  const percent = max ? Math.round(score / max * 10000) / 100 : 0;
  await q(`UPDATE attempts SET status = $1, submitted_at = $2, score = $3, max_score = $4, percent = $5, pending_essays = $6, late = $7,
             sent_late = $9, finished_at = $10, void_reason = NULL WHERE id = $8`,
    [STATUS.SUBMITTED, o.now, score, max, percent, pending, !!o.late, a.id, !!o.sentLate, o.finishedAt || o.now]);
  Object.assign(a, { status: STATUS.SUBMITTED, score, max_score: max, percent, pending_essays: pending });
  return { score, max, percent, pending, answered: Object.keys(answers).length };
}

/**
 * The answers of an offline exam arrive: from the student's device, an answer file the teacher uploads, or a QR code
 * scanned by the teacher or a helper. o.studentId (the student's own device) or o.examId (teacher / helper) limits
 * which copy can be used. Checks the receipt and the times, then grades it like a submit.
 */
async function receiveOffline(b, o) {
    const out = await db.tx(async (t) => {
      const q = t.query;
      const pkg = (await q('SELECT * FROM offline_packages WHERE id = $1 FOR UPDATE', [b.packageId])).rows[0];
      if (pkg && o.studentId && pkg.student_id !== o.studentId) throw fail(404, 'NO_ATTEMPT', 'This exam copy was not found. It may have been downloaded under another account.');
      if (pkg && o.examId && pkg.exam_id !== o.examId) throw fail(404, 'NO_ATTEMPT', 'These answers are for a different exam.');
      if (!pkg) throw fail(404, 'NO_ATTEMPT', 'This exam copy was not found. It may have been downloaded under another account.');
      const x = (await q('SELECT * FROM exams WHERE id = $1', [pkg.exam_id])).rows[0];
      const exam = core.examConfig(x);
      const done = (await q('SELECT * FROM attempts WHERE id = $1', [pkg.id])).rows[0];
      const finishedAt = Math.round(Number(b.finishedAt)), startedAt = Math.round(Number(b.startedAt));
      const expect = offline.receiptOf(pkg.receipt_key, pkg.id, finishedAt, b.answers);
      if (done) {
        if (done.receipt && b.receipt && b.receipt !== done.receipt) await logEvent(q, done.id, 'SECOND_COPY', 'Another copy with different answers arrived (receipt ' + str(b.receipt, 10) + '); it was not used.');
        return { result: Object.assign(resultFor(done, exam), { receipt: done.receipt }) };
      }
      const now = new Date();
      const review = [];
      const okTime = (ms) => Number.isFinite(ms) && ms > new Date(pkg.downloaded_at).getTime() - 3600000 && ms <= now.getTime() + 120000;
      const start = okTime(startedAt) ? startedAt : new Date(pkg.downloaded_at).getTime();
      const finish = okTime(finishedAt) && finishedAt >= start ? finishedAt : now.getTime();
      if (!okTime(startedAt) || !okTime(finishedAt)) review.push('The device clock looked wrong (start or finish time not possible).');
      if (exam.start && start < exam.start.getTime() - 15 * 60000) review.push('Started before the exam opened (' + new Date(start).toISOString() + ').');
      if (exam.end && start > exam.end.getTime()) review.push('Started after the exam closed.');
      if (!b.voided && b.receipt !== expect) review.push('The receipt code (' + str(b.receipt, 10) + ') does not match these answers: they may have been changed after finishing.');
      const events = (Array.isArray(b.events) ? b.events : []).slice(0, 300);
      if (events.some((e) => e && e.event === 'CLOCK_CHANGED')) review.push('The device clock was changed during the exam.');
      const graceMs = exam.options.submitGraceSeconds * 1000;
      let deadline = exam.limitMin > 0 ? start + exam.limitMin * 60000 : null;
      if (exam.end && (!deadline || exam.end.getTime() < deadline)) deadline = exam.end.getTime();
      const late = deadline !== null && finish > deadline + graceMs;
      if (late) review.push('Finished ' + fmtGap(finish - deadline) + ' after the time was up.');
      const closeMs = exam.end ? exam.end.getTime() : deadline;
      const sentLate = closeMs !== null && now.getTime() > closeMs + exam.options.offlineSubmitMinutes * 60000;
      if (sentLate) review.push('The answers arrived ' + fmtGap(now.getTime() - closeMs) + ' after the exam closed.');
      const others = (await q('SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1 AND student_id = $2', [exam.id, pkg.student_id])).rows[0].n;
      if (others) review.push('This student also has ' + others + ' other attempt' + (others === 1 ? '' : 's') + ' at this exam (e.g. online).');
      const env = b.env || {};
      const a = (await q(`INSERT INTO attempts (id, exam_id, student_id, status, started_at, deadline, user_agent, device, last_seen, offline, fixed_question_ids,
            warnings, focus_warnings, reconnects, receipt, review)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), true, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [pkg.id, exam.id, pkg.student_id, STATUS.IN_PROGRESS, new Date(start), deadline ? new Date(deadline) : null, str(env.userAgent, 300), str(env.device, 20) || null,
          JSON.stringify(pkg.question_ids), Math.max(0, Math.round(Number(b.cameraWarnings) || 0)), Math.max(0, Math.round(Number(b.focusWarnings) || 0)),
          Math.max(0, Math.round(Number(b.reloads) || 0)), str(b.receipt, 10), review.length ? JSON.stringify(review) : null])).rows[0];
      await logEvent(q, a.id, 'OFFLINE_EXAM', 'Taken offline from the downloaded copy; answers received from ' + o.source + ' ' + fmtGap(now.getTime() - finish) + ' after finishing.');
      for (const e of events) {
        if (!e || typeof e.event !== 'string') continue;
        await logEvent(q, a.id, str(e.event, 40).replace(/[^A-Z_]/g, '') || 'EVENT', (e.at ? new Date(Number(e.at)).toISOString() + ' ' : '') + str(e.detail, 300));
      }
      await q('UPDATE offline_packages SET synced_at = now() WHERE id = $1', [pkg.id]);
      const v = b.voided && typeof b.voided === 'object' ? b.voided : null;
      if (v) {
        const event = VIOLATION_LABELS[v.event] ? v.event : 'TAB_SWITCH';
        await q('UPDATE attempts SET draft_answers = $1, draft_at = now() WHERE id = $2', [JSON.stringify(b.answers || {}), a.id]);
        await logEvent(q, a.id, event, 'VOIDED (offline): ' + str(v.detail, 300));
        await voidAttempt(q, a, event);
        return { voided: true, reason: a.void_reason };
      }
      await gradeAttempt(q, a, exam, b.answers, { now, late, sentLate, finishedAt: new Date(finish) });
      return { result: Object.assign(resultFor(a, exam), { receipt: str(b.receipt, 10), receiptOk: b.receipt === expect }) };
    });
    if (out.voided) return { status: STATUS.VOIDED, reason: out.reason };
    return out.result;
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
        // Students are not told the bank size or that questions are picked at random.
        questionCount: sum.count, totalPoints: sum.totalPoints, typeCounts: sum.typeCounts,
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
            if (last.resume_until && now <= new Date(last.resume_until)) {
              await logEvent(q, last.id, 'RECONNECTED', 'Continued after the teacher allowed it');
              await q('UPDATE attempts SET resume_until = NULL, disconnected_at = NULL, last_seen = now() WHERE id = $1', [last.id]);
            } else if (opts.reconnectSeconds > 0) {
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

      if (typeof b.pageToken === 'string' && /^[0-9a-f-]{36}$/.test(b.pageToken)) {
        await q('UPDATE attempts SET page_token = $1 WHERE id = $2', [b.pageToken, attempt.id]);
      }
      const deadline = attempt.deadline ? new Date(attempt.deadline) : null;
      const lockedIds = resumed && !exam.allowBack
        ? (await q('SELECT question_id FROM locked_answers WHERE attempt_id = $1 ORDER BY at', [attempt.id])).rows.map((r) => r.question_id) : [];
      return {
        result: {
          attemptId: attempt.id,
          studentId: req.user.student_no || req.user.email,
          studentName: req.user.name,
          resumed, reconnects: attempt.reconnects || 0, isRetake: !!attempt.is_retake, cameraWarningsUsed: Number(attempt.warnings) || 0, focusWarningsUsed: Number(attempt.focus_warnings) || 0,
          deadlineMs: deadline ? deadline.getTime() : null,
          remainingMs: deadline ? Math.max(0, deadline.getTime() - now.getTime()) : null,
          questions: core.attemptQuestions(exam, pool, attempt.id).map((qq) => core.publicQuestion(qq, exam, attempt.id)),
          lockedIds,
          draftAnswers: resumed && attempt.draft_answers ? attempt.draft_answers : null,
        },
      };
    });
    if (out.error) throw out.error;
    return out.result;
  },

  /** Offline exams: the student's locked copy (their questions, no answer key), for taking the exam without internet. */
  async download(req) {
    const x = await loadExam((sql, p) => db.query(sql, p), req.body.examId, req.user.id);
    const exam = core.examConfig(x);
    if (!exam.options.offlineMode) throw fail(409, 'NOT_OFFLINE', 'Your teacher has not made this exam available offline.');
    if (offline.normPassword(exam.password).length < 8) throw fail(409, 'CONFIG', 'This exam is not ready for offline use yet. Please tell your teacher.');
    const now = new Date();
    if (exam.end && now > exam.end) throw fail(409, 'CLOSED', 'This exam has closed.');
    const s = await getSettings();
    const mine = await db.many('SELECT * FROM attempts WHERE exam_id = $1 AND student_id = $2 ORDER BY started_at', [exam.id, req.user.id]);
    const last = mine[mine.length - 1];
    let pkg = await db.one('SELECT * FROM offline_packages WHERE exam_id = $1 AND student_id = $2', [exam.id, req.user.id]);
    if (last && !(last.allow_retake && last.status !== STATUS.IN_PROGRESS)) {
      if (!pkg || pkg.synced_at || last.id !== pkg.id) {
        throw fail(409, 'ALREADY_STARTED', last.status === STATUS.SUBMITTED ? 'You have already submitted this exam.' : 'You already started this exam online. Continue it online.');
      }
    }
    if (pkg && pkg.synced_at) { await db.query('DELETE FROM offline_packages WHERE id = $1', [pkg.id]); pkg = null; } // a retake: a new copy
    const pool = await loadPool((sql, p) => db.query(sql, p), exam);
    if (!pkg) {
      const id = crypto.randomUUID();
      const ids = core.attemptQuestions(exam, pool, id).map((qq) => qq.id);
      pkg = await db.one(`INSERT INTO offline_packages (id, exam_id, student_id, question_ids, receipt_key, pw_fp) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (exam_id, student_id) DO UPDATE SET downloads = offline_packages.downloads + 1 RETURNING *`,
        [id, exam.id, req.user.id, JSON.stringify(ids), crypto.randomBytes(32).toString('base64'), offline.fingerprint(exam.password)]);
    } else {
      pkg = await db.one('UPDATE offline_packages SET downloads = downloads + 1, downloaded_at = now(), pw_fp = $1 WHERE id = $2 RETURNING *', [offline.fingerprint(exam.password), pkg.id]);
    }
    const byId = new Map(pool.map((qq) => [qq.id, qq]));
    const qs = pkg.question_ids.map((id) => byId.get(id)).filter(Boolean);
    let total = 0;
    const questions = [];
    for (const qq of qs) {
      const pq = core.publicQuestion(qq, exam, pkg.id);
      if (qq.imageId) {
        const img = await db.one('SELECT mime, data FROM images WHERE id = $1', [qq.imageId]);
        if (img) { total += img.data.length; pq.image = { src: 'data:' + img.mime + ';base64,' + Buffer.from(img.data).toString('base64') }; }
      }
      questions.push(pq);
    }
    if (total > 25 * 1024 * 1024) throw fail(413, 'TOO_LARGE', 'The pictures in this exam are too large to download (over 25 MB). Please tell your teacher.');
    const meta = {
      id: exam.id, title: exam.title, instructions: exam.instructions, className: x.class_name + (x.class_section ? ' — ' + x.class_section : ''),
      questionCount: questions.length, totalPoints: questions.reduce((t, qq) => t + qq.points, 0), timeLimitMinutes: exam.limitMin,
      startMs: exam.start ? exam.start.getTime() : null, endMs: exam.end ? exam.end.getTime() : null,
      startText: fmtDate(exam.start, s.timeZone), endText: fmtDate(exam.end, s.timeZone), timeZone: s.timeZone,
      displayMode: exam.displayMode, allowBack: exam.allowBack, questionSeconds: exam.questionSeconds,
      faceMode: exam.faceMode, cameraPreview: exam.cameraPreview, allowedDevices: exam.allowedDevices, requiresPassword: true, offline: true,
    };
    const student = { name: req.user.name, id: req.user.student_no || req.user.email };
    const locked = offline.encrypt({ v: 1, packageId: pkg.id, receiptKey: pkg.receipt_key, exam: meta, rules: exam.options, student, questions, issuedAt: now.getTime() }, exam.password);
    const external = questions.map((qq) => qq.image && qq.image.src).filter((u) => u && /^https?:/i.test(u));
    return { packageId: pkg.id, locked, meta: Object.assign({}, meta, { instructions: undefined }), student, serverNow: now.getTime(), externalImages: external };
  },

  /** Offline exams: the answers (and what happened) arrive when the student is back online. Graded like a submit. */
  async offlineSubmit(req) {
    if (!isUuid(req.body.packageId)) throw fail(404, 'NO_ATTEMPT', 'This exam copy was not found.');
    return withRank(await receiveOffline(req.body, { studentId: req.user.id, source: 'the student\'s device' }), req.body.packageId, req.user.id);
  },

  /** An unexpected error on the exam page (a bug): logged for the teacher. At most 5 per attempt. */
  async clientError(req) {
    if (!isUuid(req.body.attemptId)) return { logged: false };
    const a = await db.one('SELECT id, page_errors FROM attempts WHERE id = $1 AND student_id = $2', [req.body.attemptId, req.user.id]);
    if (!a || a.page_errors >= 5) return { logged: false };
    await db.query('UPDATE attempts SET page_errors = page_errors + 1 WHERE id = $1', [a.id]);
    await logEvent((sql, p) => db.query(sql, p), a.id, 'PAGE_ERROR', str(req.body.message, 300) + (req.body.where ? ' @ ' + str(req.body.where, 150) : ''));
    return { logged: true };
  },

  async ping(req) {
    return db.tx(async (t) => {
      const a = await lockAttempt(t.query, req.body.attemptId, req.user.id);
      if (a.status !== STATUS.IN_PROGRESS) return { status: a.status, reason: a.void_reason };
      const exam = await examOfAttempt(t.query, a);
      if (!(await enforceGap(t.query, a, exam.options, new Date(), req.body.pageToken))) return { status: a.status, reason: a.void_reason };
      const ans = req.body.answers && typeof req.body.answers === 'object' && !Array.isArray(req.body.answers) ? req.body.answers : null;
      if (ans && JSON.stringify(ans).length <= 400000) {
        await t.query('UPDATE attempts SET last_seen = now(), disconnected_at = NULL, draft_answers = $1, draft_at = now() WHERE id = $2', [JSON.stringify(ans), a.id]);
      } else {
        await t.query('UPDATE attempts SET last_seen = now(), disconnected_at = NULL WHERE id = $1', [a.id]);
      }
      return { status: a.status, saved: !!ans, deadlineMs: a.deadline ? new Date(a.deadline).getTime() : null };
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
      if (a.status !== STATUS.IN_PROGRESS) {
        if (!req.body.resend) await logEvent(t.query, a.id, event, detail);
        return { status: a.status, reason: a.void_reason };
      }
      // A void kept on the device (sent again when the exam page opens) is old news once the teacher has let the
      // student continue: it must not void the attempt a second time.
      if (req.body.resend) {
        const helped = (await t.query(`SELECT 1 FROM violations WHERE attempt_id = $1 AND event = 'TEACHER_HELP' LIMIT 1`, [a.id])).rows[0];
        if (helped) {
          await logEvent(t.query, a.id, 'NOTE', 'An earlier void kept on the student\'s device was sent again after the teacher let them continue: ignored');
          return { status: a.status, ignored: true };
        }
      }
      // Leaving the exam (tab switch, another window): warnings first, if the exam allows them.
      if (['TAB_SWITCH', 'LEFT_WINDOW'].includes(event) && req.body.final !== true) {
        const allowedF = (await examOfAttempt(t.query, a)).options.focusWarnings;
        const usedF = Number(a.focus_warnings) || 0;
        if (usedF < allowedF) {
          await logEvent(t.query, a.id, event, 'WARNING ' + (usedF + 1) + ' of ' + allowedF + ': ' + detail);
          await t.query('UPDATE attempts SET focus_warnings = $1 WHERE id = $2', [usedF + 1, a.id]);
          return { status: a.status, warned: true, focusWarnings: usedF + 1 };
        }
      }
      const allowed = WARNABLE_EVENTS.includes(event) ? (await examOfAttempt(t.query, a)).options.cameraWarnings : 0;
      const used = Number(a.warnings) || 0;
      if (WARNABLE_EVENTS.includes(event) && used < allowed) {
        await logEvent(t.query, a.id, event, 'WARNING ' + (used + 1) + ' of ' + allowed + ': ' + detail);
        await t.query('UPDATE attempts SET warnings = $1 WHERE id = $2', [used + 1, a.id]);
        return { status: a.status, warned: true, warnings: used + 1 };
      }
      await logEvent(t.query, a.id, event, (WARNABLE_EVENTS.includes(event) ? 'VOIDED (camera problem ' + (used + 1) + ', ' + allowed + ' warning' + (allowed === 1 ? '' : 's') + ' allowed): ' : 'VOIDED: ') + detail);
      await voidAttempt(t.query, a, event);
      return { status: a.status, reason: a.void_reason };
    });
  },

  /**
   * A small JPEG from the camera: at the moment it flagged something (kept as proof), or a random check (event RANDOM)
   * when the exam takes random snapshots. Random ones are limited to the exam's number per hour.
   */
  async snapshot(req) {
    const b = req.body;
    if (!isUuid(b.attemptId)) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found.');
    const a = await db.one('SELECT * FROM attempts WHERE id = $1 AND student_id = $2', [b.attemptId, req.user.id]);
    if (!a) throw fail(404, 'NO_ATTEMPT', 'This exam session was not found.');
    const exam = await examOfAttempt((sql, p) => db.query(sql, p), a);
    const random = b.event === 'RANDOM';
    if (exam.faceMode !== 'ALWAYS' || !(random ? exam.options.randomSnapshots : exam.options.cameraSnapshots)) return { saved: false };
    const offlineLater = a.offline && a.last_seen && Date.now() - new Date(a.last_seen).getTime() < 24 * 3600000;
    if (random && a.status !== STATUS.IN_PROGRESS && !offlineLater) return { saved: false };
    const recentlyVoided = a.status === STATUS.VOIDED && a.voided_at && Date.now() - new Date(a.voided_at).getTime() < 5 * 60000;
    if (a.status !== STATUS.IN_PROGRESS && !recentlyVoided && !offlineLater) return { saved: false };
    const m = String(b.dataUrl || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw fail(400, 'BAD_INPUT', 'Bad picture.');
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length > 100 * 1024) throw fail(413, 'TOO_LARGE', 'Picture too large.');
    const kind = random ? 'random' : 'flag';
    const n = (await db.one('SELECT count(*)::int AS n FROM attempt_snapshots WHERE attempt_id = $1 AND kind = $2', [a.id, kind])).n;
    // random: at most (pictures per hour × hours since the start) + 1, so a page can't send more than the exam allows
    const until = a.offline && a.submitted_at ? new Date(a.submitted_at).getTime() : Date.now();
    const cap = random ? Math.floor(exam.options.snapshotsPerHour * Math.max(0, until - new Date(a.started_at).getTime()) / 3600000) + 1 : 10;
    if (n >= cap) return { saved: false };
    const event = random ? 'RANDOM' : VIOLATION_LABELS[b.event] ? b.event : 'CAMERA';
    await snapshots.save(a.id, event, kind, bytes);
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
      const token = req.body.pageToken;
      if (!(await enforceGap(q, a, exam.options, now, token))) return { error: blockedError(a) };
      // Finished while offline: the page sends when the internet is back. It counts as on time if it was finished before
      // the deadline and arrives within the exam's limit; the teacher sees "Sent late (offline)".
      const graceMs = exam.options.submitGraceSeconds * 1000;
      const deadlineMs = a.deadline ? new Date(a.deadline).getTime() : null;
      const finishedMs = Number(req.body.finishedAt);
      const offlineFinish = samePage(a, exam.options, token) && Number.isFinite(finishedMs) && finishedMs <= now.getTime() && now.getTime() - finishedMs > 30000;
      let late = deadlineMs !== null && now.getTime() > deadlineMs + graceMs;
      let sentLate = false;
      if (offlineFinish) {
        sentLate = true;
        late = deadlineMs !== null && (finishedMs > deadlineMs + graceMs || now.getTime() > deadlineMs + exam.options.offlineSubmitMinutes * 60000);
        await logEvent(q, a.id, 'SENT_LATE', 'Finished ' + new Date(finishedMs).toISOString() + ' while offline; the answers arrived ' + fmtGap(now.getTime() - finishedMs) + ' later' +
          (late ? ' (too late: marked Late).' : '.'));
      }
      await gradeAttempt(q, a, exam, req.body.answers, { now, late, sentLate, finishedAt: sentLate ? new Date(finishedMs) : now });
      return { result: resultFor(a, exam) };
    });
    if (out.error) throw out.error;
    return withRank(out.result, req.body.attemptId, req.user.id);
  },
};

/** Adds the student's rank to a submit result, when the exam shows scores and ranks. */
async function withRank(result, attemptId, studentId) {
  if (!result || !result.showScore || !isUuid(attemptId)) return result;
  const a = await db.one('SELECT exam_id FROM attempts WHERE id = $1 AND student_id = $2', [attemptId, studentId]);
  if (!a) return result;
  const x = await db.one('SELECT options, end_at FROM exams WHERE id = $1', [a.exam_id]);
  if (!x || !core.examOptions(x.options).showRank) return result;
  const rank = await core.rankOf((sql, p) => db.query(sql, p), a.exam_id, studentId);
  if (rank) result.rank = { rank: rank.rank, total: rank.total, mean: rank.mean, median: rank.median, sd: rank.sd, percentile: rank.percentile, current: rank.pending || !x.end_at || new Date(x.end_at) > new Date() };
  return result;
}

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
module.exports.gradeAttempt = gradeAttempt;
module.exports.receiveOffline = receiveOffline;
module.exports.examOfAttempt = examOfAttempt;
module.exports.logEvent = logEvent;
