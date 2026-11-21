// Storage adapter (spec §6.4): turns the host's edit state (`state.ts`) into the exact list of pdf.js
// `annotationStorage` entries that the writer service (`media/pdfWriter.js`) feeds to
// `annotationStorage.setValue` before `saveDocument()`. Pure; no `vscode`, no npm.
//
// The entry format is internal to pdf.js; it was read from the pinned 6.5.438 worker source
// (`saveNewAnnotations`, `createNewDict` / `createNewAppearanceStream` of Highlight and Ink,
// `#replaceIdByRef`) and is pinned by tests/pdf/writerContract.test.mjs, which runs the real writer.
// Facts that shape it:
//  - Added and removed annotations are only seen under keys starting `pdfjs_internal_editor_`
//    (`getNewAnnotationsMap`). A removal keyed by the bare annotation id is silently ignored: nothing
//    is appended and the annotation stays (spike S3). Removals therefore get editor keys too.
//  - A removal names its Popup in `popupRef` so the writer frees both.
//  - Field values are keyed by the widget/field id ("12R", "12R3" for generation 3).
//  - The output is a pure function of the state (+ context): canonical order, dates from the state.
//  - Every value survives JSON. The host->webview channel may serialise messages as JSON, which
//    turns NaN into null; pdf.js's ink path format uses NaN control points for straight segments and
//    reads `isNaN(null)` as "a curve", so ink segments are written as cubic curves whose control
//    points are the segment's end points (a straight line) and no NaN is ever emitted.

import type { PdfAnnotSpec, PdfColor, PdfFieldValue, PdfObjRef } from '../protocol.js';
import type { PdfBox, PdfPageBoxes } from './geometry.js';
import { boxToArray, normBox, quadsToOutlines, visibleBox } from './geometry.js';
import type { PdfAnnotRecord, PdfEditContext, PdfEditState } from './state.js';
import { annotationBounds, canonicalAnnotations, canonicalFields, canonicalRemoved, parseRefKey, refKey } from './state.js';

// ---------------------------------------------------------------- constants

/** Key prefix under which pdf.js's writer looks for added and removed annotations. */
export const EDITOR_KEY_PREFIX = 'pdfjs_internal_editor_';

/** pdf.js `AnnotationEditorType` values the adapter emits. */
export const PDFJS_EDITOR_TYPE = { HIGHLIGHT: 9, INK: 15 } as const;

export type PdfRgb = readonly [number, number, number];

/** Highlight fill colours (0-255), drawn with a Multiply blend so text stays readable. */
export const HIGHLIGHT_RGB: Readonly<Record<PdfColor, PdfRgb>> = Object.freeze({
  yellow: [255, 255, 152], green: [83, 255, 188], blue: [128, 235, 255], pink: [255, 203, 230], red: [255, 79, 95],
});

/** Ink stroke colours (0-255): the same hues, dark enough to show as a line on white paper. */
export const INK_RGB: Readonly<Record<PdfColor, PdfRgb>> = Object.freeze({
  yellow: [230, 170, 0], green: [0, 150, 60], blue: [0, 90, 220], pink: [220, 50, 140], red: [220, 30, 40],
});

/** Size of the Popup rectangle written for a comment (points). Readers position popups themselves. */
export const POPUP_SIZE = { width: 180, height: 100 } as const;

// ---------------------------------------------------------------- entry types

export interface PdfPopupEntry { contents: string; rect: [number, number, number, number]; }

export interface PdfHighlightEntry {
  annotationType: 9; pageIndex: number; rect: [number, number, number, number]; rotation: 0;
  color: [number, number, number]; opacity: 1; quadPoints: number[]; outlines: number[][];
  date: string; user?: string; popup?: PdfPopupEntry;
}

export interface PdfInkEntry {
  annotationType: 15; pageIndex: number; rect: [number, number, number, number]; rotation: 0;
  color: [number, number, number]; opacity: 1; thickness: number;
  /** `lines`: per stroke [_, _, _, _, x0, y0, then c1x c1y c2x c2y x y per segment]; `points`: the /InkList. */
  paths: { lines: number[][]; points: number[][] };
  date: string; user?: string; popup?: PdfPopupEntry;
}

export interface PdfRemovalEntry { id: string; deleted: true; pageIndex: number; popupRef: string; }

export interface PdfFieldEntry { value: PdfFieldValue; }

