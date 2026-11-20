// STUB (WP-20) — replaced by WP-22 (the date style patch, spec §9.3.1).
// Signature matches plan WP-22. Until then a date typed into a General cell stores its serial and
// keeps the cell's style ("store serial, keep s"): styles.xml is never touched.
import type { EditBuilder } from '../edits.js';
import type { OfficeNotice } from '../types.js';
import type { StyleTable } from './styles.js';

export function dateStyleFor(_b: EditBuilder, _styles: StyleTable, baseStyleIndex: number, _withTime: boolean,
  _cache: Map<string, number>): { styleIndex: number } | { fallback: 'text'; notice: OfficeNotice } {
  return { styleIndex: baseStyleIndex };
}
