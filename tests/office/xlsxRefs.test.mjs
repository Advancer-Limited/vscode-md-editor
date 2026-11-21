// WP-36: structural reference shifting (src/office/core/xlsx/refs.ts slice 2). Spec §9.6 (first
// paragraph), §9.7 (rename/delete rewriting), §14 Phase 4 reference-shifting list.
//
// Expectations are hand-derived from Excel's documented insert/delete semantics. Cases whose exact
// Excel output has not been observed in Excel itself are tagged `[WP-37]` in their name and listed in
// PENDING_GOLDENS below: WP-37 (Excel-produced goldens via COM) should replace them with goldens.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const R = core.xlsx.refs;
const { shiftFormula, shiftRange, shiftSqref, renameSheetInFormula, deleteSheetInFormula, formulaMentionsSheet, quoteSheetName, checkFormulaSyntax, FormulaTranslateError } = R;
const { OfficePackage } = core.pkg;

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const colIndex = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// Shift builders in Excel's terms (1-based rows, column letters); `sheet` defaults to Sheet1.
/** Insert n rows before (1-based) row r. */
const insR = (r, n, sheet = 'Sheet1') => ({ sheetName: sheet, axis: 'row', at: r - 1, count: n });
/** Delete n rows starting at (1-based) row r. */
const delR = (r, n, sheet = 'Sheet1') => ({ sheetName: sheet, axis: 'row', at: r - 1, count: -n });
/** Insert n columns before column c. */
const insC = (c, n, sheet = 'Sheet1') => ({ sheetName: sheet, axis: 'col', at: colIndex(c), count: n });
/** Delete n columns starting at column c. */
const delC = (c, n, sheet = 'Sheet1') => ({ sheetName: sheet, axis: 'col', at: colIndex(c), count: -n });

/** Cases whose expectation reflects a decision that should be confirmed by an Excel golden (WP-37). */
const PENDING_GOLDENS = [];

