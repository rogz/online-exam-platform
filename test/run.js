// End-to-end test of the whole site in a real browser (Playwright + Chromium),
// with a throw-away in-memory database. Run with: npm test
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-1';
const os = require('os'), path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const db = require('../src/db');
const { createApp, ensureAdmin } = require('../server');

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'platform-shots');
fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  // TEST_DATABASE_URL=postgres://... runs the test against a real PostgreSQL server (it must be an empty database)
  await db.connect(process.env.TEST_DATABASE_URL ? { databaseUrl: process.env.TEST_DATABASE_URL } : { databaseUrl: '', dataDir: null });
  await ensureAdmin();
  const server = createApp().listen(0);
  const BASE = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const newUser = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 } }, opts || {}));
    await ctx.addInitScript(() => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return !!window.__ext; } }); });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.accept());
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
  /** Waits until a message containing `text` is shown. */
  const toastSays = async (p, text) => { try { await p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, text, { timeout: 10000 }); return true; } catch (e) { return false; } };
  const dbOne = (sql, params) => db.one(sql, params);

  // ── Admin creates an access code ──
  const admin = await newUser();
  await admin.goto(BASE + '/');
  await shot(admin, '01-home');
  await admin.fill('#inEmail', 'admin@test.local'); await admin.fill('#inPass', 'admin-pass-1'); await admin.click('#signIn button[type=submit]');
  await admin.waitForURL(/\/admin/);
  ok(true, 'admin signs in and lands on the admin console');
  await admin.click('a[href="#codes"]');
  await admin.fill('#cAmount', '30'); await admin.fill('#cNote', 'Free trial');
  await admin.click('#cCreate');
  await admin.waitForSelector('#cOut .code-box');
  const code = (await admin.textContent('#cOut .code-box')).trim();
  ok(/^T[A-Z0-9]{3}-[A-Z0-9]{4}$/.test(code), 'access code created: ' + code);

  // ── Teacher signs up with the code ──
  const teacher = await newUser();
  await teacher.goto(BASE + '/#signup');
  await teacher.check('input[value=teacher]');
  await teacher.fill('#upName', 'Maria Santos'); await teacher.fill('#upEmail', 'maria@school.edu'); await teacher.fill('#upPass', 'teacher-pass-1');
  await teacher.fill('#upSchool', 'MSU-IIT'); await teacher.fill('#upCode', code);
  await teacher.click('#signUp button[type=submit]');
  await teacher.waitForURL(/\/teacher/);
  ok(await toastSays(teacher, '30 days'), 'teacher gets 30 days from the code');
  ok(await teacher.isHidden('#accessBanner'), 'no "need access" banner with access');

  // class
  await teacher.click('#newClass');
  await teacher.fill('#cName', 'EEE 150'); await teacher.fill('#cSection', 'Section A');
  await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('.classcard .code-box');
  const joinCode = (await teacher.textContent('.classcard .code-box')).trim();
  ok(/^[A-Z0-9]{6}$/.test(joinCode), 'class created with join code ' + joinCode);
  await shot(teacher, '02-teacher-classes');

  // questions: MC with picture, TF, FIB, essay
  await teacher.click('a[href="#questions"]');
  await teacher.click('#addQ');
  await teacher.fill('#qeText', 'What is the unit of electrical resistance?');
  const chs = await teacher.$$('[data-ch]');
  const vals = ['Volt', 'Ohm', 'Ampere', 'Watt'];
  for (let i = 0; i < 4; i++) await chs[i].fill(vals[i]);
  await teacher.check('input[name=correct][value="1"]');
  await teacher.fill('#qeTopic', 'Easy');
  const pic = await teacher.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 120); g.strokeRect(20, 20, 260, 80); return c.toDataURL('image/png'); });
  const picFile = path.join(os.tmpdir(), 'circuit.png'); fs.writeFileSync(picFile, Buffer.from(pic.split(',')[1], 'base64'));
  await teacher.setInputFiles('#qeFile', picFile);
  await teacher.waitForSelector('#qePic img');
  await shot(teacher, '03-question-editor');
  await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('#qRows tr td:has-text("Q001")');
  ok(true, 'MC question with picture saved as Q001');
  const addSimple = async (type, text, fill) => {
    await teacher.click('#addQ'); await teacher.selectOption('#qeType', type); await teacher.fill('#qeText', text); await fill(); await teacher.click('.dialog .btn.primary');
    await teacher.waitForSelector(`#qRows td.qtext:has-text("${text.slice(0, 20)}")`);
  };
  await addSimple('TF', 'Current is measured in amperes.', async () => { await teacher.check('input[name=tf][value=TRUE]'); await teacher.fill('#qeTopic', 'Easy'); });
  await addSimple('FIB', 'V = I × ____', async () => { await teacher.fill('#qeFib', 'R | resistance'); await teacher.fill('#qeTopic', 'Hard'); });
  await addSimple('ESSAY', 'Explain Ohm\'s law in your own words.', async () => { await teacher.fill('#qePoints', '5'); });
  // CSV import
  await teacher.click('#importBtn');
  const csv = path.join(os.tmpdir(), 'bank.csv');
  fs.writeFileSync(csv, 'QuestionID,Type,Question,Choices,Answer,Points,Topic\nH-1,MC,1 kΩ equals,10 Ω | 100 Ω | 1000 Ω,C,1,Hard\nH-2,TF,"Power = V × I",,TRUE,1,Hard\n');
  await teacher.setInputFiles('#csvFile', csv);
  await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('#csvOut .note');
  ok((await teacher.textContent('#csvOut')).includes('2 added'), 'CSV import adds 2 questions');
  await teacher.click('.dialog .x');
  await teacher.waitForFunction(() => document.querySelectorAll('#qRows tr').length === 6);
  await shot(teacher, '04-question-bank');

  // exam
  await teacher.click('a[href="#exams"]');
  await teacher.click('a[href="#exam/new"]');
  await teacher.waitForSelector('#pRows [data-q]');
  await teacher.fill('#eTitle', 'EEE 150 Quiz 1');
  await teacher.fill('#eLimit', '20');
  await teacher.fill('#ePass', 'ohm');
  await teacher.check('#pAll');
  await teacher.waitForFunction(() => document.querySelector('#pSum').textContent.startsWith('6 selected'));
  await shot(teacher, '05-exam-editor');
  await teacher.click('#pubBtn');
  ok(await toastSays(teacher, 'Published'), 'exam published');

  // ── Student signs up, joins, takes the exam ──
  const student = await newUser();
  await student.goto(BASE + '/#signup');
  await student.fill('#upName', 'Juan Dela Cruz'); await student.fill('#upEmail', 'juan@student.edu'); await student.fill('#upPass', 'student-pass-1'); await student.fill('#upStudentNo', '2024-0001');
  await student.click('#signUp button[type=submit]');
  await student.waitForURL(/\/student/);
  await student.waitForSelector('#joinBig2');
  ok(true, 'new student sees "Join a class"');
  await student.click('#joinBtn'); await student.fill('#joinCode', joinCode.toLowerCase()); await student.click('.dialog .btn.primary');
  await student.waitForSelector('.item:has-text("EEE 150 Quiz 1")');
  ok((await student.textContent('#list')).includes('Open now'), 'exam listed under "Open now"');
  await student.waitForSelector('#startbox a.btn.primary');
  ok((await student.textContent('.tiles')).includes('Password'), 'detail pane shows settings tiles');
  await shot(student, '06-student-dashboard');
  await student.click('#startbox a.btn.primary');
  await student.waitForSelector('#screen-rules:not([hidden])');
  ok((await student.textContent('#whoName')) === 'Juan Dela Cruz', 'exam page knows the signed-in student');
  await student.check('#agree');
  await student.fill('#examPassword', 'wrong');
  await student.click('#startBtn');
  await student.waitForSelector('#startError:not([hidden])');
  ok((await student.textContent('#startError')).includes('password is incorrect'), 'wrong exam password refused');
  await student.fill('#examPassword', 'OHM');
  await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  ok((await student.$$('.question')).length === 6, '6 questions shown');
  await student.waitForFunction(() => { const i = document.querySelector('.q-image img'); return i && i.complete && i.naturalWidth > 0; });
  ok(true, 'uploaded picture loads for the student');
  // answer everything correctly
  const qs = await student.$$eval('.question', (els) => els.map((e) => ({ id: e.dataset.id, text: e.querySelector('.q-text').textContent })));
  for (const q of qs) {
    const li = `.question[data-id="${q.id}"]`;
    if (q.text.includes('resistance')) await student.click(`${li} .choice:has-text("Ohm")`);
    else if (q.text.includes('amperes') || q.text.includes('Power')) await student.check(`${li} input[value=TRUE]`);
    else if (q.text.includes('1 kΩ')) await student.click(`${li} .choice:has-text("1000")`);
    else if (q.text.includes('V = I')) await student.fill(`${li} input.blank`, 'r');
    else await student.fill(`${li} textarea`, 'Voltage equals current times resistance.');
  }
  await shot(student, '07-exam-screen');
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#screen-result:not([hidden])');
  ok((await student.textContent('#resultScore')).includes('5 / 10'), 'auto-graded 5 of 10 (essay pending): ' + await student.textContent('#resultScore'));
  await student.click('#resultBack');
  await student.waitForSelector('.item:has-text("EEE 150 Quiz 1")');
  ok((await student.textContent('#list')).includes('Completed'), 'dashboard moves the exam to Completed');
  await student.waitForSelector('#startbox .score');
  await shot(student, '08-student-completed');

  // ── Teacher grades the essay and allows a retake ──
  await teacher.goto(BASE + '/teacher#exams');
  await teacher.click('a[href^="#results/"]');
  await teacher.waitForSelector('[data-answers]');
  ok((await teacher.textContent('.statgrid')).includes('Essays to grade'), 'results page shows stats');
  await teacher.click('[data-answers]');
  await teacher.waitForSelector('.dialog [data-pts]');
  const essayInput = await teacher.$('.dialog .resp:has-text("Explain Ohm") [data-pts]');
  await essayInput.fill('4');
  await shot(teacher, '09-grading');
  await teacher.click('.dialog .btn.primary');
  ok(await toastSays(teacher, '9 / 10'), 'essay graded: score 9 / 10');
  await teacher.check('[data-retake]');
  await sleep(300);
  const att = await dbOne(`SELECT * FROM attempts ORDER BY started_at LIMIT 1`);
  ok(att.allow_retake === true && att.score === 9 && att.pending_essays === 0, 'retake allowed and score saved in the database');

  // ── Student retakes, switches tab → voided ──
  await student.goto(BASE + '/student');
  await student.waitForSelector('#startbox a.btn.primary');
  ok((await student.textContent('#startbox')).includes('take this exam again'), 'student sees the retake');
  await student.click('#startbox a.btn.primary');
  await student.waitForSelector('#screen-rules:not([hidden])');
  await student.check('#agree'); await student.fill('#examPassword', 'ohm'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await student.waitForSelector('#voidModal:not([hidden])', { timeout: 5000 });
  await sleep(500);
  const voided = await dbOne(`SELECT status, void_reason FROM attempts WHERE is_retake ORDER BY started_at DESC LIMIT 1`);
  ok(voided.status === 'VOIDED' && /tab/.test(voided.void_reason), 'tab switch voids the retake on the server');
  await student.evaluate(() => { delete document.visibilityState; });
  await student.click('#voidBack');
  await student.waitForSelector('#startbox .tag.bad');
  ok(true, 'dashboard shows Voided');

  // ── Credits: a teacher without access must request credits ──
  const t2 = await newUser();
  await t2.goto(BASE + '/#signup');
  await t2.check('input[value=teacher]');
  await t2.fill('#upName', 'Pedro Reyes'); await t2.fill('#upEmail', 'pedro@school.edu'); await t2.fill('#upPass', 'teacher-pass-2');
  await t2.click('#signUp button[type=submit]');
  await t2.waitForURL(/\/teacher/);
  await t2.waitForSelector('#accessBanner:not([hidden])');
  ok(true, 'teacher without access sees the access banner');
  await t2.click('#newClass'); await t2.fill('#cName', 'Physics'); await t2.click('.dialog .btn.primary'); await t2.waitForSelector('.classcard');
  await t2.click('a[href="#questions"]'); await t2.click('#addQ'); await t2.selectOption('#qeType', 'TF'); await t2.fill('#qeText', 'g ≈ 9.8 m/s²'); await t2.check('input[name=tf][value=TRUE]');
  await t2.click('.dialog .btn.primary'); await t2.waitForSelector('#qRows td:has-text("Q001")');
  await t2.click('a[href="#exams"]'); await t2.click('a[href="#exam/new"]'); await t2.waitForSelector('#pRows [data-q]');
  await t2.fill('#eTitle', 'Physics quiz'); await t2.check('#pAll');
  await t2.click('#pubBtn');
  ok(await toastSays(t2, 'access code or 1 credit'), 'publishing without credits is refused');
  await t2.waitForURL(/#account/);
  await t2.waitForSelector('#request');
  await t2.fill('#rqCredits', '10'); await t2.fill('#rqRef', 'GCASH-123456'); await t2.click('#request');
  ok(await toastSays(t2, 'Request sent'), 'credit request sent');
  await shot(t2, '10-teacher-account');
  await admin.goto(BASE + '/admin#requests');
  await admin.waitForSelector('[data-approve]');
  await admin.waitForFunction(() => document.querySelector('#reqBadge').textContent === '1');
  ok(true, 'admin sees 1 waiting request');
  await shot(admin, '11-admin-requests');
  await admin.click('[data-approve]'); await admin.click('.dialog .btn.primary');
  await admin.waitForSelector('.tag.ok');
  await t2.goto(BASE + '/teacher#exams'); await t2.waitForSelector('a[href^="#exam/"]:has-text("Edit")');
  await t2.click('a[href^="#exam/"]:has-text("Edit")');
  await t2.waitForSelector('#pubBtn');
  await t2.click('#pubBtn');
  ok(await toastSays(t2, '1 credit used'), 'publishing uses 1 credit');
  const pedro = await dbOne(`SELECT credits FROM users WHERE email = 'pedro@school.edu'`);
  ok(pedro.credits === 9, 'teacher has 9 credits left');

  // ── Security checks ──
  const r1 = await student.evaluate(async () => (await fetch('/api/teacher/questions')).status);
  ok(r1 === 403, 'students cannot reach teacher pages (403)');
  const r2 = await t2.evaluate(async () => (await fetch('/api/admin/overview')).status);
  ok(r2 === 403, 'teachers cannot reach admin pages (403)');
  const r3 = await student.evaluate(async () => (await fetch('/api/student/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"X"}' })).status);
  ok(r3 === 403, 'requests without the site header are blocked (CSRF)');
  const r4 = await t2.evaluate(async (id) => (await fetch('/api/teacher/exams/' + id + '/results')).status, (await dbOne(`SELECT id FROM exams WHERE title = 'EEE 150 Quiz 1'`)).id);
  ok(r4 === 404, "a teacher cannot see another teacher's results");
  const dash = await student.evaluate(async () => (await fetch('/api/student/dashboard')).text());
  ok(!dash.includes('"answer"') && !dash.includes('resistance |'), 'no answer keys sent to students');

  // ── Phone layout ──
  const phone = await newUser({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await phone.goto(BASE + '/');
  await phone.fill('#inEmail', 'juan@student.edu'); await phone.fill('#inPass', 'student-pass-1'); await phone.click('#signIn button[type=submit]');
  await phone.waitForSelector('.item');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'student dashboard fits a phone screen');
  await shot(phone, '12-phone-dashboard');

  ok(errors.length === 0, 'no browser errors ' + errors.join(' | '));
  await browser.close(); server.close(); await db.close();
  console.log('Screenshots: ' + SHOTS);
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
