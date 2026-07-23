import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce, computeMinimalEdit, getBrandButtonHtml, toolbarIcon, buildMarkdownPrintHtml } from './utils.js';
import { WebviewToExtensionMessage, GrammarMatch } from './types.js';
import { FileIndexService } from './wikilink/fileIndexService.js';
import { showAboutDialog } from './about.js';
import { sweepOldPrintFiles } from './printFiles.js';

const MD_PRINT_FILE_PATTERN = /^md-print-(\d+)\.html$/;

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

    // Suppress echoing our own edits back to the webview.
    // Two-layer guard: applyingEdits (a depth counter, not a boolean) stays
    // raised while ANY applyEdit is in flight — so overlapping edits from fast
    // typing don't clear the guard early; lastAppliedText catches a change
    // event that arrives after the last await resolves.
    let applyingEdits = 0;
    let lastAppliedText: string | null = null;

    const updateWebview = () => {
      if (applyingEdits > 0) {
        return;
      }
      const currentText = document.getText();
      if (lastAppliedText !== null && currentText === lastAppliedText) {
        lastAppliedText = null;
        return;
      }
      lastAppliedText = null;
      webviewPanel.webview.postMessage({
        type: 'update',
        text: currentText,
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
            if (message.cursorOffset !== undefined) {
              this.cursorOffsets.set(document.uri.toString(), message.cursorOffset);
            }
            const currentText = document.getText();
            // message.text always uses \n line endings (it comes from an HTML
            // textarea / Turndown output in the webview). On a CRLF document,
            // comparing/diffing against that raw text makes computeMinimalEdit
            // see the entire body as changed on every single keystroke — expand
            // it back to the document's actual EOL style first.
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const incomingText = eol === '\n' ? message.text : message.text.replace(/\r?\n/g, eol);
            if (currentText === incomingText) {
              webviewPanel.webview.postMessage({ type: 'editAck' });
              return;
            }
            applyingEdits++;
            lastAppliedText = incomingText;
            // Apply the smallest ranged edit rather than replacing the whole
            // document: this keeps undo granular and doesn't disturb cursor or
            // scroll state in a parallel raw text editor of the same document.
            const minimal = computeMinimalEdit(currentText, incomingText);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(
                document.positionAt(minimal.start),
                document.positionAt(minimal.end)
              ),
              minimal.text
            );
            let applied = false;
            try {
              applied = await vscode.workspace.applyEdit(edit);
            } finally {
              applyingEdits--;
            }
            // Ack before any corrective updateWebview() below, so the webview
            // doesn't mistake the correction for a stale/in-flight echo and
            // skip rendering it (see editsInFlight handling in editor.js).
            webviewPanel.webview.postMessage({ type: 'editAck' });
            if (!applied) {
              // The edit was rejected (e.g. a concurrent modification). The
              // webview now shows text that never reached the document — push
              // the real document state back so the two can't silently diverge.
              lastAppliedText = null;
              updateWebview();
            }
            return;
          }

          case 'requestGrammarCheck':
            vscode.commands.executeCommand('vscodeMdEditor.checkGrammar');
            return;

          case 'showAbout':
            await showAboutDialog(this.context);
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
            const startPos = document.positionAt(message.offset);
            const endPos = document.positionAt(message.offset + message.length);
            // Grammar match offsets were computed against the text at check
            // time. If the document has changed since (edits earlier in the
            // file shift offsets), applying blindly would replace the wrong
            // text — verify the range still contains what the check matched.
            if (
              message.expectedText !== undefined &&
              document.getText(new vscode.Range(startPos, endPos)) !== message.expectedText
            ) {
              vscode.window.showInformationMessage(
                'The text has changed since the grammar check — run the check again to apply fixes.'
              );
              return;
            }
            applyingEdits++;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(startPos, endPos), message.replacement);
            try {
              await vscode.workspace.applyEdit(edit);
            } finally {
              applyingEdits--;
            }
            // Intentionally push the corrected text back to the webview.
            updateWebview();
            return;
          }

          case 'print': {
            try {
              const dir = this.context.globalStorageUri;
              await vscode.workspace.fs.createDirectory(dir);
              await sweepOldPrintFiles(dir, MD_PRINT_FILE_PATTERN);
              const cssUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css');
              const cssBytes = await vscode.workspace.fs.readFile(cssUri);
              const css = Buffer.from(cssBytes).toString('utf8');
              const file = vscode.Uri.joinPath(dir, `md-print-${Date.now()}.html`);
              await vscode.workspace.fs.writeFile(
                file,
                Buffer.from(buildMarkdownPrintHtml(path.basename(document.fileName), message.html, css), 'utf8')
              );
              // globalStorageUri can be a vscode-userdata: URI rather than
              // file: (seen on Windows) — openExternal then hands that
              // scheme straight to the OS shell, which has no app
              // registered for it. Uri.file(fsPath) rebuilds a real file:
              // URI the shell/browser can open.
              await vscode.env.openExternal(vscode.Uri.file(file.fsPath));
            } catch (err) {
              vscode.window.showErrorMessage(
                `Failed to open the document for printing: ${err instanceof Error ? err.message : String(err)}`
              );
            }
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
      this.cursorOffsets.delete(document.uri.toString());
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
    const tableRulesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'turndownTableRules.js')
    );
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mermaid.min.js')
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
    <button id="btn-link" class="icon-btn" title="Insert Link" aria-label="Insert Link">${toolbarIcon('<path d="M6.5 9.5 L9.5 6.5"/><path d="M4.5 11.5 A3 3 0 0 1 4.5 7 L6.5 5"/><path d="M11.5 4.5 A3 3 0 0 1 11.5 9 L9.5 11"/>')}</button>
    <button id="btn-image" class="icon-btn" title="Insert Image" aria-label="Insert Image">${toolbarIcon('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><path d="M2 12.5 L6 8.5 L9 11 L11.5 8 L14.5 11.5"/>')}</button>
    <button id="btn-code" class="icon-btn" title="Inline Code" aria-label="Inline Code">${toolbarIcon('<path d="M6 4 L2 8 L6 12"/><path d="M10 4 L14 8 L10 12"/>')}</button>
    <button id="btn-codeblock" class="icon-btn" title="Code Block" aria-label="Code Block">${toolbarIcon('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M6.5 6 L4.5 8 L6.5 10"/><path d="M9.5 6 L11.5 8 L9.5 10"/>')}</button>
    <span class="toolbar-separator"></span>
    <button id="btn-ul" class="icon-btn" title="Unordered List" aria-label="Unordered List">${toolbarIcon('<circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none"/><line x1="5.5" y1="4" x2="14" y2="4"/><line x1="5.5" y1="8" x2="14" y2="8"/><line x1="5.5" y1="12" x2="14" y2="12"/>')}</button>
    <button id="btn-ol" class="icon-btn" title="Ordered List" aria-label="Ordered List">${toolbarIcon('<text x="0.5" y="5.3" font-size="4.2" fill="currentColor" stroke="none">1</text><text x="0.5" y="9.3" font-size="4.2" fill="currentColor" stroke="none">2</text><text x="0.5" y="13.3" font-size="4.2" fill="currentColor" stroke="none">3</text><line x1="5.5" y1="4" x2="14" y2="4"/><line x1="5.5" y1="8" x2="14" y2="8"/><line x1="5.5" y1="12" x2="14" y2="12"/>')}</button>
    <button id="btn-quote" class="icon-btn" title="Blockquote" aria-label="Blockquote">${toolbarIcon('<path d="M2 4.5 H4.5 V7.5 Q4.5 9.5 2 9.5"/><path d="M9 4.5 H11.5 V7.5 Q11.5 9.5 9 9.5"/>')}</button>
    <button id="btn-hr" class="icon-btn" title="Horizontal Rule" aria-label="Horizontal Rule">${toolbarIcon('<line x1="2" y1="8" x2="14" y2="8"/>')}</button>
    <span class="spacer"></span>
    <button id="btn-check-grammar" title="Check Grammar" class="grammar-btn">&#10003; Grammar</button>
    <span class="toolbar-separator"></span>
    <div class="view-toggle">
      <button id="btn-preview-only" class="active" title="Edit (WYSIWYG)">Edit</button>
      <button id="btn-split" title="Split View">Split</button>
      <button id="btn-editor-only" title="Raw Markdown">Raw</button>
    </div>
    <span class="toolbar-separator"></span>
    <button id="btn-print" class="icon-btn" title="Print or Save as PDF" aria-label="Print or Save as PDF">${toolbarIcon('<rect x="3" y="6" width="10" height="5" rx="0.5"/><path d="M4.5 6 V2.5 H11.5 V6"/><rect x="5" y="10.5" width="6" height="3.5"/>')}</button>
    <span class="toolbar-separator"></span>
    ${getBrandButtonHtml()}
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
  <script nonce="${nonce}" src="${tableRulesUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${mermaidUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
