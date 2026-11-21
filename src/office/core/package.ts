// OfficePackage: one OOXML package = the original ZIP + lazily parsed parts + dirty-part tracking.
//
// Preservation model (spec §3.1, §10.1, §13.2):
// - Nothing is inflated or parsed until asked for. `open` reads only `[Content_Types].xml`,
//   `_rels/.rels` and the root start tag of the main part. Every other part (VML drawings, binaries,
//   parts with XML we could not parse) is copied as raw ZIP bytes on save and can never block opening.
// - `serialize()` with nothing touched returns `originalBytes` itself (G0). Otherwise every unchanged
//   entry is copied raw by the ZIP writer (G1, G3); a touched part is re-encoded from its tree.
// - A changed part whose final bytes equal the original (an edit followed by its undo) is written as
//   the original entry again, so edit -> undo -> serialize is byte-identical to the input (G5).
//
// No `vscode` import here (core rule).

import type { ReadOnlyReason } from './types.js';
import { LIMITS } from './limits.js';
import { ZipError, readZip, inflateEntry, inflateEntryAsync, inflateEntryPrefix, writeZip, writeZipAsync, crc32, crc32Async } from './zip.js';
import type { ZipArchive, ZipEntry, ZipLimits, ZipRefusal, ZipWriteItem } from './zip.js';
import { XmlError, decodePart, decodePartPrefix, encodePart, parseXml, parseXmlAsync, serialize as serializeXml } from './xml.js';
import type { XmlDoc } from './xml.js';
import { OfficeLoadError, sniff, sniffDetail } from './sniff.js';
import { CONTENT_TYPES_PART, REL_OFFICE_DOCUMENT_STRICT, contentTypeOf, mainPart, normalizePartName, readRelationships } from './opc.js';

export type OfficeKind = 'docx' | 'xlsx';

/** ZIP reader limits from §10.2 (`LIMITS` names them differently). */
export function zipLimits(): ZipLimits {
  return {
    maxFileBytes: LIMITS.maxFileBytes,
    maxTotalUncompressed: LIMITS.maxUncompressedTotalBytes,
    maxEntryUncompressed: LIMITS.maxEntryBytes,
  };
}

/** Container refusals that mean "a packaging feature we don't support" rather than "damaged" (§10.3). */
const UNSUPPORTED_PACKAGING: ReadonlySet<ZipRefusal> = new Set<ZipRefusal>([
  'zip64', 'multi-disk', 'encrypted', 'unsupported-compression', 'duplicate-name', 'unsafe-name',
]);

function zipFailure(e: ZipError): OfficeLoadError {
  if (e.code === 'too-large') return new OfficeLoadError('too-large', e.message);
  return new OfficeLoadError(UNSUPPORTED_PACKAGING.has(e.code) ? 'unsupported-packaging' : 'damaged', `${e.code}: ${e.message}`);
}

// Main-part content types (lower case; MIME types compare case-insensitively).
const CT = (s: string): string => s.toLowerCase();
const DOCX_MAIN = CT('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml');
const XLSX_MAIN = CT('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
/** Other main-part types we recognise: view-only (`unsupported-xml-layout`). */
const DOCX_OTHER = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-word.document.macroenabled.main+xml',
  'application/vnd.ms-word.template.macroenabledtemplate.main+xml',
]);
const XLSX_OTHER = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroenabled.main+xml',
  'application/vnd.ms-excel.template.macroenabled.main+xml',
  'application/vnd.ms-excel.addin.macroenabled.main+xml',
]);
const XLSX_WORKSHEET = CT('application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
const STRICT_NS_PREFIX = 'http://purl.oclc.org/ooxml/';

const EXT_KIND: Record<string, OfficeKind> = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx', xlam: 'xlsx',
};

function extensionKind(fileName: string): OfficeKind | undefined {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? undefined : EXT_KIND[base.slice(dot + 1).toLowerCase()];
}

/**
 * Bytes of the main part read by `open` to find its root start tag: first a small prefix, then (only
 * for a root start tag or prolog longer than that) a larger one. Never the whole part (§10.2).
 */
const ROOT_SCAN_BYTES = [64 * 1024, 1024 * 1024] as const;

