// Shared host shell for the Office viewers (spec §4, §6.1–6.2, §10.3, §12).
//
// Phase 1: a read-only provider. The base owns everything both kinds share — webview HTML (CSP,
// nonce, `?v=` cache-busting, `localResourceRoots` = media/ only), the common messages (`ready`,
// `setEditMode`, `openLink`, `openExternally`, `retry`, `writeClipboard`, `showAbout`), the
// load-error view, and re-sending state when the document reloads. Kind providers supply the
// assets, the body markup, the CSP and the kind-specific messages.

import * as vscode from 'vscode';
import { getNonce } from '../utils.js';
import { showAboutDialog } from '../about.js';
import { OfficeDocument } from './officeDocument.js';
import type { OfficeDocumentStateChange } from './officeDocument.js';
import type { OfficeKind } from './core/package.js';
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

interface PanelState { editMode: boolean; showingError: boolean; }

export abstract class OfficeEditorProviderBase implements vscode.CustomReadonlyEditorProvider<OfficeDocument> {
  protected abstract readonly kind: OfficeKind;

  private readonly panelStates = new WeakMap<vscode.WebviewPanel, PanelState>();

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

  /** Kind-specific notices added to the document's host notices (WP-10, WP-14). */
  protected kindNotices(_doc: OfficeDocument): OfficeNotice[] {
    return [];
  }

  // -------------------------------------------------------------------------------------------
  // vscode.CustomReadonlyEditorProvider

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<OfficeDocument> {
    // untitledDocumentData is ignored: no "new file" support in v1 (§6.1).
    return OfficeDocument.create(uri, this.kind, openContext.backupId);
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
    this.panelStates.set(panel, { editMode: false, showingError: false });

    const subs: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((raw: unknown) => this.dispatch(doc, panel, raw)),
      doc.onDidChangeState((e) => this.onDocumentState(doc, panel, e)),
    ];
    panel.onDidDispose(() => {
      for (const s of subs) s.dispose();
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
    if (state) {
      state.showingError = false;
      if (!doc.canEdit) state.editMode = false;
    }
    this.post(panel, {
      type: 'init',
      kind: this.kind,
      fileName: doc.fileName,
      version: doc.version,
      canEdit: doc.canEdit,
      readOnlyReason: doc.readOnlyReason,
      editMode: state?.editMode ?? false,
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
      case 'ready':
        this.sendState(doc, panel);
        if (!doc.loadError) this.onReady(doc, panel);
        return;
      case 'setEditMode': {
        const state = this.panelStates.get(panel);
        const editMode = msg.editMode && doc.canEdit;
        if (state) state.editMode = editMode;
        this.post(panel, { type: 'editModeChanged', editMode });
        return;
      }
      case 'flushed':
        return;   // Phase 1 never asks for a flush
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
    const url = allowedExternalLink(href);
    if (!url) {
      this.post(panel, { type: 'notices', notices: [...this.allNotices(doc), LINK_BLOCKED_NOTICE] });
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url.href, true));
  }

  private async openExternally(doc: OfficeDocument): Promise<void> {
    const app = this.kind === 'docx' ? 'Word' : 'Excel';
    if (doc.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(`Open in ${app} is only available for files on this computer.`);
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
