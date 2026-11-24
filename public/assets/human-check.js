/* Exam Wizard: the "I'm not a robot" box on the sign-up form.
 * Ticking it asks the site for a small puzzle and solves it in this browser (a second or two). The solved puzzle is sent
 * with the sign-up. No outside service is used. window.EWHuman.attach(element) → { proof(): Promise<object>, reset() }
 */
(function () {
  'use strict';
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function solve(c) {
    const enc = new TextEncoder(), BATCH = 400;
    for (let start = 0; start <= c.max; start += BATCH) {
      const nums = [];
      for (let n = start; n < start + BATCH && n <= c.max; n++) nums.push(n);
      const hashes = await Promise.all(nums.map((n) => crypto.subtle.digest('SHA-256', enc.encode(c.salt + n))));
      for (let i = 0; i < nums.length; i++) if (hex(hashes[i]) === c.hash) return nums[i];
    }
    throw new Error('The check could not be finished. Please tick the box again.');
  }

  function attach(box) {
    box.classList.add('humancheck');
    box.innerHTML = '<label class="hc-box"><input type="checkbox" class="hc-input"><span class="hc-text">I\'m not a robot</span></label><span class="hc-side">Spam check</span>';
    const input = box.querySelector('.hc-input'), text = box.querySelector('.hc-text');
    let proof = null, got = 0, running = null;
    const show = (state, msg) => { box.dataset.state = state; text.textContent = msg; };
    show('idle', 'I\'m not a robot');

    async function run() {
      if (proof && Date.now() - got < 8 * 60000) return proof;
      if (running) return running;
      running = (async () => {
        input.checked = true; input.disabled = true; show('busy', 'Checking…');
        try {
          if (!(window.crypto && crypto.subtle)) throw new Error('This browser is too old for the check. Please update it or use another browser.');
          const res = await fetch('/api/auth/human', { headers: { 'X-Requested-With': 'fetch' }, cache: 'no-store' });
          const c = (await res.json()).challenge;
          const number = await solve(c);
          proof = { salt: c.salt, hash: c.hash, sig: c.sig, number }; got = Date.now();
          show('done', 'Verified: you\'re human');
          return proof;
        } catch (e) {
          input.checked = false; input.disabled = false;
          show('error', e.message && !/fetch|network/i.test(e.message) ? e.message : 'No connection. Tick the box again.');
          throw e;
        } finally { running = null; }
      })();
      return running;
    }
    input.addEventListener('change', () => { if (input.checked) run().catch(() => {}); });
    return {
      proof: run, // ticking is optional: sending the form runs the check too
      reset() { proof = null; input.checked = false; input.disabled = false; show('idle', 'I\'m not a robot'); },
    };
  }
  window.EWHuman = { attach };
})();
