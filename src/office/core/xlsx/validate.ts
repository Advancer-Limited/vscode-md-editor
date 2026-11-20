// WP-22: xlsx format validators (spec §13.3 "Xlsx" + the styles rules), run on the re-opened output
// of every save and backup (§6.5 step 4) after core/save.ts `packageValidator`.
//
// Scope, so a save costs what the edit touched:
//   workbook rules  always (workbook.xml is small): sheet names valid and unique, every sheet/@r:id
//                   resolves to an existing part, definedName/@localSheetId < sheet count, and the
//                   calc chain is absent whenever formulas were touched
//   sheet rules     every worksheet part in `touched`: rows strictly ascending by r, cells strictly
//                   ascending within their row and inside the sheet, dimension covers every cell,
//                   c/@s < cellXfs record count, t="s" index < shared-string count, merge ranges do
//                   not overlap, every <f> parses, each shared-formula group has exactly one master;
//                   with a ValidatorContext also: every formula the edit changed (its text differs
//                   from the cell's formula as loaded, a shared dependant's read through its master)
//                   passes refs.validateFormula in the workbook context (function argument counts,
//                   literals, sheet/table names, no external references) — unless the loaded sheet
//                   already had a formula failing for the same reason (a structural shift or a
//                   materialisation rewrites file formulas without making them worse)
//   styles rules    when the styles part is touched: cellXfs/@count (when present) equals the number
//                   of xf records; every xf/@numFmtId is built-in (< 164) or defined in numFmts;
//                   fontId/fillId/borderId within their tables, xfId < cellStyleXfs records; every
//                   cellXfs record that existed at load is still there, at the same index, with
//                   identical text
//
// With a ValidatorContext the output is compared with the package as loaded: a problem the file already
// had (same key) is not reported, so a file that arrived slightly malformed can still be saved, but an
// edit can never add a problem. "Formulas were touched" means a touched sheet's formulas differ from the
// loaded ones (without a context: a touched sheet has any formula).
//
// `xlsxValidator.async` runs the same rules with yields to the event loop (large parts parsed with the
// yielding parser, scans paused every few thousand cells); the save path uses it (Gate R2 F5).
//
// The validator reads the XML trees directly — it shares no code with the writers it checks except the
// lossless parser, the A1 parser and the formula checks (refs.checkFormulaSyntax / validateFormula).
//
// No `vscode` import here (core rule).

import type { Validator, ValidatorContext } from '../save.js';
import { LIMITS } from '../limits.js';
import type { OfficePackage } from '../package.js';
import { attr, child, childrenOf, serialize, textContent } from '../xml.js';
import type { XmlElement } from '../xml.js';
import { contentTypeOf, mainPart, normalizePartName, partNameFromTarget, readRelationships } from '../opc.js';
import type { Relationship } from '../opc.js';
import { isMainNs } from './sharedStrings.js';
import { MAX_COLS, MAX_ROWS, a1ToRange } from './sheet.js';
import type { Range } from './sheet.js';
import { checkFormulaSyntax, formulaContextOf, translateFormula, validateFormula } from './refs.js';
import type { FormulaContext } from './refs.js';

interface Problem { key: string; message: string }

const REL_BASES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
];
const NS_R = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const CT_CALC_CHAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml';
const DEFAULT_CALC_CHAIN = 'xl/calcChain.xml';
/** Custom number formats start here (ECMA-376 §18.8.30); every id below is built-in. */
const FIRST_CUSTOM_NUMFMT = 164;

const lower = (s: string): string => normalizePartName(s).toLowerCase();
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function relKind(type: string): string | undefined {
  for (const base of REL_BASES) if (type.startsWith(base)) return type.slice(base.length);
  return undefined;
}

/** Non-negative integer attribute value, or undefined when absent; NaN when present but not one. */
function uintAttr(el: XmlElement, local: string): number | undefined {
  const v = attr(el, '', local);
  if (v === undefined) return undefined;
  return /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : NaN;
}

