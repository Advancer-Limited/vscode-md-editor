// WP-23: the Excel cell editor (media/xlsxCellEditor.js) with the real viewer shell
// (media/xlsxEditor.js), OfficeCommon and XlsxGridMath, run in node:vm against a DOM shim with a
// stubbed grid (the real grid is covered by xlsxGrid.test.js). Real focus/blur behaviour, the paste
// event from the system clipboard and Ctrl+Z routing need the Extension Development Host (Gate R2).
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
];
const metaFor = (sheetId, over) => Object.assign({
  sheetId, version: 1, rowCount: 100, colCount: 26, defaultColWidthPx: 64, defaultRowHeightPx: 20,
  colWidthsPx: [], rowHeightsPx: [], hiddenCols: [], hiddenRows: [], merges: [], frozenRows: 0, frozenCols: 0, notices: [],
}, over);

function setup(opts = {}) {
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

const cell = (r, c, d, k, extra) => Object.assign({ r, c, d, s: 0, k: k || 's' }, extra);

// ---------------------------------------------------------------------------------------------

test('typing in View mode shows the hint and posts nothing', () => {
  const t = setup();
  t.open({ editMode: false });
  assert.strictEqual(t.gesture({ kind: 'type', text: 'x', r: 0, c: 0 }), false);
  assert.match(t.hintText(), /Press Edit \(Ctrl\+E\)/);
  deq(t.posted, []);
  t.paste('a\tb');
  assert.match(t.hintText(), /Press Edit/);
  deq(t.posted, []);
  t.gesture({ kind: 'delete', r: 0, c: 0, range: [0, 0, 0, 0] });
  deq(t.posted, []);
});

test('a read-only sheet and a locked cell are refused with a hint and nothing is posted', () => {
  const t = setup();
  t.open();
  t.g.cells.set('1,1', cell(1, 1, 'x', 's', { ro: true }));
  assert.strictEqual(t.gesture({ kind: 'f2', r: 1, c: 1 }), true);
  assert.strictEqual(t.hintText(), "This cell can't be changed here.");
  assert.strictEqual(t.editor.isEditing(), false);
  deq(t.posted, []);
  // sheet 2 is protected
  t.shell.selectSheet(2);
  t.meta(2);
  t.posted.length = 0;
  assert.strictEqual(t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 }), false);
  assert.match(t.hintText(), /protected/i);
  t.paste('a');
  assert.match(t.hintText(), /protected/i);
  deq(t.posted, []);
});

test('typing starts an edit with the typed character; Enter commits with baseVersion and moves down', () => {
  const t = setup();
  t.open();
  assert.strictEqual(t.gesture({ kind: 'type', text: '4', r: 2, c: 1 }), true);
  assert.strictEqual(t.cell().hidden, false);
  assert.strictEqual(t.cell().value, '4');
  assert.strictEqual(t.doc.activeElement, t.cell());
  deq(t.posted, [], 'typing replaces: no seed is requested');
  t.typeInto(t.cell(), '42');
  const e = t.keyOn(t.cell(), { key: 'Enter' });
  assert.strictEqual(e.prevented, true);
  const m = t.last('xlsxEdit');
  deq(m, { type: 'xlsxEdit', requestId: m.requestId, baseVersion: 1, edit: { op: 'setCells', sheetId: 1, cells: [{ r: 2, c: 1, input: '42' }] } });
  assert.strictEqual(t.cell().hidden, true);
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 3, 1]);
  assert.ok(t.g.calls.some((c) => c[0] === 'focus'));
  t.posted.length = 0;
  t.ok(m.requestId, { version: 2 });
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 }, 'the sheet is refetched');
  assert.strictEqual(t.shell.state.version, 2);
});

