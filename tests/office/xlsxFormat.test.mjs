// WP-12: display strings, edit seeds, unit conversions (src/office/core/xlsx/format.ts). Spec §7.2, §9.3.
// Expected strings are what Excel's Range.Text shows for the rows of tests/fixtures/office/basic.xlsx,
// written by hand (expected/basic-display.json was not generated). Excel's own rendering of styles.xlsx
// is expected/styles.pdf.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture } from './_helpers.mjs';

const { displayString, editSeed, unitsToPx, pointsToPx } = core.xlsx.format;
const { StyleTable } = core.xlsx.styles;
const { OfficePackage } = core.pkg;
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const num = (v) => ({ k: 'n', v });

function basic() {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  return StyleTable.load(pkg, 'xl/styles.xml', null);
}

test('basic.xlsx table: display strings match Excel', () => {
  const st = basic();
  const rows = [
    [0, 42, '42'], [0, 3.14159, '3.14159'], [0, -17.5, '-17.5'], [0, 1234567890123, '1.23457E+12'],
    [1, 45366, '2024-03-15'], [2, 45366.572916666664, '15/03/2024 13:45'], [3, 0.75, '6:00 PM'],
    [4, 0.256, '25.60%'], [5, 1234.5, '$1,234.50'], [6, 12.5, '12.50 kg'], [7, 0.000123, '1.23E-04'],
    [8, 0.75, ' 3/4'],
  ];
  for (const [s, v, text] of rows) assert.strictEqual(displayString(num(v), st.formatCode(s), false).text, text, `style ${s} value ${v}`);
  assert.strictEqual(displayString({ k: 's', v: '007' }, st.formatCode(9), false).text, '007');
  assert.strictEqual(displayString({ k: 'b', v: true }, 'General', false).text, 'TRUE');
  assert.strictEqual(displayString({ k: 'b', v: false }, 'General', false).text, 'FALSE');
  assert.strictEqual(displayString({ k: 'e', v: '#DIV/0!' }, 'General', false).text, '#DIV/0!');
  assert.strictEqual(displayString({ k: 'z' }, '0.00', false).text, '');
  assert.strictEqual(displayString({ k: 's', v: 'Hello' }, '0.00', false).text, 'Hello');
});

test('built-in ids 0-49 format like Excel (spot table)', () => {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  pkg.setPart('xl/styles.xml', new TextEncoder().encode(`<styleSheet xmlns="${S}"><cellXfs count="50">${Array.from({ length: 50 }, (_, i) => `<xf numFmtId="${i}"/>`).join('')}</cellXfs></styleSheet>`));
  const st = StyleTable.load(pkg, 'xl/styles.xml', null);
  const show = (id, v) => displayString(num(v), st.formatCode(id), false).text;
  assert.strictEqual(show(1, 1234.5), '1235');
  assert.strictEqual(show(2, 1234.5), '1234.50');
  assert.strictEqual(show(3, 1234.5), '1,235');
  assert.strictEqual(show(4, 1234.5), '1,234.50');
  assert.strictEqual(show(9, 0.256), '26%');
  assert.strictEqual(show(10, 0.256), '25.60%');
  assert.strictEqual(show(14, 45366), '3/15/2024');
  assert.strictEqual(show(15, 45366), '15-Mar-24');
  assert.strictEqual(show(18, 0.75), '6:00 PM');
  assert.strictEqual(show(20, 0.75), '18:00');
  assert.strictEqual(show(21, 0.75), '18:00:00');
  assert.strictEqual(show(11, 12345), '1.23E+04');
  assert.strictEqual(show(12, 0.75), ' 3/4');
  assert.strictEqual(show(49, 5), '5');
});

test('[Red] section yields a colour; unnamed sections do not', () => {
  const st = basic();
  const code = st.formatCode(10);   // [Red]\-0.0;[Blue]0.0
  assert.deepStrictEqual(displayString(num(-3.5), code, false), { text: '3.5', color: '#0000FF' });
  assert.deepStrictEqual(displayString(num(3.5), code, false), { text: '-3.5', color: '#FF0000' });
  assert.deepStrictEqual(displayString(num(3.5), '0.0', false), { text: '3.5' });
  assert.strictEqual(displayString(num(5), '[Green]0', false).color, '#00FF00');
  assert.strictEqual(displayString(num(5), '[Magenta]0', false).color, '#FF00FF');
});

test('invalid format codes never throw', () => {
  assert.doesNotThrow(() => displayString(num(5), '[[bad', false));
  assert.strictEqual(typeof displayString(num(5), '0.0.0.0\\', false).text, 'string');
});

