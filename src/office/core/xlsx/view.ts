// WP-14: view DTOs over the read model: sheet meta, cell windows, TSV (spec §5.2, §7.2, §9.2, §9.5).
// Pure: no `vscode` import (core rule), so the bundle test reaches it.

import type { OfficeNotice, XlsxCell, XlsxSheetMeta, XlsxStyle } from '../../protocol.js';
import { partNameFromTarget, readRelationships } from '../opc.js';
import { attr, childrenOf } from '../xml.js';
import type { Workbook } from './workbook.js';
import type { Sheet } from './sheet.js';
import { a1ToRange, rcToA1 } from './sheet.js';
import { isMainNs, stringItemText } from './sharedStrings.js';
import type { StyleTable } from './styles.js';
import { displayString, pointsToPx, unitsToPx } from './format.js';
import { stripXlfnPrefixes } from './xlfn.js';
import type { CellRead, Range } from './types.js';
import { detectSheetNotices } from './notices.js';

export type CellRange = [number, number, number, number];

const MIN_ROWS = 100;
const MIN_COLS = 26;

// ---------------------------------------------------------------------------------------------
// Per-sheet auxiliary lookups (hyperlinks, legacy comments, locked ranges), built once per Sheet.

interface SheetAux {
  links: Map<string, string>;                 // "B2" -> target (single-cell refs)
  linkRanges: Array<[Range, string]>;         // range refs
  notes: Map<string, string>;                 // "B2" -> legacy comment text
  locked: Range[];                            // multi-cell array formulas and table header rows
}

const auxCache = new WeakMap<Sheet, SheetAux>();

function legacyNotes(wb: Workbook, sheet: Sheet): Map<string, string> {
  const out = new Map<string, string>();
  let rels;
  try { rels = readRelationships(wb.pkg, sheet.part); } catch { return out; }
  for (const rel of rels) {
    if (rel.external || !/\/comments$/.test(rel.type)) continue;
    try {
      const part = partNameFromTarget(sheet.part, rel.target);
      if (!wb.pkg.has(part)) continue;
      const root = wb.pkg.xml(part).root;
      if (root.local !== 'comments' || !isMainNs(root.ns)) continue;
      for (const list of childrenOf(root, root.ns, 'commentList')) {
        for (const c of childrenOf(list, root.ns, 'comment')) {
          const ref = attr(c, '', 'ref');
          const text = c.children.find((n) => n.type === 'el' && n.local === 'text');
          if (ref === undefined || !text || text.type !== 'el') continue;
          const key = ref.replace(/\$/g, '').toUpperCase();
          if (!out.has(key)) out.set(key, stringItemText(text, root.ns).text);
        }
      }
    } catch { /* an unreadable comments part just means no tooltips */ }
  }
  return out;
}

function auxFor(wb: Workbook, sheet: Sheet): SheetAux {
  const hit = auxCache.get(sheet);
  if (hit) return hit;
  const links = new Map<string, string>();
  const linkRanges: Array<[Range, string]> = [];
  for (const [ref, target] of sheet.hyperlinks()) {
    if (ref.includes(':')) {
      const rg = a1ToRange(ref);
      if (rg) linkRanges.push([rg, target]);
    } else {
      links.set(ref, target);
    }
  }
  const locked: Range[] = [];
  for (const rg of sheet.arrayFormulaRanges()) if (rg[0] !== rg[2] || rg[1] !== rg[3]) locked.push(rg);
  for (const t of sheet.tables()) {
    if (t.headerRows > 0) locked.push([t.ref[0], t.ref[1], t.ref[0] + t.headerRows - 1, t.ref[3]]);
  }
  const aux = { links, linkRanges, notes: legacyNotes(wb, sheet), locked };
  auxCache.set(sheet, aux);
  return aux;
}

const inRange = (rg: Range, r: number, c: number): boolean => r >= rg[0] && r <= rg[2] && c >= rg[1] && c <= rg[3];