test('Shift+Enter, Tab and Shift+Tab commit and move; the last row stays', () => {
  const t = setup();
  t.open();
  const run = (key, shiftKey, r, c) => {
    t.gesture({ kind: 'type', text: 'a', r, c });
    t.typeInto(t.cell(), 'a' + key);
    t.keyOn(t.cell(), { key, shiftKey });
    const m = t.last('xlsxEdit');
    t.ok(m.requestId, { version: t.shell.state.version + 1 });
    return t.g.calls.filter((x) => x[0] === 'setActive').pop();
  };
  deq(run('Enter', true, 5, 5), ['setActive', 4, 5]);
  deq(run('Tab', false, 5, 5), ['setActive', 5, 6]);
  deq(run('Tab', true, 5, 5), ['setActive', 5, 4]);
  deq(run('Enter', false, 99, 2), ['setActive', 99, 2]);
});

test('moving skips hidden rows', () => {
  const t = setup();
  t.open(null, { hiddenRows: [3] });
  t.gesture({ kind: 'type', text: 'a', r: 2, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });
  deq(t.g.calls.filter((x) => x[0] === 'setActive').pop(), ['setActive', 4, 0]);
});

test('F2 requests the seed, holds input until it arrives, then Esc posts nothing', () => {
  const t = setup();
  t.open();
  assert.strictEqual(t.gesture({ kind: 'f2', r: 0, c: 0 }), true);
  const req = t.last('xlsxRequestCellInput');
  deq(req, { type: 'xlsxRequestCellInput', requestId: req.requestId, sheetId: 1, r: 0, c: 0 });
  assert.strictEqual(t.cell().readOnly, true);
  t.send({ type: 'xlsxCellInput', requestId: req.requestId, sheetId: 1, r: 0, c: 0, input: '=SUM(A1:A3)' });
  assert.strictEqual(t.cell().readOnly, false);
  assert.strictEqual(t.cell().value, '=SUM(A1:A3)');
  deq(t.cell().selection, [11, 11], 'caret at the end');
  t.posted.length = 0;
  t.keyOn(t.cell(), { key: 'Escape' });
  deq(t.posted, []);
  assert.strictEqual(t.cell().hidden, true);
  assert.strictEqual(t.editor.isEditing(), false);
  // A seed for another request is ignored.
  t.gesture({ kind: 'enter', r: 0, c: 0 });
  const req2 = t.last('xlsxRequestCellInput');
  t.send({ type: 'xlsxCellInput', requestId: req2.requestId + 5, sheetId: 1, r: 0, c: 0, input: 'nope' });
  assert.strictEqual(t.cell().value, '');
});

test('committing the unchanged seed posts nothing (still moves)', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'dblclick', r: 0, c: 0 });
  const req = t.last('xlsxRequestCellInput');
  t.send({ type: 'xlsxCellInput', requestId: req.requestId, sheetId: 1, r: 0, c: 0, input: '=B1+1' });
  t.posted.length = 0;
  t.keyOn(t.cell(), { key: 'Enter' });
  deq(t.posted, []);
});

test('Delete and Backspace post clearCells for the selection', () => {
  const t = setup();
  t.open();
  assert.strictEqual(t.gesture({ kind: 'delete', r: 1, c: 1, range: [1, 1, 3, 2] }), true);
  const m = t.last('xlsxEdit');
  deq(m.edit, { op: 'clearCells', sheetId: 1, range: [1, 1, 3, 2] });
  assert.strictEqual(m.baseVersion, 1);
});

test('edits are sent one at a time, each with the version the previous reply reported', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });
  t.gesture({ kind: 'type', text: 'b', r: 1, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });
  const first = t.all('xlsxEdit');
  assert.strictEqual(first.length, 1, 'the second waits for the first reply');
  t.ok(first[0].requestId, { version: 2 });
  const both = t.all('xlsxEdit');
  assert.strictEqual(both.length, 2);
  assert.strictEqual(both[1].baseVersion, 2);
  deq(both[1].edit.cells, [{ r: 1, c: 0, input: 'b' }]);
});

