// WP-28: paragraph writer (src/office/core/docx/paragraphWriter.ts). Spec §8.4 rules 1–8, §13.2 G0/G3/G4/G5.
//
// Every committing test goes through `commit()`, which asserts for the edit it made:
//   G3  only the main part's entry differs;
//   G4  the main part's text is the original outside the paragraph's own `w:p` span (exactly);
//   G5  undo serialises to the bytes before the edit, redo to the bytes after it;
//   G6  the new main part is well-formed for an independent parser (saxes) and re-opens with the
//       text and b/i/u the commit asked for.
// Outputs go to tests/.out/docxParagraph/ for scripts/verify-office-open.ps1 -Kind Word.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { core, fixture, allFixtures, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG0, assertG3, assertG5, prettyDocx, rng } from './_roundtrip.mjs';

const require = createRequire(import.meta.url);
const { SaxesParser } = require('saxes');

const { OfficePackage } = core.pkg;
const { DocxModel, isEditable, paragraphProps, NS_W } = core.docx.model;
const { DocxStyles } = core.docx.styles;
const { EditBuilder, applyEdit, invertEdit } = core.edits;
const { serialize, parseFragment } = core.xml;
const PW = core.docx.paragraphWriter;
const { buildParagraphXml, commitParagraph, setToggle, upsertPPrChild, RPR_ORDER, PPR_ORDER } = PW;

const OUT = 'docxParagraph';
const NB_HYPHEN = String.fromCodePoint(0x2011);
const SOFT_HYPHEN = String.fromCodePoint(0xAD);
const NBSP = String.fromCodePoint(0xA0);

// ---------------------------------------------------------------------------------------------------
// Harness

function open(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  const model = DocxModel.load(pkg);
  const styles = DocxStyles.load(pkg, model.mainPart);
  return { name, pkg, model, styles, orig: bytes };
}

