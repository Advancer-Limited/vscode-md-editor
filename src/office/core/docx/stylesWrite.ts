// Styles and lists, write side (spec §8.6; plan WP-30, which fixes the exact markup created here).
//
// Contract with `applyDocxEdit` (ops.ts): each function records its changes into `b` and returns
// null, or returns an `OfficeError` (the caller then aborts the builder, so partial changes are
// rolled back). It never finishes or aborts `b` and never calls `model.refresh()` or the `reload()`
// of styles/numbering: the caller does all of that once, after finishing the builder. Until then
// `ctx.styles` / `ctx.numbering` describe the document as it was BEFORE the operation, which is why
// everything created during one call is tracked here (`NumberingPlan`, the `planned` map).
//
// What is written:
//   paragraph   only its `w:pPr` (replaced, inserted as the first child of `w:p`, or removed when
//               nothing is left in it). The `w:p` itself stays, so the block keeps its id. Only the
//               `w:pStyle` and/or `w:numPr` child differs; a paragraph already as requested is not
//               written at all.
//   styles      one `w:style` appended after the last element of `w:styles` when the heading or
//               List Paragraph style is missing. A missing or unreadable style sheet refuses.
//   numbering   `w:abstractNum` after the last existing one, `w:num` after the last existing one;
//               ids are max+1. A missing part is created with its relationship and Override; an
//               unreadable part, or a numbering relationship that leads nowhere, refuses (a second
//               relationship is never added).
//
// Every block id must name an editable paragraph, else the whole operation is refused (nothing is
// applied to "the ones that can be changed"). A `w:numPr` holding anything besides `w:ilvl` and
// `w:numId` (a tracked numbering change) is never rewritten: refused.
//
// Lists, beyond §8.6 (decisions):
//   - joining looks at the previous sibling block first, then at the first block after the run of
//     selected blocks that follows; always in the same container.
//   - a paragraph that is already an item of another kind of list keeps its level when its kind is
//     changed; one that was not in a list takes the level of the list it joins, else 0.
//     Either way a level the list does not define is never written (the item would show no
//     number): the level of the joined item is used instead.
//   - several selected blocks that end up next to each other share one list (one new `w:num`).
//   - indent/outdent does nothing when the list does not define the level it would move to (Word's
//     single-level lists define level 0 only).
//
// No `vscode` import here (core rule).

import type { OfficeError } from '../types.js';
import type { EditBuilder } from '../edits.js';
import { addOverride, addRelationship, readRelationships } from '../opc.js';
import type { XmlElement } from '../xml.js';
import { XmlError, XmlScopeError, attr, child, childrenOf, escapeAttr, qnameAt, serialize } from '../xml.js';
import type { Block, ParagraphProps } from './model.js';
import { NS_W, isEditable, paragraphProps } from './model.js';
import { upsertPPrChild } from './paragraphWriter.js';
import type { DocxContext } from './ops.js';

export type StyleChoice = 'normal' | { heading: 1 | 2 | 3 | 4 | 5 | 6 };
export type ListChoice = 'none' | 'bullet' | 'number';

export const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
export const CT_NUMBERING = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

export const NO_STYLE_SHEET = 'This document has no style sheet.';

// ---------------------------------------------------------------------------------------------------
// Refusals

class Refusal extends Error {
  readonly error: OfficeError;
  constructor(code: OfficeError['code'], message: string) {
    super(message);
    this.error = { code, message };
  }
}

const blocked = (message: string): Refusal => new Refusal('blocked', message);

