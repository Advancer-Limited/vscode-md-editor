// Worksheet read model (spec §9.1, §9.2, §9.4 read side, §10.2).
//
// A `Sheet` wraps the parsed worksheet tree and an index over it: row number -> `row` node and
// (row, column) -> `c` node. The index is the structure every later write goes through, so it keeps
// the nodes themselves; `CellRead` values are built on demand from a node (nothing per cell is
// copied, which keeps a 200k-cell sheet cheap). After the write side changes the tree it calls
// `rebuildIndex()`.
//
// Coordinates are 0-based everywhere in this API (`r` 0 = row "1", `c` 0 = column "A"), including
// `ColInfo.min`/`max` and `Range`.
//
// View-only reasons for the sheet (§9.1, §10.2): `protected` (a `sheetProtection` element),
// `unsupported-xml-layout` (a `row` or `c` without `r`, a cell whose `r` names another row, rows or
// cells out of order or duplicated), `too-large` (part > 64 MB or > 500,000 non-empty cells; only
// the first 50,000 rows are indexed). Positions of rows/cells without `r` are inferred the way Excel
// does (previous + 1) so the sheet can still be viewed; the first of duplicated positions wins.
//
// No `vscode` import here (core rule).

import type { ReadOnlyReason } from '../types.js';
import type { OfficePackage } from '../package.js';
import type { XmlDoc, XmlElement } from '../xml.js';
import { attr, child, childrenOf, textContent } from '../xml.js';
import { partNameFromTarget, readRelationships } from '../opc.js';
import type { Relationship } from '../opc.js';
import { LIMITS } from '../limits.js';
import type { CellRead, CellValue, ColInfo, Range, RowInfo, TableInfo } from './types.js';
import { decodeXstring, isMainNs, stringItemText } from './sharedStrings.js';
import type { SharedStrings } from './sharedStrings.js';

export type { CellRead, CellValue, ColInfo, Range, RowInfo, TableInfo } from './types.js';

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

// ---------------------------------------------------------------------------------------------------
// A1 references

/** Column letters ("A".."XFD") -> 0-based index; -1 when invalid. */
function colIndex(s: string, start: number, end: number): number {
  if (end <= start || end - start > 3) return -1;
  let n = 0;
  for (let i = start; i < end; i++) {
    let ch = s.charCodeAt(i);
    if (ch >= 97 && ch <= 122) ch -= 32;
    if (ch < 65 || ch > 90) return -1;
    n = n * 26 + (ch - 64);
  }
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

/** Parse "A1" / "$A$1" into [r, c] (0-based); undefined when not a valid cell reference. */
function parseCell(ref: string): [number, number] | undefined {
  let i = 0;
  const n = ref.length;
  if (ref.charCodeAt(i) === 36) i++;                                    // '$'
  const cs = i;
  while (i < n) { const ch = ref.charCodeAt(i) | 32; if (ch < 97 || ch > 122) break; i++; }
  const c = colIndex(ref, cs, i);
  if (c < 0) return undefined;
  if (ref.charCodeAt(i) === 36) i++;
  const rs = i;
  let row = 0;
  for (; i < n; i++) {
    const ch = ref.charCodeAt(i);
    if (ch < 48 || ch > 57) return undefined;
    row = row * 10 + (ch - 48);
    if (row > MAX_ROWS) return undefined;
  }
  if (i === rs || row < 1 || ref.charCodeAt(rs) === 48) return undefined;
  return [row - 1, c];
}

/** "B3" or "$B$3" -> [2, 1] (0-based row, column). Throws for anything else. */
export function a1ToRc(ref: string): [number, number] {
  const rc = parseCell(ref);
  if (!rc) throw new Error(`Invalid cell reference "${ref}"`);
  return rc;
}

/** (2, 1) -> "B3". Throws for coordinates outside the sheet. */
export function rcToA1(r: number, c: number): string {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) {
    throw new Error(`Cell (${r}, ${c}) is outside the sheet`);
  }
  let col = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) col = String.fromCharCode(65 + ((n - 1) % 26)) + col;
  return col + (r + 1);
}

