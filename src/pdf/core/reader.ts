// Strict PDF object reader (spec §3.3, §9.3; plan PWP-14).
//
// The host-side, dependency-free reader that classification (§6.2) and the save verifier (§6.5) build on.
// Its input is untrusted and it runs in the extension host, so it REFUSES rather than recovers, and every
// loop and allocation is bounded by a cap from `limits.ts`. Failure is always a `PdfReadError` with a code;
// messages carry offsets and object numbers only, never document content.
//
// Scope: header and `startxref`; classic cross-reference tables and cross-reference streams; the `/Prev`
// chain; object streams; a tokeniser and parser for PDF objects that skips stream bodies by `/Length`;
// FlateDecode (with PNG predictors) through `node:zlib`. Out of scope, refused: encryption (`encrypted`),
// hybrid-reference files (`/XRefStm`, `hybrid`), repair of damaged cross-references (`bad-xref`).
//
// LAZY by design (spike S4): `openPdf` parses the cross-reference chain and checks each in-use entry's
// `N G obj` header; objects are tokenised only when `resolve` asks for them. There is no code path that
// tokenises the whole body. Opening yields to the event loop every `yieldIntervalMs` for files over
// `asyncParseThresholdBytes` (`openPdf`); `openPdfSync` is the same work without yielding.
//
// No `vscode` import, no npm package (core rule 1).

import { inflateSync } from 'node:zlib';
import { PDF_LIMITS } from './limits.js';

// ------------------------------------------------------------------ errors

export type PdfReadErrorCode =
  | 'no-header'      // no `%PDF-` in the first 1,024 bytes
  | 'no-startxref'   // no `startxref N %%EOF` at the end of the file
  | 'bad-xref'       // a cross-reference section or entry is wrong (offsets, headers, ranges, duplicates)
  | 'prev-cycle'     // the /Prev chain revisits a section
  | 'hybrid'         // a trailer has /XRefStm
  | 'encrypted'      // a trailer has /Encrypt
  | 'objstm'         // an object stream is malformed or does not hold the object the xref says it does
  | 'too-large'      // a §9.3 cap was exceeded
  | 'malformed';     // object syntax, stream framing, unsupported filter, reference cycle

export class PdfReadError extends Error {
  readonly code: PdfReadErrorCode;
  /** Byte offset (in the file, or in a decoded object stream for `objstm`) where the problem was found. */
  readonly offset: number | undefined;
  constructor(code: PdfReadErrorCode, message: string, offset?: number) {
    super(offset === undefined ? `${code}: ${message}` : `${code}: ${message} (offset ${offset})`);
    this.name = 'PdfReadError';
    this.code = code;
    this.offset = offset;
  }
}

function fail(code: PdfReadErrorCode, message: string, offset?: number): never {
  throw new PdfReadError(code, message, offset);
}

// ------------------------------------------------------------------ limits

/** The caps the reader enforces (spec §9.3), plus the yielding parameters. */
export interface ReaderLimits {
  maxXrefEntries: number;
  maxObjectNesting: number;
  maxRevisions: number;
  maxObjectStreamBytes: number;
  maxDictionaryBytes: number;
  asyncParseThresholdBytes: number;
  yieldIntervalMs: number;
}

function readerLimits(over: Partial<ReaderLimits> | undefined): ReaderLimits {
  return {
    maxXrefEntries: PDF_LIMITS.maxXrefEntries,
    maxObjectNesting: PDF_LIMITS.maxObjectNesting,
    maxRevisions: PDF_LIMITS.maxRevisions,
    maxObjectStreamBytes: PDF_LIMITS.maxObjectStreamBytes,
    maxDictionaryBytes: PDF_LIMITS.maxDictionaryBytes,
    asyncParseThresholdBytes: PDF_LIMITS.asyncParseThresholdBytes,
    yieldIntervalMs: PDF_LIMITS.yieldIntervalMs,
    ...over,
  };
}

/** Longest keyword/number run, and longest name, the lexer accepts (ISO 32000 implementation limits are far lower). */
const MAX_RUN = 255;
const MAX_NAME = 4096;
/** Nested resolutions (a stream's indirect /Length inside another object stream ...) deeper than this are refused. */
const MAX_RESOLVE_DEPTH = 32;
/** Decoded object streams kept in memory at once: this many times `maxObjectStreamBytes`. */
const OBJSTM_CACHE_FACTOR = 2;

// ------------------------------------------------------------------ values

/** Byte span of a value: offsets into `PdfIndirectObject.source` (the file, or a decoded object stream). */
export interface PdfSpan { start: number; end: number }
export interface PdfNull extends PdfSpan { kind: 'null' }
export interface PdfBool extends PdfSpan { kind: 'bool'; value: boolean }
export interface PdfNumber extends PdfSpan { kind: 'number'; value: number; integer: boolean }
/** `value` is the decoded name (`#xx` escapes applied) without the slash; one char per byte (latin1). */
export interface PdfName extends PdfSpan { kind: 'name'; value: string }
/** `bytes` is the decoded string (escapes applied); `hex` records the token form. */
export interface PdfString extends PdfSpan { kind: 'string'; bytes: Uint8Array; hex: boolean }
export interface PdfArray extends PdfSpan { kind: 'array'; items: PdfValue[] }
/** Keys are decoded names without the slash, in source order. A `null` value is kept as written. */
export interface PdfDict extends PdfSpan { kind: 'dict'; entries: Map<string, PdfValue> }
export interface PdfRef extends PdfSpan { kind: 'ref'; num: number; gen: number }
export type PdfValue = PdfNull | PdfBool | PdfNumber | PdfName | PdfString | PdfArray | PdfDict | PdfRef;
/** An indirect stream object: the dictionary plus the body's byte range in the file (never read until asked). */
export interface PdfStream extends PdfSpan { kind: 'stream'; dict: PdfDict; dataStart: number; dataEnd: number }

export interface PdfIndirectObject {
  num: number;
  gen: number;
  value: PdfValue | PdfStream;
  location: { kind: 'offset'; offset: number } | { kind: 'objstm'; stream: number; index: number };
  /** The bytes the spans of `value` index into: the file, or the decoded object stream. */
  source: Uint8Array;
}

// ------------------------------------------------------------------ cross-reference model

