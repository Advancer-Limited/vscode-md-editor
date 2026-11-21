// WP-32: the Word paragraph island (media/docxIsland.js), segment list <-> contenteditable DOM.
// Runs the UMD module in node:vm against a small DOM shim with text nodes, attributes, cloneNode and a
// recording Selection. Real caret behaviour (Chrome moving a caret out of an empty span, IME, the native
// paste event) needs the Extension Development Host (Gate R3 checklist).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../../media/docxIsland.js'), 'utf8');
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

// ------------------------------------------------------------------------------------- DOM shim

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) { return null; } return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) { return null; } return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
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
  contains(n) { for (let p = n; p; p = p.parentNode) { if (p === this) { return true; } } return false; }
}

class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.data = String(data); }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  cloneNode() { return new FakeText(this.ownerDocument, this.data); }
}

class FakeEl extends FakeNode {
  constructor(doc, tag) { super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.attrs = new Map(); this.style = {}; this.className = ''; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '') { this.appendChild(new FakeText(this.ownerDocument, v)); } }
  set innerHTML(_v) { throw new Error('innerHTML must not be used'); }
  get innerHTML() { throw new Error('innerHTML must not be used'); }
  set outerHTML(_v) { throw new Error('outerHTML must not be used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must not be used'); }
  cloneNode(deep) {
    const c = new FakeEl(this.ownerDocument, this.tagName);
    this.attrs.forEach((v, k) => c.attrs.set(k, v));
    c.style = Object.assign({}, this.style); c.className = this.className;
    if (deep) { this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true))); }
    return c;
  }
}

function makeDoc(computed) {
  const doc = {
    selection: null,
    createElement: (t) => new FakeEl(doc, t),
    createTextNode: (t) => new FakeText(doc, t),
    createRange() {
      const r = { setStart(c, o) { r.startContainer = c; r.startOffset = o; }, setEnd(c, o) { r.endContainer = c; r.endOffset = o; } };
      return r;
    },
    getSelection() {
      return { removeAllRanges() { doc.selection = null; }, addRange(r) { doc.selection = r; } };
    },
    defaultView: { getComputedStyle: () => Object.assign({ fontWeight: '400', fontStyle: 'normal', textDecorationLine: 'none' }, computed) },
  };
  return doc;
}

function load() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.DocxIsland;
}
const I = load();

/** Fresh <p> with an island for `segs`. */
function island(segs, computed, opts) {
  const doc = makeDoc(computed);
  const p = doc.createElement('p');
  p.setAttribute('data-block', '1');
  // docx-preview content that build() replaces
  const old = doc.createElement('span'); old.appendChild(doc.createTextNode('rendered')); p.appendChild(old);
  I.build(doc, segs, p, opts);
  return { doc, p };
}

const T = (id, text, f = {}, css = {}) => ({ kind: 'text', id, text, b: !!f.b, i: !!f.i, u: !!f.u, css });
const A = (id, atomType = 'image', label = 'Image') => ({ kind: 'atom', id, atomType, label });
const N = (id) => ({ kind: 'anchor', id });
const it = (text, src, f = {}) => ({ kind: 'text', text, b: !!f.b, i: !!f.i, u: !!f.u, src });
const atom = (id) => ({ kind: 'atom', id });
const anchor = (id) => ({ kind: 'anchor', id });
const R = (sc, so, ec = sc, eo = so) => ({ startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo, collapsed: sc === ec && so === eo });

const segSpan = (p, id) => find(p, (n) => n.nodeType === 1 && n.getAttribute('data-seg') === String(id))[0];
const chip = (p, id) => find(p, (n) => n.nodeType === 1 && n.getAttribute('data-atom') === String(id))[0];
const anchorEl = (p, id) => find(p, (n) => n.nodeType === 1 && n.getAttribute('data-anchor') === String(id))[0];
const textIn = (el) => find(el, (n) => n.nodeType === 3)[0];
function find(n, pred, out = []) { n.childNodes.forEach((c) => { if (pred(c)) { out.push(c); } find(c, pred, out); }); return out; }
function shape(n) {
  if (n.nodeType === 3) { return JSON.stringify(n.data); }
  const a = [...n.attrs.entries()].filter(([k]) => k.startsWith('data-')).map(([k, v]) => `${k}=${v}`).join(' ');
  return `<${n.tagName.toLowerCase()}${a ? ' ' + a : ''}>${n.childNodes.map(shape).join('')}`;
}

