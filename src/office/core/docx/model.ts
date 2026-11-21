// Docx block and segment model (spec §8.1, §8.3, §10.2; plan WP-25).
//
// Read-only view over the lossless tree of the main document part. It decides what the editor may
// touch: which paragraphs are editable, and how an editable paragraph's children split into text
// segments, atoms, anchors and disposable nodes. Everything it does not recognise locks the
// paragraph (allow-list, never a guess); the model itself never changes the tree.
//
// Containers and blocks (§8.1): `w:body` and every `w:tc` reached through body → `w:tbl` → `w:tr`
// → `w:tc` (direct children only, recursively) are containers; each element child of a container
// is a block (`w:tcPr` excepted: it is the cell's properties, not content). A `w:p` is a paragraph
// block, everything else is opaque. Rows or cells wrapped in `w:sdt` / `w:customXml` are not
// descended into.
//
// Ids: one counter for blocks and segments, held per node in a WeakMap, never reused. A block's id
// is keyed on its element; a text segment's on its first piece, an atom's on its first node, an
// anchor's on its node. A node that survives an edit keeps its id (EditBuilder keeps detached nodes,
// so undo/redo normally bring the very same node, and id, back). A writer that replaces a node with
// a new one standing for the same thing calls `carryId(from, to)` before `refresh()`.
//
// Complex fields are tracked in document order across the whole story (body, cells, and the content
// of blocks that are not descended into), so a field that begins in one paragraph and ends in
// another locks every paragraph it touches wherever those paragraphs sit.
//
// No `vscode` import here (core rule).

import type { DocxBlockInfo, DocxSegment } from '../../protocol.js';
import type { ReadOnlyReason } from '../types.js';
import { LIMITS } from '../limits.js';
import type { OfficePackage } from '../package.js';
import type { XmlDoc, XmlElement, XmlNode } from '../xml.js';
import { XmlError, attr, child, serialize, textContent } from '../xml.js';
import { mainPart } from '../opc.js';
import { OfficeLoadError } from '../sniff.js';

export const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const XMLNS_PREFIX = 'xmlns:';

export type LockReason = NonNullable<DocxBlockInfo['lockReason']>;
export type AtomType = Extract<DocxSegment, { kind: 'atom' }>['atomType'];

export interface Container {
  /** `w:body` or a `w:tc`. */
  readonly el: XmlElement;
  /** Id of the table block that directly holds this cell; null for the body. */
  readonly tableBlockId: number | null;
  /** 0-based ordinal of the `w:tr` among the table's direct `w:tr` children; -1 for the body. */
  readonly row: number;
  /** 0-based ordinal of the `w:tc` among the row's direct `w:tc` children (not a grid column); -1 for the body. */
  readonly col: number;
  /** The container holding the table block; null for the body. */
  readonly parent: Container | null;
  /**
   * Lock every paragraph of this container carries (and every container nested in it inherits):
   * `merged-cell` for a vMerge/hMerge continuation cell, `tracked-changes` for table-level revision
   * marks (§8.1). `merged-cell` wins when both apply (such paragraphs never get render markers).
   */
  readonly lockReason: 'merged-cell' | 'tracked-changes' | null;
}

export interface Block {
  readonly id: number;
  readonly el: XmlElement;
  /** `paragraph` = a `w:p`; `opaque` = anything else (table, sdt, sectPr, range markers, unknown). */
  readonly kind: 'paragraph' | 'opaque';
  readonly container: Container;
  /** An opaque block that is a `w:tbl` (a container host). */
  readonly isTable: boolean;
  /** Set when the block is not editable. Opaque blocks always carry `opaque`. */
  lockReason?: LockReason;
}

export type Segment =
  /**
   * Text of consecutive `w:t` / `w:tab` (`\t`) / plain `w:br` (`\n`) / `w:noBreakHyphen` (U+2011) /
   * `w:softHyphen` (U+00AD) children of one run. `pieces` are those children, in order; `rPr` is the
   * run's `w:rPr` (shared by every segment of the run). `wholeRun`: the run's element children other
   * than `w:rPr` are exactly `pieces`, so the run's source slice stands for this segment alone.
   */
  | { kind: 'text'; id: number; text: string; run: XmlElement; rPr: XmlElement | null; pieces: XmlElement[]; wholeRun: boolean }
  /**
   * Read-only content that must be re-emitted verbatim. `run === null`: `nodes` are consecutive
   * children of the paragraph (a whole run, a wrapper such as `w:hyperlink`, or every node from a
   * complex field's begin run to its end run). `run !== null`: `nodes` is one child of that run,
   * which also holds other segments; re-emit it inside a `w:r` carrying a copy of `rPr`.
   */
  | { kind: 'atom'; id: number; atomType: AtomType; label: string; nodes: XmlNode[]; run: XmlElement | null; rPr: XmlElement | null }
  /**
   * Zero-width marker, a child of the paragraph: a range start/end, or a run holding only a
   * `w:commentReference` (then `pairKey` is the comment's and `role` is absent). `pairKey` is
   * `bookmark:<id>`, `comment:<id>`, `perm:<id>`, `moveFrom:<id>` or `moveTo:<id>`; absent when the
   * marker has no `w:id`. The matching marker may be in another paragraph or outside any.
   */
  | { kind: 'anchor'; id: number; node: XmlNode; pairKey?: string; role?: 'start' | 'end' }
  /**
   * Droppable from an edited paragraph: `w:proofErr`, whitespace between elements, a run with no
   * content (children of the paragraph), or a `w:lastRenderedPageBreak` (child of a run).
   */
  | { kind: 'disposable'; nodes: XmlNode[] };