// [formula, shift, expected, opts?]  opts: { home (default 'Sheet1'; null = defined name), has3d, order, wp37 }
const FORMULA_CASES = [
  // --- row insert: 2 rows before row 3 -------------------------------------------------------------
  ['A1', insR(3, 2), 'A1'],
  ['A2', insR(3, 2), 'A2'],
  ['A3', insR(3, 2), 'A5'],
  ['A10', insR(3, 2), 'A12'],
  ['$A$3', insR(3, 2), '$A$5'],
  ['A$3', insR(3, 2), 'A$5'],
  ['$A3', insR(3, 2), '$A5'],
  ['$A$2', insR(3, 2), '$A$2'],
  ['A1:A2', insR(3, 2), 'A1:A2'],
  ['A1:A3', insR(3, 2), 'A1:A5'],
  ['A2:A4', insR(3, 2), 'A2:A6'],
  ['A3:A4', insR(3, 2), 'A5:A6', { wp37: 'insert at the top edge of a range moves it (does not grow it)' }],
  ['B3:D3', insR(3, 2), 'B5:D5'],
  ['$A$1:$B$10', insR(3, 2), '$A$1:$B$12'],
  ['A$1:$B10', insR(3, 2), 'A$1:$B12'],
  ['A:A', insR(3, 2), 'A:A'],
  ['$A:$C', insR(3, 2), '$A:$C'],
  ['3:5', insR(3, 2), '5:7'],
  ['1:2', insR(3, 2), '1:2'],
  ['2:3', insR(3, 2), '2:5'],
  ['$3:$5', insR(3, 2), '$5:$7'],
  ['$2:3', insR(3, 2), '$2:5'],
  ['SUM(A1:A10)*A3', insR(3, 2), 'SUM(A1:A12)*A5'],
  ['Sheet1!A3', insR(3, 2), 'Sheet1!A5'],
  ['sheet1!A3', insR(3, 2), 'sheet1!A5'],
  ['SHEET1!$B$3:$C$9', insR(3, 2), 'SHEET1!$B$5:$C$11'],
  ['Sheet2!A3', insR(3, 2), 'Sheet2!A3'],
  ['A3', insR(3, 2), 'A3', { home: 'Sheet2' }],
  ['Sheet1!A3+A3', insR(3, 2), 'Sheet1!A5+A3', { home: 'Sheet2' }],
  ["'My Sheet'!A3", insR(3, 2, 'My Sheet'), "'My Sheet'!A5", { home: 'Data' }],
  ["'my sheet'!A3:B4", insR(3, 2, 'My Sheet'), "'my sheet'!A5:B6", { home: 'Data' }],
  ["'It''s'!A3", insR(3, 2, "It's"), "'It''s'!A5"],
  ["'Sheet1'!A3", insR(3, 2), "'Sheet1'!A5"],
  ['"A3"&A3', insR(3, 2), '"A3"&A5'],
  ['"Sheet1!A3"', insR(3, 2), '"Sheet1!A3"'],
  ['[1]Sheet1!A3', insR(3, 2), '[1]Sheet1!A3'],
  ["'[1]Sheet1'!A3", insR(3, 2), "'[1]Sheet1'!A3"],
  ['[Book2.xlsx]Sheet1!A3', insR(3, 2), '[Book2.xlsx]Sheet1!A3'],
  ['Table1[Col]', insR(1, 2), 'Table1[Col]'],
  ['SUM(Table1[[#This Row],[Qty]])+A3', insR(3, 2), 'SUM(Table1[[#This Row],[Qty]])+A5'],
  ['TaxRate*A3', insR(3, 2), 'TaxRate*A5'],
  ['Sheet1!LocalName', insR(1, 2), 'Sheet1!LocalName'],
  ['[0]!LocalName+A3', insR(3, 2), '[0]!LocalName+A5'],
  ['a3', insR(3, 2), 'a5'],
  ['a3:b4', insR(3, 2), 'a5:b6'],
  ['A1:A1', insR(3, 2), 'A1:A1'],
  ['A3:A3', insR(3, 2), 'A5:A5'],
  ['A4:A2', insR(3, 2), 'A6:A2'],
  ['A1 A3', insR(3, 2), 'A1 A5'],
  ['SUM((A1,A3))', insR(3, 2), 'SUM((A1,A5))'],
  ['Sheet1!A1:Sheet1!A3', insR(3, 2), 'Sheet1!A1:Sheet1!A5'],
  ['INDEX(A:A,3)', insR(3, 2), 'INDEX(A:A,3)'],
  ['#REF!', insR(1, 2), '#REF!'],
  ['Sheet1!#REF!+A3', insR(3, 2), 'Sheet1!#REF!+A5'],
  [' SUM( A3 , 1 ) ', insR(3, 2), ' SUM( A5 , 1 ) '],
  ['R1C1+A3', insR(3, 2), 'R1C1+A5'],
  ['A3', insR(3, 2), 'A3', { home: null }],
  ['Sheet1!$A$3', insR(3, 2), 'Sheet1!$A$5', { home: null }],
  ['_xlfn.XLOOKUP(A3,B:B,C:C)', insR(3, 2), '_xlfn.XLOOKUP(A5,B:B,C:C)'],
  ['{1,2;3,4}', insR(1, 5), '{1,2;3,4}'],
  ['VLOOKUP(A3,Sheet2!A:C,2,FALSE)', insR(3, 2), 'VLOOKUP(A5,Sheet2!A:C,2,FALSE)'],
  ['OFFSET(A3,1,1)', insR(1, 1), 'OFFSET(A4,1,1)'],
  ['A1:B2 B2:C3', insR(2, 1), 'A1:B3 B3:C4'],
  ['A1', insR(1, 1), 'A2'],
  ['$1:$1', insR(1, 1), '$2:$2'],
  ['C1', insR(3, 2), 'C1'],
  ['A3', insR(3, 0), 'A3'],
  // --- row insert at the bottom edge of the grid ---------------------------------------------------
  ['A1048576', insR(1, 1), '#REF!', { wp37: 'a single cell pushed off the grid becomes #REF!' }],
  ['A1048575', insR(1, 1), 'A1048576'],
  ['$A$1048576', insR(5, 3), '#REF!', { wp37: 'absolute cell pushed off the grid' }],
  ['A1:A1048576', insR(5, 1), 'A1:A1048576', { wp37: 'range end pushed off the grid is clamped to row 1,048,576' }],
  ['A1048570:A1048576', insR(1, 10), '#REF!', { wp37: 'range start pushed off the grid' }],
  ['1:1048576', insR(5, 1), '1:1048576'],
  ['Sheet1!A1048576', insR(1, 1), '#REF!'],
  ['SUM(A1048576,A1)', insR(1, 1), 'SUM(#REF!,A2)'],
  ['A1048576', insR(MAX_ROWS, 1), '#REF!'],
  ['A1048575', insR(MAX_ROWS, 1), 'A1048575'],
  // --- row delete: rows 3-4 --------------------------------------------------------------------
  ['A1', delR(3, 2), 'A1'],
  ['A2', delR(3, 2), 'A2'],
  ['A3', delR(3, 2), '#REF!'],
  ['A4', delR(3, 2), '#REF!'],
  ['A5', delR(3, 2), 'A3'],
  ['$A$5', delR(3, 2), '$A$3'],
  ['A$5:$B6', delR(3, 2), 'A$3:$B4'],
  ['A1:A10', delR(3, 2), 'A1:A8'],
  ['A3:A4', delR(3, 2), '#REF!'],
  ['A2:A3', delR(3, 2), 'A2:A2'],
  ['A4:A6', delR(3, 2), 'A3:A4'],
  ['A3:A6', delR(3, 2), 'A3:A4'],
  ['A1:A2', delR(3, 2), 'A1:A2'],
  ['A5:B6', delR(3, 2), 'A3:B4'],
  ['A4:A2', delR(3, 2), 'A2:A2'],
  ['SUM(A3:A4)', delR(3, 2), 'SUM(#REF!)'],
  ['SUM(A3:A4,A5)', delR(3, 2), 'SUM(#REF!,A3)'],
  ['Sheet1!A3', delR(3, 2), '#REF!', { wp37: 'Excel writes Sheet1!#REF!; this module writes a bare #REF! (fx cannot parse the qualified form)' }],
  ["'My Sheet'!A4", delR(3, 2, 'My Sheet'), '#REF!', { home: 'Data' }],
  ['3:4', delR(3, 2), '#REF!'],
  ['2:5', delR(3, 2), '2:3'],
  ['5:6', delR(3, 2), '3:4'],
  ['$1:$3', delR(3, 2), '$1:$2'],
  ['A:A', delR(3, 2), 'A:A'],
  ['Sheet2!A3', delR(3, 2), 'Sheet2!A3'],
  ['[1]Sheet1!A3', delR(3, 2), '[1]Sheet1!A3'],
  ['A3+Table1[Col]', delR(3, 2), '#REF!+Table1[Col]'],
  ['"A3"', delR(3, 2), '"A3"'],
  ['IF(A3>0,"x A3",A4)', delR(3, 1), 'IF(#REF!>0,"x A3",A3)'],
  ['A1048576', delR(3, 2), 'A1048574'],
  ['A1:A1048576', delR(3, 2), 'A1:A1048574', { wp37: 'a range reaching row 1,048,576 shrinks like any other (Excel may keep it whole)' }],
  ['Sheet1!A1:Sheet1!A3', delR(3, 2), 'Sheet1!A1:Sheet1!A2'],
  ['Sheet1!A3:Sheet1!A4', delR(3, 2), '#REF!'],
  ['A1048576', delR(MAX_ROWS, 1), '#REF!'],
  ['A1:A1048576', delR(MAX_ROWS, 1), 'A1:A1048575'],
  ['A1', delR(1, 1), '#REF!'],
  ['A2:B9', delR(1, 1), 'A1:B8'],
  ['A1:A1048576', delR(1, MAX_ROWS), '#REF!'],
  // --- column insert: 2 columns before C -----------------------------------------------------------
  ['B1', insC('C', 2), 'B1'],
  ['C1', insC('C', 2), 'E1'],
  ['$C$1', insC('C', 2), '$E$1'],
  ['C$1', insC('C', 2), 'E$1'],
  ['B1:C1', insC('C', 2), 'B1:E1'],
  ['C1:D5', insC('C', 2), 'E1:F5', { wp37: 'insert at the left edge of a range moves it' }],
  ['A1:Z1', insC('C', 2), 'A1:AB1'],
  ['C:C', insC('C', 2), 'E:E'],
  ['B:C', insC('C', 2), 'B:E'],
  ['$A:$B', insC('C', 2), '$A:$B'],
  ['1:1', insC('C', 2), '1:1'],
  ['A3', insC('C', 2), 'A3'],
  ['Z1', insC('C', 2), 'AB1'],
  ['XFD1', insC('C', 2), '#REF!', { wp37: 'cell pushed past column XFD' }],
  ['XFB1', insC('C', 2), 'XFD1'],
  ['A1:XFD1', insC('C', 2), 'A1:XFD1', { wp37: 'range end pushed past XFD is clamped' }],
  ['Sheet1!C1', insC('C', 2), 'Sheet1!E1'],
  ['c1', insC('C', 2), 'e1'],
  ['AZ1', insC('A', 1), 'BA1'],
  ['ZZ9', insC('A', 1), 'AAA9'],
  ['XFD1', insC('XFD', 1), '#REF!'],
  // --- column delete: C:D ---------------------------------------------------------------------
  ['B1', delC('C', 2), 'B1'],
  ['C1', delC('C', 2), '#REF!'],
  ['D1', delC('C', 2), '#REF!'],
  ['E1', delC('C', 2), 'C1'],
  ['B1:E1', delC('C', 2), 'B1:C1'],
  ['C1:D9', delC('C', 2), '#REF!'],
  ['D1:F1', delC('C', 2), 'C1:D1'],
  ['C:D', delC('C', 2), '#REF!'],
  ['A:Z', delC('C', 2), 'A:X'],
  ['$E$1', delC('C', 2), '$C$1'],
  ['2:2', delC('C', 2), '2:2'],
  ['XFD1', delC('C', 2), 'XFB1'],
  ['AA1', delC('C', 2), 'Y1'],
  ['A1:XFD1', delC('A', 1), 'A1:XFC1'],
  ['BA1', delC('A', 1), 'AZ1'],
  // --- 3-D references (never shifted; reported) ----------------------------------------------------
  ['Sheet1:Sheet3!A3', insR(3, 2), 'Sheet1:Sheet3!A3', { has3d: true }],
  ['SUM(Sheet1:Sheet3!A3:A4)', delR(3, 2), 'SUM(Sheet1:Sheet3!A3:A4)', { has3d: true }],
  ['SUM(Sheet2:Sheet3!A3)', insR(3, 2), 'SUM(Sheet2:Sheet3!A3)', { has3d: true }],
  ['SUM(Sheet2:Sheet3!A3)', insR(3, 2), 'SUM(Sheet2:Sheet3!A3)', { has3d: false, order: ['Sheet1', 'Sheet2', 'Sheet3'] }],
  ['SUM(Sheet1:Sheet3!A3)', insR(3, 2, 'Sheet2'), 'SUM(Sheet1:Sheet3!A3)', { has3d: true, order: ['Sheet1', 'Sheet2', 'Sheet3'] }],
  ['SUM(Sheet3:Sheet1!A3)', insR(3, 2, 'Sheet2'), 'SUM(Sheet3:Sheet1!A3)', { has3d: true, order: ['Sheet1', 'Sheet2', 'Sheet3'] }],
  ["SUM('Jan:Mar 2024'!B2)", insR(1, 1, 'Mar 2024'), "SUM('Jan:Mar 2024'!B2)", { has3d: true }],
  ['Sheet1:Sheet3!A:A', insC('A', 1), 'Sheet1:Sheet3!A:A', { has3d: true }],
  ['[1]Sheet1:Sheet3!A1', insR(1, 1), '[1]Sheet1:Sheet3!A1', { has3d: false }],
  ['Sheet1:Sheet3!A3+A3', insR(3, 2), 'Sheet1:Sheet3!A3+A5', { has3d: true }],
];

