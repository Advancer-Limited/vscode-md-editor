// Formula references, slice 1 (WP-21; spec §9.4, §9.5): validation and relative translation.
// WP-36 adds structural reference shifting (§9.6) to this file.
//
// checkFormulaSyntax(text)         `@borgar/fx` tokenize + parse; also refuses what parses but Excel would
//                                  report as a corrupt file (a leading '=', the `#` spill and `@`
//                                  intersection operators — stored by Excel as ANCHORARRAY()/SINGLE() —,
//                                  control characters, more than 8,192 characters).
// validateFormula(text, ctx?)      checkFormulaSyntax plus what parses but Excel still refuses (§9.5):
//                                  argument counts of the functions Excel knows (functions.ts; an unknown
//                                  name is not checked), a call whose arguments are all empty
//                                  (`SUM(,)`), more than 255 arguments, ragged array constants, text
//                                  constants over 255 characters, number constants outside
//                                  ±9.99999999999999E+307, a top-level union (`A1,B1` outside
//                                  parentheses), Lotus `A1..B2` ranges, a lone column name as a range end
//                                  (`A1:B`), unquoted sheet names that need quotes (`Sheet 1!A1`,
//                                  `A1!B1`), structured references without a table name, and references
//                                  to other workbooks (`[1]Sheet1!A1`, `[Book2.xlsx]Sheet1!A1`; code
//                                  `blocked`). With a workbook context (formulaContextOf) it also requires
//                                  every sheet, table and table column a reference names to exist.
// formulaContextOf(pkg)            that context: sheet names, tables with their columns, defined names.
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

import { parse, parseA1Ref, parseStructRef, tokenize } from '@borgar/fx/xlsx';
import type { OfficePackage } from '../package.js';
import { attr, child, childrenOf } from '../xml.js';
import { mainPart, partNameFromTarget, readRelationships } from '../opc.js';
import { MAX_COLS, MAX_ROWS } from './sheet.js';
import { FUNCTION_ARITY, MAX_FUNCTION_ARGS } from './functions.js';

export { addXlfnPrefixes, stripXlfnPrefixes } from './xlfn.js';
export { FUNCTION_ARITY, MAX_FUNCTION_ARGS } from './functions.js';

/** Excel's limit on the length of a formula's contents. */
export const MAX_FORMULA_CHARS = 8192;
/** Excel's limit on a text constant inside a formula. */
export const MAX_FORMULA_STRING_CHARS = 255;
/** The largest magnitude Excel accepts for a number (it refuses 1E+308). */
export const MAX_EXCEL_NUMBER = 9.99999999999999e307;

/** `code: 'blocked'` marks a formula this editor does not write although Excel could (references to other workbooks). */
export type FormulaCheck = { ok: true } | { ok: false; position: number; message: string; code?: 'blocked' };

/**
 * What a formula may refer to in its workbook. Names are compared case-insensitively: every set
 * holds names folded with `foldName`.
 */
export interface FormulaContext {
  /** Every sheet name of the workbook. */
  sheetNames: ReadonlySet<string>;
  /** Table name -> its column names, or null when they could not be read (columns are then not checked). */
  tables: ReadonlyMap<string, ReadonlySet<string> | null>;
  /** Workbook- and sheet-level defined names (without any sheet qualifier). */
  definedNames: ReadonlySet<string>;
}

/** The case folding used for sheet, table, column and defined names. */
export const foldName = (s: string): string => s.toLocaleUpperCase('en-US');

type Tokens = ReturnType<typeof tokenize>;
type Parsed = { ok: true; tokens: Tokens; ast: unknown } | { ok: false; position: number; message: string };

/** Whether `text` (no leading '=') parses as a formula Excel will read from the file. `position` is a 0-based offset into `text`. */
export function checkFormulaSyntax(text: string): FormulaCheck {
  const p = parseFormula(text);
  return p.ok ? { ok: true } : p;
}

/**
 * Whether `text` (no leading '=') is a formula Excel accepts (see the header); with `ctx`, also that
 * the sheets, tables and columns it names exist. `position` is a 0-based offset into `text`.
 */
export function validateFormula(text: string, ctx?: FormulaContext): FormulaCheck {
  const p = parseFormula(text);
  if (!p.ok) return p;
  return semanticCheck(p.tokens, p.ast, ctx);
}

