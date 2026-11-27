// Online Exam website — start with `npm start`.
// Settings come from environment variables (see README):
//   DATABASE_URL   PostgreSQL connection (leave empty to use the built-in database in ./data)
//   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME   the site owner's account (created on first start)
//   PORT           web port (default 3000)
//   HOST           address to listen on (default: all; 127.0.0.1 when behind nginx)
const path = require('path');
const express = require('express');
const db = require('./src/db');
const auth = require('./src/auth');
const { HttpError } = require('./src/util');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render / a load balancer: needed for secure cookies
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Asked by the deploy script on the server itself before an update: wait while students are taking an exam,
  // and don't update while the owner has paused updates (Admin → Site settings). Not reachable from outside.
  app.get('/deploy-check', async (req, res, next) => {
    try {
      const ip = req.socket.remoteAddress || '';
      if (req.get('X-Forwarded-For') || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(404).json({ ok: false });
      const s = await require('./src/settings').getSettings();
      const active = (await db.one(`SELECT count(*)::int AS n FROM attempts WHERE status = 'IN_PROGRESS' AND last_seen > now() - interval '10 minutes'`)).n;
      res.json({ ok: true, paused: !!s.updatesPaused, busy: active > 0, activeAttempts: active });
    } catch (e) { next(e); }
  });

  // API
  const api = express.Router();
  api.use(auth.loadUser);
  api.use('/attempt', require('./src/routes/attempt')); // has its own body parsing (sendBeacon support)
  api.use(express.json({ limit: '1mb' }));
  api.use(auth.sameSiteOnly);
  api.use('/auth', require('./src/routes/auth'));
  api.use('/admin', require('./src/routes/admin'));
  api.use('/teacher', require('./src/routes/teacher'));
  api.use('/student', require('./src/routes/student'));
  api.use('/collect', require('./src/routes/collect')); // QR hand-in: signed-in teachers, or helpers with a collector link
  api.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
  app.use('/api', api);

  // Pages
  const pub = path.join(__dirname, 'public');
  // The site name goes into the page title here, so the tab never shows "{site}" while the page loads.
  const fs = require('fs');
  const { getSettings } = require('./src/settings');
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const page = (file) => async (req, res, next) => {
    try {
      const html = await fs.promises.readFile(path.join(pub, file), 'utf8');
      let name = 'Exam Wizard';
      try { name = (await getSettings()).siteName || name; } catch (e) { /* database not ready: use the default */ }
      res.set('Cache-Control', 'no-cache').type('html').send(html.replace(/\{site\}/g, escHtml(name)));
    } catch (e) { next(e); }
  };
  // Signed in? Go straight to your own page instead of flashing the sign-in page.
  // (The database is only asked when a sign-in cookie is present.)
  const home = (u) => (u.role === 'student' ? '/student' : u.role === 'admin' ? '/admin' : '/teacher');
  app.get(['/', '/index.html'], auth.loadUser, (req, res, next) => {
    if (!req.user) return next();
    const nx = String(req.query.next || '');
    res.redirect(302, nx.startsWith('/') && !nx.startsWith('//') ? nx : home(req.user));
  }, page('index.html'));
  app.get('/student', page('student.html'));
  app.get('/teacher', page('teacher.html'));
  app.get('/admin', page('admin.html'));
  // Strict exams: opened in Safe Exam Browser, the exam page remembers it (a signed cookie for that exam; no database)
  const seb = require('./src/seb');
  app.get('/exam', (req, res, next) => { if (/^[0-9a-f-]{36}$/i.test(String(req.query.id || ''))) seb.rememberPage(req, res, String(req.query.id).toLowerCase()); next(); },
    page('exam/index.html'));
  app.get('/seb/:file', (req, res) => {
    const m = /^([0-9a-f-]{36}|check)\.seb$/i.exec(req.params.file);
    if (!m) return res.status(404).type('text').send('Not found.');
    res.set('Cache-Control', 'no-store').type('application/seb').set('Content-Disposition', 'attachment; filename="exam.seb"')
      .send(seb.plist(seb.settings(seb.baseUrl(req), m[1].toLowerCase())));
  });
  // A test page to open in Safe Exam Browser before the exam day: is it working, and does the camera work in it?
  app.get('/seb-check', async (req, res, next) => {
    try {
      const html = await fs.promises.readFile(path.join(pub, 'seb-check.html'), 'utf8');
      const info = { level: seb.check(req, 'check'), sebAgent: seb.isSebAgent(req.get('user-agent')), keyHeader: !!req.get('x-safeexambrowser-configkeyhash'),
        userAgent: String(req.get('user-agent') || '').slice(0, 300) };
      res.set('Cache-Control', 'no-store').type('html').send(html.replace('/*SEB_INFO*/null', JSON.stringify(info).replace(/</g, '\\u003c')));
    } catch (e) { next(e); }
  });
  app.get('/seb-quit', (req, res) => res.type('html').send('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Done</title><body style="font:16px system-ui;padding:40px;text-align:center"><p>You can close Safe Exam Browser now.</p></body>'));
  app.get('/preview', page('exam/preview.html'));
  app.get('/reset', page('reset.html'));
  app.get('/join/:code', page('join.html'));
  app.get('/manual', page('manual/index.html'));
  app.get('/offline', page('offline.html'));
  app.get('/collect', page('collect.html'));
  // no-cache: browsers keep a copy but check for a newer one each time, so updates show up at once
  app.use(express.static(pub, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  // Errors → JSON for the API, plain text otherwise
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on the server. Please try again.' :
      err.type === 'entity.too.large' ? 'That is too large to upload.' : err.message;
    if (req.originalUrl.startsWith('/api')) return res.status(status).json({ ok: false, code: err.code || 'ERROR', error: message });
    res.status(status).type('text').send(message);
  });
  return app;
}

/** Creates or promotes the site owner's account from ADMIN_EMAIL / ADMIN_PASSWORD. */
async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const existing = await db.one('SELECT id, role FROM users WHERE email = $1', [email]);
  if (existing) {
    if (existing.role !== 'admin') await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [existing.id]);
    return;
  }
  if (!process.env.ADMIN_PASSWORD) { console.warn('ADMIN_EMAIL is set but ADMIN_PASSWORD is not: no admin account created.'); return; }
  await db.query(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`,
    [email, await auth.hashPassword(process.env.ADMIN_PASSWORD), process.env.ADMIN_NAME || 'Site Admin']);
  console.log('Admin account created for ' + email);
}

async function main() {
  await db.connect();
  await ensureAdmin();
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || undefined; // e.g. 127.0.0.1 behind nginx: not reachable from outside
  createApp().listen(port, host, () => console.log(`Online Exam running on http://${host || 'localhost'}:${port} (database: ${db.kind})`));
  require('./src/backup').startNightly();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp, ensureAdmin };
