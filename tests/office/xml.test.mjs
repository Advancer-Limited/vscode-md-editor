// WP-05: lossless XML (src/office/core/xml.ts). Spec §3.3, §6.3, §10.2, §12, G2, G4.
//
// Fixture parts: tests/fixtures/office/parts/ holds hand-authored OOXML parts laid out as extracted
// packages (checked in byte-exact; `.gitattributes` marks the directory binary):
//   docx-pretty/word/document.xml            pretty-printed body: runs, bookmarks, comments, simple and complex
//                                            fields, hyperlink, table with a nested table, mc:AlternateContent
//   docx-min/word/document.xml               Word-style: declaration + CRLF, then the body on one line
//   docx-min/_rels/.rels, word/_rels/document.xml.rels, [Content_Types].xml
//   prefixed-namespaces/xl/worksheets/sheet1.xml   `x:`-prefixed SpreadsheetML, CRLF line endings
//   prefixed-namespaces/xl/sharedStrings.xml       `x:`-prefixed, UTF-8 BOM, rich text, literal LF in text
//   xlsx-legacy/xl/drawings/vmlDrawing1.vml        legacy VML (root <xml>, single quotes, multi-line attrs), CRLF
//
// Once the ZIP reader (WP-04) and the fixture archives (WP-03) are present, the G2 and saxes tests also
// cover every XML part of every fixture archive automatically (WP-06 makes that the full run).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { core, fixture, allFixtures, commonAffixes } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { SaxesParser } = require('saxes');
const x = core.xml;

const here = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = path.join(here, '..', 'fixtures', 'office', 'parts');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML_PART = /\.(xml|rels|vml)$/i;

function listParts(dir = PARTS_DIR, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listParts(path.join(dir, e.name), rel));
    else if (XML_PART.test(e.name)) out.push(rel);
  }
  return out.sort();
}
const partBytes = (rel) => new Uint8Array(fs.readFileSync(path.join(PARTS_DIR, rel)));
const partText = (rel) => x.decodePart(partBytes(rel)).text;

/** Every XML part available: the checked-in parts, plus every part of every fixture archive once core.zip exists. */
function allXmlParts() {
  const out = listParts().map((rel) => ({ name: `parts/${rel}`, bytes: partBytes(rel) }));
  const zip = core.zip;
  if (typeof zip.readZip !== 'function' || typeof zip.inflateEntry !== 'function') return { parts: out, archives: 0, skipped: [] };
  const L = core.limits.LIMITS;
  const limits = { maxFileBytes: L.maxFileBytes, maxTotalUncompressed: L.maxUncompressedTotalBytes, maxEntryUncompressed: L.maxEntryBytes };
  let archives = 0;
  const skipped = [];
  for (const f of allFixtures()) {
    let archive;
    try { archive = zip.readZip(fixture(f), limits); } catch (e) { skipped.push(`${f} (${e.code ?? e.message})`); continue; }
    archives++;
    for (const entry of archive.entries) {
      if (XML_PART.test(entry.name)) out.push({ name: `${f}!${entry.name}`, bytes: zip.inflateEntry(archive, entry) });
    }
  }
  return { parts: out, archives, skipped };
}

function elementsOf(doc) {
  const out = [];
  const walk = (el) => { out.push(el); for (const c of el.children) if (c.type === 'el') walk(c); };
  walk(doc.root);
  return out;
}

function findEl(doc, pred) { return elementsOf(doc).find(pred); }

/** G4: `after` equals `before` outside [start, end) of `before`. */
function assertLocal(before, after, start, end, msg = 'G4') {
  const { prefix, suffix } = commonAffixes(before, after);
  assert.ok(prefix >= start, `${msg}: prefix differs before the target (common prefix ${prefix} < ${start})`);
  assert.ok(suffix >= before.length - end, `${msg}: suffix differs after the target (common suffix ${suffix} < ${before.length - end})`);
}

function mustThrow(fn, code) {
  assert.throws(fn, (e) => e instanceof x.XmlError && e.code === code && typeof e.offset === 'number', `expected XmlError ${code}`);
}

// ---------------------------------------------------------------------------------------------------

test('G2: serialize(parse(x)) === x for every XML part of every fixture', async (t) => {
  const { parts, archives, skipped } = allXmlParts();
  assert.ok(parts.length >= 8, 'checked-in parts are present');
  for (const p of parts) {
    const { text } = x.decodePart(p.bytes);
    assert.strictEqual(x.serialize(x.parseXml(text)), text, `G2 failed for ${p.name}`);
    assert.strictEqual(x.serialize(await x.parseXmlAsync(text, 1)), text, `G2 (async) failed for ${p.name}`);
    const re = x.encodePart(text, x.decodePart(p.bytes).bom);
    if (x.decodePart(p.bytes).encoding === 'utf-8') assert.deepStrictEqual(Buffer.from(re), Buffer.from(p.bytes), `bytes round-trip for ${p.name}`);
  }
  t.diagnostic(`${parts.length} parts checked; fixture archives read: ${archives}${skipped.length ? `; unreadable (expected for negative fixtures): ${skipped.join(', ')}` : ''}`);
});

