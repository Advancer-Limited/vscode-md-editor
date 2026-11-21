// Shared host shell for the Office viewers (spec §4, §6.1–6.2, §10.3, §12).
//
// The base owns everything both kinds share — webview HTML (CSP, nonce, `?v=` cache-busting,
// `localResourceRoots` = media/ only), the common messages (`ready`, `setEditMode`, `flushed`,
// `openLink`, `openExternally`, `retry`, `writeClipboard`, `showAbout`), the load-error view, and
// re-sending state when the document reloads or an undo/redo changes it. Kind providers supply the
// assets, the body markup, the CSP, the kind-specific messages and (WP-19 hooks) their validators
// and save-time preparation.
//
// WP-19: a full `CustomEditorProvider` (save, save as, revert, backup, `onDidChangeCustomDocument`),
// all delegated to OfficeDocument. VS Code treats a provider as editable when its
// `onDidChangeCustomDocument` is set at registration, so that getter is undefined while the kind's
// edit flag is off: with the flags off VS Code sees exactly the Phase 1 read-only provider (no
// dirty state, no Save As, no backups).

import * as vscode from 'vscode';
import { getNonce } from '../utils.js';
import { showAboutDialog } from '../about.js';
import { OfficeDocument } from './officeDocument.js';
import type { OfficeDocumentStateChange } from './officeDocument.js';
import type { OfficeKind } from './core/package.js';
import type { EditBuilder } from './core/edits.js';
import type { Validator } from './core/save.js';
import { editFlagFor } from './featureFlags.js';
import { parseCommonToHost } from './protocol.js';
import type {
  DocxToWebview, OfficeCommonToHost, OfficeError, OfficeNotice, XlsxToWebview,
} from './protocol.js';

/** Schemes the host will open from a document link (spec §12). Everything else is dropped. */
export const ALLOWED_LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** The normalised URL when `href` is an absolute http/https/mailto link, else null. */
export function allowedExternalLink(href: string): URL | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  return ALLOWED_LINK_PROTOCOLS.has(u.protocol) ? u : null;
}

export const LINK_BLOCKED_NOTICE: OfficeNotice = {
  severity: 'warning',
  code: 'link-blocked',
  message: 'That link was not opened: only web (http, https) and email (mailto) links can be opened from a document.',
};

/**
 * The Office webview CSP (spec §12). No `connect-src`, no `frame-src`. `blob:`/`data:` images and
 * fonts are for docx-preview; the xlsx webview needs neither and passes `allowBlobAndData: false`.
 */
export function officeCsp(cspSource: string, nonce: string, allowBlobAndData: boolean): string {
  const extra = allowBlobAndData ? ' blob: data:' : '';
  return `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; `
    + `img-src ${cspSource}${extra}; font-src ${cspSource}${extra};`;
}

const MEDIA_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface PanelState {
  showingError: boolean;
  /** The webview sent `ready` (it can answer `flushPendingEdits`). */
  ready: boolean;
  /** Set while the link-blocked warning is showing; clears it when it fires. */
  linkBlockedTimer?: ReturnType<typeof setTimeout>;
}

/** How long the link-blocked warning stays up. */
export const LINK_BLOCKED_MS = 10_000;

export abstract class OfficeEditorProviderBase implements vscode.CustomEditorProvider<OfficeDocument> {
  protected abstract readonly kind: OfficeKind;

  private readonly panelStates = new WeakMap<vscode.WebviewPanel, PanelState>();
  private readonly editEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<OfficeDocument>>();

  /**
   * Undefined while the kind's edit flag is off, so VS Code registers this provider as read-only
   * (it looks at the property when `registerCustomEditorProvider` is called). The declared type
   * says the event is always there because `CustomEditorProvider` requires it.
   */
  get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<OfficeDocument>> {
    return (editFlagFor(this.kind) ? this.editEmitter.event : undefined) as vscode.Event<vscode.CustomDocumentEditEvent<OfficeDocument>>;
  }

