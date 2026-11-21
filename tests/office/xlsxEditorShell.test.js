// WP-16: Excel viewer shell (media/xlsxEditor.js), run in node:vm against a DOM shim with a
// stubbed XlsxGrid (the real grid is covered by xlsxGrid.test.js) and the real XlsxGridMath and
// OfficeCommon. Layout, theming and real focus behaviour need the Extension Development Host
// (Gate R1 checklist).
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
const deq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDoc = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.id = '';
    this._text = ''; this.style = {}; this.value = '';
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
  getBoundingClientRect() { return { left: 10, top: 500, right: 100, bottom: 520 }; }
  find(pred, out = []) { if (pred(this)) { out.push(this); } this.children.forEach((c) => c.find(pred, out)); return out; }
}

const SHEETS = [
  { id: 1, name: 'Data', kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: 'view-mode' },
  { id: 2, name: 'Totals', kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: 'view-mode' },
  { id: 3, name: 'Chart1', kind: 'chartsheet', state: 'visible', canEdit: false, readOnlyReason: 'view-mode' },
  { id: 4, name: 'Secret', kind: 'worksheet', state: 'hidden', canEdit: false, readOnlyReason: 'view-mode' },
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
  if (opts.appearance) { app.setAttribute('data-sheet-appearance', opts.appearance); }
  const toolbar = doc.createElement('div'); toolbar.id = 'office-toolbar';
  const banner = doc.createElement('div'); banner.id = 'office-banner';
  const content = doc.createElement('div'); content.id = 'office-content';
  const brandWrap = doc.createElement('div'); brandWrap.id = 'office-brand';
  const brandBtn = doc.createElement('button'); brandBtn.id = 'btn-about';
  brandWrap.appendChild(brandBtn);
  [toolbar, banner, content].forEach((e) => app.appendChild(e));
  doc.body.appendChild(app); doc.body.appendChild(brandWrap);

  win.addEventListener = (t, f) => { (win.listeners[t] = win.listeners[t] || []).push(f); };
  win.dispatch = (t, ev) => { const e = Object.assign({ preventDefault() { e.prevented = true; } }, ev); (win.listeners[t] || []).forEach((f) => f(e)); return e; };
  const timers = [];
  const sandbox = {
    window: win, document: doc, console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  const observers = [];
  if (opts.observers) {
    doc.documentElement = new FakeEl('html', doc);
    sandbox.MutationObserver = class {
      constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
      observe(target, o) { this.targets.push({ target, filter: o.attributeFilter }); }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(COMMON_SRC, sandbox);
  vm.runInContext(MATH_SRC, sandbox);
  vm.runInContext(SHELL_SRC, sandbox);

  // ---- stub grid ----
  const g = {
    opts: null, calls: [], meta: null, cells: new Map(), active: { r: 0, c: 0 }, rect: [0, 0, 0, 0],
    readOnly: true, acceptCells: true,
  };
  const grid = {
    rootElement: doc.createElement('div'),
    setMeta(m) {
      g.calls.push(['setMeta', m.sheetId]);
      if (!g.meta || g.meta.sheetId !== m.sheetId) { g.active = { r: 0, c: 0 }; g.rect = [0, 0, 0, 0]; g.cells = new Map(); }
      g.meta = m; fireSel(true); return true;
    },
    setCells(msg) {
      g.calls.push(['setCells', msg.requestId]);
      if (!g.acceptCells || !g.meta || msg.sheetId !== g.meta.sheetId || msg.version !== g.meta.version) { return false; }
      msg.cells.forEach((c) => g.cells.set(c.r + ',' + c.c, c));
      return true;
    },
    invalidate(s) { g.calls.push(['invalidate', s]); },
    getSelection() { return { active: Object.assign({}, g.active), focus: Object.assign({}, g.active), range: g.rect.slice() }; },
    getCells(rg) {
      const out = [];
      g.cells.forEach((c) => { if (c.r >= rg[0] && c.r <= rg[2] && c.c >= rg[1] && c.c <= rg[3]) { out.push(c); } });
      return out;
    },
    getCell(r, c) { return g.cells.get(r + ',' + c) || null; },
    setActive(r, c) { g.calls.push(['setActive', r, c]); g.active = { r, c }; g.rect = [r, c, r, c]; fireSel(true); },
    setReadOnly(v) { g.readOnly = !!v; g.calls.push(['setReadOnly', !!v]); },
    focus() { g.calls.push(['focus']); },
  };
  function fireSel() {
    g.opts.onActiveChange({ r: g.active.r, c: g.active.c, cell: grid.getCell(g.active.r, g.active.c) });
    g.opts.onSelectionChange({ active: g.active, range: g.rect.slice() });
  }
  g.select = (r0, c0, r1, c1, active) => {
    g.rect = [r0, c0, r1, c1]; g.active = active || { r: r0, c: c0 };
    g.opts.onSelectionChange({ active: g.active, range: g.rect.slice() });
  };
  g.putCells = (list) => { list.forEach((c) => g.cells.set(c.r + ',' + c.c, c)); };
  g.fire = () => fireSel();
  const XlsxGridStub = {
    addrOf: (r, c) => { let s = ''; let n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s + (r + 1); },
    create(container, o) { g.opts = o; container.appendChild(grid.rootElement); return grid; },
  };

  const t = { win, doc, posted, content, toolbar, banner, app, g, grid, timers, brandBtn, observers };
  t.shell = sandbox.window.XlsxEditor.create({
    document: doc, window: win, OfficeCommon: win.OfficeCommon, XlsxGrid: XlsxGridStub, math: sandbox.XlsxGridMath,
    vscode: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) },
    setTimeout: sandbox.setTimeout, clearTimeout: sandbox.clearTimeout,
  });
  t.shell.start();
  t.send = (msg) => win.dispatch('message', { data: msg });
  t.last = (type) => { for (let i = posted.length - 1; i >= 0; i--) { if (posted[i].type === type) { return posted[i]; } } return null; };
  t.all = (type) => posted.filter((m) => m.type === type);
  t.tabs = () => content.find((e) => e.getAttribute('role') === 'tab');
  t.tab = (name) => t.tabs().find((e) => e.textContent.startsWith(name));
  t.btn = (label) => doc.body.find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === label)[0];
  t.cls = (c) => doc.body.find((e) => e.className.split(/\s+/).includes(c))[0];
  t.hintText = () => { const h = t.cls('office-hint'); return h && !h.hidden ? h.textContent : null; };
  t.init = (over) => t.send(Object.assign({
    type: 'init', kind: 'xlsx', fileName: 'a.xlsx', version: 1, canEdit: false, readOnlyReason: 'view-mode', editMode: false, notices: [],
  }, over));
  t.workbook = (over) => t.send(Object.assign({ type: 'xlsxWorkbook', version: 1, sheets: SHEETS, activeSheetId: 1 }, over));
  t.meta = (id, over) => t.send({ type: 'xlsxSheetMeta', meta: metaFor(id, over) });
  /** init + workbook + meta for sheet 1, ready for interaction. */
  t.open = (over) => { t.init(over); t.workbook(); t.meta(1); posted.length = 0; };
  t.key = (ev) => win.dispatch('keydown', Object.assign({ target: doc.body }, ev));
  return t;
}