test('a stale result refetches, tells the user and drops what was queued behind it', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 }); t.keyOn(t.cell(), { key: 'Enter' });
  t.gesture({ kind: 'type', text: 'b', r: 1, c: 0 }); t.keyOn(t.cell(), { key: 'Enter' });
  const m = t.last('xlsxEdit');
  t.posted.length = 0;
  t.fail(m.requestId, 'stale', 'The workbook changed. Your edit was not applied.');
  assert.match(t.hintText(), /changed/);
  assert.match(t.hintText(), /Some edits were discarded because the workbook changed\./, 'says the queued edit was dropped (Gate R2 nit b)');
  deq(t.posted.map((x) => x.type), ['xlsxRequestSheetMeta']);
  // The refetched meta carries the host's version: the next edit uses it.
  t.meta(1, { version: 7 });
  t.gesture({ kind: 'type', text: 'c', r: 2, c: 0 }); t.keyOn(t.cell(), { key: 'Enter' });
  assert.strictEqual(t.last('xlsxEdit').baseVersion, 7);
  // Stale with nothing queued behind it: the host's message only.
  t.fail(t.last('xlsxEdit').requestId, 'stale', 'The workbook changed. Your edit was not applied.');
  assert.strictEqual(t.hintText(), 'The workbook changed. Your edit was not applied.');
});

test('a rejected edit shows the message with hint; a rejected formula reopens the formula bar at the position', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: '=', r: 0, c: 0 });
  t.typeInto(t.cell(), '=SUM(1,');
  t.keyOn(t.cell(), { key: 'Enter' });
  const m = t.last('xlsxEdit');
  t.send({ type: 'xlsxEditResult', requestId: m.requestId, ok: false, error: { code: 'invalid', message: "This formula can't be used: unexpected end (at character 8)." } });
  assert.match(t.hintText(), /can't be used/);
  assert.strictEqual(t.editor.isEditing(), true);
  deq(t.editor.current(), { r: 0, c: 0, where: 'bar', value: '=SUM(1,', awaiting: false });
  assert.strictEqual(t.bar().hidden, false);
  assert.strictEqual(t.shell.formulaBar.display.hidden, true);
  deq(t.bar().selection, [7, 7], 'caret at character 8 (1-based, the "=" counts)');
  // Fixing and committing sends a new edit.
  t.typeInto(t.bar(), '=SUM(1,2)');
  t.keyOn(t.bar(), { key: 'Enter' });
  assert.strictEqual(t.last('xlsxEdit').edit.cells[0].input, '=SUM(1,2)');
  assert.strictEqual(t.shell.formulaBar.display.hidden, false);
  // Other refusals just show the message and reopen nothing.
  const m2 = t.last('xlsxEdit');
  t.fail(m2.requestId, 'read-only', 'Sheet "Data" is protected.');
  assert.strictEqual(t.hintText(), 'Sheet "Data" is protected.');
  assert.strictEqual(t.editor.isEditing(), false);
});

test('caretFromMessage understands the host wording', () => {
  const { caretFromMessage } = setup();
  assert.strictEqual(caretFromMessage("(at character 3).", '=A+'), 2);
  assert.strictEqual(caretFromMessage('foo (at the end of the formula).', '=SUM('), 5);
  assert.strictEqual(caretFromMessage('nothing', '=A'), null);
  assert.strictEqual(caretFromMessage('(at character 99).', '=A'), 2, 'clamped');
});

test('the formula bar edits the active cell and commits on Enter', () => {
  const t = setup();
  t.open();
  t.g.active = { r: 3, c: 2 };
  t.shell.formulaBar.display.fire('click', {});
  const req = t.last('xlsxRequestCellInput');
  assert.strictEqual(req.r, 3);
  assert.strictEqual(t.editor.current().where, 'bar');
  t.send({ type: 'xlsxCellInput', requestId: req.requestId, sheetId: 1, r: 3, c: 2, input: '=A1' });
  assert.strictEqual(t.bar().value, '=A1');
  t.typeInto(t.bar(), '=A2');
  t.keyOn(t.bar(), { key: 'Enter' });
  deq(t.last('xlsxEdit').edit.cells, [{ r: 3, c: 2, input: '=A2' }]);
  // In View mode the formula bar does not start an edit.
  const v = setup();
  v.open({ editMode: false });
  v.shell.formulaBar.display.fire('click', {});
  assert.strictEqual(v.editor.isEditing(), false);
});

