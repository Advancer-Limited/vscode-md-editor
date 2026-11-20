// Tests for the Excel grid component (media/xlsxGrid.js), run in node:vm against a minimal
// DOM shim (same approach as tests/office/officeCommon.test.js). Layout, sticky positioning,
// scroll smoothness and theming need a real webview: see the Gate R1 list in the task report.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA = path.join(__dirname, '../../media');
const MATH_SRC = fs.readFileSync(path.join(MEDIA, 'xlsxGridMath.js'), 'utf8');
const GRID_SRC = fs.readFileSync(path.join(MEDIA, 'xlsxGrid.js'), 'utf8');
const deq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this._text = '';
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  set innerHTML(_v) { throw new Error('innerHTML must not be used'); }
  get innerHTML() { return ''; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(ev || {})); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight }; }
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}

function setup(over) {
  const o = over || {};
  const doc = { activeElement: null, body: null };
  doc.createElement = (tag) => new FakeEl(tag, doc);
  doc.body = doc.createElement('body');
  doc.body.className = 'vscode-dark';
  doc.body.classList = { contains: (c) => doc.body.className.split(' ').includes(c) };
  const docListeners = {};
  doc.addEventListener = (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); };
  doc.removeEventListener = () => {};
  const sandbox = { console, document: doc };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MATH_SRC, sandbox);
  vm.runInContext(GRID_SRC, sandbox);
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const requests = [];
  const events = { active: [], selection: [], gestures: [], menus: [], announce: [], clicks: [] };
  const grid = sandbox.XlsxGrid.create(container, {
    math: sandbox.XlsxGridMath,
    onRequestCells: (range, id) => requests.push({ range: Array.from(range), id }),
    onActiveChange: (a) => events.active.push({ r: a.r, c: a.c }),
    onSelectionChange: (s) => events.selection.push(JSON.parse(JSON.stringify(s))),
    onEditGesture: (g) => { events.gestures.push(JSON.parse(JSON.stringify(g))); return o.handleGestures === true; },
    onContextMenu: (m) => events.menus.push(JSON.parse(JSON.stringify(m))),
    onCellClick: (m) => events.clicks.push({ r: m.r, c: m.c, ctrl: m.ctrlKey }),
    onAnnounce: (t) => events.announce.push(t),
    sheetAppearance: o.appearance || 'theme',
  });
  const root = grid.rootElement, scroller = grid.scrollerElement;
  scroller.clientWidth = o.width || 600;
  scroller.clientHeight = o.height || 400;
  const meta = Object.assign({
    sheetId: 1, version: 1, rowCount: 1000, colCount: 100,
    defaultColWidthPx: 64, defaultRowHeightPx: 20,
    colWidthsPx: [], rowHeightsPx: [], hiddenCols: [], hiddenRows: [], merges: [],
    frozenRows: 0, frozenCols: 0, notices: [],
  }, o.meta || {});
  return { grid, root, scroller, meta, requests, events, sandbox, doc, docListeners, container, prevented: 0 };
}

const cells = (root) => root.find((e) => e.getAttribute('role') === 'gridcell');
const headers = (root, role) => root.find((e) => e.getAttribute('role') === role);
const rows = (root) => root.find((e) => e.getAttribute('role') === 'row');
const key = (t, k, mods) => t.root.fire('keydown', Object.assign({ key: k, preventDefault() { t.prevented++; } }, mods));
const at = (t, r, c) => cells(t.root).find((e) => e.getAttribute('aria-rowindex') === String(r + 2) && e.getAttribute('aria-colindex') === String(c + 2));

function answer(t, over) {
  const reqs = t.requests.splice(0);
  for (const q of reqs) {
    const [r0, c0, r1, c1] = q.range;
    const cs = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        cs.push(over && over.cell ? over.cell(r, c) : { r, c, d: String(r * 1000 + c), s: 0, k: 'n', v: r * 1000 + c });
      }
    }
    t.grid.setCells({ requestId: q.id, sheetId: t.meta.sheetId, version: t.meta.version, range: q.range, cells: cs, styles: (over && over.styles) || { 0: {} } });
  }
  return reqs;
}