const cell = (r, c, d, k, extra) => Object.assign({ r, c, d, s: 0, k: k || 's' }, extra);

test('N7: the theme observer watches body class/style/data-vscode-theme-* and <html> style (dark -> dark changes)', () => {
  const t = setup({ observers: true });
  assert.strictEqual(t.observers.length, 1);
  const o = t.observers[0];
  const onBody = o.targets.find((x) => x.target === t.doc.body);
  const onHtml = o.targets.find((x) => x.target === t.doc.documentElement);
  assert.ok(onBody && onHtml, 'observes body and html');
  for (const a of ['class', 'data-vscode-theme-id', 'data-vscode-theme-kind', 'style']) assert.ok(onBody.filter.includes(a), a);
  assert.ok(onHtml.filter.includes('style'));
  let refreshed = 0;
  t.grid.refreshTheme = () => { refreshed++; };
  o.fn([{ type: 'attributes', attributeName: 'data-vscode-theme-id' }]);
  assert.strictEqual(refreshed, 1, 'a theme id change (same kind) refreshes the grid colours');
});

test('start posts ready, passes sheetAppearance to the grid and builds the toolbar', () => {
  const t = setup({ appearance: 'light' });
  deq(t.posted, [{ type: 'ready' }]);
  assert.strictEqual(t.g.opts.sheetAppearance, 'light');
  assert.strictEqual(t.g.opts.readOnly, true);
  assert.ok(t.btn('Find (Ctrl+F)') && t.btn('Copy selection (Ctrl+C)') && t.btn('Open in Excel'));
  assert.strictEqual(setup().g.opts.sheetAppearance, 'theme');
  const t2 = setup();
  t2.btn('Open in Excel').click();
  deq(t2.last('openExternally'), { type: 'openExternally' });
});

test('tab switch requests meta then cells', () => {
  const t = setup();
  t.init(); t.workbook();
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
  assert.strictEqual(t.tab('Data').getAttribute('aria-selected'), 'true');
  t.meta(1);
  deq(t.g.calls.filter((c) => c[0] === 'setMeta'), [['setMeta', 1]]);
  // the grid asks for cells: the shell posts exactly the grid's id and the shown sheet
  t.g.opts.onRequestCells([0, 0, 49, 9], 7);
  deq(t.last('xlsxRequestCells'), { type: 'xlsxRequestCells', requestId: 7, sheetId: 1, range: [0, 0, 49, 9] });
  t.send({ type: 'xlsxCells', requestId: 7, sheetId: 1, version: 1, range: [0, 0, 49, 9], cells: [cell(0, 0, 'x')], styles: {} });
  assert.ok(t.g.calls.some((c) => c[0] === 'setCells' && c[1] === 7));
  // switch: meta is requested first, the grid is not touched until it arrives
  t.posted.length = 0; t.g.calls.length = 0;
  t.tab('Totals').click();
  deq(t.posted, [{ type: 'xlsxRequestSheetMeta', sheetId: 2 }]);
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'true');
  deq(t.g.calls, []);
  t.meta(2);
  deq(t.g.calls.filter((c) => c[0] === 'setMeta'), [['setMeta', 2]]);
  t.g.opts.onRequestCells([0, 0, 49, 9], 8);
  deq(t.last('xlsxRequestCells'), { type: 'xlsxRequestCells', requestId: 8, sheetId: 2, range: [0, 0, 49, 9] });
});