/** What a paragraph's `w:pPr` says, read directly (no style inheritance: that is `DocxStyles`). */
export interface ParagraphProps {
  pPr: XmlElement | null;
  /** `w:pPr/w:pStyle/@w:val`. */
  pStyleId: string | null;
  /** Direct `w:pPr/w:numPr`; a missing or malformed `w:ilvl` reads as 0, a missing/malformed `w:numId` as null. */
  numPr: { numId: number; ilvl: number } | null;
  /** `w:pPr/w:sectPr` present: the paragraph ends a section. */
  hasSectPr: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Small helpers

const WS_ONLY = /^[ \t\r\n]*$/;
const RAW_CONTROL_WS = /[\t\r\n]/;
const LABEL_MAX = 120;

function isW(n: XmlNode | undefined, local: string): n is XmlElement {
  return n !== undefined && n.type === 'el' && n.local === local && n.ns === NS_W;
}

function isWsText(n: XmlNode): boolean {
  return n.type === 'text' && WS_ONLY.test(n.raw);
}

function clip(s: string): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > LABEL_MAX ? c.slice(0, LABEL_MAX - 1) + '\u2026' : c;
}

/** Revision markup: any of these (WordprocessingML namespace) below a paragraph locks it (§8.3). */
const REVISION_ELEMENTS = new Set([
  'ins', 'del', 'moveFrom', 'moveTo', 'delText', 'delInstrText',
  'rPrChange', 'pPrChange', 'sectPrChange', 'numberingChange',
  'tblPrChange', 'tblGridChange', 'trPrChange', 'tcPrChange', 'tblPrExChange',
  'cellIns', 'cellDel', 'cellMerge',
  'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
  'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd', 'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd',
]);

/** True when `el` or a descendant satisfies `test` (iterative: depth is bounded only by the parser cap). */
function someDescendant(el: XmlElement, test: (e: XmlElement) => boolean): boolean {
  const stack: XmlNode[] = [el];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'el') continue;
    if (test(n)) return true;
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return false;
}

const isRevision = (e: XmlElement): boolean => e.ns === NS_W && REVISION_ELEMENTS.has(e.local);
const isChangeMark = (e: XmlElement): boolean => e.ns === NS_W && e.local.endsWith('Change');
const isFldChar = (e: XmlElement): boolean => e.ns === NS_W && e.local === 'fldChar';

// ---------------------------------------------------------------------------------------------------
// Complex-field tracking

interface FieldTracker {
  /** Open complex fields at this point of the story. */
  depth: number;
  /** Lowest depth reached since the caller last reset it (may be -1: an end with no begin). */
  min: number;
  /** A `w:fldChar` that makes no sense here: unknown type, `separate` or `end` outside any field. */
  bad: boolean;
  /** Field structure can no longer be followed (fldChar inside non-run `mc:AlternateContent`). Sticky. */
  poisoned: boolean;
}

function applyFldChar(fc: XmlElement, t: FieldTracker): void {
  switch (attr(fc, NS_W, 'fldCharType')) {
    case 'begin':
      t.depth++;
      break;
    case 'separate':
      if (t.depth === 0) t.bad = true;
      break;
    case 'end':
      t.depth--;
      if (t.depth < t.min) t.min = t.depth;
      if (t.depth < 0) { t.depth = 0; t.bad = true; }
      break;
    default:
      t.bad = true;
  }
}

/**
 * Visit, in document order, the runs of the story `node` belongs to that lie at or below `node`.
 * A run's own content is not entered (text boxes inside `w:drawing` / `w:pict` are separate
 * stories), and neither is `mc:AlternateContent` outside a run (its branches are alternatives, not
 * a sequence): `onAlternate` is called for it instead.
 */
function storyRuns(node: XmlNode, onRun: (run: XmlElement) => void, onAlternate?: (el: XmlElement) => void): void {
  const stack: XmlNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'el') continue;
    if (n.ns === NS_W && n.local === 'r') { onRun(n); continue; }
    if (n.ns === NS_MC && n.local === 'AlternateContent') { onAlternate?.(n); continue; }
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
}

/** Apply every story-level `w:fldChar` at or below `node` to `t`. */
function trackStory(node: XmlNode, t: FieldTracker): void {
  storyRuns(node, (run) => {
    for (const c of run.children) if (c.type === 'el' && isFldChar(c)) applyFldChar(c, t);
  }, (alt) => {
    if (someDescendant(alt, isFldChar)) t.poisoned = true;
  });
}

/** Visible text of the runs at or below `nodes` (`w:t`; tabs and breaks read as a space). */
function storyText(nodes: readonly XmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    storyRuns(node, (run) => {
      for (const c of run.children) {
        if (c.type !== 'el' || c.ns !== NS_W) continue;
        if (c.local === 't') out += textContent(c);
        else if (c.local === 'tab' || c.local === 'br' || c.local === 'cr') out += ' ';
        else if (c.local === 'noBreakHyphen') out += '\u2011';
      }
    });
  }
  return out;
}

