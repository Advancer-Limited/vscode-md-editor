// WP-14: workbook-wide find over display strings and formula text (spec §7.2), capped at 1,000 matches.

import { LIMITS } from '../limits.js';
import type { Workbook } from './workbook.js';
import { StyleTable } from './styles.js';
import { cellText } from './view.js';

export const MAX_FIND_MATCHES = 1000;

export interface FindMatch { sheetId: number; r: number; c: number }

/**
 * Search the worksheets in tab order (hidden ones included, very hidden ones not), cells in row-major
 * order. `sheetId` null = all sheets. A cell matches when its display string or its formula text
 * (`=` + formula) contains the query. Yields to the event loop every ~30 ms on big workbooks (§10.2).
 */
export async function findInWorkbook(
  wb: Workbook, query: string, matchCase: boolean, sheetId: number | null, styles?: StyleTable,
): Promise<{ matches: FindMatch[]; truncated: boolean }> {
  const matches: FindMatch[] = [];
  if (query === '') return { matches, truncated: false };
  const st = styles ?? StyleTable.load(wb.pkg, wb.stylesPart, wb.themePart);
  const needle = matchCase ? query : query.toLowerCase();
  const norm = (s: string): string => (matchCase ? s : s.toLowerCase());
  let sliceStart = Date.now();

  for (const entry of wb.sheets) {
    if (entry.kind !== 'worksheet' || entry.state === 'veryHidden') continue;
    if (sheetId !== null && entry.id !== sheetId) continue;
    let sheet;
    try { sheet = await wb.sheet(entry.id); } catch { continue; }   // unreadable sheet: nothing to search
    const dims = sheet.dimensions();
    if (dims.rows === 0 || dims.cols === 0) continue;
    for (const cell of sheet.cellsIn([0, 0, dims.rows - 1, dims.cols - 1])) {
      const shown = cellText(wb, st, cell);
      const hit = norm(shown).includes(needle)
        || (cell.formula !== undefined && norm('=' + cell.formula).includes(needle));
      if (hit) {
        if (matches.length >= MAX_FIND_MATCHES) return { matches, truncated: true };
        matches.push({ sheetId: entry.id, r: cell.r, c: cell.c });
      }
      if (Date.now() - sliceStart > LIMITS.parseYieldMs) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStart = Date.now();
      }
    }
  }
  return { matches, truncated: false };
}