/** Run `body`; a `Refusal` becomes the returned error. XML scope errors are left to the caller. */
function guarded(body: () => void): OfficeError | null {
  try {
    body();
    return null;
  } catch (e) {
    if (e instanceof Refusal) return e.error;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------
// Exact markup (plan WP-30)

const HEADING_SIZE = [32, 26, 24, 22, 22, 22];

/** The heading style this editor creates. `d` = default paragraph style id, or null. */
export function headingStyleXml(w: string, styleId: string, level: number, d: string | null): string {
  const def = d === null ? '' : escapeAttr(d);
  const based = d === null ? '' : `<${w}:basedOn ${w}:val="${def}"/><${w}:next ${w}:val="${def}"/>`;
  const size = HEADING_SIZE[level - 1];
  const italic = level === 4 || level === 6 ? `<${w}:i/><${w}:iCs/>` : '';
  return `<${w}:style ${w}:type="paragraph" ${w}:styleId="${escapeAttr(styleId)}"><${w}:name ${w}:val="heading ${level}"/>${based}`
    + `<${w}:uiPriority ${w}:val="9"/><${w}:qFormat/>`
    + `<${w}:pPr><${w}:keepNext/><${w}:keepLines/><${w}:spacing ${w}:before="${level === 1 ? 240 : 40}" ${w}:after="0"/><${w}:outlineLvl ${w}:val="${level - 1}"/></${w}:pPr>`
    + `<${w}:rPr><${w}:rFonts ${w}:asciiTheme="majorHAnsi" ${w}:eastAsiaTheme="majorEastAsia" ${w}:hAnsiTheme="majorHAnsi" ${w}:cstheme="majorBidi"/>${italic}`
    + `<${w}:sz ${w}:val="${size}"/><${w}:szCs ${w}:val="${size}"/></${w}:rPr></${w}:style>`;
}

/** The List Paragraph style this editor creates. */
export function listParagraphStyleXml(w: string, styleId: string, d: string | null): string {
  const based = d === null ? '' : `<${w}:basedOn ${w}:val="${escapeAttr(d)}"/>`;
  return `<${w}:style ${w}:type="paragraph" ${w}:styleId="${escapeAttr(styleId)}"><${w}:name ${w}:val="List Paragraph"/>${based}`
    + `<${w}:uiPriority ${w}:val="34"/><${w}:qFormat/><${w}:pPr><${w}:ind ${w}:left="720"/><${w}:contextualSpacing/></${w}:pPr></${w}:style>`;
}

const BULLETS: readonly (readonly [string, string])[] = [['', 'Symbol'], ['o', 'Courier New'], ['', 'Wingdings']];
const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];

/** This editor's own list definition for `kind` (nine levels), named VSMDBullet / VSMDNumber. */
export function abstractNumXml(w: string, abstractNumId: number, kind: 'bullet' | 'number'): string {
  let levels = '';
  for (let k = 0; k < 9; k++) {
    const ind = `<${w}:lvlJc ${w}:val="left"/><${w}:pPr><${w}:ind ${w}:left="${720 * (k + 1)}" ${w}:hanging="360"/></${w}:pPr>`;
    if (kind === 'bullet') {
      const [glyph, font] = BULLETS[k % 3];
      levels += `<${w}:lvl ${w}:ilvl="${k}"><${w}:start ${w}:val="1"/><${w}:numFmt ${w}:val="bullet"/><${w}:lvlText ${w}:val="${glyph}"/>${ind}`
        + `<${w}:rPr><${w}:rFonts ${w}:ascii="${font}" ${w}:hAnsi="${font}" ${w}:hint="default"/></${w}:rPr></${w}:lvl>`;
    } else {
      levels += `<${w}:lvl ${w}:ilvl="${k}"><${w}:start ${w}:val="1"/><${w}:numFmt ${w}:val="${NUMBER_FORMATS[k % 3]}"/><${w}:lvlText ${w}:val="%${k + 1}."/>${ind}</${w}:lvl>`;
    }
  }
  const name = kind === 'bullet' ? 'VSMDBullet' : 'VSMDNumber';
  return `<${w}:abstractNum ${w}:abstractNumId="${abstractNumId}"><${w}:multiLevelType ${w}:val="hybridMultilevel"/><${w}:name ${w}:val="${name}"/>${levels}</${w}:abstractNum>`;
}

/** A `w:num` on `abstractNumId`; `restart` adds the override that makes the list start at 1. */
export function numXml(w: string, numId: number, abstractNumId: number, restart: boolean): string {
  const override = restart ? `<${w}:lvlOverride ${w}:ilvl="0"><${w}:startOverride ${w}:val="1"/></${w}:lvlOverride>` : '';
  return `<${w}:num ${w}:numId="${numId}"><${w}:abstractNumId ${w}:val="${abstractNumId}"/>${override}</${w}:num>`;
}

const numPrXml = (w: string, numId: number, ilvl: number): string =>
  `<${w}:numPr><${w}:ilvl ${w}:val="${ilvl}"/><${w}:numId ${w}:val="${numId}"/></${w}:numPr>`;

// ---------------------------------------------------------------------------------------------------
// Shared helpers

/** The prefix bound to the WordprocessingML namespace at `el`; refuses when it is the default namespace or unbound. */
function wPrefixAt(el: XmlElement): string {
  const q = qnameAt(el, NS_W, 'x');
  const colon = q ? q.indexOf(':') : -1;
  if (!q || colon <= 0) throw blocked("This document uses an XML layout this editor can't write styles or lists into.");
  return q.slice(0, colon);
}

/** Index just after the last element child of `parent` (its end when it has none). */
function afterLastElement(parent: XmlElement): number {
  for (let k = parent.children.length - 1; k >= 0; k--) if (parent.children[k].type === 'el') return k + 1;
  return parent.children.length;
}

/** Index just after the last `w:<local>` child (any of `locals`), or -1. */
function afterLastOf(parent: XmlElement, locals: readonly string[]): number {
  for (let k = parent.children.length - 1; k >= 0; k--) {
    const c = parent.children[k];
    if (c.type === 'el' && c.ns === NS_W && locals.includes(c.local)) return k + 1;
  }
  return -1;
}

interface Target { block: Block; props: ParagraphProps; }

/** The blocks to change, in document order, each once. Refuses unless all are editable paragraphs. */
function targetsOf(ctx: DocxContext, blockIds: number[]): Target[] {
  if (!Array.isArray(blockIds) || blockIds.length === 0 || blockIds.some((id) => typeof id !== 'number')) {
    throw new Refusal('invalid', 'The edit is malformed.');
  }
  const { model } = ctx;
  const wanted = new Set(blockIds);
  for (const id of wanted) {
    const block = model.block(id);
    if (!block) throw new Refusal('stale', 'This paragraph no longer exists. Try again.');
    if (block.kind !== 'paragraph' || !isEditable(block)) {
      throw blocked(wanted.size > 1 ? "The selection contains content that can't be edited here." : "This content can't be edited here. It is preserved as is.");
    }
  }
  const out: Target[] = [];
  for (const block of model.blocks()) if (wanted.has(block.id)) out.push({ block, props: paragraphProps(block.el) });
  return out;
}

const pPrXmlOf = (props: ParagraphProps): string => (props.pPr ? serialize(props.pPr) : '');

/** `upsertPPrChild` on '' = no `w:pPr`; a `w:pPr` it cannot rewrite refuses the operation. */
function withPPrChild(ctx: DocxContext, pPrXml: string, local: string, xml: string | null): string {
  try {
    return upsertPPrChild(pPrXml === '' ? null : pPrXml, local, xml, ctx.pkg.xml(ctx.model.mainPart));
  } catch (e) {
    if (e instanceof XmlScopeError || e instanceof XmlError) throw e;
    throw blocked(`This paragraph's properties can't be rewritten here (${e instanceof Error ? e.message : String(e)}).`);
  }
}

/** Put `pPrXml` ('' = none) in place of the paragraph's `w:pPr`. */
function writePPr(b: EditBuilder, ctx: DocxContext, t: Target, pPrXml: string): void {
  const main = ctx.model.mainPart;
  const { pPr } = t.props;
  if (pPr) {
    if (pPrXml === '') b.removeNode(main, pPr);
    else b.replaceNode(main, pPr, pPrXml);
  } else if (pPrXml !== '') {
    b.insertAt(main, t.block.el, 0, pPrXml);          // w:pPr is the first child of w:p
  }
}

const pStyleXml = (ctx: DocxContext, id: string): string => `<${ctx.model.wPrefix}:pStyle ${ctx.model.wPrefix}:val="${escapeAttr(id)}"/>`;

/** The style sheet's root, or a refusal: a style sheet is never created here. */
function styleSheetRoot(ctx: DocxContext): { part: string; root: XmlElement } {
  const part = ctx.styles.part;
  if (!part) throw blocked(NO_STYLE_SHEET);
  if (ctx.styles.damaged) throw blocked("This document's style sheet can't be read, so styles and lists can't be changed here.");
  return { part, root: ctx.pkg.xml(part).root };
}

/** Append a style made by `make(prefix, styleId)`; the id is `base`, or `base_2`, `base_3`… when taken. */
function appendStyle(b: EditBuilder, ctx: DocxContext, base: string, make: (w: string, styleId: string) => string): string {
  const { part, root } = styleSheetRoot(ctx);
  const w = wPrefixAt(root);
  const taken = new Set<string>();
  for (const s of childrenOf(root, NS_W, 'style')) {
    const id = attr(s, NS_W, 'styleId');
    if (id !== undefined) taken.add(id.toLowerCase());
  }
  let id = base;
  for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}_${n}`;
  b.insertAt(part, root, afterLastElement(root), make(w, id));
  return id;
}

/** Direct `w:numPr` that holds only `w:ilvl` / `w:numId` (or none at all); anything else is not rewritten. */
function checkPlainNumPr(props: ParagraphProps): XmlElement | null {
  const numPr = props.pPr ? child(props.pPr, NS_W, 'numPr') ?? null : null;
  if (!numPr) return null;
  for (const c of numPr.children) {
    if (c.type === 'el' && !(c.ns === NS_W && (c.local === 'ilvl' || c.local === 'numId'))) {
      throw blocked("This paragraph's numbering has a tracked change and can't be changed here.");
    }
  }
  return numPr;
}

const clampLevel = (n: number): number => (Number.isInteger(n) ? Math.max(0, Math.min(8, n)) : 0);

/** Effective numbering of a paragraph: direct `w:numPr`, else its style's. numId 0 = explicitly none. */
function effectiveNumPr(ctx: DocxContext, props: ParagraphProps): { numId: number; ilvl: number } | null {
  const np = props.numPr ?? ctx.styles.styleNumPr(props.pStyleId);
  return np && np.numId > 0 ? { numId: np.numId, ilvl: clampLevel(np.ilvl) } : null;
}

/** Whether list `numId` defines level `ilvl` (in a `w:lvlOverride/w:lvl`, else in its `w:abstractNum`). */
function levelDefined(ctx: DocxContext, numId: number, ilvl: number): boolean {
  const part = ctx.numbering.part;
  if (!part || ctx.numbering.damaged) return false;
  const root = ctx.pkg.xml(part).root;
  const val = (el: XmlElement | undefined, local: string): string | undefined => (el ? attr(el, NS_W, local)?.trim() : undefined);
  const num = childrenOf(root, NS_W, 'num').find((n) => val(n, 'numId') === String(numId));
  if (!num) return false;
  const hasLevel = (lvl: XmlElement): boolean => val(lvl, 'ilvl') === String(ilvl);
  if (childrenOf(num, NS_W, 'lvlOverride').some((o) => hasLevel(o) && child(o, NS_W, 'lvl') !== undefined)) return true;
  const absId = val(child(num, NS_W, 'abstractNumId'), 'val');
  const abs = absId === undefined ? undefined : childrenOf(root, NS_W, 'abstractNum').find((a) => val(a, 'abstractNumId') === absId);
  return abs !== undefined && childrenOf(abs, NS_W, 'lvl').some(hasLevel);
}

// ---------------------------------------------------------------------------------------------------
// Styles

export function setStyle(b: EditBuilder, ctx: DocxContext, blockIds: number[], style: StyleChoice): OfficeError | null {
  return guarded(() => {
    const targets = targetsOf(ctx, blockIds);
    const { styles } = ctx;
    if (style === 'normal') {
      const def = styles.defaultParagraphStyleId();
      for (const t of targets) {
        if (t.props.pStyleId === null || t.props.pStyleId === def) continue;        // already Normal
        writePPr(b, ctx, t, withPPrChild(ctx, pPrXmlOf(t.props), 'pStyle', null));
      }
      return;
    }
    const level = typeof style === 'object' && style !== null ? style.heading : NaN;
    if (!Number.isInteger(level) || level < 1 || level > 6) throw new Refusal('invalid', 'The edit is malformed.');
    styleSheetRoot(ctx);
    let id = styles.headingStyleId(level);
    for (const t of targets) {
      if (id !== null && t.props.pStyleId === id) continue;
      // Word writes only the styles in use, so the heading may not be defined yet.
      id ??= appendStyle(b, ctx, `Heading${level}`, (w, sid) => headingStyleXml(w, sid, level, styles.defaultParagraphStyleId()));
      writePPr(b, ctx, t, withPPrChild(ctx, pPrXmlOf(t.props), 'pStyle', pStyleXml(ctx, id)));
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Numbering definitions

/**
 * The definitions one `setList` call needs. Ids are handed out while paragraphs are planned and
 * the markup is written once, by `flush`, so a new part is created in one piece.
 */
class NumberingPlan {
  private readonly ctx: DocxContext;
  private readonly root: XmlElement | null;
  private readonly w: string;
  private nextAbstract: number;
  private nextNum: number;
  private readonly abstracts: string[] = [];
  private readonly nums: string[] = [];
  private readonly own: { bullet?: number; number?: number } = {};
  private bulletNum: number | undefined;

  constructor(ctx: DocxContext) {
    this.ctx = ctx;
    const { numbering } = ctx;
    if (numbering.damaged) throw blocked("This document's list definitions can't be read, so lists can't be changed here.");
    this.root = numbering.part ? ctx.pkg.xml(numbering.part).root : null;
    if (!this.root) this.newPartName();          // refuse before anything is written
    this.w = this.root ? wPrefixAt(this.root) : 'w';
    this.nextAbstract = numbering.maxAbstractNumId() + 1;
    this.nextNum = numbering.maxNumId() + 1;
  }

  private abstractFor(kind: 'bullet' | 'number'): { id: number; existed: boolean } {
    const known = this.own[kind];
    if (known !== undefined) return { id: known, existed: false };
    const found = this.ctx.numbering.findOwnAbstract(kind);
    if (found !== null) {
      this.own[kind] = found;
      return { id: found, existed: true };
    }
    const id = this.nextAbstract++;
    this.abstracts.push(abstractNumXml(this.w, id, kind));
    this.own[kind] = id;
    return { id, existed: false };
  }

  /** The one `w:num` all of this editor's bullets share. */
  bullet(): number {
    if (this.bulletNum !== undefined) return this.bulletNum;
    const abs = this.abstractFor('bullet');
    if (abs.existed && this.root) {
      for (const n of childrenOf(this.root, NS_W, 'num')) {
        const ref = child(n, NS_W, 'abstractNumId');
        const numId = Number(attr(n, NS_W, 'numId'));
        if (ref && Number(attr(ref, NS_W, 'val')) === abs.id && Number.isInteger(numId) && numId > 0 && !child(n, NS_W, 'lvlOverride')) {
          return (this.bulletNum = numId);
        }
      }
    }
    const id = this.nextNum++;
    this.nums.push(numXml(this.w, id, abs.id, false));
    return (this.bulletNum = id);
  }

  /** A new numbered list: its own `w:num`, restarting at 1. */
  newNumbered(): number {
    const abs = this.abstractFor('number');
    const id = this.nextNum++;
    this.nums.push(numXml(this.w, id, abs.id, true));
    return id;
  }

  flush(b: EditBuilder): void {
    if (this.abstracts.length === 0 && this.nums.length === 0) return;
    const { ctx, root } = this;
    if (root) {
      const part = ctx.numbering.part!;
      if (this.abstracts.length > 0) {
        // After the last definition; with none yet, first, but after any picture bullets.
        let at = afterLastOf(root, ['abstractNum']);
        if (at < 0) at = Math.max(afterLastOf(root, ['numPicBullet']), 0);
        b.insertAt(part, root, at, this.abstracts.join(''));
      }
      if (this.nums.length > 0) {
        // After the last w:num; with none yet, after every definition (so before w:numIdMacAtCleanup).
        let at = afterLastOf(root, ['num']);
        if (at < 0) at = afterLastOf(root, ['abstractNum', 'numPicBullet']);
        if (at < 0) at = 0;
        b.insertAt(part, root, at, this.nums.join(''));
      }
      return;
    }
    this.createPart(b);
  }

  /** Name of the numbering part to create; refuses when one cannot be added cleanly. */
  private newPartName(): string {
    const { pkg, model } = this.ctx;
    const main = model.mainPart;
    const dangling = "This document's list definitions are missing or damaged, so lists can't be added here.";
    let rels;
    try { rels = readRelationships(pkg, main); } catch { throw blocked(dangling); }
    // A numbering relationship that leads nowhere: adding a second one would not make the file valid.
    if (rels.some((r) => r.type.endsWith('/relationships/numbering'))) throw blocked(dangling);
    const slash = main.lastIndexOf('/');
    const part = main.slice(0, slash + 1) + 'numbering.xml';
    if (pkg.has(part)) throw blocked(dangling);
    return part;
  }

  /** `numbering.xml` beside the main part, with its relationship and content type. */
  private createPart(b: EditBuilder): void {
    const main = this.ctx.model.mainPart;
    const part = this.newPartName();
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + `<w:numbering xmlns:w="${NS_W}">${this.abstracts.join('')}${this.nums.join('')}</w:numbering>`;
    b.setPart(part, new TextEncoder().encode(xml));
    addRelationship(b, main, REL_NUMBERING, 'numbering.xml');
    addOverride(b, part, CT_NUMBERING);
  }
}

// ---------------------------------------------------------------------------------------------------
// Lists

function listOff(b: EditBuilder, ctx: DocxContext, targets: Target[]): void {
  const { styles } = ctx;
  const w = ctx.model.wPrefix;
  const listParagraph = styles.listParagraphStyleId();
  for (const t of targets) {
    const { props } = t;
    const numPr = checkPlainNumPr(props);
    const dropStyle = props.pStyleId !== null && props.pStyleId === listParagraph;
    // Numbering that comes from the (remaining) style can only be switched off, not removed.
    const inherited = styles.styleNumPr(dropStyle ? null : props.pStyleId) !== null;
    const done = inherited ? props.numPr !== null && props.numPr.numId === 0 : numPr === null;
    if (!dropStyle && done) continue;
    let pPr = pPrXmlOf(props);
    if (dropStyle) pPr = withPPrChild(ctx, pPr, 'pStyle', null);
    if (!done) pPr = withPPrChild(ctx, pPr, 'numPr', inherited ? `<${w}:numPr><${w}:numId ${w}:val="0"/></${w}:numPr>` : null);
    writePPr(b, ctx, t, pPr);
  }
}

function listOn(b: EditBuilder, ctx: DocxContext, targets: Target[], kind: 'bullet' | 'number'): void {
  const { model, styles, numbering } = ctx;
  const w = model.wPrefix;
  const selected = new Set(targets.map((t) => t.block.id));
  /** What this call has decided for a block it changes. */
  const planned = new Map<number, { numId: number; ilvl: number }>();
  /** The list of `kind` that block `n` is (or will be) an item of. */
  const itemOf = (n: Block | null): { numId: number; ilvl: number } | null => {
    if (!n || n.kind !== 'paragraph') return null;
    const p = planned.get(n.id);
    if (p) return p;
    const np = effectiveNumPr(ctx, paragraphProps(n.el));
    return np && numbering.listInfo(np.numId, np.ilvl).kind === kind ? np : null;
  };
  /** Lists handed out by `plan` in this call (they may not be in numbering.xml yet). */
  const own = new Set<number>();
  let plan: NumberingPlan | null = null;
  let listParagraph: string | null = null;

  for (const t of targets) {
    const { props, block } = t;
    const eff = effectiveNumPr(ctx, props);
    const cur = eff ? numbering.listInfo(eff.numId, eff.ilvl) : { kind: 'none' as const, level: 0 };
    if (cur.kind === kind) continue;
    if (plan === null) {
      styleSheetRoot(ctx);                       // refuse before anything is written
      plan = new NumberingPlan(ctx);
    }
    checkPlainNumPr(props);
    // Join the list before this paragraph, else the one after the selected paragraphs that follow it.
    const { prev, next } = model.siblings(block);
    let join = itemOf(prev);
    if (!join) {
      let n = next;
      while (n && n.kind === 'paragraph' && selected.has(n.id) && !itemOf(n)) n = model.siblings(n).next;
      join = itemOf(n);
    }
    const numId = join ? join.numId : kind === 'bullet' ? plan.bullet() : plan.newNumbered();
    if (!join) own.add(numId);
    // This editor's own definitions have all nine levels; a joined list may not.
    let ilvl = cur.kind !== 'none' ? cur.level : join ? join.ilvl : 0;
    if (join && ilvl !== join.ilvl && !own.has(numId) && !levelDefined(ctx, numId, ilvl)) ilvl = join.ilvl;
    planned.set(block.id, { numId, ilvl });

    let pPr = pPrXmlOf(props);
    if (props.pStyleId === null) {
      listParagraph ??= styles.listParagraphStyleId()
        ?? appendStyle(b, ctx, 'ListParagraph', (sw, sid) => listParagraphStyleXml(sw, sid, styles.defaultParagraphStyleId()));
      pPr = withPPrChild(ctx, pPr, 'pStyle', pStyleXml(ctx, listParagraph));
    }
    writePPr(b, ctx, t, withPPrChild(ctx, pPr, 'numPr', numPrXml(w, numId, ilvl)));
  }
  plan?.flush(b);
}

export function setList(b: EditBuilder, ctx: DocxContext, blockIds: number[], list: ListChoice): OfficeError | null {
  return guarded(() => {
    const targets = targetsOf(ctx, blockIds);
    if (list === 'none') listOff(b, ctx, targets);
    else if (list === 'bullet' || list === 'number') listOn(b, ctx, targets, list);
    else throw new Refusal('invalid', 'The edit is malformed.');
  });
}

/** Indent (+1) or outdent (-1) list items, within levels 0–8. A paragraph that is not in a list is left alone. */
export function setListLevel(b: EditBuilder, ctx: DocxContext, blockIds: number[], delta: 1 | -1): OfficeError | null {
  return guarded(() => {
    const targets = targetsOf(ctx, blockIds);
    if (delta !== 1 && delta !== -1) throw new Refusal('invalid', 'The edit is malformed.');
    const w = ctx.model.wPrefix;
    for (const t of targets) {
      const eff = effectiveNumPr(ctx, t.props);
      if (!eff || ctx.numbering.listInfo(eff.numId, eff.ilvl).kind === 'none') continue;
      const level = clampLevel(eff.ilvl + delta);
      const raw = t.props.numPr ? t.props.numPr.ilvl : eff.ilvl;
      if (level === raw || !levelDefined(ctx, eff.numId, level)) continue;
      checkPlainNumPr(t.props);
      writePPr(b, ctx, t, withPPrChild(ctx, pPrXmlOf(t.props), 'numPr', numPrXml(w, eff.numId, level)));
    }
  });
}
