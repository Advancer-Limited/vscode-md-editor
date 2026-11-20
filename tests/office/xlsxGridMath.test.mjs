// Tests for the Excel grid maths (media/xlsxGridMath.js): pure functions, loaded via
// createRequire exactly as the webview's UMD script is (mirrors gltfViewerMath.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../../media/xlsxGridMath.js');
const { buildAxis, visibleWindow, requestRanges, mergeAt, moveActive, selectionStats, toTsv } = M;

const MAX_ROWS = 1048576, MAX_COLS = 16384;

function brute(count, def, overrides, hidden) {
  const ov = new Map(overrides), hid = new Set(hidden);
  const off = [0];
  for (let i = 0; i < count; i++) off.push(off[i] + (hid.has(i) ? 0 : ov.has(i) ? ov.get(i) : def));
  return off;
}

// ---------------------------------------------------------------- buildAxis

test('buildAxis: uniform axis', () => {
  const a = buildAxis(100, 20);
  assert.strictEqual(a.total, 2000);
  assert.strictEqual(a.offsetOf(0), 0);
  assert.strictEqual(a.offsetOf(5), 100);
  assert.strictEqual(a.offsetOf(100), 2000);
  assert.strictEqual(a.indexAt(0), 0);
  assert.strictEqual(a.indexAt(19.9), 0);
  assert.strictEqual(a.indexAt(20), 1);
  assert.strictEqual(a.indexAt(1999), 99);
  assert.strictEqual(a.indexAt(5000), 99, 'clamps past the end');
  assert.strictEqual(a.indexAt(-5), 0, 'clamps before the start');
});

test('buildAxis: overrides and hidden lines match a brute-force prefix sum', () => {
  const overrides = [[2, 50], [3, 5], [10, 100], [40, 0.5], [3, 7]];
  const hidden = [0, 1, 5, 6, 7, 20, 49, 48];
  const a = buildAxis(50, 20, overrides, hidden);
  const off = brute(50, 20, overrides, hidden);
  for (let i = 0; i <= 50; i++) assert.strictEqual(a.offsetOf(i), off[i], 'offset ' + i);
  assert.strictEqual(a.total, off[50]);
  for (let px = 0; px < off[50]; px += 3) {
    const i = a.indexAt(px);
    assert.ok(off[i] <= px && px < off[i + 1], `px ${px} -> ${i}`);
    assert.ok(!a.isHidden(i));
  }
});

test('buildAxis: hidden lines have size 0, are skipped by indexAt and nextVisible', () => {
  const a = buildAxis(10, 10, [], [0, 1, 4, 5, 6, 9]);
  assert.strictEqual(a.sizeOf(4), 0);
  assert.strictEqual(a.sizeOf(2), 10);
  assert.strictEqual(a.isHidden(5), true);
  assert.strictEqual(a.firstVisible(), 2);
  assert.strictEqual(a.lastVisible(), 8);
  assert.strictEqual(a.indexAt(0), 2);
  assert.strictEqual(a.indexAt(15), 3);
  assert.strictEqual(a.indexAt(20), 7, 'jumps over the hidden run 4-6');
  assert.strictEqual(a.nextVisible(3, 1), 7);
  assert.strictEqual(a.nextVisible(7, -1), 3);
  assert.strictEqual(a.nextVisible(8, 1), -1);
  assert.strictEqual(a.nextVisible(2, -1), -1);
});

test('buildAxis: zero override counts as hidden; hidden beats override; bad input ignored', () => {
  const a = buildAxis(5, 10, [[1, 0], [2, 99], [9, 5], [-1, 5], [3, NaN]], [2]);
  assert.strictEqual(a.isHidden(1), true);
  assert.strictEqual(a.isHidden(2), true);
  assert.strictEqual(a.total, 30);
  assert.throws(() => buildAxis(-1, 10), RangeError);
  assert.throws(() => buildAxis(5, 0), RangeError);
  const e = buildAxis(0, 10);
  assert.strictEqual(e.indexAt(5), -1);
  assert.strictEqual(buildAxis(3, 10, [], [0, 1, 2]).indexAt(5), -1);
});

