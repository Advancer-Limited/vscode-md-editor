// Cell input classification (spec §9.3) and value serialisation helpers for the xlsx write side.
//
// `classifyInput` turns exactly what the user typed into the stored kind. Rules, in order:
//
//   ''                                   -> clear
//   cell format is Text ('@')            -> text, verbatim (Excel stores everything typed into a Text
//                                           cell as text; WP-12's editSeed relies on this: it seeds Text
//                                           cells without an apostrophe)
//   starts with "'"                      -> text (the rest of the input)
//   '=' followed by at least one char    -> formula (text without the '=')
//   ^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$ in Excel's range -> number (0, or a magnitude within
//                                           2.2250738585072E-308 … 9.99999999999999E+307)
//   <number>% in a percent-formatted cell -> number / 100
//   TRUE / FALSE (any case)              -> boolean
//   ISO date / date-time in range        -> date (serial in the workbook's date system)
//   anything else                        -> text (including '#N/A'-like literals, '12%' outside a
//                                           percent cell, numbers outside Excel's range, dates
//                                           outside §9.3.1's range, and surrounding whitespace)
//
// No locale-dependent guessing. No `vscode` import here (core rule).

export type Classified =
  | { kind: 'clear' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; serial: number; withTime: boolean }
  | { kind: 'formula'; text: string /* no '=' */ };

export interface ClassifyContext { isPercentStyle: boolean; isTextStyle: boolean; date1904: boolean }

/** Excel's number range: it refuses larger magnitudes (1E+308) and stores smaller non-zero ones as text. */
export const MAX_CELL_NUMBER = 9.99999999999999e307;
export const MIN_CELL_NUMBER = 2.2250738585072e-308;

/** Whether `n` is a number Excel can hold in a cell. */
export function inExcelRange(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const a = Math.abs(n);
  return a === 0 || (a >= MIN_CELL_NUMBER && a <= MAX_CELL_NUMBER);
}

/** `text` (matching NUMBER_RE) divided by `divisor`, when the result is in Excel's range; a non-zero number that underflows to 0 is not. */
function excelNumber(text: string, divisor: number): number | undefined {
  const n = Number(text) / divisor;
  if (n === 0 && /[1-9]/.test(text.split(/[eE]/)[0])) return undefined;
  return inExcelRange(n) ? n : undefined;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function classifyInput(input: string, ctx: ClassifyContext): Classified {
  if (input === '') return { kind: 'clear' };
  if (ctx.isTextStyle) return { kind: 'text', text: input };
  if (input.charCodeAt(0) === 39 /* ' */) return { kind: 'text', text: input.slice(1) };
  if (input.charCodeAt(0) === 61 /* = */ && input.length > 1) return { kind: 'formula', text: input.slice(1) };
  if (NUMBER_RE.test(input)) {
    const n = excelNumber(input, 1);
    return n !== undefined ? { kind: 'number', value: n } : { kind: 'text', text: input };
  }
  if (ctx.isPercentStyle && input.length > 1 && input.endsWith('%')) {
    const rest = input.slice(0, -1);
    if (NUMBER_RE.test(rest)) {
      const n = excelNumber(rest, 100);
      if (n !== undefined) return { kind: 'number', value: n };
    }
  }
  const upper = input.toUpperCase();
  if (upper === 'TRUE') return { kind: 'boolean', value: true };
  if (upper === 'FALSE') return { kind: 'boolean', value: false };
  const d = isoDateSerial(input, ctx.date1904);
  if (d) return { kind: 'date', serial: d.serial, withTime: d.withTime };
  return { kind: 'text', text: input };
}

// ---------------------------------------------------------------------------------------------------
// Dates (§9.3, §9.3.1 accepted range)

const DAY_MS = 86_400_000;
/** 1899-12-30: serial 0 of the 1900 system for every date from 1900-03-01 on (Excel's fictitious 1900-02-29 sits before). */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const MIN_1900 = Date.UTC(1900, 2, 1);
const MIN_1904 = Date.UTC(1904, 0, 1);
const MAX_DAY = Date.UTC(9999, 11, 31);

/**
 * Serial for an ISO `YYYY-MM-DD`, optionally `THH:mm[:ss]` / ` HH:mm[:ss]`, when it is a real calendar
 * date within 1900-03-01 (1904 system: 1904-01-01) … 9999-12-31 with hours 0–23, minutes and seconds
 * 0–59; undefined otherwise.
 */
export function isoDateSerial(input: string, date1904: boolean): { serial: number; withTime: boolean } | undefined {
  const m = ISO_RE.exec(input);
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return undefined;
  const day = Date.UTC(y, mo - 1, d);
  const back = new Date(day);
  // Date.UTC maps years 0–99 to 1900–1999; every accepted year is >= 1900, so a mismatch is just invalid.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  if (day < (date1904 ? MIN_1904 : MIN_1900) || day > MAX_DAY) return undefined;
  const withTime = m[4] !== undefined;
  let secs = 0;
  if (withTime) {
    const hh = Number(m[4]), mm = Number(m[5]), ss = m[6] !== undefined ? Number(m[6]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return undefined;
    secs = hh * 3600 + mm * 60 + ss;
  }
  const days = Math.round((day - (date1904 ? EPOCH_1904 : EPOCH_1900)) / DAY_MS);
  return { serial: secs === 0 ? days : days + secs / 86400, withTime };
}

// ---------------------------------------------------------------------------------------------------
// Serialisation

/**
 * Shortest round-trip decimal for a finite number, in the xsd:double lexical form Excel writes
 * (`1E+21`, `1E-7`); `-0` is written `0`. Throws for NaN / ±Infinity (they have no cell form).
 */
export function numberToXml(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`numberToXml: ${n} is not a finite number`);
  if (n === 0) return '0';
  return String(n).replace('e', 'E');
}

/**
 * ST_Xstring encoding for cell text: characters XML 1.0 cannot carry (C0 controls other than TAB, LF
 * and CR; lone surrogates; U+FFFE/U+FFFF) become `_xHHHH_`, and a literal `_xHHHH_` sequence is
 * protected as `_x005F_xHHHH_` — the inverse of sharedStrings.decodeXstring.
 */
export function encodeXstring(s: string): string {
  return s.replace(/_(?=x[0-9A-Fa-f]{4}_)|[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (ch) => ch === '_' ? '_x005F_' : '_x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_');
}
