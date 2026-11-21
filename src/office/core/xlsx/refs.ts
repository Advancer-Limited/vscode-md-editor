// Formula references (spec §9.4–§9.7). Slice 1 (WP-21): validation and relative translation. Slice 2
// (WP-36): structural shifting for row/column insert and delete (§9.6) and sheet rename/delete (§9.7).
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
// shiftFormula(text, shift, sheet)  references to shift.sheetName moved for a row/column insert or
//                                  delete (§9.6; see "Structural shifting" below for the exact rules).
// shiftRange / shiftSqref          the same rules on sheet-local A1 text (merges, dimension, hyperlink,
//                                  autoFilter, table and sortState refs; CF/DV/selection sqrefs).
// renameSheetInFormula / deleteSheetInFormula / formulaMentionsSheet / quoteSheetName   §9.7.
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
/**
 * A sheet name that may appear without quotes. Deliberately narrower than what Excel itself writes
 * bare: Excel refuses some non-ASCII names unquoted (`€x`, `•a`, `a»b`, `©`) and accepts others, and
 * the rule is not documented, so anything outside plain ASCII letters, digits, `_` and `.` is quoted
 * when a reference is written and must be quoted when one is typed (Excel accepts unnecessary quotes).
 */
const BARE_SHEET_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const CELL_LIKE_RE = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/;
const R1C1_LIKE_RE = /^[Rr][0-9]*[Cc][0-9]*$|^[RrCc][0-9]*$/;
const BOOLEAN_RE = /^(?:TRUE|FALSE)$/i;

