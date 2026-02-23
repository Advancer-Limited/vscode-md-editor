import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider.js';
import { LanguageToolService } from './languageToolService.js';
import { LanguageToolDiagnosticsProvider } from './diagnosticsProvider.js';
import { LanguageToolCodeActionProvider } from './codeActionsProvider.js';
import { FileIndexService } from './wikilink/fileIndexService.js';
import { BacklinkTreeProvider } from './wikilink/backlinkTreeProvider.js';
import { handleWillRenameFiles } from './wikilink/renamePropagation.js';
import { GraphDataService } from './graph/graphDataService.js';
import { GraphViewProvider } from './graph/graphViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  // 1. Create the file index service (shared foundation for wikilinks + graph)
  const fileIndexService = new FileIndexService();
  context.subscriptions.push(fileIndexService);
  fileIndexService.initialize();

  // 2. Register the custom markdown editor
  const provider = new MarkdownEditorProvider(context, fileIndexService);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // 2. Create the LanguageTool service
  const languageToolService = new LanguageToolService();

  // 3. Create the diagnostic collection
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('languagetool');
  context.subscriptions.push(diagnosticCollection);

  // 4. Create the diagnostics provider
  const diagnosticsProvider = new LanguageToolDiagnosticsProvider(
    languageToolService,
    diagnosticCollection
  );
  context.subscriptions.push(diagnosticsProvider);

  // 5. Register the code action provider for quick fixes
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'markdown', scheme: 'file' },
      new LanguageToolCodeActionProvider(),
      {
        providedCodeActionKinds: LanguageToolCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // 6. Register commands

  // "Check Grammar" command - works for both standard and custom editors
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.checkGrammar', () => {
      // Try the standard text editor first
      const textEditor = vscode.window.activeTextEditor;
      if (textEditor && textEditor.document.languageId === 'markdown') {
        diagnosticsProvider.runCheck(textEditor.document);
        return;
      }
      // Fall back to the custom editor's active document
      const activeDoc = provider.getActiveDocument();
      if (activeDoc) {
        diagnosticsProvider.runCheck(activeDoc);
      }
    })
  );

  // "Open with VS Code MD Editor" command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vscodeMdEditor.openWithEditor',
      (uri?: vscode.Uri) => {
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (targetUri) {
          vscode.commands.executeCommand(
            'vscode.openWith',
            targetUri,
            MarkdownEditorProvider.viewType
          );
        }
      }
    )
  );

  // "Set as Default Editor" command
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.setAsDefault', async () => {
      const config = vscode.workspace.getConfiguration();
      const associations =
        config.get<Record<string, string>>('workbench.editorAssociations') || {};

      associations['*.md'] = MarkdownEditorProvider.viewType;
      associations['*.markdown'] = MarkdownEditorProvider.viewType;

      await config.update(
        'workbench.editorAssociations',
        associations,
        vscode.ConfigurationTarget.Global
      );

      vscode.window.showInformationMessage(
        'VS Code MD Editor is now the default editor for .md and .markdown files.'
      );
    })
  );

  // 7. Register the backlink panel
  const getActiveFileUri = (): vscode.Uri | undefined => {
    // Try standard text editor first
    const textEditor = vscode.window.activeTextEditor;
    if (textEditor && textEditor.document.uri.fsPath.endsWith('.md')) {
      return textEditor.document.uri;
    }
    // Fall back to custom editor's active document
    return provider.getActiveDocument()?.uri;
  };

  const backlinkProvider = new BacklinkTreeProvider(fileIndexService, getActiveFileUri);
  context.subscriptions.push(
    vscode.window.createTreeView('vscodeMdEditor.backlinks', {
      treeDataProvider: backlinkProvider,
      showCollapseAll: true,
    })
  );

  // Refresh backlinks when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => backlinkProvider.refresh())
  );
  context.subscriptions.push(
    provider.onDidChangeActiveDocument(() => backlinkProvider.refresh())
  );

  // 8. Register the graph visualizer
  const graphDataService = new GraphDataService(fileIndexService);

  const getActiveFilePath = (): string | undefined => {
    const uri = getActiveFileUri();
    if (!uri) {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    let relativePath = uri.fsPath.slice(folder.uri.fsPath.length);
    relativePath = relativePath.replace(/\\/g, '/').replace(/^\//, '');
    return relativePath;
  };

  const graphViewProvider = new GraphViewProvider(
    context,
    fileIndexService,
    graphDataService,
    getActiveFilePath,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GraphViewProvider.viewType,
      graphViewProvider,
    )
  );

  // Refresh graph when active file changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => graphViewProvider.notifyActiveFileChanged())
  );
  context.subscriptions.push(
    provider.onDidChangeActiveDocument(() => graphViewProvider.notifyActiveFileChanged())
  );

  // Graph commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.showGraph', () => {
      vscode.commands.executeCommand('vscodeMdEditor.graph.focus');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.toggleGraphMode', () => {
      graphViewProvider.toggleMode();
    })
  );

  // 9. Register rename propagation
  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles((event) => {
      event.waitUntil(handleWillRenameFiles(event, fileIndexService));
    })
  );

  // 9. Run an initial check on any already-open markdown documents
  if (languageToolService.isEnabled()) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'markdown') {
        diagnosticsProvider.runCheck(doc);
      }
    }
  }
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions
}
