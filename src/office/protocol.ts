// Office viewers message protocol (spec §5, §5.1, §5.2). FROZEN after WP-07: a change is a
// plan/spec change made together with spec §5. Pure types plus inbound validators; no `vscode`
// import, and only erasable TypeScript syntax so the file also loads under Node type-stripping.
//
// Phase 0 S2 passed: `docxRender.bytes` stays a `Uint8Array` (no base64 fallback).

export type { ReadOnlyReason, OfficeNotice, OfficeError } from './core/types.js';
import type { ReadOnlyReason, OfficeNotice, OfficeError } from './core/types.js';

// ---------- shared ----------

export type OfficeCommonToWebview =
  | { type: 'init'; kind: 'docx' | 'xlsx'; fileName: string; version: number;
      canEdit: boolean; readOnlyReason: ReadOnlyReason | null; editMode: boolean;
      notices: OfficeNotice[] }
  | { type: 'loadError'; title: string; detail: string; actions: Array<'openExternally' | 'retry'> }
  | { type: 'editModeChanged'; editMode: boolean }
  | { type: 'flushPendingEdits'; flushId: number }   // host is about to save/backup
  | { type: 'notices'; notices: OfficeNotice[] }
  | { type: 'requestFailed'; requestId: number; error: OfficeError };   // generic failure reply for any requestId-carrying request without a dedicated failure variant

export type OfficeCommonToHost =
  | { type: 'ready' }
  | { type: 'setEditMode'; editMode: boolean }
  | { type: 'flushed'; flushId: number }             // sent after any pending commit's result arrived
  | { type: 'openLink'; href: string }
  | { type: 'openExternally' }                       // vscode.env.openExternal(document.uri)
  | { type: 'retry' }
  | { type: 'writeClipboard'; text: string }
  | { type: 'showAbout' };

// ---------- Word (§5.1) ----------

export interface DocxBlockInfo {
  id: number;                       // stable for the session; never reused
  kind: 'paragraph' | 'opaque';     // opaque = table, sdt, altChunk, anything not a w:p
  parentId: number | null;          // null = direct child of w:body; otherwise the id of the enclosing table block (§8.1)
  cell?: { row: number; col: number }; // 0-based w:tr / w:tc ordinal inside the table `parentId`; present iff parentId !== null
  editable: boolean;                // false => lockReason set
  lockReason?: 'tracked-changes' | 'multi-paragraph-field' | 'unknown-content' | 'opaque' | 'merged-cell';
  removable: boolean;               // §8.5
  style: { kind: 'normal' | 'heading' | 'other'; level?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; name: string };
  list: { kind: 'none' | 'bullet' | 'number' | 'other'; level: number };
}

export interface DocxRunCss {
  color?: string; fontSizePt?: number; fontFamily?: string;
  highlight?: string; strike?: boolean; vertAlign?: 'super' | 'sub'; styleClass?: string;
}

export type DocxSegment =
  | { kind: 'text'; id: number; text: string; b: boolean; i: boolean; u: boolean; css: DocxRunCss }
  | { kind: 'atom'; id: number; label: string; atomType: 'image' | 'field' | 'hyperlink' | 'footnote' | 'break' | 'math' | 'object' }
  | { kind: 'anchor'; id: number };            // zero-width, invisible, must round-trip

export type DocxCommitItem =
  | { kind: 'text'; text: string; b: boolean; i: boolean; u: boolean; src: number | null } // src = id of the text segment whose run properties it inherits
  | { kind: 'atom'; id: number }
  | { kind: 'anchor'; id: number };

export type DocxEditOp =
  | { op: 'commitParagraph'; blockId: number; items: DocxCommitItem[] }
  | { op: 'splitParagraph'; blockId: number; before: DocxCommitItem[]; after: DocxCommitItem[] }
  | { op: 'mergeWithPrevious'; blockId: number; items: DocxCommitItem[] }   // items = this block's current content
  | { op: 'insertParagraphAfter'; blockId: number | null }                 // null = at document start; a block inside a cell inserts into that cell
  | { op: 'removeParagraph'; blockId: number }
  | { op: 'setStyle'; blockIds: number[]; style: 'normal' | { heading: 1 | 2 | 3 | 4 | 5 | 6 } }
  | { op: 'setList'; blockIds: number[]; list: 'none' | 'bullet' | 'number' }
  | { op: 'setListLevel'; blockIds: number[]; delta: 1 | -1 };