/** "A1:C3" or "B2" -> Range (normalised so r0 <= r1, c0 <= c1); undefined when not a cell range. */
export function a1ToRange(ref: string): Range | undefined {
  const colon = ref.indexOf(':');
  const a = parseCell(colon < 0 ? ref : ref.slice(0, colon));
  if (!a) return undefined;
  const b = colon < 0 ? a : parseCell(ref.slice(colon + 1));
  if (!b) return undefined;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Range -> "A1:C3" ("B2" for a single cell). */
export function rangeToA1(range: Range): string {
  const a = rcToA1(range[0], range[1]);
  return range[0] === range[2] && range[1] === range[3] ? a : `${a}:${rcToA1(range[2], range[3])}`;
}

// ---------------------------------------------------------------------------------------------------
// Helpers

const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

function intAttr(el: XmlElement, local: string): number | undefined {
  const v = attr(el, '', local);
  if (v === undefined || !/^\s*-?\d+\s*$/.test(v)) return undefined;
  return parseInt(v, 10);
}

function numAttr(el: XmlElement, local: string): number | undefined {
  const v = attr(el, '', local);
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Yield to the event loop (spec §10.2 chunked parsing). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface RowIndex {
  readonly node: XmlElement;
  /** Sorted 0-based column indices of the cells in this row. */
  readonly cols: number[];
  /** `c` nodes, parallel to `cols`. */
  readonly cells: XmlElement[];
}

/** Binary search: first position in sorted `a` whose value is >= x. */
function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Context a sheet needs from its workbook. */
export interface SheetContext {
  readonly pkg: OfficePackage;
  readonly sharedStrings: () => SharedStrings;
  /** Uncompressed size of the worksheet part in bytes (for the §10.2 limits). */
  readonly partBytes: number;
}

/** A shared-formula group's master cell (§9.4). */
export interface SharedFormulaMaster { si: number; r: number; c: number; formula: string; ref: Range | undefined; refText: string }

// ---------------------------------------------------------------------------------------------------

export class Sheet {
  readonly part: string;
  readonly doc: XmlDoc;
  private readonly ctx: SheetContext;
  /** SpreadsheetML namespace of this part (transitional or Strict). */
  private readonly ns: string;

  private _readOnlyReason: ReadOnlyReason | null = null;
  private _truncatedAtRow: number | null = null;
  private _overLimits = false;
  private _nonEmptyCells = 0;

  /** Sorted 0-based row indices that have a `row` node. */
  private rowList: number[] = [];
  private rowMap = new Map<number, RowIndex>();
  private maxRow = -1;
  private maxCol = -1;
  private sharedMasters: Map<number, SharedFormulaMaster> | null = null;
  private tableCache: TableInfo[] | null = null;
  private linkCache: Map<string, string> | null = null;

  /**
   * Use `Workbook.sheet(id)`; this constructor is for the workbook. Call `rebuildIndex()` (or
   * `buildIndexAsync()`) before reading.
   */
  constructor(part: string, doc: XmlDoc, ctx: SheetContext) {
    const root = doc.root;
    if (root.local !== 'worksheet' || !isMainNs(root.ns)) {
      throw new Error(`${part}: root element is not a SpreadsheetML worksheet`);
    }
    this.part = part;
    this.doc = doc;
    this.ctx = ctx;
    this.ns = root.ns;
  }

  /** Why this sheet cannot be edited, or null. Combine with `Workbook.viewOnlyReason` (workbook-wide). */
  get readOnlyReason(): ReadOnlyReason | null { return this._readOnlyReason; }

  /**
   * For a sheet over the §10.2 limits: 50,000 (`LIMITS.xlsxTruncatedRows`). Only rows below that
   * index are indexed; later rows, if the sheet has any, read as absent. The viewer shows its
   * truncation banner whenever this is non-null (§10.2). Null for a sheet within the limits.
   */
  get truncatedAtRow(): number | null { return this._truncatedAtRow; }

  /** True when the sheet exceeds the §10.2 limits (part size or non-empty cells): the workbook is view-only. */
  get overLimits(): boolean { return this._overLimits; }

  /** Count of non-empty cells (a `v`, `f` or `is` child) in the whole part, indexed or not. */
  get nonEmptyCellCount(): number { return this._nonEmptyCells; }

  // -------------------------------------------------------------------------------------------
  // Index

  /** Rebuild the row/cell index from the current tree (synchronous; the write side calls this). */
  rebuildIndex(): void {
    const b = this.beginIndex();
    while (b.step(Infinity)) { /* runs to completion */ }
    b.finish();
  }

  /** Build the index, yielding to the event loop at least every `LIMITS.parseYieldMs` (§10.2). */
  async buildIndexAsync(): Promise<void> {
    const b = this.beginIndex();
    while (b.step(Date.now() + LIMITS.parseYieldMs)) await yieldToEventLoop();
    b.finish();
  }

  private beginIndex(): { step(deadline: number): boolean; finish(): void } {
    const ns = this.ns;
    const root = this.doc.root;
    const sheetData = child(root, ns, 'sheetData');
    const rowEls: XmlElement[] = sheetData ? childrenOf(sheetData, ns, 'row') : [];
    const rowMap = new Map<number, RowIndex>();
    const rowList: number[] = [];
    let layoutBad = false;
    let nonEmpty = 0;
    let maxRow = -1;
    let maxCol = -1;
    let prevRow = -1;
    let i = 0;
    const overSize = this.ctx.partBytes > LIMITS.xlsxMaxSheetXmlBytes;
    const rowCap = LIMITS.xlsxTruncatedRows;
    let droppedRows = false;

    const step = (deadline: number): boolean => {
      for (; i < rowEls.length; i++) {
        if ((i & 255) === 0 && Date.now() > deadline) return true;
        const rowEl = rowEls[i];
        const rAttr = attr(rowEl, '', 'r');
        let r: number;
        if (rAttr === undefined) {
          layoutBad = true;
          r = prevRow + 1;
        } else {
          const n = /^\d+$/.test(rAttr) ? parseInt(rAttr, 10) : NaN;
          if (!(n >= 1 && n <= MAX_ROWS)) { layoutBad = true; r = prevRow + 1; } else r = n - 1;
        }
        if (r <= prevRow) layoutBad = true;            // out of order or duplicate
        prevRow = Math.max(prevRow, r);
        const keep = r < MAX_ROWS && !rowMap.has(r);
        const cols: number[] = [];
        const cells: XmlElement[] = [];
        let prevCol = -1;
        let sorted = true;
        for (const ch of rowEl.children) {
          if (ch.type !== 'el' || ch.local !== 'c' || ch.ns !== ns) continue;
          // non-empty: has a v, f or is child
          for (const g of ch.children) {
            if (g.type === 'el' && g.ns === ns && (g.local === 'v' || g.local === 'f' || g.local === 'is')) { nonEmpty++; break; }
          }
          const ref = attr(ch, '', 'r');
          let c: number;
          if (ref === undefined) {
            layoutBad = true;
            c = prevCol + 1;
          } else {
            const rc = parseCell(ref);
            if (!rc) { layoutBad = true; c = prevCol + 1; } else {
              c = rc[1];
              if (rc[0] !== r) layoutBad = true;
            }
          }
          if (c <= prevCol) { layoutBad = true; sorted = false; }
          prevCol = Math.max(prevCol, c);
          if (c >= MAX_COLS) continue;
          cols.push(c);
          cells.push(ch);
        }
        if (!keep) continue;
        if (r >= rowCap) droppedRows = true;
        if (!sorted) dedupeSort(cols, cells);
        rowMap.set(r, { node: rowEl, cols, cells });
        rowList.push(r);
        if (r > maxRow) maxRow = r;
        if (cols.length && cols[cols.length - 1] > maxCol) maxCol = cols[cols.length - 1];
      }
      return false;
    };

    const finish = (): void => {
      rowList.sort((a, b) => a - b);
      const over = overSize || nonEmpty > LIMITS.xlsxMaxCells;
      if (over && droppedRows) {
        // Keep only the first `rowCap` rows (§10.2); recompute the extent from what is kept.
        const cut = lowerBound(rowList, rowCap);
        for (let k = cut; k < rowList.length; k++) rowMap.delete(rowList[k]);
        rowList.length = cut;
        maxRow = -1;
        maxCol = -1;
        for (const rr of rowList) {
          const ri = rowMap.get(rr)!;
          if (rr > maxRow) maxRow = rr;
          if (ri.cols.length && ri.cols[ri.cols.length - 1] > maxCol) maxCol = ri.cols[ri.cols.length - 1];
        }
      }
      this.rowMap = rowMap;
      this.rowList = rowList;
      this.maxRow = maxRow;
      this.maxCol = maxCol;
      this._nonEmptyCells = nonEmpty;
      this._overLimits = over;
      this._truncatedAtRow = over ? rowCap : null;
      this.sharedMasters = null;
      this.tableCache = null;
      this.linkCache = null;
      const prot = child(root, ns, 'sheetProtection') !== undefined;
      this._readOnlyReason = prot ? 'protected' : layoutBad ? 'unsupported-xml-layout' : over ? 'too-large' : null;
    };

    return { step, finish };
  }

  // -------------------------------------------------------------------------------------------
  // Cells

  /** Used range: one past the last row/column holding a row node, a cell or a merge (0 x 0 when empty). */
  dimensions(): { rows: number; cols: number } {
    let mr = this.maxRow;
    let mc = this.maxCol;
    for (const m of this.merges()) {
      if (m[2] > mr) mr = m[2];
      if (m[3] > mc) mc = m[3];
    }
    return { rows: mr + 1, cols: mc + 1 };
  }

  /** The `row` node for row `r`, if any. */
  rowNode(r: number): XmlElement | undefined {
    return this.rowMap.get(r)?.node;
  }

  /** The `c` node at (r, c), if any. */
  cellNode(r: number, c: number): XmlElement | undefined {
    const ri = this.rowMap.get(r);
    if (!ri) return undefined;
    const k = lowerBound(ri.cols, c);
    return k < ri.cols.length && ri.cols[k] === c ? ri.cells[k] : undefined;
  }

  /** The cell at (r, c), or undefined when there is no `c` node there. */
  cell(r: number, c: number): CellRead | undefined {
    const el = this.cellNode(r, c);
    return el ? this.readCell(r, c, el) : undefined;
  }

  /** Every cell node inside `range` (inclusive), in row-major order. */
  cellsIn(range: Range): CellRead[] {
    const [r0, c0, r1, c1] = range;
    const out: CellRead[] = [];
    if (r1 < r0 || c1 < c0) return out;
    for (let k = lowerBound(this.rowList, r0); k < this.rowList.length; k++) {
      const r = this.rowList[k];
      if (r > r1) break;
      const ri = this.rowMap.get(r)!;
      for (let j = lowerBound(ri.cols, c0); j < ri.cols.length; j++) {
        const c = ri.cols[j];
        if (c > c1) break;
        out.push(this.readCell(r, c, ri.cells[j]));
      }
    }
    return out;
  }

  /** Row indices (sorted, 0-based) that have a row node. */
  rowIndices(): readonly number[] {
    return this.rowList;
  }

  private readCell(r: number, c: number, el: XmlElement): CellRead {
    const ns = this.ns;
    let t = 'n';
    let styleIndex = 0;
    let cm = false;
    let vm = false;
    for (const a of el.attrs) {
      if (a.ns !== '') continue;
      switch (a.local) {
        case 't': t = a.value; break;
        case 's': { const n = parseInt(a.value, 10); styleIndex = n >= 0 ? n : 0; break; }
        case 'cm': cm = true; break;
        case 'vm': vm = true; break;
      }
    }
    let vEl: XmlElement | undefined;
    let fEl: XmlElement | undefined;
    let isEl: XmlElement | undefined;
    for (const ch of el.children) {
      if (ch.type !== 'el' || ch.ns !== ns) continue;
      if (ch.local === 'v') vEl ??= ch;
      else if (ch.local === 'f') fEl ??= ch;
      else if (ch.local === 'is') isEl ??= ch;
    }
    let value: CellValue = { k: 'z' };
    let rich = false;
    let hasCachedValue = vEl !== undefined;
    const vText = vEl ? textContent(vEl) : undefined;
    switch (t) {
      case 'n':
        if (vText !== undefined && vText.trim() !== '') {
          const n = Number(vText);
          value = Number.isFinite(n) ? { k: 'n', v: n } : { k: 's', v: vText };
        }
        break;
      case 's':
        if (vText !== undefined && vText.trim() !== '') {
          const idx = Number(vText);
          const sst = this.ctx.sharedStrings();
          const s = Number.isInteger(idx) ? sst.get(idx) : undefined;
          value = { k: 's', v: s ?? '' };
          rich = s !== undefined && sst.isRich(idx);
        }
        break;
      case 'inlineStr':
        if (isEl) {
          const it = stringItemText(isEl, ns);
          value = { k: 's', v: it.text };
          rich = it.rich;
          hasCachedValue = true;
        } else if (vText !== undefined) {
          value = { k: 's', v: decodeXstring(vText) };
        }
        break;
      case 'str':
        if (vText !== undefined) value = { k: 's', v: decodeXstring(vText) };
        break;
      case 'b':
        if (vText !== undefined && vText.trim() !== '') {
          const s = vText.trim();
          value = { k: 'b', v: s === '1' || s === 'true' };
        }
        break;
      case 'e':
        if (vText !== undefined) value = { k: 'e', v: vText };
        break;
      case 'd':                                   // ISO 8601 date: shown as text (§9.2)
        if (vText !== undefined) value = { k: 's', v: vText };
        break;
      default:                                    // unknown type: show the raw value as text
        if (vText !== undefined) value = { k: 's', v: vText };
        break;
    }
    const out: CellRead = { r, c, value, styleIndex, hasCachedValue, rich, cm, vm };
    if (fEl) {
      const ft = attr(fEl, '', 't');
      const text = textContent(fEl);
      if (ft === 'shared') {
        const si = intAttr(fEl, 'si');
        const ref = attr(fEl, '', 'ref');
        if (si !== undefined) {
          out.shared = ref !== undefined ? { si, master: true, ref } : { si, master: false };
        }
        if (text !== '') out.formula = text;
      } else {
        if (ft === 'array') {
          const ref = attr(fEl, '', 'ref');
          if (ref !== undefined) out.arrayRef = ref;
        }
        if (text !== '') out.formula = text;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Formulas (§9.4 read side)

  /**
   * Master cell of shared-formula group `si`, or undefined. A dependant (`shared.master === false`)
   * has no `formula` of its own; its formula is the master's with relative references offset
   * (WP-21 materialises that on write).
   */
  sharedMaster(si: number): SharedFormulaMaster | undefined {
    if (!this.sharedMasters) {
      const m = new Map<number, SharedFormulaMaster>();
      for (const r of this.rowList) {
        const ri = this.rowMap.get(r)!;
        for (let j = 0; j < ri.cells.length; j++) {
          const f = child(ri.cells[j], this.ns, 'f');
          if (!f || attr(f, '', 't') !== 'shared') continue;
          const ref = attr(f, '', 'ref');
          const s = intAttr(f, 'si');
          if (ref === undefined || s === undefined || m.has(s)) continue;
          m.set(s, { si: s, r, c: ri.cols[j], formula: textContent(f), ref: a1ToRange(ref), refText: ref });
        }
      }
      this.sharedMasters = m;
    }
    return this.sharedMasters.get(si);
  }

  /** Ranges of legacy array formulas (`f t="array" ref`), from their master cells. */
  arrayFormulaRanges(): Range[] {
    const out: Range[] = [];
    for (const r of this.rowList) {
      const ri = this.rowMap.get(r)!;
      for (const el of ri.cells) {
        const f = child(el, this.ns, 'f');
        if (!f || attr(f, '', 't') !== 'array') continue;
        const ref = attr(f, '', 'ref');
        const range = ref !== undefined ? a1ToRange(ref) : undefined;
        if (range) out.push(range);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Sheet-level structure

  /** Column records (`cols/col`), with 0-based inclusive `min`/`max`. */
  cols(): ColInfo[] {
    const out: ColInfo[] = [];
    const colsEl = child(this.doc.root, this.ns, 'cols');
    if (!colsEl) return out;
    for (const el of childrenOf(colsEl, this.ns, 'col')) {
      const min = intAttr(el, 'min');
      const max = intAttr(el, 'max');
      if (min === undefined || max === undefined || min < 1 || max < min) continue;
      out.push({
        min: min - 1,
        max: Math.min(max, MAX_COLS) - 1,
        widthChars: numAttr(el, 'width') ?? null,
        hidden: truthy(attr(el, '', 'hidden')),
        styleIndex: intAttr(el, 'style') ?? null,
      });
    }
    return out;
  }

  /** Row record for row `r` (height in points, hidden, row style when `customFormat`), if a row node exists. */
  rowInfo(r: number): RowInfo | undefined {
    const el = this.rowNode(r);
    if (!el) return undefined;
    return {
      heightPt: numAttr(el, 'ht') ?? null,
      hidden: truthy(attr(el, '', 'hidden')),
      styleIndex: truthy(attr(el, '', 'customFormat')) ? (intAttr(el, 's') ?? null) : null,
    };
  }

  /** `sheetFormatPr` defaults: row height (pt), column width (chars), base column width (chars, default 8). */
  formatDefaults(): { defaultRowHeightPt: number | null; defaultColWidthChars: number | null; baseColWidth: number; zeroHeight: boolean } {
    const el = child(this.doc.root, this.ns, 'sheetFormatPr');
    return {
      defaultRowHeightPt: el ? (numAttr(el, 'defaultRowHeight') ?? null) : null,
      defaultColWidthChars: el ? (numAttr(el, 'defaultColWidth') ?? null) : null,
      baseColWidth: el ? (intAttr(el, 'baseColWidth') ?? 8) : 8,
      zeroHeight: el ? truthy(attr(el, '', 'zeroHeight')) : false,
    };
  }

  /** Merged ranges (`mergeCells/mergeCell/@ref`); unparsable refs are skipped. */
  merges(): Range[] {
    const out: Range[] = [];
    const mc = child(this.doc.root, this.ns, 'mergeCells');
    if (!mc) return out;
    for (const el of childrenOf(mc, this.ns, 'mergeCell')) {
      const ref = attr(el, '', 'ref');
      const range = ref !== undefined ? a1ToRange(ref) : undefined;
      if (range) out.push(range);
    }
    return out;
  }

  /** Frozen rows/columns from the first sheet view's pane (`state` frozen or frozenSplit); a plain split is 0/0. */
  pane(): { frozenRows: number; frozenCols: number } {
    const views = child(this.doc.root, this.ns, 'sheetViews');
    const view = views ? child(views, this.ns, 'sheetView') : undefined;
    const pane = view ? child(view, this.ns, 'pane') : undefined;
    const state = pane ? attr(pane, '', 'state') : undefined;
    if (!pane || (state !== 'frozen' && state !== 'frozenSplit')) return { frozenRows: 0, frozenCols: 0 };
    const ys = numAttr(pane, 'ySplit') ?? 0;
    const xs = numAttr(pane, 'xSplit') ?? 0;
    return { frozenRows: Math.max(0, Math.floor(ys)), frozenCols: Math.max(0, Math.floor(xs)) };
  }

  /** Whether the sheet has a `sheetProtection` element (§9.1). */
  isProtected(): boolean {
    return child(this.doc.root, this.ns, 'sheetProtection') !== undefined;
  }

  /**
   * Hyperlinks: key = the `ref` as written (a cell "K2" or a range "A1:B2", `$` removed, upper case);
   * value = the external target (`r:id` through the sheet's relationships), `#location` for an
   * internal link, or target + `#location` when both are given. Links whose target cannot be
   * resolved are omitted. Targets are never dereferenced here (§12).
   */
  hyperlinks(): Map<string, string> {
    if (this.linkCache) return this.linkCache;
    const out = new Map<string, string>();
    const hl = child(this.doc.root, this.ns, 'hyperlinks');
    if (hl) {
      let rels: Map<string, string> | undefined;
      for (const el of childrenOf(hl, this.ns, 'hyperlink')) {
        const ref = attr(el, '', 'ref');
        if (ref === undefined) continue;
        const key = ref.replace(/\$/g, '').toUpperCase();
        const id = attr(el, NS_R, 'id') ?? attr(el, NS_R_STRICT, 'id');
        const location = attr(el, '', 'location');
        let target: string | undefined;
        if (id !== undefined) {
          rels ??= new Map(safeRelationships(this.ctx.pkg, this.part).map((x) => [x.id, x.target]));
          target = rels.get(id);
        }
        if (location !== undefined && location !== '') target = (target ?? '') + '#' + location;
        if (target !== undefined && !out.has(key)) out.set(key, target);
      }
    }
    this.linkCache = out;
    return out;
  }

  /** Tables on this sheet (`tableParts` resolved through the sheet's relationships). Missing parts are skipped. */
  tables(): TableInfo[] {
    if (this.tableCache) return this.tableCache;
    const out: TableInfo[] = [];
    const tp = child(this.doc.root, this.ns, 'tableParts');
    if (tp) {
      const rels = safeRelationships(this.ctx.pkg, this.part);
      for (const el of childrenOf(tp, this.ns, 'tablePart')) {
        const id = attr(el, NS_R, 'id') ?? attr(el, NS_R_STRICT, 'id');
        const rel = id !== undefined ? rels.find((x) => x.id === id) : undefined;
        if (!rel || rel.external) continue;
        let part: string;
        try { part = partNameFromTarget(this.part, rel.target); } catch { continue; }
        if (!this.ctx.pkg.has(part)) continue;
        const name = this.ctx.pkg.partNames().find((n) => n.toLowerCase() === part.toLowerCase()) ?? part;
        // A malformed table part is skipped, not fatal: tables only decorate the grid.
        let root: XmlElement;
        try { root = this.ctx.pkg.xml(name).root; } catch { continue; }
        if (root.local !== 'table' || !isMainNs(root.ns)) continue;
        const ref = attr(root, '', 'ref');
        const range = ref !== undefined ? a1ToRange(ref) : undefined;
        if (!range) continue;
        out.push({
          part: name,
          name: attr(root, '', 'displayName') ?? attr(root, '', 'name') ?? '',
          ref: range,
          headerRows: intAttr(root, 'headerRowCount') ?? 1,
          totalsRows: intAttr(root, 'totalsRowCount') ?? 0,
        });
      }
    }
    this.tableCache = out;
    return out;
  }
}

/**
 * The part's relationships, or none when its .rels part is malformed. Used for decorations
 * (hyperlinks, tables) so a damaged .rels cannot make every cell request fail.
 */
function safeRelationships(pkg: OfficePackage, part: string): Relationship[] {
  try { return readRelationships(pkg, part); } catch { return []; }
}

/** Sort parallel arrays by column and drop duplicate columns (first occurrence wins). */
function dedupeSort(cols: number[], cells: XmlElement[]): void {
  const idx = cols.map((_, k) => k).sort((a, b) => cols[a] - cols[b] || a - b);
  const nc: number[] = [];
  const ne: XmlElement[] = [];
  for (const k of idx) {
    if (nc.length && nc[nc.length - 1] === cols[k]) continue;
    nc.push(cols[k]);
    ne.push(cells[k]);
  }
  cols.length = 0; cells.length = 0;
  cols.push(...nc); cells.push(...ne);
}
