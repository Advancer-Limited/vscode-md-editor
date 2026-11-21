// Tier B / Tier C guards for structural edits (spec §9.6 Tier B and Tier C, §9.7 confirmations).
//
// `checkStructuralOp(wb, pkg, op)` inspects the workbook and says whether `op` may run:
//   { blocked: message }   Tier B: refused; the message names the cause. Nothing changes.
//   { confirm: [lines] }   Tier C: allowed after the user accepts these lines (ops.ts returns them as
//                          `confirm`; the provider shows them in a modal, default Cancel, and calls
//                          again with `confirmed: true`). Each line names the affected content.
//   {}                     nothing to say.
// It is pure inspection: it reads parts (parsing them on first use, which every later edit needs
// anyway) and loads worksheets through `Workbook.sheet` (cached), but never writes to the package, so
// `pkg.serialize()` still returns the original bytes after any number of calls (G0).
//
// Insert/delete rows/columns (§9.6), checked in this order — the first Tier B hit is reported:
//   B  the position or count runs off the sheet, or content would be pushed past row 1,048,576 / XFD
//   B  a multi-cell array formula would be split or partly deleted
//   B  a data table (`f t="dataTable"`) would be split, partly deleted or moved, or its input cells
//      (`r1`/`r2`) would move: Tier A does not rewrite `r1`/`r2`, so a moved data table would read
//      the wrong input cells
//   B  a column operation intersects a table's column span; a row operation deletes a table's header
//      row, totals row or all of its data rows, or inserts inside a multi-row header/totals area
//   B  legacy notes (`comments`) or threaded comments at or beyond the index
//   B  a pivot table on the sheet at or beyond the index
//   B  a formula or defined name with a 3-D reference spanning the edited sheet (`Sheet1:Sheet3!A1`)
//   B  another worksheet whose formulas must be rewritten is not editable (protected, unsupported
//      layout, over the size limits) or cannot be read; a formula that would need analysing cannot be
//      tokenised
//   C  drawings anchored at or beyond the index (charts, images, shapes, slicers, other frames) and
//      legacy VML form controls: they keep their grid position
//   C  chart series that reference the moved cells (every chart part, chartsheets included)
//   C  pivot-cache sources (`worksheetSource sheet= ref=`) on the sheet that the operation moves
//   C  ranges inside `extLst` (Excel 2010+ conditional formats, data validations, sparklines) that the
//      operation moves, on the edited sheet or (formulas) on other sheets
//   C  internal hyperlinks (`hyperlink/@location`) that point at moved cells (not in Tier A)
//
// Sheets (§9.7):
//   addSheet     B  workbook structure protected.  (Name validation is sheetsOps.validateSheetName,
//                   run by sheetsOps.addSheet/renameSheet themselves — not duplicated here.)
//   renameSheet  B  structure protected; a worksheet whose formulas name the sheet is not editable.
//                C  charts / pivot caches naming the sheet ("N charts/pivot tables reference this
//                   sheet by name and will not be updated"), extLst formulas and hyperlinks naming it.
//   deleteSheet  B  structure protected; not a plain worksheet; the last visible worksheet; a pivot
//                   cache source (by sheet, by a table on it, or by a defined name pointing at it);
//                   another worksheet whose formulas name the sheet is not editable.
//                C  always at least one line (§9.7: deleting a sheet always asks; the provider only
//                   shows the modal for a non-empty list), plus the references that become #REF!.
//
// No `vscode` import here (core rule).

import type { OfficePackage } from '../package.js';
import type { XlsxEditOp } from '../../protocol.js';
import { attr, child, childrenOf, textContent } from '../xml.js';
import type { XmlElement } from '../xml.js';
import { contentTypeOf, partNameFromTarget, readRelationships } from '../opc.js';
import type { Workbook, SheetEntry } from './workbook.js';
import { MAX_COLS, MAX_ROWS, a1ToRange, rangeToA1, rcToA1 } from './sheet.js';
import type { Range, Sheet } from './sheet.js';
import { foldName, formulaMentionsSheet, quoteSheetName, shiftFormula, shiftRange, shiftSqref } from './refs.js';
import type { StructuralShift } from './refs.js';

export interface GuardResult { blocked?: string; confirm?: string[] }

