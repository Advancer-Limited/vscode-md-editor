// Word viewer webview (spec §7.1, §11, §12). Renders the original package bytes with docx-preview,
// adds zoom / section count / Open in Word to the toolbar, and intercepts links.
//
// Rendering (spec §8.2, §8.8): each render goes into a detached container, is mapped to block ids
// with media/docxMap.js and is swapped in, keeping the block nearest the viewport top where it was.
// When media/docxEdit.js is loaded (Word editing), its controller sees every host message first and
// gates rendering: no render runs or swaps while a paragraph island is open.
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
    const DocxMapLib = deps.DocxMap || global.DocxMap || null;
    const DocxEditLib = deps.DocxEdit || global.DocxEdit || null;
    const IslandLib = deps.DocxIsland || global.DocxIsland || null;
    let edit = null;          // WP-34 edit controller (null in a build without docxEdit.js)
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

    let styles = mk('div', 'docx-styles');
    let host = mk('div', 'docx-host');
    let mapping = null;      // DocxMap.mapBlocks result for the DOM shown
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
        // Edit tools (spec §8.8, WP-35): shown only when the document can be edited, enabled only
        // while a paragraph island is open (the caret paragraph is what they act on).
        { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', toggle: true, pressed: false, disabled: true,
          onClick: () => toggleFormat('b') },
        { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', toggle: true, pressed: false, disabled: true,
          onClick: () => toggleFormat('i') },
        { id: 'underline', label: 'U', title: 'Underline (Ctrl+U)', toggle: true, pressed: false, disabled: true,
          onClick: () => toggleFormat('u') },
        { id: 'style', label: 'Style', title: 'Paragraph style', disabled: true, onClick: () => toggleStyleMenu() },
        { id: 'bullets', label: 'Bullets', title: 'Bullets (Ctrl+Shift+8)', toggle: true, pressed: false, disabled: true,
          onClick: () => toggleList('bullet') },
        { id: 'numbering', label: 'Numbering', title: 'Numbering (Ctrl+Shift+7)', toggle: true, pressed: false, disabled: true,
          onClick: () => toggleList('number') },
        { id: 'outdent', label: 'Outdent', title: 'Outdent (Shift+Tab at the start of a list item)', disabled: true,
          onClick: () => changeLevel(-1) },
        { id: 'indent', label: 'Indent', title: 'Indent (Tab at the start of a list item)', disabled: true,
          onClick: () => changeLevel(1) },
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
      EDIT_TOOL_IDS.forEach((id) => tb.setHidden(id, true));
      tb.button('style').setAttribute('aria-haspopup', 'menu');
      tb.button('style').setAttribute('aria-expanded', 'false');
      // Keep the caret and the island focused when a tool is clicked with the mouse.
      toolbarEl.addEventListener('mousedown', (ev) => {
        const t = ev.target;
        if (edit && edit.islandElement() && t && t.tagName === 'BUTTON' && ev.preventDefault) { ev.preventDefault(); }
      });
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

    /**
     * JSZip (inside docx-preview) only accepts Uint8Array/ArrayBuffer/Blob/string. Normalise whatever
     * the message carried: a typed-array view of another kind, or a plain object/array of byte values
     * (how a non-plain view can arrive after structured cloning).
     */
    function toBytes(data) {
      const tag = Object.prototype.toString.call(data);   // realm-independent, unlike instanceof
      if (tag === '[object Uint8Array]' || tag === '[object ArrayBuffer]') return data;
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (Array.isArray(data)) return Uint8Array.from(data);
      if (data && typeof data === 'object') {
        if (Array.isArray(data.data)) return Uint8Array.from(data.data);   // { type: 'Buffer', data: [...] }
        const n = Object.keys(data).length;
        if (n > 0 && typeof data[0] === 'number') return Uint8Array.from({ length: n }, (_, i) => data[i]);
      }
      throw new Error('The document data did not arrive in a readable form.');
    }

    /** Block nearest the top of the viewport and its offset from it, or null. */
    function captureAnchor() {
      if (!mapping || !mapping.byId || typeof content.getBoundingClientRect !== 'function') { return null; }
      const top = content.getBoundingClientRect().top;
      for (const [id, ps] of mapping.byId) {
        const p = ps.find((x) => !x.hidden && x.parentNode && typeof x.getBoundingClientRect === 'function');
        if (!p) { continue; }
        const r = p.getBoundingClientRect();
        if (r && r.bottom > top) { return { id, delta: r.top - top }; }
      }
      return null;
    }

    function restoreAnchor(anchor, scrollTop) {
      const ps = anchor && mapping && mapping.byId ? mapping.byId.get(anchor.id) : null;
      if (!ps || !ps.length || typeof ps[0].getBoundingClientRect !== 'function') { content.scrollTop = scrollTop; return; }
      const top = content.getBoundingClientRect().top;
      content.scrollTop = scrollTop + (ps[0].getBoundingClientRect().top - top - anchor.delta);
    }

    function gateFor(job) { return edit ? edit.gate(job) : 'go'; }

    /** Renders one job into a detached container, then swaps it in. 'held' when the gate closed meanwhile. */
    async function doRender(job) {
      const nextHost = mk('div', 'docx-host');
      const nextStyles = mk('div', 'docx-styles');
      try {
        if (!docxLib || typeof docxLib.renderAsync !== 'function') {
          throw new Error('The Word renderer did not load.');
        }
        await docxLib.renderAsync(toBytes(job.bytes), nextHost, nextStyles, RENDER_OPTIONS);
      } catch (e) {
        showRenderFailure(e);
        return 'done';
      }
      const g = gateFor(job);
      if (g === 'hold') { return 'held'; }
      if (g === 'drop') { if (edit) { edit.onDropped(job); } return 'done'; }
      const nextMapping = DocxMapLib ? DocxMapLib.mapBlocks(nextHost, job.blocks) : { byId: new Map(), missing: [] };
      const scrollTop = content.scrollTop;
      const anchor = captureAnchor();
      content.insertBefore(nextStyles, styles);
      content.removeChild(styles);
      content.insertBefore(nextHost, host);
      content.removeChild(host);
      styles = nextStyles;
      host = nextHost;
      mapping = nextMapping;
      renderFailed = false;
      sectionCount = countSections();
      applyZoom();
      restoreAnchor(anchor, scrollTop);
      if (edit) { edit.onRendered(mapping, job); }
      return 'done';
    }

    function showRenderFailure(e) {
      renderFailed = true;
      clear(host);
      clear(styles);
      mapping = null;
      sectionCount = 0;
      syncToolbar();
      OfficeCommon.showError({
        title: 'This document can’t be displayed.',
        detail: (e && e.message) ? String(e.message) : String(e),
        actions: ['openExternally'],
      });
    }

    /**
     * Renders `bytes`; a render requested while one runs replaces any older queued one. While the
     * edit controller's gate says 'hold' the newest job waits until `resume()`.
     */
    function render(bytes, blocks, version) {
      queued = { bytes, blocks: Array.isArray(blocks) ? blocks : [], version };
      pump();
    }

    function pump() {
      if (rendering || !queued || gateFor(queued) === 'hold') { return; }
      rendering = true;
      (async () => {
        try {
          while (queued && gateFor(queued) !== 'hold') {
            const job = queued;
            queued = null;
            if (gateFor(job) === 'drop') { if (edit) { edit.onDropped(job); } continue; }
            const r = await doRender(job);
            if (r === 'held' && !queued) { queued = job; }
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
      // VS Code's webview host page posts its own `did-click-link` for any <a href> click that reaches
      // it, whether or not the default was prevented, so an external link would open twice. Stop it
      // here (capture phase): `openLink` below is the only path.
      if (href.trim() && ev.stopPropagation) { ev.stopPropagation(); }
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

    // ---------- Word edit toolbar, shortcuts and menus (spec §8.8, §11.2, §11.3; WP-35) ----------
    // Every command goes through the edit controller: B/I/U through DocxIsland.toggle on the open
    // island (committed by the controller's idle timer), block operations through `edit.applyOp`.

    const EDIT_TOOL_IDS = ['bold', 'italic', 'underline', 'style', 'bullets', 'numbering', 'outdent', 'indent'];
    const FORMAT_NAMES = { b: 'Bold', i: 'Italic', u: 'Underline' };
    let menuState = null;      // { el, restore, opener, needsIsland }
    let hoverEl = null;
    let hoverParts = null;
    let hoverBlock = null;

    function within(root, n) { for (let x = n; x; x = x.parentNode) { if (x === root) { return true; } } return false; }
    function editing() { return !!(edit && OfficeCommon.canEdit() && OfficeCommon.isEditMode()); }
    function opIdle() { const st = edit.state(); return !st.pendingOp && !st.opening; }

    /** The paragraph with the caret (the open island) or null. */
    function caret() {
      if (!edit) { return null; }
      const p = edit.islandElement();
      const id = edit.currentBlockId();
      if (!p || id === null) { return null; }
      const b = edit.blockInfo(id);
      return b ? { id, b, p } : null;
    }

    function selectionRangeIn(p) {
      try {
        const sel = document.getSelection ? document.getSelection() : null;
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          if (within(p, r.startContainer) && within(p, r.endContainer)) { return r; }
        }
      } catch (_e) { /* no selection support */ }
      return null;
    }

    function styleName(b) {
      const st = b.style || {};
      if (st.kind === 'normal') { return 'Normal'; }
      if (st.kind === 'heading' && st.level) { return 'Heading ' + st.level; }
      return st.name || 'Other';
    }

    /** Brings the toolbar in line with the open island / caret paragraph (called on every change). */
    function syncEditUi() {
      if (!tb) { return; }
      const show = !!edit && OfficeCommon.canEdit();
      EDIT_TOOL_IDS.forEach((id) => tb.setHidden(id, !show));
      if (!show) { closeMenu(false); hideHover(); return; }
      const c = editing() ? caret() : null;
      const b = c ? c.b : null;
      ['bold', 'italic', 'underline', 'style', 'bullets', 'numbering'].forEach((id) => tb.setDisabled(id, !c));
      const inList = !!b && !!b.list && b.list.kind !== 'none';
      tb.setDisabled('outdent', !inList);
      tb.setDisabled('indent', !inList);
      tb.setPressed('bullets', !!b && !!b.list && b.list.kind === 'bullet');
      tb.setPressed('numbering', !!b && !!b.list && b.list.kind === 'number');
      let f = { b: false, i: false, u: false };
      if (c && IslandLib) {
        try { f = IslandLib.formatAt(c.p, selectionRangeIn(c.p)); } catch (_e) { /* keep unpressed */ }
      }
      tb.setPressed('bold', !!f.b);
      tb.setPressed('italic', !!f.i);
      tb.setPressed('underline', !!f.u);
      const styleBtn = tb.button('style');
      styleBtn.textContent = b ? 'Style: ' + styleName(b) : 'Style';
      styleBtn.setAttribute('aria-label', b ? 'Paragraph style: ' + styleName(b) : 'Paragraph style');
      if (!editing()) { hideHover(); }
      if (!c && menuState && menuState.needsIsland) { closeMenu(false); }
    }

    function toggleFormat(which) {
      const c = editing() ? caret() : null;
      if (!c || !IslandLib) { return false; }
      let r = selectionRangeIn(c.p);
      if (!r) { r = IslandLib.setCaret(c.p, 'end'); }
      IslandLib.toggle(c.p, r, which);
      edit.touch();
      if (typeof c.p.focus === 'function') { c.p.focus(); }
      syncEditUi();
      const f = IslandLib.formatAt(c.p, selectionRangeIn(c.p));
      OfficeCommon.announce(FORMAT_NAMES[which] + (f[which] ? ' on' : ' off'));
      return true;
    }

    /** Applies a block operation through the controller; false when it cannot run right now. */
    function runOp(op, okMessage) {
      if (!editing() || !opIdle()) { return false; }
      hideHover();
      const r = edit.applyOp(op);
      if (okMessage && r && typeof r.then === 'function') {
        r.then((x) => { if (x && x.ok) { OfficeCommon.announce(okMessage); } });
      }
      return true;
    }

    function setStyle(style) {
      const c = caret();
      if (!c || !editing()) { return false; }
      return runOp({ op: 'setStyle', blockIds: [c.id], style }, style === 'normal' ? 'Normal' : 'Heading ' + style.heading);
    }

    function toggleList(kind) {
      const c = caret();
      if (!c || !editing()) { return false; }
      const off = !!c.b.list && c.b.list.kind === kind;
      const name = kind === 'bullet' ? 'Bullets' : 'Numbering';
      return runOp({ op: 'setList', blockIds: [c.id], list: off ? 'none' : kind }, name + (off ? ' off' : ' on'));
    }

    function changeLevel(delta) {
      const c = caret();
      if (!c || !editing() || !c.b.list || c.b.list.kind === 'none') { return false; }
      return runOp({ op: 'setListLevel', blockIds: [c.id], delta }, delta > 0 ? 'Indented' : 'Outdented');
    }

    function insertAfter(blockId) { return runOp({ op: 'insertParagraphAfter', blockId }, 'Paragraph inserted'); }
    function removeBlock(blockId) { return runOp({ op: 'removeParagraph', blockId }, 'Paragraph removed'); }

    // ----- menus (style picker and the block context menu) -----

    function closeMenu(restoreFocus) {
      if (!menuState) { return; }
      const m = menuState;
      menuState = null;
      if (m.el.parentNode) { m.el.parentNode.removeChild(m.el); }
      if (m.opener) { m.opener.setAttribute('aria-expanded', 'false'); }
      if (restoreFocus && m.restore) { m.restore(); }
    }

    /** spec: { label, items: [{ label, key?, disabled?, checked?, run }], x, y, opener?, restore?, needsIsland? } */
    function openMenu(spec) {
      closeMenu(false);
      const el = mk('div', 'docx-menu');
      el.setAttribute('role', 'menu');
      el.setAttribute('aria-label', spec.label);
      const buttons = [];
      spec.items.forEach((item) => {
        const b = mk('button', 'docx-menu-item');
        b.setAttribute('type', 'button');
        b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
        b.setAttribute('tabindex', '-1');
        if (item.checked !== undefined) { b.setAttribute('aria-checked', item.checked ? 'true' : 'false'); }
        if (item.disabled) { b.setAttribute('aria-disabled', 'true'); }
        b.appendChild(mk('span', 'docx-menu-label', item.label));
        if (item.key) { b.appendChild(mk('span', 'docx-menu-key', item.key)); }
        b.addEventListener('click', () => {
          if (item.disabled) { return; }
          closeMenu(false);
          item.run();
        });
        buttons.push(b);
        el.appendChild(b);
      });
      el.addEventListener('keydown', (ev) => {
        const i = buttons.indexOf(ev.target);
        const n = buttons.length;
        switch (ev.key) {
          case 'ArrowDown': buttons[(i + 1) % n].focus(); break;
          case 'ArrowUp': buttons[(i - 1 + n) % n].focus(); break;
          case 'Home': buttons[0].focus(); break;
          case 'End': buttons[n - 1].focus(); break;
          case 'Enter': case ' ': if (i >= 0) { buttons[i].click(); } break;   // not left to the native click: it must run once
          case 'Escape': case 'Tab': closeMenu(true); break;
          default: return;
        }
        if (ev.preventDefault) { ev.preventDefault(); }
        if (ev.stopPropagation) { ev.stopPropagation(); }
      });
      el.style.left = Math.max(0, Math.round(spec.x || 0)) + 'px';
      el.style.top = Math.max(0, Math.round(spec.y || 0)) + 'px';
      document.body.appendChild(el);
      menuState = { el, restore: spec.restore || null, opener: spec.opener || null, needsIsland: !!spec.needsIsland };
      if (spec.opener) { spec.opener.setAttribute('aria-expanded', 'true'); }
      const checked = spec.items.findIndex((it) => it.checked);
      buttons[checked >= 0 ? checked : Math.max(0, spec.items.findIndex((it) => !it.disabled))].focus();
    }

    function rectOf(node) {
      const r = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      return r || { left: 0, top: 0, right: 0, bottom: 0 };
    }

    function toggleStyleMenu() {
      const btn = tb.button('style');
      if (menuState && menuState.opener === btn) { closeMenu(true); return; }
      const c = caret();
      if (!c || !editing()) { return; }
      const cur = c.b.style || {};
      const items = [{ label: 'Normal', key: 'Ctrl+Alt+0', checked: cur.kind === 'normal', run: () => setStyle('normal') }];
      for (let n = 1; n <= 6; n++) {
        items.push({
          label: 'Heading ' + n, key: 'Ctrl+Alt+' + n, checked: cur.kind === 'heading' && cur.level === n,
          run: () => setStyle({ heading: n }),
        });
      }
      const r = rectOf(btn);
      openMenu({ label: 'Paragraph style', items, x: r.left, y: r.bottom, opener: btn, needsIsland: true, restore: () => btn.focus() });
    }

    /** `restoreIsland`: Escape returns focus to the island; otherwise to the block itself (keyboard path, S3). */
    function openBlockMenu(blockId, x, y, restoreIsland, restoreBlock) {
      const b = edit.blockInfo(blockId);
      if (!b || !editing()) { return; }
      const items = [{ label: 'Insert paragraph after', run: () => insertAfter(blockId) }];
      if (b.parentId !== null && b.parentId !== undefined) {
        items.push({ label: 'Insert paragraph after table', run: () => insertAfter(b.parentId) });
      }
      items.push({ label: 'Remove paragraph', disabled: !b.removable, run: () => removeBlock(blockId) });
      openMenu({
        label: 'Paragraph actions', items, x, y,
        restore: () => {
          if (restoreBlock) { edit.focusBlock(blockId); return; }
          const p = restoreIsland ? edit.islandElement() : null;
          if (p && typeof p.focus === 'function') { p.focus(); }
        },
      });
    }

    function onContextMenu(ev) {
      if (!editing() || !DocxMapLib) { return; }
      const id = DocxMapLib.blockOf(ev.target);
      if (id === null || !edit.blockInfo(id)) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      openBlockMenu(id, ev.clientX || 0, ev.clientY || 0, false);
    }

    // ----- hover actions (mouse path of "Insert paragraph after" / "Remove paragraph") -----

    function buildHover() {
      hoverEl = mk('div', 'docx-hover-actions');
      hoverEl.setAttribute('role', 'group');
      hoverEl.setAttribute('aria-label', 'Paragraph actions');
      hoverEl.hidden = true;
      const chip = mk('span', 'docx-lock-chip', 'Locked');
      const button = (cls, label, title, run) => {
        const b = mk('button', 'docx-hover-btn ' + cls, label);
        b.setAttribute('type', 'button');
        b.setAttribute('title', title);
        b.setAttribute('aria-label', title);
        b.setAttribute('tabindex', '-1');     // keyboard users have the context menu (Shift+F10)
        b.addEventListener('click', () => { if (hoverBlock !== null) { run(hoverBlock); } });
        return b;
      };
      hoverParts = {
        chip,
        insert: button('docx-hover-insert', '+ Paragraph', 'Insert paragraph after', (id) => insertAfter(id)),
        table: button('docx-hover-table', '+ After table', 'Insert paragraph after table', (id) => {
          const b = edit.blockInfo(id);
          if (b && b.parentId !== null && b.parentId !== undefined) { insertAfter(b.parentId); }
        }),
        remove: button('docx-hover-remove', 'Remove', 'Remove paragraph', (id) => removeBlock(id)),
      };
      [chip, hoverParts.insert, hoverParts.table, hoverParts.remove].forEach((n) => hoverEl.appendChild(n));
      content.appendChild(hoverEl);
    }

    function hideHover() {
      hoverBlock = null;
      if (hoverEl) { hoverEl.hidden = true; }
    }

    function showHover(id) {
      const b = edit.blockInfo(id);
      const ps = mapping && mapping.byId ? mapping.byId.get(id) : null;
      if (!b || !ps || !ps.length) { hideHover(); return; }
      if (!hoverEl) { buildHover(); }
      hoverBlock = id;
      hoverParts.chip.hidden = b.editable;
      hoverParts.remove.hidden = !b.removable;
      hoverParts.table.hidden = b.parentId === null || b.parentId === undefined;
      const r = rectOf(ps.find((x) => !x.hidden) || ps[0]);
      const cr = rectOf(content);
      hoverEl.style.top = Math.round(r.top - cr.top + (content.scrollTop || 0)) + 'px';
      hoverEl.style.left = Math.round(r.right - cr.left + (content.scrollLeft || 0)) + 'px';
      hoverEl.hidden = false;
    }

    function onHover(ev) {
      if (!editing() || !DocxMapLib) { hideHover(); return; }
      if (hoverEl && within(hoverEl, ev.target)) { return; }
      const id = DocxMapLib.blockOf(ev.target);
      if (id === null) { hideHover(); return; }
      showHover(id);
    }

    // ----- keys -----

    function digitOf(ev) {
      const m = /^(?:Digit|Numpad)([0-9])$/.exec(String(ev.code || ''));
      if (m) { return Number(m[1]); }
      if (typeof ev.key === 'string' && /^[0-9]$/.test(ev.key)) { return Number(ev.key); }
      return ev.key === '&' ? 7 : ev.key === '*' ? 8 : null;     // shifted digits when no `code` is given
    }

    /** §11.3 Word shortcuts: returns the command for a keydown, or null. */
    function shortcutFor(ev) {
      const k = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
      if (!ev.altKey && !ev.shiftKey && (k === 'b' || k === 'i' || k === 'u')) { return () => toggleFormat(k); }
      const d = digitOf(ev);
      if (d === null) { return null; }
      if (ev.altKey && !ev.shiftKey && d <= 6) { return () => setStyle(d === 0 ? 'normal' : { heading: d }); }
      if (ev.shiftKey && !ev.altKey && d === 7) { return () => toggleList('number'); }
      if (ev.shiftKey && !ev.altKey && d === 8) { return () => toggleList('bullet'); }
      return null;
    }

    function onEditKey(ev) {
      if (!editing() || ev.isComposing) { return; }
      const c = caret();
      if (!c) {
        // No island: Shift+F10 / ContextMenu on a focused block (or the document) opens that block's menu
        // (review S3), locked and opaque blocks included ("Insert paragraph after").
        if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
          const id = edit.keyboardBlock(ev.target);
          if (id === null || !opIdle()) { return; }
          if (ev.preventDefault) { ev.preventDefault(); }
          if (ev.stopPropagation) { ev.stopPropagation(); }
          const ps = mapping && mapping.byId ? mapping.byId.get(id) : null;
          const r = rectOf(ps && ps.length ? ps[0] : ev.target);
          openBlockMenu(id, r.left, r.bottom, false, true);
        }
        return;
      }
      const t = ev.target;
      if (!(within(c.p, t) || within(toolbarEl, t))) { return; }
      const stopKey = () => { if (ev.preventDefault) { ev.preventDefault(); } if (ev.stopPropagation) { ev.stopPropagation(); } };
      if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
        stopKey();
        const r = rectOf(c.p);
        openBlockMenu(c.id, r.left, r.bottom, true);
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey)) { return; }
      if (ev.getModifierState && ev.getModifierState('AltGraph')) { return; }   // AltGr+digit types characters
      const run = shortcutFor(ev);
      if (!run) { return; }
      // Stopped so the key is not also handled by VS Code (Ctrl+B would toggle the side bar).
      stopKey();
      run();
    }

    // ---------- wiring ----------

    /** Ctrl/Cmd+= / Ctrl/Cmd+- zoom the page (window, capture phase: stopped so VS Code does not zoom too). */
    function onKeyDown(ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) { return; }
      let step = 0;
      if (ev.key === '=' || ev.key === '+') { step = 1; }
      else if (ev.key === '-' || ev.key === '_') { step = -1; }
      if (!step) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      if (ev.stopPropagation) { ev.stopPropagation(); }
      stepZoom(step);
    }

    function onWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      stepZoom(ev.deltaY < 0 ? 1 : -1);
    }

    function onMessage(msg) {
      if (edit) { edit.onMessage(msg); }   // the edit controller sees every message first
      if (msg.type === 'init' || msg.type === 'editModeChanged' || msg.type === 'docxStateChanged' || msg.type === 'loadError') {
        closeMenu(false);
      }
      switch (msg.type) {
        case 'docxRender': render(msg.bytes, msg.blocks, msg.version); break;
        case 'docxStateChanged': post({ type: 'docxRequestRender' }); break;
        case 'flushPendingEdits': {
          // Answered once the edits already sent are answered (nothing pending in View mode).
          const done = () => post({ type: 'flushed', flushId: msg.flushId });
          if (edit) { edit.flush().then(done, done); } else { done(); }
          break;
        }
        case 'loadError':
          queued = null; mapping = null;
          clear(host); clear(styles); sectionCount = 0; syncToolbar(); break;
        default: break;
      }
    }

    function start() {
      buildToolbar();
      content.addEventListener('click', onLinkClick, true);
      content.addEventListener('auxclick', onLinkClick, true);
      content.addEventListener('keydown', onContentKey);
      content.addEventListener('dblclick', editHint);
      content.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', () => { if (fit) { applyZoom(); } });
      edit = DocxEditLib ? DocxEditLib.create({
        content, toolbar: toolbarEl, post, resume: pump, hasHeld: () => !!queued,
        onState: syncEditUi, keepsIsland: (n) => !!(menuState && within(menuState.el, n)),
      }, { document, window, OfficeCommon, DocxMap: DocxMapLib, DocxIsland: deps.DocxIsland || global.DocxIsland, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout }) : null;   // WP-34
      if (edit) {
        content.addEventListener('contextmenu', onContextMenu);
        content.addEventListener('mouseover', onHover);
        content.addEventListener('mouseleave', hideHover);
        content.addEventListener('scroll', hideHover);
        window.addEventListener('keydown', onEditKey, true);    // after the controller's own capture listener
        window.addEventListener('mousedown', (ev) => {
          if (menuState && !within(menuState.el, ev.target) && ev.target !== menuState.opener) { closeMenu(false); }
        }, true);
        if (document.addEventListener) { document.addEventListener('selectionchange', syncEditUi); }
      }
      OfficeCommon.init({ vscode, onEditModeToggle: syncEditUi, onMessage });
    }

    return {
      start, whenIdle,
      state: () => ({ zoom, fit, sectionCount, renderFailed }),
      /** The Word edit controller (null without docxEdit.js). */
      editor: () => edit,
      /** The current block mapping (DocxMap.mapBlocks result) or null. */
      mapping: () => mapping,
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
