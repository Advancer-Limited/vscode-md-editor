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
  | 'Highlight' | 'Draw' | 'Edit Comment' | 'Change Colour' | 'Edit Comment and Colour' | 'Delete Annotation' | 'Fill Form Field';

/**
 * Value kinds a fillable field accepts. The value rules of spec §8.5 (MaxLen, single line, options,
 * multi-select) come through `check`, built by `fieldRule`; read-only, signature, rich-text and the other
 * refusals are decided by classification, which leaves such fields out of `PdfEditContext.fields`.
 */
export interface PdfFieldRule {
  kind: 'text' | 'button' | 'choice';
  /** Extra rule; returns a user-presentable refusal, or null to accept. */
  check?(value: PdfFieldValue): string | null;
  /**
   * A radio-button group: every `setFields` op touching one member MUST state every member (pdf.js's
   * radio inputs write all siblings on each change), and at most one may be on — exactly one when the
   * field has NoToggleToOff. Members are widget keys, the field's own `key` included when it is merged.
   */
  group?: { readonly key: string; readonly members: readonly string[]; readonly exactlyOne: boolean };
  /**
   * What the verifier checks the written value against (spec §6.5 PV4 field rows, PWP-28): the field spec and the
   * key of the terminal field node that holds /V (the widget's own key for a merged field/widget). Classification
   * always sets both; a rule without them cannot be verified, so a save that sets such a field is refused.
   */
  spec?: Readonly<PdfFieldSpec>;
  field?: string;
}

/**
 * The value rules of one fillable field (spec §8.5), as classification derives them. Keys of
 * `PdfEditContext.fields` are WIDGET keys (pdf.js annotation ids); a text or choice field has exactly one
 * widget (multi-widget ones are locked), a checkbox one, a radio group one per button.
 */
export type PdfFieldSpec =
  /** `maxLen`: the inherited /MaxLen (a positive integer), or null for none. */
  | { kind: 'text'; maxLen: number | null; multiline: boolean; comb: boolean }
  | { kind: 'checkbox' }
  | { kind: 'radio'; group: string; members: readonly string[]; noToggleToOff: boolean }
  /** `options`: the export values in /Opt order (distinct). `editable`: a combo box with the Edit flag. */
  | { kind: 'choice'; options: readonly string[]; editable: boolean; multiSelect: boolean };

/**
 * Why a field cannot be filled (spec §8.5; plan PWP-27). Classification decides; the state refuses a
 * `setFields` on a locked widget with the reason's sentence (`FIELD_LOCK_MESSAGES`).
 */
export type PdfFieldLockReason =
  | 'read-only'          // Ff bit 1
  | 'signature'          // /FT /Sig: never touched
  | 'xfa'                // the AcroForm has /XFA: form filling is off for the document
  | 'scripts'            // /AA on the field, an ancestor or a widget, or /A on a widget (decision 2026-11-21)
  | 'calculated'         // the field or an ancestor is listed in the AcroForm /CO (calculation order)
  | 'need-appearances'   // the AcroForm already has /NeedAppearances true (§8.5: not relied on)
  | 'rich-text'          // Ff RichText or /RV
  | 'password'           // Ff Password: pdf.js writes no appearance and drops the value
  | 'file-select'        // Ff FileSelect
  | 'barcode'            // /PMD: pdf.js hides barcode fields
  | 'push-button'        // no value
  | 'multi-widget'       // a text/choice/checkbox field with more than one widget
  | 'no-on-state'        // a checkbox or radio widget whose /AP /N has no on-state
  | 'ambiguous-on-state' // ... more than one on-state, or radio widgets sharing one
  | 'no-options'         // a non-editable choice field without options
  | 'duplicate-options'  // two options with the same export value
  | 'indices'            // /I on a separate field node, an ancestor or a widget (pdf.js leaves it stale; PWP-28)
  | 'bad-max-len'        // /MaxLen not a positive integer, or Comb without one
  | 'bad-flags'          // /Ff not a non-negative integer, or a contradictory flag combination
  | 'unknown-type'       // /FT missing or not Tx/Btn/Ch
  | 'widget-placement'   // a widget not listed exactly once in exactly one page's /Annots
  | 'structure'          // kids/parent links, widget dictionaries or /Opt entries not as expected
  | 'not-a-field';       // a widget annotation not reached from the AcroForm /Fields tree