test('foreign and stale sheet meta is ignored; a stale or foreign cell batch does not touch the bars', () => {
  const t = setup();
  t.init(); t.workbook(); t.meta(1);
  t.g.calls.length = 0;
  t.meta(2);                         // not the active tab
  t.meta(1, { version: 0 });         // older than the workbook version
  deq(t.g.calls, []);
  t.tab('Totals').click();
  t.meta(1);                         // the user already moved on: the late answer for sheet 1 is dropped
  deq(t.g.calls, []);
  t.meta(2);
  assert.strictEqual(t.g.calls.length > 0, true);
  t.g.acceptCells = false;           // the grid rejects the batch (superseded)
  t.g.putCells([cell(0, 0, 'old', 's')]);
  t.send({ type: 'xlsxCells', requestId: 99, sheetId: 1, version: 1, range: [0, 0, 0, 0], cells: [cell(0, 0, 'NEW')], styles: {} });
  assert.notStrictEqual(t.cls('xlsx-formula-text').textContent, 'NEW');
});

test('chartsheet tab shows the placeholder and requests nothing', () => {
  const t = setup();
  t.open();
  t.tab('Chart1').click();
  deq(t.posted, []);
  const ph = t.cls('xlsx-placeholder');
  assert.strictEqual(ph.hidden, false);
  assert.match(ph.textContent, /chart sheet/i);
  assert.strictEqual(t.cls('xlsx-grid-host').hidden, true);
  // Open in Excel from the placeholder
  t.btn('Open in Excel').click();
  assert.ok(t.last('openExternally'));
  // back to a worksheet restores the grid
  t.tab('Data').click();
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
  t.meta(1);
  assert.strictEqual(t.cls('xlsx-grid-host').hidden, false);
  assert.strictEqual(ph.hidden, true);
});

test('hidden sheets are listed in a menu and are viewable', () => {
  const t = setup();
  t.open();
  assert.strictEqual(t.tabs().some((e) => e.textContent.startsWith('Secret')), false);
  const hb = t.cls('xlsx-hidden-btn');
  assert.strictEqual(hb.hidden, false);
  assert.match(hb.textContent, /Hidden sheets \(1\)/);
  hb.click();
  const items = t.doc.body.find((e) => e.getAttribute('role') === 'menuitem');
  deq(items.map((i) => i.textContent), ['Secret (hidden)']);
  items[0].click();
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 4 });
  assert.ok(t.tab('Secret'), 'the viewed hidden sheet gets a temporary tab');
  assert.strictEqual(t.doc.body.find((e) => e.getAttribute('role') === 'menu').length, 0, 'menu closed');
});

test('formula bar shows the formula for f cells (host text) and the stale marker', () => {
  const t = setup();
  t.open();
  t.g.putCells([cell(0, 0, '42', 'n', { v: 42, f: true }), cell(1, 0, '=A1*2', 'n', { f: true, stale: true }), cell(2, 0, 'plain')]);
  t.g.active = { r: 0, c: 0 }; t.g.fire();
  assert.strictEqual(t.cls('xlsx-namebox').textContent, 'A1');
  const req = t.last('xlsxRequestCellInput');
  assert.ok(req.requestId >= 1000000000, 'shell ids never collide with the grid ids');
  assert.strictEqual(req.sheetId, 1); assert.strictEqual(req.r, 0); assert.strictEqual(req.c, 0);
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '42');   // shown until the host answers
  t.send({ type: 'xlsxCellInput', requestId: req.requestId + 5, sheetId: 1, r: 0, c: 0, input: '=BAD' });   // unknown id
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '42');
  t.send({ type: 'xlsxCellInput', requestId: req.requestId, sheetId: 1, r: 0, c: 0, input: '=SUM(B1:B3)' });
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '=SUM(B1:B3)');
  assert.strictEqual(t.cls('xlsx-stale').hidden, true);
  // stale formula
  t.g.active = { r: 1, c: 0 }; t.g.fire();
  assert.strictEqual(t.cls('xlsx-stale').hidden, false);
  assert.strictEqual(t.cls('xlsx-stale').textContent, 'Not calculated');
  const req2 = t.last('xlsxRequestCellInput');
  t.send({ type: 'xlsxCellInput', requestId: req2.requestId, sheetId: 1, r: 1, c: 0, input: '=A1*2' });
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '=A1*2');
  // a late answer for a cell that is no longer active is dropped
  t.g.active = { r: 2, c: 0 }; t.g.fire();
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, 'plain');
  assert.strictEqual(t.cls('xlsx-stale').hidden, true);
  // revisiting a formula cell uses the cache (no second request)
  const n = t.all('xlsxRequestCellInput').length;
  t.g.active = { r: 0, c: 0 }; t.g.fire();
  assert.strictEqual(t.all('xlsxRequestCellInput').length, n);
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '=SUM(B1:B3)');
});

