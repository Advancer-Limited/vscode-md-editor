// Paragraph writer (spec §8.4 rules 1–8; plan WP-28): turns the commit items the island sends for
// one paragraph back into the `w:p` element's XML.
//
// What is written, in short:
//   - The paragraph's start tag and `w:pPr` are source slices (rule 2, rule 8); only `w14:textId` is
//     removed, and only when the content changed.
//   - A run whose content the commit leaves as it was is emitted as its source slice, attributes and
//     all (rule 3). Atoms and anchors are always source slices (rule 5).
//   - Anything else is a new `w:r` with a copy of the source run's `w:rPr` slice, changed only for
//     the b/i/u toggles the user flipped (rules 4, 7). New runs carry no `w:rsid*`.
//   - Atoms and anchors missing from the commit are put back (rule 6): nothing is ever dropped.
//   - `w:proofErr`, whitespace between elements, empty runs and (outside source-slice runs)
//     `w:lastRenderedPageBreak` are not re-emitted (§8.3 "disposable").
//
// Text encoding in new runs: `\t` -> `w:tab`, `\n` -> `w:br`; every `w:t` carries
// `xml:space="preserve"` (rule 4), so no space is ever lost; CR/CRLF are read as `\n` (a raw CR in
// `w:t` would lock the paragraph on the next load); characters XML 1.0 forbids are removed.
// U+2011 / U+00AD: a character the edit did not touch (inside the common prefix or suffix of the
// source segment's text and the committed text) keeps its source form, `w:noBreakHyphen` /
// `w:softHyphen` element or literal character; a new one is written as the element when the source
// segment used the element form for that character anywhere, else as the literal character.
//
// Run merging: adjacent NEW runs with byte-identical `w:rPr` XML become one run (adjacent text in
// one `w:t`). A source-slice run is never merged with anything.
//
// Ids: the island is not rebuilt after an idle commit, so later commits still name the segment ids
// it was built from. `adopt()` (called by `commitParagraph`) keeps them meaningful: the new `w:p`
// takes the block id, every atom and anchor keeps its id, and each text segment id goes to one
// node written for it (the item that keeps the segment's formatting, if any). A text segment id
// that ends up with no node of its own (its text was deleted, or it was merged into a neighbour)
// stays known as an alias for the run properties it had, so a later `src` naming it still resolves.
//
// Refuse rather than guess: unknown ids, malformed items, a locked or stale block and markup that
// cannot be written with the root's namespace bindings are errors; nothing is changed.
//
// No `vscode` import here (core rule).

import type { DocxCommitItem } from '../../protocol.js';
import type { OfficeError, OfficeNotice } from '../types.js';
import type { EditBuilder } from '../edits.js';
import type { XmlDoc, XmlElement, XmlNode } from '../xml.js';
import { attr, child, escapeText, parseFragment, serialize, stripIllegalXmlChars, textContent } from '../xml.js';
import type { Block, DocxModel, LockReason, Segment } from './model.js';
import { NS_W, isEditable, paragraphProps } from './model.js';
import type { DocxStyles } from './styles.js';

export const NS_W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';

/** Children of `w:rPr` in schema order (CT_RPr; §8.4 rule 7). Elements not listed here sort after these. */
export const RPR_ORDER: readonly string[] = Object.freeze([
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs',
  'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange',
]);

/** Children of `w:pPr` in schema order (CT_PPr; §8.6). */
export const PPR_ORDER: readonly string[] = Object.freeze([
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
  'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap',
  'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid',
  'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
]);

/** Notice attached to an edit that had to put atoms back (§8.4 rule 6). */
export const ATOMS_KEPT_NOTICE: OfficeNotice = Object.freeze({
  severity: 'warning', code: 'docx-atoms-kept', message: "Images, fields and links can't be deleted in this editor.",
}) as OfficeNotice;

export interface BuildOptions {
  /** Use this `w:pPr` XML instead of the paragraph's own ('' = none). For split/merge/style writers. */
  pPrXml?: string;
  /**
   * false: the result is a NEW paragraph (the second half of a split): its start tag loses
   * `w14:paraId`, `w14:textId` and every `w:rsid*` attribute, and `adopt()` gives it no block id.
   * Default true.
   */
  keepIds?: boolean;
  /**
   * Atom and anchor ids that are deliberately absent from `items` because the same operation
   * writes them into another paragraph (the other half of a split). They are not re-inserted.
   */
  omit?: ReadonlySet<number>;
}

export interface BuiltParagraph {
  /** The whole `w:p` element. */
  xml: string;
  /** `xml` differs from the paragraph's current text. */
  changed: boolean;
  /**
   * At least one atom was missing from the items and was put back (the caller raises
   * `ATOMS_KEPT_NOTICE`). Can be true with `changed` false: the commit only dropped an atom, so the
   * paragraph stays exactly as it is while the island no longer shows the chip.
   */
  reinsertedAtoms: boolean;
  /** The children after `w:pPr` (what `xml` holds between the properties and the end tag). */
  contentXml: string;
  /**
   * Call with the element parsed from `xml` once it is in the tree, before `model.refresh()`:
   * carries the block id (unless `keepIds` is false) and the segment ids to the new nodes and
   * records aliases for text segment ids. Harmless to skip (ids then simply become new ones).
   */
  adopt(newP: XmlElement): void;
}

