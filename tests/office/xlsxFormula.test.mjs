// WP-21: formula entry, `_xlfn` prefixes and shared-formula materialisation
// (src/office/core/xlsx/sharedFormula.ts, refs.ts slice 1, xlfn.ts). Spec §9.3 formula row, §9.4,
// §9.5, §13.2 G3–G6.
//
// Edited workbooks are written to tests/.out/xlsxFormula/<case>.xlsx for scripts/verify-office-open.ps1
// (plain outputs: the WP-24 `writeOut(..., expect)` helper is not on this branch yet).
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture, allFixtures, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG4, assertG5, rng } from './_roundtrip.mjs';
import { assertViewMatchesFile } from './_viewCheck.mjs';

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { applyXlsxEdit, refreshAfterEdit } = core.xlsx.ops;
const { applyEdit, invertEdit, EditBuilder } = core.edits;
const { serializeAndVerify, packageValidator } = core.save;
const { validateFormula, checkFormulaSyntax, formulaContextOf, translateFormula, addXlfnPrefixes, stripXlfnPrefixes, MAX_FORMULA_CHARS, FUNCTION_ARITY } = core.xlsx.refs;
const { FUTURE_FUNCTIONS, learnedPrefixes } = core.xlsx.xlfn;
const SF = core.xlsx.sharedFormula;
const { editSeed } = core.xlsx.format;
const OUT = 'xlsxFormula';
const SHEET1 = 'xl/worksheets/sheet1.xml';
const SHEET3 = 'xl/worksheets/sheet3.xml';
const FIRST_FORMULAS = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml'];

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}
const set = (sheetId, cells) => ({ op: 'setCells', sheetId, cells: cells.map(([r, c, input]) => ({ r, c, input })) });
const run = (wb, pkg, op) => applyXlsxEdit(wb, pkg, op, { confirmed: false });
const partText = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);

function cellSpan(text, ref) {
  const m = new RegExp(`<c r="${ref}"[ />]`).exec(text);
  assert.ok(m, `cell ${ref} not found`);
  const start = m.index;
  const selfEnd = text.indexOf('/>', start);
  const open = text.indexOf('>', start);
  const end = open === selfEnd + 1 ? selfEnd + 2 : text.indexOf('</c>', start) + 4;
  return { start, end };
}
const cellXml = (text, ref) => { const s = cellSpan(text, ref); return text.slice(s.start, s.end); };
/** Span from the start of the first cell to the end of the last. */
const spanOver = (text, first, last) => ({ start: cellSpan(text, first).start, end: cellSpan(text, last).end });

async function excel(bytes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(bytes));
  return w;
}

function save(pkg) {
  const r = serializeAndVerify(pkg, [packageValidator]);
  assert.ok(r.ok, `verify: ${JSON.stringify(r.failures)}`);
  return r.bytes;
}

