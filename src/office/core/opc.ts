// Open Packaging Conventions (ECMA-376 Part 2): part names, relationships, content types, main part.
//
// Part names here are ZIP entry names without a leading '/', compared case-insensitively (OPC rule)
// with the original case kept. Relationship targets are resolved as plain path strings: no
// percent-decoding (Office writes ASCII part names; a name that only matches after decoding is
// treated as missing, which callers report as damaged rather than guessing), and a '#fragment' is
// dropped. External targets (`TargetMode="External"`) are never resolved or dereferenced (§12).
//
// No `vscode` import here (core rule).

import type { OfficePackage } from './package.js';
import { attr, childrenOf } from './xml.js';
import { OfficeLoadError } from './sniff.js';

export interface Relationship { id: string; type: string; target: string; external: boolean; }

export const NS_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const CONTENT_TYPES_PART = '[Content_Types].xml';

/** Relationship type of the main part (transitional and Strict spellings). */
export const REL_OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
export const REL_OFFICE_DOCUMENT_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument';

/** Normalise a part name: strip one leading '/'. */
export function normalizePartName(part: string): string {
  return part.startsWith('/') ? part.slice(1) : part;
}

/**
 * Resolve a relationship target to a part name. `sourcePart` '' is the package root. An absolute
 * target ('/x/y.xml') is taken from the package root; a relative one from the source part's folder.
 * '.' and '..' segments are applied; a target that climbs above the package root throws.
 */
export function partNameFromTarget(sourcePart: string, target: string): string {
  let t = target;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  const src = normalizePartName(sourcePart);
  const base = t.startsWith('/') ? [] : src.split('/').slice(0, -1);
  const segs = base.slice();
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) throw new Error(`Relationship target "${target}" escapes the package root`);
      segs.pop();
    } else {
      segs.push(seg);
    }
  }
  if (segs.length === 0) throw new Error(`Relationship target "${target}" does not name a part`);
  return segs.join('/');
}

/** 'xl/workbook.xml' -> 'xl/_rels/workbook.xml.rels'; '' (package root) -> '_rels/.rels'. */
export function relsPartFor(part: string): string {
  const p = normalizePartName(part);
  if (p === '') return '_rels/.rels';
  const slash = p.lastIndexOf('/');
  return slash < 0 ? `_rels/${p}.rels` : `${p.slice(0, slash)}/_rels/${p.slice(slash + 1)}.rels`;
}

/**
 * Relationships of `part` ('' = package root), in document order. No relationships part => [].
 * `target` is the raw `Target` attribute (resolve internal ones with `partNameFromTarget`).
 * Throws XmlError for a malformed part and OfficeLoadError('damaged') for a Relationship element
 * missing `Id`, `Type` or `Target`.
 */
export function readRelationships(p: OfficePackage, part: string): Relationship[] {
  const relsPart = relsPartFor(part);
  if (!p.has(relsPart)) return [];
  const root = p.xml(relsPart).root;
  if (root.ns !== NS_RELATIONSHIPS || root.local !== 'Relationships') {
    throw new OfficeLoadError('damaged', `${relsPart}: root element is not a Relationships element`);
  }
  const out: Relationship[] = [];
  for (const el of childrenOf(root, NS_RELATIONSHIPS, 'Relationship')) {
    const id = attr(el, '', 'Id');
    const type = attr(el, '', 'Type');
    const target = attr(el, '', 'Target');
    if (id === undefined || type === undefined || target === undefined) {
      throw new OfficeLoadError('damaged', `${relsPart}: a Relationship lacks Id, Type or Target`);
    }
    out.push({ id, type, target, external: attr(el, '', 'TargetMode') === 'External' });
  }
  return out;
}

/** Content type of `part`: an `Override` with that part name, else a `Default` for its extension (both case-insensitive). */
export function contentTypeOf(p: OfficePackage, part: string): string | undefined {
  if (!p.has(CONTENT_TYPES_PART)) return undefined;
  const root = p.xml(CONTENT_TYPES_PART).root;
  if (root.ns !== NS_CONTENT_TYPES || root.local !== 'Types') return undefined;
  const key = normalizePartName(part).toLowerCase();
  for (const el of childrenOf(root, NS_CONTENT_TYPES, 'Override')) {
    const name = attr(el, '', 'PartName');
    if (name !== undefined && normalizePartName(name).toLowerCase() === key) return attr(el, '', 'ContentType');
  }
  const last = key.slice(key.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = last.slice(dot + 1);
  for (const el of childrenOf(root, NS_CONTENT_TYPES, 'Default')) {
    const e = attr(el, '', 'Extension');
    if (e !== undefined && e.toLowerCase() === ext) return attr(el, '', 'ContentType');
  }
  return undefined;
}

/**
 * The main part, found through the package relationships (`_rels/.rels`, type officeDocument), never
 * by path. `name` uses the case stored in the package. Throws OfficeLoadError('damaged') when the
 * relationship is missing, external, points outside the package or at a missing part, or the part
 * has no content type.
 */
export function mainPart(p: OfficePackage): { name: string; contentType: string } {
  const rels = readRelationships(p, '');
  const rel = rels.find((r) => r.type === REL_OFFICE_DOCUMENT || r.type === REL_OFFICE_DOCUMENT_STRICT);
  if (!rel) throw new OfficeLoadError('damaged', '_rels/.rels has no officeDocument relationship');
  if (rel.external) throw new OfficeLoadError('damaged', 'The officeDocument relationship is external');
  let target: string;
  try {
    target = partNameFromTarget('', rel.target);
  } catch (e) {
    throw new OfficeLoadError('damaged', e instanceof Error ? e.message : String(e));
  }
  const key = target.toLowerCase();
  const name = p.partNames().find((n) => n.toLowerCase() === key);
  if (name === undefined) throw new OfficeLoadError('damaged', `Main part "${target}" is missing`);
  const contentType = contentTypeOf(p, name);
  if (contentType === undefined) throw new OfficeLoadError('damaged', `Main part "${name}" has no content type`);
  return { name, contentType };
}
