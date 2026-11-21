// OfficeDocument: the vscode.CustomDocument behind the Word and Excel viewers (spec §6.1).
//
// The document holds the package as loaded from disk (or from a backup), watches the file, reloads
// when it changes on disk while clean, and never throws for bad content — a load failure is kept as
// `loadError` so the webview can show the §10.3 error view with "Open in Word/Excel" instead of
// VS Code's generic failure.
//
// WP-19 (spec §6.2–6.5): edits with generation-guarded undo/redo fired for VS Code's undo stack, a
// mirror of VS Code's dirty bookkeeping (for the watcher), Edit mode, the flush handshake, and the
// save pipeline — conflict check, serialise + verify (never write unverified bytes), atomic write,
// error mapping (saveErrors.ts) — plus revert and hot-exit backup. Reachable only while the kind's
// edit flag is on (featureFlags.ts); the provider registers as read-only otherwise.

import * as vscode from 'vscode';
import { OfficePackage } from './core/package.js';
import type { OfficeKind } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { contentTypeOf } from './core/opc.js';
import { decodePart } from './core/xml.js';
import { LIMITS } from './core/limits.js';
import type { OfficeError, OfficeNotice, ReadOnlyReason } from './core/types.js';
import { EditBuilder, tryApplyEdit, undoRedoFor } from './core/edits.js';
import type { EditOutcome, EditTarget, OfficeEdit } from './core/edits.js';
import { serializeAndVerify } from './core/save.js';
import type { Validator, VerifyFailure, VerifyResult } from './core/save.js';
import { editFlagFor } from './featureFlags.js';
import {
  appName, describeLoadFailure, describeReadFailure, describeUnexpectedError, doctypeDetail,
  unreadablePartDetail,
} from './loadErrors.js';
import type { LoadErrorView } from './loadErrors.js';
import {
  CONFLICT_DETAIL, CONFLICT_OVERWRITE, CONFLICT_REVERT, READ_ONLY_MESSAGE, REVERTED_MESSAGE, SAVE_BUSY_MESSAGE,
  SAVE_DIAGNOSTICS_ACTION, VERIFY_FAILED_BACKUP_MESSAGE, VERIFY_FAILED_MESSAGE, VIEW_MODE_MESSAGE, conflictMessage,
  diagnosticsFileName, diagnosticsText, stampChanged, tempKeptMessage, writeErrorMessage,
} from './saveErrors.js';

/**
 * `reloaded`: a new package (load, retry, revert, external reload) — re-send `init` and state.
 * `edited`: undo/redo changed the package in place — post `…StateChanged`.
 * `notices`: host notices changed.
 */
export type OfficeDocumentStateChange = { kind: 'reloaded' | 'edited' | 'notices' };

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

/** Size of `uri` in bytes, or undefined when it cannot be stat'ed (the read then reports the error). */
async function statSize(uri: vscode.Uri): Promise<number | undefined> {
  try { return (await vscode.workspace.fs.stat(uri)).size; } catch { return undefined; }
}

/** Whether two URIs name the same file (case-insensitive paths for `file:` on Windows). */
export function sameFile(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme || a.authority !== b.authority) return false;
  return a.scheme === 'file' && process.platform === 'win32'
    ? a.path.toLowerCase() === b.path.toLowerCase()
    : a.path === b.path;
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

/** Kind-specific save hooks a provider passes to its documents (plan WP-19). */
export interface OfficeDocumentHooks {
  /** Format validators run on the re-opened output of every save and backup (spec §6.5 step 4, §13.3). */
  validators(): Validator[];
  /**
   * Applied (through `b`) to the package before each serialisation of a changed package, then
   * rolled back, so the output carries it but the in-memory state and the undo stack do not
   * (xlsx: `fullCalcOnLoad`, calc chain removal, spec §6.5, §9.5). Must be idempotent and synchronous.
   */
  beforeFirstSerialize?(b: EditBuilder): void;
  /** `vscodeMdEditor.office.startInEditMode`, read when the document opens. */
  startInEditMode?(): boolean;
}

