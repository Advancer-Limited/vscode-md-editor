// Lossless XML (spec §3.3, D3): a tokenizer plus a light tree.
//
// Every element remembers the source string it was parsed from and its offsets in it. An unmodified
// element serialises as its exact source slice; a modified element rebuilds itself from its (possibly
// rewritten) start tag, its children and its original end tag, so untouched descendants still emit
// their slices (G2, G4). Text, CDATA, comment and PI nodes are their raw source text.
//
// Children cover the content of an element completely (every character between the start tag and the
// end tag belongs to exactly one child), so concatenating them reproduces the source exactly. Adjacent
// text nodes are never merged (§6.3), which makes removeAt/insertAt at the same node path exact inverses.
//
// Security (§12): any `<!DOCTYPE` is rejected, so there are no DTDs, no external entities and no entity
// expansion. Only the five predefined entities and numeric character references are recognised.
// Hostile input is bounded (§10.2): element depth and attributes per start tag are capped, namespace
// resolution is O(1) per name and duplicate checks use Sets, so parsing stays linear; serialisation
// is iterative.
//
// No `vscode` import here (core rule): this module also runs in the Node test bundle.

import { LIMITS } from './limits.js';

export class XmlError extends Error {
  readonly code: 'doctype' | 'malformed' | 'encoding';
  readonly offset: number;
  constructor(code: 'doctype' | 'malformed' | 'encoding', message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'XmlError';
    this.code = code;
    this.offset = offset;
  }
}

/**
 * An inserted fragment (insertAt/replaceNode with `rootScoped`) would not mean at the insertion site
 * what it means at the root: a prefix is redeclared or unbound in between, or the default namespace
 * differs. Callers map this to the read-only reason `unsupported-xml-layout` (spec §3.3).
 */
export class XmlScopeError extends Error {
  /** Raw name of the first element or attribute whose namespace differs. */
  readonly rawName: string;
  /** Namespace at the root ('' when unbound or not resolvable there). */
  readonly expectedNs: string;
  /** Namespace at the insertion site. */
  readonly actualNs: string;
  constructor(rawName: string, expectedNs: string, actualNs: string, message?: string) {
    super(message ?? `"${rawName}" would be in namespace "${actualNs}" at the insertion site, not "${expectedNs}" as at the root`);
    this.name = 'XmlScopeError';
    this.rawName = rawName;
    this.expectedNs = expectedNs;
    this.actualNs = actualNs;
  }
}

export interface XmlAttr { readonly rawName: string; readonly ns: string; readonly local: string; value: string; /* decoded */ readonly raw: string; }
export interface XmlElement {
  readonly type: 'el'; readonly ns: string; readonly local: string; readonly rawName: string;
  attrs: XmlAttr[]; children: XmlNode[]; parent: XmlElement | null;
}
export interface XmlText { readonly type: 'text' | 'cdata' | 'comment' | 'pi'; readonly raw: string; parent: XmlElement | null; }
export type XmlNode = XmlElement | XmlText;
export interface XmlDoc { readonly root: XmlElement; }                      // prolog/epilog kept internally

// ---------------------------------------------------------------------------------------------------
// Internal representation

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** A namespace scope: the declarations made on one element, chained to the enclosing scope. */
interface Scope { readonly map: Map<string, string>; readonly parent: Scope | null; }
const BASE_SCOPE: Scope = { map: new Map([['xml', XML_NS]]), parent: null };

interface AttrImpl {
  readonly rawName: string; readonly ns: string; readonly local: string; value: string; readonly raw: string;
  /** Whitespace that precedes the attribute inside the start tag (part of the start tag's raw text). */
  readonly pre: string;
}

interface ElImpl {
  readonly type: 'el'; readonly ns: string; readonly local: string; readonly rawName: string;
  attrs: XmlAttr[]; children: XmlNode[]; parent: XmlElement | null;
  /** Source string this element was parsed from (the part, or a fragment). */
  readonly _src: string;
  /** Start of the start tag. */
  readonly _s: number;
  /** End of the start tag (just past `>`). */
  _stEnd: number;
  /** Start of the start tag's tail: the whitespace after the last attribute plus `>` or `/>`. */
  _tailStart: number;
  /** Start of the end tag, or -1 when the element is self-closing in the source. */
  _et: number;
  /** End of the element (just past the end tag, or the start tag when self-closing). */
  _e: number;
  /** In-scope namespace bindings (including this element's own declarations). */
  readonly _scope: Scope;
  /** Start tag must be rebuilt from `attrs` (an attribute changed). */
  _tagDirty: boolean;
  /** Children changed (here or below): rebuild from children instead of the source slice. */
  _dirty: boolean;
  /** Attributes as parsed, captured on the first attribute change (for exact restoration, G5). */
  _origAttrs: AttrImpl[] | null;
}

interface TextImpl { readonly type: 'text' | 'cdata' | 'comment' | 'pi'; readonly raw: string; parent: XmlElement | null; }

interface DocImpl { readonly root: XmlElement; readonly _src: string; readonly _prolog: string; readonly _epilog: string; }

function impl(el: XmlElement): ElImpl { return el as unknown as ElImpl; }

