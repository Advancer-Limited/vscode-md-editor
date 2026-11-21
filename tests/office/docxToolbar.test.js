// WP-35: the Word edit toolbar, shortcuts, style picker, block context menu (Shift+F10) and hover
// actions in media/docxEditor.js, wired to the edit controller (media/docxEdit.js). Same node:vm DOM
// shim and stub host as docxEdit.test.js (the shim below is a copy of it, plus document-level
// listeners for `selectionchange`).
// Needs a real window (Gate R3): VS Code forwarding webview keydowns to the workbench (does stopPropagation
// keep Ctrl+B from toggling the side bar?), AltGr layouts, real selection/focus behaviour when a toolbar
// button is clicked, menu and hover-bar placement with real geometry and CSS zoom, themes, high contrast
// and forced colours, screen-reader output.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '../../media', f), 'utf8');
const SRC = ['officeCommon.js', 'docxMap.js', 'docxIsland.js', 'docxEdit.js', 'docxEditor.js'].map((f) => [f, read(f)]);
const json = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepStrictEqual(json(a), json(b), m);

// ------------------------------------------------------------------------------------- DOM shim

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this.listeners = {}; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.childNodes.find((c) => c.nodeType === 1) || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
  get previousSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) { c.parentNode.removeChild(c); }
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) { throw new Error('insertBefore: ref is not a child'); }
    c.parentNode = this;
    if (i < 0) { this.childNodes.push(c); } else { this.childNodes.splice(i, 0, c); }
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) { throw new Error('removeChild: not a child'); }
    this.childNodes.splice(i, 1); c.parentNode = null; return c;
  }
  addEventListener(t, f, capture) { (this.listeners[t] = this.listeners[t] || []).push({ f, capture: capture === true }); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((l) => l.f !== f); }
}

class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.data = String(data); }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  cloneNode() { return new FakeText(this.ownerDocument, this.data); }
}

class FakeEl extends FakeNode {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
    this.attrs = new Map(); this.style = {}; this.className = ''; this.hidden = false; this.disabled = false;
    this.scrollTop = 0; this.clientWidth = 1000; this.offsetWidth = 800; this.rect = null;
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '') { this.appendChild(new FakeText(this.ownerDocument, v)); } }
  set innerHTML(_v) { throw new Error('innerHTML must not be used'); }
  get innerHTML() { throw new Error('innerHTML must not be used'); }
  cloneNode(deep) {
    const c = new FakeEl(this.ownerDocument, this.tagName);
    this.attrs.forEach((v, k) => c.attrs.set(k, v));
    c.style = Object.assign({}, this.style); c.className = this.className;
    if (deep) { this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true))); }
    return c;
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { return fire(this, 'click', {}); }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; }
  querySelectorAll(sel) {
    const m = /^(\w+)\.([\w-]+)$/.exec(sel);
    assert.ok(m, 'shim supports tag.class selectors only: ' + sel);
    return all(this, (e) => e.nodeType === 1 && e.tagName === m[1].toUpperCase() && e.className.split(/\s+/).includes(m[2]));
  }
}

function all(n, pred, out = []) { n.childNodes.forEach((c) => { if (pred(c)) { out.push(c); } all(c, pred, out); }); return out; }

/** Dispatch: window capture listeners, then target -> ancestors (bubble), then window bubble. */
function fire(target, type, props) {
  const doc = target.ownerDocument || target;
  const win = doc.win;
  const ev = Object.assign({ type, target, defaultPrevented: false, stopped: false,
    preventDefault() { ev.defaultPrevented = true; }, stopPropagation() { ev.stopped = true; } }, props);
  for (const l of (win.listeners[type] || [])) { if (l.capture && !ev.stopped) { l.f(ev); } }
  for (let n = target; n && !ev.stopped; n = n.parentNode) {
    for (const l of (n.listeners && n.listeners[type]) || []) { if (!l.capture) { l.f(ev); } }
  }
  for (const l of (win.listeners[type] || [])) { if (!l.capture && !ev.stopped) { l.f(ev); } }
  return ev;
}

function makeClock() {
  const c = { now: 0, seq: 0, timers: new Map() };
  c.set = (fn, ms) => { const id = ++c.seq; c.timers.set(id, { at: c.now + (ms || 0), fn }); return id; };
  c.clear = (id) => { c.timers.delete(id); };
  c.advance = (ms) => {
    const end = c.now + ms;
    for (;;) {
      let next = null;
      c.timers.forEach((t, id) => { if (t.at <= end && (!next || t.at < next.t.at)) { next = { id, t }; } });
      if (!next) { break; }
      c.timers.delete(next.id);
      c.now = next.t.at;
      next.t.fn();
    }
    c.now = end;
  };
  return c;
}

const tick = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };

// ------------------------------------------------------------------------------------- blocks

const P = (id, o = {}) => Object.assign({ id, kind: 'paragraph', parentId: null, editable: true, removable: true,
  style: { kind: 'normal', name: 'Normal' }, list: { kind: 'none', level: 0 } }, o);
const TBL = (id, o = {}) => Object.assign({ id, kind: 'opaque', parentId: null, editable: false, lockReason: 'opaque', removable: false,
  style: { kind: 'other', name: '' }, list: { kind: 'none', level: 0 } }, o);
const C = (id, table, row, col, o = {}) => P(id, Object.assign({ parentId: table, cell: { row, col } }, o));
const T = (id, text, f = {}) => ({ kind: 'text', id, text, b: !!f.b, i: !!f.i, u: !!f.u, css: {} });

// ------------------------------------------------------------------------------------- harness