/** True when sheet `name` must be in single quotes before `!` (also cell-, R1C1- and TRUE/FALSE-like names). */
function needsQuotes(name: string): boolean {
  return !BARE_SHEET_RE.test(name) || CELL_LIKE_RE.test(name) || R1C1_LIKE_RE.test(name) || BOOLEAN_RE.test(name);
}
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
      if (needsQuotes(name)) {
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

// ---------------------------------------------------------------------------------------------------
// Structural shifting (WP-36; spec §9.6) and sheet rename/delete rewriting (§9.7)
//
// Rules (Excel's, for one band of `count` rows/columns at 0-based index `at` on one sheet):
//  - Insert: every endpoint at or beyond `at` moves by `count`. So a range whose first row/column is
//    `at` (insertion at its top/left edge) moves whole, a range with `at` strictly inside it (or at
//    its last row/column) grows, and a range ending before `at` is unchanged. A reference whose start
//    is pushed past row 1,048,576 / column XFD becomes #REF!; a range whose start stays on the sheet
//    but whose end is pushed off is clamped to the last row/column (A1:A1048576 stays A1:A1048576).
//    [WP-37: confirm both against Excel.]
//  - Delete of band [at, at+n-1]: ranges before the band are unchanged, ranges after it move back by
//    n, a range wholly inside it becomes #REF!, a range partly inside it shrinks to what is left.
//  - `$` markers do not matter (unlike fill/translateFormula): absolute and relative parts move alike.
//  - Whole-row/column references (`3:5`, `$B:$D`) follow the same rules on their axis and are not
//    touched by operations on the other axis.
//  - Only references to the edited sheet move: qualified ones naming it (case-insensitive), and
//    unqualified ones when the formula lives on it. External references (`[1]Sheet1!A1`), defined-name
//    uses (`TaxRate`, `Sheet1!Name`), structured references (`Table1[Col]`), string literals and errors
//    are never rewritten; table extents are shifted by the caller through shiftRange.
//  - 3-D references (`Sheet1:Sheet3!A1`) are NOT shifted. shiftFormula reports `has3dSpanning` when
//    one may cover the edited sheet (with `sheetOrder`: when the edited sheet is an end of the span or
//    lies between its ends; without it: any local 3-D reference), and the structural operation is
//    then refused as Tier B (§9.6, WP-39) — the text returned is not meant to be written.
//  - A reference that becomes #REF! is written as a bare `#REF!`, dropping any sheet qualifier: Excel
//    writes `Sheet2!#REF!`, but `@borgar/fx` cannot parse that form, so the save-time validator would
//    refuse it. Both are the same error value. [WP-37: compare #REF! modulo the qualifier.]
//  - Two single-cell tokens joined by ':' on the edited sheet (`Sheet1!A1:Sheet1!B2`, accepted by Excel
//    though it never writes it) are shifted as one range. Other chains of the range operator
//    (`A1:B2:C3`, `A1:INDEX(…)`) are shifted per token.
//
// Why not mutate parseA1Ref's `range` and call stringifyA1Ref (the plan's S7 note): stringifyA1Ref
// collapses `A1:A1` to `A1`, unquotes `'Data'!` and upper-cases `a1`, so unrelated text would change and
// insert → delete would not restore the original. The same 0-based numbers are computed here, and only
// the digits/letters of the endpoints that move are replaced; the sheet prefix is kept verbatim.

/** One row/column insert (count > 0) or delete (count < 0) on a sheet. `at` is the 0-based first row/column of the band. */
export interface StructuralShift {
  sheetName: string;
  axis: 'row' | 'col';
  at: number;
  count: number;
}

export interface ShiftFormulaResult {
  text: string;
  changed: boolean;
  /** A 3-D reference (`Sheet1:Sheet3!A1`) may span the edited sheet: the operation must be refused (Tier B). */
  has3dSpanning: boolean;
}

interface Endpoint {
  colAbs: string;
  col: number | null;
  rowAbs: string;
  row: number | null;
  lower: boolean;
}

function parseEndpoint(p: string, beam: boolean): Endpoint {
  let m: RegExpExecArray | null;
  if (!beam && (m = CELL_RE.exec(p))) {
    const row = parseInt(m[4], 10) - 1;
    const col = colToIndex(m[2]);
    if (col >= MAX_COLS || row < 0 || row >= MAX_ROWS) throw new FormulaTranslateError(`Reference "${p}" is outside the sheet`);
    return { colAbs: m[1], col, rowAbs: m[3], row, lower: m[2] !== m[2].toUpperCase() };
  }
  if (beam && (m = COL_RE.exec(p))) {
    const col = colToIndex(m[2]);
    if (col >= MAX_COLS) throw new FormulaTranslateError(`Reference "${p}" is outside the sheet`);
    return { colAbs: m[1], col, rowAbs: '', row: null, lower: m[2] !== m[2].toUpperCase() };
  }
  if (beam && (m = ROW_RE.exec(p))) {
    const row = parseInt(m[2], 10) - 1;
    if (row < 0 || row >= MAX_ROWS) throw new FormulaTranslateError(`Reference "${p}" is outside the sheet`);
    return { colAbs: '', col: null, rowAbs: m[1], row, lower: false };
  }
  throw new FormulaTranslateError(`Unrecognised reference part "${p}"`);
}

function formatEndpoint(e: Endpoint): string {
  let s = '';
  if (e.col !== null) {
    const letters = indexToCol(e.col);
    s += e.colAbs + (e.lower ? letters.toLowerCase() : letters);
  }
  if (e.row !== null) s += e.rowAbs + String(e.row + 1);
  return s;
}

/** The 0-based interval [a, b] after the shift, or null when it is deleted or pushed off the sheet. */
function shiftInterval(a: number, b: number, at: number, count: number, max: number): [number, number] | null {
  if (count >= 0) {
    if (a >= at) a += count;
    if (b >= at) b += count;
    if (a > max - 1) return null;
    if (b > max - 1) b = max - 1;
    return [a, b];
  }
  const n = -count;
  const end = at + n - 1;
  if (b < at) return [a, b];
  if (a > end) return [a - n, b - n];
  if (a >= at && b <= end) return null;
  return [a < at ? a : at, b > end ? b - n : at - 1];
}

/** The endpoints after the shift (the same array when nothing moves), or null for #REF!. */
function shiftEndpoints(eps: Endpoint[], shift: StructuralShift): Endpoint[] | null {
  const key = shift.axis === 'row' ? 'row' : 'col';
  const max = shift.axis === 'row' ? MAX_ROWS : MAX_COLS;
  const v = eps.map((e) => e[key]);
  if (v.some((x) => x === null)) return eps; // a whole row/column on the other axis
  const nums = v as number[];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const r = shiftInterval(lo, hi, shift.at, shift.count, max);
  if (r === null) return null;
  if (r[0] === lo && r[1] === hi) return eps;
  // Endpoints keep their roles: a reversed B2:A1 stays reversed.
  const vals = eps.length === 1 ? [r[0]] : nums[0] <= nums[1] ? [r[0], r[1]] : [r[1], r[0]];
  return eps.map((e, i) => ({ ...e, [key]: vals[i] }));
}

function checkShift(shift: StructuralShift): void {
  const max = shift.axis === 'row' ? MAX_ROWS : shift.axis === 'col' ? MAX_COLS : NaN;
  const { at, count } = shift;
  const ok = Number.isInteger(at) && Number.isInteger(count) && at >= 0 && at < max && Math.abs(count) <= max && (count >= 0 || at - count <= max);
  if (!ok) throw new FormulaTranslateError('Invalid structural shift');
}

/** A sheet prefix (`Sheet1!`, `'My Sheet'!`, `[1]Sheet1!`, `Sheet1:Sheet3!`) taken apart. `book` is null when absent. */
interface Prefix { book: string | null; sheets: string[] }

function parsePrefix(prefix: string): Prefix | null {
  if (!prefix.endsWith('!')) return null;
  let body = prefix.slice(0, -1);
  if (body.startsWith("'")) {
    if (body.length < 2 || !body.endsWith("'")) return null;
    body = body.slice(1, -1).replace(/''/g, "'");
  }
  let book: string | null = null;
  if (body.startsWith('[')) {
    const close = body.indexOf(']');
    if (close < 0) return null;
    book = body.slice(1, close);
    body = body.slice(close + 1);
  }
  // Sheet names cannot contain ':' (§9.7), so a ':' always separates the two ends of a 3-D span.
  const sheets = body === '' ? [] : body.split(':');
  if (sheets.length > 2 || sheets.some((s) => s === '')) return null;
  return { book, sheets };
}

/** `name` as written before `!` in a reference: bare when Excel allows it, else in single quotes with `'` doubled. */
export function quoteSheetName(name: string): string {
  return needsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

function buildPrefix(p: Prefix): string {
  const book = p.book !== null ? `[${p.book}]` : '';
  const body = book + p.sheets.join(':');
  const quote = p.sheets.some(needsQuotes) || (p.book !== null && /[^A-Za-z0-9_.]/.test(p.book));
  return quote ? `'${body.replace(/'/g, "''")}'!` : body + '!';
}

const isLocalBook = (p: Prefix): boolean => p.book === null || p.book === '0';

/** Tokens of `text`; throws FormulaTranslateError when it cannot be tokenised losslessly. */
function tokensOf(text: string): Tokens {
  let tokens: Tokens;
  try {
    tokens = tokenize(text, { withLocation: false, allowTernary: false });
  } catch (err) {
    throw new FormulaTranslateError(messageOf(err));
  }
  let orig = '';
  for (const t of tokens) orig += t.value;
  if (orig !== text) throw new FormulaTranslateError('The formula could not be tokenised losslessly');
  return tokens;
}

/** Whether `sheet` is an end of, or with `order` lies inside, the 3-D span `sheets`. True without `order` or for unknown names. */
function spans(sheets: string[], sheet: string, order?: readonly string[]): boolean {
  const f = sheets.map(foldName);
  const target = foldName(sheet);
  if (f.includes(target) || !order) return true;
  const idx = order.map(foldName);
  const i = idx.indexOf(f[0]);
  const j = idx.indexOf(f[1]);
  const k = idx.indexOf(target);
  if (i < 0 || j < 0 || k < 0) return true;
  return k >= Math.min(i, j) && k <= Math.max(i, j);
}

interface RefInfo {
  prefix: string;
  parts: string[];
  /** 'shift' = on the edited sheet; 'other' = left alone; '3d' = a 3-D reference in this workbook. */
  target: 'shift' | 'other' | '3d';
  sheets: string[];
}

function refInfo(value: string, beam: boolean, shiftSheet: string, home: string | null): RefInfo {
  const [prefix, a1] = splitRef(value);
  const parts = a1.split(':');
  if (parts.length > 2 || parts.some((p) => p === '') || (beam && parts.length !== 2)) throw new FormulaTranslateError(`Unrecognised reference "${value}"`);
  if (prefix === '') {
    const mine = home !== null && home !== '' && foldName(home) === foldName(shiftSheet);
    return { prefix, parts, target: mine ? 'shift' : 'other', sheets: [] };
  }
  const p = parsePrefix(prefix);
  if (!p) throw new FormulaTranslateError(`Unrecognised sheet prefix in "${value}"`);
  if (!isLocalBook(p) || p.sheets.length === 0) return { prefix, parts, target: 'other', sheets: p.sheets };
  if (p.sheets.length === 2) return { prefix, parts, target: '3d', sheets: p.sheets };
  return { prefix, parts, target: foldName(p.sheets[0]) === foldName(shiftSheet) ? 'shift' : 'other', sheets: p.sheets };
}

/**
 * `text` (formula file syntax, no leading '=') with its references to `shift.sheetName` moved for the
 * insert/delete `shift` describes (rules above). `formulaSheetName` is the sheet the formula lives on
 * (its unqualified references belong to it); null or '' for a defined name, whose unqualified
 * references are then left alone. `sheetOrder` (the workbook's sheet names in order) narrows 3-D
 * detection. Throws FormulaTranslateError for an invalid shift, text that cannot be tokenised, or a
 * reference shape it does not recognise.
 */
export function shiftFormula(text: string, shift: StructuralShift, formulaSheetName: string | null, sheetOrder?: readonly string[]): ShiftFormulaResult {
  checkShift(shift);
  const tokens = tokensOf(text);
  let out = '';
  let has3dSpanning = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'range' && t.type !== 'range_beam') { out += t.value; continue; }
    const beam = t.type === 'range_beam';
    const info = refInfo(t.value, beam, shift.sheetName, formulaSheetName);
    if (info.target === '3d' && spans(info.sheets, shift.sheetName, sheetOrder)) has3dSpanning = true;
    if (info.target !== 'shift') { out += t.value; continue; }
    // `Sheet1!A1:Sheet1!B2`: two single cells on the edited sheet joined by ':' form one range.
    const n1 = tokens[i + 1];
    const n2 = tokens[i + 2];
    if (!beam && info.parts.length === 1 && n1 && n2 && n1.type === 'operator' && n1.value === ':' && n2.type === 'range') {
      const second = refInfo(n2.value, false, shift.sheetName, formulaSheetName);
      if (second.target === 'shift' && second.parts.length === 1) {
        const eps = [parseEndpoint(info.parts[0], false), parseEndpoint(second.parts[0], false)];
        const moved = shiftEndpoints(eps, shift);
        if (moved === null) out += '#REF!';
        else if (moved === eps) out += t.value + n1.value + n2.value;
        else out += info.prefix + formatEndpoint(moved[0]) + n1.value + second.prefix + formatEndpoint(moved[1]);
        i += 2;
        continue;
      }
    }
    const eps = info.parts.map((p) => parseEndpoint(p, beam));
    const moved = shiftEndpoints(eps, shift);
    if (moved === null) out += '#REF!';
    else if (moved === eps) out += t.value;
    else out += info.prefix + moved.map(formatEndpoint).join(':');
  }
  return { text: out, changed: out !== text, has3dSpanning };
}

