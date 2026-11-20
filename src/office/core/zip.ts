// ZIP container reader/writer (spec §3.2, §10.2, §10.3, §12).
//
// The reader parses the central directory (authoritative for sizes and CRCs) and computes each
// entry's *extent* — local header start up to the next local header (or the central directory) in
// file order — so the writer can copy an unchanged entry (local header + data + any data
// descriptor + anything else up to the next header) as raw bytes, untouched. Only the local-header
// offset field of an unchanged entry's central-directory record is ever patched.
//
// Consequence (§13.2 G1): read -> writeZip with every entry kept, in order, reproduces the input
// byte for byte.
//
// Nothing here inflates during readZip; limits are checked from the central directory first.

import { Inflate, deflateSync, inflateSync } from 'fflate';

export type ZipRefusal = 'not-zip' | 'truncated' | 'zip64' | 'multi-disk' | 'encrypted' | 'unsupported-compression'
  | 'duplicate-name' | 'unsafe-name' | 'overlap' | 'too-large' | 'bad-crc' | 'bad-data';

export class ZipError extends Error {
  readonly code: ZipRefusal;
  readonly entryName?: string;
  constructor(code: ZipRefusal, message: string, entryName?: string) {
    super(entryName !== undefined ? `${message} (${entryName})` : message);
    this.name = 'ZipError';
    this.code = code;
    if (entryName !== undefined) this.entryName = entryName;
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dosTime: number;
  readonly dosDate: number;
  /** Local header start .. next local header / CD start (file order). */
  readonly extent: readonly [number, number];
  /** This entry's central-directory record. */
  readonly cdRecord: readonly [number, number];
}

export interface ZipArchive { readonly bytes: Uint8Array; readonly entries: readonly ZipEntry[]; readonly comment: Uint8Array; }

export interface ZipLimits { maxFileBytes: number; maxTotalUncompressed: number; maxEntryUncompressed: number; }

export type ZipWriteItem = { keep: ZipEntry } | { replace: ZipEntry; data: Uint8Array } | { add: string; data: Uint8Array };

// ---------------------------------------------------------------------------------------------
// Constants

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const LOCAL_HEADER_LEN = 30;
const CENTRAL_HEADER_LEN = 46;
const EOCD_LEN = 22;
const ZIP64_LOCATOR_LEN = 20;
const MAX_COMMENT = 0xffff;

/** Offset of the "relative offset of local header" field inside a central-directory record. */
const CD_OFFSET_FIELD = 42;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_CD_ENCRYPTED = 0x2000;

const EXTRA_ZIP64 = 0x0001;

/** DOS date for 1980-01-01 (year offset 0, month 1, day 1); DOS time 00:00:00 is 0. */
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const VERSION_NEEDED_DEFLATE = 20;
const VERSION_MADE_BY_DEFAULT = 20; // MS-DOS host, spec version 2.0

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

// ---------------------------------------------------------------------------------------------
// Little-endian helpers

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function put16(b: Uint8Array, o: number, v: number): void { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320)

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  return crcTable;
}

export function crc32(data: Uint8Array): number {
  return (crc32Update(0xffffffff, data, 0, data.length) ^ 0xffffffff) >>> 0;
}

