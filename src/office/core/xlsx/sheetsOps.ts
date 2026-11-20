// Add, rename and delete sheet (spec §9.7, §5.2 sheet-name rules, §9.5 recalculation).
//
// Each operation records its changes on the caller's EditBuilder and returns null, or returns the
// refusal (an OfficeError) — after which the CALLER aborts the builder (ops.sheetOp does): a refusal
// found after a write is still all-or-nothing. Checks run before any write wherever they can.
// `ops.sheetOp` adds `calcPr/@fullCalcOnLoad` and removes the calc chain for rename and delete
// (formulas were rewritten); add changes no formula, so it does neither (the calc chain stays).
//
// addSheet     new part `<wbdir>worksheets/sheet{K}.xml` (K = highest existing number, or number a
//              workbook relationship already names, + 1) holding a minimal worksheet (XML declaration,
//              CRLF, `<worksheet xmlns=main><sheetData/></worksheet>`, with the prefix the existing
//              worksheets use instead when they use one); its `Override`; a workbook relationship
//              (`rId<max+1>`); a `<sheet>` with `sheetId` = max + 1, placed after `afterSheetId`
//              (else last). Inserting before other sheets moves their tab indexes, so
//              `definedName/@localSheetId` and `workbookView/@activeTab|@firstSheet` at or after the
//              new index are incremented (the same sheet stays active). Default name `Sheet{n}`,
//              first unused. `docProps/app.xml` is left alone (§9.7). A calc chain, if any, is
//              kept and `calcPr` is not touched: no formula changed (validate.ts treats a sheet
//              part that did not exist at load as having had no formulas).
// renameSheet  validates the name, sets `sheet/@name`, and requalifies (quoting as needed) every
//              reference to the old name in: cell formulas of every worksheet, conditional-format and
//              data-validation formulas, `extLst` formulas (`xm:f`: x14 CF/DV, sparklines), table
//              calculated-column and totals-row formulas, and `definedNames` (incl. `_xlnm.*`). Charts
//              and pivot caches are NOT rewritten: they are the Tier C confirmation of §9.7 (guards.ts).
//              Renaming to the same name changes nothing; a case-only change is allowed.
// deleteSheet  refused (`blocked`) for: the last visible worksheet; a chartsheet or other non-worksheet;
//              a pivot-cache source (`worksheetSource/@sheet`, or `@name` naming one of its tables or a
//              defined name that refers to it); a sheet hosting a pivot table, slicer or timeline (their
//              workbook-level caches would be left pointing at nothing); a sheet whose tables are used
//              by name in a formula or defined name elsewhere (Excel would turn those into #REF!; the
//              editor does not rewrite structured references); a sheet part that any part other than
//              the workbook has a relationship to; an unreadable relationships part anywhere (the
//              exclusive-children set could not be proven). Otherwise: removes the `<sheet>`, its
//              relationship, the part and every part reachable ONLY through it (drawings, charts,
//              images, comments, VML, tables, printer settings… computed as a fixpoint over the whole
//              package's relationship graph), each with its `Override` and its own relationships part;
//              removes names scoped to the sheet and decrements `localSheetId` of later ones (the
//              `definedNames` element goes when it empties); adjusts `workbookView/@activeTab` and
//              `@firstSheet` (clamped, the active tab moved off hidden sheets); and rewrites every
//              reference to the sheet in the remaining formulas (same places as rename) to `#REF!`
//              (a 3-D span ending on it shrinks inward, refs.deleteSheetInFormula).
//
// Formula rewriting refuses (`blocked`) rather than guess when a formula that mentions the name
// cannot be tokenised, when a worksheet that must be scanned is over the "not loaded" size limit,
// or when an unparseable worksheet's text mentions the name.
//
// Sheet entries: `syncSheetEntries(wb)` re-reads `wb.sheets` from workbook.xml. Every operation here
// calls it; after an undo/redo/revert applied from outside, the host must call it too (whenever the
// edit touches the workbook part), alongside ops.refreshAfterEdit. Entries keep their session id
// while their `<sheet>` (r:id, sheetId, part) is unchanged; a sheet that reappears (undo of a delete,
// redo of an add) gets a fresh id, because its part was re-created and any cached Sheet model of the
// old id describes a detached tree.
//
// No `vscode` import here (core rule).

