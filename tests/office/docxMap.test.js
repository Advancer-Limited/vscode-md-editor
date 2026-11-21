// WP-27: rendered DOM -> block mapping (media/docxMap.js), spec §8.2.
//
// Two layers:
//  1. The real thing: the host's render copy (core renderCopy) rendered by the docx-preview build the
//     viewer ships (media/docx-preview.min.js + media/jszip.min.js) inside node:vm, against a small
//     DOM shim (HTML output side) and a saxes-backed DOMParser (docx-preview's XML input side).
//     docx-preview's page splitting works from explicit breaks, not layout, so the <p> structure is
//     the browser's; layout (sizes, the hidden-marker CSS) is not checked here (Gate R3).
//  2. Hand-built trees for shapes docx-preview does not produce from the fixtures (a table between
//     the halves of a split paragraph, markers in different cells, duplicates, overlaps).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { SaxesParser } = require('saxes');

const REPO = path.join(__dirname, '..', '..');
const DocxMap = require('../../media/docxMap.js');
const core = require('../.build/office-core.cjs');
const { OfficePackage } = core.pkg;
const { DocxModel, NS_W } = core.docx.model;
const { buildRenderCopy } = core.docx.renderCopy;

const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'office');
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ------------------------------------------------------------------------------- XML side (input)

function itemList(a) { a.item = (i) => a[i] ?? null; return a; }
class XNode { constructor() { this.childNodes = itemList([]); this.parentNode = null; } }
class XText extends XNode {
  constructor(t) { super(); this.nodeType = 3; this.nodeName = '#text'; this.data = t; }
  get textContent() { return this.data; }
}
class XElement extends XNode {
  constructor(tag) {
    super();
    this.nodeType = 1; this.nodeName = this.tagName = tag.name; this.localName = tag.local;
    this.namespaceURI = tag.uri || null; this.prefix = tag.prefix || null;
    this.attributes = itemList(Object.values(tag.attributes).map((a) => ({
      name: a.name, localName: a.local, prefix: a.prefix || null, namespaceURI: a.uri || null, value: a.value,
    })));
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.childNodes.find((c) => c.nodeType === 1) ?? null; }
  getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; }
  getElementsByTagName(n) {
    const out = [];
    const walk = (e) => { for (const c of e.childNodes) { if (c.nodeType === 1) { if (c.nodeName === n) { out.push(c); } walk(c); } } };
    walk(this);
    return out;
  }
}
class XDocument extends XElement { constructor() { super({ name: '#document', local: null, attributes: {} }); this.nodeType = 9; } }
class ShimDOMParser {
  parseFromString(text) {
    const doc = new XDocument();
    const p = new SaxesParser({ xmlns: true });
    const stack = [doc];
    p.on('opentag', (t) => { const el = new XElement(t); el.parentNode = stack.at(-1); stack.at(-1).childNodes.push(el); stack.push(el); });
    p.on('closetag', () => { stack.pop(); });
    const text_ = (t) => { const n = new XText(t); n.parentNode = stack.at(-1); stack.at(-1).childNodes.push(n); };
    p.on('text', text_);
    p.on('cdata', text_);
    p.write(text).close();
    return doc;
  }
}

// ------------------------------------------------------------------------------ HTML side (output)

class HNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  appendChild(c) {
    if (c.nodeType === 11) { for (const k of [...c.childNodes]) { this.appendChild(k); } return c; }
    if (c.parentNode) { c.parentNode.removeChild(c); }
    c.parentNode = this; this.childNodes.push(c); return c;
  }
  insertBefore(c, ref) {
    if (!ref) { return this.appendChild(c); }
    if (c.parentNode) { c.parentNode.removeChild(c); }
    c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
  }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) { c.parentNode = null; }
    this.childNodes = [];
    if (v) { this.appendChild(this.ownerDocument.createTextNode(v)); }
  }
}
HNode.ELEMENT_NODE = 1;
HNode.TEXT_NODE = 3;
class HText extends HNode {
  constructor(d, t) { super(d); this.nodeType = 3; this.nodeName = '#text'; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class HComment extends HNode {
  constructor(d, t) { super(d); this.nodeType = 8; this.nodeName = '#comment'; this.data = String(t); }
  get textContent() { return ''; }
}
class HFragment extends HNode { constructor(d) { super(d); this.nodeType = 11; this.nodeName = '#document-fragment'; } }
class HElement extends HNode {
  constructor(d, ns, tag) {
    super(d);
    this.nodeType = 1; this.namespaceURI = ns; this.localName = tag;
    this.nodeName = this.tagName = ns === HTML_NS ? tag.toUpperCase() : tag;
    this.attrs = new Map(); this.style = {};
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this;
    return {
      add(...cs) { const cur = el.className.split(/\s+/).filter(Boolean); for (const c of cs) { if (!cur.includes(c)) { cur.push(c); } } el.className = cur.join(' '); },
      contains(c) { return el.className.split(/\s+/).includes(c); },
    };
  }
  set innerHTML(v) { if (v !== '') { throw new Error('innerHTML with content'); } this.textContent = ''; }
  get firstElementChild() { return this.childNodes.find((c) => c.nodeType === 1) ?? null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
}
function makeDocument() {
  const doc = {
    createElement: (t) => new HElement(doc, HTML_NS, t),
    createElementNS: (ns, t) => new HElement(doc, ns, t),
    createTextNode: (t) => new HText(doc, t),
    createComment: (t) => new HComment(doc, t),
    createDocumentFragment: () => new HFragment(doc),
  };
  doc.body = doc.createElement('body');
  return doc;
}

/** media/jszip.min.js + media/docx-preview.min.js loaded into one vm context (reused by every render). */
let docxCtx = null;
function docxPreview() {
  if (docxCtx) { return docxCtx; }
  const ctx = {
    document: makeDocument(), DOMParser: ShimDOMParser, Node: HNode, console, setTimeout, clearTimeout,
    requestAnimationFrame: () => 0, Blob, URL, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, Promise,
  };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['jszip.min.js', 'docx-preview.min.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, 'media', f), 'utf8'), ctx, { filename: f });
  }
  docxCtx = ctx;
  return ctx;
}

// The viewer's options (media/docxEditor.js RENDER_OPTIONS).
const RENDER_OPTIONS = {
  breakPages: true, inWrapper: true, ignoreLastRenderedPageBreak: true, renderHeaders: true, renderFooters: true,
  renderFootnotes: true, renderEndnotes: true, renderChanges: false, renderComments: false, renderAltChunks: false,
  experimental: false, useBase64URL: false,
};

async function render(bytes) {
  const ctx = docxPreview();
  const host = ctx.document.createElement('div');
  const styles = ctx.document.createElement('div');
  await ctx.docx.renderAsync(bytes, host, styles, RENDER_OPTIONS);
  return host;
}

// ---------------------------------------------------------------------------------- helpers

const tag = (n) => String(n.nodeName).toUpperCase();
function all(root, pred) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { if (pred(c)) { out.push(c); } walk(c); } } };
  walk(root);
  return out;
}
function closest(n, root, pred) {
  for (let p = n; p && p !== root; p = p.parentNode) { if (p.nodeType === 1 && pred(p)) { return p; } }
  return null;
}
const nearestCell = (p, root) => closest(p.parentNode, root, (n) => tag(n) === 'TD' || tag(n) === 'TH');
const inArticle = (p, root) => !!closest(p, root, (n) => tag(n) === 'ARTICLE');
const visibleText = (el) => el.textContent;

/** Minimal DocxBlockInfo list from a model (WP-29's blockInfos() is not written yet). */
function infosOf(model, styles) {
  return model.blocks().map((b) => {
    const pStyle = b.kind === 'paragraph' ? core.docx.model.paragraphProps(b.el).pStyleId : null;
    const style = styles ? styles.styleInfo(pStyle) : { kind: 'normal', name: '' };
    return {
      id: b.id, kind: b.kind, parentId: b.container.tableBlockId, editable: b.lockReason === undefined,
      lockReason: b.lockReason, removable: false, style, list: { kind: 'none', level: 0 },
    };
  });
}

