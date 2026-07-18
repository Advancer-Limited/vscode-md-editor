import * as vscode from 'vscode';
import { getNonce, computeMinimalEdit } from './utils.js';
import { MermaidWebviewToExtensionMessage } from './types.js';

/**
 * CustomTextEditorProvider for Mermaid diagram source files (*.mmd, *.mermaid).
 *
 * Always opens as a forced split view: raw source in a textarea on the left,
 * a live debounced mermaid.js render on the right. Self-contained — does not
 * touch the markdown editor at all, though it mirrors its document-sync
 * architecture (see markdownEditorProvider.ts).
 */
export class MermaidEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'vscodeMdEditor.mermaid';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
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

    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (message: MermaidWebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready':
            updateWebview();
            return;

          case 'edit': {
            // The textarea in the webview always yields LF-normalized text.
            // document.getText() may be CRLF if the file uses CRLF line
            // endings — comparing/diffing against the raw message text would
            // then see almost the entire document as changed on every
            // keystroke. Re-expand line endings to match the document first.
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const incoming = eol === '\n' ? message.text : message.text.replace(/\r?\n/g, eol);

            const currentText = document.getText();
            if (currentText === incoming) {
              // Nothing to apply, but the webview is still waiting on an ack
              // for this edit — without it, the webview would treat this
              // edit as permanently "in flight" and refuse safe update skips.
              webviewPanel.webview.postMessage({ type: 'editAck' });
              return;
            }

            applyingEdits++;
            lastAppliedText = incoming;
            // Apply the smallest ranged edit rather than replacing the whole
            // document: keeps undo granular and doesn't disturb cursor/scroll
            // state in a parallel raw text editor of the same document.
            const minimal = computeMinimalEdit(currentText, incoming);
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
            // Ack before any corrective updateWebview() below — the ack tells
            // the webview "this specific edit has been fully processed", so
            // it must arrive before a correction that depends on that being
            // true (otherwise the webview could wrongly ignore the fix).
            webviewPanel.webview.postMessage({ type: 'editAck' });
            if (!applied) {
              // The edit was rejected (e.g. a concurrent modification). The
              // webview now shows text that never reached the document —
              // push the real document state back so the two can't silently
              // diverge.
              lastAppliedText = null;
              updateWebview();
            }
            return;
          }
        }
      }
    );

    // When the document changes externally, update the webview.
    const changeDocumentDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
        updateWebview();
      }
    });

    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      changeDocumentDisposable.dispose();
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mermaidEditor.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mermaidEditor.js')
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
  <title>Mermaid Diagram Editor</title>
</head>
<body>
  <div class="mmd-container" id="mmd-container">
    <div class="mmd-editor-pane" id="mmd-editor-pane">
      <textarea id="mmd-input"
                spellcheck="false"
                placeholder="Enter Mermaid diagram source..."
      ></textarea>
    </div>
    <div class="mmd-divider" id="mmd-divider"></div>
    <div class="mmd-preview-pane" id="mmd-preview-pane">
      <div id="mmd-preview"></div>
      <div id="mmd-error" class="mmd-error" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mermaidUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