test('1904 dates', () => {
  assert.strictEqual(displayString(num(0), 'yyyy-mm-dd', true).text, '1904-01-01');
  assert.strictEqual(displayString(num(1462), 'yyyy-mm-dd', true).text, '1908-01-02');
  assert.strictEqual(displayString(num(1.5), 'yyyy-mm-dd hh:mm', true).text, '1904-01-02 12:00');
  // non-date formats are unaffected by the date system
  assert.strictEqual(displayString(num(1462), '0', true).text, '1462');
  assert.strictEqual(displayString(num(1462), 'General', true).text, '1462');
  // the fixture's own date cells render as plausible 1904-system dates
  const pkg = OfficePackage.open('date1904.xlsx', fixture('date1904.xlsx'));
  assert.match(pkg.text('xl/workbook.xml'), /date1904="1"/);
  const st = StyleTable.load(pkg, 'xl/styles.xml', null);
  const disp = (s, v) => displayString(num(v), st.formatCode(s), true).text;
  assert.ok(st.isDateStyle(2) && st.isDateStyle(3));
  assert.strictEqual(disp(2, 43904), '2024-03-15');
  assert.strictEqual(disp(2, 35064), '2000-01-01');
  assert.strictEqual(disp(2, 0), '1904-01-01');
  assert.strictEqual(disp(3, 44195.770833333336), '31/12/2024 18:30');
});

test('isDateFormat drives kind d', () => {
  const st = basic();
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => st.isDateStyle(i)),
    [false, true, true, true, false, false, false, false, false, false, false]);
});

function cell(value, over = {}) { return { r: 0, c: 0, value, styleIndex: 0, hasCachedValue: true, rich: false, cm: false, vm: false, ...over }; }

test('editSeed: ISO for dates, full precision for numbers, = + formula', () => {
  const st = basic();
  assert.strictEqual(editSeed(cell(num(45366), { styleIndex: 1 }), st, false), '2024-03-15');
  assert.strictEqual(editSeed(cell(num(45366.572916666664), { styleIndex: 2 }), st, false), '2024-03-15T13:45');
  assert.strictEqual(editSeed(cell(num(45366 + 3661 / 86400), { styleIndex: 2 }), st, false), '2024-03-15T01:01:01');
  assert.strictEqual(editSeed(cell(num(3.14159)), st, false), '3.14159');
  assert.strictEqual(editSeed(cell(num(0.1 + 0.2)), st, false), '0.30000000000000004');
  assert.strictEqual(editSeed(cell(num(1234567890123)), st, false), '1234567890123');
  assert.strictEqual(editSeed(cell(num(0.256), { styleIndex: 4 }), st, false), '0.256');
  assert.strictEqual(editSeed(cell(num(7), { formula: 'SUM(A1:A3)' }), st, false), '=SUM(A1:A3)');
  assert.strictEqual(editSeed(cell({ k: 's', v: 'x' }, { formula: 'A1&"x"' }), st, false), '=A1&"x"');
  assert.strictEqual(editSeed(cell({ k: 'b', v: true }), st, false), 'TRUE');
  assert.strictEqual(editSeed(cell({ k: 'e', v: '#N/A' }), st, false), '#N/A');
  assert.strictEqual(editSeed(cell({ k: 'z' }), st, false), '');
});

test('editSeed: time-only and out-of-range dates fall back to the number; 1904 dates', () => {
  const st = basic();
  assert.strictEqual(editSeed(cell(num(0.75), { styleIndex: 3 }), st, false), '0.75');
  assert.strictEqual(editSeed(cell(num(-5), { styleIndex: 1 }), st, false), '-5');
  assert.strictEqual(editSeed(cell(num(3000000), { styleIndex: 1 }), st, false), '3000000');
  assert.strictEqual(editSeed(cell(num(1462 + 61), { styleIndex: 1 }), st, true), '1908-03-03');
  assert.strictEqual(editSeed(cell(num(0), { styleIndex: 1 }), st, true), '1904-01-01');
  assert.strictEqual(editSeed(cell(num(1)), st, true), '1');
});

test('editSeed: text that would be re-read as something else keeps its meaning', () => {
  const st = basic();
  const s = (v, styleIndex = 0) => editSeed(cell({ k: 's', v }, { styleIndex }), st, false);
  assert.strictEqual(s('hello'), 'hello');
  assert.strictEqual(s('007'), "'007");
  assert.strictEqual(s('007', 9), '007');   // Text-formatted cell: stays as typed
  assert.strictEqual(s('=1+1'), "'=1+1");
  assert.strictEqual(s("'quoted"), "''quoted");
  assert.strictEqual(s('true'), "'true");
  assert.strictEqual(s('2024-03-15'), "'2024-03-15");
});

test('unit conversions', () => {
  assert.strictEqual(unitsToPx(9.140625), 64);
  assert.strictEqual(unitsToPx(14.59765625), 102);
  assert.strictEqual(unitsToPx(0), 0);
  assert.strictEqual(unitsToPx(-1), 0);
  assert.strictEqual(pointsToPx(15), 20);
  assert.strictEqual(pointsToPx(14.25), 19);
  assert.strictEqual(pointsToPx(0), 0);
});