function openFixture(name, bytes) {
  const pkg = OfficePackage.open(name, bytes ?? new Uint8Array(fs.readFileSync(path.join(FIXTURES, name))));
  const model = DocxModel.load(pkg);
  return { pkg, model };
}

function editableFixtures() {
  const out = [];
  for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.docx')).sort()) {
    let pkg;
    try { pkg = OfficePackage.open(name, new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))); } catch { continue; }
    const model = DocxModel.load(pkg);
    if (!model.viewOnlyReason) { out.push({ name, pkg, model }); }
  }
  return out;
}

/** Every text piece (split at tab / line break) of an editable block's text segments. */
function textPieces(model, b) {
  const out = [];
  for (const s of model.segments(b)) {
    if (s.kind !== 'text') { continue; }
    for (const piece of s.text.split(/[\t\n­‑]/)) { if (piece.trim()) { out.push(piece); } }
  }
  return out;
}

// ------------------------------------------------------------------- 1. real docx-preview render

test('every editable docx fixture: render copy -> docx-preview -> mapBlocks finds every marked block', async () => {
  const list = editableFixtures();
  assert.ok(list.length >= 10, `fixtures: ${list.length}`);
  let total = 0, cellBlocks = 0, nestedBlocks = 0;
  for (const { name, pkg, model } of list) {
    const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
    const host = await render(bytes);
    const styles = core.docx.styles.DocxStyles.load(pkg, model.mainPart);
    const infos = infosOf(model, styles);
    const { byId, missing } = DocxMap.mapBlocks(host, infos);
    assert.deepStrictEqual(missing, [], `${name}: no missing pairs`);
    assert.deepStrictEqual([...byId.keys()], markedBlockIds, `${name}: every marked block mapped, document order`);
    const seen = new Set();
    for (const [id, ps] of byId) {
      total++;
      const b = model.block(id);
      assert.ok(ps.length >= 1, `${name}: block ${id} has a <p>`);
      for (const p of ps) {
        assert.ok(!seen.has(p), `${name}: <p> claimed once`);
        seen.add(p);
        assert.strictEqual(p.getAttribute('data-block'), String(id));
        assert.ok(inArticle(p, host), `${name}: block ${id} <p> is in the body content`);
        assert.strictEqual(DocxMap.blockOf(p), id);
        const cell = nearestCell(p, host);
        if (b.container.tableBlockId === null) {
          assert.strictEqual(cell, null, `${name}: body block ${id} not in a cell`);
        } else {
          assert.ok(cell, `${name}: cell block ${id} in a <td>`);
          // Cell depth in the DOM = container depth in the model (nested tables map to the inner cell).
          let depth = 0;
          for (let c = cell; c; c = nearestCell(c, host)) { depth++; }
          let mdepth = 0;
          for (let c = b.container; c && c.tableBlockId !== null; c = c.parent) { mdepth++; }
          assert.strictEqual(depth, mdepth, `${name}: block ${id} cell depth`);
          if (mdepth > 1) { nestedBlocks++; }
        }
      }
      if (b.container.tableBlockId !== null) { cellBlocks++; }
      // The <p> shows the block's own text.
      const shown = ps.map(visibleText).join('');
      for (const piece of textPieces(model, b)) {
        assert.ok(shown.includes(piece), `${name}: block ${id} shows ${JSON.stringify(piece)} (rendered ${JSON.stringify(shown.slice(0, 120))})`);
      }
      // Headings carry role/aria-level.
      const info = infos.find((x) => x.id === id);
      for (const p of ps) {
        if (info.style.kind === 'heading') {
          assert.strictEqual(p.getAttribute('role'), 'heading');
          assert.strictEqual(p.getAttribute('aria-level'), String(info.style.level));
        } else {
          assert.strictEqual(p.getAttribute('role'), null);
        }
      }
    }
    // Every marker span is inside a mapped <p>.
    const spans = all(host, (n) => tag(n) === 'SPAN' && String(n.getAttribute('id') || '').startsWith('__vsmd_'));
    assert.strictEqual(spans.length, markedBlockIds.length * 2, `${name}: one span per marker`);
  }
  assert.ok(total > 2000, `blocks mapped: ${total}`);
  assert.ok(cellBlocks > 150, `cell blocks mapped: ${cellBlocks}`);
  assert.ok(nestedBlocks > 0, `nested-table cell blocks mapped: ${nestedBlocks}`);
});

