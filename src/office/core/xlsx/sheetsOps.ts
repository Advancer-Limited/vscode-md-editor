// STUB (WP-20) — replaced by WP-40 (add, rename, delete sheet, spec §9.7).
// Signatures match plan WP-40; each returns "Not available yet".
import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import type { Workbook } from './workbook.js';

const NOT_AVAILABLE: OfficeError = { code: 'blocked', message: 'Not available yet' };

export function addSheet(_b: EditBuilder, _wb: Workbook, _name?: string, _afterSheetId?: number): OfficeError | null {
  return { ...NOT_AVAILABLE };
}

export function renameSheet(_b: EditBuilder, _wb: Workbook, _sheetId: number, _name: string): OfficeError | null {
  return { ...NOT_AVAILABLE };
}

export function deleteSheet(_b: EditBuilder, _wb: Workbook, _sheetId: number): OfficeError | null {
  return { ...NOT_AVAILABLE };
}

/** Spec §5.2/§9.7 sheet-name rules; null when valid. */
export function validateSheetName(_name: string, _existing: readonly string[]): OfficeError | null {
  return { ...NOT_AVAILABLE };
}
