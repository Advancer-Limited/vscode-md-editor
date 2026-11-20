// Excel viewer shell (WP-16, spec §7.2, §11, §12). Wires the grid (xlsxGrid.js) to the host
// protocol: sheet tabs, formula bar, status bar, find bar, copy, hyperlinks, per-sheet notices,
// a context-menu scaffold and the two plug-in hooks Phase 2/4 use (`registerCellEditor`,
// `registerMenuItems`).
//
// Loaded as a classic script (globals `OfficeCommon`, `XlsxGrid`, `XlsxGridMath`) and via `vm` by
// the unit tests. Security rule (plan §1.8): document-derived strings (sheet names, cell text,
// links, notes, notices) only ever reach the DOM through textContent / setAttribute.
(function (global) {
  'use strict';

  const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];
  const MAX_HREF = 32767;           // PROTOCOL_LIMITS.MAX_HREF
  const MAX_QUERY = 32767;          // PROTOCOL_LIMITS.MAX_QUERY
  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;
  const MAX_FIND = 1000;
  const FIND_DEBOUNCE_MS = 300;
  const SHELL_ID_BASE = 1000000000;  // shell-minted requestIds; the grid owns the small ids
  const INPUT_CACHE_MAX = 200;

  const CHARTSHEET_TEXT = 'This is a chart sheet. Charts are not displayed in this viewer. Open the workbook in Excel to see it.';
  const OTHER_SHEET_TEXT = 'This sheet type is not displayed in this viewer. Open the workbook in Excel to see it.';

  function fmtNum(n) {
    if (!Number.isFinite(n)) { return String(n); }
    return n.toLocaleString('en-US', { maximumFractionDigits: 10 });
  }

  function colIndex(letters) {
    let n = 0;
    const s = letters.toUpperCase();
    for (let i = 0; i < s.length; i++) { n = n * 26 + (s.charCodeAt(i) - 64); }
    return n - 1;
  }

  /** "'My Sheet'!B2:C3", "Sheet1!A1", "A1" -> { sheetName|null, r, c } or null (named ranges etc.). */
  function parseInternalRef(ref) {
    let sheetName = null;
    let addr = String(ref).trim();
    const bang = addr.lastIndexOf('!');
    if (bang >= 0) {
      sheetName = addr.slice(0, bang);
      addr = addr.slice(bang + 1);
      if (sheetName.length >= 2 && sheetName[0] === '\'' && sheetName[sheetName.length - 1] === '\'') {
        sheetName = sheetName.slice(1, -1).replace(/''/g, '\'');
      }
    }
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.exec(addr);
    if (!m) { return null; }
    const c = colIndex(m[1]);
    const r = Number(m[2]) - 1;
    if (!(c >= 0 && c < MAX_COLS && r >= 0 && r < MAX_ROWS)) { return null; }
    return { sheetName, r, c };
  }

  function create(deps) {
    const { document, vscode, OfficeCommon, window, XlsxGrid } = deps;
    const math = deps.math || global.XlsxGridMath;
    const setTimer = deps.setTimeout || global.setTimeout;
    const clearTimer = deps.clearTimeout || global.clearTimeout;

    const app = document.getElementById('office-app');
    const toolbarEl = document.getElementById('office-toolbar');
    const bannerEl = document.getElementById('office-banner');
    const content = document.getElementById('office-content');
    const brandEl = document.getElementById('office-brand');

    const state = {
      version: 0,
      sheets: [],
      activeSheetId: null,    // the tab the user selected
      shownSheetId: null,     // the sheet whose meta is in the grid (or whose placeholder is up)
      pendingSheetId: null,   // a sheet whose meta was requested and has not arrived
      meta: null,
      placeholder: null,      // null | 'chart' | 'other' | 'unavailable' | 'empty'
      editMode: false,
    };
    const find = {
      open: false, query: '', matchCase: false, allSheets: false,
      matches: [], truncated: false, index: -1,
      pendingId: null, pendingInclusive: true, pendingDir: 1, dirty: true, timer: null,
    };
    let idCounter = SHELL_ID_BASE;
    let pendingTarget = null;           // { sheetId, r, c } applied once that sheet's meta arrives
    let pendingInput = null;            // { id, sheetId, r, c, version }
    const inputCache = new Map();       // "sheetId:r:c:version" -> formula text
    const lastActive = new Map();       // sheetId -> { r, c } so tab switching keeps the cursor
    let cellEditor = null;
    const menuProviders = [];
    let openMenuEl = null;
    let menuReturnFocus = null;
    let gridApi = null;
    let tb = null;

    function mk(tag, className, text) {
      const e = document.createElement(tag);
      if (className) { e.className = className; }
      if (text !== undefined && text !== null) { e.textContent = String(text); }
      return e;
    }
    function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
    function post(msg) { vscode.postMessage(msg); }
    function nextId() { return ++idCounter; }
    function button(label, title, onClick, extraClass) {
      const b = mk('button', 'office-btn' + (extraClass ? ' ' + extraClass : ''), label);
      b.setAttribute('type', 'button');
      b.setAttribute('aria-label', title || label);
      if (title) { b.setAttribute('title', title); }
      if (onClick) { b.addEventListener('click', onClick); }
      return b;
    }

    function sheetInfo(id) { return state.sheets.find((s) => s.id === id) || null; }
    function sheetOrder(id) { return state.sheets.findIndex((s) => s.id === id); }
    function shownInfo() { return state.shownSheetId === null ? null : sheetInfo(state.shownSheetId); }
    function worksheetShown() {
      const i = shownInfo();
      return !!(i && i.kind === 'worksheet' && state.meta && state.meta.sheetId === i.id);
    }

    // ---------- skeleton ----------

    const formulaBar = mk('div', 'xlsx-formula-bar');
    const nameBox = mk('div', 'xlsx-namebox', '');
    nameBox.setAttribute('role', 'textbox');
    nameBox.setAttribute('aria-readonly', 'true');
    nameBox.setAttribute('aria-label', 'Name box');
    nameBox.setAttribute('tabindex', '0');
    const fx = mk('span', 'xlsx-fx', 'fx');
    fx.setAttribute('aria-hidden', 'true');
    const formulaText = mk('div', 'xlsx-formula-text', '');
    formulaText.setAttribute('role', 'textbox');
    formulaText.setAttribute('aria-readonly', 'true');
    formulaText.setAttribute('aria-label', 'Formula bar');
    formulaText.setAttribute('tabindex', '0');
    const staleMark = mk('span', 'xlsx-stale', 'Not calculated');
    staleMark.hidden = true;
    formulaBar.appendChild(nameBox);
    formulaBar.appendChild(fx);
    formulaBar.appendChild(formulaText);
    formulaBar.appendChild(staleMark);

    const findBar = mk('div', 'xlsx-find');
    findBar.setAttribute('role', 'search');
    findBar.setAttribute('aria-label', 'Find in workbook');
    findBar.hidden = true;
    const findInput = mk('input', 'xlsx-find-input');
    findInput.setAttribute('type', 'text');
    findInput.setAttribute('aria-label', 'Find');
    findInput.setAttribute('placeholder', 'Find');
    findInput.setAttribute('spellcheck', 'false');
    findInput.setAttribute('maxlength', String(MAX_QUERY));
    const matchCaseBtn = button('Aa', 'Match case', null);
    matchCaseBtn.setAttribute('aria-pressed', 'false');
    const scopeBtn = button('All sheets', 'Search all sheets', null);
    scopeBtn.setAttribute('aria-pressed', 'false');
    const prevBtn = button('Previous', 'Previous match (Shift+Enter)', null);
    const nextBtn = button('Next', 'Next match (Enter)', null);
    const closeBtn = button('Close', 'Close find (Escape)', null);
    const findCount = mk('span', 'xlsx-find-count', '');
    findCount.setAttribute('role', 'status');
    findCount.setAttribute('aria-live', 'polite');
    [findInput, matchCaseBtn, scopeBtn, prevBtn, nextBtn, findCount, closeBtn].forEach((n) => findBar.appendChild(n));

    const gridHost = mk('div', 'xlsx-grid-host');
    const placeholder = mk('div', 'xlsx-placeholder');
    placeholder.setAttribute('role', 'region');
    placeholder.setAttribute('aria-label', 'Sheet not displayed');
    placeholder.hidden = true;
    const placeholderText = mk('p', 'xlsx-placeholder-text', '');
    const placeholderBtn = button('Open in Excel', 'Open in Excel', () => post({ type: 'openExternally' }), 'office-btn-primary');
    placeholder.appendChild(placeholderText);
    placeholder.appendChild(placeholderBtn);

    const tabsBar = mk('div', 'xlsx-tabs-bar');
    const tabList = mk('div', 'xlsx-tablist');
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Sheets');
    const hiddenBtn = button('Hidden sheets', 'Hidden sheets', null, 'xlsx-hidden-btn');
    hiddenBtn.setAttribute('aria-haspopup', 'menu');
    hiddenBtn.setAttribute('aria-expanded', 'false');
    hiddenBtn.hidden = true;
    tabsBar.appendChild(tabList);
    tabsBar.appendChild(hiddenBtn);

    const statusBar = mk('div', 'xlsx-status');
    const statusSel = mk('span', 'xlsx-status-selection', '');
    const statusHint = mk('span', 'xlsx-status-hint', '');
    const statusStats = mk('span', 'xlsx-status-stats', '');
    statusStats.setAttribute('title', 'Sum, average and count of the selected numeric cells that are loaded');
    statusBar.appendChild(statusSel);
    statusBar.appendChild(statusHint);
    statusBar.appendChild(statusStats);

    const noteEl = mk('div', 'xlsx-note-text', '');
    noteEl.hidden = true;

    [formulaBar, findBar, noteEl, gridHost, placeholder, tabsBar, statusBar].forEach((n) => content.appendChild(n));

    // ---------- toolbar ----------

    function buildToolbar() {
      toolbarEl.setAttribute('aria-label', 'Excel viewer');
      tb = OfficeCommon.toolbar(toolbarEl, [
        { id: 'find', label: 'Find', title: 'Find (Ctrl+F)', onClick: () => openFind() },
        { id: 'copy', label: 'Copy', title: 'Copy selection (Ctrl+C)', onClick: () => doCopy() },
        { id: 'openExternally', label: 'Open in Excel', title: 'Open in Excel', onClick: () => post({ type: 'openExternally' }) },
      ]);
      const brand = brandEl && brandEl.firstElementChild;
      if (brand) {
        toolbarEl.appendChild(brand);
        brand.addEventListener('click', () => post({ type: 'showAbout' }));
      }
    }

    // ---------- per-sheet notices ----------

    function showSheetNotices(notices) {
      clear(bannerEl);
      const list = Array.isArray(notices) ? notices : [];
      bannerEl.setAttribute('role', 'region');
      bannerEl.setAttribute('aria-label', 'Sheet notices');
      list.forEach((n) => {
        const sev = n && n.severity === 'warning' ? 'warning' : 'info';
        const row = mk('div', 'office-notice office-notice-' + sev);
        row.appendChild(mk('span', 'office-notice-label', sev === 'warning' ? 'Warning: ' : 'Info: '));
        row.appendChild(mk('span', 'office-notice-text', n && n.message));
        bannerEl.appendChild(row);
      });
      bannerEl.hidden = list.length === 0;
    }

    // ---------- tabs ----------

    function visibleTabs() {
      const tabs = state.sheets.filter((s) => s.state === 'visible');
      const active = sheetInfo(state.activeSheetId);
      if (active && active.state !== 'visible') { tabs.push(active); }   // a viewed hidden sheet gets a temporary tab
      return tabs;
    }
    function hiddenSheets() { return state.sheets.filter((s) => s.state !== 'visible'); }

    function tabLabel(s) {
      let t = s.name;
      if (s.state === 'hidden') { t += ' (hidden)'; }
      else if (s.state === 'veryHidden') { t += ' (very hidden)'; }
      if (s.kind === 'chartsheet') { t += ' (chart)'; }
      return t;
    }

    function renderTabs() {
      clear(tabList);
      const tabs = visibleTabs();
      tabs.forEach((s) => {
        const selected = s.id === state.activeSheetId;
        const b = mk('button', 'xlsx-tab' + (selected ? ' xlsx-tab-active' : ''), tabLabel(s));
        b.setAttribute('type', 'button');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', selected ? 'true' : 'false');
        b.setAttribute('tabindex', selected ? '0' : '-1');
        b.setAttribute('data-sheet-id', String(s.id));
        b.addEventListener('click', () => { selectSheet(s.id); });
        tabList.appendChild(b);
      });
      if (!tabs.some((s) => s.id === state.activeSheetId) && tabList.children[0]) {
        tabList.children[0].setAttribute('tabindex', '0');
      }
      const hidden = hiddenSheets();
      hiddenBtn.hidden = hidden.length === 0;
      hiddenBtn.textContent = 'Hidden sheets (' + hidden.length + ')';
    }

    tabList.addEventListener('keydown', (ev) => {
      const tabs = Array.from(tabList.children);
      const cur = tabs.indexOf(ev.target);
      let to = -1;
      if (ev.key === 'ArrowRight') { to = (cur + 1) % tabs.length; }
      else if (ev.key === 'ArrowLeft') { to = (cur - 1 + tabs.length) % tabs.length; }
      else if (ev.key === 'Home') { to = 0; }
      else if (ev.key === 'End') { to = tabs.length - 1; }
      if (to < 0 || !tabs.length) { return; }
      if (ev.preventDefault) { ev.preventDefault(); }
      tabs.forEach((t, i) => t.setAttribute('tabindex', i === to ? '0' : '-1'));
      tabs[to].focus();
    });

    function showHiddenMenu() {
      const items = hiddenSheets().map((s) => ({
        id: 'sheet-' + s.id, label: tabLabel(s), onClick: () => selectSheet(s.id),
      }));
      if (!items.length) { return; }
      const rc = hiddenBtn.getBoundingClientRect ? hiddenBtn.getBoundingClientRect() : { left: 0, top: 0 };
      hiddenBtn.setAttribute('aria-expanded', 'true');
      openMenu(items, rc.left, rc.top, { up: true, label: 'Hidden sheets', returnTo: hiddenBtn });
    }
    hiddenBtn.addEventListener('click', showHiddenMenu);

    function switchRelative(delta) {
      const tabs = visibleTabs();
      if (tabs.length < 2) { return; }
      const i = tabs.findIndex((s) => s.id === state.activeSheetId);
      const to = tabs[(i + delta + tabs.length) % tabs.length];
      selectSheet(to.id);
    }

    // ---------- sheet loading ----------

    function showPlaceholder(kind, message) {
      state.placeholder = kind;
      state.meta = null;
      placeholderText.textContent = message;
      placeholderBtn.hidden = kind === 'empty';
      placeholder.hidden = false;
      gridHost.hidden = true;
      formulaBar.hidden = true;
      noteEl.hidden = true;
      showSheetNotices([]);
      statusSel.textContent = '';
      statusStats.textContent = '';
      statusHint.textContent = '';
      content.setAttribute('aria-busy', 'false');
    }

    function showGrid() {
      state.placeholder = null;
      placeholder.hidden = true;
      gridHost.hidden = false;
      formulaBar.hidden = false;
    }

    function requestMeta(id) {
      state.pendingSheetId = id;
      content.setAttribute('aria-busy', 'true');
      post({ type: 'xlsxRequestSheetMeta', sheetId: id });
    }

    function rememberActive() {
      if (gridApi && worksheetShown()) {
        const a = gridApi.getSelection().active;
        lastActive.set(state.shownSheetId, { r: a.r, c: a.c });
      }
    }

    /** Make `id` the active tab and load it. Idempotent for a sheet that is shown or already requested. */
    function selectSheet(id, target) {
      const info = sheetInfo(id);
      if (!info) { return false; }
      if (target) { pendingTarget = { sheetId: id, r: target.r, c: target.c }; }
      else if (id !== state.activeSheetId) { pendingTarget = null; }
      if (id === state.activeSheetId && (state.shownSheetId === id || state.pendingSheetId === id)) {
        if (target && worksheetShown() && state.shownSheetId === id) { applyTarget(); }
        return true;
      }
      rememberActive();
      state.activeSheetId = id;
      closeMenu();
      renderTabs();
      if (info.kind !== 'worksheet') {
        state.pendingSheetId = null;
        state.shownSheetId = id;
        showPlaceholder(info.kind === 'chartsheet' ? 'chart' : 'other',
          info.kind === 'chartsheet' ? CHARTSHEET_TEXT : OTHER_SHEET_TEXT);
        OfficeCommon.announce(info.name + ': not displayed');
        return true;
      }
      requestMeta(id);
      return true;
    }

    function applyTarget() {
      const t = pendingTarget && pendingTarget.sheetId === state.shownSheetId
        ? pendingTarget : lastActive.get(state.shownSheetId) || null;
      pendingTarget = null;
      if (t && gridApi) { gridApi.setActive(t.r, t.c); }
    }

    function onSheetMeta(meta) {
      if (!meta || meta.sheetId !== state.activeSheetId) { return; }   // foreign or superseded sheet
      if (typeof meta.version === 'number' && meta.version < state.version) { return; }
      const info = sheetInfo(meta.sheetId);
      if (!info || info.kind !== 'worksheet') { return; }
      if (state.pendingSheetId === meta.sheetId) { state.pendingSheetId = null; }
      showGrid();
      state.meta = meta;
      state.shownSheetId = meta.sheetId;
      content.setAttribute('aria-busy', 'false');
      if (!gridApi.setMeta(meta)) {
        state.meta = null;
        OfficeCommon.hint('This sheet could not be displayed.');
        return;
      }
      applyEditability();
      showSheetNotices(meta.notices);
      applyTarget();
      refreshFormulaBar();
      refreshStatus();
    }

    function onNotices(notices) {
      // `xlsxRequestSheetMeta` has no requestId: a failed sheet load arrives as this notice.
      const failed = (notices || []).find((n) => n && n.code === 'sheet-unavailable');
      if (!failed || state.pendingSheetId === null) { return; }
      state.pendingSheetId = null;
      pendingTarget = null;
      content.setAttribute('aria-busy', 'false');
      const back = state.shownSheetId !== null ? sheetInfo(state.shownSheetId) : null;
      if (back) {
        state.activeSheetId = back.id;
        renderTabs();
      } else {
        showPlaceholder('unavailable', failed.message || 'This sheet can\'t be displayed.');
      }
    }

    function onWorkbook(msg) {
      state.version = msg.version;
      state.sheets = Array.isArray(msg.sheets) ? msg.sheets : [];
      if (!state.sheets.length) {
        state.activeSheetId = null; state.shownSheetId = null; state.pendingSheetId = null;
        renderTabs();
        showPlaceholder('empty', 'This workbook has no sheets.');
        return;
      }
      let target = state.activeSheetId !== null && sheetInfo(state.activeSheetId) ? state.activeSheetId : msg.activeSheetId;
      if (!sheetInfo(target)) {
        const v = state.sheets.find((s) => s.state === 'visible') || state.sheets[0];
        target = v.id;
      }
      renderTabs();
      selectSheet(target);
      renderTabs();
      applyEditability();
    }

    function onStateChanged(msg) {
      state.version = msg.version;
      inputCache.clear();
      pendingInput = null;
      resetFindResults();
      const wb = msg.invalidate === 'workbook';
      if (!wb && msg.sheetId !== undefined && msg.sheetId !== state.shownSheetId) { return; }
      if (gridApi && worksheetShown()) { gridApi.invalidate(wb ? 'workbook' : 'sheet'); }
      const info = sheetInfo(state.activeSheetId);
      if (info && info.kind === 'worksheet') { requestMeta(info.id); }
    }

    // ---------- edit state ----------

    function applyEditability() {
      if (!gridApi) { return; }
      const info = shownInfo();
      const editable = OfficeCommon.canEdit() && OfficeCommon.isEditMode() && !!(info && info.canEdit);
      state.editMode = OfficeCommon.isEditMode();
      gridApi.setReadOnly(!editable);
    }

    function onEditGesture(g) {
      if (!OfficeCommon.canEdit()) { return false; }
      if (!OfficeCommon.isEditMode()) { OfficeCommon.hint(OfficeCommon.EDIT_HINT); return false; }
      const info = shownInfo();
      if (!info || !info.canEdit) {
        OfficeCommon.hint((info && info.readOnlyReason && OfficeCommon.READ_ONLY_TEXT[info.readOnlyReason]) || 'This sheet is read-only.');
        return false;
      }
      return cellEditor ? cellEditor(g, shell) === true : false;
    }

    // ---------- formula bar, note, status ----------

    function addrOf(r, c) { return XlsxGrid.addrOf(r, c); }

    function setFormula(text, stale) {
      formulaText.textContent = text;
      staleMark.hidden = !stale;
    }

    function refreshFormulaBar() {
      if (!gridApi || !worksheetShown()) { return; }
      const a = gridApi.getSelection().active;
      const cell = gridApi.getCell(a.r, a.c);
      nameBox.textContent = addrOf(a.r, a.c);
      if (!cell) { setFormula('', false); }
      else if (cell.f) {
        const key = state.shownSheetId + ':' + a.r + ':' + a.c + ':' + state.version;
        if (inputCache.has(key)) { setFormula(inputCache.get(key), !!cell.stale); }
        else {
          setFormula(cell.d, !!cell.stale);   // shown until the host supplies the formula text
          if (!pendingInput || pendingInput.key !== key) {
            pendingInput = { id: nextId(), key, sheetId: state.shownSheetId, r: a.r, c: a.c };
            post({ type: 'xlsxRequestCellInput', requestId: pendingInput.id, sheetId: state.shownSheetId, r: a.r, c: a.c });
          }
        }
      } else { setFormula(cell.d, false); }
      if (cell && cell.note) { noteEl.textContent = 'Comment: ' + cell.note; noteEl.hidden = false; }
      else { noteEl.textContent = ''; noteEl.hidden = true; }
      statusHint.textContent = cell && cell.link ? 'Ctrl+click to follow link: ' + cell.link : '';
    }

    function onCellInput(msg) {
      if (!pendingInput || msg.requestId !== pendingInput.id) { return; }
      const p = pendingInput;
      pendingInput = null;
      if (p.sheetId !== state.shownSheetId || msg.sheetId !== p.sheetId || msg.r !== p.r || msg.c !== p.c) { return; }
      if (inputCache.size >= INPUT_CACHE_MAX) { inputCache.clear(); }
      inputCache.set(p.key, String(msg.input));
      const a = gridApi.getSelection().active;
      if (a.r === p.r && a.c === p.c) {
        const cell = gridApi.getCell(a.r, a.c);
        setFormula(String(msg.input), !!(cell && cell.stale));
      }
    }

    function refreshStatus() {
      if (!gridApi || !worksheetShown()) { return; }
      const sel = gridApi.getSelection();
      const rg = sel.range;
      const multi = rg[0] !== rg[2] || rg[1] !== rg[3];
      statusSel.textContent = multi ? addrOf(rg[0], rg[1]) + ':' + addrOf(rg[2], rg[3]) : addrOf(rg[0], rg[1]);
      if (!multi) { statusStats.textContent = ''; return; }
      const st = math.selectionStats(gridApi.getCells(rg));
      statusStats.textContent = st.count > 0
        ? 'Sum: ' + fmtNum(st.sum) + '   Average: ' + fmtNum(st.average) + '   Count: ' + st.count
        : '';
    }

    // ---------- copy ----------

    function doCopy() {
      if (!gridApi || !worksheetShown()) { return; }
      const range = gridApi.getSelection().range.slice(0, 4);
      post({ type: 'xlsxCopy', sheetId: state.shownSheetId, range, format: 'tsv' });
      OfficeCommon.announce('Copied ' + (range[0] === range[2] && range[1] === range[3]
        ? addrOf(range[0], range[1]) : addrOf(range[0], range[1]) + ':' + addrOf(range[2], range[3])));
    }

    // ---------- hyperlinks ----------

    function handleLink(href) {
      const link = String(href || '');
      if (!link) { return; }
      if (link[0] === '#') { followInternal(link.slice(1)); return; }
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(link);
      const scheme = m ? m[1].toLowerCase() : '';
      if (ALLOWED_SCHEMES.indexOf(scheme) < 0) {
        OfficeCommon.hint('This link type can\'t be opened from here.');
        return;
      }
      if (link.length > MAX_HREF) { OfficeCommon.hint('This link is too long to open.'); return; }
      post({ type: 'openLink', href: link });
    }

    function followInternal(ref) {
      const p = parseInternalRef(ref);
      if (!p) { OfficeCommon.hint('This link points to a name or range that can\'t be followed here.'); return; }
      let info;
      if (p.sheetName === null) { info = sheetInfo(state.activeSheetId); }
      else {
        const lower = p.sheetName.toLowerCase();
        info = state.sheets.find((s) => s.name.toLowerCase() === lower) || null;
      }
      if (!info) { OfficeCommon.hint('The linked sheet was not found.'); return; }
      selectSheet(info.id, { r: p.r, c: p.c });
    }

    function onCellClick(ev) {
      if (ev && ev.ctrlKey && ev.cell && ev.cell.link) { handleLink(ev.cell.link); }
    }

    // ---------- find ----------

    function setFindCount(text) { findCount.textContent = text; }

    function resetFindResults() {
      find.matches = []; find.truncated = false; find.index = -1; find.pendingId = null; find.dirty = true;
      if (find.timer !== null) { clearTimer(find.timer); find.timer = null; }
      setFindCount('');
    }

    function openFind() {
      find.open = true;
      findBar.hidden = false;
      findInput.focus();
      if (findInput.select) { findInput.select(); }
    }

    function closeFind() {
      find.open = false;
      findBar.hidden = true;
      resetFindResults();
      if (gridApi) { gridApi.focus(); }
    }

    function runFind(dir, inclusive) {
      const q = findInput.value || '';
      find.query = q;
      if (find.timer !== null) { clearTimer(find.timer); find.timer = null; }
      if (q === '' || q.length > MAX_QUERY) { resetFindResults(); return; }
      find.pendingId = nextId();
      find.pendingDir = dir;
      find.pendingInclusive = inclusive;
      find.dirty = false;
      post({
        type: 'xlsxFind', requestId: find.pendingId, query: q, matchCase: find.matchCase,
        sheetId: find.allSheets ? null : state.activeSheetId,
      });
    }

    function cmp(a, b) {
      const oa = sheetOrder(a.sheetId), ob = sheetOrder(b.sheetId);
      return oa !== ob ? oa - ob : a.r !== b.r ? a.r - b.r : a.c - b.c;
    }

    function currentPos() {
      const sel = gridApi && worksheetShown() ? gridApi.getSelection().active : { r: 0, c: 0 };
      return { sheetId: state.activeSheetId, r: sel.r, c: sel.c };
    }

    function pickStart(dir, inclusive) {
      const ms = find.matches;
      const pos = currentPos();
      if (dir > 0) {
        for (let i = 0; i < ms.length; i++) {
          const d = cmp(ms[i], pos);
          if (d > 0 || (inclusive && d === 0)) { return i; }
        }
        return 0;
      }
      for (let i = ms.length - 1; i >= 0; i--) {
        const d = cmp(ms[i], pos);
        if (d < 0 || (inclusive && d === 0)) { return i; }
      }
      return ms.length - 1;
    }

    function goToMatch(i) {
      const ms = find.matches;
      if (!ms.length) { return; }
      find.index = ((i % ms.length) + ms.length) % ms.length;
      const m = ms[find.index];
      const total = find.truncated ? fmtNum(MAX_FIND) + '+' : String(ms.length);
      setFindCount((find.index + 1) + ' of ' + total);
      if (m.sheetId === state.activeSheetId && worksheetShown()) { gridApi.setActive(m.r, m.c); }
      else { selectSheet(m.sheetId, { r: m.r, c: m.c }); }
    }

    function onFindResult(msg) {
      if (msg.requestId !== find.pendingId) { return; }   // a newer search superseded this one
      find.pendingId = null;
      find.matches = Array.isArray(msg.matches) ? msg.matches : [];
      find.truncated = !!msg.truncated;
      if (!find.matches.length) {
        find.index = -1;
        setFindCount('No results');
        OfficeCommon.announce('No results');
        return;
      }
      goToMatch(pickStart(find.pendingDir, find.pendingInclusive));
    }

    function findStep(dir) {
      if (find.dirty || find.matches.length === 0 || (findInput.value || '') !== find.query) { runFind(dir, true); return; }
      goToMatch(find.index + dir);
    }

    findInput.addEventListener('input', () => {
      find.dirty = true;
      if (find.timer !== null) { clearTimer(find.timer); }
      find.timer = setTimer(() => { find.timer = null; runFind(1, true); }, FIND_DEBOUNCE_MS);
    });
    findInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { if (ev.preventDefault) { ev.preventDefault(); } findStep(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { if (ev.preventDefault) { ev.preventDefault(); } closeFind(); }
    });
    matchCaseBtn.addEventListener('click', () => {
      find.matchCase = !find.matchCase;
      matchCaseBtn.setAttribute('aria-pressed', find.matchCase ? 'true' : 'false');
      find.dirty = true;
      if (findInput.value) { runFind(1, true); }
    });
    scopeBtn.addEventListener('click', () => {
      find.allSheets = !find.allSheets;
      scopeBtn.setAttribute('aria-pressed', find.allSheets ? 'true' : 'false');
      find.dirty = true;
      if (findInput.value) { runFind(1, true); }
    });
    prevBtn.addEventListener('click', () => findStep(-1));
    nextBtn.addEventListener('click', () => findStep(1));
    closeBtn.addEventListener('click', closeFind);

    // ---------- menus ----------

    function closeMenu() {
      if (!openMenuEl) { return; }
      const m = openMenuEl;
      openMenuEl = null;
      if (m.parentNode) { m.parentNode.removeChild(m); }
      hiddenBtn.setAttribute('aria-expanded', 'false');
      const back = menuReturnFocus;
      menuReturnFocus = null;
      if (back && back.focus) { back.focus(); }
    }

    /** items: [{ id, label, disabled?, separator?, onClick? }] */
    function openMenu(items, x, y, opts) {
      closeMenu();
      const o = opts || {};
      const menu = mk('div', 'xlsx-menu' + (o.up ? ' xlsx-menu-up' : ''));
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', o.label || 'Context menu');
      const left = Math.max(0, Math.min(x || 0, (window.innerWidth || 800) - 200));
      menu.style.left = left + 'px';
      menu.style.top = Math.max(0, Math.min(y || 0, (window.innerHeight || 600) - (o.up ? 0 : items.length * 28 + 8))) + 'px';
      const btns = [];
      items.forEach((it) => {
        if (it.separator) { const s = mk('div', 'xlsx-menu-sep'); s.setAttribute('role', 'separator'); menu.appendChild(s); return; }
        const b = mk('button', 'xlsx-menu-item', it.label);
        b.setAttribute('type', 'button');
        b.setAttribute('role', 'menuitem');
        b.setAttribute('data-id', it.id);
        b.setAttribute('tabindex', '-1');
        if (it.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
        b.addEventListener('click', () => {
          if (b.disabled) { return; }
          closeMenu();
          if (it.onClick) { it.onClick(); }
        });
        btns.push(b);
        menu.appendChild(b);
      });
      menu.addEventListener('keydown', (ev) => {
        const enabled = btns.filter((b) => !b.disabled);
        const cur = enabled.indexOf(ev.target);
        let to = null;
        if (ev.key === 'ArrowDown') { to = enabled[(cur + 1) % enabled.length]; }
        else if (ev.key === 'ArrowUp') { to = enabled[(cur - 1 + enabled.length) % enabled.length]; }
        else if (ev.key === 'Home') { to = enabled[0]; }
        else if (ev.key === 'End') { to = enabled[enabled.length - 1]; }
        else if (ev.key === 'Escape') { if (ev.preventDefault) { ev.preventDefault(); } closeMenu(); return; }
        else if (ev.key === 'Tab') { closeMenu(); return; }
        else { return; }
        if (ev.preventDefault) { ev.preventDefault(); }
        if (to) { to.focus(); }
      });
      menuReturnFocus = o.returnTo || (gridApi && gridApi.rootElement) || null;
      openMenuEl = menu;
      app.appendChild(menu);
      const first = btns.find((b) => !b.disabled);
      if (first) { first.focus(); }
      return menu;
    }

    function onContextMenu(ev) {
      if (!gridApi || !worksheetShown()) { return; }
      const items = [{ id: 'copy', label: 'Copy', onClick: () => doCopy() }];
      const extra = [];
      menuProviders.forEach((fn) => {
        try {
          const r = fn(ev, shell);
          if (Array.isArray(r)) { r.forEach((x) => extra.push(x)); }
        } catch (e) { /* a faulty provider must not break the menu */ }
      });
      if (extra.length) { items.push({ id: 'sep', separator: true }); extra.forEach((x) => items.push(x)); }
      openMenu(items, ev.x, ev.y, { label: 'Cell menu' });
    }

    // ---------- keyboard ----------

    function isTextTarget(t) {
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    }

    function onKeyDown(ev) {
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ev.key === 'Escape' && openMenuEl) { closeMenu(); return; }
      if (ev.key === 'F3' && find.open && !ctrl && !ev.altKey) {
        if (ev.preventDefault) { ev.preventDefault(); }
        findStep(ev.shiftKey ? -1 : 1);
        return;
      }
      if (!ctrl || ev.altKey) { return; }
      const k = ev.key;
      if ((k === 'f' || k === 'F') && !ev.shiftKey) {
        if (ev.preventDefault) { ev.preventDefault(); }
        openFind();
      } else if ((k === 'c' || k === 'C') && !ev.shiftKey) {
        if (isTextTarget(ev.target)) { return; }   // native copy inside the find box
        if (ev.preventDefault) { ev.preventDefault(); }
        doCopy();
      } else if (k === 'PageUp' || k === 'PageDown') {
        if (ev.preventDefault) { ev.preventDefault(); }
        switchRelative(k === 'PageDown' ? 1 : -1);
      }
    }

    // ---------- messages ----------

    function onMessage(msg) {
      switch (msg.type) {
        case 'init': state.version = typeof msg.version === 'number' ? msg.version : state.version; break;
        case 'flushPendingEdits': post({ type: 'flushed', flushId: msg.flushId }); break;   // view mode: nothing pending
        case 'xlsxWorkbook': onWorkbook(msg); break;
        case 'xlsxSheetMeta': onSheetMeta(msg.meta); break;
        case 'xlsxCells':
          if (gridApi && gridApi.setCells(msg)) { refreshFormulaBar(); refreshStatus(); }
          break;
        case 'xlsxCellInput': onCellInput(msg); break;
        case 'xlsxFindResult': onFindResult(msg); break;
        case 'xlsxStateChanged': onStateChanged(msg); break;
        case 'notices': onNotices(msg.notices); break;
        case 'requestFailed':
          if (pendingInput && msg.requestId === pendingInput.id) { pendingInput = null; }
          if (msg.requestId === find.pendingId) { find.pendingId = null; setFindCount('Search failed'); }
          break;
        case 'loadError':
          state.sheets = []; state.activeSheetId = null; state.shownSheetId = null; state.pendingSheetId = null;
          renderTabs();
          break;
        default: break;
      }
    }

    // ---------- start ----------

    const shell = {
      get grid() { return gridApi; },
      state,
      registerCellEditor(fn) { cellEditor = typeof fn === 'function' ? fn : null; },
      registerMenuItems(fn) { if (typeof fn === 'function') { menuProviders.push(fn); } },
    };

    function start() {
      buildToolbar();
      const appearance = app && app.getAttribute('data-sheet-appearance') === 'light' ? 'light' : 'theme';
      gridApi = XlsxGrid.create(gridHost, {
        math,
        sheetAppearance: appearance,
        readOnly: true,
        onRequestCells: (range, requestId) => {
          if (state.shownSheetId === null) { return; }
          post({ type: 'xlsxRequestCells', requestId, sheetId: state.shownSheetId, range: Array.from(range) });
        },
        onActiveChange: () => refreshFormulaBar(),
        onSelectionChange: () => { refreshStatus(); },
        onEditGesture,
        onContextMenu,
        onCellClick,
      });
      shell.gridApi = gridApi;
      // VS Code swaps body classes (vscode-light/-dark/-high-contrast) on a live theme change;
      // the grid caches resolved theme colours, so tell it to recompute.
      if (typeof MutationObserver === 'function' && document.body) {
        new MutationObserver(() => { if (gridApi && gridApi.refreshTheme) { gridApi.refreshTheme(); } })
          .observe(document.body, { attributes: true, attributeFilter: ['class'] });
      }
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('mousedown', (ev) => {
        if (openMenuEl && !(ev.target && openMenuEl.contains && openMenuEl.contains(ev.target))) {
          menuReturnFocus = null;
          closeMenu();
        }
      });
      renderTabs();
      showPlaceholder('empty', 'Loading workbook…');
      placeholderBtn.hidden = true;
      OfficeCommon.init({ vscode, onEditModeToggle: () => applyEditability(), onMessage });
    }

    return Object.assign(shell, {
      start, selectSheet, openFind, closeFind, handleLink, doCopy, switchRelative,
      parseInternalRef,
    });
  }

  const api = { create, parseInternalRef, ALLOWED_SCHEMES };
  global.XlsxEditor = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

  // Auto-start inside the webview (the test sandbox defines no acquireVsCodeApi).
  if (typeof global.acquireVsCodeApi === 'function' && global.document && global.document.getElementById('office-content')) {
    const shell = create({
      document: global.document, window: global, OfficeCommon: global.OfficeCommon,
      XlsxGrid: global.XlsxGrid, math: global.XlsxGridMath, vscode: global.acquireVsCodeApi(),
    });
    shell.start();
    global.XlsxShell = shell;
  }
})(typeof window !== 'undefined' ? window : globalThis);
