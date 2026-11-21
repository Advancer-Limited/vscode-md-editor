// Edits, undo and redo over an OfficePackage (spec §6.3, §13.2 G5).
//
// An OfficeEdit is a list of PartChanges applied in order, atomically. Every change is exactly
// invertible from the state it produced:
//
// - `node` changes address ONE node by its node path (child-node indexes from the part's root
//   element, counting every node kind: elements, text, CDATA, comments, PIs). `before` '' = insert,
//   `after` '' = remove, both non-empty = replace. Each side is the exact serialised text of one
//   node. Inserts add no whitespace; adjacent text nodes are never merged while the tree lives
//   (xml.ts). Replays (applyEdit, undo, redo) parse the text in the insertion site's own scope —
//   never `rootScoped`, because the text came from that very site. New content recorded through
//   EditBuilder is `rootScoped` by default (spec §3.3).
// - `attr` changes rewrite one attribute of one element's start tag (G4 for `@count`, `@ref`…).
// - `part` changes replace, create (`before` null) or delete (`after` null) a whole part; both sides
//   are stored raw-deflated (level 1) to bound undo memory.
//
// Text identity is not enough for exactness, because the tree carries structure text does not show.
// Three mechanisms close the gaps (each found by the randomised G5 test):
// 1. A node a change removes is kept (detached) and the opposite direction re-inserts that object, not
//    a re-parse of its text, which would merge adjacent text nodes inside it and lose the parse
//    history xml.setAttr relies on.
// 2. `attr` changes carry the element's start-tag text before/after; when setAttr cannot reproduce
//    the recorded tag (the element was re-created from text, e.g. by a whole-part undo), the element
//    is rewritten from the recorded tag. `node` changes that empty or fill a parent carry its empty
//    text (`<x/>` and `<x></x>` are both possible for the same text history).
// 3. Changes carry the child counts along their path. A whole-part undo re-parses the part, merging
//    adjacent text nodes; a later (older) change whose path crosses a merge is refused rather than
//    applied at a shifted index.
//
// Safety: before any change is applied its precondition is checked against the live tree — the node
// at the path serialises to `before` (replace, remove), the attribute has its `before` value and start
// tag, the part has its `before` bytes, the path has its recorded shape. A mismatch throws
// StaleEditError and, because applyEdit is atomic, leaves the package as it was. Undo/redo closures
// additionally carry the document `generation` they were made in (undoRedoFor): after a load, revert
// or external reload they refuse without touching anything.
//
// No `vscode` import here (core rule).

import type { OfficeError, OfficeNotice } from './types.js';
import type { OfficePackage } from './package.js';
import { rawDeflate, rawInflate } from './zip.js';
import {
  attr as getAttr, encodePart, insertAt as xmlInsertAt, nodeAt, pathOf, removeAt as xmlRemoveAt,
  replaceNode as xmlReplaceNode, serialize, setAttr as xmlSetAttr,
} from './xml.js';
import type { FragmentOptions, XmlDoc, XmlElement, XmlNode } from './xml.js';

export type PartChange =
  | { kind: 'node'; part: string; path: number[]; before: string; after: string;      // '' = absent (insert / remove)
      /**
       * Text of the parent element while it has no children: after this removal, or before this
       * insert (EditBuilder records it when a change empties or fills a parent). Whether an empty
       * element reads `<x/>` or `<x></x>` depends on how its object was parsed, not on its text, so
       * a removal on a re-created parent is rewritten to this exact text.
       */
      emptyParent?: string;
      /**
       * Child counts of every element from the root down to the target's parent, before the change
       * (EditBuilder records them). Re-parsing text merges adjacent text nodes, which shifts node
       * paths without changing any text; a count mismatch on the path refuses the change instead of
       * applying it at the wrong place.
       */
      counts?: number[];
    }
  | { kind: 'attr'; part: string; path: number[]; ns: string; local: string; before: string | null; after: string | null;
      /**
       * Start-tag text of the element before / after the change (EditBuilder records both). When
       * present, apply refuses unless the start tag is `beforeTag`, and guarantees it becomes
       * `afterTag` even when the element was re-created since (see applyAttr).
       */
      beforeTag?: string; afterTag?: string;
      /** Child counts of the element's ancestors, root first (as for `node` changes). */
      counts?: number[];
    }
  | { kind: 'part'; part: string; before: Uint8Array | null; after: Uint8Array | null };  // stored raw-deflated level 1

