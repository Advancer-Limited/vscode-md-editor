// @ts-nocheck
// Excel grid component (WP-15, spec 7.2 / 11). Global `XlsxGrid`; also `require`able by tests.
//
// A virtualised DOM grid over the pure maths in xlsxGridMath.js. It renders only the visible
// window plus overscan (nodes are recycled; no work proportional to the sheet size), reports
// gestures through callbacks and never posts messages itself. Document-derived strings reach
// the DOM through textContent / setAttribute only, never through innerHTML (spec 12).
//
// DOM layout (all cells absolutely positioned in sizer coordinates, header row/col included):
//   root[role=grid] > scroller > sizer > body layer + 3 sticky zero-size layers
//     body   : role=row elements for scrolling rows (cells for scrolling columns)
//     top    : sticky top  - column headers + frozen rows (scrolling columns)
//     left   : sticky left - row headers + frozen columns (scrolling rows)
//     corner : sticky both - corner + frozen headers + frozen x frozen cells
//   Cells in `left`/`corner` are owned by their logical row through aria-owns, so assistive
//   technology sees exactly one role=row per sheet row.
(function (global) {
  'use strict';

  const BLOCK_ROWS = 50;
  const BLOCK_COLS = 10;
  const MAX_REQUEST_CELLS = 20000;
  const MAX_IN_FLIGHT = 6;
  const MAX_CACHED_CELLS = 60000;
  const MAX_FROZEN_ROWS = 200;
  const MAX_FROZEN_COLS = 100;
  const MERGE_BUCKET = 64;
  const MERGE_BIG_BUCKETS = 256;
  const HEADER_H = 24;
  const INDENT_PX = 9;

  let instanceCounter = 0;

  // ------------------------------------------------------------ colour helpers

  /** "#rgb", "#rrggbb", "#rrggbbaa" or "rgb(r,g,b)" -> [r,g,b] or null. */
  function parseColor(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    let m = /^#([0-9a-fA-F]{3})$/.exec(t);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    m = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(t);
    if (m) {
      const h = m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/][^)]*)?\)$/.exec(t);
    if (m) return [Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3])];
    return null;
  }

  function luminance(rgb) {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  const BLACK = [0, 0, 0], WHITE = [255, 255, 255];
  const css = (rgb) => 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';

  /** Black or white, whichever contrasts more with `bg` (rgb triple). */
  function contrastColor(bg) {
    return contrastRatio(BLACK, bg) >= contrastRatio(WHITE, bg) ? BLACK : WHITE;
  }

  /**
   * The spec 11.1 colour rule. Returns { bg: css|null, color: css } where null/var() mean
   * "use the theme token" (the CSS supplies it).
   * appearance 'theme': no fill -> editor background; automatic colour -> editor foreground
   * (black/white by contrast on a fill); an explicit colour below 3:1 against the effective
   * background is replaced (editor foreground, or black/white on a fill).
   * appearance 'light': as authored on white.
   */
  function resolveColors(style, appearance, themeBg) {
    const st = style || {};
    const fill = parseColor(st.fill);
    const explicit = st.autoColor ? null : parseColor(st.color);
    if (appearance === 'light') {
      return { bg: fill ? css(fill) : null, color: explicit ? css(explicit) : '#000000' };
    }
    const effBg = fill || themeBg || [30, 30, 30];
    let color;
    if (!explicit) {
      color = fill ? css(contrastColor(fill)) : 'var(--vscode-editor-foreground)';
    } else if (contrastRatio(explicit, effBg) < 3) {
      color = fill ? css(contrastColor(fill)) : 'var(--vscode-editor-foreground)';
    } else {
      color = css(explicit);
    }
    return { bg: fill ? css(fill) : null, color };
  }

  // ------------------------------------------------------------ misc helpers

  function colLabel(c) {
    let s = '';
    let n = c + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function addrOf(r, c) { return colLabel(c) + (r + 1); }
  function rangeLabel(rg) {
    return rg[0] === rg[2] && rg[1] === rg[3] ? addrOf(rg[0], rg[1]) : addrOf(rg[0], rg[1]) + ':' + addrOf(rg[2], rg[3]);
  }

  function toInt(v, dflt) { return Number.isInteger(v) && v >= 0 ? v : dflt; }

  // Merge index: bucketed by row so lookups cost O(merges in the bucket), not O(merges).
  function buildMergeIndex(merges, math) {
    const buckets = new Map();
    const big = [];
    for (const m of merges || []) {
      if (!Array.isArray(m) || m.length < 4) continue;
      if (m[0] === m[2] && m[1] === m[3]) continue; // 1x1 is not a merge
      const b0 = Math.floor(m[0] / MERGE_BUCKET), b1 = Math.floor(m[2] / MERGE_BUCKET);
      if (b1 - b0 > MERGE_BIG_BUCKETS) { big.push(m); continue; }
      for (let b = b0; b <= b1; b++) {
        let a = buckets.get(b);
        if (!a) { a = []; buckets.set(b, a); }
        a.push(m);
      }
    }
    return {
      at(r, c) {
        const a = buckets.get(Math.floor(r / MERGE_BUCKET));
        return (a && math.mergeAt(a, r, c)) || (big.length ? math.mergeAt(big, r, c) : null);
      },
      size: (merges || []).length,
    };
  }

  // ------------------------------------------------------------ create

  function create(container, options) {
    const opts = options || {};
    const math = opts.math || global.XlsxGridMath;
    if (!math) throw new Error('XlsxGrid: XlsxGridMath is required');
    const doc = container.ownerDocument || global.document;
    const uid = 'xg' + (++instanceCounter);
    const cb = {
      requestCells: opts.onRequestCells || (() => {}),
      activeChange: opts.onActiveChange || (() => {}),
      selectionChange: opts.onSelectionChange || (() => {}),
      editGesture: opts.onEditGesture || (() => false),
      contextMenu: opts.onContextMenu || (() => {}),
      cellClick: opts.onCellClick || (() => {}),
      announce: opts.onAnnounce || ((t) => { if (global.OfficeCommon && global.OfficeCommon.announce) global.OfficeCommon.announce(t); }),
    };
    let appearance = opts.sheetAppearance === 'light' ? 'light' : 'theme';
    let readOnly = opts.readOnly !== false;
    const overscan = opts.overscan || { rows: 6, cols: 3 };

    function el(tag, className) {
      const e = doc.createElement(tag);
      if (className) e.className = className;
      return e;
    }

    // ---- DOM skeleton
    const root = el('div', 'xg-root' + (appearance === 'light' ? ' xg-light' : ''));
    root.setAttribute('role', 'grid');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
    const scroller = el('div', 'xg-scroller');
    scroller.setAttribute('tabindex', '-1');
    const sizer = el('div', 'xg-sizer');
    const layerBody = el('div', 'xg-layer xg-body');
    const layerTop = el('div', 'xg-layer xg-sticky xg-top');
    const layerLeft = el('div', 'xg-layer xg-sticky xg-left');
    const layerCorner = el('div', 'xg-layer xg-sticky xg-corner');
    for (const l of [layerBody, layerTop, layerLeft, layerCorner]) l.setAttribute('role', 'presentation');
    sizer.appendChild(layerBody); sizer.appendChild(layerTop); sizer.appendChild(layerLeft); sizer.appendChild(layerCorner);
    scroller.appendChild(sizer);
    root.appendChild(scroller);
    container.appendChild(root);
    const layers = { body: layerBody, top: layerTop, left: layerLeft, corner: layerCorner };

    // ---- state
    let meta = null;
    let axes = null;
    let frozen = { rows: 0, cols: 0 };
    let mergeIndex = buildMergeIndex([], math);
    let hdrW = 48;
    let active = { r: 0, c: 0 };
    let focus = { r: 0, c: 0 };
    let styles = new Map();
    let cells = new Map();          // r * MAX_COLS + c -> XlsxCell
    const loaded = new Set();       // block keys with data
    const pending = new Map();      // requestId -> { blocks: string[], range }
    let nextRequestId = 1;
    let lastSig = '';
    let lastWin = null;
    let themeBg = null;
    let themeKey = null;
    let dragging = false;
    let destroyed = false;
    const nodes = new Map();        // "layer|r|c" -> element
    const rowEls = new Map();       // r (-1 header) -> element
    const pool = { body: [], top: [], left: [], corner: [], row: [] };
    const MAXC = math.MAX_COLS;

    const ck = (r, c) => r * MAXC + c;
    const cellAt = (r, c) => cells.get(ck(r, c));
    const blockKey = (br, bc) => br + ',' + bc;

    function viewport() {
      return { w: scroller.clientWidth || 0, h: scroller.clientHeight || 0 };
    }

    // ---------------------------------------------------------- meta

    function setMeta(m) {
      if (!m || !Number.isInteger(m.rowCount) || !Number.isInteger(m.colCount) || m.rowCount < 0 || m.colCount < 0) return false;
      const sameSheet = meta && meta.sheetId === m.sheetId;
      meta = m;
      const dh = m.defaultRowHeightPx > 0 ? m.defaultRowHeightPx : 20;
      const dw = m.defaultColWidthPx > 0 ? m.defaultColWidthPx : 64;
      axes = {
        rows: math.buildAxis(m.rowCount, dh, m.rowHeightsPx, m.hiddenRows),
        cols: math.buildAxis(m.colCount, dw, m.colWidthsPx, m.hiddenCols),
      };
      frozen = {
        rows: Math.min(toInt(m.frozenRows, 0), MAX_FROZEN_ROWS, m.rowCount),
        cols: Math.min(toInt(m.frozenCols, 0), MAX_FROZEN_COLS, m.colCount),
      };
      mergeIndex = buildMergeIndex(m.merges, math);
      hdrW = Math.max(40, String(m.rowCount).length * 9 + 18);
      root.setAttribute('aria-rowcount', String(m.rowCount + 1));
      root.setAttribute('aria-colcount', String(m.colCount + 1));
      sizer.style.width = (hdrW + axes.cols.total) + 'px';
      sizer.style.height = (HEADER_H + axes.rows.total) + 'px';
      // a new version/sheet supersedes everything in flight and everything fetched
      pending.clear();
      loaded.clear();
      if (!sameSheet) {
        cells = new Map();
        styles = new Map();
        scroller.scrollTop = 0; scroller.scrollLeft = 0;
        const r0 = Math.max(0, axes.rows.firstVisible()), c0 = Math.max(0, axes.cols.firstVisible());
        active = { r: r0, c: c0 }; focus = { r: r0, c: c0 };
      } else {
        active = clampPoint(active); focus = clampPoint(focus);
      }
      rect = growToMerges(active, focus);
      releaseAll();
      lastSig = '';
      render(true);
      emitSelection(true);
      return true;
    }

    function clampPoint(p) {
      const r = Math.min(Math.max(0, p.r), Math.max(0, meta.rowCount - 1));
      const c = Math.min(Math.max(0, p.c), Math.max(0, meta.colCount - 1));
      return { r, c };
    }

    // ---------------------------------------------------------- cell data

    function setCells(batch) {
      if (!meta || !batch) return false;
      const req = pending.get(batch.requestId);
      // superseded: unknown request (invalidated / new meta), other sheet, or other version
      if (!req || batch.sheetId !== meta.sheetId || batch.version !== meta.version) return false;
      pending.delete(batch.requestId);
      const rg = req.range;
      if (batch.styles && typeof batch.styles === 'object') {
        for (const k of Object.keys(batch.styles)) styles.set(Number(k), batch.styles[k]);
      }
      // replace the whole requested range: empty cells are never sent
      const area = (rg[2] - rg[0] + 1) * (rg[3] - rg[1] + 1);
      if (area <= cells.size) {
        for (let r = rg[0]; r <= rg[2]; r++) for (let c = rg[1]; c <= rg[3]; c++) cells.delete(ck(r, c));
      } else {
        for (const [k, v] of cells) if (v.r >= rg[0] && v.r <= rg[2] && v.c >= rg[1] && v.c <= rg[3]) cells.delete(k);
      }
      for (const x of batch.cells || []) {
        if (!x || !Number.isInteger(x.r) || !Number.isInteger(x.c)) continue;
        if (x.r < rg[0] || x.r > rg[2] || x.c < rg[1] || x.c > rg[3]) continue;
        cells.set(ck(x.r, x.c), x);
      }
      for (const b of req.blocks) loaded.add(b);
      if (cells.size > MAX_CACHED_CELLS) evict();
      lastSig = '';
      render(true);
      if (nodeFor(active.r, active.c)) emitActiveText();
      return true;
    }

    function evict() {
      if (!lastWin || !lastWin.rows || !lastWin.cols) return;
      const r0 = Math.floor(lastWin.rows[0] / BLOCK_ROWS) - 4, r1 = Math.floor(lastWin.rows[1] / BLOCK_ROWS) + 4;
      const c0 = Math.floor(lastWin.cols[0] / BLOCK_COLS) - 4, c1 = Math.floor(lastWin.cols[1] / BLOCK_COLS) + 4;
      for (const key of Array.from(loaded)) {
        const [br, bc] = key.split(',').map(Number);
        if (br >= r0 && br <= r1 && bc >= c0 && bc <= c1) continue;
        loaded.delete(key);
        for (let r = br * BLOCK_ROWS; r < (br + 1) * BLOCK_ROWS; r++) {
          for (let c = bc * BLOCK_COLS; c < (bc + 1) * BLOCK_COLS; c++) cells.delete(ck(r, c));
        }
      }
    }

    /** scope: 'cells' | 'sheet' | 'workbook' | { invalidate, range? }. */
    function invalidate(scope) {
      const kind = typeof scope === 'string' ? scope : scope && (scope.invalidate || scope.kind);
      const range = scope && typeof scope === 'object' ? scope.range : null;
      pending.clear();
      if (kind === 'sheet' || kind === 'workbook') {
        // meta is stale as well: the shell re-requests it and calls setMeta again
        loaded.clear(); cells = new Map(); styles = new Map();
        releaseAll();
        lastSig = '';
        return;
      }
      if (range && range.length === 4) {
        for (let br = Math.floor(range[0] / BLOCK_ROWS); br <= Math.floor(range[2] / BLOCK_ROWS); br++) {
          for (let bc = Math.floor(range[1] / BLOCK_COLS); bc <= Math.floor(range[3] / BLOCK_COLS); bc++) loaded.delete(blockKey(br, bc));
        }
      } else {
        loaded.clear();
      }
      // cells stay on screen (no flicker) until the refreshed blocks arrive
      lastSig = '';
      render(true);
    }

    // ---------------------------------------------------------- requests

    function requestMissing(win) {
      if (!win || pending.size >= MAX_IN_FLIGHT) return;
      const pendingBlocks = new Set();
      for (const p of pending.values()) for (const b of p.blocks) pendingBlocks.add(b);
      const missing = new Map(); // br -> sorted [bc]
      for (const rg of math.requestRanges(win, MAX_REQUEST_CELLS)) {
        for (let br = Math.floor(rg[0] / BLOCK_ROWS); br <= Math.floor(rg[2] / BLOCK_ROWS); br++) {
          for (let bc = Math.floor(rg[1] / BLOCK_COLS); bc <= Math.floor(rg[3] / BLOCK_COLS); bc++) {
            const k = blockKey(br, bc);
            if (loaded.has(k) || pendingBlocks.has(k)) continue;
            let a = missing.get(br);
            if (!a) { a = new Set(); missing.set(br, a); }
            a.add(bc);
          }
        }
      }
      if (!missing.size) return;
      // runs of adjacent columns per block row, then merge equal runs of adjacent block rows
      const runs = [];
      for (const br of Array.from(missing.keys()).sort((a, b) => a - b)) {
        const bcs = Array.from(missing.get(br)).sort((a, b) => a - b);
        let s = bcs[0], p = bcs[0];
        for (let i = 1; i <= bcs.length; i++) {
          if (i < bcs.length && bcs[i] === p + 1) { p = bcs[i]; continue; }
          const prev = runs.find((x) => x.br1 === br - 1 && x.bc0 === s && x.bc1 === p);
          if (prev && (prev.br1 - prev.br0 + 1) * BLOCK_ROWS * (p - s + 1) * BLOCK_COLS + BLOCK_ROWS * (p - s + 1) * BLOCK_COLS <= MAX_REQUEST_CELLS) prev.br1 = br;
          else runs.push({ br0: br, br1: br, bc0: s, bc1: p });
          s = bcs[i]; p = bcs[i];
        }
      }
      for (const run of runs) {
        if (pending.size >= MAX_IN_FLIGHT) break;
        const range = [
          run.br0 * BLOCK_ROWS, run.bc0 * BLOCK_COLS,
          Math.min(meta.rowCount - 1, (run.br1 + 1) * BLOCK_ROWS - 1),
          Math.min(meta.colCount - 1, (run.bc1 + 1) * BLOCK_COLS - 1),
        ];
        const blocks = [];
        for (let br = run.br0; br <= run.br1; br++) for (let bc = run.bc0; bc <= run.bc1; bc++) blocks.push(blockKey(br, bc));
        const requestId = nextRequestId++;
        pending.set(requestId, { blocks, range });
        cb.requestCells(range, requestId);
      }
    }

    // ---------------------------------------------------------- rendering

    function refreshTheme() {
      const body = doc.body;
      const key = body && body.className;
      if (key === themeKey && themeBg) return;
      themeKey = key;
      let rgb = null;
      try {
        if (global.getComputedStyle && body) {
          rgb = parseColor(global.getComputedStyle(body).getPropertyValue('--vscode-editor-background'));
        }
      } catch (e) { rgb = null; }
      if (!rgb) {
        const light = body && body.classList && (body.classList.contains('vscode-light') || body.classList.contains('vscode-high-contrast-light'));
        rgb = light ? [255, 255, 255] : [30, 30, 30];
      }
      themeBg = rgb;
    }

    function acquire(layer, className) {
      const p = pool[layer];
      const e = p.length ? p.pop() : el('div', className);
      return e;
    }

    function release(key, node) {
      nodes.delete(key);
      const parent = node.parentNode;
      if (parent) parent.removeChild(node);
      pool[node._layer].push(node);
    }

    function releaseAll() {
      for (const [k, n] of Array.from(nodes)) release(k, n);
      for (const [r, n] of Array.from(rowEls)) { if (n.parentNode) n.parentNode.removeChild(n); pool.row.push(n); rowEls.delete(r); }
    }

    function nodeFor(r, c) {
      return nodes.get('body|' + r + '|' + c) || nodes.get('left|' + r + '|' + c) ||
        nodes.get('top|' + r + '|' + c) || nodes.get('corner|' + r + '|' + c) || null;
    }

    function cellId(r, c) { return uid + '-' + r + '-' + c; }

    function render(force) {
      if (destroyed || !meta || !axes) return;
      refreshTheme();
      const vp = viewport();
      const win = math.visibleWindow(
        { x: scroller.scrollLeft || 0, y: scroller.scrollTop || 0 },
        { width: Math.max(0, vp.w - hdrW), height: Math.max(0, vp.h - HEADER_H) },
        axes, frozen, overscan);
      lastWin = win;
      const sig = [win.rows && win.rows.join(':'), win.cols && win.cols.join(':'), vp.w, vp.h].join('|');
      if (!force && sig === lastSig) return;
      lastSig = sig;

      const rowList = [-1];
      for (let r = 0; r < frozen.rows; r++) if (axes.rows.sizeOf(r) > 0) rowList.push(r);
      if (win.rows) for (let r = win.rows[0]; r <= win.rows[1]; r++) if (axes.rows.sizeOf(r) > 0) rowList.push(r);
      const colList = [-1];
      for (let c = 0; c < frozen.cols; c++) if (axes.cols.sizeOf(c) > 0) colList.push(c);
      if (win.cols) for (let c = win.cols[0]; c <= win.cols[1]; c++) if (axes.cols.sizeOf(c) > 0) colList.push(c);

      const sizerW = hdrW + axes.cols.total;
      const sel = selectionRect();

      // Pass 1: decide what is needed (no DOM work), so stale nodes can be recycled first.
      const plan = [];
      const used = new Set();
      for (const r of rowList) {
        const rowFrozen = r < frozen.rows; // header row (-1) counts as frozen
        const h = r < 0 ? HEADER_H : axes.rows.sizeOf(r);
        const y = r < 0 ? 0 : HEADER_H + axes.rows.offsetOf(r);
        const entry = { r, rowFrozen, h, y, specs: [] };
        plan.push(entry);
        for (const c of colList) {
          const colFrozen = c < frozen.cols;
          const layer = rowFrozen ? (colFrozen ? 'corner' : 'top') : (colFrozen ? 'left' : 'body');
          const w = c < 0 ? hdrW : axes.cols.sizeOf(c);
          const x = c < 0 ? 0 : hdrW + axes.cols.offsetOf(c);
          let cw = w, ch = h, showText = true, dataR = r, dataC = c;
          if (r >= 0 && c >= 0) {
            const m = mergeIndex.at(r, c);
            if (m) {
              // each layer draws its own piece of the merge, starting at the first rendered cell of the piece
              const rowStart = rowFrozen ? 0 : Math.max(frozen.rows, win.rows ? win.rows[0] : 0);
              const colStart = colFrozen ? 0 : Math.max(frozen.cols, win.cols ? win.cols[0] : 0);
              const pr0 = firstVisibleIdx(axes.rows, Math.max(m[0], rowStart));
              const pc0 = firstVisibleIdx(axes.cols, Math.max(m[1], colStart));
              if (r !== pr0 || c !== pc0) continue;
              const rEnd = rowFrozen ? Math.min(m[2], frozen.rows - 1) : m[2];
              const cEnd = colFrozen ? Math.min(m[3], frozen.cols - 1) : m[3];
              ch = axes.rows.offsetOf(rEnd + 1) - axes.rows.offsetOf(r);
              cw = axes.cols.offsetOf(cEnd + 1) - axes.cols.offsetOf(c);
              dataR = m[0]; dataC = m[1];
              showText = pieceHasAnchor(m, rowFrozen, colFrozen);
            }
          }
          const key = layer + '|' + r + '|' + c;
          used.add(key);
          entry.specs.push({ key, layer, r, c, x, cw, ch, dataR, dataC, showText });
        }
      }

      // Recycle everything no longer needed before creating anything new.
      for (const [k, n] of Array.from(nodes)) if (!used.has(k)) release(k, n);
      const usedRows = new Set(plan.map((e) => e.r));
      for (const [r, n] of Array.from(rowEls)) {
        if (!usedRows.has(r)) { if (n.parentNode) n.parentNode.removeChild(n); pool.row.push(n); rowEls.delete(r); }
      }

      // Pass 2: create/update.
      for (const e of plan) {
        const rowEl = ensureRow(e.r, e.rowFrozen, e.y, e.h, sizerW);
        const owned = [];
        for (const sp of e.specs) {
          let node = nodes.get(sp.key);
          const fresh = !node;
          if (!node) {
            node = acquire(sp.layer, 'xg-cell');
            node._layer = sp.layer;
            nodes.set(sp.key, node);
            if (sp.layer === 'body' || sp.layer === 'top') rowEl.appendChild(node);
            else layers[sp.layer].appendChild(node);
          }
          const inRow = sp.layer === 'body' || sp.layer === 'top';
          if (!inRow) owned.push(cellId(sp.r, sp.c));
          paintCell(node, sp.r, sp.c, sp.x, inRow ? 0 : e.y, sp.cw, sp.ch, sp.dataR, sp.dataC, sp.showText, fresh, sel);
        }
        const ownStr = owned.join(' ');
        if (owned.length) { if (rowEl._owns !== ownStr) { rowEl._owns = ownStr; rowEl.setAttribute('aria-owns', ownStr); } }
        else if (rowEl._owns) { rowEl._owns = ''; rowEl.setAttribute('aria-owns', ''); }
      }
      updateActiveDescendant();
      requestMissing(win);
    }

    function firstVisibleIdx(axis, i) {
      // first non-hidden index >= i
      return axis.isHidden(i) ? (axis.nextVisible(i, 1) < 0 ? i : axis.nextVisible(i, 1)) : i;
    }

    // Whether the piece (rowFrozen/colFrozen region) of merge m contains the anchor cell.
    function pieceHasAnchor(m, rowFrozen, colFrozen) {
      const rowOk = rowFrozen ? m[0] < frozen.rows : m[0] >= frozen.rows;
      const colOk = colFrozen ? m[1] < frozen.cols : m[1] >= frozen.cols;
      return rowOk && colOk;
    }

    function ensureRow(r, rowFrozen, y, h, w) {
      let rowEl = rowEls.get(r);
      if (!rowEl) {
        rowEl = pool.row.length ? pool.row.pop() : el('div', 'xg-row');
        rowEl.setAttribute('role', 'row');
        rowEl._owns = '';
        rowEl.setAttribute('aria-owns', '');
        rowEls.set(r, rowEl);
        (rowFrozen ? layerTop : layerBody).appendChild(rowEl);
      } else if (rowEl.parentNode !== (rowFrozen ? layerTop : layerBody)) {
        (rowFrozen ? layerTop : layerBody).appendChild(rowEl);
      }
      rowEl.setAttribute('aria-rowindex', String(r + 2));
      rowEl.style.top = y + 'px';
      rowEl.style.height = h + 'px';
      rowEl.style.width = w + 'px';
      return rowEl;
    }

    function inSel(sel, r, c) { return r >= sel[0] && r <= sel[2] && c >= sel[1] && c <= sel[3]; }

    function paintCell(node, r, c, x, y, w, h, dataR, dataC, showText, fresh, sel) {
      const geo = x + ',' + y + ',' + w + ',' + h;
      if (node._geo !== geo) {
        node._geo = geo;
        node.style.left = x + 'px'; node.style.top = y + 'px';
        node.style.width = w + 'px'; node.style.height = h + 'px';
      }
      const isHeader = r < 0 || c < 0;
      if (isHeader) { paintHeader(node, r, c, sel, fresh); return; }

      const cell = cellAt(dataR, dataC);
      const style = cell ? styles.get(cell.s) : undefined;
      const stateSig = (readOnly ? 'R' : 'W') + (showText ? 't' : 'b') + appearance + (themeKey || '');
      if (fresh || node._cell !== cell || node._style !== style || node._stateSig !== stateSig || node._hdr) {
        node._cell = cell; node._style = style; node._stateSig = stateSig; node._hdr = false;
        applyCellContent(node, r, c, cell, style, showText);
      }
      const selected = inSel(sel, r, c);
      const isActive = r === active.r && c === active.c;
      const flags = (selected ? 1 : 0) + (isActive ? 2 : 0);
      if (node._flags !== flags) {
        node._flags = flags;
        node.setAttribute('aria-selected', selected ? 'true' : 'false');
        node.className = node._baseClass + (selected ? ' xg-sel' : '') + (isActive ? ' xg-active' : '');
      }
    }

    function applyCellContent(node, r, c, cell, style, showText) {
      const st = style || {};
      node.setAttribute('role', 'gridcell');
      node.id = cellId(r, c);
      node.setAttribute('aria-rowindex', String(r + 2));
      node.setAttribute('aria-colindex', String(c + 2));
      const ro = readOnly || !!(showText && cell && cell.ro);
      node.setAttribute('aria-readonly', ro ? 'true' : 'false');
      const text = showText && cell && typeof cell.d === 'string' ? cell.d : '';
      if (node._text !== text) { node._text = text; node.textContent = text; }
      let cls = 'xg-cell';
      if (cell && showText) {
        if (cell.k === 'n' || cell.k === 'd') cls += ' xg-num';
        else if (cell.k === 'b' || cell.k === 'e') cls += ' xg-ctr';
        if (cell.stale) cls += ' xg-stale';
        if (cell.ro) cls += ' xg-ro';
        if (cell.link) cls += ' xg-link';
        if (cell.note) cls += ' xg-note';
        if (cell.k === 'e') cls += ' xg-err';
      }
      if (st.wrap) cls += ' xg-wrap';
      node._baseClass = cls;
      node._flags = -1; // force the selection pass to rewrite className
      if (showText && cell && cell.note) node.setAttribute('title', cell.note); else node.removeAttribute('title');
      const cs = node.style;
      const col = resolveColors(st, appearance, themeBg);
      cs.backgroundColor = col.bg || '';
      cs.color = cell || style ? col.color : '';
      cs.fontWeight = st.bold ? 'bold' : '';
      cs.fontStyle = st.italic || (showText && cell && cell.stale) ? 'italic' : '';
      let deco = '';
      if (st.underline || (showText && cell && cell.link)) deco += 'underline ';
      if (st.strike) deco += 'line-through';
      cs.textDecoration = deco.trim();
      cs.fontFamily = typeof st.fontFamily === 'string' && st.fontFamily.length < 200 ? st.fontFamily : '';
      cs.fontSize = st.fontSizePt > 0 && st.fontSizePt < 410 ? (st.fontSizePt * 96 / 72) + 'px' : '';
      // horizontal alignment: authored, else by type (numbers right, booleans/errors centre)
      let h = st.h;
      const justify = { left: 'flex-start', center: 'center', right: 'flex-end', justify: 'flex-start' };
      if (!h && cell) h = cell.k === 'n' || cell.k === 'd' ? 'right' : (cell.k === 'b' || cell.k === 'e' ? 'center' : 'left');
      cs.justifyContent = justify[h || 'left'] || 'flex-start';
      cs.textAlign = h && h !== 'justify' ? h : (h === 'justify' ? 'justify' : '');
      const va = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
      cs.alignItems = va[st.v || 'bottom'] || 'flex-end';
      const ind = st.indent > 0 && st.indent < 64 ? st.indent * INDENT_PX : 0;
      cs.paddingLeft = ind && (h === 'left' || !h) ? ind + 'px' : '';
      cs.paddingRight = ind && h === 'right' ? ind + 'px' : '';
      const b = st.border || {};
      cs.borderTop = typeof b.t === 'string' ? b.t : '';
      cs.borderRight = typeof b.r === 'string' ? b.r : '';
      cs.borderBottom = typeof b.b === 'string' ? b.b : '';
      cs.borderLeft = typeof b.l === 'string' ? b.l : '';
    }

    function paintHeader(node, r, c, sel, fresh) {
      const kind = r < 0 && c < 0 ? 'corner' : (r < 0 ? 'col' : 'row');
      const selected = kind === 'col' ? (c >= sel[1] && c <= sel[3]) : kind === 'row' ? (r >= sel[0] && r <= sel[2]) : false;
      const hid = kind === 'col' ? hiddenMarker(axes.cols, c) : kind === 'row' ? hiddenMarker(axes.rows, r) : '';
      const sig = kind + (selected ? 's' : '') + hid + (kind === 'row' ? hdrW : '');
      if (!fresh && node._hdr && node._hsig === sig && node._hc === c && node._hr === r) return;
      node._hdr = true; node._hsig = sig; node._hc = c; node._hr = r;
      node._cell = null; node._style = null; node._flags = -1;
      node.style.backgroundColor = ''; node.style.color = ''; node.style.fontWeight = ''; node.style.fontStyle = '';
      node.style.textDecoration = ''; node.style.borderTop = ''; node.style.borderRight = ''; node.style.borderBottom = ''; node.style.borderLeft = '';
      node.removeAttribute('title');
      let text = '';
      if (kind === 'col') { text = colLabel(c); node.setAttribute('role', 'columnheader'); node.setAttribute('aria-colindex', String(c + 2)); node.removeAttribute('aria-rowindex'); }
      else if (kind === 'row') { text = String(r + 1); node.setAttribute('role', 'rowheader'); node.setAttribute('aria-rowindex', String(r + 2)); node.removeAttribute('aria-colindex'); }
      else { text = ''; node.setAttribute('role', 'columnheader'); node.setAttribute('aria-label', 'Select all'); node.setAttribute('aria-colindex', '1'); }
      node.removeAttribute('aria-selected'); node.removeAttribute('aria-readonly');
      if (kind !== 'corner') node.removeAttribute('aria-label');
      node.id = uid + '-h' + kind + (kind === 'col' ? c : kind === 'row' ? r : '');
      if (node._text !== text) { node._text = text; node.textContent = text; }
      node.className = 'xg-cell xg-hdr xg-hdr-' + kind + (selected ? ' xg-hdr-sel' : '') + (hid ? ' ' + hid : '');
      node._baseClass = node.className;
    }

    // thin marker for hidden lines: after a visible line followed by hidden ones
    function hiddenMarker(axis, i) {
      if (i >= 0 && axis.isHidden(i + 1)) return 'xg-hid-after';
      if (i === axis.firstVisible() && i > 0) return 'xg-hid-before';
      return '';
    }

    // ---------------------------------------------------------- selection

    let rect = [0, 0, 0, 0];
    function selectionRect() { return rect; }

    function navMeta() {
      const vp = viewport();
      return {
        rowCount: meta.rowCount, colCount: meta.colCount,
        rowAxis: axes.rows, colAxis: axes.cols, merges: meta.merges,
        pageRows: Math.max(1, Math.floor(Math.max(0, vp.h - HEADER_H) / (axes.rows.defaultPx || 20)) - 1),
        pageCols: Math.max(1, Math.floor(Math.max(0, vp.w - hdrW) / (axes.cols.defaultPx || 64)) - 1),
      };
    }

    function isEmptyCell(r, c) {
      const x = cellAt(r, c);
      return !x || x.d === '' || x.d === undefined;
    }

    let lastEmit = '';
    function emitSelection(force) {
      if (!meta) return;
      const range = rect.slice();
      const sig = [active.r, active.c, range.join(':')].join('|');
      if (!force && sig === lastEmit) return;
      const activeChanged = !lastEmit || lastEmit.split('|').slice(0, 2).join('|') !== active.r + '|' + active.c;
      lastEmit = sig;
      const info = { active: { r: active.r, c: active.c }, focus: { r: focus.r, c: focus.c }, range };
      if (activeChanged || force) cb.activeChange({ r: active.r, c: active.c, cell: cellAt(active.r, active.c) || null });
      cb.selectionChange(info);
    }

    function emitActiveText() {
      const x = cellAt(active.r, active.c);
      let t = addrOf(active.r, active.c) + ', ' + (x && x.d ? x.d : 'empty');
      if (x && x.f) t += ', has formula';
      if (x && x.stale) t += ', not calculated';
      if (x && x.ro) t += ', locked';
      if (x && x.note) t += ', has comment';
      if (rect[0] !== rect[2] || rect[1] !== rect[3]) t += ', selected ' + rangeLabel(rect);
      cb.announce(t);
    }

    function updateActiveDescendant() {
      const n = nodeFor(active.r, active.c);
      if (n && n.id) root.setAttribute('aria-activedescendant', n.id);
      else root.removeAttribute('aria-activedescendant');
    }

    function refreshSelectionClasses() {
      lastSig = '';
      render(true);
    }

    function applySelection(a, f, rr, announce, noScroll) {
      const prevActive = active;
      active = a; focus = f; rect = rr;
      if (!noScroll) ensureVisible(f.r === a.r && f.c === a.c ? a : f);
      refreshSelectionClasses();
      emitSelection(false);
      if (announce !== false && (prevActive.r !== a.r || prevActive.c !== a.c || rr[0] !== rr[2] || rr[1] !== rr[3])) emitActiveText();
    }

    function setActive(r, c) {
      if (!meta || !Number.isInteger(r) || !Number.isInteger(c)) return;
      let p = clampPoint({ r, c });
      const m = mergeIndex.at(p.r, p.c);
      if (m) p = { r: m[0], c: m[1] };
      applySelection(p, p, [p.r, p.c, p.r, p.c]);
    }

    function setSelection(r0, c0, r1, c1) {
      if (!meta) return;
      const a = clampPoint({ r: r0, c: c0 }), f = clampPoint({ r: r1, c: c1 });
      applySelection(a, f, growToMerges(a, f));
    }

    function growToMerges(a, f) {
      let r0 = Math.min(a.r, f.r), r1 = Math.max(a.r, f.r), c0 = Math.min(a.c, f.c), c1 = Math.max(a.c, f.c);
      for (const m of meta.merges || []) {
        if (m[0] <= r1 && m[2] >= r0 && m[1] <= c1 && m[3] >= c0) {
          r0 = Math.min(r0, m[0]); r1 = Math.max(r1, m[2]); c0 = Math.min(c0, m[1]); c1 = Math.max(c1, m[3]);
        }
      }
      return [r0, c0, r1, c1];
    }

    // scroll so cell (r,c) is fully inside the unfrozen viewport (frozen cells never scroll)
    function ensureVisible(p) {
      if (!meta || !axes) return;
      const vp = viewport();
      const m = mergeIndex.at(p.r, p.c);
      const r = m ? m[0] : p.r, c = m ? m[1] : p.c;
      if (r >= frozen.rows) {
        const base = axes.rows.offsetOf(frozen.rows);
        const top = axes.rows.offsetOf(r) - base;
        const hgt = axes.rows.sizeOf(r);
        const visH = Math.max(0, vp.h - HEADER_H - base);
        const st = scroller.scrollTop || 0;
        if (top < st) scroller.scrollTop = top;
        else if (top + hgt > st + visH) scroller.scrollTop = Math.max(0, top + hgt - visH);
      }
      if (c >= frozen.cols) {
        const base = axes.cols.offsetOf(frozen.cols);
        const left = axes.cols.offsetOf(c) - base;
        const wid = axes.cols.sizeOf(c);
        const visW = Math.max(0, vp.w - hdrW - base);
        const sl = scroller.scrollLeft || 0;
        if (left < sl) scroller.scrollLeft = left;
        else if (left + wid > sl + visW) scroller.scrollLeft = Math.max(0, left + wid - visW);
      }
    }

    // ---------------------------------------------------------- input

    function pointToTarget(clientX, clientY) {
      const rc = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { left: 0, top: 0 };
      const x = clientX - rc.left, y = clientY - rc.top;
      const vp = viewport();
      if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) return null; // outside (scrollbar)
      const fw = axes.cols.offsetOf(frozen.cols), fh = axes.rows.offsetOf(frozen.rows);
      let col = null, row = null;
      if (x >= hdrW) {
        const off = x - hdrW;
        col = axes.cols.indexAt(off < fw ? off : off + (scroller.scrollLeft || 0));
      }
      if (y >= HEADER_H) {
        const off = y - HEADER_H;
        row = axes.rows.indexAt(off < fh ? off : off + (scroller.scrollTop || 0));
      }
      return { r: row, c: col };
    }

    function pointFromEvent(ev, clampInside) {
      let cx = ev.clientX, cy = ev.clientY;
      if (clampInside && scroller.getBoundingClientRect) {
        const rc = scroller.getBoundingClientRect();
        const vp = viewport();
        cx = Math.min(Math.max(cx, rc.left + hdrW), rc.left + vp.w - 1);
        cy = Math.min(Math.max(cy, rc.top + HEADER_H), rc.top + vp.h - 1);
      }
      return pointToTarget(cx, cy);
    }

    function lastColVisible() { return Math.max(0, axes.cols.lastVisible()); }
    function lastRowVisible() { return Math.max(0, axes.rows.lastVisible()); }

    function onMouseDown(ev) {
      if (!meta || ev.button > 0) return;
      const t = pointToTarget(ev.clientX, ev.clientY);
      if (!t) return;
      if (root.focus) root.focus();
      if (ev.ctrlKey || ev.metaKey) {
        if (t.r !== null && t.c !== null) cb.cellClick({ r: t.r, c: t.c, cell: cellAt(t.r, t.c) || null, ctrlKey: true });
        return;
      }
      if (ev.preventDefault) ev.preventDefault();
      if (t.r === null && t.c === null) { // corner: select all
        applySelection({ r: firstR(), c: firstC() }, { r: lastRowVisible(), c: lastColVisible() }, [0, 0, meta.rowCount - 1, meta.colCount - 1], true, true);
        return;
      }
      if (t.r === null) { // column header
        const ac = ev.shiftKey ? active.c : t.c;
        const a = { r: ev.shiftKey ? active.r : firstR(), c: ac };
        applySelection(a, { r: lastRowVisible(), c: t.c }, growToMerges({ r: 0, c: ac }, { r: meta.rowCount - 1, c: t.c }), true, true);
        dragging = 'col';
        return;
      }
      if (t.c === null) { // row header
        const ar = ev.shiftKey ? active.r : t.r;
        const a = { r: ar, c: ev.shiftKey ? active.c : firstC() };
        applySelection(a, { r: t.r, c: lastColVisible() }, growToMerges({ r: ar, c: 0 }, { r: t.r, c: meta.colCount - 1 }), true, true);
        dragging = 'row';
        return;
      }
      if (ev.shiftKey) {
        applySelection(active, { r: t.r, c: t.c }, growToMerges(active, { r: t.r, c: t.c }));
      } else {
        let p = { r: t.r, c: t.c };
        const m = mergeIndex.at(p.r, p.c);
        if (m) p = { r: m[0], c: m[1] };
        applySelection(p, p, growToMerges(p, p));
        cb.cellClick({ r: t.r, c: t.c, cell: cellAt(t.r, t.c) || null, ctrlKey: false });
      }
      dragging = 'cell';
    }
    function firstR() { return Math.max(0, axes.rows.firstVisible()); }
    function firstC() { return Math.max(0, axes.cols.firstVisible()); }

    function onMouseMove(ev) {
      if (!dragging || !meta) return;
      const t = pointFromEvent(ev, true);
      if (!t || t.r === null || t.c === null) return;
      if (dragging === 'cell') applySelection(active, { r: t.r, c: t.c }, growToMerges(active, { r: t.r, c: t.c }), false);
      else if (dragging === 'col') applySelection(active, { r: lastRowVisible(), c: t.c }, growToMerges(active, { r: meta.rowCount - 1, c: t.c }), false, true);
      else applySelection(active, { r: t.r, c: lastColVisible() }, growToMerges(active, { r: t.r, c: meta.colCount - 1 }), false, true);
    }
    function onMouseUp() { if (dragging) { dragging = false; emitActiveText(); } }

    function onDblClick(ev) {
      if (!meta) return;
      const t = pointToTarget(ev.clientX, ev.clientY);
      if (!t || t.r === null || t.c === null) return;
      cb.editGesture({ kind: 'dblclick', r: active.r, c: active.c });
    }

    function onContextMenu(ev) {
      if (!meta) return;
      const t = pointToTarget(ev.clientX, ev.clientY);
      if (!t) return;
      if (ev.preventDefault) ev.preventDefault();
      const target = t.r === null && t.c === null ? 'corner' : t.r === null ? 'colHeader' : t.c === null ? 'rowHeader' : 'cell';
      if (target === 'cell' && !inSel(rect, t.r, t.c)) setActive(t.r, t.c);
      cb.contextMenu({ source: 'mouse', target, r: t.r, c: t.c, x: ev.clientX, y: ev.clientY });
    }

    function activeClientPoint() {
      const n = nodeFor(active.r, active.c);
      const rc = n && n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      return rc ? { x: rc.left, y: rc.bottom } : { x: 0, y: 0 };
    }

    function onKeyDown(ev) {
      if (!meta) return;
      const key = ev.key;
      const mods = { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey, alt: ev.altKey };
      const ctrl = ev.ctrlKey || ev.metaKey;
      const stop = () => { if (ev.preventDefault) ev.preventDefault(); };

      if ((key === 'F10' && ev.shiftKey) || key === 'ContextMenu') {
        stop();
        const p = activeClientPoint();
        cb.contextMenu({ source: 'keyboard', target: 'cell', r: active.r, c: active.c, x: p.x, y: p.y });
        return;
      }
      // Ctrl+PageUp/PageDown belong to the shell (sheet switching); Ctrl+C/V/X etc. are not ours.
      if (ctrl && (key === 'PageUp' || key === 'PageDown')) return;
      if (key === 'F2') {
        if (cb.editGesture({ kind: 'f2', r: active.r, c: active.c }) === true) stop();
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
        if (cb.editGesture({ kind: 'delete', r: active.r, c: active.c, range: rect.slice() }) === true) stop();
        return;
      }
      if (key === 'Enter' && !ev.shiftKey && !ctrl && !ev.altKey) {
        if (cb.editGesture({ kind: 'enter', r: active.r, c: active.c }) === true) { stop(); return; }
      }
      if (key && key.length === 1 && !ctrl && !ev.altKey) {
        if (cb.editGesture({ kind: 'type', text: key, r: active.r, c: active.c }) === true) stop();
        return;
      }
      if (ctrl && (key === 'c' || key === 'C' || key === 'v' || key === 'V' || key === 'x' || key === 'X' || key === 'z' || key === 'Z' || key === 'y' || key === 'Y' || key === 'f' || key === 'F' || key === 's' || key === 'S' || key === 'e' || key === 'E')) return;

      const res = math.moveActive({ active, focus }, key, mods, navMeta(), isEmptyCell);
      if (!res) return;
      stop();
      applySelection(res.active, res.focus, res.selection);
    }

    function onScroll() { render(false); }

    root.addEventListener('keydown', onKeyDown);
    scroller.addEventListener('scroll', onScroll);
    scroller.addEventListener('mousedown', onMouseDown);
    scroller.addEventListener('dblclick', onDblClick);
    scroller.addEventListener('contextmenu', onContextMenu);
    const docTarget = doc;
    docTarget.addEventListener && docTarget.addEventListener('mousemove', onMouseMove);
    docTarget.addEventListener && docTarget.addEventListener('mouseup', onMouseUp);
    let ro = null;
    if (typeof global.ResizeObserver === 'function') {
      ro = new global.ResizeObserver(() => { lastSig = ''; render(true); });
      ro.observe(scroller);
    }

    // ---------------------------------------------------------- public API

    function getSelection() {
      return { active: { r: active.r, c: active.c }, focus: { r: focus.r, c: focus.c }, range: rect.slice() };
    }

    /** Loaded cells inside `range` (default: the selection), as an array. Unloaded cells are absent. */
    function getCells(range) {
      const rg = range || rect;
      const out = [];
      const area = (rg[2] - rg[0] + 1) * (rg[3] - rg[1] + 1);
      if (area <= cells.size) {
        for (let r = rg[0]; r <= rg[2]; r++) for (let c = rg[1]; c <= rg[3]; c++) {
          const x = cells.get(ck(r, c));
          if (x) out.push(x);
        }
      } else {
        for (const x of cells.values()) if (x.r >= rg[0] && x.r <= rg[2] && x.c >= rg[1] && x.c <= rg[3]) out.push(x);
      }
      return out;
    }

    function destroy() {
      destroyed = true;
      scroller.removeEventListener && scroller.removeEventListener('scroll', onScroll);
      docTarget.removeEventListener && docTarget.removeEventListener('mousemove', onMouseMove);
      docTarget.removeEventListener && docTarget.removeEventListener('mouseup', onMouseUp);
      if (ro) ro.disconnect();
      if (root.parentNode) root.parentNode.removeChild(root);
      nodes.clear(); rowEls.clear(); cells = new Map(); loaded.clear(); pending.clear();
    }

    return {
      setMeta, setCells, invalidate, getSelection, setActive, setSelection, getCells,
      getCell: (r, c) => cellAt(r, c) || null,
      /** The rendered element of a cell (null while it is outside the rendered window); for overlays. */
      cellElement: (r, c) => nodeFor(r, c),
      focus() { if (root.focus) root.focus(); },
      destroy,
      setReadOnly(v) { readOnly = !!v; root.setAttribute('aria-readonly', readOnly ? 'true' : 'false'); lastSig = ''; render(true); },
      setSheetAppearance(v) {
        appearance = v === 'light' ? 'light' : 'theme';
        root.className = 'xg-root' + (appearance === 'light' ? ' xg-light' : '');
        lastSig = ''; render(true);
      },
      refreshTheme() { themeKey = null; themeBg = null; lastSig = ''; render(true); },
      getScroll: () => ({ x: scroller.scrollLeft || 0, y: scroller.scrollTop || 0 }),
      setScroll(x, y) { scroller.scrollLeft = x || 0; scroller.scrollTop = y || 0; render(false); },
      resize() { lastSig = ''; render(true); },
      rootElement: root,
      scrollerElement: scroller,
    };
  }

  const api = { create, colLabel, addrOf, parseColor, contrastRatio, contrastColor, resolveColors, BLOCK_ROWS, BLOCK_COLS };
  global.XlsxGrid = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
