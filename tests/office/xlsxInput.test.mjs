// WP-20: cell input classification (src/office/core/xlsx/input.ts), spec §9.3 and the §9.3.1 date range.
import { test } from 'node:test';
import assert from 'node:assert';
import { core } from './_helpers.mjs';

const { classifyInput, numberToXml, encodeXstring, isoDateSerial } = core.xlsx.input;
const { decodeXstring } = core.xlsx.sharedStrings;

const G = { isPercentStyle: false, isTextStyle: false, date1904: false };   // General cell, 1900 system
const P = { ...G, isPercentStyle: true };                                    // percent-formatted cell
const T = { ...G, isTextStyle: true };                                       // Text ('@') cell
const D4 = { ...G, date1904: true };                                         // 1904 date system

const clear = { kind: 'clear' };
const text = (t) => ({ kind: 'text', text: t });
const num = (v) => ({ kind: 'number', value: v });
const bool = (v) => ({ kind: 'boolean', value: v });
const date = (serial, withTime = false) => ({ kind: 'date', serial, withTime });
const formula = (t) => ({ kind: 'formula', text: t });

// [input, context, expected, note]
const TABLE = [
  // empty
  ['', G, clear, 'empty clears'],
  ['', T, clear, 'empty clears a Text cell too'],
  // apostrophe prefix
  ["'123", G, text('123'), 'apostrophe keeps a number as text'],
  ["'=A1", G, text('=A1'), 'apostrophe keeps a formula as text'],
  ["'TRUE", G, text('TRUE'), 'apostrophe keeps a boolean as text'],
  ["'2024-01-02", G, text('2024-01-02'), 'apostrophe keeps a date as text'],
  ["'", G, text(''), 'a lone apostrophe is empty text'],
  ["''x", G, text("'x"), 'only the first apostrophe is removed'],
  // formulas
  ['=A1+1', G, formula('A1+1'), 'formula'],
  ['=SUM(A1:A3)', G, formula('SUM(A1:A3)'), 'formula with a function'],
  ['= 1', G, formula(' 1'), 'formula text is kept verbatim after ='],
  ['=', G, text('='), 'a lone = is text'],
  ['==', G, formula('='), '== is a formula (rejected later by the parser)'],
  // numbers
  ['0', G, num(0), 'zero'],
  ['42', G, num(42), 'integer'],
  ['-17.5', G, num(-17.5), 'negative decimal'],
  ['+3', G, num(3), 'leading plus'],
  ['1e5', G, num(100000), 'exponent'],
  ['1E5', G, num(100000), 'upper-case exponent'],
  ['2.5e-3', G, num(0.0025), 'negative exponent'],
  ['-1.5E+2', G, num(-150), 'signed exponent'],
  ['.5', G, num(0.5), 'leading dot'],
  ['5.', G, num(5), 'trailing dot'],
  ['007', G, num(7), 'leading zeros are a number'],
  ['0.1', G, num(0.1), 'decimal'],
  ['123456789012345678', G, num(123456789012345678), 'beyond 15 digits is still a number'],
  ['1e400', G, text('1e400'), 'overflow to Infinity is text'],
  // Gate R2 nit: Excel's range is 2.2250738585072E-308 … 9.99999999999999E+307 (and 0).
  ['1e308', G, text('1e308'), 'finite but above Excel\'s largest number is text'],
  ['-1.7976931348623157e308', G, text('-1.7976931348623157e308'), 'the largest double is text'],
  ['9.99999999999999E+307', G, num(9.99999999999999e307), 'Excel\'s largest number'],
  ['-9.99999999999999E+307', G, num(-9.99999999999999e307), 'Excel\'s most negative number'],
  ['1e-320', G, text('1e-320'), 'a subnormal is text'],
  ['2.2250738585072E-308', G, num(2.2250738585072e-308), 'Excel\'s smallest positive number'],
  ['1e-400', G, text('1e-400'), 'underflow to 0 is text, not 0'],
  ['0e5', G, num(0), 'zero in any notation'],
  ['1e310%', P, text('1e310%'), 'percent overflow is text'],
  ['1e-306%', P, text('1e-306%'), 'percent underflow below Excel\'s range is text'],
  ['-0', G, num(-0), 'negative zero'],
  ['1,000', G, text('1,000'), 'thousands separators are not parsed (no locale guessing)'],
  ['1.000,5', G, text('1.000,5'), 'decimal comma is text'],
  [' 12', G, text(' 12'), 'leading space makes it text'],
  ['12 ', G, text('12 '), 'trailing space makes it text'],
  ['1e', G, text('1e'), 'incomplete exponent'],
  ['.', G, text('.'), 'lone dot'],
  ['+', G, text('+'), 'lone sign'],
  ['$5', G, text('$5'), 'currency symbol is text'],
  ['0x1F', G, text('0x1F'), 'hex is text'],
  ['Infinity', G, text('Infinity'), 'Infinity is text'],
  ['NaN', G, text('NaN'), 'NaN is text'],
  // percent
  ['12%', P, num(0.12), 'percent in a percent cell'],
  ['-5%', P, num(-0.05), 'negative percent'],
  ['.5%', P, num(0.005), 'percent with leading dot'],
  ['1e2%', P, num(1), 'percent with exponent'],
  ['12%', G, text('12%'), 'percent outside a percent cell is text'],
  ['%', P, text('%'), 'lone percent sign'],
  ['12%%', P, text('12%%'), 'double percent'],
  ['12 %', P, text('12 %'), 'space before percent'],
  ['42', P, num(42), 'plain number in a percent cell is not divided'],
  // booleans
  ['TRUE', G, bool(true), 'TRUE'],
  ['FALSE', G, bool(false), 'FALSE'],
  ['true', G, bool(true), 'lower-case true'],
  ['False', G, bool(false), 'mixed-case false'],
  ['TRUE ', G, text('TRUE '), 'trailing space'],
  ['yes', G, text('yes'), 'yes is text'],
  ['1', G, num(1), '1 is a number, not a boolean'],
  // errors and other text
  ['#N/A', G, text('#N/A'), 'error literals are text (§9.3 has no error row)'],
  ['#DIV/0!', G, text('#DIV/0!'), 'error literal'],
  ['hello', G, text('hello'), 'plain text'],
  ['café 日本語 😀', G, text('café 日本語 😀'), 'non-ASCII text'],
  ['line1\nline2', G, text('line1\nline2'), 'multi-line text'],
  // ISO dates (1900 system)
  ['2024-03-15', G, date(45366), 'date'],
  ['2024-03-15T13:45', G, date(45366 + (13 * 60 + 45) / 1440, true), 'date-time with T'],
  ['2024-03-15 13:45:30', G, date(45366 + (13 * 3600 + 45 * 60 + 30) / 86400, true), 'date-time with space and seconds'],
  ['2024-03-15T00:00', G, date(45366, true), 'midnight with a time part'],
  ['1900-03-01', G, date(61), 'first accepted 1900-system date'],
  ['1900-02-28', G, text('1900-02-28'), 'before 1900-03-01 is text'],
  ['1900-02-29', G, text('1900-02-29'), 'the fictitious 1900-02-29 is text'],
  ['1899-12-31', G, text('1899-12-31'), '1899 is text'],
  ['9999-12-31', G, date(2958465), 'last accepted date'],
  ['9999-12-31T23:59:59', G, date(2958465 + 86399 / 86400, true), 'last accepted date-time'],
  ['2023-02-29', G, text('2023-02-29'), 'not a leap year'],
  ['2024-02-29', G, date(45351), 'leap day'],
  ['2024-13-01', G, text('2024-13-01'), 'month 13'],
  ['2024-00-10', G, text('2024-00-10'), 'month 0'],
  ['2024-04-31', G, text('2024-04-31'), 'April 31'],
  ['2024-01-00', G, text('2024-01-00'), 'day 0'],
  ['2024-03-15T24:00', G, text('2024-03-15T24:00'), 'hour 24'],
  ['2024-03-15T12:60', G, text('2024-03-15T12:60'), 'minute 60'],
  ['2024-03-15T12:30:60', G, text('2024-03-15T12:30:60'), 'second 60'],
  ['2024-3-15', G, text('2024-3-15'), 'one-digit month'],
  ['2024-03-15T9:30', G, text('2024-03-15T9:30'), 'one-digit hour'],
  ['2024-03-15T12', G, text('2024-03-15T12'), 'hour without minutes'],
  ['2024-03-15Z', G, text('2024-03-15Z'), 'time zone suffix'],
  ['15/03/2024', G, text('15/03/2024'), 'locale date formats are text'],
  ['2024-03-15', T, text('2024-03-15'), 'date in a Text cell stays text'],
  // 1904 system
  ['2024-03-15', D4, date(45366 - 1462), '1904 serial'],
  ['1904-01-01', D4, date(0), 'first accepted 1904-system date'],
  ['1903-12-31', D4, text('1903-12-31'), 'before 1904-01-01 is text in the 1904 system'],
  ['1900-03-01', D4, text('1900-03-01'), '1900 dates are text in the 1904 system'],
  // Text-formatted cells take everything verbatim
  ['123', T, text('123'), 'number in a Text cell'],
  ['TRUE', T, text('TRUE'), 'boolean in a Text cell'],
  ['=A1', T, text('=A1'), 'formula in a Text cell'],
  ['12%', { ...T, isPercentStyle: true }, text('12%'), 'Text wins over percent'],
  ["'abc", T, text("'abc"), 'apostrophe is kept in a Text cell (editSeed seeds Text cells verbatim)'],
];