/** Running CRC register over data[from, to): start with 0xffffffff, finish with (c ^ 0xffffffff) >>> 0. */
function crc32Update(c: number, data: Uint8Array, from: number, to: number): number {
  const t = getCrcTable();
  for (let i = from; i < to; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Deflate / inflate (raw, no zlib/gzip wrapper)

export function rawDeflate(data: Uint8Array, level: 1 | 6): Uint8Array {
  return deflateSync(data, { level });
}

/** Largest input slice per step of bounded inflation (when `expectedSize` is given). */
const INFLATE_STEP = 64 * 1024;
/** Deflate's maximum expansion: one input byte can produce at most ~1032 output bytes. */
const DEFLATE_MAX_RATIO = 1032;
/**
 * Extra input bytes allowed per step beyond what the outstanding output needs at the maximum ratio.
 * Bounds the output of one step past the declared size to about INFLATE_SLACK * DEFLATE_MAX_RATIO
 * (~4 MB). Smaller values cost throughput (more, smaller pushes): measured on a 20 MB XML entry,
 * 4 KB is as fast as fixed 64 KB steps, 1 KB about 30 % slower.
 */
const INFLATE_SLACK = 4096;

/**
 * Inflation bounded by a declared size, pushed through fflate's streaming Inflate in steps whose input
 * is capped so that even at the maximum deflate ratio a step cannot produce much more than the output
 * still outstanding. A bomb is therefore refused after a few MB of overshoot instead of after a whole
 * 64 KB slice (~64 MB). Normal entries still use 64 KB steps until they are close to their end.
 */
class BoundedInflate {
  /** Chunks, not a buffer of `expectedSize`: the size is untrusted, memory follows the data produced. */
  private readonly chunks: Uint8Array[] = [];
  private written = 0;
  private ended = false;
  private pos = 0;
  private started = false;
  private readonly inf: Inflate;
  private readonly data: Uint8Array;
  private readonly expectedSize: number;

  constructor(data: Uint8Array, expectedSize: number) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new ZipError('bad-data', `Invalid expected size ${expectedSize}`);
    }
    this.data = data;
    this.expectedSize = expectedSize;
    this.inf = new Inflate((chunk: Uint8Array, final: boolean) => {
      if (this.written + chunk.length > expectedSize) {
        throw new ZipError('bad-data', `Inflated data exceeds the declared size of ${expectedSize} bytes`);
      }
      if (chunk.length) this.chunks.push(chunk);
      this.written += chunk.length;
      if (final) this.ended = true;
    });
  }

  /**
   * Push input until it is exhausted or at least `want` bytes are out (returns true), or until
   * `deadline` (Date.now() ms) passes (returns false: call again). Throws ZipError('bad-data').
   */
  run(want: number, deadline: number): boolean {
    const data = this.data;
    try {
      if (data.length === 0) {
        if (!this.started) { this.started = true; this.inf.push(data, true); }
        return true;
      }
      const target = Math.min(want, this.expectedSize);
      while (this.pos < data.length) {
        if (this.written >= want) return true;
        if (this.started && Date.now() >= deadline) return false;
        this.started = true;
        const need = Math.ceil(Math.max(0, target - this.written) / DEFLATE_MAX_RATIO) + INFLATE_SLACK;
        const end = Math.min(this.pos + Math.min(INFLATE_STEP, need), data.length);
        this.inf.push(data.subarray(this.pos, end), end === data.length);
        this.pos = end;
      }
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new ZipError('bad-data', `Invalid deflate data: ${errText(e)}`);
    }
    return true;
  }

  /** The complete output; throws ZipError('bad-data') unless the stream ended at exactly `expectedSize`. */
  result(): Uint8Array {
    if (!this.ended || this.written !== this.expectedSize) {
      throw new ZipError('bad-data', `Inflated ${this.written} bytes, expected ${this.expectedSize}`);
    }
    return this.concat(this.expectedSize);
  }

  /** The first `max` bytes produced so far (fewer if fewer were produced). */
  prefix(max: number): Uint8Array {
    return this.concat(Math.min(max, this.written));
  }

  private concat(n: number): Uint8Array {
    const chunks = this.chunks;
    if (chunks.length === 1 && chunks[0].length === n) return chunks[0];
    const out = new Uint8Array(n);
    let w = 0;
    for (const c of chunks) {
      if (w >= n) break;
      const take = Math.min(c.length, n - w);
      out.set(take === c.length ? c : c.subarray(0, take), w);
      w += take;
    }
    return out;
  }
}

/**
 * Raw-inflate `data`. With `expectedSize`, the output MUST be exactly that long: inflation stops as
 * soon as more output appears (so a lying size cannot make us allocate or work without bound) and
 * a short result is an error. Throws ZipError('bad-data') on any malformed stream.
 */
export function rawInflate(data: Uint8Array, expectedSize?: number): Uint8Array {
  if (expectedSize === undefined) {
    try {
      return inflateSync(data);
    } catch (e) {
      throw new ZipError('bad-data', `Invalid deflate data: ${errText(e)}`);
    }
  }
  const b = new BoundedInflate(data, expectedSize);
  b.run(Infinity, Infinity);
  return b.result();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------
// Names

// CP437 code points for bytes 0x80..0xFF (names without the UTF-8 flag, APPNOTE appendix D).
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (utf8) {
    try {
      return utf8Decoder.decode(raw);
    } catch {
      throw new ZipError('bad-data', 'Entry name is flagged UTF-8 but is not valid UTF-8');
    }
  }
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  }
  return s;
}