export type DocxToWebview = OfficeCommonToWebview
  | { type: 'docxRender'; version: number; bytes: Uint8Array; blocks: DocxBlockInfo[] }
  | { type: 'docxBlockModel'; requestId: number; version: number; blockId: number; segments: DocxSegment[] }
  | { type: 'docxEditResult'; requestId: number; ok: true; version: number;
      blocks: DocxBlockInfo[];              // full, current block list (cheap: a few bytes per block)
      changedBlockIds: number[]; focus?: { blockId: number; at: 'start' | 'end' | number } }
  | { type: 'docxEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'docxStateChanged'; version: number };   // undo/redo/revert/reload: webview requests a new render

export type DocxToHost = OfficeCommonToHost
  | { type: 'docxRequestRender' }
  | { type: 'docxRequestBlockModel'; requestId: number; blockId: number }
  | { type: 'docxEdit'; requestId: number; baseVersion: number; edit: DocxEditOp };

// ---------- Excel (§5.2) ----------

export type XlsxRange = [number, number, number, number];   // [r0, c0, r1, c1], inclusive, 0-based

export interface XlsxSheetInfo {
  id: number;                 // session-stable id, NOT the tab index
  name: string;
  kind: 'worksheet' | 'chartsheet' | 'other';
  state: 'visible' | 'hidden' | 'veryHidden';
  canEdit: boolean; readOnlyReason: ReadOnlyReason | null;
}

export interface XlsxSheetMeta {
  sheetId: number; version: number;
  rowCount: number; colCount: number;          // used range, min 100 x 26 for an empty sheet
  defaultColWidthPx: number; defaultRowHeightPx: number;
  colWidthsPx: Array<[col: number, px: number]>;   // sparse overrides, 0-based
  rowHeightsPx: Array<[row: number, px: number]>;
  hiddenCols: number[]; hiddenRows: number[];
  merges: Array<[r0: number, c0: number, r1: number, c1: number]>;
  frozenRows: number; frozenCols: number;
  notices: OfficeNotice[];                     // e.g. "3 charts and 1 image are not shown (preserved)"
}

export interface XlsxCell {
  r: number; c: number;
  d: string;                   // display string (already number-formatted)
  s: number;                   // index into the style table sent with the batch
  k: 'n' | 's' | 'b' | 'e' | 'd' | 'z';   // number, string, boolean, error, date-formatted number, empty-but-styled
  v?: number;                  // raw numeric value when k is 'n' or 'd' (selection Sum/Average use it, as Excel does)
  f?: true;                    // has a formula
  stale?: true;                // formula whose cached value is missing or may be out of date (§9.5)
  link?: string;               // hyperlink target
  note?: string;               // legacy comment text (read-only tooltip)
  ro?: true;                   // cell-level lock (array member, rich value, table header) (§9.4)
}

export interface XlsxStyle {   // resolved, CSS-ready; colours already theme/tint resolved
  bold?: true; italic?: true; underline?: true; strike?: true;
  color?: string; fill?: string; fontFamily?: string; fontSizePt?: number;
  h?: 'left' | 'center' | 'right' | 'justify'; v?: 'top' | 'middle' | 'bottom';
  wrap?: true; indent?: number;
  border?: { t?: string; r?: string; b?: string; l?: string };   // CSS border shorthand
  autoColor?: true;            // font colour is "automatic": follow theme (§11.1)
}

export type XlsxEditOp =
  | { op: 'setCells'; sheetId: number; cells: Array<{ r: number; c: number; input: string }> } // input is what the user typed
  | { op: 'clearCells'; sheetId: number; range: [number, number, number, number] }
  | { op: 'insertRows' | 'deleteRows'; sheetId: number; at: number; count: number }
  | { op: 'insertCols' | 'deleteCols'; sheetId: number; at: number; count: number }
  | { op: 'addSheet'; name?: string; afterSheetId?: number }
  | { op: 'renameSheet'; sheetId: number; name: string }
  | { op: 'deleteSheet'; sheetId: number };

export type XlsxToWebview = OfficeCommonToWebview
  | { type: 'xlsxWorkbook'; version: number; sheets: XlsxSheetInfo[]; activeSheetId: number }
  | { type: 'xlsxSheetMeta'; meta: XlsxSheetMeta }
  | { type: 'xlsxCells'; requestId: number; sheetId: number; version: number;
      range: [number, number, number, number]; cells: XlsxCell[]; styles: Record<number, XlsxStyle> }
  | { type: 'xlsxCellInput'; requestId: number; sheetId: number; r: number; c: number; input: string } // text to seed the cell editor
  | { type: 'xlsxEditResult'; requestId: number; ok: true; version: number;
      invalidate: 'cells' | 'sheet' | 'workbook'; sheetId?: number; range?: [number, number, number, number] }
  | { type: 'xlsxEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'xlsxFindResult'; requestId: number; matches: Array<{ sheetId: number; r: number; c: number }>; truncated: boolean }
  | { type: 'xlsxStateChanged'; version: number; invalidate: 'sheet' | 'workbook'; sheetId?: number };

export type XlsxToHost = OfficeCommonToHost
  | { type: 'xlsxRequestSheetMeta'; sheetId: number }
  | { type: 'xlsxRequestCells'; requestId: number; sheetId: number; range: [number, number, number, number] }
  | { type: 'xlsxRequestCellInput'; requestId: number; sheetId: number; r: number; c: number }
  | { type: 'xlsxEdit'; requestId: number; baseVersion: number; edit: XlsxEditOp }
  | { type: 'xlsxFind'; requestId: number; query: string; matchCase: boolean; sheetId: number | null }
  | { type: 'xlsxCopy'; sheetId: number; range: [number, number, number, number]; format: 'tsv' | 'markdown' };

export type OfficeToHost = DocxToHost | XlsxToHost;

/** Exhaustive over every inbound `type`; adding a message without updating this fails to compile. */
export function isOfficeToHost(msg: { type: string }): msg is OfficeToHost {
  const m = msg as OfficeToHost;
  switch (m.type) {
    case 'ready': case 'setEditMode': case 'flushed': case 'openLink': case 'openExternally':
    case 'retry': case 'writeClipboard': case 'showAbout':
    case 'docxRequestRender': case 'docxRequestBlockModel': case 'docxEdit':
    case 'xlsxRequestSheetMeta': case 'xlsxRequestCells': case 'xlsxRequestCellInput':
    case 'xlsxEdit': case 'xlsxFind': case 'xlsxCopy':
      return true;
    default: {
      const _never: never = m;
      void _never;
      return false;
    }
  }
}

// ---------- Inbound validation (§5 "the host never trusts the webview") ----------
// Structural checks only: types, integer-ness, ranges, caps. Semantic checks (does the block
// exist, is the href scheme allowed) belong to the host. Each parser rebuilds a clean object
// (unknown extra keys are dropped) and returns null on any violation. They never throw.

/** Structural caps. Spec §10.2 / §5 values where given; the rest are generous sanity bounds. */
export const PROTOCOL_LIMITS = {
  MAX_ID: Number.MAX_SAFE_INTEGER,
  /** §10.2: more than 20,000 blocks makes a document view-only, so an edit never references more. */
  MAX_BLOCK_IDS: 20000,
  MAX_COMMIT_ITEMS: 200000,
  MAX_ITEM_TEXT: 10_000_000,
  /** §5.2 / spec: at most 10,000 cells per setCells. */
  MAX_CELLS: 10000,
  /** Excel cell text limit. */
  MAX_CELL_CHARS: 32767,
  /** Excel grid bounds (0-based indices must be below these). */
  MAX_ROWS: 1048576,
  MAX_COLS: 16384,
  MAX_HREF: 32767,
  MAX_CLIPBOARD: 50_000_000,
  MAX_QUERY: 32767,
  MAX_SHEET_NAME: 32767,
} as const;

type Rec = Record<string, unknown>;
const L = PROTOCOL_LIMITS;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function isIdx(v: unknown, max: number): v is number {
  return isId(v) && v < max;
}
function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function parseRange(v: unknown): XlsxRange | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [r0, c0, r1, c1] = v as unknown[];
  if (!isIdx(r0, L.MAX_ROWS) || !isIdx(r1, L.MAX_ROWS) || !isIdx(c0, L.MAX_COLS) || !isIdx(c1, L.MAX_COLS)) return null;
  if (r0 > r1 || c0 > c1) return null;
  return [r0, c0, r1, c1];
}

function parseBlockIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > L.MAX_BLOCK_IDS) return null;
  for (const x of v) if (!isId(x)) return null;
  return v.slice() as number[];
}

