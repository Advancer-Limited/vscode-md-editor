// WP-22: xlsx format validators (src/office/core/xlsx/validate.ts), spec §13.3 (xlsx + styles rules)
// and their place in the save pipeline (§6.5 step 4).
//
// Each rule has a synthetic failing case: a clean fixture whose part is replaced in memory (so it is a
// touched part), validated against the clean package as the loaded original.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, fixture, allFixtures } from './_helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', '.out');
const { OfficePackage } = core.pkg;
const { encodePart } = core.xml;
const { serializeAndVerify, packageValidator } = core.save;
const { xlsxValidator, sheetNameProblem } = core.xlsx.validate;
const SHEET1 = 'xl/worksheets/sheet1.xml';
const STYLES = 'xl/styles.xml';
const WB = 'xl/workbook.xml';

const open = (name, bytes = fixture(name)) => OfficePackage.open(name, bytes);
const ctxFor = (name, bytes = fixture(name)) => ({ original: () => open(name, bytes) });

/** Messages for `name` with `edits` ({ part: text => text }) applied in memory, against the clean original. */
function broken(name, edits, { withCtx = true } = {}) {
  const pkg = open(name);
  for (const [part, fn] of Object.entries(edits)) {
    const before = pkg.text(part);
    const after = fn(before);
    assert.notStrictEqual(after, before, `${part}: the patch must change something`);
    pkg.setPart(part, encodePart(after, false));
  }
  return xlsxValidator(pkg, pkg.touchedParts(), withCtx ? ctxFor(name) : undefined);
}
const sub = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from.slice(0, 80)}`); return t.replace(from, to); };

function assertFails(messages, re, what) {
  assert.ok(messages.length > 0, `${what}: expected a failure`);
  assert.ok(messages.some((m) => re.test(m)), `${what}: ${JSON.stringify(messages)}`);
}

// ---------------------------------------------------------------------------------------------
// Clean inputs pass

function openable() {
  const out = [];
  for (const f of allFixtures('xlsx')) {
    try { out.push([f, open(f)]); } catch { /* encrypted, zip64 …: not openable, not validated */ }
  }
  return out;
}

test('every openable xlsx fixture passes unedited (all parts in scope, loaded original as context)', () => {
  const list = openable();
  assert.ok(list.length >= 15, `fixtures: ${list.length}`);
  for (const [f, pkg] of list) assert.deepStrictEqual(xlsxValidator(pkg, pkg.partNames(), ctxFor(f)), [], f);
});

test('without a context, only the damaged fixture and calc-chain-with-formulas workbooks are reported', () => {
  const flagged = {};
  for (const [f, pkg] of openable()) {
    const m = xlsxValidator(pkg, pkg.partNames());
    if (m.length) flagged[f] = m;
  }
  assert.deepStrictEqual(Object.keys(flagged).sort(), ['damaged-sheet.xlsx', 'formulas.xlsx', 'tables.xlsx']);
  assert.match(flagged['damaged-sheet.xlsx'].join('\n'), /sheet3\.xml/);
  assert.match(flagged['formulas.xlsx'].join('\n'), /calc chain/);
});

test('every tests/.out workbook written by the xlsx edit tests passes', async () => {
  // Other test files run concurrently and may be mid-write: a file that does not open is retried briefly.
  const dirs = ['xlsxCellEdit', 'xlsxFormula', 'xlsxDateStyle'].map((d) => path.join(OUT_DIR, d)).filter((d) => fs.existsSync(d));
  let n = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xlsx'))) {
      let pkg;
      for (let attempt = 0; ; attempt++) {
        try { pkg = open(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); break; } catch (e) {
          if (attempt >= 10) throw new Error(`${dir}/${f}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.deepStrictEqual(xlsxValidator(pkg, pkg.partNames()), [], `${path.basename(dir)}/${f}`);
      n++;
    }
  }
  // On a fresh checkout the directory may not exist yet (test files run in parallel); the date-style and
  // random-sequence tests validate every output they write in any case.
  if (n === 0) console.log('# no tests/.out xlsx outputs present yet');
});

test('the xlsx provider runs packageValidator and xlsxValidator', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'office', 'xlsxEditorProvider.ts'), 'utf8');
  assert.match(src, /protected validators\(\): Validator\[\] \{\s*return \[packageValidator, xlsxValidator\];/);
});

