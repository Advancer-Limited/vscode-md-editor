// Load-failure text for the Office error view (spec §10.3).
//
// Maps a core `LoadFailure` (plus the two host-only cases: the file could not be read, and an
// unexpected exception while opening) to the `loadError` message the webview shows: a plain title,
// the technical reason for the "Details" disclosure, and the actions offered.
//
// Type-only imports: the Node test runner loads this file directly (types are stripped).

import type { LoadFailure } from './core/sniff.js';
import type { OfficeKind } from './core/package.js';

export type LoadErrorAction = 'openExternally' | 'retry';

/** The payload of a `loadError` message (protocol §5) minus its `type`. */
export interface LoadErrorView {
  title: string;
  /** Technical reason; never document content. */
  detail: string;
  actions: LoadErrorAction[];
}

/** "Word" or "Excel". */
export function appName(kind: OfficeKind): 'Word' | 'Excel' {
  return kind === 'docx' ? 'Word' : 'Excel';
}

interface Entry {
  title: (kind: OfficeKind) => string;
  actions: LoadErrorAction[];
}

// A Record keyed by LoadFailure, so adding a failure code to the core without a message here fails
// to type-check. Every entry offers "Open in Word/Excel" (§10.3: "all load problems ... an Open in
// Word/Excel button"); "Retry" only where the file may be mid-write (a copy or sync in progress).
const TABLE: Record<LoadFailure, Entry> = {
  'encrypted-ole': {
    title: (k) => `This file is password-protected. Open it in ${appName(k)} to view it.`,
    actions: ['openExternally'],
  },
  'legacy-ole': {
    title: (k) => `This looks like an older ${k === 'docx' ? '.doc' : '.xls'} file saved with a .${k} name.`,
    actions: ['openExternally'],
  },
  'lock-file': {
    title: (k) => `This is a temporary lock file created by ${appName(k)}, not a document.`,
    actions: ['openExternally'],
  },
  'damaged': {
    title: () => "This file is damaged and can't be displayed.",
    actions: ['openExternally', 'retry'],
  },
  'unsupported-packaging': {
    title: () => "This file uses a packaging feature this viewer doesn't support.",
    actions: ['openExternally'],
  },
  'empty': {
    title: () => 'This file is empty.',
    actions: ['openExternally', 'retry'],
  },
  // §10.2 "Refuse to open (error view)"; §10.3 gives no wording for this case.
  'too-large': {
    title: (k) => `This file is too large to display here. Open it in ${appName(k)} to view it.`,
    actions: ['openExternally'],
  },
};

/** Every LoadFailure code, in table order (for tests and exhaustive UI checks). */
export const LOAD_FAILURES: readonly LoadFailure[] = Object.keys(TABLE) as LoadFailure[];

export function describeLoadFailure(failure: LoadFailure, kind: OfficeKind, detail: string): LoadErrorView {
  const e = TABLE[failure] ?? TABLE.damaged;
  return { title: e.title(kind), detail, actions: e.actions.slice() };
}

/** The file itself could not be read (missing, permission denied, provider error). */
export function describeReadFailure(_kind: OfficeKind, detail: string): LoadErrorView {
  return { title: "This file couldn't be read.", detail, actions: ['openExternally', 'retry'] };
}

/** An exception that is not an OfficeLoadError while opening: shown as damaged, never thrown. */
export function describeUnexpectedError(kind: OfficeKind, err: unknown): LoadErrorView {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return describeLoadFailure('damaged', kind, detail);
}

/** Detail for a part refused by the pre-render DOCTYPE guard (spec §12). */
export function doctypeDetail(part: string): string {
  return `Part "${part}" contains a DOCTYPE declaration (not allowed in Office documents)`;
}

/** Detail for a part the pre-render guard could not read (bad CRC, inflate failure). */
export function unreadablePartDetail(part: string, reason: string): string {
  return `Part "${part}" could not be read: ${reason}`;
}
