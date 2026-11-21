// PDF viewer message protocol (spec §5). Pure types plus inbound validators; no `vscode` import,
// only erasable TypeScript syntax (the file also loads under Node type-stripping, with a resolve
// hook mapping `./x.js` to `./x.ts`; see tests/pdf/protocol.test.mjs).
//
// STATUS
//   FROZEN (view half, PWP-04): PdfReadOnlyReason, PdfFacts, `pdfRequestDocument`, `pdfDocument`,
//     `pdfFacts`, `pdfSaveAttachment`, `pdfSaveAttachmentResult`, the common Office messages, and
//     the limits and rules that govern them. A change is a plan/spec change made with spec §5.
//   AMENDMENT (view half, 2026-11-21, approved by the user): `pdfLog` (spec §5, §12).
//   DRAFT (edit half): PdfColor .. PdfObserved, `pdfState`, `pdfEditInfo`, `pdfEdit`,
//     `pdfEditResult`, `pdfWrite`, `pdfWriteResult`. Confirmed (not redesigned) by the
//     orchestrator at the start of Phase 2 (plan §3); the validators below already enforce them.
//
// Facts from the spikes: the host posts a plain `Uint8Array` (a Node `Buffer` arrives in the
// webview as `{ type: 'Buffer', data: [...] }`); 100 MB crosses in about 1 s either way. The
// password of an encrypted file never leaves the webview, so no message carries one.
// Known follow-up for PWP-06: `OfficeCommonToWebview` `init` has `kind: 'docx' | 'xlsx'` and
// `readOnlyReason: ReadOnlyReason`; it must be widened for `'pdf'` and `PdfReadOnlyReason`.

import { parseCommonToHost } from '../office/protocol.js';
import type { OfficeCommonToWebview, OfficeCommonToHost, OfficeError } from '../office/protocol.js';

// ---------- shared types ----------

// FROZEN
export type PdfReadOnlyReason =
  | 'view-mode' | 'non-writable-scheme' | 'too-large'
  | 'encrypted'               // §9.1
  | 'unsupported-structure'   // the strict reader refused the file (§3.3, §6.2)
  | 'engine-too-old';         // §10.4

// FROZEN
export interface PdfFacts {
  pageCount: number; encrypted: boolean; hasText: boolean; hasJavaScript: boolean;
  hasXfa: boolean; attachmentCount: number;
  signatures: Array<{ signer: string; reason: string; time: string }>;
}

// FROZEN (amendment 2026-11-21): the small fixed set of things the webview may report to the host log.
export type PdfLogLevel = 'info' | 'warn' | 'error';
export type PdfLogCode = 'csp-violation' | 'worker-fallback' | 'page-render-failed';

// DRAFT (edit half)
export type PdfColor = 'yellow' | 'green' | 'blue' | 'pink' | 'red';
export interface PdfObjRef { num: number; gen: number; }      // an object in the loaded file

// Geometry is in PDF user space of the page (points, origin bottom-left, unrotated).
export type PdfAnnotSpec =
  | { kind: 'highlight'; localId: number; page: number; quads: number[];   // 8 numbers per quad
      color: PdfColor; comment: string }
  | { kind: 'ink'; localId: number; page: number; paths: number[][];       // x,y pairs per stroke
      color: PdfColor; width: 1 | 2 | 4; comment: string };

export type PdfFieldValue = string | boolean | string[];       // text | checkbox/radio widget | choice

export type PdfEditOp =
  | { op: 'addAnnotation'; spec: PdfAnnotSpec }
  | { op: 'updateAnnotation'; localId: number; patch: { comment?: string; color?: PdfColor } }  // session-created only
  | { op: 'removeAnnotation'; target: { localId: number } | { ref: PdfObjRef } }
  | { op: 'setFields'; values: Array<{ ref: PdfObjRef; value: PdfFieldValue }> };

export interface PdfStateView {                                 // what the webview draws
  version: number;
  annots: Array<PdfAnnotSpec & { createdAt: string }>;
  removed: PdfObjRef[];
  fields: Array<{ ref: PdfObjRef; value: PdfFieldValue }>;
}

export interface PdfEditInfo {                                  // result of classification (§6.2)
  deletable: PdfObjRef[];                                       // existing markup annotations
  forms: { editable: boolean; reason?: 'flag-off' | 'xfa' | 'none'; lockedFields: PdfObjRef[] };
  signed: boolean;
}

export interface PdfObserved { pageCount: number; annotsPerPage: number[];
  fields: Array<{ ref: PdfObjRef; value: PdfFieldValue }>; }

// ---------- messages ----------