type Axis = 'row' | 'col';
type StructOp = Extract<XlsxEditOp, { op: 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols' }>;

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

const CT_CHART = /drawingml\.chart\+xml$|chartex\+xml$/i;
const CT_PIVOT_CACHE = /pivotCacheDefinition\+xml$/i;
const CT_PIVOT_TABLE = /pivotTable\+xml$/i;

const VERB: Record<StructOp['op'], string> = {
  insertRows: 'insert rows', deleteRows: 'delete rows', insertCols: 'insert columns', deleteCols: 'delete columns',
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const quoted = (name: string): string => `"${name}"`;
const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
/** At most `max` names, then "…and N more". */
const someNames = (names: string[], max = 3): string =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

/** A Tier B refusal escaping from a helper; caught in checkStructuralOp and turned into `blocked`. */
class Blocked extends Error {
  constructor(message: string) { super(message); this.name = 'Blocked'; }
}

/** Is `op` refused (Tier B), allowed after confirmation (Tier C), or allowed? Never mutates `pkg`. */
export async function checkStructuralOp(wb: Workbook, pkg: OfficePackage, op: XlsxEditOp): Promise<GuardResult> {
  try {
    switch (op.op) {
      case 'insertRows': case 'deleteRows': case 'insertCols': case 'deleteCols':
        return await checkInsertDelete(wb, pkg, op);
      case 'addSheet':
        return wb.structureLocked ? { blocked: structureLockedMessage('add a sheet') } : {};
      case 'renameSheet':
        return await checkRename(wb, pkg, op.sheetId);
      case 'deleteSheet':
        return await checkDelete(wb, pkg, op.sheetId);
      default:
        return {};   // cell edits are not structural
    }
  } catch (err) {
    if (err instanceof Blocked) return { blocked: err.message };
    throw err;
  }
}

const structureLockedMessage = (verb: string): string =>
  `Can't ${verb}: the workbook structure is protected.`;

// ---------------------------------------------------------------------------------------------------
// Shared inspection helpers

/** Index (0-based) of `range` on `axis`: [lo, hi]. */
const span = (range: Range, axis: Axis): [number, number] => (axis === 'row' ? [range[0], range[2]] : [range[1], range[3]]);

/** The affected band of a shift: inserted before `at`, or the deleted [at, end]. */
interface Band { axis: Axis; at: number; count: number; end: number }

const bandOf = (shift: StructuralShift): Band => ({
  axis: shift.axis, at: shift.at, count: shift.count, end: shift.count < 0 ? shift.at - shift.count - 1 : shift.at,
});

/** Whether the operation splits [lo, hi] (insert strictly inside) or deletes only part of it. */
function splits(lo: number, hi: number, b: Band): boolean {
  if (b.count > 0) return lo < b.at && b.at <= hi;
  const overlaps = !(hi < b.at || lo > b.end);
  return overlaps && !(lo >= b.at && hi <= b.end);
}

/** Whether [lo, hi] is at or beyond the index (so it moves, grows, shrinks or is deleted). */
const reaches = (hi: number, b: Band): boolean => hi >= b.at;

const colName = (c: number): string => rcToA1(0, c).replace(/\d+$/, '');
const indexLabel = (axis: Axis, i: number): string => (axis === 'row' ? `row ${(i + 1).toLocaleString('en-US')}` : `column ${colName(i)}`);
const beyondLabel = (b: Band): string => (b.axis === 'row' ? `at or below ${indexLabel('row', b.at)}` : `at or to the right of ${indexLabel('col', b.at)}`);

/** Descendant elements of `el` (depth first, document order) for which `pick` holds. */
function descendants(el: XmlElement, pick: (e: XmlElement) => boolean, out: XmlElement[] = []): XmlElement[] {
  for (const ch of el.children) {
    if (ch.type !== 'el') continue;
    if (pick(ch)) out.push(ch);
    descendants(ch, pick, out);
  }
  return out;
}

const relId = (el: XmlElement): string | undefined => attr(el, NS_R, 'id') ?? attr(el, NS_R_STRICT, 'id');

/** Internal parts related to `part` by relationship types ending in `/${kind}` (in package case). */
function relatedParts(pkg: OfficePackage, part: string, kind: string): string[] {
  const out: string[] = [];
  let rels: ReturnType<typeof readRelationships>;
  try { rels = readRelationships(pkg, part); } catch { return out; }
  for (const rel of rels) {
    if (rel.external || !rel.type.endsWith('/' + kind)) continue;
    let name: string;
    try { name = partNameFromTarget(part, rel.target); } catch { continue; }
    if (!pkg.has(name)) continue;
    out.push(pkg.partNames().find((n) => n.toLowerCase() === name.toLowerCase()) ?? name);
  }
  return out;
}

/** Parts whose content type matches `re`. */
function partsOfType(pkg: OfficePackage, re: RegExp): string[] {
  return pkg.partNames().filter((p) => re.test(contentTypeOf(pkg, p) ?? ''));
}

const baseName = (part: string): string => part.slice(part.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');

/** A formula's cell, for messages: `'My Sheet'!B3`. */
const cellLabel = (sheetName: string, ref: string): string => `${quoteSheetName(sheetName)}!${ref}`;

interface FormulaCell { ref: string; text: string; t: string | undefined; el: XmlElement; f: XmlElement }

/** Every formula cell of the (indexed) sheet, in row order. Reads only the indexed rows. */
function* formulaCells(sheet: Sheet): Generator<FormulaCell> {
  const ns = sheet.doc.root.ns;
  for (const r of sheet.rowIndices()) {
    const row = sheet.rowNode(r);
    if (!row) continue;
    for (const el of row.children) {
      if (el.type !== 'el' || el.local !== 'c' || el.ns !== ns) continue;
      const f = child(el, ns, 'f');
      if (!f) continue;
      yield { ref: attr(el, '', 'r') ?? '?', text: textContent(f), t: attr(f, '', 't'), el, f };
    }
  }
}

/** Why a loaded worksheet can't be rewritten, or null. */
function notEditableReason(sheet: Sheet): string | null {
  if (sheet.readOnlyReason === 'protected') return 'it is protected';
  if (sheet.overLimits || sheet.truncatedAtRow !== null || sheet.readOnlyReason === 'too-large') return 'it is over the size limit';
  if (sheet.readOnlyReason) return `it can't be edited here (${sheet.readOnlyReason})`;
  return null;
}

/** Load a worksheet or refuse, naming why it can't be read. */
async function loadOrBlock(wb: Workbook, e: SheetEntry, verb: string, why: string): Promise<Sheet> {
  try {
    return await wb.sheet(e.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Blocked(`Can't ${verb}: sheet ${quoted(e.name)} can't be read (${msg}), so ${why} can't be checked.`);
  }
}

interface DefinedName { name: string; localSheetId: number | null; text: string }

function definedNames(wb: Workbook, pkg: OfficePackage): DefinedName[] {
  const root = pkg.xml(wb.workbookPart).root;
  const dn = child(root, root.ns, 'definedNames');
  if (!dn) return [];
  return childrenOf(dn, root.ns, 'definedName').map((el) => {
    const l = attr(el, '', 'localSheetId');
    return { name: attr(el, '', 'name') ?? '', localSheetId: l !== undefined && /^\d+$/.test(l) ? Number(l) : null, text: textContent(el) };
  });
}

/** Chart parts with the text of their `f` (formula) elements; `null` texts when the part can't be parsed. */
function chartFormulas(pkg: OfficePackage): Array<{ part: string; texts: string[] | null }> {
  return partsOfType(pkg, CT_CHART).map((part) => {
    try {
      return { part, texts: descendants(pkg.xml(part).root, (e) => e.local === 'f').map(textContent) };
    } catch {
      return { part, texts: null };
    }
  });
}

/** `formulaMentionsSheet`, falling back to a case-insensitive substring test for text it can't tokenise. */
function mentions(text: string, name: string, order: readonly string[]): boolean {
  try { return formulaMentionsSheet(text, name, order); } catch { return foldName(text).includes(foldName(name)); }
}

interface PivotCacheInfo { part: string; sheet: string | null; ref: string | null; name: string | null; tables: string[] }

/** Pivot cache definitions with their worksheet source and the names of the pivot tables using them. */
function pivotCaches(wb: Workbook, pkg: OfficePackage): PivotCacheInfo[] {
  // cacheId -> cache part, through workbook.xml pivotCaches and the workbook relationships.
  const byCacheId = new Map<string, string>();
  const root = pkg.xml(wb.workbookPart).root;
  const pcs = child(root, root.ns, 'pivotCaches');
  if (pcs) {
    const rels = readRelationships(pkg, wb.workbookPart);
    for (const pc of childrenOf(pcs, root.ns, 'pivotCache')) {
      const id = attr(pc, '', 'cacheId');
      const rel = rels.find((r) => r.id === relId(pc));
      if (id === undefined || !rel || rel.external) continue;
      try { byCacheId.set(id, partNameFromTarget(wb.workbookPart, rel.target).toLowerCase()); } catch { /* skip */ }
    }
  }
  const tablesByCache = new Map<string, string[]>();
  for (const part of partsOfType(pkg, CT_PIVOT_TABLE)) {
    let el: XmlElement;
    try { el = pkg.xml(part).root; } catch { continue; }
    const cache = byCacheId.get(attr(el, '', 'cacheId') ?? '');
    if (!cache) continue;
    const list = tablesByCache.get(cache) ?? [];
    list.push(attr(el, '', 'name') ?? baseName(part));
    tablesByCache.set(cache, list);
  }
  const out: PivotCacheInfo[] = [];
  for (const part of partsOfType(pkg, CT_PIVOT_CACHE)) {
    let el: XmlElement;
    try { el = pkg.xml(part).root; } catch { out.push({ part, sheet: null, ref: null, name: null, tables: [] }); continue; }
    const src = descendants(el, (e) => e.local === 'worksheetSource')[0];
    const external = src !== undefined && relId(src) !== undefined;
    out.push({
      part,
      sheet: src && !external ? (attr(src, '', 'sheet') ?? null) : null,
      ref: src && !external ? (attr(src, '', 'ref') ?? null) : null,
      name: src && !external ? (attr(src, '', 'name') ?? null) : null,
      tables: tablesByCache.get(part.toLowerCase()) ?? [],
    });
  }
  return out;
}

const pivotLabel = (c: PivotCacheInfo): string =>
  c.tables.length ? `pivot table ${listOf(c.tables.map(quoted))}` : `a pivot cache (${baseName(c.part)})`;

/** Items of a worksheet's `extLst` that carry ranges: kind, sqref texts and formula texts. */
interface ExtItem { kind: 'cf' | 'dv' | 'sparkline' | 'other'; sqrefs: string[]; formulas: string[] }

function extItems(sheet: Sheet): ExtItem[] {
  const root = sheet.doc.root;
  const ext = child(root, root.ns, 'extLst');
  if (!ext) return [];
  const out: ExtItem[] = [];
  const walk = (el: XmlElement): void => {
    for (const ch of el.children) {
      if (ch.type !== 'el') continue;
      const kind = ch.local === 'conditionalFormatting' ? 'cf' : ch.local === 'dataValidation' ? 'dv' : ch.local === 'sparkline' ? 'sparkline' : null;
      if (kind) {
        out.push({
          kind,
          sqrefs: descendants(ch, (e) => e.local === 'sqref').map(textContent),
          formulas: descendants(ch, (e) => e.local === 'f').map(textContent),
        });
      } else if (ch.local === 'sqref' || ch.local === 'f') {
        out.push({ kind: 'other', sqrefs: ch.local === 'sqref' ? [textContent(ch)] : [], formulas: ch.local === 'f' ? [textContent(ch)] : [] });
      } else {
        walk(ch);
      }
    }
  };
  walk(ext);
  return out;
}

const EXT_NAMES: Record<ExtItem['kind'], [string, string]> = {
  cf: ['conditional format', 'conditional formats'],
  dv: ['data validation', 'data validations'],
  sparkline: ['sparkline', 'sparklines'],
  other: ['other range', 'other ranges'],
};

function extSummary(counts: Map<ExtItem['kind'], number>): string {
  const parts: string[] = [];
  for (const k of ['sparkline', 'cf', 'dv', 'other'] as const) {
    const n = counts.get(k) ?? 0;
    if (n) parts.push(plural(n, EXT_NAMES[k][0], EXT_NAMES[k][1]));
  }
  return listOf(parts);
}

/** Internal hyperlink locations of a worksheet. */
function hyperlinkLocations(sheet: Sheet): Array<{ ref: string; location: string }> {
  const root = sheet.doc.root;
  const hl = child(root, root.ns, 'hyperlinks');
  if (!hl) return [];
  const out: Array<{ ref: string; location: string }> = [];
  for (const el of childrenOf(hl, root.ns, 'hyperlink')) {
    const location = attr(el, '', 'location');
    if (location) out.push({ ref: attr(el, '', 'ref') ?? '?', location });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Insert/delete rows and columns (§9.6)

async function checkInsertDelete(wb: Workbook, pkg: OfficePackage, op: StructOp): Promise<GuardResult> {
  const verb = VERB[op.op];
  const fail = (why: string): never => { throw new Blocked(`Can't ${verb}: ${why}.`); };
  const axis: Axis = op.op === 'insertRows' || op.op === 'deleteRows' ? 'row' : 'col';
  const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
  const lastLabel = axis === 'row' ? `row ${MAX_ROWS.toLocaleString('en-US')}` : 'column XFD';
  const insert = op.op.startsWith('insert');

  const e = wb.entry(op.sheetId);
  if (!e) return fail(`there is no sheet with id ${op.sheetId}`);
  if (e.kind !== 'worksheet') return fail(`${quoted(e.name)} is not a worksheet`);
  if (!Number.isInteger(op.at) || !Number.isInteger(op.count) || op.at < 0 || op.count < 1 || op.at >= max) return fail('the position or count is invalid');
  if (op.at + op.count > max) {
    return fail(insert ? `the new ${axis === 'row' ? 'rows' : 'columns'} would run past ${lastLabel}` : `the ${axis === 'row' ? 'rows' : 'columns'} to delete run past ${lastLabel}`);
  }
  const shift: StructuralShift = { sheetName: e.name, axis, at: op.at, count: insert ? op.count : -op.count };
  const b = bandOf(shift);
  const sheet = await loadOrBlock(wb, e, verb, 'its content');
  const where = quoted(e.name);

  // Content pushed off the sheet.
  if (insert) {
    const dims = sheet.dimensions();
    let last = (axis === 'row' ? dims.rows : dims.cols) - 1;
    for (const t of sheet.tables()) last = Math.max(last, span(t.ref, axis)[1]);
    if (last >= b.at && last + op.count > max - 1) {
      fail(`content on ${where} would be pushed past ${lastLabel} (the last used ${axis === 'row' ? 'row' : 'column'} is ${indexLabel(axis, last).replace(/^\w+ /, '')})`);
    }
  }

  // Array formulas and data tables.
  for (const fc of formulaCells(sheet)) {
    if (fc.t !== 'array' && fc.t !== 'dataTable') continue;
    const refText = attr(fc.f, '', 'ref');
    const range = refText !== undefined ? a1ToRange(refText) : undefined;
    if (!range) {
      if (fc.t === 'dataTable') fail(`the data table at ${fc.ref} has no readable range`);
      continue;
    }
    const [lo, hi] = span(range, axis);
    if (fc.t === 'array') {
      if (lo !== hi && splits(lo, hi, b)) {
        fail(`it would ${insert ? 'split' : 'delete part of'} the array formula ${rangeToA1(range)} on ${where}`);
      }
      continue;
    }
    if (splits(lo, hi, b)) fail(`it would ${insert ? 'split' : 'delete part of'} the data table ${rangeToA1(range)} on ${where}`);
    const inputs = [attr(fc.f, '', 'r1'), attr(fc.f, '', 'r2')].filter((x): x is string => x !== undefined && x !== '');
    const moved = reaches(hi, b) || inputs.some((x) => { const r = a1ToRange(x); return !r || reaches(span(r, axis)[1], b); });
    if (moved) {
      fail(`it would move the data table ${rangeToA1(range)} on ${where} or its input cell${inputs.length === 1 ? '' : 's'} ${inputs.join(', ')}, which can't be adjusted yet`);
    }
  }

  // Tables.
  for (const t of sheet.tables()) {
    const label = `table ${quoted(t.name)} (${rangeToA1(t.ref)})`;
    const [r0, c0, r1, c1] = t.ref;
    if (axis === 'col') {
      if (insert ? (c0 < b.at && b.at <= c1) : !(c1 < b.at || c0 > b.end)) {
        fail(`the ${insert ? 'insertion point is inside' : 'columns intersect'} ${label}`);
      }
      continue;
    }
    const h = Math.max(0, t.headerRows);
    const tot = Math.max(0, t.totalsRows);
    const header: [number, number] | null = h > 0 ? [r0, r0 + h - 1] : null;
    const totals: [number, number] | null = tot > 0 ? [r1 - tot + 1, r1] : null;
    const data: [number, number] = [r0 + h, r1 - tot];
    if (insert) {
      if (header && header[0] < b.at && b.at <= header[1]) fail(`it would split the header rows of ${label}`);
      if (totals && totals[0] < b.at && b.at <= totals[1]) fail(`it would split the totals rows of ${label}`);
      continue;
    }
    const hits = (x: [number, number] | null): boolean => x !== null && !(x[1] < b.at || x[0] > b.end);
    if (hits(header)) fail(`it would delete the header row of ${label}`);
    if (hits(totals)) fail(`it would delete the totals row of ${label}`);
    if (data[0] <= data[1] && b.at <= data[0] && b.end >= data[1]) fail(`it would delete all data rows of ${label}`);
  }

  // Notes (legacy comments) and threaded comments.
  for (const [kind, what] of [['comments', 'note'], ['threadedComment', 'comment']] as const) {
    for (const part of relatedParts(pkg, sheet.part, kind)) {
      let els: XmlElement[];
      try {
        els = descendants(pkg.xml(part).root, (x) => (x.local === 'comment' || x.local === 'threadedComment') && attr(x, '', 'ref') !== undefined);
      } catch {
        return fail(`the ${what}s on ${where} can't be read`);
      }
      for (const el of els) {
        const ref = attr(el, '', 'ref')!;
        const range = a1ToRange(ref);
        if (!range || reaches(span(range, axis)[1], b)) {
          fail(`${where} has a ${what} at ${ref} ${beyondLabel(b)}, and ${what}s can't be moved yet`);
        }
      }
    }
  }

  // Pivot tables on the sheet.
  for (const part of relatedParts(pkg, sheet.part, 'pivotTable')) {
    let name = baseName(part);
    let range: Range | undefined;
    try {
      const root = pkg.xml(part).root;
      name = attr(root, '', 'name') ?? name;
      const loc = child(root, root.ns, 'location');
      const ref = loc ? attr(loc, '', 'ref') : undefined;
      range = ref !== undefined ? a1ToRange(ref) : undefined;
    } catch { /* unreadable: refuse below */ }
    if (!range) fail(`the location of pivot table ${quoted(name)} on ${where} can't be read`);
    else if (reaches(span(range, axis)[1], b)) fail(`pivot table ${quoted(name)} (${rangeToA1(range)}) is ${beyondLabel(b)}`);
  }

  // Formulas in every worksheet and in defined names: 3-D spans, and sheets that must be rewritten.
  const order = wb.sheets.map((s) => s.name);
  for (const other of wb.sheets) {
    if (other.kind !== 'worksheet') continue;
    const s = other.id === e.id ? sheet : await loadOrBlock(wb, other, verb, `its references to ${where}`);
    let rewrite: string | null = null;
    for (const fc of formulaCells(s)) {
      if (!fc.text.includes('!')) continue;   // unqualified references never span sheets and only move on the edited sheet
      let res;
      try {
        res = shiftFormula(fc.text, shift, other.name, order);
      } catch {
        return fail(`the formula in ${cellLabel(other.name, fc.ref)} can't be analysed`);
      }
      if (res.has3dSpanning) fail(`the formula in ${cellLabel(other.name, fc.ref)} uses a 3-D reference that spans ${where}`);
      if (other.id !== e.id && rewrite === null && (res.changed || (fc.t === 'shared' && mentions(fc.text, e.name, order)))) rewrite = fc.ref;
    }
    const why = rewrite !== null ? notEditableReason(s) : null;
    if (why) fail(`${quoted(other.name)} refers to cells on ${where} (${cellLabel(other.name, rewrite!)}) but can't be updated: ${why}`);
  }
  for (const dn of definedNames(wb, pkg)) {
    if (!dn.text.includes('!')) continue;
    let res;
    try { res = shiftFormula(dn.text, shift, null, order); } catch { return fail(`the defined name ${quoted(dn.name)} can't be analysed`); }
    if (res.has3dSpanning) fail(`the defined name ${quoted(dn.name)} uses a 3-D reference that spans ${where}`);
  }

  return confirmInsertDelete(wb, pkg, e, sheet, shift, b, order);
}

/** Tier C lines for an allowed insert/delete. */
async function confirmInsertDelete(
  wb: Workbook, pkg: OfficePackage, e: SheetEntry, sheet: Sheet, shift: StructuralShift, b: Band, order: readonly string[],
): Promise<GuardResult> {
  const lines: string[] = [];
  const where = quoted(e.name);

  // Drawings (and legacy VML controls) anchored at or beyond the index.
  const kinds = new Map<string, number>();
  const bump = (k: string): void => { kinds.set(k, (kinds.get(k) ?? 0) + 1); };
  for (const part of relatedParts(pkg, sheet.part, 'drawing')) {
    let root: XmlElement;
    try { root = pkg.xml(part).root; } catch { bump('object'); continue; }
    for (const a of anchors(root)) if (a.hi === null || reaches(b.axis === 'row' ? a.hi[0] : a.hi[1], b)) bump(a.kind);
  }
  for (const part of relatedParts(pkg, sheet.part, 'vmlDrawing')) {
    let text: string;
    try { text = pkg.text(part); } catch { continue; }
    for (const c of vmlControls(text)) if (c.hi === null || reaches(b.axis === 'row' ? c.hi[0] : c.hi[1], b)) bump('control');
  }
  if (kinds.size) {
    const order2 = ['chart', 'image', 'shape', 'slicer', 'control', 'object'];
    const names: Record<string, [string, string]> = {
      chart: ['chart', 'charts'], image: ['image', 'images'], shape: ['shape', 'shapes'], slicer: ['slicer', 'slicers'],
      control: ['form control', 'form controls'], object: ['other drawing object', 'other drawing objects'],
    };
    const parts = order2.filter((k) => kinds.has(k)).map((k) => plural(kinds.get(k)!, names[k][0], names[k][1]));
    const total = [...kinds.values()].reduce((x, y) => x + y, 0);
    lines.push(`${listOf(parts)} on ${where} ${beyondLabel(b)} will keep ${total === 1 ? 'its' : 'their'} position instead of moving with the cells.`);
  }

  // Chart series that reference the moved cells.
  const charts: string[] = [];
  for (const c of chartFormulas(pkg)) {
    const hit = c.texts === null ? false : c.texts.some((t) => {
      try { return shiftFormula(t, shift, null, order).changed; } catch { return mentions(t, e.name, order); }
    });
    if (hit) charts.push(baseName(c.part));
  }
  if (charts.length) {
    lines.push(`${plural(charts.length, 'chart', 'charts')} (${someNames(charts)}) ${charts.length === 1 ? 'plots' : 'plot'} cells on ${where} that move; the chart ranges will not be adjusted.`);
  }

  // Pivot-cache sources on the sheet that move.
  for (const c of pivotCaches(wb, pkg)) {
    if (c.sheet === null || c.ref === null || foldName(c.sheet) !== foldName(e.name)) continue;
    let moved: boolean;
    try { moved = shiftRange(c.ref, shift) !== c.ref; } catch { moved = true; }
    if (moved) lines.push(`The source range of ${pivotLabel(c)} (${cellLabel(e.name, c.ref)}) will not be adjusted.`);
  }

  // extLst ranges (Excel 2010+ conditional formats, data validations, sparklines) and hyperlinks.
  const extCounts = new Map<ExtItem['kind'], number>();
  const extSheets = new Set<string>();
  let links = 0;
  for (const other of wb.sheets) {
    if (other.kind !== 'worksheet') continue;
    const s = other.id === e.id ? sheet : wb.loadedSheet(other.id);   // loaded by the Tier B pass
    if (!s) continue;
    for (const item of extItems(s)) {
      let moved = false;
      if (other.id === e.id) {
        for (const q of item.sqrefs) { try { if (shiftSqref(q, shift) !== q) moved = true; } catch { moved = true; } }
      }
      for (const f of item.formulas) {
        try { if (shiftFormula(f, shift, other.name, order).changed) moved = true; } catch { if (mentions(f, e.name, order) || other.id === e.id) moved = true; }
      }
      if (moved) { extCounts.set(item.kind, (extCounts.get(item.kind) ?? 0) + 1); extSheets.add(other.name); }
    }
    for (const h of hyperlinkLocations(s)) {
      try { if (shiftFormula(h.location, shift, other.name, order).changed) links++; } catch { /* a name or other text: not a cell address */ }
    }
  }
  if (extCounts.size) {
    lines.push(`Excel 2010+ ranges on ${listOf([...extSheets].map(quoted))} will not be adjusted: ${extSummary(extCounts)}.`);
  }
  if (links) lines.push(`${plural(links, 'hyperlink points', 'hyperlinks point')} at cells on ${where} that move; ${links === 1 ? 'it' : 'they'} will not be adjusted.`);

  return lines.length ? { confirm: lines } : {};
}

interface Anchor { kind: string; hi: [row: number, col: number] | null }

/** Anchors of a drawing part with what they hold and their far corner (null: not cell-anchored → treated as affected only when unreadable). */
function anchors(root: XmlElement): Anchor[] {
  const out: Anchor[] = [];
  const num = (el: XmlElement | undefined, local: string): number | null => {
    const c = el ? el.children.find((n): n is XmlElement => n.type === 'el' && n.local === local) : undefined;
    const v = c ? Number(textContent(c).trim()) : NaN;
    return Number.isInteger(v) && v >= 0 ? v : null;
  };
  const corner = (el: XmlElement | undefined): [number, number] | null => {
    const r = num(el, 'row');
    const c = num(el, 'col');
    return r !== null && c !== null ? [r, c] : null;
  };
  const visit = (parent: XmlElement): void => {
    for (const ch of parent.children) {
      if (ch.type !== 'el') continue;
      if (ch.local === 'AlternateContent') {
        const choice = ch.children.find((n): n is XmlElement => n.type === 'el' && n.local === 'Choice');
        if (choice) visit(choice);
        continue;
      }
      if (ch.local !== 'twoCellAnchor' && ch.local !== 'oneCellAnchor') continue;   // absoluteAnchor: not tied to cells
      const elOf = (l: string): XmlElement | undefined => ch.children.find((n): n is XmlElement => n.type === 'el' && n.local === l);
      const from = corner(elOf('from'));
      const to = ch.local === 'twoCellAnchor' ? corner(elOf('to')) : from;
      const hi: [number, number] | null = from && to ? [Math.max(from[0], to[0]), Math.max(from[1], to[1])] : null;
      out.push({ kind: anchorKind(ch), hi });
    }
  };
  visit(root);
  return out;
}

/** What an anchor draws, by the same rules as notices.ts (pic → image; sp/cxnSp/grpSp → shape; graphic frame by its uri). */
function anchorKind(anchor: XmlElement): string {
  let content = anchor.children.find((n): n is XmlElement => n.type === 'el' && !['from', 'to', 'ext', 'pos', 'clientData'].includes(n.local));
  if (content && content.local === 'AlternateContent') {
    const choice = content.children.find((n): n is XmlElement => n.type === 'el' && n.local === 'Choice');
    content = choice?.children.find((n): n is XmlElement => n.type === 'el');
  }
  if (!content) return 'object';
  switch (content.local) {
    case 'pic': return 'image';
    case 'sp': case 'cxnSp': case 'grpSp': return 'shape';
    case 'graphicFrame': {
      const uris = descendants(content, () => true).map((d) => `${d.local} ${attr(d, '', 'uri') ?? ''}`).join(' ').toLowerCase();
      return uris.includes('slicer') ? 'slicer' : uris.includes('chart') ? 'chart' : 'shape';
    }
    default: return 'object';
  }
}

/** Non-note objects (form controls) of a legacy VML drawing, with their far corner from `x:Anchor`. */
function vmlControls(text: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<(?:\w+:)?ClientData\b[^>]*\bObjectType\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/(?:\w+:)?ClientData>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] === 'Note') continue;   // comment shapes: comments are Tier B
    const a = /<(?:\w+:)?Anchor>([^<]*)</.exec(m[2]);
    const n = a ? a[1].split(',').map((x) => Number(x.trim())) : [];
    // LeftColumn, LeftOffset, TopRow, TopOffset, RightColumn, RightOffset, BottomRow, BottomOffset.
    const ok = n.length === 8 && n.every((x) => Number.isInteger(x) && x >= 0);
    out.push({ kind: 'control', hi: ok ? [Math.max(n[2], n[6]), Math.max(n[0], n[4])] : null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Sheets (§9.7)

/**
 * Worksheets (other than `except`) whose formulas name `name`: refuses when one of them can't be
 * read or rewritten; returns the number of formula cells found, for confirmation text.
 */
async function sheetsNaming(wb: Workbook, name: string, except: number | null, verb: string): Promise<{ formulas: number; sheets: Sheet[] }> {
  const order = wb.sheets.map((s) => s.name);
  let formulas = 0;
  const sheets: Sheet[] = [];
  for (const other of wb.sheets) {
    if (other.kind !== 'worksheet' || other.id === except) continue;
    const s = await loadOrBlock(wb, other, verb, `its references to ${quoted(name)}`);
    sheets.push(s);
    let first: string | null = null;
    for (const fc of formulaCells(s)) {
      if (!fc.text.includes('!') || !mentions(fc.text, name, order)) continue;
      formulas++;
      first ??= fc.ref;
    }
    const why = first !== null ? notEditableReason(s) : null;
    if (why) {
      throw new Blocked(`Can't ${verb}: ${quoted(other.name)} refers to ${quoted(name)} (${cellLabel(other.name, first!)}) but can't be updated: ${why}.`);
    }
  }
  return { formulas, sheets };
}

/** Tier C lines shared by rename and delete: extLst formulas and hyperlinks naming the sheet. */
function namingLines(wb: Workbook, sheets: Sheet[], name: string, what: string): string[] {
  const order = wb.sheets.map((s) => s.name);
  const extCounts = new Map<ExtItem['kind'], number>();
  let links = 0;
  for (const s of sheets) {
    for (const item of extItems(s)) if (item.formulas.some((f) => mentions(f, name, order))) extCounts.set(item.kind, (extCounts.get(item.kind) ?? 0) + 1);
    for (const h of hyperlinkLocations(s)) if (mentions(h.location, name, order)) links++;
  }
  const lines: string[] = [];
  if (extCounts.size) lines.push(`Excel 2010+ ranges that name ${quoted(name)} will not be ${what}: ${extSummary(extCounts)}.`);
  if (links) lines.push(`${plural(links, 'hyperlink points', 'hyperlinks point')} at ${quoted(name)} and will not be ${what}.`);
  return lines;
}

async function checkRename(wb: Workbook, pkg: OfficePackage, sheetId: number): Promise<GuardResult> {
  const verb = 'rename the sheet';
  if (wb.structureLocked) return { blocked: structureLockedMessage(verb) };
  const e = wb.entry(sheetId);
  if (!e) return { blocked: `Can't ${verb}: there is no sheet with id ${sheetId}.` };
  const order = wb.sheets.map((s) => s.name);
  const { sheets } = await sheetsNaming(wb, e.name, null, verb);

  const charts = chartFormulas(pkg).filter((c) => c.texts !== null && c.texts.some((t) => mentions(t, e.name, order))).map((c) => baseName(c.part));
  const caches = pivotCaches(wb, pkg).filter((c) => c.sheet !== null && foldName(c.sheet) === foldName(e.name));
  const lines: string[] = [];
  if (charts.length || caches.length) {
    const what = listOf([
      ...(charts.length ? [`${plural(charts.length, 'chart', 'charts')} (${someNames(charts)})`] : []),
      ...(caches.length ? [plural(caches.length, 'pivot table source', 'pivot table sources') + ` (${someNames(caches.map((c) => (c.tables.length ? c.tables.join(', ') : baseName(c.part))))})`] : []),
    ]);
    lines.push(`${what} reference ${quoted(e.name)} by name and will not be updated.`);
  }
  lines.push(...namingLines(wb, sheets, e.name, 'updated'));
  return lines.length ? { confirm: lines } : {};
}

async function checkDelete(wb: Workbook, pkg: OfficePackage, sheetId: number): Promise<GuardResult> {
  const verb = 'delete the sheet';
  if (wb.structureLocked) return { blocked: structureLockedMessage(verb) };
  const e = wb.entry(sheetId);
  if (!e) return { blocked: `Can't ${verb}: there is no sheet with id ${sheetId}.` };
  const where = quoted(e.name);
  if (e.kind !== 'worksheet') {
    return { blocked: `Can't ${verb}: ${where} is ${e.kind === 'chartsheet' ? 'a chart sheet' : 'not a plain worksheet'}; only worksheets can be deleted here.` };
  }
  if (!wb.sheets.some((s) => s.id !== e.id && s.kind === 'worksheet' && s.state === 'visible')) {
    return { blocked: `Can't ${verb}: ${where} is the last visible worksheet.` };
  }

  // Pivot cache sources: the sheet itself, a table on it, or a defined name pointing at it.
  const order = wb.sheets.map((s) => s.name);
  const names = definedNames(wb, pkg);
  const caches = pivotCaches(wb, pkg);
  let tableNames: string[] | null = null;
  for (const c of caches) {
    let source = c.sheet !== null && foldName(c.sheet) === foldName(e.name);
    if (!source && c.name !== null) {
      if (tableNames === null) {
        const own = await loadOrBlock(wb, e, verb, 'whether a pivot table uses it');
        tableNames = own.tables().map((t) => foldName(t.name));
      }
      const n = foldName(c.name);
      source = tableNames.includes(n) || names.some((d) => foldName(d.name) === n && mentions(d.text, e.name, order));
    }
    if (source) return { blocked: `Can't ${verb}: ${where} holds the source data of ${pivotLabel(c)}.` };
  }

  const { formulas, sheets } = await sheetsNaming(wb, e.name, e.id, verb);
  const index = wb.sheets.findIndex((s) => s.id === e.id);
  const nameRefs = names.filter((d) => d.localSheetId !== index && mentions(d.text, e.name, order)).length;

  const lines: string[] = [`${where} and everything on it will be deleted.`];
  if (formulas || nameRefs) {
    const what = listOf([
      ...(formulas ? [`${plural(formulas, 'formula', 'formulas')} on other sheets`] : []),
      ...(nameRefs ? [plural(nameRefs, 'defined name', 'defined names')] : []),
    ]);
    lines.push(`${what} refer${formulas + nameRefs === 1 ? 's' : ''} to ${where}; those references will become #REF!.`);
  }
  // Charts outside the deleted sheet that plot its cells (its own charts are deleted with it).
  const own = new Set<string>();
  if (e.part) for (const d of relatedParts(pkg, e.part, 'drawing')) for (const c of relatedParts(pkg, d, 'chart')) own.add(c.toLowerCase());
  const charts = chartFormulas(pkg)
    .filter((c) => !own.has(c.part.toLowerCase()) && c.texts !== null && c.texts.some((t) => mentions(t, e.name, order)))
    .map((c) => baseName(c.part));
  if (charts.length) lines.push(`${plural(charts.length, 'chart', 'charts')} (${someNames(charts)}) ${charts.length === 1 ? 'plots' : 'plot'} cells on ${where} and will not be updated.`);
  lines.push(...namingLines(wb, sheets, e.name, 'updated'));
  return { confirm: lines };
}