/** Common messages (§5). Returns null for anything that is not a well-formed common message. */
export function parseCommonToHost(raw: unknown): OfficeCommonToHost | null {
  if (!isRec(raw)) return null;
  switch (raw.type) {
    case 'ready': return { type: 'ready' };
    case 'openExternally': return { type: 'openExternally' };
    case 'retry': return { type: 'retry' };
    case 'showAbout': return { type: 'showAbout' };
    case 'setEditMode':
      return isBool(raw.editMode) ? { type: 'setEditMode', editMode: raw.editMode } : null;
    case 'flushed':
      return isId(raw.flushId) ? { type: 'flushed', flushId: raw.flushId } : null;
    case 'openLink':
      return isStr(raw.href, L.MAX_HREF) ? { type: 'openLink', href: raw.href } : null;
    case 'writeClipboard':
      return isStr(raw.text, L.MAX_CLIPBOARD) ? { type: 'writeClipboard', text: raw.text } : null;
    default: return null;
  }
}

function parseCommitItems(v: unknown): DocxCommitItem[] | null {
  if (!Array.isArray(v) || v.length > L.MAX_COMMIT_ITEMS) return null;
  const out: DocxCommitItem[] = [];
  for (const it of v) {
    if (!isRec(it)) return null;
    if (it.kind === 'text') {
      if (!isStr(it.text, L.MAX_ITEM_TEXT) || !isBool(it.b) || !isBool(it.i) || !isBool(it.u)) return null;
      if (it.src !== null && !isId(it.src)) return null;
      out.push({ kind: 'text', text: it.text, b: it.b, i: it.i, u: it.u, src: it.src });
    } else if (it.kind === 'atom') {
      if (!isId(it.id)) return null;
      out.push({ kind: 'atom', id: it.id });
    } else if (it.kind === 'anchor') {
      if (!isId(it.id)) return null;
      out.push({ kind: 'anchor', id: it.id });
    } else return null;
  }
  return out;
}

