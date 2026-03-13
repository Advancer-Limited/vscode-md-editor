import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider.js';
import { LanguageToolService } from './languageToolService.js';
import { LanguageToolDiagnosticsProvider } from './diagnosticsProvider.js';
import { LanguageToolCodeActionProvider } from './codeActionsProvider.js';
import { FileIndexService } from './wikilink/fileIndexService.js';
import { handleWillRenameFiles } from './wikilink/renamePropagation.js';
import { GraphDataService } from './graph/graphDataService.js';
import { GraphViewProvider } from './graph/graphViewProvider.js';
import { FullGraphPanel } from './graph/fullGraphPanel.js';
import { DiffService } from './diff/diffService.js';
import { MarkdownDiffPanel } from './diff/markdownDiffPanel.js';

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

  // 3. Create the LanguageTool service
  const languageToolService = new LanguageToolService();

  // 4. Create the diagnostic collection
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('languagetool');
  context.subscriptions.push(diagnosticCollection);

  // 5. Create the diagnostics provider
  const diagnosticsProvider = new LanguageToolDiagnosticsProvider(
    languageToolService,
    diagnosticCollection
  );
  context.subscriptions.push(diagnosticsProvider);

  // Wire cursor offset for incremental grammar checking
  diagnosticsProvider.setCursorOffsetProvider((uri) => provider.getCursorOffset(uri));

  // Forward grammar results to the custom editor webview
  context.subscriptions.push(
    diagnosticsProvider.onGrammarResults(({ uri, matches }) => {
      provider.sendGrammarResults(uri, matches);
    })
  );

  // 6. Register the code action provider for quick fixes
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'markdown', scheme: 'file' },
      new LanguageToolCodeActionProvider(),
      {
        providedCodeActionKinds: LanguageToolCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // 7. Register commands

  // "Check Grammar" command
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.checkGrammar', async () => {
      const textEditor = vscode.window.activeTextEditor;
      let doc: vscode.TextDocument | undefined;
      if (textEditor && textEditor.document.languageId === 'markdown') {
        doc = textEditor.document;
      } else {
        doc = provider.getActiveDocument();
      }

      if (!doc) {
        vscode.window.showWarningMessage('No markdown document is active.');
        return;
      }

      if (!languageToolService.isEnabled()) {
        vscode.window.showWarningMessage(
          'LanguageTool is disabled. Enable it in Settings: vscodeMdEditor.languageTool.enabled'
        );
        return;
      }

      const count = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking grammar...' },
        async () => {
          return await diagnosticsProvider.runCheck(doc);
        }
      );

      if (count > 0) {
        vscode.window.showInformationMessage(`Grammar check: ${count} issue${count !== 1 ? 's' : ''} found.`);
      } else {
        vscode.window.showInformationMessage('Grammar check: No issues found.');
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

  // 8. Helper: get active file URI/path
  const getActiveFileUri = (): vscode.Uri | undefined => {
    const textEditor = vscode.window.activeTextEditor;
    if (textEditor && textEditor.document.uri.fsPath.endsWith('.md')) {
      return textEditor.document.uri;
    }
    return provider.getActiveDocument()?.uri;
  };

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

  // 9. Register the graph sidebar panel
  const graphDataService = new GraphDataService(fileIndexService);

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
    vscode.window.onDidChangeActiveTextEditor(() => {
      graphViewProvider.notifyActiveFileChanged();
      FullGraphPanel.notifyActiveFileChanged(getActiveFilePath());
    })
  );
  context.subscriptions.push(
    provider.onDidChangeActiveDocument(() => {
      graphViewProvider.notifyActiveFileChanged();
      FullGraphPanel.notifyActiveFileChanged(getActiveFilePath());
    })
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

  // "Open Full Graph" command
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.openFullGraph', () => {
      FullGraphPanel.createOrShow(
        context,
        fileIndexService,
        graphDataService,
        getActiveFilePath,
      );
    })
  );

  // 10. Register rename propagation
  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles((event) => {
      event.waitUntil(handleWillRenameFiles(event, fileIndexService));
    })
  );

  // 11. Register diff support
  const diffService = new DiffService();

  interface DiffContext {
    fileUri: vscode.Uri;
    repoRoot: string;
    relativePath: string;
    filename: string;
    currentContent: string;
  }

  // Resolve and validate all common diff prerequisites in one place.
  const resolveDiffContext = async (uri?: vscode.Uri): Promise<DiffContext | undefined> => {
    const fileUri = uri || getActiveFileUri();
    if (!fileUri) {
      vscode.window.showWarningMessage('No markdown file is active.');
      return undefined;
    }

    const repoRoot = await diffService.getRepoRoot(fileUri);
    if (!repoRoot) {
      vscode.window.showWarningMessage('This file is not in a git repository.');
      return undefined;
    }

    const relativePath = diffService.getRelativePath(repoRoot, fileUri);
    const filename = fileUri.fsPath.split(/[\\/]/).pop() || 'file.md';

    // Read current content from the open document if available, otherwise from disk
    const openDoc = vscode.workspace.textDocuments.find(
      d => d.uri.toString() === fileUri.toString()
    );
    let currentContent: string;
    if (openDoc) {
      currentContent = openDoc.getText();
    } else {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      currentContent = Buffer.from(bytes).toString('utf-8');
    }

    return { fileUri, repoRoot, relativePath, filename, currentContent };
  };

  // "Compare with Previous Version" — diff current file against the previous commit.
  // If uncommitted changes exist (current differs from HEAD), compare with HEAD.
  // Otherwise compare with the commit before HEAD to always show a meaningful diff.
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.diffWithPrevious', async (uri?: vscode.Uri) => {
      try {
        const ctx = await resolveDiffContext(uri);
        if (!ctx) return;

        const history = await diffService.getFileHistory(ctx.repoRoot, ctx.relativePath, 2);
        if (history.length === 0) {
          vscode.window.showInformationMessage('No git history found for this file.');
          return;
        }

        // Check if current content differs from the latest commit
        const headContent = await diffService.getFileContentAtCommit(ctx.repoRoot, ctx.relativePath, history[0].hash);
        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
        const hasUncommittedChanges = normalize(headContent) !== normalize(ctx.currentContent);

        let commit: typeof history[0];
        let oldContent: string;

        if (hasUncommittedChanges) {
          // Show uncommitted changes vs HEAD
          commit = history[0];
          oldContent = headContent;
        } else if (history.length >= 2) {
          // No uncommitted changes — show what the last commit changed
          commit = history[1];
          oldContent = await diffService.getFileContentAtCommit(ctx.repoRoot, ctx.relativePath, history[1].hash);
        } else {
          vscode.window.showInformationMessage('No previous version to compare with.');
          return;
        }

        MarkdownDiffPanel.show(context, oldContent, ctx.currentContent, `${ctx.filename} (${commit.shortHash}) ↔ Current`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to compare: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // "Compare with Commit..." — QuickPick to select a commit, then diff
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.diffWithCommit', async (uri?: vscode.Uri) => {
      try {
        const ctx = await resolveDiffContext(uri);
        if (!ctx) return;

        const history = await diffService.getFileHistory(ctx.repoRoot, ctx.relativePath, 20);
        if (history.length === 0) {
          vscode.window.showInformationMessage('No git history found for this file.');
          return;
        }

        const items = history.map(c => ({
          label: `$(git-commit) ${c.shortHash}`,
          description: c.message,
          detail: `${c.authorName} — ${new Date(c.date).toLocaleDateString()}`,
          commit: c,
        }));

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a commit to compare with',
        });
        if (!picked) return;

        const oldContent = await diffService.getFileContentAtCommit(ctx.repoRoot, ctx.relativePath, picked.commit.hash);
        MarkdownDiffPanel.show(context, oldContent, ctx.currentContent, `${ctx.filename} (${picked.commit.shortHash}) ↔ Current`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to compare: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // "Compare with Saved" — diff HEAD version against current working content
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeMdEditor.diffWithSaved', async () => {
      try {
        const ctx = await resolveDiffContext();
        if (!ctx) return;

        const oldContent = await diffService.getFileContentAtCommit(ctx.repoRoot, ctx.relativePath, 'HEAD');
        MarkdownDiffPanel.show(context, oldContent, ctx.currentContent, `${ctx.filename} (HEAD) ↔ Working`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to compare: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // 12. Run an initial check on any already-open markdown documents
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