test('when the cell is not rendered the edit opens in the formula bar', () => {
  const t = setup();
  t.open();
  t.g.renderedCells = false;
  t.gesture({ kind: 'type', text: 'z', r: 0, c: 0 });
  assert.strictEqual(t.editor.current().where, 'bar');
  assert.strictEqual(t.bar().value, 'z');
});

test('flushPendingEdits (backup, auto-save) never commits an open editor: it stays open, nothing is posted (Gate R2 F4)', async () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'q', r: 0, c: 0 });
  t.typeInto(t.cell(), 'qq');
  const calls = t.g.calls.length;
  t.send({ type: 'flushPendingEdits', flushId: 9 });
  await tick();
  deq(t.last('flushed'), { type: 'flushed', flushId: 9 });
  assert.strictEqual(t.last('xlsxEdit'), null, 'the half-typed cell was not committed');
  assert.strictEqual(t.editor.isEditing(), true, 'the editor is still open');
  assert.strictEqual(t.cell().value, 'qq', 'with the typing intact');
  assert.strictEqual(t.cell().hidden, false);
  assert.strictEqual(t.hintText(), null, 'no hint');
  deq(t.g.calls.slice(calls), [], 'the grid was not moved or refocused');
  // Enter still commits it afterwards.
  t.keyOn(t.cell(), { key: 'Enter' });
  deq(t.last('xlsxEdit').edit.cells, [{ r: 0, c: 0, input: 'qq' }]);
});

test('flushPendingEdits waits for an edit already in flight, then answers flushed', async () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'q', r: 0, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });
  const m = t.last('xlsxEdit');
  assert.ok(m, 'the edit was posted');
  t.send({ type: 'flushPendingEdits', flushId: 9 });
  await tick();
  assert.strictEqual(t.last('flushed'), null, 'not flushed before the host answered');
  t.ok(m.requestId);
  await tick();
  deq(t.last('flushed'), { type: 'flushed', flushId: 9 });
  assert.ok(t.posted.indexOf(t.last('flushed')) > t.posted.indexOf(m));
});

test('Ctrl/Cmd+S inside the editor commits it and lets VS Code save; its flush waits for that commit (Gate R2 F4)', async () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
    const t = setup();
    t.open();
    t.gesture({ kind: 'type', text: 'x', r: 2, c: 1 });
    t.typeInto(t.cell(), 'x42');
    const ev = t.win.dispatch('keydown', Object.assign({ key: 's', target: t.cell() }, mod));
    assert.ok(!ev.prevented && !ev.stopped, 'the key goes on to VS Code (its save command)');
    const m = t.last('xlsxEdit');
    deq(m.edit.cells, [{ r: 2, c: 1, input: 'x42' }]);
    assert.strictEqual(t.editor.isEditing(), false);
    // VS Code's save flushes: answered only after the commit's reply.
    t.send({ type: 'flushPendingEdits', flushId: 4 });
    await tick();
    assert.strictEqual(t.last('flushed'), null);
    t.ok(m.requestId);
    await tick();
    deq(t.last('flushed'), { type: 'flushed', flushId: 4 });
    // With no editor open Ctrl+S is left alone entirely.
    const n = t.posted.length;
    const ev2 = t.win.dispatch('keydown', Object.assign({ key: 's', target: t.doc.body }, mod));
    assert.ok(!ev2.prevented && !ev2.stopped);
    assert.strictEqual(t.posted.length, n);
  }
});

test('flushPendingEdits with nothing pending answers flushed; a lost reply does not hang it (timeout)', async () => {
  const t = setup();
  t.open();
  t.send({ type: 'flushPendingEdits', flushId: 1 });
  await tick();
  deq(t.last('flushed'), { type: 'flushed', flushId: 1 });
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });   // in flight; its reply never comes
  t.send({ type: 'flushPendingEdits', flushId: 2 });
  await tick();
  assert.strictEqual(t.all('flushed').length, 1);
  t.timers.forEach((fn) => fn());   // the fallback timer fires
  await tick();
  deq(t.last('flushed'), { type: 'flushed', flushId: 2 });
});

