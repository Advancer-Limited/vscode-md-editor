// Tests for media/pdfViewMath.js (pure UMD script). Self-contained: loaded via createRequire
// as the webview script is; does not use tests/pdf/_helpers.mjs (PWP-02 creates it later).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const M = require('../../media/pdfViewMath.js');
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);
const r = (l, t, rt, b) => ({ left: l, top: t, right: rt, bottom: b });

test('loads as a plain webview script and exposes the global', () => {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(new URL('../../media/pdfViewMath.js', import.meta.url), 'utf8'), ctx);
  assert.strictEqual(typeof ctx.PdfViewMath.zoomIn, 'function');
});

test('zoom steps: in/out walk the table and clamp', () => {
  assert.strictEqual(M.zoomIn(1), 1.25);
  assert.strictEqual(M.zoomOut(1), 0.75);
  assert.strictEqual(M.zoomIn(1.1), 1.25);
  assert.strictEqual(M.zoomOut(1.1), 1);
  assert.strictEqual(M.zoomIn(5), 5);
  assert.strictEqual(M.zoomOut(0.25), 0.25);
  assert.strictEqual(M.zoomIn(0.01), 0.33);
  assert.strictEqual(M.zoomOut(99), 4);
  assert.strictEqual(M.zoomIn(NaN), 1.25);
  let z = 1;
  for (let i = 0; i < 20; i++) { const n = M.zoomIn(z); assert.ok(n >= z); z = n; }
  assert.strictEqual(z, 5);
  for (let i = 0; i < 20; i++) z = M.zoomOut(z);
  assert.strictEqual(z, 0.25);
});

test('zoomBy / clampZoom / zoomPercent', () => {
  assert.strictEqual(M.zoomBy(1, 2), 2);
  assert.strictEqual(M.zoomBy(4, 10), 5);
  assert.strictEqual(M.zoomBy(0.3, 0.1), 0.25);
  assert.strictEqual(M.zoomBy(2, -1), 2);
  assert.strictEqual(M.zoomBy(2, Infinity), 2);
  assert.strictEqual(M.clampZoom('x'), 1);
  assert.strictEqual(M.zoomPercent(1.256), 126);
  assert.strictEqual(M.zoomPercent(0), 25);
});

test('rotation helpers', () => {
  assert.strictEqual(M.normalizeRotation(-90), 270);
  assert.strictEqual(M.normalizeRotation(450), 90);
  assert.strictEqual(M.normalizeRotation(45), 0);
  assert.strictEqual(M.normalizeRotation(undefined), 0);
  assert.strictEqual(M.rotateView(270, 1), 0);
  assert.strictEqual(M.rotateView(0, -1), 270);
  assert.deepStrictEqual(M.rotatedSize(600, 800, 90), { width: 800, height: 600 });
  assert.deepStrictEqual(M.rotatedSize(600, 800, 180), { width: 600, height: 800 });
});

test('fitScale: width, page, auto, actual, rotation, degenerate input', () => {
  const view = { width: 1000, height: 800 };
  near(M.fitScale('page-width', 500, 700, 0, view, 0), 2);
  near(M.fitScale('page-width', 500, 700, 0, view, 20), 1.96);
  near(M.fitScale('page-fit', 500, 700, 0, view, 0), 800 / 700);
  near(M.fitScale('page-fit', 500, 700, 90, view, 0), 1000 / 700); // rotated: 700 wide, 500 tall
  assert.strictEqual(M.fitScale('auto', 500, 700, 0, view, 0), 1.25);
  near(M.fitScale('auto', 2000, 700, 0, view, 0), 0.5);
  assert.strictEqual(M.fitScale('actual', 500, 700, 0, view, 0), 1);
  assert.strictEqual(M.fitScale(2, 500, 700, 0, view, 0), 2);
  assert.strictEqual(M.fitScale(99, 500, 700, 0, view, 0), 5);
  assert.strictEqual(M.fitScale('page-width', 0, 700, 0, view, 0), 1);
  assert.strictEqual(M.fitScale('page-width', 500, 700, 0, null, 0), 1);
  assert.strictEqual(M.fitScale('page-width', 100, 700, 0, { width: 1, height: 1 }, 50), 0.25);
  assert.strictEqual(M.fitScale('bogus', 500, 700, 0, view, 0), 1);
});

