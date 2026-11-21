// Styles and lists, write side (spec §8.6; plan WP-30). TYPED STUB written by WP-29: the signatures
// `ops.ts` dispatches to. WP-30 replaces the bodies; until then every call is refused and changes
// nothing.
//
// Contract with `applyDocxEdit` (ops.ts): each function records its changes into `b` and returns
// null, or returns an `OfficeError` (the caller then aborts the builder, so partial changes are
// rolled back). It must not finish or abort `b` and must not call `model.refresh()` or the
// `reload()` of styles/numbering: the caller does all of that once, after finishing the builder.
// A `w:p` element that is kept (only its `w:pPr` replaced) keeps its block id; a writer that
// replaces the `w:p` itself calls `model.carryId(old, new)`.
//
// No `vscode` import here (core rule).

import type { OfficeError } from '../types.js';
import type { EditBuilder } from '../edits.js';
import type { DocxContext } from './ops.js';

export type StyleChoice = 'normal' | { heading: 1 | 2 | 3 | 4 | 5 | 6 };
export type ListChoice = 'none' | 'bullet' | 'number';

const notYet = (): OfficeError => ({ code: 'blocked', message: "Styles and lists can't be changed in this version yet." });

export function setStyle(b: EditBuilder, ctx: DocxContext, blockIds: number[], style: StyleChoice): OfficeError | null {
  void b; void ctx; void blockIds; void style;
  return notYet();
}

export function setList(b: EditBuilder, ctx: DocxContext, blockIds: number[], list: ListChoice): OfficeError | null {
  void b; void ctx; void blockIds; void list;
  return notYet();
}

export function setListLevel(b: EditBuilder, ctx: DocxContext, blockIds: number[], delta: 1 | -1): OfficeError | null {
  void b; void ctx; void blockIds; void delta;
  return notYet();
}
