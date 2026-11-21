// WP-22: the date style patch — the only change this editor ever makes to `xl/styles.xml` (spec §9.3.1).
//
// Called by ops.ts for a date typed into a cell whose effective number format is General (numFmtId 0;
// the gate is the caller's). Picks the `cellXfs` record for "the cell's base record, with a built-in
// date format":
//
//   target = copy of cellXfs/xf[base] (every attribute and child copied from its source text) with
//            numFmtId = 14 (date) or 22 (date + time) and applyNumberFormat = "1"
//   reuse  : the lowest index whose record equals the target (same attribute name/value set in any
//            order, identical child XML) — a second date costs nothing, and a date record Excel wrote
//            is reused
//   append : otherwise insert the target as the last child of cellXfs, right after the last `xf`,
//            with no added whitespace, and bump cellXfs/@count by one only when it is present. The
//            new index is the previous number of `xf` children; nothing else in the part changes.
//
// Falls back to text (with a notice) when there is no styles part, it is not UTF-8 or not parseable,
// the root is not a SpreadsheetML styleSheet with the main namespace bound on it, cellXfs is missing
// or empty, cellXfs/@count disagrees with the records (an existing inconsistency the editor does not
// guess around), the base index has no record, or the record count would exceed 65,430 (MAX_CELL_XFS).
//
// The style table (StyleTable) is refreshed by the caller once the edit is finished
// (ops.ts afterCellEdit -> styles.reload(); refreshAfterEdit after undo/redo): this module reads the
// live tree only, so records appended earlier in the same edit are seen without a reload, and an
// aborted edit never leaves the table describing a record that was rolled back.
//
// No `vscode` import here (core rule).

import type { EditBuilder } from '../edits.js';
import type { OfficePackage } from '../package.js';
import type { OfficeNotice } from '../types.js';
import { XmlScopeError, attr, child, childrenOf, decodePart, qname, serialize } from '../xml.js';
import type { XmlElement } from '../xml.js';
import { mainPart, partNameFromTarget, readRelationships } from '../opc.js';
import { NS_MAIN } from './sharedStrings.js';
import type { StyleTable } from './styles.js';

/**
 * Spec §9.3.1: no more cell formats than this are ever written. 65,430 is the schema limit Office
 * validates against: the Open XML SDK's generated SpreadsheetML schema gives `cellXfs/xf`
 * maxOccurs = 65430 (`CellFormats`: `new ElementParticle(CellFormat.ElementType, 1, 65430)` in
 * schemas_openxmlformats_org_spreadsheetml_2006_main.g.cs), and the SDK rejects a styles part with
 * more records. (ECMA-376's sml.xsd says "unbounded"; Excel's own documented limit is 64,000 unique
 * formats, but files with more records open, so the stricter of the file-format limits is used.)
 */
export const MAX_CELL_XFS = 65_430;
/** Built-in short date / short date + h:mm (no numFmts entry needed). */
export const DATE_NUMFMT_ID = 14;
export const DATE_TIME_NUMFMT_ID = 22;

export const DATE_AS_TEXT_NOTICE: OfficeNotice = Object.freeze({
  severity: 'warning',
  code: 'date-stored-as-text',
  message: 'Stored as text — this workbook has no cell formats to extend',
}) as OfficeNotice;

const STYLES_REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'];
const XMLNS = 'http://www.w3.org/2000/xmlns/';

type Result = { styleIndex: number } | { fallback: 'text'; notice: OfficeNotice };
const fallback = (): Result => ({ fallback: 'text', notice: { ...DATE_AS_TEXT_NOTICE } });

/** The workbook's styles part (first internal styles relationship of the main part), in package case, or null. */
export function stylesPartOf(pkg: OfficePackage): string | null {
  let main: string;
  try { main = mainPart(pkg).name; } catch { return null; }
  let rels;
  try { rels = readRelationships(pkg, main); } catch { return null; }
  const rel = rels.find((r) => !r.external && STYLES_REL.includes(r.type));
  if (!rel) return null;
  let name: string;
  try { name = partNameFromTarget(main, rel.target); } catch { return null; }
  if (!pkg.has(name)) return null;
  const key = name.toLowerCase();
  return pkg.partNames().find((n) => n.toLowerCase() === key) ?? name;
}

/** End offset (exclusive) of the start tag in an element's serialised text. */
function startTagEnd(text: string): number {
  let q = '';
  for (let j = 1; j < text.length; j++) {
    const ch = text[j];
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') return j + 1;
  }
  throw new Error('stylesWrite: unterminated start tag');
}

/** Attribute key for record equality: namespace + local name (prefix-independent). */
const attrKey = (ns: string, local: string): string => `${ns}|${local}`;

