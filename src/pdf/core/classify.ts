// Classification of a PDF for editing (spec §6.2, §9.1–§9.3; plan PWP-16).
//
// Runs the first time Edit is turned on for a generation. From the strict reader's view of the file it
// decides whether the file may be edited at all (and if not, which `PdfReadOnlyReason`), and collects the
// facts edits are validated against (`PdfEditContext`, consumed by `state.ts`) and the facts the webview
// is told (`PdfEditInfo`):
//
//  - pages in page-tree order, with their object refs and the boxes and rotation pdf.js would use;
//  - per page, every /Annots entry (ref, subtype, Popup link) and which of them are DELETABLE: the
//    existing Highlight, Underline, StrikeOut, Squiggly, Text, Ink and FreeText annotations whose removal
//    pdf.js's writer can express without leaving a dangling reference (see `NOT_DELETABLE` below);
//  - the AcroForm facts (present, /XFA, /NeedAppearances, every terminal field with its type, flags and
//    widgets, and whether it is FILLABLE or locked with a `PdfFieldLockReason`) and signature facts
//    (signed fields, /Perms). Fillable widgets get the value rules of spec §8.5 (`state.fieldRule`).
//    With `options.forms` off (the default, = `PDF_FLAGS.pdfForms` false) `context.fields` stays empty
//    and `info.forms.reason` is 'flag-off' (plan PWP-27).
//
// Refuse rather than guess: any structure this module does not fully understand makes the file view-only
// (`unsupported-structure`), never editable on a best guess. Work is LAZY (spike S4): only the catalog,
// the page tree, the annotations, the Popups they point to and the AcroForm field tree are read. Results
// and `detail` strings carry codes and object numbers only, never document content.
//
// No `vscode` import, no npm package (core rule 1).

import type { PdfEditInfo, PdfObjRef, PdfReadOnlyReason } from '../protocol.js';
import { openPdf, openPdfSync, PdfReadError } from './reader.js';
import type { PdfArray, PdfDict, PdfFile, PdfReadErrorCode, PdfStream, PdfValue, ReaderLimits, XrefKind } from './reader.js';
import { normalizeRotation } from './geometry.js';
import type { PdfBox, PdfPageBoxes } from './geometry.js';
import { fieldRule, refKey } from './state.js';
import type { PdfEditContext, PdfFieldLockReason, PdfFieldRule } from './state.js';
import { decodeTextString } from './verify.js';
import { PDF_LIMITS } from './limits.js';

// ---------------------------------------------------------------- policy tables

/** The read-only reasons classification can produce. */
export type PdfClassifyReason = Extract<PdfReadOnlyReason, 'too-large' | 'encrypted' | 'unsupported-structure'>;

/**
 * Strict-reader refusal -> read-only reason. THE one place that decides what a reader error means for
 * editing. Classification adds no refusal of its own for hybrid-reference files (/XRefStm, e.g. Word
 * "Save as PDF"): the user decided (2026-11-21) they should be editable, and a separate package teaches
 * the reader to open well-formed hybrids. Until then the reader throws `hybrid`, mapped below; once it
 * no longer does, only malformed hybrids reach this row (and stay view-only).
 */
export const READ_ERROR_REASON: Readonly<Record<PdfReadErrorCode, PdfClassifyReason>> = Object.freeze({
  'no-header': 'unsupported-structure',
  'no-startxref': 'unsupported-structure',
  'bad-xref': 'unsupported-structure',     // damaged cross-references are never repaired (§3.3)
  'prev-cycle': 'unsupported-structure',
  'hybrid': 'unsupported-structure',       // see above: becomes rare once the reader accepts hybrids
  'encrypted': 'encrypted',                // §9.1: all encrypted files are view-only
  'objstm': 'unsupported-structure',
  'too-large': 'unsupported-structure',    // a §9.3 strict-reader cap, not the file-size limit
  'malformed': 'unsupported-structure',
});

/** Subtypes whose existing annotations may be deleted (spec §6.2), with their Popups. */
export const DELETABLE_SUBTYPES: ReadonlySet<string> = new Set([
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', 'Ink', 'FreeText',
]);

/**
 * Why an annotation of the page is not deletable.
 *  - `subtype`: not one of `DELETABLE_SUBTYPES` (links, widgets, Popups themselves, stamps ...).
 *  - `inline`: written directly in /Annots (no object number; pdf.js cannot address it).
 *  - `dangling`: the reference resolves to nothing, or to something that is not a dictionary.
 *  - `shared`: the same object is listed more than once in /Annots, on one page or across pages.
 *  - `locked`: /F has the Locked (128) or ReadOnly (64) flag.
 *  - `bad-popup`: /Popup is not a reference to a Popup annotation whose /Parent (if any) is this one,
 *    or the Popup is shared with another annotation, or listed on a different page / more than once.
 *  - `group-reply`: /RT /Group — pdf.js takes the Popup of the /IRT target for it, so deleting it
 *    would free the other annotation's Popup.
 *  - `has-replies`: another annotation's /IRT points at it; deleting it would orphan the replies.
 *  - `other-page`: its /P names a different page than the one listing it.
 */
export type PdfNotDeletableReason =
  | 'subtype' | 'inline' | 'dangling' | 'shared' | 'locked' | 'bad-popup' | 'group-reply' | 'has-replies' | 'other-page';

/** Annotation flags (ISO 32000-1 table 165). */
const F_READONLY = 64;
const F_LOCKED = 128;