/** Column letters + row digits ("B3") -> [r, c] 0-based, without `$`; undefined when not a cell inside the sheet. */
function cellRc(ref: string): [number, number] | undefined {
  if (!/^[A-Za-z]{1,3}[1-9]\d{0,6}$/.test(ref)) return undefined;
  const rg = a1ToRange(ref);
  return rg ? [rg[0], rg[1]] : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Package model the rules need (read from the trees, not from Workbook)

interface SheetRef { name: string; rId: string; part: string | null; worksheet: boolean }

interface WorkbookFacts {
  workbookPart: string;
  rels: Relationship[];
  sheets: SheetRef[];
  stylesPart: string | null;
  sstPart: string | null;
  problems: Problem[];
}

function resolveRel(pkg: OfficePackage, source: string, rel: Relationship | undefined): string | null {
  if (!rel || rel.external) return null;
  let name: string;
  try { name = partNameFromTarget(source, rel.target); } catch { return null; }
  if (!pkg.has(name)) return null;
  const key = name.toLowerCase();
  return pkg.partNames().find((n) => n.toLowerCase() === key) ?? name;
}

/** ECMA-376 §18.2.19 / Excel: 1–31 characters, none of : \ / ? * [ ], not starting or ending with '. */
export function sheetNameProblem(name: string): string | undefined {
  if (name.length === 0) return 'is empty';
  if (name.length > 31) return 'is longer than 31 characters';
  if (/[:\\/?*[\]]/.test(name)) return 'contains one of : \\ / ? * [ ]';
  if (name.startsWith("'") || name.endsWith("'")) return "starts or ends with '";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(name)) return 'contains a control character';
  return undefined;
}

function workbookFacts(pkg: OfficePackage): WorkbookFacts | Problem[] {
  let workbookPart: string;
  try { workbookPart = mainPart(pkg).name; } catch (e) { return [{ key: 'wb-main', message: `The workbook part cannot be found: ${errText(e)}` }]; }
  let root: XmlElement;
  try { root = pkg.xml(workbookPart).root; } catch (e) { return [{ key: 'wb-xml', message: `${workbookPart}: ${errText(e)}` }]; }
  if (root.local !== 'workbook' || !isMainNs(root.ns)) return [{ key: 'wb-root', message: `${workbookPart}: root element is not a SpreadsheetML workbook` }];
  let rels: Relationship[];
  try { rels = readRelationships(pkg, workbookPart); } catch (e) { return [{ key: 'wb-rels', message: `${workbookPart}: relationships: ${errText(e)}` }]; }
  const ns = root.ns;
  const problems: Problem[] = [];
  const byId = new Map(rels.map((r) => [r.id, r] as const));
  const sheets: SheetRef[] = [];
  const sheetsEl = child(root, ns, 'sheets');
  if (!sheetsEl) problems.push({ key: 'wb-nosheets', message: `${workbookPart}: no sheets element` });
  const seen = new Map<string, string>();
  for (const el of sheetsEl ? childrenOf(sheetsEl, ns, 'sheet') : []) {
    const name = attr(el, '', 'name') ?? '';
    const rId = NS_R.map((n) => attr(el, n, 'id')).find((v) => v !== undefined) ?? '';
    const why = sheetNameProblem(name);
    if (why) problems.push({ key: `sheet-name:${name}`, message: `${workbookPart}: sheet name "${name}" ${why}` });
    const fold = name.toLocaleUpperCase('en-US');
    if (seen.has(fold)) problems.push({ key: `sheet-dup:${fold}`, message: `${workbookPart}: sheet name "${name}" is used twice` });
    seen.set(fold, name);
    const rel = byId.get(rId);
    const part = resolveRel(pkg, workbookPart, rel);
    if (!rel || rel.external || !part) {
      problems.push({ key: `sheet-rid:${rId}`, message: `${workbookPart}: sheet "${name}" relationship "${rId}" does not resolve to a part` });
    }
    sheets.push({ name, rId, part, worksheet: rel !== undefined && relKind(rel.type) === 'worksheet' });
  }
  const dn = child(root, ns, 'definedNames');
  for (const d of dn ? childrenOf(dn, ns, 'definedName') : []) {
    const id = uintAttr(d, 'localSheetId');
    if (id === undefined) continue;
    if (!(id < sheets.length)) {
      const name = attr(d, '', 'name') ?? '';
      problems.push({ key: `defname-local:${name}:${attr(d, '', 'localSheetId')}`, message: `${workbookPart}: defined name "${name}" has localSheetId ${attr(d, '', 'localSheetId')} but there are ${sheets.length} sheets` });
    }
  }
  const first = (kind: string): string | null => resolveRel(pkg, workbookPart, rels.find((r) => !r.external && relKind(r.type) === kind));
  return { workbookPart, rels, sheets, stylesPart: first('styles'), sstPart: first('sharedStrings'), problems };
}

