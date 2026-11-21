// WP-06: OPC helpers and OfficePackage (src/office/core/opc.ts, package.ts).
// Spec §4, §6.1, §8.1/§9.1 (main-part discovery, view-only reasons), §10.1–10.3, §13.2 G0–G3.
//
// This file owns the full-fixture G2 run that WP-05's xml.test.mjs promised: every XML part
// (.xml/.rels/.vml) of every fixture archive, reached through OfficePackage, unconditionally.
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import { core, fixture, allFixtures, assertBytesEqual, entryTable, writeOut } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { OfficeLoadError } = core.sniff;
const opc = core.opc;
const x = core.xml;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Fixtures the container reader or sniff refuses by design (sniff.test.mjs classifies them). */
const NEGATIVE = new Set(['encrypted.docx', 'encrypted.xlsx', 'legacy-renamed.docx', 'truncated.docx', 'zip64.xlsx']);
const openable = () => allFixtures().filter((f) => !NEGATIVE.has(f));

/** Open `name`, apply `edit(pkg)` (setPart etc.), return the serialised bytes. */
function patched(name, edit) {
  const p = OfficePackage.open(name, fixture(name));
  edit(p);
  return p.serialize();
}
const replaceText = (p, part, from, to) => {
  const t = p.text(part);
  assert.ok(t.includes(from), `${part} should contain ${from}`);
  p.setPart(part, enc.encode(t.split(from).join(to)));
};
const loadFailure = (name, bytes) => {
  try { OfficePackage.open(name, bytes); } catch (e) { assert.ok(e instanceof OfficeLoadError, `expected OfficeLoadError, got ${e}`); return e.failure; }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Acceptance tests (plan WP-06)

test('G1 via OfficePackage.serialize({force:true}) on every fixture', () => {
  const names = openable();
  assert.ok(names.length >= 30, `expected the WP-03 fixture set, found ${names.length}`);
  for (const f of names) {
    const bytes = fixture(f);
    const out = OfficePackage.open(f, bytes).serialize({ force: true });
    assert.notStrictEqual(out, bytes, `${f}: force must run the writer`);
    assertBytesEqual(out, bytes, `G1 failed for ${f}`);
  }
});

test('G0: serialize() with nothing touched returns the original bytes object', () => {
  for (const f of openable()) {
    const bytes = fixture(f);
    const p = OfficePackage.open(f, bytes);
    // Reading and parsing parts is not an edit.
    for (const part of p.partNames().filter((n) => /\.(xml|rels)$/.test(n)).slice(0, 5)) p.xml(part);
    assert.deepStrictEqual(p.touchedParts(), [], f);
    assert.strictEqual(p.serialize(), bytes, `${f}: serialize() must return originalBytes itself`);
    assert.strictEqual(p.originalBytes, bytes, f);
  }
});

test('G2 across every fixture part', (t) => {
  let archives = 0;
  let parts = 0;
  for (const f of openable()) {
    const p = OfficePackage.open(f, fixture(f));
    archives++;
    for (const part of p.partNames()) {
      if (!/\.(xml|rels|vml)$/i.test(part)) continue;
      if (f === 'damaged-sheet.xlsx' && part === 'xl/worksheets/sheet3.xml') continue;   // malformed on purpose
      const text = p.text(part);
      assert.strictEqual(x.serialize(p.xml(part)), text, `G2 failed for ${f}:${part}`);
      parts++;
    }
  }
  assert.strictEqual(archives, openable().length);
  assert.ok(parts >= 300, `expected the full fixture part set, checked ${parts}`);
  t.diagnostic(`${archives} archives, ${parts} XML parts round-tripped`);
});

test('main part found through _rels/.rels, not by path', () => {
  const renamed = patched('basic.docx', (p) => {
    p.setPart('word/body-main.xml', p.bytes('word/document.xml'));
    p.setPart('word/document.xml', null);
    p.setPart('word/_rels/body-main.xml.rels', p.bytes('word/_rels/document.xml.rels'));
    p.setPart('word/_rels/document.xml.rels', null);
    replaceText(p, '_rels/.rels', 'Target="word/document.xml"', 'Target="/word/body-main.xml"');
    replaceText(p, '[Content_Types].xml', 'PartName="/word/document.xml"', 'PartName="/word/body-main.xml"');
  });
  const p = OfficePackage.open('renamed.docx', renamed);
  assert.strictEqual(p.kind, 'docx');
  assert.strictEqual(p.viewOnlyReason, null);
  assert.strictEqual(p.has('word/document.xml'), false);
  assert.deepStrictEqual(opc.mainPart(p), {
    name: 'word/body-main.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  });
  assert.ok(opc.readRelationships(p, 'word/body-main.xml').some((r) => r.target === 'styles.xml'));

  // A package whose main-part relationship is missing is damaged, even with word/document.xml present.
  const noRel = patched('basic.docx', (p2) => replaceText(p2, '_rels/.rels', '/relationships/officeDocument"', '/relationships/notTheMainPart"'));
  assert.strictEqual(loadFailure('x.docx', noRel), 'damaged');
  const dangling = patched('basic.docx', (p2) => replaceText(p2, '_rels/.rels', 'Target="word/document.xml"', 'Target="word/missing.xml"'));
  assert.strictEqual(loadFailure('x.docx', dangling), 'damaged');
});

test('Strict namespace → strict-ooxml view-only', () => {
  const strictXlsx = patched('basic.xlsx', (p) => replaceText(p, 'xl/workbook.xml',
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"'));
  const a = OfficePackage.open('strict.xlsx', strictXlsx);
  assert.strictEqual(a.kind, 'xlsx');
  assert.strictEqual(a.viewOnlyReason, 'strict-ooxml');

  const strictDocx = patched('basic.docx', (p) => replaceText(p, 'word/document.xml',
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"'));
  assert.strictEqual(OfficePackage.open('strict.docx', strictDocx).viewOnlyReason, 'strict-ooxml');

  const strictRel = patched('basic.docx', (p) => replaceText(p, '_rels/.rels',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'));
  assert.strictEqual(OfficePackage.open('strict-rel.docx', strictRel).viewOnlyReason, 'strict-ooxml');

  // Strict beats the content-type reason.
  const both = patched('basic.xlsx', (p) => {
    replaceText(p, 'xl/workbook.xml', 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"');
    replaceText(p, '[Content_Types].xml', 'spreadsheetml.sheet.main+xml', 'spreadsheetml.template.main+xml');
  });
  assert.strictEqual(OfficePackage.open('both.xlsx', both).viewOnlyReason, 'strict-ooxml');
});

test('touch + serialize changes exactly that entry (G3)', () => {
  for (const [f, part] of [['basic.xlsx', 'xl/worksheets/sheet1.xml'], ['basic.docx', 'word/document.xml'], ['features.xlsx', 'xl/workbook.xml']]) {
    const bytes = fixture(f);
    const p = OfficePackage.open(f, bytes);
    const doc = p.xml(part);
    x.setAttr(doc.root, '', 'vsmdTest', '1');
    p.touch(part);
    assert.deepStrictEqual(p.touchedParts(), [part]);
    const out = p.serialize();
    writeOut('package', `g3-${f}`, out);
    const before = entryTable(bytes);
    const after = entryTable(out);
    assert.deepStrictEqual([...after.keys()], [...before.keys()], `${f}: entry names and order`);
    for (const [name, e] of before) {
      const a = after.get(name);
      if (name === part) {
        assert.notStrictEqual(a.crc, e.crc, `${f}: ${name} should change`);
      } else {
        assert.strictEqual(a.crc, e.crc, `${f}: ${name} crc`);
        assertBytesEqual(a.compressedBytes, e.compressedBytes, `${f}: ${name} compressed bytes`);
        assertBytesEqual(a.cdRecordBytes, e.cdRecordBytes, `${f}: ${name} central record`);
      }
    }
    // The changed part reads back as the edited tree, and everything else is still untouched.
    const re = OfficePackage.open(f, out);
    assert.strictEqual(re.text(part), x.serialize(doc));
    assert.strictEqual(x.attr(re.xml(part).root, '', 'vsmdTest'), '1');
  }
});

test('setPart add/delete round-trips through readZip', async () => {
  const bytes = fixture('basic.docx');
  const p = OfficePackage.open('basic.docx', bytes);
  const added = enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root xmlns="urn:vsmd-test">added</root>');
  p.setPart('customXml/vsmdItem.xml', added);
  p.setPart('/docProps/app.xml', null);
  const ghost = enc.encode('<g/>');
  p.setPart('customXml/ghost.xml', ghost);
  p.setPart('customXml/ghost.xml', null);   // created then deleted: leaves no trace
  assert.deepStrictEqual(p.touchedParts(), ['docProps/app.xml', 'customXml/vsmdItem.xml']);
  assert.strictEqual(p.has('docProps/app.xml'), false);
  assert.strictEqual(p.has('CUSTOMXML/VSMDITEM.XML'), true);
  const out = p.serialize();

  const zip = core.zip.readZip(out, core.pkg.zipLimits());
  const origNames = core.zip.readZip(bytes, core.pkg.zipLimits()).entries.map((e) => e.name);
  assert.deepStrictEqual(zip.entries.map((e) => e.name), [...origNames.filter((n) => n !== 'docProps/app.xml'), 'customXml/vsmdItem.xml']);
  const item = zip.entries.find((e) => e.name === 'customXml/vsmdItem.xml');
  assertBytesEqual(core.zip.inflateEntry(zip, item), added, 'added part content');
  assert.strictEqual(item.dosDate, (0 << 9) | (1 << 5) | 1, 'new entries are dated 1980-01-01');

  const re = OfficePackage.open('basic.docx', out);
  assert.strictEqual(re.has('docProps/app.xml'), false);
  assertBytesEqual(re.bytes('customXml/vsmdItem.xml'), added);
  // Independent reader agrees.
  const jz = await JSZip.loadAsync(out);
  assert.strictEqual(await jz.file('customXml/vsmdItem.xml').async('string'), dec.decode(added));
  assert.strictEqual(jz.file('docProps/app.xml'), null);

  // Deleting and restoring an original part with its original bytes copies the original entry again.
  const q = OfficePackage.open('basic.docx', bytes);
  const app = q.bytes('docProps/app.xml');
  q.setPart('docProps/app.xml', null);
  q.setPart('docProps/app.xml', app);
  assert.strictEqual(q.serialize(), bytes);
});

test('a created part deleted then re-created keeps its position among created parts (tombstone)', () => {
  const bytes = fixture('basic.docx');
  const names = (b) => core.zip.readZip(b, core.pkg.zipLimits()).entries.map((e) => e.name);
  const p = OfficePackage.open('basic.docx', bytes);
  const a = enc.encode('<a/>');
  const b = enc.encode('<b/>');
  const c = enc.encode('<c/>');
  p.setPart('customXml/a.xml', a);
  p.setPart('customXml/b.xml', b);
  p.setPart('customXml/c.xml', c);
  const created = ['customXml/a.xml', 'customXml/b.xml', 'customXml/c.xml'];
  const orig = names(bytes);
  const full = p.serialize();
  assert.deepStrictEqual(names(full), [...orig, ...created]);
  // Delete the first created part (an edit), then restore it (its undo).
  p.setPart('customXml/a.xml', null);
  assert.strictEqual(p.has('customXml/a.xml'), false);
  assert.deepStrictEqual(p.partNames().slice(-2), ['customXml/b.xml', 'customXml/c.xml']);
  assert.deepStrictEqual(names(p.serialize()), [...orig, 'customXml/b.xml', 'customXml/c.xml']);
  p.setPart('customXml/a.xml', a);
  assert.deepStrictEqual(p.partNames().slice(-3), created, 'back in its original slot');
  assertBytesEqual(p.serialize(), full, 'restored state is byte-identical, entry order included');
  // A re-creation under a different case takes the new case, same slot.
  p.setPart('customXml/b.xml', null);
  p.setPart('CustomXml/B.xml', b);
  assert.deepStrictEqual(p.partNames().slice(-3), ['customXml/a.xml', 'CustomXml/B.xml', 'customXml/c.xml']);
  // Deleting every created part leaves no trace: nothing touched, original bytes object.
  for (const n of ['customXml/a.xml', 'customXml/b.xml', 'customXml/c.xml']) p.setPart(n, null);
  assert.deepStrictEqual(p.touchedParts(), []);
  assert.strictEqual(p.serialize(), bytes);
  assert.strictEqual(p.has('customXml/c.xml'), false);
  assert.throws(() => p.bytes('customXml/c.xml'), /Part not found/);
});

// ---------------------------------------------------------------------------------------------
// Further package behaviour

test('edit then undo serialises byte-identical to the original (G5 groundwork)', () => {
  const bytes = fixture('basic.xlsx');
  const p = OfficePackage.open('basic.xlsx', bytes);
  const sheet = 'xl/worksheets/sheet1.xml';
  const doc = p.xml(sheet);
  const sheetData = x.child(doc.root, doc.root.ns, 'sheetData');
  const removed = x.removeAt(sheetData, 0);
  p.touch(sheet);
  assert.notStrictEqual(p.serialize(), bytes);
  x.insertAt(sheetData, 0, removed);
  const out = p.serialize();
  assert.deepStrictEqual(p.touchedParts(), [sheet]);
  assertBytesEqual(out, bytes, 'edit + undo');
  assert.strictEqual(out, bytes, 'nothing actually changed, so the original object comes back');
});

test('an unparseable part that is only copied never blocks opening (VML policy, §10.1)', () => {
  const vml = 'xl/drawings/vmlDrawing1.vml';
  const broken = enc.encode('<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape><br></v:shape></xml>');
  const bytes = patched('features.xlsx', (p) => p.setPart(vml, broken));
  const p = OfficePackage.open('features.xlsx', bytes);
  assert.strictEqual(p.viewOnlyReason, null);
  assertBytesEqual(p.serialize({ force: true }), bytes, 'G1 with a malformed copy-only part');
  assert.throws(() => p.xml(vml), (e) => e instanceof x.XmlError);
  assert.throws(() => p.touch(vml), /not been parsed/);
  // Editing another part leaves the malformed one byte-identical.
  const wb = p.xml('xl/workbook.xml');
  x.setAttr(wb.root, '', 'vsmdTest', '1');
  p.touch('xl/workbook.xml');
  const out = p.serialize();
  const a = entryTable(bytes).get(vml);
  const b = entryTable(out).get(vml);
  assertBytesEqual(b.compressedBytes, a.compressedBytes, 'malformed VML copied raw');
  assertBytesEqual(OfficePackage.open('features.xlsx', out).bytes(vml), broken);
});

test('view-only reasons: macro/template content types, UTF-16 main part, too-large document.xml', () => {
  const macro = patched('basic.xlsx', (p) => replaceText(p, '[Content_Types].xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'));
  assert.strictEqual(OfficePackage.open('m.xlsm', macro).viewOnlyReason, 'unsupported-xml-layout');
  const template = patched('basic.docx', (p) => replaceText(p, '[Content_Types].xml',
    'wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml'));
  const tp = OfficePackage.open('t.dotx', template);
  assert.strictEqual(tp.kind, 'docx');
  assert.strictEqual(tp.viewOnlyReason, 'unsupported-xml-layout');

  // UTF-16 main part: viewable, view-only, and never written.
  const utf16 = patched('basic.xlsx', (p) => {
    const t = p.text('xl/workbook.xml').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
    const body = Buffer.from(t, 'utf16le');
    p.setPart('xl/workbook.xml', new Uint8Array([0xff, 0xfe, ...body]));
  });
  const u = OfficePackage.open('u.xlsx', utf16);
  assert.strictEqual(u.viewOnlyReason, 'utf16-part');
  assert.strictEqual(u.xml('xl/workbook.xml').root.local, 'workbook');
  assert.throws(() => u.touch('xl/workbook.xml'), /UTF-16/);

  // A UTF-16 part found later (not read by open) flips the reason when first decoded.
  const lateUtf16 = patched('basic.xlsx', (p) => {
    const t = p.text('docProps/core.xml').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
    p.setPart('docProps/core.xml', new Uint8Array([0xff, 0xfe, ...Buffer.from(t, 'utf16le')]));
  });
  const lu = OfficePackage.open('lu.xlsx', lateUtf16);
  assert.strictEqual(lu.viewOnlyReason, null);
  lu.xml('docProps/core.xml');
  assert.strictEqual(lu.viewOnlyReason, 'utf16-part');

  // document.xml over the docx limit (declared size from the central directory, nothing parsed).
  const L = core.limits.LIMITS;
  const big = patched('basic.docx', (p) => {
    const t = p.text('word/document.xml');
    p.setPart('word/document.xml', enc.encode(t + ' '.repeat(L.docxMaxDocumentXmlBytes)));
  });
  assert.strictEqual(OfficePackage.open('big.docx', big).viewOnlyReason, 'too-large');
});

test('refuses packages that are not a Word/Excel XML document of the expected kind', () => {
  assert.strictEqual(loadFailure('workbook.docx', fixture('basic.xlsx')), 'unsupported-packaging', 'xlsx named .docx');
  assert.strictEqual(loadFailure('document.xlsx', fixture('basic.docx')), 'unsupported-packaging', 'docx named .xlsx');
  assert.strictEqual(OfficePackage.open('no-extension', fixture('basic.xlsx')).kind, 'xlsx');
  const pptLike = patched('basic.docx', (p) => replaceText(p, '[Content_Types].xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'));
  assert.strictEqual(loadFailure('p.docx', pptLike), 'unsupported-packaging');
  const noTypes = patched('basic.docx', (p) => p.setPart('[Content_Types].xml', null));
  assert.strictEqual(loadFailure('x.docx', noTypes), 'damaged');
  const badRels = patched('basic.docx', (p) => p.setPart('_rels/.rels', enc.encode('<Relationships><oops></Relationships>')));
  assert.strictEqual(loadFailure('x.docx', badRels), 'damaged');
  const doctype = patched('basic.docx', (p) => replaceText(p, 'word/document.xml', '<w:document', '<!DOCTYPE w:document><w:document'));
  assert.strictEqual(loadFailure('x.docx', doctype), 'damaged');
});

test('lookup is case-insensitive and keeps the original case; xml() is cached; xmlAsync shares the tree', async () => {
  const p = OfficePackage.open('large.xlsx', fixture('large.xlsx'));
  assert.ok(p.has('XL/WORKBOOK.XML') && p.has('/xl/workbook.xml'));
  assert.ok(p.partNames().includes('xl/workbook.xml'));
  assert.strictEqual(p.xml('XL/workbook.xml'), p.xml('xl/workbook.xml'));
  assert.throws(() => p.bytes('xl/nope.xml'), /Part not found/);
  const sheet = 'xl/worksheets/sheet1.xml';
  const [a, b] = await Promise.all([p.xmlAsync(sheet), p.xmlAsync(sheet)]);
  assert.strictEqual(a, b);
  assert.strictEqual(p.xml(sheet), a);
  assert.strictEqual(await p.xmlAsync('xl/workbook.xml'), p.xml('xl/workbook.xml'));
  await assert.rejects(p.xmlAsync('xl/nope.xml'), /Part not found/);
  // A setPart during an async parse never installs the stale tree.
  const q = OfficePackage.open('large.xlsx', fixture('large.xlsx'));
  const pending = q.xmlAsync(sheet);
  q.setPart(sheet, enc.encode('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'));
  const fresh = await pending;
  assert.strictEqual(fresh.root.children.length, 0);
  assert.strictEqual(q.xml(sheet), fresh);
});

// ---------------------------------------------------------------------------------------------
// opc.ts helpers

test('partNameFromTarget and relsPartFor', () => {
  const f = opc.partNameFromTarget;
  assert.strictEqual(f('', 'word/document.xml'), 'word/document.xml');
  assert.strictEqual(f('', '/xl/workbook.xml'), 'xl/workbook.xml');
  assert.strictEqual(f('xl/workbook.xml', 'worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.strictEqual(f('xl/worksheets/sheet1.xml', '../drawings/drawing1.xml'), 'xl/drawings/drawing1.xml');
  assert.strictEqual(f('xl/worksheets/sheet1.xml', '/xl/media/a.png'), 'xl/media/a.png');
  assert.strictEqual(f('word/document.xml', './media/./image1.png'), 'word/media/image1.png');
  assert.strictEqual(f('word/document.xml', 'Footnotes.XML'), 'word/Footnotes.XML');
  assert.strictEqual(f('word/document.xml', 'settings.xml#frag'), 'word/settings.xml');
  assert.throws(() => f('word/document.xml', '../../x.xml'), /escapes/);
  assert.strictEqual(opc.relsPartFor(''), '_rels/.rels');
  assert.strictEqual(opc.relsPartFor('xl/workbook.xml'), 'xl/_rels/workbook.xml.rels');
  assert.strictEqual(opc.relsPartFor('/word/document.xml'), 'word/_rels/document.xml.rels');
  assert.strictEqual(opc.relsPartFor('root.xml'), '_rels/root.xml.rels');
});

test('readRelationships and contentTypeOf on real fixtures', () => {
  const p = OfficePackage.open('rich.docx', fixture('rich.docx'));
  const rels = opc.readRelationships(p, 'word/document.xml');
  const link = rels.find((r) => r.type.endsWith('/hyperlink'));
  assert.ok(link && link.external && /^https?:/.test(link.target), 'external hyperlink relationship');
  for (const r of rels.filter((r2) => !r2.external)) {
    assert.ok(p.has(opc.partNameFromTarget('word/document.xml', r.target)), `${r.id} -> ${r.target} resolves`);
  }
  assert.deepStrictEqual(opc.readRelationships(p, 'word/styles.xml'), [], 'no rels part => []');
  assert.strictEqual(opc.contentTypeOf(p, 'word/styles.xml'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml');
  assert.strictEqual(opc.contentTypeOf(p, '/WORD/STYLES.XML'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml');
  assert.strictEqual(opc.contentTypeOf(p, '_rels/.rels'), 'application/vnd.openxmlformats-package.relationships+xml', 'Default by extension');
  const media = p.partNames().find((n) => /^word\/media\/.*\.(png|jpe?g)$/i.test(n));
  assert.ok(media && /^image\//.test(opc.contentTypeOf(p, media)), 'media part gets the Default image type');
  assert.strictEqual(opc.contentTypeOf(p, 'word/no-such.unknownext'), undefined);

  const pref = OfficePackage.open('prefixed-namespaces.xlsx', fixture('prefixed-namespaces.xlsx'));
  assert.deepStrictEqual(opc.mainPart(pref).name, 'xl/workbook.xml');
  assert.strictEqual(pref.kind, 'xlsx');
  assert.strictEqual(pref.viewOnlyReason, null);
});

test('real fixtures open with the expected kind and no document-level view-only reason', () => {
  for (const f of openable()) {
    const p = OfficePackage.open(f, fixture(f));
    assert.strictEqual(p.kind, f.endsWith('.docx') ? 'docx' : 'xlsx', f);
    assert.strictEqual(p.viewOnlyReason, null, `${f}: ${p.viewOnlyReason}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Gate R0 regressions

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
/** Start of an entry's compressed data in `bytes`. */
const dataStart = (bytes, e) => e.extent[0] + 30 + u16le(bytes, e.extent[0] + 26) + u16le(bytes, e.extent[0] + 28);

test('R0: a hostile [Content_Types].xml is refused quickly, not parsed for seconds', () => {
  const XL = core.limits.LIMITS;
  const ct = OfficePackage.open('basic.docx', fixture('basic.docx')).text('[Content_Types].xml');
  for (const [n, refused] of [[XL.xmlMaxDepth - 2, false], [20_000, true]]) {
    const bytes = patched('basic.docx', (p) => {
      const bomb = '<z xmlns:x="urn:junk">'.repeat(n) + '</z>'.repeat(n);
      p.setPart('[Content_Types].xml', enc.encode(ct.replace('</Types>', bomb + '</Types>')));
    });
    const t0 = performance.now();
    const failure = loadFailure('hostile.docx', bytes);
    const ms = performance.now() - t0;
    assert.strictEqual(failure, refused ? 'damaged' : null, `depth ${n}`);
    assert.ok(ms < 2000, `depth ${n}: open took ${ms.toFixed(0)} ms (was 12-17 s at depth 20,000)`);
  }
});

test('R0: open reads only a bounded prefix of the main part', () => {
  // A 25 MB document.xml whose compressed tail is damaged: open must classify it (too-large) from the
  // central directory and the root start tag alone; a full inflate would hit the damage.
  const doc = OfficePackage.open('basic.docx', fixture('basic.docx')).text('word/document.xml');
  const filler = '<w:p/>'.repeat(Math.ceil((25 * 1024 * 1024) / 6));
  const bytes = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(doc.replace('<w:body>', '<w:body>' + filler))));
  const zip = core.zip.readZip(bytes, core.pkg.zipLimits());
  const e = zip.entries.find((x) => x.name === 'word/document.xml');
  const start = dataStart(bytes, e);
  const damaged = bytes.slice();
  for (let i = start + e.compressedSize - 300; i < start + e.compressedSize - 20; i++) damaged[i] ^= 0xa5;

  for (const b of [bytes, damaged]) {
    const t0 = performance.now();
    const p = OfficePackage.open('big.docx', b);
    const ms = performance.now() - t0;
    assert.strictEqual(p.viewOnlyReason, 'too-large');
    assert.ok(ms < 1000, `open took ${ms.toFixed(0)} ms`);
  }
  // The damage is real: reading the whole part fails (synchronously and asynchronously).
  const p = OfficePackage.open('big.docx', damaged);
  assert.throws(() => p.bytes('word/document.xml'), (err) => err instanceof core.zip.ZipError);
  return assert.rejects(p.xmlAsync('word/document.xml'), (err) => err instanceof core.zip.ZipError);
});

test('R0: open finds the root start tag past a long prolog, and still refuses DOCTYPE and bad UTF-8', () => {
  const doc = OfficePackage.open('basic.docx', fixture('basic.docx')).text('word/document.xml');
  const decl = doc.slice(0, doc.indexOf('?>') + 2);
  const rest = doc.slice(decl.length);
  // A 200 KB comment before the root: past the first 64 KB scan, within the second.
  const long = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(decl + '<!--' + 'x'.repeat(200_000) + '-->' + rest)));
  assert.strictEqual(OfficePackage.open('long.docx', long).viewOnlyReason, null);
  const strict = patched('basic.docx', (p) => p.setPart('word/document.xml',
    enc.encode(decl + '<!--' + 'x'.repeat(200_000) + '-->' + rest.replace(/http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main/g, 'http://purl.oclc.org/ooxml/wordprocessingml/main'))));
  assert.strictEqual(OfficePackage.open('strict.docx', strict).viewOnlyReason, 'strict-ooxml');
  // Past both scans: refused as damaged rather than read in full.
  const tooLong = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(decl + '<!--' + 'x'.repeat(1_100_000) + '-->' + rest)));
  assert.strictEqual(loadFailure('toolong.docx', tooLong), 'damaged');
  const dt = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(decl + '<!DOCTYPE w:document>' + rest)));
  assert.strictEqual(loadFailure('dt.docx', dt), 'damaged');
  // A multi-byte character cut by the 64 KB scan boundary is not an encoding error.
  for (let pad = 0; pad < 4; pad++) {
    const cut = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(decl + '<!--' + 'x'.repeat(65536 - decl.length - 4 - pad) + '€\u{1F600}'.repeat(40_000) + '-->' + rest)));
    assert.strictEqual(OfficePackage.open('cut.docx', cut).viewOnlyReason, null, `pad ${pad}`);
  }
  // Invalid UTF-8 inside the scanned prefix is still damaged.
  const badUtf8 = patched('basic.docx', (p) => {
    const b = enc.encode(decl + '<!--é-->' + rest);
    b[decl.length + 4] = 0xff;
    p.setPart('word/document.xml', b);
  });
  assert.strictEqual(loadFailure('bad.docx', badUtf8), 'damaged');
});

test('R0: xmlAsync on a large part inflates asynchronously and equals xml()', async () => {
  const doc = OfficePackage.open('basic.docx', fixture('basic.docx')).text('word/document.xml');
  const filler = '<w:p><w:r><w:t>text</w:t></w:r></w:p>'.repeat(150_000);   // ~5.5 MB
  const bytes = patched('basic.docx', (p) => p.setPart('word/document.xml', enc.encode(doc.replace('<w:body>', '<w:body>' + filler))));
  const a = OfficePackage.open('a.docx', bytes);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  let tree;
  try { tree = await a.xmlAsync('word/document.xml'); } finally { clearInterval(iv); }
  assert.ok(ticks > 0);
  const b = OfficePackage.open('b.docx', bytes);
  assert.strictEqual(x.serialize(tree), x.serialize(b.xml('word/document.xml')));
  assert.strictEqual(a.xml('word/document.xml'), tree, 'cached');
  // Edit -> revert through the async tree still serialises to the original bytes object (G5 groundwork).
  a.touch('word/document.xml');
  assert.strictEqual(a.serialize(), bytes);
});

test('R0: serialize({force:true}) writes original entries in file order, not central-directory order', () => {
  const orig = fixture('basic.docx');
  const zip = core.zip.readZip(orig, core.pkg.zipLimits());
  // Reverse the central directory (offsets in each record stay valid).
  const cdStart = Math.min(...zip.entries.map((e) => e.cdRecord[0]));
  const cdEnd = Math.max(...zip.entries.map((e) => e.cdRecord[1]));
  const reordered = orig.slice();
  let w = cdStart;
  for (const e of [...zip.entries].reverse()) {
    reordered.set(orig.subarray(e.cdRecord[0], e.cdRecord[1]), w);
    w += e.cdRecord[1] - e.cdRecord[0];
  }
  assert.strictEqual(w, cdEnd);
  const fileOrder = [...zip.entries].sort((a, b) => a.extent[0] - b.extent[0]).map((e) => e.name);
  const p = OfficePackage.open('basic.docx', reordered);
  const out = p.serialize({ force: true });
  const z2 = core.zip.readZip(out, core.pkg.zipLimits());
  assert.deepStrictEqual(z2.entries.map((e) => e.name), fileOrder, 'output CD order = original file order');
  assert.deepStrictEqual([...z2.entries].sort((a, b) => a.extent[0] - b.extent[0]).map((e) => e.name), fileOrder);
  // Local entries are copied verbatim, so the bytes before the central directory are identical.
  assertBytesEqual(out.subarray(0, cdStart), orig.subarray(0, cdStart), 'local entries');
});

test('R0: partNameFromTarget with only a fragment names the source part', () => {
  assert.strictEqual(opc.partNameFromTarget('word/document.xml', '#_Toc1'), 'word/document.xml');
  assert.strictEqual(opc.partNameFromTarget('/word/document.xml', ''), 'word/document.xml');
  assert.strictEqual(opc.partNameFromTarget('word/document.xml', 'media/a.png#x'), 'word/media/a.png');
  assert.throws(() => opc.partNameFromTarget('', '#frag'), /does not name a part/);
});

test('partSize returns declared central-directory sizes without inflating', () => {
  const bytes = fixture('basic.xlsx');
  const zip = core.zip.readZip(bytes, core.pkg.zipLimits());
  const p = OfficePackage.open('basic.xlsx', bytes);
  for (const e of zip.entries) {
    if (e.name.endsWith('/')) { assert.strictEqual(p.partSize(e.name), undefined); continue; }
    assert.deepStrictEqual(p.partSize(e.name), { compressed: e.compressedSize, uncompressed: e.uncompressedSize }, e.name);
    assert.deepStrictEqual(p.partSize('/' + e.name.toUpperCase()), p.partSize(e.name), 'case-insensitive, leading slash ignored');
  }
  assert.strictEqual(p.partSize('xl/nope.xml'), undefined);
  const sheet = zip.entries.find((e) => /worksheets\/sheet1\.xml$/i.test(e.name));
  p.setPart(sheet.name, enc.encode('<x/>'));
  assert.deepStrictEqual(p.partSize(sheet.name), { compressed: sheet.compressedSize, uncompressed: sheet.uncompressedSize }, 'replaced: original entry sizes');
  p.setPart('xl/new.xml', enc.encode('<x/>'));
  assert.strictEqual(p.partSize('xl/new.xml'), undefined, 'created: no entry');
  p.setPart(sheet.name, null);
  assert.strictEqual(p.partSize(sheet.name), undefined, 'deleted');
});