function parseFormula(text: string): Parsed {
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
  let tokens: Tokens;
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
  let ast: unknown;
  try {
    ast = parse(tokens);
  } catch (err) {
    return { ok: false, position: offsetOf(err, text), message: messageOf(err) };
  }
  return { ok: true, tokens, ast };
}

// ---------------------------------------------------------------------------------------------------
// Semantic checks (on the @borgar/fx AST)

/** Thrown inside the walk to stop at the first problem. */
class Reject {
  constructor(readonly position: number, readonly message: string, readonly blocked = false) {}
}

interface Node { type: string; loc?: [number, number]; [k: string]: unknown }

const FN_PREFIX_RE = /^(?:_xlfn\.|_xlws\.)+/i;
const XLPM_RE = /^_xlpm\./i;
/** A sheet name that may appear without quotes; Excel quotes every other name when it writes a reference. */
const BARE_SHEET_RE = /^[A-Za-z_\\¡-￿][A-Za-z0-9_.¡-￿]*$/;
const CELL_LIKE_RE = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/;
const R1C1_LIKE_RE = /^[Rr][0-9]*[Cc][0-9]*$|^[RrCc][0-9]*$/;
const COLUMN_ONLY_RE = /^[A-Za-z]{1,3}$/;
const LOTUS_RANGE_RE = /^\$?[A-Za-z]{1,3}\$?[0-9]+\./;

function semanticCheck(tokens: Tokens, ast: unknown, ctx: FormulaContext | undefined): FormulaCheck {
  try {
    topLevelUnion(tokens);
    walk(ast as Node | null, ctx, new Set());
  } catch (err) {
    if (err instanceof Reject) {
      return err.blocked
        ? { ok: false, position: err.position, message: err.message, code: 'blocked' }
        : { ok: false, position: err.position, message: err.message };
    }
    throw err;
  }
  return { ok: true };
}

/** A ',' outside every bracket is a union, which Excel does not accept unparenthesised at the top of a cell formula. */
function topLevelUnion(tokens: Tokens): void {
  let depth = 0;
  for (const t of tokens) {
    if (t.type !== 'operator') continue;
    if (t.value === '(' || t.value === '{') depth++;
    else if (t.value === ')' || t.value === '}') depth--;
    else if (t.value === ',' && depth === 0) {
      throw new Reject(t.loc ? t.loc[0] : 0, 'A union of references (,) must be inside parentheses, e.g. (A1,B1)');
    }
  }
}

const at = (n: Node | null | undefined): number => (n && Array.isArray(n.loc) ? n.loc[0] : 0);

function walk(n: Node | null, ctx: FormulaContext | undefined, locals: ReadonlySet<string>): void {
  if (!n || typeof n !== 'object') return;
  switch (n.type) {
    case 'CallExpression': {
      const callee = n.callee as Node;
      const args = (n.arguments as Array<Node | null>) ?? [];
      if (args.length > MAX_FUNCTION_ARGS) throw new Reject(at(n), `A function can have at most ${MAX_FUNCTION_ARGS} arguments`);
      if (callee && callee.type === 'Identifier') {
        const name = String(callee.name).replace(FN_PREFIX_RE, '').toUpperCase();
        const arity = locals.has(foldName(name)) ? undefined : FUNCTION_ARITY.get(name);
        if (arity) {
          const [min, max] = arity;
          if (args.length < min) throw new Reject(at(callee), `${name} needs at least ${min} argument${min === 1 ? '' : 's'}`);
          if (args.length > max) throw new Reject(at(callee), max === 0 ? `${name} takes no arguments` : `${name} takes at most ${max} argument${max === 1 ? '' : 's'}`);
          if (min >= 1 && args.length > 0 && args.every((a) => a === null)) throw new Reject(at(callee), `${name} needs a value for at least one argument`);
        }
      } else {
        walk(callee, ctx, locals);
      }
      for (const a of args) walk(a, ctx, locals);
      return;
    }
    case 'LambdaExpression': {
      const inner = new Set(locals);
      for (const p of (n.params as Node[] | undefined) ?? []) if (p && typeof p.name === 'string') inner.add(foldName(p.name.replace(XLPM_RE, '')));
      walk(n.body as Node, ctx, inner);
      return;
    }
    case 'LetExpression': {
      const inner = new Set(locals);
      for (const d of (n.declarations as Node[] | undefined) ?? []) {
        walk(d?.init as Node, ctx, inner);
        const id = d?.id as Node | undefined;
        if (id && typeof id.name === 'string') inner.add(foldName(id.name.replace(XLPM_RE, '')));
      }
      walk(n.body as Node, ctx, inner);
      return;
    }
    case 'BinaryExpression': {
      const args = (n.arguments as Array<Node | null>) ?? [];
      if (n.operator === ':') for (const a of args) rangeEnd(a, ctx, locals);
      for (const a of args) walk(a, ctx, locals);
      return;
    }
    case 'UnaryExpression':
      for (const a of (n.arguments as Array<Node | null>) ?? []) walk(a, ctx, locals);
      return;
    case 'ArrayExpression': {
      const rows = (n.elements as Array<Array<Node | null>> | undefined) ?? [];
      const width = rows.length > 0 ? rows[0].length : 0;
      for (const row of rows) {
        if (row.length !== width) throw new Reject(at(n), 'Every row of an array constant must have the same number of values');
        for (const el of row) walk(el, ctx, locals);
      }
      return;
    }
    case 'Literal':
      literal(n);
      return;
    case 'ReferenceIdentifier':
      reference(n, ctx);
      return;
    default:
      return;
  }
}