test('renders only the visible window plus overscan', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  const n = cells(t.root).length;
  assert.ok(n > 0 && n < 35 * 16, 'bounded node count: ' + n);
  assert.strictEqual(t.root.getAttribute('role'), 'grid');
  assert.strictEqual(t.root.getAttribute('aria-rowcount'), '1001');
  assert.strictEqual(t.root.getAttribute('aria-colcount'), '101');
  const sizer = t.scroller.children[0];
  assert.strictEqual(sizer.style.height, (24 + 1000 * 20) + 'px');
});

test('recycles on scroll: node count stays bounded and nodes are reused', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  const all0 = new Set(t.root.find(() => true));
  const n0 = cells(t.root).length;
  for (let y = 0; y <= 15000; y += 777) {
    t.scroller.scrollTop = y;
    t.scroller.fire('scroll');
    answer(t);
    const n = cells(t.root).length;
    assert.ok(n <= n0 * 1.7 && n >= n0 * 0.5, 'node count stable at y=' + y + ': ' + n + ' vs ' + n0);
  }
  const all1 = t.root.find(() => true);
  const reused = all1.filter((e) => all0.has(e)).length;
  assert.ok(reused > n0 / 2, 'existing nodes were reused (' + reused + ')');
  assert.ok(all1.length < all0.size * 2, 'no unbounded growth');
  t.scroller.scrollTop = 15000;
  t.scroller.fire('scroll');
  answer(t);
  assert.ok(cells(t.root).some((e) => e.getAttribute('aria-rowindex') === String(750 + 2)));
  assert.ok(!cells(t.root).some((e) => e.getAttribute('aria-rowindex') === '5'));
});

test('requests missing blocks once and not again for loaded or pending blocks', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  const first = t.requests.length;
  assert.ok(first > 0);
  t.scroller.fire('scroll');
  assert.strictEqual(t.requests.length, first);
  for (const q of t.requests) {
    const area = (q.range[2] - q.range[0] + 1) * (q.range[3] - q.range[1] + 1);
    assert.ok(area <= 20000);
  }
  answer(t);
  const before = t.requests.length;
  t.grid.invalidate('cells');
  assert.ok(t.requests.length > before, 'invalidate re-requests');
});

test('discards a batch for a superseded version, sheet or unknown request', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  const q = t.requests[0];
  const mk = (o) => Object.assign({ requestId: q.id, sheetId: 1, version: 1, range: q.range, cells: [{ r: q.range[0], c: q.range[1], d: 'X', s: 0, k: 's' }], styles: {} }, o);
  assert.strictEqual(t.grid.setCells(mk({ version: 0 })), false);
  assert.strictEqual(t.grid.setCells(mk({ sheetId: 2 })), false);
  assert.strictEqual(t.grid.setCells(mk({ requestId: 9999 })), false);
  assert.strictEqual(cells(t.root).some((e) => e.textContent === 'X'), false);
  t.grid.setMeta(Object.assign({}, t.meta, { version: 2 }));
  assert.strictEqual(t.grid.setCells(mk({})), false, 'old request id no longer pending');
  const q2 = t.requests[t.requests.length - 1];
  assert.strictEqual(t.grid.setCells({ requestId: q2.id, sheetId: 1, version: 2, range: q2.range, cells: [{ r: q2.range[0], c: q2.range[1], d: 'OK', s: 0, k: 's' }], styles: {} }), true);
  assert.ok(cells(t.root).some((e) => e.textContent === 'OK'));
});

test('ARIA attributes on grid, row, cell and headers', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  assert.strictEqual(t.root.getAttribute('tabindex'), '0');
  const rs = rows(t.root);
  assert.ok(rs.length > 2);
  const idx = rs.map((r) => r.getAttribute('aria-rowindex'));
  assert.strictEqual(new Set(idx).size, idx.length, 'one role=row per sheet row');
  assert.ok(idx.includes('1'), 'header row has index 1');
  const c = at(t, 0, 1);
  assert.ok(c);
  assert.strictEqual(c.getAttribute('aria-readonly'), 'true');
  assert.ok(['true', 'false'].includes(c.getAttribute('aria-selected')));
  const ch = headers(t.root, 'columnheader');
  assert.ok(ch.some((h) => h.textContent === 'A') && ch.some((h) => h.textContent === 'B'));
  assert.ok(headers(t.root, 'rowheader').some((h) => h.textContent === '1'));
  const act = cells(t.root).find((e) => e.id === t.root.getAttribute('aria-activedescendant'));
  assert.ok(act && act.getAttribute('aria-rowindex') === '2' && act.getAttribute('aria-colindex') === '2');
  t.grid.setReadOnly(false);
  assert.strictEqual(t.root.getAttribute('aria-readonly'), 'false');
});