test('parsePageBox: numbers, labels, bounds, junk', () => {
  assert.strictEqual(M.parsePageBox('12', 340), 11);
  assert.strictEqual(M.parsePageBox(' 1 ', 340), 0);
  assert.strictEqual(M.parsePageBox('340', 340), 339);
  assert.strictEqual(M.parsePageBox('341', 340), -1);
  assert.strictEqual(M.parsePageBox('0', 340), -1);
  assert.strictEqual(M.parsePageBox('-3', 340), -1);
  assert.strictEqual(M.parsePageBox('', 340), -1);
  assert.strictEqual(M.parsePageBox('abc', 340), -1);
  assert.strictEqual(M.parsePageBox('1e2', 340), -1);
  assert.strictEqual(M.parsePageBox('5', 0), -1);
  const labels = ['i', 'ii', 'iii', '1', '2', 'A-1'];
  assert.strictEqual(M.parsePageBox('iii', 6, labels), 2);
  assert.strictEqual(M.parsePageBox('III', 6, labels), 2);
  assert.strictEqual(M.parsePageBox('a-1', 6, labels), 5);
  assert.strictEqual(M.parsePageBox('1', 6, labels), 3, 'exact label beats physical number');
  assert.strictEqual(M.parsePageBox('6', 6, labels), 5, 'falls back to the physical number');
  assert.strictEqual(M.parsePageBox('7', 6, labels), -1);
  assert.strictEqual(M.parsePageBox('zz', 6, labels), -1);
});

test('pageStatus / clampPage', () => {
  assert.strictEqual(M.pageStatus(11, 340), '12 of 340');
  assert.strictEqual(M.pageStatus(2, 6, ['i', 'ii', 'iii', '1', '2', '3']), 'iii (3 of 6)');
  assert.strictEqual(M.pageStatus(3, 6, ['i', 'ii', 'iii', '4', '5', '6']), '4 of 6');
  assert.strictEqual(M.clampPage(-4, 10), 0);
  assert.strictEqual(M.clampPage(99, 10), 9);
  assert.strictEqual(M.clampPage(2.9, 10), 2);
  assert.strictEqual(M.clampPage(NaN, 10), 0);
  assert.strictEqual(M.clampPage(3, 0), 0);
});

test('thumbnailWindow: buffer, edges, cap keeps the visible range', () => {
  assert.deepStrictEqual(M.thumbnailWindow(10, 14, 100, 3), { start: 7, end: 17 });
  assert.deepStrictEqual(M.thumbnailWindow(0, 2, 100, 5), { start: 0, end: 7 });
  assert.deepStrictEqual(M.thumbnailWindow(97, 99, 100, 5), { start: 92, end: 99 });
  assert.deepStrictEqual(M.thumbnailWindow(14, 10, 100, 3), { start: 7, end: 17 });
  assert.strictEqual(M.thumbnailWindow(0, 0, 0), null);
  const w = M.thumbnailWindow(500, 520, 2000, 500);
  assert.strictEqual(w.end - w.start + 1, 200);
  assert.ok(w.start <= 500 && w.end >= 520);
  const big = M.thumbnailWindow(0, 400, 1000, 5);
  assert.strictEqual(big.end - big.start + 1, 200);
  assert.strictEqual(big.start, 0);
  assert.deepStrictEqual(M.thumbnailWindow(1, 2, 3, 5), { start: 0, end: 2 });
});

test('coordinates: known corners for each rotation (612x792 page, scale 2)', () => {
  const box = { x0: 0, y0: 0, x1: 612, y1: 792 };
  const g = (rotation) => ({ box, scale: 2, rotation });
  assert.deepStrictEqual(M.pageToView(g(0), 0, 0), { x: 0, y: 1584 });
  assert.deepStrictEqual(M.pageToView(g(90), 0, 0), { x: 0, y: 0 });
  assert.deepStrictEqual(M.pageToView(g(180), 0, 0), { x: 1224, y: 0 });
  assert.deepStrictEqual(M.pageToView(g(270), 0, 0), { x: 1584, y: 1224 });
  assert.deepStrictEqual(M.pageToView(g(0), 612, 792), { x: 1224, y: 0 });
  assert.deepStrictEqual(M.pageToView(g(90), 612, 792), { x: 1584, y: 1224 });
});

