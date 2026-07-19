import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce, computeMinimalEdit, getBrandButtonHtml } from './utils.js';
import { MermaidWebviewToExtensionMessage } from './types.js';
import { showAboutDialog } from './about.js';

/** Escape text for safe interpolation into HTML text content. */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** How long a generated print page is kept before being swept. */
const PRINT_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete previously generated print pages that are older than the TTL.
 *
 * They can't be removed immediately after opening — the browser loads them
 * asynchronously — so they're swept on the next print instead. Without this
 * they accumulate indefinitely, each holding a full copy of a diagram.
 */
async function sweepOldPrintFiles(dir: vscode.Uri): Promise<void> {
  try {
    const cutoff = Date.now() - PRINT_FILE_TTL_MS;
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const match = /^mmd-print-(\d+)\.html$/.exec(name);
      if (!match || Number(match[1]) >= cutoff) continue;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
      } catch {
        // A file we can't delete shouldn't block printing.
      }
    }
  } catch {
    // Sweeping is best-effort housekeeping — never fail a print over it.
  }
}

/**
 * Build a standalone page containing just the diagram, for printing in an
 * external browser. Carries its own strict CSP (no script-src at all) as
 * defence in depth — nothing executable should reach the user's real browser
 * even if mermaid's sanitization were ever bypassed.
 */
function buildPrintHtml(title: string, svg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; display: flex; justify-content: center; align-items: flex-start; padding: 16px; }
  svg { max-width: 100%; height: auto; }
  @media print {
    @page { margin: 12mm; }
    body { padding: 0; }
    svg { max-width: 100%; max-height: 100vh; page-break-inside: avoid; }
  }
</style>
</head>
<body>${svg}</body>
</html>`;
}

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

          // The cases below are pure side-channels: they never touch
          // applyingEdits/lastAppliedText or call updateWebview(), so they
          // cannot interfere with document sync.

          case 'requestPngExport': {
            const choice = await vscode.window.showQuickPick(
              [
                {
                  label: 'Light background',
                  description: 'White background, dark text — best for documents and slides',
                  theme: 'light' as const,
                },
                {
                  label: 'Dark background',
                  description: 'Matches a dark editor theme',
                  theme: 'dark' as const,
                },
              ],
              { title: 'Export diagram as PNG', placeHolder: 'Choose the image background' }
            );
            if (!choice) {
              return; // user cancelled
            }
            webviewPanel.webview.postMessage({ type: 'exportPngTheme', theme: choice.theme });
            return;
          }

          case 'exportPng': {
            if (typeof message.base64 !== 'string' || message.base64.length === 0) {
              vscode.window.showErrorMessage('Diagram export failed: no image data was produced.');
              return;
            }
            const base = path
              .basename(document.fileName)
              .replace(/\.(mmd|mermaid)$/i, '');
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(document.uri, '..', `${base}.png`),
              filters: { 'PNG Image': ['png'] },
            });
            if (!target) {
              return; // user cancelled
            }
            try {
              const bytes = Buffer.from(message.base64, 'base64');
              if (bytes.length === 0) {
                throw new Error('decoded image was empty');
              }
              await vscode.workspace.fs.writeFile(target, bytes);
              vscode.window.showInformationMessage(
                `Exported ${path.basename(target.fsPath)}`
              );
            } catch (err) {
              vscode.window.showErrorMessage(
                `Failed to save the diagram: ${err instanceof Error ? err.message : String(err)}`
              );
            }
            return;
          }

          case 'exportError':
            vscode.window.showErrorMessage(`Diagram export failed: ${message.message}`);
            return;

          case 'showAbout':
            await showAboutDialog(this.context);
            return;

          case 'print': {
            // window.print() is suppressed inside VS Code's sandboxed webview
            // iframes (no allow-modals), and fails silently. Write a
            // standalone page and hand it to the real browser, where Print —
            // and its "Save as PDF" destination — works properly.
            try {
              const dir = this.context.globalStorageUri;
              await vscode.workspace.fs.createDirectory(dir);
              await sweepOldPrintFiles(dir);
              const file = vscode.Uri.joinPath(dir, `mmd-print-${Date.now()}.html`);
              await vscode.workspace.fs.writeFile(
                file,
                Buffer.from(buildPrintHtml(path.basename(document.fileName), message.svg), 'utf8')
              );
              await vscode.env.openExternal(file);
            } catch (err) {
              vscode.window.showErrorMessage(
                `Failed to open the diagram for printing: ${err instanceof Error ? err.message : String(err)}`
              );
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
    const syntaxUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mermaidSyntax.js')
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
      <div class="mmd-editor-stack" id="mmd-editor-stack">
        <pre class="mmd-highlight" id="mmd-highlight" aria-hidden="true"><code id="mmd-highlight-code"></code></pre>
        <textarea id="mmd-input"
                  spellcheck="false"
                  placeholder="Enter Mermaid diagram source..."
        ></textarea>
      </div>
    </div>
    <div class="mmd-divider" id="mmd-divider"></div>
    <div class="mmd-preview-pane" id="mmd-preview-pane">
      <div class="mmd-toolbar" id="mmd-toolbar">
        <button id="mmd-zoom-out" title="Zoom out">&minus;</button>
        <span id="mmd-zoom-readout" class="mmd-zoom-readout" title="Click to reset zoom">100%</span>
        <button id="mmd-zoom-in" title="Zoom in">+</button>
        <button id="mmd-zoom-reset" title="Reset zoom to 100%">1:1</button>
        <button id="mmd-zoom-fit" title="Fit diagram to view">Fit</button>
        <span class="mmd-toolbar-separator"></span>
        <button id="mmd-export-png" title="Export diagram as a PNG image">PNG</button>
        <button id="mmd-print" title="Open in browser to print or save as PDF">Print</button>
        <span class="mmd-toolbar-spacer"></span>
        ${getBrandButtonHtml()}
      </div>
      <div class="mmd-viewport" id="mmd-viewport">
        <div id="mmd-preview" class="mmd-canvas"></div>
      </div>
      <div id="mmd-error" class="mmd-error" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mermaidUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${syntaxUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
