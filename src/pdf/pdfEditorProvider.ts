// PDF viewer provider (viewType `vscodeMdEditor.pdf`), spec §4, §4.1, §5, §7.5, §7.6, §9.4, §12.
//
// Read-only host shell (PWP-05). Extends the Office provider base, which owns the webview HTML
// (nonce, `?v=` cache-busting, `localResourceRoots` = media/), the common messages (`ready`,
// `setEditMode`, `openLink` with the http/https/mailto allow-list, `openExternally`, `retry`,
// `writeClipboard`, `showAbout`) and the error view. This file adds the PDF CSP, the assets, and
// the PDF messages:
//   pdfRequestDocument -> pdfDocument (the bytes of the current generation, a plain Uint8Array)
//   pdfFacts           -> notices (display only, never used for a decision)
//   pdfSaveAttachment  -> Save dialog, base name only -> pdfSaveAttachmentResult
//   pdfEdit            -> pdfEditResult ok:false 'read-only' (until Phase 2)
//
// NOT REGISTERED: package.json and extension.ts are untouched until PWP-11 calls `register`.
//
// Bytes are sent only on request. The webview asks after every `init` (first load, Retry, reload
// on an external change) once its engine check passes, so an engine that is too old never receives
// a 100 MB payload, and a reload is never sent twice.

import * as vscode from 'vscode';
import { getBrandButtonHtml } from '../utils.js';
import { OfficeEditorProviderBase } from '../office/officeEditorProviderBase.js';
import { sameFile } from '../office/officeDocument.js';
import type { OfficeNotice } from '../office/protocol.js';
import { PdfDocument } from './pdfDocument.js';
import { parsePdfToHost } from './protocol.js';
import type { PdfFacts } from './protocol.js';

/**
 * The PDF webview CSP (spec §12, final after spike S1). Only the webview resource origin appears;
 * no `'unsafe-eval'`, no `'unsafe-inline'`, no frame/object/form sources.
 */