// ---------------------------------------------------------------------------------------------
// One failing synthetic input per rule (sheet rules)

test('rows out of order', () => {
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<row r="3">', '<row r="2">') }), /rows must be strictly ascending/, 'duplicate row');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<row r="3">', '<row r="X">') }), /row r="X" is not a row number/, 'non-numeric row');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: (t) => t.replace('<row r="3">', '<row r="5">').replace(/<c r="([A-C])3"/g, '<c r="$15"') }),
    /row 4 comes after row 5/, 'descending rows');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<row r="4">', '<row r="1048577">') }), /not a row number inside the sheet/, 'row past the grid');
});

test('cells out of order within a row', () => {
  const m = broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="A2" t="inlineStr"><is><t>Apples</t></is></c><c r="B2" s="2"><v>3</v></c>', '<c r="B2" s="2"><v>3</v></c><c r="A2" t="inlineStr"><is><t>Apples</t></is></c>') });
  assertFails(m, /cell A2 is out of order/, 'cell order');
});

test('a cell in the wrong row and a cell outside the sheet', () => {
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="B3"><v>4.5</v></c>', '<c r="B9"><v>4.5</v></c>') }), /cell B9 is in row 3/, 'wrong row');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: (t) => t.replace('<c r="C3" t="inlineStr"><is><t>escaped</t></is></c>', '<c r="XFE3"><v>1</v></c>').replace('A1:C4', 'A1:XFD4') }),
    /XFE3 is not a cell reference inside the sheet/, 'outside');
});

test('dimension does not cover all cells', () => {
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<dimension ref="A1:C4"/>', '<dimension ref="A1:C3"/>') }), /dimension "A1:C3" does not cover/, 'dimension');
  assert.deepStrictEqual(broken('no-date-style.xlsx', { [SHEET1]: sub('<dimension ref="A1:C4"/>', '<dimension ref="A1:Z99"/>') }), [], 'a larger dimension is fine');
});

test('c/@s at or beyond the cellXfs record count', () => {
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="B3">', '<c r="B3" s="3">') }), /style s="3" but there are 3 cell formats/, 's >= count');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="B3">', '<c r="B3" s="x">') }), /style s="x"/, 'non-numeric s');
  assertFails(broken('no-styles.xlsx', { [SHEET1]: sub('<c r="B3">', '<c r="B3" s="1">') }), /there are 0 cell formats/, 'no styles part');
});

test('t="s" index at or beyond the shared-string count', () => {
  const pkg = open('basic.xlsx');
  const n = (pkg.text('xl/sharedStrings.xml').match(/<si>/g) || []).length;
  assertFails(broken('basic.xlsx', { [SHEET1]: (t) => t.replace(/(<c r="A2"[^>]*t="s"[^>]*><v>)\d+(<\/v>)/, `$1${n}$2`) }), new RegExp(`shared string ${n} but there are ${n}`), 'sst index');
  assertFails(broken('no-shared-strings.xlsx', { [SHEET1]: sub('<c r="B2"><v>3</v></c>', '<c r="B2" t="s"><v>0</v></c>') }),
    /B2 refers to shared string 0 but there are 0/, 'no sst part');
});

test('overlapping merges', () => {
  const add = (refs) => (t) => t.replace('</sheetData>', `</sheetData><mergeCells count="${refs.length}">${refs.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`);
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: add(['A1:B2', 'B2:C3']) }), /A1:B2 and B2:C3 overlap/, 'overlap');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: add(['A1:C1', 'D1:D2', 'A3:A4', 'B1:B1']) }), /A1:C1 and B1:B1 overlap|B1:B1 and A1:C1/, 'contained');
  assert.deepStrictEqual(broken('no-date-style.xlsx', { [SHEET1]: add(['A1:B2', 'C1:C2', 'A3:C4']) }), [], 'disjoint merges are fine');
});