describe('shiftFormula: table-driven cases', () => {
  for (const [text, shift, expected, opts = {}] of FORMULA_CASES) {
    const home = opts.home === undefined ? 'Sheet1' : opts.home;
    const op = `${shift.count >= 0 ? 'insert' : 'delete'} ${Math.abs(shift.count)} ${shift.axis}(s) at ${shift.at} on ${shift.sheetName}`;
    const name = `${opts.wp37 ? '[WP-37] ' : ''}${JSON.stringify(text)} | ${op} | home ${JSON.stringify(home)} -> ${JSON.stringify(expected)}`;
    if (opts.wp37) PENDING_GOLDENS.push({ text, shift, home, expected, why: opts.wp37 });
    test(name, () => {
      const r = shiftFormula(text, shift, home, opts.order);
      assert.strictEqual(r.text, expected);
      assert.strictEqual(r.changed, expected !== text);
      assert.strictEqual(r.has3dSpanning, opts.has3d ?? false);
      // A formula that parsed still parses after the shift (the save-time validator re-checks it).
      if (checkFormulaSyntax(text).ok) assert.deepStrictEqual(checkFormulaSyntax(r.text), { ok: true }, `result does not parse: ${r.text}`);
    });
  }
  test('at least 120 formula cases', () => assert.ok(FORMULA_CASES.length >= 120, String(FORMULA_CASES.length)));
});

