// WP-26: read model for word/numbering.xml. Spec §8.6 (list kind from numId -> num -> abstractNum -> lvl -> numFmt).
// Matches by namespace URI. Never writes (stylesWrite.ts does). A missing or damaged part answers as "no lists".
import type { OfficePackage } from '../package.js';
import { attr, child, childrenOf, type XmlElement } from '../xml.js';
import type { DocxBlockInfo } from '../../protocol.js';
import { W_NS, relatedPart } from './styles.js';

const NUMBER_FORMATS = new Set(['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman']);
/** `w:abstractNum/w:name` values this editor writes (§8.6). */
const OWN_NAMES = { bullet: 'VSMDBullet', number: 'VSMDNumber' } as const;

function intAttr(el: XmlElement | undefined, local: string): number | null {
  if (!el) return null;
  const n = Number(attr(el, W_NS, local));
  return Number.isInteger(n) ? n : null;
}

export class DocxNumbering {
  private readonly pkg: OfficePackage;
  private readonly main: string;
  private partName: string | null = null;
  private isDamaged = false;
  private abstracts = new Map<number, XmlElement>();
  private nums = new Map<number, XmlElement>();

  private constructor(pkg: OfficePackage, main: string) {
    this.pkg = pkg;
    this.main = main;
    this.reload();
  }

  static load(pkg: OfficePackage, mainPart: string): DocxNumbering { return new DocxNumbering(pkg, mainPart); }

  /** Part name of the numbering part, or null when the package has none (so none can exist yet). */
  get part(): string | null { return this.partName; }
  /** True when the part exists but could not be parsed as WordprocessingML numbering. */
  get damaged(): boolean { return this.isDamaged; }

  /** Re-read the part (and its relationship) from the package's current tree. */
  reload(): void {
    this.partName = relatedPart(this.pkg, this.main, 'numbering');
    this.isDamaged = false;
    this.abstracts = new Map();
    this.nums = new Map();
    if (!this.partName) return;
    let root: XmlElement;
    try { root = this.pkg.xml(this.partName).root; } catch { this.isDamaged = true; return; }
    if (root.local !== 'numbering' || root.ns !== W_NS) { this.isDamaged = true; return; }
    for (const a of childrenOf(root, W_NS, 'abstractNum')) {
      const id = intAttr(a, 'abstractNumId');
      if (id !== null && !this.abstracts.has(id)) this.abstracts.set(id, a);
    }
    for (const n of childrenOf(root, W_NS, 'num')) {
      const id = intAttr(n, 'numId');
      if (id !== null && !this.nums.has(id)) this.nums.set(id, n);
    }
  }

  /** The `w:numFmt` of level `ilvl` of list `numId` (a `w:lvlOverride/w:lvl` wins); undefined if the level is not defined. */
  private numFmt(numId: number, ilvl: number): string | undefined {
    const num = this.nums.get(numId);
    if (!num) return undefined;
    let lvl: XmlElement | undefined;
    for (const ov of childrenOf(num, W_NS, 'lvlOverride')) {
      if (intAttr(ov, 'ilvl') === ilvl) { lvl = child(ov, W_NS, 'lvl'); if (lvl) break; }
    }
    if (!lvl) {
      const absId = intAttr(child(num, W_NS, 'abstractNumId'), 'val');
      const abs = absId !== null ? this.abstracts.get(absId) : undefined;
      if (!abs) return undefined;
      lvl = childrenOf(abs, W_NS, 'lvl').find((l) => intAttr(l, 'ilvl') === ilvl);
    }
    if (!lvl) return undefined;
    const nf = child(lvl, W_NS, 'numFmt');
    return nf ? attr(nf, W_NS, 'val') ?? 'decimal' : 'decimal';
  }

  /** List kind and level of a paragraph whose effective numPr is (numId, ilvl). numId 0 or unknown = not a list. */
  listInfo(numId: number, ilvl: number): DocxBlockInfo['list'] {
    const level = Number.isInteger(ilvl) ? Math.max(0, Math.min(8, ilvl)) : 0;
    if (!Number.isInteger(numId) || numId <= 0 || !this.nums.has(numId)) return { kind: 'none', level: 0 };
    const fmt = this.numFmt(numId, level);
    if (fmt === undefined) return { kind: 'other', level };
    if (fmt === 'bullet') return { kind: 'bullet', level };
    return { kind: NUMBER_FORMATS.has(fmt) ? 'number' : 'other', level };
  }

  /** Highest w:abstractNumId, or -1 when there is none (so "+ 1" is always the next free id). */
  maxAbstractNumId(): number {
    let m = -1;
    for (const id of this.abstracts.keys()) if (id > m) m = id;
    return m;
  }

  /** Highest w:numId, or 0 when there is none (so "+ 1" is always the next free id; numId 0 means "no list"). */
  maxNumId(): number {
    let m = 0;
    for (const id of this.nums.keys()) if (id > m) m = id;
    return m;
  }

  /** abstractNumId of this editor's own definition for `kind` (`w:name` VSMDBullet / VSMDNumber), or null. */
  findOwnAbstract(kind: 'bullet' | 'number'): number | null {
    for (const [id, a] of this.abstracts) {
      const n = child(a, W_NS, 'name');
      if (n && attr(n, W_NS, 'val') === OWN_NAMES[kind]) return id;
    }
    return null;
  }
}
