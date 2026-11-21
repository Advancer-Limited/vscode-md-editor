// WP-14: per-sheet notices for content that is present but not shown or not applied (spec §7.2).
// Detection only reads relationships and a few element names; it never affects preservation.

import type { OfficeNotice } from '../../protocol.js';
import { partNameFromTarget, readRelationships } from '../opc.js';
import type { XmlElement } from '../xml.js';
import type { Workbook } from './workbook.js';
import type { Sheet } from './sheet.js';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface DrawingCounts { charts: number; images: number; shapes: number; slicers: number }

/** Local names of an element's descendants plus any `uri` attribute (the kind of a graphic frame). */
function frameKinds(el: XmlElement, acc: string[] = []): string[] {
  acc.push(el.local);
  for (const a of el.attrs) if (a.local === 'uri') acc.push(a.value);
  for (const ch of el.children) if (ch.type === 'el') frameKinds(ch, acc);
  return acc;
}

/** Count what a drawing part draws. `AlternateContent` is read through its first `Choice` only. */
function countDrawing(el: XmlElement, out: DrawingCounts): void {
  for (const ch of el.children) {
    if (ch.type !== 'el') continue;
    switch (ch.local) {
      case 'pic': out.images++; break;
      case 'sp': case 'cxnSp': case 'grpSp': out.shapes++; break;
      case 'graphicFrame': {
        const kinds = frameKinds(ch).join(' ').toLowerCase();
        if (kinds.includes('slicer')) out.slicers++;
        else if (kinds.includes('chart')) out.charts++;
        else out.shapes++;
        break;
      }
      case 'AlternateContent': {
        const choice = ch.children.find((n) => n.type === 'el' && n.local === 'Choice');
        if (choice && choice.type === 'el') countDrawing(choice, out);
        break;
      }
      default:
        countDrawing(ch, out);   // the *Anchor wrappers
    }
  }
}

interface SheetFeatures { cf: boolean; dv: boolean; sparklines: number }

/** Scan the worksheet's direct children (never `sheetData`); `extLst` is read deeper for x14 features. */
function scanFeatures(sheet: Sheet): SheetFeatures {
  const f: SheetFeatures = { cf: false, dv: false, sparklines: 0 };
  const walk = (el: XmlElement): void => {
    for (const ch of el.children) {
      if (ch.type !== 'el') continue;
      if (ch.local === 'conditionalFormatting') f.cf = true;
      else if (ch.local === 'dataValidations') f.dv = true;
      else if (ch.local === 'sparkline') f.sparklines++;
      else walk(ch);
    }
  };
  for (const ch of sheet.doc.root.children) {
    if (ch.type !== 'el' || ch.local === 'sheetData') continue;
    if (ch.local === 'conditionalFormatting') f.cf = true;
    else if (ch.local === 'dataValidations') f.dv = true;
    else if (ch.local === 'extLst') walk(ch);
  }
  return f;
}

/** Notices for content on `sheet` that is shown approximately or not at all. */
export function detectSheetNotices(wb: Workbook, sheet: Sheet): OfficeNotice[] {
  const out: OfficeNotice[] = [];
  if (sheet.truncatedAtRow !== null) {
    out.push({
      severity: 'warning', code: 'sheet-truncated',
      message: `This sheet is very large: only the first ${sheet.truncatedAtRow.toLocaleString('en-US')} rows are shown.`,
    });
  }
  const counts: DrawingCounts = { charts: 0, images: 0, shapes: 0, slicers: 0 };
  let pivots = 0;
  let rels: ReturnType<typeof readRelationships> = [];
  try { rels = readRelationships(wb.pkg, sheet.part); } catch { /* no relationships */ }
  for (const rel of rels) {
    if (rel.external) continue;
    if (/\/pivotTable$/.test(rel.type)) {
      pivots++;
    } else if (/\/drawing$/.test(rel.type)) {
      try {
        const part = partNameFromTarget(sheet.part, rel.target);
        if (wb.pkg.has(part)) countDrawing(wb.pkg.xml(part).root, counts);
      } catch { /* unreadable drawing: nothing to count */ }
    }
  }
  const feat = scanFeatures(sheet);

  const hidden: string[] = [];
  if (counts.charts) hidden.push(plural(counts.charts, 'chart', 'charts'));
  if (counts.images) hidden.push(plural(counts.images, 'image', 'images'));
  if (counts.shapes) hidden.push(plural(counts.shapes, 'shape', 'shapes'));
  if (pivots) hidden.push(plural(pivots, 'pivot table', 'pivot tables'));
  if (feat.sparklines) hidden.push(plural(feat.sparklines, 'sparkline', 'sparklines'));
  if (counts.slicers) hidden.push(plural(counts.slicers, 'slicer', 'slicers'));
  if (hidden.length) {
    out.push({
      severity: 'info', code: 'sheet-content-not-shown',
      message: `Not shown here (kept in the file): ${hidden.join(', ')}.`,
    });
  }
  const unapplied: string[] = [];
  if (feat.cf) unapplied.push('conditional formatting');
  if (feat.dv) unapplied.push('data validation');
  if (unapplied.length) {
    out.push({
      severity: 'info', code: 'sheet-features-not-applied',
      message: `Present but not applied here: ${unapplied.join(' and ')}.`,
    });
  }
  return out;
}