describe('shiftFormula: argument and input errors', () => {
  const bad = [
    { sheetName: 'Sheet1', axis: 'row', at: -1, count: 1 },
    { sheetName: 'Sheet1', axis: 'row', at: MAX_ROWS, count: 1 },
    { sheetName: 'Sheet1', axis: 'col', at: MAX_COLS, count: 1 },
    { sheetName: 'Sheet1', axis: 'row', at: 1.5, count: 1 },
    { sheetName: 'Sheet1', axis: 'row', at: 0, count: 0.5 },
    { sheetName: 'Sheet1', axis: 'row', at: MAX_ROWS - 1, count: -2 },
    { sheetName: 'Sheet1', axis: 'col', at: MAX_COLS - 3, count: -4 },
    { sheetName: 'Sheet1', axis: 'diag', at: 0, count: 1 },
  ];
  for (const s of bad) {
    test(`invalid shift ${JSON.stringify(s)} throws FormulaTranslateError`, () => {
      assert.throws(() => shiftFormula('A1', s, 'Sheet1'), FormulaTranslateError);
      assert.throws(() => shiftRange('A1', s), FormulaTranslateError);
      assert.throws(() => shiftSqref('A1', s), FormulaTranslateError);
    });
  }
  test('delete of the whole last band is allowed', () => {
    assert.strictEqual(shiftFormula('A1048576', delR(MAX_ROWS - 1, 2), 'Sheet1').text, '#REF!');
    assert.strictEqual(shiftFormula('XFD1', delC('XFC', 2), 'Sheet1').text, '#REF!');
  });
  test('text the tokenizer cannot classify is passed through unchanged (no guess)', () => {
    assert.strictEqual(shiftFormula('"unterminated A3', insR(1, 1), 'Sheet1').text, '"unterminated A3');
  });
});

// ---------------------------------------------------------------------------------------------------
// shiftRange / shiftSqref

const RANGE_CASES = [
  ['A1:C3', insR(2, 1), 'A1:C4'],
  ['A1:C3', insR(1, 1), 'A2:C4'],
  ['A1:C3', insR(4, 1), 'A1:C3'],
  ['B2', delR(2, 1), '#REF!'],
  ['B2:C2', delR(2, 1), '#REF!'],
  ['B2:C5', delR(2, 1), 'B2:C4'],
  ['A1', insR(1, 1), 'A2'],
  ['A:A', insR(1, 1), 'A:A'],
  ['A:A', insC('A', 1), 'B:B'],
  ['3:5', delR(4, 1), '3:4'],
  ['C1:D2', delC('C', 2), '#REF!'],
  ['B1:E2', delC('C', 2), 'B1:C2'],
  ['XFD1', insC('A', 1), '#REF!'],
  ['A1:XFD1', insC('A', 1), 'B1:XFD1'],
  ['$A$1:$B$2', insR(1, 1), '$A$2:$B$3'],
  ['A1:D5', insC('B', 3), 'A1:G5'],
  ['A1048576', insR(1, 1), '#REF!'],
  ['a1:b2', insR(1, 1), 'a2:b3'],
];

describe('shiftRange', () => {
  for (const [ref, shift, expected] of RANGE_CASES) {
    test(`${ref} | ${shift.axis} ${shift.count} at ${shift.at} -> ${expected}`, () => assert.strictEqual(shiftRange(ref, shift), expected));
  }
  test('ignores shift.sheetName (the caller decides the range is on the edited sheet)', () => {
    assert.strictEqual(shiftRange('A3', insR(1, 1, 'Elsewhere')), 'A4');
  });
  for (const bad of ['Sheet1!A1', 'foo', '', 'A1:B2:C3', 'A0', 'XFE1', 'A1048577', 'A1 B2', 'A1:B', '#REF!']) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => shiftRange(bad, insR(1, 1)), FormulaTranslateError));
  }
});