function lookupNs(scope: Scope, prefix: string): string | undefined {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const v = s.map.get(prefix);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Character references and escaping

function isLegalCodePoint(cp: number): boolean {
  return cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF)
    || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

const HEX_REF = /^#x[0-9a-fA-F]+$/;
const DEC_REF = /^#[0-9]+$/;
const LEADING_ZEROS = /^0+/;

/** Replacement text of `&name;`, or null when it is not one of the five predefined entities or a legal numeric reference. */
function resolveRef(name: string): string | null {
  switch (name) {
    case 'lt': return '<';
    case 'gt': return '>';
    case 'amp': return '&';
    case 'quot': return '"';
    case 'apos': return '\'';
  }
  // Leading zeros are legal (`&#x0010FFFF;`); the length guard applies to the significant digits only
  // (U+10FFFF is 6 hex / 7 decimal digits), so parseInt never sees an absurdly long number.
  let cp: number;
  if (HEX_REF.test(name)) {
    const digits = name.slice(2).replace(LEADING_ZEROS, '');
    cp = digits.length > 6 ? -1 : parseInt(digits || '0', 16);
  } else if (DEC_REF.test(name)) {
    const digits = name.slice(1).replace(LEADING_ZEROS, '');
    cp = digits.length > 7 ? -1 : parseInt(digits || '0', 10);
  } else return null;
  return isLegalCodePoint(cp) ? String.fromCodePoint(cp) : null;
}

/** Validate every `&...;` in `s` (no decoding). `base` is the offset of `s` in the source, for errors. */
function checkRefs(s: string, base: number): void {
  let idx = s.indexOf('&');
  while (idx >= 0) {
    const semi = s.indexOf(';', idx + 1);
    if (semi < 0) throw new XmlError('malformed', 'unterminated entity reference', base + idx);
    const name = s.slice(idx + 1, semi);
    if (resolveRef(name) === null) throw new XmlError('malformed', `unknown entity &${name};`, base + idx);
    idx = s.indexOf('&', semi + 1);
  }
}

/** Decode references in already-validated text. */
function decodeRefs(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&([^;]*);/g, (_m, name: string) => resolveRef(name) ?? '');
}

/** XML end-of-line handling (§2.11): CRLF and lone CR become LF. */
function normalizeEol(s: string): string {
  return s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n');
}

const ATTR_WS = /\r\n|[\t\n\r]/g;

/** Attribute-value normalisation (§3.3.3) + reference decoding, validating as it goes. */
function decodeAttrValue(raw: string, base: number): string {
  let idx = raw.indexOf('&');
  if (idx < 0) return /[\t\n\r]/.test(raw) ? raw.replace(ATTR_WS, ' ') : raw;
  let out = '';
  let last = 0;
  while (idx >= 0) {
    const semi = raw.indexOf(';', idx + 1);
    if (semi < 0) throw new XmlError('malformed', 'unterminated entity reference', base + idx);
    const name = raw.slice(idx + 1, semi);
    const ch = resolveRef(name);
    if (ch === null) throw new XmlError('malformed', `unknown entity &${name};`, base + idx);
    out += raw.slice(last, idx).replace(ATTR_WS, ' ') + ch;   // character references are NOT normalised
    last = semi + 1;
    idx = raw.indexOf('&', last);
  }
  return out + raw.slice(last).replace(ATTR_WS, ' ');
}

/**
 * Escape text content: `&`, `<`, `>` (so `]]>` can never appear), and CR as `&#13;` (a literal CR would be
 * turned into LF by the next reader).
 */
export function escapeText(s: string): string {
  return s.replace(/[&<>\r]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;'));
}

/**
 * Escape a double-quoted attribute value: `&`, `<`, `>`, `"`, and TAB/LF/CR as character references
 * (literal ones would be normalised to spaces by the next reader).
 */
export function escapeAttr(s: string): string {
  return s.replace(/[&<>"\t\n\r]/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\t': return '&#9;';
      case '\n': return '&#10;';
      default: return '&#13;';
    }
  });
}

function escapeAttrFor(s: string, quote: string): string {
  const e = escapeAttr(s);
  return quote === '\'' ? e.replace(/'/g, '&apos;') : e;
}

/** Remove characters that are not allowed in XML 1.0 (C0 controls other than TAB/LF/CR, lone surrogates, U+FFFE/U+FFFF). */
export function stripIllegalXmlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// ---------------------------------------------------------------------------------------------------
// Encoding

/** Decode a part's bytes. UTF-8 (with or without BOM) and UTF-16 (LE/BE, BOM or `<?` sniffed). */
export function decodePart(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16'; bom: boolean } {
  return decodeBytes(bytes, false);
}

/**
 * As `decodePart`, for the first bytes of a part only (e.g. a bounded inflate to read the root start
 * tag): a multi-byte sequence cut off at the end is dropped instead of being an error. Invalid bytes
 * before that still throw XmlError('encoding').
 */
export function decodePartPrefix(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16'; bom: boolean } {
  return decodeBytes(bytes, true);
}

function decodeBytes(bytes: Uint8Array, prefix: boolean): { text: string; encoding: 'utf-8' | 'utf-16'; bom: boolean } {
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  let label = 'utf-8';
  let encoding: 'utf-8' | 'utf-16' = 'utf-8';
  let bom = false;
  let start = 0;
  if (b0 === 0xEF && b1 === 0xBB && b2 === 0xBF) { bom = true; start = 3; }
  else if (b0 === 0xFF && b1 === 0xFE) { bom = true; start = 2; label = 'utf-16le'; encoding = 'utf-16'; }
  else if (b0 === 0xFE && b1 === 0xFF) { bom = true; start = 2; label = 'utf-16be'; encoding = 'utf-16'; }
  else if (b0 === 0x3C && b1 === 0x00 && b2 === 0x3F && b3 === 0x00) { label = 'utf-16le'; encoding = 'utf-16'; }
  else if (b0 === 0x00 && b1 === 0x3C && b2 === 0x00 && b3 === 0x3F) { label = 'utf-16be'; encoding = 'utf-16'; }
  let text: string;
  try {
    // `stream: true` keeps an incomplete trailing sequence pending instead of failing on it.
    text = new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start), { stream: prefix });
  } catch {
    throw new XmlError('encoding', `part is not valid ${label}`, 0);
  }
  // The XML declaration must not claim an encoding other than the one actually used.
  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>');
    const decl = end > 0 ? text.slice(0, end) : '';
    const m = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(decl);
    if (m) {
      const declared = m[2].toLowerCase();
      const ok = encoding === 'utf-8'
        ? declared === 'utf-8' || declared === 'utf8'
        : declared === 'utf-16' || declared === label;
      if (!ok) throw new XmlError('encoding', `declared encoding "${m[2]}" is not supported (bytes are ${label})`, m.index);
    }
  }
  return { text, encoding, bom };
}