test('every element serialises to its own source slice', () => {
  for (const rel of listParts()) {
    const text = partText(rel);
    const doc = x.parseXml(text);
    let from = 0;
    for (const el of elementsOf(doc)) {
      const s = x.serialize(el);
      const at = text.indexOf(s, from);
      assert.ok(at >= 0, `${rel}: <${el.rawName}> slice not found in order`);
      from = at + 1;
    }
  }
});

test('rejects <!DOCTYPE anywhere in the prolog', () => {
  mustThrow(() => x.parseXml('<!DOCTYPE a><a/>'), 'doctype');
  mustThrow(() => x.parseXml('<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY e "x">]>\n<a>&e;</a>'), 'doctype');
  mustThrow(() => x.parseXml('<?xml version="1.0"?><!-- c --><?pi x?>\r\n<!DOCTYPE a SYSTEM "http://evil/x.dtd"><a/>'), 'doctype');
  mustThrow(() => x.parseXml('\uFEFF<!doctype a><a/>'), 'doctype');
  // XXE / billion laughs payloads never get as far as entity handling
  mustThrow(() => x.parseXml('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>'), 'doctype');
  // inside content too
  mustThrow(() => x.parseXml('<a><!DOCTYPE b></a>'), 'doctype');
  // the text "<!DOCTYPE" inside a comment or CDATA is just text
  const ok = '<a><!-- <!DOCTYPE x> --><![CDATA[<!DOCTYPE y>]]></a>';
  assert.strictEqual(x.serialize(x.parseXml(ok)), ok);
});

test('decodes only the five predefined entities and numeric references', () => {
  const src = '<a v="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1D11E;">&lt;&gt;&amp;&quot;&apos;&#67;&#x44;&#x2019;</a>';
  const doc = x.parseXml(src);
  assert.strictEqual(x.attr(doc.root, '', 'v'), '<>&"\'AB\u{1D11E}');
  assert.strictEqual(x.textContent(doc.root), '<>&"\'CD\u2019');
  assert.strictEqual(doc.root.attrs[0].raw, 'v="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1D11E;"', 'raw kept');
  assert.strictEqual(x.serialize(doc), src);
  // attribute-value normalisation: literal whitespace becomes a space, character references do not
  const n = x.parseXml('<a v="1\t2\n3\r\n4&#10;5&#9;6"/>');
  assert.strictEqual(x.attr(n.root, '', 'v'), '1 2 3 4\n5\t6');
  // end-of-line handling in text and CDATA
  assert.strictEqual(x.textContent(x.parseXml('<a>1\r\n2\r3<![CDATA[\r\n<&>]]></a>').root), '1\n2\n3\n<&>');
});

test('unknown entity is malformed', () => {
  mustThrow(() => x.parseXml('<a>&nbsp;</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a v="&copy;"/>'), 'malformed');
  mustThrow(() => x.parseXml('<a>&amp</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a>& b</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a>&#0;</a>'), 'malformed');      // not an XML Char
  mustThrow(() => x.parseXml('<a>&#xD800;</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a>&#x110000;</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a>&#12a;</a>'), 'malformed');
  mustThrow(() => x.parseXml('<a>&#x;</a>'), 'malformed');
});

test('malformed input is refused with an offset', () => {
  const cases = [
    '', '   ', '<a>', '<a></b>', '<a/><b/>', 'text<a/>', '<a/>text', '<a b="1" b="2"/>', '<a b=1/>', '<a b/>',
    '<a b="<"/>', '<a\u0020b="1"c="2"/>', '<p:a/>', '<a p:b="1"/>', '<a xmlns:p=""/>', '<a><![CDATA[x</a>',
    '<a><!-- x -- y --></a>', '<a>]]></a>', '<a></a ', '<1a/>', '<a:/>', '<a:b:c xmlns:a="u"/>', ' <?xml version="1.0"?><a/>',
    '<a/><?xml version="1.0"?>', '<![CDATA[x]]><a/>', '<a><!ENTITY x "y"></a>', '<a xmlns:a="u" xmlns:b="u" a:x="1" b:x="2"/>',
    '<a xmlns:xml="urn:other"/>',
  ];
  for (const c of cases) {
    assert.throws(() => x.parseXml(c), (e) => e instanceof x.XmlError && e.code === 'malformed' && Number.isInteger(e.offset), `should reject ${JSON.stringify(c)}`);
  }
  // fragments: no XML declaration, no DOCTYPE, balanced
  const doc = x.parseXml('<a xmlns="urn:a"/>');
  assert.throws(() => x.parseFragment(doc, '<?xml version="1.0"?><b/>'), x.XmlError);
  assert.throws(() => x.parseFragment(doc, '<b>'), x.XmlError);
  assert.throws(() => x.parseFragment(doc, '</a>'), x.XmlError);
  mustThrow(() => x.parseFragment(doc, '<!DOCTYPE b><b/>'), 'doctype');
});