function setup(opts = {}) {
  const clock = makeClock();
  const posted = [];
  const win = { listeners: {} };
  win.addEventListener = (t, f, capture) => { (win.listeners[t] = win.listeners[t] || []).push({ f, capture: capture === true }); };
  const doc = {
    win, activeElement: null, selection: null,
    createElement: (t) => new FakeEl(doc, t),
    createTextNode: (t) => new FakeText(doc, t),
    createRange() {
      const r = { setStart(c, o) { r.startContainer = c; r.startOffset = o; }, setEnd(c, o) { r.endContainer = c; r.endOffset = o; } };
      return r;
    },
    getSelection() {
      return {
        get rangeCount() { return doc.selection ? 1 : 0; },
        getRangeAt() { return doc.selection; },
        removeAllRanges() { doc.selection = null; },
        addRange(r) { doc.selection = r; },
      };
    },
    hasFocus: () => true,
    listeners: {},
    addEventListener(t, f) { (doc.listeners[t] = doc.listeners[t] || []).push(f); },
    getElementById: (id) => all(doc.body, (e) => e.nodeType === 1 && e.getAttribute('id') === id)[0] || null,
    defaultView: { getComputedStyle: () => ({ fontWeight: '400', fontStyle: 'normal', textDecorationLine: 'none' }) },
  };
  doc.body = new FakeEl(doc, 'body');
  const bodyClasses = new Set();
  doc.body.classList = { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), contains: (c) => bodyClasses.has(c) };
  const app = doc.createElement('div'); app.id = 'office-app';
  const toolbar = doc.createElement('div'); toolbar.id = 'office-toolbar';
  const content = doc.createElement('div'); content.id = 'office-content';
  content.rect = { top: 0, bottom: 600, height: 600, left: 0, right: 1000, width: 1000 };
  [toolbar, content].forEach((e) => app.appendChild(e));
  doc.body.appendChild(app);

  const sandbox = { window: win, document: doc, console: { warn() {}, log() {}, error() {} }, setTimeout: clock.set, clearTimeout: clock.clear };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const [name, src] of SRC) { vm.runInContext(src, sandbox, { filename: name }); }

  const t = {
    clock, posted, win, doc, content, toolbar, sandbox, renders: 0, blocks: opts.blocks || [],
    texts: Object.assign({}, opts.texts || {}), rects: null,
  };
  const docxLib = {
    renderAsync: (bytes, body) => {
      t.renders++;
      renderBlocks(t, body);
      return Promise.resolve();
    },
  };
  t.viewer = win.DocxViewer.create({
    document: doc, window: win, OfficeCommon: win.OfficeCommon, docxLib,
    vscode: { postMessage: (m) => posted.push(json(m)) },
    DocxEdit: sandbox.DocxEdit, DocxMap: sandbox.DocxMap, DocxIsland: sandbox.DocxIsland,
    setTimeout: clock.set, clearTimeout: clock.clear,
  });
  t.viewer.start();
  t.edit = t.viewer.editor();
  t.I = sandbox.DocxIsland;
  t.send = (msg) => { for (const l of (win.listeners.message || [])) { l.f({ data: msg }); } };
  t.of = (type) => posted.filter((m) => m.type === type);
  t.last = (type) => { const l = t.of(type); return l[l.length - 1]; };
  t.ps = (id) => all(content, (e) => e.nodeType === 1 && e.tagName === 'P' && e.getAttribute('data-block') === String(id));
  t.p = (id) => t.ps(id)[0];
  t.hintText = () => { const h = all(doc.body, (e) => e.nodeType === 1 && e.className === 'office-hint')[0]; return h && !h.hidden ? h.textContent : ''; };
  t.live = () => { const h = all(doc.body, (e) => e.nodeType === 1 && /office-live/.test(e.className))[0]; return h ? h.textContent.trim() : ''; };
  t.render = async (version, blocks) => {
    if (blocks) { t.blocks = blocks; }
    t.send({ type: 'docxRender', version, bytes: new Uint8Array([1]), blocks: t.blocks });
    await tick();
    await t.viewer.whenIdle();
  };
  t.segsFor = (id) => (t.segs && t.segs[id]) || [T(id * 100, t.texts[id] !== undefined ? t.texts[id] : 'Text ' + id)];
  /** Answer the last block-model request with segments for its block. */
  t.answerModel = async (version, segs) => {
    const req = t.last('docxRequestBlockModel');
    t.send({ type: 'docxBlockModel', requestId: req.requestId, version, blockId: req.blockId, segments: segs || t.segsFor(req.blockId) });
    await tick();
  };
  t.answerEdit = async (version, extra = {}) => {
    const req = t.last('docxEdit');
    t.send(Object.assign({ type: 'docxEditResult', requestId: req.requestId, ok: true, version, blocks: t.blocks, changedBlockIds: [req.edit.blockId] }, extra));
    await tick();
  };
  t.failEdit = async (error) => {
    const req = t.last('docxEdit');
    t.send({ type: 'docxEditResult', requestId: req.requestId, ok: false, error });
    await tick();
  };
  /** Click on block `id` with the browser caret `off` characters into its rendered text. */
  t.click = (id, off = 0) => {
    const p = t.p(id);
    const text = all(p, (n) => n.nodeType === 3)[0];
    doc.selection = { startContainer: text, startOffset: off, endContainer: text, endOffset: off };
    return fire(p, 'click', {});
  };
  /** Click and answer the model: an open island on `id`. */
  t.open = async (id, off = 0, version = 0) => { t.click(id, off); await tick(); await t.answerModel(version); };
  t.island = () => all(content, (e) => e.nodeType === 1 && e.getAttribute('data-docx-island') === '1')[0] || null;
  t.key = (key, mods = {}, target) => fire(target || doc.activeElement || doc.body, 'keydown', Object.assign({ key }, mods));
  t.type = (str) => {
    const p = t.island();
    t.I.insertText(p, doc.selection, str);
    fire(p, 'input', {});
  };
  t.caretAt = (at) => t.I.setCaret(t.island(), at);
  t.init = (over = {}) => t.send(Object.assign({ type: 'init', kind: 'docx', fileName: 'a.docx', version: 0, canEdit: true, readOnlyReason: null, editMode: true, notices: [] }, over));
  return t;
}

