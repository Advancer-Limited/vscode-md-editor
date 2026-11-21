// Docx edit operations (spec §8.5 incl. the Containers bullet, §5.1; plan WP-29).
//
// `applyDocxEdit` is the one entry point the provider calls for a `docxEdit` message. It builds the
// edit with an `EditBuilder`, so the edit it returns is ALREADY APPLIED to `ctx.pkg` (register it
// with `OfficeDocument.recordApplied`, never `applyEdit`), and it has already refreshed the model
// (and reloaded styles/numbering when another part changed). On an error nothing is changed:
// whatever was recorded is rolled back.
//
// What each structure operation writes:
//   split    the block's `w:p` is replaced by the first half (or left alone when the first half is
//            the paragraph as it is) and one new `w:p` is inserted right after it. The first half
//            keeps the block id, attributes and `w:pPr` minus `w:sectPr`; the new paragraph gets a
//            copy of `w:pPr` (with the `w:sectPr`, which must end the section after the second
//            half), no `w14:paraId` / `w14:textId` / `w:rsid*`. Split at the end of a paragraph
//            whose style declares a different `w:next`: the new paragraph takes that style and
//            loses `w:numPr` unless the next style is a list style. Enter in an empty list item
//            turns the list off instead (one `w:p` replaced, nothing inserted).
//   merge    the second paragraph's content is appended to the previous sibling's `w:p` (whose own
//            children, attributes and `w:pPr` stay byte for byte; only `w14:textId` goes) and the
//            second `w:p` is removed. A `w:sectPr` on the SECOND paragraph is carried into the
//            merged paragraph's `w:pPr` (the section still ends there); one on the first refuses.
//   insert   a bare `<w:p/>` right after the named block, in that block's container (so after a
//            nested table it lands in the holding cell), or as the first block of the body.
//   remove   the `w:p` is removed; its anchors are first re-inserted at the start of the next
//            sibling paragraph, or the end of the previous one.
//
// Containers (§8.5): every operation stays inside one container. "Previous"/"next" always means a
// sibling block of the same `w:body` or `w:tc`; no `w:tbl`, `w:tr`, `w:tc` or table property is
// ever written, and a cell always keeps a `w:p` as its last child.
//
// Refuse rather than guess: see `removalPlan`, `mergeOp` and `insertOp` for the cases refused
// beyond what §8.5 lists.
//
// No `vscode` import here (core rule).

import type { DocxBlockInfo, DocxCommitItem, DocxEditOp } from '../../protocol.js';
import type { OfficeError } from '../types.js';
import type { OfficeEdit } from '../edits.js';
import { EditBuilder } from '../edits.js';
import { LIMITS } from '../limits.js';
import type { OfficePackage } from '../package.js';
import type { XmlDoc, XmlElement, XmlNode } from '../xml.js';
import { XmlError, XmlScopeError, attr, child, childrenOf, escapeAttr, parseFragment, serialize, stripIllegalXmlChars } from '../xml.js';
import type { Block, Container, DocxModel, LockReason, ParagraphProps, Segment } from './model.js';
import { NS_W, isEditable, paragraphProps } from './model.js';
import type { DocxStyles } from './styles.js';
import type { DocxNumbering } from './numbering.js';
import type { BuildOptions, BuiltParagraph } from './paragraphWriter.js';
import { ATOMS_KEPT_NOTICE, NS_W14, buildParagraphXml, commitParagraph, upsertPPrChild } from './paragraphWriter.js';
import { setList, setListLevel, setStyle } from './stylesWrite.js';

export interface DocxContext {
  pkg: OfficePackage;
  model: DocxModel;
  styles: DocxStyles;
  numbering: DocxNumbering;
}

export type DocxFocus = { blockId: number; at: 'start' | 'end' | number };

/**
 * Result of `applyDocxEdit`. `edit` is null when the operation changed nothing (no undo entry, not
 * dirty). `changedBlockIds`: blocks whose content or properties now differ, new blocks included
 * (a removed block is simply absent from `blockInfos`). For `commitParagraph` it also names the
 * block when nothing was written but the island is out of step with the document (the commit only
 * dropped an atom, which the writer kept): the webview should rebuild that island.
 */
export type OpOutcome =
  | { ok: true; edit: OfficeEdit | null; changedBlockIds: number[]; focus?: DocxFocus }
  | { ok: false; error: OfficeError };