/** Encode a part as UTF-8, with a BOM when `bom` is true. */
export function encodePart(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out[0] = 0xEF; out[1] = 0xBB; out[2] = 0xBF;
  out.set(body, 3);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Parser

function isWs(c: number): boolean { return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D; }

const NOT_WS = /[^ \t\r\n]/;

function checkName(name: string, offset: number): void {
  if (name.length === 0) throw new XmlError('malformed', 'expected a name', offset);
  const c = name.charCodeAt(0);
  if ((c >= 0x30 && c <= 0x39) || c === 0x2D || c === 0x2E || c === 0x3A) {
    throw new XmlError('malformed', `invalid name "${name}"`, offset);
  }
  const colon = name.indexOf(':');
  if (colon >= 0 && (colon === name.length - 1 || name.indexOf(':', colon + 1) >= 0)) {
    throw new XmlError('malformed', `invalid qualified name "${name}"`, offset);
  }
}

/** Few attributes: a linear duplicate scan beats building a Set. */
const SMALL_ATTR_COUNT = 8;

class Parser {
  private readonly src: string;
  private readonly len: number;
  private pos = 0;
  private readonly stack: ElImpl[] = [];
  /** Namespace declarations made by each open element (parallel to `stack`; null = none). */
  private readonly declStack: (Map<string, string> | null)[] = [];
  /**
   * prefix -> URIs declared by the open elements of this parse, innermost last. Together with
   * `baseCache` this makes namespace resolution O(1) per name instead of a walk up the scope chain
   * (which is O(depth) and made hostile deeply nested input quadratic).
   */
  private readonly bindings = new Map<string, string[]>();
  /** Resolutions against `baseScope` (the scope outside this parse), memoised. */
  private readonly baseCache = new Map<string, string | undefined>();
  private readonly fragment: boolean;
  private readonly fragParent: XmlElement | null;
  private readonly baseScope: Scope;
  /** Depth of the element the parse happens inside (0 for a document). */
  private readonly baseDepth: number;
  private root: ElImpl | null = null;
  readonly out: XmlNode[] = [];

  constructor(src: string, fragment: boolean, baseScope: Scope, fragParent: XmlElement | null, baseDepth = 0) {
    this.src = src;
    this.len = src.length;
    this.fragment = fragment;
    this.baseScope = baseScope;
    this.fragParent = fragParent;
    this.baseDepth = baseDepth;
  }

  private resolve(prefix: string): string | undefined {
    const st = this.bindings.get(prefix);
    if (st !== undefined && st.length > 0) return st[st.length - 1];
    if (this.baseCache.has(prefix)) return this.baseCache.get(prefix);
    const v = lookupNs(this.baseScope, prefix);
    this.baseCache.set(prefix, v);
    return v;
  }

  private pushDecls(decls: Map<string, string>): void {
    for (const [p, u] of decls) {
      const st = this.bindings.get(p);
      if (st) st.push(u); else this.bindings.set(p, [u]);
    }
  }

  private popDecls(decls: Map<string, string> | null | undefined): void {
    if (!decls) return;
    for (const p of decls.keys()) this.bindings.get(p)!.pop();
  }

  /** Parse until done (returns true) or until `deadline` (Date.now() ms) passes (returns false). */
  run(deadline: number): boolean {
    const src = this.src;
    const len = this.len;
    let iter = 0;
    while (this.pos < len) {
      if ((++iter & 2047) === 0 && Date.now() >= deadline) return false;
      const pos = this.pos;
      let lt = src.indexOf('<', pos);
      if (lt < 0) lt = len;
      if (lt > pos) this.text(pos, lt);
      if (lt >= len) { this.pos = len; break; }
      const c = src.charCodeAt(lt + 1);
      if (c === 0x2F) this.endTag(lt);                 // '/'
      else if (c === 0x3F) this.pi(lt);                // '?'
      else if (c === 0x21) this.bang(lt);              // '!'
      else this.startTag(lt);
    }
    this.finish();
    return true;
  }

  private top(): ElImpl | undefined { return this.stack[this.stack.length - 1]; }

  private append(node: XmlNode): void {
    const top = this.top();
    if (top) { node.parent = top as unknown as XmlElement; top.children.push(node); }
    else if (this.fragment) { node.parent = this.fragParent; this.out.push(node); }
    // document mode, depth 0: prolog/epilog content is kept as raw text by the document
  }

  private atDocTop(): boolean { return !this.fragment && this.stack.length === 0; }

  private text(start: number, end: number): void {
    const raw = this.src.slice(start, end);
    if (this.atDocTop()) {
      let check = raw;
      if (start === 0 && raw.charCodeAt(0) === 0xFEFF) check = raw.slice(1);
      const bad = check.search(NOT_WS);
      if (bad >= 0) throw new XmlError('malformed', 'text outside the root element', start + bad + (raw === check ? 0 : 1));
      return;
    }
    checkRefs(raw, start);
    const cd = raw.indexOf(']]>');
    if (cd >= 0) throw new XmlError('malformed', '"]]>" is not allowed in text', start + cd);
    const node: TextImpl = { type: 'text', raw, parent: null };
    this.append(node as XmlText);
  }

  private pi(lt: number): void {
    const src = this.src;
    const end = src.indexOf('?>', lt + 2);
    if (end < 0) throw new XmlError('malformed', 'unterminated processing instruction', lt);
    let i = lt + 2;
    while (i < end && !isWs(src.charCodeAt(i))) i++;
    const target = src.slice(lt + 2, i);
    checkName(target, lt + 2);
    if (target.toLowerCase() === 'xml') {
      const declPos = src.charCodeAt(0) === 0xFEFF ? 1 : 0;
      if (this.fragment || lt !== declPos) throw new XmlError('malformed', 'XML declaration is only allowed at the start of the part', lt);
    }
    this.pos = end + 2;
    const node: TextImpl = { type: 'pi', raw: src.slice(lt, end + 2), parent: null };
    this.append(node as XmlText);
  }

  private bang(lt: number): void {
    const src = this.src;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('malformed', 'unterminated comment', lt);
      const body = src.slice(lt + 4, end);
      if (body.indexOf('--') >= 0 || body.endsWith('-')) throw new XmlError('malformed', '"--" is not allowed in a comment', lt);
      this.pos = end + 3;
      const node: TextImpl = { type: 'comment', raw: src.slice(lt, end + 3), parent: null };
      this.append(node as XmlText);
      return;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      if (this.atDocTop()) throw new XmlError('malformed', 'CDATA outside the root element', lt);
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('malformed', 'unterminated CDATA section', lt);
      this.pos = end + 3;
      const node: TextImpl = { type: 'cdata', raw: src.slice(lt, end + 3), parent: null };
      this.append(node as XmlText);
      return;
    }
    if (src.slice(lt, lt + 9).toUpperCase() === '<!DOCTYPE') {
      throw new XmlError('doctype', 'DOCTYPE declarations are not allowed', lt);
    }
    throw new XmlError('malformed', 'unexpected "<!"', lt);
  }

  private endTag(lt: number): void {
    const src = this.src;
    const gt = src.indexOf('>', lt + 2);
    if (gt < 0) throw new XmlError('malformed', 'unterminated end tag', lt);
    const top = this.stack.pop();
    if (!top) throw new XmlError('malformed', 'end tag without a matching start tag', lt);
    this.popDecls(this.declStack.pop());
    const name = top.rawName;
    let ok = src.startsWith(name, lt + 2);
    if (ok) {
      for (let i = lt + 2 + name.length; i < gt; i++) if (!isWs(src.charCodeAt(i))) { ok = false; break; }
    }
    if (!ok) throw new XmlError('malformed', `end tag does not match <${name}>`, lt);
    top._et = lt;
    top._e = gt + 1;
    this.pos = gt + 1;
  }

  private startTag(lt: number): void {
    const src = this.src;
    const len = this.len;
    let i = lt + 1;
    const nameStart = i;
    for (; i < len; i++) {
      const c = src.charCodeAt(i);
      if (isWs(c) || c === 0x2F || c === 0x3E) break;
      if (c === 0x3C || c === 0x26 || c === 0x22 || c === 0x27 || c === 0x3D) {
        throw new XmlError('malformed', 'invalid character in element name', i);
      }
    }
    if (i >= len) throw new XmlError('malformed', 'unterminated start tag', lt);
    const rawName = src.slice(nameStart, i);
    checkName(rawName, nameStart);
    if (this.baseDepth + this.stack.length + 1 > LIMITS.xmlMaxDepth) {
      throw new XmlError('malformed', `elements are nested more than ${LIMITS.xmlMaxDepth} deep`, lt);
    }

    const attrs: AttrImpl[] = [];
    let seen: Set<string> | null = null;   // raw attribute names, once there are more than a few
    let decls: Map<string, string> | null = null;
    let selfClosing = false;
    let tailStart: number;
    let stEnd: number;
    for (;;) {
      const wsStart = i;
      while (i < len && isWs(src.charCodeAt(i))) i++;
      if (i >= len) throw new XmlError('malformed', 'unterminated start tag', lt);
      let c = src.charCodeAt(i);
      if (c === 0x3E) { tailStart = wsStart; stEnd = i + 1; break; }
      if (c === 0x2F) {
        if (src.charCodeAt(i + 1) !== 0x3E) throw new XmlError('malformed', 'expected "/>"', i);
        tailStart = wsStart; stEnd = i + 2; selfClosing = true; break;
      }
      if (i === wsStart) throw new XmlError('malformed', 'whitespace is required before an attribute', i);
      if (attrs.length >= LIMITS.xmlMaxAttributes) {
        throw new XmlError('malformed', `more than ${LIMITS.xmlMaxAttributes} attributes on <${rawName}>`, i);
      }
      const an = i;
      for (; i < len; i++) {
        c = src.charCodeAt(i);
        if (isWs(c) || c === 0x3D || c === 0x3E || c === 0x2F) break;
        if (c === 0x3C || c === 0x26 || c === 0x22 || c === 0x27) throw new XmlError('malformed', 'invalid character in attribute name', i);
      }
      const aName = src.slice(an, i);
      checkName(aName, an);
      while (i < len && isWs(src.charCodeAt(i))) i++;
      if (src.charCodeAt(i) !== 0x3D) throw new XmlError('malformed', `attribute "${aName}" has no value`, i);
      i++;
      while (i < len && isWs(src.charCodeAt(i))) i++;
      const q = src.charCodeAt(i);
      if (q !== 0x22 && q !== 0x27) throw new XmlError('malformed', 'attribute value must be quoted', i);
      const vStart = i + 1;
      const vEnd = src.indexOf(q === 0x22 ? '"' : '\'', vStart);
      if (vEnd < 0) throw new XmlError('malformed', 'unterminated attribute value', i);
      const rawVal = src.slice(vStart, vEnd);
      const badLt = rawVal.indexOf('<');
      if (badLt >= 0) throw new XmlError('malformed', '"<" is not allowed in an attribute value', vStart + badLt);
      const value = decodeAttrValue(rawVal, vStart);
      i = vEnd + 1;
      if (seen) {
        if (seen.has(aName)) throw new XmlError('malformed', `duplicate attribute "${aName}"`, an);
        seen.add(aName);
      } else {
        for (const a of attrs) if (a.rawName === aName) throw new XmlError('malformed', `duplicate attribute "${aName}"`, an);
        if (attrs.length + 1 >= SMALL_ATTR_COUNT) {
          seen = new Set(attrs.map((a) => a.rawName));
          seen.add(aName);
        }
      }
      if (aName === 'xmlns') {
        (decls ??= new Map()).set('', value);
      } else if (aName.startsWith('xmlns:')) {
        const p = aName.slice(6);
        if (value === '') throw new XmlError('malformed', `namespace prefix "${p}" cannot be undeclared`, an);
        if (p === 'xmlns' || (p === 'xml') !== (value === XML_NS)) throw new XmlError('malformed', `reserved namespace binding "${aName}"`, an);
        (decls ??= new Map()).set(p, value);
      }
      attrs.push({ rawName: aName, ns: '', local: aName, value, raw: src.slice(an, i), pre: src.slice(wsStart, an) });
    }

    const parentScope = this.top()?._scope ?? this.baseScope;
    const scope: Scope = decls ? { map: decls, parent: parentScope } : parentScope;
    if (decls) this.pushDecls(decls);
    let ns: string;
    let local: string;
    const colon = rawName.indexOf(':');
    if (colon < 0) { ns = this.resolve('') ?? ''; local = rawName; }
    else {
      const p = rawName.slice(0, colon);
      const u = p === 'xmlns' ? undefined : this.resolve(p);
      if (u === undefined) throw new XmlError('malformed', `unbound namespace prefix "${p}"`, nameStart);
      ns = u; local = rawName.slice(colon + 1);
    }
    if (attrs.length > 0) this.resolveAttrs(attrs, lt);

    const el: ElImpl = {
      type: 'el', ns, local, rawName, attrs: attrs as XmlAttr[], children: [], parent: null,
      _src: src, _s: lt, _stEnd: stEnd, _tailStart: tailStart, _et: -1, _e: selfClosing ? stEnd : -1,
      _scope: scope, _tagDirty: false, _dirty: false, _origAttrs: null,
    };
    if (this.atDocTop()) {
      if (this.root) throw new XmlError('malformed', 'more than one root element', lt);
      this.root = el;
    } else {
      this.append(el as unknown as XmlElement);
    }
    if (selfClosing) this.popDecls(decls);
    else { this.stack.push(el); this.declStack.push(decls); }
    this.pos = stEnd;
  }

  private resolveAttrs(attrs: AttrImpl[], lt: number): void {
    let qualified = false;
    for (let k = 0; k < attrs.length; k++) {
      const a = attrs[k];
      const n = a.rawName;
      const colon = n.indexOf(':');
      if (n === 'xmlns') { attrs[k] = { ...a, ns: XMLNS_NS, local: 'xmlns' }; continue; }
      if (colon < 0) continue;                                  // unqualified: ns '' (default namespace does not apply)
      const p = n.slice(0, colon);
      let u: string | undefined;
      if (p === 'xmlns') u = XMLNS_NS;
      else u = this.resolve(p);
      if (u === undefined) throw new XmlError('malformed', `unbound namespace prefix "${p}" on attribute "${n}"`, lt);
      attrs[k] = { ...a, ns: u, local: n.slice(colon + 1) };
      qualified = true;
    }
    if (!qualified) return;   // raw names are already unique
    if (attrs.length <= SMALL_ATTR_COUNT) {
      for (let x = 0; x < attrs.length; x++) {
        for (let y = x + 1; y < attrs.length; y++) {
          if (attrs[x].ns === attrs[y].ns && attrs[x].local === attrs[y].local) {
            throw new XmlError('malformed', `duplicate attribute {${attrs[y].ns}}${attrs[y].local}`, lt);
          }
        }
      }
      return;
    }
    const expanded = new Set<string>();
    for (const a of attrs) {
      const key = '{' + a.ns + '}' + a.local;   // '}' cannot occur in a local name
      if (expanded.has(key)) throw new XmlError('malformed', `duplicate attribute ${key}`, lt);
      expanded.add(key);
    }
  }

  private finish(): void {
    const open = this.top();
    if (open) throw new XmlError('malformed', `element <${open.rawName}> is not closed`, open._s);
    if (!this.fragment && !this.root) throw new XmlError('malformed', 'no root element', this.len);
  }

  doc(): XmlDoc {
    const root = this.root!;
    const d: DocImpl = {
      root: root as unknown as XmlElement, _src: this.src,
      _prolog: this.src.slice(0, root._s), _epilog: this.src.slice(root._e),
    };
    return d;
  }
}