function renderBlocks(t, body) {
  const doc = t.doc;
  const section = doc.createElement('section'); section.className = 'docx';
  const article = doc.createElement('article');
  section.appendChild(article); body.appendChild(section);
  const tables = new Map();
  const cellOf = (table, row, col) => {
    const tbl = tables.get(table);
    while (tbl.childNodes.length <= row) { tbl.appendChild(doc.createElement('tr')); }
    const tr = tbl.childNodes[row];
    while (tr.childNodes.length <= col) { tr.appendChild(doc.createElement('td')); }
    return tr.childNodes[col];
  };
  for (const b of t.blocks) {
    if (b.kind === 'opaque') {
      const tbl = doc.createElement('table');
      tables.set(b.id, tbl);
      const parent = b.parentId === null ? article : cellOf(b.parentId, b.cell.row, b.cell.col);
      parent.appendChild(tbl);
      continue;
    }
    const p = doc.createElement('p');
    const s = doc.createElement('span'); s.setAttribute('id', '__vsmd_s_' + b.id);
    const e = doc.createElement('span'); e.setAttribute('id', '__vsmd_e_' + b.id);
    p.appendChild(s);
    p.appendChild(doc.createTextNode(t.texts[b.id] !== undefined ? t.texts[b.id] : 'Text ' + b.id));
    p.appendChild(e);
    if (t.rects && t.rects[b.id]) { p.rect = t.rects[b.id]; }
    (b.parentId === null ? article : cellOf(b.parentId, b.cell.row, b.cell.col)).appendChild(p);
  }
}

async function ready(blocks, opts = {}) {
  const t = setup(Object.assign({ blocks }, opts));
  t.init(opts.init);
  await t.render(0);
  return t;
}

const BODY = [P(1), P(2), P(3)];

// ------------------------------------------------------------------------------------- helpers

const els = (t, pred) => all(t.doc.body, (e) => e.nodeType === 1 && pred(e));
const tool = (t, prefix) => all(t.toolbar, (e) => e.nodeType === 1 && e.tagName === 'BUTTON' && (e.getAttribute('aria-label') || '').startsWith(prefix))[0];
const menu = (t) => els(t, (e) => e.className === 'docx-menu')[0] || null;
const menuItems = (m) => m.childNodes;
const itemLabel = (b) => b.childNodes[0].textContent;
const item = (t, label) => menuItems(menu(t)).find((b) => itemLabel(b) === label);
const hover = (t) => all(t.content, (e) => e.nodeType === 1 && e.className === 'docx-hover-actions')[0] || null;
const hoverBtn = (t, cls) => all(hover(t), (e) => e.nodeType === 1 && e.className.split(/\s+/).includes(cls))[0];
const selChange = async (t) => { (t.doc.listeners.selectionchange || []).forEach((f) => f()); await tick(); };
const lastEdit = (t) => t.last('docxEdit').edit;
const pressed = (t, prefix) => tool(t, prefix).getAttribute('aria-pressed');
const select = (t, a, b) => {
  const p = t.island();
  const r1 = t.I.setCaret(p, a);
  const r2 = t.I.setCaret(p, b);
  t.doc.selection = { startContainer: r1.startContainer, startOffset: r1.startOffset, endContainer: r2.startContainer, endOffset: r2.startOffset, collapsed: a === b };
};
const HEADING2 = { kind: 'heading', level: 2, name: 'heading 2' };
const IDS = ['Bold', 'Italic', 'Underline', 'Paragraph style', 'Bullets', 'Numbering', 'Outdent', 'Indent'];

/** A ready document with an island open on block `id` (default 2). */
async function opened(blocks, id = 2, segs) {
  const t = await ready(blocks || BODY);
  t.click(id, 0);
  await tick();
  await t.answerModel(0, segs);
  await tick();
  return t;
}

// ------------------------------------------------------------------------------------- toolbar state

test('edit tools are hidden when the document cannot be edited, disabled in View mode, enabled with an island', async () => {
  const ro = await ready(BODY, { init: { canEdit: false, readOnlyReason: 'protected', editMode: false } });
  for (const l of IDS) { assert.strictEqual(tool(ro, l).hidden, true, l + ' hidden'); }

  const view = await ready(BODY, { init: { editMode: false } });
  for (const l of IDS) { assert.strictEqual(tool(view, l).hidden, false, l + ' shown'); assert.strictEqual(tool(view, l).disabled, true, l + ' disabled in View mode'); }

  const t = await ready(BODY);
  await tick();
  for (const l of IDS) { assert.strictEqual(tool(t, l).disabled, true, l + ' disabled with no island'); }
  t.click(2, 0); await tick(); await t.answerModel(0); await tick();
  for (const l of ['Bold', 'Italic', 'Underline', 'Paragraph style', 'Bullets', 'Numbering']) { assert.strictEqual(tool(t, l).disabled, false, l + ' enabled'); }
  assert.strictEqual(tool(t, 'Outdent').disabled, true, 'not a list item');
  assert.strictEqual(tool(t, 'Indent').disabled, true);

  // Turning Edit off discards the island and disables everything again.
  t.send({ type: 'editModeChanged', editMode: false });
  await tick();
  for (const l of IDS) { assert.strictEqual(tool(t, l).disabled, true, l + ' disabled after Edit off'); }
});

