// Page geometry for the PDF edit core (spec §6.3, §6.4, §8). Pure functions, no `vscode`, no npm.
//
// Conventions — identical to media/pdfViewMath.js (the webview counterpart; tests/pdf/geometry.test.mjs
// cross-checks them):
//  - User space: PDF points, origin bottom-left, unrotated page. Every annotation geometry the host
//    stores is in user space of its page.
//  - A box is { x0, y0, x1, y1 } in user space; corners may come in either order (a /MediaBox array
//    need not be normalised), `normBox` orders them.
//  - A view geometry is { box, scale, rotation }: the visible box, CSS px per point and the clockwise
//    view rotation (any multiple of 90). View coordinates are px from the rotated page's top-left.
//  - A quad is 8 numbers in pdf.js order TL, TR, BL, BR as x,y pairs; quads of one annotation are
//    concatenated into one flat array.
//  - An outline (pdf.js `outlines` of a highlight) is a closed polygon as a flat x,y array, walked
//    around the perimeter: TL, TR, BR, BL.

export interface PdfBox { x0: number; y0: number; x1: number; y1: number; }
export interface PdfViewGeometry { box: PdfBox; scale: number; rotation: number; }
export interface PdfPoint { x: number; y: number; }

/** The page facts geometry checks need (filled by classification, spec §6.2). */
export interface PdfPageBoxes {
  mediaBox: PdfBox;
  /** Absent when the page has no /CropBox (it then equals the media box). */
  cropBox?: PdfBox;
  /** /Rotate as found in the page tree; any multiple of 90, normalised here. */
  rotate?: number;
}

/** How far (points) an annotation may reach outside the media box before it is refused. */
export const PAGE_TOLERANCE = 2;
/** Quads and strokes whose extent is below this (points) in either direction are degenerate. */
export const MIN_EXTENT = 1e-3;

function finite(...ns: number[]): boolean {
  for (const n of ns) if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  return true;
}

// ---------------------------------------------------------------- rotation / boxes

