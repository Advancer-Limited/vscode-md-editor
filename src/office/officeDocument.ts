// OfficeDocument: the vscode.CustomDocument behind the Word and Excel viewers (spec §6.1).
//
// Phase 1 is read-only: the document holds the package as loaded from disk (or from a backup),
// watches the file, reloads when it changes on disk while clean, and never throws for bad content —
// a load failure is kept as `loadError` so the webview can show the §10.3 error view with
// "Open in Word/Excel" instead of VS Code's generic failure.

import * as vscode from 'vscode';
import { OfficePackage } from './core/package.js';
import type { OfficeKind } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { contentTypeOf } from './core/opc.js';
import { decodePart } from './core/xml.js';
import { LIMITS } from './core/limits.js';
import type { OfficeNotice, ReadOnlyReason } from './core/types.js';
import { editFlagFor } from './featureFlags.js';
import {
  appName, describeLoadFailure, describeReadFailure, describeUnexpectedError, doctypeDetail,
  unreadablePartDetail,
} from './loadErrors.js';
import type { LoadErrorView } from './loadErrors.js';

export type OfficeDocumentStateChange = { kind: 'reloaded' | 'notices' };

// ---------------------------------------------------------------------------------------------
// Pre-render DOCTYPE guard (spec §12)
//
// docx-preview parses parts with the webview's DOMParser, outside the host's XML parser and its
// DOCTYPE rejection. Before the original bytes go to the webview, every part docx-preview may read
// is scanned for `<!DOCTYPE` (case-insensitive, after decoding).

const DOCTYPE_RE = /<!doctype/i;

/** Parts the guard scans: XML content types (`+xml`, `/xml`), `.rels`, and any `*.xml` name. */
export function isScannedXmlPart(pkg: OfficePackage, part: string): boolean {
  const lower = part.toLowerCase();
  if (lower.endsWith('.rels') || lower.endsWith('.xml')) return true;
  let ct: string | undefined;
  try { ct = contentTypeOf(pkg, part); } catch { ct = undefined; }
  if (!ct) return false;
  const base = ct.toLowerCase().split(';')[0].trim();
  return base.endsWith('+xml') || base.endsWith('/xml');
}

/** True when the bytes contain `<!DOCTYPE` in any plausible decoding. */
export function bytesContainDoctype(bytes: Uint8Array): boolean {
  let lenient = false;
  try {
    const text = decodePart(bytes).text;
    if (DOCTYPE_RE.test(text)) return true;
    // NULs in "UTF-8" text suggest BOM-less UTF-16 that decodePart did not sniff.
    lenient = text.includes('\u0000');
  } catch {
    lenient = true;   // undecodable as declared
  }
  if (!lenient) return false;
  // The webview's reader decodes leniently, so look at every decoding it might use.
  for (const label of ['utf-8', 'utf-16le', 'utf-16be']) {
    if (DOCTYPE_RE.test(new TextDecoder(label, { fatal: false }).decode(bytes))) return true;
  }
  return false;
}

export interface DoctypeFinding { part: string; reason: 'doctype' | 'unreadable'; message: string; }

/**
 * Scan the parts docx-preview may read. Returns the first offending part, or null. A part that
 * cannot be inflated (bad CRC, corrupt data) is reported too: refuse rather than guess (§10.1).
 * Yields to the event loop between parts once more than ~2 MB has been scanned (§10.2).
 */