export type XrefEntry =
  | { num: number; type: 'free'; gen: number; nextFree: number }
  | { num: number; type: 'offset'; gen: number; offset: number }
  | { num: number; type: 'objstm'; gen: 0; stream: number; index: number };

export interface PdfRevision {
  /** 0 = the original file; the last one is the newest. */
  index: number;
  /** Offset of this cross-reference section (what `startxref` or the next section's /Prev holds). */
  startxref: number;
  kind: 'table' | 'stream';
  /** The trailer dictionary (for a cross-reference stream: the stream's dictionary). */
  trailer: PdfDict;
  /** /Size of this section's trailer. */
  size: number;
  /** /Prev of this section, or null for the oldest. */
  prev: number | null;
  /** Object number of the cross-reference stream (kind 'stream' only). */
  xrefStreamNum: number | null;
  /** First byte after the section (after the trailer dictionary, or after the stream's `endobj`). */
  sectionEnd: number;
  entryCount: number;
  entries(): IterableIterator<XrefEntry>;
  /** This section's entry for `num`, if it has one. */
  entry(num: number): XrefEntry | undefined;
}

export interface PdfFile {
  readonly bytes: Uint8Array;
  /** `x.y` from the `%PDF-x.y` header. */
  readonly headerVersion: string;
  readonly headerOffset: number;
  /** Oldest first. */
  readonly revisions: readonly PdfRevision[];
  /** Trailer of the newest section. */
  readonly trailer: PdfDict;
  /** /Size of the newest section. */
  readonly size: number;
  /** Kind of the newest section. */
  readonly xrefKind: 'table' | 'stream';
  /** Value of the final `startxref`. */
  readonly startxref: number;
  /** In-use objects in the merged (newest-wins) cross-reference view. */
  readonly objectCount: number;
  /** Merged entry for `num` (newest section that lists it). */
  entry(num: number): XrefEntry | undefined;
  /** Numbers of every in-use object in the merged view, ascending. */
  objectNumbers(): IterableIterator<number>;
  /** Parse one object on demand. Null for a free or absent number, or a generation mismatch. */
  resolve(num: number, gen?: number): PdfIndirectObject | null;
  /** A value, or the value an (indirect) reference points to; null for a dangling reference. */
  deref(value: PdfValue | PdfStream | undefined): PdfValue | PdfStream | null;
  /** Source text (latin1) of the object's value; for a stream, of its dictionary. Null when absent. */
  objectText(num: number, gen?: number): string | null;
  /** The raw (still encoded) body of a stream. */
  streamData(stream: PdfStream): Uint8Array;
  /** The decoded body of a stream (no filter, or FlateDecode with an optional PNG predictor). */
  decodeStream(stream: PdfStream, maxBytes?: number): Uint8Array;
}

// ------------------------------------------------------------------ character classes

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}
function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  return s;
}
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const INT_RE = /^[+-]?\d+$/;

// ------------------------------------------------------------------ tokeniser

export type PdfToken =
  | { type: 'number'; value: number; integer: boolean; start: number; end: number }
  | { type: 'name'; value: string; start: number; end: number }
  | { type: 'string'; bytes: Uint8Array; hex: boolean; start: number; end: number }
  | { type: 'keyword'; value: string; start: number; end: number }
  | { type: 'punct'; value: '<<' | '>>' | '[' | ']'; start: number; end: number }
  | { type: 'eof'; start: number; end: number };

class Lexer {
  private pos: number;
  private readonly queue: PdfToken[] = [];
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
    private readonly maxTokenBytes: number,
  ) { this.pos = start; }

  next(): PdfToken { return this.queue.length ? this.queue.shift()! : this.scan(); }
  peek(k: number): PdfToken {
    while (this.queue.length <= k) this.queue.push(this.scan());
    return this.queue[k];
  }

  private scan(): PdfToken {
    const b = this.bytes; const end = this.end;
    let p = this.pos;
    for (;;) { // whitespace and comments
      while (p < end && WS[b[p]]) p++;
      if (p < end && b[p] === 0x25) { while (p < end && b[p] !== 10 && b[p] !== 13) p++; continue; }
      break;
    }
    if (p >= end) { this.pos = end; return { type: 'eof', start: end, end }; }
    const c = b[p];
    const start = p;
    if (c === 0x2F) { // name
      p++;
      let s = '';
      while (p < end && !WS[b[p]] && !DELIM[b[p]]) {
        let ch = b[p];
        if (ch === 0x23) {
          if (p + 2 >= end || hexVal(b[p + 1]) < 0 || hexVal(b[p + 2]) < 0) fail('malformed', 'bad #xx escape in a name', p);
          ch = (hexVal(b[p + 1]) << 4) | hexVal(b[p + 2]); p += 3;
        } else p++;
        s += String.fromCharCode(ch);
        if (s.length > MAX_NAME) fail('malformed', 'name too long', start);
      }
      this.pos = p;
      return { type: 'name', value: s, start, end: p };
    }
    if (c === 0x28) return this.literalString(start);
    if (c === 0x3C) {
      if (p + 1 < end && b[p + 1] === 0x3C) { this.pos = p + 2; return { type: 'punct', value: '<<', start, end: p + 2 }; }
      return this.hexString(start);
    }
    if (c === 0x3E) {
      if (p + 1 < end && b[p + 1] === 0x3E) { this.pos = p + 2; return { type: 'punct', value: '>>', start, end: p + 2 }; }
      fail('malformed', "stray '>'", p);
    }
    if (c === 0x5B || c === 0x5D) { this.pos = p + 1; return { type: 'punct', value: c === 0x5B ? '[' : ']', start, end: p + 1 }; }
    if (DELIM[c]) fail('malformed', 'unexpected delimiter', p); // ) { }
    while (p < end && !WS[b[p]] && !DELIM[b[p]]) {
      p++;
      if (p - start > MAX_RUN) fail('malformed', 'token too long', start);
    }
    this.pos = p;
    const text = latin1(b, start, p);
    if (NUMBER_RE.test(text)) return { type: 'number', value: Number(text), integer: INT_RE.test(text), start, end: p };
    return { type: 'keyword', value: text, start, end: p };
  }

  private literalString(start: number): PdfToken {
    const b = this.bytes; const end = this.end;
    let depth = 1; let i = start + 1;
    for (; i < end; i++) { // pass 1: find the closing parenthesis
      const c = b[i];
      if (c === 0x5C) { i++; continue; }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      if (i - start > this.maxTokenBytes) fail('too-large', 'string over the token cap', start);
    }
    if (i >= end) fail('malformed', 'unterminated string', start);
    const close = i;
    const out = new Uint8Array(close - start);
    let n = 0;
    for (let j = start + 1; j < close; j++) { // pass 2: decode
      const c = b[j];
      if (c === 0x5C) {
        const e = b[++j];
        switch (e) {
          case 0x6E: out[n++] = 10; break; case 0x72: out[n++] = 13; break; case 0x74: out[n++] = 9; break;
          case 0x62: out[n++] = 8; break; case 0x66: out[n++] = 12; break;
          case 0x28: case 0x29: case 0x5C: out[n++] = e; break;
          case 13: if (b[j + 1] === 10) j++; break; // line continuation
          case 10: break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let k = 0; k < 2 && b[j + 1] >= 0x30 && b[j + 1] <= 0x37 && j + 1 < close; k++) v = v * 8 + (b[++j] - 0x30);
              out[n++] = v & 0xFF;
            } else out[n++] = e; // unknown escape: the backslash is ignored
        }
      } else if (c === 13) { out[n++] = 10; if (b[j + 1] === 10 && j + 1 < close) j++; } else out[n++] = c;
    }
    this.pos = close + 1;
    return { type: 'string', bytes: out.slice(0, n), hex: false, start, end: close + 1 };
  }

  private hexString(start: number): PdfToken {
    const b = this.bytes; const end = this.end;
    let i = start + 1;
    while (i < end && b[i] !== 0x3E) {
      if (!WS[b[i]] && hexVal(b[i]) < 0) fail('malformed', 'bad character in a hex string', i);
      i++;
      if (i - start > this.maxTokenBytes) fail('too-large', 'string over the token cap', start);
    }
    if (i >= end) fail('malformed', 'unterminated hex string', start);
    const out = new Uint8Array((i - start) >> 1);
    let n = 0; let hi = -1;
    for (let j = start + 1; j < i; j++) {
      const v = hexVal(b[j]);
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out[n++] = (hi << 4) | v; hi = -1; }
    }
    if (hi >= 0) out[n++] = hi << 4;
    this.pos = i + 1;
    return { type: 'string', bytes: out.slice(0, n), hex: true, start, end: i + 1 };
  }
}