/** Parse a whole part. Throws XmlError. */
export function parseXml(text: string): XmlDoc {
  const p = new Parser(text, false, BASE_SCOPE, null);
  p.run(Infinity);
  return p.doc();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/** Parse a whole part, yielding to the event loop at least every `yieldEveryMs` ms (§10.2). Rejects with XmlError. */
export async function parseXmlAsync(text: string, yieldEveryMs: number = LIMITS.parseYieldMs): Promise<XmlDoc> {
  const p = new Parser(text, false, BASE_SCOPE, null);
  while (!p.run(Date.now() + yieldEveryMs)) await yieldToEventLoop();
  return p.doc();
}

function depthOf(el: XmlElement): number {
  let d = 0;
  for (let p: XmlElement | null = el; p; p = p.parent) d++;
  return d;
}

function parseFragmentIn(xml: string, scope: Scope, parent: XmlElement | null, baseDepth: number): XmlNode[] {
  const p = new Parser(xml, true, scope, parent, baseDepth);
  p.run(Infinity);
  return p.out;
}

/** Parse a fragment with the root's namespace bindings in scope. The nodes are detached (parent null). */
export function parseFragment(doc: XmlDoc, xml: string): XmlNode[] {
  return parseFragmentIn(xml, impl(doc.root)._scope, null, 1);
}

// ---------------------------------------------------------------------------------------------------
// Serialisation

function isDoc(x: XmlDoc | XmlNode): x is XmlDoc {
  return (x as XmlDoc).root !== undefined && (x as XmlNode).type === undefined;
}

function buildStartTag(el: ElImpl): string {
  let s = '<' + el.rawName;
  for (const a of el.attrs) s += (a as AttrImpl).pre + a.raw;
  return s + el._src.slice(el._tailStart, el._stEnd);
}

/**
 * Iterative (an explicit stack, no recursion), so a deep tree built through insertAt cannot overflow
 * the call stack. Only dirty elements are descended into; clean subtrees are one source slice.
 */
function serializeEl(root: ElImpl): string {
  const out: string[] = [];
  const stack: { el: ElImpl; k: number }[] = [];
  /** Emit `el`, or its start tag and push it when its children must be emitted one by one. */
  const open = (el: ElImpl): void => {
    if (!el._dirty && !el._tagDirty) { out.push(el._src.slice(el._s, el._e)); return; }
    const start = el._tagDirty ? buildStartTag(el) : el._src.slice(el._s, el._stEnd);
    if (!el._dirty) { out.push(start + el._src.slice(el._stEnd, el._e)); return; }
    const selfClosingSrc = el._et < 0;
    if (el.children.length === 0) { out.push(selfClosingSrc ? start : start + el._src.slice(el._et, el._e)); return; }
    // A self-closing element that gained children opens with `>` and gets a plain end tag; once it is
    // empty again it serialises in its original `/>` form.
    out.push(selfClosingSrc ? start.slice(0, -2) + '>' : start);
    stack.push({ el, k: 0 });
  };
  open(root);
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    const kids = f.el.children;
    if (f.k < kids.length) {
      const n = kids[f.k++];
      if (n.type === 'el') open(impl(n)); else out.push(n.raw);
    } else {
      stack.pop();
      out.push(f.el._et < 0 ? '</' + f.el.rawName + '>' : f.el._src.slice(f.el._et, f.el._e));
    }
  }
  return out.join('');
}