/**
 * Unsafe: empty, contains NUL, absolute (leading `/` or `\`, or a drive letter), or has a `..`
 * path segment (either separator counts, since other tools treat `\` as one).
 */
function isUnsafeName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.includes('\0')) return true;
  if (name[0] === '/' || name[0] === '\\') return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).some((seg) => seg === '..');
}

function nameKey(name: string): string {
  return name.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Reader

function findEocd(bytes: Uint8Array): number {
  const last = bytes.length - EOCD_LEN;
  const first = Math.max(0, last - MAX_COMMENT);
  let sawSignature = false;
  let sawCutOff = false;
  for (let p = last; p >= first; p--) {
    if (bytes[p] === 0x50 && bytes[p + 1] === 0x4b && bytes[p + 2] === 0x05 && bytes[p + 3] === 0x06) {
      sawSignature = true;
      // The comment must end exactly at the end of the file; trailing bytes after an archive are
      // refused (they could not be reproduced and other readers disagree about them).
      const end = p + EOCD_LEN + u16(bytes, p + 20);
      if (end === bytes.length) return p;
      if (end > bytes.length) sawCutOff = true;
    }
  }
  // A file that does not start like a ZIP (local header) is "not a zip" even if its tail happens to
  // contain EOCD-like bytes — e.g. a legacy OLE .doc renamed to .docx.
  const startsLikeZip = bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL;
  if (!startsLikeZip) throw new ZipError('not-zip', 'Not a ZIP archive');
  if (sawCutOff) throw new ZipError('truncated', 'Archive comment runs past the end of the file; the file looks truncated');
  if (sawSignature) throw new ZipError('bad-data', 'End of central directory comment length does not match the file');
  throw new ZipError('truncated', 'End of central directory record not found; the file looks truncated');
}

function hasZip64Extra(bytes: Uint8Array, start: number, len: number): boolean {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = u16(bytes, p);
    const size = u16(bytes, p + 2);
    if (id === EXTRA_ZIP64) return true;
    p += 4 + size;
  }
  return false;
}

interface ParsedEntry {
  name: string;
  rawName: Uint8Array;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dosTime: number;
  dosDate: number;
  localOffset: number;
  cdStart: number;
  cdEnd: number;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipArchive {
  if (bytes.length > limits.maxFileBytes) {
    throw new ZipError('too-large', `File is ${bytes.length} bytes; the limit is ${limits.maxFileBytes}`);
  }
  if (bytes.length < EOCD_LEN) {
    const startsLikeZip = bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL;
    throw new ZipError(startsLikeZip ? 'truncated' : 'not-zip', startsLikeZip ? 'File is truncated' : 'Not a ZIP archive');
  }

  const eocd = findEocd(bytes);
  const diskNo = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entriesTotal = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const commentLen = u16(bytes, eocd + 20);

  // ZIP64: a locator right before the EOCD, a ZIP64 EOCD record, or saturated EOCD fields.
  if (eocd >= ZIP64_LOCATOR_LEN && u32(bytes, eocd - ZIP64_LOCATOR_LEN) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (diskNo === U16_MAX || cdDisk === U16_MAX || entriesOnDisk === U16_MAX || entriesTotal === U16_MAX
    || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== entriesTotal) {
    throw new ZipError('multi-disk', 'Multi-disk (spanned) archives are not supported');
  }

  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) {
    throw new ZipError(cdEnd > bytes.length ? 'truncated' : 'bad-data', 'Central directory extends past its end record');
  }
  if (cdEnd < eocd) {
    // Something sits between the central directory and its end record.
    for (let p = cdEnd; p + 4 <= eocd; p++) {
      const sig = u32(bytes, p);
      if (sig === SIG_ZIP64_EOCD || sig === SIG_ZIP64_LOCATOR) throw new ZipError('zip64', 'ZIP64 archives are not supported');
    }
    throw new ZipError('bad-data', 'Unexpected bytes between the central directory and its end record');
  }

  // --- central directory
  const parsed: ParsedEntry[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < entriesTotal; i++) {
    if (p + CENTRAL_HEADER_LEN > cdEnd || u32(bytes, p) !== SIG_CENTRAL) {
      throw new ZipError('bad-data', `Central directory record ${i} is malformed`);
    }
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const dosTime = u16(bytes, p + 12);
    const dosDate = u16(bytes, p + 14);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const diskStart = u16(bytes, p + 34);
    const localOffset = u32(bytes, p + CD_OFFSET_FIELD);
    const recEnd = p + CENTRAL_HEADER_LEN + nameLen + extraLen + commentLength;
    if (recEnd > cdEnd) throw new ZipError('bad-data', `Central directory record ${i} overruns the directory`);

    const rawName = bytes.slice(p + CENTRAL_HEADER_LEN, p + CENTRAL_HEADER_LEN + nameLen);
    const name = decodeName(rawName, (flags & FLAG_UTF8) !== 0);

    if (csize === U32_MAX || usize === U32_MAX || localOffset === U32_MAX || diskStart === U16_MAX
      || hasZip64Extra(bytes, p + CENTRAL_HEADER_LEN + nameLen, extraLen)) {
      throw new ZipError('zip64', 'ZIP64 entries are not supported', name);
    }
    if (diskStart !== 0) throw new ZipError('multi-disk', 'Entry starts on another disk', name);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_CD_ENCRYPTED)) {
      throw new ZipError('encrypted', 'Encrypted entries are not supported', name);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('unsupported-compression', `Compression method ${method} is not supported`, name);
    }
    if (isUnsafeName(name)) throw new ZipError('unsafe-name', 'Unsafe entry name', name);
    const key = nameKey(name);
    const prior = seen.get(key);
    if (prior !== undefined) throw new ZipError('duplicate-name', `Duplicate entry name (also "${prior}")`, name);
    seen.set(key, name);

