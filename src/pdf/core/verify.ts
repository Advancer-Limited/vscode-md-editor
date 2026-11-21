// Save verifier (spec §6.5 PV1–PV6, §12, §13.2; plan PWP-18).
//
// The bytes to be saved come from pdf.js running in the webview, so they are UNTRUSTED. Before anything is
// written to disk the host proves, with its own strict reader (`reader.ts`) and nothing else, that the output
// is the loaded file plus exactly one well-formed, minimal, inert revision that does what the edit state asked
// for and nothing more:
//
//   PV1  prefix identity: the output is longer than the base and starts with every byte of it.
//   PV2  revision structure: exactly one appended revision, chained to the base (/Prev, same /Root, /Info and
//        first /ID), of an allowed cross-reference kind (`allowedAppendedKinds`), only allowed trailer keys,
//        and every appended byte accounted for (objects, the section, `startxref N %%EOF`, whitespace).
//   PV3  entries: in-use entries point into the appended region; no object-stream entries; free entries are
//        object 0 and exactly the annotations (and Popups) the request removes.
//   PV4  object allow-list: new objects are Highlight/Ink/Popup annotations, their appearance form XObjects
//        and the cross-reference stream, with listed keys and value shapes; superseded objects are pages
//        (/Annots only, and exactly as expected), and requested fields/widgets (/V /AS /AP /M /MK) — compared
//        by DECODED value. Anything else (catalog, AcroForm, structure tree, streams ...) is refused.
//   PV5  inert: no new object and no changed key of a superseded object carries an action, script or file.
//   PV6  expectations: the writer's read-back (`observed`) has the base's page count, the expected annotation
//        count per page and the requested field values; the appended size is within budget.
//
// Refuse rather than guess: anything outside the tables below fails. Findings carry check ids, codes, object
// numbers and page indices only, never document content (they go into the diagnostics file of §6.5).
// Work is lazy (spike S4): the cross-reference chains and the appended objects (plus their base versions and
// the few base objects they point at) are read; the body of the base is never scanned.
//
// No `vscode` import, no npm package (core rule 1).

import { timingSafeEqual } from 'node:crypto';
import type { PdfObserved } from '../protocol.js';
import { openPdf, openPdfSync, PdfReadError } from './reader.js';
import type { PdfDict, PdfFile, PdfIndirectObject, PdfRevision, PdfStream, PdfValue, ReaderLimits, XrefKind } from './reader.js';
import type { PdfEditableClassification } from './classify.js';
import type { PdfEditState } from './state.js';
import { canonicalFields, fieldValuesEqual, refKey } from './state.js';
import type { PdfHighlightEntry, PdfInkEntry, PdfStorageContext, PdfStorageEntry } from './storageAdapter.js';
import { expectedAnnotDelta, expectedFreed, isEditorKey, serialisedSize, toStorageEntries } from './storageAdapter.js';
import { PDF_LIMITS } from './limits.js';

// ================================================================ findings

/** Every reason code, by check. The diagnostics of a failed save are made of these and object numbers. */
export const VERIFY_CODES = {
  PV1: [
    'not-longer',            // the output is not longer than the base
    'prefix-differs',        // a byte of the base was changed
  ],
  PV2: [
    'base-unreadable',       // the strict reader refuses the base (the caller should never have offered editing)
    'out-unreadable',        // the strict reader refuses the output's cross-reference chain or an appended object
    'revision-count',        // not exactly one revision appended
    'chain-mismatch',        // the older revisions of the output are not the base's
    'prev-mismatch',         // the new trailer's /Prev is not the base's startxref
    'startxref-outside-append', // the last startxref does not point into the appended region
    'xref-kind',             // cross-reference kind not allowed for this base (`allowedAppendedKinds`)
    'trailer-key',           // a trailer key outside `TRAILER_KEYS` (incl. /XRefStm)
    'encrypt',               // the output declares encryption
    'root-changed',
    'info-changed',
    'id-changed',            // the first /ID element differs from the base's
    'id-malformed',          // /ID is not two strings, or appears although the base has none
    'size-mismatch',         // /Size smaller than the base's, or larger than the objects written need
    'stray-bytes',           // appended bytes that belong to no listed object and not to the section
    'object-overlap',        // two listed objects (or an object and the section) overlap
    'eof',                   // the file does not end with `startxref <offset> %%EOF` and an end of line
  ],
  PV3: [
    'entry-target',          // an in-use entry does not point at its `N G obj` header
    'entry-outside-append',  // an in-use entry points into the base (resurrecting an older version)
    'objstm-entry',          // an object-stream (type 2) entry
    'object-zero',           // object 0 is listed as in use
    'new-gen',               // a new object number with a generation other than 0
    'superseded-gen',        // a superseded object with a generation other than the base's
    'superseded-missing',    // a number below the base's /Size that is not an object of the base
    'free-unexpected',       // a free entry for an object the request does not remove
    'free-missing',          // an object the request removes is not freed
    'free-gen',              // a free entry whose generation is not the base's + 1
  ],
  PV4: [
    'new-kind',              // a new object that is not on the allow-list
    'new-key',               // a key outside the allow-list of its kind
    'new-value',             // a value of the wrong shape (inline/indirect, type, range)
    'ap-target',             // an /AP entry that does not point at an allowed appearance stream
    'font-ref',              // an appearance font that is not a font of the base
    'popup-link',            // a Popup and its parent do not point at each other
    'orphan-object',         // a new appearance stream that nothing new or rewritten uses
    'annot-unlinked',        // a new annotation listed on no page (or on several)
    'annot-wrong-page',      // a new annotation listed on a page other than the requested one
    'annot-unexpected',      // a new annotation that matches nothing the request adds
    'annot-missing',         // an annotation the request adds is not in the output
    'annots-mismatch',       // a page's /Annots is not "old minus removed plus added"
    'annots-indirect',       // a rewritten page's /Annots is not an inline array
    'page-unexpected',       // a page was rewritten although the request does not touch it
    'page-missing',          // a page the request touches was not rewritten
    'superseded-key',        // a superseded object changed a key its rule does not allow
    'mk-changed',            // a widget's /MK changed beyond removing /R 0
    'kind-changed',          // a superseded object changed between dictionary and stream
    'field-unexpected',      // a field or widget the request does not set was rewritten
    'catalog-superseded', 'acroform-superseded', 'struct-superseded', 'info-superseded', 'pages-superseded',
    'annot-superseded', 'stream-superseded', 'other-superseded',
  ],
  PV5: [
    'action-introduced',     // an action, script, embedded file or file specification was introduced
  ],
  PV6: [
    'growth-over-cap',       // output larger than the base + `maxWriteGrowthBytes` (spec §9.3)
    'size-budget',           // appended bytes over 64 KB + 16 x the serialised size of the state
    'page-count',            // observed page count differs from the base's
    'annot-count',           // observed annotation count of a page differs from base + added - removed
    'field-missing',         // a requested field was not read back
    'field-value',           // a requested field read back a different value
    'request-invalid',       // the edit state does not fit the classification (a host bug; never saved)
  ],
} as const;

