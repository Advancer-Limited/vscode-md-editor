// WP-31: docx format validators (src/office/core/docx/validate.ts, spec §13.3 "Docx") and protection
// detection (docx/protection.ts, §8.7).
//
// Each rule has a synthetic failing case: a clean fixture whose part is patched in memory (so it is a
// touched part), validated against the clean package as the loaded original.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { encodePart } = core.xml;
const { serializeAndVerify, packageValidator } = core.save;
const { docxValidator } = core.docx.validate;
const { detectProtection } = core.docx.protection;
const DOC = 'word/document.xml';
const NUM = 'word/numbering.xml';
const SETTINGS = 'word/settings.xml';

const open = (name) => OfficePackage.open(name, fixture(name));
const ctxFor = (name) => ({ original: () => open(name) });

/** Messages for `name` with `edits` ({ part: text => text }) applied in memory. */
function broken(name, edits, { withCtx = true } = {}) {
  const pkg = open(name);
  for (const [part, fn] of Object.entries(edits)) {
    const before = pkg.text(part);
    const after = fn(before);
    assert.notStrictEqual(after, before, `${part}: the patch must change something`);
    pkg.setPart(part, encodePart(after, false));
  }
  return docxValidator(pkg, pkg.touchedParts(), withCtx ? ctxFor(name) : undefined);
}
const sub = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from.slice(0, 80)}`); return t.replace(from, to); };
const subRe = (re, to) => (t) => { assert.ok(re.test(t), `part should match ${re}`); return t.replace(re, to); };

function assertFails(messages, re, what) {
  assert.ok(messages.length > 0, `${what}: expected a failure`);
  assert.ok(messages.some((m) => re.test(m)), `${what}: expected ${re} in ${JSON.stringify(messages)}`);
}

// ---------------------------------------------------------------------------------------------------
// Fixtures

const OPENABLE = allFixtures('docx').filter((f) => { try { open(f); return true; } catch { return false; } });

test('every openable docx fixture passes, with and without the loaded-package context', () => {
  assert.ok(OPENABLE.length >= 12, `expected the docx fixtures, found ${OPENABLE.length}`);
  for (const f of OPENABLE) {
    const pkg = open(f);
    assert.deepStrictEqual(docxValidator(pkg, pkg.partNames()), [], `${f}: raw`);
    assert.deepStrictEqual(docxValidator(pkg, [], ctxFor(f)), [], `${f}: untouched, with context`);
    assert.deepStrictEqual(docxValidator(pkg, pkg.partNames(), ctxFor(f)), [], `${f}: all parts, with context`);
  }
});

test('the async validator gives the same messages as the sync one', async () => {
  for (const [name, edits] of [
    ['basic.docx', { [DOC]: sub('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Nope"/>') }],
    ['tables.docx', { [DOC]: sub('<w:gridCol w:w="4513"/>', '<w:gridCol w:w="4000"/>') }],
    ['anchors.docx', { [DOC]: sub('<w:bookmarkEnd w:id="0"/>', '') }],
  ]) {
    const pkg = open(name);
    for (const [part, fn] of Object.entries(edits)) pkg.setPart(part, encodePart(fn(pkg.text(part)), false));
    const sync = docxValidator(pkg, pkg.touchedParts(), ctxFor(name));
    assert.ok(sync.length > 0);
    assert.deepStrictEqual(await docxValidator.async(pkg, pkg.touchedParts(), ctxFor(name)), sync);
  }
  const big = open('large.docx');
  assert.deepStrictEqual(await docxValidator.async(big, big.partNames(), ctxFor('large.docx')), []);
});

// ---------------------------------------------------------------------------------------------------
// One failing input per rule

test('pPr children out of schema order', () => {
  assertFails(
    broken('basic.docx', { [DOC]: sub('<w:pStyle w:val="ListParagraph"/><w:numPr>', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:pStyle w:val="ListParagraph"/><w:numPr>') }),
    /word\/document\.xml: w:pPr children out of schema order/, 'pPr order');
  assertFails(
    broken('basic.docx', { [DOC]: sub('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Heading1"/><w:pStyle w:val="Heading1"/>') }),
    /w:pStyle is repeated/, 'pPr repeated child');
});

test('rPr children out of schema order', () => {
  assertFails(
    broken('anchors.docx', { [DOC]: sub('<w:rStyle w:val="CommentReference"/><w:sz w:val="24"/>', '<w:sz w:val="24"/><w:rStyle w:val="CommentReference"/>') }),
    /w:rPr children out of schema order \(w:rStyle comes after w:sz\)/, 'rPr order');
  // An unknown extension element does not disturb the order check.
  assert.deepStrictEqual(
    broken('anchors.docx', { [DOC]: sub('<w:rStyle w:val="CommentReference"/><w:sz w:val="24"/>', '<w:rStyle w:val="CommentReference"/><x:ext xmlns:x="urn:x"/><w:sz w:val="24"/>') }), []);
});

test('w:numId that resolves to no w:num', () => {
  assertFails(broken('basic.docx', { [DOC]: sub('<w:numId w:val="1"/>', '<w:numId w:val="99"/>') }), /w:numId 99 does not resolve to a w:num/, 'numId');
  // numId 0 ("no list") is legal.
  assert.deepStrictEqual(broken('basic.docx', { [DOC]: sub('<w:numId w:val="1"/>', '<w:numId w:val="0"/>') }), []);
  // No numbering part at all: any numId > 0 dangles.
  assertFails(
    broken('no-numbering.docx', { [DOC]: sub('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="3"/></w:numPr>') }),
    /w:numId 3 does not resolve/, 'numId without numbering part');
});

test('w:num that resolves to no w:abstractNum', () => {
  assertFails(
    broken('basic.docx', { [NUM]: sub('<w:abstractNumId w:val="1"/>', '<w:abstractNumId w:val="42"/>') }),
    /word\/numbering\.xml: w:num 2 refers to missing w:abstractNum 42/, 'num -> abstractNum');
});

test('w:abstractNum after a w:num', () => {
  assertFails(
    broken('basic.docx', {
      [NUM]: (t) => {
        const m = /<w:abstractNum [^>]*w:abstractNumId="1"[\s\S]*?<\/w:abstractNum>/.exec(t);
        assert.ok(m);
        const lastNum = t.lastIndexOf('</w:num>') + '</w:num>'.length;
        return t.slice(0, m.index) + t.slice(m.index + m[0].length, lastNum) + m[0] + t.slice(lastNum);
      },
    }),
    /w:abstractNum appears after a w:num/, 'abstractNum order');
});

test('w:pStyle and w:rStyle ids that do not exist in styles.xml', () => {
  assertFails(broken('basic.docx', { [DOC]: sub('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Nope"/>') }), /w:pStyle "Nope" does not exist in styles\.xml/, 'pStyle');
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:rStyle w:val="CommentReference"/>', '<w:rStyle w:val="Nope"/>') }), /w:rStyle "Nope" does not exist/, 'rStyle');
  // Removing a style that is still referenced is caught from the styles side.
  assertFails(
    broken('basic.docx', { 'word/styles.xml': subRe(/<w:style [^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/, '') }),
    /w:pStyle "Heading1" does not exist/, 'style removed');
});

test('bookmark ranges: missing end, missing start, duplicate id', () => {
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:bookmarkEnd w:id="0"/>', '') }), /w:bookmarkStart id 0 has no w:bookmarkEnd/, 'no bookmarkEnd');
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:bookmarkStart w:id="0" w:name="fox_bm"/>', '') }), /w:bookmarkEnd id 0 has no w:bookmarkStart/, 'no bookmarkStart');
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:bookmarkStart w:id="2" w:name="second_bm"/>', '<w:bookmarkStart w:id="0" w:name="second_bm"/>') }), /w:bookmarkStart id 0 is not unique/, 'duplicate bookmark id');
});

test('comment ranges: missing end, missing start, duplicate id', () => {
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:commentRangeEnd w:id="1"/>', '') }), /w:commentRangeStart id 1 has no w:commentRangeEnd/, 'no commentRangeEnd');
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:commentRangeStart w:id="1"/>', '') }), /w:commentRangeEnd id 1 has no w:commentRangeStart/, 'no commentRangeStart');
  assertFails(broken('anchors.docx', { [DOC]: sub('<w:commentRangeStart w:id="3"/>', '<w:commentRangeStart w:id="1"/>') }), /w:commentRangeStart id 1 is not unique/, 'duplicate commentRange id');
});

test('a marker bookmark is reported, even without a clean original', () => {
  const marker = '<w:bookmarkStart w:id="90" w:name="__vsmd_7"/><w:bookmarkEnd w:id="90"/>';
  assertFails(broken('basic.docx', { [DOC]: sub('<w:body>', `<w:body><w:p>${marker}</w:p>`) }), /marker bookmark "__vsmd_7" is present/, 'marker');
  // Already present when the file was loaded: still refused (never forgiven).
  const bytes = (() => {
    const p = open('basic.docx');
    p.setPart(DOC, encodePart(p.text(DOC).replace('<w:body>', `<w:body><w:p>${marker}</w:p>`), false));
    return p.serialize();
  })();
  const pkg = OfficePackage.open('marked.docx', bytes);
  assertFails(docxValidator(pkg, [], { original: () => OfficePackage.open('marked.docx', bytes) }), /marker bookmark/, 'marker in original');
});

test('duplicate w14:paraId', () => {
  assertFails(broken('basic.docx', { [DOC]: sub('w14:paraId="74832417"', 'w14:paraId="2629DFBD"') }), /w14:paraId 2629DFBD is not unique/, 'paraId');
});

test('a w:tc that does not end with a w:p', () => {
  assertFails(broken('tables.docx', { [DOC]: sub('</w:p></w:tc>', '</w:p><w:sdt/></w:tc>') }), /w:tc ends with w:sdt instead of w:p/, 'tc last child');
  assertFails(broken('tables.docx', { [DOC]: subRe(/<w:tc>(<w:tcPr>.*?<\/w:tcPr>)<w:p [\s\S]*?<\/w:p><\/w:tc>/, '<w:tc>$1</w:tc>') }), /w:tc ends with w:tcPr instead of w:p/, 'tc without paragraph');
});

test('table census: counts and property text must equal the loaded package', () => {
  assertFails(broken('tables.docx', { [DOC]: sub('<w:gridCol w:w="4513"/>', '<w:gridCol w:w="4000"/>') }), /table structure or properties changed since load \(the text of table property element \d+ \(w:tblGrid\) changed\)/, 'tblGrid');
  assertFails(broken('tables.docx', { [DOC]: sub('<w:tblLayout w:type="fixed"/>', '') }), /\(w:tblPr\) changed/, 'tblPr');
  assertFails(broken('tables.docx', { [DOC]: sub('<w:tcW w:w="4513" w:type="dxa"/>', '<w:tcW w:w="4500" w:type="dxa"/>') }), /\(w:tcPr\) changed/, 'tcPr');
  assertFails(broken('tables.docx', { [DOC]: sub('<w:tblPrEx>', '<w:trPr><w:cantSplit/></w:trPr><w:tblPrEx>') }), /table structure or properties changed/, 'trPr added');
  assertFails(broken('tables.docx', { [DOC]: subRe(/<w:tr [\s\S]*?<\/w:tr>/, '') }), /counts changed \(tbl=\d+;tr=\d+;tc=\d+ -> /, 'row removed');
  // Editing a paragraph's text in a cell is not a structure change.
  assert.deepStrictEqual(broken('tables.docx', { [DOC]: sub('<w:t>bold</w:t>', '<w:t>bolder</w:t>') }), []);
  // Without the loaded package there is nothing to compare with.
  assert.deepStrictEqual(broken('tables.docx', { [DOC]: sub('<w:gridCol w:w="4513"/>', '<w:gridCol w:w="4000"/>') }, { withCtx: false }), []);
});

// ---------------------------------------------------------------------------------------------------
// Scope and the loaded-package comparison

test('problems the loaded package already had are forgiven; new ones of the same rule are not', () => {
  // A file whose own heading refers to a missing style.
  const preBroken = (() => {
    const p = open('basic.docx');
    p.setPart(DOC, encodePart(p.text(DOC).replace('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Gone"/>'), false));
    return p.serialize();
  })();
  const load = () => OfficePackage.open('pre.docx', preBroken);
  assert.ok(docxValidator(load(), []).length > 0, 'raw: reported');
  assert.deepStrictEqual(docxValidator(load(), [], { original: load }), [], 'forgiven against itself');
  const edited = load();
  edited.setPart(DOC, encodePart(edited.text(DOC).replace('<w:pStyle w:val="Heading2"/>', '<w:pStyle w:val="Gone2"/>'), false));
  const msgs = docxValidator(edited, edited.touchedParts(), { original: load });
  assert.strictEqual(msgs.length, 1, JSON.stringify(msgs));
  assert.match(msgs[0], /Gone2|"Gone2"/);
});

test('other touched WordprocessingML parts are scanned; untouched ones are not', () => {
  const bad = (t) => t.replace(/<w:pPr>/, '<w:pPr><w:jc w:val="left"/><w:pStyle w:val="Heading1"/>');
  const pkg = open('basic.docx');
  pkg.setPart(NUM, encodePart(bad(pkg.text(NUM)), false));
  assertFails(docxValidator(pkg, [NUM], ctxFor('basic.docx')), /word\/numbering\.xml: w:pPr children out of schema order/, 'numbering part');
  assert.deepStrictEqual(docxValidator(pkg, [], ctxFor('basic.docx')), [], 'not in scope when untouched');
});

test('a non-docx package or a package without a context does not throw', () => {
  const x = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  assert.deepStrictEqual(docxValidator(x, []), []);
  assert.deepStrictEqual(docxValidator(open('basic.docx'), ['word/document.xml'], { original: () => undefined }), []);
});

test('place in the save pipeline: an ordinary save verifies, a table change is refused', () => {
  const good = open('tables.docx');
  good.setPart(DOC, encodePart(good.text(DOC).replace('<w:t>bold</w:t>', '<w:t>bolder</w:t>'), false));
  const ok = serializeAndVerify(good, [packageValidator, docxValidator]);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.failures));

  const bad = open('tables.docx');
  bad.setPart(DOC, encodePart(bad.text(DOC).replace('<w:gridCol w:w="4513"/>', '<w:gridCol w:w="4000"/>'), false));
  const refused = serializeAndVerify(bad, [packageValidator, docxValidator]);
  assert.strictEqual(refused.ok, false);
  assert.ok(refused.failures.some((f) => /table structure/.test(f.message)), JSON.stringify(refused.failures));
});

// ---------------------------------------------------------------------------------------------------
// Protection (§8.7)

test('protection: fixtures', () => {
  assert.deepStrictEqual(detectProtection(open('protected.docx')), { readOnlyReason: 'protected' });
  assert.deepStrictEqual(detectProtection(open('tracked.docx')), { readOnlyReason: 'tracked-changes-on' });
  for (const f of OPENABLE.filter((n) => n !== 'protected.docx' && n !== 'tracked.docx')) {
    assert.deepStrictEqual(detectProtection(open(f)), { readOnlyReason: null }, f);
  }
});

test('protection: synthetic settings', () => {
  const withSettings = (inner) => {
    const pkg = open('basic.docx');
    const t = pkg.text(SETTINGS);
    pkg.setPart(SETTINGS, encodePart(t.replace(/(<w:settings\b[^>]*>)/, `$1${inner}`), false));
    return detectProtection(pkg).readOnlyReason;
  };
  assert.strictEqual(withSettings('<w:documentProtection w:edit="readOnly" w:enforcement="1"/>'), 'protected');
  assert.strictEqual(withSettings('<w:documentProtection w:edit="forms" w:enforcement="true"/>'), 'protected');
  assert.strictEqual(withSettings('<w:documentProtection w:edit="readOnly" w:enforcement="0"/>'), null, 'enforcement off');
  assert.strictEqual(withSettings('<w:documentProtection w:edit="readOnly"/>'), null, 'enforcement absent');
  assert.strictEqual(withSettings('<w:writeProtection w:recommended="1"/>'), 'protected');
  assert.strictEqual(withSettings('<w:trackRevisions/>'), 'tracked-changes-on');
  assert.strictEqual(withSettings('<w:trackRevisions w:val="1"/>'), 'tracked-changes-on');
  assert.strictEqual(withSettings('<w:trackRevisions w:val="0"/>'), null, 'track revisions off');
  assert.strictEqual(withSettings('<w:trackRevisions w:val="false"/>'), null);
  assert.strictEqual(withSettings('<w:trackRevisions/><w:documentProtection w:enforcement="1"/>'), 'protected', 'protection wins');
});

test('protection: a missing or unreadable settings part means no restriction', () => {
  const pkg = open('basic.docx');
  pkg.setPart(SETTINGS, null);
  assert.deepStrictEqual(detectProtection(pkg), { readOnlyReason: null });
  const junk = open('basic.docx');
  junk.setPart(SETTINGS, new TextEncoder().encode('<not xml'));
  assert.deepStrictEqual(detectProtection(junk), { readOnlyReason: null });
});