/**
 * Parse only the prolog and root start tag of a part (a cheap stand-in for parsing a possibly 20 MB
 * main part during `open`): returns the root element's namespace, or undefined when `text` is only
 * the start of the part (`complete` false) and ends before the root start tag does. Throws XmlError
 * if the prolog or start tag is malformed (including any DOCTYPE).
 */
function rootNamespace(text: string, complete: boolean): string | undefined {
  let i = 0;
  for (;;) {
    while (i < text.length && ' \t\r\n\uFEFF'.includes(text[i])) i++;
    if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i + 2); if (e < 0) break; i = e + 2; continue; }
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); if (e < 0) break; i = e + 3; continue; }
    break;
  }
  // Too little text to tell a comment, PI or DOCTYPE from the root start tag: ask for more.
  if (!complete && text.length - i < 9) return undefined;
  if (text[i] !== '<' || text.startsWith('<!', i) || text.startsWith('<?', i)) {
    if (!complete && (text.startsWith('<?', i) || text.startsWith('<!--', i))) return undefined;   // unterminated so far
    return parseXml(text.slice(0, i + 200)).root.ns; // lets the parser report it
  }
  let q = '';
  let j = i + 1;
  for (; j < text.length; j++) {
    const c = text[j];
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
  }
  if (j >= text.length) {
    if (!complete) return undefined;
    throw new XmlError('malformed', 'root start tag is not closed', i);
  }
  const head = text.slice(0, j + 1);
  if (head.endsWith('/>')) return parseXml(head).root.ns;
  const m = /^<([^\s/>]+)/.exec(text.slice(i));
  return parseXml(head + '</' + (m ? m[1] : '') + '>').root.ns;
}

interface PartState {
  /** Name with the case it has in the package. */
  readonly name: string;
  /** The ZIP entry this part came from (undefined for a part created by setPart). */
  readonly entry?: ZipEntry;
  /** Replacement bytes from setPart; null = deleted; undefined = original entry bytes. */
  data?: Uint8Array | null;
  /** Parsed tree (cached). */
  doc?: XmlDoc;
  /** Decoded text the tree was parsed from, when that was the original entry's bytes. */
  origText?: string;
  bom?: boolean;
  utf16?: boolean;
  pending?: Promise<XmlDoc>;
  /** Bumped by setPart, so a parse started before it never installs a stale tree. */
  gen: number;
  touched: boolean;
  /** Listed by touchedParts() (touch() or setPart() was called). */
  changed: boolean;
}

export class OfficePackage {
  readonly kind: OfficeKind;
  readonly originalBytes: Uint8Array;
  private readonly zip: ZipArchive;
  /** Lower-case name -> state, for original entries (ZIP order) then created parts (creation order). */
  private readonly parts = new Map<string, PartState>();
  private reason: ReadOnlyReason | null = null;

  /**
   * Why the package as a whole cannot be edited (`strict-ooxml`, `unsupported-xml-layout`,
   * `utf16-part`, `too-large`), or null. Set by `open`; may become `utf16-part` later when a UTF-16
   * part is first decoded (`touch` refuses such parts regardless).
   */
  get viewOnlyReason(): ReadOnlyReason | null { return this.reason; }

  private constructor(bytes: Uint8Array, zip: ZipArchive) {
    this.originalBytes = bytes;
    this.zip = zip;
    for (const entry of zip.entries) {
      this.parts.set(entry.name.toLowerCase(), { name: entry.name, entry, gen: 0, touched: false, changed: false });
    }
    this.kind = 'docx'; // replaced by classify() before open() returns
  }

  /** Open a package. Throws OfficeLoadError (spec §10.3) for anything that cannot be shown. */
  static open(fileName: string, bytes: Uint8Array): OfficePackage {
    const pre = sniff(fileName, bytes);
    if (pre) throw new OfficeLoadError(pre, sniffDetail(pre, fileName, bytes));
    let zip: ZipArchive;
    try {
      zip = readZip(bytes, zipLimits());
    } catch (e) {
      if (e instanceof ZipError) throw zipFailure(e);
      throw e;
    }
    const p = new OfficePackage(bytes, zip);
    try {
      p.classify(fileName);
    } catch (e) {
      if (e instanceof OfficeLoadError) throw e;
      if (e instanceof ZipError) throw new OfficeLoadError('damaged', `${e.code}: ${e.message}`);
      if (e instanceof XmlError) throw new OfficeLoadError('damaged', `${e.code}: ${e.message}`);
      throw e;
    }
    return p;
  }