export interface OfficeEdit { label: string; changes: PartChange[]; notices?: OfficeNotice[]; }

/**
 * A change could not be applied because the document is not in the state the change was made
 * from (stale undo/redo, or a malformed change). Nothing was changed.
 */
export class StaleEditError extends Error {
  /** Index of the offending change in the edit. */
  readonly changeIndex: number;
  readonly part: string;
  constructor(changeIndex: number, part: string, message: string) {
    super(`${part}: ${message}`);
    this.name = 'StaleEditError';
    this.changeIndex = changeIndex;
    this.part = part;
  }
}

// ---------------------------------------------------------------------------------------------------
// Part payloads (raw deflate, level 1)

/** Compress a whole-part payload for a `part` change. */
export function packPart(data: Uint8Array): Uint8Array {
  return rawDeflate(data, 1);
}

/** Inflate a `part` change payload. */
export function unpackPart(packed: Uint8Array): Uint8Array {
  return rawInflate(packed);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Applying one change

function rootOf(node: XmlNode): XmlElement | null {
  let n: XmlNode = node;
  while (n.parent) n = n.parent;
  return n.type === 'el' ? n : null;
}

/** Child counts of the root and of each element along `path` (root first), or undefined if the path is not all elements. */
function countsAlong(doc: XmlDoc, path: readonly number[]): number[] | undefined {
  let n: XmlNode = doc.root;
  const out = [doc.root.children.length];
  for (const i of path) {
    if (n.type !== 'el') return undefined;
    const next: XmlNode | undefined = n.children[i];
    if (!next || next.type !== 'el') return undefined;
    n = next;
    out.push(n.children.length);
  }
  return out;
}

function sameCounts(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Parent element and child index addressed by a non-empty node path, or a reason it does not exist. */
function site(doc: XmlDoc, path: readonly number[]): { parent: XmlElement; index: number } | string {
  if (path.length === 0) return 'the root element cannot be inserted, replaced or removed';
  for (const i of path) if (!Number.isInteger(i) || i < 0) return `invalid node path [${path.join(',')}]`;
  const parent = nodeAt(doc, path.slice(0, -1));
  if (!parent || parent.type !== 'el') return `no element at [${path.slice(0, -1).join(',')}]`;
  return { parent, index: path[path.length - 1] };
}

/** Put `nodes` (just inserted at parent[index..]) back out and, for a replace, the original node in. */
function undoSplice(parent: XmlElement, index: number, nodes: readonly XmlNode[], original?: XmlNode): void {
  parent.children.splice(index, nodes.length, ...(original ? [original] : []));
  for (const n of nodes) n.parent = null;
  if (original) original.parent = parent;
}

// Node identity across undo/redo. Re-parsing a removed node's text is exact as text but not as
// structure: adjacent text nodes inside it come back merged (shifting the node paths that older
// changes address), and its elements lose the parse history xml.setAttr uses to restore attributes.
// So a change that removes a node keeps the detached object, and the opposite direction of the same
// change re-inserts that very object (after checking it still serialises to the expected text).
// Changes are linked to their inverses by `lineage`; the detached nodes live as long as the edit.

interface Lineage { readonly canon: PartChange; readonly inverse: boolean; }
const lineage = new WeakMap<PartChange, Lineage>();
/** canon change -> [node removed by the forward direction, node removed by the inverse direction]. */
const detached = new WeakMap<PartChange, [XmlNode | undefined, XmlNode | undefined]>();

function lineageOf(c: PartChange): Lineage {
  return lineage.get(c) ?? { canon: c, inverse: false };
}

/** Remember `node`, just removed by applying `c`. */
function keepRemoved(c: PartChange, node: XmlNode): void {
  const l = lineageOf(c);
  const slot = detached.get(l.canon) ?? [undefined, undefined];
  slot[l.inverse ? 1 : 0] = node;
  detached.set(l.canon, slot);
}

/** The node the opposite direction of `c` removed, if it is detached and reads `text`. */
function removedByOpposite(c: PartChange, text: string): XmlNode | undefined {
  const l = lineageOf(c);
  const n = detached.get(l.canon)?.[l.inverse ? 0 : 1];
  return n && n.parent === null && serialize(n) === text ? n : undefined;
}

/**
 * `nodes` were just parsed from `text` into parent[index]. When exactly one and `prior` (the object
 * that text was taken from) is given, put `prior` in its place: same text, original structure.
 */
function swapIn(parent: XmlElement, index: number, nodes: readonly XmlNode[], prior: XmlNode | undefined): void {
  if (!prior || nodes.length !== 1) return;
  parent.children[index] = prior;
  prior.parent = parent;
  nodes[0].parent = null;
}

function applyNode(pkg: OfficePackage, c: Extract<PartChange, { kind: 'node' }>, k: number): void {
  const fail = (m: string): never => { throw new StaleEditError(k, c.part, m); };
  if (c.before === '' && c.after === '') fail('node change with neither before nor after text');
  if (!pkg.has(c.part)) fail('part does not exist');
  const doc = pkg.xml(c.part);
  const s = site(doc, c.path);
  if (typeof s === 'string') return fail(s);
  const { parent, index } = s;
  if (c.counts && !sameCounts(countsAlong(doc, c.path.slice(0, -1)), c.counts)) fail(`the structure above [${c.path.join(',')}] no longer matches the edit`);
  if (c.before === '') {
    if (index > parent.children.length) fail(`child index ${index} is out of range`);
  } else {
    const cur = parent.children[index];
    if (!cur) fail(`no node at [${c.path.join(',')}]`);
    if (serialize(cur) !== c.before) fail(`the node at [${c.path.join(',')}] no longer matches the edit`);
  }
  if (c.emptyParent !== undefined) {
    if (c.after === '' ? parent.children.length !== 1 : c.before === '' ? parent.children.length !== 0 : true) {
      fail(`the parent of [${c.path.join(',')}] no longer matches the edit`);
    }
    if (c.before === '' && serialize(parent) !== c.emptyParent) fail(`the parent of [${c.path.join(',')}] no longer matches the edit`);
  }
  pkg.touch(c.part);   // throws (changing nothing) for a part that cannot be written
  if (c.after === '') {
    const removed = parent.children[index];
    xmlRemoveAt(parent, index);
    keepRemoved(c, removed);
    if (c.emptyParent !== undefined && serialize(parent) !== c.emptyParent) rewriteElement(pkg, c.part, doc, parent, c.emptyParent, () => {
      // An element gaining children reads the same whichever way it was parsed: exact.
      swapIn(parent, index, xmlInsertAt(parent, index, c.before), removed);
    }, fail);
    return;
  }
  const prior = removedByOpposite(c, c.after);
  if (c.before === '') {
    const nodes = xmlInsertAt(parent, index, c.after);
    if (nodes.length !== 1 || serialize(nodes[0]) !== c.after) {
      undoSplice(parent, index, nodes);
      fail('inserted text is not exactly one node');
    }
    swapIn(parent, index, nodes, prior);
    return;
  }
  const target = parent.children[index];
  const nodes = xmlReplaceNode(target, c.after);
  if (nodes.length !== 1 || serialize(nodes[0]) !== c.after) {
    undoSplice(parent, index, nodes, target);
    fail('replacement text is not exactly one node');
  }
  swapIn(parent, index, nodes, prior);
  keepRemoved(c, target);
}

/** The start tag of an element's serialised text (up to the first '>' outside quotes). */
function startTagOf(text: string): string {
  let q = '';
  for (let j = 1; j < text.length; j++) {
    const ch = text[j];
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') return text.slice(0, j + 1);
  }
  throw new Error('unterminated start tag');
}

/** Offset of the root start tag `tag` in a serialised part (after the prolog's PIs, comments, whitespace), or -1. */
function rootTagOffset(text: string, tag: string): number {
  let i = 0;
  for (;;) {
    while (i < text.length && ' \t\r\n\uFEFF'.includes(text[i])) i++;
    if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i + 2); if (e < 0) return -1; i = e + 2; continue; }
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); if (e < 0) return -1; i = e + 3; continue; }
    break;
  }
  return text.startsWith(tag, i) ? i : -1;
}

