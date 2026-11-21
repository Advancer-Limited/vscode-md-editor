// WP-27: render-only copy with marker bookmarks (src/office/core/docx/renderCopy.ts), spec §8.2.
// The webview half (media/docxMap.js) and the docx-preview render of every fixture are tested in
// docxMap.test.js.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { core, fixture, allFixtures, assertBytesEqual, entryTable } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { SaxesParser } = require('saxes');

const { OfficePackage } = core.pkg;
const { DocxModel, NS_W } = core.docx.model;
const { buildRenderCopy, buildRenderCopyAsync, markerCandidates, FIRST_MARKER_ID, MARKER_PREFIX } = core.docx.renderCopy;
const { serialize, parseXml, pathOf, attr } = core.xml;
const { EditBuilder } = core.edits;
const LIMITS = core.limits.LIMITS;

function open(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, model: DocxModel.load(pkg) };
}

/** Every docx fixture that loads with an editable model. */
function editableFixtures() {
  const out = [];
  for (const name of allFixtures('docx')) {
    let pkg;
    try { pkg = OfficePackage.open(name, fixture(name)); } catch { continue; }   // encrypted, legacy, truncated
    const model = DocxModel.load(pkg);
    if (!model.viewOnlyReason) out.push({ name, pkg, model });
  }
  return out;
}

/** Main part text of a package's bytes. */
function mainText(bytes, mainPart = 'word/document.xml') {
  const p = OfficePackage.open('copy.docx', bytes);
  return p.text(mainPart);
}

function* elements(el) {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop();
    yield e;
    for (let i = e.children.length - 1; i >= 0; i--) if (e.children[i].type === 'el') stack.push(e.children[i]);
  }
}
const isW = (n, local) => n && n.type === 'el' && n.ns === NS_W && n.local === local;

/** Marker bookmarks of a parsed main part: name -> { start, end, id, p (enclosing w:p) }. */
function markersOf(doc) {
  const byName = new Map();
  const ends = new Map();
  for (const e of elements(doc.root)) {
    if (isW(e, 'bookmarkStart')) {
      const name = attr(e, NS_W, 'name');
      if (!name || !name.startsWith(MARKER_PREFIX)) continue;
      assert.ok(!byName.has(name), `duplicate marker ${name}`);
      byName.set(name, { start: e, id: attr(e, NS_W, 'id'), p: e.parent });
    } else if (isW(e, 'bookmarkEnd')) {
      const id = attr(e, NS_W, 'id');
      ends.set(id, (ends.get(id) ?? 0) + 1);
      ends.set(id + '@el', e);
    }
  }
  for (const m of byName.values()) {
    assert.strictEqual(ends.get(m.id), 1, `marker ${m.id} has exactly one bookmarkEnd`);
    m.end = ends.get(m.id + '@el');
    assert.strictEqual(m.end.parent, m.p, 'bookmarkEnd beside its start');
    assert.strictEqual(m.p.children.indexOf(m.end), m.p.children.indexOf(m.start) + 1, 'bookmarkEnd right after its start');
  }
  return byName;
}

const MARK = /<(?:[\w.-]+:)?bookmarkStart(?: xmlns:vsmdw="[^"]*")? [\w.-]+:id="\d+" [\w.-]+:name="__vsmd_[se]_\d+"\/><(?:[\w.-]+:)?bookmarkEnd(?: xmlns:vsmdw="[^"]*")? [\w.-]+:id="\d+"\/>/g;
/** Empty paragraphs written self-closing (`<w:p a="1"></w:p>` -> `<w:p a="1"/>`), so a copy whose
 *  self-closing paragraphs were opened for their markers compares equal. */
const closeEmpty = (t) => t.replace(/<((?:[\w.-]+:)?p)(\s[^<>]*?)?><\/\1>/g, (m, tag, attrs) => `<${tag}${attrs ?? ''}/>`);
/** The copy's main part with every marker removed is the live part (up to `closeEmpty`). */
function assertCopyIsOriginalPlusMarkers(copyText, original, msg) {
  const a = closeEmpty(copyText.replace(MARK, ''));
  const b = closeEmpty(original);
  if (a === b) return;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  assert.fail(`${msg ?? 'copy differs'} at ${i}: copy ${JSON.stringify(a.slice(i - 80, i + 80))} vs ${JSON.stringify(b.slice(i - 80, i + 80))}`);
}