async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) zip.file(part, fn(await zip.file(part).async('string')));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** Every `<f>` of a sheet must parse, and every shared dependant must have a master with its si (§13.3). */
function assertFormulasSound(sheetXml, msg = 'formulas') {
  const masters = new Set();
  const deps = [];
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:(?!<\/c>).)*?<f([^>]*?)(\/>|>([^<]*)<\/f>)/gs)) {
    const attrs = m[2];
    const text = (m[4] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const si = /\bsi="(\d+)"/.exec(attrs)?.[1];
    if (/t="shared"/.test(attrs)) {
      if (/\bref="/.test(attrs)) masters.add(si); else { deps.push([m[1], si]); continue; }
    }
    const v = validateFormula(text);
    assert.ok(v.ok, `${msg}: ${m[1]} <f>${text}</f> does not parse: ${JSON.stringify(v)}`);
  }
  for (const [ref, si] of deps) assert.ok(masters.has(si), `${msg}: dependant ${ref} (si ${si}) lost its master`);
}

// ---------------------------------------------------------------------------------------------
// Synthetic shared groups (on formulas.xlsx sheet "O'Brien", xl/worksheets/sheet3.xml)

const M0 = "A1+$A$1+A$1+$A1+'My Sheet'!B2+LEN(\"A1\")+SUM(A:A)+SUM(10:10)+TaxRate+_xlfn.XLOOKUP(A1,A:A,B:B)";
const M1 = "D4*2+'O''Brien'!$B$1+Data!A1";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SYN_SHEET_DATA = '<sheetData>'
  + '<row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>\'My Sheet\'!A1*TaxRate</f><v>2</v></c></row>'
  + `<row r="2"><c r="B2" s="0"><f t="shared" ref="B2:C3" si="0">${esc(M0)}</f><v>1</v></c><c r="C2"><f t="shared" si="0"/><v>2</v></c></row>`
  + '<row r="3"><c r="B3"><f t="shared" si="0"/><v>3</v></c><c r="C3" t="e"><f t="shared" si="0"/><v>#N/A</v></c></row>'
  + `<row r="5"><c r="D5"><f t="shared" ref="D5:D7" si="1">${esc(M1)}</f><v>10</v></c></row>`
  + '<row r="6"><c r="D6"><f t="shared" si="1"/><v>20</v></c></row>'
  + '<row r="7"><c r="D7"><f t="shared" si="1"/><v>40</v></c></row>'
  + '</sheetData>';
const SYN_EXPECTED = {
  B2: M0,
  C2: "B1+$A$1+B$1+$A1+'My Sheet'!C2+LEN(\"A1\")+SUM(B:B)+SUM(10:10)+TaxRate+_xlfn.XLOOKUP(B1,B:B,C:C)",
  B3: "A2+$A$1+A$1+$A2+'My Sheet'!B3+LEN(\"A1\")+SUM(A:A)+SUM(11:11)+TaxRate+_xlfn.XLOOKUP(A2,A:A,B:B)",
  C3: "B2+$A$1+B$1+$A2+'My Sheet'!C3+LEN(\"A1\")+SUM(B:B)+SUM(11:11)+TaxRate+_xlfn.XLOOKUP(B2,B:B,C:C)",
  D5: M1,
  D6: "D5*2+'O''Brien'!$B$1+Data!A2",
  D7: "D6*2+'O''Brien'!$B$1+Data!A3",
};
const synthetic = () => patched('formulas.xlsx', {
  [SHEET3]: (t) => t.replace(/<sheetData>.*<\/sheetData>/s, SYN_SHEET_DATA).replace('<dimension ref="A1:B1"/>', '<dimension ref="A1:D7"/>'),
});

// ---------------------------------------------------------------------------------------------
// validateFormula

const VALID = ['1+1', 'SUM(A1:B2)', "'My Sheet'!A1*2", 'Data!A2+\'O\'\'Brien\'!A1', 'A2*TaxRate', 'A3+[0]!LocalName',
  '_xlfn.XLOOKUP(3,A2:A10,B2:B10)', 'XLOOKUP(3,A2:A10,B2:B10)', 'IF(A8>5,"hi","lo")', '"a""b"&A1', '{1,2;3,4}',
  'SUM(A1,)', 'A1 B1', '1 + 2', 'SUM( A1 , B2 )', 'LET(x,1,x+1)', 'LAMBDA(a,b,a*b)(2,3)', 'Table1[Col]',
  'A:A', '1:1', '-A1%', 'A1^2', 'A1<>B1', '#N/A', 'TRUE', 'A1\n+B1', 'SUM((A1,B1))', 'IF(,1,2)', 'été!A1',
  // Gate R2 F2: what the semantic checks must keep accepting.
  'TRUE()', 'NOW()', 'ROW()', 'IF(A1,,)', 'ROUND(1.5,0)', 'A1:A2:A3', 'SUM(A1:A2,B1:B2)', '{1,2;3,4}', '{"a";"b"}',
  '"' + 'x'.repeat(255) + '"', '9.99999999999999E+307', '-9.99999999999999E+307', '1E-307', "'Sheet 1'!A1", "'A1'!B1",
  '[0]!LocalName', 'Sheet1:Sheet3!A1', 'foo(1,2,3)', '_xlfn.FUTUREFN()', 'LAMBDA(B,A1:B)(C1)', 'LET(B,A2,A1:B)',
  'XLOOKUP(1,A:A,B:B,,0,1)', 'SUM(' + Array(255).fill('1').join(',') + ')', 'CHOOSE(1,2)',
  'SUM(Table1[[#This Row],[a]])', 'Table1[#All]', 'R1C1', 'XFE1'];

// Gate R2 F2: formulas that parse but Excel refuses (or that would write a reference out of the
// workbook). [formula, message pattern, code?]
const REFUSED = [
  ['IF()', /IF needs at least 2 arguments/], ['ROUND(1.5)', /ROUND needs at least 2/], ['IF(1,2,3,4)', /IF takes at most 3/],
  ['VLOOKUP(A1)', /VLOOKUP needs at least 3/], ['PI(1)', /PI takes no arguments/], ['SUM()', /SUM needs at least 1/],
  ['_xlfn.XLOOKUP(1)', /XLOOKUP needs at least 3/], ['xlookup(1,A:A)', /XLOOKUP needs at least 3/],
  ['SUM(,)', /SUM needs a value/], ['IF(,)', /IF needs a value/], ['foo(' + Array(256).fill('1').join(',') + ')', /at most 255 arguments/],
  ['{1,2;3}', /same number of values/], ['"' + 'x'.repeat(256) + '"', /limited to 255 characters/],
  ['1e999', /between -9.99999999999999E\+307/], ['1E308', /between/], ['-1e400', /between/],
  ['A1..B2', /a range is written with ":"/], ['A1:B', /"B" is not a reference here/], ['B:A1', /"B" is not a reference/],
  ['Sheet 1!A1', /sheet name "1" must be in single quotes/], ['A1!B1', /sheet name "A1" must be in single quotes/],
  ['R1C1!A1', /single quotes/], ['A1,B1', /union of references/], ['(A1),B1', /union/],
  ['[@Col]', /needs its table name/],
  ['[1]Sheet1!A1', /other workbooks/, 'blocked'], ['[Book2.xlsx]Sheet1!A1', /other workbooks/, 'blocked'],
  ['[1]!Name', /other workbooks/, 'blocked'], ['SUM([2]Sheet1!A1:B2)', /other workbooks/, 'blocked'],
  ['[1]!Table1[Col]', /other workbooks/, 'blocked'],
];
// Refused only with the workbook context (formulas.xlsx: Data, My Sheet, O'Brien, NoCache; tables.xlsx:
// Scores, SalesTable).
const REFUSED_IN_CONTEXT = [
  ['formulas.xlsx', 'NoSuch!A1', /no sheet named "NoSuch"/], ['formulas.xlsx', "'No Such'!A1", /no sheet named "No Such"/],
  ['formulas.xlsx', 'Data:NoSuch!A1', /no sheet named "NoSuch"/], ['formulas.xlsx', 'Table9[Col]', /no table named "Table9"/],
  ['tables.xlsx', 'SalesTable[NoColumn]', /Table "SalesTable" has no column "NoColumn"/],
  ['tables.xlsx', 'SUM(Scores[[#This Row],[Column3]])', /no column "Column3"/],
];
const ACCEPTED_IN_CONTEXT = [
  ['formulas.xlsx', "data!A1+'my sheet'!B2+'O''Brien'!C3+Data:NoCache!A1+TaxRate"], ['formulas.xlsx', 'A1:TaxRate'],
  ['tables.xlsx', 'SUM(SalesTable[Units])+salestable[[#Totals],[price]]+Scores[[Column1]:[Column2]]+SalesTable[#Headers]'],
];
const INVALID = [
  ['SUM(A1', 6], ['1+', 2], [')', 0], ['foo(', 4], ['"abc', 4], ['=A1', 0], ['A1#', 2], ['@A1:A3', 0], ['{A1}', 3],
  ['SUM(A1:A3)#', 10], ['a b c', 4], [' ', 1], ['A1+\u0001', 3], ['A1+\ud800', 3], ['x'.repeat(MAX_FORMULA_CHARS + 1), MAX_FORMULA_CHARS],
];

test('validateFormula accepts what Excel accepts', () => {
  for (const f of VALID) assert.deepStrictEqual(validateFormula(f), { ok: true }, f);
});

test('validateFormula rejects unparseable formulas with a position', () => {
  for (const [f, pos] of INVALID) {
    const v = validateFormula(f);
    assert.strictEqual(v.ok, false, JSON.stringify(f));
    assert.ok(typeof v.message === 'string' && v.message.length > 0);
    assert.ok(Math.abs(v.position - pos) <= 1, `${JSON.stringify(f.slice(0, 20))}: position ${v.position}, expected about ${pos}`);
  }
});

const contextOf = (name) => formulaContextOf(OfficePackage.open(name, fixture(name)));

test('F2: validateFormula refuses what parses but Excel refuses (arity, empty calls, arrays, literals, names, quoting, unions, other workbooks)', () => {
  for (const [f, re, code] of REFUSED) {
    for (const ctx of [undefined, contextOf('formulas.xlsx')]) {
      const v = validateFormula(f, ctx);
      assert.strictEqual(v.ok, false, `${f.slice(0, 40)} must be refused`);
      assert.match(v.message, re, f.slice(0, 40));
      assert.strictEqual(v.code, code, `${f.slice(0, 40)}: code`);
      assert.ok(v.position >= 0 && v.position <= f.length);
    }
    // The syntax-only check (used by the save validator for formulas already in the file) accepts them.
    assert.deepStrictEqual(checkFormulaSyntax(f), { ok: true }, f.slice(0, 40));
  }
});

test('F2: with the workbook context, unknown sheets, tables and table columns are refused (names compare case-insensitively)', () => {
  for (const [name, f, re] of REFUSED_IN_CONTEXT) {
    assert.deepStrictEqual(validateFormula(f), { ok: true }, `${f}: without a context only syntax and shape are checked`);
    const v = validateFormula(f, contextOf(name));
    assert.strictEqual(v.ok, false, `${name}: ${f}`);
    assert.match(v.message, re, f);
  }
  for (const [name, f] of ACCEPTED_IN_CONTEXT) assert.deepStrictEqual(validateFormula(f, contextOf(name)), { ok: true }, `${name}: ${f}`);
});

test('F2: every formula of every fixture validates in its own workbook context (shared dependants through their master)', async () => {
  let n = 0;
  for (const name of allFixtures('xlsx')) {
    let pkg, wb;
    try { pkg = OfficePackage.open(name, fixture(name)); wb = Workbook.load(pkg); } catch { continue; }
    const ctx = formulaContextOf(pkg);
    assert.ok(ctx, `${name}: context`);
    for (const e of wb.sheets) {
      if (e.kind !== 'worksheet') continue;
      let s;
      try { s = await wb.sheet(e.id); } catch { continue; }
      for (const cell of s.cellsIn([0, 0, 1_048_575, 16_383])) {
        const f = SF.cellFormula(s, cell);
        if (f === undefined || cell.arrayRef !== undefined && f === '') continue;
        assert.deepStrictEqual(validateFormula(f, ctx), { ok: true }, `${name} ${e.name}!R${cell.r + 1}C${cell.c + 1}: ${f}`);
        n++;
      }
    }
  }
  assert.ok(n >= 40, `checked ${n} fixture formulas`);
});

test('F2: the arity table ([MS-XLS] Ftab + Excel 2007 built-ins + every _xlfn function)', () => {
  assert.ok(FUNCTION_ARITY.size >= 500, `${FUNCTION_ARITY.size} functions`);
  for (const [name, [min, max]] of FUNCTION_ARITY) {
    assert.ok(/^[A-Z][A-Z0-9.]*$/.test(name), name);
    assert.ok(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && min <= max && max <= 255, `${name} ${min}..${max}`);
  }
  // Every future function is listed, except the ones parsed as syntax (LET, LAMBDA) and those whose
  // signature is not published (Python and Power Query plumbing).
  const unlisted = new Set(['LET', 'LAMBDA', 'PY', 'PYTHON_STR', 'PYTHON_TYPE', 'PYTHON_TYPENAME', 'PQSOURCE', 'QUERYSTRING']);
  for (const name of FUTURE_FUNCTIONS.keys()) if (!unlisted.has(name)) assert.ok(FUNCTION_ARITY.has(name), `${name} missing`);
  const spot = { IF: [2, 3], SUM: [1, 255], ROUND: [2, 2], VLOOKUP: [3, 4], INDEX: [2, 4], TEXT: [2, 2], NOW: [0, 0], ROW: [0, 1],
    IFERROR: [2, 2], SUMIFS: [3, 255], EDATE: [2, 2], NETWORKDAYS: [2, 3], XLOOKUP: [3, 6], FILTER: [2, 3], SEQUENCE: [1, 4],
    TEXTJOIN: [3, 255], CONCATENATE: [1, 255], WEEKDAY: [1, 2], TRUNC: [1, 2], FIXED: [1, 3], LINEST: [1, 4] };
  for (const [name, want] of Object.entries(spot)) assert.deepStrictEqual([...FUNCTION_ARITY.get(name)], want, name);
  for (const macroOnly of ['GET.CELL', 'EVALUATE', 'GOTO', 'YEN']) assert.ok(!FUNCTION_ARITY.has(macroOnly), macroOnly);
});

test('F2: formula entry refuses in context (invalid / blocked), writes nothing; re-committing a file formula that fails today is a no-op', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  for (const [input, code, re] of [['=IF()', 'invalid', /IF needs at least 2 arguments \(at character 2\)\.$/],
    ['=NoSuch!A1', 'invalid', /no sheet named "NoSuch"/], ['=Table9[Col]', 'invalid', /no table named "Table9"/],
    ['=[1]Sheet1!A1', 'blocked', /^This formula can't be used: References to other workbooks can't be entered here\.$/],
    ['=SUM([Book2.xlsx]Sheet1!A1:B2)', 'blocked', /other workbooks/], ['=A1,B1', 'invalid', /union/]]) {
    for (const [r, c] of [[1, 6], [1, 1], [20, 20]]) {
      const res = await run(wb, pkg, set(1, [[r, c, input]]));
      assert.strictEqual(res.ok, false, input);
      assert.strictEqual(res.error.code, code, input);
      assert.match(res.error.message, re, res.error.message);
    }
    const paste = await run(wb, pkg, set(1, [[1, 6, '7'], [2, 6, input]]));
    assert.strictEqual(paste.ok, false);
  }
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'unchanged');
  assert.deepStrictEqual(validateFormula('NoCache!A1+Data!A1', formulaContextOf(pkg)), { ok: true });

  // A formula already in the file that today's checks refuse is shown, and committing it back changes nothing.
  const legacy = await patched('formulas.xlsx', { [SHEET1]: (t) => t.replace('<c r="G2"><v>', '<c r="G2"><f>[1]Old!A1+NoSuch!B2+IF(1)</f><v>') });
  const l = load('legacy.xlsx', legacy);
  const ls = await l.wb.sheet(1);
  const seed = editSeed(ls.cell(1, 6), core.xlsx.ops.stylesFor(l.wb), false);
  assert.strictEqual(seed, '=[1]Old!A1+NoSuch!B2+IF(1)');
  const again = await run(l.wb, l.pkg, set(1, [[1, 6, seed]]));
  assert.deepStrictEqual({ ok: again.ok, edit: again.edit }, { ok: true, edit: null });
  const changed = await run(l.wb, l.pkg, set(1, [[1, 6, seed + '+1']]));
  assert.strictEqual(changed.ok, false);
  assert.strictEqual(changed.error.code, 'blocked');
});

