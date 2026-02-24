import * as vscode from 'vscode';
import { FileIndexService } from '../wikilink/fileIndexService.js';
import { GraphDataService } from './graphDataService.js';
import { getNonce } from '../utils.js';

interface SidebarMessage {
  type: 'ready' | 'openFile' | 'openFullGraph' | 'searchChanged';
  relativePath?: string;
  query?: string;
}

interface SidebarFileNode {
  relativePath: string;
  label: string;
  folder: string;
  links: Array<{ relativePath: string; label: string; direction: 'in' | 'out' }>;
  isActive: boolean;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vscodeMdEditor.graph';

  private view?: vscode.WebviewView;
  private searchQuery = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileIndexService: FileIndexService,
    private readonly graphDataService: GraphDataService,
    private readonly getActiveFilePath: () => string | undefined,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    const messageDisposable = webviewView.webview.onDidReceiveMessage(
      (msg: SidebarMessage) => {
        switch (msg.type) {
          case 'ready':
            this.sendFileList();
            break;
          case 'openFile': {
            if (msg.relativePath) {
              const entry = this.fileIndexService.getFileEntry(msg.relativePath);
              if (entry) {
                vscode.commands.executeCommand('vscode.open', entry.uri);
              }
            }
            break;
          }
          case 'openFullGraph':
            vscode.commands.executeCommand('vscodeMdEditor.openFullGraph');
            break;
          case 'searchChanged':
            this.searchQuery = msg.query || '';
            this.sendFileList();
            break;
        }
      },
    );

    const indexDisposable = this.fileIndexService.onDidUpdateIndex(() => {
      this.sendFileList();
    });

    webviewView.onDidDispose(() => {
      messageDisposable.dispose();
      indexDisposable.dispose();
    });
  }

  public notifyActiveFileChanged(): void {
    this.sendFileList();
  }

  /** Toggle is no longer needed but kept for command compatibility. */
  public toggleMode(): void {
    // No-op — sidebar is now a flat list
  }

  public sendGraphData(): void {
    this.sendFileList();
  }

  private sendFileList(): void {
    if (!this.view) {
      return;
    }

    const activePath = this.getActiveFilePath();
    const allFiles = this.fileIndexService.getAllFiles();
    const nodes: SidebarFileNode[] = [];

    for (const file of allFiles) {
      // Search filter
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        if (!file.stem.toLowerCase().includes(q) && !file.folder.toLowerCase().includes(q)) {
          continue;
        }
      }

      const links: SidebarFileNode['links'] = [];

      // Outgoing links
      for (const link of file.outgoingLinks) {
        const resolved = this.fileIndexService.resolveWikilink(link.target);
        if (resolved) {
          const target = this.fileIndexService.getFileEntry(resolved);
          if (target) {
            links.push({
              relativePath: resolved,
              label: target.stem,
              direction: 'out',
            });
          }
        }
      }

      // Incoming links (backlinks)
      const backlinks = this.fileIndexService.getBacklinksFor(file.stem);
      for (const bl of backlinks) {
        // Avoid duplicates (if A links to B and B links to A)
        if (!links.some(l => l.relativePath === bl.relativePath)) {
          links.push({
            relativePath: bl.relativePath,
            label: bl.stem,
            direction: 'in',
          });
        }
      }

      nodes.push({
        relativePath: file.relativePath,
        label: file.stem,
        folder: file.folder,
        links,
        isActive: file.relativePath === activePath,
      });
    }

    // Sort: active file first, then alphabetically
    nodes.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return a.label.localeCompare(b.label);
    });

    this.view.webview.postMessage({
      type: 'fileList',
      nodes,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.js'),
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
             font-src ${webview.cspSource};">
  <link href="${styleUri}?v=${cacheBust}" rel="stylesheet">
  <title>Link Graph</title>
</head>
<body>
  <div id="controls">
    <div class="control-row">
      <input type="text" id="search-input" placeholder="Search files..." />
      <button id="btn-show-graph" title="Open interactive graph">Show Graph</button>
    </div>
  </div>
  <div id="file-list"></div>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