// Segment lists mirroring what WP-25 classifies in the fixture documents (basic, multi-run, fields,
// anchors, tables). When WP-25's snapshot file lands, add its lists here.
const SNAPSHOTS = {
  plain: [T(1, 'Hello world')],
  'two runs': [T(1, 'Hello '), T(2, 'world', { b: true })],
  'multi-run: tab, soft break, hyphens, nbsp': [T(1, 'a\tb\nc'), T(2, 'non‑breaking soft­hyphen', { i: true, u: true }), T(3, 'x y')],
  'fields and image atoms': [T(1, 'See '), A(2, 'field', 'Page 3'), T(3, ' and '), A(4, 'image', 'Image'), T(5, '.')],
  'anchors around text': [N(10), T(1, 'marked'), N(11), T(2, ' text'), N(12)],
  'comment anchors and atom': [T(1, 'a'), N(20), A(21, 'hyperlink', 'https://example.com'), N(22), T(2, 'b')],
  empty: [],
  'only anchors': [N(1), N(2)],
  'trailing newline': [T(1, 'abc\n')],
  'just a newline': [T(1, '\n')],
  'two trailing newlines': [T(1, 'ab\n\n')],
  'leading newline': [T(1, '\nab')],
  'trailing newline then anchor': [T(1, 'ab\n'), N(9)],
  'newline split across runs': [T(1, 'ab\n'), T(2, 'cd', { b: true })],
  'empty text segment alone': [T(5, '')],
  'empty text segment between': [T(1, 'a'), T(2, ''), T(3, 'b')],
  'adjacent atoms': [A(1, 'break', 'Page break'), A(2, 'footnote', '1')],
  'atom at end': [T(1, 'x'), A(2, 'math', 'Equation')],
  'atom at start': [A(2, 'object', ''), T(1, 'x')],
  'same flags different runs': [T(1, 'a'), T(2, 'b'), T(3, 'c')],
  'cell paragraph': [T(7, 'Cell '), T(8, 'text', { u: true })],
};

// ------------------------------------------------------------------------------------- build / read

for (const [name, segs] of Object.entries(SNAPSHOTS)) {
  test(`build then read is the identity: ${name}`, () => {
    const { p } = island(segs);
    deq(I.read(p), I.itemsFromSegments(segs));
    assert.strictEqual(I.isDirty(p), false);
  });
}

test('build replaces docx-preview content and emits seg spans, chips and anchors', () => {
  const { p } = island(SNAPSHOTS['comment anchors and atom']);
  assert.strictEqual(shape(p),
    '<p data-block=1><span data-seg=1 data-b=0 data-i=0 data-u=0>"a"<span data-anchor=20>' +
    '<span data-atom=21 data-atom-type=hyperlink>"https://example.com"<span data-anchor=22>' +
    '<span data-seg=2 data-b=0 data-i=0 data-u=0>"b"');
  const c = chip(p, 21);
  assert.strictEqual(c.getAttribute('contenteditable'), 'false');
  assert.strictEqual(c.getAttribute('aria-label'), 'https://example.com');
  assert.match(c.className, /docx-chip docx-chip-hyperlink/);
  assert.strictEqual(anchorEl(p, 20).getAttribute('contenteditable'), 'false');
  assert.strictEqual(anchorEl(p, 20).childNodes.length, 0);
});

test('build: \\n becomes <br>, a trailing \\n gets one placeholder <br>, an empty island gets one', () => {
  assert.strictEqual(shape(island([T(1, 'a\nb')]).p), '<p data-block=1><span data-seg=1 data-b=0 data-i=0 data-u=0>"a"<br>"b"');
  assert.strictEqual(shape(island([T(1, 'a\n')]).p), '<p data-block=1><span data-seg=1 data-b=0 data-i=0 data-u=0>"a"<br><br>');
  assert.strictEqual(shape(island([]).p), '<p data-block=1><br>');
  assert.strictEqual(shape(island([T(4, '')]).p), '<p data-block=1><span data-seg=4 data-b=0 data-i=0 data-u=0><br>');
});