/**
 * Tokens of `bytes[start, end)`, one at a time. Caller-driven: nothing in the reader calls this over a whole file.
 * Throws `PdfReadError` on a lexical error.
 */
export function* tokenise(bytes: Uint8Array, start = 0, end = bytes.length, limits?: Partial<ReaderLimits>): Generator<PdfToken, void> {
  const lx = new Lexer(bytes, start, Math.min(end, bytes.length), readerLimits(limits).maxDictionaryBytes);
  for (;;) {
    const t = lx.next();
    if (t.type === 'eof') return;
    yield t;
  }
}

// ------------------------------------------------------------------ object parser

function parseValue(lx: Lexer, depth: number, lim: ReaderLimits): PdfValue {
  const t = lx.next();
  switch (t.type) {
    case 'number': {
      if (t.integer && t.value >= 0) {
        const a = lx.peek(0);
        if (a.type === 'number' && a.integer && a.value >= 0) {
          const r = lx.peek(1);
          if (r.type === 'keyword' && r.value === 'R') {
            lx.next(); lx.next();
            if (t.value > 0x7FFFFFFF || a.value > 0xFFFF) fail('malformed', 'reference out of range', t.start);
            return { kind: 'ref', num: t.value, gen: a.value, start: t.start, end: r.end };
          }
        }
      }
      return { kind: 'number', value: t.value, integer: t.integer, start: t.start, end: t.end };
    }
    case 'name': return { kind: 'name', value: t.value, start: t.start, end: t.end };
    case 'string': return { kind: 'string', bytes: t.bytes, hex: t.hex, start: t.start, end: t.end };
    case 'keyword':
      if (t.value === 'true' || t.value === 'false') return { kind: 'bool', value: t.value === 'true', start: t.start, end: t.end };
      if (t.value === 'null') return { kind: 'null', start: t.start, end: t.end };
      return fail('malformed', 'unexpected keyword', t.start);
    case 'punct': {
      if (t.value === '>>' || t.value === ']') fail('malformed', 'unbalanced container end', t.start);
      if (depth + 1 > lim.maxObjectNesting) fail('too-large', 'object nesting over the cap', t.start);
      const start = t.start;
      if (t.value === '[') {
        const items: PdfValue[] = [];
        for (;;) {
          const n = lx.peek(0);
          if (n.type === 'punct' && n.value === ']') { lx.next(); return { kind: 'array', items, start, end: n.end }; }
          if (n.type === 'eof') fail('malformed', 'unterminated array', start);
          items.push(parseValue(lx, depth + 1, lim));
          if (items[items.length - 1].end - start > lim.maxDictionaryBytes) fail('too-large', 'array over the size cap', start);
        }
      }
      const entries = new Map<string, PdfValue>();
      for (;;) {
        const k = lx.next();
        if (k.type === 'punct' && k.value === '>>') return { kind: 'dict', entries, start, end: k.end };
        if (k.type === 'eof') fail('malformed', 'unterminated dictionary', start);
        if (k.type !== 'name') fail('malformed', 'dictionary key is not a name', k.start);
        if (entries.has(k.value)) fail('malformed', 'duplicate dictionary key', k.start);
        const v = parseValue(lx, depth + 1, lim);
        entries.set(k.value, v);
        if (v.end - start > lim.maxDictionaryBytes) fail('too-large', 'dictionary over the size cap', start);
      }
    }
    case 'eof': return fail('malformed', 'unexpected end of data', t.start);
  }
}

/**
 * Parse one direct value (dictionary, array, name, number, string, reference, boolean or null) at `offset`.
 * Streams are not recognised here (they exist only as indirect objects: see `PdfFile.resolve`).
 */
