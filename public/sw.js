/* Exam Wizard offline helper (service worker).
 * Only for offline exams: when a student downloads an exam, the exam page, its files, the camera checker and the
 * question pictures are kept in this browser. With internet, everything is loaded fresh from the site as usual
 * (network first); only when there is no internet are the kept copies used.
 */
const CACHE = 'exam-wizard-offline-v1';
const CACHE_SHELL = ['/exam', '/offline', '/exam/app.js', '/exam/camera.js', '/exam/styles.css', '/exam/qtext.js', '/assets/theme-mode.js', '/favicon.svg', '/vendor/qrcode.js',
  '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css'].concat([ // math in questions (KaTeX) and its fonts
  'KaTeX_AMS-Regular.woff2', 'KaTeX_Caligraphic-Bold.woff2', 'KaTeX_Caligraphic-Regular.woff2', 'KaTeX_Fraktur-Bold.woff2', 'KaTeX_Fraktur-Regular.woff2', 'KaTeX_Main-Bold.woff2', 'KaTeX_Main-BoldItalic.woff2', 'KaTeX_Main-Italic.woff2', 'KaTeX_Main-Regular.woff2', 'KaTeX_Math-BoldItalic.woff2', 'KaTeX_Math-Italic.woff2', 'KaTeX_SansSerif-Bold.woff2', 'KaTeX_SansSerif-Italic.woff2', 'KaTeX_SansSerif-Regular.woff2', 'KaTeX_Script-Regular.woff2', 'KaTeX_Size1-Regular.woff2', 'KaTeX_Size2-Regular.woff2', 'KaTeX_Size3-Regular.woff2', 'KaTeX_Size4-Regular.woff2', 'KaTeX_Typewriter-Regular.woff2'].map((f) => '/vendor/katex/fonts/' + f));
const SHELL = CACHE_SHELL;

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

/** The page asks us to keep files (the exam page and its files, camera files, pictures). */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'keep') return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const results = [];
    for (const item of [].concat(SHELL.map((u) => ({ url: u })), d.items || [])) {
      try {
        const opaque = !!item.noCors;
        const res = await fetch(item.url, opaque ? { mode: 'no-cors' } : { cache: 'no-store', credentials: 'same-origin' });
        if (!opaque && !res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(item.url, res);
        results.push({ url: item.url, ok: true });
      } catch (err) { results.push({ url: item.url, ok: false, error: String(err && err.message || err) }); }
    }
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ results });
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (same && url.pathname.startsWith('/api/')) return; // data always comes from the site
  if (same && req.mode === 'navigate') {
    // /exam?id=… and /offline: the site first; without internet, the kept page
    if (url.pathname === '/student') { // My Exams needs internet; without it, show the exams downloaded here
      e.respondWith(fetch(req).catch(async () => (await caches.match('/offline')) || Response.error()));
      return;
    }
    if (url.pathname !== '/exam' && url.pathname !== '/offline' && url.pathname !== '/collect') return;
    e.respondWith(fetch(req).catch(async () => (await caches.match(url.pathname)) || Response.error()));
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = same ? url.pathname : req.url;
    if (same) {
      try { return await fetch(req); } catch (err) { const hit = await cache.match(key); if (hit) return hit; throw err; }
    }
    const hit = await cache.match(key);
    if (hit) return hit; // camera files and pictures don't change: use the kept copy
    return fetch(req);
  })());
});
