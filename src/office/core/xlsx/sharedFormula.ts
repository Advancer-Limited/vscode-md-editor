// Formula entry and shared-formula materialisation (spec §9.3 formula row, §9.4, §9.5).
//
// formulaInputError(sheet, r, c, text, ctx?)
//                                    the refusal setFormula would give, without writing anything (ops.ts
//                                    checks a whole paste with it before writing any cell).
// setFormula(b, sheet, r, c, text, ctx?)
//                                    validates `text` (what the user typed after '=', without `_xlfn.`
//                                    prefixes), adds the file prefixes and writes `<f>` — a plain,
//                                    non-array formula — with no `<v>` (no calculation: the grid shows
//                                    "not calculated") and no `t`; `s` is kept (a new cell inherits the
//                                    row/column style). A formula refs.validateFormula refuses (with the
//                                    workbook context: sheets, tables) is rejected with its position and
//                                    nothing is written; references to other workbooks are `blocked`.
//                                    Writing over a shared master first materialises its group, so no
//                                    dependant loses its formula.
//                                    Re-committing the formula a cell already has records nothing.
// materialiseGroup(b, sheet, si)     every cell of shared group `si` (master and dependants) gets its
//                                    explicit formula — the master's text with relative references moved
//                                    by the cell's offset from the master — and loses `t`/`si`/`ref`;
//                                    cached values, `t`, `s` and every other attribute/child are kept.
//                                    A group with more than one master (a reused si) or with a member
//                                    outside its master's ref is refused (`blocked`), never guessed.
// materialiseAll(b, sheet)           every group of the sheet (structural operations, §9.6).
//
// All three record through the EditBuilder (applied as recorded; undo restores bytes exactly) and go
// through `Sheet.writeCell`, so the sheet index stays in step and a stale index throws IndexStaleError
// before anything is written. Failures that are the document's (a dependant without a master, a
// reference shape the translator does not know) throw an Error carrying `officeError` (`blocked`),
// which ops.ts reports as the result: the edit is refused, never guessed.
//
// No `vscode` import here (core rule).

import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import type { XmlElement } from '../xml.js';
import { attr, escapeText, serialize } from '../xml.js';
import type { CellRead, Sheet } from './sheet.js';
import { MAX_COLS, MAX_ROWS, rcToA1 } from './sheet.js';
import { MAX_FORMULA_CHARS, translateFormula, validateFormula } from './refs.js';
import type { FormulaCheck, FormulaContext } from './refs.js';
import { addXlfnPrefixes, learnedPrefixes, stripXlfnPrefixes } from './xlfn.js';

function blocked(message: string): Error {
  return Object.assign(new Error(message), { officeError: { code: 'blocked', message } as OfficeError });
}

/** The user-facing rejection for an invalid formula (1-based character of what was typed, '=' included). */
function rejection(text: string, position: number, message: string): OfficeError {
  const where = position >= text.length ? 'at the end of the formula' : `at character ${position + 2}`;
  return { code: 'invalid', message: `This formula can't be used: ${message.replace(/\.$/, '')} (${where}).` };
}

/** The `f` child of a cell element. */
function fChild(el: XmlElement): XmlElement | undefined {
  for (const ch of el.children) if (ch.type === 'el' && ch.ns === el.ns && ch.local === 'f') return ch;
  return undefined;
}

/**
 * The formula of `cell` as stored in the file (with `_xlfn.` prefixes): its own text, or for a shared
 * dependant the master's text translated to it (the master of its `si` whose `ref` covers it).
 * Undefined for a value cell, or a dependant no master covers or whose formula cannot be translated.
 */
export function cellFormula(sheet: Sheet, cell: CellRead): string | undefined {
  if (cell.shared && !cell.shared.master) {
    const m = sheet.sharedMaster(cell.shared.si, cell.r, cell.c);
    if (!m || m.formula === '') return undefined;
    try { return translateFormula(m.formula, cell.r - m.r, cell.c - m.c); } catch { return undefined; }
  }
  return cell.formula;
}