export type PdfVerifyCheck = keyof typeof VERIFY_CODES;
export type PdfVerifyCode<C extends PdfVerifyCheck = PdfVerifyCheck> = (typeof VERIFY_CODES)[C][number];

/** One reason a save was refused. Object numbers and page indices only — never document content. */
export interface PdfVerifyFinding {
  check: PdfVerifyCheck;
  code: PdfVerifyCode;
  /** The object the finding is about, when there is one. */
  obj?: number;
  /** The 0-based page index the finding is about, when there is one. */
  page?: number;
}

export interface PdfVerifyStats {
  appendedBytes: number;
  budgetBytes: number;
  newObjects: number;
  supersededObjects: number;
  freedObjects: number;
}

export interface PdfVerifyResult {
  ok: boolean;
  /** Empty when `ok`. The first finding is the first problem found; later ones may be consequences. */
  findings: PdfVerifyFinding[];
  /** Null when verification stopped before the appended revision was read. */
  stats: PdfVerifyStats | null;
}

// ================================================================ input

export interface PdfVerifyInput {
  /** The bytes of this generation (`PdfDocument.base`). */
  base: Uint8Array;
  /** The writer's output (`pdfWriteResult.bytes`): untrusted. */
  out: Uint8Array;
  /** `classify(base)` — must be the editable result for exactly these base bytes. */
  classification: PdfEditableClassification;
  /** The edit state the writer was asked to serialise. */
  state: PdfEditState;
  /** The `annotationAuthor` the storage entries were built with (spec §8.2). */
  author?: string;
  /** The writer's read-back (`pdfWriteResult.observed`): untrusted, compared against expectations. */
  observed: PdfObserved;
  /** The base already opened by the strict reader (saves re-opening it). Must be of `base`. */
  baseFile?: PdfFile;
}

export interface PdfVerifyOptions {
  /** Strict-reader caps and yielding parameters. */
  reader?: Partial<ReaderLimits>;
  /** Spec §9.3: output larger than base + this fails. */
  maxGrowthBytes?: number;
  /** PV6 size budget: appended <= fixed + perStateByte x serialised size of the state. */
  appendBudget?: { fixed: number; perStateByte: number };
  /** Stop collecting after this many findings. */
  maxFindings?: number;
}

export const APPEND_BUDGET = Object.freeze({ fixed: 64 * 1024, perStateByte: 16 });

// ================================================================ policy tables

/** The cross-reference kind of a base (its newest section, as the strict reader reports it). */
export type BaseXrefKind = XrefKind;
/** The kind of the appended section. */
export type AppendedXrefKind = XrefKind;

/**
 * PV2: the kinds of cross-reference section pdf.js may append, as a function of the base's kind ("matches the
 * base", spec §3.2, §6.5). Hybrid bases (/XRefStm, e.g. Word "Save as PDF"): pdf.js 6.5.438 appends a plain
 * classic table WITHOUT /XRefStm (measured, `tests/pdf/hybridWrite.test.mjs`); an appended hybrid section is
 * never allowed. A new base kind, or a different measurement after a pdf.js upgrade, is one row here.
 */
export const APPENDED_XREF_KINDS: Readonly<Record<BaseXrefKind, readonly AppendedXrefKind[]>> = Object.freeze({
  table: ['table'],
  stream: ['stream'],
  hybrid: ['table'],
});

export function allowedAppendedKinds(base: BaseXrefKind): readonly AppendedXrefKind[] {
  return APPENDED_XREF_KINDS[base];
}

export function baseXrefKind(file: PdfFile): BaseXrefKind {
  return file.xrefKind;
}

/** PV2: keys the appended trailer (for a stream: the cross-reference stream's dictionary) may have. */
export const TRAILER_KEYS: Readonly<Record<AppendedXrefKind, ReadonlySet<string>>> = Object.freeze({
  table: new Set(['Size', 'Root', 'Info', 'ID', 'Prev']),
  hybrid: new Set<string>(), // never appended (`APPENDED_XREF_KINDS`); every key is reported

  stream: new Set(['Size', 'Root', 'Info', 'ID', 'Prev', 'Type', 'W', 'Index', 'Length', 'Filter']),
});

/** PV5: names that must not be introduced, as a key or as a name value, at any depth. */
export const INERT_NAMES: ReadonlySet<string> = new Set([
  'JS', 'JavaScript', 'Launch', 'URI', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'OpenAction', 'AA', 'A',
  'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'Filespec',
]);

/** The kinds of new object PV4 allows (spec §6.5 PV4 a–e). */
export type NewObjectKind = 'highlight' | 'ink' | 'popup' | 'form' | 'xref';

/** PV4: the keys each kind of new object may have (spike S3 lists, pdf.js 6.5.438). */
export const NEW_OBJECT_KEYS: Readonly<Record<Exclude<NewObjectKind, 'xref'>, ReadonlySet<string>>> = Object.freeze({
  highlight: new Set(['Type', 'Subtype', 'CreationDate', 'Rect', 'F', 'Border', 'Rotate', 'QuadPoints', 'C', 'CA', 'T', 'AP', 'Contents', 'Popup']),
  ink: new Set(['Type', 'Subtype', 'CreationDate', 'Rect', 'F', 'Border', 'Rotate', 'InkList', 'BS', 'C', 'CA', 'T', 'AP', 'Contents', 'Popup']),
  popup: new Set(['Type', 'Subtype', 'Open', 'Rect', 'Parent']),
  form: new Set(['Type', 'Subtype', 'FormType', 'BBox', 'Length', 'Resources']),
});

/** The kinds a superseded object can have, decided from its BASE version. */
export type SupersededKind =
  | 'page' | 'widget' | 'field' | 'acroform' | 'catalog' | 'struct' | 'info' | 'pages' | 'annot' | 'stream' | 'other';

export interface SupersedeRule {
  /** Keys whose decoded value may differ from the base version (added, changed or removed). */
  keys: ReadonlySet<string>;
}

/**
 * PV4, the AcroForm row — ISOLATED so that PWP-27 can extend it. Spec §6.5: the AcroForm dictionary is never
 * superseded, so in v1 (forms off until PWP-27) the rule is "refused".
 *
 * Known pdf.js behaviour (PWP-17 finding, `forms-js.pdf`): setting a text field that has /AA format or keystroke
 * scripts makes pdf.js re-write the AcroForm adding `/NeedAppearances true` and drop that widget's /AP. Such a
 * save is refused here (`acroform-superseded`). RECOMMENDATION for PWP-27: classify fields carrying /AA as NOT
 * fillable (scripts never run here, so the formatted value would be wrong anyway) rather than relaxing this rule;
 * if the rule is relaxed instead, the entry would be `{ keys: new Set(['NeedAppearances']) }` plus a value check
 * that the new value is `true`, and PV6 would have to accept a widget without /AP.
 */
export const ACROFORM_SUPERSEDE_RULE: SupersedeRule | null = null;