export const LABELS = Object.freeze({
  commit: 'Edit Paragraph', split: 'Split Paragraph', merge: 'Merge Paragraphs', insert: 'Insert Paragraph',
  remove: 'Remove Paragraph', style: 'Change Style', list: 'Change List',
});

type AnchorSeg = Extract<Segment, { kind: 'anchor' }>;

const LOCK_MESSAGES: Readonly<Record<LockReason, string>> = {
  'tracked-changes': "This paragraph contains tracked changes and can't be edited here.",
  'multi-paragraph-field': "This paragraph is part of a field that spans several paragraphs and can't be edited here.",
  'unknown-content': "This paragraph contains content this editor doesn't understand, so it is kept as is.",
  'merged-cell': "This cell is part of a merged cell and can't be edited here.",
  opaque: "This content can't be edited here. It is preserved as is.",
};

const err = (code: OfficeError['code'], message: string): OfficeError => ({ code, message });
const blocked = (message: string): OfficeError => err('blocked', message);
const isError = (x: object): x is OfficeError => 'code' in x && 'message' in x;

/** Thrown inside an operation body to refuse it; `run` rolls back and returns the error. */
class Refusal extends Error {
  readonly error: OfficeError;
  constructor(error: OfficeError) {
    super(error.message);
    this.error = error;
  }
}

const isW = (n: XmlNode | undefined | null, local: string): n is XmlElement =>
  n !== undefined && n !== null && n.type === 'el' && n.ns === NS_W && n.local === local;

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.type === 'el') out.push(c);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Facts about blocks

/** Caret units of a paragraph's content (WP-32): a character, break or chip is 1, an anchor 0. */
function unitsOf(segs: readonly Segment[]): number {
  let n = 0;
  for (const s of segs) n += s.kind === 'text' ? s.text.length : s.kind === 'atom' ? 1 : 0;
  return n;
}

const pPrXmlOf = (props: ParagraphProps): string => (props.pPr ? serialize(props.pPr) : '');

/** The list a paragraph is in: direct `w:numPr` (numId 0 = explicitly none), else its style's. */
function listOf(ctx: DocxContext, props: ParagraphProps): DocxBlockInfo['list'] {
  const numPr = props.numPr ?? ctx.styles.styleNumPr(props.pStyleId);
  if (!numPr || numPr.numId === 0) return { kind: 'none', level: 0 };
  return ctx.numbering.listInfo(numPr.numId, numPr.ilvl);
}

interface ContainerFacts { paragraphs: number; }

function containerFacts(model: DocxModel, c: Container): ContainerFacts {
  let paragraphs = 0;
  for (const b of model.blocksIn(c)) if (b.kind === 'paragraph') paragraphs++;
  return { paragraphs };
}

type RemovalPlan =
  | { ok: true; anchors: AnchorSeg[]; target: { block: Block; where: 'start' | 'end' } | null; prev: Block | null; next: Block | null }
  | { ok: false; message: string };

/**
 * Whether paragraph `block` may be removed (§8.5), and where its anchors go. Refused: anything that
 * is not an editable paragraph; atoms; `w:sectPr`; the container's only paragraph; in a cell, the
 * last block when the block before it is not a paragraph (a cell must end with a `w:p`).
 * Beyond §8.5 (refuse rather than guess): a paragraph holding anchors is removable only when the
 * block right after it, or else right before it, is an editable paragraph of the same container.
 * Anchors are never pushed into a locked paragraph or across a table.
 */
const isTableBlock = (b: Block | null): boolean => !!b && b.isTable;

