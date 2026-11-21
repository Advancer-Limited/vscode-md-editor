// @ts-nocheck
// Excel structure UI (WP-41, spec §5.2, §9.6, §9.7, §11.2, §11.3). Plugs into the viewer shell
// (`XlsxShell.registerMenuItems`, `registerMessageHandler`, the tab strip) and sends its edits through
// the cell editor's serial queue (`XlsxCellEditorInstance.send`), so a structural edit never races a
// cell edit and always carries the version the previous reply reported.
//
// What it adds: row / column header and cell context-menu entries (Insert above / below / left /
// right, Delete rows / columns, with counts taken from the selection), a sheet-tab context menu (Add,
// Rename, Delete), a "+" button, and an inline tab editor for Rename with live validation messages
// that mirror the host's sheet-name rules (the host stays the authority and answers `invalid`).
// Keyboard: Shift+F10 / the Menu key on the grid opens the cell menu (Insert/Delete entries are in
// it); on a focused sheet tab Shift+F10 / the Menu key opens the tab menu and F2 renames. The spec
// (§11.3) calls for no Excel-style Insert dialog, so Ctrl+Shift+= / Ctrl+- are not bound.
//
// Everything is off (nothing registered, no button) unless the host rendered
// `data-structure="on"` (OFFICE_FLAGS.xlsxStructure); the host also refuses structural edits then.
// Entries are disabled outside Edit mode and hidden when the document can never be edited.
//
// Security rule (plan §1.8): sheet names and every other document-derived string only reach the DOM
// through `value` / `textContent` / `setAttribute`; there is no HTML string building here.
(function (global) {
  'use strict';

  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;
  const MAX_NAME = 31;
  const BAD_CHARS = /[\\/?*[\]:]/;
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f]/;

  /** Spec §5.2 / §9.7 sheet-name rules; null when valid, else the message to show. */
  function validateSheetName(name, others) {
    if (typeof name !== 'string' || name.length === 0) { return 'The sheet name cannot be empty.'; }
    if (name.length > MAX_NAME) { return 'The sheet name can be at most ' + MAX_NAME + ' characters (now ' + name.length + ').'; }
    if (BAD_CHARS.test(name)) { return 'The sheet name cannot contain any of : \\ / ? * [ ]'; }
    if (CONTROL.test(name)) { return 'The sheet name cannot contain control characters.'; }
    if (name.charAt(0) === "'" || name.charAt(name.length - 1) === "'") { return 'The sheet name cannot start or end with an apostrophe.'; }
    const fold = name.toLowerCase();
    if (fold === 'history') { return '"History" is a name Excel reserves; choose another sheet name.'; }
    if ((others || []).some((n) => String(n).toLowerCase() === fold)) { return 'A sheet named "' + name + '" already exists.'; }
    return null;
  }

  const plural = (n, one, many) => (n === 1 ? one : n + ' ' + many);

  function create(shell, deps) {
    const d = deps || {};
    const doc = d.document || global.document;
    const OC = d.OfficeCommon || global.OfficeCommon;
    const app = doc.getElementById('office-app');
    const enabledByHost = !!app && app.getAttribute('data-structure') === 'on';
    const api = { enabled: enabledByHost, validateSheetName };
    if (!enabledByHost) { return api; }

    let renaming = null;        // { sheetId, wrap, input, msg, settled }
    let expectSelect = false;   // an addSheet succeeded: the next xlsxWorkbook's active sheet is the new one
    let pendingSel = null;      // selection to re-apply once the refetched meta is in

    function mk(tag, className, text) {
      const e = doc.createElement(tag);
      if (className) { e.className = className; }
      if (text !== undefined && text !== null) { e.textContent = String(text); }
      return e;
    }
    const editor = () => d.cellEditor || global.XlsxCellEditorInstance || null;
    const grid = () => shell.grid;
    const sheetById = (id) => shell.state.sheets.find((s) => s.id === id) || null;

    // ---------- gating ----------

    /** { show, ok, why }: hidden for a document that can never be edited, disabled outside Edit mode. */
    function gate(needSheet) {
      if (!OC.canEdit()) { return { show: false, ok: false, why: '' }; }
      if (!OC.isEditMode()) { return { show: true, ok: false, why: OC.EDIT_HINT }; }
      if (needSheet) {
        const info = sheetById(shell.state.shownSheetId);
        if (!info || info.kind !== 'worksheet' || !shell.state.meta || shell.state.meta.sheetId !== info.id) {
          return { show: true, ok: false, why: 'Select a worksheet first.' };
        }
        if (!info.canEdit) {
          return { show: true, ok: false, why: (info.readOnlyReason && OC.READ_ONLY_TEXT[info.readOnlyReason]) || 'This sheet is read-only.' };
        }
      }
      return { show: true, ok: true, why: '' };
    }

    // ---------- sending ----------

    /** Commit an open cell editor first, then queue `op` behind the edits already in flight. */
    function run(op, announce, after) {
      const ed = editor();
      if (!ed || !ed.send) { OC.hint('Editing is not available.'); return Promise.resolve(); }
      const commit = ed.isEditing && ed.isEditing() && ed.commit ? ed.commit({ focus: false }) : null;
      return Promise.resolve(commit).then(() => ed.send(op, {
        announce,
        onResult: (msg) => { if (msg && msg.ok && after) { after(msg); } },
      }));
    }

    function applySelection(sel) {
      const g = grid();
      if (!sel || !g) { return; }
      if (sel.r1 === sel.r0 && sel.c1 === sel.c0) { g.setActive(sel.r0, sel.c0); }
      else { g.setSelection(sel.r0, sel.c0, sel.r1, sel.c1); }
    }

    // ---------- row / column menus ----------

    /** The rows or columns an operation covers: the selection when the click is inside it, else just that one. */
    function band(ev, axis) {
      const g = grid();
      const sel = g.getSelection().range;                      // [r0, c0, r1, c1]
      const lo = axis === 'row' ? sel[0] : sel[1];
      const hi = axis === 'row' ? sel[2] : sel[3];
      const idx = axis === 'row' ? ev.r : ev.c;
      if (typeof idx !== 'number' || (idx >= lo && idx <= hi)) { return { lo, hi }; }
      return { lo: idx, hi: idx };
    }

    function structural(op, axis, at, count, cover) {
      const sheetId = shell.state.shownSheetId;
      const rows = axis === 'row';
      const insert = op.indexOf('insert') === 0;
      const noun = rows ? 'row' : 'column';
      const what = count + ' ' + noun + (count === 1 ? '' : 's');
      const announce = insert ? 'Inserted ' + what + ' ' + cover.where : 'Deleted ' + what;
      const a = grid().getSelection().active;
      // Remember the cross-axis extent so the new band can be selected the way Excel does it.
      const keep = rows
        ? { c0: grid().getSelection().range[1], c1: grid().getSelection().range[3] }
        : { r0: grid().getSelection().range[0], r1: grid().getSelection().range[2] };
      const after = () => {
        let sel;
        if (insert) {
          sel = rows ? { r0: at, r1: at + count - 1, c0: keep.c0, c1: keep.c1 }
            : { c0: at, c1: at + count - 1, r0: keep.r0, r1: keep.r1 };
        } else {
          sel = rows ? { r0: at, r1: at, c0: a.c, c1: a.c } : { r0: a.r, r1: a.r, c0: at, c1: at };
        }
        pendingSel = sel;
        applySelection(sel);   // re-applied once the refetched meta is in (see onMessage)
      };
      return run({ op, sheetId, at, count }, announce, after);
    }

    function axisItems(ev, axis, g) {
      const rows = axis === 'row';
      const { lo, hi } = band(ev, axis);
      const n = hi - lo + 1;
      const max = rows ? MAX_ROWS : MAX_COLS;
      const noun = rows ? 'row' : 'column';
      const ok = g.ok;
      const insertLabel = (side) => 'Insert ' + plural(n, noun, noun + 's') + ' ' + side;
      const before = rows ? 'above' : 'left';
      const afterSide = rows ? 'below' : 'right';
      const opIns = rows ? 'insertRows' : 'insertCols';
      const opDel = rows ? 'deleteRows' : 'deleteCols';
      return [
        { id: opIns + '-before', label: insertLabel(before), disabled: !ok || lo >= max,
          onClick: () => structural(opIns, axis, lo, n, { where: rows ? 'above' : 'left' }) },
        { id: opIns + '-after', label: insertLabel(afterSide), disabled: !ok || hi + 1 >= max,
          onClick: () => structural(opIns, axis, hi + 1, n, { where: rows ? 'below' : 'right' }) },
        { id: opDel, label: 'Delete ' + plural(n, noun, noun + 's'), disabled: !ok,
          onClick: () => structural(opDel, axis, lo, n, {}) },
      ];
    }

    function menuItems(ev) {
      const target = ev && ev.target;
      if (target !== 'cell' && target !== 'rowHeader' && target !== 'colHeader') { return []; }
      const g = gate(true);
      if (!g.show || !grid()) { return []; }
      if (target === 'rowHeader' || target === 'colHeader') {
        // Right-clicking a header outside the selection selects that whole row / column first (as Excel does).
        const axis = target === 'rowHeader' ? 'row' : 'col';
        const sel = grid().getSelection().range;
        const idx = axis === 'row' ? ev.r : ev.c;
        const inside = axis === 'row' ? idx >= sel[0] && idx <= sel[2] : idx >= sel[1] && idx <= sel[3];
        const meta = shell.state.meta;
        if (typeof idx === 'number' && !inside && meta) {
          if (axis === 'row') { grid().setSelection(idx, 0, idx, Math.max(0, meta.colCount - 1)); }
          else { grid().setSelection(0, idx, Math.max(0, meta.rowCount - 1), idx); }
        }
        return axisItems(ev, axis, g);
      }
      return axisItems(ev, 'row', g).concat([{ id: 'sep-structure', separator: true }], axisItems(ev, 'col', g));
    }

    // ---------- sheet tabs ----------

    const addBtn = mk('button', 'office-btn xlsx-add-tab', '+');
    addBtn.setAttribute('type', 'button');
    addBtn.setAttribute('aria-label', 'Add sheet');
    addBtn.setAttribute('title', 'Add sheet');
    if (shell.tabsBar && shell.hiddenBtn) { shell.tabsBar.insertBefore(addBtn, shell.hiddenBtn); }
    else if (shell.tabsBar) { shell.tabsBar.appendChild(addBtn); }

    function refreshButton() {
      const g = gate(false);
      addBtn.hidden = !g.show;
      addBtn.disabled = !g.ok;
      if (g.ok) { addBtn.removeAttribute('aria-disabled'); } else { addBtn.setAttribute('aria-disabled', 'true'); }
    }

    function addSheet(afterId) {
      const g = gate(false);
      if (!g.ok) { if (g.why) { OC.hint(g.why); } return Promise.resolve(); }
      const op = { op: 'addSheet' };
      const after = afterId !== undefined && afterId !== null ? afterId : shell.state.activeSheetId;
      if (after !== null && after !== undefined && sheetById(after)) { op.afterSheetId = after; }
      return run(op, 'Sheet added', () => { expectSelect = true; });
    }

    function deleteSheet(id) {
      const g = gate(false);
      const info = sheetById(id);
      if (!g.ok || !info) { if (g.why) { OC.hint(g.why); } return Promise.resolve(); }
      // The host asks for confirmation (always, for a sheet) and answers `cancelled` on dismiss.
      return run({ op: 'deleteSheet', sheetId: id }, 'Sheet deleted', null);
    }

    function tabButton(id) {
      const kids = shell.tabList ? Array.from(shell.tabList.children) : [];
      return kids.find((k) => k.getAttribute && k.getAttribute('data-sheet-id') === String(id)) || null;
    }

    function endRename(focusTab) {
      const r = renaming;
      if (!r) { return; }
      renaming = null;
      r.settled = true;
      if (shell.renderTabs) { shell.renderTabs(); }
      if (focusTab) {
        const b = tabButton(r.sheetId);
        if (b && b.focus) { b.focus(); }
      }
    }

    function otherNames(id) { return shell.state.sheets.filter((s) => s.id !== id).map((s) => s.name); }

    function liveValidate() {
      const r = renaming;
      if (!r) { return null; }
      const problem = validateSheetName(r.input.value, otherNames(r.sheetId));
      r.msg.textContent = problem || '';
      r.msg.hidden = !problem;
      if (problem) { r.input.setAttribute('aria-invalid', 'true'); } else { r.input.removeAttribute('aria-invalid'); }
      return problem;
    }

    function commitRename() {
      const r = renaming;
      if (!r) { return; }
      const info = sheetById(r.sheetId);
      const name = r.input.value;
      if (!info || name === info.name) { endRename(true); return; }
      if (liveValidate()) { r.input.focus(); return; }
      const id = r.sheetId;
      endRename(true);
      run({ op: 'renameSheet', sheetId: id, name }, 'Sheet renamed to ' + name, null);
    }

    function startRename(id) {
      const g = gate(false);
      const info = sheetById(id);
      if (!g.ok || !info) { if (g.why) { OC.hint(g.why); } return; }
      if (renaming) { endRename(false); }
      const btn = tabButton(id);
      if (!btn || !shell.tabList) { return; }
      const wrap = mk('div', 'xlsx-tab-rename');
      const input = mk('input', 'xlsx-tab-rename-input');
      input.setAttribute('type', 'text');
      input.setAttribute('aria-label', 'Sheet name');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('maxlength', '255');
      input.value = info.name;
      const msg = mk('div', 'xlsx-tab-rename-msg', '');
      msg.setAttribute('role', 'alert');
      msg.hidden = true;
      msg.id = 'xlsx-rename-msg';
      input.setAttribute('aria-describedby', msg.id);
      wrap.appendChild(input);
      wrap.appendChild(msg);
      shell.tabList.replaceChild(wrap, btn);
      renaming = { sheetId: id, wrap, input, msg, settled: false };
      input.addEventListener('input', liveValidate);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { if (ev.preventDefault) { ev.preventDefault(); } commitRename(); }
        else if (ev.key === 'Escape') { if (ev.preventDefault) { ev.preventDefault(); } if (ev.stopPropagation) { ev.stopPropagation(); } endRename(true); }
        else if (ev.stopPropagation) { ev.stopPropagation(); }   // keep tab-strip arrow keys out of the text box
      });
      input.addEventListener('blur', () => {
        const r = renaming;
        if (!r || r.settled) { return; }
        // Leaving the box commits a valid name and discards an invalid or unchanged one (as Excel does).
        if (validateSheetName(input.value, otherNames(r.sheetId)) === null && input.value !== info.name) { commitRename(); }
        else { endRename(false); }
      });
      input.focus();
      if (input.select) { input.select(); }
    }

    function tabMenu(id, x, y, returnTo) {
      const g = gate(false);
      if (!g.show) { return; }
      const items = [
        { id: 'add-sheet', label: 'Add sheet', disabled: !g.ok, onClick: () => addSheet(id) },
        { id: 'rename-sheet', label: 'Rename', disabled: !g.ok, onClick: () => startRename(id) },
        { id: 'delete-sheet', label: 'Delete sheet', disabled: !g.ok, onClick: () => deleteSheet(id) },
      ];
      shell.openMenu(items, x, y, { up: true, label: 'Sheet menu', returnTo });
    }

    function tabFromTarget(t) {
      let n = t;
      while (n && n !== shell.tabList) {
        if (n.getAttribute && n.getAttribute('data-sheet-id') !== null && n.getAttribute('role') === 'tab') { return n; }
        n = n.parentNode;
      }
      return null;
    }

    if (shell.tabList) {
      shell.tabList.addEventListener('contextmenu', (ev) => {
        const tab = tabFromTarget(ev.target);
        if (!tab) { return; }
        if (ev.preventDefault) { ev.preventDefault(); }
        tabMenu(Number(tab.getAttribute('data-sheet-id')), ev.clientX, ev.clientY, tab);
      });
      shell.tabList.addEventListener('dblclick', (ev) => {
        const tab = tabFromTarget(ev.target);
        if (tab) { startRename(Number(tab.getAttribute('data-sheet-id'))); }
      });
      shell.tabList.addEventListener('keydown', (ev) => {
        const tab = tabFromTarget(ev.target);
        if (!tab) { return; }
        const id = Number(tab.getAttribute('data-sheet-id'));
        if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
          if (ev.preventDefault) { ev.preventDefault(); }
          const rc = tab.getBoundingClientRect ? tab.getBoundingClientRect() : { left: 0, top: 0 };
          tabMenu(id, rc.left, rc.top, tab);
        } else if (ev.key === 'F2') {
          if (ev.preventDefault) { ev.preventDefault(); }
          startRename(id);
        }
      });
    }
    addBtn.addEventListener('click', () => { addSheet(); });

    // ---------- host messages ----------

    function onMessage(msg) {
      switch (msg.type) {
        case 'init': case 'editModeChanged': case 'loadError':
          refreshButton();
          if (renaming && !OC.isEditMode()) { endRename(false); }
          break;
        case 'xlsxWorkbook':
          if (renaming) { renaming.settled = true; renaming = null; }   // the shell re-renders the tabs
          if (expectSelect) { expectSelect = false; shell.state.preferSheetId = msg.activeSheetId; }
          refreshButton();
          break;
        case 'xlsxSheetMeta':
          if (pendingSel) {
            const sel = pendingSel;
            pendingSel = null;
            // The shell has applied the meta by the time this microtask runs.
            Promise.resolve().then(() => applySelection(sel));
          }
          break;
        case 'xlsxEditResult':
          if (msg.ok === false) { pendingSel = null; }
          break;
        default: break;
      }
    }

    shell.registerMenuItems(menuItems);
    shell.registerMessageHandler(onMessage);
    refreshButton();

    return Object.assign(api, {
      menuItems, addSheet, deleteSheet, startRename, tabMenu, refreshButton, gate,
      isRenaming() { return renaming !== null; },
    });
  }

  const exported = { create, validateSheetName };
  global.XlsxStructureUi = exported;
  if (typeof module !== 'undefined' && module.exports) { module.exports = exported; }

  // Auto-attach inside the webview, once the shell and the cell editor exist.
  if (global.XlsxShell && global.document && typeof global.acquireVsCodeApi === 'function') {
    global.XlsxStructureUiInstance = create(global.XlsxShell, { document: global.document, OfficeCommon: global.OfficeCommon });
  }
})(typeof window !== 'undefined' ? window : globalThis);