  private classify(fileName: string): void {
    for (const required of [CONTENT_TYPES_PART, '_rels/.rels']) {
      if (!this.has(required)) throw new OfficeLoadError('damaged', `Required part ${required} is missing`);
      this.xml(required);   // must be well-formed
    }
    const main = mainPart(this);
    const ct = main.contentType.toLowerCase();
    let kind: OfficeKind;
    let reason: ReadOnlyReason | null = null;
    if (ct === DOCX_MAIN || DOCX_OTHER.has(ct)) kind = 'docx';
    else if (ct === XLSX_MAIN || XLSX_OTHER.has(ct)) kind = 'xlsx';
    else throw new OfficeLoadError('unsupported-packaging', `Main part content type "${main.contentType}" is not a Word or Excel XML document`);
    if (ct !== DOCX_MAIN && ct !== XLSX_MAIN) reason = 'unsupported-xml-layout';
    const extKind = extensionKind(fileName);
    if (extKind && extKind !== kind) {
      throw new OfficeLoadError('unsupported-packaging', `File name says ${extKind} but the package is a ${kind} document`);
    }
    (this as { kind: OfficeKind }).kind = kind;

    const st = this.state(main.name)!;

    // Declared sizes first (central directory only, nothing inflated).
    let tooLarge = false;
    if (kind === 'docx') {
      tooLarge = this.declaredSize(st) > LIMITS.docxMaxDocumentXmlBytes;
    } else {
      for (const s of this.parts.values()) {
        if (this.declaredSize(s) > LIMITS.xlsxMaxSheetXmlBytes && contentTypeOf(this, s.name)?.toLowerCase() === XLSX_WORKSHEET) {
          tooLarge = true;
          break;
        }
      }
    }

    // Strict OOXML: Strict relationship type or a purl.oclc.org root namespace. Strict wins over the
    // content-type reason (it is the more specific explanation). The root start tag is read from a
    // bounded prefix of the main part, whatever its size.
    const strictRel = readRelationships(this, '').some((r) => r.type === REL_OFFICE_DOCUMENT_STRICT);
    if (strictRel || this.mainRootNamespace(st).startsWith(STRICT_NS_PREFIX)) reason = 'strict-ooxml';

    // UTF-16 in any part read so far (content types, root rels, main part).
    if (!reason && [...this.parts.values()].some((s) => s.utf16)) reason = 'utf16-part';

    if (!reason && tooLarge) reason = 'too-large';
    this.reason = reason;
  }

  /**
   * Root namespace of an original part from a bounded prefix of its bytes (ROOT_SCAN_BYTES). Records
   * the part's encoding (UTF-16 flag, BOM) as `decode` would. Throws XmlError / ZipError.
   */
  private mainRootNamespace(st: PartState): string {
    const size = this.declaredSize(st);
    for (const max of ROOT_SCAN_BYTES) {
      const bytes = st.data ? st.data.subarray(0, max) : inflateEntryPrefix(this.zip, st.entry!, max);
      const complete = bytes.length >= size || bytes.length < max;
      const d = complete ? decodePart(bytes) : decodePartPrefix(bytes);
      st.bom = d.bom;
      st.utf16 = d.encoding === 'utf-16';
      const ns = rootNamespace(d.text, complete);
      if (ns !== undefined) return ns;
      if (complete) break;
    }
    throw new XmlError('malformed', `root start tag not found in the first ${ROOT_SCAN_BYTES[ROOT_SCAN_BYTES.length - 1]} bytes`, 0);
  }

  private declaredSize(s: PartState): number {
    if (s.data !== undefined) return s.data ? s.data.length : 0;
    return s.entry ? s.entry.uncompressedSize : 0;
  }

  // -------------------------------------------------------------------------------------------
  // Lookup

  private state(part: string): PartState | undefined {
    const s = this.parts.get(normalizePartName(part).toLowerCase());
    return s && s.data !== null ? s : undefined;
  }