function attrMap(el: XmlElement): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of el.attrs) m.set(attrKey(a.ns, a.local), a.value);
  return m;
}

const childText = (el: XmlElement): string => el.children.map(serialize).join('');

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Source text of the target record: the base record's text with its start tag rebuilt from the
 * original raw attributes (numFmtId / applyNumberFormat replaced in place, or appended).
 */
function targetText(base: XmlElement, numFmtId: number): string {
  const full = serialize(base);
  const end = startTagEnd(full);
  const selfClosing = full[end - 2] === '/';
  const set = new Map([['numFmtId', String(numFmtId)], ['applyNumberFormat', '1']]);
  const parts: string[] = [];
  for (const a of base.attrs) {
    const v = a.ns === '' ? set.get(a.local) : undefined;
    if (v !== undefined) { parts.push(`${a.rawName}="${v}"`); set.delete(a.local); } else parts.push(a.raw);
  }
  for (const [k, v] of set) parts.push(`${k}="${v}"`);
  return `<${base.rawName} ${parts.join(' ')}${selfClosing ? '/>' : '>'}${full.slice(end)}`;
}

/**
 * The style index for a date written into a cell whose effective style is `baseStyleIndex` (a
 * General format), appending one `xf` through `b` when no equal record exists; or the text fallback.
 * `cache` maps `${base}:${numFmtId}` to an index for the duration of one edit (paste: at most one new
 * record per distinct pair).
 */
export function dateStyleFor(b: EditBuilder, _styles: StyleTable, baseStyleIndex: number, withTime: boolean,
  cache: Map<string, number>): Result {
  const numFmtId = withTime ? DATE_TIME_NUMFMT_ID : DATE_NUMFMT_ID;
  const key = `${baseStyleIndex}:${numFmtId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return { styleIndex: hit };

  const pkg = b.pkg;
  const part = stylesPartOf(pkg);
  if (!part) return fallback();
  let doc;
  try {
    if (decodePart(pkg.bytes(part)).encoding !== 'utf-8') return fallback();
    doc = pkg.xml(part);
  } catch {
    return fallback();
  }
  const root = doc.root;
  if (root.local !== 'styleSheet' || root.ns !== NS_MAIN || qname(doc, NS_MAIN, 'xf') === undefined) return fallback();
  const cellXfs = child(root, NS_MAIN, 'cellXfs');
  if (!cellXfs) return fallback();
  const xfs = childrenOf(cellXfs, NS_MAIN, 'xf');
  if (xfs.length === 0) return fallback();
  const countAttr = attr(cellXfs, '', 'count');
  if (countAttr !== undefined && countAttr.trim() !== String(xfs.length)) return fallback();
  if (!Number.isInteger(baseStyleIndex) || baseStyleIndex < 0 || baseStyleIndex >= xfs.length) return fallback();

  const base = xfs[baseStyleIndex];
  // Target as an attribute map + child text (for the equality test).
  const want = attrMap(base);
  want.set(attrKey('', 'numFmtId'), String(numFmtId));
  want.set(attrKey('', 'applyNumberFormat'), '1');
  const wantChildren = childText(base);
  for (let i = 0; i < xfs.length; i++) {
    const x = xfs[i];
    if (childText(x) === wantChildren && sameMap(attrMap(x), want)) {
      cache.set(key, i);
      return { styleIndex: i };
    }
  }

  if (xfs.length + 1 > MAX_CELL_XFS) return fallback();
  // Namespace declarations on the base record itself are copied with it; refuse anything odd there.
  if (base.attrs.some((a) => a.ns === XMLNS || a.rawName === 'xmlns' || a.rawName.startsWith('xmlns:'))) return fallback();
  const text = targetText(base, numFmtId);
  const last = xfs[xfs.length - 1];
  const at = cellXfs.children.indexOf(last) + 1;
  let nodes;
  try {
    nodes = b.insertAt(part, cellXfs, at, text);   // rootScoped: the copied names must mean the same at the root
  } catch (err) {
    if (err instanceof XmlScopeError) return fallback();   // the record's names are not the root's: treat as "not bound"
    throw err;
  }
  const added = nodes[0];
  if (nodes.length !== 1 || added.type !== 'el' || added.ns !== NS_MAIN || added.local !== 'xf'
    || childText(added) !== wantChildren || !sameMap(attrMap(added), want)) {
    throw new Error('stylesWrite: the appended cell format does not read back as the intended record');
  }
  if (countAttr !== undefined) b.setAttr(part, cellXfs, '', 'count', String(xfs.length + 1));
  const index = xfs.length;
  cache.set(key, index);
  return { styleIndex: index };
}
