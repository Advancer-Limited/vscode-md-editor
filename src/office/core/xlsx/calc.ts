// Recalculation handling for edited workbooks (spec §9.5 last bullet, §6.5 "Xlsx-only").
//
// This editor never calculates. Once a workbook has any value, formula or structural edit, Excel must
// recalculate on open, and the calc chain (Excel's cached evaluation order) may disagree with the
// sheets, which Excel reports as corruption. So the first such edit also:
//   - sets `fullCalcOnLoad="1"` on `workbook.xml` `calcPr` (creating `calcPr` in schema position —
//     after `definedNames`, before `oleSize`/`customWorkbookViews`/`pivotCaches`/… — when absent);
//   - deletes the calc chain part, its relationship from the workbook and its `Override`.
// It runs inside the same EditBuilder as the cell change, so undo reverts both together. Idempotent:
// a later edit records nothing.
//
// No `vscode` import here (core rule).

import type { EditBuilder } from '../edits.js';
import { attr, child, qnameAt } from '../xml.js';
import type { XmlElement } from '../xml.js';
import { partNameFromTarget, readRelationships, removeOverride, removeRelationship } from '../opc.js';
import type { Workbook } from './workbook.js';

const CALC_CHAIN_TYPES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/calcChain',
];

/** CT_Workbook children that precede `calcPr` (ECMA-376 Part 1, §18.2.27). */
const BEFORE_CALC_PR = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets',
  'functionGroups', 'externalReferences', 'definedNames'];

/** Conventional calc chain part name, removed too when present without a relationship. */
const DEFAULT_CALC_CHAIN = 'xl/calcChain.xml';

/** Whether `ensureFullCalcOnLoad` would change anything (the workbook is not yet in the edited state). */
export function needsFullCalcOnLoad(wb: Workbook): boolean {
  const pkg = wb.pkg;
  const root = pkg.xml(wb.workbookPart).root;
  const calcPr = child(root, root.ns, 'calcPr');
  const v = calcPr ? attr(calcPr, '', 'fullCalcOnLoad') : undefined;
  if (v !== '1' && v !== 'true') return true;
  if (readRelationships(pkg, wb.workbookPart).some((r) => CALC_CHAIN_TYPES.includes(r.type))) return true;
  return pkg.has(DEFAULT_CALC_CHAIN);
}

export function ensureFullCalcOnLoad(b: EditBuilder, wb: Workbook): void {
  const pkg = b.pkg;
  const part = wb.workbookPart;
  const root = pkg.xml(part).root;
  const ns = root.ns;

  // 1. calcPr/@fullCalcOnLoad
  const calcPr = child(root, ns, 'calcPr');
  if (calcPr) {
    const v = attr(calcPr, '', 'fullCalcOnLoad');
    if (v !== '1' && v !== 'true') b.setAttr(part, calcPr, '', 'fullCalcOnLoad', '1');
  } else {
    const name = qnameAt(root, ns, 'calcPr');
    if (name === undefined) throw new Error(`${part}: the workbook namespace is not bound on the root`);
    b.insertAt(part, root, afterLast(root, ns, BEFORE_CALC_PR), `<${name} fullCalcOnLoad="1"/>`);
  }

  // 2. The calc chain: relationship, part and Override.
  for (const rel of readRelationships(pkg, part)) {
    if (!CALC_CHAIN_TYPES.includes(rel.type)) continue;
    removeRelationship(b, part, rel.id);
    if (rel.external) continue;
    let target: string;
    try { target = partNameFromTarget(part, rel.target); } catch { continue; }
    deletePart(b, target);
  }
  deletePart(b, DEFAULT_CALC_CHAIN);
}

function deletePart(b: EditBuilder, part: string): void {
  if (!b.pkg.has(part)) return;
  removeOverride(b, part);
  b.setPart(part, null);
}

/** Child index just after the last element child of `parent` (in `ns`) named one of `locals`; 0 when none. */
function afterLast(parent: XmlElement, ns: string, locals: readonly string[]): number {
  for (let k = parent.children.length - 1; k >= 0; k--) {
    const c = parent.children[k];
    if (c.type === 'el' && c.ns === ns && locals.includes(c.local)) return k + 1;
  }
  return 0;
}
