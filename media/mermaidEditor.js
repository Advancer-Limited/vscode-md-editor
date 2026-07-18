// @ts-check
(function () {
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const textarea = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('mmd-input')
  );
  const preview = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-preview')
  );
  const errorEl = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-error')
  );
  const container = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-container')
  );
  const divider = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-divider')
  );

  // @ts-ignore - mermaid loaded globally from mermaid.min.js
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
  });

  // Track whether the current textarea update originated from the extension
  // host (an 'update' message), so the 'input' handler doesn't treat the
  // resulting DOM mutation as a local edit and echo it straight back.
  let isExternalUpdate = false;

  // The diagram source most recently posted to the extension host, plus
  // whether a debounced local edit is still waiting to be posted, plus how
  // many posted edits haven't been acked yet. Together these let the
  // 'update' handler recognize echoes of our own edits and avoid clobbering
  // local typing that is still in flight to the host.
  let lastSentEditText = null;
  let localEditPending = false;
  let editsInFlight = 0;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let editDebounce;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let renderDebounce;
  let renderSeq = 0;

  // The extension host's document text may use CRLF line endings while the
  // textarea (an HTML control) always normalizes to LF internally. Work in
  // LF throughout the webview and let the host re-expand to the document's
  // real EOL on the way back in (mirrors mermaidEditorProvider.ts's 'edit'
  // handler). Without this, `text === lastSentEditText` below would never
  // match for CRLF documents and every one of our own edits would look like
  // an external change, causing the textarea to be clobbered and the caret
  // to jump on every keystroke.
  function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n');
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'editAck') {
      editsInFlight = Math.max(0, editsInFlight - 1);
      return;
    }
    if (message.type === 'update') {
      const text = normalizeEol(message.text);
      const isEcho = text === textarea.value || text === lastSentEditText;
      if (isEcho) {
        return;
      }
      // A newer local edit is still in flight to the host (debounced, or
      // sent but not yet acked) — applying this now-stale host text would
      // clobber what the user just typed. Drop it; once the in-flight edit
      // is acked, the document already matches what we're showing.
      if (localEditPending || editsInFlight > 0) {
        return;
      }
      isExternalUpdate = true;
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      textarea.value = text;
      textarea.selectionStart = Math.min(selStart, text.length);
      textarea.selectionEnd = Math.min(selEnd, text.length);
      isExternalUpdate = false;
      renderDiagram(text);
    }
  });

  textarea.addEventListener('input', () => {
    if (isExternalUpdate) {
      return;
    }
    const text = textarea.value;

    clearTimeout(renderDebounce);
    renderDebounce = setTimeout(() => renderDiagram(text), 300);

    localEditPending = true;
    clearTimeout(editDebounce);
    editDebounce = setTimeout(() => {
      localEditPending = false;
      editsInFlight++;
      lastSentEditText = text;
      vscode.postMessage({ type: 'edit', text: text });
    }, 150);
  });

  /** @param {string} source */
  async function renderDiagram(source) {
    const seq = ++renderSeq;
    if (!source.trim()) {
      preview.innerHTML = '';
      errorEl.hidden = true;
      return;
    }
    const diagramId = 'mmd-diagram-' + seq;
    try {
      // @ts-ignore - mermaid global
      await mermaid.parse(source);
      // @ts-ignore - mermaid global
      const { svg } = await mermaid.render(diagramId, source);
      if (seq !== renderSeq) {
        // A newer render superseded this one while we were awaiting it —
        // drop the stale result instead of flashing an old diagram back in.
        return;
      }
      preview.innerHTML = svg;
      errorEl.hidden = true;
    } catch (err) {
      if (seq !== renderSeq) {
        return;
      }
      // mermaid.render() creates a hidden scratch container (id `d` +
      // diagramId) to render into and normally removes it; on a thrown
      // error it can be left behind. Clean it up so failed renders don't
      // leak DOM nodes into the page.
      const orphan = document.getElementById('d' + diagramId);
      if (orphan) {
        orphan.remove();
      }
      // Keep-last-good-render: leave `preview` untouched (it still shows the
      // last valid diagram, if any) and just surface the error banner.
      errorEl.textContent = String((err && err.message) || err);
      errorEl.hidden = false;
    }
  }

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
    const containerRect = container.getBoundingClientRect();
    const editorPane = document.getElementById('mmd-editor-pane');
    const previewPane = document.getElementById('mmd-preview-pane');
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

  vscode.postMessage({ type: 'ready' });
  // Initial render happens when the first 'update' message arrives.
})();