test('build applies b/i/u and run css; unsafe css values are refused', () => {
  const { p } = island([
    T(1, 'x', { b: true, u: true }, { color: 'FF0000', fontSizePt: 14, fontFamily: 'Calibri";}body{x', highlight: 'darkYellow', strike: true, vertAlign: 'super', styleClass: 'docx_Emphasis' }),
    T(2, 'y', {}, { color: 'red;background:url(x)', fontSizePt: Infinity, highlight: 'none', vertAlign: 'baseline', styleClass: 'a b"' }),
  ]);
  const s1 = segSpan(p, 1).style;
  assert.strictEqual(s1.fontWeight, '', 'the run sets no toggles itself (no css.own)');
  assert.strictEqual(s1.fontStyle, '', 'the run does not set italic: left to the cascade (S5)');
  assert.strictEqual(s1.textDecoration, 'underline line-through');
  assert.strictEqual(s1.color, '#FF0000');
  assert.strictEqual(s1.fontSize, '14pt');
  assert.strictEqual(s1.fontFamily, '"Calibribodyx"');
  assert.strictEqual(s1.backgroundColor, '#808000');
  assert.strictEqual(s1.verticalAlign, 'super');
  assert.strictEqual(segSpan(p, 1).className, '', 'the raw w:rStyle id is not used as a class (N1)');
  const s2 = segSpan(p, 2).style;
  assert.strictEqual(s2.color, undefined);
  assert.strictEqual(s2.fontSize, undefined);
  assert.strictEqual(s2.backgroundColor, undefined);
  assert.strictEqual(s2.verticalAlign, undefined);
  assert.strictEqual(segSpan(p, 2).className, '');
  assert.strictEqual(s2.textDecoration, '');
});

test('review S5: only the toggles the run sets itself are written inline; the rest is left to the cascade', () => {
  // A header-row paragraph bold by its table style: the run sets nothing, so nothing is overridden.
  const { p } = island([T(1, 'Head'), T(2, 'er', { b: true }, { own: ['b'] }), T(3, '!', { i: true }, { own: ['i', 'x'] }), T(4, 'x', {}, { own: ['b'] })], { fontWeight: '700' });
  assert.strictEqual(segSpan(p, 1).style.fontWeight, '', 'not overridden: the cascade (the table style) applies');
  assert.strictEqual(segSpan(p, 1).style.fontStyle, '');
  assert.strictEqual(segSpan(p, 1).style.textDecoration, '');
  assert.strictEqual(segSpan(p, 2).style.fontWeight, 'bold', 'direct bold');
  assert.strictEqual(segSpan(p, 3).style.fontStyle, 'italic');
  assert.strictEqual(segSpan(p, 3).getAttribute('data-own'), 'i', 'unknown names are dropped');
  assert.strictEqual(segSpan(p, 4).style.fontWeight, 'normal', 'direct "not bold" (w:b w:val="0") still wins');
  // Toggling writes the toggled property inline, both ways.
  const t = island([T(1, 'word')]);
  const r = I.toggle(t.p, R(textIn(segSpan(t.p, 1)), 0, textIn(segSpan(t.p, 1)), 4), 'i');
  const span = find(t.p, (n) => n.nodeType === 1 && n.getAttribute('data-i') === '1')[0];
  assert.strictEqual(span.style.fontStyle, 'italic');
  assert.strictEqual(span.style.fontWeight, '', 'the other toggles stay with the cascade');
  I.toggle(t.p, r, 'i');
  const off = find(t.p, (n) => n.nodeType === 1 && n.getAttribute('data-seg') !== null)[0];
  assert.strictEqual(off.getAttribute('data-i'), '0');
  assert.strictEqual(off.style.fontStyle, 'normal');
});

test('read never changes the DOM', () => {
  const { p } = island(SNAPSHOTS['fields and image atoms']);
  p.appendChild(p.ownerDocument.createTextNode('typed'));
  const before = shape(p);
  I.read(p); I.splitAt(p, R(p, 0)); I.caretAtEnd(p, R(p, 0)); I.offsetOf(p, R(p, 0)); I.formatAt(p, R(p, 0));
  assert.strictEqual(shape(p), before);
});

// ------------------------------------------------------------------------------------- typed text src