export type PdfToWebview = OfficeCommonToWebview
  | { type: 'pdfDocument'; generation: number; version: number; bytes: Uint8Array }  // FROZEN: the bytes of this generation
  | { type: 'pdfState'; state: PdfStateView }                                         // DRAFT from here on
  | { type: 'pdfEditInfo'; info: PdfEditInfo }
  | { type: 'pdfEditResult'; requestId: number; ok: true; state: PdfStateView }
  | { type: 'pdfEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'pdfWrite'; requestId: number; generation: number; version: number;
      storage: Array<[key: string, entry: unknown]> }           // produced by storageAdapter (§6.4)
  | { type: 'pdfSaveAttachmentResult'; requestId: number; ok: boolean };              // FROZEN

export type PdfToHost = OfficeCommonToHost
  | { type: 'pdfRequestDocument' }                              // FROZEN
  | { type: 'pdfFacts'; facts: PdfFacts }                       // FROZEN; display only, never used for a decision
  | { type: 'pdfLog'; level: PdfLogLevel; code: PdfLogCode; detail?: string }          // FROZEN (amendment 2026-11-21); appended to the output channel, never shown
  | { type: 'pdfSaveAttachment'; requestId: number; name: string; bytes: Uint8Array }  // FROZEN; `name` is untrusted, the host keeps the base name only
  | { type: 'pdfEdit'; requestId: number; baseVersion: number; edit: PdfEditOp }       // DRAFT from here on
  | { type: 'pdfWriteResult'; requestId: number; ok: true; bytes: Uint8Array; observed: PdfObserved }
  | { type: 'pdfWriteResult'; requestId: number; ok: false; message: string };

/** Exhaustive over every inbound `type`; adding a message without updating this fails to compile. */
export function isPdfToHost(msg: { type: string }): msg is PdfToHost {
  const m = msg as PdfToHost;
  switch (m.type) {
    case 'ready': case 'setEditMode': case 'flushed': case 'openLink': case 'openExternally':
    case 'retry': case 'writeClipboard': case 'showAbout':
    case 'pdfRequestDocument': case 'pdfFacts': case 'pdfLog': case 'pdfSaveAttachment':
    case 'pdfEdit': case 'pdfWriteResult':
      return true;
    default: {
      const _never: never = m;
      void _never;
      return false;
    }
  }
}

// ---------- Limits (single source of truth for the inbound validators) ----------

export const PDF_PROTOCOL_LIMITS = {
  /** Page index < 100,000 (spec §5). */
  MAX_PAGES: 100_000,
  MAX_QUADS: 5_000,
  MAX_STROKES: 500,
  MAX_POINTS_PER_STROKE: 4_000,
  /** Every coordinate is finite and within +-this. */
  MAX_COORD: 100_000,
  MAX_COMMENT: 32_767,
  MAX_FIELDS_PER_SET: 2_000,
  MAX_TEXT_VALUE: 100_000,
  /** Items in a choice-field value array. */
  MAX_CHOICE_VALUES: 2_000,
  /** Attachment payload, 250 MB. */
  MAX_ATTACHMENT_BYTES: 250 * 1024 * 1024,
  /** Attachment file name as sent (the host reduces it to a base name). */
  MAX_ATTACHMENT_NAME: 4_096,
  /** §9.3: files above 500 MB are refused, so no loaded file is bigger. */
  MAX_FILE_BYTES: 500 * 1024 * 1024,
  /** `pdfWriteResult.bytes` <= loaded size + 64 MB. */
  WRITE_GROWTH_BYTES: 64 * 1024 * 1024,
  /** Object number / generation bounds (generation is 16 bits in the file format). */
  MAX_OBJ_NUM: 2_147_483_647,
  MAX_GEN: 65_535,
  /** pdfFacts. */
  MAX_SIGNATURES: 1_000,
  MAX_FACT_STRING: 4_096,
  MAX_ATTACHMENTS: 1_000_000,
  /** pdfWriteResult.observed. */
  MAX_OBSERVED_FIELDS: 200_000,
  MAX_ANNOTS_PER_PAGE: 10_000_000,
  /** pdfWriteResult failure text. */
  MAX_MESSAGE: 10_000,
  /** pdfLog.detail, as sent. */
  MAX_LOG_DETAIL: 2_000,
} as const;

type Rec = Record<string, unknown>;
const L = PDF_PROTOCOL_LIMITS;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function isIdx(v: unknown, max: number): v is number {
  return isId(v) && v < max;
}
function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -L.MAX_COORD && v <= L.MAX_COORD;
}
/** A real Uint8Array (a Buffer passes, being a subclass), tag-checked so it also works across realms. */
function isBytes(v: unknown, max: number): v is Uint8Array {
  return ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]'
    && (v as Uint8Array).byteLength <= max;
}
function isColor(v: unknown): v is PdfColor {
  return v === 'yellow' || v === 'green' || v === 'blue' || v === 'pink' || v === 'red';
}

