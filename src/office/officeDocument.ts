// OfficeDocument: the vscode.CustomDocument behind the Word and Excel viewers (spec §6.1).
//
// The document holds the package as loaded from disk (or from a backup), watches the file, reloads
// when it changes on disk while clean, and never throws for bad content — a load failure is kept as
// `loadError` so the webview can show the §10.3 error view with "Open in Word/Excel" instead of
// VS Code's generic failure.
//
// WP-19 (spec §6.2–6.5): edits with generation-guarded undo/redo fired for VS Code's undo stack, a
// mirror of VS Code's dirty bookkeeping (for the watcher), Edit mode, the flush handshake, and the
// save pipeline — conflict check, serialise + verify (never write unverified bytes), in-place write,
// error mapping (saveErrors.ts) — plus revert and hot-exit backup. Reachable only while the kind's
// edit flag is on (featureFlags.ts); the provider registers as read-only otherwise.
//
// Gate R2 fixes: the backup id carries the disk state the edits are based on, so a restored backup
// whose file changed meanwhile goes through the conflict modal (F3); flushing never commits an open
// editor (F4, webview side); save verification runs in stages that yield to the event loop, backups
// are coalesced, cached per version and only container-checked (F5); undo/redo are refused while a
// save is writing and the save point is the state that was serialised (F6); the save writes in place
// (spec §6.5 step 5, F8); entering Edit on a digitally signed file warns once (§10.3).

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { OfficePackage, zipLimits } from './core/package.js';
import type { OfficeKind } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { contentTypeOf, normalizePartName, readRelationships } from './core/opc.js';
import { decodePart } from './core/xml.js';
import { crc32, inflateEntry, inflateEntryAsync, readZip } from './core/zip.js';
import { LIMITS } from './core/limits.js';
import type { OfficeError, OfficeNotice, ReadOnlyReason } from './core/types.js';
import { EditBuilder, invertEdit, tryApplyEdit, undoRedoFor } from './core/edits.js';
import type { EditOutcome, EditTarget, OfficeEdit } from './core/edits.js';
import { packageValidator, serializeAndVerify, verifyBytes } from './core/save.js';
import type { Validator, ValidatorContext, VerifyFailure, VerifyResult } from './core/save.js';
import { editFlagFor } from './featureFlags.js';
import {
  appName, describeLoadFailure, describeReadFailure, describeUnexpectedError, doctypeDetail,
  unreadablePartDetail,
} from './loadErrors.js';
import type { LoadErrorView } from './loadErrors.js';
import {
  CHANGED_ON_DISK_MESSAGE, CONFLICT_DETAIL, CONFLICT_OVERWRITE, CONFLICT_REVERT, PARTIAL_WRITE_NOTE, READ_ONLY_MESSAGE,
  REVERTED_MESSAGE, SAVE_BUSY_MESSAGE, SAVE_DIAGNOSTICS_ACTION, VERIFY_FAILED_BACKUP_MESSAGE, VERIFY_FAILED_MESSAGE,
  VIEW_MODE_MESSAGE, classifyWriteError, conflictMessage, diagnosticsFileName, diagnosticsText, signedEditWarning,
  stampChanged, writeErrorMessage,
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
  /** Format validators run on the re-opened output of every save (spec §6.5 step 4, §13.3); backups get the container check only (§6.2). */
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

interface PendingFlush { remaining: number; done(): void; }

/** Yield to the event loop (spec §10.2: host work over large input must not starve other extensions). */
function pause(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// Disk base and backup ids (Gate R2 F3)

/**
 * The file on disk the in-memory state is based on: its stamp and, when known, a SHA-256 of its
 * bytes (base64). Recorded at load and after each save; carried inside the backup id so a restored
 * backup can tell whether the file changed while VS Code was closed.
 */
export interface DiskBase { mtime: number; size: number; hash?: string; }

/** Prefix of the backup ids written since Gate R2. Older ids (a bare URI) carry no base. */
export const BACKUP_ID_PREFIX = 'vsmd-office-backup:1:';

/** `CustomDocumentBackup.id`: the backup file and the disk base, as an opaque string VS Code hands back. */
export function encodeBackupId(destination: vscode.Uri, base: DiskBase | null): string {
  return BACKUP_ID_PREFIX + JSON.stringify({ uri: destination.toString(), base });
}

function isDiskBase(v: unknown): v is DiskBase {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return typeof b.mtime === 'number' && Number.isFinite(b.mtime) && typeof b.size === 'number' && Number.isFinite(b.size)
    && (b.hash === undefined || typeof b.hash === 'string');
}

/**
 * Where to read a backup from, and the base it was made against. `base: null` means unknown (an id
 * from before Gate R2, or a backup of a document whose base was unknown): treated as conflicting.
 */
export function parseBackupId(id: string): { source: vscode.Uri | null; base: DiskBase | null } {
  if (id.startsWith(BACKUP_ID_PREFIX)) {
    try {
      const v = JSON.parse(id.slice(BACKUP_ID_PREFIX.length)) as { uri?: unknown; base?: unknown };
      const source = typeof v.uri === 'string' ? vscode.Uri.parse(v.uri, true) : null;
      const base = isDiskBase(v.base) ? { mtime: v.base.mtime, size: v.base.size, hash: v.base.hash } : null;
      return { source, base };
    } catch {
      return { source: null, base: null };
    }
  }
  try { return { source: vscode.Uri.parse(id, true), base: null }; } catch { return { source: null, base: null }; }
}

/** SHA-256 (base64) of `bytes`, hashed in slices with a yield between them for large files. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const h = createHash('sha256');
  const step = LIMITS.asyncParseThresholdBytes * 4;
  for (let i = 0; i < bytes.length; i += step) {
    h.update(bytes.subarray(i, Math.min(bytes.length, i + step)));
    if (i + step < bytes.length) await pause();
  }
  return h.digest('base64');
}

// ---------------------------------------------------------------------------------------------
// Staged verification (Gate R2 F5)

const lowerPart = (s: string): string => normalizePartName(s).toLowerCase();

/** Attribute "<part>: message" to that part when the prefix names a known part (as core/save.ts does). */
function toFailure(message: string, known: ReadonlySet<string>): VerifyFailure {
  const i = message.indexOf(': ');
  if (i > 0 && known.has(lowerPart(message.slice(0, i)))) return { part: normalizePartName(message.slice(0, i)), message };
  return { message };
}

/**
 * `serializeAndVerify` (core/save.ts) cut into stages with a yield between them, so a save of a large
 * workbook blocks the extension host for one stage at a time instead of all of them: serialise;
 * container, CRC, content, re-parse and package checks (`verifyBytes` with no extra validators); then
 * each format validator on the re-opened output. Same checks, same ok/fail outcome. (One difference:
 * when the package checks fail the format validators are not run, so the diagnostics list only the
 * package failures.) The package must not change until it resolves; the save holds `writing` for that.
 */
export async function serializeAndVerifyStaged(
  pkg: OfficePackage, validators: Validator[], hooks?: SaveTestHooks,
): Promise<VerifyResult> {
  let bytes: Uint8Array;
  try {
    bytes = pkg.serialize();
  } catch (e) {
    return { ok: false, failures: [{ message: `Serialisation failed: ${errorText(e)}` }] };
  }
  if (hooks?.corrupt) bytes = hooks.corrupt(bytes.slice());
  await pause();
  const failures = verifyBytes(pkg, bytes, []);   // steps 1–4 and packageValidator
  if (failures.length > 0) return { ok: false, failures };
  const extra = validators.filter((v) => v !== packageValidator);
  if (extra.length === 0) return { ok: true, bytes };
  await pause();
  let reopened: OfficePackage;
  try {
    reopened = OfficePackage.open(`verify.${pkg.kind}`, bytes);
  } catch (e) {
    return { ok: false, failures: [{ message: `Output does not re-open: ${errorText(e)}` }] };
  }
  const touched = pkg.touchedParts();
  const known = new Set([...reopened.partNames(), ...touched].map(lowerPart));
  let original: OfficePackage | undefined | null = null;
  const ctx: ValidatorContext = {
    original: () => {
      if (original === null) {
        try { original = OfficePackage.open(`original.${pkg.kind}`, pkg.originalBytes); } catch { original = undefined; }
      }
      return original;
    },
  };
  for (const v of extra) {
    await pause();
    let messages: string[];
    try {
      messages = v(reopened, touched.slice(), ctx);
    } catch (e) {
      failures.push({ message: `Validator ${v.name || '(anonymous)'} threw: ${errorText(e)}` });
      continue;
    }
    if (!Array.isArray(messages)) { failures.push({ message: `Validator ${v.name || '(anonymous)'} returned no message list` }); continue; }
    for (const m of messages) failures.push(toFailure(String(m), known));
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, bytes };
}

/**
 * The backup check (Gate R2 F5 b): the bytes re-read as a ZIP, every entry inflates and matches its
 * CRC-32, and they re-open as a package of `kind`. No format validators: a restored backup goes
 * through the full verification before it can be saved. Yields between entries.
 */
export async function verifyBackupBytes(bytes: Uint8Array, kind: OfficeKind): Promise<VerifyFailure[]> {
  let zip;
  try {
    zip = readZip(bytes, zipLimits());
  } catch (e) {
    return [{ message: `Output is not a readable ZIP: ${errorText(e)}` }];
  }
  let sinceYield = 0;
  for (const e of zip.entries) {
    const large = e.uncompressedSize > LIMITS.asyncParseThresholdBytes;
    try {
      if (large) {
        await inflateEntryAsync(zip, e, 30);   // yields while inflating; checks the CRC-32 itself
      } else {
        const data = inflateEntry(zip, e);
        if (crc32(data) !== e.crc32) return [{ part: e.name, message: `${e.name}: CRC-32 mismatch` }];
      }
    } catch (err) {
      return [{ part: e.name, message: `${e.name}: entry does not inflate or fails its CRC-32: ${errorText(err)}` }];
    }
    sinceYield += e.uncompressedSize;
    if (large || sinceYield > LIMITS.asyncParseThresholdBytes) { sinceYield = 0; await pause(); }
  }
  try {
    const p = OfficePackage.open(`backup.${kind}`, bytes);
    if (p.kind !== kind) return [{ message: `Output re-opens as ${p.kind}, not ${kind}` }];
  } catch (e) {
    return [{ message: `Output does not re-open: ${errorText(e)}` }];
  }
  return [];
}

const SIGNATURE_ORIGIN_RE = /\/digital-signature\/origin$/;

/** Whether the package carries an OPC digital signature (`_xmlsignatures/` parts or a signature-origin relationship). */
export function isSignedPackage(pkg: OfficePackage): boolean {
  if (pkg.partNames().some((n) => /^\/?_xmlsignatures\//i.test(n))) return true;
  try {
    return readRelationships(pkg, '').some((r) => SIGNATURE_ORIGIN_RE.test(r.type));
  } catch {
    return false;
  }
}

export class OfficeDocument implements vscode.CustomDocument {
  /** Debounce for file-watcher events (Office writes a file in several steps). Tests set 0. */
  static diskCheckDelayMs = 300;
  /** How long a save/backup waits for `flushed` before going on with the committed state (§6.5). */
  static flushTimeoutMs = 1500;
  /** See SaveTestHooks. Tests assign it; the environment variable sets it for manual checks. */
  static saveHooks: SaveTestHooks | undefined = envSaveHooks(typeof process === 'undefined' ? undefined : process.env);
  /**
   * Quiet period before a backup serialises (Gate R2 F5 a): an edit landing meanwhile restarts it,
   * so a burst of typing costs one serialisation. VS Code cancels a superseded backup itself. Tests set 0.
   */
  static backupDelayMs = 750;
  /** Upper bound on the quiet-period wait, so steady typing still gets a backup. */
  static backupMaxDelayMs = 10_000;

  readonly uri: vscode.Uri;
  readonly kind: OfficeKind;
  pkg: OfficePackage | null = null;
  loadError: LoadErrorView | null = null;
  /** Monotonic, starts at 0; +1 per applied edit, undo, redo, revert and external reload (§5). */
  version = 0;
  /** +1 per load, revert or external reload; undo closures check it (§6.3). */
  generation = 0;
  diskStamp: { mtime: number; size: number } | null = null;
  /**
   * The disk state the in-memory content is based on (Gate R2 F3): stamp and hash of the file as
   * loaded or last saved, or, for a document restored from a backup, as recorded in that backup.
   * Null when unknown (a backup from before Gate R2).
   */
  base: DiskBase | null = null;
  /** Restored from a backup whose base no longer matches the file: the next save asks first (F3). */
  restoredConflict = false;
  /** The package carries a digital signature (`_xmlsignatures/`); entering Edit warns once (§10.3). */
  signed = false;
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
  private diskCheckAfterWrite = false;
  private lastBackupFailure = -1;
  /** Container-checked backup bytes of one state, keyed `generation:version` (F5: one serialisation per state). */
  private backupCache: { key: string; bytes: Uint8Array } | undefined;
  /** Backups run one at a time (a later one finds the earlier one's bytes in the cache). */
  private backupChain: Promise<unknown> = Promise.resolve();
  private signatureWarned = false;

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
    let backupBase: DiskBase | null = null;
    if (backupId) {
      const parsed = parseBackupId(backupId);
      source = parsed.source ?? uri;
      backupBase = parsed.base;
    }
    await doc.load(source, false);
    let fromBackupBytes = source !== uri && !doc.readFailed;
    if (doc.readFailed && source !== uri) {
      await doc.load(uri, false);   // unreadable backup: fall back to the file
      fromBackupBytes = false;
    }
    if (fromBackupBytes && doc.pkg) await doc.checkRestoredBase(backupBase);
    // VS Code restores a document opened from a backup as dirty (§6.2), whatever we could read.
    doc.fromBackup = backupId !== undefined;
    let start = false;
    try { start = doc.hooks.startInEditMode?.() === true; } catch { start = false; }
    doc.editMode = start && doc.canEdit;
    if (doc.editMode) doc.warnIfSigned();
    doc.startWatching();
    return doc;
  }

  /**
   * Gate R2 F3: the content came from a backup made against `base`. When the file changed since
   * (stamp differs and, where the backup has a hash, the bytes too) or the base is unknown, the
   * next save goes through the conflict modal and the "changed on disk" notice shows now.
   */
  private async checkRestoredBase(base: DiskBase | null): Promise<void> {
    const now = this.diskStamp;
    if (!now) { this.base = base; return; }   // the file is gone: saving recreates it
    if (base && base.mtime === now.mtime && base.size === now.size) { this.base = base; return; }
    if (base?.hash && base.size === now.size) {
      try {
        const hash = await hashBytes(await vscode.workspace.fs.readFile(this.uri));
        if (hash === base.hash) { this.base = { ...now, hash }; return; }   // touched, not changed
      } catch {
        // unreadable now: treat as changed
      }
    }
    this.base = base;
    this.restoredConflict = true;
    this.markChangedOnDisk(false);
  }

  /** The persistent "changed on disk" notice (§6.1); `fire` posts it to the webviews. */
  private markChangedOnDisk(fire: boolean): void {
    if (this.changedOnDisk) return;
    this.changedOnDisk = true;
    this.notices = [...this.notices, { severity: 'warning', code: 'changed-on-disk', message: CHANGED_ON_DISK_MESSAGE }];
    if (fire) this.stateEmitter.fire({ kind: 'notices' });
  }

  /** §10.3: saving a signed file invalidates its signature; say so once, when Edit first turns on. */
  private warnIfSigned(): void {
    if (!this.signed || this.signatureWarned) return;
    this.signatureWarned = true;
    void vscode.window.showWarningMessage(signedEditWarning(appName(this.kind)));
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
    if (this.editMode) this.warnIfSigned();
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
    this.flushTargets.clear();
    this.stateEmitter.dispose();
    this.editEmitter.dispose();
    this.serialCache = undefined;
    this.pkg = null;
  }

  // -------------------------------------------------------------------------------------------
  // Edits (spec §6.3)

  /** Why an edit cannot be applied now (view mode, read-only, a save writing), or null. */
  editRefusal(): OfficeError | null {
    if (this.disposed || !this.pkg || !this.canEdit) return { code: 'read-only', message: READ_ONLY_MESSAGE };
    if (!this.editMode) return { code: 'read-only', message: VIEW_MODE_MESSAGE };
    // Between a save's flush and its completion the bytes being written are fixed; an edit landing
    // then would be marked saved by VS Code without being on disk.
    if (this.writing > 0) return { code: 'blocked', message: SAVE_BUSY_MESSAGE };
    return null;
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

  /**
   * Record an edit that is ALREADY applied to the package (the xlsx ops apply as they build, so the
   * provider cannot hand them to `applyEdit` again). Registers it for undo/redo exactly like
   * `applyEdit`. When the document can no longer take edits (Edit turned off, a save began, the
   * document was disposed or reloaded while the edit was being built) the edit is rolled back and
   * the refusal returned, so nothing is ever in the package without being on the undo stack.
   */
  recordApplied(edit: OfficeEdit | null, appliedTo: OfficePackage): DocumentEditResult {
    if (!edit || edit.changes.length === 0) return { ok: true, edit: null };
    const refusal = this.editRefusal();
    const stalePkg = this.pkg !== appliedTo;
    if (refusal || stalePkg) {
      // Nothing to roll back when the package is gone or was replaced by a reload.
      if (!stalePkg) tryApplyEdit(appliedTo, invertEdit(edit));
      return { ok: false, error: refusal ?? { code: 'stale', message: 'The workbook was reloaded; try the edit again.' } };
    }
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
      undo: () => { this.position--; this.afterUndoRedo(this.undoRedoRefusal() ?? guarded.undo()); },
      redo: () => { this.position++; this.afterUndoRedo(this.undoRedoRefusal() ?? guarded.redo()); },
    });
  }

  /**
   * Gate R2 F6: while a save is between its serialisation and its completion the package must not
   * change (VS Code would mark the undone state saved while the disk holds the other). The closure
   * then changes nothing and says why; VS Code has moved its pointer already, so the dirty mirror
   * moves too and errs towards dirty.
   */
  private undoRedoRefusal(): EditOutcome | null {
    return this.writing > 0 ? { ok: false, error: { code: 'blocked', message: SAVE_BUSY_MESSAGE } } : null;
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

  /**
   * The verified bytes of the current state (cached per version), or the verification failures.
   * Synchronous (one block): tests and callers that need an answer now. Saves use
   * `serializeVerifiedAsync`, which runs the same checks in stages.
   */
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

  private validatorList(): { validators: Validator[] } | { failure: VerifyFailure } {
    try {
      return { validators: this.hooks.validators() };
    } catch (e) {
      return { failure: { message: `Validators unavailable: ${errorText(e)}` } };
    }
  }

  /**
   * Apply the save-time preparation when the package's content changed (§6.5, §9.5); an unchanged
   * one (no edits, or every edit undone) is written as its original bytes (G0). Returns the builder
   * to abort once the bytes exist (the preparation lives in the bytes only, never in the document),
   * or the failure.
   */
  private prepareSerialization(pkg: OfficePackage): { builder: EditBuilder | null } | { failure: VerifyFailure } {
    const prepare = this.hooks.beforeFirstSerialize;
    if (!prepare) return { builder: null };
    let plain: Uint8Array;
    try {
      plain = pkg.serialize();
    } catch (e) {
      return { failure: { message: `Serialisation failed: ${errorText(e)}` } };
    }
    if (plain === pkg.originalBytes) return { builder: null };
    const b = new EditBuilder(pkg, 'Prepare save');
    try {
      prepare.call(this.hooks, b);
    } catch (e) {
      b.abort();
      return { failure: { message: `Preparing the save failed: ${errorText(e)}` } };
    }
    return { builder: b };
  }

  private computeSerialization(pkg: OfficePackage, test: SaveTestHooks | undefined): VerifyResult {
    const list = this.validatorList();
    if ('failure' in list) return { ok: false, failures: [list.failure] };
    const prep = this.prepareSerialization(pkg);
    if ('failure' in prep) return { ok: false, failures: [prep.failure] };
    try {
      return serializeAndVerify(pkg, list.validators, test);
    } catch (e) {
      return { ok: false, failures: [{ message: `Verification failed: ${errorText(e)}` }] };
    } finally {
      prep.builder?.abort();
    }
  }

  /**
   * `serializeVerified` for the save path (Gate R2 F5 c): the same checks in stages, yielding to the
   * event loop between them, sharing the cache. The caller holds `writing`, so no edit, undo or redo
   * can change the package meanwhile; a reload can, and then the result is not cached.
   */
  async serializeVerifiedAsync(): Promise<VerifyResult> {
    const pkg = this.pkg;
    if (!pkg) return { ok: false, failures: [{ message: 'The document is not loaded.' }] };
    const test = OfficeDocument.saveHooks;
    const version = this.version;
    const generation = this.generation;
    const c = this.serialCache;
    if (!test && c && c.version === version && c.generation === generation) return c.result;
    const list = this.validatorList();
    if ('failure' in list) return { ok: false, failures: [list.failure] };
    const prep = this.prepareSerialization(pkg);
    if ('failure' in prep) return { ok: false, failures: [prep.failure] };
    let result: VerifyResult;
    try {
      result = await serializeAndVerifyStaged(pkg, list.validators, test);
    } catch (e) {
      result = { ok: false, failures: [{ message: `Verification failed: ${errorText(e)}` }] };
    } finally {
      prep.builder?.abort();
    }
    if (!test && this.pkg === pkg && this.version === version && this.generation === generation) {
      this.serialCache = { version, generation, result };
    }
    return result;
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
      // Gate R2 F6: the save point is the state being serialised. Nothing changes it until the write
      // is done (edits, undo and redo are refused while `writing`), but the mirror never assumes so.
      const pkg = this.pkg;
      const savedAt = this.position;
      const result = await this.serializeVerifiedAsync();
      if (!result.ok) {
        void this.reportVerifyFailure(result.failures);
        // Already explained to the user: a cancellation keeps the document dirty without a second message.
        throw new vscode.CancellationError();
      }
      if (this.pkg !== pkg) throw new vscode.CancellationError();   // reverted or reloaded meanwhile
      // §6.5 step 5: write in place, so the file keeps its identity (owner, ACLs, links, the inode
      // Word/Excel and sync clients watch). The bytes are complete and verified before this starts.
      try {
        await vscode.workspace.fs.writeFile(target, result.bytes);
      } catch (e) {
        if (own) this.diskStamp = await this.statDisk();   // our own failed write is not an external change
        const msg = writeErrorMessage(this.kind, baseName(target), e);
        throw new Error(classifyWriteError(e) === 'in-use' ? msg : `${msg} ${PARTIAL_WRITE_NOTE}`);
      }
      if (own) {
        this.diskStamp = await this.statDisk();
        this.base = this.diskStamp ? { ...this.diskStamp, hash: await hashBytes(result.bytes) } : null;
        this.restoredConflict = false;
        if (this.changedOnDisk) {
          this.changedOnDisk = false;
          this.notices = this.notices.filter((n) => n.code !== 'changed-on-disk');
          this.stateEmitter.fire({ kind: 'notices' });
        }
      }
      // VS Code moves its save point to its current edit when the save resolves; the bytes on disk
      // are the state at `savedAt`.
      this.savedPosition = savedAt;
      this.fromBackup = false;
    } finally {
      this.writing--;
      this.afterWrite();
    }
  }

  /**
   * §6.5 step 2: the file changed on disk since load / last save, or (F3) since the backup this
   * document was restored from was made → Overwrite / Revert / Cancel.
   */
  private async checkConflict(): Promise<void> {
    const now = await this.statDisk();
    if (!this.restoredConflict && !stampChanged(this.diskStamp, now)) return;
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

  /** `revertCustomDocument`: re-read from `uri`, new package, version and generation bumped (§6.2). */
  async revert(_cancellation?: vscode.CancellationToken): Promise<void> {
    if (this.disposed) return;
    const applied = await this.load(this.uri, true);
    // VS Code sets its edit index back to the save point: the document is clean.
    this.savedPosition = this.position;
    this.fromBackup = false;
    if (applied && !this.disposed) this.stateEmitter.fire({ kind: 'reloaded' });
  }

  /**
   * `backupCustomDocument` (§6.2, Gate R2 F3/F4/F5). Never changes anything the user sees: the
   * webviews are only asked for edits already in flight. Waits for a quiet period (an edit landing
   * meanwhile restarts it), then writes the bytes of the current state: the save cache when a save
   * already verified it, else one serialisation per state, container-checked (ZIP re-read, every CRC)
   * without the format validators — a restored backup is fully verified before it can be saved. The
   * id carries the disk base so a restore can detect a file that changed meanwhile.
   */
  backup(destination: vscode.Uri, cancellation?: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const run = this.backupChain.then(() => this.runBackup(destination, cancellation));
    this.backupChain = run.catch(() => undefined);
    return run;
  }

  private async runBackup(destination: vscode.Uri, cancellation: vscode.CancellationToken | undefined): Promise<vscode.CustomDocumentBackup> {
    const cancelled = (): boolean => cancellation?.isCancellationRequested === true || this.disposed;
    await this.waitForQuiet(cancelled);
    if (cancelled()) throw new vscode.CancellationError();
    await this.flush();
    if (cancelled()) throw new vscode.CancellationError();
    if (!this.pkg) throw new Error(`Couldn't back up ${this.fileName}: the file could not be loaded.`);
    const version = this.version;
    const r = await this.backupBytes();
    if (!r.ok) {
      console.error('[OfficeDocument] backup verification failed', this.uri.toString(), r.failures);
      if (this.lastBackupFailure !== version) {
        this.lastBackupFailure = version;
        void vscode.window.showErrorMessage(VERIFY_FAILED_BACKUP_MESSAGE);
      }
      throw new Error(VERIFY_FAILED_BACKUP_MESSAGE);
    }
    if (cancelled()) throw new vscode.CancellationError();
    await vscode.workspace.fs.writeFile(destination, r.bytes);
    let deleted = false;
    return {
      id: encodeBackupId(destination, this.base),
      delete: () => {
        if (deleted) return;
        deleted = true;
        vscode.workspace.fs.delete(destination).then(undefined, () => { /* already gone */ });
      },
    };
  }

  /** Resolves once no edit landed for `backupDelayMs` (at most `backupMaxDelayMs`), or when cancelled. */
  private async waitForQuiet(cancelled: () => boolean): Promise<void> {
    const delay = OfficeDocument.backupDelayMs;
    if (delay <= 0) return;
    const until = Date.now() + OfficeDocument.backupMaxDelayMs;
    for (;;) {
      const seen = `${this.generation}:${this.version}`;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (cancelled() || `${this.generation}:${this.version}` === seen || Date.now() >= until) return;
    }
  }

  /** The bytes a backup writes for the current state, serialised at most once per state. */
  private async backupBytes(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; failures: VerifyFailure[] }> {
    const pkg = this.pkg!;
    const test = OfficeDocument.saveHooks;
    const key = `${this.generation}:${this.version}`;
    const c = this.serialCache;
    if (!test && c && c.result.ok && c.version === this.version && c.generation === this.generation) return { ok: true, bytes: c.result.bytes };
    const bc = this.backupCache;
    if (!test && bc && bc.key === key) return { ok: true, bytes: bc.bytes };
    // Serialise synchronously (the package may change once this yields).
    const prep = this.prepareSerialization(pkg);
    if ('failure' in prep) return { ok: false, failures: [prep.failure] };
    let bytes: Uint8Array;
    try {
      bytes = pkg.serialize();
      if (test?.corrupt) bytes = test.corrupt(bytes.slice());
    } catch (e) {
      return { ok: false, failures: [{ message: `Serialisation failed: ${errorText(e)}` }] };
    } finally {
      prep.builder?.abort();
    }
    await pause();
    const failures = await verifyBackupBytes(bytes, this.kind);
    if (failures.length > 0) return { ok: false, failures };
    if (!test && this.pkg === pkg) this.backupCache = { key, bytes };
    return { ok: true, bytes };
  }

  private afterWrite(): void {
    if (this.writing === 0 && this.diskCheckAfterWrite) {
      this.diskCheckAfterWrite = false;
      this.scheduleDiskCheck();
    }
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
    // The disk base (F3) when the bytes are the file's own; a backup's base comes from its id (create).
    const fromFile = source.toString() === this.uri.toString();
    const hash = fromFile && bytes && stamp && this.writableScheme ? await hashBytes(bytes) : undefined;
    if (token !== this.loadToken || this.disposed) return false;

    this.pkg = pkg;
    this.loadError = loadError;
    this.diskStamp = stamp;
    this.base = fromFile && stamp ? { ...stamp, hash } : null;
    this.restoredConflict = false;
    this.signed = pkg ? isSignedPackage(pkg) : false;
    this.generation++;
    if (isReload) this.version++;
    this.serialCache = undefined;
    this.backupCache = undefined;
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
    if (this.writing > 0) {
      // Our own save is in flight (its write fires the watcher): look again when it is done.
      this.diskCheckAfterWrite = true;
      return;
    }
    const stamp = await this.statDisk();
    if (!stamp) return;   // deleted or unreadable: keep showing what we have
    const prev = this.diskStamp;
    if (prev && prev.mtime === stamp.mtime && prev.size === stamp.size) return;
    if (this.isDirty()) {
      this.markChangedOnDisk(true);
      return;
    }
    await this.reload();
  }
}