test('text typed inside a span keeps that span\'s src and look', () => {
  const { p } = island(SNAPSHOTS['two runs']);
  textIn(segSpan(p, 2)).data = 'wor-ld';
  deq(I.read(p), [it('Hello ', 1), it('wor-ld', 2, { b: true })]);
  assert.strictEqual(I.isDirty(p), true);
});

test('text typed before the first span takes the following span\'s src', () => {
  const { p, doc } = island(SNAPSHOTS['two runs']);
  p.insertBefore(doc.createTextNode('Oh, '), p.firstChild);
  deq(I.read(p), [it('Oh, Hello ', 1), it('world', 2, { b: true })]);
});

test('text typed after the last span takes the preceding span\'s src', () => {
  const { p, doc } = island(SNAPSHOTS['two runs']);
  p.appendChild(doc.createTextNode('!'));
  deq(I.read(p), [it('Hello ', 1), it('world!', 2, { b: true })]);
});

test('text typed between two chips takes the nearest preceding text span', () => {
  const { p, doc } = island([T(1, 'a'), A(2), A(3), T(4, 'b', { i: true })]);
  p.insertBefore(doc.createTextNode('mid'), chip(p, 3));
  deq(I.read(p), [it('a', 1), atom(2), it('mid', 1), atom(3), it('b', 4, { i: true })]);
});

test('text typed between two chips with no span before them takes the following span', () => {
  const { p, doc } = island([A(2), A(3), T(4, 'b', { i: true })]);
  p.insertBefore(doc.createTextNode('mid'), chip(p, 3));
  deq(I.read(p), [atom(2), it('mid', 4, { i: true }), atom(3), it('b', 4, { i: true })]);
});

test('text typed in an empty paragraph has src null and the paragraph\'s look', () => {
  const plain = island([]);
  plain.p.insertBefore(plain.doc.createTextNode('New'), plain.p.firstChild);
  deq(I.read(plain.p), [it('New', null)]);
  const heading = island([], { fontWeight: '700' });
  heading.p.insertBefore(heading.doc.createTextNode('Title'), heading.p.firstChild);
  deq(I.read(heading.p), [it('Title', null, { b: true })]);
  const forced = island([], { fontWeight: '700' }, { base: { i: true } });
  forced.p.insertBefore(forced.doc.createTextNode('x'), forced.p.firstChild);
  deq(I.read(forced.p), [it('x', null, { i: true })]);
});

test('text typed into an originally empty segment uses its src', () => {
  const { p, doc } = island(SNAPSHOTS['empty text segment alone']);
  segSpan(p, 5).insertBefore(doc.createTextNode('filled'), segSpan(p, 5).firstChild);
  deq(I.read(p), [it('filled', 5)]);
});

test('a span emptied by the user disappears from the commit (no empty item)', () => {
  const { p } = island(SNAPSHOTS['two runs']);
  textIn(segSpan(p, 2)).data = '';
  deq(I.read(p), [it('Hello ', 1)]);
});

// ------------------------------------------------------------------------------------- browser normalisation

test('browser <b>/<i>/<font>/<span style> wrappers are transparent: formatting comes from data-seg only', () => {
  const { p, doc } = island(SNAPSHOTS['two runs']);
  const s1 = segSpan(p, 1);
  const b = doc.createElement('b'); b.appendChild(doc.createTextNode('bold?'));
  s1.appendChild(b);
  const font = doc.createElement('font'); font.setAttribute('color', 'red');
  const i = doc.createElement('i'); i.appendChild(doc.createTextNode(' tail'));
  font.appendChild(i); p.appendChild(font);
  const st = doc.createElement('span'); st.style.fontWeight = '700'; st.appendChild(doc.createTextNode('!'));
  p.appendChild(st);
  deq(I.read(p), [it('Hello bold?', 1), it('world tail!', 2, { b: true })]);
});

test('<div> blocks become line breaks; Chrome\'s <div><br></div> is an empty line', () => {
  const { p, doc } = island([T(1, 'one')]);
  const d1 = doc.createElement('div'); const s = segSpan(p, 1).cloneNode(false); s.appendChild(doc.createTextNode('two')); d1.appendChild(s);
  const d2 = doc.createElement('div'); d2.appendChild(doc.createElement('br'));
  p.appendChild(d1); p.appendChild(d2);
  deq(I.read(p), [it('one\ntwo\n', 1)]);
  // content after a block starts a new line too
  p.appendChild(doc.createTextNode('three'));
  deq(I.read(p), [it('one\ntwo\n\nthree', 1)]);
});