export function parseObject(bytes: Uint8Array, offset = 0, limits?: Partial<ReaderLimits>): { value: PdfValue; end: number } {
  const lim = readerLimits(limits);
  const value = parseValue(new Lexer(bytes, offset, bytes.length, lim.maxDictionaryBytes), 0, lim);
  return { value, end: value.end };
}

// ------------------------------------------------------------------ small helpers

const getInt = (d: PdfDict, key: string): number | undefined => {
  const v = d.entries.get(key);
  return v && v.kind === 'number' && v.integer ? v.value : undefined;
};
const getName = (d: PdfDict, key: string): string | undefined => {
  const v = d.entries.get(key);
  return v && v.kind === 'name' ? v.value : undefined;
};
function matchAt(b: Uint8Array, p: number, text: string): boolean {
  if (p < 0 || p + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) if (b[p + k] !== text.charCodeAt(k)) return false;
  return true;
}
function lastIndexOf(b: Uint8Array, text: string, from: number): number {
  for (let i = b.length - text.length; i >= Math.max(0, from); i--) if (matchAt(b, i, text)) return i;
  return -1;
}
/** Unsigned decimal at `p` (no sign); returns [value, end] or null. Stops at 15 digits. */
function readUint(b: Uint8Array, p: number): [number, number] | null {
  const s = p; let v = 0;
  while (p < b.length && isDigit(b[p]) && p - s < 15) { v = v * 10 + (b[p] - 0x30); p++; }
  return p === s || (p < b.length && isDigit(b[p])) ? null : [v, p];
}
const skipWs = (b: Uint8Array, p: number) => { while (p < b.length && WS[b[p]]) p++; return p; };

/** Fast check that an `N G obj` header for (num, gen) starts exactly at `off`. */
function headerMatches(b: Uint8Array, off: number, num: number, gen: number): boolean {
  const a = readUint(b, off);
  if (!a || a[0] !== num || !WS[b[a[1]]]) return false;
  const g = readUint(b, skipWs(b, a[1]));
  if (!g || g[0] !== gen || !WS[b[g[1]]]) return false;
  const p = skipWs(b, g[1]);
  return matchAt(b, p, 'obj') && (p + 3 >= b.length || WS[b[p + 3]] === 1 || DELIM[b[p + 3]] === 1);
}

// ------------------------------------------------------------------ stream decoding

function inflateCapped(data: Uint8Array, maxBytes: number, what: string, offset: number): Uint8Array {
  try {
    const out = inflateSync(data, { maxOutputLength: Math.max(1, maxBytes) });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') fail('too-large', `${what} inflates over the cap`, offset);
    return fail('malformed', `${what}: corrupt Flate data`, offset);
  }
}

function unpredict(data: Uint8Array, parms: PdfDict | null, offset: number): Uint8Array {
  const predictor = parms ? getInt(parms, 'Predictor') ?? 1 : 1;
  if (predictor === 1) return data;
  if (predictor < 10 || predictor > 15) fail('malformed', 'unsupported predictor', offset);
  const colors = getInt(parms!, 'Colors') ?? 1;
  const bpc = getInt(parms!, 'BitsPerComponent') ?? 8;
  const columns = getInt(parms!, 'Columns') ?? 1;
  if (bpc !== 8 || colors < 1 || colors > 32 || columns < 1 || columns > 1 << 20) fail('malformed', 'unsupported predictor parameters', offset);
  const bpp = colors;
  const rowLen = columns * bpp;
  if (data.length % (rowLen + 1) !== 0) fail('malformed', 'predicted data is not a whole number of rows', offset);
  const rows = data.length / (rowLen + 1);
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1; const dst = r * rowLen; const up = dst - rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[up + i] : 0;
      const c = r > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: return fail('malformed', 'bad PNG row filter', offset);
      }
      out[dst + i] = v & 0xFF;
    }
  }
  return out;
}

// ------------------------------------------------------------------ cross-reference sections

const T_NONE = 0, T_FREE = 1, T_OFFSET = 2, T_OBJSTM = 3;

class EntryList {
  nums = new Uint32Array(64); types = new Uint8Array(64); a = new Uint32Array(64); b = new Uint32Array(64);
  length = 0;
  push(num: number, type: number, a: number, b: number): void {
    if (this.length === this.nums.length) {
      const n = this.length * 2;
      const grow = <T extends Uint32Array | Uint8Array>(x: T, mk: (n: number) => T): T => { const y = mk(n); y.set(x); return y; };
      this.nums = grow(this.nums, (k) => new Uint32Array(k)); this.types = grow(this.types, (k) => new Uint8Array(k));
      this.a = grow(this.a, (k) => new Uint32Array(k)); this.b = grow(this.b, (k) => new Uint32Array(k));
    }
    const i = this.length++;
    this.nums[i] = num; this.types[i] = type; this.a[i] = a; this.b[i] = b;
  }
  at(i: number): XrefEntry {
    const num = this.nums[i]; const t = this.types[i];
    if (t === T_FREE) return { num, type: 'free', gen: this.b[i], nextFree: this.a[i] };
    if (t === T_OFFSET) return { num, type: 'offset', gen: this.b[i], offset: this.a[i] };
    return { num, type: 'objstm', gen: 0, stream: this.a[i], index: this.b[i] };
  }
}

interface Section {
  startxref: number; kind: 'table' | 'stream'; trailer: PdfDict; size: number; prev: number | null;
  xrefStreamNum: number | null; sectionEnd: number; list: EntryList;
}

class Revision implements PdfRevision {
  private map: Map<number, number> | null = null;
  constructor(readonly index: number, private readonly s: Section) {}
  get startxref() { return this.s.startxref; }
  get kind() { return this.s.kind; }
  get trailer() { return this.s.trailer; }
  get size() { return this.s.size; }
  get prev() { return this.s.prev; }
  get xrefStreamNum() { return this.s.xrefStreamNum; }
  get sectionEnd() { return this.s.sectionEnd; }
  get entryCount() { return this.s.list.length; }
  *entries(): IterableIterator<XrefEntry> { for (let i = 0; i < this.s.list.length; i++) yield this.s.list.at(i); }
  entry(num: number): XrefEntry | undefined {
    if (!this.map) { this.map = new Map(); for (let i = 0; i < this.s.list.length; i++) this.map.set(this.s.list.nums[i], i); }
    const i = this.map.get(num);
    return i === undefined ? undefined : this.s.list.at(i);
  }
}