function saxesOk(text) {
  const p = new SaxesParser({ xmlns: true });
  let err = null;
  p.on('error', (e) => { err = e; });
  p.write(text).close();
  assert.strictEqual(err, null, String(err));
}

/** Assert the §8.2 placement of a block's pair inside its copy paragraph. */
function assertPlacement(p, s, e, label) {
  const kids = p.children;
  const firstEl = kids.findIndex((c) => c.type === 'el' && c !== s.start && c !== s.end);
  const si = kids.indexOf(s.start);
  const hasPPr = firstEl >= 0 && isW(kids[firstEl], 'pPr') && firstEl < si;
  assert.strictEqual(si, hasPPr ? firstEl + 1 : 0, `${label}: start marker is the first child after w:pPr`);
  const ei = kids.indexOf(e.end);
  const rest = kids.slice(ei + 1).filter((c) => c.type === 'el');
  if (rest.length === 0) return;   // end marker is the last element
  assert.strictEqual(rest.length, 1, `${label}: only a trailing page-break run follows the end marker`);
  const run = rest[0];
  assert.ok(isW(run, 'r'), `${label}: trailing element is a run`);
  const content = run.children.filter((c) => c.type === 'el' && !isW(c, 'rPr') && !isW(c, 'lastRenderedPageBreak'));
  const last = content[content.length - 1];
  assert.ok(isW(last, 'br') && attr(last, NS_W, 'type') === 'page', `${label}: that run ends with a page break`);
}

// ---------------------------------------------------------------------------------------------------

test('every editable docx fixture: copy differs from the original only in the main part; live package untouched', () => {
  const list = editableFixtures();
  assert.ok(list.length >= 10, `editable docx fixtures found: ${list.length}`);
  for (const { name, pkg, model } of list) {
    const before = serialize(pkg.xml(model.mainPart));
    const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
    assert.ok(markedBlockIds.length > 0, `${name}: markers placed`);
    // Live package: nothing touched, serialize() is the original bytes object (G0), tree unchanged.
    assert.deepStrictEqual(pkg.touchedParts(), [], `${name}: no touched parts`);
    assert.strictEqual(pkg.serialize(), pkg.originalBytes, `${name}: serialize() returns the original bytes`);
    assert.strictEqual(serialize(pkg.xml(model.mainPart)), before, `${name}: live tree unchanged`);
    // Copy: same entries, same order; every entry except the main part copied raw.
    const a = entryTable(pkg.originalBytes);
    const b = entryTable(bytes);
    assert.deepStrictEqual([...b.keys()], [...a.keys()], `${name}: same entries in the same order`);
    for (const [entry, ea] of a) {
      const eb = b.get(entry);
      if (entry.toLowerCase() === model.mainPart.toLowerCase()) {
        assert.notStrictEqual(eb.crc, ea.crc, `${name}: main part changed`);
        continue;
      }
      assert.strictEqual(eb.crc, ea.crc, `${name}/${entry}: crc`);
      assertBytesEqual(eb.compressedBytes, ea.compressedBytes, `${name}/${entry}: raw bytes`);
      assertBytesEqual(eb.cdRecordBytes, ea.cdRecordBytes, `${name}/${entry}: central record`);
    }
    // Removing the markers gives back the main part exactly.
    const text = mainText(bytes, model.mainPart);
    assertCopyIsOriginalPlusMarkers(text, before, `${name}: copy = original + markers only`);
  }
});