function parseDocxEditOp(v: unknown): DocxEditOp | null {
  if (!isRec(v)) return null;
  switch (v.op) {
    case 'commitParagraph': {
      const items = parseCommitItems(v.items);
      return isId(v.blockId) && items ? { op: 'commitParagraph', blockId: v.blockId, items } : null;
    }
    case 'splitParagraph': {
      const before = parseCommitItems(v.before);
      const after = parseCommitItems(v.after);
      return isId(v.blockId) && before && after ? { op: 'splitParagraph', blockId: v.blockId, before, after } : null;
    }
    case 'mergeWithPrevious': {
      const items = parseCommitItems(v.items);
      return isId(v.blockId) && items ? { op: 'mergeWithPrevious', blockId: v.blockId, items } : null;
    }
    case 'insertParagraphAfter':
      if (v.blockId === null) return { op: 'insertParagraphAfter', blockId: null };
      return isId(v.blockId) ? { op: 'insertParagraphAfter', blockId: v.blockId } : null;
    case 'removeParagraph':
      return isId(v.blockId) ? { op: 'removeParagraph', blockId: v.blockId } : null;
    case 'setStyle': {
      const blockIds = parseBlockIds(v.blockIds);
      if (!blockIds) return null;
      if (v.style === 'normal') return { op: 'setStyle', blockIds, style: 'normal' };
      if (isRec(v.style) && typeof v.style.heading === 'number' && Number.isInteger(v.style.heading)
        && v.style.heading >= 1 && v.style.heading <= 6) {
        return { op: 'setStyle', blockIds, style: { heading: v.style.heading as 1 | 2 | 3 | 4 | 5 | 6 } };
      }
      return null;
    }
    case 'setList': {
      const blockIds = parseBlockIds(v.blockIds);
      if (!blockIds || (v.list !== 'none' && v.list !== 'bullet' && v.list !== 'number')) return null;
      return { op: 'setList', blockIds, list: v.list };
    }
    case 'setListLevel': {
      const blockIds = parseBlockIds(v.blockIds);
      if (!blockIds || (v.delta !== 1 && v.delta !== -1)) return null;
      return { op: 'setListLevel', blockIds, delta: v.delta };
    }
    default: return null;
  }
}

/** Word inbound messages: the common set plus docx*. */
export function parseDocxToHost(raw: unknown): DocxToHost | null {
  if (!isRec(raw)) return null;
  switch (raw.type) {
    case 'docxRequestRender': return { type: 'docxRequestRender' };
    case 'docxRequestBlockModel':
      return isId(raw.requestId) && isId(raw.blockId)
        ? { type: 'docxRequestBlockModel', requestId: raw.requestId, blockId: raw.blockId } : null;
    case 'docxEdit': {
      if (!isId(raw.requestId) || !isId(raw.baseVersion)) return null;
      const edit = parseDocxEditOp(raw.edit);
      return edit ? { type: 'docxEdit', requestId: raw.requestId, baseVersion: raw.baseVersion, edit } : null;
    }
    default: return parseCommonToHost(raw);
  }
}

