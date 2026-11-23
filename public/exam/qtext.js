/* Exam Wizard: how question text is shown.
 * - Math between dollar signs is drawn with KaTeX: $V_S$, $10^{-3}$, $\Omega$, $\sqrt{3}$, $\frac{P}{\sqrt{3}V}$.
 *   Write \$ for a plain dollar sign. "$5 and $10" stays as plain text (a $ followed by a space or a digit after the closing $ is not math).
 * - A fill-in-the-blank question with several blanks is shown as the explanation on top and one answer line per blank:
 *   a) $V_S$ = [box] kV, b) $I_S$ = [box] A … The label and the unit are taken from the words around each blank.
 * Used by the exam page, the preview, the offline exam and the teacher pages (window.EWQ).
 */
(function () {
  'use strict';
  // \$ (a plain dollar), or $…$ that doesn't start or end with a space and isn't followed by a digit
  const MATH = /\\\$|\$(?=[^\s$])((?:\\.|[^$\\\n])*?[^\s\\$])\$(?!\d)/g;
  const BLANK = /_{3,}/;

  const SKIP = { INPUT: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1, SELECT: 1, OPTION: 1, CODE: 1 };

  /** True when the text has math in it. */
  function hasMath(s) { MATH.lastIndex = 0; let m; while ((m = MATH.exec(String(s || '')))) if (m[0] !== '\\$') return true; return false; }

  /** Draws the math in the text of an element (and everything inside it). Safe to call more than once. */
  function render(root) {
    if (!root || !String(root.textContent || '').includes('$')) return root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.includes('$')) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentNode; p && p !== root.parentNode; p = p.parentNode) {
          if (SKIP[p.nodeName] || (p.classList && (p.classList.contains('katex') || p.classList.contains('no-math')))) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      const s = n.nodeValue, frag = document.createDocumentFragment();
      let last = 0, changed = false, m;
      MATH.lastIndex = 0;
      while ((m = MATH.exec(s))) {
        if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        if (m[0] === '\\$') frag.appendChild(document.createTextNode('$'));
        else frag.appendChild(mathEl(m[1]));
        last = m.index + m[0].length; changed = true;
      }
      if (!changed) return;
      if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
    return root;
  }

  function mathEl(tex) {
    const span = document.createElement('span');
    span.className = 'math';
    if (window.katex) {
      try { window.katex.render(tex, span, { throwOnError: false, strict: 'ignore', output: 'html' }); span.setAttribute('aria-label', tex); return span; }
      catch (e) { /* fall through: show the text */ }
    }
    span.textContent = '$' + tex + '$';
    return span;
  }

  /** Puts plain text in an element and draws its math. */
  function setText(el, text) { el.textContent = text == null ? '' : String(text); return render(el); }

  // ── Answer lines for several blanks ──

  /** Same text with the math hidden (same length), so commas or brackets inside math don't count as separators. */
  function mask(s) {
    MATH.lastIndex = 0;
    return s.replace(MATH, (m) => (m === '\\$' ? m : '\u0001'.repeat(m.length)));
  }
  const ENUM_AT_START = /^\s*\(?\s*([a-h]|i{1,3}|iv|vi{0,3}|ix|x|\d{1,2})\s*\)\s*/i;
  // what can come right before a label: (a)  a)  ;  :  ,  a new line  a sentence end  "and"
  const SEP = /\(\s*(?:[a-h]|i{1,3}|iv|vi{0,3}|ix|x|\d{1,2})\s*\)|(?:^|(?<=\s))(?:[a-h]|\d{1,2})\)|;|:(?=\s|$)|,(?=\s)|\n|[.?!](?=\s)|\band\b|\bthen\b/gi;
  const isEnum = (t) => /\)\s*$/.test(t);

  /** Where the label of a blank starts in the text before it: { cut, start } (cut = end of the text before the label). */
  function labelStart(raw) {
    const s = mask(raw);
    let best = null, m;
    SEP.lastIndex = 0;
    while ((m = SEP.exec(s))) {
      if (m[0] === '') { SEP.lastIndex++; continue; }
      const enumerator = isEnum(m[0]);
      const start = enumerator ? m.index : m.index + m[0].length;
      if (enumerator || raw.slice(start).trim()) best = { cut: m.index, start };
    }
    if (best) return best;
    // no separator: "… V = ____ kV I = ____" → the label is the word before "="
    const eq = /(\S+\s*=\s*)$/.exec(s);
    if (eq && eq.index > 0) return { cut: eq.index, start: eq.index };
    return { cut: 0, start: 0 };
  }

  /**
   * Splits a fill-in-the-blank question with several blanks into an explanation and one line per blank.
   * Returns null when there are fewer than two blanks.
   * { stem, lines: [{ tag: 'a)', label: '$V_S$ =', unit: 'kV' }], tail }
   */
  function blankLines(text) {
    const parts = String(text || '').split(/_{3,}/);
    if (parts.length < 3) return null;
    const n = parts.length - 1, lines = [];
    // label of the first blank: the end of the explanation
    let first = labelStart(parts[0]);
    const stem = parts[0].slice(0, first.cut).trim();
    let label = parts[0].slice(first.start);
    let tail = '';
    for (let i = 0; i < n; i++) {
      const after = parts[i + 1];
      let unit, nextLabel = '';
      if (i < n - 1) {
        const ls = labelStart(after);
        unit = after.slice(0, ls.cut);
        nextLabel = after.slice(ls.start);
      } else {
        const m = /[;,\n]|[.?!](?=\s|$)/.exec(mask(after));
        unit = m ? after.slice(0, m.index) : after;
        tail = m ? after.slice(m.index + m[0].length) : '';
        if (unit.trim().length > 24) { tail = after.replace(/^\s*[.,;]?\s*/, ''); unit = ''; }
      }
      unit = unit.replace(/(\s*(\band\b|,|;|then))+\s*$/i, '').trim();
      lines.push(splitTag(label.trim(), i, unit));
      label = nextLabel;
    }
    return { stem, lines, tail: tail.trim() };
  }

  function splitTag(label, i, unit) {
    const m = ENUM_AT_START.exec(label);
    if (m) return { tag: m[1].toLowerCase() + ')', label: label.slice(m[0].length).trim(), unit };
    return { tag: String.fromCharCode(97 + (i % 26)) + ')', label, unit };
  }

  /**
   * The answer lines for a question with several blanks, ready to put on the page.
   * values: the saved answers (one per blank); onInput(values) is called when the student types.
   * Returns { stem, el, inputs } or null.
   */
  function blankLinesEl(text, values, onInput, opts) {
    const b = blankLines(text);
    if (!b) return null;
    const o = opts || {};
    const box = document.createElement('div');
    box.className = 'blank-lines';
    const inputs = [];
    b.lines.forEach((ln, i) => {
      const row = document.createElement('div');
      row.className = 'blank-line';
      const tag = document.createElement('span'); tag.className = 'bl-tag'; tag.textContent = ln.tag;
      const lab = document.createElement('label'); lab.className = 'bl-label';
      const id = (o.idPrefix || 'bl') + '_' + Math.random().toString(36).slice(2, 8) + '_' + i;
      lab.htmlFor = id; setText(lab, ln.label);
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'blank'; inp.id = id;
      inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.setAttribute('aria-label', 'Answer ' + ln.tag + (ln.label ? ' ' + ln.label.replace(/\$/g, '') : ''));
      inp.value = (values && values[i]) || '';
      if (onInput) inp.addEventListener('input', () => onInput(inputs.map((x) => x.value)));
      inputs.push(inp);
      row.append(tag, lab, inp);
      if (ln.unit) { const u = document.createElement('span'); u.className = 'bl-unit'; setText(u, ln.unit); row.appendChild(u); }
      box.appendChild(row);
    });
    if (b.tail) { const t = document.createElement('p'); t.className = 'bl-tail'; setText(t, b.tail); box.appendChild(t); }
    return { stem: b.stem, el: box, inputs };
  }

  window.EWQ = { render, setText, hasMath, blankLines, blankLinesEl, BLANK };
})();