import { tokenize } from '@borgar/fx/xlsx';
import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import { LIMITS } from '../limits.js';
import { attr, child, childrenOf, escapeAttr, escapeText, qnameAt, textContent } from '../xml.js';
import type { XmlElement } from '../xml.js';
import {
  addOverride, addRelationship, normalizePartName, partNameFromTarget, readRelationships, relsPartFor,
  removeOverride, removeRelationship, sourcePartOfRels,
} from '../opc.js';
import type { Relationship } from '../opc.js';
import { NS_MAIN, isMainNs } from './sharedStrings.js';
import { deleteSheetInFormula, foldName, renameSheetInFormula } from './refs.js';
import { sheetNameProblem } from './validate.js';
import type { SheetEntry, Workbook } from './workbook.js';

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
/** `xm:` — formulas and sqrefs inside Excel 2010+ `extLst` content. */
const NS_XM = 'http://schemas.microsoft.com/office/excel/2006/main';
const REL_BASES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
  'http://schemas.microsoft.com/office/2007/relationships/',
  'http://schemas.microsoft.com/office/2011/relationships/',
];
const REL_WORKSHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const CT_WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
/** Relationship kinds from a sheet whose deletion would strand a workbook-level cache. */
const HOSTED_BLOCKERS: Record<string, string> = { pivotTable: 'a pivot table', slicer: 'a slicer', timeline: 'a timeline' };
/** Main-namespace worksheet elements whose text is a formula (outside sheetData). */
const FORMULA_LOCALS = new Set(['formula', 'formula1', 'formula2']);
/** Table column elements whose text is a formula. */
const TABLE_FORMULA_LOCALS = ['calculatedColumnFormula', 'totalsRowFormula'];

/** Thrown inside an operation to stop with a refusal; converted to the return value. */
class SheetOpRefusal extends Error {
  readonly officeError: OfficeError;
  constructor(code: OfficeError['code'], message: string) {
    super(message);
    this.officeError = { code, message };
  }
}

const refuse = (code: OfficeError['code'], message: string): never => { throw new SheetOpRefusal(code, message); };

function run(body: () => void): OfficeError | null {
  try {
    body();
    return null;
  } catch (err) {
    if (err instanceof SheetOpRefusal) return { ...err.officeError };
    throw err;
  }
}

/** Short relationship type ('worksheet', 'pivotTable', …) for the known namespace bases. */
function relKind(type: string): string | undefined {
  for (const base of REL_BASES) if (type.startsWith(base)) return type.slice(base.length);
  return undefined;
}

const lower = (s: string): string => normalizePartName(s).toLowerCase();

/** The part a relationship of `source` targets, in package case; null when external, invalid or missing. */
function targetPart(wb: Workbook, source: string, rel: Relationship): string | null {
  if (rel.external) return null;
  let name: string;
  try { name = partNameFromTarget(source, rel.target); } catch { return null; }
  if (!wb.pkg.has(name)) return null;
  const key = name.toLowerCase();
  return wb.pkg.partNames().find((n) => n.toLowerCase() === key) ?? name;
}

// ---------------------------------------------------------------------------------------------------
// Reading the workbook's sheet list from the tree

interface SheetEl {
  el: XmlElement;
  name: string;
  rId: string;
  fileSheetId: number;
  state: SheetEntry['state'];
  kind: SheetEntry['kind'];
  part: string | null;
}

interface Sheets {
  root: XmlElement;
  ns: string;
  sheetsEl: XmlElement;
  list: SheetEl[];
  rels: Relationship[];
}

function readSheets(wb: Workbook): Sheets {
  const root = wb.pkg.xml(wb.workbookPart).root;
  const ns = root.ns;
  const sheetsEl = child(root, ns, 'sheets');
  if (!sheetsEl) return refuse('internal', 'The workbook has no sheets element.');
  const rels = readRelationships(wb.pkg, wb.workbookPart);
  const byId = new Map(rels.map((r) => [r.id, r] as const));
  const list: SheetEl[] = [];
  for (const el of childrenOf(sheetsEl, ns, 'sheet')) {
    const rId = attr(el, NS_R, 'id') ?? attr(el, NS_R_STRICT, 'id') ?? '';
    const rel = byId.get(rId);
    const k = rel ? relKind(rel.type) : undefined;
    const st = attr(el, '', 'state');
    const fileSheetId = Number(attr(el, '', 'sheetId'));
    list.push({
      el,
      name: attr(el, '', 'name') ?? '',
      rId,
      fileSheetId: Number.isInteger(fileSheetId) ? fileSheetId : 0,
      state: st === 'hidden' ? 'hidden' : st === 'veryHidden' ? 'veryHidden' : 'visible',
      kind: k === 'worksheet' ? 'worksheet' : k === 'chartsheet' ? 'chartsheet' : 'other',
      part: rel ? targetPart(wb, wb.workbookPart, rel) : null,
    });
  }
  return { root, ns, sheetsEl, list, rels };
}