/** Work between event-loop checkpoints: the parsing generators yield every this many entries. */
const CHECKPOINT = 512;

class Reader implements PdfFile {
  readonly headerVersion: string;
  readonly headerOffset: number;
  revisions: PdfRevision[] = [];
  trailer!: PdfDict;
  size = 0;
  xrefKind: 'table' | 'stream' = 'table';
  startxref = 0;
  objectCount = 0;
  private mType = new Uint8Array(0);
  private mA = new Uint32Array(0);
  private mB = new Uint32Array(0);
  private totalEntries = 0;
  private readonly resolving = new Set<number>();
  private depth = 0;
  private readonly objstmCache = new Map<number, { data: Uint8Array; nums: Uint32Array; offs: Uint32Array; first: number }>();
  private objstmCacheBytes = 0;

  constructor(readonly bytes: Uint8Array, readonly lim: ReaderLimits) {
    const h = findHeader(bytes);
    this.headerOffset = h.offset; this.headerVersion = h.version;
  }

  // ---------------------------------------------------------------- opening (generator: yields at checkpoints)

  *open(): Generator<void, void> {
    const b = this.bytes;
    // startxref N %%EOF in the last 1,024 bytes
    const kw = lastIndexOf(b, 'startxref', b.length - 1024 - 9);
    if (kw < 0) fail('no-startxref', 'no startxref near the end of the file');
    const n = readUint(b, skipWs(b, kw + 9));
    if (!n || !WS[b[kw + 9]]) fail('no-startxref', 'startxref has no offset', kw);
    if (!matchAt(b, skipWs(b, n[1]), '%%EOF')) fail('no-startxref', 'startxref is not followed by %%EOF', kw);
    this.startxref = n[0];

    const sections: Section[] = []; // newest first
    const seen = new Set<number>();
    let off: number | null = n[0];
    while (off !== null) {
      if (seen.has(off)) fail('prev-cycle', 'the /Prev chain revisits a section', off);
      seen.add(off);
      if (sections.length >= this.lim.maxRevisions) fail('too-large', 'more revisions than the cap', off);
      if (off < this.headerOffset || off >= b.length) fail('bad-xref', 'cross-reference offset outside the file', off);
      const sec: Section = isDigit(b[off]) ? yield* this.streamSection(off) : yield* this.tableSection(off);
      sections.push(sec);
      off = sec.prev;
    }

    // merged view, newest wins; per-section duplicates are refused
    let size = 0;
    for (const s of sections) size = Math.max(size, s.size);
    this.mType = new Uint8Array(size); this.mA = new Uint32Array(size); this.mB = new Uint32Array(size);
    const stamp = new Uint32Array(size);
    for (let si = 0; si < sections.length; si++) {
      const L = sections[si].list;
      for (let i = 0; i < L.length; i++) {
        const num = L.nums[i];
        if (stamp[num] === si + 1) fail('bad-xref', `object ${num} listed twice in one section`, sections[si].startxref);
        stamp[num] = si + 1;
        if (this.mType[num] === T_NONE) {
          const t = L.types[i];
          this.mType[num] = t; this.mA[num] = L.a[i]; this.mB[num] = L.b[i];
          if (t === T_OFFSET || t === T_OBJSTM) this.objectCount++;
        }
        if (i % CHECKPOINT === 0) yield;
      }
    }

    const newest = sections[0];
    this.trailer = newest.trailer; this.size = newest.size; this.xrefKind = newest.kind;
    this.revisions = sections.slice().reverse().map((s, i) => new Revision(i, s));
  }

  private addEntries(count: number, at: number): void {
    this.totalEntries += count;
    if (this.totalEntries > this.lim.maxXrefEntries) fail('too-large', 'more cross-reference entries than the cap', at);
  }

  private checkTrailer(t: PdfDict, at: number, kind: 'table' | 'stream'): { size: number; prev: number | null } {
    if (t.entries.has('Encrypt')) fail('encrypted', 'the file is encrypted', at);
    if (kind === 'table' && t.entries.has('XRefStm')) fail('hybrid', 'hybrid-reference file (/XRefStm)', at);
    const size = getInt(t, 'Size');
    if (size === undefined || size < 1) fail('bad-xref', 'trailer /Size missing or invalid', at);
    if (size > this.lim.maxXrefEntries) fail('too-large', '/Size over the cross-reference cap', at);
    const pv = t.entries.get('Prev');
    let prev: number | null = null;
    if (pv !== undefined) {
      if (pv.kind !== 'number' || !pv.integer || pv.value < 0 || pv.value >= this.bytes.length) fail('bad-xref', 'trailer /Prev invalid', at);
      prev = pv.value;
    }
    return { size, prev };
  }