/** First word of a field instruction (`PAGE`, `REF`, ...), or ''. */
function instructionName(instr: string): string {
  const m = /^\s*([^\s\\"]+)/.exec(instr);
  return m ? m[1] : '';
}

/**
 * Label of a complex field given every node from its begin run to its end run: its result text
 * (what follows `separate`, including the results of fields nested in the result), else the
 * instruction's first word, else "Field".
 */
function fieldLabel(nodes: readonly XmlNode[]): string {
  const inResult: boolean[] = [];   // one entry per open field: has its `separate` been seen
  let result = '';
  let instr = '';
  for (const node of nodes) {
    storyRuns(node, (run) => {
      for (const c of run.children) {
        if (c.type !== 'el' || c.ns !== NS_W) continue;
        if (c.local === 'fldChar') {
          const type = attr(c, NS_W, 'fldCharType');
          if (type === 'begin') inResult.push(false);
          else if (type === 'separate') { if (inResult.length) inResult[inResult.length - 1] = true; }
          else if (type === 'end') inResult.pop();
        } else if (inResult.length && inResult.every(Boolean)) {
          if (c.local === 't') result += textContent(c);
          else if (c.local === 'tab' || c.local === 'br' || c.local === 'cr') result += ' ';
          else if (c.local === 'noBreakHyphen') result += '\u2011';
        } else if (inResult.length === 1 && c.local === 'instrText') {
          instr += textContent(c);
        }
      }
    });
  }
  return clip(result) || instructionName(instr) || 'Field';
}

/** Alt text or name of a `w:drawing`'s `wp:docPr`, else "Picture". */
function drawingLabel(drawing: XmlElement): string {
  let label = '';
  someDescendant(drawing, (e) => {
    if (e.local !== 'docPr') return false;
    label = clip(attr(e, '', 'descr') || attr(e, '', 'title') || attr(e, '', 'name') || '');
    return true;
  });
  return label || 'Picture';
}

// ---------------------------------------------------------------------------------------------------
// Paragraph classification (§8.3 allow-list)

type IdOf = (node: XmlNode) => number;

type RunItem =
  | { k: 'text'; piece: XmlElement; s: string }
  | { k: 'atom'; el: XmlElement; atomType: AtomType; label: string }
  | { k: 'disposable'; el: XmlElement };

const ANCHOR_MARKS: Readonly<Record<string, readonly [family: string, role: 'start' | 'end']>> = {
  bookmarkStart: ['bookmark', 'start'], bookmarkEnd: ['bookmark', 'end'],
  commentRangeStart: ['comment', 'start'], commentRangeEnd: ['comment', 'end'],
  permStart: ['perm', 'start'], permEnd: ['perm', 'end'],
  moveFromRangeStart: ['moveFrom', 'start'], moveFromRangeEnd: ['moveFrom', 'end'],
  moveToRangeStart: ['moveTo', 'start'], moveToRangeEnd: ['moveTo', 'end'],
};

class ParagraphClassifier {
  readonly segs: Segment[] = [];
  /** Nodes of the complex field being collected (from its begin run), or null outside a field. */
  private field: XmlNode[] | null = null;
  private depth = 0;

  constructor(private readonly idOf: IdOf) {}

  /** Classify `p`. Returns the lock reason when something is not on the allow-list, else null. */
  classify(p: XmlElement): LockReason | null {
    let sawPPr = false;
    let sawContent = false;
    for (const n of p.children) {
      if (this.field) {
        const lock = this.insideField(n);
        if (lock) return lock;
        continue;
      }
      if (n.type !== 'el') {
        // Whitespace between elements (pretty-printed producers) carries nothing. Any other
        // character data, a comment or a processing instruction is not something this editor may
        // re-order or drop.
        if (!isWsText(n)) return 'unknown-content';
        this.segs.push({ kind: 'disposable', nodes: [n] });
        continue;
      }
      if (isW(n, 'pPr')) {
        // The schema puts w:pPr first and at most once; the writer relies on that.
        if (sawPPr || sawContent) return 'unknown-content';
        sawPPr = true;
        continue;
      }
      sawContent = true;
      const lock = this.paragraphChild(n);
      if (lock) return lock;
    }
    // A field still open at the end begins here and ends in a later paragraph.
    return this.field ? 'multi-paragraph-field' : null;
  }

  private atom(atomType: AtomType, label: string, nodes: XmlNode[]): void {
    this.segs.push({ kind: 'atom', id: this.idOf(nodes[0]), atomType, label, nodes, run: null, rPr: null });
  }

  /** A paragraph child met while a complex field is open: it belongs to the field, whatever it is. */
  private insideField(n: XmlNode): LockReason | null {
    const field = this.field!;
    field.push(n);
    if (n.type !== 'el') return null;
    if (isW(n, 'r')) {
      let closed = false;
      for (const c of n.children) {
        if (c.type !== 'el') continue;
        // Content after the field's end in the same run would be outside the field but inside the
        // atom's nodes: the run cannot be split without rewriting it.
        if (closed) return 'unknown-content';
        if (!isFldChar(c)) continue;
        switch (attr(c, NS_W, 'fldCharType')) {
          case 'begin': this.depth++; break;
          case 'separate': break;
          case 'end': this.depth--; if (this.depth === 0) closed = true; break;
          default: return 'unknown-content';
        }
      }
    } else {
      // A wrapper (hyperlink, sdt, ...) inside the field. Fields nested wholly inside it are fine; the
      // outer field ending inside it is not (the atom would end mid-element).
      const t: FieldTracker = { depth: this.depth, min: this.depth, bad: false, poisoned: false };
      trackStory(n, t);
      if (t.bad || t.poisoned || t.min < 1) return 'unknown-content';
      this.depth = t.depth;
    }
    if (this.depth === 0) {
      this.field = null;
      this.atom('field', fieldLabel(field), field);
    }
    return null;
  }

  /** An element child of the paragraph outside any complex field (`w:pPr` already handled). */
  private paragraphChild(n: XmlElement): LockReason | null {
    if (n.ns === NS_W) {
      const mark = Object.prototype.hasOwnProperty.call(ANCHOR_MARKS, n.local) ? ANCHOR_MARKS[n.local] : undefined;
      if (mark) {
        const id = attr(n, NS_W, 'id');
        const seg: Extract<Segment, { kind: 'anchor' }> = { kind: 'anchor', id: this.idOf(n), node: n, role: mark[1] };
        if (id !== undefined) seg.pairKey = `${mark[0]}:${id}`;
        this.segs.push(seg);
        return null;
      }
      switch (n.local) {
        case 'r': return this.run(n);
        case 'hyperlink': return this.wrapper(n, 'hyperlink', clip(storyText([n])) || 'Link');
        case 'fldSimple': return this.wrapper(n, 'field', clip(storyText([n])) || instructionName(attr(n, NS_W, 'instr') ?? '') || 'Field');
        case 'sdt': return this.wrapper(n, 'object', clip(storyText([n])) || 'Content control');
        case 'smartTag': return this.wrapper(n, 'object', clip(storyText([n])) || 'Smart tag');
        case 'proofErr': this.segs.push({ kind: 'disposable', nodes: [n] }); return null;
        case 'ins': case 'del': case 'moveFrom': case 'moveTo': return 'tracked-changes';
        default: return 'unknown-content';
      }
    }
    if (n.ns === NS_M && (n.local === 'oMath' || n.local === 'oMathPara')) return this.wrapper(n, 'math', 'Equation');
    return 'unknown-content';
  }

  /** One atom for a self-contained inline wrapper. A complex field crossing its boundary locks. */
  private wrapper(n: XmlElement, atomType: AtomType, label: string): LockReason | null {
    const t: FieldTracker = { depth: 0, min: 0, bad: false, poisoned: false };
    trackStory(n, t);
    if (t.depth !== 0 || t.min < 0 || t.bad || t.poisoned) return 'unknown-content';
    this.atom(atomType, label, [n]);
    return null;
  }

  /** A `w:r` child of the paragraph, outside any complex field. */
  private run(run: XmlElement): LockReason | null {
    const els: XmlElement[] = [];
    for (const c of run.children) {
      if (c.type === 'el') els.push(c);
      else if (!isWsText(c)) return 'unknown-content';
    }
    let rPr: XmlElement | null = null;
    let content = els;
    if (isW(els[0], 'rPr')) { rPr = els[0]; content = els.slice(1); }
    if (content.some((c) => isW(c, 'rPr'))) return 'unknown-content';   // w:rPr not first, or twice
    if (content.some(isFldChar)) return this.fieldRun(run, content);

    const items: RunItem[] = [];
    let commentReference: XmlElement | null = null;
    for (const c of content) {
      const item = runChild(c);
      if (item === 'commentReference') commentReference = c;
      else if (item === null) return 'unknown-content';
      else items.push(item);
    }
    if (commentReference) {
      // Only a run holding nothing but the reference is an anchor (§8.3); a mixed run is not on the list.
      if (content.length !== 1) return 'unknown-content';
      const seg: Extract<Segment, { kind: 'anchor' }> = { kind: 'anchor', id: this.idOf(run), node: run };
      const id = attr(commentReference, NS_W, 'id');
      if (id !== undefined) seg.pairKey = `comment:${id}`;
      this.segs.push(seg);
      return null;
    }
    // No content, or nothing but stale layout hints: the whole run is droppable.
    if (items.every((it) => it.k === 'disposable')) {
      this.segs.push({ kind: 'disposable', nodes: [run] });
      return null;
    }
    if (items.length === 1 && items[0].k === 'atom') {
      this.atom(items[0].atomType, items[0].label, [run]);
      return null;
    }

    const start = this.segs.length;
    let pieces: XmlElement[] = [];
    let text = '';
    const flush = (): void => {
      if (pieces.length === 0) return;
      this.segs.push({ kind: 'text', id: this.idOf(pieces[0]), text, run, rPr, pieces, wholeRun: false });
      pieces = [];
      text = '';
    };
    for (const it of items) {
      if (it.k === 'text') { pieces.push(it.piece); text += it.s; continue; }
      flush();
      if (it.k === 'atom') this.segs.push({ kind: 'atom', id: this.idOf(it.el), atomType: it.atomType, label: it.label, nodes: [it.el], run, rPr });
      else this.segs.push({ kind: 'disposable', nodes: [it.el] });
    }
    flush();
    if (this.segs.length === start + 1) {
      const only = this.segs[start];
      if (only.kind === 'text') only.wholeRun = true;
    }
    return null;
  }

  /**
   * A run holding `w:fldChar`. Field boundaries must coincide with run boundaries: anything in the
   * run before the field's begin or after its end is refused (Word never writes that).
   */
  private fieldRun(run: XmlElement, content: readonly XmlElement[]): LockReason | null {
    let depth = 0;
    let closed = false;
    for (const c of content) {
      if (closed) return 'unknown-content';
      if (!isFldChar(c)) {
        if (depth === 0) return 'unknown-content';
        continue;
      }
      switch (attr(c, NS_W, 'fldCharType')) {
        case 'begin': depth++; break;
        case 'separate': if (depth === 0) return 'unknown-content'; break;
        case 'end':
          if (depth === 0) return 'unknown-content';
          depth--;
          if (depth === 0) closed = true;
          break;
        default: return 'unknown-content';
      }
    }
    if (closed) {
      this.atom('field', fieldLabel([run]), [run]);
    } else {
      this.field = [run];
      this.depth = depth;
    }
    return null;
  }
}

/** Classify one content child of a run (not `w:rPr`, not `w:fldChar`). null = not on the allow-list. */
function runChild(c: XmlElement): RunItem | 'commentReference' | null {
  if (c.ns === NS_MC && c.local === 'AlternateContent') return { k: 'atom', el: c, atomType: 'object', label: 'Drawing' };
  if (c.ns !== NS_W) return null;
  switch (c.local) {
    case 't': {
      const s = textContent(c);
      // A raw tab or line break inside w:t is not what the island would show or write back
      // (those are w:tab / w:br): refuse rather than normalise somebody's whitespace.
      return RAW_CONTROL_WS.test(s) ? null : { k: 'text', piece: c, s };
    }
    case 'tab': return { k: 'text', piece: c, s: '\t' };
    case 'noBreakHyphen': return { k: 'text', piece: c, s: '\u2011' };
    case 'softHyphen': return { k: 'text', piece: c, s: '\u00AD' };
    case 'br': {
      const type = attr(c, NS_W, 'type');
      const clear = attr(c, NS_W, 'clear');
      if (type === 'page') return { k: 'atom', el: c, atomType: 'break', label: 'Page break' };
      if (type === 'column') return { k: 'atom', el: c, atomType: 'break', label: 'Column break' };
      if (type !== undefined && type !== 'textWrapping') return null;
      // A line break that clears floats cannot be written back as a bare w:br.
      if (clear !== undefined && clear !== 'none') return { k: 'atom', el: c, atomType: 'break', label: 'Line break' };
      return { k: 'text', piece: c, s: '\n' };
    }
    case 'cr': return { k: 'atom', el: c, atomType: 'break', label: 'Line break' };
    case 'drawing': return { k: 'atom', el: c, atomType: 'image', label: drawingLabel(c) };
    case 'pict': return { k: 'atom', el: c, atomType: 'image', label: 'Picture' };
    case 'object': return { k: 'atom', el: c, atomType: 'object', label: 'Object' };
    case 'sym': return { k: 'atom', el: c, atomType: 'object', label: 'Symbol' };
    case 'ptab': return { k: 'atom', el: c, atomType: 'object', label: 'Alignment tab' };
    case 'footnoteReference': return { k: 'atom', el: c, atomType: 'footnote', label: 'Footnote' };
    case 'endnoteReference': return { k: 'atom', el: c, atomType: 'footnote', label: 'Endnote' };
    case 'lastRenderedPageBreak': return { k: 'disposable', el: c };
    case 'commentReference': return 'commentReference';
    default: return null;
  }
}

/**
 * Classify the children of a paragraph in isolation (§8.3). Returns the segments, or the reason
 * the paragraph must be locked. Does not look at revision marks below the allowed children, at the
 * paragraph's container, or at fields open from an earlier paragraph: `DocxModel` adds those.
 */
export function classifyParagraph(p: XmlElement, idOf: (node: XmlNode) => number): Segment[] | LockReason {
  const c = new ParagraphClassifier(idOf);
  return c.classify(p) ?? c.segs;
}

/** Direct paragraph properties of a `w:p` element. */
export function paragraphProps(p: XmlElement): ParagraphProps {
  const pPr = child(p, NS_W, 'pPr') ?? null;
  const out: ParagraphProps = { pPr, pStyleId: null, numPr: null, hasSectPr: false };
  if (!pPr) return out;
  const pStyle = child(pPr, NS_W, 'pStyle');
  out.pStyleId = (pStyle && attr(pStyle, NS_W, 'val')) ?? null;
  out.hasSectPr = child(pPr, NS_W, 'sectPr') !== undefined;
  const numPr = child(pPr, NS_W, 'numPr');
  if (numPr) {
    const int = (local: string): number | null => {
      const el = child(numPr, NS_W, local);
      const v = el ? attr(el, NS_W, 'val') : undefined;
      return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
    };
    const numId = int('numId');
    if (numId !== null) out.numPr = { numId, ilvl: int('ilvl') ?? 0 };
  }
  return out;
}

/** A paragraph block with no lock: the only kind of block the writers may change. */
export function isEditable(b: Block): boolean {
  return b.kind === 'paragraph' && b.lockReason === undefined;
}

// ---------------------------------------------------------------------------------------------------
// Tables

interface TableInfo {
  /** Any `*Change` mark in tblPr, tblGrid, a trPr, a tblPrEx or a tcPr: the whole table is tracked. */
  tracked: boolean;
}

const ROW_WRAPPERS = new Set(['sdt', 'sdtContent', 'customXml']);

/**
 * Table-level revision marks (§8.1). Looks at the table's own property elements and those of its
 * rows and cells, including rows and cells wrapped in `w:sdt` / `w:customXml`; never enters a
 * cell's content (a nested table answers for itself).
 */
function tableInfo(tbl: XmlElement): TableInfo {
  const stack: XmlNode[] = [...tbl.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'el' || n.ns !== NS_W) continue;
    switch (n.local) {
      case 'tblPr': case 'tblGrid': case 'trPr': case 'tblPrEx': case 'tcPr':
        if (someDescendant(n, isChangeMark)) return { tracked: true };
        break;
      case 'tc': {
        const tcPr = child(n, NS_W, 'tcPr');
        if (tcPr) stack.push(tcPr);
        break;
      }
      default:
        if (n.local === 'tr' || ROW_WRAPPERS.has(n.local)) for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
    }
  }
  return { tracked: false };
}

/** `w:trPr/w:ins|w:del`: the row is a tracked insertion or deletion. */
function rowTracked(tr: XmlElement): boolean {
  const trPr = child(tr, NS_W, 'trPr');
  return trPr !== undefined && someDescendant(trPr, isRevision);
}

function isContinuation(mergeEl: XmlElement | undefined): boolean {
  if (!mergeEl) return false;
  const v = attr(mergeEl, NS_W, 'val');
  return v === undefined || v === 'continue';
}

/** The lock a cell imposes on its own paragraphs, before inheritance. */
function cellLock(tc: XmlElement): Container['lockReason'] {
  const tcPr = child(tc, NS_W, 'tcPr');
  if (!tcPr) return null;
  if (isContinuation(child(tcPr, NS_W, 'vMerge')) || isContinuation(child(tcPr, NS_W, 'hMerge'))) return 'merged-cell';
  return someDescendant(tcPr, isRevision) ? 'tracked-changes' : null;
}

// ---------------------------------------------------------------------------------------------------
// Table census (§13.3)

const CENSUS_PROPS = new Set(['tblPr', 'tblGrid', 'trPr', 'tcPr']);

function census(root: XmlElement): string {
  let tbl = 0;
  let tr = 0;
  let tc = 0;
  const props: string[] = [];
  const stack: XmlNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'el') continue;
    if (n.ns === NS_W) {
      if (CENSUS_PROPS.has(n.local)) { props.push(serialize(n)); continue; }   // whole text taken: no need to enter
      if (n.local === 'tbl') tbl++;
      else if (n.local === 'tr') tr++;
      else if (n.local === 'tc') tc++;
    }
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return `tbl=${tbl};tr=${tr};tc=${tc}\n${props.join('\n')}`;
}