function removalPlan(model: DocxModel, block: Block, facts: ContainerFacts): RemovalPlan {
  if (block.kind !== 'paragraph') return { ok: false, message: LOCK_MESSAGES.opaque };
  if (!isEditable(block)) return { ok: false, message: LOCK_MESSAGES[block.lockReason ?? 'opaque'] };
  const segs = model.segments(block);
  if (segs.some((s) => s.kind === 'atom')) return { ok: false, message: "This paragraph contains an image, field or link, so it can't be removed here." };
  if (paragraphProps(block.el).hasSectPr) return { ok: false, message: "This paragraph ends a section, so it can't be removed here." };
  const inCell = block.container.tableBlockId !== null;
  if (facts.paragraphs <= 1) {
    return { ok: false, message: inCell ? 'A table cell must keep at least one paragraph.' : "The last paragraph can't be removed." };
  }
  const { prev, next } = model.siblings(block);
  if (inCell && next === null && (prev === null || prev.kind !== 'paragraph')) {
    return { ok: false, message: 'A table cell must end with a paragraph.' };
  }
  // Review N2: two w:tbl elements with nothing between them are one table to Word.
  if (isTableBlock(prev) && isTableBlock(next)) {
    return { ok: false, message: "This paragraph separates two tables, so it can't be removed here (they would join into one)." };
  }
  const anchors = segs.filter((s): s is AnchorSeg => s.kind === 'anchor');
  let target: { block: Block; where: 'start' | 'end' } | null = null;
  if (anchors.length > 0) {
    if (next && isEditable(next)) target = { block: next, where: 'start' };
    else if (prev && isEditable(prev)) target = { block: prev, where: 'end' };
    else return { ok: false, message: "This paragraph holds bookmarks or comments that have nowhere to go, so it can't be removed here." };
  }
  return { ok: true, anchors, target, prev, next };
}

