import * as vscode from 'vscode';
import { getNonce } from './utils.js';
import { WebviewToExtensionMessage, GrammarMatch } from './types.js';
import { FileIndexService } from './wikilink/fileIndexService.js';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'vscodeMdEditor.editor';

  /** Track the document for the currently active custom editor panel. */
  private activeDocument: vscode.TextDocument | undefined;

  /** Track webview panels by document URI for grammar result forwarding. */
  private webviewPanels = new Map<string, vscode.WebviewPanel>();

  /** Track cursor offset per document for incremental grammar checking. */
  private cursorOffsets = new Map<string, number>();

  private _onDidChangeActiveDocument = new vscode.EventEmitter<vscode.TextDocument | undefined>();
  public readonly onDidChangeActiveDocument = this._onDidChangeActiveDocument.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileIndexService: FileIndexService,
  ) {}

  /** Send grammar results to the webview for the given document URI. */
  public sendGrammarResults(uri: vscode.Uri, matches: GrammarMatch[]): void {
    const panel = this.webviewPanels.get(uri.toString());
    if (panel) {
      panel.webview.postMessage({ type: 'grammarResults', matches });
    }
  }

  public getActiveDocument(): vscode.TextDocument | undefined {
    return this.activeDocument;
  }

  /** Get the last known cursor offset for a document. */
  public getCursorOffset(uri: vscode.Uri): number | undefined {
    return this.cursorOffsets.get(uri.toString());
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.activeDocument = document;
    this._onDidChangeActiveDocument.fire(document);
    this.webviewPanels.set(document.uri.toString(), webviewPanel);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Track whether we're currently applying an edit from the webview
    // to prevent the change event from echoing it back.
    let isApplyingEdit = false;

    const updateWebview = () => {
      if (isApplyingEdit) {
        return;
      }
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
      });
    };

    // Handle messages from the webview
    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready':
            updateWebview();
            return;

          case 'edit': {
            isApplyingEdit = true;
            if (message.cursorOffset !== undefined) {
              this.cursorOffsets.set(document.uri.toString(), message.cursorOffset);
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              message.text
            );
            await vscode.workspace.applyEdit(edit);
            isApplyingEdit = false;
            return;
          }

          case 'requestGrammarCheck':
            vscode.commands.executeCommand('vscodeMdEditor.checkGrammar');
            return;

          case 'requestWikilinkSuggestions': {
            const prefix = message.prefix.toLowerCase();
            const allFiles = this.fileIndexService.getAllFiles();
            const suggestions = allFiles
              .filter(f => f.stem.toLowerCase().includes(prefix))
              .slice(0, 20)
              .map(f => ({
                stem: f.stem,
                relativePath: f.relativePath,
                folder: f.folder,
              }));
            webviewPanel.webview.postMessage({
              type: 'wikilinkSuggestions',
              suggestions,
            });
            return;
          }

          case 'openWikilink': {
            const resolved = this.fileIndexService.resolveWikilink(message.target);
            if (resolved) {
              const entry = this.fileIndexService.getFileEntry(resolved);
              if (entry) {
                vscode.commands.executeCommand('vscode.open', entry.uri);
              }
            }
            return;
          }

          case 'applyGrammarFix': {
            isApplyingEdit = true;
            const startPos = document.positionAt(message.offset);
            const endPos = document.positionAt(message.offset + message.length);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(startPos, endPos), message.replacement);
            await vscode.workspace.applyEdit(edit);
            isApplyingEdit = false;
            updateWebview();
            return;
          }
        }
      }
    );

    // When the document changes externally, update the webview
    const changeDocumentDisposable = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
          updateWebview();
        }
      }
    );

    // Track which custom editor is active
    const visibilityDisposable = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activeDocument = document;
        this._onDidChangeActiveDocument.fire(document);
      }
    });

    webviewPanel.onDidDispose(() => {
      this.webviewPanels.delete(document.uri.toString());
      if (this.activeDocument === document) {
        this.activeDocument = undefined;
        this._onDidChangeActiveDocument.fire(undefined);
      }
      messageDisposable.dispose();
      changeDocumentDisposable.dispose();
      visibilityDisposable.dispose();
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown-it.min.js')
    );
    const turndownUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'turndown.browser.umd.js')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             font-src ${webview.cspSource};
             img-src ${webview.cspSource} https: data:;">
  <link href="${styleUri}?v=${cacheBust}" rel="stylesheet">
  <title>Markdown Editor</title>
</head>
<body>
  <div class="toolbar">
    <button id="btn-bold" title="Bold (Ctrl+B)"><b>B</b></button>
    <button id="btn-italic" title="Italic (Ctrl+I)"><i>I</i></button>
    <button id="btn-strikethrough" title="Strikethrough"><s>S</s></button>
    <span class="toolbar-separator"></span>
    <button id="btn-h1" title="Heading 1">H1</button>
    <button id="btn-h2" title="Heading 2">H2</button>
    <button id="btn-h3" title="Heading 3">H3</button>
    <span class="toolbar-separator"></span>
    <button id="btn-link" title="Insert Link">Link</button>
    <button id="btn-image" title="Insert Image">Img</button>
    <button id="btn-code" title="Inline Code">Code</button>
    <button id="btn-codeblock" title="Code Block">Block</button>
    <span class="toolbar-separator"></span>
    <button id="btn-ul" title="Unordered List">&#8226; List</button>
    <button id="btn-ol" title="Ordered List">1. List</button>
    <button id="btn-quote" title="Blockquote">&gt; Quote</button>
    <button id="btn-hr" title="Horizontal Rule">&mdash;</button>
    <span class="spacer"></span>
    <button id="btn-check-grammar" title="Check Grammar" class="grammar-btn">&#10003; Grammar</button>
    <span class="toolbar-separator"></span>
    <div class="view-toggle">
      <button id="btn-preview-only" class="active" title="Edit (WYSIWYG)">Edit</button>
      <button id="btn-split" title="Split View">Split</button>
      <button id="btn-editor-only" title="Raw Markdown">Raw</button>
    </div>
  </div>
  <div class="editor-container preview-only" id="editor-container">
    <div class="editor-pane" id="editor-pane">
      <textarea id="markdown-input"
                spellcheck="false"
                placeholder="Start writing markdown..."
      ></textarea>
    </div>
    <div class="divider" id="divider"></div>
    <div class="preview-pane" id="preview-pane">
      <div id="preview-content" class="markdown-body" contenteditable="true" spellcheck="false"></div>
    </div>
  </div>
  <div class="status-bar" id="status-bar">
    <span id="status-line-info">Ln 1, Col 1</span>
    <span id="status-word-count">0 words</span>
  </div>
  <script nonce="${nonce}" src="${markdownItUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${turndownUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