test('cell text is rendered with textContent only (no HTML parsing)', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  const payload = '<img src=x onerror=alert(1)>';
  answer(t, { cell: (r, c) => ({ r, c, d: r === 0 && c === 0 ? payload : '', s: 0, k: 's', note: '<b>n</b>' }) });
  const a1 = at(t, 0, 0);
  assert.strictEqual(a1.textContent, payload);
  assert.strictEqual(a1.children.length, 0, 'no element children were created from the text');
  assert.strictEqual(t.root.find((e) => e.tagName === 'IMG').length, 0);
  assert.strictEqual(a1.getAttribute('title'), '<b>n</b>');
  // the shim throws on any innerHTML write, so reaching here also proves none happened
});

test('no innerHTML / insertAdjacentHTML / outerHTML / document.write in the grid source', () => {
  const code = GRID_SRC.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/.test(code));
});

test('contrast rule picks black/white on fills; explicit colour below 3:1 is replaced', () => {
  const G = setup().sandbox.XlsxGrid;
  const dark = [30, 30, 30];
  const r1 = G.resolveColors({ fill: '#FFFF00', autoColor: true }, 'theme', dark);
  assert.strictEqual(r1.color, 'rgb(0,0,0)');
  assert.strictEqual(r1.bg, 'rgb(255,255,0)');
  assert.strictEqual(G.resolveColors({ fill: '#000080' }, 'theme', dark).color, 'rgb(255,255,255)');
  assert.strictEqual(G.resolveColors({ color: '#FFFF99', fill: '#FFFFFF' }, 'theme', dark).color, 'rgb(0,0,0)');
  const r4 = G.resolveColors({ color: '#222222' }, 'theme', dark);
  assert.strictEqual(r4.color, 'var(--vscode-editor-foreground)');
  assert.strictEqual(r4.bg, null);
  assert.strictEqual(G.resolveColors({ color: '#FF0000' }, 'theme', [255, 255, 255]).color, 'rgb(255,0,0)');
  assert.strictEqual(G.resolveColors({ color: '#FFFF99' }, 'light', dark).color, 'rgb(255,255,153)');
  assert.strictEqual(G.resolveColors({ autoColor: true }, 'light', dark).color, '#000000');
  const r7 = G.resolveColors({ fill: 'red; background:url(x)', color: 'expression(1)' }, 'theme', dark);
  assert.strictEqual(r7.bg, null);
  assert.strictEqual(r7.color, 'var(--vscode-editor-foreground)');
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t, { cell: (r, c) => ({ r, c, d: 'x', s: 1, k: 's' }), styles: { 1: { fill: '#FFFF00', autoColor: true, bold: true, h: 'center', v: 'top', fontSizePt: 12 } } });
  const a1 = at(t, 0, 0);
  assert.strictEqual(a1.style.backgroundColor, 'rgb(255,255,0)');
  assert.strictEqual(a1.style.color, 'rgb(0,0,0)');
  assert.strictEqual(a1.style.fontWeight, 'bold');
  assert.strictEqual(a1.style.justifyContent, 'center');
  assert.strictEqual(a1.style.alignItems, 'flex-start');
  assert.strictEqual(a1.style.fontSize, '16px');
});