test('tools are disabled on a locked paragraph (no island can open there) and give the lock reason', async () => {
  const t = await ready([P(1, { editable: false, lockReason: 'tracked-changes' }), P(2)]);
  t.click(1, 0);
  await tick();
  assert.strictEqual(t.island(), null);
  assert.match(t.hintText(), /tracked changes/);
  for (const l of IDS) { assert.strictEqual(tool(t, l).disabled, true, l); }
  assert.strictEqual(t.of('docxEdit').length, 0);
});

test('B/I/U aria-pressed follows the caret and the selection', async () => {
  const t = await opened(BODY, 2, [T(20, 'Hello '), T(21, 'world', { b: true }), T(22, ' end', { i: true, u: true })]);
  t.caretAt('end'); await selChange(t);
  assert.deepStrictEqual([pressed(t, 'Bold'), pressed(t, 'Italic'), pressed(t, 'Underline')], ['false', 'true', 'true']);
  t.caretAt(8); await selChange(t);                                    // inside "world"
  assert.deepStrictEqual([pressed(t, 'Bold'), pressed(t, 'Italic'), pressed(t, 'Underline')], ['true', 'false', 'false']);
  t.caretAt(2); await selChange(t);
  assert.strictEqual(pressed(t, 'Bold'), 'false');
  select(t, 6, 11); await selChange(t);                               // "world" selected
  assert.strictEqual(pressed(t, 'Bold'), 'true');
  select(t, 0, 11); await selChange(t);                               // "Hello world": not all bold
  assert.strictEqual(pressed(t, 'Bold'), 'false');
});

test('Bullets / Numbering / Style show the caret paragraph; Outdent and Indent need a list item', async () => {
  const t = await opened([P(1), P(2, { list: { kind: 'bullet', level: 0 }, style: HEADING2 }), P(3, { list: { kind: 'number', level: 1 } })]);
  assert.strictEqual(pressed(t, 'Bullets'), 'true');
  assert.strictEqual(pressed(t, 'Numbering'), 'false');
  assert.strictEqual(tool(t, 'Outdent').disabled, false);
  assert.strictEqual(tool(t, 'Indent').disabled, false);
  assert.strictEqual(tool(t, 'Paragraph style').textContent, 'Style: Heading 2');
  assert.strictEqual(tool(t, 'Paragraph style').getAttribute('aria-label'), 'Paragraph style: Heading 2');
  t.edit.closeIsland(true);
  await tick();
  assert.strictEqual(tool(t, 'Bullets').disabled, true, 'island closed');
  assert.strictEqual(tool(t, 'Paragraph style').textContent, 'Style');
});

// ------------------------------------------------------------------------------------- B / I / U

test('Ctrl+B toggles through DocxIsland.toggle, updates aria-pressed, announces and is stopped for VS Code', async () => {
  const t = await opened(BODY, 2, [T(20, 'Hello world')]);
  select(t, 0, 5);
  const ev = t.key('b', { ctrlKey: true, code: 'KeyB' });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev.stopped, true, 'stopped so the workbench does not also toggle the side bar');
  const items = t.I.read(t.island());
  assert.strictEqual(items[0].text, 'Hello');
  assert.strictEqual(items[0].b, true);
  assert.strictEqual(items[1].b, false);
  assert.strictEqual(pressed(t, 'Bold'), 'true');
  assert.strictEqual(t.live(), 'Bold on');
  // Ctrl+B again over the same selection turns it off (Word rule).
  select(t, 0, 5);
  t.key('b', { ctrlKey: true });
  assert.strictEqual(t.I.read(t.island())[0].b, false);
  assert.strictEqual(pressed(t, 'Bold'), 'false');
  assert.strictEqual(t.live(), 'Bold off');
});

test('Ctrl+I, Ctrl+U and Cmd+B work; the change commits through the idle timer (commitParagraph)', async () => {
  const t = await opened(BODY, 2, [T(20, 'Hello world')]);
  select(t, 6, 11);
  t.key('i', { ctrlKey: true });
  select(t, 6, 11);
  t.key('U', { ctrlKey: true });
  select(t, 0, 5);
  t.key('b', { metaKey: true });
  const items = t.I.read(t.island());
  deq(items.map((i) => [i.text, i.b, i.i, i.u]), [['Hello', true, false, false], [' ', false, false, false], ['world', false, true, true]]);
  assert.strictEqual(t.of('docxEdit').length, 0, 'nothing sent before the idle commit');
  t.clock.advance(1500);
  await tick();
  const e = lastEdit(t);
  assert.strictEqual(e.op, 'commitParagraph');
  assert.strictEqual(e.blockId, 2);
  assert.strictEqual(e.items[0].b, true);
});