test('matches by namespace URI with x: prefixes', () => {
  const doc = x.parseXml(partText('prefixed-namespaces/xl/worksheets/sheet1.xml'));
  assert.strictEqual(doc.root.ns, S);
  assert.strictEqual(doc.root.local, 'worksheet');
  assert.strictEqual(doc.root.rawName, 'x:worksheet');
  const sheetData = x.child(doc.root, S, 'sheetData');
  assert.ok(sheetData, 'sheetData found by URI');
  assert.strictEqual(x.child(doc.root, '', 'sheetData'), undefined, 'not by unqualified name');
  assert.strictEqual(x.child(doc.root, W, 'sheetData'), undefined, 'not by another URI');
  const rows = x.childrenOf(sheetData, S, 'row');
  assert.deepStrictEqual(rows.map((r) => x.attr(r, '', 'r')), ['1', '2', '3', '4']);
  const c = x.childrenOf(rows[0], S, 'c')[2];
  assert.strictEqual(x.textContent(x.child(c, S, 'is')), '\r\n          Inline & text\r\n        '.replace(/\r\n/g, '\n'));
  assert.strictEqual(x.textContent(x.child(x.child(c, S, 'is'), S, 't')), 'Inline & text');
  assert.strictEqual(x.attr(rows[0], 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac', 'dyDescent'), '0.25');
  const f = x.child(x.childrenOf(rows[2], S, 'c')[1], S, 'f');
  assert.strictEqual(x.textContent(f), 'IF(A2>0,A2<100,"<none>")');
  assert.strictEqual(x.qname(doc, S, 'c'), 'x:c', 'new elements use the root-bound prefix');
  assert.strictEqual(x.qname(doc, 'urn:unbound', 'c'), undefined);
  assert.strictEqual(x.qname(doc, '', 'c'), 'c');
  // fragments see the root's bindings
  const [cell] = x.parseFragment(doc, '<x:c r="D1"><x:v>7</x:v></x:c>');
  assert.strictEqual(cell.ns, S);
  assert.strictEqual(cell.parent, null);
  const [plain] = x.parseFragment(doc, '<c r="D1"/>');
  assert.strictEqual(plain.ns, '', 'an unprefixed element is NOT in the sheet namespace in a prefixed part');
  // the BOM'd shared strings part, also x:-prefixed
  const sst = x.parseXml(partText('prefixed-namespaces/xl/sharedStrings.xml'));
  const sis = x.childrenOf(sst.root, S, 'si');
  assert.deepStrictEqual(sis.map((si) => x.childrenOf(si, S, 'r').length), [0, 2]);
  assert.strictEqual(x.textContent(sis[1]).startsWith('Bold then plain_x000D_\nline two'), true);
  assert.strictEqual(x.attr(x.childrenOf(sis[1], S, 'r')[0].children.find((n) => n.type === 'el' && n.local === 't'), 'http://www.w3.org/XML/1998/namespace', 'space'), 'preserve');
});

test('matches by namespace URI with a default namespace', () => {
  const text = partText('docx-min/_rels/.rels');
  const doc = x.parseXml(text);
  const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
  assert.strictEqual(doc.root.ns, R);
  const rels = x.childrenOf(doc.root, R, 'Relationship');
  assert.strictEqual(rels.length, 3);
  assert.strictEqual(x.attr(rels[2], '', 'Target'), 'word/document.xml');
  assert.strictEqual(x.attr(rels[2], R, 'Target'), undefined, 'unprefixed attributes are not in the default namespace');
  assert.strictEqual(x.qname(doc, R, 'Relationship'), 'Relationship');
  assert.strictEqual(x.qname(doc, '', 'Relationship'), undefined, 'no-namespace element not expressible under a default namespace');
  // a default namespace and a prefix bound to the same URI are the same name
  const d2 = x.parseXml('<a xmlns="urn:u" xmlns:p="urn:u"><b/><p:b/><c xmlns="urn:v"><b/></c></a>');
  assert.strictEqual(x.childrenOf(d2.root, 'urn:u', 'b').length, 2);
  const c = x.child(d2.root, 'urn:v', 'c');
  assert.ok(c && x.child(c, 'urn:v', 'b'), 'redeclared default namespace applies to descendants');
  // undeclaring the default namespace
  const d3 = x.parseXml('<a xmlns="urn:u"><b xmlns=""><c/></b></a>');
  assert.ok(x.child(x.child(d3.root, '', 'b'), '', 'c'));
  // xmlns attributes are visible in the xmlns namespace
  assert.strictEqual(x.attr(d2.root, 'http://www.w3.org/2000/xmlns/', 'p'), 'urn:u');
  // content types: default namespace, Default/Override
  const ct = x.parseXml(partText('docx-min/[Content_Types].xml'));
  const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
  assert.strictEqual(x.childrenOf(ct.root, CT, 'Override').length, 5);
  assert.strictEqual(x.childrenOf(ct.root, CT, 'Default').length, 3);
  // decoded attribute with &amp;
  const dr = x.parseXml(partText('docx-min/word/_rels/document.xml.rels'));
  assert.strictEqual(x.attr(x.childrenOf(dr.root, R, 'Relationship')[2], '', 'Target'), 'https://example.com/a?b=1&c=2');
});

test('replaceNode: text outside the replaced element is byte-identical', () => {
  for (const rel of ['docx-pretty/word/document.xml', 'docx-min/word/document.xml']) {
    const text = partText(rel);
    const doc = x.parseXml(text);
    const body = x.child(doc.root, W, 'body');
    const paras = x.childrenOf(body, W, 'p');
    const target = paras[1];
    const before = x.serialize(target);
    const start = text.indexOf(before);
    assert.ok(start > 0 && text.indexOf(before, start + 1) < 0, 'target slice is unique');
    const path = x.pathOf(target);
    const replacement = '<w:p w14:paraId="DEADBEEF"><w:r><w:t>Replaced &amp; new</w:t></w:r></w:p>';
    const nodes = x.replaceNode(target, replacement);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].ns, W);
    assert.strictEqual(nodes[0].parent, body);
    assert.strictEqual(target.parent, null);
    assert.strictEqual(x.nodeAt(doc, path), nodes[0], 'same path addresses the new node');
    const after = x.serialize(doc);
    assertLocal(text, after, start, start + before.length);
    assert.strictEqual(after, text.slice(0, start) + replacement + text.slice(start + before.length));
    // undo: replace back with the old source restores the exact text (G5)
    x.replaceNode(nodes[0], before);
    assert.strictEqual(x.serialize(doc), text);
  }
});