/** Annotations across the document beyond this are not classified (`unsupported-structure`). */
export const MAX_ANNOTATIONS = 200_000;
/** AcroForm field-tree nodes beyond this, or deeper than `MAX_FIELD_DEPTH`, are refused. */
export const MAX_FIELD_NODES = 200_000;
export const MAX_FIELD_DEPTH = 64;
/** Page-tree depth beyond this is refused (pdf.js gives up far earlier on real files). */
export const MAX_TREE_DEPTH = 64;

// ---------------------------------------------------------------- result types

export interface PdfAnnotFact {
  /** Object ref; null for an annotation dictionary written inline in /Annots. */
  ref: PdfObjRef | null;
  /** /Subtype; null when missing, not a name, or the entry is not a dictionary. */
  subtype: string | null;
  /** "num gen" of its /Popup (markup annotations), when it is a reference. */
  popup?: string;
  /** For a Popup annotation: "num gen" of its /Parent, when it is a reference. */
  parent?: string;
  deletable: boolean;
  /** Set when `deletable` is false. */
  why?: PdfNotDeletableReason;
}

export interface PdfPageFact extends PdfPageBoxes {
  ref: PdfObjRef;
  /** Every /Annots entry, in order. */
  annots: PdfAnnotFact[];
}

export interface PdfSignatureFacts {
  /** Terminal fields of type /Sig. */
  signatureFields: number;
  /** ... of which carry a value (a signature dictionary). */
  signedFields: number;
  /** The catalog's /Perms has /DocMDP (a certified document). */
  docMdp: boolean;
  /** /P of the DocMDP transform (1 = no changes allowed, 2 = forms and signing, 3 = also annotations); null if not found. */
  docMdpP: 1 | 2 | 3 | null;
  /** The catalog's /Perms has /UR3 or /UR (usage rights; a later revision invalidates them). */
  usageRights: boolean;
}

/** A terminal field's type as pdf.js would draw it. */
export type PdfFieldType = 'text' | 'checkbox' | 'radio' | 'push-button' | 'combo' | 'list' | 'signature' | 'unknown';

/**
 * One terminal field of the AcroForm tree (spec §6.2, §8.5). Refs, flags and counts only — no field
 * names, values or option texts (document content); the option list lives only inside the field's rule.
 */
export interface PdfFieldFact {
  /** The terminal field node (for a merged field/widget, also its widget). */
  ref: PdfObjRef;
  type: PdfFieldType;
  /** Its widget annotations (pdf.js annotation ids), with the 0-based page listing each (null = none or several). */
  widgets: Array<{ ref: PdfObjRef; page: number | null }>;
  readOnly: boolean;
  /** Ff Required: reported for the UI; not a value rule (it is enforced on submission, which never happens here). */
  required: boolean;
  multiline: boolean;
  comb: boolean;
  /** Inherited /MaxLen when it is a positive integer. */
  maxLen: number | null;
  /** A list box with MultiSelect. */
  multiSelect: boolean;
  /** A combo box with Edit (free text allowed). */
  editable: boolean;
  /** Number of /Opt entries (choice fields). */
  options: number;
  /** /AA or a widget /A on the field, an ancestor or a widget. */
  scripts: boolean;
  /** The field or an ancestor is in the AcroForm /CO. */
  calculated: boolean;
  fillable: boolean;
  /** Set when `fillable` is false. */
  locked?: PdfFieldLockReason;
}

export interface PdfFormFacts {
  acroForm: boolean;
  xfa: boolean;
  /** Terminal fields found in the field tree (all types). */
  terminalFields: number;
  /** The AcroForm has /NeedAppearances true. */
  needAppearances: boolean;
  /** Every terminal field, in field-tree order. */
  fields: PdfFieldFact[];
  /** Fields fillable by the value rules (independent of the `forms` option). */
  fillableFields: number;
  /** Fields with scripts (/AA or /A) or in /CO — drives the "This form uses scripts" notice. */
  scriptedFields: number;
}

export interface PdfStructureFacts {
  xrefKind: XrefKind;
  revisions: number;
  size: number;
  objectCount: number;
  headerVersion: string;
}

export interface PdfEditableClassification {
  editable: true;
  pages: PdfPageFact[];
  /** What `state.ts` validates edits against. */
  context: PdfEditContext;
  /** What the webview is told (`pdfEditInfo`). */
  info: PdfEditInfo;
  signatures: PdfSignatureFacts;
  forms: PdfFormFacts;
  structure: PdfStructureFacts;
}

export interface PdfReadOnlyClassification {
  editable: false;
  reason: PdfClassifyReason;
  /** A code for logs and tests (`reader:hybrid`, `page-tree`, `pages-over-limit` ...); no document content. */
  detail: string;
}

export type PdfClassification = PdfEditableClassification | PdfReadOnlyClassification;

export interface ClassifyOptions {
  /** Edit limits of spec §9.3 (tests lower them). */
  maxEditFileBytes?: number;
  maxEditPages?: number;
  /** Strict-reader caps and yielding parameters. */
  reader?: Partial<ReaderLimits>;
  /**
   * `PDF_FLAGS.pdfForms` (core cannot import the flags). Off (default): `context.fields` is empty and
   * `info.forms.reason` is 'flag-off'; the field facts are collected either way.
   */
  forms?: boolean;
}

// ---------------------------------------------------------------- errors

/** A structure classification refuses; becomes `{ editable: false, reason, detail }`. */
class Refusal extends Error {
  constructor(readonly reason: PdfClassifyReason, readonly detail: string) { super(detail); }
}
function refuse(detail: string, reason: PdfClassifyReason = 'unsupported-structure'): never {
  throw new Refusal(reason, detail);
}