test('<div> wrapping everything (Chrome after select-all) adds no leading break', () => {
  const { p, doc } = island([T(1, 'x')]);
  const d = doc.createElement('div');
  while (p.firstChild) { d.appendChild(p.firstChild); }
  p.appendChild(d);
  deq(I.read(p), [it('x', 1)]);
});

test('a stray trailing <br> is dropped, inner <br>s are line breaks, \\r\\n is normalised', () => {
  const { p, doc } = island([T(1, 'ab')]);
  segSpan(p, 1).appendChild(doc.createElement('br'));
  deq(I.read(p), [it('ab', 1)]);
  segSpan(p, 1).appendChild(doc.createTextNode('c\r\nd\re'));
  deq(I.read(p), [it('ab\nc\nd\ne', 1)]);
  // a <br> before a trailing anchor is still the placeholder
  const q = island([T(1, 'ab'), N(3)]);
  segSpan(q.p, 1).appendChild(q.doc.createElement('br'));
  deq(I.read(q.p), [it('ab', 1), anchor(3)]);
});

test('nbsp: browser-inserted U+00A0 becomes a space; a run that had U+00A0 keeps it', () => {
  const { p, doc } = island([T(1, 'a b'), T(2, 'x y')]);
  textIn(segSpan(p, 1)).data = 'a  b';
  textIn(segSpan(p, 2)).data = 'x y z';
  p.appendChild(doc.createTextNode(' end'));
  // the orphan text resolves to run 2 and merges with it; its own nbsp becomes a space
  deq(I.read(p), [it('a  b', 1), it('x y z end', 2)]);
});

test('script/style/img content inside the island is ignored', () => {
  const { p, doc } = island([T(1, 'a')]);
  const sc = doc.createElement('script'); sc.appendChild(doc.createTextNode('alert(1)')); p.appendChild(sc);
  const img = doc.createElement('img'); p.appendChild(img);
  deq(I.read(p), [it('a', 1)]);
});

// ------------------------------------------------------------------------------------- chips and anchors

test('chips and anchors survive typing around them and keep their order', () => {
  const { p, doc } = island(SNAPSHOTS['anchors around text']);
  textIn(segSpan(p, 1)).data = 'MARKED';
  p.insertBefore(doc.createTextNode('pre '), anchorEl(p, 10));
  deq(I.read(p), [it('pre ', 1), anchor(10), it('MARKED', 1), anchor(11), it(' text', 2), anchor(12)]);
});

test('a deleted chip is simply absent (host re-inserts it)', () => {
  const { p } = island(SNAPSHOTS['fields and image atoms']);
  p.removeChild(chip(p, 4));
  deq(I.read(p), [it('See ', 1), atom(2), it(' and ', 3), it('.', 5)]);
});

test('chip label text is never read; a duplicated chip or anchor is emitted once; text typed into an anchor is kept', () => {
  const { p, doc } = island([T(1, 'a'), A(2, 'field', 'LABEL'), N(3), T(4, 'b')]);
  chip(p, 2).appendChild(doc.createTextNode('more label'));
  p.appendChild(chip(p, 2).cloneNode(true));
  p.appendChild(anchorEl(p, 3).cloneNode(true));
  anchorEl(p, 3).appendChild(doc.createTextNode('z'));
  deq(I.read(p), [it('a', 1), atom(2), anchor(3), it('z', 1), it('b', 4)]);
});

test('a chip moved by the browser keeps its new position', () => {
  const { p } = island([T(1, 'a'), A(2), T(3, 'b')]);
  p.appendChild(chip(p, 2));
  deq(I.read(p), [it('a', 1), it('b', 3), atom(2)]);
});

// ------------------------------------------------------------------------------------- toggle

