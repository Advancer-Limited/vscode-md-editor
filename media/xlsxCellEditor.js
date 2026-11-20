// @ts-nocheck
// Excel cell editing UI (WP-23, spec §6.3, §6.4, §9.3, §9.5, §11.3). Plugs into the viewer shell
// through `XlsxShell.registerCellEditor` (edit gestures), `registerMessageHandler` (host replies),
// `registerFlushHandler` and `OfficeCommon.setBeforeEditModeOff`. Edit-mode code lives here, not in
// xlsxEditor.js (plan §3.2).
//
// What it does: an in-cell editor (F2, Enter, double-click, or just typing), an editable formula bar
// (click it), Enter / Tab (and Shift) commit and move, Esc cancels, Delete / Backspace clears the
// selection, Ctrl+V pastes plain-text TSV as one edit, and the host's refusals are shown with
// `OfficeCommon.hint` (a formula rejected with a position reopens the formula bar with the caret there).
//
// Edits are sent one at a time: the next `xlsxEdit` carries the version the previous reply reported,
// so a fast typist never races the host's version counter, and `flushPendingEdits` can wait for the
// last reply before answering `flushed` (the host saves what it has applied).
//
// Undo while an edit is open (spec §16 S3, still pending): Ctrl+Z inside the in-progress editor cancels
// that edit; Ctrl+Y / Ctrl+Shift+Z do nothing there. With no editor open, VS Code's undo applies as usual.
//
// Security rule (plan §1.8): text from the document only reaches the DOM through `value` /
// `textContent` / `setAttribute`; there is no HTML string building here.
(function (global) {
  'use strict';

  const MAX_PASTE_CELLS = 10000;      // PROTOCOL_LIMITS.MAX_CELLS
  const MAX_CELL_CHARS = 32767;       // PROTOCOL_LIMITS.MAX_CELL_CHARS
  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;
  const FLUSH_WAIT_MS = 1200;         // below the host's 1500 ms flush timeout
  const RICH_CODE = 'rich-text-cell';
  const LOCKED_CELL_HINT = "This cell can't be changed here.";
  const DISCARDED_HINT = 'The document changed; your unfinished edit was discarded.';

  /**
   * Plain-text TSV (what Excel puts on the clipboard) -> rows of cells. Fields wrapped in double
   * quotes may contain tabs and line breaks; `""` is a quote. A single trailing line break is
   * dropped. Empty text gives no rows.
   */
  function parseTsv(text) {
    const s = String(text);
    if (s === '') { return []; }
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    const n = s.length;
    let atFieldStart = true;
    function endField() { row.push(field); field = ''; atFieldStart = true; }
    function endRow() { endField(); rows.push(row); row = []; }
    while (i < n) {
      const ch = s[i];
      if (atFieldStart && ch === '"') {
        // quoted field
        i++;
        let closed = false;
        while (i < n) {
          if (s[i] === '"') {
            if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
            i++; closed = true; break;
          }
          field += s[i++];
        }
        atFieldStart = false;
        if (!closed) { /* unterminated: keep what was read */ }
        continue;
      }
      if (ch === '\t') { endField(); i++; continue; }
      if (ch === '\r' || ch === '\n') {
        endRow();
        i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
        if (i >= n) { return rows; }   // a trailing line break ends the last row, it does not start one
        continue;
      }
      field += ch;
      atFieldStart = false;
      i++;
    }
    endRow();
    return rows;
  }

  /** Caret index for a host message "... (at character N)." / "... (at the end of the formula).". */
  function caretFromMessage(message, text) {
    const m = /\(at character (\d+)\)/.exec(String(message));
    if (m) { return Math.max(0, Math.min(text.length, Number(m[1]) - 1)); }
    if (/at the end of the formula/.test(String(message))) { return text.length; }
    return null;
  }

  function create(shell, deps) {
    const d = deps || {};
    const doc = d.document || global.document;
    const win = d.window || global;
    const OC = d.OfficeCommon || global.OfficeCommon;
    const setTimer = d.setTimeout || global.setTimeout;
    const clearTimer = d.clearTimeout || global.clearTimeout;

    function mk(tag, className) {
      const e = doc.createElement(tag);
      e.className = className;
      return e;
    }
    function addr(r, c) { return global.XlsxGrid && global.XlsxGrid.addrOf ? global.XlsxGrid.addrOf(r, c) : r + ',' + c; }
    function grid() { return shell.grid; }
    function sheetInfo(id) { return shell.state.sheets.find((s) => s.id === id) || null; }

    // ---- DOM: the in-cell input (over the grid) and the formula-bar input (beside the display) ----
    const cellInput = mk('input', 'xlsx-cell-editor');
    cellInput.setAttribute('type', 'text');
    cellInput.setAttribute('spellcheck', 'false');
    cellInput.setAttribute('autocomplete', 'off');
    cellInput.setAttribute('maxlength', String(MAX_CELL_CHARS));
    cellInput.hidden = true;
    const barInput = mk('input', 'xlsx-formula-input');
    barInput.setAttribute('type', 'text');
    barInput.setAttribute('spellcheck', 'false');
    barInput.setAttribute('autocomplete', 'off');
    barInput.setAttribute('aria-label', 'Formula bar');
    barInput.setAttribute('maxlength', String(MAX_CELL_CHARS));
    barInput.hidden = true;
    if (shell.gridHost) { shell.gridHost.appendChild(cellInput); }
    const bar = shell.formulaBar;
    if (bar && bar.bar) { bar.bar.insertBefore ? bar.bar.insertBefore(barInput, bar.staleMark) : bar.bar.appendChild(barInput); }

    // ---- state ----
    let ed = null;          // the open editor
    const queue = [];       // edits waiting for the previous reply
    let inflight = null;    // the edit the host is working on
    let idleWaiters = [];

    // ---------------------------------------------------------------- sending, one at a time

    function pump() {
      if (inflight) { return; }
      const item = queue.shift();
      if (!item) {
        const w = idleWaiters; idleWaiters = [];
        w.forEach((fn) => fn());
        return;
      }
      inflight = item;
      item.id = shell.nextId();
      shell.post({ type: 'xlsxEdit', requestId: item.id, baseVersion: shell.state.version, edit: item.edit });
    }

    function send(edit, ctx) {
      return new Promise((resolve) => {
        queue.push({ edit, ctx: ctx || {}, resolve, id: 0 });
        pump();
      });
    }

    /** Resolves when nothing is queued or in flight. */
    function whenIdle() {
      if (!inflight && !queue.length) { return Promise.resolve(); }
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    }

    function onEditResult(msg) {
      if (!inflight || msg.requestId !== inflight.id) { return; }
      const item = inflight;
      inflight = null;
      if (msg.ok) {
        if (typeof msg.version === 'number') { shell.state.version = msg.version; }
        // The host knows the new display strings, stale marks and used range: refetch the sheet.
        if (msg.invalidate === 'sheet' || msg.invalidate === 'workbook') {
          if (grid() && grid().invalidate) { grid().invalidate(msg.invalidate); }
        }
        shell.refetch();
        if (item.ctx.announce) { OC.announce(item.ctx.announce); }
      } else {
        const err = msg.error || {};
        if (err.code === 'cancelled') { OC.announce(err.message || 'Cancelled.'); }
        else { OC.hint(err.message || 'The edit could not be applied.'); }
        if (err.code === 'stale') {
          // Everything still queued was built on the same old version: drop it and refetch.
          queue.splice(0).forEach((q) => q.resolve());
          shell.refetch();
        } else if (err.code === 'invalid' && item.ctx.formulaInput !== undefined) {
          reopenAfterFormulaError(item.ctx, err.message);
        }
      }
      item.resolve();
      pump();
    }

    function reopenAfterFormulaError(ctx, message) {
      if (ed || shell.state.shownSheetId !== ctx.sheetId || !grid()) { return; }
      grid().setActive(ctx.r, ctx.c);
      open({ r: ctx.r, c: ctx.c, bar: true }, { value: ctx.formulaInput, seed: ctx.seed, caret: caretFromMessage(message, ctx.formulaInput) });
    }

    // ---------------------------------------------------------------- the editor

    function place(e) {
      const node = grid() && grid().cellElement ? grid().cellElement(e.r, e.c) : null;
      if (!node || !node.getBoundingClientRect) { return false; }
      const rc = node.getBoundingClientRect();
      const host = shell.gridHost && shell.gridHost.getBoundingClientRect ? shell.gridHost.getBoundingClientRect() : { left: 0, top: 0 };
      cellInput.style.left = Math.max(0, rc.left - host.left) + 'px';
      cellInput.style.top = Math.max(0, rc.top - host.top) + 'px';
      cellInput.style.minWidth = Math.max(40, (rc.right - rc.left)) + 'px';
      cellInput.style.height = Math.max(18, (rc.bottom - rc.top)) + 'px';
      return true;
    }

    function setCaret(el, at) {
      const pos = at === null || at === undefined ? el.value.length : at;
      if (el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (err) { /* not a text control */ } }
    }

    /**
     * Open the editor on (g.r, g.c). `init`: { value, seed, caret } to start with text (typing, or
     * reopening after a rejected formula); otherwise the seed is requested from the host.
     */
    function open(g, init) {
      const cell = grid().getCell(g.r, g.c);
      if (cell && cell.ro) { OC.hint(LOCKED_CELL_HINT); return true; }
      const e = {
        sheetId: shell.state.shownSheetId, r: g.r, c: g.c, where: 'cell', el: cellInput,
        seed: null, awaiting: false, seedId: 0,
      };
      if (g.bar || !place(e)) { e.where = 'bar'; e.el = barInput; }
      ed = e;
      if (e.where === 'bar') {
        bar.display.hidden = true;
        if (bar.staleMark) { bar.staleMark.hidden = true; }
      }
      e.el.setAttribute('aria-label', e.where === 'bar' ? 'Formula bar' : 'Edit cell ' + addr(e.r, e.c));
      if (init) {
        e.el.value = init.value;
        e.seed = init.seed === undefined ? null : init.seed;
        e.el.readOnly = false;
      } else {
        e.el.value = '';
        e.el.readOnly = true;
        e.awaiting = true;
        e.seedId = shell.nextId();
        shell.post({ type: 'xlsxRequestCellInput', requestId: e.seedId, sheetId: e.sheetId, r: e.r, c: e.c });
      }
      e.el.hidden = false;
      e.el.focus();
      if (init) { setCaret(e.el, init.caret); }
      return true;
    }

    function close() {
      const e = ed;
      ed = null;
      if (!e) { return null; }
      e.el.hidden = true;
      e.el.readOnly = false;
      e.el.value = '';
      if (e.where === 'bar') {
        bar.display.hidden = false;
        shell.refreshFormulaBar();   // restores the display text and the stale mark
      } else if (bar && bar.display) {
        shell.refreshFormulaBar();   // the display mirrored the typing
      }
      return e;
    }

    function cancel(message) {
      if (!ed) { return; }
      close();
      if (grid()) { grid().focus(); }
      if (message) { OC.announce(message); }
    }

    function discard(message) {
      if (!ed) { return; }
      close();
      OC.hint(message);
    }

    function hiddenSet(list) { return new Set(Array.isArray(list) ? list : []); }

    function moveActive(r, c, dr, dc) {
      const meta = shell.state.meta;
      if (!meta || !grid()) { return; }
      const hr = hiddenSet(meta.hiddenRows), hc = hiddenSet(meta.hiddenCols);
      let nr = r, nc = c;
      do { nr += dr; } while (dr !== 0 && hr.has(nr) && nr > 0 && nr < meta.rowCount - 1);
      do { nc += dc; } while (dc !== 0 && hc.has(nc) && nc > 0 && nc < meta.colCount - 1);
      nr = Math.min(Math.max(0, nr), Math.max(0, meta.rowCount - 1));
      nc = Math.min(Math.max(0, nc), Math.max(0, meta.colCount - 1));
      if (hr.has(nr) || hc.has(nc)) { return; }
      grid().setActive(nr, nc);
    }

    /**
     * Commit the open editor: post `setCells` unless the text equals the seed (an unchanged commit is a
     * no-op), then move. Resolves when the host has answered (immediately when nothing was sent).
     */
    function commit(opts) {
      const o = opts || {};
      const e = ed;
      if (!e) { return Promise.resolve(); }
      if (e.awaiting) { cancel(); return Promise.resolve(); }   // nothing was typed yet
      const text = e.el.value;
      close();
      if (o.move) { moveActive(e.r, e.c, o.move.dr, o.move.dc); }
      if (o.focus !== false && grid()) { grid().focus(); }
      if (e.seed !== null && text === e.seed) { return Promise.resolve(); }
      return send(
        { op: 'setCells', sheetId: e.sheetId, cells: [{ r: e.r, c: e.c, input: text }] },
        {
          kind: 'cell', sheetId: e.sheetId, r: e.r, c: e.c, seed: e.seed,
          formulaInput: text.length > 1 && text[0] === '=' ? text : undefined,
          announce: 'Updated ' + addr(e.r, e.c),
        },
      );
    }

    function onEditorKey(ev) {
      if (!ed || ev.target !== ed.el) { return; }
      const ctrl = ev.ctrlKey || ev.metaKey;
      const k = ev.key;
      const stop = () => { if (ev.preventDefault) { ev.preventDefault(); } };
      if (k === 'Enter' && !ctrl && !ev.altKey) { stop(); commit({ move: { dr: ev.shiftKey ? -1 : 1, dc: 0 } }); }
      else if (k === 'Tab' && !ctrl && !ev.altKey) { stop(); commit({ move: { dr: 0, dc: ev.shiftKey ? -1 : 1 } }); }
      else if (k === 'Escape') { stop(); cancel('Edit cancelled'); }
      else if (ctrl && !ev.altKey && (k === 'PageUp' || k === 'PageDown')) { commit({ focus: false }); }
    }
    [cellInput, barInput].forEach((el) => {
      el.addEventListener('keydown', onEditorKey);
      el.addEventListener('input', () => {
        if (ed && ed.el === el && ed.where === 'cell' && bar && bar.display) { bar.display.textContent = el.value; }
      });
      el.addEventListener('blur', (ev) => {
        if (!ed || ed.el !== el || ed.awaiting) { return; }
        const to = ev && ev.relatedTarget;
        if (to === cellInput || to === barInput) { return; }
        if (doc.hasFocus && !doc.hasFocus()) { return; }   // the window lost focus: keep the edit open
        commit({ focus: false });
      });
    });

    // Undo/redo while an editor is open (spec §16 S3 fallback): capture phase, before VS Code sees the key.
    win.addEventListener('keydown', (ev) => {
      if (!ed || !(ev.ctrlKey || ev.metaKey) || ev.altKey) { return; }
      const k = String(ev.key).toLowerCase();
      const undo = k === 'z' && !ev.shiftKey;
      const redo = k === 'y' || (k === 'z' && ev.shiftKey);
      if (!undo && !redo) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      if (ev.stopPropagation) { ev.stopPropagation(); }
      if (undo) { cancel('Edit cancelled'); }
    }, true);

    // ---------------------------------------------------------------- gestures

    function clear(g) {
      const sheetId = shell.state.shownSheetId;
      const rg = Array.isArray(g.range) && g.range.length >= 4 ? g.range.slice(0, 4) : [g.r, g.c, g.r, g.c];
      send({ op: 'clearCells', sheetId, range: rg }, { kind: 'clear', sheetId, announce: 'Cleared' });
      return true;
    }

    function onGesture(g) {
      if (!g || !grid() || shell.state.shownSheetId === null) { return false; }
      if (g.kind === 'delete') { return ed ? false : clear(g); }
      if (g.kind === 'f2' || g.kind === 'enter' || g.kind === 'dblclick' || g.kind === 'type') {
        if (ed) {
          if (ed.r === g.r && ed.c === g.c) { return true; }
          commit({ focus: false });
        }
        if (g.kind === 'type') { return open(g, { value: g.text, seed: null, caret: null }); }
        return open(g, null);
      }
      return false;
    }

    // ---------------------------------------------------------------- paste

    function targetIsText(t) { return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }

    function onPaste(ev) {
      if (ed || targetIsText(ev.target)) { return; }   // native paste inside an input
      if (!grid() || shell.state.shownSheetId === null || !shell.state.meta) { return; }
      const stop = () => { if (ev.preventDefault) { ev.preventDefault(); } };
      if (!OC.canEdit()) { return; }
      if (!OC.isEditMode()) { stop(); OC.hint(OC.EDIT_HINT); return; }
      const info = sheetInfo(shell.state.shownSheetId);
      if (!info || !info.canEdit) {
        stop();
        OC.hint((info && info.readOnlyReason && OC.READ_ONLY_TEXT[info.readOnlyReason]) || 'This sheet is read-only.');
        return;
      }
      const text = ev.clipboardData && ev.clipboardData.getData ? ev.clipboardData.getData('text/plain') : '';
      stop();
      const rows = parseTsv(text || '');
      if (!rows.length) { return; }
      let count = 0, width = 0;
      for (const row of rows) { count += row.length; width = Math.max(width, row.length); }
      if (count > MAX_PASTE_CELLS) {
        OC.hint('At most ' + MAX_PASTE_CELLS.toLocaleString('en-US') + ' cells can be pasted at once.');
        return;
      }
      const a = grid().getSelection().active;
      if (a.r + rows.length > MAX_ROWS || a.c + width > MAX_COLS) { OC.hint('The pasted data does not fit on the sheet.'); return; }
      const cells = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          if (rows[i][j].length > MAX_CELL_CHARS) {
            OC.hint('A pasted cell is longer than ' + MAX_CELL_CHARS.toLocaleString('en-US') + ' characters.');
            return;
          }
          cells.push({ r: a.r + i, c: a.c + j, input: rows[i][j] });
        }
      }
      const sheetId = shell.state.shownSheetId;
      send({ op: 'setCells', sheetId, cells }, { kind: 'paste', sheetId, announce: 'Pasted ' + count + (count === 1 ? ' cell' : ' cells') });
      if (grid().setSelection) { grid().setSelection(a.r, a.c, a.r + rows.length - 1, a.c + width - 1); }
    }
    win.addEventListener('paste', onPaste);

    // ---------------------------------------------------------------- formula bar

    if (bar && bar.display) {
      const activate = () => {
        if (ed || !grid() || !OC.isEditMode() || shell.state.shownSheetId === null) { return; }
        const a = grid().getSelection().active;
        shell.editGesture({ kind: 'f2', r: a.r, c: a.c, bar: true });
      };
      bar.display.addEventListener('click', activate);
      bar.display.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === 'F2') { if (ev.preventDefault) { ev.preventDefault(); } activate(); }
      });
    }

    // ---------------------------------------------------------------- host messages

    function onMessage(msg) {
      switch (msg.type) {
        case 'xlsxEditResult': onEditResult(msg); break;
        case 'xlsxCellInput':
          if (ed && ed.awaiting && msg.requestId === ed.seedId && msg.r === ed.r && msg.c === ed.c && msg.sheetId === ed.sheetId) {
            ed.awaiting = false;
            ed.seed = String(msg.input);
            ed.el.value = ed.seed;
            ed.el.readOnly = false;
            ed.el.focus();
            setCaret(ed.el, null);
          }
          break;
        case 'requestFailed':
          if (ed && ed.awaiting && msg.requestId === ed.seedId) { close(); if (grid()) { grid().focus(); } }
          break;
        case 'xlsxStateChanged': discard(DISCARDED_HINT); break;
        case 'editModeChanged': if (!msg.editMode) { discard(DISCARDED_HINT); } break;
        case 'init': case 'loadError': discard(DISCARDED_HINT); break;
        case 'notices': {
          // The host flags a rich-text cell with a notice sent before its seed: show it as a hint,
          // not as a standing banner.
          const list = Array.isArray(msg.notices) ? msg.notices : [];
          const rich = list.find((n) => n && n.code === RICH_CODE);
          if (rich) {
            OC.showNotices(list.filter((n) => !(n && n.code === RICH_CODE)));
            OC.hint(rich.message);
          }
          break;
        }
        default: break;
      }
    }

    /** Commit what is open and wait for the host's reply; gives up after FLUSH_WAIT_MS so a save never hangs. */
    function flush() {
      const work = (ed ? commit({ focus: false }) : Promise.resolve()).then(() => whenIdle());
      return new Promise((resolve) => {
        const timer = setTimer(resolve, FLUSH_WAIT_MS);
        work.then(() => { if (clearTimer) { clearTimer(timer); } resolve(); });
      });
    }

    shell.registerCellEditor(onGesture);
    shell.registerMessageHandler(onMessage);
    shell.registerFlushHandler(flush);
    OC.setBeforeEditModeOff(flush);

    return {
      onGesture, commit, cancel, flush, whenIdle,
      isEditing() { return ed !== null; },
      current() { return ed ? { r: ed.r, c: ed.c, where: ed.where, value: ed.el.value, awaiting: ed.awaiting } : null; },
      cellInput, barInput,
    };
  }

  const api = { create, parseTsv, caretFromMessage, MAX_PASTE_CELLS };
  global.XlsxCellEditor = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

  // Auto-attach inside the webview, once xlsxEditor.js has created the shell.
  if (global.XlsxShell && global.document && typeof global.acquireVsCodeApi === 'function') {
    global.XlsxCellEditorInstance = create(global.XlsxShell, { document: global.document, window: global, OfficeCommon: global.OfficeCommon });
  }
})(typeof window !== 'undefined' ? window : globalThis);