const UNSUPPORTED = 'This field cannot be filled here: its structure is not supported.';
/** User-presentable sentence per lock reason (UI `title`/`aria-describedby`, state refusals). No document content. */
export const FIELD_LOCK_MESSAGES: Readonly<Record<PdfFieldLockReason, string>> = Object.freeze({
  'read-only': 'This field is read-only.',
  'signature': 'Signature fields cannot be signed or changed here.',
  'xfa': 'This form uses XFA, which this editor does not fill.',
  'scripts': 'This field uses scripts (formatting, validation or calculation), which are not run here.',
  'calculated': 'This field is calculated by the form\'s scripts, which are not run here.',
  'need-appearances': 'This form asks readers to redraw its fields, which this editor does not rely on.',
  'rich-text': 'Rich-text fields cannot be filled here.',
  'password': 'Password fields cannot be filled here.',
  'file-select': 'File-selection fields cannot be filled here.',
  'barcode': 'Barcode fields cannot be filled here.',
  'push-button': 'Buttons have no value to fill.',
  'multi-widget': 'This field appears more than once in the document and cannot be filled here.',
  'no-on-state': UNSUPPORTED,
  'ambiguous-on-state': UNSUPPORTED,
  'no-options': UNSUPPORTED,
  'duplicate-options': UNSUPPORTED,
  'indices': UNSUPPORTED,
  'bad-max-len': UNSUPPORTED,
  'bad-flags': UNSUPPORTED,
  'unknown-type': UNSUPPORTED,
  'widget-placement': UNSUPPORTED,
  'structure': UNSUPPORTED,
  'not-a-field': UNSUPPORTED,
});

function freezeFieldSpec(spec: PdfFieldSpec): Readonly<PdfFieldSpec> {
  switch (spec.kind) {
    case 'radio': return Object.freeze({ ...spec, members: Object.freeze(spec.members.slice()) });
    case 'choice': return Object.freeze({ ...spec, options: Object.freeze(spec.options.slice()) });
    default: return Object.freeze({ ...spec });
  }
}

/**
 * The rule for one widget of a fillable field. Pure; `spec` arrays are copied and frozen. `field` is the key of the
 * terminal field node holding /V (the widget's own key when field and widget are merged).
 */
export function fieldRule(spec: PdfFieldSpec, field?: string): PdfFieldRule {
  const frozen = freezeFieldSpec(spec);
  const facts = field === undefined ? { spec: frozen } : { spec: frozen, field };
  switch (spec.kind) {
    case 'text': {
      const { maxLen, multiline } = spec;
      return Object.freeze({ kind: 'text', ...facts, check: (v: PdfFieldValue): string | null => {
        if (typeof v !== 'string') return 'The value does not fit the field.';
        // UTF-16 code units, as the browser's `maxLength` counts them: never more than the input allows.
        if (maxLen !== null && v.length > maxLen) return `This field takes at most ${maxLen} characters.`;
        if (!multiline && /[\r\n]/.test(v)) return 'This field takes a single line.';
        return null;
      } });
    }
    case 'checkbox':
      return Object.freeze({ kind: 'button', ...facts });
    case 'radio':
      return Object.freeze({ kind: 'button', ...facts,
        group: Object.freeze({ key: spec.group, members: Object.freeze(spec.members.slice()), exactlyOne: spec.noToggleToOff }) });
    case 'choice': {
      const options = Object.freeze(spec.options.slice());
      const index = new Map(options.map((o, i) => [o, i]));
      const { editable, multiSelect } = spec;
      return Object.freeze({ kind: 'choice', ...facts, check: (v: PdfFieldValue): string | null => {
        if (multiSelect) {
          if (!Array.isArray(v)) return 'The value does not fit the field.';
          // Distinct options in /Opt order: pdf.js derives /I from the values in that order.
          let last = -1;
          for (const s of v) {
            const i = index.get(s);
            if (i === undefined) return 'The value is not one of the field\'s options.';
            if (i <= last) return 'The selected options are repeated or out of order.';
            last = i;
          }
          return null;
        }
        if (typeof v !== 'string') return 'This field takes one value.';
        if (editable) return /[\r\n]/.test(v) ? 'This field takes a single line.' : null;
        return index.has(v) ? null : 'The value is not one of the field\'s options.';
      } });
    }
  }
}