/** Any integer multiple of 90 (negative allowed) -> 0|90|180|270; anything else -> 0 (as pdfViewMath). */
export function normalizeRotation(r: unknown): 0 | 90 | 180 | 270 {
  if (typeof r !== 'number' || !Number.isFinite(r) || r % 90 !== 0) return 0;
  return (((r % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Corners ordered so x0 <= x1 and y0 <= y1. */
export function normBox(b: PdfBox): PdfBox {
  return { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
}

/** A box from a PDF rectangle array [llx lly urx ury] (any corner order), or null if malformed. */
export function boxFromArray(a: readonly number[]): PdfBox | null {
  if (!Array.isArray(a) || a.length !== 4 || !finite(a[0], a[1], a[2], a[3])) return null;
  return normBox({ x0: a[0], y0: a[1], x1: a[2], y1: a[3] });
}

/** [x0, y0, x1, y1] of a normalised box — the PDF /Rect form pdf.js's writer takes. */
export function boxToArray(b: PdfBox): [number, number, number, number] {
  const n = normBox(b);
  return [n.x0, n.y0, n.x1, n.y1];
}

export function boxWidth(b: PdfBox): number { return Math.abs(b.x1 - b.x0); }
export function boxHeight(b: PdfBox): number { return Math.abs(b.y1 - b.y0); }

/** Intersection of two boxes, or null when they do not overlap with a positive area. */
export function intersectBoxes(a: PdfBox, b: PdfBox): PdfBox | null {
  const p = normBox(a), q = normBox(b);
  const r = { x0: Math.max(p.x0, q.x0), y0: Math.max(p.y0, q.y0), x1: Math.min(p.x1, q.x1), y1: Math.min(p.y1, q.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/** True when `inner` lies inside `outer` grown by `tolerance` on every side. */
export function boxContains(outer: PdfBox, inner: PdfBox, tolerance = 0): boolean {
  const o = normBox(outer), i = normBox(inner);
  return i.x0 >= o.x0 - tolerance && i.y0 >= o.y0 - tolerance && i.x1 <= o.x1 + tolerance && i.y1 <= o.y1 + tolerance;
}

/** The box grown by `d` on every side. */
export function expandBox(b: PdfBox, d: number): PdfBox {
  const n = normBox(b);
  return { x0: n.x0 - d, y0: n.y0 - d, x1: n.x1 + d, y1: n.y1 + d };
}

/** The visible box of a page: crop box clipped to the media box (PDF 32000 §14.11.2); the media box otherwise. */
export function visibleBox(p: PdfPageBoxes): PdfBox {
  const media = normBox(p.mediaBox);
  if (!p.cropBox) return media;
  return intersectBoxes(media, p.cropBox) ?? media;
}

/** Displayed size (points) of a box under a rotation: width and height swap for 90/270. */
export function rotatedSize(b: PdfBox, rotation: number): { width: number; height: number } {
  const r = normalizeRotation(rotation);
  const w = boxWidth(b), h = boxHeight(b);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

// ---------------------------------------------------------------- page <-> view

function geomSize(g: PdfViewGeometry): { w: number; h: number } {
  return { w: boxWidth(g.box) * g.scale, h: boxHeight(g.box) * g.scale };
}

/** User-space point -> view px (relative to the rotated page's top-left). Same maths as pdfViewMath.pageToView. */
export function pageToView(g: PdfViewGeometry, x: number, y: number): PdfPoint {
  const r = normalizeRotation(g.rotation);
  const { w, h } = geomSize(g);
  const u = (x - Math.min(g.box.x0, g.box.x1)) * g.scale;
  const v = h - (y - Math.min(g.box.y0, g.box.y1)) * g.scale;
  switch (r) {
    case 90: return { x: h - v, y: u };
    case 180: return { x: w - u, y: h - v };
    case 270: return { x: v, y: w - u };
    default: return { x: u, y: v };
  }
}

/** View px -> user-space point. Same maths as pdfViewMath.viewToPage. */
export function viewToPage(g: PdfViewGeometry, px: number, py: number): PdfPoint {
  const r = normalizeRotation(g.rotation);
  const { w, h } = geomSize(g);
  let u: number, v: number;
  switch (r) {
    case 90: v = h - px; u = py; break;
    case 180: u = w - px; v = h - py; break;
    case 270: v = px; u = w - py; break;
    default: u = px; v = py;
  }
  return { x: u / g.scale + Math.min(g.box.x0, g.box.x1), y: (h - v) / g.scale + Math.min(g.box.y0, g.box.y1) };
}

/** Normalised user-space box from two opposite view corners. Same as pdfViewMath.viewRectToPage. */
export function viewRectToPage(g: PdfViewGeometry, left: number, top: number, right: number, bottom: number): PdfBox {
  const a = viewToPage(g, left, top);
  const b = viewToPage(g, right, bottom);
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** User-space box -> view rect { left, top, right, bottom } (rotation-aware bounds of its corners). */
export function pageRectToView(g: PdfViewGeometry, b: PdfBox): { left: number; top: number; right: number; bottom: number } {
  const a = pageToView(g, b.x0, b.y0);
  const c = pageToView(g, b.x1, b.y1);
  return { left: Math.min(a.x, c.x), top: Math.min(a.y, c.y), right: Math.max(a.x, c.x), bottom: Math.max(a.y, c.y) };
}

// ---------------------------------------------------------------- quads

/** Box -> quad TL, TR, BL, BR (as pdfViewMath.rectToQuad). */
export function rectToQuad(b: PdfBox): number[] {
  const n = normBox(b);
  return [n.x0, n.y1, n.x1, n.y1, n.x0, n.y0, n.x1, n.y0];
}

/** Bounding box of the points of one quad starting at `offset`. */
export function quadBounds(quads: readonly number[], offset = 0): PdfBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = offset; i < offset + 8; i += 2) {
    const x = quads[i], y = quads[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Quads normalised to axis-aligned TL, TR, BL, BR order: each quad becomes the quad of its bounding
 * box. Selections on pages rotated by multiples of 90 are axis-aligned in user space, so this only
 * fixes corner order; it also makes the stored geometry canonical whatever order the webview used.
 * Returns null when the array is not a positive multiple of 8 finite numbers or a quad is degenerate.
 */
export function normalizeQuads(quads: readonly number[]): number[] | null {
  if (!Array.isArray(quads) || quads.length === 0 || quads.length % 8 !== 0) return null;
  for (const n of quads) if (!finite(n)) return null;
  const out: number[] = [];
  for (let i = 0; i < quads.length; i += 8) {
    const b = quadBounds(quads, i);
    if (boxWidth(b) < MIN_EXTENT || boxHeight(b) < MIN_EXTENT) return null;
    out.push(...rectToQuad(b));
  }
  return out;
}

/** Bounding box of every quad (the highlight's /Rect), or null for an empty or malformed array. */
export function quadsBounds(quads: readonly number[]): PdfBox | null {
  if (!Array.isArray(quads) || quads.length === 0 || quads.length % 8 !== 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < quads.length; i += 2) {
    const x = quads[i], y = quads[i + 1];
    if (!finite(x, y)) return null;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Each quad as a closed polygon walked around its perimeter (TL, TR, BR, BL), flat x,y — the
 * `outlines` of a pdf.js highlight storage entry (spec §6.4), which pdf.js fills with Multiply.
 */
export function quadsToOutlines(quads: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    const q = quads;
    out.push([q[i], q[i + 1], q[i + 2], q[i + 3], q[i + 6], q[i + 7], q[i + 4], q[i + 5]]);
  }
  return out;
}

// ---------------------------------------------------------------- ink

/**
 * Bounding box of every stroke point grown by half the line width (the ink annotation's /Rect, so
 * the stroke's caps are inside it), or null when there is no point or a coordinate is not finite.
 */
export function inkBounds(paths: readonly (readonly number[])[], width: number): PdfBox | null {
  if (!Array.isArray(paths) || !finite(width) || width < 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const s of paths) {
    if (!Array.isArray(s) || s.length % 2 !== 0) return null;
    for (let i = 0; i < s.length; i += 2) {
      const x = s[i], y = s[i + 1];
      if (!finite(x, y)) return null;
      any = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return any ? expandBox({ x0, y0, x1, y1 }, width / 2) : null;
}

// ---------------------------------------------------------------- page-box checks

/**
 * Whether an annotation's bounds may be placed on the page: inside the media box (nothing exists
 * outside it) with `PAGE_TOLERANCE` points of slack for selection rectangles that overhang the edge.
 */
export function fitsPage(bounds: PdfBox, page: PdfPageBoxes, tolerance = PAGE_TOLERANCE): boolean {
  if (!finite(bounds.x0, bounds.y0, bounds.x1, bounds.y1)) return false;
  return boxContains(page.mediaBox, bounds, tolerance);
}
