/* Exam Wizard: light / dark look, chosen per device (Auto follows the device's own setting).
 * Load this in <head> so the page never flashes in the wrong colours. Buttons go in any element with data-theme-slot.
 */
(function () {
  'use strict';
  var KEY = 'ewTheme';
  var ORDER = ['auto', 'light', 'dark'];
  var LOOK = { auto: { i: '◐', t: 'Auto' }, light: { i: '☀', t: 'Light' }, dark: { i: '☾', t: 'Dark' } };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var root = document.documentElement;

  function pref() { try { var v = localStorage.getItem(KEY); return ORDER.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref();
    root.setAttribute('data-theme', p === 'dark' || (p === 'auto' && mq && mq.matches) ? 'dark' : 'light');
    root.setAttribute('data-theme-pref', p);
    var btns = document.querySelectorAll('.theme-btn');
    for (var i = 0; i < btns.length; i++) draw(btns[i]);
  }
  function draw(b) {
    var p = pref(), next = ORDER[(ORDER.indexOf(p) + 1) % ORDER.length];
    b.innerHTML = '<span class="ti" aria-hidden="true">' + LOOK[p].i + '</span><span class="tl">' + LOOK[p].t + '</span>';
    b.title = 'Colours: ' + LOOK[p].t + (p === 'auto' ? ' (follows this device)' : '') + '. Click for ' + LOOK[next].t + '.';
    b.setAttribute('aria-label', 'Colours: ' + LOOK[p].t + '. Switch to ' + LOOK[next].t);
  }
  function set(p) { try { localStorage.setItem(KEY, p); } catch (e) { /* private mode: this page only */ } apply(); }
  function button() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'theme-btn';
    b.addEventListener('click', function () { set(ORDER[(ORDER.indexOf(pref()) + 1) % ORDER.length]); });
    draw(b);
    return b;
  }
  function mount(scope) {
    var slots = (scope || document).querySelectorAll('[data-theme-slot]');
    for (var i = 0; i < slots.length; i++) if (!slots[i].querySelector('.theme-btn')) slots[i].appendChild(button());
  }

  apply();
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); });
  else mount();
  window.EWTheme = { mount: mount, set: set, pref: pref, button: button };
})();