/** PV4: what a superseded object of each kind may change. `null` = never superseded (`<kind>-superseded`). */
export const SUPERSEDE_RULES: Readonly<Record<SupersededKind, SupersedeRule | null>> = Object.freeze({
  page: { keys: new Set(['Annots']) },
  widget: { keys: new Set(['V', 'AS', 'AP', 'M', 'MK']) },   // a widget, or a merged field/widget
  field: { keys: new Set(['V']) },
  acroform: ACROFORM_SUPERSEDE_RULE,
  catalog: null,
  struct: null,
  info: null,
  pages: null,
  annot: null,
  stream: null,
  other: null,
});

const SUPERSEDED_CODE: Readonly<Record<SupersededKind, PdfVerifyCode<'PV4'>>> = Object.freeze({
  page: 'superseded-key', widget: 'superseded-key', field: 'superseded-key',
  acroform: 'acroform-superseded', catalog: 'catalog-superseded', struct: 'struct-superseded', info: 'info-superseded',
  pages: 'pages-superseded', annot: 'annot-superseded', stream: 'stream-superseded', other: 'other-superseded',
});

const STRUCT_TYPES: ReadonlySet<string> = new Set(['StructTreeRoot', 'StructElem', 'MCR', 'OBJR']);

/** Tolerances: pdf.js writes numbers with `toFixed(10)`; rectangles and colours are matched loosely. */
const NUM_EPS = 1e-9;
const RECT_EPS = 0.01;
const COLOR_EPS = 1.5 / 255;
/** /Parent hops followed when collecting the fields a request may rewrite. */
const MAX_FIELD_DEPTH = 64;
/** Prefix compared per slice by the async verifier. */
const COMPARE_SLICE = 4 * 1024 * 1024;

// ================================================================ entry points

/**
 * Verify a writer output against the base and the request. Never rejects: every failure is a finding.
 * Yields to the event loop while comparing the prefix and opening large files.
 */
export async function verifySave(input: PdfVerifyInput, options: PdfVerifyOptions = {}): Promise<PdfVerifyResult> {
  const v = new Verifier(input, options);
  try {
    if (!v.preflight()) return v.result();
    if (!(await prefixEqualAsync(input.base, input.out, options.reader?.yieldIntervalMs ?? PDF_LIMITS.yieldIntervalMs))) {
      v.add('PV1', 'prefix-differs');
      return v.result();
    }
    if (!v.budget()) return v.result();
    const bf = input.baseFile ?? await openOr(v, 'base', () => openPdf(input.base, options.reader));
    if (!bf) return v.result();
    const of = await openOr(v, 'out', () => openPdf(input.out, options.reader));
    if (!of) return v.result();
    v.check(bf, of);
  } catch (e) {
    v.internal(e);
  }
  return v.result();
}

/** `verifySave` without yielding (small files, tests). */
export function verifySaveSync(input: PdfVerifyInput, options: PdfVerifyOptions = {}): PdfVerifyResult {
  const v = new Verifier(input, options);
  try {
    if (!v.preflight()) return v.result();
    if (!prefixEqual(input.base, input.out, 0, input.base.length)) {
      v.add('PV1', 'prefix-differs');
      return v.result();
    }
    if (!v.budget()) return v.result();
    const bf = input.baseFile ?? openOrSync(v, 'base', () => openPdfSync(input.base, options.reader));
    if (!bf) return v.result();
    const of = openOrSync(v, 'out', () => openPdfSync(input.out, options.reader));
    if (!of) return v.result();
    v.check(bf, of);
  } catch (e) {
    v.internal(e);
  }
  return v.result();
}

/** One line per finding ("PV4 new-key obj 12"), for the "Save a copy of diagnostics" file. No document content. */
export function formatFindings(result: PdfVerifyResult): string {
  const lines = result.findings.map((f) =>
    `${f.check} ${f.code}${f.obj !== undefined ? ` obj ${f.obj}` : ''}${f.page !== undefined ? ` page ${f.page + 1}` : ''}`);
  if (result.stats) {
    const s = result.stats;
    lines.push(`appended ${s.appendedBytes} budget ${s.budgetBytes} new ${s.newObjects} superseded ${s.supersededObjects} freed ${s.freedObjects}`);
  }
  return lines.join('\n');
}

/** What a writer that did exactly what was asked reads back (tests and fake writers). */
export function expectedObserved(classification: PdfEditableClassification, state: PdfEditState): PdfObserved {
  const delta = expectedAnnotDelta(state, storageContext(classification));
  return {
    pageCount: classification.pages.length,
    annotsPerPage: classification.pages.map((p, i) => p.annots.length + (delta.get(i) ?? 0)),
    fields: canonicalFields(state),
  };
}

// ================================================================ opening and the prefix

function readerFinding(e: PdfReadError, which: 'base' | 'out'): [PdfVerifyCheck, PdfVerifyCode] {
  if (which === 'base') return ['PV2', 'base-unreadable'];
  if (e.code === 'encrypted') return ['PV2', 'encrypt'];
  if (e.code === 'hybrid') return ['PV2', 'xref-kind'];
  // The reader checks every in-use entry against its `N G obj` header while opening; those refusals are PV3.
  // (Matched on the reader's own messages, `reader.ts` tableSection/streamSection.)
  if (e.code === 'bad-xref' && /does not point at its header|object stream number invalid/.test(e.message)) return ['PV3', 'entry-target'];
  return ['PV2', 'out-unreadable'];
}

async function openOr(v: Verifier, which: 'base' | 'out', open: () => Promise<PdfFile>): Promise<PdfFile | null> {
  try { return await open(); } catch (e) {
    if (!(e instanceof PdfReadError)) throw e;
    const [c, code] = readerFinding(e, which);
    v.add(c, code);
    return null;
  }
}

function openOrSync(v: Verifier, which: 'base' | 'out', open: () => PdfFile): PdfFile | null {
  try { return open(); } catch (e) {
    if (!(e instanceof PdfReadError)) throw e;
    const [c, code] = readerFinding(e, which);
    v.add(c, code);
    return null;
  }
}

function prefixEqual(base: Uint8Array, out: Uint8Array, from: number, to: number): boolean {
  if (to <= from) return true;
  return timingSafeEqual(base.subarray(from, to), out.subarray(from, to));
}

async function prefixEqualAsync(base: Uint8Array, out: Uint8Array, yieldMs: number): Promise<boolean> {
  let slice = performance.now();
  for (let at = 0; at < base.length; at += COMPARE_SLICE) {
    if (!prefixEqual(base, out, at, Math.min(base.length, at + COMPARE_SLICE))) return false;
    if (performance.now() - slice >= yieldMs) {
      await new Promise<void>((r) => setImmediate(r));
      slice = performance.now();
    }
  }
  return true;
}

function storageContext(c: PdfEditableClassification, author?: string): PdfStorageContext {
  const ctx: PdfStorageContext = { deletable: c.context.deletable, pages: c.context.pages };
  if (author) ctx.author = author;
  return ctx;
}

// ================================================================ value helpers

