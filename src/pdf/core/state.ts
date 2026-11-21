// Host-owned edit state of a PDF document (spec §6.3): the single source of truth the storage
// adapter (§6.4) serialises from and the webview draws (`pdfState`). Pure; no `vscode`, no npm.
//
// Model
//  - The state is three normalised maps: annotations added this session (by webview `localId`),
//    pre-existing annotations removed (by "num gen"), and form values (by "num gen").
//  - An edit is planned into a reversible delta `{ slot, key, before, after }[]` (undefined/false =
//    absent) without touching the state, then applied atomically. Undo applies `invertDelta`.
//    Every delta entry checks its `before` against the state, so an out-of-order apply is refused
//    instead of corrupting the state.
//  - Normalisation: adding and then removing an annotation removes the record (no tombstone), a
//    field set back to its loaded value removes the key, and an operation that changes nothing
//    plans an empty delta (the caller records no edit). Hence any sequence that returns to the
//    loaded content yields the empty state, and the empty state saves the loaded bytes (PG2).
//  - Records are frozen and never mutated: an update replaces the record.

import type { PdfAnnotSpec, PdfColor, PdfEditOp, PdfFieldValue, PdfObjRef, PdfStateView } from '../protocol.js';
import { fitsPage, inkBounds, normalizeQuads, quadsBounds } from './geometry.js';
import type { PdfBox, PdfPageBoxes } from './geometry.js';

// ---------------------------------------------------------------- types

export interface PdfAnnotRecord {
  readonly spec: Readonly<PdfAnnotSpec>;
  /** Assigned by the host when the annotation is added (an ISO 8601 date-time). */
  readonly createdAt: string;
  /** Assigned by the host; stable across undo/redo of the same add. */
  readonly uniqueName: string;
}

export interface PdfEditState {
  /** Session-created annotations by `localId`. */
  added: Map<number, PdfAnnotRecord>;
  /** "num gen" of removed pre-existing markup annotations (their Popups go with them, §6.3). */
  removed: Set<string>;
  /** "num gen" of a field or widget -> value differing from the loaded value. */
  fields: Map<string, PdfFieldValue>;
}

export type PdfDeltaEntry =
  | { readonly slot: 'added'; readonly key: number; readonly before?: PdfAnnotRecord; readonly after?: PdfAnnotRecord }
  | { readonly slot: 'removed'; readonly key: string; readonly before: boolean; readonly after: boolean }
  | { readonly slot: 'fields'; readonly key: string; readonly before?: PdfFieldValue; readonly after?: PdfFieldValue };

export type PdfDelta = readonly PdfDeltaEntry[];

/** Edit labels of spec §6.3 (the VS Code undo stack shows them). */
export type PdfEditLabel =
  | 'Highlight' | 'Draw' | 'Edit Comment' | 'Change Colour' | 'Delete Annotation' | 'Fill Form Field';

/**
 * Value kinds a fillable field accepts. PWP-27 adds the value rules of spec §8.5 (MaxLen, options,
 * read-only and rich-text refusals) through `check`.
 */
export interface PdfFieldRule {
  kind: 'text' | 'button' | 'choice';
  /** Extra rule; returns a user-presentable refusal, or null to accept. */
  check?(value: PdfFieldValue): string | null;
}

/** Facts from classification (§6.2) that edits are validated against. */
export interface PdfEditContext {
  /** Boxes per page, index = 0-based page number; its length is the page count. */
  pages: readonly PdfPageBoxes[];
  /** Deletable pre-existing markup annotations: "num gen" -> facts. */
  deletable: ReadonlyMap<string, { page: number; popup?: string }>;
  /** Popup "num gen" -> its parent's "num gen"; removing a Popup removes its parent. */
  popups?: ReadonlyMap<string, string>;
  /** Fillable fields/widgets: "num gen" -> rule. Empty while forms are off (until PWP-27). */
  fields: ReadonlyMap<string, PdfFieldRule>;
}

