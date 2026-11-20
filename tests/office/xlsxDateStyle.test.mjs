// WP-22: the date style patch (src/office/core/xlsx/stylesWrite.ts), spec §9.3.1 and the Phase 2 date
// acceptance criteria of §14. Every save here runs packageValidator + xlsxValidator (G6 format rules).
//
// Every edited workbook is written to tests/.out/xlsxDateStyle/<case>.xlsx for scripts/verify-office-open.ps1.
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { core, fixture, writeOut, assertBytesEqual } from './_helpers.mjs';
import { assertG3, assertG4, assertG5, rng } from './_roundtrip.mjs';
import { assertViewMatchesFile } from './_viewCheck.mjs';

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { applyXlsxEdit, refreshAfterEdit } = core.xlsx.ops;
const { applyEdit, invertEdit } = core.edits;
const { serializeAndVerify, packageValidator } = core.save;
const { xlsxValidator } = core.xlsx.validate;
const { MAX_CELL_XFS, DATE_AS_TEXT_NOTICE } = core.xlsx.stylesWrite;
const OUT = 'xlsxDateStyle';
const SHEET1 = 'xl/worksheets/sheet1.xml';
const STYLES = 'xl/styles.xml';
const WB = 'xl/workbook.xml';
/** First edit of a workbook without a calc chain: the sheet, calcPr in workbook.xml, and the styles patch. */
const PATCHED = [SHEET1, STYLES, WB];

function load(name, bytes = fixture(name)) {
  const pkg = OfficePackage.open(name, bytes);
  return { pkg, wb: Workbook.load(pkg), bytes };
}
const set = (sheetId, cells) => ({ op: 'setCells', sheetId, cells: cells.map(([r, c, input]) => ({ r, c, input })) });
const run = (wb, pkg, op) => applyXlsxEdit(wb, pkg, op, { confirmed: false });
const partText = (bytes, part) => OfficePackage.open('x.xlsx', bytes).text(part);

/** serializeAndVerify with every xlsx validator; returns the bytes. */
function save(pkg) {
  const r = serializeAndVerify(pkg, [packageValidator, xlsxValidator]);
  assert.ok(r.ok, `verify: ${JSON.stringify(r.ok ? [] : r.failures)}`);
  return r.bytes;
}

async function excel(bytes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(bytes));
  return w;
}

