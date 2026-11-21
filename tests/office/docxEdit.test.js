// WP-34: the Word edit controller (media/docxEdit.js) wired into the viewer (media/docxEditor.js),
// with officeCommon.js, docxMap.js and docxIsland.js, all run in node:vm against a DOM shim with
// events (capture + bubble), a recording Selection, fake timers and a stub docx-preview that renders
// the blocks' marker bookmarks. The host is a stub: tests answer each request by hand.
// Needs a real window (Gate R3): caret placement on click and after re-render in Chrome, IME, native
// paste, ArrowUp/Down line detection (layout), the scroll anchor with real geometry, large.docx.
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

// ------------------------------------------------------------------------------------- tests

test('the webview loads docxMap/docxIsland/docxEdit and the stylesheet hides marker spans', () => {
  const css = read('docxEditor.css');
  assert.match(css, /span\[id\^="__vsmd_"\]\s*\{\s*display:\s*none;?\s*\}/);
  for (const [name, src] of SRC) {
    const code = src.replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), name);
  }
});

test('render is mapped and swapped; editable and locked paragraphs are marked (tooltip + aria-describedby)', async () => {
  const t = await ready([P(1), P(2, { editable: false, lockReason: 'tracked-changes' }), P(3, { style: { kind: 'heading', level: 2, name: 'heading 2' } })]);
  assert.strictEqual(t.renders, 1);
  assert.strictEqual(t.p(1).getAttribute('data-docx-editable'), '1');
  const locked = t.p(2);
  assert.strictEqual(locked.getAttribute('data-docx-locked'), 'tracked-changes');
  assert.match(locked.getAttribute('title'), /tracked changes/);
  const desc = t.doc.getElementById(locked.getAttribute('aria-describedby'));
  assert.ok(desc, 'aria-describedby points at a description element');
  assert.match(desc.textContent, /tracked changes/);
  assert.strictEqual(t.p(3).getAttribute('role'), 'heading');
});

test('click opens an island: block model requested, textbox semantics, caret at the clicked character', async () => {
  const t = await ready(BODY, { texts: { 2: 'Hello world' } });
  t.click(2, 6);
  await tick();
  deq(t.last('docxRequestBlockModel'), { type: 'docxRequestBlockModel', requestId: t.last('docxRequestBlockModel').requestId, blockId: 2 });
  assert.strictEqual(t.island(), null, 'nothing editable before the model arrives');
  await t.answerModel(0, [T(20, 'Hello '), T(21, 'world', { b: true })]);
  const p = t.island();
  assert.strictEqual(p, t.p(2));
  assert.strictEqual(p.getAttribute('contenteditable'), 'true');
  assert.strictEqual(p.getAttribute('role'), 'textbox');
  assert.strictEqual(p.getAttribute('aria-multiline'), 'true');
  assert.strictEqual(p.getAttribute('aria-label'), 'Paragraph 2');
  assert.strictEqual(t.doc.activeElement, p);
  assert.strictEqual(t.I.offsetOf(p, t.doc.selection), 6);
});

test('locked paragraph refuses: lock hint, no request; View mode clicks open nothing', async () => {
  const t = await ready([P(1, { editable: false, lockReason: 'unknown-content' }), P(2)]);
  t.click(1);
  await tick();
  assert.strictEqual(t.of('docxRequestBlockModel').length, 0);
  assert.match(t.hintText(), /doesn't understand/);
  t.send({ type: 'editModeChanged', editMode: false });
  t.click(2);
  await tick();
  assert.strictEqual(t.of('docxRequestBlockModel').length, 0);
});

test('typing commits at most 1 s after the first uncommitted key (S2), without rebuilding the island (node identity)', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  const p = t.island();
  t.type('d');
  const nodes = all(p, () => true);
  t.clock.advance(600);
  assert.strictEqual(t.of('docxEdit').length, 0, 'not at once');
  t.type('e');                     // more typing does not push the first key's deadline back
  t.clock.advance(399);
  assert.strictEqual(t.of('docxEdit').length, 0);
  t.clock.advance(1);
  const e = t.last('docxEdit');
  deq(e.edit, { op: 'commitParagraph', blockId: 1, items: [{ kind: 'text', text: 'abcde', b: false, i: false, u: false, src: 100 }] });
  assert.strictEqual(e.baseVersion, 0);
  await t.answerEdit(1);
  assert.strictEqual(t.island(), p, 'island still open');
  const after = all(p, () => true);
  assert.strictEqual(after.length, nodes.length);
  after.forEach((n, k) => assert.strictEqual(n, nodes[k], 'node ' + k + ' is the same object'));
  assert.strictEqual(t.doc.activeElement, p);
  // Nothing new typed: the next idle tick sends nothing.
  t.clock.advance(5000);
  assert.strictEqual(t.of('docxEdit').length, 1);
  assert.strictEqual(t.of('docxRequestRender').length, 0, 'no render request while the island is open');
});