/**
 * Result of `commitParagraph`. The caller finishes the builder and then calls `model.refresh()`.
 * `reinsertedAtoms` with `changed: false`: nothing was recorded (so no notice travels with an edit),
 * but the island is out of step with the document and should be rebuilt.
 */
export type CommitOutcome =
  | { ok: true; changed: boolean; changedBlockIds: number[]; reinsertedAtoms: boolean }
  | { ok: false; error: OfficeError };

type Toggle = 'b' | 'i' | 'u';
type Toggles = { b: boolean; i: boolean; u: boolean };
type TextSeg = Extract<Segment, { kind: 'text' }>;
type AtomSeg = Extract<Segment, { kind: 'atom' }>;
type AnchorSeg = Extract<Segment, { kind: 'anchor' }>;

const NB_HYPHEN = '\u2011';
const SOFT_HYPHEN = '\u00AD';
const TOGGLES: readonly Toggle[] = ['b', 'i', 'u'];

const err = (code: OfficeError['code'], message: string): OfficeError => ({ code, message });
const isError = (x: BuiltParagraph | OfficeError): x is OfficeError => 'code' in x;

class WriterRefusal extends Error {}

/** Why a block can't be edited, per lock reason (also used by ops.ts). */
export const LOCK_MESSAGES: Readonly<Record<LockReason, string>> = {
  'tracked-changes': "This paragraph contains tracked changes and can't be edited here.",
  'multi-paragraph-field': "This paragraph is part of a field that spans several paragraphs and can't be edited here.",
  'unknown-content': "This paragraph contains content this editor doesn't understand, so it is kept as is.",
  'merged-cell': "This cell is part of a merged cell and can't be edited here.",
  opaque: "This content can't be edited here. It is preserved as is.",
};

// ---------------------------------------------------------------------------------------------------
// Small XML text helpers

const isWsChar = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isWsOnly = (n: XmlNode): boolean => n.type === 'text' && /^[ \t\r\n]*$/.test(n.raw);

/** Prefix the root binds to the WordprocessingML namespace (the root's own prefix first), or ''. */
function wPrefixOf(doc: XmlDoc): string {
  const root = doc.root;
  const own = root.rawName.includes(':') ? root.rawName.slice(0, root.rawName.indexOf(':')) : '';
  let found = '';
  for (const a of root.attrs) {
    if (!a.rawName.startsWith('xmlns:') || a.value !== NS_W) continue;
    const p = a.rawName.slice(6);
    if (p === own) return p;
    if (found === '') found = p;
  }
  return found;
}

/** The start tag of a serialised element as an open tag (`<x a="1">`), whether or not the source self-closes. */
function openTagOf(text: string): string {
  let q = '';
  for (let j = 1; j < text.length; j++) {
    const ch = text[j];
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch !== '>') continue;
    if (text[j - 1] !== '/') return text.slice(0, j + 1);
    let e = j - 1;
    while (e > 0 && isWsChar(text[e - 1])) e--;
    return text.slice(0, e) + '>';
  }
  throw new WriterRefusal('unterminated start tag');
}

/** `openTag` without the attributes `drop` names (each goes with the whitespace before it). */
function stripAttrs(openTag: string, drop: (rawName: string) => boolean): string {
  const n = openTag.length;
  let i = 1;
  while (i < n && !isWsChar(openTag[i]) && openTag[i] !== '>') i++;
  let out = openTag.slice(0, i);
  while (i < n) {
    const from = i;
    while (i < n && isWsChar(openTag[i])) i++;
    if (i >= n || openTag[i] === '>') { out += openTag.slice(from); break; }
    const nameStart = i;
    while (i < n && openTag[i] !== '=' && !isWsChar(openTag[i])) i++;
    const name = openTag.slice(nameStart, i);
    while (i < n && openTag[i] !== '=') i++;
    i++;
    while (i < n && isWsChar(openTag[i])) i++;
    const close = openTag.indexOf(openTag[i], i + 1);
    if (close < 0) throw new WriterRefusal('malformed start tag');
    i = close + 1;
    if (!drop(name)) out += openTag.slice(from, i);
  }
  return out;
}

/** Parse `xml` (one element, names resolvable with the root's bindings) or refuse. */
function oneElement(doc: XmlDoc, xml: string, what: string): XmlElement {
  let nodes: XmlNode[];
  try {
    nodes = parseFragment(doc, xml);
  } catch (e) {
    throw new WriterRefusal(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const els = nodes.filter((n) => !isWsOnly(n));
  if (els.length !== 1 || els[0].type !== 'el') throw new WriterRefusal(`${what}: expected exactly one element`);
  return els[0];
}

/** Element children of a property element; refuses character data, comments and PIs (never dropped silently). */
function propertyChildren(el: XmlElement, what: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.type === 'el') out.push(c);
    else if (!isWsOnly(c)) throw new WriterRefusal(`${what} holds something other than elements`);
  }
  return out;
}