test('one marker pair per paragraph block in body and cells, placed per §8.2; none in merged-cell paragraphs', () => {
  let cells = 0, merged = 0, nested = 0;
  for (const { name, pkg, model } of editableFixtures()) {
    const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
    const copy = parseXml(mainText(bytes, model.mainPart));
    const marks = markersOf(copy);
    const expected = model.blocks().filter((b) => b.kind === 'paragraph' && b.lockReason !== 'merged-cell').map((b) => b.id);
    assert.deepStrictEqual(markedBlockIds, expected, `${name}: marked ids = paragraph blocks minus merged-cell, document order`);
    assert.strictEqual(marks.size, expected.length * 2, `${name}: two markers per marked block, nothing else`);
    for (const b of model.blocks()) {
      const s = marks.get(`__vsmd_s_${b.id}`);
      const e = marks.get(`__vsmd_e_${b.id}`);
      if (b.kind !== 'paragraph' || b.lockReason === 'merged-cell') {
        assert.ok(!s && !e, `${name}: block ${b.id} (${b.kind}/${b.lockReason}) has no markers`);
        if (b.lockReason === 'merged-cell') merged++;
        continue;
      }
      assert.ok(s && e, `${name}: block ${b.id} has both markers`);
      assert.strictEqual(s.p, e.p, `${name}: block ${b.id} markers in one paragraph`);
      // The copy paragraph is the block's paragraph: same position in the tree (markers are only
      // ever inserted inside paragraphs, so element paths outside them are unchanged).
      assert.deepStrictEqual(pathOf(s.p), pathOf(b.el), `${name}: block ${b.id} markers inside its own w:p`);
      assert.ok(isW(s.p, 'p'));
      assertPlacement(s.p, s, e, `${name} block ${b.id}`);
      if (b.container.tableBlockId !== null) cells++;
      if (b.container.parent && b.container.parent.tableBlockId !== null) nested++;
    }
  }
  assert.ok(cells > 100, `cell paragraphs marked: ${cells}`);
  assert.ok(nested > 0, `nested-table cell paragraphs marked: ${nested}`);
  assert.ok(merged > 0, `merged-cell paragraphs seen (and left unmarked): ${merged}`);
});

test('marker ids start at 2,000,000,000, are unique, and skip ids the document already uses', async () => {
  // anchors.docx has ordinary bookmarks; add two that collide with the marker range.
  const zip = await JSZip.loadAsync(fixture('anchors.docx'));
  let text = await zip.file('word/document.xml').async('string');
  const at = text.indexOf('<w:body>') + 8;
  const taken = `<w:p><w:bookmarkStart w:id="2000000000" w:name="x"/><w:bookmarkEnd w:id="2000000000"/><w:bookmarkStart w:id="2000000002" w:name="y"/><w:bookmarkEnd w:id="2000000002"/></w:p>`;
  text = text.slice(0, at) + taken + text.slice(at);
  zip.file('word/document.xml', text);
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const { pkg, model } = open('ids.docx', bytes);
  const existing = new Set();
  for (const e of elements(pkg.xml(model.mainPart).root)) {
    if (isW(e, 'bookmarkStart')) existing.add(attr(e, NS_W, 'id'));
  }
  assert.ok(existing.has('2000000000') && existing.size > 3);
  const copy = parseXml(mainText(buildRenderCopy(pkg, model).bytes));
  const ids = [...markersOf(copy).values()].map((m) => Number(m.id));
  assert.strictEqual(new Set(ids).size, ids.length, 'unique');
  for (const id of ids) {
    assert.ok(id >= FIRST_MARKER_ID, `id ${id} >= 2e9`);
    assert.ok(!existing.has(String(id)), `id ${id} not already used`);
  }
  assert.strictEqual(Math.min(...ids), 2000000001, 'first free id from 2,000,000,000');
});

test('copy main part passes the lossless parser and saxes (every editable fixture)', () => {
  for (const { name, pkg, model } of editableFixtures()) {
    const text = mainText(buildRenderCopy(pkg, model).bytes, model.mainPart);
    const doc = parseXml(text);
    assert.strictEqual(serialize(doc), text, `${name}: lossless round trip`);
    saxesOk(text);
    // And the copy is itself a loadable docx whose model sees the markers as anchors.
    const re = open(name, buildRenderCopy(pkg, model).bytes);
    assert.strictEqual(re.model.viewOnlyReason, null, `${name}: copy loads`);
  }
});

// ---------------------------------------------------------------------------------------------------
// Synthetic paragraph shapes

