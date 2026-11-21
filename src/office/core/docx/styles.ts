// WP-26: read model for word/styles.xml. Spec §8.3 (effective toggles, run CSS), §8.6 (heading/list style lookup).
// Matches by namespace URI (never by prefix). Never writes (stylesWrite.ts does). Never throws on a
// missing or damaged styles part: every query then answers as if the sheet were empty.
// Headings are found by w:name ('heading N', case-insensitive), NEVER by w:styleId: Word writes the
// built-in English name regardless of UI language while the id is localised ('Überschrift1' -> 'berschrift1').
import type { OfficePackage } from '../package.js';
import { attr, child, childrenOf, type XmlElement } from '../xml.js';
import { partNameFromTarget, readRelationships } from '../opc.js';
import type { DocxBlockInfo, DocxRunCss } from '../../protocol.js';

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Resolve the part a relationship of `kind` ('styles', 'numbering') from the main part points at, or null. */
export function relatedPart(pkg: OfficePackage, main: string, kind: string): string | null {
  let rels;
  try { rels = readRelationships(pkg, main); } catch { return null; }
  for (const r of rels) {
    if (r.external || !r.type.endsWith('/relationships/' + kind)) continue;
    try {
      const name = partNameFromTarget(main, r.target);
      if (pkg.has(name)) return name;
    } catch { /* unusable target */ }
  }
  return null;
}

/** w:val of an on/off element: absent val = on; '0', 'false', 'off' = off. */
export function onOff(el: XmlElement): boolean {
  const v = attr(el, W_NS, 'val');
  if (v === undefined) return true;
  const t = v.trim().toLowerCase();
  return !(t === '0' || t === 'false' || t === 'off');
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'on';
}

type Toggle = 'b' | 'i' | 'u';

interface StyleDef {
  readonly id: string;
  readonly type: string;            // 'paragraph' | 'character' | 'table' | 'numbering' | ''
  readonly name: string;            // w:name val, '' when absent
  readonly basedOn: string | null;
  readonly isDefault: boolean;
  readonly el: XmlElement;
}

const HEADING_NAME = /^heading\s*([1-9])$/i;

const HIGHLIGHT_CSS: Record<string, string> = {
  yellow: 'yellow', green: 'lime', cyan: 'cyan', magenta: 'magenta', blue: 'blue', red: 'red',
  darkBlue: 'navy', darkCyan: 'teal', darkGreen: 'green', darkMagenta: 'purple', darkRed: 'maroon',
  darkYellow: 'olive', darkGray: 'gray', lightGray: 'silver', black: 'black', white: 'white',
};

export class DocxStyles {
  private readonly pkg: OfficePackage;
  private readonly main: string;
  private partName: string | null = null;
  private isDamaged = false;
  private byId = new Map<string, StyleDef>();
  private order: StyleDef[] = [];
  private defaultsRPr: XmlElement | null = null;
  private defaultParagraph: string | null = null;

  private constructor(pkg: OfficePackage, main: string) {
    this.pkg = pkg;
    this.main = main;
    this.reload();
  }

  static load(pkg: OfficePackage, mainPart: string): DocxStyles { return new DocxStyles(pkg, mainPart); }

  /** Part name of the style sheet, or null when the package has none. */
  get part(): string | null { return this.partName; }
  /** True when the part exists but could not be parsed as a WordprocessingML style sheet. */
  get damaged(): boolean { return this.isDamaged; }

  /** Re-read the part from the package's current tree (call after an edit that touched it). */
  reload(): void {
    this.partName = relatedPart(this.pkg, this.main, 'styles');
    this.isDamaged = false;
    this.byId = new Map();
    this.order = [];
    this.defaultsRPr = null;
    this.defaultParagraph = null;
    if (!this.partName) return;
    let root: XmlElement;
    try { root = this.pkg.xml(this.partName).root; } catch { this.isDamaged = true; return; }
    if (root.local !== 'styles' || root.ns !== W_NS) { this.isDamaged = true; return; }
    const dd = child(root, W_NS, 'docDefaults');
    const rd = dd ? child(dd, W_NS, 'rPrDefault') : undefined;
    this.defaultsRPr = rd ? child(rd, W_NS, 'rPr') ?? null : null;
    for (const el of childrenOf(root, W_NS, 'style')) {
      const id = attr(el, W_NS, 'styleId');
      if (!id || this.byId.has(id)) continue;
      const nameEl = child(el, W_NS, 'name');
      const basedEl = child(el, W_NS, 'basedOn');
      const def: StyleDef = {
        id, el,
        type: attr(el, W_NS, 'type') ?? '',
        name: nameEl ? attr(nameEl, W_NS, 'val') ?? '' : '',
        basedOn: basedEl ? attr(basedEl, W_NS, 'val') ?? null : null,
        isDefault: truthy(attr(el, W_NS, 'default')),
      };
      this.byId.set(id, def);
      this.order.push(def);
      if (def.type === 'paragraph' && def.isDefault && this.defaultParagraph === null) this.defaultParagraph = id;
    }
  }