function parseRef(v: unknown): PdfObjRef | null {
  if (!isRec(v) || !isIdx(v.num, L.MAX_OBJ_NUM + 1) || !isIdx(v.gen, L.MAX_GEN + 1)) return null;
  if (v.num < 1) return null;   // object 0 is the free-list head, never a target
  return { num: v.num, gen: v.gen };
}

function parseFieldValue(v: unknown): PdfFieldValue | null {
  if (typeof v === 'string') return v.length <= L.MAX_TEXT_VALUE ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    if (v.length > L.MAX_CHOICE_VALUES) return null;
    for (const s of v) if (!isStr(s, L.MAX_TEXT_VALUE)) return null;
    return v.slice() as string[];
  }
  return null;
}

function parseFields(v: unknown, max: number): Array<{ ref: PdfObjRef; value: PdfFieldValue }> | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: Array<{ ref: PdfObjRef; value: PdfFieldValue }> = [];
  for (const e of v) {
    if (!isRec(e)) return null;
    const ref = parseRef(e.ref);
    const value = parseFieldValue(e.value);
    if (!ref || value === null) return null;
    out.push({ ref, value });
  }
  return out;
}

function parseAnnotSpec(v: unknown): PdfAnnotSpec | null {
  if (!isRec(v) || !isId(v.localId) || !isIdx(v.page, L.MAX_PAGES)) return null;
  if (!isColor(v.color) || !isStr(v.comment, L.MAX_COMMENT)) return null;
  if (v.kind === 'highlight') {
    const q = v.quads;
    if (!Array.isArray(q) || q.length === 0 || q.length % 8 !== 0 || q.length > L.MAX_QUADS * 8) return null;
    for (const n of q) if (!isCoord(n)) return null;
    return { kind: 'highlight', localId: v.localId, page: v.page, quads: q.slice() as number[],
      color: v.color, comment: v.comment };
  }
  if (v.kind === 'ink') {
    if (v.width !== 1 && v.width !== 2 && v.width !== 4) return null;
    const p = v.paths;
    if (!Array.isArray(p) || p.length === 0 || p.length > L.MAX_STROKES) return null;
    const paths: number[][] = [];
    for (const s of p) {
      if (!Array.isArray(s) || s.length === 0 || s.length % 2 !== 0 || s.length > L.MAX_POINTS_PER_STROKE * 2) return null;
      for (const n of s) if (!isCoord(n)) return null;
      paths.push(s.slice() as number[]);
    }
    return { kind: 'ink', localId: v.localId, page: v.page, paths, color: v.color, width: v.width, comment: v.comment };
  }
  return null;
}

function parseEditOp(v: unknown): PdfEditOp | null {
  if (!isRec(v)) return null;
  switch (v.op) {
    case 'addAnnotation': {
      const spec = parseAnnotSpec(v.spec);
      return spec ? { op: 'addAnnotation', spec } : null;
    }
    case 'updateAnnotation': {
      if (!isId(v.localId) || !isRec(v.patch)) return null;
      const patch: { comment?: string; color?: PdfColor } = {};
      if (v.patch.comment !== undefined) { if (!isStr(v.patch.comment, L.MAX_COMMENT)) return null; patch.comment = v.patch.comment; }
      if (v.patch.color !== undefined) { if (!isColor(v.patch.color)) return null; patch.color = v.patch.color; }
      if (patch.comment === undefined && patch.color === undefined) return null;
      return { op: 'updateAnnotation', localId: v.localId, patch };
    }
    case 'removeAnnotation': {
      if (!isRec(v.target)) return null;
      const hasLocal = v.target.localId !== undefined;
      const hasRef = v.target.ref !== undefined;
      if (hasLocal === hasRef) return null;   // exactly one
      if (hasLocal) return isId(v.target.localId) ? { op: 'removeAnnotation', target: { localId: v.target.localId } } : null;
      const ref = parseRef(v.target.ref);
      return ref ? { op: 'removeAnnotation', target: { ref } } : null;
    }
    case 'setFields': {
      const values = parseFields(v.values, L.MAX_FIELDS_PER_SET);
      return values && values.length > 0 ? { op: 'setFields', values } : null;
    }
    default: return null;
  }
}

const LOG_LEVELS: readonly string[] = ['info', 'warn', 'error'];
const LOG_CODES: readonly string[] = ['csp-violation', 'worker-fallback', 'page-render-failed'];

/**
 * A log detail made safe to append to a log line: query strings and fragments removed from
 * anything URL-like (`blockedURI` can carry document-derived data), control characters (line
 * breaks included) replaced so a detail cannot forge a log line.
 */