// ---------------------------------------------------------------------------------------------------
// The model

type Task =
  | { t: 'child'; n: XmlNode; c: Container }
  | { t: 'row'; tr: XmlElement; table: Block; row: number }
  | { t: 'cell'; tc: XmlElement; table: Block; row: number; col: number; tracked: boolean }
  | { t: 'story'; n: XmlNode };

const NO_SEGMENTS: readonly Segment[] = Object.freeze([]);

export class DocxModel {
  readonly pkg: OfficePackage;
  /** The main part (`word/document.xml` in practice), in package case. */
  readonly mainPart: string;
  /**
   * Why the document as a whole cannot be edited through this model, or null: the package's own
   * reason (`strict-ooxml`, `unsupported-xml-layout`, `utf16-part`, `too-large`), a main part that
   * is not a transitional `w:document` with a `w:body` and a prefix bound to the WordprocessingML
   * namespace on its root (`unsupported-xml-layout`), or more than `LIMITS.docxMaxBlocks` blocks
   * (`too-large`). When set, `blocks()` is empty and nothing is editable. Protection and tracked
   * changes being on are detected elsewhere (`protection.ts`).
   */
  readonly viewOnlyReason: ReadOnlyReason | null;
  /**
   * Prefix the root binds to the WordprocessingML namespace (`w` in every Word-written file), for
   * writers building new markup; '' when the document is view-only.
   */
  readonly wPrefix: string;
  /** `tableCensus()` as it was at load (the validator compares against it); '' when view-only. */
  readonly loadTableCensus: string;