/** Host-assigned data for an added annotation. */
export interface PdfEditEnv {
  /** Creation time of a new annotation, ISO 8601. */
  now(): string;
  /** Unique name of a new annotation; default `uniqueNameFor`. */
  uniqueName?(localId: number, createdAt: string): string;
  /**
   * Loaded values of fields ("num gen" -> value), first report wins (`fieldBaselines`, `noteBaselines`). Held by the
   * document per generation, not part of the undoable state.
   */
  baseline?: ReadonlyMap<string, PdfFieldValue>;
}

export type PdfEditRefusalReason =
  | 'unknown-page' | 'bad-geometry' | 'outside-page' | 'too-many-annotations' | 'duplicate-local-id'
  | 'unknown-annotation' | 'not-deletable' | 'not-fillable' | 'bad-value' | 'duplicate-field';

/** Structurally an `OfficeError` (code 'invalid'), plus a machine-readable reason for logs and tests. */
export interface PdfEditRefusal { code: 'invalid'; reason: PdfEditRefusalReason; message: string; }

export type PdfEditPlan =
  | { ok: true; delta: PdfDelta; label: PdfEditLabel }
  | { ok: false; error: PdfEditRefusal };

/** At most this many session-created annotations (spec §6.3). */
export const MAX_ADDED_ANNOTATIONS = 10_000;

// ---------------------------------------------------------------- keys and values

/** "num gen" — the key of an object of the loaded file in the state maps. */
export function refKey(ref: PdfObjRef): string {
  return `${ref.num} ${ref.gen}`;
}

export function parseRefKey(key: string): PdfObjRef {
  const sp = key.indexOf(' ');
  return { num: Number(key.slice(0, sp)), gen: Number(key.slice(sp + 1)) };
}

/** Default unique name: deterministic from the add, so redo restores the same name. */
export function uniqueNameFor(localId: number, createdAt: string): string {
  return `vsmd-${localId}-${createdAt}`;
}

