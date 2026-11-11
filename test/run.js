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
  await student.waitForSelector('#startbox .score');
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

  // ── Camera snapshot as proof ──
  const camExam = await teacher.evaluate(async () => {
    const post = async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })).json();
    const cls = (await (await fetch('/api/teacher/classes')).json()).classes[0];
    const q = (await (await fetch('/api/teacher/questions')).json()).questions.find((x) => x.type === 'TF');
    const x = (await post('/api/teacher/exams', { classId: cls.id, title: 'Camera quiz', questionIds: [q.id], faceMode: 'ALWAYS', timeLimitMinutes: 10,
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
  await teacher.click('.folder:has-text("Circuits")'); await teacher.click('#delFolder'); await teacher.click('.dialog .btn.danger');
  ok(await toastSays(teacher, 'Folder deleted'), 'folder deleted');
  const after = await dbOne(`SELECT (SELECT count(*) FROM questions WHERE teacher_id = (SELECT id FROM users WHERE email = 'maria@school.edu'))::int AS q,
    (SELECT parent_id FROM question_folders WHERE name = 'Units') AS parent`);
  ok(after.q === 6 && after.parent === null && (await folderOf('Q004')) === 'Units' && (await folderOf('H-1')) === null, 'questions kept; subfolder moved up');

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
  ok((await admin.textContent('.dialog .note.bad')).includes('3 exam attempts'), 'student delete lists their attempts');
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
