// Office viewers/editors feature flags (plan §3.1).
//
// Every flag is false until the last PR of its phase flips it after the phase gate (PR-8, PR-11,
// PR-14). While a kind's edit flag is off its provider reports `canEdit: false`; while
// `xlsxStructure` is off structural operations are rejected. A hotfix release may be cut from
// `develop` at any time, so these MUST stay false until their gate has passed.
//
// No imports: the Node test runner loads this file directly.

export interface OfficeFlags {
  readonly xlsxEdit: boolean;
  readonly docxEdit: boolean;
  readonly xlsxStructure: boolean;
}

export const OFFICE_FLAGS: OfficeFlags = Object.freeze({
  xlsxEdit: false,
  docxEdit: false,
  xlsxStructure: false,
});

/** Whether editing is switched on at all for a document kind. */
export function editFlagFor(kind: 'docx' | 'xlsx'): boolean {
  return kind === 'docx' ? OFFICE_FLAGS.docxEdit : OFFICE_FLAGS.xlsxEdit;
}