  constructor(protected readonly context: vscode.ExtensionContext) {}

  /** Media file names (under `media/`) of the scripts to load, in order. */
  protected abstract scripts(): string[];
  /** Media file names of the stylesheets. */
  protected abstract styles(): string[];
  /** Static body markup. Must not contain document-derived text. */
  protected abstract bodyHtml(): string;
  protected abstract csp(webview: vscode.Webview, nonce: string): string;
  /** After `init` was sent for a loaded document: send the first payload. */
  protected abstract onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void;
  /** A message that is not a well-formed common message. Validate with the kind's parser. */
  protected abstract onMessage(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): void;

  /** After the document reloaded (and `init` was re-sent): tell the webview its state changed. */
  protected onReloaded(_doc: OfficeDocument, _panel: vscode.WebviewPanel): void {
    // kind providers post their `…StateChanged`
  }

  /**
   * After an undo/redo changed the package in place: tell the webview its state changed. Defaults
   * to `onReloaded` (both post the kind's `…StateChanged`); kinds with caches over the package
   * override it (WP-23, WP-33).
   */
  protected onEdited(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.onReloaded(doc, panel);
  }

  /** Kind-specific notices added to the document's host notices (WP-10, WP-14). */
  protected kindNotices(_doc: OfficeDocument): OfficeNotice[] {
    return [];
  }

  /** Format validators run on every save and backup, after `packageValidator` (spec §6.5 step 4, §13.3). */
  protected validators(): Validator[] {
    return [];
  }

  /**
   * Save-time preparation applied to each serialisation of a changed package and rolled back
   * afterwards (xlsx: `fullCalcOnLoad` and calc chain removal, §6.5, §9.5). Optional: a kind
   * without it never pays for the extra serialisation that decides whether the package changed.
   */
  protected beforeFirstSerialize?(b: EditBuilder): void;

  /**
   * Called before a `setEditMode` request is applied. A kind may lift a read-only reason here (Word's
   * "Edit anyway" for Track Changes, §8.7) and re-send state; the default does nothing.
   */
  protected async beforeSetEditMode(_doc: OfficeDocument, _panel: vscode.WebviewPanel, _editMode: boolean): Promise<void> {
    // nothing
  }

  /** `vscodeMdEditor.office.startInEditMode` (§4.1, §6.4). */
  protected startInEditMode(): boolean {
    return vscode.workspace.getConfiguration('vscodeMdEditor.office').get<boolean>('startInEditMode', false) === true;
  }

  // -------------------------------------------------------------------------------------------
  // vscode.CustomEditorProvider

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<OfficeDocument> {
    // untitledDocumentData is ignored: no "new file" support in v1 (§6.1).
    const prepare = this.beforeFirstSerialize;
    const doc = await OfficeDocument.create(uri, this.kind, openContext.backupId, {
      validators: () => this.validators(),
      beforeFirstSerialize: prepare ? (b) => prepare.call(this, b) : undefined,
      startInEditMode: () => this.startInEditMode(),
    });
    // The document's emitter is disposed with it, which drops this listener.
    doc.onDidEdit((e) => this.editEmitter.fire({ document: doc, label: e.label, undo: e.undo, redo: e.redo }));
    return doc;
  }

  saveCustomDocument(doc: OfficeDocument, cancellation: vscode.CancellationToken): Promise<void> {
    return doc.save(cancellation);
  }

  saveCustomDocumentAs(doc: OfficeDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    return doc.saveAs(destination, cancellation);
  }

  revertCustomDocument(doc: OfficeDocument, cancellation: vscode.CancellationToken): Promise<void> {
    return doc.revert(cancellation);
  }

  backupCustomDocument(
    doc: OfficeDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    return doc.backup(context.destination, cancellation);
  }