test('requests go one at a time; the next edit carries the version of the previous reply', async () => {
  const t = await ready(BODY, { texts: { 1: 'a', 2: 'b' } });
  await t.open(1, 1);
  t.type('x');
  t.clock.advance(1500);
  assert.strictEqual(t.of('docxEdit').length, 1);
  t.click(2, 1);                   // blur commit of 1 already in flight; open 2 waits
  fire(t.p(1), 'focusout', { relatedTarget: null });
  await tick();
  assert.strictEqual(t.of('docxRequestBlockModel').length, 1, 'model request for 2 waits for the commit reply');
  await t.answerEdit(4);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 2);
  await t.answerModel(4);
  t.type('y');
  t.clock.advance(1500);
  assert.strictEqual(t.last('docxEdit').baseVersion, 4);
});

test('no render call while an island has focus; after it closes the render runs (2 s later)', async () => {
  const t = await ready(BODY);
  await t.open(1, 0);
  t.type('z');
  t.send({ type: 'docxRender', version: 0, bytes: new Uint8Array([2]), blocks: BODY });
  await tick();
  t.clock.advance(10000);
  await tick();
  assert.strictEqual(t.renders, 1, 'docx-preview is not called while the island is open');
  fire(t.island(), 'focusout', { relatedTarget: null });
  await tick();
  assert.strictEqual(t.island(), null);
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
  await t.answerEdit(1);
  t.clock.advance(1999);
  await tick();
  assert.strictEqual(t.of('docxRequestRender').length, 0);
  t.clock.advance(1);
  await tick();
  // The held render (version 0) is older than the commit: it is dropped and a fresh one requested.
  assert.strictEqual(t.renders, 1);
  assert.strictEqual(t.of('docxRequestRender').length, 1);
  await t.render(1);
  assert.strictEqual(t.renders, 2);
});

test('a render that arrives with no island open is swapped in; one held for an island waits for its close', async () => {
  const t = await ready(BODY);
  await t.render(0);
  assert.strictEqual(t.renders, 2);
  await t.open(2, 0);
  await t.render(0);
  assert.strictEqual(t.renders, 2);
  fire(t.island(), 'focusout', { relatedTarget: null });   // clean: nothing to commit
  await tick();
  assert.strictEqual(t.of('docxEdit').length, 0);
  t.clock.advance(2000);
  await tick();
  await t.viewer.whenIdle();
  assert.strictEqual(t.renders, 3, 'the held render runs 2 s after the island closed');
});

test('Enter splits: splitParagraph posted, DOM split at once, keys typed meanwhile land in the new island', async () => {
  const t = await ready(BODY, { texts: { 2: 'Hello world' } });
  await t.open(2, 6, 3);
  const p = t.island();
  const ev = t.key('Enter');
  assert.ok(ev.defaultPrevented);
  const e = t.last('docxEdit');
  deq(e.edit, { op: 'splitParagraph', blockId: 2,
    before: [{ kind: 'text', text: 'Hello ', b: false, i: false, u: false, src: 200 }],
    after: [{ kind: 'text', text: 'world', b: false, i: false, u: false, src: 200 }] });
  assert.strictEqual(e.baseVersion, 3);
  assert.strictEqual(p.textContent, 'Hello ');
  const clone = p.nextSibling;
  assert.strictEqual(clone.textContent, 'world', 'second half shown before the reply');
  assert.strictEqual(clone.getAttribute('contenteditable'), null);
  // Typing before the reply is buffered, not lost.
  assert.ok(t.key('X', {}, t.doc.body).defaultPrevented);
  const blocks = [P(1), P(2), P(50), P(3)];
  t.blocks = blocks;
  await t.answerEdit(4, { blocks, changedBlockIds: [2, 50], focus: { blockId: 50, at: 'start' } });
  assert.strictEqual(clone.getAttribute('data-block'), '50');
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 50);
  await t.answerModel(4, [T(5000, 'world')]);
  assert.strictEqual(t.island(), clone);
  assert.strictEqual(clone.textContent, 'Xworld', 'buffered key replayed at the focus position');
  assert.strictEqual(p.getAttribute('contenteditable'), null, 'first half is no longer an island');
});

test('Enter refused: the DOM is put back and the island resumes with the caret where it was', async () => {
  const t = await ready(BODY, { texts: { 2: 'Hello world' } });
  await t.open(2, 6);
  const p = t.island();
  t.key('Enter');
  await t.failEdit({ code: 'blocked', message: 'Too many paragraphs.' });
  assert.strictEqual(t.island(), p);
  assert.strictEqual(p.textContent, 'Hello world');
  assert.strictEqual(t.ps(2).length, 1);
  assert.strictEqual(p.nextSibling && p.nextSibling.textContent, 'Text 3');
  assert.strictEqual(t.I.offsetOf(p, t.doc.selection), 6);
  assert.strictEqual(t.hintText(), 'Too many paragraphs.');
});

test('Shift+Enter inserts a line break in the island', async () => {
  const t = await ready(BODY, { texts: { 1: 'ab' } });
  await t.open(1, 1);
  assert.ok(t.key('Enter', { shiftKey: true }).defaultPrevented);
  deq(t.I.read(t.island()), [{ kind: 'text', text: 'a\nb', b: false, i: false, u: false, src: 100 }]);
  assert.strictEqual(t.of('docxEdit').length, 0);
});