  private readonly ids = new WeakMap<XmlNode, number>();
  private nextId = 1;
  private list: Block[] = [];
  private byId = new Map<number, Block>();
  private segs = new Map<number, Segment[]>();
  private byContainer = new Map<Container, Block[]>();
  private indexInContainer = new Map<number, number>();
  private cellsByTable = new Map<number, Container[]>();
  private bodyContainer: Container | null = null;

  private constructor(pkg: OfficePackage, main: string, doc: XmlDoc | null) {
    this.pkg = pkg;
    this.mainPart = main;
    let reason = pkg.viewOnlyReason;
    let prefix = '';
    if (!reason && doc) {
      prefix = wPrefixOf(doc.root);
      if (!isW(doc.root, 'document') || !child(doc.root, NS_W, 'body') || prefix === '') reason = 'unsupported-xml-layout';
    }
    if (!reason && doc && !this.build(doc)) reason = 'too-large';
    if (reason) { this.reset(); prefix = ''; }
    this.viewOnlyReason = reason;
    this.wPrefix = prefix;
    this.loadTableCensus = reason || !doc ? '' : census(doc.root);
  }

  /**
   * Build the model of a docx package. The main part is parsed (once; `pkg.xml` caches it) unless
   * the package is already view-only. Throws `OfficeLoadError('damaged')` when the main part is not
   * well-formed XML, and a plain Error when the package is not a Word document.
   */
  static load(pkg: OfficePackage): DocxModel {
    const main = mainOf(pkg);
    if (pkg.viewOnlyReason) return new DocxModel(pkg, main, null);
    let doc: XmlDoc;
    try { doc = pkg.xml(main); } catch (e) { throw damaged(main, e); }
    return new DocxModel(pkg, main, doc);
  }