/** `DocxBlockInfo` for every block of every container, in document order (`docxRender.blocks`). */
export function blockInfos(ctx: DocxContext): DocxBlockInfo[] {
  const { model, styles } = ctx;
  const facts = new Map<Container, ContainerFacts>();
  const out: DocxBlockInfo[] = [];
  for (const b of model.blocks()) {
    const info: DocxBlockInfo = {
      id: b.id,
      kind: b.kind,
      parentId: b.container.tableBlockId,
      editable: isEditable(b),
      removable: false,
      style: { kind: 'other', name: '' },
      list: { kind: 'none', level: 0 },
    };
    if (b.container.tableBlockId !== null) info.cell = { row: b.container.row, col: b.container.col };
    if (b.lockReason !== undefined) info.lockReason = b.lockReason;
    if (b.kind === 'paragraph') {
      const props = paragraphProps(b.el);
      info.style = styles.styleInfo(props.pStyleId);
      info.list = listOf(ctx, props);
      if (info.editable) {
        let f = facts.get(b.container);
        if (!f) { f = containerFacts(model, b.container); facts.set(b.container, f); }
        info.removable = removalPlan(model, b, f).ok;
      }
    }
    out.push(info);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Running one operation

interface Done {
  /** Evaluated after the model was refreshed (ids of new nodes exist only then). */
  changed(): number[];
  focus?(): DocxFocus | undefined;
}

const VIEW_ONLY: OpOutcome = Object.freeze({ ok: false, error: Object.freeze(err('read-only', 'This document is view-only.')) }) as OpOutcome;

function run(ctx: DocxContext, label: string, body: (b: EditBuilder) => Done | OfficeError): OpOutcome {
  const { model } = ctx;
  if (model.viewOnlyReason) return VIEW_ONLY;
  const b = new EditBuilder(ctx.pkg, label);
  const undo = (): void => {
    const dirty = b.size > 0;
    b.abort();
    if (dirty) model.refresh();
  };
  let r: Done | OfficeError;
  try {
    r = body(b);
  } catch (e) {
    undo();
    if (e instanceof Refusal) return { ok: false, error: e.error };
    // A prefix means something else where the markup came from than where it has to go (or is not
    // bound there at all): it cannot be written.
    if (e instanceof XmlScopeError || e instanceof XmlError) return { ok: false, error: blocked(`This can't be edited here (${e.message}).`) };
    return { ok: false, error: err('internal', e instanceof Error ? e.message : String(e)) };
  }
  if (isError(r)) {
    undo();
    return { ok: false, error: r };
  }
  const parts = b.changedParts();
  const edit = b.finish();
  if (edit) {
    if (parts.some((p) => p !== model.mainPart)) {
      ctx.styles.reload();
      ctx.numbering.reload();
    }
    model.refresh();
  }
  const out: OpOutcome = { ok: true, edit, changedBlockIds: r.changed() };
  const focus = r.focus?.();
  if (focus) out.focus = focus;
  return out;
}

/** The current, editable paragraph block `id`, or the error to return. */
function editableParagraph(model: DocxModel, id: number): Block | OfficeError {
  const block = model.block(id);
  if (!block) return err('stale', 'This paragraph no longer exists. Try again.');
  if (!isEditable(block)) return blocked(LOCK_MESSAGES[block.lockReason ?? 'opaque']);
  return block;
}

const isBlock = (x: Block | OfficeError): x is Block => 'el' in x;

/** `buildParagraphXml`, throwing a `Refusal` instead of returning an error. */
function build(ctx: DocxContext, block: Block, items: DocxCommitItem[], opts?: BuildOptions): BuiltParagraph {
  const built = buildParagraphXml(ctx.model, ctx.styles, block, items, opts);
  if ('code' in built) throw new Refusal(built);
  return built;
}

/** `upsertPPrChild` on '' = no `w:pPr`; a `w:pPr` it cannot rewrite refuses the operation. */
function withPPrChild(pPrXml: string, local: string, xml: string | null, doc: XmlDoc): string {
  try {
    return upsertPPrChild(pPrXml === '' ? null : pPrXml, local, xml, doc);
  } catch (e) {
    throw new Refusal(blocked(`This paragraph's properties can't be rewritten here (${e instanceof Error ? e.message : String(e)}).`));
  }
}

function tooMany(model: DocxModel): OfficeError | null {
  return model.blocks().length >= LIMITS.docxMaxBlocks ? blocked('This document has too many paragraphs to add another one here.') : null;
}

const MALFORMED = 'The edit is malformed.';

/** Atom and anchor ids named by commit items, or null when the items are not an array of objects. */
function markIds(items: DocxCommitItem[]): Set<number> | null {
  if (!Array.isArray(items)) return null;
  const ids = new Set<number>();
  for (const it of items as unknown[]) {
    if (typeof it !== 'object' || it === null) return null;
    const item = it as { kind?: unknown; id?: unknown };
    if ((item.kind === 'atom' || item.kind === 'anchor') && typeof item.id === 'number') ids.add(item.id);
  }
  return ids;
}

/** The items show something: an atom, or text that survives cleaning. */
function hasVisible(items: DocxCommitItem[]): boolean {
  return items.some((it) => it.kind === 'atom' || (it.kind === 'text' && typeof it.text === 'string' && stripIllegalXmlChars(it.text) !== ''));
}

// ---------------------------------------------------------------------------------------------------
// Split

/**
 * The paragraph style `w:next` of style `styleId` (null = the default paragraph style) names, when
 * it is another existing paragraph style; else null. `w:next` is read from the style itself: it is
 * not inherited through `w:basedOn`.
 */
function nextStyleId(ctx: DocxContext, styleId: string | null): string | null {
  const part = ctx.styles.part;
  const cur = styleId ?? ctx.styles.defaultParagraphStyleId();
  if (!part || ctx.styles.damaged || cur === null) return null;
  let root: XmlElement;
  try { root = ctx.pkg.xml(part).root; } catch { return null; }
  const byId = (id: string): XmlElement | undefined => childrenOf(root, NS_W, 'style').find((s) => attr(s, NS_W, 'styleId') === id);
  const def = byId(cur);
  if (!def || attr(def, NS_W, 'type') !== 'paragraph') return null;
  const nextEl = child(def, NS_W, 'next');
  const next = nextEl ? attr(nextEl, NS_W, 'val') : undefined;
  if (!next || next === cur) return null;
  const target = byId(next);
  return target && attr(target, NS_W, 'type') === 'paragraph' ? next : null;
}

/** `w:pPr` XML of a paragraph taken out of its list (§8.6 "Turn off"). */
function listOffPPr(ctx: DocxContext, props: ParagraphProps, doc: XmlDoc): string {
  const { styles } = ctx;
  let pPr = pPrXmlOf(props);
  let styleId = props.pStyleId;
  if (styleId !== null && styleId === styles.listParagraphStyleId()) {
    pPr = withPPrChild(pPr, 'pStyle', null, doc);
    styleId = null;
  }
  const w = ctx.model.wPrefix;
  // Numbering that comes from the (remaining) style can only be switched off, not removed.
  const off = styles.styleNumPr(styleId) ? `<${w}:numPr><${w}:numId ${w}:val="0"/></${w}:numPr>` : null;
  return withPPrChild(pPr, 'numPr', off, doc);
}

function splitOp(ctx: DocxContext, op: Extract<DocxEditOp, { op: 'splitParagraph' }>): OpOutcome {
  const { model } = ctx;
  if (model.viewOnlyReason) return VIEW_ONLY;
  const block = editableParagraph(model, op.blockId);
  if (!isBlock(block)) return { ok: false, error: block };
  const main = model.mainPart;
  const doc = ctx.pkg.xml(main);
  const segs = model.segments(block);
  const props = paragraphProps(block.el);
  const beforeIds = markIds(op.before);
  const afterIds = markIds(op.after);
  if (!beforeIds || !afterIds) return { ok: false, error: err('invalid', MALFORMED) };
  // An atom or anchor is in one half or the other.
  for (const id of afterIds) if (beforeIds.has(id)) return { ok: false, error: err('invalid', MALFORMED) };

  // Enter in an empty list item ends the list instead of adding a paragraph (§8.5).
  const empty = !hasVisible(op.before) && !hasVisible(op.after) && !segs.some((s) => s.kind === 'atom');
  if (empty && listOf(ctx, props).kind !== 'none') {
    return run(ctx, LABELS.list, (b) => {
      const built = build(ctx, block, [...op.before, ...op.after], { pPrXml: listOffPPr(ctx, props, doc) });
      if (built.changed) {
        const nodes = b.replaceNode(main, block.el, built.xml);
        if (nodes.length === 1 && nodes[0].type === 'el') built.adopt(nodes[0]);
      }
      return { changed: () => (built.changed ? [block.id] : []), focus: () => ({ blockId: block.id, at: 'start' }) };
    });
  }

  const limit = tooMany(model);
  if (limit) return { ok: false, error: limit };
  return run(ctx, LABELS.split, (b) => {
    const own = pPrXmlOf(props);
    // First half: the block itself. Its section break, if any, moves to the second half.
    const firstOpts: BuildOptions = props.hasSectPr ? { omit: afterIds, pPrXml: withPPrChild(own, 'sectPr', null, doc) } : { omit: afterIds };
    // Second half: a new paragraph with a copy of the properties.
    let secondPPr = own;
    if (!hasVisible(op.after)) {
      const next = nextStyleId(ctx, props.pStyleId);
      if (next !== null) {
        const w = model.wPrefix;
        const isDefault = next === ctx.styles.defaultParagraphStyleId();
        secondPPr = withPPrChild(secondPPr, 'pStyle', isDefault ? null : `<${w}:pStyle ${w}:val="${escapeAttr(next)}"/>`, doc);
        if (!ctx.styles.styleNumPr(next)) secondPPr = withPPrChild(secondPPr, 'numPr', null, doc);
      }
    }
    const omitSecond = new Set<number>();
    for (const s of segs) if ((s.kind === 'atom' || s.kind === 'anchor') && !afterIds.has(s.id)) omitSecond.add(s.id);
    // Both halves are built from the paragraph as it is, before anything is written.
    const first = build(ctx, block, op.before, firstOpts);
    const second = build(ctx, block, op.after, { keepIds: false, omit: omitSecond, pPrXml: secondPPr });

    const parent = block.el.parent;
    if (!parent) throw new Refusal(err('stale', 'This paragraph has changed. Try again.'));
    let firstEl: XmlNode = block.el;
    if (first.changed) {
      const nodes = b.replaceNode(main, block.el, first.xml);
      if (nodes.length !== 1 || nodes[0].type !== 'el') throw new Error('split: the first half is not one element');
      firstEl = nodes[0];
      first.adopt(nodes[0]);
    }
    const inserted = b.insertAt(main, parent, parent.children.indexOf(firstEl) + 1, second.xml);
    const newP = inserted[0];
    if (inserted.length !== 1 || newP.type !== 'el') throw new Error('split: the second half is not one element');
    second.adopt(newP);
    if (first.reinsertedAtoms || second.reinsertedAtoms) b.notice({ ...ATOMS_KEPT_NOTICE });
    const newId = (): number => model.idOf(newP) ?? -1;
    return { changed: () => [block.id, newId()], focus: () => ({ blockId: newId(), at: 'start' }) };
  });
}

// ---------------------------------------------------------------------------------------------------
// Merge

/**
 * Give the nodes just inserted from `built.contentXml` the ids `built.adopt` hands out. `adopt`
 * wants the element parsed from `built.xml`; that paragraph is never inserted (its content is
 * appended to another one), so it is parsed detached, adopted, and its ids copied node for node.
 */
function adoptContent(model: DocxModel, doc: XmlDoc, built: BuiltParagraph, inserted: readonly XmlNode[]): void {
  const parsed = parseFragment(doc, built.xml);
  const tmp = parsed[0];
  if (parsed.length !== 1 || tmp.type !== 'el') return;
  built.adopt(tmp);
  let from = elementChildren(tmp);
  if (isW(from[0], 'pPr')) from = from.slice(1);
  const to = inserted.filter((n): n is XmlElement => n.type === 'el');
  if (from.length !== to.length) return;                               // ids simply become new ones
  for (let k = 0; k < to.length; k++) {
    model.carryId(from[k], to[k]);
    const a = elementChildren(from[k]);
    const z = elementChildren(to[k]);
    if (a.length === z.length) for (let j = 0; j < z.length; j++) model.carryId(a[j], z[j]);
  }
}

/**
 * Refused: no previous sibling in the container (the first paragraph of a cell or of the body), a
 * previous sibling that is locked or opaque, a `w:sectPr` on the first paragraph. A `w:sectPr` on
 * the SECOND paragraph is not a reason to refuse: it is carried into the merged paragraph (dropping
 * it would delete the section; §10.1).
 */
function mergeOp(ctx: DocxContext, op: Extract<DocxEditOp, { op: 'mergeWithPrevious' }>): OpOutcome {
  const { model } = ctx;
  if (model.viewOnlyReason) return VIEW_ONLY;
  const block = editableParagraph(model, op.blockId);
  if (!isBlock(block)) return { ok: false, error: block };
  const prev = model.siblings(block).prev;            // same container only: never across a cell boundary
  if (!prev) return { ok: false, error: blocked('There is no paragraph before this one to merge with here.') };
  if (!isEditable(prev)) return { ok: false, error: blocked("The content before this paragraph can't be edited, so the two can't be merged.") };
  const prevProps = paragraphProps(prev.el);
  if (prevProps.hasSectPr) return { ok: false, error: blocked("The paragraph before this one ends a section, so the two can't be merged.") };
  const main = model.mainPart;
  const doc = ctx.pkg.xml(main);
  const at = unitsOf(model.segments(prev));

  return run(ctx, LABELS.merge, (b) => {
    const props = paragraphProps(block.el);
    let mergedPPr = pPrXmlOf(prevProps);
    const sectPr = props.pPr ? child(props.pPr, NS_W, 'sectPr') : undefined;
    if (sectPr) mergedPPr = withPPrChild(mergedPPr, 'sectPr', serialize(sectPr), doc);
    const built = build(ctx, block, op.items, { keepIds: false, pPrXml: mergedPPr });

    if (sectPr) {
      if (prevProps.pPr) b.replaceNode(main, prevProps.pPr, mergedPPr);
      else b.insertAt(main, prev.el, 0, mergedPPr);
    }
    if (built.contentXml !== '') {
      const inserted = b.insertAt(main, prev.el, prev.el.children.length, built.contentXml);
      adoptContent(model, doc, built, inserted);
      b.setAttr(main, prev.el, NS_W14, 'textId', null);                // content changed (§8.4 rule 8)
    }
    b.removeNode(main, block.el);
    if (built.reinsertedAtoms) b.notice({ ...ATOMS_KEPT_NOTICE });
    return { changed: () => [prev.id], focus: () => ({ blockId: prev.id, at }) };
  });
}

// ---------------------------------------------------------------------------------------------------
// Insert and remove

/**
 * Refused beyond §8.5: after the body's final `w:sectPr` (it must stay last); inside a merged
 * continuation cell or a table with tracked structure (nothing there is editable, and a merged
 * cell is not displayed); between two paragraphs of one multi-paragraph field (the new paragraph
 * would sit inside the field).
 */
function insertOp(ctx: DocxContext, op: Extract<DocxEditOp, { op: 'insertParagraphAfter' }>): OpOutcome {
  const { model } = ctx;
  if (model.viewOnlyReason) return VIEW_ONLY;
  const limit = tooMany(model);
  if (limit) return { ok: false, error: limit };
  const main = model.mainPart;
  let parent: XmlElement;
  let after: XmlElement | null = null;
  if (op.blockId === null) {
    const body = model.body();
    if (!body) return VIEW_ONLY;
    parent = body.el;
  } else {
    const block = model.block(op.blockId);
    if (!block) return { ok: false, error: err('stale', 'This content no longer exists. Try again.') };
    if (block.container.lockReason) return { ok: false, error: blocked(LOCK_MESSAGES[block.container.lockReason]) };
    if (block.container.tableBlockId === null && isW(block.el, 'sectPr')) {
      return { ok: false, error: blocked("Nothing can be added after the end of the document's last section.") };
    }
    if (block.lockReason === 'multi-paragraph-field' && model.siblings(block).next?.lockReason === 'multi-paragraph-field') {
      return { ok: false, error: blocked("A paragraph can't be added inside a field that spans several paragraphs.") };
    }
    parent = block.container.el;
    after = block.el;
  }
  return run(ctx, LABELS.insert, (b) => {
    let index: number;
    if (after) {
      index = parent.children.indexOf(after);
      if (index < 0) throw new Refusal(err('stale', 'This content has changed. Try again.'));
      index++;
    } else {
      index = parent.children.findIndex((n) => n.type === 'el');       // before the first block of the body
      if (index < 0) index = parent.children.length;
    }
    const inserted = b.insertAt(main, parent, index, `<${model.wPrefix}:p/>`);
    const newP = inserted[0];
    const newId = (): number => model.idOf(newP) ?? -1;
    return { changed: () => [newId()], focus: () => ({ blockId: newId(), at: 'start' }) };
  });
}

function removeOp(ctx: DocxContext, op: Extract<DocxEditOp, { op: 'removeParagraph' }>): OpOutcome {
  const { model } = ctx;
  if (model.viewOnlyReason) return VIEW_ONLY;
  const block = model.block(op.blockId);
  if (!block) return { ok: false, error: err('stale', 'This paragraph no longer exists. Try again.') };
  const plan = removalPlan(model, block, containerFacts(model, block.container));
  if (!plan.ok) return { ok: false, error: blocked(plan.message) };
  const main = model.mainPart;
  return run(ctx, LABELS.remove, (b) => {
    const { target } = plan;
    if (target) {
      // Nothing is dropped: the anchors go, in their order, to the neighbouring paragraph.
      const el = target.block.el;
      let index = el.children.length;
      if (target.where === 'start') {
        const pPr = child(el, NS_W, 'pPr');
        index = pPr ? el.children.indexOf(pPr) + 1 : 0;
      }
      const xml = plan.anchors.map((a) => serialize(a.node)).join('');
      const inserted = b.insertAt(main, el, index, xml);
      if (inserted.length === plan.anchors.length) inserted.forEach((n, k) => model.carryId(plan.anchors[k].node, n));
    }
    b.removeNode(main, block.el);
    const focus = (): DocxFocus | undefined => {
      const next = plan.next && model.block(plan.next.id);
      if (next && isEditable(next)) return { blockId: next.id, at: 'start' };
      const prev = plan.prev && model.block(plan.prev.id);
      if (prev && isEditable(prev)) return { blockId: prev.id, at: 'end' };
      return undefined;
    };
    return { changed: () => (target ? [target.block.id] : []), focus };
  });
}

// ---------------------------------------------------------------------------------------------------
// Entry point

/**
 * Apply one webview edit operation to `ctx.pkg`. See the file header: the returned edit is already
 * applied and the model already refreshed. Bad input is an `OfficeError`, not a throw; a throw
 * means the rollback of a failed operation itself failed.
 */
export function applyDocxEdit(ctx: DocxContext, op: DocxEditOp): OpOutcome {
  switch (op.op) {
    case 'commitParagraph':
      return run(ctx, LABELS.commit, (b) => {
        const o = commitParagraph(b, ctx.model, ctx.styles, op.blockId, op.items);
        if (!o.ok) return o.error;
        return { changed: () => (o.changed || o.reinsertedAtoms ? [op.blockId] : []) };
      });
    case 'splitParagraph': return splitOp(ctx, op);
    case 'mergeWithPrevious': return mergeOp(ctx, op);
    case 'insertParagraphAfter': return insertOp(ctx, op);
    case 'removeParagraph': return removeOp(ctx, op);
    case 'setStyle':
      return run(ctx, LABELS.style, (b) => setStyle(b, ctx, op.blockIds, op.style) ?? { changed: () => op.blockIds.slice() });
    case 'setList':
      return run(ctx, LABELS.list, (b) => setList(b, ctx, op.blockIds, op.list) ?? { changed: () => op.blockIds.slice() });
    case 'setListLevel':
      return run(ctx, LABELS.list, (b) => setListLevel(b, ctx, op.blockIds, op.delta) ?? { changed: () => op.blockIds.slice() });
    default:
      return { ok: false, error: err('invalid', 'Unknown edit operation.') };
  }
}
