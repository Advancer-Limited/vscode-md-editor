// Save-path messages and error mapping for the Office editors (spec §6.5, §10.3).
//
// Pure: type-only imports, so Node's type stripping loads this file directly in tests
// (tests/office/saveErrors.test.mjs). officeDocument.ts owns the VS Code side (modals, dialogs,
// file writes) and takes every user-facing sentence from here.

import type { OfficeKind } from './core/package.js';
import type { VerifyFailure } from './core/save.js';

function app(kind: OfficeKind): string {
  return kind === 'docx' ? 'Word' : 'Excel';
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

function errorName(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  const n = (e as { name?: unknown }).name;
  return typeof n === 'string' ? n : '';
}

/** Node errno codes that mean "another program holds the file" on Windows (and permission problems elsewhere). */
const IN_USE_ERRNO = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** `vscode.FileSystemError` codes with the same meaning. */
const IN_USE_FS_CODES = new Set(['NoPermissions', 'Unavailable']);

export type WriteErrorKind = 'in-use' | 'other';

/**
 * Classify a write failure (§10.3). `vscode.FileSystemError` carries its code in `code` and in
 * `name` ("NoPermissions (FileSystemError)"); the disk provider puts the Node errno in the message
 * ("EBUSY: resource busy or locked, …"); a raw Node error carries the errno in `code`.
 */
export function classifyWriteError(e: unknown): WriteErrorKind {
  const code = errorCode(e);
  if (code && (IN_USE_ERRNO.has(code) || IN_USE_FS_CODES.has(code))) return 'in-use';
  const name = /^(\w+) \(FileSystemError\)$/.exec(errorName(e));
  if (name && IN_USE_FS_CODES.has(name[1])) return 'in-use';
  if (/\b(EBUSY|EPERM|EACCES)\b/.test(errorText(e))) return 'in-use';
  return 'other';
}

/** The user-facing sentence for a failed write. The document stays dirty (the caller rethrows). */
export function writeErrorMessage(kind: OfficeKind, fileName: string, e: unknown): string {
  if (classifyWriteError(e) === 'in-use') {
    return `Couldn't save: the file is in use by another program (probably ${app(kind)}). Close it there and save again, or use Save As.`;
  }
  const detail = errorText(e).trim();
  return detail ? `Couldn't save ${fileName}: ${detail}` : `Couldn't save ${fileName}.`;
}

// ---------------------------------------------------------------------------------------------
// Verification failure (§6.5 step 4)

export const VERIFY_FAILED_MESSAGE = 'Save failed an internal consistency check — your file on disk was not changed.';
export const SAVE_DIAGNOSTICS_ACTION = 'Save a copy of diagnostics';
export const VERIFY_FAILED_BACKUP_MESSAGE = "Couldn't back up unsaved changes: they failed an internal consistency check.";

/** Default file name offered for the diagnostics file. */
export function diagnosticsFileName(fileName: string): string {
  return `${fileName}.save-diagnostics.txt`;
}

/**
 * The diagnostics file: failing part names and validator messages only — never document content
 * (§6.5). Validators report structural facts ("xl/worksheets/sheet1.xml: rows not ascending"), not
 * text from the document.
 */
export function diagnosticsText(info: {
  kind: OfficeKind; fileName: string; version: number; touched: readonly string[];
  failures: readonly VerifyFailure[]; when: Date; extensionVersion?: string;
}): string {
  const lines = [
    'VS Code MD Editor: Office save verification failure',
    `When: ${info.when.toISOString()}`,
    `File: ${info.fileName} (${info.kind})`,
    `Document version: ${info.version}`,
  ];
  if (info.extensionVersion) lines.push(`Extension version: ${info.extensionVersion}`);
  lines.push('', 'Changed parts:');
  if (info.touched.length === 0) lines.push('  (none)');
  for (const p of info.touched) lines.push(`  ${p}`);
  lines.push('', 'Failures:');
  for (const f of info.failures) lines.push(f.part ? `  [${f.part}] ${f.message}` : `  ${f.message}`);
  lines.push('', 'The file on disk was not changed. No document content is included in this report.', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Conflict on save (§6.5 step 2)

export const CONFLICT_OVERWRITE = 'Overwrite';
export const CONFLICT_REVERT = 'Revert to disk version';

export function conflictMessage(fileName: string): string {
  return `${fileName} has changed on disk since it was opened here.`;
}

export const CONFLICT_DETAIL = 'Overwrite replaces the version on disk with yours. Revert discards your unsaved changes and loads the version on disk.';

/** Whether the file on disk differs from the stamp recorded at load / last save. */
export function stampChanged(
  recorded: { mtime: number; size: number } | null,
  now: { mtime: number; size: number } | null,
): boolean {
  if (!recorded || !now) return false;   // nothing recorded, or the file is gone (the write recreates it)
  return recorded.mtime !== now.mtime || recorded.size !== now.size;
}

// ---------------------------------------------------------------------------------------------
// Other save-path messages

export const SAVE_BUSY_MESSAGE = 'The document is being saved. Try again in a moment.';
export const VIEW_MODE_MESSAGE = 'Press Edit (Ctrl+E) to make changes.';
export const READ_ONLY_MESSAGE = 'This document is open read-only.';
export const REVERTED_MESSAGE = 'Reverted to the version on disk.';

/** The persistent notice when the file changed on disk under unsaved changes (§6.1), or since a restored backup. */
export const CHANGED_ON_DISK_MESSAGE = 'This file has changed on disk. Your unsaved changes are kept; saving will ask before overwriting.';

/**
 * Appended to a write failure other than "in use" (§6.5 step 5, §10.3): the save writes in place,
 * so a write that failed part-way may have left the file incomplete. The changes are still open.
 */
export const PARTIAL_WRITE_NOTE = 'The file on disk may be incomplete. Your changes are still here: save again, or use Save As.';

/** §10.3: shown once when Edit is turned on for a digitally signed file. */
export function signedEditWarning(app: string): string {
  return `This file is digitally signed. Saving changes here will invalidate the signature; sign it again in ${app} if you need it.`;
}
