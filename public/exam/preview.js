/* Exam preview for teachers: the same look as the student exam screen, with an answer check.
 * Nothing is saved. Security checks, the camera and the timer are off. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const examId = new URLSearchParams(location.search).get('id') || '';
  const state = { mode: 'all', seed: String(Date.now()), answers: {}, questions: [], exam: null };
  const TYPE = { MC: 'Multiple choice', TF: 'True or false', FIB: 'Fill in the blank', ESSAY: 'Essay' };

  async function api(path, body) {
    const r = await fetch('/api/teacher/exams/' + encodeURIComponent(examId) + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' } : { 'X-Requested-With': 'fetch' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'The server did not answer. Try again.' }));
    if (!j.ok) {
      const e = new Error(r.status === 401 ? 'Please sign in as the teacher of this exam first.' : j.error || 'Something went wrong.');
      throw e;
    }
    return j;
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  async function load() {
    $('backBtn').href = '/teacher#exam/' + encodeURIComponent(examId);
    try {
      const r = await api('/preview?mode=' + state.mode + '&seed=' + encodeURIComponent(state.seed));
      state.exam = r.exam; state.questions = r.questions;
      renderHead(); renderQuestions(); clearResults();
      $('pvLoading').hidden = true; $('pvMain').hidden = false;
    } catch (e) {
      $('pvLoading').hidden = true; $('pvError').hidden = false; $('pvErrorText').textContent = e.message;
    }
  }

  function renderHead() {
    const x = state.exam;
    document.title = 'Preview: ' + x.title;
    $('pvTitle').textContent = x.title;
    $('pvClass').textContent = x.className + (x.published ? '' : ' · Draft (students cannot see it yet)');
    $('pvInstructions').textContent = x.instructions || '';
    $('pvInstructions').hidden = !x.instructions;
    const s = x.summary, chips = [];
    chips.push(s.poolSize ? s.count + ' questions per student (from ' + s.poolSize + ')' : s.count + ' questions');
    if (s.totalPoints !== null && s.totalPoints !== undefined) chips.push(s.totalPoints + ' points');
    chips.push(x.timeLimitMinutes ? x.timeLimitMinutes + ' min time limit' : 'No time limit');
    chips.push(x.displayMode === 'ONE' ? 'One question at a time' + (x.allowBack ? '' : ', no going back') : 'All questions on one page');
    if (x.hasPassword) chips.push('Password required');
    if (x.faceMode !== 'OFF') chips.push(x.faceMode === 'ALWAYS' ? 'Camera on all the time' : 'Camera check at start');
    $('pvChips').textContent = '';
    chips.forEach((c) => $('pvChips').appendChild(el('li', '', c)));
    const random = s.poolSize || (s.topicBreakdown && s.topicBreakdown.length);
    $('modeAll').textContent = 'All questions (' + x.poolSize + ')';
    $('modeAll').classList.toggle('on', state.mode === 'all');
    $('modeStudent').classList.toggle('on', state.mode === 'student');
    $('newSet').hidden = state.mode !== 'student';
    $('modeHint').textContent = state.mode === 'all'
      ? 'Every question in this exam, in your order, with choices unshuffled. Check the wording, pictures and answer keys.'
      : (random ? 'One random set, as a student would get it' : 'The questions as a student would get them') + (state.questions.length ? ' (shuffled if you turned shuffling on).' : '.');
  }

  function renderQuestions() {
    const ol = $('questions');
    ol.textContent = '';
    if (!state.questions.length) {
      const li = el('li', 'card'); li.appendChild(el('p', 'muted', 'This exam has no questions yet. Add some in the exam editor.')); ol.appendChild(li); return;
    }
    state.questions.forEach((q, qi) => {
      const li = el('li', 'card question'); li.dataset.id = q.id;
      const head = el('div', 'q-head');
      const num = el('span', 'q-num', 'Question ' + (qi + 1));
      num.appendChild(el('span', 'pv-id', (q.code ? q.code : '') + (q.topic ? ' · ' + q.topic : '')));
      const edit = el('a', 'pv-edit', 'Edit'); edit.href = '/teacher#questions/edit/' + q.id; edit.target = '_blank'; edit.rel = 'noopener';
      num.appendChild(edit);
      head.append(num, el('span', 'q-meta', TYPE[q.type] + ' · ' + q.points + (q.points === 1 ? ' point' : ' points')));
      li.appendChild(head);
      if (q.problems && q.problems.length) li.appendChild(el('div', 'notice bad pv-problem', '⚠ Problem with this question: ' + q.problems.join('; ') + '.'));

      const text = el('p', 'q-text');
      li.appendChild(text);
      if (q.image) li.appendChild(picture(q.image.src));
      const saved = state.answers[q.id];

      if (q.type === 'FIB') {
        const input = el('input', 'blank'); input.setAttribute('aria-label', 'Your answer'); input.autocomplete = 'off'; input.value = saved || '';
        input.addEventListener('input', () => { state.answers[q.id] = input.value; });
        const parts = q.text.split(/_{3,}/);
        if (parts.length > 1) text.append(parts[0], input, parts.slice(1).join('____'));
        else { text.textContent = q.text; input.style.width = '100%'; input.style.margin = '0'; li.appendChild(input); }
      } else text.textContent = q.text;

      if (q.type === 'MC' || q.type === 'TF') {
        const opts = q.type === 'MC' ? q.choices.map((c, i) => ({ value: c.key, label: c.text, letter: String.fromCharCode(65 + i) }))
          : [{ value: 'TRUE', label: 'True' }, { value: 'FALSE', label: 'False' }];
        const wrap = el('div', 'choices'); wrap.setAttribute('role', 'radiogroup');
        opts.forEach((o) => {
          const lab = el('label', 'choice');
          const input = el('input'); input.type = 'radio'; input.name = 'q_' + q.id; input.value = o.value; input.checked = saved === o.value;
          input.addEventListener('change', () => { state.answers[q.id] = o.value; wrap.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', c.contains(input))); });
          lab.appendChild(input);
          if (o.letter) lab.appendChild(el('span', 'letter', o.letter + '.'));
          lab.appendChild(el('span', '', o.label));
          if (input.checked) lab.classList.add('selected');
          wrap.appendChild(lab);
        });
        li.appendChild(wrap);
      }
      if (q.type === 'ESSAY') {
        const ta = el('textarea', 'essay'); ta.setAttribute('aria-label', 'Your answer'); ta.value = saved || '';
        ta.addEventListener('input', () => { state.answers[q.id] = ta.value; });
        li.appendChild(ta);
      }
      ol.appendChild(li);
    });
  }

  function picture(src) {
    const fig = el('figure', 'q-image');
    const img = el('img'); img.alt = 'Picture for this question'; img.src = src;
    img.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    img.addEventListener('error', () => {
      fig.textContent = '';
      fig.appendChild(el('div', 'img-error', '⚠ This picture could not be loaded. Students would not see it either. Check the link (it must be shared publicly) or upload the picture again.'));
    });
    fig.append(img, el('figcaption', '', 'Click the picture to open it full size'));
    return fig;
  }

  function clearResults() {
    document.querySelectorAll('.pv-result').forEach((n) => n.remove());
    document.querySelectorAll('.question').forEach((n) => n.classList.remove('pv-right', 'pv-wrong'));
    $('pvScore').textContent = ''; $('pvSummary').hidden = true;
  }

  async function check() {
    $('checkBtn').disabled = true;
    try {
      const r = await api('/preview/check', { answers: state.answers, questionIds: state.questions.map((q) => q.id) });
      clearResults();
      let wrong = 0, blank = 0;
      state.questions.forEach((q) => {
        const res = r.results[q.id]; if (!res) return;
        const li = document.querySelector('.question[data-id="' + q.id + '"]');
        const box = el('div', 'pv-result ' + (res.pending ? 'pending' : res.correct ? 'ok' : 'bad'));
        if (res.pending) {
          box.textContent = '✎ Essay: you grade this one in Results.';
          if (res.correctAnswer) box.appendChild(el('span', '', 'Your guide answer: ' + res.correctAnswer));
        } else if (res.correct) {
          box.textContent = '✓ Correct (' + res.points + ' / ' + res.max + ')';
        } else {
          if (!res.yourAnswer) blank++; else wrong++;
          box.textContent = res.yourAnswer ? '✗ Wrong (0 / ' + res.max + ')' : '— Not answered (0 / ' + res.max + ')';
          box.appendChild(el('span', '', (res.yourAnswer ? 'You answered: ' + res.yourAnswer + ' · ' : '') + 'Answer key: ' + (res.correctAnswer || '(none set)')));
        }
        if (!res.pending) li.classList.add(res.correct ? 'pv-right' : 'pv-wrong');
        li.appendChild(box);
      });
      $('pvScore').textContent = 'Score: ' + r.score + ' / ' + r.max + (r.pending ? ' (+ ' + r.pending + ' essay' + (r.pending === 1 ? '' : 's') + ' to grade)' : '');
      $('pvSummary').hidden = false;
      $('pvSummary').className = 'notice' + (wrong || blank ? ' bad' : '');
      $('pvSummary').textContent = 'Score: ' + r.score + ' / ' + r.max + '. ' + (wrong || blank
        ? 'If you answered correctly but a question is marked wrong, its answer key needs fixing: click Edit next to it.'
        : 'All answered questions match their answer keys.');
      $('pvSummary').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { alert(e.message); }
    $('checkBtn').disabled = false;
  }

  $('checkBtn').addEventListener('click', check);
  $('clearBtn').addEventListener('click', () => { state.answers = {}; renderQuestions(); clearResults(); });
  $('modeAll').addEventListener('click', () => { if (state.mode !== 'all') { state.mode = 'all'; state.answers = {}; load(); } });
  $('modeStudent').addEventListener('click', () => { if (state.mode !== 'student') { state.mode = 'student'; state.answers = {}; load(); } });
  $('newSet').addEventListener('click', () => { state.seed = String(Date.now()); state.answers = {}; load(); });
  load();
})();