/** Serialise a document or node. An unmodified node serialises as its exact source slice. */
export function serialize(node: XmlDoc | XmlNode): string {
  if (isDoc(node)) {
    const d = node as DocImpl;
    const root = impl(d.root);
    if (!root._dirty && !root._tagDirty) return d._src;
    return d._prolog + serializeEl(root) + d._epilog;
  }
  return node.type === 'el' ? serializeEl(impl(node)) : node.raw;
}

// ---------------------------------------------------------------------------------------------------
// Mutation

/** Mark `el` and every ancestor as having modified children. Invariant: dirty => all ancestors dirty. */
function markDirty(el: XmlElement | null): void {
  for (let p = el; p && !impl(p)._dirty; p = p.parent) impl(p)._dirty = true;
}

function checkIndex(parent: XmlElement, index: number, allowEnd: boolean): void {
  const max = allowEnd ? parent.children.length : parent.children.length - 1;
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new RangeError(`child index ${index} out of range 0..${max} for <${parent.rawName}>`);
  }
}

/** Options for `insertAt` / `replaceNode`. */
export interface FragmentOptions {
  /**
   * The fragment's names were chosen for the root's bindings (with `qname`). Require every element
   * and attribute of it to resolve at the insertion site to the same namespace as at the root;
   * throws XmlScopeError (and changes nothing) when a prefix is redeclared or unbound in between or
   * the default namespace differs. Without it, the fragment is simply parsed in the insertion
   * site's scope (right for re-inserting source text that came from that site, e.g. undo).
   */
  readonly rootScoped?: boolean;
}

