// Makes the pictures used on the home page (public/assets/shot-*.webp) from a demo site
// filled with sample classes and exams. Run with: node test/screenshots.js
// Needs Python 3 with Pillow to convert the screenshots to small WebP files.
process.env.ADMIN_EMAIL = 'admin@demo.local';
process.env.ADMIN_PASSWORD = 'demo-admin-1';
const path = require('path'), os = require('os'), fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const db = require('../src/db');
const { createApp, ensureAdmin } = require('../server');

const OUT = path.join(__dirname, '..', 'public', 'assets');
const day = 86400000;

(async () => {
  await db.connect({ databaseUrl: '', dataDir: null });
  await ensureAdmin();
  const server = createApp().listen(0);
  const BASE = 'http://localhost:' + server.address().port;
  const client = () => {
    let cookie = '';
    return async (p, body) => {
      const r = await fetch(BASE + '/api' + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const j = await r.json(); if (!j.ok) throw new Error(p + ': ' + j.error); return j;
    };
  };
  const admin = client(), teacher = client(), student = client();
  await admin('/auth/login', { email: 'admin@demo.local', password: 'demo-admin-1' });
  const code = (await admin('/admin/codes', { kind: 'days', amount: 30 })).codes[0];
  await teacher('/auth/register', { role: 'teacher', name: 'Prof. Ana Reyes', email: 'ana@demo.local', password: 'demo-teacher-1', accessCode: code });
  const eee = (await teacher('/teacher/classes', { name: 'EEE 150', section: 'Section A' })).class;
  const math = (await teacher('/teacher/classes', { name: 'MATH 101', section: 'Section C' })).class;
  const q = async (b) => (await teacher('/teacher/questions', b)).question.id;
  const ids = [
    await q({ type: 'MC', text: 'A 10 Ω resistor carries 2 A. What is the voltage across it?', choices: ['5 V', '12 V', '20 V', '40 V'], answer: 'C', topic: 'Circuits' }),
    await q({ type: 'TF', text: 'In a series circuit, the same current flows through every component.', answer: 'TRUE', topic: 'Circuits' }),
    await q({ type: 'FIB', text: 'The unit of electrical resistance is the ____.', answer: 'ohm | ohms', topic: 'Units' }),
    await q({ type: 'MC', text: 'Which law states that the total current entering a junction equals the total current leaving it?', choices: ["Ohm's law", "Kirchhoff's current law", "Faraday's law", "Lenz's law"], answer: 'B', topic: 'Circuits' }),
    await q({ type: 'ESSAY', text: 'Explain, in 3–5 sentences, why household circuits are wired in parallel.', points: 5, topic: 'Circuits' }),
  ];
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const exam = async (b, publish = true) => {
    const x = (await teacher('/teacher/exams', Object.assign({ questionIds: ids, timeLimitMinutes: 60 }, b))).exam;
    if (publish) await teacher('/teacher/exams/' + x.id, { publish: true });
    return x;
  };
  const mid = await exam({ classId: eee.id, title: 'EEE 150 Midterm Exam', startAt: iso(now - 3600000), endAt: iso(now + 2 * day), timeLimitMinutes: 90, password: 'volt',
    displayMode: 'ONE', allowBack: true, faceMode: 'ALWAYS', instructions: 'Answer all questions. Calculators are not allowed. Essay answers are graded by your instructor.' });
  await exam({ classId: math.id, title: 'MATH 101 Quiz 3', startAt: iso(now + day + 3 * 3600000), endAt: iso(now + day + 5 * 3600000), timeLimitMinutes: 30 });
  const q2 = await exam({ classId: eee.id, title: 'EEE 150 Quiz 2', startAt: iso(now - 3 * day), endAt: iso(now + 3 * day), timeLimitMinutes: 20 });
  const prac = await exam({ classId: math.id, title: 'Practice Exam', startAt: iso(now - 5 * day), timeLimitMinutes: 15 });
  await exam({ classId: math.id, title: 'MATH 101 Long Exam 1', startAt: iso(now - 9 * day), endAt: iso(now - 8 * day) });

  await student('/auth/register', { role: 'student', name: 'Juan Dela Cruz', email: 'juan@demo.local', password: 'demo-student-1', studentNo: '2024-0153', school: 'MSU-IIT' });
  await student('/student/join', { code: eee.join_code });
  await student('/student/join', { code: math.join_code });
  const env = { monitorCheck: 'supported', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140' };
  for (const [x, right] of [[q2, true], [prac, false]]) {
    const st = await student('/attempt', { action: 'start', examId: x.id, env });
    const answers = {};
    st.questions.forEach((qq) => {
      if (qq.type === 'MC') answers[qq.id] = (qq.choices.find((c) => /20 V|Kirchhoff/.test(c.text)) || qq.choices[0]).key;
      if (qq.type === 'TF') answers[qq.id] = right ? 'TRUE' : 'FALSE';
      if (qq.type === 'FIB') answers[qq.id] = 'ohm';
      if (qq.type === 'ESSAY') answers[qq.id] = 'Each appliance gets the full voltage and works independently.';
    });
    await student('/attempt', { action: 'submit', attemptId: st.attemptId, answers });
  }

  const browser = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const shots = [];
  // Student dashboard
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(BASE + '/');
  await p.fill('#inEmail', 'juan@demo.local'); await p.fill('#inPass', 'demo-student-1'); await p.click('#signIn button[type=submit]');
  await p.waitForSelector('.item');
  await p.click(`.item[data-id="${mid.id}"]`);
  await p.waitForSelector('#startbox a.btn');
  await p.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.hidden = true; });
  shots.push(['dashboard', path.join(tmp, 'dashboard.png')]);
  await p.screenshot({ path: shots[0][1] });
  // Exam screen (a second student taking the midterm, camera off for the picture)
  await teacher('/teacher/exams/' + mid.id, Object.assign({}, { classId: eee.id, title: 'EEE 150 Midterm Exam', questionIds: ids, startAt: iso(now - 3600000), endAt: iso(now + 2 * day),
    timeLimitMinutes: 90, displayMode: 'ALL', faceMode: 'OFF', shuffleQuestions: false, password: 'volt', instructions: 'Answer all questions.' }));
  const s2 = client();
  await s2('/auth/register', { role: 'student', name: 'Maria Lopez', email: 'maria@demo.local', password: 'demo-student-2', studentNo: '2024-0207' });
  await s2('/student/join', { code: eee.join_code });
  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
  await ctx2.addInitScript(() => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return false; } }); });
  const e = await ctx2.newPage();
  await e.goto(BASE + '/');
  await e.fill('#inEmail', 'maria@demo.local'); await e.fill('#inPass', 'demo-student-2'); await e.click('#signIn button[type=submit]');
  await e.waitForSelector('.item');
  await e.goto(BASE + '/exam?id=' + mid.id);
  await e.waitForSelector('#screen-rules:not([hidden])');
  await e.check('#agree'); await e.fill('#examPassword', 'volt'); await e.click('#startBtn');
  await e.waitForSelector('#screen-exam:not([hidden])');
  await e.click('.question:nth-child(1) .choice:has-text("20 V")');
  await e.check('.question:nth-child(2) input[value=TRUE]');
  await e.evaluate(() => window.scrollTo(0, 0));
  shots.push(['exam', path.join(tmp, 'exam.png')]);
  await e.screenshot({ path: shots[1][1] });
  await browser.close(); server.close(); await db.close();

  for (const [name, file] of shots) {
    const out = path.join(OUT, 'shot-' + name + '.webp');
    execFileSync('python3', ['-c', 'import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert("RGB"); im.save(sys.argv[2], "WEBP", quality=82, method=6)', file, out]);
    console.log('wrote', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
  }
})().catch((err) => { console.error(err); process.exit(1); });