test('F2: the save validator checks changed formulas in context, and not formulas the file already had', async () => {
  const { xlsxValidator } = core.xlsx.validate;
  const validators = [packageValidator, xlsxValidator];
  // A formula written behind the validators' back (not through setFormula) that names a missing sheet.
  const { pkg, wb, bytes } = load('formulas.xlsx');
  await wb.sheet(1);
  const b = new EditBuilder(pkg, 'raw');
  const doc = pkg.xml(SHEET1);
  const find = (n, ref) => { if (n.type === 'el' && n.local === 'c' && n.attrs.some((a) => a.local === 'r' && a.value === ref)) return n; for (const ch of n.children ?? []) { const x = find(ch, ref); if (x) return x; } return undefined; };
  b.replaceNode(SHEET1, find(doc.root, 'G2'), '<c r="G2"><f>NoSuch!A1+IF(1)</f></c>');
  b.finish();
  // serializeAndVerify hands the validators the package as loaded (from pkg.originalBytes).
  const r = serializeAndVerify(pkg, validators);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => /cell G2 has a formula Excel would refuse \(There is no sheet named "NoSuch"/.test(f.message)), JSON.stringify(r.failures));
  // The xlsx validator itself: without a loaded package there is no telling what changed, so only syntax is checked.
  assert.deepStrictEqual(xlsxValidator(OfficePackage.open('x.xlsx', pkg.serialize()), [SHEET1]).filter((m) => /would refuse/.test(m)), []);

  // The same formula already in the file: an unrelated edit to the sheet saves.
  const legacy = await patched('formulas.xlsx', { [SHEET1]: (t) => t.replace('<c r="G2"><v>', '<c r="G2"><f>NoSuch!A1+IF(1)</f><v>') });
  const l = load('legacy.xlsx', legacy);
  const e = await run(l.wb, l.pkg, set(1, [[0, 6, '5']]));
  assert.ok(e.ok && e.edit);
  const saved = serializeAndVerify(l.pkg, validators);
  assert.ok(saved.ok, JSON.stringify(saved.failures));
});

// ---------------------------------------------------------------------------------------------
// translateFormula

