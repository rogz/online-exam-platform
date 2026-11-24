// End-to-end test of the whole site in a real browser (Playwright + Chromium),
// with a throw-away in-memory database. Run with: npm test
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-1';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SNAPSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshots-')); // camera snapshots go here during the test
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
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
  Object.assign(process.env, { SMTP_HOST: 'test', PUBLIC_URL: BASE }); // emails go to an in-memory outbox
  const { outbox } = require('../src/mailer');
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
  await admin.fill('#inEmail', 'admin@test.local'); await admin.fill('#inPass', 'admin-pass-1'); await admin.press('#inPass', 'Enter');
  await admin.waitForURL(/\/admin/);
  ok(true, 'admin signs in (pressing Enter) and lands on the admin console');
  await admin.waitForSelector('a.brand');
  ok((await admin.getAttribute('a.brand', 'href')) === '/admin', 'logo goes to your own page when signed in');
  const homeRes = await admin.evaluate(async () => { const r = await fetch('/', { redirect: 'manual' }); return r.type === 'opaqueredirect' || r.redirected || r.status === 302; });
  ok(homeRes, 'home page sends signed-in users straight to their page');
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
  const maria = await dbOne(`SELECT credits FROM users WHERE email = 'maria@school.edu'`);
  ok(maria.credits === 5 && await toastSays(teacher, '5 free credits'), 'new teacher also gets 5 free credits');
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
  // folders
  const folderOf = async (code) => (await dbOne(`SELECT f.name FROM questions q LEFT JOIN question_folders f ON f.id = q.folder_id WHERE q.code = $1`, [code])).name;
  await teacher.click('#newFolder'); await teacher.fill('#fName', 'Circuits'); await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('.folder.on:has-text("Circuits")');
  ok((await teacher.textContent('#qRows')).includes('No questions in this folder'), 'new folder opens empty');
  await teacher.click('[data-folder="all"]');
  await teacher.waitForSelector('#qRows [data-sel]');
  for (const code of ['H-1', 'H-2']) await teacher.check(`#qRows tr:has-text("${code}") [data-sel]`);
  ok((await teacher.textContent('#moveCount')).startsWith('2 selected'), 'move bar shows 2 selected');
  const circuitsId = (await dbOne(`SELECT id FROM question_folders WHERE name = 'Circuits'`)).id;
  await teacher.selectOption('#moveTo', circuitsId); await teacher.click('#moveBtn');
  ok(await toastSays(teacher, '2 question(s) moved'), 'questions moved into the folder');
  ok((await folderOf('H-1')) === 'Circuits' && (await folderOf('H-2')) === 'Circuits', 'saved in the folder');
  await teacher.click('.folder:has-text("Circuits")'); await teacher.click('#subFolder');
  await teacher.fill('#fName', 'Units'); await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('.folder.on:has-text("Units")');
  await teacher.click('[data-folder="all"]'); await teacher.waitForSelector('#qRows tr:has-text("Q004") [data-edit]');
  await teacher.click('#qRows tr:has-text("Q004") [data-edit]');
  const unitsId = (await dbOne(`SELECT id FROM question_folders WHERE name = 'Units'`)).id;
  await teacher.selectOption('#qeFolder', unitsId); await teacher.click('.dialog .btn.primary');
  await teacher.waitForSelector('#qRows tr:has-text("Q004")');
  ok((await folderOf('Q004')) === 'Units', 'question editor puts a question in a subfolder');
  await teacher.click('.folder:has-text("Circuits")');
  await teacher.waitForFunction(() => document.querySelectorAll('#qRows [data-sel]').length === 3);
  ok(true, 'a folder lists its subfolders\' questions too (3)');
  ok((await teacher.textContent('.folder:has-text("Not in a folder")')).includes('3'), '"Not in a folder" counts the rest');
  await shot(teacher, '04-question-bank');

  // exam
  await teacher.click('a[href="#exams"]');
  await teacher.click('a[href="#exam/new"]');
  await teacher.waitForSelector('#pRows [data-q]');
  await teacher.fill('#eTitle', 'EEE 150 Quiz 1');
  await teacher.fill('#eLimit', '20');
  await teacher.fill('#ePass', 'ohm');
  await teacher.selectOption('#pFolder', unitsId);
  await teacher.waitForFunction(() => document.querySelectorAll('#pRows [data-q]').length === 1);
  ok(true, 'exam editor filters the bank by folder');
  await teacher.selectOption('#pFolder', 'all');
  await teacher.check('#pAll');
  await teacher.waitForFunction(() => document.querySelector('#pSum').textContent.startsWith('6 selected'));
  await shot(teacher, '05-exam-editor');
  await teacher.click('#pubBtn');
  ok(await toastSays(teacher, 'Published'), 'exam published');

  // ── Teacher previews the exam (nothing is saved) ──
  const quiz1 = await dbOne(`SELECT id FROM exams WHERE title = 'EEE 150 Quiz 1'`);
  ok(await teacher.waitForSelector('#previewBtn', { timeout: 10000 }).then(() => true, () => false), 'exam editor has a Preview button');
  const pv = await teacher.context().newPage(); pv.on('pageerror', (e) => errors.push(e.message));
  await pv.goto(BASE + '/preview?id=' + quiz1.id);
  await pv.waitForSelector('#questions .question');
  ok((await pv.$$('#questions .question')).length === 6, 'preview shows all 6 questions');
  ok(await pv.evaluate(async () => { const i = document.querySelector('.q-image img'); if (!i) return false; await i.decode(); return i.naturalWidth > 0; }), 'preview shows the question picture');
  await pv.click('.question:has-text("unit of electrical resistance") .choice:has-text("Ohm")');
  await pv.click('.question:has-text("measured in amperes") .choice:has-text("False")');
  await pv.fill('.question:has-text("V = I") input.blank', 'r');
  await pv.click('#checkBtn');
  await pv.waitForSelector('.pv-result');
  ok(await pv.isVisible('.question:has-text("unit of electrical resistance") .pv-result.ok'), 'preview: right answer is marked correct');
  ok(await pv.isVisible('.question:has-text("measured in amperes") .pv-result.bad:has-text("Answer key: True")'), 'preview: wrong answer shows the answer key');
  ok(await pv.isVisible('.question:has-text("V = I") .pv-result.ok'), 'preview: fill-in-the-blank accepts "r" for R');
  const pvScore = await pv.textContent('#pvScore');
  ok(pvScore.startsWith('Score: 2 / 10') && pvScore.includes('1 essay'), 'preview score: ' + pvScore);
  await shot(pv, '06-teacher-preview');
  await pv.click('#modeStudent'); await pv.waitForSelector('#newSet:not([hidden])');
  ok((await pv.$$('#questions .question')).length === 6, 'preview "as a student sees it" mode works');
  const editHref = await pv.getAttribute('.question .pv-edit', 'href');
  await pv.goto(BASE + editHref);
  await pv.waitForSelector('.dialog #qeText');
  ok((await pv.inputValue('.dialog #qeText')).length > 0, 'preview "Edit" link opens the question editor');
  await pv.close();
  ok((await dbOne('SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1', [quiz1.id])).n === 0, 'preview saves no attempt');
  const anonPreview = (await fetch(BASE + '/api/teacher/exams/' + quiz1.id + '/preview')).status;
  ok(anonPreview === 401 || anonPreview === 403, 'preview needs the teacher to be signed in');

  // ── Student signs up, joins, takes the exam ──
  const student = await newUser();
  await student.goto(BASE + '/#signup');
  await student.fill('#upName', 'Juan Dela Cruz'); await student.fill('#upEmail', 'juan@student.edu'); await student.fill('#upPass', 'student-pass-1'); await student.fill('#upStudentNo', '2024-0001');
  await student.click('#humanBox .hc-input');
  await student.waitForSelector('#humanBox[data-state="done"]');
  ok((await student.textContent('#humanBox')).includes('Verified'), 'ticking "I\'m not a robot" checks in a moment and turns green');
  await shot(student, '02b-not-a-robot');
  await student.click('#signUp button[type=submit]');
  await student.waitForURL(/\/student/);
  await student.waitForSelector('#joinBig2');
  ok(true, 'new student sees "Join a class"');
  await student.click('#joinBtn'); await student.fill('#joinCode', joinCode.toLowerCase()); await student.click('.dialog .btn.primary');
  await student.waitForSelector('.item:has-text("EEE 150 Quiz 1")');
  ok((await student.textContent('#list')).includes('Open now'), 'exam listed under "Open now"');
  await student.waitForSelector('#startbox a.btn.primary');
  ok((await student.textContent('.tiles')).includes('Password'), 'detail pane shows settings tiles');
  // profile picture
  const face = await student.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d');
    g.fillStyle = '#7fa8d8'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#f2c9a0'; g.beginPath(); g.arc(450, 300, 180, 0, 7); g.fill(); return c.toDataURL('image/jpeg', 0.9); });
  const faceFile = path.join(os.tmpdir(), 'face.jpg'); fs.writeFileSync(faceFile, Buffer.from(face.split(',')[1], 'base64'));
  await student.click('#profileBtn');
  await student.waitForSelector('.dialog #pfFile', { state: 'attached' });
  await student.setInputFiles('#pfFile', faceFile);
  await student.waitForSelector('#pfPic img.avatar-img');
  await student.waitForSelector('#profileBtn img.avatar-img');
  ok(true, 'student adds a profile picture; it shows in the top bar');
  const av = await dbOne(`SELECT octet_length(data) AS n, mime FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.email = 'juan@student.edu'`);
  ok(av && av.mime === 'image/jpeg' && av.n < 60000, 'picture cropped and shrunk (' + (av && Math.round(av.n / 1024)) + ' KB)');
  await student.fill('#pfNo', '2024-0001A');
  await shot(student, '06b-profile');
  await student.click('.dialog .btn.primary');
  ok(await toastSays(student, 'Profile saved'), 'student edits their profile');
  const avUrl = await student.getAttribute('#profileBtn img', 'src');
  const avStatus = await teacher.evaluate(async (u) => { const r = await fetch(u); return r.status + ' ' + r.headers.get('content-type'); }, avUrl);
  ok(avStatus === '200 image/jpeg', 'teacher can load the student picture');
  ok((await fetch(BASE + avUrl)).status === 401, 'pictures need sign-in');
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
  await student.waitForSelector('#startbox .scorebox');
  await shot(student, '08-student-completed');

  // ── Teacher grades the essay and allows a retake ──
  await teacher.goto(BASE + '/teacher#exams');
  await teacher.click('a[href^="#results/"]');
  await teacher.waitForSelector('[data-answers]');
  ok((await teacher.textContent('.statgrid')).includes('Essays to grade'), 'results page shows stats');
  ok(await teacher.isVisible('tr:has-text("Juan Dela Cruz") img.avatar-img'), 'results show the student picture');
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
  // (no free credits for this teacher, to test buying/requesting them)
  ok((await admin.evaluate(async () => (await (await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ signupCredits: 0 }) })).json()).settings.signupCredits)) === 0, 'admin sets free credits for new teachers to 0');
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
  await t2.waitForSelector('#askSend');
  ok(await t2.isVisible('#askPanel') && await t2.isHidden('#buyPanel'), 'payments hidden: teacher sees "Request an access code"');
  await t2.check('input[name=askKind][value=credits]'); await t2.fill('#askAmount', '10'); await t2.fill('#askMsg', 'Physics, 2 classes');
  await t2.click('#askSend');
  ok(await toastSays(t2, 'Request sent'), 'access request sent');
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

  // ── Payment methods: bank transfer with a receipt picture ──
  await admin.goto(BASE + '/admin#settings');
  await admin.waitForSelector('#sBankOn');
  await admin.check('#sPayOn'); await admin.check('#sBankOn'); await admin.fill('#sBank', 'Bank: BDO\nAccount name: ABNJ Works\nAccount number: 0012 3456 7890');
  await admin.check('#sPpOn'); await admin.fill('#sPpLink', 'https://paypal.me/abnjworks');
  await admin.click('#sSave');
  ok(await toastSays(admin, 'Settings saved'), 'admin turns on payments: bank transfer and PayPal');
  await shot(admin, '13-admin-payment-settings');
  await t2.goto(BASE + '/teacher#account'); await t2.waitForSelector('.methods');
  await t2.click('.pack:has-text("30 credits")'); await t2.click('.method:has-text("Bank transfer")');
  ok(await t2.isVisible('.paydetails:has-text("0012 3456 7890")') && await t2.isVisible('.due:has-text("₱250.00")'), 'teacher sees the bank details and the amount');
  await t2.click('.method:has-text("PayPal")');
  ok((await t2.getAttribute('.paydetails a', 'href')) === 'https://paypal.me/abnjworks/250PHP', 'PayPal.me link includes the amount');
  await t2.click('.method:has-text("Bank transfer")');
  await t2.click('#request');
  ok(await toastSays(t2, 'reference number'), 'a payment needs a reference number or a receipt');
  const receipt = await t2.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 100); g.fillText('RECEIPT', 60, 50); return c.toDataURL('image/png'); });
  await t2.setInputFiles('#rqProof', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(receipt.split(',')[1], 'base64') });
  await t2.waitForSelector('#rqProofNote:has-text("attached")');
  await t2.click('#request');
  ok(await toastSays(t2, 'Request sent'), 'bank transfer sent with only a receipt picture');
  await shot(t2, '12-teacher-buy-credits');
  await admin.goto(BASE + '/admin#requests');
  await admin.waitForSelector('a:has-text("View receipt picture")');
  const proofHref = await admin.getAttribute('a:has-text("View receipt picture")', 'href');
  const proofType = await admin.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), proofHref);
  ok(proofType === 'image/png' && await admin.isVisible('td:has-text("₱250.00")') && await admin.isVisible('td:has-text("Bank transfer")'), 'admin sees method, amount and the receipt');
  const proofOther = await t2.evaluate(async (u) => (await fetch(u)).status, proofHref);
  ok(proofOther === 403, 'teachers cannot open the admin receipt link');

  // ── QR code instead of account details ──
  await admin.goto(BASE + '/admin#settings'); await admin.waitForSelector('[data-qr=bank]');
  const qrPng = await admin.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 120); g.fillStyle = '#000'; for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if ((i * 7 + j * 3) % 5 < 2) g.fillRect(i * 10, j * 10, 10, 10); return c.toDataURL('image/png'); });
  await admin.setInputFiles('[data-qr=bank]', { name: 'qr.png', mimeType: 'image/png', buffer: Buffer.from(qrPng.split(',')[1], 'base64') });
  ok(await toastSays(admin, 'QR code saved'), 'admin uploads a bank QR code');
  await admin.waitForSelector('img.qrthumb');
  await admin.fill('#sBank', ''); await admin.click('#sSave'); await toastSays(admin, 'Settings saved');
  await t2.goto(BASE + '/teacher#classes'); await t2.goto(BASE + '/teacher#account'); await t2.reload(); await t2.waitForSelector('.methods');
  await t2.click('.method:has-text("Bank transfer")');
  await t2.waitForSelector('.qrbox img');
  const qrShown = await t2.evaluate(async () => { const i = document.querySelector('.qrbox img'); await i.decode(); return i.naturalWidth; });
  ok(qrShown === 120 && !(await t2.isVisible('.paydetails')), 'teacher sees only the QR code, no account number');
  await shot(t2, '14-teacher-pay-qr');
  const qrStudent = await student.evaluate(async () => (await fetch('/api/teacher/payment-qr/bank')).status);
  ok(qrStudent === 403, 'students cannot see the payment QR code');

  // ── PayPal checkout (against a pretend PayPal server) ──
  const http = require('http');
  const orders = {};
  const pp = http.createServer((rq, rs) => {
    let body = ''; rq.on('data', (c) => { body += c; }); rq.on('end', () => {
      const send = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
      if (rq.url === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3600 });
      if (rq.headers.authorization !== 'Bearer tok') return send(401, {});
      if (rq.url === '/v2/checkout/orders' && rq.method === 'POST') {
        const id = 'ORDER' + (Object.keys(orders).length + 1); const u = JSON.parse(body).purchase_units[0];
        orders[id] = { custom_id: u.custom_id, amount: u.amount, captured: false };
        return send(201, { id, status: 'CREATED' });
      }
      const m = rq.url.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/); const o = m && orders[m[1]];
      if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      const out = () => ({ id: m[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-' + m[1], status: 'COMPLETED', custom_id: o.custom_id, amount: o.paidAmount || o.amount }] } }] });
      if (m[2]) { if (o.captured) return send(422, { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }); o.captured = true; return send(201, out()); }
      return send(200, out());
    });
  }).listen(0);
  Object.assign(process.env, { PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret', PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'http://localhost:' + pp.address().port });
  await t2.goto(BASE + '/teacher#classes'); await t2.goto(BASE + '/teacher#account'); await t2.reload(); await t2.waitForSelector('.methods');
  await t2.click('.method:has-text("PayPal")');
  ok(await t2.isVisible('#ppButtons') && await t2.isVisible('text=Test mode'), 'PayPal checkout buttons area is shown (test mode)');
  const tapi = (u, b) => t2.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json(), [u, b]);
  const ppBefore = (await dbOne(`SELECT credits FROM users WHERE email = 'pedro@school.edu'`)).credits;
  const bad = await tapi('/api/teacher/paypal/order', { credits: 7 });
  ok(!bad.ok, 'PayPal order for a non-package amount is refused');
  const ord = await tapi('/api/teacher/paypal/order', { credits: 30 });
  ok(ord.ok && orders[ord.id] && orders[ord.id].amount.value === '250.00' && orders[ord.id].amount.currency_code === 'PHP', 'PayPal order created for ₱250.00');
  const cap = await tapi('/api/teacher/paypal/capture', { orderId: ord.id });
  const ppAfter = (await dbOne(`SELECT credits FROM users WHERE email = 'pedro@school.edu'`)).credits;
  ok(cap.ok && cap.credits === 30 && ppAfter === ppBefore + 30, 'PayPal payment adds 30 credits at once');
  const cap2 = await tapi('/api/teacher/paypal/capture', { orderId: ord.id });
  ok(cap2.ok && (await dbOne(`SELECT credits FROM users WHERE email = 'pedro@school.edu'`)).credits === ppAfter, 'capturing the same order twice adds nothing more');
  const other = await teacher.evaluate(async (id) => (await (await fetch('/api/teacher/paypal/capture', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ orderId: id }) })).json()).ok, ord.id);
  ok(other === false, "another teacher cannot claim someone else's PayPal payment");
  const ord2 = await tapi('/api/teacher/paypal/order', { credits: 10 });
  orders[ord2.id].paidAmount = { currency_code: 'PHP', value: '1.00' };
  const cap3 = await tapi('/api/teacher/paypal/capture', { orderId: ord2.id });
  const held = await dbOne(`SELECT status FROM credit_requests WHERE paypal_order_id = $1`, [ord2.id]);
  ok(!cap3.ok && held && held.status === 'pending', 'a PayPal amount that does not match is held for the admin');
  pp.close();
  ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENV', 'PAYPAL_API_BASE'].forEach((k) => delete process.env[k]);

  // ── Random sets: students don't see the bank size ──
  const randExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type !== 'ESSAY').map((q) => q.id);
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Random quiz', questionIds: ids, pickCount: 3, timeLimitMinutes: 10,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return { id: x.id, pool: ids.length };
  });
  await student.goto(BASE + '/exam?id=' + randExam.id);
  await student.waitForSelector('#screen-rules:not([hidden])');
  const factQ = (await student.textContent('#factQuestions')).trim();
  const examInfo = await student.evaluate(async (id) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ action: 'getExam', examId: id }) })).json(), randExam.id);
  ok(factQ === '3' && examInfo.exam.poolSize === undefined && !JSON.stringify(examInfo).replace(/randomSnapshots/g, '').includes('random'), 'random set: student sees "' + factQ + '" questions, not the bank size (' + randExam.pool + ')');

  // ── Pick per question type (1 multiple choice + 1 true/false per student) ──
  const typeExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'MC' || q.type === 'TF').map((q) => q.id);
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Type quiz', questionIds: ids, timeLimitMinutes: 10, options: { typePicks: [{ type: 'MC', count: 1 }, { type: 'TF', count: 1 }] },
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  await teacher.goto(BASE + '/teacher#exam/' + typeExam); await teacher.waitForSelector('#typePicks [data-ptype="MC"]');
  ok((await teacher.inputValue('#typePicks [data-ptype="MC"]')) === '1' && (await teacher.textContent('#pSum')).includes('1 multiple choice, 1 true/false'), 'exam editor shows the per-type picks');
  const typeInfo = await student.evaluate(async (id) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const g = await post({ action: 'getExam', examId: id });
    const st = await post({ action: 'start', examId: id, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return { count: g.exam.questionCount, types: st.questions.map((q) => q.type).sort().join(',') };
  }, typeExam);
  ok(typeInfo.count === 2 && typeInfo.types === 'MC,TF', 'student gets 1 multiple choice + 1 true/false (' + typeInfo.types + ')');

  // ── Points override: every question worth 2 in this exam (the bank is not changed) ──
  const ptsExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const qs = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'MC' || q.type === 'TF');
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Points quiz', questionIds: qs.map((q) => q.id), timeLimitMinutes: 10,
      options: { typePicks: [{ type: 'MC', count: 1 }, { type: 'TF', count: 1 }], pointsRule: { mode: 'TYPE', byType: { MC: 2, TF: 3 } } },
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  await teacher.goto(BASE + '/teacher#exam/' + ptsExam); await teacher.waitForSelector('#ptsBox [data-ptspt="TF"]');
  ok((await teacher.inputValue('#ePtsMode')) === 'TYPE' && (await teacher.inputValue('#ptsBox [data-ptspt="TF"]')) === '3', 'exam editor shows points per question type');
  await teacher.selectOption('#ePtsMode', 'ALL'); await teacher.fill('#ePtsAll', '2');
  ok(/— \d+ points/.test(await teacher.textContent('#pSum')), 'exam editor totals use the exam points');
  await teacher.selectOption('#ePtsMode', 'TYPE');
  const ptsInfo = await student.evaluate(async (id) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId: id, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    const sub = await post({ action: 'submit', attemptId: st.attemptId, answers: {} });
    return { points: st.questions.map((q) => q.type + q.points).sort().join(','), max: sub.maxScore, err: sub.error || st.error };
  }, ptsExam);
  ok(ptsInfo.points === 'MC2,TF3' && ptsInfo.max === 5, 'points per type: every student out of 5 (' + JSON.stringify(ptsInfo) + ')');

  // ── Symbol buttons in the question editor ──
  await teacher.goto(BASE + '/teacher#questions'); await teacher.waitForSelector('#addQ');
  await teacher.click('#addQ'); await teacher.waitForSelector('.dialog #qeType');
  await teacher.selectOption('#qeType', 'FIB'); await teacher.waitForSelector('#qeFib');
  await teacher.fill('#qeFib', '122.5  1% V'); await teacher.focus('#qeFib');
  await teacher.evaluate(() => { const i = document.querySelector('#qeFib'); i.setSelectionRange(6, 6); });
  await teacher.click('#qeSyms [data-sym="±"]');
  await teacher.click('#qeText'); await teacher.click('#qeSyms [data-sym="Ω"]');
  ok((await teacher.inputValue('#qeFib')) === '122.5 ± 1% V' && (await teacher.inputValue('#qeText')) === 'Ω', 'symbol buttons insert ± and Ω where the cursor is');
  await teacher.keyboard.press('Escape');

  // ── Fill in the blank: number ranges, units, close numbers and close spellings ──
  const fibExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const mk = async (code, text, answer) => (await post('/api/teacher/questions', { type: 'FIB', code, text, answer, points: 1 })).question.id;
    const ids = [await mk('FIB-R1', 'Receiving-end voltage is ____ V.', '122.1-122.9 V'), await mk('FIB-R2', 'Sending-end voltage is ____ V.', '122.5 ± 1% V'),
      await mk('FIB-R3', 'Line current is ____ A.', '50.0 ± 0.2'), await mk('FIB-S1', 'The voltage rise at a light load is the ____ effect.', 'Ferranti')];
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Range quiz', questionIds: ids, timeLimitMinutes: 10, shuffleQuestions: false,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return { id: x.id, ids };
  });
  const fibRes = await student.evaluate(async ({ id, ids }) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId: id, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    const answers = { [ids[0]]: '122.48 V', [ids[1]]: '123.6 kV', [ids[2]]: '50.3', [ids[3]]: 'Feranti' };
    return post({ action: 'submit', attemptId: st.attemptId, answers });
  }, fibExam);
  ok(fibRes.score === 2 && fibRes.maxScore === 4, 'number ranges: 122.48 V and 123.6 kV count, 50.3 and "Feranti" do not (' + fibRes.score + ' / ' + fibRes.maxScore + ')');
  await teacher.goto(BASE + '/teacher#results/' + fibExam.id); await teacher.waitForSelector('[data-answers]');
  ok((await teacher.textContent('#aRows')).includes('3 to check'), 'results flag 3 answers to check');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-give]');
  const notes = await teacher.textContent('.dialog');
  ok(notes.includes('Different unit') && notes.includes('Close number') && notes.includes('Close spelling'), 'answers show the unit, close number and spelling notes');
  await teacher.click('.dialog .resp:has-text("Ferranti") [data-give]');
  await teacher.click('.dialog .btn.primary');
  ok(await toastSays(teacher, '3 / 4'), 'one click gives the points for the close spelling: 3 / 4');
  await teacher.waitForSelector('[data-answers]');
  ok(!(await teacher.textContent('#aRows')).includes('to check'), 'saving clears "to check"');

  // ── Fill in the blank with several blanks: one box per blank, partial points ──
  await teacher.goto(BASE + '/teacher#questions'); await teacher.waitForSelector('#addQ');
  await teacher.click('#addQ'); await teacher.waitForSelector('.dialog #qeType');
  await teacher.selectOption('#qeType', 'FIB');
  await teacher.fill('#qeText', 'The load draws $V_S$ = ____ V and $I_S$ = ____ A.');
  await teacher.waitForSelector('[data-fibn="1"]');
  await teacher.waitForSelector('#qePreview:not([hidden]) .katex');
  ok((await teacher.locator('#qePreview .blank-line').count()) === 2 && (await teacher.locator('#qePreview .katex').count()) === 2,
    'the editor shows how students will see it: the math drawn and one answer line per blank');
  await teacher.fill('[data-fibn="0"]', '120 ± 1% V'); await teacher.fill('[data-fibn="1"]', '5 ± 1% A | five');
  await teacher.fill('#qePoints', '2'); await teacher.fill('#qeCode', 'FIB-2B');
  await teacher.click('.dialog .ft .btn.primary'); await toastSays(teacher, 'Question saved');
  const twoB = await dbOne(`SELECT id, answer FROM questions WHERE code = 'FIB-2B'`);
  ok(twoB && twoB.answer === '120 ± 1% V ; 5 ± 1% A | five', 'the editor shows one answer box per blank and saves them in order (' + (twoB && twoB.answer) + ')');
  const twoExam = await teacher.evaluate(async (qid) => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Two blanks quiz', questionIds: [qid], timeLimitMinutes: 10,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  }, twoB.id);
  await student.goto(BASE + '/exam?id=' + twoExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  const lines = await student.$$eval('#questions .blank-line', (ls) => ls.map((l) => [l.querySelector('.bl-tag').textContent, l.querySelector('.bl-label').textContent.replace(/\s+/g, ''), (l.querySelector('.bl-unit') || {}).textContent]));
  ok(lines.length === 2 && lines[0][0] === 'a)' && lines[1][0] === 'b)' && lines[0][2] === 'V' && lines[1][2] === 'A' && (await student.locator('#questions .blank-line .katex').count()) === 2,
    'students see one answer line per blank: a) V_S = [box] V, b) I_S = [box] A, with the math drawn (' + JSON.stringify(lines) + ')');
  ok((await student.textContent('#questions .q-text')).includes('The load draws'), 'the explanation stays on top');
  await student.locator('#questions .blank-lines input.blank').nth(0).fill('120.4 V');
  ok((await student.textContent('#progress')).startsWith('0 /'), 'with one blank still empty, the question does not count as answered yet');
  await student.locator('#questions .blank-lines input.blank').nth(1).fill('7');
  await shot(student, '24-two-blanks');
  // light / dark switch: Auto → Light → Dark, remembered on this device
  const themeOf = () => student.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themePref]);
  await student.click('.topbar .theme-btn');
  ok((await themeOf()).join() === 'light,light', 'the colours switch to Light');
  await student.click('.topbar .theme-btn');
  ok((await themeOf()).join() === 'dark,dark', 'then to Dark');
  ok((await student.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(18, 21, 27)', 'the page turns dark');
  await shot(student, '24b-two-blanks-dark');
  await student.click('.topbar .theme-btn');
  ok((await themeOf())[1] === 'auto', 'and back to Auto (follows the device)');
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#screen-result:not([hidden])');
  const twoRes = await dbOne(`SELECT r.points_earned, r.max_points, r.student_answer FROM responses r JOIN attempts a ON a.id = r.attempt_id WHERE a.exam_id = $1`, [twoExam]);
  ok(twoRes.points_earned === 1 && twoRes.max_points === 2 && twoRes.student_answer.includes('(1) 120.4 V ✓') && twoRes.student_answer.includes('(2) 7 ✗'),
    'each blank is graded on its own: 1 of 2 right gives 1 / 2 points (' + twoRes.student_answer + ')');
  const badQ = await teacher.evaluate(async () => (await (await fetch('/api/teacher/questions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ type: 'FIB', text: 'a ____ b ____', answer: 'only one', code: 'FIB-BAD' }) })).json()));
  ok(badQ && !badQ.ok && String(badQ.error).includes('2 blanks: give the accepted answers for each blank'), 'a question with 2 blanks but answers for only 1 cannot be saved, with a clear message');

  // ── Pick per topic, combining the parts of a topic (Long Lines P1, P2 … → Long Lines) ──
  const partsExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const rows = ['QuestionID,Type,Question,Choices,Answer,Points,Topic,Folder'];
    [['LL1a', 'Long Lines P1'], ['LL1b', 'Long Lines P1'], ['LL2a', 'Long Lines P2'], ['LL2b', 'Long Lines (Part 3)'], ['ML1a', 'Medium Lines P1'], ['ML2a', 'P2 - Medium Lines']]
      .forEach(([id, topic]) => rows.push(`PT-${id},TF,Statement ${id},,TRUE,1,${topic},Parts`));
    await post('/api/teacher/questions/import', { csv: rows.join('\n') });
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.code.startsWith('PT-')).map((q) => q.id);
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Topic parts quiz', questionIds: ids, timeLimitMinutes: 10,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    return x.id;
  });
  await teacher.goto(BASE + '/teacher#exam/' + partsExam); await teacher.waitForSelector('#combineParts');
  const ptRows = await teacher.$$eval('#topicPicks tbody tr td:first-child', (td) => td.map((x) => x.textContent.trim()));
  ok(await teacher.isChecked('#combineParts') && ptRows.length === 2 && ptRows[0].startsWith('Long Lines') && ptRows[0].includes('3 parts') && ptRows[1].startsWith('Medium Lines'),
    'pick per topic combines the parts of a topic: ' + ptRows.join(' | '));
  await teacher.fill('#topicPicks [data-topic="Long Lines"]', '3'); await teacher.fill('#topicPicks [data-topic="Medium Lines"]', '1');
  await teacher.click('#saveBtn'); await toastSays(teacher, 'Saved');
  const ptSaved = await dbOne('SELECT topic_counts FROM exams WHERE id = $1', [partsExam]);
  ok(ptSaved.topic_counts.length === 2 && ptSaved.topic_counts.every((t) => t.group === true), 'saved as combined topics');
  await teacher.evaluate(async (id) => { await fetch('/api/teacher/exams/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ publish: true }) }); }, partsExam);
  const ptSet = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return st.questions.map((q) => q.text);
  }, partsExam);
  ok(ptSet.length === 4 && ptSet.filter((x) => /LL/.test(x)).length === 3 && ptSet.filter((x) => /ML/.test(x)).length === 1, 'each student gets 3 from all the Long Lines parts and 1 from Medium Lines');
  await teacher.goto(BASE + '/teacher#exams'); await teacher.goto(BASE + '/teacher#exam/' + partsExam); await teacher.waitForSelector('#combineParts');
  await teacher.uncheck('#combineParts');
  ok((await teacher.$$eval('#topicPicks tbody tr', (r) => r.length)) === 5, 'unticking shows each part as its own topic again');

  // ── Per topic (with a type) and per type together: 3 fill-in-the-blank from Long Lines, then 4 multiple choice from the rest ──
  const mixExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const rows = ['QuestionID,Type,Question,Choices,Answer,Points,Topic,Folder'];
    for (let i = 1; i <= 4; i++) rows.push(`MX-F${i},FIB,Long line value ${i} is ____,,${i},1,Long Lines P${i % 2 + 1},Mix`);
    for (let i = 1; i <= 2; i++) rows.push(`MX-L${i},MC,Long line choice ${i},A | B | C | D,A,1,Long Lines P${i},Mix`);
    for (let i = 1; i <= 6; i++) rows.push(`MX-M${i},MC,Other choice ${i},A | B | C | D,B,1,Misc,Mix`);
    await post('/api/teacher/questions/import', { csv: rows.join('\n') });
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.code.startsWith('MX-')).map((q) => q.id);
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    return (await post('/api/teacher/exams', { classId: cls.id, title: 'Topic and type quiz', questionIds: ids, timeLimitMinutes: 10,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam.id;
  });
  await teacher.goto(BASE + '/teacher#exams'); await teacher.goto(BASE + '/teacher#exam/' + mixExam); await teacher.waitForSelector('[data-ttype="Long Lines"]');
  await teacher.selectOption('[data-ttype="Long Lines"]', 'FIB');
  await teacher.fill('#topicPicks [data-topic="Long Lines"]', '3');
  await teacher.fill('#typePicks [data-ptype="MC"]', '4');
  const mixSum = await teacher.textContent('#pSum');
  ok(mixSum.includes('each student gets 7') && mixSum.includes('3 Long Lines (fill in the blank), then 4 multiple choice from the rest'), 'per topic and per type work together: ' + mixSum.split('—').pop().trim());
  await teacher.click('#saveBtn'); await toastSays(teacher, 'Saved');
  const mixRow = await dbOne('SELECT topic_counts, options FROM exams WHERE id = $1', [mixExam]);
  ok(mixRow.topic_counts[0].type === 'FIB' && mixRow.options.typePicks[0].type === 'MC' && mixRow.options.typePicks[0].count === 4, 'both are saved');
  await teacher.evaluate(async (id) => { await fetch('/api/teacher/exams/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ publish: true }) }); }, mixExam);
  const mixSet = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const g = await post({ action: 'getExam', examId });
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return { told: g.exam.questionCount, types: g.exam.typeCounts, qs: st.questions.map((q) => q.type + ':' + q.text) };
  }, mixExam);
  const fibs = mixSet.qs.filter((q) => q.startsWith('FIB:Long line value')).length, mcs = mixSet.qs.filter((q) => q.startsWith('MC:')).length;
  ok(mixSet.qs.length === 7 && fibs === 3 && mcs === 4 && mixSet.told === 7 && mixSet.types.FIB === 3 && mixSet.types.MC === 4,
    'each student gets 3 fill-in-the-blank from Long Lines and 4 multiple choice; the rules screen says 7 (3 FIB, 4 MC)');

  // ── Tab/window warnings: 2 allowed, the 3rd time away voids; staying away over 1 minute voids ──
  const mkExam = async (title, options) => teacher.evaluate(async ([title, options]) => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const q = (await (await fetch('/api/teacher/questions')).json()).questions.find((x) => x.type === 'TF');
    const x = (await post('/api/teacher/exams', { classId: cls.id, title, questionIds: [q.id], timeLimitMinutes: 10, options,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  }, [title, options]);
  const focusExam = await mkExam('Focus quiz', { focusWarnings: 2 });
  await student.goto(BASE + '/exam?id=' + focusExam);
  await student.waitForSelector('#screen-rules:not([hidden])');
  ok((await student.textContent('#ruleFocus')).includes('2 warnings'), 'rules screen tells students they get 2 tab warnings');
  await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  const leave = async () => { await student.evaluate(() => window.dispatchEvent(new Event('blur'))); await student.waitForTimeout(900); };
  await leave();
  await student.waitForSelector('#focusWarnModal:not([hidden])');
  const w1 = await student.textContent('#focusWarnTitle');
  await student.click('#focusWarnOk'); await student.waitForTimeout(1200);
  await leave();
  await student.waitForSelector('#focusWarnModal:not([hidden])');
  const w2 = (await student.textContent('#focusWarnTitle')) + ' / ' + (await student.textContent('#focusWarnNext'));
  await student.click('#focusWarnOk'); await student.waitForTimeout(1200);
  const mid = (await dbOne('SELECT status, focus_warnings FROM attempts WHERE exam_id = $1', [focusExam]));
  await leave();
  await student.waitForSelector('#voidModal:not([hidden])');
  const fin = await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [focusExam]);
  ok(w1.includes('warning 1 of 2') && w2.includes('warning 2 of 2') && w2.includes('last warning') && mid.status === 'IN_PROGRESS' && mid.focus_warnings === 2 && fin.status === 'VOIDED',
    'tab warnings: 1 of 2, 2 of 2 (last), then the 3rd time away voids');
  await shot(student, '17-focus-warning-void');
  const awayExam = await mkExam('Away quiz', { focusWarnings: 3 });
  await student.goto(BASE + '/exam?id=' + awayExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await student.waitForSelector('#focusWarnModal:not([hidden])');
  await student.evaluate(() => { const real = Date.now; Date.now = () => real() + 61000; });
  await student.waitForSelector('#voidModal:not([hidden])', { timeout: 5000 }).catch(() => {});
  const away = await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [awayExam]);
  ok(away.status === 'VOIDED', 'staying away from the exam for more than 1 minute voids it, even with warnings left');

  // ── Unstable internet: the exam keeps going offline, answers are sent when the internet is back ──
  const netExam = await mkExam('Unstable internet quiz', {});
  await student.goto(BASE + '/exam?id=' + netExam);
  await student.waitForSelector('#screen-rules:not([hidden])');
  ok((await student.textContent('#ruleReload')).includes('If the internet drops, keep this page open'), 'rules screen explains what to do when the internet drops');
  await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.click('#questions .question label:has-text("True")');
  await student.context().setOffline(true);
  await student.waitForSelector('#connBanner.offline:not([hidden])', { timeout: 10000 });
  await shot(student, '18-offline-banner');
  const offBanner = await student.textContent('#connBanner'), offSave = await student.textContent('#saveState');
  // pretend the internet was gone for 5 minutes (longer than the 60 s reconnect window)
  await db.query(`UPDATE attempts SET last_seen = now() - interval '5 minutes' WHERE exam_id = $1`, [netExam]);
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#screen-pending:not([hidden])', { timeout: 20000 });
  await shot(student, '19-offline-finished');
  const [dl] = await Promise.all([student.waitForEvent('download'), student.click('#pendingFile')]);
  const fileJson = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(fileJson.kind === 'exam-wizard-answers' && Object.keys(fileJson.answers).length === 1 && /^answers-.+\.json$/.test(dl.suggestedFilename()),
    'offline, the student can save a copy of the answers as a file (' + dl.suggestedFilename() + ')');
  ok(offBanner.includes('No internet') && offSave.includes('Saved on this device'), 'offline: "No internet… keep answering" banner and "Saved on this device"');
  const stillOpen = await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [netExam]);
  ok(stillOpen.status === 'IN_PROGRESS', 'finishing offline shows "Your exam is finished… keep this page open" and nothing is voided');
  // the answers waited 2 minutes on the device
  await student.evaluate((id) => { const k = 'exam-pending:' + id; const p = JSON.parse(localStorage.getItem(k)); p.finishedAt -= 120000; localStorage.setItem(k, JSON.stringify(p)); }, netExam);
  // let a try that is already on its way fail first, so the next one carries the changed answers
  const pendBefore = await student.textContent('#pendingStatus');
  await student.waitForFunction((b) => { const t = document.querySelector('#pendingStatus').textContent; return t !== b && t.includes('Still no internet'); }, pendBefore, { timeout: 20000 });
  await student.context().setOffline(false); // the page notices and sends by itself
  await student.waitForSelector('#screen-result:not([hidden])', { timeout: 15000 });
  const netRow = await dbOne('SELECT status, score, sent_late, late, offline_ms FROM attempts WHERE exam_id = $1', [netExam]);
  const netEv = (await db.many(`SELECT event FROM violations v JOIN attempts a ON a.id = v.attempt_id WHERE a.exam_id = $1`, [netExam])).map((r) => r.event).join();
  ok(netRow.status === 'SUBMITTED' && netRow.sent_late === true && netRow.late === false && Number(netRow.offline_ms) > 200000 && netEv.includes('OFFLINE') && netEv.includes('SENT_LATE'),
    'back online: answers sent, not voided, logged as offline and "sent after the internet came back" (' + netEv + ' ' + JSON.stringify(netRow) + ')');
  await teacher.goto(BASE + '/teacher#results/' + netExam); await teacher.waitForSelector('[data-answers]');
  const netNotes = await teacher.textContent('#aRows');
  ok(netNotes.includes('Offline 5 min') && netNotes.includes('Sent after the internet came back'), 'results show "Offline 5 min" and "Sent after the internet came back"');
  // the same exam with "void after the reconnect window" keeps the old rule
  const strictExam = await mkExam('Strict internet quiz', { keepGoingOffline: false });
  await student.goto(BASE + '/exam?id=' + strictExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await db.query(`UPDATE attempts SET last_seen = now() - interval '5 minutes' WHERE exam_id = $1`, [strictExam]);
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#voidModal:not([hidden])', { timeout: 15000 });
  ok((await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [strictExam])).status === 'VOIDED', '"void after the reconnect window" still voids a long gap');
  // answers are kept on the server while the exam runs (draft)
  const draftExam = await mkExam('Draft quiz', {});
  await student.goto(BASE + '/exam?id=' + draftExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.click('#questions .question label:has-text("False")');
  await student.evaluate(() => window.dispatchEvent(new Event('online')));
  await student.waitForSelector('#saveState.ok', { timeout: 10000 });
  const draft = await dbOne('SELECT draft_answers FROM attempts WHERE exam_id = $1', [draftExam]);
  ok(draft.draft_answers && Object.values(draft.draft_answers).length === 1, 'answers so far are saved on the server too ("✓ Saved")');
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#screen-result:not([hidden])');

  // A phone in "desktop site" mode is still a phone (touch-only, small screen)
  const deskPhoneCtx = await browser.newContext({ viewport: { width: 980, height: 1800 }, screen: { width: 412, height: 915 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  await deskPhoneCtx.addCookies((await student.context().cookies()).filter((c) => c.name === 'sid'));
  const deskPhone = await deskPhoneCtx.newPage();
  await deskPhone.goto(BASE + '/exam?id=' + randExam.id);
  await deskPhone.waitForSelector('#screen-rules:not([hidden])');
  const devText = await deskPhone.textContent('#checkDevice');
  const deskStart = await deskPhone.evaluate(async (id) => (await (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ action: 'start', examId: id, env: { userAgent: navigator.userAgent, device: 'phone', monitorCheck: 'supported' } }) })).json()).code, randExam.id);
  ok(/Phone/.test(devText) && deskStart === 'DEVICE_NOT_ALLOWED', 'a phone in "desktop site" mode is detected as a phone and refused (' + devText.trim().slice(0, 40) + ')');
  await deskPhoneCtx.close();

  await teacher.goto(BASE + '/teacher#results/' + randExam.id);
  await teacher.waitForSelector('table.notstarted');
  ok(await teacher.isVisible('table.notstarted tr:has-text("Juan Dela Cruz"):has-text("2024-0001")'), '"Not started" is a list with name and student number');
  await shot(teacher, '16-not-started');

  // ── Camera snapshot as proof ──
  const camExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const q = (await (await fetch('/api/teacher/questions')).json()).questions.find((x) => x.type === 'TF');
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Camera quiz', questionIds: [q.id], faceMode: 'ALWAYS', options: { cameraWarnings: 2 }, timeLimitMinutes: 10,
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  const snap = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', camera: 'ok', userAgent: navigator.userAgent } });
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); g.fillStyle = '#556'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.fillText('Phone detected', 10, 230);
    const dataUrl = c.toDataURL('image/jpeg', 0.4);
    const r = await post({ action: 'snapshot', attemptId: st.attemptId, event: 'PHONE_DETECTED', dataUrl });
    return { saved: r.saved, attemptId: st.attemptId, kb: Math.round(dataUrl.length * 3 / 4 / 1024) };
  }, camExam);
  ok(snap.saved === true && snap.kb <= 15, 'student\'s browser saves a small camera snapshot (' + snap.kb + ' KB)');
  const seen = await teacher.evaluate(async ([examId, aid]) => {
    const r = await (await fetch('/api/teacher/exams/' + examId + '/attempts/' + aid)).json();
    const sn = r.snapshots[0];
    const img = sn && await fetch('/api/teacher/exams/' + examId + '/attempts/' + aid + '/snapshots/' + sn.id);
    return { n: r.snapshots.length, event: sn && sn.event, type: img && img.headers.get('content-type') };
  }, [camExam, snap.attemptId]);
  ok(seen.n === 1 && seen.event === 'PHONE_DETECTED' && seen.type === 'image/jpeg', 'teacher sees the snapshot in the attempt details');
  await teacher.goto(BASE + '/teacher#results/' + camExam); await teacher.waitForSelector('[data-answers]');
  await teacher.click('[data-answers]');
  await teacher.waitForSelector('.snap img');
  ok(await teacher.evaluate(async () => { const i = document.querySelector('.snap img'); await i.decode(); return i.naturalWidth === 320; }), 'snapshot shows under "Camera snapshots"');
  await shot(teacher, '15-teacher-snapshot');
  await teacher.keyboard.press('Escape');
  ok(fs.readdirSync(process.env.SNAPSHOT_DIR).length === 1, 'the snapshot is a file on the server disk, not in the database');

  // ── Random snapshots (6 per hour): told on the rules screen, limited per hour, deleted on archive and after 30 days ──
  const randExamId = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const q = (await (await fetch('/api/teacher/questions')).json()).questions.find((x) => x.type === 'TF');
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Random snapshot quiz', questionIds: [q.id], faceMode: 'ALWAYS', options: { randomSnapshots: true, snapshotsPerHour: 6 },
      timeLimitMinutes: 10, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  await teacher.goto(BASE + '/teacher#exam/' + randExamId); await teacher.waitForSelector('#oRandSnap');
  ok((await teacher.isChecked('#oRandSnap')) && (await teacher.inputValue('#oSnapHour')) === '6', 'exam editor shows random snapshots: 6 per hour');
  await student.goto(BASE + '/exam?id=' + randExamId); await student.waitForSelector('#screen-rules:not([hidden])');
  ok((await student.textContent('#ruleCamera')).includes('6 small pictures per hour at random times'), 'students are told about random snapshots on the rules screen');
  const rnd = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', camera: 'ok', userAgent: navigator.userAgent } });
    const c = document.createElement('canvas'); c.width = 240; c.height = 180; const g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 240, 180);
    const dataUrl = c.toDataURL('image/jpeg', 0.35);
    const a = await post({ action: 'snapshot', attemptId: st.attemptId, event: 'RANDOM', dataUrl });
    const b = await post({ action: 'snapshot', attemptId: st.attemptId, event: 'RANDOM', dataUrl });
    return { first: a.saved, second: b.saved, attemptId: st.attemptId };
  }, randExamId);
  ok(rnd.first === true && rnd.second === false, 'random snapshot saved; a second one right away is refused (limit per hour)');
  const rndSeen = await teacher.evaluate(async ([examId, aid]) => (await (await fetch('/api/teacher/exams/' + examId + '/attempts/' + aid)).json()).snapshots.map((s) => s.kind + ':' + s.event).join(), [randExamId, rnd.attemptId]);
  ok(rndSeen === 'random:RANDOM', 'teacher sees the random snapshot (' + rndSeen + ')');
  await teacher.goto(BASE + '/teacher#exams'); await teacher.waitForSelector(`[data-archive="${randExamId}"]`);
  await teacher.click(`[data-archive="${randExamId}"]`);
  ok((await teacher.textContent('.dialog')).includes('1 camera snapshot is permanently deleted'), 'archiving warns that the snapshots are deleted');
  await teacher.click('.dialog .btn.primary');
  ok(await toastSays(teacher, '1 snapshot deleted'), 'archiving deletes the exam\'s snapshots');
  const snapLeft = await dbOne(`SELECT count(*)::int AS n FROM attempt_snapshots s JOIN attempts a ON a.id = s.attempt_id WHERE a.exam_id = $1`, [randExamId]);
  ok(snapLeft.n === 0 && fs.readdirSync(process.env.SNAPSHOT_DIR).length === 1, 'the snapshot row and file are gone; other exams keep theirs');
  await db.query(`UPDATE exams SET end_at = now() - interval '31 days' WHERE id = $1`, [camExam]);
  await require('../src/snapshots').cleanup();
  const left2 = await dbOne(`SELECT count(*)::int AS n FROM attempt_snapshots`);
  ok(left2.n === 0 && fs.readdirSync(process.env.SNAPSHOT_DIR).length === 0, 'snapshots are deleted 30 days after the exam closes');
  await db.query(`UPDATE exams SET end_at = now() + interval '1 hour' WHERE id = $1`, [camExam]);
  const strikes = await student.evaluate(async (aid) => {
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ action: 'violation', attemptId: aid, event: 'PHONE_DETECTED', detail: 'Phone detected for 3 s.' }) })).json());
    return out.map((r) => r.status + (r.warned ? '/warned' : ''));
  }, snap.attemptId);
  ok(strikes.join(',') === 'IN_PROGRESS/warned,IN_PROGRESS/warned,VOIDED', 'with 2 camera warnings set, the 3rd phone detection voids (' + strikes.join(', ') + ')');

  // ── Passwords: admin reset (forgiving temporary code), forced new password, forgot-password email ──
  const pwUser = await newUser();
  // the page may move to the sign-in page by itself at the same moment (after signing out): that is fine
  const goHome = async () => { try { await pwUser.goto(BASE + '/'); } catch (e) { if (!/ERR_ABORTED|interrupted/.test(e.message)) throw e; await pwUser.waitForLoadState(); } };
  await pwUser.goto(BASE + '/#signup');
  await pwUser.fill('#upName', 'Lea Cruz'); await pwUser.fill('#upEmail', 'lea@student.edu'); await pwUser.fill('#upPass', 'student-pass-9');
  await pwUser.click('#signUp button[type=submit]'); await pwUser.waitForURL(/\/student/);
  await pwUser.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } }));
  await goHome(); await pwUser.waitForSelector('#signIn');
  for (let i = 0; i < 10; i++) await pwUser.evaluate((i) => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: 'lea@student.edu', password: 'guess-' + i }) }), i);
  const leaId = (await dbOne(`SELECT id FROM users WHERE email = 'lea@student.edu'`)).id;
  const leaTemp = await admin.evaluate(async (id) => (await (await fetch('/api/admin/users/' + id + '/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })).json()).tempPassword, leaId);
  await goHome();
  await pwUser.fill('#inEmail', 'lea@student.edu'); await pwUser.fill('#inPass', leaTemp.toLowerCase() + ' '); await pwUser.press('#inPass', 'Enter');
  await pwUser.waitForURL(/\/student/);
  ok(true, 'temporary password works in small letters with a space, even after 10 earlier wrong tries');
  await pwUser.waitForSelector('.dialog:has-text("Choose your own password")');
  ok(!(await pwUser.isVisible('.dialog .x')), 'after a temporary password, choosing a new one is required (no close button)');
  await pwUser.fill('#cnNew', 'my-new-pass-1'); await pwUser.fill('#cnAgain', 'my-new-pass-1'); await pwUser.click('.dialog .btn.primary');
  ok(await toastSays(pwUser, 'Password saved'), 'student saves a new password');
  ok((await dbOne(`SELECT must_change_password FROM users WHERE id = $1`, [leaId])).must_change_password === false, 'the "must change password" flag is cleared');
  // Forgot password by email
  await pwUser.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } }));
  await goHome();
  await pwUser.fill('#inEmail', 'lea@student.edu');
  await pwUser.click('#forgotLink');
  await pwUser.waitForSelector('#fpEmail');
  ok((await pwUser.inputValue('#fpEmail')) === 'lea@student.edu', 'forgot-password box is filled with the typed email');
  const before = outbox.length;
  await pwUser.click('.dialog .btn.primary');
  await pwUser.waitForSelector('#fpMsg .note.ok');
  const mail = outbox[outbox.length - 1];
  ok(outbox.length === before + 1 && mail.to === 'lea@student.edu' && /\/reset\?token=[0-9a-f]{64}/.test(mail.text), 'a reset link is emailed');
  const nobody = await pwUser.evaluate(async () => (await (await fetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: 'nobody@student.edu' }) })).json()));
  ok(nobody.ok && outbox.length === before + 1, 'an unknown email gets the same answer and no email (no account guessing)');
  const link = mail.text.match(/https?:\/\/\S+\/reset\?token=[0-9a-f]{64}/)[0];
  await pwUser.goto(link);
  await pwUser.waitForSelector('#rpNew');
  ok(!pwUser.url().includes('token='), 'the secret link is removed from the address bar');
  await pwUser.fill('#rpNew', 'from-email-1'); await pwUser.fill('#rpAgain', 'from-email-1'); await pwUser.click('#rpSave');
  await pwUser.waitForURL(/\/student/);
  ok(true, 'new password set from the email link, and signed in');
  const reuse = await pwUser.evaluate(async (t) => (await (await fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ token: t, password: 'again-pass-1' }) })).json()).code, link.split('token=')[1]);
  ok(reuse === 'BAD_LINK', 'a reset link works only once');
  const testMail = await admin.evaluate(async () => (await (await fetch('/api/admin/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })).json()));
  ok(testMail.ok && outbox[outbox.length - 1].to === 'admin@test.local', 'admin can send a test email');

  // ── Offline exam: download, take it without internet, receipt code, send when back online ──
  const offExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'TF').slice(0, 2).map((q) => q.id);
    const weak = await post('/api/teacher/exams', { classId: cls.id, title: 'Offline weak', questionIds: ids, password: 'abc', options: { offlineMode: true } });
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Offline quiz', questionIds: ids, timeLimitMinutes: 10, password: 'K7M-Q2X-9PD', shuffleQuestions: false,
      options: { offlineMode: true }, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    const pub = await post('/api/teacher/exams/' + x.id, { publish: true });
    return { id: x.id, weak: weak.error || '', pub: pub.ok ? '' : pub.error };
  });
  ok(offExam.weak.includes('at least 8'), 'an offline exam needs a strong password');
  await teacher.goto(BASE + '/teacher#exam/' + offExam.id); await teacher.waitForSelector('input[name=eNet][value=OFFLINE]');
  ok((await teacher.isChecked('input[name=eNet][value=OFFLINE]')) && (await teacher.textContent('#passShow')).includes('K7M-Q2X-9PD'), 'exam editor shows "Offline exam" and the password to announce');
  await student.goto(BASE + '/exam?id=' + offExam.id);
  await student.waitForSelector('#screen-rules:not([hidden]), #screen-error:not([hidden])', { timeout: 15000 }).catch(() => {});
  await student.waitForTimeout(1500);
  await student.waitForSelector('#offlineCard:not([hidden]) #dlBtn');
  await student.click('#dlBtn');
  await student.waitForFunction(() => /Ready offline|could not/.test(document.querySelector('#dlStatus') ? document.querySelector('#dlStatus').textContent : ''), null, { timeout: 60000 });
  ok((await student.textContent('#dlStatus')).includes('Ready offline') && (await student.textContent('#offlineCard')).includes('Downloaded on this device'), 'student downloads the exam for offline: "Ready offline"');
  ok(await student.isVisible('#examPassword') && !(await dbOne('SELECT 1 AS x FROM attempts WHERE exam_id = $1', [offExam.id])),
    'after downloading, this device uses the downloaded copy (password needed), even with internet: no online attempt can start');
  await teacher.goto(BASE + '/teacher#results/' + offExam.id); await teacher.waitForSelector('.panel h3:has-text("Offline copies")');
  ok((await teacher.locator('.panel', { hasText: 'Offline copies' }).locator('.statgrid').textContent()).includes('1 / '), 'Results show who has downloaded the offline copy');
  const [sheet] = await Promise.all([teacher.waitForEvent('popup'), teacher.click('#examDaySheet')]);
  await sheet.waitForSelector('table tbody tr');
  const sheetText = await sheet.textContent('body');
  ok(sheetText.includes('K7M-Q2X-9PD') && sheetText.includes('Juan Dela Cruz') && sheetText.includes('Receipt code'), 'the exam-day sheet has the password, the steps and the attendance list');
  await sheet.close();
  await student.context().setOffline(true);
  await student.goto(BASE + '/exam?id=' + offExam.id);
  await student.waitForSelector('#screen-rules:not([hidden]) #offlineCard:not([hidden])', { timeout: 20000 });
  ok((await student.textContent('#offlineCard')).includes('No internet is needed'), 'without internet, the downloaded exam still opens');
  await student.check('#agree');
  await student.fill('#examPassword', 'WRONG-PASS-1'); await student.click('#startBtn');
  await student.waitForSelector('#startError:not([hidden])');
  ok((await student.textContent('#startError')).includes('not right'), 'a wrong password does not unlock it');
  await student.fill('#examPassword', 'k7m q2x 9pd'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])', { timeout: 20000 });
  await student.click('#questions .question:nth-child(1) label:has-text("True")');
  ok((await student.textContent('#saveState')).includes('Offline exam'), 'the right password (any letter case) unlocks it; "Offline exam · saved on this device"');
  await student.reload();
  await student.waitForSelector('#screen-rules:not([hidden])', { timeout: 20000 });
  ok((await student.textContent('#startBtn')).includes('Continue exam'), 'after a reload, the offline exam can be continued');
  await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  ok(await student.isChecked('#questions .question:nth-child(1) input[value="TRUE"], #questions .question:nth-child(1) input:checked'), 'the answer given before the reload is still there');
  await student.click('#questions .question:nth-child(2) label:has-text("False")');
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#pendingReceipt:not([hidden])');
  const offReceipt = (await student.textContent('#pendingReceipt b')).trim();
  await shot(student, '20-offline-receipt');
  ok(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(offReceipt), 'finishing offline shows a receipt code (' + offReceipt + ')');
  await student.context().setOffline(false);
  await student.waitForSelector('#screen-result:not([hidden])', { timeout: 30000 });
  const offRow = await dbOne(`SELECT id, status, offline, receipt, review, score, max_score FROM attempts WHERE exam_id = $1`, [offExam.id]);
  ok(offRow && offRow.status === 'SUBMITTED' && offRow.offline && offRow.receipt === offReceipt && !offRow.review && offRow.max_score === 2,
    'back online: the answers are sent, graded and the receipt matches (' + JSON.stringify(offRow) + ')');
  await teacher.goto(BASE + '/teacher#exams'); await teacher.goto(BASE + '/teacher#results/' + offExam.id); await teacher.waitForSelector('[data-answers]');
  const offNotes = await teacher.textContent('#aRows');
  ok(offNotes.includes('Offline') && offNotes.includes('Receipt ' + offReceipt), 'Results show "Offline" and the receipt code');
  // changed answers don't match the receipt; an answer file can be uploaded by the teacher
  const off2 = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'TF').slice(0, 1).map((q) => q.id);
    const mk = async (title) => { const x = (await post('/api/teacher/exams', { classId: cls.id, title, questionIds: ids, timeLimitMinutes: 10, password: 'AAAA-BBBB-CC', options: { offlineMode: true },
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam; await post('/api/teacher/exams/' + x.id, { publish: true }); return x.id; };
    return { a: await mk('Offline tamper'), b: await mk('Offline file') };
  });
  const tamper = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const d = await post({ action: 'download', examId });
    return post({ action: 'offlineSubmit', packageId: d.packageId, answers: { x: 'TRUE' }, startedAt: Date.now() - 60000, finishedAt: Date.now() - 1000, receipt: 'AAA-AAA', events: [] });
  }, off2.a);
  const tRow = await dbOne(`SELECT review FROM attempts WHERE exam_id = $1`, [off2.a]);
  ok(tamper.submitted && tRow.review && tRow.review.join(' ').includes('does not match'), 'answers changed after the receipt are flagged "Please check"');
  const pkgB = await student.evaluate(async (examId) => (await (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ action: 'download', examId }) })).json()).packageId, off2.b);
  await teacher.goto(BASE + '/teacher#exams'); await teacher.goto(BASE + '/teacher#results/' + off2.b); await teacher.waitForSelector('[data-offfile]', { state: 'attached' });
  await teacher.setInputFiles('[data-offfile]', { name: 'answers.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ kind: 'exam-wizard-answers', attemptId: pkgB, answers: {}, finishedMs: Date.now() - 5000, student: { name: 'Juan Dela Cruz' } })) });
  ok(await toastSays(teacher, 'Juan Dela Cruz: received'), 'teacher uploads the answer file of a student who finished offline');
  const fRow = await dbOne(`SELECT status, offline FROM attempts WHERE exam_id = $1`, [off2.b]);
  ok(fRow && fRow.status === 'SUBMITTED' && fRow.offline, 'the uploaded offline answers are graded');

  // ── QR hand-in: the student's device never gets internet; a qrHelper scans the QR codes ──
  const qrExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const qs = (await (await fetch('/api/teacher/questions')).json()).questions;
    const ids = [qs.find((q) => q.type === 'TF').id, qs.find((q) => q.type === 'ESSAY').id];
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'QR quiz', questionIds: ids, timeLimitMinutes: 10, password: 'QRQR-1234-XY', shuffleQuestions: false,
      options: { offlineMode: true }, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    const link = (await post('/api/teacher/exams/' + x.id + '/collectors', { label: 'Ana (assistant)', hours: 4 })).link;
    const link2 = (await post('/api/teacher/exams/' + x.id + '/collectors', { label: 'Old link', hours: 4 })).link;
    const links = (await (await fetch('/api/teacher/exams/' + x.id + '/collectors')).json()).links;
    await post('/api/teacher/exams/' + x.id + '/collectors', { revoke: links.find((l) => l.label === 'Old link').id });
    return { id: x.id, link, link2 };
  });
  await student.goto(BASE + '/exam?id=' + qrExam.id);
  await student.waitForSelector('#offlineCard:not([hidden]) #dlBtn'); await student.click('#dlBtn');
  await student.waitForFunction(() => /Ready offline|could not/.test((document.querySelector('#dlStatus') || {}).textContent || ''), null, { timeout: 60000 });
  await student.context().setOffline(true);
  await student.goto(BASE + '/exam?id=' + qrExam.id);
  await student.waitForSelector('#screen-rules:not([hidden]) #offlineCard:not([hidden])', { timeout: 20000 });
  await student.check('#agree'); await student.fill('#examPassword', 'QRQR-1234-XY'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])', { timeout: 20000 });
  await student.click('#questions .question:nth-child(1) label:has-text("True")');
  const essay = 'Ohm\'s law: V = I × R, so R = V / I = 10 Ω. '.repeat(40);
  await student.fill('#questions .question:nth-child(2) textarea', essay);
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#qrBox:not([hidden]) #qrShow');
  await student.click('#qrShow');
  await student.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'jsqr.js'), 'utf8') });
  const qrTexts = [];
  for (let k = 0; k < 10; k++) {
    const t = await student.evaluate(async () => {
      const img = document.querySelector('#qrImg'); await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const r = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      return r ? new TextDecoder('utf-8').decode(new Uint8Array(r.binaryData)) : null;
    });
    if (t && !qrTexts.includes(t)) qrTexts.push(t);
    const total = t ? Number(t.split('|')[2]) : 0;
    if (total && qrTexts.length >= total) break;
    if (await student.isVisible('#qrNext')) await student.click('#qrNext'); else break;
  }
  await shot(student, '21-offline-qr');
  ok(qrTexts.length >= 2 && qrTexts.every((t) => t.startsWith('EWQ|')), 'a long answer becomes ' + qrTexts.length + ' QR codes that a phone can read');
  // the qrHelper opens the collector link (no account) and scans
  const helperCtx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  const qrHelper = await helperCtx.newPage();
  qrHelper.on('pageerror', (e) => errors.push('helper: ' + e.message));
  await qrHelper.goto(BASE + qrExam.link2);
  await qrHelper.waitForSelector('#err:not([hidden])');
  ok((await qrHelper.textContent('#err')).includes('turned off'), 'a helper link that was turned off does not work');
  await qrHelper.goto(BASE + qrExam.link);
  await qrHelper.waitForFunction(() => document.querySelector('#title').textContent.includes('QR quiz'));
  ok((await qrHelper.textContent('#sub')).includes('Ana (assistant)'), 'the helper link opens the scanner for this exam only');
  for (const t of qrTexts.slice().reverse()) await qrHelper.evaluate((x) => window.EWCollect.handleText(x), t); // any order
  await qrHelper.waitForSelector('#list li .ok', { timeout: 15000 });
  const hl = await qrHelper.textContent('#list');
  const qrRow = await dbOne(`SELECT a.status, a.offline, a.review, a.score, (SELECT student_answer FROM responses r WHERE r.attempt_id = a.id AND r.type = 'ESSAY') AS essay
      FROM attempts a WHERE a.exam_id = $1`, [qrExam.id]);
  ok(hl.includes('Juan Dela Cruz') && hl.includes('Received') && !/\d+ \/ \d+/.test(hl), 'helper sees "Juan Dela Cruz ✓ Received" (no score)');
  ok(qrRow && qrRow.status === 'SUBMITTED' && qrRow.offline && !qrRow.review && qrRow.essay === essay, 'the scanned answers are graded; the long essay (with Ω and ×) arrived complete');
  // the teacher's own scanner: the same codes again are recognised as already received
  await teacher.goto(BASE + '/collect?exam=' + qrExam.id);
  await teacher.waitForFunction(() => document.querySelector('#title').textContent.includes('QR quiz'));
  for (const t of qrTexts) await teacher.evaluate((x) => window.EWCollect.handleText(x), t);
  await teacher.waitForSelector('#list li .ok', { timeout: 15000 });
  ok((await teacher.textContent('#list')).includes('Already received'), 'scanning the same student twice: "Already received", nothing changes');
  // the student's device later gets internet: nothing is sent twice
  await student.context().setOffline(false);
  await student.waitForSelector('#screen-result:not([hidden])', { timeout: 30000 });
  ok((await dbOne('SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1', [qrExam.id])).n === 1, 'when the student\'s device gets internet later, the same answers are not counted twice');
  await helperCtx.close();

  // ── Offline fixes: a voided offline exam, My Exams without internet, a void made while offline, old unfinished attempts ──
  const voidOff = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'TF').slice(0, 1).map((q) => q.id);
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Offline void quiz', questionIds: ids, timeLimitMinutes: 10, password: 'VOID-TEST-99',
      options: { offlineMode: true }, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  await student.goto(BASE + '/exam?id=' + voidOff);
  await student.waitForSelector('#offlineCard:not([hidden]) #dlBtn'); await student.click('#dlBtn');
  await student.waitForFunction(() => /Ready offline|could not/.test((document.querySelector('#dlStatus') || {}).textContent || ''), null, { timeout: 60000 });
  await student.context().setOffline(true);
  await student.goto(BASE + '/exam?id=' + voidOff);
  await student.waitForSelector('#screen-rules:not([hidden]) #examPassword', { timeout: 20000 });
  await student.check('#agree'); await student.fill('#examPassword', 'VOID-TEST-99'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])', { timeout: 20000 });
  await student.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await student.waitForSelector('#voidModal:not([hidden])', { timeout: 10000 });
  await student.goto(BASE + '/student'); // My Exams without internet → the downloaded exams
  await student.waitForSelector('.off-item', { timeout: 20000 });
  const offList = await student.textContent('#list');
  ok(offList.includes('Offline void quiz') && offList.includes('Voided · not sent yet'), 'My Exams without internet shows the downloaded exams; a voided one says "Voided · not sent yet"');
  await shot(student, '22-offline-list');
  await student.context().setOffline(false);
  await student.goto(BASE + '/exam?id=' + voidOff);
  await student.waitForFunction(() => (document.querySelector('#voidOffline') || {}).textContent.includes('Sent to your teacher') || (document.querySelector('#voidOffline') || {}).textContent.includes('sent to your teacher.'), null, { timeout: 20000 });
  const vRow = await dbOne('SELECT status, review FROM attempts WHERE exam_id = $1', [voidOff]);
  ok(vRow && vRow.status === 'VOIDED' && !vRow.review, 'the offline void arrives as Voided, shows "✓ sent to your teacher", and no false receipt warning');
  await student.goto(BASE + '/offline'); await student.waitForSelector('.off-item');
  ok((await student.textContent('#list')).includes('Voided · sent ✓'), 'the downloaded-exams page then says "Voided · sent ✓"');
  // an online exam voided while the internet was off: the void is sent the next time the page opens
  const lostExam = await mkExam('Lost void quiz', {});
  await student.goto(BASE + '/exam?id=' + lostExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.context().setOffline(true);
  await student.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await student.waitForSelector('#voidModal:not([hidden])', { timeout: 10000 });
  await student.waitForTimeout(500);
  const stillIn = (await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [lostExam])).status;
  await student.goto('about:blank');
  await student.context().setOffline(false);
  await student.goto(BASE + '/exam?id=' + lostExam);
  await student.waitForSelector('#screen-error:not([hidden]), #screen-rules:not([hidden])', { timeout: 20000 });
  ok(stillIn === 'IN_PROGRESS' && (await dbOne('SELECT status FROM attempts WHERE exam_id = $1', [lostExam])).status === 'VOIDED',
    'a void that happened without internet is sent the next time the exam page opens');
  // Results: an attempt whose time ran out long ago is "Time ran out (not submitted)", not "In progress"
  const oldExam = await mkExam('Old attempt quiz', {});
  await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
  }, oldExam);
  await db.query(`UPDATE attempts SET started_at = now() - interval '5 hours', deadline = now() - interval '4 hours' WHERE exam_id = $1`, [oldExam]);
  await teacher.goto(BASE + '/teacher#exams'); await teacher.goto(BASE + '/teacher#results/' + oldExam); await teacher.waitForSelector('[data-answers]');
  ok((await teacher.textContent('#aRows')).includes('Time ran out'), 'Results: an old unfinished attempt shows "Time ran out (not submitted)"');

  // ── My Exams: offline exams are labelled and can be downloaded from there; students see their current rank ──
  const dashOff = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const ids = (await (await fetch('/api/teacher/questions')).json()).questions.filter((q) => q.type === 'TF').slice(0, 1).map((q) => q.id);
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Dashboard offline quiz', questionIds: ids, timeLimitMinutes: 10, password: 'DASH-OFF-123',
      options: { offlineMode: true }, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString() })).exam;
    await post('/api/teacher/exams/' + x.id, { publish: true });
    return x.id;
  });
  await student.goto(BASE + '/student'); await student.waitForSelector('.item');
  await student.click(`.item[data-id="${dashOff}"]`); await student.waitForSelector('#offbox a.btn');
  ok((await student.textContent(`.item[data-id="${dashOff}"]`)).includes('Offline exam') && (await student.textContent('#offbox')).includes('weak or no internet') &&
    (await student.textContent('.tiles')).includes('Offline exam'), 'My Exams shows "📥 Offline exam" before starting, with a Download for offline button');
  await shot(student, '23-dashboard-offline');
  await student.click('#offbox a.btn');
  await student.waitForFunction(() => /Ready offline|could not/.test((document.querySelector('#dlStatus') || {}).textContent || ''), null, { timeout: 60000 });
  ok((await student.textContent('#dlStatus')).includes('Ready offline'), 'the button on My Exams downloads it straight away');
  await student.goto(BASE + '/student'); await student.waitForSelector('.item');
  await student.click(`.item[data-id="${dashOff}"]`); await student.waitForSelector('#offbox.ready');
  ok((await student.textContent('#offbox')).includes('Downloaded on this device'), 'My Exams then says "✓ Downloaded on this device"');
  // rank: one other student scored higher
  const rankExam = await mkExam('Rank quiz', {});
  const teacherId = (await dbOne(`SELECT teacher_id FROM exams WHERE id = $1`, [rankExam])).teacher_id;
  await db.query(`INSERT INTO attempts (id, exam_id, student_id, status, started_at, submitted_at, score, max_score, percent, pending_essays)
      VALUES (gen_random_uuid(), $1, $2, 'SUBMITTED', now(), now(), 1, 1, 100, 0)`, [rankExam, teacherId]);
  await student.goto(BASE + '/exam?id=' + rankExam);
  await student.waitForSelector('#screen-rules:not([hidden])'); await student.check('#agree'); await student.click('#startBtn');
  await student.waitForSelector('#screen-exam:not([hidden])');
  await student.click('#questions .question label:has-text("False")');
  await student.click('#submitBtn'); await student.click('#confirmYes');
  await student.waitForSelector('#resultRank:not([hidden])');
  const rText = await student.textContent('#resultRank');
  ok(rText.includes('Rank = 2/2') && rText.includes('Percentile rank = 25') && rText.includes('Mean = 50'), 'after submitting, the student sees the rank and class statistics (' + rText.trim().slice(0, 60) + ')');
  await student.goto(BASE + '/student'); await student.waitForSelector('.item');
  await student.click(`.item[data-id="${rankExam}"]`); await student.waitForSelector('#startbox .scorebox');
  const rep = await student.textContent('#startbox');
  ok(rep.includes('0.00%') && rep.includes('Rank = 2/2') && rep.includes('Median = 50'), 'My Exams shows the results report: score, rank 2/2, mean, median, percentile');
  const [rpop] = await Promise.all([student.waitForEvent('popup'), student.click('#printResult')]);
  await rpop.waitForSelector('.box');
  ok((await rpop.textContent('body')).includes('Rank = 2/2') && (await rpop.textContent('.box')).includes('0.00%'), 'a printable result report opens');
  await rpop.close();
  await teacher.evaluate(async (id) => {
    const x = (await (await fetch('/api/teacher/exams/' + id)).json()).exam;
    await fetch('/api/teacher/exams/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ classId: x.class_id, title: x.title, questionIds: x.question_ids, startAt: x.start_at, endAt: x.end_at, timeLimitMinutes: x.time_limit_min, showScore: true, options: Object.assign({}, x.options, { showRank: false }) }) });
  }, rankExam);
  await student.goto(BASE + '/student'); await student.waitForSelector('.item');
  await student.click(`.item[data-id="${rankExam}"]`); await student.waitForSelector('#startbox .scorebox');
  ok(!(await student.textContent('#startbox')).includes('Rank'), 'with "show rank" turned off, no rank or statistics are shown');
  await db.query('DELETE FROM attempts WHERE exam_id = $1 AND student_id = $2', [rankExam, teacherId]);

  // ── New teacher accounts: need an access code or the admin's approval ──
  await admin.goto(BASE + '/admin#settings'); await admin.waitForSelector('#sTeachMode');
  await admin.selectOption('#sTeachMode', 'approval'); await admin.click('#sSave'); await toastSays(admin, 'Settings saved');
  const appl = await newUser();
  await appl.goto(BASE + '/#signup'); await appl.waitForSelector('#signUp:not([hidden])');
  await appl.check('input[name=role][value=teacher]');
  ok(await appl.isVisible('#approvalNote') && await appl.isVisible('#upNote'), 'the sign-up form explains: an access code, or a request for approval');
  await appl.fill('#upName', 'Rosa Reyes'); await appl.fill('#upEmail', 'rosa@school.edu'); await appl.fill('#upPass', 'teacher-pass-7');
  await appl.fill('#upSchool', 'MSU-IIT'); await appl.fill('#upNote', 'EE instructor, EEE 152');
  await appl.click('#signUp button[type=submit]'); await appl.waitForSelector('#pendingMsg');
  ok((await appl.textContent('#pendingMsg')).includes('Request sent'), 'without a code, the teacher\'s sign-up becomes a request');
  const reqMail = outbox[outbox.length - 1];
  ok(reqMail && reqMail.to === 'admin@test.local' && reqMail.text.includes('Rosa Reyes') && reqMail.text.includes('/admin#signups'), 'the site owner gets an email about the request');
  const pendLogin = await appl.evaluate(async () => (await (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: 'rosa@school.edu', password: 'teacher-pass-7' }) })).json()));
  ok(pendLogin.code === 'PENDING' && pendLogin.error.includes('waiting for the administrator'), 'the teacher cannot sign in before approval (clear message)');
  await admin.goto(BASE + '/admin#signups'); await admin.waitForSelector('[data-approve]');
  ok((await admin.textContent('#signBadge')) === '1' && (await admin.textContent('#view')).includes('EE instructor, EEE 152'), 'Admin → Teacher sign-ups lists the request with their note');
  await shot(admin, '26-teacher-signups');
  await admin.click('[data-approve]'); await toastSays(admin, 'Approved');
  const okMail = outbox[outbox.length - 1];
  ok(okMail.to === 'rosa@school.edu' && okMail.subject.includes('is ready'), 'approving emails the teacher that the account is ready');
  const afterLogin = await appl.evaluate(async () => (await (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: 'rosa@school.edu', password: 'teacher-pass-7' }) })).json()));
  ok(afterLogin.ok && afterLogin.user.role === 'teacher', 'after approval the teacher signs in');
  // with an access code: at once; a wrong code is refused; a declined request is deleted
  const goodCode = await admin.evaluate(async () => (await (await fetch('/api/admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ kind: 'days', amount: 30 }) })).json()).codes[0]);
  const reg = async (email, extra) => appl.evaluate(async ([email, extra]) => {
    const human = await EWHuman.attach(document.createElement('div')).proof();
    return (await (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(Object.assign({ role: 'teacher', name: 'T ' + email, email, password: 'teacher-pass-8', human }, extra)) })).json());
  }, [email, extra]);
  // spam checks: no tick, a reused tick, a made-up answer, or the hidden field filled in are all refused (and no account is made)
  const spam = await appl.evaluate(async () => {
    const post = async (b) => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const base = (email) => ({ role: 'student', name: 'Bot', email, password: 'robot-pass-1' });
    const none = await post(base('bot1@spam.test'));
    const human = await EWHuman.attach(document.createElement('div')).proof();
    const fake = await post(Object.assign(base('bot2@spam.test'), { human: Object.assign({}, human, { number: (human.number + 1) % 60000 }) }));
    const trap = await post(Object.assign(base('bot3@spam.test'), { human, website: 'http://spam.test' }));
    const first = await post(Object.assign(base('real@student.edu'), { human }));
    const again = await post(Object.assign(base('bot4@spam.test'), { human }));
    return { none, fake, trap, first, again };
  });
  ok(!spam.none.ok && spam.none.error.includes("I'm not a robot") && !spam.fake.ok && !spam.trap.ok && spam.first.ok && !spam.again.ok
    && !(await dbOne(`SELECT 1 AS x FROM users WHERE email LIKE '%@spam.test'`)),
    'sign-up needs the "I\'m not a robot" check: no tick, a wrong answer, the hidden robot field, or reusing one tick are refused');
  await appl.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' }); });
  const withCode = await reg('coded@school.edu', { accessCode: goodCode });
  const wrongCode = await reg('wrong@school.edu', { accessCode: 'NOPE-NOPE' });
  ok(withCode.ok && !withCode.pending && withCode.user && withCode.user.role === 'teacher', 'with a valid access code, the teacher account works at once');
  ok(!wrongCode.ok && wrongCode.error.includes('not valid') && !(await dbOne(`SELECT 1 AS x FROM users WHERE email = 'wrong@school.edu'`)), 'a wrong access code is refused (no account made)');
  const toDecline = await reg('nope@school.edu', {});
  await admin.goto(BASE + '/admin#overview'); await admin.goto(BASE + '/admin#signups'); await admin.waitForSelector('[data-decline]');
  await admin.click('[data-decline]'); await admin.locator('.overlay').last().locator('.ft .btn.danger, .ft .btn.primary').last().click();
  await toastSays(admin, 'Declined');
  ok(toDecline.pending && !(await dbOne(`SELECT 1 AS x FROM users WHERE email = 'nope@school.edu'`)), 'declining deletes the request');
  await admin.goto(BASE + '/admin#settings'); await admin.waitForSelector('#sTeachMode');
  await admin.selectOption('#sTeachMode', 'open'); await admin.click('#sSave'); await toastSays(admin, 'Settings saved');
  await appl.context().close();

  // ── Safeguards: backups, pausing updates, helping one student ──
  const backupLib = require('../src/backup');
  const bk = await backupLib.backupNow();
  const { PGlite } = require('@electric-sql/pglite');
  const copy = new PGlite();
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8').split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const st of schemaSql) await copy.query(st);
  const rest = await backupLib.restore(path.join(process.env.BACKUP_DIR, bk.file), (sql, p) => copy.query(sql, p));
  const countsHere = await dbOne(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM responses)::int AS r, (SELECT count(*) FROM question_folders)::int AS f`);
  const countsCopy = (await copy.query(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM responses)::int AS r, (SELECT count(*) FROM question_folders)::int AS f`)).rows[0];
  ok(bk.rows > 50 && rest.failedCount === 0 && countsCopy.u === countsHere.u && countsCopy.r === countsHere.r && countsCopy.f === countsHere.f,
    'a backup restores into an empty database with every row (' + bk.rows + ' rows, ' + Math.round(bk.bytes / 1024) + ' KB)');
  await copy.close();
  const check1 = await (await fetch(BASE + '/deploy-check')).json();
  const outside = await fetch(BASE + '/deploy-check', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  await admin.goto(BASE + '/admin#settings'); await admin.waitForSelector('#sPause');
  await admin.waitForSelector('#sBackupNow');
  ok((await admin.textContent('#sBackups')).includes('Download'), 'Site settings list the backups with Download buttons');
  await admin.check('#sPause'); await admin.click('#sSave'); await toastSays(admin, 'Settings saved');
  let check2 = {};
  for (let i = 0; i < 50 && !check2.paused; i++) { check2 = await (await fetch(BASE + '/deploy-check')).json(); if (!check2.paused) await sleep(100); }
  ok(check1.ok && check1.paused === false && outside.status === 404 && check2.paused === true, 'the deploy check sees "Pause site updates" and is not reachable from outside');
  await admin.uncheck('#sPause'); await admin.click('#sSave'); await toastSays(admin, 'Settings saved');

  // a student's device "crashes": answers saved on the server are submitted by the teacher
  const helpExam = await mkExam('Help quiz', {});
  const helpSt = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, pageToken: '11111111-2222-4333-8444-555555555555', env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    await post({ action: 'ping', attemptId: st.attemptId, pageToken: '11111111-2222-4333-8444-555555555555', answers: { [st.questions[0].id]: 'TRUE' } });
    await post({ action: 'clientError', attemptId: st.attemptId, message: 'TypeError: x is undefined', where: 'app.js:10' });
    return { attemptId: st.attemptId, deadlineMs: st.deadlineMs };
  }, helpExam);
  await teacher.goto(BASE + '/teacher#results/' + helpExam); await teacher.waitForSelector('[data-answers]');
  ok((await teacher.textContent('#aRows')).includes('Page problem (1)'), 'a problem on the student\'s exam page shows in Results');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="continue"]');
  await teacher.fill('#helpMin', '10'); await teacher.click('.dialog [data-help="continue"]');
  await toastSays(teacher, 'Extra time added');
  const afterTime = await dbOne('SELECT deadline FROM attempts WHERE id = $1', [helpSt.attemptId]);
  ok(new Date(afterTime.deadline).getTime() - helpSt.deadlineMs >= 9.9 * 60000, 'teacher gives 10 minutes extra time');
  await teacher.waitForSelector('[data-answers]'); await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="draft"]');
  ok((await teacher.textContent('.dialog .helpbox')).includes('1 answer saved on the server'), 'the Answers window shows the answers saved on the server');
  await teacher.click('.dialog [data-help="draft"]'); await teacher.locator('.overlay').last().locator('.ft .btn.primary').click();
  ok(await toastSays(teacher, 'Submitted. Score: 1 / 1'), 'teacher submits the saved answers for the student: 1 / 1');
  const helpRow = await dbOne(`SELECT a.status, (SELECT count(*) FROM violations v WHERE v.attempt_id = a.id AND v.event = 'TEACHER_SUBMITTED')::int AS n FROM attempts a WHERE a.id = $1`, [helpSt.attemptId]);
  ok(helpRow.status === 'SUBMITTED' && helpRow.n === 1, 'it is recorded in the student\'s events');

  // a voided student is allowed to continue with the same questions and saved answers
  const contExam = await mkExam('Continue quiz', {});
  const cont1 = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    await post({ action: 'ping', attemptId: st.attemptId, answers: { [st.questions[0].id]: 'FALSE' } });
    await post({ action: 'violation', attemptId: st.attemptId, event: 'TAB_SWITCH', detail: 'test', final: true });
    const again = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return { attemptId: st.attemptId, blocked: again.code };
  }, contExam);
  await teacher.goto(BASE + '/teacher#results/' + contExam); await teacher.waitForSelector('[data-answers]');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="continue"]');
  ok((await teacher.textContent('.dialog [data-help="continue"]')).includes('Let them continue'), 'a voided attempt offers "Let them continue"');
  await teacher.click('.dialog [data-help="continue"]'); await toastSays(teacher, 'can open the exam link again');
  const cont2 = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return { attemptId: st.attemptId, resumed: st.resumed, draft: st.draftAnswers };
  }, contExam);
  ok(cont1.blocked === 'VOIDED' && cont2.attemptId === cont1.attemptId && cont2.resumed && cont2.draft && Object.values(cont2.draft)[0] === 'FALSE',
    'after "Let them continue" the student reopens the same attempt with the saved answers');

  // an answer file from a student whose device had no internet
  const fileExam = await mkExam('File quiz', {});
  const fileSt = await student.evaluate(async (examId) => {
    const post = async (b) => (await fetch('/api/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const st = await post({ action: 'start', examId, env: { monitorCheck: 'supported', userAgent: navigator.userAgent } });
    return { attemptId: st.attemptId, qid: st.questions[0].id };
  }, fileExam);
  await teacher.goto(BASE + '/teacher#results/' + fileExam); await teacher.waitForSelector('[data-answers]');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="file"]', { state: 'attached' });
  const wrongFile = { kind: 'exam-wizard-answers', attemptId: '00000000-0000-4000-8000-000000000000', answers: { a: 1 }, student: { name: 'Juan' }, finishedAt: new Date().toISOString() };
  await teacher.setInputFiles('.dialog [data-help="file"]', { name: 'answers.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(wrongFile)) });
  await teacher.locator('.overlay').last().locator('.ft .btn.primary').click();
  ok(await toastSays(teacher, 'not for this student'), 'an answer file for another attempt is refused');
  await teacher.keyboard.press('Escape');
  await teacher.goto(BASE + '/teacher#results/' + fileExam); await teacher.waitForSelector('[data-answers]');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="file"]', { state: 'attached' });
  const goodFile = Object.assign({}, wrongFile, { attemptId: fileSt.attemptId, answers: { [fileSt.qid]: 'TRUE' } });
  await teacher.setInputFiles('.dialog [data-help="file"]', { name: 'answers.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(goodFile)) });
  await teacher.locator('.overlay').last().locator('.ft .btn.primary').click();
  ok(await toastSays(teacher, 'Submitted from the file. Score: 1 / 1'), 'teacher uploads the student\'s answer file: graded 1 / 1');
  await db.query('UPDATE attempts SET late = true WHERE id = $1', [fileSt.attemptId]);
  await teacher.goto(BASE + '/teacher#results/' + fileExam); await teacher.waitForSelector('[data-answers]');
  await teacher.click('[data-answers]'); await teacher.waitForSelector('.dialog [data-help="ontime"]');
  await teacher.click('.dialog [data-help="ontime"]'); await toastSays(teacher, 'Counted as on time');
  ok((await dbOne('SELECT late FROM attempts WHERE id = $1', [fileSt.attemptId])).late === false, '"Count as on time" removes the Late mark');

  // ── Exams list grouped by course ──
  const groupCls = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const c = (await post('/api/teacher/classes', { name: 'EEE 146', section: 'W89' })).class;
    const qid = (await (await fetch('/api/teacher/questions')).json()).questions.find((q) => q.type === 'TF').id;
    await post('/api/teacher/exams', { classId: c.id, title: 'Magnetic circuits quiz', questionIds: [qid] });
    return c.id;
  });
  await teacher.goto(BASE + '/teacher#classes'); await teacher.goto(BASE + '/teacher#exams'); await teacher.waitForSelector('#activeExams .grouprow');
  const groupNames = await teacher.$$eval('#activeExams .grouprow b', (b) => b.map((x) => x.textContent));
  ok(groupNames.includes('EEE 146') && groupNames.length >= 2, 'the Exams list is grouped by course (' + groupNames.join(', ') + ')');
  await teacher.click('#activeExams .grouprow:has-text("EEE 146") .groupbtn');
  ok(!(await teacher.isVisible('#activeExams tr[data-group="EEE146"]')), 'clicking a course folds its exams away');
  await teacher.goto(BASE + '/teacher#classes'); await teacher.goto(BASE + '/teacher#exams'); await teacher.waitForSelector('#activeExams .grouprow');
  ok(!(await teacher.isVisible('#activeExams tr[data-group="EEE146"]')), 'the folded course stays folded next time');
  await teacher.click('#activeExams .grouprow:has-text("EEE 146") .groupbtn');
  await teacher.uncheck('#groupCourses'); await teacher.waitForFunction(() => !document.querySelector('#activeExams .grouprow'));
  ok(true, '"Group by course" can be turned off for one plain list');
  await teacher.check('#groupCourses'); await teacher.waitForSelector('#activeExams .grouprow');
  await shot(teacher, '25-exams-grouped');
  await teacher.evaluate(async (id) => {
    const xs = (await (await fetch('/api/teacher/exams')).json()).exams.filter((x) => x.class_id === id);
    for (const x of xs) await fetch('/api/teacher/exams/' + x.id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ delete: true, confirmDeleteResults: true }) });
    await fetch('/api/teacher/classes/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ delete: true }) });
  }, groupCls);
  await teacher.goto(BASE + '/teacher#classes'); await teacher.waitForSelector('.classcard');

  // ── Archive: exams (teacher's list only) and classes (hidden from students) ──
  await teacher.goto(BASE + '/teacher#exams'); await teacher.waitForSelector('#activeExams [data-archive]');
  const activeBefore = await teacher.$$eval('#activeExams tbody tr[data-group]', (r) => r.length);
  const archivedBefore = await teacher.$$eval('#archivedExams tbody tr[data-group]', (r) => r.length);
  await teacher.click('#activeExams [data-archive]');
  if (await teacher.isVisible('.dialog .btn.primary').catch(() => false)) await teacher.click('.dialog .btn.primary');
  ok(await toastSays(teacher, 'Moved to Archived'), 'an exam can be archived');
  await teacher.waitForSelector('#archivedPanel:not([hidden])');
  ok((await teacher.$$eval('#activeExams tbody tr[data-group]', (r) => r.length)) === activeBefore - 1 && (await teacher.$$eval('#archivedExams tbody tr[data-group]', (r) => r.length)) === archivedBefore + 1, 'archived exam moves to the Archived list');
  await teacher.click('#archivedPanel > summary'); await teacher.click('#archivedExams [data-restore]');
  ok(await toastSays(teacher, 'Moved back to Exams'), 'an archived exam can be restored');
  await teacher.waitForFunction((n) => document.querySelectorAll('#activeExams tbody tr[data-group]').length === n, activeBefore);
  await teacher.goto(BASE + '/teacher#classes'); await teacher.waitForSelector('[data-carchive][data-to="1"]');
  await teacher.click('[data-carchive][data-to="1"]'); await teacher.click('.dialog .btn.primary');
  ok(await toastSays(teacher, 'Class archived'), 'a class can be archived');
  const hidden = await student.evaluate(async () => (await (await fetch('/api/student/dashboard')).json()).exams.length);
  await teacher.click('.archivepanel > summary'); await teacher.click('[data-carchive][data-to="0"]');
  ok(await toastSays(teacher, 'Class restored'), 'an archived class can be restored');
  const shown = await student.evaluate(async () => (await (await fetch('/api/student/dashboard')).json()).exams.length);
  ok(hidden === 0 && shown > 0, 'students don\'t see an archived class\'s exams, and see them again after restoring (' + hidden + ' → ' + shown + ')');

  // ── Teacher's manual ──
  await teacher.goto(BASE + '/teacher#classes'); await teacher.waitForSelector('#manualLink');
  const man = await teacher.context().newPage(); man.on('pageerror', (e) => errors.push(e.message));
  await man.goto(BASE + '/manual', { waitUntil: 'networkidle' });
  const manInfo = await man.evaluate(() => ({ title: document.title, imgs: document.images.length, broken: [...document.images].filter((i) => !i.naturalWidth).length,
    badLinks: [...document.querySelectorAll('a[href^="#"]')].filter((a) => !document.getElementById(a.getAttribute('href').slice(1))).length }));
  ok(/manual/i.test(manInfo.title) && !manInfo.title.includes('{site}') && manInfo.imgs > 20 && manInfo.broken === 0 && manInfo.badLinks === 0, "teacher's manual opens from the menu with all its pictures (" + manInfo.imgs + ')');
  await man.close();

  // ── Links for Google Classroom: class join link and exam link ──
  await teacher.goto(BASE + '/teacher#classes'); await teacher.waitForSelector('.classcard');
  const joinLink = await teacher.getAttribute('.classcard [data-copy*="/join/"]', 'data-copy');
  ok(/\/join\/[A-Z0-9]{6}$/.test(joinLink), 'class card has a "Copy join link" button (' + joinLink.replace(BASE, '') + ')');
  await teacher.goto(BASE + '/teacher#exams'); await teacher.waitForSelector('[data-copylink]');
  ok(await teacher.isVisible('[data-copylink]'), 'exam list has a "Copy link" button');
  const newbie = await newUser();
  await newbie.goto(joinLink);
  await newbie.waitForURL(/\?next=/);
  ok(await newbie.isVisible('.note:has-text("Joining a class?")'), 'join link asks a signed-out student to sign in or create an account');
  await newbie.click('#tabUp');
  await newbie.fill('#upName', 'Nina Reyes'); await newbie.fill('#upEmail', 'nina@student.edu'); await newbie.fill('#upPass', 'student-pass-7');
  await newbie.click('#signUp button[type=submit]');
  await newbie.waitForURL(/\/student/);
  ok(await toastSays(newbie, 'You joined'), 'after signing up, the student is in the class (from the join link)');
  const ninaIn = await dbOne(`SELECT count(*)::int AS n FROM enrollments e JOIN users u ON u.id = e.student_id WHERE u.email = 'nina@student.edu'`);
  ok(ninaIn.n === 1, 'enrollment saved');

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
  await phone.waitForSelector('#signIn');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'home page fits a phone screen');
  await shot(phone, '01b-home-phone');
  await phone.fill('#inEmail', 'juan@student.edu'); await phone.fill('#inPass', 'student-pass-1'); await phone.click('#signIn button[type=submit]');
  await phone.waitForSelector('.item');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'student dashboard fits a phone screen');
  await shot(phone, '12-phone-dashboard');

  // ── Deleting a folder never deletes questions ──
  await teacher.goto(BASE + '/teacher#questions');
  await teacher.waitForSelector('.folder:has-text("Circuits")');
  const qBefore = (await dbOne(`SELECT count(*)::int AS n FROM questions WHERE teacher_id = (SELECT id FROM users WHERE email = 'maria@school.edu')`)).n;
  await teacher.click('.folder:has-text("Circuits")'); await teacher.click('#delFolder'); await teacher.click('.dialog .btn.danger');
  ok(await toastSays(teacher, 'Folder deleted'), 'folder deleted');
  const after = await dbOne(`SELECT (SELECT count(*) FROM questions WHERE teacher_id = (SELECT id FROM users WHERE email = 'maria@school.edu'))::int AS q,
    (SELECT parent_id FROM question_folders WHERE name = 'Units') AS parent`);
  ok(after.q === qBefore && after.parent === null && (await folderOf('Q004')) === 'Units' && (await folderOf('H-1')) === null, 'questions kept; subfolder moved up');

  // ── Admins: promote a teacher, create a new admin, owner protection ──
  await admin.goto(BASE + '/admin#admins');
  await admin.waitForSelector('#addAdmin');
  ok((await admin.textContent('#view')).includes('Site owner'), 'owner is marked on the Admins page');
  await admin.click('#addAdmin');
  await admin.fill('#adEmail', 'maria@school.edu');
  await admin.click('.dialog .btn.primary');
  ok(await toastSays(admin, 'Maria Santos is now an admin'), 'existing teacher promoted to admin');
  ok((await dbOne(`SELECT role FROM users WHERE email = 'maria@school.edu'`)).role === 'admin', 'role saved');
  ok((await dbOne(`SELECT count(*)::int AS n FROM exams WHERE title = 'EEE 150 Quiz 1'`)).n === 1, "promoted teacher keeps their exams");
  await admin.click('#addAdmin');
  await admin.fill('#adEmail', 'helper@test.local'); await admin.fill('#adName', 'Helper Admin');
  await admin.click('.dialog .btn.primary');
  await admin.waitForSelector('.dialog .code-box');
  const temp = (await admin.textContent('.dialog .code-box')).trim();
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(temp), 'new admin created with a temporary password');
  await shot(admin, '12c-admins');
  await admin.click('.dialog .btn.primary');
  const helper = await newUser();
  await helper.goto(BASE + '/');
  await helper.fill('#inEmail', 'helper@test.local'); await helper.fill('#inPass', temp); await helper.click('#signIn button[type=submit]');
  await helper.waitForURL(/\/admin/);
  ok(true, 'new admin signs in to the admin console');
  const ownerId = (await dbOne(`SELECT id FROM users WHERE email = 'admin@test.local'`)).id;
  const post = (path, body) => helper.evaluate(async ([pth, b]) => (await (await fetch(pth, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json()).code, [path, body]);
  ok(await post('/api/admin/admins/' + ownerId + '/remove', {}) === 'OWNER', "another admin cannot remove the owner's rights");
  ok(await post('/api/admin/users/' + ownerId, { disabled: true }) === 'OWNER', 'another admin cannot disable the owner');
  ok(await post('/api/admin/users/' + ownerId + '/reset-password', {}) === 'OWNER_ONLY', "another admin cannot reset the owner's password");
  const helperId = (await dbOne(`SELECT id FROM users WHERE email = 'helper@test.local'`)).id;
  ok(await post('/api/admin/admins/' + helperId + '/remove', {}) === 'BAD_INPUT', 'an admin cannot remove their own rights');
  await admin.goto(BASE + '/admin#admins');
  await admin.waitForSelector('tr:has-text("maria@school.edu") [data-demote]');
  await admin.click('tr:has-text("maria@school.edu") [data-demote]');
  await admin.click('.dialog .btn.danger');
  ok(await toastSays(admin, 'no longer an admin'), 'owner removes admin rights');
  ok((await dbOne(`SELECT role FROM users WHERE email = 'maria@school.edu'`)).role === 'teacher', 'back to teacher');

  // ── Admin deletes users ──
  await admin.goto(BASE + '/admin#teachers');
  await admin.waitForSelector('tr:has-text("pedro@school.edu") [data-delete]');
  await shot(admin, '12b-admin-teachers');
  await admin.click('tr:has-text("pedro@school.edu") [data-delete]');
  await admin.waitForSelector('.dialog #delEmail');
  const impact = await admin.textContent('.dialog .note.bad');
  ok(impact.includes('1 class') && impact.includes('1 exam') && impact.includes('1 question'), 'delete shows what will be removed: ' + impact.replace(/\s+/g, ' ').trim());
  await shot(admin, '13-delete-user');
  await admin.fill('#delEmail', 'wrong@school.edu');
  await admin.click('.dialog .btn.danger');
  ok(await toastSays(admin, 'Type the user'), 'wrong email does not delete');
  await admin.fill('#delEmail', 'pedro@school.edu');
  await admin.click('.dialog .btn.danger');
  ok(await toastSays(admin, 'was deleted'), 'teacher deleted');
  const left = await dbOne(`SELECT (SELECT count(*) FROM users WHERE email = 'pedro@school.edu')::int AS u,
    (SELECT count(*) FROM exams WHERE title = 'Physics quiz')::int AS x, (SELECT count(*) FROM classes WHERE name = 'Physics')::int AS c`);
  ok(left.u === 0 && left.x === 0 && left.c === 0, 'teacher, their class and exam are gone');
  await admin.goto(BASE + '/admin#students');
  await admin.waitForSelector('tr:has-text("juan@student.edu") [data-delete]');
  await admin.click('tr:has-text("juan@student.edu") [data-delete]');
  await admin.waitForSelector('.dialog #delEmail');
  const juanAttempts = Number((await dbOne(`SELECT count(*)::int AS n FROM attempts a JOIN users u ON u.id = a.student_id WHERE u.email = 'juan@student.edu'`)).n);
  ok((await admin.textContent('.dialog .note.bad')).includes(juanAttempts + ' exam attempts'), 'student delete lists their attempts (' + juanAttempts + ')');
  await admin.fill('#delEmail', 'JUAN@student.edu');
  await admin.click('.dialog .btn.danger');
  ok(await toastSays(admin, 'was deleted'), 'student deleted');
  for (let i = 0; i < 50 && (await dbOne(`SELECT count(*)::int AS n FROM users WHERE email = 'juan@student.edu'`)).n; i++) await sleep(100);
  ok((await dbOne(`SELECT count(*)::int AS n FROM attempts`)).n === 0, "student's attempts removed");
  const selfDel = await admin.evaluate(async () => {
    const me = (await (await fetch('/api/auth/me')).json()).user;
    return (await (await fetch('/api/admin/users/' + me.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ confirmEmail: me.email }) })).json()).error;
  });
  ok(/own account/.test(selfDel || ''), 'admin cannot delete their own account');
  ok((await phone.evaluate(async () => (await fetch('/api/student/dashboard')).status)) === 401, "deleted student's session no longer works");

  ok(errors.length === 0, 'no browser errors ' + errors.join(' | '));
  await browser.close(); server.close(); await db.close();
  console.log('Screenshots: ' + SHOTS);
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
