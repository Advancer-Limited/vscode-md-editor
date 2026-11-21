// WP-41: the Excel structure UI (media/xlsxStructureUi.js) with the real viewer shell, cell editor and
// OfficeCommon in node:vm against a DOM shim and a stubbed grid: header / cell / tab menus, the "+" button,
// inline tab rename with live validation, keyboard equivalents, disabled and hidden states, and
// textContent-only rendering. Real focus, the host modal and the Extension Development Host belong to Gate R4.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '../../media', f), 'utf8');
const COMMON_SRC = read('officeCommon.js');
const MATH_SRC = read('xlsxGridMath.js');
const SHELL_SRC = read('xlsxEditor.js');
const EDITOR_SRC = read('xlsxCellEditor.js');
const STRUCT_SRC = read('xlsxStructureUi.js');
const deq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const tick = () => new Promise((r) => setImmediate(r));

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDoc = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.id = '';
    this._text = ''; this.style = {}; this.value = ''; this.readOnly = false; this.selection = null;
  }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  set innerHTML(_v) { this.ownerDoc.innerHTMLWrites++; }
  get innerHTML() { return ''; }
  appendChild(c) { if (c.parentNode) { c.parentNode.removeChild(c); } c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) { this.children.push(c); } else { this.children.splice(i, 0, c); }
    return c;
  }
  replaceChild(n, old) { const i = this.children.indexOf(old); if (n.parentNode) { n.parentNode.removeChild(n); } n.parentNode = this; if (i < 0) { this.children.push(n); } else { this.children.splice(i, 1, n); } old.parentNode = null; return old; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); } }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  fire(t, ev) {
    const e = Object.assign({ target: this, preventDefault() { e.prevented = true; } }, ev);
    (this.listeners[t] || []).forEach((f) => f(e));
    return e;
  }
  click() { return this.disabled ? null : this.fire('click', {}); }
  focus() { this.ownerDoc.activeElement = this; this.fire('focus', {}); }
  setSelectionRange(a, b) { this.selection = [a, b]; }
  getBoundingClientRect() { return { left: 110, top: 540, right: 190, bottom: 560 }; }
  find(pred, out = []) { if (pred(this)) { out.push(this); } this.children.forEach((c) => c.find(pred, out)); return out; }
}

const SHEETS = [
  { id: 1, name: 'Data', kind: 'worksheet', state: 'visible', canEdit: true, readOnlyReason: null },
  { id: 2, name: 'Locked', kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: 'protected' },
  { id: 3, name: 'Other', kind: 'worksheet', state: 'visible', canEdit: true, readOnlyReason: null },
];
const metaFor = (sheetId, over) => Object.assign({
  sheetId, version: 1, rowCount: 100, colCount: 26, defaultColWidthPx: 64, defaultRowHeightPx: 20,
  colWidthsPx: [], rowHeightsPx: [], hiddenCols: [], hiddenRows: [], merges: [], frozenRows: 0, frozenCols: 0, notices: [],
}, over);