  private *tableSection(off: number): Generator<void, Section> {
    const b = this.bytes;
    if (!matchAt(b, off, 'xref') || !WS[b[off + 4]]) fail('bad-xref', 'no xref keyword at the cross-reference offset', off);
    let p = skipWs(b, off + 4);
    const list = new EntryList();
    while (p < b.length && isDigit(b[p])) {
      const f = readUint(b, p);
      if (!f || !(b[f[1]] === 32)) fail('bad-xref', 'bad subsection header', p);
      const c = readUint(b, f[1] + 1);
      if (!c) fail('bad-xref', 'bad subsection header', p);
      const [first, count] = [f[0], c[0]];
      p = c[1];
      while (b[p] === 32) p++;
      if (b[p] === 13 && b[p + 1] === 10) p += 2; else if (b[p] === 10 || b[p] === 13) p++; else fail('bad-xref', 'bad subsection header', p);
      this.addEntries(count, p);
      if (count * 19 > b.length - p) fail('bad-xref', 'subsection runs past the end of the file', p);
      for (let i = 0; i < count; i++) {
        // nnnnnnnnnn ggggg n<eol>
        const o = readUint(b, p); const g = o && b[o[1]] === 32 ? readUint(b, o[1] + 1) : null;
        if (!o || !g || o[1] - p !== 10 || g[1] - o[1] !== 6 || b[g[1]] !== 32) fail('bad-xref', 'bad cross-reference entry', p);
        const t = b[g[1] + 1];
        let q = g[1] + 2;
        if (b[q] === 32 && (b[q + 1] === 10 || b[q + 1] === 13)) q += 2;
        else if (b[q] === 13 && b[q + 1] === 10) q += 2;
        else if (b[q] === 10 || b[q] === 13) q += 1;
        else fail('bad-xref', 'bad cross-reference entry end', p);
        const num = first + i;
        if (t === 0x6E) { // n
          if (g[0] > 0xFFFF) fail('bad-xref', 'generation out of range', p);
          if (!headerMatches(b, o[0], num, g[0]) || o[0] < this.headerOffset) fail('bad-xref', `object ${num}: entry does not point at its header`, p);
          list.push(num, T_OFFSET, o[0], g[0]);
        } else if (t === 0x66) { // f
          list.push(num, T_FREE, Math.min(o[0], 0xFFFFFFFF), Math.min(g[0], 0xFFFFFFFF));
        } else fail('bad-xref', 'entry type is not n or f', p);
        p = q;
        if (i % CHECKPOINT === CHECKPOINT - 1) yield;
      }
    }
    const lx = new Lexer(b, p, b.length, this.lim.maxDictionaryBytes);
    const tk = lx.next();
    if (tk.type !== 'keyword' || tk.value !== 'trailer') fail('bad-xref', 'no trailer after the cross-reference table', tk.start);
    let tr: PdfValue;
    try { tr = parseValue(lx, 0, this.lim); } catch (e) {
      if (e instanceof PdfReadError && e.code === 'malformed') fail('bad-xref', 'trailer dictionary is malformed', e.offset);
      throw e;
    }
    if (tr.kind !== 'dict') fail('bad-xref', 'trailer is not a dictionary', tr.start);
    const { size, prev } = this.checkTrailer(tr, off, 'table');
    for (let i = 0; i < list.length; i++) {
      if (list.nums[i] >= size) fail('bad-xref', `object ${list.nums[i]} at or over /Size`, off);
      if (i % CHECKPOINT === CHECKPOINT - 1) yield;
    }
    return { startxref: off, kind: 'table', trailer: tr, size, prev, xrefStreamNum: null, sectionEnd: tr.end, list };
  }

  private *streamSection(off: number): Generator<void, Section> {
    const b = this.bytes;
    const hdr = readUint(b, off);
    if (!hdr) fail('bad-xref', 'no object at the cross-reference offset', off);
    const genT = readUint(b, skipWs(b, hdr[1]));
    if (!genT || !headerMatches(b, off, hdr[0], genT[0])) fail('bad-xref', 'no object header at the cross-reference offset', off);
    let parsed: { value: PdfValue | PdfStream; end: number };
    try { parsed = this.parseIndirectAt(b, off, hdr[0], genT[0], true); } catch (e) {
      if (e instanceof PdfReadError && e.code === 'malformed') fail('bad-xref', 'cross-reference stream is malformed', e.offset);
      throw e;
    }
    const { value, end } = parsed;
    if (value.kind !== 'stream' || getName(value.dict, 'Type') !== 'XRef') fail('bad-xref', 'cross-reference offset does not hold an XRef stream', off);
    const d = value.dict;
    const { size, prev } = this.checkTrailer(d, off, 'stream');
    const W = d.entries.get('W');
    if (!W || W.kind !== 'array' || W.items.length !== 3) fail('bad-xref', '/W missing or invalid', off);
    const w = W.items.map((x) => (x.kind === 'number' && x.integer && x.value >= 0 && x.value <= 8 ? x.value : -1));
    if (w.some((x) => x < 0) || w[0] + w[1] + w[2] === 0) fail('bad-xref', '/W widths invalid', off);
    const rowLen = w[0] + w[1] + w[2];
    const ranges: number[] = [];
    const ix = d.entries.get('Index');
    if (ix === undefined) ranges.push(0, size);
    else {
      if (ix.kind !== 'array' || ix.items.length % 2 !== 0) fail('bad-xref', '/Index invalid', off);
      for (const it of ix.items) {
        if (it.kind !== 'number' || !it.integer || it.value < 0) fail('bad-xref', '/Index invalid', off);
        ranges.push(it.value);
      }
    }
    let rows = 0;
    for (let i = 1; i < ranges.length; i += 2) rows += ranges[i];
    this.addEntries(rows, off);
    if (rows * rowLen > this.lim.maxObjectStreamBytes) fail('too-large', 'cross-reference stream over the cap', off);
    // Cap the inflated size at what /W and /Index allow, with room for a PNG predictor's per-row filter byte.
    let data: Uint8Array;
    try { data = this.decodeStream(value, rows * (rowLen + 1) + 1); } catch (e) {
      if (e instanceof PdfReadError && e.code !== 'too-large') fail('bad-xref', 'cross-reference stream cannot be decoded', off);
      if (e instanceof PdfReadError) fail('bad-xref', 'cross-reference stream longer than /W and /Index allow', off);
      throw e;
    }
    if (data.length !== rows * rowLen) fail('bad-xref', 'cross-reference stream length does not match /W and /Index', off);
    const field = (p: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + data[p + k]; return v; };
    const list = new EntryList();
    let p = 0; let done = 0;
    for (let r = 0; r < ranges.length; r += 2) {
      for (let i = 0; i < ranges[r + 1]; i++) {
        const num = ranges[r] + i;
        if (num >= size) fail('bad-xref', `object ${num} at or over /Size`, off);
        const t = w[0] === 0 ? 1 : field(p, w[0]);
        const f2 = field(p + w[0], w[1]);
        const f3 = field(p + w[0] + w[1], w[2]);
        p += rowLen;
        if (f2 > 0xFFFFFFFF || f3 > 0xFFFFFFFF) fail('bad-xref', `object ${num}: field out of range`, off);
        if (t === 0) list.push(num, T_FREE, f2, f3);
        else if (t === 1) {
          if (f3 > 0xFFFF || f2 < this.headerOffset || !headerMatches(b, f2, num, f3)) fail('bad-xref', `object ${num}: entry does not point at its header`, off);
          list.push(num, T_OFFSET, f2, f3);
        } else if (t === 2) {
          if (f2 >= size || f2 === num) fail('bad-xref', `object ${num}: object stream number invalid`, off);
          list.push(num, T_OBJSTM, f2, f3);
        } else fail('bad-xref', `object ${num}: unknown entry type`, off);
        if (++done % CHECKPOINT === 0) yield;
      }
    }
    return { startxref: off, kind: 'stream', trailer: d, size, prev, xrefStreamNum: hdr[0], sectionEnd: end, list };
  }

