import * as vscode from 'vscode';
import * as path from 'path';
import { getFileStem, isMermaidFile } from '../utils.js';

/** Metadata for a single .mmd/.mermaid file in the index. */
export interface MermaidFileEntry {
  /** Workspace-relative path, e.g., "diagrams/flow.mmd" */
  relativePath: string;
  /** Absolute URI */
  uri: vscode.Uri;
  /** Filename without extension */
  stem: string;
  /** Immediate parent folder name */
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

  constructor() {
    this.disposables.push(this._onDidUpdateIndex);
  }

  /** Full workspace scan. Call once on activation. */
  public async initialize(): Promise<void> {
    // Register watchers BEFORE the initial scan so files created while
    // scanning aren't missed — re-adding a file is idempotent.
    this.registerWatchers();

    const uris = await vscode.workspace.findFiles('**/*.{mmd,mermaid}', '**/node_modules/**');
    for (const uri of uris) {
      this.addFile(uri);
    }

    this._onDidUpdateIndex.fire();
  }

  private registerWatchers(): void {
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
   * URI isn't inside any open workspace folder. Uses path.relative() rather
   * than a manual startsWith()/slice() — see FileIndexService.getRelativePath
   * for why a plain string comparison is unsafe (case mismatch between
   * URIs from different VS Code APIs, even on Windows).
   */
  private getRelativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
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
