// @ts-check
(function () {
  // @ts-ignore - markdownit loaded globally from markdown-it.min.js
  const md = window.markdownit({
    html: true,
    linkify: true,
    typographer: true,
    breaks: true,
  });

  // GFM task-list checkboxes (`- [ ] text` / `- [x] text`), useful for e.g.
  // GitHub spec-kit tasks.md checklists. A core-ruler token pass rather than
  // markdown-it's own list-item handling: it needs no source-position
  // mapping (which preprocessWikilinks's placeholder-collapsed fenced blocks
  // would make unreliable), and toggling is handled entirely DOM-side and
  // round-tripped back through Turndown, same as every other WYSIWYG edit.
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline') continue;
      // Expected ancestry: list_item_open > paragraph_open > inline.
      if (i < 2 || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = tokens[i].children && tokens[i].children[0];
      if (!first || first.type !== 'text') continue;
      const match = first.content.match(/^\[( |x|X)\] /);
      if (!match) continue;
      const checked = match[1].toLowerCase() === 'x';
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      // No trailing space in the raw tag: the CSS margin-right on
      // input[type="checkbox"] (editor.css) supplies the visual gap in the
      // rendered preview. A literal space here would become a real DOM text
      // node right after the checkbox — Turndown's whitespace-collapse pass
      // deliberately preserves text immediately following a void element (so
      // intentional spacing around inline elements like <img> survives),
      // which combined with the taskCheckbox Turndown rule's own trailing
      // space in '[x] '/'[ ] ' would double up into "[x]  text".
      checkbox.content = '<input type="checkbox" class="task-checkbox"' + (checked ? ' checked=""' : '') + '>';
      tokens[i].children.unshift(checkbox);
      tokens[i - 2].attrJoin('class', 'task-list-item');
    }
  });

  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const textarea = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('markdown-input')
  );
  const previewContent = /** @type {HTMLDivElement} */ (
    document.getElementById('preview-content')
  );
  const editorContainer = /** @type {HTMLDivElement} */ (
    document.getElementById('editor-container')
  );
  const divider = /** @type {HTMLDivElement} */ (
    document.getElementById('divider')
  );
  const statusLineInfo = /** @type {HTMLSpanElement} */ (
    document.getElementById('status-line-info')
  );
  const statusWordCount = /** @type {HTMLSpanElement} */ (
    document.getElementById('status-word-count')
  );

  // Track whether the current content update originated from the extension host
  let isExternalUpdate = false;

  // True while an IME composition is in progress in the contenteditable
  // preview. Serializing/re-rendering mid-composition breaks the IME session
  // and teleports the caret, so all sync work is deferred to compositionend.
  let isComposing = false;

  // The markdown most recently posted to the extension host, plus whether a
  // debounced local edit is still waiting to be posted. Together these let the
  // update handler recognize late echoes and stale snapshots (see 'update').
  let lastSentEditText = null;
  let localEditPending = false;

  // Count of 'edit' messages posted to the host that haven't been
  // acknowledged (via 'editAck') yet. While > 0, an incoming 'update' may be
  // a stale snapshot racing an edit still in flight to the host — see
  // 'update' handling below.
  let editsInFlight = 0;

  // Stored frontmatter to preserve during contenteditable round-trips
  let currentFrontmatter = '';

  // Grammar check results for inline highlighting
  let currentGrammarMatches = [];
  let grammarTooltip = null;

  // ================================================
  // Turndown (HTML → Markdown) initialization
  // ================================================
  // @ts-ignore - TurndownService loaded globally from turndown.browser.umd.js
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  // Custom rule: preserve wikilinks
  turndownService.addRule('wikilink', {
    filter: function (node) {
      return node.nodeName === 'A' && node.classList.contains('wikilink');
    },
    replacement: function (content, node) {
      const target = node.getAttribute('data-target');
      if (content === target) {
        return '[[' + target + ']]';
      }
      return '[[' + target + '|' + content + ']]';
    },
  });

  // Custom rule: strip grammar error spans during conversion
  turndownService.addRule('grammarError', {
    filter: function (node) {
      return node.nodeName === 'SPAN' && node.classList.contains('grammar-error');
    },
    replacement: function (content) {
      return content;
    },
  });

  // Custom rule: serialize a task-list checkbox back to its `[ ]`/`[x]`
  // source syntax. Turndown drops unrecognized void elements by default, so
  // <input> needs an explicit rule; the existing `li` handling already
  // supplies the `- ` marker and indentation. Reads the `checked` attribute
  // (not the `.checked` DOM property) because Turndown serializes
  // previewContent.innerHTML as a string first — only attributes survive
  // that round trip — so the click handler below must keep the attribute in
  // sync whenever it toggles the box.
  turndownService.addRule('taskCheckbox', {
    filter: function (node) {
      return node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox';
    },
    replacement: function (_content, node) {
      return node.hasAttribute('checked') ? '[x] ' : '[ ] ';
    },
  });

  // Custom rule: serialize a rendered mermaid diagram block back to its
  // fenced source. The block is contenteditable="false" (atomic — the user
  // can't edit its contents, only delete the whole thing), so `content`
  // (Turndown's serialization of its children, i.e. the rendered SVG) is
  // never used; the original source is round-tripped verbatim from the
  // data attribute instead. Returned as a plain string (not built via
  // Turndown's escaping helpers) so the diagram source passes through
  // byte-for-byte, matching how the wikilink rule above handles its target.
  turndownService.addRule('mermaidBlock', {
    filter: function (node) {
      return node.nodeName === 'DIV' && node.classList.contains('mermaid-block');
    },
    replacement: function (_content, node) {
      const source = node.getAttribute('data-mermaid-source') || '';
      return '\n\n```mermaid\n' + source + '\n```\n\n';
    },
  });

  // GFM table rules (Turndown's core has no table support). Defined in the
  // shared media/turndownTableRules.js module so the same logic can be unit
  // tested. Loaded as a global by the preceding <script> tag.
  // @ts-ignore - installTurndownTableRules is a global from turndownTableRules.js
  installTurndownTableRules(turndownService);

  /** Check if the editor is in preview-only (WYSIWYG) mode */
  function isPreviewMode() {
    return editorContainer.classList.contains('preview-only');
  }

  /**
   * TreeWalker NodeFilter that skips (rejects, does not descend into) any
   * `.mermaid-block` subtree. A rendered diagram's SVG contains real text
   * nodes (its labels) that must never be treated as document prose — by
   * caret offset math, by grammar-match text search, or by anything else
   * that walks the preview's text content.
   */
  function rejectMermaidBlocks(node) {
    return node.nodeType === 1 && node.classList && node.classList.contains('mermaid-block')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT;
  }

  /**
   * Save caret position inside a contenteditable element as a block index
   * (which top-level child of `element` the caret is in) plus a character
   * offset within that block's own text. Anchoring within a single block —
   * rather than a single global character offset over the whole preview —
   * means content changes in *other* blocks (e.g. typographer/list-marker
   * normalization elsewhere, or an async render landing in another block)
   * can never shift this caret, and there is no ambiguity between "end of
   * block A" and "start of block B" collapsing onto the wrong block.
   * Returns null if the selection is not inside the element.
   */
  function saveCaretPosition(element) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!element.contains(range.startContainer)) return null;
    const start = locateInBlock(element, range.startContainer, range.startOffset);
    if (!start) return null;
    const end = locateInBlock(element, range.endContainer, range.endOffset) || start;
    return { start, end };
  }

  /**
   * Find which top-level child ("block") of `element` contains `container`,
   * and the character offset within that block's own text content.
   */
  function locateInBlock(element, container, containerOffset) {
    if (container === element) {
      // Selection anchored directly on the container (e.g. clicking into
      // empty space below the last block) — containerOffset is a child index.
      const blockIndex = Math.max(0, Math.min(containerOffset, element.childNodes.length - 1));
      return { blockIndex, offset: 0 };
    }
    let block = container;
    while (block.parentNode && block.parentNode !== element) {
      block = block.parentNode;
    }
    if (!block.parentNode) return null; // container isn't actually inside element
    const blockIndex = Array.prototype.indexOf.call(element.childNodes, block);
    if (blockIndex === -1) return null;
    if (block.nodeType === 1 && block.classList && block.classList.contains('mermaid-block')) {
      // Atomic (contenteditable="false") block rendered from a ```mermaid
      // fence — its SVG contains real text nodes (diagram labels) that must
      // never be counted as document prose. The caret can't land inside it
      // via user interaction, so treat it as zero-length. (A mermaid fence
      // nested inside a list item, rather than as its own top-level block,
      // isn't covered by this check — rare enough not to be worth the extra
      // subtree-exclusion bookkeeping; worst case is a one-render caret drift
      // in that block, corrected on the next unrelated edit.)
      return { blockIndex, offset: 0 };
    }
    const pre = document.createRange();
    pre.selectNodeContents(block);
    try {
      pre.setEnd(container, containerOffset);
    } catch (_) {
      return { blockIndex, offset: 0 };
    }
    return { blockIndex, offset: pre.toString().length };
  }

  /**
   * Restore a caret position (saved by saveCaretPosition) inside a contenteditable
   * element after its innerHTML has been replaced.
   */
  function restoreCaretPosition(element, saved) {
    if (!saved) return;
    try {
      const s = resolveBlockPosition(element, saved.start);
      if (!s) return;
      const e = saved.end ? resolveBlockPosition(element, saved.end) : s;
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd((e || s).node, (e || s).offset);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (_) {
      // Fail silently — better no restore than a crash
    }
  }

  /**
   * Resolve a { blockIndex, offset } bookmark to a concrete DOM node + offset.
   * The block index is clamped to the current child count (blocks may have
   * been added/removed elsewhere in the document). Within the block, walks
   * text nodes to find the saved offset, clamping to the block's end if it's
   * now shorter (e.g. markdown-it/typographer normalization removed a
   * character) and anchoring directly on the block element if it has no text
   * nodes at all (e.g. an empty `<p><br></p>` from pressing Enter — there is
   * no text node to walk to, but setStart(emptyBlock, 0) is a valid caret
   * position inside it).
   */
  function resolveBlockPosition(element, saved) {
    if (element.childNodes.length === 0) return null;
    const blockIndex = Math.min(saved.blockIndex, element.childNodes.length - 1);
    const block = element.childNodes[blockIndex];
    if (block.nodeType === Node.TEXT_NODE) {
      return { node: block, offset: Math.min(saved.offset, block.textContent.length) };
    }
    if (block.classList && block.classList.contains('mermaid-block')) {
      // contenteditable="false" — the caret can't land inside its rendered
      // SVG, so anchor immediately before it (a child-index position on
      // `element` itself) instead of walking into diagram label text.
      return { node: element, offset: blockIndex };
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, rejectMermaidBlocks);
    let acc = 0;
    let node;
    let last = null;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (saved.offset <= acc + len) {
        return { node, offset: saved.offset - acc };
      }
      acc += len;
      last = node;
    }
    if (!last) {
      return { node: block, offset: 0 };
    }
    return { node: last, offset: last.textContent.length };
  }

  /**
   * Get the caret character offset within a contenteditable element's text content.
   * Returns 0 if the selection is not inside the element.
   */
  function getCaretTextOffset(element) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!element.contains(range.startContainer)) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(element);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  // ================================================
  // Message handling from extension host
  // ================================================
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'update': {
        const text = message.text;
        // If the incoming text already matches the textarea, this update is the
        // echo of an edit we just made locally (the textarea is our source of
        // truth, updated synchronously on every keystroke). Re-rendering on an
        // echo would rebuild the preview DOM needlessly. Only re-render when the
        // text genuinely differs — i.e. a real external change (other editor,
        // git, grammar fix, etc.). This replaces the old isContentEditableUpdate
        // flag, which could get stuck and silently drop external updates.
        const isEcho = text === textarea.value || text === lastSentEditText;
        if (isEcho) {
          // Consume it — otherwise a later genuine external change that
          // happens to match this exact text (e.g. `git checkout` reverting
          // to precisely what was last typed) would be misclassified as
          // another echo and silently dropped instead of rendered.
          lastSentEditText = null;
        }
        if (!isEcho && (localEditPending || editsInFlight > 0)) {
          // A newer local edit is still debounce-pending, or already posted to
          // the host but not yet acknowledged. Rendering this older snapshot
          // would clobber the user's latest keystrokes and yank the caret. Skip
          // it — the pending/in-flight edit will replace the document
          // momentarily (last-writer-wins), and any genuine external change
          // will arrive again after that settles.
          updateStatusBar();
          break;
        }
        if (!isEcho) {
          // The matches we're holding were anchored against the previous
          // text; re-searching them against genuinely different content
          // (external edit, git, etc.) at their old offsets/matchedText
          // would highlight the wrong spots. Drop them — the host will
          // re-check and send fresh results after this change settles.
          currentGrammarMatches = [];
          isExternalUpdate = true;
          const selStart = textarea.selectionStart;
          const selEnd = textarea.selectionEnd;
          textarea.value = text;
          textarea.selectionStart = Math.min(selStart, text.length);
          textarea.selectionEnd = Math.min(selEnd, text.length);
          isExternalUpdate = false;
          renderPreview(text);
        }
        updateStatusBar();
        break;
      }
      case 'editAck': {
        editsInFlight = Math.max(0, editsInFlight - 1);
        break;
      }
      case 'wikilinkSuggestions': {
        if (linkPickerMode && linkPickerCallback) {
          // Show file picker overlay for Link button
          linkPickerMode = false;
          showLinkPicker(message.suggestions, linkPickerCallback);
          linkPickerCallback = null;
        } else if (autocomplete.triggerOffset >= 0) {
          autocomplete.show(message.suggestions);
        }
        break;
      }
      case 'grammarResults': {
        currentGrammarMatches = message.matches || [];
        // Reset the grammar button
        const gBtn = document.getElementById('btn-check-grammar');
        if (gBtn) {
          gBtn.textContent = '\u2713 Grammar';
          gBtn.disabled = false;
        }
        statusWordCount.textContent = currentGrammarMatches.length + ' grammar issue(s) found';
        // Refresh highlights in place. A full renderPreview() here rebuilt the
        // contenteditable's innerHTML — and because auto grammar checks land
        // asynchronously (often just as the user resumes typing), that rebuild
        // randomly moved the caret whenever the markdown→HTML round-trip wasn't
        // text-identical (smart quotes, `...`→…, a "- " line becoming a list).
        // Unwrapping and re-wrapping highlight spans never changes text content,
        // so the caret can be restored to the exact same offset.
        refreshGrammarHighlights();
        break;
      }
    }
  });

  // ================================================
  // User input handling
  // ================================================
  let debounceTimer;

  textarea.addEventListener('input', () => {
    if (isExternalUpdate) {
      return;
    }

    const text = textarea.value;
    renderPreview(text);
    updateStatusBar();

    localEditPending = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      localEditPending = false;
      lastSentEditText = text;
      editsInFlight++;
      vscode.postMessage({ type: 'edit', text: text, cursorOffset: textarea.selectionStart });
    }, 50);
  });

  // ================================================
  // Contenteditable (WYSIWYG) input handling
  // ================================================
  let contentEditableDebounce;

  function syncContentEditable() {
    // Convert HTML back to markdown via Turndown. Guard against Turndown
    // throwing on malformed DOM so a single bad keystroke can't wedge editing.
    let markdown;
    try {
      const bodyMarkdown = turndownService.turndown(previewContent.innerHTML);
      // Re-attach frontmatter that was stripped during rendering
      markdown = currentFrontmatter + bodyMarkdown;
    } catch (_) {
      return;
    }

    // Sync to textarea (source of truth)
    textarea.value = markdown;

    // Capture caret offset NOW (synchronously) before the async timeout fires.
    // This is an approximate offset into the markdown source: it is the caret's
    // offset within the rendered preview text (plus the stripped frontmatter
    // length). It is only used host-side to pick which paragraph to run the
    // incremental grammar check on, so an approximation is acceptable.
    // textarea.selectionStart can't be used — it's 0 while the textarea is unfocused.
    const previewCaretOffset = Math.min(
      getCaretTextOffset(previewContent) + currentFrontmatter.length,
      markdown.length
    );

    // Debounced send to extension host
    localEditPending = true;
    clearTimeout(contentEditableDebounce);
    contentEditableDebounce = setTimeout(() => {
      localEditPending = false;
      lastSentEditText = markdown;
      editsInFlight++;
      vscode.postMessage({ type: 'edit', text: markdown, cursorOffset: previewCaretOffset });
    }, 100);

    updateStatusBar();
  }

  previewContent.addEventListener('input', () => {
    if (isExternalUpdate || isComposing) return;
    syncContentEditable();
  });

  // IME composition: defer all markdown sync until the composition commits.
  previewContent.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  previewContent.addEventListener('compositionend', () => {
    isComposing = false;
    syncContentEditable();
    if (grammarRefreshPending) {
      grammarRefreshPending = false;
      refreshGrammarHighlights();
    }
  });

  // Handle Tab key - insert tab instead of moving focus
  textarea.addEventListener('keydown', (e) => {
    // When the wikilink autocomplete is open, let its own keydown handler own
    // Tab/Enter/arrows — otherwise both handlers fire and conflict (e.g. Tab
    // would insert a literal tab AND confirm the autocomplete selection).
    if (autocomplete.isOpen) {
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      insertAtCursor('\t');
    }
    // Shift+Tab - remove leading tab/spaces
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      removeLeadingIndent();
    }
    // Enter - auto-continue list items
    if (e.key === 'Enter') {
      const handled = handleAutoList(e);
      if (handled) {
        e.preventDefault();
      }
    }
  });

  // ================================================
  // Auto-continue list items on Enter
  // ================================================
  function handleAutoList(e) {
    const start = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, start);
    const lineStart = textBefore.lastIndexOf('\n') + 1;
    const currentLine = textBefore.substring(lineStart);

    // Unordered list: "- ", "* ", "+ "
    const ulMatch = currentLine.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ulMatch) {
      const [, indent, marker, content] = ulMatch;
      if (content.trim() === '') {
        // Empty list item - remove it
        textarea.selectionStart = lineStart;
        insertText('');
        return true;
      }
      insertAtCursor('\n' + indent + marker + ' ');
      return true;
    }

    // Ordered list: "1. ", "2. ", etc.
    const olMatch = currentLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const [, indent, num, content] = olMatch;
      if (content.trim() === '') {
        textarea.selectionStart = lineStart;
        insertText('');
        return true;
      }
      const nextNum = parseInt(num) + 1;
      insertAtCursor('\n' + indent + nextNum + '. ');
      return true;
    }

    // Blockquote: "> "
    const bqMatch = currentLine.match(/^(\s*>+\s+)(.*)$/);
    if (bqMatch) {
      const [, prefix, content] = bqMatch;
      if (content.trim() === '') {
        textarea.selectionStart = lineStart;
        insertText('');
        return true;
      }
      insertAtCursor('\n' + prefix);
      return true;
    }

    return false;
  }

  // ================================================
  // Toolbar button handlers
  // ================================================
  function wrapSelection(before, after) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    const text = selected || 'text';
    const replacement = before + text + (after !== undefined ? after : before);
    textarea.value =
      textarea.value.substring(0, start) +
      replacement +
      textarea.value.substring(end);
    textarea.selectionStart = start + before.length;
    textarea.selectionEnd = start + before.length + text.length;
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  function insertAtLineStart(prefix) {
    const start = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, start);
    const lineStart = textBefore.lastIndexOf('\n') + 1;
    textarea.value =
      textarea.value.substring(0, lineStart) +
      prefix +
      textarea.value.substring(lineStart);
    textarea.selectionStart = textarea.selectionEnd = start + prefix.length;
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  function insertAtCursor(text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value =
      textarea.value.substring(0, start) +
      text +
      textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  function insertText(text) {
    const start = textarea.selectionStart; // must be saved before value is replaced
    const end = textarea.selectionEnd;
    const lineEnd = textarea.value.indexOf('\n', end);
    const actualEnd = lineEnd === -1 ? textarea.value.length : lineEnd;
    textarea.value =
      textarea.value.substring(0, start) +
      text +
      textarea.value.substring(actualEnd);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  function removeLeadingIndent() {
    const start = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, start);
    const lineStart = textBefore.lastIndexOf('\n') + 1;
    const lineContent = textarea.value.substring(lineStart);
    if (lineContent.startsWith('\t')) {
      textarea.value = textarea.value.substring(0, lineStart) + lineContent.substring(1);
      textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 1);
    } else if (lineContent.startsWith('  ')) {
      textarea.value = textarea.value.substring(0, lineStart) + lineContent.substring(2);
      textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 2);
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  // Toolbar: Formatting (dispatches to contenteditable or textarea)
  document.getElementById('btn-bold')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('bold'); } else { wrapSelection('**', '**'); }
  });
  document.getElementById('btn-italic')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('italic'); } else { wrapSelection('*', '*'); }
  });
  document.getElementById('btn-strikethrough')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('strikethrough'); } else { wrapSelection('~~', '~~'); }
  });

  // Toolbar: Headings
  document.getElementById('btn-h1')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('formatBlock', false, 'h1'); } else { insertAtLineStart('# '); }
  });
  document.getElementById('btn-h2')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('formatBlock', false, 'h2'); } else { insertAtLineStart('## '); }
  });
  document.getElementById('btn-h3')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('formatBlock', false, 'h3'); } else { insertAtLineStart('### '); }
  });

  // Toolbar: Insert wikilink (Link button)
  let linkPickerMode = false; // Track if we're in link picker mode
  let linkPickerCallback = null; // Callback when a link is selected

  document.getElementById('btn-link')?.addEventListener('click', () => {
    // Request all wikilink suggestions (empty prefix = all files)
    linkPickerMode = true;
    linkPickerCallback = (stem) => {
      if (isPreviewMode()) {
        // Insert wikilink as HTML in contenteditable
        const wikilinkHtml = `<a class="wikilink" data-target="${escapeHtml(stem)}">${escapeHtml(stem)}</a>&nbsp;`;
        document.execCommand('insertHTML', false, wikilinkHtml);
        // Sync back to markdown
        const bodyMarkdown = turndownService.turndown(previewContent.innerHTML);
        const markdown = currentFrontmatter + bodyMarkdown;
        textarea.value = markdown;
        lastSentEditText = markdown;
        editsInFlight++;
        vscode.postMessage({ type: 'edit', text: markdown });
      } else {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const insertion = `[[${stem}]]`;
        textarea.value =
          textarea.value.substring(0, start) + insertion + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
        textarea.focus();
        textarea.dispatchEvent(new Event('input'));
      }
    };
    vscode.postMessage({ type: 'requestWikilinkSuggestions', prefix: '' });
  });

  document.getElementById('btn-image')?.addEventListener('click', () => {
    if (isPreviewMode()) {
      const url = prompt('Enter image URL:');
      if (url) { document.execCommand('insertImage', false, url); }
    } else {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.substring(start, end);
      const replacement = `![${selected || 'alt text'}](image-url)`;
      textarea.value =
        textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
      textarea.focus();
      textarea.dispatchEvent(new Event('input'));
    }
  });

  document.getElementById('btn-code')?.addEventListener('click', () => {
    if (isPreviewMode()) {
      // Wrap selection in <code> via insertHTML
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const text = sel.toString();
        document.execCommand('insertHTML', false, '<code>' + escapeHtml(text) + '</code>');
      }
    } else {
      wrapSelection('`', '`');
    }
  });

  document.getElementById('btn-codeblock')?.addEventListener('click', () => {
    if (isPreviewMode()) {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : 'code here';
      document.execCommand('insertHTML', false, '<pre><code>' + escapeHtml(text) + '</code></pre>');
    } else {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.substring(start, end);
      const replacement = '```\n' + (selected || 'code here') + '\n```';
      textarea.value =
        textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
      textarea.selectionStart = start + 4;
      textarea.selectionEnd = start + 4 + (selected || 'code here').length;
      textarea.focus();
      textarea.dispatchEvent(new Event('input'));
    }
  });

  // Toolbar: Lists & blocks
  document.getElementById('btn-ul')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('insertUnorderedList'); } else { insertAtLineStart('- '); }
  });
  document.getElementById('btn-ol')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('insertOrderedList'); } else { insertAtLineStart('1. '); }
  });
  document.getElementById('btn-quote')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('formatBlock', false, 'blockquote'); } else { insertAtLineStart('> '); }
  });
  document.getElementById('btn-hr')?.addEventListener('click', () => {
    if (isPreviewMode()) { document.execCommand('insertHorizontalRule'); } else { insertAtCursor('\n---\n'); }
  });

  // Toolbar: Grammar check
  const grammarBtn = document.getElementById('btn-check-grammar');
  if (grammarBtn) {
    grammarBtn.addEventListener('click', () => {
      grammarBtn.textContent = 'Checking...';
      grammarBtn.disabled = true;
      vscode.postMessage({ type: 'requestGrammarCheck' });
    });
  }

  // Toolbar: About (brand button)
  document.getElementById('btn-about')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'showAbout' });
  });

  // Toolbar: Print / Save as PDF — window.print() is suppressed inside VS
  // Code's sandboxed webview (no allow-modals), so the host opens a
  // standalone page in the real browser instead (see mermaidEditor.js's
  // identical Print button for the same reason).
  document.getElementById('btn-print')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'print', html: previewContent.innerHTML });
  });

  // ================================================
  // View toggle
  // ================================================
  function setActiveToggle(activeId) {
    ['btn-split', 'btn-editor-only', 'btn-preview-only'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('active', id === activeId);
      }
    });
  }

  document.getElementById('btn-split')?.addEventListener('click', () => {
    editorContainer.className = 'editor-container';
    setActiveToggle('btn-split');
    renderPreview(textarea.value);
  });
  document.getElementById('btn-editor-only')?.addEventListener('click', () => {
    editorContainer.className = 'editor-container editor-only';
    setActiveToggle('btn-editor-only');
  });
  document.getElementById('btn-preview-only')?.addEventListener('click', () => {
    editorContainer.className = 'editor-container preview-only';
    setActiveToggle('btn-preview-only');
    renderPreview(textarea.value);
    previewContent.focus();
  });

  // ================================================
  // Draggable divider for pane resizing
  // ================================================
  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    divider.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = editorContainer.getBoundingClientRect();
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    if (!editorPane || !previewPane) return;

    const offset = e.clientX - containerRect.left;
    const percentage = Math.max(20, Math.min(80, (offset / containerRect.width) * 100));

    editorPane.style.flex = 'none';
    editorPane.style.width = percentage + '%';
    previewPane.style.flex = 'none';
    previewPane.style.width = (100 - percentage) + '%';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('dragging');
    }
  });

  // ================================================
  // Scroll synchronization (batched to avoid layout thrashing)
  // ================================================
  let scrollRafId = 0;
  textarea.addEventListener('scroll', () => {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0;
      const previewParent = previewContent.parentElement;
      if (!previewParent) return;
      const scrollRatio =
        textarea.scrollTop / Math.max(1, textarea.scrollHeight - textarea.clientHeight);
      previewParent.scrollTop =
        scrollRatio * (previewParent.scrollHeight - previewParent.clientHeight);
    });
  });

  // ================================================
  // Wikilink Autocomplete
  // ================================================
  const autocomplete = (() => {
    let isOpen = false;
    let suggestions = [];
    let filteredSuggestions = [];
    let selectedIndex = 0;
    let triggerOffset = -1; // Position of [[ in the textarea

    // Create the overlay element
    const overlay = document.createElement('div');
    overlay.id = 'wikilink-autocomplete';
    overlay.className = 'autocomplete-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);

    // Event delegation: single handler for all autocomplete item clicks
    overlay.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (item) {
        e.preventDefault();
        const idx = parseInt(item.getAttribute('data-index'));
        selectedIndex = idx;
        confirm();
      }
    });

    function show(items) {
      suggestions = items;
      filteredSuggestions = items;
      selectedIndex = 0;
      isOpen = true;
      render();
      positionOverlay();
      overlay.style.display = 'block';
    }

    function hide() {
      isOpen = false;
      suggestions = [];
      filteredSuggestions = [];
      triggerOffset = -1;
      overlay.style.display = 'none';
    }

    function filter(prefix) {
      const lower = prefix.toLowerCase();
      filteredSuggestions = suggestions.filter(s =>
        s.stem.toLowerCase().includes(lower)
      );
      selectedIndex = Math.min(selectedIndex, Math.max(0, filteredSuggestions.length - 1));
      render();
    }

    function render() {
      if (filteredSuggestions.length === 0) {
        overlay.innerHTML = '<div class="autocomplete-empty">No matches</div>';
        return;
      }
      overlay.innerHTML = filteredSuggestions.map((s, i) =>
        `<div class="autocomplete-item${i === selectedIndex ? ' selected' : ''}" data-index="${i}">` +
        `<span class="autocomplete-stem">${escapeHtml(s.stem)}</span>` +
        (s.folder ? `<span class="autocomplete-folder">${escapeHtml(s.folder)}</span>` : '') +
        `</div>`
      ).join('');
    }

    function confirm() {
      if (filteredSuggestions.length === 0 || triggerOffset < 0) {
        hide();
        return;
      }
      const item = filteredSuggestions[selectedIndex];
      const cursorPos = textarea.selectionStart;
      const before = textarea.value.substring(0, triggerOffset);
      const after = textarea.value.substring(cursorPos);
      const insertion = '[[' + item.stem + ']]';
      textarea.value = before + insertion + after;
      textarea.selectionStart = textarea.selectionEnd = triggerOffset + insertion.length;
      textarea.focus();
      hide();
      textarea.dispatchEvent(new Event('input'));
    }

    function moveSelection(delta) {
      if (filteredSuggestions.length === 0) return;
      selectedIndex = (selectedIndex + delta + filteredSuggestions.length) % filteredSuggestions.length;
      render();
      // Scroll selected item into view
      const selectedEl = overlay.querySelector('.autocomplete-item.selected');
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }

    function positionOverlay() {
      // Approximate position based on cursor line/column
      const textBefore = textarea.value.substring(0, textarea.selectionStart);
      const lines = textBefore.split('\n');
      const lineNum = lines.length - 1;
      const colNum = lines[lines.length - 1].length;

      const taRect = textarea.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
      const paddingTop = parseFloat(style.paddingTop) || 16;
      const paddingLeft = parseFloat(style.paddingLeft) || 16;
      const charWidth = parseFloat(style.fontSize) * 0.6; // Approximate monospace char width

      let top = taRect.top + paddingTop + (lineNum * lineHeight) - textarea.scrollTop + lineHeight;
      let left = taRect.left + paddingLeft + (colNum * charWidth);

      // Clamp to viewport
      const viewW = document.documentElement.clientWidth;
      const viewH = document.documentElement.clientHeight;
      if (left + 250 > viewW) left = viewW - 260;
      if (top + 200 > viewH) top = top - lineHeight - 200;

      overlay.style.top = top + 'px';
      overlay.style.left = left + 'px';
    }

    return {
      get isOpen() { return isOpen; },
      show,
      hide,
      filter,
      confirm,
      moveSelection,
      get triggerOffset() { return triggerOffset; },
      set triggerOffset(v) { triggerOffset = v; },
    };
  })();

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Link picker overlay (reuses autocomplete styling)
  function showLinkPicker(suggestions, onSelect) {
    const existing = document.getElementById('link-picker-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'link-picker-overlay';
    overlay.className = 'autocomplete-overlay';

    // Add search input
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search files...';
    searchInput.className = 'link-picker-search';
    overlay.appendChild(searchInput);

    const list = document.createElement('div');
    list.className = 'link-picker-list';
    overlay.appendChild(list);

    let filtered = suggestions;
    let selectedIndex = 0;

    function render() {
      if (filtered.length === 0) {
        list.innerHTML = '<div class="autocomplete-empty">No matches</div>';
        return;
      }
      list.innerHTML = filtered.map((s, i) =>
        `<div class="autocomplete-item${i === selectedIndex ? ' selected' : ''}" data-index="${i}">` +
        `<span class="autocomplete-stem">${escapeHtml(s.stem)}</span>` +
        (s.folder ? `<span class="autocomplete-folder">${escapeHtml(s.folder)}</span>` : '') +
        `</div>`
      ).join('');
    }

    function confirm() {
      if (filtered.length > 0) {
        onSelect(filtered[selectedIndex].stem);
      }
      overlay.remove();
      document.removeEventListener('click', outsideClick);
    }

    function outsideClick(e) {
      if (!overlay.contains(e.target) && e.target.id !== 'btn-link') {
        overlay.remove();
        document.removeEventListener('click', outsideClick);
      }
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      filtered = suggestions.filter(s => s.stem.toLowerCase().includes(q));
      selectedIndex = 0;
      render();
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('click', outsideClick);
      }
    });

    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (item) {
        e.preventDefault();
        selectedIndex = parseInt(item.dataset.index);
        confirm();
      }
    });

    // Position below the Link button
    const btn = document.getElementById('btn-link');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      overlay.style.top = (rect.bottom + 4) + 'px';
      overlay.style.left = rect.left + 'px';
    }

    render();
    document.body.appendChild(overlay);
    searchInput.focus();

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', outsideClick);
    }, 100);
  }

  // Detect [[ trigger on input
  textarea.addEventListener('input', () => {
    if (isExternalUpdate) return;
    detectWikilinkTrigger();
  });

  function detectWikilinkTrigger() {
    const cursorPos = textarea.selectionStart;
    const textBefore = textarea.value.substring(0, cursorPos);

    // Look for [[ before cursor that hasn't been closed with ]]
    const triggerMatch = textBefore.match(/\[\[([^\]]*?)$/);
    if (triggerMatch) {
      const prefix = triggerMatch[1];
      const offset = cursorPos - triggerMatch[0].length;

      if (autocomplete.isOpen) {
        // Already open - just filter
        autocomplete.filter(prefix);
      } else {
        // New trigger - request suggestions
        autocomplete.triggerOffset = offset;
        vscode.postMessage({ type: 'requestWikilinkSuggestions', prefix: prefix });
      }
    } else if (autocomplete.isOpen) {
      autocomplete.hide();
    }
  }

  // Keyboard handling for autocomplete
  textarea.addEventListener('keydown', (e) => {
    if (!autocomplete.isOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocomplete.moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocomplete.moveSelection(-1);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      autocomplete.confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      autocomplete.hide();
    }
  });

  // ================================================
  // Preview rendering (with wikilink support)
  // ================================================
  function preprocessWikilinks(text) {
    // Replace [[target|display]] and [[target]] with clickable links
    // Skip those inside code blocks
    const codeBlockPlaceholders = [];
    let idx = 0;

    // Temporarily replace fenced code blocks
    let processed = text.replace(/```[\s\S]*?```/g, (match) => {
      const placeholder = '\x00CODE' + idx + '\x00';
      codeBlockPlaceholders.push({ placeholder, original: match });
      idx++;
      return placeholder;
    });

    // Temporarily replace inline code
    processed = processed.replace(/`[^`\n]+`/g, (match) => {
      const placeholder = '\x00CODE' + idx + '\x00';
      codeBlockPlaceholders.push({ placeholder, original: match });
      idx++;
      return placeholder;
    });

    // Replace wikilinks
    processed = processed.replace(/\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (match, target, display) => {
      const label = display || target;
      return '<a class="wikilink" data-target="' + escapeHtml(target.trim()) + '">' + escapeHtml(label.trim()) + '</a>';
    });

    // Restore code blocks. Passed as a replacer function, not a string — a
    // string replacement interprets $&/$`/$'/$$/$1 as special patterns, so a
    // code block containing e.g. a shell `$(...)` or regex backreference
    // would silently corrupt neighboring text.
    for (const { placeholder, original } of codeBlockPlaceholders) {
      processed = processed.replace(placeholder, () => original);
    }

    return processed;
  }

  /**
   * Strip YAML frontmatter (---...---) from the beginning of the text.
   * Stores the frontmatter so it can be re-attached during contenteditable sync.
   * Returns the text without frontmatter for rendering.
   */
  function stripFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (match) {
      currentFrontmatter = match[0];
      return text.slice(match[0].length);
    }
    currentFrontmatter = '';
    return text;
  }

  // Attributes that can carry a navigable/executable URI and so need scheme
  // checking, beyond the on* handler-attribute check below.
  const URI_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'poster']);
  const DANGEROUS_SCHEMES = ['javascript:', 'vbscript:', 'data:text/html'];

  /**
   * Strip ASCII control/whitespace characters (code points 0-32, e.g. tab,
   * newline) from a string. Browsers strip these from URL schemes before
   * matching — "java(tab)script:" still navigates — so a scheme check must
   * too, or it can be bypassed by embedding one inside the scheme name.
   */
  function stripControlChars(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 32) out += str[i];
    }
    return out;
  }

  /** Sanitize HTML output — strip script tags, event handlers, and dangerous elements */
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Remove dangerous elements. <base> is included because it can silently
    // redirect every relative URL/attribute on the page.
    for (const el of doc.querySelectorAll('script, iframe, object, embed, form, meta, link[rel="import"], base')) {
      el.remove();
    }
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (URI_ATTRS.has(attr.name.toLowerCase())) {
          const normalized = stripControlChars(attr.value).toLowerCase();
          if (DANGEROUS_SCHEMES.some((scheme) => normalized.startsWith(scheme))) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }
    return doc.body.innerHTML;
  }

  // ================================================
  // Mermaid diagram rendering (read-only in the WYSIWYG/split preview —
  // editing a diagram means switching to Raw/Split and editing its fenced
  // source directly; the rendered block itself is contenteditable="false").
  // ================================================
  let mermaidReady = false;
  // Rendered SVG cache keyed by a hash of the diagram source. Lets an
  // unrelated re-render (grammar-fix push, external update, view toggle)
  // reuse a diagram's SVG synchronously instead of re-invoking mermaid.
  const mermaidSvgCache = new Map();
  let mermaidRenderSeq = 0;

  function ensureMermaid() {
    if (mermaidReady) return true;
    // @ts-ignore - mermaid loaded globally from mermaid.min.js
    if (typeof mermaid === 'undefined') return false;
    // @ts-ignore
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
    });
    mermaidReady = true;
    return true;
  }

  /** Cheap non-cryptographic string hash (djb2), used only as a cache key. */
  function hashSource(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * Replace markdown-it's rendered ```mermaid fences (`<pre><code
   * class="language-mermaid">`) with atomic, contenteditable="false" blocks
   * that hold the diagram source in a data attribute (for the Turndown
   * round-trip) and either a cached SVG (synchronous) or a placeholder that
   * fills in once mermaid.render() resolves (async — mermaid has no sync
   * render API).
   */
  function upgradeMermaidBlocks(root) {
    const codeBlocks = root.querySelectorAll('pre > code.language-mermaid');
    if (codeBlocks.length === 0) return;
    for (const code of codeBlocks) {
      const pre = code.parentElement;
      // markdown-it appends a trailing newline to fence content.
      const source = code.textContent.replace(/\n$/, '');
      const div = document.createElement('div');
      div.className = 'mermaid-block';
      div.setAttribute('contenteditable', 'false');
      div.setAttribute('data-mermaid-source', source);
      pre.replaceWith(div);

      const cached = mermaidSvgCache.get(hashSource(source));
      if (cached) {
        div.innerHTML = cached;
        continue;
      }
      div.innerHTML = '<div class="mermaid-pending">Rendering diagram…</div>';
      renderMermaidInto(div, source);
    }
  }

  async function renderMermaidInto(div, source) {
    if (!ensureMermaid()) {
      div.innerHTML = '<div class="mermaid-error">Mermaid failed to load</div>';
      return;
    }
    const key = hashSource(source);
    const diagramId = 'mmd-diagram-' + (++mermaidRenderSeq);
    try {
      // @ts-ignore - mermaid global
      const { svg } = await mermaid.render(diagramId, source);
      mermaidSvgCache.set(key, svg);
      // The block may have been removed (re-render elsewhere) or reassigned
      // to a different diagram (fast typing in split mode) while awaiting.
      if (div.isConnected && div.getAttribute('data-mermaid-source') === source) {
        div.innerHTML = svg;
      }
      if (mermaidSvgCache.size > 100) {
        // Sources churn while editing raw mermaid in split mode — bound
        // memory rather than caching every keystroke's variant forever.
        mermaidSvgCache.delete(mermaidSvgCache.keys().next().value);
      }
    } catch (err) {
      // mermaid can leave a scratch element behind under the diagram's id on
      // a failed parse/render.
      document.getElementById('d' + diagramId)?.remove();
      if (!div.isConnected || div.getAttribute('data-mermaid-source') !== source) return;
      if (div.querySelector('svg')) {
        // Keep the last good render visible rather than replacing it with an
        // error while the user is still mid-edit of the diagram source.
        div.classList.add('mermaid-stale');
      } else {
        div.innerHTML = '<div class="mermaid-error">Invalid diagram: ' +
          escapeHtml(String((err && err.message) || err)) + '</div>';
      }
    }
  }

  function renderPreview(text) {
    // Save caret before rebuilding the DOM so it can be restored afterward.
    const savedCaret = isPreviewMode() ? saveCaretPosition(previewContent) : null;

    const withoutFrontmatter = stripFrontmatter(text);
    const processed = preprocessWikilinks(withoutFrontmatter);
    const rendered = md.render(processed);

    previewContent.innerHTML = sanitizeHtml(rendered);
    // Must run before caret restore below: it replaces DOM nodes (mermaid
    // fences -> atomic blocks), and the block-anchored caret bookmark is
    // resolved against child *indices*, which upgradeMermaidBlocks does not
    // change (replaceWith keeps the same position) but a later swap would.
    upgradeMermaidBlocks(previewContent);
    applyGrammarHighlights();

    if (savedCaret) {
      restoreCaretPosition(previewContent, savedCaret);
    }
  }

  // ================================================
  // Grammar highlight rendering
  // ================================================
  /** True if the text node is already inside a grammar-error highlight span. */
  function isInsideHighlight(node) {
    let el = node.parentElement;
    while (el && el !== previewContent) {
      if (el.classList && el.classList.contains('grammar-error')) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /** Count non-overlapping occurrences of `needle` in `haystack` before `beforeIndex`. */
  function countOccurrencesBefore(haystack, needle, beforeIndex) {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1 && idx < beforeIndex) {
      count++;
      idx = haystack.indexOf(needle, idx + 1);
    }
    return count;
  }

  function applyGrammarHighlights() {
    if (currentGrammarMatches.length === 0) return;

    // Build a plain text representation of the preview with offset mapping
    // to locate grammar errors in the rendered DOM. Diagram label text
    // inside mermaid blocks is excluded — it isn't document prose.
    const walker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT, rejectMermaidBlocks);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    // For each grammar match, try to find its text in the preview
    for (let mi = 0; mi < currentGrammarMatches.length; mi++) {
      const match = currentGrammarMatches[mi];
      const searchText = match.matchedText;
      if (!searchText) continue;

      // The matched text can repeat elsewhere in the document. Use the
      // match's offset in the markdown source to work out which occurrence
      // it actually refers to, rather than always grabbing the first
      // not-yet-highlighted one — otherwise the wavy underline can land on a
      // different occurrence than the one a clicked suggestion fixes.
      const targetOccurrence = countOccurrencesBefore(textarea.value, searchText, match.originalOffset);

      // Search through text nodes for the matched text
      let occurrence = 0;
      let found = false;
      for (let ni = 0; ni < textNodes.length && !found; ni++) {
        const textNode = textNodes[ni];
        // Skip text already wrapped in a highlight so repeated phrases advance
        // to the next un-highlighted occurrence rather than re-marking the first.
        if (isInsideHighlight(textNode)) continue;
        const content = textNode.textContent;
        let idx = content.indexOf(searchText);
        while (idx !== -1 && occurrence < targetOccurrence) {
          occurrence++;
          idx = content.indexOf(searchText, idx + 1);
        }
        if (idx === -1) continue;

        // Split the text node and wrap the match in a span
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + searchText.length);

        const span = document.createElement('span');
        span.className = 'grammar-error severity-' + match.severity;
        span.dataset.matchIndex = String(mi);
        span.title = match.message;

        // surroundContents throws if the range crosses element boundaries; the
        // range here is within a single text node, but guard so a single bad
        // match can't abort the whole highlight pass (and thus the render).
        try {
          range.surroundContents(span);
        } catch (_) {
          continue;
        }
        found = true;

        // Update textNodes since we split the node
        const newWalker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT, rejectMermaidBlocks);
        textNodes.length = 0;
        let n;
        while ((n = newWalker.nextNode())) {
          textNodes.push(n);
        }
      }
    }
  }

  /** Unwrap all existing grammar-error spans, leaving text content untouched. */
  function clearGrammarHighlights() {
    for (const span of previewContent.querySelectorAll('span.grammar-error')) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      parent.removeChild(span);
    }
    // Merge the text nodes the unwrapping left behind so highlight matching
    // (which searches within single text nodes) sees contiguous text again.
    previewContent.normalize();
  }

  // True while a refreshGrammarHighlights() call was deferred because an IME
  // composition was in progress; replayed once the composition commits.
  let grammarRefreshPending = false;

  /**
   * Re-apply grammar highlights to the live DOM without re-rendering markdown.
   * Wrapping/unwrapping spans never changes the element's text content, so the
   * caret offset round-trips exactly — no cursor movement, unlike a full
   * renderPreview() which rebuilds innerHTML from (possibly normalized) markdown.
   */
  function refreshGrammarHighlights() {
    if (isComposing) {
      // Unwrapping/rewrapping spans calls normalize() and surroundContents(),
      // which mutate text nodes out from under an in-progress IME composition
      // and would corrupt it (and teleport the caret). Defer to compositionend.
      grammarRefreshPending = true;
      return;
    }
    if (currentGrammarMatches.length === 0 && !previewContent.querySelector('span.grammar-error')) {
      // Nothing to add and nothing to clear. This is the common case — most
      // incremental checks come back clean — and previously still paid for a
      // full caret save/restore cycle on every one of them while the user types.
      return;
    }
    const savedCaret = isPreviewMode() ? saveCaretPosition(previewContent) : null;
    hideGrammarTooltip();
    clearGrammarHighlights();
    applyGrammarHighlights();
    if (savedCaret) {
      restoreCaretPosition(previewContent, savedCaret);
    }
  }

  function showGrammarTooltip(span, match) {
    hideGrammarTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'grammar-tooltip';

    const msg = document.createElement('div');
    msg.className = 'grammar-tooltip-message';
    msg.textContent = match.message;
    tooltip.appendChild(msg);

    if (match.replacements && match.replacements.length > 0) {
      const sugBox = document.createElement('div');
      sugBox.className = 'grammar-tooltip-suggestions';
      for (const replacement of match.replacements.slice(0, 5)) {
        const btn = document.createElement('button');
        btn.className = 'grammar-suggestion';
        btn.textContent = replacement;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Apply the fix in the DOM immediately, rather than relying solely
          // on the host round trip (host applies the edit and pushes an
          // 'update' back). If a different local edit is already in flight
          // when that push arrives, the 'update' handler correctly treats it
          // as a possibly-stale snapshot and skips it — silently dropping
          // this fix. Doing it here means it's already part of whatever the
          // next sync (below) sends, regardless of that race.
          if (isPreviewMode() && span.isConnected) {
            const parent = span.parentNode;
            if (parent) {
              parent.replaceChild(document.createTextNode(replacement), span);
              parent.normalize();
              syncContentEditable();
            }
          }
          // Still tell the host: it verifies the offsets against its own
          // document.getText() (a safety net independent of the DOM-based
          // fix above) and keeps its diagnostics collection in sync.
          vscode.postMessage({
            type: 'applyGrammarFix',
            offset: match.originalOffset,
            length: match.originalLength,
            replacement: replacement,
            // Lets the host verify the offsets still point at this text —
            // edits since the check shift offsets and would corrupt the doc.
            expectedText: match.matchedText,
          });
          hideGrammarTooltip();
        });
        sugBox.appendChild(btn);
      }
      tooltip.appendChild(sugBox);
    }

    document.body.appendChild(tooltip);
    grammarTooltip = tooltip;

    // Position below the error span
    const rect = span.getBoundingClientRect();
    tooltip.style.top = (rect.bottom + 4) + 'px';
    tooltip.style.left = rect.left + 'px';

    // Clamp to viewport
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth;
    if (tooltipRect.right > viewW) {
      tooltip.style.left = (viewW - tooltipRect.width - 8) + 'px';
    }
  }

  function hideGrammarTooltip() {
    if (grammarTooltip) {
      grammarTooltip.remove();
      grammarTooltip = null;
    }
  }

  // Hover and click handlers for grammar errors (event delegation on preview)
  previewContent.addEventListener('mouseover', (e) => {
    const span = e.target.closest('.grammar-error');
    if (span) {
      const idx = parseInt(span.dataset.matchIndex);
      const match = currentGrammarMatches[idx];
      if (match) {
        showGrammarTooltip(span, match);
      }
    }
  });

  previewContent.addEventListener('mouseout', (e) => {
    const span = e.target.closest('.grammar-error');
    if (span) {
      // Delay hiding so user can move to tooltip
      setTimeout(() => {
        if (grammarTooltip && !grammarTooltip.matches(':hover')) {
          hideGrammarTooltip();
        }
      }, 200);
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (grammarTooltip && !grammarTooltip.contains(e.target) && !e.target.closest('.grammar-error')) {
      hideGrammarTooltip();
    }
  });

  // Task-list checkbox click handler in preview. Checkboxes inside a
  // contenteditable region aren't reliably interactive by default in
  // Chromium (a click there tends to just move the caret) — handle toggling
  // explicitly instead of relying on native <input> behavior.
  previewContent.addEventListener('click', (e) => {
    const checkbox = e.target.closest && e.target.closest('input.task-checkbox');
    if (!checkbox) return;
    e.preventDefault();
    const nowChecked = !checkbox.hasAttribute('checked');
    if (nowChecked) {
      checkbox.setAttribute('checked', '');
    } else {
      checkbox.removeAttribute('checked');
    }
    checkbox.checked = nowChecked; // keep the visual box in sync with the attribute
    syncContentEditable(); // a click doesn't fire 'input' — sync manually
  });

  // Wikilink click handler in preview
  // In contenteditable (preview) mode: Ctrl+Click to navigate, plain click places cursor
  // In non-editable mode: any click navigates
  previewContent.addEventListener('click', (e) => {
    const link = e.target.closest('.wikilink');
    if (link) {
      if (isPreviewMode() && !e.ctrlKey && !e.metaKey) {
        // Plain click in contenteditable mode — let the cursor land naturally
        return;
      }
      e.preventDefault();
      vscode.postMessage({ type: 'openWikilink', target: link.dataset.target });
    }
  });

  // ================================================
  // Status bar
  // ================================================
  function updateStatusBar() {
    if (isPreviewMode()) {
      // In preview mode, get word count from preview content
      statusLineInfo.textContent = 'Edit';
      const text = (previewContent.textContent || '').trim();
      const words = text === '' ? 0 : text.split(/\s+/).length;
      statusWordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
    } else {
      // Line and column from textarea
      const pos = textarea.selectionStart;
      const textBefore = textarea.value.substring(0, pos);
      const lines = textBefore.split('\n');
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      statusLineInfo.textContent = `Ln ${line}, Col ${col}`;

      // Word count
      const text = textarea.value.trim();
      const words = text === '' ? 0 : text.split(/\s+/).length;
      statusWordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
    }
  }

  textarea.addEventListener('click', updateStatusBar);
  textarea.addEventListener('keyup', updateStatusBar);
  previewContent.addEventListener('click', updateStatusBar);
  previewContent.addEventListener('keyup', updateStatusBar);

  // ================================================
  // Keyboard shortcuts
  // ================================================
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      wrapSelection('**', '**');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      wrapSelection('*', '*');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('btn-link')?.click();
    }
  });

  // Keyboard shortcuts for contenteditable preview mode
  previewContent.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      document.execCommand('bold');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      document.execCommand('italic');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const url = prompt('Enter URL:');
      if (url) { document.execCommand('createLink', false, url); }
    }
  });

  // ================================================
  // Signal ready
  // ================================================
  vscode.postMessage({ type: 'ready' });
})();