function setup(opts = {}) {
  const structure = opts.structure !== false;
  const posted = [];
  const win = { listeners: {}, innerWidth: 1000, innerHeight: 700 };
  const doc = {
    activeElement: null, innerHTMLWrites: 0,
    createElement(tag) { return new FakeEl(tag, doc); },
    getElementById(id) { return doc.body.find((e) => e.id === id)[0] || null; },
  };
  doc.body = new FakeEl('body', doc);
  const bodyClasses = new Set();
  doc.body.classList = { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), contains: (c) => bodyClasses.has(c) };
  const app = doc.createElement('div'); app.id = 'office-app';
  app.setAttribute('data-structure', structure ? 'on' : 'off');
  const toolbar = doc.createElement('div'); toolbar.id = 'office-toolbar';
  const banner = doc.createElement('div'); banner.id = 'office-banner';
  const content = doc.createElement('div'); content.id = 'office-content';
  const brandWrap = doc.createElement('div'); brandWrap.id = 'office-brand';
  [toolbar, banner, content].forEach((e) => app.appendChild(e));
  doc.body.appendChild(app); doc.body.appendChild(brandWrap);

  win.addEventListener = (t, f) => { (win.listeners[t] = win.listeners[t] || []).push(f); };
  win.dispatch = (t, ev) => { const e = Object.assign({ preventDefault() { e.prevented = true; }, stopPropagation() { e.stopped = true; } }, ev); (win.listeners[t] || []).forEach((f) => f(e)); return e; };
  const timers = [];
  const sandbox = {
    window: win, document: doc, console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(COMMON_SRC, sandbox);
  vm.runInContext(MATH_SRC, sandbox);
  vm.runInContext(SHELL_SRC, sandbox);
  vm.runInContext(EDITOR_SRC, sandbox);
  vm.runInContext(STRUCT_SRC, sandbox);

  const g = { opts: null, calls: [], meta: null, cells: new Map(), active: { r: 0, c: 0 }, rect: [0, 0, 0, 0], renderedCells: true };
  const grid = {
    rootElement: doc.createElement('div'),
    setMeta(m) {
      g.calls.push(['setMeta', m.sheetId]);
      if (!g.meta || g.meta.sheetId !== m.sheetId) { g.active = { r: 0, c: 0 }; g.rect = [0, 0, 0, 0]; g.cells = new Map(); }
      g.meta = m; fireSel(); return true;
    },
    setCells(msg) { msg.cells.forEach((c) => g.cells.set(c.r + ',' + c.c, c)); return true; },
    invalidate(s) { g.calls.push(['invalidate', s]); },
    getSelection() { return { active: Object.assign({}, g.active), focus: Object.assign({}, g.active), range: g.rect.slice() }; },
    getCells(rg) {
      const out = [];
      g.cells.forEach((c) => { if (c.r >= rg[0] && c.r <= rg[2] && c.c >= rg[1] && c.c <= rg[3]) { out.push(c); } });
      return out;
    },
    getCell(r, c) { return g.cells.get(r + ',' + c) || null; },
    setActive(r, c) { g.calls.push(['setActive', r, c]); g.active = { r, c }; g.rect = [r, c, r, c]; fireSel(); },
    setSelection(r0, c0, r1, c1) { g.calls.push(['setSelection', r0, c0, r1, c1]); g.rect = [r0, c0, r1, c1]; },
    setReadOnly(v) { g.calls.push(['setReadOnly', !!v]); },
    cellElement(r, c) { return g.renderedCells ? new FakeEl('div', doc) : null; },
    focus() { g.calls.push(['focus']); },
  };
  function fireSel() {
    g.opts.onActiveChange({ r: g.active.r, c: g.active.c, cell: grid.getCell(g.active.r, g.active.c) });
    g.opts.onSelectionChange({ active: g.active, range: g.rect.slice() });
  }
  const XlsxGridStub = {
    addrOf: (r, c) => { let s = ''; let n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s + (r + 1); },
    create(container, o) { g.opts = o; container.appendChild(grid.rootElement); return grid; },
  };
  sandbox.XlsxGrid = XlsxGridStub;

  const t = { win, doc, posted, content, g, grid, timers };
  t.shell = sandbox.window.XlsxEditor.create({
    document: doc, window: win, OfficeCommon: win.OfficeCommon, XlsxGrid: XlsxGridStub, math: sandbox.XlsxGridMath,
    vscode: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) },
    setTimeout: sandbox.setTimeout, clearTimeout: sandbox.clearTimeout,
  });
  t.shell.start();
  t.editor = win.XlsxCellEditor.create(t.shell, { document: doc, window: win, OfficeCommon: win.OfficeCommon, setTimeout: sandbox.setTimeout });
  t.ui = win.XlsxStructureUi.create(t.shell, { document: doc, OfficeCommon: win.OfficeCommon, cellEditor: t.editor });
  t.parseTsv = win.XlsxCellEditor.parseTsv;
  t.caretFromMessage = win.XlsxCellEditor.caretFromMessage;
  t.send = (msg) => win.dispatch('message', { data: msg });
  t.last = (type) => { for (let i = posted.length - 1; i >= 0; i--) { if (posted[i].type === type) { return posted[i]; } } return null; };
  t.all = (type) => posted.filter((m) => m.type === type);
  t.cls = (c) => doc.body.find((e) => e.className.split(/\s+/).includes(c))[0];
  t.hintText = () => { const h = t.cls('office-hint'); return h && !h.hidden ? h.textContent : null; };
  t.init = (over) => t.send(Object.assign({
    type: 'init', kind: 'xlsx', fileName: 'a.xlsx', version: 1, canEdit: true, readOnlyReason: null, editMode: true, notices: [],
  }, over));
  t.workbook = (over) => t.send(Object.assign({ type: 'xlsxWorkbook', version: 1, sheets: SHEETS, activeSheetId: 1 }, over));
  t.meta = (id, over) => t.send({ type: 'xlsxSheetMeta', meta: metaFor(id, over) });
  /** Edit mode on, sheet 1 shown, posted cleared. */
  t.open = (over, metaOver) => { t.init(over); t.workbook(); t.meta(1, metaOver); posted.length = 0; };
  t.gesture = (g2) => g.opts.onEditGesture(g2);
  t.cell = () => t.editor.cellInput;
  t.bar = () => t.editor.barInput;
  t.keyOn = (el, ev) => el.fire('keydown', ev);
  /** Type into the open input like a user (sets value, fires input). */
  t.typeInto = (el, text) => { el.value = text; el.fire('input', {}); };
  t.ok = (requestId, over) => t.send(Object.assign({ type: 'xlsxEditResult', requestId, ok: true, version: 2, invalidate: 'cells', sheetId: 1, range: [0, 0, 0, 0] }, over));
  t.fail = (requestId, code, message) => t.send({ type: 'xlsxEditResult', requestId, ok: false, error: { code, message } });
  t.paste = (text, target) => win.dispatch('paste', { target: target || doc.body, clipboardData: { getData: () => text } });
  return t;
}