function parseXlsxEditOp(v: unknown): XlsxEditOp | null {
  if (!isRec(v)) return null;
  switch (v.op) {
    case 'setCells': {
      if (!isId(v.sheetId) || !Array.isArray(v.cells) || v.cells.length === 0 || v.cells.length > L.MAX_CELLS) return null;
      const cells: Array<{ r: number; c: number; input: string }> = [];
      for (const c of v.cells as unknown[]) {
        if (!isRec(c) || !isIdx(c.r, L.MAX_ROWS) || !isIdx(c.c, L.MAX_COLS) || !isStr(c.input, L.MAX_CELL_CHARS)) return null;
        cells.push({ r: c.r, c: c.c, input: c.input });
      }
      return { op: 'setCells', sheetId: v.sheetId, cells };
    }
    case 'clearCells': {
      const range = parseRange(v.range);
      return isId(v.sheetId) && range ? { op: 'clearCells', sheetId: v.sheetId, range } : null;
    }
    case 'insertRows': case 'deleteRows': {
      if (!isId(v.sheetId) || !isIdx(v.at, L.MAX_ROWS) || !isId(v.count) || v.count < 1 || v.count > L.MAX_ROWS) return null;
      return { op: v.op, sheetId: v.sheetId, at: v.at, count: v.count };
    }
    case 'insertCols': case 'deleteCols': {
      if (!isId(v.sheetId) || !isIdx(v.at, L.MAX_COLS) || !isId(v.count) || v.count < 1 || v.count > L.MAX_COLS) return null;
      return { op: v.op, sheetId: v.sheetId, at: v.at, count: v.count };
    }
    case 'addSheet': {
      const out: { op: 'addSheet'; name?: string; afterSheetId?: number } = { op: 'addSheet' };
      if (v.name !== undefined) { if (!isStr(v.name, L.MAX_SHEET_NAME)) return null; out.name = v.name; }
      if (v.afterSheetId !== undefined) { if (!isId(v.afterSheetId)) return null; out.afterSheetId = v.afterSheetId; }
      return out;
    }
    case 'renameSheet':
      return isId(v.sheetId) && isStr(v.name, L.MAX_SHEET_NAME)
        ? { op: 'renameSheet', sheetId: v.sheetId, name: v.name } : null;
    case 'deleteSheet':
      return isId(v.sheetId) ? { op: 'deleteSheet', sheetId: v.sheetId } : null;
    default: return null;
  }
}

/** Excel inbound messages: the common set plus xlsx*. */
export function parseXlsxToHost(raw: unknown): XlsxToHost | null {
  if (!isRec(raw)) return null;
  switch (raw.type) {
    case 'xlsxRequestSheetMeta':
      return isId(raw.sheetId) ? { type: 'xlsxRequestSheetMeta', sheetId: raw.sheetId } : null;
    case 'xlsxRequestCells': {
      const range = parseRange(raw.range);
      if (!isId(raw.requestId) || !isId(raw.sheetId) || !range) return null;
      // Spec §5.2: requests are at most 20,000 cells.
      if ((range[2] - range[0] + 1) * (range[3] - range[1] + 1) > 20000) return null;
      return { type: 'xlsxRequestCells', requestId: raw.requestId, sheetId: raw.sheetId, range };
    }
    case 'xlsxRequestCellInput':
      return isId(raw.requestId) && isId(raw.sheetId) && isIdx(raw.r, L.MAX_ROWS) && isIdx(raw.c, L.MAX_COLS)
        ? { type: 'xlsxRequestCellInput', requestId: raw.requestId, sheetId: raw.sheetId, r: raw.r, c: raw.c } : null;
    case 'xlsxEdit': {
      if (!isId(raw.requestId) || !isId(raw.baseVersion)) return null;
      const edit = parseXlsxEditOp(raw.edit);
      return edit ? { type: 'xlsxEdit', requestId: raw.requestId, baseVersion: raw.baseVersion, edit } : null;
    }
    case 'xlsxFind': {
      if (!isId(raw.requestId) || !isStr(raw.query, L.MAX_QUERY) || !isBool(raw.matchCase)) return null;
      if (raw.sheetId !== null && !isId(raw.sheetId)) return null;
      return { type: 'xlsxFind', requestId: raw.requestId, query: raw.query, matchCase: raw.matchCase, sheetId: raw.sheetId };
    }
    case 'xlsxCopy': {
      const range = parseRange(raw.range);
      if (!isId(raw.sheetId) || !range || (raw.format !== 'tsv' && raw.format !== 'markdown')) return null;
      return { type: 'xlsxCopy', sheetId: raw.sheetId, range, format: raw.format };
    }
    default: return parseCommonToHost(raw);
  }
}
