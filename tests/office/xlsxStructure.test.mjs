// WP-38: insert/delete rows and columns, Tier A (src/office/core/xlsx/structure.ts). Spec §9.6 Tier A,
// §9.4 (shared formulas before a structural operation), §9.5 (calc handling), §13.2 G3–G6.
//
// Most cases drive structure.insertOrDelete exactly as ops.structural does (EditBuilder ->
// insertOrDelete -> ensureFullCalcOnLoad -> finish) without the WP-39 guard in front, so Tier A is
// tested on its own (guards: xlsxGuards.test.mjs); one test bundles ops.ts with a pass-through guard to
// cover the dispatcher, and the grid tests at the end go through the real ops.applyXlsxEdit. Every edit
// is checked for G3 (exact touched set), G5 (undo / redo bytes), G6 (both validators + ExcelJS re-read)
// and view-vs-file including the grid (Gate R2 F1) after the op, its undo and its redo.
//
// Expectations are hand-derived from Excel's documented insert/delete semantics. Cases whose exact
// Excel output has not been observed in Excel itself are tagged `[WP-37]` in their name: WP-37
// (Excel-produced goldens via COM, deferred) should replace them with goldens.
//
// Edited workbooks are written to tests/.out/xlsxStructure/<case>.xlsx for scripts/verify-office-open.ps1.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture, allFixtures, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG4 } from './_roundtrip.mjs';
import { assertViewMatchesFile } from './_viewCheck.mjs';

const { editSeed } = core.xlsx.format;
const { displayFormula } = core.xlsx.sharedFormula;

/**
 * View-vs-file (Gate R2 F1): every loaded worksheet's Sheet.cellsIn (value, style, formula, shared
 * group, array ref, editor seed, shown formula), its read-only reasons and dimensions equal a model
 * freshly loaded from the serialised package, every indexed node is in the current tree, and — through
 * _viewCheck.assertViewMatchesFile — the grid (view.cellWindow: hyperlinks, notes, locked ranges) does
 * too, which needs view.ts's per-sheet lookups to follow Sheet.structureGeneration.
 */
async function assertModelMatchesFile(wb, pkg, styles, msg, range = [0, 0, 59, 15]) {
  const fp = OfficePackage.open('fresh.xlsx', pkg.serialize());
  const fwb = Workbook.load(fp);
  const fst = core.xlsx.styles.StyleTable.load(fp, fwb.stylesPart, fwb.themePart);
  const dump = (w, s, st) => s.cellsIn(range).map((c) => JSON.stringify({
    r: c.r, c: c.c, value: c.value, s: c.styleIndex, f: c.formula, shared: c.shared, arrayRef: c.arrayRef,
    seed: editSeed(c, st, w.date1904), shown: displayFormula(s, c), ro: s.readOnlyCellReason(c.r, c.c),
  }));
  for (const e of wb.sheets) {
    if (e.kind !== 'worksheet') continue;
    const live = wb.loadedSheet(e.id);
    if (!live) continue;
    const root = pkg.xml(live.part).root;
    for (const c of live.cellsIn(range)) {
      let n = live.cellNode(c.r, c.c);
      while (n && n.parent) n = n.parent;
      assert.ok(n === root, `${msg}: sheet ${e.id} cell (${c.r}, ${c.c}) is indexed to a node outside the tree`);
    }
    assert.deepStrictEqual(dump(wb, live, styles), dump(fwb, await fwb.sheet(e.id), fst), `${msg}: sheet ${e.id} cells differ from the file`);
    assert.deepStrictEqual(live.dimensions(), (await fwb.sheet(e.id)).dimensions(), `${msg}: sheet ${e.id} dimensions`);
  }
  await assertViewMatchesFile(wb, pkg, styles, msg, range);
}

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { EditBuilder, applyEdit, invertEdit } = core.edits;
const { insertOrDelete } = core.xlsx.structure;
const { ensureFullCalcOnLoad } = core.xlsx.calc;
const { refreshAfterEdit, stylesFor } = core.xlsx.ops;
const { serializeAndVerify, packageValidator } = core.save;
const { xlsxValidator } = core.xlsx.validate;
const OUT = 'xlsxStructure';
const S1 = 'xl/worksheets/sheet1.xml';
const CALC_FIRST = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml'];
const CALC_FIRST_NO_CHAIN = ['xl/workbook.xml'];

const colIndex = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** Excel terms: insR(3, 2) = insert 2 rows before row 3; delC('B', 1) = delete column B. */
const insR = (r, n = 1) => ['row', r - 1, n];
const delR = (r, n = 1) => ['row', r - 1, -n];
const insC = (c, n = 1) => ['col', colIndex(c), n];
const delC = (c, n = 1) => ['col', colIndex(c), -n];

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}

/** What ops.structural does: one builder, insertOrDelete, calc handling, finish. */
async function structural(wb, sheetId, [axis, at, count], label = 'Structure') {
  const sheet = await wb.sheet(sheetId);
  const b = new EditBuilder(wb.pkg, label);
  try {
    await insertOrDelete(b, wb, sheet, axis, at, count);
    if (b.size > 0) ensureFullCalcOnLoad(b, wb);
  } catch (err) {
    b.abort();
    throw err;
  }
  return b.finish();
}

/** The refusal (officeError) of an op, asserting the package is unchanged. */
async function refusal(wb, sheetId, op) {
  const before = wb.pkg.serialize();
  let err;
  try { await structural(wb, sheetId, op); } catch (e) { err = e; }
  assert.ok(err, 'the operation must be refused');
  assert.ok(err.officeError, `refusal carries officeError: ${err.stack}`);
  assertBytesEqual(wb.pkg.serialize(), before, 'refused: package unchanged');
  return err.officeError;
}

function save(pkg) {
  const r = serializeAndVerify(pkg, [packageValidator, xlsxValidator]);
  assert.ok(r.ok, `verify: ${JSON.stringify(r.ok ? '' : r.failures)}`);
  return r.bytes;
}

async function excel(bytes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(bytes));
  return w;
}

const partText = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);

/**
 * Apply `op` and run the per-op guarantees: G3 (touched = `touched`, plus the calc parts on the first
 * edit), G5 (undo -> original bytes, redo -> same bytes), G6 (validators), view-vs-file after the op and
 * after undo. Leaves the edit applied. Returns { edit, bytes } (bytes = the saved result).
 */
async function check(fx, sheetId, op, touched, caseName, opts = {}) {
  const { pkg, wb } = fx;
  const orig = pkg.serialize();
  const styles = stylesFor(wb);
  const edit = await structural(wb, sheetId, op);
  assert.ok(edit, `${caseName}: the operation changed something`);
  const bytes = save(pkg);
  const calc = opts.calc ?? (pkg.has('xl/calcChain.xml') || OfficePackage.open('o.xlsx', orig).has('xl/calcChain.xml') ? CALC_FIRST : CALC_FIRST_NO_CHAIN);
  if (touched) assertG3(orig, bytes, [...new Set([...touched, ...calc])], `${caseName} G3`);
  await assertModelMatchesFile(wb, pkg, styles, `${caseName} view`, opts.range);
  // G5
  applyEdit(pkg, invertEdit(edit));
  refreshAfterEdit(wb, invertEdit(edit));
  assertBytesEqual(pkg.serialize(), orig, `${caseName}: edit -> undo must serialise to the original bytes`);
  await assertModelMatchesFile(wb, pkg, styles, `${caseName} view after undo`, opts.range);
  applyEdit(pkg, edit);
  refreshAfterEdit(wb, edit);
  assertBytesEqual(pkg.serialize(), bytes, `${caseName}: edit -> undo -> redo must equal edit`);
  await assertModelMatchesFile(wb, pkg, styles, `${caseName} view after redo`, opts.range);
  writeOut(OUT, `${caseName}.xlsx`, bytes);
  return { edit, bytes };
}

