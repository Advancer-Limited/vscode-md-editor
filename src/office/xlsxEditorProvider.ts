// Excel workbook viewer provider (viewType `vscodeMdEditor.xlsx`), spec §4.1, §5.2, §7.2.
//
// WP-14: the view path. Glue only: the DTO building lives in core/xlsx/view.ts, find.ts and
// notices.ts so it is bundle-testable. Editing (Phase 2) stays off while `OFFICE_FLAGS.xlsxEdit`
// is false; `xlsxEdit` is then answered with a `read-only` error.
//
// WP-23: `xlsxEdit` -> `applyXlsxEdit` (core/xlsx/ops.ts, which applies as it builds) ->
// `doc.recordApplied` (VS Code undo stack) -> `xlsxEditResult`. Edits are processed strictly in
// arrival order (a per-document queue; spec §5). Undo/redo mutate the package in place, so `onEdited`
// drops the workbook/model cache and the webview refetches.

import * as vscode from 'vscode';
import { getBrandButtonHtml } from '../utils.js';
import { OfficeEditorProviderBase, officeCsp } from './officeEditorProviderBase.js';
import type { OfficeDocument } from './officeDocument.js';
import { parseXlsxToHost } from './protocol.js';
import type { OfficeError, OfficeNotice, XlsxEditOp, XlsxSheetInfo, XlsxSheetMeta, XlsxToHost } from './protocol.js';
import type { OfficePackage } from './core/package.js';
import { OfficeLoadError } from './core/sniff.js';
import { attr, child } from './core/xml.js';
import { Workbook, SheetLoadError } from './core/xlsx/workbook.js';
import type { Sheet } from './core/xlsx/sheet.js';
import { StyleTable } from './core/xlsx/styles.js';
import { editSeed } from './core/xlsx/format.js';
import { applyXlsxEdit, refreshAfterEdit, refreshAfterUnknownEdit } from './core/xlsx/ops.js';
import { displayFormula } from './core/xlsx/sharedFormula.js';
import { CopyTooLargeError, TSV_MAX_CELLS, cellWindow, clampRange, sheetMeta, toTsv } from './core/xlsx/view.js';
import { findInWorkbook } from './core/xlsx/find.js';
import { describeLoadFailure, describeUnexpectedError } from './loadErrors.js';
import { packageValidator } from './core/save.js';
import type { Validator } from './core/save.js';
import { xlsxValidator } from './core/xlsx/validate.js';
import { OFFICE_FLAGS } from './featureFlags.js';

/** `fullCalcAtLoad`: the workbook asks Excel to recalculate on open (`calcPr/@fullCalcOnLoad`, Gate R2 F9). */
interface Model { wb: Workbook; styles: StyleTable; fullCalcAtLoad: boolean }

/**
 * The Tier C modal's title (review N2): a delete-sheet confirmation names the sheet (its detail says
 * what goes with it); the other lists are about content that will not follow the change.
 */
export function confirmTitle(op: XlsxEditOp, wb: Workbook): string {
  if (op.op === 'deleteSheet') {
    const name = wb.entry(op.sheetId)?.name;
    return name !== undefined ? `Delete sheet "${name}"?` : 'Delete this sheet?';
  }
  if (op.op === 'renameSheet') return 'Some content refers to this sheet by name and will not be updated.';
  return 'This change will not be fully applied everywhere.';
}