  /** `w:styleId` of the default paragraph style (`w:default="1"`), or null. */
  defaultParagraphStyleId(): string | null { return this.defaultParagraph; }

  /** Paragraph style for heading `level` (1-9): by w:name 'heading N', else by own w:outlineLvl N-1. Never by id. */
  headingStyleId(level: number): string | null {
    if (!Number.isInteger(level) || level < 1 || level > 9) return null;
    for (const s of this.order) {
      if (s.type !== 'paragraph') continue;
      const m = HEADING_NAME.exec(s.name.trim());
      if (m && Number(m[1]) === level) return s.id;
    }
    for (const s of this.order) {
      if (s.type !== 'paragraph') continue;
      const ppr = child(s.el, W_NS, 'pPr');
      const ol = ppr ? child(ppr, W_NS, 'outlineLvl') : undefined;
      if (ol && attr(ol, W_NS, 'val')?.trim() === String(level - 1)) return s.id;
    }
    return null;
  }

  /** Paragraph style named 'List Paragraph' (case-insensitive), or null. */
  listParagraphStyleId(): string | null {
    for (const s of this.order) if (s.type === 'paragraph' && s.name.trim().toLowerCase() === 'list paragraph') return s.id;
    return null;
  }

  /** The style, then each w:basedOn ancestor (cycle-safe, bounded). */
  private chain(id: string | null): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id !== null ? this.byId.get(id) : undefined;
    while (cur && !seen.has(cur.id) && out.length < 64) {
      out.push(cur);
      seen.add(cur.id);
      cur = cur.basedOn !== null ? this.byId.get(cur.basedOn) : undefined;
    }
    return out;
  }

  private paragraphId(pStyleId: string | null): string | null { return pStyleId ?? this.defaultParagraph; }

  /** Heading level from the style's name, else its (inherited) outline level; null when it is body text. */
  private levelOf(pStyleId: string | null): number | null {
    for (const s of this.chain(this.paragraphId(pStyleId))) {
      const m = HEADING_NAME.exec(s.name.trim());
      if (m) return Number(m[1]);
      const ppr = child(s.el, W_NS, 'pPr');
      const ol = ppr ? child(ppr, W_NS, 'outlineLvl') : undefined;
      if (ol) {
        const n = Number(attr(ol, W_NS, 'val'));
        return Number.isInteger(n) && n >= 0 && n <= 8 ? n + 1 : null;   // 9 = body text
      }
    }
    return null;
  }

  /** Style summary for a paragraph's w:pStyle (null = none, i.e. the default paragraph style). `name` is the w:name value. */
  styleInfo(pStyleId: string | null): DocxBlockInfo['style'] {
    const id = this.paragraphId(pStyleId);
    const def = id !== null ? this.byId.get(id) : undefined;
    const level = this.levelOf(pStyleId);
    if (level !== null) {
      return { kind: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, name: def?.name || id || '' };
    }
    if (id === null) return { kind: 'normal', name: 'Normal' };
    if (!def) return { kind: 'other', name: id };
    const normal = def.isDefault && def.type === 'paragraph';
    return { kind: normal ? 'normal' : 'other', name: def.name || def.id };
  }

  /** rPr elements in priority order: direct, run (character) style chain, paragraph style chain, docDefaults. */
  private sources(pStyleId: string | null, rStyleId: string | null, direct: XmlElement | null, withParagraph: boolean): XmlElement[] {
    const out: XmlElement[] = [];
    if (direct) out.push(direct);
    const pick = (s: StyleDef): void => { const r = child(s.el, W_NS, 'rPr'); if (r) out.push(r); };
    for (const s of this.chain(rStyleId)) pick(s);
    if (withParagraph) {
      for (const s of this.chain(this.paragraphId(pStyleId))) pick(s);
      if (this.defaultsRPr) out.push(this.defaultsRPr);
    }
    return out;
  }

  private toggles(sources: XmlElement[]): { b: boolean; i: boolean; u: boolean } {
    const res = { b: false, i: false, u: false };
    for (const t of ['b', 'i', 'u'] as Toggle[]) {
      for (const r of sources) {
        const el = child(r, W_NS, t);
        if (!el) continue;
        if (t === 'u') {
          const v = attr(el, W_NS, 'val');
          res.u = v === undefined || v.trim().toLowerCase() !== 'none';
        } else res[t] = onOff(el);
        break;
      }
    }
    return res;
  }

  /** Effective b/i/u of a run: direct rPr, then its character style, then the paragraph style chain, then docDefaults. */
  effectiveToggles(pStyleId: string | null, rPr: XmlElement | null): { b: boolean; i: boolean; u: boolean } {
    const rs = rPr ? child(rPr, W_NS, 'rStyle') : undefined;
    return this.toggles(this.sources(pStyleId, rs ? attr(rs, W_NS, 'val') ?? null : null, rPr, true));
  }

  /** Same as effectiveToggles with no direct rPr: what the run would be if its own formatting were removed. */
  inheritedToggles(pStyleId: string | null, rStyleId: string | null): { b: boolean; i: boolean; u: boolean } {
    return this.toggles(this.sources(pStyleId, rStyleId, null, true));
  }

  /** CSS-relevant properties set directly on the run or by its character style (paragraph style is inherited in the DOM). */
  runCss(rPr: XmlElement | null): DocxRunCss {
    const css: DocxRunCss = {};
    if (!rPr) return css;
    const rs = child(rPr, W_NS, 'rStyle');
    const rStyleId = rs ? attr(rs, W_NS, 'val') ?? null : null;
    if (rStyleId) css.styleClass = rStyleId;
    const src = this.sources(null, rStyleId, rPr, false);
    const first = (local: string): XmlElement | undefined => {
      for (const r of src) { const e = child(r, W_NS, local); if (e) return e; }
      return undefined;
    };
    const color = first('color');
    const cv = color ? attr(color, W_NS, 'val')?.trim() : undefined;
    if (cv && /^[0-9a-fA-F]{6}$/.test(cv)) css.color = '#' + cv.toUpperCase();
    const sz = first('sz');
    const half = sz ? Number(attr(sz, W_NS, 'val')) : NaN;
    if (Number.isFinite(half) && half > 0) css.fontSizePt = half / 2;
    const fonts = first('rFonts');
    const fam = fonts ? attr(fonts, W_NS, 'ascii') ?? attr(fonts, W_NS, 'hAnsi') : undefined;
    if (fam) css.fontFamily = fam;
    const hl = first('highlight');
    const hv = hl ? attr(hl, W_NS, 'val') : undefined;
    if (hv && HIGHLIGHT_CSS[hv]) css.highlight = HIGHLIGHT_CSS[hv];
    const strike = first('strike');
    const dstrike = first('dstrike');
    if ((strike && onOff(strike)) || (dstrike && onOff(dstrike))) css.strike = true;
    const va = first('vertAlign');
    const vv = va ? attr(va, W_NS, 'val') : undefined;
    if (vv === 'superscript') css.vertAlign = 'super';
    else if (vv === 'subscript') css.vertAlign = 'sub';
    return css;
  }

  /** w:numPr set by the paragraph style (or a w:basedOn ancestor); null when none or numId is 0. */
  styleNumPr(pStyleId: string | null): { numId: number; ilvl: number } | null {
    for (const s of this.chain(this.paragraphId(pStyleId))) {
      const ppr = child(s.el, W_NS, 'pPr');
      const np = ppr ? child(ppr, W_NS, 'numPr') : undefined;
      if (!np) continue;
      const idEl = child(np, W_NS, 'numId');
      if (!idEl) continue;
      const numId = Number(attr(idEl, W_NS, 'val'));
      if (!Number.isInteger(numId) || numId <= 0) return null;
      const lv = child(np, W_NS, 'ilvl');
      const ilvl = lv ? Number(attr(lv, W_NS, 'val')) : 0;
      return { numId, ilvl: Number.isInteger(ilvl) && ilvl >= 0 && ilvl <= 8 ? ilvl : 0 };
    }
    return null;
  }
}