  /** As `load`, but a large main part is inflated and parsed in slices (`pkg.xmlAsync`, §10.2). */
  static async loadAsync(pkg: OfficePackage): Promise<DocxModel> {
    const main = mainOf(pkg);
    if (pkg.viewOnlyReason) return new DocxModel(pkg, main, null);
    let doc: XmlDoc;
    try { doc = await pkg.xmlAsync(main); } catch (e) { throw damaged(main, e); }
    return new DocxModel(pkg, main, doc);
  }

  /** Every block of every container, flattened in document order (a table block precedes its cells' blocks). */
  blocks(): Block[] {
    return this.list.slice();
  }

  block(id: number): Block | undefined {
    return this.byId.get(id);
  }

  /** Neighbouring blocks in the same container (never across a cell or table boundary). */
  siblings(b: Block): { prev: Block | null; next: Block | null } {
    const list = this.byContainer.get(b.container);
    const i = this.indexInContainer.get(b.id);
    if (!list || i === undefined || list[i] !== b) return { prev: null, next: null };
    return { prev: list[i - 1] ?? null, next: list[i + 1] ?? null };
  }

  /** The blocks of one container, in order. */
  blocksIn(c: Container): Block[] {
    return (this.byContainer.get(c) ?? []).slice();
  }

  /** The body container, or null when the document is view-only. */
  body(): Container | null {
    return this.bodyContainer;
  }