test('buildAxis: full-size sheet (1,048,576 rows / 16,384 cols) is O(k) to build and O(log) to query', () => {
  const ov = [], hid = [];
  for (let i = 0; i < 20000; i++) ov.push([i * 50, 30]);
  for (let i = 0; i < 5000; i++) hid.push(1000 + i * 7);
  const rows = buildAxis(MAX_ROWS, 20, ov, hid);
  const cols = buildAxis(MAX_COLS, 64, [[0, 200], [16383, 300]], [5, 6, 7]);
  assert.strictEqual(rows.offsetOf(MAX_ROWS), rows.total);
  assert.strictEqual(cols.total, 16384 * 64 - 3 * 64 + 136 + 236);
  const last = rows.indexAt(rows.total - 1);
  assert.strictEqual(last, rows.lastVisible());
  // round-trip a spread of indices
  for (const i of [0, 1, 999, 1234, 500000, 1048575]) {
    if (rows.isHidden(i)) continue;
    assert.strictEqual(rows.indexAt(rows.offsetOf(i)), i);
  }
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let k = 0; k < 100000; k++) {
    sink += rows.indexAt((k * 7919) % rows.total) + cols.indexAt((k * 104729) % cols.total);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(sink > 0);
  assert.ok(ms < 3000, `200k indexAt calls took ${ms} ms`);
});

// ------------------------------------------------------------- visibleWindow

test('visibleWindow: simple scroll with overscan', () => {
  const axes = { rows: buildAxis(1000, 20), cols: buildAxis(50, 100) };
  const w = visibleWindow({ x: 0, y: 0 }, { width: 500, height: 200 }, axes, { rows: 0, cols: 0 }, 2);
  assert.strictEqual(w.firstRow, 0);
  assert.strictEqual(w.lastRow, 9);
  assert.deepStrictEqual(w.rows, [0, 11]);
  assert.strictEqual(w.firstCol, 0);
  assert.strictEqual(w.lastCol, 4);
  assert.deepStrictEqual(w.cols, [0, 6]);
  const s = visibleWindow({ x: 1000, y: 410 }, { width: 500, height: 200 }, axes, { rows: 0, cols: 0 }, 0);
  assert.strictEqual(s.firstRow, 20);
  assert.strictEqual(s.lastRow, 30);
  assert.strictEqual(s.firstCol, 10);
  assert.deepStrictEqual(s.rows, [20, 30]);
});

test('visibleWindow: frozen panes shrink the scrollable area and report frozen sizes', () => {
  const axes = { rows: buildAxis(1000, 20), cols: buildAxis(50, 100) };
  const w = visibleWindow({ x: 0, y: 0 }, { width: 500, height: 200 }, axes, { rows: 2, cols: 1 }, 0);
  assert.strictEqual(w.frozenHeight, 40);
  assert.strictEqual(w.frozenWidth, 100);
  assert.strictEqual(w.firstRow, 2);
  assert.strictEqual(w.lastRow, 9, '8 scrollable rows fit in 160 px');
  assert.strictEqual(w.firstCol, 1);
  assert.strictEqual(w.lastCol, 4);
  const s = visibleWindow({ x: 0, y: 100 }, { width: 500, height: 200 }, axes, { rows: 2, cols: 1 }, 0);
  assert.strictEqual(s.firstRow, 7, 'scroll is relative to the first non-frozen row');
});

test('visibleWindow: hidden rows are skipped; scroll and frozen are clamped', () => {
  const axes = { rows: buildAxis(100, 20, [], [10, 11, 12]), cols: buildAxis(10, 50) };
  const w = visibleWindow({ x: 0, y: 190 }, { width: 100, height: 40 }, axes, { rows: 0, cols: 0 }, 0);
  assert.strictEqual(w.firstRow, 9);
  assert.strictEqual(w.lastRow, 14, 'rows 10-12 are 0 px: 13 and 14 fill the remaining 40 px');
  const c = visibleWindow({ x: 1e9, y: 1e9 }, { width: 100, height: 40 }, axes, { rows: 500, cols: 500 }, 0);
  assert.strictEqual(c.frozenRows, 100);
  assert.strictEqual(c.rows, null, 'everything frozen: nothing scrolls');
  const d = visibleWindow({ x: 1e9, y: 1e9 }, { width: 100, height: 40 }, axes, { rows: 0, cols: 0 }, 0);
  assert.strictEqual(d.lastRow, 99);
});