async function patched(name, edits) {
  const zip = await JSZip.loadAsync(fixture(name));
  for (const [part, fn] of Object.entries(edits)) zip.file(part, fn(await zip.file(part).async('string')));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
const replaceOnce = (from, to) => (t) => { assert.ok(t.includes(from), `part should contain ${from}`); return t.replace(from, to); };

/** Span of the `c` element for `ref` in sheet XML. */
function cellSpan(text, ref) {
  const m = new RegExp(`<c r="${ref}"[ />]`).exec(text);
  assert.ok(m, `cell ${ref} not found`);
  const start = m.index;
  const selfEnd = text.indexOf('/>', start);
  const open = text.indexOf('>', start);
  const end = open === selfEnd + 1 ? selfEnd + 2 : text.indexOf('</c>', start) + 4;
  return { start, end };
}

/** cellXfs records of a styles part, as text. */
const xfsOf = (stylesText) => {
  const m = /<(\w+:)?cellXfs[^>]*>([\s\S]*?)<\/(\w+:)?cellXfs>/.exec(stylesText);
  return [...m[2].matchAll(/<(\w+:)?xf\b[^>]*?(\/>|>[\s\S]*?<\/(\w+:)?xf>)/g)].map((x) => x[0]);
};

/**
 * G4 for styles.xml: the new text is exactly the original with `appended` inserted right after the
 * last cellXfs record and (when `count` is given) cellXfs/@count changed from count to count+n.
 */
function assertStylesAppendOnly(orig, now, appended, count) {
  const close = /<\/(\w+:)?cellXfs>/.exec(orig);
  let want = orig.slice(0, close.index) + appended.join('') + orig.slice(close.index);
  if (count !== undefined) {
    const from = `cellXfs count="${count}"`;
    assert.ok(want.includes(from));
    want = want.replace(from, `cellXfs count="${count + appended.length}"`);
  } else {
    assert.ok(!/cellXfs[^>]*count=/.test(now), 'no count attribute is invented');
  }
  assert.strictEqual(now, want, 'styles.xml differs only by the appended xf and cellXfs/@count');
}

/** Pre-existing records byte-identical and at the same index. */
function assertXfsKept(orig, now) {
  const a = xfsOf(orig), b = xfsOf(now);
  for (let i = 0; i < a.length; i++) assert.strictEqual(b[i], a[i], `xf[${i}] unchanged and in place`);
}

/** One edit on a fresh copy: ok, G3, G5, save (validators), output written. */
async function checkEdit({ name, bytes, op, touched, out, write = true }) {
  const { pkg, wb, bytes: orig } = load(name, bytes);
  const res = await run(wb, pkg, op);
  assert.ok(res.ok, `edit refused: ${JSON.stringify(res.error)}`);
  assert.ok(res.edit, 'edit recorded');
  const after = save(pkg);
  assertG3(orig, after, touched, `${out} G3`);
  assertG5(pkg, res.edit, orig, `${out} G5`);
  // (An output from a deliberately inconsistent input is not kept: tests/.out holds valid workbooks only.)
  if (write) writeOut(OUT, `${out}.xlsx`, after);
  const re = OfficePackage.open('x.xlsx', after);
  return { res, after, orig, pkg, wb, sheet: re.text(SHEET1), styles: re.has(STYLES) ? re.text(STYLES) : undefined };
}

const XF14 = '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>';

// ---------------------------------------------------------------------------------------------
// The patch itself

test('date in a General cell: v is the serial, s points at an xf with numFmtId 14; ExcelJS reads a Date', async () => {
  const { sheet, styles, after, orig } = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[2, 1, '2024-03-15']]),
    touched: PATCHED, out: 'general-date' });
  assert.ok(sheet.includes('<c r="B3" s="3"><v>45366</v></c>'), sheet);
  const o = partText(orig, STYLES);
  assertStylesAppendOnly(o, styles, [XF14], 3);   // G4 for styles.xml
  assertXfsKept(o, styles);
  assertG4(partText(orig, SHEET1), sheet, cellSpan(partText(orig, SHEET1), 'B3'), 'sheet G4');
  const v = (await excel(after)).worksheets[0].getCell('B3').value;
  assert.ok(v instanceof Date && v.toISOString().startsWith('2024-03-15'), String(v));
});

test('date-time uses numFmtId 22', async () => {
  const { sheet, styles, after, orig } = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[2, 1, '2024-03-15T13:45']]),
    touched: PATCHED, out: 'general-datetime' });
  assert.ok(sheet.includes(`<c r="B3" s="3"><v>${45366 + (13 * 60 + 45) / 1440}</v></c>`), sheet);
  assertStylesAppendOnly(partText(orig, STYLES), styles, [XF14.replace('"14"', '"22"')], 3);
  const v = (await excel(after)).worksheets[0].getCell('B3').value;
  assert.ok(v instanceof Date && v.toISOString().startsWith('2024-03-15T13:45'), String(v));
});

test('a new cell (no c yet) gets the patch too, and the dimension grows', async () => {
  const { sheet, styles, orig } = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[5, 3, '2024-01-02']]),
    touched: PATCHED, out: 'new-cell' });
  assert.ok(sheet.includes('<row r="6"><c r="D6" s="3"><v>45293</v></c></row>'), sheet);
  assert.ok(sheet.includes('<dimension ref="A1:D6"/>'));
  assertStylesAppendOnly(partText(orig, STYLES), styles, [XF14], 3);
});