const SHEET_LOCAL_CELL = '\\$?[A-Za-z]{1,3}\\$?[0-9]+';
const SHEET_LOCAL_RE = new RegExp(`^(?:${SHEET_LOCAL_CELL}(?::${SHEET_LOCAL_CELL})?|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}|\\$?[0-9]+:\\$?[0-9]+)$`);

/**
 * A sheet-local A1 reference (`B2`, `A1:C10`, `B:D`, `3:5`; `$` allowed; no sheet prefix) after the
 * shift, or '#REF!' when it is deleted or pushed off the sheet. For merges, `dimension`, hyperlinks,
 * autoFilter/sortState and table refs: the caller has established that the reference is on the edited
 * sheet (`shift.sheetName` is not consulted). Unchanged input is returned as is. Throws
 * FormulaTranslateError for anything else.
 */
export function shiftRange(ref: string, shift: StructuralShift): string {
  checkShift(shift);
  if (!SHEET_LOCAL_RE.test(ref)) throw new FormulaTranslateError(`Unrecognised range "${ref}"`);
  const parts = ref.split(':');
  const beam = parts.length === 2 && !CELL_RE.test(parts[0]);
  const eps = parts.map((p) => parseEndpoint(p, beam));
  const moved = shiftEndpoints(eps, shift);
  if (moved === null) return '#REF!';
  if (moved === eps) return ref;
  const out = moved.map(formatEndpoint);
  // A cell range shrunk to one cell is written as that cell (`B4`, as Excel writes it), not `B4:B4` (review N5).
  if (!beam && out.length === 2 && out[0] === out[1]) return out[0];
  return out.join(':');
}