function orderIndex(order: readonly string[], el: XmlElement): number {
  if (el.ns !== NS_W) return order.length;            // extension elements (w14:…) follow the schema's own
  const k = order.indexOf(el.local);
  return k < 0 ? order.length : k;
}

// ---------------------------------------------------------------------------------------------------
// Toggles and paragraph properties (exported for WP-29/30)

/**
 * `w:rPr` XML with one toggle set (§8.4 rule 7). `rPrXml` null = the run has no properties.
 * `inheritedOn` is the toggle's value from styles alone (`DocxStyles.inheritedToggles`). Children
 * are emitted in schema order whatever the source order; every other child is its source text.
 * Returns '' when no property is left (the run then has no `w:rPr`). Throws when `rPrXml` is not one
 * `w:rPr` element expressible with the root's namespace bindings.
 */
export function setToggle(rPrXml: string | null, which: 'b' | 'i' | 'u', on: boolean, inheritedOn: boolean, doc: XmlDoc): string {
  const w = wPrefixOf(doc);
  if (w === '') throw new Error('setToggle: the WordprocessingML namespace has no prefix at the root');
  let open = `<${w}:rPr>`;
  let close = `</${w}:rPr>`;
  let kids: { order: number; xml: string; el: XmlElement | null; local: string }[] = [];
  if (rPrXml !== null && rPrXml !== '') {
    let el: XmlElement;
    try { el = oneElement(doc, rPrXml, 'w:rPr'); } catch (e) { throw new Error(`setToggle: ${(e as Error).message}`); }
    if (el.ns !== NS_W || el.local !== 'rPr') throw new Error('setToggle: not a w:rPr element');
    open = openTagOf(serialize(el));
    close = `</${el.rawName}>`;
    let children: XmlElement[];
    try { children = propertyChildren(el, 'w:rPr'); } catch (e) { throw new Error(`setToggle: ${(e as Error).message}`); }
    kids = children.map((c) => ({ order: orderIndex(RPR_ORDER, c), xml: serialize(c), el: c, local: c.ns === NS_W ? c.local : '' }));
  }
  const add = (local: string, val: string | null): void => {
    kids.push({ order: RPR_ORDER.indexOf(local), xml: val === null ? `<${w}:${local}/>` : `<${w}:${local} ${w}:val="${val}"/>`, el: null, local });
  };
  if (which === 'u') {
    const existing = kids.find((k) => k.local === 'u');
    const val = existing?.el ? attr(existing.el, NS_W, 'val') : undefined;
    const existingOn = existing !== undefined && (val === undefined || val.trim().toLowerCase() !== 'none');
    if (on) {
      if (!existingOn) { kids = kids.filter((k) => k.local !== 'u'); add('u', 'single'); }   // else: keep its line style
    } else {
      kids = kids.filter((k) => k.local !== 'u');
      if (inheritedOn) add('u', 'none');
    }
  } else {
    const cs = which + 'Cs';
    kids = kids.filter((k) => k.local !== which && k.local !== cs);
    if (on) { add(which, null); add(cs, null); } else if (inheritedOn) { add(which, '0'); add(cs, '0'); }
  }
  if (kids.length === 0) return '';
  // Stable: children with the same rank (repeats, extension elements) keep their source order.
  const sorted = kids.map((k, n) => ({ k, n })).sort((a, b) => a.k.order - b.k.order || a.n - b.n);
  return open + sorted.map((s) => s.k.xml).join('') + close;
}

/**
 * `w:pPr` XML with the WordprocessingML child `childLocal` replaced by `xml`, inserted at its schema
 * position when absent, or removed (`xml` null). Existing children keep their text and their order;
 * a replaced child keeps its position. `pPrXml` null = the paragraph has no properties. Returns ''
 * when no child is left (the paragraph then has no `w:pPr`). Throws on malformed input.
 */