  private require(part: string): PartState {
    const s = this.state(part);
    if (!s) throw new Error(`Part not found: ${part}`);
    return s;
  }

  /** Current part names (ZIP order, then created parts), original case. Directory entries are not parts. */
  partNames(): string[] {
    const out: string[] = [];
    for (const s of this.parts.values()) if (s.data !== null && !s.name.endsWith('/')) out.push(s.name);
    return out;
  }

  /** Case-insensitive; a leading '/' is ignored. */
  has(part: string): boolean {
    const s = this.state(part);
    return !!s && !s.name.endsWith('/');
  }

  /**
   * Declared central-directory sizes of a part's original ZIP entry (case-insensitive; a leading '/'
   * is ignored). Nothing is inflated. Undefined for a missing or deleted part, a directory entry, and
   * a part created by setPart (it has no entry yet). A part replaced by setPart still reports its
   * original entry's sizes.
   */
  partSize(part: string): { compressed: number; uncompressed: number } | undefined {
    const s = this.state(part);
    if (!s || !s.entry || s.name.endsWith('/')) return undefined;
    return { compressed: s.entry.compressedSize, uncompressed: s.entry.uncompressedSize };
  }

  // -------------------------------------------------------------------------------------------
  // Content

  /** Current bytes of a part (a fresh copy). Throws for a missing part; ZipError for a damaged entry. */
  bytes(part: string): Uint8Array {
    return this.currentBytes(this.require(part)).slice();
  }

  private currentBytes(s: PartState): Uint8Array {
    if (s.touched && s.doc) return encodePart(serializeXml(s.doc), s.bom ?? false);
    if (s.data) return s.data;
    return inflateEntry(this.zip, s.entry!);
  }

  private decode(s: PartState, bytes?: Uint8Array): string {
    const fromOriginal = s.data === undefined && !s.touched;
    const d = decodePart(bytes ?? this.currentBytes(s));
    s.bom = d.bom;
    s.utf16 = d.encoding === 'utf-16';
    if (s.utf16 && !this.reason) this.reason = 'utf16-part';
    if (fromOriginal) s.origText = d.text;
    return d.text;
  }

  /** Decoded text of a part (UTF-8 or UTF-16). Throws XmlError('encoding') for undecodable bytes. */
  text(part: string): string {
    const s = this.require(part);
    if (s.touched && s.doc) return serializeXml(s.doc);
    return decodePart(this.currentBytes(s)).text;
  }

  /**
   * Parsed tree of a part, parsed once and cached. Throws XmlError for a malformed part; the error
   * is not cached and the part stays copy-only (it is never parsed again unless asked).
   */
  xml(part: string): XmlDoc {
    const s = this.require(part);
    if (!s.doc) s.doc = parseXml(this.decode(s));
    return s.doc;
  }

  /** As `xml`, yielding to the event loop while parsing parts above the async threshold (§10.2). */
  xmlAsync(part: string): Promise<XmlDoc> {
    let s: PartState;
    try { s = this.require(part); } catch (e) { return Promise.reject(e); }
    if (s.doc) return Promise.resolve(s.doc);
    if (s.pending) return s.pending;
    if (this.declaredSize(s) <= LIMITS.asyncParseThresholdBytes) {
      try { return Promise.resolve(this.xml(part)); } catch (e) { return Promise.reject(e); }
    }
    const gen = s.gen;
    // Inflation of a large original entry yields too (§10.2); set/created data is already in memory.
    const bytes = s.data === undefined && s.entry
      ? inflateEntryAsync(this.zip, s.entry, LIMITS.parseYieldMs)
      : Promise.resolve(this.currentBytes(s));
    const pending = bytes.then((b) => {
      // A setPart meanwhile: these bytes are stale (the handler below re-reads the current ones).
      if (s.gen !== gen) return undefined;
      return parseXmlAsync(this.decode(s, b), LIMITS.parseYieldMs);
    }).then((doc) => {
      if (s.pending === pending) s.pending = undefined;
      // A setPart meanwhile makes this tree stale; a synchronous xml() meanwhile already installed
      // one. Either way never hand out a second, different tree.
      if (s.gen !== gen || doc === undefined) return this.xml(part);
      if (s.doc) return s.doc;
      s.doc = doc;
      return doc;
    }, (e) => {
      if (s.pending === pending) s.pending = undefined;
      throw e;
    });
    s.pending = pending;
    return pending;
  }