function linkAt(aux: SheetAux, r: number, c: number): string | undefined {
  const hit = aux.links.get(rcToA1(r, c));
  if (hit !== undefined) return hit;
  for (const [rg, target] of aux.linkRanges) if (inRange(rg, r, c)) return target;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Cells

/** Formula cell (own formula or a shared-formula dependant). */
export function hasFormula(cell: CellRead): boolean {
  return cell.formula !== undefined || cell.shared !== undefined;
}

/**
 * The text a cell shows. A formula cell without a cached value shows its formula text (the grid
 * adds the italic "not calculated" marker, §7.2); a shared-formula dependant has none to show.
 */
export function cellText(wb: Workbook, styles: StyleTable, cell: CellRead): string {
  if (!cell.hasCachedValue && cell.value.k === 'z' && hasFormula(cell)) {
    return cell.formula !== undefined ? '=' + stripXlfnPrefixes(cell.formula) : '';
  }
  return displayString(cell.value, styles.formatCode(cell.styleIndex), wb.date1904).text;
}

function toCell(wb: Workbook, styles: StyleTable, aux: SheetAux, cell: CellRead, staleAll: boolean): XlsxCell {
  const v = cell.value;
  const out: XlsxCell = {
    r: cell.r, c: cell.c,
    d: cellText(wb, styles, cell),
    s: cell.styleIndex,
    k: v.k === 'n' ? (styles.isDateStyle(cell.styleIndex) ? 'd' : 'n') : v.k,
  };
  if (v.k === 'n') out.v = v.v;
  if (hasFormula(cell)) {
    out.f = true;
    if (staleAll || !cell.hasCachedValue) out.stale = true;
  }
  const link = linkAt(aux, cell.r, cell.c);
  if (link !== undefined) out.link = link;
  const note = aux.notes.get(rcToA1(cell.r, cell.c));
  if (note !== undefined) out.note = note;
  if (cell.cm || cell.vm || aux.locked.some((rg) => inRange(rg, cell.r, cell.c))) out.ro = true;
  return out;
}

/** Clamp a requested range to the sheet's meta size; null when nothing is left. */
export function clampRange(meta: Pick<XlsxSheetMeta, 'rowCount' | 'colCount'>, range: readonly number[]): CellRange | null {
  const r1 = Math.min(range[2], meta.rowCount - 1);
  const c1 = Math.min(range[3], meta.colCount - 1);
  if (range[0] > r1 || range[1] > c1) return null;
  return [range[0], range[1], r1, c1];
}

/**
 * The cells in `range` (already clamped by the caller) plus the style-table subset they use.
 * Includes empty-but-styled cells (a `c` node with no value, or a position that inherits a row or
 * column style) and empty cells carrying a hyperlink or a note. `staleAll` flags every formula cell
 * stale (set once a workbook has been edited, §9.5).
 */
export function cellWindow(
  wb: Workbook, sheet: Sheet, styles: StyleTable, range: readonly number[], staleAll: boolean,
): { cells: XlsxCell[]; styles: Record<number, XlsxStyle> } {
  const aux = auxFor(wb, sheet);
  const [r0, c0, r1, c1] = range;
  const cells: XlsxCell[] = [];
  const have = new Set<number>();
  for (const cell of sheet.cellsIn([r0, c0, r1, c1])) {
    cells.push(toCell(wb, styles, aux, cell, staleAll));
    have.add(cell.r * 16384 + cell.c);
  }
  const cols = sheet.cols();
  const colStyle = (c: number): number => {
    for (const ci of cols) if (c >= ci.min && c <= ci.max && ci.styleIndex !== null) return ci.styleIndex;
    return 0;
  };
  const annotated = aux.notes.size > 0 || aux.links.size > 0;
  for (let r = r0; r <= r1; r++) {
    const rowStyle = sheet.rowInfo(r)?.styleIndex ?? null;
    for (let c = c0; c <= c1; c++) {
      if (have.has(r * 16384 + c)) continue;
      const s = rowStyle ?? colStyle(c);
      const a1 = annotated ? rcToA1(r, c) : '';
      const note = aux.notes.get(a1);
      const link = aux.links.get(a1);
      if (s === 0 && note === undefined && link === undefined) continue;
      const cell: XlsxCell = { r, c, d: '', s, k: 'z' };
      if (link !== undefined) cell.link = link;
      if (note !== undefined) cell.note = note;
      cells.push(cell);
    }
  }
  const out: Record<number, XlsxStyle> = {};
  for (const cell of cells) if (!(cell.s in out)) out[cell.s] = styles.dto(cell.s);
  return { cells, styles: out };
}

// ---------------------------------------------------------------------------------------------
// Meta

export function sheetMeta(wb: Workbook, sheet: Sheet, _styles: StyleTable, sheetId: number, version: number): XlsxSheetMeta {
  const dims = sheet.dimensions();
  let rowCount = Math.max(MIN_ROWS, dims.rows);
  const colCount = Math.max(MIN_COLS, dims.cols);
  if (sheet.truncatedAtRow !== null) rowCount = Math.min(rowCount, sheet.truncatedAtRow);

  const fd = sheet.formatDefaults();
  const defaultColWidthPx = fd.defaultColWidthChars !== null
    ? unitsToPx(fd.defaultColWidthChars)
    : (fd.baseColWidth === 8 ? 64 : fd.baseColWidth * 7 + 5);
  const defaultRowHeightPx = pointsToPx(fd.defaultRowHeightPt ?? 15) || 20;

  const colWidthsPx: Array<[number, number]> = [];
  const hiddenCols: number[] = [];
  const seenCols = new Set<number>();
  for (const ci of sheet.cols()) {
    const px = ci.widthChars !== null ? unitsToPx(ci.widthChars) : null;
    for (let c = ci.min; c <= Math.min(ci.max, colCount - 1); c++) {
      if (seenCols.has(c)) continue;
      seenCols.add(c);
      if (ci.hidden) hiddenCols.push(c);
      else if (px !== null && px !== defaultColWidthPx) colWidthsPx.push([c, px]);
    }
  }
  colWidthsPx.sort((a, b) => a[0] - b[0]);
  hiddenCols.sort((a, b) => a - b);

  const rowHeightsPx: Array<[number, number]> = [];
  const hiddenRows: number[] = [];
  for (const r of sheet.rowIndices()) {
    if (r >= rowCount) break;
    const ri = sheet.rowInfo(r);
    if (!ri) continue;
    if (ri.hidden) hiddenRows.push(r);
    else if (ri.heightPt !== null) {
      const px = pointsToPx(ri.heightPt);
      if (px > 0 && px !== defaultRowHeightPx) rowHeightsPx.push([r, px]);
    }
  }

  const pane = sheet.pane();
  const notices: OfficeNotice[] = detectSheetNotices(wb, sheet);
  return {
    sheetId, version, rowCount, colCount, defaultColWidthPx, defaultRowHeightPx,
    colWidthsPx, rowHeightsPx, hiddenCols, hiddenRows,
    merges: sheet.merges().map((m) => [m[0], m[1], m[2], m[3]] as [number, number, number, number]),
    frozenRows: pane.frozenRows, frozenCols: pane.frozenCols,
    notices,
  };
}

// ---------------------------------------------------------------------------------------------
// TSV

function tsvField(s: string): string {
  return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Display strings of `range` (clamped to the used range) as tab-separated rows, quoted like Excel. */
export function toTsv(wb: Workbook, sheet: Sheet, styles: StyleTable, range: readonly number[]): string {
  const dims = sheet.dimensions();
  const r0 = range[0], c0 = range[1];
  const r1 = Math.min(range[2], dims.rows - 1);
  const c1 = Math.min(range[3], dims.cols - 1);
  if (r0 > r1 || c0 > c1) return '';
  const width = c1 - c0 + 1;
  const rows: string[][] = [];
  for (let r = r0; r <= r1; r++) rows.push(new Array<string>(width).fill(''));
  for (const cell of sheet.cellsIn([r0, c0, r1, c1])) {
    rows[cell.r - r0][cell.c - c0] = tsvField(cellText(wb, styles, cell));
  }
  return rows.map((r) => r.join('\t')).join('\n');
}