export async function findDoctypePart(pkg: OfficePackage): Promise<DoctypeFinding | null> {
  let sinceYield = 0;
  for (const part of pkg.partNames()) {
    if (!isScannedXmlPart(pkg, part)) continue;
    let bytes: Uint8Array;
    try {
      bytes = pkg.bytes(part);
    } catch (e) {
      return { part, reason: 'unreadable', message: e instanceof Error ? e.message : String(e) };
    }
    if (bytesContainDoctype(bytes)) return { part, reason: 'doctype', message: 'DOCTYPE declaration' };
    sinceYield += bytes.length;
    if (sinceYield > LIMITS.asyncParseThresholdBytes) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

function baseName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Candidate names of the lock file Word/Excel create next to an open document. */
export function siblingLockNames(name: string): string[] {
  if (name.startsWith('~$')) return [];
  // Excel: "~$" + full name. Word: "~$" + name with its first one or two characters dropped.
  const out = new Set<string>(['~$' + name]);
  if (name.length > 1) out.add('~$' + name.slice(1));
  if (name.length > 2) out.add('~$' + name.slice(2));
  return [...out];
}

export class OfficeDocument implements vscode.CustomDocument {
  /** Debounce for file-watcher events (Office writes a file in several steps). Tests set 0. */
  static diskCheckDelayMs = 300;

  readonly uri: vscode.Uri;
  readonly kind: OfficeKind;
  pkg: OfficePackage | null = null;
  loadError: LoadErrorView | null = null;
  /** Monotonic, starts at 0; +1 per external reload (and, from Phase 2, per edit/undo/redo/revert). */
  version = 0;
  /** +1 per load, revert or external reload; undo closures check it (§6.3). */
  generation = 0;
  diskStamp: { mtime: number; size: number } | null = null;
  readOnlyReason: ReadOnlyReason | null = null;
  /** Host-level notices (open in Office, changed on disk). Kind providers add their own. */
  notices: OfficeNotice[] = [];
  /** Whether the document has unsaved edits. Always false in Phase 1; the save pipeline replaces it. */
  isDirty: () => boolean = () => false;

  private readonly stateEmitter = new vscode.EventEmitter<OfficeDocumentStateChange>();
  readonly onDidChangeState: vscode.Event<OfficeDocumentStateChange> = this.stateEmitter.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private changedOnDisk = false;
  /** The last load could not read the source bytes at all. */
  private readFailed = false;
  private disposed = false;

  private constructor(uri: vscode.Uri, kind: OfficeKind) {
    this.uri = uri;
    this.kind = kind;
  }

  /** Open a document. Never throws for bad or unreadable content: see `loadError`. */
  static async create(uri: vscode.Uri, kind: OfficeKind, backupId: string | undefined): Promise<OfficeDocument> {
    const doc = new OfficeDocument(uri, kind);
    let source = uri;
    if (backupId) {
      try { source = vscode.Uri.parse(backupId, true); } catch { source = uri; }
    }
    await doc.load(source, false);
    if (doc.readFailed && source !== uri) await doc.load(uri, false);   // unreadable backup: fall back to the file
    doc.startWatching();
    return doc;
  }

  get fileName(): string { return baseName(this.uri); }

  /** Whether the scheme can be written. `undefined` (unknown provider) is treated as writable. */
  get writableScheme(): boolean {
    return vscode.workspace.fs.isWritableFileSystem(this.uri.scheme) !== false;
  }

  /** `init.canEdit`: the kind's flag is on, the package loaded, and nothing restricts it. */
  get canEdit(): boolean {
    return editFlagFor(this.kind) && this.pkg !== null && this.readOnlyReason === null;
  }

  /** Re-read from `uri` (Retry, external change while clean). Fires `reloaded` when it completes. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const applied = await this.load(this.uri, true);
    if (applied && !this.disposed) this.stateEmitter.fire({ kind: 'reloaded' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken++;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.watcher?.dispose();
    this.stateEmitter.dispose();
    this.pkg = null;
  }

  // -------------------------------------------------------------------------------------------

  /** Returns false when a later load superseded this one (its result is then discarded). */
  private async load(source: vscode.Uri, isReload: boolean): Promise<boolean> {
    const token = ++this.loadToken;
    let pkg: OfficePackage | null = null;
    let loadError: LoadErrorView | null = null;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await vscode.workspace.fs.readFile(source);
    } catch (e) {
      loadError = describeReadFailure(this.kind, errorText(e));
    }
    const stamp = await this.statDisk();
    if (bytes) {
      try {
        pkg = OfficePackage.open(this.fileName, bytes);
        if (pkg.kind !== this.kind) {
          throw new OfficeLoadError('unsupported-packaging', `The package is a ${pkg.kind} document, not ${this.kind}`);
        }
        if (this.kind === 'docx') {
          const bad = await findDoctypePart(pkg);
          if (bad) {
            throw new OfficeLoadError('damaged', bad.reason === 'doctype'
              ? doctypeDetail(bad.part) : unreadablePartDetail(bad.part, bad.message));
          }
        }
      } catch (e) {
        pkg = null;
        loadError = e instanceof OfficeLoadError
          ? describeLoadFailure(e.failure, this.kind, e.detail)
          : describeUnexpectedError(this.kind, e);
      }
    }
    const lockNotice = pkg ? await this.lockFileNotice() : null;
    if (token !== this.loadToken || this.disposed) return false;

    this.pkg = pkg;
    this.loadError = loadError;
    this.diskStamp = stamp;
    this.generation++;
    if (isReload) this.version++;
    this.changedOnDisk = false;
    this.readFailed = bytes === undefined;
    this.readOnlyReason = pkg
      ? (!this.writableScheme ? 'non-writable-scheme' : pkg.viewOnlyReason)
      : null;
    this.notices = lockNotice ? [lockNotice] : [];
    return true;
  }

  private async statDisk(): Promise<{ mtime: number; size: number } | null> {
    try {
      const s = await vscode.workspace.fs.stat(this.uri);
      return { mtime: s.mtime, size: s.size };
    } catch {
      return null;
    }
  }

  /** §10.3: a sibling `~$` lock file means the document is probably open in Word/Excel. */
  private async lockFileNotice(): Promise<OfficeNotice | null> {
    if (!this.writableScheme) return null;
    const dir = vscode.Uri.joinPath(this.uri, '..');
    for (const name of siblingLockNames(this.fileName)) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
        return {
          severity: 'warning',
          code: 'open-in-office',
          message: `This file appears to be open in ${appName(this.kind)}. Saving here may fail or conflict.`,
        };
      } catch {
        // not there
      }
    }
    return null;
  }

  private startWatching(): void {
    if (this.disposed || !this.writableScheme) return;   // git: and other read-only views never change
    try {
      const dir = vscode.Uri.joinPath(this.uri, '..');
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, this.fileName));
      w.onDidChange(() => this.scheduleDiskCheck());
      w.onDidCreate(() => this.scheduleDiskCheck());
      this.watcher = w;
    } catch (e) {
      console.warn('[OfficeDocument] could not watch', this.uri.toString(), e);
    }
  }

  private scheduleDiskCheck(): void {
    if (this.disposed) return;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = setTimeout(() => {
      this.diskTimer = undefined;
      this.onDiskChanged().catch((e) => console.error('[OfficeDocument] reload after disk change failed', e));
    }, OfficeDocument.diskCheckDelayMs);
  }

  /** §6.1: clean -> reload; dirty -> persistent "changed on disk" warning, state left alone. */
  private async onDiskChanged(): Promise<void> {
    if (this.disposed) return;
    const stamp = await this.statDisk();
    if (!stamp) return;   // deleted or unreadable: keep showing what we have
    const prev = this.diskStamp;
    if (prev && prev.mtime === stamp.mtime && prev.size === stamp.size) return;
    if (this.isDirty()) {
      if (this.changedOnDisk) return;
      this.changedOnDisk = true;
      this.notices = [...this.notices, {
        severity: 'warning',
        code: 'changed-on-disk',
        message: 'This file has changed on disk. Your unsaved changes are kept; saving will ask before overwriting.',
      }];
      this.stateEmitter.fire({ kind: 'notices' });
      return;
    }
    await this.reload();
  }
}