const TRANSLATE = [
  ['A1', 1, 1, 'B2'],
  ['A1+$B$2+B$3+$C4', 1, 1, 'B2+$B$2+C$3+$C5'],
  ['SUM( A1 , B2 )', 2, 0, 'SUM( A3 , B4 )'],
  ["'My Sheet'!A1*2", 0, 3, "'My Sheet'!D1*2"],
  ["'O''Brien'!A1:B2", 1, 0, "'O''Brien'!A2:B3"],
  ['"A1"&A1', 1, 0, '"A1"&A2'],
  ['Table1[Col]+A1', 1, 0, 'Table1[Col]+A2'],
  ['Table1[[#This Row],[Col]]', 5, 5, 'Table1[[#This Row],[Col]]'],
  ['[1]Sheet1!A1+A2', 1, 0, '[1]Sheet1!A2+A3'],
  ['A:A+1:1', 1, 1, 'B:B+2:2'],
  ['$A:B+1:$3', 1, 1, '$A:C+2:$3'],
  ['A1:A1', 0, 1, 'B1:B1'],
  ['B2:A1', 1, 0, 'B3:A2'],
  ['XFD1+1', 0, 1, '#REF!+1'],
  ['A1048576', 1, 0, '#REF!'],
  ['C3', -2, -2, 'A1'],
  ['C3', -3, 0, '#REF!'],
  ['TaxRate*R1C1+RC', 1, 1, 'TaxRate*R1C1+RC'],        // names that look like R1C1 references stay names
  ['a1+b$2', 1, 1, 'B2+C$2'],
  ['_xlfn.XLOOKUP(A1,A:A,B:B)', 1, 0, '_xlfn.XLOOKUP(A2,A:A,B:B)'],
  ['#REF!+A1', 1, 0, '#REF!+A2'],
  ['Sheet1:Sheet3!A1', 1, 0, 'Sheet1:Sheet3!A2'],
  ['INDIRECT("A1")', 9, 9, 'INDIRECT("A1")'],
  ['LET(x,A1,x+1)', 1, 0, 'LET(x,A2,x+1)'],
];

test('translateFormula moves relative parts only and preserves all other text', () => {
  for (const [f, dr, dc, want] of TRANSLATE) assert.strictEqual(translateFormula(f, dr, dc), want, `${f} by (${dr}, ${dc})`);
});

test('translateFormula by (0, 0) is the identity, every fixture formula validates, strip/add round-trips', async () => {
  let n = 0;
  for (const name of allFixtures('xlsx')) {
    let pkg;
    try { pkg = OfficePackage.open(name, fixture(name)); } catch { continue; }
    for (const part of pkg.partNames()) {
      if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(part)) continue;
      const text = pkg.text(part);
      for (const m of text.matchAll(/<(?:x:)?f\b[^>]*>([^<]+)<\/(?:x:)?f>/g)) {
        const f = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        assert.strictEqual(translateFormula(f, 0, 0), f, `${name}: ${f}`);
        assert.deepStrictEqual(validateFormula(f), { ok: true }, `${name}: ${f}`);
        assert.strictEqual(addXlfnPrefixes(stripXlfnPrefixes(f)), f, `${name}: strip/add ${f}`);
        n++;
      }
    }
  }
  assert.ok(n >= 25, `exercised ${n} fixture formulas`);
});

// ---------------------------------------------------------------------------------------------
// _xlfn

// [MS-XLSX] §2.2.2.1 (revision 2024-04-16): every listed future function, with its stored prefix.
const MS_XLSX_FUTURE = '_xlfn._xlws.FILTER _xlfn._xlws.PY _xlfn._xlws.SORT _xlfn.ACOT _xlfn.ACOTH _xlfn.AGGREGATE _xlfn.ARABIC _xlfn.BASE _xlfn.BETA.DIST _xlfn.BETA.INV _xlfn.BINOM.DIST _xlfn.BINOM.DIST.RANGE _xlfn.BINOM.INV _xlfn.BITAND _xlfn.BITLSHIFT _xlfn.BITOR _xlfn.BITRSHIFT _xlfn.BITXOR _xlfn.BYCOL _xlfn.BYROW _xlfn.CEILING.MATH _xlfn.CEILING.PRECISE _xlfn.CHISQ.DIST _xlfn.CHISQ.DIST.RT _xlfn.CHISQ.INV _xlfn.CHISQ.INV.RT _xlfn.CHISQ.TEST _xlfn.CHOOSECOLS _xlfn.CHOOSEROWS _xlfn.COMBINA _xlfn.CONCAT _xlfn.CONFIDENCE.NORM _xlfn.CONFIDENCE.T _xlfn.COT _xlfn.COTH _xlfn.COVARIANCE.P _xlfn.COVARIANCE.S _xlfn.CSC _xlfn.CSCH _xlfn.DAYS _xlfn.DECIMAL _xlfn.DROP _xlfn.ERF.PRECISE _xlfn.ERFC.PRECISE _xlfn.EXPAND _xlfn.EXPON.DIST _xlfn.F.DIST _xlfn.F.DIST.RT _xlfn.F.INV _xlfn.F.INV.RT _xlfn.F.TEST _xlfn.FIELDVALUE _xlfn.FILTERXML _xlfn.FLOOR.MATH _xlfn.FLOOR.PRECISE _xlfn.FORECAST.ETS _xlfn.FORECAST.ETS.CONFINT _xlfn.FORECAST.ETS.SEASONALITY _xlfn.FORECAST.ETS.STAT _xlfn.FORECAST.LINEAR _xlfn.FORMULATEXT _xlfn.GAMMA _xlfn.GAMMA.DIST _xlfn.GAMMA.INV _xlfn.GAMMALN.PRECISE _xlfn.GAUSS _xlfn.HSTACK _xlfn.HYPGEOM.DIST _xlfn.IFNA _xlfn.IFS _xlfn.IMCOSH _xlfn.IMCOT _xlfn.IMCSC _xlfn.IMCSCH _xlfn.IMSEC _xlfn.IMSECH _xlfn.IMSINH _xlfn.IMTAN _xlfn.ISFORMULA _xlfn.ISOMITTED _xlfn.ISOWEEKNUM _xlfn.LAMBDA _xlfn.LET _xlfn.LOGNORM.DIST _xlfn.LOGNORM.INV _xlfn.MAKEARRAY _xlfn.MAP _xlfn.MAXIFS _xlfn.MINIFS _xlfn.MODE.MULT _xlfn.MODE.SNGL _xlfn.MUNIT _xlfn.NEGBINOM.DIST _xlfn.NORM.DIST _xlfn.NORM.INV _xlfn.NORM.S.DIST _xlfn.NORM.S.INV _xlfn.NUMBERVALUE _xlfn.PDURATION _xlfn.PERCENTILE.EXC _xlfn.PERCENTILE.INC _xlfn.PERCENTRANK.EXC _xlfn.PERCENTRANK.INC _xlfn.PERMUTATIONA _xlfn.PHI _xlfn.POISSON.DIST _xlfn.PQSOURCE _xlfn.PYTHON_STR _xlfn.PYTHON_TYPE _xlfn.PYTHON_TYPENAME _xlfn.QUARTILE.EXC _xlfn.QUARTILE.INC _xlfn.QUERYSTRING _xlfn.RANDARRAY _xlfn.RANK.AVG _xlfn.RANK.EQ _xlfn.REDUCE _xlfn.RRI _xlfn.SCAN _xlfn.SEC _xlfn.SECH _xlfn.SEQUENCE _xlfn.SHEET _xlfn.SHEETS _xlfn.SKEW.P _xlfn.SORTBY _xlfn.STDEV.P _xlfn.STDEV.S _xlfn.SWITCH _xlfn.T.DIST _xlfn.T.DIST.2T _xlfn.T.DIST.RT _xlfn.T.INV _xlfn.T.INV.2T _xlfn.T.TEST _xlfn.TAKE _xlfn.TEXTAFTER _xlfn.TEXTBEFORE _xlfn.TEXTJOIN _xlfn.TEXTSPLIT _xlfn.TOCOL _xlfn.TOROW _xlfn.UNICHAR _xlfn.UNICODE _xlfn.UNIQUE _xlfn.VAR.P _xlfn.VAR.S _xlfn.VSTACK _xlfn.WEBSERVICE _xlfn.WEIBULL.DIST _xlfn.WRAPCOLS _xlfn.WRAPROWS _xlfn.XLOOKUP _xlfn.XOR _xlfn.Z.TEST'.split(' ');
// Functions [MS-XLSX] lists without a prefix and pre-2010 functions: written bare.
const BARE = ['ECMA.CEILING', 'ISO.CEILING', 'NETWORKDAYS.INTL', 'WORKDAY.INTL', 'SUM', 'VLOOKUP', 'IF', 'IFERROR', 'SUMIFS', 'CONCATENATE', 'STDEV'];

