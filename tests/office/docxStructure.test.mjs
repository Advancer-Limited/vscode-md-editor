// WP-29: paragraph structure operations (src/office/core/docx/ops.ts). Spec §8.5 (incl. Containers),
// §13.2 G3/G4/G5/G6.
//
// Every operation goes through `apply()`, which asserts for the edit it made:
//   G3  only the main part's entry differs from the file as opened;
//   G4  the main part's text is the text before the operation outside the span of the `w:p`
//       elements the caller names (per-op tests additionally assert the exact new text);
//   G5  undo serialises to the bytes before the operation, redo to the bytes after it, and block
//       ids survive the round trip;
//   G6  the output passes packageValidator + docxValidator (serialise-and-verify, as at save time),
//       is well-formed for an independent parser (saxes), and an independent reload reads the same
//       blocks and text as the live model;
//   table census unchanged; `changedBlockIds` and `focus` name live blocks.
// Outputs go to tests/.out/docxStructure/ for scripts/verify-office-open.ps1 -Kind Word.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { core, fixture, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG0, assertG3, assertG5, prettyDocx, rng } from './_roundtrip.mjs';

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
const { applyDocxEdit, blockInfos, LABELS } = core.docx.ops;

const OUT = 'docxStructure';
const MAIN = 'word/document.xml';
const CHIP = String.fromCodePoint(0xFFFC);

// ---------------------------------------------------------------------------------------------------
// Harness

function open(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  const model = DocxModel.load(pkg);
  const styles = DocxStyles.load(pkg, model.mainPart);
  const numbering = DocxNumbering.load(pkg, model.mainPart);
  return { name, pkg, model, styles, numbering, orig: bytes };
}

