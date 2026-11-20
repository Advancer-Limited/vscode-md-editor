// WP-11: xlsx read model (src/office/core/xlsx/workbook.ts, sheet.ts, sharedStrings.ts).
// Spec §9.1 (workbook model, view-only reasons), §9.2 (reading cells), §9.4 (shared formulas, read
// side), §10.2 (limits, chunked parse).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture } from './_helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { OfficePackage } = core.pkg;
const { Workbook, SheetLoadError } = core.xlsx.workbook;
const { a1ToRc, rcToA1, a1ToRange, rangeToA1 } = core.xlsx.sheet;
const { SharedStrings, decodeXstring } = core.xlsx.sharedStrings;
const LIMITS = core.limits.LIMITS;

const open = (name, bytes = fixture(name)) => Workbook.load(OfficePackage.open(name, bytes));

/** Copy of fixture `name` with `edits` = { part: (text) => text } applied (and parts added when absent). */
async function patchedFixture(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) {
    const f = zip.file(part);
    const text = f ? await f.async('string') : '';
    zip.file(part, fn(text));
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

const replaceOnce = (from, to) => (t) => {
  assert.ok(t.includes(from), `part should contain ${from}`);
  return t.replace(from, to);
};

/** Every cell of every worksheet, as plain data, for whole-workbook comparisons. */
async function snapshot(wb) {
  const out = [];
  for (const e of wb.sheets) {
    const row = { name: e.name, kind: e.kind, state: e.state };
    if (e.kind === 'worksheet') {
      const s = await wb.sheet(e.id);
      const d = s.dimensions();
      row.dims = d;
      row.readOnly = s.readOnlyReason;
      row.cells = s.cellsIn([0, 0, Math.max(0, d.rows - 1), Math.max(0, d.cols - 1)]);
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Acceptance tests (plan WP-11)

/** ExcelJS cell value -> our CellValue (null for "no value"). */
function fromExcelJs(v, date1904) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return { k: 'n', v };
  if (typeof v === 'string') return { k: 's', v };
  if (typeof v === 'boolean') return { k: 'b', v };
  if (v instanceof Date) {
    // ExcelJS turns date-formatted numbers into UTC Dates; convert back to the serial.
    return { k: 'n', v: v.getTime() / 86400000 + (date1904 ? 24107 : 25569), date: true };
  }
  if (v.error) return { k: 'e', v: v.error };
  if (v.richText) return { k: 's', v: v.richText.map((r) => r.text).join('') };
  if ('formula' in v || 'sharedFormula' in v) {
    // ExcelJS drops falsy cached results (0, '', false), so only a present result is compared.
    const res = v.result === undefined ? { any: true } : fromExcelJs(v.result, date1904) ?? { any: true };
    return { ...res, formula: v.formula, shared: v.sharedFormula !== undefined };
  }
  throw new Error(`unexpected ExcelJS value ${JSON.stringify(v)}`);
}

for (const name of ['basic.xlsx', 'formulas.xlsx', 'date1904.xlsx', 'styles.xlsx']) {
  test(`reads every c/@t kind from ${name} with the values ExcelJS reports (all cells)`, async () => {
    const bytes = fixture(name);
    const xj = new ExcelJS.Workbook();
    await xj.xlsx.load(Buffer.from(bytes));
    const wb = open(name, bytes);
    let compared = 0;
    const kinds = new Set();
    for (const e of wb.sheets) {
      const ws = xj.getWorksheet(e.name);
      assert.ok(ws, `ExcelJS has sheet ${e.name}`);
      const s = await wb.sheet(e.id);
      const seen = new Set();
      ws.eachRow({ includeEmpty: false }, (row, rn) => {
        row.eachCell({ includeEmpty: false }, (cell, cn) => {
          if (cell.isMerged && cell.master !== cell) return;   // ExcelJS repeats the master's value
          const exp = fromExcelJs(cell.value, wb.date1904);
          if (exp === null) return;
          const got = s.cell(rn - 1, cn - 1);
          const where = `${e.name}!${rcToA1(rn - 1, cn - 1)}`;
          assert.ok(got, `${where} exists`);
          seen.add(`${rn - 1},${cn - 1}`);
          kinds.add(got.value.k);
          if (exp.formula !== undefined) assert.strictEqual(got.formula, exp.formula, `${where} formula`);
          if (exp.shared) assert.strictEqual(got.shared?.master, false, `${where} shared dependant`);
          if (exp.any) {
            // value not reported by ExcelJS
          } else if (exp.date) {
            assert.strictEqual(got.value.k, 'n', where);
            assert.ok(Math.abs(got.value.v - exp.v) < 1e-6, `${where}: ${got.value.v} vs ${exp.v}`);
          } else {
            assert.deepStrictEqual(got.value, { k: exp.k, v: exp.v }, where);
          }
          compared++;
        });
      });
      // Every cell we report with a value is one ExcelJS reports too.
      const d = s.dimensions();
      for (const c of s.cellsIn([0, 0, Math.max(0, d.rows - 1), Math.max(0, d.cols - 1)])) {
        if (c.value.k === 'z') continue;
        // ExcelJS drops formula string results that are empty (`<v/>`); nothing else may be extra.
        if (c.formula !== undefined && c.value.k === 's' && c.value.v === '') continue;
        assert.ok(seen.has(`${c.r},${c.c}`), `${e.name}!${rcToA1(c.r, c.c)} only in our read (${JSON.stringify(c.value)})`);
      }
    }
    assert.ok(compared > 0, 'compared some cells');
    if (name === 'basic.xlsx') {
      for (const k of ['n', 's', 'b', 'e']) assert.ok(kinds.has(k), `basic.xlsx has kind ${k}`);
    }
  });
}

test('basic.xlsx: specific values, styles, blank cell', async () => {
  const wb = open('basic.xlsx');
  assert.deepStrictEqual(wb.sheets.map((e) => [e.id, e.name, e.kind, e.state, e.fileSheetId, e.rId, e.part]), [
    [1, 'Values', 'worksheet', 'visible', 1, 'rId1', 'xl/worksheets/sheet1.xml'],
    [2, 'Second Sheet', 'worksheet', 'visible', 2, 'rId2', 'xl/worksheets/sheet2.xml'],
  ]);
  assert.strictEqual(wb.stylesPart, 'xl/styles.xml');
  assert.strictEqual(wb.themePart, 'xl/theme/theme1.xml');
  assert.strictEqual(wb.sharedStringsPart, 'xl/sharedStrings.xml');
  const s = await wb.sheet(1);
  assert.strictEqual(s.readOnlyReason, null);
  assert.strictEqual(s.truncatedAtRow, null);
  assert.deepStrictEqual(s.dimensions(), { rows: 23, cols: 3 });
  const b2 = s.cell(1, 1);
  assert.deepStrictEqual(b2, { r: 1, c: 1, value: { k: 'n', v: 42 }, styleIndex: 0, hasCachedValue: true, rich: false, cm: false, vm: false });
  assert.deepStrictEqual(s.cell(6, 1).value, { k: 's', v: 'café 日本語 😀' });
  assert.deepStrictEqual(s.cell(7, 1).value, { k: 's', v: '  leading and trailing  ' });
  assert.deepStrictEqual(s.cell(8, 1).value, { k: 'b', v: true });
  assert.deepStrictEqual(s.cell(9, 1).value, { k: 'b', v: false });
  assert.deepStrictEqual(s.cell(10, 1).value, { k: 'e', v: '#DIV/0!' });
  assert.strictEqual(s.cell(12, 1).styleIndex, 1);
  assert.strictEqual(s.cell(0, 0).styleIndex, 11);
  assert.strictEqual(s.cell(30, 30), undefined);
  assert.strictEqual(wb.sharedString(0), 'Kind');
  assert.strictEqual(wb.sharedString(9999), '');
  const empty = await wb.sheet(2);
  assert.deepStrictEqual(empty.dimensions(), { rows: 0, cols: 0 });
  assert.deepStrictEqual(empty.cellsIn([0, 0, 99, 25]), []);
  assert.strictEqual(await wb.sheet(1), s, 'sheet() is cached');
});

test('shared strings: rich runs concatenated, rPh ignored, _xHHHH_ decoded', async () => {
  const bytes = await patchedFixture('basic.xlsx', {
    'xl/sharedStrings.xml': (t) => t
      .replace('<si><t>Kind</t></si>',
        '<si><r><rPr><b/><sz val="11"/></rPr><t>Hel</t></r><r><t xml:space="preserve">lo world</t></r>'
        + '<rPh sb="0" eb="1"><t>ハロー</t></rPh><phoneticPr fontId="1" type="noConversion"/></si>')
      .replace('<si><t>Value</t></si>', '<si><t>Val</t><rPh sb="0" eb="3"><t>バリュー</t></rPh></si>')
      .replace('<si><t>Note</t></si>', '<si><t>a_x000D_b_x005F_x0041_</t></si>'),
  });
  const wb = open('basic.xlsx', bytes);
  const s = await wb.sheet(1);
  assert.deepStrictEqual(s.cell(0, 0).value, { k: 's', v: 'Hello world' });
  assert.strictEqual(s.cell(0, 0).rich, true);
  assert.deepStrictEqual(s.cell(0, 1).value, { k: 's', v: 'Val' });
  assert.strictEqual(s.cell(0, 1).rich, false);
  assert.deepStrictEqual(s.cell(0, 2).value, { k: 's', v: 'a\rb_x0041_' });
  assert.strictEqual(wb.sharedString(0), 'Hello world');
  assert.strictEqual(wb.sharedStrings().isRich(0), true);
  assert.strictEqual(decodeXstring('x_x0009_y'), 'x\ty');
  assert.strictEqual(SharedStrings.empty().count, 0);
});

test('inline-strings.xlsx and no-shared-strings.xlsx read', async () => {
  const expectText = [
    ['Name', 'Qty', 'Note'],
    ['Apples', 3, 'first'],
    [null, 4.5, 'escaped'],
    ['Empty', null, 'styled blank'],
  ];
  for (const [name, a3] of [['inline-strings.xlsx', 'Pears & "Plums" <x>'], ['no-shared-strings.xlsx', 'Pears x x xxx']]) {
    const wb = open(name);
    assert.strictEqual(wb.sharedStringsPart, null, `${name} has no shared strings`);
    const s = await wb.sheet(1);
    assert.deepStrictEqual(s.dimensions(), { rows: 4, cols: 3 });
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        let exp = r === 2 && c === 0 ? a3 : expectText[r][c];
        const got = s.cell(r, c);
        assert.ok(got, `${name} ${rcToA1(r, c)} exists`);
        if (exp === null) {
          assert.deepStrictEqual(got.value, { k: 'z' }, `${name} ${rcToA1(r, c)}`);
          assert.strictEqual(got.hasCachedValue, false);
        } else {
          assert.deepStrictEqual(got.value, typeof exp === 'number' ? { k: 'n', v: exp } : { k: 's', v: exp }, `${name} ${rcToA1(r, c)}`);
        }
        if (name === 'no-shared-strings.xlsx' && typeof exp === 'string') {
          assert.strictEqual(got.formula, JSON.stringify(exp), 't="str" cells carry their formula');
          assert.strictEqual(got.hasCachedValue, true);
        }
      }
    }
  }
});

test('prefixed-namespaces.xlsx reads identically to its unprefixed twin', async () => {
  const unprefix = (t) => t.replace(/xmlns:x=/g, 'xmlns=').replace(/<x:/g, '<').replace(/<\/x:/g, '</');
  const twin = await patchedFixture('prefixed-namespaces.xlsx', {
    'xl/workbook.xml': unprefix, 'xl/worksheets/sheet1.xml': unprefix, 'xl/sharedStrings.xml': unprefix,
  });
  const a = open('prefixed-namespaces.xlsx');
  const b = open('prefixed-namespaces.xlsx', twin);
  assert.ok(!(await JSZip.loadAsync(twin).then((z) => z.file('xl/worksheets/sheet1.xml').async('string'))).includes('<x:'));
  const sa = await snapshot(a);
  assert.deepStrictEqual(sa, await snapshot(b));
  assert.deepStrictEqual(sa[0].cells.map((c) => c.value), [
    { k: 's', v: 'Prefixed' }, { k: 's', v: 'Namespaces' }, { k: 'n', v: 1 }, { k: 'n', v: 2 },
  ]);
});

test('sheet without r attributes -> unsupported-xml-layout (positions inferred for viewing)', async () => {
  const strip = (t) => t.replace(/<row r="\d+"/g, '<row').replace(/<c r="[A-Z]+\d+"/g, '<c');
  const bytes = await patchedFixture('basic.xlsx', { 'xl/worksheets/sheet1.xml': strip });
  const wb = open('basic.xlsx', bytes);
  const s = await wb.sheet(1);
  assert.strictEqual(s.readOnlyReason, 'unsupported-xml-layout');
  assert.deepStrictEqual(s.cell(1, 1).value, { k: 'n', v: 42 });
  assert.deepStrictEqual(s.dimensions(), { rows: 23, cols: 3 });
  // Only cells missing r: still unsupported.
  const cellsOnly = await patchedFixture('basic.xlsx', { 'xl/worksheets/sheet1.xml': replaceOnce('<c r="B2">', '<c>') });
  assert.strictEqual((await open('basic.xlsx', cellsOnly).sheet(1)).readOnlyReason, 'unsupported-xml-layout');
  // Duplicate / out-of-order cells and a cell whose r names another row.
  for (const edit of [
    replaceOnce('<c r="B2">', '<c r="A2">'),
    replaceOnce('<c r="C2"', '<c r="C9"'),
    replaceOnce('<row r="3"', '<row r="2"'),
  ]) {
    const b = await patchedFixture('basic.xlsx', { 'xl/worksheets/sheet1.xml': edit });
    assert.strictEqual((await open('basic.xlsx', b).sheet(1)).readOnlyReason, 'unsupported-xml-layout');
  }
  // The other sheet is unaffected.
  assert.strictEqual((await wb.sheet(2)).readOnlyReason, null);
});

test('protected-sheet.xlsx -> protected; protected-structure.xlsx -> structureLocked only', async () => {
  const p = open('protected-sheet.xlsx');
  assert.strictEqual(p.structureLocked, false);
  const ps = await p.sheet(1);
  assert.strictEqual(ps.readOnlyReason, 'protected');
  assert.strictEqual(ps.isProtected(), true);
  assert.strictEqual(p.viewOnlyReason, null, 'sheet protection is not workbook-wide');

  const w = open('protected-structure.xlsx');
  assert.strictEqual(w.structureLocked, true);
  assert.strictEqual(w.viewOnlyReason, null);
  for (const e of w.sheets) assert.strictEqual((await w.sheet(e.id)).readOnlyReason, null, `${e.name} stays editable`);
  assert.strictEqual(open('basic.xlsx').structureLocked, false);
});

test('date1904 flag', () => {
  assert.strictEqual(open('date1904.xlsx').date1904, true);
  assert.strictEqual(open('basic.xlsx').date1904, false);
});

test('chartsheet entry has kind chartsheet and no part parse', async () => {
  const bytes = await patchedFixture('basic.xlsx', {
    'xl/workbook.xml': replaceOnce('<sheet name="Second Sheet" sheetId="2" r:id="rId2"/>',
      '<sheet name="Second Sheet" sheetId="2" r:id="rId2"/><sheet name="Chart1" sheetId="7" state="hidden" r:id="rId99"/>'),
    'xl/_rels/workbook.xml.rels': replaceOnce('</Relationships>',
      '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>'),
    '[Content_Types].xml': replaceOnce('</Types>',
      '<Override PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/></Types>'),
    // Deliberately malformed: any parse of this part would throw.
    'xl/chartsheets/sheet1.xml': () => '<chartsheet><unclosed></chartsheet>',
  });
  const wb = open('basic.xlsx', bytes);
  const e = wb.sheets[2];
  assert.deepStrictEqual(e, { id: 3, name: 'Chart1', part: 'xl/chartsheets/sheet1.xml', kind: 'chartsheet', state: 'hidden', rId: 'rId99', fileSheetId: 7 });
  await assert.rejects(wb.sheet(3), (err) => err instanceof SheetLoadError && err.failure === 'not-worksheet');
  await assert.rejects(wb.sheet(42), (err) => err instanceof SheetLoadError && err.failure === 'unknown-sheet');
  assert.strictEqual((await wb.sheet(1)).readOnlyReason, null, 'worksheets still load');
  assert.strictEqual(wb.allocateSheetId(), 4);
});

test('large.xlsx index builds within the WP-01 S4 budget', async (t) => {
  const bytes = fixture('large.xlsx');
  globalThis.gc?.();
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const wb = open('large.xlsx', bytes);
  const s = await wb.sheet(1);
  const total = performance.now() - t0;
  const rss = (process.memoryUsage().rss - rss0) / 1048576;
  const t1 = performance.now();
  s.rebuildIndex();
  const indexMs = performance.now() - t1;
  t.diagnostic(`large.xlsx: parse+index ${total.toFixed(0)} ms (index alone ${indexMs.toFixed(0)} ms), RSS +${rss.toFixed(0)} MB`);
  assert.strictEqual(s.nonEmptyCellCount, 200_000);
  assert.deepStrictEqual(s.dimensions(), { rows: 4000, cols: 50 });
  assert.strictEqual(s.readOnlyReason, null);
  assert.strictEqual(s.truncatedAtRow, null);
  assert.strictEqual(s.cellsIn([0, 0, 3999, 49]).length, 200_000);
  // S4 budget: parse < 3 s, RSS growth < 400 MB. The XML parse itself (WP-05) dominates; the index
  // built here must stay a small fraction of it. Totals are asserted with headroom because test files
  // run concurrently; the report quotes isolated numbers.
  assert.ok(indexMs < 1000, `index build ${indexMs.toFixed(0)} ms`);
  assert.ok(total < 10_000, `parse+index ${total.toFixed(0)} ms is over the S4 "worker thread" threshold`);
  assert.ok(rss < 400, `RSS growth ${rss.toFixed(0)} MB`);
});

test('over-limit sheet (makeHugeXlsx) -> workbook view-only, truncatedAtRow 50000', async () => {
  const { makeHugeXlsx } = await import(pathToFileURL(path.join(here, '..', '..', 'scripts', 'office-fixtures', 'make-synthetic.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-huge-'));
  try {
    // 50,010 rows x 10 = 500,100 non-empty cells: over the cell limit and past the row cap.
    const file = await makeHugeXlsx(tmp, { rows: 50_010, cols: 10 });
    const wb = open('huge.xlsx', new Uint8Array(fs.readFileSync(file)));
    assert.strictEqual(wb.viewOnlyReason, null, 'unknown until the sheet is loaded');
    const s = await wb.sheet(1);
    assert.strictEqual(s.nonEmptyCellCount, 500_100);
    assert.ok(s.nonEmptyCellCount > LIMITS.xlsxMaxCells);
    assert.strictEqual(s.overLimits, true);
    assert.strictEqual(s.readOnlyReason, 'too-large');
    assert.strictEqual(wb.viewOnlyReason, 'too-large');
    assert.strictEqual(s.truncatedAtRow, 50_000);
    assert.deepStrictEqual(s.dimensions(), { rows: 50_000, cols: 10 });
    assert.ok(s.cell(49_999, 9));
    assert.strictEqual(s.cell(50_000, 0), undefined, 'rows past the cap are not indexed');
    assert.strictEqual(s.rowNode(50_005), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Further coverage

test('formulas.xlsx: shared, array, plain formulas and the NoCache sheet', async () => {
  const wb = open('formulas.xlsx');
  assert.deepStrictEqual(wb.sheets.map((e) => e.name), ['Data', 'My Sheet', "O'Brien", 'NoCache']);
  const s = await wb.sheet(1);
  const b2 = s.cell(1, 1);
  assert.strictEqual(b2.formula, 'A2*2');
  assert.deepStrictEqual(b2.shared, { si: 0, master: true, ref: 'B2:B10' });
  const b3 = s.cell(2, 1);
  assert.deepStrictEqual(b3.shared, { si: 0, master: false });
  assert.strictEqual(b3.formula, undefined, 'a dependant has no formula text of its own');
  assert.deepStrictEqual(s.sharedMaster(0), { si: 0, r: 1, c: 1, formula: 'A2*2', ref: [1, 1, 9, 1], refText: 'B2:B10' });
  assert.strictEqual(s.sharedMaster(5), undefined);
  const e2 = s.cell(1, 4);
  assert.strictEqual(e2.arrayRef, 'E2:E4');
  assert.strictEqual(e2.formula, 'A2:A4*10');
  assert.deepStrictEqual(s.arrayFormulaRanges(), [[1, 4, 3, 4]]);
  assert.strictEqual(s.cell(2, 4).formula, undefined, 'array member has no f');
  assert.strictEqual(s.cell(2, 5).formula, '_xlfn.IFS(A3>5,"big",TRUE,"small")', 'entities decoded');
  const f4 = s.cell(3, 5);
  assert.deepStrictEqual(f4.value, { k: 's', v: '' }, 't="str" with <v/> is an empty string result');
  assert.strictEqual(f4.hasCachedValue, true);
  assert.deepStrictEqual(s.cell(4, 5).value, { k: 'e', v: '#DIV/0!' });

  const nc = await wb.sheet(4);
  for (let r = 0; r < 4; r++) {
    const c = nc.cell(r, 0);
    assert.ok(c.formula, `NoCache A${r + 1} has a formula`);
    assert.strictEqual(c.hasCachedValue, false);
    assert.deepStrictEqual(c.value, { k: 'z' });
  }
});

test('styles.xlsx: cols, rows, merges, frozen panes, defaults', async () => {
  const s = await open('styles.xlsx').sheet(1);
  assert.deepStrictEqual(s.pane(), { frozenRows: 1, frozenCols: 1 });
  assert.deepStrictEqual(s.merges(), [[13, 0, 13, 2], [12, 4, 14, 4], [15, 0, 16, 1]]);
  const cols = s.cols();
  assert.deepStrictEqual(cols[0], { min: 0, max: 0, widthChars: 14.59765625, hidden: false, styleIndex: null });
  assert.deepStrictEqual(cols.find((c) => c.hidden), { min: 11, max: 11, widthChars: 0, hidden: true, styleIndex: null });
  assert.deepStrictEqual(s.rowInfo(0), { heightPt: 18, hidden: false, styleIndex: null });
  assert.deepStrictEqual(s.rowInfo(20), { heightPt: null, hidden: true, styleIndex: null });
  assert.deepStrictEqual(s.rowInfo(21), { heightPt: 42, hidden: false, styleIndex: null });
  assert.strictEqual(s.rowInfo(500), undefined);
  assert.strictEqual(s.formatDefaults().defaultRowHeightPt, 14.25);
  assert.strictEqual(s.formatDefaults().baseColWidth, 8);
});

test('features.xlsx hyperlinks and tables.xlsx tables', async () => {
  const f = await open('features.xlsx').sheet(1);
  assert.deepStrictEqual([...f.hyperlinks()], [['K2', 'https://example.com/'], ['K3', "#'PivotData'!A1"]]);
  const t = await open('tables.xlsx').sheet(1);
  assert.deepStrictEqual(t.tables(), [
    { part: 'xl/tables/table1.xml', name: 'SalesTable', ref: [0, 0, 6, 4], headerRows: 1, totalsRows: 1 },
    { part: 'xl/tables/table2.xml', name: 'Scores', ref: [9, 0, 12, 1], headerRows: 1, totalsRows: 0 },
  ]);
  assert.deepStrictEqual(t.hyperlinks().size, 0);
});

test('cellsIn: row-major order, clipped to the range', async () => {
  const s = await open('basic.xlsx').sheet(1);
  const cells = s.cellsIn([1, 1, 3, 2]);
  assert.deepStrictEqual(cells.map((c) => [c.r, c.c]), [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]);
  assert.deepStrictEqual(s.cellsIn([5, 2, 4, 2]), [], 'inverted range is empty');
  const all = s.cellsIn([0, 0, 1_048_575, 16_383]);
  assert.deepStrictEqual(all, s.cellsIn([0, 0, 22, 2]));
  assert.ok(all.length > 60);
});

test('rowNode/cellNode are the tree nodes; rebuildIndex follows tree changes', async () => {
  const wb = open('basic.xlsx');
  const s = await wb.sheet(1);
  const x = core.xml;
  const row2 = s.rowNode(1);
  assert.strictEqual(row2.local, 'row');
  assert.strictEqual(x.attr(row2, '', 'r'), '2');
  const b2 = s.cellNode(1, 1);
  assert.strictEqual(b2.parent, row2);
  assert.strictEqual(x.attr(b2, '', 'r'), 'B2');
  // Remove row 2 and add a cell D2-less row change: the index follows after rebuildIndex.
  const sheetData = row2.parent;
  x.removeAt(sheetData, sheetData.children.indexOf(row2));
  const row3 = s.rowNode(2);
  x.insertAt(row3, row3.children.length, '<c r="D3"><v>9</v></c>');
  s.rebuildIndex();
  assert.strictEqual(s.rowNode(1), undefined);
  assert.strictEqual(s.cell(1, 1), undefined);
  assert.deepStrictEqual(s.cell(2, 3).value, { k: 'n', v: 9 });
  assert.deepStrictEqual(s.dimensions(), { rows: 23, cols: 4 });
});

test('a1ToRc / rcToA1 / a1ToRange', () => {
  assert.deepStrictEqual(a1ToRc('A1'), [0, 0]);
  assert.deepStrictEqual(a1ToRc('B3'), [2, 1]);
  assert.deepStrictEqual(a1ToRc('$AA$10'), [9, 26]);
  assert.deepStrictEqual(a1ToRc('xfd1048576'), [1_048_575, 16_383]);
  for (const bad of ['', 'A', '1', 'A0', 'A01', 'XFE1', 'A1048577', 'A1:B2', 'AAAA1', 'A-1', 'Sheet!A1']) {
    assert.throws(() => a1ToRc(bad), undefined, bad);
  }
  for (const [r, c] of [[0, 0], [9, 25], [99, 26], [1_048_575, 16_383], [5, 701], [5, 702]]) {
    assert.deepStrictEqual(a1ToRc(rcToA1(r, c)), [r, c]);
  }
  assert.strictEqual(rcToA1(0, 701), 'ZZ1');
  assert.strictEqual(rcToA1(0, 702), 'AAA1');
  assert.throws(() => rcToA1(-1, 0));
  assert.throws(() => rcToA1(0, 16_384));
  assert.deepStrictEqual(a1ToRange('C3:A1'), [0, 0, 2, 2]);
  assert.deepStrictEqual(a1ToRange('B2'), [1, 1, 1, 1]);
  assert.strictEqual(a1ToRange('A:A'), undefined);
  assert.strictEqual(rangeToA1([0, 0, 2, 2]), 'A1:C3');
  assert.strictEqual(rangeToA1([1, 1, 1, 1]), 'B2');
});

test('damaged worksheet part rejects with SheetLoadError damaged; workbook still loads', async () => {
  const bytes = await patchedFixture('basic.xlsx', { 'xl/worksheets/sheet2.xml': (t) => t.replace('</worksheet>', '') });
  const wb = open('basic.xlsx', bytes);
  await assert.rejects(wb.sheet(2), (err) => err instanceof SheetLoadError && err.failure === 'damaged');
  assert.strictEqual((await wb.sheet(1)).readOnlyReason, null);
});

test('every openable xlsx fixture loads and indexes every worksheet', async () => {
  for (const name of ['basic.xlsx', 'styles.xlsx', 'formulas.xlsx', 'tables.xlsx', 'features.xlsx', 'date1904.xlsx',
    'protected-sheet.xlsx', 'protected-structure.xlsx', 'no-date-style.xlsx', 'no-date-style-nocount.xlsx',
    'no-styles.xlsx', 'inline-strings.xlsx', 'no-shared-strings.xlsx', 'prefixed-namespaces.xlsx', 'data-descriptors.xlsx']) {
    const wb = open(name);
    assert.ok(wb.sheets.length > 0, name);
    for (const e of wb.sheets) {
      assert.strictEqual(e.kind, 'worksheet', `${name} ${e.name}`);
      const s = await wb.sheet(e.id);
      const d = s.dimensions();
      assert.ok(d.rows >= 0 && d.cols >= 0);
    }
    if (name === 'no-styles.xlsx') assert.strictEqual(wb.stylesPart, null);
  }
});