  async resolveCustomEditor(
    doc: OfficeDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    panel.webview.html = this.buildHtml(panel.webview);
    const state: PanelState = { showingError: false, ready: false };
    this.panelStates.set(panel, state);

    const subs: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((raw: unknown) => this.dispatch(doc, panel, raw)),
      doc.onDidChangeState((e) => this.onDocumentState(doc, panel, e)),
      doc.addFlushTarget((flushId) => {
        if (!state.ready || state.showingError) return false;   // nothing can be pending there
        this.post(panel, { type: 'flushPendingEdits', flushId });
        return true;
      }),
    ];
    panel.onDidDispose(() => {
      for (const s of subs) s.dispose();
      const st = this.panelStates.get(panel);
      if (st?.linkBlockedTimer) clearTimeout(st.linkBlockedTimer);
      this.panelStates.delete(panel);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Messages

  protected post(panel: vscode.WebviewPanel, msg: DocxToWebview | XlsxToWebview): void {
    try {
      panel.webview.postMessage(msg).then(undefined, () => { /* panel gone */ });
    } catch {
      // disposed webview
    }
  }

  /** Generic failure reply for a `requestId`-carrying request without a dedicated failure variant. */
  protected fail(panel: vscode.WebviewPanel, requestId: number, code: OfficeError['code'], message: string): void {
    this.post(panel, { type: 'requestFailed', requestId, error: { code, message } });
  }

  /** A message that failed validation: answer it if it carries a usable `requestId`, else drop it. */
  protected replyInvalid(panel: vscode.WebviewPanel, raw: unknown): void {
    if (isRecord(raw) && typeof raw.requestId === 'number' && Number.isSafeInteger(raw.requestId) && raw.requestId >= 0) {
      this.fail(panel, raw.requestId, 'invalid', 'The request was not understood.');
    }
  }

  /** All notices to show: the document's host notices plus the kind's. */
  protected allNotices(doc: OfficeDocument): OfficeNotice[] {
    return doc.pkg ? [...doc.notices, ...this.kindNotices(doc)] : [...doc.notices];
  }

  /** `loadError` when the document failed to load, else `init`. */
  protected sendState(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    const state = this.panelStates.get(panel);
    if (doc.loadError) {
      if (state) state.showingError = true;
      const { title, detail, actions } = doc.loadError;
      this.post(panel, { type: 'loadError', title, detail, actions: actions.slice() });
      return;
    }
    if (state) state.showingError = false;
    if (!doc.canEdit) doc.setEditMode(false);
    this.post(panel, {
      type: 'init',
      kind: this.kind,
      fileName: doc.fileName,
      version: doc.version,
      canEdit: doc.canEdit,
      readOnlyReason: doc.readOnlyReason,
      editMode: doc.editMode,
      notices: this.allNotices(doc),
    });
  }

  /** Returns the handling promise so tests (and nothing else) can await it. */
  private dispatch(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): Promise<void> {
    const common = parseCommonToHost(raw);
    if (common) {
      return this.handleCommon(doc, panel, common).catch((e) => {
        console.error('[OfficeEditor] message failed', common.type, e);
      });
    }
    try {
      this.onMessage(doc, panel, raw);
    } catch (e) {
      console.error('[OfficeEditor] message failed', e);
    }
    return Promise.resolve();
  }

  private async handleCommon(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: OfficeCommonToHost): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const state = this.panelStates.get(panel);
        if (state) state.ready = true;
        this.sendState(doc, panel);
        if (!doc.loadError) this.onReady(doc, panel);
        return;
      }
      case 'setEditMode': {
        await this.beforeSetEditMode(doc, panel, msg.editMode);
        const editMode = doc.setEditMode(msg.editMode);
        this.post(panel, { type: 'editModeChanged', editMode });
        return;
      }
      case 'flushed':
        doc.flushed(msg.flushId);
        return;
      case 'openLink':
        await this.openLink(doc, panel, msg.href);
        return;
      case 'openExternally':
        await this.openExternally(doc);
        return;
      case 'retry':
        await doc.reload();   // fires 'reloaded', which re-sends state
        return;
      case 'writeClipboard':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case 'showAbout':
        await showAboutDialog(this.context);
        return;
      default: {
        const never: never = msg;
        void never;
      }
    }
  }

  /** §12: only http/https/mailto, through openExternal (which applies VS Code's trusted-domain prompt). */
  private async openLink(doc: OfficeDocument, panel: vscode.WebviewPanel, href: string): Promise<void> {
    const state = this.panelStates.get(panel);
    const url = allowedExternalLink(href);
    if (!url) {
      this.post(panel, { type: 'notices', notices: [...this.allNotices(doc), LINK_BLOCKED_NOTICE] });
      // The warning is about one click: drop it after a while (or on the next link that opens).
      if (state) {
        if (state.linkBlockedTimer) clearTimeout(state.linkBlockedTimer);
        const timer = setTimeout(() => this.clearLinkBlocked(doc, panel), LINK_BLOCKED_MS);
        (timer as { unref?: () => void }).unref?.();   // never keeps the host process alive
        state.linkBlockedTimer = timer;
      }
      return;
    }
    this.clearLinkBlocked(doc, panel);
    await vscode.env.openExternal(vscode.Uri.parse(url.href, true));
  }

  /** Re-post the notices without the link-blocked warning, if it is showing. */
  private clearLinkBlocked(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    const state = this.panelStates.get(panel);
    if (!state?.linkBlockedTimer) return;
    clearTimeout(state.linkBlockedTimer);
    state.linkBlockedTimer = undefined;
    if (!doc.loadError) this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
  }

  private async openExternally(doc: OfficeDocument): Promise<void> {
    const app = this.kind === 'docx' ? 'Word' : 'Excel';
    if (doc.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(`Open in ${app} is only available for files on this computer.`);
      return;
    }
    if (vscode.env.remoteName) {
      // In a Remote-SSH/WSL/container window a file: URI names a path on the remote machine, which
      // the local Word/Excel cannot open.
      void vscode.window.showInformationMessage(
        `Open in ${app} is not available in a remote window: this file is on the remote machine. Download it to open it in ${app}.`);
      return;
    }
    const ok = await vscode.env.openExternal(doc.uri);
    if (!ok) void vscode.window.showWarningMessage(`Couldn't open ${doc.fileName} in ${app}.`);
  }

  private onDocumentState(doc: OfficeDocument, panel: vscode.WebviewPanel, e: OfficeDocumentStateChange): void {
    if (e.kind === 'notices') {
      if (!doc.loadError) this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
      return;
    }
    if (e.kind === 'edited') {
      if (!doc.loadError && !(this.panelStates.get(panel)?.showingError ?? false)) this.onEdited(doc, panel);
      return;
    }
    const wasError = this.panelStates.get(panel)?.showingError ?? false;
    this.sendState(doc, panel);
    if (doc.loadError) return;
    if (wasError) this.onReady(doc, panel);   // the webview was on the error view: send a first payload
    else this.onReloaded(doc, panel);
  }

  // -------------------------------------------------------------------------------------------
  // HTML

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now();
    const media = (file: string): string => {
      if (!MEDIA_FILE_RE.test(file)) throw new Error(`Invalid media file name: ${file}`);
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
      return `${uri}?v=${cacheBust}`;
    };
    const title = this.kind === 'docx' ? 'Word Document Viewer' : 'Excel Workbook Viewer';
    const styles = this.styles().map((f) => `  <link href="${media(f)}" rel="stylesheet">`).join('\n');
    const scripts = this.scripts().map((f) => `  <script nonce="${nonce}" src="${media(f)}"></script>`).join('\n');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${this.csp(webview, nonce)}">
${styles}
  <title>${title}</title>
</head>
<body data-office-kind="${this.kind}">
${this.bodyHtml()}
${scripts}
</body>
</html>`;
  }
}