/** `from` with `fn(text)` applied to one part. */
async function patched(fn, from = 'basic.docx', part = MAIN) {
  const zip = await JSZip.loadAsync(fixture(from));
  zip.file(part, fn(await zip.file(part).async('string')));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** A document whose body is exactly `bodyXml` + the final sectPr (root and namespaces from basic.docx). */
async function docWithBody(bodyXml, name = 'synthetic.docx') {
  const bytes = await patched((t) => {
    const a = t.indexOf('<w:body>');
    const b = t.lastIndexOf('<w:sectPr');
    assert.ok(a > 0 && b > a);
    return t.slice(0, a + 8) + bodyXml + t.slice(b);
  });
  return open(name, bytes);
}

const mainText = (ctx) => serialize(ctx.pkg.xml(ctx.model.mainPart));

/** Offset of `node`'s text in its serialised document. */
function offsetOf(doc, node) {
  const text = serialize(doc);
  let off = text.indexOf(serialize(doc.root));
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

/** What a paragraph reads: text, a chip per atom; anchors are invisible. */
function textOf(ctx, b) {
  return ctx.model.segments(b).map((s) => (s.kind === 'text' ? s.text : s.kind === 'atom' ? CHIP : '')).join('');
}
const itemsText = (items) => items.map((it) => (it.kind === 'text' ? it.text : it.kind === 'atom' ? CHIP : '')).join('');

/** One entry per block, in document order: the text of an editable paragraph, else a marker. */
function reading(ctx) {
  return ctx.model.blocks().map((b) => (isEditable(b) ? 'P:' + textOf(ctx, b) : b.kind === 'paragraph' ? `L:${b.lockReason}` : `O:${b.el.rawName}`));
}
const indexOfBlock = (ctx, id) => ctx.model.blocks().findIndex((b) => b.id === id);

/** The commit items that mean "this paragraph as it is" (what the island sends untouched). */
function identity(ctx, b) {
  const pStyle = paragraphProps(b.el).pStyleId;
  const out = [];
  for (const s of ctx.model.segments(b)) {
    if (s.kind === 'text') out.push({ kind: 'text', text: s.text, ...ctx.styles.effectiveToggles(pStyle, s.rPr), src: s.id });
    else if (s.kind === 'atom' || s.kind === 'anchor') out.push({ kind: s.kind, id: s.id });
  }
  return out;
}

/** Cut commit items at caret unit `k` (a character or chip is 1, an anchor 0). */
function cut(items, k) {
  const before = [];
  const after = [];
  let n = 0;
  for (const it of items) {
    const len = it.kind === 'text' ? it.text.length : it.kind === 'atom' ? 1 : 0;
    if (len === 0) { (n < k ? before : after).push(it); continue; }
    if (n + len <= k) before.push(it);
    else if (n >= k) after.push(it);
    else {
      before.push({ ...it, text: it.text.slice(0, k - n) });
      after.push({ ...it, text: it.text.slice(k - n) });
    }
    n += len;
  }
  return { before, after };
}
const unitsOfItems = (items) => items.reduce((n, it) => n + (it.kind === 'text' ? it.text.length : it.kind === 'atom' ? 1 : 0), 0);

function byText(ctx, text, nth = 0) {
  const hits = ctx.model.blocks().filter((b) => isEditable(b) && textOf(ctx, b) === text);
  assert.ok(hits.length > nth, `an editable paragraph reads "${text}"`);
  return hits[nth];
}

/** [start, end) in the main part's text covering the elements of `blockIds` (and `at` insertion points). */
function spanOf(ctx, blockIds, points = []) {
  const doc = ctx.pkg.xml(ctx.model.mainPart);
  let start = Infinity;
  let end = -1;
  for (const id of blockIds) {
    const b = ctx.model.block(id);
    assert.ok(b, `block ${id} exists`);
    const s = offsetOf(doc, b.el);
    start = Math.min(start, s);
    end = Math.max(end, s + serialize(b.el).length);
  }
  for (const p of points) { start = Math.min(start, p); end = Math.max(end, p); }
  return { start, end };
}

/** Offset just after block `id` (where insertParagraphAfter puts the new paragraph). */
function endOf(ctx, id) {
  const b = ctx.model.block(id);
  return offsetOf(ctx.pkg.xml(ctx.model.mainPart), b.el) + serialize(b.el).length;
}

function verifyOutput(ctx, what) {
  const v = serializeAndVerify(ctx.pkg, [packageValidator, docxValidator]);
  assert.ok(v.ok, `${what}: validators: ${v.ok ? '' : JSON.stringify(v.failures)}`);
  return v.bytes;
}

/**
 * Apply `op` and assert everything in the header. `opts.affected`: ids (before the op) of the blocks
 * whose `w:p` may change; `opts.points`: extra offsets where text may be inserted; `opts.light`:
 * text-level checks only (long sequences); `opts.expect`: the reading (see `reading`) afterwards.
 */
function apply(ctx, op, opts = {}) {
  const { pkg, model } = ctx;
  const main = model.mainPart;
  const doc = pkg.xml(main);
  const light = opts.light === true;
  const beforeText = serialize(doc);
  const beforeBytes = light ? null : pkg.serialize();
  const beforeReading = reading(ctx);
  const census = model.tableCensus();
  const span = opts.affected ? spanOf(ctx, opts.affected, opts.points) : null;

  const out = applyDocxEdit(ctx, op);
  if (!out.ok || out.edit === null) {
    assert.strictEqual(serialize(doc), beforeText, 'nothing changed');
    assert.deepStrictEqual(reading(ctx), beforeReading, 'the model reads the same');
    if (!light) assertBytesEqual(pkg.serialize(), beforeBytes, 'bytes unchanged');
    return { out, bytes: beforeBytes, afterText: beforeText, beforeText };
  }
  const edit = out.edit;
  const afterText = serialize(doc);
  assert.notStrictEqual(afterText, beforeText, 'an edit changes the text');
  // Only the main part.
  assert.deepStrictEqual([...new Set(edit.changes.map((c) => c.part))], [main], 'changes are in the main part only');
  assert.deepStrictEqual(pkg.touchedParts(), [main]);
  // G4: nothing outside the named paragraphs.
  if (span) {
    assert.strictEqual(afterText.slice(0, span.start), beforeText.slice(0, span.start), 'G4: text before the affected paragraphs is untouched');
    const tail = beforeText.length - span.end;
    assert.ok(afterText.length >= span.start + tail, 'G4: text outside the span was removed');
    assert.strictEqual(afterText.slice(afterText.length - tail), beforeText.slice(span.end), 'G4: text after the affected paragraphs is untouched');
  }
  assert.strictEqual(model.tableCensus(), census, 'table census unchanged');
  // Result shape.
  const infos = blockInfos(ctx);
  const ids = new Set(infos.map((i) => i.id));
  for (const id of out.changedBlockIds) assert.ok(ids.has(id), `changedBlockIds names a live block (${id})`);
  assert.strictEqual(new Set(out.changedBlockIds).size, out.changedBlockIds.length, 'changedBlockIds has no duplicates');
  if (out.focus) {
    const f = model.block(out.focus.blockId);
    assert.ok(f && isEditable(f), 'focus names an editable block');
    if (typeof out.focus.at === 'number') assert.ok(out.focus.at >= 0 && out.focus.at <= unitsOfItems(identity(ctx, f)), 'focus offset is inside the paragraph');
  }
  // Every cell still ends with a paragraph (also a validator rule; asserted directly here).
  for (const t of model.blocks().filter((b) => b.isTable)) {
    for (const c of model.cells(t)) {
      const inCell = model.blocksIn(c);
      assert.ok(inCell.length > 0 && inCell[inCell.length - 1].kind === 'paragraph', 'every cell ends with a paragraph');
    }
  }
  const afterReading = reading(ctx);
  if (opts.expect) assert.deepStrictEqual(afterReading, opts.expect, 'the document reads as expected');

  let bytes = null;
  if (light) {
    applyEdit(pkg, invertEdit(edit));
    assert.strictEqual(serialize(doc), beforeText, 'G5 (text): undo restores the main part');
    applyEdit(pkg, edit);
    assert.strictEqual(serialize(doc), afterText, 'G5 (text): redo restores the edit');
  } else {
    saxesOk(afterText);
    bytes = pkg.serialize();
    assertG3(ctx.orig, bytes, [main]);
    assertG5(pkg, edit, beforeBytes);
  }
  model.refresh();
  assert.deepStrictEqual(blockInfos(ctx), infos, 'undo then redo brings back the same blocks with the same ids');
  if (!light) {
    assertBytesEqual(verifyOutput(ctx, op.op), bytes, 'verified bytes are the serialised bytes');
    const re = open('reload.docx', bytes);
    assert.deepStrictEqual(reading(re), afterReading, 'reload reads the same blocks and text');
    assert.deepStrictEqual(blockInfos(re).map(({ id, parentId, ...rest }) => rest), infos.map(({ id, parentId, ...rest }) => rest),
      'reload gives the same block infos');
  }
  return { out, edit, bytes, afterText, beforeText };
}

/** `apply` for an operation that must be refused with `code`; asserts nothing changed. */
function refused(ctx, op, code, re) {
  const { out } = apply(ctx, op);
  assert.strictEqual(out.ok, false, `${op.op} must be refused`);
  assert.strictEqual(out.error.code, code, out.error.message);
  if (re) assert.match(out.error.message, re);
  return out.error;
}

function undoAll(ctx, edits) {
  for (let k = edits.length - 1; k >= 0; k--) applyEdit(ctx.pkg, invertEdit(edits[k]));
  ctx.model.refresh();
  assertBytesEqual(ctx.pkg.serialize(), ctx.orig, 'undo of everything is the original file');
}

const pXml = (ctx, id) => serialize(ctx.model.block(id).el);
const info = (ctx, id) => blockInfos(ctx).find((i) => i.id === id);
const R = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const WT = (s) => `<w:t xml:space="preserve">${s}</w:t>`;
const count = (text, needle) => text.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------------
// blockInfos

test('blockInfos: kind, parentId/cell, lock, style, list and removable for basic.docx and tables.docx', () => {
  const basic = open('basic.docx');
  const bi = blockInfos(basic);
  assert.strictEqual(bi.length, basic.model.blocks().length);
  assert.deepStrictEqual(bi.map((i) => i.id), basic.model.blocks().map((b) => b.id), 'document order');
  const row = (ctx, text) => { const i = info(ctx, byText(ctx, text).id); return [i.kind, i.parentId, i.editable, i.removable, i.style.kind, i.style.level ?? 0, i.list.kind]; };
  assert.deepStrictEqual(row(basic, 'Heading One'), ['paragraph', null, true, true, 'heading', 1, 'none']);
  assert.deepStrictEqual(row(basic, 'A plain paragraph with ordinary text.'), ['paragraph', null, true, true, 'normal', 0, 'none']);
  assert.deepStrictEqual(row(basic, 'Bullet two'), ['paragraph', null, true, true, 'other', 0, 'bullet']);
  assert.deepStrictEqual(row(basic, 'Step two'), ['paragraph', null, true, true, 'other', 0, 'number']);
  const sect = bi[bi.length - 1];
  assert.deepStrictEqual({ ...sect, id: 0 }, { id: 0, kind: 'opaque', parentId: null, editable: false, lockReason: 'opaque', removable: false,
    style: { kind: 'other', name: '' }, list: { kind: 'none', level: 0 } });
  assert.ok(!('cell' in bi[0]), 'a body block has no cell');

  const t = open('tables.docx');
  const ti = blockInfos(t);
  const tables = ti.filter((i) => i.kind === 'opaque' && t.model.block(i.id).isTable);
  assert.ok(tables.length >= 6);
  for (const i of tables) assert.deepStrictEqual([i.editable, i.removable, i.lockReason], [false, false, 'opaque']);
  const cellP = info(t, byText(t, 'second cell').id);
  assert.deepStrictEqual([cellP.parentId, cellP.cell, cellP.removable], [tables[0].id, { row: 0, col: 1 }, false], 'the only paragraph of a cell is not removable');
  assert.deepStrictEqual(info(t, byText(t, 'two').id).cell, { row: 1, col: 0 });
  assert.strictEqual(info(t, byText(t, 'two').id).removable, true, 'one of two paragraphs in a cell is removable');
  assert.strictEqual(info(t, byText(t, 'Item two').id).list.kind, 'bullet', 'list in a cell');
  // Nested table: its block sits in the outer cell; its cells' paragraphs name the nested table.
  const holder = byText(t, 'outer 2,1 (ends in a nested table)');
  const nested = t.model.siblings(holder).next;
  assert.ok(nested.isTable);
  assert.deepStrictEqual([info(t, nested.id).parentId, info(t, nested.id).cell], [info(t, holder.id).parentId, { row: 1, col: 0 }]);
  assert.strictEqual(info(t, byText(t, 'in 1,1').id).parentId, nested.id);
  const tail = t.model.siblings(nested).next;
  assert.strictEqual(info(t, tail.id).removable, false, "a cell's last paragraph after a nested table is not removable");
  assert.strictEqual(info(t, holder.id).removable, true, 'the paragraph before the nested table is (the cell still ends with a paragraph)');
  const merged = ti.filter((i) => i.lockReason === 'merged-cell');
  assert.ok(merged.length > 0);
  for (const i of merged) assert.deepStrictEqual([i.editable, i.removable], [false, false]);
  // Atoms and section breaks.
  const rich = open('rich.docx');
  assert.strictEqual(info(rich, byText(rich, 'Paragraph with an inline picture: ' + CHIP).id).removable, false);
  const sectP = rich.model.blocks().find((b) => b.kind === 'paragraph' && paragraphProps(b.el).hasSectPr);
  assert.strictEqual(info(rich, sectP.id).removable, false);
  for (const ctx of [basic, t, rich]) assertG0(ctx.pkg, ctx.name);
});

// ---------------------------------------------------------------------------------------------------
// Split

test('split: pPr copied, no paraId/textId/rsid on the new p; the first half keeps its id and paraId', async () => {
  const ctx = await docWithBody(
    '<w:p w14:paraId="11111111" w14:textId="22222222" w:rsidR="00AA0001" w:rsidRDefault="00AA0002" w:rsidP="00AA0003">'
    + '<w:pPr><w:keepNext/><w:spacing w:after="120"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'
    + '<w:r w:rsidR="00AA0004"><w:rPr><w:i/></w:rPr><w:t>Hello world</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Tail</w:t></w:r></w:p>');
  const b = byText(ctx, 'Hello world');
  const { before, after } = cut(identity(ctx, b), 6);
  const pPr = '<w:pPr><w:keepNext/><w:spacing w:after="120"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>';
  const { out, edit, bytes, afterText, beforeText } = apply(ctx, { op: 'splitParagraph', blockId: b.id, before, after },
    { affected: [b.id], expect: ['P:Hello ', 'P:world', 'P:Tail', 'O:w:sectPr'] });
  assert.strictEqual(edit.label, 'Split Paragraph');
  const blocks = ctx.model.blocks();
  assert.strictEqual(blocks[0].id, b.id, 'the first half keeps the block id');
  assert.deepStrictEqual(out.changedBlockIds, [b.id, blocks[1].id]);
  assert.deepStrictEqual(out.focus, { blockId: blocks[1].id, at: 'start' });
  assert.strictEqual(pXml(ctx, b.id),
    `<w:p w14:paraId="11111111" w:rsidR="00AA0001" w:rsidRDefault="00AA0002" w:rsidP="00AA0003">${pPr}<w:r><w:rPr><w:i/></w:rPr>${WT('Hello ')}</w:r></w:p>`,
    'first half: attributes kept, textId dropped (content changed), pPr verbatim');
  assert.strictEqual(pXml(ctx, blocks[1].id), `<w:p>${pPr}<w:r><w:rPr><w:i/></w:rPr>${WT('world')}</w:r></w:p>`,
    'second half: a copy of pPr, no paraId/textId/rsid');
  // G4, exactly: the one w:p became two.
  const start = beforeText.indexOf('<w:p w14:paraId="11111111"');
  const end = beforeText.indexOf('<w:p><w:r><w:t>Tail');
  assert.strictEqual(afterText, beforeText.slice(0, start) + pXml(ctx, b.id) + pXml(ctx, blocks[1].id) + beforeText.slice(end));
  writeOut(OUT, 'split-mid.docx', bytes);
});

test('split inside a formatted run of basic.docx keeps formatting on both sides; split at the very start and end', () => {
  const ctx = open('basic.docx');
  const b = ctx.model.blocks().find((x) => isEditable(x) && textOf(ctx, x).startsWith('This paragraph has bold'));
  const items = identity(ctx, b);
  const text = itemsText(items);
  const k = text.indexOf('bold') + 2;
  const { before, after } = cut(items, k);
  const bold = (list) => list.filter((it) => it.kind === 'text' && it.b).map((it) => it.text).join('|');
  assert.deepStrictEqual([bold(before), bold(after)], ['bo', 'ld']);
  const i = indexOfBlock(ctx, b.id);
  const r1 = apply(ctx, { op: 'splitParagraph', blockId: b.id, before, after }, { affected: [b.id] });
  const [p1, p2] = ctx.model.blocks().slice(i, i + 2);
  assert.deepStrictEqual([textOf(ctx, p1), textOf(ctx, p2)], [text.slice(0, k), text.slice(k)]);
  assert.strictEqual(bold(identity(ctx, p1)), 'bo', 'bold survives in the first half');
  assert.strictEqual(bold(identity(ctx, p2)), 'ld', 'bold survives in the second half');
  assert.ok(identity(ctx, p2).some((it) => it.kind === 'text' && it.i) && identity(ctx, p2).some((it) => it.kind === 'text' && it.u), 'italic and underline runs moved whole');
  assert.match(pXml(ctx, p1.id), /w14:paraId="[0-9A-F]{8}"/);
  assert.doesNotMatch(pXml(ctx, p2.id), /paraId|textId|rsid/);

  // At the very start: the first half is empty, the text moves down. The untouched runs are source slices.
  const plain = byText(ctx, 'A plain paragraph with ordinary text.');
  const runs = pXml(ctx, plain.id).match(/<w:r>.*<\/w:r>/)[0];
  const j = indexOfBlock(ctx, plain.id);
  const r2 = apply(ctx, { op: 'splitParagraph', blockId: plain.id, before: [], after: identity(ctx, plain) }, { affected: [plain.id] });
  assert.deepStrictEqual(ctx.model.blocks().slice(j, j + 2).map((x) => textOf(ctx, x)), ['', 'A plain paragraph with ordinary text.']);
  assert.strictEqual(pXml(ctx, ctx.model.blocks()[j + 1].id), `<w:p>${runs}</w:p>`, 'runs moved as their source slices');
  assert.deepStrictEqual(r2.out.focus, { blockId: ctx.model.blocks()[j + 1].id, at: 'start' });

  // At the very end of a Normal paragraph: the first half is not rewritten at all (one insert).
  const fin = byText(ctx, 'Final paragraph.');
  const finXml = pXml(ctx, fin.id);
  const r3 = apply(ctx, { op: 'splitParagraph', blockId: fin.id, before: identity(ctx, fin), after: [] }, { affected: [fin.id] });
  assert.strictEqual(r3.edit.changes.length, 1, 'only an insert');
  assert.strictEqual(pXml(ctx, fin.id), finXml, 'the first half keeps every byte, w14:textId included');
  assert.strictEqual(pXml(ctx, r3.out.focus.blockId), '<w:p/>', 'a Normal paragraph with no properties splits off an empty one');
  writeOut(OUT, 'split-basic.docx', r3.bytes);
  undoAll(ctx, [r1.edit, r2.edit, r3.edit]);
});

test('split: sectPr stays on the second half', async () => {
  // rich.docx: the (empty) paragraph that ends section one.
  const ctx = open('rich.docx');
  const b = ctx.model.blocks().find((x) => x.kind === 'paragraph' && paragraphProps(x.el).hasSectPr);
  const sect = serialize(paragraphProps(b.el).pPr);
  const i = indexOfBlock(ctx, b.id);
  const sections = count(mainText(ctx), '<w:sectPr');
  const { bytes } = apply(ctx, { op: 'splitParagraph', blockId: b.id, before: [], after: [] }, { affected: [b.id] });
  const [p1, p2] = ctx.model.blocks().slice(i, i + 2);
  assert.strictEqual(p1.id, b.id);
  assert.strictEqual(paragraphProps(p1.el).hasSectPr, false, 'the first half no longer ends the section');
  assert.match(pXml(ctx, p1.id), /^<w:p w14:paraId="[0-9A-F]{8}" w14:textId="[0-9A-F]{8}"\/>$/, 'first half: an empty paragraph, attributes kept');
  assert.strictEqual(pXml(ctx, p2.id), `<w:p>${sect}</w:p>`, 'second half carries the section properties verbatim');
  assert.strictEqual(count(mainText(ctx), '<w:sectPr'), sections, 'no section added or lost');
  writeOut(OUT, 'split-sectPr.docx', bytes);

  // With text and other properties: only sectPr leaves the first half.
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const syn = await docWithBody(`<w:p><w:pPr><w:jc w:val="right"/>${sectPr}</w:pPr>${R('End of one')}</w:p><w:p>${R('Two')}</w:p>`);
  const sb = byText(syn, 'End of one');
  const c = cut(identity(syn, sb), 4);
  const r = apply(syn, { op: 'splitParagraph', blockId: sb.id, ...c }, { affected: [sb.id], expect: ['P:End ', 'P:of one', 'P:Two', 'O:w:sectPr'] });
  const [q1, q2] = syn.model.blocks();
  assert.strictEqual(pXml(syn, q1.id), `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${WT('End ')}</w:r></w:p>`);
  assert.strictEqual(pXml(syn, q2.id), `<w:p><w:pPr><w:jc w:val="right"/>${sectPr}</w:pPr><w:r>${WT('of one')}</w:r></w:p>`);
  writeOut(OUT, 'split-sectPr-text.docx', r.bytes);
});

test('split at end honours w:next and drops numPr; mid-paragraph and same-style splits keep the style', async () => {
  const ctx = open('basic.docx');
  // Heading 1 declares w:next Normal (the default style): the new paragraph has no pStyle.
  const h = byText(ctx, 'Heading One');
  const hXml = pXml(ctx, h.id);
  const r1 = apply(ctx, { op: 'splitParagraph', blockId: h.id, before: identity(ctx, h), after: [] }, { affected: [h.id] });
  assert.strictEqual(pXml(ctx, h.id), hXml, 'the heading itself is untouched');
  assert.strictEqual(pXml(ctx, r1.out.focus.blockId), '<w:p/>', 'the paragraph after a heading is Normal');
  assert.strictEqual(info(ctx, r1.out.focus.blockId).style.kind, 'normal');
  // Mid-heading: both halves stay headings.
  const h2 = byText(ctx, 'Heading Two');
  const c = cut(identity(ctx, h2), 7);
  const r2 = apply(ctx, { op: 'splitParagraph', blockId: h2.id, ...c }, { affected: [h2.id] });
  assert.deepStrictEqual([info(ctx, h2.id).style.level, info(ctx, r2.out.focus.blockId).style.level], [2, 2]);
  // A list item (List Paragraph has no w:next): the list continues, numPr and style kept.
  const li = byText(ctx, 'Bullet two');
  const liPPr = serialize(paragraphProps(li.el).pPr);
  const r3 = apply(ctx, { op: 'splitParagraph', blockId: li.id, before: identity(ctx, li), after: [] }, { affected: [li.id] });
  assert.strictEqual(pXml(ctx, r3.out.focus.blockId), `<w:p>${liPPr}</w:p>`);
  assert.deepStrictEqual(info(ctx, r3.out.focus.blockId).list, { kind: 'bullet', level: 0 });
  writeOut(OUT, 'split-next-style.docx', r3.bytes);
  undoAll(ctx, [r1.edit, r2.edit, r3.edit]);

  // A numbered heading: at the end the new paragraph takes w:next and loses numPr, other direct formatting stays.
  const num = await patched((t) => t.replace('<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>',
    '<w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:jc w:val="center"/></w:pPr>'));
  const n = open('numbered-heading.docx', num);
  const nh = byText(n, 'Heading One');
  assert.strictEqual(info(n, nh.id).list.kind, 'number');
  const r4 = apply(n, { op: 'splitParagraph', blockId: nh.id, before: identity(n, nh), after: [] }, { affected: [nh.id] });
  assert.strictEqual(pXml(n, r4.out.focus.blockId), '<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>');
  // ... but not mid-paragraph.
  const c2 = cut(identity(n, nh), 3);
  const r5 = apply(n, { op: 'splitParagraph', blockId: nh.id, ...c2 }, { affected: [nh.id] });
  assert.match(pXml(n, r5.out.focus.blockId), /^<w:p><w:pPr><w:pStyle w:val="Heading1"\/><w:numPr>/);
  writeOut(OUT, 'split-numbered-heading.docx', r5.bytes);

  // w:next naming another (non-default) style: that style id is written; a list style keeps numPr.
  const chained = await patched((t) => t.replace(/(w:styleId="Heading1">.*?<w:next w:val=")Normal"/, '$1Heading2"'), 'basic.docx', 'word/styles.xml');
  const ch = open('chained.docx', chained);
  const chh = byText(ch, 'Heading One');
  const r6 = apply(ch, { op: 'splitParagraph', blockId: chh.id, before: identity(ch, chh), after: [] }, { affected: [chh.id] });
  assert.strictEqual(pXml(ch, r6.out.focus.blockId), '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr></w:p>');
  // w:next naming a style that does not exist is ignored (the validator would refuse the save).
  const dangling = await patched((t) => t.replace(/(w:styleId="Heading1">.*?<w:next w:val=")Normal"/, '$1Nope"'), 'basic.docx', 'word/styles.xml');
  const dg = open('dangling.docx', dangling);
  const dh = byText(dg, 'Heading One');
  const r7 = apply(dg, { op: 'splitParagraph', blockId: dh.id, before: identity(dg, dh), after: [] }, { affected: [dh.id] });
  assert.strictEqual(pXml(dg, r7.out.focus.blockId), '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>');
});

test('Enter in an empty list item removes numbering instead', async () => {
  const ctx = open('basic.docx');
  const li = byText(ctx, 'Bullet three');
  const n = ctx.model.blocks().length;
  // The island was emptied and Enter pressed: the paragraph becomes empty and leaves the list.
  const { out, edit, bytes } = apply(ctx, { op: 'splitParagraph', blockId: li.id, before: [], after: [] }, { affected: [li.id] });
  assert.strictEqual(edit.label, LABELS.list);
  assert.strictEqual(edit.label, 'Change List');
  assert.strictEqual(ctx.model.blocks().length, n, 'no paragraph added');
  assert.deepStrictEqual(out.changedBlockIds, [li.id]);
  assert.deepStrictEqual(out.focus, { blockId: li.id, at: 'start' });
  assert.match(pXml(ctx, li.id), /^<w:p w14:paraId="[0-9A-F]{8}"\/>$/, 'numPr and the List Paragraph style are gone, paraId kept');
  assert.deepStrictEqual(info(ctx, li.id).list, { kind: 'none', level: 0 });
  writeOut(OUT, 'empty-list-item.docx', bytes);
  // The same Enter again: now an ordinary split.
  const again = apply(ctx, { op: 'splitParagraph', blockId: li.id, before: [], after: [] }, { affected: [li.id] });
  assert.strictEqual(again.edit.label, 'Split Paragraph');
  assert.strictEqual(ctx.model.blocks().length, n + 1);

  // Other direct properties survive; an already empty item needs no text change.
  const syn = await docWithBody('<w:p><w:pPr><w:keepNext/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:jc w:val="center"/></w:pPr></w:p><w:p/>');
  const e = syn.model.blocks()[0];
  assert.strictEqual(info(syn, e.id).list.kind, 'number');
  apply(syn, { op: 'splitParagraph', blockId: e.id, before: [], after: [] }, { affected: [e.id] });
  assert.strictEqual(pXml(syn, e.id), '<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr></w:p>');

  // Numbering that comes from the style can only be switched off: numId 0.
  const styled = await patched((t) => t.replace(/(w:styleId="Quote">.*?<w:pPr>)/, '$1<w:numPr><w:numId w:val="1"/></w:numPr>'), 'basic.docx', 'word/styles.xml');
  const zip = await JSZip.loadAsync(styled);
  zip.file(MAIN, (await zip.file(MAIN).async('string')).replace(/<w:p [^>]*><w:r><w:t>Final paragraph\.<\/w:t><\/w:r><\/w:p>/, '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr></w:p>'));
  const s = open('style-numbered.docx', new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
  const q = s.model.blocks().find((x) => paragraphProps(x.el).pStyleId === 'Quote');
  assert.notStrictEqual(info(s, q.id).list.kind, 'none', 'numbered through its style');
  const r = apply(s, { op: 'splitParagraph', blockId: q.id, before: [], after: [] }, { affected: [q.id] });
  assert.strictEqual(r.edit.label, 'Change List');
  assert.strictEqual(pXml(s, q.id), '<w:p><w:pPr><w:pStyle w:val="Quote"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr></w:p>');
  assert.deepStrictEqual(info(s, q.id).list, { kind: 'none', level: 0 });
  // An empty item that holds an image is not empty: it splits.
  const rich = open('rich.docx');
  const pic = byText(rich, CHIP);
  const before = rich.model.blocks().length;
  apply(rich, { op: 'splitParagraph', blockId: pic.id, before: [], after: [] }, { affected: [pic.id] });
  assert.strictEqual(rich.model.blocks().length, before + 1);
});

test('split keeps atoms and anchors on their side, re-inserts dropped ones once, and refuses bad input', () => {
  const ctx = open('anchors.docx');
  const b = ctx.model.blocks().find((x) => isEditable(x) && textOf(ctx, x).startsWith('A second pa'));
  const items = identity(ctx, b);
  const text = itemsText(items);
  const anchors = items.filter((it) => it.kind === 'anchor').map((it) => it.id);
  assert.ok(anchors.length >= 2);
  const c = cut(items, text.indexOf('ragraph'));
  const i = indexOfBlock(ctx, b.id);
  const r = apply(ctx, { op: 'splitParagraph', blockId: b.id, ...c }, { affected: [b.id] });
  const [p1, p2] = ctx.model.blocks().slice(i, i + 2);
  const anchorIds = (p) => ctx.model.segments(p).filter((s) => s.kind === 'anchor').map((s) => s.id);
  assert.deepStrictEqual(anchorIds(p1), c.before.filter((it) => it.kind === 'anchor').map((it) => it.id), 'anchors before the caret stay, with their ids');
  assert.deepStrictEqual(anchorIds(p2), c.after.filter((it) => it.kind === 'anchor').map((it) => it.id), 'anchors after the caret move, with their ids');
  assert.deepStrictEqual([...anchorIds(p1), ...anchorIds(p2)].sort(), anchors.slice().sort(), 'every anchor exactly once');
  writeOut(OUT, 'split-anchors.docx', r.bytes);
  applyEdit(ctx.pkg, invertEdit(r.edit));
  ctx.model.refresh();

  // Anchors missing from both halves are put back (in the first half), never duplicated.
  const b2 = ctx.model.block(b.id);
  const noAnchors = cut(identity(ctx, b2).filter((it) => it.kind !== 'anchor'), 5);
  apply(ctx, { op: 'splitParagraph', blockId: b2.id, ...noAnchors }, { affected: [b2.id] });
  const [q1, q2] = ctx.model.blocks().slice(i, i + 2);
  assert.deepStrictEqual(anchorIds(q1).sort(), anchors.slice().sort());
  assert.deepStrictEqual(anchorIds(q2), []);
  assert.deepStrictEqual([textOf(ctx, q1), textOf(ctx, q2)], [text.slice(0, 5), text.slice(5)]);

  // An image dropped from the items is kept, with the notice.
  const rich = open('rich.docx');
  const pic = byText(rich, 'Paragraph with an inline picture: ' + CHIP);
  const cp = cut(identity(rich, pic).filter((it) => it.kind !== 'atom'), 9);
  const rp = apply(rich, { op: 'splitParagraph', blockId: pic.id, ...cp }, { affected: [pic.id] });
  assert.deepStrictEqual(rp.edit.notices.map((x) => x.code), ['docx-atoms-kept']);
  const j = indexOfBlock(rich, pic.id);
  assert.deepStrictEqual(rich.model.blocks().slice(j, j + 2).map((x) => textOf(rich, x)), ['Paragraph' + CHIP, ' with an inline picture: ']);

  // Refusals: nothing changes.
  const basic = open('basic.docx');
  const p = byText(basic, 'Final paragraph.');
  refused(basic, { op: 'splitParagraph', blockId: 999999, before: [], after: [] }, 'stale');
  refused(basic, { op: 'splitParagraph', blockId: p.id, before: [{ kind: 'text', text: 'x', b: false, i: false, u: false, src: 424242 }], after: [] }, 'invalid');
  refused(basic, { op: 'splitParagraph', blockId: p.id, before: 'nope', after: [] }, 'invalid');
  refused(basic, { op: 'splitParagraph', blockId: p.id, before: [null], after: [] }, 'invalid');
  refused(basic, { op: 'splitParagraph', blockId: basic.model.blocks().at(-1).id, before: [], after: [] }, 'blocked');
  const a = open('anchors.docx');
  const ab = a.model.blocks().find((x) => isEditable(x) && textOf(a, x).startsWith('A second pa'));
  const anchor = identity(a, ab).find((it) => it.kind === 'anchor');
  refused(a, { op: 'splitParagraph', blockId: ab.id, before: [anchor], after: [anchor] }, 'invalid');
  const tracked = open('tracked.docx');
  const locked = tracked.model.blocks().find((x) => x.lockReason === 'tracked-changes');
  refused(tracked, { op: 'splitParagraph', blockId: locked.id, before: [], after: [] }, 'blocked', /tracked changes/);
  for (const x of [basic, a, tracked]) assertG0(x.pkg, x.name);
});

// ---------------------------------------------------------------------------------------------------
// Merge

test('merge keeps the first pPr and its runs byte for byte; focus lands on the join', () => {
  const ctx = open('basic.docx');
  const first = byText(ctx, 'Heading Two');
  const second = ctx.model.siblings(first).next;
  const secondText = textOf(ctx, second);
  const firstXml = pXml(ctx, first.id);
  const secondXml = pXml(ctx, second.id);
  const n = ctx.model.blocks().length;
  const { out, edit, bytes, beforeText, afterText } = apply(ctx, { op: 'mergeWithPrevious', blockId: second.id, items: identity(ctx, second) },
    { affected: [first.id, second.id] });
  assert.strictEqual(edit.label, 'Merge Paragraphs');
  assert.strictEqual(ctx.model.blocks().length, n - 1);
  assert.strictEqual(ctx.model.block(second.id), undefined, 'the second block is gone');
  assert.deepStrictEqual(out.changedBlockIds, [first.id]);
  assert.deepStrictEqual(out.focus, { blockId: first.id, at: 'Heading Two'.length });
  assert.strictEqual(textOf(ctx, ctx.model.block(first.id)), 'Heading Two' + secondText);
  assert.strictEqual(info(ctx, first.id).style.level, 2, 'the merged paragraph is the first one: still Heading 2');
  // Exactly: the first w:p without its textId, its own children untouched, then the second's runs.
  const merged = pXml(ctx, first.id);
  const firstNoTextId = firstXml.replace(/ w14:textId="[0-9A-F]{8}"/, '');
  assert.notStrictEqual(firstNoTextId, firstXml);
  const secondRuns = secondXml.slice(secondXml.indexOf('<w:r>'), -'</w:p>'.length);
  assert.strictEqual(merged, firstNoTextId.slice(0, -'</w:p>'.length) + secondRuns + '</w:p>', 'unchanged runs of the second paragraph move as source slices');
  assert.strictEqual(afterText, beforeText.replace(firstXml + secondXml, merged), 'G4: exactly the two w:p became one');
  // Formatting of the moved runs is still what it was.
  const kinds = identity(ctx, ctx.model.block(first.id)).filter((it) => it.kind === 'text');
  assert.ok(kinds.some((it) => it.text === 'bold' && it.b) && kinds.some((it) => it.text === 'italic' && it.i) && kinds.some((it) => it.text === 'underlined' && it.u));
  writeOut(OUT, 'merge-basic.docx', bytes);

  // The items are the second paragraph's CURRENT content: pending edits are merged, not lost.
  const a = byText(ctx, 'Bullet one');
  const b = byText(ctx, 'Bullet two');
  const src = identity(ctx, b)[0].src;
  const r = apply(ctx, { op: 'mergeWithPrevious', blockId: b.id, items: [{ kind: 'text', text: ' and 2', b: true, i: false, u: false, src }] }, { affected: [a.id, b.id] });
  assert.strictEqual(textOf(ctx, ctx.model.block(a.id)), 'Bullet one and 2');
  assert.deepStrictEqual(r.out.focus, { blockId: a.id, at: 'Bullet one'.length });
  assert.match(pXml(ctx, a.id), /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve"> and 2<\/w:t><\/w:r><\/w:p>$/);
  // Merging an empty paragraph up changes nothing in the first (not even its textId).
  const fin = byText(ctx, 'Final paragraph.');
  const last = ctx.model.siblings(fin).next;
  const finXml = pXml(ctx, fin.id);
  const r3 = apply(ctx, { op: 'mergeWithPrevious', blockId: last.id, items: [] }, { affected: [fin.id, last.id] });
  assert.strictEqual(pXml(ctx, fin.id), finXml);
  assert.strictEqual(r3.edit.changes.length, 1, 'one removal');
  assert.deepStrictEqual(r3.out.focus, { blockId: fin.id, at: 'Final paragraph.'.length });
  // Merging into an empty paragraph (self-closing w:p).
  apply(ctx, { op: 'insertParagraphAfter', blockId: fin.id }, { affected: [], points: [endOf(ctx, fin.id)] });
  const empty = ctx.model.siblings(ctx.model.block(fin.id)).next;
  apply(ctx, { op: 'insertParagraphAfter', blockId: empty.id }, { affected: [], points: [endOf(ctx, empty.id)] });
  const tail = ctx.model.siblings(ctx.model.block(empty.id)).next;
  apply(ctx, { op: 'commitParagraph', blockId: tail.id, items: [{ kind: 'text', text: 'typed', b: false, i: false, u: false, src: null }] }, { affected: [tail.id] });
  const r4 = apply(ctx, { op: 'mergeWithPrevious', blockId: tail.id, items: identity(ctx, ctx.model.block(tail.id)) }, { affected: [empty.id, tail.id] });
  assert.strictEqual(pXml(ctx, empty.id), `<w:p><w:r>${WT('typed')}</w:r></w:p>`);
  assert.deepStrictEqual(r4.out.focus, { blockId: empty.id, at: 0 });
  writeOut(OUT, 'merge-several.docx', r4.bytes);
});

test('merge is refused when the first has sectPr, a neighbour is locked or opaque, or there is no sibling; a sectPr on the second is carried', () => {
  const rich = open('rich.docx');
  const sectP = rich.model.blocks().find((b) => b.kind === 'paragraph' && paragraphProps(b.el).hasSectPr);
  const afterSect = rich.model.siblings(sectP).next;
  refused(rich, { op: 'mergeWithPrevious', blockId: afterSect.id, items: identity(rich, afterSect) }, 'blocked', /ends a section/);
  // Previous sibling is a table (opaque).
  const afterTable = byText(rich, 'Paragraph with an inline picture: ' + CHIP);
  assert.ok(rich.model.siblings(afterTable).prev.isTable);
  refused(rich, { op: 'mergeWithPrevious', blockId: afterTable.id, items: identity(rich, afterTable) }, 'blocked', /can't be edited/);
  // First block of the body.
  const top = rich.model.blocks()[0];
  refused(rich, { op: 'mergeWithPrevious', blockId: top.id, items: identity(rich, top) }, 'blocked', /no paragraph before/);
  // Opaque block as the subject.
  refused(rich, { op: 'mergeWithPrevious', blockId: rich.model.siblings(afterTable).prev.id, items: [] }, 'blocked');
  refused(rich, { op: 'mergeWithPrevious', blockId: 987654, items: [] }, 'stale');
  // Locked neighbour (tracked changes), and a locked subject.
  const tracked = open('tracked.docx');
  const blocks = tracked.model.blocks();
  const lockedIdx = blocks.findIndex((b) => b.lockReason === 'tracked-changes');
  const afterLocked = blocks.find((b, k) => k > lockedIdx && isEditable(b) && !isEditable(tracked.model.siblings(b).prev));
  refused(tracked, { op: 'mergeWithPrevious', blockId: afterLocked.id, items: identity(tracked, afterLocked) }, 'blocked');
  refused(tracked, { op: 'mergeWithPrevious', blockId: blocks[lockedIdx].id, items: [] }, 'blocked', /tracked changes/);
  for (const x of [rich, tracked]) assertG0(x.pkg, x.name);

  // The second paragraph ends a section: merging keeps the section break on the merged paragraph.
  const before = rich.model.siblings(sectP).prev;
  assert.strictEqual(textOf(rich, before), 'Page two paragraph.');
  const sectXml = serialize(paragraphProps(sectP.el).pPr).slice('<w:pPr>'.length, -'</w:pPr>'.length);
  const sections = count(mainText(rich), '<w:sectPr');
  const { out, bytes } = apply(rich, { op: 'mergeWithPrevious', blockId: sectP.id, items: [] }, { affected: [before.id, sectP.id] });
  assert.deepStrictEqual(out.changedBlockIds, [before.id]);
  assert.strictEqual(count(mainText(rich), '<w:sectPr'), sections, 'no section lost');
  assert.ok(paragraphProps(rich.model.block(before.id).el).hasSectPr);
  assert.ok(pXml(rich, before.id).includes(`<w:pPr>${sectXml}</w:pPr><w:r><w:lastRenderedPageBreak/><w:t>Page two paragraph.</w:t></w:r></w:p>`),
    'sectPr text carried verbatim; the first paragraph\'s run untouched');
  // ... and now that paragraph ends the section, so the next one cannot merge into it.
  const next = rich.model.siblings(rich.model.block(before.id)).next;
  refused(rich, { op: 'mergeWithPrevious', blockId: next.id, items: identity(rich, next) }, 'blocked', /ends a section/);
  writeOut(OUT, 'merge-sectPr-carried.docx', bytes);
});

test('merge: a carried sectPr goes to its schema place in the pPr of the first paragraph; nothing else in it changes', async () => {
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const ctx = await docWithBody(
    `<w:p w14:paraId="0A0A0A0A" w14:textId="0B0B0B0B"><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:rPr><w:i/></w:rPr></w:pPr>${R('Title')}</w:p>`
    + `<w:p><w:pPr><w:jc w:val="right"/>${sectPr}</w:pPr>${R(' ends here', '<w:b/>')}</w:p><w:p>${R('Next section')}</w:p>`);
  const [first, second] = ctx.model.blocks();
  const { out, bytes } = apply(ctx, { op: 'mergeWithPrevious', blockId: second.id, items: identity(ctx, second) },
    { affected: [first.id, second.id], expect: ['P:Title ends here', 'P:Next section', 'O:w:sectPr'] });
  assert.strictEqual(pXml(ctx, first.id),
    `<w:p w14:paraId="0A0A0A0A"><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:rPr><w:i/></w:rPr>${sectPr}</w:pPr>${R('Title')}${R(' ends here', '<w:b/>')}</w:p>`);
  assert.deepStrictEqual(out.focus, { blockId: first.id, at: 5 });
  writeOut(OUT, 'merge-sectPr-into-pPr.docx', bytes);
});

test('merge moves atoms and anchors with their ids; later commits may still name the old ids', () => {
  const ctx = open('anchors.docx');
  const first = ctx.model.blocks().find((x) => isEditable(x) && textOf(ctx, x).startsWith('The quick'));
  const second = ctx.model.siblings(first).next;
  const firstItems = identity(ctx, first);
  const secondItems = identity(ctx, second);
  const { out, bytes } = apply(ctx, { op: 'mergeWithPrevious', blockId: second.id, items: secondItems }, { affected: [first.id, second.id] });
  const merged = ctx.model.block(first.id);
  const ids = (items) => items.filter((it) => it.kind !== 'text').map((it) => it.id);
  assert.deepStrictEqual(ids(identity(ctx, merged)), [...ids(firstItems), ...ids(secondItems)], 'anchors keep their ids and order');
  assert.strictEqual(out.focus.at, unitsOfItems(firstItems));
  writeOut(OUT, 'merge-anchors.docx', bytes);
  // The island still holds the items it had: old text ids resolve as aliases, anchors by id.
  const stale = [...firstItems, ...secondItems].map((it) => (it.kind === 'text' ? { ...it, text: it.text.toUpperCase() } : it));
  const r = apply(ctx, { op: 'commitParagraph', blockId: first.id, items: stale }, { affected: [first.id] });
  assert.strictEqual(r.out.ok, true);
  assert.strictEqual(textOf(ctx, ctx.model.block(first.id)), itemsText(stale));

  // Images move too, and a dropped one is put back with the notice.
  const rich = open('rich.docx');
  const pic = byText(rich, 'Paragraph with an inline picture: ' + CHIP);
  const float = rich.model.siblings(pic).next;
  const fn = rich.model.siblings(float).next;
  assert.strictEqual(textOf(rich, fn), 'A paragraph with a footnote.' + CHIP);
  const r2 = apply(rich, { op: 'mergeWithPrevious', blockId: fn.id, items: identity(rich, fn).filter((it) => it.kind !== 'atom') }, { affected: [float.id, fn.id] });
  assert.deepStrictEqual(r2.edit.notices.map((x) => x.code), ['docx-atoms-kept']);
  assert.ok(textOf(rich, rich.model.block(float.id)).endsWith(CHIP + 'A paragraph with a footnote.') || textOf(rich, rich.model.block(float.id)).endsWith('A paragraph with a footnote.' + CHIP));
  writeOut(OUT, 'merge-footnote.docx', r2.bytes);
});

// ---------------------------------------------------------------------------------------------------
// Remove

test('remove: the w:p goes, nothing else; refused with atoms, sectPr, the last paragraph, locked and opaque blocks', async () => {
  const ctx = open('basic.docx');
  const p = byText(ctx, 'A plain paragraph with ordinary text.');
  const xml = pXml(ctx, p.id);
  const next = ctx.model.siblings(p).next;
  const { out, edit, bytes, beforeText, afterText } = apply(ctx, { op: 'removeParagraph', blockId: p.id }, { affected: [p.id] });
  assert.strictEqual(edit.label, 'Remove Paragraph');
  assert.strictEqual(afterText, beforeText.replace(xml, ''), 'G4: exactly that w:p removed');
  assert.deepStrictEqual(out.changedBlockIds, []);
  assert.deepStrictEqual(out.focus, { blockId: next.id, at: 'start' });
  assert.strictEqual(ctx.model.block(p.id), undefined);
  // The last paragraph block of the body: focus goes to the end of the one before.
  const last = ctx.model.blocks().filter((b) => b.kind === 'paragraph').at(-1);
  const prev = ctx.model.siblings(last).prev;
  const r2 = apply(ctx, { op: 'removeParagraph', blockId: last.id }, { affected: [last.id] });
  assert.deepStrictEqual(r2.out.focus, { blockId: prev.id, at: 'end' });
  writeOut(OUT, 'remove-basic.docx', r2.bytes);
  assert.ok(bytes);

  const rich = open('rich.docx');
  refused(rich, { op: 'removeParagraph', blockId: byText(rich, 'Paragraph with an inline picture: ' + CHIP).id }, 'blocked', /image, field or link/);
  refused(rich, { op: 'removeParagraph', blockId: byText(rich, 'A hyperlink: ' + CHIP).id }, 'blocked', /image, field or link/);
  const sectP = rich.model.blocks().find((b) => b.kind === 'paragraph' && paragraphProps(b.el).hasSectPr);
  refused(rich, { op: 'removeParagraph', blockId: sectP.id }, 'blocked', /ends a section/);
  refused(rich, { op: 'removeParagraph', blockId: rich.model.blocks().find((b) => b.isTable).id }, 'blocked');
  refused(rich, { op: 'removeParagraph', blockId: rich.model.blocks().at(-1).id }, 'blocked');
  refused(rich, { op: 'removeParagraph', blockId: 31337 }, 'stale');
  const tracked = open('tracked.docx');
  refused(tracked, { op: 'removeParagraph', blockId: tracked.model.blocks().find((b) => b.lockReason === 'tracked-changes').id }, 'blocked', /tracked changes/);
  // The last remaining paragraph.
  const one = await docWithBody(`<w:p>${R('Only')}</w:p>`);
  assert.strictEqual(info(one, one.model.blocks()[0].id).removable, false);
  refused(one, { op: 'removeParagraph', blockId: one.model.blocks()[0].id }, 'blocked', /last paragraph/);
  const two = await docWithBody(`<w:p>${R('One')}</w:p><w:p>${R('Two')}</w:p>`);
  apply(two, { op: 'removeParagraph', blockId: two.model.blocks()[0].id }, { affected: [two.model.blocks()[0].id], expect: ['P:Two', 'O:w:sectPr'] });
  refused(two, { op: 'removeParagraph', blockId: two.model.blocks()[0].id }, 'blocked', /last paragraph/);
  for (const x of [rich, tracked, one]) assertG0(x.pkg, x.name);
  // `removable` and the operation agree on every block of several fixtures.
  for (const name of ['basic.docx', 'rich.docx', 'tables.docx', 'anchors.docx', 'fields.docx', 'content-controls.docx', 'tracked.docx']) {
    const f = open(name);
    for (const i of blockInfos(f)) {
      if (i.removable) continue;
      const o = applyDocxEdit(f, { op: 'removeParagraph', blockId: i.id });
      assert.strictEqual(o.ok, false, `${name} block ${i.id} is not removable`);
    }
    assertG0(f.pkg, name);
    const removable = blockInfos(f).filter((i) => i.removable);
    for (const i of removable.slice(0, 40)) {
      const g = open(name);
      const target = blockInfos(g)[blockInfos(f).findIndex((x) => x.id === i.id)];
      assert.strictEqual(applyDocxEdit(g, { op: 'removeParagraph', blockId: target.id }).ok, true, `${name} block ${i.id} is removable`);
      verifyOutput(g, `${name} remove`);
    }
  }
});

test('review N2: a paragraph between two tables is not removable (the tables would join)', async () => {
  const tbl = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p>' + R('c') + '</w:p></w:tc></w:tr></w:tbl>';
  const ctx = await docWithBody(`<w:p>${R('a')}</w:p>${tbl}<w:p/>${tbl}<w:p>${R('z')}</w:p>`);
  const body = ctx.model.blocks().filter((b) => b.container.tableBlockId === null);
  const between = body[2];
  assert.ok(body[1].isTable && body[3].isTable && between.kind === 'paragraph');
  assert.strictEqual(info(ctx, between.id).removable, false);
  refused(ctx, { op: 'removeParagraph', blockId: between.id }, 'blocked', /separates two tables/);
  // A paragraph with a table on one side only is still removable.
  assert.strictEqual(info(ctx, body[0].id).removable, true);
  apply(ctx, { op: 'removeParagraph', blockId: body[4].id }, { affected: [body[4].id] });
});

test('remove: anchors move to the next sibling paragraph (or previous); refused when they have nowhere to go', async () => {
  const ctx = open('anchors.docx');
  const b = ctx.model.blocks().find((x) => isEditable(x) && textOf(ctx, x).startsWith('A second pa'));
  const anchors = ctx.model.segments(b).filter((s) => s.kind === 'anchor');
  const anchorXml = anchors.map((s) => serialize(s.node)).join('');
  assert.ok(anchors.length >= 2);
  const next = ctx.model.siblings(b).next;
  const nextXml = pXml(ctx, next.id);
  const nextAnchors = ctx.model.segments(next).filter((s) => s.kind === 'anchor').map((s) => s.id);
  const { out, bytes, beforeText, afterText } = apply(ctx, { op: 'removeParagraph', blockId: b.id }, { affected: [b.id, next.id] });
  assert.deepStrictEqual(out.changedBlockIds, [next.id]);
  assert.deepStrictEqual(out.focus, { blockId: next.id, at: 'start' });
  // Exactly: the anchors, in order, right after the next paragraph's start tag (it has no pPr).
  const open1 = nextXml.slice(0, nextXml.indexOf('>') + 1);
  assert.strictEqual(pXml(ctx, next.id), open1 + anchorXml + nextXml.slice(open1.length));
  assert.strictEqual(afterText, beforeText.replace(serialize(b.el) + nextXml, pXml(ctx, next.id)));
  assert.deepStrictEqual(ctx.model.segments(ctx.model.block(next.id)).filter((s) => s.kind === 'anchor').map((s) => s.id),
    [...anchors.map((s) => s.id), ...nextAnchors], 'the moved anchors keep their ids');
  writeOut(OUT, 'remove-anchors-next.docx', bytes);

  // The paragraph whose next sibling is not a paragraph (a body-level bookmarkEnd): anchors go to the end of the previous one.
  const third = ctx.model.block(next.id);
  assert.strictEqual(ctx.model.siblings(third).next.kind, 'opaque');
  const prev = ctx.model.siblings(third).prev;
  const prevXml = pXml(ctx, prev.id);
  const moving = ctx.model.segments(third).filter((s) => s.kind === 'anchor').map((s) => serialize(s.node)).join('');
  const r2 = apply(ctx, { op: 'removeParagraph', blockId: third.id }, { affected: [prev.id, third.id] });
  assert.deepStrictEqual(r2.out.changedBlockIds, [prev.id]);
  assert.deepStrictEqual(r2.out.focus, { blockId: prev.id, at: 'end' });
  assert.strictEqual(pXml(ctx, prev.id), prevXml.slice(0, -'</w:p>'.length) + moving + '</w:p>');
  writeOut(OUT, 'remove-anchors-prev.docx', r2.bytes);

  // After a pPr; and nowhere to go (between two tables) is refused.
  const bm = '<w:bookmarkStart w:id="50" w:name="here"/><w:bookmarkEnd w:id="50"/>';
  const tbl = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>';
  const syn = await docWithBody(`<w:p>${bm}${R('gone')}</w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${R('stay')}</w:p>${tbl}<w:p>${bm.replace(/50/g, '51').replace('here', 'stuck')}</w:p><w:p><w:ins w:id="70" w:author="a" w:date="2024-01-01T00:00:00Z">${R('tracked')}</w:ins></w:p><w:p/>`);
  const [gone, stay] = syn.model.blocks();
  apply(syn, { op: 'removeParagraph', blockId: gone.id }, { affected: [gone.id, stay.id] });
  assert.strictEqual(pXml(syn, stay.id), `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${bm}${R('stay')}</w:p>`);
  const stuck = syn.model.blocks().find((x) => isEditable(x) && syn.model.segments(x).some((s) => s.kind === 'anchor') && x.id !== stay.id);
  assert.strictEqual(info(syn, stuck.id).removable, false);
  refused(syn, { op: 'removeParagraph', blockId: stuck.id }, 'blocked', /nowhere to go/);
});

// ---------------------------------------------------------------------------------------------------
// Cells

/** Text of the `w:tc` holding block `id`. */
const cellXml = (ctx, id) => serialize(ctx.model.block(id).container.el);
const tableOf = (ctx, id) => ctx.model.block(ctx.model.block(id).container.tableBlockId);

test('cells: split inside a cell adds a p to that tc only; merge and remove stay inside the cell', () => {
  const ctx = open('tables.docx');
  const b = byText(ctx, 'plain bold italic');
  const tc = cellXml(ctx, b.id);
  const tbl = serialize(tableOf(ctx, b.id).el);
  const before = mainText(ctx);
  const c = cut(identity(ctx, b), 'plain bo'.length);
  const { out, edit, bytes, afterText } = apply(ctx, { op: 'splitParagraph', blockId: b.id, ...c }, { affected: [b.id] });
  const fresh = ctx.model.block(out.focus.blockId);
  assert.strictEqual(fresh.container.el, ctx.model.block(b.id).container.el, 'the new paragraph is in the same cell');
  assert.deepStrictEqual(info(ctx, fresh.id).cell, { row: 0, col: 0 });
  assert.deepStrictEqual(ctx.model.blocksIn(fresh.container).map((x) => textOf(ctx, x)), ['plain bo', 'ld italic']);
  // The tc changed only by its paragraphs; the table outside this tc and the document outside the table are identical.
  const tcNow = cellXml(ctx, b.id);
  const tcPr = tc.slice(0, tc.indexOf('<w:p'));
  assert.ok(tcNow.startsWith(tcPr) && tcPr.includes('<w:tcPr>'), 'tcPr untouched');
  assert.strictEqual(count(tcNow, '<w:p>') + count(tcNow, '<w:p '), 2);
  assert.strictEqual(serialize(tableOf(ctx, b.id).el), tbl.replace(tc, tcNow), 'the rest of the table is byte-identical');
  assert.strictEqual(afterText, before.replace(tc, tcNow), 'the rest of the document is byte-identical');
  writeOut(OUT, 'cell-split.docx', bytes);

  // Merge them back within the cell: same reading as at the start.
  const r2 = apply(ctx, { op: 'mergeWithPrevious', blockId: fresh.id, items: identity(ctx, fresh) }, { affected: [b.id, fresh.id] });
  assert.deepStrictEqual(ctx.model.blocksIn(ctx.model.block(b.id).container).map((x) => textOf(ctx, x)), ['plain bold italic']);
  assert.deepStrictEqual(r2.out.focus, { blockId: b.id, at: 'plain bo'.length });

  // A cell with two paragraphs: remove one; the survivor is then the only one and stays.
  const two = byText(ctx, 'two');
  const paras = byText(ctx, 'paragraphs');
  assert.strictEqual(two.container, paras.container);
  const r3 = apply(ctx, { op: 'removeParagraph', blockId: paras.id }, { affected: [paras.id] });
  assert.deepStrictEqual(r3.out.focus, { blockId: two.id, at: 'end' }, 'focus stays in the cell');
  assert.strictEqual(info(ctx, two.id).removable, false);
  refused(ctx, { op: 'removeParagraph', blockId: two.id }, 'blocked', /at least one paragraph/);
  // Split in a list inside a cell continues the list in the cell; Enter on the empty item ends it.
  const item = byText(ctx, 'Item three');
  const r4 = apply(ctx, { op: 'splitParagraph', blockId: item.id, before: identity(ctx, item), after: [] }, { affected: [item.id] });
  const emptyItem = ctx.model.block(r4.out.focus.blockId);
  assert.strictEqual(emptyItem.container.el, ctx.model.block(item.id).container.el);
  assert.strictEqual(info(ctx, emptyItem.id).list.kind, 'bullet');
  const r5 = apply(ctx, { op: 'splitParagraph', blockId: emptyItem.id, before: [], after: [] }, { affected: [emptyItem.id] });
  assert.strictEqual(r5.edit.label, 'Change List');
  assert.strictEqual(info(ctx, emptyItem.id).list.kind, 'none');
  writeOut(OUT, 'cell-several.docx', r5.bytes);
  undoAll(ctx, [edit, r2.edit, r3.edit, r4.edit, r5.edit]);
});

test('cells: only paragraph not removable; last p after a nested table not removable; Backspace-merge at the first paragraph of a cell is refused', () => {
  const ctx = open('tables.docx');
  const only = byText(ctx, 'second cell');
  assert.strictEqual(ctx.model.blocksIn(only.container).length, 1);
  refused(ctx, { op: 'removeParagraph', blockId: only.id }, 'blocked', /at least one paragraph/);
  // The cell that ends "…nested table, empty paragraph".
  const holder = byText(ctx, 'outer 2,1 (ends in a nested table)');
  const nested = ctx.model.siblings(holder).next;
  const tail = ctx.model.siblings(nested).next;
  assert.ok(nested.isTable && tail.kind === 'paragraph' && ctx.model.siblings(tail).next === null);
  refused(ctx, { op: 'removeParagraph', blockId: tail.id }, 'blocked', /must end with a paragraph/);
  // First paragraph of a cell: no previous sibling in this container, whatever precedes it in the document.
  for (const text of ['plain bold italic', 'second cell', 'two', 'in 1,1', 'outer 2,2']) {
    const p = byText(ctx, text);
    assert.strictEqual(ctx.model.siblings(p).prev, null);
    refused(ctx, { op: 'mergeWithPrevious', blockId: p.id, items: identity(ctx, p) }, 'blocked', /no paragraph before/);
  }
  // The paragraph after a nested table cannot merge into the table.
  refused(ctx, { op: 'mergeWithPrevious', blockId: tail.id, items: [] }, 'blocked', /can't be edited/);
  // The body paragraph after a table cannot merge into the table's last cell.
  const after = byText(ctx, 'After table 1.');
  refused(ctx, { op: 'mergeWithPrevious', blockId: after.id, items: identity(ctx, after) }, 'blocked', /can't be edited/);
  // Merged continuation cells: nothing at all.
  const merged = ctx.model.blocks().find((b) => b.lockReason === 'merged-cell');
  refused(ctx, { op: 'splitParagraph', blockId: merged.id, before: [], after: [] }, 'blocked', /merged cell/);
  refused(ctx, { op: 'removeParagraph', blockId: merged.id }, 'blocked', /merged cell/);
  refused(ctx, { op: 'insertParagraphAfter', blockId: merged.id }, 'blocked', /merged cell/);
  refused(ctx, { op: 'mergeWithPrevious', blockId: merged.id, items: [] }, 'blocked', /merged cell/);
  // A tracked row: its paragraphs are locked and nothing is inserted there.
  const trackedCell = ctx.model.blocks().find((b) => b.lockReason === 'tracked-changes');
  assert.ok(trackedCell && trackedCell.container.tableBlockId !== null);
  refused(ctx, { op: 'insertParagraphAfter', blockId: trackedCell.id }, 'blocked', /tracked changes/);
  refused(ctx, { op: 'removeParagraph', blockId: trackedCell.id }, 'blocked', /tracked changes/);
  assertG0(ctx.pkg, 'tables.docx');

  // Removing the paragraph BEFORE the nested table is fine: the cell still ends with a paragraph.
  const { bytes } = apply(ctx, { op: 'removeParagraph', blockId: holder.id }, { affected: [holder.id] });
  assert.deepStrictEqual(ctx.model.blocksIn(ctx.model.block(tail.id).container).map((x) => x.kind), ['opaque', 'paragraph']);
  refused(ctx, { op: 'removeParagraph', blockId: tail.id }, 'blocked', /at least one paragraph/);
  writeOut(OUT, 'cell-remove-before-nested.docx', bytes);
});

test('insertParagraphAfter: nested table → holding cell; null → document start; after a body table; after paragraphs; refusals', () => {
  const ctx = open('tables.docx');
  const holder = byText(ctx, 'outer 2,1 (ends in a nested table)');
  const nested = ctx.model.siblings(holder).next;
  const tail = ctx.model.siblings(nested).next;
  const outerTable = tableOf(ctx, holder.id);
  const r1 = apply(ctx, { op: 'insertParagraphAfter', blockId: nested.id }, { affected: [], points: [endOf(ctx, nested.id)] });
  assert.strictEqual(r1.edit.label, 'Insert Paragraph');
  const fresh = ctx.model.block(r1.out.focus.blockId);
  assert.deepStrictEqual(r1.out, { ok: true, edit: r1.edit, changedBlockIds: [fresh.id], focus: { blockId: fresh.id, at: 'start' } });
  assert.strictEqual(serialize(fresh.el), '<w:p/>');
  assert.deepStrictEqual([info(ctx, fresh.id).parentId, info(ctx, fresh.id).cell], [outerTable.id, { row: 1, col: 0 }], 'in the cell that holds the nested table');
  assert.deepStrictEqual(ctx.model.blocksIn(fresh.container).map((x) => x.id), [holder.id, nested.id, fresh.id, tail.id]);
  assert.strictEqual(r1.afterText, r1.beforeText.replace(serialize(nested.el), serialize(nested.el) + '<w:p/>'));
  assert.strictEqual(info(ctx, fresh.id).removable, true);
  assert.strictEqual(info(ctx, tail.id).removable, true, 'the last paragraph now follows a paragraph');

  // Document start.
  const first = ctx.model.blocks()[0];
  const r2 = apply(ctx, { op: 'insertParagraphAfter', blockId: null }, { affected: [], points: [spanOf(ctx, [first.id]).start] });
  assert.strictEqual(ctx.model.blocks()[0].id, r2.out.focus.blockId);
  assert.strictEqual(ctx.model.blocks()[1].id, first.id);
  assert.match(r2.afterText, /<w:body><w:p\/><w:p /);
  assert.strictEqual(info(ctx, r2.out.focus.blockId).parentId, null);

  // After a body table: between the table and the paragraph that followed it.
  const table1 = tableOf(ctx, byText(ctx, 'second cell').id);
  const afterTable = byText(ctx, 'After table 1.');
  const r3 = apply(ctx, { op: 'insertParagraphAfter', blockId: table1.id }, { affected: [], points: [endOf(ctx, table1.id)] });
  const p3 = ctx.model.block(r3.out.focus.blockId);
  assert.strictEqual(p3.container.tableBlockId, null);
  assert.deepStrictEqual([ctx.model.siblings(p3).prev.id, ctx.model.siblings(p3).next.id], [table1.id, afterTable.id]);
  assert.ok(r3.afterText.includes('</w:tbl><w:p/><w:p '));

  // After a paragraph in a cell: stays in the cell. After the last table of a document, after a paragraph.
  const cellP = byText(ctx, 'second cell');
  const r4 = apply(ctx, { op: 'insertParagraphAfter', blockId: cellP.id }, { affected: [], points: [endOf(ctx, cellP.id)] });
  assert.strictEqual(ctx.model.block(r4.out.focus.blockId).container.el, ctx.model.block(cellP.id).container.el);
  assert.strictEqual(info(ctx, cellP.id).removable, true);
  const r5 = apply(ctx, { op: 'insertParagraphAfter', blockId: afterTable.id }, { affected: [], points: [endOf(ctx, afterTable.id)] });
  assert.strictEqual(ctx.model.siblings(ctx.model.block(r5.out.focus.blockId)).prev.id, afterTable.id);
  writeOut(OUT, 'insert-paragraphs.docx', r5.bytes);
  // Type into the new paragraph after the table, then save: the usual commit path works on it.
  const r6 = apply(ctx, { op: 'commitParagraph', blockId: p3.id, items: [{ kind: 'text', text: 'Typed after the table', b: false, i: true, u: false, src: null }] }, { affected: [p3.id] });
  assert.deepStrictEqual(r6.out.changedBlockIds, [p3.id]);
  assert.strictEqual(pXml(ctx, p3.id), `<w:p><w:r><w:rPr><w:i/><w:iCs/></w:rPr>${WT('Typed after the table')}</w:r></w:p>`);
  writeOut(OUT, 'insert-then-type.docx', r6.bytes);
  undoAll(ctx, [r1.edit, r2.edit, r3.edit, r4.edit, r5.edit, r6.edit]);

  // Refusals.
  refused(ctx, { op: 'insertParagraphAfter', blockId: ctx.model.blocks().at(-1).id }, 'blocked', /last section/);
  refused(ctx, { op: 'insertParagraphAfter', blockId: 55555 }, 'stale');
  const fields = open('fields.docx');
  const toc = fields.model.blocks().filter((b) => b.lockReason === 'multi-paragraph-field');
  assert.ok(toc.length >= 2);
  refused(fields, { op: 'insertParagraphAfter', blockId: toc[0].id }, 'blocked', /field that spans/);
  assertG0(fields.pkg, 'fields.docx');
  const r7 = apply(fields, { op: 'insertParagraphAfter', blockId: toc.at(-1).id }, { affected: [], points: [endOf(fields, toc.at(-1).id)] });
  assert.ok(isEditable(fields.model.block(r7.out.focus.blockId)), 'after the field ends, a new paragraph is editable');
  writeOut(OUT, 'insert-after-toc.docx', r7.bytes);
  // An empty document body (only sectPr): null still inserts before it.
  const cc = open('content-controls.docx');
  const sdt = cc.model.blocks().find((b) => b.kind === 'opaque' && b.el.local === 'sdt');
  const r8 = apply(cc, { op: 'insertParagraphAfter', blockId: sdt.id }, { affected: [], points: [endOf(cc, sdt.id)] });
  assert.strictEqual(cc.model.siblings(cc.model.block(r8.out.focus.blockId)).prev.id, sdt.id);
  writeOut(OUT, 'insert-after-sdt.docx', r8.bytes);
});

test('table census unchanged after every cell operation (every editable cell paragraph of tables.docx: split, merge back, insert, remove)', () => {
  const ctx = open('tables.docx');
  const census = ctx.model.loadTableCensus;
  const edits = [];
  const cellParas = ctx.model.blocks().filter((b) => isEditable(b) && b.container.tableBlockId !== null);
  assert.ok(cellParas.length > 150);
  let k = 0;
  for (const b of cellParas) {
    const step = k++ % 8 === 0 ? {} : { light: true };            // full checks on a spread, text-level on the rest
    const items = identity(ctx, ctx.model.block(b.id));
    const c = cut(items, Math.floor(unitsOfItems(items) / 2));
    const s = apply(ctx, { op: 'splitParagraph', blockId: b.id, ...c }, { ...step, affected: [b.id] });
    assert.ok(s.out.ok && s.edit, `split ${b.id}`);
    edits.push(s.edit);
    assert.strictEqual(ctx.model.tableCensus(), census);
    const second = ctx.model.block(s.out.focus.blockId);
    assert.strictEqual(second.container.el, ctx.model.block(b.id).container.el);
    if (k % 3 === 0) {
      const m = apply(ctx, { op: 'mergeWithPrevious', blockId: second.id, items: identity(ctx, second) }, { ...step, affected: [b.id, second.id] });
      edits.push(m.edit);
    } else if (k % 3 === 1) {
      const ins = apply(ctx, { op: 'insertParagraphAfter', blockId: b.id }, { ...step, affected: [], points: [endOf(ctx, b.id)] });
      edits.push(ins.edit);
      const rem = apply(ctx, { op: 'removeParagraph', blockId: second.id }, { ...step, affected: [second.id] });
      assert.ok(rem.out.ok, 'the second half is removable (no atoms in these cells)');
      edits.push(rem.edit);
    }
    assert.strictEqual(ctx.model.tableCensus(), census);
  }
  const bytes = verifyOutput(ctx, 'cells');
  assertG3(ctx.orig, bytes, [MAIN]);
  saxesOk(mainText(ctx));
  writeOut(OUT, 'cells-every-paragraph.docx', bytes);
  undoAll(ctx, edits);
});

// ---------------------------------------------------------------------------------------------------
// Dispatch

test('applyDocxEdit: commitParagraph delegates; style/list ops are dispatched to stylesWrite (stub refuses); unknown ops are invalid', () => {
  const ctx = open('basic.docx');
  const p = byText(ctx, 'Final paragraph.');
  const same = apply(ctx, { op: 'commitParagraph', blockId: p.id, items: identity(ctx, p) });
  assert.deepStrictEqual(same.out, { ok: true, edit: null, changedBlockIds: [] }, 'unchanged commit: no edit');
  assertG0(ctx.pkg, 'unchanged');
  const items = identity(ctx, p).map((it) => ({ ...it, text: 'Final words.' }));
  const r = apply(ctx, { op: 'commitParagraph', blockId: p.id, items }, { affected: [p.id] });
  assert.strictEqual(r.edit.label, 'Edit Paragraph');
  assert.deepStrictEqual(r.out, { ok: true, edit: r.edit, changedBlockIds: [p.id] });
  assert.strictEqual(textOf(ctx, ctx.model.block(p.id)), 'Final words.');
  refused(ctx, { op: 'commitParagraph', blockId: 777777, items: [] }, 'stale');
  refused(ctx, { op: 'commitParagraph', blockId: p.id, items: [{ kind: 'atom', id: 5 }] }, 'invalid');
  // WP-30 replaces the stub; until then these are refused and change nothing.
  if (/in this version yet/.test(core.docx.stylesWrite.setStyle(null, ctx, [p.id], 'normal')?.message ?? '')) {
    refused(ctx, { op: 'setStyle', blockIds: [p.id], style: { heading: 1 } }, 'blocked');
    refused(ctx, { op: 'setList', blockIds: [p.id], list: 'bullet' }, 'blocked');
    refused(ctx, { op: 'setListLevel', blockIds: [p.id], delta: 1 }, 'blocked');
  }
  refused(ctx, { op: 'frobnicate' }, 'invalid');
  // A commit that only drops an image changes nothing but names the block, so the island is rebuilt.
  const rich = open('rich.docx');
  const pic = byText(rich, 'Paragraph with an inline picture: ' + CHIP);
  const dropped = apply(rich, { op: 'commitParagraph', blockId: pic.id, items: identity(rich, pic).filter((it) => it.kind !== 'atom') });
  assert.deepStrictEqual(dropped.out, { ok: true, edit: null, changedBlockIds: [pic.id] });
  assertG0(rich.pkg, 'rich');
});

test('a view-only document refuses every operation; the block limit refuses split and insert only', () => {
  const ctx = open('basic.docx');
  const p = byText(ctx, 'Final paragraph.');
  const L = core.limits.LIMITS;
  const max = L.docxMaxBlocks;
  try {
    L.docxMaxBlocks = ctx.model.blocks().length;
    refused(ctx, { op: 'splitParagraph', blockId: p.id, ...cut(identity(ctx, p), 3) }, 'blocked', /too many paragraphs/);
    refused(ctx, { op: 'insertParagraphAfter', blockId: p.id }, 'blocked', /too many paragraphs/);
    refused(ctx, { op: 'insertParagraphAfter', blockId: null }, 'blocked', /too many paragraphs/);
    const last = ctx.model.siblings(p).next;
    assert.strictEqual(apply(ctx, { op: 'mergeWithPrevious', blockId: last.id, items: [] }, { affected: [p.id, last.id] }).out.ok, true);
  } finally {
    L.docxMaxBlocks = max;
  }
  // View-only (over the block limit at load): nothing is editable, every op says so.
  try {
    L.docxMaxBlocks = 3;
    const big = open('basic.docx');
    assert.strictEqual(big.model.viewOnlyReason, 'too-large');
    assert.deepStrictEqual(blockInfos(big), []);
    for (const op of [
      { op: 'commitParagraph', blockId: 1, items: [] }, { op: 'splitParagraph', blockId: 1, before: [], after: [] },
      { op: 'mergeWithPrevious', blockId: 1, items: [] }, { op: 'insertParagraphAfter', blockId: null },
      { op: 'insertParagraphAfter', blockId: 1 }, { op: 'removeParagraph', blockId: 1 }, { op: 'setStyle', blockIds: [1], style: 'normal' },
    ]) {
      const out = applyDocxEdit(big, op);
      assert.deepStrictEqual([out.ok, out.error.code], [false, 'read-only'], op.op);
    }
    assertG0(big.pkg, 'view-only');
  } finally {
    L.docxMaxBlocks = max;
  }
});

test('markup that needs a prefix bound only on its own paragraph cannot move to another one: merge is refused and rolled back', async () => {
  const ctx = await docWithBody(`<w:p>${R('First')}</w:p>`
    + '<w:p xmlns:zz="urn:example:zz"><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>Second</w:t></w:r><w:r><w:rPr><zz:odd/></w:rPr><w:t> odd</w:t></w:r></w:p>'
    + `<w:p>${R('Third')}</w:p>`);
  const [first, second] = ctx.model.blocks();
  assert.ok(isEditable(second));
  // The merge first carries the sectPr into the first paragraph, then fails on the run: all of it is rolled back.
  const m = apply(ctx, { op: 'mergeWithPrevious', blockId: second.id, items: identity(ctx, second) });
  assert.deepStrictEqual([m.out.ok, m.out.error?.code], [false, 'blocked'], m.out.error?.message);
  assertG0(ctx.pkg, 'rolled back');
  assert.deepStrictEqual(ctx.model.blocks().slice(0, 2).map((b) => b.id), [first.id, second.id], 'ids survive the rollback');
  // Splitting it is fine: both halves keep the paragraph's own start tag, binding included.
  const s = apply(ctx, { op: 'splitParagraph', blockId: second.id, ...cut(identity(ctx, second), 3) }, { affected: [second.id] });
  assert.strictEqual(s.out.ok, true);
  assert.match(pXml(ctx, s.out.focus.blockId), /^<w:p xmlns:zz="urn:example:zz"><w:pPr><w:sectPr>/);
});

test('pretty-printed document: split, merge, insert and remove keep the whitespace around other paragraphs (G4, G5)', async () => {
  const bytes = await prettyDocx();
  const ctx = open('pretty.docx', bytes);
  if (ctx.model.viewOnlyReason) return;
  const edits = [];
  const paras = () => ctx.model.blocks().filter(isEditable);
  assert.ok(paras().length >= 2, 'the pretty document has editable paragraphs');
  const run = (op, opts) => {
    // No package validators here: docx-min deliberately has dangling relationship targets (see prettyDocx).
    const r = apply(ctx, op, { ...opts, light: true });
    if (r.edit) edits.push(r.edit);
    saxesOk(mainText(ctx));
    return r;
  };
  const target = paras().find((b) => textOf(ctx, b).length >= 4);
  const items = identity(ctx, target);
  const s = run({ op: 'splitParagraph', blockId: target.id, ...cut(items, 2) }, { affected: [target.id] });
  assert.strictEqual(s.out.ok, true);
  const second = ctx.model.block(s.out.focus.blockId);
  assert.deepStrictEqual([textOf(ctx, ctx.model.block(target.id)), textOf(ctx, second)], [itemsText(items).slice(0, 2), itemsText(items).slice(2)]);
  const m = run({ op: 'mergeWithPrevious', blockId: second.id, items: identity(ctx, second) }, { affected: [target.id, second.id] });
  assert.strictEqual(m.out.ok, true);
  assert.strictEqual(textOf(ctx, ctx.model.block(target.id)), itemsText(items));
  const ins = run({ op: 'insertParagraphAfter', blockId: target.id }, { affected: [], points: [endOf(ctx, target.id)] });
  const rem = run({ op: 'removeParagraph', blockId: ins.out.focus.blockId }, { affected: [ins.out.focus.blockId] });
  assert.strictEqual(rem.out.ok, true);
  run({ op: 'insertParagraphAfter', blockId: null }, { affected: [], points: [spanOf(ctx, [ctx.model.blocks()[0].id]).start] });
  undoAll(ctx, edits);
});

// ---------------------------------------------------------------------------------------------------
// Ids across operations (the island is not rebuilt after an optimistic split or merge)

test('after a split, both halves accept commits that still name the segment ids of the undivided paragraph', () => {
  const ctx = open('multi-run.docx');
  const b = ctx.model.blocks().filter(isEditable).sort((x, y) => ctx.model.segments(y).length - ctx.model.segments(x).length)[0];
  const items = identity(ctx, b);
  assert.ok(items.filter((it) => it.kind === 'text').length >= 5, 'many runs');
  const c = cut(items, Math.floor(unitsOfItems(items) / 2));
  const r = apply(ctx, { op: 'splitParagraph', blockId: b.id, ...c }, { affected: [b.id] });
  const second = r.out.focus.blockId;
  // The webview's two islands hold c.before and c.after: edit both with those very items.
  const up = (list) => list.map((it) => (it.kind === 'text' ? { ...it, text: it.text.toUpperCase() } : it));
  const r1 = apply(ctx, { op: 'commitParagraph', blockId: b.id, items: up(c.before) }, { affected: [b.id] });
  const r2 = apply(ctx, { op: 'commitParagraph', blockId: second, items: up(c.after) }, { affected: [second] });
  assert.ok(r1.out.ok && r2.out.ok);
  assert.strictEqual(textOf(ctx, ctx.model.block(b.id)), itemsText(up(c.before)));
  assert.strictEqual(textOf(ctx, ctx.model.block(second)), itemsText(up(c.after)));
  // And an unchanged commit of what the model now says is a no-op (ids are coherent).
  assert.strictEqual(apply(ctx, { op: 'commitParagraph', blockId: second, items: identity(ctx, ctx.model.block(second)) }).out.edit, null);
  writeOut(OUT, 'split-multi-run.docx', r2.bytes);
  undoAll(ctx, [r.edit, r1.edit, r2.edit]);
});

// ---------------------------------------------------------------------------------------------------
// Randomised sequences

const WORDS = ['alpha', 'beta ', ' gamma', 'δέλτα', 'tab\there', 'line\nbreak', '  two spaces', 'x', '& < >', 'é', ''];

/** One random operation on `ctx`; returns the edit (or null). Asserts the outcome the model predicts. */
function randomOp(ctx, rand, stats) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const blocks = ctx.model.blocks();
  const editable = blocks.filter(isEditable);
  const before = reading(ctx);
  const roll = rand();
  const light = { light: true };
  if (roll < 0.3) {
    // Commit: change one text item, flip a toggle, add text.
    const b = pick(editable);
    const items = identity(ctx, b);
    const texts = items.filter((it) => it.kind === 'text');
    if (texts.length && rand() < 0.8) {
      const t = pick(texts);
      t.text = rand() < 0.2 ? '' : t.text.slice(0, Math.floor(rand() * (t.text.length + 1))) + pick(WORDS);
      if (rand() < 0.3) t.b = !t.b;
      if (rand() < 0.2) t.u = !t.u;
    } else {
      items.splice(Math.floor(rand() * (items.length + 1)), 0, { kind: 'text', text: pick(WORDS), b: rand() < 0.3, i: rand() < 0.3, u: false, src: texts.length ? pick(texts).src : null });
    }
    const expect = before.slice();
    expect[indexOfBlock(ctx, b.id)] = 'P:' + itemsText(items);
    const r = apply(ctx, { op: 'commitParagraph', blockId: b.id, items }, { ...light, affected: [b.id], expect: undefined });
    assert.strictEqual(r.out.ok, true, r.out.error?.message);
    assert.deepStrictEqual(reading(ctx), expect, 'commit: the paragraph reads as committed');
    stats.commit++;
    return r.edit ?? null;
  }
  if (roll < 0.55) {
    const b = pick(editable);
    const items = identity(ctx, b);
    const k = Math.floor(rand() * (unitsOfItems(items) + 1));
    const c = cut(items, k);
    const i = indexOfBlock(ctx, b.id);
    const info0 = info(ctx, b.id);
    const hasAtoms = items.some((it) => it.kind === 'atom');
    const r = apply(ctx, { op: 'splitParagraph', blockId: b.id, ...c }, { ...light, affected: [b.id] });
    assert.strictEqual(r.out.ok, true, r.out.error?.message);
    const expect = before.slice();
    if (unitsOfItems(items) === 0 && !hasAtoms && info0.list.kind !== 'none') {
      assert.strictEqual(r.edit.label, 'Change List');                // empty list item: list off, no new paragraph
      stats.listOff++;
    } else {
      assert.strictEqual(r.edit.label, 'Split Paragraph');
      expect.splice(i, 1, 'P:' + itemsText(c.before), 'P:' + itemsText(c.after));
      assert.strictEqual(ctx.model.blocks()[i + 1].id, r.out.focus.blockId);
      stats.split++;
    }
    assert.deepStrictEqual(reading(ctx), expect, 'split: the two halves read as cut');
    return r.edit;
  }
  if (roll < 0.75) {
    const b = pick(editable);
    const prev = ctx.model.siblings(b).prev;
    const ok = prev !== null && isEditable(prev) && !paragraphProps(prev.el).hasSectPr;
    const affected = ok ? [prev.id, b.id] : undefined;
    const i = indexOfBlock(ctx, b.id);
    const r = apply(ctx, { op: 'mergeWithPrevious', blockId: b.id, items: identity(ctx, b) }, { ...light, affected });
    assert.strictEqual(r.out.ok, ok, `merge of ${b.id}: ${r.out.error?.message ?? 'accepted'}`);
    if (!ok) { stats.refused++; return null; }
    const expect = before.slice();
    expect.splice(i - 1, 2, before[i - 1] + before[i].slice(2));
    assert.deepStrictEqual(reading(ctx), expect, 'merge: the texts are joined');
    assert.strictEqual(r.out.focus.at, before[i - 1].length - 2);
    stats.merge++;
    return r.edit;
  }
  if (roll < 0.87) {
    const target = rand() < 0.1 ? null : pick(blocks);
    const refusedHere = target !== null && (target.container.lockReason !== null
      || (target.container.tableBlockId === null && target.el.local === 'sectPr')
      || (target.lockReason === 'multi-paragraph-field' && ctx.model.siblings(target).next?.lockReason === 'multi-paragraph-field'));
    const point = target === null ? spanOf(ctx, [blocks[0].id]).start : endOf(ctx, target.id);
    const r = apply(ctx, { op: 'insertParagraphAfter', blockId: target ? target.id : null }, { ...light, affected: [], points: [point] });
    assert.strictEqual(r.out.ok, !refusedHere, r.out.error?.message);
    if (refusedHere) { stats.refused++; return null; }
    const at = indexOfBlock(ctx, r.out.focus.blockId);
    const expect = before.slice();
    expect.splice(at, 0, 'P:');
    assert.deepStrictEqual(reading(ctx), expect, 'insert: one empty paragraph more');
    if (target) assert.strictEqual(ctx.model.siblings(ctx.model.block(r.out.focus.blockId)).prev.id, target.id);
    stats.insert++;
    return r.edit;
  }
  {
    const b = pick(blocks);
    const i0 = info(ctx, b.id);
    const i = indexOfBlock(ctx, b.id);
    const { prev, next } = ctx.model.siblings(b);
    const anchors = i0.removable && ctx.model.segments(b).some((s) => s.kind === 'anchor');
    const affected = i0.removable ? [b.id, ...(anchors ? [next && isEditable(next) ? next.id : prev.id] : [])] : undefined;
    const r = apply(ctx, { op: 'removeParagraph', blockId: b.id }, { ...light, affected });
    assert.strictEqual(r.out.ok, i0.removable, `remove of ${b.id}: ${r.out.error?.message ?? 'accepted'}`);
    if (!i0.removable) { stats.refused++; return null; }
    const expect = before.slice();
    expect.splice(i, 1);
    assert.deepStrictEqual(reading(ctx), expect, 'remove: one paragraph fewer, the others read the same');
    stats.remove++;
    return r.edit;
  }
}

/** Ids of every range marker in the document, as "kind:id:role" (nothing may ever be lost). */
function anchorCensus(ctx) {
  const text = mainText(ctx);
  return (text.match(/<w:(?:bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference)\b[^>]*>/g) ?? [])
    .map((m) => m.replace(/ w:(?!id=)[\w:]+="[^"]*"/g, '')).sort();
}
const atomCensus = (ctx) => ['<w:drawing', '<w:hyperlink', '<w:footnoteReference', '<w:fldChar', '<w:br w:type="page"', '<w:sdt>', '<w:sectPr']
  .map((n) => count(mainText(ctx), n));

for (const [name, seed] of [['basic.docx', 2901], ['tables.docx', 2902], ['anchors.docx', 2903], ['rich.docx', 2904], ['multi-run.docx', 2905],
  ['fields.docx', 2906], ['content-controls.docx', 2907]]) {
  test(`seeded 200-op random sequence over ${name}: commits and structure ops, each step G4/G5/census, then validate, reload and undo everything → identical bytes`, () => {
    const ctx = open(name);
    const rand = rng(seed);
    const census = ctx.model.loadTableCensus;
    const anchors = anchorCensus(ctx);
    const atoms = atomCensus(ctx);
    const stats = { commit: 0, split: 0, merge: 0, insert: 0, remove: 0, listOff: 0, refused: 0 };
    const edits = [];
    for (let k = 0; k < 200; k++) {
      const edit = randomOp(ctx, rand, stats);
      if (edit) edits.push(edit);
      assert.strictEqual(ctx.model.tableCensus(), census, `step ${k}: table census`);
      if (k % 50 === 49) {
        // Mid-sequence: the state so far would save, and reads back the same.
        const bytes = verifyOutput(ctx, `${name} step ${k}`);
        assert.deepStrictEqual(reading(open('mid.docx', bytes)), reading(ctx));
      }
    }
    assert.ok(stats.commit > 20 && stats.split > 20 && stats.merge > 5 && stats.insert > 5 && stats.remove > 3, `${name}: every operation exercised ${JSON.stringify(stats)}`);
    assert.deepStrictEqual(anchorCensus(ctx), anchors, 'no bookmark or comment marker lost or duplicated');
    assert.deepStrictEqual(atomCensus(ctx), atoms, 'no image, link, footnote, field, break, control or section lost or duplicated');
    const bytes = verifyOutput(ctx, name);
    assertG3(ctx.orig, bytes, [MAIN]);
    saxesOk(mainText(ctx));
    const re = open('reload.docx', bytes);
    assert.deepStrictEqual(reading(re), reading(ctx), 'reload reads the same document');
    assert.strictEqual(re.model.tableCensus(), census);
    writeOut(OUT, `random-${name}`, bytes);
    // Redo everything from the original on a fresh package: same bytes (the edits are self-contained).
    const again = open(name);
    for (const e of edits) applyEdit(again.pkg, e);
    assertBytesEqual(again.pkg.serialize(), bytes, 'replaying the edits on the original gives the same file');
    undoAll(ctx, edits);
  });
}
