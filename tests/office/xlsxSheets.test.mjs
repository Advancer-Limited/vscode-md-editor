// WP-40: add, rename and delete sheet (src/office/core/xlsx/sheetsOps.ts). Spec §9.7, §5.2 names,
// §9.5 recalculation, §13.2 G3–G6, §13.3 validators.
//
// The operations are driven the way ops.sheetOp drives them (a fresh EditBuilder; fullCalcOnLoad for
// rename and delete; abort on refusal), because ops dispatches sheet operations through
// guards.checkStructuralOp (WP-39) first, and that module is developed in parallel.
// After every edit, undo and redo: both save validators pass on the serialised package, the live
// read model (loaded sheets, wb.sheets) matches a model built from the bytes, and ExcelJS (G6)
// opens the result with the expected sheet names, order and formulas.
//
// Outputs: tests/.out/xlsxSheets/<case>.xlsx (scripts/verify-office-open.ps1).
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG4, assertG5, rng } from './_roundtrip.mjs';

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { EditBuilder, applyEdit, invertEdit } = core.edits;
const { ensureFullCalcOnLoad } = core.xlsx.calc;
const { addSheet, renameSheet, deleteSheet, validateSheetName, syncSheetEntries } = core.xlsx.sheetsOps;
const { applyXlsxEdit, refreshAfterEdit, stylesFor } = core.xlsx.ops;
const { serializeAndVerify, packageValidator } = core.save;
const { xlsxValidator } = core.xlsx.validate;
const { StyleTable } = core.xlsx.styles;
const { editSeed } = core.xlsx.format;
const { cellWindow } = core.xlsx.view;
const { displayFormula } = core.xlsx.sharedFormula;
const { renameSheetInFormula, deleteSheetInFormula } = core.xlsx.refs;

const OUT = 'xlsxSheets';
const WB = 'xl/workbook.xml';
const WB_RELS = 'xl/_rels/workbook.xml.rels';
const CT = '[Content_Types].xml';
const CALC = [WB_RELS, CT, 'xl/calcChain.xml'];   // calc-chain removal on the first formula edit

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}

const byName = (wb, name) => {
  const e = wb.sheets.find((s) => s.name === name);
  assert.ok(e, `sheet "${name}" exists`);
  return e.id;
};

/** One sheet operation as ops.sheetOp runs it: { edit } (null when nothing changed) or { error }. */
function op(wb, kind, ...args) {
  const b = new EditBuilder(wb.pkg, kind);
  const fn = { add: addSheet, rename: renameSheet, delete: deleteSheet }[kind];
  let err;
  try {
    err = fn(b, wb, ...args);
    if (!err && kind !== 'add' && b.size > 0) ensureFullCalcOnLoad(b, wb);
  } catch (e) {
    b.abort();
    syncSheetEntries(wb);
    throw e;
  }
  if (err) {
    b.abort();
    syncSheetEntries(wb);
    return { error: err };
  }
  const edit = b.finish();
  if (edit) refreshAfterEdit(wb, edit);
  return { edit };
}

/** Apply `edit` (or its inverse) from outside, as the provider's undo/redo does, then refresh. */
function replay(wb, edit, undo) {
  const e = undo ? invertEdit(edit) : edit;
  applyEdit(wb.pkg, e);
  refreshAfterEdit(wb, e);
  syncSheetEntries(wb);
}

function save(pkg, msg = 'save') {
  const r = serializeAndVerify(pkg, [packageValidator, xlsxValidator]);
  assert.ok(r.ok, `${msg}: verify: ${JSON.stringify(r.ok ? [] : r.failures)}`);
  return r.bytes;
}

const partText = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);
const partNames = (bytes) => OfficePackage.open('x.xlsx', bytes).partNames();

async function excel(bytes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(bytes));
  return w;
}
const excelNames = (w) => w.worksheets.filter(Boolean).sort((a, b) => a.orderNo - b.orderNo).map((s) => s.name);

