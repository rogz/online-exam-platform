// Online Exam website — start with `npm start`.
// Settings come from environment variables (see README):
//   DATABASE_URL   PostgreSQL connection (leave empty to use the built-in database in ./data)
//   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME   the site owner's account (created on first start)
//   PORT           web port (default 3000)
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
  api.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
  app.use('/api', api);

  // Pages
  const pub = path.join(__dirname, 'public');
  const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
  app.get('/', page('index.html'));
  app.get('/student', page('student.html'));
  app.get('/teacher', page('teacher.html'));
  app.get('/admin', page('admin.html'));
  app.get('/exam', page('exam/index.html'));
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
  createApp().listen(port, () => console.log(`Online Exam running on http://localhost:${port} (database: ${db.kind})`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp, ensureAdmin };
