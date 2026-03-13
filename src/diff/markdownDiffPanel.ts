import * as vscode from 'vscode';
import { getNonce } from '../utils.js';
import { computeLineDiff, DiffHunk } from './diffAlgorithm.js';

/**
 * Opens a webview panel showing a rendered markdown diff.
 * Old and new content are diffed at the line level, each hunk is rendered
 * through markdown-it in the webview, and additions/deletions are highlighted.
 */
export class MarkdownDiffPanel {
  public static show(
    context: vscode.ExtensionContext,
    oldContent: string,
    newContent: string,
    title: string,
  ): void {
    const hunks = computeLineDiff(oldContent, newContent);

    const panel = vscode.window.createWebviewPanel(
      'markdownDiff',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    );

    panel.webview.html = buildHtml(panel.webview, context, hunks, title);
  }
}

function buildHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  hunks: DiffHunk[],
  title: string,
): string {
  const nonce = getNonce();
  const cacheBust = Date.now();

  const markdownItUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'markdown-it.min.js')
  );
  const diffStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'diff.css')
  );
  const diffScriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'diff.js')
  );

  const hunksJson = JSON.stringify(hunks)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const titleEscaped = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
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
  <link href="${diffStyleUri}?v=${cacheBust}" rel="stylesheet">
  <title>Markdown Diff</title>
</head>
<body>
  <div id="diff-header"><h2>${titleEscaped}</h2></div>
  <div id="diff-legend">
    <span class="legend-added">+ Added</span>
    <span class="legend-removed">− Removed</span>
    <span class="legend-unchanged">Unchanged</span>
  </div>
  <div id="diff-content"></div>
  <input type="hidden" id="diff-data" value="${hunksJson}">
  <script nonce="${nonce}" src="${markdownItUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${diffScriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
}