test('turning Edit off commits first and only then asks the host for View mode', async () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.typeInto(t.cell(), 'abc');
  t.win.dispatch('keydown', { key: 'e', ctrlKey: true, target: t.doc.body });
  const m = t.last('xlsxEdit');
  assert.ok(m);
  await tick();
  assert.strictEqual(t.last('setEditMode'), null, 'setEditMode waits for the commit to be answered');
  t.ok(m.requestId);
  await tick();
  deq(t.last('setEditMode'), { type: 'setEditMode', editMode: false });
  // With no editor open the toggle is immediate.
  const u = setup();
  u.open();
  u.win.dispatch('keydown', { key: 'e', ctrlKey: true, target: u.doc.body });
  await tick();
  deq(u.last('setEditMode'), { type: 'setEditMode', editMode: false });
});

test('an in-progress edit is discarded with a hint when the document changes under it', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.send({ type: 'xlsxStateChanged', version: 5, invalidate: 'workbook' });
  assert.strictEqual(t.editor.isEditing(), false);
  assert.strictEqual(t.hintText(), 'The document changed; your unfinished edit was discarded.');
  assert.strictEqual(t.all('xlsxEdit').length, 0);
  // Edit mode switched off by the host discards too.
  t.gesture({ kind: 'type', text: 'b', r: 0, c: 0 });
  t.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(t.editor.isEditing(), false);
});

test('Ctrl+Z inside an open editor cancels that edit (S3 fallback); Ctrl+Y does nothing; both are stopped', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  const y = t.win.dispatch('keydown', { key: 'y', ctrlKey: true, target: t.cell() });
  assert.strictEqual(y.prevented, true); assert.strictEqual(y.stopped, true);
  assert.strictEqual(t.editor.isEditing(), true);
  const z = t.win.dispatch('keydown', { key: 'z', ctrlKey: true, target: t.cell() });
  assert.strictEqual(z.prevented, true); assert.strictEqual(z.stopped, true);
  assert.strictEqual(t.editor.isEditing(), false);
  deq(t.all('xlsxEdit'), []);
  // With no editor open the key is left alone for VS Code's undo.
  const free = t.win.dispatch('keydown', { key: 'z', ctrlKey: true, target: t.doc.body });
  assert.ok(!free.prevented && !free.stopped);
});

test('blur commits, except to the other editor input', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.cell().fire('blur', { relatedTarget: t.bar() });
  assert.strictEqual(t.editor.isEditing(), true);
  t.cell().fire('blur', { relatedTarget: null });
  assert.strictEqual(t.editor.isEditing(), false);
  deq(t.last('xlsxEdit').edit.cells, [{ r: 0, c: 0, input: 'a' }]);
});

test('paste splits TSV and posts one setCells at the active cell; the selection grows to the pasted block', () => {
  const t = setup();
  t.open();
  t.g.active = { r: 2, c: 1 };
  const e = t.paste('a\tb\r\n"x\ty"\t"q""r"\r\n');
  assert.strictEqual(e.prevented, true);
  const m = t.last('xlsxEdit');
  deq(m.edit, { op: 'setCells', sheetId: 1, cells: [
    { r: 2, c: 1, input: 'a' }, { r: 2, c: 2, input: 'b' }, { r: 3, c: 1, input: 'x\ty' }, { r: 3, c: 2, input: 'q"r' },
  ] });
  assert.strictEqual(t.all('xlsxEdit').length, 1);
  deq(t.g.calls.filter((c) => c[0] === 'setSelection').pop(), ['setSelection', 2, 1, 3, 2]);
});