// ---------------------------------------------------------------------------------------------

const menuOf = (t) => t.doc.body.find((e) => e.className.split(/\s+/).includes('xlsx-menu'))[0] || null;
const itemsOf = (t) => { const m = menuOf(t); return m ? m.find((e) => e.tagName === 'BUTTON') : []; };
const labelsOf = (t) => itemsOf(t).map((b) => b.textContent);
const item = (t, id) => itemsOf(t).find((b) => b.getAttribute('data-id') === id);
const tabs = (t) => t.shell.tabList.children.filter((c) => c.getAttribute('role') === 'tab');
const tabNamed = (t, name) => tabs(t).find((b) => b.textContent === name);
const ctx = (t, target, r, c) => t.g.opts.onContextMenu({ source: 'mouse', target, r, c, x: 50, y: 60 });
const edit = (t) => t.last('xlsxEdit');
const reply = (t, over) => t.ok(edit(t).requestId, over);
const renameInput = (t) => t.shell.tabList.find((e) => e.tagName === 'INPUT')[0];

test('flag off: nothing is registered, no + button, the context menu is just Copy', () => {
  const t = setup({ structure: false });
  t.open();
  assert.strictEqual(t.ui.enabled, false);
  ctx(t, 'rowHeader', 3, null);
  deq(labelsOf(t), ['Copy']);
  assert.strictEqual(t.shell.tabsBar.find((e) => e.className.includes('xlsx-add-tab')).length, 0);
  t.shell.closeMenu();
  const tab = tabNamed(t, 'Data');
  t.shell.tabList.fire('contextmenu', { target: tab, clientX: 5, clientY: 5 });
  assert.strictEqual(menuOf(t), null);
});

test('row header menu: counts come from the selection; Insert above / below and Delete post the right ops', async () => {
  const t = setup();
  t.open();
  t.g.rect = [4, 0, 6, 25]; t.g.active = { r: 4, c: 0 };
  ctx(t, 'rowHeader', 5, null);
  deq(labelsOf(t), ['Copy', 'Insert 3 rows above', 'Insert 3 rows below', 'Delete 3 rows']);
  item(t, 'insertRows-before').click();
  await tick();
  deq(edit(t).edit, { op: 'insertRows', sheetId: 1, at: 4, count: 3 });
  reply(t, { invalidate: 'sheet' });
  assert.ok(t.g.calls.some((c) => c[0] === 'setSelection' && c[1] === 4 && c[3] === 6), 'the inserted rows are selected');
  assert.strictEqual(t.last('xlsxRequestSheetMeta').sheetId, 1, 'the sheet is refetched');

  t.posted.length = 0;
  ctx(t, 'rowHeader', 5, null);
  item(t, 'insertRows-after').click();
  await tick();
  deq(edit(t).edit, { op: 'insertRows', sheetId: 1, at: 7, count: 3 });
  reply(t, { invalidate: 'sheet', version: 3 });

  t.posted.length = 0;
  t.g.rect = [4, 0, 6, 25];
  ctx(t, 'rowHeader', 5, null);
  item(t, 'deleteRows').click();
  await tick();
  deq(edit(t).edit, { op: 'deleteRows', sheetId: 1, at: 4, count: 3 });
  assert.strictEqual(edit(t).baseVersion, 3, 'carries the version of the previous reply');
});

