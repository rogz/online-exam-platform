/* Online Exam — student page.
 * Talks to the Google Apps Script backend (see apps-script/Code.gs).
 * Detects tab switches, leaving the window and second monitors, and voids the exam.
 */
(function () {
  'use strict';

  const API_URL = '/api/attempt';
  const $ = (id) => document.getElementById(id);

  const state = {
    examId: new URLSearchParams(location.search).get('id') || new URLSearchParams(location.search).get('exam') || '',
    info: null,          // getExam response
    rules: { blurGraceSeconds: 0, requireMonitorCheck: true, blockCopyPaste: true },
    serverOffset: 0,     // serverNow - clientNow
    attemptId: null,
    student: null,
    questions: [],
    answers: {},
    endAt: null,         // client timestamp when time is up
    active: false,       // exam in progress, guards on
    voided: false,
    submitting: false,
    violations: [],
    warned: new Set(),   // time warnings already shown (minutes)
    qEndAt: null,        // per-question deadline (one-at-a-time with a time limit per question)
    unloading: false,    // the page is closing or reloading (reconnect allowed)
    disconnectSent: false,
    hiddenTimer: null,
    lastOkAt: 0,         // last successful contact with the server
    offlineSince: null,  // when the connection was lost
    oneAtATime: false,   // show one question at a time
    allowBack: true,     // may return to earlier questions (one-at-a-time mode)
    index: 0,            // current question in one-at-a-time mode
    locked: new Set(),   // questions that can no longer be changed
    cam: { required: false, continuous: false, warnings: 0, warningOpen: false, offenseArmed: true },
    pageToken: newToken(), // this open page; lets the server tell "internet dropped" from "page was closed"
    answersVer: 0,         // changes each time an answer changes
    savedVer: 0,           // the version the server has
  };

  function newToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const h = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return h() + h() + '-' + h() + '-4' + h().slice(1) + '-a' + h().slice(1) + '-' + h() + h() + h();
  }

  // ───────── API ─────────

  /** While an offline exam runs (or was voided and is not being sent yet), the page's server actions are handled on the device. */
  const useLocal = (action) => !!(state.offline && state.offline.st && LOCAL_ACTIONS.includes(action) &&
    (state.offline.st.status === 'IN_PROGRESS' || (state.offline.st.status === 'VOIDED' && !state.offline.syncing)));

  async function api(action, payload, tries = 1) {
    if (useLocal(action)) return localApi(action, payload || {});
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify(Object.assign({ action }, payload || {})),
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.code === 'SIGNED_OUT') { location.href = '/?next=' + encodeURIComponent(location.pathname + location.search); }
        if (!data.ok) {
          const e = new Error(data.error || 'Something went wrong.');
          e.code = data.code;
          throw e;
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (err.code) throw err;           // server answered with an error: don't retry
        if (i < tries - 1) await sleep(1500 * (i + 1));
      }
    }
    const e = new Error('Could not reach the exam server. Check your internet connection.');
    e.code = 'NETWORK';
    e.cause = lastErr;
    throw e;
  }

  function beacon(action, payload) {
    if (useLocal(action)) { localApi(action, payload || {}); return true; }
    try {
      const body = new Blob([JSON.stringify(Object.assign({ action }, payload))], { type: 'text/plain;charset=UTF-8' });
      return navigator.sendBeacon && navigator.sendBeacon(API_URL, body);
    } catch (e) { return false; }
  }

  // ───────── Screens ─────────

  function show(screen) {
    ['loading', 'error', 'rules', 'exam', 'pending', 'result'].forEach((s) => { $('screen-' + s).hidden = s !== screen; });
    $('examBar').hidden = screen !== 'exam';
    window.scrollTo(0, 0);
  }

  function showError(msg) {
    $('errorText').textContent = msg;
    show('error');
  }

  function busy(on, text) {
    $('busyText').textContent = text || 'Please wait…';
    $('busyModal').hidden = !on;
  }

  // ───────── Monitor & browser checks ─────────

  /**
   * 'computer' | 'tablet' | 'phone'. iPads ask for desktop pages and report "Macintosh",
   * so a touch screen on a Mac means iPad.
   */
  function deviceType() {
    const ua = navigator.userAgent || '';
    const touch = navigator.maxTouchPoints || 0;
    // Hardware first: "Desktop site" mode changes what the browser says about itself, but not the screen.
    // A touch screen with no mouse or trackpad is a phone or tablet; the screen's short side tells which.
    // Checked on a real phone in Brave's desktop mode: the browser name, "mobile" flag and device type change,
    // but the main pointer stays a touch screen that can't hover, and the screen size stays phone-sized.
    // (Phones with stylus support also report a "fine" pointer, so that is not used.)
    const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    const touchFirst = touch > 0 && mq('(pointer: coarse)') && mq('(hover: none)');
    const shortSide = Math.min(screen.width || 0, screen.height || 0);
    if (touchFirst) return shortSide > 0 && shortSide < 520 ? 'phone' : 'tablet'; // phones are up to ~480 wide, small tablets 530+
    if (/iPhone|iPod|Windows Phone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return 'phone';
    if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch > 1) || /Android/i.test(ua) || /Tablet/i.test(ua)) return 'tablet';
    if (navigator.userAgentData && navigator.userAgentData.mobile) return 'phone';
    return 'computer';
  }

  const DEVICE_NAME = { computer: 'Computer', tablet: 'Tablet', phone: 'Phone' };

  function deviceAllowed() {
    const allowed = (state.info && state.info.exam.allowedDevices) || 'COMPUTER';
    const d = deviceType();
    return allowed === 'ANY' || d === 'computer' || (allowed === 'TABLET' && d === 'tablet');
  }

  /** 'single' | 'multiple' | 'unsupported' */
  function monitorStatus() {
    if (!window.screen || !('isExtended' in window.screen)) return 'unsupported';
    return window.screen.isExtended ? 'multiple' : 'single';
  }

  function setCheck(id, ok, text) {
    const li = $(id);
    li.className = ok ? 'ok' : 'bad';
    let msg = li.querySelector('.msg');
    if (!msg) { msg = document.createElement('span'); msg.className = 'msg'; li.appendChild(msg); }
    msg.textContent = text;
  }

  function preChecksPass() {
    const d = deviceType();
    const allowed = state.info.exam.allowedDevices || 'COMPUTER';
    const devOk = deviceAllowed();
    setCheck('checkDevice', devOk, DEVICE_NAME[d] + (devOk ? ''
      : allowed === 'TABLET' ? ' — this exam must be taken on a computer or a tablet, not a phone.'
        : ' — this exam must be taken on a laptop or desktop computer.'));
    if (d !== 'computer') {
      // Tablets and phones: no second-monitor check; leaving the exam app still voids it.
      setCheck('checkBrowser', true, 'Supported');
      setCheck('checkMonitor', true, 'Not checked on ' + (d === 'tablet' ? 'tablets' : 'phones'));
      return devOk && cameraCheckPasses();
    }
    const m = monitorStatus();
    const browserOk = m !== 'unsupported' || !state.rules.requireMonitorCheck;
    setCheck('checkBrowser', browserOk, m === 'unsupported'
      ? (state.rules.requireMonitorCheck
        ? 'This browser cannot check for extra monitors. Open this link in Google Chrome or Microsoft Edge on a laptop or desktop computer.'
        : 'This browser cannot check for extra monitors. Make sure only one screen is connected.')
      : 'Supported');
    if (m === 'unsupported') setCheck('checkMonitor', !state.rules.requireMonitorCheck, 'Cannot be checked in this browser');
    else setCheck('checkMonitor', m === 'single', m === 'single'
      ? 'One screen detected'
      : 'A second monitor is connected. Disconnect it to start the exam.');
    return devOk && browserOk && m !== 'multiple' && cameraCheckPasses();
  }

  // ───────── Camera ─────────

  const CAM_TEXT = {
    OFF: 'Camera off',
    LOADING: 'Loading face detection…',
    OK: '✓ Face detected',
    NO_FACE: 'No face detected',
    CAMERA_BLOCKED: 'Camera is covered or too dark',
    MULTIPLE_FACES: 'More than one person in view',
    PHONE_DETECTED: 'Phone detected',
    CAMERA_OFF: 'Camera turned off',
  };
  const CAM_HELP = {
    NO_FACE: 'Make sure your whole face is visible and well lit, facing the screen.',
    CAMERA_BLOCKED: 'Uncover the camera and make sure the room is bright enough.',
    MULTIPLE_FACES: 'Only you may be in front of the camera.',
    PHONE_DETECTED: 'Put your phone away, out of the camera\'s view. Using a calculator? Keep it flat on your desk, below the camera.',
    CAMERA_OFF: 'Your camera stopped. Turn it back on to continue.',
  };

  function camRuleText() {
    const n = camAllowed();
    if (n === 0) return '<b>your exam is voided</b> right away.';
    return 'you get <b>' + (n === 1 ? 'one warning' : n + ' warnings') + '</b>. The ' + ['', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh'][n] + ' time, <b>your exam is voided</b>.';
  }

  function cameraCheckPasses() {
    if (!state.cam.required) return true;
    const st = window.ExamCamera.status();
    setCheck('checkCamera', st === 'OK', st === 'OK' ? 'Face detected'
      : st === 'OFF' ? 'Turn on your camera below.'
        : st === 'LOADING' ? 'Loading face detection…' : CAM_TEXT[st] + '. ' + (CAM_HELP[st] || ''));
    return st === 'OK';
  }

  function paintCamBadge(boxId, badgeId, st) {
    const box = $(boxId);
    box.classList.toggle('ok', st === 'OK');
    box.classList.toggle('bad', st !== 'OK' && st !== 'LOADING' && st !== 'OFF');
    $(badgeId).textContent = CAM_TEXT[st] || st;
  }

  async function turnOnCamera() {
    $('camBtn').disabled = true;
    $('camError').hidden = true;
    try {
      await window.ExamCamera.start($('camVideo'), { phoneDetection: state.rules.phoneDetection, headDetection: state.rules.headDetection !== false, onStatus: onCamStatus });
      $('camBtn').hidden = true;
    } catch (e) {
      $('camError').textContent = e.message;
      $('camError').hidden = false;
      $('camBtn').disabled = false;
    }
    refreshStartButton();
  }

  /** Called by camera.js about twice a second. */
  function onCamStatus(st, ageMs) {
    paintCamBadge('camBox', 'camBadge', st);
    $('camIndicator').classList.toggle('bad', st !== 'OK');
    $('camIndicator').textContent = st === 'OK' ? '📷 Camera on' : '📷 ' + (CAM_TEXT[st] || st);
    if (!state.attemptId) { refreshStartButton(); return; }
    if (state.cam.warningOpen) {
      paintCamBadge('faceWarnBox', 'faceWarnBadge', st);
      $('faceWarnOk').disabled = st !== 'OK';
      $('camRestartBtn').hidden = st !== 'CAMERA_OFF';
      return;
    }
    if (!state.active || !state.cam.continuous) return;
    if (st === 'OK') { state.cam.offenseArmed = true; return; }
    if (st === 'LOADING' || st === 'OFF' || !state.cam.offenseArmed) return;
    const graceMs = st === 'CAMERA_OFF' ? 0 : Math.max(1, state.rules.faceGraceSeconds || 3) * 1000;
    if (ageMs >= graceMs) cameraOffense(st, CAM_TEXT[st] + ' for ' + Math.round(ageMs / 1000) + ' s.');
  }

  /** Each camera problem is a warning until the exam's limit (default 1); the next one voids. The server applies the same rule. */
  /** Saves one small picture as proof (if the exam allows it). Failures are ignored. */
  function sendSnapshot(event) {
    if (!state.rules.cameraSnapshots || !state.attemptId) return;
    let dataUrl = null;
    try { dataUrl = window.ExamCamera.snapshot(CAM_TEXT[event] || event); } catch (e) { dataUrl = null; }
    if (dataUrl) api('snapshot', { attemptId: state.attemptId, event, dataUrl }, 2).catch(() => {});
  }

  /**
   * Random snapshots: the hour is split into equal parts (e.g. 6 parts of 10 minutes) and one small picture is taken
   * at a random moment in each part, so students can't predict them and there are no long gaps.
   */
  function startRandomSnapshots() {
    const per = state.rules.randomSnapshots ? Number(state.rules.snapshotsPerHour) || 6 : 0;
    if (!per || state.randomSnapTimer || !state.attemptId) return;
    const part = 3600000 / per;
    let partStart = Date.now();
    const plan = () => {
      const at = partStart + Math.max(20000, Math.random() * part);
      state.randomSnapTimer = setTimeout(() => {
        if (!state.active) { state.randomSnapTimer = null; return; }
        let dataUrl = null;
        try { dataUrl = window.ExamCamera.snapshot('Random check', { small: true }); } catch (e) { dataUrl = null; }
        if (dataUrl) api('snapshot', { attemptId: state.attemptId, event: 'RANDOM', dataUrl }, 2).catch(() => {});
        partStart += part;
        plan();
      }, Math.max(1000, at - Date.now()));
    };
    plan();
  }

  function cameraOffense(event, detail) {
    sendSnapshot(event);
    state.cam.offenseArmed = false;
    state.cam.warnings++;
    if (state.cam.warnings > camAllowed()) { voidExam(event, detail); return; }
    showFaceWarning(event);
    api('violation', { attemptId: state.attemptId, event, detail }, 3)
      .then((r) => { if (r.status === 'VOIDED') { state.violations.push({ event, detail }); showVoid(event); } })
      .catch((e) => { if (e.code === 'VOIDED') showVoid(event); else beacon('violation', { attemptId: state.attemptId, event, detail }); });
  }

  const camAllowed = () => { const n = Number(state.rules.cameraWarnings); return Number.isFinite(n) ? n : 1; };

  function showFaceWarning(event) {
    state.cam.warningOpen = true;
    const n = camAllowed(), left = n - state.cam.warnings;
    $('faceWarnTitle').textContent = n === 1 ? '⚠ Warning — this is your only warning'
      : left === 0 ? '⚠ Warning ' + state.cam.warnings + ' of ' + n + ' — this is your last warning'
        : '⚠ Warning ' + state.cam.warnings + ' of ' + n;
    $('faceWarnNext').textContent = left === 0 ? 'If this happens again, your exam will be voided.'
      : 'You have ' + left + ' warning' + (left === 1 ? '' : 's') + ' left. After that, your exam will be voided.';
    $('faceWarnReason').textContent = REASONS[event] || CAM_TEXT[event];
    window.ExamCamera.mirrorTo($('faceWarnVideo'));
    $('faceWarnOk').disabled = true;
    $('faceWarnModal').hidden = false;
  }

  function closeFaceWarning() {
    if (window.ExamCamera.status() !== 'OK') return;
    $('faceWarnModal').hidden = true;
    state.cam.warningOpen = false;
    state.cam.offenseArmed = true;
  }

  function windowStatusNow() {
    if (state.offline) return 'OPEN'; // offline: the password the teacher gives in the room opens the exam
    const now = Date.now() + state.serverOffset;
    const e = state.info.exam;
    if (e.startMs && now < e.startMs) return 'NOT_YET_OPEN';
    if (e.endMs && now > e.endMs) return 'CLOSED';
    return 'OPEN';
  }

  function refreshStartButton() {
    if (!state.info || state.attemptId) return;
    const checksOk = preChecksPass();
    const ws = windowStatusNow();
    const n = $('windowNotice');
    if (ws === 'NOT_YET_OPEN') {
      n.hidden = false; n.className = 'notice';
      const until = state.info.exam.startMs - (Date.now() + state.serverOffset);
      n.textContent = state.rules.openCountdown
        ? 'This exam opens in ' + fmtCountdown(until) + ' (' + state.info.exam.startText + '). Keep this page open: you can start as soon as it opens.'
        : 'This exam is not open yet. It opens on ' + state.info.exam.startText + '. This page will let you start once it opens.';
    } else if (ws === 'CLOSED') {
      n.hidden = false; n.className = 'notice bad';
      n.textContent = 'This exam closed on ' + state.info.exam.endText + '. If your instructor allowed you a retake, you can still start.';
    } else {
      n.hidden = true;
    }
    // CLOSED is still allowed through: the server decides (approved retakes may start late).
    $('startBtn').disabled = !(checksOk && ws !== 'NOT_YET_OPEN' && $('agree').checked);
  }

  // ───────── Rules screen ─────────

  function renderRules() {
    const { exam, rules } = state.info;
    state.rules = rules;
    document.title = exam.title + ' — Online Exam';
    $('brand').textContent = exam.title;
    $('examTitle').textContent = exam.title;
    EWQ.setText($('examInstructions'), exam.instructions);
    $('examInstructions').hidden = !exam.instructions;
    const types = { MC: 'multiple choice', TF: 'true/false', FIB: 'fill in the blank', ESSAY: 'essay' };
    $('factQuestions').textContent = exam.typeCounts
      ? exam.questionCount + ' (' + Object.keys(exam.typeCounts).map((k) => exam.typeCounts[k] + ' ' + (types[k] || k)).join(', ') + ')'
      : String(exam.questionCount);
    $('factPoints').textContent = exam.totalPoints === null ? '—' : exam.totalPoints;
    $('factLimit').textContent = exam.timeLimitMinutes ? exam.timeLimitMinutes + ' minutes' : 'No limit (until the exam closes)';
    $('factWindow').textContent = (exam.startText ? 'From ' + exam.startText : 'Now') + (exam.endText ? ' until ' + exam.endText : '');
    $('whoName').textContent = state.info.student.name;
    $('whoId').textContent = state.info.student.id ? '(' + state.info.student.id + ')' : '';
    $('passwordWrap').hidden = !exam.requiresPassword;
    $('rulePaste').hidden = !rules.blockCopyPaste;
    if (deviceType() !== 'computer') {
      $('ruleMonitor').innerHTML = '<b>Stay in this browser.</b> Switching to another app, going to the home screen, or opening another tab will void your exam.';
    }
    state.cam.required = exam.faceMode === 'START' || exam.faceMode === 'ALWAYS';
    state.cam.continuous = exam.faceMode === 'ALWAYS';
    const fw = focusAllowed();
    if (fw > 0) {
      $('ruleFocus').innerHTML = '<b>Stay on the exam page.</b> Opening another tab, minimizing the browser, Alt+Tab / Cmd+Tab or clicking another app counts as leaving. ' +
        'You get <b>' + (fw === 1 ? 'one warning' : fw + ' warnings') + '</b>; the next time, <b>your exam is voided</b>. Staying away for more than 1 minute voids it at once.';
      $('agreeText').textContent = 'I have read the rules. I understand that leaving the exam page (after my warnings) or using a second monitor will void my exam.';
    }
    $('ruleCamera').hidden = !state.cam.required;
    $('ruleCalc').hidden = !(state.cam.required && state.rules.phoneDetection);
    $('checkCamera').hidden = !state.cam.required;
    $('cameraPanel').hidden = !state.cam.required;
    if (state.cam.continuous) {
      $('ruleCamera').innerHTML = '📷 <b>Your camera will be monitored throughout the exam.</b> Keep your face clearly visible' +
        (state.rules.headDetection !== false ? ' (looking down at your paper is fine, as long as your head stays in view)' : '') + '. ' +
        'If your face is hidden, the camera is covered, another person appears, or a phone is seen, ' + camRuleText() +
        (state.rules.cameraSnapshots ? ' When the camera flags something, a small still picture is saved for your teacher as proof.' : '') +
        (state.rules.randomSnapshots ? ' <b>Your camera will also take about ' + (Number(state.rules.snapshotsPerHour) || 6) + ' small pictures per hour at random times.</b> Only your teacher can see them, and they are deleted when the exam is archived (at the latest 30 days after it closes).' : '') +
        (state.rules.cameraSnapshots || state.rules.randomSnapshots ? ' No video is recorded.' : '');
      const n = camAllowed();
      $('agreeText').textContent = 'I have read the rules. I understand that ' + (focusAllowed() ? 'leaving the exam page (after my warnings) ' : 'switching tabs or windows ') + 'or using a second monitor will void my exam, ' +
        'and that my camera is monitored: ' + (n === 0 ? 'any camera problem will void my exam.' : 'I get ' + (n === 1 ? 'one warning' : n + ' warnings') + ', and the next camera problem will void my exam.');
    } else if (state.cam.required) {
      $('ruleCamera').innerHTML = '📷 <b>Your face must be visible to the camera before you can start.</b> Sit facing the screen in a well-lit place, with only you in view.';
      $('camHelp').textContent = 'Turn on your camera so we can check that your face is visible. The camera turns off when the exam starts.';
    }
    const rs = rules.reconnectSeconds || 0;
    if (rules.keepGoingOffline !== false) {
      $('ruleReload').innerHTML = '<b>If the internet drops, keep this page open and keep answering.</b> Your answers are saved on this device and sent automatically when the internet is back; ' +
        'if time runs out while offline, they are sent as soon as you are back online. ' +
        (rs > 0 ? 'If the page itself is closed or reloaded, reopen the same exam link within <b>' + fmtDuration(rs) + '</b> (up to ' + rules.maxReconnects + ' time' + (rules.maxReconnects === 1 ? '' : 's') + '), or your exam is voided. '
          : 'Closing or reloading the page voids your exam. ') + '<b>Do not close or reload this page.</b>';
    } else if (rs > 0) {
      $('ruleReload').innerHTML = '<b>If your internet drops or the page reloads</b>, reopen the same exam link within <b>' + fmtDuration(rs) +
        '</b> to continue (up to ' + rules.maxReconnects + ' time' + (rules.maxReconnects === 1 ? '' : 's') + '). Your timer keeps running. ' +
        'Taking longer voids your exam. <b>Do not close or reload this page on purpose.</b>';
    }
    if (exam.questionSeconds > 0) {
      $('ruleNav').hidden = false;
      $('ruleNav').innerHTML = 'Questions are shown <b>one at a time</b>, with <b>' + fmtDuration(exam.questionSeconds) + ' per question</b>. ' +
        'When the time is up, the exam moves on automatically. <b>You cannot go back</b> to earlier questions.';
    }
    const nav = $('ruleNav');
    if (exam.displayMode === 'ONE' && !(exam.questionSeconds > 0)) {
      nav.hidden = false;
      nav.innerHTML = exam.allowBack
        ? 'Questions are shown <b>one at a time</b>. You can go back to earlier questions before submitting.'
        : 'Questions are shown <b>one at a time</b>. <b>You cannot go back</b> to a question once you click <i>Next</i>, so answer each one before moving on.';
    }
    show('rules');
    refreshStartButton();
  }

  async function onStart(ev) {
    ev.preventDefault();
    const err = $('startError');
    err.hidden = true;
    if (state.info.exam.requiresPassword && !$('examPassword').value.trim()) {
      err.textContent = 'Enter the exam password from your teacher.';
      err.hidden = false;
      return;
    }
    if (!preChecksPass()) return;
    if (state.offline) {
      $('startBtn').disabled = true;
      busy(true, state.offline.st ? 'Continuing…' : 'Unlocking the exam…');
      try { await startOffline(); } catch (e) { err.textContent = e.message; err.hidden = false; } finally { busy(false); refreshStartButton(); }
      return;
    }
    const m = monitorStatus();
    $('startBtn').disabled = true;
    busy(true, 'Starting exam…');
    try {
      const r = await api('start', {
        examId: state.examId,
        pageToken: state.pageToken,
        password: $('examPassword').value.trim(),
        env: {
          userAgent: navigator.userAgent,
          device: deviceType(),
          touchPoints: navigator.maxTouchPoints || 0,
          screenSize: (screen.width || 0) + 'x' + (screen.height || 0),
          isExtended: m === 'multiple',
          monitorCheck: m === 'unsupported' ? 'unsupported' : 'supported',
          camera: state.cam.required && window.ExamCamera.status() === 'OK' ? 'ok' : 'none',
        },
      }, 2);
      busy(false);
      beginExam(r);
    } catch (e) {
      busy(false);
      err.textContent = e.message;
      err.hidden = false;
      refreshStartButton();
    }
  }

  // ───────── Offline exams (downloaded before, taken without internet) ─────────
  // The download (a locked copy of this student's questions) is kept in IndexedDB; the exam page itself is kept by the
  // offline helper (/sw.js). While an offline exam runs, the actions the page would send to the server are handled here
  // on the device (localApi) and sent together when the student is back online (offlineSubmit).

  const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const normPw = (p) => String(p || '').toUpperCase().replace(/[\s-]+/g, '');
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const nowEst = () => Date.now() + state.serverOffset; // the site's time, as far as this device knows

  let dbPromise = null;
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
        const r = indexedDB.open('exam-wizard', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('packages')) d.createObjectStore('packages');
          if (!d.objectStoreNames.contains('snaps')) d.createObjectStore('snaps', { autoIncrement: true });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  async function idbDo(store, mode, fn) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const pkgGet = (key) => idbDo('packages', 'readonly', (s) => s.get(key)).catch(() => null);
  const pkgPut = (key, v) => idbDo('packages', 'readwrite', (s) => s.put(v, key));
  const pkgDel = (key) => idbDo('packages', 'readwrite', (s) => s.delete(key)).catch(() => {});

  const offKey = (id) => 'exam-offline:' + id;
  function offLoad(id) { try { return JSON.parse(localStorage.getItem(offKey(id)) || 'null'); } catch (e) { return null; } }
  function offSave() {
    const o = state.offline;
    if (!o || !o.st) return;
    o.st.answers = state.answers;
    o.st.cameraWarnings = state.cam.warnings || 0;
    o.st.focusWarnings = state.focusWarnings || 0;
    o.st.locked = Array.from(state.locked || []);
    o.st.lastWall = Date.now();
    try { localStorage.setItem(offKey(o.pkg.packageId), JSON.stringify(o.st)); } catch (e) { /* storage full: answers still in memory */ }
  }
  function offEvent(event, detail) {
    const o = state.offline;
    if (!o || !o.st) return;
    o.st.events = o.st.events || [];
    if (o.st.events.length < 300) o.st.events.push({ event, detail: String(detail || '').slice(0, 300), at: nowEst() });
    offSave();
  }

  /** The unlocked copy: questions and all. Wrong password → the browser can't decrypt it. */
  async function unlockPackage(locked, password) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(normPw(password)), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(locked.salt), iterations: locked.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(locked.iv) }, key, fromB64(locked.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** Same as receiptOf() in src/offline.js. */
  function canonAnswers(a) {
    return Object.keys(a || {}).filter((k) => a[k] !== undefined && a[k] !== null && String(a[k]) !== '').sort().map((k) => k + '=' + String(a[k])).join('\n');
  }
  async function receiptOf(keyB64, packageId, finishedAt, answers) {
    const key = await crypto.subtle.importKey('raw', fromB64(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(packageId + '|' + Math.round(finishedAt) + '|' + canonAnswers(answers))));
    let s = '';
    for (let i = 0; i < 6; i++) s += B32[mac[i] % 32];
    return s.slice(0, 3) + '-' + s.slice(3);
  }

  /** What the server would do, done on the device while the exam is offline. */
  const LOCAL_ACTIONS = ['violation', 'disconnect', 'snapshot', 'ping', 'lockAnswer', 'clientError'];
  async function localApi(action, p) {
    const o = state.offline, st = o.st;
    if (action === 'ping') return { ok: true, status: st.status };
    if (action === 'violation') {
      offEvent(p.event, (p.final ? 'VOIDED: ' : 'WARNING: ') + (p.detail || ''));
      if (p.final && st.status === 'IN_PROGRESS') { st.status = 'VOIDED'; st.voided = { event: p.event, detail: p.detail || '' }; st.finishedAt = nowEst(); offSave(); }
      return { ok: true, status: st.status === 'VOIDED' ? 'IN_PROGRESS' : st.status, warned: true }; // the page already shows the void itself
    }
    if (action === 'disconnect') { offEvent('DISCONNECTED', 'Page closed or reloaded (offline)'); return { ok: true }; }
    if (action === 'clientError') { offEvent('PAGE_ERROR', p.message + (p.where ? ' @ ' + p.where : '')); return { ok: true }; }
    if (action === 'lockAnswer') { offSave(); return { ok: true, locked: true }; }
    if (action === 'snapshot') {
      const random = p.event === 'RANDOM';
      st.snapCount = st.snapCount || { flag: 0, random: 0 };
      const kind = random ? 'random' : 'flag';
      const cap = random ? Math.floor((Number(state.rules.snapshotsPerHour) || 6) * (nowEst() - st.startedAt) / 3600000) + 1 : 10;
      if (st.snapCount[kind] >= cap) return { ok: true, saved: false };
      st.snapCount[kind]++;
      offSave();
      await idbDo('snaps', 'readwrite', (s) => s.add({ packageId: o.pkg.packageId, event: p.event, dataUrl: p.dataUrl, at: nowEst() })).catch(() => {});
      return { ok: true, saved: true };
    }
    return { ok: true };
  }

  /** Shown on the rules screen (with internet) when the teacher made the exam available offline. */
  async function renderOfflineCard() {
    const card = $('offlineCard');
    if (!state.info || !state.info.rules.offlineMode) { card.hidden = true; return; }
    const pk = await pkgGet(state.examId);
    card.hidden = false;
    card.className = 'offline-card' + (pk ? ' ready' : '');
    card.innerHTML = pk
      ? '<b>✓ Downloaded on this device</b> (' + new Date(pk.downloadedAt).toLocaleString() + '). <b>📌 Bookmark this page now.</b> On exam day, open it in this same browser, ' +
        '<b>without internet</b>: the bookmark, or <b>' + location.host + '/offline</b>. Your teacher gives you the password in the room.' +
        '<div><button type="button" class="btn" id="dlBtn">Download again</button> <span class="small muted" id="dlStatus"></span></div>'
      : '<b>📥 This exam can be taken without internet.</b> Download it now, while you have internet (on the device you will use for the exam). ' +
        'It stays locked until your teacher gives the password.<div><button type="button" class="btn primary" id="dlBtn">Download for offline</button> <span class="small muted" id="dlStatus"></span></div>';
    $('dlBtn').onclick = downloadForOffline;
  }

  async function downloadForOffline() {
    const status = $('dlStatus'), btn = $('dlBtn');
    btn.disabled = true;
    status.textContent = 'Downloading…';
    try {
      if (!window.crypto || !crypto.subtle || !window.indexedDB) throw new Error('This browser cannot keep exams offline. Use an up-to-date Chrome, Edge or Safari.');
      const r = await api('download', { examId: state.examId }, 2);
      await pkgPut(state.examId, { packageId: r.packageId, locked: r.locked, meta: r.meta, rules: state.info.rules, student: r.student,
        serverOffset: r.serverNow - Date.now(), downloadedAt: Date.now(), externalImages: r.externalImages });
      status.textContent = 'Saving the exam page…';
      const kept = await keepForOffline(r.externalImages || []);
      const bad = kept.filter((k) => !k.ok);
      renderOfflineRules(await pkgGet(state.examId)); // from now on this device uses the downloaded copy
      const camBad = bad.some((k) => window.ExamCamera.files.includes(k.url));
      $('dlStatus').innerHTML = (bad.length
        ? '<span style="color:#9a6700">Downloaded, but ' + bad.length + ' file' + (bad.length === 1 ? '' : 's') + ' could not be saved' + (camBad ? ' (camera checker)' : '') + '. Click "Download again" with a better connection.</span>'
        : '<span style="color:#1a7f37">✓ Ready offline</span>');
    } catch (e) {
      btn.disabled = false;
      status.textContent = e.message;
    }
  }

  /** Asks the offline helper to keep the exam page, the camera checker and the pictures. */
  async function keepForOffline(images) {
    if (!('serviceWorker' in navigator)) return [{ url: 'offline helper', ok: false }];
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const reg = await navigator.serviceWorker.ready;
    const items = [];
    if (state.info.exam.faceMode !== 'OFF') window.ExamCamera.files.forEach((u) => items.push({ url: u }));
    images.forEach((u) => items.push({ url: u, noCors: true }));
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve([{ url: 'offline helper', ok: false }]), 120000);
      ch.port1.onmessage = (e) => { clearTimeout(t); resolve((e.data && e.data.results) || []); };
      (reg.active || navigator.serviceWorker.controller).postMessage({ type: 'keep', items }, [ch.port2]);
    });
  }

  /** No internet, but this exam was downloaded: show the rules screen from the downloaded details. */
  function renderOfflineRules(pk) {
    const st = offLoad(pk.packageId);
    state.offline = { pkg: pk, st: st && st.status === 'IN_PROGRESS' ? st : null };
    state.serverOffset = pk.serverOffset || 0;
    state.info = { exam: Object.assign({}, pk.meta, { requiresPassword: !state.offline.st, windowStatus: 'OPEN' }), rules: pk.rules, student: pk.student };
    renderRules();
    const n = $('offlineCard');
    n.hidden = false; n.className = 'offline-card';
    n.innerHTML = state.offline.st
      ? '<b>📴 Offline exam in progress.</b> Click <i>Continue exam</i> to go on. Your answers so far are kept on this device.'
      : '<b>📥 Downloaded on this device</b> (' + new Date(pk.downloadedAt).toLocaleString() + '). No internet is needed. Enter the password your teacher gives you in the room, then start. ' +
        'When you finish, you get a <b>receipt code</b>; your answers are sent as soon as this device is online.' +
        (navigator.onLine ? '<div><button type="button" class="btn small" id="dlBtn">Download again</button> <span class="small muted" id="dlStatus">Only if your teacher asks (e.g. the password changed).</span></div>' : '');
    if ($('dlBtn')) $('dlBtn').onclick = downloadForOffline;
    if (state.offline.st) $('startBtn').textContent = 'Continue exam';
    const rs = state.rules.reconnectSeconds || 0, mr = state.rules.maxReconnects || 0;
    $('ruleReload').innerHTML = '<b>This is an offline exam: no internet is needed.</b> Your answers are kept on this device. ' +
      (rs > 0 ? 'If the page is closed or reloaded, open the same exam link again within <b>' + fmtDuration(rs) + '</b> (up to ' + mr + ' time' + (mr === 1 ? '' : 's') + '), or your exam is voided. '
        : 'Closing or reloading the page voids your exam. ') + '<b>Do not close or reload this page on purpose.</b>';
    refreshStartButton();
  }

  /** Start (or continue after a reload) an offline exam. */
  async function startOffline() {
    const o = state.offline, err = $('startError');
    let open = await pkgGet('open:' + o.pkg.packageId);
    if (o.st) {
      // continuing after the page was closed: the same rules as the server's reconnect window
      const rs = state.rules.reconnectSeconds || 0, gap = Date.now() - (o.st.lastWall || Date.now());
      o.st.reloads = (o.st.reloads || 0) + 1;
      const tooLong = !(rs > 0) || gap > rs * 1000 + 30000, tooMany = o.st.reloads > (state.rules.maxReconnects || 0);
      if (!open || tooLong || tooMany) {
        const ev = !open ? 'PAGE_CLOSED' : tooMany ? 'TOO_MANY_RECONNECTS' : rs > 0 ? 'CONNECTION_LOST' : 'PAGE_CLOSED';
        offEvent(ev, !open ? 'The unlocked copy was missing' : tooMany ? 'Reopened ' + o.st.reloads + ' times' : 'Came back after ' + Math.round(gap / 1000) + ' s');
        o.st.status = 'VOIDED'; o.st.voided = { event: ev, detail: 'offline reload' }; o.st.finishedAt = nowEst(); offSave();
        state.attemptId = o.pkg.packageId;
        state.student = { name: o.pkg.student.name, id: o.pkg.student.id };
        showVoid(ev === 'TOO_MANY_RECONNECTS' ? 'PAGE_CLOSED' : ev);
        return;
      }
      offEvent('RECONNECTED', 'Continued offline after ' + Math.round(gap / 1000) + ' s (reopen ' + o.st.reloads + ' of ' + state.rules.maxReconnects + ')');
    } else {
      const pw = $('examPassword').value.trim();
      try { open = await unlockPackage(o.pkg.locked, pw); } catch (e) {
        err.textContent = pw ? 'That password is not right. Check it with your teacher (capital letters and dashes don\'t matter).' : 'Enter the exam password from your teacher.';
        err.hidden = false; refreshStartButton(); return;
      }
      await pkgPut('open:' + o.pkg.packageId, open);
      const limitMs = (open.exam.timeLimitMinutes || 0) * 60000;
      const endEst = open.exam.endMs && (!limitMs || open.exam.endMs < nowEst() + limitMs) && open.exam.endMs > nowEst() ? open.exam.endMs : null;
      o.st = { status: 'IN_PROGRESS', startedAt: nowEst(), endAt: limitMs ? Date.now() + limitMs : endEst ? Date.now() + (endEst - nowEst()) : null,
        answers: {}, events: [], reloads: 0, locked: [], device: deviceType() };
      offEvent('OFFLINE_START', 'Unlocked with the password and started offline');
    }
    state.unlocked = open;
    const r = {
      attemptId: o.pkg.packageId, studentId: open.student.id, studentName: open.student.name, questions: open.questions,
      remainingMs: o.st.endAt === null ? null : Math.max(0, o.st.endAt - Date.now()), resumed: (o.st.reloads || 0) > 0, reconnects: o.st.reloads || 0,
      cameraWarningsUsed: o.st.cameraWarnings || 0, focusWarningsUsed: o.st.focusWarnings || 0, lockedIds: o.st.locked || [], draftAnswers: o.st.answers || {},
    };
    beginExam(r);
    offSave();
  }

  /** Finished (or voided) offline: receipt code, then send whenever there is internet. */
  async function finishPackageExam() {
    const o = state.offline;
    o.st.finishedAt = nowEst();
    o.st.answers = state.answers;
    o.st.receipt = await receiptOf(state.unlocked.receiptKey, o.pkg.packageId, o.st.finishedAt, o.st.answers);
    o.st.status = 'FINISHED';
    offSave();
    finishExam();
    showOfflineFinished();
  }

  /** The answers as QR code(s), for handing in without internet (scanned on /collect). Format: see src/routes/collect.js. */
  function qrParts() {
    const o = state.offline, st = o.st, qs = (state.unlocked && state.unlocked.questions) || state.questions || [];
    const list = qs.map((q) => {
      const v = st.answers && st.answers[q.id];
      if (v === undefined || v === null || String(v) === '') return '';
      if (q.type === 'TF') return v === 'TRUE' ? 'T' : v === 'FALSE' ? 'F' : String(v);
      return String(v);
    });
    while (list.length && list[list.length - 1] === '') list.pop();
    const flags = [st.voided ? 'v=' + st.voided.event : '', st.reloads ? 'r=' + st.reloads : '', st.cameraWarnings ? 'c=' + st.cameraWarnings : '',
      st.focusWarnings ? 'f=' + st.focusWarnings : '', (st.events || []).some((e) => e.event === 'CLOCK_CHANGED') ? 'k' : ''].filter(Boolean).join(',');
    const text = ['EW1', o.pkg.packageId, Math.round(st.finishedAt).toString(36), Math.round(st.startedAt).toString(36), st.receipt || '', flags, JSON.stringify(list)].join('~');
    const size = 280, n = Math.max(1, Math.ceil(text.length / size)), id8 = o.pkg.packageId.slice(0, 8);
    const out = [];
    for (let i = 0; i < n; i++) out.push('EWQ|' + (i + 1) + '|' + n + '|' + id8 + '|' + text.slice(i * size, (i + 1) * size));
    return out;
  }

  function showQr(i) {
    const parts = state.qrParts, k = ((i % parts.length) + parts.length) % parts.length;
    state.qrIndex = k;
    const qr = window.qrcode(0, 'L');
    if (window.qrcode.stringToBytesFuncs && window.qrcode.stringToBytesFuncs['UTF-8']) window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
    qr.addData(parts[k], 'Byte');
    qr.make();
    $('qrImg').src = qr.createDataURL(Math.max(4, Math.floor(420 / (qr.getModuleCount() + 8))), 4);
    $('qrPart').textContent = parts.length > 1 ? 'Code ' + (k + 1) + ' of ' + parts.length + ': it changes by itself every few seconds; keep showing it until all are scanned.' : '';
    $('qrNext').hidden = parts.length < 2;
  }

  function showOfflineFinished() {
    const st = state.offline.st;
    show('pending');
    $('qrBox').hidden = !(window.qrcode && st.status === 'FINISHED' && state.unlocked);
    $('qrArea').hidden = true;
    $('pendingReceipt').hidden = !st.receipt;
    $('pendingReceipt').innerHTML = 'Your receipt code<b>' + (st.receipt || '') + '</b><span class="small">Show it to your teacher (or write it on the attendance sheet).</span>';
    $('pendingKeep').innerHTML = '<b>Your answers stay on this device</b>, even if you close this page. To send them, keep this page open until you have internet, ' +
      'or open this exam link again later (in this same browser) when you are online.';
    syncOffline();
  }

  async function syncOffline() {
    const o = state.offline;
    if (!o || !o.st || o.syncing || !['FINISHED', 'VOIDED'].includes(o.st.status)) return;
    o.syncing = true;
    if (!$('screen-pending').hidden) $('pendingStatus').textContent = 'Sending your answers…';
    const st = o.st;
    try {
      const r = await api('offlineSubmit', {
        packageId: o.pkg.packageId, answers: st.answers || {}, startedAt: st.startedAt, finishedAt: st.finishedAt, receipt: st.receipt || '',
        events: st.events || [], voided: st.voided || null, reloads: st.reloads || 0, cameraWarnings: st.cameraWarnings || 0, focusWarnings: st.focusWarnings || 0,
        env: { userAgent: navigator.userAgent, device: st.device || deviceType() },
      }, 2);
      // the pictures the camera took offline follow the answers
      const snaps = await idbDo('snaps', 'readonly', (s) => s.getAll()).catch(() => []);
      const keys = await idbDo('snaps', 'readonly', (s) => s.getAllKeys()).catch(() => []);
      for (let i = 0; i < snaps.length; i++) {
        if (snaps[i].packageId !== o.pkg.packageId) continue;
        try { await api('snapshot', { attemptId: o.pkg.packageId, event: snaps[i].event, dataUrl: snaps[i].dataUrl }, 2); } catch (e) { if (e.code === 'NETWORK') throw e; }
        await idbDo('snaps', 'readwrite', (s) => s.delete(keys[i])).catch(() => {});
      }
      st.status = 'SENT'; st.sentAt = Date.now(); offSave();
      await pkgDel('open:' + o.pkg.packageId);
      o.syncing = false;
      if (r.status === 'VOIDED') { $('voidOffline').className = 'notice ok'; $('voidOffline').textContent = '✓ This was sent to your teacher.'; return; }
      showResult(r);
      if (st.receipt) $('resultNote').textContent = ($('resultNote').textContent ? $('resultNote').textContent + ' ' : '') + 'Receipt code: ' + st.receipt + '.';
    } catch (e) {
      o.syncing = false;
      if (e.code === 'NETWORK') {
        if (!$('screen-pending').hidden) $('pendingStatus').textContent = 'No internet yet (last try ' + new Date().toLocaleTimeString() + '). Your answers will be sent when this device is online.';
        clearTimeout(o.syncTimer);
        o.syncTimer = setTimeout(syncOffline, 10000);
        return;
      }
      if (!$('screen-pending').hidden) $('pendingStatus').textContent = 'Could not send: ' + e.message + ' Please show this screen to your teacher.';
    }
  }

  // ───────── Exam ─────────

  function storageKey() { return 'exam-answers:' + state.attemptId; }

  function saveLocal() {
    if (state.offline) offSave();
    try { localStorage.setItem(storageKey(), JSON.stringify(state.answers)); } catch (e) { /* ignore */ }
  }

  function beginExam(r) {
    state.attemptId = r.attemptId;
    state.cam.warnings = r.cameraWarningsUsed || 0;
    state.focusWarnings = r.focusWarningsUsed || 0;
    state.student = { id: r.studentId, name: r.studentName };
    state.questions = r.questions;
    state.answers = {};
    if (r.resumed) {
      try { state.answers = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {}; } catch (e) { state.answers = {}; }
      if (r.draftAnswers && typeof r.draftAnswers === 'object') state.answers = Object.assign({}, r.draftAnswers, state.answers);
    }
    state.endAt = r.remainingMs === null || r.remainingMs === undefined ? null : Date.now() + r.remainingMs;
    // Skip warnings longer than the time available (no "5 minutes left" on a 3-minute exam)
    if (state.endAt !== null) (state.rules.timeWarnings || []).forEach((m) => { if (m * 60000 >= r.remainingMs) state.warned.add(m); });

    state.oneAtATime = state.info.exam.displayMode === 'ONE';
    state.allowBack = !state.oneAtATime || state.info.exam.allowBack !== false;
    state.locked = new Set(state.allowBack ? [] : (r.lockedIds || []));
    const firstOpen = state.questions.findIndex((q) => !state.locked.has(q.id));
    state.index = firstOpen === -1 ? state.questions.length - 1 : firstOpen;

    $('examTitle2').textContent = state.info.exam.title;
    $('studentLine').textContent = state.student.name + ' · ' + state.student.id + (r.isRetake ? ' · Retake' : '') + (r.resumed ? ' · Resumed' : '');
    renderQuestions();
    loadDriveImages();
    show('exam');
    if (state.oneAtATime) setupPager();
    if (state.rules.blockCopyPaste) document.body.classList.add('locked');
    state.active = true;
    if (window.ExamCamera && window.ExamCamera.allowHead) window.ExamCamera.allowHead(state.rules.headDetection !== false);
    if (state.cam.required && !state.cam.continuous) {
      window.ExamCamera.stop(); // face was checked at the start only
    } else if (state.cam.continuous) {
      $('camFloat').appendChild($('camBox')); // moving the element pauses it, so resume
      $('camFloat').hidden = false;
      const preview = state.info.exam.cameraPreview !== false;
      $('camFloat').classList.toggle('preview-off', !preview);
      $('camIndicator').hidden = preview;
      window.ExamCamera.resume();
      startRandomSnapshots();
    }
    tick();
    state.timerId = setInterval(tick, 250);
    state.lastOkAt = Date.now();
    if (state.rules.reconnectSeconds > 0 || keepGoing()) state.pingId = setInterval(ping, 20000);
    paintSaveState();
    if (r.resumed && state.rules.reconnectSeconds > 0) {
      const w = $('timeWarning');
      w.hidden = false; w.className = 'notice';
      w.textContent = 'Reconnected — you can continue. Reconnects used: ' + r.reconnects + ' of ' + state.rules.maxReconnects + '. Your timer kept running while you were away.';
    }
    // A monitor may have been connected while the start request was in flight
    checkMonitorDuringExam();
  }

  function renderQuestions() {
    const ol = $('questions');
    ol.textContent = '';
    state.questions.forEach((q, qi) => {
      const li = document.createElement('li');
      li.className = 'card question';
      li.dataset.id = q.id;

      const head = document.createElement('div');
      head.className = 'q-head';
      const num = document.createElement('span'); num.className = 'q-num';
      num.textContent = 'Question ' + (qi + 1);
      const meta = document.createElement('span'); meta.className = 'q-meta';
      meta.textContent = ({ MC: 'Multiple choice', TF: 'True or false', FIB: 'Fill in the blank', ESSAY: 'Essay' }[q.type]) +
        ' · ' + q.points + (q.points === 1 ? ' point' : ' points');
      head.append(num, meta);
      li.appendChild(head);

      const text = document.createElement('p');
      text.className = 'q-text';
      li.appendChild(text);
      if (q.image) li.appendChild(questionImage(q));

      const saved = state.answers[q.id];

      const nBlanks = q.type === 'FIB' ? (q.text.match(/_{3,}/g) || []).length : 0;
      if (nBlanks > 1) {
        // several blanks: the explanation on top, then one answer line per blank (a) … = [box] unit); the answer is a list
        let vals = [];
        try { vals = JSON.parse(saved || '[]'); } catch (e) { vals = []; }
        if (!Array.isArray(vals)) vals = [];
        const bl = EWQ.blankLinesEl(q.text, vals, (v) => setAnswer(q.id, JSON.stringify(v)), { idPrefix: 'q' + qi });
        EWQ.setText(text, bl.stem);
        if (!bl.stem) text.hidden = true;
        li.appendChild(bl.el);
      } else if (q.type === 'FIB') {
        const input = document.createElement('input');
        input.className = 'blank';
        input.setAttribute('aria-label', 'Your answer');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = saved || '';
        input.addEventListener('input', () => setAnswer(q.id, input.value));
        const parts = q.text.split(/_{3,}/);
        if (parts.length > 1) {
          text.append(parts[0], input, parts.slice(1).join('____'));
          EWQ.render(text);
        } else {
          EWQ.setText(text, q.text);
          input.style.width = '100%';
          input.style.margin = '0';
          li.appendChild(input);
        }
      } else {
        EWQ.setText(text, q.text);
      }

      if (q.type === 'MC' || q.type === 'TF') {
        const opts = q.type === 'MC'
          ? q.choices.map((c, i) => ({ value: c.key, label: c.text, letter: String.fromCharCode(65 + i) }))
          : [{ value: 'TRUE', label: 'True' }, { value: 'FALSE', label: 'False' }];
        const wrap = document.createElement('div');
        wrap.className = 'choices';
        wrap.setAttribute('role', 'radiogroup');
        opts.forEach((o) => {
          const lab = document.createElement('label');
          lab.className = 'choice';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'q_' + q.id;
          input.value = o.value;
          input.checked = saved === o.value;
          input.addEventListener('change', () => {
            setAnswer(q.id, o.value);
            wrap.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', c.contains(input)));
          });
          lab.appendChild(input);
          if (o.letter) { const l = document.createElement('span'); l.className = 'letter'; l.textContent = o.letter + '.'; lab.appendChild(l); }
          const t = document.createElement('span'); EWQ.setText(t, o.label); lab.appendChild(t);
          if (input.checked) lab.classList.add('selected');
          wrap.appendChild(lab);
        });
        li.appendChild(wrap);
      }

      if (q.type === 'ESSAY') {
        const ta = document.createElement('textarea');
        ta.className = 'essay';
        ta.setAttribute('aria-label', 'Your answer');
        ta.maxLength = 20000;
        ta.value = saved || '';
        const wc = document.createElement('div');
        wc.className = 'wordcount';
        const count = () => { const n = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0; wc.textContent = n + (n === 1 ? ' word' : ' words'); };
        ta.addEventListener('input', () => { setAnswer(q.id, ta.value); count(); });
        count();
        li.append(ta, wc);
      }

      ol.appendChild(li);
    });
    updateProgress();
  }

  // ───────── Question pictures ─────────

  /** A picture under the question text. Drive pictures arrive from the server after the exam starts. */
  function questionImage(q) {
    const fig = document.createElement('figure');
    fig.className = 'q-image';
    fig.dataset.id = q.id;
    if (q.image.src) {
      showImage(fig, q.image.src, false);
    } else {
      const ph = document.createElement('div');
      ph.className = 'img-loading';
      ph.textContent = 'Loading picture…';
      fig.appendChild(ph);
    }
    return fig;
  }

  function showImage(fig, src, fromServer) {
    fig.textContent = '';
    const img = document.createElement('img');
    img.alt = 'Picture for this question';
    img.draggable = false;
    img.addEventListener('click', () => openZoom(img.src));
    img.addEventListener('error', () => imageFailed(fig, fromServer ? null : src));
    img.src = src;
    const cap = document.createElement('figcaption');
    cap.textContent = 'Tap or click the picture to enlarge it';
    fig.append(img, cap);
  }

  function imageFailed(fig, retrySrc) {
    fig.textContent = '';
    const box = document.createElement('div');
    box.className = 'img-error';
    box.textContent = 'The picture for this question could not be loaded.';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Try again';
    btn.addEventListener('click', () => {
      if (retrySrc) showImage(fig, retrySrc + (retrySrc.indexOf('?') === -1 ? '?' : '&') + 'retry=' + Date.now(), false);
      else fetchDriveImage(fig);
    });
    box.appendChild(btn);
    fig.appendChild(box);
  }

  function fetchDriveImage(fig) {
    fig.textContent = '';
    const ph = document.createElement('div');
    ph.className = 'img-loading'; ph.textContent = 'Loading picture…';
    fig.appendChild(ph);
    return api('image', { attemptId: state.attemptId, questionId: fig.dataset.id }, 3)
      .then((r) => showImage(fig, r.dataUrl, true))
      .catch((e) => {
        if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
        imageFailed(fig, null);
        if (e.code === 'IMAGE_TOO_LARGE' || e.code === 'IMAGE_UNAVAILABLE') fig.querySelector('.img-error').firstChild.textContent = e.message + ' Please tell your instructor.';
      });
  }

  /** Loads Drive pictures two at a time, in question order (the current question first). */
  function loadDriveImages() {
    const figs = Array.from(document.querySelectorAll('.q-image')).filter((f) => f.querySelector('.img-loading'));
    if (state.oneAtATime) {
      const cur = state.questions[state.index] && state.questions[state.index].id;
      figs.sort((a, b) => (a.dataset.id === cur ? -1 : b.dataset.id === cur ? 1 : 0));
    }
    let i = 0;
    const next = () => (i < figs.length && !state.voided ? fetchDriveImage(figs[i++]).then(next) : null);
    next(); next();
  }

  function openZoom(src) {
    $('imgZoomImg').src = src;
    $('imgZoom').hidden = false;
    $('imgZoomClose').focus();
  }

  function closeZoom() {
    $('imgZoom').hidden = true;
    $('imgZoomImg').removeAttribute('src');
  }

  function setAnswer(id, value) {
    state.answers[id] = value;
    state.answersVer++;
    saveLocal();
    updateProgress();
    paintSaveState();
  }

  /** "✓ Saved" when the server has the latest answers; "Saved on this device" while offline or not sent yet. */
  function paintSaveState() {
    const el = $('saveState');
    if (!keepGoing() || !state.active) { el.hidden = true; return; }
    el.hidden = false;
    if (state.offline) { el.hidden = false; el.className = 'save-state wait'; el.textContent = '📴 Offline exam · saved on this device'; return; }
    const offline = state.offlineSince !== null;
    const synced = state.savedVer >= state.answersVer;
    el.className = 'save-state ' + (offline ? 'wait' : synced ? 'ok' : '');
    el.textContent = offline ? '💾 Saved on this device' : synced ? '✓ Saved' : 'Saving…';
    el.title = offline ? 'No internet: your answers are kept on this device and sent when the internet is back.' : '';
  }

  function isAnswered(id) {
    const v = state.answers[id];
    if (v === undefined || v === null || String(v).trim() === '') return false;
    if (String(v).charAt(0) === '[') { // several blanks: answered when every blank is filled
      try { const a = JSON.parse(v); if (Array.isArray(a)) return a.length > 0 && a.every((x) => String(x).trim() !== '') && a.length >= ((state.questions.find((q) => q.id === id) || {}).text || '').split(/_{3,}/).length - 1; } catch (e) { /* plain text */ }
    }
    return true;
  }

  function updateProgress() {
    const n = state.questions.filter((q) => isAnswered(q.id)).length;
    const t = n + ' / ' + state.questions.length + ' answered';
    $('progress').textContent = t;
    $('progress2').textContent = t;
    document.querySelectorAll('.question').forEach((li) => li.classList.toggle('answered', isAnswered(li.dataset.id)));
    document.querySelectorAll('#palette button').forEach((b) => b.classList.toggle('answered', isAnswered(b.dataset.id)));
  }

  // ───────── One question at a time ─────────

  function setupPager() {
    $('pager').hidden = false;
    $('submitBar').hidden = true;
    const pal = $('palette');
    pal.textContent = '';
    pal.hidden = !state.allowBack;
    if (state.allowBack) {
      state.questions.forEach((q, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(i + 1);
        b.dataset.id = q.id;
        b.setAttribute('aria-label', 'Go to question ' + (i + 1));
        b.addEventListener('click', () => showQuestion(i));
        pal.appendChild(b);
      });
    }
    state.locked.forEach((id) => lockInputs(id));
    updateProgress();
    showQuestion(state.index);
  }

  function showQuestion(i) {
    state.index = Math.max(0, Math.min(i, state.questions.length - 1));
    const id = state.questions[state.index].id;
    document.querySelectorAll('.question').forEach((li) => { li.hidden = li.dataset.id !== id; });
    document.querySelectorAll('#palette button').forEach((b, j) => b.classList.toggle('current', j === state.index));
    const last = state.index === state.questions.length - 1;
    $('pagerCount').textContent = 'Question ' + (state.index + 1) + ' of ' + state.questions.length;
    $('prevBtn').hidden = !state.allowBack;
    $('prevBtn').disabled = state.index === 0;
    $('nextBtn').textContent = last ? 'Submit exam' : 'Next →';
    const qs = state.info.exam.questionSeconds || 0;
    state.qEndAt = qs > 0 ? Date.now() + qs * 1000 : null;
    $('qTimer').hidden = !(qs > 0);
    window.scrollTo(0, 0);
  }

  function lockInputs(id) {
    const li = document.querySelector('.question[data-id="' + CSS.escape(id) + '"]');
    if (!li) return;
    li.classList.add('locked');
    li.querySelectorAll('input, textarea').forEach((el) => { el.disabled = true; });
  }

  function goNext() {
    if (!state.active) return;
    const q = state.questions[state.index];
    const last = state.index === state.questions.length - 1;
    if (last) { askSubmit(); return; }
    const advance = () => advanceFrom(q);
    if (!state.allowBack && !isAnswered(q.id)) {
      confirmBox('Skip this question?', 'You have not answered Question ' + (state.index + 1) +
        '. You cannot come back to it after moving on.', 'Skip it', 'Go back', advance);
      return;
    }
    advance();
  }

  function advanceFrom(q) {
    if (!state.active || state.questions[state.index] !== q) return;
    if (!state.allowBack) {
      state.locked.add(q.id);
      lockInputs(q.id);
      const value = state.answers[q.id] === undefined ? '' : state.answers[q.id];
      sendReliably('lockAnswer', { attemptId: state.attemptId, questionId: q.id, value });
    }
    showQuestion(state.index + 1);
  }

  /** Time per question ran out: move on (or submit on the last question). */
  function questionTimeUp() {
    state.qEndAt = null;
    const q = state.questions[state.index];
    if (confirmAction) { $('confirmModal').hidden = true; confirmAction = null; }
    if (state.index === state.questions.length - 1) { submitExam(true); return; }
    advanceFrom(q);
  }

  function goPrev() {
    if (state.active && state.allowBack) showQuestion(state.index - 1);
  }

  let confirmAction = null;
  function confirmBox(title, text, yesLabel, noLabel, onYes) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel;
    $('confirmNo').textContent = noLabel;
    confirmAction = onYes;
    $('confirmModal').hidden = false;
    $('confirmNo').focus();
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(sec);
  }

  /** "2 d 03:15:20", "1:05:30", "04:59" */
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(s / 86400);
    return (d ? d + (d === 1 ? ' day ' : ' days ') : '') + fmtTime((s % 86400) * 1000);
  }

  /** 60 → "1 minute", 90 → "1 min 30 s", 45 → "45 seconds" */
  function fmtDuration(sec) {
    const m = Math.floor(sec / 60), r = sec % 60;
    if (!m) return sec + (sec === 1 ? ' second' : ' seconds');
    if (!r) return m + (m === 1 ? ' minute' : ' minutes');
    return m + ' min ' + r + ' s';
  }

  function tick() {
    if (!state.active) return;
    if (state.offline && state.offline.st) {
      const n = Date.now();
      if (state.lastTickWall && n < state.lastTickWall - 60000) offEvent('CLOCK_CHANGED', 'The device clock went back ' + Math.round((state.lastTickWall - n) / 60000) + ' min');
      state.lastTickWall = n;
      if (!state.lastOffSave || n - state.lastOffSave > 5000) { state.lastOffSave = n; offSave(); }
    }
    tickConnection();
    if (!state.active) return;
    if (state.qEndAt !== null) {
      const ql = state.qEndAt - Date.now();
      $('qTimer').textContent = '⏱ ' + fmtTime(ql);
      $('qTimer').classList.toggle('low', ql <= 10000);
      if (ql <= 0) { questionTimeUp(); return; }
    }
    const el = $('timer');
    if (state.endAt === null) { el.textContent = 'No time limit'; return; }
    const left = state.endAt - Date.now();
    el.textContent = fmtTime(left);
    el.classList.toggle('low', left <= 60000);
    // Teacher-chosen warnings, e.g. [10, 5, 1] minutes before the end
    const due = (state.rules.timeWarnings || []).filter((m) => left <= m * 60000 && !state.warned.has(m));
    if (due.length && left > 0) {
      const m = Math.min.apply(null, due);
      state.rules.timeWarnings.forEach((x) => { if (x >= m) state.warned.add(x); });
      const smallest = Math.min.apply(null, state.rules.timeWarnings);
      const warn = $('timeWarning');
      warn.hidden = false;
      warn.className = m === smallest ? 'notice bad' : 'notice warn';
      warn.textContent = (m < 1 ? Math.round(m * 60) + ' seconds' : m + (m === 1 ? ' minute' : ' minutes')) +
        ' left. Your answers will be submitted automatically when time runs out.';
    }
    if (left <= 0) submitExam(true);
  }

  // ───────── Connection & reconnect ─────────

  const keepGoing = () => state.rules.keepGoingOffline !== false;

  function markOnline() {
    state.lastOkAt = Date.now();
    if (state.offlineSince !== null) {
      state.offlineSince = null;
      $('connBanner').hidden = true;
      $('connBanner').classList.remove('offline');
    }
    paintSaveState();
  }

  function markOffline(since) {
    if (state.offline) return; // an offline exam needs no internet
    if (state.offlineSince === null) state.offlineSince = since || Date.now();
    paintSaveState();
  }

  async function ping() {
    if (!state.active || !(state.rules.reconnectSeconds > 0 || keepGoing())) return;
    const ver = state.answersVer;
    try {
      const r = await api('ping', { attemptId: state.attemptId, pageToken: state.pageToken, answers: keepGoing() && ver > state.savedVer ? state.answers : undefined });
      if (r.saved) state.savedVer = Math.max(state.savedVer, ver);
      if (r.deadlineMs && state.endAt !== null) {
        const newEnd = r.deadlineMs - state.serverOffset;
        if (newEnd > state.endAt + 30000) {
          state.endAt = newEnd;
          state.warned.clear();
          (state.rules.timeWarnings || []).forEach((m) => { if (m * 60000 >= newEnd - Date.now()) state.warned.add(m); });
          const w = $('timeWarning'); w.hidden = false; w.className = 'notice';
          w.textContent = 'Your teacher gave you more time. New time left: ' + fmtTime(newEnd - Date.now()) + '.';
        }
      }
      markOnline();
      if (r.status === 'VOIDED') showVoid(null, 'Your exam was voided: ' + (r.reason || 'exam rules were broken') + '. Please inform your instructor.');
    } catch (e) {
      if (e.code === 'NETWORK') markOffline(state.lastOkAt);
    }
  }

  /**
   * Shows the "connection lost" banner. With "keep going offline" (the default) the exam simply continues: answers stay
   * on this device and are sent when the internet is back. Otherwise the exam is voided when the reconnect limit passes.
   */
  function tickConnection() {
    if (state.offlineSince === null) return;
    if (keepGoing()) {
      const b = $('connBanner');
      b.hidden = false; b.classList.add('offline');
      b.textContent = '📶 No internet for ' + fmtTime(Date.now() - state.offlineSince) + '. Keep this page open and keep answering: ' +
        'your answers are saved on this device and will be sent automatically when the internet is back.';
      if (Date.now() - (state.lastRetryAt || 0) > 5000) { state.lastRetryAt = Date.now(); ping(); }
      return;
    }
    const rs = state.rules.reconnectSeconds || 0;
    if (!(rs > 0)) return;
    const left = rs * 1000 - (Date.now() - state.offlineSince);
    const b = $('connBanner');
    b.hidden = false;
    b.textContent = '⚠ Connection lost — trying to reconnect… Keep this page open. ' +
      'If you are not back online within ' + fmtTime(left) + ', your exam will be voided.';
    if (Date.now() - (state.lastRetryAt || 0) > 5000) { state.lastRetryAt = Date.now(); ping(); }
    if (left <= 0 && !state.submitting) voidExam('CONNECTION_LOST', 'Offline for more than ' + rs + ' s.');
  }

  /** Sends now, or keeps retrying every 5 s while offline (as long as the page is open when "keep going offline" is on). */
  function sendReliably(action, payload, onDone) {
    let tries = 0;
    const attempt = () => api(action, payload).then((r) => { markOnline(); if (onDone) onDone(r); return r; }).catch((e) => {
      if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
      if (e.code !== 'NETWORK') return;
      markOffline(state.lastOkAt);
      if (++tries < (keepGoing() ? 100000 : 120)) setTimeout(attempt, 5000);
      else beacon(action, payload);
    });
    attempt();
  }

  // ───────── Submit ─────────

  function askSubmit() {
    const unanswered = state.questions.map((q, i) => (isAnswered(q.id) ? null : i + 1)).filter(Boolean);
    confirmBox('Submit your exam?', unanswered.length
      ? 'You have ' + unanswered.length + ' unanswered question(s): #' + unanswered.join(', #') + '. You cannot change your answers after submitting.'
      : 'You answered all questions. You cannot change your answers after submitting.',
    'Submit now', 'Keep answering', () => submitExam(false));
  }

  async function submitExam(auto) {
    if (!state.active || state.submitting) return;
    state.submitting = true;
    $('confirmModal').hidden = true;
    $('submitBtn').disabled = true;
    if (state.offline) { await finishPackageExam(); state.submitting = false; return; }
    busy(true, auto ? 'Time is up — submitting your answers…' : 'Submitting your answers…');
    const finishedAt = Date.now() + state.serverOffset;
    try {
      const r = await api('submit', { attemptId: state.attemptId, answers: state.answers, violations: state.violations, pageToken: state.pageToken, finishedAt }, 4);
      finishExam();
      busy(false);
      showResult(r);
    } catch (e) {
      busy(false);
      state.submitting = false;
      if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
      if (e.code === 'ALREADY_SUBMITTED') { finishExam(); showResult({ showScore: false }); return; }
      if (e.code === 'NETWORK' && keepGoing()) { finishOffline(finishedAt); return; }
      $('submitBtn').disabled = false;
      const warn = $('timeWarning');
      warn.hidden = false; warn.className = 'notice bad';
      warn.textContent = 'Your answers were NOT submitted yet: ' + e.message + ' Stay on this page and click "Submit exam" again.';
      window.scrollTo(0, 0);
      if (auto) setTimeout(() => submitExam(true), 5000);
    }
  }

  // ── Finished without internet: the answers are frozen and sent when the internet is back ──
  const pendingKey = () => 'exam-pending:' + state.examId;

  function finishOffline(finishedAt) {
    const pending = { attemptId: state.attemptId, pageToken: state.pageToken, answers: state.answers, violations: state.violations, finishedAt, name: state.student && state.student.name };
    try { localStorage.setItem(pendingKey(), JSON.stringify(pending)); } catch (e) { /* ignore */ }
    finishExam();
    show('pending');
    sendPending(pending);
  }

  async function sendPending(pending) {
    if (state.sendingPending) return;
    state.sendingPending = true;
    $('pendingStatus').textContent = 'Sending your answers…';
    try {
      const r = await api('submit', { attemptId: pending.attemptId, answers: pending.answers, violations: pending.violations, pageToken: pending.pageToken, finishedAt: pending.finishedAt }, 2);
      try { localStorage.removeItem(pendingKey()); } catch (e) { /* ignore */ }
      state.sendingPending = false;
      if (!state.student && pending.name) state.student = { name: pending.name };
      showResult(r);
    } catch (e) {
      state.sendingPending = false;
      if (e.code === 'NETWORK') {
        $('pendingStatus').textContent = 'Still no internet (last try ' + new Date().toLocaleTimeString() + '). Trying again every few seconds…';
        clearTimeout(state.pendingTimer);
        state.pendingTimer = setTimeout(() => sendPending(pendingFromStorage() || pending), 5000);
        return;
      }
      try { localStorage.removeItem(pendingKey()); } catch (err) { /* ignore */ }
      if (e.code === 'ALREADY_SUBMITTED') { showResult({ showScore: false }); return; }
      if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
      showError(e.message);
    }
  }

  /** A copy of the finished answers as a file, for the teacher to upload (Results → Answers → Upload an answer file). */
  function saveAnswerFile() {
    const o = state.offline;
    const p = pendingFromStorage() || (o && o.st ? { attemptId: o.pkg.packageId, answers: o.st.answers || {}, finishedAt: o.st.finishedAt || nowEst(), name: o.pkg.student.name, receipt: o.st.receipt } : null);
    if (!p) return;
    const file = { kind: 'exam-wizard-answers', version: 1, examId: state.examId, examTitle: state.info ? state.info.exam.title : '', attemptId: p.attemptId,
      student: state.student || { name: p.name }, answers: p.answers, finishedAt: new Date(p.finishedAt).toISOString(), finishedMs: p.finishedAt, receipt: p.receipt || null,
      offline: !!o, savedAt: new Date(Date.now() + state.serverOffset).toISOString() };
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    const who = String((state.student && (state.student.id || state.student.name)) || 'student').replace(/[^\w.-]+/g, '_');
    a.href = URL.createObjectURL(blob); a.download = 'answers-' + who + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function pendingFromStorage() {
    try { const p = JSON.parse(localStorage.getItem(pendingKey()) || 'null'); return p && p.attemptId ? p : null; } catch (e) { return null; }
  }

  function finishExam() {
    state.active = false;
    clearInterval(state.timerId);
    clearInterval(state.pingId);
    $('connBanner').hidden = true;
    stopCamera();
    closeZoom();
    document.body.classList.remove('locked');
    try { localStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
  }

  function showResult(r) {
    show('result');
    $('resultText').textContent = 'Thank you, ' + (state.student ? state.student.name : '') + '. Your answers have been recorded.';
    if (r.showScore) {
      $('resultScore').hidden = false;
      $('resultScore').textContent = r.score + ' / ' + r.maxScore + ' (' + r.percent + '%)';
      $('resultNote').textContent = r.pendingEssays
        ? r.pendingEssays + ' essay question(s) still need to be graded by your instructor, so your final score may change.'
        : '';
      if (r.rank) {
        const k = r.rank;
        $('resultRank').hidden = false;
        $('resultRank').innerHTML = '<b>Rank = ' + k.rank + '/' + k.total + '</b> · Percentile rank = ' + k.percentile + '<br><span class="small muted">Mean = ' + k.mean + '% · Median = ' + k.median +
          '% · StdDev = ' + k.sd + (k.current ? '<br>Current: these change while classmates are still taking the exam. See My Exams later.' : '') + '</span>';
      }
    } else {
      $('resultNote').textContent = 'Your instructor will release the results.';
    }
  }

  // ───────── Violations ─────────

  const REASONS = {
    TAB_SWITCH: 'You switched to another tab or minimized the exam window.',
    LEFT_WINDOW: 'You left the exam window (for example, Alt+Tab to another application).',
    SECOND_MONITOR: 'A second monitor was connected during the exam.',
    PAGE_CLOSED: 'You closed or reloaded the exam page.',
    NO_FACE: 'Your face was not visible to the camera.',
    CAMERA_BLOCKED: 'Your camera was covered or blocked.',
    MULTIPLE_FACES: 'More than one person was in front of the camera.',
    PHONE_DETECTED: 'A mobile phone was seen on camera. If it was your calculator, keep it flat on your desk, below the camera.',
    CAMERA_OFF: 'Your camera was turned off or disconnected.',
    CONNECTION_LOST: 'Your internet connection was lost for longer than allowed.',
  };

  function voidExam(event, detail) {
    if (!state.active || state.voided || state.unloading) return;
    state.voided = true;
    state.active = false;
    clearInterval(state.timerId);
    state.violations.push({ event, detail, at: new Date().toISOString() });
    const payload = { attemptId: state.attemptId, event, detail, final: true };
    if (!state.offline) { try { localStorage.setItem('exam-void:' + state.examId, JSON.stringify(Object.assign({}, payload, { resend: true }))); } catch (e) { /* ignore */ } }

    if (document.visibilityState === 'hidden') {
      // The page may be closing: a beacon is delivered even if the tab is gone.
      if (!beacon('violation', payload)) sendReliably('violation', payload);
    } else {
      // once the server has the void, forget the copy kept here (otherwise it would be sent again after the teacher lets the student continue)
      sendReliably('violation', payload, () => { try { localStorage.removeItem('exam-void:' + state.examId); } catch (e) { /* ignore */ } });
    }
    try { localStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
    showVoid(event);
  }

  function stopCamera() {
    if (!state.cam.required) return;
    window.ExamCamera.stop();
    $('camFloat').hidden = true;
    $('camIndicator').hidden = true;
    $('faceWarnModal').hidden = true;
    state.cam.warningOpen = false;
  }

  function showVoid(event, serverMessage) {
    state.active = false;
    state.voided = true;
    clearInterval(state.timerId);
    clearInterval(state.pingId);
    $('connBanner').hidden = true;
    stopCamera();
    $('confirmModal').hidden = true;
    busy(false);
    $('voidReason').textContent = event ? REASONS[event] : (serverMessage || 'Exam rules were broken.');
    $('voidStudent').textContent = state.student ? state.student.name + ' (' + state.student.id + ')' : '';
    $('voidExam').textContent = state.info ? state.info.exam.title : '';
    const st0 = state.offline && state.offline.st;
    $('voidTime').textContent = new Date(st0 && st0.finishedAt ? st0.finishedAt - (state.serverOffset || 0) : Date.now()).toLocaleString();
    $('voidRef').textContent = state.attemptId ? state.attemptId.slice(0, 8).toUpperCase() : '';
    $('questions').textContent = ''; // hide the questions
    closeZoom();
    $('voidModal').hidden = false;
    if (state.offline && state.offline.st) {
      $('voidOffline').hidden = false;
      $('voidOffline').className = 'notice warn';
      $('voidOffline').textContent = st0.status === 'SENT' ? '✓ This was sent to your teacher.' : 'Offline exam: this is sent to your teacher automatically when this device is online. Keep this page open, or open the exam again later with internet.';
      syncOffline();
    }
  }

  let blurTimer = null;
  let unfocusedSince = null;

  const reconnectOn = () => state.rules.reconnectSeconds > 0;

  function onHidden() {
    if (!state.active || document.visibilityState !== 'hidden') return;
    const go = () => leftExam('TAB_SWITCH', 'Page became hidden (tab switch, minimize, or another window covered it).');
    if (!reconnectOn()) { go(); return; }
    // A reload or closing the page also hides it; wait a moment to tell them apart.
    if (!state.hiddenTimer) state.hiddenTimer = setTimeout(() => { state.hiddenTimer = null; go(); }, 500);
  }

  /** Page is closing or reloading. With reconnect on, this starts the reconnect window instead of voiding. */
  function onLeaving() {
    if (!state.active || state.disconnectSent) return;
    if (!reconnectOn()) { voidExam('PAGE_CLOSED', 'pagehide'); return; }
    state.unloading = true;
    state.disconnectSent = true;
    clearTimeout(state.hiddenTimer);
    clearTimeout(blurTimer);
    clearTimeout(state.blurVoidTimer);
    beacon('disconnect', { attemptId: state.attemptId, detail: 'page closed or reloaded' });
  }

  function onBlur() {
    if (!state.active) return;
    const grace = state.rules.blurGraceSeconds * 1000;
    if (grace <= 0) {
      if (!reconnectOn()) { leftExam('LEFT_WINDOW', 'Exam window lost focus.'); return; }
      // Wait a moment so a reload (reconnect allowed) is not counted; coming back quickly still counts.
      clearTimeout(state.blurVoidTimer);
      state.blurVoidTimer = setTimeout(() => leftExam('LEFT_WINDOW', 'Exam window lost focus.'), 500);
      return;
    }
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (state.active && !document.hasFocus()) leftExam('LEFT_WINDOW', 'Exam window lost focus for more than ' + state.rules.blurGraceSeconds + ' s.');
    }, grace);
  }

  function onFocus() { clearTimeout(blurTimer); unfocusedSince = null; backInExam(); }

  // ── Tab/window warnings (the exam's "Tab/window warnings" setting; 0 = leaving voids at once) ──
  const AWAY_LIMIT_MS = 60000; // with warnings on, staying away longer than this voids the exam
  const focusAllowed = () => { const n = Number(state.rules.focusWarnings); return Number.isFinite(n) && n > 0 ? n : 0; };

  /** The student left the exam (tab switch, another window). One warning per time away, then void. */
  function leftExam(event, detail) {
    if (!state.active || state.voided || state.unloading) return;
    if (state.awaySince) return; // already counted this time away
    if ((state.focusWarnings || 0) >= focusAllowed()) { voidExam(event, detail); return; }
    state.focusWarnings = (state.focusWarnings || 0) + 1;
    state.awaySince = Date.now();
    const payload = { attemptId: state.attemptId, event, detail };
    api('violation', payload, 3)
      .then((r) => { if (r.status === 'VOIDED') { state.violations.push({ event, detail }); showVoid(event); } })
      .catch((e) => { if (e.code === 'VOIDED') showVoid(event); else if (!beacon('violation', payload)) sendReliably('violation', payload); });
    showFocusWarning(event);
  }

  /** Back on the exam page: the next time away counts as a new warning. */
  function backInExam() {
    if (!state.awaySince) return;
    setTimeout(() => { if (document.visibilityState === 'visible' && document.hasFocus()) state.awaySince = null; }, 800);
  }

  function showFocusWarning(event) {
    const n = focusAllowed(), used = state.focusWarnings, left = n - used;
    $('focusWarnTitle').textContent = '⚠ You left the exam — warning ' + used + ' of ' + n;
    $('focusWarnReason').textContent = event === 'TAB_SWITCH' ? 'The exam page was hidden (another tab, or the browser was minimized).' : 'Another window or app was in front of the exam.';
    $('focusWarnNext').textContent = left === 0 ? 'This was your last warning: if you leave the exam again, it will be voided.'
      : 'You have ' + left + ' warning' + (left === 1 ? '' : 's') + ' left. After that, leaving the exam voids it.';
    $('focusWarnModal').hidden = false;
  }

  function checkMonitorDuringExam() {
    if (state.active && deviceType() === 'computer' && monitorStatus() === 'multiple') {
      voidExam('SECOND_MONITOR', 'screen.isExtended became true during the exam.');
    }
  }

  /** Backup checks every second, in case an event was missed. */
  function watchdog() {
    if (state.active) {
      checkMonitorDuringExam();
      if (!state.active) return;
      if (state.awaySince && Date.now() - state.awaySince > AWAY_LIMIT_MS) { voidExam('LEFT_WINDOW', 'Away from the exam for more than ' + AWAY_LIMIT_MS / 1000 + ' s.'); return; }
      if (document.visibilityState === 'hidden') { onHidden(); return; }
      if (!document.hasFocus() && !state.unloading) {
        if (unfocusedSince === null) unfocusedSince = Date.now();
        const limit = Math.max(1000, state.rules.blurGraceSeconds * 1000);
        if (Date.now() - unfocusedSince >= limit) leftExam('LEFT_WINDOW', 'Exam window did not have focus.');
      } else {
        unfocusedSince = null;
      }
    } else if (state.info && !state.attemptId && !$('screen-rules').hidden) {
      refreshStartButton();
    }
  }

  function blockIfActive(e) {
    if (state.active && state.rules.blockCopyPaste) e.preventDefault();
  }

  // ───────── Boot ─────────

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  let errorsSent = 0;
  function reportError(message, where) {
    if (!state.attemptId || errorsSent >= 3) return;
    errorsSent++;
    api('clientError', { attemptId: state.attemptId, message: String(message || 'Unknown error').slice(0, 300), where: String(where || '').slice(0, 150) }).catch(() => {});
  }

  async function boot() {
    window.addEventListener('error', (e) => reportError(e.message, (e.filename || '').split('/').pop() + ':' + (e.lineno || '')));
    window.addEventListener('unhandledrejection', (e) => reportError(e.reason && (e.reason.message || String(e.reason)), 'promise'));
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onLeaving);
    window.addEventListener('beforeunload', (e) => {
      if (!state.active) return;
      if (reconnectOn()) { onLeaving(); return; } // reload allowed: reconnect within the time limit
      e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('offline', () => { if (state.active && (reconnectOn() || keepGoing())) markOffline(Date.now()); });
    window.addEventListener('online', () => {
      if (state.offline && state.offline.st && ['FINISHED', 'VOIDED'].includes(state.offline.st.status)) { clearTimeout(state.offline.syncTimer); syncOffline(); }
      if (state.active) ping();
      const p = !$('screen-pending').hidden && pendingFromStorage();
      if (p) { clearTimeout(state.pendingTimer); sendPending(p); }
    });
    $('pendingFile').addEventListener('click', saveAnswerFile);
    $('qrShow').addEventListener('click', () => {
      state.qrParts = qrParts();
      $('qrArea').hidden = false; $('qrShow').hidden = true;
      showQr(0);
      setTimeout(() => $('qrImg').scrollIntoView({ block: 'center' }), 50);
      clearInterval(state.qrTimer);
      if (state.qrParts.length > 1) state.qrTimer = setInterval(() => showQr(state.qrIndex + 1), 2500);
    });
    $('qrNext').addEventListener('click', () => showQr(state.qrIndex + 1));
    $('pendingRetry').addEventListener('click', () => { if (state.offline) syncOffline(); });
    $('pendingRetry').addEventListener('click', () => { const p = pendingFromStorage(); if (p) { clearTimeout(state.pendingTimer); sendPending(p); } });
    if (window.screen && typeof window.screen.addEventListener === 'function') {
      window.screen.addEventListener('change', () => { checkMonitorDuringExam(); if (!state.attemptId && state.info) refreshStartButton(); });
    }
    ['copy', 'cut', 'paste', 'contextmenu', 'drop', 'dragstart'].forEach((t) => document.addEventListener(t, blockIfActive));
    setInterval(watchdog, 1000);

    $('startForm').addEventListener('submit', onStart);
    $('agree').addEventListener('change', refreshStartButton);
    $('submitBtn').addEventListener('click', askSubmit);
    $('confirmNo').addEventListener('click', () => { $('confirmModal').hidden = true; });
    $('confirmYes').addEventListener('click', () => {
      $('confirmModal').hidden = true;
      const f = confirmAction; confirmAction = null;
      if (f) f();
    });
    $('nextBtn').addEventListener('click', goNext);
    $('camBtn').addEventListener('click', turnOnCamera);
    $('faceWarnOk').addEventListener('click', closeFaceWarning);
    $('focusWarnOk').addEventListener('click', () => { $('focusWarnModal').hidden = true; backInExam(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') backInExam(); });
    $('camRestartBtn').addEventListener('click', () => { window.ExamCamera.restart().catch(() => {}); });
    $('prevBtn').addEventListener('click', goPrev);
    $('imgZoom').addEventListener('click', closeZoom);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('imgZoom').hidden) closeZoom(); });

    if (!state.examId) {
      showError('This link has no exam in it. Go back to My Exams and choose the exam there.');
      return;
    }
    const left = pendingFromStorage();
    if (left) { show('pending'); sendPending(left); return; } // finished earlier without internet: send those answers first
    // an exam voided here earlier while the internet was off: tell the server now (the void must not get lost)
    let lostVoid = null;
    try { lostVoid = JSON.parse(localStorage.getItem('exam-void:' + state.examId) || 'null'); } catch (e) { lostVoid = null; }
    if (lostVoid && lostVoid.attemptId) {
      try { await api('violation', lostVoid, 2); localStorage.removeItem('exam-void:' + state.examId); } catch (e) { if (e.code !== 'NETWORK') { try { localStorage.removeItem('exam-void:' + state.examId); } catch (err) { /* ignore */ } } }
    }
    const pk = await pkgGet(state.examId);
    const pst = pk && offLoad(pk.packageId);
    if (pk && (!pst || pst.status === 'IN_PROGRESS')) { renderOfflineRules(pk); return; } // downloaded here: always the downloaded copy
    if (pk && pst && (pst.status === 'FINISHED' || pst.status === 'VOIDED')) {
      // finished offline earlier: send it now (or keep trying)
      state.offline = { pkg: pk, st: pst };
      state.serverOffset = pk.serverOffset || 0;
      state.attemptId = pk.packageId;
      state.student = pk.student;
      state.unlocked = await pkgGet('open:' + pk.packageId);
      if (pst.status === 'VOIDED') showVoid(pst.voided && REASONS[pst.voided.event] ? pst.voided.event : null, 'Your offline exam was voided.');
      else showOfflineFinished();
      return;
    }
    try {
      state.info = await api('getExam', { examId: state.examId }, 3);
      state.serverOffset = state.info.exam.serverNow - Date.now();
      renderRules();
      renderOfflineCard().then(() => {
        if (new URLSearchParams(location.search).get('download') === '1' && $('dlBtn') && !state.offline) $('dlBtn').click();
      }).catch(() => {});
    } catch (e) {
      if (e.code === 'NETWORK' && pk && !(pst && pst.status === 'SENT')) { renderOfflineRules(pk); return; }
      if (e.code === 'NETWORK') { showError('No internet connection.' + (pk ? ' Your answers for this exam were already sent.' : ' This exam was not downloaded on this device, so it needs internet.')); return; }
      showError(e.message);
    }
  }

  boot();
})();
