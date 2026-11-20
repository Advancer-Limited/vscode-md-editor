// STUB (WP-20) — replaced by WP-21 (formula entry and shared formulas, spec §9.4, §9.5).
// Signatures match plan WP-21; every function reports "Not available yet" so ops.ts refuses
// formula entry and any edit that would need a shared group materialised.
import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import type { Sheet } from './sheet.js';

const NOT_AVAILABLE: OfficeError = { code: 'blocked', message: 'Not available yet' };

/** Thrown by the void-returning stubs; ops.ts reports `officeError` as the operation's result. */
function notAvailable(): Error {
  return Object.assign(new Error(NOT_AVAILABLE.message), { officeError: { ...NOT_AVAILABLE } });
}

/** Write formula `text` (no '=') into (r, c); removes `<v>`. Null on success. */
export function setFormula(_b: EditBuilder, _sheet: Sheet, _r: number, _c: number, _text: string): OfficeError | null {
  return { ...NOT_AVAILABLE };
}

/** Give every dependant of shared group `si` its explicit formula and drop the group's t/si/ref. */
export function materialiseGroup(_b: EditBuilder, _sheet: Sheet, _si: number): void {
  throw notAvailable();
}

/** Materialise every shared group of the sheet (structural operations). */
export function materialiseAll(_b: EditBuilder, _sheet: Sheet): void {
  throw notAvailable();
}