test('styled General cell keeps fontId/fillId/borderId/alignment', async () => {
  // B2 has s=2: fill 2, border 1.
  const fill = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[1, 1, '2024-03-15']]), touched: PATCHED, out: 'styled-fill-border' });
  assert.ok(fill.sheet.includes('<c r="B2" s="3"><v>45366</v></c>'));
  assertStylesAppendOnly(partText(fill.orig, STYLES), fill.styles,
    ['<xf numFmtId="14" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="1"/>'], 3);
  // B1 has s=1: bold font.
  const font = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[0, 1, '2024-03-15']]), touched: PATCHED, out: 'styled-font' });
  assertStylesAppendOnly(partText(font.orig, STYLES), font.styles,
    ['<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'], 3);
  // A record with child elements: children copied from the source text; an existing numFmtId replaced in place.
  const XF2 = '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>';
  const withKids = await patched('no-date-style.xlsx', {
    [STYLES]: replaceOnce(XF2, '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="0" applyAlignment="1"><alignment horizontal="center" wrapText="1"/><protection locked="0"/></xf>'),
  });
  const al = await checkEdit({ name: 'kids.xlsx', bytes: withKids, op: set(1, [[1, 1, '2024-03-15']]), touched: PATCHED, out: 'styled-alignment' });
  assertStylesAppendOnly(partText(al.orig, STYLES), al.styles,
    ['<xf numFmtId="14" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/><protection locked="0"/></xf>'], 3);
  const cell = (await excel(al.after)).worksheets[0].getCell('B2');
  assert.ok(cell.value instanceof Date);
  assert.strictEqual(cell.alignment?.horizontal, 'center');
  assert.strictEqual(cell.fill?.fgColor?.argb, 'FFFFFF00');
});

test('second date in a like-styled cell appends nothing; an existing Excel-written date xf is reused', async () => {
  const { pkg, wb, bytes } = load('no-date-style.xlsx');
  const first = await run(wb, pkg, set(1, [[2, 1, '2024-03-15']]));
  assert.ok(first.ok && first.edit);
  const afterFirst = save(pkg);
  const second = await run(wb, pkg, set(1, [[2, 2, '2025-12-31']]));   // C3: inline string, no s -> same base 0
  assert.ok(second.ok && second.edit);
  assert.ok(!second.edit.changes.some((c) => c.part === STYLES), 'second edit does not touch styles.xml');
  const afterSecond = save(pkg);
  assertG3(afterFirst, afterSecond, [SHEET1], 'second date G3');
  assert.ok(partText(afterSecond, SHEET1).includes('<c r="C3" s="3"><v>46022</v></c>'));
  // Full undo is byte-identical.
  applyEdit(pkg, invertEdit(second.edit)); refreshAfterEdit(wb, second.edit);
  applyEdit(pkg, invertEdit(first.edit)); refreshAfterEdit(wb, first.edit);
  assertBytesEqual(pkg.serialize(), bytes, 'undo both');

  // A date record Excel wrote (attributes in another order) is reused: styles.xml untouched.
  const excelXf = '<xf numFmtId="14" applyNumberFormat="1" xfId="0" borderId="0" fillId="0" fontId="0"/>';
  const withDate = await patched('no-date-style.xlsx', {
    [STYLES]: (t) => replaceOnce('<cellXfs count="3">', '<cellXfs count="4">')(t).replace('</cellXfs>', `${excelXf}</cellXfs>`),
  });
  const r = await checkEdit({ name: 'reuse.xlsx', bytes: withDate, op: set(1, [[2, 1, '2024-03-15']]), touched: [SHEET1, WB], out: 'reuse-existing' });
  assert.ok(r.sheet.includes('<c r="B3" s="3"><v>45366</v></c>'));
  // ... but not when the child XML differs.
  const withKid = await patched('no-date-style.xlsx', {
    [STYLES]: (t) => replaceOnce('<cellXfs count="3">', '<cellXfs count="4">')(t).replace('</cellXfs>', `${XF14.replace('/>', '><alignment horizontal="left"/></xf>')}</cellXfs>`),
  });
  const k = await checkEdit({ name: 'kid.xlsx', bytes: withKid, op: set(1, [[2, 1, '2024-03-15']]), touched: PATCHED, out: 'no-reuse-children' });
  assert.ok(k.sheet.includes('<c r="B3" s="4"><v>45366</v></c>'));
  assertStylesAppendOnly(partText(k.orig, STYLES), k.styles, [XF14], 4);
});

