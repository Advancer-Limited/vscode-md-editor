// Xlsx edit operations: the single entry point from the provider (spec §5.2 XlsxEditOp, §9.3–§9.7).
//
// `applyXlsxEdit` turns one XlsxEditOp into one OfficeEdit through an EditBuilder. The builder applies
// as it records, so on `ok: true` with a non-null `edit` the package ALREADY HOLDS the edit: the
// caller records it for undo/redo (e.g. `undoRedoFor`) and must not apply it again. On `ok: false`
// nothing changed: setCells checks every target and every formula before writing any cell, and a
// refusal that only shows while writing aborts the builder and rebuilds the sheet index (and reloads
// the style table) from the restored tree, so the read model never keeps a refused value. `edit: null` means the operation changed nothing (or is
// waiting for the `confirm` list to be accepted: call again with `confirmed: true`).
//
// Dispatch (plan §3.2 — every later WP replaces only its own module):
//   setCells / clearCells            here, with sheet.writeCell (WP-20)
//     formula input                  sharedFormula.setFormula (WP-21)
//     editing/clearing a shared master  sharedFormula.materialiseGroup (WP-21)
//     date input into a General cell stylesWrite.dateStyleFor (WP-22)
//   insert/delete rows/columns       guards.checkStructuralOp (WP-39) -> structure.insertOrDelete (WP-38)
//   add/rename/delete sheet          guards.checkStructuralOp (WP-39) -> sheetsOps.* (WP-40)
// Every value, formula or structural edit also runs calc.ensureFullCalcOnLoad in the same edit (§9.5).
//
// Refusals (never best-effort, §10.1): view-only workbook or sheet, read-only cells (§9.3 `ro`), more
// than 10,000 cells, out-of-grid coordinates, over-long input, duplicate cells, namespace layouts the
// writer cannot express. A helper that throws an Error carrying `officeError` is reported as that error.
//
// After applying an edit from outside (undo, redo, revert), call `refreshAfterEdit` so the sheet
// list, the sheet indexes (and the grid lookups keyed on them) and the style table follow the tree. (The write path also detects a stale index on its own
// and retries once after rebuilding it.)
//
// No `vscode` import here (core rule).

import type { OfficeError } from '../types.js';
import type { OfficePackage } from '../package.js';
import { EditBuilder } from '../edits.js';
import type { OfficeEdit } from '../edits.js';
import { XmlScopeError, escapeText } from '../xml.js';
import type { XlsxEditOp } from '../../protocol.js';
import type { Workbook } from './workbook.js';
import { SheetLoadError } from './workbook.js';
import { IndexStaleError, MAX_COLS, MAX_ROWS } from './sheet.js';
import type { Range, Sheet } from './sheet.js';
import type { CellRead } from './types.js';
import { StyleTable } from './styles.js';
import { editSeed } from './format.js';
import { classifyInput, encodeXstring, numberToXml } from './input.js';
import { ensureFullCalcOnLoad } from './calc.js';
import { formulaInputError, isUnchangedFormula, materialiseGroup, setFormula } from './sharedFormula.js';
import { formulaContextOf } from './refs.js';
import type { FormulaContext } from './refs.js';
import { dateStyleFor } from './stylesWrite.js';
import { insertOrDelete } from './structure.js';
import { checkStructuralOp } from './guards.js';
import { addSheet, deleteSheet, renameSheet, syncSheetEntries } from './sheetsOps.js';
import { partNameFromTarget, readRelationships, relsPartFor } from '../opc.js';

export type OpResult =
  | { ok: true; edit: OfficeEdit | null; invalidate: 'cells' | 'sheet' | 'workbook'; sheetId?: number; range?: Range; confirm?: string[] }
  | { ok: false; error: OfficeError };

export interface ApplyOptions {
  /** The user accepted the operation's Tier C confirmation list (§9.6). */
  confirmed: boolean;
  /** The provider's style table for this workbook; one is created (and cached per workbook) when omitted. */
  styles?: StyleTable;
}