/** Elements and attributes of `nodes` in document order, as [rawName, ns] pairs. */
function namesOf(nodes: readonly XmlNode[]): [string, string][] {
  const out: [string, string][] = [];
  const stack: XmlNode[] = [];
  for (let k = nodes.length - 1; k >= 0; k--) stack.push(nodes[k]);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type !== 'el') continue;
    out.push([n.rawName, n.ns]);
    for (const a of n.attrs) out.push([a.rawName, a.ns]);
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return out;
}

/** Throw XmlScopeError unless `xml` (already parsed at the site as `nodes`) means the same at the root. */
function checkRootScoped(parent: XmlElement, xml: string, nodes: readonly XmlNode[]): void {
  let root: XmlElement = parent;
  while (root.parent) root = root.parent;
  const rootScope = impl(root)._scope;
  if (impl(parent)._scope === rootScope) return;   // same bindings: nothing can differ
  let atRoot: XmlNode[];
  try {
    atRoot = parseFragmentIn(xml, rootScope, null, 1);
  } catch (e) {
    // It parsed at the site, so the only thing that can fail at the root is an unbound prefix.
    if (e instanceof XmlError) throw new XmlScopeError('', '', '', `fragment is not expressible with the root's namespace bindings: ${e.message}`);
    throw e;
  }
  const a = namesOf(atRoot);
  const b = namesOf(nodes);
  for (let k = 0; k < b.length; k++) {
    if (a[k][1] !== b[k][1]) throw new XmlScopeError(b[k][0], a[k][1], b[k][1]);
  }
}