test('an unparseable or empty <f>', () => {
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="B3"><v>4.5</v></c>', '<c r="B3"><f>SUM(1,</f><v>4.5</v></c>') }), /B3 has a formula that does not parse/, 'unparseable');
  assertFails(broken('no-date-style.xlsx', { [SHEET1]: sub('<c r="B3"><v>4.5</v></c>', '<c r="B3"><f></f><v>4.5</v></c>') }), /B3 has an empty formula/, 'empty');
});

test('shared-formula groups with two masters or none', () => {
  // formulas.xlsx: B2 is the master of si 0 (B2:B10), B3..B10 its dependants.
  assertFails(broken('formulas.xlsx', { [SHEET1]: sub('<c r="B3"><f t="shared" si="0"/>', '<c r="B3"><f t="shared" ref="B3:B10" si="0">A3*2</f>') }),
    /si="0" has 2 masters/, 'two masters');
  assertFails(broken('formulas.xlsx', { [SHEET1]: sub('<f t="shared" ref="B2:B10" si="0">A2*2</f>', '<f>A2*2</f>') }), /si="0" has no master/, 'no master');
});

// ---------------------------------------------------------------------------------------------
// Workbook rules

test('sheet names valid and unique', () => {
  for (const bad of ['', 'a'.repeat(32), 'a:b', 'a/b', 'a\\b', 'a?b', 'a*b', 'a[b', 'a]b', "'quoted", "quoted'"]) assert.ok(sheetNameProblem(bad), JSON.stringify(bad));
  for (const ok of ['Sheet1', 'My Sheet', "O'Brien", 'a'.repeat(31), 'Daten über 2024']) assert.strictEqual(sheetNameProblem(ok), undefined, ok);
  assertFails(broken('basic.xlsx', { [WB]: sub('name="Second Sheet"', 'name="values"') }), /"values" is used twice/, 'duplicate (case-insensitive)');
  assertFails(broken('basic.xlsx', { [WB]: sub('name="Second Sheet"', 'name="Bad/Name"') }), /"Bad\/Name" contains/, 'invalid');
});

test('every sheet/@r:id resolves', () => {
  assertFails(broken('basic.xlsx', { [WB]: sub('r:id="rId2"', 'r:id="rId99"') }), /relationship "rId99" does not resolve/, 'unknown rId');
  const pkg = open('basic.xlsx');
  pkg.setPart('xl/worksheets/sheet2.xml', null);
  pkg.setPart('xl/_rels/workbook.xml.rels', encodePart(pkg.text('xl/_rels/workbook.xml.rels'), false));
  assertFails(xlsxValidator(pkg, pkg.touchedParts(), ctxFor('basic.xlsx')), /relationship "rId2" does not resolve/, 'missing part');
});

test('definedName/@localSheetId below the sheet count', () => {
  assertFails(broken('formulas.xlsx', { [WB]: sub('<definedName name="LocalName">', '<definedName name="LocalName" localSheetId="4">') }),
    /"LocalName" has localSheetId 4 but there are 4 sheets/, 'localSheetId');
  assert.deepStrictEqual(broken('formulas.xlsx', { [WB]: sub('<definedName name="LocalName">', '<definedName name="LocalName" localSheetId="3">') }), []);
});

test('calc chain present after a formula edit', () => {
  assertFails(broken('formulas.xlsx', { [SHEET1]: sub('<f>SUM(A2:A10)</f>', '<f>SUM(A2:A11)</f>') }), /calc chain is still present/, 'calcChain');
  // A value-only edit of the same sheet does not trip the rule.
  assert.deepStrictEqual(broken('formulas.xlsx', { [SHEET1]: sub('<c r="G2"><v>7</v></c>', '<c r="G2"><v>8</v></c>') }), []);
});

// ---------------------------------------------------------------------------------------------
// Styles rules (only when styles.xml is touched)

test('cellXfs/@count mismatch', () => {
  assertFails(broken('no-date-style.xlsx', { [STYLES]: (t) => t.replace('<cellXfs count="3">', '<cellXfs count="4">').replace('</cellXfs>', '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0"/></cellXfs>') }),
    /cellXfs count="4" but there are 5 records/, 'count');
});

test('numFmtId neither built-in nor defined; fontId/fillId/borderId/xfId out of range', () => {
  const append = (xf) => (t) => t.replace('<cellXfs count="3">', '<cellXfs count="4">').replace('</cellXfs>', `${xf}</cellXfs>`);
  assertFails(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="200" fontId="0" fillId="0" borderId="0" xfId="0"/>') }), /numFmtId="200" is neither built-in/, 'numFmt');
  assert.deepStrictEqual(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="163" fontId="0" fillId="0" borderId="0" xfId="0"/>') }), [], '163 is in the built-in range');
  assert.deepStrictEqual(broken('basic.xlsx', { [STYLES]: (t) => t.replace('<cellXfs count="12">', '<cellXfs count="13">').replace('</cellXfs>', '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>') }), [], 'defined custom id');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="14" fontId="2" fillId="0" borderId="0" xfId="0"/>') }), /fontId="2" but there are 2/, 'font');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="14" fontId="0" fillId="3" borderId="0" xfId="0"/>') }), /fillId="3" but there are 3/, 'fill');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="14" fontId="0" fillId="0" borderId="2" xfId="0"/>') }), /borderId="2" but there are 2/, 'border');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: append('<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="1"/>') }), /xfId="1" but there are 1 cell style formats/, 'xfId');
});

