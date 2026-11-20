// WP-12: read model for xl/styles.xml (+ theme colours). Spec §3.5, §7.2, §11.1.
// Matches by namespace URI (never by prefix), so `x:`-prefixed parts work. Never writes (stylesWrite.ts does).
import { getFormatFromId, isDateFormat, isPercentFormat, isTextFormat } from 'numfmt';
import type { OfficePackage } from '../package.js';
import { attr, child, childrenOf, type XmlElement } from '../xml.js';
import type { XlsxStyle } from '../../protocol.js';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** Default Office (2013+) theme, used when the package has no usable theme part. */
const DEFAULT_THEME: Record<string, string> = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
  accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47',
  hlink: '0563C1', folHlink: '954F72',
};
/** SpreadsheetML theme index -> clrScheme element (0/1 and 2/3 are swapped relative to the XML order). */
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** ECMA-376 §18.8.27 default indexed palette (0-63). 64/65 (system foreground/background) are handled separately. */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/** Border style -> CSS width/style (§7.2). */
const BORDER_CSS: Record<string, string> = {
  thin: '1px solid', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed',
  dashDot: '1px dashed', dashDotDot: '1px dashed', medium: '2px solid', mediumDashed: '2px dashed',
  mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed',
  thick: '3px solid', double: '3px double',
};

// ---------------------------------------------------------------------------------------------
// Colour maths

function hex2(n: number): string { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase(); }

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, l, 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, l, s];
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Apply an ECMA-376 tint (-1..1) to a 6-digit hex colour in HLS space, as Excel does. Returns '#RRGGBB'. */
export function applyTint(hex6: string, tint: number): string {
  const r = parseInt(hex6.slice(0, 2), 16), g = parseInt(hex6.slice(2, 4), 16), b = parseInt(hex6.slice(4, 6), 16);
  if (!tint) return '#' + hex6.toUpperCase();
  const [h, l0, s] = rgbToHls(r, g, b);
  const l = tint < 0 ? l0 * (1 + tint) : l0 * (1 - tint) + tint;
  const [nr, ng, nb] = hlsToRgb(h, Math.max(0, Math.min(1, l)), s);
  return '#' + hex2(nr) + hex2(ng) + hex2(nb);
}

// ---------------------------------------------------------------------------------------------

interface FontRec { bold?: true; italic?: true; underline?: true; strike?: true; color?: string; name?: string; size?: number }
interface XfRec { numFmtId: number; fontId: number; fillId: number; borderId: number; align?: XmlElement }
interface FmtInfo { code: string; date: boolean; text: boolean; percent: boolean }

export class StyleTable {
  private fonts: FontRec[] = [];
  private fills: Array<string | undefined> = [];
  private borders: Array<XlsxStyle['border']> = [];
  private xfs: XfRec[] = [];
  private numFmts = new Map<number, string>();
  private palette: string[] = [];
  private theme: Record<string, string> = DEFAULT_THEME;
  private cache = new Map<number, XlsxStyle>();
  private fmtCache = new Map<number, FmtInfo>();

  private constructor(
    private readonly pkg: OfficePackage,
    private readonly stylesPart: string | null,
    private readonly themePart: string | null,
  ) { this.reload(); }

  /** Absent or unreadable parts give an empty table: every index resolves to General / default style. */
  static load(pkg: OfficePackage, stylesPart: string | null, themePart: string | null): StyleTable {
    return new StyleTable(pkg, stylesPart, themePart);
  }

  get xfCount(): number { return this.xfs.length; }

  /** Re-read the parts from the package (after stylesWrite appended an `xf`). */
  reload(): void {
    this.fonts = []; this.fills = []; this.borders = []; this.xfs = [];
    this.numFmts = new Map(); this.palette = INDEXED.slice(); this.theme = DEFAULT_THEME;
    this.cache.clear(); this.fmtCache.clear();
    const pkg = this.pkg;
    if (this.themePart && pkg.has(this.themePart)) {
      try { this.theme = { ...DEFAULT_THEME, ...readTheme(pkg.xml(this.themePart).root) }; } catch { /* keep default */ }
    }
    if (this.stylesPart && pkg.has(this.stylesPart)) {
      try {
        this.readStyles(pkg.xml(this.stylesPart).root);
      } catch {
        this.fonts = []; this.fills = []; this.borders = []; this.xfs = []; this.numFmts = new Map();
      }
    }
  }

