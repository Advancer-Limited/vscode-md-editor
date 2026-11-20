// Formula references, slice 1 (WP-21; spec §9.4, §9.5): validation and relative translation.
// WP-36 adds structural reference shifting (§9.6) to this file.
//
// validateFormula(text)            `@borgar/fx` tokenize + parse; also refuses what parses but Excel would
//                                  report as a corrupt file (a leading '=', the `#` spill and `@`
//                                  intersection operators — stored by Excel as ANCHORARRAY()/SINGLE() —,
//                                  control characters, more than 8,192 characters).
// translateFormula(text, dR, dC)   the formula as Excel shows it in a cell dR rows / dC columns from the
//                                  original (shared-formula materialisation, §9.4): relative row/column
//                                  parts of A1 references move, `$` parts stay, references pushed off the
//                                  sheet become `#REF!`; every other character is preserved.
//
// Why translateFormula works per token rather than through translateFormulaToR1C1 → translateFormulaToA1
// (the plan's S7 note): the R1C1 round trip re-tokenises in R1C1 mode, so a defined name that looks
// like an R1C1 reference (`R1C1`, `RC`) turns into a cell reference, and it collapses `A1:A1` to `A1`,
// so translating by (0, 0) is not the identity. Here only `range`/`range_beam` tokens are rewritten, by
// adjusting the digits/letters of their relative parts in place.
//
// No `vscode` import here (core rule).

import { parse, tokenize } from '@borgar/fx/xlsx';
import { MAX_COLS, MAX_ROWS } from './sheet.js';

export { addXlfnPrefixes, stripXlfnPrefixes } from './xlfn.js';

/** Excel's limit on the length of a formula's contents. */
export const MAX_FORMULA_CHARS = 8192;

export type FormulaCheck = { ok: true } | { ok: false; position: number; message: string };

/** Whether `text` (no leading '=') is a formula Excel will accept from the file. `position` is a 0-based offset into `text`. */
export function validateFormula(text: string): FormulaCheck {
  if (text.length === 0) return { ok: false, position: 0, message: 'The formula is empty' };
  if (text.length > MAX_FORMULA_CHARS) return { ok: false, position: MAX_FORMULA_CHARS, message: `A formula can have at most ${MAX_FORMULA_CHARS.toLocaleString('en-US')} characters` };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if ((ch < 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) || ch === 0xfffe || ch === 0xffff) {
      return { ok: false, position: i, message: 'The formula contains a control character' };
    }
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return { ok: false, position: i, message: 'The formula contains an invalid character' };
    }
    if (ch >= 0xdc00 && ch <= 0xdfff) return { ok: false, position: i, message: 'The formula contains an invalid character' };
  }
  let tokens: ReturnType<typeof tokenize>;
  try {
    tokens = tokenize(text, { withLocation: true, allowTernary: false });
  } catch (err) {
    return { ok: false, position: offsetOf(err, text), message: messageOf(err) };
  }
  for (const t of tokens) {
    const at = t.loc ? t.loc[0] : 0;
    if (t.type === 'fx_prefix') return { ok: false, position: at, message: 'Unexpected "="' };
    if (t.type === 'operator' && t.value === '#') return { ok: false, position: at, message: 'The spill operator # is not supported here; use ANCHORARRAY(reference)' };
    if (t.type === 'operator' && t.value === '@') return { ok: false, position: at, message: 'The @ operator is not supported here; use SINGLE(value)' };
  }
  try {
    parse(tokens);
  } catch (err) {
    return { ok: false, position: offsetOf(err, text), message: messageOf(err) };
  }
  return { ok: true };
}

function offsetOf(err: unknown, text: string): number {
  const o = (err as { sourceOffset?: unknown } | null)?.sourceOffset;
  return typeof o === 'number' && Number.isFinite(o) ? Math.max(0, Math.min(text.length, o)) : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Invalid syntax';
}

// ---------------------------------------------------------------------------------------------------
// Relative translation

/** Thrown when a reference token has a shape this module does not understand (callers refuse the edit). */
export class FormulaTranslateError extends Error {
  constructor(message: string) { super(message); this.name = 'FormulaTranslateError'; }
}

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;
const ROW_RE = /^(\$?)([0-9]+)$/;