test('_xlfn list covers [MS-XLSX] and the _xlfn names in formulas.xlsx; pre-2010 functions stay bare', () => {
  for (const full of MS_XLSX_FUTURE) {
    const name = full.replace(/^(_xlfn\.|_xlws\.)+/, '');
    assert.strictEqual(addXlfnPrefixes(`${name}(1)`), `${full}(1)`, name);
    assert.strictEqual(stripXlfnPrefixes(`${full}(1)`), `${name}(1)`, name);
  }
  for (const n of ['CONCAT', 'IFS', 'TEXTJOIN', 'STDEV.S', 'XLOOKUP']) assert.ok(FUTURE_FUNCTIONS.has(n), n);
  for (const n of BARE) assert.strictEqual(addXlfnPrefixes(`${n}(1)`), `${n}(1)`, n);
});

test('_xlfn prefix added for XLOOKUP, LET, FILTER, LAMBDA… and stripped for display', () => {
  const cases = [
    ['XLOOKUP(A1,B:B,C:C)', '_xlfn.XLOOKUP(A1,B:B,C:C)'],
    ['xlookup(A1,B:B,C:C)', '_xlfn.XLOOKUP(A1,B:B,C:C)'],
    ['LET(x,1,x+1)', '_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'],
    ['LET(x,A1,y,x*2,x+y)', '_xlfn.LET(_xlpm.x,A1,_xlpm.y,_xlpm.x*2,_xlpm.x+_xlpm.y)'],
    ['LAMBDA(a,b,a*b)(2,3)', '_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a*_xlpm.b)(2,3)'],
    ['FILTER(A1:A3,B1:B3>0)', '_xlfn._xlws.FILTER(A1:A3,B1:B3>0)'],
    ['SORT(UNIQUE(A:A))', '_xlfn._xlws.SORT(_xlfn.UNIQUE(A:A))'],
    ['TaxRate+LET(TaxRate,2,TaxRate)', 'TaxRate+_xlfn.LET(_xlpm.TaxRate,2,_xlpm.TaxRate)'],   // the outer name is the defined name
    ['"XLOOKUP("&CONCAT(1)', '"XLOOKUP("&_xlfn.CONCAT(1)'],
    ['SUM(A1:A3)', 'SUM(A1:A3)'],
  ];
  for (const [shown, file] of cases) {
    assert.strictEqual(addXlfnPrefixes(shown), file, shown);
    assert.strictEqual(addXlfnPrefixes(file), file, `idempotent: ${file}`);
    assert.strictEqual(addXlfnPrefixes(stripXlfnPrefixes(file)), file, `round trip: ${file}`);
  }
  assert.strictEqual(stripXlfnPrefixes('_xlfn.LET(_xlpm.x,1,_xlpm.x+1)+_xlfn._xlws.SORT(A1:A2)'), 'LET(x,1,x+1)+SORT(A1:A2)');
  // An unknown future function keeps the prefix it already has; learnedPrefixes carries it to edits.
  assert.strictEqual(addXlfnPrefixes('_xlfn.NEWFN(1)+XLOOKUP(1,A:A,B:B)'), '_xlfn.NEWFN(1)+_xlfn.XLOOKUP(1,A:A,B:B)');
  const learned = learnedPrefixes('_xlfn.NEWFN(A1)');
  assert.deepStrictEqual([...learned], [['NEWFN', '_xlfn.']]);
  assert.strictEqual(addXlfnPrefixes('NEWFN(A2)', learned), '_xlfn.NEWFN(A2)');
  assert.strictEqual(addXlfnPrefixes('NEWFN(A2)'), 'NEWFN(A2)');
});

test('editSeed and the grid show formulas without _xlfn prefixes', async () => {
  const { wb } = load('formulas.xlsx');
  const sheet = await wb.sheet(1);
  const styles = core.xlsx.ops.stylesFor(wb);
  assert.strictEqual(editSeed(sheet.cell(1, 5), styles, false), '=CONCAT("a",A2)');
  assert.strictEqual(editSeed(sheet.cell(5, 5), styles, false), '=XLOOKUP(3,A2:A10,B2:B10)');
  const nocache = await wb.sheet(4);
  assert.strictEqual(core.xlsx.view.cellText(wb, styles, nocache.cell(2, 0)), '=CONCAT("x","y")');
  assert.strictEqual(SF.displayFormula(sheet, sheet.cell(4, 1)), 'A5*2', 'shared dependant B5');
});

// ---------------------------------------------------------------------------------------------
// Formula entry (G3–G6)

test('unparseable formula is rejected with a position and nothing is written', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  for (const input of ['=SUM(A1', '=1+', '==A1', '=A1#', '=@A1:A3', '=foo(', '="abc', '=A1+\u0001', '=' + 'x'.repeat(MAX_FORMULA_CHARS + 1)]) {
    for (const [r, c] of [[1, 6], [1, 1], [2, 1], [20, 20]]) {   // value cell, shared master, dependant, new cell
      const res = await run(wb, pkg, set(1, [[r, c, input]]));
      assert.strictEqual(res.ok, false, input);
      assert.strictEqual(res.error.code, 'invalid', input);
      assert.match(res.error.message, /^This formula can't be used: .*\((at character \d+|at the end of the formula)\)\.$/, res.error.message);
    }
  }
  const pasted = await run(wb, pkg, set(1, [[1, 6, '=1+1'], [2, 6, '=SUM(']]));   // all-or-nothing paste
  assert.strictEqual(pasted.ok, false);
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  assert.match((await run(wb, pkg, set(1, [[0, 0, '=SUM(A1']]))).error.message, /at the end of the formula/);
  const mid = validateFormula('SUM(1,2))+3');
  assert.ok(!mid.ok && mid.position < 10, JSON.stringify(mid));
  const midMsg = (await run(wb, pkg, set(1, [[0, 0, '=SUM(1,2))+3']]))).error.message;
  assert.ok(midMsg.includes(`(at character ${mid.position + 2}).`), midMsg);
});

test('edited formula cell has no <v>, t removed, s kept (G3/G4/G5/G6)', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const res = await run(wb, pkg, set(1, [[1, 5, '=TEXTJOIN("-",TRUE,A2:A4)']]));   // F2: t="str" with a cached v
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  const after = save(pkg);
  assertG3(bytes, after, [SHEET1, ...FIRST_FORMULAS]);
  const before = partText(bytes, SHEET1);
  const text = partText(after, SHEET1);
  assertG4(before, text, cellSpan(before, 'F2'));
  assert.strictEqual(cellXml(text, 'F2'), '<c r="F2"><f>_xlfn.TEXTJOIN("-",TRUE,A2:A4)</f></c>');
  assertG5(pkg, res.edit, bytes);
  assertFormulasSound(text);
  writeOut(OUT, 'formula-replaces-str.xlsx', after);
  const ws = (await excel(after)).getWorksheet('Data');
  assert.strictEqual(ws.getCell('F2').formula, '_xlfn.TEXTJOIN("-",TRUE,A2:A4)');
  // The read side: no cached value, so the grid shows the formula ("not calculated").
  const s = await wb.sheet(1);
  const cell = s.cell(1, 5);
  assert.strictEqual(cell.hasCachedValue, false);
  assert.strictEqual(core.xlsx.view.cellText(wb, core.xlsx.ops.stylesFor(wb), cell), '=TEXTJOIN("-",TRUE,A2:A4)');
});

