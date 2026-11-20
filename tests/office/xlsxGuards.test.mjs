// WP-39: Tier B / Tier C guards for structural edits (src/office/core/xlsx/guards.ts).
// Spec §9.6 Tier B (refused, message names the cause, nothing changes) and Tier C (confirmation list
// naming what will not follow the cells), §9.7 sheet confirmations and refusals.
//
// Every guard call is followed by G0 and a byte comparison: guards are pure inspection.
// Fixtures: features, tables, formulas, chartsheet, hidden-sheets, protected-structure, basic; synthetic
// packages are patched from them in-test for conditions no fixture has (3-D references, threaded
// comments, slicers/shapes/form controls, data tables, protected dependants, last visible sheet).
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import { core, fixture, assertBytesEqual } from './_helpers.mjs';
import { assertG0 } from './_roundtrip.mjs';

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { checkStructuralOp } = core.xlsx.guards;
const { applyXlsxEdit, refreshAfterEdit } = core.xlsx.ops;
const { applyEdit, invertEdit } = core.edits;
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

const partOf = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}

const idOf = (wb, name) => {
  const e = wb.sheets.find((s) => s.name === name);
  assert.ok(e, `sheet ${name}`);
  return e.id;
};

/** Run the guard, then prove the package is untouched (G0 + the serialised bytes equal the input). */
async function guard(ctx, op) {
  const res = await checkStructuralOp(ctx.wb, ctx.pkg, op);
  assert.deepStrictEqual(ctx.pkg.touchedParts(), [], 'guard touched no part');
  assertG0(ctx.pkg);
  assertBytesEqual(ctx.pkg.serialize(), ctx.bytes, 'package bytes after guard');
  assert.ok(!(res.blocked && res.confirm), 'never both blocked and confirm');
  return res;
}

const rows = (ctx, sheet, kind, at, count = 1) => guard(ctx, { op: kind === 'insert' ? 'insertRows' : 'deleteRows', sheetId: idOf(ctx.wb, sheet), at, count });
const cols = (ctx, sheet, kind, at, count = 1) => guard(ctx, { op: kind === 'insert' ? 'insertCols' : 'deleteCols', sheetId: idOf(ctx.wb, sheet), at, count });

function assertBlocked(res, ...needles) {
  assert.ok(res.blocked, `expected a refusal, got ${JSON.stringify(res)}`);
  for (const n of needles) assert.ok(res.blocked.includes(n), `refusal "${res.blocked}" should mention ${JSON.stringify(n)}`);
}
function assertConfirm(res, ...needles) {
  assert.ok(!res.blocked, `unexpected refusal: ${res.blocked}`);
  assert.ok(res.confirm && res.confirm.length > 0, `expected a confirmation list, got ${JSON.stringify(res)}`);
  const text = res.confirm.join('\n');
  for (const n of needles) assert.ok(text.includes(n), `confirmation\n${text}\nshould mention ${JSON.stringify(n)}`);
}
function assertOk(res) {
  assert.deepStrictEqual(res, {}, `expected no guard result, got ${JSON.stringify(res)}`);
}

