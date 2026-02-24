import * as vscode from 'vscode';
import { LanguageToolService } from './languageToolService.js';
import { LanguageToolMatch, GrammarMatch } from './types.js';
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

export interface GrammarResultsEvent {
  uri: vscode.Uri;
  matches: GrammarMatch[];
}

export class LanguageToolDiagnosticsProvider implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private languageToolService: LanguageToolService;
  private disposables: vscode.Disposable[] = [];
  private checkTimer: ReturnType<typeof setTimeout> | undefined;

  /** Accumulated grammar matches per document (for incremental merging). */
  private storedMatches = new Map<string, GrammarMatch[]>();

  /** Function to get cursor offset for a document (set by extension). */
  private getCursorOffset: ((uri: vscode.Uri) => number | undefined) | undefined;

  private _onGrammarResults = new vscode.EventEmitter<GrammarResultsEvent>();
  public readonly onGrammarResults = this._onGrammarResults.event;

  constructor(
    languageToolService: LanguageToolService,
    diagnosticCollection: vscode.DiagnosticCollection
  ) {
    this.languageToolService = languageToolService;
    this.diagnosticCollection = diagnosticCollection;

    // Listen for text document changes to trigger incremental re-checking
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'markdown') {
          this.scheduleIncrementalCheck(e.document);
        }
      })
    );

    // Clear diagnostics when a document is closed
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.diagnosticCollection.delete(doc.uri);
        this.storedMatches.delete(doc.uri.toString());
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

  /** Set a function to retrieve cursor offset for incremental checking. */
  public setCursorOffsetProvider(fn: (uri: vscode.Uri) => number | undefined): void {
    this.getCursorOffset = fn;
  }

  private scheduleIncrementalCheck(document: vscode.TextDocument): void {
    if (!this.languageToolService.isEnabled()) {
      return;
    }

    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }

    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.runIncrementalCheck(document);
    }, this.languageToolService.getCheckDelay());
  }

  /**
   * Run a full grammar check on the entire document (manual "Grammar" button).
   * Returns the number of issues found.
   */
  public async runCheck(document: vscode.TextDocument): Promise<number> {
    const originalText = document.getText();
    const { text: strippedText, offsetMap } = stripMarkdownForChecking(originalText);

    if (strippedText.trim().length === 0) {
      this.diagnosticCollection.set(document.uri, []);
      this.storedMatches.set(document.uri.toString(), []);
      return 0;
    }

    const matches = await this.languageToolService.check(strippedText);

    const diagnostics = matches
      .map((match) => this.matchToDiagnostic(document, match, offsetMap))
      .filter((d): d is vscode.Diagnostic => d !== undefined);

    this.diagnosticCollection.set(document.uri, diagnostics);

    const grammarMatches: GrammarMatch[] = matches
      .map((match) => this.matchToGrammarMatch(match, offsetMap, originalText))
      .filter((m): m is GrammarMatch => m !== undefined);

    // Store and emit
    this.storedMatches.set(document.uri.toString(), grammarMatches);
    this._onGrammarResults.fire({ uri: document.uri, matches: grammarMatches });

    return grammarMatches.length;
  }

  /**
   * Run an incremental grammar check on just the paragraph around the cursor.
   * Merges results with existing matches from other parts of the document.
   */
  private async runIncrementalCheck(document: vscode.TextDocument): Promise<void> {
    const cursorOffset = this.getCursorOffset?.(document.uri);
    if (cursorOffset === undefined) {
      return;
    }

    const originalText = document.getText();
    const { start: paraStart, end: paraEnd } = this.findParagraphBounds(originalText, cursorOffset);
    const paragraph = originalText.slice(paraStart, paraEnd);

    if (paragraph.trim().length === 0) {
      return;
    }

    const { text: strippedParagraph, offsetMap: paraOffsetMap } = stripMarkdownForChecking(paragraph);

    if (strippedParagraph.trim().length === 0) {
      return;
    }

    let matches: LanguageToolMatch[];
    try {
      matches = await this.languageToolService.check(strippedParagraph);
    } catch {
      return; // Silently fail for auto-checks
    }

    // Convert API matches to GrammarMatches with document-level offsets
    const newParaMatches: GrammarMatch[] = matches
      .map((match) => this.matchToGrammarMatch(match, paraOffsetMap, paragraph))
      .filter((m): m is GrammarMatch => m !== undefined)
      .map((m) => ({
        ...m,
        originalOffset: m.originalOffset + paraStart,
      }));

    // Merge with existing stored matches:
    // Remove old matches in the paragraph range, add new ones
    const existing = this.storedMatches.get(document.uri.toString()) || [];
    const merged = existing.filter(
      (m) => m.originalOffset + m.originalLength <= paraStart || m.originalOffset >= paraEnd
    );
    merged.push(...newParaMatches);
    merged.sort((a, b) => a.originalOffset - b.originalOffset);

    this.storedMatches.set(document.uri.toString(), merged);

    // Update diagnostics
    const diagnostics = matches
      .map((match) => {
        // Adjust match offset to document-level
        const adjusted = { ...match, offset: match.offset };
        return this.matchToDiagnostic(document, adjusted, paraOffsetMap, paraStart);
      })
      .filter((d): d is vscode.Diagnostic => d !== undefined);

    // Merge diagnostics: keep existing outside paragraph, add new ones
    const existingDiags = (this.diagnosticCollection.get(document.uri) || []) as vscode.Diagnostic[];
    const mergedDiags = existingDiags.filter((d) => {
      const offset = document.offsetAt(d.range.start);
      return offset < paraStart || offset >= paraEnd;
    });
    mergedDiags.push(...diagnostics);

    this.diagnosticCollection.set(document.uri, mergedDiags);

    // Emit merged results
    this._onGrammarResults.fire({ uri: document.uri, matches: merged });
  }

  /**
   * Find the paragraph boundaries around a cursor offset.
   * A paragraph is delimited by blank lines (\n\n).
   */
  private findParagraphBounds(text: string, offset: number): { start: number; end: number } {
    // Find start: search backward for a blank line
    let start = offset;
    while (start > 0) {
      const prevNewline = text.lastIndexOf('\n', start - 1);
      if (prevNewline === -1) {
        start = 0;
        break;
      }
      // Check if this newline is preceded by another newline (blank line)
      if (prevNewline > 0 && text[prevNewline - 1] === '\n') {
        start = prevNewline + 1;
        break;
      }
      start = prevNewline;
    }

    // Find end: search forward for a blank line
    let end = offset;
    while (end < text.length) {
      const nextNewline = text.indexOf('\n', end);
      if (nextNewline === -1) {
        end = text.length;
        break;
      }
      // Check if followed by another newline (blank line)
      if (nextNewline + 1 < text.length && text[nextNewline + 1] === '\n') {
        end = nextNewline;
        break;
      }
      end = nextNewline + 1;
    }

    return { start, end };
  }

  private matchToDiagnostic(
    document: vscode.TextDocument,
    match: LanguageToolMatch,
    offsetMap: number[],
    baseOffset: number = 0,
  ): vscode.Diagnostic | undefined {
    if (match.offset >= offsetMap.length) {
      return undefined;
    }

    const originalStart = offsetMap[match.offset];
    if (originalStart === undefined) {
      return undefined;
    }

    const lastStrippedIdx = Math.min(match.offset + match.length - 1, offsetMap.length - 1);
    const originalEnd = (offsetMap[lastStrippedIdx] ?? originalStart) + 1;

    const startPos = document.positionAt(originalStart + baseOffset);
    const endPos = document.positionAt(originalEnd + baseOffset);
    const range = new vscode.Range(startPos, endPos);

    const severity = match.rule.issueType === 'misspelling'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;

    const diagnostic = new vscode.Diagnostic(range, match.message, severity);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = match.rule.id;

    diagnosticDataMap.set(diagnostic, {
      ruleId: match.rule.id,
      replacements: match.replacements.map((r) => r.value),
    });

    return diagnostic;
  }

  private matchToGrammarMatch(
    match: LanguageToolMatch,
    offsetMap: number[],
    originalText: string,
  ): GrammarMatch | undefined {
    if (match.offset >= offsetMap.length) {
      return undefined;
    }
    const originalStart = offsetMap[match.offset];
    if (originalStart === undefined) {
      return undefined;
    }
    const lastStrippedIdx = Math.min(match.offset + match.length - 1, offsetMap.length - 1);
    const originalEnd = (offsetMap[lastStrippedIdx] ?? originalStart) + 1;

    return {
      originalOffset: originalStart,
      originalLength: originalEnd - originalStart,
      matchedText: originalText.slice(originalStart, originalEnd),
      message: match.message,
      shortMessage: match.shortMessage,
      severity: match.rule.issueType === 'misspelling' ? 'error' : 'warning',
      ruleId: match.rule.id,
      replacements: match.replacements.map((r) => r.value).slice(0, 5),
    };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onGrammarResults.dispose();
    this.diagnosticCollection.clear();
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }
  }
}