function colToIndex(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + ((s.charCodeAt(i) | 32) - 96);
  return n - 1;
}

function indexToCol(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** One endpoint shifted, or null when it leaves the sheet. */
function shiftEndpoint(p: string, dRow: number, dCol: number, beam: 'none' | 'col' | 'row'): string | null {
  const col = (abs: string, letters: string): string | null => {
    if (abs || dCol === 0) return abs + letters;
    const c = colToIndex(letters) + dCol;
    return c >= 0 && c < MAX_COLS ? indexToCol(c) : null;
  };
  const row = (abs: string, digits: string): string | null => {
    if (abs || dRow === 0) return abs + digits;
    const r = parseInt(digits, 10) + dRow;
    return r >= 1 && r <= MAX_ROWS ? String(r) : null;
  };
  let m: RegExpExecArray | null;
  if (beam === 'none' && (m = CELL_RE.exec(p))) {
    const a = col(m[1], m[2]);
    const b = row(m[3], m[4]);
    return a === null || b === null ? null : a + b;
  }
  if (beam !== 'row' && (m = COL_RE.exec(p))) return col(m[1], m[2]);
  if (beam !== 'col' && (m = ROW_RE.exec(p))) return row(m[1], m[2]);
  throw new FormulaTranslateError(`Unrecognised reference part "${p}"`);
}

/** Split a reference token into its sheet prefix (through the last '!' outside quotes/brackets) and the A1 part. */
function splitRef(v: string): [string, string] {
  let cut = 0;
  let quoted = false;
  let bracket = 0;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (quoted) {
      if (ch === "'") { if (v[i + 1] === "'") i++; else quoted = false; }
    } else if (ch === "'") quoted = true;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '!' && bracket === 0) cut = i + 1;
  }
  return [v.slice(0, cut), v.slice(cut)];
}

function shiftRefToken(value: string, beamToken: boolean, dRow: number, dCol: number): string {
  const [prefix, a1] = splitRef(value);
  if (/^#REF!$/i.test(a1)) return value;
  const parts = a1.split(':');
  if (parts.length > 2 || parts.some((p) => p === '')) throw new FormulaTranslateError(`Unrecognised reference "${value}"`);
  let beam: 'none' | 'col' | 'row' = 'none';
  if (beamToken) {
    if (parts.length !== 2) throw new FormulaTranslateError(`Unrecognised reference "${value}"`);
    beam = COL_RE.test(parts[0]) && COL_RE.test(parts[1]) ? 'col' : ROW_RE.test(parts[0]) && ROW_RE.test(parts[1]) ? 'row' : 'none';
    if (beam === 'none') throw new FormulaTranslateError(`Unrecognised reference "${value}"`);
  }
  const shifted: string[] = [];
  for (const p of parts) {
    if (!beamToken && !CELL_RE.test(p)) throw new FormulaTranslateError(`Unrecognised reference "${value}"`);
    const s = shiftEndpoint(p, dRow, dCol, beam);
    if (s === null) return '#REF!';
    shifted.push(s);
  }
  return prefix + shifted.join(':');
}

/**
 * `text` as it reads dRow rows down and dCol columns right of the cell it was written for (relative
 * references move, `$` parts stay, off-sheet references become `#REF!`). Throws FormulaTranslateError for
 * text that cannot be tokenised or a reference shape it does not recognise.
 */
export function translateFormula(text: string, dRow: number, dCol: number): string {
  if (!Number.isInteger(dRow) || !Number.isInteger(dCol)) throw new FormulaTranslateError('Offsets must be integers');
  let tokens: ReturnType<typeof tokenize>;
  try {
    tokens = tokenize(text, { withLocation: false, allowTernary: false });
  } catch (err) {
    throw new FormulaTranslateError(messageOf(err));
  }
  let orig = '';
  let out = '';
  for (const t of tokens) {
    orig += t.value;
    if ((t.type === 'range' || t.type === 'range_beam') && (dRow !== 0 || dCol !== 0)) out += shiftRefToken(t.value, t.type === 'range_beam', dRow, dCol);
    else out += t.value;
  }
  if (orig !== text) throw new FormulaTranslateError('The formula could not be tokenised losslessly');
  return out;
}
