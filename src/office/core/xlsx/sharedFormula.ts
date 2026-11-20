// Formula entry and shared-formula materialisation (spec §9.3 formula row, §9.4, §9.5).
//
// setFormula(b, sheet, r, c, text)   validates `text` (what the user typed after '=', without `_xlfn.`
//                                    prefixes), adds the file prefixes and writes `<f>` — a plain,
//                                    non-array formula — with no `<v>` (no calculation: the grid shows
//                                    "not calculated") and no `t`; `s` is kept (a new cell inherits the
//                                    row/column style). A formula that does not parse is rejected with its
//                                    position and nothing is written. Writing over a shared master first
//                                    materialises its group, so no dependant loses its formula.
//                                    Re-committing the formula a cell already has records nothing.
// materialiseGroup(b, sheet, si)     every cell of shared group `si` (master and dependants) gets its
//                                    explicit formula — the master's text with relative references moved
//                                    by the cell's offset from the master — and loses `t`/`si`/`ref`;
//                                    cached values, `t`, `s` and every other attribute/child are kept.
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
 * dependant the master's text translated to it. Undefined for a value cell, or a dependant whose
 * group has no master or cannot be translated.
 */
export function cellFormula(sheet: Sheet, cell: CellRead): string | undefined {
  if (cell.shared && !cell.shared.master) {
    const m = sheet.sharedMaster(cell.shared.si);
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

/** Write formula `text` (no '=') into (r, c); removes `<v>` and `t`. Null on success, else the refusal (nothing written). */
export function setFormula(b: EditBuilder, sheet: Sheet, r: number, c: number, text: string): OfficeError | null {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) {
    return { code: 'invalid', message: 'The cell is outside the sheet.' };
  }
  const check = validateFormula(text);
  if (!check.ok) return rejection(text, check.position, check.message);

  // The read-only check also verifies the index against the live tree (IndexStaleError when stale).
  const roWhy = sheet.readOnlyCellReason(r, c);
  if (roWhy) return { code: 'read-only', message: `This cell can't be changed here: ${roWhy}.` };
  let existing = sheet.cell(r, c);
  if (isUnchangedFormula(sheet, existing, text)) return null;

  const fileText = addXlfnPrefixes(text, existing?.formula !== undefined ? learnedPrefixes(existing.formula) : undefined);
  if (fileText.length > MAX_FORMULA_CHARS) {
    return { code: 'invalid', message: `This formula can't be used: with its function prefixes it is longer than ${MAX_FORMULA_CHARS.toLocaleString('en-US')} characters.` };
  }
  const again = validateFormula(fileText);
  if (!again.ok) return rejection(text, Math.min(text.length, again.position), again.message);

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
  const master = sheet.sharedMaster(si);
  if (!master) throw blocked(`The shared formula group ${si} on this sheet has no master cell, so its formulas can't be rewritten safely.`);
  if (master.formula === '') throw blocked(`The shared formula at ${rcToA1(master.r, master.c)} has no formula text.`);
  const members: CellRead[] = [];
  for (const cell of sheet.cellsIn([0, 0, MAX_ROWS - 1, MAX_COLS - 1])) {
    if (cell.shared && cell.shared.si === si) members.push(cell);
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
