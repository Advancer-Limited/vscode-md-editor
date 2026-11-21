// Load classification before anything else looks at a PDF (spec §9.4, §9.3).
//
// The host does not parse a PDF to show it (spec §6.1, plan rule 2): opening runs only these checks
// and hands the bytes to the webview, where pdf.js does the rest. `sniff` answers the questions that
// need no parser — empty, too large to open, not a PDF at all — and `sizeClass` turns a file size
// into the §9.3 viewing/editing bands. A damaged file that passes these checks is reported by pdf.js
// in the webview ("This file is damaged…").
//
// No `vscode` import here (core rule), no npm package.

import { PDF_LIMITS } from './limits.js';

export type PdfLoadFailure = 'empty' | 'not-pdf' | 'too-large';

/** The header must start within the first 1,024 bytes (spec §9.4; readers accept leading junk). */
export const HEADER_WINDOW = 1024;
/** `%%EOF` is looked for in this many trailing bytes (ISO 32000 §7.5.5 allows trailing junk). */
export const EOF_WINDOW = 1024;

const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2D];        // %PDF-
const EOF_MARK = [0x25, 0x25, 0x45, 0x4F, 0x46];      // %%EOF

function indexOfSeq(bytes: Uint8Array, seq: number[], from: number, to: number): number {
  const last = Math.min(to, bytes.length) - seq.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let k = 0; k < seq.length; k++) if (bytes[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfSeq(bytes: Uint8Array, seq: number[], from: number): number {
  for (let i = bytes.length - seq.length; i >= Math.max(0, from); i--) {
    let ok = true;
    for (let k = 0; ok && k < seq.length; k++) ok = bytes[i + k] === seq[k];
    if (ok) return i;
  }
  return -1;
}

/** Offset of `%PDF-` when it starts within the first `HEADER_WINDOW` bytes, else -1. */
export function headerOffset(bytes: Uint8Array): number {
  return indexOfSeq(bytes, HEADER, 0, HEADER_WINDOW - 1 + HEADER.length);
}

/** The header's version (`"1.7"`, `"2.0"`), or null when absent or not `d.d`. Display only. */
export function headerVersion(bytes: Uint8Array): string | null {
  const at = headerOffset(bytes);
  if (at < 0) return null;
  const p = at + HEADER.length;
  const d = (i: number): boolean => bytes[i] >= 0x30 && bytes[i] <= 0x39;
  if (p + 3 > bytes.length || !d(p) || bytes[p + 1] !== 0x2E || !d(p + 2)) return null;
  return String.fromCharCode(bytes[p], 0x2E, bytes[p + 2]);
}

/** Whether `%%EOF` occurs in the last `EOF_WINDOW` bytes. A missing marker is a fact, not a failure. */
export function hasEofMarker(bytes: Uint8Array): boolean {
  return lastIndexOfSeq(bytes, EOF_MARK, bytes.length - EOF_WINDOW) >= 0;
}

/** Failure from the size alone, so an over-limit file is refused from its `stat` without being read. */
export function sizeFailure(size: number): PdfLoadFailure | null {
  if (size === 0) return 'empty';
  if (size > PDF_LIMITS.maxFileBytes) return 'too-large';
  return null;
}

/** Checks in order: empty, over the open limit, no `%PDF-` header. Null when the bytes go to pdf.js. */
export function sniff(bytes: Uint8Array): PdfLoadFailure | null {
  return sizeFailure(bytes.length) ?? (headerOffset(bytes) < 0 ? 'not-pdf' : null);
}

export interface PdfSizeClass {
  /** §9.3: > 150 MB opens with a "large file" notice; thumbnails are not pre-rendered. */
  large: boolean;
  /** §9.3: > 100 MB is view-only (`too-large`). The page-count half of that rule needs the webview. */
  viewOnly: boolean;
}

export function sizeClass(size: number): PdfSizeClass {
  return { large: size > PDF_LIMITS.largeFileBytes, viewOnly: size > PDF_LIMITS.maxEditFileBytes };
}

/** Technical detail for a failure (the error view's "Details"); never document content. */
export function sniffDetail(failure: PdfLoadFailure, size: number): string {
  switch (failure) {
    case 'empty': return 'The file is 0 bytes long';
    case 'too-large': return `File is ${size} bytes; the limit is ${PDF_LIMITS.maxFileBytes}`;
    case 'not-pdf': return `No %PDF- header in the first ${HEADER_WINDOW} bytes`;
    default: return failure;
  }
}