async function docWithBody(bodyXml) {
  const zip = await JSZip.loadAsync(fixture('basic.docx'));
  const t = await zip.file('word/document.xml').async('string');
  const a = t.indexOf('<w:body>');
  const b = t.indexOf('</w:body>');
  zip.file('word/document.xml', t.slice(0, a + 8) + bodyXml + t.slice(b));
  return open('synthetic.docx', new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
}
const T = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const PAGE = '<w:r><w:br w:type="page"/></w:r>';

test('placement: pPr, empty, self-closing with attributes, trailing page-break run, mid-paragraph break', async () => {
  const { pkg, model } = await docWithBody([
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${T('centred')}</w:p>`,            // 0 start after pPr
    `<w:p w14:paraId="1A2B3C4D" w14:textId="77777777"/>`,                            // 1 self-closing
    `<w:p></w:p>`,                                                                   // 2 empty, open form
    `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`,                           // 3 pPr only
    `<w:p>${T('before break')}${PAGE}</w:p>`,                                        // 4 trailing break run
    `<w:p>${T('a')}<w:r><w:t>b</w:t><w:br w:type="page"/><w:lastRenderedPageBreak/></w:r></w:p>`, // 5 break then lrpb
    `<w:p>${T('one')}<w:r><w:br w:type="page"/><w:t>two</w:t></w:r></w:p>`,          // 6 break mid-run: end marker last
    `<w:p>${PAGE}${T('after')}</w:p>`,                                               // 7 break first
    `<w:p><w:pPr/>${PAGE}</w:p>`,                                                    // 8 only a break run
    `<w:p>${T('column')}<w:r><w:br w:type="column"/></w:r></w:p>`,                  // 9 column break: last
    `<w:sectPr/>`,
  ].join(''));
  assert.strictEqual(model.viewOnlyReason, null);
  const blocks = model.blocks();
  const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
  assert.strictEqual(markedBlockIds.length, 10);
  const text = mainText(bytes);
  saxesOk(text);
  const copy = parseXml(text);
  const marks = markersOf(copy);
  const body = copy.root.children.find((c) => isW(c, 'body'));
  const ps = body.children.filter((c) => isW(c, 'p'));
  const kinds = (p) => p.children.filter((c) => c.type === 'el').map((c) => {
    const n = attr(c, NS_W, 'name');
    if (n) return n.startsWith('__vsmd_s_') ? 'S' : 'E';
    return c.local;
  }).filter((k) => k !== 'bookmarkEnd').join(' ');
  assert.deepStrictEqual(ps.map(kinds), [
    'pPr S r E',
    'S E',
    'S E',
    'pPr S E',
    'S r E r',
    'S r E r',
    'S r r E',
    'S r r E',
    'pPr S E r',
    'S r r E',
  ]);
  for (let i = 0; i < 10; i++) {
    const s = marks.get(`__vsmd_s_${blocks[i].id}`);
    const e = marks.get(`__vsmd_e_${blocks[i].id}`);
    assert.strictEqual(s.p, ps[i]);
    assertPlacement(ps[i], s, e, `p${i}`);
  }
  // The self-closing paragraph keeps its start tag (attributes) and is closed normally.
  assert.match(text, /<w:p w14:paraId="1A2B3C4D" w14:textId="77777777"><w:bookmarkStart w:id="\d+" w:name="__vsmd_s_\d+"\/>/);
  assertCopyIsOriginalPlusMarkers(text, serialize(pkg.xml(model.mainPart)));
});

test('tables: cell and nested-cell paragraphs are marked; vMerge continuation and hMerge are not', async () => {
  const TC = (inner, tcPr = '') => `<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/>${tcPr}</w:tcPr>${inner}</w:tc>`;
  const TBL = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="100"/><w:gridCol w:w="100"/></w:tblGrid>${rows}</w:tbl>`;
  const P = (t) => `<w:p>${T(t)}</w:p>`;
  const inner = TBL(`<w:tr>${TC(P('inner a'))}${TC(P('inner b'))}</w:tr>`);
  const { pkg, model } = await docWithBody([
    P('body'),
    TBL([
      `<w:tr>${TC(P('restart'), '<w:vMerge w:val="restart"/>')}${TC(P('r0c1') + inner + P('after inner'))}</w:tr>`,
      `<w:tr>${TC(P('continuation'), '<w:vMerge/>')}${TC(P('h'), '<w:hMerge w:val="continue"/>')}</w:tr>`,
    ].join('')),
    P('tail'),
    '<w:sectPr/>',
  ].join(''));
  const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
  const texts = (id) => {
    const b = model.block(id);
    return b.el.children.filter((c) => isW(c, 'r')).map((r) => r.children.map((t) => (t.type === 'el' ? t.children.map((x) => x.raw).join('') : '')).join('')).join('');
  };
  assert.deepStrictEqual(markedBlockIds.map(texts), ['body', 'restart', 'r0c1', 'inner a', 'inner b', 'after inner', 'tail']);
  const merged = model.blocks().filter((b) => b.lockReason === 'merged-cell').map((b) => texts(b.id));
  assert.deepStrictEqual(merged, ['continuation', 'h']);
  saxesOk(mainText(bytes));
  assert.deepStrictEqual(markerCandidates(model).map((b) => b.id), markedBlockIds);
});

test('an edited package: the copy reflects the edit; building it changes nothing in the package', () => {
  const { pkg, model } = open('basic.docx');
  const doc = pkg.xml(model.mainPart);
  const body = doc.root.children.find((c) => isW(c, 'body'));
  const b = new EditBuilder(pkg, 'test');
  b.insertAt(model.mainPart, body, 0, `<w:p>${T('inserted first')}</w:p>`);
  const edit = b.finish();
  assert.ok(edit);
  model.refresh();
  const touched = pkg.touchedParts();
  assert.deepStrictEqual(touched, ['word/document.xml']);
  const saved = pkg.serialize();
  const before = serialize(doc);
  const { bytes, markedBlockIds } = buildRenderCopy(pkg, model);
  assert.deepStrictEqual(pkg.touchedParts(), touched, 'touched set unchanged');
  assert.strictEqual(serialize(doc), before, 'tree unchanged');
  assertBytesEqual(pkg.serialize(), saved, 'serialize unchanged');
  const first = model.blocks()[0];
  assert.strictEqual(markedBlockIds[0], first.id);
  const text = mainText(bytes);
  assert.ok(text.includes(`<w:p><w:bookmarkStart w:id="2000000000" w:name="__vsmd_s_${first.id}"/><w:bookmarkEnd w:id="2000000000"/><w:r><w:t xml:space="preserve">inserted first</w:t></w:r>`));
  assertCopyIsOriginalPlusMarkers(text, before);
  // Other entries are those of the live package.
  const a = entryTable(saved);
  const c = entryTable(bytes);
  for (const [n, e] of a) if (n !== 'word/document.xml') assert.strictEqual(c.get(n).crc, e.crc, n);
});

test('buildRenderCopyAsync produces the same bytes', async () => {
  for (const name of ['basic.docx', 'tables.docx', 'large.docx']) {
    const { pkg, model } = open(name);
    const sync = buildRenderCopy(pkg, model);
    const asyn = await buildRenderCopyAsync(pkg, model);
    assertBytesEqual(asyn.bytes, sync.bytes, name);
    assert.deepStrictEqual(asyn.markedBlockIds, sync.markedBlockIds);
  }
});

test('a view-only model gets the unmarked current bytes', async () => {
  // WordprocessingML only as the root's default namespace (prefix bound below the root) ->
  // unsupported-xml-layout.
  const zip = await JSZip.loadAsync(fixture('basic.docx'));
  const t = await zip.file('word/document.xml').async('string');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  assert.ok(t.includes(W));
  zip.file('word/document.xml', t.replace(' ' + W, '').replace('<w:document ', `<document xmlns="${NS_W}" `)
    .replace('</w:document>', '</document>').replace('<w:body>', `<w:body ${W}>`));
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const { pkg, model } = open('odd.docx', bytes);
  assert.strictEqual(model.viewOnlyReason, 'unsupported-xml-layout');
  const r = buildRenderCopy(pkg, model);
  assert.deepStrictEqual(r.markedBlockIds, []);
  assert.strictEqual(r.bytes, pkg.serialize());
});

test('large.docx: copy within budget', () => {
  const { pkg, model } = open('large.docx');
  const t0 = performance.now();
  const { markedBlockIds } = buildRenderCopy(pkg, model);
  const ms = performance.now() - t0;
  assert.ok(markedBlockIds.length > 1000);
  assert.ok(ms < 3000, `large.docx copy took ${ms.toFixed(0)} ms`);
  assert.ok(LIMITS.parseYieldMs > 0);
});
