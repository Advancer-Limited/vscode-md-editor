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
import type { EditBuilder } from './edits.js';
import { attr, childrenOf, escapeAttr, qnameAt } from './xml.js';
import type { XmlElement } from './xml.js';
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
 * '.' and '..' segments are applied; a target that climbs above the package root throws. A '#fragment'
 * is dropped; a target that is empty after that ('#frag') names the source part itself.
 */
export function partNameFromTarget(sourcePart: string, target: string): string {
  let t = target;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  const src = normalizePartName(sourcePart);
  // An empty reference ('' or '#fragment' alone) is a same-document reference: the source part itself.
  if (t === '') {
    if (src === '') throw new Error(`Relationship target "${target}" does not name a part`);
    return src;
  }
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

// ---------------------------------------------------------------------------------------------------
// Writers (WP-18). Each records its changes on an EditBuilder, so they undo with the edit. New
// elements are spliced in after their last sibling of the same kind with no added whitespace; names
// come from the bindings in scope at the parent (qnameAt), and the fragment is rootScoped-checked.

export const CT_RELATIONSHIPS = 'application/vnd.openxmlformats-package.relationships+xml';

function typesRoot(b: EditBuilder): XmlElement {
  if (!b.pkg.has(CONTENT_TYPES_PART)) throw new Error(`${CONTENT_TYPES_PART} is missing`);
  const root = b.pkg.xml(CONTENT_TYPES_PART).root;
  if (root.ns !== NS_CONTENT_TYPES || root.local !== 'Types') throw new Error(`${CONTENT_TYPES_PART}: root element is not Types`);
  return root;
}

/** Child index just after the last element child of `parent` named one of `locals` (in `ns`), or -1. */
function afterLast(parent: XmlElement, ns: string, locals: readonly string[]): number {
  for (let k = parent.children.length - 1; k >= 0; k--) {
    const c = parent.children[k];
    if (c.type === 'el' && c.ns === ns && locals.includes(c.local)) return k + 1;
  }
  return -1;
}

function newElement(parent: XmlElement, ns: string, local: string, attrs: [string, string][]): string {
  const name = qnameAt(parent, ns, local);
  if (name === undefined) throw new Error(`Cannot write <${local}>: namespace ${ns} is not bound on <${parent.rawName}>`);
  return '<' + name + attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('') + '/>';
}

function findOverride(root: XmlElement, part: string): XmlElement | undefined {
  const key = normalizePartName(part).toLowerCase();
  return childrenOf(root, NS_CONTENT_TYPES, 'Override').find((el) => {
    const n = attr(el, '', 'PartName');
    return n !== undefined && normalizePartName(n).toLowerCase() === key;
  });
}

/** Add (or update the ContentType of) the `Override` for `part`. No-op when already as requested. */
export function addOverride(b: EditBuilder, part: string, contentType: string): void {
  const root = typesRoot(b);
  const existing = findOverride(root, part);
  if (existing) {
    b.setAttr(CONTENT_TYPES_PART, existing, '', 'ContentType', contentType);
    return;
  }
  let at = afterLast(root, NS_CONTENT_TYPES, ['Override']);
  if (at < 0) at = afterLast(root, NS_CONTENT_TYPES, ['Default']);
  if (at < 0) at = root.children.length;
  b.insertAt(CONTENT_TYPES_PART, root, at,
    newElement(root, NS_CONTENT_TYPES, 'Override', [['PartName', '/' + normalizePartName(part)], ['ContentType', contentType]]));
}

/** Remove the `Override` for `part`, if there is one. */
export function removeOverride(b: EditBuilder, part: string): void {
  const root = typesRoot(b);
  const existing = findOverride(root, part);
  if (existing) b.removeNode(CONTENT_TYPES_PART, existing);
}

/** Add a `Default` for extension `ext` unless one exists (any content type). */
export function ensureDefault(b: EditBuilder, ext: string, contentType: string): void {
  const root = typesRoot(b);
  const key = ext.toLowerCase();
  if (childrenOf(root, NS_CONTENT_TYPES, 'Default').some((el) => attr(el, '', 'Extension')?.toLowerCase() === key)) return;
  let at = afterLast(root, NS_CONTENT_TYPES, ['Default']);
  if (at < 0) at = 0;
  b.insertAt(CONTENT_TYPES_PART, root, at,
    newElement(root, NS_CONTENT_TYPES, 'Default', [['Extension', ext], ['ContentType', contentType]]));
}

function nextRelId(rels: readonly Relationship[]): string {
  const ids = new Set(rels.map((r) => r.id));
  let n = 0;
  for (const r of rels) {
    const m = /^rId(\d+)$/.exec(r.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let id = `rId${n + 1}`;
  while (ids.has(id)) id = `rId${++n + 1}`;
  return id;
}

/**
 * Add a relationship from `sourcePart` ('' = package root) and return its new Id (`rId<max+1>`).
 * Creates the relationships part when absent (and a `rels` Default content type if none exists).
 * `target` is written as given (relative to the source part's folder, as Office writes it).
 */
export function addRelationship(b: EditBuilder, sourcePart: string, type: string, target: string, opts?: { external?: boolean }): string {
  const relsPart = relsPartFor(sourcePart);
  const attrs: [string, string][] = [['Type', type], ['Target', target]];
  if (opts?.external) attrs.push(['TargetMode', 'External']);
  if (!b.pkg.has(relsPart)) {
    const id = 'rId1';
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + `<Relationships xmlns="${NS_RELATIONSHIPS}"><Relationship Id="${id}"`
      + attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('') + '/></Relationships>';
    if (contentTypeOf(b.pkg, relsPart) === undefined) ensureDefault(b, 'rels', CT_RELATIONSHIPS);
    b.setPart(relsPart, new TextEncoder().encode(xml));
    return id;
  }
  const rels = readRelationships(b.pkg, sourcePart);
  const id = nextRelId(rels);
  const root = b.pkg.xml(relsPart).root;
  let at = afterLast(root, NS_RELATIONSHIPS, ['Relationship']);
  if (at < 0) at = root.children.length;
  b.insertAt(relsPart, root, at, newElement(root, NS_RELATIONSHIPS, 'Relationship', [['Id', id], ...attrs]));
  return id;
}

/** Remove relationship `rId` of `sourcePart`. Throws when there is no such relationship. */
export function removeRelationship(b: EditBuilder, sourcePart: string, rId: string): void {
  const relsPart = relsPartFor(sourcePart);
  if (!b.pkg.has(relsPart)) throw new Error(`${relsPart} does not exist`);
  readRelationships(b.pkg, sourcePart);   // validates the part
  const root = b.pkg.xml(relsPart).root;
  const el = childrenOf(root, NS_RELATIONSHIPS, 'Relationship').find((r) => attr(r, '', 'Id') === rId);
  if (!el) throw new Error(`${relsPart} has no relationship ${rId}`);
  b.removeNode(relsPart, el);
}

/** Source part of a relationships part ('_rels/.rels' -> '', 'xl/_rels/workbook.xml.rels' -> 'xl/workbook.xml'); undefined if not a rels part name. */
export function sourcePartOfRels(relsPart: string): string | undefined {
  const p = normalizePartName(relsPart);
  const m = /^(.*?)(?:^|\/)_rels\/([^/]*)\.rels$/i.exec(p);
  if (!m) return undefined;
  const dir = m[1];
  const file = m[2];
  if (file === '') return dir === '' ? '' : undefined;
  return dir === '' ? file : `${dir}/${file}`;
}