  // -------------------------------------------------------------------------------------------
  // Changes

  /**
   * Mark an XML part modified: its tree is serialised on `serialize()`. The tree must have been
   * obtained with `xml`/`xmlAsync` first, and the part must be UTF-8 (UTF-16 parts are view-only).
   */
  touch(part: string): void {
    const s = this.require(part);
    if (!s.doc) throw new Error(`touch: ${s.name} has not been parsed; call xml() first`);
    if (s.utf16) throw new Error(`touch: ${s.name} is UTF-16 and cannot be written`);
    s.touched = true;
    s.changed = true;
  }

  /**
   * Create, replace (`data`) or delete (`null`) a whole part. Any cached tree of the part is dropped.
   * Does not update `[Content_Types].xml` or relationships: the caller changes those parts too.
   */
  setPart(part: string, data: Uint8Array | null): void {
    const name = normalizePartName(part);
    if (name === '' || name.endsWith('/')) throw new Error(`setPart: invalid part name "${part}"`);
    const key = name.toLowerCase();
    let s = this.parts.get(key);
    if (!s) {
      if (data === null) return;
      s = { name, gen: 0, touched: false, changed: false };
      this.parts.set(key, s);
    } else if (!s.entry && s.data === null && s.name !== name) {
      // Re-creating a tombstoned part under a different case: same slot (Map.set keeps the
      // position of an existing key), new name.
      s = { name, gen: s.gen, touched: false, changed: false, data: null };
      this.parts.set(key, s);
    }
    if (data === null && !s.entry) {
      // A created part that is deleted again leaves no trace in the output, but its map slot stays
      // as a tombstone: re-creating it (undo of the deletion) puts it back at its original position
      // among the created parts, so every intermediate state has the same ZIP entry order.
      s.data = null;
      s.gen++;
      s.doc = undefined;
      s.origText = undefined;
      s.pending = undefined;
      s.bom = undefined;
      s.utf16 = undefined;
      s.touched = false;
      s.changed = false;
      return;
    }
    s.data = data === null ? null : data.slice();
    s.gen++;
    s.doc = undefined;
    s.origText = undefined;
    s.pending = undefined;
    s.bom = undefined;
    s.utf16 = undefined;
    s.touched = false;
    s.changed = true;
  }

  /** Parts touched or set/created/deleted since open (original order, then created parts). */
  touchedParts(): string[] {
    const out: string[] = [];
    for (const s of this.parts.values()) if (s.changed) out.push(s.name);
    return out;
  }

  /**
   * Serialise the package. With nothing touched and no `force`, returns `originalBytes` itself (G0).
   * Unchanged entries are copied raw; a changed part whose final bytes equal its original entry is
   * copied raw too. `force` always runs the writer (G1: the result is then byte-identical anyway).
   */
  serialize(opts?: { force?: boolean }): Uint8Array {
    const force = opts?.force === true;
    if (!force && this.touchedParts().length === 0) return this.originalBytes;
    const items: ZipWriteItem[] = [];
    let changed = false;
    // Original entries in file order (by local-header offset, §3.2), which can differ from the
    // central-directory order `parts` keeps; then created parts in creation order.
    const all = [...this.parts.values()];
    const ordered = all.filter((s) => s.entry).sort((a, b) => a.entry!.extent[0] - b.entry!.extent[0]);
    for (const s of all) if (!s.entry) ordered.push(s);
    for (const s of ordered) {
      if (!s.entry) {
        if (s.data === null) continue;   // tombstone of a created-then-deleted part
        items.push({ add: s.name, data: this.currentBytes(s) });
        changed = true;
        continue;
      }
      if (s.data === null) { changed = true; continue; }
      if (!s.changed || this.sameAsOriginal(s)) { items.push({ keep: s.entry }); continue; }
      items.push({ replace: s.entry, data: this.currentBytes(s) });
      changed = true;
    }
    if (!changed && !force) return this.originalBytes;
    return writeZip(this.zip, items);
  }