  private readStyles(root: XmlElement): void {
    const colors = child(root, S, 'colors');
    const ic = colors && child(colors, S, 'indexedColors');
    if (ic) {
      childrenOf(ic, S, 'rgbColor').forEach((c, i) => {
        const rgb = attr(c, '', 'rgb');
        if (rgb && rgb.length >= 6 && i < 64) this.palette[i] = rgb.slice(-6).toUpperCase();
      });
    }
    const nf = child(root, S, 'numFmts');
    if (nf) {
      for (const e of childrenOf(nf, S, 'numFmt')) {
        const id = Number(attr(e, '', 'numFmtId')), code = attr(e, '', 'formatCode');
        if (Number.isInteger(id) && code !== undefined) this.numFmts.set(id, code);
      }
    }
    const fonts = child(root, S, 'fonts');
    if (fonts) for (const f of childrenOf(fonts, S, 'font')) this.fonts.push(this.readFont(f));
    const fills = child(root, S, 'fills');
    if (fills) for (const f of childrenOf(fills, S, 'fill')) this.fills.push(this.readFill(f));
    const borders = child(root, S, 'borders');
    if (borders) for (const b of childrenOf(borders, S, 'border')) this.borders.push(this.readBorder(b));
    const xfs = child(root, S, 'cellXfs');
    if (xfs) {
      for (const x of childrenOf(xfs, S, 'xf')) {
        this.xfs.push({
          numFmtId: Number(attr(x, '', 'numFmtId') ?? 0) || 0,
          fontId: Number(attr(x, '', 'fontId') ?? 0) || 0,
          fillId: Number(attr(x, '', 'fillId') ?? 0) || 0,
          borderId: Number(attr(x, '', 'borderId') ?? 0) || 0,
          align: child(x, S, 'alignment'),
        });
      }
    }
  }

  /** '#RRGGBB', 'auto', or undefined (no colour information). */
  private resolveColor(el: XmlElement | undefined): string | undefined {
    if (!el) return undefined;
    const auto = attr(el, '', 'auto');
    if (auto === '1' || auto === 'true') return 'auto';
    const rgb = attr(el, '', 'rgb');
    if (rgb !== undefined) return /^[0-9a-fA-F]{6,8}$/.test(rgb) ? '#' + rgb.slice(-6).toUpperCase() : undefined;
    const theme = attr(el, '', 'theme');
    if (theme !== undefined) {
      const key = THEME_ORDER[Number(theme)];
      const base = key ? this.theme[key] : undefined;
      if (!base) return undefined;
      return applyTint(base, Number(attr(el, '', 'tint') ?? 0) || 0);
    }
    const idx = attr(el, '', 'indexed');
    if (idx !== undefined) {
      const n = Number(idx);
      if (n === 64) return 'auto';
      if (n === 65) return '#FFFFFF';
      const base = this.palette[n];
      return base ? '#' + base : undefined;
    }
    return undefined;
  }

  private readFont(f: XmlElement): FontRec {
    const out: FontRec = {};
    const on = (name: string): boolean => {
      const e = child(f, S, name);
      if (!e) return false;
      const v = attr(e, '', 'val');
      return v === undefined || (v !== '0' && v !== 'false');
    };
    if (on('b')) out.bold = true;
    if (on('i')) out.italic = true;
    if (on('strike')) out.strike = true;
    const u = child(f, S, 'u');
    if (u && attr(u, '', 'val') !== 'none') out.underline = true;
    const sz = child(f, S, 'sz');
    if (sz && Number(attr(sz, '', 'val')) > 0) out.size = Number(attr(sz, '', 'val'));
    const name = child(f, S, 'name');
    if (name && attr(name, '', 'val')) out.name = attr(name, '', 'val');
    const c = this.resolveColor(child(f, S, 'color'));
    if (c && c !== 'auto') out.color = c;
    return out;
  }

  private readFill(f: XmlElement): string | undefined {
    const p = child(f, S, 'patternFill');
    if (!p) return undefined;   // gradientFill: non-goal in v1
    const type = attr(p, '', 'patternType');
    if (!type || type === 'none' || type === 'gray125') return undefined;
    // Non-solid patterns are drawn as the nearest solid colour (§7.2 non-goals): the pattern's foreground.
    const c = this.resolveColor(child(p, S, 'fgColor'));
    if (c === 'auto') return type === 'solid' ? '#000000' : undefined;
    return c;
  }