test('visibleWindow: full-size sheet scrolls in O(log) per call', () => {
  const ov = [];
  for (let i = 0; i < 20000; i++) ov.push([i * 50, 30]);
  const axes = { rows: buildAxis(MAX_ROWS, 20, ov, [100, 101]), cols: buildAxis(MAX_COLS, 64) };
  const end = visibleWindow({ x: 1e12, y: 1e12 }, { width: 1200, height: 800 }, axes, { rows: 3, cols: 2 }, 5);
  assert.strictEqual(end.lastRow, MAX_ROWS - 1);
  assert.strictEqual(end.lastCol, MAX_COLS - 1);
  assert.ok(end.rows[1] <= MAX_ROWS - 1 && end.cols[1] <= MAX_COLS - 1);
  assert.ok(end.rows[1] - end.rows[0] < 200, 'window size is bounded by the viewport');
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20000; k++) {
    visibleWindow({ x: k * 311, y: k * 40000 }, { width: 1200, height: 800 }, axes, { rows: 3, cols: 2 }, 5);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 3000, `20k windows took ${ms} ms`);
});

// ------------------------------------------------------------- requestRanges

test('requestRanges: frozen corner/strips and body, covering the window exactly', () => {
  const axes = { rows: buildAxis(1000, 20), cols: buildAxis(50, 100) };
  const w = visibleWindow({ x: 500, y: 1000 }, { width: 600, height: 300 }, axes, { rows: 1, cols: 2 }, 1);
  const rs = requestRanges(w);
  assert.deepStrictEqual(rs[0], [0, 0, 0, 1], 'corner');
  assert.deepStrictEqual(rs[1], [0, w.cols[0], 0, w.cols[1]], 'top strip');
  assert.deepStrictEqual(rs[2], [w.rows[0], 0, w.rows[1], 1], 'left strip');
  assert.deepStrictEqual(rs[3], [w.rows[0], w.cols[0], w.rows[1], w.cols[1]], 'body');
  assert.strictEqual(requestRanges(visibleWindow({ x: 0, y: 0 }, { width: 600, height: 300 }, axes, { rows: 0, cols: 0 }, 0)).length, 1);
});

test('requestRanges: no range exceeds the 20,000-cell cap and the bands tile the area', () => {
  const win = { frozenRows: 0, frozenCols: 0, rows: [100, 1099], cols: [10, 59] }; // 50,000 cells
  const rs = requestRanges(win);
  assert.ok(rs.length >= 3);
  let total = 0, expectedR = 100;
  for (const [r0, c0, r1, c1] of rs) {
    const n = (r1 - r0 + 1) * (c1 - c0 + 1);
    assert.ok(n <= 20000, `range of ${n} cells`);
    assert.strictEqual(r0, expectedR, 'contiguous bands');
    assert.strictEqual(c0, 10);
    assert.strictEqual(c1, 59);
    expectedR = r1 + 1;
    total += n;
  }
  assert.strictEqual(total, 50000);
  assert.strictEqual(expectedR, 1100);
  for (const [r0, c0, r1, c1] of requestRanges(win, 100)) assert.ok((r1 - r0 + 1) * (c1 - c0 + 1) <= 100);
});

test('requestRanges: a single row wider than the cap is split by columns', () => {
  const rs = requestRanges({ frozenRows: 0, frozenCols: 0, rows: [0, 1], cols: [0, 24999] }, 10000);
  for (const [r0, c0, r1, c1] of rs) assert.ok((r1 - r0 + 1) * (c1 - c0 + 1) <= 10000);
  assert.strictEqual(rs.reduce((n, [r0, c0, r1, c1]) => n + (r1 - r0 + 1) * (c1 - c0 + 1), 0), 50000);
});