/**
 * A space-separated list of sheet-local ranges (`sqref` of conditional formats, data validations,
 * selections, protected ranges, ignored errors) after the shift. Deleted ranges are dropped; null when
 * every range is deleted. Unchanged input is returned as is, spacing included.
 */
export function shiftSqref(sqref: string, shift: StructuralShift): string | null {
  checkShift(shift);
  const pieces = sqref.split(/\s+/).filter((p) => p !== '');
  if (pieces.length === 0) return sqref;
  const out: string[] = [];
  let changed = false;
  for (const p of pieces) {
    const s = shiftRange(p, shift);
    if (s !== p) changed = true;
    if (s !== '#REF!') out.push(s);
  }
  if (!changed) return sqref;
  return out.length === 0 ? null : out.join(' ');
}

interface PrefixedToken { i: number; prefix: string; rest: string; context: boolean }

/** The tokens that carry a sheet prefix. A `context` token (`Sheet2` in `Sheet2!#REF!`) counts, with the `!` operator after it. */
function prefixedTokens(tokens: Tokens): PrefixedToken[] {
  const out: PrefixedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'range' || t.type === 'range_beam' || t.type === 'range_named' || t.type === 'structured') {
      const [prefix, rest] = splitRef(t.value);
      if (prefix !== '') out.push({ i, prefix, rest, context: false });
    } else if ((t.type === 'context' || t.type === 'context_quote') && tokens[i + 1]?.type === 'operator' && tokens[i + 1].value === '!') {
      out.push({ i, prefix: t.value + '!', rest: '', context: true });
    }
  }
  return out;
}