    if (method === 0 && csize !== usize) {
      throw new ZipError('bad-data', 'Stored entry has different compressed and uncompressed sizes', name);
    }
    if (usize > limits.maxEntryUncompressed) {
      throw new ZipError('too-large', `Entry declares ${usize} bytes; the limit is ${limits.maxEntryUncompressed}`, name);
    }
    total += usize;
    if (total > limits.maxTotalUncompressed) {
      throw new ZipError('too-large', `Archive declares more than ${limits.maxTotalUncompressed} uncompressed bytes`);
    }

    parsed.push({
      name, rawName, method, flags, crc32: crc, compressedSize: csize, uncompressedSize: usize,
      dosTime, dosDate, localOffset, cdStart: p, cdEnd: recEnd,
    });
    p = recEnd;
  }
  if (p !== cdEnd) throw new ZipError('bad-data', 'Central directory size does not match its records');

  // --- local headers and extents (file order)
  const order = parsed.map((_, i) => i).sort((a, b) => parsed[a].localOffset - parsed[b].localOffset);
  if (order.length > 0 && parsed[order[0]].localOffset !== 0) {
    throw new ZipError('bad-data', 'Unexpected bytes before the first entry');
  }
  if (order.length === 0 && cdOffset !== 0) {
    throw new ZipError('bad-data', 'Unexpected bytes before the central directory');
  }
  const extents: Array<[number, number]> = new Array(parsed.length);
  for (let k = 0; k < order.length; k++) {
    const e = parsed[order[k]];
    const start = e.localOffset;
    const end = k + 1 < order.length ? parsed[order[k + 1]].localOffset : cdOffset;
    if (start >= cdOffset) throw new ZipError('overlap', 'Entry overlaps the central directory', e.name);
    if (end === start) throw new ZipError('overlap', 'Two entries share one local header', e.name);
    if (start + LOCAL_HEADER_LEN > end) throw new ZipError('overlap', 'Local header overlaps the next entry', e.name);
    if (u32(bytes, start) !== SIG_LOCAL) throw new ZipError('bad-data', 'Local header signature missing', e.name);

    const lFlags = u16(bytes, start + 6);
    const lMethod = u16(bytes, start + 8);
    const lCrc = u32(bytes, start + 14);
    const lCsize = u32(bytes, start + 18);
    const lUsize = u32(bytes, start + 22);
    const lNameLen = u16(bytes, start + 26);
    const lExtraLen = u16(bytes, start + 28);
    const dataStart = start + LOCAL_HEADER_LEN + lNameLen + lExtraLen;
    if (dataStart > end) throw new ZipError('overlap', 'Local header overlaps the next entry', e.name);
    // The local and central views must agree, or another reader could see a different file.
    if (!sameBytes(bytes.subarray(start + LOCAL_HEADER_LEN, start + LOCAL_HEADER_LEN + lNameLen), e.rawName)) {
      throw new ZipError('bad-data', 'Local header name differs from the central directory', e.name);
    }
    if (lFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError('encrypted', 'Encrypted entries are not supported', e.name);
    if (lMethod !== e.method) throw new ZipError('bad-data', 'Local header compression method differs from the central directory', e.name);
    if ((lFlags & FLAG_DATA_DESCRIPTOR) !== (e.flags & FLAG_DATA_DESCRIPTOR)) {
      throw new ZipError('bad-data', 'Local header data-descriptor flag differs from the central directory', e.name);
    }
    if (!(lFlags & FLAG_DATA_DESCRIPTOR)) {
      if (lCrc === U32_MAX && lCsize === U32_MAX) throw new ZipError('zip64', 'ZIP64 entries are not supported', e.name);
      if (lCrc !== e.crc32 || lCsize !== e.compressedSize || lUsize !== e.uncompressedSize) {
        throw new ZipError('bad-data', 'Local header sizes or CRC differ from the central directory', e.name);
      }
    }
    if (dataStart + e.compressedSize > end) {
      throw new ZipError('overlap', 'Entry data overlaps the next entry or the central directory', e.name);
    }
    extents[order[k]] = [start, end];
  }

  const entries: ZipEntry[] = parsed.map((e, i) => Object.freeze({
    name: e.name,
    method: e.method as 0 | 8,
    flags: e.flags,
    crc32: e.crc32,
    compressedSize: e.compressedSize,
    uncompressedSize: e.uncompressedSize,
    dosTime: e.dosTime,
    dosDate: e.dosDate,
    extent: Object.freeze(extents[i]) as readonly [number, number],
    cdRecord: Object.freeze([e.cdStart, e.cdEnd]) as readonly [number, number],
  }));

  return Object.freeze({
    bytes,
    entries: Object.freeze(entries),
    comment: bytes.slice(eocd + EOCD_LEN, eocd + EOCD_LEN + commentLen),
  });
}

