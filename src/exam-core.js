// Exam rules shared by the whole site: grading, random question sets, devices,
// integrity events. Ported from the Google Sheets version (apps-script/Code.gs).

const STATUS = { IN_PROGRESS: 'IN_PROGRESS', SUBMITTED: 'SUBMITTED', VOIDED: 'VOIDED', EXPIRED: 'EXPIRED' };

const VIOLATION_LABELS = {
  TAB_SWITCH: 'Switched to another tab or minimized the exam window',
  LEFT_WINDOW: 'Left the exam window (for example Alt+Tab to another application)',
  SECOND_MONITOR: 'A second monitor was connected during the exam',
  PAGE_CLOSED: 'Closed or reloaded the exam page',
  NO_FACE: 'Face was not visible to the camera',
  CAMERA_BLOCKED: 'The camera was covered or blocked',
  MULTIPLE_FACES: 'More than one person was in front of the camera',
  PHONE_DETECTED: 'A mobile phone was seen on camera',
  CAMERA_OFF: 'The camera was turned off or disconnected',
  CONNECTION_LOST: 'Was disconnected for longer than allowed',
  TOO_MANY_RECONNECTS: 'Reconnected more times than allowed',
};
/** Camera events give one warning first; the next one voids the exam. */
const WARNABLE_EVENTS = ['NO_FACE', 'CAMERA_BLOCKED', 'MULTIPLE_FACES', 'PHONE_DETECTED', 'CAMERA_OFF'];
const PING_SLACK_MS = 30000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Integrity options each exam can override (Advanced settings in the exam editor). */
const DEFAULT_OPTIONS = {
  blurGraceSeconds: 0,
  requireMonitorCheck: true,
  blockCopyPaste: true,
  submitGraceSeconds: 60,
  faceGraceSeconds: 3,
  phoneDetection: true,
  openCountdown: true,
  timeWarnings: [5, 1],
  reconnectSeconds: 60,
  maxReconnects: 3,
};

function examOptions(raw) {
  const o = Object.assign({}, DEFAULT_OPTIONS, raw || {});
  const num = (v, d, min) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, n) : d; };
  return {
    blurGraceSeconds: num(o.blurGraceSeconds, 0, 0),
    requireMonitorCheck: o.requireMonitorCheck !== false,
    blockCopyPaste: o.blockCopyPaste !== false,
    submitGraceSeconds: num(o.submitGraceSeconds, 60, 0),
    faceGraceSeconds: num(o.faceGraceSeconds, 3, 1),
    phoneDetection: o.phoneDetection !== false,
    openCountdown: o.openCountdown !== false,
    timeWarnings: (Array.isArray(o.timeWarnings) ? o.timeWarnings : String(o.timeWarnings || '').split(/[,;\s]+/))
      .map(Number).filter((n) => n > 0).sort((a, b) => b - a),
    reconnectSeconds: Math.round(num(o.reconnectSeconds, 60, 0)),
    maxReconnects: Math.round(num(o.maxReconnects, 3, 0)),
  };
}

/** Exam row from the database → the settings the rules below use. */
function examConfig(row) {
  const displayMode = row.display_mode === 'ONE' ? 'ONE' : 'ALL';
  let questionSeconds = displayMode === 'ONE' ? Math.max(0, Number(row.question_seconds) || 0) : 0;
  let allowBack = displayMode === 'ONE' ? row.allow_back !== false : true;
  if (questionSeconds > 0) allowBack = false;
  return {
    id: row.id,
    teacherId: row.teacher_id,
    classId: row.class_id,
    title: row.title,
    instructions: row.instructions || '',
    questionIds: Array.isArray(row.question_ids) ? row.question_ids : [],
    start: row.start_at ? new Date(row.start_at) : null,
    end: row.end_at ? new Date(row.end_at) : null,
    limitMin: Math.max(0, Number(row.time_limit_min) || 0),
    shuffleQuestions: !!row.shuffle_q,
    shuffleChoices: !!row.shuffle_c,
    showScore: row.show_score !== false,
    displayMode,
    allowBack,
    questionSeconds,
    pickCount: Math.max(0, Number(row.pick_count) || 0),
    topicCounts: (Array.isArray(row.topic_counts) ? row.topic_counts : [])
      .map((t) => ({ topic: String(t.topic || '').trim(), count: Math.round(Number(t.count) || 0) }))
      .filter((t) => t.topic && t.count > 0),
    faceMode: ['START', 'ALWAYS'].includes(row.face_mode) ? row.face_mode : 'OFF',
    cameraPreview: row.camera_preview !== false,
    allowedDevices: ['TABLET', 'ANY'].includes(row.allowed_devices) ? row.allowed_devices : 'COMPUTER',
    password: row.password || '',
    options: examOptions(row.options),
    published: !!row.published,
  };
}