test('selection: click, shift-click, drag, headers and callbacks', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  const hdrW = Math.max(40, String(1000).length * 9 + 18);
  const px = (c) => hdrW + c * 64 + 5, py = (r) => 24 + r * 20 + 5;
  t.scroller.fire('mousedown', { button: 0, clientX: px(2), clientY: py(3) });
  deq(t.grid.getSelection().active, { r: 3, c: 2 });
  deq(t.grid.getSelection().range, [3, 2, 3, 2]);
  assert.strictEqual(t.doc.activeElement, t.root, 'focus moves to the grid');
  t.scroller.fire('mousedown', { button: 0, shiftKey: true, clientX: px(4), clientY: py(6) });
  deq(t.grid.getSelection().range, [3, 2, 6, 4]);
  deq(t.grid.getSelection().active, { r: 3, c: 2 });
  t.scroller.fire('mousedown', { button: 0, clientX: px(1), clientY: py(1) });
  (t.docListeners.mousemove || []).forEach((f) => f({ clientX: px(3), clientY: py(2) }));
  deq(t.grid.getSelection().range, [1, 1, 2, 3]);
  (t.docListeners.mouseup || []).forEach((f) => f({}));
  t.scroller.fire('mousedown', { button: 0, clientX: px(5), clientY: 10 });
  deq(t.grid.getSelection().range, [0, 5, 999, 5]);
  t.scroller.fire('mousedown', { button: 0, clientX: 10, clientY: py(7) });
  deq(t.grid.getSelection().range, [7, 0, 7, 99]);
  t.scroller.fire('mousedown', { button: 0, clientX: 10, clientY: 10 });
  deq(t.grid.getSelection().range, [0, 0, 999, 99]);
  t.grid.setSelection(0, 0, 1, 1);
  assert.strictEqual(cells(t.root).filter((e) => e.getAttribute('aria-selected') === 'true').length, 4);
  assert.ok(t.events.selection.length > 3);
  assert.ok(t.events.active.length >= 1);
  const before = JSON.stringify(t.grid.getSelection());
  t.scroller.fire('mousedown', { button: 0, ctrlKey: true, clientX: px(2), clientY: py(2) });
  assert.strictEqual(JSON.stringify(t.grid.getSelection()), before, 'Ctrl+click does not move the selection');
  deq(t.events.clicks[t.events.clicks.length - 1], { r: 2, c: 2, ctrl: true });
});

test('keyboard routing: navigation, extension, gestures, context menu, passthrough', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  key(t, 'ArrowDown'); key(t, 'ArrowRight');
  deq(t.grid.getSelection().active, { r: 1, c: 1 });
  assert.ok(t.prevented >= 2);
  key(t, 'ArrowDown', { shiftKey: true }); key(t, 'ArrowRight', { shiftKey: true });
  deq(t.grid.getSelection().range, [1, 1, 2, 2]);
  deq(t.grid.getSelection().active, { r: 1, c: 1 });
  key(t, 'a', { ctrlKey: true });
  deq(t.grid.getSelection().range, [0, 0, 999, 99]);
  key(t, 'Home', { ctrlKey: true });
  deq(t.grid.getSelection().active, { r: 0, c: 0 });
  key(t, 'End', { ctrlKey: true });
  deq(t.grid.getSelection().active, { r: 999, c: 99 });
  assert.ok(/^[A-Z]+\d+, /.test(t.events.announce[t.events.announce.length - 1]));

  const p0 = t.prevented;
  key(t, 'c', { ctrlKey: true });
  key(t, 'PageDown', { ctrlKey: true });
  key(t, 'f', { ctrlKey: true });
  key(t, 'Escape');
  assert.strictEqual(t.prevented, p0, 'keys owned by the shell/browser are not swallowed');

  key(t, 'Home', { ctrlKey: true });
  key(t, 'F2'); key(t, 'x'); key(t, 'Delete'); key(t, 'Enter');
  deq(t.events.gestures.map((g) => g.kind), ['f2', 'type', 'delete', 'enter']);
  assert.strictEqual(t.events.gestures[1].text, 'x');
  deq(t.grid.getSelection().active, { r: 1, c: 0 }, 'unhandled Enter moves down');

  key(t, 'F10', { shiftKey: true });
  assert.strictEqual(t.events.menus[0].source, 'keyboard');
  deq([t.events.menus[0].r, t.events.menus[0].c], [1, 0]);
  t.scroller.fire('contextmenu', { clientX: 100, clientY: 100, preventDefault() {} });
  assert.strictEqual(t.events.menus[1].target, 'cell');
});

test('handled gestures suppress default navigation (edit mode)', () => {
  const t = setup({ handleGestures: true });
  t.grid.setMeta(t.meta);
  answer(t);
  key(t, 'Enter');
  deq(t.grid.getSelection().active, { r: 0, c: 0 }, 'shell consumed Enter');
  key(t, 'q');
  assert.ok(t.prevented >= 2);
  t.scroller.fire('dblclick', { clientX: 70, clientY: 30 });
  assert.strictEqual(t.events.gestures[t.events.gestures.length - 1].kind, 'dblclick');
});

