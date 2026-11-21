// @ts-nocheck
// PDF viewer core (spec §7.1, §7.3, §7.5, §9.1, §9.4, §10.3, §10.4, §12; plan PWP-08).
//
// Loaded as a classic script after pdfjs-bundle.js (global `PdfjsBundle`), officeCommon.js and
// pdfViewMath.js, and via `vm` by the unit tests. It defines the global `PdfViewerShell`, which
// the later viewer scripts (sidebar, find, overlay, tools) plug into; see "shell API" below.
//
// Rules this file keeps:
//  - Document-derived strings reach the DOM only through textContent / setAttribute. There is no
//    HTML string building anywhere in this file (plan §1 rule 4).
//  - No `style` attributes and no injected <style>: the CSP has no 'unsafe-inline'. Visibility is
//    the `hidden` attribute, everything else is a class in pdfViewer.css.
//  - The webview never navigates. Only http/https/mailto links are forwarded (`openLink`); the
//    host applies the same allow-list again.
//  - Nothing from the document is executed: no scripting manager, `enableScripting` is never set,
//    XFA is off, and pdf.js's own annotation-editor UI is disabled.
//  - The password of an encrypted file stays in this closure; no message carries it.
(function (global) {
  'use strict';

  /** Spec §9.4 sentences, verbatim from PDF_VIEWER_TEXT in src/pdf/loadErrors.ts (a test compares). */
  const TEXT = Object.freeze({
    damaged: "This file is damaged and can't be displayed.",
    engineTooOld: 'The PDF viewer needs a newer version of VS Code.',
    passwordCancelled: 'This PDF is password-protected. Reopen it to enter the password, or open it externally.',
    passwordIncorrect: 'Incorrect password',
    pageFailed: "This page couldn't be displayed",
  });
  const PASSWORD_PROMPT = 'This PDF is password-protected. Enter the password to open it.';
  const LINK_BLOCKED = 'This link was not opened.';
  const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];
  const SCALE_PRESETS = ['auto', 'page-actual', 'page-fit', 'page-width'];
  const PRESET_LABELS = { 'auto': 'Automatic', 'page-actual': 'Actual size', 'page-fit': 'Fit page', 'page-width': 'Fit width' };
  const WORKER_FILE = 'pdf.worker.min.mjs';
  const MAX_CLIPBOARD = 50000000;      // OFFICE protocol limit for `writeClipboard.text`
  const MAX_FACT_STRING = 4096;        // PDF_PROTOCOL_LIMITS.MAX_FACT_STRING
  const MAX_SIGNATURES = 1000;         // PDF_PROTOCOL_LIMITS.MAX_SIGNATURES
  const FACT_PAGES = 5;                // "first pages" looked at for text and page-level scripts
  const MAX_VIOLATIONS = 50;
  const PERSIST_MS = 150;
  const LINE_PX = 40;

  // ---------- pure helpers (exported for tests) ----------

  /**
   * Spec §10.4: the features the pinned pdf.js build needs. Returns the names of the missing ones
   * (empty = the engine is new enough). Never throws.
   */
  function engineProblems(win) {
    const missing = [];
    const need = (name, probe) => {
      let ok = false;
      try { ok = !!probe(); } catch (e) { ok = false; }
      if (!ok) { missing.push(name); }
    };
    need('Promise.withResolvers', () => typeof win.Promise.withResolvers === 'function');
    need('CSS round()', () => win.CSS.supports('width', 'round(down, 10.5px, 1px)'));
    need('WebAssembly', () => typeof win.WebAssembly === 'object');
    need('OffscreenCanvas', () => typeof win.OffscreenCanvas === 'function');
    need('module Worker', () => {
      const url = win.URL.createObjectURL(new win.Blob([''], { type: 'text/javascript' }));
      try {
        new win.Worker(url, { type: 'module' }).terminate();
        return true;
      } finally {
        win.URL.revokeObjectURL(url);
      }
    });
    need('pdf.js bundle', () => !!(win.PdfjsBundle && win.PdfjsBundle.pdfjsLib && win.PdfjsBundle.pdfjsViewer));
    return missing;
  }

  /**
   * The exact `getDocument` options (spec §3.1, §12; plan PWP-08). No network (range, stream and
   * auto-fetch off; the data files come from the extension's own media/pdfjs/ through the main
   * thread), no XFA, and nothing that enables scripting.
   */
  function documentOptions(bytes, baseUrl) {
    return {
      data: bytes,
      cMapUrl: baseUrl + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: baseUrl + 'standard_fonts/',
      wasmUrl: baseUrl + 'wasm/',
      iccUrl: baseUrl + 'iccs/',
      enableXfa: false,
      useWorkerFetch: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
    };
  }

  /** A plain Uint8Array from whatever the message carried (the host posts a plain Uint8Array). */
  function toBytes(data) {
    const tag = Object.prototype.toString.call(data);   // realm-independent, unlike instanceof
    if (tag === '[object Uint8Array]') { return data; }
    if (tag === '[object ArrayBuffer]') { return new Uint8Array(data); }
    if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
    if (Array.isArray(data)) { return Uint8Array.from(data); }
    if (data && typeof data === 'object' && Array.isArray(data.data)) { return Uint8Array.from(data.data); }   // { type: 'Buffer' }
    throw new Error('The document data did not arrive in a readable form.');
  }

  /** 'auto' | 'page-actual' | 'page-fit' | 'page-width' | a numeric string within the zoom range; else null. */
  function normaliseScaleValue(value, VM) {
    if (value === null || value === undefined || value === '') { return null; }
    const s = String(value);
    if (SCALE_PRESETS.indexOf(s) >= 0) { return s; }
    const n = Number(s);
    if (!isFinite(n) || n <= 0) { return null; }
    return String(VM.clampZoom(n));
  }

  /** The scheme of an href if it may be opened (http, https, mailto), else null. */
  function allowedScheme(href) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(href).trim());
    if (!m) { return null; }
    const scheme = m[1].toLowerCase();
    return ALLOWED_SCHEMES.indexOf(scheme) >= 0 ? scheme : null;
  }

  /**
   * `PdfFacts` (spec §5, §7.6) from a loaded pdf.js document. Display only. Every probe is
   * independent and failure-tolerant: a probe that throws leaves its fact at the default.
   * JavaScript is detected with `getJSActions()` (document and first pages) and with fields or
   * widgets that carry actions — not `hasJSActions()`, which is also true for signed files.
   */
  async function collectFacts(pdf, opts) {
    const o = opts || {};
    const facts = {
      pageCount: pdf.numPages | 0, encrypted: !!o.passwordUsed, hasText: false, hasJavaScript: false,
      hasXfa: false, attachmentCount: 0, signatures: [],
    };
    const safe = async (f) => { try { return await f(); } catch (e) { return null; } };
    const str = (v) => (v === null || v === undefined ? '' : String(v)).slice(0, MAX_FACT_STRING);

    const meta = await safe(() => pdf.getMetadata());
    const info = (meta && meta.info) || {};
    if (info.EncryptFilterName) { facts.encrypted = true; }
    facts.hasXfa = !!info.IsXFAPresent;

    if ((await safe(() => pdf.getJSActions())) != null) { facts.hasJavaScript = true; }
    const fields = await safe(() => pdf.getFieldObjects());
    if (fields && !facts.hasJavaScript) {
      for (const name of Object.keys(fields)) {
        const list = Array.isArray(fields[name]) ? fields[name] : [];
        if (list.some((f) => f && f.actions != null)) { facts.hasJavaScript = true; break; }
      }
    }

    const attachments = await safe(() => pdf.getAttachments());   // a Map in pdf.js 6
    if (attachments) {
      facts.attachmentCount = typeof attachments.size === 'number' ? attachments.size : Object.keys(attachments).length;
    }

    const sigs = await safe(() => (typeof pdf.getSignatures === 'function' ? pdf.getSignatures() : null));
    if (Array.isArray(sigs)) {
      for (const s of sigs.slice(0, MAX_SIGNATURES)) {
        if (s) { facts.signatures.push({ signer: str(s.signerName), reason: str(s.reason), time: str(s.signingTime) }); }
      }
    }

    const pages = Math.min(facts.pageCount, o.pages || FACT_PAGES);
    for (let n = 1; n <= pages && !(facts.hasText && facts.hasJavaScript); n++) {
      const page = await safe(() => pdf.getPage(n));
      if (!page) { continue; }
      if (!facts.hasText) {
        const tc = await safe(() => page.getTextContent());
        if (tc && Array.isArray(tc.items) && tc.items.some((i) => i && typeof i.str === 'string' && i.str.trim() !== '')) {
          facts.hasText = true;
        }
      }
      if (!facts.hasJavaScript) {
        if ((await safe(() => page.getJSActions())) != null) { facts.hasJavaScript = true; }
        const annots = facts.hasJavaScript ? null : await safe(() => page.getAnnotations());
        if (Array.isArray(annots) && annots.some((a) => a && a.actions != null)) { facts.hasJavaScript = true; }
      }
    }
    return facts;
  }

  // ---------- the shell ----------

  function create(deps) {
    const win = deps.window;
    const document = deps.document;
    const vscode = deps.vscode;
    const OC = deps.OfficeCommon;
    const VM = deps.PdfViewMath;

    const app = document.getElementById('office-app');
    const content = document.getElementById('office-content');
    const toolbarEl = document.getElementById('office-toolbar');
    const brandEl = document.getElementById('office-brand');
    const baseUrl = (app && app.getAttribute('data-pdfjs-base')) || '';
    const cacheBust = (app && app.getAttribute('data-cache-bust')) || '';
    const defaultScale = normaliseScaleValue(app && app.getAttribute('data-default-zoom'), VM) || 'auto';

    // pdf.js objects (created after the engine check, on the first document)
    let lib = null, V = null;
    let eventBus = null, linkService = null, findController = null, viewer = null, viewerAbort = null;
    let annotationMode = null;          // AnnotationMode.ENABLE_STORAGE until a later PWP switches
    let worker = null, workerPromise = null, workerIsOurs = null;

    // document state
    let started = false;
    let engineMissing = [];
    let phase = 'idle';                 // idle | loading | password | ready | failed
    let generation = -1, version = 0, fileName = '';
    let loadToken = 0;
    let loadingTask = null, pdfDocument = null, pageLabels = null;
    let editMode = false;

    // password (webview memory only)
    let rememberedPassword = null, candidate = null, triedRemembered = false;
    let passwordAsked = false, passwordSubmitted = false, passwordCancelled = false, pwUpdate = null;

    // view state (vscode.setState)
    let view = null;                    // { page, scale, rotation, left, top }
    let pendingView = null;             // applied at the next `pagesinit`
    let sidebarOpen = false, activePanel = null;
    let moduleState = {};
    let persistTimer = null;

    // registrations
    const listeners = {};
    const panels = [];
    const tools = [];
    const extraItems = [];
    const keys = [];
    let activeTool = null;
    let flushHandler = null;
    const violations = [];

    // DOM
    let layout, sidebarEl, tablistEl, panelsEl, main, container = null, viewerDiv = null;
    let passwordEl, pwInput, pwError;
    let tb = null, toolbarInner = null, pageInput = null, pageCountEl = null, zoomSelect = null, customOption = null;

    function mk(tag, className, text) {
      const e = document.createElement(tag);
      if (className) { e.className = className; }
      if (text !== undefined && text !== null) { e.textContent = String(text); }
      return e;
    }
    function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
    function post(msg) { vscode.postMessage(msg); }
    /** `pdfLog` (spec §5, §12): identical reports are sent once per document; URLs lose query and fragment. */
    const loggedOnce = new Set();
    function stripUrl(s) { return String(s || '').replace(/[?#].*$/, '').slice(0, 200); }
    function hostLog(level, code, detail, key) {
      const k = code + '|' + (key !== undefined ? key : detail || '');
      if (loggedOnce.has(k)) { return; }
      if (loggedOnce.size < 200) { loggedOnce.add(k); }
      const m = { type: 'pdfLog', level, code };
      if (detail) { m.detail = String(detail).slice(0, 1000); }
      try { post(m); } catch (e) { /* logging never breaks the viewer */ }
    }
    function prevent(ev) { if (ev && ev.preventDefault) { ev.preventDefault(); } }
    function warn() {
      if (win.console && win.console.warn) { win.console.warn.apply(win.console, ['[PdfViewer]'].concat([].slice.call(arguments))); }
    }

    // ---------- events for later scripts ----------

    function on(type, cb) {
      (listeners[type] = listeners[type] || []).push(cb);
      return () => { listeners[type] = (listeners[type] || []).filter((f) => f !== cb); };
    }
    function emit(type, payload) {
      (listeners[type] || []).slice().forEach((cb) => {
        try { cb(payload); } catch (e) { warn('listener for', type, 'failed:', e && e.message); }
      });
    }

    // ---------- persisted state ----------

    function restoreState() {
      let s = null;
      try { s = vscode.getState ? vscode.getState() : null; } catch (e) { s = null; }
      if (!s || typeof s !== 'object' || s.v !== 1) { return; }
      if (s.view && typeof s.view === 'object') { pendingView = cleanView(s.view); view = pendingView; }
      if (s.sidebar && typeof s.sidebar === 'object') {
        sidebarOpen = s.sidebar.open === true;
        activePanel = typeof s.sidebar.tab === 'string' ? s.sidebar.tab : null;
      }
      if (s.modules && typeof s.modules === 'object') { moduleState = Object.assign({}, s.modules); }
    }

    function cleanView(v) {
      const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
      return {
        page: Math.max(1, Math.trunc(num(v.page) || 1)),
        scale: normaliseScaleValue(v.scale, VM),
        rotation: VM.normalizeRotation(num(v.rotation) || 0),
        left: num(v.left), top: num(v.top),
      };
    }

    function persistNow() {
      persistTimer = null;
      if (!vscode.setState) { return; }
      try {
        vscode.setState({ v: 1, view, sidebar: { open: sidebarOpen, tab: activePanel }, modules: moduleState });
      } catch (e) { /* state is a convenience */ }
    }
    function persist() {
      if (persistTimer !== null) { return; }
      persistTimer = win.setTimeout(persistNow, PERSIST_MS);
    }

    // ---------- layout ----------

    function buildLayout() {
      layout = mk('div', 'pdf-layout');

      sidebarEl = mk('div', 'pdf-sidebar');
      sidebarEl.setAttribute('role', 'complementary');
      sidebarEl.setAttribute('aria-label', 'Sidebar');
      sidebarEl.hidden = true;
      tablistEl = mk('div', 'pdf-sidebar-tabs');
      tablistEl.setAttribute('role', 'tablist');
      tablistEl.setAttribute('aria-label', 'Sidebar views');
      tablistEl.addEventListener('keydown', onTabKey);
      panelsEl = mk('div', 'pdf-sidebar-panels');
      sidebarEl.appendChild(tablistEl);
      sidebarEl.appendChild(panelsEl);

      main = mk('div', 'pdf-main');
      buildPassword();
      main.appendChild(passwordEl);

      layout.appendChild(sidebarEl);
      layout.appendChild(main);
      content.appendChild(layout);
      newContainer();
    }

    /** A fresh scroll container (pdf.js needs an absolutely positioned DIV holding a `.pdfViewer` DIV). */
    function newContainer() {
      const old = container;
      container = mk('div', 'pdf-container');
      container.setAttribute('tabindex', '0');
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', 'PDF pages');
      viewerDiv = mk('div', 'pdfViewer');
      container.appendChild(viewerDiv);
      if (old && old.parentNode === main) { main.replaceChild(container, old); }
      else { main.insertBefore(container, main.firstChild); }
    }

    // ---------- toolbar ----------

    function buildToolbar() {
      const items = [
        { id: 'sidebar', label: 'Sidebar', title: 'Toggle sidebar (F4)', toggle: true, pressed: sidebarOpen,
          onClick: (pressed) => setSidebarOpen(pressed) },
        { id: 'prev', label: '↑', title: 'Previous page', onClick: () => stepPage(-1) },
        { id: 'next', label: '↓', title: 'Next page', onClick: () => stepPage(1) },
        { id: 'zoomOut', label: '−', title: 'Zoom out (Ctrl+-)', onClick: () => zoomStep(-1) },
        { id: 'zoomIn', label: '+', title: 'Zoom in (Ctrl+=)', onClick: () => zoomStep(1) },
        { id: 'rotateCcw', label: '⟲', title: 'Rotate view counter-clockwise (Shift+R)', onClick: () => rotate(-1) },
        { id: 'rotateCw', label: '⟳', title: 'Rotate view clockwise (R)', onClick: () => rotate(1) },
      ];
      extraItems.forEach((x) => {
        items.push({ id: x.id, label: x.label, title: x.title, toggle: !!x.toggle, pressed: !!x.state.pressed,
          disabled: !!x.state.disabled, onClick: x.onClick });
      });
      tools.forEach((t) => {
        items.push({ id: 'tool:' + t.id, label: t.label, title: t.title, toggle: !t.run, pressed: activeTool === t.id,
          onClick: () => { if (t.run) { runTool(t); } else { setTool(activeTool === t.id ? null : t.id); } } });
      });
      items.push({ id: 'openExternally', label: 'Open externally', title: 'Open externally',
        onClick: () => post({ type: 'openExternally' }) });

      const inner = mk('div', 'pdf-toolbar');
      inner.setAttribute('aria-label', 'PDF viewer');
      tb = OC.toolbar(inner, items);

      // Page box and zoom list sit between the buttons. They are their own tab stops (native
      // controls that use the arrow keys), so their arrow keys must not reach the roving toolbar.
      const pageWrap = mk('span', 'pdf-page-box');
      pageInput = mk('input', 'pdf-page-input');
      pageInput.setAttribute('type', 'text');
      pageInput.setAttribute('aria-label', 'Page');
      pageInput.setAttribute('title', 'Page (Ctrl+G): a page number or a page label');
      pageInput.setAttribute('autocomplete', 'off');
      pageInput.addEventListener('keydown', (ev) => {
        keepFromToolbar(ev);
        if (ev.key === 'Enter') { prevent(ev); commitPageBox(); }
        else if (ev.key === 'Escape') { prevent(ev); syncToolbar(); if (container.focus) { container.focus(); } }
      });
      pageInput.addEventListener('change', commitPageBox);
      pageCountEl = mk('span', 'pdf-page-count', '');
      pageWrap.appendChild(pageInput);
      pageWrap.appendChild(pageCountEl);
      inner.insertBefore(pageWrap, tb.button('next'));

      zoomSelect = mk('select', 'pdf-zoom-select');
      zoomSelect.setAttribute('aria-label', 'Zoom');
      zoomSelect.setAttribute('title', 'Zoom');
      const option = (value, label) => {
        const o = mk('option', null, label);
        o.setAttribute('value', value);
        o.value = value;
        zoomSelect.appendChild(o);
        return o;
      };
      SCALE_PRESETS.forEach((p) => option(p, PRESET_LABELS[p]));
      VM.ZOOM_STEPS.forEach((s) => option(String(s), VM.zoomPercent(s) + '%'));
      customOption = option('custom', '');
      customOption.hidden = true;
      zoomSelect.addEventListener('keydown', keepFromToolbar);
      zoomSelect.addEventListener('change', () => {
        if (zoomSelect.value !== 'custom') { setScaleValue(zoomSelect.value, true); }
      });
      inner.insertBefore(zoomSelect, tb.button('zoomIn'));

      if (toolbarInner && toolbarInner.parentNode === toolbarEl) { toolbarEl.replaceChild(inner, toolbarInner); }
      else { toolbarEl.insertBefore(inner, toolbarEl.firstChild); }
      toolbarInner = inner;
      syncToolbar();
    }

    /** Arrow keys, Home and End belong to the control, not to the roving toolbar around it. */
    function keepFromToolbar(ev) {
      if (/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(String(ev.key)) && ev.stopPropagation) { ev.stopPropagation(); }
    }

    function attachBrand() {
      const brand = brandEl && brandEl.firstElementChild;
      if (!brand) { return; }
      toolbarEl.appendChild(brand);
      brand.addEventListener('click', () => post({ type: 'showAbout' }));
    }

    function pageCount() { return pdfDocument ? pdfDocument.numPages : 0; }
    function currentPage() { return pdfDocument && viewer ? viewer.currentPageNumber : 1; }

    function syncToolbar() {
      if (!tb) { return; }
      const count = pageCount();
      const page = currentPage();
      const has = count > 0 && phase === 'ready';
      const scale = has ? viewer.currentScale : 1;

      tb.setHidden('sidebar', !panels.some((p) => p.available));
      tb.setPressed('sidebar', sidebarOpen);
      tb.setDisabled('prev', !has || page <= 1);
      tb.setDisabled('next', !has || page >= count);
      tb.setDisabled('zoomOut', !has || scale <= VM.MIN_ZOOM + 1e-6);
      tb.setDisabled('zoomIn', !has || scale >= VM.MAX_ZOOM - 1e-6);
      tb.setDisabled('rotateCcw', !has);
      tb.setDisabled('rotateCw', !has);

      pageInput.disabled = !has;
      zoomSelect.disabled = !has;
      if (has) {
        const label = pageLabels && pageLabels[page - 1] != null ? String(pageLabels[page - 1]) : '';
        const showLabel = label !== '' && label !== String(page);
        pageInput.value = showLabel ? label : String(page);
        pageCountEl.textContent = showLabel ? '(' + page + ' of ' + count + ')' : 'of ' + count;
        const preset = viewer.currentScaleValue;
        if (SCALE_PRESETS.indexOf(preset) >= 0) {
          zoomSelect.value = preset;
          customOption.hidden = true;
        } else {
          const step = VM.ZOOM_STEPS.find((s) => Math.abs(s - scale) < 0.005);
          if (step !== undefined) {
            zoomSelect.value = String(step);
            customOption.hidden = true;
          } else {
            customOption.textContent = Math.round(scale * 100) + '%';
            customOption.hidden = false;
            zoomSelect.value = 'custom';
          }
        }
      } else {
        pageInput.value = '';
        pageCountEl.textContent = '';
      }

      extraItems.forEach((x) => {
        if (x.toggle) { tb.setPressed(x.id, !!x.state.pressed); }
        tb.setDisabled(x.id, !!x.state.disabled);
        tb.setHidden(x.id, !!x.state.hidden);
      });
      tools.forEach((t) => {
        const id = 'tool:' + t.id;
        tb.setHidden(id, t.editOnly && !editMode);
        tb.setDisabled(id, !has);
        if (!t.run) { tb.setPressed(id, activeTool === t.id); }
      });

      // The roving tab stop must sit on a button that can take focus, or Tab would skip the toolbar.
      const reachable = (b) => !b.hidden && !b.disabled;
      const stop = tb.buttons.find((b) => b.getAttribute('tabindex') === '0');
      if (!stop || !reachable(stop)) {
        const first = tb.buttons.find(reachable);
        if (first) { tb.buttons.forEach((b) => b.setAttribute('tabindex', b === first ? '0' : '-1')); }
      }
    }

    // ---------- navigation, zoom, rotation ----------

    function goToPage(number, announce) {
      if (!pdfDocument || phase !== 'ready') { return false; }
      const count = pageCount();
      const target = VM.clampPage(number - 1, count) + 1;
      viewer.currentPageNumber = target;
      if (announce) { OC.announce('Page ' + VM.pageStatus(target - 1, count, pageLabels)); }
      syncToolbar();
      return true;
    }
    function stepPage(delta) { return goToPage(currentPage() + delta, true); }

    function commitPageBox() {
      if (!pdfDocument || phase !== 'ready') { return; }
      const text = String(pageInput.value || '');
      const index = VM.parsePageBox(text, pageCount(), pageLabels);
      if (index < 0) {
        if (text.trim() !== '') { OC.hint('There is no page “' + text.trim().slice(0, 40) + '” in this PDF.'); }
        syncToolbar();
        return;
      }
      goToPage(index + 1, true);
    }

    function focusPageBox() {
      if (!pageInput || pageInput.disabled) { return; }
      if (pageInput.focus) { pageInput.focus(); }
      if (pageInput.select) { pageInput.select(); }
    }

    function setScaleValue(value, announce) {
      if (!pdfDocument || phase !== 'ready') { return; }
      const v = normaliseScaleValue(value, VM);
      if (!v) { return; }
      viewer.currentScaleValue = v;
      if (announce) { OC.announce('Zoom ' + Math.round(viewer.currentScale * 100) + '%'); }
      syncToolbar();
    }
    function zoomStep(dir) {
      if (!pdfDocument || phase !== 'ready') { return; }
      const cur = viewer.currentScale;
      setScaleValue(String(dir > 0 ? VM.zoomIn(cur) : VM.zoomOut(cur)), true);
    }
    function zoomReset() { setScaleValue(defaultScale, true); }

    function rotate(dir) {
      if (!pdfDocument || phase !== 'ready') { return; }
      const next = VM.rotateView(viewer.pagesRotation || 0, dir);
      viewer.pagesRotation = next;     // view only: never saved, never dirties the document
      OC.announce('View rotated to ' + next + ' degrees');
      syncToolbar();
    }

    function onWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) { return; }
      prevent(ev);                      // also keeps the webview itself from zooming
      if (!pdfDocument || phase !== 'ready' || !ev.deltaY) { return; }
      const cur = viewer.currentScale;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-ev.deltaY / 400)));
      const next = VM.zoomBy(cur, factor);
      if (Math.abs(next - cur) < 1e-4) { return; }
      if (typeof viewer.updateScale === 'function') {
        viewer.updateScale({ scaleFactor: next / cur, origin: [ev.clientX, ev.clientY], drawingDelay: 400 });
      } else {
        viewer.currentScaleValue = String(next);
      }
    }

    function onResize() {
      if (!pdfDocument || phase !== 'ready') { return; }
      const v = viewer.currentScaleValue;
      if (v === 'auto' || v === 'page-fit' || v === 'page-width') { viewer.currentScaleValue = v; }
      if (typeof viewer.update === 'function') { viewer.update(); }
    }

    // ---------- keyboard (spec §10.3) ----------

    /** A control that owns its own keys (typing, Space, arrows). */
    function isTextInput(node) {
      if (!node || !node.tagName) { return false; }
      const tag = String(node.tagName).toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || node.isContentEditable === true;
    }
    /** The page area (the scroll container), or nothing focused at all (focus on <body>). */
    function inPageArea(node) {
      return !node || node === document.body || node === document.documentElement || node === document
        || container.contains(node);
    }

    function scrollPages(dy) { container.scrollTop = container.scrollTop + dy; }

    function onKeyDown(ev) {
      if (ev.defaultPrevented) { return; }
      const key = ev.key;
      if (typeof key !== 'string') { return; }
      const ctrl = !!(ev.ctrlKey || ev.metaKey);
      const text = isTextInput(ev.target);
      const page = inPageArea(ev.target);

      for (const k of keys) {
        if (k.key !== key.toLowerCase() || k.ctrl !== ctrl || !!ev.altKey) { continue; }
        if (k.shift !== undefined && k.shift !== !!ev.shiftKey) { continue; }
        if (!k.ctrl && (text || !page)) { continue; }
        if (k.run(ev, shell) !== false) { prevent(ev); return; }
      }
      if (ev.altKey) { return; }

      if (ctrl) {
        switch (key) {
          case '=': case '+': zoomStep(1); break;
          case '-': case '_': zoomStep(-1); break;
          case '0': zoomReset(); break;
          case 'g': case 'G': focusPageBox(); break;
          default: return;
        }
        prevent(ev);
        return;
      }
      if (key === 'F4') { prevent(ev); setSidebarOpen(!sidebarOpen); return; }
      // Single-letter and navigation keys: only in the page area and never in a text input.
      if (text || !page) { return; }
      if (key === 'Escape') {
        if (activeTool) { prevent(ev); setTool(null); }
        return;
      }
      if (key.length === 1 && key !== ' ') {
        const t = tools.find((x) => x.key === key.toLowerCase() && !(x.editOnly && !editMode));
        if (t && phase === 'ready') {
          prevent(ev);
          if (t.run) { runTool(t); } else { setTool(t.id); }
          return;
        }
      }
      if (!pdfDocument || phase !== 'ready') { return; }
      const native = container.contains(ev.target);   // the focused scroll container scrolls by itself
      const pageStep = Math.max(LINE_PX, Math.round((container.clientHeight || 0) * 0.9));
      switch (key) {
        case 'r': case 'R': rotate(ev.shiftKey ? -1 : 1); break;
        case 'Home': goToPage(1, true); break;
        case 'End': goToPage(pageCount(), true); break;
        case 'ArrowLeft': case 'ArrowRight':
          if (container.scrollWidth > container.clientWidth) { return; }   // horizontal scrolling wins
          stepPage(key === 'ArrowLeft' ? -1 : 1);
          break;
        case 'ArrowUp': if (native) { return; } scrollPages(-LINE_PX); break;
        case 'ArrowDown': if (native) { return; } scrollPages(LINE_PX); break;
        case 'PageUp': if (native) { return; } scrollPages(-pageStep); break;
        case 'PageDown': if (native) { return; } scrollPages(pageStep); break;
        case ' ': if (native) { return; } scrollPages(ev.shiftKey ? -pageStep : pageStep); break;
        default: return;
      }
      prevent(ev);
    }

    // ---------- links (spec §7.5) and copy (spec §7.3) ----------

    function anchorFor(node) {
      for (let n = node; n && n !== main; n = n.parentNode) {
        if (n.tagName && String(n.tagName).toUpperCase() === 'A') { return n; }
      }
      return null;
    }

    function onLinkClick(ev) {
      const a = anchorFor(ev.target);
      if (!a) { return; }
      const href = a.getAttribute('href');
      if (href === null || href === undefined) { return; }
      prevent(ev);                                         // the webview never navigates
      const target = String(href).trim();
      if (target === '' || target.charAt(0) === '#') { return; }   // internal: pdf.js's own handler scrolls
      // VS Code's webview host page also listens for clicks on <a href> (without looking at
      // defaultPrevented) and opens http/https/mailto itself: stop the event here, in the capture
      // phase, so that the link is opened once, by the host's allow-listed `openLink`.
      if (ev.stopPropagation) { ev.stopPropagation(); }
      if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); }
      if (allowedScheme(target)) { post({ type: 'openLink', href: target }); }
      else { OC.hint(LINK_BLOCKED); }                      // javascript:, file:, Launch, GoToR, …: dropped
    }

    function onCopy(ev) {
      if (isTextInput(ev.target)) { return; }
      const sel = win.getSelection ? win.getSelection() : null;
      const raw = sel ? String(sel) : '';
      if (!raw || !sel.anchorNode || !main.contains(sel.anchorNode)) { return; }
      prevent(ev);
      if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); }
      let text = raw.replace(/\u0000/g, '');
      if (lib && typeof lib.normalizeUnicode === 'function') {
        try { text = lib.normalizeUnicode(text); } catch (e) { /* keep the selection text as is */ }
      }
      if (text.length > MAX_CLIPBOARD) { OC.hint('The selection is too large to copy.'); return; }
      post({ type: 'writeClipboard', text });
    }

    // ---------- sidebar frame (panels are registered by later scripts) ----------

    function ensurePanelDom(p) {
      if (p.tab) { return; }
      p.tab = mk('button', 'pdf-sidebar-tab', p.def.title);
      p.tab.setAttribute('type', 'button');
      p.tab.setAttribute('role', 'tab');
      p.tab.id = 'pdf-tab-' + p.id;
      p.tab.setAttribute('aria-controls', 'pdf-panel-' + p.id);
      p.tab.addEventListener('click', () => showPanel(p.id));
      p.el = mk('div', 'pdf-sidebar-panel');
      p.el.setAttribute('role', 'tabpanel');
      p.el.id = 'pdf-panel-' + p.id;
      p.el.setAttribute('aria-labelledby', 'pdf-tab-' + p.id);
      p.el.hidden = true;
    }

    function layoutPanels() {
      panels.sort((a, b) => a.order - b.order);
      panels.forEach((p) => {
        ensurePanelDom(p);
        tablistEl.appendChild(p.tab);    // re-appending moves: keeps DOM order = sort order
        panelsEl.appendChild(p.el);
      });
    }

    function availablePanels() { return panels.filter((p) => p.available); }

    /** The panel on show: the chosen one if this document has it, else the first available. */
    function currentPanel() {
      const avail = availablePanels();
      return avail.find((p) => p.id === activePanel) || avail[0] || null;
    }

    function updateSidebar() {
      const cur = currentPanel();
      const visible = sidebarOpen && !!cur;
      sidebarEl.hidden = !visible;
      panels.forEach((p) => {
        if (!p.tab) { return; }
        const selected = p === cur;
        p.tab.hidden = !p.available;
        p.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        p.tab.setAttribute('tabindex', selected ? '0' : '-1');
        p.el.hidden = !selected;
        const show = visible && selected;
        if (show && !p.mounted) {
          p.mounted = true;
          try { p.def.mount(p.el, shell); } catch (e) { warn('panel', p.id, 'failed to mount:', e && e.message); }
        }
        if (show !== p.shown) {
          p.shown = show;
          const hook = show ? p.def.onShow : p.def.onHide;
          if (p.mounted && typeof hook === 'function') {
            try { hook.call(p.def, shell); } catch (e) { warn('panel', p.id, 'hook failed:', e && e.message); }
          }
        }
      });
      syncToolbar();
    }

    /**
     * Re-evaluates one panel's (or every panel's) `isAvailable` for the current document. The
     * sidebar is updated once, after every asynchronous answer is in, so that a panel is never
     * mounted just because a better choice was still being worked out.
     */
    function refreshPanels(only) {
      const token = loadToken;
      const waits = [];
      (only ? [only] : panels).forEach((p) => {
        let r = true;
        if (typeof p.def.isAvailable === 'function') {
          try { r = p.def.isAvailable(pdfDocument, shell); } catch (e) { r = false; }
        }
        if (r && typeof r.then === 'function') {
          waits.push(r.then((ok) => { if (token === loadToken) { p.available = !!ok; } },
            () => { if (token === loadToken) { p.available = false; } }));
        } else {
          p.available = !!r;
        }
      });
      if (!waits.length) { updateSidebar(); return; }
      Promise.all(waits).then(() => { if (token === loadToken) { updateSidebar(); } });
    }

    function setSidebarOpen(open) {
      sidebarOpen = !!open;
      updateSidebar();
      persist();
      const cur = currentPanel();
      emit('sidebar', { open: sidebarOpen, panel: cur ? cur.id : null });
    }

    function showPanel(id) {
      const p = panels.find((x) => x.id === id);
      if (!p || !p.available) { return false; }
      activePanel = id;
      sidebarOpen = true;
      updateSidebar();
      persist();
      emit('sidebar', { open: true, panel: id });
      return true;
    }

    function onTabKey(ev) {
      const avail = availablePanels();
      if (!avail.length) { return; }
      const pos = Math.max(0, avail.indexOf(currentPanel()));
      let next = null;
      switch (ev.key) {
        case 'ArrowRight': case 'ArrowDown': next = avail[(pos + 1) % avail.length]; break;
        case 'ArrowLeft': case 'ArrowUp': next = avail[(pos - 1 + avail.length) % avail.length]; break;
        case 'Home': next = avail[0]; break;
        case 'End': next = avail[avail.length - 1]; break;
        default: return;
      }
      prevent(ev);
      if (ev.stopPropagation) { ev.stopPropagation(); }
      showPanel(next.id);
      if (next.tab.focus) { next.tab.focus(); }
    }

    function registerPanel(def) {
      if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.id) || typeof def.title !== 'string'
        || typeof def.mount !== 'function') {
        throw new Error('registerPanel needs { id, title, mount(el, shell) }');
      }
      if (panels.some((p) => p.id === def.id)) { throw new Error('Panel already registered: ' + def.id); }
      const p = { id: def.id, def, order: typeof def.order === 'number' ? def.order : 100,
        available: false, mounted: false, shown: false, tab: null, el: null };
      panels.push(p);
      if (started) { layoutPanels(); refreshPanels(p); }
      return {
        refresh() { refreshPanels(p); },
        show() { return showPanel(p.id); },
        isShown() { return p.shown; },
        get element() { return p.el; },
      };
    }

    // ---------- tools, toolbar items, keys ----------

    function registerTool(def) {
      if (!def || typeof def.id !== 'string' || typeof def.label !== 'string'
        || (typeof def.run !== 'function' && typeof def.activate !== 'function')) {
        throw new Error('registerTool needs { id, label, activate(shell) + deactivate(shell) } or { id, label, run(shell) }');
      }
      if (tools.some((t) => t.id === def.id)) { throw new Error('Tool already registered: ' + def.id); }
      tools.push({
        id: def.id, label: def.label, title: def.title || def.label, order: typeof def.order === 'number' ? def.order : 100,
        key: typeof def.key === 'string' && def.key.length === 1 ? def.key.toLowerCase() : null,
        editOnly: def.editOnly !== false, run: def.run || null, activate: def.activate || null, deactivate: def.deactivate || null,
      });
      tools.sort((a, b) => a.order - b.order);
      if (started) { buildToolbar(); }
    }

    function runTool(t) {
      try { t.run(shell); } catch (e) { warn('tool', t.id, 'failed:', e && e.message); }
    }

    function setTool(id) {
      const next = id === null || id === undefined ? null : tools.find((t) => t.id === id && !t.run);
      if (id !== null && id !== undefined && !next) { return false; }
      if (next && next.editOnly && !editMode) { return false; }
      const nextId = next ? next.id : null;
      if (nextId === activeTool) { return true; }
      const prev = tools.find((t) => t.id === activeTool);
      activeTool = nextId;
      if (prev && prev.deactivate) { try { prev.deactivate(shell); } catch (e) { warn('tool', prev.id, 'failed:', e && e.message); } }
      if (next && next.activate) { try { next.activate(shell); } catch (e) { warn('tool', next.id, 'failed:', e && e.message); } }
      syncToolbar();
      emit('toolchange', { tool: activeTool });
      return true;
    }

    function registerToolbarItems(items) {
      const handles = {};
      (Array.isArray(items) ? items : [items]).forEach((it) => {
        if (!it || typeof it.id !== 'string' || typeof it.label !== 'string') {
          throw new Error('registerToolbarItems needs [{ id, label, title?, toggle?, pressed?, disabled?, hidden?, order?, onClick }]');
        }
        if (extraItems.some((x) => x.id === it.id) || it.id.indexOf('tool:') === 0
          || ['sidebar', 'prev', 'next', 'zoomOut', 'zoomIn', 'rotateCcw', 'rotateCw', 'openExternally'].indexOf(it.id) >= 0) {
          throw new Error('Toolbar item id already in use: ' + it.id);
        }
        const x = {
          id: it.id, label: it.label, title: it.title || it.label, toggle: !!it.toggle,
          order: typeof it.order === 'number' ? it.order : 100,
          state: { pressed: !!it.pressed, disabled: !!it.disabled, hidden: !!it.hidden },
        };
        x.onClick = (pressed) => {
          if (x.toggle) { x.state.pressed = !!pressed; }
          if (typeof it.onClick === 'function') { it.onClick(pressed, shell); }
        };
        extraItems.push(x);
        handles[it.id] = {
          setPressed(v) { x.state.pressed = !!v; syncToolbar(); },
          setDisabled(v) { x.state.disabled = !!v; syncToolbar(); },
          setHidden(v) { x.state.hidden = !!v; syncToolbar(); },
          get button() { return tb ? tb.button(x.id) : null; },
        };
      });
      extraItems.sort((a, b) => a.order - b.order);
      if (started) { buildToolbar(); }
      return handles;
    }

    function registerKey(spec, run) {
      if (!spec || typeof spec.key !== 'string' || typeof run !== 'function') {
        throw new Error('registerKey needs ({ key, ctrl?, shift? }, run(event, shell))');
      }
      const k = { key: spec.key.toLowerCase(), ctrl: !!spec.ctrl, shift: spec.shift === undefined ? undefined : !!spec.shift, run };
      keys.push(k);
      return () => { const i = keys.indexOf(k); if (i >= 0) { keys.splice(i, 1); } };
    }

    // ---------- password box (spec §9.1) ----------

    function buildPassword() {
      passwordEl = mk('div', 'pdf-password');
      passwordEl.setAttribute('role', 'group');
      passwordEl.setAttribute('aria-labelledby', 'pdf-password-label');
      passwordEl.hidden = true;
      const label = mk('label', 'pdf-password-label', PASSWORD_PROMPT);
      label.id = 'pdf-password-label';
      label.setAttribute('for', 'pdf-password-input');
      pwInput = mk('input', 'pdf-password-input');
      pwInput.id = 'pdf-password-input';
      pwInput.setAttribute('type', 'password');
      pwInput.setAttribute('autocomplete', 'off');
      pwInput.setAttribute('spellcheck', 'false');
      pwInput.setAttribute('aria-describedby', 'pdf-password-error');
      pwError = mk('div', 'pdf-password-error', '');
      pwError.id = 'pdf-password-error';
      pwError.setAttribute('role', 'alert');
      pwError.hidden = true;
      const row = mk('div', 'pdf-password-actions');
      const ok = mk('button', 'office-btn office-btn-primary', 'Open');
      ok.setAttribute('type', 'button');
      ok.setAttribute('data-action', 'submit');
      ok.addEventListener('click', submitPassword);
      const cancel = mk('button', 'office-btn', 'Cancel');
      cancel.setAttribute('type', 'button');
      cancel.setAttribute('data-action', 'cancel');
      cancel.addEventListener('click', cancelPassword);
      row.appendChild(ok);
      row.appendChild(cancel);
      passwordEl.addEventListener('keydown', (ev) => {
        if (ev.stopPropagation) { ev.stopPropagation(); }    // no viewer shortcut while the box is up
        if (ev.key === 'Enter' && ev.target === pwInput) { prevent(ev); submitPassword(); }
        else if (ev.key === 'Escape') { prevent(ev); cancelPassword(); }
      });
      [label, pwInput, pwError, row].forEach((n) => passwordEl.appendChild(n));
    }

    function showPassword(incorrect) {
      phase = 'password';
      pwInput.value = '';
      pwError.textContent = incorrect ? TEXT.passwordIncorrect : '';
      pwError.hidden = !incorrect;
      if (incorrect) { pwInput.setAttribute('aria-invalid', 'true'); } else { pwInput.setAttribute('aria-invalid', 'false'); }
      container.hidden = true;
      passwordEl.hidden = false;
      // Take the caret only when this webview already has the focus.
      if (pwInput.focus && (!document.hasFocus || document.hasFocus())) { pwInput.focus(); }
      syncToolbar();
    }

    function hidePassword() {
      pwInput.value = '';
      passwordEl.hidden = true;
      if (container) { container.hidden = false; }
    }

    function submitPassword() {
      const update = pwUpdate;
      const value = String(pwInput.value || '');
      if (!update || value === '') { return; }
      pwUpdate = null;
      candidate = value;
      passwordSubmitted = true;
      hidePassword();
      phase = 'loading';
      update(value);
    }

    function cancelPassword() {
      const update = pwUpdate;
      if (!update) { return; }
      pwUpdate = null;
      passwordCancelled = true;
      hidePassword();
      phase = 'loading';
      update(new Error('No password given'));
    }

    function onPassword(token, update, reason) {
      if (token !== loadToken) { update(new Error('Superseded by a newer load')); return; }
      passwordAsked = true;
      const incorrect = reason === lib.PasswordResponses.INCORRECT_PASSWORD;
      // A reload of the same tab (the file changed on disk): try the password that opened it.
      if (!incorrect && rememberedPassword !== null && !triedRemembered) {
        triedRemembered = true;
        candidate = rememberedPassword;
        update(rememberedPassword);
        return;
      }
      if (incorrect && !passwordSubmitted) { rememberedPassword = null; }   // the remembered one no longer fits
      pwUpdate = update;
      showPassword(incorrect && passwordSubmitted);
    }

    // ---------- pdf.js boot ----------

    function ensureEngine() {
      if (viewer) { return; }
      lib = win.PdfjsBundle.pdfjsLib;
      V = win.PdfjsBundle.pdfjsViewer;
      if (annotationMode === null) { annotationMode = lib.AnnotationMode.ENABLE_STORAGE; }
      eventBus = new V.EventBus();
      linkService = new V.PDFLinkService({ eventBus, externalLinkRel: 'noopener noreferrer nofollow' });
      findController = new V.PDFFindController({ eventBus, linkService });
      wireBus();
      buildPdfViewer();
    }

    /**
     * One PDFViewer per annotation mode. No `l10n` (the viewer creates its own, with no fetch), no
     * scripting manager, no `enableScripting`; pdf.js's annotation editor UI is disabled.
     */
    function buildPdfViewer() {
      if (viewerAbort) { viewerAbort.abort(); newContainer(); }
      viewerAbort = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      const options = {
        container, viewer: viewerDiv, eventBus, linkService, findController,
        imageResourcesPath: baseUrl + 'images/',
        textLayerMode: 1,
        annotationMode,
        annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      };
      if (viewerAbort) { options.abortSignal = viewerAbort.signal; }
      viewer = new V.PDFViewer(options);
      linkService.setViewer(viewer);
    }

    /**
     * §10.2: every page container is a landmark named "Page N of M" (pdf.js leaves the name to its
     * l10n, which this viewer does not use). Names are numbers only: page labels are document text
     * and stay out of attributes.
     */
    function labelPages() {
      const count = pageCount();
      if (!viewer || typeof viewer.getPageView !== 'function') { return; }
      for (let i = 0; i < count; i++) {
        const pv = viewer.getPageView(i);
        const div = pv && pv.div;
        if (div && typeof div.setAttribute === 'function') {
          // pdf.js names the page through its l10n id ("Page ⁨N⁩" with bidi marks); ours is plain text.
          if (typeof div.removeAttribute === 'function') { div.removeAttribute('data-l10n-id'); div.removeAttribute('data-l10n-args'); }
          div.setAttribute('role', 'region');
          div.setAttribute('aria-label', 'Page ' + (i + 1) + ' of ' + count);
        }
      }
    }

    function wireBus() {
      eventBus.on('pagesinit', () => {
        labelPages();
        const v = pendingView || {};
        pendingView = null;
        viewer.currentScaleValue = v.scale || defaultScale;
        if (v.rotation) { viewer.pagesRotation = v.rotation; }
        const count = pageCount();
        const page = VM.clampPage((v.page || 1) - 1, count) + 1;
        if (page > 1 || typeof v.top === 'number') {
          const dest = typeof v.top === 'number' && typeof v.left === 'number' && page === (v.page || 1)
            ? [null, { name: 'XYZ' }, v.left, v.top, null] : undefined;
          viewer.scrollPageIntoView({ pageNumber: page, destArray: dest });
        }
        syncToolbar();
      });
      eventBus.on('pagechanging', (e) => { syncToolbar(); emit('pagechanging', { pageNumber: e.pageNumber }); });
      eventBus.on('scalechanging', (e) => {
        // pdf.js allows 10 %–2500 %; the viewer's range is the one of pdfViewMath (25 %–500 %).
        const clamped = VM.clampZoom(e.scale);
        if (Math.abs(clamped - e.scale) > 1e-6) { viewer.currentScaleValue = String(clamped); return; }
        syncToolbar();
        emit('scalechanging', { scale: e.scale, presetValue: e.presetValue });
      });
      eventBus.on('rotationchanging', (e) => { syncToolbar(); emit('rotationchanging', { pagesRotation: e.pagesRotation }); });
      eventBus.on('updateviewarea', (e) => {
        const loc = e && e.location;
        if (!loc || phase !== 'ready') { return; }
        view = cleanView({
          page: loc.pageNumber, scale: viewer.currentScaleValue || String(viewer.currentScale),
          rotation: loc.rotation, left: loc.left, top: loc.top,
        });
        persist();
      });
      eventBus.on('pagerendered', onPageRendered);
      eventBus.on('textlayerrendered', (e) => {
        emit('textlayerrendered', { pageNumber: e.pageNumber, pageView: e.source, div: e.source && e.source.div });
      });
    }

    function onPageRendered(e) {
      const pageView = e.source;
      const div = pageView && pageView.div;
      if (div) {
        const old = [];
        for (let n = div.firstChild; n; n = n.nextSibling) { if (n.className === 'pdf-page-error') { old.push(n); } }
        old.forEach((n) => div.removeChild(n));
        if (e.error) {
          // §9.4: that page says so; the rest of the document works.
          const note = mk('div', 'pdf-page-error', TEXT.pageFailed);
          note.setAttribute('role', 'note');
          div.appendChild(note);
          warn('page', e.pageNumber, 'failed to render:', e.error && e.error.message);
          hostLog('warn', 'page-render-failed', 'page ' + e.pageNumber + ': ' + String((e.error && e.error.name) || 'Error').slice(0, 60), 'page ' + e.pageNumber);
        }
      }
      emit('pagerendered', {
        pageNumber: e.pageNumber, pageView, div, error: e.error || null,
        cssTransform: !!e.cssTransform, isDetailView: !!e.isDetailView,
      });
    }

    /**
     * The pdf.js worker, made from a blob of the worker file's text (CSP `worker-src blob:`) and
     * handed over as `workerPort`, so that a missing worker is an error here rather than pdf.js's
     * silent main-thread fallback.
     */
    function ensureWorker() {
      if (!workerPromise) {
        workerPromise = (async () => {
          const url = baseUrl + WORKER_FILE + (cacheBust ? '?v=' + encodeURIComponent(cacheBust) : '');
          const res = await win.fetch(url);
          if (!res.ok) { throw new Error('The PDF engine file could not be read (HTTP ' + res.status + ').'); }
          const text = await res.text();
          const blobUrl = win.URL.createObjectURL(new win.Blob([text], { type: 'text/javascript' }));
          if (worker) {   // an earlier worker that died: its document was closed before this load
            try { worker.terminate(); } catch (e) { /* already gone */ }
          }
          const w = new win.Worker(blobUrl, { type: 'module' });
          w.addEventListener('error', (ev) => onWorkerError(w, ev));
          lib.GlobalWorkerOptions.workerPort = w;
          worker = w;
        })();
        workerPromise.catch(() => { workerPromise = null; });
      }
      return workerPromise;
    }

    function onWorkerError(w, ev) {
      warn('worker error:', ev && ev.message);
      if (w !== worker) { return; }
      // The cached worker may be dead: the next load (Retry, reload) creates a new one.
      workerPromise = null;
      if (phase !== 'loading' && phase !== 'password') { return; }
      // The worker never came up: nothing would ever answer. Report instead of waiting for ever.
      // Not the engine check (that passed): shown as the unexpected-error view, with the reason.
      loadToken++;
      void closeDocument();
      showFailure(TEXT.damaged, 'The PDF engine could not start: ' + ((ev && ev.message) || 'worker error'), ['openExternally', 'retry']);
    }

    // ---------- loading ----------

    function showFailure(title, detail, actions) {
      phase = 'failed';
      hidePassword();
      OC.showError({ title, detail: detail || '', actions });
      syncToolbar();
    }

    function showEngineError() {
      showFailure(TEXT.engineTooOld, 'Missing: ' + engineMissing.join(', '), ['openExternally']);
    }

    async function closeDocument() {
      const task = loadingTask;
      const had = !!pdfDocument;
      loadingTask = null;
      pdfDocument = null;
      pageLabels = null;
      pwUpdate = null;
      loggedOnce.clear();   // a new document may report the same things again
      if (activeTool) { setTool(null); }
      if (viewer) {
        try { viewer.setDocument(null); } catch (e) { warn('closing the view failed:', e && e.message); }
        linkService.setDocument(null, null);
      }
      if (had) { notifyDocument(); }
      if (task) {
        try { await task.destroy(); } catch (e) { /* already gone */ }
      }
    }

    function notifyDocument() {
      panels.forEach((p) => {
        if (typeof p.def.onDocument === 'function') {
          try { p.def.onDocument(pdfDocument, shell); } catch (e) { warn('panel', p.id, 'failed:', e && e.message); }
        }
      });
      refreshPanels();
      emit(pdfDocument ? 'documentloaded' : 'documentclosed', { pdfDocument, generation, version });
    }

    async function load(msg) {
      const token = ++loadToken;
      generation = msg.generation;
      version = typeof msg.version === 'number' ? msg.version : version;
      if (pdfDocument && view) { pendingView = view; }     // a reload keeps the place
      phase = 'loading';
      candidate = null; triedRemembered = false;
      passwordAsked = false; passwordSubmitted = false; passwordCancelled = false;
      hidePassword();
      syncToolbar();

      let task = null;
      try {
        ensureEngine();
        await closeDocument();
        if (token !== loadToken) { return; }
        await ensureWorker();
        if (token !== loadToken) { return; }
        task = lib.getDocument(documentOptions(toBytes(msg.bytes), baseUrl));
      } catch (e) {
        if (token !== loadToken) { return; }
        // The engine check passed (showEngineError is the only "needs a newer VS Code" view): any
        // other exception before pdf.js has the bytes is the unexpected-error view, with the reason.
        showFailure(TEXT.damaged, 'The PDF engine could not start: ' + ((e && e.message) || String(e)), ['openExternally', 'retry']);
        return;
      }
      loadingTask = task;
      task.onPassword = (update, reason) => onPassword(token, update, reason);

      let pdf;
      try {
        pdf = await task.promise;
      } catch (e) {
        if (token !== loadToken) { return; }
        loadingTask = null;
        try { await task.destroy(); } catch (e2) { /* already gone */ }
        if (token !== loadToken) { return; }
        if (passwordCancelled) { showFailure(TEXT.passwordCancelled, '', ['openExternally', 'retry']); }
        else { showFailure(TEXT.damaged, (e && e.name ? e.name + ': ' : '') + ((e && e.message) || String(e)), ['openExternally', 'retry']); }
        return;
      }
      if (token !== loadToken) {
        try { await task.destroy(); } catch (e) { /* already gone */ }
        return;
      }

      hidePassword();
      if (passwordAsked && candidate !== null) { rememberedPassword = candidate; }
      candidate = null;
      // Fallback detection: the document must be served by our worker, not a main-thread fake one.
      workerIsOurs = !!(task._worker && task._worker.port === worker) && !win.pdfjsWorker;
      if (!workerIsOurs) { warn('pdf.js is not using the dedicated worker (main-thread fallback).');
        hostLog('warn', 'worker-fallback', '', 'w' + generation);
      }

      pdfDocument = pdf;
      phase = 'ready';
      viewer.setDocument(pdf);
      linkService.setDocument(pdf, null);
      syncToolbar();
      notifyDocument();

      Promise.resolve().then(() => pdf.getPageLabels()).then((labels) => {
        if (token !== loadToken || !Array.isArray(labels)) { return; }
        pageLabels = labels;
        if (typeof viewer.setPageLabels === 'function') { viewer.setPageLabels(labels); }
        syncToolbar();
      }, () => { /* no labels */ });

      const factsGeneration = msg.generation;
      collectFacts(pdf, { passwordUsed: passwordAsked }).then((facts) => {
        if (token !== loadToken) { return; }
        post({ type: 'pdfFacts', generation: factsGeneration, facts });
        emit('facts', facts);
      }, (e) => warn('facts failed:', e && e.message));
    }

    /** Switches the annotation layer mode (ENABLE_STORAGE for viewing, ENABLE_FORMS while filling) without a reload. */
    function setAnnotationMode(mode) {
      if (mode === annotationMode) { return; }
      annotationMode = mode;
      if (!viewer) { return; }
      const pdf = pdfDocument;
      if (pdf && view) { pendingView = view; }
      try { viewer.setDocument(null); } catch (e) { warn('closing the view failed:', e && e.message); }
      buildPdfViewer();
      if (pdf) {
        viewer.setDocument(pdf);
        if (pageLabels && typeof viewer.setPageLabels === 'function') { viewer.setPageLabels(pageLabels); }
      }
      emit('viewerchanged', { viewer, container, annotationMode });
    }

    // ---------- host messages ----------

    function onMessage(msg) {
      switch (msg.type) {
        case 'init':
          fileName = typeof msg.fileName === 'string' ? msg.fileName : '';
          if (engineMissing.length) { showEngineError(); break; }
          // Asked after every init (first load, Retry, reload on an external change) and only
          // once the engine check has passed: an engine that is too old never receives the bytes.
          post({ type: 'pdfRequestDocument' });
          break;
        case 'loadError':
          loadToken++;
          phase = 'idle';
          hidePassword();
          void closeDocument();
          syncToolbar();
          break;
        case 'pdfDocument': {
          if (engineMissing.length) { break; }
          const g = msg.generation;
          if (typeof g !== 'number' || !isFinite(g)) { break; }
          if (g < generation || (g === generation && phase !== 'idle')) { break; }   // stale or already loading/shown
          void load(msg);
          break;
        }
        case 'flushPendingEdits':
          if (flushHandler) { flushHandler(msg.flushId); } else { post({ type: 'flushed', flushId: msg.flushId }); }
          break;
        default: break;
      }
      emit('message', msg);
    }

    function onEditModeToggle(on) {
      const next = !!on;
      if (next === editMode) { return; }
      editMode = next;
      const t = tools.find((x) => x.id === activeTool);
      if (!editMode && t && t.editOnly) { setTool(null); }
      syncToolbar();
      emit('editmode', { editMode });
    }

    // ---------- start ----------

    function start() {
      if (started) { return; }
      started = true;
      // §12: a file that needs a source the CSP does not list must be noticed, not silently degraded.
      document.addEventListener('securitypolicyviolation', (e) => {
        const v = {
          directive: String(e.effectiveDirective || e.violatedDirective || ''),
          blocked: String(e.blockedURI || '').slice(0, 200),
        };
        hostLog('warn', 'csp-violation', v.directive + ' ' + stripUrl(v.blocked));
        if (violations.length < MAX_VIOLATIONS) { violations.push(v); }
        if (win.console && win.console.error) { win.console.error('[PdfViewer] CSP violation', v.directive, v.blocked); }
        emit('cspviolation', v);
      });

      restoreState();
      buildLayout();
      layoutPanels();
      buildToolbar();
      attachBrand();
      refreshPanels();

      main.addEventListener('click', onLinkClick, true);
      main.addEventListener('auxclick', onLinkClick, true);
      main.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('copy', onCopy, true);
      win.addEventListener('keydown', onKeyDown);
      win.addEventListener('resize', onResize);
      if (typeof win.ResizeObserver === 'function') { new win.ResizeObserver(onResize).observe(main); }

      engineMissing = engineProblems(win);
      OC.init({ vscode, onEditModeToggle, onMessage });
    }

    // ---------- shell API (plan PWP-08; used by PWP-09, 10, 11, 22–29) ----------

    const shell = {
      start,
      // registration: call at script load (the shell starts on DOMContentLoaded); later calls also work
      registerPanel, registerTool, registerToolbarItems, registerKey,
      /** cb({ pageNumber, pageView, div, error, cssTransform, isDetailView }) after every page render. Returns an unsubscribe function. */
      onPagesRendered(cb) { return on('pagerendered', cb); },
      /** Shell events: documentloaded, documentclosed, pagerendered, textlayerrendered, pagechanging, scalechanging,
       *  rotationchanging, viewerchanged, editmode, toolchange, sidebar, facts, cspviolation, message (every host message). */
      on,
      // pdf.js objects (null until the first document; `viewer`/`container` change on `viewerchanged`)
      get lib() { return lib; },
      get viewerLib() { return V; },
      get eventBus() { return eventBus; },
      get linkService() { return linkService; },
      get findController() { return findController; },
      get viewer() { return viewer; },
      get pdfDocument() { return pdfDocument; },
      get pageLabels() { return pageLabels; },
      get container() { return container; },
      get main() { return main; },
      get annotationMode() { return annotationMode; },
      // state
      get phase() { return phase; },
      get generation() { return generation; },
      get version() { return version; },
      get fileName() { return fileName; },
      get editMode() { return editMode; },
      get activeTool() { return activeTool; },
      get pageCount() { return pageCount(); },
      get currentPage() { return currentPage(); },
      // actions
      post, goToPage, setScaleValue, zoomStep, zoomReset, rotate, setTool, setAnnotationMode,
      showPanel, setSidebarOpen,
      get sidebarOpen() { return sidebarOpen; },
      announce(text) { OC.announce(text); },
      hint(text) { OC.hint(text); },
      /** Per-script state kept with the view state in `vscode.setState` (JSON-serialisable values). */
      getState(key) { return Object.prototype.hasOwnProperty.call(moduleState, key) ? moduleState[key] : undefined; },
      setState(key, value) { moduleState[key] = value; persist(); },
      /** The edit PWPs take over `flushPendingEdits`; until then it is answered at once. */
      setFlushHandler(fn) { flushHandler = typeof fn === 'function' ? fn : null; },
      diagnostics() {
        return { phase, generation, engineMissing: engineMissing.slice(), workerIsOurs, cspViolations: violations.slice() };
      },
    };
    return shell;
  }

  const api = {
    create, engineProblems, documentOptions, collectFacts, toBytes, normaliseScaleValue, allowedScheme,
    TEXT, ALLOWED_SCHEMES, SCALE_PRESETS,
  };
  global.PdfViewer = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

  // Inside the webview (the test sandbox defines no acquireVsCodeApi): create the shell now so the
  // scripts loaded after this one can register, and start once every script has run.
  if (typeof global.acquireVsCodeApi === 'function' && global.document && global.document.getElementById('office-content')) {
    const shell = create({
      window: global, document: global.document, vscode: global.acquireVsCodeApi(),
      OfficeCommon: global.OfficeCommon, PdfViewMath: global.PdfViewMath,
    });
    global.PdfViewerShell = shell;
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', () => shell.start(), { once: true });
    } else {
      shell.start();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
