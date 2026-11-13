(async function () {
  'use strict';
  const { $, $$, esc, api, toast, dialog } = App;
  let me = await App.requireRole(['teacher', 'admin']);
  App.renderTopbar(me.user, me.site, [{ href: '/teacher', label: 'Teacher', on: true }].concat(me.user.role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []));
  const view = $('#view');
  const TYPE = { MC: 'Multiple choice', TF: 'True / False', FIB: 'Fill in the blank', ESSAY: 'Essay' };
  const TYPE_SHORT = { MC: 'MC', TF: 'T/F', FIB: 'Blank', ESSAY: 'Essay' };
  let cache = { classes: null, questions: null, folders: [] };

  // ───────── header / access ─────────
  function renderMe() {
    const u = me.user;
    $('#avatar').innerHTML = App.avatarHtml(u, 44);
    $('#meName').textContent = u.name;
    $('#adminLink').hidden = u.role !== 'admin';
    const a = u.access || {};
    $('#meAccess').textContent = u.role === 'admin' ? 'Administrator' : a.timeOk ? 'Full access until ' + App.fmtDay(a.until) : (a.credits || 0) + ' credit' + (a.credits === 1 ? '' : 's');
    const b = $('#accessBanner');
    b.hidden = a.canPublish;
    b.innerHTML = 'You can build classes, questions and exams now. To <b>publish</b> an exam to students you need an <b>access code</b> or <b>credits</b>. <a href="#account">Go to My account</a>.';
  }
  async function refreshMe() { me = await api('/auth/me'); renderMe(); }
  window.addEventListener('profile-changed', (e) => { me.user = Object.assign(me.user, e.detail); renderMe(); });
  try { const w = sessionStorage.getItem('welcome'); if (w) { toast(w); sessionStorage.removeItem('welcome'); } } catch (e) { /* ignore */ }

  // ───────── router ─────────
  async function route() {
    const [name, id, extra] = (location.hash.replace(/^#/, '') || 'classes').split('/');
    $$('.sidenav a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === name || (name === 'exam' || name === 'results') && a.dataset.view === 'exams'));
    view.innerHTML = '<div class="empty">Loading…</div>';
    try {
      if (name === 'classes') await viewClasses();
      else if (name === 'questions') {
        await viewQuestions();
        if (id === 'edit' && extra) {
          const q = (await getQuestions()).find((qq) => qq.id === extra);
          history.replaceState(null, '', '#questions');
          if (q) questionDialog(q); else toast('That question was not found.', true);
        }
      }
      else if (name === 'exams') await viewExams();
      else if (name === 'exam') await viewExamEditor(id);
      else if (name === 'results') await viewResults(id);
      else if (name === 'account') await viewAccount();
      else location.hash = '#classes';
    } catch (e) {
      view.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>';
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  const getClasses = async (force) => (cache.classes && !force ? cache.classes : (cache.classes = (await api('/teacher/classes')).classes));
  const getQuestions = async (force) => (cache.questions && !force ? cache.questions : (cache.questions = (await api('/teacher/questions')).questions));

  // ───────── Classes ─────────
  async function viewClasses() {
    const classes = await getClasses(true);
    const active = classes.filter((c) => !c.archived), archived = classes.filter((c) => c.archived);
    const card = (c) => `<div class="classcard"><div><h3>${esc(c.name)}${c.section ? ' <span class="muted">— ' + esc(c.section) + '</span>' : ''}</h3>
        <div class="small muted">${c.student_count} student${c.student_count === 1 ? '' : 's'} · ${c.exam_count} exam${c.exam_count === 1 ? '' : 's'}${c.archived ? ' · archived' : ''}</div>
        <div class="row" style="margin-top:8px"><span class="small muted">Class code</span> <span class="code-box" style="font-size:16px;padding:4px 10px">${esc(c.join_code)}</span>
          <button type="button" class="btn small" data-copy="${esc(c.join_code)}">Copy</button></div></div>
      <div class="row"><button type="button" class="btn small" data-students="${c.id}">Students</button>
        <button type="button" class="btn small" data-edit="${c.id}">Edit</button></div></div>`;
    view.innerHTML = `<div class="stack">
      <div class="panel"><div class="hd"><h2>Classes</h2><button type="button" class="btn primary" id="newClass">+ New class</button></div>
        <div>${active.length ? active.map(card).join('') : '<div class="empty">No classes yet. Create one, then give students its <b>class code</b> so they can join.</div>'}</div></div>
      ${archived.length ? '<div class="panel"><div class="hd"><h3>Archived</h3></div><div>' + archived.map(card).join('') + '</div></div>' : ''}
      <div class="note info">Students sign up for free, then click <b>Join a class</b> and type the class code. All their exams then appear in one list.</div></div>`;
    $('#newClass').onclick = () => classDialog();
    $$('[data-copy]').forEach((b) => b.onclick = () => App.copyText(b.dataset.copy));
    $$('[data-edit]').forEach((b) => b.onclick = () => classDialog(classes.find((c) => c.id === b.dataset.edit)));
    $$('[data-students]').forEach((b) => b.onclick = () => studentsDialog(classes.find((c) => c.id === b.dataset.students)));
  }

  function classDialog(c) {
    const d = dialog(c ? 'Edit class' : 'New class', `<div class="field"><label for="cName">Class name</label><input type="text" id="cName" value="${esc(c ? c.name : '')}" placeholder="e.g. EEE 150"></div>
      <div class="field"><label for="cSection">Section <span class="muted">(optional)</span></label><input type="text" id="cSection" value="${esc(c ? c.section || '' : '')}" placeholder="e.g. Section A, 1st Sem 2026"></div>
      ${c ? `<label class="check"><input type="checkbox" id="cNewCode"> Make a new class code (the old one stops working)</label>
        <label class="check"><input type="checkbox" id="cArchived"${c.archived ? ' checked' : ''}> Archived (hidden from students)</label>` : ''}`, {
      buttons: [
        ...(c ? [{ label: 'Delete class', danger: true, onClick: async () => {
          if (!(await App.confirmBox('Delete class?', 'Delete "' + c.name + '"? Students will be removed from it.', 'Delete', true))) return true;
          await api('/teacher/classes/' + c.id, { delete: true }); toast('Class deleted'); route();
        } }] : []),
        { label: 'Cancel' },
        { label: c ? 'Save' : 'Create class', primary: true, onClick: async (ov) => {
          const body = { name: $('#cName', ov).value, section: $('#cSection', ov).value };
          if (c) Object.assign(body, { newCode: $('#cNewCode', ov).checked, archived: $('#cArchived', ov).checked });
          const r = await api(c ? '/teacher/classes/' + c.id : '/teacher/classes', body);
          toast(c ? 'Saved' : 'Class created. Code: ' + r.class.join_code);
          cache.classes = null; route();
        } },
      ],
    });
    return d;
  }

  async function studentsDialog(c) {
    const r = await api('/teacher/classes/' + c.id + '/students');
    const d = dialog(c.name + ' — students', r.students.length ? `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Student no.</th><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>
      ${r.students.map((s) => `<tr><td><span class="person">${App.avatarHtml(s, 32)}${esc(s.name)}</span></td><td>${esc(s.student_no || '')}</td><td>${esc(s.email)}</td><td class="nowrap">${esc(App.fmtDay(s.joined_at))}</td>
        <td><button type="button" class="btn small danger" data-remove="${s.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">No students yet. Give them the class code <span class="code-box">${esc(c.join_code)}</span></div>`, { wide: true });
    $$('[data-remove]', d.el).forEach((b) => b.onclick = async () => {
      if (!(await App.confirmBox('Remove student?', 'They will no longer see this class\'s exams. Their past results are kept.', 'Remove', true))) return;
      await api('/teacher/classes/' + c.id + '/students/' + b.dataset.remove + '/remove', {});
      b.closest('tr').remove(); toast('Student removed'); cache.classes = null;
    });
  }

  // ───────── Question bank (with folders) ─────────
  let currentFolder = 'all'; // 'all', 'none' or a folder id
  try { currentFolder = sessionStorage.getItem('qFolder') || 'all'; } catch (e) { /* ignore */ }
  const getFolders = async () => (cache.folders = (await api('/teacher/folders')).folders);

  /** Folders in tree order: [{ f, depth }] */
  function folderTree(folders) {
    const kids = (pid) => folders.filter((f) => (f.parent_id || null) === pid).sort((a, b) => a.name.localeCompare(b.name));
    const out = [];
    const walk = (pid, depth) => kids(pid).forEach((f) => { out.push({ f, depth }); walk(f.id, depth + 1); });
    walk(null, 0);
    return out;
  }
  /** The folder and all folders inside it */
  function folderAndBelow(folders, id) {
    const set = new Set([id]);
    let grew = true;
    while (grew) { grew = false; folders.forEach((f) => { if (f.parent_id && set.has(f.parent_id) && !set.has(f.id)) { set.add(f.id); grew = true; } }); }
    return set;
  }
  const folderPath = (folders, id) => { const out = []; let f = folders.find((x) => x.id === id); for (let n = 0; f && n < 50; n++) { out.unshift(f.name); f = folders.find((x) => x.id === f.parent_id); } return out.join(' / '); };
  /** <option>s for a folder picker, indented by depth */
  const folderOptions = (folders, selected, extra) => (extra || '') + folderTree(folders).map(({ f, depth }) =>
    `<option value="${f.id}"${f.id === selected ? ' selected' : ''}>${'   '.repeat(depth)}${esc(f.name)}</option>`).join('');
  const inFolder = (folders, q, sel) => sel === 'all' || (sel === 'none' ? !q.folderId : !!q.folderId && folderAndBelow(folders, sel).has(q.folderId));

  async function viewQuestions() {
    const [qs, folders] = await Promise.all([getQuestions(true), getFolders()]);
    if (currentFolder !== 'all' && currentFolder !== 'none' && !folders.some((f) => f.id === currentFolder)) currentFolder = 'all';
    const topics = [...new Set(qs.map((q) => q.topic).filter(Boolean))].sort();
    const selected = new Set();
    view.innerHTML = `<div class="panel"><div class="hd"><h2>Question bank <span class="muted small">(${qs.length})</span></h2>
        <div class="toolbar"><button type="button" class="btn" id="importBtn">Import CSV</button><a class="btn" href="/api/teacher/questions/export.csv">Export CSV</a>
        <button type="button" class="btn primary" id="addQ">+ Add question</button></div></div>
      <details class="csvdetails bankhelp" id="csvHelp"><summary>📄 Adding many questions at once? See the CSV format for <b>Import CSV</b> · <a href="/assets/sample-questions.csv" download="sample-questions.csv">download a sample</a></summary>${CSV_HELP}</details>
      <div class="bank"><nav class="folders" aria-label="Folders"><div class="folders-hd"><b>Folders</b><button type="button" class="btn small" id="newFolder">+ New</button></div>
          <div id="folderList"></div><div class="folder-actions" id="folderActions"></div></nav>
        <div class="bank-main"><div class="toolbar" style="margin-bottom:10px">
          <input type="search" id="qSearch" placeholder="Search text or ID…" aria-label="Search questions">
          <select id="qType" aria-label="Type"><option value="">All types</option>${Object.keys(TYPE).map((t) => `<option value="${t}">${TYPE[t]}</option>`).join('')}</select>
          <select id="qTopic" aria-label="Topic"><option value="">All topics</option>${topics.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
        <div class="movebar" id="moveBar" hidden><b id="moveCount"></b> <label for="moveTo" class="sr-only">Move to folder</label>
          <select id="moveTo">${folderOptions(folders, null, '<option value="">Not in a folder</option>')}</select>
          <button type="button" class="btn small primary" id="moveBtn">Move</button> <button type="button" class="linkbtn small" id="clearSel">Clear selection</button></div>
        <div class="tablewrap"><table class="list"><thead><tr><th><input type="checkbox" id="qAll" aria-label="Select all listed"></th><th>ID</th><th>Type</th><th>Question</th><th>Pts</th><th>Topic</th><th></th></tr></thead><tbody id="qRows"></tbody></table></div></div></div></div>`;

    function drawFolders() {
      const count = (sel) => qs.filter((q) => inFolder(folders, q, sel)).length;
      const item = (id, label, depth, n) => `<button type="button" class="folder${currentFolder === id ? ' on' : ''}" data-folder="${id}" style="padding-left:${10 + depth * 16}px">
        <span class="fi" aria-hidden="true">${id === 'all' ? '▦' : id === 'none' ? '○' : '📁'}</span><span class="fname">${label}</span><span class="fcount">${n}</span></button>`;
      $('#folderList').innerHTML = item('all', 'All questions', 0, qs.length) +
        folderTree(folders).map(({ f, depth }) => item(f.id, esc(f.name), depth, count(f.id))).join('') +
        item('none', 'Not in a folder', 0, count('none'));
      $$('[data-folder]').forEach((b) => b.onclick = () => {
        currentFolder = b.dataset.folder;
        try { sessionStorage.setItem('qFolder', currentFolder); } catch (e) { /* ignore */ }
        selected.clear(); drawFolders(); draw();
      });
      const f = folders.find((x) => x.id === currentFolder);
      $('#folderActions').innerHTML = f ? `<div class="small muted" style="margin-bottom:6px">${esc(folderPath(folders, f.id))}</div>
        <button type="button" class="btn small" id="subFolder">+ Subfolder</button> <button type="button" class="btn small" id="editFolder">Rename / move</button>
        <button type="button" class="btn small danger" id="delFolder">Delete</button>` : '';
      if (f) {
        $('#subFolder').onclick = () => folderDialog(null, f.id);
        $('#editFolder').onclick = () => folderDialog(f);
        $('#delFolder').onclick = async () => {
          const n = qs.filter((q) => q.folderId === f.id).length;
          if (!(await App.confirmBox('Delete folder?', 'Delete the folder "' + f.name + '"? Its ' + n + ' question(s) and any subfolders move up to ' +
            (f.parent_id ? '"' + folderPath(folders, f.parent_id) + '"' : '"Not in a folder"') + '. No questions are deleted.', 'Delete folder', true))) return;
          await api('/teacher/folders/' + f.id, { delete: true }); toast('Folder deleted'); currentFolder = f.parent_id || 'all'; viewQuestions();
        };
      }
    }
    function folderDialog(f, parentId) {
      const exclude = f ? folderAndBelow(folders, f.id) : new Set();
      const parentOpts = '<option value="">Top level</option>' + folderTree(folders).filter(({ f: x }) => !exclude.has(x.id)).map(({ f: x, depth }) =>
        `<option value="${x.id}"${x.id === (f ? f.parent_id : parentId) ? ' selected' : ''}>${'   '.repeat(depth)}${esc(x.name)}</option>`).join('');
      dialog(f ? 'Rename or move folder' : 'New folder', `<div class="field"><label for="fName">Folder name</label><input type="text" id="fName" value="${esc(f ? f.name : '')}" placeholder="e.g. EEE 150 — Midterm"></div>
        <div class="field"><label for="fParent">Inside</label><select id="fParent">${parentOpts}</select></div>`, {
        buttons: [{ label: 'Cancel' }, { label: f ? 'Save' : 'Create folder', primary: true, onClick: async (ov) => {
          const body = { name: $('#fName', ov).value, parentId: $('#fParent', ov).value || null };
          const r = await api(f ? '/teacher/folders/' + f.id : '/teacher/folders', body);
          toast(f ? 'Folder saved' : 'Folder created'); currentFolder = r.folder.id;
          try { sessionStorage.setItem('qFolder', currentFolder); } catch (e) { /* ignore */ }
          viewQuestions();
        } }],
      });
    }
    const listed = () => {
      const s2 = $('#qSearch').value.trim().toLowerCase(), t = $('#qType').value, tp = $('#qTopic').value;
      return qs.filter((q) => inFolder(folders, q, currentFolder) && (!t || q.type === t) && (!tp || q.topic === tp) && (!s2 || q.code.toLowerCase().includes(s2) || q.text.toLowerCase().includes(s2)));
    };
    function syncMoveBar() {
      $('#moveBar').hidden = !selected.size;
      $('#moveCount').textContent = selected.size + ' selected — move to';
      const rows = listed();
      $('#qAll').checked = rows.length > 0 && rows.every((q) => selected.has(q.id));
    }
    function draw() {
      const rows = listed();
      const showFolder = currentFolder === 'all';
      $('#qRows').innerHTML = rows.length ? rows.map((q) => `<tr><td><input type="checkbox" data-sel="${q.id}"${selected.has(q.id) ? ' checked' : ''} aria-label="Select ${esc(q.code)}"></td>
        <td class="nowrap">${esc(q.code)}</td><td><span class="tag">${TYPE_SHORT[q.type]}</span></td>
        <td class="qtext">${q.imageId || q.imageUrl ? '🖼 ' : ''}${esc(q.text.length > 200 ? q.text.slice(0, 200) + '…' : q.text)}
          ${q.type === 'MC' ? '<div class="choices">' + q.choices.map((c, i) => String.fromCharCode(65 + i) + '. ' + esc(c)).join(' &nbsp; ') + '</div>' : ''}
          ${showFolder && q.folderId ? '<div class="small muted">📁 ' + esc(folderPath(folders, q.folderId)) + '</div>' : ''}
          ${q.problems.length ? '<div class="small" style="color:var(--bad)">⚠ ' + esc(q.problems.join('; ')) + '</div>' : ''}</td>
        <td class="num">${q.points}</td><td>${esc(q.topic)}</td>
        <td class="nowrap"><button type="button" class="btn small" data-edit="${q.id}">Edit</button></td></tr>`).join('')
        : `<tr><td colspan="7"><div class="empty">${qs.length ? (currentFolder === 'all' ? 'No questions match.' : 'No questions in this folder yet. Add one, or select questions elsewhere and move them here.') : 'No questions yet. Add one, or import your existing question bank from a CSV file.'}</div></td></tr>`;
      $$('[data-edit]').forEach((b) => b.onclick = () => questionDialog(qs.find((q) => q.id === b.dataset.edit)));
      $$('[data-sel]').forEach((c) => c.onchange = () => { if (c.checked) selected.add(c.dataset.sel); else selected.delete(c.dataset.sel); syncMoveBar(); });
      syncMoveBar();
    }
    ['qSearch', 'qType', 'qTopic'].forEach((id) => $('#' + id).addEventListener('input', draw));
    $('#qAll').onchange = (e) => { listed().forEach((q) => (e.target.checked ? selected.add(q.id) : selected.delete(q.id))); draw(); };
    $('#clearSel').onclick = () => { selected.clear(); draw(); };
    $('#moveBtn').onclick = async () => {
      const folderId = $('#moveTo').value || null;
      const r = await api('/teacher/questions/move', { ids: [...selected], folderId });
      toast(r.moved + ' question(s) moved to ' + (folderId ? folderPath(folders, folderId) : '"Not in a folder"'));
      viewQuestions();
    };
    $('#newFolder').onclick = () => folderDialog(null, null);
    drawFolders(); draw();
    $('#addQ').onclick = () => questionDialog(null);
    $('#importBtn').onclick = importDialog;
  }

  function questionDialog(q) {
    const topics = [...new Set((cache.questions || []).map((x) => x.topic).filter(Boolean))].sort();
    const st = {
      type: q ? q.type : 'MC',
      choices: q && q.type === 'MC' ? q.choices.slice() : ['', '', '', ''],
      correct: q && q.type === 'MC' ? Math.max(0, mcIndex(q)) : 0,
      imageId: q ? q.imageId : null, imageUrl: q ? q.imageUrl || '' : '', newImage: null,
    };
    const d = dialog(q ? 'Edit question ' + q.code : 'Add question', `
      <div class="grid3"><div class="field"><label for="qeType">Type</label><select id="qeType">${Object.keys(TYPE).map((t) => `<option value="${t}"${st.type === t ? ' selected' : ''}>${TYPE[t]}</option>`).join('')}</select></div>
        <div class="field"><label for="qePoints">Points</label><input type="number" id="qePoints" min="0.5" step="0.5" value="${q ? q.points : 1}"></div>
        <div class="field"><label for="qeCode">Question ID <span class="muted">(optional)</span></label><input type="text" id="qeCode" value="${esc(q ? q.code : '')}" placeholder="auto"></div></div>
      <div class="field"><label for="qeText">Question</label><textarea id="qeText" rows="3">${esc(q ? q.text : '')}</textarea>
        <div class="hint" id="qeTextHint"></div></div>
      <div id="qeAnswer"></div>
      <div class="field"><label for="qeFolder">Folder</label><select id="qeFolder">${folderOptions(cache.folders || [], q ? q.folderId : (currentFolder !== 'all' && currentFolder !== 'none' ? currentFolder : null), '<option value="">Not in a folder</option>')}</select></div>
      <div class="field"><label for="qeTopic">Topic <span class="muted">(optional, for filtering and per-topic picking)</span></label><input type="text" id="qeTopic" list="qeTopics" value="${esc(q ? q.topic : '')}">
        <datalist id="qeTopics">${topics.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
      <fieldset><legend>Picture (optional)</legend>
        <div class="row"><input type="file" id="qeFile" accept="image/*" aria-label="Upload a picture"><button type="button" class="btn small danger" id="qeNoPic">Remove picture</button></div>
        <div class="field" style="margin-top:8px"><label for="qeUrl">…or a link to a picture</label><input type="text" id="qeUrl" value="${esc(st.imageUrl)}" placeholder="https:// (Dropbox, public Google Drive, or a direct image link)"></div>
        <div class="hint" id="qePicNote">Pictures over 2 MB are shrunk automatically.</div><div id="qePic"></div></fieldset>`, {
      wide: true,
      buttons: [
        ...(q ? [{ label: 'Delete', danger: true, onClick: async () => {
          if (!(await App.confirmBox('Delete question?', 'Delete question ' + q.code + '?', 'Delete', true))) return true;
          await api('/teacher/questions/' + q.id, { delete: true }); toast('Question deleted'); cache.questions = null; route();
        } }] : []),
        { label: 'Cancel' },
        { label: 'Save question', primary: true, onClick: async (ov) => {
          readAnswer(ov);
          let imageId = st.imageId;
          if (st.newImage) imageId = (await api('/teacher/images', { dataUrl: st.newImage })).image.id;
          const url = $('#qeUrl', ov).value.trim();
          const body = { type: st.type, text: $('#qeText', ov).value, points: $('#qePoints', ov).value, code: $('#qeCode', ov).value, topic: $('#qeTopic', ov).value,
            choices: st.choices, answer: st.answer, imageId: url && !st.newImage ? null : imageId, imageUrl: url && !st.newImage ? url : null,
            folderId: $('#qeFolder', ov).value || null };
          await api(q ? '/teacher/questions/' + q.id : '/teacher/questions', body);
          toast('Question saved'); cache.questions = null; route();
        } },
      ],
    });
    const ov = d.el;
    function drawAnswer() {
      const box = $('#qeAnswer', ov);
      $('#qeTextHint', ov).textContent = st.type === 'FIB' ? 'Mark the blank with ____ (3 or more underscores), e.g. "The unit of resistance is the ____."' : '';
      if (st.type === 'MC') {
        box.innerHTML = '<label>Choices <span class="muted">(select the correct one)</span></label><div id="chs"></div><button type="button" class="btn small" id="addCh">+ Add choice</button>';
        const chs = $('#chs', ov);
        chs.innerHTML = st.choices.map((c, i) => `<div class="choice-row"><input type="radio" name="correct" value="${i}"${i === st.correct ? ' checked' : ''} aria-label="Correct answer ${String.fromCharCode(65 + i)}">
          <span class="letter">${String.fromCharCode(65 + i)}.</span><input type="text" data-ch="${i}" value="${esc(c)}" aria-label="Choice ${String.fromCharCode(65 + i)}">
          <button type="button" class="btn small" data-del="${i}" aria-label="Remove choice"${st.choices.length <= 2 ? ' disabled' : ''}>✕</button></div>`).join('');
        $$('[data-ch]', chs).forEach((inp) => inp.oninput = () => { st.choices[+inp.dataset.ch] = inp.value; });
        $$('input[name=correct]', chs).forEach((r) => r.onchange = () => { st.correct = +r.value; });
        $$('[data-del]', chs).forEach((b) => b.onclick = () => { const i = +b.dataset.del; st.choices.splice(i, 1); if (st.correct >= st.choices.length) st.correct = 0; drawAnswer(); });
        $('#addCh', ov).onclick = () => { if (st.choices.length < 10) { st.choices.push(''); drawAnswer(); } };
        $('#addCh', ov).disabled = st.choices.length >= 10;
      } else if (st.type === 'TF') {
        const v = q && q.type === 'TF' ? String(q.answer).toUpperCase() : 'TRUE';
        box.innerHTML = `<label>Correct answer</label><div class="row" style="margin-bottom:12px"><label class="check"><input type="radio" name="tf" value="TRUE"${v === 'TRUE' ? ' checked' : ''}> True</label>
          <label class="check"><input type="radio" name="tf" value="FALSE"${v === 'FALSE' ? ' checked' : ''}> False</label></div>`;
      } else if (st.type === 'FIB') {
        box.innerHTML = `<div class="field"><label for="qeFib">Accepted answers</label><input type="text" id="qeFib" value="${esc(q && q.type === 'FIB' ? q.answer : '')}" placeholder="e.g. ohm | ohms | Ω">
          <div class="hint">Separate several accepted answers with |. Capital letters and extra spaces are ignored.</div></div>`;
      } else {
        box.innerHTML = `<div class="field"><label for="qeModel">Model answer <span class="muted">(optional, only you see it)</span></label><textarea id="qeModel" rows="3">${esc(q && q.type === 'ESSAY' ? q.answer : '')}</textarea>
          <div class="hint">Essays are graded by you in Results.</div></div>`;
      }
    }
    function readAnswer(o) {
      if (st.type === 'MC') { st.answer = String.fromCharCode(65 + st.correct); }
      else if (st.type === 'TF') { const r = $('input[name=tf]:checked', o); st.answer = r ? r.value : ''; }
      else if (st.type === 'FIB') st.answer = $('#qeFib', o).value;
      else st.answer = $('#qeModel', o).value;
    }
    function drawPic() {
      const src = st.newImage || (st.imageId ? '/api/teacher/images/' + st.imageId : '') || ($('#qeUrl', ov).value.trim() || '');
      $('#qePic', ov).innerHTML = src ? `<img class="imgprev" alt="Question picture" src="${esc(src)}">` : '';
    }
    $('#qeType', ov).onchange = (e) => { st.type = e.target.value; drawAnswer(); };
    $('#qeFile', ov).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const r = await App.pictureToDataUrl(f); st.newImage = r.dataUrl; $('#qePicNote', ov).textContent = r.note; $('#qeUrl', ov).value = ''; drawPic(); }
      catch (err) { toast(err.message, true); }
    };
    $('#qeUrl', ov).oninput = () => { st.newImage = null; st.imageId = null; drawPic(); };
    $('#qeNoPic', ov).onclick = () => { st.newImage = null; st.imageId = null; $('#qeUrl', ov).value = ''; $('#qeFile', ov).value = ''; drawPic(); };
    drawAnswer(); drawPic();
  }
  function mcIndex(q) {
    const a = String(q.answer).trim();
    if (/^[A-Za-z]$/.test(a)) return a.toUpperCase().charCodeAt(0) - 65;
    return q.choices.findIndex((c) => c.trim().toLowerCase() === a.toLowerCase());
  }

  /** How to write a CSV for Import (shown on the Question bank page and in the Import window). */
  const CSV_HELP = `<div class="csvhelp">
      <p>Make the questions in <b>Excel</b> or <b>Google Sheets</b>, one question per row, with these column names in the <b>first row</b>.
        Then save as CSV: Excel <b>File → Save As → CSV UTF-8</b>; Google Sheets <b>File → Download → Comma-separated values</b>.
        Easiest: <a href="/assets/sample-questions.csv" download="sample-questions.csv">download the sample</a> and replace its rows.</p>
      <div class="tablewrap"><table class="list"><thead><tr><th>Column</th><th>What to put</th><th>Example</th></tr></thead><tbody>
        <tr><td><b>Type</b> *</td><td><b>MC</b> multiple choice, <b>TF</b> true/false, <b>FIB</b> fill in the blank, <b>ESSAY</b></td><td>MC</td></tr>
        <tr><td><b>Question</b> *</td><td>The question text. For FIB, type <b>____</b> (4 underscores) where the blank goes.</td><td>V = I × ____</td></tr>
        <tr><td><b>Choices</b></td><td>MC only: the choices separated by <b>|</b> (the key above Enter, with Shift)</td><td>Volt | Ohm | Ampere | Watt</td></tr>
        <tr><td><b>Answer</b> *</td><td>MC: the <b>letter</b> of the correct choice (A, B, C…)<br>TF: <b>TRUE</b> or <b>FALSE</b><br>FIB: accepted answers separated by <b>|</b> (capital letters don't matter)<br>ESSAY: optional guide answer for you</td><td>B<br>TRUE<br>R | resistance<br>(optional)</td></tr>
        <tr><td><b>Points</b></td><td>Points for the question. Empty = 1</td><td>2</td></tr>
        <tr><td><b>Topic</b></td><td>Optional. Used for filtering and for picking random questions per topic</td><td>Circuits</td></tr>
        <tr><td><b>Folder</b></td><td>Optional. Folder path; folders are created if they don't exist</td><td>EEE 150/Midterm</td></tr>
        <tr><td><b>Image</b></td><td>Optional. A picture link starting with https:// (Google Drive links must be shared publicly). Or add pictures later in the question editor.</td><td>https://…</td></tr>
        <tr><td><b>QuestionID</b></td><td>Optional. Your own code. Importing a row with an ID you already have <b>updates</b> that question instead of adding a copy.</td><td>Q-001</td></tr>
      </tbody></table></div>
      <p class="small muted" style="margin:8px 0 0">* required. Column order doesn't matter. Commas inside a question are fine: Excel and Google Sheets handle them when saving as CSV.
        Rows with a problem are listed after importing, and the other rows are still added.</p></div>`;

  function importDialog() {
    dialog('Import questions from CSV', `<p style="margin-top:0">Choose a CSV file with columns <b>Type, Question, Choices, Answer</b> (and optionally Points, Topic, Folder, Image, QuestionID).
      <a href="/assets/sample-questions.csv" download="sample-questions.csv">Download a sample CSV</a></p>
      <details class="csvdetails"><summary>Show the CSV format</summary>${CSV_HELP}</details>
      <div class="field"><label for="csvFolder">Put imported questions in</label><select id="csvFolder">${folderOptions(cache.folders || [], currentFolder !== 'all' && currentFolder !== 'none' ? currentFolder : null, '<option value="">Not in a folder</option>')}</select></div>
      <input type="file" id="csvFile" accept=".csv,text/csv" aria-label="CSV file"><div id="csvOut" style="margin-top:12px"></div>`, {
      buttons: [{ label: 'Close' }, { label: 'Import', primary: true, onClick: async (ov) => {
        const f = $('#csvFile', ov).files[0];
        if (!f) throw new Error('Choose a CSV file first.');
        const r = await api('/teacher/questions/import', { csv: await f.text(), folderId: $('#csvFolder', ov).value || null });
        $('#csvOut', ov).innerHTML = `<div class="note ${r.errors.length ? 'warn' : 'ok'}">${r.created} added, ${r.updated} updated.${r.errors.length ? '<br>' + r.errors.map(esc).join('<br>') : ''}</div>`;
        cache.questions = null;
        if (location.hash === '#questions') viewQuestions();
        return true;
      } }],
    });
  }

  // ───────── Exams list ─────────
  function examStatus(x) {
    const now = Date.now();
    if (!x.published) return '<span class="tag grey">Draft</span>';
    if (x.start_at && new Date(x.start_at) > now) return '<span class="tag">Scheduled</span>';
    if (x.end_at && new Date(x.end_at) < now) return '<span class="tag warn">Closed</span>';
    return '<span class="tag ok">Open</span>';
  }
  async function viewExams() {
    const r = await api('/teacher/exams');
    view.innerHTML = `<div class="panel"><div class="hd"><h2>Exams</h2><a class="btn primary" href="#exam/new">+ New exam</a></div>
      <div class="tablewrap"><table class="list"><thead><tr><th>Exam</th><th>Class</th><th>Opens</th><th>Closes</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>
      ${r.exams.length ? r.exams.map((x) => `<tr><td><b>${esc(x.title)}</b><div class="small muted">${x.question_count} question${x.question_count === 1 ? '' : 's'}${x.time_limit_min ? ' · ' + x.time_limit_min + ' min' : ''}</div></td>
        <td>${esc(x.class_name)}${x.class_section ? '<div class="small muted">' + esc(x.class_section) + '</div>' : ''}</td>
        <td class="nowrap small">${esc(App.fmtDate(x.start_at)) || 'Now'}</td><td class="nowrap small">${esc(App.fmtDate(x.end_at)) || '—'}</td>
        <td>${examStatus(x)}</td><td class="num">${x.submitted_count}${x.attempt_count > x.submitted_count ? ' <span class="muted small">(+' + (x.attempt_count - x.submitted_count) + ')</span>' : ''}</td>
        <td class="nowrap"><a class="btn small" href="#exam/${x.id}">Edit</a> <a class="btn small" href="/preview?id=${x.id}" target="_blank" rel="noopener">Preview</a> <a class="btn small" href="#results/${x.id}">Results</a></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty">No exams yet. Add questions to your bank, then create an exam.</div></td></tr>'}</tbody></table></div></div>`;
  }

  // ───────── Exam editor ─────────
  async function viewExamEditor(id) {
    const [classes, qs, folders] = await Promise.all([getClasses(true), getQuestions(true), getFolders()]);
    const x = id && id !== 'new' ? (await api('/teacher/exams/' + id)).exam : null;
    if (!classes.filter((c) => !c.archived).length && !x) {
      view.innerHTML = '<div class="note warn">Create a class first: exams are given to a class. <a href="#classes">Go to Classes</a></div>';
      return;
    }
    const o = Object.assign({ blurGraceSeconds: 0, requireMonitorCheck: true, blockCopyPaste: true, submitGraceSeconds: 60, faceGraceSeconds: 3, phoneDetection: true,
      openCountdown: true, timeWarnings: [5, 1], reconnectSeconds: 60, maxReconnects: 3 }, x ? x.options : {});
    const sel = new Set(x ? x.question_ids : []);
    const order = x ? x.question_ids.slice() : [];
    const topicPick = {}; (x ? x.topic_counts : []).forEach((t) => { topicPick[t.topic] = t.count; });
    const topics = [...new Set(qs.map((q) => q.topic).filter(Boolean))].sort();
    const v = (k, d) => (x && x[k] !== null && x[k] !== undefined ? x[k] : d);
    const opt = (val, cur, label) => `<option value="${val}"${val === cur ? ' selected' : ''}>${label}</option>`;

    view.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><h1 style="margin:0">${x ? 'Edit exam' : 'New exam'}</h1>
      <div class="row">${x ? `<button type="button" class="btn primary" id="previewBtn" title="Save, then try the exam as a student would">👁 Preview</button><a class="btn" href="#results/${x.id}">Results</a><button type="button" class="btn" id="dupBtn">Duplicate</button><button type="button" class="btn danger" id="delBtn">Delete</button>` : ''}</div></div>
      ${x ? `<div class="note ${x.published ? 'ok' : 'info'}" style="margin-bottom:12px">${x.published ? 'Published: students in the class can see this exam.' : 'Draft: students cannot see this exam until you publish it.'}</div>` : ''}
      <div class="editor"><div class="panel"><div class="bd">
        <div class="field"><label for="eClass">Class</label><select id="eClass">${classes.filter((c) => !c.archived || (x && x.class_id === c.id)).map((c) => opt(c.id, v('class_id', ''), esc(c.name + (c.section ? ' — ' + c.section : '')))).join('')}</select></div>
        <div class="field"><label for="eTitle">Title</label><input type="text" id="eTitle" value="${esc(v('title', ''))}" placeholder="e.g. EEE 150 Midterm Exam"></div>
        <div class="field"><label for="eInstr">Instructions for students</label><textarea id="eInstr" rows="3">${esc(v('instructions', ''))}</textarea></div>
        <fieldset><legend>When</legend>
          <div class="field"><label for="eStart">Opens</label><input type="datetime-local" id="eStart" value="${App.toLocalInput(v('start_at', null))}"></div>
          <div class="field"><label for="eEnd">Closes</label><input type="datetime-local" id="eEnd" value="${App.toLocalInput(v('end_at', null))}"></div>
          <div class="field"><label for="eLimit">Time limit (minutes, 0 = until it closes)</label><input type="number" id="eLimit" min="0" value="${v('time_limit_min', 60)}"></div>
          <div class="field"><label for="ePass">Exam password <span class="muted">(optional)</span></label><input type="text" id="ePass" value="${esc(v('password', '') || '')}" autocomplete="off">
            <div class="hint">If set, students must type it to start, e.g. announce it in the room.</div></div></fieldset>
        <fieldset><legend>Questions</legend>
          <div class="field"><label for="ePick">Questions per student (0 = all selected)</label><input type="number" id="ePick" min="0" value="${v('pick_count', 0)}">
            <div class="hint">e.g. select 50 and enter 10: each student gets a different random 10.</div></div>
          <label>Or pick per topic <span class="muted">(replaces the number above)</span></label><div id="topicPicks" class="small muted"></div>
          <label class="check"><input type="checkbox" id="eShufQ"${v('shuffle_q', true) ? ' checked' : ''}> Shuffle question order</label>
          <label class="check"><input type="checkbox" id="eShufC"${v('shuffle_c', true) ? ' checked' : ''}> Shuffle multiple-choice options</label>
          <label class="check"><input type="checkbox" id="eScore"${v('show_score', true) ? ' checked' : ''}> Show score to students after submitting</label></fieldset>
        <fieldset><legend>How questions are shown</legend>
          <select id="eMode">${opt('ALL', v('display_mode', 'ALL'), 'All on one page (scroll)')}${opt('ONE', v('display_mode', 'ALL'), 'One question at a time')}</select>
          <label class="check"><input type="checkbox" id="eBack"${v('allow_back', true) ? ' checked' : ''}> Allow going back to previous questions</label>
          <div class="field"><label for="eQsec">Time limit per question (seconds, 0 = none)</label><input type="number" id="eQsec" min="0" value="${v('question_seconds', 0)}"></div></fieldset>
        <fieldset><legend>Security</legend>
          <div class="field"><label for="eDev">Allowed devices</label><select id="eDev">${opt('COMPUTER', v('allowed_devices', 'COMPUTER'), 'Computers only')}${opt('TABLET', v('allowed_devices', 'COMPUTER'), 'Computers and tablets')}${opt('ANY', v('allowed_devices', 'COMPUTER'), 'Any device, including phones')}</select></div>
          <div class="field"><label for="eFace">Camera / face check</label><select id="eFace">${opt('OFF', v('face_mode', 'OFF'), 'Not required')}${opt('START', v('face_mode', 'OFF'), 'Check face at the start only')}${opt('ALWAYS', v('face_mode', 'OFF'), 'Monitor during the whole exam (1 warning, then void)')}</select></div>
          <label class="check"><input type="checkbox" id="ePrev"${v('camera_preview', true) ? ' checked' : ''}> Show students their camera preview</label>
          <details><summary class="small" style="cursor:pointer;margin:6px 0">Advanced settings</summary>
            <div class="grid2" style="margin-top:8px">
              <div class="field"><label for="oFocusWarn">Tab/window warnings</label><input type="number" id="oFocusWarn" min="0" max="10" value="${o.focusWarnings || 0}"><div class="hint">Warnings for switching tabs or apps before the exam is voided. 0 = void at once</div></div>
              <div class="field"><label for="oBlur">Focus grace (s)</label><input type="number" id="oBlur" min="0" value="${o.blurGraceSeconds}"><div class="hint">0 = leaving the window voids at once</div></div>
              <div class="field"><label for="oRecon">Reconnect window (s)</label><input type="number" id="oRecon" min="0" value="${o.reconnectSeconds}"><div class="hint">0 = reloading voids</div></div>
              <div class="field"><label for="oMaxRe">Max reconnects</label><input type="number" id="oMaxRe" min="0" value="${o.maxReconnects}"></div>
              <div class="field"><label for="oWarn">Time warnings (min)</label><input type="text" id="oWarn" value="${esc((o.timeWarnings || []).join(', '))}"><div class="hint">e.g. 10, 5, 1; empty = none</div></div>
              <div class="field"><label for="oFace">Camera grace (s)</label><input type="number" id="oFace" min="1" value="${o.faceGraceSeconds}"></div>
              <div class="field"><label for="oCamWarn">Camera warnings</label><input type="number" id="oCamWarn" min="0" max="10" value="${o.cameraWarnings === undefined ? 1 : o.cameraWarnings}"><div class="hint">Warnings before a camera problem (e.g. a phone) voids the exam. 0 = void at once</div></div>
              <div class="field"><label for="oSubmit">Late submit grace (s)</label><input type="number" id="oSubmit" min="0" value="${o.submitGraceSeconds}"></div></div>
            <label class="check"><input type="checkbox" id="oMon"${o.requireMonitorCheck ? ' checked' : ''}> Computers must use a browser that can detect a second monitor</label>
            <label class="check"><input type="checkbox" id="oCopy"${o.blockCopyPaste ? ' checked' : ''}> Block copy, paste and right-click</label>
            <label class="check"><input type="checkbox" id="oPhone"${o.phoneDetection ? ' checked' : ''}> Camera exams: watch for a phone</label>
            <label class="check"><input type="checkbox" id="oHead"${o.headDetection !== false ? ' checked' : ''}> Camera exams: accept the head when the student looks down (writing or solving), not only the face</label>
            <label class="check"><input type="checkbox" id="oSnap"${o.cameraSnapshots !== false ? ' checked' : ''}> Camera exams: save a small snapshot as proof when the camera flags something</label>
            <label class="check"><input type="checkbox" id="oCount"${o.openCountdown ? ' checked' : ''}> Show a countdown before the exam opens</label></details></fieldset>
        <div class="row"><button type="button" class="btn" id="saveBtn">Save</button>
          ${x && x.published ? '<button type="button" class="btn" id="unpubBtn">Unpublish</button>' : '<button type="button" class="btn primary" id="pubBtn">Save &amp; publish</button>'}</div>
        <div class="hint" id="pubHint"></div>
      </div></div>
      <div class="panel"><div class="hd"><h3>Question bank — select questions for this exam</h3><a class="small" href="#questions">Manage questions</a></div><div class="bd">
        <div class="toolbar" style="margin-bottom:8px"><input type="search" id="pSearch" placeholder="Search…" aria-label="Search">
          <select id="pType" aria-label="Type"><option value="">All types</option>${Object.keys(TYPE).map((t) => `<option value="${t}">${TYPE[t]}</option>`).join('')}</select>
          <select id="pTopic" aria-label="Topic"><option value="">All topics</option>${topics.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
          <select id="pFolder" aria-label="Folder">${folderOptions(folders, null, '<option value="all">All folders</option><option value="none">Not in a folder</option>')}</select></div>
        <div class="picker"><table class="list"><thead><tr><th><input type="checkbox" id="pAll" aria-label="Select all listed"></th><th>ID</th><th>Type</th><th>Question</th><th>Pts</th><th>Topic</th></tr></thead><tbody id="pRows"></tbody></table></div>
        <div class="sumbar"><b id="pSum"></b></div></div></div></div>`;

    const visible = () => {
      const s = $('#pSearch').value.trim().toLowerCase(), t = $('#pType').value, tp = $('#pTopic').value, pf = $('#pFolder').value;
      return qs.filter((q) => inFolder(folders, q, pf) && (!t || q.type === t) && (!tp || q.topic === tp) && (!s || q.code.toLowerCase().includes(s) || q.text.toLowerCase().includes(s)));
    };
    const toggle = (qid, on) => { if (on && !sel.has(qid)) { sel.add(qid); order.push(qid); } if (!on && sel.has(qid)) { sel.delete(qid); order.splice(order.indexOf(qid), 1); } };
    function drawPicker() {
      const rows = visible();
      $('#pRows').innerHTML = rows.length ? rows.map((q) => `<tr><td><input type="checkbox" data-q="${q.id}"${sel.has(q.id) ? ' checked' : ''}${q.problems.length ? ' disabled' : ''} aria-label="Select ${esc(q.code)}"></td>
        <td class="nowrap">${esc(q.code)}</td><td><span class="tag">${TYPE_SHORT[q.type]}</span></td><td class="qtext">${q.imageId || q.imageUrl ? '🖼 ' : ''}${esc(q.text.length > 140 ? q.text.slice(0, 140) + '…' : q.text)}
        ${q.problems.length ? '<div class="small" style="color:var(--bad)">⚠ ' + esc(q.problems.join('; ')) + '</div>' : ''}</td><td class="num">${q.points}</td><td>${esc(q.topic)}</td></tr>`).join('')
        : `<tr><td colspan="6"><div class="empty">${qs.length ? 'No questions match.' : 'Your question bank is empty. <a href="#questions">Add questions</a> first.'}</div></td></tr>`;
      $$('[data-q]').forEach((c) => c.onchange = () => { toggle(c.dataset.q, c.checked); drawTopics(); drawSum(); });
      const ok = rows.filter((q) => !q.problems.length);
      $('#pAll').checked = ok.length > 0 && ok.every((q) => sel.has(q.id));
      drawTopics(); drawSum();
    }
    function drawTopics() {
      const avail = {};
      order.forEach((qid) => { const q = qs.find((y) => y.id === qid); if (q && q.topic) avail[q.topic] = (avail[q.topic] || 0) + 1; });
      const ts = Object.keys(avail).sort();
      $('#topicPicks').innerHTML = ts.length ? `<table class="list"><thead><tr><th>Topic</th><th>Selected</th><th>Each student gets</th></tr></thead><tbody>${ts.map((t) => `<tr><td>${esc(t)}</td><td>${avail[t]}</td>
        <td><input type="number" min="0" max="${avail[t]}" style="width:80px" data-topic="${esc(t)}" value="${topicPick[t] || ''}" placeholder="0"></td></tr>`).join('')}</tbody></table>`
        : 'Select questions that have a topic to pick a number from each topic.';
      $$('[data-topic]').forEach((i) => i.oninput = () => { const n = Math.max(0, Math.round(+i.value || 0)); if (n) topicPick[i.dataset.topic] = n; else delete topicPick[i.dataset.topic]; drawSum(); });
    }
    const activeTopics = () => {
      const present = new Set(order.map((qid) => (qs.find((y) => y.id === qid) || {}).topic).filter(Boolean));
      return Object.keys(topicPick).filter((t) => present.has(t) && topicPick[t] > 0).map((t) => ({ topic: t, count: topicPick[t] }));
    };
    function drawSum() {
      const picked = order.map((qid) => qs.find((y) => y.id === qid)).filter(Boolean);
      const pts = picked.reduce((s, q) => s + q.points, 0);
      const tps = activeTopics();
      $('#ePick').disabled = tps.length > 0;
      const pick = +$('#ePick').value || 0;
      $('#pSum').textContent = picked.length + ' selected — ' + pts + ' points' +
        (tps.length ? ' — each student gets ' + tps.reduce((s, t) => s + t.count, 0) + ' at random: ' + tps.map((t) => t.count + ' ' + t.topic).join(', ')
          : pick > 0 && pick < picked.length ? ' — each student gets ' + pick + ' at random' : '');
    }
    function syncMode() {
      const one = $('#eMode').value === 'ONE', perQ = one && +$('#eQsec').value > 0;
      $('#eBack').disabled = !one || perQ; $('#eQsec').disabled = !one;
      if (!one) $('#eBack').checked = true; if (perQ) $('#eBack').checked = false;
      $('#ePrev').disabled = $('#eFace').value !== 'ALWAYS';
    }
    ['pSearch', 'pType', 'pTopic', 'pFolder'].forEach((i) => $('#' + i).addEventListener('input', drawPicker));
    $('#pAll').onchange = (e) => { visible().filter((q) => !q.problems.length).forEach((q) => toggle(q.id, e.target.checked)); drawPicker(); };
    ['eMode', 'eQsec', 'eFace'].forEach((i) => $('#' + i).addEventListener('input', syncMode));
    $('#ePick').addEventListener('input', drawSum);
    drawPicker(); syncMode();
    const a = me.user.access || {};
    $('#pubHint').textContent = me.user.role === 'admin' || a.timeOk ? 'Publishing is included in your access.' : x && x.credit_spent ? 'Already paid for: publishing again is free.' : 'Publishing uses 1 credit (you have ' + (a.credits || 0) + ').';

    const body = () => ({
      classId: $('#eClass').value, title: $('#eTitle').value, instructions: $('#eInstr').value, questionIds: order.slice(),
      startAt: App.fromLocalInput($('#eStart').value), endAt: App.fromLocalInput($('#eEnd').value), timeLimitMinutes: $('#eLimit').value, password: $('#ePass').value,
      pickCount: $('#ePick').value, topicCounts: activeTopics(), shuffleQuestions: $('#eShufQ').checked, shuffleChoices: $('#eShufC').checked, showScore: $('#eScore').checked,
      displayMode: $('#eMode').value, allowBack: $('#eBack').checked, questionSeconds: $('#eQsec').value,
      allowedDevices: $('#eDev').value, faceMode: $('#eFace').value, cameraPreview: $('#ePrev').checked,
      options: { focusWarnings: $('#oFocusWarn').value, blurGraceSeconds: $('#oBlur').value, reconnectSeconds: $('#oRecon').value, maxReconnects: $('#oMaxRe').value, timeWarnings: $('#oWarn').value,
        faceGraceSeconds: $('#oFace').value, cameraWarnings: $('#oCamWarn').value, submitGraceSeconds: $('#oSubmit').value, requireMonitorCheck: $('#oMon').checked, blockCopyPaste: $('#oCopy').checked,
        phoneDetection: $('#oPhone').checked, headDetection: $('#oHead').checked, cameraSnapshots: $('#oSnap').checked, openCountdown: $('#oCount').checked },
    });
    async function save() {
      const r = await api(x ? '/teacher/exams/' + x.id : '/teacher/exams', body());
      return r.exam;
    }
    if ($('#previewBtn')) $('#previewBtn').onclick = async () => {
      const w = window.open('about:blank', '_blank');
      try {
        await save();
        if (w) w.location.href = '/preview?id=' + encodeURIComponent(x.id); else location.href = '/preview?id=' + encodeURIComponent(x.id);
      } catch (err) { if (w) w.close(); toast(err.message, true); }
    };
    $('#saveBtn').onclick = async () => {
      try { const e = await save(); toast('Saved'); if (!x) location.hash = '#exam/' + e.id; else route(); } catch (err) { toast(err.message, true); }
    };
    const pub = $('#pubBtn');
    if (pub) pub.onclick = async () => {
      try {
        const e = await save();
        const r = await api('/teacher/exams/' + e.id, { publish: true });
        toast(r.charged ? 'Published. 1 credit used.' : 'Published. Students in the class can now see it.');
        me.user = r.user; renderMe();
        location.hash = '#exam/' + e.id; route();
      } catch (err) { toast(err.message, true); if (err.code === 'NO_CREDITS') setTimeout(() => { location.hash = '#account'; }, 1500); }
    };
    const unpub = $('#unpubBtn');
    if (unpub) unpub.onclick = async () => { await api('/teacher/exams/' + x.id, { publish: false }); toast('Unpublished: students no longer see it.'); route(); };
    if (x) {
      $('#dupBtn').onclick = async () => { const r = await api('/teacher/exams/' + x.id, { duplicate: true }); toast('Copy created as a draft'); location.hash = '#exam/' + r.exam.id; };
      $('#delBtn').onclick = async () => {
        if (!(await App.confirmBox('Delete exam?', 'Delete "' + x.title + '"? All of its results are deleted too. This cannot be undone.', 'Delete exam', true))) return;
        await api('/teacher/exams/' + x.id, { delete: true, confirmDeleteResults: true }); toast('Exam deleted'); location.hash = '#exams';
      };
    }
  }

  // ───────── Results ─────────
  const STATUS_TAG = { SUBMITTED: '<span class="tag ok">Submitted</span>', VOIDED: '<span class="tag bad">Voided</span>', IN_PROGRESS: '<span class="tag">In progress</span>', EXPIRED: '<span class="tag grey">Not submitted</span>' };
  async function viewResults(id) {
    const r = await api('/teacher/exams/' + id + '/results');
    const sub = r.attempts.filter((a) => a.status === 'SUBMITTED');
    const avg = sub.length ? Math.round(sub.reduce((s, a) => s + (a.percent || 0), 0) / sub.length * 10) / 10 : null;
    view.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><h1 style="margin:0">${esc(r.exam.title)} — results</h1>
      <div class="row"><a class="btn" href="#exam/${id}">Edit exam</a><a class="btn" href="/api/teacher/exams/${id}/export.csv">Download results (CSV)</a>
      <a class="btn" href="/api/teacher/exams/${id}/export.csv?detail=1">Download all answers (CSV)</a></div></div>
      <div class="statgrid" style="margin-bottom:16px">
        <div class="stat"><b>${sub.length}</b><span>Submitted</span></div>
        <div class="stat"><b>${avg === null ? '—' : avg + '%'}</b><span>Average</span></div>
        <div class="stat"><b>${r.attempts.filter((a) => a.status === 'IN_PROGRESS').length}</b><span>In progress</span></div>
        <div class="stat"><b>${r.attempts.filter((a) => a.status === 'VOIDED').length}</b><span>Voided</span></div>
        <div class="stat"><b>${r.notStarted.length}</b><span>Not started</span></div>
        <div class="stat"><b>${sub.reduce((s, a) => s + (a.pending_essays || 0), 0)}</b><span>Essays to grade</span></div></div>
      <div class="panel"><div class="hd"><h3>Attempts <span class="muted small">(${r.attempts.length})</span></h3>
        ${r.attempts.length > 1 ? `<div class="toolbar">${r.attempts.length > 5 ? `<input type="search" id="aFind" placeholder="Find a student…" aria-label="Find a student" style="width:200px">
          <select id="aStatus" aria-label="Show"><option value="">All</option><option value="SUBMITTED">Submitted</option><option value="VOIDED">Voided</option><option value="IN_PROGRESS">In progress</option><option value="EXPIRED">Not submitted</option></select>` : ''}
          <select id="aSort" aria-label="Sort by"><option value="name">Sort: Name (A–Z)</option><option value="name-desc">Name (Z–A)</option><option value="start">Started: earliest first</option><option value="start-desc">Started: latest first</option>
            <option value="end">Finished: earliest first</option><option value="end-desc">Finished: latest first</option><option value="dur">Time taken: shortest first</option><option value="dur-desc">Time taken: longest first</option>
            <option value="score-desc">Score: highest first</option><option value="score">Score: lowest first</option></select></div>` : ''}</div>
      <div class="tablewrap"><table class="list results"><thead><tr><th class="sortable" data-sort="name" title="Sort by name">Student</th><th class="sortable" data-sort="score-desc" title="Sort by score">Result</th><th class="sortable" data-sort="start" title="Sort by start time (click again: finish time)">Time</th><th>Notes</th><th></th></tr></thead><tbody id="aRows">
      ${r.attempts.length ? r.attempts.map((a) => {
        const reason = String(a.void_reason || '');
        const shortReason = reason.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
        const mins = a.submitted_at ? Math.max(1, Math.round((new Date(a.submitted_at) - new Date(a.started_at)) / 60000)) : null;
        const sameDay = a.submitted_at && new Date(a.submitted_at).toDateString() === new Date(a.started_at).toDateString();
        const endText = a.submitted_at ? (sameDay ? new Date(a.submitted_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : App.fmtDate(a.submitted_at)) : '';
        const startMs = new Date(a.started_at).getTime(), endMs = a.submitted_at ? new Date(a.submitted_at).getTime() : '';
        return `<tr data-status="${esc(a.status)}" data-name="${esc(a.student_name.toLowerCase())}" data-start="${startMs}" data-end="${endMs}" data-dur="${endMs ? endMs - startMs : ''}" data-score="${a.percent === null || a.percent === undefined ? '' : a.percent}" data-find="${esc((a.student_name + ' ' + (a.student_no || '') + ' ' + (a.student_email || '')).toLowerCase())}">
        <td data-label="Student"><span class="person">${App.avatarHtml({ name: a.student_name, avatarUrl: a.avatarUrl }, 32)}<span><b>${esc(a.student_name)}</b><div class="small muted">${esc(a.student_no || a.student_email)}</div></span></span></td>
        <td data-label="Result">${STATUS_TAG[a.status] || esc(a.status)}${a.is_retake ? ' <span class="tag grey">Retake</span>' : ''}${a.late ? ' <span class="tag warn">Late</span>' : ''}
          ${a.score !== null ? '<div class="score">' + a.score + ' / ' + a.max_score + ' <span class="muted">(' + a.percent + '%)</span></div>' : ''}${a.pending_essays ? '<div class="small" style="color:var(--warn)">' + a.pending_essays + ' to grade</div>' : ''}</td>
        <td data-label="Time" class="small"><div class="nowrap">${esc(App.fmtDate(a.started_at))}</div>${a.submitted_at ? '<div class="muted nowrap">→ ' + esc(endText) + ' · ' + mins + ' min</div>' : ''}</td>
        <td data-label="Notes" class="small">${shortReason ? '<div class="bad-text" title="' + esc(reason) + '">' + esc(shortReason) + '</div>' : ''}${a.focus_warnings ? '<div>' + a.focus_warnings + ' tab warning' + (a.focus_warnings === 1 ? '' : 's') + '</div>' : ''}${a.warnings ? '<div>' + a.warnings + ' camera warning' + (a.warnings === 1 ? '' : 's') + '</div>' : ''}${a.reconnects ? '<div>' + a.reconnects + ' reconnect' + (a.reconnects === 1 ? '' : 's') + '</div>' : ''}<div class="muted">${esc(a.device || '')}</div></td>
        <td class="actions"><button type="button" class="btn small" data-answers="${a.id}">Answers</button>
          ${a.status !== 'IN_PROGRESS' ? `<label class="check small" title="Let this student take the exam again"><input type="checkbox" data-retake="${a.id}"${a.allow_retake ? ' checked' : ''}> Allow retake</label>` : ''}</td></tr>`;
      }).join('')
      : '<tr><td colspan="5"><div class="empty">Nobody has started this exam yet.</div></td></tr>'}
      <tr id="aNone" hidden><td colspan="5"><div class="empty">No students match.</div></td></tr></tbody></table></div></div>
      ${r.notStarted.length ? `<div class="panel" style="margin-top:16px"><div class="hd"><h3>Not started (${r.notStarted.length})</h3></div><div class="tablewrap"><table class="list notstarted"><thead><tr><th class="num">#</th><th>Student</th><th>Student no.</th><th>Email</th></tr></thead><tbody>
        ${r.notStarted.map((s, i) => `<tr><td class="num muted">${i + 1}</td><td><span class="person">${App.avatarHtml(s, 32)}${esc(s.name)}</span></td><td class="nowrap">${esc(s.student_no || '—')}</td><td class="small">${esc(s.email)}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`;
    $$('[data-retake]').forEach((c) => c.onchange = async () => {
      await api('/teacher/exams/' + id + '/attempts/' + c.dataset.retake, { allowRetake: c.checked });
      toast(c.checked ? 'Retake allowed: the student can open the exam again.' : 'Retake turned off');
    });
    $$('[data-answers]').forEach((b) => b.onclick = () => attemptDialog(id, b.dataset.answers));
    const filterRows = () => {
      const q = ($('#aFind').value || '').trim().toLowerCase(), st = $('#aStatus').value;
      let shown = 0;
      $$('#aRows tr[data-status]').forEach((tr) => { const ok = (!q || tr.dataset.find.includes(q)) && (!st || tr.dataset.status === st); tr.hidden = !ok; if (ok) shown++; });
      $('#aNone').hidden = shown > 0;
    };
    if ($('#aFind')) { $('#aFind').oninput = filterRows; $('#aStatus').onchange = filterRows; }
    // Sorting: the menu, or click a column title. Rows without a value (e.g. not finished) go last.
    const sortRows = (how) => {
      const desc = how.endsWith('-desc'), key = how.replace('-desc', '');
      const rows = $$('#aRows tr[data-status]');
      const val = (tr) => key === 'name' ? tr.dataset.name : (tr.dataset[key] === '' ? null : Number(tr.dataset[key]));
      rows.sort((x, y) => {
        const a = val(x), b = val(y);
        if (a === null && b === null) return x.dataset.name.localeCompare(y.dataset.name);
        if (a === null) return 1;
        if (b === null) return -1;
        const c = key === 'name' ? a.localeCompare(b) : a - b;
        return (desc ? -c : c) || x.dataset.name.localeCompare(y.dataset.name);
      });
      const tbody = $('#aRows'), none = $('#aNone');
      rows.forEach((tr) => tbody.insertBefore(tr, none));
      $$('th.sortable').forEach((th) => th.classList.toggle('on', th.dataset.sort.replace('-desc', '') === key || (th.dataset.sort === 'start' && key === 'end')));
      if ($('#aSort')) $('#aSort').value = how;
    };
    if ($('#aSort')) $('#aSort').onchange = () => sortRows($('#aSort').value);
    const nextSort = { name: 'name', 'score-desc': 'score', score: 'score-desc', start: 'start-desc', 'start-desc': 'end', end: 'end-desc', 'end-desc': 'start' };
    $$('th.sortable').forEach((th) => { th.onclick = () => {
      const cur = $('#aSort') ? $('#aSort').value : 'name';
      const group = th.dataset.sort.replace('-desc', '');
      const inGroup = group === 'start' ? ['start', 'start-desc', 'end', 'end-desc'].includes(cur) : cur.replace('-desc', '') === group;
      sortRows(inGroup ? (group === 'name' ? (cur === 'name' ? 'name-desc' : 'name') : nextSort[cur]) : th.dataset.sort);
    }; });
  }

  async function attemptDialog(examId, attemptId) {
    const r = await api('/teacher/exams/' + examId + '/attempts/' + attemptId);
    const a = r.attempt;
    const d = dialog(a.student_name + ' — answers', `<div class="row small" style="margin-bottom:10px">${STATUS_TAG[a.status] || ''} ${a.score !== null ? '<b>' + a.score + ' / ' + a.max_score + ' (' + a.percent + '%)</b>' : ''}
        <span class="muted">Started ${esc(App.fmtDate(a.started_at))}${a.submitted_at ? ' · submitted ' + esc(App.fmtDate(a.submitted_at)) : ''}</span></div>
      ${a.void_reason ? '<div class="note bad" style="margin-bottom:10px">Voided: ' + esc(a.void_reason) + '</div>' : ''}
      ${r.responses.length ? r.responses.map((x, i) => `<div class="resp"><div class="row" style="justify-content:space-between"><b>Question ${i + 1}</b><span class="tag">${TYPE_SHORT[x.type]}</span></div>
        <div class="q">${esc(x.question_text)}</div>
        <div class="small muted">Answer</div><div class="a">${esc(x.student_answer) || '<span class="muted">(no answer)</span>'}</div>
        ${x.type !== 'ESSAY' ? `<div class="small" style="margin-top:6px">Correct answer: ${esc(x.correct_answer)} — ${x.is_correct ? '<span class="tag ok">Correct</span>' : '<span class="tag bad">Wrong</span>'}</div>`
          : (x.correct_answer ? '<div class="small muted" style="margin-top:6px">Model answer: ' + esc(x.correct_answer) + '</div>' : '')}
        <div class="row" style="margin-top:8px"><label for="pts${i}" style="margin:0">Points</label><input type="number" id="pts${i}" data-pts="${x.question_id}" min="0" max="${x.max_points}" step="0.5"
          value="${x.points_earned === null ? '' : x.points_earned}" style="width:90px"${x.type === 'ESSAY' && x.points_earned === null ? ' placeholder="grade"' : ''}> <span class="muted">/ ${x.max_points}</span></div></div>`).join('')
        : '<div class="empty">No answers recorded (the exam was not submitted).</div>'}
      <h3 style="margin-top:14px">Events</h3>${r.events.length ? '<table class="list"><tbody>' + r.events.map((e) => `<tr><td class="nowrap small">${esc(App.fmtDate(e.at))}</td><td><b>${esc(e.event)}</b><div class="small muted">${esc(e.detail)}</div></td></tr>`).join('') + '</tbody></table>' : '<p class="muted small">No events.</p>'}
      ${(r.snapshots || []).length ? '<h3 style="margin-top:14px">Camera snapshots</h3><div class="snaps">' + r.snapshots.map((sn) => {
        const u = '/api/teacher/exams/' + examId + '/attempts/' + attemptId + '/snapshots/' + sn.id;
        return `<a href="${u}" target="_blank" rel="noopener" class="snap"><img src="${u}" alt="Camera snapshot" loading="lazy"><span><b>${esc(sn.event)}</b><br>${esc(App.fmtDate(sn.at))}</span></a>`;
      }).join('') + '</div>' : ''}`, {
      wide: true,
      buttons: r.responses.length ? [{ label: 'Close' }, { label: 'Save points', primary: true, onClick: async (ov) => {
        const grade = {};
        $$('[data-pts]', ov).forEach((i) => { grade[i.dataset.pts] = i.value === '' ? null : i.value; });
        const res = await api('/teacher/exams/' + examId + '/attempts/' + attemptId, { grade });
        toast('Saved. Score: ' + res.attempt.score + ' / ' + res.attempt.max_score);
        viewResults(examId);
      } }] : [{ label: 'Close' }],
    });
    return d;
  }

  // ───────── Account ─────────
  const money = (n, cur) => { try { return new Intl.NumberFormat('en-PH', { style: 'currency', currency: cur || 'PHP' }).format(n); } catch (e) { return (cur || '') + ' ' + n; } };
  const methodName = (m) => ({ bank: 'Bank transfer', paypal: 'PayPal', other: 'GCash / other' })[m] || '';
  let paypalSdk = null;
  /** Loads PayPal's checkout script once. */
  function loadPayPal(clientId, currency) {
    if (window.paypal && window.paypal.Buttons) return Promise.resolve(window.paypal);
    if (!paypalSdk) paypalSdk = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=' + encodeURIComponent(currency) + '&intent=capture&components=buttons';
      sc.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal not loaded')));
      sc.onerror = () => { paypalSdk = null; reject(new Error('PayPal not loaded')); };
      document.head.appendChild(sc);
    });
    return paypalSdk;
  }

  async function viewAccount() {
    const r = await api('/teacher/account');
    me.user = r.user; renderMe();
    const a = r.user.access || {};
    view.innerHTML = `<div class="stack">
      <div class="panel"><div class="hd"><h2>My access</h2></div><div class="bd access">
        <div>${r.user.role === 'admin' ? '<b>Administrator</b>: you can publish without credits.' :
          a.timeOk ? '<span class="tag ok">Full access</span> until <b>' + esc(App.fmtDate(a.until)) + '</b>. Publishing is free during this time.' :
          '<span class="tag ' + (a.credits ? 'ok' : 'warn') + '">' + (a.credits || 0) + ' credit' + (a.credits === 1 ? '' : 's') + '</span> 1 credit = publish 1 exam. Editing and re-publishing it later is free.'}</div></div></div>
      <div class="grid2">
        <div class="panel"><div class="hd"><h3>Redeem an access code</h3></div><div class="bd">
          <div class="field"><label for="code">Access code</label><input type="text" id="code" autocomplete="off" placeholder="e.g. TABC-DEFG" style="text-transform:uppercase"></div>
          <button type="button" class="btn primary" id="redeem">Redeem</button><div class="hint">Access codes are given by the site administrator. They add days of full access or credits.</div></div></div>
        ${!r.paymentsEnabled ? `<div class="panel" id="askPanel"><div class="hd"><h3>Request an access code</h3></div><div class="bd">
          <div class="field"><label>I need</label><div class="methods">
            <label class="method"><input type="radio" name="askKind" value="access" checked>Days of full access</label>
            <label class="method"><input type="radio" name="askKind" value="credits">Credits <span class="muted small">(1 credit = 1 exam)</span></label></div></div>
          <div class="field"><label for="askAmount" id="askAmountLabel">How many days?</label><input type="number" id="askAmount" min="1" value="30" style="max-width:140px"></div>
          <div class="field"><label for="askMsg">Message to the administrator</label><textarea id="askMsg" rows="3" placeholder="e.g. school, subject, number of classes and students"></textarea></div>
          <button type="button" class="btn primary" id="askSend">Send request</button>
          <div class="hint">When the administrator approves it, the access is added to your account automatically. You don't need to type a code.${r.supportContact ? ' Questions? ' + esc(r.supportContact) : ''}</div></div></div></div>` : ''}
        <div class="panel" id="buyPanel"${r.paymentsEnabled ? '' : ' hidden'}><div class="hd"><h3>Buy credits</h3></div><div class="bd">
          <div class="field"><label>1. Choose a package</label>${r.packages.length ? `<div class="packs">${r.packages.map((p, i) => `<label class="pack"><input type="radio" name="pack" value="${p.credits}"${i === 0 ? ' checked' : ''}>
            <b>${p.credits} credit${p.credits === 1 ? '' : 's'}</b><span>${esc(money(p.price, r.currency))}</span><small>${esc(money(p.price / p.credits, r.currency))} per exam</small></label>`).join('')}</div>`
            : '<input type="number" id="rqCredits" min="1" value="10">'}<div class="hint">1 credit = publish 1 exam. Editing and re-publishing it later is free.</div></div>
          <div class="field"><label>2. Choose how to pay</label>${r.methods.length ? `<div class="methods">${r.methods.map((m, i) => `<label class="method"><input type="radio" name="method" value="${m.id}"${i === 0 ? ' checked' : ''}>${esc(m.label)}</label>`).join('')}</div>`
            : '<div class="note warn small">Payment methods are not set up yet. Send a request and the administrator will contact you.</div>'}</div>
          <div id="payBox"></div>
          <div class="hint" style="margin-top:12px">Need free access instead (e.g. a school trial)? <a href="#account" id="askAccess">Request free access</a>${r.supportContact ? ' · Questions? ' + esc(r.supportContact) : ''}</div></div></div></div>
      <div class="grid2">
        <div class="panel"><div class="hd"><h3>My requests</h3></div><div class="tablewrap"><table class="list"><tbody>${r.requests.length ? r.requests.map((q) => `<tr><td class="small nowrap">${esc(App.fmtDate(q.created_at))}</td>
          <td>${q.kind === 'access' ? 'Access' : q.credits + ' credits'}${q.amount ? ' · ' + esc(money(q.amount, q.currency || r.currency)) : ''}<div class="small muted">${esc(methodName(q.method))}${q.reference ? ' · Ref ' + esc(q.reference) : ''}</div></td>
          <td><span class="tag ${q.status === 'approved' ? 'ok' : q.status === 'rejected' ? 'bad' : 'warn'}">${esc(q.status)}</span></td></tr>`).join('') : '<tr><td><div class="empty">No requests yet.</div></td></tr>'}</tbody></table></div></div>
        <div class="panel"><div class="hd"><h3>History</h3></div><div class="tablewrap"><table class="list"><tbody>${r.ledger.length ? r.ledger.map((l) => `<tr><td class="small nowrap">${esc(App.fmtDate(l.at))}</td><td>${esc(l.reason)}</td>
          <td class="num nowrap">${l.credits ? (l.credits > 0 ? '+' : '') + l.credits + ' cr' : ''}${l.days ? ' ' + (l.days > 0 ? '+' : '') + l.days + ' days' : ''}</td></tr>`).join('') : '<tr><td><div class="empty">Nothing yet.</div></td></tr>'}</tbody></table></div></div></div>
      <div class="panel"><div class="hd"><h3>Profile</h3></div><div class="bd"><div class="person">${App.avatarHtml(r.user, 56)}<div><b>${esc(r.user.name)}</b>
        <div class="small muted">${esc(r.user.email)}${r.user.school ? ' · ' + esc(r.user.school) : ''}</div></div></div>
        <button type="button" class="btn" id="editProfile" style="margin-top:10px">Edit profile, picture or password</button></div></div></div>`;
    $('#redeem').onclick = async () => {
      try { const x = await api('/teacher/redeem', { code: $('#code').value }); toast(x.message); me.user = x.user; viewAccount(); } catch (e) { toast(e.message, true); }
    };
    const credits = () => Number((($('input[name=pack]:checked') || {}).value) || ($('#rqCredits') || {}).value || 0);
    const pack = () => r.packages.find((p) => p.credits === credits());
    const method = () => r.methods.find((m) => m.id === (($('input[name=method]:checked') || {}).value));
    let proofId = null;
    const manualForm = (m) => `<div class="field"><label for="rqRef">3. Payment reference number</label><input type="text" id="rqRef" autocomplete="off" placeholder="${m && m.id === 'bank' ? 'e.g. transfer reference' : m && m.id === 'paypal' ? 'PayPal transaction ID' : 'e.g. GCash reference no.'}"></div>
      <div class="field"><label for="rqProof">Picture of your receipt <span class="muted">(optional)</span></label><input type="file" id="rqProof" accept="image/*"><div class="hint" id="rqProofNote"></div></div>
      <div class="field"><label for="rqMsg">Message <span class="muted">(optional)</span></label><textarea id="rqMsg" rows="2"></textarea></div>
      <button type="button" class="btn primary" id="request">Send payment details</button><div class="hint">Credits are added once the administrator confirms your payment.</div>`;
    const renderPayPal = (co, p) => {
      loadPayPal(co.clientId, r.currency).then((paypal) => {
        const box = $('#ppButtons'); if (!box) return;
        box.innerHTML = '';
        paypal.Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'pay' },
          createOrder: async () => (await api('/teacher/paypal/order', { credits: p.credits })).id,
          onApprove: async (data) => {
            try {
              const x = await api('/teacher/paypal/capture', { orderId: data.orderID });
              me.user = x.user; toast('Payment complete: ' + x.credits + ' credits added. Thank you!'); viewAccount();
            } catch (e) { toast(e.message, true); }
          },
          onError: (err) => toast('PayPal error: ' + ((err && err.message) || 'please try again'), true),
        }).render(box);
      }).catch(() => { const box = $('#ppButtons'); if (box) box.innerHTML = '<div class="note warn small">PayPal could not be loaded. Check your internet connection or ad blocker, then reload the page.</div>'; });
    };
    const paintPay = () => {
      const m = method(), p = pack(), amt = p ? money(p.price, r.currency) : '';
      const due = p ? `<div class="due">Amount to pay: <b>${esc(amt)}</b> for ${p.credits} credit${p.credits === 1 ? '' : 's'}</div>` : '';
      let h = '';
      if (m && m.id === 'paypal' && m.checkout && p) {
        h = `${due}<div id="ppButtons" class="pp-buttons"><div class="muted small">Loading PayPal…</div></div>
          <div class="hint">Pay with your PayPal account or a debit/credit card. Your credits are added right away.${m.checkout.sandbox ? ' <b>(Test mode: no real money.)</b>' : ''}</div>`;
      } else if (m && m.id === 'paypal') {
        const link = /^https:\/\/(www\.)?paypal\.me\//i.test(m.link) && p ? m.link.replace(/\/+$/, '') + '/' + p.price + r.currency : m.link;
        h = `${due}<div class="note info small paydetails">Send the amount by PayPal to ${/^https:/i.test(m.link) ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(m.link)}</a>` : '<b>' + esc(m.link) + '</b>'}, then enter the transaction ID below.</div>${manualForm(m)}`;
      } else if (m) {
        const qr = m.qr ? '/api/teacher/payment-qr/' + m.id + '?v=' + encodeURIComponent(m.qr) : '';
        h = `${due}${qr ? `<div class="qrbox"><img src="${qr}" alt="QR code to pay"><div><b>Scan to pay</b> with GCash, Maya or your bank app${p ? ' and enter <b>' + esc(amt) + '</b>' : ''}.
          <div class="small muted" style="margin-top:6px">On your phone? <a href="${qr}" download="payment-qr">Save the QR picture</a>, then in your app tap <i>Scan QR → Upload QR</i> and choose it.</div></div></div>` : ''}
          ${m.details ? `<div class="note info small paydetails">${esc(m.details)}</div>` : ''}${manualForm(m)}`;
      } else h = due + manualForm(null);
      $('#payBox').innerHTML = h;
      proofId = null;
      if ($('#ppButtons')) renderPayPal(m.checkout, p);
      if ($('#rqProof')) $('#rqProof').onchange = async () => {
        const f = $('#rqProof').files[0]; proofId = null; if (!f) return;
        try {
          $('#rqProofNote').textContent = 'Uploading…';
          const pic = await App.pictureToDataUrl(f);
          proofId = (await api('/teacher/images', { dataUrl: pic.dataUrl })).image.id;
          $('#rqProofNote').textContent = '✓ Receipt attached';
        } catch (e) { $('#rqProofNote').textContent = ''; $('#rqProof').value = ''; toast(e.message, true); }
      };
      if ($('#request')) $('#request').onclick = async () => {
        try {
          await api('/teacher/requests', { kind: 'credits', credits: credits(), method: m ? m.id : '', reference: $('#rqRef').value, proofImageId: proofId, message: $('#rqMsg').value });
          toast('Request sent to the administrator'); viewAccount();
        } catch (e) { toast(e.message, true); }
      };
    };
    $$('input[name=pack], input[name=method]').forEach((i) => { i.onchange = paintPay; });
    if (r.paymentsEnabled) paintPay();
    if ($('#askSend')) {
      $$('input[name=askKind]').forEach((i) => { i.onchange = () => {
        const days = $('input[name=askKind]:checked').value === 'access';
        $('#askAmountLabel').textContent = days ? 'How many days?' : 'How many credits?';
        $('#askAmount').value = days ? 30 : 10;
      }; });
      $('#askSend').onclick = async () => {
        const kind = $('input[name=askKind]:checked').value, n = $('#askAmount').value;
        try {
          await api('/teacher/requests', kind === 'access' ? { kind, days: n, message: $('#askMsg').value } : { kind, credits: n, message: $('#askMsg').value });
          toast('Request sent to the administrator'); viewAccount();
        } catch (e) { toast(e.message, true); }
      };
    }
    $('#askAccess').onclick = (ev) => {
      ev.preventDefault();
      dialog('Request free access', `<p style="margin-top:0">Tell the administrator about your school and classes. If approved, you get days of full access.</p>
        <div class="field"><label for="faMsg">Message</label><textarea id="faMsg" rows="3" placeholder="e.g. school, subject, number of classes"></textarea></div>`, {
        buttons: [{ label: 'Cancel' }, { label: 'Send request', primary: true, onClick: async (ov) => {
          await api('/teacher/requests', { kind: 'access', message: $('#faMsg', ov).value }); toast('Request sent to the administrator'); viewAccount();
        } }],
      });
    };
    $('#editProfile').onclick = () => App.openProfile(me.user);
  }

  function passwordDialog() {
    dialog('Change password', `<div class="field"><label for="pwOld">Current password</label><input type="password" id="pwOld" autocomplete="current-password"></div>
      <div class="field"><label for="pwNew">New password</label><input type="password" id="pwNew" autocomplete="new-password"><div class="hint">At least 8 characters.</div></div>`, {
      buttons: [{ label: 'Cancel' }, { label: 'Change password', primary: true, onClick: async (ov) => {
        await api('/auth/password', { current: $('#pwOld', ov).value, next: $('#pwNew', ov).value }); toast('Password changed');
      } }],
    });
  }

  renderMe();
  route();
})();
