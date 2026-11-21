// PDF viewer find bar (plan PWP-10, spec §7.4): our own bar over pdf.js's PDFFindController.
// Loaded after pdfViewer.js; registers on the global `PdfViewerShell`. Also loaded via `vm` by the tests.
// Rules (plan §1): no HTML string building (document text only ever reaches textContent), no style attributes.
(function (global) {
  'use strict';

  const MAX_QUERY = 500;
  const MAX_SEED = 100;
  // pdf.js FindState
  const FOUND = 0, WRAPPED = 2, PENDING = 3;
  const SEARCHING = 'Searching…';

  const TEXT = {
    label: 'Find in document',
    placeholder: 'Find',
    noText: 'This PDF has no text layer (it looks like a scan). Selecting and searching text aren’t available.',
    notFound: 'No matches',
    wrappedNext: 'Reached the end of the document; continued from the top.',
    wrappedPrev: 'Reached the top of the document; continued from the end.',
  };

  function create(shell, doc, win) {
    const mk = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) { e.className = cls; }
      if (text !== undefined) { e.textContent = text; }
      return e;
    };
    const button = (cls, text, label, title, onClick) => {
      const b = mk('button', 'pdf-find-btn ' + cls, text);
      b.setAttribute('type', 'button');
      b.setAttribute('aria-label', label);
      b.setAttribute('title', title);
      b.addEventListener('click', onClick);
      return b;
    };
    const prevent = (ev) => { if (ev && ev.preventDefault) { ev.preventDefault(); } };

    const saved = shell.getState('find') || {};
    const opts = {
      matchCase: saved.matchCase === true,
      wholeWord: saved.wholeWord === true,
      highlightAll: saved.highlightAll !== false,
    };
    let open = false, built = false;
    let bus = null, controller = null;
    let noText = false;
    let returnFocus = null;
    let lastKind = 'type';          // 'type' | 'next' | 'prev': what the user did last (decides what is announced)
    let counts = { current: 0, total: 0 };
    let findState = FOUND;
    let lastAnnounced = '';

    let bar, input, countEl, noteEl, caseBtn, wordBtn, allBtn, prevBtn, nextBtn, closeBtn;

    function build() {
      if (built || !shell.main) { return; }
      built = true;
      bar = mk('div', 'pdf-find');
      bar.setAttribute('role', 'search');
      bar.setAttribute('aria-label', TEXT.label);
      bar.hidden = true;
      input = mk('input', 'pdf-find-input');
      input.setAttribute('type', 'text');
      input.setAttribute('aria-label', 'Find');
      input.setAttribute('placeholder', TEXT.placeholder);
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('maxlength', String(MAX_QUERY));
      input.setAttribute('aria-describedby', 'pdf-find-count');
      input.addEventListener('input', () => { lastKind = 'type'; run('', false); });
      input.addEventListener('keydown', onInputKey);
      caseBtn = button('pdf-find-opt', 'Aa', 'Match case', 'Match case', () => toggle('matchCase'));
      wordBtn = button('pdf-find-opt', 'Word', 'Whole words', 'Whole words', () => toggle('wholeWord'));
      allBtn = button('pdf-find-opt', 'All', 'Highlight all', 'Highlight all matches', () => toggle('highlightAll'));
      prevBtn = button('pdf-find-nav', '↑', 'Previous match', 'Previous match (Shift+Enter)', () => step(true));
      nextBtn = button('pdf-find-nav', '↓', 'Next match', 'Next match (Enter)', () => step(false));
      closeBtn = button('pdf-find-close', '×', 'Close find', 'Close find (Escape)', () => close(true));
      // Visual count; what is spoken goes through the shell's live region (announce), not through this element.
      countEl = mk('span', 'pdf-find-count', '');
      countEl.id = 'pdf-find-count';
      noteEl = mk('div', 'pdf-find-note', '');
      noteEl.hidden = true;
      const row = mk('div', 'pdf-find-row');
      [input, caseBtn, wordBtn, allBtn, prevBtn, nextBtn, countEl, closeBtn].forEach((n) => row.appendChild(n));
      bar.appendChild(row);
      bar.appendChild(noteEl);
      bar.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && ev.target !== input) { prevent(ev); close(true); return; }
        // Nothing typed or pressed in the bar reaches the viewer's own shortcuts (arrows, Home, End, tool letters).
        if (ev.stopPropagation && !(ev.ctrlKey || ev.metaKey) && ev.key !== 'F3') { ev.stopPropagation(); }
      });
      shell.main.appendChild(bar);
      syncButtons();
      syncNote();
    }

    function syncButtons() {
      if (!built) { return; }
      caseBtn.setAttribute('aria-pressed', String(opts.matchCase));
      wordBtn.setAttribute('aria-pressed', String(opts.wholeWord));
      allBtn.setAttribute('aria-pressed', String(opts.highlightAll));
      [input, caseBtn, wordBtn, allBtn, prevBtn, nextBtn].forEach((b) => { b.disabled = noText; });
    }

    function syncNote() {
      if (!built) { return; }
      noteEl.textContent = noText ? TEXT.noText : '';
      noteEl.hidden = !noText;
    }

    function toggle(key) {
      opts[key] = !opts[key];
      shell.setState('find', { matchCase: opts.matchCase, wholeWord: opts.wholeWord, highlightAll: opts.highlightAll });
      syncButtons();
      lastKind = 'type';
      run(key === 'highlightAll' ? 'highlightallchange' : '', false);
    }

    // ---------- pdf.js bus ----------

    function bind() {
      controller = shell.findController;
      const b = shell.eventBus;
      if (!b || b === bus) { return; }
      bus = b;
      b.on('updatefindcontrolstate', (e) => { if (bus === b) { onState(e); } });
      b.on('updatefindmatchescount', (e) => { if (bus === b) { onCount(e && e.matchesCount); } });
    }

    /** Sends the query to pdf.js. type '' = new search, 'again' = next/previous, 'highlightallchange'. */
    function run(type, previous) {
      if (!built) { return; }
      bind();
      const query = input.value;
      if (noText || query === '') {
        counts = { current: 0, total: 0 };
        findState = FOUND;
        render();
        if (bus && query === '') { bus.dispatch('findbarclose', { source: shell }); }   // clears the highlights
        else if (noText && query !== '') { shell.hint(TEXT.noText); }
        return;
      }
      if (!bus) { return; }
      bus.dispatch('find', {
        source: shell, type, query,
        caseSensitive: opts.matchCase, entireWord: opts.wholeWord, highlightAll: opts.highlightAll,
        findPrevious: !!previous, matchDiacritics: false,
      });
    }

    function step(previous) {
      if (input.value === '') { if (input.focus) { input.focus(); } return; }
      lastKind = previous ? 'prev' : 'next';
      run('again', previous);
    }

    function onCount(c) {
      if (c) { counts = { current: c.current | 0, total: c.total | 0 }; }
      render();
      maybeAnnounce();
    }

    function onState(e) {
      if (!e) { return; }
      findState = e.state;
      if (e.matchesCount) { counts = { current: e.matchesCount.current | 0, total: e.matchesCount.total | 0 }; }
      render();
      maybeAnnounce();
    }

    /** pdf.js extracts page text lazily: the total is "more than N" until every page has been scanned. */
    function scanComplete() {
      const pending = controller && controller._pendingFindMatches;
      return !pending || typeof pending.size !== 'number' || pending.size === 0;
    }

    function countText() {
      if (noText || input.value === '') { return ''; }
      const complete = scanComplete();
      if (counts.total === 0) { return complete && findState !== PENDING ? TEXT.notFound : SEARCHING; }
      const total = complete ? String(counts.total) : 'more than ' + counts.total;
      if (counts.current > 0) { return counts.current + ' of ' + total; }
      return complete ? counts.total + (counts.total === 1 ? ' match' : ' matches') : total + ' matches';
    }

    function render() {
      if (!built) { return; }
      const t = countText();
      countEl.textContent = t;
      const none = t === TEXT.notFound;
      input.setAttribute('aria-invalid', none ? 'true' : 'false');
      countEl.className = 'pdf-find-count' + (none ? ' pdf-find-none' : '');
    }

    function maybeAnnounce() {
      if (!open || noText || input.value === '' || findState === PENDING) { return; }
      if (!scanComplete() && lastKind === 'type') { return; }   // typing: say the final count, not every step
      let msg = countText();
      if (!msg || msg === SEARCHING) { return; }
      if (findState === WRAPPED && counts.total > 0) { msg = (lastKind === 'prev' ? TEXT.wrappedPrev : TEXT.wrappedNext) + ' ' + msg; }
      if (msg === lastAnnounced) { return; }
      lastAnnounced = msg;
      shell.announce(msg);
    }

    // ---------- open / close ----------

    function seedFromSelection() {
      try {
        const sel = win.getSelection ? win.getSelection() : null;
        const t = sel ? String(sel.toString()).replace(/\s+/g, ' ').trim() : '';
        if (t && t.length <= MAX_SEED) { return t; }
      } catch (e) { /* no selection API */ }
      return '';
    }

    function openBar() {
      build();
      if (!built) { return; }
      bind();
      const a = doc.activeElement;
      if (!open && !(a && bar.contains(a))) { returnFocus = a || null; }
      const seed = seedFromSelection();
      open = true;
      bar.hidden = false;
      syncButtons();
      syncNote();
      lastKind = 'type';
      if (seed && !noText && seed !== input.value) { input.value = seed; lastAnnounced = ''; run('', false); }
      else if (input.value !== '') { run('', false); }
      if (noText) { shell.hint(TEXT.noText); return; }
      if (input.focus) { input.focus(); }
      if (input.select) { input.select(); }
    }

    function close(restoreFocus) {
      if (!open) { return; }
      open = false;
      bar.hidden = true;
      lastAnnounced = '';
      if (bus) { bus.dispatch('findbarclose', { source: shell }); }
      if (restoreFocus) {
        const back = returnFocus;
        returnFocus = null;
        const target = back && !bar.contains(back) && back.visible !== false ? back : shell.container;
        if (target && target.focus) { target.focus(); }
      }
    }

    function onInputKey(ev) {
      const key = ev.key;
      if (key === 'Enter' || key === 'F3') { prevent(ev); step(!!ev.shiftKey); }
      else if (key === 'Escape') { prevent(ev); close(true); }
      else if ((ev.ctrlKey || ev.metaKey) && (key === 'f' || key === 'F')) { prevent(ev); if (input.select) { input.select(); } }
    }

    // ---------- shell wiring ----------

    shell.registerKey({ key: 'f', ctrl: true }, () => { openBar(); });
    shell.registerKey({ key: 'f3' }, (ev) => {
      if (!open) { openBar(); return; }
      step(!!(ev && ev.shiftKey));
    });
    shell.registerKey({ key: 'escape' }, () => { if (!open) { return false; } close(true); });

    function reset() {
      counts = { current: 0, total: 0 };
      findState = FOUND;
      lastAnnounced = '';
    }
    shell.on('documentloaded', () => {
      noText = false;
      reset();
      bind();
      syncButtons(); syncNote(); render();
      if (open && input.value !== '') { lastKind = 'type'; run('', false); }
    });
    shell.on('documentclosed', () => {
      noText = false;
      reset();
      if (open) { close(false); }
      syncButtons(); syncNote(); render();
    });
    shell.on('viewerchanged', () => {
      bind();
      if (open && input.value !== '') { lastKind = 'type'; run('', false); }
    });
    shell.on('facts', (facts) => {
      noText = !!facts && facts.hasText === false && (facts.pageCount | 0) > 0;
      syncButtons(); syncNote();
      if (noText && open) { shell.hint(TEXT.noText); }
    });

    return {
      open: openBar, close, next: () => step(false), previous: () => step(true),
      get isOpen() { return open; },
      get options() { return Object.assign({}, opts); },
      get bar() { return bar || null; },
    };
  }

  const api = { create, TEXT };
  global.PdfFind = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (global.PdfViewerShell && global.document) {
    global.PdfFindBar = create(global.PdfViewerShell, global.document, global);
  }
})(typeof window !== 'undefined' ? window : globalThis);