/**
 * Replace `target` with the nodes parsed from `xml` (may be empty: removal). Marks ancestors modified.
 * `xml` is parsed in the parent's scope; see FragmentOptions.rootScoped.
 */
export function replaceNode(target: XmlNode, xml: string, opts?: FragmentOptions): XmlNode[] {
  const parent = target.parent;
  if (!parent) throw new Error('replaceNode: the node has no parent (the root element cannot be replaced)');
  const index = parent.children.indexOf(target);
  if (index < 0) throw new Error('replaceNode: the node is not a child of its parent');
  const nodes = parseFragmentIn(xml, impl(parent)._scope, parent, depthOf(parent));
  if (opts?.rootScoped) checkRootScoped(parent, xml, nodes);
  parent.children.splice(index, 1, ...nodes);
  target.parent = null;
  markDirty(parent);
  return nodes;
}

/**
 * Insert the nodes parsed from `xml` before child `childIndex` (or at the end). No whitespace is added.
 * `xml` is parsed in the parent's scope; see FragmentOptions.rootScoped.
 */
export function insertAt(parent: XmlElement, childIndex: number, xml: string, opts?: FragmentOptions): XmlNode[] {
  checkIndex(parent, childIndex, true);
  const nodes = parseFragmentIn(xml, impl(parent)._scope, parent, depthOf(parent));
  if (opts?.rootScoped) checkRootScoped(parent, xml, nodes);
  if (nodes.length === 0) return nodes;
  parent.children.splice(childIndex, 0, ...nodes);
  markDirty(parent);
  return nodes;
}

/** Remove child `childIndex` and return its serialised source. Adjacent text nodes are never merged. */
export function removeAt(parent: XmlElement, childIndex: number): string {
  checkIndex(parent, childIndex, false);
  const [node] = parent.children.splice(childIndex, 1);
  const s = serialize(node);
  node.parent = null;
  markDirty(parent);
  return s;
}

function sameAttrs(a: readonly XmlAttr[], b: readonly XmlAttr[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k].ns !== b[k].ns || a[k].local !== b[k].local || a[k].value !== b[k].value) return false;
  }
  return true;
}

/**
 * Set (`value` string) or remove (`value` null) one attribute. Only the start tag is rewritten: the
 * other attributes keep their order, quote style, whitespace and raw text. An attribute that existed at
 * parse time and is set back to its original value gets its original raw text and position back, and
 * once every attribute is back to its parsed state the start tag is emitted from the source again (G5).
 * Throws if `local` is not an NCName (no colon: the prefix comes from `ns`), if `ns` is not bound to a
 * prefix in scope (namespaced attributes need a prefix), or for a namespace declaration (`ns` the
 * xmlns namespace, or unqualified `xmlns`): declarations are never edited.
 */