/** The formula as the editor shows it (no '=', no `_xlfn.`/`_xlws.`/`_xlpm.` prefixes); see cellFormula. */
export function displayFormula(sheet: Sheet, cell: CellRead): string | undefined {
  const f = cellFormula(sheet, cell);
  return f === undefined ? undefined : stripXlfnPrefixes(f);
}

/**
 * Whether committing formula `text` (typed, without '=') to `cell` would change nothing: the cell is a
 * plain or shared formula cell whose formula, shown or stored, is `text`.
 */
export function isUnchangedFormula(sheet: Sheet, cell: CellRead | undefined, text: string): boolean {
  if (!cell || cell.arrayRef !== undefined) return false;
  const f = cellFormula(sheet, cell);
  if (f === undefined) return false;
  return text === f || text === stripXlfnPrefixes(f) || addXlfnPrefixes(text, learnedPrefixes(f)) === f;
}

/** The refusal for formula check `check` of `text` (what was typed, without '='). */
function refusalFor(text: string, check: Extract<FormulaCheck, { ok: false }>, position = check.position): OfficeError {
  if (check.code === 'blocked') return { code: 'blocked', message: `This formula can't be used: ${check.message.replace(/\.$/, '')}.` };
  return rejection(text, position, check.message);
}

/**
 * Why formula `text` (no '=') can't be written into (r, c) — refused by refs.validateFormula in the
 * workbook context `ctx`, or too long with its function prefixes — or null when it can (or would
 * change nothing). Read-only cells are the caller's check. Writes nothing: ops.ts checks every
 * formula of a paste with this before writing any cell.
 */
export function formulaInputError(sheet: Sheet, r: number, c: number, text: string, ctx?: FormulaContext): OfficeError | null {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) {
    return { code: 'invalid', message: 'The cell is outside the sheet.' };
  }
  const check = validateFormula(text, ctx);
  // Re-committing the formula a cell already has is a no-op even when that formula (from the file)
  // would not pass today's checks.
  const existing = sheet.cell(r, c);
  if (!check.ok) return isUnchangedFormula(sheet, existing, text) ? null : refusalFor(text, check);
  if (isUnchangedFormula(sheet, existing, text)) return null;
  const fileText = addXlfnPrefixes(text, existing?.formula !== undefined ? learnedPrefixes(existing.formula) : undefined);
  if (fileText.length > MAX_FORMULA_CHARS) {
    return { code: 'invalid', message: `This formula can't be used: with its function prefixes it is longer than ${MAX_FORMULA_CHARS.toLocaleString('en-US')} characters.` };
  }
  const again = validateFormula(fileText, ctx);
  if (!again.ok) return refusalFor(text, again, Math.min(text.length, again.position));
  return null;
}

/**
 * Write formula `text` (no '=') into (r, c); removes `<v>` and `t`. Null on success, else the refusal
 * (nothing written). `ctx` is the workbook context for the reference checks (refs.formulaContextOf).
 */
export function setFormula(b: EditBuilder, sheet: Sheet, r: number, c: number, text: string, ctx?: FormulaContext): OfficeError | null {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) {
    return { code: 'invalid', message: 'The cell is outside the sheet.' };
  }
  // The read-only check also verifies the index against the live tree (IndexStaleError when stale).
  const roWhy = sheet.readOnlyCellReason(r, c);
  if (roWhy) return { code: 'read-only', message: `This cell can't be changed here: ${roWhy}.` };
  let existing = sheet.cell(r, c);
  if (isUnchangedFormula(sheet, existing, text)) return null;
  const err = formulaInputError(sheet, r, c, text, ctx);
  if (err) return err;
  const fileText = addXlfnPrefixes(text, existing?.formula !== undefined ? learnedPrefixes(existing.formula) : undefined);

  if (existing?.shared?.master) {
    materialiseGroup(b, sheet, existing.shared.si);
    existing = sheet.cell(r, c);
  }
  const f = sheet.elementName('f');
  const inherited = existing ? undefined : sheet.inheritedStyle(r, c);
  sheet.writeCell(b, r, c, { s: inherited !== undefined && inherited > 0 ? inherited : undefined, inner: `<${f}>${escapeText(fileText)}</${f}>` });
  return null;
}

