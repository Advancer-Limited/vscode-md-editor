// Load-failure text for the PDF error view (spec §9.4).
//
// Host-detected failures (empty, not a PDF, too large, unreadable, unexpected) become the shared
// `loadError` message. Failures only the webview can see (pdf.js rejects the file, the engine is too
// old, the password prompt was cancelled, a page fails) are rendered by the viewer itself; their
// wording lives here too as `PDF_VIEWER_TEXT` so there is one source for the §9.4 sentences —
// media/pdfViewer.js (PWP-08/11) copies them verbatim and its tests compare against this table.
//
// Type-only imports: the Node test runner can load this file directly (types are stripped).

import type { PdfLoadFailure } from './core/sniff.js';
import type { LoadErrorAction, LoadErrorView } from '../office/loadErrors.js';

export type { LoadErrorAction, LoadErrorView };

const MB = 1024 * 1024;

/** Whole megabytes, rounded up so that a file just over a limit never reads as the limit itself. */
export function formatMegabytes(size: number): string {
  return `${Math.ceil(size / MB)} MB`;
}

interface Entry {
  title: (size: number) => string;
  actions: LoadErrorAction[];
}

// Keyed by PdfLoadFailure: a new failure code without a message fails to type-check. Every entry
// offers "Open externally" (§9.4); "Retry" where the file may still be being written.
const TABLE: Record<PdfLoadFailure, Entry> = {
  'empty': { title: () => 'This file is empty.', actions: ['openExternally', 'retry'] },
  'not-pdf': { title: () => "This file isn't a PDF.", actions: ['openExternally'] },
  'too-large': {
    title: (size) => `This file is too large to open here (${formatMegabytes(size)}).`,
    actions: ['openExternally'],
  },
};

/** Every PdfLoadFailure code, in table order (for tests). */
export const PDF_LOAD_FAILURES: readonly PdfLoadFailure[] = Object.keys(TABLE) as PdfLoadFailure[];

export function describePdfLoadFailure(failure: PdfLoadFailure, size: number, detail: string): LoadErrorView {
  const e = TABLE[failure];
  return { title: e.title(size), detail, actions: e.actions.slice() };
}

/** The file itself could not be read (missing, permission denied, provider error). */
export function describePdfReadFailure(detail: string): LoadErrorView {
  return { title: "This file couldn't be read.", detail, actions: ['openExternally', 'retry'] };
}

/** An unexpected exception while opening: shown as damaged, never thrown. */
export function describePdfUnexpectedError(err: unknown): LoadErrorView {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { title: PDF_VIEWER_TEXT.damaged, detail, actions: ['openExternally', 'retry'] };
}

/** §9.4 sentences for failures the webview detects. The viewer shows them; the host never does. */
export const PDF_VIEWER_TEXT = Object.freeze({
  /** pdf.js `InvalidPDFException` or any load rejection; the technical reason goes under "Details". */
  damaged: "This file is damaged and can't be displayed.",
  /** §10.4 engine check failed. */
  engineTooOld: 'The PDF viewer needs a newer version of VS Code.',
  /** §9.1: the password prompt was cancelled. */
  passwordCancelled: 'This PDF is password-protected. Reopen it to enter the password, or open it externally.',
  /** §9.1: retry prompt after a wrong password. */
  passwordIncorrect: 'Incorrect password',
  /** §9.4: one page failed to render; the rest of the document works. */
  pageFailed: "This page couldn't be displayed",
});