test("nested modification keeps untouched descendants' slices", () => {
  const text = partText('docx-pretty/word/document.xml');
  const doc = x.parseXml(text);
  const body = x.child(doc.root, W, 'body');
  const tbl = x.child(body, W, 'tbl');
  const outerTr = x.child(tbl, W, 'tr');
  const cells = x.childrenOf(outerTr, W, 'tc');
  const innerTbl = x.child(cells[1], W, 'tbl');
  const innerP = x.child(x.child(x.child(innerTbl, W, 'tr'), W, 'tc'), W, 'p');
  const untouched = [cells[0], x.child(tbl, W, 'tblPr'), x.child(tbl, W, 'tblGrid'), x.child(innerTbl, W, 'tblPr'), x.childrenOf(body, W, 'p')[0]];
  const slices = untouched.map((n) => x.serialize(n));
  const innerBefore = x.serialize(innerP);
  const start = text.indexOf(innerBefore);
  const repl = '<w:p><w:r><w:t>changed</w:t></w:r></w:p>';
  x.replaceNode(innerP, repl);
  const after = x.serialize(doc);
  assertLocal(text, after, start, start + innerBefore.length);
  untouched.forEach((n, k) => assert.strictEqual(x.serialize(n), slices[k], `untouched descendant ${k} still emits its slice`));
  // the modified ancestors rebuild exactly around the change
  const tblBefore = text.slice(text.indexOf('<w:tbl>'), text.lastIndexOf('</w:tbl>') + 8);
  assert.strictEqual(x.serialize(tbl), tblBefore.replace(innerBefore, repl));
  // a second, independent modification elsewhere
  const firstT = x.child(x.child(x.childrenOf(body, W, 'p')[0], W, 'r'), W, 't');
  x.replaceNode(firstT.children[0], 'Intro');
  const after2 = x.serialize(doc);
  assert.strictEqual(after2, after.replace('Introduction &amp; Scope', 'Intro'));
});

