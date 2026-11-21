// @ts-nocheck
// Excel grid maths — pure functions, no DOM. UMD: `require`d by Node tests and loaded
// by the webview as the global `XlsxGridMath` (pattern of media/gltfViewerMath.js).
//
// Everything is index based (0-based rows/cols) and sized for a full sheet
// (1,048,576 x 16,384): no function here loops over the row/column count while
// scrolling. Axes cost O(overrides + hidden runs) to build and O(log k) per query.
(function (global) {
  'use strict';

  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;

  // ---------------------------------------------------------------- axis

  function lastLE(arr, x) {
    // index of the last element <= x, or -1
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  /**
   * Prefix-sum axis over `count` lines of `defaultPx`, with sparse size overrides and
   * hidden lines (size 0).
   * @param {number} count
   * @param {number} defaultPx  > 0
   * @param {Array<[number, number]>} [overrides] sparse [index, px]; later duplicates win
   * @param {number[]} [hidden] hidden indices (win over overrides)
   */
  function buildAxis(count, defaultPx, overrides, hidden) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
    if (!(defaultPx > 0) || !Number.isFinite(defaultPx)) throw new RangeError('defaultPx must be > 0');

    const sizeMap = new Map();
    for (const o of overrides || []) {
      const i = o[0], px = o[1];
      if (Number.isInteger(i) && i >= 0 && i < count && Number.isFinite(px) && px >= 0) {
        sizeMap.set(i, px);
      }
    }
    const hid = [];
    for (const [i, px] of sizeMap) if (px === 0) hid.push(i); // zero width/height = hidden
    for (const i of hidden || []) {
      if (Number.isInteger(i) && i >= 0 && i < count) hid.push(i);
    }
    hid.sort((a, b) => a - b);

    // Hidden runs (merged, sorted, disjoint).
    const hStart = [], hEnd = [];
    for (const i of hid) {
      const n = hEnd.length - 1;
      if (n >= 0 && i <= hEnd[n] + 1) { if (i > hEnd[n]) hEnd[n] = i; } else { hStart.push(i); hEnd.push(i); }
    }
    const hiddenAt = (i) => { const k = lastLE(hStart, i); return k >= 0 && i <= hEnd[k]; };

    // Segments: sorted disjoint [start,end,size] with a uniform size.
    const segs = [];
    for (let k = 0; k < hStart.length; k++) segs.push([hStart[k], hEnd[k], 0]);
    for (const [i, px] of sizeMap) if (px !== defaultPx && !hiddenAt(i)) segs.push([i, i, px]);
    segs.sort((a, b) => a[0] - b[0]);
    const starts = new Array(segs.length), ends = new Array(segs.length), sizes = new Array(segs.length);
    const cum = new Array(segs.length); // sum of (size-default)*len over earlier segments
    let acc = 0;
    for (let k = 0; k < segs.length; k++) {
      starts[k] = segs[k][0]; ends[k] = segs[k][1]; sizes[k] = segs[k][2];
      cum[k] = acc;
      acc += (sizes[k] - defaultPx) * (ends[k] - starts[k] + 1);
    }

    function offsetOf(i) {
      if (i <= 0) return 0;
      if (i > count) i = count;
      const k = lastLE(starts, i);
      let off = i * defaultPx;
      if (k >= 0) {
        off += cum[k] + (sizes[k] - defaultPx) * (Math.min(i, ends[k] + 1) - starts[k]);
      }
      return off;
    }
    const total = offsetOf(count);

    function sizeOf(i) {
      if (!Number.isInteger(i) || i < 0 || i >= count) return 0;
      const k = lastLE(starts, i);
      return k >= 0 && i <= ends[k] ? sizes[k] : defaultPx;
    }
    function isHidden(i) {
      return Number.isInteger(i) && i >= 0 && i < count && hiddenAt(i);
    }
    // nearest visible index strictly in direction `dir` from i; -1 if none
    function nextVisible(i, dir) {
      let j = i + dir;
      if (j < 0 || j >= count) return -1;
      const k = lastLE(hStart, j);
      if (k >= 0 && j <= hEnd[k]) j = dir > 0 ? hEnd[k] + 1 : hStart[k] - 1;
      return j < 0 || j >= count ? -1 : j;
    }
    function firstVisible() {
      if (count === 0) return -1;
      return hiddenAt(0) ? nextVisible(hEnd[0], 1) : 0;
    }
    function lastVisible() {
      if (count === 0) return -1;
      return hiddenAt(count - 1) ? nextVisible(hStart[hStart.length - 1], -1) : count - 1;
    }
    // index of the (non-hidden) line containing px; clamps to first/last visible
    function indexAt(px) {
      if (count === 0) return -1;
      if (!(px > 0)) return firstVisible();
      if (px >= total) return lastVisible();
      // smallest i with offsetOf(i+1) > px (never a zero-size line)
      let lo = 0, hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsetOf(mid + 1) > px) hi = mid; else lo = mid + 1;
      }
      return lo;
    }

    return { count, total, defaultPx, offsetOf, sizeOf, indexAt, isHidden, nextVisible, firstVisible, lastVisible };
  }

  // ------------------------------------------------------------- window

  /**
   * Which rows/cols to render. Frozen lines are always shown; `scroll` is the offset
   * into the *scrollable* region (0 = first non-frozen line flush with the frozen edge).
   * @param {{x:number,y:number}} scroll
   * @param {{width:number,height:number}} viewport  full viewport incl. frozen area
   * @param {{rows:object, cols:object}} axes  from buildAxis
   * @param {{rows:number, cols:number}} frozen
   * @param {number|{rows:number,cols:number}} [overscan] extra lines each side (default 5)
   * @returns first/last* = exactly visible scrollable lines; rows/cols = overscanned
   *   inclusive [start,end] of the scrollable region (null when nothing scrolls).
   */
  function visibleWindow(scroll, viewport, axes, frozen, overscan) {
    const R = axes.rows, C = axes.cols;
    let os = { rows: 5, cols: 5 };
    if (typeof overscan === 'number') os = { rows: overscan, cols: overscan };
    else if (overscan) os = { rows: overscan.rows != null ? overscan.rows : 5, cols: overscan.cols != null ? overscan.cols : 5 };
    const fr = Math.max(0, Math.min((frozen && frozen.rows) | 0, R.count));
    const fc = Math.max(0, Math.min((frozen && frozen.cols) | 0, C.count));
    const frozenHeight = R.offsetOf(fr), frozenWidth = C.offsetOf(fc);

    function span(axis, f, frozenPx, scrollPx, viewPx, ov) {
      if (f >= axis.count) return { first: -1, last: -1, range: null };
      const base = axis.offsetOf(f);
      const maxScroll = Math.max(0, axis.total - base);
      const s = Math.min(Math.max(0, scrollPx || 0), maxScroll);
      const startPx = base + s;
      const endPx = startPx + Math.max(0, viewPx - frozenPx);
      let first = axis.indexAt(startPx);
      let last = axis.indexAt(Math.max(startPx, endPx - 0.0001));
      if (first < f) first = f;
      if (last < first) last = first;
      return { first, last, range: [Math.max(f, first - ov), Math.min(axis.count - 1, last + ov)] };
    }
    const rs = span(R, fr, frozenHeight, scroll && scroll.y, viewport.height, os.rows);
    const cs = span(C, fc, frozenWidth, scroll && scroll.x, viewport.width, os.cols);
    return {
      frozenRows: fr, frozenCols: fc, frozenHeight, frozenWidth,
      firstRow: rs.first, lastRow: rs.last, firstCol: cs.first, lastCol: cs.last,
      rows: rs.range, cols: cs.range,
    };
  }

  function splitRange(r0, c0, r1, c1, maxCells, out) {
    const w = c1 - c0 + 1;
    if (w > maxCells) {
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c += maxCells) out.push([r, c, r, Math.min(c1, c + maxCells - 1)]);
      }
      return;
    }
    const band = Math.max(1, Math.floor(maxCells / w));
    for (let r = r0; r <= r1; r += band) out.push([r, c0, Math.min(r1, r + band - 1), c1]);
  }

  /**
   * Cell ranges to request for a visibleWindow result: frozen corner, frozen top strip,
   * frozen left strip and body. Every range holds <= maxCells cells (larger areas are
   * split into row bands).
   * @returns {Array<[number,number,number,number]>}
   */
  function requestRanges(win, maxCells) {
    const cap = Math.max(1, Math.floor(maxCells) || 20000);
    const out = [];
    const fr = win.frozenRows, fc = win.frozenCols;
    const rr = win.rows, cr = win.cols;
    if (fr > 0 && fc > 0) splitRange(0, 0, fr - 1, fc - 1, cap, out);
    if (fr > 0 && cr) splitRange(0, cr[0], fr - 1, cr[1], cap, out);
    if (fc > 0 && rr) splitRange(rr[0], 0, rr[1], fc - 1, cap, out);
    if (rr && cr) splitRange(rr[0], cr[0], rr[1], cr[1], cap, out);
    return out;
  }

  // -------------------------------------------------------------- merges

  /** The merge [r0,c0,r1,c1] containing (r,c), or null. O(merges); callers may cache. */
  function mergeAt(merges, r, c) {
    if (!merges) return null;
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      if (r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3]) return m;
    }
    return null;
  }

  // ---------------------------------------------------------- navigation

  // bounding rect of two corners, grown to include every merge it touches
  function rectOf(a, b, meta) {
    let r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
    let c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    const merges = meta.merges || [];
    let changed = merges.length > 0;
    let guard = 0;
    while (changed && guard++ < 64) {
      changed = false;
      for (const m of merges) {
        if (m[0] <= r1 && m[2] >= r0 && m[1] <= c1 && m[3] >= c0) {
          if (m[0] < r0) { r0 = m[0]; changed = true; }
          if (m[2] > r1) { r1 = m[2]; changed = true; }
          if (m[1] < c0) { c0 = m[1]; changed = true; }
          if (m[3] > c1) { c1 = m[3]; changed = true; }
        }
      }
    }
    return [r0, c0, r1, c1];
  }

  function step(axis, count, i, dir) {
    if (axis) { const j = axis.nextVisible(i, dir); return j < 0 ? i : j; }
    const j = i + dir;
    return j < 0 || j >= count ? i : j;
  }
  function firstV(axis) { return axis ? axis.firstVisible() : 0; }
  function lastV(axis, count) { return axis ? axis.lastVisible() : count - 1; }

  function snapMerge(p, meta) {
    const m = mergeAt(meta.merges, p.r, p.c);
    return m ? { r: m[0], c: m[1] } : p;
  }

  // One cell in direction (dr,dc): leaves the current merge, skips hidden lines.
  function stepCell(from, dr, dc, meta, useMerges) {
    let r = from.r, c = from.c;
    const m = useMerges ? mergeAt(meta.merges, r, c) : null;
    if (m) {
      if (dr > 0) r = m[2]; else if (dr < 0) r = m[0];
      if (dc > 0) c = m[3]; else if (dc < 0) c = m[1];
    }
    if (dr) r = step(meta.rowAxis, meta.rowCount, r, dr);
    if (dc) c = step(meta.colAxis, meta.colCount, c, dc);
    return { r, c };
  }

  // Excel Ctrl+arrow: stop at the end of the current data run; if the neighbour is empty
  // (or we start on an empty cell) stop at the next non-empty cell, else at the sheet edge.
  function jumpEdge(from, dr, dc, meta, isEmpty) {
    const nxt = (p) => {
      const q = { r: p.r, c: p.c };
      if (dr) q.r = step(meta.rowAxis, meta.rowCount, p.r, dr);
      if (dc) q.c = step(meta.colAxis, meta.colCount, p.c, dc);
      return q.r === p.r && q.c === p.c ? null : q;
    };
    let cur = { r: from.r, c: from.c };
    let n = nxt(cur);
    if (!n) return cur;
    if (!isEmpty(cur.r, cur.c) && !isEmpty(n.r, n.c)) {
      while (n && !isEmpty(n.r, n.c)) { cur = n; n = nxt(cur); }
      return cur;
    }
    while (n && isEmpty(n.r, n.c)) { cur = n; n = nxt(cur); }
    return n || cur;
  }

  /**
   * Keyboard navigation. `state` = {active:{r,c}, focus?:{r,c}}; focus is the moving end
   * of a Shift-extended selection (defaults to active).
   * meta = {rowCount, colCount, rowAxis?, colAxis?, merges?, pageRows?, pageCols?}.
   * Keys are KeyboardEvent.key values. Returns {active, focus, selection:[r0,c0,r1,c1]},
   * or null when the key is not a navigation key.
   */
  function moveActive(state, key, modifiers, meta, isEmpty) {
    const mod = modifiers || {};
    const ctrl = !!(mod.ctrl || mod.meta), shift = !!mod.shift, alt = !!mod.alt;
    const empty = isEmpty || (() => true);
    const active = state.active;
    const focus = state.focus || active;
    const done = (a, f) => ({ active: a, focus: f, selection: rectOf(a, f, meta) });

    if ((key === 'a' || key === 'A') && ctrl && !alt) {
      return {
        active,
        focus: { r: lastV(meta.rowAxis, meta.rowCount), c: lastV(meta.colAxis, meta.colCount) },
        selection: [0, 0, meta.rowCount - 1, meta.colCount - 1],
      };
    }

    // Shift extends with arrows/Home/End/Page keys; for Tab/Enter it reverses direction.
    const extend = shift && key !== 'Tab' && key !== 'Enter';
    const from = extend ? focus : active;
    let to;
    switch (key) {
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
        const dr = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
        const dc = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
        to = ctrl ? jumpEdge(from, dr, dc, meta, empty) : stepCell(from, dr, dc, meta, !extend);
        break;
      }
      case 'Tab': to = stepCell(active, 0, shift ? -1 : 1, meta, true); break;
      case 'Enter': to = stepCell(active, shift ? -1 : 1, 0, meta, true); break;
      case 'Home':
        to = ctrl ? { r: firstV(meta.rowAxis), c: firstV(meta.colAxis) } : { r: from.r, c: firstV(meta.colAxis) };
        break;
      case 'End':
        to = ctrl
          ? { r: lastV(meta.rowAxis, meta.rowCount), c: lastV(meta.colAxis, meta.colCount) }
          : { r: from.r, c: lastV(meta.colAxis, meta.colCount) };
        break;
      case 'PageUp': case 'PageDown': {
        const dir = key === 'PageUp' ? -1 : 1;
        const n = Math.max(1, (alt ? meta.pageCols : meta.pageRows) | 0 || (alt ? 8 : 20));
        let p = { r: from.r, c: from.c };
        for (let i = 0; i < n; i++) {
          const q = alt
            ? { r: p.r, c: step(meta.colAxis, meta.colCount, p.c, dir) }
            : { r: step(meta.rowAxis, meta.rowCount, p.r, dir), c: p.c };
          if (q.r === p.r && q.c === p.c) break;
          p = q;
        }
        to = p;
        break;
      }
      default: return null;
    }
    if (to.r < 0 || to.c < 0) to = { r: from.r, c: from.c };
    if (extend) return done(active, to);
    to = snapMerge(to, meta);
    return done(to, to);
  }

  // ------------------------------------------------------------- selection

  /** Parse a number out of a display string ("1,234.5", "$3", "(12)", "45%", "1E3"). */
  function parseDisplayNumber(d) {
    if (typeof d !== 'string') return NaN;
    let s = d.trim();
    if (!s) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    let pct = false;
    if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
    s = s.replace(/^([+-]?)\s*[$£€¥]\s*/, '$1').replace(/,/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    let n = Number(s);
    if (pct) n /= 100;
    return neg ? -n : n;
  }

  /**
   * Status-bar stats over loaded cells (XlsxCell-like). Numeric = k 'n' (dates excluded).
   * Uses a numeric `v` field when present, else parses the display string `d`.
   * @returns {{sum:number,average:number|null,count:number}}
   */
  function selectionStats(cells) {
    let sum = 0, count = 0;
    for (const cell of cells || []) {
      if (!cell || cell.k !== 'n') continue;
      const n = typeof cell.v === 'number' ? cell.v : parseDisplayNumber(cell.d);
      if (!Number.isFinite(n)) continue;
      sum += n; count++;
    }
    sum = Number(sum.toPrecision(15));
    return { sum, average: count ? Number((sum / count).toPrecision(15)) : null, count };
  }

  function tsvField(s) {
    return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * Tab-separated text for `range` from loaded cells (array, or Map keyed "r,c"). Missing
   * cells are empty. Hidden rows/cols are skipped when axes are supplied (Excel behaviour).
   * opts = {rowAxis?, colAxis?, maxCells?} (throws RangeError above maxCells, default 1e6).
   */
  function toTsv(cells, range, opts) {
    const o = opts || {};
    const r0 = range[0], c0 = range[1], r1 = range[2], c1 = range[3];
    const max = o.maxCells || 1000000;
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > max) throw new RangeError('range exceeds ' + max + ' cells');
    let map = cells;
    if (!(cells instanceof Map)) {
      map = new Map();
      for (const x of cells || []) map.set(x.r + ',' + x.c, x);
    }
    const cols = [];
    for (let c = c0; c <= c1; c++) if (!(o.colAxis && o.colAxis.isHidden(c))) cols.push(c);
    const lines = [];
    for (let r = r0; r <= r1; r++) {
      if (o.rowAxis && o.rowAxis.isHidden(r)) continue;
      lines.push(cols.map((c) => { const x = map.get(r + ',' + c); return x && x.d ? tsvField(x.d) : ''; }).join('\t'));
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------ unit helpers

  /** Excel <col width> (file value, padding included; 9.140625 = default) -> px (maxDigitPx 7 for Calibri 11). */
  function charWidthToPx(chars, maxDigitPx) {
    const mdw = maxDigitPx || 7;
    return Math.trunc(((256 * chars + Math.trunc(128 / mdw)) / 256) * mdw);
  }
  /** Row height in points -> px at 96 dpi. */
  function pointsToPx(pt) {
    return (pt * 96) / 72;
  }

  const api = {
    MAX_ROWS, MAX_COLS,
    buildAxis, visibleWindow, requestRanges, mergeAt, moveActive,
    selectionStats, toTsv, parseDisplayNumber, charWidthToPx, pointsToPx,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.XlsxGridMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
