// WP-25: docx block and segment model (src/office/core/docx/model.ts).
// Spec §8.1 (containers, table-cell rules), §8.3 (paragraph allow-list), §10.2 (block limit).
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import { core, fixture, allFixtures, assertBytesEqual } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { DocxModel, classifyParagraph, paragraphProps, isEditable, NS_W } = core.docx.model;
const { EditBuilder, applyEdit, invertEdit } = core.edits;
const { serialize } = core.xml;
const LIMITS = core.limits.LIMITS;

const NB_HYPHEN = String.fromCodePoint(0x2011);
const SOFT_HYPHEN = String.fromCodePoint(0xAD);

function open(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, model: DocxModel.load(pkg) };
}

/** basic.docx with `fn(document.xml text)` as its main part. */
async function patchedDocx(fn, from = 'basic.docx') {
  const zip = await JSZip.loadAsync(fixture(from));
  const text = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', fn(text));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** A document whose body is exactly `bodyXml` (root element and its namespace declarations from basic.docx). */
async function docWithBody(bodyXml) {
  const bytes = await patchedDocx((t) => {
    const a = t.indexOf('<w:body>');
    const b = t.indexOf('</w:body>');
    assert.ok(a > 0 && b > a, 'basic.docx has a w:body');
    return t.slice(0, a + 8) + bodyXml + t.slice(b);
  });
  return open('synthetic.docx', bytes);
}

const T = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const P = (inner = '') => `<w:p>${inner}</w:p>`;
const FLD = (type) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
const TC = (inner, tcPr = '') => `<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/>${tcPr}</w:tcPr>${inner}</w:tc>`;
const TR = (cells, trPr = '') => `<w:tr>${trPr}${cells}</w:tr>`;
const TBL = (rows, tblPr = '') => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${tblPr}</w:tblPr><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>${rows}</w:tbl>`;

function segText(s) {
  switch (s.kind) {
    case 'text': return JSON.stringify(s.text) + (s.wholeRun ? '' : '~');
    case 'atom': return `<${s.atomType}:${s.label}>` + (s.run ? '@run' : '');
    case 'anchor': return `^${s.pairKey ?? '?'}${s.role ? '/' + s.role : ''}`;
    default: return '(d)';
  }
}
const segs = (model, b) => model.segments(b).map(segText).join(' ');

/** One line per block: element, cell position, lock state. */
function snapshot(model) {
  return model.blocks().map((b) => {
    const c = b.container;
    const where = c.tableBlockId === null ? '' : `[${c.row},${c.col}]`;
    return `${b.el.local}${where}:${b.lockReason ?? 'editable'}`;
  });
}

/** Plain text of a block's element (every w:t below it). */
function plain(b) {
  let out = '';
  const stack = [b.el];
  while (stack.length) {
    const n = stack.pop();
    if (n.type !== 'el') continue;
    if (n.local === 't' && n.ns === NS_W) { out += core.xml.textContent(n); continue; }
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return out;
}
function byText(model, text) {
  const hits = model.blocks().filter((b) => b.kind === 'paragraph' && plain(b) === text);
  assert.strictEqual(hits.length, 1, `exactly one paragraph reads "${text}"`);
  return hits[0];
}

/** State of the single paragraph of a one-paragraph body: its lock reason, or its segments as text. */
async function para(inner) {
  const { model } = await docWithBody(`<w:p>${inner}</w:p><w:sectPr/>`);
  const b = model.blocks()[0];
  return b.lockReason ?? segs(model, b);
}

// ---------------------------------------------------------------------------------------------------
// Blocks

test('body paragraphs, tables and sectPr of basic/rich.docx classify as expected (snapshot of kind/lockReason per block)', () => {
  const basic = open('basic.docx').model;
  assert.strictEqual(basic.viewOnlyReason, null);
  assert.strictEqual(basic.mainPart, 'word/document.xml');
  assert.strictEqual(basic.wPrefix, 'w');
  assert.deepStrictEqual(snapshot(basic), [...Array(16).fill('p:editable'), 'sectPr:opaque']);
  for (const b of basic.blocks()) {
    assert.strictEqual(b.kind, b.el.local === 'p' ? 'paragraph' : 'opaque');
    assert.strictEqual(b.container, basic.body());
    assert.strictEqual(b.isTable, false);
  }

  const rich = open('rich.docx').model;
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push(`p[${r},${c}]:editable`);
  assert.deepStrictEqual(snapshot(rich), [
    'p:editable', 'p:editable', 'tbl:opaque', ...cells,
    ...Array(9).fill('p:editable'), 'sectPr:opaque',
  ]);
  const table = rich.blocks()[2];
  assert.strictEqual(table.kind, 'opaque');
  assert.strictEqual(table.isTable, true);
  assert.strictEqual(isEditable(table), false);
  assert.strictEqual(rich.cells(table).length, 9);
  // The section-ending paragraph is still an editable paragraph; the final sectPr is an opaque block.
  const sectionEnd = rich.blocks().filter((b) => b.kind === 'paragraph' && paragraphProps(b.el).hasSectPr);
  assert.strictEqual(sectionEnd.length, 1);
  assert.strictEqual(isEditable(sectionEnd[0]), true);
  assert.strictEqual(segs(rich, byText(rich, 'A paragraph with a footnote.')), '"A paragraph with a footnote." <footnote:Footnote>');
  assert.strictEqual(segs(rich, byText(rich, 'A hyperlink: example link')), '"A hyperlink: " <hyperlink:example link>');
  const pageBreak = rich.blocks().find((b) => segs(rich, b) === '<break:Page break>');
  assert.ok(pageBreak, 'the page-break paragraph is one whole-run atom');
});

test('tables.docx: cell paragraphs are blocks with parentId/cell; nested table cells are containers; vMerge continuation → merged-cell; restart and gridSpan cells editable; content-control row not descended; tracked row → tracked-changes', () => {
  const { model } = open('tables.docx');
  const blocks = model.blocks();
  const tables = blocks.filter((b) => b.isTable);
  assert.strictEqual(tables.length, 8);
  assert.ok(tables.every((t) => t.kind === 'opaque' && t.lockReason === 'opaque'));
  assert.strictEqual(tables.filter((t) => t.container.tableBlockId === null).length, 7);

  // Table 1: cell paragraphs carry the table's id and the tr/tc ordinals.
  const second = byText(model, 'second cell');
  assert.strictEqual(second.container.tableBlockId, tables[0].id);
  assert.deepStrictEqual([second.container.row, second.container.col], [0, 1]);
  assert.strictEqual(second.container.el.local, 'tc');
  assert.strictEqual(second.container.parent, model.body());
  assert.strictEqual(isEditable(second), true);
  assert.strictEqual(segs(model, byText(model, 'plain bold italic')), '"plain " "bold" " " "italic"');
  // Two paragraphs of one cell are siblings; siblings never leave the cell.
  const two = byText(model, 'two');
  const paragraphs = byText(model, 'paragraphs');
  assert.deepStrictEqual(model.siblings(two), { prev: null, next: paragraphs });
  assert.deepStrictEqual(model.siblings(paragraphs), { prev: two, next: null });
  assert.deepStrictEqual(model.blocksIn(two.container), [two, paragraphs]);
  // A table's body siblings are the paragraphs around it, not its cells.
  assert.strictEqual(model.siblings(tables[0]).prev, byText(model, 'Table 1: mixed run formatting'));
  assert.strictEqual(model.siblings(tables[0]).next, byText(model, 'After table 1.'));

  // Table 3: the nested table is an opaque block inside a cell, and its cells are containers.
  const nested = tables.find((t) => t.container.tableBlockId !== null);
  const holder = byText(model, 'outer 2,1 (ends in a nested table)');
  assert.strictEqual(nested.container, holder.container);
  assert.deepStrictEqual([nested.container.row, nested.container.col], [1, 0]);
  const inner = byText(model, 'in 2,1');
  assert.strictEqual(inner.container.tableBlockId, nested.id);
  assert.deepStrictEqual([inner.container.row, inner.container.col], [1, 0]);
  assert.strictEqual(inner.container.parent, nested.container);
  assert.strictEqual(isEditable(inner), true);
  assert.strictEqual(model.cells(nested).length, 4);
  // The cell ends with the mandatory empty paragraph after the nested table.
  const inHolder = model.blocksIn(holder.container);
  assert.deepStrictEqual(inHolder.map((b) => b.el.local), ['p', 'tbl', 'p']);
  assert.deepStrictEqual(model.siblings(inHolder[2]), { prev: nested, next: null });
  // Document order: the nested table's cell paragraphs come between the table block and the trailing paragraph.
  assert.ok(blocks.indexOf(nested) < blocks.indexOf(inner) && blocks.indexOf(inner) < blocks.indexOf(inHolder[2]));

  // Table 4: vMerge continuations are locked; the restart cell and gridSpan cells are ordinary.
  const merged = blocks.filter((b) => b.lockReason === 'merged-cell');
  assert.strictEqual(merged.length, 2);
  for (const b of merged) {
    assert.strictEqual(b.kind, 'paragraph');
    assert.strictEqual(b.container.lockReason, 'merged-cell');
    assert.deepStrictEqual(model.segments(b), []);
  }
  for (const text of ['M11', 'M31', 'M24']) {
    const b = byText(model, text);
    assert.strictEqual(isEditable(b), true, `${text} is editable`);
    assert.strictEqual(b.container.lockReason, null);
  }
  const tcPrText = (b) => serialize(b.container.el.children.find((n) => n.type === 'el' && n.local === 'tcPr'));
  assert.match(tcPrText(byText(model, 'M11')), /<w:gridSpan w:val="2"\/>/);
  assert.match(tcPrText(byText(model, 'M24')), /<w:vMerge w:val="restart"\/>/);

  // Table 5: the row wrapped in a content control is not descended into.
  const cc = tables.find((t) => model.cells(t).some((c) => model.blocksIn(c).some((b) => plain(b) === 'CC11')));
  assert.deepStrictEqual(model.cells(cc).map((c) => model.blocksIn(c).map(plain).join('|')), ['CC11', 'CC12', 'CC31', 'CC32']);
  assert.ok(!blocks.some((b) => b.kind === 'paragraph' && plain(b).startsWith('CC2')), 'CC2x paragraphs are not blocks');
  assert.match(serialize(cc.el), /CC21/);
  // Row ordinals count the table's direct w:tr children only.
  assert.deepStrictEqual([byText(model, 'CC31').container.row, byText(model, 'CC32').container.col], [1, 1]);

  // Table 7: the tracked row insertion locks its cells' paragraphs; the other rows stay editable.
  const tracked = blocks.filter((b) => b.lockReason === 'tracked-changes');
  assert.strictEqual(tracked.length, 2);
  assert.ok(tracked.every((b) => b.container.lockReason === 'tracked-changes' && b.container.row === 2));
  assert.strictEqual(isEditable(byText(model, 'T22')), true);

  // Every other cell paragraph is editable.
  const cellParas = blocks.filter((b) => b.kind === 'paragraph' && b.container.tableBlockId !== null);
  assert.strictEqual(cellParas.length, 186);
  assert.strictEqual(cellParas.filter(isEditable).length, 182);
});

test('table-level revision marks and merge continuations (synthetic)', async () => {
  const cell = (text, tcPr) => TC(P(T(text)), tcPr);
  const { model } = await docWithBody(
    // 0: legacy hMerge continuation, cellIns, vMerge with explicit continue
    TBL(TR(cell('a') + cell('h', '<w:hMerge/>') + cell('ci', '<w:cellIns w:id="1" w:author="x"/>') + cell('vc', '<w:vMerge w:val="continue"/>')
      + cell('hr', '<w:hMerge w:val="restart"/>')))
    // 1: tblPrChange locks the whole table, nested table included
    + TBL(TR(cell('w1') + TC(TBL(TR(cell('w-nested'))) + P())), '<w:tblPrChange w:id="2" w:author="x"><w:tblPr/></w:tblPrChange>')
    // 2: tcPrChange in one cell locks the whole table
    + TBL(TR(cell('x1')) + TR(cell('x2', '<w:tcPrChange w:id="3" w:author="x"><w:tcPr/></w:tcPrChange>')))
    // 3: a deleted row; a continuation cell holding a nested table; merged wins over tracked
    + TBL(TR(cell('d1'), '<w:trPr><w:del w:id="4" w:author="x"/></w:trPr>')
      + TR(cell('ok') + TC(TBL(TR(cell('m-nested'))) + P(), '<w:vMerge/>'))
      + TR(cell('both', '<w:vMerge/>'), '<w:trPr><w:ins w:id="5" w:author="x"/></w:trPr>'))
    // 4: trPrChange in a row wrapped in a content control still marks the whole table
    + TBL(TR(cell('y1')) + '<w:sdt><w:sdtContent>' + TR(cell('y2'), '<w:trPr><w:trPrChange w:id="6" w:author="x"><w:trPr/></w:trPrChange></w:trPr>') + '</w:sdtContent></w:sdt>')
    + P(T('after')) + '<w:sectPr/>');
  const lock = (text) => byText(model, text).lockReason ?? 'editable';
  assert.deepStrictEqual(
    ['a', 'h', 'ci', 'vc', 'hr'].map(lock),
    ['editable', 'merged-cell', 'tracked-changes', 'merged-cell', 'editable']);
  assert.deepStrictEqual(['w1', 'w-nested'].map(lock), ['tracked-changes', 'tracked-changes']);
  assert.deepStrictEqual(['x1', 'x2'].map(lock), ['tracked-changes', 'tracked-changes']);
  assert.deepStrictEqual(['d1', 'ok', 'm-nested', 'both'].map(lock), ['tracked-changes', 'editable', 'merged-cell', 'merged-cell']);
  assert.strictEqual(lock('y1'), 'tracked-changes');
  assert.strictEqual(lock('after'), 'editable');
  // tcPr is the cell's properties, never a block.
  assert.ok(!model.blocks().some((b) => b.el.local === 'tcPr'));
});

// ---------------------------------------------------------------------------------------------------
// Segments

test('multi-run.docx: tab/br/noBreakHyphen/softHyphen map into text; mixed run splits into segments sharing rPr', async () => {
  const { model } = open('multi-run.docx');
  const b = model.blocks()[1];
  const list = model.segments(b);
  assert.deepStrictEqual(list.map((s) => s.text), [
    'Plain ', 'bold ', 'italic ', 'both ', 'underline ', 'strike ', 'big ', 'red ', 'mono ', 'sup',
    '\tafter-tab', '\nsoft line break', '\tsecond-tab end.',
  ]);
  assert.ok(list.every((s) => s.kind === 'text' && s.wholeRun));
  assert.strictEqual(list[0].rPr, null);
  assert.strictEqual(serialize(list[1].rPr), '<w:rPr><w:b/></w:rPr>');
  assert.deepStrictEqual(list[10].pieces.map((p) => p.local), ['tab', 't']);
  assert.deepStrictEqual(list[11].pieces.map((p) => p.local), ['br', 't']);
  assert.strictEqual(serialize(list[12].run), '<w:r><w:rPr><w:b/></w:rPr><w:tab/><w:t>second-tab end.</w:t></w:r>');
  assert.deepStrictEqual(paragraphProps(b.el), { pPr: b.el.children[0], pStyleId: null, numPr: null, hasSectPr: false });
  assert.strictEqual(paragraphProps(model.blocks()[0].el).pStyleId, 'Heading1');

  // The hyphen elements, an explicit textWrapping break, and entity/CDATA text.
  assert.strictEqual(
    await para('<w:r><w:t>co</w:t><w:noBreakHyphen/><w:t>op</w:t><w:softHyphen/><w:t>era</w:t><w:br w:type="textWrapping"/><w:t>a &amp; b <![CDATA[<c>]]></w:t></w:r>'),
    JSON.stringify(`co${NB_HYPHEN}op${SOFT_HYPHEN}era\na & b <c>`));

  // A run mixing text with atoms: consecutive segments, all pointing at the one run and its rPr.
  const { model: mixed } = await docWithBody(
    P('<w:r w:rsidR="00AB12CD"><w:rPr><w:i/></w:rPr><w:t>before</w:t><w:br w:type="page"/><w:t>after</w:t><w:tab/><w:footnoteReference w:id="2"/><w:lastRenderedPageBreak/><w:t>end</w:t></w:r>')
    + '<w:sectPr/>');
  const mb = mixed.blocks()[0];
  const ms = mixed.segments(mb);
  assert.strictEqual(ms.map(segText).join(' '), '"before"~ <break:Page break>@run "after\\t"~ <footnote:Footnote>@run (d) "end"~');
  const run = mb.el.children[0];
  for (const s of ms.filter((x) => x.kind !== 'disposable')) {
    assert.strictEqual(s.run, run);
    assert.strictEqual(s.rPr, run.children[0]);
  }
  assert.strictEqual(serialize(ms[1].nodes[0]), '<w:br w:type="page"/>');
  assert.strictEqual(ms[4].nodes[0].local, 'lastRenderedPageBreak');
  // Ids are distinct across blocks and segments.
  const ids = [mb.id, ...ms.filter((x) => x.kind !== 'disposable').map((x) => x.id)];
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('run content outside the text mapping: atoms, and refusals', async () => {
  const drawing = '<w:drawing><wp:inline><wp:docPr id="1" name="Picture 7" descr="A red square"/></wp:inline></w:drawing>';
  assert.strictEqual(await para(`<w:r><w:rPr><w:noProof/></w:rPr>${drawing}</w:r>`), '<image:A red square>');
  assert.strictEqual(await para('<w:r><w:pict/></w:r><w:r><w:object/></w:r><w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r>'), '<image:Picture> <object:Object> <object:Symbol>');
  assert.strictEqual(await para('<w:r><w:endnoteReference w:id="1"/></w:r><w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r><w:r><w:cr/></w:r>'),
    '<footnote:Endnote> <object:Alignment tab> <break:Line break>');
  assert.strictEqual(await para('<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing/></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>'), '<object:Drawing>');
  assert.strictEqual(await para('<w:r><w:br w:type="column"/></w:r>'), '<break:Column break>');
  // A line break that clears floats cannot be written back as a plain w:br: it stays an atom.
  assert.strictEqual(await para('<w:r><w:t>a</w:t><w:br w:clear="all"/><w:t>b</w:t></w:r>'), '"a"~ <break:Line break>@run "b"~');
  assert.strictEqual(await para('<w:r><w:br w:clear="none"/></w:r>'), '"\\n"');

  for (const [why, inner] of [
    ['unknown break type', '<w:r><w:br w:type="line"/></w:r>'],
    ['raw tab inside w:t', '<w:r><w:t>a\tb</w:t></w:r>'],
    ['raw newline inside w:t', '<w:r><w:t>a\nb</w:t></w:r>'],
    ['w:rPr not first', '<w:r><w:t>a</w:t><w:rPr><w:b/></w:rPr></w:r>'],
    ['two w:rPr', '<w:r><w:rPr/><w:rPr/><w:t>a</w:t></w:r>'],
    ['character data directly in a run', '<w:r>loose<w:t>a</w:t></w:r>'],
    ['footnote-part-only run content', '<w:r><w:footnoteRef/></w:r>'],
    ['field instruction with no field', '<w:r><w:instrText>PAGE</w:instrText></w:r>'],
    ['ruby', '<w:r><w:ruby/></w:r>'],
    ['foreign-namespace run child', '<w:r><wp:inline/></w:r>'],
    ['comment reference sharing a run with text', '<w:r><w:t>a</w:t><w:commentReference w:id="1"/></w:r>'],
  ]) {
    assert.strictEqual(await para(inner), 'unknown-content', why);
  }
});

test('fields.docx: same-paragraph complex field is one atom labelled with its result; TOC paragraphs → multi-paragraph-field', async () => {
  const { model } = open('fields.docx');
  assert.deepStrictEqual(snapshot(model), [
    'p:editable', 'p:editable',
    'p:multi-paragraph-field', 'p:multi-paragraph-field',   // the two TOC entries
    'p:multi-paragraph-field',                               // "Chapter One": the TOC field ends in it
    'p:editable', 'p:editable', 'p:editable', 'p:editable', 'p:editable', 'p:editable', 'p:editable', 'p:editable',
    'sectPr:opaque',
  ]);
  const page = model.blocks()[9];
  assert.strictEqual(segs(model, page), '(d) "Page number field: "~ <field:1>');
  const field = model.segments(page)[2];
  assert.strictEqual(field.atomType, 'field');
  assert.strictEqual(field.run, null);
  assert.strictEqual(field.nodes.length, 5);                 // begin, instruction, separate, result, end
  assert.strictEqual(field.nodes[0], page.el.children[1]);
  assert.strictEqual(field.nodes[4], page.el.children[5]);
  assert.strictEqual(segs(model, model.blocks()[10]), '"Cross reference: " <field:Chapter Two>');
  assert.strictEqual(segs(model, model.blocks()[11]), '"Date field: " <field:1 January 2020>');   // w:fldSimple
  for (const b of model.blocks().slice(2, 5)) assert.deepStrictEqual(model.segments(b), []);

  // Nested fields are one atom; the label takes the result, nested results included, never the instructions.
  assert.strictEqual(await para(
    T('x') + FLD('begin') + '<w:r><w:instrText> IF </w:instrText></w:r>' + FLD('begin') + '<w:r><w:instrText> PAGE </w:instrText></w:r>'
    + FLD('separate') + T('3') + FLD('end') + '<w:r><w:instrText> = 3 "y" "n" </w:instrText></w:r>' + FLD('separate') + T('res ')
    + '<w:bookmarkStart w:id="9" w:name="in"/>' + FLD('begin') + FLD('separate') + T('ult') + FLD('end') + '<w:hyperlink><w:r><w:t>!</w:t></w:r></w:hyperlink>' + FLD('end') + T('y')),
  '"x" <field:res ult!> "y"');
  // A field with no result is labelled with its instruction; one run may hold the whole field.
  assert.strictEqual(await para('<w:r><w:fldChar w:fldCharType="begin"/><w:instrText> NUMPAGES \\* Arabic </w:instrText><w:fldChar w:fldCharType="end"/></w:r>'), '<field:NUMPAGES>');
  assert.strictEqual(await para('<w:fldSimple w:instr=" AUTHOR "/>'), '<field:AUTHOR>');

  for (const [why, inner, expected = 'unknown-content'] of [
    ['text before the begin in the same run', '<w:r><w:t>a</w:t><w:fldChar w:fldCharType="begin"/></w:r>' + FLD('end')],
    ['text after the end in the same run', FLD('begin') + '<w:r><w:fldChar w:fldCharType="end"/><w:t>a</w:t></w:r>'],
    ['two fields in one run', '<w:r><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/></w:r>'],
    ['end with no begin', T('a') + FLD('end')],
    ['separate with no begin', FLD('separate') + T('a')],
    ['unknown fldCharType', '<w:r><w:fldChar w:fldCharType="middle"/></w:r>'],
    ['fldChar with no type', '<w:r><w:fldChar/></w:r>'],
    ['field ending inside a hyperlink', FLD('begin') + '<w:hyperlink>' + FLD('end') + '</w:hyperlink>'],
    ['field beginning inside a hyperlink', '<w:hyperlink>' + FLD('begin') + '</w:hyperlink>' + FLD('end')],
    ['begin without end', T('a') + FLD('begin') + T('b'), 'multi-paragraph-field'],
  ]) {
    assert.strictEqual(await para(inner), expected, why);
  }
});

test('a field spanning paragraphs locks every paragraph it touches, through tables and blocks that are not descended into', async () => {
  const { model } = await docWithBody(
    P(T('before'))
    + P(T('opens') + FLD('begin') + FLD('separate'))
    + P(T('inside'))
    + TBL(TR(TC(P(T('cell inside'))) + TC(P(T('closes') + FLD('end')) + P(T('cell after')))))
    + P(T('free'))
    + '<w:sdt><w:sdtContent>' + P(T('sdt opens') + FLD('begin')) + '</w:sdtContent></w:sdt>'
    + P(T('held by the sdt field'))
    + TBL('<w:sdt><w:sdtContent>' + TR(TC(P(FLD('end')))) + '</w:sdtContent></w:sdt>' + TR(TC(P(T('row after')))))
    + P(T('free again'))
    // A text box is its own story: a field left open inside it does not leak out.
    + P('<w:r><w:pict><v:textbox><w:txbxContent>' + P(FLD('begin')) + '</w:txbxContent></v:textbox></w:pict></w:r>')
    + P(T('after the text box'))
    // Outside a run the branches of AlternateContent are alternatives: fields inside cannot be followed.
    + P('<mc:AlternateContent><mc:Choice Requires="x">' + FLD('begin') + '</mc:Choice></mc:AlternateContent>')
    + P(T('cannot be trusted any more'))
    + '<w:sectPr/>');
  const state = (text) => byText(model, text).lockReason ?? 'editable';
  assert.deepStrictEqual(
    ['before', 'opens', 'inside', 'cell inside', 'closes', 'cell after', 'free', 'held by the sdt field', 'row after', 'free again', 'after the text box', 'cannot be trusted any more'].map(state),
    ['editable', 'multi-paragraph-field', 'multi-paragraph-field', 'multi-paragraph-field', 'multi-paragraph-field', 'editable', 'editable',
      'multi-paragraph-field', 'editable', 'editable', 'editable', 'unknown-content']);
  const textBox = model.blocks().find((b) => b.kind === 'paragraph' && serialize(b.el).includes('txbxContent'));
  assert.strictEqual(segs(model, textBox), '<image:Picture>');
});

test('anchors.docx: bookmark and comment range markers are anchors with pair keys', async () => {
  const { model } = open('anchors.docx');
  assert.deepStrictEqual(snapshot(model), ['p:editable', 'p:editable', 'p:editable', 'p:editable', 'bookmarkEnd:opaque', 'p:editable', 'sectPr:opaque']);
  const fox = model.blocks()[1];
  assert.strictEqual(segs(model, fox),
    '"The " ^bookmark:0/start "quick " ^comment:1/start "brown fox" ^bookmark:0/end ^comment:1/end ^comment:1 " jumps over the lazy dog near the riverbank."');
  const list = model.segments(fox);
  const anchors = list.filter((s) => s.kind === 'anchor');
  assert.deepStrictEqual(anchors.map((a) => a.node.local), ['bookmarkStart', 'commentRangeStart', 'bookmarkEnd', 'commentRangeEnd', 'r']);
  assert.match(serialize(anchors[4].node), /^<w:r><w:rPr><w:rStyle w:val="CommentReference"\/>.*<w:commentReference w:id="1"\/><\/w:r>$/);
  assert.strictEqual('role' in anchors[4], false);
  assert.strictEqual(new Set(list.map((s) => s.id)).size, list.length);
  // A bookmark that ends outside the paragraph: the start is an anchor with no partner here, the
  // end is an opaque block of the body.
  assert.strictEqual(segs(model, model.blocks()[3]), '^bookmark:4/start "Third paragraph with a whole-paragraph bookmark."');

  assert.strictEqual(
    await para('<w:permStart w:id="7" w:edGrp="everyone"/><w:moveFromRangeStart w:id="8" w:name="m"/><w:moveFromRangeEnd w:id="8"/><w:moveToRangeStart w:id="9" w:name="m"/><w:moveToRangeEnd w:id="9"/><w:permEnd w:id="7"/><w:bookmarkEnd/>'),
    '^perm:7/start ^moveFrom:8/start ^moveFrom:8/end ^moveTo:9/start ^moveTo:9/end ^perm:7/end ^?/end');
});

test('tracked.docx: w:ins/w:del/rPrChange lock', async () => {
  const { model } = open('tracked.docx');
  assert.deepStrictEqual(snapshot(model), ['p:editable', 'p:tracked-changes', 'p:tracked-changes', 'p:editable', 'sectPr:opaque']);
  assert.deepStrictEqual(model.segments(model.blocks()[1]), []);

  for (const [why, inner] of [
    ['w:ins', '<w:ins w:id="1" w:author="x">' + T('a') + '</w:ins>'],
    ['w:del', '<w:del w:id="1" w:author="x"><w:r><w:delText>a</w:delText></w:r></w:del>'],
    ['w:moveFrom', '<w:moveFrom w:id="1" w:author="x">' + T('a') + '</w:moveFrom>'],
    ['w:moveTo', '<w:moveTo w:id="1" w:author="x">' + T('a') + '</w:moveTo>'],
    ['rPrChange in a run', '<w:r><w:rPr><w:b/><w:rPrChange w:id="1" w:author="x"><w:rPr/></w:rPrChange></w:rPr><w:t>a</w:t></w:r>'],
    ['pPrChange', '<w:pPr><w:pPrChange w:id="1" w:author="x"><w:pPr/></w:pPrChange></w:pPr>' + T('a')],
    ['tracked paragraph mark', '<w:pPr><w:rPr><w:ins w:id="1" w:author="x"/></w:rPr></w:pPr>' + T('a')],
    ['tracked numbering change', '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:ins w:id="1" w:author="x"/></w:numPr></w:pPr>' + T('a')],
    ['insertion inside a hyperlink', '<w:hyperlink><w:ins w:id="1" w:author="x">' + T('a') + '</w:ins></w:hyperlink>'],
    ['revision inside a field', FLD('begin') + '<w:del w:id="1" w:author="x"><w:r><w:delInstrText>PAGE</w:delInstrText></w:r></w:del>' + FLD('end')],
    ['custom XML revision range', '<w:customXmlInsRangeStart w:id="1" w:author="x"/>' + T('a') + '<w:customXmlInsRangeEnd w:id="1"/>'],
  ]) {
    assert.strictEqual(await para(inner), 'tracked-changes', why);
  }
});

test('unknown child element locks with unknown-content', async () => {
  for (const [why, inner] of [
    ['unknown WordprocessingML element', '<w:somethingNew/>' + T('a')],
    ['foreign-namespace element', T('a') + '<wp:inline/>'],
    ['w:customXml wrapper', '<w:customXml w:element="x">' + T('a') + '</w:customXml>'],
    ['w:dir wrapper', '<w:dir w:val="rtl">' + T('a') + '</w:dir>'],
    ['w:subDoc', '<w:subDoc r:id="rId99"/>'],
    ['paragraph-level AlternateContent', '<mc:AlternateContent><mc:Choice Requires="x"/></mc:AlternateContent>'],
    ['character data directly in the paragraph', 'loose' + T('a')],
    ['XML comment', '<!-- note -->' + T('a')],
    ['processing instruction', '<?pi x?>' + T('a')],
    ['w:pPr after content', T('a') + '<w:pPr/>'],
    ['two w:pPr', '<w:pPr/><w:pPr/>' + T('a')],
  ]) {
    assert.strictEqual(await para(inner), 'unknown-content', why);
  }
  // Inline wrappers on the allow-list are single atoms; the neighbours stay editable text.
  assert.strictEqual(
    await para(T('a') + '<w:smartTag w:uri="u" w:element="e">' + T('tagged') + '</w:smartTag><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><m:oMathPara/><w:sdt><w:sdtContent/></w:sdt><w:hyperlink r:id="rId9"/>' + T('b')),
    '"a" <object:tagged> <math:Equation> <math:Equation> <object:Content control> <hyperlink:Link> "b"');
  // One unknown paragraph does not affect its neighbours, and classifyParagraph agrees in isolation.
  const { model } = await docWithBody(P(T('one')) + P('<w:somethingNew/>') + P(T('three')) + '<w:sectPr/>');
  assert.deepStrictEqual(snapshot(model), ['p:editable', 'p:unknown-content', 'p:editable', 'sectPr:opaque']);
  assert.strictEqual(isEditable(model.blocks()[1]), false);
  assert.strictEqual(classifyParagraph(model.blocks()[1].el, () => 0), 'unknown-content');
  assert.strictEqual(classifyParagraph(model.blocks()[0].el, () => 7).length, 1);
  // Unknown block-level elements are opaque blocks.
  const { model: m2 } = await docWithBody('<w:altChunk r:id="rId9"/><w:customXml>' + P(T('wrapped')) + '</w:customXml><w:somethingNew/>' + P() + '<w:sectPr/>');
  assert.deepStrictEqual(snapshot(m2), ['altChunk:opaque', 'customXml:opaque', 'somethingNew:opaque', 'p:editable', 'sectPr:opaque']);
});

test('proofErr and lastRenderedPageBreak are disposable', async () => {
  assert.strictEqual(
    await para('<w:proofErr w:type="spellStart"/>' + T('teh') + '<w:proofErr w:type="spellEnd"/>\n  <w:r><w:lastRenderedPageBreak/><w:t>next</w:t></w:r><w:r><w:rPr><w:b/></w:rPr></w:r><w:r><w:lastRenderedPageBreak/></w:r>'),
    '(d) "teh" (d) (d) (d) "next"~ (d) (d)');
  const { model } = open('fields.docx');
  const page = model.segments(model.blocks()[9]);
  assert.strictEqual(page[0].kind, 'disposable');
  assert.strictEqual(page[0].nodes[0].local, 'lastRenderedPageBreak');
  assert.strictEqual('id' in page[0], false);
  // large.docx has one in most chapters; all of them classify, none locks.
  const large = open('large.docx').model;
  assert.ok(large.blocks().every((b) => b.kind === 'opaque' || isEditable(b)));
});

// ---------------------------------------------------------------------------------------------------
// Whole-document properties

test('every docx fixture: nothing is dropped, ids are unique, the package is never touched', () => {
  let checked = 0;
  for (const name of allFixtures('docx')) {
    let pkg;
    try { pkg = OfficePackage.open(name, fixture(name)); } catch { continue; }   // encrypted, legacy, truncated
    const model = DocxModel.load(pkg);
    const ids = new Set();
    for (const b of model.blocks()) {
      assert.ok(!ids.has(b.id), `${name}: block id ${b.id} is unique`);
      ids.add(b.id);
      assert.strictEqual(model.block(b.id), b);
      assert.strictEqual(b.lockReason === undefined, b.kind === 'paragraph' && isEditable(b));
      const list = model.segments(b);
      if (!isEditable(b)) { assert.deepStrictEqual(list, [], `${name}: locked block ${b.id} offers no segments`); continue; }
      // Every child of the paragraph (w:pPr aside) is covered by exactly one run of segments, in
      // order; inside a split run every child (w:rPr aside) is covered once.
      const covered = [];
      const inRun = new Map();
      for (const s of list) {
        if (s.kind !== 'disposable') { assert.ok(!ids.has(s.id), `${name}: segment id ${s.id} is unique`); ids.add(s.id); }
        const nodes = s.kind === 'text' ? s.pieces : s.kind === 'anchor' ? [s.node] : s.nodes;
        for (const n of nodes) {
          if (n.parent === b.el) { covered.push(n); continue; }
          assert.strictEqual(n.parent.parent, b.el, `${name}: a segment node is a child of the paragraph or of one of its runs`);
          if (covered[covered.length - 1] !== n.parent) covered.push(n.parent);
          inRun.set(n.parent, [...(inRun.get(n.parent) ?? []), n]);
        }
      }
      assert.deepStrictEqual(covered, b.el.children.filter((n) => !(n.type === 'el' && n.local === 'pPr')), `${name}: block ${b.id} is fully covered`);
      for (const [run, nodes] of inRun) {
        assert.deepStrictEqual(nodes, run.children.filter((n) => n.type === 'el' && n.local !== 'rPr'), `${name}: a split run is fully covered`);
      }
    }
    assert.deepStrictEqual(pkg.touchedParts(), [], `${name}: the model touches nothing`);
    assert.strictEqual(pkg.serializesToOriginal(), true);
    assert.strictEqual(model.tableCensus(), model.loadTableCensus);
    checked++;
  }
  assert.ok(checked >= 14, `${checked} docx fixtures checked`);
});

test('refresh keeps ids of untouched blocks', () => {
  const { pkg, model } = open('multi-run.docx');
  const original = fixture('multi-run.docx');
  const before = model.blocks();
  const maxId = Math.max(...before.map((b) => b.id), ...before.flatMap((b) => model.segments(b)).map((s) => s.id ?? 0));
  const target = before[2];
  assert.strictEqual(plain(target), 'Another paragraph.');
  const segIdsOfSecond = model.segments(before[1]).map((s) => s.id);

  const eb = new EditBuilder(pkg, 'replace paragraph');
  const [created] = eb.replaceNode(model.mainPart, target.el, '<w:p><w:r><w:t>Replaced.</w:t></w:r></w:p>');
  const edit = eb.finish();
  // Until refresh the model still describes the old tree.
  assert.strictEqual(model.block(target.id).el, target.el);
  model.refresh();
  const after = model.blocks();
  assert.strictEqual(after.length, before.length);
  assert.deepStrictEqual(after.map((b) => b.id).filter((_, i) => i !== 2), before.map((b) => b.id).filter((_, i) => i !== 2));
  assert.deepStrictEqual(model.segments(after[1]).map((s) => s.id), segIdsOfSecond);
  assert.strictEqual(after[2].el, created);
  assert.ok(after[2].id > maxId, 'a new node gets a number never used before');
  assert.ok(model.segments(after[2])[0].id > maxId);
  assert.strictEqual(model.block(target.id), undefined);
  assert.strictEqual(model.idOf(created), after[2].id);
  const replacedId = after[2].id;

  // Undo brings the original node back, and with it the original id.
  applyEdit(pkg, invertEdit(edit));
  model.refresh();
  assert.deepStrictEqual(model.blocks().map((b) => b.id), before.map((b) => b.id));
  assert.strictEqual(model.blocks()[2].el, target.el);
  assertBytesEqual(pkg.serialize(), original, 'undo restores the original bytes');
  // Redo: the replacement node returns with its own id; no number is ever shared.
  applyEdit(pkg, edit);
  model.refresh();
  assert.strictEqual(model.blocks()[2].id, replacedId);
  applyEdit(pkg, invertEdit(edit));
  model.refresh();

  // carryId: a writer that replaces a paragraph element keeps the block's id (and a text segment's).
  const eb2 = new EditBuilder(pkg, 'rewrite paragraph');
  const oldSeg = model.segments(target)[0];
  const [rewritten] = eb2.replaceNode(model.mainPart, target.el, '<w:p><w:r><w:t>Another paragraph, edited.</w:t></w:r></w:p>');
  model.carryId(target.el, rewritten);
  model.carryId(oldSeg.pieces[0], rewritten.children[0].children[0]);
  const edit2 = eb2.finish();
  model.refresh();
  assert.deepStrictEqual(model.blocks().map((b) => b.id), before.map((b) => b.id));
  assert.strictEqual(model.block(target.id).el, rewritten);
  assert.strictEqual(model.segments(model.block(target.id))[0].id, oldSeg.id);
  assert.strictEqual(model.segments(model.block(target.id))[0].text, 'Another paragraph, edited.');
  applyEdit(pkg, invertEdit(edit2));
  model.refresh();
  assert.strictEqual(model.block(target.id).el, target.el);
  assertBytesEqual(pkg.serialize(), original, 'undo restores the original bytes');

  // An in-place attribute change keeps the element, so the id; inserting a paragraph shifts nothing.
  const eb3 = new EditBuilder(pkg, 'insert');
  eb3.setAttr(model.mainPart, target.el, 'http://schemas.microsoft.com/office/word/2010/wordml', 'textId', null);
  const body = model.body().el;
  eb3.insertAt(model.mainPart, body, 0, '<w:p/>');
  eb3.finish();
  model.refresh();
  const grown = model.blocks();
  assert.strictEqual(grown.length, before.length + 1);
  assert.deepStrictEqual(grown.slice(1).map((b) => b.id), before.map((b) => b.id));
  assert.ok(grown[0].id > replacedId);
  assert.deepStrictEqual(model.siblings(grown[1]), { prev: grown[0], next: grown[2] });
});

test('> 20,000 blocks → too-large', async () => {
  assert.strictEqual(LIMITS.docxMaxBlocks, 20000);
  // Exactly at the limit (19,999 paragraphs + sectPr) is still editable.
  const at = await docWithBody('<w:p/>'.repeat(19999) + '<w:sectPr/>');
  assert.strictEqual(at.model.viewOnlyReason, null);
  assert.strictEqual(at.model.blocks().length, 20000);
  const over = await docWithBody('<w:p/>'.repeat(20000) + '<w:sectPr/>');
  assert.strictEqual(over.model.viewOnlyReason, 'too-large');
  assert.deepStrictEqual(over.model.blocks(), []);
  assert.strictEqual(over.model.body(), null);
  assert.strictEqual(over.model.loadTableCensus, '');
  // Table-cell paragraphs count (§10.2), and so do the tables themselves.
  const cells = await docWithBody(TBL(TR(TC(P()).repeat(100)).repeat(200)) + '<w:sectPr/>');
  assert.strictEqual(cells.model.viewOnlyReason, 'too-large');
  const fewer = await docWithBody(TBL(TR(TC(P()).repeat(100)).repeat(199)) + '<w:sectPr/>');
  assert.strictEqual(fewer.model.viewOnlyReason, null);
  assert.strictEqual(fewer.model.blocks().length, 19902);
  // Deep nesting is walked without recursion.
  let nested = P(T('deepest'));
  for (let k = 0; k < 1500; k++) nested = TBL(TR(TC(nested + P())));
  const deep = await docWithBody(nested + '<w:sectPr/>');
  assert.strictEqual(deep.model.viewOnlyReason, null);
  assert.strictEqual(deep.model.blocks().length, 1500 * 2 + 2);
  assert.strictEqual(isEditable(byText(deep.model, 'deepest')), true);
  assert.match(deep.model.tableCensus(), /^tbl=1500;tr=1500;tc=1500\n/);
});

test('view-only documents and load failures', async () => {
  // A root that binds the WordprocessingML namespace only as the default namespace gives writers
  // no prefix for attributes: view-only.
  const noPrefix = await patchedDocx(() =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p/></body></document>');
  let m = open('noprefix.docx', noPrefix).model;
  assert.strictEqual(m.viewOnlyReason, 'unsupported-xml-layout');
  assert.deepStrictEqual(m.blocks(), []);
  assert.strictEqual(m.wPrefix, '');
  m.refresh();
  assert.deepStrictEqual(m.blocks(), []);
  assert.strictEqual(m.tableCensus(), '');

  // Another prefix is fine, and is reported.
  const other = await patchedDocx(() =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>hi</x:t></x:r></x:p><x:sectPr/></x:body></x:document>');
  m = open('x.docx', other).model;
  assert.strictEqual(m.viewOnlyReason, null);
  assert.strictEqual(m.wPrefix, 'x');
  assert.deepStrictEqual(snapshot(m), ['p:editable', 'sectPr:opaque']);
  assert.strictEqual(segs(m, m.blocks()[0]), '"hi"');

  // No w:body, or a different root element.
  const noBody = await patchedDocx((t) => t.replace(/<w:body>[\s\S]*<\/w:body>/, ''));
  assert.strictEqual(open('nobody.docx', noBody).model.viewOnlyReason, 'unsupported-xml-layout');
  const glossary = await patchedDocx((t) => t.replace('<w:document ', '<w:glossaryDocument ').replace('</w:document>', '</w:glossaryDocument>'));
  assert.strictEqual(open('glossary.docx', glossary).model.viewOnlyReason, 'unsupported-xml-layout');

  // A package that is already view-only is not parsed at all.
  const strict = await patchedDocx((t) => t.replace('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'));
  const sp = OfficePackage.open('strict.docx', strict);
  assert.strictEqual(sp.viewOnlyReason, 'strict-ooxml');
  m = DocxModel.load(sp);
  assert.strictEqual(m.viewOnlyReason, 'strict-ooxml');
  assert.deepStrictEqual(m.blocks(), []);
  assert.deepStrictEqual(m.segments({ id: 1 }), []);

  // A main part that is not well-formed is a damaged document.
  const broken = await patchedDocx((t) => t.replace('</w:body>', ''));
  const bp = OfficePackage.open('broken.docx', broken);
  assert.throws(() => DocxModel.load(bp), (e) => e.name === 'OfficeLoadError' && e.failure === 'damaged');
  await assert.rejects(DocxModel.loadAsync(bp), (e) => e.name === 'OfficeLoadError' && e.failure === 'damaged');

  // Not a Word document.
  assert.throws(() => DocxModel.load(OfficePackage.open('basic.xlsx', fixture('basic.xlsx'))), /not a Word document/);
});

test('loadAsync builds the same model (large.docx goes through the chunked parser)', async () => {
  const sync = open('large.docx').model;
  const pkg = OfficePackage.open('large.docx', fixture('large.docx'));
  const model = await DocxModel.loadAsync(pkg);
  assert.strictEqual(model.viewOnlyReason, null);
  assert.deepStrictEqual(snapshot(model), snapshot(sync));
  assert.strictEqual(model.blocks().length, 1970);
  assert.deepStrictEqual(model.blocks().map((b) => segs(model, b)), sync.blocks().map((b) => segs(sync, b)));
});

test('tableCensus: counts and property text, anywhere in the main part', async () => {
  const { pkg, model } = open('tables.docx');
  const text = model.loadTableCensus;
  assert.match(text, /^tbl=8;tr=87;tc=179\n/);
  // Rows and cells the model does not descend into (the content-control row) are counted too.
  const main = pkg.text(model.mainPart);
  for (const local of ['tblPr', 'tblGrid', 'trPr', 'tcPr']) {
    const inSource = main.split(`<w:${local}>`).length - 1;
    assert.strictEqual(text.split(`<w:${local}>`).length - 1, inSource, `every ${local} is in the census`);
  }
  assert.strictEqual(model.tableCensus(), text);

  // Editing cell text leaves it alone; touching a property, or adding a row, changes it.
  const cellPara = byText(model, 'second cell');
  const eb = new EditBuilder(pkg, 'text');
  eb.replaceNode(model.mainPart, cellPara.el, '<w:p><w:r><w:t>changed</w:t></w:r></w:p>');
  eb.finish();
  model.refresh();
  assert.strictEqual(model.tableCensus(), text);
  assert.strictEqual(model.loadTableCensus, text);

  const tc = byText(model, 'changed').container.el;
  const tcW = tc.children[0].children[0];
  assert.strictEqual(tcW.local, 'tcW');
  const eb2 = new EditBuilder(pkg, 'width');
  eb2.setAttr(model.mainPart, tcW, NS_W, 'w', '1');
  const widen = eb2.finish();
  assert.notStrictEqual(model.tableCensus(), text);
  applyEdit(pkg, invertEdit(widen));
  assert.strictEqual(model.tableCensus(), text);

  const tr = tc.parent;
  const eb3 = new EditBuilder(pkg, 'row');
  eb3.insertAt(model.mainPart, tr.parent, tr.parent.children.indexOf(tr), '<w:tr><w:tc><w:p/></w:tc></w:tr>');
  eb3.finish();
  assert.match(model.tableCensus(), /^tbl=8;tr=88;tc=180\n/);
  assert.strictEqual(model.loadTableCensus, text);
});