test('Backspace at start posts mergeWithPrevious only when the previous sibling is in the same container', async () => {
  const blocks = [P(1), TBL(10), C(11, 10, 0, 0), C(12, 10, 0, 0), C(13, 10, 0, 1), P(2)];
  const t = await ready(blocks);
  // First paragraph of a cell: the previous block in document order is the table, not a sibling.
  await t.open(11, 0);
  assert.ok(t.key('Backspace').defaultPrevented);
  assert.strictEqual(t.of('docxEdit').length, 0);
  // Body paragraph after the table: its previous sibling is the table (opaque): nothing.
  fire(t.island(), 'focusout', { relatedTarget: null });
  await t.open(2, 0);
  t.key('Backspace');
  assert.strictEqual(t.of('docxEdit').length, 0);
  // Second paragraph of the same cell: merges with the first.
  fire(t.island(), 'focusout', { relatedTarget: null });
  await t.open(12, 0);
  const p12 = t.island();
  t.key('Backspace');
  deq(t.last('docxEdit').edit, { op: 'mergeWithPrevious', blockId: 12, items: [{ kind: 'text', text: 'Text 12', b: false, i: false, u: false, src: 1200 }] });
  assert.strictEqual(p12.parentNode, null, 'merged paragraph removed at once');
  assert.strictEqual(t.p(11).textContent, 'Text 11Text 12');
  t.blocks = [P(1), TBL(10), C(11, 10, 0, 0), C(13, 10, 0, 1), P(2)];
  await t.answerEdit(1, { blocks: t.blocks, changedBlockIds: [11], focus: { blockId: 11, at: 7 } });
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 11);
  await t.answerModel(1, [T(1100, 'Text 11Text 12')]);
  assert.strictEqual(t.island(), t.p(11));
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 7);
});

test('Backspace at the start of the first paragraph after a locked one hints and posts nothing', async () => {
  const t = await ready([P(1, { editable: false, lockReason: 'tracked-changes' }), P(2)]);
  await t.open(2, 0);
  t.key('Backspace');
  assert.strictEqual(t.of('docxEdit').length, 0);
  assert.match(t.hintText(), /tracked changes/);
});

test('Delete at end commits this paragraph, then merges the next sibling (its content unchanged) into it', async () => {
  const t = await ready(BODY, { texts: { 1: 'ab' } });
  await t.open(1, 2);
  t.type('c');
  t.key('Delete');
  deq(t.last('docxEdit').edit, { op: 'commitParagraph', blockId: 1, items: [{ kind: 'text', text: 'abc', b: false, i: false, u: false, src: 100 }] });
  await t.answerEdit(1);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 2);
  await t.answerModel(1, [T(200, 'Text 2'), { kind: 'anchor', id: 201 }]);
  deq(t.last('docxEdit').edit, { op: 'mergeWithPrevious', blockId: 2, items: [{ kind: 'text', text: 'Text 2', b: false, i: false, u: false, src: 200 }, { kind: 'anchor', id: 201 }] });
  assert.strictEqual(t.last('docxEdit').baseVersion, 1);
  assert.strictEqual(t.ps(2).length, 0);
  t.blocks = [P(1), P(3)];
  await t.answerEdit(2, { blocks: t.blocks, changedBlockIds: [1], focus: { blockId: 1, at: 3 } });
  await t.answerModel(2, [T(100, 'abcText 2')]);
  assert.strictEqual(t.island(), t.p(1));
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 3);
});

test('stale result -> refetch the block model and reopen the island', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  t.clock.advance(1500);
  await t.failEdit({ code: 'stale', message: 'The document changed. Your edit was not applied.' });
  assert.strictEqual(t.hintText(), 'The document changed; your unfinished edit was discarded.');
  const req = t.last('docxRequestBlockModel');
  assert.strictEqual(req.blockId, 1);
  assert.strictEqual(t.of('docxRequestBlockModel').length, 2);
  await t.answerModel(7, [T(100, 'abX')]);
  assert.strictEqual(t.island(), t.p(1));
  assert.strictEqual(t.island().textContent, 'abX');
  t.type('!');
  t.clock.advance(1500);
  assert.strictEqual(t.last('docxEdit').baseVersion, 7);
});

test('docxStateChanged with an open island discards it, announces, and re-renders at once', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  const p = t.island();
  t.type('d');
  t.send({ type: 'docxStateChanged', version: 9 });
  assert.strictEqual(t.island(), null);
  assert.strictEqual(p.getAttribute('contenteditable'), null);
  assert.strictEqual(t.hintText(), 'The document changed; your unfinished edit was discarded.');
  assert.strictEqual(t.live().indexOf('The document changed') >= 0, true);
  assert.strictEqual(t.of('docxRequestRender').length, 1);
  t.clock.advance(5000);
  assert.strictEqual(t.of('docxEdit').length, 0, 'the discarded edit is never committed');
  await t.render(9);
  assert.strictEqual(t.renders, 2);
  assert.strictEqual(t.p(1).textContent, 'abc');
});

