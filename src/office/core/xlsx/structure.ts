// Insert/delete rows and columns, Tier A (spec §9.6; plan WP-38).
//
// insertOrDelete(b, wb, sheet, axis, at, count) inserts `count` (> 0) or deletes `-count` (< 0) rows or
// columns at the 0-based index `at` of `sheet`, recording every change through the EditBuilder (applied
// as recorded, so undo/redo are exact — §13.2 G5). The caller (ops.ts) has already run the WP-39 guards
// and adds the calc handling (§9.5) to the same edit. Anything this module cannot update correctly is
// refused (an Error carrying `officeError`, nothing written), never guessed (§10.1).
//
// The operation is planned completely before anything is written (every formula shifted, every range
// computed, every refusal raised), then written in one synchronous pass; a failure while writing
// aborts the builder and rebuilds the sheet indexes from the restored trees before rethrowing.
//
// What is updated (Tier A):
//  Edited sheet
//   sheetData           one `node` change per row that changes: the row replaced by its rewritten text
//                       (built from the source text, so only what moves or changes differs — G4), or
//                       removed with the whitespace node before it; or, when many rows change in a tall
//                       sheet (PER_ROW_BUDGET), one `node` change replacing sheetData with the same text
//                       (a per-row change locates its row by a search of the children: quadratic then).
//                       Per-attribute changes would cost a node-path walk per cell; a whole-part change
//                       would orphan the Sheet's tree. Inside a row: row/@r, c/@r, `spans` removed
//                       from every row on column operations, formulas shifted (references to this sheet,
//                       unqualified or qualified), array / data-table `f/@ref` (moved whole; a range
//                       that would grow, shrink or split is refused — Tier B), data-table `r1`/`r2`.
//                       Deleted rows/cells are dropped with the whitespace node before them. New
//                       rows/columns are simply absent: empty and unstyled.
//   shared formulas     (§9.4) a group whose members all move by the same offset and whose shifted
//                       master still yields every dependant's shifted formula is kept (master text and
//                       `ref` shifted); any other affected group is materialised (each surviving member
//                       gets its explicit shifted formula; t/si/ref dropped). A sheet with a malformed
//                       group (no master, several masters for one si, a member outside the master's ref)
//                       is refused.
//   dimension/@ref      shifted; "A1" when everything it covered was deleted.
//   sheetView           pane/@topLeftCell, selection/@activeCell (a deleted cell moves to the first
//                       row/column after the band; pushed off -> last row/column), selection/@sqref
//                       (all deleted -> the active cell). Frozen panes (state frozen/frozenSplit) also
//                       shift xSplit/ySplit as the frozen band [0, split-1]; deleting every frozen
//                       row/column is refused. [WP-37]
//   cols                column operations: min/max shifted, a range the insertion point falls inside is
//                       split (new columns unstyled), ranges shrink, a wholly deleted one is removed,
//                       `cols` removed when empty; on delete, the two halves of a split range that become
//                       adjacent again with identical attributes are joined (so insert -> delete
//                       restores the text). max is clamped to XFD.
//   mergeCells          shift/grow/shrink; a merge wholly deleted or reduced to one cell is removed,
//                       @count corrected, the element removed when empty.
//   autoFilter, sortState  @ref (removed when wholly deleted); filterColumn/@colId follows its column on
//                       column operations (removed when its column is deleted); sortCondition/@ref.
//   hyperlinks          hyperlink/@ref (removed when deleted; element removed when empty). `location`
//                       strings are not rewritten (Excel does not either). [WP-37]
//   conditionalFormatting  @sqref (removed when wholly deleted); cfRule `formula` children and formula
//                       `cfvo/@val`s shifted. Their relative references are relative to the top-left
//                       cell of the first range: when that cell is deleted the formula is first
//                       translated to the new anchor (each remaining cell keeps its rule), then shifted.
//   dataValidations     dataValidation/@sqref, formula1/formula2 (anchored as above), @count, element
//                       removed when empty.
//   protectedRanges, ignoredErrors  @sqref; entries removed when wholly deleted, containers when empty.
//   rowBreaks/colBreaks brk/@id on the operation's axis (a break belongs to the row/column after it;
//                       removed when that row/column is deleted), @count / @manualBreakCount. [WP-37]
//   Refused when present: customSheetViews, scenarios, dataConsolidate, cellWatches, smartTags,
//   webPublishItems (cell references this module does not rewrite).
//  Every other worksheet  formulas that reference the edited sheet qualified (prefilter: text with '!'),
//                       including shared groups (kept when the shifted master still yields every
//                       dependant, else materialised) and conditional-format / data-validation
//                       formulas; one `node` change per rewritten `c` / `formula` element. A sheet that
//                       cannot be read is refused; one that must be rewritten but is not editable too.
//  workbook.xml         definedNames (Print_Area, Print_Titles, _FilterDatabase included): `node`
//                       change per changed name.
//  Tables on the sheet  table/@ref, its autoFilter/@ref and sortState refs as `attr` changes. Column
//                       operations that intersect a table's columns, row deletions that hit a header or
//                       totals row or delete every data row are refused (Tier B, also guarded by WP-39).
//
// References that become #REF! are written as a bare `#REF!` (refs.ts). 3-D references spanning the
// sheet are refused (Tier B). Structured references, defined-name uses, external references and
// string literals are never rewritten (refs.ts).
//
// No `vscode` import here (core rule).

import type { EditBuilder } from '../edits.js';
import type { OfficeError } from '../types.js';
import type { XmlElement, XmlNode } from '../xml.js';
import { attr, child, childrenOf, escapeText, serialize, textContent } from '../xml.js';
import { partNameFromTarget, readRelationships } from '../opc.js';
import type { Range, Sheet } from './sheet.js';
import { MAX_COLS, MAX_ROWS, a1ToRange, a1ToRc, rangeToA1 as rangeA1, rcToA1 } from './sheet.js';
import { FormulaTranslateError, formulaMentionsSheet, shiftFormula, shiftRange, shiftSqref, translateFormula } from './refs.js';
import type { StructuralShift } from './refs.js';
import type { SheetEntry, Workbook } from './workbook.js';

const NS_R = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];

/** Worksheet children holding cell references this module does not rewrite: refused when present. */
const UNSUPPORTED: Record<string, string> = {
  customSheetViews: 'custom views',
  scenarios: 'scenarios',
  dataConsolidate: 'data consolidation settings',
  cellWatches: 'cell watches',
  smartTags: 'smart tags',
  webPublishItems: 'web publishing items',
};

