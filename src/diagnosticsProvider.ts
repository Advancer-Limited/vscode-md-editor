import * as vscode from 'vscode';
import { LanguageToolService } from './languageToolService.js';
import { LanguageToolMatch } from './types.js';
import { stripMarkdownForChecking } from './utils.js';

export const DIAGNOSTIC_SOURCE = 'LanguageTool';

/**
 * Metadata stored per diagnostic so the CodeActionProvider can offer fixes.
 */
export interface DiagnosticData {
  ruleId: string;
  replacements: string[];
}

// Store diagnostic data in a WeakMap keyed by the diagnostic object.
export const diagnosticDataMap = new WeakMap<vscode.Diagnostic, DiagnosticData>();

export class LanguageToolDiagnosticsProvider implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private languageToolService: LanguageToolService;
  private disposables: vscode.Disposable[] = [];
  private checkTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    languageToolService: LanguageToolService,
    diagnosticCollection: vscode.DiagnosticCollection
  ) {
    this.languageToolService = languageToolService;
    this.diagnosticCollection = diagnosticCollection;

    // Listen for text document changes to trigger re-checking
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'markdown') {
          this.scheduleCheck(e.document);
        }
      })
    );

    // Clear diagnostics when a document is closed
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.diagnosticCollection.delete(doc.uri);
      })
    );

    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vscodeMdEditor.languageTool')) {
          this.languageToolService.refreshConfig();
        }
      })
    );
  }

  private scheduleCheck(document: vscode.TextDocument): void {
    if (!this.languageToolService.isEnabled()) {
      return;
    }

    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }

    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.runCheck(document);
    }, this.languageToolService.getCheckDelay());
  }

  /**
   * Run a grammar check immediately on the given document.
   */
  public async runCheck(document: vscode.TextDocument): Promise<void> {
    const originalText = document.getText();
    const { text: strippedText, offsetMap } = stripMarkdownForChecking(originalText);

    if (strippedText.trim().length === 0) {
      this.diagnosticCollection.set(document.uri, []);
      return;
    }

    const matches = await this.languageToolService.check(strippedText);

    const diagnostics = matches
      .map((match) => this.matchToDiagnostic(document, match, offsetMap))
      .filter((d): d is vscode.Diagnostic => d !== undefined);

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private matchToDiagnostic(
    document: vscode.TextDocument,
    match: LanguageToolMatch,
    offsetMap: number[]
  ): vscode.Diagnostic | undefined {
    // Map the stripped-text offset back to the original document offset
    if (match.offset >= offsetMap.length) {
      return undefined;
    }

    const originalStart = offsetMap[match.offset];
    if (originalStart === undefined) {
      return undefined;
    }

    // Find the end offset
    const lastStrippedIdx = Math.min(match.offset + match.length - 1, offsetMap.length - 1);
    const originalEnd = (offsetMap[lastStrippedIdx] ?? originalStart) + 1;

    const startPos = document.positionAt(originalStart);
    const endPos = document.positionAt(originalEnd);
    const range = new vscode.Range(startPos, endPos);

    const severity = match.rule.issueType === 'misspelling'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;

    const diagnostic = new vscode.Diagnostic(range, match.message, severity);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = match.rule.id;

    // Store metadata for the CodeActionProvider
    diagnosticDataMap.set(diagnostic, {
      ruleId: match.rule.id,
      replacements: match.replacements.map((r) => r.value),
    });

    return diagnostic;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.diagnosticCollection.clear();
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }
  }
}