test('requestRanges: a realistic full-size viewport stays within the cap', () => {
  const axes = { rows: buildAxis(MAX_ROWS, 20), cols: buildAxis(MAX_COLS, 64) };
  const w = visibleWindow({ x: 400000, y: 9000000 }, { width: 3840, height: 2160 }, axes, { rows: 5, cols: 3 }, 10);
  const rs = requestRanges(w, 20000);
  for (const [r0, c0, r1, c1] of rs) {
    assert.ok(r1 < MAX_ROWS && c1 < MAX_COLS && r0 >= 0 && c0 >= 0);
    assert.ok((r1 - r0 + 1) * (c1 - c0 + 1) <= 20000);
  }
});

// ------------------------------------------------------------------ mergeAt

test('mergeAt: finds the containing merge or null', () => {
  const merges = [[0, 0, 1, 2], [5, 5, 5, 8]];
  assert.deepStrictEqual(mergeAt(merges, 1, 2), [0, 0, 1, 2]);
  assert.deepStrictEqual(mergeAt(merges, 0, 0), [0, 0, 1, 2]);
  assert.deepStrictEqual(mergeAt(merges, 5, 7), [5, 5, 5, 8]);
  assert.strictEqual(mergeAt(merges, 2, 0), null);
  assert.strictEqual(mergeAt(merges, 5, 9), null);
  assert.strictEqual(mergeAt([], 0, 0), null);
  assert.strictEqual(mergeAt(undefined, 0, 0), null);
});

// --------------------------------------------------------------- moveActive

const st = (r, c) => ({ active: { r, c } });
const noMods = {};

test('moveActive: arrows move one cell and clamp at the edges', () => {
  const meta = { rowCount: 10, colCount: 5 };
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowDown', noMods, meta).active, { r: 4, c: 2 });
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowUp', noMods, meta).active, { r: 2, c: 2 });
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowLeft', noMods, meta).active, { r: 3, c: 1 });
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowRight', noMods, meta).active, { r: 3, c: 3 });
  assert.deepStrictEqual(moveActive(st(0, 0), 'ArrowUp', noMods, meta).active, { r: 0, c: 0 });
  assert.deepStrictEqual(moveActive(st(9, 4), 'ArrowDown', noMods, meta).active, { r: 9, c: 4 });
  assert.deepStrictEqual(moveActive(st(9, 4), 'ArrowRight', noMods, meta).active, { r: 9, c: 4 });
  assert.strictEqual(moveActive(st(0, 0), 'x', noMods, meta), null);
});

test('moveActive: Tab / Enter and their Shift variants', () => {
  const meta = { rowCount: 10, colCount: 5 };
  assert.deepStrictEqual(moveActive(st(1, 1), 'Tab', noMods, meta).active, { r: 1, c: 2 });
  assert.deepStrictEqual(moveActive(st(1, 1), 'Tab', { shift: true }, meta).active, { r: 1, c: 0 });
  assert.deepStrictEqual(moveActive(st(1, 1), 'Enter', noMods, meta).active, { r: 2, c: 1 });
  const up = moveActive(st(1, 1), 'Enter', { shift: true }, meta);
  assert.deepStrictEqual(up.active, { r: 0, c: 1 });
  assert.deepStrictEqual(up.selection, [0, 1, 0, 1], 'Shift+Enter moves, it does not extend');
});

test('moveActive: hidden rows and columns are skipped', () => {
  const meta = {
    rowCount: 10, colCount: 10,
    rowAxis: buildAxis(10, 20, [], [4, 5, 6]), colAxis: buildAxis(10, 50, [], [0, 1]),
  };
  assert.deepStrictEqual(moveActive(st(3, 5), 'ArrowDown', noMods, meta).active, { r: 7, c: 5 });
  assert.deepStrictEqual(moveActive(st(7, 5), 'ArrowUp', noMods, meta).active, { r: 3, c: 5 });
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowLeft', noMods, meta).active, { r: 3, c: 2 }, 'cols 0-1 hidden: stays');
  assert.deepStrictEqual(moveActive(st(3, 5), 'Home', noMods, meta).active, { r: 3, c: 2 });
  assert.deepStrictEqual(moveActive(st(3, 5), 'Home', { ctrl: true }, meta).active, { r: 0, c: 2 });
});

