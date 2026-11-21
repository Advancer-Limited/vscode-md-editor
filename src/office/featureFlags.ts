// Office viewers/editors feature flags (plan §3.1).
//
// Each flag was false until its phase was released (plan: PR-8, PR-11, PR-14). Version 1.6 switches
// on Excel cell editing, Excel structural editing and Word editing (user's release decision,
// 2026-11-21). While a kind's edit flag is off its provider reports `canEdit: false` and registers
// read-only; while `xlsxStructure` is off structural operations are rejected. Tests exercise the
// flag-off behaviour through a mutable copy of this module (see saveProvider.test.mjs).
//
// No imports: the Node test runner loads this file directly.

export interface OfficeFlags {
  readonly xlsxEdit: boolean;
  readonly docxEdit: boolean;
  readonly xlsxStructure: boolean;
}

export const OFFICE_FLAGS: OfficeFlags = Object.freeze({
  xlsxEdit: true,
  docxEdit: true,
  xlsxStructure: true,
});

/** Whether editing is switched on at all for a document kind. */
export function editFlagFor(kind: 'docx' | 'xlsx'): boolean {
  return kind === 'docx' ? OFFICE_FLAGS.docxEdit : OFFICE_FLAGS.xlsxEdit;
}
