// @ts-check
(function () {
  // @ts-ignore - markdownit loaded globally from markdown-it.min.js
  const md = window.markdownit({
    html: true,
    linkify: true,
    typographer: true,
    breaks: true,
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

  // Track whether the current update originated from contenteditable input
  let isContentEditableUpdate = false;

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

  /** Check if the editor is in preview-only (WYSIWYG) mode */
  function isPreviewMode() {
    return editorContainer.classList.contains('preview-only');
  }

  // ================================================
  // Message handling from extension host
  // ================================================
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'update': {
        const text = message.text;
        if (textarea.value !== text) {
          isExternalUpdate = true;
          const selStart = textarea.selectionStart;
          const selEnd = textarea.selectionEnd;
          textarea.value = text;
          textarea.selectionStart = Math.min(selStart, text.length);
          textarea.selectionEnd = Math.min(selEnd, text.length);
          isExternalUpdate = false;
        }
        // Don't re-render preview if change came from contenteditable
        if (!isContentEditableUpdate) {
          renderPreview(text);
        }
        updateStatusBar();
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
        console.log('[Webview] Received grammarResults:', currentGrammarMatches.length, 'matches');
        if (currentGrammarMatches.length > 0) {
          console.log('[Webview] First match:', currentGrammarMatches[0].matchedText, 'at offset', currentGrammarMatches[0].originalOffset);
        }
        // Reset the grammar button
        const gBtn = document.getElementById('btn-check-grammar');
        if (gBtn) {
          gBtn.textContent = '\u2713 Grammar';
          gBtn.disabled = false;
        }
        statusWordCount.textContent = currentGrammarMatches.length + ' grammar issue(s) found';
        // Re-render preview to apply highlights
        renderPreview(textarea.value);
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

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'edit', text: text, cursorOffset: textarea.selectionStart });
    }, 50);
  });

  // ================================================
  // Contenteditable (WYSIWYG) input handling
  // ================================================
  let contentEditableDebounce;

  previewContent.addEventListener('input', () => {
    if (isExternalUpdate) return;

    isContentEditableUpdate = true;

    // Convert HTML back to markdown via Turndown
    const bodyMarkdown = turndownService.turndown(previewContent.innerHTML);

    // Re-attach frontmatter that was stripped during rendering
    const markdown = currentFrontmatter + bodyMarkdown;

    // Sync to textarea (source of truth)
    textarea.value = markdown;

    // Debounced send to extension host
    clearTimeout(contentEditableDebounce);
    contentEditableDebounce = setTimeout(() => {
      // Estimate cursor offset from the markdown text length up to current position
      const cursorOffset = markdown.length > 0 ? Math.min(textarea.selectionStart || 0, markdown.length) : 0;
      vscode.postMessage({ type: 'edit', text: markdown, cursorOffset });
      isContentEditableUpdate = false;
    }, 100);

    updateStatusBar();
  });

  // Handle Tab key - insert tab instead of moving focus
  textarea.addEventListener('keydown', (e) => {
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
    const end = textarea.selectionEnd;
    const lineEnd = textarea.value.indexOf('\n', end);
    const actualEnd = lineEnd === -1 ? textarea.value.length : lineEnd;
    textarea.value =
      textarea.value.substring(0, textarea.selectionStart) +
      text +
      textarea.value.substring(actualEnd);
    textarea.selectionStart = textarea.selectionEnd = textarea.selectionStart + text.length;
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
        const wikilinkHtml = `<a class="wikilink" data-target="${stem}">${stem}</a>&nbsp;`;
        document.execCommand('insertHTML', false, wikilinkHtml);
        // Sync back to markdown
        const bodyMarkdown = turndownService.turndown(previewContent.innerHTML);
        const markdown = currentFrontmatter + bodyMarkdown;
        textarea.value = markdown;
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

    // Restore code blocks
    for (const { placeholder, original } of codeBlockPlaceholders) {
      processed = processed.replace(placeholder, original);
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

  function renderPreview(text) {
    const withoutFrontmatter = stripFrontmatter(text);
    const processed = preprocessWikilinks(withoutFrontmatter);
    const rendered = md.render(processed);

    // Debug: check if wikilinks are being processed correctly
    if (processed.includes('class="wikilink"')) {
      const preserved = rendered.includes('class="wikilink"');
      const escaped = rendered.includes('&lt;a');
      console.log('[Editor] Wikilink debug — preserved:', preserved, 'escaped:', escaped,
        'html option:', md.options?.html);
    }

    previewContent.innerHTML = rendered;
    applyGrammarHighlights();
  }

  // ================================================
  // Grammar highlight rendering
  // ================================================
  function applyGrammarHighlights() {
    if (currentGrammarMatches.length === 0) return;

    console.log('[Webview] Applying grammar highlights for', currentGrammarMatches.length, 'matches');

    // Build a plain text representation of the preview with offset mapping
    // to locate grammar errors in the rendered DOM
    const walker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    console.log('[Webview] Found', textNodes.length, 'text nodes in preview');

    let highlightCount = 0;

    // For each grammar match, try to find its text in the preview
    for (let mi = 0; mi < currentGrammarMatches.length; mi++) {
      const match = currentGrammarMatches[mi];
      const searchText = match.matchedText;
      if (!searchText) continue;

      // Search through text nodes for the matched text
      let found = false;
      for (let ni = 0; ni < textNodes.length && !found; ni++) {
        const textNode = textNodes[ni];
        const content = textNode.textContent;
        const idx = content.indexOf(searchText);
        if (idx === -1) continue;

        // Split the text node and wrap the match in a span
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + searchText.length);

        const span = document.createElement('span');
        span.className = 'grammar-error severity-' + match.severity;
        span.dataset.matchIndex = String(mi);
        span.title = match.message;

        range.surroundContents(span);
        found = true;
        highlightCount++;

        // Update textNodes since we split the node
        const newWalker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT);
        textNodes.length = 0;
        let n;
        while ((n = newWalker.nextNode())) {
          textNodes.push(n);
        }
      }

      if (!found) {
        console.log('[Webview] Could not find text for match:', JSON.stringify(searchText));
      }
    }

    console.log('[Webview] Applied', highlightCount, '/', currentGrammarMatches.length, 'highlights');
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
          vscode.postMessage({
            type: 'applyGrammarFix',
            offset: match.originalOffset,
            length: match.originalLength,
            replacement: replacement,
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
