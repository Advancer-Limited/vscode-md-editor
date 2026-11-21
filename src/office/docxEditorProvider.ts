// Word document viewer provider (viewType `vscodeMdEditor.docx`), spec §4.1, §7.1.
//
// View path: registration, assets, CSP, `docxRender` with the original bytes and no block list,
// kind notices (core/docx/notices.ts); the webview side is media/docxEditor.js.
//
// Edit path (WP-33), only while `OFFICE_FLAGS.docxEdit` is on (it is off today, and then every
// message below behaves exactly as in the view-only viewer): `docxRender` carries the marked render
// copy plus the block list; `docxRequestBlockModel` answers with a paragraph's segments; `docxEdit`
// -> `applyDocxEdit` (which applies as it builds) -> `doc.recordApplied` (VS Code undo stack) ->
// `docxEditResult` with the full block list. Edits run strictly in arrival order (a per-document
// queue). Undo/redo change the package in place: `onEdited` refreshes the model, styles and
// numbering and posts `docxStateChanged`; a reload/revert makes a new package, hence a new model.
// Protection and Track Changes make the document read-only (spec §8.7); Track Changes can be
// overridden once per open through a modal when the user presses Edit.

import * as vscode from 'vscode';
import { getBrandButtonHtml } from '../utils.js';
import { OfficeEditorProviderBase, officeCsp } from './officeEditorProviderBase.js';
import type { OfficeDocument } from './officeDocument.js';
import { parseDocxToHost } from './protocol.js';
import type { DocxToHost, OfficeError, OfficeNotice } from './protocol.js';
import type { OfficePackage } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { EDIT_ANYWAY, detectDocxNotices, segmentDtos } from './core/docx/notices.js';
import { DocxModel } from './core/docx/model.js';
import { DocxStyles } from './core/docx/styles.js';
import { DocxNumbering } from './core/docx/numbering.js';
import { applyDocxEdit, blockInfos } from './core/docx/ops.js';
import type { DocxContext } from './core/docx/ops.js';
import { buildRenderCopyAsync } from './core/docx/renderCopy.js';
import { detectProtection } from './core/docx/protection.js';
import { docxValidator } from './core/docx/validate.js';
import { packageValidator } from './core/save.js';
import type { Validator } from './core/save.js';
import { describeLoadFailure, describeUnexpectedError } from './loadErrors.js';
import { OFFICE_FLAGS } from './featureFlags.js';

/** The notice scan reads the main part's text; do it once per loaded package. */
const noticeCache = new WeakMap<OfficePackage, OfficeNotice[]>();

type EditMsg = Extract<DocxToHost, { type: 'docxEdit' }>;