test('paste over 10,000 cells, past the sheet edge, or with an over-long cell is refused with a hint', () => {
  const t = setup();
  t.open();
  const row = new Array(101).fill('1').join('\t');
  t.paste(new Array(100).fill(row).join('\n'));       // 10,100 cells
  assert.match(t.hintText(), /At most 10,000 cells/);
  const ok = new Array(100).fill(new Array(100).fill('1').join('\t')).join('\n');   // exactly 10,000
  t.paste(ok);
  assert.strictEqual(t.all('xlsxEdit').length, 1);
  assert.strictEqual(t.last('xlsxEdit').edit.cells.length, 10000);
  const t2 = setup();
  t2.open();
  t2.g.active = { r: 1048575, c: 0 };
  t2.paste('a\nb');
  assert.match(t2.hintText(), /does not fit/);
  t2.paste('x'.repeat(32768));
  assert.match(t2.hintText(), /longer than 32,767/);
  deq(t2.posted, []);
});

test('paste is left to the browser while an editor or a find box has focus; empty clipboard posts nothing', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  const e = t.paste('x\ty');
  assert.ok(!e.prevented);
  t.editor.cancel();
  const input = t.doc.createElement('input');
  assert.ok(!t.paste('x', input).prevented);
  t.paste('');
  deq(t.posted, []);
});

test('Ctrl+C still copies from the grid; native copy inside the editor input is left alone', () => {
  const t = setup();
  t.open();
  t.g.select = null;
  const e = t.win.dispatch('keydown', { key: 'c', ctrlKey: true, target: t.doc.body });
  assert.strictEqual(e.prevented, true);
  assert.ok(t.last('xlsxCopy'));
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.posted.length = 0;
  const n = t.win.dispatch('keydown', { key: 'c', ctrlKey: true, target: t.cell() });
  assert.ok(!n.prevented);
  assert.strictEqual(t.last('xlsxCopy'), null);
});

test('a rich-text cell shows a hint, not a standing banner', () => {
  const t = setup();
  t.open();
  t.gesture({ kind: 'f2', r: 0, c: 0 });
  t.send({ type: 'notices', notices: [{ severity: 'info', code: 'formula-results-stale', message: 'stale' }, { severity: 'info', code: 'rich-text-cell', message: 'Rich text will be flattened' }] });
  assert.strictEqual(t.hintText(), 'Rich text will be flattened');
  const banner = t.cls('office-notices');
  assert.doesNotMatch(banner.textContent, /Rich text/);
  assert.match(banner.textContent, /stale/);
});

test('document-derived strings reach the DOM only as text: no innerHTML anywhere, values are literal', () => {
  const t = setup();
  t.open();
  const evil = '<img src=x onerror=alert(1)>';
  t.gesture({ kind: 'f2', r: 0, c: 0 });
  const req = t.last('xlsxRequestCellInput');
  t.send({ type: 'xlsxCellInput', requestId: req.requestId, sheetId: 1, r: 0, c: 0, input: evil });
  assert.strictEqual(t.cell().value, evil);
  t.keyOn(t.cell(), { key: 'Escape' });
  t.gesture({ kind: 'type', text: 'a', r: 0, c: 0 });
  t.keyOn(t.cell(), { key: 'Enter' });
  t.fail(t.last('xlsxEdit').requestId, 'read-only', evil);
  assert.strictEqual(t.hintText(), evil);
  t.send({ type: 'notices', notices: [{ severity: 'info', code: 'rich-text-cell', message: evil }] });
  assert.strictEqual(t.doc.innerHTMLWrites, 0);
});

test('the cell editor source never builds HTML', () => {
  const code = EDITOR_SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /\.innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

test('parseTsv: rows, quotes, line endings, trailing break', () => {
  const p = setup().parseTsv;
  deq(p('a\tb\nc'), [['a', 'b'], ['c']]);
  deq(p('a\r\nb\r\n'), [['a'], ['b']]);
  deq(p('a\t\tb'), [['a', '', 'b']]);
  deq(p('"a\nb"\tc'), [['a\nb', 'c']]);
  deq(p('"he said ""hi"""'), [['he said "hi"']]);
  deq(p('ab"c\td'), [['ab"c', 'd']], 'a quote inside an unquoted field is literal');
  deq(p(''), []);
  deq(p('\n'), [['']]);
  deq(p('a\n\nb'), [['a'], [''], ['b']]);
});