  private readBorder(b: XmlElement): XlsxStyle['border'] {
    const out: NonNullable<XlsxStyle['border']> = {};
    for (const [side, key] of [['top', 't'], ['right', 'r'], ['bottom', 'b'], ['left', 'l']] as const) {
      const e = child(b, S, side);
      const css = e && BORDER_CSS[attr(e, '', 'style') ?? ''];
      if (!e || !css) continue;
      const c = this.resolveColor(child(e, S, 'color'));
      out[key] = `${css} ${c && c !== 'auto' ? c : '#000000'}`;
    }
    return Object.keys(out).length ? out : undefined;
  }

  // -------------------------------------------------------------------------------------------

  private xf(i: number): XfRec | undefined { return Number.isInteger(i) ? this.xfs[i] : undefined; }

  numFmtId(styleIndex: number): number { return this.xf(styleIndex)?.numFmtId ?? 0; }

  private fmt(styleIndex: number): FmtInfo {
    let r = this.fmtCache.get(styleIndex);
    if (r) return r;
    const id = this.numFmtId(styleIndex);
    let code = this.numFmts.get(id);
    if (code === undefined) {
      try { code = getFormatFromId(id, 'en-US'); } catch { code = undefined; }
    }
    const c = code || 'General';
    const safe = (fn: (p: string) => boolean): boolean => { try { return fn(c); } catch { return false; } };
    r = { code: c, date: safe(isDateFormat), text: safe(isTextFormat), percent: safe(isPercentFormat) };
    this.fmtCache.set(styleIndex, r);
    return r;
  }

  formatCode(styleIndex: number): string { return this.fmt(styleIndex).code; }
  isDateStyle(styleIndex: number): boolean { return this.fmt(styleIndex).date; }
  /** Whether the style's number format is General: id 0, or a custom `numFmts` entry whose code is "General" (§9.3.1). */
  isGeneralStyle(styleIndex: number): boolean { return this.fmt(styleIndex).code.trim().toUpperCase() === 'GENERAL'; }
  isTextStyle(styleIndex: number): boolean { return this.fmt(styleIndex).text; }
  isPercentStyle(styleIndex: number): boolean { return this.fmt(styleIndex).percent; }

  /** CSS-ready style; theme+tint and indexed colours are resolved to #rrggbb. Out-of-range index = default style. */
  dto(styleIndex: number): XlsxStyle {
    const hit = this.cache.get(styleIndex);
    if (hit) return hit;
    const out: XlsxStyle = {};
    const xf = this.xf(styleIndex);
    const font = xf ? this.fonts[xf.fontId] : undefined;
    if (font) {
      if (font.bold) out.bold = true;
      if (font.italic) out.italic = true;
      if (font.underline) out.underline = true;
      if (font.strike) out.strike = true;
      if (font.name) out.fontFamily = font.name;
      if (font.size) out.fontSizePt = font.size;
    }
    if (font?.color) out.color = font.color; else out.autoColor = true;
    if (xf) {
      const fill = this.fills[xf.fillId];
      if (fill) out.fill = fill;
      const border = this.borders[xf.borderId];
      if (border) out.border = { ...border };
      const al = xf.align;
      if (al) {
        const h = attr(al, '', 'horizontal');
        const hm: Record<string, XlsxStyle['h']> = { left: 'left', center: 'center', centerContinuous: 'center', right: 'right', justify: 'justify', distributed: 'justify' };
        if (h && hm[h]) out.h = hm[h];
        const v = attr(al, '', 'vertical');
        const vm: Record<string, XlsxStyle['v']> = { top: 'top', center: 'middle', bottom: 'bottom', justify: 'top', distributed: 'middle' };
        if (v && vm[v]) out.v = vm[v];
        const wrap = attr(al, '', 'wrapText');
        if (wrap === '1' || wrap === 'true') out.wrap = true;
        const indent = Number(attr(al, '', 'indent') ?? 0);
        if (indent > 0) out.indent = indent;
      }
    }
    this.cache.set(styleIndex, out);
    return out;
  }
}

function readTheme(root: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const els = child(root, A, 'themeElements');
  const scheme = els && child(els, A, 'clrScheme');
  if (!scheme) return out;
  for (const key of THEME_ORDER) {
    const slot = child(scheme, A, key);
    const c = slot && slot.children.find((n): n is XmlElement => n.type === 'el');
    if (!c) continue;
    const v = c.local === 'sysClr' ? (attr(c, '', 'lastClr') ?? attr(c, '', 'val')) : attr(c, '', 'val');
    if (v && /^[0-9a-fA-F]{6}$/.test(v)) out[key] = v.toUpperCase();
  }
  return out;
}