test('requestFailed for the formula lookup keeps the displayed value', () => {
  const t = setup();
  t.open();
  t.g.putCells([cell(0, 0, '5', 'n', { v: 5, f: true })]);
  t.g.fire();
  const req = t.last('xlsxRequestCellInput');
  t.send({ type: 'requestFailed', requestId: req.requestId, error: { code: 'internal', message: 'nope' } });
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, '5');
});

test('status bar sums the numeric selection from raw v (dates and text excluded)', () => {
  const t = setup();
  t.open();
  t.g.putCells([
    cell(0, 0, '1', 'n', { v: 1.25 }), cell(1, 0, '$2.50', 'n', { v: 2.5 }), cell(2, 0, 'text', 's'),
    cell(3, 0, '2024-01-01', 'd', { v: 45292 }), cell(4, 0, '3', 'n', { v: 3 }),
  ]);
  t.g.select(0, 0, 4, 0);
  const st = t.cls('xlsx-status-stats').textContent;
  assert.match(st, /Sum: 6\.75/);
  assert.match(st, /Average: 2\.25/);
  assert.match(st, /Count: 3/);
  assert.strictEqual(t.cls('xlsx-status-selection').textContent, 'A1:A5');
  t.g.select(2, 0, 2, 0);
  assert.strictEqual(t.cls('xlsx-status-stats').textContent, '', 'a single cell shows no stats');
  t.g.select(2, 0, 3, 0);
  assert.strictEqual(t.cls('xlsx-status-stats').textContent, '', 'no numeric cells -> no stats');
  // cells arriving after the selection refresh the figures
  t.g.select(0, 0, 4, 0);
  t.g.cells.delete('4,0');
  t.send({ type: 'xlsxCells', requestId: 1, sheetId: 1, version: 1, range: [4, 0, 4, 0], cells: [cell(4, 0, '10', 'n', { v: 10 })], styles: {} });
  // (the stub only accepts batches that match; the shell recomputes after an accepted batch)
  assert.match(t.cls('xlsx-status-stats').textContent, /Sum: 13\.75/);
});

test('copy: Ctrl+C posts xlsxCopy (tsv) for the selection; never the markdown format', () => {
  const t = setup();
  t.open();
  t.g.select(1, 1, 3, 2);
  const e = t.key({ ctrlKey: true, key: 'c' });
  assert.strictEqual(e.prevented, true);
  deq(t.last('xlsxCopy'), { type: 'xlsxCopy', sheetId: 1, range: [1, 1, 3, 2], format: 'tsv' });
  t.posted.length = 0;
  t.btn('Copy selection (Ctrl+C)').click();
  assert.strictEqual(t.all('xlsxCopy').length, 1);
  assert.strictEqual(t.all('xlsxCopy')[0].format, 'tsv');
  // inside the find box the native copy is left alone
  t.posted.length = 0;
  t.key({ ctrlKey: true, key: 'c', target: t.cls('xlsx-find-input') });
  deq(t.posted, []);
  // text selected in the formula bar: native copy of that text, not the range
  const fText = t.cls('xlsx-formula-text');
  t.win.getSelection = () => ({ isCollapsed: false, anchorNode: fText, toString: () => '=SUM(A1:A3)' });
  const e2 = t.key({ ctrlKey: true, key: 'c' });
  deq(t.posted, []);
  assert.notStrictEqual(e2.prevented, true);
  // a collapsed selection (just a caret) still copies the range
  t.win.getSelection = () => ({ isCollapsed: true, anchorNode: fText, toString: () => '' });
  t.key({ ctrlKey: true, key: 'c' });
  assert.strictEqual(t.all('xlsxCopy').length, 1);
  delete t.win.getSelection;
  t.posted.length = 0;
  // nothing to copy on a chart sheet
  t.tab('Chart1').click();
  t.posted.length = 0;
  t.key({ ctrlKey: true, key: 'c' });
  deq(t.posted, []);
  assert.strictEqual(t.doc.body.find((e) => e.getAttribute('aria-label') === 'Copy as Markdown').length, 0);
});

