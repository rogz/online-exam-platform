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
/** Camera events give warnings first (cameraWarnings, default 1); the next one voids the exam. */
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
  cameraWarnings: 1,
  focusWarnings: 0,
  pointsRule: { mode: 'OFF', all: 1, byType: {}, byTopic: {} }, // optional: override the bank's points for this exam
  typePicks: [],           // random picks per question type, e.g. [{ type: 'MC', count: 10 }, { type: 'TF', count: 5 }]        // tab/window switches allowed (each shows a warning) before the next one voids the exam       // camera problems allowed (each shows a warning) before the next one voids the exam
  phoneDetection: true,
  headDetection: true,     // a lowered head (writing, solving) counts as present, not 'no face'
  cameraSnapshots: true,   // save a small still picture when the camera flags something
  randomSnapshots: false,  // also take small pictures at random times (camera exams monitored throughout)
  snapshotsPerHour: 6,     // how many random pictures per hour (one at a random moment in each part of the hour)
  openCountdown: true,
  timeWarnings: [5, 1],
  reconnectSeconds: 60,
  maxReconnects: 3,
  showRank: true,          // with "show score": also show the student's rank (e.g. 3rd of 25)
  offlineMode: false,      // students may download the exam before and take it without internet (needs a strong password)
  keepGoingOffline: true,  // internet drops while the exam page stays open: keep going, send the answers when it's back
  offlineSubmitMinutes: 60, // answers finished in time but sent this many minutes after the deadline are still accepted
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
    cameraWarnings: Math.min(10, Math.round(num(o.cameraWarnings, 1, 0))),
    focusWarnings: Math.min(10, Math.round(num(o.focusWarnings, 0, 0))),
    typePicks: (Array.isArray(o.typePicks) ? o.typePicks : [])
      .map((t) => ({ type: String((t && t.type) || '').toUpperCase(), count: Math.round(Number(t && t.count) || 0) }))
      .filter((t, i, a) => ['MC', 'TF', 'FIB', 'ESSAY'].includes(t.type) && t.count > 0 && a.findIndex((u) => u.type === t.type) === i),
    pointsRule: pointsRule(o.pointsRule),
    phoneDetection: o.phoneDetection !== false,
    headDetection: o.headDetection !== false,
    cameraSnapshots: o.cameraSnapshots !== false,
    randomSnapshots: o.randomSnapshots === true,
    snapshotsPerHour: Math.min(30, Math.max(1, Math.round(num(o.snapshotsPerHour, 6, 1)))),
    openCountdown: o.openCountdown !== false,
    timeWarnings: (Array.isArray(o.timeWarnings) ? o.timeWarnings : String(o.timeWarnings || '').split(/[,;\s]+/))
      .map(Number).filter((n) => n > 0).sort((a, b) => b - a),
    reconnectSeconds: Math.round(num(o.reconnectSeconds, 60, 0)),
    maxReconnects: Math.round(num(o.maxReconnects, 3, 0)),
    showRank: o.showRank !== false,
    offlineMode: o.offlineMode === true,
    keepGoingOffline: o.keepGoingOffline !== false,
    offlineSubmitMinutes: Math.min(24 * 60, Math.round(num(o.offlineSubmitMinutes, 60, 0))),
  };
}

const ptsVal = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 ? Math.min(1000, n) : null; };

/** Optional points override: OFF (bank points), ALL (same for every question), TYPE or TOPIC (per type/topic; blank = bank points). */
function pointsRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mode = ['ALL', 'TYPE', 'TOPIC'].includes(String(r.mode).toUpperCase()) ? String(r.mode).toUpperCase() : 'OFF';
  const byType = {}, byTopic = {};
  Object.entries(r.byType && typeof r.byType === 'object' ? r.byType : {}).forEach(([k, v]) => {
    const t = String(k).toUpperCase(), n = ptsVal(v);
    if (['MC', 'TF', 'FIB', 'ESSAY'].includes(t) && n) byType[t] = n;
  });
  Object.entries(r.byTopic && typeof r.byTopic === 'object' ? r.byTopic : {}).slice(0, 300).forEach(([k, v]) => {
    const t = String(k).trim().slice(0, 200), n = ptsVal(v);
    if (t && n) byTopic[t] = n;
  });
  return { mode, all: ptsVal(r.all) || 1, byType, byTopic };
}