function toReadOnly(e: unknown): PdfReadOnlyClassification {
  if (e instanceof Refusal) return { editable: false, reason: e.reason, detail: e.detail };
  if (e instanceof PdfReadError) return { editable: false, reason: READ_ERROR_REASON[e.code] ?? 'unsupported-structure', detail: `reader:${e.code}` };
  // A bug, or input this module did not anticipate: refusing to edit is the safe failure.
  return { editable: false, reason: 'unsupported-structure', detail: 'internal' };
}

// ---------------------------------------------------------------- entry points

/**
 * Classify `bytes` for editing. Never rejects: every failure is a read-only result. For files over the
 * reader's `asyncParseThresholdBytes` it yields to the event loop every `yieldIntervalMs`.
 */
export async function classify(bytes: Uint8Array, options: ClassifyOptions = {}): Promise<PdfClassification> {
  try {
    const early = sizeCheck(bytes, options);
    if (early) return early;
    const file = await openPdf(bytes, options.reader);
    const steps = run(file, options);
    const yielding = bytes.length > (options.reader?.asyncParseThresholdBytes ?? PDF_LIMITS.asyncParseThresholdBytes);
    const interval = options.reader?.yieldIntervalMs ?? PDF_LIMITS.yieldIntervalMs;
    let slice = performance.now();
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      if (yielding && performance.now() - slice >= interval) {
        await new Promise<void>((res) => setImmediate(res));
        slice = performance.now();
      }
    }
  } catch (e) {
    return toReadOnly(e);
  }
}

/** `classify` without yielding (small files, tests). */
export function classifySync(bytes: Uint8Array, options: ClassifyOptions = {}): PdfClassification {
  try {
    const early = sizeCheck(bytes, options);
    if (early) return early;
    const steps = run(openPdfSync(bytes, options.reader), options);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  } catch (e) {
    return toReadOnly(e);
  }
}

function sizeCheck(bytes: Uint8Array, o: ClassifyOptions): PdfReadOnlyClassification | null {
  if (bytes.length > (o.maxEditFileBytes ?? PDF_LIMITS.maxEditFileBytes)) {
    return { editable: false, reason: 'too-large', detail: 'file-over-limit' };
  }
  return null;
}

// ---------------------------------------------------------------- value helpers

type Val = PdfValue | PdfStream | null | undefined;

function asDict(v: Val): PdfDict | null { return v && v.kind === 'dict' ? v : null; }
function asArray(v: Val): PdfArray | null { return v && v.kind === 'array' ? v : null; }
function nameOf(v: Val): string | null { return v && v.kind === 'name' ? v.value : null; }
function numOf(v: Val): number | null { return v && v.kind === 'number' ? v.value : null; }
function isNull(v: Val): boolean { return v === undefined || v === null || v.kind === 'null'; }
function key(r: { num: number; gen: number }): string { return refKey({ num: r.num, gen: r.gen }); }

// ---------------------------------------------------------------- field-tree helpers

/** Entries inherited down the field tree (raw values, dereferenced when used) and sticky facts. */
interface FieldInherited {
  ft: Val; ff: Val; v: Val; maxLen: Val; opt: Val;
  rich: boolean; scripts: boolean; calculated: boolean; indices: boolean; barcode: boolean;
  /** An ancestor (not the node itself) carries /I. */
  indicesUp: boolean;
  /** A /Parent link in the chain disagrees with the Kids walk. */
  bad: boolean;
}
interface FieldNode {
  ref: { num: number; gen: number };
  key: string;
  dict: PdfDict;
  inh: FieldInherited;
  /** Kids without /T (its widgets); null when the node has no /Kids (a merged field/widget, or no widget). */
  kids: Array<{ ref: { num: number; gen: number }; dict: PdfDict }> | null;
}
/** Value-defining entries a separate widget must not carry (pdf.js would read them from the widget first). */
const SEPARATE_WIDGET_FORBIDDEN = ['T', 'FT', 'Ff', 'V', 'DV', 'MaxLen', 'Opt', 'RV'];
/** Radio groups larger than one `setFields` op can state (protocol `MAX_FIELDS_PER_SET`) are locked. */
export const MAX_RADIO_WIDGETS = 2_000;
/** Present and not null (a direct /Key null counts as absent). */
function present(v: PdfValue | undefined): boolean { return v !== undefined && v.kind !== 'null'; }

// ---------------------------------------------------------------- the walk

interface Candidate {
  fact: PdfAnnotFact;
  key: string;
  page: number;
  dict: PdfDict;
}