/** Patched copy of a fixture: { part: (text) => text | null (delete) }. */
async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) {
    const f = zip.file(part);
    const next = fn(f ? await f.async('string') : '');
    if (next === null) zip.remove(part); else zip.file(part, next);
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
const replaceOnce = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from}`); return t.replace(from, to); };

// ---------------------------------------------------------------------------------------------
// Read-model checks (the shared _viewCheck helper pairs sheets by session id, which add/delete
// renumber against a fresh load; here they are paired by part).

function dump(wb, sheet, styles, range) {
  const cells = sheet.cellsIn(range).map((c) => JSON.stringify({
    r: c.r, c: c.c, value: c.value, s: c.styleIndex, f: c.formula, shared: c.shared, arrayRef: c.arrayRef,
    seed: editSeed(c, styles, wb.date1904), shown: displayFormula(sheet, c),
  }));
  const window = cellWindow(wb, sheet, styles, range, false).cells.map((c) => JSON.stringify(c));
  return { cells, window };
}

const rootOf = (n) => { while (n.parent) n = n.parent; return n; };

async function assertModel(wb, msg, range = [0, 0, 39, 12]) {
  const fp = OfficePackage.open('fresh.xlsx', wb.pkg.serialize());
  const fwb = Workbook.load(fp);
  const strip = (e) => ({ name: e.name, part: e.part, kind: e.kind, state: e.state, rId: e.rId, fileSheetId: e.fileSheetId });
  assert.deepStrictEqual(wb.sheets.map(strip), fwb.sheets.map(strip), `${msg}: wb.sheets`);
  assert.strictEqual(new Set(wb.sheets.map((e) => e.id)).size, wb.sheets.length, `${msg}: session ids unique`);
  const styles = stylesFor(wb);
  const fst = StyleTable.load(fp, fwb.stylesPart, fwb.themePart);
  for (let i = 0; i < wb.sheets.length; i++) {
    const e = wb.sheets[i];
    if (e.kind !== 'worksheet') continue;
    const live = wb.loadedSheet(e.id);
    if (!live) continue;
    assert.strictEqual(live.doc, wb.pkg.xml(live.part), `${msg}: sheet ${e.name} model is on the current tree`);
    const root = wb.pkg.xml(live.part).root;
    for (const c of live.cellsIn(range)) {
      const node = live.cellNode(c.r, c.c);
      assert.ok(node && rootOf(node) === root, `${msg}: ${e.name} (${c.r}, ${c.c}) indexed outside the tree`);
    }
    const a = dump(wb, live, styles, range);
    const b = dump(fwb, await fwb.sheet(fwb.sheets[i].id), fst, range);
    assert.deepStrictEqual(a.cells, b.cells, `${msg}: ${e.name} cells differ from the file`);
    assert.deepStrictEqual(a.window, b.window, `${msg}: ${e.name} grid differs from the file`);
  }
}

async function loadAll(wb) {
  for (const e of wb.sheets) if (e.kind === 'worksheet' && e.part) await wb.sheet(e.id);
}

/** Every <f> text of every worksheet part, keyed by part + cell. */
function formulasOf(bytes) {
  const p = OfficePackage.open('x.xlsx', bytes);
  const out = {};
  for (const n of p.partNames()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/i.test(n)) continue;
    for (const m of p.text(n).matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<f[^>]*>([^<]*)<\/f>)/g)) out[`${n}!${m[1]}`] = m[2];
  }
  return out;
}

/** Locality inside a sheet part: identical once every <f> text is blanked. */
function assertOnlyFormulaText(before, after, msg) {
  const blank = (t) => t.replace(/(<(?:\w+:)?f\b[^>]*>)[^<]*(<\/(?:\w+:)?f>)/g, '$1$2');
  assert.strictEqual(blank(after), blank(before), `${msg}: only formula text changed`);
}

/** G3 + G5 + validators + model + output, for an edit already applied. Returns the edited bytes. */
async function checkEdit(wb, edit, orig, touched, out) {
  assert.ok(edit, `${out}: an edit was recorded`);
  const after = save(wb.pkg, out);
  assertG3(orig, after, touched, `${out} G3`);
  await assertModel(wb, `${out} edit`);
  assertG5(wb.pkg, edit, orig, `${out} G5`);
  // assertG5 replays without refreshing the models: bring them back in line and check both states.
  replay(wb, edit, true);
  replay(wb, edit, false);
  await assertModel(wb, `${out} redo`);
  replay(wb, edit, true);
  assertBytesEqual(wb.pkg.serialize(), orig, `${out}: undo`);
  await assertModel(wb, `${out} undo`);
  save(wb.pkg, `${out} undo`);
  replay(wb, edit, false);
  assertBytesEqual(wb.pkg.serialize(), after, `${out}: redo`);
  writeOut(OUT, `${out}.xlsx`, after);
  return after;
}

// ---------------------------------------------------------------------------------------------
// validateSheetName (§5.2, §9.7)

test('validateSheetName: rules table', () => {
  const existing = ['Data', 'My Sheet', "O'Brien"];
  const ok = ['Sheet1', 'Sheet 1', "It's", 'x'.repeat(31), 'Ünïcødé ✓', 'Data2', 'History2', '1', 'A1', 'R1C1', ' lead space'];
  for (const n of ok) assert.strictEqual(validateSheetName(n, existing), null, `"${n}" is valid`);
  const bad = ['', 'x'.repeat(32), 'a[b', 'a]b', 'a:b', 'a*b', 'a?b', 'a/b', 'a\\b', "'lead", "trail'", "'", 'History', 'HISTORY', 'history',
    'data', 'DATA', 'my sheet', "o'brien", 'tab\there'];
  for (const n of bad) {
    const err = validateSheetName(n, existing);
    assert.ok(err, `"${n}" is refused`);
    assert.strictEqual(err.code, 'invalid', `"${n}" code`);
  }
  assert.match(validateSheetName('data', existing).message, /already exists/);
  assert.match(validateSheetName('History', []).message, /History/);
  assert.match(validateSheetName('x'.repeat(32), []).message, /31/);
});

// ---------------------------------------------------------------------------------------------
// addSheet

test('add: part, sheet element, rel, Override; touched set exact; default name first unused', async () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  await loadAll(wb);
  const { edit } = op(wb, 'add');
  const NEW = 'xl/worksheets/sheet3.xml';
  const after = await checkEdit(wb, edit, bytes, [WB, WB_RELS, CT, NEW], 'add-default');
  assert.strictEqual(partText(after, NEW),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  const wbText = partText(after, WB);
  const origWb = partText(bytes, WB);
  assert.ok(wbText.includes('<sheet name="Second Sheet" sheetId="2" r:id="rId2"/><sheet name="Sheet1" sheetId="3" r:id="rId6"/></sheets>'), wbText);
  assertG4(origWb, wbText, { start: origWb.indexOf('</sheets>'), end: origWb.indexOf('</sheets>') }, 'add G4 workbook');
  assert.ok(!wbText.includes('fullCalcOnLoad'), 'adding a sheet does not force recalculation');
  assert.ok(partText(after, WB_RELS).includes('<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>'));
  assert.ok(partText(after, CT).includes('<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'));
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Values', 'Second Sheet', 'Sheet1']);
  assert.deepStrictEqual(excelNames(await excel(after)), ['Values', 'Second Sheet', 'Sheet1']);

  // Default name skips used ones, case-insensitively; a second add gets sheet4.xml and sheetId 4.
  const b2 = op(wb, 'add');
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Values', 'Second Sheet', 'Sheet1', 'Sheet2']);
  assert.ok(pkg.has('xl/worksheets/sheet4.xml'));
  assert.ok(pkg.text(WB).includes('<sheet name="Sheet2" sheetId="4" r:id="rId7"/>'));
  save(pkg, 'add twice');
  replay(wb, b2.edit, true);
  assert.ok(!pkg.has('xl/worksheets/sheet4.xml'));
});

test('add: named, after a given sheet: localSheetId, activeTab and firstSheet of later tabs move up', async () => {
  const bytes = await patched('formulas.xlsx', {
    [WB]: (t) => replaceOnce('<definedName name="LocalName">', '<definedName name="Scoped" localSheetId="1">\'My Sheet\'!$A$1</definedName><definedName name="_xlnm.Print_Area" localSheetId="2">\'O\'\'Brien\'!$A$1:$B$2</definedName><definedName name="First" localSheetId="0">Data!$A$1</definedName><definedName name="LocalName">')(
      replaceOnce('<workbookView ', '<workbookView activeTab="2" firstSheet="1" ')(t)),
  });
  const { wb } = load('formulas.xlsx', bytes);
  await loadAll(wb);
  const { edit } = op(wb, 'add', 'New One', byName(wb, 'Data'));
  // formulas.xlsx has a calc chain: add keeps it (no formula changed) and forces no recalculation.
  const after = await checkEdit(wb, edit, bytes, [WB, WB_RELS, CT, 'xl/worksheets/sheet5.xml'], 'add-after-first');
  assert.ok(!/fullCalcOnLoad/.test(partText(after, WB)), 'no forced recalculation');
  assertBytesEqual(OfficePackage.open('x.xlsx', after).bytes('xl/calcChain.xml'), OfficePackage.open('o.xlsx', bytes).bytes('xl/calcChain.xml'), 'calc chain kept');
  assert.ok(partText(after, WB_RELS).includes('calcChain'), 'calc chain relationship kept');
  const t = partText(after, WB);
  assert.ok(t.includes('<sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="New One" sheetId="5" r:id="rId8"/><sheet name="My Sheet"'), t);
  assert.ok(t.includes('<definedName name="Scoped" localSheetId="2">'));
  assert.ok(t.includes('<definedName name="_xlnm.Print_Area" localSheetId="3">'));
  assert.ok(t.includes('<definedName name="First" localSheetId="0">'));
  assert.ok(t.includes('<workbookView activeTab="3" firstSheet="2" '));
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Data', 'New One', 'My Sheet', "O'Brien", 'NoCache']);
  const w = await excel(after);
  assert.deepStrictEqual(excelNames(w), ['Data', 'New One', 'My Sheet', "O'Brien", 'NoCache']);
  assert.strictEqual(w.getWorksheet('Data').getCell('C2').formula, "'My Sheet'!A1+Data!A2");
});

test('add: prefixed namespaces keep their prefix in the new part and the sheet element', async () => {
  const { wb, bytes } = load('prefixed-namespaces.xlsx');
  await loadAll(wb);
  const { edit } = op(wb, 'add', 'Two');
  const after = await checkEdit(wb, edit, bytes, [WB, WB_RELS, CT, 'xl/worksheets/sheet2.xml'], 'add-prefixed');
  assert.strictEqual(partText(after, 'xl/worksheets/sheet2.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData/></x:worksheet>');
  assert.ok(partText(after, WB).includes('<x:sheet name="Sheet1" sheetId="1" r:id="rId1"/><x:sheet name="Two" sheetId="2" r:id="rId'));
  // ExcelJS cannot read prefixed SpreadsheetML at all (the unedited fixture fails the same way): G6 here is the validators.
  await assert.rejects(excel(bytes));
});

test('add: invalid names and unknown afterSheetId are refused with nothing changed', () => {
  const { pkg, wb, bytes } = load('basic.xlsx');
  for (const n of ['', 'values', 'History', 'a/b', "'x", 'y'.repeat(32)]) {
    const r = op(wb, 'add', n);
    assert.strictEqual(r.error?.code, 'invalid', `"${n}"`);
  }
  assert.strictEqual(op(wb, 'add', 'Fine', 999).error?.code, 'invalid');
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  assert.deepStrictEqual(pkg.touchedParts(), []);
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Values', 'Second Sheet']);
});

// ---------------------------------------------------------------------------------------------
// renameSheet

test('rename: formulas and names rewritten with quoting; touched set exact', async () => {
  const { wb, bytes } = load('formulas.xlsx');
  await loadAll(wb);
  const before = formulasOf(bytes);
  const { edit } = op(wb, 'rename', byName(wb, 'Data'), 'Data 2024');
  const touched = [WB, ...CALC, 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet4.xml'];
  const after = await checkEdit(wb, edit, bytes, touched, 'rename-data');
  const now = formulasOf(after);
  for (const [k, f] of Object.entries(before)) {
    const unesc = f.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const want = renameSheetInFormula(unesc, 'Data', 'Data 2024');
    assert.strictEqual(now[k].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'), want, k);
  }
  assert.strictEqual(now['xl/worksheets/sheet1.xml!C2'], "'My Sheet'!A1+'Data 2024'!A2");
  assert.strictEqual(now['xl/worksheets/sheet2.xml!A2'], "'Data 2024'!A2+'O''Brien'!A1");
  assert.strictEqual(now['xl/worksheets/sheet4.xml!A4'], "SUM('Data 2024'!A2:A10)");
  for (const p of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet4.xml']) {
    assertOnlyFormulaText(partText(bytes, p), partText(after, p), `rename ${p}`);
  }
  const t = partText(after, WB);
  assert.ok(t.includes('<sheet name="Data 2024" sheetId="1" r:id="rId1"/>'));
  assert.ok(t.includes('<definedName name="LocalName">\'Data 2024\'!$G$2</definedName><definedName name="TaxRate">\'Data 2024\'!$G$1</definedName>'));
  assert.ok(/<calcPr[^>]*fullCalcOnLoad="1"/.test(t), 'rename forces recalculation (§9.5)');
  const w = await excel(after);
  assert.deepStrictEqual(excelNames(w), ['Data 2024', 'My Sheet', "O'Brien", 'NoCache']);
  assert.strictEqual(w.getWorksheet('Data 2024').getCell('C2').formula, "'My Sheet'!A1+'Data 2024'!A2");
  assert.strictEqual(w.getWorksheet('NoCache').getCell('A4').formula, "SUM('Data 2024'!A2:A10)");
  assert.strictEqual(w.getWorksheet('Data 2024').getCell('A1').value !== undefined, true);
});

test("rename: a quoted name with an apostrophe to a bare name, and a bare one to one with an apostrophe", async () => {
  {
    const { wb, bytes } = load('formulas.xlsx');
    const { edit } = op(wb, 'rename', byName(wb, "O'Brien"), 'Plain');
    const after = await checkEdit(wb, edit, bytes, [WB, ...CALC, 'xl/worksheets/sheet2.xml'], 'rename-obrien');
    assert.strictEqual(formulasOf(after)['xl/worksheets/sheet2.xml!A2'], 'Data!A2+Plain!A1');
    assert.strictEqual((await excel(after)).getWorksheet('My Sheet').getCell('A2').formula, 'Data!A2+Plain!A1');
  }
  {
    const { wb, bytes } = load('formulas.xlsx');
    const { edit } = op(wb, 'rename', byName(wb, 'My Sheet'), "Bob's");
    const after = await checkEdit(wb, edit, bytes, [WB, ...CALC, 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'], 'rename-apostrophe');
    assert.strictEqual(formulasOf(after)['xl/worksheets/sheet1.xml!C2'], "'Bob''s'!A1+Data!A2");
    assert.strictEqual(formulasOf(after)['xl/worksheets/sheet3.xml!B1'], "'Bob''s'!A1*TaxRate");
    assert.deepStrictEqual(excelNames(await excel(after)), ['Data', "Bob's", "O'Brien", 'NoCache']);
  }
});

test('rename: case-only change is allowed; same name is a no-op; duplicates and bad names refused', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  assert.deepStrictEqual(op(wb, 'rename', byName(wb, 'Data'), 'Data'), { edit: null });
  assertBytesEqual(pkg.serialize(), bytes, 'same name: unchanged');
  for (const n of ['my sheet', "O'BRIEN", 'History', '', 'a:b']) {
    assert.strictEqual(op(wb, 'rename', byName(wb, 'Data'), n).error?.code, 'invalid', `"${n}"`);
  }
  assert.strictEqual(op(wb, 'rename', 999, 'X').error?.code, 'invalid');
  assertBytesEqual(pkg.serialize(), bytes, 'refusals: unchanged');
  const { edit } = op(wb, 'rename', byName(wb, 'Data'), 'DATA');
  const after = await checkEdit(wb, edit, bytes, [WB, ...CALC, 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet4.xml'], 'rename-case');
  assert.strictEqual(formulasOf(after)['xl/worksheets/sheet4.xml!A2'], 'DATA!A2*3');
});

test('rename: sparkline (extLst xm:f) formulas follow; charts and pivot caches are left (Tier C)', async () => {
  const { wb, bytes } = load('features.xlsx');
  await loadAll(wb);
  const { edit } = op(wb, 'rename', byName(wb, 'Features'), 'Feat 2');
  // features.xlsx has no calc chain: workbook.xml (name + calcPr) and the sheet's sparklines.
  const after = await checkEdit(wb, edit, bytes, [WB, 'xl/worksheets/sheet1.xml'], 'rename-features');
  const s1 = partText(after, 'xl/worksheets/sheet1.xml');
  assert.ok(s1.includes("<xm:f>'Feat 2'!B2:E2</xm:f>") && s1.includes("<xm:f>'Feat 2'!B4:E4</xm:f>"), 'sparkline sources renamed');
  assert.ok(partText(after, 'xl/charts/chart1.xml').includes('<c:f>Features!$A$2</c:f>'), 'chart refs untouched (Tier C)');
  assert.deepStrictEqual(excelNames(await excel(after)), ['Feat 2', 'PivotData', 'Pivot']);

  const p = load('features.xlsx');
  const r = op(p.wb, 'rename', byName(p.wb, 'PivotData'), 'Source');
  await checkEdit(p.wb, r.edit, p.bytes, [WB], 'rename-pivot-source');
  assert.ok(p.pkg.text('xl/pivotCache/pivotCacheDefinition1.xml').includes('sheet="PivotData"'), 'pivot cache source untouched (Tier C)');
});

test('rename: table formulas and data-validation / conditional-format formulas follow', async () => {
  // tables.xlsx plus a second sheet whose CF, DV and a table calculated column reference "Sales".
  const bytes = await patched('tables.xlsx', {
    'xl/worksheets/sheet1.xml': (t) => replaceOnce('</sheetData>', '</sheetData><conditionalFormatting sqref="H1"><cfRule type="expression" dxfId="0" priority="1"><formula>Sales!$A$1="x"</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="H2"><formula1>Sales!$A$2:$A$4</formula1></dataValidation></dataValidations>')(t.replace(/<conditionalFormatting[\s\S]*?<\/conditionalFormatting>|<dataValidations[\s\S]*?<\/dataValidations>/g, '')),
    'xl/tables/table1.xml': replaceOnce('<calculatedColumnFormula>', '<calculatedColumnFormula>0*Sales!$Z$1+'),
  });
  const { wb } = load('tables.xlsx', bytes);
  const { edit } = op(wb, 'rename', byName(wb, 'Sales'), 'Sales 2');
  const after = await checkEdit(wb, edit, bytes, [WB, ...CALC, 'xl/worksheets/sheet1.xml', 'xl/tables/table1.xml'], 'rename-tables');
  const s1 = partText(after, 'xl/worksheets/sheet1.xml');
  assert.ok(s1.includes("<formula>'Sales 2'!$A$1=\"x\"</formula>"), s1.slice(s1.indexOf('<conditionalFormatting')));
  assert.ok(s1.includes("<formula1>'Sales 2'!$A$2:$A$4</formula1>"));
  assert.ok(partText(after, 'xl/tables/table1.xml').includes("<calculatedColumnFormula>0*'Sales 2'!$Z$1+SalesTable"));
});

test('structureLocked workbook refuses all three, nothing changed', () => {
  const { pkg, wb, bytes } = load('protected-structure.xlsx');
  assert.ok(wb.structureLocked);
  const id = wb.sheets[0].id;
  for (const [k, args] of [['add', []], ['rename', [id, 'Other']], ['delete', [id]]]) {
    const r = op(wb, k, ...args);
    assert.strictEqual(r.error?.code, 'read-only', k);
  }
  assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
});

// ---------------------------------------------------------------------------------------------
// deleteSheet

test('delete: references -> #REF!, part and relationship removed, part restored on undo', async () => {
  const { pkg, wb, bytes } = load('formulas.xlsx');
  await loadAll(wb);
  const before = formulasOf(bytes);
  const order = wb.sheets.map((s) => s.name);
  const { edit } = op(wb, 'delete', byName(wb, 'My Sheet'));
  const touched = [WB, ...CALC, 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'];
  const after = await checkEdit(wb, edit, bytes, touched, 'delete-mysheet');
  assert.ok(!partNames(after).includes('xl/worksheets/sheet2.xml'));
  assert.ok(!partText(after, CT).includes('/xl/worksheets/sheet2.xml'));
  assert.ok(!partText(after, WB_RELS).includes('worksheets/sheet2.xml'));
  assert.ok(!partText(after, WB).includes('My Sheet'));
  const now = formulasOf(after);
  for (const [k, f] of Object.entries(before)) {
    if (k.startsWith('xl/worksheets/sheet2.xml')) { assert.strictEqual(now[k], undefined); continue; }
    const dec = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    assert.strictEqual(dec(now[k]), deleteSheetInFormula(dec(f), 'My Sheet', order), k);
  }
  assert.strictEqual(now['xl/worksheets/sheet1.xml!C2'], '#REF!+Data!A2');
  assert.strictEqual(now['xl/worksheets/sheet3.xml!B1'], '#REF!*TaxRate');
  const w = await excel(after);
  assert.deepStrictEqual(excelNames(w), ['Data', "O'Brien", 'NoCache']);
  assert.strictEqual(w.getWorksheet('Data').getCell('C2').formula, '#REF!+Data!A2');
  // Undo restored the part byte for byte at its ZIP position (checkEdit); the sheet comes back with a fresh id.
  replay(wb, edit, true);
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), order);
  const back = wb.sheets.find((s) => s.name === 'My Sheet');
  const sheet = await wb.sheet(back.id);
  assert.strictEqual(sheet.doc, pkg.xml('xl/worksheets/sheet2.xml'), 'the reappeared sheet loads from the restored tree');
  // ...and is editable again through ops (setCells is not behind the structural guards).
  const r = await applyXlsxEdit(wb, pkg, { op: 'setCells', sheetId: back.id, cells: [{ r: 0, c: 5, input: '7' }] }, { confirmed: false });
  assert.ok(r.ok, JSON.stringify(r));
  save(pkg, 'edit after undo of delete');
});

test('delete: localSheetId decremented, scoped names removed, activeTab/firstSheet clamped', async () => {
  const bytes = await patched('formulas.xlsx', {
    [WB]: (t) => replaceOnce('<definedName name="LocalName">', '<definedName name="_xlnm.Print_Area" localSheetId="1">\'My Sheet\'!$A$1:$B$2</definedName><definedName name="Later" localSheetId="2">\'O\'\'Brien\'!$A$1</definedName><definedName name="Last" localSheetId="3">\'My Sheet\'!$A$1+NoCache!$A$1</definedName><definedName name="LocalName">')(
      replaceOnce('<workbookView ', '<workbookView activeTab="1" firstSheet="3" ')(t)),
  });
  const { wb } = load('formulas.xlsx', bytes);
  const { edit } = op(wb, 'delete', byName(wb, 'My Sheet'));
  const after = await checkEdit(wb, edit, bytes, [WB, ...CALC, 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'], 'delete-names');
  const t = partText(after, WB);
  assert.ok(!t.includes('_xlnm.Print_Area'), 'name scoped to the deleted sheet removed');
  assert.ok(t.includes('<definedName name="Later" localSheetId="1">\'O\'\'Brien\'!$A$1</definedName>'));
  assert.ok(t.includes('<definedName name="Last" localSheetId="2">#REF!+NoCache!$A$1</definedName>'));
  assert.ok(t.includes('<workbookView activeTab="1" firstSheet="2" '), t.slice(t.indexOf('<workbookView'), t.indexOf('<workbookView') + 60));
  const w = await excel(after);
  assert.deepStrictEqual(excelNames(w), ['Data', "O'Brien", 'NoCache']);
});

test('delete: every scoped name gone removes definedNames; activeTab moves off hidden sheets; last visible refused', async () => {
  const bytes = await patched('hidden-sheets.xlsx', {
    [WB]: (t) => replaceOnce('</sheets>', '</sheets><definedName_PLACEHOLDER/>')(replaceOnce('<workbookView ', '<workbookView activeTab="1" ')(t))
      .replace('<definedName_PLACEHOLDER/>', '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">\'Second Sheet\'!$A$1:$C$3</definedName></definedNames>'),
  });
  const { pkg, wb } = load('hidden-sheets.xlsx', bytes);
  const { edit } = op(wb, 'delete', byName(wb, 'Second Sheet'));
  const after = await checkEdit(wb, edit, bytes, [WB, WB_RELS, CT, 'xl/worksheets/sheet2.xml'], 'delete-hidden-tabs');
  const t = partText(after, WB);
  assert.ok(!t.includes('<definedNames'), 'empty definedNames removed');
  // Remaining tabs: Values, Hidden Sheet, Very Hidden Sheet; index 1 is hidden, nothing visible after it -> 0.
  assert.ok(t.includes('<workbookView activeTab="0" '), t.slice(t.indexOf('<workbookView'), t.indexOf('<workbookView') + 60));
  assert.deepStrictEqual(excelNames(await excel(after)), ['Values', 'Hidden Sheet', 'Very Hidden Sheet']);
  // Values is now the last visible worksheet: refused; hidden sheets can still go.
  const r = op(wb, 'delete', byName(wb, 'Values'));
  assert.strictEqual(r.error?.code, 'blocked');
  assert.match(r.error.message, /visible/);
  assertBytesEqual(pkg.serialize(), after, 'refusal changed nothing');
  const h = op(wb, 'delete', byName(wb, 'Very Hidden Sheet'));
  assert.ok(h.edit);
  save(pkg, 'delete very hidden');
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Values', 'Hidden Sheet']);
});

test('delete: exclusive children removed (drawing, chart, image, comments, VML), shared ones kept', async () => {
  const { pkg, wb, bytes } = load('features.xlsx');
  await loadAll(wb);
  const { edit } = op(wb, 'delete', byName(wb, 'Features'));
  const gone = ['xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels',
    'xl/charts/chart1.xml', 'xl/media/image1.png', 'xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml'];
  const after = await checkEdit(wb, edit, bytes, [WB, WB_RELS, CT, ...gone], 'delete-features');
  const names = partNames(after).map((n) => n.toLowerCase());
  for (const g of gone) assert.ok(!names.includes(g.toLowerCase()), `${g} removed`);
  for (const k of ['xl/pivotCache/pivotCacheDefinition1.xml', 'xl/pivotTables/pivotTable1.xml', 'xl/styles.xml', 'xl/theme/theme1.xml']) assert.ok(names.includes(k.toLowerCase()), `${k} kept`);
  const ct = partText(after, CT);
  for (const g of ['/xl/drawings/drawing1.xml', '/xl/charts/chart1.xml', '/xl/comments1.xml']) assert.ok(!ct.includes(g), `Override for ${g} removed`);
  assert.ok(ct.includes('Extension="png"') && ct.includes('Extension="vml"'), 'Defaults are left alone');
  assert.deepStrictEqual(excelNames(await excel(after)), ['PivotData', 'Pivot']);
  replay(wb, edit, true);
  assertBytesEqual(pkg.serialize(), bytes, 'undo restores every part');
});

test('delete: a part shared with another sheet is kept, its exclusive sibling removed', async () => {
  const PS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings';
  const rels = (targets) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + targets.map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="${t}"/>`).join('') + '</Relationships>';
  const bytes = await patched('basic.xlsx', {
    [CT]: replaceOnce('<Default Extension="xml"', `<Default Extension="bin" ContentType="${PS}"/><Default Extension="xml"`),
    'xl/worksheets/_rels/sheet1.xml.rels': () => rels(['../printerSettings/printerSettings1.bin']),
    'xl/worksheets/_rels/sheet2.xml.rels': () => rels(['../printerSettings/printerSettings1.bin', '../printerSettings/printerSettings2.bin']),
    'xl/printerSettings/printerSettings1.bin': () => 'shared',
    'xl/printerSettings/printerSettings2.bin': () => 'mine',
  });
  const { wb } = load('basic.xlsx', bytes);
  const { edit } = op(wb, 'delete', byName(wb, 'Second Sheet'));
  const after = await checkEdit(wb, edit, bytes,
    [WB, WB_RELS, CT, 'xl/worksheets/sheet2.xml', 'xl/worksheets/_rels/sheet2.xml.rels', 'xl/printerSettings/printerSettings2.bin'], 'delete-shared');
  const names = partNames(after);
  assert.ok(names.includes('xl/printerSettings/printerSettings1.bin'), 'shared part kept');
  assert.ok(!names.includes('xl/printerSettings/printerSettings2.bin'), 'exclusive part removed');
  assert.deepStrictEqual(excelNames(await excel(after)), ['Values']);
});