test('keyboard navigation scrolls the active cell into view and requests data', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  key(t, 'End', { ctrlKey: true });
  assert.ok(t.scroller.scrollTop > 0 && t.scroller.scrollLeft > 0);
  assert.ok(t.requests.length > 0, 'data for the new window is requested');
  answer(t);
  assert.ok(cells(t.root).some((e) => e.id === t.root.getAttribute('aria-activedescendant')), 'active cell is rendered');
  key(t, 'PageUp');
  assert.ok(t.grid.getSelection().active.r < 999 - 5);
});

test('hidden rows and columns are skipped, with a collapse marker on the header', () => {
  const t = setup({ meta: { hiddenRows: [2, 3], hiddenCols: [1] } });
  t.grid.setMeta(t.meta);
  answer(t);
  const rowIdx = cells(t.root).map((e) => e.getAttribute('aria-rowindex'));
  assert.ok(!rowIdx.includes('4') && !rowIdx.includes('5'), 'rows 3 and 4 hidden');
  assert.ok(rowIdx.includes('3') && rowIdx.includes('6'));
  assert.ok(!cells(t.root).map((e) => e.getAttribute('aria-colindex')).includes('3'), 'column B hidden');
  const a = headers(t.root, 'columnheader').find((h) => h.textContent === 'A');
  assert.ok(/xg-hid-after/.test(a.className), 'marker after A');
  assert.ok(/xg-hid-after/.test(headers(t.root, 'rowheader').find((h) => h.textContent === '2').className));
  t.grid.setActive(1, 0);
  key(t, 'ArrowDown');
  deq(t.grid.getSelection().active, { r: 4, c: 0 });
  key(t, 'ArrowRight');
  deq(t.grid.getSelection().active, { r: 4, c: 2 });
});

test('merged cells: one anchor node spans the merge, covered cells are not rendered, selection snaps', () => {
  const t = setup({ meta: { merges: [[1, 1, 2, 2]] } });
  t.grid.setMeta(t.meta);
  answer(t, { cell: (r, c) => ({ r, c, d: 'v' + r + '_' + c, s: 0, k: 's' }) });
  const anchor = at(t, 1, 1);
  assert.ok(anchor);
  assert.strictEqual(anchor.textContent, 'v1_1');
  assert.strictEqual(anchor.style.width, '128px');
  assert.strictEqual(anchor.style.height, '40px');
  assert.strictEqual(at(t, 1, 2), undefined);
  assert.strictEqual(at(t, 2, 1), undefined);
  assert.strictEqual(at(t, 2, 2), undefined);
  t.grid.setActive(2, 2);
  deq(t.grid.getSelection().active, { r: 1, c: 1 }, 'covered cell resolves to the anchor');
  t.grid.setActive(1, 0);
  key(t, 'ArrowRight');
  deq(t.grid.getSelection().active, { r: 1, c: 1 });
  key(t, 'ArrowRight');
  deq(t.grid.getSelection().active, { r: 1, c: 3 }, 'leaves the merge');
  t.grid.setSelection(0, 0, 1, 1);
  deq(t.grid.getSelection().range, [0, 0, 2, 2], 'selection grows to the whole merge');
});