type Val = PdfValue | PdfStream | null | undefined;

const isDict = (v: Val): v is PdfDict => !!v && v.kind === 'dict';
const nameOf = (v: Val): string | null => (v && v.kind === 'name' ? v.value : null);
const isNum = (v: Val): boolean => !!v && v.kind === 'number' && Number.isFinite(v.value);
const isInt = (v: Val): boolean => !!v && v.kind === 'number' && v.integer;
const isStr = (v: Val): boolean => !!v && v.kind === 'string';
const isBool = (v: Val): boolean => !!v && v.kind === 'bool';
const nums = (v: Val): number[] | null => {
  if (!v || v.kind !== 'array') return null;
  const out: number[] = [];
  for (const it of v.items) { if (it.kind !== 'number' || !Number.isFinite(it.value)) return null; out.push(it.value); }
  return out;
};
const dictOf = (v: Val): PdfDict | null => (!v ? null : v.kind === 'dict' ? v : v.kind === 'stream' ? v.dict : null);

/** PDFDocEncoding code points for 0x18–0x1F and 0x80–0xA0 (ISO 32000-1 Annex D); the rest is Latin-1. */
const PDFDOC_18 = [0x02D8, 0x02C7, 0x02C6, 0x02D9, 0x02DD, 0x02DB, 0x02DA, 0x02DC];
const PDFDOC_80 = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203A, 0x2212, 0x2030, 0x201E, 0x201C,
  0x201D, 0x2018, 0x2019, 0x201A, 0x2122, 0xFB01, 0xFB02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017D, 0x0131, 0x0142,
  0x0153, 0x0161, 0x017E, 0xFFFD, 0x20AC,
];

/** A PDF string as text: UTF-16BE or UTF-8 with a byte-order mark, otherwise PDFDocEncoding. */
export function decodeTextString(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return b.length % 2 ? s + '�' : s;
  }
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  let s = '';
  for (const c of b) {
    s += String.fromCharCode(c >= 0x18 && c <= 0x1F ? PDFDOC_18[c - 0x18] : c >= 0x80 && c <= 0xA0 ? PDFDOC_80[c - 0x80] : c);
  }
  return s;
}

function numEqual(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= NUM_EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Equality by DECODED value (spec §6.5 PV4): names and strings after decoding (a string compares as text, so
 * hexadecimal/literal, escapes and PDFDocEncoding/UTF-16BE forms of the same text are equal), numbers by value,
 * references by number and generation, dictionaries ignoring key order and keys whose value is null.
 */
export function equalValues(a: Val, b: Val): boolean {
  const an = !a || a.kind === 'null', bn = !b || b.kind === 'null';
  if (an || bn) return an && bn;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'bool': return a.value === (b as typeof a).value;
    case 'number': return numEqual(a.value, (b as typeof a).value);
    case 'name': return a.value === (b as typeof a).value;
    case 'ref': return a.num === (b as typeof a).num && a.gen === (b as typeof a).gen;
    case 'string': {
      const bb = (b as typeof a).bytes;
      if (a.bytes.length === bb.length && a.bytes.every((x, i) => x === bb[i])) return true;
      return decodeTextString(a.bytes) === decodeTextString(bb);
    }
    case 'array': {
      const bi = (b as typeof a).items;
      if (a.items.length !== bi.length) return false;
      for (let i = 0; i < bi.length; i++) if (!equalValues(a.items[i], bi[i])) return false;
      return true;
    }
    case 'dict': return dictDiff(a, b as PdfDict).length === 0;
    case 'stream': return false; // streams are never compared: a superseded stream is refused outright
  }
  return false;
}

/** Keys whose decoded values differ (null-valued keys count as absent). */
function dictDiff(a: PdfDict, b: PdfDict): string[] {
  const out: string[] = [];
  const keys = new Set([...a.entries.keys(), ...b.entries.keys()]);
  for (const k of keys) if (!equalValues(a.entries.get(k), b.entries.get(k))) out.push(k);
  return out;
}