test('lowest equal index is reused when the table already has duplicates', async () => {
  const bytes = await patched('no-date-style.xlsx', {
    [STYLES]: (t) => replaceOnce('<cellXfs count="3">', '<cellXfs count="5">')(t).replace('</cellXfs>', `${XF14}${XF14}</cellXfs>`),
  });
  const r = await checkEdit({ name: 'dups.xlsx', bytes, op: set(1, [[2, 1, '2024-03-15']]), touched: [SHEET1, WB], out: 'reuse-lowest' });
  assert.ok(r.sheet.includes('<c r="B3" s="3">'));
});

test('date-formatted, currency-formatted target: styles.xml untouched, serial stored; Text-formatted target: stored as text', async () => {
  const BASIC = [SHEET1, WB];
  const d = await checkEdit({ name: 'basic.xlsx', op: set(1, [[12, 1, '2024-01-02']]), touched: BASIC, out: 'date-cell' });
  assert.ok(d.sheet.includes('<c r="B13" s="1"><v>45293</v></c>'));
  const c = await checkEdit({ name: 'basic.xlsx', op: set(1, [[16, 1, '2024-03-15']]), touched: BASIC, out: 'currency-cell' });
  assert.ok(c.sheet.includes('<c r="B17" s="5"><v>45366</v></c>'));
  const t = await checkEdit({ name: 'basic.xlsx', op: set(1, [[20, 1, '2024-03-15']]), touched: BASIC, out: 'text-cell' });
  assert.ok(t.sheet.includes('<c r="B21" s="9" t="inlineStr"><is><t xml:space="preserve">2024-03-15</t></is></c>'));
  assert.strictEqual((await excel(t.after)).getWorksheet('Values').getCell('B21').value, '2024-03-15');
});

test('a custom number format whose code is "General" is General: the date style patch applies', async () => {
  const bytes = await patched('no-date-style.xlsx', {
    [STYLES]: (t) => t
      .replace('<fonts count="2">', '<numFmts count="1"><numFmt numFmtId="164" formatCode="General"/></numFmts><fonts count="2">')
      .replace('<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>',
        '<xf numFmtId="164" fontId="0" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>'),
  });
  const { pkg, wb } = load('general-custom.xlsx', bytes);
  const styles = core.xlsx.ops.stylesFor(wb);
  assert.strictEqual(styles.numFmtId(2), 164);
  assert.ok(styles.isGeneralStyle(2) && styles.isGeneralStyle(0), "id 164 \"General\" and id 0 are General");
  const res = await run(wb, pkg, set(1, [[1, 1, '2024-03-15']]));
  assert.ok(res.ok && res.edit, JSON.stringify(res));
  assert.ok(res.edit.changes.some((c) => c.part === STYLES), 'styles patched');
  const text = pkg.text(SHEET1);
  assert.ok(text.includes('<c r="B2" s="3"><v>45366</v></c>'), text);
  assert.ok(pkg.text(STYLES).includes('<xf numFmtId="14" fontId="0" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/></cellXfs>'));
  assert.ok(styles.isDateStyle(3));
  const after = save(pkg);
  writeOut(OUT, 'general-custom.xlsx', after);
  assert.ok((await excel(after)).getWorksheet(1).getCell('B2').value instanceof Date);
});

test('no-date-style-nocount.xlsx: no count attribute is invented', async () => {
  const { styles, orig } = await checkEdit({ name: 'no-date-style-nocount.xlsx', op: set(1, [[2, 1, '2024-03-15']]),
    touched: PATCHED, out: 'nocount' });
  assertStylesAppendOnly(partText(orig, STYLES), styles, [XF14], undefined);
});