export function sanitizeLogDetail(detail: string): string {
  return detail.replace(/[?#]\S*/g, '').replace(/[\x00-\x1f\x7f\p{Zl}\p{Zp}]/gu, ' ');
}

function parseFacts(v: unknown): PdfFacts | null {
  if (!isRec(v)) return null;
  if (!isIdx(v.pageCount, L.MAX_PAGES + 1) || !isIdx(v.attachmentCount, L.MAX_ATTACHMENTS + 1)) return null;
  if (!isBool(v.encrypted) || !isBool(v.hasText) || !isBool(v.hasJavaScript) || !isBool(v.hasXfa)) return null;
  if (!Array.isArray(v.signatures) || v.signatures.length > L.MAX_SIGNATURES) return null;
  const signatures: PdfFacts['signatures'] = [];
  for (const s of v.signatures as unknown[]) {
    if (!isRec(s) || !isStr(s.signer, L.MAX_FACT_STRING) || !isStr(s.reason, L.MAX_FACT_STRING) || !isStr(s.time, L.MAX_FACT_STRING)) return null;
    signatures.push({ signer: s.signer, reason: s.reason, time: s.time });
  }
  return { pageCount: v.pageCount, encrypted: v.encrypted, hasText: v.hasText, hasJavaScript: v.hasJavaScript,
    hasXfa: v.hasXfa, attachmentCount: v.attachmentCount, signatures };
}

function parseObserved(v: unknown): PdfObserved | null {
  if (!isRec(v) || !isIdx(v.pageCount, L.MAX_PAGES + 1)) return null;
  if (!Array.isArray(v.annotsPerPage) || v.annotsPerPage.length > L.MAX_PAGES) return null;
  for (const n of v.annotsPerPage as unknown[]) if (!isIdx(n, L.MAX_ANNOTS_PER_PAGE + 1)) return null;
  const fields = parseFields(v.fields, L.MAX_OBSERVED_FIELDS);
  if (!fields) return null;
  return { pageCount: v.pageCount, annotsPerPage: (v.annotsPerPage as number[]).slice(), fields };
}

export interface ParsePdfOptions {
  /** Size of the loaded file; `pdfWriteResult.bytes` may be at most this + 64 MB. Defaults to the 500 MB open limit. */
  loadedSize?: number;
}

/**
 * Every inbound PDF-webview message: PDF messages plus the common set. Structural checks only
 * (types, integer-ness, ranges, caps); semantic checks (stale version, unknown localId, name
 * sanitising) belong to the host. Rebuilds a clean object (unknown keys dropped), returns null on
 * any violation, never throws.
 */
export function parsePdfToHost(raw: unknown, opts: ParsePdfOptions = {}): PdfToHost | null {
  if (!isRec(raw)) return null;
  switch (raw.type) {
    case 'pdfRequestDocument': return { type: 'pdfRequestDocument' };
    case 'pdfFacts': {
      const facts = parseFacts(raw.facts);
      return facts ? { type: 'pdfFacts', facts } : null;
    }
    case 'pdfLog': {
      if (typeof raw.level !== 'string' || !LOG_LEVELS.includes(raw.level)) return null;
      if (typeof raw.code !== 'string' || !LOG_CODES.includes(raw.code)) return null;
      const level = raw.level as PdfLogLevel;
      const code = raw.code as PdfLogCode;
      if (raw.detail === undefined) return { type: 'pdfLog', level, code };
      return isStr(raw.detail, L.MAX_LOG_DETAIL)
        ? { type: 'pdfLog', level, code, detail: sanitizeLogDetail(raw.detail) } : null;
    }
    case 'pdfSaveAttachment':
      return isId(raw.requestId) && isStr(raw.name, L.MAX_ATTACHMENT_NAME) && isBytes(raw.bytes, L.MAX_ATTACHMENT_BYTES)
        ? { type: 'pdfSaveAttachment', requestId: raw.requestId, name: raw.name, bytes: raw.bytes } : null;
    case 'pdfEdit': {
      if (!isId(raw.requestId) || !isId(raw.baseVersion)) return null;
      const edit = parseEditOp(raw.edit);
      return edit ? { type: 'pdfEdit', requestId: raw.requestId, baseVersion: raw.baseVersion, edit } : null;
    }
    case 'pdfWriteResult': {
      if (!isId(raw.requestId)) return null;
      if (raw.ok === false) {
        return isStr(raw.message, L.MAX_MESSAGE)
          ? { type: 'pdfWriteResult', requestId: raw.requestId, ok: false, message: raw.message } : null;
      }
      if (raw.ok !== true) return null;
      const loaded = isId(opts.loadedSize) ? Math.min(opts.loadedSize, L.MAX_FILE_BYTES) : L.MAX_FILE_BYTES;
      if (!isBytes(raw.bytes, loaded + L.WRITE_GROWTH_BYTES)) return null;
      const observed = parseObserved(raw.observed);
      return observed ? { type: 'pdfWriteResult', requestId: raw.requestId, ok: true, bytes: raw.bytes, observed } : null;
    }
    default: return parseCommonToHost(raw);
  }
}