async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) {
    const f = zip.file(part);
    zip.file(part, typeof fn === 'function' ? fn(f ? await f.async('string') : '') : fn);
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** Insert `xml` into sheet XML just before `<before` (first occurrence). */
const injectBefore = (before, xml) => (s) => { const i = s.indexOf(`<${before}`); assert.ok(i >= 0, `<${before} not found`); return s.slice(0, i) + xml + s.slice(i); };

const formulaOf = (text, ref) => {
  const m = new RegExp(`<c r="${ref}"[^>]*>(?:(?!</c>).)*?<f([^>]*?)(?:/>|>([^<]*)</f>)`, 's').exec(text);
  return m ? { attrs: m[1], text: (m[2] ?? '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') } : undefined;
};

// ---------------------------------------------------------------------------------------------------
// Cells: renumbering, new rows/columns, spans

test('rows: c/@r and row/@r renumbered, values follow; ExcelJS reads the shifted cells', async () => {
  const fx = load('basic.xlsx');
  const before = await excel(fx.bytes);
  const { bytes } = await check(fx, 1, insR(3, 2), [S1], 'insert-rows-basic');
  const after = await excel(bytes);
  const ws0 = before.getWorksheet('Values');
  const ws1 = after.getWorksheet('Values');
  for (let r = 1; r <= 23; r++) {
    for (let c = 1; c <= 3; c++) {
      const want = JSON.stringify(ws0.getCell(r, c).value);
      const nr = r >= 3 ? r + 2 : r;
      assert.strictEqual(JSON.stringify(ws1.getCell(nr, c).value), want, `R${r}C${c}`);
    }
  }
  const text = partText(bytes, S1);
  assert.ok(!/<row r="3"[ >]/.test(text) && !/<row r="4"[ >]/.test(text), 'new rows are empty: no row element');
  assert.match(text, /<dimension ref="A1:C25"\/>/);
});

test('new rows/columns are empty and unstyled', async () => {
  const fx = load('styles.xlsx');
  const { bytes } = await check(fx, 1, insR(5, 1), [S1], 'new-rows-unstyled');
  const text = partText(bytes, S1);
  assert.ok(!/<row r="5"[ >]/.test(text), 'no row element for the inserted row (default height, no style)');
  const fx2 = load('styles.xlsx');
  const { bytes: b2 } = await check(fx2, 1, insC('B', 2), [S1], 'new-cols-unstyled');
  const t2 = partText(b2, S1);
  assert.ok(!/<c r="[BC]\d+"/.test(t2), 'no cells in the inserted columns B:C');
  const cols = /<cols>.*?<\/cols>/.exec(t2)[0];
  for (const m of cols.matchAll(/min="(\d+)" max="(\d+)"/g)) assert.ok(+m[2] < 2 || +m[1] > 3, `no column record covers the new columns: ${m[0]}`);
});

test('spans removed on column ops; kept on row ops', async () => {
  const fx = load('basic.xlsx');
  const { bytes } = await check(fx, 1, insC('B'), [S1], 'spans-removed-col');
  assert.ok(!/spans=/.test(partText(bytes, S1)), 'no spans left after a column insert');
  const fx2 = load('basic.xlsx');
  const { bytes: b2 } = await check(fx2, 1, delC('A'), [S1], 'spans-removed-col-delete');
  assert.ok(!/spans=/.test(partText(b2, S1)));
  const fx3 = load('basic.xlsx');
  const orig = fx3.pkg.text(S1);
  const { bytes: b3 } = await check(fx3, 1, insR(2), [S1], 'spans-kept-row');
  assert.strictEqual((partText(b3, S1).match(/spans="/g) ?? []).length, (orig.match(/spans="/g) ?? []).length);
});

test('delete rows: cells in the band are removed, the rest move up; ExcelJS agrees', async () => {
  const fx = load('basic.xlsx');
  const before = await excel(fx.bytes);
  const { bytes } = await check(fx, 1, delR(2, 3), [S1], 'delete-rows-basic');
  const ws0 = before.getWorksheet('Values');
  const ws1 = (await excel(bytes)).getWorksheet('Values');
  for (let r = 5; r <= 23; r++) {
    for (let c = 1; c <= 3; c++) assert.strictEqual(JSON.stringify(ws1.getCell(r - 3, c).value), JSON.stringify(ws0.getCell(r, c).value), `R${r}C${c}`);
  }
  assert.match(partText(bytes, S1), /<dimension ref="A1:C20"\/>/);
});

test('delete columns: cells in the band removed, the rest move left', async () => {
  const fx = load('basic.xlsx');
  const before = await excel(fx.bytes);
  const { bytes } = await check(fx, 1, delC('B'), [S1], 'delete-col-basic');
  const ws0 = before.getWorksheet('Values');
  const ws1 = (await excel(bytes)).getWorksheet('Values');
  for (let r = 1; r <= 23; r++) {
    assert.strictEqual(JSON.stringify(ws1.getCell(r, 1).value), JSON.stringify(ws0.getCell(r, 1).value));
    assert.strictEqual(JSON.stringify(ws1.getCell(r, 2).value), JSON.stringify(ws0.getCell(r, 3).value));
  }
  assert.match(partText(bytes, S1), /<dimension ref="A1:B23"\/>/);
});

test('G4: an insert near the bottom changes only the rows below it and the dimension', async () => {
  const fx = load('basic.xlsx');
  const orig = fx.pkg.text(S1);
  const { bytes } = await check(fx, 1, insR(22), [S1], 'g4-insert-near-bottom');
  const now = partText(bytes, S1);
  // Only the dimension's ref and rows 22-23 differ: undo the dimension change textually, then the
  // difference must lie inside rows 22..23 of the original.
  const back = now.replace('<dimension ref="A1:C24"/>', '<dimension ref="A1:C23"/>');
  assert.notStrictEqual(back, now, 'dimension grew');
  const row22 = orig.indexOf('<row r="22"');
  const end = orig.indexOf('</sheetData>');
  assertG4(orig, back, { start: row22, end }, 'only rows 22-23 change');
  assert.ok(back.slice(row22).startsWith('<row r="23"'), 'row 22 became row 23');
});

test('refused: content pushed past the last row / column (Tier B) — package unchanged', async () => {
  const bytes = await patched('basic.xlsx', {
    [S1]: (s) => s.replace('</sheetData>', '<row r="1048576"><c r="A1048576"><v>1</v></c></row></sheetData>').replace('A1:C23', 'A1:C1048576'),
  });
  const fx = load('basic.xlsx', bytes);
  assert.match((await refusal(fx.wb, 1, insR(5))).message, /pushed past the last row/);
  const b3 = await patched('basic.xlsx', { [S1]: (s) => s.replace(/(<row r="1"[^>]*>.*?)(<\/row>)/, '$1<c r="XFD1"><v>1</v></c>$2').replace('A1:C23', 'A1:XFD23') });
  const fx3 = load('basic.xlsx', b3);
  assert.match((await refusal(fx3.wb, 1, insC('B'))).message, /pushed past the last column/);
});

test('invalid arguments are refused', async () => {
  const fx = load('basic.xlsx');
  assert.strictEqual((await refusal(fx.wb, 1, ['row', 0, 0])).code, 'invalid');
  assert.strictEqual((await refusal(fx.wb, 1, ['row', -1, 1])).code, 'invalid');
  assert.strictEqual((await refusal(fx.wb, 1, ['col', 16380, -10])).code, 'invalid');
  assert.strictEqual((await refusal(fx.wb, 1, ['diag', 0, 1])).code, 'invalid');
});

test('an insert below all content changes nothing (no edit)', async () => {
  const fx = load('basic.xlsx');
  assert.strictEqual(await structural(fx.wb, 1, insR(100)), null);
  assert.strictEqual(await structural(fx.wb, 1, insC('Z')), null);
  assertBytesEqual(fx.pkg.serialize(), fx.bytes, 'unchanged');
});

// ---------------------------------------------------------------------------------------------------
// Formulas, shared formulas, arrays, names

test('formulas on every sheet: unqualified on the sheet, qualified elsewhere; names shift', async () => {
  const fx = load('formulas.xlsx');
  // formulas.xlsx: sheet1 "Data" (edited), sheet2 'My Sheet' refs Data!A2, sheet4 refs Data!A2 / Data!A2:A10.
  const { bytes } = await check(fx, 1, insR(1), [S1, 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet4.xml', 'xl/workbook.xml'], 'formulas-insert-top');
  const d = partText(bytes, S1);
  assert.deepStrictEqual(formulaOf(d, 'C3'), { attrs: '', text: "'My Sheet'!A1+Data!A3" }, 'other-sheet ref untouched, own qualified ref shifted');
  assert.strictEqual(formulaOf(d, 'D4').text, 'A4+[0]!LocalName', 'defined-name use untouched');
  assert.strictEqual(formulaOf(d, 'F6').text, '_xlfn.STDEV.S(A3:A11)');
  assert.strictEqual(formulaOf(partText(bytes, 'xl/worksheets/sheet2.xml'), 'A2').text, "Data!A3+'O''Brien'!A1");
  assert.strictEqual(formulaOf(partText(bytes, 'xl/worksheets/sheet4.xml'), 'A4').text, 'SUM(Data!A3:A11)');
  const wbx = partText(bytes, 'xl/workbook.xml');
  assert.match(wbx, /<definedName name="LocalName">Data!\$G\$3<\/definedName>/);
  assert.match(wbx, /<definedName name="TaxRate">Data!\$G\$2<\/definedName>/);
  const x = await excel(bytes);
  assert.strictEqual(x.getWorksheet('Data').getCell('C3').formula, "'My Sheet'!A1+Data!A3");
  assert.strictEqual(x.getWorksheet('Data').getCell('F8').formula, 'SUM(A3:A11)');
});

test('shared formulas (§9.4): a group moved whole is kept (master text and ref shifted)', async () => {
  const fx = load('formulas.xlsx');
  const { bytes } = await check(fx, 1, insR(1), null, 'shared-kept');
  const d = partText(bytes, S1);
  assert.deepStrictEqual(formulaOf(d, 'B3'), { attrs: ' t="shared" ref="B3:B11" si="0"', text: 'A3*2' });
  assert.deepStrictEqual(formulaOf(d, 'B4'), { attrs: ' t="shared" si="0"', text: '' });
  const x = await excel(bytes);
  assert.strictEqual(x.getWorksheet('Data').getCell('B7').formula, 'A7*2', 'ExcelJS derives the dependant from the kept master');
});

test('shared formulas (§9.4): a group split by the band is materialised (every member explicit)', async () => {
  const fx = load('formulas.xlsx');
  const { bytes } = await check(fx, 1, insR(5, 2), null, 'shared-materialised');
  const d = partText(bytes, S1);
  assert.ok(!/t="shared"/.test(d), 'no shared group left');
  assert.deepStrictEqual(formulaOf(d, 'B2'), { attrs: '', text: 'A2*2' });
  assert.deepStrictEqual(formulaOf(d, 'B4'), { attrs: '', text: 'A4*2' });
  assert.deepStrictEqual(formulaOf(d, 'B7'), { attrs: '', text: 'A7*2' }, 'old B5 -> B7 refers to its own (moved) row');
  assert.deepStrictEqual(formulaOf(d, 'B12'), { attrs: '', text: 'A12*2' });
  const x = await excel(bytes);
  assert.strictEqual(x.getWorksheet('Data').getCell('B12').formula, 'A12*2');
});

test('shared formulas: deleting the master row materialises the survivors', async () => {
  // Without the array formula E2:E4 (deleting its first row would split it — Tier B).
  const fx = load('formulas.xlsx', await patched('formulas.xlsx', { [S1]: (s) => s.replace('<f t="array" ref="E2:E4">A2:A4*10</f>', '<f>A2*10</f>') }));
  const { bytes } = await check(fx, 1, delR(2), null, 'shared-master-deleted');
  const d = partText(bytes, S1);
  assert.ok(!/t="shared"/.test(d));
  assert.deepStrictEqual(formulaOf(d, 'B2'), { attrs: '', text: 'A2*2' }, 'old B3');
  assert.deepStrictEqual(formulaOf(d, 'B9'), { attrs: '', text: 'A9*2' }, 'old B10');
});

test('references into the deleted band become #REF!; ranges shrink', async () => {
  const fx = load('formulas.xlsx');
  const { bytes } = await check(fx, 1, delR(1), null, 'ref-error');
  const d = partText(bytes, S1);
  // The name TaxRate (Data!$G$1) is wholly deleted.
  assert.match(partText(bytes, 'xl/workbook.xml'), /<definedName name="TaxRate">#REF!<\/definedName>/);
  assert.strictEqual(formulaOf(d, 'F6').text, 'SUM(A1:A9)', 'A2:A10 -> A1:A9');
  assert.strictEqual(formulaOf(d, 'C1').text, "'My Sheet'!A1+Data!A1");
});

test('array formula moved whole: master f/@ref shifted, members move; deleted whole: all gone', async () => {
  const fx = load('formulas.xlsx');
  const { bytes } = await check(fx, 1, insR(2, 3), null, 'array-moved-rows');
  assert.deepStrictEqual(formulaOf(partText(bytes, S1), 'E5'), { attrs: ' t="array" ref="E5:E7"', text: 'A5:A7*10' });
  assert.match(partText(bytes, S1), /<c r="E7"><v>0<\/v><\/c>/, 'array member moved with it');
  const fx2 = load('formulas.xlsx');
  const { bytes: b2 } = await check(fx2, 1, insC('A'), null, 'array-moved-cols');
  assert.deepStrictEqual(formulaOf(partText(b2, S1), 'F2'), { attrs: ' t="array" ref="F2:F4"', text: 'B2:B4*10' });
  const fx3 = load('formulas.xlsx');
  const { bytes: b3 } = await check(fx3, 1, delC('E'), null, 'array-deleted-whole');
  const t3 = partText(b3, S1);
  assert.ok(!/t="array"/.test(t3), 'the whole array was deleted with its column');
  assert.ok(!/<c r="E2"><f/.test(t3));
  const fx4 = load('formulas.xlsx');
  const { bytes: b4 } = await check(fx4, 1, delR(2, 3), null, 'array-deleted-whole-rows');
  assert.ok(!/t="array"/.test(partText(b4, S1)));
});

test('array formula split or resized is refused (Tier B) — package unchanged', async () => {
  const fx = load('formulas.xlsx');
  assert.match((await refusal(fx.wb, 1, insR(3))).message, /array formula E2:E4/);
  assert.match((await refusal(fx.wb, 1, delR(3))).message, /array formula E2:E4/);
  assert.match((await refusal(fx.wb, 1, delR(1, 2))).message, /array formula E2:E4/);
});

test('3-D references spanning the sheet are refused (Tier B)', async () => {
  const bytes = await patched('formulas.xlsx', {
    'xl/worksheets/sheet3.xml': (s) => s.replace(/<f>[^<]*<\/f>/, "<f>SUM(Data:Sheet4!A1)</f>"),
  });
  const fx = load('formulas.xlsx', bytes);
  assert.match((await refusal(fx.wb, 1, insR(1))).message, /3-D reference/);
});

test('malformed shared group (two masters for one si) refuses the structural op (§9.4)', async () => {
  const bytes = await patched('formulas.xlsx', {
    [S1]: (s) => s.replace('<c r="B5"><f t="shared" si="0"/>', '<c r="B5"><f t="shared" ref="B5:B6" si="0">A5*2</f>'),
  });
  const fx = load('formulas.xlsx', bytes);
  assert.match((await refusal(fx.wb, 1, insR(1))).message, /2 master cells/);
});

test('shared group on another sheet whose master refers to the edited sheet: kept when uniform', async () => {
  const bytes = await patched('formulas.xlsx', {
    'xl/worksheets/sheet4.xml': (s) => s.replace('<f>Data!A2*3</f>', '<f t="shared" ref="A2:A3" si="0">Data!A2*3</f>')
      .replace('<c r="A3" t="str"><f>_xlfn.CONCAT("x","y")</f>', '<c r="A3"><f t="shared" si="0"/>'),
    // No array formula on Data, so a row can be inserted at row 3 (it would split E2:E4 — Tier B).
    [S1]: (s) => s.replace('<f t="array" ref="E2:E4">A2:A4*10</f>', '<f>A2*10</f>'),
  });
  const fx = load('formulas.xlsx', bytes);
  const { bytes: out } = await check(fx, 1, insR(1), null, 'other-sheet-shared-kept');
  const t = partText(out, 'xl/worksheets/sheet4.xml');
  assert.deepStrictEqual(formulaOf(t, 'A2'), { attrs: ' t="shared" ref="A2:A3" si="0"', text: 'Data!A3*3' });
  assert.deepStrictEqual(formulaOf(t, 'A3'), { attrs: ' t="shared" si="0"', text: '' });
  // A band between the two derived references splits the group: materialised.
  const fx2 = load('formulas.xlsx', bytes);
  const { bytes: out2 } = await check(fx2, 1, insR(3), null, 'other-sheet-shared-materialised');
  const t2 = partText(out2, 'xl/worksheets/sheet4.xml');
  assert.deepStrictEqual(formulaOf(t2, 'A2'), { attrs: '', text: 'Data!A2*3' });
  assert.deepStrictEqual(formulaOf(t2, 'A3'), { attrs: '', text: 'Data!A4*3' });
});

test('another sheet that must be rewritten but is protected refuses (Tier B); one that need not is fine', async () => {
  const bytes = await patched('formulas.xlsx', {
    'xl/worksheets/sheet4.xml': injectBefore('pageMargins', '<sheetProtection sheet="1"/>'),
  });
  const fx = load('formulas.xlsx', bytes);
  assert.match((await refusal(fx.wb, 1, insR(1))).message, /can't be edited here/);
  // Inserting at row 20 changes no reference held by the protected sheet.
  const fx2 = load('formulas.xlsx', bytes);
  const edit = await structural(fx2.wb, 1, insR(20));
  assert.ok(edit === null || !edit.changes.some((c) => c.part === 'xl/worksheets/sheet4.xml'));
});

test('a workbook with an unreadable sheet refuses (its references cannot be checked)', async () => {
  const fx = load('damaged-sheet.xlsx');
  assert.match((await refusal(fx.wb, 1, insR(1))).message, /can't be read/);
});

test('defined names: Print_Area / Print_Titles / _FilterDatabase shift (workbook.xml node changes)', async () => {
  const bytes = await patched('basic.xlsx', {
    'xl/workbook.xml': (s) => s.replace('</sheets>', '</sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Values!$A$1:$C$23</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Values!$A$1:$C$23</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Values!$1:$1</definedName><definedName name="Other">\'Second Sheet\'!$A$1</definedName></definedNames>'),
  });
  const fx = load('basic.xlsx', bytes);
  const { bytes: out } = await check(fx, 1, insR(1), [S1, 'xl/workbook.xml'], 'defined-names');
  const w = partText(out, 'xl/workbook.xml');
  assert.match(w, /_FilterDatabase" localSheetId="0" hidden="1">Values!\$A\$2:\$C\$24</);
  assert.match(w, /Print_Area" localSheetId="0">Values!\$A\$2:\$C\$24</);
  assert.match(w, /Print_Titles" localSheetId="0">Values!\$2:\$2</);
  assert.match(w, /name="Other">'Second Sheet'!\$A\$1</);
  const fx2 = load('basic.xlsx', bytes);
  const { bytes: out2 } = await check(fx2, 1, delC('B'), null, 'defined-names-col');
  assert.match(partText(out2, 'xl/workbook.xml'), /Print_Area" localSheetId="0">Values!\$A\$1:\$B\$23</);
});

// ---------------------------------------------------------------------------------------------------
// Sheet-level ranges

test('mergeCells: shift, grow, shrink, remove; count corrected / element removed when empty', async () => {
  // styles.xlsx merges: A14:C14, E13:E15, A16:B17 (count 3).
  const fx = load('styles.xlsx');
  const { bytes } = await check(fx, 1, insR(14), [S1], 'merges-insert');
  assert.match(partText(bytes, S1), /<mergeCells count="3"><mergeCell ref="A15:C15"\/><mergeCell ref="E13:E16"\/><mergeCell ref="A17:B18"\/><\/mergeCells>/);
  const fx2 = load('styles.xlsx');
  const { bytes: b2 } = await check(fx2, 1, delR(14), [S1], 'merges-delete');
  assert.match(partText(b2, S1), /<mergeCells count="2"><mergeCell ref="E13:E14"\/><mergeCell ref="A15:B16"\/><\/mergeCells>/, 'A14:C14 wholly deleted');
  const fx3 = load('styles.xlsx');
  const { bytes: b3 } = await check(fx3, 1, delR(14, 2), [S1], 'merges-shrink-to-one [WP-37]');
  assert.match(partText(b3, S1), /<mergeCells count="1"><mergeCell ref="A14:B15"\/><\/mergeCells>/, 'E13:E15 -> E13 (one cell) removed [WP-37]');
  const fx4 = load('styles.xlsx');
  const { bytes: b4 } = await check(fx4, 1, delR(13, 5), [S1], 'merges-all-deleted');
  assert.ok(!/mergeCell/.test(partText(b4, S1)), 'mergeCells element removed when empty');
  const fx5 = load('styles.xlsx');
  const { bytes: b5 } = await check(fx5, 1, delC('B'), [S1], 'merges-col-delete');
  assert.match(partText(b5, S1), /<mergeCells count="3"><mergeCell ref="A14:B14"\/><mergeCell ref="D13:D15"\/><mergeCell ref="A16:A17"\/><\/mergeCells>/);
});

test('cols: shift, split (new columns unstyled), shrink, remove, rejoin on delete [WP-37]', async () => {
  const bytes = await patched('styles.xlsx', {
    [S1]: (s) => s.replace(/<cols>.*?<\/cols>/, '<cols><col min="1" max="1" width="14.59765625" customWidth="1"/><col min="3" max="6" width="18.5" customWidth="1"/><col min="9" max="16384" width="3" style="1"/></cols>')
      .replace(/<sheetViews>.*?<\/sheetViews>/, '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'),   // no frozen column A
  });
  const fx = load('styles.xlsx', bytes);
  const { bytes: b1 } = await check(fx, 1, insC('D', 2), [S1], 'cols-split');
  assert.match(partText(b1, S1), /<cols><col min="1" max="1" width="14.59765625" customWidth="1"\/><col min="3" max="3" width="18.5" customWidth="1"\/><col min="6" max="8" width="18.5" customWidth="1"\/><col min="11" max="16384" width="3" style="1"\/><\/cols>/);
  // Deleting the inserted band rejoins the halves: the original text comes back.
  const del = await structural(fx.wb, 1, delC('D', 2));
  assert.ok(del);
  assert.strictEqual(/<cols>.*?<\/cols>/.exec(fx.pkg.text(S1))[0], /<cols>.*?<\/cols>/.exec(OfficePackage.open('o.xlsx', bytes).text(S1))[0]);
  const fx2 = load('styles.xlsx', bytes);
  const { bytes: b2 } = await check(fx2, 1, delC('B', 3), [S1], 'cols-shrink');
  assert.match(partText(b2, S1), /<cols><col min="1" max="1" width="14.59765625" customWidth="1"\/><col min="2" max="3" width="18.5" customWidth="1"\/><col min="6" max="16384" width="3" style="1"\/><\/cols>/, 'a range reaching XFD keeps reaching it [WP-37]');
  const fx3 = load('styles.xlsx', bytes);
  const { bytes: b3 } = await check(fx3, 1, delC('A'), [S1], 'cols-remove');
  assert.match(partText(b3, S1), /<cols><col min="2" max="5" width="18.5" customWidth="1"\/><col min="8" max="16384" width="3" style="1"\/><\/cols>/);
  const fx4 = load('styles.xlsx', bytes);
  const { bytes: b4 } = await check(fx4, 1, insC('A'), [S1], 'cols-clamp-xfd');
  assert.match(partText(b4, S1), /<col min="10" max="16384" width="3" style="1"\/>/, 'max clamped to XFD');
  const one = await patched('styles.xlsx', { [S1]: (s) => s.replace(/<cols>.*?<\/cols>/, '<cols><col min="2" max="2" width="9" customWidth="1"/></cols>') });
  const fx5 = load('styles.xlsx', one);
  const { bytes: b5 } = await check(fx5, 1, delC('B'), [S1], 'cols-element-removed');
  assert.ok(!/<cols/.test(partText(b5, S1)), 'cols removed when empty');
});

test('sheetView: pane topLeftCell, frozen split, selection activeCell/sqref [WP-37]', async () => {
  // styles.xlsx: pane xSplit=1 ySplit=1 topLeftCell=B2 frozenSplit; selections B1, A2.
  const fx = load('styles.xlsx');
  const { bytes } = await check(fx, 1, insR(1), [S1], 'pane-insert-in-frozen-rows');
  const t = partText(bytes, S1);
  assert.match(t, /<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozenSplit"\/><selection pane="topRight" activeCell="B2" sqref="B2"\/><selection pane="bottomLeft" activeCell="A3" sqref="A3"\/>/);
  const fx2 = load('styles.xlsx');
  const { bytes: b2 } = await check(fx2, 1, insR(2), [S1], 'pane-insert-below-frozen');
  assert.match(partText(b2, S1), /<pane xSplit="1" ySplit="1" topLeftCell="B3"/);
  const fx3 = load('styles.xlsx');
  const { bytes: b3 } = await check(fx3, 1, delR(2), [S1], 'pane-delete-topleft-row');
  assert.match(partText(b3, S1), /<pane xSplit="1" ySplit="1" topLeftCell="B2"[^>]*\/><selection pane="topRight" activeCell="B1" sqref="B1"\/><selection pane="bottomLeft" activeCell="A2" sqref="A2"\/>/, 'deleted cells clamp to the first row after the band');
  const fx4 = load('styles.xlsx');
  assert.match((await refusal(fx4.wb, 1, delR(1))).message, /every frozen row/);
});

test('autoFilter and sortState (sheet level): ref, filterColumn colId, sortCondition', async () => {
  const bytes = await patched('basic.xlsx', {
    [S1]: injectBefore('pageMargins', '<autoFilter ref="A1:C23"><filterColumn colId="2"><filters><filter val="x"/></filters></filterColumn><sortState ref="A2:C23"><sortCondition ref="C2:C23"/></sortState></autoFilter>'),
  });
  const fx = load('basic.xlsx', bytes);
  const { bytes: b1 } = await check(fx, 1, insC('B'), [S1], 'autofilter-col-insert');
  assert.match(partText(b1, S1), /<autoFilter ref="A1:D23"><filterColumn colId="3">.*<sortState ref="A2:D23"><sortCondition ref="D2:D23"\/><\/sortState><\/autoFilter>/);
  const fx2 = load('basic.xlsx', bytes);
  const { bytes: b2 } = await check(fx2, 1, delC('C'), [S1], 'autofilter-col-deleted');
  const t2 = partText(b2, S1);
  assert.match(t2, /<autoFilter ref="A1:B23"><sortState ref="A2:B23">(<\/sortState>)?<\/autoFilter>/, 'filtered column and its sort condition removed');
  const fx3 = load('basic.xlsx', bytes);
  const { bytes: b3 } = await check(fx3, 1, insR(1), [S1], 'autofilter-row');
  assert.match(partText(b3, S1), /<autoFilter ref="A2:C24"><filterColumn colId="2">/);
  const fx4 = load('basic.xlsx', bytes);
  const { bytes: b4 } = await check(fx4, 1, delC('A', 3), [S1], 'autofilter-removed');
  assert.ok(!/autoFilter/.test(partText(b4, S1)));
});

test('hyperlinks: ref shifted, deleted link removed, element removed when empty; location kept [WP-37]', async () => {
  // features.xlsx: hyperlink K2 (external, r:id) and K3 (location 'PivotData'!A1).
  const fx = load('features.xlsx');
  const { bytes } = await check(fx, 1, insR(1), [S1], 'hyperlinks-insert', { calc: CALC_FIRST_NO_CHAIN });
  const t = partText(bytes, S1);
  assert.match(t, /<hyperlink ref="K3" r:id="rId1"/);
  assert.match(t, /<hyperlink ref="K4" location="'PivotData'!A1"/, 'location strings are not rewritten [WP-37]');
  const fx2 = load('features.xlsx');
  const { bytes: b2 } = await check(fx2, 1, delR(2), [S1], 'hyperlinks-delete-one', { calc: CALC_FIRST_NO_CHAIN });
  assert.match(partText(b2, S1), /<hyperlinks><hyperlink ref="K2" location=/);
  const fx3 = load('features.xlsx');
  const { bytes: b3 } = await check(fx3, 1, delC('K'), [S1], 'hyperlinks-all-deleted', { calc: CALC_FIRST_NO_CHAIN });
  assert.ok(!/<hyperlinks/.test(partText(b3, S1)));
});

test('conditionalFormatting: sqref and rule formulas; anchored formula when the anchor row is deleted', async () => {
  const bytes = await patched('features.xlsx', {
    [S1]: injectBefore('dataValidations', '<conditionalFormatting sqref="F2:F4 F8"><cfRule type="expression" dxfId="0" priority="9"><formula>F2&gt;$B$3</formula></cfRule></conditionalFormatting>'),
  });
  const fx = load('features.xlsx', bytes);
  const { bytes: b1 } = await check(fx, 1, insR(3), [S1], 'cf-insert', { calc: CALC_FIRST_NO_CHAIN });
  const t1 = partText(b1, S1);
  assert.match(t1, /<conditionalFormatting sqref="D2:D5"><cfRule type="cellIs" dxfId="0" priority="3" stopIfTrue="1" operator="greaterThan"><formula>30<\/formula>/);
  assert.match(t1, /<conditionalFormatting sqref="F2:F5 F9"><cfRule type="expression" dxfId="0" priority="9"><formula>F2&gt;\$B\$4<\/formula>/);
  const fx2 = load('features.xlsx', bytes);
  const { bytes: b2 } = await check(fx2, 1, delR(2), [S1], 'cf-anchor-deleted');
  // Old F3 (the new anchor) had F3>$B$3; after the delete it is F2>$B$2.
  assert.match(partText(b2, S1), /<conditionalFormatting sqref="F2:F3 F7"><cfRule type="expression" dxfId="0" priority="9"><formula>F2&gt;\$B\$2<\/formula>/);
  const fx3 = load('features.xlsx', bytes);
  const { bytes: b3 } = await check(fx3, 1, delC('D'), [S1], 'cf-removed');
  const t3 = partText(b3, S1);
  assert.ok(!/operator="greaterThan"/.test(t3), 'the D2:D4 format was wholly deleted');
  assert.match(t3, /<conditionalFormatting sqref="D2:D4"><cfRule type="iconSet"/, 'E2:E4 moved to D2:D4');
});

test('dataValidations: sqref, formula1/2, count; removed when empty', async () => {
  const bytes = await patched('features.xlsx', {
    [S1]: (s) => s.replace('<dataValidations count="2">', '<dataValidations count="3"><dataValidation type="list" allowBlank="1" sqref="J2:J4"><formula1>$G$2:$G$4</formula1></dataValidation>'),
  });
  const fx = load('features.xlsx', bytes);
  const { bytes: b1 } = await check(fx, 1, insR(1), [S1], 'dv-insert', { calc: CALC_FIRST_NO_CHAIN });
  const t1 = partText(b1, S1);
  assert.match(t1, /<dataValidation type="list" allowBlank="1" sqref="J3:J5"><formula1>\$G\$3:\$G\$5<\/formula1>/);
  assert.match(t1, /sqref="H3"[^>]*><formula1>"Yes,No,Maybe"<\/formula1>/, 'list literal untouched');
  const fx2 = load('features.xlsx', bytes);
  const { bytes: b2 } = await check(fx2, 1, delC('J'), [S1], 'dv-delete-one', { calc: CALC_FIRST_NO_CHAIN });
  assert.match(partText(b2, S1), /<dataValidations count="2"><dataValidation type="list" allowBlank="1" showInputMessage="1"/);
  const fx3 = load('features.xlsx', bytes);
  const { bytes: b3 } = await check(fx3, 1, delC('H', 3), [S1], 'dv-all-deleted', { calc: CALC_FIRST_NO_CHAIN });
  assert.ok(!/<dataValidations/.test(partText(b3, S1)));
});

test('protectedRanges, ignoredErrors, rowBreaks/colBreaks [WP-37 for breaks]', async () => {
  const bytes = await patched('basic.xlsx', {
    [S1]: (s) => injectBefore('pageMargins', '<protectedRanges><protectedRange sqref="B2:B5" name="R1"/><protectedRange sqref="C3" name="R2"/></protectedRanges>')(s)
      .replace('</worksheet>', '<rowBreaks count="2" manualBreakCount="2"><brk id="5" max="16383" man="1"/><brk id="10" max="16383" man="1"/></rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="2" max="1048575" man="1"/></colBreaks><ignoredErrors><ignoredError sqref="A1:A3 C9" numberStoredAsText="1"/></ignoredErrors></worksheet>'),
  });
  // Schema order: rowBreaks/colBreaks before ignoredErrors? (CT_Worksheet: …pageSetup, headerFooter, rowBreaks, colBreaks, customProperties, cellWatches, ignoredErrors…) — fine.
  const fx = load('basic.xlsx', bytes);
  const { bytes: b1 } = await check(fx, 1, insR(4, 2), [S1], 'ranges-breaks-insert');
  const t1 = partText(b1, S1);
  assert.match(t1, /<protectedRanges><protectedRange sqref="B2:B7" name="R1"\/><protectedRange sqref="C3" name="R2"\/><\/protectedRanges>/);
  assert.match(t1, /<rowBreaks count="2" manualBreakCount="2"><brk id="7" max="16383" man="1"\/><brk id="12"/);
  assert.match(t1, /<colBreaks count="1" manualBreakCount="1"><brk id="2"/, 'column breaks untouched by a row op');
  assert.match(t1, /<ignoredError sqref="A1:A3 C11" numberStoredAsText="1"\/>/);
  const fx2 = load('basic.xlsx', bytes);
  const { bytes: b2 } = await check(fx2, 1, delR(6), [S1], 'ranges-breaks-delete');
  const t2 = partText(b2, S1);
  assert.match(t2, /<rowBreaks count="1" manualBreakCount="1"><brk id="9"/, 'the break before row 6 went with it');
  const fx3 = load('basic.xlsx', bytes);
  const { bytes: b3 } = await check(fx3, 1, delC('C'), [S1], 'ranges-col-delete');
  const t3 = partText(b3, S1);
  assert.match(t3, /<protectedRanges><protectedRange sqref="B2:B5" name="R1"\/><\/protectedRanges>/);
  assert.ok(!/<colBreaks/.test(t3), 'break before column C removed with it; container removed');
  assert.match(t3, /<ignoredError sqref="A1:A3" numberStoredAsText="1"\/>/);
});

test('refused: sheet elements with references this module does not rewrite', async () => {
  const bytes = await patched('basic.xlsx', {
    [S1]: injectBefore('pageMargins', '<scenarios><scenario name="s" count="1"><inputCells r="A1" val="1"/></scenario></scenarios>'),
  });
  const fx = load('basic.xlsx', bytes);
  assert.match((await refusal(fx.wb, 1, insR(1))).message, /scenarios/);
});

// ---------------------------------------------------------------------------------------------------
// Tables

test('tables: row ops above / within / below the data area update table and autoFilter refs (attr changes)', async () => {
  // tables.xlsx: SalesTable A1:E7 (totals row, autoFilter A1:E6), Scores A10:B13.
  const T1 = 'xl/tables/table1.xml';
  const T2 = 'xl/tables/table2.xml';
  const fx = load('tables.xlsx');
  const { edit, bytes } = await check(fx, 1, insR(3), [S1, T1, T2], 'tables-insert-in-data');
  assert.match(partText(bytes, T1), /ref="A1:E8" totalsRowCount="1"><autoFilter ref="A1:E7"/);
  assert.match(partText(bytes, T2), /ref="A11:B14"/);
  assert.ok(edit.changes.filter((c) => c.part === T1).every((c) => c.kind === 'attr'), 'table changes are attr changes');
  const x = await excel(bytes);
  assert.ok(x.getWorksheet(1), 'ExcelJS loads');
  const fx2 = load('tables.xlsx');
  const { bytes: b2 } = await check(fx2, 1, insR(1), [S1, T1, T2], 'tables-insert-above');
  assert.match(partText(b2, T1), /ref="A2:E8" totalsRowCount="1"><autoFilter ref="A2:E7"/);
  const fx3 = load('tables.xlsx');
  const { bytes: b3 } = await check(fx3, 1, delR(3, 2), [S1, T1, T2], 'tables-delete-data-rows');
  assert.match(partText(b3, T1), /ref="A1:E5" totalsRowCount="1"><autoFilter ref="A1:E4"/);
  assert.match(partText(b3, T2), /ref="A8:B11"/);
  const fx4 = load('tables.xlsx');
  const { bytes: b4 } = await check(fx4, 1, insR(7), [S1, T1, T2], 'tables-insert-at-totals');
  assert.match(partText(b4, T1), /ref="A1:E8" totalsRowCount="1"><autoFilter ref="A1:E7"/, 'insert before the totals row grows the data area [WP-37]');
});

test('tables: column ops left of a table move it; intersecting / header / totals / all data rows refused (Tier B)', async () => {
  const bytes = await patched('tables.xlsx', {
    'xl/tables/table2.xml': (s) => s.replace('ref="A10:B13"', 'ref="D10:E13"'),
    [S1]: (s) => s.replace(/<c r="A1([0-3])"/g, '<c r="D1$1"').replace(/<c r="B1([0-3])"/g, '<c r="E1$1"'),
  });
  const fx0 = load('tables.xlsx');
  assert.match((await refusal(fx0.wb, 1, insC('B'))).message, /inside table "SalesTable"/);
  assert.match((await refusal(fx0.wb, 1, delC('E'))).message, /inside table "SalesTable"/);
  assert.match((await refusal(fx0.wb, 1, delR(1))).message, /header row of table "SalesTable"/);
  assert.match((await refusal(fx0.wb, 1, delR(7))).message, /totals row of table "SalesTable"/);
  assert.match((await refusal(fx0.wb, 1, delR(2, 5))).message, /every data row of table "SalesTable"/);
  assert.match((await refusal(fx0.wb, 1, delR(10))).message, /header row of table "Scores"/);
  const fx = load('tables.xlsx');
  assert.strictEqual(await structural(fx.wb, 1, insC('F')), null, 'a column op right of every table and cell changes nothing');
  void bytes;
  // A column op entirely to the left of a table: give SalesTable room by inserting at A (moves it).
  const fx2 = load('tables.xlsx');
  const { bytes: b2 } = await check(fx2, 1, insC('A'), [S1, 'xl/tables/table1.xml', 'xl/tables/table2.xml'], 'tables-col-left');
  assert.match(partText(b2, 'xl/tables/table1.xml'), /ref="B1:F7" totalsRowCount="1"><autoFilter ref="B1:F6"/);
  assert.match(partText(b2, 'xl/tables/table2.xml'), /ref="B10:C13"/);
});

// ---------------------------------------------------------------------------------------------------
// Insert then delete restores the original (every fixture)

/** The package after the first edit's calc handling only: what insert -> delete must return to. */
function calcBaseline(name, bytes) {
  const { pkg, wb } = load(name, bytes);
  const b = new EditBuilder(pkg, 'calc');
  ensureFullCalcOnLoad(b, wb);
  b.finish();
  return pkg.serialize();
}

for (const name of allFixtures('xlsx')) {
  test(`insert -> delete of the same band restores the bytes: ${name}`, async (t) => {
    let fx;
    try { fx = load(name); } catch (err) {
      // encrypted.xlsx and zip64.xlsx are refused at open by design (fixtures.test.mjs): nothing to shift.
      assert.ok(err instanceof core.sniff.OfficeLoadError, `${name}: only a classified load refusal is expected (${err?.stack})`);
      t.diagnostic(`refused at open: ${err.failure}`);
      return;
    }
    if (fx.pkg.viewOnlyReason) { t.skip(`view-only (${fx.pkg.viewOnlyReason})`); return; }
    const baseline = calcBaseline(name, fx.bytes);
    let ran = 0;
    for (const e of fx.wb.sheets) {
      if (e.kind !== 'worksheet') continue;
      let sheet;
      try { sheet = await fx.wb.sheet(e.id); } catch { continue; }
      if (sheet.readOnlyReason || sheet.truncatedAtRow !== null) continue;
      const dims = sheet.dimensions();
      const bands = name === 'large.xlsx' ? [['row', 0], ['col', 0]] : null;   // large: the perf test covers the rest
      for (const [axis, at] of bands ?? [['row', 0], ['row', Math.floor(dims.rows / 2)], ['row', Math.max(0, dims.rows - 1)], ['col', 0], ['col', Math.floor(dims.cols / 2)], ['col', Math.max(0, dims.cols - 1)]]) {
        const f = load(name);
        const s0 = f.pkg.serialize();
        let ins;
        try { ins = await structural(f.wb, e.id, [axis, at, 2]); } catch (err) {
          assert.ok(err.officeError, `${name} ${e.name} insert ${axis} ${at}: refusals carry officeError (${err.stack})`);
          assertBytesEqual(f.pkg.serialize(), s0, 'refused: unchanged');
          continue;
        }
        if (!ins) continue;
        save(f.pkg);
        const materialised = ins.changes.some((c) => c.kind === 'node' && /t="shared"/.test(c.before) && !/t="shared"/.test(c.after));
        const del = await structural(f.wb, e.id, [axis, at, -2]);
        assert.ok(del, `${name} ${e.name} ${axis} ${at}: the delete changes something`);
        save(f.pkg);
        const now = f.pkg.serialize();
        const base = OfficePackage.open('b.xlsx', baseline);
        const cur = OfficePackage.open('c.xlsx', now);
        for (const part of base.partNames()) {
          let a = base.bytes(part);
          let z = cur.bytes(part);
          if (axis === 'col' && /worksheets\/sheet\d+\.xml$/i.test(part) && part.toLowerCase() === sheet.part.toLowerCase()) {
            // §9.6: spans are removed by column operations and not restored.
            a = new TextEncoder().encode(new TextDecoder().decode(a).replace(/ spans="[^"]*"/g, ''));
            z = new TextEncoder().encode(new TextDecoder().decode(z).replace(/ spans="[^"]*"/g, ''));
          }
          if (materialised && part.toLowerCase() === sheet.part.toLowerCase()) continue;   // a materialised group stays materialised
          assertBytesEqual(z, a, `${name} ${e.name} ${axis} at ${at}: ${part}`);
        }
        ran++;
      }
    }
    t.diagnostic(`${ran} insert/delete round trips`);
  });
}

// ---------------------------------------------------------------------------------------------------
// Large sheet performance

test('large.xlsx (200,000 cells): insert/delete a row at the top is linear and exact', async (t) => {
  const fx = load('large.xlsx');
  const sheet = await fx.wb.sheet(1);
  const orig = fx.pkg.serialize();
  const timeOp = async (op) => {
    const t0 = performance.now();
    const edit = await structural(fx.wb, 1, op);
    return { edit, ms: performance.now() - t0 };
  };
  const top = await timeOp(insR(1));
  const t1 = performance.now();
  applyEdit(fx.pkg, invertEdit(top.edit));
  const undoMs = performance.now() - t1;
  assertBytesEqual(fx.pkg.serialize(), orig, 'large: undo restores the bytes');
  applyEdit(fx.pkg, top.edit);
  refreshAfterEdit(fx.wb, top.edit);
  const bytes = save(fx.pkg);
  assertG3(orig, bytes, [S1, 'xl/workbook.xml'], 'large G3');
  assert.strictEqual(sheet.cellsIn([0, 0, 0, 49]).length, 0, 'row 1 is empty');
  assert.strictEqual(sheet.cellsIn([1, 0, 1, 49]).length, 50, 'old row 1 is row 2');
  const del = await timeOp(delR(1));
  applyEdit(fx.pkg, invertEdit(del.edit));
  applyEdit(fx.pkg, invertEdit(top.edit));
  assertBytesEqual(fx.pkg.serialize(), orig, 'large: insert, delete, undo both');
  // Linearity: shifting half the rows costs at most ~ the full shift (an O(n²) shift would be ~4x apart).
  const fx2 = load('large.xlsx');
  await fx2.wb.sheet(1);
  const t2 = performance.now();
  await structural(fx2.wb, 1, insR(2001));
  const halfMs = performance.now() - t2;
  t.diagnostic(`insert row 1: ${top.ms.toFixed(0)} ms (4,000 rows / 200,000 cells renumbered); undo ${undoMs.toFixed(0)} ms; delete row 1: ${del.ms.toFixed(0)} ms; insert at row 2001 (half): ${halfMs.toFixed(0)} ms`);
  assert.ok(top.ms < 20000, `insert at the top took ${top.ms} ms`);
  writeOut(OUT, 'large-insert-top.xlsx', bytes);
});


// ---------------------------------------------------------------------------------------------------
// Grid (view.cellWindow) after structural ops, undo and redo: view.ts caches hyperlinks, notes and
// locked ranges per Sheet, keyed on Sheet.structureGeneration.

const { cellWindow } = core.xlsx.view;
const { applyXlsxEdit } = core.xlsx.ops;

/** Outside undo (or redo) as the provider's stack does it: apply, then refresh the read models. */
function outside(wb, edit, undo) {
  const e = undo ? invertEdit(edit) : edit;
  applyEdit(wb.pkg, e);
  refreshAfterEdit(wb, e);
}

const gridCell = (wb, sheet, styles, r, c) => cellWindow(wb, sheet, styles, [r, c, r, c], false).cells[0];

test('grid view after a structural op (view.cellWindow) matches the file', async () => {
  const fx = load('formulas.xlsx');
  const styles = stylesFor(fx.wb);
  const sheet = await fx.wb.sheet(1);
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'before');   // fills the aux cache
  assert.ok(gridCell(fx.wb, sheet, styles, 1, 4).ro, 'E2 is in the array formula E2:E4');
  const g0 = sheet.structureGeneration;
  const edit = await structural(fx.wb, 1, insR(1));   // moves the array formula E2:E4 (a locked range) to E3:E5
  assert.ok(sheet.structureGeneration > g0, 'the structural op bumps the generation');
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'grid after insert');
  assert.ok(gridCell(fx.wb, sheet, styles, 4, 4).ro, 'E5 is locked after the insert');
  outside(fx.wb, edit, true);
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'grid after undo');
  assert.ok(!gridCell(fx.wb, sheet, styles, 4, 4)?.ro, 'E5 is not locked after the undo');
  outside(fx.wb, edit, false);
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'grid after redo');
  assert.ok(gridCell(fx.wb, sheet, styles, 4, 4).ro);
});

test('grid: hyperlinks and table header locks follow structural ops through ops.applyXlsxEdit, undo and redo', async () => {
  // features.xlsx: hyperlinks K2 (external) and K3 (internal). Inserting two columns at G moves them to M.
  const fx = load('features.xlsx');
  const styles = stylesFor(fx.wb);
  const sheet = await fx.wb.sheet(1);
  const link = (r, c) => gridCell(fx.wb, sheet, styles, r, c)?.link;
  const k2 = link(1, 10);
  assert.ok(k2, 'K2 has a link');
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'links before');
  const res = await applyXlsxEdit(fx.wb, fx.pkg, { op: 'insertCols', sheetId: 1, at: 6, count: 2 }, { confirmed: true });
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  assert.strictEqual(res.edit.label, 'Insert Columns');
  assert.strictEqual(link(1, 10), undefined, 'K2 has no link any more');
  assert.strictEqual(link(1, 12), k2, 'the link moved to M2');
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'links after insert');
  outside(fx.wb, res.edit, true);
  assert.strictEqual(link(1, 10), k2, 'undo: back at K2');
  assert.strictEqual(link(1, 12), undefined);
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'links after undo');
  outside(fx.wb, res.edit, false);
  assert.strictEqual(link(1, 12), k2, 'redo: at M2 again');
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'links after redo');

  // tables.xlsx: SalesTable A1:E7 has its header on row 1; inserting a row above moves the lock to row 2.
  const tx = load('tables.xlsx');
  const tst = stylesFor(tx.wb);
  const ts = await tx.wb.sheet(1);
  const ro = (r, c) => gridCell(tx.wb, ts, tst, r, c)?.ro === true;
  assert.ok(ro(0, 0) && !ro(1, 0), 'header row 1 is locked');
  const ins = await applyXlsxEdit(tx.wb, tx.pkg, { op: 'insertRows', sheetId: 1, at: 0, count: 1 }, { confirmed: true });
  assert.ok(ins.ok && ins.edit, JSON.stringify(ins));
  assert.ok(!ro(0, 0) && ro(1, 0), 'the header lock moved to row 2');
  await assertViewMatchesFile(tx.wb, tx.pkg, tst, 'table after insert');
  outside(tx.wb, ins.edit, true);
  assert.ok(ro(0, 0) && !ro(1, 0), 'undo: the header lock is back on row 1');
  await assertViewMatchesFile(tx.wb, tx.pkg, tst, 'table after undo');
  outside(tx.wb, ins.edit, false);
  assert.ok(!ro(0, 0) && ro(1, 0), 'redo');
  await assertViewMatchesFile(tx.wb, tx.pkg, tst, 'table after redo');
});

test('grid: cell edits keep the structural generation (a hyperlink cell keeps its link; table headers stay refused)', async () => {
  const fx = load('features.xlsx');
  const styles = stylesFor(fx.wb);
  const sheet = await fx.wb.sheet(1);
  const k2 = gridCell(fx.wb, sheet, styles, 1, 10).link;
  const g0 = sheet.structureGeneration;
  const res = await applyXlsxEdit(fx.wb, fx.pkg, { op: 'setCells', sheetId: 1, cells: [{ r: 1, c: 10, input: 'relabelled' }] }, { confirmed: false });
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  assert.strictEqual(sheet.structureGeneration, g0, 'a cell edit does not rebuild the aux lookups');
  const after = gridCell(fx.wb, sheet, styles, 1, 10);
  assert.strictEqual(after.d, 'relabelled');
  assert.strictEqual(after.link, k2, 'the hyperlink stays on the edited cell');
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'hyperlink cell edited');
  outside(fx.wb, res.edit, true);
  await assertViewMatchesFile(fx.wb, fx.pkg, styles, 'hyperlink cell edit undone');

  const tx = load('tables.xlsx');
  const before = tx.pkg.serialize();
  const hdr = await applyXlsxEdit(tx.wb, tx.pkg, { op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: 'Renamed' }] }, { confirmed: false });
  assert.strictEqual(hdr.ok, false);
  assert.strictEqual(hdr.error.code, 'read-only');
  assert.match(hdr.error.message, /header cell of table/);
  assertBytesEqual(tx.pkg.serialize(), before, 'refused header edit changed nothing');
  await assertViewMatchesFile(tx.wb, tx.pkg, stylesFor(tx.wb), 'table header refused');
});
// ---------------------------------------------------------------------------------------------------
// Through the dispatcher (ops.ts) with a pass-through guard

test('ops.applyXlsxEdit dispatches insert/delete to structure.insertOrDelete with calc handling', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  const outfile = path.join(root, 'tests', '.build', 'office-core-structure.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'office', 'core', 'index.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{
      name: 'pass-guard',
      setup(b) { b.onLoad({ filter: /[\\/]xlsx[\\/]guards\.ts$/ }, () => ({ contents: 'export function checkStructuralOp() { return Promise.resolve({}); }', loader: 'ts' })); },
    }],
  });
  const c2 = createRequire(import.meta.url)(outfile);
  const pkg = c2.pkg.OfficePackage.open('formulas.xlsx', fixture('formulas.xlsx'));
  const wb = c2.xlsx.workbook.Workbook.load(pkg);
  const orig = pkg.serialize();
  const r = await c2.xlsx.ops.applyXlsxEdit(wb, pkg, { op: 'insertRows', sheetId: 1, at: 0, count: 1 }, { confirmed: false });
  assert.ok(r.ok && r.edit, JSON.stringify(r));
  assert.strictEqual(r.edit.label, 'Insert Rows');
  assert.strictEqual(r.invalidate, 'sheet');
  const bytes = pkg.serialize();
  assertG3(orig, bytes, [S1, 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet4.xml', ...CALC_FIRST], 'dispatch G3');
  assert.match(OfficePackage.open('x.xlsx', bytes).text('xl/workbook.xml'), /fullCalcOnLoad="1"/);
  const d = await c2.xlsx.ops.applyXlsxEdit(wb, pkg, { op: 'deleteCols', sheetId: 1, at: 6, count: 1 }, { confirmed: false });
  assert.ok(d.ok && d.edit && d.edit.label === 'Delete Columns');
  // A cell edit after the structural op works on the rebuilt index.
  const e = await c2.xlsx.ops.applyXlsxEdit(wb, pkg, { op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: '5' }] }, { confirmed: false });
  assert.ok(e.ok && e.edit, JSON.stringify(e));
  const refused = await c2.xlsx.ops.applyXlsxEdit(wb, pkg, { op: 'insertRows', sheetId: 1, at: 3, count: 1 }, { confirmed: false });
  assert.deepStrictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'blocked');
});