export function upsertPPrChild(pPrXml: string | null, childLocal: string, xml: string | null, doc: XmlDoc): string {
  const w = wPrefixOf(doc);
  if (w === '') throw new Error('upsertPPrChild: the WordprocessingML namespace has no prefix at the root');
  const rank = PPR_ORDER.indexOf(childLocal);
  if (rank < 0) throw new Error(`upsertPPrChild: "${childLocal}" is not a w:pPr child`);
  let open = `<${w}:pPr>`;
  let close = `</${w}:pPr>`;
  let kids: { order: number; xml: string; mine: boolean }[] = [];
  if (pPrXml !== null && pPrXml !== '') {
    try {
      const el = oneElement(doc, pPrXml, 'w:pPr');
      if (el.ns !== NS_W || el.local !== 'pPr') throw new WriterRefusal('not a w:pPr element');
      open = openTagOf(serialize(el));
      close = `</${el.rawName}>`;
      kids = propertyChildren(el, 'w:pPr').map((c) => ({
        order: orderIndex(PPR_ORDER, c), xml: serialize(c), mine: c.ns === NS_W && c.local === childLocal,
      }));
    } catch (e) {
      throw new Error(`upsertPPrChild: ${(e as Error).message}`);
    }
  }
  if (xml !== null) {
    try {
      const el = oneElement(doc, xml, childLocal);
      if (el.ns !== NS_W || el.local !== childLocal) throw new WriterRefusal(`the new child is not a w:${childLocal} element`);
    } catch (e) {
      throw new Error(`upsertPPrChild: ${(e as Error).message}`);
    }
  }
  const at = kids.findIndex((k) => k.mine);
  const rest = kids.filter((k, n) => !k.mine || n === at);
  if (at >= 0) {
    const pos = rest.findIndex((k) => k.mine);
    if (xml === null) rest.splice(pos, 1); else rest[pos] = { order: rank, xml, mine: true };
  } else if (xml !== null) {
    let pos = rest.findIndex((k) => k.order > rank);
    if (pos < 0) pos = rest.length;
    rest.splice(pos, 0, { order: rank, xml, mine: true });
  }
  if (rest.length === 0) return '';
  return open + rest.map((k) => k.xml).join('') + close;
}

// ---------------------------------------------------------------------------------------------------
// Sources of run properties: live text segments and aliases of retired ones

interface Alias { rPrXml: string; text: string; enc: string; }

/** Text segment id -> the run properties it stood for when it was last a live segment. */
const aliases = new WeakMap<DocxModel, Map<number, Alias>>();

interface Src {
  id: number;
  /** The live segment, or null for an alias. */
  seg: TextSeg | null;
  rPrXml: string;                 // '' = no w:rPr
  rPr: XmlElement | null;
  text: string;
  /** One char per UTF-16 unit of `text`: 'E' = written as an element (noBreakHyphen/softHyphen), 'L' otherwise. */
  enc: string;
}

function encodingOf(seg: TextSeg): string {
  let enc = '';
  for (const p of seg.pieces) {
    if (p.local === 't') enc += 'L'.repeat(textContent(p).length);
    else enc += p.local === 'noBreakHyphen' || p.local === 'softHyphen' ? 'E' : 'L';
  }
  // Defensive: the two are built from the same pieces; never index past either.
  return enc.length === seg.text.length ? enc : 'L'.repeat(seg.text.length);
}

function rStyleOf(rPr: XmlElement | null): string | null {
  const rs = rPr ? child(rPr, NS_W, 'rStyle') : undefined;
  return (rs && attr(rs, NS_W, 'val')) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// Building

type Piece = { t: 'text'; s: string } | { t: 'xml'; s: string };

/** `text` as run content: `w:t` pieces with `w:tab` / `w:br` / hyphen elements between them. */
function textPieces(w: string, text: string, src: Src | null): Piece[] {
  const old = src?.text ?? '';
  const enc = src?.enc ?? '';
  const max = Math.min(old.length, text.length);
  let pre = 0;
  while (pre < max && old[pre] === text[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
  const usesElement = (ch: string): boolean => {
    for (let k = 0; k < old.length; k++) if (old[k] === ch && enc[k] === 'E') return true;
    return false;
  };
  const elementDefault: Record<string, boolean> = { [NB_HYPHEN]: usesElement(NB_HYPHEN), [SOFT_HYPHEN]: usesElement(SOFT_HYPHEN) };
  const out: Piece[] = [];
  let buf = '';
  const flush = (): void => { if (buf !== '') { out.push({ t: 'text', s: buf }); buf = ''; } };
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\t') { flush(); out.push({ t: 'xml', s: `<${w}:tab/>` }); continue; }
    if (ch === '\n') { flush(); out.push({ t: 'xml', s: `<${w}:br/>` }); continue; }
    if (ch === NB_HYPHEN || ch === SOFT_HYPHEN) {
      const asElement = j < pre ? enc[j] === 'E'
        : j >= text.length - suf ? enc[old.length - (text.length - j)] === 'E'
          : elementDefault[ch];
      if (asElement) { flush(); out.push({ t: 'xml', s: `<${w}:${ch === NB_HYPHEN ? 'noBreakHyphen' : 'softHyphen'}/>` }); continue; }
    }
    buf += ch;
  }
  flush();
  return out;
}

const pieceXml = (w: string, p: Piece): string => (p.t === 'text' ? `<${w}:t xml:space="preserve">${escapeText(p.s)}</${w}:t>` : p.s);

/** What the island would send for text it did not touch: CR/CRLF as `\n`, no characters XML forbids. */
function cleanText(s: string): string {
  return stripIllegalXmlChars(s).replace(/\r\n?/g, '\n');
}

type Out =
  | { kind: 'text'; srcId: number | null; text: string; b: boolean; i: boolean; u: boolean }
  | { kind: 'atom'; seg: AtomSeg }
  | { kind: 'anchor'; seg: AnchorSeg };

interface Carry { from: XmlNode; top: number; inner: number; }
interface Entry { xml: string; els: number; carries: Carry[]; }
interface NewRun { rPrXml: string; pieces: Piece[]; carries: { from: XmlNode; piece: number }[]; }

function elementOrdinal(parent: XmlElement, node: XmlNode): number {
  let k = 0;
  for (const c of parent.children) {
    if (c === node) return k;
    if (c.type === 'el') k++;
  }
  return -1;
}

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.type === 'el') out.push(c);
  return out;
}

