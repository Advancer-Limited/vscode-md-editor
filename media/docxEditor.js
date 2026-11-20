// Word viewer webview (spec §7.1, §11, §12). Renders the original package bytes with docx-preview,
// adds zoom / section count / Open in Word to the toolbar, and intercepts links.
//
// Loaded as a classic script (globals `docx`, `OfficeCommon`) and via `vm` by the unit tests.
// Security rule (plan §1.8): document-derived strings are only assigned through textContent /
// setAttribute. docx-preview renders into its own container; that output is contained by the CSP.
(function (global) {
  'use strict';

  /** The exact docx-preview options of spec §7.1 (everything else stays at the library default). */
  const RENDER_OPTIONS = Object.freeze({
    breakPages: true,
    inWrapper: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: false,
    renderComments: false,
    renderAltChunks: false,
    experimental: false,
    useBase64URL: false,
  });

  const ZOOM_MIN = 50;
  const ZOOM_MAX = 200;
  const ZOOM_STEPS = [50, 75, 90, 100, 110, 125, 150, 175, 200];
  const FIT_MARGIN_PX = 40;   // docx-preview's wrapper padding on both sides
  const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

  function create(deps) {
    const { document, vscode, OfficeCommon, docxLib, window } = deps;
    const content = document.getElementById('office-content');
    const toolbarEl = document.getElementById('office-toolbar');
    const brandEl = document.getElementById('office-brand');

    let zoom = 100;          // percent actually applied
    let fit = false;
    let rendering = false;
    let queued = null;
    let renderFailed = false;
    let sectionCount = 0;
    const idleWaiters = [];

    function mk(tag, className, text) {
      const e = document.createElement(tag);
      if (className) { e.className = className; }
      if (text !== undefined) { e.textContent = text; }
      return e;
    }
    function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
    function post(msg) { vscode.postMessage(msg); }

    // ---------- content skeleton ----------

    const styles = mk('div', 'docx-styles');
    const host = mk('div', 'docx-host');
    content.setAttribute('tabindex', '0');
    content.setAttribute('role', 'document');
    content.setAttribute('aria-label', 'Word document');
    content.appendChild(styles);
    content.appendChild(host);

    // ---------- toolbar ----------

    let tb = null;
    let countEl = null;

    function buildToolbar() {
      toolbarEl.setAttribute('aria-label', 'Word viewer');
      tb = OfficeCommon.toolbar(toolbarEl, [
        { id: 'zoomOut', label: '−', title: 'Zoom out (Ctrl+-)', onClick: () => stepZoom(-1) },
        { id: 'zoomLevel', label: '100%', title: 'Reset zoom to 100%', onClick: () => setZoom(100) },
        { id: 'zoomIn', label: '+', title: 'Zoom in (Ctrl+=)', onClick: () => stepZoom(1) },
        { id: 'fit', label: 'Fit width', title: 'Fit width', toggle: true, pressed: false,
          onClick: (pressed) => setFit(pressed) },
        { id: 'openExternally', label: 'Open in Word', title: 'Open in Word',
          onClick: () => post({ type: 'openExternally' }) },
      ]);
      countEl = mk('span', 'docx-section-count', '');
      countEl.setAttribute('title', 'Explicit page and section breaks. Word’s own page count can differ.');
      toolbarEl.appendChild(countEl);
      const brand = brandEl && brandEl.firstElementChild;
      if (brand) {
        toolbarEl.appendChild(brand);
        brand.addEventListener('click', () => post({ type: 'showAbout' }));
      }
      syncToolbar();
    }

    function syncToolbar() {
      if (!tb) { return; }
      tb.button('zoomLevel').textContent = Math.round(zoom) + '%';
      tb.setDisabled('zoomOut', zoom <= ZOOM_MIN);
      tb.setDisabled('zoomIn', zoom >= ZOOM_MAX);
      tb.setPressed('fit', fit);
      countEl.textContent = sectionCount > 0
        ? sectionCount + (sectionCount === 1 ? ' section' : ' sections') : '';
    }

    // ---------- zoom ----------

    function clampZoom(p) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, p)); }

    function applyZoom() {
      if (fit) { zoom = computeFit(); }
      host.style.zoom = String(zoom / 100);
      syncToolbar();
    }

    function firstPage() {
      const pages = host.querySelectorAll('section.docx');
      return pages && pages.length ? pages[0] : null;
    }

    function computeFit() {
      const page = firstPage();
      if (!page) { return zoom; }
      // Measure unzoomed: the property is restored synchronously, so nothing is painted in between.
      const previous = host.style.zoom;
      host.style.zoom = '1';
      const pageWidth = page.offsetWidth;
      host.style.zoom = previous;
      const avail = content.clientWidth - FIT_MARGIN_PX;
      if (!(pageWidth > 0) || !(avail > 0)) { return zoom; }
      return clampZoom(Math.floor((avail / pageWidth) * 100));
    }

    function setZoom(percent) {
      fit = false;
      zoom = clampZoom(Math.round(percent));
      applyZoom();
      OfficeCommon.announce('Zoom ' + zoom + '%');
    }

    function stepZoom(dir) {
      const cur = Math.round(zoom);
      let next = null;
      if (dir > 0) {
        next = ZOOM_STEPS.find((s) => s > cur);
        if (next === undefined) { next = ZOOM_MAX; }
      } else {
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
          if (ZOOM_STEPS[i] < cur) { next = ZOOM_STEPS[i]; break; }
        }
        if (next === null) { next = ZOOM_MIN; }
      }
      setZoom(next);
    }

    function setFit(on) {
      fit = !!on;
      applyZoom();
      OfficeCommon.announce(fit ? 'Fit width, zoom ' + Math.round(zoom) + '%' : 'Zoom ' + Math.round(zoom) + '%');
    }

    // ---------- rendering ----------

    function countSections() {
      const pages = host.querySelectorAll('section.docx');
      return pages ? pages.length : 0;
    }

    async function doRender(bytes) {
      const scrollTop = content.scrollTop;
      try {
        if (!docxLib || typeof docxLib.renderAsync !== 'function') {
          throw new Error('The Word renderer did not load.');
        }
        await docxLib.renderAsync(bytes, host, styles, RENDER_OPTIONS);
      } catch (e) {
        showRenderFailure(e);
        return;
      }
      renderFailed = false;
      sectionCount = countSections();
      applyZoom();
      content.scrollTop = scrollTop;
    }

    function showRenderFailure(e) {
      renderFailed = true;
      clear(host);
      clear(styles);
      sectionCount = 0;
      syncToolbar();
      OfficeCommon.showError({
        title: 'This document can’t be displayed.',
        detail: (e && e.message) ? String(e.message) : String(e),
        actions: ['openExternally'],
      });
    }

    /** Renders `bytes`; a render requested while one runs replaces any older queued one. */
    function render(bytes) {
      queued = { bytes };
      if (rendering) { return; }
      rendering = true;
      (async () => {
        try {
          while (queued) {
            const job = queued;
            queued = null;
            await doRender(job.bytes);
          }
        } finally {
          rendering = false;
          idleWaiters.splice(0).forEach((f) => f());
        }
      })();
    }

    function whenIdle() {
      return rendering ? new Promise((resolve) => { idleWaiters.push(resolve); }) : Promise.resolve();
    }

    // ---------- links ----------

    function scrollToAnchor(raw) {
      let id = raw;
      try { id = decodeURIComponent(raw); } catch (e) { /* keep the raw text */ }
      if (!id) { return; }
      const target = document.getElementById(id);
      if (target && typeof target.scrollIntoView === 'function') { target.scrollIntoView(); }
    }

    function linkFor(node) {
      for (let n = node; n; n = n.parentNode) {
        if (n.tagName && String(n.tagName).toUpperCase() === 'A') { return n; }
      }
      return null;
    }

    function onLinkClick(ev) {
      const a = linkFor(ev.target);
      if (!a) { return; }
      const href = a.getAttribute('href');
      if (href === null || href === undefined) { return; }
      // The webview never navigates (spec §12).
      if (ev.preventDefault) { ev.preventDefault(); }
      if (href.charAt(0) === '#') { scrollToAnchor(href.slice(1)); return; }
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href.trim());
      if (m && ALLOWED_SCHEMES.indexOf(m[1].toLowerCase()) >= 0) {
        post({ type: 'openLink', href: href.trim() });
      } else {
        OfficeCommon.announce('This link was not opened.');
      }
    }

    // ---------- view-mode editing gestures ----------

    function editHint() {
      if (OfficeCommon.canEdit() && !OfficeCommon.isEditMode()) { OfficeCommon.hint(OfficeCommon.EDIT_HINT); }
    }

    function onContentKey(ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) { return; }
      const k = ev.key;
      if ((k && k.length === 1 && k !== ' ') || k === 'Delete' || k === 'Backspace' || k === 'F2') { editHint(); }
    }

    // ---------- wiring ----------

    function onKeyDown(ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) { return; }
      if (ev.key === '=' || ev.key === '+') { if (ev.preventDefault) { ev.preventDefault(); } stepZoom(1); }
      else if (ev.key === '-' || ev.key === '_') { if (ev.preventDefault) { ev.preventDefault(); } stepZoom(-1); }
    }

    function onWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      stepZoom(ev.deltaY < 0 ? 1 : -1);
    }

    function onMessage(msg) {
      switch (msg.type) {
        case 'docxRender': render(msg.bytes); break;
        case 'docxStateChanged': post({ type: 'docxRequestRender' }); break;
        case 'flushPendingEdits': post({ type: 'flushed', flushId: msg.flushId }); break;   // view mode: nothing pending
        case 'loadError':
          clear(host); clear(styles); sectionCount = 0; syncToolbar(); break;
        default: break;
      }
    }

    function start() {
      buildToolbar();
      content.addEventListener('click', onLinkClick);
      content.addEventListener('auxclick', onLinkClick);
      content.addEventListener('keydown', onContentKey);
      content.addEventListener('dblclick', editHint);
      content.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', () => { if (fit) { applyZoom(); } });
      OfficeCommon.init({ vscode, onEditModeToggle: () => {}, onMessage });
    }

    return {
      start, whenIdle,
      state: () => ({ zoom, fit, sectionCount, renderFailed }),
    };
  }

  const api = { create, RENDER_OPTIONS, ZOOM_STEPS, ALLOWED_SCHEMES };
  global.DocxViewer = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

  // Auto-start inside the webview (the test sandbox defines no acquireVsCodeApi).
  if (typeof global.acquireVsCodeApi === 'function' && global.document && global.document.getElementById('office-content')) {
    create({
      document: global.document, window: global, OfficeCommon: global.OfficeCommon,
      docxLib: global.docx, vscode: global.acquireVsCodeApi(),
    }).start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