test('swap keeps the block nearest the viewport top where it was', async () => {
  const t = setup({ blocks: BODY });
  t.init();
  t.rects = { 1: { top: -120, bottom: -20, height: 100 }, 2: { top: -20, bottom: 80, height: 100 }, 3: { top: 80, bottom: 180, height: 100 } };
  await t.render(0);
  t.content.scrollTop = 500;
  // The new render moved block 2 down by 300 px (content above it grew).
  t.rects = { 1: { top: -120, bottom: 180, height: 300 }, 2: { top: 280, bottom: 380, height: 100 }, 3: { top: 380, bottom: 480, height: 100 } };
  await t.render(0);
  assert.strictEqual(t.content.scrollTop, 800, 'block 2 stays 20 px above the viewport top');
});

test('Tab in a cell commits and focuses the next cell\'s first editable block; at the last cell nothing happens', async () => {
  const blocks = [TBL(10), C(11, 10, 0, 0), C(12, 10, 0, 1, { editable: false, lockReason: 'merged-cell' }), C(13, 10, 1, 0), C(14, 10, 1, 0), C(15, 10, 1, 1)];
  const t = await ready(blocks, { texts: { 11: 'a' } });
  await t.open(11, 1);
  t.type('b');
  const ev = t.key('Tab');
  assert.ok(ev.defaultPrevented && ev.stopped);
  deq(t.last('docxEdit').edit.op, 'commitParagraph');
  await t.answerEdit(1);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 13, 'merged-cell continuation skipped');
  await t.answerModel(1);
  assert.strictEqual(t.island(), t.p(13));
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 0);
  t.key('Tab');
  await t.answerModel(1);
  assert.strictEqual(t.island(), t.p(15));
  const n = t.posted.length;
  assert.ok(t.key('Tab').defaultPrevented);
  assert.strictEqual(t.posted.length, n, 'last cell: nothing');
  assert.strictEqual(t.island(), t.p(15));
  t.key('Tab', { shiftKey: true });
  await t.answerModel(1);
  assert.strictEqual(t.island(), t.p(13), 'Shift+Tab: previous cell\'s first editable paragraph');
  t.key('Tab', { ctrlKey: true });
  deq(t.I.read(t.island())[0].text, '\tText 13', 'Ctrl+Tab inserts a tab');
});

test('Tab: list level at the start of a list item (rendered at once, island back after the render); tab character elsewhere', async () => {
  const blocks = [P(1, { list: { kind: 'bullet', level: 0 } }), P(2)];
  const t = await ready(blocks);
  await t.open(1, 0);
  t.key('Tab');
  deq(t.last('docxEdit').edit, { op: 'setListLevel', blockIds: [1], delta: 1 });
  t.blocks = [P(1, { list: { kind: 'bullet', level: 1 } }), P(2)];
  await t.answerEdit(1, { blocks: t.blocks, changedBlockIds: [1] });
  assert.strictEqual(t.of('docxRequestRender').length, 1, 'list change renders immediately');
  await t.render(1);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 1, 'focus after re-render');
  await t.answerModel(1);
  assert.strictEqual(t.island(), t.p(1));
  fire(t.island(), 'focusout', { relatedTarget: null });
  await t.open(2, 2);
  t.key('Tab');
  deq(t.I.read(t.island())[0].text, 'Te\txt 2');
});

test('ArrowDown at the end moves to the next editable paragraph (into a cell), ArrowUp back out', async () => {
  const blocks = [P(1), P(2, { editable: false, lockReason: 'tracked-changes' }), TBL(10), C(11, 10, 0, 0)];
  const t = await ready(blocks, { texts: { 1: 'ab' } });
  await t.open(1, 1);
  assert.ok(!t.key('ArrowDown').defaultPrevented, 'not on the last line yet: the browser moves the caret');
  t.caretAt('end');
  assert.ok(t.key('ArrowDown').defaultPrevented);
  await tick();
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 11);
  await t.answerModel(0);
  t.caretAt('start');
  t.key('ArrowUp');
  await tick();
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 1);
  await t.answerModel(0);
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 2, 'ArrowUp lands at the end');
});

test('Ctrl+Z in a dirty island cancels the typing (kept from VS Code); in a clean island it closes and passes through', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  const p = t.island();
  t.type('XYZ');
  const ev = t.key('z', { ctrlKey: true });
  assert.ok(ev.defaultPrevented && ev.stopped, 'the workbench never sees it');
  assert.strictEqual(p.textContent, 'abc');
  assert.strictEqual(t.island(), p);
  const redo = t.key('y', { ctrlKey: true });
  assert.strictEqual(redo.defaultPrevented, false, 'clean island: Ctrl+Y goes to VS Code');
  assert.strictEqual(t.island(), null, 'and the island closed');
  t.clock.advance(5000);
  assert.strictEqual(t.of('docxEdit').length, 0);
});

