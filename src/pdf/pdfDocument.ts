// PdfDocument: the vscode.CustomDocument behind the PDF viewer (spec §6.1), read-only (PWP-05).
//
// Holds the bytes of this generation (`base`), the disk stamp, and the external-change watcher;
// reloads when the file changes on disk while clean. The host does NOT parse the PDF (plan rule 2,
// spec §6.1, §12): opening runs only `sniff`, and the webview's pdf.js does the rest. A load failure
// is kept as `loadError` (never thrown) so the webview can show the §9.4 error view.
//
// Lifecycle mirrors src/office/officeDocument.ts (and its Gate R0/R1 review fixes): stamp before
// read; refuse an over-limit file from its stat without reading it; watch a name with glob
// characters through its directory and filter by URI; a superseded load is discarded. That logic is
// deliberately duplicated rather than shared until PWP-13 extracts BinaryDocumentBase from
// officeDocument.ts; PdfDocument then derives from it and this file shrinks to the PDF members.

import * as vscode from 'vscode';
import { sniff, sizeFailure, sniffDetail, sizeClass } from './core/sniff.js';
import { sameFile } from '../office/officeDocument.js';
import type { OfficeDocumentStateChange } from '../office/officeDocument.js';
import type { OfficeNotice } from '../office/protocol.js';
import type { PdfReadOnlyReason } from './protocol.js';
import { PDF_FLAGS } from './featureFlags.js';
import type { PdfFlags } from './featureFlags.js';
import {
  describePdfLoadFailure, describePdfReadFailure, describePdfUnexpectedError, formatMegabytes,
} from './loadErrors.js';
import type { LoadErrorView } from './loadErrors.js';

function baseName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function statSize(uri: vscode.Uri): Promise<number | undefined> {
  try { return (await vscode.workspace.fs.stat(uri)).size; } catch { return undefined; }
}

/**
 * A plain `Uint8Array` owning exactly these bytes. A Node `Buffer` reaches the webview as
 * `{ type: 'Buffer', data: [...] }` (spike S8) and a view into a pooled buffer would carry the whole
 * pool, so anything else is copied — once, at load, not per post.
 */
export function plainBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor === Uint8Array && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes;
  }
  return new Uint8Array(bytes);
}

/** "Glob characters" that stop a file name from matching itself as a RelativePattern. */
const GLOB_CHARS_RE = /[[\]{}*?!]/;

export class PdfDocument implements vscode.CustomDocument {
  /** Debounce for file-watcher events (writers save in several steps). Tests set 0. */
  static diskCheckDelayMs = 300;
  /** Feature flags in effect. Test hook only; production always uses PDF_FLAGS. */
  static flags: PdfFlags = PDF_FLAGS;

  readonly uri: vscode.Uri;
  /** The bytes of this generation, as loaded (plain Uint8Array), or null after a load failure. */
  base: Uint8Array | null = null;
  loadError: LoadErrorView | null = null;
  /** Monotonic, starts at 0; +1 per external reload (and, from Phase 2, per edit/undo/redo/revert). */
  version = 0;
  /** +1 per load or reload; the webview tags its pdf.js document with it. */
  generation = 0;
  diskStamp: { mtime: number; size: number } | null = null;
  readOnlyReason: PdfReadOnlyReason | null = null;
  /** Host-level notices (large file, changed on disk). Facts-derived notices are the provider's. */
  notices: OfficeNotice[] = [];
  /** Always false while read-only; the Phase 2 save pipeline replaces it. */
  isDirty: () => boolean = () => false;

  private readonly stateEmitter = new vscode.EventEmitter<OfficeDocumentStateChange>();
  readonly onDidChangeState: vscode.Event<OfficeDocumentStateChange> = this.stateEmitter.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private changedOnDisk = false;
  private readFailed = false;
  private disposed = false;