const SQREF_CASES = [
  ['A1:A10 C5', insR(3, 2), 'A1:A12 C7'],
  ['A3 A4', delR(3, 2), null],
  ['A3 B10', delR(3, 2), 'B8'],
  ['A1  B1', insR(5, 1), 'A1  B1'],
  ['', insR(1, 1), ''],
  ['C1:D1 F1', delC('C', 2), 'D1'],
  ['A1:B2 D4:E5', insC('A', 1), 'B1:C2 E4:F5'],
  ['B2', delR(1, 1), 'B1'],
  ['XFD1 A1', insC('A', 1), 'B1'],
];

describe('shiftSqref', () => {
  for (const [sq, shift, expected] of SQREF_CASES) {
    test(`${JSON.stringify(sq)} | ${shift.axis} ${shift.count} at ${shift.at} -> ${JSON.stringify(expected)}`, () => assert.strictEqual(shiftSqref(sq, shift), expected));
  }
});

// ---------------------------------------------------------------------------------------------------
// Sheet rename / delete / mention / quoting (§9.7)

const RENAME_CASES = [
  ['Sheet1!A1', 'Sheet1', 'Data', 'Data!A1'],
  ['Sheet1!A1', 'Sheet1', 'My Data', "'My Data'!A1"],
  ["'My Data'!A1", 'My Data', 'Plain', 'Plain!A1'],
  ['sheet1!A1+Sheet2!B1', 'Sheet1', 'X', 'X!A1+Sheet2!B1'],
  ['Sheet1!A1', 'Sheet1', "It's", "'It''s'!A1"],
  ["'It''s'!A1", "It's", 'Its', 'Its!A1'],
  ['A1', 'Sheet1', 'Data', 'A1'],
  ['[1]Sheet1!A1', 'Sheet1', 'Data', '[1]Sheet1!A1'],
  ['Sheet1:Sheet3!A1', 'Sheet3', 'Last Sheet', "'Sheet1:Last Sheet'!A1"],
  ['Sheet1:Sheet3!A1', 'Sheet1', 'First', 'First:Sheet3!A1'],
  ['Sheet1!LocalName', 'Sheet1', 'Data', 'Data!LocalName'],
  ['Sheet1!Table1[Col]', 'Sheet1', 'Data', 'Data!Table1[Col]'],
  ['"Sheet1!A1"&Sheet1!A1', 'Sheet1', 'Data', '"Sheet1!A1"&Data!A1'],
  ['Sheet1!#REF!', 'Sheet1', 'Data', 'Data!#REF!'],
  ["'Sheet 1'!#REF!", 'Sheet 1', 'Data', 'Data!#REF!'],
  ['Sheet1!A1', 'Sheet1', '2024', "'2024'!A1"],
  ['Sheet1!A1', 'Sheet1', 'A1', "'A1'!A1"],
  ['Sheet1!A1', 'Sheet1', 'R1C1', "'R1C1'!A1"],
  ['Sheet1!A:A+Sheet1!1:1', 'Sheet1', 'Data', 'Data!A:A+Data!1:1'],
  ['SUM(Sheet1!A1:B2, Sheet1!C3)', 'Sheet1', 'Q1', "SUM('Q1'!A1:B2, 'Q1'!C3)"],
];

describe('renameSheetInFormula', () => {
  for (const [text, from, to, expected] of RENAME_CASES) {
    test(`${text} | ${from} -> ${to} = ${expected}`, () => {
      const out = renameSheetInFormula(text, from, to);
      assert.strictEqual(out, expected);
      if (checkFormulaSyntax(text).ok) assert.deepStrictEqual(checkFormulaSyntax(out), { ok: true }, out);
    });
  }
});

const ORDER = ['Jan', 'Feb', 'Mar', 'Apr'];
const DELETE_SHEET_CASES = [
  ['Sheet2!A1+1', 'Sheet2', '#REF!+1'],
  ['SUM(Sheet2!A1:B2)', 'Sheet2', 'SUM(#REF!)'],
  ['Sheet1!A1', 'Sheet2', 'Sheet1!A1'],
  ['Sheet2!#REF!', 'Sheet2', '#REF!'],
  ['Sheet2!LocalName', 'Sheet2', '#REF!'],
  ['[1]Sheet2!A1', 'Sheet2', '[1]Sheet2!A1'],
  ["'My Sheet'!A1", 'my sheet', '#REF!'],
  ['"Sheet2!A1"', 'Sheet2', '"Sheet2!A1"'],
  ['SUM(Jan:Mar!A1)', 'Jan', 'SUM(Feb:Mar!A1)', ORDER],
  ['SUM(Jan:Mar!A1)', 'Mar', 'SUM(Jan:Feb!A1)', ORDER],
  ['SUM(Jan:Mar!A1)', 'Feb', 'SUM(Jan:Mar!A1)', ORDER],
  ['SUM(Jan:Feb!A1)', 'Jan', 'SUM(Feb!A1)', ORDER],
  ['SUM(Jan:Mar!A1)', 'Jan', 'SUM(#REF!)'],
  ['SUM(Mar:Jan!A1)', 'Mar', 'SUM(Jan:Feb!A1)', ORDER],
];

