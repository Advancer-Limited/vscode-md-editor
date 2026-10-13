// @ts-nocheck
// Find / Replace bar for the Markdown editor webview.
//
// Exposed as a UMD-style module so the pure match logic can be unit tested
// under Node (via `require`) while the webview loads it as globals
// (`findMatches`, `initFindBar`).
//
// Two search targets, chosen by the current view mode:
//  - Edit (WYSIWYG) mode searches the *rendered* text of the contenteditable
//    preview. Matches are painted with the CSS Custom Highlight API, which
//    never touches the DOM — so it can't disturb the caret or trigger the
//    HTML→markdown sync. Replace goes through execCommand('insertText'), which
//    fires a normal `input` event and keeps native undo working.
//  - Raw / Split mode searches the markdown source in the textarea.
(function (global) {
  'use strict';

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Find all non-overlapping occurrences of `query` in `text`.
   * @returns {{start: number, end: number}[]}
   */
  function findMatches(text, query, caseSensitive) {
    if (!query) {
      return [];
    }
    const re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,div,tr';

  /**
   * @param {{
   *   textarea: HTMLTextAreaElement,
   *   previewContent: HTMLElement,
   *   editorContainer: HTMLElement,
   *   isPreviewMode: () => boolean,
   * }} deps
   */
  function initFindBar(deps) {
    const { textarea, previewContent, editorContainer, isPreviewMode } = deps;

    const bar = document.getElementById('find-bar');
    const findInput = document.getElementById('find-input');
    const replaceInput = document.getElementById('replace-input');
    const replaceRow = document.getElementById('find-replace-row');
    const countEl = document.getElementById('find-count');
    const caseBtn = document.getElementById('find-case');
    const toggleReplaceBtn = document.getElementById('find-toggle-replace');
    if (!bar || !findInput || !replaceInput) {
      return;
    }

    const hasHighlights =
      typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

    let isOpen = false;
    let caseSensitive = false;
    let matches = []; // {start, end} offsets into the searched text
    let current = -1;
    let anchor = 0; // start offset of the current match; survives text changes
    let segments = []; // preview mode: [{node, start, length}] text-node map
    let refreshTimer = null;
    let searchedText = null; // text the current matches were computed against

    // ---------- Text collection ----------

    /** Preview mode: concatenated rendered text, with '\n' between blocks. */
    function collectPreviewText() {
      segments = [];
      let text = '';
      let lastBlock = null;
      const walker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        // A SHOW_TEXT walker never offers element nodes to its filter, so
        // rejectMermaidBlocks can't be used here — test the ancestry instead.
        if (node.parentElement && node.parentElement.closest('.mermaid-block')) {
          continue;
        }
        const block = node.parentElement ? node.parentElement.closest(BLOCK_SELECTOR) : null;
        if (lastBlock !== null && block !== lastBlock) {
          text += '\n';
        }
        lastBlock = block;
        segments.push({ node, start: text.length, length: node.data.length });
        text += node.data;
      }
      return text;
    }

    function searchText() {
      return isPreviewMode() ? collectPreviewText() : textarea.value;
    }

    /** Preview mode: build a DOM Range for an offset span of the collected text. */
    function toRange(start, end) {
      // Binary search for the first segment ending past (or, if inclusive, at) `from`.
      function firstSegment(from, inclusive) {
        let lo = 0;
        let hi = segments.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const segEnd = segments[mid].start + segments[mid].length;
          if (inclusive ? segEnd >= from : segEnd > from) {
            hi = mid;
          } else {
            lo = mid + 1;
          }
        }
        return segments[lo] || null;
      }
      const startSeg = firstSegment(start, false);
      const endSeg = firstSegment(end, true);
      if (!startSeg || !endSeg) {
        return null;
      }
      const range = document.createRange();
      range.setStart(startSeg.node, Math.max(0, start - startSeg.start));
      range.setEnd(endSeg.node, Math.min(endSeg.length, end - endSeg.start));
      return range;
    }

    // ---------- Highlighting / navigation ----------

    function clearHighlights() {
      if (hasHighlights) {
        CSS.highlights.delete('find-match');
        CSS.highlights.delete('find-current');
      }
    }

    /** Pixel offset of a character index inside the textarea, via a mirror div. */
    function textareaOffsetTop(index) {
      const cs = getComputedStyle(textarea);
      const mirror = document.createElement('div');
      for (const prop of [
        'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'whiteSpace', 'wordBreak', 'overflowWrap',
      ]) {
        mirror.style[prop] = cs[prop];
      }
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.boxSizing = 'border-box';
      // clientWidth already excludes the borders, so the mirror must have none.
      mirror.style.border = '0';
      mirror.style.width = textarea.clientWidth + 'px';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.textContent = textarea.value.substring(0, index);
      const marker = document.createElement('span');
      marker.textContent = '​';
      mirror.appendChild(marker);
      document.body.appendChild(mirror);
      const top = marker.offsetTop;
      mirror.remove();
      return top;
    }

    function paint(reveal) {
      clearHighlights();
      if (current < 0 || current >= matches.length) {
        return;
      }
      const m = matches[current];
      if (isPreviewMode()) {
        const ranges = [];
        let currentRange = null;
        matches.forEach((mm, i) => {
          const r = toRange(mm.start, mm.end);
          if (!r) {
            return;
          }
          if (i === current) {
            currentRange = r;
          } else {
            ranges.push(r);
          }
        });
        if (hasHighlights) {
          CSS.highlights.set('find-match', new Highlight(...ranges));
          if (currentRange) {
            CSS.highlights.set('find-current', new Highlight(currentRange));
          }
        }
        if (reveal && currentRange) {
          const el = currentRange.startContainer.parentElement;
          if (el) {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
          }
        }
      } else if (reveal) {
        textarea.setSelectionRange(m.start, m.end);
        const top = textareaOffsetTop(m.start);
        if (top < textarea.scrollTop || top > textarea.scrollTop + textarea.clientHeight - 40) {
          textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
        }
      }
    }

    function updateCount() {
      if (!findInput.value) {
        countEl.textContent = '';
        countEl.classList.remove('no-results');
      } else if (matches.length === 0) {
        countEl.textContent = 'No results';
        countEl.classList.add('no-results');
      } else {
        countEl.textContent = current + 1 + ' of ' + matches.length;
        countEl.classList.remove('no-results');
      }
    }

    /** Recompute matches against the current text; keep the nearest match. */
    function refresh(reveal) {
      if (!isOpen) {
        return;
      }
      searchedText = searchText();
      matches = findMatches(searchedText, findInput.value, caseSensitive);
      if (matches.length === 0) {
        current = -1;
      } else {
        const idx = matches.findIndex((m) => m.start >= anchor);
        current = idx === -1 ? 0 : idx;
        anchor = matches[current].start;
      }
      paint(reveal);
      updateCount();
    }

    function scheduleRefresh() {
      if (!isOpen) {
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh(false), 120);
    }

    /** Re-run the search if the document changed without us hearing about it. */
    function ensureFresh() {
      if (searchText() !== searchedText) {
        refresh(false);
      }
    }

    function step(dir) {
      ensureFresh();
      if (matches.length === 0) {
        return;
      }
      current = (current + dir + matches.length) % matches.length;
      anchor = matches[current].start;
      paint(true);
      updateCount();
    }

    // ---------- Replace ----------

    function insertInto(target, text) {
      target.focus();
      if (!document.execCommand('insertText', false, text) && target === textarea) {
        textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input'));
      }
    }

    function replaceCurrent() {
      ensureFresh();
      if (current < 0 || matches.length === 0) {
        return;
      }
      const m = matches[current];
      const text = replaceInput.value;
      if (isPreviewMode()) {
        const range = toRange(m.start, m.end);
        if (!range) {
          return;
        }
        previewContent.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } else {
        textarea.focus();
        textarea.setSelectionRange(m.start, m.end);
        insertInto(textarea, text);
      }
      // Resume after the replacement so a replacement that itself contains
      // the query can't be matched again.
      anchor = m.start + text.length;
      replaceInput.focus();
      refresh(true);
    }

    function replaceAll() {
      ensureFresh();
      if (matches.length === 0) {
        return;
      }
      const text = replaceInput.value;
      if (isPreviewMode()) {
        // Ranges are computed up front and applied back-to-front so earlier
        // offsets stay valid.
        const ranges = matches.map((m) => toRange(m.start, m.end)).filter(Boolean);
        previewContent.focus();
        const sel = window.getSelection();
        for (let i = ranges.length - 1; i >= 0; i--) {
          sel.removeAllRanges();
          sel.addRange(ranges[i]);
          document.execCommand('insertText', false, text);
        }
      } else {
        const value = textarea.value;
        let out = '';
        let last = 0;
        for (const m of matches) {
          out += value.substring(last, m.start) + text;
          last = m.end;
        }
        out += value.substring(last);
        const scrollTop = textarea.scrollTop;
        textarea.focus();
        textarea.select();
        insertInto(textarea, out);
        textarea.scrollTop = scrollTop;
      }
      anchor = 0;
      replaceInput.focus();
      refresh(false);
    }

    // ---------- Open / close ----------

    function selectedSeed() {
      if (isPreviewMode()) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && previewContent.contains(sel.anchorNode)) {
          return sel.toString();
        }
        return '';
      }
      return textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    }

    function setReplaceVisible(visible) {
      replaceRow.hidden = !visible;
      toggleReplaceBtn.setAttribute('aria-expanded', String(visible));
      toggleReplaceBtn.classList.toggle('expanded', visible);
    }

    function open(showReplace) {
      const seed = selectedSeed();
      anchor = 0;
      const toolbar = document.querySelector('.toolbar');
      bar.style.top = (toolbar ? toolbar.getBoundingClientRect().bottom : 0) + 4 + 'px';
      bar.hidden = false;
      isOpen = true;
      if (showReplace) {
        setReplaceVisible(true);
      }
      if (seed && !/[\r\n]/.test(seed)) {
        findInput.value = seed;
      }
      findInput.focus();
      findInput.select();
      refresh(true);
    }

    function close() {
      if (!isOpen) {
        return;
      }
      isOpen = false;
      bar.hidden = true;
      clearTimeout(refreshTimer);
      clearHighlights();
      if (isPreviewMode()) {
        previewContent.focus();
      } else {
        textarea.focus();
      }
    }

    // ---------- Wiring ----------

    findInput.addEventListener('input', () => {
      anchor = 0;
      refresh(true);
    });

    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && (e.target === findInput || e.target === replaceInput)) {
        e.preventDefault();
        if (e.target === replaceInput) {
          replaceCurrent();
        } else {
          step(e.shiftKey ? -1 : 1);
        }
      }
    });

    caseBtn.addEventListener('click', () => {
      caseSensitive = !caseSensitive;
      caseBtn.classList.toggle('active', caseSensitive);
      caseBtn.setAttribute('aria-pressed', String(caseSensitive));
      refresh(true);
      findInput.focus();
    });
    document.getElementById('find-prev').addEventListener('click', () => step(-1));
    document.getElementById('find-next').addEventListener('click', () => step(1));
    document.getElementById('find-close').addEventListener('click', close);
    document.getElementById('replace-one').addEventListener('click', replaceCurrent);
    document.getElementById('replace-all').addEventListener('click', replaceAll);
    toggleReplaceBtn.addEventListener('click', () => setReplaceVisible(replaceRow.hidden));
    document.getElementById('btn-find')?.addEventListener('click', () => open(false));

    // Only intercepted while the editor webview has focus, so VS Code's own
    // global Ctrl+F (workbench / other editors) is unaffected.
    document.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          open(false);
        } else if (mod && !e.altKey && !e.shiftKey && (e.key === 'h' || e.key === 'H')) {
          e.preventDefault();
          open(true);
        } else if (e.key === 'F3' && isOpen) {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      },
      true
    );

    // Esc closes the bar even when focus has moved back into the document
    // (bubble phase + defaultPrevented so the wikilink autocomplete, which
    // handles its own Esc, keeps priority).
    document.addEventListener('keydown', (e) => {
      if (isOpen && e.key === 'Escape' && !e.defaultPrevented) {
        close();
      }
    });

    // Keep results current as the document changes (typing, external edits,
    // grammar highlight spans) and when the view mode flips.
    new MutationObserver(scheduleRefresh).observe(previewContent, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    textarea.addEventListener('input', scheduleRefresh);
    new MutationObserver(() => {
      if (isOpen) {
        anchor = 0;
        refresh(false);
      }
    }).observe(editorContainer, { attributes: true, attributeFilter: ['class'] });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { findMatches };
  } else {
    global.findMatches = findMatches;
    global.initFindBar = initFindBar;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