test('a header outside the selection selects that whole row / column first and counts one', () => {
  const t = setup();
  t.open();
  t.g.rect = [0, 0, 0, 0];
  ctx(t, 'rowHeader', 9, null);
  deq(labelsOf(t).slice(1), ['Insert row above', 'Insert row below', 'Delete row']);
  assert.ok(t.g.calls.some((c) => c[0] === 'setSelection' && c[1] === 9 && c[2] === 0 && c[3] === 9 && c[4] === 25));
  t.shell.closeMenu();
  t.g.rect = [0, 0, 0, 0];
  ctx(t, 'colHeader', null, 2);
  deq(labelsOf(t).slice(1), ['Insert column left', 'Insert column right', 'Delete column']);
});

test('column header menu posts insertCols / deleteCols with at/count from the selection', async () => {
  const t = setup();
  t.open();
  t.g.rect = [0, 2, 99, 3]; t.g.active = { r: 0, c: 2 };
  ctx(t, 'colHeader', null, 3);
  deq(labelsOf(t).slice(1), ['Insert 2 columns left', 'Insert 2 columns right', 'Delete 2 columns']);
  item(t, 'insertCols-after').click();
  await tick();
  deq(edit(t).edit, { op: 'insertCols', sheetId: 1, at: 4, count: 2 });
  reply(t, { invalidate: 'sheet' });
  t.posted.length = 0;
  t.g.rect = [0, 2, 99, 3];
  ctx(t, 'colHeader', null, 3);
  item(t, 'deleteCols').click();
  await tick();
  deq(edit(t).edit, { op: 'deleteCols', sheetId: 1, at: 2, count: 2 });
});

test('cell menu has both axes (Shift+F10 reaches it with source keyboard); the corner has none', () => {
  const t = setup();
  t.open();
  t.g.rect = [2, 2, 2, 2]; t.g.active = { r: 2, c: 2 };
  t.g.opts.onContextMenu({ source: 'keyboard', target: 'cell', r: 2, c: 2, x: 10, y: 10 });
  deq(labelsOf(t), ['Copy', 'Insert row above', 'Insert row below', 'Delete row', 'Insert column left', 'Insert column right', 'Delete column']);
  const corner = setup();
  corner.open();
  ctx(corner, 'corner', null, null);
  deq(labelsOf(corner), ['Copy']);
});

test('insert below the last row is disabled', () => {
  const t = setup();
  t.open();
  t.g.rect = [1048575, 0, 1048575, 0]; t.g.active = { r: 1048575, c: 0 };
  ctx(t, 'cell', 1048575, 0);
  assert.strictEqual(item(t, 'insertRows-after').disabled, true);
  assert.strictEqual(item(t, 'insertRows-before').disabled, false);
});

test('View mode: entries are shown disabled and clicking them posts nothing', async () => {
  const t = setup();
  t.open({ editMode: false });
  ctx(t, 'rowHeader', 3, null);
  assert.ok(itemsOf(t).length > 1);
  itemsOf(t).filter((b) => b.getAttribute('data-id') !== 'copy').forEach((b) => assert.strictEqual(b.disabled, true));
  item(t, 'deleteRows').click();
  await tick();
  deq(t.posted, []);
  assert.strictEqual(t.cls('xlsx-add-tab').disabled, true);
  t.cls('xlsx-add-tab').click();
  deq(t.posted, []);
});

test('a read-only document hides the structure entries and the + button; a protected sheet disables the row/column ones', () => {
  const ro = setup();
  ro.open({ canEdit: false, editMode: false, readOnlyReason: 'flag-off' });
  ctx(ro, 'rowHeader', 3, null);
  deq(labelsOf(ro), ['Copy']);
  assert.strictEqual(ro.cls('xlsx-add-tab').hidden, true);

  const t = setup();
  t.open();
  t.shell.selectSheet(2); t.meta(2);
  ctx(t, 'cell', 0, 0);
  itemsOf(t).filter((b) => b.getAttribute('data-id') !== 'copy').forEach((b) => assert.strictEqual(b.disabled, true));
});