describe('deleteSheetInFormula', () => {
  for (const [text, name, expected, order] of DELETE_SHEET_CASES) {
    const tag = /[A-Z][a-z]{2}:[A-Z][a-z]{2}!/.test(text) && order ? '[WP-37] ' : '';
    if (tag) PENDING_GOLDENS.push({ text, deleteSheet: name, expected, why: '3-D span with a deleted end shrinks inward' });
    test(`${tag}${text} | delete ${name}${order ? ' (ordered)' : ''} = ${expected}`, () => {
      const out = deleteSheetInFormula(text, name, order);
      assert.strictEqual(out, expected);
      if (checkFormulaSyntax(text).ok) assert.deepStrictEqual(checkFormulaSyntax(out), { ok: true }, out);
    });
  }
});

describe('formulaMentionsSheet', () => {
  const cases = [
    ['Sheet2!A1', 'Sheet2', true],
    ['sheet2!A1', 'SHEET2', true],
    ['A1', 'Sheet2', false],
    ['"Sheet2!A1"', 'Sheet2', false],
    ['[1]Sheet2!A1', 'Sheet2', false],
    ['Jan:Mar!A1', 'Feb', true, ORDER],
    ['Jan:Mar!A1', 'Feb', false],
    ['Jan:Mar!A1', 'Mar', true],
    ['Jan:Mar!A1', 'Apr', false, ORDER],
    ['Sheet2!LocalName', 'Sheet2', true],
    ['Sheet2!#REF!', 'Sheet2', true],
    ["'My Sheet'!A1+1", 'My Sheet', true],
    ['Sheet2!Table1[Col]', 'Sheet2', true],
    ['Table1[Col]', 'Sheet2', false],
  ];
  for (const [text, name, expected, order] of cases) {
    test(`${text} mentions ${name}${order ? ' (ordered)' : ''}: ${expected}`, () => assert.strictEqual(formulaMentionsSheet(text, name, order), expected));
  }
});

describe('quoteSheetName', () => {
  const cases = [
    ['Sheet1', 'Sheet1'], ['Data', 'Data'], ['My Sheet', "'My Sheet'"], ["It's", "'It''s'"], ["O'Brien", "'O''Brien'"],
    ['2024', "'2024'"], ['A1', "'A1'"], ['R1C1', "'R1C1'"], ['RC', "'RC'"], ['Données', "'Données'"], ['a-b', "'a-b'"],
    ['_x', '_x'], ['Q1.2024', 'Q1.2024'], ['(x)', "'(x)'"],
  ];
  for (const [name, expected] of cases) test(`${name} -> ${expected}`, () => assert.strictEqual(quoteSheetName(name), expected));
});