test('toggle on a partial selection yields three items and returns the new range', () => {
  const { p, doc } = island([T(1, 'Hello world')]);
  const t = textIn(segSpan(p, 1));
  const r = I.toggle(p, R(t, 2, t, 5), 'b');
  deq(I.read(p), [it('He', 1), it('llo', 1, { b: true }), it(' world', 1)]);
  assert.strictEqual(r.startContainer.data, 'llo');
  assert.strictEqual(r.startOffset, 0);
  assert.strictEqual(r.endContainer.data, 'llo');
  assert.strictEqual(r.endOffset, 3);
  assert.strictEqual(doc.selection.startContainer, r.startContainer);
  const bold = r.startContainer.parentNode;
  assert.strictEqual(bold.getAttribute('data-seg'), '1');
  assert.strictEqual(bold.getAttribute('data-b'), '1');
  assert.strictEqual(bold.style.fontWeight, 'bold');
  // toggling the same range again turns it off and the items merge back
  I.toggle(p, r, 'b');
  deq(I.read(p), [it('Hello world', 1)]);
});

test('toggle over mixed formatting turns on everywhere; over all-on turns off; keeps chips and anchors', () => {
  const { p } = island([T(1, 'ab', { b: true }), A(5), N(6), T(2, 'cd')]);
  const t1 = textIn(segSpan(p, 1)); const t2 = textIn(segSpan(p, 2));
  const r = I.toggle(p, R(t1, 1, t2, 1), 'b');
  deq(I.read(p), [it('ab', 1, { b: true }), atom(5), anchor(6), it('c', 2, { b: true }), it('d', 2)]);
  I.toggle(p, r, 'b');
  deq(I.read(p), [it('a', 1, { b: true }), it('b', 1), atom(5), anchor(6), it('cd', 2)]);
  I.toggle(p, R(p, 0, p, p.childNodes.length), 'u');
  deq(I.read(p), [it('a', 1, { b: true, u: true }), it('b', 1, { u: true }), atom(5), anchor(6), it('cd', 2, { u: true })]);
});

test('toggle italic on text typed outside any span wraps it with the resolved src', () => {
  const { p, doc } = island([T(1, 'a')]);
  const typed = doc.createTextNode('xyz'); p.appendChild(typed);
  I.toggle(p, R(typed, 0, typed, 3), 'i');
  deq(I.read(p), [it('a', 1), it('xyz', 1, { i: true })]);
});

test('toggle with a collapsed caret inside a word toggles the word', () => {
  const { p } = island([T(1, 'one two three')]);
  const t = textIn(segSpan(p, 1));
  I.toggle(p, R(t, 5), 'i');
  deq(I.read(p), [it('one ', 1), it('two', 1, { i: true }), it(' three', 1)]);
});

test('toggle with a collapsed caret between words inserts an empty span for the next typed text', () => {
  const { p } = island([T(1, 'one two', { b: true })]);
  const t = textIn(segSpan(p, 1));
  const r = I.toggle(p, R(t, 4), 'b');
  assert.strictEqual(r.collapsed, true);
  assert.strictEqual(r.startContainer.data, '');
  deq(I.read(p), [it('one two', 1, { b: true })]);   // the empty span is not content
  r.startContainer.data = 'new ';
  deq(I.read(p), [it('one ', 1, { b: true }), it('new ', 1), it('two', 1, { b: true })]);
});

test('toggle with a collapsed caret in an empty paragraph', () => {
  const { p } = island([]);
  const r = I.toggle(p, R(p, 0), 'u');
  r.startContainer.data = 'u';
  deq(I.read(p), [it('u', null, { u: true })]);
});

test('formatAt reports the look before the caret and all-on for selections', () => {
  const { p } = island([T(1, 'ab', { b: true }), T(2, 'cd', { i: true })]);
  const t1 = textIn(segSpan(p, 1)); const t2 = textIn(segSpan(p, 2));
  deq(I.formatAt(p, R(t1, 1)), { b: true, i: false, u: false });
  deq(I.formatAt(p, R(t2, 1)), { b: false, i: true, u: false });
  deq(I.formatAt(p, R(t1, 0, t2, 2)), { b: false, i: false, u: false });
  deq(I.formatAt(p, R(t1, 0, t1, 2)), { b: true, i: false, u: false });
});

// ------------------------------------------------------------------------------------- splitAt

