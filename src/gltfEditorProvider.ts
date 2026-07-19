import * as vscode from 'vscode';
import { getNonce, computeMinimalEdit, getBrandButtonHtml } from './utils.js';
import { GltfWebviewToExtensionMessage } from './types.js';
import { showAboutDialog } from './about.js';

/**
 * CustomTextEditorProvider for glTF 3D scene files (*.gltf — the JSON text
 * variant only; *.glb is binary and out of scope, see the spec).
 *
 * Always opens as a forced split view: raw JSON source in a textarea on the
 * left, a live debounced three.js render on the right. Self-contained — does
 * not touch the markdown or mermaid editors, but mirrors mermaidEditorProvider.ts's
 * document-sync architecture verbatim (that design is hard-won; see the
 * comments on `applyingEdits`/`lastAppliedText` below).
 */
export class GltfEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'vscodeMdEditor.gltf';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // A .gltf references .bin/texture files by relative URI. The workspace
    // folder is included (not just the document's own directory) so a
    // reference that climbs out of the document's folder (e.g.
    // ../textures/x.png) still resolves; fall back to the document's
    // directory for a file opened outside any workspace.
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        wsFolder ? wsFolder.uri : docDir,
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

    // Suppress echoing our own edits back to the webview.
    // Two-layer guard: applyingEdits (a depth counter, not a boolean) stays
    // raised while ANY applyEdit is in flight — so overlapping edits from fast
    // typing don't clear the guard early; lastAppliedText catches a change
    // event that arrives after the last await resolves.
    // (Copied verbatim from mermaidEditorProvider.ts — see its comments for
    // the full rationale.)
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
      async (message: GltfWebviewToExtensionMessage) => {
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

          case 'showAbout':
            await showAboutDialog(this.context);
            return;
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

  private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = getNonce();
    const cacheBust = Date.now();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gltfEditor.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gltfEditor.js')
    );
    const threeBundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'three-bundle.js')
    );
    const mathUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gltfViewerMath.js')
    );

    // GLTFLoader.parse()'s `path` argument is what every relative `uri` in
    // the glTF resolves against (via LoaderUtils.resolveURL, which passes
    // data:/blob:/absolute URLs through untouched). The webview cannot call
    // asWebviewUri itself, so the host computes it once here — it's static
    // per document, so no round-trip message is needed.
    const resourceBase =
      webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..')).toString() + '/';

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
             img-src ${webview.cspSource} blob: data:;
             connect-src ${webview.cspSource} data: blob:;">
  <link href="${styleUri}?v=${cacheBust}" rel="stylesheet">
  <title>glTF 3D Editor</title>
</head>
<body>
  <div class="gltf-container" id="gltf-container">
    <div class="gltf-editor-pane" id="gltf-editor-pane">
      <div class="gltf-editor-stack" id="gltf-editor-stack">
        <textarea id="gltf-input"
                  spellcheck="false"
                  placeholder="Enter glTF JSON source..."
        ></textarea>
      </div>
    </div>
    <div class="gltf-divider" id="gltf-divider"></div>
    <div class="gltf-preview-pane" id="gltf-preview-pane">
      <div class="gltf-toolbar" id="gltf-toolbar">
        <button id="gltf-fit" title="Fit model to view">Fit</button>
        <button id="gltf-reset" title="Reset camera">Reset</button>
        <span class="gltf-toolbar-separator"></span>
        <button id="gltf-wireframe" title="Toggle wireframe" aria-pressed="false">Wireframe</button>
        <button id="gltf-grid" title="Toggle grid" aria-pressed="false">Grid</button>
        <span class="gltf-toolbar-separator"></span>
        <button id="gltf-update" title="Force a re-render">Update</button>
        <span class="gltf-toolbar-spacer"></span>
        ${getBrandButtonHtml()}
      </div>
      <div class="gltf-viewport" id="gltf-viewport">
        <div class="gltf-container-3d" id="gltf-container-3d" data-resource-base="${resourceBase}"></div>
        <div id="gltf-note" class="gltf-note" hidden></div>
      </div>
      <div id="gltf-error" class="gltf-error" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${threeBundleUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${mathUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