test('real render: headings found in basic.docx carry role="heading" and aria-level', async () => {
  const { pkg, model } = openFixture('basic.docx');
  const host = await render(buildRenderCopy(pkg, model).bytes);
  const styles = core.docx.styles.DocxStyles.load(pkg, model.mainPart);
  const { byId } = DocxMap.mapBlocks(host, infosOf(model, styles));
  const headings = [...byId.values()].flat().filter((p) => p.getAttribute('role') === 'heading');
  assert.ok(headings.length >= 2, `headings: ${headings.length}`);
  assert.ok(headings.some((p) => p.getAttribute('aria-level') === '1'));
  assert.ok(headings.some((p) => p.getAttribute('aria-level') === '2'));
});

/** rich.docx (it has headers and footers) with `bodyXml` as its body and its first section's sectPr. */
async function docWithBody(bodyXml) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, 'rich.docx')));
  const t = await zip.file('word/document.xml').async('string');
  const a = t.indexOf('<w:body>');
  const b = t.indexOf('</w:body>');
  // The first section's properties (they reference the default header and footer).
  const sect = /<w:sectPr(?:(?!<\/w:sectPr>)[\s\S])*?<w:headerReference[\s\S]*?<\/w:sectPr>/.exec(t)[0];
  zip.file('word/document.xml', t.slice(0, a + 8) + bodyXml + sect + t.slice(b));
  return openFixture('synthetic.docx', new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
}
const T = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const P = (inner) => `<w:p>${inner}</w:p>`;
const PAGE = '<w:br w:type="page"/>';
const TC = (inner, tcPr = '') => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${tcPr}</w:tcPr>${inner}</w:tc>`;
const TBL = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>`;

test('real render: a page-break-split body paragraph gets both <p>; the page footer and next header between them are not claimed', async () => {
  const { pkg, model } = await docWithBody([
    P(T('first')),
    P(`${T('split before')}<w:r>${PAGE}<w:t>split after</w:t></w:r>`),   // break mid-paragraph
    P(`${T('trailing')}<w:r>${PAGE}</w:r>`),                            // trailing break run (§8.2 rule)
    P(T('next page')),
    P(`<w:hyperlink w:anchor="x"><w:r><w:t>link</w:t></w:r><w:r>${PAGE}</w:r></w:hyperlink>${T('link tail')}`), // break inside a hyperlink: no split
    P(T('last')),
  ].join(''));
  const blocks = model.blocks().filter((b) => b.kind === 'paragraph');
  const host = await render(buildRenderCopy(pkg, model).bytes);
  // rich.docx has a header and a footer: they are rendered on every page, between the halves.
  const headerFooterPs = all(host, (n) => tag(n) === 'P' && !inArticle(n, host));
  assert.ok(headerFooterPs.length >= 2, `header/footer <p>s rendered: ${headerFooterPs.length}`);
  const { byId, missing } = DocxMap.mapBlocks(host, infosOf(model));
  assert.deepStrictEqual(missing, []);
  const texts = (id) => byId.get(id).map((p) => p.textContent);
  assert.deepStrictEqual(texts(blocks[0].id), ['first']);
  assert.deepStrictEqual(texts(blocks[1].id), ['split before', 'split after'], 'both halves, nothing between');
  assert.deepStrictEqual(texts(blocks[2].id), ['trailing'], 'trailing break: one <p>, no empty <p> claimed on the next page');
  assert.deepStrictEqual(texts(blocks[3].id), ['next page']);
  assert.strictEqual(byId.get(blocks[4].id).length, 1, 'no split at a break inside w:hyperlink');
  assert.deepStrictEqual(texts(blocks[5].id), ['last']);
  for (const p of headerFooterPs) { assert.strictEqual(p.getAttribute('data-block'), null, 'header/footer <p> not claimed'); }
  // The halves really are on different pages.
  const page = (p) => closest(p, host, (n) => tag(n) === 'SECTION');
  const [h1, h2] = byId.get(blocks[1].id);
  assert.notStrictEqual(page(h1), page(h2));
});