test('formula into a value cell and a new cell on basic.xlsx; new cell inherits style; escaping', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  const res = await run(wb, pkg, set(1, [[1, 1, '=IF(B3<>"x&y",1,0)']]));
  assert.ok(res.ok && res.edit);
  const after = save(pkg);
  assertG3(bytes, after, [SHEET1, 'xl/workbook.xml']);
  const before = partText(bytes, SHEET1);
  const text = partText(after, SHEET1);
  assertG4(before, text, cellSpan(before, 'B2'));
  assert.strictEqual(cellXml(text, 'B2'), '<c r="B2"><f>IF(B3&lt;&gt;"x&amp;y",1,0)</f></c>');
  assertG5(pkg, res.edit, bytes);
  writeOut(OUT, 'formula-basic.xlsx', after);
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B2').formula, 'IF(B3<>"x&y",1,0)');

  // New cell in a row with customFormat style.
  const rowStyled = await patched('basic.xlsx', { [SHEET1]: (t) => t.replace(/<row r="2"([^>]*)>/, '<row r="2"$1 s="1" customFormat="1">') });
  const p = load('row.xlsx', rowStyled);
  const r2 = await run(p.wb, p.pkg, set(1, [[1, 30, '=1+1']]));
  assert.ok(r2.ok && r2.edit);
  assert.match(p.pkg.text(SHEET1), /<c r="AE2" s="1"><f>1\+1<\/f><\/c>/);
  assertG5(p.pkg, r2.edit, rowStyled);
});

test('editing a dependant replaces only its f; the group keeps its master (G4)', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const res = await run(wb, pkg, set(1, [[4, 1, '=A5*3']]));   // B5
  assert.ok(res.ok && res.edit);
  const after = save(pkg);
  assertG3(bytes, after, [SHEET1, ...FIRST_FORMULAS]);
  const before = partText(bytes, SHEET1);
  const text = partText(after, SHEET1);
  assertG4(before, text, cellSpan(before, 'B5'));
  assert.strictEqual(cellXml(text, 'B5'), '<c r="B5"><f>A5*3</f></c>');
  assert.ok(text.includes('<c r="B2"><f t="shared" ref="B2:B10" si="0">A2*2</f><v>0</v></c>'));
  assert.ok(text.includes('<c r="B6"><f t="shared" si="0"/><v>0</v></c>'));
  assertFormulasSound(text);
  assertG5(pkg, res.edit, bytes);
  writeOut(OUT, 'edit-dependant.xlsx', after);
  const ws = (await excel(after)).getWorksheet('Data');
  assert.strictEqual(ws.getCell('B5').formula, 'A5*3');
  assert.strictEqual(ws.getCell('B6').formula, 'A6*2');
});

/** formulas.xlsx B2:B10 as ExcelJS resolves it (its shared-formula translation). */
async function exceljsShared(bytes, sheetName, refs) {
  const ws = (await excel(bytes)).getWorksheet(sheetName);
  return Object.fromEntries(refs.map((r) => [r, ws.getCell(r).formula]));
}

const B_REFS = ['B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10'];

test('editing a master materialises every dependant with the translated text (formulas.xlsx; cross-checked with ExcelJS)', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const expected = await exceljsShared(bytes, 'Data', B_REFS);
  for (const r of B_REFS) assert.strictEqual(expected[r], `A${r.slice(1)}*2`, `ExcelJS ${r}`);
  // Our read side agrees before any edit.
  const s = await wb.sheet(1);
  for (const r of B_REFS) assert.strictEqual(SF.cellFormula(s, s.cell(Number(r.slice(1)) - 1, 1)), expected[r]);

  const res = await run(wb, pkg, set(1, [[1, 1, '=A2+1']]));
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  const after = save(pkg);
  assertG3(bytes, after, [SHEET1, ...FIRST_FORMULAS]);
  const before = partText(bytes, SHEET1);
  const text = partText(after, SHEET1);
  assertG4(before, text, spanOver(before, 'B2', 'B10'));
  assert.strictEqual(cellXml(text, 'B2'), '<c r="B2"><f>A2+1</f></c>');
  for (const r of B_REFS) assert.strictEqual(cellXml(text, r), `<c r="${r}"><f>${expected[r]}</f><v>0</v></c>`, r);
  assert.ok(!/t="shared"/.test(text));
  assertFormulasSound(text);
  assertG5(pkg, res.edit, bytes);
  writeOut(OUT, 'edit-master.xlsx', after);
  const got = await exceljsShared(after, 'Data', B_REFS);
  assert.deepStrictEqual(got, expected, 'ExcelJS reads the materialised formulas');
});

test('clearing a master (setCells "" and clearCells) materialises the group first', async () => {
  for (const op of [set(1, [[1, 1, '']]), { op: 'clearCells', sheetId: 1, range: [0, 1, 1, 1] }]) {
    const { pkg, wb, bytes } = load('formulas.xlsx');
    const res = await run(wb, pkg, op);
    assert.ok(res.ok && res.edit, JSON.stringify(res));
    const after = save(pkg);
    const text = partText(after, SHEET1);
    assert.ok(!text.includes('<c r="B2"'), 'unstyled master removed');
    for (const r of B_REFS) assert.strictEqual(cellXml(text, r), `<c r="${r}"><f>A${r.slice(1)}*2</f><v>0</v></c>`, r);
    assertFormulasSound(text);
    assertG5(pkg, res.edit, bytes);
    writeOut(OUT, `clear-master-${op.op}.xlsx`, after);
    await excel(after);
  }
});

test('2-D synthetic groups: $-anchors, quoted sheets, strings, whole rows/columns, names, _xlfn (cross-checked with ExcelJS)', async () => {
  const bytes = await synthetic();
  const { pkg, wb } = load('syn.xlsx', bytes);
  const s = await wb.sheet(3);
  // Read side agrees with the expectation, and with ExcelJS where ExcelJS's shared-formula slide is
  // reliable: ExcelJS 4.4 also rewrites "A1" inside string literals and does not move whole-row/column
  // references, so group 0 (which has both on purpose) is checked against the hand-derived Excel
  // semantics only; ExcelJS's known-wrong answer is pinned so a change in it is noticed.
  const ej = await exceljsShared(bytes, "O'Brien", Object.keys(SYN_EXPECTED));
  for (const [ref, want] of Object.entries(SYN_EXPECTED)) {
    const [r, c] = core.xlsx.sheet.a1ToRc(ref);
    assert.strictEqual(SF.cellFormula(s, s.cell(r, c)), want, `cellFormula ${ref}`);
    if (ref.startsWith('D')) assert.strictEqual(ej[ref], want, `ExcelJS ${ref}`);
  }
  assert.strictEqual(ej.C2, "B1+$A$1+B$1+$A1+'My Sheet'!C2+LEN(\"B1\")+SUM(A:A)+SUM(10:10)+TaxRate+_xlfn.XLOOKUP(B1,A:A,B:B)", 'ExcelJS slide (known wrong)');
  // Edit the 2-D master: every dependant materialised, their t/v kept.
  const res = await run(wb, pkg, set(3, [[1, 1, '=XLOOKUP(A1,A:A,B:B)']]));
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  const after = save(pkg);
  assertG3(bytes, after, [SHEET3, ...FIRST_FORMULAS]);
  const text = partText(after, SHEET3);
  assertG4(partText(bytes, SHEET3), text, spanOver(partText(bytes, SHEET3), 'B2', 'C3'));
  assert.strictEqual(cellXml(text, 'B2'), '<c r="B2" s="0"><f>_xlfn.XLOOKUP(A1,A:A,B:B)</f></c>');
  assert.strictEqual(cellXml(text, 'C2'), `<c r="C2"><f>${esc(SYN_EXPECTED.C2)}</f><v>2</v></c>`);
  assert.strictEqual(cellXml(text, 'B3'), `<c r="B3"><f>${esc(SYN_EXPECTED.B3)}</f><v>3</v></c>`);
  assert.strictEqual(cellXml(text, 'C3'), `<c r="C3" t="e"><f>${esc(SYN_EXPECTED.C3)}</f><v>#N/A</v></c>`);
  assert.ok(text.includes('<c r="D6"><f t="shared" si="1"/><v>20</v></c>'), 'the other group is untouched');
  assertFormulasSound(text);
  assertG5(pkg, res.edit, bytes);
  writeOut(OUT, 'synthetic-2d-master.xlsx', after);
  const ws = (await excel(after)).getWorksheet("O'Brien");
  for (const ref of ['C2', 'B3', 'C3']) assert.strictEqual(ws.getCell(ref).formula, SYN_EXPECTED[ref], ref);
});