test('splitAt keeps atoms on the correct side', () => {
  const { p } = island([T(1, 'ab'), A(7), T(2, 'cd'), A(8), T(3, 'ef')]);
  const t2 = textIn(segSpan(p, 2));
  deq(I.splitAt(p, R(t2, 1)), { before: [it('ab', 1), atom(7), it('c', 2)], after: [it('d', 2), atom(8), it('ef', 3)] });
  // caret right before chip 8 (element boundary)
  const idx = p.childNodes.indexOf(chip(p, 8));
  deq(I.splitAt(p, R(p, idx)), { before: [it('ab', 1), atom(7), it('cd', 2)], after: [atom(8), it('ef', 3)] });
  // caret right after chip 7
  deq(I.splitAt(p, R(p, p.childNodes.indexOf(chip(p, 7)) + 1)), { before: [it('ab', 1), atom(7)], after: [it('cd', 2), atom(8), it('ef', 3)] });
});

test('splitAt at the ends and with a selection (selected chips dropped, anchors kept)', () => {
  const { p } = island([T(1, 'ab'), A(7), N(9), T(2, 'cd')]);
  const t1 = textIn(segSpan(p, 1)); const t2 = textIn(segSpan(p, 2));
  deq(I.splitAt(p, R(t1, 0)), { before: [], after: [it('ab', 1), atom(7), anchor(9), it('cd', 2)] });
  deq(I.splitAt(p, R(t2, 2)), { before: [it('ab', 1), atom(7), anchor(9), it('cd', 2)], after: [] });
  deq(I.splitAt(p, R(t1, 1, t2, 1)), { before: [it('a', 1), anchor(9)], after: [it('d', 2)] });
});

test('splitAt after a soft break at the end keeps the break in the first half', () => {
  const { p } = island([T(1, 'a\n')]);
  const span = segSpan(p, 1);   // "a", <br>, <br placeholder>
  deq(I.splitAt(p, R(span, 2)), { before: [it('a\n', 1)], after: [] });
});

// ------------------------------------------------------------------------------------- caret helpers

test('caretAtStart / caretAtEnd ignore anchors and the placeholder; false for selections', () => {
  const { p } = island([N(1), T(2, 'ab\n'), N(3)]);
  const t = textIn(segSpan(p, 2));
  assert.strictEqual(I.caretAtStart(p, R(p, 0)), true);
  assert.strictEqual(I.caretAtStart(p, R(t, 0)), true);
  assert.strictEqual(I.caretAtStart(p, R(t, 1)), false);
  assert.strictEqual(I.caretAtEnd(p, R(t, 2)), false);                      // the \n follows
  assert.strictEqual(I.caretAtEnd(p, R(segSpan(p, 2), 2)), true);          // after the real <br>
  assert.strictEqual(I.caretAtEnd(p, R(p, p.childNodes.length)), true);
  assert.strictEqual(I.caretAtStart(p, R(t, 0, t, 1)), false);
  const e = island([]);
  assert.strictEqual(I.caretAtStart(e.p, R(e.p, 0)), true);
  assert.strictEqual(I.caretAtEnd(e.p, R(e.p, 0)), true);
});

test('setCaret start / end / offset, and offsetOf round-trips (anchors count 0, chips 1)', () => {
  const { p, doc } = island([N(9), T(1, 'ab'), A(2), T(3, 'c\nd'), N(10)]);
  let r = I.setCaret(p, 'start');
  assert.strictEqual(r.startContainer, textIn(segSpan(p, 1)));
  assert.strictEqual(r.startOffset, 0);
  assert.strictEqual(doc.selection.startContainer, r.startContainer);
  r = I.setCaret(p, 'end');
  assert.strictEqual(r.startContainer.data, 'd');
  assert.strictEqual(r.startOffset, 1);
  for (let n = 0; n <= 6; n++) { assert.strictEqual(I.offsetOf(p, I.setCaret(p, n)), n, 'offset ' + n); }
  r = I.setCaret(p, 3);           // after the chip
  assert.strictEqual(r.startContainer.data, 'c');
  assert.strictEqual(r.startOffset, 0);
  assert.strictEqual(I.offsetOf(p, I.setCaret(p, 99)), 6);
  const e = island([]);
  r = I.setCaret(e.p, 'start');
  assert.strictEqual(r.startContainer, e.p);
  assert.strictEqual(r.startOffset, 0);
});