/** Spec §5.2 limits (PROTOCOL_LIMITS mirrors them; core may not import values from protocol.ts). */
export const MAX_SET_CELLS = 10_000;
export const MAX_INPUT_CHARS = 32_767;

const fail = (code: OfficeError['code'], message: string): OpResult => ({ ok: false, error: { code, message } });

const stylesCache = new WeakMap<Workbook, StyleTable>();

/** The style table ops.ts uses for `wb` when the caller does not pass one. */
export function stylesFor(wb: Workbook): StyleTable {
  let s = stylesCache.get(wb);
  if (!s) {
    s = StyleTable.load(wb.pkg, wb.stylesPart, wb.themePart);
    stylesCache.set(wb, s);
  }
  return s;
}

/**
 * Bring the read models in line with the tree after `edit` was applied, undone or redone from
 * outside: re-read the sheet list when it touches the workbook part (an added, renamed or deleted
 * sheet: sheetsOps.syncSheetEntries), rebuild the index of every loaded sheet whose part — or whose
 * relationships part, or a part those relationships target (tables, comments) — it touches, and
 * reload the style table when it touches the styles part. Rebuilding bumps the sheet's
 * structureGeneration, which drops the grid's hyperlink and locked-range lookups (view.ts).
 */
export function refreshAfterEdit(wb: Workbook, edit: OfficeEdit, styles?: StyleTable): void {
  const parts = refreshParts(wb, edit.changes.map((c) => c.part));
  if (wb.stylesPart && parts.has(wb.stylesPart.toLowerCase())) {
    (styles ?? stylesFor(wb)).reload();
    if (styles && stylesCache.get(wb) !== styles) stylesCache.get(wb)?.reload();
  }
}

/**
 * Bring `wb` (and `styles`) in line with its package after changes that are not known one by one (VS
 * Code's undo/redo applies an edit inside OfficeDocument): as refreshAfterEdit with every part changed.
 * The sheet list is re-read by syncSheetEntries, so session sheet ids stay stable (review S4 / K14):
 * dropping the model instead would number the sheets by position again and move the webview's tab.
 */
export function refreshAfterUnknownEdit(wb: Workbook, styles?: StyleTable): void {
  refreshParts(wb, [...wb.pkg.partNames(), wb.workbookPart]);
  (styles ?? stylesFor(wb)).reload();
  const cached = stylesCache.get(wb);
  if (styles && cached && cached !== styles) cached.reload();
}

/** The sheet-list and sheet-index half of refreshAfterEdit for the changed `parts`; returns them lower-cased. */
function refreshParts(wb: Workbook, changed: readonly string[]): Set<string> {
  const parts = new Set(changed.map((p) => p.toLowerCase()));
  if (parts.has(wb.workbookPart.toLowerCase())) syncSheetEntries(wb);
  for (const e of wb.sheets) {
    const s = wb.loadedSheet(e.id);
    if (s && sheetTouched(wb, s, parts)) s.rebuildIndex();
  }
  return parts;
}

/** Whether `parts` (lower-case) include `sheet`'s part, its relationships part or a part they target. */
function sheetTouched(wb: Workbook, sheet: Sheet, parts: ReadonlySet<string>): boolean {
  if (parts.has(sheet.part.toLowerCase())) return true;
  const rels = relsPartFor(sheet.part);
  if (parts.has(rels.toLowerCase())) return true;
  if (!wb.pkg.has(rels)) return false;
  let list;
  try { list = readRelationships(wb.pkg, sheet.part); } catch { return true; }
  for (const r of list) {
    if (r.external) continue;
    try { if (parts.has(partNameFromTarget(sheet.part, r.target).toLowerCase())) return true; } catch { /* not a part */ }
  }
  return false;
}