test('insertAt then removeAt restores the exact source', () => {
  for (const rel of listParts()) {
    const text = partText(rel);
    const doc = x.parseXml(text);
    for (const el of elementsOf(doc)) {
      for (const at of [0, el.children.length]) {
        const prefix = el.rawName.includes(':') ? el.rawName.split(':')[0] + ':' : '';
        const ins = x.insertAt(el, at, `<${prefix}inserted a="1"/>`);
        assert.strictEqual(ins.length, 1);
        const mid = x.serialize(doc);
        assert.notStrictEqual(mid, text);
        const removed = x.removeAt(el, at);
        assert.strictEqual(removed, x.serialize(ins[0]));
        assert.strictEqual(x.serialize(doc), text, `${rel}: <${el.rawName}> at ${at}`);
      }
    }
  }
  // a self-closing element that gains a child, then loses it, gets its original form back
  const d = x.parseXml('<a><b  x="1" /></a>');
  const b = d.root.children[0];
  x.insertAt(b, 0, '<c/>');
  assert.strictEqual(x.serialize(d), '<a><b  x="1" ><c/></b></a>');
  x.removeAt(b, 0);
  assert.strictEqual(x.serialize(d), '<a><b  x="1" /></a>');
  // no whitespace is added; multi-node fragments are spliced in order
  const e = x.parseXml('<a>\n  <b/>\n</a>');
  const nodes = x.insertAt(e.root, 2, '<c/>text<!--k--><d/>');
  assert.deepStrictEqual(nodes.map((n) => n.type), ['el', 'text', 'comment', 'el']);
  assert.strictEqual(x.serialize(e), '<a>\n  <b/><c/>text<!--k--><d/>\n</a>');
  assert.throws(() => x.insertAt(e.root, 99, '<z/>'), RangeError);
  assert.throws(() => x.removeAt(e.root, -1), RangeError);
});

test('removeAt then insertAt at the same path restores the exact source, including surrounding whitespace', () => {
  for (const rel of listParts()) {
    const text = partText(rel);
    const doc = x.parseXml(text);
    // every child node of every element, of every kind (elements, whitespace text, comments, ...)
    const targets = [];
    for (const el of elementsOf(doc)) el.children.forEach((_, k) => targets.push(x.pathOf(el).concat(k)));
    for (const p of targets) {
      const node = x.nodeAt(doc, p);
      assert.ok(node, `${rel}: node at ${p}`);
      const parent = node.parent;
      const idx = p[p.length - 1];
      const removed = x.removeAt(parent, idx);
      const ws = parent.children.filter((n) => n.type === 'text').length;
      assert.ok(ws >= 0);
      const back = x.insertAt(parent, idx, removed);
      assert.strictEqual(x.serialize(doc), text, `${rel}: restore at ${p}`);
      assert.deepStrictEqual(x.pathOf(back[0]), p);
    }
  }
  // explicit pretty-printed case: the whitespace text nodes either side are never merged
  const src = '<a>\n  <b/>\n  <c/>\n</a>';
  const d = x.parseXml(src);
  assert.strictEqual(d.root.children.length, 5);
  const removed = x.removeAt(d.root, 1);
  assert.strictEqual(removed, '<b/>');
  assert.strictEqual(d.root.children.length, 4, 'adjacent text nodes are not merged');
  assert.strictEqual(x.serialize(d), '<a>\n  \n  <c/>\n</a>');
  x.insertAt(d.root, 1, removed);
  assert.strictEqual(x.serialize(d), src);
});