/** Offset of the compressed data of `entry` (after its local header, name and extra field). */
function dataOffset(bytes: Uint8Array, entry: ZipEntry): number {
  const start = entry.extent[0];
  return start + LOCAL_HEADER_LEN + u16(bytes, start + 26) + u16(bytes, start + 28);
}

const memberSets = new WeakMap<ZipArchive, Set<ZipEntry>>();
function memberSet(zip: ZipArchive): Set<ZipEntry> {
  let s = memberSets.get(zip);
  if (!s) { s = new Set(zip.entries); memberSets.set(zip, s); }
  return s;
}

function assertMember(zip: ZipArchive, entry: ZipEntry): void {
  if (!memberSet(zip).has(entry)) throw new Error('ZIP entry does not belong to this archive');
}

function entryData(zip: ZipArchive, entry: ZipEntry): Uint8Array {
  assertMember(zip, entry);
  const start = dataOffset(zip.bytes, entry);
  return zip.bytes.subarray(start, start + entry.compressedSize);
}

function withName<T>(entry: ZipEntry, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ZipError && e.entryName === undefined) throw new ZipError(e.code, e.message, entry.name);
    throw e;
  }
}

/**
 * The first `maxBytes` bytes of an entry's data (fewer if the entry is shorter), inflating only about
 * that much (bounded work and memory, whatever the entry's size). No CRC check: the data is partial.
 * Throws ZipError('bad-data') for a malformed stream or output beyond the declared size.
 */