/** Whether the package still has a calc chain (relationship, conventional part, or calcChain content type). */
function hasCalcChain(pkg: OfficePackage, f: WorkbookFacts): boolean {
  if (f.rels.some((r) => relKind(r.type) === 'calcChain')) return true;
  if (pkg.has(DEFAULT_CALC_CHAIN)) return true;
  for (const n of pkg.partNames()) {
    let ct: string | undefined;
    try { ct = contentTypeOf(pkg, n); } catch { ct = undefined; }
    if (ct === CT_CALC_CHAIN) return true;
  }
  return false;
}

/** Number of `xf` records in cellXfs (0 without a usable styles part). */
function cellXfCount(pkg: OfficePackage, stylesPart: string | null): number {
  if (!stylesPart) return 0;
  try {
    const root = pkg.xml(stylesPart).root;
    const x = child(root, root.ns, 'cellXfs');
    return x ? childrenOf(x, root.ns, 'xf').length : 0;
  } catch {
    return 0;
  }
}

function sharedStringCount(pkg: OfficePackage, sstPart: string | null): number {
  if (!sstPart) return 0;
  try {
    const root = pkg.xml(sstPart).root;
    return childrenOf(root, root.ns, 'si').length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------
// Sheet rules

interface SheetScan {
  problems: Problem[];
  /** Every `<f>` (label + serialised element), in order: the calc-chain comparison. */
  formulas: string[];
  /** Formula text written in the cell (not data tables, not empty), by cell label. */
  explicit: Array<[string, string]>;
  /** The formula each formula cell has: its own text, or a shared dependant's master text translated to it. */
  effective: Map<string, string>;
}

// ---------------------------------------------------------------------------------------------------
// Stepping: the rules are generators so the same code runs in one block (xlsxValidator) or with
// yields to the event loop (xlsxValidator.async, spec §10.2). A generator yields TICK at points where
// a pause is cheap (every TICK_CELLS cells, every TICK_ITEMS list items), and a Need before it reads a
// part's tree, so the async driver can parse a large part with the yielding parser first; the
// synchronous driver ignores both, and `pkg.xml` then parses (or throws) exactly as before.

const TICK = 0;
interface Need { pkg: OfficePackage; part: string }
type Step = typeof TICK | Need;
type Steps<T> = Generator<Step, T, void>;
const TICK_CELLS = 2000;
const TICK_ITEMS = 500;

function runSync<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

async function runAsync<T>(g: Steps<T>, yieldEveryMs: number): Promise<T> {
  let deadline = Date.now() + yieldEveryMs;
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (r.value !== TICK) {
      const { pkg, part } = r.value;
      // Errors are left for the generator's own pkg.xml call to raise, as the sync path does.
      if (pkg.has(part)) await pkg.xmlAsync(part).catch(() => undefined);
      deadline = Date.now() + yieldEveryMs;
    } else if (Date.now() >= deadline) {
      await yieldToEventLoop();
      deadline = Date.now() + yieldEveryMs;
    }
  }
}

function* scanSheet(pkg: OfficePackage, part: string, xfCount: number, sstCount: number): Steps<SheetScan> {
  const problems: Problem[] = [];
  const formulas: string[] = [];
  const explicit: Array<[string, string]> = [];
  const effective = new Map<string, string>();
  const done = (): SheetScan => ({ problems, formulas, explicit, effective });
  const add = (key: string, message: string): void => { problems.push({ key: `${lower(part)}|${key}`, message: `${part}: ${message}` }); };
  let root: XmlElement;
  yield { pkg, part };
  try { root = pkg.xml(part).root; } catch (e) { add('xml', errText(e)); return done(); }
  const ns = root.ns;
  if (root.local !== 'worksheet' || !isMainNs(ns)) { add('root', 'root element is not a SpreadsheetML worksheet'); return done(); }
  let tick = 0;
  const masterAt = new Map<string, { r: number; c: number; text: string }>();
  const dependantsAt: Array<{ label: string; si: string; r: number; c: number }> = [];

  let box: Range | null = null;
  const masters = new Map<string, number>();
  const dependants = new Set<string>();
  const sheetData = child(root, ns, 'sheetData');
  let prevRow = 0;
  for (const row of sheetData ? childrenOf(sheetData, ns, 'row') : []) {
    if (++tick >= TICK_CELLS) { tick = 0; yield TICK; }
    const rAttr = uintAttr(row, 'r');
    const r = rAttr === undefined ? prevRow + 1 : rAttr;
    if (!Number.isInteger(r) || r < 1 || r > MAX_ROWS) { add(`row-r:${attr(row, '', 'r')}`, `row r="${attr(row, '', 'r')}" is not a row number inside the sheet`); continue; }
    if (r <= prevRow) add(`row-order:${r}`, `row ${r} comes after row ${prevRow} (rows must be strictly ascending)`);
    prevRow = Math.max(prevRow, r);
    let prevCol = -1;
    for (const c of childrenOf(row, ns, 'c')) {
      if (++tick >= TICK_CELLS) { tick = 0; yield TICK; }
      const ref = attr(c, '', 'r');
      let rc: [number, number] | undefined;
      if (ref === undefined) rc = prevCol + 1 < MAX_COLS ? [r - 1, prevCol + 1] : undefined;
      else rc = cellRc(ref);
      const label = ref ?? `(column ${prevCol + 2} of row ${r})`;
      if (!rc) { add(`cell-ref:${label}`, `cell ${label} is not a cell reference inside the sheet`); continue; }
      if (rc[0] !== r - 1) add(`cell-row:${label}`, `cell ${label} is in row ${r}`);
      if (rc[1] <= prevCol) add(`cell-order:${label}`, `cell ${label} is out of order in row ${r} (cells must be strictly ascending)`);
      prevCol = Math.max(prevCol, rc[1]);
      box = box ? [Math.min(box[0], rc[0]), Math.min(box[1], rc[1]), Math.max(box[2], rc[0]), Math.max(box[3], rc[1])] : [rc[0], rc[1], rc[0], rc[1]];

      const s = uintAttr(c, 's');
      if (s !== undefined && !(s === 0 || s < xfCount)) add(`s:${label}`, `cell ${label} has style s="${attr(c, '', 's')}" but there are ${xfCount} cell formats`);
      const t = attr(c, '', 't');
      if (t === 's') {
        const v = child(c, ns, 'v');
        const text = v ? textContent(v).trim() : '';
        const idx = /^\d+$/.test(text) ? Number(text) : NaN;
        if (!(idx < sstCount)) add(`sst:${label}`, `cell ${label} refers to shared string ${text || '(none)'} but there are ${sstCount}`);
      }
      const f = child(c, ns, 'f');
      if (f) {
        const ft = attr(f, '', 't') ?? 'normal';
        const text = textContent(f);
        formulas.push(`${label}\u0000${serialize(f)}`);
        if (ft === 'shared') {
          const si = attr(f, '', 'si') ?? '';
          if (attr(f, '', 'ref') !== undefined) {
            masters.set(si, (masters.get(si) ?? 0) + 1);
            if (!masterAt.has(si)) masterAt.set(si, { r: rc[0], c: rc[1], text });
          } else {
            dependants.add(si);
            if (text === '') dependantsAt.push({ label, si, r: rc[0], c: rc[1] });
          }
        }
        if (ft !== 'dataTable' && text !== '') {
          explicit.push([label, text]);
          effective.set(label, text);
          const check = checkFormulaSyntax(text);
          if (!check.ok) add(`f:${label}`, `cell ${label} has a formula that does not parse (at ${check.position}: ${check.message})`);
        } else if (ft === 'normal' || ft === 'array') {
          add(`f-empty:${label}`, `cell ${label} has an empty formula`);
        }
      }
    }
  }
  for (const d of dependantsAt) {
    if (++tick >= TICK_ITEMS) { tick = 0; yield TICK; }
    const m = masterAt.get(d.si);
    if (!m || m.text === '') continue;
    try { effective.set(d.label, translateFormula(m.text, d.r - m.r, d.c - m.c)); } catch { /* not comparable */ }
  }
  for (const [si, n] of masters) if (n !== 1) add(`shared:${si}`, `shared formula group si="${si}" has ${n} masters`);
  for (const si of dependants) if (!masters.has(si)) add(`shared:${si}`, `shared formula group si="${si}" has no master`);

  const dim = child(root, ns, 'dimension');
  const dimRef = dim ? attr(dim, '', 'ref') : undefined;
  if (box && dimRef !== undefined) {
    const d = a1ToRange(dimRef.replace(/\$/g, ''));
    if (!d || d[0] > box[0] || d[1] > box[1] || d[2] < box[2] || d[3] < box[3]) {
      add('dim', `dimension "${dimRef}" does not cover every cell`);
    }
  }

  const mc = child(root, ns, 'mergeCells');
  const merges: Array<{ ref: string; rg: Range }> = [];
  for (const m of mc ? childrenOf(mc, ns, 'mergeCell') : []) {
    const ref = attr(m, '', 'ref') ?? '';
    const rg = a1ToRange(ref);
    if (!rg) { add(`merge-ref:${ref}`, `merged range "${ref}" is not a range`); continue; }
    merges.push({ ref, rg });
  }
  merges.sort((a, b) => a.rg[0] - b.rg[0]);
  for (let i = 0; i < merges.length; i++) {
    if (++tick >= TICK_ITEMS) { tick = 0; yield TICK; }
    const a = merges[i].rg;
    for (let j = i + 1; j < merges.length && merges[j].rg[0] <= a[2]; j++) {
      const b = merges[j].rg;
      if (b[1] <= a[3] && b[3] >= a[1]) add(`merge-overlap:${merges[i].ref}:${merges[j].ref}`, `merged ranges ${merges[i].ref} and ${merges[j].ref} overlap`);
    }
  }
  return done();
}

/**
 * Formulas of `cur` the edit changed (text differs from the loaded cell's formula in `orig`) that
 * refs.validateFormula refuses in `fctx`, unless the loaded sheet had a formula refused for the same reason.
 */
function* changedFormulaProblems(part: string, cur: SheetScan, orig: SheetScan | undefined, fctx: FormulaContext): Steps<Problem[]> {
  const out: Problem[] = [];
  let before: Set<string> | undefined;
  let tick = 0;
  for (const [label, text] of cur.explicit) {
    if (++tick >= TICK_ITEMS) { tick = 0; yield TICK; }
    if (orig?.effective.get(label) === text) continue;
    const check = validateFormula(text, fctx);
    if (check.ok) continue;
    if (!before) {
      before = new Set();
      for (const t of orig?.effective.values() ?? []) {
        if (++tick >= TICK_ITEMS) { tick = 0; yield TICK; }
        const v = validateFormula(t, fctx);
        if (!v.ok) before.add(v.message);
      }
    }
    if (before.has(check.message)) continue;
    out.push({ key: `${lower(part)}|fctx:${label}`, message: `${part}: cell ${label} has a formula Excel would refuse (${check.message})` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Styles rules

function cellXfsRecords(pkg: OfficePackage, stylesPart: string): string[] | undefined {
  try {
    const root = pkg.xml(stylesPart).root;
    const x = child(root, root.ns, 'cellXfs');
    return x ? childrenOf(x, root.ns, 'xf').map((e) => serialize(e)) : [];
  } catch {
    return undefined;
  }
}

function stylesProblems(pkg: OfficePackage, part: string): Problem[] {
  const out: Problem[] = [];
  const add = (key: string, message: string): void => { out.push({ key: `styles|${key}`, message: `${part}: ${message}` }); };
  let root: XmlElement;
  try { root = pkg.xml(part).root; } catch (e) { add('xml', errText(e)); return out; }
  const ns = root.ns;
  if (root.local !== 'styleSheet' || !isMainNs(ns)) { add('root', 'root element is not a SpreadsheetML styleSheet'); return out; }
  const count = (table: string, item: string): number => {
    const t = child(root, ns, table);
    return t ? childrenOf(t, ns, item).length : 0;
  };
  const fonts = count('fonts', 'font'), fills = count('fills', 'fill'), borders = count('borders', 'border');
  const styleXfs = count('cellStyleXfs', 'xf');
  const numFmtIds = new Set<number>();
  const nf = child(root, ns, 'numFmts');
  for (const e of nf ? childrenOf(nf, ns, 'numFmt') : []) {
    const id = uintAttr(e, 'numFmtId');
    if (id !== undefined && Number.isInteger(id)) numFmtIds.add(id);
  }
  const checkXf = (table: string, x: XmlElement, i: number, withXfId: boolean): void => {
    const where = `${table}/xf[${i}]`;
    const n = uintAttr(x, 'numFmtId');
    if (n !== undefined && !(n < FIRST_CUSTOM_NUMFMT || numFmtIds.has(n))) add(`numfmt:${table}:${i}`, `${where} numFmtId="${attr(x, '', 'numFmtId')}" is neither built-in nor defined in numFmts`);
    for (const [a, max] of [['fontId', fonts], ['fillId', fills], ['borderId', borders]] as const) {
      const v = uintAttr(x, a);
      if (v !== undefined && !(v < max)) add(`${a}:${table}:${i}`, `${where} ${a}="${attr(x, '', a)}" but there are ${max}`);
    }
    if (withXfId) {
      const v = uintAttr(x, 'xfId');
      if (v !== undefined && !(v < styleXfs)) add(`xfId:${i}`, `${where} xfId="${attr(x, '', 'xfId')}" but there are ${styleXfs} cell style formats`);
    }
  };
  const csx = child(root, ns, 'cellStyleXfs');
  if (csx) childrenOf(csx, ns, 'xf').forEach((x, i) => checkXf('cellStyleXfs', x, i, false));
  const cx = child(root, ns, 'cellXfs');
  if (cx) {
    const xfs = childrenOf(cx, ns, 'xf');
    const c = attr(cx, '', 'count');
    if (c !== undefined && c.trim() !== String(xfs.length)) add('count', `cellXfs count="${c}" but there are ${xfs.length} records`);
    xfs.forEach((x, i) => checkXf('cellXfs', x, i, true));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------

/** Every rule for `pkg` within the scope of `touched` (lower-case part names). */
interface ScopeResult { problems: Problem[]; facts?: WorkbookFacts; formulas: Map<string, string[]>; scans: Map<string, SheetScan> }

function* problemsOf(pkg: OfficePackage, touched: ReadonlySet<string>): Steps<ScopeResult> {
  const facts = workbookFacts(pkg);
  const formulas = new Map<string, string[]>();
  const scans = new Map<string, SheetScan>();
  if (Array.isArray(facts)) return { problems: facts, formulas, scans };
  const problems = facts.problems.slice();
  if (facts.stylesPart) yield { pkg, part: facts.stylesPart };
  const xfCount = cellXfCount(pkg, facts.stylesPart);
  let sstCount: number | undefined;
  for (const s of facts.sheets) {
    if (!s.worksheet || !s.part || !touched.has(lower(s.part))) continue;
    if (sstCount === undefined && facts.sstPart) yield { pkg, part: facts.sstPart };
    sstCount ??= sharedStringCount(pkg, facts.sstPart);
    yield TICK;
    const scan = yield* scanSheet(pkg, s.part, xfCount, sstCount);
    problems.push(...scan.problems);
    formulas.set(lower(s.part), scan.formulas);
    scans.set(lower(s.part), scan);
  }
  if (facts.stylesPart && touched.has(lower(facts.stylesPart))) problems.push(...stylesProblems(pkg, facts.stylesPart));
  return { problems, facts, formulas, scans };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Every §13.3 xlsx rule (styles rules when the styles part is touched). Messages are prefixed with the
 * part they concern. See the header for scope and the comparison with the loaded package.
 */
export const xlsxValidator: Validator = Object.assign(
  // A method, so the function's name stays "xlsxValidator" (failure messages use it) whatever a
  // bundler renames: a named function expression here would shadow the const and be renamed.
  {
    xlsxValidator(pkg: OfficePackage, touched: string[], ctx?: ValidatorContext): string[] {
      return runSync(xlsxChecks(pkg, touched, ctx));
    },
  }.xlsxValidator,
  {
    /** The same checks and messages, yielding to the event loop between and within large parts (§10.2). */
    async: (pkg: OfficePackage, touched: string[], ctx?: ValidatorContext): Promise<string[]> =>
      runAsync(xlsxChecks(pkg, touched, ctx), LIMITS.parseYieldMs),
  },
);

function* xlsxChecks(pkg: OfficePackage, touched: string[], ctx: ValidatorContext | undefined): Steps<string[]> {
  const scope = new Set(touched.map(lower));
  const { problems, facts, formulas, scans } = yield* problemsOf(pkg, scope);
  if (!facts) return problems.map((p) => p.message);
  const original = ctx?.original();
  let loadedScan: ScopeResult | undefined;
  function* loaded(o: OfficePackage): Steps<ScopeResult> {
    loadedScan ??= yield* problemsOf(o, scope);
    return loadedScan;
  }

  // Calc chain absent whenever formulas were touched (§9.5, §13.3).
  if (hasCalcChain(pkg, facts)) {
    let changed = false;
    if (original) {
      const before = (yield* loaded(original)).formulas;
      for (const [part, list] of formulas) if (!sameList(list, before.get(part))) { changed = true; break; }
    } else {
      for (const list of formulas.values()) if (list.length > 0) { changed = true; break; }
    }
    if (changed) problems.push({ key: 'calcchain', message: `${facts.workbookPart}: formulas were edited but the calc chain is still present` });
  }

  let out = problems;
  if (out.length > 0 && original) {
    const before = new Set((yield* loaded(original)).problems.map((p) => p.key));
    out = out.filter((p) => !before.has(p.key));
  }

  // Changed formulas pass the contextual checks (only with the loaded package to tell what changed).
  if (original) {
    const fctx = formulaContextOf(pkg);
    if (fctx) {
      for (const [part, scan] of scans) {
        const orig = (yield* loaded(original)).scans.get(part);
        out.push(...(yield* changedFormulaProblems(part, scan, orig, fctx)));
      }
    }
  }

  // Every cellXfs record that existed at load is still present, at the same index, with identical text.
  if (original && facts.stylesPart && scope.has(lower(facts.stylesPart))) {
    const ofacts = workbookFacts(original);
    const opart = Array.isArray(ofacts) ? null : ofacts.stylesPart;
    const was = opart ? cellXfsRecords(original, opart) : [];
    const now = cellXfsRecords(pkg, facts.stylesPart);
    if (was && now) {
      for (let i = 0; i < was.length; i++) {
        if (now[i] !== was[i]) {
          out.push({ key: `styles|xf-changed:${i}`, message: `${facts.stylesPart}: cellXfs/xf[${i}] ${now[i] === undefined ? 'was removed' : 'changed or moved'} since load` });
        }
      }
    }
  }
  return out.map((p) => p.message);
}
