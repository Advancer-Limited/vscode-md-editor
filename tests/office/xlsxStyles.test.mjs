// WP-12: xlsx style table (src/office/core/xlsx/styles.ts). Spec §3.5, §7.2, §11.1.
// Expected theme+tint colours were read once from tests/fixtures/office/expected/styles.pdf (Excel's own
// rendering: fill/stroke colour operators in the page content stream, 3 decimals): 0.267 0.702 0.882,
// 0.745 0.314 0.0784 and 0.0706 0.314 0.102.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture } from './_helpers.mjs';

const { StyleTable } = core.xlsx.styles;
const { OfficePackage } = core.pkg;
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const enc = (s) => new TextEncoder().encode(s);

function table(name, styles = 'xl/styles.xml', theme = 'xl/theme/theme1.xml') {
  const pkg = OfficePackage.open(name, fixture(name));
  return { pkg, st: StyleTable.load(pkg, pkg.has(styles) ? styles : null, theme && pkg.has(theme) ? theme : null) };
}
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Tolerance 3/255: Excel's own HLS rounding differs slightly from a float HLS tint (max observed delta 3).
function assertClose(actual, expected255, msg) {
  hexToRgb(actual).forEach((v, i) => assert.ok(Math.abs(v - expected255[i]) <= 3, `${msg}: ${actual} vs ${expected255}`));
}
const fromPdf = (r, g, b) => [r, g, b].map((x) => Math.round(x * 255));

test('theme colour + tint matches the values Excel shows for styles.xlsx', () => {
  const { st } = table('styles.xlsx');
  assert.strictEqual(st.xfCount, 27);
  assert.strictEqual(st.dto(8).fill, '#FFFF00');
  assertClose(st.dto(9).fill, fromPdf(0.267, 0.702, 0.882), 'accent1 tint +0.4');
  assertClose(st.dto(10).fill, fromPdf(0.745, 0.314, 0.0784), 'accent2 tint -0.25');
  assertClose(st.dto(11).color, fromPdf(0.0706, 0.314, 0.102), 'accent3 font tint -0.25');
  assert.strictEqual(st.dto(26).fill, '#DDEBF7');
  assert.strictEqual(st.dto(7).color, '#FF0000');
});

test('theme index order swaps dk/lt and tint extremes', () => {
  const { st } = table('styles.xlsx');
  assert.strictEqual(st.dto(0).color, '#000000');   // font 0 is theme="1" = dk1
  assert.strictEqual(core.xlsx.styles.applyTint('156082', 0), '#156082');
  assert.strictEqual(core.xlsx.styles.applyTint('808080', 1), '#FFFFFF');
  assert.strictEqual(core.xlsx.styles.applyTint('808080', -1), '#000000');
});

test('font, alignment and default-style flags', () => {
  const { st } = table('styles.xlsx');
  assert.strictEqual(st.dto(1).bold, true);
  assert.strictEqual(st.dto(2).fontSizePt, 14);
  assert.strictEqual(st.dto(2).fontFamily, 'Aptos Narrow');
  assert.ok(st.dto(3).italic && st.dto(4).underline && st.dto(5).strike);
  assert.strictEqual(st.dto(6).fontFamily, 'Courier New');
  assert.strictEqual(st.dto(16).h, 'left');
  assert.strictEqual(st.dto(17).h, 'center');
  assert.strictEqual(st.dto(18).h, 'right');
  assert.strictEqual(st.dto(19).h, 'left');
  assert.strictEqual(st.dto(19).indent, 2);
  assert.strictEqual(st.dto(20).wrap, true);
  assert.strictEqual(st.dto(22).v, 'top');
  assert.strictEqual(st.dto(25).v, 'middle');
  assert.strictEqual(st.dto(0).bold, undefined);
});