function replaceTokens(text: string, tokens: Tokens, repl: Map<number, string>): string {
  if (repl.size === 0) return text;
  let out = '';
  for (let i = 0; i < tokens.length; i++) out += repl.get(i) ?? tokens[i].value;
  return out;
}

/**
 * `text` with every reference qualified by sheet `oldName` (case-insensitive; also either end of a
 * 3-D span) requalified with `newName`, quoted as needed (§9.7). References into other workbooks are
 * left alone. Throws FormulaTranslateError for text it cannot tokenise.
 */
export function renameSheetInFormula(text: string, oldName: string, newName: string): string {
  const tokens = tokensOf(text);
  const target = foldName(oldName);
  const repl = new Map<number, string>();
  for (const pt of prefixedTokens(tokens)) {
    const p = parsePrefix(pt.prefix);
    if (!p || !isLocalBook(p) || !p.sheets.some((s) => foldName(s) === target)) continue;
    const prefix = buildPrefix({ book: p.book, sheets: p.sheets.map((s) => (foldName(s) === target ? newName : s)) });
    if (pt.context) {
      repl.set(pt.i, prefix.slice(0, -1));
    } else {
      repl.set(pt.i, prefix + pt.rest);
    }
  }
  return replaceTokens(text, tokens, repl);
}

