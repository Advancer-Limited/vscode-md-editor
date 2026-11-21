// Render-only copy of a docx package with marker bookmarks (spec §8.2; plan WP-27).
//
// For every paragraph block that may be mapped in the webview (every `w:p` block of the body and of
// every cell container at any depth, except `merged-cell` paragraphs) the main part of the copy gets
// two empty bookmarks:
//   `__vsmd_s_{blockId}` as the first child after `w:pPr` (or the first child when there is none);
//   `__vsmd_e_{blockId}` as the last child, except when the paragraph's last element child is a
//     `w:r` whose last content element (ignoring `w:rPr` and `w:lastRenderedPageBreak`) is
//     `w:br w:type="page"`: then immediately before that run (Phase 0 S1: docx-preview's page
//     splitter moves anything after a page-break run to the next page).
// docx-preview renders each `w:bookmarkStart` as `<span id="{w:name}">`; `media/docxMap.js` finds
// the spans and maps the rendered `<p>` elements back to block ids.
//
// The copy is produced by string-splicing marker XML into the serialised main part and writing a
// new ZIP in which only the main part's entry is replaced (other entries as the live package has
// them). It never touches the live `XmlDoc` or the `OfficePackage` state: nothing is parsed, touched
// or set, so `pkg.touchedParts()` and `pkg.serialize()` are unchanged (G0). The copy is sent to the
// webview as `docxRender.bytes` and is never saved.
//
// No `vscode` import here (core rule).

import type { OfficePackage } from '../package.js';
import { zipLimits } from '../package.js';
import { LIMITS } from '../limits.js';
import type { XmlElement, XmlNode } from '../xml.js';
import { attr, encodePart, qnameAt, serialize } from '../xml.js';
import type { ZipWriteItem } from '../zip.js';
import { readZip, writeZip, writeZipAsync } from '../zip.js';
import type { Block, DocxModel } from './model.js';
import { NS_W } from './model.js';

/** Prefix of every marker bookmark name; the docx validator refuses a package containing it. */
export const MARKER_PREFIX = '__vsmd_';
/** First marker bookmark `w:id`; ids count up from here, skipping ids the document already uses. */
export const FIRST_MARKER_ID = 2_000_000_000;

export function startMarkerName(blockId: number): string { return `${MARKER_PREFIX}s_${blockId}`; }
export function endMarkerName(blockId: number): string { return `${MARKER_PREFIX}e_${blockId}`; }

/** Blocks that get a marker pair: paragraph blocks, except `merged-cell` ones (§8.1, §8.2). */
export function markerCandidates(model: DocxModel): Block[] {
  return model.blocks().filter((b) => b.kind === 'paragraph' && b.lockReason !== 'merged-cell');
}

export interface RenderCopy {
  bytes: Uint8Array;
  /** Blocks that received a marker pair, in document order. */
  markedBlockIds: number[];
}

/**
 * Build the render-only copy of the package's current state. When the model is view-only (no
 * blocks) the copy is the package's current bytes, unmarked.
 */
export function buildRenderCopy(pkg: OfficePackage, model: DocxModel): RenderCopy {
  const marked = markMainPart(pkg, model);
  if (!marked) return { bytes: pkg.serialize(), markedBlockIds: [] };
  return { bytes: writeZip(...zipPlan(pkg, model.mainPart, marked.text)), markedBlockIds: marked.markedBlockIds };
}

/** As `buildRenderCopy`, deflating with yields to the event loop (§10.2) for large documents. */
export async function buildRenderCopyAsync(pkg: OfficePackage, model: DocxModel): Promise<RenderCopy> {
  const marked = markMainPart(pkg, model);
  if (!marked) return { bytes: await pkg.serializeAsync(), markedBlockIds: [] };
  const [zip, items] = zipPlan(pkg, model.mainPart, marked.text);
  return { bytes: await writeZipAsync(zip, items, LIMITS.parseYieldMs), markedBlockIds: marked.markedBlockIds };
}

/**
 * The main part's current text with the marker bookmarks spliced in, or null when there is nothing
 * to mark (view-only model or no candidate paragraph). Reads the live tree; never modifies it.
 */