/** Give every cell of shared group `si` its explicit formula and drop the group's t/si/ref. */
export function materialiseGroup(b: EditBuilder, sheet: Sheet, si: number): void {
  const masters = sheet.sharedMastersOf(si);
  if (masters.length === 0) throw blocked(`The shared formula group ${si} on this sheet has no master cell, so its formulas can't be rewritten safely.`);
  // A reused si (two masters) or a member outside its master's ref is a malformed group: which master
  // a dependant follows is not defined, so the edit is refused rather than guessed (§9.4).
  if (masters.length > 1) {
    throw blocked(`The shared formula group ${si} on this sheet has ${masters.length} master cells (${masters.map((m) => rcToA1(m.r, m.c)).join(', ')}), so its formulas can't be rewritten safely.`);
  }
  const master = masters[0];
  if (master.formula === '') throw blocked(`The shared formula at ${rcToA1(master.r, master.c)} has no formula text.`);
  const ref = master.ref;
  if (!ref) throw blocked(`The shared formula at ${rcToA1(master.r, master.c)} has a range "${master.refText}" that can't be read.`);
  const members: CellRead[] = [];
  for (const cell of sheet.cellsIn([0, 0, MAX_ROWS - 1, MAX_COLS - 1])) {
    if (!cell.shared || cell.shared.si !== si) continue;
    if (cell.r < ref[0] || cell.r > ref[2] || cell.c < ref[1] || cell.c > ref[3]) {
      throw blocked(`The shared formula cell ${rcToA1(cell.r, cell.c)} lies outside its group's range ${master.refText}, so its formulas can't be rewritten safely.`);
    }
    members.push(cell);
  }
  // Translate everything first: a failure refuses the edit before any cell is written.
  const texts: string[] = [];
  for (const cell of members) {
    const isMaster = cell.r === master.r && cell.c === master.c;
    if (isMaster) { texts.push(master.formula); continue; }
    let t: string;
    try { t = translateFormula(master.formula, cell.r - master.r, cell.c - master.c); } catch (err) {
      throw blocked(`The shared formula at ${rcToA1(master.r, master.c)} can't be rewritten for ${rcToA1(cell.r, cell.c)}: ${err instanceof Error ? err.message : String(err)}.`);
    }
    texts.push(t);
  }
  for (let k = 0; k < members.length; k++) materialiseCell(b, sheet, members[k], texts[k]);
}

/** Materialise every shared group of the sheet (structural operations). */
export function materialiseAll(b: EditBuilder, sheet: Sheet): void {
  const groups = new Set<number>();
  for (const cell of sheet.cellsIn([0, 0, MAX_ROWS - 1, MAX_COLS - 1])) if (cell.shared) groups.add(cell.shared.si);
  for (const si of [...groups].sort((x, y) => x - y)) materialiseGroup(b, sheet, si);
}

/** Rewrite one group member: plain `f` with `text`, everything else kept. */
function materialiseCell(b: EditBuilder, sheet: Sheet, cell: CellRead, text: string): void {
  const el = sheet.cellNode(cell.r, cell.c);
  if (!el) throw new Error(`materialise: no cell at ${rcToA1(cell.r, cell.c)}`);
  const fEl = fChild(el);
  if (!fEl) throw new Error(`materialise: ${rcToA1(cell.r, cell.c)} has no formula`);
  let fAttrs = '';
  for (const a of fEl.attrs) {
    if (a.ns === '' && (a.local === 't' || a.local === 'si' || a.local === 'ref')) continue;
    fAttrs += ((a as { pre?: string }).pre ?? ' ') + a.raw;
  }
  // The value children in their source order, the new f in the old f's place.
  let inner = '';
  for (const ch of el.children) {
    if (ch.type !== 'el' || ch.ns !== el.ns) continue;
    if (ch === fEl) inner += `<${fEl.rawName}${fAttrs}>${escapeText(text)}</${fEl.rawName}>`;
    else if (ch.local === 'v' || ch.local === 'is') inner += serialize(ch);
  }
  const t = attr(el, '', 't');
  sheet.writeCell(b, cell.r, cell.c, { t, inner });
}