test('x:-prefixed styles part: the copy keeps the prefix', async () => {
  const bytes = await patched('no-date-style.xlsx', {
    [STYLES]: (t) => t.replace('<styleSheet xmlns=', '<x:styleSheet xmlns:x=').replace(/<(\/?)(?!\?|x:)(\w+)/g, '<$1x:$2'),
  });
  const r = await checkEdit({ name: 'prefixed-styles.xlsx', bytes, op: set(1, [[2, 1, '2024-03-15']]), touched: PATCHED, out: 'prefixed-styles' });
  assertStylesAppendOnly(partText(r.orig, STYLES), r.styles, [XF14.replace('<xf', '<x:xf')], 3);
  // (ExcelJS cannot read an x:-prefixed styles part at all, edited or not: G6 here is the validators only.)
});

// ---------------------------------------------------------------------------------------------
// Fallbacks

async function assertTextFallback(name, bytes, out, touched = [SHEET1, WB], write = true) {
  const r = await checkEdit({ name, bytes, op: set(1, [[2, 1, '2024-03-15']]), touched, out, write });
  assert.ok(/<c r="B3"[^>]* t="inlineStr"><is><t xml:space="preserve">2024-03-15<\/t><\/is><\/c>/.test(r.sheet), r.sheet);
  assert.deepStrictEqual(r.res.edit.notices, [{ ...DATE_AS_TEXT_NOTICE }]);
  assert.strictEqual(r.res.edit.notices[0].message, 'Stored as text — this workbook has no cell formats to extend');
  return r;
}

test('no-styles.xlsx: falls back to text with the notice', async () => {
  await assertTextFallback('no-styles.xlsx', undefined, 'no-styles');
});

test('prefixed-namespaces.xlsx (no styles part): falls back to text; a paste reports the notice once', async () => {
  const { pkg, wb } = load('prefixed-namespaces.xlsx');
  const res = await run(wb, pkg, set(1, [[5, 0, '2024-03-15'], [5, 1, '2024-03-16'], [5, 2, '7']]));
  assert.ok(res.ok && res.edit);
  assert.strictEqual(res.edit.notices.length, 1);
  const text = pkg.text(SHEET1);
  assert.ok(text.includes('<x:c r="A6" t="inlineStr"><x:is><x:t xml:space="preserve">2024-03-15</x:t></x:is></x:c>'), text);
  writeOut(OUT, 'prefixed-namespaces.xlsx', save(pkg));
});

test('fallbacks: cellXfs missing or empty, count disagrees, names not the root\'s, cap reached', async () => {
  const XFS = /<cellXfs count="3">[\s\S]*<\/cellXfs>/;
  await assertTextFallback('missing.xlsx', await patched('no-date-style.xlsx', { [STYLES]: (t) => t.replace(XFS, '') }), 'no-cellxfs', undefined, false);
  await assertTextFallback('empty.xlsx', await patched('no-date-style.xlsx', { [STYLES]: (t) => t.replace(XFS, '<cellXfs count="0"/>') }), 'empty-cellxfs', undefined, false);
  await assertTextFallback('badcount.xlsx', await patched('no-date-style.xlsx', { [STYLES]: replaceOnce('<cellXfs count="3">', '<cellXfs count="7">') }), 'count-mismatch', undefined, false);
  // The records use a prefix that is bound only on cellXfs: a copy can't be written with the root's bindings.
  await assertTextFallback('scoped.xlsx', await patched('no-date-style.xlsx', {
    [STYLES]: (t) => t.replace(XFS, (m) => m.replace('<cellXfs count="3">', '<cellXfs count="3" xmlns:y="http://schemas.openxmlformats.org/spreadsheetml/2006/main">').replace(/<xf /g, '<y:xf ')),
  }), 'scoped-prefix');
  // Root not in the main namespace (with a main-namespace cellXfs below it).
  await assertTextFallback('foreign.xlsx', await patched('no-date-style.xlsx', {
    [STYLES]: (t) => t.replace('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">', '<styleSheet xmlns="urn:example:not-main">')
      .replace('<cellXfs count="3">', '<cellXfs count="3" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'),
  }), 'foreign-root', undefined, false);
});