test('+ adds a sheet after the active one; the next xlsxWorkbook selects the new sheet and a later one does not steal the selection', async () => {
  const t = setup();
  t.open();
  t.cls('xlsx-add-tab').click();
  await tick();
  deq(edit(t).edit, { op: 'addSheet', afterSheetId: 1 });
  reply(t, { invalidate: 'workbook' });
  t.posted.length = 0;
  const sheets = [SHEETS[0], { id: 4, name: 'Sheet1', kind: 'worksheet', state: 'visible', canEdit: true, readOnlyReason: null }, SHEETS[1], SHEETS[2]];
  t.workbook({ version: 2, sheets, activeSheetId: 4 });
  assert.strictEqual(t.shell.state.activeSheetId, 4, 'the new sheet is selected');
  assert.strictEqual(t.last('xlsxRequestSheetMeta').sheetId, 4);
  deq(tabs(t).map((b) => b.textContent), ['Data', 'Sheet1', 'Locked', 'Other']);
  t.workbook({ version: 3, sheets, activeSheetId: 1 });
  assert.strictEqual(t.shell.state.activeSheetId, 4);
});

test('tab menu (right click, Shift+F10, Menu key): Add, Rename, Delete', async () => {
  const t = setup();
  t.open();
  const tab = tabNamed(t, 'Other');
  t.shell.tabList.fire('contextmenu', { target: tab, clientX: 30, clientY: 500 });
  deq(labelsOf(t), ['Add sheet', 'Rename', 'Delete sheet']);
  item(t, 'add-sheet').click();
  await tick();
  deq(edit(t).edit, { op: 'addSheet', afterSheetId: 3 });
  reply(t, { invalidate: 'workbook' });

  t.posted.length = 0;
  const e1 = t.shell.tabList.fire('keydown', { target: tabNamed(t, 'Data'), key: 'F10', shiftKey: true });
  assert.strictEqual(e1.prevented, true);
  deq(labelsOf(t), ['Add sheet', 'Rename', 'Delete sheet']);
  item(t, 'delete-sheet').click();
  await tick();
  deq(edit(t).edit, { op: 'deleteSheet', sheetId: 1 });
  t.fail(edit(t).requestId, 'cancelled', 'Cancelled.');

  t.shell.tabList.fire('keydown', { target: tabNamed(t, 'Data'), key: 'ContextMenu' });
  assert.ok(menuOf(t), 'the Menu key opens it too');
});

test('a refused structural edit shows the host message as a hint', async () => {
  const t = setup();
  t.open();
  ctx(t, 'rowHeader', 3, null);
  item(t, 'deleteRows').click();
  await tick();
  t.fail(edit(t).requestId, 'blocked', "Can't delete rows: it would delete part of the array formula E2:E4.");
  assert.match(t.hintText(), /array formula/);
});

test('rename: double-click opens an inline editor; live validation shows the section 5.2 messages', () => {
  const t = setup();
  t.open();
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Data') });
  assert.strictEqual(t.ui.isRenaming(), true);
  const input = renameInput(t);
  const msg = t.shell.tabList.find((e) => e.className === 'xlsx-tab-rename-msg')[0];
  assert.strictEqual(input.value, 'Data');
  const cases = [
    ['', /cannot be empty/], ['x'.repeat(32), /at most 31 characters/], ['a/b', /cannot contain/], ['a[1]', /cannot contain/],
    ["'x", /apostrophe/], ["x'", /apostrophe/], ['history', /History/], ['locked', /already exists/], ['LOCKED', /already exists/],
  ];
  for (const [text, re] of cases) {
    t.typeInto(input, text);
    assert.match(msg.textContent, re, JSON.stringify(text));
    assert.strictEqual(msg.hidden, false);
    assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
  }
  t.typeInto(input, 'Data');
  assert.strictEqual(msg.hidden, true);
  assert.strictEqual(input.getAttribute('aria-invalid'), null);
  t.typeInto(input, 'Renamed 2');
  assert.strictEqual(msg.hidden, true);
});

