// Excel workbook viewer provider (viewType `vscodeMdEditor.xlsx`), spec §4.1, §5.2, §7.2.
//
// WP-14: the view path. Glue only: the DTO building lives in core/xlsx/view.ts, find.ts and
// notices.ts so it is bundle-testable. Editing (Phase 2) stays off while `OFFICE_FLAGS.xlsxEdit`
// is false; `xlsxEdit` is answered with a `read-only` error.

import * as vscode from 'vscode';
import { getBrandButtonHtml } from '../utils.js';
import { OfficeEditorProviderBase, officeCsp } from './officeEditorProviderBase.js';
import type { OfficeDocument } from './officeDocument.js';
import { parseXlsxToHost } from './protocol.js';
import type { OfficeError, XlsxSheetInfo, XlsxToHost } from './protocol.js';
import type { OfficePackage } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { attr, child } from './core/xml.js';
import { Workbook, SheetLoadError } from './core/xlsx/workbook.js';
import type { Sheet } from './core/xlsx/sheet.js';
import { StyleTable } from './core/xlsx/styles.js';
import { editSeed } from './core/xlsx/format.js';
import { cellWindow, clampRange, sheetMeta, toTsv } from './core/xlsx/view.js';
import { findInWorkbook } from './core/xlsx/find.js';
import { describeLoadFailure, describeUnexpectedError } from './loadErrors.js';

interface Model { wb: Workbook; styles: StyleTable }

export type SheetAppearance = 'theme' | 'light';

export class XlsxEditorProvider extends OfficeEditorProviderBase {
  public static readonly viewType = 'vscodeMdEditor.xlsx';

  /** Registration options (spec §4.1): own find (the grid is virtualised), one editor per document. */
  public static readonly registrationOptions = {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
    supportsMultipleEditorsPerDocument: false,
  } as const;