test("setAttr preserves attribute order, quote style and other attributes' raw text", () => {
  const src = '<r xmlns:w="urn:w" xmlns:q="urn:q">\n  <w:e  first=\'1\'\n      w:mid="a&amp;b"   last = "x&#10;y" >keep<w:k/></w:e>\n</r>';
  const doc = x.parseXml(src);
  const e = x.child(doc.root, 'urn:w', 'e');
  const tagStart = src.indexOf('<w:e');
  const tagEnd = src.indexOf('>keep') + 1;
  // change a middle attribute: everything else in the tag keeps its raw text
  x.setAttr(e, 'urn:w', 'mid', 'c<d"');
  let out = x.serialize(doc);
  assert.strictEqual(out, src.replace('w:mid="a&amp;b"', 'w:mid="c&lt;d&quot;"'));
  assertLocal(src, out, tagStart, tagEnd, 'only the start tag changes');
  assert.deepStrictEqual(e.attrs.map((a) => a.rawName), ['first', 'w:mid', 'last']);
  assert.strictEqual(x.attr(e, 'urn:w', 'mid'), 'c<d"');
  // single-quoted attribute stays single-quoted
  x.setAttr(e, '', 'first', "it's");
  out = x.serialize(doc);
  assert.ok(out.includes("first='it&apos;s'"), out);
  // add a namespaced attribute: appended with a prefix bound in scope, quote style of the last attribute
  x.setAttr(e, 'urn:q', 'added', 'v\tw');
  out = x.serialize(doc);
  assert.ok(out.includes('last = "x&#10;y" q:added="v&#9;w" >keep'), out);
  assert.strictEqual(x.attr(x.parseXml(out).root.children[1], 'urn:q', 'added'), 'v\tw', 'TAB survives a re-parse');
  // remove an attribute
  x.setAttr(e, '', 'last', null);
  out = x.serialize(doc);
  assert.ok(!out.includes('last'), out);
  assertLocal(src, out, tagStart, tagEnd);
  // namespaced attribute with an unbound namespace is refused; declarations are never edited
  assert.throws(() => x.setAttr(e, 'urn:nope', 'a', '1'));
  assert.throws(() => x.setAttr(e, 'http://www.w3.org/2000/xmlns/', 'w', 'urn:x'));
  // undo every change (G5): original raw text and order come back, byte-identical
  x.setAttr(e, 'urn:q', 'added', null);
  x.setAttr(e, '', 'last', 'x\ny');
  x.setAttr(e, '', 'first', '1');
  x.setAttr(e, 'urn:w', 'mid', 'a&b');
  assert.strictEqual(x.serialize(doc), src);
  // no-op changes change nothing
  x.setAttr(e, '', 'missing', null);
  x.setAttr(e, '', 'first', '1');
  assert.strictEqual(x.serialize(doc), src);
  // a large element: setAttr on it leaves its children's text alone (the 'attr' change kind, §6.3)
  const sheet = partText('prefixed-namespaces/xl/worksheets/sheet1.xml');
  const sd = x.parseXml(sheet);
  const dim = x.child(sd.root, S, 'dimension');
  const mc = x.child(sd.root, S, 'mergeCells');
  x.setAttr(dim, '', 'ref', 'A1:D4');
  x.setAttr(mc, '', 'count', '2');
  assert.strictEqual(x.serialize(sd), sheet.replace('<x:dimension ref="A1:C4" />', '<x:dimension ref="A1:D4" />').replace('<x:mergeCells count="1">', '<x:mergeCells count="2">'));
  // attribute on the root element
  x.setAttr(sd.root, '', 'extra', '1');
  assert.ok(x.serialize(sd).includes('xmlns:x="' + S + '" extra="1">'));
  x.setAttr(sd.root, '', 'extra', null);
  x.setAttr(dim, '', 'ref', 'A1:C4');
  x.setAttr(mc, '', 'count', '1');
  assert.strictEqual(x.serialize(sd), sheet);
});