test('moveActive: Home / End / Ctrl+Home / Ctrl+End', () => {
  const meta = { rowCount: 100, colCount: 20 };
  assert.deepStrictEqual(moveActive(st(5, 7), 'Home', noMods, meta).active, { r: 5, c: 0 });
  assert.deepStrictEqual(moveActive(st(5, 7), 'End', noMods, meta).active, { r: 5, c: 19 });
  assert.deepStrictEqual(moveActive(st(5, 7), 'Home', { ctrl: true }, meta).active, { r: 0, c: 0 });
  assert.deepStrictEqual(moveActive(st(5, 7), 'End', { ctrl: true }, meta).active, { r: 99, c: 19 });
  assert.deepStrictEqual(moveActive(st(5, 7), 'End', { meta: true }, meta).active, { r: 99, c: 19 }, 'Cmd counts as Ctrl');
});

test('moveActive: Ctrl+arrow jumps to data edges like Excel', () => {
  // data in rows 2-4 and 8-9 of column 0
  const filled = new Set([2, 3, 4, 8, 9]);
  const isEmpty = (r, c) => !(c === 0 && filled.has(r));
  const meta = { rowCount: 20, colCount: 3 };
  const ctrl = { ctrl: true };
  assert.deepStrictEqual(moveActive(st(2, 0), 'ArrowDown', ctrl, meta, isEmpty).active, { r: 4, c: 0 }, 'end of run');
  assert.deepStrictEqual(moveActive(st(4, 0), 'ArrowDown', ctrl, meta, isEmpty).active, { r: 8, c: 0 }, 'next run start');
  assert.deepStrictEqual(moveActive(st(9, 0), 'ArrowDown', ctrl, meta, isEmpty).active, { r: 19, c: 0 }, 'sheet edge');
  assert.deepStrictEqual(moveActive(st(0, 0), 'ArrowDown', ctrl, meta, isEmpty).active, { r: 2, c: 0 }, 'from empty to data');
  assert.deepStrictEqual(moveActive(st(9, 0), 'ArrowUp', ctrl, meta, isEmpty).active, { r: 8, c: 0 });
  assert.deepStrictEqual(moveActive(st(8, 0), 'ArrowUp', ctrl, meta, isEmpty).active, { r: 4, c: 0 });
  assert.deepStrictEqual(moveActive(st(2, 0), 'ArrowUp', ctrl, meta, isEmpty).active, { r: 0, c: 0 });
  assert.deepStrictEqual(moveActive(st(3, 0), 'ArrowRight', ctrl, meta, isEmpty).active, { r: 3, c: 2 });
  assert.deepStrictEqual(moveActive(st(3, 2), 'ArrowLeft', ctrl, meta, isEmpty).active, { r: 3, c: 0 });
});

test('moveActive: Ctrl+arrow skips hidden rows inside a data run', () => {
  const meta = { rowCount: 20, colCount: 1, rowAxis: buildAxis(20, 20, [], [3]) };
  const isEmpty = (r) => !(r >= 1 && r <= 6);
  assert.deepStrictEqual(moveActive(st(1, 0), 'ArrowDown', { ctrl: true }, meta, isEmpty).active, { r: 6, c: 0 });
});

test('moveActive: Ctrl+arrow on an empty full-size sheet reaches the edge', () => {
  const meta = { rowCount: MAX_ROWS, colCount: MAX_COLS };
  const r = moveActive(st(0, 0), 'ArrowDown', { ctrl: true }, meta, () => true);
  assert.deepStrictEqual(r.active, { r: MAX_ROWS - 1, c: 0 });
  const e = moveActive(st(0, 0), 'End', { ctrl: true }, meta, () => true);
  assert.deepStrictEqual(e.active, { r: MAX_ROWS - 1, c: MAX_COLS - 1 });
});