test('Ctrl+Z after an idle commit re-renders and reopens at the same place (the document holds the commit)', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  t.clock.advance(1500);
  await t.answerEdit(1);
  t.type('e');
  assert.ok(t.key('z', { ctrlKey: true }).defaultPrevented);
  assert.strictEqual(t.island(), null);
  assert.strictEqual(t.of('docxRequestRender').length, 1);
  t.texts[1] = 'abcd';
  await t.render(1);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 1);
  await t.answerModel(1, [T(100, 'abcd')]);
  assert.strictEqual(t.island().textContent, 'abcd');
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 4);
});

test('Escape cancels the in-progress edit and closes the island', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  const p = t.island();
  t.type('!');
  t.key('Escape');
  assert.strictEqual(t.island(), null);
  assert.strictEqual(p.textContent, 'abc');
  t.clock.advance(5000);
  assert.strictEqual(t.of('docxEdit').length, 0);
});

test('flushPendingEdits waits for the commit in flight and never commits the open island', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  t.send({ type: 'flushPendingEdits', flushId: 4 });
  await tick();
  assert.strictEqual(t.of('docxEdit').length, 0, 'the open island is not committed by a flush');
  deq(t.of('flushed'), [{ type: 'flushed', flushId: 4 }]);
  t.clock.advance(1500);                          // idle commit now in flight
  t.send({ type: 'flushPendingEdits', flushId: 5 });
  await tick();
  assert.strictEqual(t.of('flushed').length, 1, 'waits for the reply');
  await t.answerEdit(1);
  await tick();
  deq(t.of('flushed')[1], { type: 'flushed', flushId: 5 });
  assert.ok(t.island(), 'island still open after the flush');
});

test('Ctrl+S in an island commits it and lets the key through to VS Code; the save flush waits for it', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  const ev = t.key('s', { ctrlKey: true });
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(ev.stopped, false);
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
  t.send({ type: 'flushPendingEdits', flushId: 1 });
  await tick();
  assert.strictEqual(t.of('flushed').length, 0);
  await t.answerEdit(1);
  await tick();
  assert.strictEqual(t.of('flushed').length, 1);
  assert.ok(t.island());
});

test('a flush never hangs on a lost reply (bounded below the host timeout)', async () => {
  const t = await ready(BODY);
  await t.open(1, 0);
  t.type('x');
  t.clock.advance(1500);
  t.send({ type: 'flushPendingEdits', flushId: 2 });
  await tick();
  t.clock.advance(1200);
  await tick();
  assert.strictEqual(t.of('flushed').length, 1);
});

test('turning Edit off commits and closes the island first, then asks the host', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  t.key('e', { ctrlKey: true });
  await tick();
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
  assert.strictEqual(t.of('setEditMode').length, 0, 'waits for the commit reply');
  assert.strictEqual(t.island(), null);
  await t.answerEdit(1);
  await tick();
  deq(t.last('setEditMode'), { type: 'setEditMode', editMode: false });
  t.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(t.content.getAttribute('data-docx-edit'), '0');
  t.click(2);
  await tick();
  assert.strictEqual(t.of('docxRequestBlockModel').length, 1, 'View mode: no island');
});

test('blur to the toolbar keeps the island open; blur elsewhere commits and closes it', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  const btn = t.doc.createElement('button');
  t.toolbar.appendChild(btn);
  fire(t.island(), 'focusout', { relatedTarget: btn });
  assert.ok(t.island());
  assert.strictEqual(t.of('docxEdit').length, 0);
  const p = t.island();
  fire(p, 'focusout', { relatedTarget: null });
  assert.strictEqual(t.island(), null);
  assert.strictEqual(p.getAttribute('role'), null);
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
});

test('a block operation (setStyle) commits first, renders at once and puts the island back after the render', async () => {
  const t = await ready(BODY, { texts: { 2: 'Title' } });
  await t.open(2, 3);
  t.type('!');
  const done = t.edit.applyOp({ op: 'setStyle', blockIds: [2], style: { heading: 1 } });
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
  await t.answerEdit(1);
  deq(t.last('docxEdit').edit, { op: 'setStyle', blockIds: [2], style: { heading: 1 } });
  assert.strictEqual(t.last('docxEdit').baseVersion, 1);
  t.blocks = [P(1), P(2, { style: { kind: 'heading', level: 1, name: 'heading 1' } }), P(3)];
  await t.answerEdit(2, { blocks: t.blocks, changedBlockIds: [2] });
  await done;
  assert.strictEqual(t.of('docxRequestRender').length, 1);
  t.texts[2] = 'Tit!le';
  await t.render(2);
  assert.strictEqual(t.p(2).getAttribute('role'), 'heading');
  await t.answerModel(2, [T(200, 'Tit!le')]);
  assert.strictEqual(t.island(), t.p(2));
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 4, 'caret where it was');
});