/**
 * xml.setAttr is exact only on the element object it was used on before: it restores an attribute's
 * parsed raw text and position from that object's parse history. An element re-created since (a
 * node or part undo re-parses text) has a different history, so re-adding an attribute there would
 * append it with synthesized whitespace and quoting. With `afterTag` recorded, the result is checked
 * and, when it differs, the element is rewritten from the exact recorded start tag plus its unchanged
 * content (the root element: the whole part, as text). Without tags (hand-made changes) setAttr's
 * result is taken as is.
 */
function applyAttr(pkg: OfficePackage, c: Extract<PartChange, { kind: 'attr' }>, k: number): void {
  const fail = (m: string): never => { throw new StaleEditError(k, c.part, m); };
  if (!pkg.has(c.part)) fail('part does not exist');
  const doc = pkg.xml(c.part);
  const el = nodeAt(doc, c.path);
  if (!el || el.type !== 'el') return fail(`no element at [${c.path.join(',')}]`);
  if (c.counts && c.path.length > 0 && !sameCounts(countsAlong(doc, c.path.slice(0, -1)), c.counts)) {
    fail(`the structure above [${c.path.join(',')}] no longer matches the edit`);
  }
  const cur = getAttr(el, c.ns, c.local) ?? null;
  if (cur !== c.before) fail(`attribute ${c.local} on <${el.rawName}> no longer matches the edit`);
  const tags = c.beforeTag !== undefined && c.afterTag !== undefined ? { before: c.beforeTag, after: c.afterTag } : undefined;
  if (!tags) {
    if (cur === c.after) return;
    pkg.touch(c.part);
    xmlSetAttr(el, c.ns, c.local, c.after);
    return;
  }
  const full = serialize(el);
  const tag0 = startTagOf(full);
  if (tag0 !== tags.before) fail(`the start tag of <${el.rawName}> no longer matches the edit`);
  if (tags.after === tags.before) return;
  pkg.touch(c.part);
  if (cur !== c.after) xmlSetAttr(el, c.ns, c.local, c.after);
  if (startTagOf(serialize(el)) === tags.after) return;
  rewriteElement(pkg, c.part, doc, el, tags.after + full.slice(tag0.length), () => {
    if (el.parent) xmlReplaceNode(el, full);   // the original text parsed before, so it parses again
    else xmlSetAttr(el, c.ns, c.local, cur);   // root (only if its start tag cannot be located: not reachable for a parsed part)
  }, fail);
}