export function pdfCsp(cspSource: string, nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; `
    + `connect-src ${cspSource}; style-src ${cspSource}; img-src ${cspSource} data:; font-src ${cspSource};`;
}

/** Longest attachment file name offered in the Save dialog (common file-system limit). */
const MAX_NAME = 200;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * An attachment's suggested name reduced to a safe base name (spec §12): document-derived, so it is
 * never a path. Drops directories (both separators), control and Windows-reserved characters,
 * trailing dots and spaces, and device names; caps the length keeping the extension; falls back to
 * "attachment".
 */
export function sanitizeAttachmentName(name: string): string {
  let n = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '_');
  n = n.trim().replace(/[. ]+$/, '');
  n = n.replace(/^\.+/, '');   // no hidden files, no "." / ".."
  if (WINDOWS_RESERVED_RE.test(n)) n = '_' + n;
  if (n.length > MAX_NAME) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, MAX_NAME - ext.length) + ext;
  }
  return n || 'attachment';
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** §7.6 notices from the webview's facts. Display only: nothing here decides what the host does. */
export function factsNotices(facts: PdfFacts): OfficeNotice[] {
  const out: OfficeNotice[] = [];
  if (facts.encrypted) {
    out.push({ severity: 'info', code: 'pdf-encrypted', message: 'This PDF is encrypted. It can be viewed but not changed here.' });
  }
  if (facts.signatures.length > 0) {
    out.push({
      severity: 'info', code: 'pdf-signed',
      message: `This PDF has ${plural(facts.signatures.length, 'digital signature', 'digital signatures')}. Signatures are not verified here.`,
    });
  }
  if (facts.hasXfa) {
    out.push({
      severity: 'warning', code: 'pdf-xfa',
      message: "This form was made with Adobe LiveCycle (XFA) and can't be shown or filled here.",
    });
  }
  if (facts.hasJavaScript) {
    out.push({ severity: 'info', code: 'pdf-javascript', message: 'This PDF contains scripts. Scripts in this PDF are not run.' });
  }
  if (!facts.hasText && facts.pageCount > 0) {
    out.push({
      severity: 'info', code: 'pdf-no-text',
      message: "This PDF has no text layer (it may be a scan), so its text can't be selected or found.",
    });
  }
  if (facts.attachmentCount > 0) {
    out.push({
      severity: 'info', code: 'pdf-attachments',
      message: `This PDF has ${plural(facts.attachmentCount, 'attached file', 'attached files')}. They are never opened here; you can save them from the sidebar.`,
    });
  }
  return out;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class PdfEditorProvider extends OfficeEditorProviderBase<PdfDocument> {
  public static readonly viewType = 'vscodeMdEditor.pdf';

  /**
   * Spec §4.1. `retainContextWhenHidden` is required (spike S8: a hidden tab's webview is destroyed
   * without it and could not answer a save); the find widget is off (virtualised pages, own find).
   */
  public static readonly registrationOptions = {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
    supportsMultipleEditorsPerDocument: false,
  } as const;

  /** For PWP-11. Cheap: nothing is read until a .pdf is opened. Not called anywhere yet. */
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context),
      PdfEditorProvider.registrationOptions,
    );
  }

  protected readonly kind = 'pdf' as const;

  /** Facts-derived notices per document, for the generation the webview reported them for. */
  private readonly facts = new WeakMap<PdfDocument, { generation: number; notices: OfficeNotice[] }>();

  protected createDocument(uri: vscode.Uri, backupId: string | undefined): Promise<PdfDocument> {
    return PdfDocument.create(uri, backupId);
  }

  protected scripts(): string[] {
    // The pdf.js bundle defines `PdfjsBundle`; pdfViewMath is UMD; the viewer files land in PWP-08+.
    return ['pdfjs-bundle.js', 'officeCommon.js', 'pdfViewMath.js', 'pdfViewer.js'];
  }

  protected styles(): string[] {
    return ['pdfjs/pdf_viewer.css', 'officeCommon.css', 'pdfViewer.css'];
  }

  protected bodyHtml(webview: vscode.Webview): string {
    // Static markup. `data-pdfjs-base` is the folder of the worker and pdf.js data files (cMaps,
    // standard fonts, wasm, ICC), ending in '/'; `data-cache-bust` is appended as `?v=` to the
    // worker URL. Neither is document-derived.
    const base = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs')).toString();
    return /* html */ `  <div id="office-app" class="office-app" data-pdfjs-base="${escapeAttr(base.endsWith('/') ? base : base + '/')}" data-cache-bust="${Date.now()}">
    <div id="office-toolbar" class="office-toolbar"></div>
    <div id="office-banner" class="office-banner"></div>
    <div id="office-content" class="office-content pdf-backdrop"></div>
  </div>
  <div id="office-brand" hidden>${getBrandButtonHtml()}</div>`;
  }

  protected csp(webview: vscode.Webview, nonce: string): string {
    return pdfCsp(webview.cspSource, nonce);
  }

  protected kindNotices(doc: PdfDocument): OfficeNotice[] {
    const f = this.facts.get(doc);
    return f && f.generation === doc.generation ? f.notices : [];
  }

  protected onReady(_doc: PdfDocument, _panel: vscode.WebviewPanel): void {
    // The webview asks for the bytes (pdfRequestDocument) after its engine check.
  }

  protected onReloaded(_doc: PdfDocument, _panel: vscode.WebviewPanel): void {
    // The re-sent `init` makes the webview ask for the new generation.
  }

  protected onMessage(doc: PdfDocument, panel: vscode.WebviewPanel, raw: unknown): void {
    const msg = parsePdfToHost(raw, { loadedSize: doc.size });
    if (!msg) {
      this.replyInvalid(panel, raw);
      return;
    }
    switch (msg.type) {
      case 'pdfRequestDocument':
        this.sendDocument(doc, panel);
        return;
      case 'pdfFacts':
        if (doc.loadError) return;
        this.facts.set(doc, { generation: doc.generation, notices: factsNotices(msg.facts) });
        this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
        return;
      case 'pdfSaveAttachment':
        void this.saveAttachment(doc, panel, msg.requestId, msg.name, msg.bytes)
          .catch((e) => console.error('[PdfEditor] save attachment failed', e));
        return;
      case 'pdfEdit':
        this.post(panel, {
          type: 'pdfEditResult', requestId: msg.requestId, ok: false,
          error: { code: 'read-only', message: 'This document is open read-only.' },
        });
        return;
      case 'pdfWriteResult':
        return;   // no write is ever requested while read-only: a stray result is dropped
      default:
        // Common messages never reach here: the base handles every well-formed one first.
        return;
    }
  }

  /** `pdfDocument` with the bytes of the current generation (already a plain Uint8Array). */
  private sendDocument(doc: PdfDocument, panel: vscode.WebviewPanel): void {
    if (!doc.base) {
      this.sendState(doc, panel);   // shows the error view
      return;
    }
    this.post(panel, { type: 'pdfDocument', generation: doc.generation, version: doc.version, bytes: doc.base });
  }

  /**
   * Spec §12: an attachment is saved only through an explicit Save dialog, never opened. The
   * suggested name is reduced to a base name; the document's own file is never a valid target
   * (plan rule 6: nothing but verified bytes reaches the document's URI).
   */
  private async saveAttachment(
    doc: PdfDocument, panel: vscode.WebviewPanel, requestId: number, name: string, bytes: Uint8Array,
  ): Promise<void> {
    const reply = (ok: boolean): void => this.post(panel, { type: 'pdfSaveAttachmentResult', requestId, ok });
    const safe = sanitizeAttachmentName(name);
    const folder = doc.writableScheme ? vscode.Uri.joinPath(doc.uri, '..') : vscode.workspace.workspaceFolders?.[0]?.uri;
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, safe) : undefined,
        saveLabel: 'Save Attachment',
        title: `Save attachment "${safe}"`,
      });
    } catch (e) {
      console.error('[PdfEditor] save dialog failed', e);
    }
    if (!target) {
      reply(false);
      return;
    }
    if (sameFile(target, doc.uri)) {
      void vscode.window.showErrorMessage("An attachment can't be saved over the PDF it came from. Choose another name.");
      reply(false);
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
      reply(true);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't save the attachment: ${e instanceof Error ? e.message : String(e)}`);
      reply(false);
    }
  }
}