export function setAttr(el: XmlElement, ns: string, local: string, value: string | null): void {
  const e = impl(el);
  if (!isNcName(local)) throw new Error(`setAttr: "${local}" is not a valid attribute local name (NCName)`);
  if (ns === XMLNS_NS || (ns === '' && local === 'xmlns')) throw new Error('setAttr: namespace declarations cannot be edited');
  const attrs = el.attrs;
  const idx = attrs.findIndex((a) => a.ns === ns && a.local === local);
  if (value === null ? idx < 0 : idx >= 0 && attrs[idx].value === value) return;   // no change

  const orig = (e._origAttrs ??= (attrs as AttrImpl[]).slice());
  const origIdx = orig.findIndex((a) => a.ns === ns && a.local === local);
  const o = origIdx >= 0 ? orig[origIdx] : undefined;

  if (value === null) {
    attrs.splice(idx, 1);
  } else if (idx >= 0) {
    const cur = attrs[idx] as AttrImpl;
    attrs[idx] = o && o.value === value ? o : rebuildAttr(cur, value);
  } else if (o) {
    // Re-adding an attribute that was parsed: put it back after the nearest preceding original attribute.
    let at = 0;
    for (let k = origIdx - 1; k >= 0; k--) {
      const p = attrs.indexOf(orig[k]);
      const q = p >= 0 ? p : attrs.findIndex((a) => a.ns === orig[k].ns && a.local === orig[k].local);
      if (q >= 0) { at = q + 1; break; }
    }
    attrs.splice(at, 0, o.value === value ? o : rebuildAttr(o, value));
  } else {
    let rawName = local;
    if (ns !== '') {
      const prefix = prefixFor(e._scope, ns);
      if (prefix === undefined) throw new Error(`setAttr: namespace ${ns} is not bound to a prefix on <${el.rawName}>`);
      rawName = prefix + ':' + local;
    }
    const last = attrs[attrs.length - 1];
    const quote = last ? last.raw[last.raw.length - 1] : '"';
    const added: AttrImpl = { rawName, ns, local, value, raw: rawName + '=' + quote + escapeAttrFor(value, quote) + quote, pre: ' ' };
    attrs.push(added);
  }

  if (sameAttrs(attrs, orig)) {
    attrs.splice(0, attrs.length, ...orig);
    e._tagDirty = false;
  } else {
    e._tagDirty = true;
  }
  markDirty(el.parent);
}

function rebuildAttr(a: AttrImpl, value: string): AttrImpl {
  const quote = a.raw[a.raw.length - 1];
  const open = a.raw.indexOf(quote);
  return { rawName: a.rawName, ns: a.ns, local: a.local, value, raw: a.raw.slice(0, open + 1) + escapeAttrFor(value, quote) + quote, pre: a.pre };
}

/** A non-default prefix bound to `ns` in `scope` and not shadowed by an inner declaration. O(declarations in scope). */
function prefixFor(scope: Scope, ns: string): string | undefined {
  const shadowed = new Set<string>();   // prefixes already bound by an inner scope
  for (let s: Scope | null = scope; s; s = s.parent) {
    for (const [p, u] of s.map) {
      if (shadowed.has(p)) continue;
      if (p !== '' && u === ns) return p;
      shadowed.add(p);
    }
  }
  return undefined;
}

const NC_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D'
  + '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NC_NAME = new RegExp(`^[${NC_START}][${NC_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`, 'u');

/** XML Namespaces NCName: an XML Name without colons. */
function isNcName(s: string): boolean {
  return NC_NAME.test(s);
}

// ---------------------------------------------------------------------------------------------------
// Navigation and queries

/** Child-node indexes from the root element down to `node`, counting every node kind. Root (or detached) => []. */
export function pathOf(node: XmlNode): number[] {
  const path: number[] = [];
  for (let n: XmlNode = node; n.parent; n = n.parent) {
    const i = n.parent.children.indexOf(n);
    if (i < 0) throw new Error('pathOf: node is not a child of its parent');
    path.push(i);
  }
  return path.reverse();
}

export function nodeAt(doc: XmlDoc, path: readonly number[]): XmlNode | undefined {
  let n: XmlNode = doc.root;
  for (const i of path) {
    if (n.type !== 'el') return undefined;
    const next: XmlNode | undefined = n.children[i];
    if (!next) return undefined;
    n = next;
  }
  return n;
}

export function child(el: XmlElement, ns: string, local: string): XmlElement | undefined {
  for (const c of el.children) if (c.type === 'el' && c.local === local && c.ns === ns) return c;
  return undefined;
}

export function childrenOf(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.type === 'el' && c.local === local && c.ns === ns) out.push(c);
  return out;
}

/** Decoded value of an attribute; `ns` '' = unqualified. */
export function attr(el: XmlElement, ns: string, local: string): string | undefined {
  for (const a of el.attrs) if (a.local === local && a.ns === ns) return a.value;
  return undefined;
}

/** Concatenated decoded character data (text and CDATA) of all descendants. */
export function textContent(el: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [];
  for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'el') {
      for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
    } else if (n.type === 'text') {
      out += decodeRefs(normalizeEol(n.raw));
    } else if (n.type === 'cdata') {
      out += normalizeEol(n.raw.slice(9, -3));
    }
  }
  return out;
}

/**
 * Qualified name to use for a new element in namespace `ns`, using the bindings declared on the root:
 * the default namespace when it is `ns`, else a prefix bound to `ns`; undefined when `ns` is not bound
 * at the root (the part is then not editable, §3.3).
 */
export function qname(doc: XmlDoc, ns: string, local: string): string | undefined {
  return qnameIn(impl(doc.root)._scope, ns, local);
}

/**
 * As `qname`, but for a new child of `parent`: uses the bindings in scope at `parent` (its own
 * declarations and its ancestors'), so the name means `ns` there even where a prefix is redeclared or
 * the default namespace is changed below the root. Undefined when `ns` cannot be written there without
 * adding a declaration.
 */
export function qnameAt(parent: XmlElement, ns: string, local: string): string | undefined {
  return qnameIn(impl(parent)._scope, ns, local);
}

function qnameIn(scope: Scope, ns: string, local: string): string | undefined {
  const def = lookupNs(scope, '') ?? '';
  if (def === ns) return local;
  if (ns === '') return undefined;
  const p = prefixFor(scope, ns);
  return p === undefined ? undefined : p + ':' + local;
}
