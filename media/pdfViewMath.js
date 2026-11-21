// @ts-nocheck
// PDF viewer maths — pure functions, no DOM. UMD: `require`d by Node tests and loaded
// by the webview as the global `PdfViewMath` (pattern of media/xlsxGridMath.js).
//
// Conventions
//  - Zoom is a scale factor (1 = 100 %), as pdf.js `currentScale`.
//  - A "geometry" is { box: {x0,y0,x1,y1}, scale, rotation } describing one page: the
//    visible box in PDF user space (points, origin bottom-left, unrotated), the view scale
//    (CSS px per point) and the clockwise view rotation (/Rotate + view rotation, summed by
//    the caller; any multiple of 90). View coordinates are CSS px relative to the top-left
//    of the rotated page box.
//  - Quads are 8 numbers in pdf.js order: TL, TR, BL, BR as x,y pairs (user space).
(function (global) {
  'use strict';

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 5;
  const MAX_AUTO_ZOOM = 1.25;
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
  const THUMB_CAP = 200;
  const EPS = 1e-6;

  // ---------------------------------------------------------------- zoom

  function clampZoom(z) {
    if (typeof z !== 'number' || !isFinite(z)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }

  /** Next step above `z` (MAX_ZOOM at the top). */
  function zoomIn(z) {
    const c = clampZoom(z);
    for (const s of ZOOM_STEPS) if (s > c + EPS) return s;
    return MAX_ZOOM;
  }

  /** Next step below `z` (MIN_ZOOM at the bottom). */
  function zoomOut(z) {
    const c = clampZoom(z);
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < c - EPS) return ZOOM_STEPS[i];
    return MIN_ZOOM;
  }

  /** Continuous zoom for Ctrl+wheel / pinch: `factor` multiplies the scale; result clamped. */
  function zoomBy(z, factor) {
    if (typeof factor !== 'number' || !isFinite(factor) || factor <= 0) return clampZoom(z);
    return clampZoom(clampZoom(z) * factor);
  }

  function zoomPercent(z) {
    return Math.round(clampZoom(z) * 100);
  }

  // ---------------------------------------------------------------- rotation / sizes

  /** Any integer multiple of 90 (negative allowed) -> 0|90|180|270; anything else -> 0. */
  function normalizeRotation(r) {
    if (typeof r !== 'number' || !isFinite(r) || r % 90 !== 0) return 0;
    return ((r % 360) + 360) % 360;
  }

  /** Rotate the view clockwise (delta >= 0) or counter-clockwise (delta < 0) by 90. */
  function rotateView(current, delta) {
    return normalizeRotation(normalizeRotation(current) + (delta >= 0 ? 90 : -90));
  }

  /** Size as displayed (width/height swapped for 90/270). Any unit. */
  function rotatedSize(width, height, rotation) {
    const r = normalizeRotation(rotation);
    return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
  }

  function boxSize(box) {
    return { width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) };
  }

  // ---------------------------------------------------------------- fit

  /**
   * Scale for a zoom mode. `pageW/pageH` = unrotated page size in points, `view` = the
   * container's client size in px, `margin` = horizontal and vertical padding (px).
   * mode: 'auto' (fit width, capped at 125 % like pdf.js) | 'page-width' | 'page-fit' |
   * 'actual' | a number. Always clamped to [MIN_ZOOM, MAX_ZOOM]; degenerate input -> 1.
   */
  function fitScale(mode, pageW, pageH, rotation, view, margin) {
    if (typeof mode === 'number') return clampZoom(mode);
    if (mode === 'actual') return 1;
    const m = margin && isFinite(margin) ? margin : 0;
    const sz = rotatedSize(pageW, pageH, rotation);
    if (!(sz.width > 0) || !(sz.height > 0) || !view) return 1;
    const wScale = Math.max(1, view.width - m) / sz.width;
    const hScale = Math.max(1, view.height - m) / sz.height;
    switch (mode) {
      case 'page-width': return clampZoom(wScale);
      case 'page-fit': return clampZoom(Math.min(wScale, hScale));
      case 'auto': return clampZoom(Math.min(MAX_AUTO_ZOOM, wScale));
      default: return 1;
    }
  }

  // ---------------------------------------------------------------- page box input

  /**
   * Parse the page box text to a 0-based page index, or -1. `labels` (optional array of
   * page-label strings): an exact, case-insensitive label match wins; otherwise a positive
   * integer within 1..pageCount is a physical page number.
   */
  function parsePageBox(text, pageCount, labels) {
    const t = String(text == null ? '' : text).trim();
    if (!t || !(pageCount > 0)) return -1;
    if (Array.isArray(labels)) {
      const want = t.toLowerCase();
      const n = Math.min(labels.length, pageCount);
      for (let i = 0; i < n; i++) {
        if (labels[i] != null && String(labels[i]).trim().toLowerCase() === want) return i;
      }
    }
    if (/^\d+$/.test(t)) {
      const v = parseInt(t, 10);
      return v >= 1 && v <= pageCount ? v - 1 : -1;
    }
    return -1;
  }

  /** "12 of 340"; with a label that differs from the number: "iii (3 of 6)". */
  function pageStatus(index, pageCount, labels) {
    const num = index + 1;
    const label = Array.isArray(labels) && labels[index] != null ? String(labels[index]) : '';
    if (label && label !== String(num)) return label + ' (' + num + ' of ' + pageCount + ')';
    return num + ' of ' + pageCount;
  }

  /** Clamp a 0-based page index into the document. */
  function clampPage(index, pageCount) {
    if (!(pageCount > 0)) return 0;
    if (typeof index !== 'number' || !isFinite(index)) return 0;
    return Math.min(pageCount - 1, Math.max(0, Math.trunc(index)));
  }

  // ---------------------------------------------------------------- thumbnail window

  /**
   * Thumbnail indices to keep rendered: the visible range [first, last] (0-based, inclusive,
   * either order) widened by `buffer` (default 5) each side, capped at `cap` (default 200)
   * entries, trimming the buffer first so the visible range survives. Returns {start, end}
   * inclusive, or null for an empty document.
   */
  function thumbnailWindow(first, last, pageCount, buffer, cap) {
    if (!(pageCount > 0)) return null;
    const capN = cap > 0 ? cap : THUMB_CAP;
    const b = buffer >= 0 ? buffer : 5;
    const lo = clampPage(Math.min(first, last), pageCount);
    let hi = clampPage(Math.max(first, last), pageCount);
    if (hi - lo + 1 > capN) hi = lo + capN - 1;
    let start = Math.max(0, lo - b);
    let end = Math.min(pageCount - 1, hi + b);
    while (end - start + 1 > capN) {
      if (lo - start >= end - hi) start++; else end--;
    }
    return { start, end };
  }

  // ---------------------------------------------------------------- coordinates

  function geomSize(g) {
    const s = boxSize(g.box);
    return { w: s.width * g.scale, h: s.height * g.scale };
  }

  /** User-space point -> view px (relative to the rotated page's top-left). */
  function pageToView(g, x, y) {
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

  /** View px (relative to the rotated page's top-left) -> user-space point. */
  function viewToPage(g, px, py) {
    const r = normalizeRotation(g.rotation);
    const { w, h } = geomSize(g);
    let u, v;
    switch (r) {
      case 90: v = h - px; u = py; break;
      case 180: u = w - px; v = h - py; break;
      case 270: v = px; u = w - py; break;
      default: u = px; v = py;
    }
    return {
      x: u / g.scale + Math.min(g.box.x0, g.box.x1),
      y: (h - v) / g.scale + Math.min(g.box.y0, g.box.y1),
    };
  }

  /** Normalised user-space rect {x0,y0,x1,y1} from two opposite view corners. */
  function viewRectToPage(g, left, top, right, bottom) {
    const a = viewToPage(g, left, top);
    const b = viewToPage(g, right, bottom);
    return {
      x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
    };
  }

  /** Rect {x0,y0,x1,y1} -> quad of 8 numbers, order TL, TR, BL, BR. */
  function rectToQuad(r) {
    return [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0];
  }

  // ---------------------------------------------------------------- rect merging

  /**
   * Merge client rects ({left,top,right,bottom}, any coordinate space) into one rect per
   * text line. Two rects are on one line when they overlap vertically by more than half of
   * the shorter one; on a line they merge when the horizontal gap is at most `gap`
   * (default 25 % of the line height, min 1) — a larger gap (columns) stays separate.
   * Zero-area, non-finite and null rects are dropped; contained rects are absorbed.
   * Result is ordered top-to-bottom, left-to-right.
   */
  function mergeRects(rects, gap) {
    const clean = [];
    for (const r of rects || []) {
      if (!r) continue;
      const l = +r.left, t = +r.top, rt = +r.right, b = +r.bottom;
      if (![l, t, rt, b].every(isFinite)) continue;
      const rect = { left: Math.min(l, rt), top: Math.min(t, b), right: Math.max(l, rt), bottom: Math.max(t, b) };
      if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) continue;
      clean.push(rect);
    }
    clean.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of clean) {
      const hr = r.bottom - r.top;
      let line = null;
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
        const L = lines[i];
        const overlap = Math.min(L.bottom, r.bottom) - Math.max(L.top, r.top);
        if (overlap > 0.5 * Math.min(L.bottom - L.top, hr)) { line = L; break; }
      }
      if (line) {
        line.items.push(r);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ top: r.top, bottom: r.bottom, items: [r] });
      }
    }
    const out = [];
    for (const L of lines) {
      const g = gap >= 0 ? gap : Math.max(1, 0.25 * (L.bottom - L.top));
      L.items.sort((a, b) => a.left - b.left);
      let cur = null;
      for (const it of L.items) {
        if (cur && it.left - cur.right <= g) {
          cur.right = Math.max(cur.right, it.right);
          cur.top = Math.min(cur.top, it.top);
          cur.bottom = Math.max(cur.bottom, it.bottom);
        } else {
          if (cur) out.push(cur);
          cur = { left: it.left, top: it.top, right: it.right, bottom: it.bottom };
        }
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  /**
   * Client rects -> merged per line -> quads in user space (8 numbers per quad, flat).
   * `origin` = {x, y}: client position of the page's rotated top-left corner.
   */
  function clientRectsToQuads(rects, g, origin, gap) {
    const ox = origin ? +origin.x || 0 : 0, oy = origin ? +origin.y || 0 : 0;
    const out = [];
    for (const m of mergeRects(rects, gap)) {
      const pr = viewRectToPage(g, m.left - ox, m.top - oy, m.right - ox, m.bottom - oy);
      out.push(...rectToQuad(pr));
    }
    return out;
  }

  const api = {
    MIN_ZOOM, MAX_ZOOM, MAX_AUTO_ZOOM, ZOOM_STEPS, THUMB_CAP,
    clampZoom, zoomIn, zoomOut, zoomBy, zoomPercent,
    normalizeRotation, rotateView, rotatedSize, boxSize,
    fitScale, parsePageBox, pageStatus, clampPage, thumbnailWindow,
    pageToView, viewToPage, viewRectToPage, rectToQuad,
    mergeRects, clientRectsToQuads,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.PdfViewMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