/**
 * The XML of paragraph `block` holding `items` (§8.4). Returns an `OfficeError` (nothing built) for
 * a block that is stale, locked or not a paragraph, for malformed items or unknown ids, and for
 * markup that cannot be written. `changed: false` means the paragraph already reads exactly `xml`.
 */
export function buildParagraphXml(model: DocxModel, styles: DocxStyles, block: Block, items: DocxCommitItem[],
  opts?: BuildOptions): BuiltParagraph | OfficeError {
  if (model.viewOnlyReason) return err('read-only', 'This document is view-only.');
  const cur = model.block(block.id);
  if (!cur || cur.el !== block.el) return err('stale', 'This paragraph has changed. Try again.');
  if (!isEditable(cur)) return err('blocked', LOCK_MESSAGES[cur.lockReason ?? 'opaque']);
  try {
    return build(model, styles, cur, items, opts ?? {});
  } catch (e) {
    if (e instanceof InvalidItems) return err('invalid', e.message);
    if (e instanceof WriterRefusal) return err('blocked', `This paragraph can't be edited here (${e.message}).`);
    return err('internal', e instanceof Error ? e.message : String(e));
  }
}

class InvalidItems extends Error {}

function build(model: DocxModel, styles: DocxStyles, block: Block, items: DocxCommitItem[], opts: BuildOptions): BuiltParagraph {
  const p = block.el;
  const doc = model.pkg.xml(model.mainPart);
  const w = model.wPrefix;
  const segs = model.segments(block);
  const props = paragraphProps(p);
  const keepIds = opts.keepIds !== false;
  const omit = opts.omit ?? new Set<number>();

  // --- the paragraph's own pieces
  const pText = serialize(p);
  const pPrXml = opts.pPrXml !== undefined ? opts.pPrXml : props.pPr ? serialize(props.pPr) : '';
  let targetStyleId = props.pStyleId;
  if (opts.pPrXml !== undefined) {
    targetStyleId = opts.pPrXml === '' ? null : paragraphStyleOf(oneElement(doc, opts.pPrXml, 'w:pPr'));
  }

  // --- index the current segments
  const textSegs = new Map<number, TextSeg>();
  const atomSegs = new Map<number, AtomSeg>();
  const anchorSegs = new Map<number, AnchorSeg>();
  /** Per run: its non-empty text segments and in-run atoms, in order (what a source-slice run must match). */
  const runContent = new Map<XmlElement, (TextSeg | AtomSeg)[]>();
  for (const s of segs) {
    if (s.kind === 'text') {
      textSegs.set(s.id, s);
      if (s.text !== '') pushTo(runContent, s.run, s);
    } else if (s.kind === 'atom') {
      atomSegs.set(s.id, s);
      if (s.run) pushTo(runContent, s.run, s);
    } else if (s.kind === 'anchor') {
      anchorSegs.set(s.id, s);
    }
  }
  const toggleCache = new Map<XmlElement | null, Toggles>();
  const sourceToggles = (rPr: XmlElement | null): Toggles => {
    let t = toggleCache.get(rPr);
    if (!t) { t = styles.effectiveToggles(props.pStyleId, rPr); toggleCache.set(rPr, t); }
    return t;
  };

  // --- sources named by the items
  const known = aliases.get(model);
  const srcCache = new Map<number, Src>();
  const srcOf = (id: number): Src => {
    let s = srcCache.get(id);
    if (s) return s;
    const seg = textSegs.get(id);
    if (seg) {
      s = { id, seg, rPrXml: seg.rPr ? serialize(seg.rPr) : '', rPr: seg.rPr, text: seg.text, enc: encodingOf(seg) };
    } else {
      const a = known?.get(id);
      if (!a) throw new InvalidItems('The edit refers to text that is no longer in this paragraph.');
      s = { id, seg: null, rPrXml: a.rPrXml, rPr: a.rPrXml === '' ? null : oneElement(doc, a.rPrXml, 'w:rPr'), text: a.text, enc: a.enc };
    }
    srcCache.set(id, s);
    return s;
  };

  // --- validate and normalise the items
  if (!Array.isArray(items)) throw new InvalidItems('The edit is malformed.');
  const out: Out[] = [];
  const seen = new Set<number>();
  for (const it of items as unknown[]) {
    if (typeof it !== 'object' || it === null) throw new InvalidItems('The edit is malformed.');
    const item = it as Partial<Extract<DocxCommitItem, { kind: 'text' }>> & { kind?: string; id?: unknown };
    if (item.kind === 'text') {
      if (typeof item.text !== 'string' || typeof item.b !== 'boolean' || typeof item.i !== 'boolean' || typeof item.u !== 'boolean'
        || !(item.src === null || (typeof item.src === 'number' && Number.isInteger(item.src)))) {
        throw new InvalidItems('The edit is malformed.');
      }
      if (item.src !== null) srcOf(item.src);                        // unknown id: refuse
      const text = cleanText(item.text);
      if (text === '') continue;
      const last = out[out.length - 1];
      if (last && last.kind === 'text' && last.srcId === item.src && last.b === item.b && last.i === item.i && last.u === item.u) {
        last.text += text;
      } else {
        out.push({ kind: 'text', srcId: item.src, text, b: item.b, i: item.i, u: item.u });
      }
    } else if (item.kind === 'atom' || item.kind === 'anchor') {
      const id = item.id;
      if (typeof id !== 'number' || seen.has(id)) throw new InvalidItems('The edit is malformed.');
      const seg = item.kind === 'atom' ? atomSegs.get(id) : anchorSegs.get(id);
      if (!seg) throw new InvalidItems('The edit refers to content that is no longer in this paragraph.');
      seen.add(id);
      out.push(item.kind === 'atom' ? { kind: 'atom', seg: seg as AtomSeg } : { kind: 'anchor', seg: seg as AnchorSeg });
    } else {
      throw new InvalidItems('The edit is malformed.');
    }
  }

  // --- rule 1: nothing changed
  const contentChanged = !sameAsSegments(out, segs, sourceToggles);
  const plain = opts.pPrXml === undefined && keepIds;
  const currentContent = (): string => {
    let s = '';
    for (const c of p.children) if (c !== props.pPr) s += serialize(c);
    return s;
  };
  if (!contentChanged && plain) {
    return { xml: pText, changed: false, reinsertedAtoms: false, contentXml: currentContent(), adopt: () => undefined };
  }

  // --- rule 6: nothing is dropped
  let reinsertedAtoms = false;
  {
    let after: Out | null = null;
    for (const s of segs) {
      if (s.kind === 'disposable') continue;
      if (s.kind === 'text') {
        for (let k = out.length - 1; k >= 0; k--) {
          const o = out[k];
          if (o.kind === 'text' && o.srcId === s.id) { after = o; break; }
        }
        continue;
      }
      const there: Out | undefined = out.find((o) => o.kind !== 'text' && o.seg === s);
      if (there) { after = there; continue; }
      if (omit.has(s.id)) continue;
      const o: Out = s.kind === 'atom' ? { kind: 'atom', seg: s } : { kind: 'anchor', seg: s };
      out.splice(after ? out.indexOf(after) + 1 : 0, 0, o);
      after = o;
      if (s.kind === 'atom') reinsertedAtoms = true;
    }
    // A paired anchor's start always comes before its end.
    for (const end of out.slice()) {
      if (end.kind !== 'anchor' || end.seg.role !== 'end' || end.seg.pairKey === undefined) continue;
      const key = end.seg.pairKey;
      const start = out.find((o) => o.kind === 'anchor' && o.seg.role === 'start' && o.seg.pairKey === key);
      if (!start || out.indexOf(start) < out.indexOf(end)) continue;
      out.splice(out.indexOf(start), 1);
      out.splice(out.indexOf(end), 0, start);
    }
  }

  // --- rules 3–5, 7: emit
  const entries: Entry[] = [];
  let pending: NewRun | null = null;
  const flushRun = (): void => {
    if (!pending) return;
    const run = pending;
    pending = null;
    const base = run.rPrXml === '' ? 0 : 1;
    entries.push({
      xml: `<${w}:r>${run.rPrXml}${run.pieces.map((x) => pieceXml(w, x)).join('')}</${w}:r>`,
      els: 1,
      carries: run.carries.map((c) => ({ from: c.from, top: 0, inner: base + c.piece })),
    });
  };
  const addToRun = (rPrXml: string, pieces: Piece[], from: XmlNode | null): void => {
    if (pieces.length === 0) return;
    if (pending && pending.rPrXml !== rPrXml) flushRun();
    if (!pending) pending = { rPrXml, pieces: [], carries: [] };
    const run = pending;
    let first = run.pieces.length;
    const lastPiece = run.pieces[run.pieces.length - 1];
    let rest = pieces;
    if (lastPiece && lastPiece.t === 'text' && pieces[0].t === 'text') {
      lastPiece.s += pieces[0].s;                                   // adjacent text shares one w:t
      rest = pieces.slice(1);
      first--;
    }
    run.pieces.push(...rest.map((x) => ({ ...x })));
    if (from && !run.carries.some((c) => c.piece === first)) run.carries.push({ from, piece: first });
  };

  const inheritedCache = new Map<string, Toggles>();
  const rPrCache = new Map<string, string>();
  const rPrFor = (src: Src | null, o: Extract<Out, { kind: 'text' }>): string => {
    const key = `${src ? src.id : 'null'}:${o.b ? 1 : 0}${o.i ? 1 : 0}${o.u ? 1 : 0}`;
    const hit = rPrCache.get(key);
    if (hit !== undefined) return hit;
    const base = sourceToggles(src ? src.rPr : null);
    let xml = src ? src.rPrXml : '';
    const rStyle = rStyleOf(src ? src.rPr : null);
    for (const which of TOGGLES) {
      if (o[which] === base[which]) continue;                       // not flipped: its encoding is left alone
      const ik = rStyle ?? '';
      let inherited = inheritedCache.get(ik);
      if (!inherited) { inherited = styles.inheritedToggles(targetStyleId, rStyle); inheritedCache.set(ik, inherited); }
      try {
        xml = setToggle(xml === '' ? null : xml, which, o[which], inherited[which], doc);
      } catch (e) {
        throw new WriterRefusal(e instanceof Error ? e.message : String(e));
      }
    }
    rPrCache.set(key, xml);
    return xml;
  };

  const usedRuns = new Set<XmlElement>();
  /** Number of `out` entries from `k` that are run `run`'s content exactly as it is now, or 0. */
  const sliceMatch = (k: number, run: XmlElement): number => {
    if (usedRuns.has(run)) return 0;
    const content = runContent.get(run);
    if (!content || k + content.length > out.length) return 0;
    for (let j = 0; j < content.length; j++) {
      const s = content[j];
      const o = out[k + j];
      if (s.kind === 'atom') {
        if (o.kind !== 'atom' || o.seg !== s) return 0;
      } else {
        if (o.kind !== 'text' || o.srcId !== s.id || o.text !== s.text) return 0;
        const t = sourceToggles(s.rPr);
        if (t.b !== o.b || t.i !== o.i || t.u !== o.u) return 0;
      }
    }
    return content.length;
  };

  // Rule 3 first: which stretches of `out` are a source run exactly as it is now.
  const slices = new Map<number, { run: XmlElement; n: number }>();
  const claim = new Map<number, Out>();
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    const run = o.kind === 'text' ? (o.srcId !== null ? textSegs.get(o.srcId)?.run : undefined)
      : o.kind === 'atom' ? o.seg.run ?? undefined : undefined;
    const n = run ? sliceMatch(k, run) : 0;
    if (!run || n === 0) continue;
    usedRuns.add(run);
    slices.set(k, { run, n });
    for (let j = 0; j < n; j++) {
      const m = out[k + j];
      if (m.kind === 'text' && m.srcId !== null) claim.set(m.srcId, m);
    }
    k += n - 1;
  }
  // Which text item keeps each other live segment's id: the first that keeps the segment's
  // formatting, else the first.
  for (const pass of [0, 1]) {
    for (const o of out) {
      if (o.kind !== 'text' || o.srcId === null || claim.has(o.srcId)) continue;
      const seg = textSegs.get(o.srcId);
      if (!seg) continue;
      const t = sourceToggles(seg.rPr);
      if (pass === 1 || (t.b === o.b && t.i === o.i && t.u === o.u)) claim.set(o.srcId, o);
    }
  }

  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    const slice = slices.get(k);
    if (slice) {
      // The run as it is in the source, attributes included.
      const run = slice.run;
      flushRun();
      const carries: Carry[] = [];
      for (const s of segs) {
        if (s.kind === 'text' && s.run === run) carries.push({ from: s.pieces[0], top: 0, inner: elementOrdinal(run, s.pieces[0]) });
        else if (s.kind === 'atom' && s.run === run) carries.push({ from: s.nodes[0], top: 0, inner: elementOrdinal(run, s.nodes[0]) });
      }
      entries.push({ xml: serialize(run), els: 1, carries });
      k += slice.n - 1;
      continue;
    }
    if (o.kind === 'text') {
      const src = o.srcId === null ? null : srcOf(o.srcId);
      const from = src && src.seg && claim.get(src.id) === o ? src.seg.pieces[0] : null;
      addToRun(rPrFor(src, o), textPieces(w, o.text, src), from);
    } else if (o.kind === 'atom' && o.seg.run) {
      // One child of a run that is not emitted as a slice: its own run, same properties.
      addToRun(o.seg.rPr ? serialize(o.seg.rPr) : '', [{ t: 'xml', s: serialize(o.seg.nodes[0]) }], o.seg.nodes[0]);
    } else {
      flushRun();
      const nodes = o.kind === 'atom' ? o.seg.nodes : [o.seg.node];
      entries.push({
        xml: nodes.map((x) => serialize(x)).join(''),
        els: nodes.filter((x) => x.type === 'el').length,
        carries: [{ from: nodes[0], top: 0, inner: -1 }],
      });
    }
  }
  flushRun();

  // --- rule 8: the paragraph element itself
  const contentXml = entries.map((e) => e.xml).join('');
  const open = openTagOf(pText);
  const rawNameOf = (ns: string, test: (local: string) => boolean): Set<string> =>
    new Set(p.attrs.filter((a) => a.ns === ns && test(a.local)).map((a) => a.rawName));
  const assemble = (dropTextId: boolean): string => {
    let tag = open;
    if (!keepIds) {
      const drop = new Set([...rawNameOf(NS_W14, (l) => l === 'paraId' || l === 'textId'), ...rawNameOf(NS_W, (l) => l.startsWith('rsid'))]);
      if (drop.size) tag = stripAttrs(tag, (name) => drop.has(name));
    } else if (dropTextId) {
      const drop = rawNameOf(NS_W14, (l) => l === 'textId');
      if (drop.size) tag = stripAttrs(tag, (name) => drop.has(name));
    }
    const inner = pPrXml + contentXml;
    return inner === '' ? tag.slice(0, -1) + '/>' : tag + inner + `</${p.rawName}>`;
  };
  // The items can differ from the segments (ids from before an earlier commit) and still describe
  // exactly what is there: then nothing changes, w14:textId included.
  let xml = assemble(false);
  if (plain && xml === pText) {
    // `reinsertedAtoms` can be true here: the only thing the commit did was drop an atom.
    return { xml: pText, changed: false, reinsertedAtoms, contentXml: currentContent(), adopt: () => undefined };
  }
  if (contentChanged && keepIds) xml = assemble(true);
  oneElement(doc, xml, 'w:p');                                       // refuse now what the tree would refuse later

  const pPrEls = pPrXml === '' ? 0 : 1;
  const total = entries.reduce((s, e) => s + e.els, 0);
  const remember: [number, Alias][] = [];
  for (const s of textSegs.values()) remember.push([s.id, { rPrXml: s.rPr ? serialize(s.rPr) : '', text: s.text, enc: encodingOf(s) }]);

  const adopt = (newP: XmlElement): void => {
    let table = aliases.get(model);
    if (!table) { table = new Map(); aliases.set(model, table); }
    for (const [id, a] of remember) table.set(id, a);
    if (keepIds) model.carryId(p, newP);
    const kids = elementChildren(newP);
    if (kids.length !== pPrEls + total) return;                     // not the shape that was built: ids simply become new
    let at = pPrEls;
    for (const e of entries) {
      for (const c of e.carries) {
        const top = kids[at + c.top];
        const to = c.inner < 0 ? top : elementChildren(top)[c.inner];
        if (to) model.carryId(c.from, to);
      }
      at += e.els;
    }
  };
  return { xml, changed: xml !== pText, reinsertedAtoms, contentXml, adopt };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