/** The exam's questions with the exam's points override applied (the bank is not changed). */
function applyPoints(exam, pool) {
  const r = exam.options && exam.options.pointsRule;
  if (!r || r.mode === 'OFF') return pool;
  const topics = new Map(Object.entries(r.byTopic).map(([k, v]) => [normTopic(k), v]));
  return pool.map((q) => {
    const p = r.mode === 'ALL' ? r.all : r.mode === 'TYPE' ? r.byType[q.type] : topics.get(normTopic(q.topic));
    return p ? Object.assign({}, q, { points: p }) : q;
  });
}

/**
 * The student's rank among everyone who submitted this exam (each student's latest submitted attempt, by percent;
 * equal percents share a rank). q(sql, params) runs a query. Returns null when the student has no submitted attempt.
 */
async function rankOf(q, examId, studentId) {
  const r = (await q(`WITH last AS (
      SELECT DISTINCT ON (student_id) student_id, percent FROM attempts
       WHERE exam_id = $1 AND status = 'SUBMITTED' ORDER BY student_id, submitted_at DESC)
    SELECT (SELECT percent FROM last WHERE student_id = $2) AS mine, (SELECT count(*)::int FROM last) AS total,
           (SELECT count(*)::int FROM last WHERE percent > (SELECT percent FROM last WHERE student_id = $2)) AS above,
           (SELECT count(*)::int FROM last WHERE percent = (SELECT percent FROM last WHERE student_id = $2)) AS same,
           (SELECT count(*)::int FROM attempts WHERE exam_id = $1 AND (status = 'IN_PROGRESS' OR (status = 'SUBMITTED' AND pending_essays > 0))) AS open_count`,
    [examId, studentId])).rows[0];
  if (!r || r.mine === null || r.mine === undefined) return null;
  const all = (await q(`SELECT DISTINCT ON (student_id) percent FROM attempts WHERE exam_id = $1 AND status = 'SUBMITTED' ORDER BY student_id, submitted_at DESC`, [examId])).rows
    .map((x) => Number(x.percent) || 0).sort((a, b) => a - b);
  const n = all.length, mean = all.reduce((t, v) => t + v, 0) / n;
  const median = n % 2 ? all[(n - 1) / 2] : (all[n / 2 - 1] + all[n / 2]) / 2;
  const sd = Math.sqrt(all.reduce((t, v) => t + (v - mean) * (v - mean), 0) / n);
  const below = all.filter((v) => v < Number(r.mine)).length;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { rank: r.above + 1, total: r.total, tied: r.same > 1, pending: r.open_count > 0,
    mean: r2(mean), median: r2(median), sd: r2(sd), percentile: r2((below + 0.5 * r.same) / n * 100) };
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
    get typePicks() { return this.topicCounts.length ? [] : this.options.typePicks; },
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

// ───────── Fill in the blank: number ranges, units, close spellings ─────────

const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const cleanNum = (s) => String(s).trim().replace(/[−–—]/g, (c) => (c === '−' ? '-' : c)).replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
const cleanUnit = (u) => String(u || '').trim().replace(/\.$/, '').replace(/\s+/g, '');

/** "122.5 V" → { value: 122.5, unit: 'V' }; null when the text doesn't start with a number. */
function parseNumber(s) {
  const m = new RegExp('^(' + NUM + ')\\s*(.*)$').exec(cleanNum(s));
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, unit: cleanUnit(m[2]) } : null;
}

/**
 * A numeric accepted answer: "122.1..122.9 V", "122.1-122.9", "122.1 to 122.9", "122.5 ± 0.4", "122.5 +- 0.5%", or a plain
 * number "0.7788" (exact value, so ".7788" and "0.77880" also count). null when the entry is text.
 */
function numericSpec(entry) {
  const t = cleanNum(entry);
  let m = new RegExp('^(' + NUM + ')\\s*(?:\\.\\.|to|–|—|-)\\s*(' + NUM + ')\\s*([^\\d\\s].*)?$', 'i').exec(t);
  if (m && Number(m[1]) <= Number(m[2])) return { lo: Number(m[1]), hi: Number(m[2]), unit: cleanUnit(m[3]) };
  m = new RegExp('^(' + NUM + ')\\s*(?:±|\\+-|\\+/-)\\s*(' + NUM + ')\\s*(%)?\\s*(.*)$').exec(t);
  if (m) {
    const c = Number(m[1]), d = Math.abs(Number(m[2])) * (m[3] ? Math.abs(c) / 100 : 1);
    return { lo: c - d, hi: c + d, unit: cleanUnit(m[4]) };
  }
  const n = parseNumber(t);
  if (n && /^[^\d]*$/.test(n.unit) && !/^[-–—]/.test(n.unit)) return { lo: n.value, hi: n.value, unit: n.unit };
  return null;
}

