/* Collect answers by QR code (public/collect.html).
 * /collect?exam=ID  for the signed-in teacher;  /collect?t=TOKEN  for a helper (collector link).
 * Reads the QR codes of finished offline exams (format: src/routes/collect.js), keeps them on this phone and sends them
 * to the site whenever there is internet.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const token = qs.get('t') || '', examId = qs.get('exam') || '';
  const key = token ? 't:' + token.slice(0, 12) : 'e:' + examId;
  const QKEY = 'collect-queue:' + key, IKEY = 'collect-info:' + key;
  const who = token ? { token } : { examId };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  let queue = load(QKEY, []);
  const parts = {}; // first 8 of the package id → pieces received so far
  let sending = false;

  async function api(path, body) {
    let res;
    try {
      res = await fetch('/api/collect' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(Object.assign({}, who, body)), credentials: 'same-origin' });
    } catch (e) { const err = new Error('No internet'); err.code = 'NETWORK'; throw err; }
    const data = await res.json().catch(() => ({ ok: false, error: 'Unexpected answer from the site.' }));
    if (!data.ok) { const err = new Error(data.error || 'Something went wrong.'); err.code = data.code; throw err; }
    return data;
  }

  function save() { try { localStorage.setItem(QKEY, JSON.stringify(queue)); } catch (e) { /* full */ } }

  function draw() {
    const sent = queue.filter((q) => q.status === 'sent').length, wait = queue.filter((q) => q.status === 'wait').length;
    $('cScanned').textContent = queue.length + ' scanned';
    $('cSent').textContent = sent + ' received';
    $('cWait').textContent = wait + ' waiting for internet';
    $('list').innerHTML = queue.slice().reverse().map((q) => {
      const r = q.result || {};
      const name = r.student ? esc(r.student.name) + (r.student.studentNo ? ' <span class="muted">(' + esc(r.student.studentNo) + ')</span>' : '') : 'Student (not sent yet)';
      const state = q.status === 'sent' ? '<span class="ok">✓ ' + (r.already ? 'Already received' : r.status === 'VOIDED' ? 'Received (voided)' : 'Received') +
          (r.score !== undefined ? ' · ' + r.score + ' / ' + r.maxScore : '') + (r.receiptOk === false ? ' · ⚠ check' : '') + '</span>'
        : q.status === 'wait' ? '<span class="wait">⏳ Waiting for internet</span>' : '<span class="bad">✗ ' + esc(q.error || 'Not accepted') + '</span>';
      return '<li><span>' + name + '<br><span class="small muted">Receipt ' + esc(q.receipt || '?') + ' · ' + new Date(q.at).toLocaleTimeString() + '</span></span>' + state + '</li>';
    }).join('');
  }

  async function sendAll() {
    if (sending) return;
    sending = true;
    try {
      for (const q of queue.filter((x) => x.status === 'wait')) {
        try { q.result = await api('', { payload: q.text }); q.status = 'sent'; }
        catch (e) { if (e.code === 'NETWORK') break; q.status = 'error'; q.error = e.message; }
        save(); draw();
      }
    } finally { sending = false; }
  }

  function beep() {
    try { if (navigator.vibrate) navigator.vibrate(120); const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); o.frequency.value = 880; o.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 120); } catch (e) { /* no sound */ }
  }

  /** One QR code was read. Returns a short status for the screen (also used by the tests). */
  function handleText(text) {
    const m = /^EWQ\|(\d+)\|(\d+)\|([0-9a-f]{8})\|([\s\S]*)$/.exec(String(text || ''));
    if (!m) { $('status').textContent = 'That QR code is not from an Exam Wizard offline exam.'; return 'not ours'; }
    const i = Number(m[1]), n = Number(m[2]), id8 = m[3];
    const p = parts[id8] = parts[id8] || { n, pieces: {} };
    p.pieces[i] = m[4];
    const have = Object.keys(p.pieces).length;
    if (have < n) { $('status').textContent = 'Code ' + have + ' of ' + n + ' read. Keep pointing at the screen…'; return 'part'; }
    const full = Array.from({ length: n }, (_, k) => p.pieces[k + 1]).join('');
    delete parts[id8];
    if (queue.some((q) => q.text === full)) { $('status').textContent = 'Already scanned.'; return 'again'; }
    const receipt = (full.split('~')[4] || '');
    queue.push({ text: full, at: Date.now(), status: 'wait', receipt });
    save(); draw(); beep();
    $('status').textContent = '✓ Scanned (receipt ' + receipt + '). Next student!';
    $('wrap').classList.add('hit'); setTimeout(() => $('wrap').classList.remove('hit'), 600);
    sendAll();
    return 'done';
  }

  // ── camera ──
  let detector = null, canvas = null, ctx = null, last = '', lastAt = 0;
  async function startCamera() {
    $('err').hidden = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      const v = $('video'); v.srcObject = stream; await v.play();
      $('startCam').hidden = true;
      if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
      $('status').textContent = 'Point the camera at the QR code on the student\'s screen.';
      loop();
    } catch (e) {
      $('err').hidden = false;
      $('err').textContent = 'The camera could not start: allow the camera for this site (camera icon in the address bar), then try again.';
    }
  }
  async function loop() {
    const v = $('video');
    let text = null;
    try {
      if (detector) {
        const codes = await detector.detect(v);
        if (codes.length) text = codes[0].rawValue;
      } else if (window.jsQR && v.videoWidth) {
        const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
        if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
        canvas.width = w; canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (r) text = r.binaryData && r.binaryData.length ? new TextDecoder('utf-8').decode(new Uint8Array(r.binaryData)) : r.data;
      }
    } catch (e) { /* keep trying */ }
    if (text && (text !== last || Date.now() - lastAt > 3000)) { last = text; lastAt = Date.now(); handleText(text); }
    setTimeout(loop, 200);
  }

  async function boot() {
    $('startCam').onclick = startCamera;
    window.addEventListener('online', sendAll);
    setInterval(sendAll, 15000);
    draw();
    let info = load(IKEY, null);
    try {
      info = await api('/info', {});
      try { localStorage.setItem(IKEY, JSON.stringify(info)); } catch (e) { /* ignore */ }
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then((reg) => {
          (reg.active || navigator.serviceWorker.controller).postMessage({ type: 'keep', items: [{ url: '/collect' }, { url: '/assets/collect.js' }, { url: '/vendor/jsqr.js' }] });
        }).catch(() => {});
      }
    } catch (e) {
      if (e.code !== 'NETWORK') { $('err').hidden = false; $('err').textContent = e.message; $('startCam').hidden = true; return; }
    }
    if (info) {
      $('title').textContent = 'Collect answers: ' + info.exam.title;
      $('sub').textContent = (info.helper ? 'Helper link' + (info.label ? ' for ' + info.label : '') + (info.until ? ', valid until ' + new Date(info.until).toLocaleString() : '') + '. ' : '') +
        'Scan the QR code on each student\'s screen after they finish.';
    }
    sendAll();
  }

  window.EWCollect = { handleText, queue: () => queue };
  boot();
})();