/** PV5: does `v` contain an inert-breaking name (as a key or a name value), at any depth? */
function hasInertName(v: Val): boolean {
  if (!v) return false;
  switch (v.kind) {
    case 'name': return INERT_NAMES.has(v.value);
    case 'array': return v.items.some(hasInertName);
    case 'dict':
      for (const [k, x] of v.entries) if (INERT_NAMES.has(k) || hasInertName(x)) return true;
      return false;
    case 'stream': return hasInertName(v.dict);
    default: return false;
  }
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
function skipWs(b: Uint8Array, p: number, end = b.length): number { while (p < end && WS[b[p]]) p++; return p; }
function matchAt(b: Uint8Array, p: number, s: string): boolean {
  if (p + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

// ================================================================ the verifier

interface NewObject { num: number; kind: NewObjectKind | null; obj: PdfIndirectObject; dict: PdfDict | null }
type AddedEntry = PdfHighlightEntry | PdfInkEntry;

class Verifier {
  readonly findings: PdfVerifyFinding[] = [];
  stats: PdfVerifyStats | null = null;
  private readonly max: number;
  private entries: PdfStorageEntry[] = [];
  private budgetBytes = 0;

  constructor(readonly input: PdfVerifyInput, readonly options: PdfVerifyOptions) {
    this.max = options.maxFindings ?? 100;
  }

  add<C extends PdfVerifyCheck>(check: C, code: PdfVerifyCode<C>, obj?: number, page?: number): void {
    if (this.findings.length >= this.max) return;
    const f: PdfVerifyFinding = { check, code };
    if (obj !== undefined) f.obj = obj;
    if (page !== undefined) f.page = page;
    this.findings.push(f);
  }

  /** A bug or an input the code did not anticipate: refusing the save is the safe failure. */
  internal(_e: unknown): void {
    this.add('PV2', 'out-unreadable');
  }

  result(): PdfVerifyResult {
    return { ok: this.findings.length === 0, findings: this.findings, stats: this.stats };
  }

  /** Cheap checks before anything is parsed: growth cap, length, request consistency. */
  preflight(): boolean {
    const { base, out } = this.input;
    if (out.length > base.length + (this.options.maxGrowthBytes ?? PDF_LIMITS.maxWriteGrowthBytes)) {
      this.add('PV6', 'growth-over-cap');
      return false;
    }
    if (!(out.length > base.length)) {
      this.add('PV1', 'not-longer');
      return false;
    }
    try {
      this.entries = toStorageEntries(this.input.state, storageContext(this.input.classification, this.input.author));
    } catch {
      this.add('PV6', 'request-invalid');
      return false;
    }
    return true;
  }

  /** PV6 size budget, before the appended region is parsed (bounds all later work). */
  budget(): boolean {
    const b = this.options.appendBudget ?? APPEND_BUDGET;
    this.budgetBytes = b.fixed + b.perStateByte * serialisedSize(this.entries);
    if (this.input.out.length - this.input.base.length > this.budgetBytes) {
      this.add('PV6', 'size-budget');
      return false;
    }
    return true;
  }

  check(bf: PdfFile, of: PdfFile): void {
    const rev = this.structure(bf, of);
    if (!rev) return;
    const objs = this.entriesAndObjects(bf, of, rev);
    if (!objs) return;
    this.objects(bf, of, rev, objs);
    this.observed();
  }

  // ---------------------------------------------------------------- PV2

  private structure(bf: PdfFile, of: PdfFile): PdfRevision | null {
    const { base } = this.input;
    const nb = bf.revisions.length;
    if (of.revisions.length !== nb + 1) {
      // Name the more specific cause when the newest section is at least chained elsewhere.
      const last = of.revisions[of.revisions.length - 1];
      if (last.startxref >= base.length && last.prev !== bf.startxref) this.add('PV2', 'prev-mismatch');
      this.add('PV2', 'revision-count');
      return null;
    }
    const rev = of.revisions[nb];
    if (rev.startxref < base.length) { this.add('PV2', 'startxref-outside-append'); return null; }
    if (rev.prev !== bf.startxref) { this.add('PV2', 'prev-mismatch'); return null; }
    for (let i = 0; i < nb; i++) {
      if (of.revisions[i].startxref !== bf.revisions[i].startxref) { this.add('PV2', 'chain-mismatch'); return null; }
    }
    if (!allowedAppendedKinds(baseXrefKind(bf)).includes(rev.kind)) this.add('PV2', 'xref-kind');

    const t = rev.trailer.entries;
    const bt = bf.trailer.entries;
    const allowed = TRAILER_KEYS[rev.kind];
    for (const k of t.keys()) {
      if (k === 'Encrypt') this.add('PV2', 'encrypt');
      else if (!allowed.has(k)) this.add('PV2', 'trailer-key');
    }
    const root = t.get('Root');
    if (!root || root.kind !== 'ref' || !equalValues(root, bt.get('Root'))) this.add('PV2', 'root-changed');
    if (!equalValues(t.get('Info'), bt.get('Info'))) this.add('PV2', 'info-changed');
    this.checkId(bt.get('ID'), t.get('ID'));
    return rev;
  }

  private checkId(baseId: PdfValue | undefined, id: PdfValue | undefined): void {
    const pair = (v: PdfValue | undefined) =>
      v && v.kind === 'array' && v.items.length === 2 && v.items[0].kind === 'string' && v.items[1].kind === 'string' ? v.items : null;
    if (baseId === undefined || baseId.kind === 'null') {
      if (id !== undefined && id.kind !== 'null') this.add('PV2', 'id-malformed');
      return;
    }
    const p = pair(id);
    if (!p) { this.add('PV2', 'id-malformed'); return; }
    const b0 = baseId.kind === 'array' && baseId.items[0]?.kind === 'string' ? baseId.items[0].bytes : null;
    const o0 = (p[0] as { bytes: Uint8Array }).bytes;
    // pdf.js keeps the base's first element; only an empty or invalid one is replaced (`fileIds[0] || md5`).
    if (b0 && b0.length > 0 && !(b0.length === o0.length && b0.every((x, i) => x === o0[i]))) this.add('PV2', 'id-changed');
  }

  // ---------------------------------------------------------------- PV3 + reading the appended objects

  private entriesAndObjects(bf: PdfFile, of: PdfFile, rev: PdfRevision): Map<number, PdfIndirectObject> | null {
    const { base, out, state } = this.input;
    const freed = new Map<number, number>(); // expected freed num -> base gen
    for (const r of expectedFreed(state, storageContext(this.input.classification))) freed.set(r.num, r.gen);
    const seenFree = new Set<number>();
    const inUse: Array<{ num: number; gen: number; offset: number }> = [];
    let maxNum = -1;
    for (const e of rev.entries()) {
      maxNum = Math.max(maxNum, e.num);
      if (e.type === 'objstm') { this.add('PV3', 'objstm-entry', e.num); continue; }
      if (e.type === 'free') {
        if (e.num === 0) continue;
        const bg = freed.get(e.num);
        if (bg === undefined) { this.add('PV3', 'free-unexpected', e.num); continue; }
        if (e.gen !== Math.min(bg + 1, 0xFFFF)) this.add('PV3', 'free-gen', e.num);
        seenFree.add(e.num);
        continue;
      }
      if (e.num === 0) { this.add('PV3', 'object-zero', 0); continue; }
      if (e.offset < base.length) { this.add('PV3', 'entry-outside-append', e.num); continue; }
      if (e.num >= bf.size) {
        if (e.gen !== 0) this.add('PV3', 'new-gen', e.num);
      } else {
        const be = bf.entry(e.num);
        if (!be || be.type === 'free') this.add('PV3', 'superseded-missing', e.num);
        else if (be.gen !== e.gen) this.add('PV3', 'superseded-gen', e.num);
      }
      inUse.push({ num: e.num, gen: e.gen, offset: e.offset });
    }
    for (const n of freed.keys()) if (!seenFree.has(n)) this.add('PV3', 'free-missing', n);
    if (rev.size < bf.size || rev.size > Math.max(bf.size, maxNum + 1)) this.add('PV2', 'size-mismatch');

    // Read every appended object (the reader checks its framing, /Length and endstream) and tile the region.
    const objs = new Map<number, PdfIndirectObject>();
    const tiles: Array<{ start: number; end: number }> = [];
    for (const u of inUse) {
      let o: PdfIndirectObject | null;
      try { o = of.resolve(u.num, u.gen); } catch (e) {
        if (!(e instanceof PdfReadError)) throw e;
        this.add('PV2', 'out-unreadable', u.num);
        return null;
      }
      if (!o || o.location.kind !== 'offset' || o.location.offset !== u.offset) { this.add('PV3', 'entry-target', u.num); return null; }
      const end = objectEnd(out, o);
      if (end < 0) { this.add('PV2', 'out-unreadable', u.num); return null; }
      objs.set(u.num, o);
      if (u.offset !== rev.startxref) tiles.push({ start: u.offset, end });
    }
    tiles.push({ start: rev.startxref, end: rev.sectionEnd });
    this.tiling(tiles, rev);
    return objs;
  }

  /** PV2: the appended region is exactly the listed objects, the section and the `startxref` tail. */
  private tiling(tiles: Array<{ start: number; end: number }>, rev: PdfRevision): void {
    const { base, out } = this.input;
    tiles.sort((a, b) => a.start - b.start);
    let p = base.length;
    for (const t of tiles) {
      if (t.start < p) { this.add('PV2', 'object-overlap'); return; }
      if (skipWs(out, p, t.start) !== t.start) { this.add('PV2', 'stray-bytes'); return; }
      p = t.end;
    }
    p = skipWs(out, p);
    if (!matchAt(out, p, 'startxref')) { this.add('PV2', 'stray-bytes'); return; }
    let q = skipWs(out, p + 9);
    if (q === p + 9) { this.add('PV2', 'eof'); return; }
    let n = 0; const d0 = q;
    while (q < out.length && out[q] >= 0x30 && out[q] <= 0x39 && q - d0 < 16) n = n * 10 + (out[q++] - 0x30);
    if (q === d0 || n !== rev.startxref) { this.add('PV2', 'eof'); return; }
    q = skipWs(out, q);
    if (!matchAt(out, q, '%%EOF')) { this.add('PV2', 'eof'); return; }
    q += 5;
    while (q < out.length && (out[q] === 10 || out[q] === 13)) q++;
    if (q !== out.length) this.add('PV2', 'eof');
  }

  // ---------------------------------------------------------------- PV4 / PV5

  private objects(bf: PdfFile, of: PdfFile, rev: PdfRevision, objs: Map<number, PdfIndirectObject>): void {
    const cls = this.input.classification;
    const pageIndex = new Map<string, number>();
    cls.pages.forEach((p, i) => pageIndex.set(refKey(p.ref), i));

    const news = new Map<number, NewObject>();
    const superseded: PdfIndirectObject[] = [];
    for (const [num, o] of objs) {
      if (num >= bf.size) news.set(num, { num, kind: newKindOf(o, rev), obj: o, dict: dictOf(o.value) });
      else superseded.push(o);
    }

    // New objects: inert, kind, keys, shapes.
    const formRefs = new Set<number>();
    for (const n of news.values()) {
      if (hasInertName(n.obj.value)) this.add('PV5', 'action-introduced', n.num);
      if (!n.kind) { this.add('PV4', 'new-kind', n.num); continue; }
      if (n.kind === 'xref') continue; // its dictionary is the trailer (PV2)
      this.newShape(bf, n, news, formRefs);
    }

    // Superseded objects.
    const fieldFamily = this.fieldFamily(bf);
    const links = new Map<number, number>(); // new annotation num -> page listing it
    const rewrittenPages = new Set<number>();
    const ctx = { bf, news, formRefs, links, rewrittenPages, pageIndex, fieldFamily };
    for (const o of superseded) this.supersede(o, ctx);

    // Pages the request touches must have been rewritten.
    const expectedPages = this.expectedPages();
    for (const p of expectedPages) if (!rewrittenPages.has(p)) this.add('PV4', 'page-missing', cls.pages[p].ref.num, p);
    for (const p of rewrittenPages) if (!expectedPages.has(p)) this.add('PV4', 'page-unexpected', cls.pages[p].ref.num, p);

    // Every new appearance stream is used.
    for (const n of news.values()) if (n.kind === 'form' && !formRefs.has(n.num)) this.add('PV4', 'orphan-object', n.num);

    this.matchAnnotations(news, links);

    this.stats = {
      appendedBytes: this.input.out.length - this.input.base.length,
      budgetBytes: this.budgetBytes,
      newObjects: [...news.values()].filter((n) => n.kind !== 'xref').length,
      supersededObjects: superseded.length,
      freedObjects: expectedFreed(this.input.state, storageContext(cls)).length,
    };
  }

  /** PV4 a–d: keys and value shapes of one new object. */
  private newShape(bf: PdfFile, n: NewObject, news: Map<number, NewObject>, formRefs: Set<number>): void {
    const d = n.dict!;
    const kind = n.kind as Exclude<NewObjectKind, 'xref'>;
    const keys = NEW_OBJECT_KEYS[kind];
    const bad = () => this.add('PV4', 'new-value', n.num);
    for (const [k, v] of d.entries) {
      if (!keys.has(k)) { this.add('PV4', 'new-key', n.num); continue; }
      switch (k) {
        case 'Type': if (nameOf(v) !== (kind === 'form' ? 'XObject' : 'Annot')) bad(); break;
        case 'Subtype': break; // decided the kind
        case 'CreationDate': case 'T': case 'Contents': if (!isStr(v)) bad(); break;
        case 'Rect': case 'BBox': if (nums(v)?.length !== 4) bad(); break;
        case 'F': case 'FormType': if (!isInt(v)) bad(); break;
        case 'Rotate': case 'CA': if (!isNum(v)) bad(); break;
        case 'Border': { const a = nums(v); if (!a || a.length > 4) bad(); break; }
        case 'C': { const a = nums(v); if (!a || ![0, 1, 3, 4].includes(a.length)) bad(); break; }
        case 'QuadPoints': { const a = nums(v); if (!a || a.length === 0 || a.length % 8 !== 0) bad(); break; }
        case 'InkList': {
          if (v.kind !== 'array' || v.items.length === 0) { bad(); break; }
          for (const s of v.items) { const a = nums(s); if (!a || a.length < 2 || a.length % 2 !== 0) { bad(); break; } }
          break;
        }
        case 'BS': {
          if (!isDict(v)) { bad(); break; }
          for (const [bk, bv] of v.entries) if (bk !== 'W' || !isNum(bv)) bad();
          break;
        }
        case 'Open': if (!isBool(v)) bad(); break;
        case 'Length': if (v.kind !== 'number' || !v.integer || v.value < 0) bad(); break;
        case 'AP': {
          // /AP << /N ref-to-a-new-form >> and nothing else.
          if (!isDict(v) || v.entries.size !== 1) { this.add('PV4', 'ap-target', n.num); break; }
          const nv = v.entries.get('N');
          const target = nv && nv.kind === 'ref' && nv.gen === 0 ? news.get(nv.num) : undefined;
          if (!target || target.kind !== 'form') this.add('PV4', 'ap-target', n.num);
          else formRefs.add(target.num);
          break;
        }
        case 'Popup': {
          const t = v.kind === 'ref' && v.gen === 0 ? news.get(v.num) : undefined;
          const back = t?.dict?.entries.get('Parent');
          if (!t || t.kind !== 'popup' || !back || back.kind !== 'ref' || back.num !== n.num) this.add('PV4', 'popup-link', n.num);
          break;
        }
        case 'Parent': {
          const t = v.kind === 'ref' && v.gen === 0 ? news.get(v.num) : undefined;
          const back = t?.dict?.entries.get('Popup');
          if (!t || (t.kind !== 'highlight' && t.kind !== 'ink') || !back || back.kind !== 'ref' || back.num !== n.num) this.add('PV4', 'popup-link', n.num);
          break;
        }
        case 'Resources': this.resources(bf, n.num, v); break;
      }
    }
    if (kind !== 'form' && nums(d.entries.get('Rect'))?.length !== 4) bad();
    if (kind === 'popup' && !d.entries.has('Parent')) this.add('PV4', 'popup-link', n.num);
  }

  /** PV4 d: inline /Resources with only an inline Multiply ExtGState and references to fonts of the base. */
  private resources(bf: PdfFile, num: number, v: PdfValue): void {
    if (!isDict(v)) { this.add('PV4', 'new-value', num); return; }
    for (const [rk, rv] of v.entries) {
      if (rk === 'ExtGState') {
        if (!isDict(rv)) { this.add('PV4', 'new-value', num); continue; }
        for (const gs of rv.entries.values()) {
          if (!isDict(gs) || nameOf(gs.entries.get('BM')) !== 'Multiply') { this.add('PV4', 'new-value', num); continue; }
          for (const [gk, gv] of gs.entries) {
            const ok = gk === 'BM' || (gk === 'Type' && nameOf(gv) === 'ExtGState') || ((gk === 'CA' || gk === 'ca') && isNum(gv));
            if (!ok) this.add('PV4', 'new-value', num);
          }
        }
      } else if (rk === 'Font') {
        if (!isDict(rv)) { this.add('PV4', 'new-value', num); continue; }
        for (const f of rv.entries.values()) {
          const fd = f.kind === 'ref' && f.num < bf.size ? safeDeref(bf, f) : null;
          if (!fd || !isDict(fd) || nameOf(fd.entries.get('Type')) !== 'Font') this.add('PV4', 'font-ref', num);
        }
      } else this.add('PV4', 'new-value', num);
    }
  }

  /** Field and widget objects a request may rewrite: the requested refs and their /Parent ancestors. */
  private fieldFamily(bf: PdfFile): Set<string> {
    const fam = new Set<string>();
    for (const key of this.input.state.fields.keys()) {
      fam.add(key);
      let d = dictOf(safeResolve(bf, key)?.value);
      for (let i = 0; d && i < MAX_FIELD_DEPTH; i++) {
        const p = d.entries.get('Parent');
        if (!p || p.kind !== 'ref') break;
        const pk = refKey(p);
        if (fam.has(pk)) break;
        fam.add(pk);
        d = dictOf(safeResolve(bf, pk)?.value);
      }
    }
    return fam;
  }

  private supersededKind(bf: PdfFile, o: PdfIndirectObject, pageIndex: Map<string, number>): SupersededKind {
    const key = refKey(o);
    const ref = (v: PdfValue | undefined) => (v && v.kind === 'ref' ? refKey(v) : null);
    const root = ref(bf.trailer.entries.get('Root'));
    if (key === root) return 'catalog';
    if (key === ref(bf.trailer.entries.get('Info'))) return 'info';
    const catalog = root ? dictOf(safeResolve(bf, root)?.value) : null;
    if (catalog && key === ref(catalog.entries.get('AcroForm'))) return 'acroform';
    if (catalog && key === ref(catalog.entries.get('StructTreeRoot'))) return 'struct';
    if (pageIndex.has(key)) return 'page';
    if (o.value.kind === 'stream') return 'stream';
    const d = dictOf(o.value);
    if (!d) return 'other';
    const type = nameOf(d.entries.get('Type'));
    if (type && STRUCT_TYPES.has(type)) return 'struct';
    if (type === 'Catalog') return 'catalog';
    if (type === 'Pages') return 'pages';
    if (type === 'Page') return 'other'; // a page object outside the page tree
    const sub = nameOf(d.entries.get('Subtype'));
    if (sub === 'Widget') return 'widget';
    if (sub) return 'annot';
    if (d.entries.has('FT') || d.entries.has('T') || d.entries.has('Kids')) return 'field';
    if (d.entries.has('Fields')) return 'acroform';
    return 'other';
  }

  private supersede(o: PdfIndirectObject, c: {
    bf: PdfFile; news: Map<number, NewObject>; formRefs: Set<number>; links: Map<number, number>;
    rewrittenPages: Set<number>; pageIndex: Map<string, number>; fieldFamily: Set<string>;
  }): void {
    const before = safeResolve(c.bf, refKey(o));
    if (!before) { this.add('PV3', 'superseded-missing', o.num); return; }
    const kind = this.supersededKind(c.bf, before, c.pageIndex);
    const rule = SUPERSEDE_RULES[kind];
    const bd = dictOf(before.value), od = dictOf(o.value);
    const changed = bd && od ? dictDiff(bd, od) : [];
    // PV5 on changed keys (an unchanged /A or /AA carried over by a rewrite is not a finding).
    if (od) for (const k of changed) if (INERT_NAMES.has(k) || hasInertName(od.entries.get(k))) { this.add('PV5', 'action-introduced', o.num); break; }
    if (!rule) { this.add('PV4', SUPERSEDED_CODE[kind], o.num); return; }
    if (before.value.kind === 'stream' || o.value.kind === 'stream' || !bd || !od) { this.add('PV4', 'kind-changed', o.num); return; }
    for (const k of changed) if (!rule.keys.has(k)) this.add('PV4', 'superseded-key', o.num);

    if (kind === 'page') {
      const p = c.pageIndex.get(refKey(o))!;
      c.rewrittenPages.add(p);
      this.pageAnnots(c.bf, o.num, p, bd, od, c.news, c.links);
      return;
    }
    // widget / field
    if (!c.fieldFamily.has(refKey(o))) this.add('PV4', 'field-unexpected', o.num);
    if (changed.includes('MK')) {
      const a = bd.entries.get('MK'), b = od.entries.get('MK');
      const r = isDict(a) ? a.entries.get('R') : undefined;
      const stripped = isDict(a) && r && r.kind === 'number' && r.value === 0
        ? { ...a, entries: new Map([...a.entries].filter(([k]) => k !== 'R')) } : a;
      if (!equalValues(stripped, b)) this.add('PV4', 'mk-changed', o.num);
    }
    if (changed.includes('AP') && od.entries.has('AP')) this.widgetAp(c.bf, o.num, od.entries.get('AP')!, c.news, c.formRefs);
  }

  /** A rewritten widget's /AP: N/D/R, each a reference or a dictionary of references, to base objects or new forms. */
  private widgetAp(bf: PdfFile, num: number, ap: PdfValue, news: Map<number, NewObject>, formRefs: Set<number>): void {
    const okRef = (v: PdfValue): boolean => {
      if (v.kind !== 'ref') return false;
      if (v.num >= bf.size) {
        const t = news.get(v.num);
        if (!t || t.kind !== 'form' || v.gen !== 0) return false;
        formRefs.add(t.num);
        return true;
      }
      const e = bf.entry(v.num);
      return !!e && e.type !== 'free' && e.gen === v.gen;
    };
    if (!isDict(ap)) { this.add('PV4', 'ap-target', num); return; }
    for (const [k, v] of ap.entries) {
      if (k !== 'N' && k !== 'D' && k !== 'R') { this.add('PV4', 'ap-target', num); continue; }
      if (v.kind === 'ref') { if (!okRef(v)) this.add('PV4', 'ap-target', num); continue; }
      if (!isDict(v)) { this.add('PV4', 'ap-target', num); continue; }
      for (const s of v.entries.values()) if (!okRef(s)) this.add('PV4', 'ap-target', num);
    }
  }

  /** PV4 page row: /Annots is an inline array equal to "old minus removed, plus the new annotations". */
  private pageAnnots(bf: PdfFile, num: number, page: number, bd: PdfDict, od: PdfDict, news: Map<number, NewObject>, links: Map<number, number>): void {
    const raw = od.entries.get('Annots');
    if (raw !== undefined && raw.kind !== 'array') { this.add('PV4', 'annots-indirect', num, page); return; }
    const freed = new Set(expectedFreed(this.input.state, storageContext(this.input.classification)).map(refKey));
    const oldVal = bd.entries.get('Annots');
    const old = oldVal ? safeDerefValue(bf, oldVal) : null;
    const oldItems = old && old.kind === 'array' ? old.items : [];
    const keep = oldItems.filter((it) => !(it.kind === 'ref' && freed.has(refKey(it))));
    const items = raw ? raw.items : [];
    const kept: PdfValue[] = [];
    for (const it of items) {
      if (it.kind === 'ref' && it.num >= bf.size) {
        const t = news.get(it.num);
        if (!t || it.gen !== 0 || (t.kind !== 'highlight' && t.kind !== 'ink' && t.kind !== 'popup')) { this.add('PV4', 'annots-mismatch', num, page); continue; }
        if (links.has(it.num)) { this.add('PV4', 'annot-unlinked', it.num); continue; }
        links.set(it.num, page);
      } else kept.push(it);
    }
    if (kept.length !== keep.length || kept.some((it, i) => !equalValues(it, keep[i]))) this.add('PV4', 'annots-mismatch', num, page);
  }

  /** Pages the request adds annotations to or removes annotations from. */
  private expectedPages(): Set<number> {
    const out = new Set<number>();
    for (const r of this.input.state.added.values()) out.add(r.spec.page);
    for (const k of this.input.state.removed) {
      const f = this.input.classification.context.deletable.get(k);
      if (f) out.add(f.page);
    }
    return out;
  }

  /** PV4: each new Highlight/Ink is one of the requested annotations, on its page; Popups sit with their parent. */
  private matchAnnotations(news: Map<number, NewObject>, links: Map<number, number>): void {
    const wanted: Array<{ e: AddedEntry; used: boolean }> = [];
    for (const [k, v] of this.entries) {
      if (isEditorKey(k) && !('deleted' in v)) wanted.push({ e: v as AddedEntry, used: false });
    }
    const markup = [...news.values()].filter((n) => n.kind === 'highlight' || n.kind === 'ink').sort((a, b) => a.num - b.num);
    for (const n of markup) {
      const page = links.get(n.num);
      if (page === undefined) { this.add('PV4', 'annot-unlinked', n.num); continue; }
      const hit = wanted.find((w) => !w.used && w.e.pageIndex === page && annotMatches(n, w.e));
      if (hit) { hit.used = true; continue; }
      if (wanted.some((w) => !w.used && annotMatches(n, w.e))) this.add('PV4', 'annot-wrong-page', n.num, page);
      else this.add('PV4', 'annot-unexpected', n.num, page);
    }
    for (const w of wanted) if (!w.used) this.add('PV4', 'annot-missing', undefined, w.e.pageIndex);
    for (const n of news.values()) {
      if (n.kind !== 'popup') continue;
      const page = links.get(n.num);
      if (page === undefined) { this.add('PV4', 'annot-unlinked', n.num); continue; }
      const parent = n.dict?.entries.get('Parent');
      if (parent && parent.kind === 'ref' && links.has(parent.num) && links.get(parent.num) !== page) this.add('PV4', 'annot-wrong-page', n.num, page);
    }
  }

  // ---------------------------------------------------------------- PV6

  private observed(): void {
    const { observed, classification: cls, state } = this.input;
    if (observed.pageCount !== cls.pages.length) this.add('PV6', 'page-count');
    const delta = expectedAnnotDelta(state, storageContext(cls));
    if (observed.annotsPerPage.length !== cls.pages.length) this.add('PV6', 'annot-count');
    else {
      for (let p = 0; p < cls.pages.length; p++) {
        if (observed.annotsPerPage[p] !== cls.pages[p].annots.length + (delta.get(p) ?? 0)) this.add('PV6', 'annot-count', cls.pages[p].ref.num, p);
      }
    }
    for (const { ref, value } of canonicalFields(state)) {
      const got = observed.fields.find((f) => f.ref.num === ref.num && f.ref.gen === ref.gen);
      if (!got) this.add('PV6', 'field-missing', ref.num);
      else if (!fieldValuesEqual(got.value, value)) this.add('PV6', 'field-value', ref.num);
    }
  }
}

// ================================================================ helpers outside the class

/** The new-object kind of an appended object, or null when it is not on the allow-list. */
function newKindOf(o: PdfIndirectObject, rev: PdfRevision): NewObjectKind | null {
  const v = o.value;
  if (v.kind === 'stream') {
    const type = nameOf(v.dict.entries.get('Type'));
    if (type === 'XRef') return rev.kind === 'stream' && o.num === rev.xrefStreamNum ? 'xref' : null;
    if (nameOf(v.dict.entries.get('Subtype')) === 'Form' && (type === null || type === 'XObject')) return 'form';
    return null;
  }
  if (v.kind !== 'dict') return null;
  const type = nameOf(v.entries.get('Type'));
  if (type !== null && type !== 'Annot') return null;
  switch (nameOf(v.entries.get('Subtype'))) {
    case 'Highlight': return 'highlight';
    case 'Ink': return 'ink';
    case 'Popup': return 'popup';
    default: return null;
  }
}

/** Does new annotation `n` look like the requested entry: subtype, rectangle, colour and comment? */
function annotMatches(n: NewObject, e: AddedEntry): boolean {
  const d = n.dict!;
  if ((n.kind === 'highlight') !== (e.annotationType === 9)) return false;
  const rect = nums(d.entries.get('Rect'));
  if (!rect || rect.length !== 4 || rect.some((x, i) => Math.abs(x - e.rect[i]) > RECT_EPS)) return false;
  const c = nums(d.entries.get('C'));
  if (!c || c.length !== 3 || c.some((x, i) => Math.abs(x - e.color[i] / 255) > COLOR_EPS)) return false;
  const contents = d.entries.get('Contents');
  const text = contents && contents.kind === 'string' ? decodeTextString(contents.bytes) : '';
  if (text !== (e.popup?.contents ?? '')) return false;
  return d.entries.has('Popup') === !!e.popup;
}

/** End of an appended object (after `endobj`), or -1 when `endobj` does not follow its value. */
function objectEnd(out: Uint8Array, o: PdfIndirectObject): number {
  const v = o.value;
  const p = skipWs(out, v.end);
  if (!matchAt(out, p, 'endobj')) return -1;
  return p + 6;
}

function safeResolve(f: PdfFile, key: string): PdfIndirectObject | null {
  const sp = key.indexOf(' ');
  try { return f.resolve(Number(key.slice(0, sp)), Number(key.slice(sp + 1))); } catch (e) {
    if (e instanceof PdfReadError) return null;
    throw e;
  }
}

function safeDeref(f: PdfFile, v: PdfValue): PdfValue | PdfStream | null {
  try { return f.deref(v); } catch (e) {
    if (e instanceof PdfReadError) return null;
    throw e;
  }
}

function safeDerefValue(f: PdfFile, v: PdfValue): PdfValue | null {
  const d = safeDeref(f, v);
  return d && d.kind !== 'stream' ? d : null;
}