// ------------------------------------------------------------------------------------- paste

test('pasted HTML is reduced to text: only text/plain is read, inserted as text and <br>', () => {
  const asked = [];
  const cd = { getData: (t) => { asked.push(t); return t === 'text/html' ? '<b onclick="x()">evil</b>' : 'Line1\r\nLine2\u0007'; } };
  const text = I.plainText(cd);
  assert.strictEqual(text, 'Line1\nLine2');
  deq(asked, ['text/plain']);
  const { p } = island([T(1, 'Hello', { i: true }), T(2, '!')]);
  const t = textIn(segSpan(p, 1));
  const r = I.insertText(p, R(t, 3), text);
  deq(I.read(p), [it('HelLine1\nLine2lo', 1, { i: true }), it('!', 2)]);
  assert.strictEqual(r.startContainer.data, 'Line2');
  assert.strictEqual(r.startOffset, 5);
  assert.strictEqual(find(p, (n) => n.nodeType === 1 && n.tagName === 'B').length, 0);
});

test('insertText replaces a selection (chips in it removed, anchors kept) and keeps a trailing break visible', () => {
  const { p } = island([T(1, 'abc'), A(5), N(6), T(2, 'def')]);
  const t1 = textIn(segSpan(p, 1)); const t2 = textIn(segSpan(p, 2));
  I.insertText(p, R(t1, 1, t2, 2), 'X');
  deq(I.read(p), [it('aX', 1), anchor(6), it('f', 2)]);
  const q = island([T(1, 'end')]);
  const r = I.insertText(q.p, R(textIn(segSpan(q.p, 1)), 3), 'x\n');
  deq(I.read(q.p), [it('endx\n', 1)]);
  assert.strictEqual(I.caretAtEnd(q.p, r), true);
  assert.strictEqual(I.plainText(null), '');
  assert.strictEqual(I.plainText({ getData() { throw new Error('denied'); } }), '');
});

// ------------------------------------------------------------------------------------- undo fallback

test('undo fallback (S3 pending): Ctrl+Z cancels the edit, Ctrl+Y / Ctrl+Shift+Z are blocked', () => {
  assert.strictEqual(I.UNDO_POLICY, 'cancel-edit');
  assert.strictEqual(I.undoKeyAction({ ctrlKey: true, key: 'z' }), 'cancel');
  assert.strictEqual(I.undoKeyAction({ metaKey: true, key: 'Z', shiftKey: false }), 'cancel');
  assert.strictEqual(I.undoKeyAction({ ctrlKey: true, key: 'y' }), 'block');
  assert.strictEqual(I.undoKeyAction({ ctrlKey: true, shiftKey: true, key: 'Z' }), 'block');
  assert.strictEqual(I.undoKeyAction({ key: 'z' }), null);
  assert.strictEqual(I.undoKeyAction({ ctrlKey: true, altKey: true, key: 'z' }), null);
  assert.strictEqual(I.undoKeyAction({ ctrlKey: true, key: 'b' }), null);
  const segs = SNAPSHOTS['fields and image atoms'];
  const { p, doc } = island(segs);
  textIn(segSpan(p, 1)).data = 'changed';
  p.removeChild(chip(p, 2));
  p.appendChild(doc.createTextNode('junk'));
  assert.strictEqual(I.isDirty(p), true);
  assert.strictEqual(I.cancel(p), true);
  deq(I.read(p), I.itemsFromSegments(segs));
  assert.strictEqual(I.isDirty(p), false);
  I.release(p);
  assert.strictEqual(I.cancel(p), false);
});

// ------------------------------------------------------------------------------------- misc

test('sameItems compares every field', () => {
  assert.strictEqual(I.sameItems([it('a', 1)], [it('a', 1)]), true);
  assert.strictEqual(I.sameItems([it('a', 1)], [it('a', 2)]), false);
  assert.strictEqual(I.sameItems([it('a', 1)], [it('a', 1, { u: true })]), false);
  assert.strictEqual(I.sameItems([atom(1)], [anchor(1)]), false);
  assert.strictEqual(I.sameItems([atom(1)], []), false);
});

test('no HTML-string DOM APIs in the module (plan §1.8)', () => {
  const code = SRC.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);
});