test('preserves XML declaration, comments, PIs, CDATA, CRLF line endings, a BOM', () => {
  const src = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<!-- head -->\r\n<?mso-application progid="Word.Document"?>\r\n'
    + '<a  b = \'1\'\tc="2"\r\n>\r\n  <!-- inner -->\r\n  <?pi data ?>\r\n  <![CDATA[<raw> & ]]]]><![CDATA[>]]>\r\n  <e></e ><f/>\r\n</a >\r\n<!-- tail -->\r\n';
  const doc = x.parseXml(src);
  assert.strictEqual(x.serialize(doc), src);
  assert.deepStrictEqual(doc.root.children.map((n) => n.type), ['text', 'comment', 'text', 'pi', 'text', 'cdata', 'cdata', 'text', 'el', 'el', 'text']);
  assert.strictEqual(doc.root.children[1].raw, '<!-- inner -->');
  assert.strictEqual(x.textContent(doc.root).includes('<raw> & ]]>'), true);
  // edit inside: prolog and epilog untouched, CRLF kept around the edit
  x.replaceNode(doc.root.children[9], '<g/>');
  assert.strictEqual(x.serialize(doc), src.replace('<f/>', '<g/>'));
  // BOM: decoded, flagged, re-encoded; a BOM character in a string is tolerated too
  const bomBytes = partBytes('prefixed-namespaces/xl/sharedStrings.xml');
  const dec = x.decodePart(bomBytes);
  assert.strictEqual(dec.bom, true);
  assert.strictEqual(dec.encoding, 'utf-8');
  assert.ok(dec.text.startsWith('<?xml'), 'BOM not part of the text');
  assert.deepStrictEqual(Buffer.from(x.encodePart(x.serialize(x.parseXml(dec.text)), true)), Buffer.from(bomBytes));
  assert.strictEqual(x.serialize(x.parseXml('\uFEFF<?xml version="1.0"?><a/>')), '\uFEFF<?xml version="1.0"?><a/>');
  const plain = x.decodePart(partBytes('docx-min/word/document.xml'));
  assert.strictEqual(plain.bom, false);
  assert.strictEqual(x.encodePart('é', false).length, 2);
  // CRLF part from the fixtures keeps every CR
  const crlf = partText('xlsx-legacy/xl/drawings/vmlDrawing1.vml');
  assert.ok(crlf.includes('\r\n'));
  assert.strictEqual(x.serialize(x.parseXml(crlf)), crlf);
  // invalid UTF-8 and a lying declaration are encoding errors
  mustThrow(() => x.decodePart(new Uint8Array([0x3C, 0x61, 0xFF, 0x2F, 0x3E])), 'encoding');
  mustThrow(() => x.decodePart(new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><a/>')), 'encoding');
});

test('UTF-16 part decodes and is flagged', () => {
  const text = '<?xml version="1.0" encoding="UTF-16"?>\r\n<a xmlns="urn:a">héllo 𝄞</a>';
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const r = x.decodePart(new Uint8Array(le));
  assert.strictEqual(r.encoding, 'utf-16');
  assert.strictEqual(r.bom, true);
  assert.strictEqual(r.text, text);
  assert.strictEqual(x.textContent(x.parseXml(r.text).root), 'héllo 𝄞');
  const be = Buffer.from(text, 'utf16le').swap16();
  const r2 = x.decodePart(new Uint8Array(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])));
  assert.strictEqual(r2.encoding, 'utf-16');
  assert.strictEqual(r2.text, text);
  // no BOM, sniffed from "<?"
  const r3 = x.decodePart(new Uint8Array(Buffer.from(text, 'utf16le')));
  assert.strictEqual(r3.encoding, 'utf-16');
  assert.strictEqual(r3.bom, false);
  assert.strictEqual(r3.text, text);
  // UTF-16 bytes declaring UTF-8 are refused
  mustThrow(() => x.decodePart(new Uint8Array(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><a/>', 'utf16le'))), 'encoding');
});

function bigSheet(targetBytes) {
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>`;
  const parts = [head];
  let size = head.length;
  for (let r = 1; size < targetBytes; r++) {
    const row = `<row r="${r}" spans="1:4"><c r="A${r}" t="s"><v>${r % 997}</v></c><c r="B${r}" s="3"><v>${(r * 1.5).toFixed(2)}</v></c>`
      + `<c r="C${r}"><f>A${r}*2&amp;"x"</f><v>${r * 2}</v></c><c r="D${r}" t="inlineStr"><is><t xml:space="preserve"> row ${r} &lt;ok&gt; </t></is></c></row>`;
    parts.push(row);
    size += row.length;
  }
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

test('parseXmlAsync yields at least once on a 5 MB input and equals parseXml', async (t) => {
  const text = bigSheet(5 * 1024 * 1024);
  assert.ok(text.length >= 5 * 1024 * 1024);
  let t0 = performance.now();
  const syncDoc = x.parseXml(text);
  const syncMs = performance.now() - t0;
  let ticks = 0;
  let running = true;
  const tick = () => { if (running) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  t0 = performance.now();
  const asyncDoc = await x.parseXmlAsync(text, 5);
  const asyncMs = performance.now() - t0;
  running = false;
  assert.ok(ticks >= 1, `event loop ran during the async parse (ticks=${ticks})`);
  // default budget (LIMITS.parseYieldMs) also completes and agrees
  const defDoc = await x.parseXmlAsync(text);
  t0 = performance.now();
  const ser = x.serialize(asyncDoc);
  const serMs = performance.now() - t0;
  assert.strictEqual(ser, text);
  assert.strictEqual(x.serialize(defDoc), text);
  const shape = (d) => { const sd = x.child(d.root, S, 'sheetData'); return [sd.children.length, x.serialize(sd.children[sd.children.length - 1])]; };
  assert.deepStrictEqual(shape(asyncDoc), shape(syncDoc));
  assert.deepStrictEqual(elementsOf(asyncDoc).length, elementsOf(syncDoc).length);
  // edit one row in the middle and serialise (G4 on a large part)
  const sd = x.child(syncDoc.root, S, 'sheetData');
  const mid = sd.children[Math.floor(sd.children.length / 2)];
  const before = x.serialize(mid);
  const start = text.indexOf(before);
  t0 = performance.now();
  x.setAttr(mid, '', 'spans', '1:5');
  const edited = x.serialize(syncDoc);
  const editMs = performance.now() - t0;
  assertLocal(text, edited, start, start + before.indexOf('>') + 1);
  t.diagnostic(`5 MB (${(text.length / 1048576).toFixed(2)} MiB, ${elementsOf(syncDoc).length} elements): parseXml ${syncMs.toFixed(0)} ms; parseXmlAsync(5 ms slices) ${asyncMs.toFixed(0)} ms with ${ticks} event-loop turns; serialize ${serMs.toFixed(1)} ms; setAttr+serialize ${editMs.toFixed(0)} ms`);
});

function saxesEvents(text) {
  const events = [];
  const p = new SaxesParser({ xmlns: true });
  let depth = 0;
  let chars = '';
  p.on('error', (e) => { throw e; });
  p.on('opentag', (node) => {
    depth++;
    events.push(['open', node.uri, node.local, Object.values(node.attributes).map((a) => [a.uri, a.local, a.value])]);
  });
  p.on('closetag', () => { depth--; events.push(['close']); });
  p.on('text', (s) => { if (depth > 0) chars += s; });
  p.on('cdata', (s) => { chars += s; });
  p.write(text).close();
  return { events, chars };
}

function ourEvents(doc) {
  const events = [];
  let chars = '';
  const walk = (el) => {
    events.push(['open', el.ns, el.local, el.attrs.map((a) => [a.ns, a.local, a.value])]);
    for (const c of el.children) {
      if (c.type === 'el') walk(c);
      else if (c.type === 'text' || c.type === 'cdata') {
        // textContent of a synthetic wrapper decodes the node exactly as a reader would
        chars += x.textContent({ type: 'el', children: [c] });
      }
    }
    events.push(['close']);
  };
  walk(doc.root);
  return { events, chars };
}

test('agrees with saxes on element/attribute sequence for every fixture part', (t) => {
  const { parts } = allXmlParts();
  for (const p of parts) {
    const { text } = x.decodePart(p.bytes);
    const theirs = saxesEvents(text);
    const ours = ourEvents(x.parseXml(text));
    assert.deepStrictEqual(ours.events, theirs.events, `element/attribute sequence differs for ${p.name}`);
    assert.strictEqual(ours.chars, theirs.chars, `character data differs for ${p.name}`);
  }
  // the 5 MB generated part as well
  const big = bigSheet(512 * 1024);
  assert.deepStrictEqual(ourEvents(x.parseXml(big)).events, saxesEvents(big).events);
  t.diagnostic(`${parts.length} parts cross-checked`);
});

test('escape/strip helpers', () => {
  assert.strictEqual(x.escapeText('a<b>&c]]>d"\''), 'a&lt;b&gt;&amp;c]]&gt;d"\'');
  assert.ok(!x.escapeText(']]>').includes(']]>'), ']]> cannot survive escaping');
  assert.strictEqual(x.escapeText('a\r\nb'), 'a&#13;\nb');
  assert.strictEqual(x.escapeAttr('a<b>&"c\'\t\n\r'), 'a&lt;b&gt;&amp;&quot;c\'&#9;&#10;&#13;');
  assert.strictEqual(x.stripIllegalXmlChars('a\u0000b\u0001\u0008c\td\ne\rf\u000B\u000C\u001Fg\uFFFE\uFFFFh'), 'abc\td\ne\rfgh');
  assert.strictEqual(x.stripIllegalXmlChars('ok 𝄞 \uD800x \uDC00y'), 'ok 𝄞 x y', 'lone surrogates removed, pairs kept');
  assert.strictEqual(x.stripIllegalXmlChars('\u0085\u00A0\uE000'), '\u0085\u00A0\uE000');
  // round trip through parse: escaped text and attribute values decode back to the input
  const nasty = 'x < y && "q" \'s\' ]]> \t\r\n end';
  const doc = x.parseXml(`<a v="${x.escapeAttr(nasty)}">${x.escapeText(nasty)}</a>`);
  assert.strictEqual(x.attr(doc.root, '', 'v'), nasty);
  assert.strictEqual(x.textContent(doc.root), nasty);
});

test('pathOf / nodeAt count every child node kind', () => {
  const doc = x.parseXml('<a>t<!--c--><?p?><b><c/></b><![CDATA[d]]></a>');
  const b = x.child(doc.root, '', 'b');
  assert.deepStrictEqual(x.pathOf(b), [3]);
  assert.deepStrictEqual(x.pathOf(b.children[0]), [3, 0]);
  assert.deepStrictEqual(x.pathOf(doc.root), []);
  assert.strictEqual(x.nodeAt(doc, []), doc.root);
  assert.strictEqual(x.nodeAt(doc, [1]).type, 'comment');
  assert.strictEqual(x.nodeAt(doc, [4]).type, 'cdata');
  assert.strictEqual(x.nodeAt(doc, [9]), undefined);
  assert.strictEqual(x.nodeAt(doc, [0, 0]), undefined, 'cannot descend into text');
  assert.throws(() => x.replaceNode(doc.root, '<z/>'), 'the root cannot be replaced');
  // replaceNode with '' removes; text node targets work too
  x.replaceNode(doc.root.children[0], '');
  assert.strictEqual(x.serialize(doc), '<a><!--c--><?p?><b><c/></b><![CDATA[d]]></a>');
});