export function markMainPart(pkg: OfficePackage, model: DocxModel): { text: string; markedBlockIds: number[] } | null {
  if (model.viewOnlyReason) return null;
  const blocks = markerCandidates(model);
  if (blocks.length === 0) return null;
  const doc = pkg.xml(model.mainPart);
  const docText = serialize(doc);
  const rootText = serialize(doc.root);
  const rootOff = docText.indexOf(rootText);
  if (rootOff < 0) throw new Error('renderCopy: main part root not found in its serialisation');

  // Offsets: walk down from the root, only into ancestors of candidate paragraphs. Each element's
  // children are serialised once; an element's children start right after its start tag.
  const wanted = new Set<XmlElement>(blocks.map((b) => b.el));
  const ancestors = new Set<XmlElement>();
  for (const b of blocks) {
    for (let p = b.el.parent; p && !ancestors.has(p); p = p.parent) ancestors.add(p);
  }
  const found = new Map<XmlElement, { off: number; text: string }>();
  const stack: { el: XmlElement; off: number; text: string }[] = [{ el: doc.root, off: rootOff, text: rootText }];
  while (stack.length > 0) {
    const { el, off, text } = stack.pop()!;
    let pos = off + startTagLength(text);
    for (const c of el.children) {
      const t = serialize(c);
      if (c.type === 'el') {
        if (wanted.has(c)) found.set(c, { off: pos, text: t });
        else if (ancestors.has(c)) stack.push({ el: c, off: pos, text: t });
      }
      pos += t.length;
    }
  }

  const used = usedBookmarkIds(doc.root);
  let nextId = FIRST_MARKER_ID;
  const takeId = (): number => {
    while (used.has(nextId)) nextId++;
    return nextId++;
  };

  const inserts: { at: number; del: number; text: string; order: number }[] = [];
  const markedBlockIds: number[] = [];
  let order = 0;
  for (const b of blocks) {
    const where = found.get(b.el);
    if (!where) throw new Error(`renderCopy: paragraph block ${b.id} not found in the main part`);
    const names = markerNames(b.el);
    const s = bookmarkXml(names, takeId(), startMarkerName(b.id));
    const e = bookmarkXml(names, takeId(), endMarkerName(b.id));
    markedBlockIds.push(b.id);
    const { off, text } = where;
    const p = b.el;
    if (p.children.length === 0) {
      if (text.endsWith('/>')) {
        // `<w:p .../>`: keep the start tag (attributes such as w14:paraId), open it, close it.
        inserts.push({ at: off + text.length - 2, del: 2, text: '>' + s + e + '</' + p.rawName + '>', order: order++ });
      } else {
        inserts.push({ at: off + startTagLength(text), del: 0, text: s + e, order: order++ });
      }
      continue;
    }
    // Child offsets inside the paragraph.
    const childOff: number[] = [];
    let pos = off + startTagLength(text);
    for (const c of p.children) { childOff.push(pos); pos += serialize(c).length; }
    const childrenEnd = pos;

    const firstEl = p.children.findIndex((c) => c.type === 'el');
    const startIdx = firstEl >= 0 && isW(p.children[firstEl], 'pPr') ? firstEl + 1 : 0;
    const startAt = startIdx < p.children.length ? childOff[startIdx] : childrenEnd;

    let endAt = childrenEnd;
    const lastEl = lastElementIndex(p.children);
    if (lastEl >= startIdx && lastEl >= 0 && endsWithPageBreakRun(p.children[lastEl])) endAt = childOff[lastEl];
    inserts.push({ at: startAt, del: 0, text: s, order: order++ });
    inserts.push({ at: Math.max(endAt, startAt), del: 0, text: e, order: order++ });
  }
  inserts.sort((a, b) => a.at - b.at || a.order - b.order);
  const out: string[] = [];
  let at = 0;
  for (const ins of inserts) {
    out.push(docText.slice(at, ins.at), ins.text);
    at = ins.at + ins.del;
  }
  out.push(docText.slice(at));
  return { text: out.join(''), markedBlockIds };
}

// ---------------------------------------------------------------------------------------------------

function isW(n: XmlNode | undefined, local: string): n is XmlElement {
  return n !== undefined && n.type === 'el' && n.local === local && n.ns === NS_W;
}