test('find: Ctrl+F opens, Enter searches the active sheet and selects the first match after the cursor', () => {
  const t = setup();
  t.open();
  const bar = t.cls('xlsx-find');
  assert.strictEqual(bar.hidden, true);
  const e = t.key({ ctrlKey: true, key: 'f' });
  assert.strictEqual(e.prevented, true);
  assert.strictEqual(bar.hidden, false);
  assert.strictEqual(t.doc.activeElement, t.cls('xlsx-find-input'));
  const input = t.cls('xlsx-find-input');
  input.value = 'abc';
  t.g.active = { r: 5, c: 0 }; t.g.rect = [5, 0, 5, 0];
  input.fire('keydown', { key: 'Enter' });
  const q = t.last('xlsxFind');
  assert.strictEqual(q.query, 'abc'); assert.strictEqual(q.matchCase, false); assert.strictEqual(q.sheetId, 1);
  assert.ok(q.requestId >= 1000000000);
  // a stale result id is dropped
  t.send({ type: 'xlsxFindResult', requestId: q.requestId - 1, matches: [{ sheetId: 1, r: 1, c: 1 }], truncated: false });
  assert.strictEqual(t.g.calls.filter((c) => c[0] === 'setActive').length, 0);
  t.send({ type: 'xlsxFindResult', requestId: q.requestId, matches: [{ sheetId: 1, r: 2, c: 0 }, { sheetId: 1, r: 8, c: 3 }, { sheetId: 1, r: 9, c: 1 }], truncated: false });
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 8, 3]);
  assert.strictEqual(t.cls('xlsx-find-count').textContent, '2 of 3');
  // Enter again: next (no new request); Shift+Enter: previous; both wrap
  const n = t.all('xlsxFind').length;
  input.fire('keydown', { key: 'Enter' });
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 9, 1]);
  input.fire('keydown', { key: 'Enter' });
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 2, 0]);
  input.fire('keydown', { key: 'Enter', shiftKey: true });
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 9, 1]);
  assert.strictEqual(t.all('xlsxFind').length, n);
  // Escape closes and returns focus to the grid
  t.g.calls.length = 0;
  input.fire('keydown', { key: 'Escape' });
  assert.strictEqual(bar.hidden, true);
  assert.ok(t.g.calls.some((c) => c[0] === 'focus'));
});

test('find navigates across sheets (all-sheets scope) and shows truncation', () => {
  const t = setup();
  t.open();
  t.key({ ctrlKey: true, key: 'f' });
  t.btn('Search all sheets').click();
  assert.strictEqual(t.btn('Search all sheets').getAttribute('aria-pressed'), 'true');
  t.btn('Match case').click();
  const input = t.cls('xlsx-find-input');
  input.value = 'Total';
  input.fire('keydown', { key: 'Enter' });
  const q = t.last('xlsxFind');
  assert.strictEqual(q.sheetId, null); assert.strictEqual(q.matchCase, true);
  t.send({ type: 'xlsxFindResult', requestId: q.requestId, truncated: true,
    matches: [{ sheetId: 1, r: 0, c: 0 }, { sheetId: 2, r: 4, c: 2 }] });
  // the first search is inclusive: the match under the cursor (A1, sheet 1) is selected; Enter moves to sheet 2
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 0, 0]);
  assert.strictEqual(t.cls('xlsx-find-count').textContent, '1 of 1,000+');
  input.fire('keydown', { key: 'Enter' });
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 2 });
  assert.strictEqual(t.cls('xlsx-find-count').textContent, '2 of 1,000+');
  t.g.calls.length = 0;
  t.meta(2);
  deq(t.g.calls.filter((c) => c[0] === 'setActive'), [['setActive', 4, 2]]);
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'true');
  // next wraps back to sheet 1
  input.fire('keydown', { key: 'Enter' });
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
  t.meta(1);
  deq(t.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 0, 0]);
});

test('find: no results, debounced typing and a query change re-searches', () => {
  const t = setup();
  t.open();
  t.key({ ctrlKey: true, key: 'f' });
  const input = t.cls('xlsx-find-input');
  input.value = 'zzz';
  input.fire('input', {});
  assert.strictEqual(t.all('xlsxFind').length, 0, 'debounced');
  t.timers.forEach((f) => f());
  const q = t.last('xlsxFind');
  assert.ok(q);
  t.send({ type: 'xlsxFindResult', requestId: q.requestId, matches: [], truncated: false });
  assert.strictEqual(t.cls('xlsx-find-count').textContent, 'No results');
  input.value = 'abc';
  input.fire('keydown', { key: 'Enter' });
  assert.strictEqual(t.last('xlsxFind').query, 'abc');
  // a workbook change invalidates the results
  t.send({ type: 'xlsxStateChanged', version: 2, invalidate: 'sheet', sheetId: 1 });
  assert.strictEqual(t.cls('xlsx-find-count').textContent, '');
});

test('hyperlink Ctrl+click: http/https/mailto go to openLink, other schemes are refused', () => {
  const t = setup();
  t.init(); t.workbook(); t.meta(1);
  t.posted.length = 0;
  const click = (link, ctrlKey) => t.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, 'x', 's', { link }), ctrlKey });
  click('https://example.com/a', true);
  deq(t.posted, [{ type: 'openLink', href: 'https://example.com/a' }]);
  click('mailto:a@b.co', true);
  assert.strictEqual(t.last('openLink').href, 'mailto:a@b.co');
  t.posted.length = 0;
  click('https://example.com/a', false);          // a plain click never follows
  click('javascript:alert(1)', true);
  click('file:///c:/x.txt', true);
  click('..\\other.xlsx', true);
  deq(t.posted, []);
  assert.match(t.hintText(), /can't be opened/);
  t.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, 'x'), ctrlKey: true });   // no link: nothing
  deq(t.posted, []);
});