/** basic.docx (or `from`) with `fn(text)` applied to one part. */
async function patched(fn, from = 'basic.docx', part = 'word/document.xml') {
  const zip = await JSZip.loadAsync(fixture(from));
  zip.file(part, fn(await zip.file(part).async('string')));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** A document whose body is exactly `bodyXml` + a final sectPr (root and namespaces from basic.docx). */
async function docWithBody(bodyXml, name = 'synthetic.docx') {
  const bytes = await patched((t) => {
    const a = t.indexOf('<w:body>');
    const b = t.indexOf('<w:sectPr', a);
    assert.ok(a > 0 && b > a);
    return t.slice(0, a + 8) + bodyXml + t.slice(b);
  });
  return open(name, bytes);
}

const mainText = (ctx) => serialize(ctx.pkg.xml(ctx.model.mainPart));

/** Offset of `node`'s text in its serialised document. */
function offsetOf(doc, node) {
  const text = serialize(doc);
  const rootText = serialize(doc.root);
  let off = text.indexOf(rootText);
  const chain = [];
  for (let n = node; n.parent; n = n.parent) chain.unshift(n);
  let parent = doc.root;
  for (const n of chain) {
    const ptext = serialize(parent);
    let q = '';
    let j = 1;
    for (; j < ptext.length; j++) {
      const ch = ptext[j];
      if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break;
    }
    off += j + 1;
    for (const c of parent.children) {
      if (c === n) break;
      off += serialize(c).length;
    }
    parent = n;
  }
  return off;
}

function saxesOk(text) {
  const p = new SaxesParser({ xmlns: true });
  let error = null;
  p.on('error', (e) => { error ??= e; });
  p.write(text).close();
  assert.strictEqual(error, null, `saxes: ${error && error.message}`);
}

const textSegs = (ctx, b) => ctx.model.segments(b).filter((s) => s.kind === 'text');

/** The commit items that mean "nothing changed" (what the island sends for an untouched paragraph). */
function identity(ctx, b) {
  const pStyle = paragraphProps(b.el).pStyleId;
  const out = [];
  for (const s of ctx.model.segments(b)) {
    if (s.kind === 'text') out.push({ kind: 'text', text: s.text, ...ctx.styles.effectiveToggles(pStyle, s.rPr), src: s.id });
    else if (s.kind === 'atom' || s.kind === 'anchor') out.push({ kind: s.kind, id: s.id });
  }
  return out;
}

/** What a reader sees: runs of text with their effective b/i/u, atoms and anchors as marks. */
function look(ctx, b) {
  const pStyle = paragraphProps(b.el).pStyleId;
  const out = [];
  for (const s of ctx.model.segments(b)) {
    if (s.kind === 'text') {
      if (s.text === '') continue;
      const t = ctx.styles.effectiveToggles(pStyle, s.rPr);
      const f = (t.b ? 'b' : '') + (t.i ? 'i' : '') + (t.u ? 'u' : '');
      const last = out[out.length - 1];
      if (last && last.t !== undefined && last.f === f) last.t += s.text; else out.push({ t: s.text, f });
    } else if (s.kind === 'atom') out.push({ a: s.atomType + ':' + s.label });
    else if (s.kind === 'anchor') out.push({ k: (s.pairKey ?? '?') + '/' + (s.role ?? 'ref') });
  }
  return out;
}

/** The same shape from commit items (text merged by formatting only; atoms/anchors by presence). */
function lookOfItems(items) {
  const out = [];
  for (const it of items) {
    if (it.kind !== 'text') { out.push(it.kind); continue; }
    if (it.text === '') continue;
    const f = (it.b ? 'b' : '') + (it.i ? 'i' : '') + (it.u ? 'u' : '');
    const last = out[out.length - 1];
    if (last && last.t !== undefined && last.f === f) last.t += it.text; else out.push({ t: it.text, f });
  }
  return out;
}
/** Text entries only, adjacent ones with the same formatting merged (marks between them do not split text). */
function textOnly(l) {
  const out = [];
  for (const x of l) {
    if (typeof x !== 'object' || x.t === undefined) continue;
    const last = out[out.length - 1];
    if (last && last.f === x.f) last.t += x.t; else out.push({ ...x });
  }
  return out;
}

/**
 * Commit `items` to block `blockId` and assert G3, G4, G5 and well-formedness. Returns
 * { outcome, edit, pXml (new paragraph text), before (old paragraph text), bytes }.
 * `opts.light` (long sequences): G4 and undo/redo are checked on the main part's text only (it is
 * the only part touched, so the package bytes follow); no package serialise, saxes run or reload
 * per step, and `bytes` is null. The caller checks bytes, saxes and reload once at the end.
 */
function commit(ctx, blockId, items, opts = {}) {
  const { pkg, model, styles } = ctx;
  const main = model.mainPart;
  const doc = pkg.xml(main);
  const block = model.block(blockId);
  assert.ok(block, `block ${blockId} exists`);
  const beforeText = serialize(doc);
  const light = opts.light === true;
  const beforeBytes = light ? null : pkg.serialize();
  const before = serialize(block.el);
  const start = offsetOf(doc, block.el);
  assert.strictEqual(beforeText.slice(start, start + before.length), before, 'offsetOf finds the paragraph');
  const census = model.tableCensus();

  const b = new EditBuilder(pkg, 'Edit Paragraph');
  const outcome = commitParagraph(b, model, styles, blockId, items);
  const edit = b.finish();
  if (!outcome.ok || !outcome.changed) {
    assert.strictEqual(edit, null, 'no edit recorded');
    assert.strictEqual(serialize(doc), beforeText, 'nothing changed');
    if (!light) assertBytesEqual(pkg.serialize(), beforeBytes, 'bytes unchanged');
    return { outcome, edit: null, before, pXml: before, bytes: beforeBytes };
  }
  model.refresh();
  assert.ok(edit, 'an edit was recorded');
  assert.strictEqual(edit.label, 'Edit Paragraph');
  assert.deepStrictEqual(outcome.changedBlockIds, [blockId]);
  const now = model.block(blockId);
  assert.ok(now, 'the block keeps its id across the commit');
  assert.strictEqual(now.lockReason, undefined, 'the written paragraph is still editable');
  const pXml = serialize(now.el);
  const afterText = serialize(doc);
  // G4, exactly: the original text with this one w:p replaced.
  assert.strictEqual(afterText, beforeText.slice(0, start) + pXml + beforeText.slice(start + before.length), 'G4: only the w:p span changed');
  assert.strictEqual(model.tableCensus(), census, 'table census unchanged');
  assert.deepStrictEqual(pkg.touchedParts(), [main]);
  assert.deepStrictEqual(edit.changes.map((c) => c.part), [main], 'one change, in the main part');
  let bytes = null;
  if (light) {
    applyEdit(pkg, invertEdit(edit));
    assert.strictEqual(serialize(doc), beforeText, 'G5 (text): undo restores the main part');
    applyEdit(pkg, edit);
    assert.strictEqual(serialize(doc), afterText, 'G5 (text): redo restores the edit');
  } else {
    saxesOk(afterText);
    // G3 against the file as opened, G5 against the state before this edit.
    bytes = pkg.serialize();
    assertG3(ctx.orig, bytes, [main]);
    assertG5(pkg, edit, beforeBytes);
  }
  model.refresh();
  assert.strictEqual(serialize(model.block(blockId).el), pXml, 'redo restores the committed paragraph');
  if (!light && !opts.skipReload) {
    // Reload: an independent open of the saved bytes reads the committed text and formatting.
    const re = open('reload.docx', bytes);
    const index = model.blocks().findIndex((x) => x.id === blockId);
    const rb = re.model.blocks()[index];
    assert.ok(isEditable(rb), 'reloaded paragraph is editable');
    assert.deepStrictEqual(textOnly(look(re, rb)), textOnly(lookOfItems(items.map((it) => (it.kind === 'text' ? { ...it, text: clean(it.text) } : it)))),
      'reload reads the committed text and formatting');
  }
  return { outcome, edit, before, pXml, bytes };
}

const clean = (s) => core.xml.stripIllegalXmlChars(s).replace(/\r\n?/g, '\n');

/** Undo `edits` (latest first) and assert the package is the file as opened. */
function undoAll(ctx, edits) {
  for (let k = edits.length - 1; k >= 0; k--) applyEdit(ctx.pkg, invertEdit(edits[k]));
  ctx.model.refresh();
  assertBytesEqual(ctx.pkg.serialize(), ctx.orig, 'undo of everything is the original file');
}

function byText(ctx, text) {
  const hits = ctx.model.blocks().filter((b) => isEditable(b) && textSegs(ctx, b).map((s) => s.text).join('') === text);
  assert.strictEqual(hits.length, 1, `exactly one editable paragraph reads "${text}"`);
  return hits[0];
}
const T = (text, src, f = '') => ({ kind: 'text', text, b: f.includes('b'), i: f.includes('i'), u: f.includes('u'), src });
const R = (text, rPr = '', attrs = '') => `<w:r${attrs}>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const WT = (s) => `<w:t xml:space="preserve">${s}</w:t>`;

// ---------------------------------------------------------------------------------------------------
// Constants and the two property helpers

test('RPR_ORDER and PPR_ORDER are the schema sequences', () => {
  assert.deepStrictEqual(RPR_ORDER.slice(0, 6), ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs']);
  assert.ok(RPR_ORDER.indexOf('highlight') < RPR_ORDER.indexOf('u') && RPR_ORDER.indexOf('u') < RPR_ORDER.indexOf('vertAlign'));
  assert.strictEqual(RPR_ORDER[RPR_ORDER.length - 2], 'oMath');
  assert.strictEqual(new Set(RPR_ORDER).size, RPR_ORDER.length);
  assert.deepStrictEqual(PPR_ORDER.slice(0, 7), ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr']);
  assert.ok(PPR_ORDER.indexOf('spacing') < PPR_ORDER.indexOf('ind') && PPR_ORDER.indexOf('ind') < PPR_ORDER.indexOf('jc'));
  assert.deepStrictEqual(PPR_ORDER.slice(-3), ['rPr', 'sectPr', 'pPrChange']);
  assert.strictEqual(new Set(PPR_ORDER).size, PPR_ORDER.length);
});

test('setToggle: bold/italic/underline encodings (rule 7) and schema order', () => {
  const { pkg, model } = open('basic.docx');
  const doc = pkg.xml(model.mainPart);
  assert.strictEqual(setToggle(null, 'b', true, false, doc), '<w:rPr><w:b/><w:bCs/></w:rPr>');
  assert.strictEqual(setToggle(null, 'i', true, false, doc), '<w:rPr><w:i/><w:iCs/></w:rPr>');
  assert.strictEqual(setToggle(null, 'u', true, false, doc), '<w:rPr><w:u w:val="single"/></w:rPr>');
  assert.strictEqual(setToggle(null, 'b', false, false, doc), '');
  assert.strictEqual(setToggle(null, 'b', false, true, doc), '<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>');
  assert.strictEqual(setToggle(null, 'u', false, true, doc), '<w:rPr><w:u w:val="none"/></w:rPr>');
  assert.strictEqual(setToggle('<w:rPr><w:b/><w:bCs/></w:rPr>', 'b', false, false, doc), '');
  assert.strictEqual(setToggle('<w:rPr><w:b/></w:rPr>', 'b', false, true, doc), '<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>');
  assert.strictEqual(setToggle('<w:rPr><w:b w:val="0"/></w:rPr>', 'b', true, true, doc), '<w:rPr><w:b/><w:bCs/></w:rPr>');
  // Underline: an existing line style survives "on"; none and absent become single.
  assert.strictEqual(setToggle('<w:rPr><w:u w:val="double" w:color="FF0000"/></w:rPr>', 'u', true, false, doc), '<w:rPr><w:u w:val="double" w:color="FF0000"/></w:rPr>');
  assert.strictEqual(setToggle('<w:rPr><w:u w:val="none"/></w:rPr>', 'u', true, true, doc), '<w:rPr><w:u w:val="single"/></w:rPr>');
  assert.strictEqual(setToggle('<w:rPr><w:u w:val="wave"/></w:rPr>', 'u', false, false, doc), '');
  // Schema order whatever the source order; untouched children keep their exact text; extensions last.
  const messy = '<w:rPr><w:sz w:val="28"/><w14:ligatures w14:val="none"/><w:color w:val="FF0000"/><w:rFonts w:ascii="Arial"  w:hAnsi="Arial"/><w:rStyle w:val="Strong"/></w:rPr>';
  assert.strictEqual(setToggle(messy, 'i', true, false, doc),
    '<w:rPr><w:rStyle w:val="Strong"/><w:rFonts w:ascii="Arial"  w:hAnsi="Arial"/><w:i/><w:iCs/><w:color w:val="FF0000"/><w:sz w:val="28"/><w14:ligatures w14:val="none"/></w:rPr>');
  assert.strictEqual(setToggle('<w:rPr><w:lang w:val="en-GB"/><w:noProof/></w:rPr>', 'u', true, false, doc),
    '<w:rPr><w:noProof/><w:u w:val="single"/><w:lang w:val="en-GB"/></w:rPr>');
  // Refusals.
  assert.throws(() => setToggle('<w:pPr/>', 'b', true, false, doc), /not a w:rPr/);
  assert.throws(() => setToggle('<w:rPr><!--x--><w:b/></w:rPr>', 'b', false, false, doc), /other than elements/);
  assert.throws(() => setToggle('<w:rPr><nope:b/></w:rPr>', 'b', false, false, doc));
  assert.throws(() => setToggle('<w:rPr/><w:rPr/>', 'b', true, false, doc), /exactly one element/);
});

test('upsertPPrChild: schema position on insert, in-place replace, removal', () => {
  const { pkg, model } = open('basic.docx');
  const doc = pkg.xml(model.mainPart);
  const ps = '<w:pStyle w:val="Heading1"/>';
  assert.strictEqual(upsertPPrChild(null, 'pStyle', ps, doc), `<w:pPr>${ps}</w:pPr>`);
  assert.strictEqual(upsertPPrChild('', 'pStyle', null, doc), '');
  const pPr = '<w:pPr><w:keepNext/><w:spacing w:after="0"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>';
  assert.strictEqual(upsertPPrChild(pPr, 'pStyle', ps, doc), `<w:pPr>${ps}<w:keepNext/><w:spacing w:after="0"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>`);
  const numPr = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>';
  assert.strictEqual(upsertPPrChild(pPr, 'numPr', numPr, doc), `<w:pPr><w:keepNext/>${numPr}<w:spacing w:after="0"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>`);
  assert.strictEqual(upsertPPrChild(pPr, 'ind', '<w:ind w:left="720"/>', doc), '<w:pPr><w:keepNext/><w:spacing w:after="0"/><w:ind w:left="720"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>');
  assert.strictEqual(upsertPPrChild(pPr, 'sectPr', '<w:sectPr/>', doc), '<w:pPr><w:keepNext/><w:spacing w:after="0"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:sectPr/></w:pPr>');
  // Replace keeps the position; remove leaves the rest byte-identical; the last child gone = no pPr.
  assert.strictEqual(upsertPPrChild(pPr, 'spacing', '<w:spacing w:before="240"/>', doc), '<w:pPr><w:keepNext/><w:spacing w:before="240"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>');
  assert.strictEqual(upsertPPrChild(pPr, 'jc', null, doc), '<w:pPr><w:keepNext/><w:spacing w:after="0"/><w:rPr><w:b/></w:rPr></w:pPr>');
  assert.strictEqual(upsertPPrChild(pPr, 'numPr', null, doc), pPr);
  assert.strictEqual(upsertPPrChild(`<w:pPr>${ps}</w:pPr>`, 'pStyle', null, doc), '');
  assert.throws(() => upsertPPrChild(pPr, 'bogus', '<w:bogus/>', doc), /not a w:pPr child/);
  assert.throws(() => upsertPPrChild(pPr, 'jc', '<w:ind/>', doc), /not a w:jc element/);
  assert.throws(() => upsertPPrChild('<w:rPr/>', 'jc', null, doc), /not a w:pPr element/);
});

// ---------------------------------------------------------------------------------------------------
// Rule 1

test('unchanged commit → no edit (every editable paragraph of every loadable docx fixture; G0)', () => {
  let paragraphs = 0;
  for (const name of allFixtures('docx')) {
    let ctx;
    try { ctx = open(name); } catch { continue; }                 // encrypted / truncated / legacy: not loadable
    if (ctx.model.viewOnlyReason) continue;
    const blocks = ctx.model.blocks().filter(isEditable);
    const step = blocks.length > 400 ? 7 : 1;                      // large.docx: a spread, not all 1,969
    for (let k = 0; k < blocks.length; k += step) {
      const b = blocks[k];
      const built = buildParagraphXml(ctx.model, ctx.styles, b, identity(ctx, b));
      assert.strictEqual(built.changed, false, `${name} block ${b.id}`);
      assert.strictEqual(built.xml, serialize(b.el));
      assert.strictEqual(built.reinsertedAtoms, false);
      const eb = new EditBuilder(ctx.pkg, 'Edit Paragraph');
      const outcome = commitParagraph(eb, ctx.model, ctx.styles, b.id, identity(ctx, b));
      assert.deepStrictEqual(outcome, { ok: true, changed: false, changedBlockIds: [], reinsertedAtoms: false });
      assert.strictEqual(eb.finish(), null);
      paragraphs++;
    }
    assert.deepStrictEqual(ctx.pkg.touchedParts(), [], `${name}: nothing touched`);
    assertG0(ctx.pkg, name);
  }
  assert.ok(paragraphs > 500, `checked ${paragraphs} paragraphs`);
});

test('unchanged commit ignores an empty w:t and CR/illegal characters the island never sends back', async () => {
  const ctx = await docWithBody(`<w:p><w:r><w:t/></w:r>${R('abc')}</w:p>`);
  const b = ctx.model.blocks()[0];
  const id = textSegs(ctx, b).find((s) => s.text === 'abc').id;
  const r = commit(ctx, b.id, [T('abc', id)]);
  assert.strictEqual(r.outcome.changed, false);
});

// ---------------------------------------------------------------------------------------------------
// Rules 3 and 4: run preservation

test('text edit in one run of multi-run.docx: every other run\'s XML slice byte-identical incl. rsid attributes', async () => {
  // The fixture's own runs first.
  const ctx = open('multi-run.docx');
  const b = ctx.model.blocks().filter(isEditable)[1];
  const runsBefore = b.el.children.filter((c) => c.type === 'el' && c.local === 'r').map((r) => serialize(r));
  const items = identity(ctx, b);
  const k = items.findIndex((it) => it.text === 'italic ');
  items[k] = { ...items[k], text: 'slanted ' };
  const r = commit(ctx, b.id, items);
  const runsAfter = ctx.model.block(b.id).el.children.filter((c) => c.type === 'el' && c.local === 'r').map((x) => serialize(x));
  assert.strictEqual(runsAfter.length, runsBefore.length);
  for (let n = 0; n < runsBefore.length; n++) {
    if (n === k) assert.strictEqual(runsAfter[n], `<w:r><w:rPr><w:i/></w:rPr>${WT('slanted ')}</w:r>`);
    else assert.strictEqual(runsAfter[n], runsBefore[n], `run ${n} is its source slice`);
  }
  // pPr (with its paragraph-mark rPr) verbatim, paraId kept, textId gone.
  assert.ok(r.pXml.startsWith('<w:p w14:paraId="6E81E259"><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Plain </w:t></w:r>'));
  writeOut(OUT, 'multi-run-text-edit.docx', r.bytes);
  undoAll(ctx, [r.edit]);

  // The same with rsid attributes, odd spacing and proofing marks around the runs.
  const r1 = '<w:r w:rsidRPr="00AB12CD" w:rsidR="00112233"><w:rPr><w:b/><w:color w:val="FF0000" /></w:rPr><w:t xml:space="preserve">one </w:t></w:r>';
  const r2 = '<w:r w:rsidR="00445566"><w:t>two</w:t></w:r>';
  const r3 = '<w:r  w:rsidR="00778899" ><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> three</w:t></w:r>';
  const syn = await docWithBody(`<w:p w:rsidR="00112233" w:rsidRDefault="00445566" w14:paraId="0A0B0C0D" w14:textId="11223344"><w:pPr><w:jc w:val="center"/></w:pPr><w:proofErr w:type="spellStart"/>${r1}<w:proofErr w:type="spellEnd"/>${r2}${r3}</w:p>`);
  const sb = syn.model.blocks()[0];
  const sItems = identity(syn, sb);
  sItems[1] = { ...sItems[1], text: 'TWO' };
  const s = commit(syn, sb.id, sItems);
  assert.strictEqual(s.pXml,
    `<w:p w:rsidR="00112233" w:rsidRDefault="00445566" w14:paraId="0A0B0C0D"><w:pPr><w:jc w:val="center"/></w:pPr>${r1}<w:r>${WT('TWO')}</w:r>${r3}</w:p>`);
  writeOut(OUT, 'rsid-text-edit.docx', s.bytes);
});

test('partial-selection bold splits one run into three with copied rPr', () => {
  const ctx = open('multi-run.docx');
  const b = ctx.model.blocks().filter(isEditable)[1];
  const items = identity(ctx, b);
  const k = items.findIndex((it) => it.text === 'red ');
  const src = items[k].src;
  items.splice(k, 1, T('r', src), T('e', src, 'b'), T('d ', src));
  const before = b.el.children.filter((c) => c.type === 'el' && c.local === 'r').map((r) => serialize(r));
  const r = commit(ctx, b.id, items);
  const rPr = '<w:color w:val="FF0000"/>';
  const expected = [
    ...before.slice(0, k),
    `<w:r><w:rPr>${rPr}</w:rPr>${WT('r')}</w:r>`,
    `<w:r><w:rPr><w:b/><w:bCs/>${rPr}</w:rPr>${WT('e')}</w:r>`,
    `<w:r><w:rPr>${rPr}</w:rPr>${WT('d ')}</w:r>`,
    ...before.slice(k + 1),
  ];
  assert.deepStrictEqual(ctx.model.block(b.id).el.children.filter((c) => c.type === 'el' && c.local === 'r').map((x) => serialize(x)), expected);
  // The segment id stays with the piece that kept the formatting; the other two are new segments.
  const segsNow = textSegs(ctx, ctx.model.block(b.id));
  assert.strictEqual(segsNow[k].id, src);
  assert.notStrictEqual(segsNow[k + 1].id, src);
  writeOut(OUT, 'partial-bold.docx', r.bytes);
});

test('bold off inside a Heading writes w:b w:val="0" and bCs', async () => {
  // basic.docx with a bold Heading 1 style (modern Word's built-in headings are not bold).
  const bytes = await patched((t) => {
    const at = t.indexOf('w:styleId="Heading1"');
    const rPr = t.indexOf('<w:color', at);
    assert.ok(at > 0 && rPr > at);
    return t.slice(0, rPr) + '<w:b/><w:bCs/>' + t.slice(rPr);
  }, 'basic.docx', 'word/styles.xml');
  const ctx = open('bold-heading.docx', bytes);
  const b = byText(ctx, 'Heading One');
  const [seg] = textSegs(ctx, b);
  assert.deepStrictEqual(identity(ctx, b), [T('Heading One', seg.id, 'b')], 'the heading text is effectively bold');
  const r = commit(ctx, b.id, [T('Heading ', seg.id, 'b'), T('One', seg.id)]);
  assert.strictEqual(r.pXml,
    `<w:p w14:paraId="74832417"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r>${WT('Heading ')}</w:r><w:r><w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>${WT('One')}</w:r></w:p>`);
  assert.deepStrictEqual(look(ctx, ctx.model.block(b.id)), [{ t: 'Heading ', f: 'b' }, { t: 'One', f: '' }]);
  // Bold back on: the explicit "off" goes, since on is written as <w:b/><w:bCs/>.
  const segs = textSegs(ctx, ctx.model.block(b.id));
  const r2 = commit(ctx, b.id, [T('Heading ', segs[0].id, 'b'), T('One', segs[1].id, 'b')]);
  assert.ok(r2.pXml.endsWith(`<w:r>${WT('Heading ')}</w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr>${WT('One')}</w:r></w:p>`));
  writeOut(OUT, 'heading-bold-off.docx', r.bytes);
  undoAll(ctx, [r.edit, r2.edit]);
});

test('underline keeps an existing non-none w:u value; off writes none only when inherited', async () => {
  const ctx = await docWithBody(`<w:p>${R('dbl', '<w:u w:val="double"/>')}${R('plain')}${R('off', '<w:u w:val="none"/>')}</w:p>`);
  const b = ctx.model.blocks()[0];
  const [dbl, plain, off] = textSegs(ctx, b);
  assert.deepStrictEqual(identity(ctx, b).map((x) => x.u), [true, false, false]);
  // Italic added to the double-underlined run: w:u untouched. Underline on for the other two.
  const r = commit(ctx, b.id, [T('dbl', dbl.id, 'iu'), T('plain', plain.id, 'u'), T('off', off.id, 'u')]);
  assert.strictEqual(r.pXml, '<w:p>'
    + `<w:r><w:rPr><w:i/><w:iCs/><w:u w:val="double"/></w:rPr>${WT('dbl')}</w:r>`
    + `<w:r><w:rPr><w:u w:val="single"/></w:rPr>${WT('plainoff')}</w:r></w:p>`);
  // Off again: nothing inherited, so the element is removed.
  const now = textSegs(ctx, ctx.model.block(b.id));
  const r2 = commit(ctx, b.id, [T('dbl', now[0].id, 'i'), T('plainoff', now[1].id)]);
  assert.strictEqual(r2.pXml, `<w:p><w:r><w:rPr><w:i/><w:iCs/></w:rPr>${WT('dbl')}</w:r><w:r>${WT('plainoff')}</w:r></w:p>`);
  writeOut(OUT, 'underline.docx', r.bytes);
});

test('underline off under an underlined character style writes w:u w:val="none"', async () => {
  const bytes = await patched((t) => t.replace('</w:styles>',
    '<w:style w:type="character" w:customStyle="1" w:styleId="Und"><w:name w:val="Und"/><w:rPr><w:u w:val="single"/></w:rPr></w:style></w:styles>'),
  'basic.docx', 'word/styles.xml');
  const zip = await JSZip.loadAsync(bytes);
  const t = await zip.file('word/document.xml').async('string');
  const a = t.indexOf('<w:body>');
  zip.file('word/document.xml', t.slice(0, a + 8) + `<w:p>${R('styled', '<w:rStyle w:val="Und"/>')}</w:p>` + t.slice(t.indexOf('<w:sectPr', a)));
  const ctx = open('und.docx', new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
  const b = ctx.model.blocks()[0];
  const [seg] = textSegs(ctx, b);
  assert.strictEqual(identity(ctx, b)[0].u, true);
  const r = commit(ctx, b.id, [T('sty', seg.id, 'u'), T('led', seg.id)]);
  assert.strictEqual(r.pXml, `<w:p><w:r><w:rPr><w:rStyle w:val="Und"/></w:rPr>${WT('sty')}</w:r><w:r><w:rPr><w:rStyle w:val="Und"/><w:u w:val="none"/></w:rPr>${WT('led')}</w:r></w:p>`);
});

test('rPr children emitted in schema order whatever the source order; an unflipped rPr is copied as is', async () => {
  const messy = '<w:sz w:val="28"/><w:color w:val="00B050"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>';
  const ctx = await docWithBody(`<w:p>${R('abcdef', messy)}</w:p>`);
  const b = ctx.model.blocks()[0];
  const [seg] = textSegs(ctx, b);
  const r = commit(ctx, b.id, [T('ab', seg.id), T('cd', seg.id, 'b'), T('ef!', seg.id)]);
  const ordered = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:bCs/><w:color w:val="00B050"/><w:sz w:val="28"/>';
  assert.strictEqual(r.pXml, '<w:p>'
    + `<w:r><w:rPr>${messy}</w:rPr>${WT('ab')}</w:r>`              // not flipped: the source rPr slice, untouched
    + `<w:r><w:rPr>${ordered}</w:rPr>${WT('cd')}</w:r>`
    + `<w:r><w:rPr>${messy}</w:rPr>${WT('ef!')}</w:r></w:p>`);
});

test('tab and newline become w:tab / w:br; leading/trailing spaces get xml:space="preserve"', () => {
  const ctx = open('basic.docx');
  const b = byText(ctx, 'Final paragraph.');
  const [seg] = textSegs(ctx, b);
  const text = '  two leading,\ttab,\nbreak, a\r\nCRLF and trailing  ';
  const r = commit(ctx, b.id, [T(text, seg.id)]);
  assert.strictEqual(r.pXml, '<w:p w14:paraId="71057103"><w:r>'
    + `${WT('  two leading,')}<w:tab/>${WT('tab,')}<w:br/>${WT('break, a')}<w:br/>${WT('CRLF and trailing  ')}</w:r></w:p>`);
  assert.strictEqual(textSegs(ctx, ctx.model.block(b.id)).map((s) => s.text).join(''), clean(text));
  // Only whitespace, and markup characters.
  const [again] = textSegs(ctx, ctx.model.block(b.id));
  const r2 = commit(ctx, b.id, [T(' \t ', again.id), T('a < b && c > d ]]> "q"' + NBSP, again.id, 'i')]);
  assert.ok(r2.pXml.endsWith(`<w:r>${WT(' ')}<w:tab/>${WT(' ')}</w:r><w:r><w:rPr><w:i/><w:iCs/></w:rPr>${WT('a &lt; b &amp;&amp; c &gt; d ]]&gt; "q"' + NBSP)}</w:r></w:p>`));
  writeOut(OUT, 'whitespace.docx', r.bytes);
  writeOut(OUT, 'markup-chars.docx', r2.bytes);
  undoAll(ctx, [r.edit, r2.edit]);
});

test('src:null run has no rPr (text typed into an empty paragraph); toggles on it create one', () => {
  const ctx = open('basic.docx');
  const empty = ctx.model.blocks().filter(isEditable).find((b) => ctx.model.segments(b).length === 0);
  assert.strictEqual(serialize(empty.el), '<w:p w14:paraId="3098CD90" w14:textId="77777777"/>');
  const r = commit(ctx, empty.id, [T('typed', null)]);
  assert.strictEqual(r.pXml, `<w:p w14:paraId="3098CD90"><w:r>${WT('typed')}</w:r></w:p>`);
  const [seg] = textSegs(ctx, ctx.model.block(empty.id));
  const r2 = commit(ctx, empty.id, [T('typed', seg.id), T(' bold', null, 'b')]);
  assert.strictEqual(r2.pXml, `<w:p w14:paraId="3098CD90"><w:r>${WT('typed')}</w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr>${WT(' bold')}</w:r></w:p>`);
  // Emptied again: a self-closing paragraph, like the source.
  const r3 = commit(ctx, empty.id, []);
  assert.strictEqual(r3.pXml, '<w:p w14:paraId="3098CD90"/>');
  writeOut(OUT, 'empty-paragraph-typed.docx', r2.bytes);
  undoAll(ctx, [r.edit, r2.edit, r3.edit]);
});

test('adjacent new runs with identical rPr merge; a source-slice run never merges', async () => {
  const ctx = await docWithBody(`<w:p>${R('Hel', '', ' w:rsidR="00AA0001"')}${R('lo', '', ' w:rsidR="00AA0002"')}${R(' world', '', ' w:rsidR="00AA0003"')}</w:p>`);
  const b = ctx.model.blocks()[0];
  const [s1, s2, s3] = textSegs(ctx, b);
  // Bold across the two fragments: one new run. The third stays its slice although it has the same (empty) rPr as nothing new.
  const r = commit(ctx, b.id, [T('Hel', s1.id, 'b'), T('lo', s2.id, 'b'), T(' world', s3.id)]);
  assert.strictEqual(r.pXml, `<w:p><w:r><w:rPr><w:b/><w:bCs/></w:rPr>${WT('Hello')}</w:r>${R(' world', '', ' w:rsidR="00AA0003"')}</w:p>`);
  // Changed text next to an unchanged run with identical (no) properties: still two runs.
  const now = textSegs(ctx, ctx.model.block(b.id));
  const r2 = commit(ctx, b.id, [T('Hello', now[0].id), T(' world', now[1].id)]);
  assert.strictEqual(r2.pXml, `<w:p><w:r>${WT('Hello')}</w:r>${R(' world', '', ' w:rsidR="00AA0003"')}</w:p>`);
});

// ---------------------------------------------------------------------------------------------------
// Hyphens

test('U+2011 / U+00AD: untouched characters keep their source form (element or literal); new ones follow the segment', async () => {
  const ctx = await docWithBody(
    `<w:p><w:r><w:t>non</w:t><w:noBreakHyphen/><w:t>breaking and co</w:t><w:softHyphen/><w:t>operate</w:t></w:r></w:p>`
    + `<w:p>${R(`lit${NB_HYPHEN}eral and so${SOFT_HYPHEN}ft`)}</w:p>`
    + `<w:p><w:r><w:t>a</w:t><w:noBreakHyphen/><w:t>b${NB_HYPHEN}c</w:t></w:r></w:p>`);
  const [p1, p2, p3] = ctx.model.blocks();
  const [e] = textSegs(ctx, p1);
  assert.strictEqual(e.text, `non${NB_HYPHEN}breaking and co${SOFT_HYPHEN}operate`);
  const r1 = commit(ctx, p1.id, [T(`non${NB_HYPHEN}breaking and co${SOFT_HYPHEN}operate now, re${NB_HYPHEN}typed`, e.id)]);
  assert.strictEqual(r1.pXml, `<w:p><w:r>${WT('non')}<w:noBreakHyphen/>${WT('breaking and co')}<w:softHyphen/>${WT('operate now, re')}<w:noBreakHyphen/>${WT('typed')}</w:r></w:p>`);
  const [l] = textSegs(ctx, p2);
  const r2 = commit(ctx, p2.id, [T(`X lit${NB_HYPHEN}eral and so${SOFT_HYPHEN}ft, new${NB_HYPHEN}one`, l.id)]);
  assert.strictEqual(r2.pXml, `<w:p><w:r>${WT(`X lit${NB_HYPHEN}eral and so${SOFT_HYPHEN}ft, new${NB_HYPHEN}one`)}</w:r></w:p>`);
  // Mixed forms in one segment: each untouched character keeps its own.
  const [m] = textSegs(ctx, p3);
  const r3 = commit(ctx, p3.id, [T(`a${NB_HYPHEN}bX${NB_HYPHEN}c`, m.id)]);
  assert.strictEqual(r3.pXml, `<w:p><w:r>${WT('a')}<w:noBreakHyphen/>${WT(`bX${NB_HYPHEN}c`)}</w:r></w:p>`);
  // Text with no source run: literal characters.
  const r4 = commit(ctx, p3.id, [T(`a${NB_HYPHEN}bX${NB_HYPHEN}c`, textSegs(ctx, ctx.model.block(p3.id))[0].id), T(`n${NB_HYPHEN}${SOFT_HYPHEN}`, null, 'i')]);
  assert.ok(r4.pXml.endsWith(`<w:r><w:rPr><w:i/><w:iCs/></w:rPr>${WT(`n${NB_HYPHEN}${SOFT_HYPHEN}`)}</w:r></w:p>`));
  writeOut(OUT, 'hyphens.docx', r4.bytes);
});

// ---------------------------------------------------------------------------------------------------
// Rules 5 and 6: atoms and anchors

test('atoms and anchors re-emitted verbatim at committed positions', () => {
  const ctx = open('anchors.docx');
  const b = ctx.model.blocks().filter(isEditable)[1];
  const kids = b.el.children.map((c) => serialize(c));
  const items = identity(ctx, b);
  assert.deepStrictEqual(items.map((x) => x.kind), ['text', 'anchor', 'text', 'anchor', 'text', 'anchor', 'anchor', 'anchor', 'text']);
  const lookBefore = look(ctx, b);
  items[2] = { ...items[2], text: 'slow ' };            // "quick " -> "slow "
  items[4] = { ...items[4], text: 'red fox' };          // "brown fox" -> "red fox"
  const r = commit(ctx, b.id, items);
  const after = ctx.model.block(b.id).el.children.map((c) => serialize(c));
  assert.strictEqual(after.length, kids.length);
  for (let k = 0; k < kids.length; k++) {
    if (k === 2) assert.strictEqual(after[k], `<w:r>${WT('slow ')}</w:r>`);
    else if (k === 4) assert.strictEqual(after[k], `<w:r>${WT('red fox')}</w:r>`);
    else assert.strictEqual(after[k], kids[k], `child ${k} verbatim`);
  }
  // Anchor and block ids survive the commit (the island keeps using them).
  const itemsNow = identity(ctx, ctx.model.block(b.id));
  assert.deepStrictEqual(itemsNow.filter((x) => x.kind === 'anchor'), items.filter((x) => x.kind === 'anchor'));
  assert.deepStrictEqual(itemsNow.map((x) => x.src ?? x.id), items.map((x) => x.src ?? x.id), 'text segment ids survive too');
  assert.deepStrictEqual(look(ctx, ctx.model.block(b.id)).filter((x) => x.k), lookBefore.filter((x) => x.k));
  writeOut(OUT, 'anchors-text-edit.docx', r.bytes);

  // An inline image, a footnote reference, a hyperlink and fields: the atom is its source slice.
  for (const [name, find] of [['rich.docx', 'image'], ['rich.docx', 'footnote'], ['rich.docx', 'hyperlink'], ['fields.docx', 'field']]) {
    const c = open(name);
    const blk = c.model.blocks().filter(isEditable).find((x) => c.model.segments(x).some((s) => s.kind === 'atom' && s.atomType === find)
      && c.model.segments(x).some((s) => s.kind === 'text'));
    const atom = c.model.segments(blk).find((s) => s.kind === 'atom');
    const atomXml = atom.nodes.map((n) => serialize(n)).join('');
    const its = identity(c, blk);
    const ti = its.findIndex((x) => x.kind === 'text');
    its[ti] = { ...its[ti], text: 'Edited: ' + its[ti].text };
    const res = commit(c, blk.id, its);
    assert.strictEqual(res.outcome.reinsertedAtoms, false);
    assert.ok(res.pXml.includes(atomXml), `${name} ${find}: atom slice verbatim`);
    assert.strictEqual(res.edit.notices, undefined);
    assert.deepStrictEqual(identity(c, c.model.block(blk.id)).filter((x) => x.kind === 'atom'), its.filter((x) => x.kind === 'atom'), 'atom ids survive');
    writeOut(OUT, `atom-${find}-kept.docx`, res.bytes);
  }
});

test('select-all-and-type over an image keeps the image and raises the notice', () => {
  const ctx = open('rich.docx');
  const b = ctx.model.blocks().filter(isEditable).find((x) => {
    const s = ctx.model.segments(x);
    return s.length === 2 && s[0].kind === 'text' && s[1].kind === 'atom' && s[1].atomType === 'image';
  });
  const [text, image] = ctx.model.segments(b);
  const imageXml = image.nodes.map((n) => serialize(n)).join('');
  const r = commit(ctx, b.id, [T('Replaced everything', text.id)]);
  assert.strictEqual(r.outcome.reinsertedAtoms, true);
  assert.deepStrictEqual(r.edit.notices, [{ severity: 'warning', code: 'docx-atoms-kept', message: "Images, fields and links can't be deleted in this editor." }]);
  assert.ok(r.pXml.endsWith(`<w:r>${WT('Replaced everything')}</w:r>${imageXml}</w:p>`), 'the image follows its surviving predecessor');
  assert.deepStrictEqual(identity(ctx, ctx.model.block(b.id)).map((x) => x.kind), ['text', 'atom']);
  writeOut(OUT, 'image-kept.docx', r.bytes);

  // Only the chip deleted: the paragraph is exactly what it was, so there is no edit, and the caller is told.
  const kept = identity(ctx, ctx.model.block(b.id));
  const onlyChip = commit(ctx, b.id, kept.filter((x) => x.kind === 'text'));
  assert.deepStrictEqual(onlyChip.outcome, { ok: true, changed: false, changedBlockIds: [], reinsertedAtoms: true });

  // Everything deleted, nothing typed: the image alone, at the paragraph start.
  const now = ctx.model.block(b.id);
  const r2 = commit(ctx, now.id, []);
  assert.strictEqual(r2.outcome.reinsertedAtoms, true);
  assert.ok(r2.pXml.endsWith(`">${imageXml}</w:p>`));
  // A heading that starts with a floating image, all text replaced by text with no source.
  const h = ctx.model.blocks().filter(isEditable)[0];
  const hx = ctx.model.segments(h)[0].nodes.map((n) => serialize(n)).join('');
  const r3 = commit(ctx, h.id, [T('New title', null)]);
  assert.ok(r3.pXml.includes(`</w:pPr>${hx}<w:r>${WT('New title')}</w:r></w:p>`), 'no surviving predecessor: paragraph start');
  writeOut(OUT, 'image-only-kept.docx', r3.bytes);
  undoAll(ctx, [r.edit, r2.edit, r3.edit]);
});

