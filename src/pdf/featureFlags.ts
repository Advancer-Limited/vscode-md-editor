// PDF viewer/editor feature flags (plan §3.2).
//
// `pdfEdit` is flipped by the last commit of PR-P9 after Gate P3; `pdfForms` by the last commit of
// PR-P10 after Gate P4. While `pdfEdit` is off the provider reports `canEdit: false`; while
// `pdfForms` is off classification reports `forms.reason: 'flag-off'`. A hotfix release may be cut
// from `develop` at any time, so both MUST stay false until their gate has passed.
//
// No imports: the Node test runner can load this file directly.

export interface PdfFlags {
  readonly pdfEdit: boolean;
  readonly pdfForms: boolean;
}

export const PDF_FLAGS: PdfFlags = Object.freeze({
  pdfEdit: false,
  pdfForms: false,
});