test('internal hyperlinks switch sheet and select the cell', () => {
  const t = setup();
  t.init(); t.workbook(); t.meta(1);
  t.posted.length = 0;
  t.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, 'go', 's', { link: '#Totals!B3' }), ctrlKey: true });
  deq(t.posted, [{ type: 'xlsxRequestSheetMeta', sheetId: 2 }]);
  t.g.calls.length = 0;
  t.meta(2);
  deq(t.g.calls.filter((c) => c[0] === 'setActive'), [['setActive', 2, 1]]);
  // quoted names with doubled apostrophes, same-sheet refs, ranges
  const t2 = setup();
  const sheets = [{ id: 1, name: "It's", kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: null },
    { id: 2, name: 'B', kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: null }];
  t2.init(); t2.workbook({ sheets }); t2.meta(1);
  t2.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, '', 's', { link: "#'It''s'!$D$5:E6" }), ctrlKey: true });
  deq(t2.g.calls.filter((c) => c[0] === 'setActive').pop(), ['setActive', 4, 3]);
  t2.posted.length = 0;
  t2.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, '', 's', { link: '#nosuch!A1' }), ctrlKey: true });
  deq(t2.posted, []);
  assert.match(t2.hintText(), /not found/);
  t2.g.opts.onCellClick({ r: 0, c: 0, cell: cell(0, 0, '', 's', { link: '#MyNamedRange' }), ctrlKey: true });
  assert.match(t2.hintText(), /can't be followed/);
  const { parseInternalRef } = t2.shell;
  deq(parseInternalRef('A1'), { sheetName: null, r: 0, c: 0 });
  assert.strictEqual(parseInternalRef('Sheet1!XFE1'), null);
});

test('sheet-unavailable notice reverts the tab to the previously shown sheet', () => {
  const t = setup();
  t.open();
  t.tab('Totals').click();
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'true');
  t.send({ type: 'notices', notices: [{ severity: 'warning', code: 'sheet-unavailable', message: 'This sheet is damaged.' }] });
  assert.strictEqual(t.tab('Data').getAttribute('aria-selected'), 'true');
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'false');
  assert.strictEqual(t.cls('xlsx-grid-host').hidden, false);
  // the common chrome shows the notice itself
  assert.match(t.cls('office-notices').textContent, /damaged/);
  // a late meta for the abandoned sheet is dropped
  t.g.calls.length = 0;
  t.meta(2);
  deq(t.g.calls, []);
});

test('sheet-unavailable on the very first sheet shows a placeholder; other notices are ignored', () => {
  const t = setup();
  t.init(); t.workbook();
  t.send({ type: 'notices', notices: [{ severity: 'info', code: 'whatever', message: 'hi' }] });
  assert.strictEqual(t.cls('xlsx-placeholder').hidden, false);   // still loading
  t.send({ type: 'notices', notices: [{ severity: 'warning', code: 'sheet-unavailable', message: 'Too large to display.' }] });
  assert.match(t.cls('xlsx-placeholder').textContent, /Too large/);
  assert.strictEqual(t.cls('xlsx-grid-host').hidden, true);
  // retrying by clicking the tab works
  t.tab('Totals').click();
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 2 });
});

test('per-sheet notices render in the banner (textContent only)', () => {
  const t = setup();
  t.init(); t.workbook();
  t.meta(1, { notices: [{ severity: 'info', code: 'charts', message: '2 charts are <b>not shown</b>' }, { severity: 'warning', code: 'x', message: 'warn' }] });
  assert.strictEqual(t.banner.hidden, false);
  assert.match(t.banner.textContent, /2 charts are <b>not shown<\/b>/);
  assert.strictEqual(t.banner.children.length, 2);
  t.tab('Totals').click(); t.meta(2);
  assert.strictEqual(t.banner.hidden, true);
  assert.strictEqual(t.doc.innerHTMLWrites, 0);
});

test('edit gestures: View mode shows the hint and returns false; read-only reasons are not nagged', () => {
  const t = setup();
  t.open({ canEdit: true, readOnlyReason: null });
  assert.strictEqual(t.g.opts.onEditGesture({ kind: 'type', text: 'a', r: 0, c: 0 }), false);
  assert.strictEqual(t.hintText(), 'Press Edit (Ctrl+E) to make changes');
  assert.strictEqual(t.posted.length, 0, 'nothing is posted');
  const t2 = setup();
  t2.open({ canEdit: false });
  assert.strictEqual(t2.g.opts.onEditGesture({ kind: 'f2', r: 0, c: 0 }), false);
  assert.strictEqual(t2.hintText(), null);
});