/** Patched copy of a fixture: { part: (text) => text }; a function on a missing part receives ''. */
async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) {
    const f = zip.file(part);
    zip.file(part, fn(f ? await f.async('string') : ''));
  }
  return load(name, new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })));
}
const replaceOnce = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from}`); return t.replace(from, to); };

// ---------------------------------------------------------------------------------------------------
// Tier B — insert/delete rows and columns

test('B: position or count off the sheet', async () => {
  const ctx = load('tables.xlsx');
  assertBlocked(await rows(ctx, 'Sales', 'insert', 5, MAX_ROWS), 'run past row 1,048,576');
  assertBlocked(await rows(ctx, 'Sales', 'delete', MAX_ROWS - 2, 5), 'run past row 1,048,576');
  assertBlocked(await guard(ctx, { op: 'insertRows', sheetId: 1, at: -1, count: 1 }), 'invalid');
  assertBlocked(await guard(ctx, { op: 'insertRows', sheetId: 99, at: 0, count: 1 }), 'no sheet');
});

test('B: content pushed past row 1,048,576 or column XFD', async () => {
  const ctx = load('tables.xlsx');
  // The Scores table ends on row 13: inserting MAX-10 rows above it pushes it off the sheet.
  assertBlocked(await rows(ctx, 'Sales', 'insert', 0, MAX_ROWS - 10), 'pushed past row 1,048,576');
  // Below all content nothing is pushed off.
  assertOk(await rows(ctx, 'Sales', 'insert', 20, MAX_ROWS - 30));
  const basic = load('basic.xlsx');
  assertBlocked(await cols(basic, basic.wb.sheets[0].name, 'insert', 0, MAX_COLS - 2), 'pushed past column XFD');
});

test('B: array formula split or partly deleted (formulas.xlsx E2:E4)', async () => {
  const ctx = load('formulas.xlsx');
  assertBlocked(await rows(ctx, 'Data', 'insert', 2), 'split the array formula E2:E4', '"Data"');
  assertBlocked(await rows(ctx, 'Data', 'delete', 3, 2), 'delete part of the array formula E2:E4');
  // Inserting at its top edge moves it whole; deleting all of its rows deletes it whole.
  assertOk(await rows(ctx, 'Data', 'insert', 1));
  assertOk(await rows(ctx, 'Data', 'delete', 1, 3));
  // Column operations never split a one-column array.
  assertOk(await cols(ctx, 'Data', 'insert', 4));
});

async function dataTableBook() {
  return patched('basic.xlsx', {
    'xl/worksheets/sheet1.xml': replaceOnce('</sheetData>',
      '<row r="30"><c r="B30"><f t="dataTable" ref="B30:B32" dt2D="0" dtr="0" r1="A1"/><v>1</v></c></row></sheetData>'),
  });
}

test('B: data table split, partly deleted, or moved (input cells are not rewritten)', async () => {
  const ctx = await dataTableBook();
  const name = ctx.wb.sheets[0].name;
  assertBlocked(await rows(ctx, name, 'insert', 30), 'split the data table B30:B32');
  assertBlocked(await rows(ctx, name, 'delete', 31), 'delete part of the data table B30:B32');
  assertBlocked(await rows(ctx, name, 'insert', 25), 'move the data table B30:B32', 'input cell A1');
  assertBlocked(await cols(ctx, name, 'insert', 0), 'move the data table B30:B32');
  assertOk(await rows(ctx, name, 'insert', 40));
  assertOk(await cols(ctx, name, 'insert', 5));
});

test('B: column operation intersecting a table (tables.xlsx)', async () => {
  const ctx = load('tables.xlsx');
  assertBlocked(await cols(ctx, 'Sales', 'insert', 2), 'insertion point is inside', 'table "SalesTable" (A1:E7)');
  assertBlocked(await cols(ctx, 'Sales', 'delete', 4), 'columns intersect', 'table "SalesTable"');
  assertBlocked(await cols(ctx, 'Sales', 'delete', 0), 'columns intersect');
  // Entirely to the left (at the left edge) or to the right of both tables.
  assertOk(await cols(ctx, 'Sales', 'insert', 0));
  assertOk(await cols(ctx, 'Sales', 'insert', 5));
  assertOk(await cols(ctx, 'Sales', 'delete', 6, 2));
});

test('B: row deletes that remove a table header row, totals row or all data rows', async () => {
  const ctx = load('tables.xlsx');
  assertBlocked(await rows(ctx, 'Sales', 'delete', 0), 'delete the header row of table "SalesTable"');
  assertBlocked(await rows(ctx, 'Sales', 'delete', 6), 'delete the totals row of table "SalesTable"');
  assertBlocked(await rows(ctx, 'Sales', 'delete', 1, 5), 'delete all data rows of table "SalesTable"');
  assertBlocked(await rows(ctx, 'Sales', 'delete', 9), 'delete the header row of table "Scores" (A10:B13)');
  // Some data rows, inserts within the data area, and rows between the tables are fine.
  assertOk(await rows(ctx, 'Sales', 'delete', 2, 2));
  assertOk(await rows(ctx, 'Sales', 'insert', 3, 2));
  assertOk(await rows(ctx, 'Sales', 'insert', 0));
  assertOk(await rows(ctx, 'Sales', 'delete', 7, 2));
});

test('B: legacy note at or beyond the index (features.xlsx note on A2)', async () => {
  const ctx = load('features.xlsx');
  assertBlocked(await rows(ctx, 'Features', 'insert', 0), 'note at A2', 'at or below row 1');
  assertBlocked(await rows(ctx, 'Features', 'delete', 1), 'note at A2');
  assertBlocked(await cols(ctx, 'Features', 'insert', 0), 'note at A2', 'at or to the right of column A');
});

async function threadedBook() {
  return patched('basic.xlsx', {
    'xl/worksheets/_rels/sheet1.xml.rels': () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/>'
      + '</Relationships>',
    'xl/threadedComments/threadedComment1.xml': () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">'
      + '<threadedComment ref="C5" dT="2026-01-01T00:00:00.00" personId="{00000000-0000-0000-0000-000000000001}" id="{00000000-0000-0000-0000-000000000002}"><text>Hi</text></threadedComment>'
      + '</ThreadedComments>',
  });
}

test('B: threaded comment at or beyond the index (synthetic)', async () => {
  const ctx = await threadedBook();
  const name = ctx.wb.sheets[0].name;
  assertBlocked(await rows(ctx, name, 'insert', 4), 'comment at C5', 'at or below row 5');
  assertBlocked(await cols(ctx, name, 'delete', 1), 'comment at C5', 'column B');
  assertOk(await rows(ctx, name, 'insert', 5));
  assertOk(await cols(ctx, name, 'insert', 3));
});

test('B: pivot table on the sheet at or beyond the index (features.xlsx Pivot!A3:E10)', async () => {
  const ctx = load('features.xlsx');
  assertBlocked(await rows(ctx, 'Pivot', 'insert', 0), 'pivot table "PivotTable1" (A3:E10)', 'at or below row 1');
  assertBlocked(await rows(ctx, 'Pivot', 'delete', 9), 'pivot table "PivotTable1"');
  assertBlocked(await cols(ctx, 'Pivot', 'insert', 4), 'pivot table "PivotTable1"', 'column E');
  assertOk(await rows(ctx, 'Pivot', 'insert', 10));
  assertOk(await cols(ctx, 'Pivot', 'insert', 5));
});

async function threeDBook() {
  return patched('formulas.xlsx', {
    'xl/worksheets/sheet2.xml': replaceOnce('<c r="A1"><v>10</v></c>', '<c r="A1"><v>10</v></c><c r="B1"><f>SUM(\'Data:O\'\'Brien\'!A1)</f><v>0</v></c>'),
  });
}

test('B: 3-D reference spanning the edited sheet, in a cell formula (synthetic)', async () => {
  const ctx = await threeDBook();
  assertBlocked(await rows(ctx, 'Data', 'insert', 0), "'My Sheet'!B1", '3-D reference', '"Data"');
  assertBlocked(await cols(ctx, "O'Brien", 'insert', 0), '3-D reference', `"O'Brien"`);
  assertBlocked(await rows(ctx, 'My Sheet', 'delete', 5), '3-D reference');   // inside the span
  // NoCache lies outside Data:O'Brien.
  assertOk(await rows(ctx, 'NoCache', 'insert', 0));
});

test('B: 3-D reference spanning the edited sheet, in a defined name (synthetic)', async () => {
  const ctx = await patched('formulas.xlsx', {
    'xl/workbook.xml': replaceOnce('<definedNames>', '<definedNames><definedName name="Span">\'My Sheet:NoCache\'!$A$1</definedName>'),
  });
  assertBlocked(await rows(ctx, "O'Brien", 'insert', 0), 'defined name "Span"', '3-D reference');
  assertOk(await rows(ctx, 'Data', 'insert', 50));
});

async function protectedDependantBook() {
  return patched('formulas.xlsx', {
    'xl/worksheets/sheet2.xml': replaceOnce('</sheetData>', '</sheetData><sheetProtection sheet="1"/>'),
  });
}

test('B: another worksheet that must be rewritten is protected (synthetic)', async () => {
  const ctx = await protectedDependantBook();
  // 'My Sheet'!A2 = Data!A2+…: inserting above row 2 of Data must rewrite it.
  assertBlocked(await rows(ctx, 'Data', 'insert', 0), '"My Sheet" refers to cells on "Data"', "'My Sheet'!A2", 'protected');
  // Below every reference into Data nothing on 'My Sheet' changes.
  assertOk(await rows(ctx, 'Data', 'insert', 50));
});

test('B: another worksheet that must be checked cannot be read (damaged-sheet.xlsx)', async () => {
  const ctx = load('damaged-sheet.xlsx');
  const res = await rows(ctx, ctx.wb.sheets[0].name, 'insert', 0);
  assertBlocked(res, '"Damaged Sheet" can\'t be read');
});

test('B: the edited sheet is not a worksheet (chartsheet.xlsx)', async () => {
  const ctx = load('chartsheet.xlsx');
  assertBlocked(await rows(ctx, 'Chart Sheet', 'insert', 0), '"Chart Sheet" is not a worksheet');
});

// ---------------------------------------------------------------------------------------------------
// Tier C — insert/delete rows and columns

test('C: drawings anchored at or beyond the index (features.xlsx chart and image)', async () => {
  const ctx = load('features.xlsx');
  // Rows 12–26 hold the chart and the picture; row 5 is below the note and every chart/sparkline range.
  const res = await rows(ctx, 'Features', 'insert', 4);
  assertConfirm(res, '1 chart and 1 image on "Features" at or below row 5 will keep their position');
  assert.strictEqual(res.confirm.length, 1, res.confirm.join('\n'));
  // Column L is right of everything on the sheet.
  assertOk(await cols(ctx, 'Features', 'insert', 11));
  // Column J: only the picture (I–K) reaches it.
  assertConfirm(await cols(ctx, 'Features', 'insert', 9), '1 image on "Features" at or to the right of column J will keep its position');
});

test('C: slicers, shapes and legacy form controls anchored at or beyond the index (synthetic)', async () => {
  const anchor = (row, body) => `<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 3}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${body}<xdr:clientData/></xdr:twoCellAnchor>`;
  const slicer = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:sle15="http://schemas.microsoft.com/office/drawing/2012/slicer" Requires="sle15">'
    + '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="9" name="Region"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2010/slicer"><sle:slicer xmlns:sle="http://schemas.microsoft.com/office/drawing/2010/slicer" name="Region"/></a:graphicData></a:graphic></xdr:graphicFrame>'
    + '</mc:Choice><mc:Fallback/></mc:AlternateContent>';
  const shape = '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="10" name="Rect"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>';
  const button = '<v:shape id="_x0000_s1030" type="#_x0000_t201"><x:ClientData ObjectType="Button"><x:Anchor>\n 2, 0, 40, 0, 4, 0, 42, 0</x:Anchor></x:ClientData></v:shape>';
  const ctx = await patched('features.xlsx', {
    'xl/drawings/drawing1.xml': replaceOnce('</xdr:wsDr>', anchor(30, slicer) + anchor(5, shape) + '</xdr:wsDr>'),
    'xl/drawings/vmlDrawing1.vml': replaceOnce(' </v:shape></xml>', ' </v:shape>' + button + '</xml>'),
  });
  assertConfirm(await rows(ctx, 'Features', 'insert', 20), '1 chart, 1 slicer and 1 form control on "Features" at or below row 21');
  assertConfirm(await rows(ctx, 'Features', 'insert', 4), '1 chart, 1 image, 1 shape, 1 slicer and 1 form control');
  assertConfirm(await rows(ctx, 'Features', 'insert', 35), '1 form control on "Features" at or below row 36 will keep its position');
  assertOk(await rows(ctx, 'Features', 'insert', 45));
});

test('C: chart series that reference moved cells (chartsheet.xlsx: chart1 on Features, chart2 on the chart sheet)', async () => {
  const ctx = load('chartsheet.xlsx');
  // Row 4 holds the third series (Features!$B$4:$E$4).
  const res = await rows(ctx, 'Features', 'insert', 3);
  assertConfirm(res, '2 charts (chart1, chart2) plot cells on "Features" that move; the chart ranges will not be adjusted.');
  // Rows below every series: no chart line (only the drawings line).
  const below = await rows(ctx, 'Features', 'insert', 4);
  assert.ok(!below.confirm.join('\n').includes('chart ranges'), below.confirm.join('\n'));
});

test('C: pivot-cache source on the sheet that moves (features.xlsx PivotData!A1:C8)', async () => {
  const ctx = load('features.xlsx');
  assertConfirm(await rows(ctx, 'PivotData', 'insert', 0), 'The source range of pivot table "PivotTable1" (PivotData!A1:C8) will not be adjusted.');
  assertConfirm(await cols(ctx, 'PivotData', 'delete', 1), 'pivot table "PivotTable1"');
  assertOk(await rows(ctx, 'PivotData', 'insert', 20));
});

test('C: extLst ranges (Excel 2010+ conditional format and sparklines on features.xlsx)', async () => {
  const ctx = load('features.xlsx');
  const res = await rows(ctx, 'Features', 'insert', 3);
  assertConfirm(res, 'Excel 2010+ ranges on "Features" will not be adjusted: 1 sparkline and 1 conditional format.');
  const res2 = await cols(ctx, 'Features', 'insert', 1);
  assertConfirm(res2, 'Excel 2010+ ranges on "Features" will not be adjusted: 3 sparklines and 1 conditional format.');
});

test('C: internal hyperlinks pointing at moved cells (features.xlsx K3 → PivotData!A1)', async () => {
  const ctx = load('features.xlsx');
  assertConfirm(await rows(ctx, 'PivotData', 'insert', 0), '1 hyperlink points at cells on "PivotData" that move');
});

// ---------------------------------------------------------------------------------------------------
// Sheets (§9.7)

test('sheets: structure-protected workbook refuses add, rename and delete; rows still pass', async () => {
  const ctx = load('protected-structure.xlsx');
  const id = ctx.wb.sheets[0].id;
  assertBlocked(await guard(ctx, { op: 'addSheet' }), 'workbook structure is protected');
  assertBlocked(await guard(ctx, { op: 'renameSheet', sheetId: id, name: 'X' }), 'workbook structure is protected');
  assertBlocked(await guard(ctx, { op: 'deleteSheet', sheetId: id }), 'workbook structure is protected');
});

test('sheets: add is allowed without confirmation', async () => {
  const ctx = load('features.xlsx');
  assertOk(await guard(ctx, { op: 'addSheet', name: 'New' }));
});

test('sheets: rename confirms charts and pivot sources that name the sheet', async () => {
  const cs = load('chartsheet.xlsx');
  assertConfirm(await guard(cs, { op: 'renameSheet', sheetId: idOf(cs.wb, 'Features'), name: 'F2' }),
    '2 charts (chart1, chart2) reference "Features" by name and will not be updated.');
  const ft = load('features.xlsx');
  assertConfirm(await guard(ft, { op: 'renameSheet', sheetId: idOf(ft.wb, 'PivotData'), name: 'Src' }),
    '1 pivot table source (PivotTable1) reference "PivotData" by name and will not be updated.',
    '1 hyperlink points at "PivotData" and will not be updated.');
  // Sparklines on Features name Features in their formulas.
  assertConfirm(await guard(ft, { op: 'renameSheet', sheetId: idOf(ft.wb, 'Features'), name: 'F' }), 'Excel 2010+ ranges that name "Features" will not be updated: 3 sparklines.');
  // Nothing names "Pivot".
  assertOk(await guard(ft, { op: 'renameSheet', sheetId: idOf(ft.wb, 'Pivot'), name: 'P' }));
});

test('sheets: rename refused when a worksheet naming the sheet is protected (synthetic)', async () => {
  const ctx = await protectedDependantBook();
  assertBlocked(await guard(ctx, { op: 'renameSheet', sheetId: idOf(ctx.wb, 'Data'), name: 'D' }), '"My Sheet" refers to "Data"', 'protected');
  assertOk(await guard(ctx, { op: 'renameSheet', sheetId: idOf(ctx.wb, 'NoCache'), name: 'N' }));
});

test('sheets: delete refused for a chartsheet, the last visible worksheet, and a pivot source', async () => {
  const cs = load('chartsheet.xlsx');
  assertBlocked(await guard(cs, { op: 'deleteSheet', sheetId: idOf(cs.wb, 'Chart Sheet') }), '"Chart Sheet" is a chart sheet');
  const ft = load('features.xlsx');
  assertBlocked(await guard(ft, { op: 'deleteSheet', sheetId: idOf(ft.wb, 'PivotData') }), 'source data of pivot table "PivotTable1"');
  const hs = await patched('hidden-sheets.xlsx', {
    'xl/workbook.xml': replaceOnce('<sheet name="Second Sheet" sheetId="2"', '<sheet name="Second Sheet" sheetId="2" state="hidden"'),
  });
  assertBlocked(await guard(hs, { op: 'deleteSheet', sheetId: idOf(hs.wb, 'Values') }), '"Values" is the last visible worksheet');
  // A hidden sheet can still go.
  assertConfirm(await guard(hs, { op: 'deleteSheet', sheetId: idOf(hs.wb, 'Hidden Sheet') }), '"Hidden Sheet" and everything on it will be deleted.');
});

test('sheets: delete refused for a pivot source named through a defined name (synthetic)', async () => {
  const ctx = await patched('features.xlsx', {
    'xl/pivotCache/pivotCacheDefinition1.xml': replaceOnce('<worksheetSource ref="A1:C8" sheet="PivotData"/>', '<worksheetSource name="SrcRange"/>'),
    'xl/workbook.xml': replaceOnce('<calcPr', '<definedNames><definedName name="SrcRange">PivotData!$A$1:$C$8</definedName></definedNames><calcPr'),
  });
  assertBlocked(await guard(ctx, { op: 'deleteSheet', sheetId: idOf(ctx.wb, 'PivotData') }), 'pivot table "PivotTable1"');
});

test('sheets: delete always confirms, listing references that become #REF!', async () => {
  const hs = load('hidden-sheets.xlsx');
  const res = await guard(hs, { op: 'deleteSheet', sheetId: idOf(hs.wb, 'Second Sheet') });
  assertConfirm(res, '"Second Sheet" and everything on it will be deleted.');
  const fm = load('formulas.xlsx');
  assertConfirm(await guard(fm, { op: 'deleteSheet', sheetId: idOf(fm.wb, 'My Sheet') }),
    '"My Sheet" and everything on it will be deleted.',
    'formulas on other sheets refer to "My Sheet"; those references will become #REF!.');
  assertConfirm(await guard(fm, { op: 'deleteSheet', sheetId: idOf(fm.wb, 'Data') }), '3 formulas on other sheets and 2 defined names refer to "Data"');
  // features: chart1 lives on Features and goes with it; the chart sheet's chart2 does not.
  const cs = load('chartsheet.xlsx');
  const del = await guard(cs, { op: 'deleteSheet', sheetId: idOf(cs.wb, 'Features') });
  assertConfirm(del, '1 chart (chart2) plots cells on "Features" and will not be updated.');
});

test('sheets: delete refused when a worksheet naming the sheet is protected (synthetic)', async () => {
  const ctx = await protectedDependantBook();
  assertBlocked(await guard(ctx, { op: 'deleteSheet', sheetId: idOf(ctx.wb, 'Data') }), '"My Sheet" refers to "Data"', 'protected');
});

// ---------------------------------------------------------------------------------------------------
// Through applyXlsxEdit (ops.ts): blocked → error, confirm → list, confirmed: true → proceeds

test('ops: Tier B refusal is an error with the guard message; the package is unchanged', async () => {
  const ctx = load('tables.xlsx');
  const res = await applyXlsxEdit(ctx.wb, ctx.pkg, { op: 'insertCols', sheetId: 1, at: 2, count: 1 }, { confirmed: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'blocked');
  assert.match(res.error.message, /table "SalesTable"/);
  assertG0(ctx.pkg);
});

test('ops: Tier C returns the confirm list unapplied; confirmed: true proceeds past the guard', async () => {
  const ctx = load('features.xlsx');
  const sheetId = idOf(ctx.wb, 'Features');
  // Inserting before row 3 moves cells under a chart, an image, chart ranges and x14 ranges (Tier C).
  const op = { op: 'insertRows', sheetId, at: 2, count: 1 };
  const first = await applyXlsxEdit(ctx.wb, ctx.pkg, op, { confirmed: false });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.edit, null, 'unconfirmed: nothing applied');
  assert.strictEqual(first.invalidate, 'sheet');
  assert.ok(first.confirm && first.confirm[0].includes('1 chart and 1 image'), JSON.stringify(first));
  assert.ok(first.confirm.some((c) => c.includes('chart ranges will not be adjusted')), JSON.stringify(first.confirm));
  assert.ok(first.confirm.some((c) => c.includes('sparkline')), JSON.stringify(first.confirm));
  assertG0(ctx.pkg);
  assertBytesEqual(ctx.pkg.serialize(), ctx.bytes, 'confirm list returned unapplied');

  const second = await applyXlsxEdit(ctx.wb, ctx.pkg, op, { confirmed: true });
  assert.ok(second.ok, JSON.stringify(second));
  assert.ok(!second.confirm, 'no confirmation the second time');
  assert.ok(second.edit, 'confirmed: the operation is applied');
  assert.strictEqual(second.edit.label, 'Insert Rows');
  const sheet = await ctx.wb.sheet(sheetId);
  // A3 ("…" row label) moved to A4; row 3 is empty; the read model follows the tree.
  const a3 = partOf(ctx.bytes, 'xl/worksheets/sheet1.xml').match(/<c r="A3" t="s"><v>(\d+)<\/v>/)[1];
  assert.match(ctx.pkg.text('xl/worksheets/sheet1.xml'), new RegExp(`<c r="A4" t="s"><v>${a3}</v>`));
  assert.strictEqual(sheet.cellsIn([2, 0, 2, 15]).length, 0, 'the inserted row is empty');
  assert.deepStrictEqual(sheet.cell(3, 0).value, (await Workbook.load(OfficePackage.open('f.xlsx', ctx.bytes)).sheet(sheetId)).cell(2, 0).value);
  // Undo restores the bytes exactly.
  applyEdit(ctx.pkg, invertEdit(second.edit));
  refreshAfterEdit(ctx.wb, second.edit);
  assertBytesEqual(ctx.pkg.serialize(), ctx.bytes, 'undo');

  // Confirmed but nothing moves (row 5 is below all content): ok, no edit, nothing changed.
  const below = await applyXlsxEdit(ctx.wb, ctx.pkg, { op: 'insertRows', sheetId, at: 4, count: 1 }, { confirmed: true });
  assert.ok(below.ok && below.edit === null && !below.confirm, JSON.stringify(below));
  assertBytesEqual(ctx.pkg.serialize(), ctx.bytes, 'nothing moved');

  // Tier B stays refused even when confirmed (the note at A2), and changes nothing.
  const blocked = await applyXlsxEdit(ctx.wb, ctx.pkg, { op: 'insertRows', sheetId, at: 0, count: 1 }, { confirmed: true });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error.code, 'blocked');
  assert.match(blocked.error.message, /note at A2/);
  assertBytesEqual(ctx.pkg.serialize(), ctx.bytes, 'refused: unchanged');
});

test('ops: deleteSheet always produces a confirmation list (the provider only asks for a non-empty list)', async () => {
  const ctx = load('hidden-sheets.xlsx');
  const res = await applyXlsxEdit(ctx.wb, ctx.pkg, { op: 'deleteSheet', sheetId: idOf(ctx.wb, 'Hidden Sheet') }, { confirmed: false });
  assert.strictEqual(res.ok, true);
  assert.ok(res.confirm && res.confirm.length >= 1);
  assertG0(ctx.pkg);
});

test('cell edits are not structural: no guard result', async () => {
  const ctx = load('basic.xlsx');
  assertOk(await guard(ctx, { op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: '1' }] }));
});