  // ---------------------------------------------------------------- objects

  /** Parse `N G obj value endobj` (or a stream) at `off`. `xrefStream`: /Length must be direct. */
  private parseIndirectAt(b: Uint8Array, off: number, num: number, gen: number, xrefStream = false): { value: PdfValue | PdfStream; end: number } {
    const lx = new Lexer(b, off, b.length, this.lim.maxDictionaryBytes);
    const t1 = lx.next(), t2 = lx.next(), t3 = lx.next();
    if (t1.type !== 'number' || t1.value !== num || t2.type !== 'number' || t2.value !== gen || t3.type !== 'keyword' || t3.value !== 'obj') {
      fail('bad-xref', `object ${num}: header does not match`, off);
    }
    const v = parseValue(lx, 0, this.lim);
    const t = lx.next();
    if (t.type === 'keyword' && t.value === 'endobj') return { value: v, end: t.end };
    if (!(t.type === 'keyword' && t.value === 'stream')) fail('malformed', `object ${num}: no endobj`, t.start);
    if (v.kind !== 'dict') fail('malformed', `object ${num}: stream without a dictionary`, v.start);
    let p = t.end;
    if (b[p] === 13 && b[p + 1] === 10) p += 2; else if (b[p] === 10) p += 1;
    else fail('malformed', `object ${num}: stream keyword not followed by an end of line`, p);
    const lv = v.entries.get('Length');
    let len: number | undefined;
    if (lv && lv.kind === 'number' && lv.integer) len = lv.value;
    else if (lv && lv.kind === 'ref') {
      if (xrefStream) fail('bad-xref', `object ${num}: cross-reference stream /Length is indirect`, off);
      const lo = this.resolve(lv.num, lv.gen);
      if (lo && lo.value.kind === 'number' && lo.value.integer) len = lo.value.value;
    }
    if (len === undefined || len < 0) fail('malformed', `object ${num}: stream /Length missing or invalid`, v.start);
    const dataStart = p; const dataEnd = p + len;
    if (dataEnd > b.length) fail('malformed', `object ${num}: stream /Length runs past the end of the file`, v.start);
    let q = dataEnd;
    if (b[q] === 13 && b[q + 1] === 10) q += 2; else if (b[q] === 10 || b[q] === 13) q += 1;
    while (q < b.length && q - dataEnd < 16 && (b[q] === 32 || b[q] === 0)) q++;
    if (!matchAt(b, q, 'endstream') || !(q + 9 >= b.length || WS[b[q + 9]] || DELIM[b[q + 9]])) {
      fail('malformed', `object ${num}: stream /Length does not end at endstream`, dataEnd);
    }
    const lx2 = new Lexer(b, q + 9, b.length, this.lim.maxDictionaryBytes);
    const e = lx2.next();
    if (e.type !== 'keyword' || e.value !== 'endobj') fail('malformed', `object ${num}: no endobj after endstream`, e.start);
    return { value: { kind: 'stream', dict: v, dataStart, dataEnd, start: v.start, end: q + 9 }, end: e.end };
  }

  resolve(num: number, gen?: number): PdfIndirectObject | null {
    if (!Number.isInteger(num) || num < 0 || num >= this.mType.length) return null;
    const t = this.mType[num];
    if (t !== T_OFFSET && t !== T_OBJSTM) return null;
    const g = t === T_OFFSET ? this.mB[num] : 0;
    if (gen !== undefined && gen !== g) return null;
    if (this.resolving.has(num)) fail('malformed', `object ${num}: reference cycle while resolving`);
    if (this.depth >= MAX_RESOLVE_DEPTH) fail('malformed', `object ${num}: nested resolution too deep`);
    this.resolving.add(num); this.depth++;
    try {
      if (t === T_OFFSET) {
        const offset = this.mA[num];
        const { value } = this.parseIndirectAt(this.bytes, offset, num, g);
        return { num, gen: g, value, location: { kind: 'offset', offset }, source: this.bytes };
      }
      return this.fromObjectStream(num, this.mA[num], this.mB[num]);
    } finally {
      this.resolving.delete(num); this.depth--;
    }
  }

  private objectStream(sn: number) {
    const hit = this.objstmCache.get(sn);
    if (hit) { this.objstmCache.delete(sn); this.objstmCache.set(sn, hit); return hit; }
    if (sn >= this.mType.length || this.mType[sn] !== T_OFFSET) fail('objstm', `object stream ${sn} is not a direct object`);
    const so = this.resolve(sn);
    if (!so || so.value.kind !== 'stream' || getName(so.value.dict, 'Type') !== 'ObjStm') fail('objstm', `object ${sn} is not an object stream`);
    const st = so.value;
    const N = getInt(st.dict, 'N'); const first = getInt(st.dict, 'First');
    if (N === undefined || first === undefined || N < 0 || first < 0) fail('objstm', `object stream ${sn}: /N or /First invalid`);
    let data: Uint8Array;
    try { data = this.decodeStream(st, this.lim.maxObjectStreamBytes); } catch (e) {
      if (e instanceof PdfReadError && e.code === 'too-large') throw e;
      return fail('objstm', `object stream ${sn}: cannot be decoded`);
    }
    if (first > data.length || N * 4 > first + 4) fail('objstm', `object stream ${sn}: header does not fit`);
    const nums = new Uint32Array(N); const offs = new Uint32Array(N);
    const lx = new Lexer(data, 0, first, this.lim.maxDictionaryBytes);
    for (let i = 0; i < N; i++) {
      const a = lx.next(), o = lx.next();
      if (a.type !== 'number' || !a.integer || a.value < 0 || o.type !== 'number' || !o.integer || o.value < 0 || first + o.value >= data.length + 1) {
        fail('objstm', `object stream ${sn}: bad header pair ${i}`);
      }
      nums[i] = a.value; offs[i] = o.value;
    }
    const entry = { data, nums, offs, first };
    this.objstmCache.set(sn, entry);
    this.objstmCacheBytes += data.length;
    for (const [k, v] of this.objstmCache) {
      if (this.objstmCacheBytes <= OBJSTM_CACHE_FACTOR * this.lim.maxObjectStreamBytes || k === sn) break;
      this.objstmCache.delete(k); this.objstmCacheBytes -= v.data.length;
    }
    return entry;
  }