  /** The cell containers of a table block, row by row; empty for any other block. */
  cells(table: Block): Container[] {
    return (this.cellsByTable.get(table.id) ?? []).slice();
  }

  /**
   * The segments of an editable paragraph block, in document order. Empty for an empty paragraph
   * and for every block that is not editable (opaque, or locked for any reason): locked content is
   * never offered for editing. Never throws.
   */
  segments(b: Block): Segment[] {
    const cur = this.byId.get(b.id);
    if (!cur || cur.lockReason !== undefined) return [];
    return (this.segs.get(b.id) ?? NO_SEGMENTS).slice();
  }

  /** The id `node` has, if it was ever a block or the key node of a segment. */
  idOf(node: XmlNode): number | undefined {
    return this.ids.get(node);
  }

  /**
   * Make `to` (a node created by an edit) stand for what `from` stood for: it takes `from`'s id.
   * For writers that replace a paragraph or run element but keep the block or text segment, so the
   * webview's ids stay valid across a commit. `from` keeps the id too: if undo brings that node
   * back (while `to` is detached) the block is still the same block. Call before `refresh()`; a
   * no-op when `from` has no id.
   */
  carryId(from: XmlNode, to: XmlNode): void {
    const id = this.ids.get(from);
    if (id !== undefined) this.ids.set(to, id);
  }

  /**
   * Re-read the tree after an edit, undo or redo. Nodes still in the tree keep their ids; new nodes
   * get new ids (never a number used before). `Block` and `Container` objects from before the call
   * are stale. `viewOnlyReason` does not change: it is decided at load. Should an edit push the
   * document over the block limit, the model empties (nothing editable) until a later refresh
   * finds it under the limit again.
   */
  refresh(): void {
    if (this.viewOnlyReason) return;
    const doc = this.pkg.xml(this.mainPart);
    if (!isW(doc.root, 'document') || !child(doc.root, NS_W, 'body') || !this.build(doc)) this.reset();
  }

  /**
   * Table structure fingerprint (§13.3): the number of `w:tbl`, `w:tr` and `w:tc` elements anywhere
   * in the main part, then the source text of every `w:tblPr`, `w:tblGrid`, `w:trPr` and `w:tcPr`
   * in document order. Equal strings mean table structure and properties are untouched.
   */
  tableCensus(): string {
    if (this.viewOnlyReason) return '';
    return census(this.pkg.xml(this.mainPart).root);
  }

  // -------------------------------------------------------------------------------------------

  private reset(): void {
    this.list = [];
    this.byId = new Map();
    this.segs = new Map();
    this.byContainer = new Map();
    this.indexInContainer = new Map();
    this.cellsByTable = new Map();
    this.bodyContainer = null;
  }