test('the B button toggles the selection, keeps focus in the island and resyncs aria-pressed', async () => {
  const t = await opened(BODY, 2, [T(20, 'Hello world')]);
  const mouse = fire(tool(t, 'Bold'), 'mousedown', {});
  assert.strictEqual(mouse.defaultPrevented, true, 'mousedown must not steal focus from the island');
  select(t, 0, 5);
  tool(t, 'Bold').click();
  assert.strictEqual(t.I.read(t.island())[0].b, true);
  assert.strictEqual(pressed(t, 'Bold'), 'true');
  assert.strictEqual(t.doc.activeElement, t.island());
  select(t, 6, 11);
  tool(t, 'Underline').click();
  assert.strictEqual(pressed(t, 'Underline'), 'true');
});

test('B/I/U shortcuts also work with focus on a toolbar button, and do nothing without an island, in View mode or with AltGr', async () => {
  const t = await opened(BODY, 2, [T(20, 'Hello world')]);
  select(t, 0, 5);
  tool(t, 'Bold').focus();
  t.key('i', { ctrlKey: true }, tool(t, 'Bold'));
  assert.strictEqual(t.I.read(t.island())[0].i, true);
  select(t, 0, 5);
  const gr = t.key('b', { ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' });
  assert.strictEqual(gr.defaultPrevented, false);
  assert.strictEqual(t.I.read(t.island())[0].b, false);

  const view = await ready(BODY, { init: { editMode: false } });
  const ev = view.key('b', { ctrlKey: true }, view.content);
  assert.strictEqual(ev.defaultPrevented, false);
  const none = await ready(BODY);
  assert.strictEqual(none.key('b', { ctrlKey: true }, none.content).defaultPrevented, false, 'no island, no caret paragraph');
});

// ------------------------------------------------------------------------------------- style picker

test('style picker: opens a labelled menu with the current style checked and posts setStyle for the caret block', async () => {
  const t = await opened([P(1), P(2, { style: HEADING2 }), P(3)]);
  const btn = tool(t, 'Paragraph style');
  assert.strictEqual(btn.getAttribute('aria-haspopup'), 'menu');
  btn.click();
  const m = menu(t);
  assert.strictEqual(m.getAttribute('role'), 'menu');
  assert.deepStrictEqual(menuItems(m).map(itemLabel), ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
  assert.deepStrictEqual(menuItems(m).map((b) => b.getAttribute('aria-checked')), ['false', 'false', 'true', 'false', 'false', 'false', 'false']);
  assert.ok(menuItems(m).every((b) => b.getAttribute('role') === 'menuitemradio'));
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(t.doc.activeElement, item(t, 'Heading 2'), 'focus starts on the checked item');
  fire(t.island(), 'focusout', { relatedTarget: item(t, 'Heading 2') });
  assert.notStrictEqual(t.island(), null, 'moving focus into the menu keeps the island open');
  item(t, 'Heading 3').click();
  assert.strictEqual(menu(t), null);
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
  const sent = t.last('docxEdit');
  assert.deepStrictEqual(sent.edit, { op: 'setStyle', blockIds: [2], style: { heading: 3 } });
  assert.strictEqual(t.live(), '', 'announced only after the host accepted it');
  await t.answerEdit(1);
  assert.strictEqual(t.live(), 'Heading 3');
});

test('style picker: Normal posts style "normal"; keyboard Arrow/Home/End/Escape/Enter work and Escape returns focus to the button', async () => {
  const t = await opened(BODY);
  const btn = tool(t, 'Paragraph style');
  btn.click();
  assert.strictEqual(t.doc.activeElement, item(t, 'Normal'));
  const down = () => fire(t.doc.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.strictEqual(down().defaultPrevented, true);
  assert.strictEqual(t.doc.activeElement, item(t, 'Heading 1'));
  fire(t.doc.activeElement, 'keydown', { key: 'End' });
  assert.strictEqual(t.doc.activeElement, item(t, 'Heading 6'));
  fire(t.doc.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.strictEqual(t.doc.activeElement, item(t, 'Normal'), 'wraps');
  fire(t.doc.activeElement, 'keydown', { key: 'ArrowUp' });
  assert.strictEqual(t.doc.activeElement, item(t, 'Heading 6'));
  fire(t.doc.activeElement, 'keydown', { key: 'Home' });
  assert.strictEqual(t.doc.activeElement, item(t, 'Normal'));
  fire(t.doc.activeElement, 'keydown', { key: 'Escape' });
  assert.strictEqual(menu(t), null);
  assert.strictEqual(t.doc.activeElement, btn);
  assert.strictEqual(t.of('docxEdit').length, 0);
  btn.click();
  fire(t.doc.activeElement, 'keydown', { key: 'Enter' });             // activates "Normal" once
  assert.strictEqual(t.of('docxEdit').length, 1);
  assert.deepStrictEqual(lastEdit(t), { op: 'setStyle', blockIds: [2], style: 'normal' });
});

test('style picker toggles closed on a second click and closes when clicking elsewhere', async () => {
  const t = await opened(BODY);
  const btn = tool(t, 'Paragraph style');
  btn.click();
  assert.ok(menu(t));
  btn.click();
  assert.strictEqual(menu(t), null);
  btn.click();
  fire(t.content, 'mousedown', {});
  assert.strictEqual(menu(t), null);
});

// ------------------------------------------------------------------------------------- lists

test('Bullets and Numbering post setList (toggling off when already on); Outdent/Indent post setListLevel', async () => {
  const bullet = { kind: 'bullet', level: 0 };
  const t = await opened([P(1), P(2), P(3)]);
  tool(t, 'Bullets').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'setList', blockIds: [2], list: 'bullet' });
  const t2 = await opened([P(1), P(2, { list: bullet }), P(3)]);
  tool(t2, 'Bullets').click();
  assert.deepStrictEqual(lastEdit(t2), { op: 'setList', blockIds: [2], list: 'none' });
  await t2.answerEdit(1);
  assert.strictEqual(t2.live(), 'Bullets off');
  const t3 = await opened([P(1), P(2, { list: { kind: 'number', level: 0 } }), P(3)]);
  tool(t3, 'Numbering').click();
  assert.deepStrictEqual(lastEdit(t3), { op: 'setList', blockIds: [2], list: 'none' });
  const t4 = await opened([P(1), P(2, { list: { kind: 'bullet', level: 1 } }), P(3)]);
  tool(t4, 'Numbering').click();
  assert.deepStrictEqual(lastEdit(t4), { op: 'setList', blockIds: [2], list: 'number' }, 'switching kind');
  const t5 = await opened([P(1), P(2, { list: { kind: 'bullet', level: 1 } }), P(3)]);
  tool(t5, 'Indent').click();
  assert.deepStrictEqual(lastEdit(t5), { op: 'setListLevel', blockIds: [2], delta: 1 });
  const t6 = await opened([P(1), P(2, { list: { kind: 'bullet', level: 1 } }), P(3)]);
  tool(t6, 'Outdent').click();
  assert.deepStrictEqual(lastEdit(t6), { op: 'setListLevel', blockIds: [2], delta: -1 });
});

test('a block operation commits and closes the island first, then re-opens at the host focus', async () => {
  const t = await opened([P(1), P(2), P(3)], 2, [T(20, 'Hello')]);
  t.type('X');
  tool(t, 'Bullets').click();
  assert.strictEqual(t.of('docxEdit')[0].edit.op, 'commitParagraph', 'typed text is committed before the list change');
  await t.answerEdit(1);
  assert.strictEqual(lastEdit(t).op, 'setList');
  t.blocks = [P(1), P(2, { list: { kind: 'bullet', level: 0 } }), P(3)];
  await t.answerEdit(2, { blocks: t.blocks, changedBlockIds: [2], focus: { blockId: 2, at: 'end' } });
  await tick();
  t.send({ type: 'docxRender', version: 2, bytes: new Uint8Array([1]), blocks: t.blocks });
  await tick(); await t.viewer.whenIdle();
  await t.answerModel(2);
  await tick();
  assert.ok(t.island(), 'island re-opened');
  assert.strictEqual(pressed(t, 'Bullets'), 'true');
});

// ------------------------------------------------------------------------------------- shortcuts

const A = { ctrlKey: true, altKey: true };
const SHORTCUTS = [
  { name: 'Ctrl+Alt+0', ev: Object.assign({ key: '0', code: 'Digit0' }, A), op: { op: 'setStyle', blockIds: [2], style: 'normal' } },
  { name: 'Ctrl+Alt+1', ev: Object.assign({ key: '1', code: 'Digit1' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 1 } } },
  { name: 'Ctrl+Alt+2', ev: Object.assign({ key: '2', code: 'Digit2' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 2 } } },
  { name: 'Ctrl+Alt+3', ev: Object.assign({ key: '3', code: 'Digit3' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 3 } } },
  { name: 'Ctrl+Alt+4', ev: Object.assign({ key: '4', code: 'Digit4' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 4 } } },
  { name: 'Ctrl+Alt+5', ev: Object.assign({ key: '5', code: 'Digit5' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 5 } } },
  { name: 'Ctrl+Alt+6', ev: Object.assign({ key: '6', code: 'Digit6' }, A), op: { op: 'setStyle', blockIds: [2], style: { heading: 6 } } },
  { name: 'Cmd+Alt+2', ev: { key: '2', code: 'Digit2', metaKey: true, altKey: true }, op: { op: 'setStyle', blockIds: [2], style: { heading: 2 } } },
  { name: 'Ctrl+Shift+7 (code)', ev: { key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }, op: { op: 'setList', blockIds: [2], list: 'number' } },
  { name: 'Ctrl+Shift+8 (code)', ev: { key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true }, op: { op: 'setList', blockIds: [2], list: 'bullet' } },
  { name: 'Ctrl+Shift+7 (no code, US key)', ev: { key: '&', ctrlKey: true, shiftKey: true }, op: { op: 'setList', blockIds: [2], list: 'number' } },
  { name: 'Ctrl+Shift+8 (AZERTY-style key "8")', ev: { key: '8', code: 'Digit8', ctrlKey: true, shiftKey: true }, op: { op: 'setList', blockIds: [2], list: 'bullet' } },
  { name: 'Cmd+Shift+8', ev: { key: '*', code: 'Digit8', metaKey: true, shiftKey: true }, op: { op: 'setList', blockIds: [2], list: 'bullet' } },
];
for (const c of SHORTCUTS) {
  test('shortcut ' + c.name + ' maps to the right operation', async () => {
    const t = await opened(BODY);
    const ev = t.key(c.ev.key, c.ev);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(ev.stopped, true);
    assert.strictEqual(t.of('docxEdit').length, 1);
    assert.deepStrictEqual(lastEdit(t), c.op);
  });
}

test('shortcut near-misses do nothing: Ctrl+7, Ctrl+Alt+7, Ctrl+Shift+6, Ctrl+Alt+Shift+1, plain digits, Ctrl+Alt+B', async () => {
  const t = await opened(BODY);
  for (const ev of [
    { key: '7', code: 'Digit7', ctrlKey: true }, { key: '7', code: 'Digit7', ctrlKey: true, altKey: true },
    { key: '^', code: 'Digit6', ctrlKey: true, shiftKey: true }, { key: '1', code: 'Digit1', ctrlKey: true, altKey: true, shiftKey: true },
    { key: '1', code: 'Digit1' }, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true },
  ]) {
    const e = t.key(ev.key, ev);
    assert.strictEqual(e.defaultPrevented, false, JSON.stringify(ev));
  }
  assert.strictEqual(t.of('docxEdit').length, 0);
});

test('heading and list shortcuts do nothing in View mode, without an island, with AltGr, or once the island has closed', async () => {
  const view = await ready(BODY, { init: { editMode: false } });
  assert.strictEqual(view.key('1', { code: 'Digit1', ctrlKey: true, altKey: true }, view.content).defaultPrevented, false);
  const none = await ready(BODY);
  assert.strictEqual(none.key('1', { code: 'Digit1', ctrlKey: true, altKey: true }, none.content).defaultPrevented, false);
  const t = await opened(BODY);
  const gr = t.key('2', { code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' });
  assert.strictEqual(gr.defaultPrevented, false);
  assert.strictEqual(t.of('docxEdit').length, 0);
  t.key('1', { code: 'Digit1', ctrlKey: true, altKey: true });
  assert.strictEqual(t.of('docxEdit').length, 1);
  t.key('2', { code: 'Digit2', ctrlKey: true, altKey: true });     // the island closed: nothing to act on
  assert.strictEqual(t.of('docxEdit').length, 1);
});

// ------------------------------------------------------------------------------------- context menu

test('context menu on a paragraph: Insert paragraph after / Remove paragraph post the ops; default menu replaced', async () => {
  const t = await ready([P(1), P(2), P(3, { removable: false })]);
  const ev = fire(t.p(2), 'contextmenu', { clientX: 40, clientY: 50 });
  assert.strictEqual(ev.defaultPrevented, true);
  const m = menu(t);
  assert.strictEqual(m.getAttribute('aria-label'), 'Paragraph actions');
  assert.deepStrictEqual(menuItems(m).map(itemLabel), ['Insert paragraph after', 'Remove paragraph']);
  assert.strictEqual(m.style.left, '40px');
  assert.strictEqual(m.style.top, '50px');
  assert.strictEqual(t.doc.activeElement, item(t, 'Insert paragraph after'));
  item(t, 'Insert paragraph after').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'insertParagraphAfter', blockId: 2 });
  await t.answerEdit(1);
  assert.strictEqual(t.live(), 'Paragraph inserted');
  fire(t.p(2), 'contextmenu', { clientX: 1, clientY: 2 });
  item(t, 'Remove paragraph').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'removeParagraph', blockId: 2 });
  await t.answerEdit(2);

  fire(t.p(3), 'contextmenu', {});
  assert.strictEqual(item(t, 'Remove paragraph').getAttribute('aria-disabled'), 'true', 'not removable');
  const before = t.of('docxEdit').length;
  item(t, 'Remove paragraph').click();
  assert.strictEqual(t.of('docxEdit').length, before, 'a disabled item does nothing');
});