test('insertParagraphAfter: the new block is not in the DOM yet, so render and focus it afterwards', async () => {
  const t = await ready([TBL(10), C(11, 10, 0, 0), P(1)]);
  t.edit.applyOp({ op: 'insertParagraphAfter', blockId: 10 });
  t.blocks = [TBL(10), C(11, 10, 0, 0), P(60), P(1)];
  await t.answerEdit(1, { blocks: t.blocks, changedBlockIds: [60], focus: { blockId: 60, at: 'start' } });
  assert.strictEqual(t.of('docxRequestRender').length, 1);
  await t.render(1);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 60);
  await t.answerModel(1, []);
  assert.strictEqual(t.island(), t.p(60));
});

test('paste inserts plain text only', async () => {
  const t = await ready(BODY, { texts: { 1: 'ab' } });
  await t.open(1, 1);
  const ev = fire(t.island(), 'paste', { clipboardData: { getData: (k) => (k === 'text/plain' ? 'X\r\nY' : '<b>bad</b>') } });
  assert.ok(ev.defaultPrevented);
  deq(t.I.read(t.island()), [{ kind: 'text', text: 'aX\nYb', b: false, i: false, u: false, src: 100 }]);
  assert.ok(fire(t.island(), 'beforeinput', { inputType: 'formatBold' }).defaultPrevented);
});

test('a block-model failure (locked since the render) hints and leaves no island', async () => {
  const t = await ready(BODY);
  t.click(1);
  await tick();
  const req = t.last('docxRequestBlockModel');
  t.send({ type: 'requestFailed', requestId: req.requestId, error: { code: 'blocked', message: "This content can't be edited here." } });
  await tick();
  assert.strictEqual(t.island(), null);
  assert.strictEqual(t.hintText(), "This content can't be edited here.");
  assert.ok(!t.edit.state().busy);
});

test('a page-break-split paragraph opens in its first <p>; the other half is hidden while the island holds all of it', async () => {
  const t = setup({ blocks: [P(1)] });
  t.init();
  t.send({ type: 'docxRender', version: 0, bytes: new Uint8Array([1]), blocks: [P(1)] });
  // Override the stub for this render: the block is rendered as two <p>s on two pages.
  t.blocks = [P(1)];
  await tick(); await t.viewer.whenIdle();
  const first = t.p(1);
  const second = t.doc.createElement('p');
  const endSpan = all(first, (n) => n.nodeType === 1 && n.getAttribute('id') === '__vsmd_e_1')[0];
  first.removeChild(endSpan);
  second.appendChild(t.doc.createTextNode('page two'));
  second.appendChild(endSpan);
  first.parentNode.appendChild(second);
  // Remap the edited DOM as a render would.
  const mapping = t.sandbox.DocxMap.mapBlocks(t.content, [P(1)]);
  t.edit.onRendered(mapping, { version: 0, blocks: [P(1)] });
  await t.open(1, 0);
  assert.strictEqual(t.island(), first);
  assert.strictEqual(second.hidden, true);
});

test('Delete at end: a refused commit stops the merge and the island resumes', async () => {
  const t = await ready(BODY, { texts: { 1: 'ab' } });
  await t.open(1, 2);
  t.type('c');
  t.key('Delete');
  await t.failEdit({ code: 'blocked', message: 'No.' });
  assert.strictEqual(t.of('docxRequestBlockModel').length, 1, 'next paragraph never fetched');
  assert.strictEqual(t.island(), t.p(1));
  assert.strictEqual(t.hintText(), 'No.');
  assert.ok(!t.edit.state().busy);
});

// ------------------------------------------------------------------------------------- review fixes (2026-11-21)

const SAVING = { code: 'blocked', message: 'The document is being saved. Try again in a moment.' };

test('review B1: a blur commit refused while saving reopens the island with the typed text and retries it', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  const p = t.island();
  fire(p, 'focusout', { relatedTarget: null });
  assert.strictEqual(t.island(), null, 'closed on blur');
  deq(t.last('docxEdit').edit.items, [{ kind: 'text', text: 'abcd', b: false, i: false, u: false, src: 100 }]);
  await t.failEdit(SAVING);
  assert.strictEqual(t.island(), p, 'reopened with its DOM');
  assert.strictEqual(p.textContent, 'abcd', 'the typed text is still there');
  assert.strictEqual(t.hintText(), SAVING.message);
  assert.strictEqual(t.of('docxRequestRender').length, 0, 'no render over the typed text');
  await t.render(0);                          // a render arriving now waits
  assert.strictEqual(t.p(1).textContent, 'abcd');
  assert.strictEqual(t.renders, 1);
  t.clock.advance(1000);                      // re-armed: sent again
  assert.strictEqual(t.of('docxEdit').length, 2);
  deq(t.last('docxEdit').edit.items, [{ kind: 'text', text: 'abcd', b: false, i: false, u: false, src: 100 }]);
  await t.answerEdit(1);
  assert.ok(t.island(), 'still open after the retry');
});