test('moveActive: Page keys move by pageRows (or pageCols with Alt), visible lines only', () => {
  const meta = { rowCount: 100, colCount: 30, pageRows: 10, pageCols: 4 };
  assert.deepStrictEqual(moveActive(st(5, 3), 'PageDown', noMods, meta).active, { r: 15, c: 3 });
  assert.deepStrictEqual(moveActive(st(5, 3), 'PageUp', noMods, meta).active, { r: 0, c: 3 });
  assert.deepStrictEqual(moveActive(st(95, 3), 'PageDown', noMods, meta).active, { r: 99, c: 3 });
  assert.deepStrictEqual(moveActive(st(5, 3), 'PageDown', { alt: true }, meta).active, { r: 5, c: 7 });
  const hidden = { rowCount: 100, colCount: 30, pageRows: 3, rowAxis: buildAxis(100, 20, [], [6, 7]) };
  assert.deepStrictEqual(moveActive(st(5, 0), 'PageDown', noMods, hidden).active, { r: 10, c: 0 });
});

test('moveActive: Shift extends from the focus, keeping the active cell', () => {
  const meta = { rowCount: 20, colCount: 10 };
  let s = moveActive(st(2, 2), 'ArrowDown', { shift: true }, meta);
  assert.deepStrictEqual(s.active, { r: 2, c: 2 });
  assert.deepStrictEqual(s.focus, { r: 3, c: 2 });
  assert.deepStrictEqual(s.selection, [2, 2, 3, 2]);
  s = moveActive(s, 'ArrowRight', { shift: true }, meta);
  assert.deepStrictEqual(s.selection, [2, 2, 3, 3]);
  s = moveActive(s, 'ArrowUp', { shift: true }, meta);
  s = moveActive(s, 'ArrowUp', { shift: true }, meta);
  assert.deepStrictEqual(s.selection, [1, 2, 2, 3], 'shrinks past the anchor then flips');
  s = moveActive(s, 'ArrowLeft', noMods, meta);
  assert.deepStrictEqual(s.selection, [2, 1, 2, 1], 'plain move collapses the selection');
  const far = moveActive(st(2, 2), 'End', { shift: true, ctrl: true }, meta);
  assert.deepStrictEqual(far.selection, [2, 2, 19, 9]);
});

test('moveActive: Ctrl+A selects the whole sheet and keeps the active cell', () => {
  const meta = { rowCount: MAX_ROWS, colCount: MAX_COLS };
  const s = moveActive(st(7, 7), 'a', { ctrl: true }, meta);
  assert.deepStrictEqual(s.selection, [0, 0, MAX_ROWS - 1, MAX_COLS - 1]);
  assert.deepStrictEqual(s.active, { r: 7, c: 7 });
  assert.strictEqual(moveActive(st(7, 7), 'a', noMods, meta), null);
});

test('moveActive: merged-cell navigation', () => {
  // B2:D3 merged (rows 1-2, cols 1-3)
  const meta = { rowCount: 10, colCount: 10, merges: [[1, 1, 2, 3]] };
  assert.deepStrictEqual(moveActive(st(0, 2), 'ArrowDown', noMods, meta).active, { r: 1, c: 1 }, 'lands on the anchor');
  assert.deepStrictEqual(moveActive(st(1, 1), 'ArrowDown', noMods, meta).active, { r: 3, c: 1 }, 'leaves via the bottom edge');
  assert.deepStrictEqual(moveActive(st(1, 1), 'ArrowRight', noMods, meta).active, { r: 1, c: 4 }, 'leaves via the right edge');
  assert.deepStrictEqual(moveActive(st(1, 1), 'ArrowUp', noMods, meta).active, { r: 0, c: 1 });
  assert.deepStrictEqual(moveActive(st(1, 1), 'ArrowLeft', noMods, meta).active, { r: 1, c: 0 });
  assert.deepStrictEqual(moveActive(st(1, 1), 'Tab', noMods, meta).active, { r: 1, c: 4 });
  assert.deepStrictEqual(moveActive(st(1, 4), 'ArrowLeft', noMods, meta).active, { r: 1, c: 1 }, 'enters at the anchor');
  // selection grows to include a touched merge
  const s = moveActive(st(0, 0), 'ArrowDown', { shift: true }, { ...meta, merges: [[0, 0, 1, 1]] });
  assert.deepStrictEqual(s.selection, [0, 0, 1, 1]);
  const t = moveActive(st(0, 3), 'ArrowDown', { shift: true }, meta);
  assert.deepStrictEqual(t.selection, [0, 1, 2, 3], 'extends to the whole merge');
});