function capped(n) {
  return patched('no-date-style.xlsx', {
    [STYLES]: (t) => t.replace(/<cellXfs count="3">([\s\S]*?)<\/cellXfs>/, (m, inner) =>
      `<cellXfs count="${n}">${inner}${'<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0"/>'.repeat(n - 3)}</cellXfs>`),
  });
}

test(`the record cap: ${MAX_CELL_XFS - 1} records -> append the ${MAX_CELL_XFS}th; ${MAX_CELL_XFS} records -> text`, async () => {
  assert.strictEqual(MAX_CELL_XFS, 65_430);   // Open XML SDK schema: cellXfs/xf maxOccurs
  const below = await checkEdit({ name: 'below.xlsx', bytes: await capped(MAX_CELL_XFS - 1), op: set(1, [[2, 1, '2024-03-15']]),
    touched: PATCHED, out: 'cap-below' });
  assert.ok(below.sheet.includes(`<c r="B3" s="${MAX_CELL_XFS - 1}"><v>45366</v></c>`));
  assert.ok(below.styles.includes(`<cellXfs count="${MAX_CELL_XFS}">`));
  // Reuse still works at the cap (no append needed).
  const atCapReuse = await capped(MAX_CELL_XFS);
  const { pkg, wb } = load('cap.xlsx', atCapReuse);
  const r = await run(wb, pkg, set(1, [[2, 1, '2024-03-15']]));
  assert.ok(r.ok && r.edit);
  assert.deepStrictEqual(r.edit.notices, [{ ...DATE_AS_TEXT_NOTICE }]);
  assert.ok(!r.edit.changes.some((c) => c.part === STYLES));
});

// ---------------------------------------------------------------------------------------------
// Date systems and range

test('date1904.xlsx stores the 1904 serial; 1900-02-28 and 1899 dates are text', async () => {
  const r = await checkEdit({ name: 'date1904.xlsx', op: set(1, [[5, 0, '2024-03-15']]), touched: PATCHED, out: 'date1904' });
  assert.ok(r.sheet.includes('<c r="A6" s="4"><v>43904</v></c>'), r.sheet);
  assertStylesAppendOnly(partText(r.orig, STYLES), r.styles, [XF14], 4);
  const v = (await excel(r.after)).worksheets[0].getCell('A6').value;
  assert.ok(v instanceof Date && v.toISOString().startsWith('2024-03-15'), String(v));
  for (const [name, input] of [['date1904.xlsx', '1900-02-28'], ['date1904.xlsx', '1899-12-31'], ['date1904.xlsx', '1903-12-31'],
    ['no-date-style.xlsx', '1900-02-28'], ['no-date-style.xlsx', '1899-12-31'], ['no-date-style.xlsx', '1900-02-29']]) {
    const { pkg, wb } = load(name);
    const res = await run(wb, pkg, set(1, [[6, 0, input]]));
    assert.ok(res.ok && res.edit);
    assert.ok(!res.edit.changes.some((c) => c.part === STYLES), `${name} ${input}: styles untouched`);
    assert.ok(pkg.text(SHEET1).includes(`<c r="A7" t="inlineStr"><is><t xml:space="preserve">${input}</t></is></c>`), `${name} ${input} is text`);
    assert.ok(!res.edit.notices, 'out-of-range dates are plain text, no notice');
  }
  // First accepted dates of each system.
  const a = load('no-date-style.xlsx');
  assert.ok((await run(a.wb, a.pkg, set(1, [[6, 0, '1900-03-01']]))).ok);
  assert.ok(a.pkg.text(SHEET1).includes('<c r="A7" s="3"><v>61</v></c>'));
  const b = load('date1904.xlsx');
  assert.ok((await run(b.wb, b.pkg, set(1, [[6, 0, '1904-01-01']]))).ok);
  assert.ok(b.pkg.text(SHEET1).includes('<c r="A7" s="4"><v>0</v></c>'));
});

// ---------------------------------------------------------------------------------------------
// Paste, clear, undo