export function inflateEntryPrefix(zip: ZipArchive, entry: ZipEntry, maxBytes: number): Uint8Array {
  const raw = entryData(zip, entry);
  if (entry.method === 0) return raw.slice(0, Math.min(maxBytes, raw.length));
  return withName(entry, () => {
    const b = new BoundedInflate(raw, entry.uncompressedSize);
    b.run(maxBytes, Infinity);
    return b.prefix(maxBytes);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/** CRC-32 bytes processed between deadline checks in `inflateEntryAsync`. */
const CRC_SLICE = 1024 * 1024;

/**
 * As `inflateEntry`, yielding to the event loop at least every `yieldEveryMs` ms while inflating and
 * checking the CRC (spec 10.2: host-side work on large parts must not block). Rejects with ZipError.
 */
export async function inflateEntryAsync(zip: ZipArchive, entry: ZipEntry, yieldEveryMs: number): Promise<Uint8Array> {
  const raw = entryData(zip, entry);
  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw.slice();
  } else {
    const b = withName(entry, () => new BoundedInflate(raw, entry.uncompressedSize));
    while (!withName(entry, () => b.run(Infinity, Date.now() + yieldEveryMs))) await yieldToEventLoop();
    out = withName(entry, () => b.result());
  }
  let c = 0xffffffff;
  let deadline = Date.now() + yieldEveryMs;
  for (let pos = 0; pos < out.length; pos += CRC_SLICE) {
    if (Date.now() >= deadline) { await yieldToEventLoop(); deadline = Date.now() + yieldEveryMs; }
    c = crc32Update(c, out, pos, Math.min(pos + CRC_SLICE, out.length));
  }
  if (((c ^ 0xffffffff) >>> 0) !== entry.crc32) throw new ZipError('bad-crc', 'CRC-32 mismatch', entry.name);
  return out;
}

export function inflateEntry(zip: ZipArchive, entry: ZipEntry): Uint8Array {
  assertMember(zip, entry);
  const start = dataOffset(zip.bytes, entry);
  const raw = zip.bytes.subarray(start, start + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw.slice();
  } else {
    try {
      out = rawInflate(raw, entry.uncompressedSize);
    } catch (e) {
      if (e instanceof ZipError) throw new ZipError(e.code, e.message, entry.name);
      throw e;
    }
  }
  if (crc32(out) !== entry.crc32) throw new ZipError('bad-crc', 'CRC-32 mismatch', entry.name);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writer

function localHeader(rawName: Uint8Array, flags: number, method: number, dosTime: number, dosDate: number,
  crc: number, csize: number, usize: number): Uint8Array {
  const h = new Uint8Array(LOCAL_HEADER_LEN + rawName.length);
  put32(h, 0, SIG_LOCAL);
  put16(h, 4, VERSION_NEEDED_DEFLATE);
  put16(h, 6, flags);
  put16(h, 8, method);
  put16(h, 10, dosTime);
  put16(h, 12, dosDate);
  put32(h, 14, crc);
  put32(h, 18, csize);
  put32(h, 22, usize);
  put16(h, 26, rawName.length);
  put16(h, 28, 0);
  h.set(rawName, LOCAL_HEADER_LEN);
  return h;
}

interface CentralFields {
  versionMadeBy: number; flags: number; method: number; dosTime: number; dosDate: number;
  crc: number; csize: number; usize: number; rawName: Uint8Array; comment: Uint8Array;
  internalAttr: number; externalAttr: number; offset: number;
}

function centralRecord(f: CentralFields): Uint8Array {
  const r = new Uint8Array(CENTRAL_HEADER_LEN + f.rawName.length + f.comment.length);
  put32(r, 0, SIG_CENTRAL);
  put16(r, 4, f.versionMadeBy);
  put16(r, 6, VERSION_NEEDED_DEFLATE);
  put16(r, 8, f.flags);
  put16(r, 10, f.method);
  put16(r, 12, f.dosTime);
  put16(r, 14, f.dosDate);
  put32(r, 16, f.crc);
  put32(r, 20, f.csize);
  put32(r, 24, f.usize);
  put16(r, 28, f.rawName.length);
  put16(r, 30, 0);
  put16(r, 32, f.comment.length);
  put16(r, 34, 0);
  put16(r, 36, f.internalAttr);
  put32(r, 38, f.externalAttr);
  put32(r, CD_OFFSET_FIELD, f.offset);
  r.set(f.rawName, CENTRAL_HEADER_LEN);
  r.set(f.comment, CENTRAL_HEADER_LEN + f.rawName.length);
  return r;
}

function checkU32(n: number, what: string, name?: string): void {
  if (n > U32_MAX) throw new ZipError('too-large', `${what} would need ZIP64`, name);
}

/**
 * Write a new archive from `zip`. `items` are in output order (local data and central directory
 * alike); entries of `zip` not mentioned are removed. Unchanged (`keep`) entries are copied as raw
 * bytes: their whole extent, and their central record with only the local-header offset patched.
 */
export function writeZip(zip: ZipArchive, items: ZipWriteItem[]): Uint8Array {
  const src = zip.bytes;
  const members = memberSet(zip);
  const used = new Set<ZipEntry>();
  const names = new Map<string, string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const claimName = (name: string): void => {
    const key = nameKey(name);
    const prior = names.get(key);
    if (prior !== undefined) throw new ZipError('duplicate-name', `Duplicate entry name (also "${prior}")`, name);
    names.set(key, name);
  };
  const claimEntry = (entry: ZipEntry): void => {
    if (!members.has(entry)) throw new Error('ZIP entry does not belong to this archive');
    if (used.has(entry)) throw new ZipError('duplicate-name', 'Entry listed twice', entry.name);
    used.add(entry);
    claimName(entry.name);
  };

  for (const item of items) {
    checkU32(offset, 'Archive size');
    if ('keep' in item) {
      const e = item.keep;
      claimEntry(e);
      const [xs, xe] = e.extent;
      locals.push(src.subarray(xs, xe));
      const rec = src.slice(e.cdRecord[0], e.cdRecord[1]);
      put32(rec, CD_OFFSET_FIELD, offset);
      centrals.push(rec);
      offset += xe - xs;
    } else if ('replace' in item) {
      const e = item.replace;
      claimEntry(e);
      const cd = e.cdRecord[0];
      const nameLen = u16(src, cd + 28);
      const extraLen = u16(src, cd + 30);
      const commentLen = u16(src, cd + 32);
      const rawName = src.slice(cd + CENTRAL_HEADER_LEN, cd + CENTRAL_HEADER_LEN + nameLen);
      const comment = src.slice(cd + CENTRAL_HEADER_LEN + nameLen + extraLen, cd + CENTRAL_HEADER_LEN + nameLen + extraLen + commentLen);
      checkU32(item.data.length, 'Entry size', e.name);
      const packed = rawDeflate(item.data, 6);
      checkU32(packed.length, 'Entry size', e.name);
      const crc = crc32(item.data);
      const flags = e.flags & FLAG_UTF8;
      const head = localHeader(rawName, flags, 8, e.dosTime, e.dosDate, crc, packed.length, item.data.length);
      locals.push(head, packed);
      centrals.push(centralRecord({
        versionMadeBy: u16(src, cd + 4), flags, method: 8, dosTime: e.dosTime, dosDate: e.dosDate,
        crc, csize: packed.length, usize: item.data.length, rawName, comment,
        internalAttr: u16(src, cd + 36), externalAttr: u32(src, cd + 38), offset,
      }));
      offset += head.length + packed.length;
    } else {
      const name = item.add;
      if (isUnsafeName(name)) throw new ZipError('unsafe-name', 'Unsafe entry name', name);
      claimName(name);
      const rawName = utf8Encoder.encode(name);
      if (rawName.length > U16_MAX) throw new ZipError('unsafe-name', 'Entry name is too long', name);
      checkU32(item.data.length, 'Entry size', name);
      const packed = rawDeflate(item.data, 6);
      checkU32(packed.length, 'Entry size', name);
      const crc = crc32(item.data);
      // eslint-disable-next-line no-control-regex
      const flags = /^[\x00-\x7f]*$/.test(name) ? 0 : FLAG_UTF8;
      const head = localHeader(rawName, flags, 8, 0, DOS_DATE_1980_01_01, crc, packed.length, item.data.length);
      locals.push(head, packed);
      centrals.push(centralRecord({
        versionMadeBy: VERSION_MADE_BY_DEFAULT, flags, method: 8, dosTime: 0, dosDate: DOS_DATE_1980_01_01,
        crc, csize: packed.length, usize: item.data.length, rawName, comment: new Uint8Array(0),
        internalAttr: 0, externalAttr: 0, offset,
      }));
      offset += head.length + packed.length;
    }
  }

  if (centrals.length > U16_MAX - 1) throw new ZipError('too-large', 'Too many entries; would need ZIP64');
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;
  checkU32(cdOffset, 'Archive size');
  checkU32(cdOffset + cdSize, 'Archive size');
  if (zip.comment.length > MAX_COMMENT) throw new ZipError('bad-data', 'Archive comment is too long');

  const eocd = new Uint8Array(EOCD_LEN + zip.comment.length);
  put32(eocd, 0, SIG_EOCD);
  put16(eocd, 4, 0);
  put16(eocd, 6, 0);
  put16(eocd, 8, centrals.length);
  put16(eocd, 10, centrals.length);
  put32(eocd, 12, cdSize);
  put32(eocd, 16, cdOffset);
  put16(eocd, 20, zip.comment.length);
  eocd.set(zip.comment, EOCD_LEN);

  const out = new Uint8Array(cdOffset + cdSize + eocd.length);
  let w = 0;
  for (const part of locals) { out.set(part, w); w += part.length; }
  for (const part of centrals) { out.set(part, w); w += part.length; }
  out.set(eocd, w);
  return out;
}
