// STUB (WP-20) — replaced by WP-38 (insert/delete rows and columns, Tier A, spec §9.6).
// Signature matches plan WP-38; rejects with "Not available yet".
import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import type { Sheet } from './sheet.js';
import type { Workbook } from './workbook.js';

const NOT_AVAILABLE: OfficeError = { code: 'blocked', message: 'Not available yet' };

export function insertOrDelete(_b: EditBuilder, _wb: Workbook, _sheet: Sheet, _axis: 'row' | 'col', _at: number, _count: number): Promise<void> {
  return Promise.reject(Object.assign(new Error(NOT_AVAILABLE.message), { officeError: { ...NOT_AVAILABLE } }));
}