/**
 * Re-read `wb.sheets` from workbook.xml (after any edit that touches it, including undo/redo).
 * Returns whether the list changed. See the header for how session ids are kept.
 */
export function syncSheetEntries(wb: Workbook): boolean {
  const { list } = readSheets(wb);
  const old = wb.sheets;
  const used = new Set<number>();
  const next: SheetEntry[] = list.map((s) => {
    const prev = old.find((e) => !used.has(e.id) && e.rId === s.rId && e.fileSheetId === s.fileSheetId
      && (e.part ?? '').toLowerCase() === (s.part ?? '').toLowerCase());
    let id: number;
    if (prev && !replacedSinceLoad(wb, prev)) id = prev.id;
    else id = wb.allocateSheetId();
    used.add(id);
    return { id, name: s.name, part: s.part, kind: s.kind, state: s.state, rId: s.rId, fileSheetId: s.fileSheetId };
  });
  const same = next.length === old.length && next.every((e, i) => {
    const o = old[i];
    return o.id === e.id && o.name === e.name && o.part === e.part && o.kind === e.kind && o.state === e.state
      && o.rId === e.rId && o.fileSheetId === e.fileSheetId;
  });
  if (!same) wb.sheets = next;
  return !same;
}

/** Whether entry `e` has a loaded Sheet model whose tree is no longer the part's tree. */
function replacedSinceLoad(wb: Workbook, e: SheetEntry): boolean {
  const loaded = wb.loadedSheet(e.id);
  if (!loaded || !e.part || !wb.pkg.has(e.part)) return false;
  try {
    return loaded.doc !== wb.pkg.xml(e.part);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------
// Names (§5.2, §9.7)

/**
 * Spec §5.2/§9.7 sheet-name rules; null when valid: 1–31 characters, none of `: \ / ? * [ ]`, no
 * leading or trailing `'`, no control characters (validate.sheetNameProblem, the save validator's
 * rule), not `History`, and not equal case-insensitively to any of `existing`. Violations: `invalid`.
 */
export function validateSheetName(name: string, existing: readonly string[]): OfficeError | null {
  if (typeof name !== 'string') return { code: 'invalid', message: 'The sheet name must be text.' };
  const why = sheetNameProblem(name);
  if (why) return { code: 'invalid', message: `The sheet name ${why}.` };
  const fold = foldName(name);
  if (fold === foldName('History')) return { code: 'invalid', message: '"History" is a name Excel reserves; choose another sheet name.' };
  if (existing.some((n) => foldName(n) === fold)) return { code: 'invalid', message: `A sheet named "${name}" already exists.` };
  return null;
}

/** `Sheet{n}` for the first n >= 1 not used (case-insensitively). */
function defaultSheetName(existing: readonly string[]): string {
  const used = new Set(existing.map(foldName));
  for (let n = 1; ; n++) {
    const name = `Sheet${n}`;
    if (!used.has(foldName(name))) return name;
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared workbook.xml adjustments

/** `definedName/@localSheetId` values >= `from` move by `delta`. */
function shiftLocalSheetIds(b: EditBuilder, wb: Workbook, s: Sheets, from: number, delta: number): void {
  const dn = child(s.root, s.ns, 'definedNames');
  if (!dn) return;
  for (const d of childrenOf(dn, s.ns, 'definedName')) {
    const v = attr(d, '', 'localSheetId');
    if (v === undefined || !/^\d+$/.test(v)) continue;
    const id = Number(v);
    if (id >= from) b.setAttr(wb.workbookPart, d, '', 'localSheetId', String(id + delta));
  }
}

function setViewIndex(b: EditBuilder, wb: Workbook, view: XmlElement, local: string, value: number): void {
  const cur = attr(view, '', local);
  if (cur === undefined && value === 0) return;
  if (cur === String(value)) return;
  b.setAttr(wb.workbookPart, view, '', local, String(value));
}

function workbookViews(s: Sheets): XmlElement[] {
  const bv = child(s.root, s.ns, 'bookViews');
  return bv ? childrenOf(bv, s.ns, 'workbookView') : [];
}

const intAttr = (el: XmlElement, local: string): number => {
  const v = attr(el, '', local);
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : 0;
};

// ---------------------------------------------------------------------------------------------------
// Formula sites (rename and delete rewrite the same places)

interface FormulaSite { part: string; el: XmlElement; where: string; }

/** Text variants under which a sheet name can appear in a formula (bare/quoted, `'` doubled), folded. */
function needlesFor(name: string): string[] {
  const out = new Set([foldName(name), foldName(name.replace(/'/g, "''"))]);
  return [...out];
}

const mentions = (text: string, needles: readonly string[]): boolean => {
  const t = foldName(text);
  return needles.some((n) => t.includes(n));
};

/** Whether raw part text could hold one of `names` (an XML-escaped, case-insensitive, loose check). */
function rawTextMentions(text: string, names: readonly string[]): boolean {
  const t = text.toLowerCase();
  for (const name of names) {
    for (const v of [name, name.replace(/'/g, "''")]) {
      const e = escapeText(v);
      for (const c of [v, e, e.replace(/'/g, '&apos;'), e.replace(/'/g, '&#39;')]) if (t.includes(c.toLowerCase())) return true;
    }
  }
  return false;
}

function* deepFormulas(el: XmlElement, ns: string): Generator<XmlElement> {
  const stack: XmlElement[] = [];
  for (let k = el.children.length - 1; k >= 0; k--) {
    const c = el.children[k];
    if (c.type === 'el') stack.push(c);
  }
  while (stack.length) {
    const n = stack.pop()!;
    if ((n.ns === ns && FORMULA_LOCALS.has(n.local)) || (n.ns === NS_XM && n.local === 'f')) { yield n; continue; }
    for (let k = n.children.length - 1; k >= 0; k--) {
      const c = n.children[k];
      if (c.type === 'el') stack.push(c);
    }
  }
}

/**
 * Every formula element of the worksheets in `list` (minus `skip`, lower-case part names) and of their
 * tables (minus `skip`). `names` are what the caller looks for: a worksheet that cannot be scanned is a
 * refusal only when it could mention one of them.
 */
function* formulaSites(wb: Workbook, list: readonly SheetEl[], skip: ReadonlySet<string>, names: readonly string[]): Generator<FormulaSite> {
  for (const s of list) {
    if (s.kind !== 'worksheet' || !s.part || skip.has(s.part.toLowerCase())) continue;
    const part = s.part;
    if (wb.partSize(part) > LIMITS.xlsxSkipSheetXmlBytes) {
      refuse('blocked', `Sheet "${s.name}" is too large to update its formulas.`);
    }
    let root: XmlElement;
    try {
      root = wb.pkg.xml(part).root;
    } catch {
      let text = '';
      try { text = wb.pkg.text(part); } catch { /* unreadable */ }
      if (text === '' || rawTextMentions(text, names)) refuse('blocked', `Sheet "${s.name}" can't be read, so its formulas can't be updated.`);
      continue;
    }
    if (root.local !== 'worksheet' || !isMainNs(root.ns)) continue;
    const ns = root.ns;
    for (const top of root.children) {
      if (top.type !== 'el') continue;
      if (top.ns === ns && top.local === 'sheetData') {
        for (const row of childrenOf(top, ns, 'row')) {
          for (const c of childrenOf(row, ns, 'c')) {
            const f = child(c, ns, 'f');
            if (f) yield { part, el: f, where: `sheet "${s.name}" cell ${attr(c, '', 'r') ?? '?'}` };
          }
        }
        continue;
      }
      for (const f of deepFormulas(top, ns)) yield { part, el: f, where: `sheet "${s.name}"` };
    }
    let rels: Relationship[];
    try { rels = readRelationships(wb.pkg, part); } catch { refuse('blocked', `The relationships of sheet "${s.name}" can't be read.`); return; }
    for (const rel of rels) {
      if (relKind(rel.type) !== 'table') continue;
      const tp = targetPart(wb, part, rel);
      if (!tp || skip.has(tp.toLowerCase())) continue;
      let t: XmlElement;
      try { t = wb.pkg.xml(tp).root; } catch { refuse('blocked', `Table part ${tp} can't be read.`); return; }
      if (t.local !== 'table') continue;
      const cols = child(t, t.ns, 'tableColumns');
      for (const col of cols ? childrenOf(cols, t.ns, 'tableColumn') : []) {
        for (const local of TABLE_FORMULA_LOCALS) {
          const f = child(col, t.ns, local);
          if (f) yield { part: tp, el: f, where: `table ${attr(t, '', 'displayName') ?? tp}` };
        }
      }
    }
  }
}

/** Defined names of the workbook as formula sites. */
function definedNameSites(wb: Workbook, s: Sheets): FormulaSite[] {
  const dn = child(s.root, s.ns, 'definedNames');
  return (dn ? childrenOf(dn, s.ns, 'definedName') : [])
    .map((el) => ({ part: wb.workbookPart, el, where: `defined name "${attr(el, '', 'name') ?? ''}"` }));
}

interface Rewrite { part: string; el: XmlElement; text: string; }

/** The new text of `site` under `transform`, or null when unchanged. Refuses when it cannot be computed. */
function planRewrite(site: FormulaSite, needles: readonly string[], transform: (text: string) => string): Rewrite | null {
  const text = textContent(site.el);
  if (text === '' || !mentions(text, needles)) return null;
  let next: string;
  try {
    next = transform(text);
  } catch (err) {
    return refuse('blocked', `The formula in ${site.where} can't be updated: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (next === text) return null;
  const kids = site.el.children;
  if (kids.length !== 1 || (kids[0].type !== 'text' && kids[0].type !== 'cdata')) {
    refuse('blocked', `The formula in ${site.where} has a layout the editor can't rewrite.`);
  }
  return { part: site.part, el: site.el, text: next };
}

function applyRewrite(b: EditBuilder, r: Rewrite): void {
  b.replaceNode(r.part, r.el.children[0], escapeText(r.text));
}

/** Table names (folded) a formula uses: structured references and bare table names. */
function tablesUsed(text: string): string[] {
  let tokens: Array<{ type: string; value: string }>;
  try {
    tokens = tokenize(text, { withLocation: false, allowTernary: false }) as Array<{ type: string; value: string }>;
  } catch {
    return ['\u0000unparsed'];
  }
  const out: string[] = [];
  for (const t of tokens) {
    if (t.type !== 'structured' && t.type !== 'range_named') continue;
    let v = t.value;
    const bang = v.lastIndexOf('!');
    if (bang >= 0) v = v.slice(bang + 1);
    const br = v.indexOf('[');
    if (br >= 0) v = v.slice(0, br);
    if (v !== '') out.push(foldName(v));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// addSheet

/**
 * Add an empty worksheet named `name` (default `Sheet{n}`, first unused) after sheet `afterSheetId`
 * (session id; default: last). Touches workbook.xml, its relationships, `[Content_Types].xml` and
 * creates the sheet part.
 */
export function addSheet(b: EditBuilder, wb: Workbook, name?: string, afterSheetId?: number): OfficeError | null {
  return run(() => {
    if (wb.structureLocked) refuse('read-only', 'The workbook structure is protected: sheets cannot be added, renamed or deleted.');
    const s = readSheets(wb);
    const names = s.list.map((x) => x.name);
    let sheetName: string;
    if (name === undefined) {
      sheetName = defaultSheetName(names);
    } else {
      const err = validateSheetName(name, names);
      if (err) refuse(err.code, err.message);
      sheetName = name;
    }
    let insertIdx = s.list.length;
    if (afterSheetId !== undefined) {
      const e = wb.entry(afterSheetId);
      if (!e) refuse('invalid', `There is no sheet with id ${afterSheetId}.`);
      const i = s.list.findIndex((x) => x.rId === e!.rId);
      if (i < 0) refuse('stale', 'The sheet list changed; reload the workbook.');
      insertIdx = i + 1;
    }
    const sheetQ = qnameAt(s.sheetsEl, s.ns, 'sheet');
    if (sheetQ === undefined) refuse('blocked', "The workbook uses a namespace layout the editor can't write to safely.");

    // The part: <wbdir>worksheets/sheet{K}.xml, K past every existing part and every name a
    // workbook relationship already uses (a dangling target must not silently resolve to the new part).
    const slash = wb.workbookPart.lastIndexOf('/');
    const dir = slash >= 0 ? wb.workbookPart.slice(0, slash + 1) : '';
    const re = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}worksheets/sheet(\\d+)\\.xml$`, 'i');
    let k = 0;
    const consider = (n: string): void => { const m = re.exec(n); if (m) k = Math.max(k, Number(m[1])); };
    for (const n of wb.pkg.partNames()) consider(n);
    for (const r of s.rels) {
      if (r.external) continue;
      try { consider(partNameFromTarget(wb.workbookPart, r.target)); } catch { /* ignore */ }
    }
    const part = `${dir}worksheets/sheet${k + 1}.xml`;
    if (wb.pkg.has(part)) refuse('internal', `${part} already exists.`);

    b.setPart(part, new TextEncoder().encode(minimalWorksheet(wb, s)));
    addOverride(b, part, CT_WORKSHEET);
    const rId = addRelationship(b, wb.workbookPart, REL_WORKSHEET, `worksheets/sheet${k + 1}.xml`);

    // The <sheet> element.
    const fileSheetId = Math.max(0, ...s.list.map((x) => x.fileSheetId)) + 1;
    let rAttr = qnameAt(s.sheetsEl, NS_R, 'id');
    let decl = '';
    if (rAttr === undefined || !rAttr.includes(':')) { rAttr = 'r:id'; decl = ` xmlns:r="${NS_R}"`; }
    const xml = `<${sheetQ} name="${escapeAttr(sheetName)}" sheetId="${fileSheetId}" ${rAttr}="${escapeAttr(rId)}"${decl}/>`;
    let at: number;
    if (insertIdx < s.list.length) {
      at = s.sheetsEl.children.indexOf(s.list[insertIdx].el);
    } else if (s.list.length > 0) {
      at = s.sheetsEl.children.indexOf(s.list[s.list.length - 1].el) + 1;
    } else {
      at = s.sheetsEl.children.length;
    }
    b.insertAt(wb.workbookPart, s.sheetsEl, at, xml);

    // The calc chain stays: no formula changed and the new sheet has none (its cells are listed by
    // sheetId, which existing sheets keep), so Excel neither needs nor rebuilds anything (§9.5).

    // Tab indexes at or after the insertion point move up by one.
    if (insertIdx < s.list.length) {
      shiftLocalSheetIds(b, wb, s, insertIdx, +1);
      for (const v of workbookViews(s)) {
        for (const local of ['activeTab', 'firstSheet']) {
          const i = intAttr(v, local);
          if (i >= insertIdx) setViewIndex(b, wb, v, local, i + 1);
        }
      }
    }
    syncSheetEntries(wb);
  });
}

/** The new part's text: same main-namespace binding style (default or prefix) as an existing worksheet. */
function minimalWorksheet(wb: Workbook, s: Sheets): string {
  let prefix = '';
  for (const x of s.list) {
    if (x.kind !== 'worksheet' || !x.part) continue;
    try {
      const root = wb.pkg.xml(x.part).root;
      if (root.local === 'worksheet' && root.ns === NS_MAIN) {
        const colon = root.rawName.indexOf(':');
        prefix = colon > 0 ? root.rawName.slice(0, colon) : '';
        break;
      }
    } catch { /* try the next one */ }
  }
  const p = prefix ? `${prefix}:` : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<${p}worksheet xmlns${prefix ? ':' + prefix : ''}="${NS_MAIN}"><${p}sheetData/></${p}worksheet>`;
}

// ---------------------------------------------------------------------------------------------------
// renameSheet

/** Rename sheet `sheetId` (session id) to `name` and requalify every formula reference to it (§9.7). */
export function renameSheet(b: EditBuilder, wb: Workbook, sheetId: number, name: string): OfficeError | null {
  return run(() => {
    if (wb.structureLocked) refuse('read-only', 'The workbook structure is protected: sheets cannot be added, renamed or deleted.');
    const e = wb.entry(sheetId);
    if (!e) refuse('invalid', `There is no sheet with id ${sheetId}.`);
    const s = readSheets(wb);
    const me = s.list.find((x) => x.rId === e!.rId);
    if (!me) refuse('stale', 'The sheet list changed; reload the workbook.');
    const target = me!;
    if (name === target.name) return;
    const err = validateSheetName(name, s.list.filter((x) => x !== target).map((x) => x.name));
    if (err) refuse(err.code, err.message);

    const oldName = target.name;
    const needles = needlesFor(oldName);
    const transform = (t: string): string => renameSheetInFormula(t, oldName, name);
    const plan: Rewrite[] = [];
    for (const site of formulaSites(wb, s.list, new Set(), [oldName])) {
      const r = planRewrite(site, needles, transform);
      if (r) plan.push(r);
    }
    for (const site of definedNameSites(wb, s)) {
      const r = planRewrite(site, needles, transform);
      if (r) plan.push(r);
    }
    b.setAttr(wb.workbookPart, target.el, '', 'name', name);
    for (const r of plan) applyRewrite(b, r);
    syncSheetEntries(wb);
  });
}

// ---------------------------------------------------------------------------------------------------
// deleteSheet

/** Delete worksheet `sheetId` (session id) and everything only it owns (§9.7). See the header for refusals. */
export function deleteSheet(b: EditBuilder, wb: Workbook, sheetId: number): OfficeError | null {
  return run(() => {
    if (wb.structureLocked) refuse('read-only', 'The workbook structure is protected: sheets cannot be added, renamed or deleted.');
    const e = wb.entry(sheetId);
    if (!e) refuse('invalid', `There is no sheet with id ${sheetId}.`);
    const s = readSheets(wb);
    const idx = s.list.findIndex((x) => x.rId === e!.rId);
    if (idx < 0) refuse('stale', 'The sheet list changed; reload the workbook.');
    const target = s.list[idx];
    if (target.kind !== 'worksheet') refuse('blocked', `"${target.name}" is not a worksheet; only worksheets can be deleted here.`);
    if (!s.list.some((x, i) => i !== idx && x.kind === 'worksheet' && x.state === 'visible')) {
      refuse('blocked', 'A workbook must keep at least one visible worksheet.');
    }
    const part = target.part;
    const order = s.list.map((x) => x.name);

    // Hosted content whose workbook-level cache would be stranded; the sheet's tables.
    const tableNames: string[] = [];
    if (part) {
      let rels: Relationship[];
      try { rels = readRelationships(wb.pkg, part); } catch { return refuse('blocked', `The relationships of sheet "${target.name}" can't be read.`); }
      for (const rel of rels) {
        const k = relKind(rel.type) ?? '';
        if (HOSTED_BLOCKERS[k]) refuse('blocked', `Sheet "${target.name}" contains ${HOSTED_BLOCKERS[k]}; delete it in Excel.`);
        if (k !== 'table') continue;
        const tp = targetPart(wb, part, rel);
        if (!tp) continue;
        try {
          const t = wb.pkg.xml(tp).root;
          for (const n of [attr(t, '', 'displayName'), attr(t, '', 'name')]) if (n) tableNames.push(foldName(n));
        } catch {
          refuse('blocked', `Table part ${tp} can't be read.`);
        }
      }
    }

    // Pivot-cache source.
    checkNotPivotSource(wb, s, target, tableNames);

    // Exclusive children (fixpoint over the package relationship graph).
    const doomed = part ? exclusiveParts(wb, part, target) : new Set<string>();

    // Plan formula rewrites (and refuse table uses elsewhere) before writing anything.
    const needles = needlesFor(target.name);
    const transform = (t: string): string => deleteSheetInFormula(t, target.name, order);
    const tableSet = new Set(tableNames);
    const plan: Rewrite[] = [];
    const dnScoped = new Set<XmlElement>();
    const dn = child(s.root, s.ns, 'definedNames');
    const names = dn ? childrenOf(dn, s.ns, 'definedName') : [];
    for (const d of names) if (attr(d, '', 'localSheetId') === String(idx)) dnScoped.add(d);
    const sites = [
      ...formulaSites(wb, s.list, doomed, [target.name, ...tableNames]),
      ...definedNameSites(wb, s).filter((x) => !dnScoped.has(x.el)),
    ];
    for (const site of sites) {
      if (tableSet.size > 0) {
        const text = textContent(site.el);
        if (text !== '' && [...tableSet].some((t) => foldName(text).includes(t))) {
          const used = tablesUsed(text);
          if (used.some((t) => tableSet.has(t) || t === '\u0000unparsed')) {
            refuse('blocked', `The formula in ${site.where} uses a table on sheet "${target.name}"; change it before deleting the sheet.`);
          }
        }
      }
      const r = planRewrite(site, needles, transform);
      if (r) plan.push(r);
    }

    // --- writes ---
    // workbook.xml: names, views, the <sheet> element.
    if (dn && names.length > 0 && names.every((d) => dnScoped.has(d))) {
      b.removeNode(wb.workbookPart, dn);
    } else {
      for (const d of dnScoped) b.removeNode(wb.workbookPart, d);
      shiftLocalSheetIds(b, wb, s, idx + 1, -1);
    }
    const remaining = s.list.filter((_, i) => i !== idx);
    for (const v of workbookViews(s)) {
      let a = intAttr(v, 'activeTab');
      if (a > idx) a--;
      a = Math.min(a, remaining.length - 1);
      if (remaining[a].state !== 'visible') {
        let j = remaining.findIndex((x, i) => i >= a && x.state === 'visible');
        if (j < 0) j = remaining.map((x) => x.state).lastIndexOf('visible');
        if (j >= 0) a = j;
      }
      setViewIndex(b, wb, v, 'activeTab', a);
      let f = intAttr(v, 'firstSheet');
      if (f > idx) f--;
      setViewIndex(b, wb, v, 'firstSheet', Math.min(f, remaining.length - 1));
    }
    for (const r of plan) applyRewrite(b, r);
    b.removeNode(wb.workbookPart, target.el);
    if (s.rels.some((r) => r.id === target.rId)) removeRelationship(b, wb.workbookPart, target.rId);

    // Parts: each doomed part, its Override and its own relationships part.
    for (const p of wb.pkg.partNames().filter((n) => doomed.has(n.toLowerCase()))) {
      const rp = relsPartFor(p);
      if (wb.pkg.has(rp)) {
        removeOverride(b, rp);
        b.setPart(rp, null);
      }
      removeOverride(b, p);
      b.setPart(p, null);
    }
    syncSheetEntries(wb);
  });
}

/** Refuse when a pivot cache is built from `target` (by sheet name, one of its tables, or a name referring to it). */
function checkNotPivotSource(wb: Workbook, s: Sheets, target: SheetEl, tableNames: readonly string[]): void {
  const fold = foldName(target.name);
  const needles = needlesFor(target.name);
  const dn = child(s.root, s.ns, 'definedNames');
  const namesOnSheet = new Set<string>();
  for (const d of dn ? childrenOf(dn, s.ns, 'definedName') : []) {
    const n = attr(d, '', 'name');
    if (n && mentions(textContent(d), needles)) namesOnSheet.add(foldName(n));
  }
  for (const rel of s.rels) {
    if (relKind(rel.type) !== 'pivotCacheDefinition') continue;
    const p = targetPart(wb, wb.workbookPart, rel);
    if (!p) continue;
    let root: XmlElement;
    try { root = wb.pkg.xml(p).root; } catch { return refuse('blocked', `Pivot cache ${p} can't be read.`); }
    const src = child(root, root.ns, 'cacheSource');
    const ws = src ? child(src, root.ns, 'worksheetSource') : undefined;
    if (!ws) continue;
    if (attr(ws, NS_R, 'id') !== undefined || attr(ws, NS_R_STRICT, 'id') !== undefined) continue;   // another workbook
    const sheet = attr(ws, '', 'sheet');
    const name = attr(ws, '', 'name');
    const byName = name !== undefined && (tableNames.includes(foldName(name)) || namesOnSheet.has(foldName(name)));
    if ((sheet !== undefined && foldName(sheet) === fold) || byName) {
      refuse('blocked', `Sheet "${target.name}" is the source of a pivot table; it can't be deleted here.`);
    }
  }
}

/**
 * Lower-case names of `part` and every part reachable from it only through parts in the set (a
 * fixpoint over every relationships part of the package). Refuses when a relationships part cannot be
 * read or when anything but the workbook has a relationship to the sheet part itself.
 */
function exclusiveParts(wb: Workbook, part: string, target: SheetEl): Set<string> {
  const pkg = wb.pkg;
  const incoming = new Map<string, Set<string>>();   // target -> sources ('' = package root)
  const outgoing = new Map<string, Set<string>>();
  for (const rp of pkg.partNames()) {
    const source = sourcePartOfRels(rp);
    if (source === undefined) continue;
    if (source !== '' && !pkg.has(source)) continue;   // relationships of a missing part: inert
    let rels: Relationship[];
    try { rels = readRelationships(pkg, source); } catch { return refuse('blocked', `${rp} can't be read, so the parts only "${target.name}" uses can't be determined.`); }
    const src = source === '' ? '' : lower(source);
    for (const r of rels) {
      if (r.external) continue;
      let t: string;
      try { t = partNameFromTarget(source, r.target).toLowerCase(); } catch { continue; }
      if (!pkg.has(t)) continue;
      if (!incoming.has(t)) incoming.set(t, new Set());
      incoming.get(t)!.add(src);
      if (!outgoing.has(src)) outgoing.set(src, new Set());
      outgoing.get(src)!.add(t);
    }
  }
  const sheetKey = part.toLowerCase();
  const wbKey = wb.workbookPart.toLowerCase();
  for (const src of incoming.get(sheetKey) ?? []) {
    if (src !== wbKey) refuse('blocked', `Sheet "${target.name}" is linked from ${src || 'the package'}; it can't be deleted here.`);
  }
  const doomed = new Set([sheetKey]);
  for (let changed = true; changed;) {
    changed = false;
    for (const d of [...doomed]) {
      for (const t of outgoing.get(d) ?? []) {
        if (doomed.has(t) || t === wbKey) continue;
        const from = incoming.get(t) ?? new Set();
        if ([...from].every((x) => doomed.has(x))) { doomed.add(t); changed = true; }
      }
    }
  }
  return doomed;
}