function paragraphStyleOf(pPr: XmlElement): string | null {
  const ps = child(pPr, NS_W, 'pStyle');
  return (ps && attr(ps, NS_W, 'val')) ?? null;
}

/** Rule 1: the normalised items are the current segments (empty text segments carry nothing). */
function sameAsSegments(out: readonly Out[], segs: readonly Segment[], toggles: (rPr: XmlElement | null) => Toggles): boolean {
  let k = 0;
  for (const s of segs) {
    if (s.kind === 'disposable' || (s.kind === 'text' && s.text === '')) continue;
    const o = out[k++];
    if (!o || o.kind !== s.kind) return false;
    if (o.kind === 'text') {
      const seg = s as TextSeg;
      if (o.srcId !== seg.id || o.text !== seg.text) return false;
      const t = toggles(seg.rPr);
      if (t.b !== o.b || t.i !== o.i || t.u !== o.u) return false;
    } else if (o.seg !== s) {
      return false;
    }
  }
  return k === out.length;
}

/**
 * Replace paragraph `blockId` with what `items` describe, recording into `b` (§8.4). Records
 * nothing when the paragraph already reads that way (`changed: false`). On success the new `w:p` has
 * the block's id and the segment ids are carried over; the caller finishes (or aborts) the builder
 * and calls `model.refresh()`. On error nothing was changed or recorded.
 */