test('delete: refused for pivot source, pivot host, chartsheet, unknown id — nothing changed', () => {
  {
    const { pkg, wb, bytes } = load('features.xlsx');
    const src = op(wb, 'delete', byName(wb, 'PivotData'));
    assert.strictEqual(src.error?.code, 'blocked');
    assert.match(src.error.message, /source of a pivot table/);
    const host = op(wb, 'delete', byName(wb, 'Pivot'));
    assert.strictEqual(host.error?.code, 'blocked');
    assert.match(host.error.message, /pivot table/);
    assert.strictEqual(op(wb, 'delete', 99).error?.code, 'invalid');
    assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
    assert.deepStrictEqual(pkg.touchedParts(), []);
  }
  {
    const { pkg, wb, bytes } = load('chartsheet.xlsx');
    const r = op(wb, 'delete', byName(wb, 'Chart Sheet'));
    assert.strictEqual(r.error?.code, 'blocked');
    assert.match(r.error.message, /not a worksheet/);
    assertBytesEqual(pkg.serialize(), bytes, 'unchanged');
  }
});

test('delete: a table used by a formula elsewhere refuses; unused tables go with the sheet', async () => {
  const { pkg, wb, bytes } = load('tables.xlsx');
  const add = op(wb, 'add', 'Other');
  assert.ok(add.edit);
  const other = byName(wb, 'Other');
  const set = async (input) => {
    const r = await applyXlsxEdit(wb, pkg, { op: 'setCells', sheetId: other, cells: [{ r: 0, c: 0, input }] }, { confirmed: false });
    assert.ok(r.ok, JSON.stringify(r));
  };
  await set('=SUM(SalesTable[Units])');
  const before = pkg.serialize();
  const r = op(wb, 'delete', byName(wb, 'Sales'));
  assert.strictEqual(r.error?.code, 'blocked');
  assert.match(r.error.message, /uses a table/);
  assertBytesEqual(pkg.serialize(), before, 'refusal changed nothing');
  await set('=Sales!A1&"x"');
  const mid = save(pkg, 'mid');
  const fresh = load('tables.xlsx', mid);
  await loadAll(fresh.wb);
  const d = op(fresh.wb, 'delete', byName(fresh.wb, 'Sales'));
  const after = await checkEdit(fresh.wb, d.edit, mid,
    [WB, WB_RELS, CT, 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/tables/table1.xml', 'xl/tables/table2.xml', 'xl/worksheets/sheet2.xml'],
    'delete-tables');
  assert.strictEqual(formulasOf(after)['xl/worksheets/sheet2.xml!A1'], '#REF!&amp;"x"');
  const w = await excel(after);
  assert.deepStrictEqual(excelNames(w), ['Other']);
  assert.strictEqual(w.getWorksheet('Other').getCell('A1').formula, '#REF!&"x"');
  assert.ok(bytes.length > 0);
});

// ---------------------------------------------------------------------------------------------
// Through ops.applyXlsxEdit, with the provider-style outside undo/redo: applyEdit(invertEdit(...))
// then ops.refreshAfterEdit ONLY (no syncSheetEntries of its own) — refreshAfterEdit re-reads the
// sheet list whenever the edit touches workbook.xml.

function outside(wb, edit, undo) {
  const e = undo ? invertEdit(edit) : edit;
  applyEdit(wb.pkg, e);
  refreshAfterEdit(wb, e);
}

for (const [label, name, mk, expect] of [
  ['add', 'basic.xlsx', () => ({ op: 'addSheet', name: 'Added' }), ['Values', 'Second Sheet', 'Added']],
  ['add (after the first)', 'formulas.xlsx', (wb) => ({ op: 'addSheet', afterSheetId: byName(wb, 'Data') }), ['Data', 'Sheet1', 'My Sheet', "O'Brien", 'NoCache']],
  ['delete', 'formulas.xlsx', (wb) => ({ op: 'deleteSheet', sheetId: byName(wb, 'My Sheet') }), ['Data', "O'Brien", 'NoCache']],
  ['rename', 'formulas.xlsx', (wb) => ({ op: 'renameSheet', sheetId: byName(wb, 'Data'), name: 'Data 2024' }), ['Data 2024', 'My Sheet', "O'Brien", 'NoCache']],
]) {
  test(`ops: ${label}, then outside undo/redo with refreshAfterEdit: wb.sheets and the grid match a fresh load`, async () => {
    const { pkg, wb, bytes } = load(name);
    await loadAll(wb);
    const res = await applyXlsxEdit(wb, pkg, mk(wb), { confirmed: true });
    assert.ok(res.ok && res.edit, JSON.stringify(res.ok ? res : res.error));
    assert.strictEqual(res.invalidate, 'workbook');
    const after = save(pkg, label);
    assert.deepStrictEqual(wb.sheets.map((s) => s.name), expect);
    await assertModel(wb, `${label} applied`);
    for (let round = 0; round < 2; round++) {
      outside(wb, res.edit, true);
      assertBytesEqual(pkg.serialize(), bytes, `${label} undo ${round}`);
      await loadAll(wb);
      await assertModel(wb, `${label} undo ${round}`);
      outside(wb, res.edit, false);
      assertBytesEqual(pkg.serialize(), after, `${label} redo ${round}`);
      assert.deepStrictEqual(wb.sheets.map((s) => s.name), expect, `${label} redo ${round}: names`);
      await loadAll(wb);
      await assertModel(wb, `${label} redo ${round}`);
    }
    // A cell edit on the restored list goes to the right sheet.
    const target = wb.sheets.find((s) => s.kind === 'worksheet');
    const cell = await applyXlsxEdit(wb, pkg, { op: 'setCells', sheetId: target.id, cells: [{ r: 30, c: 0, input: 'after' }] }, { confirmed: false });
    assert.ok(cell.ok && cell.edit && cell.edit.changes.some((c) => c.part === target.part), JSON.stringify(cell.ok ? '' : cell.error));
    await assertModel(wb, `${label} cell edit after redo`);
  });
}

test('ops: a sheet op aborted after writing restores wb.sheets and every touched sheet index', async () => {
  // A bundle whose calc handling throws: rename and delete (which force recalculation) fail after
  // sheetsOps has written (and re-read wb.sheets); ops.sheetOp aborts and must restore the read model.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  const outfile = path.join(root, 'tests', '.build', 'office-core-failcalc.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'office', 'core', 'index.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{
      name: 'fail-calc',
      setup(b) {
        b.onLoad({ filter: /[\\/]xlsx[\\/]calc\.ts$/ }, () => ({
          contents: 'export function needsFullCalcOnLoad() { return true; }\nexport function ensureFullCalcOnLoad() { throw new Error("calc handling failed (test)"); }',
          loader: 'ts',
        }));
      },
    }],
  });
  const c2 = createRequire(import.meta.url)(outfile);
  for (const mk of [(wb) => ({ op: 'renameSheet', sheetId: wb.sheets[1].id, name: 'Renamed' }), (wb) => ({ op: 'deleteSheet', sheetId: wb.sheets[1].id })]) {
    const pkg = c2.pkg.OfficePackage.open('formulas.xlsx', fixture('formulas.xlsx'));
    const wb = c2.xlsx.workbook.Workbook.load(pkg);
    for (const e of wb.sheets) if (e.kind === 'worksheet') await wb.sheet(e.id);
    const before = wb.sheets.map((e) => ({ ...e }));
    const op = mk(wb);
    const res = await c2.xlsx.ops.applyXlsxEdit(wb, pkg, op, { confirmed: true });
    assert.strictEqual(res.ok, false, op.op);
    assert.match(res.error.message, /calc handling failed/);
    assertBytesEqual(pkg.serialize(), fixture('formulas.xlsx'), `${op.op}: aborted, unchanged`);
    assert.deepStrictEqual(wb.sheets, before, `${op.op}: wb.sheets restored (names, ids, parts)`);
    // Every loaded sheet reads the restored tree (rename/delete had rewritten formulas on other sheets).
    for (const e of wb.sheets) {
      if (e.kind !== 'worksheet') continue;
      // A sheet whose deletion was rolled back has a re-created tree: it reloads under the same id.
      const live = wb.loadedSheet(e.id) ?? await wb.sheet(e.id);
      const fresh = await Workbook.load(OfficePackage.open('f.xlsx', fixture('formulas.xlsx'))).sheet(e.id);
      const rows = (s) => s.cellsIn([0, 0, 39, 12]).map((c) => JSON.stringify([c.r, c.c, c.value, c.formula]));
      assert.deepStrictEqual(rows(live), rows(fresh), `${op.op}: ${e.name} cells`);
      const tree = pkg.xml(live.part).root;
      for (const c of live.cellsIn([0, 0, 39, 12])) assert.strictEqual(rootOf(live.cellNode(c.r, c.c)), tree, `${op.op}: ${e.name} (${c.r}, ${c.c}) on the tree`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Seeded random sequences with undo/redo (G5 over sequences, validators and model after each step)

const SEQ_FIXTURES = [['formulas.xlsx', 0x5eed40], ['features.xlsx', 0x40f00d], ['hidden-sheets.xlsx', 0xbad5ee7], ['prefixed-namespaces.xlsx', 0x1234]];

for (const [name, seed] of SEQ_FIXTURES) {
  test(`random add/rename/delete/cell sequences with undo/redo: ${name} (seed ${seed.toString(16)})`, async () => {
    const random = rng(seed);
    const pick = (a) => a[Math.floor(random() * a.length)];
    const { pkg, wb, bytes } = load(name);
    await loadAll(wb);
    const done = [];    // applied edits (undo stack)
    const undone = [];  // redo stack
    const states = [bytes];   // serialised bytes after each applied edit (states[done.length])
    let applied = 0;
    let refused = 0;
    const kinds = { add: 0, rename: 0, delete: 0, cells: 0, undo: 0, redo: 0 };
    const NAMES = ['Alpha', "Q'tr", 'Sheet 9', 'Ωmega', 'x', 'Data', 'Long name that is thirty-one ch', 'A1'];
    const roll2redo = () => {
      const { e, bytes: was } = undone.pop();
      replay(wb, e, false);
      done.push(e);
      states.push(pkg.serialize());
      assertBytesEqual(states[states.length - 1], was, 'redo returns the state the edit produced');
      kinds.redo++;
    };
    for (let step = 0; step < 60; step++) {
      const roll = random();
      const ws = wb.sheets.filter((s) => s.kind === 'worksheet');
      let res = null;
      if (roll < 0.15 && done.length > 0) {
        const e = done.pop();
        replay(wb, e, true);
        undone.push({ e, bytes: states.pop() });
        kinds.undo++;
        assertBytesEqual(pkg.serialize(), states[states.length - 1], `step ${step}: undo returns the previous state`);
        if (random() < 0.4) {   // undo -> redo pair
          save(pkg, `step ${step} undo`);
          await assertModel(wb, `step ${step} undo`);
          roll2redo();
        }
      } else if (roll < 0.32 && undone.length > 0) {
        roll2redo();
      } else {
        let kind;
        if (roll < 0.45) kind = 'add', res = op(wb, 'add', random() < 0.5 ? undefined : pick(NAMES), random() < 0.5 ? pick(wb.sheets).id : undefined);
        else if (roll < 0.7) kind = 'rename', res = op(wb, 'rename', pick(wb.sheets).id, pick(NAMES) + (random() < 0.5 ? '' : String(step)));
        else if (roll < 0.85) kind = 'delete', res = op(wb, 'delete', pick(ws).id);
        else {
          kind = 'cells';
          const target = pick(ws);
          const ref = pick(wb.sheets.filter((s) => s.kind === 'worksheet'));
          const q = core.xlsx.refs.quoteSheetName(ref.name);
          const r = await applyXlsxEdit(wb, pkg, { op: 'setCells', sheetId: target.id, cells: [{ r: Math.floor(random() * 5), c: 8 + Math.floor(random() * 3), input: `=${q}!A1+1` }] }, { confirmed: false });
          res = r.ok ? { edit: r.edit } : { error: r.error };
        }
        if (res.error) {
          refused++;
          assertBytesEqual(pkg.serialize(), states[states.length - 1], `step ${step}: refusal (${res.error.message}) changed nothing`);
        } else if (res.edit) {
          applied++;
          kinds[kind]++;
          done.push(res.edit);
          undone.length = 0;
          states.push(pkg.serialize());
        }
      }
      save(pkg, `step ${step}`);
      await loadAll(wb);
      await assertModel(wb, `step ${step}`);
    }
    assert.ok(applied >= 15, `enough edits applied (${applied}, ${refused} refused)`);
    for (const k of Object.keys(kinds)) assert.ok(kinds[k] > 0, `${k} exercised: ${JSON.stringify(kinds)}`);
    const last = pkg.serialize();
    writeOut(OUT, `random-${name}`, last);
    if (name !== 'prefixed-namespaces.xlsx') {   // ExcelJS cannot read prefixed SpreadsheetML
      assert.deepStrictEqual(excelNames(await excel(last)), wb.sheets.filter((s) => s.kind === 'worksheet').map((s) => s.name));
    }
    while (done.length > 0) replay(wb, done.pop(), true);
    assertBytesEqual(pkg.serialize(), bytes, 'undoing everything restores the original bytes');
    await assertModel(wb, 'all undone');
  });
}