export type PdfStorageValue = PdfHighlightEntry | PdfInkEntry | PdfRemovalEntry | PdfFieldEntry;

/** One `annotationStorage.setValue(key, value)` call; the shape of `pdfWrite.storage` items. */
export type PdfStorageEntry = [key: string, value: PdfStorageValue];

/** What the adapter needs besides the state: classification facts and the author setting. */
export interface PdfStorageContext {
  /** Deletable annotations ("num gen" -> page and Popup), as in `PdfEditContext`. */
  deletable: PdfEditContext['deletable'];
  /** Page boxes; when given, a comment's Popup rectangle is kept inside the visible page. */
  pages?: readonly PdfPageBoxes[];
  /** `annotationAuthor` setting (spec §8.2); written as /T when non-empty. */
  author?: string;
}

// ---------------------------------------------------------------- ids

/** pdf.js id of an object of the loaded file: "12R", or "12R3" when the generation is not 0. */
export function pdfjsId(ref: PdfObjRef): string {
  return ref.gen === 0 ? `${ref.num}R` : `${ref.num}R${ref.gen}`;
}

/** Inverse of `pdfjsId`; null when `id` is not of that form. */
export function parsePdfjsId(id: string): PdfObjRef | null {
  const m = /^(\d+)R(\d*)$/.exec(id);
  if (!m) return null;
  return { num: Number(m[1]), gen: m[2] ? Number(m[2]) : 0 };
}

export function isEditorKey(key: string): boolean {
  return key.startsWith(EDITOR_KEY_PREFIX);
}

// ---------------------------------------------------------------- entries

function fail(message: string): never {
  throw new Error(`storageAdapter: ${message}`);
}

function rgb(table: Readonly<Record<PdfColor, PdfRgb>>, c: PdfColor): [number, number, number] {
  const v = table[c];
  if (!v) fail(`unknown colour ${JSON.stringify(c)}`);
  return [v[0], v[1], v[2]];
}

function checkedDate(createdAt: string): string {
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) fail('annotation without a valid creation date');
  return createdAt;
}

function boundsOf(spec: PdfAnnotSpec): PdfBox {
  const b = annotationBounds(spec);
  if (!b) fail(`annotation ${spec.localId} has no usable geometry`);
  return b;
}

/** Popup rectangle right of the annotation, kept inside the visible page when its boxes are known. */
export function popupRect(annot: PdfBox, page?: PdfPageBoxes): [number, number, number, number] {
  const a = normBox(annot);
  const { width: w, height: h } = POPUP_SIZE;
  let x0 = a.x1 + 10, y1 = a.y1;
  if (page) {
    const v = visibleBox(page);
    x0 = Math.max(v.x0, Math.min(x0, v.x1 - w));
    y1 = Math.min(v.y1, Math.max(y1, v.y0 + h));
  }
  return [x0, y1 - h, x0 + w, y1];
}

function common(rec: PdfAnnotRecord, ctx: PdfStorageContext, bounds: PdfBox) {
  const out: { date: string; user?: string; popup?: PdfPopupEntry } = { date: checkedDate(rec.createdAt) };
  if (ctx.author) out.user = ctx.author;
  if (rec.spec.comment) out.popup = { contents: rec.spec.comment, rect: popupRect(bounds, ctx.pages?.[rec.spec.page]) };
  return out;
}

/** The storage value of a session-created highlight. */
export function highlightEntry(rec: PdfAnnotRecord, ctx: PdfStorageContext): PdfHighlightEntry {
  const spec = rec.spec;
  if (spec.kind !== 'highlight') fail('not a highlight');
  const bounds = boundsOf(spec);
  return {
    annotationType: PDFJS_EDITOR_TYPE.HIGHLIGHT, pageIndex: spec.page, rect: boxToArray(bounds), rotation: 0,
    color: rgb(HIGHLIGHT_RGB, spec.color), opacity: 1, quadPoints: spec.quads.slice(), outlines: quadsToOutlines(spec.quads),
    ...common(rec, ctx, bounds),
  };
}

/** One stroke [x0,y0,x1,y1,...] in pdf.js's path format, every segment a straight cubic (JSON-safe). */
export function strokeToLine(stroke: readonly number[]): number[] {
  const x0 = stroke[0], y0 = stroke[1];
  const line = [x0, y0, x0, y0, x0, y0];
  for (let i = 2; i + 1 < stroke.length; i += 2) {
    line.push(stroke[i - 2], stroke[i - 1], stroke[i], stroke[i + 1], stroke[i], stroke[i + 1]);
  }
  return line;
}