// Gate R2 F7: two groups reusing si="0" (Excel never writes this, but files do arrive so).
const TWO_MASTERS = '<sheetData>'
  + '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>'
  + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>'
  + '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row>'
  + '<row r="6"><c r="A6"><v>6</v></c><c r="B6"><f t="shared" ref="B6:B7" si="0">A6+100</f><v>106</v></c></row>'
  + '<row r="7"><c r="A7"><v>7</v></c><c r="B7"><f t="shared" si="0"/><v>107</v></c></row>'
  + '</sheetData>';
const onSheet3 = (data) => patched('formulas.xlsx', {
  [SHEET3]: (t) => t.replace(/<sheetData>.*<\/sheetData>/s, data).replace('<dimension ref="A1:B1"/>', '<dimension ref="A1:B9"/>'),
});

test('F7: a reused si: each dependant reads its own master; materialising either group is refused (blocked), nothing written', async () => {
  const bytes = await onSheet3(TWO_MASTERS);
  const { pkg, wb } = load('two-masters.xlsx', bytes);
  const s = await wb.sheet(3);
  assert.strictEqual(s.sharedMastersOf(0).length, 2);
  assert.strictEqual(SF.displayFormula(s, s.cell(2, 1)), 'A3*2', 'B3 from B1');
  assert.strictEqual(SF.displayFormula(s, s.cell(6, 1)), 'A7+100', 'B7 from B6 (its own master, not B1)');
  for (const op of [set(3, [[0, 1, '5']]), set(3, [[5, 1, '=A6']]), set(3, [[5, 1, '']]), { op: 'clearCells', sheetId: 3, range: [0, 1, 0, 1] },
    { op: 'clearCells', sheetId: 3, range: [4, 0, 6, 1] }, set(3, [[8, 0, 'x'], [0, 1, '1']])]) {
    const res = await run(wb, pkg, op);
    assert.strictEqual(res.ok, false, JSON.stringify(op));
    assert.strictEqual(res.error.code, 'blocked');
    assert.match(res.error.message, /group 0 on this sheet has 2 master cells \(B1, B6\)/);
  }
  const b = new EditBuilder(pkg, 'x');
  assert.throws(() => SF.materialiseAll(b, s), (e) => e.officeError?.code === 'blocked');
  b.abort();
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'unchanged');
  await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), 'after the refusals');
  // A dependant itself can still be overwritten (no materialisation needed).
  const dep = await run(wb, pkg, set(3, [[6, 1, '9']]));
  assert.ok(dep.ok && dep.edit);
  assert.ok(pkg.text(SHEET3).includes('<c r="B7"><v>9</v></c>'));
});

test('F7: a member outside its master\'s ref is refused (blocked); a dependant no master covers shows no formula', async () => {
  const outside = '<sheetData>'
    + '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>2</v></c></row>'
    + '<row r="2"><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>'
    + '<row r="5"><c r="B5"><f t="shared" si="0"/><v>10</v></c></row>'
    + '</sheetData>';
  const bytes = await onSheet3(outside);
  const { pkg, wb } = load('outside.xlsx', bytes);
  const s = await wb.sheet(3);
  assert.strictEqual(SF.displayFormula(s, s.cell(1, 1)), 'A2*2');
  assert.strictEqual(SF.displayFormula(s, s.cell(4, 1)), undefined, 'B5 is outside B1:B2');
  const res = await run(wb, pkg, set(3, [[0, 1, '5']]));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'blocked');
  assert.match(res.error.message, /B5 lies outside its group's range B1:B2/);
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'unchanged');
});

test('materialiseAll rewrites every group in one undoable edit; orphan dependants are refused', async () => {
  const bytes = await synthetic();
  const { pkg, wb } = load('syn.xlsx', bytes);
  const s = await wb.sheet(3);
  const b = new EditBuilder(pkg, 'Materialise');
  SF.materialiseAll(b, s);
  const edit = b.finish();
  const text = pkg.text(SHEET3);
  assert.ok(!/t="shared"/.test(text));
  for (const [ref, want] of Object.entries(SYN_EXPECTED)) assert.match(cellXml(text, ref), new RegExp(`<f>${esc(want).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</f>`), ref);
  assertFormulasSound(text);
  assertG5(pkg, edit, bytes);

  // A dependant whose master is missing: refuse rather than guess, nothing written.
  const orphan = await patched('formulas.xlsx', { [SHEET1]: (t) => t.replace('<f t="shared" ref="B2:B10" si="0">A2*2</f>', '<f>A2*2</f>') });
  const o = load('orphan.xlsx', orphan);
  const os = await o.wb.sheet(1);
  const ob = new EditBuilder(o.pkg, 'x');
  assert.throws(() => { SF.materialiseAll(ob, os); }, (e) => e.officeError?.code === 'blocked');
  ob.abort();
  assertBytesEqual(o.pkg.serialize(), orphan, 'unchanged');
});

test('committing the unchanged seed is a no-op: own formulas, _xlfn formulas, shared masters and dependants', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const s = await wb.sheet(1);
  const styles = core.xlsx.ops.stylesFor(wb);
  const cells = [];
  for (const [r, c] of [[1, 1], [1, 2], [1, 3], [1, 5], [2, 5], [4, 5], [5, 5], [6, 5]]) cells.push([r, c, editSeed(s.cell(r, c), styles, false)]);
  for (const r of [2, 5, 9]) cells.push([r, 1, '=' + SF.displayFormula(s, s.cell(r, 1))]);   // dependants, materialised seed
  const res = await run(wb, pkg, set(1, cells));
  assert.deepStrictEqual({ ok: res.ok, edit: res.edit }, { ok: true, edit: null }, JSON.stringify(res));
  // The file form typed back in is the same formula, too.
  const res2 = await run(wb, pkg, set(1, [[1, 5, '=_xlfn.CONCAT("a",A2)'], [3, 1, '=A4*2']]));
  assert.deepStrictEqual({ ok: res2.ok, edit: res2.edit }, { ok: true, edit: null });
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  // setFormula directly records nothing for an unchanged formula.
  const b = new EditBuilder(pkg, 'x');
  assert.strictEqual(SF.setFormula(b, s, 1, 5, 'CONCAT("a",A2)'), null);
  assert.strictEqual(b.size, 0);
  b.abort();
});

