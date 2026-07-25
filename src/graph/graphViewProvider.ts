import * as vscode from 'vscode';
import * as path from 'path';
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
    // Overrides the package.json-contributed "Markdown Links: Graph" — set
    // at runtime rather than fought over in package.json, since this is a
    // documented, writable property specifically meant for this.
    webviewView.title = 'MD & MMD Editor';

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
            // A fresh 'ready' means the webview's DOM (and its search boxes)
            // just loaded from scratch — e.g. the view was hidden and is
            // being re-resolved. Reset any stale query from before, or the
            // now-empty search box would silently keep filtering by it.
            this.searchQuery = '';
            this.mermaidSearchQuery = '';
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
            if (msg.kind) {
              this.handleRevealInExplorer(msg.folderPath || '', msg.kind);
            }
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

    const folderUri = this.resolveWorkspaceFolderUri(folderPath, kind);
    if (!folderUri) {
      vscode.window.showErrorMessage('Could not resolve the target folder.');
      return;
    }

    const fileUri = vscode.Uri.joinPath(folderUri, fileName);

    // Create atomically via a WorkspaceEdit rather than stat-then-write:
    // ignoreIfExists/overwrite both false means applyEdit fails outright if
    // something else created the file in between, instead of a separate
    // existence check racing the write and silently truncating it.
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(fileUri, { overwrite: false, ignoreIfExists: false });
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(`"${fileName}" already exists in that folder.`);
      return;
    }

    await vscode.commands.executeCommand('vscode.open', fileUri);
  }

  private handleRevealInExplorer(folderPath: string, kind: FileKind): void {
    const folderUri = this.resolveWorkspaceFolderUri(folderPath, kind);
    if (folderUri) {
      vscode.commands.executeCommand('revealInExplorer', folderUri);
    }
  }

  /**
   * Resolve a workspace-relative folder path ('' for the root) to a URI.
   *
   * A bare `folderPath` string doesn't say which workspace folder it belongs
   * to in a multi-root workspace — `relativePath` is computed per-file
   * against that file's OWN root (see FileIndexService/MermaidFileIndexService
   * getRelativePath), so two roots can produce identical-looking relative
   * paths. Resolve the root from an actual indexed file under this folder
   * instead of always assuming workspaceFolders[0].
   */
  private resolveWorkspaceFolderUri(folderPath: string, kind: FileKind): vscode.Uri | undefined {
    const files = kind === 'markdown'
      ? this.fileIndexService.getAllFiles()
      : this.mermaidFileIndexService.getAllFiles();
    const prefix = folderPath ? folderPath + '/' : '';
    const match = files.find(f => f.relativePath.startsWith(prefix));

    const root = match
      ? vscode.workspace.getWorkspaceFolder(match.uri)
      : vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }

    const folderUri = folderPath ? vscode.Uri.joinPath(root.uri, folderPath) : root.uri;

    // Defense in depth: joinPath normalizes '..' segments, so a crafted
    // folderPath could otherwise resolve outside the workspace root.
    const normalizedRoot = root.uri.fsPath.replace(/[\\/]+$/, '');
    if (folderUri.fsPath !== normalizedRoot && !folderUri.fsPath.startsWith(normalizedRoot + path.sep)) {
      return undefined;
    }

    return folderUri;
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

      nodes.push({
        relativePath: file.relativePath,
        label: file.stem,
        folder: file.folder,
        isActive: file.relativePath === activePath,
      });
    }

    // Plain alphabetical order — the same files as folder view, flattened.
    // The active file keeps its highlight but is not hoisted to the top.
    nodes.sort((a, b) => a.label.localeCompare(b.label));

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
    <button class="tab-btn active" data-tab="links" role="tab" aria-selected="true">
      <svg class="tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
           stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M4 2 H9 L12 5 V14 H4 Z"/><path d="M9 2 V5 H12"/>
        <line x1="6" y1="8.2" x2="10.5" y2="8.2"/><line x1="6" y1="10.6" x2="10.5" y2="10.6"/>
      </svg>
      <span class="tab-label">Markdown</span>
    </button>
    <button class="tab-btn" data-tab="mermaid" role="tab" aria-selected="false">
      <svg class="tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
           stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <rect x="2" y="2.5" width="5.5" height="3.6" rx="0.6"/><rect x="8.5" y="10" width="5.5" height="3.6" rx="0.6"/>
        <path d="M4.75 6.1 V9 H11.25 V10"/>
      </svg>
      <span class="tab-label">Mermaid</span>
    </button>
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
