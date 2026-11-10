(async function () {
  'use strict';
  const { $, $$, esc, api, toast, dialog } = App;
  const me = await App.requireRole(['admin']);
  App.renderTopbar(me.user, me.site, [{ href: '/admin', label: 'Admin', on: true }, { href: '/teacher', label: 'Teacher' }]);
  $('#meName').textContent = me.user.name;
  const drawMe = () => { $('.sidenav .avatar').outerHTML = '<div class="avatar">' + App.avatarHtml(me.user, 44) + '</div>'; $('#meName').textContent = me.user.name; };
  drawMe();
  window.addEventListener('profile-changed', (e) => { me.user = Object.assign(me.user, e.detail); drawMe(); });
  const view = $('#view');

  async function badge() {
    const r = await api('/admin/overview');
    $('#reqBadge').hidden = !r.counts.pending_requests;
    $('#reqBadge').textContent = r.counts.pending_requests;
    return r.counts;
  }

  async function route() {
    const name = location.hash.replace(/^#/, '') || 'overview';
    $$('.sidenav a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
    view.innerHTML = '<div class="empty">Loading…</div>';
    if (name !== 'overview') badge().catch(() => {});
    try {
      if (name === 'overview') await overview();
      else if (name === 'requests') await requests();
      else if (name === 'codes') await codes();
      else if (name === 'teachers') await users('teacher');
      else if (name === 'students') await users('student');
      else if (name === 'settings') await settings();
      else if (name === 'admins') await admins();
    } catch (e) { view.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
  }
  window.addEventListener('hashchange', route);

  async function overview() {
    const c = await badge();
    view.innerHTML = `<h1>Overview</h1><div class="statgrid">
      <div class="stat"><b>${c.teachers}</b><span>Teachers</span></div><div class="stat"><b>${c.students}</b><span>Students</span></div>
      <div class="stat"><b>${c.exams}</b><span>Published exams</span></div><div class="stat"><b>${c.attempts}</b><span>Exam attempts</span></div>
      <div class="stat"><b>${c.pending_requests}</b><span>Requests waiting</span></div></div>
      <div class="panel" style="margin-top:16px"><div class="hd"><h3>How teacher access works</h3></div><div class="bd">
        <ul style="margin:0;padding-left:18px">
          <li>Anyone can sign up as a teacher and build classes, questions and exams.</li>
          <li>To <b>publish</b> an exam, a teacher needs <b>full access</b> (days, e.g. a 30-day free trial) or <b>credits</b> (1 credit = 1 exam).</li>
          <li>Give access with <a href="#codes">access codes</a>, or add it directly on the <a href="#teachers">Teachers</a> page.</li>
          <li>Teachers who pay send a <a href="#requests">credit request</a> with their payment reference; approve it once you have checked the payment.</li></ul></div></div>`;
  }

  const money = (n, cur) => { try { return new Intl.NumberFormat('en-PH', { style: 'currency', currency: cur || 'PHP' }).format(n); } catch (e) { return (cur || '') + ' ' + n; } };
  const methodName = (m) => ({ bank: 'Bank transfer', paypal: 'PayPal', other: 'GCash / other' })[m] || m || '';

  async function requests() {
    const r = await api('/admin/requests');
    view.innerHTML = `<div class="panel"><div class="hd"><h2>Credit requests</h2></div><div class="tablewrap"><table class="list"><thead><tr><th>Date</th><th>Teacher</th><th>Request</th><th>Reference / message</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.requests.length ? r.requests.map((q) => `<tr><td class="small nowrap">${esc(App.fmtDate(q.created_at))}</td>
        <td><b>${esc(q.teacher_name)}</b><div class="small muted">${esc(q.teacher_email)}</div><div class="small muted">Has ${q.teacher_credits} cr${q.teacher_until && new Date(q.teacher_until) > Date.now() ? ', access until ' + esc(App.fmtDay(q.teacher_until)) : ''}</div></td>
        <td>${q.kind === 'access' ? 'Free access' : '<b>' + q.credits + '</b> credits'}${q.amount ? '<div class="small">' + esc(money(q.amount, q.currency)) + '</div>' : ''}${q.method ? '<div class="small muted">' + esc(methodName(q.method)) + '</div>' : ''}</td>
        <td class="small">${q.reference ? '<b>Ref:</b> ' + esc(q.reference) + '<br>' : ''}${esc(q.message || '')}${q.proof_image_id ? '<div><a href="/api/admin/requests/' + q.id + '/proof" target="_blank" rel="noopener">View receipt picture</a></div>' : ''}</td>
        <td><span class="tag ${q.status === 'approved' ? 'ok' : q.status === 'rejected' ? 'bad' : 'warn'}">${esc(q.status)}</span></td>
        <td class="nowrap">${q.status === 'pending' ? `<button type="button" class="btn small primary" data-approve="${q.id}">Approve…</button> <button type="button" class="btn small danger" data-reject="${q.id}">Reject</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6"><div class="empty">No requests yet.</div></td></tr>'}</tbody></table></div></div>`;
    $$('[data-reject]').forEach((b) => b.onclick = async () => {
      if (!(await App.confirmBox('Reject request?', 'The teacher will see it as rejected.', 'Reject', true))) return;
      await api('/admin/requests/' + b.dataset.reject, { action: 'reject' }); toast('Rejected'); route(); badge();
    });
    $$('[data-approve]').forEach((b) => b.onclick = () => {
      const q = r.requests.find((x) => x.id === b.dataset.approve);
      dialog('Approve request', `<p style="margin-top:0">${esc(q.teacher_name)} asked for ${q.kind === 'access' ? 'free access' : q.credits + ' credits'}. Give:</p>
        <div class="grid2"><div class="field"><label for="apCred">Credits</label><input type="number" id="apCred" min="0" value="${q.kind === 'credits' ? q.credits : 0}"></div>
        <div class="field"><label for="apDays">Days of full access</label><input type="number" id="apDays" min="0" value="${q.kind === 'access' ? 30 : 0}"></div></div>`, {
        buttons: [{ label: 'Cancel' }, { label: 'Approve', primary: true, onClick: async (ov) => {
          await api('/admin/requests/' + q.id, { action: 'approve', credits: $('#apCred', ov).value, days: $('#apDays', ov).value }); toast('Approved'); route(); badge();
        } }],
      });
    });
  }

  async function codes() {
    const r = await api('/admin/codes');
    view.innerHTML = `<div class="stack"><div class="panel"><div class="hd"><h2>Create access codes</h2></div><div class="bd">
        <div class="grid3"><div class="field"><label for="cKind">Code gives</label><select id="cKind"><option value="days">Days of full access</option><option value="credits">Credits</option></select></div>
          <div class="field"><label for="cAmount">How many (days or credits)</label><input type="number" id="cAmount" min="1" value="30"></div>
          <div class="field"><label for="cCount">Number of codes</label><input type="number" id="cCount" min="1" max="200" value="1"></div>
          <div class="field"><label for="cUses">Uses per code</label><input type="number" id="cUses" min="1" value="1"><div class="hint">More than 1 = one code shared by several teachers</div></div>
          <div class="field"><label for="cExp">Code expires <span class="muted">(optional)</span></label><input type="datetime-local" id="cExp"></div>
          <div class="field"><label for="cNote">Note <span class="muted">(optional)</span></label><input type="text" id="cNote" placeholder="e.g. Free trial, Dept. of EE"></div></div>
        <button type="button" class="btn primary" id="cCreate">Create codes</button><div id="cOut" style="margin-top:12px"></div></div></div>
      <div class="panel"><div class="hd"><h3>All codes</h3></div><div class="tablewrap"><table class="list"><thead><tr><th>Code</th><th>Gives</th><th>Used</th><th>Expires</th><th>Note</th><th>Used by</th><th></th></tr></thead><tbody>
      ${r.codes.length ? r.codes.map((c) => `<tr${c.active ? '' : ' style="opacity:.55"'}><td class="nowrap"><b style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(c.code)}</b> <button type="button" class="btn small" data-copy="${esc(c.code)}">Copy</button></td>
        <td class="nowrap">${c.amount} ${c.kind === 'days' ? 'days' : 'credits'}</td><td class="num">${c.uses} / ${c.max_uses}</td><td class="small nowrap">${esc(App.fmtDate(c.expires_at)) || '—'}</td>
        <td class="small">${esc(c.note || '')}</td><td class="small">${c.used_by.map((u) => esc(u.name)).join(', ')}</td>
        <td><button type="button" class="btn small" data-toggle="${esc(c.code)}" data-active="${c.active}">${c.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty">No codes yet.</div></td></tr>'}</tbody></table></div></div></div>`;
    $('#cKind').onchange = () => { $('#cAmount').value = $('#cKind').value === 'days' ? 30 : 10; };
    $('#cCreate').onclick = async () => {
      try {
        const x = await api('/admin/codes', { kind: $('#cKind').value, amount: $('#cAmount').value, count: $('#cCount').value, maxUses: $('#cUses').value,
          expiresAt: App.fromLocalInput($('#cExp').value), note: $('#cNote').value });
        await codes();
        $('#cOut').innerHTML = '<div class="note ok">Created: ' + x.codes.map((c) => '<span class="code-box" style="font-size:15px;margin:3px">' + esc(c) + '</span>').join(' ') + '</div>';
      } catch (e) { toast(e.message, true); }
    };
    $$('[data-copy]').forEach((b) => b.onclick = () => App.copyText(b.dataset.copy));
    $$('[data-toggle]').forEach((b) => b.onclick = async () => { await api('/admin/codes/' + encodeURIComponent(b.dataset.toggle), { active: b.dataset.active !== 'true' }); codes(); });
  }

  async function users(role) {
    view.innerHTML = `<div class="panel"><div class="hd"><h2>${role === 'teacher' ? 'Teachers' : 'Students'}</h2><input type="search" id="uq" placeholder="Search name or email…" style="max-width:260px" aria-label="Search"></div>
      <div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Email</th>${role === 'teacher' ? '<th>Access</th><th>Classes / exams</th>' : '<th>Student no.</th>'}<th></th></tr></thead><tbody id="urows"></tbody></table></div></div>`;
    const load = async () => {
      const r = await api('/admin/users?role=' + role + '&q=' + encodeURIComponent($('#uq').value));
      $('#urows').innerHTML = r.users.length ? r.users.map((u) => `<tr${u.disabled ? ' style="opacity:.55"' : ''}><td class="user-name"><b>${esc(u.name)}</b>${u.school ? '<div class="small muted">' + esc(u.school) + '</div>' : ''}${u.disabled ? ' <span class="tag bad">Disabled</span>' : ''}</td>
        <td>${esc(u.email)}<div class="small muted">Joined ${esc(App.fmtDay(u.created_at))}</div></td>
        ${role === 'teacher' ? `<td class="small">${u.teacher_until && new Date(u.teacher_until) > Date.now() ? '<span class="tag ok">Until ' + esc(App.fmtDay(u.teacher_until)) + '</span>' : ''} ${u.credits} credit${u.credits === 1 ? '' : 's'}</td><td class="num">${u.class_count} / ${u.exam_count}</td>` : `<td>${esc(u.student_no || '')}</td>`}
        <td><div class="user-actions${role === 'teacher' ? ' two' : ''}">${role === 'teacher' ? `<button type="button" class="btn small primary" data-grant="${u.id}">Give access…</button>` : ''}
          <button type="button" class="btn small" data-reset="${u.id}">Reset password</button><button type="button" class="btn small" data-disable="${u.id}" data-state="${u.disabled}">${u.disabled ? 'Enable' : 'Disable'}</button><button type="button" class="btn small danger" data-delete="${u.id}">Delete</button></div></td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty">Nobody found.</div></td></tr>';
      $$('[data-grant]').forEach((b) => b.onclick = () => {
        const u = r.users.find((x) => x.id === b.dataset.grant);
        dialog('Give access to ' + u.name, `<div class="grid2"><div class="field"><label for="gCred">Add credits</label><input type="number" id="gCred" value="0"><div class="hint">Negative to remove</div></div>
          <div class="field"><label for="gDays">Add days of full access</label><input type="number" id="gDays" value="30"></div></div>
          <div class="field"><label for="gReason">Reason <span class="muted">(shown in their history)</span></label><input type="text" id="gReason" placeholder="e.g. Free trial"></div>`, {
          buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async (ov) => {
            await api('/admin/users/' + u.id, { credits: $('#gCred', ov).value, days: $('#gDays', ov).value, reason: $('#gReason', ov).value }); toast('Saved'); load();
          } }],
        });
      });
      $$('[data-reset]').forEach((b) => b.onclick = async () => {
        if (!(await App.confirmBox('Reset password?', 'This creates a temporary password and signs the user out everywhere. Give it to them privately.', 'Reset password'))) return;
        const x = await api('/admin/users/' + b.dataset.reset + '/reset-password', {});
        dialog('Temporary password', `<p style="margin-top:0">Give this to the user privately. They can change it after signing in.</p><span class="code-box">${esc(x.tempPassword)}</span>`, { buttons: [{ label: 'Done', primary: true }] });
      });
      $$('[data-disable]').forEach((b) => b.onclick = async () => { await api('/admin/users/' + b.dataset.disable, { disabled: b.dataset.state !== 'true' }); load(); });
      $$('[data-delete]').forEach((b) => b.onclick = () => deleteUser(b.dataset.delete, load));
    };
    let t; $('#uq').oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
    await load();
  }

  async function admins() {
    const r = await api('/admin/admins');
    view.innerHTML = `<div class="stack"><div class="panel"><div class="hd"><h2>Admins</h2><button type="button" class="btn primary" id="addAdmin">+ Add admin</button></div>
      <div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Since</th><th></th></tr></thead><tbody>
      ${r.admins.map((a) => `<tr><td><b>${esc(a.name)}</b> ${a.isOwner ? '<span class="tag">Site owner</span>' : ''} ${a.isMe ? '<span class="tag grey">You</span>' : ''}${a.disabled ? ' <span class="tag bad">Disabled</span>' : ''}</td>
        <td>${esc(a.email)}</td><td class="small nowrap">${esc(App.fmtDay(a.created_at))}</td>
        <td class="nowrap">${a.isOwner || a.isMe ? '' : `<button type="button" class="btn small danger" data-demote="${a.id}">Remove admin rights</button>`}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="note info small">Admins can do everything on this console: create access codes, approve credit requests, manage teachers and students, and change site settings.
        They can also publish exams without credits. Removing admin rights turns the person back into a teacher; their classes and exams stay.
        The <b>site owner</b> (the email set as ADMIN_EMAIL on the server) cannot be removed or disabled by other admins, and only the owner can reset an admin's password.</div></div>`;
    $('#addAdmin').onclick = () => dialog('Add an admin', `<div class="field"><label for="adEmail">Email</label><input type="email" id="adEmail" autocomplete="off">
        <div class="hint">If a teacher already uses this email, they are made an admin and keep their classes and exams.</div></div>
      <div class="field"><label for="adName">Full name <span class="muted">(for a new account)</span></label><input type="text" id="adName" autocomplete="off"></div>`, {
      buttons: [{ label: 'Cancel' }, { label: 'Add admin', primary: true, onClick: async (ov) => {
        const x = await api('/admin/admins', { email: $('#adEmail', ov).value, name: $('#adName', ov).value });
        if (x.created) {
          dialog('Admin account created', `<p style="margin-top:0">Give ${esc(x.name)} this <b>temporary password</b> privately. They should change it after signing in (My account → Change password).</p>
            <span class="code-box">${esc(x.tempPassword)}</span>`, { buttons: [{ label: 'Done', primary: true }] });
        } else toast(x.name + ' is now an admin');
        admins();
      } }],
    });
    $$('[data-demote]').forEach((b) => b.onclick = async () => {
      const a = r.admins.find((x) => x.id === b.dataset.demote);
      if (!(await App.confirmBox('Remove admin rights?', a.name + ' will become a teacher. Their classes and exams stay.', 'Remove admin rights', true))) return;
      try { await api('/admin/admins/' + a.id + '/remove', {}); toast(a.name + ' is no longer an admin'); admins(); } catch (e) { toast(e.message, true); }
    });
  }

  /** Shows what will be removed, then asks for the email before deleting for good. */
  async function deleteUser(id, after) {
    let u;
    try { u = (await api('/admin/users/' + id + '/impact')).impact; } catch (e) { toast(e.message, true); return; }
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const lost = u.role === 'teacher'
      ? [plural(u.classes, 'class', 'classes'), plural(u.exams, 'exam', 'exams'), plural(u.questions, 'question', 'questions'), plural(u.student_attempts, 'student result', 'student results')]
      : [plural(u.own_attempts, 'exam attempt', 'exam attempts') + ' and their answers', plural(u.enrollments, 'class membership', 'class memberships')];
    dialog('Delete ' + u.name + '?', `<div class="note bad" style="margin-bottom:12px"><b>This cannot be undone.</b> Deleting this ${u.role} also permanently deletes:
        <ul style="margin:6px 0 0;padding-left:18px">${lost.map((l) => '<li>' + esc(l) + '</li>').join('')}</ul></div>
      ${u.role === 'teacher' && u.exams ? '<p class="small">Tip: to keep their exams and results, use <b>Disable</b> instead: they can no longer sign in, but nothing is lost.</p>' : ''}
      <div class="field"><label for="delEmail">Type <b>${esc(u.email)}</b> to confirm</label><input type="text" id="delEmail" autocomplete="off"></div>`, {
      buttons: [{ label: 'Cancel' }, { label: 'Delete permanently', danger: true, onClick: async (ov) => {
        await api('/admin/users/' + u.id + '/delete', { confirmEmail: $('#delEmail', ov).value });
        toast(u.name + ' was deleted');
        after();
      } }],
    });
  }

  async function settings() {
    const s = (await api('/admin/settings')).settings;
    view.innerHTML = `<div class="panel"><div class="hd"><h2>Site settings</h2></div><div class="bd">
      <div class="grid2"><div class="field"><label for="sName">Site name</label><input type="text" id="sName" value="${esc(s.siteName)}"></div>
        <div class="field"><label for="sTz">Time zone</label><input type="text" id="sTz" value="${esc(s.timeZone)}"><div class="hint">e.g. Asia/Manila</div></div></div>
      <label class="check"><input type="checkbox" id="sTeach"${s.teacherSignup ? ' checked' : ''}> Anyone can sign up as a teacher</label>
      <label class="check"><input type="checkbox" id="sStud"${s.studentSignup ? ' checked' : ''}> Anyone can sign up as a student</label>
      <h3 class="settings-h">Credit packages</h3>
      <div class="grid2"><div class="field"><label for="sPack">Packages, one per line: <code>credits = price</code></label><textarea id="sPack" rows="4">${esc(s.creditPackages)}</textarea>
        <div class="hint">e.g. <code>10 = 100</code> means 10 credits for 100. Teachers pick one of these.</div></div>
        <div class="field"><label for="sCur">Currency</label><input type="text" id="sCur" value="${esc(s.currency)}" maxlength="3" style="text-transform:uppercase;max-width:120px"><div class="hint">PHP, USD …</div></div></div>
      <h3 class="settings-h">Payment methods</h3>
      <div class="paymethod"><label class="check"><input type="checkbox" id="sBankOn"${s.bankEnabled ? ' checked' : ''}> <b>Bank transfer</b></label>
        <div class="field"><label for="sBank">Bank details shown to teachers</label><textarea id="sBank" rows="4">${esc(s.bankDetails)}</textarea><div class="hint">Bank name, account name, account number (and branch or SWIFT code if needed).</div></div></div>
      <div class="paymethod"><label class="check"><input type="checkbox" id="sPpOn"${s.paypalEnabled ? ' checked' : ''}> <b>PayPal</b></label>
        <div id="sPpStatus" class="note small"></div>
        <div class="field"><label for="sPpLink">PayPal.me link or PayPal email <span class="muted">(used when automatic checkout is not set up)</span></label><input type="text" id="sPpLink" value="${esc(s.paypalLink)}" placeholder="https://paypal.me/yourname"></div></div>
      <div class="paymethod"><label class="check"><input type="checkbox" id="sOtherOn"${s.otherEnabled ? ' checked' : ''}> <b>GCash / other</b></label>
        <div class="field"><label for="sPay">Instructions shown to teachers</label><textarea id="sPay" rows="3">${esc(s.paymentInstructions)}</textarea></div></div>
      <h3 class="settings-h">Support</h3>
      <div class="field"><label for="sSupport">Support contact <span class="muted">(optional)</span></label><input type="text" id="sSupport" value="${esc(s.supportContact)}" placeholder="e.g. Email support@abnjworks.com"></div>
      <button type="button" class="btn primary" id="sSave">Save settings</button></div></div>`;
    api('/admin/payments').then((x) => {
      const n = $('#sPpStatus'); if (!n) return;
      n.className = 'note small ' + (x.paypalCheckout ? 'ok' : 'info');
      n.innerHTML = x.paypalCheckout
        ? '✓ <b>Automatic PayPal checkout is on</b>' + (x.paypalCheckout.sandbox ? ' in <b>test mode</b> (sandbox, no real money)' : '') + '. Teachers pay by PayPal or card and their credits are added at once.'
        : 'Automatic checkout is off: teachers send money to the link below and you approve their request. To turn on automatic checkout, add <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> on the server (see the README).';
    }).catch(() => {});
    $('#sSave').onclick = async () => {
      await api('/admin/settings', { siteName: $('#sName').value, timeZone: $('#sTz').value, teacherSignup: $('#sTeach').checked, studentSignup: $('#sStud').checked,
        creditPackages: $('#sPack').value, currency: $('#sCur').value, bankEnabled: $('#sBankOn').checked, bankDetails: $('#sBank').value,
        paypalEnabled: $('#sPpOn').checked, paypalLink: $('#sPpLink').value, otherEnabled: $('#sOtherOn').checked,
        paymentInstructions: $('#sPay').value, supportContact: $('#sSupport').value });
      toast('Settings saved');
    };
  }

  badge();
  route();
})();