  /** Walk the tree and replace the block tables. False (tables untouched) when over the block limit. */
  private build(doc: XmlDoc): boolean {
    const bodyEl = child(doc.root, NS_W, 'body')!;
    const list: Block[] = [];
    const byId = new Map<number, Block>();
    const segs = new Map<number, Segment[]>();
    const byContainer = new Map<Container, Block[]>();
    const indexInContainer = new Map<number, number>();
    const cellsByTable = new Map<number, Container[]>();
    const tables = new Map<number, TableInfo>();
    // Ids handed out in this walk. Two attached nodes can share an id only if `carryId` was used on
    // a node that then stayed in the tree; the later one gets a fresh id rather than a duplicate.
    const seen = new Set<number>();
    const idOf: IdOf = (node) => {
      let id = this.ids.get(node);
      if (id === undefined || seen.has(id)) {
        id = this.nextId++;
        this.ids.set(node, id);
      }
      seen.add(id);
      return id;
    };
    const fields: FieldTracker = { depth: 0, min: 0, bad: false, poisoned: false };

    const body: Container = { el: bodyEl, tableBlockId: null, row: -1, col: -1, parent: null, lockReason: null };
    byContainer.set(body, []);
    const stack: Task[] = [];
    const pushChildren = (c: Container): void => {
      for (let k = c.el.children.length - 1; k >= 0; k--) stack.push({ t: 'child', n: c.el.children[k], c });
    };
    pushChildren(body);

    while (stack.length) {
      const task = stack.pop()!;
      switch (task.t) {
        case 'story':
          trackStory(task.n, fields);
          break;

        case 'child': {
          const { n, c } = task;
          if (n.type !== 'el') break;                                  // whitespace, comments: not blocks
          if (c.tableBlockId !== null && isW(n, 'tcPr')) break;        // the cell's properties, not content
          if (list.length >= LIMITS.docxMaxBlocks) return false;
          const wLocal = n.ns === NS_W ? n.local : '';
          const isPara = wLocal === 'p';
          const isTable = wLocal === 'tbl';
          const b: Block = { id: idOf(n), el: n, kind: isPara ? 'paragraph' : 'opaque', container: c, isTable };
          const mine = byContainer.get(c)!;
          indexInContainer.set(b.id, mine.length);
          mine.push(b);
          list.push(b);
          byId.set(b.id, b);
          if (isPara) {
            const r = this.paragraph(n, c, fields, idOf);
            if (typeof r === 'string') b.lockReason = r;
            else segs.set(b.id, r);
          } else if (isTable) {
            b.lockReason = 'opaque';
            tables.set(b.id, tableInfo(n));
            cellsByTable.set(b.id, []);
            // Row ordinals count direct w:tr children; tasks go on the stack last-first.
            let row = 0;
            for (const ch of n.children) if (isW(ch, 'tr')) row++;
            for (let k = n.children.length - 1; k >= 0; k--) {
              const ch = n.children[k];
              stack.push(isW(ch, 'tr') ? { t: 'row', tr: ch, table: b, row: --row } : { t: 'story', n: ch });
            }
          } else {
            b.lockReason = 'opaque';
            trackStory(n, fields);                                     // not descended, but fields run through it
          }
          break;
        }

        case 'row': {
          const tracked = tables.get(task.table.id)!.tracked || rowTracked(task.tr);
          const kids = task.tr.children;
          let col = 0;
          for (const ch of kids) if (isW(ch, 'tc')) col++;
          for (let k = kids.length - 1; k >= 0; k--) {
            const ch = kids[k];
            stack.push(isW(ch, 'tc')
              ? { t: 'cell', tc: ch, table: task.table, row: task.row, col: --col, tracked }
              : { t: 'story', n: ch });
          }
          break;
        }

        case 'cell': {
          const parent = task.table.container;
          const own = cellLock(task.tc);
          const lockReason: Container['lockReason'] =
            parent.lockReason === 'merged-cell' || own === 'merged-cell' ? 'merged-cell'
              : parent.lockReason === 'tracked-changes' || own === 'tracked-changes' || task.tracked ? 'tracked-changes'
                : null;
          const c: Container = { el: task.tc, tableBlockId: task.table.id, row: task.row, col: task.col, parent, lockReason };
          byContainer.set(c, []);
          cellsByTable.get(task.table.id)!.push(c);
          pushChildren(c);
          break;
        }
      }
    }

    this.list = list;
    this.byId = byId;
    this.segs = segs;
    this.byContainer = byContainer;
    this.indexInContainer = indexInContainer;
    this.cellsByTable = cellsByTable;
    this.bodyContainer = body;
    return true;
  }

  /** Segments of one paragraph, or why it is locked. Advances the document-order field tracker. */
  private paragraph(p: XmlElement, c: Container, fields: FieldTracker, idOf: IdOf): Segment[] | LockReason {
    const start = fields.depth;
    fields.min = start;
    fields.bad = false;
    trackStory(p, fields);
    if (c.lockReason === 'merged-cell') return 'merged-cell';
    if (c.lockReason === 'tracked-changes' || someDescendant(p, isRevision)) return 'tracked-changes';
    if (fields.poisoned) return 'unknown-content';
    // Inside a field begun earlier, or beginning one that ends later: the field spans paragraphs.
    if (start > 0 || fields.depth > 0) return 'multi-paragraph-field';
    if (fields.bad || fields.min < 0) return 'unknown-content';
    return classifyParagraph(p, idOf);
  }
}

function mainOf(pkg: OfficePackage): string {
  if (pkg.kind !== 'docx') throw new Error('DocxModel: the package is not a Word document');
  return mainPart(pkg).name;
}

function damaged(part: string, e: unknown): unknown {
  return e instanceof XmlError ? new OfficeLoadError('damaged', `${part}: ${e.message}`) : e;
}

/** A prefix the root element binds to the WordprocessingML namespace, or ''. */
function wPrefixOf(root: XmlElement): string {
  // The root's own prefix first: it is what the rest of the part uses.
  const own = root.rawName.includes(':') ? root.rawName.slice(0, root.rawName.indexOf(':')) : '';
  let found = '';
  for (const a of root.attrs) {
    if (!a.rawName.startsWith(XMLNS_PREFIX) || a.value !== NS_W) continue;
    const p = a.rawName.slice(XMLNS_PREFIX.length);
    if (p === own) return p;
    if (found === '') found = p;
  }
  return found;
}
