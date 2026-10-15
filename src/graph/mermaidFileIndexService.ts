import * as vscode from 'vscode';
import { getFileStem, isMermaidFile } from '../utils.js';
import { getExcludePatterns, affectsExcludeSettings } from '../fileExclusions.js';
import { matchesAnyGlob, buildFindFilesExclude } from '../globMatch.js';
import { getWorkspacePath } from '../workspacePaths.js';

/** Metadata for a single .mmd/.mermaid file in the index. */
export interface MermaidFileEntry {
  /** Workspace-relative path, e.g., "diagrams/flow.mmd" */
  relativePath: string;
  /** Absolute URI */
  uri: vscode.Uri;
  /** Filename without extension */
  stem: string;
  /** Full folder path (all segments before the filename) */
  folder: string;
}

/**
 * Lightweight sibling to FileIndexService for Mermaid diagram files. Unlike
 * the markdown index, there's no wikilink/backlink graph to maintain here —
 * this only needs to know which .mmd/.mermaid files exist, so it just tracks
 * filenames rather than reading and parsing file content.
 */
export class MermaidFileIndexService implements vscode.Disposable {
  private files: Map<string, MermaidFileEntry> = new Map();

  private _onDidUpdateIndex = new vscode.EventEmitter<void>();
  public readonly onDidUpdateIndex = this._onDidUpdateIndex.event;

  private disposables: vscode.Disposable[] = [];
  /** Exclude globs, re-read whenever the relevant settings change. */
  private excludePatterns: string[] = [];

  constructor() {
    this.disposables.push(this._onDidUpdateIndex);
  }

  /** Full workspace scan. Call once on activation. */
  public async initialize(): Promise<void> {
    this.excludePatterns = getExcludePatterns();

    // Register watchers BEFORE the initial scan so files created while
    // scanning aren't missed — re-adding a file is idempotent.
    this.registerWatchers();

    await this.scan();

    this._onDidUpdateIndex.fire();
  }

  /** Walk the workspace and add every diagram file that isn't excluded. */
  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.{mmd,mermaid}',
      buildFindFilesExclude(this.excludePatterns),
    );
    for (const uri of uris) {
      this.addFile(uri);
    }
  }

  /**
   * Re-read the exclude settings and rebuild the index from scratch. Public
   * so the sidebar's Refresh button can force a rescan — file watchers can
   * legitimately miss things (a path under `files.watcherExclude`, a network
   * or remote filesystem, a watcher-limit exhaustion on very large trees),
   * and a rescan is the guaranteed way back to an accurate list.
   */
  public async refresh(): Promise<void> {
    this.excludePatterns = getExcludePatterns();
    this.files.clear();
    await this.scan();
    this._onDidUpdateIndex.fire();
  }

  private registerWatchers(): void {
    // Workspace folders added or removed: keys gain or lose their folder-name
    // prefix, and an added folder's files fire no create events.
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refresh().catch(err => {
          console.warn('[MermaidFileIndex] Failed to rebuild after workspace folder change:', err);
        });
      })
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsExcludeSettings(e)) {
          this.refresh().catch(err => {
            console.warn('[MermaidFileIndex] Failed to rebuild after exclude change:', err);
          });
        }
      })
    );

    // Disk-level watcher. The workspace.onDidCreateFiles/onDidDeleteFiles
    // events below only fire for operations VS Code itself performs (the
    // Explorer, or a WorkspaceEdit) — a diagram written by a terminal
    // command, a git checkout, or any other program never reaches them, so
    // it stayed missing from the list until the window was reloaded.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{mmd,mermaid}');
    this.disposables.push(watcher);

    this.disposables.push(
      watcher.onDidCreate(uri => {
        const relativePath = this.getRelativePath(uri);
        // Already indexed means the user-gesture event below got there
        // first — firing again would re-render the sidebar for nothing.
        if (!relativePath || this.files.has(relativePath)) {
          return;
        }
        this.addFile(uri);
        // addFile skips excluded paths, so only announce a real addition.
        if (this.files.has(relativePath)) {
          this._onDidUpdateIndex.fire();
        }
      })
    );

    this.disposables.push(
      watcher.onDidDelete(uri => {
        const relativePath = this.getRelativePath(uri);
        if (!relativePath || !this.files.has(relativePath)) {
          return;
        }
        this.files.delete(relativePath);
        this._onDidUpdateIndex.fire();
      })
    );

    this.disposables.push(
      vscode.workspace.onDidCreateFiles(e => {
        let changed = false;
        for (const uri of e.files) {
          if (isMermaidFile(uri.fsPath)) {
            this.addFile(uri);
            changed = true;
          }
        }
        if (changed) {
          this._onDidUpdateIndex.fire();
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidDeleteFiles(e => {
        let changed = false;
        for (const uri of e.files) {
          if (isMermaidFile(uri.fsPath)) {
            this.removeFile(uri);
            changed = true;
          }
        }
        if (changed) {
          this._onDidUpdateIndex.fire();
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidRenameFiles(e => {
        let changed = false;
        for (const { oldUri, newUri } of e.files) {
          if (isMermaidFile(oldUri.fsPath)) {
            this.removeFile(oldUri);
            changed = true;
          }
          if (isMermaidFile(newUri.fsPath)) {
            this.addFile(newUri);
            changed = true;
          }
        }
        if (changed) {
          this._onDidUpdateIndex.fire();
        }
      })
    );
  }

  private addFile(uri: vscode.Uri): void {
    const workspacePath = getWorkspacePath(uri);
    if (!workspacePath) {
      return;
    }
    const relativePath = workspacePath.indexPath;
    // Single choke point for the scan and every watcher — see the matching
    // guard in FileIndexService.indexFile for why it belongs here.
    if (matchesAnyGlob(workspacePath.folderRelativePath, this.excludePatterns)) {
      return;
    }
    const stem = getFileStem(relativePath);
    const folder = this.getFolder(relativePath);
    this.files.set(relativePath, { relativePath, uri, stem, folder });
  }

  private removeFile(uri: vscode.Uri): void {
    const relativePath = this.getRelativePath(uri);
    if (relativePath) {
      this.files.delete(relativePath);
    }
  }

  /** Get all indexed files. */
  public getAllFiles(): MermaidFileEntry[] {
    return Array.from(this.files.values());
  }

  /** Get a file entry by its relative path. */
  public getFileEntry(relativePath: string): MermaidFileEntry | undefined {
    return this.files.get(relativePath);
  }

  /** The file's index key — see workspacePaths.getWorkspacePath. */
  private getRelativePath(uri: vscode.Uri): string | undefined {
    return getWorkspacePath(uri)?.indexPath;
  }

  /**
   * Full folder path (all segments before the filename), not just the
   * immediate parent — see FileIndexService.getFolder for why: otherwise
   * two files with the same name and immediate parent folder in different
   * parent projects are indistinguishable in the flat sidebar list.
   */
  private getFolder(relativePath: string): string {
    const parts = relativePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