test('formula entry refuses read-only cells (array members) and keeps G5 on NoCache and prefixed namespaces', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const arr = await run(wb, pkg, set(1, [[2, 4, '=1']]));
  assert.strictEqual(arr.error.code, 'read-only');
  const arrMaster = await run(wb, pkg, set(1, [[1, 4, '=1']]));
  assert.strictEqual(arrMaster.error.code, 'read-only');
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');

  const nc = await run(wb, pkg, set(4, [[0, 0, '=2+2'], [5, 0, '=SUM(Data!A2:A10)']]));
  assert.ok(nc.ok && nc.edit);
  const after = save(pkg);
  const text = partText(after, 'xl/worksheets/sheet4.xml');
  assert.ok(text.includes('<c r="A1"><f>2+2</f></c>'));
  assert.ok(text.includes('<row r="6"><c r="A6"><f>SUM(Data!A2:A10)</f></c></row>'));
  assertG5(pkg, nc.edit, bytes);
  writeOut(OUT, 'nocache.xlsx', after);

  const p = load('prefixed-namespaces.xlsx');
  const pr = await run(p.wb, p.pkg, set(p.wb.sheets[0].id, [[0, 0, '=XLOOKUP(1,B:B,C:C)']]));
  assert.ok(pr.ok && pr.edit, JSON.stringify(pr));
  const pText = p.pkg.text(p.wb.sheets[0].part);
  assert.match(pText, /<x:c r="A1"[^>]*><x:f>_xlfn\.XLOOKUP\(1,B:B,C:C\)<\/x:f><\/x:c>/);
  assertG5(p.pkg, pr.edit, p.bytes);
  const pa = save(p.pkg);
  writeOut(OUT, 'prefixed-namespaces.xlsx', pa);
  // ExcelJS cannot read prefixed SpreadsheetML at all; re-read with the core reader instead.
  const re = await Workbook.load(OfficePackage.open('x.xlsx', pa)).sheet(p.wb.sheets[0].id);
  assert.strictEqual(re.cell(0, 0).formula, '_xlfn.XLOOKUP(1,B:B,C:C)');
});

// ---------------------------------------------------------------------------------------------
// Seeded random mix of value and formula edits with undo/redo (G5)

const POOL = ['', '1', '-2.5', 'TRUE', 'text', "'=quoted", '2024-03-15', '=1+1', '=A2*3', '=SUM(A1:A3)', '=XLOOKUP(1,A:A,B:B)',
  '=LET(x,A1,x*2)', '=CONCAT("a",B2)', "='My Sheet'!A1+1", '=SUM(', '==A1', '=A1#', '=IF(A1>1,"x&y","<z>")', '=FILTER(A1:A3,A1:A3>0)'];

/** Formulas the contextual checks refuse, mixed into multi-cell pastes after good values (Gate R2 F1/F2). */
const BAD = ['=IF(', '=ROUND(1.5)', '=NoSuch!A1', '=Table9[Col]', '=[1]Sheet1!A1', '=A1,B1', '=1e999'];

async function randomRun(name, bytes, seed, withRefresh) {
  const { pkg, wb } = load(name, bytes);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const sheetIds = wb.sheets.filter((s) => s.kind === 'worksheet').map((s) => s.id);
  const done = [];
  const undone = [];
  let applied = 0, undos = 0, refused = 0, materialised = 0;
  for (let i = 0; i < 200; i++) {
    const x = rand();
    if (x < 0.15 && done.length) {
      const e = done.pop();
      applyEdit(pkg, invertEdit(e));
      if (withRefresh) refreshAfterEdit(wb, e);
      undone.push(e); undos++;
      if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `undo ${i}`, [0, 0, 15, 9]);
      continue;
    }
    if (x < 0.22 && undone.length) {
      const e = undone.pop();
      applyEdit(pkg, e);
      if (withRefresh) refreshAfterEdit(wb, e);
      done.push(e);
      if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `redo ${i}`, [0, 0, 15, 9]);
      continue;
    }
    let sheetId = pick(sheetIds);
    let op;
    // One op in ten aims at a shared-formula master (where materialisation happens), if any is left.
    const masterRefs = rand() < 0.1 ? sheetIds.flatMap((sid) => [...pkg.text(wb.entry(sid).part).matchAll(/<c r="([A-Z]+\d+)"[^>]*><f t="shared" ref=/g)].map((m) => [sid, m[1]])) : [];
    if (masterRefs.length) {
      const [sid, ref] = pick(masterRefs);
      sheetId = sid;
      const [r, c] = core.xlsx.sheet.a1ToRc(ref);
      op = rand() < 0.3 ? { op: 'clearCells', sheetId, range: [r, c, r, c] } : set(sheetId, [[r, c, pick(POOL)]]);
    } else if (rand() < 0.15) {
      const r0 = Math.floor(rand() * 10), c0 = Math.floor(rand() * 6);
      op = { op: 'clearCells', sheetId, range: [r0, c0, r0 + Math.floor(rand() * 3), c0 + Math.floor(rand() * 2)] };
    } else {
      const n = 1 + Math.floor(rand() * 3);
      const cells = new Map();
      for (let k = 0; k < n; k++) cells.set(`${Math.floor(rand() * 12)},${Math.floor(rand() * 7)}`, pick(POOL));
      const list = [...cells].map(([rc, input]) => [...rc.split(',').map(Number), input]);
      if (list.length > 1 && rand() < 0.2) list[list.length - 1][2] = pick(BAD);
      op = set(sheetId, list);
    }
    const beforeText = pkg.text(wb.entry(sheetId).part);
    const res = await run(wb, pkg, op);
    if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `step ${i}`, [0, 0, 15, 9]);
    if (!res.ok) {
      refused++;
      assert.strictEqual(pkg.text(wb.entry(sheetId).part), beforeText, 'a refused op changes nothing');
      continue;
    }
    if (res.edit) {
      done.push(res.edit); undone.length = 0; applied++;
      const masters = (t) => (t.match(/<f t="shared" ref="/g) ?? []).length;
      if (masters(pkg.text(wb.entry(sheetId).part)) < masters(beforeText)) materialised++;
    }
    for (const sid of sheetIds) assertFormulasSound(pkg.text(wb.entry(sid).part), `step ${i}`);
    if (i % 25 === 0) save(pkg);
  }
  const final = save(pkg);
  writeOut(OUT, `random-${seed}-${name}`, final);
  await excel(final);
  while (done.length) applyEdit(pkg, invertEdit(done.pop()));
  assertBytesEqual(pkg.serialize(), bytes, `${name}: full undo`);
  assert.ok(applied >= 60 && undos >= 15 && refused > 0, `exercised: ${applied} edits, ${undos} undos, ${refused} refusals`);
  return { materialised };
}

test('seeded 200-op random value/formula sequence on formulas.xlsx: every group keeps its master; full undo is byte-identical', async () => {
  const { materialised } = await randomRun('formulas.xlsx', fixture('formulas.xlsx'), 21, true);
  assert.ok(materialised >= 1, `materialised ${materialised} times`);
});

test('seeded 200-op random value/formula sequence on the synthetic shared groups (no refresh: stale-index recovery)', async () => {
  const { materialised } = await randomRun('syn.xlsx', await synthetic(), 5, false);
  assert.ok(materialised >= 1, `materialised ${materialised} times`);
});
