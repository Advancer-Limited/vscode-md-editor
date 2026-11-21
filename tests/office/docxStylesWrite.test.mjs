// WP-30: styles and lists, write side (src/office/core/docx/stylesWrite.ts). Spec §8.6, plan WP-30
// (exact markup), §13.2 G3/G5/G6.
//
// Every operation goes through `apply()` (so through `applyDocxEdit`), which asserts for the edit:
//   G3  exactly the parts named in `touched` differ from the bytes before the operation, and the
//       edit records changes in exactly those parts;
//   G5  undo serialises to the bytes before the operation, redo to the bytes after it, and the
//       blocks keep their ids;
//   G6  the output passes packageValidator + docxValidator, every touched XML part is well-formed
//       for an independent parser (saxes), and an independent reload reads the same styles and lists;
//   the paragraphs read the same text as before; the table census is unchanged.
// Outputs go to tests/.out/docxStyles/ for scripts/verify-office-open.ps1 -Kind Word.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { core, fixture, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG5 } from './_roundtrip.mjs';

const require = createRequire(import.meta.url);
const { SaxesParser } = require('saxes');

const { OfficePackage } = core.pkg;
const { DocxModel, isEditable, paragraphProps } = core.docx.model;
const { DocxStyles } = core.docx.styles;
const { DocxNumbering } = core.docx.numbering;
const { applyEdit, invertEdit } = core.edits;
const { serialize } = core.xml;
const { serializeAndVerify, packageValidator } = core.save;
const { docxValidator } = core.docx.validate;
const { applyDocxEdit, blockInfos } = core.docx.ops;
const SW = core.docx.stylesWrite;

const OUT = 'docxStyles';
const MAIN = 'word/document.xml';
const STYLES = 'word/styles.xml';
const NUMBERING = 'word/numbering.xml';
const RELS = 'word/_rels/document.xml.rels';
const TYPES = '[Content_Types].xml';
const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ---------------------------------------------------------------------------------------------------
// Harness

function open(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  const model = DocxModel.load(pkg);
  const styles = DocxStyles.load(pkg, model.mainPart);
  const numbering = DocxNumbering.load(pkg, model.mainPart);
  return { name, pkg, model, styles, numbering, orig: bytes, edits: [] };
}