/** Question row from the database → plain object. */
function questionFromRow(r) {
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    text: r.text,
    choices: Array.isArray(r.choices) ? r.choices.map(String) : [],
    answer: r.answer == null ? '' : String(r.answer),
    points: Number(r.points) > 0 ? Number(r.points) : 1,
    topic: r.topic || '',
    imageId: r.image_id || null,
    imageUrl: r.image_url || null,
  };
}

function windowStatus(exam, now) {
  if (exam.start && now < exam.start) return 'NOT_YET_OPEN';
  if (exam.end && now > exam.end) return 'CLOSED';
  return 'OPEN';
}

// ───────── Validation & grading ─────────

function normText(v) {
  return String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

function parseTF(v) {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'f', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function letter(i) { return String.fromCharCode(65 + i); }

function mcCorrectIndex(q) {
  const ans = String(q.answer).trim();
  if (/^[A-Za-z]$/.test(ans)) { const i = ans.toUpperCase().charCodeAt(0) - 65; return i < q.choices.length ? i : -1; }
  const n = normText(ans);
  return q.choices.findIndex((c) => normText(c) === n);
}

function normType(t) {
  const s = String(t || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (['MC', 'MCQ', 'MULTIPLECHOICE'].includes(s)) return 'MC';
  if (['TF', 'TRUEFALSE', 'TRUEORFALSE'].includes(s)) return 'TF';
  if (['FIB', 'FILLINTHEBLANK', 'FILLINTHEBLANKS', 'BLANK', 'IDENTIFICATION'].includes(s)) return 'FIB';
  if (['ESSAY', 'SHORTESSAY'].includes(s)) return 'ESSAY';
  return '';
}

function validateQuestion(q) {
  const p = [];
  if (!['MC', 'TF', 'FIB', 'ESSAY'].includes(q.type)) p.push('choose a question type');
  if (!String(q.text || '').trim()) p.push('the question text is empty');
  if (q.type === 'MC') {
    if ((q.choices || []).filter((c) => String(c).trim()).length < 2) p.push('add at least 2 choices');
    else if (mcCorrectIndex(q) < 0) p.push('mark the correct choice');
  }
  if (q.type === 'TF' && parseTF(q.answer) === null) p.push('the answer must be True or False');
  if (q.type === 'FIB' && !String(q.answer || '').trim()) p.push('enter at least one accepted answer');
  return p;
}

function gradeQuestion(q, raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).slice(0, 20000);
  const out = { correct: false, points: 0, pending: false, studentText: value, correctText: '' };
  if (q.type === 'MC') {
    const ci = mcCorrectIndex(q);
    out.correctText = ci >= 0 ? letter(ci) + '. ' + q.choices[ci] : String(q.answer);
    if (value !== '' && /^\d+$/.test(value) && q.choices[Number(value)] !== undefined) {
      const idx = Number(value);
      out.studentText = letter(idx) + '. ' + q.choices[idx];
      out.correct = idx === ci;
    } else out.studentText = '';
  } else if (q.type === 'TF') {
    const expected = parseTF(q.answer), given = parseTF(value);
    out.correctText = expected === null ? String(q.answer) : (expected ? 'True' : 'False');
    out.studentText = given === null ? '' : (given ? 'True' : 'False');
    out.correct = given !== null && given === expected;
  } else if (q.type === 'FIB') {
    const accepted = String(q.answer).split('|').map(normText).filter(Boolean);
    out.correctText = String(q.answer).split('|').map((s) => s.trim()).filter(Boolean).join(' / ');
    out.correct = value.trim() !== '' && accepted.includes(normText(value));
  } else {
    out.pending = true;
    out.correctText = String(q.answer || '');
  }
  if (out.correct) out.points = q.points;
  return out;
}

// ───────── Random sets & shuffling ─────────

function seededShuffle(arr, seedStr) {
  seedStr = String(seedStr);
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const tmp = out[i]; out[i] = out[j]; out[j] = tmp; }
  return out;
}

const normTopic = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The questions one attempt gets (random set per student if configured), fixed per attempt. */
function attemptQuestions(exam, pool, attemptId) {
  let qs = pool;
  if (exam.topicCounts.length) {
    const picked = new Set();
    exam.topicCounts.forEach((tc) => {
      const inTopic = pool.filter((q) => normTopic(q.topic) === normTopic(tc.topic));
      seededShuffle(inTopic, attemptId + ':pick:' + normTopic(tc.topic)).slice(0, tc.count).forEach((q) => picked.add(q.id));
    });
    qs = pool.filter((q) => picked.has(q.id));
  } else if (exam.pickCount > 0 && exam.pickCount < pool.length) {
    const picked = new Set(seededShuffle(pool, attemptId + ':pick').slice(0, exam.pickCount).map((q) => q.id));
    qs = pool.filter((q) => picked.has(q.id));
  }
  return exam.shuffleQuestions ? seededShuffle(qs, String(attemptId)) : qs;
}

/** What students are told about the question set. */
function setSummary(exam, pool) {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const samePoints = (qs) => qs.length > 0 && qs.every((q) => q.points === qs[0].points);
  if (exam.topicCounts.length) {
    let count = 0, points = 0, fixed = true;
    const breakdown = exam.topicCounts.map((tc) => {
      const inTopic = pool.filter((q) => normTopic(q.topic) === normTopic(tc.topic));
      const n = Math.min(tc.count, inTopic.length);
      count += n;
      if (n === inTopic.length) points += sum(inTopic.map((q) => q.points));
      else if (samePoints(inTopic)) points += n * inTopic[0].points;
      else fixed = false;
      return { topic: tc.topic, count: n, available: inTopic.length };
    });
    return { count, poolSize: pool.length, totalPoints: fixed ? points : null, typeCounts: null, topicBreakdown: breakdown };
  }
  if (exam.pickCount > 0 && exam.pickCount < pool.length) {
    return { count: exam.pickCount, poolSize: pool.length, totalPoints: samePoints(pool) ? exam.pickCount * pool[0].points : null, typeCounts: null, topicBreakdown: null };
  }
  const typeCounts = {};
  pool.forEach((q) => { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });
  return { count: pool.length, poolSize: null, totalPoints: sum(pool.map((q) => q.points)), typeCounts, topicBreakdown: null };
}

/** Question as sent to a student: no answers. */
function publicQuestion(q, exam, attemptId) {
  const out = { id: q.id, type: q.type, text: q.text, points: q.points };
  if (q.type === 'MC') {
    let choices = q.choices.map((t, i) => ({ key: String(i), text: t }));
    if (exam.shuffleChoices) choices = seededShuffle(choices, attemptId + ':' + q.id);
    out.choices = choices;
  }
  if (q.imageId) out.image = { src: '/api/attempt/' + attemptId + '/image/' + q.id };
  else if (q.imageUrl) out.image = { src: externalImageUrl(q.imageUrl) };
  return out;
}

// ───────── Pictures ─────────

function driveFileId(v) {
  const s = String(v || '').trim();
  const m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?(?:[^#]*&)?id=|uc\?(?:[^#]*&)?id=|thumbnail\?(?:[^#]*&)?id=)([\w-]{20,})/) ||
    s.match(/googleusercontent\.com\/d\/([\w-]{20,})/);
  return m ? m[1] : null;
}

/** A link students' browsers can load. Drive (shared publicly) and Dropbox links are converted. */
function externalImageUrl(v) {
  const s = String(v || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return null;
  const drive = driveFileId(s);
  if (drive) return 'https://drive.google.com/thumbnail?id=' + drive + '&sz=w2000';
  if (/^https?:\/\/([\w-]+\.)*dropbox\.com\//i.test(s)) {
    let u = s.replace(/([?&])dl=[01]/, '$1raw=1');
    if (!/[?&]raw=1/.test(u)) u += (u.includes('?') ? '&' : '?') + 'raw=1';
    return u;
  }
  return s;
}

// ───────── Devices ─────────

function deviceOf(env) {
  const ua = String((env && env.userAgent) || '');
  if (/iPhone|iPod|Windows Phone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return 'phone';
  const d = String((env && env.device) || '');
  if (d === 'phone' || d === 'tablet') return d;
  if (/iPad|Tablet/i.test(ua) || /Android/i.test(ua)) return 'tablet';
  return 'computer';
}

function deviceAllowed(allowed, device) {
  if (allowed === 'ANY') return true;
  if (allowed === 'TABLET') return device === 'computer' || device === 'tablet';
  return device === 'computer';
}

module.exports = {
  STATUS, VIOLATION_LABELS, WARNABLE_EVENTS, PING_SLACK_MS, MAX_IMAGE_BYTES, DEFAULT_OPTIONS,
  examOptions, examConfig, questionFromRow, windowStatus,
  normText, parseTF, mcCorrectIndex, normType, validateQuestion, gradeQuestion,
  seededShuffle, attemptQuestions, setSummary, publicQuestion, normTopic,
  driveFileId, externalImageUrl, deviceOf, deviceAllowed,
};
