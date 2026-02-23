// @ts-check
(function () {
  // @ts-ignore - markdownit loaded globally from markdown-it.min.js
  const md = window.markdownit({
    html: false,
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
        renderPreview(text);
        updateStatusBar();
        break;
      }
      case 'wikilinkSuggestions': {
        if (autocomplete.triggerOffset >= 0) {
          autocomplete.show(message.suggestions);
        }
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
      vscode.postMessage({ type: 'edit', text: text });
    }, 50);
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

  // Toolbar: Formatting
  document.getElementById('btn-bold')?.addEventListener('click', () => wrapSelection('**', '**'));
  document.getElementById('btn-italic')?.addEventListener('click', () => wrapSelection('*', '*'));
  document.getElementById('btn-strikethrough')?.addEventListener('click', () => wrapSelection('~~', '~~'));

  // Toolbar: Headings
  document.getElementById('btn-h1')?.addEventListener('click', () => insertAtLineStart('# '));
  document.getElementById('btn-h2')?.addEventListener('click', () => insertAtLineStart('## '));
  document.getElementById('btn-h3')?.addEventListener('click', () => insertAtLineStart('### '));

  // Toolbar: Insert elements
  document.getElementById('btn-link')?.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    const replacement = `[${selected || 'link text'}](url)`;
    textarea.value =
      textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    if (selected) {
      // Select the "url" part
      textarea.selectionStart = start + selected.length + 3;
      textarea.selectionEnd = start + selected.length + 6;
    } else {
      // Select "link text"
      textarea.selectionStart = start + 1;
      textarea.selectionEnd = start + 10;
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  });

  document.getElementById('btn-image')?.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    const replacement = `![${selected || 'alt text'}](image-url)`;
    textarea.value =
      textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  });

  document.getElementById('btn-code')?.addEventListener('click', () => wrapSelection('`', '`'));

  document.getElementById('btn-codeblock')?.addEventListener('click', () => {
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
  });

  // Toolbar: Lists & blocks
  document.getElementById('btn-ul')?.addEventListener('click', () => insertAtLineStart('- '));
  document.getElementById('btn-ol')?.addEventListener('click', () => insertAtLineStart('1. '));
  document.getElementById('btn-quote')?.addEventListener('click', () => insertAtLineStart('> '));
  document.getElementById('btn-hr')?.addEventListener('click', () => {
    insertAtCursor('\n---\n');
  });

  // Toolbar: Grammar check
  document.getElementById('btn-check-grammar')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'requestGrammarCheck' });
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
  });
  document.getElementById('btn-editor-only')?.addEventListener('click', () => {
    editorContainer.className = 'editor-container editor-only';
    setActiveToggle('btn-editor-only');
  });
  document.getElementById('btn-preview-only')?.addEventListener('click', () => {
    editorContainer.className = 'editor-container preview-only';
    setActiveToggle('btn-preview-only');
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

  function renderPreview(text) {
    const processed = preprocessWikilinks(text);
    previewContent.innerHTML = md.render(processed);
  }

  // Wikilink click handler in preview
  previewContent.addEventListener('click', (e) => {
    const link = e.target.closest('.wikilink');
    if (link) {
      e.preventDefault();
      vscode.postMessage({ type: 'openWikilink', target: link.dataset.target });
    }
  });

  // ================================================
  // Status bar
  // ================================================
  function updateStatusBar() {
    // Line and column
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

  textarea.addEventListener('click', updateStatusBar);
  textarea.addEventListener('keyup', updateStatusBar);

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

  // ================================================
  // Signal ready
  // ================================================
  vscode.postMessage({ type: 'ready' });
})();
