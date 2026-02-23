import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE, diagnosticDataMap } from './diagnosticsProvider.js';

export class LanguageToolCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }

      const data = diagnosticDataMap.get(diagnostic);
      if (!data || data.replacements.length === 0) {
        continue;
      }

      // Create a quick fix for each replacement suggestion (max 5)
      for (const replacement of data.replacements.slice(0, 5)) {
        const action = new vscode.CodeAction(
          `Replace with "${replacement}"`,
          vscode.CodeActionKind.QuickFix
        );

        action.diagnostics = [diagnostic];

        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, diagnostic.range, replacement);
        action.edit = edit;

        // Mark the first suggestion as preferred
        if (actions.length === 0) {
          action.isPreferred = true;
        }

        actions.push(action);
      }
    }

    return actions;
  }
}