test('paste of 50 dates over two base styles appends exactly two records', async () => {
  const cells = [[0, 0, '2024-01-01'], [0, 1, '2024-01-02']];   // A1, B1: s=1 (bold)
  for (let i = 0; i < 48; i++) cells.push([10 + (i % 24), i < 24 ? 0 : 1, `2024-02-${String(1 + (i % 28)).padStart(2, '0')}`]);   // new cells: base 0
  const r = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, cells), touched: PATCHED, out: 'paste-50' });
  assert.strictEqual(r.res.edit.label, 'Paste Cells');
  assertStylesAppendOnly(partText(r.orig, STYLES), r.styles, [
    '<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>',
    XF14,
  ], 3);
  assert.ok(r.sheet.includes('<c r="A1" s="3"><v>45292</v></c>'));
  assert.ok(r.sheet.includes('<c r="A11" s="4"><v>45323</v></c>'));
  const ws = (await excel(r.after)).worksheets[0];
  assert.ok(ws.getCell('B34').value instanceof Date);
  assert.ok(ws.getCell('A1').font?.bold);
  // Dates and date-times over the same base: one record per (base, numFmtId).
  const mixed = await checkEdit({ name: 'no-date-style.xlsx', op: set(1, [[10, 0, '2024-01-01'], [11, 0, '2024-01-01 10:00'], [12, 0, '2024-01-02'], [13, 0, '2024-01-02T11:00']]),
    touched: PATCHED, out: 'paste-mixed' });
  assertStylesAppendOnly(partText(mixed.orig, STYLES), mixed.styles, [XF14, XF14.replace('"14"', '"22"')], 3);
});

test('clearing a patched cell keeps its date s; typing a number then shows a date', async () => {
  const { pkg, wb } = load('no-date-style.xlsx');
  assert.ok((await run(wb, pkg, set(1, [[2, 1, '2024-03-15']]))).ok);
  assert.ok((await run(wb, pkg, { op: 'clearCells', sheetId: 1, range: [2, 1, 2, 1] })).ok);
  assert.ok(pkg.text(SHEET1).includes('<c r="B3" s="3"/>'));
  const n = await run(wb, pkg, set(1, [[2, 1, '45000']]));
  assert.ok(n.ok && !n.edit.changes.some((c) => c.part === STYLES));
  assert.ok(pkg.text(SHEET1).includes('<c r="B3" s="3"><v>45000</v></c>'));
  const bytes = save(pkg);
  assert.ok((await excel(bytes)).worksheets[0].getCell('B3').value instanceof Date);
  writeOut(OUT, 'clear-then-number.xlsx', bytes);
});

test('undo restores styles.xml byte for byte (G5), also after the style table was reloaded', async () => {
  const { pkg, wb, bytes } = load('no-date-style.xlsx');
  const origStyles = pkg.bytes(STYLES);
  const res = await run(wb, pkg, set(1, [[2, 1, '2024-03-15']]));
  assert.ok(res.ok && res.edit);
  applyEdit(pkg, invertEdit(res.edit));
  refreshAfterEdit(wb, res.edit);
  assertBytesEqual(pkg.bytes(STYLES), origStyles, 'styles.xml after undo');
  assertBytesEqual(pkg.serialize(), bytes, 'package after undo');
  // Redo, then a new date reuses the redone record.
  applyEdit(pkg, res.edit);
  refreshAfterEdit(wb, res.edit);
  const again = await run(wb, pkg, set(1, [[3, 2, '2024-03-16']]));
  assert.ok(again.ok && !again.edit.changes.some((c) => c.part === STYLES));
  assert.ok(pkg.text(SHEET1).includes('<c r="C4" s="3"'));
});