  private constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  /** Open a document. Never throws for bad or unreadable content: see `loadError`. */
  static async create(uri: vscode.Uri, backupId: string | undefined): Promise<PdfDocument> {
    const doc = new PdfDocument(uri);
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

  /** Size of `base` in bytes (0 when not loaded). */
  get size(): number { return this.base?.byteLength ?? 0; }

  /** Whether the scheme can be written. `undefined` (unknown provider) is treated as writable. */
  get writableScheme(): boolean {
    return vscode.workspace.fs.isWritableFileSystem(this.uri.scheme) !== false;
  }

  /** `init.canEdit` (spec §6.2): the flag is on, the bytes loaded, nothing restricts it. */
  get canEdit(): boolean {
    return PdfDocument.flags.pdfEdit && this.base !== null && this.readOnlyReason === null;
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
    this.base = null;
  }

  // -------------------------------------------------------------------------------------------

  /** Returns false when a later load superseded this one (its result is then discarded). */
  private async load(source: vscode.Uri, isReload: boolean): Promise<boolean> {
    const token = ++this.loadToken;
    let base: Uint8Array | null = null;
    let loadError: LoadErrorView | null = null;
    let read = false;
    // Stamp BEFORE reading: a write landing between the read and a later stat would otherwise be
    // recorded as "already seen" and the watcher would skip the reload.
    const stamp = await this.statDisk();
    const sourceSize = source.toString() === this.uri.toString() ? stamp?.size : await statSize(source);
    // Refuse an over-limit file from its size alone, without reading 500 MB+ into the host.
    if (sourceSize !== undefined && sizeFailure(sourceSize) === 'too-large') {
      loadError = describePdfLoadFailure('too-large', sourceSize, sniffDetail('too-large', sourceSize));
    } else {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await vscode.workspace.fs.readFile(source);
        read = true;
      } catch (e) {
        loadError = describePdfReadFailure(errorText(e));
      }
      if (bytes) {
        try {
          const failure = sniff(bytes);
          if (failure) loadError = describePdfLoadFailure(failure, bytes.length, sniffDetail(failure, bytes.length));
          else base = plainBytes(bytes);
        } catch (e) {
          loadError = describePdfUnexpectedError(e);
        }
      }
    }
    if (token !== this.loadToken || this.disposed) return false;

    this.base = base;
    this.loadError = loadError;
    this.diskStamp = stamp;
    this.generation++;
    if (isReload) this.version++;
    this.changedOnDisk = false;
    this.readFailed = !read;
    this.readOnlyReason = base ? this.restriction(base.byteLength) : null;
    this.notices = base && sizeClass(base.byteLength).large ? [largeFileNotice(base.byteLength)] : [];
    return true;
  }

  /** Host-known view-only reasons. `encrypted`, `unsupported-structure` and `engine-too-old` come later (§6.2, §10.4). */
  private restriction(size: number): PdfReadOnlyReason | null {
    if (!this.writableScheme) return 'non-writable-scheme';
    if (sizeClass(size).viewOnly) return 'too-large';
    return null;
  }

  private async statDisk(): Promise<{ mtime: number; size: number } | null> {
    try {
      const s = await vscode.workspace.fs.stat(this.uri);
      return { mtime: s.mtime, size: s.size };
    } catch {
      return null;
    }
  }

  private startWatching(): void {
    if (this.disposed || !this.writableScheme) return;   // git: and other read-only views never change
    try {
      const dir = vscode.Uri.joinPath(this.uri, '..');
      // RelativePattern takes a glob, so "Report [draft].pdf" would never match itself: such names
      // watch the directory (non-recursive) and filter events by URI.
      const pattern = GLOB_CHARS_RE.test(this.fileName) ? '*' : this.fileName;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, pattern));
      const onEvent = (u: vscode.Uri): void => { if (sameFile(u, this.uri)) this.scheduleDiskCheck(); };
      w.onDidChange(onEvent);
      w.onDidCreate(onEvent);
      this.watcher = w;
    } catch (e) {
      console.warn('[PdfDocument] could not watch', this.uri.toString(), e);
    }
  }

  private scheduleDiskCheck(): void {
    if (this.disposed) return;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = setTimeout(() => {
      this.diskTimer = undefined;
      this.onDiskChanged().catch((e) => console.error('[PdfDocument] reload after disk change failed', e));
    }, PdfDocument.diskCheckDelayMs);
  }

  /** Clean -> reload; dirty (Phase 2) -> persistent "changed on disk" warning, state left alone. */
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

/** §9.3: over 150 MB opens with a notice; thumbnails are not pre-rendered. */
export function largeFileNotice(size: number): OfficeNotice {
  return {
    severity: 'info',
    code: 'large-file',
    message: `This is a large file (${formatMegabytes(size)}). Page thumbnails are drawn only when you scroll to them.`,
  };
}
