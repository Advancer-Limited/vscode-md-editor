import * as vscode from 'vscode';
import { getFileStem, isMermaidFile } from '../utils.js';
import { getExcludePatterns, affectsExcludeSettings } from '../fileExclusions.js';
import { matchesAnyGlob, buildFindFilesExclude } from '../globMatch.js';

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

  /** Re-read the exclude settings and rebuild the index from scratch. */
  private async refreshExclusions(): Promise<void> {
    this.excludePatterns = getExcludePatterns();
    this.files.clear();
    await this.scan();
    this._onDidUpdateIndex.fire();
  }

  private registerWatchers(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsExcludeSettings(e)) {
          this.refreshExclusions().catch(err => {
            console.warn('[MermaidFileIndex] Failed to rebuild after exclude change:', err);
          });
        }
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
    const relativePath = this.getRelativePath(uri);
    if (!relativePath) {
      return;
    }
    // Single choke point for the scan and every watcher — see the matching
    // guard in FileIndexService.indexFile for why it belongs here.
    if (matchesAnyGlob(relativePath, this.excludePatterns)) {
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

  /**
   * Workspace-relative path (forward-slash separated), or undefined if the
   * URI isn't inside any open workspace folder. Slices by folder.uri.fsPath's
   * character length rather than a manual startsWith()/slice()-with-check
   * or path.relative() — see FileIndexService.getRelativePath for why: both
   * of those re-derive containment via a string comparison that has to
   * reimplement VS Code's own platform-specific case sensitivity rules,
   * where getWorkspaceFolder() above has already made that determination.
   */
  private getRelativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const relative = uri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]/, '');
    if (!relative) {
      return undefined;
    }
    return relative.replace(/\\/g, '/');
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