  /** Registers the provider. Cheap: nothing is read or parsed until a .xlsx is opened. */
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      XlsxEditorProvider.viewType,
      new XlsxEditorProvider(context),
      XlsxEditorProvider.registrationOptions,
    );
  }

  protected readonly kind = 'xlsx' as const;

  /** Workbook + style table per loaded package (a reload makes a new package, so a new model). */
  private readonly models = new WeakMap<OfficePackage, Model>();
  /** JSON of the last `xlsxWorkbook` sent per panel, to re-send only when sheet info changed. */
  private readonly sentInfo = new WeakMap<vscode.WebviewPanel, string>();

  protected scripts(): string[] {
    return ['officeCommon.js', 'xlsxGridMath.js', 'xlsxGrid.js', 'xlsxEditor.js'];
  }

  protected styles(): string[] {
    return ['officeCommon.css', 'xlsxGrid.css', 'xlsxEditor.css'];
  }

  /** `vscodeMdEditor.office.sheetAppearance`: read when the editor opens (webview carries it as a data attribute). */
  private sheetAppearance(): SheetAppearance {
    const v = vscode.workspace.getConfiguration('vscodeMdEditor.office').get<string>('sheetAppearance');
    return v === 'light' ? 'light' : 'theme';
  }

  protected bodyHtml(): string {
    // Static markup only (the appearance value is one of two literals). The brand button is
    // host-generated and is moved into the toolbar by the webview script.
    return /* html */ `  <div id="office-app" class="office-app" data-sheet-appearance="${this.sheetAppearance()}">
    <div id="office-toolbar" class="office-toolbar"></div>
    <div id="office-banner" class="office-banner"></div>
    <div id="office-content" class="office-content xlsx-content"></div>
  </div>
  <div id="office-brand" hidden>${getBrandButtonHtml()}</div>`;
  }

  protected csp(webview: vscode.Webview, nonce: string): string {
    return officeCsp(webview.cspSource, nonce, false);
  }

  // -------------------------------------------------------------------------------------------
  // Model

  /** The workbook model for the document's current package; null (and a load error set) when it is malformed. */
  private model(doc: OfficeDocument): Model | null {
    const pkg = doc.pkg;
    if (!pkg) return null;
    const hit = this.models.get(pkg);
    if (hit) return hit;
    try {
      const wb = Workbook.load(pkg);
      const m = { wb, styles: StyleTable.load(pkg, wb.stylesPart, wb.themePart) };
      this.models.set(pkg, m);
      return m;
    } catch (e) {
      doc.loadError = e instanceof OfficeLoadError
        ? describeLoadFailure(e.failure, 'xlsx', e.detail)
        : describeUnexpectedError('xlsx', e);
      return null;
    }
  }

  private workbookMessage(doc: OfficeDocument, m: Model): { sheets: XlsxSheetInfo[]; activeSheetId: number } {
    const { wb } = m;
    const sheets: XlsxSheetInfo[] = wb.sheets.map((e) => {
      const loaded = wb.loadedSheet(e.id);
      const reason = doc.readOnlyReason ?? wb.viewOnlyReason ?? loaded?.readOnlyReason ?? null;
      return {
        id: e.id, name: e.name, kind: e.kind, state: e.state,
        canEdit: doc.canEdit && e.kind === 'worksheet' && reason === null,
        readOnlyReason: reason,
      };
    });
    // The workbook's active tab when it is a visible sheet, else the first visible sheet, else the first.
    let active = wb.sheets.find((e) => e.state === 'visible') ?? wb.sheets[0];
    try {
      const root = wb.pkg.xml(wb.workbookPart).root;
      const views = child(root, root.ns, 'bookViews');
      const view = views ? child(views, root.ns, 'workbookView') : undefined;
      const idx = view ? Number(attr(view, '', 'activeTab') ?? 0) : 0;
      const tab = wb.sheets[idx];
      if (tab && tab.state === 'visible') active = tab;
    } catch { /* keep the fallback */ }
    return { sheets, activeSheetId: active ? active.id : 0 };
  }

  private sendWorkbook(doc: OfficeDocument, panel: vscode.WebviewPanel, force: boolean): void {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    const { sheets, activeSheetId } = this.workbookMessage(doc, m);
    const key = JSON.stringify(sheets);
    if (!force && this.sentInfo.get(panel) === key) return;
    this.sentInfo.set(panel, key);
    this.post(panel, { type: 'xlsxWorkbook', version: doc.version, sheets, activeSheetId });
  }

  protected onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.sendWorkbook(doc, panel, true);
  }

  protected onReloaded(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.post(panel, { type: 'xlsxStateChanged', version: doc.version, invalidate: 'workbook' });
    this.sendWorkbook(doc, panel, true);
  }

  // -------------------------------------------------------------------------------------------
  // Messages

  protected onMessage(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): void {
    const msg = parseXlsxToHost(raw);
    if (!msg) {
      this.replyInvalid(panel, raw);
      return;
    }
    this.handle(doc, panel, msg).catch((e) => {
      console.error('[XlsxEditor] message failed', msg.type, e);
      if ('requestId' in msg) this.fail(panel, msg.requestId, 'internal', 'Something went wrong reading the workbook.');
    });
  }

  /** Test seam: resolves when the message has been handled. */
  async handle(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: XlsxToHost): Promise<void> {
    switch (msg.type) {
      case 'xlsxRequestSheetMeta': return this.requestSheetMeta(doc, panel, msg.sheetId);
      case 'xlsxRequestCells': return this.requestCells(doc, panel, msg.requestId, msg.sheetId, msg.range);
      case 'xlsxRequestCellInput': return this.requestCellInput(doc, panel, msg.requestId, msg.sheetId, msg.r, msg.c);
      case 'xlsxFind': return this.find(doc, panel, msg.requestId, msg.query, msg.matchCase, msg.sheetId);
      case 'xlsxCopy': return this.copy(doc, msg.sheetId, msg.range, msg.format);
      case 'xlsxEdit':
        this.post(panel, {
          type: 'xlsxEditResult', requestId: msg.requestId, ok: false,
          error: { code: 'read-only', message: 'This workbook is open read-only.' },
        });
        return;
      default:
        return;   // common messages never reach here: the base handles every well-formed one first
    }
  }

  /** Load a worksheet for a request; on failure returns the error to report. */
  private async loadSheet(m: Model, sheetId: number): Promise<{ sheet: Sheet } | { error: OfficeError }> {
    try {
      return { sheet: await m.wb.sheet(sheetId) };
    } catch (e) {
      if (e instanceof SheetLoadError) {
        const code: OfficeError['code'] = e.failure === 'unknown-sheet' ? 'invalid'
          : e.failure === 'not-worksheet' || e.failure === 'too-large' ? 'blocked' : 'internal';
        const message = e.failure === 'too-large'
          ? 'This sheet is too large to display here. Open it in Excel to view it.'
          : e.failure === 'unknown-sheet' ? 'That sheet does not exist.'
          : e.failure === 'not-worksheet' ? 'This sheet has no cells to display.'
          : "This sheet is damaged and can't be displayed.";
        return { error: { code, message } };
      }
      throw e;
    }
  }

  private async requestSheetMeta(doc: OfficeDocument, panel: vscode.WebviewPanel, sheetId: number): Promise<void> {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    const version = doc.version;   // the version this answer is built for (stale answers are discarded by the webview)
    const r = await this.loadSheet(m, sheetId);
    if ('error' in r) {
      // `xlsxRequestSheetMeta` has no requestId: report through the notices bar.
      this.post(panel, {
        type: 'notices',
        notices: [...this.allNotices(doc), { severity: 'warning', code: 'sheet-unavailable', message: r.error.message }],
      });
      return;
    }
    this.post(panel, { type: 'xlsxSheetMeta', meta: sheetMeta(m.wb, r.sheet, m.styles, sheetId, version) });
    this.sendWorkbook(doc, panel, false);   // the sheet's own read-only reason is known now
  }

  private async requestCells(
    doc: OfficeDocument, panel: vscode.WebviewPanel, requestId: number, sheetId: number, range: readonly number[],
  ): Promise<void> {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    const version = doc.version;
    const r = await this.loadSheet(m, sheetId);
    if ('error' in r) { this.fail(panel, requestId, r.error.code, r.error.message); return; }
    const meta = sheetMeta(m.wb, r.sheet, m.styles, sheetId, version);
    const clamped = clampRange(meta, range);
    if (!clamped) { this.fail(panel, requestId, 'invalid', 'That range is outside the sheet.'); return; }
    const w = cellWindow(m.wb, r.sheet, m.styles, clamped, false);
    this.post(panel, {
      type: 'xlsxCells', requestId, sheetId, version, range: clamped, cells: w.cells, styles: w.styles,
    });
  }

  private async requestCellInput(
    doc: OfficeDocument, panel: vscode.WebviewPanel, requestId: number, sheetId: number, row: number, col: number,
  ): Promise<void> {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    const r = await this.loadSheet(m, sheetId);
    if ('error' in r) { this.fail(panel, requestId, r.error.code, r.error.message); return; }
    const meta = sheetMeta(m.wb, r.sheet, m.styles, sheetId, doc.version);
    if (!clampRange(meta, [row, col, row, col])) { this.fail(panel, requestId, 'invalid', 'That cell is outside the sheet.'); return; }
    const cell = r.sheet.cell(row, col);
    const input = cell ? editSeed(cell, m.styles, m.wb.date1904) : '';
    this.post(panel, { type: 'xlsxCellInput', requestId, sheetId, r: row, c: col, input });
  }

  private async find(
    doc: OfficeDocument, panel: vscode.WebviewPanel, requestId: number, query: string, matchCase: boolean, sheetId: number | null,
  ): Promise<void> {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    if (sheetId !== null && !m.wb.entry(sheetId)) { this.fail(panel, requestId, 'invalid', 'That sheet does not exist.'); return; }
    const res = await findInWorkbook(m.wb, query, matchCase, sheetId, m.styles);
    this.post(panel, { type: 'xlsxFindResult', requestId, matches: res.matches, truncated: res.truncated });
  }

  private async copy(
    doc: OfficeDocument, sheetId: number, range: readonly number[], format: 'tsv' | 'markdown',
  ): Promise<void> {
    if (format !== 'tsv') return;   // Markdown stays hidden until WP-50
    const m = this.model(doc);
    if (!m) return;
    const r = await this.loadSheet(m, sheetId);
    if ('error' in r) return;
    await vscode.env.clipboard.writeText(toTsv(m.wb, r.sheet, m.styles, range));
  }
}
