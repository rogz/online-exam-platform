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
  };

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)); const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; const p = (n) => String(n).padStart(2, '0');
    return (d ? d + (d === 1 ? ' day ' : ' days ') : '') + (h || d ? h + ':' + p(m) : p(m)) + ':' + p(sec);
  }
  const minutes = (m) => (m >= 60 ? (Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + Math.round(m % 60) + ' min' : '')) : Math.round(m * 10) / 10 + ' min');

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
        <div><b>${esc(x.title)}</b><span>${esc(x.className)}</span><span>${esc(subline(x))}</span></div>${mark(x)}</button>`).join('')}</section>`;
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
      ['lock', 'Secure'],
      ['clock', x.timeLimitMinutes ? minutes(x.timeLimitMinutes) : 'No time limit'],
      [x.faceMode === 'OFF' ? 'nocamera' : 'camera', x.faceMode === 'ALWAYS' ? 'Camera on' : x.faceMode === 'START' ? 'Face check' : 'No camera'],
      nav,
      ['device', x.allowedDevices === 'ANY' ? 'Any device' : x.allowedDevices === 'TABLET' ? 'Computer or tablet' : 'Computer only'],
    ];
    if (x.requiresPassword) tiles.push(['key', 'Password']);
    el.innerHTML = `<h1>${esc(x.title)}</h1>
      <p class="sub">${esc(x.className)} · ${esc(x.teacherName)}</p>
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
          <tr><td>Switching tabs or apps</td><td>Voids exam</td></tr>
          <tr><td>Copy &amp; paste</td><td>${x.blockCopyPaste ? 'OFF' : 'ON'}</td></tr>
          <tr><td>Reconnect after lost internet</td><td>${x.reconnectSeconds ? esc(minutes(x.reconnectSeconds / 60)) : 'Not allowed'}</td></tr>
          <tr><td>Score shown after submitting</td><td>${x.showScore ? 'Yes' : 'No'}</td></tr>
        </tbody></table></div>
      </div>`;
    renderStartbox(x);
  }

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
          ${a.score !== null && a.score !== undefined ? `<div class="score">${a.score} / ${a.maxScore} <span class="muted" style="font-size:18px">(${a.percent}%)</span></div>
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
  setInterval(load, 60000);

  function joinClass() {
    dialog('Join a class', `<div class="field"><label for="joinCode">Class code</label><input type="text" id="joinCode" autocomplete="off" placeholder="e.g. 7KQ2PA" style="text-transform:uppercase;font-size:18px;letter-spacing:2px"></div>
      <p class="hint">Your teacher gives you this code. It is 6 letters and numbers.</p>`, {
      buttons: [{ label: 'Cancel' }, { label: 'Join class', primary: true, onClick: async (ov) => {
        const r = await api('/student/join', { code: $('#joinCode', ov).value });
        toast('Joined ' + r.class.name + (r.class.section ? ' — ' + r.class.section : ''));
        load();
      } }],
    });
  }

  $('#joinBtn').onclick = joinClass;
  $('#refresh').onclick = () => { load(); toast('List refreshed'); };
  load();
})();