test('dropped bookmark pair re-inserted start before end (anchors.docx); a dropped comment keeps range and reference', () => {
  const ctx = open('anchors.docx');
  const b = ctx.model.blocks().filter(isEditable)[1];
  const segs = ctx.model.segments(b);
  const xmlOf = (s) => serialize(s.node);
  const anchors = segs.filter((s) => s.kind === 'anchor');
  const [bmStart, cStart, bmEnd, cEnd, cRef] = anchors;
  assert.deepStrictEqual(anchors.map((a) => `${a.pairKey}/${a.role ?? 'ref'}`),
    ['bookmark:0/start', 'comment:1/start', 'bookmark:0/end', 'comment:1/end', 'comment:1/ref']);
  const texts = segs.filter((s) => s.kind === 'text');
  // The whole bookmarked range is deleted: only the first and last text survive.
  const r = commit(ctx, b.id, [T('The ', texts[0].id), T(texts[3].text, texts[3].id)]);
  assert.strictEqual(r.outcome.reinsertedAtoms, false, 'anchors are put back silently');
  assert.strictEqual(r.edit.notices, undefined);
  const first = serialize(texts[0].run);
  const last = serialize(texts[3].run);
  assert.ok(r.pXml.endsWith(`${first}${xmlOf(bmStart)}${xmlOf(cStart)}${xmlOf(bmEnd)}${xmlOf(cEnd)}${xmlOf(cRef)}${last}</w:p>`),
    'all five anchors after their surviving predecessor, in source order');
  writeOut(OUT, 'bookmark-range-deleted.docx', r.bytes);
  undoAll(ctx, [r.edit]);

  // Only the end marker comes back from the island, before where the start would be re-inserted:
  // the start is still placed before its end.
  const ctx2 = open('anchors.docx');
  const b2 = ctx2.model.blocks().filter(isEditable)[1];
  const s2 = ctx2.model.segments(b2);
  const a2 = s2.filter((s) => s.kind === 'anchor');
  const t2 = s2.filter((s) => s.kind === 'text');
  const r2 = commit(ctx2, b2.id, [{ kind: 'anchor', id: a2[2].id }, T('The ', t2[0].id), T('tail', t2[3].id)]);
  const order = [...r2.pXml.matchAll(/<w:(bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd)\b[^>]*w:id="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(order, ['bookmarkStart:0', 'bookmarkEnd:0', 'commentRangeStart:1', 'commentRangeEnd:1']);
  assert.ok(r2.pXml.includes(serialize(a2[4].node)), 'comment reference run kept');
  // Everything deleted in a paragraph that opens a bookmark closed elsewhere: the start stays.
  const b3 = ctx2.model.blocks().filter(isEditable)[3];
  const start3 = ctx2.model.segments(b3).find((s) => s.kind === 'anchor');
  const r3 = commit(ctx2, b3.id, []);
  assert.ok(r3.pXml.includes(serialize(start3.node)));
  writeOut(OUT, 'anchors-reinserted.docx', r3.bytes);
});

test('a mixed run (text, page break, text) is rebuilt as one run when one piece changes, kept as its slice when none does', async () => {
  const run = '<w:r w:rsidR="00C0FFEE"><w:rPr><w:i/></w:rPr><w:t>before</w:t><w:br w:type="page"/><w:lastRenderedPageBreak/><w:t>after</w:t></w:r>';
  const ctx = await docWithBody(`<w:p>${run}${R(' tail')}</w:p>`);
  const b = ctx.model.blocks()[0];
  const items = identity(ctx, b);
  assert.deepStrictEqual(items.map((x) => x.kind), ['text', 'atom', 'text', 'text']);
  // Only the other run changes: the mixed run is its source slice, layout hint included.
  const r = commit(ctx, b.id, [items[0], items[1], items[2], { ...items[3], text: ' TAIL' }]);
  assert.strictEqual(r.pXml, `<w:p>${run}<w:r>${WT(' TAIL')}</w:r></w:p>`);
  // One piece changes: a new run with the same properties holding text, break, text; no rsid, no stale layout hint.
  const now = identity(ctx, ctx.model.block(b.id));
  assert.deepStrictEqual(now.slice(0, 3), items.slice(0, 3), 'ids inside the slice run survive');
  const r2 = commit(ctx, b.id, [{ ...now[0], text: 'BEFORE' }, now[1], now[2], now[3]]);
  assert.strictEqual(r2.pXml, `<w:p><w:r><w:rPr><w:i/></w:rPr>${WT('BEFORE')}<w:br w:type="page"/>${WT('after')}</w:r><w:r>${WT(' TAIL')}</w:r></w:p>`);
  assert.deepStrictEqual(identity(ctx, ctx.model.block(b.id)).map((x) => x.src ?? x.id), now.map((x) => x.src ?? x.id), 'ids survive the rebuild');
  // The break dropped by the island: put back after its predecessor, inside a run with the run's properties.
  const cur = identity(ctx, ctx.model.block(b.id));
  const r3 = commit(ctx, b.id, [{ ...cur[0], text: 'B' }, cur[3]]);
  assert.strictEqual(r3.outcome.reinsertedAtoms, true);
  assert.strictEqual(r3.pXml, `<w:p><w:r><w:rPr><w:i/></w:rPr>${WT('B')}<w:br w:type="page"/></w:r><w:r>${WT(' TAIL')}</w:r></w:p>`);
});

// ---------------------------------------------------------------------------------------------------
// Rule 8 and input hygiene

test('w14:textId removed on change, paraId kept; other attributes and odd spacing survive', async () => {
  const ctx = open('basic.docx');
  const b = byText(ctx, 'A plain paragraph with ordinary text.');
  assert.ok(serialize(b.el).startsWith('<w:p w14:paraId="51B0BD62" w14:textId="045E354B">'));
  const [seg] = textSegs(ctx, b);
  const r = commit(ctx, b.id, [T('A plain paragraph with extraordinary text.', seg.id)]);
  assert.ok(r.pXml.startsWith('<w:p w14:paraId="51B0BD62"><w:r>'));
  writeOut(OUT, 'textid-removed.docx', r.bytes);

  const syn = await docWithBody(`<w:p  w14:textId='0A1B2C3D'  w:rsidR="00AA11BB" w14:paraId = "01020304" w:rsidP="00CC22DD" >${R('x')}</w:p>`);
  const sb = syn.model.blocks()[0];
  const s = commit(syn, sb.id, [T('y', textSegs(syn, sb)[0].id)]);
  assert.strictEqual(s.pXml, `<w:p  w:rsidR="00AA11BB" w14:paraId = "01020304" w:rsidP="00CC22DD" ><w:r>${WT('y')}</w:r></w:p>`);
});

test('illegal XML chars stripped', () => {
  const ctx = open('basic.docx');
  const b = byText(ctx, 'Final paragraph.');
  const [seg] = textSegs(ctx, b);
  const lone = String.fromCharCode(0xD800);
  const r = commit(ctx, b.id, [T(`a\u0000b\u0008c\u000Bd\u001Fe${lone}f${String.fromCharCode(0xFFFE)}g${String.fromCharCode(0xFFFF)} \u{1F600} ok`, seg.id)]);
  assert.strictEqual(r.pXml, `<w:p w14:paraId="71057103"><w:r>${WT('abcdefg \u{1F600} ok')}</w:r></w:p>`);
  // Text that is nothing but illegal characters is no text at all.
  const [now] = textSegs(ctx, ctx.model.block(b.id));
  const same = commit(ctx, b.id, [T('abcdefg \u{1F600} ok', now.id), T('\u0001\u0002', now.id, 'b')]);
  assert.strictEqual(same.outcome.changed, false);
  writeOut(OUT, 'illegal-chars.docx', r.bytes);
});

// ---------------------------------------------------------------------------------------------------
// Table cells

test('same tests on a cell paragraph of tables.docx: the rest of the table byte-identical', () => {
  const ctx = open('tables.docx');
  const cellBlocks = ctx.model.blocks().filter((b) => isEditable(b) && b.container.tableBlockId !== null);
  const mixed = cellBlocks.find((b) => textSegs(ctx, b).map((s) => s.text).join('') === 'plain bold italic');
  const table = ctx.model.block(mixed.container.tableBlockId);
  const tableBefore = serialize(table.el);
  const pBefore = serialize(mixed.el);
  const at = tableBefore.indexOf(pBefore);
  assert.ok(at > 0 && tableBefore.indexOf(pBefore, at + 1) < 0);
  const edits = [];

  // Unchanged.
  assert.strictEqual(commit(ctx, mixed.id, identity(ctx, mixed)).outcome.changed, false);
  // Text edit in one run; the others are slices.
  const items = identity(ctx, mixed);
  const runs = mixed.el.children.filter((c) => c.type === 'el' && c.local === 'r').map((r) => serialize(r));
  items[1] = { ...items[1], text: 'BOLD' };
  const r = commit(ctx, mixed.id, items);
  edits.push(r.edit);
  const runsNow = ctx.model.block(mixed.id).el.children.filter((c) => c.type === 'el' && c.local === 'r').map((x) => serialize(x));
  assert.deepStrictEqual([runsNow[0], runsNow[2], runsNow[3]], [runs[0], runs[2], runs[3]]);
  assert.ok(runsNow[1].endsWith(`${WT('BOLD')}</w:r>`));
  // commit() asserted G4 on the document; here: the table is its old text with the one paragraph replaced.
  assert.strictEqual(serialize(ctx.model.block(table.id).el), tableBefore.slice(0, at) + r.pXml + tableBefore.slice(at + pBefore.length));
  assert.strictEqual(ctx.model.block(mixed.id).container.tableBlockId, table.id, 'still in its cell');
  writeOut(OUT, 'cell-text-edit.docx', r.bytes);

  // Partial bold, tab/newline, src null in an empty cell paragraph, illegal characters: in cells.
  const now = textSegs(ctx, ctx.model.block(mixed.id));
  const r2 = commit(ctx, mixed.id, [T('pl', now[0].id), T('ai', now[0].id, 'b'), T('n\t\n ', now[0].id), ...identity(ctx, ctx.model.block(mixed.id)).slice(1)]);
  edits.push(r2.edit);
  assert.ok(r2.pXml.includes(`<w:r>${WT('pl')}</w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr>${WT('ai')}</w:r><w:r>${WT('n')}<w:tab/><w:br/>${WT(' ')}</w:r>`));
  const emptyCell = cellBlocks.find((b) => ctx.model.segments(b).length === 0 && paragraphProps(b.el).pPr === null);
  assert.ok(emptyCell, 'tables.docx has an empty cell paragraph');
  const r3 = commit(ctx, emptyCell.id, [T(`in${String.fromCharCode(0)} an empty cell`, null)]);
  edits.push(r3.edit);
  assert.ok(r3.pXml.endsWith(`<w:r>${WT('in an empty cell')}</w:r></w:p>`));
  // A list item in a cell and a paragraph of a nested table.
  const listItem = cellBlocks.find((b) => paragraphProps(b.el).numPr !== null);
  const pPr = serialize(paragraphProps(listItem.el).pPr);
  const r4 = commit(ctx, listItem.id, [T('Item 1', textSegs(ctx, listItem)[0].id, 'u')]);
  edits.push(r4.edit);
  assert.ok(r4.pXml.includes(`${pPr}<w:r><w:rPr><w:u w:val="single"/></w:rPr>${WT('Item 1')}</w:r>`), 'numbering properties verbatim');
  const nested = cellBlocks.find((b) => b.container.parent && b.container.parent.tableBlockId !== null && textSegs(ctx, b).length > 0);
  const r5 = commit(ctx, nested.id, [T('nested edit', textSegs(ctx, nested)[0].id)]);
  edits.push(r5.edit);
  writeOut(OUT, 'cell-edits.docx', r5.bytes);

  // Locked cell paragraphs are refused.
  const locked = ctx.model.blocks().filter((b) => b.kind === 'paragraph' && b.lockReason !== undefined);
  assert.ok(locked.some((b) => b.lockReason === 'merged-cell') && locked.some((b) => b.lockReason === 'tracked-changes'));
  for (const b of locked) {
    const out = commit(ctx, b.id, [T('nope', null)]).outcome;
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error.code, 'blocked');
  }
  assert.strictEqual(ctx.model.tableCensus(), ctx.model.loadTableCensus);
  undoAll(ctx, edits);
});

// ---------------------------------------------------------------------------------------------------
// Refusals

test('locked block is refused; so are opaque and unknown blocks, unknown ids and malformed items', async () => {
  const tracked = open('tracked.docx');
  const lockedBlock = tracked.model.blocks().find((b) => b.kind === 'paragraph' && b.lockReason === 'tracked-changes');
  let out = commit(tracked, lockedBlock.id, [T('x', null)]).outcome;
  assert.deepStrictEqual([out.ok, out.error.code], [false, 'blocked']);
  assert.match(out.error.message, /tracked changes/);
  assertG0(tracked.pkg);

  const fields = open('fields.docx');
  const toc = fields.model.blocks().find((b) => b.lockReason === 'multi-paragraph-field');
  out = commit(fields, toc.id, []).outcome;
  assert.deepStrictEqual([out.ok, out.error.code], [false, 'blocked']);

  const ctx = open('rich.docx');
  const table = ctx.model.blocks().find((b) => b.isTable);
  const sectPr = ctx.model.blocks().find((b) => b.kind === 'opaque' && !b.isTable);
  for (const b of [table, sectPr]) {
    out = commit(ctx, b.id, []).outcome;
    assert.deepStrictEqual([out.ok, out.error.code], [false, 'blocked']);
  }
  const eb = new EditBuilder(ctx.pkg, 'Edit Paragraph');
  out = commitParagraph(eb, ctx.model, ctx.styles, 987654, []);
  assert.deepStrictEqual([out.ok, out.error.code], [false, 'stale']);
  assert.strictEqual(eb.finish(), null);

  const b = ctx.model.blocks().filter(isEditable).find((x) => ctx.model.segments(x).some((s) => s.kind === 'atom') && textSegs(ctx, x).length > 0);
  const other = ctx.model.blocks().filter(isEditable).find((x) => x !== b && textSegs(ctx, x).length > 0);
  const seg = textSegs(ctx, b)[0];
  const atom = ctx.model.segments(b).find((s) => s.kind === 'atom');
  const bad = [
    [T('x', 424242)],                                                 // unknown src
    [T('x', textSegs(ctx, other)[0].id)],                            // a segment of another paragraph
    [T('x', atom.id)],                                                // an atom id as src
    [{ kind: 'atom', id: seg.id }],                                   // a text id as atom
    [{ kind: 'anchor', id: atom.id }],                                // an atom id as anchor
    [{ kind: 'atom', id: atom.id }, { kind: 'atom', id: atom.id }],   // the same atom twice
    [{ kind: 'text', text: 5, b: false, i: false, u: false, src: null }],
    [{ kind: 'text', text: 'x', b: 'yes', i: false, u: false, src: null }],
    [{ kind: 'text', text: 'x', b: false, i: false, u: false }],     // src missing
    [{ kind: 'image', id: atom.id }],
    [null],
    'not an array',
  ];
  for (const items of bad) {
    out = commit(ctx, b.id, items, { skipReload: true }).outcome;
    assert.deepStrictEqual([out.ok, out.error.code], [false, 'invalid'], JSON.stringify(items));
  }
  assertG0(ctx.pkg);

  // A Block object from before a refresh that replaced the paragraph is stale.
  const live = open('basic.docx');
  const blk = byText(live, 'Final paragraph.');
  const stale = { ...blk };
  commit(live, blk.id, [T('changed', textSegs(live, blk)[0].id)]);
  const res = buildParagraphXml(live.model, live.styles, stale, []);
  assert.strictEqual(res.code, 'stale');

  // View-only documents are refused outright.
  const viewOnly = open('strict.docx', await patched((t) => t.replace(/http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main/g, 'http://purl.oclc.org/ooxml/wordprocessingml/main')));
  assert.ok(viewOnly.model.viewOnlyReason);
  out = commitParagraph(new EditBuilder(viewOnly.pkg, 'Edit Paragraph'), viewOnly.model, viewOnly.styles, 1, []);
  assert.deepStrictEqual([out.ok, out.error.code], [false, 'read-only']);
});

test('a paragraph whose markup needs a prefix the root does not bind is refused, not rewritten', async () => {
  // The prefix `x` is declared on the body only: new markup is written with the root's bindings.
  const bytes = await patched((t) => {
    const a = t.indexOf('<w:body>');
    return t.slice(0, a) + '<w:body xmlns:x="urn:example:x"><w:p x:mark="1">' + R('abc') + '</w:p>' + t.slice(t.indexOf('<w:sectPr', a));
  });
  const ctx = open('scoped.docx', bytes);
  const b = ctx.model.blocks()[0];
  assert.ok(isEditable(b));
  const out = commit(ctx, b.id, [T('abcd', textSegs(ctx, b)[0].id)]).outcome;
  assert.deepStrictEqual([out.ok, out.error.code], [false, 'blocked']);
  assertG0(ctx.pkg);

  // A prefix the body binds to something else: the paragraph's own attribute would change meaning
  // under the root's bindings. Refused; the package still saves as the original bytes.
  const bytes2 = await patched((t) => {
    const a = t.indexOf('<w:body>');
    return t.slice(0, a) + '<w:body xmlns:w14="urn:example:other"><w:p w14:paraId="00000001">' + R('abc') + '</w:p>' + t.slice(t.indexOf('<w:sectPr', a));
  });
  const ctx2 = open('rebound.docx', bytes2);
  const b2 = ctx2.model.blocks()[0];
  assert.ok(isEditable(b2));
  const out2 = commit(ctx2, b2.id, [T('abcd', textSegs(ctx2, b2)[0].id)]).outcome;
  assert.deepStrictEqual([out2.ok, out2.error.code], [false, 'blocked']);
  assert.strictEqual(ctx2.pkg.serialize(), ctx2.orig, 'serialises to the original bytes object');
});

// ---------------------------------------------------------------------------------------------------
// Ids across commits (the island is not rebuilt after an idle commit)

test('later commits may keep naming the segment ids the island was built from', () => {
  const ctx = open('basic.docx');
  const b = byText(ctx, 'This paragraph has bold, italic and underlined text.');
  const first = identity(ctx, b);
  const ids = first.map((x) => x.src);
  // 1. Bold on part of the first run; the "bold" run's text deleted altogether.
  const c1 = [T('This ', ids[0]), T('paragraph', ids[0], 'b'), T(' has ', ids[0]), ...first.slice(2)];
  const r1 = commit(ctx, b.id, c1);
  const afterFirst = r1.pXml;
  // 2. The island sends the very same items again (idle commit, nothing typed): nothing to do.
  const r2 = commit(ctx, b.id, c1);
  assert.strictEqual(r2.outcome.changed, false, 'same items, old ids: no edit');
  assert.strictEqual(serialize(ctx.model.block(b.id).el), afterFirst);
  // 3. More typing, still with the old ids, including the id whose run no longer exists (ids[1], bold).
  const c3 = [T('This ', ids[0]), T('paragraph', ids[0], 'b'), T(' has ', ids[0]), T('BOLD AGAIN', ids[1], 'b'), ...first.slice(2)];
  const r3 = commit(ctx, b.id, c3);
  const boldRun = [...r3.pXml.matchAll(/<w:r>(?:<w:rPr>((?:(?!<\/w:rPr>).)*)<\/w:rPr>)?<w:t xml:space="preserve">BOLD AGAIN<\/w:t><\/w:r>/g)];
  assert.strictEqual(boldRun.length, 1);
  assert.match(boldRun[0][1], /^<w:b\/>(<w:bCs\/>)?$/, 'the retired run\'s own rPr (bold), not a guess');
  assert.deepStrictEqual(look(ctx, ctx.model.block(b.id)).slice(0, 4), [{ t: 'This ', f: '' }, { t: 'paragraph', f: 'b' }, { t: ' has ', f: '' }, { t: 'BOLD AGAIN', f: 'b' }]);
  // An id that never existed is still refused.
  const out = commit(ctx, b.id, [T('x', 9999999)]).outcome;
  assert.strictEqual(out.error.code, 'invalid');
  writeOut(OUT, 'repeated-commits.docx', r3.bytes);
  undoAll(ctx, [r1.edit, r3.edit]);
  // After undo the original nodes (and ids) are back: the first commit's items apply again as before.
  const again = commit(ctx, b.id, c1);
  assert.strictEqual(again.pXml, afterFirst);
});

// ---------------------------------------------------------------------------------------------------
// Options for the structure writers (WP-29/30)

test('buildParagraphXml options: pPrXml, keepIds:false and omit', async () => {
  const run = (t) => `<w:r w:rsidR="00AB0001">${`<w:t xml:space="preserve">${t}</w:t>`}</w:r>`;
  const ctx = await docWithBody(`<w:p w:rsidR="00AB0001" w:rsidP="00AB0002" w14:paraId="0000AAAA" w14:textId="0000BBBB"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('first ')}<w:bookmarkStart w:id="7" w:name="bm"/>${run('second')}<w:bookmarkEnd w:id="7"/></w:p>`);
  const b = ctx.model.blocks()[0];
  const items = identity(ctx, b);
  // Unchanged content with keepIds false: a new paragraph's start tag; runs are still slices.
  const half = buildParagraphXml(ctx.model, ctx.styles, b, items.slice(2), { keepIds: false, pPrXml: '', omit: new Set([items[1].id]) });
  assert.strictEqual(half.xml, `<w:p>${run('second')}<w:bookmarkEnd w:id="7"/></w:p>`);
  assert.strictEqual(half.contentXml, `${run('second')}<w:bookmarkEnd w:id="7"/>`);
  assert.strictEqual(half.changed, true);
  // The other half: the omitted end marker is not put back; without `omit` it is.
  const head = buildParagraphXml(ctx.model, ctx.styles, b, items.slice(0, 2), { omit: new Set([items[3].id]) });
  assert.strictEqual(head.xml, `<w:p w:rsidR="00AB0001" w:rsidP="00AB0002" w14:paraId="0000AAAA"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('first ')}<w:bookmarkStart w:id="7" w:name="bm"/></w:p>`);
  const kept = buildParagraphXml(ctx.model, ctx.styles, b, items.slice(0, 2));
  assert.ok(kept.xml.endsWith(`<w:bookmarkStart w:id="7" w:name="bm"/><w:bookmarkEnd w:id="7"/></w:p>`));
  // A replacement pPr with unchanged content keeps w14:textId (the content hash still holds).
  const restyled = buildParagraphXml(ctx.model, ctx.styles, b, items, { pPrXml: '<w:pPr><w:jc w:val="center"/></w:pPr>' });
  assert.strictEqual(restyled.xml, `<w:p w:rsidR="00AB0001" w:rsidP="00AB0002" w14:paraId="0000AAAA" w14:textId="0000BBBB"><w:pPr><w:jc w:val="center"/></w:pPr>${run('first ')}<w:bookmarkStart w:id="7" w:name="bm"/>${run('second')}<w:bookmarkEnd w:id="7"/></w:p>`);
  assert.strictEqual(restyled.changed, true);
  // Nothing was written by any of this.
  assert.deepStrictEqual(ctx.pkg.touchedParts(), []);
  for (const built of [half, head, kept, restyled]) assert.strictEqual(parseFragment(ctx.pkg.xml(ctx.model.mainPart), built.xml).length, 1);
});

// ---------------------------------------------------------------------------------------------------
// Pretty-printed source

test('pretty-printed document: whitespace between runs is dropped inside the edited paragraph only', async () => {
  const ctx = open('pretty.docx', await prettyDocx());
  assert.strictEqual(ctx.model.viewOnlyReason, null);
  const blocks = ctx.model.blocks().filter((b) => isEditable(b) && textSegs(ctx, b).length > 0);
  assert.ok(blocks.length > 0);
  const b = blocks[0];
  assert.strictEqual(commit(ctx, b.id, identity(ctx, b)).outcome.changed, false);
  const items = identity(ctx, b);
  const k = items.findIndex((x) => x.kind === 'text');
  items[k] = { ...items[k], text: items[k].text + ' (edited)' };
  const r = commit(ctx, b.id, items);
  assert.ok(!/>\s+</.test(r.pXml.replace(/<w:pPr>.*?<\/w:pPr>/s, '')), 'no inter-element whitespace left in the rebuilt paragraph');
  writeOut(OUT, 'pretty-edit.docx', r.bytes);
  undoAll(ctx, [r.edit]);
});

// ---------------------------------------------------------------------------------------------------
// Round trips over the fixtures

/** One of a few plausible edits to paragraph `b`, chosen by `rand`; null when the paragraph offers none. */
function randomEdit(ctx, b, rand) {
  const items = identity(ctx, b);
  const texts = items.map((x, k) => (x.kind === 'text' ? k : -1)).filter((k) => k >= 0);
  const pick = Math.floor(rand() * 7);
  if (texts.length === 0) {
    const out = items.slice();
    out.splice(Math.floor(rand() * (items.length + 1)), 0, T(pick % 2 ? 'typed text' : 'typed\ttext\n', null, pick % 3 === 0 ? 'b' : ''));
    return out;
  }
  const k = texts[Math.floor(rand() * texts.length)];
  const it = items[k];
  const mid = Math.floor(it.text.length / 2);
  switch (pick) {
    case 0: items[k] = { ...it, text: it.text + ' more' }; return items;
    case 1: items[k] = { ...it, text: it.text.slice(0, mid) + 'XY' + it.text.slice(mid) }; return items;
    case 2: if (it.text.length < 2) return null;
      items.splice(k, 1, { ...it, text: it.text.slice(0, mid) }, { ...it, text: it.text.slice(mid), b: !it.b });
      return items;
    case 3: items[k] = { ...it, i: !it.i, u: !it.u }; return items;
    case 4: items.splice(k, 1); return items;                               // text deleted
    case 5: return [T('everything replaced', it.src, it.b ? 'b' : '')];     // select all and type: atoms/anchors must come back
    default: items.splice(k + 1, 0, T(' inserted\t', it.src, 'i')); return items;
  }
}

test('round trip over the editable paragraphs of every docx fixture: edit → save → reload reads the edit; unchanged paragraphs byte-identical; undo of everything → byte-identical package', () => {
  let committed = 0;
  for (const name of allFixtures('docx')) {
    let ctx;
    try { ctx = open(name); } catch { continue; }
    if (ctx.model.viewOnlyReason) continue;
    const rand = rng(0x28 + name.length);
    const editable = ctx.model.blocks().filter(isEditable).map((b) => b.id);
    const step = editable.length > 400 ? 37 : editable.length > 100 ? 5 : 1;
    const untouched = new Map(ctx.model.blocks().map((b) => [b.id, serialize(b.el)]));
    const edits = [];
    for (let n = 0; n < editable.length; n += step) {
      const b = ctx.model.block(editable[n]);
      const items = randomEdit(ctx, b, rand);
      if (!items) continue;
      const atomsBefore = identity(ctx, b).filter((x) => x.kind !== 'text').map((x) => x.id).sort();
      const r = commit(ctx, b.id, items, { light: editable.length > 100 });
      if (!r.edit) continue;
      edits.push(r.edit);
      untouched.delete(b.id);
      committed++;
      // Nothing dropped, whatever the items said.
      const atomsAfter = identity(ctx, ctx.model.block(b.id)).filter((x) => x.kind !== 'text').map((x) => x.id).sort();
      assert.deepStrictEqual(atomsAfter, atomsBefore, `${name} block ${b.id}: every atom and anchor still there, same ids`);
    }
    assert.ok(edits.length > 0, `${name}: at least one paragraph edited`);
    // Unchanged paragraphs (and every opaque block except tables holding edited cells) are byte-identical.
    for (const blk of ctx.model.blocks()) {
      const was = untouched.get(blk.id);
      if (was === undefined || blk.isTable) continue;
      assert.strictEqual(serialize(blk.el), was, `${name} block ${blk.id} untouched`);
    }
    const bytes = ctx.pkg.serialize();
    assertG3(ctx.orig, bytes, [ctx.model.mainPart]);
    saxesOk(mainText(ctx));
    // Reload the saved file: every block reads what the live model reads.
    const re = open(name, bytes);
    const live = ctx.model.blocks();
    const loaded = re.model.blocks();
    assert.strictEqual(loaded.length, live.length);
    for (let k = 0; k < live.length; k++) {
      assert.strictEqual(loaded[k].lockReason, live[k].lockReason, `${name} block #${k} lock`);
      if (isEditable(live[k])) assert.deepStrictEqual(look(re, loaded[k]), look(ctx, live[k]), `${name} block #${k}`);
    }
    assert.strictEqual(re.model.tableCensus(), ctx.model.loadTableCensus, `${name}: table census`);
    writeOut(OUT, `roundtrip-${name}`, bytes);
    undoAll(ctx, edits);
  }
  assert.ok(committed > 150, `committed ${committed} paragraph edits`);
});

test('seeded 200-commit random sequence over multi-run, anchors, rich and tables: each step G3–G5, then undo everything → identical bytes', () => {
  for (const name of ['multi-run.docx', 'anchors.docx', 'rich.docx', 'tables.docx']) {
    const ctx = open(name);
    const rand = rng(20261121 + name.length);
    const ids = ctx.model.blocks().filter(isEditable).map((b) => b.id);
    const edits = [];
    const marks = ctx.model.blocks().filter(isEditable).flatMap((b) => identity(ctx, b).filter((x) => x.kind !== 'text').map((x) => x.id)).sort();
    for (let n = 0; n < 200; n++) {
      const b = ctx.model.block(ids[Math.floor(rand() * ids.length)]);
      const items = randomEdit(ctx, b, rand);
      if (!items) continue;
      const r = commit(ctx, b.id, items, { light: n % 10 !== 0 });
      if (r.edit) edits.push(r.edit);
      // Sometimes undo the last few and carry on from there.
      if (edits.length > 3 && rand() < 0.1) {
        for (let k = 0; k < 3; k++) applyEdit(ctx.pkg, invertEdit(edits.pop()));
        ctx.model.refresh();
      }
    }
    const marksNow = ctx.model.blocks().filter(isEditable).flatMap((b) => identity(ctx, b).filter((x) => x.kind !== 'text').map((x) => x.id)).sort();
    assert.deepStrictEqual(marksNow, marks, `${name}: no atom or anchor lost or duplicated in 200 commits`);
    assert.strictEqual(ctx.model.tableCensus(), ctx.model.loadTableCensus);
    const bytes = ctx.pkg.serialize();
    assertG3(ctx.orig, bytes, [ctx.model.mainPart]);
    saxesOk(mainText(ctx));
    const re = open(name, bytes);
    assert.deepStrictEqual(re.model.blocks().filter(isEditable).map((x) => look(re, x)), ctx.model.blocks().filter(isEditable).map((x) => look(ctx, x)), `${name}: reload reads the same`);
    writeOut(OUT, `random-200-${name}`, bytes);
    undoAll(ctx, edits);
  }
});