function* run(file: PdfFile, o: ClassifyOptions): Generator<void, PdfClassification> {
  const maxPages = o.maxEditPages ?? PDF_LIMITS.maxEditPages;
  const D = (v: Val): Val => file.deref(v ?? undefined);

  // --- catalog
  const rootRef = file.trailer.entries.get('Root');
  if (!rootRef || rootRef.kind !== 'ref') refuse('catalog');
  const catalog = asDict(D(rootRef));
  if (!catalog || nameOf(catalog.entries.get('Type')) !== 'Catalog') refuse('catalog');

  // --- page tree: root /Count first, so an over-limit document is not walked at all
  const pagesRef = catalog.entries.get('Pages');
  if (!pagesRef || pagesRef.kind !== 'ref') refuse('page-tree');
  const pagesRoot = asDict(D(pagesRef));
  if (!pagesRoot || nameOf(pagesRoot.entries.get('Type')) !== 'Pages') refuse('page-tree');
  const rootCount = numOf(D(pagesRoot.entries.get('Count')));
  if (rootCount === null || !Number.isSafeInteger(rootCount) || rootCount < 0) refuse('page-count');
  if (rootCount > maxPages) refuse('pages-over-limit', 'too-large');
  if (rootCount === 0) refuse('no-pages');

  const pages: PdfPageFact[] = [];
  const pageDicts: PdfDict[] = [];                       // parallel to `pages`, for the annotation pass
  const pageKeys = new Map<string, number>();
  const visited = new Set<string>();
  const nodeCap = 2 * maxPages + 1000;

  interface Inherited { media: Val; crop: Val; rotate: Val }
  // Iterative depth-first walk in Kids order (= pdf.js page order); each kid's /Parent must be the node
  // listing it, so inheritance along the walk equals pdf.js's inheritance along /Parent.
  type Frame = { ref: { num: number; gen: number }; dict: PdfDict; inh: Inherited; kids: PdfValue[]; i: number; leavesBefore: number; count: number; depth: number };
  const rootK = key(pagesRef);
  visited.add(rootK);
  const rootInh: Inherited = inherit({ media: undefined, crop: undefined, rotate: undefined }, pagesRoot);
  if (pagesRoot.entries.has('Annots')) refuse('page-tree-annots');
  const stack: Frame[] = [frameFor(pagesRef, pagesRoot, rootInh, 0, 0)];

  function frameFor(ref: { num: number; gen: number }, dict: PdfDict, inh: Inherited, leavesBefore: number, depth: number): Frame {
    const kids = asArray(D(dict.entries.get('Kids')));
    if (!kids) refuse('page-tree');
    const count = numOf(D(dict.entries.get('Count')));
    if (count === null || !Number.isSafeInteger(count) || count < 0) refuse('page-count');
    return { ref, dict, inh, kids: kids.items, i: 0, leavesBefore, count, depth };
  }
  function inherit(parent: Inherited, d: PdfDict): Inherited {
    return {
      media: d.entries.has('MediaBox') ? d.entries.get('MediaBox') : parent.media,
      crop: d.entries.has('CropBox') ? d.entries.get('CropBox') : parent.crop,
      rotate: d.entries.has('Rotate') ? d.entries.get('Rotate') : parent.rotate,
    };
  }

  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i >= f.kids.length) {
      if (pages.length - f.leavesBefore !== f.count) refuse('page-count');
      stack.pop();
      continue;
    }
    const kidRef = f.kids[f.i++];
    if (kidRef.kind !== 'ref') refuse('page-tree');
    const k = key(kidRef);
    if (visited.has(k)) refuse('page-tree-cycle');
    visited.add(k);
    if (visited.size > nodeCap) refuse('page-tree');
    const kid = asDict(D(kidRef));
    if (!kid) refuse('page-tree');
    const parent = kid.entries.get('Parent');
    if (!parent || parent.kind !== 'ref' || parent.num !== f.ref.num || parent.gen !== f.ref.gen) refuse('page-tree-parent');
    const type = nameOf(kid.entries.get('Type'));
    const inh = inherit(f.inh, kid);
    if (kid.entries.has('Kids')) {
      if (type !== 'Pages') refuse('page-tree');
      if (kid.entries.has('Annots')) refuse('page-tree-annots'); // pdf.js would inherit them
      if (f.depth + 1 > MAX_TREE_DEPTH) refuse('page-tree-depth');
      stack.push(frameFor(kidRef, kid, inh, pages.length, f.depth + 1));
      continue;
    }
    if (type !== 'Page') refuse('page-tree');
    if (pages.length >= rootCount) refuse('page-count');
    const boxes = pageBoxes(inh, D);
    pageKeys.set(k, pages.length);
    pages.push({ ref: { num: kidRef.num, gen: kidRef.gen }, ...boxes, annots: [] });
    pageDicts.push(kid);
    yield;
  }
  if (pages.length !== rootCount) refuse('page-count');

  // --- annotations
  const occurrences = new Map<string, number[]>();        // ref key -> pages listing it (with repeats)
  const annotDicts = new Map<string, PdfDict | null>();   // ref key -> resolved dictionary (null = dangling)
  const candidates: Candidate[] = [];
  const irtTargets = new Set<string>();
  let total = 0;
  for (let p = 0; p < pages.length; p++) {
    const raw = pageDicts[p].entries.get('Annots');
    if (raw === undefined) continue;
    const arr = D(raw);
    if (isNull(arr)) {
      if (raw.kind === 'ref') refuse('annots'); // a dangling /Annots reference
      continue;
    }
    const list = asArray(arr);
    if (!list) refuse('annots');
    total += list.items.length;
    if (total > MAX_ANNOTATIONS) refuse('too-many-annotations');
    for (const item of list.items) {
      const fact: PdfAnnotFact = { ref: null, subtype: null, deletable: false };
      pages[p].annots.push(fact);
      let dict: PdfDict | null;
      if (item.kind === 'ref') {
        const k = key(item);
        fact.ref = { num: item.num, gen: item.gen };
        const occ = occurrences.get(k);
        if (occ) occ.push(p); else occurrences.set(k, [p]);
        if (!annotDicts.has(k)) annotDicts.set(k, asDict(D(item)));
        dict = annotDicts.get(k)!;
        if (!dict) { fact.why = 'dangling'; continue; }
      } else {
        dict = asDict(item);
        fact.why = 'inline';
        if (!dict) continue;
      }
      fact.subtype = nameOf(dict.entries.get('Subtype'));
      const pop = dict.entries.get('Popup');
      if (pop && pop.kind === 'ref') fact.popup = key(pop);
      const par = dict.entries.get('Parent');
      if (fact.subtype === 'Popup' && par && par.kind === 'ref') fact.parent = key(par);
      const irt = dict.entries.get('IRT');
      if (irt && irt.kind === 'ref') irtTargets.add(key(irt));
      if (fact.why) continue; // inline
      if (!fact.subtype || !DELETABLE_SUBTYPES.has(fact.subtype)) { fact.why = 'subtype'; continue; }
      candidates.push({ fact, key: key(item as { num: number; gen: number }), page: p, dict });
    }
    yield;
  }

  // Popups referenced by more than one candidate.
  const popupUsers = new Map<string, number>();
  for (const c of candidates) {
    const pop = c.dict.entries.get('Popup');
    if (pop && pop.kind === 'ref') popupUsers.set(key(pop), (popupUsers.get(key(pop)) ?? 0) + 1);
  }

  const deletable = new Map<string, { page: number; popup?: string }>();
  const popups = new Map<string, string>();
  const deletableRefs: PdfObjRef[] = [];
  for (const c of candidates) {
    const why = notDeletable(c);
    if (why) { c.fact.why = why; continue; }
    c.fact.deletable = true;
    const entry: { page: number; popup?: string } = { page: c.page };
    if (c.fact.popup) { entry.popup = c.fact.popup; popups.set(c.fact.popup, c.key); }
    deletable.set(c.key, entry);
    deletableRefs.push(c.fact.ref!);
  }

  function notDeletable(c: Candidate): PdfNotDeletableReason | null {
    const occ = occurrences.get(c.key)!;
    if (occ.length !== 1) return 'shared';
    const flags = numOf(D(c.dict.entries.get('F')));
    if (flags !== null && Number.isInteger(flags) && (flags & (F_LOCKED | F_READONLY)) !== 0) return 'locked';
    const pRef = c.dict.entries.get('P');
    if (pRef !== undefined && pRef.kind === 'ref' && pageKeys.has(key(pRef)) && pageKeys.get(key(pRef)) !== c.page) return 'other-page';
    if (c.dict.entries.has('IRT') && nameOf(D(c.dict.entries.get('RT'))) === 'Group') return 'group-reply';
    if (irtTargets.has(c.key)) return 'has-replies';
    if (c.dict.entries.has('Popup')) {
      const pop = c.dict.entries.get('Popup')!;
      if (pop.kind === 'null') return null;
      if (pop.kind !== 'ref') return 'bad-popup';
      const pk = key(pop);
      if (pk === c.key || (popupUsers.get(pk) ?? 0) !== 1) return 'bad-popup';
      if (!annotDicts.has(pk)) annotDicts.set(pk, asDict(D(pop)));
      const pd = annotDicts.get(pk);
      if (!pd || nameOf(pd.entries.get('Subtype')) !== 'Popup') return 'bad-popup';
      const parent = pd.entries.get('Parent');
      if (parent !== undefined && (parent.kind !== 'ref' || key(parent) !== c.key)) return 'bad-popup';
      const pocc = occurrences.get(pk);
      if (pocc && (pocc.length !== 1 || pocc[0] !== c.page)) return 'bad-popup';
    }
    return null;
  }
  yield;

  // --- AcroForm and signatures
  const forms: PdfFormFacts = { acroForm: false, xfa: false, terminalFields: 0, needAppearances: false, fields: [], fillableFields: 0, scriptedFields: 0 };
  const signatures: PdfSignatureFacts = { signatureFields: 0, signedFields: 0, docMdp: false, docMdpP: null, usageRights: false };
  const fieldRules = new Map<string, PdfFieldRule>();      // widget key -> rule (fillable widgets)
  const lockedKeys = new Map<string, PdfFieldLockReason>(); // widget and field keys of locked fields
  const terminals: FieldNode[] = [];
  const calcOrder = new Set<string>();
  const acro = D(catalog.entries.get('AcroForm'));
  if (!isNull(acro)) {
    const af = asDict(acro);
    if (!af) refuse('acroform');
    forms.acroForm = true;
    forms.xfa = !isNull(D(af.entries.get('XFA')));
    const na = D(af.entries.get('NeedAppearances'));
    forms.needAppearances = !!na && na.kind === 'bool' && na.value;
    const co = asArray(D(af.entries.get('CO')));
    if (co) for (const it of co.items) if (it.kind === 'ref') calcOrder.add(key(it));
    walkFields(af);
  }
  yield;
  assessFields();
  const perms = D(catalog.entries.get('Perms'));
  if (!isNull(perms)) {
    const pd = asDict(perms);
    if (!pd) refuse('perms');
    signatures.usageRights = !isNull(D(pd.entries.get('UR3'))) || !isNull(D(pd.entries.get('UR')));
    const mdp = D(pd.entries.get('DocMDP'));
    if (!isNull(mdp)) {
      signatures.docMdp = true;
      signatures.docMdpP = docMdpP(asDict(mdp));
    }
  }

  /**
   * Walk the field tree from /Fields in Kids order. Kids that carry /T are child fields; kids without /T
   * are the field's widgets. Inheritable entries (FT, Ff, V, MaxLen, Opt) are carried down the walk, as
   * pdf.js reads them up the /Parent chain — the two agree only when every child's /Parent is the node
   * listing it, so a mismatch marks the subtree `bad` (locked, never guessed).
   */
  function walkFields(af: PdfDict): void {
    const fieldsVal = D(af.entries.get('Fields'));
    if (isNull(fieldsVal)) return;
    const roots = asArray(fieldsVal);
    if (!roots) refuse('acroform');
    const seen = new Set<string>();
    type W = { v: PdfValue; parent: string | null; inh: FieldInherited; depth: number };
    const rootInh: FieldInherited = { ft: undefined, ff: undefined, v: undefined, maxLen: undefined, opt: undefined,
      rich: false, scripts: false, calculated: false, indices: false, indicesUp: false, barcode: false, bad: false };
    const work: W[] = [];
    for (let i = roots.items.length - 1; i >= 0; i--) work.push({ v: roots.items[i], parent: null, inh: rootInh, depth: 0 });
    while (work.length) {
      const { v, parent, inh: up, depth } = work.pop()!;
      if (depth > MAX_FIELD_DEPTH) refuse('acroform');
      if (v.kind !== 'ref') refuse('acroform');
      const k = key(v);
      if (seen.has(k)) refuse('acroform');
      seen.add(k);
      if (seen.size > MAX_FIELD_NODES) refuse('acroform');
      const d = asDict(D(v));
      if (!d) refuse('acroform');
      const e = d.entries;
      const par = e.get('Parent');
      const inh: FieldInherited = {
        ft: e.has('FT') ? e.get('FT') : up.ft,
        ff: e.has('Ff') ? e.get('Ff') : up.ff,
        v: e.has('V') ? e.get('V') : up.v,
        maxLen: e.has('MaxLen') ? e.get('MaxLen') : up.maxLen,
        opt: e.has('Opt') ? e.get('Opt') : up.opt,
        rich: up.rich || present(e.get('RV')),
        scripts: up.scripts || present(e.get('AA')),
        calculated: up.calculated || calcOrder.has(k),
        indices: up.indices || present(e.get('I')),
        indicesUp: up.indices,
        barcode: up.barcode || present(e.get('PMD')),
        bad: up.bad || (parent === null ? par !== undefined && par.kind !== 'null' : !(par && par.kind === 'ref' && key(par) === parent)),
      };
      const kidsVal = e.has('Kids') ? D(e.get('Kids')) : null;
      const kids = isNull(kidsVal) ? null : asArray(kidsVal);
      if (!isNull(kidsVal) && !kids) refuse('acroform');
      const childFields: PdfValue[] = [];
      const widgetKids: Array<{ ref: { num: number; gen: number }; dict: PdfDict }> = [];
      if (kids) {
        for (const kid of kids.items) {
          if (kid.kind !== 'ref') refuse('acroform');
          const kd = asDict(D(kid));
          if (!kd) refuse('acroform');
          if (kd.entries.has('T')) childFields.push(kid);
          else widgetKids.push({ ref: { num: kid.num, gen: kid.gen }, dict: kd });
        }
      }
      if (childFields.length === 0) {
        forms.terminalFields++;
        const ft = nameOf(D(inh.ft));
        if (ft === 'Sig') {
          signatures.signatureFields++;
          if (asDict(D(inh.v))) signatures.signedFields++;
        }
        terminals.push({ ref: { num: v.num, gen: v.gen }, key: k, dict: d, inh, kids: kids ? widgetKids : null });
        continue;
      }
      // Widgets of a node that also has child fields are not a field's widgets: they stay `not-a-field`.
      for (let i = childFields.length - 1; i >= 0; i--) work.push({ v: childFields[i], parent: k, inh, depth: depth + 1 });
    }
  }

  /**
   * Decide, per terminal field, whether it is fillable (spec §8.5) and with which value rule, or why not.
   * The first reason in the order below wins; facts are collected either way.
   */
  function assessFields(): void {
    // How many terminal fields claim each widget (a widget shared between fields is never fillable).
    const claims = new Map<string, number>();
    const widgetsOf = new Map<FieldNode, Array<{ ref: { num: number; gen: number }; key: string; dict: PdfDict }>>();
    for (const t of terminals) {
      const ws = t.kids !== null
        ? t.kids.map((w) => ({ ref: w.ref, key: key(w.ref), dict: w.dict }))
        : nameOf(t.dict.entries.get('Subtype')) === 'Widget' ? [{ ref: t.ref, key: t.key, dict: t.dict }] : [];
      widgetsOf.set(t, ws);
      for (const w of ws) claims.set(w.key, (claims.get(w.key) ?? 0) + 1);
    }
    for (const t of terminals) {
      const ws = widgetsOf.get(t)!;
      const fact = assessField(t, ws, claims);
      forms.fields.push(fact);
      if (fact.scripts || fact.calculated) forms.scriptedFields++;
      if (fact.fillable) forms.fillableFields++;
    }
  }

  function assessField(t: FieldNode, ws: Array<{ ref: { num: number; gen: number }; key: string; dict: PdfDict }>,
    claims: ReadonlyMap<string, number>): PdfFieldFact {
    const inh = t.inh;
    const ft = nameOf(D(inh.ft));
    const ffVal = D(inh.ff);
    const ffOk = isNull(ffVal) || (!!ffVal && ffVal.kind === 'number' && Number.isSafeInteger(ffVal.value) && ffVal.value >= 0 && ffVal.value <= 0xFFFFFFFF);
    const ff = ffOk && ffVal && ffVal.kind === 'number' ? ffVal.value : 0;
    const bit = (n: number): boolean => Math.floor(ff / 2 ** n) % 2 === 1; // bit n (0-based); Ff may exceed 2^31
    const push = bit(16), radio = !push && bit(15);
    const combo = bit(17);
    const type: PdfFieldType = ft === 'Sig' ? 'signature' : ft === 'Tx' ? 'text'
      : ft === 'Btn' ? (push ? 'push-button' : radio ? 'radio' : 'checkbox')
      : ft === 'Ch' ? (combo ? 'combo' : 'list') : 'unknown';
    const mlRaw = D(inh.maxLen);
    const maxLenOk = isNull(mlRaw) || (!!mlRaw && mlRaw.kind === 'number' && Number.isSafeInteger(mlRaw.value) && mlRaw.value > 0);
    const maxLen = maxLenOk && mlRaw && mlRaw.kind === 'number' ? mlRaw.value : null;
    const multiline = type === 'text' && bit(12);
    const comb = type === 'text' && bit(24);
    const multiSelect = type === 'list' && bit(21);
    const editable = type === 'combo' && bit(18);

    // Widgets: a separate widget must be a Widget annotation whose /Parent is the field and which carries
    // none of the value-defining entries (pdf.js reads them from the widget first, so they would override).
    let structure = inh.bad;
    let scripts = inh.scripts;
    // /I (choice indices) is fillable only on a merged field/widget that carries it itself (PWP-28): pdf.js
    // rewrites /I there from the new value and /Opt order (the verifier checks it), but leaves an /I on a separate
    // field node or an ancestor stale next to the new /V.
    const merged = t.kids === null && ws.length === 1 && ws[0].key === t.key;
    let indices = inh.indicesUp || (present(t.dict.entries.get('I')) && !merged);
    let barcode = inh.barcode;
    let placement = false;
    const widgets: PdfFieldFact['widgets'] = [];
    for (const w of ws) {
      const we = w.dict.entries;
      if (w.key !== t.key) {
        const par = we.get('Parent');
        if (nameOf(we.get('Subtype')) !== 'Widget' || !par || par.kind !== 'ref' || key(par) !== t.key || we.has('Kids')
          || SEPARATE_WIDGET_FORBIDDEN.some((k) => we.has(k))) structure = true;
        if (present(we.get('AA'))) scripts = true;
        if (present(we.get('I'))) indices = true;
        if (present(we.get('PMD'))) barcode = true;
      }
      if (present(we.get('A')) && !push) scripts = true;
      const occ = occurrences.get(w.key);
      if ((claims.get(w.key) ?? 0) !== 1 || !occ || occ.length !== 1) placement = true;
      widgets.push({ ref: w.ref, page: occ && occ.length === 1 ? occ[0] : null });
    }
    if (ws.length === 0) structure = true;

    // Type-specific facts.
    let options: string[] = [];
    let optionsBad = false;
    if (type === 'combo' || type === 'list') {
      const opt = D(inh.opt);
      if (!isNull(opt)) {
        const arr = asArray(opt);
        if (!arr) optionsBad = true;
        else for (const it of arr.items) {
          const o = D(it);
          const ex = o && o.kind === 'array' && o.items.length === 2 ? D(o.items[0]) : o;
          const disp = o && o.kind === 'array' && o.items.length === 2 ? D(o.items[1]) : o;
          if (!ex || ex.kind !== 'string' || !disp || disp.kind !== 'string') { optionsBad = true; break; }
          options.push(decodeTextString(ex.bytes));
        }
      }
      if (optionsBad) options = [];
    }
    const onStates = (type === 'checkbox' || type === 'radio') ? ws.map((w) => onStateOf(w.dict)) : [];

    const locked = ((): PdfFieldLockReason | undefined => {
      if (type === 'signature') return 'signature';
      if (forms.xfa) return 'xfa';
      if (structure || optionsBad) return 'structure';
      if (type === 'unknown') return 'unknown-type';
      if (placement) return 'widget-placement';
      if (!ffOk) return 'bad-flags';
      if (bit(0)) return 'read-only';
      if (scripts) return 'scripts';
      if (inh.calculated) return 'calculated';
      if (forms.needAppearances) return 'need-appearances';
      if (barcode) return 'barcode';
      switch (type) {
        case 'text':
          if (bit(13)) return 'password';
          if (bit(20)) return 'file-select';
          if (bit(25) || inh.rich) return 'rich-text';
          if (ws.length > 1) return 'multi-widget';
          if (!maxLenOk || (comb && maxLen === null)) return 'bad-max-len';
          if (comb && multiline) return 'bad-flags';
          return undefined;
        case 'push-button':
          return 'push-button';
        case 'checkbox':
          if (ws.length > 1) return 'multi-widget';
          return onStates[0] === null ? 'no-on-state' : onStates[0] === undefined ? 'ambiguous-on-state' : undefined;
        case 'radio': {
          if (ws.length > MAX_RADIO_WIDGETS) return 'structure';
          if (onStates.some((s) => s === null)) return 'no-on-state';
          if (onStates.some((s) => s === undefined) || new Set(onStates).size !== onStates.length) return 'ambiguous-on-state';
          return undefined;
        }
        case 'combo': case 'list':
          if (combo && bit(21)) return 'bad-flags';
          if (ws.length > 1) return 'multi-widget';
          if (indices) return 'indices';
          if (new Set(options).size !== options.length) return 'duplicate-options';
          if (options.length === 0 && !editable) return 'no-options';
          return undefined;
      }
    })();

    const fact: PdfFieldFact = {
      ref: t.ref, type, widgets, readOnly: bit(0), required: bit(1), multiline, comb: comb && !multiline && maxLen !== null,
      maxLen, multiSelect, editable, options: options.length, scripts, calculated: inh.calculated, fillable: locked === undefined,
    };
    if (locked) {
      fact.locked = locked;
      lockedKeys.set(t.key, locked);
      for (const w of ws) if (!lockedKeys.has(w.key) && !fieldRules.has(w.key)) lockedKeys.set(w.key, locked);
      return fact;
    }
    const members = ws.map((w) => w.key);
    const rule = type === 'text' ? fieldRule({ kind: 'text', maxLen, multiline, comb: fact.comb }, t.key)
      : type === 'checkbox' ? fieldRule({ kind: 'checkbox' }, t.key)
      : type === 'radio' ? fieldRule({ kind: 'radio', group: t.key, members, noToggleToOff: bit(14) }, t.key)
      : fieldRule({ kind: 'choice', options, editable, multiSelect }, t.key);
    for (const k of members) fieldRules.set(k, rule);
    return fact;
  }

  /** The widget's single on-state: its /AP /N state names other than Off. null = none, undefined = several. */
  function onStateOf(w: PdfDict): string | null | undefined {
    const ap = asDict(D(w.entries.get('AP')));
    const n = ap ? asDict(D(ap.entries.get('N'))) : null;
    if (!n) return null;
    const on = [...n.entries.keys()].filter((k) => k !== 'Off');
    return on.length === 0 ? null : on.length === 1 ? on[0] : undefined;
  }

  function docMdpP(sig: PdfDict | null): 1 | 2 | 3 | null {
    const refs = sig ? asArray(D(sig.entries.get('Reference'))) : null;
    if (!refs) return null;
    for (const item of refs.items) {
      const r = asDict(D(item));
      if (!r || nameOf(D(r.entries.get('TransformMethod'))) !== 'DocMDP') continue;
      const tp = asDict(D(r.entries.get('TransformParams')));
      if (!tp) return 2;
      const p = tp.entries.has('P') ? numOf(D(tp.entries.get('P'))) : 2;
      return p === 1 || p === 2 || p === 3 ? p : null;
    }
    return null;
  }

  const signed = signatures.signedFields > 0 || signatures.docMdp || signatures.usageRights;
  // Every widget annotation on a page that is not fillable is locked; one no terminal field claims is
  // `not-a-field` (pdf.js would still draw an input for it).
  const lockedFields: PdfObjRef[] = [];
  const listed = new Set<string>();
  for (const p of pages) {
    for (const a of p.annots) {
      if (!a.ref || a.subtype !== 'Widget') continue;
      const k = key(a.ref);
      if (fieldRules.has(k) || listed.has(k)) continue;
      listed.add(k);
      lockedFields.push(a.ref);
      if (!lockedKeys.has(k)) lockedKeys.set(k, 'not-a-field');
    }
  }
  const formsOn = o.forms === true;
  const formsInfo: PdfEditInfo['forms'] = !formsOn ? { editable: false, reason: 'flag-off', lockedFields: [] }
    : forms.xfa ? { editable: false, reason: 'xfa', lockedFields: [] }
    : fieldRules.size === 0 ? { editable: false, reason: 'none', lockedFields: [] }
    : { editable: true, lockedFields };
  const context: PdfEditContext = {
    pages: pages.map(({ mediaBox, cropBox, rotate }) => (cropBox ? { mediaBox, cropBox, rotate } : { mediaBox, rotate })),
    deletable,
    popups,
    fields: formsInfo.editable ? fieldRules : new Map(),
    locked: formsInfo.editable ? lockedKeys : new Map(),
  };
  const info: PdfEditInfo = {
    deletable: deletableRefs,
    forms: formsInfo,
    signed,
  };
  const structure: PdfStructureFacts = {
    xrefKind: file.xrefKind, revisions: file.revisions.length, size: file.size,
    objectCount: file.objectCount, headerVersion: file.headerVersion,
  };
  return { editable: true, pages, context, info, signatures, forms, structure };
}
/**
 * Boxes and rotation exactly as pdf.js derives them (`Page.mediaBox`, `Page.view`, `Page.rotate`):
 * an absent or invalid (not 4 finite numbers, or zero/negative extent) media box is US Letter; an
 * invalid crop box is ignored; a crop box not intersecting the media box is ignored; /Rotate that is
 * not a multiple of 90 is 0.
 */