const inRange = (v, sp) => { const eps = 1e-9 * Math.max(1, Math.abs(sp.lo), Math.abs(sp.hi)); return v >= sp.lo - eps && v <= sp.hi + eps; };

/** Edit distance with swapped neighbours counting as one (Damerau, optimal string alignment). */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(Array(b.length).fill(0)));
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** True when `given` looks like a misspelling of `expected` (1 letter off; 2 for 8+ letters). Not for short words or numbers. */
function closeSpelling(given, expected) {
  const a = normText(given), b = normText(expected);
  if (a === b || b.length < 4 || /\d/.test(b) || /\d/.test(a) || Math.abs(a.length - b.length) > 2) return false;
  return editDistance(a, b) <= (b.length >= 8 ? 2 : 1);
}

/** Grades a fill-in-the-blank answer. Returns { correct, note } where note is for the teacher only. */
function gradeFib(answerKey, value) {
  const entries = String(answerKey).split('|').map((s) => s.trim()).filter(Boolean);
  const given = String(value).trim();
  if (!given) return { correct: false, note: '' };
  if (entries.some((e) => normText(e) === normText(given))) return { correct: true, note: '' };
  const n = parseNumber(given);
  if (n) {
    for (const e of entries) {
      const sp = numericSpec(e);
      if (!sp || !inRange(n.value, sp)) continue;
      const diff = sp.unit && n.unit && sp.unit.toLowerCase() !== n.unit.toLowerCase();
      return { correct: true, note: diff ? 'Different unit: the student wrote "' + n.unit + '", the answer key uses "' + sp.unit + '".' : '' };
    }
  }
  if (n) {
    // just outside: within one more range width (a plain number: within 1%) → flag for the teacher
    for (const e of entries) {
      const sp = numericSpec(e);
      if (!sp) continue;
      const w = sp.hi > sp.lo ? (sp.hi - sp.lo) / 2 : Math.abs(sp.lo) * 0.01;
      if (w > 0 && n.value >= sp.lo - w && n.value <= sp.hi + w) {
        return { correct: false, note: 'Close number: ' + given + ' is just outside the answer key (' + e + '). Give the points if you accept it.' };
      }
    }
  }
  const near = entries.find((e) => !numericSpec(e) && closeSpelling(given, e));
  return { correct: false, note: near ? 'Close spelling: "' + given + '" is close to "' + near + '". Give the points if you accept it.' : '' };
}

function gradeQuestion(q, raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).slice(0, 20000);
  const out = { correct: false, points: 0, pending: false, studentText: value, correctText: '', note: '' };
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
    out.correctText = String(q.answer).split('|').map((s) => s.trim()).filter(Boolean).join(' / ');
    Object.assign(out, gradeFib(q.answer, value));
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
  } else if (exam.typePicks && exam.typePicks.length) {
    const picked = new Set();
    exam.typePicks.forEach((tp) => {
      seededShuffle(pool.filter((q) => q.type === tp.type), attemptId + ':pick:' + tp.type).slice(0, tp.count).forEach((q) => picked.add(q.id));
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
  if (exam.typePicks && exam.typePicks.length) {
    let count = 0, points = 0, fixed = true;
    const typeCounts = {};
    exam.typePicks.forEach((tp) => {
      const ofType = pool.filter((q) => q.type === tp.type);
      const n = Math.min(tp.count, ofType.length);
      if (!n) return;
      count += n; typeCounts[tp.type] = n;
      if (n === ofType.length) points += sum(ofType.map((q) => q.points));
      else if (samePoints(ofType)) points += n * ofType[0].points;
      else fixed = false;
    });
    return { count, poolSize: pool.length, totalPoints: fixed ? points : null, typeCounts, topicBreakdown: null };
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
  const d = String((env && env.device) || '');
  // The exam page checks the hardware (touch-only screen and its size), which "desktop site" mode can't hide.
  if (d === 'phone') return 'phone';
  if (/iPhone|iPod|Windows Phone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return 'phone';
  if (d === 'tablet') return d;
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
  seededShuffle, attemptQuestions, setSummary, rankOf, gradeFib, numericSpec, parseNumber, closeSpelling, applyPoints, pointsRule, publicQuestion, normTopic,
  driveFileId, externalImageUrl, deviceOf, deviceAllowed,
};
