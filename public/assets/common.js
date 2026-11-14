/* Shared helpers for every page. */
(function () {
  'use strict';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body, opts) {
    const res = await fetch('/api' + path, {
      method: body !== undefined ? 'POST' : (opts && opts.method) || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: 'The server did not answer properly. Try again.' }; }
    if (!data.ok) {
      if (data.code === 'SIGNED_OUT' && !(opts && opts.allowSignedOut)) { location.href = '/?next=' + encodeURIComponent(location.pathname + location.hash); }
      const e = new Error(data.error || 'Something went wrong.');
      e.code = data.code;
      throw e;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
  }

  /** Opens a dialog. content: HTML string. Returns { el, close }. */
  function dialog(title, content, { wide, buttons, locked } = {}) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="hd"><h2>${esc(title)}</h2>${locked ? '' : '<button type="button" class="x" aria-label="Close">×</button>'}</div>
      <div class="bd">${content}</div>${buttons ? '<div class="ft"></div>' : ''}</div>`;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && !locked) close(); };
    if (!locked) { $('.x', ov).onclick = close; ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); }); }
    document.addEventListener('keydown', onKey);
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''); btn.textContent = b.label;
      btn.onclick = async () => {
        if (!b.onClick) return close();
        btn.disabled = true;
        try { const keep = await b.onClick(ov); if (keep !== true) close(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
      };
      $('.ft', ov).appendChild(btn);
    });
    document.body.appendChild(ov);
    const first = $('input, select, textarea', ov);
    if (first) first.focus();
    return { el: ov, close };
  }

  function confirmBox(title, text, okLabel, danger) {
    return new Promise((resolve) => {
      const d = dialog(title, `<p style="margin:0">${esc(text)}</p>`, {
        buttons: [{ label: 'Cancel', onClick: () => resolve(false) }, { label: okLabel || 'OK', primary: !danger, danger, onClick: () => resolve(true) }],
      });
      $('.x', d.el).addEventListener('click', () => resolve(false));
    });
  }

  const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
  /** For <input type=datetime-local> */
  const toLocalInput = (d) => { if (!d) return ''; const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied: ' + text); }
    catch (e) { window.prompt('Copy this:', text); }
  }

  /** Top bar with the site name and the signed-in user. */
  function renderTopbar(me, site, links) {
    const bar = document.createElement('header');
    bar.className = 'topbar';
    // Two-tone name: "Exam Wizard" → "Exam" + gold "Wizard"
    const words = String(site.name || '').trim().split(/\s+/);
    const name = words.length > 1 ? esc(words.slice(0, -1).join(' ')) + ' <span class="accent">' + esc(words[words.length - 1]) + '</span>' : esc(site.name);
    bar.innerHTML = `<a class="brand" href="${me ? homeFor(me) : '/'}"><img class="logo" src="/assets/logo.svg" alt="" width="30" height="30"><span class="name">${name}</span></a>
      <div class="who">${me ? `<button type="button" class="me-btn" id="profileBtn" title="My profile">${avatarHtml(me, 30)}<span class="me-text">${esc(me.name)}${me.studentNo ? ' — ' + esc(me.studentNo) : ''}${me.school ? ' — ' + esc(me.school) : ''}</span></button>` : ''}</div>
      <nav>${(links || []).map((l) => `<a href="${esc(l.href)}"${l.on ? ' class="on"' : ''}>${esc(l.label)}</a>`).join('')}
      ${me ? '<button type="button" class="menu-btn" id="signOut">Sign out</button>' : ''}</nav>`;
    document.body.prepend(bar);
    const so = $('#signOut', bar);
    if (so) so.onclick = async () => { await api('/auth/logout', {}); location.href = '/'; };
    const pb = $('#profileBtn', bar);
    if (pb) pb.onclick = () => openProfile(me);
    document.title = document.title.replace('{site}', site.name);
  }

  /** A round profile picture, or the person's initial when there is none. */
  function avatarHtml(u, size) {
    const s = size || 32;
    const initial = esc(String((u && u.name) || '?').trim().charAt(0).toUpperCase() || '?');
    return u && u.avatarUrl
      ? `<img class="avatar-img" src="${esc(u.avatarUrl)}" alt="" width="${s}" height="${s}" style="width:${s}px;height:${s}px">`
      : `<span class="avatar-img initial" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.45)}px" aria-hidden="true">${initial}</span>`;
  }

  /** Crops a photo to the centre square and shrinks it to 256 × 256 (a small JPEG). */
  async function cropAvatar(file) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('The file could not be read.')); r.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a picture this browser can open (use JPEG or PNG).')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return c.toDataURL('image/jpeg', 0.86);
  }

  /** "My profile": picture, name, student number, school and password, for every kind of account. */
  function openProfile(me) {
    let user = me;
    const d = dialog('My profile', `<div class="profile-pic"><div id="pfPic">${avatarHtml(user, 96)}</div>
        <div><label class="btn small" for="pfFile" style="cursor:pointer">Change picture</label><input type="file" id="pfFile" accept="image/*" class="sr-only">
          <button type="button" class="btn small danger" id="pfRemove"${user.avatarUrl ? '' : ' hidden'}>Remove</button>
          <div class="hint">A clear photo of your face helps your teachers recognise you. It is cropped to a square.</div></div></div>
      <div class="field"><label for="pfName">Full name</label><input type="text" id="pfName" value="${esc(user.name)}"></div>
      ${user.role === 'student' ? `<div class="field"><label for="pfNo">Student number</label><input type="text" id="pfNo" value="${esc(user.studentNo)}"></div>` : ''}
      <div class="field"><label for="pfSchool">School name</label><input type="text" id="pfSchool" value="${esc(user.school)}"></div>
      <p class="small muted" style="margin:0">Signed in as ${esc(user.email)}</p>
      <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Change password</summary>
        <div class="field" style="margin-top:8px"><label for="pfOld">Current password</label><input type="password" id="pfOld" autocomplete="current-password"></div>
        <div class="field"><label for="pfNew">New password</label><input type="password" id="pfNew" autocomplete="new-password"><div class="hint">At least 8 characters.</div></div>
        <button type="button" class="btn small" id="pfPw">Change password</button></details>`, {
      buttons: [{ label: 'Close' }, { label: 'Save profile', primary: true, onClick: async (ov) => {
        const r = await api('/auth/profile', { name: $('#pfName', ov).value, studentNo: $('#pfNo', ov) ? $('#pfNo', ov).value : undefined, school: $('#pfSchool', ov).value });
        updated(r.user); toast('Profile saved');
      } }],
    });
    const ov = d.el;
    function updated(u) {
      user = u;
      Object.assign(me, u);
      $('#pfPic', ov).innerHTML = avatarHtml(u, 96);
      $('#pfRemove', ov).hidden = !u.avatarUrl;
      const pb = $('#profileBtn');
      if (pb) pb.innerHTML = avatarHtml(u, 30) + `<span class="me-text">${esc(u.name)}${u.studentNo ? ' — ' + esc(u.studentNo) : ''}${u.school ? ' — ' + esc(u.school) : ''}</span>`;
      window.dispatchEvent(new CustomEvent('profile-changed', { detail: u }));
    }
    $('#pfFile', ov).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const r = await api('/auth/avatar', { dataUrl: await cropAvatar(f) }); updated(r.user); toast('Picture updated'); }
      catch (err) { toast(err.message, true); }
      e.target.value = '';
    };
    $('#pfRemove', ov).onclick = async () => { const r = await api('/auth/avatar/remove', {}); updated(r.user); toast('Picture removed'); };
    $('#pfPw', ov).onclick = async () => {
      try { await api('/auth/password', { current: $('#pfOld', ov).value, next: $('#pfNew', ov).value }); $('#pfOld', ov).value = ''; $('#pfNew', ov).value = ''; toast('Password changed'); }
      catch (err) { toast(err.message, true); }
    };
  }

  /** Loads the signed-in user; sends them to the right page if their role doesn't match. */
  async function requireRole(roles) {
    const r = await api('/auth/me', undefined, { allowSignedOut: true });
    if (!r.user) { location.href = '/?next=' + encodeURIComponent(location.pathname + location.hash); throw new Error('signed out'); }
    if (roles && !roles.includes(r.user.role)) { location.href = homeFor(r.user); throw new Error('wrong role'); }
    if (r.user.mustChangePassword) setTimeout(chooseNewPassword, 300);
    return r;
  }
  /** After signing in with a temporary password from an admin: choose your own password first. */
  function chooseNewPassword() {
    dialog('Choose your own password', `<p style="margin-top:0">You signed in with a temporary password. Choose your own password to continue.</p>
      <div class="field"><label for="cnNew">New password</label><input type="password" id="cnNew" autocomplete="new-password"><div class="hint">At least 8 characters.</div></div>
      <div class="field"><label for="cnAgain">Type it again</label><input type="password" id="cnAgain" autocomplete="new-password"></div>`, {
      locked: true,
      buttons: [{ label: 'Save password', primary: true, onClick: async (ov) => {
        if ($('#cnNew', ov).value !== $('#cnAgain', ov).value) throw new Error('The two passwords are not the same.');
        await api('/auth/password', { next: $('#cnNew', ov).value });
        toast('Password saved');
      } }],
    });
  }
  const homeFor = (u) => (u.role === 'student' ? '/student' : u.role === 'admin' ? '/admin' : '/teacher');

  /** Shrinks a picture file to ≤ 2 MB (JPEG); small JPEG/PNG files are kept as they are. */
  async function pictureToDataUrl(file) {
    const MAX = 2 * 1024 * 1024;
    const read = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('The file could not be read.')); r.readAsDataURL(f); });
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a picture this browser can open (use JPEG or PNG).')); i.src = src; });
    const bytes = (u) => { const b = u.slice(u.indexOf(',') + 1); return Math.floor(b.length * 3 / 4); };
    const url = await read(file);
    const img = await load(url);
    if (file.size <= MAX && /^image\/(jpeg|png|gif|webp)$/.test(file.type)) return { dataUrl: url, note: 'Original kept (' + Math.round(file.size / 1024) + ' KB)' };
    let maxSide = 2000, q = 0.88, out = url, w = 0, h = 0;
    for (let i = 0; i < 20; i++) {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.max(1, Math.round(img.naturalWidth * s)); h = Math.max(1, Math.round(img.naturalHeight * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      out = c.toDataURL('image/jpeg', q);
      if (bytes(out) <= MAX * 0.95) break;
      if (q > 0.6) q -= 0.1; else maxSide = Math.round(maxSide * 0.8);
    }
    if (bytes(out) > MAX) throw new Error('This picture could not be made smaller than 2 MB.');
    return { dataUrl: out, note: 'Shrunk from ' + (file.size / 1048576).toFixed(1) + ' MB to ' + (bytes(out) / 1048576).toFixed(2) + ' MB (' + w + ' × ' + h + ')' };
  }

  window.App = { $, $$, esc, api, toast, dialog, confirmBox, fmtDate, fmtDay, toLocalInput, fromLocalInput, copyText, renderTopbar, requireRole, homeFor, pictureToDataUrl, avatarHtml, openProfile };
})();