test('frozen panes: frozen rows/cols are always rendered, in the sticky layers', () => {
  const t = setup({ meta: { frozenRows: 2, frozenCols: 1 } });
  t.grid.setMeta(t.meta);
  answer(t);
  t.scroller.scrollTop = 5000; t.scroller.scrollLeft = 640;
  t.scroller.fire('scroll');
  answer(t);
  const [body, top, left, corner] = t.scroller.children[0].children;
  const idxs = (layer) => layer.find((e) => e.getAttribute('role') === 'gridcell').map((e) => e.getAttribute('aria-rowindex') + ':' + e.getAttribute('aria-colindex'));
  assert.ok(idxs(corner).includes('2:2') && idxs(corner).includes('3:2'), 'frozen x frozen cells in the corner layer');
  assert.ok(idxs(top).some((s) => s.startsWith('2:')) && idxs(top).some((s) => s.startsWith('3:')), 'frozen rows in the top layer');
  assert.ok(idxs(left).every((s) => s.endsWith(':2')), 'frozen col only in the left layer');
  assert.ok(idxs(left).some((s) => Number(s.split(':')[0]) > 200), 'left layer follows the vertical scroll');
  assert.ok(idxs(body).every((s) => Number(s.split(':')[0]) > 3 && Number(s.split(':')[1]) > 2));
  const f = corner.find((e) => e.getAttribute('aria-rowindex') === '2' && e.getAttribute('aria-colindex') === '2')[0];
  assert.strictEqual(f.style.top, '24px', 'frozen cells keep fixed sizer coordinates');
  const rs = rows(t.root).map((r) => r.getAttribute('aria-rowindex'));
  assert.strictEqual(new Set(rs).size, rs.length, 'still one role=row per sheet row');
  assert.ok(rows(t.root).some((r) => r.getAttribute('aria-owns')), 'sticky-layer cells are owned by their row');
  const st = t.scroller.scrollTop;
  t.grid.setActive(0, 0);
  assert.strictEqual(t.scroller.scrollTop, st, 'navigating to a frozen cell does not scroll');
  t.grid.setActive(300, 5);
  assert.ok(t.scroller.scrollTop <= (300 - 2) * 20);
});

test('live-region text names the cell, value and formula state', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t, { cell: (r, c) => (r === 6 && c === 1 ? { r, c, d: '1,250.00', s: 0, k: 'n', v: 1250, f: true } : { r, c, d: '', s: 0, k: 'z' }) });
  t.grid.setActive(6, 1);
  assert.strictEqual(t.events.announce[t.events.announce.length - 1], 'B7, 1,250.00, has formula');
  t.grid.setActive(0, 0);
  assert.strictEqual(t.events.announce[t.events.announce.length - 1], 'A1, empty');
});

test('stale, locked and link cells carry marker classes; getCells returns the loaded selection', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t, {
    cell: (r, c) => (r === 0 && c === 0 ? { r, c, d: '=A1+1', s: 0, k: 's', f: true, stale: true }
      : r === 0 && c === 1 ? { r, c, d: 'ro', s: 0, k: 's', ro: true }
        : r === 0 && c === 2 ? { r, c, d: 'link', s: 0, k: 's', link: 'https://x.test' } : { r, c, d: '', s: 0, k: 'z' }),
  });
  assert.ok(/xg-stale/.test(at(t, 0, 0).className) && at(t, 0, 0).style.fontStyle === 'italic');
  assert.ok(/xg-ro/.test(at(t, 0, 1).className));
  assert.ok(/xg-link/.test(at(t, 0, 2).className));
  t.grid.setSelection(0, 0, 0, 2);
  assert.strictEqual(t.grid.getCells().length, 3);
});

test('selection stats can use numeric v (shell feeds getCells to selectionStats)', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t, { cell: (r, c) => (r === 0 ? { r, c, d: '$1,250.00', s: 0, k: 'n', v: 1250.456 } : { r, c, d: '', s: 0, k: 'z' }) });
  t.grid.setSelection(0, 0, 0, 1);
  const st = t.sandbox.XlsxGridMath.selectionStats(t.grid.getCells());
  assert.strictEqual(st.count, 2);
  assert.strictEqual(Number(st.sum.toFixed(3)), 2500.912);
});

test('invalidate("sheet") drops cached cells; setMeta for another sheet resets selection; destroy detaches', () => {
  const t = setup();
  t.grid.setMeta(t.meta);
  answer(t);
  t.grid.setActive(5, 5);
  t.grid.invalidate('sheet');
  assert.strictEqual(cells(t.root).length, 0);
  t.grid.setMeta(Object.assign({}, t.meta, { sheetId: 2 }));
  deq(t.grid.getSelection().active, { r: 0, c: 0 });
  t.grid.destroy();
  assert.strictEqual(t.container.children.length, 0);
});

test('large sheet: 1,048,576 x 16,384 renders a bounded node set', () => {
  const t = setup({ meta: { rowCount: 1048576, colCount: 16384 } });
  t.grid.setMeta(t.meta);
  answer(t);
  t.scroller.scrollTop = 20000000; t.scroller.scrollLeft = 900000;
  t.scroller.fire('scroll');
  answer(t);
  assert.ok(t.root.find(() => true).length < 1200);
  assert.ok(cells(t.root).length > 0);
});