test('context menu in a table cell also offers Insert paragraph after table (inserts after the table block)', async () => {
  const t = await ready([TBL(1), C(2, 1, 0, 0), C(3, 1, 0, 1), P(4)]);
  fire(t.p(3), 'contextmenu', {});
  assert.deepStrictEqual(menuItems(menu(t)).map(itemLabel), ['Insert paragraph after', 'Insert paragraph after table', 'Remove paragraph']);
  item(t, 'Insert paragraph after table').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'insertParagraphAfter', blockId: 1 });
});

test('context menu is left to the browser in View mode and outside paragraphs; locked paragraphs still allow insert', async () => {
  const view = await ready(BODY, { init: { editMode: false } });
  assert.strictEqual(fire(view.p(2), 'contextmenu', {}).defaultPrevented, false);
  assert.strictEqual(menu(view), null);
  const t = await ready([P(1, { editable: false, lockReason: 'unknown-content', removable: false }), P(2)]);
  assert.strictEqual(fire(t.content, 'contextmenu', {}).defaultPrevented, false, 'not on a paragraph');
  fire(t.p(1), 'contextmenu', {});
  assert.strictEqual(item(t, 'Remove paragraph').getAttribute('aria-disabled'), 'true');
  item(t, 'Insert paragraph after').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'insertParagraphAfter', blockId: 1 });
});

