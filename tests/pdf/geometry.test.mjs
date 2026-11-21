// PWP-15: core/geometry.ts — page geometry, quads, ink bounds, page-box checks. Cross-checked
// against media/pdfViewMath.js (the webview counterpart): same conventions, same numbers.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { core } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const M = require('../../media/pdfViewMath.js');
const G = core.geometry;
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);
const nearPt = (p, q, e) => { near(p.x, q.x, e); near(p.y, q.y, e); };

const ROTATIONS = [0, 90, 180, 270, -90, 360, 450, -540];
const BOXES = [
  { x0: 0, y0: 0, x1: 612, y1: 792 },          // Letter
  { x0: 50, y0: 100, x1: 662, y1: 892 },       // offset media/crop box
  { x0: 300, y0: 400, x1: -20, y1: -30 },      // reversed corners, negative origin
  { x0: 0.5, y0: 0.25, x1: 200.75, y1: 50.5 }, // fractional, landscape
];
const SCALES = [0.25, 1, 1.5, 3.7];

test('normalizeRotation and rotatedSize agree with pdfViewMath', () => {
  for (const r of [...ROTATIONS, 45, NaN, Infinity, '90', null, 89.9, -0]) {
    assert.strictEqual(G.normalizeRotation(r), M.normalizeRotation(r), `rotation ${r}`);
  }
  for (const r of ROTATIONS) {
    const b = BOXES[1];
    const m = M.rotatedSize(M.boxSize(b).width, M.boxSize(b).height, r);
    assert.deepStrictEqual(G.rotatedSize(b, r), m);
  }
});

test('pageToView / viewToPage match pdfViewMath for every rotation, box and scale', () => {
  const pts = [[0, 0], [612, 792], [100.5, 33.25], [-20, 900], [301, 401]];
  for (const box of BOXES) for (const rotation of ROTATIONS) for (const scale of SCALES) {
    const g = { box, scale, rotation };
    for (const [x, y] of pts) {
      const v = G.pageToView(g, x, y);
      assert.deepStrictEqual(v, M.pageToView(g, x, y));
      const back = G.viewToPage(g, v.x, v.y);
      assert.deepStrictEqual(back, M.viewToPage(g, v.x, v.y));
      nearPt(back, { x, y }, 1e-9);
    }
  }
});

test('page corners land on the rotated page corners', () => {
  for (const box of BOXES) for (const rotation of [0, 90, 180, 270]) {
    const g = { box, scale: 2, rotation };
    const n = G.normBox(box);
    const sz = G.rotatedSize(box, rotation);
    const corners = [[n.x0, n.y0], [n.x1, n.y0], [n.x0, n.y1], [n.x1, n.y1]].map(([x, y]) => G.pageToView(g, x, y));
    const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
    near(Math.min(...xs), 0, 1e-9); near(Math.min(...ys), 0, 1e-9);
    near(Math.max(...xs), sz.width * 2, 1e-9); near(Math.max(...ys), sz.height * 2, 1e-9);
  }
  // Rotation 90: the page's top-left (x0, y1) is drawn at the view's top-right.
  const g = { box: BOXES[0], scale: 1, rotation: 90 };
  nearPt(G.pageToView(g, 0, 792), { x: 792, y: 0 }, 1e-9);
});

test('viewRectToPage matches pdfViewMath; pageRectToView round-trips it', () => {
  for (const box of BOXES) for (const rotation of ROTATIONS) for (const scale of SCALES) {
    const g = { box, scale, rotation };
    const rects = [[10, 20, 110, 35], [110, 35, 10, 20], [0, 0, 1, 1]];
    for (const [l, t, r, b] of rects) {
      const pr = G.viewRectToPage(g, l, t, r, b);
      assert.deepStrictEqual(pr, M.viewRectToPage(g, l, t, r, b));
      const vr = G.pageRectToView(g, pr);
      near(vr.left, Math.min(l, r), 1e-9); near(vr.right, Math.max(l, r), 1e-9);
      near(vr.top, Math.min(t, b), 1e-9); near(vr.bottom, Math.max(t, b), 1e-9);
    }
  }
});

test('quads from the webview pipeline are already canonical for the host', () => {
  const rects = [{ left: 100, top: 200, right: 180, bottom: 212 }, { left: 182, top: 200, right: 260, bottom: 212 },
    { left: 100, top: 220, right: 150, bottom: 232 }];
  for (const box of BOXES) for (const rotation of [0, 90, 180, 270]) {
    const g = { box, scale: 1.25, rotation };
    const quads = M.clientRectsToQuads(rects, g, { x: 40, y: 60 });
    assert.strictEqual(quads.length, 16);
    assert.deepStrictEqual(G.normalizeQuads(quads), quads);
    // rectToQuad is the same function on both sides.
    const r = G.quadBounds(quads, 0);
    assert.deepStrictEqual(G.rectToQuad(r), M.rectToQuad(r));
  }
});

