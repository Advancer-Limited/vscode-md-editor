import * as vscode from 'vscode';
import { FileIndexService } from '../wikilink/fileIndexService.js';
import { GraphDataService } from './graphDataService.js';
import { GraphToExtensionMessage, GraphFilters } from '../types.js';
import { getNonce } from '../utils.js';

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vscodeMdEditor.graph';

  private view?: vscode.WebviewView;
  private currentFilters: GraphFilters;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileIndexService: FileIndexService,
    private readonly graphDataService: GraphDataService,
    private readonly getActiveFilePath: () => string | undefined,
  ) {
    const config = vscode.workspace.getConfiguration('vscodeMdEditor.graph');
    this.currentFilters = {
      mode: config.get<'local' | 'global'>('defaultMode', 'local'),
      localDepth: config.get<number>('localDepth', 1),
      showOrphans: true,
      folderFilter: [],
      tagFilter: [],
      searchQuery: '',
    };
  }

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
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    const messageDisposable = webviewView.webview.onDidReceiveMessage(
      (msg: GraphToExtensionMessage) => {
        switch (msg.type) {
          case 'ready':
            this.sendGraphData();
            break;
          case 'openFile': {
            const entry = this.fileIndexService.getFileEntry(msg.relativePath);
            if (entry) {
              vscode.commands.executeCommand('vscode.open', entry.uri);
            }
            break;
          }
          case 'filterChanged':
            this.currentFilters = msg.filters;
            this.sendGraphData();
            break;
          case 'requestRefresh':
            this.sendGraphData();
            break;
        }
      },
    );

    // Refresh when the index updates
    const indexDisposable = this.fileIndexService.onDidUpdateIndex(() => {
      this.sendGraphData();
    });

    webviewView.onDidDispose(() => {
      messageDisposable.dispose();
      indexDisposable.dispose();
    });
  }

  /** Refresh the graph when the active file changes. */
  public notifyActiveFileChanged(): void {
    this.sendGraphData();
  }

  public sendGraphData(): void {
    if (!this.view) {
      return;
    }

    const activePath = this.getActiveFilePath();
    let data;

    if (this.currentFilters.mode === 'local' && activePath) {
      data = this.graphDataService.getLocalGraph(
        activePath,
        this.currentFilters.localDepth,
      );
    } else {
      data = this.graphDataService.getGlobalGraph();
    }

    data = this.graphDataService.applyFilters(data, this.currentFilters);

    // Mark active node
    if (activePath) {
      for (const node of data.nodes) {
        if (node.id === activePath) {
          node.isActive = true;
        }
      }
    }

    this.view.webview.postMessage({
      type: 'graphData',
      nodes: data.nodes,
      edges: data.edges,
    });
  }

  /** Toggle between local and global mode. */
  public toggleMode(): void {
    this.currentFilters.mode =
      this.currentFilters.mode === 'local' ? 'global' : 'local';
    this.sendGraphData();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.css'),
    );
    const forceGraphUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'force-graph.min.js'),
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
             script-src 'nonce-${nonce}' 'unsafe-eval';
             font-src ${webview.cspSource};
             img-src ${webview.cspSource} https: data:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Link Graph</title>
</head>
<body>
  <div id="controls">
    <div class="control-row">
      <button id="btn-mode" title="Toggle Local/Global">Local</button>
      <label>Depth: <input type="range" id="depth-slider" min="1" max="3" value="1" /></label>
      <label><input type="checkbox" id="show-orphans" checked /> Orphans</label>
    </div>
    <div class="control-row">
      <input type="text" id="search-input" placeholder="Search nodes..." />
    </div>
  </div>
  <div id="graph-container"></div>
  <script nonce="${nonce}" src="${forceGraphUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