test('edit mode: the registered cell editor is offered the gesture; sheet protection blocks it', () => {
  const t = setup();
  t.init({ canEdit: true, readOnlyReason: null });
  const sheets = SHEETS.map((s) => Object.assign({}, s, { canEdit: s.kind === 'worksheet' && s.id !== 2, readOnlyReason: s.id === 2 ? 'protected' : null }));
  t.workbook({ sheets }); t.meta(1);
  assert.strictEqual(t.g.readOnly, true);
  t.send({ type: 'editModeChanged', editMode: true });
  assert.strictEqual(t.g.readOnly, false, 'grid becomes editable in edit mode on an editable sheet');
  const seen = [];
  t.shell.registerCellEditor((g, shell) => { seen.push([g.kind, shell === t.shell]); return true; });
  assert.strictEqual(t.g.opts.onEditGesture({ kind: 'enter', r: 1, c: 1 }), true);
  deq(seen, [['enter', true]]);
  t.tab('Totals').click(); t.meta(2);
  assert.strictEqual(t.g.readOnly, true, 'protected sheet stays read-only');
  assert.strictEqual(t.g.opts.onEditGesture({ kind: 'enter', r: 1, c: 1 }), false);
  assert.match(t.hintText(), /protected/);
  assert.strictEqual(seen.length, 1);
  t.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(t.g.readOnly, true);
});

test('context menu scaffold: only Copy is enabled; providers can add items; Escape closes', () => {
  const t = setup();
  t.open();
  t.g.select(0, 0, 1, 1);
  t.g.opts.onContextMenu({ source: 'keyboard', target: 'cell', r: 0, c: 0, x: 20, y: 30 });
  let items = t.doc.body.find((e) => e.getAttribute('role') === 'menuitem');
  deq(items.map((i) => [i.textContent, i.disabled]), [['Copy', false]]);
  assert.strictEqual(t.doc.activeElement, items[0], 'keyboard focus moves into the menu');
  items[0].click();
  deq(t.last('xlsxCopy'), { type: 'xlsxCopy', sheetId: 1, range: [0, 0, 1, 1], format: 'tsv' });
  assert.strictEqual(t.doc.body.find((e) => e.getAttribute('role') === 'menu').length, 0);
  let clicked = 0;
  t.shell.registerMenuItems((ev) => [{ id: 'ins', label: 'Insert row ' + ev.r, onClick: () => { clicked++; } }, { id: 'off', label: 'Off', disabled: true }]);
  t.g.opts.onContextMenu({ source: 'mouse', target: 'rowHeader', r: 3, c: null, x: 5, y: 5 });
  items = t.doc.body.find((e) => e.getAttribute('role') === 'menuitem');
  deq(items.map((i) => i.textContent), ['Copy', 'Insert row 3', 'Off']);
  assert.strictEqual(items[2].disabled, true);
  items[1].click();
  assert.strictEqual(clicked, 1);
  t.g.opts.onContextMenu({ source: 'mouse', target: 'cell', r: 0, c: 0, x: 5, y: 5 });
  t.key({ key: 'Escape' });
  assert.strictEqual(t.doc.body.find((e) => e.getAttribute('role') === 'menu').length, 0);
  // arrow keys move through enabled items
  t.g.opts.onContextMenu({ source: 'mouse', target: 'cell', r: 0, c: 0, x: 5, y: 5 });
  const menu = t.doc.body.find((e) => e.getAttribute('role') === 'menu')[0];
  items = menu.find((e) => e.getAttribute('role') === 'menuitem');
  menu.fire('keydown', { key: 'ArrowDown', target: items[0] });
  assert.strictEqual(t.doc.activeElement, items[1]);
});

test('Ctrl+PageUp/PageDown switch sheets (visible tabs, wrapping)', () => {
  const t = setup();
  t.open();
  const e = t.key({ ctrlKey: true, key: 'PageDown' });
  assert.strictEqual(e.prevented, true);
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 2 });
  t.meta(2);
  t.key({ ctrlKey: true, key: 'PageDown' });                  // chart sheet: placeholder, no request
  assert.strictEqual(t.tab('Chart1').getAttribute('aria-selected'), 'true');
  t.key({ ctrlKey: true, key: 'PageDown' });                  // wraps to Data
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
  t.meta(1);
  t.key({ ctrlKey: true, key: 'PageUp' });                    // wraps back to the chart sheet
  assert.strictEqual(t.tab('Chart1').getAttribute('aria-selected'), 'true');
});

test('the tab strip is a tablist with roving tabindex and arrow-key focus', () => {
  const t = setup();
  t.open();
  const list = t.content.find((e) => e.getAttribute('role') === 'tablist')[0];
  assert.ok(list);
  assert.strictEqual(t.tab('Data').getAttribute('tabindex'), '0');
  assert.strictEqual(t.tab('Totals').getAttribute('tabindex'), '-1');
  list.fire('keydown', { key: 'ArrowRight', target: t.tab('Data') });
  assert.strictEqual(t.doc.activeElement, t.tab('Totals'));
  assert.strictEqual(t.tab('Totals').getAttribute('tabindex'), '0');
  list.fire('keydown', { key: 'End', target: t.tab('Totals') });
  assert.strictEqual(t.doc.activeElement, t.tab('Chart1'));
});