/**
 * `text` after sheet `name` is deleted (§9.7): every reference qualified by it becomes `#REF!` (bare,
 * as in shiftFormula). With `sheetOrder` (the sheet names in workbook order before the deletion) a 3-D
 * span with the deleted sheet at one end shrinks to the next sheet inward, becoming a plain reference
 * when one sheet is left; without it such a span becomes `#REF!`. A span that merely contains the
 * sheet is unchanged. Throws FormulaTranslateError for text it cannot tokenise.
 */
export function deleteSheetInFormula(text: string, name: string, sheetOrder?: readonly string[]): string {
  const tokens = tokensOf(text);
  const target = foldName(name);
  const repl = new Map<number, string>();
  for (const pt of prefixedTokens(tokens)) {
    const p = parsePrefix(pt.prefix);
    if (!p || !isLocalBook(p)) continue;
    const f = p.sheets.map(foldName);
    if (!f.includes(target)) continue;
    if (pt.context) {
      // `Sheet2!#REF!` (context, '!', error) → the error alone.
      repl.set(pt.i, '');
      repl.set(pt.i + 1, '');
      continue;
    }
    let replacement = '#REF!';
    if (f.length === 2 && f[0] !== f[1] && sheetOrder) {
      const idx = sheetOrder.map(foldName);
      let i = idx.indexOf(f[0]);
      let j = idx.indexOf(f[1]);
      const k = idx.indexOf(target);
      if (i >= 0 && j >= 0) {
        if (i > j) [i, j] = [j, i];
        if (k === i) i++;
        else if (k === j) j--;
        if (i <= j) replacement = buildPrefix({ book: p.book, sheets: i === j ? [sheetOrder[i]] : [sheetOrder[i], sheetOrder[j]] }) + pt.rest;
      }
    }
    repl.set(pt.i, replacement);
  }
  return replaceTokens(text, tokens, repl);
}

/**
 * Whether `text` names sheet `name` (case-insensitive) in a reference, defined-name use or structured
 * reference, including either end of a 3-D span — or, with `sheetOrder`, a span containing it.
 * References into other workbooks do not count. Throws FormulaTranslateError for text it cannot tokenise.
 */
export function formulaMentionsSheet(text: string, name: string, sheetOrder?: readonly string[]): boolean {
  const tokens = tokensOf(text);
  const target = foldName(name);
  for (const pt of prefixedTokens(tokens)) {
    const p = parsePrefix(pt.prefix);
    if (!p || !isLocalBook(p) || p.sheets.length === 0) continue;
    if (p.sheets.some((s) => foldName(s) === target)) return true;
    if (p.sheets.length === 2 && sheetOrder) {
      const idx = sheetOrder.map(foldName);
      const i = idx.indexOf(foldName(p.sheets[0]));
      const j = idx.indexOf(foldName(p.sheets[1]));
      const k = idx.indexOf(target);
      if (i >= 0 && j >= 0 && k >= Math.min(i, j) && k <= Math.max(i, j)) return true;
    }
  }
  return false;
}