function pageBoxes(inh: { media: Val; crop: Val; rotate: Val }, D: (v: Val) => Val): PdfPageBoxes {
  const box = (v: Val): PdfBox | null => {
    const a = asArray(D(v));
    if (!a || a.items.length !== 4) return null;
    const n: number[] = [];
    for (const it of a.items) {
      const x = numOf(D(it));
      if (x === null || !Number.isFinite(x)) return null;
      n.push(x);
    }
    const b = { x0: Math.min(n[0], n[2]), y0: Math.min(n[1], n[3]), x1: Math.max(n[0], n[2]), y1: Math.max(n[1], n[3]) };
    return b.x1 - b.x0 > 0 && b.y1 - b.y0 > 0 ? b : null;
  };
  const mediaBox = box(inh.media) ?? { x0: 0, y0: 0, x1: 612, y1: 792 };
  const crop = box(inh.crop);
  const rot = numOf(D(inh.rotate));
  const rotate = normalizeRotation(rot ?? 0);
  const out: PdfPageBoxes = { mediaBox, rotate };
  if (crop) {
    const x0 = Math.max(crop.x0, mediaBox.x0), y0 = Math.max(crop.y0, mediaBox.y0);
    const x1 = Math.min(crop.x1, mediaBox.x1), y1 = Math.min(crop.y1, mediaBox.y1);
    if (x1 - x0 > 0 && y1 - y0 > 0) out.cropBox = crop;
  }
  return out;
}