test('a refused paste (bad formula after a date) leaves styles.xml and the package unchanged', async () => {
  const { pkg, wb, bytes } = load('no-date-style.xlsx');
  const res = await run(wb, pkg, set(1, [[2, 1, '2024-03-15'], [2, 2, '=SUM(']]));
  assert.strictEqual(res.ok, false);
  assertBytesEqual(pkg.serialize({ force: true }), bytes, 'nothing changed');
  // The next date still appends at the right index.
  const ok = await run(wb, pkg, set(1, [[2, 1, '2024-03-15']]));
  assert.ok(ok.ok);
  assert.ok(pkg.text(SHEET1).includes('<c r="B3" s="3">'));
  save(pkg);
});

// ---------------------------------------------------------------------------------------------
// Randomised: value / date / formula edits with undo/redo; every step passes the validators

const POOL = ['', '1', '-2.5', 'TRUE', 'text', "'2024-01-01", '2024-03-15', '2024-03-15T08:30', '1900-02-28', '1999-12-31 23:59:59',
  '=1+1', '=A2*3', '=SUM(A1:A3)', '=XLOOKUP(1,A:A,B:B)', '=TODAY()', '12%', '#N/A'];

/** Refused inputs mixed into pastes after dates (Gate R2 F1: the date style patch must roll back with the view). */
const BAD = ['=IF(', '=SUM(,)', '=NoSuch!A1', '={1,2;3}'];

async function randomMix(name, seed, steps) {
  const { pkg, wb, bytes } = load(name);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const sheetIds = wb.sheets.filter((s) => s.kind === 'worksheet').map((s) => s.id);
  const done = [];
  const undone = [];
  let applied = 0, undos = 0, styleEdits = 0, refused = 0;
  for (let i = 0; i < steps; i++) {
    const x = rand();
    if (x < 0.15 && done.length) {
      const e = done.pop();
      applyEdit(pkg, invertEdit(e)); refreshAfterEdit(wb, e);
      undone.push(e); undos++;
    } else if (x < 0.22 && undone.length) {
      const e = undone.pop();
      applyEdit(pkg, e); refreshAfterEdit(wb, e);
      done.push(e);
    } else {
      const sheetId = pick(sheetIds);
      let op;
      if (rand() < 0.15) {
        const r0 = Math.floor(rand() * 20), c0 = Math.floor(rand() * 6);
        op = { op: 'clearCells', sheetId, range: [r0, c0, r0 + Math.floor(rand() * 2), c0 + Math.floor(rand() * 2)] };
      } else {
        const cells = new Map();
        for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) cells.set(`${Math.floor(rand() * 25)},${Math.floor(rand() * 7)}`, pick(POOL));
        const list = [...cells].map(([rc, input]) => [...rc.split(',').map(Number), input]);
        if (list.length > 1 && rand() < 0.2) list[list.length - 1][2] = pick(BAD);
        op = set(sheetId, list);
      }
      const res = await run(wb, pkg, op);
      if (!res.ok) refused++;
      if (res.ok && res.edit) {
        done.push(res.edit); undone.length = 0; applied++;
        if (res.edit.changes.some((c) => c.part === STYLES)) styleEdits++;
      }
    }
    save(pkg);   // packageValidator + xlsxValidator at every step
    await assertViewMatchesFile(wb, pkg, core.xlsx.ops.stylesFor(wb), `${name} step ${i}`, [0, 0, 29, 9]);
  }
  const final = save(pkg);
  writeOut(OUT, `random-${name}`, final);
  await excel(final);
  while (done.length) { const e = done.pop(); applyEdit(pkg, invertEdit(e)); refreshAfterEdit(wb, e); }
  assertBytesEqual(pkg.serialize(), bytes, `${name}: full undo`);
  assert.ok(applied >= 40 && undos >= 8 && refused >= 3, `exercised: ${applied} edits, ${undos} undos, ${refused} refusals`);
  return styleEdits;
}

test('seeded random value/date/formula edits with undo/redo pass the validators at every step (no-date-style, basic, formulas)', async () => {
  const a = await randomMix('no-date-style.xlsx', 22, 120);
  const b = await randomMix('basic.xlsx', 5, 120);
  await randomMix('formulas.xlsx', 9, 120);
  assert.ok(a + b >= 3, `the styles patch was exercised (${a + b} edits)`);
});
