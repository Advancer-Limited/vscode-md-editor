// Declarations shared by the parallel xlsx WPs (11 and 12). Types only.
export type CellValue =
  | { k: 'n'; v: number }
  | { k: 's'; v: string }
  | { k: 'b'; v: boolean }
  | { k: 'e'; v: string }
  | { k: 'z' };

export type Range = readonly [r0: number, c0: number, r1: number, c1: number]; // 0-based inclusive

export interface CellRead {
  r: number;
  c: number;
  value: CellValue;
  styleIndex: number;
  formula?: string;
  shared?: { si: number; master: boolean; ref?: string };
  arrayRef?: string;
  hasCachedValue: boolean;
  rich: boolean;
  cm: boolean;
  vm: boolean;
}

export interface ColInfo { min: number; max: number; widthChars: number | null; hidden: boolean; styleIndex: number | null }
export interface RowInfo { heightPt: number | null; hidden: boolean; styleIndex: number | null }
export interface TableInfo { part: string; name: string; ref: Range; headerRows: number; totalsRows: number }
