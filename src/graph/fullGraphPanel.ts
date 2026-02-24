import * as vscode from 'vscode';
import { FileIndexService } from '../wikilink/fileIndexService.js';
import { GraphDataService } from './graphDataService.js';
import { FullGraphToExtensionMessage, GraphFilters } from '../types.js';
import { getNonce } from '../utils.js';

export class FullGraphPanel {
  public static readonly viewType = 'vscodeMdEditor.fullGraph';

  private static instance: FullGraphPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private currentFilters: GraphFilters;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly fileIndexService: FileIndexService,
    private readonly graphDataService: GraphDataService,
    private readonly getActiveFilePath: () => string | undefined,
  ) {
    this.panel = panel;
    this.currentFilters = {
      mode: 'global',
      localDepth: 2,
      showOrphans: true,
      folderFilter: [],
      tagFilter: [],
      searchQuery: '',
    };

    // Register message handler BEFORE setting HTML to avoid race condition
    // where webview sends 'ready' before listener is registered
    this.panel.webview.onDidReceiveMessage(
      (msg: FullGraphToExtensionMessage) => {
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
      undefined,
      this.disposables,
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    // Fallback: send data after a short delay in case 'ready' was missed
    setTimeout(() => this.sendGraphData(), 1000);

    // Refresh when the index updates
    this.disposables.push(
      this.fileIndexService.onDidUpdateIndex(() => {
        this.sendGraphData();
      }),
    );

    this.panel.onDidDispose(
      () => {
        FullGraphPanel.instance = undefined;
        for (const d of this.disposables) {
          d.dispose();
        }
      },
      null,
      this.disposables,
    );
  }

  /** Create or reveal the full graph panel. */
  public static createOrShow(
    context: vscode.ExtensionContext,
    fileIndexService: FileIndexService,
    graphDataService: GraphDataService,
    getActiveFilePath: () => string | undefined,
  ): void {
    if (FullGraphPanel.instance) {
      FullGraphPanel.instance.panel.reveal(vscode.ViewColumn.One);
      FullGraphPanel.instance.sendGraphData();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      FullGraphPanel.viewType,
      'Link Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
        ],
      },
    );

    FullGraphPanel.instance = new FullGraphPanel(
      panel,
      context,
      fileIndexService,
      graphDataService,
      getActiveFilePath,
    );
  }

  /** Notify the full graph of an active file change. */
  public static notifyActiveFileChanged(activePath: string | undefined): void {
    if (FullGraphPanel.instance) {
      FullGraphPanel.instance.panel.webview.postMessage({
        type: 'activeFileChanged',
        nodeId: activePath ?? null,
      });
    }
  }

  private async sendGraphData(): Promise<void> {
    try {
      let data = this.graphDataService.getGlobalGraph();
      data = this.graphDataService.applyFilters(data, this.currentFilters);

      const activePath = this.getActiveFilePath();
      if (activePath) {
        for (const node of data.nodes) {
          if (node.id === activePath) {
            node.isActive = true;
          }
        }
      }

      console.log(`[FullGraph] Sending ${data.nodes.length} nodes, ${data.edges.length} edges`);

      const delivered = await this.panel.webview.postMessage({
        type: 'graphData',
        nodes: data.nodes,
        edges: data.edges,
      });

      console.log(`[FullGraph] Message delivered: ${delivered}`);

      // If message wasn't delivered, retry after a delay
      if (!delivered) {
        console.log('[FullGraph] Message not delivered, retrying in 500ms...');
        setTimeout(() => this.sendGraphData(), 500);
      }
    } catch (err) {
      console.error('[FullGraph] Error in sendGraphData:', err);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fullGraph.css'),
    );
    const forceGraphUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'force-graph.min.js'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fullGraph.js'),
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
  <link href="${styleUri}?v=${cacheBust}" rel="stylesheet">
  <title>Link Graph</title>
</head>
<body>
  <div id="controls-panel">
    <div class="controls-header" id="toggle-controls">Controls</div>
    <div class="controls-body" id="controls-body">
      <div class="control-section">
        <div class="section-title">Filters</div>
        <input type="text" id="search-input" placeholder="Search nodes..." />
        <label><input type="checkbox" id="show-orphans" checked /> Show orphans</label>
      </div>
      <div class="control-section">
        <div class="section-title">Display</div>
        <label>Labels: <select id="label-mode">
          <option value="auto">Auto</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select></label>
        <label><input type="checkbox" id="show-arrows" /> Show arrows</label>
      </div>
      <div class="control-section">
        <div class="section-title">Forces</div>
        <label>Repulsion: <input type="range" id="charge-slider" min="-1000" max="-50" value="-300" /></label>
        <label>Distance: <input type="range" id="distance-slider" min="30" max="300" value="100" /></label>
        <label><input type="checkbox" id="center-force" checked /> Center force</label>
      </div>
    </div>
  </div>
  <div id="graph-container"></div>
  <div id="node-tooltip" class="hidden"></div>
  <div id="zoom-controls">
    <button id="btn-fit" title="Fit to view">Fit</button>
    <button id="btn-zoom-in" title="Zoom in">+</button>
    <button id="btn-zoom-out" title="Zoom out">&minus;</button>
  </div>
  <script nonce="${nonce}" src="${forceGraphUri}?v=${cacheBust}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