test('real render: cell paragraphs map within their td, nested-table paragraphs to the inner cell, merged cells unmapped', async () => {
  const inner = TBL(`<w:tr>${TC(P(T('inner a')))}${TC(P(T('inner b')))}</w:tr>`);
  const { pkg, model } = await docWithBody([
    P(T('before')),
    TBL([
      `<w:tr>${TC(P(T('restart')), '<w:vMerge w:val="restart"/>')}${TC(P(T('outer')) + inner + P(T('after inner')))}</w:tr>`,
      `<w:tr>${TC(P(T('continuation')), '<w:vMerge/>')}${TC(P(T('r1c1 one')) + P(T('r1c1 two')))}</w:tr>`,
    ].join('')),
    P(T('after')),
  ].join(''));
  const host = await render(buildRenderCopy(pkg, model).bytes);
  const infos = infosOf(model);
  const { byId, missing } = DocxMap.mapBlocks(host, infos);
  assert.deepStrictEqual(missing, []);
  const byText = new Map();
  for (const [id, ps] of byId) { byText.set(ps.map((p) => p.textContent).join('|'), { id, ps }); }
  assert.deepStrictEqual([...byText.keys()], ['before', 'restart', 'outer', 'inner a', 'inner b', 'after inner', 'r1c1 one', 'r1c1 two', 'after']);
  const outerCell = nearestCell(byText.get('outer').ps[0], host);
  const innerCell = nearestCell(byText.get('inner a').ps[0], host);
  assert.notStrictEqual(innerCell, outerCell);
  assert.strictEqual(nearestCell(innerCell, host), outerCell, 'inner cell nested in the outer cell');
  assert.strictEqual(nearestCell(byText.get('after inner').ps[0], host), outerCell);
  // The continuation cell's paragraph is rendered (hidden) but never mapped.
  const cont = all(host, (n) => tag(n) === 'P' && n.textContent === 'continuation');
  assert.strictEqual(cont.length, 1);
  assert.strictEqual(cont[0].getAttribute('data-block'), null);
  const contId = model.blocks().find((b) => b.lockReason === 'merged-cell').id;
  assert.ok(!byId.has(contId));
});

test('styleClassName matches the class docx-preview gives a character style', async () => {
  const { pkg, model } = await docWithBody(P(`<w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>strong text</w:t></w:r>`)
    + P(`<w:r><w:rPr><w:rStyle w:val="My Style.Name&amp;Co"/></w:rPr><w:t>odd</w:t></w:r>`));
  const host = await render(buildRenderCopy(pkg, model).bytes);
  const spans = all(host, (n) => tag(n) === 'SPAN' && n.textContent === 'strong text');
  assert.strictEqual(spans.length, 1);
  assert.ok(spans[0].className.split(/\s+/).includes(DocxMap.styleClassName('Strong')), spans[0].className);
  const odd = all(host, (n) => tag(n) === 'SPAN' && n.textContent === 'odd');
  assert.ok(odd[0].className.split(/\s+/).includes(DocxMap.styleClassName('My Style.Name&Co')), odd[0].className);
  assert.strictEqual(DocxMap.styleClassName('My Style.Name&Co'), 'docx_my-style-nameandco');
  assert.strictEqual(DocxMap.styleClassName(null), 'docx');
  assert.strictEqual(DocxMap.styleClassName('Strong', 'x'), 'x_strong');
});

// ------------------------------------------------------------------------ 2. hand-built trees

