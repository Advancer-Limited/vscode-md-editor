// @ts-nocheck
// Common webview chrome for the Office viewers (spec ยง5, ยง6.4, ยง10.3, ยง11).
//
// Loaded as a classic script by the Word and Excel webviews (global `OfficeCommon`) and via
// `require` by the unit tests. Security rule (plan ยง1.8): document-derived strings are only ever
// assigned through `textContent` / `setAttribute`; there is no HTML string building here.
(function (global) {
  'use strict';

  const READ_ONLY_TEXT = {
    'view-mode': 'Editing is turned off. Press Edit (Ctrl+E) to make changes.',
    'non-writable-scheme': 'Read-only: this file cannot be written to (for example a Git revision or a read-only file system).',
    'too-large': 'Read-only: this document is too large to edit safely.',
    'protected': 'Read-only: the document is protected. Remove the protection in Word or Excel to edit it here.',
    'strict-ooxml': 'Read-only: this file uses Strict Open XML, which this editor cannot edit safely.',
    'unsupported-xml-layout': 'Read-only: this file uses an XML layout this editor cannot edit safely.',
    'utf16-part': 'Read-only: this file contains UTF-16 encoded parts this editor cannot edit safely.',
    'tracked-changes-on': 'Read-only: Track Changes is on in this document. Turn it off in Word to edit it here.',
  };

  // PDF-only reasons (spec ง5, ง6.2, ง9.1, ง10.4). The shared reasons above are reused as is.
  const PDF_READ_ONLY_TEXT = {
    'view-mode': 'Editing is turned off. Press Edit (Ctrl+E) to annotate this PDF.',
    'non-writable-scheme': 'Read-only: this file cannot be written to (for example a Git revision or a read-only file system).',
    'too-large': 'Read-only: this PDF is too large to edit safely.',
    'encrypted': 'Read-only: this PDF is password protected. Editing protected PDFs is not supported.',
    'unsupported-structure': 'Read-only: this PDF has a structure this editor cannot edit safely. Open it in a PDF reader to change it.',
    'engine-too-old': 'Read-only: this version of VS Code is too old to edit PDFs. Update VS Code to enable editing.',
  };

  const EDIT_HINT = 'Press Edit (Ctrl+E) to make changes';
  const HINT_MS = 4000;

  const state = {
    vscode: null, onEditModeToggle: null, onMessage: null,
    kind: null, canEdit: false, editMode: false, readOnlyReason: null,
    root: null, editBtn: null, reasonEl: null, noticesEl: null,
    hintEl: null, liveEl: null, errorEl: null,
    hintTimer: null, lastAnnounce: '',
  };

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function readOnlyText(reason) {
    const table = state.kind === 'pdf' ? PDF_READ_ONLY_TEXT : READ_ONLY_TEXT;
    return table[reason] || READ_ONLY_TEXT[reason] || 'Read-only.';
  }

  function openExternallyLabel() {
    return state.kind === 'pdf' ? 'Open externally' : 'Open in ' + appName();
  }

  function appName() {
    if (state.kind === 'pdf') { return 'a PDF reader'; }
    return state.kind === 'docx' ? 'Word' : state.kind === 'xlsx' ? 'Excel' : 'Word or Excel';
  }

  // ---------- toolbar ----------

  /**
   * items: [{ id, label, title?, toggle?: boolean, pressed?: boolean, disabled?: boolean,
   *           onClick?: (pressed|undefined) => void }]
   */
  function toolbar(container, items) {
    container.setAttribute('role', 'toolbar');
    if (!container.getAttribute('aria-label')) {
      container.setAttribute('aria-label', 'Toolbar');
    }
    container.className = (container.className ? container.className + ' ' : '') + 'office-toolbar';
    const buttons = [];
    const byId = {};
    let current = 0;

    function setCurrent(i) {
      current = i;
      buttons.forEach((b, j) => b.setAttribute('tabindex', j === i ? '0' : '-1'));
    }
    function enabledIndexes() {
      const out = [];
      buttons.forEach((b, i) => { if (!b.disabled && !b.hidden) { out.push(i); } });
      return out;
    }

    items.forEach((item) => {
      const b = el('button', 'office-btn', item.label);
      b.setAttribute('type', 'button');
      if (item.title) { b.setAttribute('title', item.title); }
      b.setAttribute('aria-label', item.title || item.label);
      if (item.toggle) { b.setAttribute('aria-pressed', item.pressed ? 'true' : 'false'); }
      b.disabled = !!item.disabled;
      b.addEventListener('click', () => {
        if (b.disabled) { return; }
        if (item.toggle) {
          const next = b.getAttribute('aria-pressed') !== 'true';
          b.setAttribute('aria-pressed', next ? 'true' : 'false');
          if (item.onClick) { item.onClick(next); }
        } else if (item.onClick) {
          item.onClick();
        }
      });
      b.addEventListener('focus', () => { setCurrent(buttons.indexOf(b)); });
      buttons.push(b);
      byId[item.id] = b;
      container.appendChild(b);
    });
    setCurrent(0);

    container.addEventListener('keydown', (ev) => {
      const idx = enabledIndexes();
      if (!idx.length) { return; }
      const pos = idx.indexOf(current);
      let target = null;
      switch (ev.key) {
        case 'ArrowRight': case 'ArrowDown': target = idx[(pos + 1) % idx.length]; break;
        case 'ArrowLeft': case 'ArrowUp': target = idx[(pos - 1 + idx.length) % idx.length]; break;
        case 'Home': target = idx[0]; break;
        case 'End': target = idx[idx.length - 1]; break;
        default: return;
      }
      if (ev.preventDefault) { ev.preventDefault(); }
      setCurrent(target);
      buttons[target].focus();
    });

    return {
      element: container,
      buttons,
      button(id) { return byId[id] || null; },
      setPressed(id, pressed) { if (byId[id]) { byId[id].setAttribute('aria-pressed', pressed ? 'true' : 'false'); } },
      setDisabled(id, disabled) { if (byId[id]) { byId[id].disabled = !!disabled; } },
      setHidden(id, hidden) { if (byId[id]) { byId[id].hidden = !!hidden; } },
    };
  }

  // ---------- chrome ----------

  function ensureChrome() {
    if (state.root) { return; }
    let root = document.getElementById('office-chrome');
    if (!root) {
      root = el('div');
      root.id = 'office-chrome';
      if (document.body.firstChild) { document.body.insertBefore(root, document.body.firstChild); }
      else { document.body.appendChild(root); }
    }
    root.className = 'office-chrome';
    state.root = root;

    const bar = el('div', 'office-bar');
    const tb = el('div', 'office-common-toolbar');
    tb.setAttribute('aria-label', 'Document');
    const api = toolbar(tb, [{
      id: 'edit', label: 'Edit', title: 'Edit (Ctrl+E)', toggle: true, pressed: false,
      onClick: (pressed) => { requestEditMode(pressed); },
    }]);
    state.editBtn = api.button('edit');
    state.editBtn.hidden = true;
    state.reasonEl = el('span', 'office-reason');
    state.reasonEl.hidden = true;
    bar.appendChild(tb);
    bar.appendChild(state.reasonEl);

    state.noticesEl = el('div', 'office-notices');
    state.noticesEl.setAttribute('role', 'region');
    state.noticesEl.setAttribute('aria-label', 'Notices');
    state.noticesEl.hidden = true;

    state.hintEl = el('div', 'office-hint');
    state.hintEl.hidden = true;

    state.liveEl = el('div', 'office-live office-visually-hidden');
    state.liveEl.setAttribute('role', 'status');
    state.liveEl.setAttribute('aria-live', 'polite');
    state.liveEl.setAttribute('aria-atomic', 'true');

    state.errorEl = el('div', 'office-error');
    state.errorEl.setAttribute('role', 'alert');
    state.errorEl.hidden = true;

    [bar, state.noticesEl, state.hintEl, state.liveEl, state.errorEl]
      .forEach((n) => root.appendChild(n));
  }

  function post(msg) { if (state.vscode) { state.vscode.postMessage(msg); } }

  function requestEditMode(editMode) {
    if (!state.canEdit) {
      // With a reason, say why editing is unavailable. Without one, this build has no editing at
      // all (no Edit button), so there is nothing to tell the user to press.
      if (state.readOnlyReason) { hint(readOnlyText(state.readOnlyReason)); }
      syncEditButton();
      return;
    }
    post({ type: 'setEditMode', editMode: !!editMode });
  }

  function syncEditButton() {
    if (!state.editBtn) { return; }
    state.editBtn.hidden = !state.canEdit;
    state.editBtn.setAttribute('aria-pressed', state.editMode ? 'true' : 'false');
  }

  function setInit(msg) {
    ensureChrome();
    state.kind = msg.kind;
    state.canEdit = !!msg.canEdit;
    state.readOnlyReason = msg.readOnlyReason || null;
    state.editMode = !!msg.editMode && state.canEdit;
    syncEditButton();
    if (!state.canEdit && state.readOnlyReason) {
      state.reasonEl.textContent = readOnlyText(state.readOnlyReason);
      state.reasonEl.hidden = false;
    } else {
      state.reasonEl.textContent = '';
      state.reasonEl.hidden = true;
    }
    state.errorEl.hidden = true;
    clear(state.errorEl);
    document.body.classList.remove('office-has-error');
    showNotices(msg.notices || []);
  }

  function showNotices(notices) {
    ensureChrome();
    clear(state.noticesEl);
    (notices || []).forEach((n) => {
      const sev = n && n.severity === 'warning' ? 'warning' : 'info';
      const row = el('div', 'office-notice office-notice-' + sev);
      row.appendChild(el('span', 'office-notice-label', sev === 'warning' ? 'Warning: ' : 'Info: '));
      row.appendChild(el('span', 'office-notice-text', n && n.message));
      state.noticesEl.appendChild(row);
    });
    state.noticesEl.hidden = !(notices && notices.length);
  }

  function showError(msg) {
    ensureChrome();
    clear(state.errorEl);
    state.errorEl.appendChild(el('h2', 'office-error-title', msg.title));
    if (msg.detail) {
      const details = el('details', 'office-error-details');
      details.appendChild(el('summary', null, 'Details'));
      details.appendChild(el('pre', 'office-error-detail', msg.detail));
      state.errorEl.appendChild(details);
    }
    const actions = el('div', 'office-error-actions');
    (msg.actions || []).forEach((a) => {
      if (a === 'openExternally') {
        const b = el('button', 'office-btn office-btn-primary', openExternallyLabel());
        b.setAttribute('type', 'button');
        b.setAttribute('data-action', 'openExternally');
        b.addEventListener('click', () => post({ type: 'openExternally' }));
        actions.appendChild(b);
      } else if (a === 'retry') {
        const b = el('button', 'office-btn', 'Retry');
        b.setAttribute('type', 'button');
        b.setAttribute('data-action', 'retry');
        b.addEventListener('click', () => post({ type: 'retry' }));
        actions.appendChild(b);
      }
    });
    state.errorEl.appendChild(actions);
    state.errorEl.hidden = false;
    document.body.classList.add('office-has-error');
  }

  function hint(text) {
    ensureChrome();
    state.hintEl.textContent = text;
    state.hintEl.hidden = false;
    announce(text);
    if (state.hintTimer) { clearTimeout(state.hintTimer); }
    state.hintTimer = setTimeout(() => {
      state.hintEl.hidden = true;
      state.hintEl.textContent = '';
      state.hintTimer = null;
    }, HINT_MS);
  }

  function announce(text) {
    ensureChrome();
    // Repeating an identical string would not re-announce; alternate a trailing nbsp.
    const out = text === state.lastAnnounce ? text + 'ย ' : text;
    state.lastAnnounce = out;
    state.liveEl.textContent = out;
  }

  // ---------- message + key wiring ----------

  function handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') { return; }
    switch (msg.type) {
      case 'init':
        setInit(msg);
        if (state.onEditModeToggle) { state.onEditModeToggle(state.editMode); }
        break;
      case 'loadError': showError(msg); break;
      case 'editModeChanged':
        state.editMode = !!msg.editMode && state.canEdit;
        syncEditButton();
        announce(state.editMode ? 'Edit mode on' : 'Edit mode off');
        if (state.onEditModeToggle) { state.onEditModeToggle(state.editMode); }
        break;
      case 'notices': showNotices(msg.notices); break;
      case 'requestFailed':
        if (msg.error && msg.error.message) { hint(msg.error.message); }
        break;
      default: break;
    }
    // Every message (including the common ones) is also offered to the viewer: it owns
    // flushPendingEdits, requestFailed correlation and all docx*/xlsx* replies.
    if (state.onMessage) { state.onMessage(msg); }
  }

  function onKeyDown(ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && (ev.key === 'e' || ev.key === 'E')) {
      if (ev.preventDefault) { ev.preventDefault(); }
      requestEditMode(!state.editMode);
    }
  }

  function init(opts) {
    state.vscode = opts.vscode;
    state.onEditModeToggle = opts.onEditModeToggle || null;
    state.onMessage = opts.onMessage || null;
    ensureChrome();
    window.addEventListener('message', (e) => { handleMessage(e.data); });
    window.addEventListener('keydown', onKeyDown);
    post({ type: 'ready' });
  }

  const api = {
    init, toolbar, setInit, showNotices, showError, hint, announce,
    READ_ONLY_TEXT, PDF_READ_ONLY_TEXT, EDIT_HINT, openExternallyLabel, appName,
    isEditMode() { return state.editMode; },
    canEdit() { return state.canEdit; },
  };
  global.OfficeCommon = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
