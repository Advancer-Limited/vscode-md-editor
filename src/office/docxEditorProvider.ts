// Word document viewer provider (viewType `vscodeMdEditor.docx`), spec §4.1, §7.1.
//
// View path: registration, assets, CSP, `docxRender` with the original bytes and no block list,
// kind notices (core/docx/notices.ts); the webview side is media/docxEditor.js.
// Editing (Phase 3) stays off while `OFFICE_FLAGS.docxEdit` is false.

import * as vscode from 'vscode';
import { getBrandButtonHtml } from '../utils.js';
import { OfficeEditorProviderBase, officeCsp } from './officeEditorProviderBase.js';
import type { OfficeDocument } from './officeDocument.js';
import { parseDocxToHost } from './protocol.js';
import type { OfficeNotice } from './protocol.js';
import type { OfficePackage } from './core/package.js';
import { detectDocxNotices } from './core/docx/notices.js';

/** The notice scan reads the main part's text; do it once per loaded package. */
const noticeCache = new WeakMap<OfficePackage, OfficeNotice[]>();

export class DocxEditorProvider extends OfficeEditorProviderBase {
  public static readonly viewType = 'vscodeMdEditor.docx';

  /** Registration options (spec §4.1): find widget over the rendered DOM, one editor per document. */
  public static readonly registrationOptions = {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
    supportsMultipleEditorsPerDocument: false,
  } as const;

  /** Registers the provider. Cheap: nothing is read or parsed until a .docx is opened. */
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DocxEditorProvider.viewType,
      new DocxEditorProvider(context),
      DocxEditorProvider.registrationOptions,
    );
  }

  protected readonly kind = 'docx' as const;

  protected scripts(): string[] {
    // docx-preview's UMD build expects the JSZip global, so jszip loads first.
    return ['jszip.min.js', 'docx-preview.min.js', 'officeCommon.js', 'docxMap.js', 'docxIsland.js', 'docxEdit.js', 'docxEditor.js'];
  }

  protected styles(): string[] {
    return ['officeCommon.css', 'docxEditor.css'];
  }

  protected bodyHtml(): string {
    // Static markup only. The brand button is host-generated (getBrandButtonHtml) and is moved into
    // the toolbar by the webview script.
    return /* html */ `  <div id="office-app" class="office-app">
    <div id="office-toolbar" class="office-toolbar"></div>
    <div id="office-banner" class="office-banner"></div>
    <div id="office-content" class="office-content docx-backdrop"></div>
  </div>
  <div id="office-brand" hidden>${getBrandButtonHtml()}</div>`;
  }

  protected csp(webview: vscode.Webview, nonce: string): string {
    return officeCsp(webview.cspSource, nonce, true);
  }

  protected kindNotices(doc: OfficeDocument): OfficeNotice[] {
    if (!doc.pkg) return [];
    let notices = noticeCache.get(doc.pkg);
    if (!notices) {
      notices = detectDocxNotices(doc.pkg);
      noticeCache.set(doc.pkg, notices);
    }
    return notices;
  }

  protected onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.sendRender(doc, panel);
  }

  protected onReloaded(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.post(panel, { type: 'docxStateChanged', version: doc.version });
  }

  protected onMessage(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): void {
    const msg = parseDocxToHost(raw);
    if (!msg) {
      this.replyInvalid(panel, raw);
      return;
    }
    switch (msg.type) {
      case 'docxRequestRender':
        this.sendRender(doc, panel);
        return;
      case 'docxRequestBlockModel':
        this.fail(panel, msg.requestId, 'read-only', 'This document is open read-only.');
        return;
      case 'docxEdit':
        this.post(panel, {
          type: 'docxEditResult', requestId: msg.requestId, ok: false,
          error: { code: 'read-only', message: 'This document is open read-only.' },
        });
        return;
      default:
        // Common messages never reach here: the base handles every well-formed one first.
        return;
    }
  }

  /**
   * `docxRender` with the package's original bytes (Phase 1: no edits, so original = current).
   * The document already passed the pre-render DOCTYPE guard when it loaded (spec §12).
   */
  private sendRender(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    if (!doc.pkg) {
      this.sendState(doc, panel);   // shows the error view
      return;
    }
    let bytes = doc.pkg.originalBytes;
    // Send a plain Uint8Array that owns exactly the file's bytes. A Node Buffer (a Uint8Array subclass)
    // or a view into a larger pooled buffer is copied: Buffer#slice shares memory instead of copying,
    // and a non-plain view can reach the webview as something docx-preview/JSZip cannot read.
    if (bytes.constructor !== Uint8Array || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
      bytes = new Uint8Array(bytes);
    }
    this.post(panel, { type: 'docxRender', version: doc.version, bytes, blocks: [] });
  }
}