  /**
   * As `serialize` (byte-identical result, same errors), but the expensive work (CRC-32 and byte
   * comparison of replaced parts against their originals, deflating every new or changed part)
   * yields to the event loop at least every `LIMITS.parseYieldMs` ms and between parts (§6.5, §10.2).
   *
   * The package state is captured synchronously, before the promise is returned: each changed
   * part's current bytes are produced then (a tree is serialised once; no deflating). Anything done
   * to the package after the call returns — an edit, or rolling back a temporary EditBuilder — does
   * not affect the result.
   */
  serializeAsync(opts?: { force?: boolean }): Promise<Uint8Array> {
    const force = opts?.force === true;
    if (!force && this.touchedParts().length === 0) return Promise.resolve(this.originalBytes);
    type Step = { item: ZipWriteItem } | { entry: ZipEntry; data: Uint8Array };
    const steps: Step[] = [];
    let changed = false;
    try {
      // Same order and the same decisions as serialize().
      const all = [...this.parts.values()];
      const ordered = all.filter((s) => s.entry).sort((a, b) => a.entry!.extent[0] - b.entry!.extent[0]);
      for (const s of all) if (!s.entry) ordered.push(s);
      for (const s of ordered) {
        if (!s.entry) {
          if (s.data === null) continue;
          steps.push({ item: { add: s.name, data: this.currentBytes(s) } });
          changed = true;
          continue;
        }
        if (s.data === null) { changed = true; continue; }
        if (!s.changed) { steps.push({ item: { keep: s.entry } }); continue; }
        if (s.touched && s.doc && s.origText !== undefined) {
          const text = serializeXml(s.doc);
          if (text === s.origText) { steps.push({ item: { keep: s.entry } }); continue; }
          steps.push({ item: { replace: s.entry, data: encodePart(text, s.bom ?? false) } });
          changed = true;
          continue;
        }
        // Compared with the original entry below (after a yield): kept when identical.
        steps.push({ entry: s.entry, data: this.currentBytes(s) });
      }
    } catch (e) {
      return Promise.reject(e);
    }
    return (async () => {
      const items: ZipWriteItem[] = [];
      for (const st of steps) {
        if ('item' in st) { items.push(st.item); continue; }
        if (await this.sameAsEntryAsync(st.entry, st.data)) { items.push({ keep: st.entry }); continue; }
        items.push({ replace: st.entry, data: st.data });
        changed = true;
      }
      if (!changed && !force) return this.originalBytes;
      return writeZipAsync(this.zip, items, LIMITS.parseYieldMs);
    })();
  }

  /** `sameAsOriginal` for bytes already produced, yielding while it CRCs and inflates. */
  private async sameAsEntryAsync(e: ZipEntry, data: Uint8Array): Promise<boolean> {
    if (data.length !== e.uncompressedSize) return false;
    if (await crc32Async(data, LIMITS.parseYieldMs) !== e.crc32) return false;
    const orig = await inflateEntryAsync(this.zip, e, LIMITS.parseYieldMs);
    for (let i = 0; i < data.length; i++) if (data[i] !== orig[i]) return false;
    return true;
  }

  /**
   * Whether `serialize()` (without `force`) would return `originalBytes` itself: nothing changed, or
   * every change was undone. Deflates nothing; a part replaced by setPart with bytes of its original
   * size and CRC is compared with the inflated original.
   */
  serializesToOriginal(): boolean {
    for (const s of this.parts.values()) {
      if (!s.entry) {
        if (s.data === null) continue;
        return false;
      }
      if (s.data === null) return false;
      if (s.changed && !this.sameAsOriginal(s)) return false;
    }
    return true;
  }

  private sameAsOriginal(s: PartState): boolean {
    const e = s.entry!;
    if (s.touched && s.doc && s.origText !== undefined) {
      return serializeXml(s.doc) === s.origText;   // BOM is unchanged: same decode
    }
    const data = this.currentBytes(s);
    if (data.length !== e.uncompressedSize || crc32(data) !== e.crc32) return false;
    const orig = inflateEntry(this.zip, e);
    for (let i = 0; i < data.length; i++) if (data[i] !== orig[i]) return false;
    return true;
  }
}
