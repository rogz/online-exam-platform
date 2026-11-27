(async function () {
  'use strict';
  const { $, esc, api, toast, dialog } = App;
  const me = await App.requireRole(['student']);
  App.renderTopbar(me.user, me.site, [{ href: '/student', label: 'My Exams', on: true }]);

  let data = { exams: [], classes: [] };
  let offset = 0; // server clock − our clock
  let selected = null;
  try { selected = sessionStorage.getItem('selectedExam'); } catch (e) { /* ignore */ }

  const GROUPS = [
    ['inprogress', 'In progress'], ['open', 'Open now'], ['upcoming', 'Upcoming'], ['completed', 'Completed'], ['expired', 'Expired'],
  ];
  const ICON = {
    lock: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9zm3 3a2 2 0 0 1 1 3.7V19h-2v-2.3A2 2 0 0 1 12 13z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    nocamera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/><path d="M2 2l20 20"/></svg>',
    nav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h14l-4-4M20 16H6l4 4"/></svg>',
    forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 19h16"/></svg>',
  };

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)); const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; const p = (n) => String(n).padStart(2, '0');
    return (d ? d + (d === 1 ? ' day ' : ' days ') : '') + (h || d ? h + ':' + p(m) : p(m)) + ':' + p(sec);
  }
  const minutes = (m) => (m >= 60 ? (Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + Math.round(m % 60) + ' min' : '')) : Math.round(m * 10) / 10 + ' min');

  try { const w = sessionStorage.getItem('welcome'); if (w) { setTimeout(() => App.toast(w), 400); sessionStorage.removeItem('welcome'); } } catch (e) { /* ignore */ }

  async function load() {
    try {
      data = await api('/student/dashboard');
      offset = data.serverNow - Date.now();
      renderList(); renderClasses();
      if (!data.exams.some((x) => x.id === selected)) {
        const first = GROUPS.map((g) => data.exams.find((x) => x.state === g[0])).find(Boolean);
        selected = first ? first.id : null;
      }
      renderDetail();
    } catch (e) { toast(e.message, true); }
  }

  function subline(x) {
    if (x.state === 'inprogress') return 'In progress — resume now';
    if (x.state === 'open') return x.endAt ? 'Open until ' + App.fmtDate(x.endAt) : 'Open now';
    if (x.state === 'upcoming') return 'Opens ' + App.fmtDate(x.startAt);
    if (x.state === 'expired') return 'Closed ' + App.fmtDate(x.endAt);
    const a = x.attempt || {};
    if (a.status === 'SUBMITTED') return 'Submitted ' + App.fmtDate(a.submittedAt) + (a.percent !== null && a.percent !== undefined ? ' — ' + a.percent + '%' : '');
    if (a.status === 'VOIDED') return 'Voided';
    return 'Time ran out';
  }
  function mark(x) {
    if (x.state === 'completed') return x.attempt && x.attempt.status === 'SUBMITTED' ? '<span class="mark ok" title="Submitted">✓</span>' : '<span class="mark bad" title="Not submitted">✕</span>';
    if (x.state === 'inprogress' || x.state === 'open') return '<span class="mark live" title="Open">●</span>';
    return '';
  }

  function renderList() {
    const el = $('#list');
    if (!data.classes.length) {
      el.innerHTML = '<div class="empty">You haven\'t joined any classes yet.<br><br><button type="button" class="btn primary" id="joinBig">Join your first class</button></div>';
      $('#joinBig').onclick = joinClass;
      return;
    }
    el.innerHTML = GROUPS.map(([state, label]) => {
      const items = data.exams.filter((x) => x.state === state);
      if (!items.length) return '';
      return `<section class="group"><h2>${label}</h2>${items.map((x) => `<button type="button" class="item${x.id === selected ? ' on' : ''}" data-id="${esc(x.id)}">
        <div><b>${esc(x.title)}</b>${x.offline ? ' <span class="offtag">📥 Offline exam</span>' : ''}<span>${esc(x.className)}</span><span>${esc(subline(x))}</span></div>${mark(x)}</button>`).join('')}</section>`;
    }).join('') || '<div class="empty">No exams yet. Your teachers\' exams will appear here when they are published.</div>';
    el.querySelectorAll('.item').forEach((b) => b.addEventListener('click', () => {
      selected = b.dataset.id;
      try { sessionStorage.setItem('selectedExam', selected); } catch (e) { /* ignore */ }
      renderList(); renderDetail();
      if (window.innerWidth <= 820) $('#detail').scrollIntoView({ behavior: 'smooth' });
    }));
  }

  function renderClasses() {
    $('#classList').innerHTML = data.classes.length ? data.classes.map((c) => `<li><span>${esc(c.name)}${c.section ? ' — ' + esc(c.section) : ''} <span class="muted">(${esc(c.teacher_name)})</span></span>
      <button type="button" class="linkbtn small" data-leave="${esc(c.id)}">Leave</button></li>`).join('') : '<li class="muted">None yet</li>';
    $('#classList').querySelectorAll('[data-leave]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await App.confirmBox('Leave class?', 'You will no longer see this class\'s exams. You can join again with the class code.', 'Leave class', true))) return;
      await api('/student/leave', { classId: b.dataset.leave }); load();
    }));
  }

  function renderDetail() {
    const el = $('#detail');
    const x = data.exams.find((e) => e.id === selected);
    if (!x) {
      el.innerHTML = data.classes.length
        ? '<div class="empty">Choose an exam from the list.</div>'
        : `<div class="startbox"><h1>Welcome, ${esc(me.user.name)}</h1><p>Join your class with the <b>class code</b> your teacher gave you. Your exams will then appear on the left.</p><button type="button" class="btn primary big" id="joinBig2">Join a class</button></div>`;
      const j = $('#joinBig2'); if (j) j.onclick = joinClass;
      return;
    }
    const nav = x.displayMode === 'ONE'
      ? (x.questionSeconds ? ['forward', x.questionSeconds + ' s per question'] : x.allowBack ? ['nav', 'One at a time'] : ['forward', 'No going back'])
      : ['nav', 'Navigate freely'];
    const tiles = [
      ...(x.offline ? [['download', 'Offline exam']] : []),
      ['lock', 'Secure'],
      ['clock', x.timeLimitMinutes ? minutes(x.timeLimitMinutes) : 'No time limit'],
      [x.faceMode === 'OFF' ? 'nocamera' : 'camera', x.faceMode === 'ALWAYS' ? 'Camera on' : x.faceMode === 'START' ? 'Face check' : 'No camera'],
      nav,
      ['device', x.allowedDevices === 'ANY' ? 'Any device' : x.allowedDevices === 'TABLET' ? 'Computer or tablet' : 'Computer only'],
    ];
    if (x.requiresPassword) tiles.push(['key', 'Password']);
    el.innerHTML = `<h1>${esc(x.title)}</h1>
      <p class="sub">${esc(x.className)} · ${esc(x.teacherName)}</p>
      ${x.offline && ['open', 'upcoming', 'inprogress'].includes(x.state) ? '<div class="offbox" id="offbox"></div>' : ''}
      <div class="startbox" id="startbox"></div>
      ${x.instructions ? '<h2>Instructions</h2><p class="instructions">' + esc(x.instructions) + '</p>' : ''}
      <h2>Exam settings</h2>
      <div class="tiles">${tiles.map((t) => `<div class="tile">${ICON[t[0]]}${esc(t[1])}</div>`).join('')}</div>
      <div class="two">
        <div><h2>Exam details</h2><table class="kv"><tbody>
          <tr><td>Questions</td><td>${x.questionCount}</td></tr>
          <tr><td>Opens</td><td>${x.startAt ? esc(App.fmtDate(x.startAt)) : 'Now'}</td></tr>
          <tr><td>Closes</td><td>${x.endAt ? esc(App.fmtDate(x.endAt)) : '—'}</td></tr>
          <tr><td>Time limit</td><td>${x.timeLimitMinutes ? esc(minutes(x.timeLimitMinutes)) : 'None'}</td></tr>
        </tbody></table></div>
        <div><h2>Exam rules</h2><table class="kv"><tbody>
          <tr><td>Switching tabs or apps</td><td>${x.focusWarnings ? x.focusWarnings + ' warning' + (x.focusWarnings === 1 ? '' : 's') + ', then voids exam' : 'Voids exam'}</td></tr>
          <tr><td>Copy &amp; paste</td><td>${x.blockCopyPaste ? 'OFF' : 'ON'}</td></tr>
          <tr><td>Reconnect after lost internet</td><td>${x.reconnectSeconds ? esc(minutes(x.reconnectSeconds / 60)) : 'Not allowed'}</td></tr>
          <tr><td>Score shown after submitting</td><td>${x.showScore ? 'Yes' : 'No'}</td></tr>
        </tbody></table></div>
      </div>`;
    renderStartbox(x);
    renderOffbox(x);
    const pb = $('#printResult'); if (pb) pb.onclick = () => printResult(x);
  }

  /** Offline exam: tell the student before they start, and let them download it on this device. */
  async function renderOffbox(x) {
    const box = $('#offbox');
    if (!box) return;
    const here = await downloadedHere(x.id);
    const url = '/exam?id=' + encodeURIComponent(x.id);
    if (here) {
      box.className = 'offbox ready';
      box.innerHTML = `<b>✓ Downloaded on this device</b> <span class="muted small">(${esc(App.fmtDate(here.downloadedAt))})</span>
        <p>This exam works <b>without internet</b>. On exam day open it here (in this browser) and type the password your teacher gives you in the room.
        If you have no internet then, open <b>${esc(location.host)}/offline</b> (or your bookmark).</p>
        <a class="btn primary" href="${url}">Open exam</a>`;
      const sb = $('#startbox .btn.primary'); if (sb) sb.textContent = 'Open exam';
    } else {
      box.className = 'offbox';
      box.innerHTML = `<b>📥 Offline exam</b>: for rooms with weak or no internet.
        <p>Download it <b>now, while you have internet</b>, on the device you will use for the exam. It stays locked until your teacher gives the password in the room.
        ${x.downloadedAt ? '<br><span class="small muted">You downloaded it on another device (' + esc(App.fmtDate(x.downloadedAt)) + '). Use that device, or download it here too.</span>' : ''}</p>
        <a class="btn primary" href="${url}&download=1">📥 Download for offline</a>`;
      // the online start becomes the second choice
      const sb = $('#startbox .btn.primary');
      if (sb && x.state === 'open') { sb.classList.remove('primary', 'big'); sb.textContent = 'Start online now'; }
      const hint = $('#startbox .hint');
      if (hint && x.state === 'open') hint.textContent = 'With good internet you can also take it online now. Once it starts, switching tabs or apps will void it.';
    }
  }

  /** Was this exam downloaded in this browser? (kept by the exam page in IndexedDB) */
  function downloadedHere(examId) {
    return new Promise((resolve) => {
      try {
        const r = indexedDB.open('exam-wizard', 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('packages')) d.createObjectStore('packages'); if (!d.objectStoreNames.contains('snaps')) d.createObjectStore('snaps', { autoIncrement: true }); };
        r.onerror = () => resolve(null);
        r.onsuccess = () => {
          const g = r.result.transaction('packages', 'readonly').objectStore('packages').get(examId);
          g.onsuccess = () => resolve(g.result || null);
          g.onerror = () => resolve(null);
        };
      } catch (e) { resolve(null); }
    });
  }

  /** The results report: the score in big type, and the class statistics with the rank (when the teacher shows them). */
  function reportHtml(x, a) {
    const k = a.rank;
    const stats = k ? `<div class="statline">Mean = ${k.mean}% · Median = ${k.median}% · StdDev = ${k.sd} · <b>Rank = ${k.rank}/${k.total}</b> · Percentile rank = ${k.percentile}</div>
      ${k.current ? '<div class="small muted">Current: these change while classmates are still taking the exam or being graded.</div>' : ''}` : '';
    return `<div class="report"><div class="scorebox"><div class="pct">${Number(a.percent).toFixed(2)}%</div><div>My score · ${a.score} / ${a.maxScore}</div></div>${stats}</div>`;
  }

  function printResult(x) {
    const a = x.attempt, k = a.rank, w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for this site to print.', true); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Result: ${esc(x.title)}</title><style>
      body { font: 15px/1.5 Arial, sans-serif; color: #111; margin: 16mm; } .top { display: flex; justify-content: space-between; gap: 20px; }
      .brand { font-weight: 700; font-size: 20px; color: #23558c; } .who { text-align: right; }
      h1 { text-align: center; font-size: 26px; margin: 18px 0 2px; } .sub, .stats { text-align: center; font-style: italic; }
      .box { margin: 18px auto; width: 300px; background: #eee; text-align: center; padding: 10px; } .box b { display: block; font-size: 48px; font-weight: 400; }
      @media print { .noprint { display: none; } }</style></head><body>
      <p class="noprint"><button onclick="print()">🖨 Print</button></p>
      <div class="top"><div class="brand">${esc(document.title.split('—').pop().trim() || 'Exam Wizard')}</div><div class="who">${esc(me.user.name)}${me.user.student_no ? '; Student ID: ' + esc(me.user.student_no) : ''}</div></div>
      <h1>${esc(x.title)}</h1>
      <div class="sub">Class: ${esc(x.className)} • Teacher: ${esc(x.teacherName)} • ${esc(App.fmtDate(a.submittedAt))} • Questions: ${x.questionTotal || x.questionCount}</div>
      ${k ? `<div class="stats">StdDev = ${k.sd} • Mean = ${k.mean} • Median = ${k.median} • Rank = ${k.rank}/${k.total} • Percentile Rank = ${k.percentile}${k.current ? ' (current)' : ''}</div>` : ''}
      <div class="box"><b>${Number(a.percent).toFixed(2)}%</b>My Score (${a.score} / ${a.maxScore})</div>
      </body></html>`);
    w.document.close();
  }

  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  function renderStartbox(x) {
    const box = $('#startbox');
    if (!box) return;
    const now = Date.now() + offset;
    const startUrl = '/exam?id=' + encodeURIComponent(x.id);
    if (x.state === 'open' || x.state === 'inprogress') {
      const retake = x.attempt && x.attempt.retakeAllowed && x.state === 'open';
      box.innerHTML = `<p style="margin-top:0">${x.state === 'inprogress' ? 'You started this exam. You can go back to it now: your timer kept running.' : retake ? 'Your teacher has allowed you to <b>take this exam again</b>.' : 'This exam is open.'}
        ${x.requiresPassword && x.state === 'open' ? ' You will need the <b>exam password</b> from your teacher.' : ''}</p>
        <a class="btn primary big" href="${startUrl}">${x.state === 'inprogress' ? 'Resume exam' : 'Start exam'}</a>
        <p class="hint">The exam opens in this window. Once it starts, switching tabs or apps will void it.</p>`;
    } else if (x.state === 'upcoming') {
      box.innerHTML = `<div class="small muted">Opens in</div><div class="countdown" id="cd">${esc(fmtCountdown(new Date(x.startAt) - now))}</div>
        <div class="small muted">${esc(App.fmtDate(x.startAt))}. This page will let you start when it opens.</div>`;
    } else if (x.state === 'expired') {
      box.innerHTML = `<p style="margin:0">This exam closed on <b>${esc(App.fmtDate(x.endAt))}</b>. If you missed it, contact your teacher.</p>`;
    } else {
      const a = x.attempt || {};
      if (a.status === 'SUBMITTED') {
        box.innerHTML = `<div class="row" style="justify-content:space-between"><div><span class="tag ok">Submitted</span> <span class="muted small">${esc(App.fmtDate(a.submittedAt))}${a.late ? ' — late' : ''}</span></div></div>
          ${a.score !== null && a.score !== undefined ? `${reportHtml(x, a)}
            <button type="button" class="btn small" id="printResult" style="margin-top:10px">🖨 Print my result</button>
            ${a.pendingEssays ? '<p class="small muted" style="margin:0">' + a.pendingEssays + ' essay question(s) still to be graded by your teacher.</p>' : ''}`
          : '<p class="muted" style="margin:6px 0 0">Your teacher will release the results.</p>'}`;
      } else if (a.status === 'VOIDED') {
        box.innerHTML = `<span class="tag bad">Voided</span><p style="margin:8px 0 0">${esc(a.voidReason || 'Exam rules were broken.')}. Please talk to your teacher; only they can allow you to take it again.</p>`;
      } else {
        box.innerHTML = '<span class="tag grey">Not submitted</span><p style="margin:8px 0 0">The time ran out before the exam was submitted. Please contact your teacher.</p>';
      }
    }
  }

  // live countdown + refresh when an exam opens
  setInterval(() => {
    const x = data.exams.find((e) => e.id === selected);
    if (x && x.state === 'upcoming') {
      const left = new Date(x.startAt) - (Date.now() + offset);
      const cd = $('#cd');
      if (cd) cd.textContent = fmtCountdown(left);
      if (left <= 0) load();
    }
  }, 1000);
  // Refresh the list every minute, but only while the tab is visible and the student was active in the
  // last 15 minutes. Background or forgotten tabs then don't keep the database awake.
  let lastActive = Date.now();
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
  const inUse = () => document.visibilityState === 'visible' && Date.now() - lastActive < 15 * 60000;
  setInterval(() => { if (inUse()) load(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { lastActive = Date.now(); load(); }
  });

  function joinClass() {
    dialog('Join a class', `<div class="field"><label for="joinCode">Class code</label><input type="text" id="joinCode" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="20" placeholder="e.g. 7KQ2PA" style="text-transform:uppercase;font-size:18px;letter-spacing:2px;font-family:ui-monospace,Consolas,monospace"></div>
      <div class="note warn small" id="joinOdd" hidden></div>
      <p class="hint">Your teacher gives you this code. It is 6 letters and numbers (never O, 0, I, 1 or L).</p>`, {
      buttons: [{ label: 'Cancel' }, { label: 'Join class', primary: true, onClick: async (ov) => {
        const r = await api('/student/join', { code: $('#joinCode', ov).value });
        toast('Joined ' + r.class.name + (r.class.section ? ' — ' + r.class.section : ''));
        load();
      } }],
    });
    const box = App.$$('.overlay').pop(), inp = $('#joinCode', box), odd = $('#joinOdd', box);
    inp.addEventListener('input', () => {
      // turn full-width or look-alike letters into plain ones as they are typed; warn about anything else
      const clean = App.cleanCode(inp.value);
      const bad = Array.from(clean.replace(/-/g, '')).filter((c) => !/[A-Z0-9]/.test(c));
      if (clean !== inp.value.toUpperCase() && !bad.length) { const at = inp.selectionStart; inp.value = clean; try { inp.setSelectionRange(at, at); } catch (e) { /* ignore */ } }
      odd.hidden = !bad.length;
      odd.textContent = bad.length ? 'This code has a character that is not a plain letter or number (' + bad.slice(0, 3).join(' ') + '). Switch your keyboard to English (ABC) and type it again.' : '';
    });
  }

  $('#joinBtn').onclick = joinClass;
  $('#refresh').onclick = () => { load(); toast('List refreshed'); };
  load();
})();
