// Shared strings table (`xl/sharedStrings.xml`) and string-item text (spec §9.2).
//
// A string item (`si`, also the `is` of an inline-string cell) is either a single `t` or a list of
// rich runs `r/t`; its plain text is the concatenation of those `t` elements. Phonetic runs (`rPh`)
// and `phoneticPr` are ignored. Elements are matched by namespace URI (real files use `x:` prefixes),
// with the namespace taken from the part's root element so Strict files read too.
//
// ST_Xstring escapes (`_xHHHH_`, used by Excel for control characters; a literal `_x` sequence is
// written as `_x005F_x…`) are decoded in a single left-to-right pass, as Excel and ExcelJS do.
//
// No `vscode` import here (core rule).

import type { XmlDoc, XmlElement } from '../xml.js';
import { textContent } from '../xml.js';

export const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const NS_MAIN_STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

/** True when `ns` is the SpreadsheetML main namespace (transitional or Strict). */
export function isMainNs(ns: string): boolean {
  return ns === NS_MAIN || ns === NS_MAIN_STRICT;
}

const XSTRING_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

/** Decode ST_Xstring `_xHHHH_` escapes. */
export function decodeXstring(s: string): string {
  if (s.indexOf('_x') < 0) return s;
  return s.replace(XSTRING_ESCAPE, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Plain text of a string item (`si` or `is`) in namespace `ns`: its `t`, or its rich runs' `t`s
 * concatenated; `rPh` ignored. `rich` is true when the item has at least one `r` run.
 */
export function stringItemText(el: XmlElement, ns: string): { text: string; rich: boolean } {
  let text = '';
  let rich = false;
  for (const ch of el.children) {
    if (ch.type !== 'el' || ch.ns !== ns) continue;
    if (ch.local === 't') {
      text += textContent(ch);
    } else if (ch.local === 'r') {
      rich = true;
      for (const rc of ch.children) {
        if (rc.type === 'el' && rc.ns === ns && rc.local === 't') text += textContent(rc);
      }
    }
  }
  return { text: decodeXstring(text), rich };
}

export class SharedStrings {
  private readonly items: string[];
  private readonly richFlags: Uint8Array;

  private constructor(items: string[], richFlags: Uint8Array) {
    this.items = items;
    this.richFlags = richFlags;
  }

  /** An empty table (workbook without a shared strings part). */
  static empty(): SharedStrings {
    return new SharedStrings([], new Uint8Array(0));
  }

  /** Read a parsed `sst` part. A root that is not `sst` in the main namespace yields an empty table. */
  static parse(doc: XmlDoc): SharedStrings {
    const root = doc.root;
    if (root.local !== 'sst' || !isMainNs(root.ns)) return SharedStrings.empty();
    const ns = root.ns;
    const items: string[] = [];
    const rich: number[] = [];
    for (const ch of root.children) {
      if (ch.type !== 'el' || ch.ns !== ns || ch.local !== 'si') continue;
      const it = stringItemText(ch, ns);
      if (it.rich) rich.push(items.length);
      items.push(it.text);
    }
    const flags = new Uint8Array(items.length);
    for (const i of rich) flags[i] = 1;
    return new SharedStrings(items, flags);
  }

  get count(): number { return this.items.length; }

  /** Text of item `i`, or undefined when `i` is out of range. */
  get(i: number): string | undefined {
    return i >= 0 && i < this.items.length ? this.items[i] : undefined;
  }

  /** True when item `i` has rich runs. */
  isRich(i: number): boolean {
    return i >= 0 && i < this.richFlags.length && this.richFlags[i] === 1;
  }
}