/** One applied edit, as the provider forwards it to VS Code (`CustomDocumentEditEvent` minus `document`). */
export interface OfficeEditEvent {
  readonly label: string;
  undo(): void;
  redo(): void;
}

export type DocumentEditResult = { ok: true; edit: OfficeEdit | null } | { ok: false; error: OfficeError };

/** Test seam and the Gate R2 verification-failure hook (spec §14 Phase 2). */
export interface SaveTestHooks {
  /** Receives a copy of the serialised bytes; what it returns is verified instead. */
  corrupt?(bytes: Uint8Array): Uint8Array;
}

/**
 * `VSMD_OFFICE_CORRUPT_SAVE=1` in the Extension Development Host's environment flips one byte of
 * every serialised output, so the verification-failure UX can be checked by hand (Gate R2). It can
 * only make saves fail, never write anything.
 */
export function envSaveHooks(env: Record<string, string | undefined> | undefined): SaveTestHooks | undefined {
  if (env?.VSMD_OFFICE_CORRUPT_SAVE !== '1') return undefined;
  return {
    corrupt(bytes: Uint8Array): Uint8Array {
      if (bytes.length > 0) bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      return bytes;
    },
  };
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Thrown by the atomic write; carries whether the temporary copy was kept. */
class WriteFailure extends Error {
  constructor(readonly original: unknown, readonly keptTemp: string | null) {
    super(errorText(original));
  }
}

interface PendingFlush { remaining: number; done(): void; }

export class OfficeDocument implements vscode.CustomDocument {
  /** Debounce for file-watcher events (Office writes a file in several steps). Tests set 0. */
  static diskCheckDelayMs = 300;
  /** How long a save/backup waits for `flushed` before going on with the committed state (§6.5). */
  static flushTimeoutMs = 1500;
  /** See SaveTestHooks. Tests assign it; the environment variable sets it for manual checks. */
  static saveHooks: SaveTestHooks | undefined = envSaveHooks(typeof process === 'undefined' ? undefined : process.env);

  readonly uri: vscode.Uri;
  readonly kind: OfficeKind;
  pkg: OfficePackage | null = null;
  loadError: LoadErrorView | null = null;
  /** Monotonic, starts at 0; +1 per applied edit, undo, redo, revert and external reload (§5). */
  version = 0;
  /** +1 per load, revert or external reload; undo closures check it (§6.3). */
  generation = 0;
  diskStamp: { mtime: number; size: number } | null = null;
  readOnlyReason: ReadOnlyReason | null = null;
  /** Host-level notices (open in Office, changed on disk). Kind providers add their own. */
  notices: OfficeNotice[] = [];
  /** Edit mode (§6.4). Only ever true while `canEdit`. */
  editMode = false;
  /**
   * Whether the document has unsaved edits, as VS Code sees it. VS Code owns the dirty flag; this
   * mirrors its bookkeeping (edit index vs. save point, "restored from backup") so the file watcher
   * can choose between reloading and warning (§6.1). Errs towards dirty. Assignable for tests.
   */
  isDirty: () => boolean = () => this.fromBackup || this.position !== this.savedPosition;

  private readonly stateEmitter = new vscode.EventEmitter<OfficeDocumentStateChange>();
  readonly onDidChangeState: vscode.Event<OfficeDocumentStateChange> = this.stateEmitter.event;
  private readonly editEmitter = new vscode.EventEmitter<OfficeEditEvent>();
  /** Fired once per applied edit; the provider forwards it as `onDidChangeCustomDocument`. */
  readonly onDidEdit: vscode.Event<OfficeEditEvent> = this.editEmitter.event;

  private readonly hooks: OfficeDocumentHooks;
  private watcher: vscode.FileSystemWatcher | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private changedOnDisk = false;
  /** The last load could not read the source bytes at all. */
  private readFailed = false;
  private disposed = false;

  // Dirty mirror (see isDirty): edits applied net of undos, and where the save point is.
  private position = 0;
  private savedPosition = 0;
  private fromBackup = false;

  /** Verified serialisation of the current state, keyed by version and generation (§6.2 backup). */
  private serialCache: { version: number; generation: number; result: VerifyResult } | undefined;
  /** Saves between their flush and their completion; edits are refused meanwhile (editRefusal). */
  private writing = 0;
  /** Resolved when `writing` drops to 0 (or the document is disposed): edits waiting for a save (B1). */
  private writeIdleWaiters: Array<() => void> = [];
  private diskCheckAfterWrite = false;
  private lastBackupFailure = -1;

  private readonly flushTargets = new Set<(flushId: number) => boolean>();
  private readonly pendingFlushes = new Map<number, PendingFlush>();
  private flushSeq = 0;

  private constructor(uri: vscode.Uri, kind: OfficeKind, hooks: OfficeDocumentHooks) {
    this.uri = uri;
    this.kind = kind;
    this.hooks = hooks;
  }

  /** Open a document. Never throws for bad or unreadable content: see `loadError`. */
  static async create(
    uri: vscode.Uri, kind: OfficeKind, backupId: string | undefined, hooks?: OfficeDocumentHooks,
  ): Promise<OfficeDocument> {
    const doc = new OfficeDocument(uri, kind, hooks ?? { validators: () => [] });
    let source = uri;
    if (backupId) {
      try { source = vscode.Uri.parse(backupId, true); } catch { source = uri; }
    }
    await doc.load(source, false);
    if (doc.readFailed && source !== uri) await doc.load(uri, false);   // unreadable backup: fall back to the file
    // VS Code restores a document opened from a backup as dirty (§6.2), whatever we could read.
    doc.fromBackup = backupId !== undefined;
    let start = false;
    try { start = doc.hooks.startInEditMode?.() === true; } catch { start = false; }
    doc.editMode = start && doc.canEdit;
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

  /** Switch Edit mode (§6.4); refused (false) unless `canEdit`. Returns the mode now in effect. */
  setEditMode(on: boolean): boolean {
    this.editMode = on && this.canEdit;
    return this.editMode;
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
    for (const p of [...this.pendingFlushes.values()]) p.done();
    this.releaseWriteIdleWaiters();
    this.flushTargets.clear();
    this.stateEmitter.dispose();
    this.editEmitter.dispose();
    this.serialCache = undefined;
    this.pkg = null;
  }

  // -------------------------------------------------------------------------------------------
  // Edits (spec §6.3)

  /** Why an edit cannot be applied now, or null. */
  private editRefusal(): OfficeError | null {
    if (this.disposed || !this.pkg || !this.canEdit) return { code: 'read-only', message: READ_ONLY_MESSAGE };
    if (!this.editMode) return { code: 'read-only', message: VIEW_MODE_MESSAGE };
    // Between a save's flush and its completion the bytes being written are fixed; an edit landing
    // then would be marked saved by VS Code without being on disk.
    if (this.writing > 0) return { code: 'blocked', message: SAVE_BUSY_MESSAGE };
    return null;
  }

  /**
   * Resolves once no save is writing: at once when none is, else when the last one finishes (or the
   * document is disposed). Never rejects.
   */
  whenNotWriting(): Promise<void> {
    if (this.writing === 0 || this.disposed) return Promise.resolve();
    return new Promise((resolve) => { this.writeIdleWaiters.push(resolve); });
  }

  /**
   * Review B1: why an edit cannot be applied, after waiting out any save that is writing. A save in
   * progress is not a reason to refuse an edit the user already made (the webview would drop the
   * typed text); providers call this from their per-document edit queue, so the edit still lands in
   * arrival order, just after the bytes being written. A save that starts while the caller is between
   * this check and applying the edit is caught by the synchronous refusal in edit/applyEdit/recordApplied.
   */
  async editRefusalAfterSave(): Promise<OfficeError | null> {
    while (this.writing > 0 && !this.disposed) await this.whenNotWriting();
    return this.editRefusal();
  }

  /**
   * Build an edit with `build` against the current package and record it. `build` returns an
   * OfficeError to refuse (everything it did is rolled back); a throw is rolled back and reported as
   * `internal`. No edit is recorded and no event fired when nothing changed (§6.3).
   */
  edit(label: string, build: (b: EditBuilder) => OfficeError | void): DocumentEditResult {
    const refusal = this.editRefusal();
    if (refusal) return { ok: false, error: refusal };
    const b = new EditBuilder(this.pkg!, label);
    let refused: OfficeError | void;
    try {
      refused = build(b);
    } catch (e) {
      b.abort();
      return { ok: false, error: { code: 'internal', message: errorText(e) } };
    }
    if (refused) {
      b.abort();
      return { ok: false, error: refused };
    }
    const edit = b.finish();
    if (edit) this.record(edit);
    return { ok: true, edit };
  }

  /** Apply a prepared (not yet applied) edit atomically and record it. */
  applyEdit(edit: OfficeEdit): DocumentEditResult {
    const refusal = this.editRefusal();
    if (refusal) return { ok: false, error: refusal };
    if (edit.changes.length === 0) return { ok: true, edit: null };
    const r = tryApplyEdit(this.pkg!, edit);
    if (!r.ok) return r;
    this.record(edit);
    return { ok: true, edit };
  }

  /** Bump the version, track the dirty mirror and fire the edit event with guarded undo/redo. */
  private record(edit: OfficeEdit): void {
    // A save point on the discarded redo branch can never be reached again.
    if (this.savedPosition > this.position) this.savedPosition = Number.NEGATIVE_INFINITY;
    this.position++;
    this.version++;
    const target = this.editTarget();
    const guarded = undoRedoFor(target, edit);
    this.editEmitter.fire({
      label: edit.label,
      undo: () => { this.position--; this.afterUndoRedo(guarded.undo()); },
      redo: () => { this.position++; this.afterUndoRedo(guarded.redo()); },
    });
  }

  /** What undo/redo closures read when they run. A disposed document matches no generation. */
  private editTarget(): EditTarget {
    const doc = this;
    return {
      get pkg(): OfficePackage { return doc.pkg as OfficePackage; },
      get generation(): number { return doc.disposed || !doc.pkg ? -1 : doc.generation; },
    };
  }

  private afterUndoRedo(r: EditOutcome): void {
    if (this.disposed) return;
    if (!r.ok) {
      // VS Code has already moved its undo pointer; the closure changes nothing and says so (§6.3).
      void vscode.window.showWarningMessage(r.error.message);
      return;
    }
    this.version++;
    this.stateEmitter.fire({ kind: 'edited' });
  }

  // -------------------------------------------------------------------------------------------
  // Flush handshake (spec §5 flushPendingEdits / flushed, §6.5 step 1)

  /**
   * Register a webview that can be asked to flush. `post` sends `flushPendingEdits` and returns
   * whether it was sent (a webview that is not ready yet has nothing pending).
   */
  addFlushTarget(post: (flushId: number) => boolean): vscode.Disposable {
    this.flushTargets.add(post);
    return { dispose: () => { this.flushTargets.delete(post); } };
  }

  /** A webview answered `flushed`. Unknown or late ids are ignored. */
  flushed(flushId: number): void {
    const p = this.pendingFlushes.get(flushId);
    if (p && --p.remaining <= 0) p.done();
  }

  /** Ask every webview to land its pending commits; resolves on all `flushed` or after the timeout. */
  async flush(): Promise<void> {
    if (this.disposed || this.flushTargets.size === 0) return;
    const id = ++this.flushSeq;
    let remaining = 0;
    for (const post of [...this.flushTargets]) {
      try { if (post(id)) remaining++; } catch { /* disposed webview */ }
    }
    if (remaining === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.pendingFlushes.delete(id);
        resolve();
      };
      const timer = setTimeout(done, OfficeDocument.flushTimeoutMs);
      this.pendingFlushes.set(id, { remaining, done });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Save pipeline (spec §6.5)

  /** The verified bytes of the current state (cached per version), or the verification failures. */
  serializeVerified(): VerifyResult {
    const pkg = this.pkg;
    if (!pkg) return { ok: false, failures: [{ message: 'The document is not loaded.' }] };
    const test = OfficeDocument.saveHooks;
    const c = this.serialCache;
    if (!test && c && c.version === this.version && c.generation === this.generation) return c.result;
    const result = this.computeSerialization(pkg, test);
    this.serialCache = test ? undefined : { version: this.version, generation: this.generation, result };
    return result;
  }

  private computeSerialization(pkg: OfficePackage, test: SaveTestHooks | undefined): VerifyResult {
    let validators: Validator[];
    try {
      validators = this.hooks.validators();
    } catch (e) {
      return { ok: false, failures: [{ message: `Validators unavailable: ${errorText(e)}` }] };
    }
    const prepare = this.hooks.beforeFirstSerialize;
    if (prepare) {
      // Only a package whose content changed gets the save-time preparation: an unchanged one
      // (no edits, or every edit undone) is written as its original bytes (G0).
      let plain: Uint8Array;
      try {
        plain = pkg.serialize();
      } catch (e) {
        return { ok: false, failures: [{ message: `Serialisation failed: ${errorText(e)}` }] };
      }
      if (plain !== pkg.originalBytes) {
        const b = new EditBuilder(pkg, 'Prepare save');
        try {
          prepare.call(this.hooks, b);
          return serializeAndVerify(pkg, validators, test);
        } catch (e) {
          return { ok: false, failures: [{ message: `Preparing the save failed: ${errorText(e)}` }] };
        } finally {
          b.abort();   // the preparation lives in the bytes only, never in the document
        }
      }
    }
    return serializeAndVerify(pkg, validators, test);
  }

  /** `saveCustomDocument`. Rejects (the document stays dirty) on conflict-cancel, verification or write failure. */
  async save(cancellation?: vscode.CancellationToken): Promise<void> {
    await this.saveTo(this.uri, cancellation);
  }

  /** `saveCustomDocumentAs`. With no edits the original bytes are written verbatim (G0). */
  async saveAs(destination: vscode.Uri, cancellation?: vscode.CancellationToken): Promise<void> {
    await this.saveTo(destination, cancellation);
  }

  private async saveTo(target: vscode.Uri, cancellation: vscode.CancellationToken | undefined): Promise<void> {
    if (!this.pkg) throw new Error(`Couldn't save ${this.fileName}: the file could not be loaded.`);
    const own = target.toString() === this.uri.toString();
    await this.flush();
    if (cancellation?.isCancellationRequested) throw new vscode.CancellationError();
    this.writing++;
    try {
      if (own) await this.checkConflict();
      if (cancellation?.isCancellationRequested) throw new vscode.CancellationError();
      const result = this.serializeVerified();
      if (!result.ok) {
        void this.reportVerifyFailure(result.failures);
        // Already explained to the user: a cancellation keeps the document dirty without a second message.
        throw new vscode.CancellationError();
      }
      try {
        await this.writeAtomic(target, result.bytes);
      } catch (e) {
        const w = e instanceof WriteFailure ? e : new WriteFailure(e, null);
        const msg = writeErrorMessage(this.kind, baseName(target), w.original);
        throw new Error(w.keptTemp ? `${msg} ${tempKeptMessage(w.keptTemp)}` : msg);
      }
      if (own) {
        this.diskStamp = await this.statDisk();
        if (this.changedOnDisk) {
          this.changedOnDisk = false;
          this.notices = this.notices.filter((n) => n.code !== 'changed-on-disk');
          this.stateEmitter.fire({ kind: 'notices' });
        }
      }
      // VS Code moves its save point to the current edit when the save resolves.
      this.savedPosition = this.position;
      this.fromBackup = false;
    } finally {
      this.writing--;
      this.afterWrite();
    }
  }

  /** §6.5 step 2: the file changed on disk since load / last save → Overwrite / Revert / Cancel. */
  private async checkConflict(): Promise<void> {
    const now = await this.statDisk();
    if (!stampChanged(this.diskStamp, now)) return;
    const choice = await vscode.window.showWarningMessage(
      conflictMessage(this.fileName), { modal: true, detail: CONFLICT_DETAIL }, CONFLICT_OVERWRITE, CONFLICT_REVERT,
    );
    if (choice === CONFLICT_OVERWRITE) return;
    if (choice === CONFLICT_REVERT) this.revertAfterConflict();
    throw new vscode.CancellationError();
  }

  /**
   * "Revert to disk version" from the conflict modal. The save is rejected first; then, when this
   * document is the active editor, VS Code's own Revert runs (it calls revertCustomDocument and
   * clears the dirty flag). Otherwise the document reverts itself; VS Code may then still show it
   * dirty until the next save or close.
   */
  private revertAfterConflict(): void {
    setTimeout(() => {
      if (this.disposed) return;
      let active = false;
      try {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        active = input instanceof vscode.TabInputCustom && input.uri.toString() === this.uri.toString();
      } catch {
        active = false;
      }
      if (active) {
        void vscode.commands.executeCommand('workbench.action.files.revert');
        return;
      }
      this.revert().then(
        () => { void vscode.window.showInformationMessage(REVERTED_MESSAGE); },
        (e) => console.error('[OfficeDocument] revert after conflict failed', e),
      );
    }, 0);
  }

  /** §6.5 step 4 failure UX: message with "Save a copy of diagnostics" (failing parts and messages only). */
  private async reportVerifyFailure(failures: readonly VerifyFailure[]): Promise<void> {
    console.error('[OfficeDocument] save verification failed', this.uri.toString(), failures);
    const touched = this.pkg?.touchedParts() ?? [];
    const version = this.version;
    const choice = await vscode.window.showErrorMessage(VERIFY_FAILED_MESSAGE, SAVE_DIAGNOSTICS_ACTION);
    if (choice !== SAVE_DIAGNOSTICS_ACTION) return;
    const dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(this.uri, '..', diagnosticsFileName(this.fileName)),
      filters: { Text: ['txt'] },
    });
    if (!dest) return;
    const text = diagnosticsText({ kind: this.kind, fileName: this.fileName, version, touched, failures, when: new Date() });
    try {
      await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(text));
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't write the diagnostics file: ${errorText(e)}`);
    }
  }

  /**
   * Write `bytes` to `target` without ever leaving a partly written file there: write a sibling
   * temporary file, then rename it over the target. On failure the temporary file is removed,
   * unless the target is gone too (a file system that deletes before renaming failed half way);
   * then it is kept and named in the error, because it is the only complete copy.
   */
  private async writeAtomic(target: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const fs = vscode.workspace.fs;
    const tmpName = `${baseName(target)}.${randomTag()}.vsmd-tmp`;
    const tmp = vscode.Uri.joinPath(target, '..', tmpName);
    const exists = async (u: vscode.Uri): Promise<boolean> => {
      try { await fs.stat(u); return true; } catch { return false; }
    };
    const remove = async (u: vscode.Uri): Promise<void> => {
      try { await fs.delete(u); } catch { /* best effort */ }
    };
    try {
      await fs.writeFile(tmp, bytes);
    } catch (e) {
      await remove(tmp);
      throw new WriteFailure(e, null);
    }
    const existed = await exists(target);
    try {
      await fs.rename(tmp, target, { overwrite: true });
    } catch (e) {
      if (existed && !(await exists(target))) throw new WriteFailure(e, tmpName);
      await remove(tmp);
      throw new WriteFailure(e, null);
    }
  }

  /** `revertCustomDocument`: re-read from `uri`, new package, version and generation bumped (§6.2). */
  async revert(_cancellation?: vscode.CancellationToken): Promise<void> {
    if (this.disposed) return;
    const applied = await this.load(this.uri, true);
    // VS Code sets its edit index back to the save point: the document is clean.
    this.savedPosition = this.position;
    this.fromBackup = false;
    if (applied && !this.disposed) this.stateEmitter.fire({ kind: 'reloaded' });
  }

  /** `backupCustomDocument`: verified serialisation (cached per version) written to `destination`. */
  async backup(destination: vscode.Uri, cancellation?: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    await this.flush();
    if (cancellation?.isCancellationRequested) throw new vscode.CancellationError();
    if (!this.pkg) throw new Error(`Couldn't back up ${this.fileName}: the file could not be loaded.`);
    const result = this.serializeVerified();
    if (!result.ok) {
      console.error('[OfficeDocument] backup verification failed', this.uri.toString(), result.failures);
      if (this.lastBackupFailure !== this.version) {
        this.lastBackupFailure = this.version;
        void vscode.window.showErrorMessage(VERIFY_FAILED_BACKUP_MESSAGE);
      }
      throw new Error(VERIFY_FAILED_BACKUP_MESSAGE);
    }
    await vscode.workspace.fs.writeFile(destination, result.bytes);
    return {
      id: destination.toString(),
      delete: () => {
        vscode.workspace.fs.delete(destination).then(undefined, () => { /* already gone */ });
      },
    };
  }

  private afterWrite(): void {
    if (this.writing === 0 && this.diskCheckAfterWrite) {
      this.diskCheckAfterWrite = false;
      this.scheduleDiskCheck();
    }
    if (this.writing === 0) this.releaseWriteIdleWaiters();
  }

  private releaseWriteIdleWaiters(): void {
    const waiters = this.writeIdleWaiters;
    this.writeIdleWaiters = [];
    for (const w of waiters) w();
  }

  // -------------------------------------------------------------------------------------------

  /** Returns false when a later load superseded this one (its result is then discarded). */
  private async load(source: vscode.Uri, isReload: boolean): Promise<boolean> {
    const token = ++this.loadToken;
    let pkg: OfficePackage | null = null;
    let loadError: LoadErrorView | null = null;
    let bytes: Uint8Array | undefined;
    // Stamp the file BEFORE reading it: a write that lands between the read and a later stat would
    // otherwise be recorded as "already seen" and the watcher would skip the reload (stale view).
    const stamp = await this.statDisk();
    // Refuse an over-limit file from its size alone, without reading 250 MB+ into the host.
    const sourceSize = source.toString() === this.uri.toString() ? stamp?.size : await statSize(source);
    if (sourceSize !== undefined && sourceSize > LIMITS.maxFileBytes) {
      loadError = describeLoadFailure('too-large', this.kind,
        `File is ${sourceSize} bytes; the limit is ${LIMITS.maxFileBytes}`);
    } else {
      try {
        bytes = await vscode.workspace.fs.readFile(source);
      } catch (e) {
        loadError = describeReadFailure(this.kind, errorText(e));
      }
    }
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
    this.serialCache = undefined;
    this.changedOnDisk = false;
    this.readFailed = bytes === undefined;
    this.readOnlyReason = pkg
      ? (!this.writableScheme ? 'non-writable-scheme' : pkg.viewOnlyReason)
      : null;
    this.notices = lockNotice ? [lockNotice] : [];
    if (!this.canEdit) this.editMode = false;
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
      // RelativePattern takes a glob, so a name like "Budget [2024].xlsx" would never match itself.
      // Such names watch the whole directory (non-recursive) and filter events by URI instead.
      const pattern = /[[\]{}*?!]/.test(this.fileName) ? '*' : this.fileName;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, pattern));
      const onEvent = (u: vscode.Uri): void => { if (sameFile(u, this.uri)) this.scheduleDiskCheck(); };
      w.onDidChange(onEvent);
      w.onDidCreate(onEvent);
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
    if (this.writing > 0) {
      // Our own save is in flight (its rename fires the watcher): look again when it is done.
      this.diskCheckAfterWrite = true;
      return;
    }
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