test('review B1: a refused idle commit is retried; a flush sends it again before answering', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  t.clock.advance(1000);
  assert.strictEqual(t.of('docxEdit').length, 1);
  await t.failEdit(SAVING);
  assert.ok(t.island());
  t.send({ type: 'flushPendingEdits', flushId: 9 });
  await tick();
  assert.strictEqual(t.of('docxEdit').length, 2, 'the flush retried the refused commit');
  assert.strictEqual(t.of('flushed').length, 0, 'and waits for it');
  await t.answerEdit(1);
  await tick();
  deq(t.of('flushed'), [{ type: 'flushed', flushId: 9 }]);
  // Without a flush the idle timer retries it too.
  t.type('e');
  t.clock.advance(1000);
  await t.failEdit(SAVING);
  t.clock.advance(60000);
  assert.strictEqual(t.of('docxEdit').length, 4, 'retried once by the re-armed timer');
  await t.answerEdit(2);
  t.clock.advance(60000);
  assert.strictEqual(t.of('docxEdit').length, 4, 'nothing more once it landed');
});

test('review B1: a closed island that cannot be reopened (another one is opening) is re-sent in the background', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc', 2: 'xyz' } });
  await t.open(1, 3);
  t.type('d');
  t.click(2, 1);                               // closes 1 (commit in flight), opening 2 waits for it
  fire(t.p(1), 'focusout', { relatedTarget: null });
  await tick();
  await t.failEdit(SAVING);
  await t.answerModel(0);
  assert.strictEqual(t.island(), t.p(2), 'the other island opened');
  assert.strictEqual(t.p(1).textContent, 'abcd', 'the closed one still shows the typing');
  assert.strictEqual(t.edit.state().retrying, 1);
  fire(t.island(), 'focusout', { relatedTarget: null });   // 2 closes clean: a render would be due
  t.clock.advance(999);
  assert.strictEqual(t.of('docxRequestRender').length, 0, 'renders wait while a commit is being retried');
  t.clock.advance(1);
  deq(t.last('docxEdit').edit, { op: 'commitParagraph', blockId: 1, items: [{ kind: 'text', text: 'abcd', b: false, i: false, u: false, src: 100 }] });
  await t.answerEdit(1);
  assert.strictEqual(t.edit.state().retrying, 0);
  t.clock.advance(2000);
  assert.strictEqual(t.of('docxRequestRender').length, 1, 'the render follows once it landed');
});

test('review B1: a genuine refusal of a blur commit keeps the text (island reopened), without retrying', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  t.type('d');
  fire(t.island(), 'focusout', { relatedTarget: null });
  await t.failEdit({ code: 'blocked', message: 'This paragraph cannot be edited here (x).' });
  assert.strictEqual(t.island().textContent, 'abcd');
  t.clock.advance(60000);
  assert.strictEqual(t.of('docxEdit').length, 1, 'not retried');
});

test('review S2: steady typing commits about once a second; Ctrl+S / Ctrl+W anywhere and leaving the window commit', async () => {
  const t = await ready(BODY, { texts: { 1: 'abc' } });
  await t.open(1, 3);
  for (let s = 0; s < 10; s++) {
    t.type('x');
    t.clock.advance(1000);
    if (t.of('docxEdit').length > s) { await t.answerEdit(s + 1); }
  }
  assert.ok(t.of('docxEdit').length >= 9, 'commits while typing one key a second: ' + t.of('docxEdit').length);
  const n = t.of('docxEdit').length;
  t.type('w');
  const ev = t.key('w', { ctrlKey: true }, t.island());
  assert.strictEqual(ev.defaultPrevented, false, 'Ctrl+W still reaches VS Code');
  assert.strictEqual(t.of('docxEdit').length, n + 1);
  await t.answerEdit(50);
  const btn = t.doc.createElement('button');
  t.toolbar.appendChild(btn);
  t.type('s');
  assert.strictEqual(t.key('s', { ctrlKey: true }, btn).defaultPrevented, false);
  assert.strictEqual(t.of('docxEdit').length, n + 2, 'Ctrl+S with the focus on a toolbar button');
  await t.answerEdit(51);
  t.type('b');
  for (const l of (t.win.listeners.blur || [])) { l.f({ type: 'blur' }); }
  assert.strictEqual(t.of('docxEdit').length, n + 3, 'window blur');
  assert.ok(t.island(), 'the island stays open');
});

test('review S3: keyboard only: blocks are focusable (roving tabindex), Enter/F2 open at the end, arrows move, Escape returns to the block', async () => {
  const t = await ready([P(1), P(2, { editable: false, lockReason: 'tracked-changes' }), P(3)], { texts: { 1: 'abc', 3: 'xyz' } });
  assert.strictEqual(t.p(1).getAttribute('tabindex'), '0', 'the first editable block is the tab stop');
  assert.strictEqual(t.p(2).getAttribute('tabindex'), '-1');
  assert.strictEqual(t.p(3).getAttribute('tabindex'), '-1');
  // Enter on the document itself opens the current block.
  assert.ok(t.key('Enter', {}, t.content).defaultPrevented);
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 1);
  await t.answerModel(0);
  assert.strictEqual(t.island(), t.p(1));
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 3, 'caret at the end');
  // Escape: closed, focus on the block.
  t.key('Escape');
  assert.strictEqual(t.island(), null);
  assert.strictEqual(t.doc.activeElement, t.p(1));
  // ArrowDown moves between blocks, locked ones included; Enter on a locked one says why.
  t.key('ArrowDown');
  assert.strictEqual(t.doc.activeElement, t.p(2));
  assert.strictEqual(t.p(2).getAttribute('tabindex'), '0', 'the focused block becomes the tab stop');
  assert.strictEqual(t.p(1).getAttribute('tabindex'), '-1');
  t.key('Enter');
  assert.match(t.hintText(), /tracked changes/);
  assert.strictEqual(t.of('docxRequestBlockModel').length, 1);
  t.key('ArrowDown');
  t.key('F2');
  assert.strictEqual(t.last('docxRequestBlockModel').blockId, 3);
  await t.answerModel(0);
  assert.strictEqual(t.island(), t.p(3));
  // View mode: no tab stops on blocks.
  t.key('Escape');
  t.send({ type: 'editModeChanged', editMode: false });
  assert.strictEqual(t.p(1).getAttribute('tabindex'), null);
});

