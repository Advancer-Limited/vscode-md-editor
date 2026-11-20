// Synthetic fixtures from make-synthetic.mjs: hidden/veryHidden sheets, a chartsheet, a damaged sheet part.
// Spec §7.2 (hidden sheets, chartsheets), §10.3 (damaged sheet -> sheet-unavailable).
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { Workbook, SheetLoadError } = core.xlsx.workbook;
const open = (name) => Workbook.load(OfficePackage.open(name, fixture(name)));

test('hidden-sheets.xlsx lists hidden and veryHidden states; both load as worksheets', async () => {
  const wb = open('hidden-sheets.xlsx');
  assert.deepStrictEqual(wb.sheets.map((e) => [e.name, e.kind, e.state]), [
    ['Values', 'worksheet', 'visible'],
    ['Second Sheet', 'worksheet', 'visible'],
    ['Hidden Sheet', 'worksheet', 'hidden'],
    ['Very Hidden Sheet', 'worksheet', 'veryHidden'],
  ]);
  for (const e of wb.sheets.slice(2)) await wb.sheet(e.id);
});

test('chartsheet.xlsx lists the chartsheet with kind chartsheet and never parses its part', async () => {
  const wb = open('chartsheet.xlsx');
  const e = wb.sheets.find((s) => s.name === 'Chart Sheet');
  assert.ok(e, 'chartsheet entry present');
  assert.strictEqual(e.kind, 'chartsheet');
  assert.strictEqual(e.part, 'xl/chartsheets/sheet1.xml');
  assert.deepStrictEqual(wb.sheets.filter((s) => s.kind === 'worksheet').length, 3);
  await assert.rejects(wb.sheet(e.id), (err) => err instanceof SheetLoadError && err.failure === 'not-worksheet');
  await wb.sheet(1);   // worksheets still load
});

test('damaged-sheet.xlsx opens; the damaged sheet throws SheetLoadError, the other loads', async () => {
  const wb = open('damaged-sheet.xlsx');
  assert.deepStrictEqual(wb.sheets.map((e) => e.name), ['Values', 'Second Sheet', 'Damaged Sheet']);
  await assert.rejects(wb.sheet(3), (err) => err instanceof SheetLoadError && err.failure === 'damaged');
  await wb.sheet(1);
  await wb.sheet(2);
});