function literal(n: Node): void {
  const v = n.value;
  if (typeof v === 'string') {
    if (v.length > MAX_FORMULA_STRING_CHARS) throw new Reject(at(n), `Text in a formula is limited to ${MAX_FORMULA_STRING_CHARS} characters`);
    return;
  }
  if (typeof v === 'boolean') return;
  const raw = typeof n.raw === 'string' ? n.raw : '';
  // The parser gives a number that does not fit in a double as null.
  if (typeof v === 'number' ? !Number.isFinite(v) || Math.abs(v) > MAX_EXCEL_NUMBER : /^[+-]?[0-9.]/.test(raw)) {
    throw new Reject(at(n), 'A number in a formula must be between -9.99999999999999E+307 and 9.99999999999999E+307');
  }
}

/** An operand of the range operator: a lone column name (`A1:B`) is not a reference unless it is a defined or LET/LAMBDA name. */
function rangeEnd(n: Node | null, ctx: FormulaContext | undefined, locals: ReadonlySet<string>): void {
  if (!n || n.type !== 'ReferenceIdentifier' || n.kind !== 'name') return;
  const v = String(n.value);
  if (v.includes('!') || !COLUMN_ONLY_RE.test(v)) return;
  const fold = foldName(v);
  if (locals.has(fold) || ctx?.definedNames.has(fold)) return;
  throw new Reject(at(n), `"${v}" is not a reference here (a whole column is written ${v}:${v})`);
}