test('classifyInput table (§9.3)', () => {
  assert.ok(TABLE.length >= 60, `at least 60 rows (${TABLE.length})`);
  for (const [input, ctx, expected, note] of TABLE) {
    const got = classifyInput(input, ctx);
    if (expected.kind === 'date') {
      assert.strictEqual(got.kind, 'date', `${note}: ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
      assert.ok(Math.abs(got.serial - expected.serial) < 1e-9, `${note}: serial ${got.serial} vs ${expected.serial}`);
      assert.strictEqual(got.withTime, expected.withTime, `${note}: withTime`);
    } else {
      assert.deepStrictEqual(got, expected, `${note}: ${JSON.stringify(input)}`);
    }
  }
});

test('isoDateSerial agrees with Excel serials for known dates', () => {
  // Serials from basic.xlsx (B13 = 2024-03-15) and well-known anchors.
  assert.strictEqual(isoDateSerial('2024-03-15', false).serial, 45366);
  assert.strictEqual(isoDateSerial('2000-01-01', false).serial, 36526);
  assert.strictEqual(isoDateSerial('1900-03-01', false).serial, 61);
  assert.strictEqual(isoDateSerial('2000-01-01', true).serial, 36526 - 1462);
  assert.strictEqual(isoDateSerial('0099-01-01', false), undefined);
});

test('numberToXml: shortest round-trip, Excel exponent form', () => {
  const cases = [[0, '0'], [-0, '0'], [42, '42'], [-17.5, '-17.5'], [0.1, '0.1'], [1 / 3, '0.3333333333333333'],
    [1e21, '1E+21'], [1.5e-7, '1.5E-7'], [123456789012345680, '123456789012345680'], [Number.MAX_VALUE, '1.7976931348623157E+308'],
    [5e-324, '5E-324'], [0.12, '0.12']];
  for (const [n, s] of cases) {
    assert.strictEqual(numberToXml(n), s, String(n));
    assert.strictEqual(Number(s), n === 0 ? 0 : n, `${s} round-trips`);
  }
  assert.throws(() => numberToXml(NaN));
  assert.throws(() => numberToXml(Infinity));
});

test('encodeXstring is the inverse of decodeXstring', () => {
  const samples = ['plain', '_x0041_', 'a_x005F_b', '\u0001bell\u0007', 'tab\tand\nnewline', 'lone \uD800 surrogate',
    'pair 😀', '￾￿', '__x12_', '_x', '_xZZZZ_', 'café'];
  for (const s of samples) {
    const e = encodeXstring(s);
    assert.strictEqual(decodeXstring(e), s, JSON.stringify(s));
    assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(e), `${JSON.stringify(e)} has no illegal controls`);
  }
  assert.strictEqual(encodeXstring('_x0041_'), '_x005F_x0041_');
  assert.strictEqual(encodeXstring('\u0001'), '_x0001_');
  assert.strictEqual(encodeXstring('tab\tok'), 'tab\tok');
});