/** h('div', {attr}, ...children) on a fresh shim document; strings become text nodes. */
function builder() {
  const doc = makeDocument();
  const h = (name, attrs, ...kids) => {
    const el = doc.createElement(name);
    for (const [k, v] of Object.entries(attrs || {})) { el.setAttribute(k, v); }
    for (const k of kids) { el.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k); }
    return el;
  };
  const s = (id) => h('span', { id: `__vsmd_s_${id}` });
  const e = (id) => h('span', { id: `__vsmd_e_${id}` });
  // docx-preview's page: <section class="docx"><header/>?<article>...</article><footer/>?</section>
  const page = (...body) => h('section', { class: 'docx' }, h('header', {}, h('p', {}, 'Header')),
    h('article', {}, ...body), h('footer', {}, h('p', {}, 'Footer')));
  const wrapper = (...pages) => h('div', { class: 'docx-wrapper' }, ...pages);
  const table = (...rows) => h('table', {}, h('tbody', {}, ...rows.map((cells) => h('tr', {}, ...cells.map((c) => h('td', {}, ...c))))));
  return { doc, h, s, e, page, wrapper, table };
}
const para = (id, extra = {}) => ({ id, kind: 'paragraph', parentId: null, editable: true, removable: true,
  style: { kind: 'normal', name: 'Normal' }, list: { kind: 'none', level: 0 }, ...extra });
const ids = (r) => [...r.byId.entries()].map(([id, ps]) => [id, ps.map((p) => p.textContent)]);

test('hand-built: page-break split paragraph claims both halves; a table between the halves is not claimed', () => {
  const { h, s, e, page, wrapper, table } = builder();
  const root = wrapper(
    page(h('p', {}, s(1), 'one'), h('p', {}, s(2), 'two, first half')),
    page(table([[h('p', {}, 'tbl a')], [h('p', {}, 'tbl b')]]), h('p', {}, 'two, second half', e(2)), h('p', {}, s(3), 'three', e(3))),
  );
  root.childNodes[0].childNodes[1].childNodes[0].appendChild(e(1));
  const r = DocxMap.mapBlocks(root, [para(1), para(2), para(3)]);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(ids(r), [[1, ['one']], [2, ['two, first half', 'two, second half']], [3, ['three']]]);
  for (const p of all(root, (n) => tag(n) === 'P' && (n.textContent.startsWith('tbl') || n.textContent === 'Header' || n.textContent === 'Footer'))) {
    assert.strictEqual(p.getAttribute('data-block'), null, `${p.textContent} not claimed`);
  }
});

test('hand-built: cell paragraphs map within their td; nested-table paragraphs map to the inner cell', () => {
  const { h, s, e, page, wrapper, table } = builder();
  const inner = table([[h('p', {}, s(5), 'inner', e(5))]]);
  const root = wrapper(page(
    h('p', {}, s(1), 'body', e(1)),
    table([
      [h('p', {}, s(2), 'cell first'), h('p', {}, 'cell second'), inner, h('p', {}, 'cell third', e(2))],
      [h('p', {}, s(3), 'other cell', e(3))],
    ]),
  ));
  const r = DocxMap.mapBlocks(root, [para(1), para(2, { parentId: 9 }), para(3, { parentId: 9 }), para(5, { parentId: 4 })]);
  assert.deepStrictEqual(r.missing, []);
  // Block 2 spans its cell's <p>s from start to end, skipping the nested table's <p>.
  assert.deepStrictEqual(ids(r), [[1, ['body']], [2, ['cell first', 'cell second', 'cell third']], [3, ['other cell']], [5, ['inner']]]);
});

test('hand-built: start and end in different cells (or body vs cell) -> missing, nothing claimed', () => {
  const { h, s, e, page, wrapper, table } = builder();
  const root = wrapper(page(
    table([[h('p', {}, s(1), 'a')], [h('p', {}, 'b', e(1))]]),
    h('p', {}, s(2), 'body start'),
    table([[h('p', {}, 'cell end', e(2))]]),
    h('p', {}, s(3), 'ok', e(3)),
  ));
  const r = DocxMap.mapBlocks(root, [para(1, { parentId: 7 }), para(2), para(3)]);
  assert.deepStrictEqual(r.missing, [1, 2]);
  assert.deepStrictEqual(ids(r), [[3, ['ok']]]);
  assert.strictEqual(all(root, (n) => n.getAttribute && n.getAttribute('data-block') !== null).length, 1);
});