export async function applyXlsxEdit(wb: Workbook, pkg: OfficePackage, op: XlsxEditOp, opts: ApplyOptions): Promise<OpResult> {
  if (wb.pkg !== pkg) return fail('internal', 'The workbook model does not belong to this package.');
  const viewOnly = wb.viewOnlyReason;
  if (viewOnly) return fail('read-only', `This workbook can't be edited here (${viewOnly}).`);
  switch (op.op) {
    case 'setCells': return setCells(wb, op, opts);
    case 'clearCells': return clearCells(wb, op, opts);
    case 'insertRows': case 'deleteRows': case 'insertCols': case 'deleteCols': return structural(wb, op, opts);
    case 'addSheet': case 'renameSheet': case 'deleteSheet': return sheetOp(wb, op, opts);
    default: return fail('invalid', 'Unknown edit operation.');
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared plumbing

/** The editable worksheet `sheetId`, or the refusal. */
async function editableSheet(wb: Workbook, sheetId: number): Promise<Sheet | OpResult> {
  const e = wb.entry(sheetId);
  if (!e) return fail('invalid', `There is no sheet with id ${sheetId}.`);
  if (e.kind !== 'worksheet') return fail('read-only', `"${e.name}" is not a worksheet and can't be edited.`);
  let sheet: Sheet;
  try {
    sheet = await wb.sheet(sheetId);
  } catch (err) {
    if (err instanceof SheetLoadError) return fail('read-only', err.message);
    return fail('internal', err instanceof Error ? err.message : String(err));
  }
  if (sheet.doc !== wb.pkg.xml(sheet.part)) return fail('stale', `Sheet "${e.name}" was replaced; reload it before editing.`);
  if (sheet.readOnlyReason) {
    return fail('read-only', sheet.readOnlyReason === 'protected'
      ? `Sheet "${e.name}" is protected.` : `Sheet "${e.name}" can't be edited here (${sheet.readOnlyReason}).`);
  }
  if (sheet.truncatedAtRow !== null) return fail('read-only', `Sheet "${e.name}" is too large to edit.`);
  return sheet;
}

const isResult = (x: unknown): x is OpResult => typeof x === 'object' && x !== null && 'ok' in x;

/** Map an exception from a write to a result (the builder has already been aborted). */
function errorResult(err: unknown): OpResult {
  const carried = (err as { officeError?: OfficeError } | null)?.officeError;
  if (carried && typeof carried.code === 'string') return { ok: false, error: { code: carried.code, message: carried.message } };
  if (err instanceof XmlScopeError) return fail('blocked', "This part uses a namespace layout the editor can't write to safely.");
  return fail('internal', err instanceof Error ? err.message : String(err));
}

/** Thrown inside a cell-op body to stop with a result; the builder is aborted. */
class Refusal extends Error {
  readonly result: OpResult;
  constructor(result: OpResult) { super('refused'); this.result = result; }
}

/**
 * Run `body` with a fresh builder. A stale sheet index (an outside undo/redo since it was built) is
 * repaired by aborting, rebuilding the index and running once more. Any error aborts the builder.
 *
 * Aborting rolls the trees back, but the sheet index (and the style table, after a date-style patch)
 * were updated as the body wrote: they would keep pointing at the detached nodes and serve the
 * refused values. So whenever an aborted body had written anything, the index of `sheet` is rebuilt
 * from the restored tree and the style table reloaded when the styles part was among the writes.
 */
function runCellEdit(wb: Workbook, sheet: Sheet, styles: StyleTable, label: string, body: (b: EditBuilder) => void): OfficeEdit | null | OpResult {
  for (let attempt = 0; ; attempt++) {
    const b = new EditBuilder(wb.pkg, label);
    try {
      body(b);
      if (b.size === 0) { b.abort(); return null; }
      ensureFullCalcOnLoad(b, wb);
      return b.finish();
    } catch (err) {
      const written = b.changedParts().map((p) => p.toLowerCase());
      b.abort();
      if (written.length > 0) restoreReadModels(wb, sheet, styles, written);
      if (err instanceof IndexStaleError && attempt === 0) { sheet.rebuildIndex(); continue; }
      if (err instanceof IndexStaleError) { sheet.rebuildIndex(); return fail('stale', 'The sheet changed while editing; try again.'); }
      if (err instanceof Refusal) return err.result;
      return errorResult(err);
    }
  }
}

/** After an abort that had written `parts` (lower-case): bring the read models back in line with the trees. */
function restoreReadModels(wb: Workbook, sheet: Sheet, styles: StyleTable, parts: readonly string[]): void {
  if (parts.includes(sheet.part.toLowerCase())) sheet.rebuildIndex();
  if (wb.stylesPart && parts.includes(wb.stylesPart.toLowerCase())) {
    styles.reload();
    const cached = stylesCache.get(wb);
    if (cached && cached !== styles) cached.reload();
  }
}

function roRefusal(why: string): Refusal {
  return new Refusal(fail('read-only', `This edit includes a cell that can't be changed here: ${why}.`));
}

function afterCellEdit(wb: Workbook, styles: StyleTable, edit: OfficeEdit | null): void {
  if (edit && wb.stylesPart && edit.changes.some((c) => c.part.toLowerCase() === wb.stylesPart!.toLowerCase())) styles.reload();
}

// ---------------------------------------------------------------------------------------------------
// setCells (§9.3) — Edit Cell / Paste Cells

async function setCells(wb: Workbook, op: Extract<XlsxEditOp, { op: 'setCells' }>, opts: ApplyOptions): Promise<OpResult> {
  const cells = op.cells;
  if (!Array.isArray(cells)) return fail('invalid', 'No cells given.');
  if (cells.length > MAX_SET_CELLS) return fail('invalid', `At most ${MAX_SET_CELLS.toLocaleString('en-US')} cells can be changed at once.`);
  const seen = new Set<number>();
  for (const cell of cells) {
    const { r, c, input } = cell;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) return fail('invalid', 'A cell is outside the sheet.');
    if (typeof input !== 'string') return fail('invalid', 'Cell input must be text.');
    if (input.length > MAX_INPUT_CHARS) return fail('invalid', `Cell input is limited to ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters.`);
    const key = r * MAX_COLS + c;
    if (seen.has(key)) return fail('invalid', 'The same cell is given twice.');
    seen.add(key);
  }
  const sheetOrError = await editableSheet(wb, op.sheetId);
  if (isResult(sheetOrError)) return sheetOrError;
  const sheet = sheetOrError;
  if (cells.length === 0) return { ok: true, edit: null, invalidate: 'cells', sheetId: op.sheetId };
  const styles = opts.styles ?? stylesFor(wb);
  const label = cells.length > 1 ? 'Paste Cells' : 'Edit Cell';

  const result = runCellEdit(wb, sheet, styles, label, (b) => {
    // 1. Every target must be editable before anything is written (paste is all-or-nothing).
    for (const { r, c } of cells) {
      const why = sheet.readOnlyCellReason(r, c);
      if (why) throw roRefusal(why);
    }
    // 2. Every formula must be valid before anything is written: a refusal half-way through would
    //    leave nothing written (the builder rolls back) but is cheaper and clearer caught here.
    let fctx: FormulaContext | undefined | null = null;
    const formulaCtx = (): FormulaContext | undefined => (fctx === null ? (fctx = formulaContextOf(wb.pkg)) : fctx);
    for (const { r, c, input } of cells) {
      const planned = classifyCell(wb, sheet, styles, r, c, input);
      if (planned?.k.kind !== 'formula') continue;
      const err = formulaInputError(sheet, r, c, planned.k.text, formulaCtx());
      if (err) throw new Refusal({ ok: false, error: err });
    }
    // 3. Grow the dimension once for all the cells that will be created.
    let box: [number, number, number, number] | null = null;
    for (const { r, c, input } of cells) {
      if (input === '' || sheet.cell(r, c)) continue;
      box = box ? [Math.min(box[0], r), Math.min(box[1], c), Math.max(box[2], r), Math.max(box[3], c)] : [r, c, r, c];
    }
    if (box) sheet.ensureDimensionCovers(b, box);
    // 4. Write.
    const dateCache = new Map<string, number>();
    const noticeCodes = new Set<string>();
    for (const { r, c, input } of cells) writeOne(b, wb, sheet, styles, r, c, input, dateCache, noticeCodes, formulaCtx);
  });
  if (isResult(result)) return result;
  afterCellEdit(wb, styles, result);
  return { ok: true, edit: result, invalidate: 'cells', sheetId: op.sheetId, range: bounds(cells) };
}

/**
 * How (r, c) would store `input`: null when committing it changes nothing (the editor's unchanged
 * seed, or a formula cell's own formula), else the cell as it is, its effective style and the class.
 */
function classifyCell(wb: Workbook, sheet: Sheet, styles: StyleTable, r: number, c: number, input: string):
  { existing: CellRead | undefined; style: number; k: ReturnType<typeof classifyInput> } | null {
  const existing = sheet.cell(r, c);
  // Committing the editor's unchanged seed changes nothing (keeps rich text, shared strings, cached
  // formula results and error values exactly as they are).
  if (existing && input === editSeed(existing, styles, wb.date1904)) return null;
  const style = existing ? existing.styleIndex : sheet.inheritedStyle(r, c);
  const k = classifyInput(input, { isPercentStyle: styles.isPercentStyle(style), isTextStyle: styles.isTextStyle(style), date1904: wb.date1904 });
  // Re-committing a formula cell's formula (shown without `_xlfn.` prefixes, or as a shared
  // dependant's materialised text) changes nothing.
  if (k.kind === 'formula' && isUnchangedFormula(sheet, existing, k.text)) return null;
  return { existing, style, k };
}

function writeOne(b: EditBuilder, wb: Workbook, sheet: Sheet, styles: StyleTable, r: number, c: number, input: string,
  dateCache: Map<string, number>, noticeCodes: Set<string>, formulaCtx: () => FormulaContext | undefined): void {
  const planned = classifyCell(wb, sheet, styles, r, c, input);
  if (!planned) return;
  const { existing, style, k } = planned;
  // A shared-formula master is materialised before it changes (§9.4; setFormula does it for formula
  // input); dependants just lose their f.
  if (existing?.shared?.master && k.kind !== 'formula') materialiseGroup(b, sheet, existing.shared.si);
  const inherited = !existing && style > 0 ? style : undefined;
  const v = sheet.elementName('v');
  switch (k.kind) {
    case 'clear':
      sheet.writeCell(b, r, c, null);
      return;
    case 'formula': {
      const err = setFormula(b, sheet, r, c, k.text, formulaCtx());
      if (err) throw new Refusal({ ok: false, error: err });
      return;
    }
    case 'number':
      sheet.writeCell(b, r, c, { s: inherited, inner: `<${v}>${numberToXml(k.value)}</${v}>` });
      return;
    case 'boolean':
      sheet.writeCell(b, r, c, { t: 'b', s: inherited, inner: `<${v}>${k.value ? 1 : 0}</${v}>` });
      return;
    case 'text':
      sheet.writeCell(b, r, c, { t: 'inlineStr', s: inherited, inner: inlineString(sheet, k.text) });
      return;
    case 'date': {
      let s = inherited;
      if (styles.isGeneralStyle(style)) {
        // General (id 0, or a custom format whose code is "General"): the date style patch (§9.3.1) picks or appends a date xf, or falls back to text.
        const d = dateStyleFor(b, styles, style, k.withTime, dateCache);
        if ('fallback' in d) {
          if (!noticeCodes.has(d.notice.code)) { noticeCodes.add(d.notice.code); b.notice(d.notice); }
          sheet.writeCell(b, r, c, { t: 'inlineStr', s: inherited, inner: inlineString(sheet, input) });
          return;
        }
        if (d.styleIndex !== style) s = d.styleIndex;
      }
      sheet.writeCell(b, r, c, { s, inner: `<${v}>${numberToXml(k.serial)}</${v}>` });
      return;
    }
  }
}

/** `<is><t xml:space="preserve">…</t></is>` (spec §9.3: edited text is always an inline string). */
function inlineString(sheet: Sheet, text: string): string {
  const is = sheet.elementName('is');
  const t = sheet.elementName('t');
  return `<${is}><${t} xml:space="preserve">${escapeText(encodeXstring(text))}</${t}></${is}>`;
}

function bounds(cells: ReadonlyArray<{ r: number; c: number }>): Range {
  let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
  for (const { r, c } of cells) { r0 = Math.min(r0, r); c0 = Math.min(c0, c); r1 = Math.max(r1, r); c1 = Math.max(c1, c); }
  return [r0, c0, r1, c1];
}

// ---------------------------------------------------------------------------------------------------
// clearCells (§9.3 "empty") — Clear Cells

async function clearCells(wb: Workbook, op: Extract<XlsxEditOp, { op: 'clearCells' }>, opts: ApplyOptions): Promise<OpResult> {
  const rg = op.range;
  if (!Array.isArray(rg) || rg.length !== 4 || !rg.every((n) => Number.isInteger(n) && n >= 0)) return fail('invalid', 'Invalid range.');
  const range: Range = [Math.min(rg[0], rg[2]), Math.min(rg[1], rg[3]), Math.max(rg[0], rg[2]), Math.max(rg[1], rg[3])];
  if (range[2] >= MAX_ROWS || range[3] >= MAX_COLS) return fail('invalid', 'The range is outside the sheet.');
  const sheetOrError = await editableSheet(wb, op.sheetId);
  if (isResult(sheetOrError)) return sheetOrError;
  const sheet = sheetOrError;
  const styles = opts.styles ?? stylesFor(wb);

  const result = runCellEdit(wb, sheet, styles, 'Clear Cells', (b) => {
    for (const area of sheet.readOnlyAreas()) {
      const a = area.range;
      if (a[0] <= range[2] && a[2] >= range[0] && a[1] <= range[3] && a[3] >= range[1]) {
        const r = Math.max(a[0], range[0]), c = Math.max(a[1], range[1]);
        const why = sheet.readOnlyCellReason(r, c);
        if (why) throw roRefusal(why);
      }
    }
    const targets = sheet.cellsIn(range);
    for (const cell of targets) {
      const why = sheet.readOnlyCellReason(cell.r, cell.c);
      if (why) throw roRefusal(why);
    }
    for (const cell of targets) {
      const cur = sheet.cell(cell.r, cell.c);   // materialisation may have rewritten it
      if (!cur) continue;
      if (cur.shared?.master) materialiseGroup(b, sheet, cur.shared.si);
      sheet.writeCell(b, cell.r, cell.c, null);
    }
  });
  if (isResult(result)) return result;
  afterCellEdit(wb, styles, result);
  return { ok: true, edit: result, invalidate: 'cells', sheetId: op.sheetId, range };
}

// ---------------------------------------------------------------------------------------------------
// Structure (§9.6) and sheets (§9.7): guards, confirmation, then the owning module.

const STRUCT_LABELS = { insertRows: 'Insert Rows', deleteRows: 'Delete Rows', insertCols: 'Insert Columns', deleteCols: 'Delete Columns' } as const;
const SHEET_LABELS = { addSheet: 'Add Sheet', renameSheet: 'Rename Sheet', deleteSheet: 'Delete Sheet' } as const;

async function guard(wb: Workbook, op: XlsxEditOp, opts: ApplyOptions): Promise<OpResult | string[] | null> {
  let g: { blocked?: string; confirm?: string[] };
  try { g = await checkStructuralOp(wb, wb.pkg, op); } catch (err) { return errorResult(err); }
  if (g.blocked) return fail('blocked', g.blocked);
  if (g.confirm && g.confirm.length > 0 && !opts.confirmed) return g.confirm;
  return null;
}

async function structural(wb: Workbook, op: Extract<XlsxEditOp, { op: 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols' }>, opts: ApplyOptions): Promise<OpResult> {
  if (!Number.isInteger(op.at) || !Number.isInteger(op.count) || op.at < 0 || op.count < 1) return fail('invalid', 'Invalid position or count.');
  const axis = op.op === 'insertRows' || op.op === 'deleteRows' ? 'row' : 'col';
  if (op.at >= (axis === 'row' ? MAX_ROWS : MAX_COLS)) return fail('invalid', 'The position is outside the sheet.');
  const sheetOrError = await editableSheet(wb, op.sheetId);
  if (isResult(sheetOrError)) return sheetOrError;
  const g = await guard(wb, op, opts);
  if (isResult(g)) return g;
  if (g) return { ok: true, edit: null, invalidate: 'sheet', sheetId: op.sheetId, confirm: g };
  const b = new EditBuilder(wb.pkg, STRUCT_LABELS[op.op]);
  try {
    // count > 0 inserts, < 0 deletes (the StructuralShift convention of WP-36).
    await insertOrDelete(b, wb, sheetOrError, axis, op.at, op.op.startsWith('insert') ? op.count : -op.count);
    if (b.size > 0) ensureFullCalcOnLoad(b, wb);
  } catch (err) {
    // insertOrDelete rebuilt the indexes from what it wrote; a failure after it (calc handling)
    // rolls those writes back, so the indexes follow the restored tree again.
    const written = b.changedParts();
    b.abort();
    if (written.length > 0) refreshParts(wb, written);
    return errorResult(err);
  }
  return { ok: true, edit: b.finish(), invalidate: 'sheet', sheetId: op.sheetId };
}

async function sheetOp(wb: Workbook, op: Extract<XlsxEditOp, { op: 'addSheet' | 'renameSheet' | 'deleteSheet' }>, opts: ApplyOptions): Promise<OpResult> {
  if (wb.structureLocked) return fail('read-only', 'The workbook structure is protected: sheets cannot be added, renamed or deleted.');
  if (op.op !== 'addSheet' && !wb.entry(op.sheetId)) return fail('invalid', `There is no sheet with id ${op.sheetId}.`);
  const g = await guard(wb, op, opts);
  if (isResult(g)) return g;
  if (g) return { ok: true, edit: null, invalidate: 'workbook', confirm: g };
  const b = new EditBuilder(wb.pkg, SHEET_LABELS[op.op]);
  // The operations re-read wb.sheets as they write. After an abort the list is put back as it was,
  // so every sheet keeps its session id (the webview still holds them): a sheet whose deletion was
  // rolled back has a re-created tree, so its cached model is dropped and reloads under the same id.
  // Indexes of the sheets the operation had rewritten follow the restored nodes.
  const sheetsBefore = wb.sheets;
  const abort = (): void => {
    const written = b.changedParts();
    b.abort();
    wb.sheets = sheetsBefore;
    for (const e of wb.sheets) {
      const s = wb.loadedSheet(e.id);
      if (s && (!wb.pkg.has(s.part) || s.doc !== wb.pkg.xml(s.part))) wb.forgetSheet(e.id);
    }
    syncSheetEntries(wb);
    refreshParts(wb, written);
  };
  try {
    const err = op.op === 'addSheet' ? addSheet(b, wb, op.name, op.afterSheetId)
      : op.op === 'renameSheet' ? renameSheet(b, wb, op.sheetId, op.name)
        : deleteSheet(b, wb, op.sheetId);
    if (err) { abort(); return { ok: false, error: err }; }
    // Rename and delete rewrite formulas (§9.7), so Excel must recalculate; adding a sheet does not
    // (and keeps the calc chain: no formula changed).
    if (op.op !== 'addSheet' && b.size > 0) ensureFullCalcOnLoad(b, wb);
  } catch (err) {
    abort();
    return errorResult(err);
  }
  const edit = b.finish();
  // Rename and delete rewrite formulas on other sheets: their indexes must follow the new nodes.
  if (edit) refreshParts(wb, edit.changes.map((c) => c.part));
  return { ok: true, edit, invalidate: 'workbook' };
}