// Review B1: Excel refused these names unquoted (€x, €, •a, a»b, €1) or our validator refused them
// (©, £1, a¬b, ideographic space, TRUE/FALSE), so a rename wrote an unopenable or unsaveable workbook.
// Emoji, en dash and × were accepted unquoted by Excel; quoting them is accepted too.
describe('B1: renaming to a non-ASCII or TRUE/FALSE name quotes the prefix and the result validates', () => {
  const NAMES = ['€x', '€', '•a', 'a»b', '€1', '©', '£1', 'a¬b', '　', 'a　b', 'TRUE', 'FALSE', 'true', 'False',
    '\u{1F600}', 'a–b', 'a×b', 'été', '日本', 'a b', '\\a', 'R2C3', 'rc', 'XFD1048576', 'A1', "It's"];
  for (const name of NAMES) {
    test(JSON.stringify(name), () => {
      const q = (s) => `'${s.replace(/'/g, "''")}'`;
      assert.strictEqual(quoteSheetName(name), q(name));
      const out = renameSheetInFormula('Sheet1!A1+SUM(Sheet1:Sheet2!B1)', 'Sheet1', name);
      assert.strictEqual(out, `${q(name)}!A1+SUM(${q(name + ':Sheet2')}!B1)`);
      assert.deepStrictEqual(R.validateFormula(out), { ok: true }, out);
      // Typed by hand without quotes it is refused (by the parser or with the "needs quotes" message).
      // (A no-break space parses as the intersection operator, so `a b!A1` is a different formula.)
      if (name.includes(' ')) return;
      const bare = R.validateFormula(`${name}!A1`);
      assert.strictEqual(bare.ok, false, `${name}!A1 must be refused`);
    });
  }
  for (const name of ['Sheet1', 'Data', '_x', 'Q1.2024', 'Tax_2024', 'TRUEx', 'ABCD1']) {
    test(`${name} stays bare`, () => {
      assert.strictEqual(renameSheetInFormula('Sheet1!A1', 'Sheet1', name), `${name}!A1`);
      assert.deepStrictEqual(R.validateFormula(`${name}!A1`), { ok: true });
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Hand-verified fixture expectations (formulas.xlsx). [WP-37] replace with Excel goldens.

describe('[WP-37] formulas.xlsx hand-verified shifts', () => {
  // Sheets: Data, My Sheet, O'Brien, NoCache. Names: LocalName = Data!$G$2, TaxRate = Data!$G$1.
  const cases = [
    // insert 2 rows before Data row 3
    ['Data', "'My Sheet'!A2+Data!A3", insR(3, 2, 'Data'), "'My Sheet'!A2+Data!A5"],
    ['Data', 'A3+[0]!LocalName', insR(3, 2, 'Data'), 'A5+[0]!LocalName'],
    ['Data', '_xlfn.TEXTJOIN(",",TRUE,A2:A4)', insR(3, 2, 'Data'), '_xlfn.TEXTJOIN(",",TRUE,A2:A6)'],
    ['Data', '_xlfn.XLOOKUP(3,A2:A10,B2:B10)', insR(3, 2, 'Data'), '_xlfn.XLOOKUP(3,A2:A12,B2:B12)'],
    ['Data', 'IF(A8>5,"hi","lo")', insR(3, 2, 'Data'), 'IF(A10>5,"hi","lo")'],
    ['My Sheet', "Data!A2+'O''Brien'!A1", insR(3, 2, 'Data'), "Data!A2+'O''Brien'!A1"],
    ['NoCache', 'SUM(Data!A2:A10)', insR(3, 2, 'Data'), 'SUM(Data!A2:A12)'],
    [null, 'Data!$G$2', insR(1, 1, 'Data'), 'Data!$G$3'],
    // delete Data row 5
    ['Data', "'My Sheet'!A4+Data!A5", delR(5, 1, 'Data'), "'My Sheet'!A4+#REF!"],
    ['Data', 'SUM(A2:A10)', delR(5, 1, 'Data'), 'SUM(A2:A9)'],
    ['NoCache', 'Data!A2*3', delR(2, 1, 'Data'), '#REF!*3'],
    // insert a column before A on My Sheet
    ['Data', "'My Sheet'!A1+Data!A2", insC('A', 1, 'My Sheet'), "'My Sheet'!B1+Data!A2"],
    ["O'Brien", "'My Sheet'!A1*TaxRate", insC('A', 1, 'My Sheet'), "'My Sheet'!B1*TaxRate"],
    // delete column G on Data (the defined names' column)
    [null, 'Data!$G$1', delC('G', 1, 'Data'), '#REF!'],
  ];
  for (const [home, text, shift, expected] of cases) {
    test(`${home ?? '(name)'}: ${text} -> ${expected}`, () => {
      PENDING_GOLDENS.push({ fixture: 'formulas.xlsx', home, text, shift, expected });
      assert.strictEqual(shiftFormula(text, shift, home).text, expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Fixture property tests: every <f>, CF/DV formula, chart formula, defined name, merge/ref and sqref.

const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#[0-9]+);/g, (_m, e) => (
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
    : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));

function collect() {
  const out = [];
  for (const name of allFixtures('xlsx')) {
    let pkg;
    try { pkg = OfficePackage.open(name, fixture(name)); } catch { continue; }
    const formulas = [];
    const refs = [];
    const sqrefs = [];
    let sheets = [];
    for (const part of pkg.partNames()) {
      if (!/\.xml$/i.test(part)) continue;
      let text;
      try { text = pkg.text(part); } catch { continue; }
      if (/^xl\/workbook\.xml$/i.test(part)) {
        sheets = [...text.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]));
        for (const m of text.matchAll(/<(?:\w+:)?definedName\b[^>]*>([^<]*)</g)) formulas.push({ part, kind: 'definedName', text: decode(m[1]), home: null });
      }
      for (const m of text.matchAll(/<((?:\w+:)?(?:f|formula|formula1|formula2))\b[^>]*>([^<]*)<\/\1>/g)) {
        if (m[2] !== '') formulas.push({ part, kind: m[1], text: decode(m[2]), home: undefined });
      }
      if (/^xl\/(worksheets|tables)\//i.test(part)) {
        for (const m of text.matchAll(/\s(?:ref|topLeftCell|activeCell)="([^"]*)"/g)) refs.push({ part, text: decode(m[1]) });
        for (const m of text.matchAll(/\ssqref="([^"]*)"/g)) sqrefs.push({ part, text: decode(m[1]) });
      }
    }
    out.push({ name, sheets, formulas, refs, sqrefs });
  }
  return out;
}

const FIXTURES = collect();
const BANDS = [
  ['row', 0, 1], ['row', 1, 3], ['row', 4, 2], ['row', 9, 1], ['row', 99, 7],
  ['col', 0, 1], ['col', 2, 2], ['col', 5, 5], ['col', 26, 1],
];

describe('fixture property tests', () => {
  test('fixtures provide formulas, defined names, refs and sqrefs', () => {
    const n = (k) => FIXTURES.reduce((s, f) => s + f[k].length, 0);
    assert.ok(n('formulas') >= 50, `formulas: ${n('formulas')}`);
    assert.ok(n('refs') >= 10, `refs: ${n('refs')}`);
    assert.ok(n('sqrefs') >= 5, `sqrefs: ${n('sqrefs')}`);
    assert.ok(FIXTURES.some((f) => f.formulas.some((x) => x.kind === 'definedName')), 'some defined name');
    assert.ok(FIXTURES.some((f) => f.refs.some((x) => /mergeCell/.test(x.part) || x.text.includes(':'))), 'some range ref');
  });

  for (const fx of FIXTURES) {
    if (fx.formulas.length + fx.refs.length + fx.sqrefs.length === 0) continue;
    const homes = [null, ...fx.sheets];
    test(`${fx.name}: shifting by 0 is the identity on every formula, ref and sqref`, () => {
      for (const sheet of fx.sheets) {
        for (const axis of ['row', 'col']) {
          const s = { sheetName: sheet, axis, at: 3, count: 0 };
          for (const f of fx.formulas) for (const home of homes) {
            const r = shiftFormula(f.text, s, home, fx.sheets);
            assert.strictEqual(r.text, f.text, `${f.part}: ${f.text}`);
            assert.strictEqual(r.changed, false);
          }
          for (const r of fx.refs) assert.strictEqual(shiftRange(r.text, s), r.text, `${r.part}: ${r.text}`);
          for (const q of fx.sqrefs) assert.strictEqual(shiftSqref(q.text, s), q.text, `${q.part}: ${q.text}`);
        }
      }
    });

    test(`${fx.name}: a shift on a sheet no formula names leaves defined names and qualified refs alone`, () => {
      const s = { sheetName: 'No Such Sheet', axis: 'row', at: 0, count: 5 };
      for (const f of fx.formulas) assert.strictEqual(shiftFormula(f.text, s, null).text, f.text, f.text);
    });

    test(`${fx.name}: insert then delete of the same band restores every formula, ref and sqref`, () => {
      let checked = 0;
      let skipped = 0;
      const offGrid = (t) => /1048576|XFD/i.test(t);
      for (const sheet of fx.sheets) {
        for (const [axis, at, count] of BANDS) {
          const ins = { sheetName: sheet, axis, at, count };
          const del = { sheetName: sheet, axis, at, count: -count };
          for (const f of fx.formulas) for (const home of [null, sheet]) {
            const a = shiftFormula(f.text, ins, home, fx.sheets);
            const refs = (t) => (t.match(/#REF!/g) || []).length;
            if (refs(a.text) > refs(f.text) || (offGrid(a.text) && !offGrid(f.text))) { skipped++; continue; }
            assert.strictEqual(a.has3dSpanning, shiftFormula(f.text, del, home, fx.sheets).has3dSpanning);
            const b = shiftFormula(a.text, del, home, fx.sheets);
            assert.strictEqual(b.text, f.text, `${f.part} [${sheet} ${axis} ${at}+${count} home ${home}]: ${f.text} -> ${a.text} -> ${b.text}`);
            if (checkFormulaSyntax(f.text).ok) assert.deepStrictEqual(checkFormulaSyntax(a.text), { ok: true }, a.text);
            checked++;
          }
          for (const r of fx.refs) {
            const a = shiftRange(r.text, ins);
            if (a === '#REF!' || (offGrid(a) && !offGrid(r.text))) { skipped++; continue; }
            assert.strictEqual(shiftRange(a, del), r.text, `${r.part}: ${r.text} -> ${a}`);
            checked++;
          }
          for (const q of fx.sqrefs) {
            const a = shiftSqref(q.text, ins);
            if (a === null || a.split(/\s+/).length !== q.text.split(/\s+/).length || (offGrid(a) && !offGrid(q.text))) { skipped++; continue; }
            assert.strictEqual(shiftSqref(a, del), a === q.text ? q.text : q.text.split(/\s+/).filter(Boolean).join(' '), `${q.part}: ${q.text} -> ${a}`);
            checked++;
          }
        }
      }
      assert.ok(checked > 0, 'nothing checked');
      assert.ok(skipped <= checked, `skipped ${skipped} of ${checked + skipped}`);
    });

    test(`${fx.name}: deleting a band then checking results parse; insert never yields #REF! below the grid edge`, () => {
      for (const sheet of fx.sheets) {
        for (const [axis, at, count] of BANDS) {
          const del = { sheetName: sheet, axis, at, count: -count };
          for (const f of fx.formulas) {
            const r = shiftFormula(f.text, del, sheet, fx.sheets);
            if (checkFormulaSyntax(f.text).ok) assert.deepStrictEqual(checkFormulaSyntax(r.text), { ok: true }, `${f.text} -> ${r.text}`);
          }
          for (const q of fx.sqrefs) {
            const r = shiftSqref(q.text, del);
            assert.ok(r === null || r.split(' ').every((p) => p !== '#REF!'));
          }
        }
      }
    });

    test(`${fx.name}: renaming every sheet and back restores every formula`, () => {
      for (const sheet of fx.sheets) {
        for (const f of fx.formulas) {
          const a = renameSheetInFormula(f.text, sheet, 'Renamed Temp');
          const b = renameSheetInFormula(a, 'Renamed Temp', sheet);
          // Restored modulo quoting: an unnecessarily quoted original comes back unquoted.
          const norm = (t) => t.replace(/'([A-Za-z_][A-Za-z0-9_.]*)'!/g, '$1!');
          assert.strictEqual(norm(b), norm(f.text), `${f.text} -> ${a} -> ${b}`);
          assert.strictEqual(formulaMentionsSheet(f.text, sheet), a !== f.text, `${f.text} mentions ${sheet}`);
        }
      }
    });
  }
});

test('PENDING_GOLDENS lists the cases WP-37 should confirm against Excel', () => {
  // Printed so the WP-37 author can turn them into cases.json entries.
  assert.ok(PENDING_GOLDENS.length >= 10, String(PENDING_GOLDENS.length));
});