/**
 * Make element `el` of `doc` read exactly `text` (same element, re-created from text). A non-root
 * element is replaced in place; the root element by rewriting the whole part as text. If the text
 * does not re-parse as one node (it came from this site, so it should), `restore` puts the
 * element's text back as it was before the caller's change and the change is refused.
 */
function rewriteElement(pkg: OfficePackage, part: string, doc: XmlDoc, el: XmlElement, text: string,
  restore: () => void, fail: (m: string) => never): void {
  const parent = el.parent;
  if (parent) {
    const index = parent.children.indexOf(el);
    let nodes: XmlNode[];
    try {
      nodes = xmlReplaceNode(el, text);
    } catch {
      restore();
      return fail('the recorded text does not re-parse');
    }
    if (nodes.length !== 1 || serialize(nodes[0]) !== text) {
      undoSplice(parent, index, nodes, el);
      restore();
      fail('the recorded text does not re-parse as one element');
    }
    return;
  }
  const docText = serialize(doc);
  const cur = serialize(el);
  const at = rootTagOffset(docText, cur);
  if (at < 0) { restore(); fail('cannot locate the root element'); }
  const bytes = pkg.bytes(part);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  pkg.setPart(part, encodePart(docText.slice(0, at) + text + docText.slice(at + cur.length), bom));
}

function applyPart(pkg: OfficePackage, c: Extract<PartChange, { kind: 'part' }>, k: number): void {
  const fail = (m: string): never => { throw new StaleEditError(k, c.part, m); };
  const exists = pkg.has(c.part);
  if (c.before === null) {
    if (exists) fail('part already exists');
  } else {
    if (!exists) fail('part does not exist');
    if (!bytesEqual(pkg.bytes(c.part), unpackPart(c.before))) fail('part content no longer matches the edit');
  }
  pkg.setPart(c.part, c.after === null ? null : unpackPart(c.after));
}

function applyChange(pkg: OfficePackage, c: PartChange, k: number): void {
  switch (c.kind) {
    case 'node': applyNode(pkg, c, k); return;
    case 'attr': applyAttr(pkg, c, k); return;
    case 'part': applyPart(pkg, c, k); return;
    default: throw new StaleEditError(k, (c as { part?: string }).part ?? '', 'unknown change kind');
  }
}

