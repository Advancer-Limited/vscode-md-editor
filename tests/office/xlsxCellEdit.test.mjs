// WP-20: xlsx cell write, calc handling and the ops dispatcher (src/office/core/xlsx/sheet.ts write side,
// ops.ts, calc.ts). Spec §9.3, §9.5 last bullet, §6.5 "Xlsx-only", §13.2 G3–G6.
//
// Every edited workbook is written to tests/.out/xlsxCellEdit/<case>.xlsx for scripts/verify-office-open.ps1.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG4, assertG5, rng } from './_roundtrip.mjs';
import { assertViewMatchesFile } from './_viewCheck.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { applyXlsxEdit, refreshAfterEdit } = core.xlsx.ops;
const { applyEdit, invertEdit } = core.edits;
const { serializeAndVerify, packageValidator } = core.save;
const OUT = 'xlsxCellEdit';
const SHEET1 = 'xl/worksheets/sheet1.xml';

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}

const set = (sheetId, cells) => ({ op: 'setCells', sheetId, cells: cells.map(([r, c, input]) => ({ r, c, input })) });
const run = (wb, pkg, op, confirmed = false) => applyXlsxEdit(wb, pkg, op, { confirmed });

const partText = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);

/** Span of the `c` element for `ref` in sheet XML (prefix '' or 'x:'). */
function cellSpan(text, ref, prefix = '') {
  const m = new RegExp(`<${prefix}c r="${ref}"[ />]`).exec(text);
  assert.ok(m, `cell ${ref} not found`);
  const start = m.index;
  const selfEnd = text.indexOf('/>', start);
  const open = text.indexOf('>', start);
  const end = open === selfEnd + 1 ? selfEnd + 2 : text.indexOf(`</${prefix}c>`, start) + `</${prefix}c>`.length;
  return { start, end };
}