test('review S3: Shift+F10 on a focused locked block opens its menu with "Insert paragraph after"', async () => {
  const t = await ready([P(1), P(2, { editable: false, lockReason: 'unknown-content' })]);
  t.p(2).focus();
  assert.ok(t.key('F10', { shiftKey: true }).defaultPrevented);
  const m = all(t.doc.body, (e) => e.nodeType === 1 && e.className === 'docx-menu')[0];
  assert.ok(m);
  assert.ok(m.textContent.includes('Insert paragraph after'));
  fire(t.doc.activeElement, 'keydown', { key: 'Escape' });
  assert.strictEqual(t.doc.activeElement, t.p(2), 'focus back on the block');
});

test('review N4: a block operation is not sent when the commit before it was refused', async () => {
  const t = await ready(BODY, { texts: { 2: 'Title' } });
  await t.open(2, 3);
  t.type('!');
  const done = t.edit.applyOp({ op: 'setStyle', blockIds: [2], style: { heading: 1 } });
  assert.strictEqual(t.last('docxEdit').edit.op, 'commitParagraph');
  await t.failEdit({ code: 'blocked', message: 'No.' });
  const r = await done;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(t.of('docxEdit').length, 1, 'setStyle never posted');
  assert.strictEqual(t.island(), t.p(2), 'the paragraph is open again with its text');
  assert.strictEqual(t.island().textContent, 'Tit!le');
  assert.ok(!t.edit.state().busy);
});

test('review N7: an abandoned split leaves nothing busy; a render that never comes does not keep the focus request forever', async () => {
  const t = await ready(BODY, { texts: { 2: 'Hello world' } });
  await t.open(2, 6);
  t.type('!');
  t.clock.advance(1000);                       // commit in flight
  t.key('Enter');                              // split queued behind it
  assert.strictEqual(t.edit.state().pendingOp, 'split');
  await t.failEdit({ code: 'stale', message: 'The document changed. Your edit was not applied.' });
  assert.strictEqual(t.last('docxEdit').edit.op, 'splitParagraph', 'the split went out before the stale reply was handled');
  await t.failEdit({ code: 'stale', message: 'The document changed. Your edit was not applied.' });   // its reply: abandoned
  assert.strictEqual(t.edit.state().pendingOp, null, 'the abandoned split is not pending any more');
  await t.answerModel(3, [T(200, 'Hello! world')]);   // the stale path reopens the island
  assert.ok(t.island());
  assert.ok(!t.edit.state().busy);
  // insertParagraphAfter focuses the new block after a render; that render never arrives.
  t.edit.applyOp({ op: 'insertParagraphAfter', blockId: 1 });
  t.blocks = [P(1), P(60), P(2), P(3)];
  await t.answerEdit(6, { blocks: t.blocks, changedBlockIds: [60], focus: { blockId: 60, at: 'start' } });
  assert.strictEqual(t.last('docxEdit').edit.op, 'insertParagraphAfter');
  assert.ok(t.edit.state().busy, 'waiting for the render');
  t.clock.advance(5000);
  assert.ok(!t.edit.state().busy, 'the watchdog gave up');
});

test('review N3: a click after a link places the caret counting the link as one chip', async () => {
  const t = await ready(BODY, { texts: { 1: 'ab' } });
  // The rendered paragraph: "ab" + <a>link</a> + "cd"; click between c and d.
  const p = t.p(1);
  const a = t.doc.createElement('a'); a.setAttribute('href', 'https://x'); a.appendChild(t.doc.createTextNode('link'));
  const tail = t.doc.createTextNode('cd');
  p.insertBefore(a, p.lastChild); p.insertBefore(tail, p.lastChild);
  t.doc.selection = { startContainer: tail, startOffset: 1, endContainer: tail, endOffset: 1 };
  fire(tail, 'click', {});
  await tick();
  await t.answerModel(0, [T(100, 'ab'), { kind: 'atom', id: 101, atomType: 'hyperlink', label: 'link' }, T(102, 'cd')]);
  assert.strictEqual(t.I.offsetOf(t.island(), t.doc.selection), 4, 'a, b, chip, c');
});