  private fromObjectStream(num: number, sn: number, index: number): PdfIndirectObject {
    const s = this.objectStream(sn);
    if (index >= s.nums.length || s.nums[index] !== num) fail('objstm', `object ${num}: not at index ${index} of object stream ${sn}`);
    const at = s.first + s.offs[index];
    const lx = new Lexer(s.data, at, s.data.length, this.lim.maxDictionaryBytes);
    const value = parseValue(lx, 0, this.lim);
    const after = lx.peek(0);
    if (after.type === 'keyword' && (after.value === 'stream' || after.value === 'obj')) fail('objstm', `object ${num}: a stream or object header inside object stream ${sn}`, after.start);
    return { num, gen: 0, value, location: { kind: 'objstm', stream: sn, index }, source: s.data };
  }

  entry(num: number): XrefEntry | undefined {
    if (!Number.isInteger(num) || num < 0 || num >= this.mType.length) return undefined;
    const t = this.mType[num];
    if (t === T_FREE) return { num, type: 'free', gen: this.mB[num], nextFree: this.mA[num] };
    if (t === T_OFFSET) return { num, type: 'offset', gen: this.mB[num], offset: this.mA[num] };
    if (t === T_OBJSTM) return { num, type: 'objstm', gen: 0, stream: this.mA[num], index: this.mB[num] };
    return undefined;
  }

  *objectNumbers(): IterableIterator<number> {
    for (let i = 0; i < this.mType.length; i++) if (this.mType[i] === T_OFFSET || this.mType[i] === T_OBJSTM) yield i;
  }

  deref(value: PdfValue | PdfStream | undefined): PdfValue | PdfStream | null {
    let v: PdfValue | PdfStream | undefined = value;
    for (let hops = 0; v && v.kind === 'ref'; hops++) {
      if (hops >= MAX_RESOLVE_DEPTH) fail('malformed', 'reference chain too long');
      const o = this.resolve(v.num, v.gen);
      v = o ? o.value : undefined;
    }
    return v ?? null;
  }

  objectText(num: number, gen?: number): string | null {
    const o = this.resolve(num, gen);
    if (!o) return null;
    const v = o.value.kind === 'stream' ? o.value.dict : o.value;
    return latin1(o.source, v.start, v.end);
  }

  streamData(stream: PdfStream): Uint8Array {
    return this.bytes.subarray(stream.dataStart, stream.dataEnd);
  }

  decodeStream(stream: PdfStream, maxBytes: number = this.lim.maxObjectStreamBytes): Uint8Array {
    const raw = this.streamData(stream);
    const f = stream.dict.entries.get('Filter');
    const fv = f && f.kind === 'ref' ? this.deref(f) : f;
    let filters: string[] = [];
    if (fv && fv.kind === 'name') filters = [fv.value];
    else if (fv && fv.kind === 'array') filters = fv.items.map((x) => (x.kind === 'name' ? x.value : fail('malformed', 'filter is not a name', stream.start)));
    else if (fv && fv.kind !== 'null') fail('malformed', '/Filter invalid', stream.start);
    if (filters.length === 0) {
      if (raw.length > maxBytes) fail('too-large', 'stream over the cap', stream.start);
      return raw;
    }
    if (filters.length !== 1 || filters[0] !== 'FlateDecode') fail('malformed', 'unsupported filter', stream.start);
    const pr = stream.dict.entries.get('DecodeParms');
    let pv = pr && pr.kind === 'ref' ? this.deref(pr) : pr;
    if (pv && pv.kind === 'array') pv = pv.items.length === 1 ? pv.items[0] : fail('malformed', '/DecodeParms invalid', stream.start);
    if (pv && pv.kind === 'ref') pv = this.deref(pv);
    let parms: PdfDict | null = null;
    if (pv && pv.kind === 'dict') parms = pv;
    else if (pv && pv.kind !== 'null') fail('malformed', '/DecodeParms invalid', stream.start);
    return unpredict(inflateCapped(raw, maxBytes, 'stream', stream.start), parms, stream.start);
  }
}

function findHeader(b: Uint8Array): { offset: number; version: string } {
  const lim = Math.min(b.length, 1024) - 8;
  for (let i = 0; i <= lim; i++) {
    if (matchAt(b, i, '%PDF-') && isDigit(b[i + 5]) && b[i + 6] === 0x2E && isDigit(b[i + 7])) {
      return { offset: i, version: `${b[i + 5] - 0x30}.${b[i + 7] - 0x30}` };
    }
  }
  return fail('no-header', 'no %PDF- header in the first 1,024 bytes');
}

// ------------------------------------------------------------------ entry points

/**
 * Open a PDF for reading: parses the header, `startxref`, and the whole cross-reference chain (checking
 * each in-use entry's `N G obj` header), and nothing else. Objects are parsed when `resolve` asks.
 * For files over `asyncParseThresholdBytes` it yields to the event loop every `yieldIntervalMs`.
 * Rejects with `PdfReadError`.
 */
export async function openPdf(bytes: Uint8Array, limits?: Partial<ReaderLimits>): Promise<PdfFile> {
  const r = new Reader(bytes, readerLimits(limits));
  const steps = r.open();
  const yielding = bytes.length > r.lim.asyncParseThresholdBytes;
  let slice = performance.now();
  for (;;) {
    if (!steps.next().done) {
      if (yielding && performance.now() - slice >= r.lim.yieldIntervalMs) {
        await new Promise<void>((res) => setImmediate(res));
        slice = performance.now();
      }
      continue;
    }
    return r;
  }
}

/** `openPdf` without yielding (small files, tests, callers already off the hot path). */
export function openPdfSync(bytes: Uint8Array, limits?: Partial<ReaderLimits>): PdfFile {
  const r = new Reader(bytes, readerLimits(limits));
  const steps = r.open();
  while (!steps.next().done) { /* run to completion */ }
  return r;
}
