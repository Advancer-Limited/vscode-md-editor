// Load classification before the ZIP reader runs (spec §10.3).
//
// `sniff` answers the questions that do not need the container: is this a lock file, an empty file,
// too big to open, or an OLE compound file (a password-protected OOXML package, or a legacy binary
// .doc/.xls renamed to .docx/.xlsx)? Everything else is left to `OfficePackage.open`, which maps
// container and parser errors onto the same `LoadFailure` codes.
//
// No `vscode` import here (core rule).

import { LIMITS } from './limits.js';

export type LoadFailure = 'empty' | 'lock-file' | 'encrypted-ole' | 'legacy-ole' | 'damaged' | 'unsupported-packaging' | 'too-large';

export class OfficeLoadError extends Error {
  readonly failure: LoadFailure;
  /** Technical reason, for the error view's "Details" disclosure. Never contains document content. */
  readonly detail: string;
  constructor(failure: LoadFailure, detail: string) {
    super(`${failure}: ${detail}`);
    this.name = 'OfficeLoadError';
    this.failure = failure;
    this.detail = detail;
  }
}

/** OLE compound-file signature `D0 CF 11 E0 A1 B1 1A E1`. */
const OLE_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const OLE_HEADER_LEN = 512;
const OLE_DIR_ENTRY_LEN = 128;
const OLE_TYPE_STREAM = 2;

/** Stream names of an encrypted OOXML package ([MS-OFFCRYPTO] §2.3.4). */
const ENCRYPTION_STREAMS = ['EncryptedPackage', 'EncryptionInfo'];

function baseName(fileName: string): string {
  const i = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return i >= 0 ? fileName.slice(i + 1) : fileName;
}

export function isOleCompoundFile(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_SIGNATURE.length) return false;
  for (let i = 0; i < OLE_SIGNATURE.length; i++) if (bytes[i] !== OLE_SIGNATURE[i]) return false;
  return true;
}

/**
 * True when the compound file has a directory entry for a stream called `name`.
 *
 * Directory sectors are sector-aligned and sector sizes (512 or 4096) are multiples of the 128-byte
 * entry size, so every directory entry starts at a 128-byte-aligned offset after the 512-byte header.
 * A slot only counts when it is a well-formed stream entry: the UTF-16LE name, its NUL terminator, the
 * name-length field (bytes incl. terminator) and the object type all agree. Text that merely mentions
 * the name inside a stream (a .doc whose body says "EncryptedPackage") does not match.
 */
export function oleHasStream(bytes: Uint8Array, name: string): boolean {
  const nameBytes = (name.length + 1) * 2;
  for (let p = OLE_HEADER_LEN; p + OLE_DIR_ENTRY_LEN <= bytes.length; p += OLE_DIR_ENTRY_LEN) {
    if ((bytes[p + 64] | (bytes[p + 65] << 8)) !== nameBytes) continue;
    if (bytes[p + 66] !== OLE_TYPE_STREAM) continue;
    let ok = bytes[p + nameBytes - 2] === 0 && bytes[p + nameBytes - 1] === 0;
    for (let k = 0; ok && k < name.length; k++) {
      const c = name.charCodeAt(k);
      ok = bytes[p + 2 * k] === (c & 0xff) && bytes[p + 2 * k + 1] === (c >>> 8);
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Pre-ZIP checks, in order: lock-file name (`~$…`), empty file, over the file-size limit, OLE compound
 * file (encrypted package if it has an `EncryptedPackage`/`EncryptionInfo` stream, otherwise a legacy
 * binary document). Returns null when the bytes should go to the ZIP reader.
 */
export function sniff(fileName: string, bytes: Uint8Array): LoadFailure | null {
  if (baseName(fileName).startsWith('~$')) return 'lock-file';
  if (bytes.length === 0) return 'empty';
  if (bytes.length > LIMITS.maxFileBytes) return 'too-large';
  if (isOleCompoundFile(bytes)) {
    return ENCRYPTION_STREAMS.some((s) => oleHasStream(bytes, s)) ? 'encrypted-ole' : 'legacy-ole';
  }
  return null;
}

/** Plain-language detail for a sniff result (no document content). */
export function sniffDetail(failure: LoadFailure, fileName: string, bytes: Uint8Array): string {
  switch (failure) {
    case 'lock-file': return `"${baseName(fileName)}" is an Office lock file (name starts with ~$)`;
    case 'empty': return 'The file is 0 bytes long';
    case 'too-large': return `File is ${bytes.length} bytes; the limit is ${LIMITS.maxFileBytes}`;
    case 'encrypted-ole': return 'OLE compound file with an EncryptedPackage/EncryptionInfo stream (password-protected package)';
    case 'legacy-ole': {
      const kind = oleHasStream(bytes, 'WordDocument') ? ' (WordDocument stream: Word 97-2003)'
        : oleHasStream(bytes, 'Workbook') || oleHasStream(bytes, 'Book') ? ' (Workbook stream: Excel 97-2003)' : '';
      return `OLE compound file without an encrypted package${kind}`;
    }
    default: return failure;
  }
}