test('rename: Enter with an invalid name stays open and posts nothing; a valid name posts renameSheet; Escape cancels', async () => {
  const t = setup();
  t.open();
  t.shell.tabList.fire('keydown', { target: tabNamed(t, 'Data'), key: 'F2' });
  let input = renameInput(t);
  t.typeInto(input, 'Locked');
  t.keyOn(input, { key: 'Enter' });
  await tick();
  assert.strictEqual(t.ui.isRenaming(), true);
  deq(t.posted, []);
  t.typeInto(input, "Q1 Plan's");
  t.keyOn(input, { key: 'Enter' });
  await tick();
  assert.strictEqual(t.ui.isRenaming(), false);
  deq(edit(t).edit, { op: 'renameSheet', sheetId: 1, name: "Q1 Plan's" });
  assert.ok(tabNamed(t, 'Data'), 'the tab is back until the host sends the new names');
  reply(t, { invalidate: 'workbook' });

  t.posted.length = 0;
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Other') });
  input = renameInput(t);
  t.typeInto(input, 'Whatever');
  const esc = t.keyOn(input, { key: 'Escape' });
  assert.strictEqual(esc.prevented, true);
  await tick();
  assert.strictEqual(t.ui.isRenaming(), false);
  deq(t.posted, []);

  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Other') });
  input = renameInput(t);
  t.keyOn(input, { key: 'Enter' });
  await tick();
  deq(t.posted, []);
});

test('rename: leaving the box commits a valid name and discards an invalid one', async () => {
  const t = setup();
  t.open();
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Data') });
  let input = renameInput(t);
  t.typeInto(input, 'Bad:Name');
  input.fire('blur', {});
  await tick();
  assert.strictEqual(t.ui.isRenaming(), false);
  deq(t.posted, []);
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Data') });
  input = renameInput(t);
  t.typeInto(input, 'Good');
  input.fire('blur', {});
  await tick();
  deq(edit(t).edit, { op: 'renameSheet', sheetId: 1, name: 'Good' });
});

test('rename is refused in View mode with the hint; turning Edit off or a new workbook message ends an open rename', () => {
  const v = setup();
  v.open({ editMode: false });
  v.shell.tabList.fire('dblclick', { target: tabNamed(v, 'Data') });
  assert.strictEqual(v.ui.isRenaming(), false);
  assert.match(v.hintText(), /Press Edit/);

  const t = setup();
  t.open();
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Data') });
  t.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(t.ui.isRenaming(), false);
  t.send({ type: 'editModeChanged', editMode: true });
  t.shell.tabList.fire('dblclick', { target: tabNamed(t, 'Data') });
  t.workbook({ version: 2 });
  assert.strictEqual(t.ui.isRenaming(), false);
  assert.ok(tabNamed(t, 'Data'));
});

test('document-derived text is never parsed as HTML: sheet names with markup render as text and in the rename box', () => {
  const t = setup();
  t.open();
  const evil = '<img src=x onerror=alert(1)>';
  t.workbook({ version: 2, sheets: [Object.assign({}, SHEETS[0], { name: evil }), SHEETS[1], SHEETS[2]], activeSheetId: 1 });
  const tab = tabNamed(t, evil);
  assert.ok(tab, 'the name is the tab text');
  t.shell.tabList.fire('dblclick', { target: tab });
  const input = renameInput(t);
  assert.strictEqual(input.value, evil);
  t.typeInto(input, 'a<b>');
  assert.strictEqual(t.doc.innerHTMLWrites, 0, 'no innerHTML write anywhere');
  const src = fs.readFileSync(path.join(__dirname, '../../media/xlsxStructureUi.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src.replace(/\/\/.*$/gm, '')), 'the source has no HTML sinks');
});

test('validateSheetName mirrors the host rules', () => {
  const f = setup().win.XlsxStructureUi.validateSheetName;
  assert.strictEqual(f('Sheet1', ['Other']), null);
  assert.strictEqual(f('a'.repeat(31), []), null);
  assert.ok(f('a'.repeat(32), []));
  assert.ok(f('a\\b', []) && f('a?b', []) && f('a*b', []) && f('a:b', []) && f('a\u0001', []));
  assert.strictEqual(f("it's", []), null, 'an inner apostrophe is fine');
});

test('a cell edit in progress is committed before the structural edit goes out', async () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'x', r: 1, c: 1 });
  assert.strictEqual(t.editor.isEditing(), true);
  ctx(t, 'rowHeader', 3, null);
  item(t, 'deleteRows').click();
  await tick();
  assert.strictEqual(edit(t).edit.op, 'setCells', 'the open cell edit is sent first');
  reply(t, { invalidate: 'cells' });
  await tick();
  assert.strictEqual(edit(t).edit.op, 'deleteRows');
});