test('coordinates: round trip for all rotations, offset boxes and scales', () => {
  const boxes = [{ x0: 0, y0: 0, x1: 612, y1: 792 }, { x0: 36, y0: -20, x1: 400.5, y1: 700 }];
  for (const box of boxes) for (const rotation of [0, 90, 180, 270, -90, 450]) for (const scale of [0.25, 1, 1.33, 5]) {
    const g = { box, scale, rotation };
    for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y1], [100, 200], [box.x0 + 3, box.y1 - 7]]) {
      const v = M.pageToView(g, x, y);
      const p = M.viewToPage(g, v.x, v.y);
      near(p.x, x, 1e-7); near(p.y, y, 1e-7);
    }
  }
});

test('coordinates: view rect maps onto the page box and is normalised', () => {
  const g = { box: { x0: 0, y0: 0, x1: 100, y1: 200 }, scale: 1, rotation: 90 };
  const full = M.viewRectToPage(g, 0, 0, 200, 100); // rotated page is 200 wide, 100 tall
  assert.deepStrictEqual(full, { x0: 0, y0: 0, x1: 100, y1: 200 });
  assert.deepStrictEqual(M.viewRectToPage(g, 200, 100, 0, 0), full);
});

test('rectToQuad order is TL, TR, BL, BR', () => {
  assert.deepStrictEqual(M.rectToQuad({ x0: 1, y0: 2, x1: 5, y1: 8 }), [1, 8, 5, 8, 1, 2, 5, 2]);
});

test('mergeRects: one rect per line, small gaps merged, big gaps kept', () => {
  const out = M.mergeRects([
    r(50, 100, 80, 112), r(80, 100.5, 120, 112.5), r(120.5, 99, 150, 112), // line 1: three pieces
    r(10, 130, 60, 142), // line 2
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { left: 50, top: 99, right: 150, bottom: 112.5 });
  assert.deepStrictEqual(out[1], { left: 10, top: 130, right: 60, bottom: 142 });
  assert.strictEqual(M.mergeRects([r(0, 0, 40, 10), r(200, 0, 240, 10)]).length, 2);
  assert.strictEqual(M.mergeRects([r(0, 0, 40, 10), r(200, 0, 240, 10)], 500).length, 1);
});

test('mergeRects: unordered input, contained rects, junk dropped', () => {
  const out = M.mergeRects([
    r(60, 20, 100, 32), r(0, 0, 50, 12), r(10, 2, 20, 10),
    r(0, 0, 0, 5), r(NaN, 0, 5, 5), null, r(5, 5, 5, 5),
  ]);
  assert.deepStrictEqual(out, [{ left: 0, top: 0, right: 50, bottom: 12 }, { left: 60, top: 20, right: 100, bottom: 32 }]);
  assert.deepStrictEqual(M.mergeRects([]), []);
  assert.deepStrictEqual(M.mergeRects(null), []);
  assert.deepStrictEqual(M.mergeRects([r(10, 12, 0, 0)]), [{ left: 0, top: 0, right: 10, bottom: 12 }]);
  assert.strictEqual(M.mergeRects([r(0, 0, 50, 10), r(0, 10, 50, 20)]).length, 2);
});

test('clientRectsToQuads: client rects -> user-space quads, rotation aware', () => {
  const g0 = { box: { x0: 0, y0: 0, x1: 200, y1: 100 }, scale: 1, rotation: 0 };
  const q = M.clientRectsToQuads([r(40, 45, 90, 57)], g0, { x: 30, y: 40 });
  assert.deepStrictEqual(q, [10, 95, 60, 95, 10, 83, 60, 83]);
  const g90 = { box: g0.box, scale: 1, rotation: 90 };
  const v = M.pageToView(g90, 10, 83), w = M.pageToView(g90, 60, 95);
  const q90 = M.clientRectsToQuads(
    [r(Math.min(v.x, w.x), Math.min(v.y, w.y), Math.max(v.x, w.x), Math.max(v.y, w.y))], g90, { x: 0, y: 0 });
  q90.forEach((n, i) => near(n, q[i], 1e-9));
  assert.deepStrictEqual(M.clientRectsToQuads([], g0, null), []);
});
