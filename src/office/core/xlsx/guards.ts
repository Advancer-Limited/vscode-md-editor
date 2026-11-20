// STUB (WP-20) — replaced by WP-39 (Tier B/C guards, spec §9.6, §9.7 confirmations).
// Signature matches plan WP-39. Pure inspection; until then every structural/sheet operation is blocked.
import type { OfficePackage } from '../package.js';
import type { XlsxEditOp } from '../../protocol.js';
import type { Workbook } from './workbook.js';

export function checkStructuralOp(_wb: Workbook, _pkg: OfficePackage, _op: XlsxEditOp): Promise<{ blocked?: string; confirm?: string[] }> {
  return Promise.resolve({ blocked: 'Not available yet' });
}