const READ_ONLY: OfficeError = { code: 'read-only', message: 'This document is open read-only.' };
/** Renders rebuilt because an edit landed while the copy was being built (see `sendRender`). */
const MAX_RENDER_ATTEMPTS = 3;

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

  /** Model, styles and numbering per loaded package (a reload makes a new package, so a new model). */
  private readonly models = new WeakMap<OfficePackage, DocxContext>();
  private readonly loading = new WeakMap<OfficePackage, Promise<DocxContext | null>>();
  /** Tail of each document's edit queue: edits run one at a time, in order. */
  private readonly editQueues = new WeakMap<OfficeDocument, Promise<void>>();
  /** Documents whose Track Changes read-only state the user chose to override (once per open, §8.7). */
  private readonly trackedOverride = new WeakSet<OfficeDocument>();

  protected scripts(): string[] {
    // docx-preview's UMD build expects the JSZip global, so jszip loads first.
    return ['jszip.min.js', 'docx-preview.min.js', 'officeCommon.js', 'docxEditor.js'];
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

  /** Spec §6.5 step 4 / §13.3: the package rules, then every docx rule. */
  protected validators(): Validator[] {
    return [packageValidator, docxValidator];
  }

  // -------------------------------------------------------------------------------------------
  // Read-only reasons and the model

  /**
   * Protection and Track Changes (spec §8.7) make the document read-only. Applied to the document
   * before `init` is built (and again when requests arrive), never while the edit flag is off.
   */
  private applyProtection(doc: OfficeDocument): void {
    if (!OFFICE_FLAGS.docxEdit || !doc.pkg || doc.readOnlyReason !== null) return;
    const reason = detectProtection(doc.pkg).readOnlyReason;
    if (reason === 'tracked-changes-on' && this.trackedOverride.has(doc)) return;
    if (reason) doc.readOnlyReason = reason;
  }

  protected sendState(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.applyProtection(doc);
    super.sendState(doc, panel);
  }

  /**
   * Pressing Edit on a Track Changes document asks (until confirmed, once per open) whether to edit
   * anyway; on yes the reason is lifted, the webview told and re-rendered. `protected` documents
   * never ask.
   */
  protected async beforeSetEditMode(doc: OfficeDocument, panel: vscode.WebviewPanel, editMode: boolean): Promise<void> {
    if (!editMode || !OFFICE_FLAGS.docxEdit || doc.readOnlyReason !== 'tracked-changes-on') return;
    const answer = await vscode.window.showWarningMessage(
      EDIT_ANYWAY.message, { modal: true, detail: EDIT_ANYWAY.detail }, EDIT_ANYWAY.action);
    if (answer !== EDIT_ANYWAY.action || doc.readOnlyReason !== 'tracked-changes-on') return;
    this.trackedOverride.add(doc);
    doc.readOnlyReason = null;
    this.sendState(doc, panel);
    this.post(panel, { type: 'docxStateChanged', version: doc.version });   // the webview re-requests a marked render
  }

  /** The editing context of the document's current package; null (and a load error set) when it is malformed. */
  private async docxContext(doc: OfficeDocument): Promise<DocxContext | null> {
    const pkg = doc.pkg;
    if (!pkg) return null;
    const hit = this.models.get(pkg);
    if (hit) return hit;
    let p = this.loading.get(pkg);
    if (!p) {
      p = this.loadContext(doc, pkg);
      this.loading.set(pkg, p);
    }
    return p;
  }

  private async loadContext(doc: OfficeDocument, pkg: OfficePackage): Promise<DocxContext | null> {
    try {
      const model = await DocxModel.loadAsync(pkg);
      const ctx: DocxContext = {
        pkg, model, styles: DocxStyles.load(pkg, model.mainPart), numbering: DocxNumbering.load(pkg, model.mainPart),
      };
      this.models.set(pkg, ctx);
      return ctx;
    } catch (e) {
      if (doc.pkg === pkg) {
        doc.loadError = e instanceof OfficeLoadError
          ? describeLoadFailure(e.failure, 'docx', e.detail)
          : describeUnexpectedError('docx', e);
      }
      return null;
    } finally {
      this.loading.delete(pkg);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  protected onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.sendRender(doc, panel).catch((e) => console.error('[DocxEditor] render failed', e));
  }

  protected onReloaded(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.post(panel, { type: 'docxStateChanged', version: doc.version });
  }

  /** Undo/redo changed the package in place: bring the model, styles and numbering up to date, then tell the webview. */
  protected onEdited(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    const pkg = doc.pkg;
    const ctx = pkg ? this.models.get(pkg) : undefined;
    if (pkg && ctx) {
      try {
        ctx.styles.reload();
        ctx.numbering.reload();
        ctx.model.refresh();
      } catch (e) {
        console.error('[DocxEditor] model refresh failed', e);
        this.models.delete(pkg);   // rebuilt on the next request
      }
    }
    this.onReloaded(doc, panel);
  }

  // -------------------------------------------------------------------------------------------
  // Messages

  protected onMessage(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): void {
    const msg = parseDocxToHost(raw);
    if (!msg) {
      this.replyInvalid(panel, raw);
      return;
    }
    this.handle(doc, panel, msg).catch((e) => {
      console.error('[DocxEditor] message failed', msg.type, e);
      if (msg.type === 'docxEdit') this.editFailed(panel, msg.requestId, { code: 'internal', message: 'The edit could not be applied.' });
      else if ('requestId' in msg) this.fail(panel, msg.requestId, 'internal', 'Something went wrong reading the document.');
    });
  }

  /** Test seam: resolves when the message has been handled. */
  async handle(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: DocxToHost): Promise<void> {
    switch (msg.type) {
      case 'docxRequestRender': return this.sendRender(doc, panel);
      case 'docxRequestBlockModel': return this.requestBlockModel(doc, panel, msg.requestId, msg.blockId);
      case 'docxEdit': return this.enqueueEdit(doc, panel, msg);
      default:
        return;   // common messages never reach here: the base handles every well-formed one first
    }
  }

  /**
   * `docxRender`. Flag off (or a document that cannot be edited): the package's original bytes and no
   * block list, as in the view-only viewer. Otherwise the render copy of the current state with the
   * block list. The document already passed the pre-render DOCTYPE guard when it loaded (spec §12).
   */
  private async sendRender(doc: OfficeDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (!doc.pkg) {
      this.sendState(doc, panel);   // shows the error view
      return;
    }
    this.applyProtection(doc);
    if (!OFFICE_FLAGS.docxEdit || !doc.canEdit) {
      this.post(panel, { type: 'docxRender', version: doc.version, bytes: plainBytes(doc.pkg.originalBytes), blocks: [] });
      return;
    }
    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const pkg: OfficePackage | null = doc.pkg;
      const ctx = await this.docxContext(doc);
      if (!ctx || !pkg) { this.sendState(doc, panel); return; }
      const version = doc.version;
      const copy = await buildRenderCopyAsync(pkg, ctx.model);
      // An edit applied while the copy was deflating would leave the bytes and the block list a
      // version apart: build again (rare; an edit result carries its own block list).
      if (doc.pkg !== pkg || doc.version !== version) continue;
      this.post(panel, { type: 'docxRender', version, bytes: plainBytes(copy.bytes), blocks: blockInfos(ctx) });
      return;
    }
    // Still moving after several tries: the webview asks again after the next state change.
  }

  private async requestBlockModel(doc: OfficeDocument, panel: vscode.WebviewPanel, requestId: number, blockId: number): Promise<void> {
    this.applyProtection(doc);
    if (!OFFICE_FLAGS.docxEdit || !doc.canEdit) { this.fail(panel, requestId, READ_ONLY.code, READ_ONLY.message); return; }
    const ctx = await this.docxContext(doc);
    if (!ctx) { this.sendState(doc, panel); return; }
    const block = ctx.model.block(blockId);
    if (!block) { this.fail(panel, requestId, 'stale', 'This paragraph no longer exists. Try again.'); return; }
    if (block.kind !== 'paragraph') { this.fail(panel, requestId, 'blocked', "This content can't be edited here. It is preserved as is."); return; }
    this.post(panel, {
      type: 'docxBlockModel', requestId, version: doc.version, blockId, segments: segmentDtos(ctx.model, ctx.styles, block),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Edits

  private enqueueEdit(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: EditMsg): Promise<void> {
    const prev = this.editQueues.get(doc) ?? Promise.resolve();
    const run = prev.then(() => this.runEdit(doc, panel, msg)).catch((e) => {
      console.error('[DocxEditor] edit failed', e);
      this.editFailed(panel, msg.requestId, { code: 'internal', message: 'The edit could not be applied.' });
    });
    this.editQueues.set(doc, run);
    return run;
  }

  private editFailed(panel: vscode.WebviewPanel, requestId: number, error: OfficeError): void {
    this.post(panel, { type: 'docxEditResult', requestId, ok: false, error });
  }

  private async runEdit(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: EditMsg): Promise<void> {
    const fail = (error: OfficeError): void => this.editFailed(panel, msg.requestId, error);
    const stale = (): void => fail({ code: 'stale', message: 'The document changed. Your edit was not applied.' });
    if (!OFFICE_FLAGS.docxEdit) { fail(READ_ONLY); return; }
    this.applyProtection(doc);
    const refusal = doc.editRefusal();
    if (refusal) { fail(refusal); return; }
    if (msg.baseVersion !== doc.version) { stale(); return; }
    const pkg = doc.pkg;
    const ctx = pkg ? await this.docxContext(doc) : null;
    if (!ctx || !pkg) { fail({ code: 'internal', message: "This document can't be edited." }); return; }
    // The model load awaited: anything may have happened meanwhile.
    const again = doc.editRefusal();
    if (again) { fail(again); return; }
    if (doc.pkg !== pkg || msg.baseVersion !== doc.version) { stale(); return; }

    const res = applyDocxEdit(ctx, msg.edit);
    if (!res.ok) { fail(res.error); return; }
    // applyDocxEdit applied the edit already (and refreshed the model): register it for undo, never apply it again.
    const rec = doc.recordApplied(res.edit, pkg);
    if (!rec.ok) {
      // recordApplied rolled the package back: the model and the stylesheets follow.
      try { ctx.styles.reload(); ctx.numbering.reload(); ctx.model.refresh(); } catch { this.models.delete(pkg); }
      fail(rec.error);
      return;
    }
    this.post(panel, {
      type: 'docxEditResult', requestId: msg.requestId, ok: true, version: doc.version,
      blocks: blockInfos(ctx), changedBlockIds: res.changedBlockIds,
      ...(res.focus ? { focus: res.focus } : {}),
    });
  }
}

/**
 * A plain Uint8Array that owns exactly the given bytes. A Node Buffer (a Uint8Array subclass) or a
 * view into a larger pooled buffer is copied: Buffer#slice shares memory instead of copying, and a
 * non-plain view can reach the webview as something docx-preview/JSZip cannot read.
 */
function plainBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor !== Uint8Array || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    return new Uint8Array(bytes);
  }
  return bytes;
}