test('stateChanged invalidates the grid and re-requests meta; a workbook message keeps the active sheet', () => {
  const t = setup();
  t.open();
  t.tab('Totals').click(); t.meta(2);
  t.posted.length = 0; t.g.calls.length = 0;
  t.send({ type: 'xlsxStateChanged', version: 2, invalidate: 'workbook' });
  deq(t.g.calls, [['invalidate', 'workbook']]);
  deq(t.posted, [{ type: 'xlsxRequestSheetMeta', sheetId: 2 }]);
  t.send({ type: 'xlsxWorkbook', version: 2, sheets: SHEETS, activeSheetId: 1 });
  deq(t.posted, [{ type: 'xlsxRequestSheetMeta', sheetId: 2 }], 'no duplicate request, still on Totals');
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'true');
  t.meta(2, { version: 2 });
  assert.ok(t.g.calls.some((c) => c[0] === 'setMeta' && c[1] === 2));
  // a re-sent workbook (sheet-level read-only reason became known) only updates tabs
  t.posted.length = 0;
  t.send({ type: 'xlsxWorkbook', version: 2, sheets: SHEETS.map((s) => Object.assign({}, s, { readOnlyReason: 'protected' })), activeSheetId: 1 });
  deq(t.posted, []);
  // a workbook whose active sheet disappeared falls back to a visible sheet
  t.send({ type: 'xlsxWorkbook', version: 3, sheets: [SHEETS[0], SHEETS[2]], activeSheetId: 1 });
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
});

test('K14: a workbook whose ids were renumbered keeps the active sheet by name', () => {
  const t = setup();
  t.open();
  t.tab('Totals').click(); t.meta(2);
  // Ids shifted (as a fresh host model numbers sheets by position): Totals is now id 3, id 2 is another sheet.
  const renumbered = [
    Object.assign({}, SHEETS[0], { id: 1 }), Object.assign({}, SHEETS[2], { id: 2 }),
    Object.assign({}, SHEETS[1], { id: 3 }), Object.assign({}, SHEETS[3], { id: 4 }),
  ];
  t.send({ type: 'xlsxWorkbook', version: 3, sheets: renumbered, activeSheetId: 1 });
  assert.strictEqual(t.tab('Totals').getAttribute('aria-selected'), 'true', 'still on Totals');
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 3 });
  // A rename of the active sheet keeps its id: still selected.
  t.meta(3, { version: 3 });
  t.send({ type: 'xlsxWorkbook', version: 4, sheets: renumbered.map((x) => (x.id === 3 ? Object.assign({}, x, { name: 'Sums' }) : x)), activeSheetId: 1 });
  assert.strictEqual(t.tab('Sums').getAttribute('aria-selected'), 'true');
});

test('flushPendingEdits is answered immediately (View mode: nothing pending)', () => {
  const t = setup();
  t.open();
  t.send({ type: 'flushPendingEdits', flushId: 12 });
  deq(t.posted, [{ type: 'flushed', flushId: 12 }]);
});

test('the initial active sheet comes from the host; first sheet when none is given', () => {
  const t = setup();
  t.init(); t.workbook({ activeSheetId: 2 });
  deq(t.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 2 });
  const t2 = setup();
  t2.init(); t2.workbook({ activeSheetId: 999 });
  deq(t2.last('xlsxRequestSheetMeta'), { type: 'xlsxRequestSheetMeta', sheetId: 1 });
  const t3 = setup();
  t3.init(); t3.workbook({ sheets: [] });
  assert.match(t3.cls('xlsx-placeholder').textContent, /no sheets/);
});

test('document-derived text uses textContent only (sheet names, cells, links, notes)', () => {
  const t = setup();
  const evil = '<img src=x onerror=alert(1)>';
  t.init();
  t.workbook({ sheets: [{ id: 1, name: evil, kind: 'worksheet', state: 'visible', canEdit: false, readOnlyReason: null }], activeSheetId: 1 });
  t.meta(1);
  assert.strictEqual(t.tabs()[0].textContent, evil);
  t.g.putCells([cell(0, 0, evil, 's', { note: evil, link: evil })]);
  t.g.fire();
  assert.strictEqual(t.cls('xlsx-formula-text').textContent, evil);
  assert.match(t.cls('xlsx-note-text').textContent, /Comment: <img/);
  assert.strictEqual(t.doc.innerHTMLWrites, 0);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(SHELL_SRC), 'source has no HTML-string sinks');
});

test('the comment text of the active cell is shown (keyboard equivalent of the hover tooltip)', () => {
  const t = setup();
  t.open();
  t.g.putCells([cell(0, 0, 'v', 's', { note: 'Check this' })]);
  t.g.fire();
  const n = t.cls('xlsx-note-text');
  assert.strictEqual(n.hidden, false);
  assert.strictEqual(n.textContent, 'Comment: Check this');
  t.g.active = { r: 1, c: 1 }; t.g.fire();
  assert.strictEqual(n.hidden, true);
});

test('loadError clears the tabs', () => {
  const t = setup();
  t.open();
  t.send({ type: 'loadError', title: 'Bad', detail: 'x', actions: [] });
  assert.strictEqual(t.tabs().length, 0);
});

test('window.XlsxShell exposes grid, state and both plug-in hooks when auto-started', () => {
  const t = setup();
  assert.strictEqual(typeof t.shell.registerCellEditor, 'function');
  assert.strictEqual(typeof t.shell.registerMenuItems, 'function');
  assert.ok(t.shell.grid);
  assert.ok(t.shell.state && 'activeSheetId' in t.shell.state);
});