export function fieldValuesEqual(a: PdfFieldValue | undefined, b: PdfFieldValue | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function numsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

export function specsEqual(a: PdfAnnotSpec, b: PdfAnnotSpec): boolean {
  if (a.kind !== b.kind || a.localId !== b.localId || a.page !== b.page || a.color !== b.color || a.comment !== b.comment) return false;
  if (a.kind === 'highlight') return numsEqual(a.quads, (b as typeof a).quads);
  const bi = b as typeof a;
  if (a.width !== bi.width || a.paths.length !== bi.paths.length) return false;
  for (let i = 0; i < a.paths.length; i++) if (!numsEqual(a.paths[i], bi.paths[i])) return false;
  return true;
}

export function recordsEqual(a: PdfAnnotRecord | undefined, b: PdfAnnotRecord | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.createdAt === b.createdAt && a.uniqueName === b.uniqueName && specsEqual(a.spec, b.spec);
}

// ---------------------------------------------------------------- state

export function emptyState(): PdfEditState {
  return { added: new Map(), removed: new Set(), fields: new Map() };
}

export function isEmptyState(s: PdfEditState): boolean {
  return s.added.size === 0 && s.removed.size === 0 && s.fields.size === 0;
}

/** A copy sharing the (frozen) records and values. */
export function cloneState(s: PdfEditState): PdfEditState {
  return { added: new Map(s.added), removed: new Set(s.removed), fields: new Map(s.fields) };
}

export function statesEqual(a: PdfEditState, b: PdfEditState): boolean {
  if (a.added.size !== b.added.size || a.removed.size !== b.removed.size || a.fields.size !== b.fields.size) return false;
  for (const [k, r] of a.added) if (!recordsEqual(r, b.added.get(k))) return false;
  for (const k of a.removed) if (!b.removed.has(k)) return false;
  for (const [k, v] of a.fields) if (!b.fields.has(k) || !fieldValuesEqual(v, b.fields.get(k))) return false;
  return true;
}

function compareRefKeys(a: string, b: string): number {
  const p = parseRefKey(a), q = parseRefKey(b);
  return p.num - q.num || p.gen - q.gen;
}

/** Added annotations in canonical order: page, then creation time, then `localId` (§6.4). */
export function canonicalAnnotations(s: PdfEditState): PdfAnnotRecord[] {
  return [...s.added.values()].sort((a, b) =>
    a.spec.page - b.spec.page
    || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    || a.spec.localId - b.spec.localId);
}

/** Removed refs in object-number order. */
export function canonicalRemoved(s: PdfEditState): PdfObjRef[] {
  return [...s.removed].sort(compareRefKeys).map(parseRefKey);
}

/** Field values in object-number order. */
export function canonicalFields(s: PdfEditState): Array<{ ref: PdfObjRef; value: PdfFieldValue }> {
  return [...s.fields.keys()].sort(compareRefKeys).map((k) => ({ ref: parseRefKey(k), value: copyValue(s.fields.get(k)!) }));
}

function copySpec(spec: Readonly<PdfAnnotSpec>): PdfAnnotSpec {
  return spec.kind === 'highlight'
    ? { kind: 'highlight', localId: spec.localId, page: spec.page, quads: spec.quads.slice(), color: spec.color, comment: spec.comment }
    : { kind: 'ink', localId: spec.localId, page: spec.page, paths: spec.paths.map((p) => p.slice()), color: spec.color,
        width: spec.width, comment: spec.comment };
}

function copyValue(v: PdfFieldValue): PdfFieldValue {
  return Array.isArray(v) ? v.slice() : v;
}

/** What the webview draws (`pdfState`), canonical order, fresh mutable copies. */
export function toStateView(s: PdfEditState, version: number): PdfStateView {
  return {
    version,
    annots: canonicalAnnotations(s).map((r) => ({ ...copySpec(r.spec), createdAt: r.createdAt })),
    removed: canonicalRemoved(s),
    fields: canonicalFields(s),
  };
}

// ---------------------------------------------------------------- deltas

/** The delta that undoes `d`: entries reversed, before/after swapped. */
export function invertDelta(d: PdfDelta): PdfDelta {
  const out: PdfDeltaEntry[] = [];
  for (let i = d.length - 1; i >= 0; i--) {
    const e = d[i];
    out.push({ slot: e.slot, key: e.key, before: e.after, after: e.before } as PdfDeltaEntry);
  }
  return out;
}

function matches(s: PdfEditState, e: PdfDeltaEntry): boolean {
  switch (e.slot) {
    case 'added': return recordsEqual(s.added.get(e.key), e.before);
    case 'removed': return s.removed.has(e.key) === e.before;
    case 'fields': return s.fields.has(e.key) === (e.before !== undefined)
      && fieldValuesEqual(s.fields.get(e.key), e.before);
  }
}

/**
 * Apply `d` to `s` in place, atomically: if any entry's `before` does not match the state nothing
 * is changed and false is returned (a stale or out-of-order delta). An entry may not repeat a key.
 */
export function applyDelta(s: PdfEditState, d: PdfDelta): boolean {
  const seen = new Set<string>();
  for (const e of d) {
    const id = `${e.slot}:${e.key}`;
    if (seen.has(id) || !matches(s, e)) return false;
    seen.add(id);
  }
  for (const e of d) {
    switch (e.slot) {
      case 'added': if (e.after) s.added.set(e.key, e.after); else s.added.delete(e.key); break;
      case 'removed': if (e.after) s.removed.add(e.key); else s.removed.delete(e.key); break;
      case 'fields': if (e.after !== undefined) s.fields.set(e.key, e.after); else s.fields.delete(e.key); break;
    }
  }
  return true;
}

/**
 * The loaded values a `setFields` op reports (`loaded`), for fillable fields whose value kind they
 * fit. Recorded with `noteBaselines` whatever the op's outcome: the webview sends a loaded value only
 * with its first change to a field, and that first change may be refused or change nothing.
 */
export function fieldBaselines(op: PdfEditOp, ctx: PdfEditContext): Array<readonly [string, PdfFieldValue]> {
  if (op.op !== 'setFields') return [];
  const out: Array<readonly [string, PdfFieldValue]> = [];
  for (const { ref, loaded } of op.values) {
    const rule = ctx.fields.get(refKey(ref));
    if (loaded !== undefined && rule && valueFitsKind(rule, loaded)) out.push([refKey(ref), loaded]);
  }
  return out;
}

/** Record reported loaded values; the first report for a field wins. */
export function noteBaselines(baseline: Map<string, PdfFieldValue>, notes: ReadonlyArray<readonly [string, PdfFieldValue]>): void {
  for (const [k, v] of notes) if (!baseline.has(k)) baseline.set(k, freezeValue(v));
}

// ---------------------------------------------------------------- planning

function refuse(reason: PdfEditRefusalReason, message: string): PdfEditPlan {
  return { ok: false, error: { code: 'invalid', reason, message } };
}

function freezeValue(v: PdfFieldValue): PdfFieldValue {
  return Array.isArray(v) ? Object.freeze(v.slice()) as string[] : v;
}

function freezeSpec(spec: PdfAnnotSpec): Readonly<PdfAnnotSpec> {
  if (spec.kind === 'highlight') Object.freeze(spec.quads);
  else { for (const p of spec.paths) Object.freeze(p); Object.freeze(spec.paths); }
  return Object.freeze(spec);
}

function makeRecord(spec: PdfAnnotSpec, createdAt: string, uniqueName: string): PdfAnnotRecord {
  return Object.freeze({ spec: freezeSpec(spec), createdAt, uniqueName });
}

/** The /Rect of an annotation spec in user space, or null when the geometry is unusable. */
export function annotationBounds(spec: PdfAnnotSpec): PdfBox | null {
  return spec.kind === 'highlight' ? quadsBounds(spec.quads) : inkBounds(spec.paths, spec.width);
}

/** Validated, normalised copy of a new annotation's spec, or a refusal. */
function normaliseSpec(spec: PdfAnnotSpec, ctx: PdfEditContext): PdfAnnotSpec | PdfEditPlan {
  if (!Number.isSafeInteger(spec.page) || spec.page < 0 || spec.page >= ctx.pages.length) {
    return refuse('unknown-page', 'The page does not exist.');
  }
  let out: PdfAnnotSpec;
  if (spec.kind === 'highlight') {
    const quads = normalizeQuads(spec.quads);
    if (!quads) return refuse('bad-geometry', 'The highlight has no usable area.');
    out = { kind: 'highlight', localId: spec.localId, page: spec.page, quads, color: spec.color, comment: spec.comment };
  } else {
    if (spec.paths.length === 0) return refuse('bad-geometry', 'The drawing has no strokes.');
    const paths: number[][] = [];
    for (const p of spec.paths) {
      if (!Array.isArray(p) || p.length < 4 || p.length % 2 !== 0) return refuse('bad-geometry', 'A stroke needs at least two points.');
      for (const n of p) if (typeof n !== 'number' || !Number.isFinite(n)) return refuse('bad-geometry', 'A stroke has an invalid point.');
      paths.push(p.slice());
    }
    out = { kind: 'ink', localId: spec.localId, page: spec.page, paths, color: spec.color, width: spec.width, comment: spec.comment };
  }
  const bounds = annotationBounds(out);
  if (!bounds) return refuse('bad-geometry', 'The annotation has no usable geometry.');
  if (!fitsPage(bounds, ctx.pages[spec.page])) return refuse('outside-page', 'The annotation lies outside the page.');
  return out;
}

function valueFitsKind(rule: PdfFieldRule, v: PdfFieldValue): boolean {
  switch (rule.kind) {
    case 'text': return typeof v === 'string';
    case 'button': return typeof v === 'boolean';
    case 'choice': return typeof v === 'string' || Array.isArray(v);
  }
}

/**
 * Plan `op` against `s` without changing it. The protocol validator (`parsePdfToHost`) has already
 * checked types and caps; this checks the op against the state and the classification. An
 * `ok: true` plan with an empty delta means the op changes nothing: record no edit, fire no event.
 */
export function planEdit(s: PdfEditState, op: PdfEditOp, ctx: PdfEditContext, env: PdfEditEnv): PdfEditPlan {
  switch (op.op) {
    case 'addAnnotation': {
      const id = op.spec.localId;
      if (s.added.has(id)) return refuse('duplicate-local-id', 'This annotation already exists.');
      if (s.added.size >= MAX_ADDED_ANNOTATIONS) return refuse('too-many-annotations', 'Too many annotations in one session.');
      const spec = normaliseSpec(op.spec, ctx);
      if ('ok' in spec) return spec;
      const createdAt = env.now();
      const uniqueName = (env.uniqueName ?? uniqueNameFor)(id, createdAt);
      return { ok: true, label: spec.kind === 'highlight' ? 'Highlight' : 'Draw',
        delta: [{ slot: 'added', key: id, after: makeRecord(spec, createdAt, uniqueName) }] };
    }
    case 'updateAnnotation': {
      const rec = s.added.get(op.localId);
      if (!rec) return refuse('unknown-annotation', 'Only annotations added in this session can be changed.');
      const comment = op.patch.comment ?? rec.spec.comment;
      const color: PdfColor = op.patch.color ?? rec.spec.color;
      const label: PdfEditLabel = comment !== rec.spec.comment ? 'Edit Comment' : 'Change Colour';
      if (comment === rec.spec.comment && color === rec.spec.color) return { ok: true, label, delta: [] };
      const spec = { ...copySpec(rec.spec), comment, color } as PdfAnnotSpec;
      return { ok: true, label,
        delta: [{ slot: 'added', key: op.localId, before: rec, after: makeRecord(spec, rec.createdAt, rec.uniqueName) }] };
    }
    case 'removeAnnotation': {
      const t = op.target;
      if ('localId' in t) {
        const rec = s.added.get(t.localId);
        if (!rec) return refuse('unknown-annotation', 'The annotation does not exist.');
        return { ok: true, label: 'Delete Annotation', delta: [{ slot: 'added', key: t.localId, before: rec }] };
      }
      let key = refKey(t.ref);
      const parent = ctx.popups?.get(key);
      if (parent !== undefined) key = parent;
      if (!ctx.deletable.has(key)) return refuse('not-deletable', 'This annotation cannot be deleted.');
      if (s.removed.has(key)) return { ok: true, label: 'Delete Annotation', delta: [] };
      return { ok: true, label: 'Delete Annotation', delta: [{ slot: 'removed', key, before: false, after: true }] };
    }
    case 'setFields': {
      const seen = new Set<string>();
      const delta: PdfDeltaEntry[] = [];
      for (const { ref, value, loaded } of op.values) {
        const key = refKey(ref);
        if (seen.has(key)) return refuse('duplicate-field', 'A field was given two values.');
        seen.add(key);
        const rule = ctx.fields.get(key);
        if (!rule) return refuse('not-fillable', 'This field cannot be filled.');
        if (!valueFitsKind(rule, value) || (loaded !== undefined && !valueFitsKind(rule, loaded))) {
          return refuse('bad-value', 'The value does not fit the field.');
        }
        const msg = rule.check?.(value);
        if (msg) return { ok: false, error: { code: 'invalid', reason: 'bad-value', message: msg } };
        // A recorded loaded value wins over the one in this op (first report wins).
        const base = env.baseline?.get(key) ?? loaded;
        const before = s.fields.get(key);
        const after = base !== undefined && fieldValuesEqual(value, base) ? undefined : freezeValue(value);
        if (fieldValuesEqual(before, after)) continue;
        delta.push({ slot: 'fields', key, before, after });
      }
      return { ok: true, label: 'Fill Form Field', delta };
    }
  }
}

/**
 * Convenience: record the op's loaded values in `env.baseline` (when given), plan, and apply.
 * Returns the plan; on `ok` the state has changed by `plan.delta`.
 */
export function applyEdit(s: PdfEditState, op: PdfEditOp, ctx: PdfEditContext,
  env: PdfEditEnv & { baseline?: Map<string, PdfFieldValue> }): PdfEditPlan {
  if (env.baseline) noteBaselines(env.baseline, fieldBaselines(op, ctx));
  const plan = planEdit(s, op, ctx, env);
  if (plan.ok && !applyDelta(s, plan.delta)) throw new Error('internal: a planned delta did not apply');
  return plan;
}