/** Length of the start tag a serialised element begins with (a `>` inside a quoted value is skipped). */
function startTagLength(text: string): number {
  let quote = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  throw new Error('renderCopy: unterminated start tag');
}

function lastElementIndex(nodes: readonly XmlNode[]): number {
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type === 'el') return i;
  return -1;
}

/** A `w:r` whose last content element (ignoring `w:rPr`, `w:lastRenderedPageBreak`) is `w:br w:type="page"`. */
function endsWithPageBreakRun(n: XmlNode): boolean {
  if (!isW(n, 'r')) return false;
  for (let i = n.children.length - 1; i >= 0; i--) {
    const c = n.children[i];
    if (c.type !== 'el') continue;
    if (isW(c, 'rPr') || isW(c, 'lastRenderedPageBreak')) continue;
    return isW(c, 'br') && attr(c, NS_W, 'type') === 'page';
  }
  return false;
}

interface MarkerNames { start: string; end: string; id: string; name: string; decl: string }

/**
 * Names for the bookmark elements inside `p`: the prefix bound to the WordprocessingML namespace
 * there, or (when it is only the default namespace, whose unprefixed attributes would be in no
 * namespace) a prefix declared on the marker element itself.
 */
function markerNames(p: XmlElement): MarkerNames {
  const q = qnameAt(p, NS_W, 'bookmarkStart');
  const colon = q ? q.indexOf(':') : -1;
  if (q && colon > 0) {
    const pre = q.slice(0, colon + 1);
    return { start: pre + 'bookmarkStart', end: pre + 'bookmarkEnd', id: pre + 'id', name: pre + 'name', decl: '' };
  }
  return {
    start: 'vsmdw:bookmarkStart', end: 'vsmdw:bookmarkEnd', id: 'vsmdw:id', name: 'vsmdw:name',
    decl: ` xmlns:vsmdw="${NS_W}"`,
  };
}

function bookmarkXml(n: MarkerNames, id: number, name: string): string {
  return `<${n.start}${n.decl} ${n.id}="${id}" ${n.name}="${name}"/><${n.end}${n.decl} ${n.id}="${id}"/>`;
}

/** Numeric `w:id` values of every bookmark start/end in the part. */
function usedBookmarkIds(root: XmlElement): Set<number> {
  const used = new Set<number>();
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (isW(el, 'bookmarkStart') || isW(el, 'bookmarkEnd')) {
      const v = attr(el, NS_W, 'id');
      if (v !== undefined && /^\s*-?\d+\s*$/.test(v)) used.add(Number(v));
    }
    for (const c of el.children) if (c.type === 'el') stack.push(c);
  }
  return used;
}

/**
 * ZIP items for the copy: the package's current parts in the order `serialize()` writes them, with
 * the main part replaced by `mainText`. Unchanged entries are copied raw.
 */
function zipPlan(pkg: OfficePackage, mainPart: string, mainText: string): [ReturnType<typeof readZip>, ZipWriteItem[]] {
  const zip = readZip(pkg.originalBytes, zipLimits());
  const changed = new Set(pkg.touchedParts().map((n) => n.toLowerCase()));
  const mainKey = mainPart.replace(/^\/+/, '').toLowerCase();
  const items: ZipWriteItem[] = [];
  const original = new Set<string>();
  const ordered = [...zip.entries].sort((a, b) => a.extent[0] - b.extent[0]);
  let mainSeen = false;
  for (const e of ordered) {
    const key = e.name.toLowerCase();
    original.add(key);
    if (key === mainKey) {
      items.push({ replace: e, data: encodePart(mainText, false) });
      mainSeen = true;
      continue;
    }
    if (!changed.has(key)) { items.push({ keep: e }); continue; }
    if (!pkg.has(e.name)) continue;                       // deleted since open
    items.push({ replace: e, data: pkg.bytes(e.name) });
  }
  if (!mainSeen) throw new Error(`renderCopy: main part ${mainPart} has no ZIP entry`);
  for (const name of pkg.partNames()) {
    if (!original.has(name.toLowerCase())) items.push({ add: name, data: pkg.bytes(name) });
  }
  return [zip, items];
}