function refuse(message: string, code: OfficeError['code'] = 'blocked'): never {
  throw Object.assign(new Error(message), { officeError: { code, message } as OfficeError });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');

// ---------------------------------------------------------------------------------------------------
// Index arithmetic on the operation's axis

interface Op {
  readonly shift: StructuralShift;
  readonly rows: boolean;
  readonly at: number;
  readonly count: number;
  /** Number of rows/columns on the axis (1,048,576 or 16,384). */
  readonly max: number;
  readonly name: string;
  readonly order: readonly string[];
}

/** New 0-based index on the axis, or null when deleted or pushed off the sheet. */
function moveIndex(op: Op, i: number): number | null {
  if (i < op.at) return i;
  if (op.count > 0) return i + op.count < op.max ? i + op.count : null;
  return i < op.at - op.count ? null : i + op.count;
}

/** Old index of the surviving row/column now at new index j (never asked for an inserted one). */
function oldIndex(op: Op, j: number): number {
  if (op.count > 0) return j >= op.at + op.count ? j - op.count : j;
  return j >= op.at ? j - op.count : j;
}

function axisWord(op: Op, plural = false): string {
  return op.rows ? (plural ? 'rows' : 'row') : (plural ? 'columns' : 'column');
}

/** shiftRange, refusing what it cannot read. */
function moveRange(op: Op, ref: string, what: string): string {
  try { return shiftRange(ref, op.shift); } catch (e) { return refuse(`The ${what} "${ref}" can't be updated safely (${errText(e)}).`); }
}

function moveSqref(op: Op, sqref: string, what: string): string | null {
  try { return shiftSqref(sqref, op.shift); } catch (e) { return refuse(`The ${what} "${sqref}" can't be updated safely (${errText(e)}).`); }
}

/** A single cell after the shift, clamped instead of deleted (view state: pane, selection). */
function moveCellClamped(op: Op, ref: string, what: string): string {
  const moved = moveRange(op, ref, what);
  if (moved !== '#REF!') return moved;
  const rc = a1ToRange(ref);
  if (!rc) return refuse(`The ${what} "${ref}" can't be updated safely.`);
  const v = op.count > 0 ? op.max - 1 : Math.min(op.at, op.max - 1);
  return op.rows ? rcToA1(v, rc[1]) : rcToA1(rc[0], v);
}

/** `text` shifted (refs.shiftFormula); refuses 3-D spans and text it cannot tokenise. */
function shiftText(op: Op, text: string, home: string | null, where: string): string {
  let res;
  try { res = shiftFormula(text, op.shift, home, op.order); } catch (e) {
    return refuse(`The formula ${where} can't be updated safely (${errText(e)}).`);
  }
  if (res.has3dSpanning) refuse(`The formula ${where} uses a 3-D reference that spans "${op.name}", which can't be shifted.`);
  return res.text;
}

function translate(text: string, dr: number, dc: number, where: string): string {
  try { return translateFormula(text, dr, dc); } catch (e) {
    return refuse(`The formula ${where} can't be updated safely (${errText(e)}).`);
  }
}

/** Top-left cell of the first range of a sqref. */
function anchorOf(sqref: string, what: string): [number, number] {
  const first = sqref.trim().split(/\s+/)[0] ?? '';
  const rg = a1ToRange(first);
  if (!rg) return refuse(`The ${what} "${sqref}" can't be updated safely.`);
  return [rg[0], rg[1]];
}

/**
 * A conditional-format / data-validation formula (relative to the top-left cell of its sqref's first
 * range) for the shifted sqref: translated to the new anchor's old position when the anchor changed
 * (its cell was deleted), then shifted.
 */
function shiftAnchored(op: Op, text: string, oldSq: string, newSq: string, where: string): string {
  let base = text;
  if (newSq !== oldSq) {
    const a = anchorOf(oldSq, 'range');
    const t = anchorOf(newSq, 'range');
    const told: [number, number] = op.rows ? [oldIndex(op, t[0]), t[1]] : [t[0], oldIndex(op, t[1])];
    const dr = told[0] - a[0];
    const dc = told[1] - a[1];
    if (dr !== 0 || dc !== 0) base = translate(text, dr, dc, where);
  }
  return shiftText(op, base, op.name, where);
}

// ---------------------------------------------------------------------------------------------------
// Element text helpers (exact: untouched text is copied from the serialised source)

/** The start tag of an element's serialised text (up to the first '>' outside quotes). */
function startTagOf(text: string): string {
  let q = '';
  for (let j = 1; j < text.length; j++) {
    const ch = text[j];
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') return text.slice(0, j + 1);
  }
  throw new Error('unterminated start tag');
}

function escapeAttrValue(v: string, quote: string): string {
  if (!/[&<\t\n\r"']/.test(v)) return v;
  const s =v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  return quote === '"' ? s.replace(/"/g, '&quot;') : s.replace(/'/g, '&apos;');
}

/**
 * `el`'s start tag (taken from `full`, its serialised text) with existing unqualified attributes changed
 * (string) or removed (null); every other byte of the tag is kept.
 */
function retag(el: XmlElement, full: string, changes: ReadonlyMap<string, string | null>): string {
  const tag = startTagOf(full);
  if (changes.size === 0) return tag;
  let head = '<' + el.rawName;
  let out = head;
  for (const a of el.attrs) {
    const pre = (a as { pre?: string }).pre ?? ' ';
    head += pre + a.raw;
    if (a.ns !== '' || !changes.has(a.local)) { out += pre + a.raw; continue; }
    const v = changes.get(a.local)!;
    if (v === null) continue;
    const quote = a.raw[a.raw.length - 1];
    out += pre + a.raw.slice(0, a.raw.indexOf(quote) + 1) + escapeAttrValue(v, quote) + quote;
  }
  if (!tag.startsWith(head)) throw new Error(`structure: the start tag of <${el.rawName}> could not be rebuilt`);
  return out + tag.slice(head.length);
}

/** `el` (serialised as `full`) with start tag `tag` and new content `inner` (escaped XML). */
function withInner(el: XmlElement, full: string, tag: string, inner: string): string {
  const selfClosing = startTagOf(full).length === full.length;
  if (selfClosing) return inner === '' ? tag : tag.replace(/\s*\/>$/, '>') + inner + `</${el.rawName}>`;
  return tag.replace(/\s*\/>$/, '>') + inner + full.slice(full.lastIndexOf('</'));
}

/** `el` with its text content replaced (start tag kept). */
function withText(el: XmlElement, text: string): string {
  const full = serialize(el);
  return withInner(el, full, startTagOf(full), escapeText(text));
}

const isWs = (n: XmlNode | undefined): boolean => !!n && n.type === 'text' && /^[ \t\r\n]*$/.test(n.raw);

function elements(parent: XmlElement, ns: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const n of parent.children) if (n.type === 'el' && n.ns === ns) out.push(n);
  return out;
}

function intAttr(el: XmlElement, local: string): number | undefined {
  const v = attr(el, '', local);
  return v !== undefined && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Recording helpers (closures run in the write pass)

type Write = () => void;

/** Remove `el` and the whitespace node just before it. */
function removeEl(b: EditBuilder, part: string, el: XmlElement): void {
  const p = el.parent;
  if (!p) throw new Error('structure: cannot remove the root element');
  const prev = p.children[p.children.indexOf(el) - 1];
  b.removeNode(part, el);
  if (isWs(prev)) b.removeNode(part, prev);
}

function setAttrW(writes: Write[], b: EditBuilder, part: string, el: XmlElement, local: string, value: string | null): void {
  if ((attr(el, '', local) ?? null) === value) return;
  writes.push(() => b.setAttr(part, el, '', local, value));
}

function replaceW(writes: Write[], b: EditBuilder, part: string, el: XmlElement, text: string): void {
  if (serialize(el) === text) return;
  writes.push(() => { b.replaceNode(part, el, text, { rootScoped: false }); });
}

// ---------------------------------------------------------------------------------------------------
// Cells and formulas

/** How one `c` element's formula changes. */
interface FormulaRewrite {
  /** New formula text (unescaped), when it changes. */
  text?: string;
  /** Plain formula: drop t/si/ref (shared-group materialisation, §9.4). */
  materialise?: boolean;
  /** Attribute changes on `f` (ref, r1, r2). */
  fAttrs?: Map<string, string | null>;
}

interface FCell {
  el: XmlElement; f: XmlElement;
  r: number; c: number;
  /** New position; null = deleted. */
  nr: number | null; nc: number | null;
}

/** The new text of `f` for `rw`. */
function fText(f: XmlElement, rw: FormulaRewrite): string {
  const full = serialize(f);
  if (rw.materialise) {
    let attrs = '';
    for (const a of f.attrs) {
      if (a.ns === '' && (a.local === 't' || a.local === 'si' || a.local === 'ref')) continue;
      attrs += ((a as { pre?: string }).pre ?? ' ') + a.raw;
    }
    return `<${f.rawName}${attrs}>${escapeText(rw.text ?? textContent(f))}</${f.rawName}>`;
  }
  const tag = retag(f, full, rw.fAttrs ?? new Map());
  if (rw.text === undefined) return tag + full.slice(startTagOf(full).length);
  return withInner(f, full, tag, escapeText(rw.text));
}

/** New text of cell `el`: `ref` its new r (null = unchanged), `rw` its formula change. */
function cellText(el: XmlElement, ns: string, ref: string | null, rw: FormulaRewrite | undefined): string {
  const full = serialize(el);
  const tag = retag(el, full, ref === null ? new Map() : new Map([['r', ref]]));
  if (!rw) return tag + full.slice(startTagOf(full).length);
  let inner = '';
  for (const ch of el.children) {
    if (ch.type === 'el' && ch.ns === ns && ch.local === 'f') inner += fText(ch, rw);
    else inner += serialize(ch);
  }
  return withInner(el, full, tag, inner);
}

function fChild(el: XmlElement, ns: string): XmlElement | undefined {
  for (const ch of el.children) if (ch.type === 'el' && ch.ns === ns && ch.local === 'f') return ch;
  return undefined;
}

/**
 * Formula rewrites for the formula cells of one sheet. `home` is the sheet's name; `edited` whether it is
 * the sheet being changed (cells move; unqualified references shift); otherwise only formulas with '!'
 * are looked at.
 */
function planFormulas(op: Op, cells: readonly FCell[], home: string, edited: boolean): Map<XmlElement, FormulaRewrite> {
  const out = new Map<XmlElement, FormulaRewrite>();
  const groups = new Map<number, FCell[]>();
  const at = (x: FCell): string => `in ${home}!${rcToA1(x.r, x.c)}`;
  for (const x of cells) {
    const t = attr(x.f, '', 't');
    if (t === 'shared') {
      const si = intAttr(x.f, 'si');
      if (si === undefined) refuse(`The shared formula ${at(x)} has no group number, so it can't be updated safely.`);
      const g = groups.get(si);
      if (g) g.push(x); else groups.set(si, [x]);
      continue;
    }
    const rw: FormulaRewrite = {};
    const text = textContent(x.f);
    if (text !== '' && (edited || text.includes('!'))) {
      const s = shiftText(op, text, home, at(x));
      if (s !== text) rw.text = s;
    }
    if (edited && (t === 'array' || t === 'dataTable')) {
      const kind = t === 'array' ? 'array formula' : 'data table';
      const ref = attr(x.f, '', 'ref');
      const deleted = x.nr === null || x.nc === null;
      if (ref !== undefined) {
        const rg = a1ToRange(ref);
        if (!rg) refuse(`The ${kind} range "${ref}" ${at(x)} can't be read.`);
        const moved = moveRange(op, ref, `${kind} range`);
        if (deleted) {
          if (moved !== '#REF!') refuse(`This would delete part of the ${kind} ${ref}.`);
        } else {
          const nrg = moved === '#REF!' ? undefined : a1ToRange(moved);
          if (!nrg || nrg[2] - nrg[0] !== rg[2] - rg[0] || nrg[3] - nrg[1] !== rg[3] - rg[1]) {
            refuse(`This would split or resize the ${kind} ${ref}.`);
          }
          if (moved !== ref) (rw.fAttrs ??= new Map()).set('ref', moved);
        }
      }
      if (t === 'dataTable' && !deleted) {
        for (const k of ['r1', 'r2']) {
          const v = attr(x.f, '', k);
          if (v === undefined) continue;
          const mv = moveRange(op, v, 'data table input cell');
          if (mv === '#REF!') refuse(`This would delete the input cell ${v} of the data table ${ref ?? ''}.`);
          if (mv !== v) (rw.fAttrs ??= new Map()).set(k, mv);
        }
      }
    }
    if (rw.text !== undefined || rw.fAttrs) out.set(x.el, rw);
  }

  for (const [si, members] of groups) {
    const masters = members.filter((x) => attr(x.f, '', 'ref') !== undefined);
    if (!edited) {
      // Another sheet: only groups whose formula can mention the edited sheet matter.
      const relevant = masters.some((m) => {
        const tx = textContent(m.f);
        if (!tx.includes('!')) return false;
        try { return formulaMentionsSheet(tx, op.name, op.order); } catch (e) { return refuse(`The formula ${at(m)} can't be read (${errText(e)}).`); }
      });
      if (!relevant) continue;
    }
    if (masters.length !== 1) {
      refuse(masters.length === 0
        ? `The shared formula group ${si} on "${home}" has no master cell, so its formulas can't be updated safely.`
        : `The shared formula group ${si} on "${home}" has ${masters.length} master cells, so its formulas can't be updated safely.`);
    }
    const m = masters[0];
    const refText = attr(m.f, '', 'ref')!;
    const ref = a1ToRange(refText);
    if (!ref) refuse(`The shared formula ${at(m)} has a range "${refText}" that can't be read.`);
    const mtext = textContent(m.f);
    if (mtext === '') refuse(`The shared formula ${at(m)} has no formula text.`);
    const E = new Map<FCell, string>();
    const S = new Map<FCell, string>();
    for (const x of members) {
      if (x.r < ref[0] || x.r > ref[2] || x.c < ref[1] || x.c > ref[3]) {
        refuse(`The shared formula cell ${home}!${rcToA1(x.r, x.c)} lies outside its group's range ${refText}, so its formulas can't be updated safely.`);
      }
      const e = x === m ? mtext : translate(mtext, x.r - m.r, x.c - m.c, at(x));
      E.set(x, e);
      if (x.nr !== null && x.nc !== null) S.set(x, shiftText(op, e, home, at(x)));
    }
    const survivors = members.filter((x) => x.nr !== null && x.nc !== null);
    const moved = members.some((x) => x.nr !== x.r || x.nc !== x.c);
    const changed = survivors.some((x) => S.get(x) !== E.get(x));
    if ((!moved && !changed) || survivors.length === 0) continue;
    // Keep the group when the shifted master still yields every surviving dependant's shifted formula.
    let keep = m.nr !== null && m.nc !== null;
    let newRef = refText;
    if (keep) {
      const dr = m.nr! - m.r;
      const dc = m.nc! - m.c;
      // On another sheet nothing moves: only the edited sheet's ranges shift.
      newRef = edited ? moveRange(op, refText, 'shared formula range') : refText;
      keep = newRef !== '#REF!' && survivors.every((x) => x.nr! - x.r === dr && x.nc! - x.c === dc);
      const sm = S.get(m)!;
      if (keep) {
        for (const x of survivors) {
          if (x === m) continue;
          let derived: string;
          try { derived = translateFormula(sm, x.nr! - m.nr!, x.nc! - m.nc!); } catch { keep = false; break; }
          if (derived !== S.get(x)) { keep = false; break; }
        }
      }
    }
    if (keep) {
      const rw: FormulaRewrite = {};
      const sm = S.get(m)!;
      if (sm !== mtext) rw.text = sm;
      if (newRef !== refText) rw.fAttrs = new Map([['ref', newRef]]);
      if (rw.text !== undefined || rw.fAttrs) out.set(m.el, rw);
    } else {
      for (const x of survivors) out.set(x.el, { materialise: true, text: S.get(x)! });
    }
  }
  return out;
}

/** Every formula cell of a sheet's sheetData, with its position before/after the shift (edited sheet). */
function formulaCells(sd: XmlElement | undefined, ns: string, op: Op | null): FCell[] {
  const out: FCell[] = [];
  if (!sd) return out;
  for (const row of sd.children) {
    if (row.type !== 'el' || row.ns !== ns || row.local !== 'row') continue;
    for (const el of row.children) {
      if (el.type !== 'el' || el.ns !== ns || el.local !== 'c') continue;
      const f = fChild(el, ns);
      if (!f) continue;
      const rc = cellPos(el);
      const np = op ? movePos(op, rc[0], rc[1]) : rc;
      out.push({ el, f, r: rc[0], c: rc[1], nr: np ? np[0] : null, nc: np ? np[1] : null });
    }
  }
  return out;
}

function cellPos(el: XmlElement): [number, number] {
  const ref = attr(el, '', 'r');
  if (ref === undefined) return refuse('A cell has no reference, so the sheet can\'t be shifted.', 'read-only');
  try { return a1ToRc(ref); } catch { return refuse(`The cell reference "${ref}" can't be read.`, 'read-only'); }
}

function movePos(op: Op, r: number, c: number): [number, number] | null {
  if (op.rows) { const n = moveIndex(op, r); return n === null ? null : [n, c]; }
  const n = moveIndex(op, c);
  return n === null ? null : [r, n];
}

// ---------------------------------------------------------------------------------------------------
// The edited sheet's sheetData

/** Whether any cell of sheetData lies in column t or beyond. */
function anyCellAtOrAfter(sd: XmlElement, ns: string, at: number): boolean {
  for (const row of sd.children) {
    if (row.type !== 'el' || row.ns !== ns || row.local !== 'row') continue;
    for (let k = row.children.length - 1; k >= 0; k--) {
      const ch = row.children[k];
      if (ch.type !== 'el' || ch.ns !== ns || ch.local !== 'c') continue;
      if (cellPos(ch)[1] >= at) return true;
      break;   // cells are in ascending order: the last one is the rightmost
    }
  }
  return false;
}

/** A row's new text; null = deleted; undefined = unchanged. */
function rewriteRow(op: Op, row: XmlElement, ns: string, rewrites: Map<XmlElement, FormulaRewrite>, dropSpans: boolean): string | null | undefined {
  const rAttr = attr(row, '', 'r');
  if (rAttr === undefined || !/^\d+$/.test(rAttr)) return refuse('A row has no valid number, so the sheet can\'t be shifted.', 'read-only');
  const r = parseInt(rAttr, 10) - 1;
  let nr = r;
  const changes = new Map<string, string | null>();
  if (op.rows) {
    const m = moveIndex(op, r);
    if (m === null) {
      if (op.count > 0) refuse(`Row ${r + 1} would be pushed past the last row of the sheet (1,048,576).`);
      return null;
    }
    nr = m;
    if (nr !== r) changes.set('r', String(nr + 1));
  } else if (dropSpans && attr(row, '', 'spans') !== undefined) {
    changes.set('spans', null);   // optional attribute; removed on column operations that move cells (§9.6)
  }
  let cellsChanged = false;
  const inner: string[] = [];
  let lastWs = false;
  for (const ch of row.children) {
    if (ch.type !== 'el' || ch.ns !== ns || ch.local !== 'c') {
      inner.push(ch.type === 'el' ? serialize(ch) : ch.raw);
      lastWs = isWs(ch);
      continue;
    }
    const [cr, cc] = cellPos(ch);
    let nc = cc;
    if (!op.rows) {
      const m = moveIndex(op, cc);
      if (m === null) {
        if (op.count > 0) refuse(`Cell ${rcToA1(cr, cc)} would be pushed past the last column of the sheet (XFD).`);
        cellsChanged = true;
        if (lastWs) inner.pop();
        lastWs = false;
        continue;
      }
      nc = m;
    }
    const rw = rewrites.get(ch);
    const ref = nr !== cr || nc !== cc ? rcToA1(nr, nc) : null;
    if (ref === null && !rw) inner.push(serialize(ch));
    else { cellsChanged = true; inner.push(cellText(ch, ns, ref, rw)); }
    lastWs = false;
  }
  if (changes.size === 0 && !cellsChanged) return undefined;
  const full = serialize(row);
  const tag = retag(row, full, changes);
  if (!cellsChanged) return tag + full.slice(startTagOf(full).length);
  return withInner(row, full, tag, inner.join(''));
}

// ---------------------------------------------------------------------------------------------------
// The edited sheet's other elements

function planDimension(op: Op, b: EditBuilder, part: string, el: XmlElement, writes: Write[]): void {
  const ref = attr(el, '', 'ref');
  if (ref === undefined) return;
  let moved = moveRange(op, ref, 'sheet dimension');
  if (moved === '#REF!') moved = 'A1';
  setAttrW(writes, b, part, el, 'ref', moved);
}

function planSheetViews(op: Op, b: EditBuilder, part: string, views: XmlElement, ns: string, writes: Write[]): void {
  for (const view of childrenOf(views, ns, 'sheetView')) {
    const pane = child(view, ns, 'pane');
    if (pane) {
      const tl = attr(pane, '', 'topLeftCell');
      if (tl !== undefined) setAttrW(writes, b, part, pane, 'topLeftCell', moveCellClamped(op, tl, 'pane position'));
      const state = attr(pane, '', 'state');
      if (state === 'frozen' || state === 'frozenSplit') {
        const key = op.rows ? 'ySplit' : 'xSplit';
        const v = attr(pane, '', key);
        if (v !== undefined) {
          const k = Number(v);
          if (!Number.isInteger(k) || k < 0) refuse(`The frozen pane split "${v}" can't be read.`);
          let nk = k;
          if (op.count > 0) { if (op.at < k) nk = Math.min(k + op.count, op.max - 1); } else {
            const lo = op.at;
            const hi = op.at - op.count - 1;
            nk = k - Math.max(0, Math.min(hi, k - 1) - lo + 1);
          }
          if (nk === 0 && k > 0) refuse(`This would delete every frozen ${axisWord(op)}; unfreeze the panes first.`);
          if (nk !== k) setAttrW(writes, b, part, pane, key, String(nk));
        }
      }
    }
    for (const sel of childrenOf(view, ns, 'selection')) {
      const ac = attr(sel, '', 'activeCell');
      const nac = ac !== undefined ? moveCellClamped(op, ac, 'active cell') : undefined;
      if (ac !== undefined) setAttrW(writes, b, part, sel, 'activeCell', nac!);
      const sq = attr(sel, '', 'sqref');
      if (sq !== undefined) {
        const nsq = moveSqref(op, sq, 'selection');
        setAttrW(writes, b, part, sel, 'sqref', nsq ?? nac ?? 'A1');
      }
    }
  }
}

/** cols on column operations: split / shift / shrink / remove; rejoin halves on delete. */
function planCols(op: Op, b: EditBuilder, part: string, cols: XmlElement, ns: string, writes: Write[]): void {
  interface ColPlan { el: XmlElement; a: number; bb: number; orig: number; out: Array<[number, number]> }
  const plans: ColPlan[] = [];
  for (const el of childrenOf(cols, ns, 'col')) {
    const min = intAttr(el, 'min');
    const max = intAttr(el, 'max');
    if (min === undefined || max === undefined || min < 1 || max < min) refuse('A column record has an unreadable range, so columns can\'t be shifted.');
    const a = min - 1;
    const bb = Math.min(max, MAX_COLS) - 1;
    const out: Array<[number, number]> = [];
    if (op.count > 0) {
      if (bb < op.at) out.push([a, bb]);
      else if (a >= op.at) { if (a + op.count < MAX_COLS) out.push([a + op.count, Math.min(bb + op.count, MAX_COLS - 1)]); }
      else {
        out.push([a, op.at - 1]);
        if (op.at + op.count < MAX_COLS) out.push([op.at + op.count, Math.min(bb + op.count, MAX_COLS - 1)]);
      }
    } else {
      const n = -op.count;
      const hi = op.at + n - 1;
      if (bb < op.at) out.push([a, bb]);
      else if (a > hi) out.push([a - n, bb === MAX_COLS - 1 ? bb : bb - n]);
      else {
        const na = a < op.at ? a : op.at;
        // A range reaching XFD keeps reaching it (the columns entering at the end belong to it). [WP-37]
        const nb = bb === MAX_COLS - 1 ? bb : bb > hi ? bb - n : op.at - 1;
        if (nb >= na) out.push([na, nb]);
      }
    }
    plans.push({ el, a, bb, orig: max - 1, out });
  }
  // Delete: join the two halves of a range split by an earlier insert (adjacent again, same attributes).
  if (op.count < 0) {
    const n = -op.count;
    const bare = (el: XmlElement): string => { const f = serialize(el); return retag(el, f, new Map([['min', null], ['max', null]])) + f.slice(startTagOf(f).length); };
    for (let k = 0; k + 1 < plans.length; k++) {
      const p = plans[k];
      const q = plans[k + 1];
      if (p.bb === op.at - 1 && q.a === op.at + n && p.out.length === 1 && q.out.length === 1 && bare(p.el) === bare(q.el)) {
        p.out = [[p.out[0][0], q.out[0][1]]];
        q.out = [];
      }
    }
  }
  const changedAny = plans.some((p) => p.out.length !== 1 || p.out[0][0] !== p.a || p.out[0][1] !== p.orig);
  if (!changedAny) return;
  if (plans.every((p) => p.out.length === 0)) { writes.push(() => removeEl(b, part, cols)); return; }
  const full = serialize(cols);
  const pieces: string[] = [startTagOf(full)];
  let lastWs = false;
  const byEl = new Map(plans.map((p) => [p.el, p]));
  for (const node of cols.children) {
    const p = node.type === 'el' ? byEl.get(node) : undefined;
    if (!p) { pieces.push(node.type === 'el' ? serialize(node) : node.raw); lastWs = isWs(node); continue; }
    if (p.out.length === 0) { if (lastWs) pieces.pop(); lastWs = false; continue; }
    const f = serialize(p.el);
    for (const [na, nb] of p.out) {
      const tag = retag(p.el, f, new Map([['min', String(na + 1)], ['max', String(nb + 1)]]));
      pieces.push(tag + f.slice(startTagOf(f).length));
    }
    lastWs = false;
  }
  pieces.push(full.slice(full.lastIndexOf('</')));
  replaceW(writes, b, part, cols, pieces.join(''));
}

function planMerges(op: Op, b: EditBuilder, part: string, mcs: XmlElement, ns: string, writes: Write[]): void {
  const list = childrenOf(mcs, ns, 'mergeCell');
  const local: Write[] = [];
  let remaining = 0;
  for (const mc of list) {
    const ref = attr(mc, '', 'ref');
    if (ref === undefined) { remaining++; continue; }
    const moved = moveRange(op, ref, 'merged range');
    const rg = moved === '#REF!' ? undefined : a1ToRange(moved);
    const single = rg !== undefined && rg[0] === rg[2] && rg[1] === rg[3] && moved !== ref;
    if (!rg || single) { local.push(() => removeEl(b, part, mc)); continue; }
    remaining++;
    setAttrW(local, b, part, mc, 'ref', moved);
  }
  if (list.length > 0 && remaining === 0) { writes.push(() => removeEl(b, part, mcs)); return; }
  writes.push(...local);
  const count = attr(mcs, '', 'count');
  if (count !== undefined && local.length > 0) setAttrW(writes, b, part, mcs, 'count', String(remaining));
}

function planSortState(op: Op, b: EditBuilder, part: string, ss: XmlElement, ns: string, writes: Write[], mayRemove: boolean): void {
  const ref = attr(ss, '', 'ref');
  if (ref !== undefined) {
    const moved = moveRange(op, ref, 'sort range');
    if (moved === '#REF!') {
      if (!mayRemove) refuse(`This would delete the sort range ${ref}.`);
      writes.push(() => removeEl(b, part, ss));
      return;
    }
    setAttrW(writes, b, part, ss, 'ref', moved);
  }
  for (const sc of childrenOf(ss, ns, 'sortCondition')) {
    const r = attr(sc, '', 'ref');
    if (r === undefined) continue;
    const moved = moveRange(op, r, 'sort condition range');
    if (moved === '#REF!') writes.push(() => removeEl(b, part, sc));
    else setAttrW(writes, b, part, sc, 'ref', moved);
  }
}

function planAutoFilter(op: Op, b: EditBuilder, part: string, af: XmlElement, ns: string, writes: Write[], mayRemove: boolean): void {
  const ref = attr(af, '', 'ref');
  let moved = ref;
  if (ref !== undefined) {
    moved = moveRange(op, ref, 'filter range');
    if (moved === '#REF!') {
      if (!mayRemove) refuse(`This would delete the filter range ${ref}.`);
      writes.push(() => removeEl(b, part, af));
      return;
    }
    setAttrW(writes, b, part, af, 'ref', moved);
  }
  if (!op.rows && ref !== undefined) {
    const old = a1ToRange(ref);
    const now = a1ToRange(moved!);
    const cols = childrenOf(af, ns, 'filterColumn');
    if (cols.length > 0 && (!old || !now)) refuse(`The filter range ${ref} can't be read.`);
    for (const fc of cols) {
      const id = intAttr(fc, 'colId');
      if (id === undefined) refuse('A filter column has no column number, so the filter can\'t be shifted.');
      const abs = moveIndex(op, old![1] + id);
      if (abs === null) { writes.push(() => removeEl(b, part, fc)); continue; }
      setAttrW(writes, b, part, fc, 'colId', String(abs - now![1]));
    }
  }
  const ss = child(af, ns, 'sortState');
  if (ss) planSortState(op, b, part, ss, ns, writes, mayRemove);
}

/** A container of entries with a ref/sqref attribute: shift each, remove deleted ones, drop the container when empty. */
function planList(op: Op, b: EditBuilder, part: string, container: XmlElement, ns: string, entry: string, key: 'ref' | 'sqref',
  what: string, writes: Write[], countAttr?: string): void {
  const list = childrenOf(container, ns, entry);
  const local: Write[] = [];
  let remaining = 0;
  for (const el of list) {
    const v = attr(el, '', key);
    if (v === undefined) { remaining++; continue; }
    const moved = key === 'ref' ? moveRange(op, v, what) : moveSqref(op, v, what);
    if (moved === null || moved === '#REF!') { local.push(() => removeEl(b, part, el)); continue; }
    remaining++;
    setAttrW(local, b, part, el, key, moved);
  }
  if (list.length > 0 && remaining === 0) { writes.push(() => removeEl(b, part, container)); return; }
  writes.push(...local);
  if (countAttr && attr(container, '', countAttr) !== undefined && remaining !== list.length) setAttrW(writes, b, part, container, countAttr, String(remaining));
}

const PLAIN_NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

/** cfRule formulas and formula cfvo values; `oldSq`/`newSq` the rule's range before/after (anchoring). */
function planCfRules(op: Op, b: EditBuilder, part: string, cf: XmlElement, ns: string, home: string, edited: boolean,
  oldSq: string, newSq: string, writes: Write[]): void {
  const where = `in the conditional format on ${home}!${oldSq}`;
  const shiftOne = (text: string): string => (edited ? shiftAnchored(op, text, oldSq, newSq, where) : text.includes('!') ? shiftText(op, text, home, where) : text);
  for (const rule of childrenOf(cf, ns, 'cfRule')) {
    for (const fe of childrenOf(rule, ns, 'formula')) {
      const t = textContent(fe);
      if (t === '') continue;
      const s = shiftOne(t);
      if (s !== t) replaceW(writes, b, part, fe, withText(fe, s));
    }
    for (const holder of elements(rule, ns)) {
      for (const cfvo of childrenOf(holder, ns, 'cfvo')) {
        const v = attr(cfvo, '', 'val');
        if (v === undefined || v === '' || PLAIN_NUMBER.test(v)) continue;
        const s = shiftOne(v.startsWith('=') ? v.slice(1) : v);
        const nv = v.startsWith('=') ? '=' + s : s;
        setAttrW(writes, b, part, cfvo, 'val', nv);
      }
    }
  }
}

function planConditionalFormatting(op: Op, b: EditBuilder, part: string, cf: XmlElement, ns: string, home: string, edited: boolean, writes: Write[]): void {
  const sq = attr(cf, '', 'sqref');
  if (sq === undefined) return;
  if (!edited) { planCfRules(op, b, part, cf, ns, home, false, sq, sq, writes); return; }
  const nsq = moveSqref(op, sq, 'conditional format range');
  if (nsq === null) { writes.push(() => removeEl(b, part, cf)); return; }
  planCfRules(op, b, part, cf, ns, home, true, sq, nsq, writes);
  setAttrW(writes, b, part, cf, 'sqref', nsq);
}

function planDataValidations(op: Op, b: EditBuilder, part: string, dvs: XmlElement, ns: string, home: string, edited: boolean, writes: Write[]): void {
  const list = childrenOf(dvs, ns, 'dataValidation');
  const local: Write[] = [];
  let remaining = 0;
  for (const dv of list) {
    const sq = attr(dv, '', 'sqref');
    const nsq = sq !== undefined && edited ? moveSqref(op, sq, 'data validation range') : sq;
    if (nsq === null) { local.push(() => removeEl(b, part, dv)); continue; }
    remaining++;
    const where = `in the data validation on ${home}!${sq ?? ''}`;
    for (const k of ['formula1', 'formula2']) {
      const fe = child(dv, ns, k);
      if (!fe) continue;
      const t = textContent(fe);
      if (t === '') continue;
      const s = edited ? shiftAnchored(op, t, sq!, nsq!, where) : t.includes('!') ? shiftText(op, t, home, where) : t;
      if (s !== t) replaceW(local, b, part, fe, withText(fe, s));
    }
    if (edited && sq !== undefined) setAttrW(local, b, part, dv, 'sqref', nsq!);
  }
  if (list.length > 0 && remaining === 0) { writes.push(() => removeEl(b, part, dvs)); return; }
  writes.push(...local);
  if (attr(dvs, '', 'count') !== undefined && remaining !== list.length) setAttrW(writes, b, part, dvs, 'count', String(remaining));
}

function planBreaks(op: Op, b: EditBuilder, part: string, brks: XmlElement, ns: string, writes: Write[]): void {
  const list = childrenOf(brks, ns, 'brk');
  const local: Write[] = [];
  let remaining = 0;
  let manual = 0;
  let changed = false;
  for (const brk of list) {
    const id = intAttr(brk, 'id');
    const man = attr(brk, '', 'man') === '1' || attr(brk, '', 'man') === 'true';
    if (id === undefined) { remaining++; if (man) manual++; continue; }
    const n = moveIndex(op, id);
    if (n === null) { changed = true; local.push(() => removeEl(b, part, brk)); continue; }
    remaining++;
    if (man) manual++;
    if (n !== id) { changed = true; setAttrW(local, b, part, brk, 'id', String(n)); }
  }
  if (!changed) return;
  if (list.length > 0 && remaining === 0) { writes.push(() => removeEl(b, part, brks)); return; }
  writes.push(...local);
  if (attr(brks, '', 'count') !== undefined) setAttrW(writes, b, part, brks, 'count', String(remaining));
  if (attr(brks, '', 'manualBreakCount') !== undefined) setAttrW(writes, b, part, brks, 'manualBreakCount', String(manual));
}

// ---------------------------------------------------------------------------------------------------
// Tables (xl/tables/tableN.xml) on the edited sheet

function planTables(op: Op, b: EditBuilder, wb: Workbook, sheet: Sheet, writes: Write[]): void {
  const pkg = wb.pkg;
  const root = sheet.doc.root;
  const ns = root.ns;
  const tp = child(root, ns, 'tableParts');
  if (!tp) return;
  const rels = readRelationships(pkg, sheet.part);
  for (const el of childrenOf(tp, ns, 'tablePart')) {
    const id = NS_R.map((u) => attr(el, u, 'id')).find((v) => v !== undefined);
    const rel = id !== undefined ? rels.find((x) => x.id === id) : undefined;
    if (!rel || rel.external) refuse('A table on this sheet can\'t be found, so it can\'t be shifted.');
    let name: string;
    try { name = partNameFromTarget(sheet.part, rel.target); } catch { return refuse('A table on this sheet can\'t be found, so it can\'t be shifted.'); }
    const part = pkg.partNames().find((p) => p.toLowerCase() === name.toLowerCase());
    if (!part) refuse('A table on this sheet can\'t be found, so it can\'t be shifted.');
    const troot = pkg.xml(part).root;
    const tns = troot.ns;
    const tname = attr(troot, '', 'displayName') ?? attr(troot, '', 'name') ?? part;
    const ref = attr(troot, '', 'ref');
    const rg = ref !== undefined ? a1ToRange(ref) : undefined;
    if (!rg) refuse(`The range of table "${tname}" can't be read.`);
    const h = intAttr(troot, 'headerRowCount') ?? 1;
    const t = intAttr(troot, 'totalsRowCount') ?? 0;
    checkTable(op, tname, rg, h, t);
    const moved = moveRange(op, ref!, `range of table "${tname}"`);
    if (moved === '#REF!') refuse(`This would delete table "${tname}".`);
    setAttrW(writes, b, part, troot, 'ref', moved);
    const af = child(troot, tns, 'autoFilter');
    const afRef = af ? attr(af, '', 'ref') : undefined;
    const nrg = a1ToRange(moved);
    if (af && afRef !== undefined && t > 0 && nrg && afRef === rangeA1([rg[0], rg[1], rg[2] - t, rg[3]])) {
      // The table's own filter covers header + data (not the totals rows): it follows the new table
      // extent, so rows inserted just above the totals row join the data area. [WP-37]
      setAttrW(writes, b, part, af, 'ref', rangeA1([nrg[0], nrg[1], nrg[2] - t, nrg[3]]));
      const ss = child(af, tns, 'sortState');
      if (ss) planSortState(op, b, part, ss, tns, writes, false);
    } else if (af) planAutoFilter(op, b, part, af, tns, writes, false);
    const ss = child(troot, tns, 'sortState');
    if (ss) planSortState(op, b, part, ss, tns, writes, false);
    planTableFormulas(op, b, part, troot, op.name, true, writes);
  }
}

/** Table column elements whose text is a formula (as sheetsOps rewrites them on rename/delete). */
const TABLE_FORMULA_LOCALS = ['calculatedColumnFormula', 'totalsRowFormula'];

/**
 * A table's calculated-column and totals-row formulas, shifted like the cell formulas of the sheet the
 * table is on (`home`): every reference on the edited sheet, or (another sheet) only qualified ones.
 */
function planTableFormulas(op: Op, b: EditBuilder, part: string, troot: XmlElement, home: string, edited: boolean, writes: Write[]): void {
  const tns = troot.ns;
  const cols = child(troot, tns, 'tableColumns');
  if (!cols) return;
  const tname = attr(troot, '', 'displayName') ?? attr(troot, '', 'name') ?? part;
  for (const col of childrenOf(cols, tns, 'tableColumn')) {
    for (const local of TABLE_FORMULA_LOCALS) {
      const fe = child(col, tns, local);
      if (!fe) continue;
      const t = textContent(fe);
      if (t === '' || (!edited && !t.includes('!'))) continue;
      const s = shiftText(op, t, home, `of column "${attr(col, '', 'name') ?? ''}" in table "${tname}"`);
      if (s !== t) replaceW(writes, b, part, fe, withText(fe, s));
    }
  }
}

/** The table parts of `sheet` (resolved through its tableParts relationships); unresolvable ones are refused. */
function tablePartsOf(wb: Workbook, sheet: Sheet): string[] {
  const root = sheet.doc.root;
  const tp = child(root, root.ns, 'tableParts');
  if (!tp) return [];
  const rels = readRelationships(wb.pkg, sheet.part);
  const out: string[] = [];
  for (const el of childrenOf(tp, root.ns, 'tablePart')) {
    const id = NS_R.map((u) => attr(el, u, 'id')).find((v) => v !== undefined);
    const rel = id !== undefined ? rels.find((x) => x.id === id) : undefined;
    let name: string | undefined;
    try { name = rel && !rel.external ? partNameFromTarget(sheet.part, rel.target) : undefined; } catch { name = undefined; }
    const part = name !== undefined ? wb.pkg.partNames().find((p) => p.toLowerCase() === name!.toLowerCase()) : undefined;
    if (!part) refuse(`A table on sheet "${sheet.part}" can't be found, so its formulas can't be updated.`);
    out.push(part);
  }
  return out;
}

/** Tier B for tables (§9.6): what Tier A cannot update. */
function checkTable(op: Op, name: string, rg: Range, headerRows: number, totalsRows: number): void {
  if (!op.rows) {
    const lo = rg[1];
    const hi = rg[3];
    if (op.count > 0 ? op.at > lo && op.at <= hi : op.at <= hi && op.at - op.count - 1 >= lo) {
      refuse(`This would insert or delete columns inside table "${name}"; that is not supported here.`);
    }
    return;
  }
  if (op.count > 0) return;
  const lo = op.at;
  const hi = op.at - op.count - 1;
  const hit = (a: number, z: number): boolean => a <= z && lo <= z && hi >= a;
  if (headerRows > 0 && hit(rg[0], rg[0] + headerRows - 1)) refuse(`This would delete the header row of table "${name}".`);
  if (totalsRows > 0 && hit(rg[2] - totalsRows + 1, rg[2])) refuse(`This would delete the totals row of table "${name}".`);
  const d0 = rg[0] + headerRows;
  const d1 = rg[2] - totalsRows;
  if (d1 >= d0 && lo <= d0 && hi >= d1) refuse(`This would delete every data row of table "${name}".`);
}

// ---------------------------------------------------------------------------------------------------
// Sheets

/**
 * Above this many (changed rows x rows in sheetData), sheetData is replaced as one node instead of one
 * change per row: a per-row change locates its row by position (EditBuilder / xml.replaceNode search the
 * parent's children, and a removal shifts them), so per-row recording is O(changed x rows) — quadratic
 * when an insert near the top renumbers every row (review S3: 100k rows took 10.7 s, undo 12.9 s).
 * Below it, a few changed rows in a big sheet re-parse only those rows.
 */
const PER_ROW_BUDGET = 20_000_000;

/**
 * sheetData of the edited sheet. Few changed rows: one `node` change per row that changes (replaced, or
 * removed with the whitespace node before it). Many: one `node` change replacing sheetData with the same
 * text those per-row changes would have produced (unchanged rows copied from their serialised source),
 * so the result, undo and redo are byte-identical either way and the cost is linear in the sheet.
 */
function planSheetData(op: Op, b: EditBuilder, part: string, sd: XmlElement, ns: string,
  rewrites: Map<XmlElement, FormulaRewrite>, dropSpans: boolean, writes: Write[]): void {
  const plans: Array<[XmlElement, string | null]> = [];
  for (const node of sd.children) {
    if (node.type !== 'el' || node.ns !== ns || node.local !== 'row') continue;
    const text = rewriteRow(op, node, ns, rewrites, dropSpans);
    if (text !== undefined) plans.push([node, text]);
  }
  if (plans.length === 0) return;
  if (plans.length * sd.children.length <= PER_ROW_BUDGET) {
    for (const [node, text] of plans) {
      if (text === null) writes.push(() => removeEl(b, part, node));
      else writes.push(() => { b.replaceNode(part, node, text, { rootScoped: false }); });
    }
    return;
  }
  const byRow = new Map(plans);
  const full = serialize(sd);
  const pieces: string[] = [startTagOf(full)];
  let lastWs = false;
  for (const node of sd.children) {
    const text = node.type === 'el' ? byRow.get(node) : undefined;
    if (text === undefined) {
      pieces.push(node.type === 'el' ? serialize(node) : node.raw);
      lastWs = isWs(node);
      continue;
    }
    if (text === null) { if (lastWs) pieces.pop(); }   // removed with the whitespace before it (removeEl)
    else pieces.push(text);
    lastWs = false;
  }
  const inner = pieces.slice(1).join('');
  const next = withInner(sd, full, pieces[0], inner);
  writes.push(() => { b.replaceNode(part, sd, next, { rootScoped: false }); });
}

/** Plan the edited sheet: sheetData plus every Tier A element. */
function planEditedSheet(op: Op, b: EditBuilder, sheet: Sheet, writes: Write[]): void {
  const root = sheet.doc.root;
  const ns = root.ns;
  const part = sheet.part;
  for (const el of elements(root, ns)) {
    const what = UNSUPPORTED[el.local];
    if (what) refuse(`This sheet has ${what}, which can't be shifted here.`);
  }
  const sd = child(root, ns, 'sheetData');
  if (sd) {
    const rewrites = planFormulas(op, formulaCells(sd, ns, op), op.name, true);
    // spans (column-extent hints) go on column operations that move or delete any cell; a column op
    // beyond every cell leaves them correct and changes nothing.
    const dropSpans = !op.rows && anyCellAtOrAfter(sd, ns, op.at);
    planSheetData(op, b, part, sd, ns, rewrites, dropSpans, writes);
  }
  for (const el of elements(root, ns)) {
    switch (el.local) {
      case 'dimension': planDimension(op, b, part, el, writes); break;
      case 'sheetViews': planSheetViews(op, b, part, el, ns, writes); break;
      case 'cols': if (!op.rows) planCols(op, b, part, el, ns, writes); break;
      case 'mergeCells': planMerges(op, b, part, el, ns, writes); break;
      case 'autoFilter': planAutoFilter(op, b, part, el, ns, writes, true); break;
      case 'sortState': planSortState(op, b, part, el, ns, writes, true); break;
      case 'hyperlinks': planList(op, b, part, el, ns, 'hyperlink', 'ref', 'hyperlink', writes); break;
      case 'conditionalFormatting': planConditionalFormatting(op, b, part, el, ns, op.name, true, writes); break;
      case 'dataValidations': planDataValidations(op, b, part, el, ns, op.name, true, writes); break;
      case 'protectedRanges': planList(op, b, part, el, ns, 'protectedRange', 'sqref', 'protected range', writes); break;
      case 'ignoredErrors': planList(op, b, part, el, ns, 'ignoredError', 'sqref', 'ignored-error range', writes); break;
      case 'rowBreaks': if (op.rows) planBreaks(op, b, part, el, ns, writes); break;
      case 'colBreaks': if (!op.rows) planBreaks(op, b, part, el, ns, writes); break;
      default: break;
    }
  }
}

/** Plan another worksheet: formulas (cells, conditional formats, validations) qualified with the edited sheet. */
function planOtherSheet(op: Op, b: EditBuilder, wb: Workbook, e: SheetEntry, sheet: Sheet, writes: Write[]): boolean {
  const root = sheet.doc.root;
  const ns = root.ns;
  const part = sheet.part;
  const local: Write[] = [];
  const sd = child(root, ns, 'sheetData');
  const rewrites = planFormulas(op, formulaCells(sd, ns, null), e.name, false);
  for (const [el, rw] of rewrites) replaceW(local, b, part, el, cellText(el, ns, null, rw));
  for (const el of elements(root, ns)) {
    if (el.local === 'conditionalFormatting') planConditionalFormatting(op, b, part, el, ns, e.name, false, local);
    else if (el.local === 'dataValidations') planDataValidations(op, b, part, el, ns, e.name, false, local);
  }
  for (const tpart of tablePartsOf(wb, sheet)) {
    let troot: XmlElement;
    try { troot = wb.pkg.xml(tpart).root; } catch { return refuse(`A table on sheet "${e.name}" can't be read, so its formulas can't be updated.`); }
    planTableFormulas(op, b, tpart, troot, e.name, false, local);
  }
  if (local.length === 0) return false;
  if (sheet.readOnlyReason || sheet.truncatedAtRow !== null) {
    refuse(`Sheet "${e.name}" has formulas that refer to "${op.name}" but can't be edited here${sheet.readOnlyReason ? ` (${sheet.readOnlyReason})` : ''}.`);
  }
  if (sheet.doc !== b.pkg.xml(part)) refuse(`Sheet "${e.name}" was replaced; reload it before editing.`, 'stale');
  writes.push(...local);
  return true;
}

/** workbook.xml definedNames. */
function planDefinedNames(op: Op, b: EditBuilder, wb: Workbook, writes: Write[]): void {
  const part = wb.workbookPart;
  const root = wb.pkg.xml(part).root;
  const dn = child(root, root.ns, 'definedNames');
  if (!dn) return;
  for (const d of childrenOf(dn, root.ns, 'definedName')) {
    const text = textContent(d);
    if (text === '' || !text.includes('!')) continue;
    const s = shiftText(op, text, null, `of the defined name "${attr(d, '', 'name') ?? ''}"`);
    if (s !== text) replaceW(writes, b, part, d, withText(d, s));
  }
}

// ---------------------------------------------------------------------------------------------------

/**
 * Insert (`count` > 0) or delete (`count` < 0) rows or columns at 0-based `at` of `sheet` (§9.6 Tier A).
 * Records through `b`; nothing is written when the operation is refused (the returned promise rejects
 * with an Error carrying `officeError`). Changes nothing (records nothing) when nothing moves.
 */
export async function insertOrDelete(b: EditBuilder, wb: Workbook, sheet: Sheet, axis: 'row' | 'col', at: number, count: number): Promise<void> {
  if (axis !== 'row' && axis !== 'col') refuse('Invalid axis.', 'invalid');
  const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
  if (!Number.isInteger(at) || !Number.isInteger(count) || count === 0 || at < 0 || at >= max || Math.abs(count) > max) {
    refuse('Invalid position or count.', 'invalid');
  }
  if (count < 0 && at - count > max) refuse(`The ${axis === 'row' ? 'rows' : 'columns'} to delete run past the end of the sheet.`, 'invalid');
  if (b.pkg !== wb.pkg) refuse('The edit does not belong to this workbook.', 'internal');
  const entry = wb.sheets.find((e) => e.part !== null && e.part.toLowerCase() === sheet.part.toLowerCase());
  if (!entry || entry.kind !== 'worksheet') refuse('The sheet is not a worksheet of this workbook.', 'internal');
  if (sheet.doc !== wb.pkg.xml(sheet.part)) refuse(`Sheet "${entry.name}" was replaced; reload it before editing.`, 'stale');
  if (sheet.readOnlyReason || sheet.truncatedAtRow !== null) refuse(`Sheet "${entry.name}" can't be edited here.`, 'read-only');

  const op: Op = {
    shift: { sheetName: entry.name, axis, at, count }, rows: axis === 'row', at, count, max,
    name: entry.name, order: wb.sheets.map((e) => e.name),
  };

  // Load every other worksheet first (parsed on demand, §9.6), so planning and writing below run
  // without yielding: nothing can change the trees between the plan and the writes.
  const others: Array<{ e: SheetEntry; s: Sheet }> = [];
  for (const e of wb.sheets) {
    if (e.kind !== 'worksheet' || e.id === entry.id) continue;
    let s: Sheet;
    try { s = await wb.sheet(e.id); } catch (err) {
      return refuse(`Sheet "${e.name}" can't be read (${errText(err)}), so references in it to "${entry.name}" can't be updated.`);
    }
    others.push({ e, s });
  }
  if (sheet.doc !== wb.pkg.xml(sheet.part)) refuse(`Sheet "${entry.name}" was replaced; reload it before editing.`, 'stale');

  const writes: Write[] = [];
  const touched: Sheet[] = [sheet];
  planEditedSheet(op, b, sheet, writes);
  for (const { e, s } of others) if (planOtherSheet(op, b, wb, e, s, writes)) touched.push(s);
  planTables(op, b, wb, sheet, writes);
  planDefinedNames(op, b, wb, writes);
  if (writes.length === 0) return;

  try {
    for (const w of writes) w();
  } catch (err) {
    b.abort();
    for (const s of touched) s.rebuildIndex();
    throw err;
  }
  for (const s of touched) s.rebuildIndex();
}
