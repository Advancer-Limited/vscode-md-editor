import * as vscode from 'vscode';
import { FileIndexService } from '../wikilink/fileIndexService.js';
import { MermaidFileIndexService } from './mermaidFileIndexService.js';
import { GraphDataService } from './graphDataService.js';
import { getNonce, isMarkdownFile, isMermaidFile } from '../utils.js';

type FileKind = 'markdown' | 'mermaid';

interface SidebarMessage {
  type: 'ready' | 'openFile' | 'openMermaidFile' | 'openFullGraph' | 'searchChanged'
    | 'mermaidSearchChanged' | 'createFile' | 'revealInExplorer';
  relativePath?: string;
  query?: string;
  folderPath?: string;
  kind?: FileKind;
}

interface SidebarFileNode {
  relativePath: string;
  label: string;
  folder: string;
  links: Array<{ relativePath: string; label: string; direction: 'in' | 'out' }>;
  isActive: boolean;
}

interface MermaidSidebarNode {
  relativePath: string;
  label: string;
  folder: string;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vscodeMdEditor.graph';

  private view?: vscode.WebviewView;
  private searchQuery = '';
  private mermaidSearchQuery = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileIndexService: FileIndexService,
    private readonly mermaidFileIndexService: MermaidFileIndexService,
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
            this.sendMermaidFileList();
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
          case 'openMermaidFile': {
            if (msg.relativePath) {
              const entry = this.mermaidFileIndexService.getFileEntry(msg.relativePath);
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
          case 'mermaidSearchChanged':
            this.mermaidSearchQuery = msg.query || '';
            this.sendMermaidFileList();
            break;
          case 'createFile':
            if (msg.kind) {
              this.handleCreateFile(msg.folderPath || '', msg.kind).catch(err => {
                vscode.window.showErrorMessage(
                  `Failed to create file: ${err instanceof Error ? err.message : String(err)}`
                );
              });
            }
            break;
          case 'revealInExplorer':
            this.handleRevealInExplorer(msg.folderPath || '');
            break;
        }
      },
    );

    const indexDisposable = this.fileIndexService.onDidUpdateIndex(() => {
      this.sendFileList();
    });

    const mermaidIndexDisposable = this.mermaidFileIndexService.onDidUpdateIndex(() => {
      this.sendMermaidFileList();
    });

    webviewView.onDidDispose(() => {
      messageDisposable.dispose();
      indexDisposable.dispose();
      mermaidIndexDisposable.dispose();
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

  /**
   * Create a new file of `kind` inside the folder at `folderPath` (workspace
   * relative, '' for the workspace root), prompting for its name via a
   * native input box — webviews can't use window.prompt() (blocked, no
   * allow-modals in VS Code's sandboxed webviews, same restriction that
   * blocks confirm()/print()).
   */
  private async handleCreateFile(folderPath: string, kind: FileKind): Promise<void> {
    const ext = kind === 'markdown' ? '.md' : '.mmd';
    const label = kind === 'markdown' ? 'Markdown file' : 'Mermaid diagram';

    const name = await vscode.window.showInputBox({
      prompt: `New ${label} name (in ${folderPath || 'workspace root'})`,
      placeHolder: kind === 'markdown' ? 'notes' : 'flow',
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Enter a file name.';
        }
        if (/[\\/:*?"<>|]/.test(value)) {
          return 'File name contains invalid characters.';
        }
        return null;
      },
    });
    if (!name) {
      return; // cancelled
    }

    let fileName = name.trim();
    const hasValidExt = kind === 'markdown' ? isMarkdownFile(fileName) : isMermaidFile(fileName);
    if (!hasValidExt) {
      fileName += ext;
    }

    const folderUri = this.resolveWorkspaceFolderUri(folderPath);
    if (!folderUri) {
      vscode.window.showErrorMessage('Could not resolve the target folder.');
      return;
    }

    const fileUri = vscode.Uri.joinPath(folderUri, fileName);

    const alreadyExists = await vscode.workspace.fs.stat(fileUri).then(() => true, () => false);
    if (alreadyExists) {
      vscode.window.showErrorMessage(`"${fileName}" already exists in that folder.`);
      return;
    }

    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
    await vscode.commands.executeCommand('vscode.open', fileUri);
  }

  private handleRevealInExplorer(folderPath: string): void {
    const folderUri = this.resolveWorkspaceFolderUri(folderPath);
    if (folderUri) {
      vscode.commands.executeCommand('revealInExplorer', folderUri);
    }
  }

  /** Resolve a workspace-relative folder path ('' for the root) to a URI. */
  private resolveWorkspaceFolderUri(folderPath: string): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    return folderPath ? vscode.Uri.joinPath(root.uri, folderPath) : root.uri;
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

  private sendMermaidFileList(): void {
    if (!this.view) {
      return;
    }

    const allFiles = this.mermaidFileIndexService.getAllFiles();
    const nodes: MermaidSidebarNode[] = [];

    for (const file of allFiles) {
      if (this.mermaidSearchQuery) {
        const q = this.mermaidSearchQuery.toLowerCase();
        if (!file.stem.toLowerCase().includes(q) && !file.folder.toLowerCase().includes(q)) {
          continue;
        }
      }
      nodes.push({
        relativePath: file.relativePath,
        label: file.stem,
        folder: file.folder,
      });
    }

    nodes.sort((a, b) => a.label.localeCompare(b.label));

    this.view.webview.postMessage({
      type: 'mermaidFileList',
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
  <div id="tab-bar" role="tablist">
    <button class="tab-btn active" data-tab="links" role="tab" aria-selected="true">Markdown Links</button>
    <button class="tab-btn" data-tab="mermaid" role="tab" aria-selected="false">Mermaid</button>
  </div>

  <div id="tab-panel-links" class="tab-panel active" data-panel="links">
    <div id="controls">
      <div class="control-row">
        <input type="text" id="search-input" placeholder="Search files..." />
        <button id="btn-toggle-links-view" class="icon-btn" title="Show folder structure" aria-label="Show folder structure"></button>
        <button id="btn-show-graph" title="Open interactive graph">Show Graph</button>
      </div>
    </div>
    <div id="file-list"></div>
  </div>

  <div id="tab-panel-mermaid" class="tab-panel" data-panel="mermaid">
    <div id="mermaid-controls">
      <div class="control-row">
        <input type="text" id="mermaid-search-input" placeholder="Search diagrams..." />
        <button id="btn-toggle-mermaid-view" class="icon-btn" title="Show folder structure" aria-label="Show folder structure"></button>
      </div>
    </div>
    <div id="mermaid-file-list"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
  }
}