test('normalizeQuads reorders corners, refuses degenerate and malformed input', () => {
  const canon = [10, 30, 50, 30, 10, 20, 50, 20];                 // TL TR BL BR
  const shuffled = [50, 20, 10, 20, 50, 30, 10, 30];              // BR BL TR TL
  assert.deepStrictEqual(G.normalizeQuads(shuffled), canon);
  assert.deepStrictEqual(G.normalizeQuads([...canon, ...shuffled]), [...canon, ...canon]);
  // A slightly skewed quad becomes its bounding box.
  assert.deepStrictEqual(G.normalizeQuads([10, 31, 50, 30, 11, 20, 50, 20]), [10, 31, 50, 31, 10, 20, 50, 20]);
  assert.strictEqual(G.normalizeQuads([]), null);
  assert.strictEqual(G.normalizeQuads([1, 2, 3]), null);
  assert.strictEqual(G.normalizeQuads([10, 30, 50, 30, 10, 30, 50, 30]), null, 'zero height');
  assert.strictEqual(G.normalizeQuads([10, 30, 10, 30, 10, 20, 10, 20]), null, 'zero width');
  assert.strictEqual(G.normalizeQuads([NaN, 30, 50, 30, 10, 20, 50, 20]), null);
  assert.strictEqual(G.normalizeQuads([Infinity, 30, 50, 30, 10, 20, 50, 20]), null);
});

test('quadsBounds and quadsToOutlines', () => {
  const q = [10, 30, 50, 30, 10, 20, 50, 20, 5, 15, 40, 15, 5, 5, 40, 5];
  assert.deepStrictEqual(G.quadsBounds(q), { x0: 5, y0: 5, x1: 50, y1: 30 });
  assert.strictEqual(G.quadsBounds([]), null);
  assert.strictEqual(G.quadsBounds([1, 2, 3, 4, 5, 6, 7]), null);
  assert.strictEqual(G.quadsBounds([1, 2, 3, 4, 5, 6, 7, NaN]), null);
  // Perimeter order TL, TR, BR, BL: consecutive points share an x or a y (no crossing edge).
  const outlines = G.quadsToOutlines(q);
  assert.deepStrictEqual(outlines, [[10, 30, 50, 30, 50, 20, 10, 20], [5, 15, 40, 15, 40, 5, 5, 5]]);
  for (const o of outlines) {
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) % 8;
      assert.ok(o[i] === o[j] || o[i + 1] === o[j + 1], 'edge is axis-aligned');
    }
  }
});

test('inkBounds grows the stroke box by half the width', () => {
  assert.deepStrictEqual(G.inkBounds([[10, 10, 20, 30], [5, 15, 6, 16]], 4), { x0: 3, y0: 8, x1: 22, y1: 32 });
  assert.deepStrictEqual(G.inkBounds([[1, 1, 1, 1]], 2), { x0: 0, y0: 0, x1: 2, y1: 2 });
  assert.strictEqual(G.inkBounds([], 1), null);
  assert.strictEqual(G.inkBounds([[]], 1), null);
  assert.strictEqual(G.inkBounds([[1, 2, 3]], 1), null);
  assert.strictEqual(G.inkBounds([[1, 2, NaN, 4]], 1), null);
  assert.strictEqual(G.inkBounds([[1, 2, 3, 4]], -1), null);
});

test('boxes: from arrays, intersections, visible box, page checks', () => {
  assert.deepStrictEqual(G.boxFromArray([612, 792, 0, 0]), { x0: 0, y0: 0, x1: 612, y1: 792 });
  assert.strictEqual(G.boxFromArray([0, 0, 1]), null);
  assert.strictEqual(G.boxFromArray([0, 0, 1, NaN]), null);
  assert.deepStrictEqual(G.boxToArray({ x0: 5, y0: 9, x1: 1, y1: 2 }), [1, 2, 5, 9]);
  assert.strictEqual(G.intersectBoxes({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 0, x1: 2, y1: 1 }), null);
  const media = { x0: 0, y0: 0, x1: 612, y1: 792 };
  assert.deepStrictEqual(G.visibleBox({ mediaBox: media }), media);
  assert.deepStrictEqual(G.visibleBox({ mediaBox: media, cropBox: { x0: 36, y0: 36, x1: 700, y1: 756 } }),
    { x0: 36, y0: 36, x1: 612, y1: 756 });
  assert.deepStrictEqual(G.visibleBox({ mediaBox: media, cropBox: { x0: 700, y0: 0, x1: 800, y1: 10 } }), media,
    'a crop box outside the media box falls back to the media box');
  const page = { mediaBox: { x0: 50, y0: 100, x1: 662, y1: 892 } };
  assert.ok(G.fitsPage({ x0: 50, y0: 100, x1: 662, y1: 892 }, page));
  assert.ok(G.fitsPage({ x0: 48.5, y0: 99, x1: 663, y1: 893.9 }, page), 'within the tolerance');
  assert.ok(!G.fitsPage({ x0: 0, y0: 0, x1: 10, y1: 10 }, page), 'below-left of an offset box');
  assert.ok(!G.fitsPage({ x0: 100, y0: 100, x1: 700, y1: 200 }, page));
  assert.ok(!G.fitsPage({ x0: NaN, y0: 100, x1: 200, y1: 200 }, page));
  assert.ok(G.boxContains(media, { x0: 1, y0: 1, x1: 2, y1: 2 }));
  assert.deepStrictEqual(G.expandBox({ x0: 2, y0: 2, x1: 1, y1: 1 }, 1), { x0: 0, y0: 0, x1: 3, y1: 3 });
});
