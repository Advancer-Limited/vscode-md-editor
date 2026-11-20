// WP-12: display formatting (numfmt wrapper), edit-box seeding (§9.3) and unit conversions. Spec §7.2, §9.3.
// numfmt locale is fixed to en-US in v1. numfmt has no 1904 option, so the date system is handled here.
import { dateFromSerial, format, formatColor, isDateFormat } from 'numfmt';
import type { CellRead, CellValue } from './types.js';
import type { StyleTable } from './styles.js';

const COLOR_HEX: Record<string, string> = {
  black: '#000000', blue: '#0000FF', cyan: '#00FFFF', green: '#00FF00',
  magenta: '#FF00FF', red: '#FF0000', white: '#FFFFFF', yellow: '#FFFF00',
};
const OFFSET_1904 = 1462;
const MAX_SERIAL = 2958465;   // 9999-12-31

function dateFormat(code: string): boolean { try { return isDateFormat(code); } catch { return false; } }

function colorHex(c: string | number | undefined): string | undefined {
  if (typeof c !== 'string') return undefined;
  const k = c.toLowerCase();
  if (COLOR_HEX[k]) return COLOR_HEX[k];
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : undefined;
}

/** The text a cell shows (and its `[Color]` section colour as #RRGGBB), as Excel would for this format code. */
export function displayString(value: CellValue, formatCode: string, date1904: boolean): { text: string; color?: string } {
  switch (value.k) {
    case 'z': return { text: '' };
    case 'e': return { text: value.v };
    case 'b': return { text: value.v ? 'TRUE' : 'FALSE' };
    case 's': {
      // Strings only go through the format's text section (`@`); numfmt passes them through otherwise.
      if (!formatCode.includes('@')) return { text: value.v };
      try { return { text: format(formatCode, value.v, { throws: false }) }; } catch { return { text: value.v }; }
    }
    case 'n': {
      let v = value.v;
      if (date1904 && dateFormat(formatCode)) v += OFFSET_1904;
      let text: string;
      try { text = format(formatCode, v, { throws: false }); } catch { text = String(value.v); }
      let color: string | undefined;
      try { color = colorHex(formatColor(formatCode, v, { throws: false })); } catch { /* no colour */ }
      return color ? { text, color } : { text };
    }
  }
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }

function looksLikeNonText(s: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)
    || /^(true|false)$/i.test(s)
    || /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(s);
}

/**
 * What the cell editor opens with (§9.3): formulas as `=` + formula; dates as ISO; other numbers at full
 * precision. A date-formatted number that has no valid ISO form (time-only, before 1900-03-01, past 9999)
 * is seeded as the plain number so re-entering it cannot silently turn it into text.
 * Text that would be re-read as something else (a number, TRUE/FALSE, an ISO date, `=...`, or starting
 * with an apostrophe) gets a leading apostrophe, except in Text-formatted cells.
 */
export function editSeed(cell: CellRead, styles: StyleTable, date1904: boolean): string {
  if (cell.formula !== undefined && cell.formula !== '') return '=' + cell.formula;
  const v = cell.value;
  switch (v.k) {
    case 'z': return '';
    case 'e': return v.v;
    case 'b': return v.v ? 'TRUE' : 'FALSE';
    case 's':
      if (styles.isTextStyle(cell.styleIndex)) return v.v;
      return v.v.startsWith("'") || v.v.startsWith('=') || looksLikeNonText(v.v.trim()) ? "'" + v.v : v.v;
    case 'n': {
      if (styles.isDateStyle(cell.styleIndex)) {
        const iso = isoFromSerial(v.v, date1904);
        if (iso) return iso;
      }
      return Number.isFinite(v.v) ? String(v.v) : '';
    }
  }
}

function isoFromSerial(serial: number, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial)) return undefined;
  const s = date1904 ? serial + OFFSET_1904 : serial;
  if (s < 61 || s >= MAX_SERIAL + 1) return undefined;   // 61 = 1900-03-01: avoids the 1900 leap-year quirk
  const total = Math.round(s * 86400);                   // whole seconds
  const days = Math.floor(total / 86400), secs = total - days * 86400;
  const [y, mo, d] = dateFromSerial(days);
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  if (secs === 0) return date;
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  return `${date}T${pad(hh)}:${pad(mm)}${ss ? ':' + pad(ss) : ''}`;
}

/** Excel's maximum digit width is 7px; the file's `width` already includes the 5px padding. */
export function unitsToPx(colWidthChars: number): number {
  return colWidthChars > 0 ? Math.round(colWidthChars * 7) : 0;
}
export function pointsToPx(pt: number): number {
  return pt > 0 ? Math.round((pt * 96) / 72) : 0;
}