test('keyboard only: Shift+F10 in an island opens the menu, arrows move, Enter runs, Escape returns focus to the island', async () => {
  const t = await opened([P(1), P(2), P(3)]);
  const ev = t.key('F10', { shiftKey: true });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(menu(t));
  assert.strictEqual(t.doc.activeElement, item(t, 'Insert paragraph after'));
  fire(t.island(), 'focusout', { relatedTarget: item(t, 'Insert paragraph after') });
  assert.notStrictEqual(t.island(), null, 'the island survives the focus move');
  fire(t.doc.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.strictEqual(t.doc.activeElement, item(t, 'Remove paragraph'));
  fire(t.doc.activeElement, 'keydown', { key: 'Escape' });
  assert.strictEqual(menu(t), null);
  assert.strictEqual(t.doc.activeElement, t.island());
  t.key('ContextMenu', {});                                              // the Menu key is the same gesture
  assert.ok(menu(t));
  fire(t.doc.activeElement, 'keydown', { key: 'ArrowDown' });
  const enter = fire(t.doc.activeElement, 'keydown', { key: 'Enter' });
  assert.strictEqual(enter.defaultPrevented, true);
  assert.deepStrictEqual(lastEdit(t), { op: 'removeParagraph', blockId: 2 });
  assert.strictEqual(t.of('docxEdit').length, 1, 'activated exactly once');
});

test('Shift+F10 without an island opens the current block menu (S3), not outside the document; Tab closes the menu', async () => {
  const t = await ready(BODY);
  assert.strictEqual(t.key('F10', { shiftKey: true }, t.doc.body).defaultPrevented, false, 'outside the document: left alone');
  assert.strictEqual(menu(t), null);
  assert.strictEqual(t.key('F10', { shiftKey: true }, t.content).defaultPrevented, true);
  assert.ok(menu(t), 'the current block (the first editable one) gets the menu');
  fire(t.doc.activeElement, 'keydown', { key: 'Escape' });
  assert.strictEqual(menu(t), null);
  assert.strictEqual(t.doc.activeElement, t.p(1), 'Escape puts the focus on the block');
  const o = await opened(BODY);
  o.key('F10', { shiftKey: true });
  fire(o.doc.activeElement, 'keydown', { key: 'Tab' });
  assert.strictEqual(menu(o), null);
});

test('the menu closes when the host state changes (undo/redo) or Edit is turned off', async () => {
  const t = await opened(BODY);
  t.key('F10', { shiftKey: true });
  assert.ok(menu(t));
  t.send({ type: 'docxStateChanged', version: 5 });
  assert.strictEqual(menu(t), null);
  const o = await ready(BODY);
  fire(o.p(2), 'contextmenu', {});
  o.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(menu(o), null);
});

// ------------------------------------------------------------------------------------- hover actions

test('hover bar: shown in Edit mode beside the paragraph, posts insert/remove, hides again', async () => {
  const t = setup({ blocks: [P(1), P(2), P(3, { removable: false })] });
  t.rects = { 2: { top: 100, bottom: 120, left: 50, right: 300, height: 20, width: 250 } };
  t.init();
  await t.render(0);
  assert.strictEqual(hover(t), null, 'built lazily');
  fire(t.p(2), 'mouseover', {});
  const bar = hover(t);
  assert.strictEqual(bar.hidden, false);
  assert.strictEqual(bar.style.top, '100px');
  assert.strictEqual(bar.style.left, '300px');
  assert.strictEqual(bar.getAttribute('role'), 'group');
  assert.strictEqual(hoverBtn(t, 'docx-hover-insert').getAttribute('aria-label'), 'Insert paragraph after');
  assert.strictEqual(hoverBtn(t, 'docx-hover-insert').getAttribute('tabindex'), '-1');
  assert.strictEqual(hoverBtn(t, 'docx-hover-remove').hidden, false);
  assert.strictEqual(hoverBtn(t, 'docx-hover-table').hidden, true);
  assert.strictEqual(all(bar, (e) => e.className === 'docx-lock-chip')[0].hidden, true);
  hoverBtn(t, 'docx-hover-insert').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'insertParagraphAfter', blockId: 2 });
  assert.strictEqual(bar.hidden, true);
  await t.answerEdit(1);

  fire(t.p(2), 'mouseover', {});
  hoverBtn(t, 'docx-hover-remove').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'removeParagraph', blockId: 2 });
  await t.answerEdit(2);

  fire(t.p(3), 'mouseover', {});
  assert.strictEqual(hoverBtn(t, 'docx-hover-remove').hidden, true, 'not removable');
  fire(t.content, 'mouseover', {});
  assert.strictEqual(hover(t).hidden, true);
});