export function invertChange(c: PartChange): PartChange {
  switch (c.kind) {
    case 'node': {
      const inv: PartChange = { kind: 'node', part: c.part, path: c.path.slice(), before: c.after, after: c.before };
      if (c.emptyParent !== undefined) inv.emptyParent = c.emptyParent;   // same text: empty before the insert = empty after its undo
      if (c.counts) {
        inv.counts = c.counts.slice();
        inv.counts[inv.counts.length - 1] += c.before === '' ? 1 : c.after === '' ? -1 : 0;   // the parent after this change
      }
      const l = lineageOf(c);
      lineage.set(inv, { canon: l.canon, inverse: !l.inverse });
      return inv;
    }
    case 'attr': {
      const inv: PartChange = { kind: 'attr', part: c.part, path: c.path.slice(), ns: c.ns, local: c.local, before: c.after, after: c.before };
      if (c.beforeTag !== undefined && c.afterTag !== undefined) { inv.beforeTag = c.afterTag; inv.afterTag = c.beforeTag; }
      if (c.counts) inv.counts = c.counts.slice();
      return inv;
    }
    case 'part': return { kind: 'part', part: c.part, before: c.after, after: c.before };
  }
}

/** Apply inverses of `applied` (in reverse) after a failure. A failure here is a bug: report loudly. */
function rollback(pkg: OfficePackage, applied: readonly PartChange[], cause: unknown): void {
  for (let k = applied.length - 1; k >= 0; k--) {
    try {
      applyChange(pkg, invertChange(applied[k]), k);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const orig = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Edit rollback failed (${why}) after: ${orig}. The in-memory document is inconsistent; revert it.`);
    }
  }
}

/**
 * Apply every change of `edit` in order. Atomic: if any change fails (StaleEditError for a
 * precondition, or any other error), the changes already applied are rolled back and the error is
 * rethrown, leaving every part's text as it was.
 */
export function applyEdit(pkg: OfficePackage, edit: OfficeEdit): void {
  const applied: PartChange[] = [];
  for (let k = 0; k < edit.changes.length; k++) {
    try {
      applyChange(pkg, edit.changes[k], k);
    } catch (e) {
      rollback(pkg, applied, e);
      throw e;
    }
    applied.push(edit.changes[k]);
  }
}

/** The edit that undoes `edit`: changes reversed, before/after swapped. Notices are not carried over. */
export function invertEdit(edit: OfficeEdit): OfficeEdit {
  const changes: PartChange[] = [];
  for (let k = edit.changes.length - 1; k >= 0; k--) changes.push(invertChange(edit.changes[k]));
  return { label: edit.label, changes };
}

// ---------------------------------------------------------------------------------------------------
// Result-style wrappers and the generation guard (spec §6.3)

export type EditOutcome = { ok: true } | { ok: false; error: OfficeError };

/** applyEdit, reporting a refused or failed edit as an OfficeError instead of throwing. */
export function tryApplyEdit(pkg: OfficePackage, edit: OfficeEdit, refusedMessage = "Can't apply the edit: the document has changed."): EditOutcome {
  try {
    applyEdit(pkg, edit);
    return { ok: true };
  } catch (e) {
    if (e instanceof StaleEditError) return { ok: false, error: { code: 'stale', message: refusedMessage } };
    return { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } };
  }
}

/** What undo/redo closures read at run time: the current package and its load generation. */
export interface EditTarget {
  readonly pkg: OfficePackage;
  /** Incremented by every load, revert and external reload (the package is replaced then). */
  readonly generation: number;
}

export const UNDO_RELOADED_MESSAGE = "Can't undo: the file was reloaded from disk";
export const REDO_RELOADED_MESSAGE = "Can't redo: the file was reloaded from disk";
export const UNDO_STALE_MESSAGE = "Can't undo: the document no longer matches this edit";
export const REDO_STALE_MESSAGE = "Can't redo: the document no longer matches this edit";

/**
 * Undo/redo closures for an edit just applied to `target.pkg`. Each captures `target.generation`
 * now; when it no longer matches, the closure changes nothing and reports `stale`. Otherwise it
 * applies the inverse (undo) or the edit again (redo) atomically, refusing on a before-text mismatch.
 */
export function undoRedoFor(target: EditTarget, edit: OfficeEdit): { undo(): EditOutcome; redo(): EditOutcome } {
  const generation = target.generation;
  const inverse = invertEdit(edit);
  const run = (e: OfficeEdit, reloaded: string, stale: string): EditOutcome => {
    if (target.generation !== generation) return { ok: false, error: { code: 'stale', message: reloaded } };
    return tryApplyEdit(target.pkg, e, stale);
  };
  return {
    undo: () => run(inverse, UNDO_RELOADED_MESSAGE, UNDO_STALE_MESSAGE),
    redo: () => run(edit, REDO_RELOADED_MESSAGE, REDO_STALE_MESSAGE),
  };
}

// ---------------------------------------------------------------------------------------------------
// EditBuilder

/**
 * Records an edit while applying it, so later steps see earlier ones. Each primitive either fully
 * succeeds (and is recorded) or throws having changed nothing. `finish()` returns the edit (null
 * when nothing changed); `abort()` rolls back everything recorded.
 *
 * Node arguments must belong to the current tree of `part` (`pkg.xml(part)`).
 */
export class EditBuilder {
  readonly pkg: OfficePackage;
  readonly label: string;
  private readonly changes: PartChange[] = [];
  private readonly notices: OfficeNotice[] = [];
  private closed = false;

  constructor(pkg: OfficePackage, label: string) {
    this.pkg = pkg;
    this.label = label;
  }

  /** Number of changes recorded so far. */
  get size(): number { return this.changes.length; }

  /** The parts the changes recorded so far touch (as recorded, in first-touch order). */
  changedParts(): string[] {
    return [...new Set(this.changes.map((c) => c.part))];
  }

  private open(): void {
    if (this.closed) throw new Error('EditBuilder: already finished or aborted');
  }

  private member(part: string, node: XmlNode): XmlDoc {
    const doc = this.pkg.xml(part);
    if (rootOf(node) !== doc.root) throw new Error(`EditBuilder: node does not belong to the current tree of ${part}`);
    return doc;
  }

  /** Record a change that removed or replaced `removed` (kept for an exact undo). */
  private record(c: PartChange, removed: XmlNode): void {
    keepRemoved(c, removed);
    this.changes.push(c);
  }

  /** Record one-node inserts for `nodes`, now at parent[index..]. Each must re-parse as one node. */
  private recordInserts(part: string, basePath: readonly number[], index: number, nodes: readonly XmlNode[], counts: readonly number[]): void {
    for (let k = 0; k < nodes.length; k++) {
      const text = serialize(nodes[k]);
      if (text === '') throw new Error('EditBuilder: empty node');
      const cs = counts.slice();
      cs[cs.length - 1] += k;
      this.changes.push({ kind: 'node', part, path: [...basePath, index + k], before: '', after: text, counts: cs });
    }
  }

  /** Child counts along the path to `parent` (root first), now. */
  private countsTo(doc: XmlDoc, parent: XmlElement): number[] {
    return countsAlong(doc, pathOf(parent))!;
  }

  /**
   * Replace `node` with the nodes parsed from `xml` (several, or none = removal). New content is
   * `rootScoped` unless `opts.rootScoped` is false (pass false only for text taken from this site).
   * Replacing a node with identical text records nothing.
   */
  replaceNode(part: string, node: XmlNode, xml: string, opts?: FragmentOptions): XmlNode[] {
    this.open();
    const doc = this.member(part, node);
    if (!node.parent) throw new Error('EditBuilder.replaceNode: the root element cannot be replaced');
    const before = serialize(node);
    const path = pathOf(node);
    const parent = node.parent;
    const index = path[path.length - 1];
    const counts = this.countsTo(doc, parent);
    this.pkg.touch(part);
    const nodes = xmlReplaceNode(node, xml, { rootScoped: opts?.rootScoped ?? true });
    if (nodes.length === 1) {
      const after = serialize(nodes[0]);
      if (after !== before) this.record({ kind: 'node', part, path, before, after, counts }, node);
      return nodes;
    }
    if (nodes.length > 1 && nodes.some((n) => serialize(n) === '')) {
      undoSplice(parent, index, nodes, node);
      throw new Error('EditBuilder: empty node');
    }
    if (nodes.length === 0) {
      this.record(withEmpty({ kind: 'node', part, path, before, after: '', counts }, parent), node);
      return nodes;
    }
    // Several nodes: recorded as a removal and one insert per node. The parent is never empty in
    // between in either direction's final state, so no emptyParent is needed.
    this.record({ kind: 'node', part, path, before, after: '', counts }, node);
    const after = counts.slice();
    after[after.length - 1] -= 1;
    this.recordInserts(part, path.slice(0, -1), index, nodes, after);
    return nodes;
  }

  /** Insert the nodes parsed from `xml` before child `index` of `parent` (no whitespace added). */
  insertAt(part: string, parent: XmlElement, index: number, xml: string, opts?: FragmentOptions): XmlNode[] {
    this.open();
    const doc = this.member(part, parent);
    const base = pathOf(parent);
    const counts = this.countsTo(doc, parent);
    const empty = parent.children.length === 0 ? serialize(parent) : undefined;
    this.pkg.touch(part);
    const nodes = xmlInsertAt(parent, index, xml, { rootScoped: opts?.rootScoped ?? true });
    if (nodes.some((n) => serialize(n) === '')) {
      undoSplice(parent, index, nodes);
      throw new Error('EditBuilder: empty node');
    }
    const first = this.changes.length;
    this.recordInserts(part, base, index, nodes, counts);
    if (empty !== undefined && nodes.length > 0) (this.changes[first] as Extract<PartChange, { kind: 'node' }>).emptyParent = empty;
    return nodes;
  }

  removeNode(part: string, node: XmlNode): void {
    this.open();
    const doc = this.member(part, node);
    if (!node.parent) throw new Error('EditBuilder.removeNode: the root element cannot be removed');
    const path = pathOf(node);
    const before = serialize(node);
    const parent = node.parent;
    const counts = this.countsTo(doc, parent);
    this.pkg.touch(part);
    xmlRemoveAt(parent, path[path.length - 1]);
    this.record(withEmpty({ kind: 'node', part, path, before, after: '', counts }, parent), node);
  }

  /** Set (string) or remove (null) one attribute; only the start tag changes. No-op when unchanged. */
  setAttr(part: string, el: XmlElement, ns: string, local: string, value: string | null): void {
    this.open();
    const doc = this.member(part, el);
    const before = getAttr(el, ns, local) ?? null;
    if (before === value) return;
    const path = pathOf(el);
    const counts = path.length > 0 ? countsAlong(doc, path.slice(0, -1))! : [];
    const beforeTag = startTagOf(serialize(el));
    this.pkg.touch(part);
    xmlSetAttr(el, ns, local, value);
    const afterTag = startTagOf(serialize(el));
    this.changes.push({ kind: 'attr', part, path, ns, local, before, after: value, beforeTag, afterTag, counts });
  }

  /** Create, replace (data) or delete (null) a whole part. No-op when the bytes are unchanged. */
  setPart(part: string, data: Uint8Array | null): void {
    this.open();
    const exists = this.pkg.has(part);
    const cur = exists ? this.pkg.bytes(part) : null;
    if (cur === null && data === null) return;
    if (cur !== null && data !== null && bytesEqual(cur, data)) return;
    const name = exists ? this.pkg.partNames().find((n) => n.toLowerCase() === normalize(part).toLowerCase()) ?? normalize(part) : normalize(part);
    const change: PartChange = { kind: 'part', part: name, before: cur && packPart(cur), after: data && packPart(data) };
    this.pkg.setPart(name, data);
    this.changes.push(change);
  }

  notice(n: OfficeNotice): void {
    this.open();
    this.notices.push(n);
  }

  /** The recorded edit, or null when nothing changed. The builder is closed afterwards. */
  finish(): OfficeEdit | null {
    this.open();
    this.closed = true;
    if (this.changes.length === 0) return null;
    const edit: OfficeEdit = { label: this.label, changes: this.changes.slice() };
    if (this.notices.length > 0) edit.notices = this.notices.slice();
    return edit;
  }

  /** Roll back everything recorded and close the builder. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    const changes = this.changes.slice();
    this.changes.length = 0;
    rollback(this.pkg, changes, new Error('aborted'));
  }
}

/** Add `emptyParent` to a removal that left `parent` without children. */
function withEmpty(c: Extract<PartChange, { kind: 'node' }>, parent: XmlElement): PartChange {
  if (parent.children.length === 0) c.emptyParent = serialize(parent);
  return c;
}

function normalize(part: string): string {
  return part.startsWith('/') ? part.slice(1) : part;
}