export function commitParagraph(b: EditBuilder, model: DocxModel, styles: DocxStyles, blockId: number, items: DocxCommitItem[]): CommitOutcome {
  if (model.viewOnlyReason) return { ok: false, error: err('read-only', 'This document is view-only.') };
  const block = model.block(blockId);
  if (!block) return { ok: false, error: err('stale', 'This paragraph no longer exists. Try again.') };
  const built = buildParagraphXml(model, styles, block, items);
  if (isError(built)) return { ok: false, error: built };
  if (!built.changed) return { ok: true, changed: false, changedBlockIds: [], reinsertedAtoms: built.reinsertedAtoms };
  let nodes: XmlNode[];
  try {
    nodes = b.replaceNode(model.mainPart, block.el, built.xml);
  } catch (e) {
    // Root-scoped insertion failed: a prefix means something else at this paragraph than at the root.
    return { ok: false, error: err('blocked', `This paragraph can't be edited here (${e instanceof Error ? e.message : String(e)}).`) };
  }
  const newP = nodes[0];
  if (nodes.length === 1 && newP.type === 'el') built.adopt(newP);
  if (built.reinsertedAtoms) b.notice({ ...ATOMS_KEPT_NOTICE });
  return { ok: true, changed: true, changedBlockIds: [blockId], reinsertedAtoms: built.reinsertedAtoms };
}