/** Facts from classification (§6.2) that edits are validated against. */
export interface PdfEditContext {
  /** Boxes per page, index = 0-based page number; its length is the page count. */
  pages: readonly PdfPageBoxes[];
  /** Deletable pre-existing markup annotations: "num gen" -> facts. */
  deletable: ReadonlyMap<string, { page: number; popup?: string }>;
  /** Popup "num gen" -> its parent's "num gen"; removing a Popup removes its parent. */
  popups?: ReadonlyMap<string, string>;
  /** Fillable widgets: "num gen" -> rule. Empty while forms are off (classify without orms: true). */
  fields: ReadonlyMap<string, PdfFieldRule>;
  /** Widgets (and locked fields) that classification found NOT fillable, with the reason; refusals name it. */
  locked?: ReadonlyMap<string, PdfFieldLockReason>;
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
  | 'unknown-annotation' | 'not-deletable' | 'not-fillable' | 'field-locked' | 'bad-value' | 'duplicate-field';

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
 * Radio groups touched by a `setFields` op must be stated whole, with at most (or exactly) one on — and a CHANGE that
 * leaves a group with none on is refused (PWP-28): pdf.js writes the field's /V only when a button is turned on, so
 * turning the last one off leaves /V naming it while every widget shows Off, which readers disagree about (the
 * verifier refuses such output). Restating an all-off group that was loaded all off changes nothing and passes.
 */
function checkGroups(values: ReadonlyArray<{ ref: PdfObjRef; value: PdfFieldValue }>, ctx: PdfEditContext,
  changed: ReadonlySet<string>): string | null {
  const given = new Map<string, PdfFieldValue>();
  for (const { ref, value } of values) given.set(refKey(ref), value);
  const done = new Set<string>();
  for (const k of given.keys()) {
    const g = ctx.fields.get(k)?.group;
    if (!g || done.has(g.key)) continue;
    done.add(g.key);
    let on = 0;
    for (const m of g.members) {
      if (!given.has(m)) return 'A group of radio buttons must be set as a whole.';
      if (given.get(m) === true) on++;
    }
    if (on > 1) return 'Only one radio button of a group can be on.';
    if (g.exactlyOne && on !== 1) return 'One radio button of this group must stay on.';
    if (on === 0 && g.members.some((m) => changed.has(m))) return 'A group of radio buttons cannot be cleared here.';
  }
  return null;
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
      const label: PdfEditLabel = comment !== rec.spec.comment
        ? (color !== rec.spec.color ? 'Edit Comment and Colour' : 'Edit Comment') : 'Change Colour';
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
        if (!rule) {
          const why = ctx.locked?.get(key);
          return why ? refuse('field-locked', FIELD_LOCK_MESSAGES[why]) : refuse('not-fillable', 'This field cannot be filled.');
        }
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
      const groupMsg = checkGroups(op.values, ctx, new Set(delta.map((e) => String(e.key))));
      if (groupMsg) return refuse('bad-value', groupMsg);
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