// ----------------------------------------------------------- selectionStats

test('selectionStats: Sum / Average / Count of numeric cells', () => {
  const cells = [
    { r: 0, c: 0, d: '10', k: 'n', s: 0 },
    { r: 0, c: 1, d: '2.5', k: 'n', s: 0 },
    { r: 1, c: 0, d: 'hello', k: 's', s: 0 },
    { r: 1, c: 1, d: '', k: 'z', s: 0 },
    { r: 2, c: 0, d: '2024-01-01', k: 'd', s: 0 },
    { r: 2, c: 1, d: '#DIV/0!', k: 'e', s: 0 },
    { r: 3, c: 0, d: 'TRUE', k: 'b', s: 0 },
  ];
  assert.deepStrictEqual(selectionStats(cells), { sum: 12.5, average: 6.25, count: 2 });
});

test('selectionStats: formatted display strings and float noise', () => {
  const c = (d) => ({ r: 0, c: 0, d, k: 'n', s: 0 });
  assert.strictEqual(selectionStats([c('$1,234.50'), c('(100)'), c('-5')]).sum, 1129.5);
  assert.strictEqual(selectionStats([c('50%'), c('1E3')]).sum, 1000.5);
  assert.strictEqual(selectionStats([c('0.1'), c('0.2')]).sum, 0.3);
  assert.strictEqual(selectionStats([c('n/a'), c('12 apples')]).count, 0);
  assert.deepStrictEqual(selectionStats([]), { sum: 0, average: null, count: 0 });
  assert.deepStrictEqual(selectionStats([{ r: 0, c: 0, d: '1.2K', k: 'n', v: 1200, s: 0 }]), { sum: 1200, average: 1200, count: 1 });
});

// -------------------------------------------------------------------- toTsv

test('toTsv: rows by newline, columns by tab, missing cells empty', () => {
  const cells = [
    { r: 0, c: 0, d: 'a' }, { r: 0, c: 2, d: 'c' },
    { r: 1, c: 1, d: '2' },
    { r: 5, c: 5, d: 'outside' },
  ];
  assert.strictEqual(toTsv(cells, [0, 0, 1, 2]), 'a\t\tc\n\t2\t');
  assert.strictEqual(toTsv(cells, [1, 1, 1, 1]), '2');
  assert.strictEqual(toTsv(new Map([['3,3', { d: 'm' }]]), [3, 3, 3, 3]), 'm');
});

test('toTsv: quotes fields containing tab, newline or quote', () => {
  const cells = [{ r: 0, c: 0, d: 'a\tb' }, { r: 0, c: 1, d: 'x\ny' }, { r: 0, c: 2, d: 'say "hi"' }];
  assert.strictEqual(toTsv(cells, [0, 0, 0, 2]), '"a\tb"\t"x\ny"\t"say ""hi"""');
});

test('toTsv: hidden rows and columns are skipped; oversize ranges are refused', () => {
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push({ r, c, d: `${r}${c}` });
  const opts = { rowAxis: buildAxis(3, 20, [], [1]), colAxis: buildAxis(3, 50, [], [0]) };
  assert.strictEqual(toTsv(cells, [0, 0, 2, 2], opts), '01\t02\n21\t22');
  assert.throws(() => toTsv([], [0, 0, MAX_ROWS - 1, MAX_COLS - 1]), RangeError);
});

// --------------------------------------------------------------- unit helpers

test('unit helpers: character widths and points to px', () => {
  assert.strictEqual(M.charWidthToPx(9.140625), 64);
  assert.strictEqual(M.charWidthToPx(10), 70);
  assert.strictEqual(M.pointsToPx(15), 20);
  assert.strictEqual(M.pointsToPx(12.75), 17);
});
