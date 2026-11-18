// Collect answers by QR code: the teacher (signed in) or a helper with a collector link scans the QR codes that a
// finished offline exam shows. Works with the student's device offline; the scanner phone sends what it scanned.
//
// QR text (all parts joined): EW1~<packageId>~<finishedAt base36>~<startedAt base36>~<receipt>~<flags>~<answers JSON>
//   flags: comma list of v=<EVENT> (voided), r=<reloads>, c=<camera warnings>, f=<tab warnings>, k (clock changed)
//   answers: an array in question order (the order of the downloaded copy); "" = no answer; true/false as T/F.
// Each QR code: EWQ|<part>|<parts>|<first 8 of packageId>|<piece of the text>
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { fail, str, isUuid } = require('../util');

const router = express.Router();
const hashToken = (t) => crypto.createHash('sha256').update('ew-collect:' + String(t)).digest('hex');

/** Which exam this scanner collects for, and who is scanning: a signed-in teacher, or a valid collector link. */
async function scope(req) {
  const b = req.body || {};
  if (b.token) {
    const l = await db.one(`SELECT l.*, x.title FROM collector_links l JOIN exams x ON x.id = l.exam_id WHERE l.token_hash = $1`, [hashToken(b.token)]);
    if (!l || l.revoked) throw fail(403, 'LINK_OFF', 'This collector link was turned off by the teacher.');
    if (new Date(l.expires_at) < new Date()) throw fail(403, 'LINK_EXPIRED', 'This collector link has expired. Ask the teacher for a new one.');
    return { examId: l.exam_id, title: l.title, until: l.expires_at, helper: true, linkId: l.id, label: l.label };
  }
  if (!req.user || !['teacher', 'admin'].includes(req.user.role)) throw fail(401, 'SIGNED_OUT', 'Please sign in as the teacher, or open the collector link again.');
  if (!isUuid(b.examId)) throw fail(404, 'NOT_FOUND', 'Exam not found.');
  const x = await db.one('SELECT id, title FROM exams WHERE id = $1 AND teacher_id = $2', [b.examId, req.user.id]);
  if (!x) throw fail(404, 'NOT_FOUND', 'Exam not found.');
  return { examId: x.id, title: x.title, helper: false };
}

/** The joined QR text → the fields an offline hand-in needs (answers keyed by question id). */
async function decode(text) {
  const parts = [];
  let rest = String(text || '');
  for (let i = 0; i < 6; i++) { const k = rest.indexOf('~'); if (k < 0) throw fail(400, 'BAD_QR', 'This QR code is not from an Exam Wizard offline exam.'); parts.push(rest.slice(0, k)); rest = rest.slice(k + 1); }
  const [tag, packageId, fin36, start36, receipt, flags] = parts;
  if (tag !== 'EW1' || !isUuid(packageId)) throw fail(400, 'BAD_QR', 'This QR code is not from an Exam Wizard offline exam.');
  let list;
  try { list = JSON.parse(rest); } catch (e) { throw fail(400, 'BAD_QR', 'The QR code could not be read completely. Scan it again.'); }
  if (!Array.isArray(list)) throw fail(400, 'BAD_QR', 'The QR code could not be read completely. Scan it again.');
  const pkg = await db.one('SELECT * FROM offline_packages WHERE id = $1', [packageId]);
  if (!pkg) throw fail(404, 'NO_ATTEMPT', 'This exam copy is not known here (wrong exam or deleted).');
  const types = new Map((await db.many('SELECT id, type FROM questions WHERE id = ANY($1::uuid[])', [pkg.question_ids])).map((r) => [r.id, r.type]));
  const answers = {};
  pkg.question_ids.forEach((id, i) => {
    let v = list[i];
    if (v === undefined || v === null || v === '') return;
    v = String(v);
    if (types.get(id) === 'TF') v = v === 'T' ? 'TRUE' : v === 'F' ? 'FALSE' : v;
    answers[id] = v;
  });
  const f = {};
  String(flags || '').split(',').filter(Boolean).forEach((x) => { const [k, val] = x.split('='); f[k] = val === undefined ? true : val; });
  const events = [{ event: 'QR_HANDIN', detail: 'Answers handed in by QR code' + (f.k ? '; the device clock was changed' : ''), at: Date.now() }];
  if (f.k) events.push({ event: 'CLOCK_CHANGED', detail: 'reported in the QR code', at: Date.now() });
  return {
    pkg,
    body: { packageId, answers, finishedAt: parseInt(fin36, 36), startedAt: parseInt(start36, 36), receipt: str(receipt, 10), events,
      voided: f.v ? { event: String(f.v), detail: 'voided on the device (from the QR code)' } : null,
      reloads: Number(f.r) || 0, cameraWarnings: Number(f.c) || 0, focusWarnings: Number(f.f) || 0, env: { device: 'offline (QR)' } },
  };
}

router.post('/info', async (req, res) => {
  const s = await scope(req);
  res.json({ ok: true, exam: { id: s.examId, title: s.title }, until: s.until || null, helper: s.helper, label: s.label || '' });
});

router.post('/', async (req, res) => {
  const s = await scope(req);
  const { pkg, body } = await decode(req.body.payload);
  if (pkg.exam_id !== s.examId) throw fail(409, 'OTHER_EXAM', 'This QR code is for a different exam.');
  const student = await db.one('SELECT name, student_no, email FROM users WHERE id = $1', [pkg.student_id]);
  const before = await db.one('SELECT id FROM attempts WHERE id = $1', [pkg.id]);
  const who = s.helper ? 'a QR code scanned by a helper' + (s.label ? ' (' + str(s.label, 60) + ')' : '') : 'a QR code scanned by the teacher';
  const r = await require('./attempt').receiveOffline(body, { examId: s.examId, source: who });
  if (s.linkId) await db.query('UPDATE collector_links SET scans = scans + 1 WHERE id = $1', [s.linkId]);
  res.json({
    ok: true, already: !!before, student: { name: student ? student.name : '?', studentNo: student ? student.student_no : '' }, receipt: body.receipt,
    status: r.status === 'VOIDED' ? 'VOIDED' : 'SUBMITTED',
    score: s.helper || r.status === 'VOIDED' ? undefined : r.score, maxScore: s.helper ? undefined : r.maxScore, receiptOk: r.receiptOk,
  });
});

module.exports = router;
module.exports.hashToken = hashToken;