/** Patched copy of a fixture: { part: (text) => text }. */
async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) {
    const f = zip.file(part);
    zip.file(part, fn(f ? await f.async('string') : ''));
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
const replaceOnce = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from}`); return t.replace(from, to); };

async function excel(bytes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(bytes));
  return w;
}

/** Rows strictly ascending, cells strictly ascending within each row, every c/@r in its row (§13.3). */
function assertOrdered(sheetXml, prefix = '') {
  const rowRe = new RegExp(`<${prefix}row\\b[^>]*?\\br="(\\d+)"[^>]*?(/>|>([\\s\\S]*?)</${prefix}row>)`, 'g');
  let prev = 0;
  for (const m of sheetXml.matchAll(rowRe)) {
    const r = Number(m[1]);
    assert.ok(r > prev, `row ${r} after ${prev}`);
    prev = r;
    let pc = -1;
    for (const c of (m[3] ?? '').matchAll(new RegExp(`<${prefix}c r="([A-Z]+)(\\d+)"`, 'g'))) {
      assert.strictEqual(Number(c[2]), r, `cell ${c[1]}${c[2]} in row ${r}`);
      const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      assert.ok(col > pc, `cell ${c[1]}${c[2]} out of order`);
      pc = col;
    }
  }
}

/** serializeAndVerify with the package validator; returns the bytes. */
function save(pkg) {
  const r = serializeAndVerify(pkg, [packageValidator]);
  assert.ok(r.ok, `verify: ${JSON.stringify(r.failures)}`);
  return r.bytes;
}

/**
 * One edit on a fresh copy: asserts ok, G3 (touched set), G4 (sheet locality around `span` of the
 * original sheet text, ignoring a dimension change when `dimFrom`/`dimTo` are given), G5, saves
 * /verifies, writes the output and returns { bytes, after } for the semantic (G6) checks.
 */
async function checkEdit({ name, bytes, op, touched, sheetPart = SHEET1, span, dim, out }) {
  const { pkg, wb, bytes: orig } = load(name, bytes);
  const res = await run(wb, pkg, op);
  assert.ok(res.ok, `edit refused: ${JSON.stringify(res.error)}`);
  assert.ok(res.edit, 'edit recorded');
  const after = save(pkg);
  assertG3(orig, after, touched, `${out} G3`);
  const origText = partText(orig, sheetPart);
  let newText = partText(after, sheetPart);
  if (dim) newText = newText.replace(`<${dim.prefix ?? ''}dimension ref="${dim.to}"/>`, `<${dim.prefix ?? ''}dimension ref="${dim.from}"/>`);
  if (span) assertG4(origText, newText, typeof span === 'function' ? span(origText) : span, `${out} G4`);
  assertOrdered(partText(after, sheetPart), op.prefix ?? '');
  assertG5(pkg, res.edit, orig, `${out} G5`);
  writeOut(OUT, `${out}.xlsx`, after);
  return { res, after, text: partText(after, sheetPart), pkg, wb };
}

const BASIC_FIRST = [SHEET1, 'xl/workbook.xml'];   // basic.xlsx has no calc chain: first edit = sheet + calcPr

// ---------------------------------------------------------------------------------------------
// Per input kind on basic.xlsx (G3, G4, G5, G6)

test('number replaces a shared-string cell (t and v rewritten, sharedStrings untouched)', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[1, 2, '12.5']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'C2'), out: 'number' });
  assert.ok(text.includes('<c r="C2"><v>12.5</v></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('C2').value, 12.5);
});

test('text becomes an inline string with xml:space="preserve" and escaping', async () => {
  const input = '  Pears & "Plums" <x> _x0041_ \u0001';
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[1, 1, input]]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B2'), out: 'text' });
  assert.ok(text.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">  Pears &amp; "Plums" &lt;x&gt; _x005F_x0041_ _x0001_</t></is></c>'), text.slice(text.indexOf('r="B2"') - 5, text.indexOf('r="B2"') + 200));
  const { pkg: re } = load('x.xlsx', after);
  const s = await Workbook.load(re).sheet(1);
  assert.deepStrictEqual(s.cell(1, 1).value, { k: 's', v: input });
  // ExcelJS does not decode ST_Xstring escapes; it still reads the text around them.
  assert.ok(String((await excel(after)).getWorksheet('Values').getCell('B2').value).startsWith('  Pears & "Plums" <x> '));
});

test('boolean', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[2, 1, 'true']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B3'), out: 'boolean' });
  assert.ok(text.includes('<c r="B3" t="b"><v>1</v></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B3').value, true);
});

test('apostrophe keeps a number as text', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[3, 1, "'42"]]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B4'), out: 'apostrophe' });
  assert.ok(text.includes('<c r="B4" t="inlineStr"><is><t xml:space="preserve">42</t></is></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B4').value, '42');
});

test('percent input in a percent cell stores number/100 and keeps s', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[15, 1, '12%']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B16'), out: 'percent' });
  assert.ok(text.includes('<c r="B16" s="4"><v>0.12</v></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B16').value, 0.12);
});

test('Text-formatted cell stores a number-like input as text', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[20, 1, '123']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B21'), out: 'text-format' });
  assert.ok(text.includes('<c r="B21" s="9" t="inlineStr"><is><t xml:space="preserve">123</t></is></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B21').value, '123');
});

test('date into a date-formatted cell: only the value changes', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[12, 1, '2024-01-02']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B13'), out: 'date-in-date-cell' });
  assert.ok(text.includes('<c r="B13" s="1"><v>45293</v></c>'));
  const v = (await excel(after)).getWorksheet('Values').getCell('B13').value;
  assert.ok(v instanceof Date && v.toISOString().startsWith('2024-01-02'), String(v));
});

test('date-time into a currency cell stores the serial and leaves the format alone', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[16, 1, '2024-03-15 12:00']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B17'), out: 'date-in-currency-cell' });
  assert.ok(text.includes('<c r="B17" s="5"><v>45366.5</v></c>'));
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B17').value, 45366.5);
});

test('date into a General cell stores the serial with a date format (WP-22 date style patch; full cases in xlsxDateStyle)', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[1, 1, '2024-03-15']]), touched: [...BASIC_FIRST, 'xl/styles.xml'],
    span: (t) => cellSpan(t, 'B2'), out: 'date-in-general-cell' });
  assert.ok(text.includes('<c r="B2" s="12"><v>45366</v></c>'));
  const v = (await excel(after)).getWorksheet('Values').getCell('B2').value;
  assert.ok(v instanceof Date && v.toISOString().startsWith('2024-03-15'), String(v));
});

test('clear keeps a styled c, removes an unstyled one', async () => {
  const styled = await checkEdit({ name: 'basic.xlsx', op: set(1, [[16, 1, '']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B17'), out: 'clear-styled' });
  assert.ok(styled.text.includes('<c r="B17" s="5"/>'));
  assert.strictEqual((await excel(styled.after)).getWorksheet('Values').getCell('B17').value, null);

  const plain = await checkEdit({ name: 'basic.xlsx', op: { op: 'clearCells', sheetId: 1, range: [1, 1, 1, 1] }, touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'B2'), out: 'clear-unstyled' });
  assert.ok(!/<c r="B2"[ />]/.test(plain.text));
  assert.ok(plain.text.includes('<c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c>'));
  assert.strictEqual(plain.res.edit.label, 'Clear Cells');
});

test('clearCells over a block: values gone, styled cells kept, empty cells ignored', async () => {
  const { text, after, res } = await checkEdit({ name: 'basic.xlsx', op: { op: 'clearCells', sheetId: 1, range: [16, 1, 30, 1] },
    touched: BASIC_FIRST, span: (t) => ({ start: cellSpan(t, 'B17').start, end: cellSpan(t, 'B22').end }), out: 'clear-block' });
  for (const [ref, s] of [['B17', 5], ['B18', 6], ['B19', 7], ['B20', 8], ['B21', 9], ['B22', 10]]) assert.ok(text.includes(`<c r="${ref}" s="${s}"/>`), ref);
  assert.ok(text.includes('<c r="C17" t="s">'), 'column C outside the range');
  assert.deepStrictEqual(res.range, [16, 1, 30, 1]);
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('B18').value, null);
});

test('formula input goes through sharedFormula.setFormula (WP-21; full coverage in xlsxFormula.test.mjs)', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  const res = await run(wb, pkg, set(1, [[1, 1, '=1+1']]));
  assert.ok(res.ok && res.edit);
  assert.ok(pkg.text(SHEET1).includes('<c r="B2"><f>1+1</f></c>'));
  const bad = load('basic.xlsx');
  const refused = await run(bad.wb, bad.pkg, set(1, [[1, 1, '=1+']]));
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'invalid');
  assertBytesEqual(bad.pkg.serialize(), bytes, 'unchanged');
});

test('committing the unchanged edit seed records nothing', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  // seeds: number, text, boolean, error, date (ISO), Text-formatted text, padded text
  const cells = [[1, 1, '42'], [5, 1, 'Hello, world'], [8, 1, 'TRUE'], [10, 1, '#DIV/0!'], [12, 1, '2024-03-15'], [20, 1, '007'], [7, 1, '  leading and trailing  ']];
  const res = await run(wb, pkg, set(1, cells));
  assert.deepStrictEqual({ ok: res.ok, edit: res.edit }, { ok: true, edit: null });
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
});

// ---------------------------------------------------------------------------------------------
// Creating rows and cells

test('new cells and rows are inserted in order, including before the first and after the last', async () => {
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<dimension ref="B3:D5"/><sheetData><row r="3"><c r="B3"><v>1</v></c><c r="D3"><v>2</v></c></row><row r="5" spans="2:2"><c r="B5"><v>3</v></c></row></sheetData></worksheet>';
  const bytes = await patched('inline-strings.xlsx', { [SHEET1]: () => sheet });
  const cells = [[0, 0, 'first row'], [3, 2, 'middle row'], [8, 1, 'last row'], [2, 0, 'before first cell'], [2, 2, 'between cells'], [2, 25, 'after last cell'], [4, 0, '7']];
  const { text, after, res } = await checkEdit({ name: 'gaps.xlsx', bytes, op: set(1, cells), touched: [SHEET1, 'xl/workbook.xml'], out: 'insert-order' });
  assert.strictEqual(res.edit.label, 'Paste Cells');
  assert.ok(text.includes('<dimension ref="A1:Z9"/>'), 'dimension grown');
  assert.ok(text.includes('<sheetData><row r="1"><c r="A1" t="inlineStr">'));
  assert.ok(text.includes('<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">before first cell</t></is></c><c r="B3"><v>1</v></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">between cells</t></is></c><c r="D3"><v>2</v></c><c r="Z3" t="inlineStr">'));
  assert.ok(text.includes('</row><row r="4"><c r="C4" t="inlineStr">'));
  assert.ok(text.includes('<row r="5" spans="2:2"><c r="A5"><v>7</v></c><c r="B5"><v>3</v></c></row>'), 'spans left alone');
  assert.ok(text.includes('<row r="9"><c r="B9" t="inlineStr"><is><t xml:space="preserve">last row</t></is></c></row></sheetData>'));
  const ws = (await excel(after)).worksheets[0];
  assert.strictEqual(ws.getCell('A1').value, 'first row');
  assert.strictEqual(ws.getCell('Z3').value, 'after last cell');
  assert.strictEqual(ws.getCell('A5').value, 7);
});

test('writing into an empty sheet (<sheetData/>) creates the row; dimension grows', async () => {
  const { text, after } = await checkEdit({ name: 'basic.xlsx', op: set(2, [[4, 2, 'x']]), sheetPart: 'xl/worksheets/sheet2.xml',
    touched: ['xl/worksheets/sheet2.xml', 'xl/workbook.xml'], out: 'empty-sheet' });
  assert.ok(text.includes('<dimension ref="A1:C5"/>'));
  assert.ok(text.includes('<sheetData><row r="5"><c r="C5" t="inlineStr"><is><t xml:space="preserve">x</t></is></c></row></sheetData>'));
  assert.strictEqual((await excel(after)).getWorksheet('Second Sheet').getCell('C5').value, 'x');
});

test('a new cell inside the dimension changes only the insertion point (G4)', async () => {
  // Preconditions: B23 is a gap between two cells of an existing row, inside the dimension.
  const orig = partText(fixture('basic.xlsx'), SHEET1);
  assert.ok(orig.includes('<dimension ref="A1:C23"/>'), 'basic.xlsx: dimension A1:C23');
  assert.ok(orig.includes('<c r="A23" t="s"><v>46</v></c><c r="C23"'), 'basic.xlsx: A23 and C23 adjacent');
  const { text } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[22, 1, '5']]), touched: BASIC_FIRST,
    span: (t) => { const i = cellSpan(t, 'C23').start; return { start: i, end: i }; }, out: 'new-cell-in-row' });
  // Exactly the new cell was inserted there; the dimension and the row element are unchanged.
  assert.ok(text.includes('<c r="A23" t="s"><v>46</v></c><c r="B23"><v>5</v></c><c r="C23"'));
  assert.ok(text.includes('<dimension ref="A1:C23"/>'));
  assert.strictEqual(text.length, orig.length + '<c r="B23"><v>5</v></c>'.length);
});

test('a new cell outside the dimension: the dimension is an attr change, the rest is the new row', async () => {
  const { text } = await checkEdit({ name: 'basic.xlsx', op: set(1, [[24, 3, '1']]), touched: BASIC_FIRST,
    dim: { from: 'A1:C23', to: 'A1:D25' }, span: (t) => { const i = t.indexOf('</sheetData>'); return { start: i, end: i }; }, out: 'new-row' });
  assert.ok(text.includes('<row r="25"><c r="D25"><v>1</v></c></row></sheetData>'));
});

test('new cell inherits row style (customFormat), else column style, else none', async () => {
  const bytes = await patched('basic.xlsx', {
    [SHEET1]: (t) => t
      .replace('<col min="3" max="3" width="26.59765625" customWidth="1"/>', '<col min="3" max="3" width="26.59765625" customWidth="1"/><col min="5" max="5" width="9" style="11" customWidth="1"/>')
      .replace('</sheetData>', '<row r="25" s="4" customFormat="1"/><row r="26" s="5"/></sheetData>'),
  });
  const { text, after } = await checkEdit({ name: 'basic.xlsx', bytes, out: 'inherit-style', touched: BASIC_FIRST,
    op: set(1, [[1, 4, '5'], [24, 0, '12%'], [24, 4, '0.5'], [25, 4, '6'], [25, 0, '7'], [1, 5, '8']]) });
  assert.ok(text.includes('<c r="E2" s="11"><v>5</v></c>'), 'column style');
  assert.ok(text.includes('<row r="25" s="4" customFormat="1"><c r="A25" s="4"><v>0.12</v></c><c r="E25" s="4"><v>0.5</v></c></row>'), 'row style wins, percent rule uses it');
  assert.ok(text.includes('<row r="26" s="5"><c r="A26"><v>7</v></c><c r="E26" s="11"><v>6</v></c></row>'), 'row s without customFormat is ignored');
  assert.ok(text.includes('<c r="F2"><v>8</v></c>'), 'no style');
  assert.strictEqual((await excel(after)).getWorksheet('Values').getCell('A25').value, 0.12);
});

test('rich-text cell becomes plain inlineStr, s kept; extra children and attributes are preserved', async () => {
  const rich = '<c r="C2" s="11" t="inlineStr" ph="1"><is><r><rPr><b/></rPr><t>bold</t></r><r><t xml:space="preserve"> plain</t></r></is><extLst><ext uri="{X}"/></extLst></c>';
  const bytes = await patched('basic.xlsx', { [SHEET1]: replaceOnce('<c r="C2" t="s"><v>4</v></c>', rich) });
  // The unchanged seed is a no-op (the rich runs survive).
  {
    const { pkg, wb } = load('rich.xlsx', bytes);
    const res = await run(wb, pkg, set(1, [[1, 2, 'bold plain']]));
    assert.strictEqual(res.edit, null);
  }
  const { text, after } = await checkEdit({ name: 'rich.xlsx', bytes, op: set(1, [[1, 2, 'new']]), touched: BASIC_FIRST,
    span: (t) => cellSpan(t, 'C2'), out: 'rich-to-plain' });
  assert.ok(text.includes('<c r="C2" s="11" t="inlineStr" ph="1"><is><t xml:space="preserve">new</t></is><extLst><ext uri="{X}"/></extLst></c>'));
  const { pkg: re } = load('x.xlsx', after);
  const cell = (await Workbook.load(re).sheet(1)).cell(1, 2);
  assert.deepStrictEqual([cell.value, cell.rich, cell.styleIndex], [{ k: 's', v: 'new' }, false, 11]);
  await excel(after);   // ExcelJS loads it
});

// ---------------------------------------------------------------------------------------------
// Paste, read-only cells and refusals

test('paste 3x3 is one edit', async () => {
  const cells = [];
  for (let r = 29; r < 32; r++) for (let c = 0; c < 3; c++) cells.push([r, c, String(r * 10 + c)]);
  const { res, after, pkg } = await checkEdit({ name: 'basic.xlsx', op: set(1, cells), touched: BASIC_FIRST, out: 'paste-3x3' });
  assert.strictEqual(res.edit.label, 'Paste Cells');
  assert.deepStrictEqual(res.range, [29, 0, 31, 2]);
  assert.strictEqual(res.invalidate, 'cells');
  // One undo removes all nine.
  applyEdit(pkg, invertEdit(res.edit));
  assertBytesEqual(pkg.serialize(), fixture('basic.xlsx'), 'one undo');
  const ws = (await excel(after)).getWorksheet('Values');
  assert.strictEqual(ws.getCell('C32').value, 312);
});

// Gate R2 F1: a refused multi-cell edit must leave the read model describing the (unchanged) file.

test('F1: a paste refused by a bad formula after a good value leaves no phantom value in the view', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  const styles = core.xlsx.ops.stylesFor(wb);
  const res = await run(wb, pkg, set(1, [[1, 1, '777'], [2, 1, '=IF(']]));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'invalid');
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'package unchanged');
  const sheet = await wb.sheet(1);
  assert.strictEqual(sheet.cell(1, 1).value.v, 42, 'B2 still reads 42');
  assert.strictEqual(core.xlsx.format.editSeed(sheet.cell(1, 1), styles, wb.date1904), '42');
  // A new cell in a new row, refused by the next cell: not in the view either.
  const res2 = await run(wb, pkg, set(1, [[40, 0, 'phantom'], [41, 0, '=1+']]));
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(sheet.cell(40, 0), undefined);
  assert.deepStrictEqual(sheet.cellsIn([39, 0, 42, 3]), []);
  await assertViewMatchesFile(wb, pkg, styles, 'after refused pastes');
  // An unrelated edit afterwards does not resurrect them, and the saved file agrees.
  const ok = await run(wb, pkg, set(1, [[29, 4, '1']]));
  assert.ok(ok.ok && ok.edit);
  await assertViewMatchesFile(wb, pkg, styles, 'after a later edit');
  assert.ok(partText(save(pkg), SHEET1).includes('<c r="B2"><v>42</v></c>'));
});

// Two shared groups reusing si="0" (malformed: materialising either is refused) after plain cells, so a
// refusal happens after earlier cells of the same edit were written (the rollback path, not the pre-check).
const DUP_SI_DATA = '<sheetData>'
  + '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B2" si="0">A1+1</f><v>2</v></c></row>'
  + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>3</v></c></row>'
  + '<row r="4"><c r="A4"><v>4</v></c></row>'
  + '<row r="6"><c r="A6"><v>6</v></c><c r="B6"><f t="shared" ref="B6:B7" si="0">A6+100</f><v>106</v></c></row>'
  + '<row r="7"><c r="A7"><v>7</v></c><c r="B7"><f t="shared" si="0"/><v>107</v></c></row>'
  + '</sheetData>';
const dupSi = () => patched('basic.xlsx', {
  [SHEET1]: (t) => t.replace(/<sheetData>.*<\/sheetData>/s, DUP_SI_DATA),
});

test('F1: a refusal after cells and a date style were written rolls the index and the style table back', async () => {
  const bytes = await dupSi();
  const { pkg, wb } = load('dup.xlsx', bytes);
  const styles = core.xlsx.ops.stylesFor(wb);
  const xfs = styles.xfCount;
  const sheet = await wb.sheet(1);
  // A4 (value), A5 (new row), A8 (date: appends a date xf), then B1 (master of a reused si: blocked).
  const res = await run(wb, pkg, set(1, [[3, 0, '777'], [4, 0, 'new'], [7, 0, '2024-03-15'], [0, 1, '5']]));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'blocked');
  assert.match(res.error.message, /2 master cells/);
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'package unchanged');
  assert.strictEqual(styles.xfCount, xfs, 'style table reloaded');
  assert.strictEqual(sheet.cell(3, 0).value.v, 4);
  assert.strictEqual(sheet.cell(4, 0), undefined);
  assert.strictEqual(sheet.cell(7, 0), undefined);
  await assertViewMatchesFile(wb, pkg, styles, 'after the refused paste');
  // clearCells: A4 is cleared before B6 (a master of the reused si) refuses.
  const clr = await run(wb, pkg, { op: 'clearCells', sheetId: 1, range: [3, 0, 5, 1] });
  assert.strictEqual(clr.ok, false);
  assert.strictEqual(clr.error.code, 'blocked');
  assert.strictEqual(sheet.cell(3, 0).value.v, 4);
  await assertViewMatchesFile(wb, pkg, styles, 'after the refused clear');
  // The next edit still lands exactly and appends the date style once.
  const ok = await run(wb, pkg, set(1, [[7, 0, '2024-03-15']]));
  assert.ok(ok.ok && ok.edit);
  assert.strictEqual(styles.xfCount, xfs + 1);
  await assertViewMatchesFile(wb, pkg, styles, 'after a later edit');
  save(pkg);
});

test('paste onto a table header is refused and changes nothing', async () => {
  const { pkg, wb, bytes } = load('tables.xlsx');
  const sheet = await wb.sheet(1);
  assert.ok(sheet.isReadOnlyCell(0, 1), 'B1 is a header cell');
  assert.ok(!sheet.isReadOnlyCell(1, 1), 'B2 is data');
  const res = await run(wb, pkg, set(1, [[1, 1, '1'], [0, 1, 'Renamed'], [1, 2, '2']]));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'read-only');
  assert.match(res.error.message, /B1 is a header cell of table "SalesTable"/);
  assert.deepStrictEqual(pkg.touchedParts(), []);
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  // Data cells of the table stay editable; clearing a range that includes the header is refused.
  const ok = await run(wb, pkg, set(1, [[1, 1, 'x']]));
  assert.ok(ok.ok && ok.edit);
  writeOut(OUT, 'table-data.xlsx', save(pkg));
  const clr = await run(wb, pkg, { op: 'clearCells', sheetId: 1, range: [0, 0, 3, 3] });
  assert.strictEqual(clr.ok, false);
});

test('array formula members, data tables, cm/vm cells are read-only; shared masters are materialised (WP-21)', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const sheet = await wb.sheet(1);
  for (const [r, c] of [[1, 4], [2, 4], [3, 4]]) assert.ok(sheet.isReadOnlyCell(r, c), `E${r + 1}`);
  assert.ok(!sheet.isReadOnlyCell(4, 4), 'E5 is outside the array');
  const arr = await run(wb, pkg, set(1, [[2, 4, '1']]));
  assert.strictEqual(arr.ok, false);
  assert.match(arr.error.message, /E3 is part of the array formula E2:E4/);
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  const master = await run(wb, pkg, set(1, [[1, 1, '5']]));
  assert.ok(master.ok && master.edit);
  assert.ok(pkg.text(SHEET1).includes('<c r="B2"><v>5</v></c>') && pkg.text(SHEET1).includes('<c r="B3"><f>A3*2</f><v>0</v></c>'));
  applyEdit(pkg, invertEdit(master.edit));
  refreshAfterEdit(wb, master.edit);
  assertBytesEqual(pkg.serialize(), bytes, 'undone');

  const vmBytes = await patched('basic.xlsx', { [SHEET1]: (t) => t.replace('<c r="B2"><v>42</v></c>', '<c r="B2" vm="1"><v>42</v></c>').replace('<c r="B3">', '<c r="B3" cm="1">') });
  const v = load('vm.xlsx', vmBytes);
  const vs = await v.wb.sheet(1);
  assert.ok(vs.isReadOnlyCell(1, 1) && vs.isReadOnlyCell(2, 1));
  const r = await run(v.wb, v.pkg, set(1, [[1, 1, '1']]));
  assert.strictEqual(r.error.code, 'read-only');

  const dtBytes = await patched('basic.xlsx', { [SHEET1]: replaceOnce('<c r="B2"><v>42</v></c>', '<c r="B2"><f t="dataTable" ref="B2:B4" dt2D="0" dtr="0" r1="A1"/><v>42</v></c>') });
  const d = load('dt.xlsx', dtBytes);
  assert.ok((await d.wb.sheet(1)).isReadOnlyCell(3, 1), 'data table member');
});

test('dependants of a shared formula can be overwritten (their f goes)', async () => {
  const { text, after } = await checkEdit({ name: 'formulas.xlsx', op: set(1, [[2, 1, '99']]),
    touched: [SHEET1, 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml'],
    span: (t) => cellSpan(t, 'B3'), out: 'shared-dependant' });
  assert.ok(text.includes('<c r="B3"><v>99</v></c>'));
  assert.strictEqual((await excel(after)).worksheets[0].getCell('B3').value, 99);
});

test('refusals: protected sheet, chartsheet, limits, duplicates, bad coordinates, structure ops', async () => {
  const p = load('protected-sheet.xlsx');
  const prot = await run(p.wb, p.pkg, set(1, [[0, 0, 'x']]));
  assert.strictEqual(prot.error.code, 'read-only');
  assert.match(prot.error.message, /protected/);

  const ch = load('chartsheet.xlsx');
  const chartId = ch.wb.sheets.find((s) => s.kind === 'chartsheet').id;
  assert.strictEqual((await run(ch.wb, ch.pkg, set(chartId, [[0, 0, 'x']]))).error.code, 'read-only');

  const { pkg, wb, bytes } = load('basic.xlsx');
  const tooMany = Array.from({ length: 10001 }, (_, i) => [Math.floor(i / 100), i % 100, '1']);
  assert.strictEqual((await run(wb, pkg, set(1, tooMany))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, set(1, [[0, 0, 'a'], [0, 0, 'b']]))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, set(1, [[1048576, 0, 'a']]))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, set(1, [[0, 16384, 'a']]))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, set(1, [[0, 0, 'x'.repeat(32768)]]))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, set(99, [[0, 0, 'a']]))).error.code, 'invalid');
  assert.strictEqual((await run(wb, pkg, { op: 'clearCells', sheetId: 1, range: [0, 0, -1, 2] })).error.code, 'invalid');
  for (const op of [{ op: 'insertRows', sheetId: 1, at: 2, count: 1 }, { op: 'deleteCols', sheetId: 1, at: 0, count: 2 },
    { op: 'addSheet' }, { op: 'renameSheet', sheetId: 1, name: 'X' }, { op: 'deleteSheet', sheetId: 2 }]) {
    assert.deepStrictEqual(await run(wb, pkg, op), { ok: false, error: { code: 'blocked', message: 'Not available yet' } }, op.op);
  }
  const big = await run(wb, pkg, set(1, [[0, 0, 'x'.repeat(32767)]]));
  assert.ok(big.ok, 'exactly 32,767 characters is accepted');
  applyEdit(pkg, invertEdit(big.edit));
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');

  const ps = load('protected-structure.xlsx');
  const r = await run(ps.wb, ps.pkg, { op: 'renameSheet', sheetId: 1, name: 'X' });
  assert.strictEqual(r.error.code, 'read-only');
  assert.ok((await run(ps.wb, ps.pkg, set(1, [[0, 0, '1']]))).ok, 'cells stay editable under structure protection');
});

// ---------------------------------------------------------------------------------------------
// Calc handling (§9.5)

test('first edit on formulas.xlsx sets fullCalcOnLoad and drops calcChain, its rel and Override; later edits do not touch them', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  const res = await run(wb, pkg, set(1, [[0, 6, '0.3']]));
  const after = save(pkg);
  assertG3(bytes, after, [SHEET1, 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml'], 'G3 first');
  const re = OfficePackage.open('x.xlsx', after);
  assert.ok(!re.has('xl/calcChain.xml'));
  assert.ok(!re.text('xl/_rels/workbook.xml.rels').includes('calcChain'));
  assert.ok(!re.text('[Content_Types].xml').includes('calcChain'));
  assert.ok(re.text('xl/workbook.xml').includes('<calcPr calcId="191029" fullCalcOnLoad="1"/>'));
  assertG4(partText(bytes, 'xl/workbook.xml'), re.text('xl/workbook.xml'), (() => { const t = partText(bytes, 'xl/workbook.xml'); const i = t.indexOf('<calcPr'); return { start: i, end: t.indexOf('>', i) + 1 }; })());
  writeOut(OUT, 'calc-first-edit.xlsx', after);
  const second = await run(wb, pkg, set(1, [[1, 6, '8']]));
  assert.ok(second.edit.changes.every((c) => c.part === SHEET1), 'second edit touches only the sheet');
  // Undo both: the calc chain comes back byte for byte.
  applyEdit(pkg, invertEdit(second.edit));
  applyEdit(pkg, invertEdit(res.edit));
  assertBytesEqual(pkg.serialize(), bytes, 'full undo');
  // ExcelJS still loads the edited workbook.
  assert.strictEqual((await excel(after)).worksheets[0].getCell('G1').value, 0.3);
});

test('calcPr created in schema position when absent (before extLst; after sheets/definedNames)', async () => {
  const bytes = await patched('basic.xlsx', { 'xl/workbook.xml': replaceOnce('<calcPr calcId="191029"/>', '') });
  const { text } = await checkEdit({ name: 'basic.xlsx', bytes, op: set(1, [[1, 1, '1']]), touched: BASIC_FIRST, out: 'calcpr-created' });
  const wbText = partText(OfficePackage.open('x.xlsx', bytes).serialize(), 'xl/workbook.xml');
  assert.ok(text.includes('<v>1</v>'));
  const { pkg, wb } = load('basic.xlsx', bytes);
  await run(wb, pkg, set(1, [[1, 1, '1']]));
  const w = pkg.text('xl/workbook.xml');
  assert.ok(w.includes('</sheets><calcPr fullCalcOnLoad="1"/><extLst>'), w.slice(w.indexOf('</sheets>'), w.indexOf('</sheets>') + 60));
  assertG4(wbText, w, (() => { const i = wbText.indexOf('<extLst>'); return { start: i, end: i }; })());

  const withNames = await patched('basic.xlsx', { 'xl/workbook.xml': (t) => t.replace('<calcPr calcId="191029"/>', '').replace('</sheets>', '</sheets><definedNames><definedName name="N">Values!$A$1</definedName></definedNames>') });
  const n = load('names.xlsx', withNames);
  await run(n.wb, n.pkg, set(1, [[1, 1, '1']]));
  assert.ok(n.pkg.text('xl/workbook.xml').includes('</definedNames><calcPr fullCalcOnLoad="1"/><extLst>'));
});

test('existing fullCalcOnLoad="1" is left alone', async () => {
  const bytes = await patched('basic.xlsx', { 'xl/workbook.xml': replaceOnce('<calcPr calcId="191029"/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>') });
  await checkEdit({ name: 'basic.xlsx', bytes, op: set(1, [[1, 1, '1']]), touched: [SHEET1], out: 'calc-already-set' });
});

// ---------------------------------------------------------------------------------------------
// Other producers / layouts

test('works on prefixed-namespaces.xlsx (x: prefix on every new element)', async () => {
  const { text, after } = await checkEdit({ name: 'prefixed-namespaces.xlsx', out: 'prefixed', touched: [SHEET1, 'xl/workbook.xml'],
    op: { ...set(1, [[1, 1, 'two'], [3, 0, '4'], [0, 2, 'TRUE']]), prefix: 'x:' } });
  assert.ok(text.includes('<x:c r="B2" t="inlineStr"><x:is><x:t xml:space="preserve">two</x:t></x:is></x:c>'), text);
  assert.ok(text.includes('<x:row r="4"><x:c r="A4"><x:v>4</x:v></x:c></x:row></x:sheetData>'));
  assert.ok(text.includes('<x:c r="C1" t="b"><x:v>1</x:v></x:c></x:row>'));
  assert.ok(text.includes('<x:dimension ref="A1:C4"/>'));
  const re = OfficePackage.open('x.xlsx', after);
  assert.ok(re.text('xl/workbook.xml').includes('</x:sheets><x:calcPr fullCalcOnLoad="1"/></x:workbook>'));
  const s = await Workbook.load(re).sheet(1);
  assert.deepStrictEqual([s.cell(1, 1).value, s.cell(3, 0).value, s.cell(0, 2).value], [{ k: 's', v: 'two' }, { k: 'n', v: 4 }, { k: 'b', v: true }]);
});

test('works on inline-strings.xlsx', async () => {
  const { text, after } = await checkEdit({ name: 'inline-strings.xlsx', out: 'inline-strings', touched: [SHEET1, 'xl/workbook.xml'],
    op: set(1, [[2, 0, 'Quinces'], [3, 1, '5']]) });
  assert.ok(text.includes('<c r="A3" t="inlineStr"><is><t xml:space="preserve">Quinces</t></is></c>'));
  assert.ok(text.includes('<c r="B4"><v>5</v></c>'));
  const ws = (await excel(after)).worksheets[0];
  assert.strictEqual(ws.getCell('A3').value, 'Quinces');
  assert.strictEqual(ws.getCell('B4').value, 5);
});

const LIBRE = path.join(here, '..', 'fixtures', 'office', 'libreoffice.xlsx');
test('works on libreoffice.xlsx', { skip: !fs.existsSync(LIBRE) && 'PENDING: libreoffice.xlsx not supplied yet (tests/fixtures/office/README.md)' }, async () => {
  const { wb, pkg, bytes } = load('libreoffice.xlsx');
  const res = await run(wb, pkg, set(1, [[1, 1, 'edited'], [40, 3, '1.5']]));
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  const after = save(pkg);
  assertG5(pkg, res.edit, bytes);
  writeOut(OUT, 'libreoffice.xlsx', after);
  const ws = (await excel(after)).worksheets[0];
  assert.strictEqual(ws.getCell('B2').value, 'edited');
});

// ---------------------------------------------------------------------------------------------
// Index freshness after outside undo/redo

test('an undo applied from outside without refresh: the next edit detects the stale index and is still exact', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  const e1 = (await run(wb, pkg, set(1, [[1, 1, '']]))).edit;   // removes B2
  applyEdit(pkg, invertEdit(e1));                                // B2 back; the index still says it is gone
  const e2 = (await run(wb, pkg, set(1, [[1, 1, '7']]))).edit;
  assert.ok(pkg.text(SHEET1).includes('<c r="A2" t="s"><v>3</v></c><c r="B2"><v>7</v></c><c r="C2"'));
  assert.ok(e2.changes.some((c) => c.kind === 'node' && c.before === '<c r="B2"><v>42</v></c>'), 'replaced, not duplicated');
  applyEdit(pkg, invertEdit(e2));
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  // And with refreshAfterEdit the index follows directly.
  applyEdit(pkg, e1);
  refreshAfterEdit(wb, e1);
  assert.strictEqual((await wb.sheet(1)).cell(1, 1), undefined);
});

// ---------------------------------------------------------------------------------------------
// Randomised G5: 200 setCells/clear operations with undo/redo interleaved, then full undo

const POOL = ['', '', '0', '42', '-3.25', '1e5', '.5', '5.', 'TRUE', 'false', 'text', "'007", '  spaced  ', 'café 😀', '2024-03-15',
  '2024-03-15T08:30', '12%', '#N/A', 'a & <b>', '_x0041_', '=1+1', 'line\nbreak'];
/** Inputs every paste containing one is refused for (Gate R2 F1: mixed into pastes after good values). */
const BAD = ['=IF(', '=SUM(,)', '=NoSuch!A1', '=[1]Sheet1!A1', '=ROUND(1.5)', '={1,2;3}'];

async function randomRun(name, seed, withRefresh) {
  const { pkg, wb, bytes } = load(name);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const sheetIds = wb.sheets.filter((s) => s.kind === 'worksheet').map((s) => s.id);
  const done = [];
  const undone = [];
  let refused = 0;
  let applied = 0;
  let undos = 0;
  for (let i = 0; i < 200; i++) {
    const x = rand();
    if (x < 0.15 && done.length) {
      const e = done.pop();
      applyEdit(pkg, invertEdit(e));
      if (withRefresh) refreshAfterEdit(wb, e);
      undone.push(e);
      undos++;
      if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `${name} undo ${i}`);
      continue;
    }
    if (x < 0.22 && undone.length) {
      const e = undone.pop();
      applyEdit(pkg, e);
      if (withRefresh) refreshAfterEdit(wb, e);
      done.push(e);
      if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `${name} redo ${i}`);
      continue;
    }
    const sheetId = pick(sheetIds);
    let op;
    if (rand() < 0.2) {
      const r0 = Math.floor(rand() * 30), c0 = Math.floor(rand() * 8);
      op = { op: 'clearCells', sheetId, range: [r0, c0, r0 + Math.floor(rand() * 3), c0 + Math.floor(rand() * 3)] };
    } else {
      const n = 1 + Math.floor(rand() * 4);
      const cells = new Map();
      for (let k = 0; k < n; k++) cells.set(`${Math.floor(rand() * 35)},${Math.floor(rand() * 9)}`, pick(POOL));
      const list = [...cells].map(([rc, input]) => [...rc.split(',').map(Number), input]);
      if (list.length > 1 && rand() < 0.15) list[list.length - 1][2] = pick(BAD);
      op = set(sheetId, list);
    }
    const res = await run(wb, pkg, op);
    if (!res.ok) refused++;
    else if (res.edit) { done.push(res.edit); undone.length = 0; applied++; }
    // With refresh after every outside undo/redo the view must read what the file says at every step.
    if (withRefresh) await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `${name} step ${i}`);
    if (!res.ok) continue;
    if (i % 25 === 0) {
      for (const sid of sheetIds) {
        const part = wb.entry(sid).part;
        assertOrdered(pkg.text(part));
      }
      save(pkg);
    }
  }
  const final = save(pkg);
  writeOut(OUT, `random-${name}`, final);
  await excel(final);   // G6: ExcelJS loads the edited workbook
  while (done.length) applyEdit(pkg, invertEdit(done.pop()));
  assertBytesEqual(pkg.serialize(), bytes, `${name}: full undo`);
  assert.ok(applied >= 70 && undos >= 15, `exercised: ${applied} edits, ${undos} undos`);
  assert.ok(refused >= 5, `bad pastes exercised: ${refused} refusals`);
  return refused;
}

test('seeded 200-op random setCells/clear sequence on basic.xlsx: full undo is byte-identical', async () => {
  await randomRun('basic.xlsx', 20, true);
});

test('seeded 200-op random setCells/clear sequence on formulas.xlsx (no refresh: stale-index recovery): full undo is byte-identical', async () => {
  await randomRun('formulas.xlsx', 7, false);
});
