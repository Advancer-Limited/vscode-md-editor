// @ts-nocheck
// Word edit controller: paragraph islands, commit timing and re-render scheduling (spec §6.3, §6.4,
// §6.5 step 1, §8.5, §8.8, §11.2, §11.3; plan WP-34).
//
// Created by media/docxEditor.js (`DocxEdit.create(hooks, deps)`); it sees every host message first.
// Pure webview code: DOM through `deps.document`, timers through `deps.setTimeout/clearTimeout`, so the
// unit tests drive it in node:vm with a DOM shim and fake timers.
//
// Islands. In Edit mode a click on a mapped paragraph (`data-block`, media/docxMap.js) asks the host
// for the block model (`docxRequestBlockModel`) and builds a contenteditable island in the block's
// FIRST <p> with media/docxIsland.js; the block's other <p>s (halves of a page-break-split paragraph)
// are hidden until the next render, because the island holds all of the paragraph's content. The
// island is `role="textbox"`, `aria-multiline="true"`, labelled "Paragraph N".
//
// Commit timing (§8.8): on blur, on moving to another block (click, ArrowUp/Down at the first/last
// line, Tab between cells), on Ctrl/Cmd+S and Ctrl/Cmd+W wherever the focus is (capture phase; the key
// still reaches VS Code, whose save flush then waits for this commit), when the window loses focus or
// is hidden, when Edit is turned off, after 1.5 s without typing, and at most 1 s after the first
// uncommitted keystroke (review S2: VS Code only knows the document is dirty once a commit landed).
// A commit never touches the island DOM (project lesson "wysiwyg-cursor-fix"): the island stays as
// the paragraph's display until the next docx-preview render.
//
// A refused commit never loses the typed text (review B1): an island whose commit failed stays open
// (or is reopened with its DOM when it had just closed), and a commit refused only because a save was
// writing is retried (the idle timer is re-armed; a closed island nobody can reopen right now is
// re-sent in the background, and renders wait for it). A flush retries such a commit before answering.
//
// Requests go to the host one at a time (like media/xlsxCellEditor.js): every `docxEdit` carries the
// version the previous reply reported, and `flushPendingEdits` answers once nothing is in flight. A
// flush never commits an open island (Gate R2 F4: the host flushes for backups and auto-save too),
// except to retry a commit the host refused for a moment (B1).
//
// Keyboard (review S3): in Edit mode the mapped blocks are focusable with a roving tabindex (the last
// block focused or edited is the tab stop). ArrowUp/Down on a focused block moves between blocks,
// Enter or F2 opens its island with the caret at the end (Enter on the document itself opens the
// current block), and Escape in an island closes it and puts the focus back on the block. The
// viewer opens the block context menu for the focused block on Shift+F10 / ContextMenu.
//
// Structure keys (§8.5, §11.3): Enter splits (`splitParagraph`, the DOM is split at once and the new
// half gets its id from `docxEditResult`), Shift+Enter inserts a line break, Backspace at the start
// merges into the previous sibling and Delete at the end merges the next sibling in (both only when
// that sibling is an editable paragraph in the SAME container; otherwise nothing happens), Tab /
// Shift+Tab change the list level at the start of a list item, else move to the next / previous
// table cell's first editable paragraph (nothing at the last cell), else insert a tab; Ctrl+Tab
// always inserts a tab. While a structural request or an island opening is outstanding, typing is
// buffered and replayed into the island that opens next, so no keystroke is lost.
//
// Rendering (§8.8): a full docx-preview render is requested 2 s after the last island closed, or at
// once after style/list/insert/remove operations and undo/redo/revert (`docxStateChanged`). The
// viewer renders into a detached container and asks `gate(job)` before rendering and again before
// swapping: 'hold' while an island is open or opening or a structural edit is in flight (so the
// renderer never runs while an island has focus), 'drop' for bytes older than an edit already applied.
// After a swap `onRendered` re-indexes the blocks, marks locked ones (tooltip + aria-describedby) and
// opens the island a structural operation asked to focus.
//
// Undo inside an island (spec §16 S3 fallback, `DocxIsland.UNDO_POLICY`): Ctrl/Cmd+Z cancels the
// in-progress edit (typing since the island opened or since its last commit); Ctrl+Y / Ctrl+Shift+Z
// do nothing. When nothing is in progress the island closes and the key goes on to VS Code's undo.
// `docxStateChanged` while an island is open discards it and tells the user (§6.3).
//
// Security (plan §1.8): document text reaches the DOM only through docxIsland.js (textContent /
// createTextNode); messages and labels here use textContent / setAttribute. No innerHTML.
(function (global) {
  'use strict';

  const ELEMENT = 1;
  const TEXT = 3;
  const IDLE_COMMIT_MS = 1500;
  const MAX_WAIT_MS = 1000;            // S2: an uncommitted keystroke is committed at most this late
  const RETRY_MS = 1000;               // B1: a commit refused while a save was writing is sent again
  const MAX_RETRIES = 10;
  const FOCUS_WATCHDOG_MS = 5000;      // N7: a render that never arrives does not leave the editor busy
  const RENDER_IDLE_MS = 2000;
  const FLUSH_WAIT_MS = 1200;          // below the host's 1500 ms flush timeout (§6.5 step 1)
  const MAX_BUFFERED_KEYS = 2000;
  const DISCARDED = 'The document changed; your unfinished edit was discarded.';
  const LOCK_TEXT = Object.freeze({
    'tracked-changes': "This paragraph contains tracked changes and can't be edited here.",
    'multi-paragraph-field': "This paragraph is part of a field that spans several paragraphs and can't be edited here.",
    'unknown-content': "This paragraph contains content this editor doesn't understand, so it is kept as is.",
    'merged-cell': "This cell is part of a merged cell and can't be edited here.",
    opaque: 'Not editable here — preserved as is',
  });
  const NOT_MAPPED_TEXT = "This paragraph can't be edited in this view.";
  /** The host's refusal while a save is writing (src/office/saveErrors.ts SAVE_BUSY_MESSAGE): worth retrying. */
  const SAVE_BUSY_TEXT = 'The document is being saved. Try again in a moment.';

  function retryable(e) { return !!e && e.code === 'blocked' && e.message === SAVE_BUSY_TEXT; }

  function lockText(info) {
    return (info && info.lockReason && LOCK_TEXT[info.lockReason]) || LOCK_TEXT.opaque;
  }

  /** Key events typed while the editor is busy and replayed into the next island. */
  function isPrintable(ev) {
    return typeof ev.key === 'string' && ev.key.length === 1 && !((ev.ctrlKey || ev.metaKey) && !ev.altKey);
  }
  function isBufferable(ev) {
    if (isPrintable(ev)) { return true; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) { return ev.key === 'Tab' && ev.ctrlKey && !ev.metaKey && !ev.altKey; }
    return ev.key === 'Enter' || ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Tab';
  }

  function create(hooks, deps) {
    const d = deps || {};
    const doc = d.document || global.document;
    const win = d.window || global;
    const OC = d.OfficeCommon || global.OfficeCommon;
    const Island = d.DocxIsland || global.DocxIsland;
    const DMap = d.DocxMap || global.DocxMap;
    const setTimer = d.setTimeout || ((f, ms) => global.setTimeout(f, ms));
    const clearTimer = d.clearTimeout || ((h) => global.clearTimeout(h));
    const content = hooks.content;
    const log = d.console || global.console;

    // ------------------------------------------------------------------------------ state

    let version = 0;
    let blocks = [];                 // DocxBlockInfo[] as the host last reported them
    let info = new Map();            // id -> DocxBlockInfo
    let byId = new Map();            // id -> <p>[] in the DOM currently shown
    let island = null;               // the open island (see openOn)
    let opening = null;              // { id, at, req } island waiting for its block model
    let pendingOp = null;            // structural op in flight: { kind, restore(), ... }
    let focusAfterRender = null;     // { blockId, at } open once the next render is swapped in
    let needsRender = false;         // the DOM shows content docx-preview has not rendered
    let renderTimer = null;
    const keyBuffer = [];
    const queue = [];
    let inflight = null;
    let idleWaiters = [];
    let nextRequestId = 1;
    let lockDescs = null;
    const orphans = new Set();       // closed islands whose refused commit is being re-sent (B1)
    let orphanWaiters = [];
    let kbBlock = null;              // roving tab stop: block id (S3)
    let kbReturn = null;             // block to focus once the next render is swapped in
    let focusWatchdog = null;

    // ------------------------------------------------------------------------------ small helpers

    function post(msg) { hooks.post(msg); }
    function within(root, n) { for (let p = n; p; p = p.parentNode) { if (p === root) { return true; } } return false; }
    function tagOf(n) { return n && n.nodeType === ELEMENT ? String(n.tagName || n.nodeName || '').toUpperCase() : ''; }
    function kids(n) { return n && n.childNodes ? Array.prototype.slice.call(n.childNodes) : []; }
    function textOf(n) { const v = n.data !== undefined ? n.data : n.nodeValue; return v == null ? '' : String(v); }
    function setText(n, s) { if (n.data !== undefined) { n.data = s; } else { n.nodeValue = s; } }
    function prevent(ev) { if (ev.preventDefault) { ev.preventDefault(); } }
    function stop(ev) { prevent(ev); if (ev.stopPropagation) { ev.stopPropagation(); } }
    function editMode() { return !!(OC && OC.isEditMode && OC.isEditMode()); }
    function hint(text) { if (OC && OC.hint) { OC.hint(text); } }
    function announce(text) { if (OC && OC.announce) { OC.announce(text); } }
    function setVersion(v) { if (typeof v === 'number' && Number.isFinite(v) && v > version) { version = v; } }

    /** Tells the viewer its toolbar may be out of date (island opened/closed, blocks changed); coalesced. */
    let changePending = false;
    function changed() {
      if (!hooks.onState || changePending) { return; }
      changePending = true;
      Promise.resolve().then(() => { changePending = false; hooks.onState(); });
    }

    function setBlocks(list) {
      if (!Array.isArray(list)) { return; }
      changed();
      blocks = list;
      info = new Map();
      for (const b of list) { if (b && typeof b.id === 'number') { info.set(b.id, b); } }
    }

    function currentRange() {
      try {
        const sel = doc.getSelection ? doc.getSelection() : (win.getSelection ? win.getSelection() : null);
        if (sel && sel.rangeCount > 0) { return sel.getRangeAt(0); }
      } catch (_e) { /* no selection support */ }
      return null;
    }

    /** The selection inside the island, or a caret at its end. */
    function islandRange() {
      const r = currentRange();
      if (r && island && within(island.p, r.startContainer) && within(island.p, r.endContainer)) { return r; }
      return island ? Island.setCaret(island.p, 'end') : null;
    }

    function isCollapsed(r) {
      if (!r) { return true; }
      if (typeof r.collapsed === 'boolean') { return r.collapsed; }
      return r.startContainer === r.endContainer && r.startOffset === r.endOffset;
    }

    function containerKey(b) {
      return b.parentId === null || b.parentId === undefined ? 'body' : b.parentId + ':' + (b.cell ? b.cell.row + ',' + b.cell.col : '');
    }

    /** Previous / next sibling block in the same container (§8.5), or null. */
    function sibling(id, dir) {
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx < 0) { return null; }
      const key = containerKey(blocks[idx]);
      for (let k = idx + dir; k >= 0 && k < blocks.length; k += dir) {
        if (containerKey(blocks[k]) === key) { return blocks[k]; }
      }
      return null;
    }

    function isEditablePara(b) { return !!b && b.kind === 'paragraph' && b.editable === true; }
    function shown(id) { const ps = byId.get(id); return !!ps && ps.length > 0 && !!ps[0].parentNode; }

    function paragraphLabel(id) {
      let n = 0;
      for (const b of blocks) {
        if (b.kind === 'paragraph') { n++; }
        if (b.id === id) { break; }
      }
      return 'Paragraph ' + Math.max(1, n);
    }

    // ------------------------------------------------------------------------------ host requests

    function nextId() { return nextRequestId++; }

    function pump() {
      if (inflight) { return; }
      const item = queue.shift();
      if (!item) {
        const w = idleWaiters; idleWaiters = [];
        w.forEach((fn) => fn());
        return;
      }
      inflight = item;
      item.id = nextId();
      if (item.type === 'model') {
        post({ type: 'docxRequestBlockModel', requestId: item.id, blockId: item.blockId });
      } else {
        post({ type: 'docxEdit', requestId: item.id, baseVersion: version, edit: item.edit });
      }
    }

    /** Queue a request; resolves with the reply ({ ok, ... }) or { ok: false, abandoned: true }. */
    function enqueue(item) {
      return new Promise((resolve) => {
        item.resolve = resolve;
        queue.push(item);
        pump();
      });
    }
    function sendEdit(edit) { return enqueue({ type: 'edit', edit }); }
    function fetchModel(blockId) { return enqueue({ type: 'model', blockId }); }

    function whenIdle() {
      if (!inflight && !queue.length) { return Promise.resolve(); }
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    }

    function settle(msg, reply) {
      if (!inflight || msg.requestId !== inflight.id) { return; }
      const item = inflight;
      inflight = null;
      // Record the host's version now: the next queued request is posted below, before any `.then`.
      if (reply.ok) { setVersion(reply.version); }
      try { item.resolve(item.abandoned ? { ok: false, abandoned: true, error: reply.error } : reply); } finally { pump(); }
    }

    /** Drop everything queued (not the request in flight: its reply still arrives and is ignored). */
    function abandonQueue() {
      if (inflight) { inflight.abandoned = true; }
      queue.splice(0).forEach((q) => q.resolve({ ok: false, abandoned: true }));
    }

    // ------------------------------------------------------------------------------ rendering

    function requestRender() {
      if (renderTimer !== null) { clearTimer(renderTimer); renderTimer = null; }
      post({ type: 'docxRequestRender' });
    }

    /** Ask for a render now, or 2 s after the last island closed (§8.8). */
    function scheduleRender(immediate) {
      needsRender = true;
      if (renderTimer !== null) { clearTimer(renderTimer); renderTimer = null; }
      if (immediate) { requestRender(); return; }
      if (island || opening) { return; }   // rescheduled when the island closes
      renderTimer = setTimer(() => {
        renderTimer = null;
        if (island || opening || pendingOp || orphans.size) { return; }
        if (hooks.hasHeld && hooks.hasHeld()) { hooks.resume(); return; }
        if (needsRender) { requestRender(); }
      }, RENDER_IDLE_MS);
    }

    /** Viewer asks before rendering and before swapping: 'go' | 'hold' | 'drop'. */
    function gate(job) {
      if (job && typeof job.version === 'number' && job.version < version) { return 'drop'; }
      if (island || opening || pendingOp || orphans.size) { return 'hold'; }   // never render over unsaved typing
      return 'go';
    }

    /** A render was dropped as stale: make sure a current one follows. */
    function onDropped() { scheduleRender(true); }

    function ensureLockDescriptions() {
      if (lockDescs) { return lockDescs; }
      lockDescs = new Map();
      const box = doc.createElement('div');
      box.className = 'docx-lock-descriptions';
      box.hidden = true;
      box.setAttribute('aria-hidden', 'true');
      Object.keys(LOCK_TEXT).forEach((reason) => {
        const s = doc.createElement('span');
        s.setAttribute('id', 'docx-lock-' + reason);
        s.textContent = LOCK_TEXT[reason];
        box.appendChild(s);
        lockDescs.set(reason, 'docx-lock-' + reason);
      });
      content.appendChild(box);
      return lockDescs;
    }

    /** After a swap: index the mapped <p>s, mark locked and editable ones, open a pending focus. */
    function onRendered(mapping, job) {
      changed();
      byId = mapping && mapping.byId ? mapping.byId : new Map();
      if (job && Array.isArray(job.blocks) && job.blocks.length && (typeof job.version !== 'number' || job.version >= version)) {
        setBlocks(job.blocks);
      }
      if (job && typeof job.version === 'number' && job.version >= version) { needsRender = false; }
      const descs = ensureLockDescriptions();
      applyRoving();
      byId.forEach((ps, id) => {
        const b = info.get(id);
        if (!b) { return; }
        for (const p of ps) {
          if (isEditablePara(b)) {
            p.setAttribute('data-docx-editable', '1');
          } else {
            const reason = b.lockReason || 'opaque';
            p.setAttribute('data-docx-locked', reason);
            p.setAttribute('title', lockText(b));
            if (descs.has(reason)) { p.setAttribute('aria-describedby', descs.get(reason)); }
          }
        }
      });
      const missing = mapping && Array.isArray(mapping.missing) ? mapping.missing.filter((id) => isEditablePara(info.get(id))) : [];
      if (missing.length && log && log.warn) {
        log.warn('[docx] ' + missing.length + ' editable paragraph(s) could not be located in the rendered document and are locked for this view: ' + missing.slice(0, 20).join(', '));
      }
      if (focusAfterRender) {
        const f = focusAfterRender;
        setFocusAfterRender(null);
        if (editMode() && shown(f.blockId) && isEditablePara(info.get(f.blockId))) { openIsland(f.blockId, f.at); }
        else { dropKeys(); }
      } else if (!island && !opening) {
        dropKeys();
      }
      if (kbReturn !== null && !island && !opening) {
        const id = kbReturn;
        kbReturn = null;
        if (editMode() && shown(id)) { focusBlock(id); }
      }
    }

    /** focusAfterRender with a watchdog (N7): a render that never comes must not keep the editor busy. */
    function setFocusAfterRender(f) {
      focusAfterRender = f;
      if (focusWatchdog !== null) { clearTimer(focusWatchdog); focusWatchdog = null; }
      if (!f) { return; }
      focusWatchdog = setTimer(() => {
        focusWatchdog = null;
        if (focusAfterRender !== f) { return; }
        focusAfterRender = null;
        dropKeys();
        changed();
        afterIslandGone();
      }, FOCUS_WATCHDOG_MS);
    }

    // ------------------------------------------------------------------------------ keyboard focus (S3)

    /** First shown <p> of block `id`, or null. */
    function blockEl(id) {
      const ps = byId.get(id);
      if (!ps) { return null; }
      return ps.find((x) => !x.hidden && x.parentNode) || null;
    }

    /** Edit mode: every mapped block is focusable; `kbBlock` (else the first editable one) is the tab stop. */
    function applyRoving() {
      const on = editMode();
      if (on && (kbBlock === null || !shown(kbBlock))) {
        kbBlock = null;
        for (const b of blocks) { if (isEditablePara(b) && shown(b.id)) { kbBlock = b.id; break; } }
      }
      byId.forEach((ps, id) => {
        ps.forEach((p, k) => {
          if (!on) { p.removeAttribute('tabindex'); return; }
          p.setAttribute('tabindex', id === kbBlock && k === 0 ? '0' : '-1');
        });
      });
    }

    function setKbBlock(id) {
      if (kbBlock === id) { return; }
      const old = kbBlock !== null ? byId.get(kbBlock) : null;
      if (old && editMode()) { old.forEach((p) => p.setAttribute('tabindex', '-1')); }
      kbBlock = id;
      const p = blockEl(id);
      if (p && editMode()) { p.setAttribute('tabindex', '0'); }
    }

    /** Move the keyboard focus to block `id` (not an island). */
    function focusBlock(id) {
      const p = blockEl(id);
      if (!p) { return false; }
      setKbBlock(id);
      if (typeof p.focus === 'function') { p.focus(); }
      return true;
    }

    /** The block a key on `t` acts on: a focused block <p>, or the current one when the document itself has focus. */
    function keyboardBlock(t) {
      if (!t || !editMode()) { return null; }
      if (t === content) { return kbBlock !== null && shown(kbBlock) ? kbBlock : null; }
      if (t.nodeType !== ELEMENT || !within(content, t) || t.getAttribute('data-block') === null) { return null; }
      const id = DMap.blockOf(t);
      return id !== null && info.has(id) && shown(id) ? id : null;
    }

    function adjacentShown(id, dir) {
      const idx = blocks.findIndex((b) => b.id === id);
      for (let k = idx + dir; idx >= 0 && k >= 0 && k < blocks.length; k += dir) {
        if (shown(blocks[k].id)) { return blocks[k].id; }
      }
      return null;
    }

    /** Enter / F2 on a focused block: open its island at the end, or say why not. */
    function openFromKeyboard(id) {
      const b = info.get(id);
      if (!b) { return; }
      if (!isEditablePara(b)) { hint(lockText(b)); return; }
      openIsland(id, 'end');
    }

    // ------------------------------------------------------------------------------ island lifecycle

    /** Visible-unit offset (docxIsland caret units) for the characters before a point in the rendered <p>s. */
    function charsBefore(roots, container, offset) {
      let n = 0;
      let found = false;
      function walk(node) {
        if (found) { return; }
        if (node.nodeType === TEXT) {
          if (node === container) { n += Math.min(offset, textOf(node).length); found = true; return; }
          n += textOf(node).length;
          return;
        }
        if (node.nodeType !== ELEMENT) { return; }
        if (tagOf(node) === 'BR') { if (node === container) { found = true; return; } n += 1; return; }
        // A link is one chip in the island (N3): count it as one character, whatever its text.
        if (tagOf(node) === 'A') { if (within(node, container)) { found = true; return; } n += 1; return; }
        const ks = kids(node);
        for (let i = 0; i < ks.length; i++) {
          if (node === container && i === offset) { found = true; return; }
          walk(ks[i]);
          if (found) { return; }
        }
        if (node === container) { found = true; }
      }
      for (const r of roots) { walk(r); if (found) { return n; } }
      return null;
    }

    /** docxIsland caret offset for `n` characters into the built island (chips count 1, no characters). */
    function unitsForChars(p, n) {
      if (!(n > 0)) { return 'start'; }
      let chars = 0;
      let units = 0;
      let done = false;
      function walk(node) {
        if (done) { return; }
        if (node.nodeType === TEXT) {
          const t = textOf(node).length;
          if (chars + t >= n) { units += n - chars; chars = n; done = true; return; }
          chars += t; units += t;
          return;
        }
        if (node.nodeType !== ELEMENT) { return; }
        if (node.getAttribute('data-atom') !== null) {
          units += 1;
          if (node.getAttribute('data-atom-type') === 'hyperlink') { chars += 1; if (chars >= n) { done = true; } }   // see charsBefore
          return;
        }
        if (node.getAttribute('data-anchor') !== null) { return; }
        if (tagOf(node) === 'BR') { chars += 1; units += 1; if (chars >= n) { done = true; } return; }
        kids(node).forEach(walk);
      }
      kids(p).forEach(walk);
      return done ? units : 'end';
    }

    function clickOffset(id) {
      const r = currentRange();
      const ps = byId.get(id);
      if (!r || !ps) { return null; }
      if (!ps.some((p) => within(p, r.startContainer))) { return null; }
      return charsBefore(ps, r.startContainer, r.startOffset);
    }

    /**
     * Open an island on block `id` with the caret at `at` ('start' | 'end' | caret units) or, when
     * `chars` is given, after that many rendered characters. Returns false when the block is locked.
     */
    function openIsland(id, at, chars) {
      const b = info.get(id);
      if (!b || b.kind !== 'paragraph') { return false; }
      if (!isEditablePara(b)) { hint(lockText(b)); return false; }
      if (!shown(id)) {
        // Not in the DOM yet (a new paragraph from insert): render, then open.
        setFocusAfterRender({ blockId: id, at: at === undefined ? 'start' : at });
        scheduleRender(true);
        return true;
      }
      if (renderTimer !== null) { clearTimer(renderTimer); renderTimer = null; }
      const req = { id, at, chars };
      opening = req;
      fetchModel(id).then((reply) => onModel(req, reply));
      return true;
    }

    function onModel(req, reply) {
      if (opening !== req) { return; }   // superseded: state changed, edit mode off, another open
      opening = null;
      if (!reply || !reply.ok) {
        if (reply && !reply.abandoned && reply.error && reply.error.message) { hint(reply.error.message); }
        dropKeys();
        afterIslandGone();
        return;
      }
      setVersion(reply.version);
      const ps = byId.get(req.id);
      if (!ps || !ps.length || !ps[0].parentNode || !editMode()) { dropKeys(); afterIslandGone(); return; }
      const p = ps[0];
      const others = ps.slice(1);
      others.forEach((o) => { o.hidden = true; });
      Island.build(doc, reply.segments, p);
      const opened = Island.itemsFromSegments(reply.segments);
      island = {
        id: req.id, p, others, segments: reply.segments, opened, committed: opened,
        commits: 0, idleTimer: null, maxTimer: null, suspended: false, sending: 0, closed: false, failed: null,
        saved: { role: p.getAttribute('role'), level: p.getAttribute('aria-level') },
      };
      activate(island);
      const at = req.chars !== null && req.chars !== undefined ? unitsForChars(p, req.chars) : (req.at === undefined ? 'start' : req.at);
      Island.setCaret(p, at);
      replayKeys();
    }

    function activate(isl) {
      const p = isl.p;
      p.setAttribute('contenteditable', 'true');
      p.setAttribute('role', 'textbox');
      p.setAttribute('aria-multiline', 'true');
      p.setAttribute('aria-label', paragraphLabel(isl.id));
      p.removeAttribute('aria-level');
      p.setAttribute('data-docx-island', '1');
      p.setAttribute('spellcheck', 'true');
      isl.suspended = false;
      setKbBlock(isl.id);
      changed();
      if (typeof p.focus === 'function') { p.focus(); }
    }

    function clearTimers(isl) {
      if (isl.idleTimer !== null) { clearTimer(isl.idleTimer); isl.idleTimer = null; }
      if (isl.maxTimer !== null) { clearTimer(isl.maxTimer); isl.maxTimer = null; }
    }

    /** Make the island inert (contenteditable off), keeping its DOM as the paragraph's display. */
    function deactivate(isl) {
      const p = isl.p;
      clearTimers(isl);
      p.removeAttribute('contenteditable');
      p.removeAttribute('aria-multiline');
      p.removeAttribute('aria-label');
      p.removeAttribute('data-docx-island');
      p.removeAttribute('spellcheck');
      if (isl.saved.role !== null) { p.setAttribute('role', isl.saved.role); } else { p.removeAttribute('role'); }
      if (isl.saved.level !== null) { p.setAttribute('aria-level', isl.saved.level); }
      changed();
    }

    function suspend(isl) {
      clearTimers(isl);
      isl.suspended = true;
      isl.p.setAttribute('contenteditable', 'false');
      changed();
    }

    function resumeIsland(isl, at) {
      island = isl;
      activate(isl);
      if (at !== undefined) { Island.setCaret(isl.p, at); }
      replayKeys();
    }

    /** The island is gone: render later if the DOM shows unrendered content. */
    function afterIslandGone() {
      if (island || opening || pendingOp || orphans.size) { return; }
      if (focusAfterRender) { return; }
      if (needsRender || (hooks.hasHeld && hooks.hasHeld())) { scheduleRender(false); }
    }

    /** Typing happened: commit after 1.5 s without typing, and at most 1 s after the first uncommitted key (S2). */
    function touch() {
      if (!island || island.suspended) { return; }
      const isl = island;
      if (isl.idleTimer !== null) { clearTimer(isl.idleTimer); }
      const fire = () => { if (island === isl && !isl.suspended) { commit(); } };
      isl.idleTimer = setTimer(() => { isl.idleTimer = null; fire(); }, IDLE_COMMIT_MS);
      if (isl.maxTimer === null) { isl.maxTimer = setTimer(() => { isl.maxTimer = null; fire(); }, MAX_WAIT_MS); }
    }

    /**
     * Commit the open island's content if it changed since the last commit. Never touches the island
     * DOM. Resolves once the host answered.
     */
    function commit() {
      if (!island) { return whenIdle(); }
      const isl = island;
      clearTimers(isl);
      const items = Island.read(isl.p);
      if (Island.sameItems(items, isl.committed)) { return whenIdle(); }
      const previous = isl.committed;
      isl.committed = items;
      isl.commits++;
      isl.sending++;
      needsRender = true;
      return sendEdit({ op: 'commitParagraph', blockId: isl.id, items }).then((r) => {
        isl.sending--;
        if (r.abandoned) { return r; }
        if (r.ok) {
          isl.failed = null;
          setVersion(r.version);
          setBlocks(r.blocks);
          // A commit that only dropped an atom is not written (the writer keeps the atom); the island
          // is out of step, but it is never rebuilt while open: the next render shows the atom.
          if (isl.closed && isl.sending === 0) { isl.closed = false; if (island !== isl) { Island.release(isl.p); } }
          return r;
        }
        if (isl.committed === items) { isl.committed = previous; }
        onCommitFailed(r.error, isl, items);
        return r;
      });
    }

    /**
     * A commitParagraph was refused (B1). The typed text is never rendered over: the island stays open,
     * or is reopened with its DOM if it had closed and nothing else is open; a refusal because a save
     * was writing is retried. Only a closed island that cannot be reopened and will not be retried
     * falls back to showing the document's state.
     */
    function onCommitFailed(error, isl, items) {
      const e = error || {};
      if (e.code === 'stale') { onStale(isl); return; }
      hint(e.message || 'The change could not be applied.');
      const again = retryable(e);
      if (island === isl) {
        if (again) { isl.failed = e; touch(); }
        return;
      }
      if (isl.closed && isl.p.parentNode && editMode() && !island && !opening && !focusAfterRender
          && (!pendingOp || pendingOp.preCommit)) {
        if (pendingOp) { pendingOp.cancelled = true; pendingOp = null; }   // applyOp: its op is not sent (N4)
        isl.closed = false;
        island = isl;
        activate(isl);
        Island.setCaret(isl.p, 'end');
        if (again) { isl.failed = e; touch(); }
        return;
      }
      if (again && isl.p.parentNode && editMode()) { retryClosed(isl, items, 1); return; }
      isl.closed = false;
      scheduleRender(true);   // the closed island shows text the document does not have
    }

    /** Re-send a closed island's refused commit in the background; renders wait meanwhile (B1). */
    function retryClosed(isl, items, attempt) {
      orphans.add(isl);
      const run = () => {
        if (isl.retryTimer) { clearTimer(isl.retryTimer); }
        isl.retryTimer = null;
        isl.retryNow = null;
        if (!orphans.has(isl)) { return; }
        if (!isl.p.parentNode || !editMode()) { dropOrphan(isl); scheduleRender(true); return; }
        sendEdit({ op: 'commitParagraph', blockId: isl.id, items }).then((r) => {
          if (!orphans.has(isl)) { return; }
          if (r.abandoned) { dropOrphan(isl); return; }
          if (r.ok) {
            setVersion(r.version);
            setBlocks(r.blocks);
            isl.closed = false;
            if (island !== isl) { Island.release(isl.p); }
            dropOrphan(isl);
            afterIslandGone();
            return;
          }
          if (retryable(r.error) && attempt < MAX_RETRIES) { retryClosed(isl, items, attempt + 1); return; }
          dropOrphan(isl);
          onEditError(r.error, null);
        });
      };
      isl.retryNow = run;
      isl.retryTimer = setTimer(run, RETRY_MS);
    }

    function dropOrphan(isl) {
      if (isl.retryTimer) { clearTimer(isl.retryTimer); isl.retryTimer = null; }
      isl.retryNow = null;
      orphans.delete(isl);
      if (!orphans.size) { const w = orphanWaiters; orphanWaiters = []; w.forEach((f) => f()); }
    }

    function whenOrphansDone() {
      return orphans.size ? new Promise((resolve) => { orphanWaiters.push(resolve); }) : Promise.resolve();
    }

    function onEditError(error, isl) {
      const e = error || {};
      if (e.code === 'stale') { onStale(isl); return; }
      hint(e.message || 'The change could not be applied.');
      if (!island || island !== isl) { scheduleRender(true); }   // the closed island shows text the document does not have
    }

    /** `stale`: everything queued was built on an old version; refetch the block and reopen. */
    function onStale(isl) {
      abandonQueue();
      const target = island && (island === isl || !isl) ? island : null;
      if (target) {
        const offset = Island.offsetOf(target.p, islandRange());
        hint(DISCARDED);
        closeIsland(false);
        openIsland(target.id, offset);
      } else {
        scheduleRender(true);
      }
    }

    /** Close the open island; with `commitFirst` its content is committed. Resolves after the reply. */
    function closeIsland(commitFirst) {
      if (!island) { return whenIdle(); }
      const isl = island;
      const done = commitFirst ? commit() : Promise.resolve();
      if (!commitFirst && Island.isDirty(isl.p)) { needsRender = true; }
      deactivate(isl);
      // A commit still in flight may be refused: keep the island's state so it can be reopened (B1).
      if (isl.sending > 0) { isl.closed = true; } else { Island.release(isl.p); }
      island = null;
      afterIslandGone();
      return done;
    }

    /** Discard the island and any opening without committing (state changed, Edit off, reload). */
    function discardAll(tell) {
      const had = !!(island || opening || pendingOp);
      if (island) {
        const isl = island;
        deactivate(isl);
        Island.release(isl.p);
        island = null;
      }
      opening = null;
      pendingOp = null;
      setFocusAfterRender(null);
      [...orphans].forEach(dropOrphan);
      keyBuffer.length = 0;
      abandonQueue();
      if (renderTimer !== null) { clearTimer(renderTimer); renderTimer = null; }
      if (had && tell) { hint(DISCARDED); }
      changed();
      return had;
    }

    // ------------------------------------------------------------------------------ key buffering

    function dropKeys() { keyBuffer.length = 0; }

    function isBusy() { return !!(opening || pendingOp || focusAfterRender || (island && island.suspended)); }

    function replayKeys() {
      while (keyBuffer.length && island && !island.suspended && !isBusy()) {
        const k = keyBuffer.shift();
        const ev = Object.assign({ target: island.p, synthetic: true, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, k);
        if (handleIslandKey(ev)) { continue; }
        if (k.key === 'Backspace' || k.key === 'Delete') { deleteOne(k.key === 'Backspace' ? -1 : 1); continue; }
        if (isPrintable(k)) { Island.insertText(island.p, islandRange(), k.key); touch(); }
      }
    }

    /** Emulated Backspace/Delete for a replayed key that is not at a paragraph boundary. */
    function deleteOne(dir) {
      const p = island.p;
      const r = islandRange();
      if (!isCollapsed(r)) { Island.insertText(p, r, ''); touch(); return; }
      const o = Island.offsetOf(p, r);
      const a = Island.setCaret(p, dir < 0 ? Math.max(0, o - 1) : o);
      const b = Island.setCaret(p, dir < 0 ? o : o + 1);
      Island.insertText(p, { startContainer: a.startContainer, startOffset: a.startOffset, endContainer: b.startContainer, endOffset: b.startOffset, collapsed: false }, '');
      touch();
    }

    // ------------------------------------------------------------------------------ structure: split

    /** Split `root` at a DOM point; returns a shallow clone of `root` holding everything after it. */
    function splitDomAt(root, container, offset) {
      let parent;
      let index;
      // Never split inside a chip: move the point after it.
      for (let n = container; n && n !== root; n = n.parentNode) {
        if (n.nodeType === ELEMENT && n.getAttribute('data-atom') !== null) {
          container = n.parentNode; offset = kids(n.parentNode).indexOf(n) + 1;
        }
      }
      if (container.nodeType === TEXT) {
        const t = textOf(container);
        const tail = doc.createTextNode(t.slice(offset));
        setText(container, t.slice(0, offset));
        parent = container.parentNode;
        parent.insertBefore(tail, container.nextSibling);
        index = kids(parent).indexOf(tail);
      } else {
        parent = container;
        index = offset;
      }
      let right = null;
      for (;;) {
        const copy = parent.cloneNode(false);
        if (right) { copy.appendChild(right); }
        kids(parent).slice(index).forEach((c) => copy.appendChild(c));
        if (parent === root) { return copy; }
        right = copy;
        const gp = parent.parentNode;
        index = kids(gp).indexOf(parent) + 1;
        parent = gp;
      }
    }

    function hasVisible(el) {
      return kids(el).some((c) => (c.nodeType === TEXT && textOf(c).length > 0)
        || (c.nodeType === ELEMENT && (c.getAttribute('data-atom') !== null || hasVisible(c))));
    }
    function padEmpty(el) { if (!hasVisible(el) && !kids(el).some((c) => tagOf(c) === 'BR')) { el.appendChild(doc.createElement('br')); } }

    function stripIslandAttrs(el) {
      ['contenteditable', 'role', 'aria-multiline', 'aria-label', 'aria-level', 'data-docx-island', 'spellcheck',
        'data-block', 'data-block-heading', 'id', 'aria-describedby', 'title', 'tabindex'].forEach((a) => el.removeAttribute(a));
      el.hidden = false;
    }

    function split() {
      const isl = island;
      const p = isl.p;
      let range = islandRange();
      const halves = Island.splitAt(p, range);
      const offset = Island.offsetOf(p, range);
      if (!isCollapsed(range)) { range = Island.insertText(p, range, ''); }
      const clone = splitDomAt(p, range.startContainer, range.startOffset);
      stripIslandAttrs(clone);
      padEmpty(p);
      padEmpty(clone);
      p.parentNode.insertBefore(clone, p.nextSibling);
      suspend(isl);
      const known = new Set(blocks.map((b) => b.id));
      const restore = () => {
        kids(clone).forEach((c) => p.appendChild(c));
        if (clone.parentNode) { clone.parentNode.removeChild(clone); }
      };
      const op = { kind: 'split', restore };
      pendingOp = op;
      needsRender = true;
      sendEdit({ op: 'splitParagraph', blockId: isl.id, before: halves.before, after: halves.after }).then((r) => {
        if (r.abandoned) { abandonedOp(op); return; }
        pendingOp = null;
        if (!r.ok) {
          restore();
          resumeIsland(isl, offset);
          onEditError(r.error, isl);
          return;
        }
        setVersion(r.version);
        setBlocks(r.blocks);
        const created = (r.changedBlockIds || []).find((id) => !known.has(id) && info.has(id));
        deactivate(isl);
        Island.release(p);
        island = null;
        if (created === undefined) {
          // Enter in an empty list item turned the list off instead (§8.5): render, then focus.
          restore();
          setFocusAfterRender(r.focus || { blockId: isl.id, at: 'start' });
          scheduleRender(true);
          return;
        }
        clone.setAttribute('data-block', String(created));
        byId.set(created, [clone]);
        const f = r.focus && r.focus.blockId === created ? r.focus : { blockId: created, at: 'start' };
        openIsland(created, f.at);
      });
    }

    // ------------------------------------------------------------------------------ structure: merge

    /** Backspace at the start of the island: merge it into the previous sibling paragraph. */
    function mergeBack() {
      const isl = island;
      const prev = sibling(isl.id, -1);
      if (!isEditablePara(prev) || !shown(prev.id)) {
        if (prev && prev.kind === 'paragraph' && !prev.editable) { hint(lockText(prev)); }
        return;
      }
      const items = Island.read(isl.p);
      const target = byId.get(prev.id).filter((x) => !x.hidden).pop() || byId.get(prev.id)[0];
      const restore = moveInto(target, [isl.p].concat(isl.others));
      runMerge(isl, { op: 'mergeWithPrevious', blockId: isl.id, items }, restore, 'start', prev.id);
    }

    /** Delete at the end of the island: merge the next sibling paragraph into it. */
    function mergeForward() {
      const isl = island;
      const next = sibling(isl.id, 1);
      if (!isEditablePara(next) || !shown(next.id)) {
        if (next && next.kind === 'paragraph' && !next.editable) { hint(lockText(next)); }
        return;
      }
      suspend(isl);
      const op = { kind: 'merge', restore: () => {} };
      pendingOp = op;
      // Commit this paragraph first, then merge the next one (its content, unchanged) into it.
      commit().then((c) => {
        if (c && c.abandoned) { abandonedOp(op); return null; }
        if (c && !c.ok) {                       // not applied: do not merge on top of it
          if (pendingOp === op) { pendingOp = null; }
          if (island === isl && isl.suspended) { resumeIsland(isl, 'end'); }
          return null;
        }
        return pendingOp === op ? fetchModel(next.id) : null;
      }).then((m) => {
        if (m && m.abandoned) { abandonedOp(op); return; }
        if (!m || pendingOp !== op) { return; }
        if (!m || !m.ok) {
          pendingOp = null;
          resumeIsland(isl, 'end');
          hint((m && m.error && m.error.message) || 'The paragraphs could not be merged.');
          return;
        }
        setVersion(m.version);
        const restore = moveInto(isl.p, byId.get(next.id));
        pendingOp = null;
        runMerge(isl, { op: 'mergeWithPrevious', blockId: next.id, items: Island.itemsFromSegments(m.segments) }, restore, 'end', isl.id);
      });
    }

    /** Move the children of `sources` to the end of `target`; detach the sources. Returns an undo. */
    function moveInto(target, sources) {
      const moved = [];
      const placed = [];
      const brBefore = kids(target).filter((c) => tagOf(c) === 'BR' && !c.nextSibling);
      // An empty paragraph's placeholder <br> would become a visible line break.
      brBefore.forEach((br) => { if (!hasVisible(target)) { target.removeChild(br); placed.push({ br }); } });
      for (const s of sources) {
        if (!s || !s.parentNode) { continue; }
        const ks = kids(s);
        ks.forEach((c) => { target.appendChild(c); moved.push({ node: c, from: s }); });
        placed.push({ el: s, parent: s.parentNode, next: s.nextSibling });
        s.parentNode.removeChild(s);
      }
      return () => {
        for (let k = placed.length - 1; k >= 0; k--) {
          const e = placed[k];
          if (e.el) { e.parent.insertBefore(e.el, e.next && e.next.parentNode === e.parent ? e.next : null); }
        }
        moved.forEach((m) => m.from.appendChild(m.node));
        placed.forEach((e) => { if (e.br) { target.appendChild(e.br); } });
      };
    }

    function runMerge(isl, edit, restore, failAt, survivorId) {
      suspend(isl);
      const op = { kind: 'merge', restore };
      pendingOp = op;
      needsRender = true;
      sendEdit(edit).then((r) => {
        if (r.abandoned) { abandonedOp(op); return; }
        pendingOp = null;
        if (!r.ok) {
          restore();
          resumeIsland(isl, failAt);
          onEditError(r.error, isl);
          return;
        }
        setVersion(r.version);
        setBlocks(r.blocks);
        deactivate(isl);
        Island.release(isl.p);
        island = null;
        if (edit.blockId === isl.id) { byId.delete(isl.id); } else { byId.delete(edit.blockId); }
        const f = r.focus || { blockId: survivorId, at: 'end' };
        openIsland(f.blockId, f.at);
      });
    }

    // ------------------------------------------------------------------------------ block operations

    /**
     * A block-level operation (setStyle, setList, setListLevel, insertParagraphAfter, removeParagraph;
     * WP-35's toolbar and context menu use this too). Commits and closes the open island first, renders
     * at once after the reply and puts the caret back (the host's `focus`, else where it was).
     */
    function applyOp(edit) {
      const keep = island ? { blockId: island.id, at: Island.offsetOf(island.p, islandRange()) } : null;
      // `preCommit`: while the island's closing commit is in flight a refusal may reopen it (B1); the
      // operation is then not sent (N4: it would act on a paragraph whose text was not applied).
      const op = { kind: 'op', restore: () => {}, preCommit: true };
      pendingOp = op;
      let pre = null;
      if (island) {
        const isl = island;
        const c = closeIsland(true);
        if (isl.sending > 0) { pre = c; }   // a commit is in flight: the op waits for its answer
      }
      const send = () => {
        op.preCommit = false;
        return sendEdit(edit).then((r) => {
          if (r.abandoned) { abandonedOp(op); return r; }
          if (pendingOp === op) { pendingOp = null; }
          if (!r.ok) {
            onEditError(r.error, null);
            if (keep && r.error && r.error.code !== 'stale') { openIsland(keep.blockId, keep.at); }
            return r;
          }
          setVersion(r.version);
          setBlocks(r.blocks);
          const f = r.focus && info.has(r.focus.blockId) ? r.focus : (keep && info.has(keep.blockId) ? keep : null);
          setFocusAfterRender(f && isEditablePara(info.get(f.blockId)) ? { blockId: f.blockId, at: f.at } : null);
          scheduleRender(true);
          return r;
        });
      };
      if (!pre) { return send(); }
      return pre.then((c) => {
        if (op.cancelled || (c && (c.abandoned || c.ok === false)) || pendingOp !== op) {
          if (pendingOp === op) { pendingOp = null; }
          afterIslandGone();
          return c && c.ok === false ? c : { ok: false, abandoned: true };
        }
        return send();
      });
    }

    /** A structural request was abandoned (stale, state change): never leave the editor busy (N7). */
    function abandonedOp(op) {
      if (pendingOp !== op) { return; }
      pendingOp = null;
      try { op.restore(); } catch (_e) { /* the DOM moved on: the render below shows the document */ }
      needsRender = true;
      changed();
      scheduleRender(true);
    }

    // ------------------------------------------------------------------------------ navigation

    function caretLine(dir) {
      const p = island.p;
      const r = islandRange();
      try {
        let rect = r && r.getBoundingClientRect ? r.getBoundingClientRect() : null;
        if ((!rect || !rect.height) && r && r.getClientRects) { const l = r.getClientRects(); rect = l && l.length ? l[0] : rect; }
        const pr = p.getBoundingClientRect ? p.getBoundingClientRect() : null;
        if (rect && pr && rect.height > 0 && pr.height > 0) {
          return dir < 0 ? rect.top - pr.top < rect.height * 0.8 : pr.bottom - rect.bottom < rect.height * 0.8;
        }
      } catch (_e) { /* fall back to the caret position */ }
      return dir < 0 ? Island.caretAtStart(p, r) : Island.caretAtEnd(p, r);
    }

    function adjacentEditable(id, dir) {
      const idx = blocks.findIndex((b) => b.id === id);
      for (let k = idx + dir; idx >= 0 && k >= 0 && k < blocks.length; k += dir) {
        if (isEditablePara(blocks[k]) && shown(blocks[k].id)) { return blocks[k].id; }
      }
      return null;
    }

    /** First editable paragraph of the next / previous cell of the same table, or null. */
    function cellTarget(id, dir) {
      const cur = info.get(id);
      if (!cur || cur.parentId === null || cur.parentId === undefined || !cur.cell) { return null; }
      const order = [];
      const first = new Map();
      for (const b of blocks) {
        if (b.parentId !== cur.parentId || !b.cell) { continue; }
        const key = b.cell.row + ',' + b.cell.col;
        if (order.indexOf(key) < 0) { order.push(key); }
        if (!first.has(key) && isEditablePara(b) && shown(b.id)) { first.set(key, b.id); }
      }
      let k = order.indexOf(cur.cell.row + ',' + cur.cell.col);
      for (k += dir; k >= 0 && k < order.length; k += dir) {
        if (first.has(order[k])) { return first.get(order[k]); }
      }
      return null;
    }

    function moveTo(id, at) {
      closeIsland(true);
      openIsland(id, at);
    }

    // ------------------------------------------------------------------------------ keys

    /** Ctrl+Z / Ctrl+Y inside an island (S3 fallback). */
    function onUndoKey(ev, act) {
      const isl = island;
      const dirty = !Island.sameItems(Island.read(isl.p), isl.committed);
      if (!dirty) {
        // Nothing in progress: close the island and let VS Code's undo/redo have the key.
        closeIsland(false);
        return;
      }
      stop(ev);
      if (act === 'cancel') { cancelEdit(false); }
    }

    /** Throw away the typing since the island opened or last committed. */
    function cancelEdit(close) {
      const isl = island;
      const offset = Island.offsetOf(isl.p, islandRange());
      clearTimers(isl);
      if (isl.commits === 0) {
        Island.cancel(isl.p);
        announce('Edit cancelled');
        if (close) { closeIsland(false); } else { Island.setCaret(isl.p, offset); }
        return;
      }
      // Some typing was committed already: the document holds the last commit; show it again.
      deactivate(isl);
      Island.release(isl.p);
      island = null;
      announce('Edit cancelled');
      if (!close) { setFocusAfterRender({ blockId: isl.id, at: offset }); } else { kbReturn = isl.id; }
      scheduleRender(true);
    }

    /** Island keydown (capture phase). Returns true when the key was handled here. */
    function handleIslandKey(ev) {
      if (ev.isComposing) { return false; }
      const k = ev.key;
      const ctrl = ev.ctrlKey || ev.metaKey;
      const p = island.p;
      if (k === 'Enter' && !ctrl && !ev.altKey) {
        prevent(ev);
        if (ev.shiftKey) { Island.insertText(p, islandRange(), '\n'); touch(); return true; }
        split();
        return true;
      }
      if ((k === 'Backspace' || k === 'Delete') && !ctrl && !ev.altKey && !ev.shiftKey) {
        const r = islandRange();
        if (!isCollapsed(r)) { return false; }
        if (k === 'Backspace' && Island.caretAtStart(p, r)) { prevent(ev); mergeBack(); return true; }
        if (k === 'Delete' && Island.caretAtEnd(p, r)) { prevent(ev); mergeForward(); return true; }
        return false;
      }
      if (k === 'Tab' && !ev.altKey && !ev.metaKey) {
        stop(ev);
        if (ev.ctrlKey) { Island.insertText(p, islandRange(), '\t'); touch(); return true; }
        const b = info.get(island.id);
        const r = islandRange();
        if (b && b.list && b.list.kind !== 'none' && isCollapsed(r) && Island.caretAtStart(p, r)) {
          applyOp({ op: 'setListLevel', blockIds: [island.id], delta: ev.shiftKey ? -1 : 1 });
          return true;
        }
        if (b && b.parentId !== null && b.parentId !== undefined) {
          const target = cellTarget(island.id, ev.shiftKey ? -1 : 1);
          if (target !== null) { moveTo(target, 'start'); }
          return true;
        }
        if (!ev.shiftKey) { Island.insertText(p, r, '\t'); touch(); }
        return true;
      }
      if ((k === 'ArrowUp' || k === 'ArrowDown') && !ctrl && !ev.altKey && !ev.shiftKey) {
        const dir = k === 'ArrowUp' ? -1 : 1;
        if (!caretLine(dir)) { return false; }
        const target = adjacentEditable(island.id, dir);
        if (target === null) { return false; }
        prevent(ev);
        moveTo(target, dir < 0 ? 'end' : 'start');
        return true;
      }
      if (k === 'Escape' && !ctrl && !ev.altKey) {
        prevent(ev);
        const id = island.id;
        if (Island.sameItems(Island.read(p), island.committed)) { closeIsland(false); focusBlock(id); return true; }
        cancelEdit(true);
        if (kbReturn !== id) { focusBlock(id); }   // else after the render that shows the document's text
        return true;
      }
      return false;
    }

    function targetInDocument(t) {
      return !t || t === doc.body || t === doc || t === doc.documentElement || within(content, t);
    }

    /** Commit the open island now (save, close, window blur / hidden). */
    function commitOpen() { if (island && !island.suspended) { commit(); } }

    function onKeyCapture(ev) {
      if (!editMode()) { return; }
      const lower = String(ev.key).toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (lower === 's' || lower === 'w')) {
        // Save / close the editor, wherever the focus is (S2): not stopped, VS Code gets the key; a
        // save's flush waits for this reply, and a close finds the document dirty.
        commitOpen();
        return;
      }
      if (island && !island.suspended && within(island.p, ev.target)) {
        const act = Island.undoKeyAction(ev);
        if (act) { onUndoKey(ev, act); return; }
        handleIslandKey(ev);
        return;
      }
      if (!isBusy() && !island && !ev.isComposing) {
        const id = keyboardBlock(ev.target);
        const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
        if (id !== null && plain && (ev.key === 'Enter' || ev.key === 'F2')) { prevent(ev); openFromKeyboard(id); return; }
        if (id !== null && plain && ev.target !== content && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
          const to = adjacentShown(id, ev.key === 'ArrowUp' ? -1 : 1);
          if (to !== null) { prevent(ev); focusBlock(to); }
          return;
        }
      }
      if (isBusy() && targetInDocument(ev.target)) {
        if (Island.undoKeyAction(ev)) { stop(ev); return; }
        if (isBufferable(ev) && !ev.isComposing) {
          prevent(ev);
          if (keyBuffer.length < MAX_BUFFERED_KEYS) {
            keyBuffer.push({ key: ev.key, shiftKey: !!ev.shiftKey, ctrlKey: !!ev.ctrlKey, altKey: !!ev.altKey, metaKey: !!ev.metaKey });
          }
        }
      }
    }

    // ------------------------------------------------------------------------------ DOM events

    function linkAncestor(n) {
      for (let x = n; x && x !== content; x = x.parentNode) { if (tagOf(x) === 'A') { return x; } }
      return null;
    }

    function onClick(ev) {
      if (!editMode()) { return; }
      const t = ev.target;
      if (island && within(island.p, t)) { return; }
      if (linkAncestor(t)) { return; }
      const id = DMap.blockOf(t);
      if (id === null || isBusy()) { return; }
      const b = info.get(id);
      if (!b) { return; }
      if (!isEditablePara(b)) { hint(lockText(b)); return; }
      if (!shown(id)) { hint(NOT_MAPPED_TEXT); return; }
      if (island && island.id === id) { return; }
      const chars = clickOffset(id);
      if (island) { closeIsland(true); }
      openIsland(id, chars === null ? 'end' : undefined, chars);
    }

    function onFocusOut(ev) {
      if (!island || island.suspended || ev.target !== island.p) { return; }
      const to = ev.relatedTarget;
      if (to && within(island.p, to)) { return; }
      if (to && hooks.toolbar && within(hooks.toolbar, to)) { return; }   // toolbar buttons act on the island
      if (to && hooks.keepsIsland && hooks.keepsIsland(to)) { return; }   // so do the style and context menus
      if (doc.hasFocus && !doc.hasFocus()) { commit(); return; }        // window lost focus: keep it open
      closeIsland(true);
    }

    function onInput(ev) {
      if (island && within(island.p, ev.target)) { touch(); }
    }

    function onPaste(ev) {
      if (!editMode()) { return; }
      if (island && !island.suspended && within(island.p, ev.target)) {
        prevent(ev);
        const text = Island.plainText(ev.clipboardData);
        if (text) { Island.insertText(island.p, islandRange(), text); touch(); }
        return;
      }
      if (isBusy() && targetInDocument(ev.target)) { prevent(ev); }
    }

    function onBeforeInput(ev) {
      if (!island || !within(island.p, ev.target)) { return; }
      const t = String(ev.inputType || '');
      // Rich formatting, drops and paragraph breaks never reach the island DOM directly.
      if (t.indexOf('format') === 0 || t === 'insertFromDrop' || t === 'insertParagraph' || t === 'historyUndo' || t === 'historyRedo') {
        prevent(ev);
      }
    }

    function onDrop(ev) { if (island && within(island.p, ev.target)) { prevent(ev); } }

    function onFocusIn(ev) {
      const t = ev.target;
      if (!editMode() || !t || t === content || (island && t === island.p)) { return; }
      if (t.nodeType === ELEMENT && t.getAttribute('data-block') !== null) {
        const id = DMap.blockOf(t);
        if (id !== null && info.has(id)) { setKbBlock(id); }
      }
    }

    content.addEventListener('click', onClick);
    content.addEventListener('focusin', onFocusIn);
    content.addEventListener('focusout', onFocusOut);
    content.addEventListener('input', onInput);
    content.addEventListener('paste', onPaste);
    content.addEventListener('beforeinput', onBeforeInput);
    content.addEventListener('drop', onDrop);
    win.addEventListener('keydown', onKeyCapture, true);
    // S2: leaving the window (another VS Code part, another app) or hiding the editor commits the island.
    win.addEventListener('blur', commitOpen);
    if (doc.addEventListener) {
      doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') { commitOpen(); } });
    }

    // ------------------------------------------------------------------------------ flush / edit mode

    function bounded(work) {
      return new Promise((resolve) => {
        let finished = false;
        const timer = setTimer(() => { if (!finished) { finished = true; resolve(); } }, FLUSH_WAIT_MS);
        work.then(() => { if (!finished) { finished = true; clearTimer(timer); resolve(); } });
      });
    }

    /**
     * `flushPendingEdits`: wait for the requests already sent. An open island stays open, uncommitted,
     * unless its last commit was refused for a moment (a save writing): that one is sent again now, as
     * are closed islands waiting to retry, and the flush waits for them (B1).
     */
    function flush() {
      return bounded(whenIdle().then(() => {
        const work = [];
        if (island && island.failed && !island.suspended) { work.push(commit()); }
        [...orphans].forEach((o) => { if (o.retryNow) { o.retryNow(); } });
        work.push(whenOrphansDone());
        return Promise.all(work);
      }).then(() => whenIdle()));
    }

    /** Turning Edit off (§6.4): commit and close the island, then wait for the reply. */
    function commitAndClose() { return bounded(closeIsland(true).then(() => whenIdle())); }
    if (OC && OC.setBeforeEditModeOff) { OC.setBeforeEditModeOff(commitAndClose); }

    function setEditAttr() { content.setAttribute('data-docx-edit', editMode() ? '1' : '0'); applyRoving(); }

    // ------------------------------------------------------------------------------ host messages

    function onMessage(msg) {
      if (!msg || typeof msg.type !== 'string') { return; }
      switch (msg.type) {
        case 'init':
          discardAll(false);
          version = typeof msg.version === 'number' ? msg.version : version;
          setEditAttr();
          break;
        case 'editModeChanged':
          if (!msg.editMode) { discardAll(true); }
          setEditAttr();
          break;
        case 'loadError':
          discardAll(false);
          break;
        case 'docxRender':
          setVersion(msg.version);
          if (Array.isArray(msg.blocks)) { setBlocks(msg.blocks); }
          break;
        case 'docxStateChanged':
          // Undo/redo/revert/reload (§6.3): the in-progress edit is cancelled; the viewer re-renders.
          discardAll(true);
          if (typeof msg.version === 'number') { version = msg.version; }
          needsRender = true;
          break;
        case 'docxBlockModel':
          settle(msg, { ok: true, version: msg.version, blockId: msg.blockId, segments: msg.segments });
          break;
        case 'docxEditResult':
          settle(msg, msg.ok ? msg : { ok: false, error: msg.error });
          break;
        case 'requestFailed':
          settle(msg, { ok: false, error: msg.error });
          break;
        default: break;
      }
    }

    return {
      onMessage, gate, onRendered, onDropped, flush, commitAndClose,
      commit, applyOp, touch, whenIdle, keyboardBlock, focusBlock,
      closeIsland: (commitFirst) => closeIsland(commitFirst !== false),
      /** The open island's <p>, or null (WP-35: toolbar B/I/U act on it). */
      islandElement() { return island && !island.suspended ? island.p : null; },
      currentBlockId() { return island ? island.id : null; },
      blockInfo(id) { return info.get(id) || null; },
      state() {
        return {
          version, open: island ? island.id : null, opening: opening ? opening.id : null,
          busy: isBusy(), pendingOp: pendingOp ? pendingOp.kind : null, needsRender,
          queued: queue.length, inflight: !!inflight, bufferedKeys: keyBuffer.length,
          retrying: orphans.size, focusBlock: kbBlock,
        };
      },
    };
  }

  const api = { create, LOCK_TEXT, IDLE_COMMIT_MS, MAX_WAIT_MS, RETRY_MS, RENDER_IDLE_MS, FLUSH_WAIT_MS, DISCARDED, SAVE_BUSY_TEXT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DocxEdit = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