/** Whether `workbook.xml` has `calcPr/@fullCalcOnLoad` on: cached formula results may be out of date (§9.5). */
function hasFullCalcOnLoad(wb: Workbook): boolean {
  try {
    const root = wb.pkg.xml(wb.workbookPart).root;
    const calcPr = child(root, root.ns, 'calcPr');
    const v = calcPr ? attr(calcPr, '', 'fullCalcOnLoad') : undefined;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/**
 * Spec §9.5: shown once the workbook has any edit, or when it already asks Excel to recalculate on
 * open (saved here, or by another tool, without recalculating) — cached formula results may be out of date.
 */
export const STALE_FORMULAS_NOTICE: OfficeNotice = {
  severity: 'info',
  code: 'formula-results-stale',
  message: 'Formula results are from the last calculation in Excel and will update when the file is next opened there.',
};

/** Spec §9.3: sent just before the seed of a cell whose text carries inline formatting. */
export const RICH_TEXT_NOTICE: OfficeNotice = {
  severity: 'info',
  code: 'rich-text-cell',
  message: 'This cell has formatting inside its text. Editing it replaces the text with plain text.',
};

/** Operations behind the `xlsxStructure` flag (plan §3.1): refused here while it is off, whatever the webview sends. */
const STRUCTURAL_OPS: ReadonlySet<string> = new Set([
  'insertRows', 'deleteRows', 'insertCols', 'deleteCols', 'addSheet', 'renameSheet', 'deleteSheet',
]);

type EditMsg = Extract<XlsxToHost, { type: 'xlsxEdit' }>;

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
  /** Tail of each document's edit queue: edits and their confirmations run one at a time, in order. */
  private readonly editQueues = new WeakMap<OfficeDocument, Promise<void>>();
  /** The generation at which a document was last edited; the stale-formulas banner shows while it matches. */
  private readonly editedAt = new WeakMap<OfficeDocument, number>();
  /** Last meta built per sheet (see `metaFor`). */
  private metaCache = new WeakMap<Sheet, XlsxSheetMeta>();
  /** Panels showing the sheet-unavailable warning, with it (cleared when a sheet then loads). */
  private readonly unavailableShown = new WeakMap<vscode.WebviewPanel, OfficeNotice>();
  /** requestId of the newest find per panel; older finds still running stop at their next yield. */
  private readonly latestFind = new WeakMap<vscode.WebviewPanel, number>();

  protected scripts(): string[] {
    return ['officeCommon.js', 'xlsxGridMath.js', 'xlsxGrid.js', 'xlsxEditor.js', 'xlsxCellEditor.js', 'xlsxStructureUi.js'];
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
    return /* html */ `  <div id="office-app" class="office-app" data-sheet-appearance="${this.sheetAppearance()}" data-structure="${OFFICE_FLAGS.xlsxStructure ? 'on' : 'off'}">
    <div id="office-toolbar" class="office-toolbar"></div>
    <div id="office-banner" class="office-banner"></div>
    <div id="office-content" class="office-content xlsx-content"></div>
  </div>
  <div id="office-brand" hidden>${getBrandButtonHtml()}</div>`;
  }

  protected csp(webview: vscode.Webview, nonce: string): string {
    return officeCsp(webview.cspSource, nonce, false);
  }

  /** Spec §6.5 step 4 / §13.3: the package rules, then every xlsx rule (styles rules when styles.xml changed). */
  protected validators(): Validator[] {
    return [packageValidator, xlsxValidator];
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
      const m = { wb, styles: StyleTable.load(pkg, wb.stylesPart, wb.themePart), fullCalcAtLoad: hasFullCalcOnLoad(wb) };
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

  private sendWorkbook(doc: OfficeDocument, panel: vscode.WebviewPanel, force: boolean, activeOverride?: number): void {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    const wm = this.workbookMessage(doc, m);
    const { sheets } = wm;
    const activeSheetId = activeOverride !== undefined && sheets.some((s) => s.id === activeOverride) ? activeOverride : wm.activeSheetId;
    const key = JSON.stringify(sheets);
    if (!force && this.sentInfo.get(panel) === key) return;
    this.sentInfo.set(panel, key);
    this.post(panel, { type: 'xlsxWorkbook', version: doc.version, sheets, activeSheetId });
  }

  protected onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.sendWorkbook(doc, panel, true);
    this.sendStaleBanner(doc, panel);
  }

  protected onReloaded(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    this.post(panel, { type: 'xlsxStateChanged', version: doc.version, invalidate: 'workbook' });
    this.sendWorkbook(doc, panel, true);
    this.sendStaleBanner(doc, panel);
  }

  /**
   * `init` carries the notices known before the workbook model is built; `fullCalcOnLoad` is only
   * known once it is (sendWorkbook builds it). Re-send the notices when that adds the banner.
   */
  private sendStaleBanner(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    if (this.editedAt.get(doc) === doc.generation) return;   // already in the notices sent with init
    if (this.resultsMayBeStale(doc)) this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
  }

  /**
   * Undo/redo (VS Code's stack) changed the package in place. The workbook model is refreshed in place
   * (sheet list re-read, every loaded sheet re-indexed, styles reloaded) rather than dropped: a fresh
   * model numbers the sheets by position, so after an add/delete sheet was undone the webview's session
   * sheet id would name another sheet (review S4, K14). The webview is told to refetch.
   */
  protected onEdited(doc: OfficeDocument, panel: vscode.WebviewPanel): void {
    const m = doc.pkg ? this.models.get(doc.pkg) : undefined;
    if (m) {
      try {
        refreshAfterUnknownEdit(m.wb, m.styles);
      } catch (e) {
        console.error('[XlsxEditor] model refresh after undo/redo failed; rebuilding it', e);
        if (doc.pkg) this.models.delete(doc.pkg);
      }
    }
    this.editedAt.set(doc, doc.generation);
    this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
    this.onReloaded(doc, panel);
  }

  /**
   * Whether cached formula results may be out of date (spec §9.5): the workbook was edited in this
   * generation, or it was loaded with `fullCalcOnLoad` on (Gate R2 F9: after a save and reopen).
   */
  private resultsMayBeStale(doc: OfficeDocument): boolean {
    if (this.editedAt.get(doc) === doc.generation) return true;
    return doc.pkg !== null && this.models.get(doc.pkg)?.fullCalcAtLoad === true;
  }

  protected panelNotices(panel: vscode.WebviewPanel): OfficeNotice[] {
    const n = this.unavailableShown.get(panel);
    return n ? [n] : [];
  }

  /** The stale-formulas banner (spec §9.5). */
  protected kindNotices(doc: OfficeDocument): OfficeNotice[] {
    return this.resultsMayBeStale(doc) ? [STALE_FORMULAS_NOTICE] : [];
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
      case 'xlsxEdit': return this.enqueueEdit(doc, panel, msg);
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
      const notice: OfficeNotice = { severity: 'warning', code: 'sheet-unavailable', message: r.error.message };
      this.unavailableShown.set(panel, notice);
      this.post(panel, { type: 'notices', notices: [...this.allNotices(doc), notice] });
      return;
    }
    this.post(panel, { type: 'xlsxSheetMeta', meta: this.metaFor(m, r.sheet, sheetId, version) });
    // A sheet that loads replaces the one that could not: drop its warning.
    if (this.unavailableShown.delete(panel) && !doc.loadError) this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
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
    const meta = this.metaFor(m, r.sheet, sheetId, version);
    const clamped = clampRange(meta, range);
    if (!clamped) { this.fail(panel, requestId, 'invalid', 'That range is outside the sheet.'); return; }
    const w = cellWindow(m.wb, r.sheet, m.styles, clamped, this.resultsMayBeStale(doc));
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
    const meta = this.metaFor(m, r.sheet, sheetId, doc.version);
    if (!clampRange(meta, [row, col, row, col])) { this.fail(panel, requestId, 'invalid', 'That cell is outside the sheet.'); return; }
    const cell = r.sheet.cell(row, col);
    let input = cell ? editSeed(cell, m.styles, m.wb.date1904) : '';
    // A shared-formula dependant stores no formula of its own: seed the translated one, or the editor
    // would open on the cached value and committing it would replace the formula (spec §9.4).
    if (cell && cell.shared && !cell.shared.master) {
      const f = displayFormula(r.sheet, cell);
      if (f !== undefined) input = '=' + f;
    }
    if (cell?.rich) {
      this.post(panel, { type: 'notices', notices: [...this.allNotices(doc), RICH_TEXT_NOTICE] });
    }
    this.post(panel, { type: 'xlsxCellInput', requestId, sheetId, r: row, c: col, input });
  }

  // -------------------------------------------------------------------------------------------
  // Edits (WP-23, spec §5.2, §6.3)

  private enqueueEdit(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: EditMsg): Promise<void> {
    const prev = this.editQueues.get(doc) ?? Promise.resolve();
    const run = prev.then(() => this.runEdit(doc, panel, msg)).catch((e) => {
      console.error('[XlsxEditor] edit failed', e);
      this.editFailed(panel, msg.requestId, { code: 'internal', message: 'The edit could not be applied.' });
    });
    this.editQueues.set(doc, run);
    return run;
  }

  private editFailed(panel: vscode.WebviewPanel, requestId: number, error: OfficeError): void {
    this.post(panel, { type: 'xlsxEditResult', requestId, ok: false, error });
  }

  private async runEdit(doc: OfficeDocument, panel: vscode.WebviewPanel, msg: EditMsg): Promise<void> {
    const fail = (error: OfficeError): void => this.editFailed(panel, msg.requestId, error);
    const stale = (): void => fail({ code: 'stale', message: 'The workbook changed. Your edit was not applied.' });
    const refusal = doc.editRefusal();
    if (refusal) { fail(refusal); return; }
    if (msg.baseVersion !== doc.version) { stale(); return; }
    if (STRUCTURAL_OPS.has(msg.edit.op) && !OFFICE_FLAGS.xlsxStructure) {
      fail({ code: 'blocked', message: 'Inserting, deleting and renaming rows, columns and sheets is not available yet.' });
      return;
    }
    const m = this.model(doc);
    const pkg = doc.pkg;
    if (!m || !pkg) { fail({ code: 'internal', message: "This workbook can't be edited." }); return; }

    try {
      await this.runEditLoop(doc, panel, msg, m, pkg, fail, stale);
    } finally {
      // applyXlsxEdit changes the sheet in place across awaits, before the version moves on (or
      // without it moving, when the edit fails, is cancelled or is not recorded): a meta cached
      // meanwhile could describe a state that never had its version. Drop the cache.
      this.metaCache = new WeakMap();
    }
  }

  private async runEditLoop(
    doc: OfficeDocument, panel: vscode.WebviewPanel, msg: EditMsg, m: Model, pkg: OfficePackage,
    fail: (error: OfficeError) => void, stale: () => void,
  ): Promise<void> {
    // The core gives no new-sheet id back: the sheet list before the edit tells which one was added or
    // which neighbour to select after a delete (spec 9.7).
    const sheetsBefore = m.wb.sheets.map((s) => ({ id: s.id, state: s.state }));
    let confirmed = false;
    for (;;) {
      const res = await applyXlsxEdit(m.wb, pkg, msg.edit, { confirmed, styles: m.styles });
      if (!res.ok) { fail(res.error); return; }
      if (res.confirm && res.confirm.length > 0 && !confirmed) {
        // Tier C (spec §9.6): ask, then run the same operation again with the confirmation.
        if (!(await this.confirmEdit(msg.edit, res.confirm, m.wb))) { fail({ code: 'cancelled', message: 'Cancelled.' }); return; }
        if (msg.baseVersion !== doc.version) { stale(); return; }
        confirmed = true;
        continue;
      }
      // applyXlsxEdit applied the edit already: register it for undo, never apply it again.
      const rec = doc.recordApplied(res.edit, pkg);
      if (!rec.ok) {
        if (res.edit) refreshAfterEdit(m.wb, res.edit, m.styles);
        fail(rec.error);
        return;
      }
      if (res.edit) {
        this.editedAt.set(doc, doc.generation);
        // The sheet list changed: the core has already re-synced `wb.sheets` and kept the session ids, so
        // the model stays (a fresh load would renumber the sheets and the webview still holds the old ids).
      }
      const range = res.range ? [res.range[0], res.range[1], res.range[2], res.range[3]] as [number, number, number, number] : undefined;
      this.post(panel, {
        type: 'xlsxEditResult', requestId: msg.requestId, ok: true, version: doc.version, invalidate: res.invalidate,
        ...(res.sheetId !== undefined ? { sheetId: res.sheetId } : {}),
        ...(range ? { range } : {}),
      });
      if (res.edit) {
        this.post(panel, { type: 'notices', notices: this.allNotices(doc) });
        if (res.invalidate === 'workbook') this.sendWorkbook(doc, panel, true, this.sheetToSelect(m.wb, msg.edit, sheetsBefore));
      }
      return;
    }
  }

  /** After add: the new sheet; after delete: the nearest remaining visible sheet (the one before, else after). */
  private sheetToSelect(wb: Workbook, op: XlsxEditOp, before: ReadonlyArray<{ id: number; state: string }>): number | undefined {
    if (op.op === 'addSheet') {
      const known = new Set(before.map((s) => s.id));
      return wb.sheets.find((s) => !known.has(s.id) && s.state === 'visible')?.id;
    }
    if (op.op === 'deleteSheet') {
      const idx = before.findIndex((s) => s.id === op.sheetId);
      const alive = new Set(wb.sheets.filter((s) => s.state === 'visible').map((s) => s.id));
      for (let i = idx - 1; i >= 0; i--) if (alive.has(before[i].id)) return before[i].id;
      for (let i = idx + 1; i < before.length; i++) if (alive.has(before[i].id)) return before[i].id;
    }
    return undefined;
  }

  /** The modal for a Tier C list (default button Cancel); skipped when `confirmStructuralEdits` is off (spec §4.1). */
  private async confirmEdit(op: XlsxEditOp, lines: readonly string[], wb: Workbook): Promise<boolean> {
    const alwaysAsk = op.op === 'deleteSheet';   // §9.7: deleting a sheet always asks
    const setting = vscode.workspace.getConfiguration('vscodeMdEditor.office').get<boolean>('confirmStructuralEdits', true);
    if (setting === false && !alwaysAsk) return true;
    const proceed = 'Continue';
    const answer = await vscode.window.showWarningMessage(
      confirmTitle(op, wb),
      { modal: true, detail: lines.join('\n') },
      proceed,
    );
    return answer === proceed;
  }

  private async find(
    doc: OfficeDocument, panel: vscode.WebviewPanel, requestId: number, query: string, matchCase: boolean, sheetId: number | null,
  ): Promise<void> {
    const m = this.model(doc);
    if (!m) { this.sendState(doc, panel); return; }
    if (sheetId !== null && !m.wb.entry(sheetId)) { this.fail(panel, requestId, 'invalid', 'That sheet does not exist.'); return; }
    // A newer find on this panel supersedes this one: stop searching (it still gets its one reply).
    this.latestFind.set(panel, requestId);
    const res = await findInWorkbook(m.wb, query, matchCase, sheetId, m.styles, () => this.latestFind.get(panel) !== requestId);
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
    let text: string;
    try {
      text = toTsv(m.wb, r.sheet, m.styles, range);
    } catch (e) {
      if (!(e instanceof CopyTooLargeError)) throw e;
      void vscode.window.showWarningMessage(
        `Nothing was copied: the selection holds ${e.cells.toLocaleString('en-US')} cells and the limit is `
        + `${TSV_MAX_CELLS.toLocaleString('en-US')}. Select a smaller range, or open the workbook in Excel.`);
      return;
    }
    await vscode.env.clipboard.writeText(text);
  }

  /**
   * The sheet's meta for `version` (the version the caller's answer is built for, captured before
   * any await), computed once per (sheet, version): building it walks every row, the merges and
   * the notices, far too slow to repeat per cell request (181 ms on a 300k-row sheet).
   * Every change to a sheet bumps `doc.version`, and a reload makes a new Sheet, so the key is safe.
   */
  private metaFor(m: Model, sheet: Sheet, sheetId: number, version: number): XlsxSheetMeta {
    const hit = this.metaCache.get(sheet);
    if (hit && hit.version === version && hit.sheetId === sheetId) return hit;
    const meta = sheetMeta(m.wb, sheet, m.styles, sheetId, version);
    this.metaCache.set(sheet, meta);
    return meta;
  }
}