/** `from` with `fns[part](text)` applied to each named part (a null result removes the part). */
async function patched(from, fns) {
  const zip = await JSZip.loadAsync(fixture(from));
  for (const [part, fn] of Object.entries(fns)) {
    const f = zip.file(part);
    const next = fn(f ? await f.async('string') : null);
    if (next === null) zip.remove(part); else zip.file(part, next);
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** A document whose body is `bodyXml` + the final sectPr of `from`. */
async function docWithBody(bodyXml, from = 'basic.docx', more = {}) {
  return open('synthetic.docx', await patched(from, {
    [MAIN]: (t) => {
      const a = t.indexOf('<w:body>');
      const b = t.lastIndexOf('<w:sectPr');
      assert.ok(a > 0 && b > a);
      return t.slice(0, a + 8) + bodyXml + t.slice(b);
    },
    ...more,
  }));
}

/** styles.xml without the paragraph styles named `heading N` / `List Paragraph` and their linked character styles. */
function stripStyles(t, { headings = true, listParagraph = false } = {}) {
  const drop = (re) => { t = t.replace(/<w:style [^>]*>.*?<\/w:style>/gs, (s) => (re.test(s) ? '' : s)); };
  if (headings) drop(/<w:name w:val="heading \d"\/>|<w:name w:val="Heading \d Char"\/>/i);
  if (listParagraph) drop(/<w:name w:val="List Paragraph"\/>/);
  return t;
}

function saxesOk(text, what) {
  const p = new SaxesParser({ xmlns: true });
  let error = null;
  p.on('error', (e) => { error ??= e; });
  p.write(text).close();
  assert.strictEqual(error, null, `saxes (${what}): ${error && error.message}`);
}

const textOf = (ctx, b) => ctx.model.segments(b).map((s) => (s.kind === 'text' ? s.text : s.kind === 'atom' ? '\uFFFC' : '')).join('');
const reading = (ctx) => ctx.model.blocks().map((b) => (isEditable(b) ? 'P:' + textOf(ctx, b) : `X:${b.el.rawName}`));

function byText(ctx, text, nth = 0) {
  const hits = ctx.model.blocks().filter((b) => isEditable(b) && textOf(ctx, b) === text);
  assert.ok(hits.length > nth, `an editable paragraph reads "${text}"`);
  return hits[nth];
}
const ids = (ctx, ...texts) => texts.map((t) => byText(ctx, t).id);
const pXml = (ctx, id) => serialize(ctx.model.block(id).el);
const info = (ctx, id) => blockInfos(ctx).find((i) => i.id === id);
const numPrOf = (ctx, id) => paragraphProps(ctx.model.block(id).el).numPr;
const styleOf = (ctx, id) => paragraphProps(ctx.model.block(id).el).pStyleId;
const partText = (ctx, part) => serialize(ctx.pkg.xml(part));
const count = (text, needle) => text.split(needle).length - 1;
const anon = (infos) => infos.map(({ id, parentId, ...rest }) => rest);

function refreshAll(ctx) {
  ctx.styles.reload();
  ctx.numbering.reload();
  ctx.model.refresh();
}

/**
 * Apply `op` and assert everything in the header. `touched`: the parts this operation changes
 * (default: the main part only). Returns `{ out, edit, bytes }`; `edit` is null for a no-op.
 */
function apply(ctx, op, touched = [MAIN]) {
  const { pkg, model } = ctx;
  const beforeBytes = pkg.serialize();
  const beforeReading = reading(ctx);
  const beforeInfos = blockInfos(ctx);
  const census = model.tableCensus();

  const out = applyDocxEdit(ctx, op);
  if (!out.ok || out.edit === null) {
    assertBytesEqual(pkg.serialize(), beforeBytes, 'nothing changed');
    refreshAll(ctx);
    assert.deepStrictEqual(blockInfos(ctx), beforeInfos, 'the model reads the same');
    return { out, edit: null, bytes: beforeBytes };
  }
  const edit = out.edit;
  const lower = (a) => a.map((p) => p.toLowerCase()).sort();
  assert.deepStrictEqual(lower([...new Set(edit.changes.map((c) => c.part))]), lower(touched), 'the edit changes exactly the expected parts');
  assert.deepStrictEqual(reading(ctx), beforeReading, 'no text changed and no block was added or removed');
  assert.strictEqual(model.tableCensus(), census, 'table census unchanged');
  const infos = blockInfos(ctx);
  const live = new Set(infos.map((i) => i.id));
  for (const id of out.changedBlockIds) assert.ok(live.has(id), `changedBlockIds names a live block (${id})`);
  // What ops.ts refreshed is what a full reload of the read models gives.
  refreshAll(ctx);
  assert.deepStrictEqual(blockInfos(ctx), infos, 'applyDocxEdit left styles, numbering and the model up to date');

  const bytes = pkg.serialize();
  assertG3(beforeBytes, bytes, touched);
  for (const part of touched) if (pkg.has(part)) saxesOk(pkg.text(part), part);
  assertG5(pkg, edit, beforeBytes);
  refreshAll(ctx);
  assert.deepStrictEqual(blockInfos(ctx), infos, 'undo then redo brings back the same blocks with the same ids');

  const v = serializeAndVerify(pkg, [packageValidator, docxValidator]);
  assert.ok(v.ok, `${op.op}: validators: ${v.ok ? '' : JSON.stringify(v.failures)}`);
  assertBytesEqual(v.bytes, bytes, 'verified bytes are the serialised bytes');
  const re = open('reload.docx', bytes);
  assert.deepStrictEqual(reading(re), beforeReading, 'reload reads the same text');
  assert.deepStrictEqual(anon(blockInfos(re)), anon(infos), 'reload reads the same styles and lists');
  ctx.edits.push(edit);
  return { out, edit, bytes };
}

function refused(ctx, op, code, re) {
  const { out } = apply(ctx, op);
  assert.strictEqual(out.ok, false, `${op.op} must be refused`);
  assert.strictEqual(out.error.code, code, out.error.message);
  if (re) assert.match(out.error.message, re);
}

function noop(ctx, op) {
  const { out } = apply(ctx, op);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.strictEqual(out.edit, null, `${op.op} changes nothing`);
}

/** Undo every edit made through `apply`: the file as opened, byte for byte. */
function undoAll(ctx) {
  for (let k = ctx.edits.length - 1; k >= 0; k--) applyEdit(ctx.pkg, invertEdit(ctx.edits[k]));
  ctx.edits.length = 0;
  refreshAll(ctx);
  assertBytesEqual(ctx.pkg.serialize(), ctx.orig, 'undo of everything is the original file');
}

const setStyle = (blockIds, style) => ({ op: 'setStyle', blockIds, style });
const setList = (blockIds, list) => ({ op: 'setList', blockIds, list });
const setLevel = (blockIds, delta) => ({ op: 'setListLevel', blockIds, delta });
const numPr = (numId, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

// The markup of plan WP-30, written out independently of the code under test.
const HEADING1 = '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>';
const HEADING4 = '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:i/><w:iCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>';
const LIST_PARAGRAPH = '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>';

function expectedAbstract(id, kind) {
  const glyphs = [['\uF0B7', 'Symbol'], ['o', 'Courier New'], ['\uF0A7', 'Wingdings']];
  const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  let s = `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/><w:name w:val="${kind === 'bullet' ? 'VSMDBullet' : 'VSMDNumber'}"/>`;
  for (let k = 0; k < 9; k++) {
    s += `<w:lvl w:ilvl="${k}"><w:start w:val="1"/>`;
    s += kind === 'bullet'
      ? `<w:numFmt w:val="bullet"/><w:lvlText w:val="${glyphs[k % 3][0]}"/>`
      : `<w:numFmt w:val="${fmts[k % 3]}"/><w:lvlText w:val="%${k + 1}."/>`;
    s += `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (k + 1)}" w:hanging="360"/></w:pPr>`;
    if (kind === 'bullet') s += `<w:rPr><w:rFonts w:ascii="${glyphs[k % 3][1]}" w:hAnsi="${glyphs[k % 3][1]}" w:hint="default"/></w:rPr>`;
    s += '</w:lvl>';
  }
  return s + '</w:abstractNum>';
}
const NUM_PLAIN = (m, a) => `<w:num w:numId="${m}"><w:abstractNumId w:val="${a}"/></w:num>`;
const NUM_RESTART = (m, a) => `<w:num w:numId="${m}"><w:abstractNumId w:val="${a}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;

/** In numbering.xml every w:abstractNum precedes every w:num; ids are unique. */
function assertNumberingOrder(ctx) {
  const t = partText(ctx, ctx.numbering.part);
  const lastAbs = t.lastIndexOf('<w:abstractNum ');
  const firstNum = t.indexOf('<w:num ');
  if (firstNum >= 0) assert.ok(lastAbs < firstNum, 'abstractNums precede nums');
  const uniq = (re) => { const all = [...t.matchAll(re)].map((m) => m[1]); assert.strictEqual(new Set(all).size, all.length, `${re} ids unique`); };
  uniq(/<w:abstractNum w:abstractNumId="(\d+)"/g);
  uniq(/<w:num w:numId="(\d+)"/g);
}

// ---------------------------------------------------------------------------------------------------
// Styles

test('setStyle replaces only w:pStyle; creates pPr as first child when absent; Normal removes it', async () => {
  const ctx = open('basic.docx');
  const [plain] = ids(ctx, 'A plain paragraph with ordinary text.');
  const original = pXml(ctx, plain);
  assert.ok(!original.includes('<w:pPr>'));
  const r = apply(ctx, setStyle([plain], { heading: 2 }));
  assert.strictEqual(r.edit.label, 'Change Style');
  assert.deepStrictEqual(r.out.changedBlockIds, [plain]);
  assert.strictEqual(pXml(ctx, plain), original.replace('<w:r>', '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r>'), 'pPr is the first child; paraId, textId and runs are untouched');
  assert.deepStrictEqual(info(ctx, plain).style, { kind: 'heading', level: 2, name: 'heading 2' });
  noop(ctx, setStyle([plain], { heading: 2 }));
  // An existing pStyle is replaced in place.
  apply(ctx, setStyle([plain], { heading: 3 }));
  assert.strictEqual(pXml(ctx, plain), original.replace('<w:r>', '<w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r>'));
  writeOut(OUT, 'style-heading.docx', ctx.pkg.serialize());
  // Normal removes it, and with it the now empty pPr: the paragraph is the original text again.
  apply(ctx, setStyle([plain], 'normal'));
  assert.strictEqual(pXml(ctx, plain), original);
  noop(ctx, setStyle([plain], 'normal'));
  // A list item made a heading keeps its numbering (direct formatting is left alone).
  const [bullet] = ids(ctx, 'Bullet two');
  apply(ctx, setStyle([bullet], { heading: 1 }));
  assert.match(pXml(ctx, bullet), /<w:pPr><w:pStyle w:val="Heading1"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr>/);
  assert.strictEqual(info(ctx, bullet).list.kind, 'bullet');
  undoAll(ctx);

  // Other properties keep their text and order; pStyle goes first.
  const syn = await docWithBody(
    '<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="right"/></w:pPr><w:r><w:t>two</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="0"/></w:pPr><w:r><w:t>three</w:t></w:r></w:p>');
  const [one, two, three] = ids(syn, 'one', 'two', 'three');
  apply(syn, setStyle([one], { heading: 1 }));
  assert.strictEqual(pXml(syn, one), '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>');
  apply(syn, setStyle([one], 'normal'));
  assert.strictEqual(pXml(syn, one), '<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>');
  noop(syn, setStyle([two], 'normal'));                       // names the default style: already Normal
  apply(syn, setStyle([three], 'normal'));
  assert.strictEqual(pXml(syn, three), '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:t>three</w:t></w:r></w:p>');
  writeOut(OUT, 'style-synthetic.docx', syn.pkg.serialize());
});

test('heading style created in no-heading-styles.docx matches the plan markup character for character and is found again by name on reload', async () => {
  const bytes = await patched('no-heading-styles.docx', { [STYLES]: (t) => stripStyles(t) });
  const ctx = open('no-headings.docx', bytes);
  assert.strictEqual(ctx.styles.headingStyleId(1), null, 'the fixture has no heading styles once stripped');
  const stylesBefore = partText(ctx, STYLES);
  const [p1, p2, p3] = ids(ctx, 'Plain paragraph one. No heading styles are used anywhere in this document.', 'Plain paragraph two.', 'Plain paragraph three.');

  const r = apply(ctx, setStyle([p1], { heading: 1 }), [MAIN, STYLES]);
  assert.strictEqual(partText(ctx, STYLES), stylesBefore.replace('</w:styles>', HEADING1 + '</w:styles>'), 'appended as the last child of w:styles, nothing else changed');
  assert.strictEqual(SW.headingStyleXml('w', 'Heading1', 1, 'Normal'), HEADING1);
  assert.strictEqual(SW.headingStyleXml('w', 'Heading4', 4, 'Normal'), HEADING4);
  assert.strictEqual(styleOf(ctx, p1), 'Heading1');
  assert.deepStrictEqual(info(ctx, p1).style, { kind: 'heading', level: 1, name: 'heading 1' });
  const re = open('reload.docx', r.bytes);
  assert.strictEqual(re.styles.headingStyleId(1), 'Heading1', 'found again by name');
  // The second use reuses it: styles.xml is not touched again.
  apply(ctx, setStyle([p2], { heading: 1 }));
  assert.strictEqual(count(partText(ctx, STYLES), 'w:val="heading 1"'), 1);
  // One operation over several blocks creates the style once.
  apply(ctx, setStyle([p2, p3], { heading: 4 }), [MAIN, STYLES]);
  assert.ok(partText(ctx, STYLES).endsWith(HEADING1 + HEADING4 + '</w:styles>'));
  assert.deepStrictEqual([styleOf(ctx, p2), styleOf(ctx, p3)], ['Heading4', 'Heading4']);
  // Every other level, against the plan's table.
  const sizes = { 2: 26, 3: 24, 5: 22, 6: 22 };
  for (const [n, size] of Object.entries(sizes)) {
    const level = Number(n);
    apply(ctx, setStyle([p3], { heading: level }), [MAIN, STYLES]);
    const made = partText(ctx, STYLES).match(new RegExp(`<w:style w:type="paragraph" w:styleId="Heading${n}">.*?</w:style>`))[0];
    assert.ok(made.includes(`<w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`));
    assert.ok(made.includes(`<w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="${level - 1}"/>`));
    assert.ok(made.includes(`${level === 6 ? '<w:i/><w:iCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`));
    assert.strictEqual(made.includes('<w:i/>'), level === 6);
    assert.deepStrictEqual(info(ctx, p3).style, { kind: 'heading', level, name: `heading ${n}` });
  }
  writeOut(OUT, 'headings-created.docx', ctx.pkg.serialize());
  undoAll(ctx);

  // A taken id gets a suffix; no default paragraph style means no basedOn/next.
  const odd = open('odd.docx', await patched('no-heading-styles.docx', {
    [STYLES]: (t) => stripStyles(t)
      .replace('</w:styles>', '<w:style w:type="character" w:styleId="heading3"><w:name w:val="Odd"/></w:style><w:style w:type="character" w:styleId="Heading3_2"><w:name w:val="Odder"/></w:style></w:styles>')
      .replace('<w:style w:type="paragraph" w:default="1" w:styleId="Normal">', '<w:style w:type="paragraph" w:styleId="Normal">'),
  }));
  const [o] = ids(odd, 'Plain paragraph two.');
  apply(odd, setStyle([o], { heading: 3 }), [MAIN, STYLES]);
  assert.strictEqual(styleOf(odd, o), 'Heading3_3');
  assert.ok(partText(odd, STYLES).endsWith('<w:style w:type="paragraph" w:styleId="Heading3_3"><w:name w:val="heading 3"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>'));
  assert.strictEqual(info(odd, o).style.kind, 'heading');
  writeOut(OUT, 'heading-suffixed.docx', odd.pkg.serialize());
});

test('a style sheet bound to another prefix gets its styles in that prefix', async () => {
  const ctx = open('prefixed.docx', await patched('no-heading-styles.docx', {
    [STYLES]: (t) => stripStyles(t, { listParagraph: true }).replace(/xmlns:w=/g, 'xmlns:ww=').replace(/([<\/ ])w:/g, '$1ww:'),
  }));
  assert.strictEqual(ctx.styles.damaged, false);
  assert.strictEqual(ctx.styles.defaultParagraphStyleId(), 'Normal');
  const [p, q] = ids(ctx, 'Plain paragraph two.', 'Plain paragraph three.');
  apply(ctx, setStyle([p], { heading: 2 }), [MAIN, STYLES]);
  assert.ok(partText(ctx, STYLES).endsWith('<ww:sz ww:val="26"/><ww:szCs ww:val="26"/></ww:rPr></ww:style></ww:styles>'));
  assert.strictEqual(pXml(ctx, p).includes('<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'), true, 'the paragraph uses the main part prefix');
  apply(ctx, setList([q], 'bullet'), [MAIN, STYLES, NUMBERING, RELS, TYPES]);
  assert.ok(partText(ctx, STYLES).endsWith(LIST_PARAGRAPH.replace(/([<\/ ])w:/g, '$1ww:') + '</ww:styles>'));
  assert.deepStrictEqual(info(ctx, q).style, { kind: 'other', name: 'List Paragraph' });
  writeOut(OUT, 'styles-other-prefix.docx', ctx.pkg.serialize());
  undoAll(ctx);
});

test('existing localised heading style is reused, not duplicated', () => {
  const ctx = open('localised-de.synthetic.docx');
  const stylesBefore = partText(ctx, STYLES);
  const [plain, h1] = ids(ctx, 'A plain paragraph with ordinary text.', 'Heading One');
  apply(ctx, setStyle([plain], { heading: 2 }));               // main part only
  assert.strictEqual(styleOf(ctx, plain), 'berschrift2');
  assert.deepStrictEqual(info(ctx, plain).style, { kind: 'heading', level: 2, name: 'heading 2' });
  noop(ctx, setStyle([h1], { heading: 1 }));
  apply(ctx, setStyle([h1, plain], { heading: 6 }));
  assert.deepStrictEqual([styleOf(ctx, h1), styleOf(ctx, plain)], ['berschrift6', 'berschrift6']);
  assert.strictEqual(partText(ctx, STYLES), stylesBefore);
  assert.deepStrictEqual(ctx.pkg.touchedParts(), [MAIN]);
  writeOut(OUT, 'localised-heading.docx', ctx.pkg.serialize());
  undoAll(ctx);
});

test('no style sheet: heading and list-on are refused, nothing is created; Normal and list off still work', async () => {
  const ctx = open('no-styles.docx', await patched('basic.docx', {
    [STYLES]: () => null,
    [RELS]: (t) => t.replace(/<Relationship [^>]*relationships\/styles"[^>]*\/>/, ''),
    [TYPES]: (t) => t.replace(/<Override PartName="\/word\/styles.xml"[^>]*\/>/, ''),
  }));
  assert.strictEqual(ctx.styles.part, null);
  const [plain, bullet] = ids(ctx, 'A plain paragraph with ordinary text.', 'Bullet one');
  refused(ctx, setStyle([plain], { heading: 1 }), 'blocked', /no style sheet/);
  refused(ctx, setList([plain], 'bullet'), 'blocked', /no style sheet/);
  refused(ctx, setList([plain], 'number'), 'blocked', /no style sheet/);
  assert.deepStrictEqual(ctx.pkg.touchedParts(), []);
  // (The validator's own complaints about this broken input are the input's, so only bytes are checked.)
  let out = applyDocxEdit(ctx, setLevel([bullet], 1));
  assert.ok(out.ok && out.edit === null, 'a single-level list: nowhere to indent to, but not an error');
  out = applyDocxEdit(ctx, setList([bullet], 'none'));
  assert.ok(out.ok && out.edit);
  assert.strictEqual(numPrOf(ctx, bullet), null);
  out = applyDocxEdit(ctx, setStyle([bullet], 'normal'));
  assert.ok(out.ok && out.edit);
  assert.strictEqual(styleOf(ctx, bullet), null);

  const damaged = open('damaged-styles.docx', await patched('basic.docx', { [STYLES]: () => '<?xml version="1.0"?><nope/>' }));
  assert.strictEqual(damaged.styles.damaged, true);
  const [d] = ids(damaged, 'A plain paragraph with ordinary text.');
  refused(damaged, setStyle([d], { heading: 1 }), 'blocked', /style sheet/);
  refused(damaged, setList([d], 'bullet'), 'blocked', /style sheet/);
});

// ---------------------------------------------------------------------------------------------------
// Lists

test('bullets join an adjacent Word list (same numId/ilvl); numbers join too; no definition is added', async () => {
  const ctx = open('basic.docx');
  const [h3, final] = ids(ctx, 'Heading Three', 'Final paragraph.');
  // Next block is "Bullet one" (numId 1): joined. The paragraph has a style, so it keeps it.
  apply(ctx, setList([h3], 'bullet'));
  assert.match(pXml(ctx, h3), new RegExp(`<w:pPr><w:pStyle w:val="Heading3"/>${numPr(1)}</w:pPr>`));
  assert.deepStrictEqual(info(ctx, h3).list, { kind: 'bullet', level: 0 });
  // Previous block is "Step three" (numId 2): joined; no style, so List Paragraph.
  const r = apply(ctx, setList([final], 'number'));
  assert.strictEqual(r.edit.label, 'Change List');
  assert.match(pXml(ctx, final), new RegExp(`<w:pPr><w:pStyle w:val="ListParagraph"/>${numPr(2)}</w:pPr><w:r>`));
  assert.deepStrictEqual(info(ctx, final), { ...info(ctx, final), style: { kind: 'other', name: 'List Paragraph' }, list: { kind: 'number', level: 0 } });
  noop(ctx, setList([final], 'number'));
  assert.deepStrictEqual(ctx.pkg.touchedParts(), [MAIN], 'numbering.xml and styles.xml are untouched');
  writeOut(OUT, 'list-joined.docx', ctx.pkg.serialize());
  undoAll(ctx);

  // The level of the joined item is taken; an item that changes kind keeps its own level where
  // the joined list defines it (the fixture's Word lists are single-level: level 0 only).
  const syn = await docWithBody(
    '<w:p><w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p>'
    + `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>${numPr(2)}</w:pPr><w:r><w:t>num</w:t></w:r></w:p><w:p><w:r><w:t>d</w:t></w:r></w:p>`);
  const [a, b, c, d] = ids(syn, 'a', 'b', 'c', 'd');
  apply(syn, setList([a], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(syn, a), { numId: 3, ilvl: 0 });
  apply(syn, setLevel([a], 1));
  apply(syn, setLevel([a], 1));
  apply(syn, setList([b], 'bullet'));
  assert.deepStrictEqual(numPrOf(syn, b), { numId: 3, ilvl: 2 }, 'joins "a" at its level');
  // "c": the previous block is a bullet, the next a numbered item. Numbering joins the next.
  apply(syn, setList([c], 'number'));
  assert.deepStrictEqual(numPrOf(syn, c), { numId: 2, ilvl: 0 });
  // "b" (bullet, level 2) to numbers: joins "c"; that Word list has no level 2, so level 0.
  apply(syn, setList([b], 'number'));
  assert.deepStrictEqual(numPrOf(syn, b), { numId: 2, ilvl: 0 });
  assert.deepStrictEqual(info(syn, b).list, { kind: 'number', level: 0 });
  // "d" joins the Word list before it.
  apply(syn, setList([d], 'number'));
  assert.deepStrictEqual(numPrOf(syn, d), { numId: 2, ilvl: 0 });
  writeOut(OUT, 'list-joined-levels.docx', syn.pkg.serialize());
});

test('new numbered list gets a new num with startOverride; a second separate list restarts at 1; bullets share one num; abstractNums precede nums', () => {
  const ctx = open('basic.docx');
  const numberingBefore = partText(ctx, NUMBERING);
  const [title, plain, mixed, h1] = ids(ctx, 'Fixture Basic', 'A plain paragraph with ordinary text.', 'This paragraph has bold, italic and underlined text.', 'Heading One');
  assert.deepStrictEqual([ctx.numbering.maxAbstractNumId(), ctx.numbering.maxNumId()], [1, 2]);

  apply(ctx, setList([plain], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, plain), { numId: 3, ilvl: 0 });
  assert.strictEqual(styleOf(ctx, plain), 'ListParagraph', 'the existing List Paragraph style is used');
  let t = partText(ctx, NUMBERING);
  assert.ok(t.includes('</w:abstractNum>' + expectedAbstract(2, 'number') + '<w:num w:numId="1"'), 'the definition goes after the last abstractNum, before the first num');
  assert.ok(t.endsWith(NUM_RESTART(3, 2) + '</w:numbering>'), 'the num goes after the last num');
  assert.strictEqual(t.length, numberingBefore.length + expectedAbstract(2, 'number').length + NUM_RESTART(3, 2).length, 'nothing else changed');
  assert.strictEqual(SW.abstractNumXml('w', 2, 'number'), expectedAbstract(2, 'number'));
  assertNumberingOrder(ctx);
  assert.deepStrictEqual(info(ctx, plain).list, { kind: 'number', level: 0 });

  // A second, separate numbered list: the definition is reused, the num is new and restarts.
  apply(ctx, setList([mixed], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, mixed), { numId: 4, ilvl: 0 });
  t = partText(ctx, NUMBERING);
  assert.ok(t.endsWith(NUM_RESTART(3, 2) + NUM_RESTART(4, 2) + '</w:numbering>'));
  assert.strictEqual(count(t, 'VSMDNumber'), 1);

  // Bullets: one definition, one shared num.
  apply(ctx, setList([title], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, title), { numId: 5, ilvl: 0 });
  assert.strictEqual(styleOf(ctx, title), 'Title', 'a styled paragraph keeps its style');
  t = partText(ctx, NUMBERING);
  assert.ok(t.includes(expectedAbstract(2, 'number') + expectedAbstract(3, 'bullet') + '<w:num w:numId="1"'));
  assert.ok(t.endsWith(NUM_RESTART(4, 2) + NUM_PLAIN(5, 3) + '</w:numbering>'));
  assert.strictEqual(SW.abstractNumXml('w', 3, 'bullet'), expectedAbstract(3, 'bullet'));
  // "Heading One" sits between the bullet title and the numbered paragraph: bullets join the title.
  apply(ctx, setList([h1], 'bullet'));
  assert.deepStrictEqual(numPrOf(ctx, h1), { numId: 5, ilvl: 0 });
  // A bullet somewhere else uses the shared num too, without touching numbering.xml.
  const [final] = ids(ctx, 'Final paragraph.');
  apply(ctx, setList([final], 'bullet'));
  assert.deepStrictEqual(numPrOf(ctx, final), { numId: 5, ilvl: 0 });
  assert.strictEqual(count(partText(ctx, NUMBERING), 'VSMDBullet'), 1);
  assertNumberingOrder(ctx);
  assert.deepStrictEqual(info(ctx, final).list, { kind: 'bullet', level: 0 });
  writeOut(OUT, 'lists-new.docx', ctx.pkg.serialize());
  undoAll(ctx);
});

test('numbering.xml, relationship and Override created from nothing (no-numbering.docx); touched set asserted exactly (G3)', async () => {
  const ctx = open('no-numbering.docx');
  assert.strictEqual(ctx.numbering.part, null);
  assert.ok(!ctx.pkg.has(NUMBERING));
  const [h, p] = ids(ctx, 'No numbering document', 'This document has no lists, so no numbering part is written.');
  const relsBefore = ctx.pkg.text(RELS);
  const typesBefore = ctx.pkg.text(TYPES);

  const r = apply(ctx, setList([p], 'bullet'), [MAIN, NUMBERING, RELS, TYPES]);
  assert.strictEqual(ctx.pkg.text(NUMBERING), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<w:numbering xmlns:w="${NS}">${expectedAbstract(0, 'bullet')}${NUM_PLAIN(1, 0)}</w:numbering>`);
  assert.strictEqual(ctx.pkg.text(RELS), relsBefore.replace('</Relationships>',
    '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>'));
  assert.strictEqual(ctx.pkg.text(TYPES).length, typesBefore.length + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'.length);
  assert.ok(ctx.pkg.text(TYPES).includes('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'));
  assert.strictEqual(ctx.numbering.part, NUMBERING, 'applyDocxEdit reloaded the numbering model');
  assert.match(pXml(ctx, p), new RegExp(`<w:pPr><w:pStyle w:val="ListParagraph"/>${numPr(1)}</w:pPr>`));
  assert.deepStrictEqual(info(ctx, p).list, { kind: 'bullet', level: 0 });
  const re = open('reload.docx', r.bytes);
  assert.strictEqual(re.numbering.part, NUMBERING);
  assert.strictEqual(re.numbering.findOwnAbstract('bullet'), 0);
  writeOut(OUT, 'numbering-created-bullet.docx', r.bytes);

  // Next operation: the part exists now and is edited in place.
  apply(ctx, setList([h], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, h), { numId: 2, ilvl: 0 });
  assert.ok(ctx.pkg.text(NUMBERING).endsWith(expectedAbstract(0, 'bullet') + expectedAbstract(1, 'number') + NUM_PLAIN(1, 0) + NUM_RESTART(2, 1) + '</w:numbering>'));
  assertNumberingOrder(ctx);
  writeOut(OUT, 'numbering-created-both.docx', ctx.pkg.serialize());
  undoAll(ctx);
  assert.ok(!ctx.pkg.has(NUMBERING), 'undo removes the part again');

  // Created with a numbered list first, and with the List Paragraph style missing: five parts.
  const bare = open('bare.docx', await patched('no-numbering.docx', { [STYLES]: (t) => stripStyles(t, { headings: false, listParagraph: true }) }));
  assert.strictEqual(bare.styles.listParagraphStyleId(), null);
  const stylesBefore = partText(bare, STYLES);
  const [bp] = ids(bare, 'This document has no lists, so no numbering part is written.');
  const br = apply(bare, setList([bp], 'number'), [MAIN, STYLES, NUMBERING, RELS, TYPES]);
  assert.strictEqual(bare.pkg.text(NUMBERING), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<w:numbering xmlns:w="${NS}">${expectedAbstract(0, 'number')}${NUM_RESTART(1, 0)}</w:numbering>`);
  assert.strictEqual(partText(bare, STYLES), stylesBefore.replace('</w:styles>', LIST_PARAGRAPH + '</w:styles>'));
  assert.strictEqual(SW.listParagraphStyleXml('w', 'ListParagraph', 'Normal'), LIST_PARAGRAPH);
  assert.strictEqual(open('reload.docx', br.bytes).styles.listParagraphStyleId(), 'ListParagraph');
  assert.deepStrictEqual(info(bare, bp), { ...info(bare, bp), style: { kind: 'other', name: 'List Paragraph' }, list: { kind: 'number', level: 0 } });
  writeOut(OUT, 'numbering-and-list-style-created.docx', br.bytes);
  undoAll(bare);
});

test('list off: numPr removed, or numId 0 when inherited from the style; List Paragraph pStyle removed', async () => {
  const ctx = open('basic.docx');
  const [b2, plain] = ids(ctx, 'Bullet two', 'A plain paragraph with ordinary text.');
  apply(ctx, setList([b2], 'none'));
  assert.match(pXml(ctx, b2), /^<w:p w14:paraId="50FF5658" w14:textId="6EA06028"><w:r><w:t>Bullet two<\/w:t><\/w:r><\/w:p>$/, 'numPr, the List Paragraph style and the empty pPr are gone');
  assert.deepStrictEqual(info(ctx, b2), { ...info(ctx, b2), style: { kind: 'normal', name: 'Normal' }, list: { kind: 'none', level: 0 } });
  noop(ctx, setList([b2], 'none'));
  noop(ctx, setList([plain], 'none'));
  assert.deepStrictEqual(ctx.pkg.touchedParts(), [MAIN]);
  writeOut(OUT, 'list-off.docx', ctx.pkg.serialize());
  undoAll(ctx);

  // Other styles and properties stay; only numPr goes.
  const syn = await docWithBody(
    `<w:p><w:pPr><w:pStyle w:val="Title"/><w:keepNext/>${numPr(2, 1)}<w:jc w:val="center"/></w:pPr><w:r><w:t>one</w:t></w:r></w:p>`
    + `<w:p><w:pPr>${numPr(99)}</w:pPr><w:r><w:t>dangling</w:t></w:r></w:p>`
    + '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>styled only</w:t></w:r></w:p>');
  const [one, styledOnly] = ids(syn, 'one', 'styled only');
  apply(syn, setList([one], 'none'));
  assert.strictEqual(pXml(syn, one), '<w:p><w:pPr><w:pStyle w:val="Title"/><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:t>one</w:t></w:r></w:p>');
  // A numPr naming a list that does not exist reads as "no list" and is still removed. (The
  // dangling numId is the input's own problem, so this one is applied without the validators.)
  const dangling = byText(syn, 'dangling').id;
  const out = applyDocxEdit(syn, setList([dangling], 'none'));
  assert.ok(out.ok && out.edit);
  assert.strictEqual(pXml(syn, dangling), '<w:p><w:r><w:t>dangling</w:t></w:r></w:p>');
  apply(syn, setList([styledOnly], 'none'));
  assert.strictEqual(pXml(syn, styledOnly), '<w:p><w:r><w:t>styled only</w:t></w:r></w:p>');

  // Numbering that comes from the style can only be switched off: numId 0.
  const s = open('style-numbered.docx', await patched('basic.docx', {
    [STYLES]: (t) => t.replace(/(w:styleId="Quote">.*?<w:pPr>)/, '$1<w:numPr><w:numId w:val="1"/></w:numPr>'),
    [MAIN]: (t) => t.replace(/<w:p [^>]*><w:r><w:t>Final paragraph\.<\/w:t><\/w:r><\/w:p>/, '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Quoted.</w:t></w:r></w:p>'),
  }));
  const [q] = ids(s, 'Quoted.');
  assert.strictEqual(info(s, q).list.kind, 'bullet', 'numbered through its style');
  apply(s, setList([q], 'none'));
  assert.strictEqual(pXml(s, q), '<w:p><w:pPr><w:pStyle w:val="Quote"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Quoted.</w:t></w:r></w:p>');
  assert.deepStrictEqual(info(s, q).list, { kind: 'none', level: 0 });
  noop(s, setList([q], 'none'));
  // Back on: the direct numPr is replaced, joining the numbered list before it.
  apply(s, setList([q], 'number'));
  assert.strictEqual(pXml(s, q), `<w:p><w:pPr><w:pStyle w:val="Quote"/>${numPr(2)}</w:pPr><w:r><w:t>Quoted.</w:t></w:r></w:p>`);
  writeOut(OUT, 'list-off-inherited.docx', s.pkg.serialize());
});

test('level change clamps 0–8; an inherited level becomes a direct numPr; paragraphs outside a list and levels the list lacks are left alone', async () => {
  const ctx = open('basic.docx');
  const [b1, plain] = ids(ctx, 'Bullet one', 'A plain paragraph with ordinary text.');
  noop(ctx, setLevel([plain], 1));
  noop(ctx, setLevel([plain], -1));
  // Word's own list in this fixture is single-level: there is no level 1 to move to.
  noop(ctx, setLevel([b1], 1));
  noop(ctx, setLevel([b1], -1));
  // This editor's lists have nine levels.
  apply(ctx, setList([plain], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, plain), { numId: 3, ilvl: 0 });
  noop(ctx, setLevel([plain], -1));
  for (let k = 1; k <= 8; k++) {
    const r = apply(ctx, setLevel([plain], 1));
    assert.strictEqual(r.edit.label, 'Change List');
    assert.deepStrictEqual(numPrOf(ctx, plain), { numId: 3, ilvl: k });
    assert.deepStrictEqual(info(ctx, plain).list, { kind: 'bullet', level: k });
  }
  assert.match(pXml(ctx, plain), new RegExp(`<w:pPr><w:pStyle w:val="ListParagraph"/>${numPr(3, 8)}</w:pPr>`));
  noop(ctx, setLevel([plain], 1));
  writeOut(OUT, 'level-8.docx', ctx.pkg.serialize());
  apply(ctx, setLevel([plain], -1));
  assert.deepStrictEqual(numPrOf(ctx, plain), { numId: 3, ilvl: 7 });
  undoAll(ctx);

  // A numbered list from the style (numId 2, given all nine levels here), at level 1.
  let levels = '';
  for (let k = 1; k <= 8; k++) levels += `<w:lvl w:ilvl="${k}"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%${k + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (k + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const s = open('style-numbered.docx', await patched('basic.docx', {
    [NUMBERING]: (t) => t.replace(/(<w:abstractNum w:abstractNumId="1".*?)singleLevel(.*?<\/w:lvl>)/, (m, x, y) => `${x}multilevel${y}${levels}`),
    [STYLES]: (t) => t.replace(/(w:styleId="Quote">.*?<w:pPr>)/, '$1<w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>'),
    [MAIN]: (t) => t.replace(/<w:p [^>]*><w:r><w:t>Final paragraph\.<\/w:t><\/w:r><\/w:p>/,
      `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:jc w:val="left"/></w:pPr><w:r><w:t>Quoted.</w:t></w:r></w:p><w:p><w:pPr>${numPr(2, 12)}</w:pPr><w:r><w:t>too deep</w:t></w:r></w:p>`),
  }));
  const [q, deep] = ids(s, 'Quoted.', 'too deep');
  assert.deepStrictEqual(info(s, q).list, { kind: 'number', level: 1 });
  apply(s, setLevel([q], 1));
  assert.strictEqual(pXml(s, q), `<w:p><w:pPr><w:pStyle w:val="Quote"/>${numPr(2, 2)}<w:jc w:val="left"/></w:pPr><w:r><w:t>Quoted.</w:t></w:r></w:p>`);
  assert.deepStrictEqual(info(s, q).list, { kind: 'number', level: 2 });
  // A level beyond 8 in the file is brought back into range.
  apply(s, setLevel([deep], 1));
  assert.deepStrictEqual(numPrOf(s, deep), { numId: 2, ilvl: 8 });
  apply(s, setLevel([deep, q], -1));
  assert.deepStrictEqual([numPrOf(s, deep), numPrOf(s, q)], [{ numId: 2, ilvl: 7 }, { numId: 2, ilvl: 1 }]);
  writeOut(OUT, 'level-inherited.docx', s.pkg.serialize());
});

test('list inside a table cell: never joins a list outside the cell; cells keep their structure', () => {
  const ctx = open('tables.docx');
  const [caption, c11, c12, two, paragraphs, neighbour, item3, after2] = ids(ctx,
    'Table 1: mixed run formatting', 'plain bold italic', 'second cell', 'two', 'paragraphs', 'neighbour', 'Item three', 'After table 2.');
  assert.deepStrictEqual([ctx.numbering.maxAbstractNumId(), ctx.numbering.maxNumId()], [0, 1]);
  // The body paragraph right before the table becomes a numbered list (num 2).
  apply(ctx, setList([caption], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, caption), { numId: 2, ilvl: 0 });
  // The first paragraph of the first cell: its own list (num 3), not the caption's.
  apply(ctx, setList([c11], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, c11), { numId: 3, ilvl: 0 });
  // The next cell is another container again.
  apply(ctx, setList([c12], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, c12), { numId: 4, ilvl: 0 });
  // Two paragraphs of one cell, selected together: one list.
  apply(ctx, setList([two, paragraphs], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual([numPrOf(ctx, two), numPrOf(ctx, paragraphs)], [{ numId: 5, ilvl: 0 }, { numId: 5, ilvl: 0 }]);
  apply(ctx, setLevel([paragraphs], 1));
  assert.deepStrictEqual(info(ctx, paragraphs).list, { kind: 'number', level: 1 });
  assert.deepStrictEqual(info(ctx, paragraphs).cell, { row: 1, col: 0 });
  // Inside a cell that holds a Word list, a neighbouring cell's paragraph does not join it...
  apply(ctx, setList([neighbour], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, neighbour), { numId: 6, ilvl: 0 }, 'this editor\'s shared bullet num, not the cell list\'s numId 1');
  // ...and the body paragraph after the table does not either; it uses the shared bullet num.
  apply(ctx, setList([after2], 'bullet'));
  assert.deepStrictEqual(numPrOf(ctx, after2), { numId: 6, ilvl: 0 });
  // Styles and list-off in cells.
  apply(ctx, setStyle([c12], { heading: 3 }));
  assert.deepStrictEqual(info(ctx, c12).style.kind, 'heading');
  apply(ctx, setList([item3], 'none'));
  assert.deepStrictEqual(info(ctx, item3), { ...info(ctx, item3), style: { kind: 'normal', name: 'Normal' }, list: { kind: 'none', level: 0 } });
  apply(ctx, setList([item3], 'bullet'));
  assert.deepStrictEqual(numPrOf(ctx, item3), { numId: 1, ilvl: 0 }, 'back into the cell\'s own Word list');
  assertNumberingOrder(ctx);
  writeOut(OUT, 'lists-in-cells.docx', ctx.pkg.serialize());
  undoAll(ctx);
  // A table block or a merged-away paragraph is not a paragraph to style.
  const table = ctx.model.blocks().find((b) => b.kind !== 'paragraph');
  refused(ctx, setStyle([table.id], { heading: 1 }), 'blocked');
  const locked = ctx.model.blocks().find((b) => b.kind === 'paragraph' && !isEditable(b));
  refused(ctx, setList([locked.id], 'bullet'), 'blocked');
  refused(ctx, setLevel([caption, locked.id], 1), 'blocked', /selection/);
});

test('multi-block selections: one list per run of neighbours, document order, all or nothing', async () => {
  const ctx = open('no-heading-styles.docx');
  const [p1, p2, p3] = ids(ctx, 'Plain paragraph one. No heading styles are used anywhere in this document.', 'Plain paragraph two.', 'Plain paragraph three.');
  // Given out of order and twice: three neighbours become one numbered list.
  const r = apply(ctx, setList([p3, p1, p2, p1], 'number'), [MAIN, NUMBERING, RELS, TYPES]);
  assert.deepStrictEqual(r.out.changedBlockIds.slice().sort(), [p1, p1, p2, p3].sort());
  assert.deepStrictEqual([p1, p2, p3].map((id) => numPrOf(ctx, id)), [{ numId: 1, ilvl: 0 }, { numId: 1, ilvl: 0 }, { numId: 1, ilvl: 0 }]);
  assert.strictEqual(count(ctx.pkg.text(NUMBERING), '<w:num '), 1);
  apply(ctx, setLevel([p2, p3], 1));
  assert.deepStrictEqual([p1, p2, p3].map((id) => info(ctx, id).list.level), [0, 1, 1]);
  // The whole list to bullets: every item keeps its level and they stay one list.
  apply(ctx, setList([p1, p2, p3], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual([p1, p2, p3].map((id) => numPrOf(ctx, id)), [{ numId: 2, ilvl: 0 }, { numId: 2, ilvl: 1 }, { numId: 2, ilvl: 1 }]);
  assert.deepStrictEqual([p1, p2, p3].map((id) => info(ctx, id).list.kind), ['bullet', 'bullet', 'bullet']);
  // Only the middle one back to numbers: its own new list, level kept.
  apply(ctx, setList([p2], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(ctx, p2), { numId: 3, ilvl: 1 });
  writeOut(OUT, 'multi-list.docx', ctx.pkg.serialize());
  // Headings and Normal over several blocks; a block that already has the style is skipped.
  apply(ctx, setStyle([p1, p2], { heading: 2 }));
  apply(ctx, setStyle([p3, p2, p1], { heading: 2 }));
  assert.deepStrictEqual([p1, p2, p3].map((id) => styleOf(ctx, id)), ['Heading2', 'Heading2', 'Heading2']);
  apply(ctx, setStyle([p1, p2, p3], 'normal'));
  assert.deepStrictEqual([p1, p2, p3].map((id) => styleOf(ctx, id)), [null, null, null]);
  apply(ctx, setList([p1, p2, p3], 'none'));
  assert.deepStrictEqual([p1, p2, p3].map((id) => pXml(ctx, id).includes('<w:pPr>')), [false, false, false]);
  writeOut(OUT, 'multi-style.docx', ctx.pkg.serialize());
  // All or nothing.
  refused(ctx, setList([p1, 424242], 'bullet'), 'stale');
  refused(ctx, setStyle([p1, 424242], { heading: 1 }), 'stale');
  refused(ctx, setLevel([], 1), 'invalid');
  refused(ctx, setList([], 'bullet'), 'invalid');
  refused(ctx, setStyle([], 'normal'), 'invalid');
  undoAll(ctx);

  // Two selected paragraphs that are not neighbours: two numbered lists. Selected paragraphs before
  // an existing list join it together.
  const basic = open('basic.docx');
  const [plain, mixed, h3, final] = ids(basic, 'A plain paragraph with ordinary text.', 'This paragraph has bold, italic and underlined text.', 'Heading Three', 'Final paragraph.');
  apply(basic, setList([plain, mixed], 'number'), [MAIN, NUMBERING]);
  assert.deepStrictEqual([numPrOf(basic, plain), numPrOf(basic, mixed)], [{ numId: 3, ilvl: 0 }, { numId: 4, ilvl: 0 }]);
  const empty = basic.model.siblings(basic.model.block(final)).next;
  assert.ok(empty && isEditable(empty));
  apply(basic, setList([h3, final, empty.id], 'bullet'), [MAIN, NUMBERING]);
  assert.deepStrictEqual(numPrOf(basic, h3), { numId: 1, ilvl: 0 }, 'joins "Bullet one" after it');
  assert.deepStrictEqual([numPrOf(basic, final), numPrOf(basic, empty.id)], [{ numId: 5, ilvl: 0 }, { numId: 5, ilvl: 0 }], 'no bullet neighbour: the shared bullet num');
  assertNumberingOrder(basic);
  writeOut(OUT, 'multi-separate.docx', basic.pkg.serialize());
  undoAll(basic);
});

test('refusals: unreadable numbering, a numbering relationship that leads nowhere, tracked numbering, bad input; nothing is written', async () => {
  const damaged = open('damaged-numbering.docx', await patched('basic.docx', { [NUMBERING]: () => '<?xml version="1.0"?><nope/>' }));
  assert.strictEqual(damaged.numbering.damaged, true);
  const [d] = ids(damaged, 'A plain paragraph with ordinary text.');
  refused(damaged, setList([d], 'bullet'), 'blocked', /list definitions/);
  refused(damaged, setList([d], 'number'), 'blocked', /list definitions/);

  // The relationship is there, the part is not: a second relationship must not be added.
  const dangling = open('dangling.docx', await patched('basic.docx', { [NUMBERING]: () => null }));
  assert.strictEqual(dangling.numbering.part, null);
  const [g] = ids(dangling, 'A plain paragraph with ordinary text.');
  const relsBefore = dangling.pkg.text(RELS);
  refused(dangling, setList([g], 'bullet'), 'blocked', /list definitions/);
  assert.strictEqual(dangling.pkg.text(RELS), relsBefore);
  assert.ok(!dangling.pkg.has(NUMBERING));
  assert.deepStrictEqual(dangling.pkg.touchedParts(), []);

  // The part is there, the relationship is not: it is not overwritten.
  const orphan = open('orphan.docx', await patched('basic.docx', { [RELS]: (t) => t.replace(/<Relationship [^>]*relationships\/numbering"[^>]*\/>/, '') }));
  assert.strictEqual(orphan.numbering.part, null);
  const [o] = ids(orphan, 'A plain paragraph with ordinary text.');
  refused(orphan, setList([o], 'number'), 'blocked', /list definitions/);

  // A tracked numbering change inside w:numPr is never rewritten or dropped.
  const tracked = await docWithBody('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:ins w:id="9" w:author="x" w:date="2024-01-01T00:00:00Z"/></w:numPr></w:pPr><w:r><w:t>tracked</w:t></w:r></w:p><w:p/>');
  const t = tracked.model.blocks()[0];
  for (const op of [setList([t.id], 'none'), setList([t.id], 'number'), setLevel([t.id], 1)]) refused(tracked, op, 'blocked');
  assert.strictEqual(t.lockReason, 'tracked-changes', 'the model already locks it; stylesWrite also refuses such a numPr on its own');

  const ctx = open('basic.docx');
  const [plain] = ids(ctx, 'A plain paragraph with ordinary text.');
  for (const op of [setStyle([plain], { heading: 7 }), setStyle([plain], { heading: 1.5 }), setStyle([plain], 'title'), setList([plain], 'roman'), setLevel([plain], 2), setStyle('x', 'normal')]) {
    refused(ctx, op, 'invalid');
  }
  refused(ctx, setList([777777], 'none'), 'stale');
  assert.deepStrictEqual(ctx.pkg.touchedParts(), []);
});