test('hover bar on a locked paragraph shows a text "Locked" chip; in a cell it offers Insert after table; none in View mode', async () => {
  const t = await ready([TBL(1), C(2, 1, 0, 0), P(3, { editable: false, lockReason: 'unknown-content', removable: false })]);
  fire(t.p(3), 'mouseover', {});
  const chip = all(hover(t), (e) => e.className === 'docx-lock-chip')[0];
  assert.strictEqual(chip.hidden, false);
  assert.strictEqual(chip.textContent, 'Locked');
  fire(t.p(2), 'mouseover', {});
  assert.strictEqual(hoverBtn(t, 'docx-hover-table').hidden, false);
  hoverBtn(t, 'docx-hover-table').click();
  assert.deepStrictEqual(lastEdit(t), { op: 'insertParagraphAfter', blockId: 1 });

  const view = await ready(BODY, { init: { editMode: false } });
  fire(view.p(2), 'mouseover', {});
  assert.strictEqual(hover(view), null);
});

// ------------------------------------------------------------------------------------- static checks

test('no innerHTML in docxEditor.js; menus and chips are built with createElement/textContent', () => {
  const code = read('docxEditor.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
});

test('stylesheet: hover outline, lock styling, chips, cell focus ring, menu and hover bar tokens, high contrast and forced colours', () => {
  const css = read('docxEditor.css');
  assert.match(css, /\[data-docx-edit="1"\] \.docx-host p\[data-docx-editable\][^{]*:hover\s*\{/);
  assert.match(css, /p\[data-docx-locked\]:hover/);
  assert.match(css, /td:focus-within/);
  assert.match(css, /\.docx-chip\s*\{/);
  assert.match(css, /\.docx-lock-chip/);
  assert.match(css, /\.docx-menu\s*\{/);
  assert.match(css, /\.docx-hover-actions\s*\{/);
  assert.match(css, /--vscode-menu-background/);
  assert.match(css, /body\.vscode-high-contrast[^{]*\.docx-menu/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.docx-menu/);
  assert.match(css, /span\[id\^="__vsmd_"\]\s*\{\s*display:\s*none;?\s*\}/);
  assert.doesNotMatch(css, /transition|animation/, 'no motion');
});
