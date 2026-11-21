// PDF viewer sidebar panels and the document-properties dialog (spec §7.2, plan PWP-09).
// Loaded after pdfViewer.js. It registers four things with `PdfViewerShell` (the shell owns the tab
// frame, F4, the persisted open/closed state, and mounts a panel lazily):
//   Thumbnails   lazy, one render at a time, at most PdfViewMath.THUMB_CAP canvases alive
//   Outline      role="tree", arrow-key navigation, only when getOutline() has entries
//   Attachments  name, size and "Save as…" through the host (never opened, never executed)
//   Properties   a dialog opened from a toolbar button
// Rules (plan §1): every string that comes from the document is set with textContent / attributes,
// never HTML; no style attributes (the CSP has no 'unsafe-inline'); nothing is written to the file.
(function (global) {
  'use strict';

  const win = global.window || global;
  const MAX_TITLE = 2000;           // longest outline title / attachment name kept for display
  const MAX_ATT_BYTES = 250 * 1024 * 1024;   // mirrors MAX_ATTACHMENT_BYTES in src/pdf/protocol.ts
  const THUMB_WIDTH = 96;           // CSS px; the canvas is rendered at up to 2x
  const THUMB_BUFFER = 5;
  const MAX_THUMBS = 5000;          // thumbnail buttons built; later pages are reached with the page box
  const MAX_OUTLINE_ITEMS = 5000;   // outline rows built across the whole tree
  const MAX_OUTLINE_DEPTH = 64;     // outline levels built; deeper entries are left out
  const OPENABLE = /^(https?:|mailto:)/i;

  // ---------------------------------------------------------------- pure helpers

  function cut(v, n) {
    const s = v === null || v === undefined ? '' : String(v);
    return s.length > n ? s.slice(0, n) : s;
  }

  function formatSize(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) { return ''; }
    if (n < 1024) { return n + ' bytes'; }
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + units[i];
  }

  /** "D:20240131120000+01'00'" -> "2024-01-31 12:00 (+01:00)"; anything unparseable is shown as is. */
  function formatPdfDate(raw) {
    if (raw === null || raw === undefined || raw === '') { return ''; }
    const s = String(raw);
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})(?:'?(\d{2})'?)?)?/.exec(s);
    if (!m) { return cut(s, 100); }
    const p = (x, d) => (x === undefined ? d : x);
    let out = m[1] + '-' + p(m[2], '01') + '-' + p(m[3], '01');
    if (m[4] !== undefined) { out += ' ' + m[4] + ':' + p(m[5], '00'); }
    if (m[7]) { out += ' (UTC)'; } else if (m[8]) { out += ' (' + m[8] + m[9] + ':' + p(m[10], '00') + ')'; }
    return out;
  }

  /** `page.view` (points) -> "210 × 297 mm (595 × 842 pt)", honouring /Rotate and /UserUnit. */
  function formatPageSize(page) {
    const v = page && Array.isArray(page.view) ? page.view : null;
    if (!v || v.length < 4) { return ''; }
    const unit = typeof page.userUnit === 'number' && page.userUnit > 0 ? page.userUnit : 1;
    let w = Math.abs(v[2] - v[0]) * unit;
    let h = Math.abs(v[3] - v[1]) * unit;
    if (!(w > 0 && h > 0)) { return ''; }
    const rot = ((page.rotate || 0) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
    const mm = (x) => Math.round(x / 72 * 25.4);
    return mm(w) + ' × ' + mm(h) + ' mm (' + Math.round(w) + ' × ' + Math.round(h) + ' pt)';
  }

  /**
   * pdf.js 6 returns a Map keyed by attachment id whose values carry no bytes (they are fetched with
   * `getAttachmentContent(id)`); older builds return an object with `content`. -> [{ id, name, content?, description }]
   */
  function listAttachments(raw) {
    const out = [];
    if (!raw) { return out; }
    const add = (key, a) => {
      if (!a || typeof a !== 'object') { return; }
      const name = cut(a.filename || a.rawFilename || key || '', MAX_TITLE);
      out.push({ id: key, name: name || 'attachment', content: a.content, description: cut(a.description, MAX_TITLE) });
    };
    if (typeof raw.forEach === 'function' && typeof raw.size === 'number') { raw.forEach((a, k) => add(k, a)); }
    else { Object.keys(raw).forEach((k) => add(k, raw[k])); }
    return out;
  }

  // ---------------------------------------------------------------- registration

  function install(shell, doc) {
    const VM = global.PdfViewMath;
    const mk = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) { e.className = cls; }
      if (text !== undefined && text !== null) { e.textContent = String(text); }
      return e;
    };
    const clear = (n) => { while (n.firstChild) { n.removeChild(n.firstChild); } };
    const label = (i) => {
      const l = shell.pageLabels;
      return Array.isArray(l) && l[i] ? String(l[i]) : String(i + 1);
    };

    // Outline and attachment lists are looked up once per document and shared by isAvailable and mount.
    let cacheDoc = null;
    let outlineP = null;
    let attachP = null;
    function lookups(pdf) {
      if (cacheDoc !== pdf) {
        cacheDoc = pdf;
        outlineP = Promise.resolve().then(() => pdf.getOutline()).then((o) => (Array.isArray(o) ? o : []), () => []);
        attachP = Promise.resolve().then(() => pdf.getAttachments()).then(listAttachments, () => []);
      }
      return { outline: outlineP, attachments: attachP };
    }

    // ================================================================ thumbnails

    const thumbs = {
      el: null, pdf: null, built: false, active: false,
      list: null, items: [], canvases: new Map(), failed: new Set(), visible: new Set(),
      observer: null, queue: [], rendering: false, token: 0, current: 0, scheduled: false,
    };

    function thumbReset() {
      thumbs.token++;
      thumbs.queue = [];
      if (thumbs.observer) { try { thumbs.observer.disconnect(); } catch (e) { /* gone */ } thumbs.observer = null; }
      thumbs.canvases.clear(); thumbs.failed.clear(); thumbs.visible.clear();
      thumbs.items = []; thumbs.list = null; thumbs.built = false; thumbs.rendering = false;
      if (thumbs.el) { clear(thumbs.el); }
    }

    function thumbBuild() {
      if (thumbs.built || !thumbs.el || !thumbs.pdf) { return; }
      thumbs.built = true;
      const pages = thumbs.pdf.numPages | 0;
      const count = Math.min(pages, MAX_THUMBS);
      const list = mk('div', 'pdf-thumbs');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', 'Page thumbnails');
      thumbs.list = list;
      thumbs.current = Math.max(0, Math.min(count - 1, (shell.currentPage || 1) - 1));
      for (let i = 0; i < count; i++) {
        const b = mk('button', 'pdf-thumb');
        b.setAttribute('type', 'button');
        b.setAttribute('aria-label', 'Page ' + label(i));
        b.setAttribute('tabindex', i === thumbs.current ? '0' : '-1');
        if (i === thumbs.current) { b.setAttribute('aria-current', 'page'); }
        b.appendChild(mk('span', 'pdf-thumb-frame'));
        b.appendChild(mk('span', 'pdf-thumb-label', label(i)));
        const n = i;
        b.addEventListener('click', () => shell.goToPage(n + 1, true));
        thumbs.items.push(b);
        list.appendChild(b);
      }
      list.addEventListener('keydown', thumbKey);
      thumbs.el.appendChild(list);
      if (pages > count) {
        const note = mk('p', 'pdf-thumbs-note',
          'Thumbnails are shown for the first ' + count.toLocaleString('en-US') + ' of '
          + pages.toLocaleString('en-US') + ' pages. Use the page box (Ctrl+G) to go to a later page.');
        note.setAttribute('role', 'note');
        thumbs.el.appendChild(note);
      }
      if (typeof win.IntersectionObserver === 'function') {
        thumbs.observer = new win.IntersectionObserver((entries) => {
          entries.forEach((e) => {
            const i = thumbs.items.indexOf(e.target);
            if (i < 0) { return; }
            if (e.isIntersecting) { thumbs.visible.add(i); } else { thumbs.visible.delete(i); }
          });
          thumbSchedule();
        }, { root: thumbs.el, rootMargin: '100px 0px' });
        thumbs.items.forEach((b) => thumbs.observer.observe(b));
      }
      thumbSchedule();
    }

    function thumbKey(ev) {
      const items = thumbs.items;
      const at = items.indexOf(ev.target);
      if (at < 0) { return; }
      let next = -1;
      switch (ev.key) {
        case 'ArrowDown': case 'ArrowRight': next = Math.min(items.length - 1, at + 1); break;
        case 'ArrowUp': case 'ArrowLeft': next = Math.max(0, at - 1); break;
        case 'Home': next = 0; break;
        case 'End': next = items.length - 1; break;
        default: return;
      }
      if (ev.preventDefault) { ev.preventDefault(); }
      if (ev.stopPropagation) { ev.stopPropagation(); }
      thumbRove(next);
      items[next].focus();
    }

    function thumbRove(index) {
      const items = thumbs.items;
      if (!items.length) { return; }
      const was = thumbs.current;
      if (items[was]) { items[was].setAttribute('tabindex', '-1'); items[was].setAttribute('aria-current', 'false'); }
      thumbs.current = index;
      items[index].setAttribute('tabindex', '0');
      items[index].setAttribute('aria-current', 'page');
    }

    /** The shell's current page changed: mark it, and bring it into view when it is not. */
    function thumbCurrent(pageNumber) {
      if (!thumbs.built || !thumbs.items.length) { return; }
      if ((pageNumber | 0) - 1 >= thumbs.items.length) {   // a page past the thumbnail cap: nothing to mark
        const was = thumbs.items[thumbs.current];
        if (was) { was.setAttribute('aria-current', 'false'); }
        return;
      }
      const i = Math.max(0, (pageNumber | 0) - 1);
      const hadFocus = thumbs.items.indexOf(doc.activeElement) >= 0;
      thumbRove(i);
      if (hadFocus) { thumbs.items[i].focus(); }
      const b = thumbs.items[i];
      if (thumbs.active && b && typeof b.scrollIntoView === 'function' && !thumbs.visible.has(i)) {
        b.scrollIntoView({ block: 'nearest' });
      }
      thumbSchedule();
    }

    function thumbSchedule() {
      if (thumbs.scheduled) { return; }
      thumbs.scheduled = true;
      Promise.resolve().then(() => { thumbs.scheduled = false; thumbUpdate(); });
    }

    /** Window = visible range plus a buffer, trimmed to the cap; render what is missing, release the rest. */
    function thumbUpdate() {
      if (!thumbs.built || !thumbs.active) { return; }
      const count = thumbs.items.length;
      let first = thumbs.current;
      let last = thumbs.current;
      if (thumbs.visible.size) {
        const v = Array.from(thumbs.visible);
        first = Math.min.apply(null, v);
        last = Math.max.apply(null, v);
      }
      const w = VM.thumbnailWindow(first, last, count, THUMB_BUFFER, VM.THUMB_CAP);
      if (!w) { return; }
      thumbs.window = w;
      Array.from(thumbs.canvases.keys()).forEach((i) => { if (i < w.start || i > w.end) { thumbRelease(i); } });
      const need = [];
      for (let i = w.start; i <= w.end; i++) {
        if (!thumbs.canvases.has(i) && !thumbs.failed.has(i)) { need.push(i); }
      }
      const mid = (first + last) / 2;
      need.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));   // nearest the visible range first
      thumbs.queue = need;
      thumbPump();
    }

    function thumbRelease(i) {
      const entry = thumbs.canvases.get(i);
      thumbs.canvases.delete(i);
      if (!entry) { return; }
      if (entry.canvas.parentNode) { entry.canvas.parentNode.removeChild(entry.canvas); }
      entry.canvas.width = 0; entry.canvas.height = 0;       // frees the bitmap
      if (entry.task && typeof entry.task.cancel === 'function') { try { entry.task.cancel(); } catch (e) { /* done */ } }
      if (entry.page && typeof entry.page.cleanup === 'function') { try { entry.page.cleanup(); } catch (e) { /* done */ } }
    }

    function thumbPump() {
      if (thumbs.rendering) { return; }
      const token = thumbs.token;
      const i = thumbs.queue.shift();
      if (i === undefined) { return; }
      const w = thumbs.window;
      if (!w || i < w.start || i > w.end || thumbs.canvases.has(i)) { thumbPump(); return; }
      thumbs.rendering = true;
      const pdf = thumbs.pdf;
      const done = () => { if (token === thumbs.token) { thumbs.rendering = false; thumbPump(); } };
      Promise.resolve().then(() => pdf.getPage(i + 1)).then((page) => {
        if (token !== thumbs.token) { return null; }
        const rotation = (((page.rotate || 0) + (shell.viewer && shell.viewer.pagesRotation || 0)) % 360 + 360) % 360;
        const base = page.getViewport({ scale: 1, rotation });
        const cssScale = THUMB_WIDTH / (base.width || 1);
        const dpr = Math.min(2, (win.devicePixelRatio || 1));
        const viewport = page.getViewport({ scale: cssScale * dpr, rotation });
        const canvas = doc.createElement('canvas');
        canvas.className = 'pdf-thumb-canvas';
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.setAttribute('aria-hidden', 'true');
        const entry = { canvas, page, task: null };
        thumbs.canvases.set(i, entry);
        const ctx = canvas.getContext ? canvas.getContext('2d') : null;
        entry.task = page.render({ canvasContext: ctx, canvas, viewport });
        return entry.task.promise.then(() => {
          if (token !== thumbs.token || thumbs.canvases.get(i) !== entry) { return; }
          const frame = thumbs.items[i] && thumbs.items[i].firstChild;
          if (frame) { frame.appendChild(canvas); }
        });
      }).then(done, () => {
        if (token !== thumbs.token) { return; }
        thumbs.failed.add(i);
        const e = thumbs.canvases.get(i);
        if (e) { thumbRelease(i); }
        done();
      });
    }

    function thumbRerender() {
      Array.from(thumbs.canvases.keys()).forEach(thumbRelease);
      thumbs.failed.clear();
      thumbs.queue = [];
      thumbSchedule();
    }

    shell.registerPanel({
      id: 'thumbnails', title: 'Thumbnails', order: 10,
      mount(el) {
        thumbs.el = el;
        el.setAttribute('aria-label', 'Thumbnails');
        thumbs.pdf = shell.pdfDocument;
        thumbBuild();
      },
      onShow() { thumbs.active = true; thumbBuild(); thumbCurrent(shell.currentPage || 1); thumbSchedule(); },
      onHide() { thumbs.active = false; thumbs.queue = []; },
      onDocument(pdf) {
        thumbs.pdf = pdf;
        thumbReset();
        if (pdf && thumbs.el && thumbs.active) { thumbBuild(); }
      },
      isAvailable(pdf) { return !!pdf; },
    });
    shell.on('pagechanging', (e) => { if (e && typeof e.pageNumber === 'number') { thumbCurrent(e.pageNumber); } });
    shell.on('rotationchanging', thumbRerender);

    // ================================================================ outline

    const outline = { el: null, pdf: null, built: false, tree: null, rows: [], current: null, token: 0, truncated: false };

    function outlineActivate(row) {
      const item = row.item;
      if (item.dest !== undefined && item.dest !== null && shell.linkService) {
        try { shell.linkService.goToDestination(item.dest); } catch (e) { /* a bad destination does nothing */ }
        return;
      }
      const url = typeof item.url === 'string' ? item.url : (typeof item.unsafeUrl === 'string' ? item.unsafeUrl : '');
      if (url && OPENABLE.test(url.trim())) { shell.post({ type: 'openLink', href: url.trim() }); }
    }

    /** One level of the tree. The item cap is shared by the whole tree (`outline.rows`), not per level. */
    function outlineBuildLevel(items, level, parentEl, parentRow) {
      for (const item of items) {
        if (!item) { continue; }
        if (outline.rows.length >= MAX_OUTLINE_ITEMS) { outline.truncated = true; return; }
        let kids = Array.isArray(item.items) ? item.items : [];
        if (kids.length && level >= MAX_OUTLINE_DEPTH) { outline.truncated = true; kids = []; }
        const li = mk('div', 'pdf-outline-item');
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', String(level));
        li.setAttribute('tabindex', '-1');
        const row = { el: li, item, parent: parentRow, children: [], expanded: false, group: null };
        const head = mk('span', 'pdf-outline-row');
        const twist = mk('span', 'pdf-outline-twist' + (kids.length ? '' : ' pdf-outline-leaf'));
        twist.setAttribute('aria-hidden', 'true');
        head.appendChild(twist);
        const title = cut(item.title, MAX_TITLE) || 'Untitled';
        const text = mk('span', 'pdf-outline-title' + (item.bold ? ' pdf-outline-bold' : '') + (item.italic ? ' pdf-outline-italic' : ''), title);
        head.appendChild(text);
        li.appendChild(head);
        if (kids.length) {
          li.setAttribute('aria-expanded', 'false');
          const group = mk('div', 'pdf-outline-group');
          group.setAttribute('role', 'group');
          group.hidden = true;
          row.group = group;
          li.appendChild(group);
        }
        outline.rows.push(row);
        if (parentRow) { parentRow.children.push(row); }
        parentEl.appendChild(li);
        head.addEventListener('click', (ev) => {
          outlineFocus(row);
          if (kids.length && ev.target === twist) { outlineToggle(row, !row.expanded); return; }
          outlineActivate(row);
        });
        if (kids.length) { outlineBuildLevel(kids, level + 1, row.group, row); }
      }
    }

    function outlineToggle(row, expand) {
      if (!row.group || row.expanded === expand) { return; }
      row.expanded = expand;
      row.group.hidden = !expand;
      row.el.setAttribute('aria-expanded', expand ? 'true' : 'false');
      if (!expand && outline.current && isDescendant(outline.current, row)) { outlineFocus(row); }
    }

    function isDescendant(row, ancestor) {
      for (let p = row.parent; p; p = p.parent) { if (p === ancestor) { return true; } }
      return false;
    }

    function outlineVisible() {
      return outline.rows.filter((r) => { for (let p = r.parent; p; p = p.parent) { if (!p.expanded) { return false; } } return true; });
    }

    function outlineFocus(row, move) {
      if (outline.current) { outline.current.el.setAttribute('tabindex', '-1'); outline.current.el.setAttribute('aria-selected', 'false'); }
      outline.current = row;
      row.el.setAttribute('tabindex', '0');
      row.el.setAttribute('aria-selected', 'true');
      if (move !== false) { row.el.focus(); }
    }

    function outlineKey(ev) {
      const cur = outline.current;
      if (!cur) { return; }
      const vis = outlineVisible();
      const at = vis.indexOf(cur);
      let handled = true;
      switch (ev.key) {
        case 'ArrowDown': if (at < vis.length - 1) { outlineFocus(vis[at + 1]); } break;
        case 'ArrowUp': if (at > 0) { outlineFocus(vis[at - 1]); } break;
        case 'Home': outlineFocus(vis[0]); break;
        case 'End': outlineFocus(vis[vis.length - 1]); break;
        case 'ArrowRight':
          if (cur.group && !cur.expanded) { outlineToggle(cur, true); }
          else if (cur.children.length) { outlineFocus(cur.children[0]); }
          break;
        case 'ArrowLeft':
          if (cur.group && cur.expanded) { outlineToggle(cur, false); }
          else if (cur.parent) { outlineFocus(cur.parent); }
          break;
        case 'Enter': case ' ': outlineActivate(cur); break;
        default: handled = false;
      }
      if (handled) {
        if (ev.preventDefault) { ev.preventDefault(); }
        if (ev.stopPropagation) { ev.stopPropagation(); }
      }
    }

    function outlineReset() {
      outline.token++;
      outline.built = false; outline.rows = []; outline.current = null; outline.tree = null; outline.truncated = false;
      if (outline.el) { clear(outline.el); }
    }

    function outlineBuild() {
      if (outline.built || !outline.el || !outline.pdf) { return; }
      outline.built = true;
      const token = outline.token;
      lookups(outline.pdf).outline.then((items) => {
        if (token !== outline.token || !items.length) { return; }
        const tree = mk('div', 'pdf-outline');
        tree.setAttribute('role', 'tree');
        tree.setAttribute('aria-label', 'Document outline');
        outline.tree = tree;
        outlineBuildLevel(items, 1, tree, null);
        tree.addEventListener('keydown', outlineKey);
        outline.el.appendChild(tree);
        if (outline.truncated) {
          const note = mk('p', 'pdf-outline-truncated', '…outline truncated: only the first '
            + MAX_OUTLINE_ITEMS.toLocaleString('en-US') + ' entries and ' + MAX_OUTLINE_DEPTH + ' levels are shown.');
          note.setAttribute('role', 'note');
          outline.el.appendChild(note);
        }
        if (outline.rows.length) { outlineFocus(outline.rows[0], false); }
      });
    }

    shell.registerPanel({
      id: 'outline', title: 'Outline', order: 20,
      mount(el) { outline.el = el; outline.pdf = shell.pdfDocument; outlineBuild(); },
      onShow() { outlineBuild(); },
      onDocument(pdf) { outline.pdf = pdf; outlineReset(); if (pdf && outline.el) { outlineBuild(); } },
      isAvailable(pdf) { return pdf ? lookups(pdf).outline.then((o) => o.length > 0) : false; },
    });

    // ================================================================ attachments

    const att = { el: null, pdf: null, built: false, token: 0, nextId: 1, pending: new Map() };

    function attReset() {
      att.token++;
      att.built = false;
      att.pending.clear();
      if (att.el) { clear(att.el); }
    }

    function attBuild() {
      if (att.built || !att.el || !att.pdf) { return; }
      att.built = true;
      const token = att.token;
      lookups(att.pdf).attachments.then((list) => {
        if (token !== att.token || !list.length) { return; }
        const ul = mk('ul', 'pdf-attachments');
        ul.setAttribute('aria-label', 'Attachments');
        list.forEach((a) => {
          const li = mk('li', 'pdf-attachment');
          const info = mk('span', 'pdf-attachment-info');
          info.appendChild(mk('span', 'pdf-attachment-name', a.name));
          const size = a.content && typeof a.content.length === 'number' ? formatSize(a.content.length) : '';
          if (size) { info.appendChild(mk('span', 'pdf-attachment-size', size)); }
          if (a.description) { info.appendChild(mk('span', 'pdf-attachment-desc', a.description)); }
          li.appendChild(info);
          const btn = mk('button', 'pdf-attachment-save', 'Save as…');
          btn.setAttribute('type', 'button');
          btn.setAttribute('aria-label', 'Save ' + a.name + ' as…');
          btn.addEventListener('click', () => attSave(a, btn));
          li.appendChild(btn);
          ul.appendChild(li);
        });
        att.el.appendChild(ul);
      });
    }

    function attSave(a, btn) {
      const token = att.token;
      btn.disabled = true;
      const fail = (text) => { btn.disabled = false; shell.hint(text); };
      Promise.resolve().then(() => {
        if (a.content) { return a.content; }
        if (!att.pdf || typeof att.pdf.getAttachmentContent !== 'function') { return null; }
        return att.pdf.getAttachmentContent(a.id);   // read on demand: a PDF can embed far more than we want in memory
      }).then((c) => {
        if (token !== att.token) { return; }
        if (!c || typeof c.length !== 'number' || typeof c.subarray !== 'function') { fail('This attachment has no content to save.'); return; }
        if (c.length > MAX_ATT_BYTES) { fail('This attachment is too large to save.'); return; }
        const requestId = att.nextId++;
        att.pending.set(requestId, { name: a.name, btn });
        shell.post({ type: 'pdfSaveAttachment', requestId, name: a.name, bytes: c });
      }, () => { if (token === att.token) { fail('This attachment could not be read.'); } });
    }

    shell.on('message', (msg) => {
      if (!msg || msg.type !== 'pdfSaveAttachmentResult') { return; }
      const p = att.pending.get(msg.requestId);
      if (!p) { return; }
      att.pending.delete(msg.requestId);
      p.btn.disabled = false;
      shell.announce(msg.ok ? 'Attachment saved.' : 'Attachment not saved.');
    });

    shell.registerPanel({
      id: 'attachments', title: 'Attachments', order: 30,
      mount(el) { att.el = el; att.pdf = shell.pdfDocument; attBuild(); },
      onShow() { attBuild(); },
      onDocument(pdf) { att.pdf = pdf; attReset(); if (pdf && att.el) { attBuild(); } },
      isAvailable(pdf) { return pdf ? lookups(pdf).attachments.then((l) => l.length > 0) : false; },
    });

    // ================================================================ properties dialog

    let facts = null;
    let dialog = null;
    shell.on('facts', (f) => { facts = f; });
    shell.on('documentclosed', () => { facts = null; closeProps(); });

    function closeProps() {
      if (!dialog) { return; }
      const d = dialog;
      dialog = null;
      if (d.root.parentNode) { d.root.parentNode.removeChild(d.root); }
      if (d.opener && d.opener.focus) { d.opener.focus(); }
    }

    async function collectProps(pdf) {
      const safe = async (f) => { try { return await f(); } catch (e) { return null; } };
      const meta = await safe(() => pdf.getMetadata());
      const info = (meta && meta.info) || {};
      const page = await safe(() => pdf.getPage(1));
      const dl = await safe(() => (typeof pdf.getDownloadInfo === 'function' ? pdf.getDownloadInfo() : null));
      const mark = await safe(() => (typeof pdf.getMarkInfo === 'function' ? pdf.getMarkInfo() : null));
      const yes = (b) => (b ? 'Yes' : 'No');
      const sigs = facts && Array.isArray(facts.signatures) ? facts.signatures.length : null;
      const encrypted = facts ? !!facts.encrypted : !!info.EncryptFilterName;
      return [
        ['File name', cut(shell.fileName, MAX_TITLE)],
        ['Title', cut(info.Title, MAX_TITLE)],
        ['Author', cut(info.Author, MAX_TITLE)],
        ['Subject', cut(info.Subject, MAX_TITLE)],
        ['Keywords', cut(info.Keywords, MAX_TITLE)],
        ['Creator', cut(info.Creator, MAX_TITLE)],
        ['Producer', cut(info.Producer, MAX_TITLE)],
        ['Created', formatPdfDate(info.CreationDate)],
        ['Modified', formatPdfDate(info.ModDate)],
        ['PDF version', cut(info.PDFFormatVersion, 20)],
        ['Pages', String(pdf.numPages | 0)],
        ['Page size', formatPageSize(page)],
        ['File size', dl && typeof dl.length === 'number' ? formatSize(dl.length) : ''],
        ['Tagged', yes(mark && mark.Marked)],
        ['Encrypted', yes(encrypted)],
        ['Signatures', sigs === null ? '' : String(sigs)],
      ];
    }

    async function openProps() {
      const pdf = shell.pdfDocument;
      if (!pdf || dialog) { return; }
      const opener = doc.activeElement;
      const rows = await collectProps(pdf);
      if (dialog || shell.pdfDocument !== pdf) { return; }
      const root = mk('div', 'pdf-dialog-backdrop');
      const box = mk('div', 'pdf-dialog');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'pdf-props-title');
      const title = mk('h2', 'pdf-dialog-title', 'Document properties');
      title.id = 'pdf-props-title';
      box.appendChild(title);
      const dl = mk('dl', 'pdf-props');
      rows.forEach((r) => {
        dl.appendChild(mk('dt', 'pdf-props-name', r[0]));
        dl.appendChild(mk('dd', 'pdf-props-value', r[1] === '' ? '—' : r[1]));
      });
      box.appendChild(dl);
      const close = mk('button', 'pdf-dialog-close', 'Close');
      close.setAttribute('type', 'button');
      close.addEventListener('click', closeProps);
      box.appendChild(close);
      box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { if (ev.preventDefault) { ev.preventDefault(); } if (ev.stopPropagation) { ev.stopPropagation(); } closeProps(); }
        else if (ev.key === 'Tab') { if (ev.preventDefault) { ev.preventDefault(); } close.focus(); }   // one control: the focus stays in the dialog
      });
      root.addEventListener('click', (ev) => { if (ev.target === root) { closeProps(); } });
      root.appendChild(box);
      doc.body.appendChild(root);
      dialog = { root, box, opener, close };
      close.focus();
    }

    const items = shell.registerToolbarItems([{
      id: 'properties', label: 'Properties', title: 'Document properties', order: 900, disabled: true,
      onClick() { openProps(); },
    }]);
    const sync = () => { if (items.properties) { items.properties.setDisabled(!shell.pdfDocument); } };
    shell.on('documentloaded', sync);
    shell.on('documentclosed', sync);

    return { thumbs, outline, att, openProps, closeProps, get dialog() { return dialog; } };
  }

  const api = { formatSize, formatPdfDate, formatPageSize, listAttachments, install, MAX_THUMBS, MAX_OUTLINE_ITEMS, MAX_OUTLINE_DEPTH };
  global.PdfSidebar = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (global.PdfViewerShell && global.document) { global.PdfSidebarInstance = install(global.PdfViewerShell, global.document); }
})(typeof window !== 'undefined' ? window : globalThis);