test('border styles map to CSS', () => {
  const { st } = table('styles.xlsx');
  assert.deepStrictEqual(st.dto(12).border, { t: '1px solid #000000', r: '1px solid #000000', b: '1px solid #000000', l: '1px solid #000000' });
  assert.deepStrictEqual(st.dto(13).border, { b: '3px solid #000000', l: '1px solid #000000' });
  assert.deepStrictEqual(st.dto(14).border, { t: '1px dashed #000000', b: '1px dashed #000000', l: '1px dashed #000000' });
  assert.deepStrictEqual(st.dto(15).border, { t: '3px double #0000FF', l: '1px dashed #000000' });
  assert.strictEqual(st.dto(0).border, undefined);
});

test('indexed palette, system colours and a custom indexedColors override', () => {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  const xml = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${S}">
    <colors><indexedColors>${'<rgbColor rgb="FF010203"/>'.repeat(3)}</indexedColors></colors>
    <fonts count="3"><font><color indexed="2"/></font><font><color indexed="10"/></font><font><color indexed="64"/></font></fonts>
    <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor indexed="13"/></patternFill></fill></fills>
    <borders count="1"><border><left style="hair"><color indexed="12"/></left></border></borders>
    <cellXfs count="4"><xf fontId="0" fillId="1" borderId="0"/><xf fontId="1" fillId="0" borderId="0"/><xf fontId="2" fillId="0" borderId="0"/><xf fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`;
  pkg.setPart('xl/styles.xml', enc(xml));
  const st = StyleTable.load(pkg, 'xl/styles.xml', null);
  assert.strictEqual(st.dto(0).color, '#010203', 'custom palette entry 2');
  assert.strictEqual(st.dto(0).fill, '#FFFF00', 'default palette 13 (beyond the 3 overridden entries)');
  assert.strictEqual(st.dto(1).color, '#FF0000', 'default palette 10');
  assert.strictEqual(st.dto(2).color, undefined, 'indexed 64 is automatic');
  assert.strictEqual(st.dto(2).autoColor, true);
});

test('automatic colour: an explicit colour has no autoColor, no styles part does', () => {
  const { st } = table('styles.xlsx');
  assert.strictEqual(st.dto(1).autoColor, undefined);
  assert.strictEqual(table('no-styles.xlsx').st.dto(0).autoColor, true);
});

test('number formats: built-in ids and custom codes; kind predicates', () => {
  const { st } = table('basic.xlsx');
  assert.strictEqual(st.formatCode(0), 'General');
  assert.strictEqual(st.formatCode(1), 'yyyy\\-mm\\-dd');
  assert.strictEqual(st.formatCode(3), 'h:mm AM/PM');   // built-in 18
  assert.strictEqual(st.formatCode(4), '0.00%');        // built-in 10
  assert.strictEqual(st.formatCode(7), '0.00E+00');     // built-in 11
  assert.strictEqual(st.formatCode(9), '@');            // built-in 49
  assert.strictEqual(st.numFmtId(2), 165);
  assert.ok(st.isDateStyle(1) && st.isDateStyle(2) && st.isDateStyle(3));
  assert.ok(!st.isDateStyle(0) && !st.isDateStyle(4) && !st.isDateStyle(5));
  assert.ok(st.isPercentStyle(4) && !st.isPercentStyle(1));
  assert.ok(st.isTextStyle(9) && !st.isTextStyle(0));
});

test('every built-in id 0-49 resolves to a format code', () => {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  const xfs = Array.from({ length: 50 }, (_, i) => `<xf numFmtId="${i}"/>`).join('');
  pkg.setPart('xl/styles.xml', enc(`<styleSheet xmlns="${S}"><cellXfs count="50">${xfs}</cellXfs></styleSheet>`));
  const st = StyleTable.load(pkg, 'xl/styles.xml', null);
  for (let i = 0; i < 50; i++) assert.ok(st.formatCode(i).length > 0, `id ${i}`);
  assert.strictEqual(st.formatCode(14), 'm/d/yyyy');
  assert.ok(st.formatCode(22).startsWith('m/d/yyyy h:mm'), st.formatCode(22));
  assert.strictEqual(st.formatCode(2), '0.00');
  assert.strictEqual(st.formatCode(9), '0%');
  assert.ok(st.isDateStyle(14) && st.isDateStyle(22) && st.isPercentStyle(9) && st.isTextStyle(49));
});

test('out-of-range style index behaves as the default style', () => {
  const { st } = table('styles.xlsx');
  for (const i of [-1, 27, 1e9, 1.5, NaN]) {
    assert.strictEqual(st.numFmtId(i), 0);
    assert.strictEqual(st.formatCode(i), 'General');
    assert.strictEqual(st.isDateStyle(i), false);
    assert.strictEqual(st.dto(i).autoColor, true);
  }
});

test('no styles part: empty table, General everywhere', () => {
  const { st } = table('no-styles.xlsx');
  assert.strictEqual(st.xfCount, 0);
  assert.strictEqual(st.formatCode(0), 'General');
  assert.deepStrictEqual(st.dto(0), { autoColor: true });
});

test('fixtures without a date style load, with and without a theme', () => {
  const { st } = table('no-date-style.xlsx', 'xl/styles.xml', null);
  assert.ok(st.xfCount > 0);
  const { st: nc } = table('no-date-style-nocount.xlsx', 'xl/styles.xml', null);
  assert.strictEqual(nc.xfCount, st.xfCount);
  for (let i = 0; i < st.xfCount; i++) assert.strictEqual(nc.isDateStyle(i), false);
});

test('prefixed namespaces: x: styles and a:-prefixed theme are matched by namespace URI', () => {
  const pkg = OfficePackage.open('prefixed-namespaces.xlsx', fixture('prefixed-namespaces.xlsx'));
  pkg.setPart('xl/styles.xml', enc(`<?xml version="1.0"?><x:styleSheet xmlns:x="${S}">
    <x:numFmts count="1"><x:numFmt numFmtId="164" formatCode="0.0&quot; u&quot;"/></x:numFmts>
    <x:fonts count="1"><x:font><x:b/><x:sz val="9"/><x:color theme="4" tint="0.5"/><x:name val="Arial"/></x:font></x:fonts>
    <x:fills count="1"><x:fill><x:patternFill patternType="solid"><x:fgColor theme="5"/></x:patternFill></x:fill></x:fills>
    <x:borders count="1"><x:border><x:top style="medium"><x:color rgb="FF112233"/></x:top></x:border></x:borders>
    <x:cellXfs count="1"><x:xf numFmtId="164" fontId="0" fillId="0" borderId="0"><x:alignment horizontal="right" wrapText="1"/></x:xf></x:cellXfs>
  </x:styleSheet>`));
  pkg.setPart('xl/theme/theme1.xml', enc(`<a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme name="t">
    <a:accent1><a:srgbClr val="FF0000"/></a:accent1><a:accent2><a:srgbClr val="00FF00"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`));
  const st = StyleTable.load(pkg, 'xl/styles.xml', 'xl/theme/theme1.xml');
  assert.strictEqual(st.formatCode(0), '0.0" u"');
  const d = st.dto(0);
  assert.strictEqual(d.bold, true);
  assert.strictEqual(d.fontSizePt, 9);
  assert.strictEqual(d.fontFamily, 'Arial');
  assert.strictEqual(d.color, '#FF8080');   // red, tint 0.5
  assert.strictEqual(d.fill, '#00FF00');
  assert.strictEqual(d.h, 'right');
  assert.strictEqual(d.wrap, true);
  assert.deepStrictEqual(d.border, { t: '2px solid #112233' });
});

test('reload picks up a changed styles part', () => {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  const st = StyleTable.load(pkg, 'xl/styles.xml', null);
  const n = st.xfCount;
  pkg.setPart('xl/styles.xml', enc(`<styleSheet xmlns="${S}"><cellXfs count="1"><xf numFmtId="14"/></cellXfs></styleSheet>`));
  st.reload();
  assert.strictEqual(st.xfCount, 1);
  assert.ok(n > 1);
  assert.ok(st.isDateStyle(0));
});