test('a pre-existing xf moved, changed or removed', () => {
  const XF1 = '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
  const XF2 = '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>';
  assertFails(broken('no-date-style.xlsx', { [STYLES]: sub(XF1 + XF2, XF2 + XF1) }), /xf\[1\] changed or moved/, 'moved');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: sub(XF1, XF1.replace('fontId="1"', 'fontId="0"')) }), /xf\[1\] changed or moved/, 'changed');
  assertFails(broken('no-date-style.xlsx', { [STYLES]: (t) => t.replace(XF2, '').replace('count="3"><xf', 'count="2"><xf') }), /xf\[2\] was removed/, 'removed');
  // Re-serialised with different spacing is a change too (records must be byte-identical).
  assertFails(broken('no-date-style.xlsx', { [STYLES]: sub(XF1, XF1.replace('" applyFont', '"  applyFont')) }), /xf\[1\] changed or moved/, 'respaced');
});

test('styles rules run only when styles.xml is touched; sheet rules only for touched sheets', () => {
  const pkg = open('no-date-style.xlsx');
  pkg.setPart(STYLES, encodePart(pkg.text(STYLES).replace('<cellXfs count="3">', '<cellXfs count="9">'), false));
  assert.deepStrictEqual(xlsxValidator(pkg, [SHEET1], ctxFor('no-date-style.xlsx')), []);
  assertFails(xlsxValidator(pkg, [STYLES], ctxFor('no-date-style.xlsx')), /count="9"/, 'touched styles');
});

test('a problem the file already had is not reported; an edit cannot add one', async () => {
  // An original whose dimension is already too small: editing another cell still saves...
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fixture('no-date-style.xlsx'));
  zip.file(SHEET1, (await zip.file(SHEET1).async('string')).replace('<dimension ref="A1:C4"/>', '<dimension ref="A1:B2"/>'));
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  const pkg = open('pre.xlsx', bytes);
  pkg.setPart(SHEET1, encodePart(pkg.text(SHEET1).replace('<v>4.5</v>', '<v>5</v>'), false));
  assert.deepStrictEqual(xlsxValidator(pkg, pkg.touchedParts(), ctxFor('pre.xlsx', bytes)), []);
  assert.ok(xlsxValidator(pkg, pkg.touchedParts()).length > 0, 'without the context it is reported');
  // ... but a new problem in the same part is.
  pkg.setPart(SHEET1, encodePart(pkg.text(SHEET1).replace('<c r="B3">', '<c r="B3" s="7">'), false));
  assertFails(xlsxValidator(pkg, pkg.touchedParts(), ctxFor('pre.xlsx', bytes)), /s="7"/, 'new problem');
});

test('in the save pipeline a failing xlsx rule blocks the bytes and names the part', () => {
  const pkg = open('no-date-style.xlsx');
  pkg.setPart(SHEET1, encodePart(pkg.text(SHEET1).replace('<row r="3">', '<row r="2">'), false));
  const r = serializeAndVerify(pkg, [packageValidator, xlsxValidator]);
  assert.strictEqual(r.ok, false);
  assert.ok(!('bytes' in r));
  const f = r.failures.find((x) => /strictly ascending/.test(x.message));
  assert.ok(f, JSON.stringify(r.failures));
  assert.strictEqual(f.part, SHEET1);
  // The same package saves once fixed.
  pkg.setPart(SHEET1, encodePart(open('no-date-style.xlsx').text(SHEET1), false));
  assert.ok(serializeAndVerify(pkg, [packageValidator, xlsxValidator]).ok);
});