/** The storage value of a session-created ink drawing. */
export function inkEntry(rec: PdfAnnotRecord, ctx: PdfStorageContext): PdfInkEntry {
  const spec = rec.spec;
  if (spec.kind !== 'ink') fail('not an ink annotation');
  const bounds = boundsOf(spec);
  return {
    annotationType: PDFJS_EDITOR_TYPE.INK, pageIndex: spec.page, rect: boxToArray(bounds), rotation: 0,
    color: rgb(INK_RGB, spec.color), opacity: 1, thickness: spec.width,
    paths: { lines: spec.paths.map(strokeToLine), points: spec.paths.map((p) => p.slice()) },
    ...common(rec, ctx, bounds),
  };
}

/** The storage value that removes a pre-existing annotation (and its Popup). */
export function removalEntry(ref: PdfObjRef, ctx: PdfStorageContext): PdfRemovalEntry {
  const facts = ctx.deletable.get(refKey(ref));
  if (!facts) fail(`removed annotation ${refKey(ref)} is not in the deletable set`);
  return { id: pdfjsId(ref), deleted: true, pageIndex: facts.page, popupRef: facts.popup ? pdfjsId(parseRefKey(facts.popup)) : '' };
}

/**
 * The storage entries for `state`, in canonical order: editor entries grouped by page (ascending;
 * within a page removals by object number, then additions by creation time and `localId`), keyed
 * `pdfjs_internal_editor_0..n-1` in that order; then field values by object number. The empty state
 * yields no entries (and pdf.js then returns the loaded bytes unchanged). Throws on a state that
 * does not fit the context (a removal outside the deletable set, a record without geometry or date).
 */
export function toStorageEntries(state: PdfEditState, ctx: PdfStorageContext): PdfStorageEntry[] {
  const byPage = new Map<number, PdfStorageValue[]>();
  const push = (page: number, v: PdfStorageValue) => {
    let list = byPage.get(page);
    if (!list) byPage.set(page, (list = []));
    list.push(v);
  };
  for (const ref of canonicalRemoved(state)) { const e = removalEntry(ref, ctx); push(e.pageIndex, e); }
  for (const rec of canonicalAnnotations(state)) push(rec.spec.page, rec.spec.kind === 'highlight' ? highlightEntry(rec, ctx) : inkEntry(rec, ctx));

  const out: PdfStorageEntry[] = [];
  let n = 0;
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    for (const v of byPage.get(page)!) out.push([`${EDITOR_KEY_PREFIX}${n++}`, v]);
  }
  for (const { ref, value } of canonicalFields(state)) out.push([pdfjsId(ref), { value }]);
  return out;
}

// ---------------------------------------------------------------- expectations (for the verifier, PV3/PV6)

/** Objects the writer frees for `state`: each removed annotation and its Popup, in object order. */
export function expectedFreed(state: PdfEditState, ctx: PdfStorageContext): PdfObjRef[] {
  const out: PdfObjRef[] = [];
  for (const ref of canonicalRemoved(state)) {
    out.push(ref);
    const popup = ctx.deletable.get(refKey(ref))?.popup;
    if (popup) out.push(parseRefKey(popup));
  }
  return out.sort((a, b) => a.num - b.num || a.gen - b.gen);
}

/** Change of the annotation count per page index (Popups counted; pages without change omitted). */
export function expectedAnnotDelta(state: PdfEditState, ctx: PdfStorageContext): Map<number, number> {
  const d = new Map<number, number>();
  const add = (p: number, k: number) => d.set(p, (d.get(p) ?? 0) + k);
  for (const rec of state.added.values()) add(rec.spec.page, rec.spec.comment ? 2 : 1);
  for (const ref of canonicalRemoved(state)) {
    const f = ctx.deletable.get(refKey(ref));
    if (!f) fail(`removed annotation ${refKey(ref)} is not in the deletable set`);
    add(f.page, f.popup ? -2 : -1);
  }
  for (const [p, k] of d) if (k === 0) d.delete(p);
  return d;
}

/** UTF-8 size of the entries as JSON: "the serialised size of the state" of PV6. */
export function serialisedSize(entries: readonly PdfStorageEntry[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).length;
}