test('hand-built: missing, duplicated, reversed and overlapping markers are never guessed', () => {
  const { h, s, e, page, wrapper } = builder();
  const root = wrapper(page(
    h('p', {}, s(1), 'no end'),
    h('p', {}, s(2), 'dup', e(2)), h('p', {}, s(2), 'dup again', e(2)),
    h('p', {}, e(3), 'reversed'), h('p', {}, s(3), 'reversed start'),
    h('p', {}, s(4), 'overlap a'), h('p', {}, s(5), 'overlap shared', e(4)), h('p', {}, 'overlap b', e(5)),
    h('p', {}, s(6), 'fine', e(6)),
    h('p', {}, h('span', {}, h('p', {}, s(7), 'text box', e(7)))),   // <p> nested in a <p>
  ));
  const r = DocxMap.mapBlocks(root, [para(1), para(2), para(3), para(4), para(5), para(6), para(7), para(8)]);
  assert.deepStrictEqual(r.missing, [1, 2, 3, 4, 5, 7, 8]);
  assert.deepStrictEqual(ids(r), [[6, ['fine']]]);
});

test('hand-built: opaque and merged-cell blocks are ignored; locked paragraphs map when found', () => {
  const { h, s, e, page, wrapper } = builder();
  const root = wrapper(page(h('p', {}, s(1), 'locked', e(1)), h('p', {}, 'merged')));
  const r = DocxMap.mapBlocks(root, [
    para(1, { editable: false, lockReason: 'tracked-changes' }),
    para(2, { editable: false, lockReason: 'merged-cell' }),
    { id: 3, kind: 'opaque', parentId: null, editable: false, lockReason: 'opaque', removable: false, style: { kind: 'other', name: '' }, list: { kind: 'none', level: 0 } },
  ]);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(ids(r), [[1, ['locked']]]);
});

test('hand-built: headings get role/aria-level; a re-map clears the previous mapping', () => {
  const { h, s, e, page, wrapper } = builder();
  const root = wrapper(page(h('p', {}, s(1), 'title', e(1)), h('p', {}, s(2), 'body', e(2))));
  const r1 = DocxMap.mapBlocks(root, [para(1, { style: { kind: 'heading', level: 2, name: 'Heading 2' } }), para(2)]);
  const [p1, p2] = [r1.byId.get(1)[0], r1.byId.get(2)[0]];
  assert.strictEqual(p1.getAttribute('role'), 'heading');
  assert.strictEqual(p1.getAttribute('aria-level'), '2');
  assert.strictEqual(p2.getAttribute('role'), null);
  // Block 1 becomes Normal, block 2 is no longer listed.
  const r2 = DocxMap.mapBlocks(root, [para(1)]);
  assert.deepStrictEqual(ids(r2), [[1, ['title']]]);
  assert.strictEqual(p1.getAttribute('role'), null);
  assert.strictEqual(p1.getAttribute('aria-level'), null);
  assert.strictEqual(p2.getAttribute('data-block'), null);
});

test('blockOf: nearest data-block ancestor or null', () => {
  const { h, s, e, page, wrapper } = builder();
  const text = h('span', {}, 'deep');
  const root = wrapper(page(h('p', {}, s(4), h('span', {}, text), e(4)), h('p', {}, 'free')));
  DocxMap.mapBlocks(root, [para(4)]);
  assert.strictEqual(DocxMap.blockOf(text.firstChild), 4, 'from a text node');
  assert.strictEqual(DocxMap.blockOf(text), 4);
  assert.strictEqual(DocxMap.blockOf(all(root, (n) => n.textContent === 'free' && tag(n) === 'P')[0]), null);
  assert.strictEqual(DocxMap.blockOf(null), null);
  assert.strictEqual(DocxMap.blockOf(root), null);
});

test('docxMap.js uses no innerHTML and no globals beyond its export', () => {
  const src = fs.readFileSync(path.join(REPO, 'media', 'docxMap.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src.replace(/\/\/.*$/gm, '')));
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.deepStrictEqual(Object.keys(ctx).filter((k) => k !== 'globalThis'), ['DocxMap']);
  assert.strictEqual(typeof ctx.DocxMap.mapBlocks, 'function');
});

test('NS_W sanity (render-copy markers use WordprocessingML bookmarks)', () => {
  assert.strictEqual(NS_W, 'http://schemas.openxmlformats.org/wordprocessingml/2006/main');
});