function reference(n: Node, ctx: FormulaContext | undefined): void {
  const value = String(n.value);
  const pos = at(n);
  if (n.kind === 'table') {
    let s: ReturnType<typeof parseStructRef>;
    try { s = parseStructRef(value); } catch { s = undefined; }
    if (!s) return;
    if (s.workbookName && s.workbookName !== '0') throw externalRef(pos);
    if (s.sheetName) sheetsExist(s.sheetName, pos, ctx);
    if (!s.table) throw new Reject(pos, 'A structured reference needs its table name here, e.g. Table1[Column]');
    if (!ctx) return;
    const cols = ctx.tables.get(foldName(s.table));
    if (cols === undefined) throw new Reject(pos, `There is no table named "${s.table}" in this workbook`);
    if (cols) for (const c of s.columns ?? []) if (!cols.has(foldName(c))) throw new Reject(pos, `Table "${s.table}" has no column "${c}"`);
    return;
  }
  const [prefix, local] = splitRef(value);
  if (prefix === '') {
    if (n.kind === 'name' && LOTUS_RANGE_RE.test(local)) throw new Reject(pos, `"${local}" is not a reference; a range is written with ":" (e.g. A1:B2)`);
    return;
  }
  let parsed: ReturnType<typeof parseA1Ref>;
  try { parsed = parseA1Ref(value, { allowNamed: true, allowTernary: false }); } catch { parsed = undefined; }
  const book = parsed ? parsed.workbookName : /^'?\[([^\]]*)\]/.exec(prefix)?.[1];
  // `[0]` is this workbook (Excel writes `[0]!Name` for a workbook-level name); any other book is external.
  if (book && book !== '0') throw externalRef(pos);
  let sheetPart = prefix.slice(0, -1);
  if (book === '0') {
    sheetPart = sheetPart.replace(/^\[0\]/, '').replace(/^'\[0\]/, "'");
    if (sheetPart === '') return;
  }
  if (!sheetPart.startsWith("'")) {
    for (const name of sheetPart.split(':')) {
      if (!BARE_SHEET_RE.test(name) || CELL_LIKE_RE.test(name) || R1C1_LIKE_RE.test(name)) {
        throw new Reject(pos, `The sheet name "${name}" must be in single quotes here: '${name}'!`);
      }
    }
  }
  const sheetName = parsed?.sheetName || (sheetPart.startsWith("'") ? sheetPart.slice(1, -1).replace(/''/g, "'") : sheetPart);
  sheetsExist(sheetName, pos, ctx);
}

function sheetsExist(sheetName: string, pos: number, ctx: FormulaContext | undefined): void {
  if (!ctx) return;
  for (const name of sheetName.split(':')) {
    if (!ctx.sheetNames.has(foldName(name))) throw new Reject(pos, `There is no sheet named "${name}" in this workbook`);
  }
}

function externalRef(pos: number): Reject {
  return new Reject(pos, "References to other workbooks can't be entered here", true);
}

// ---------------------------------------------------------------------------------------------------
// Workbook context

const NS_R = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];

/** `_xHHHH_` escapes (ST_Xstring) decoded, so table column names compare as Excel shows them. */
const decodeX = (s: string): string => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

function actualPart(pkg: OfficePackage, name: string): string | null {
  if (pkg.has(name)) return name;
  const key = name.toLowerCase();
  return pkg.partNames().find((n) => n.toLowerCase() === key) ?? null;
}

/**
 * The sheet names, tables (with their columns) and defined names of the workbook in `pkg`, for
 * validateFormula. Undefined when the workbook part cannot be read (contextual checks are then skipped).
 */
export function formulaContextOf(pkg: OfficePackage): FormulaContext | undefined {
  try {
    const wbPart = mainPart(pkg).name;
    const root = pkg.xml(wbPart).root;
    const ns = root.ns;
    const rels = readRelationships(pkg, wbPart);
    const sheetNames = new Set<string>();
    const tables = new Map<string, Set<string> | null>();
    const definedNames = new Set<string>();
    const sheets = child(root, ns, 'sheets');
    for (const el of sheets ? childrenOf(sheets, ns, 'sheet') : []) {
      sheetNames.add(foldName(attr(el, '', 'name') ?? ''));
      const id = NS_R.map((u) => attr(el, u, 'id')).find((v) => v !== undefined);
      const rel = id !== undefined ? rels.find((r) => r.id === id) : undefined;
      if (!rel || rel.external || !/\/worksheet$/.test(rel.type)) continue;
      let part: string | null;
      try { part = actualPart(pkg, partNameFromTarget(wbPart, rel.target)); } catch { continue; }
      if (!part) continue;
      for (const trel of readRelationships(pkg, part)) {
        if (trel.external || !/\/table$/.test(trel.type)) continue;
        let tp: string | null;
        try { tp = actualPart(pkg, partNameFromTarget(part, trel.target)); } catch { continue; }
        if (!tp) continue;
        const t = pkg.xml(tp).root;
        if (t.local !== 'table') continue;
        const name = attr(t, '', 'displayName') ?? attr(t, '', 'name');
        if (!name) continue;
        const colsEl = child(t, t.ns, 'tableColumns');
        const cols = colsEl ? new Set(childrenOf(colsEl, t.ns, 'tableColumn').map((c) => foldName(decodeX(attr(c, '', 'name') ?? '')))) : null;
        tables.set(foldName(name), cols);
      }
    }
    const dn = child(root, ns, 'definedNames');
    for (const d of dn ? childrenOf(dn, ns, 'definedName') : []) {
      const name = attr(d, '', 'name');
      if (name) definedNames.add(foldName(name));
    }
    return { sheetNames, tables, definedNames };
  } catch {
    return undefined;
  }
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
