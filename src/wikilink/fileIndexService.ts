import * as vscode from 'vscode';
import { parseWikilinks, resolveWikilinkTarget, parseTags, WikilinkOccurrence } from './wikilinkParser.js';
import { getFileStem } from '../utils.js';

/** Metadata for a single .md file in the index. */
export interface FileEntry {
  /** Workspace-relative path, e.g., "notes/my-file.md" */
  relativePath: string;
  /** Absolute URI */
  uri: vscode.Uri;
  /** Filename without extension */
  stem: string;
  /** Outgoing wikilinks parsed from this file */
  outgoingLinks: WikilinkOccurrence[];
  /** Tags extracted from frontmatter or inline #tags */
  tags: string[];
  /** Parent folder name (for graph coloring) */
  folder: string;
  /** Raw text content (cached for unlinked mentions) */
  content: string;
}

export type FileIndex = Map<string, FileEntry>;
export type BacklinkIndex = Map<string, Set<string>>;

export class FileIndexService implements vscode.Disposable {
  private fileIndex: FileIndex = new Map();
  private backlinkIndex: BacklinkIndex = new Map();
  /** Lowercase stem -> relativePath for wikilink resolution */
  private stemToPath: Map<string, string> = new Map();

  private _onDidUpdateIndex = new vscode.EventEmitter<void>();
  public readonly onDidUpdateIndex = this._onDidUpdateIndex.event;

  private disposables: vscode.Disposable[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.disposables.push(this._onDidUpdateIndex);
  }

  /** Full workspace scan. Call once on activation. */
  public async initialize(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');

    // Process in batches to avoid overwhelming the file system
    const batchSize = 50;
    for (let i = 0; i < uris.length; i += batchSize) {
      const batch = uris.slice(i, i + batchSize);
      await Promise.all(batch.map(uri => this.indexFile(uri)));
    }

    this.registerWatchers();
    this._onDidUpdateIndex.fire();
  }

  private registerWatchers(): void {
    // Incremental update on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'markdown' || doc.uri.fsPath.endsWith('.md')) {
          this.indexFile(doc.uri, doc.getText()).then(() => {
            this._onDidUpdateIndex.fire();
          });
        }
      })
    );

    // File creation
    this.disposables.push(
      vscode.workspace.onDidCreateFiles(e => {
        const mdFiles = e.files.filter(f => f.fsPath.endsWith('.md'));
        if (mdFiles.length > 0) {
          Promise.all(mdFiles.map(uri => this.indexFile(uri))).then(() => {
            this._onDidUpdateIndex.fire();
          });
        }
      })
    );

    // File deletion
    this.disposables.push(
      vscode.workspace.onDidDeleteFiles(e => {
        let changed = false;
        for (const uri of e.files) {
          if (uri.fsPath.endsWith('.md')) {
            this.removeFromIndex(uri);
            changed = true;
          }
        }
        if (changed) {
          this._onDidUpdateIndex.fire();
        }
      })
    );

    // File rename
    this.disposables.push(
      vscode.workspace.onDidRenameFiles(e => {
        const indexPromises: Promise<void>[] = [];
        for (const { oldUri, newUri } of e.files) {
          if (oldUri.fsPath.endsWith('.md') || newUri.fsPath.endsWith('.md')) {
            this.removeFromIndex(oldUri);
            if (newUri.fsPath.endsWith('.md')) {
              indexPromises.push(this.indexFile(newUri));
            }
          }
        }
        if (indexPromises.length > 0) {
          Promise.all(indexPromises).then(() => {
            this._onDidUpdateIndex.fire();
          });
        }
      })
    );

    // Debounced update on text change (for live backlink updates before save)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'markdown' || e.document.uri.fsPath.endsWith('.md')) {
          if (e.contentChanges.length === 0) {
            return;
          }
          if (this.updateTimer) {
            clearTimeout(this.updateTimer);
          }
          this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            this.indexFile(e.document.uri, e.document.getText()).then(() => {
              this._onDidUpdateIndex.fire();
            });
          }, 500);
        }
      })
    );
  }

  /** Index a single file. Optionally pass content to avoid re-reading. */
  private async indexFile(uri: vscode.Uri, content?: string): Promise<void> {
    const relativePath = this.getRelativePath(uri);
    if (!relativePath) {
      return;
    }

    if (content === undefined) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(bytes).toString('utf-8');
      } catch (err) {
        console.warn(`[FileIndex] Failed to read ${uri.fsPath}:`, err);
        return;
      }
    }

    // Remove old backlink entries for this file
    const oldEntry = this.fileIndex.get(relativePath);
    if (oldEntry) {
      this.removeBacklinks(relativePath, oldEntry.outgoingLinks);
    }

    const stem = getFileStem(relativePath);
    const folder = this.getFolder(relativePath);
    const outgoingLinks = parseWikilinks(content);
    const tags = parseTags(content);

    const entry: FileEntry = {
      relativePath,
      uri,
      stem,
      outgoingLinks,
      tags,
      folder,
      content,
    };

    this.fileIndex.set(relativePath, entry);
    this.stemToPath.set(stem.toLowerCase(), relativePath);

    // Add new backlink entries
    for (const link of outgoingLinks) {
      const targetStem = link.target.toLowerCase();
      if (!this.backlinkIndex.has(targetStem)) {
        this.backlinkIndex.set(targetStem, new Set());
      }
      this.backlinkIndex.get(targetStem)!.add(relativePath);
    }
  }

  /** Remove a file from the index. */
  private removeFromIndex(uri: vscode.Uri): void {
    const relativePath = this.getRelativePath(uri);
    if (!relativePath) {
      return;
    }

    const entry = this.fileIndex.get(relativePath);
    if (entry) {
      this.removeBacklinks(relativePath, entry.outgoingLinks);
      this.stemToPath.delete(entry.stem.toLowerCase());
      this.fileIndex.delete(relativePath);
    }
  }

  /** Remove backlink entries for a file's outgoing links. */
  private removeBacklinks(sourcePath: string, links: WikilinkOccurrence[]): void {
    for (const link of links) {
      const targetStem = link.target.toLowerCase();
      const backlinks = this.backlinkIndex.get(targetStem);
      if (backlinks) {
        backlinks.delete(sourcePath);
        if (backlinks.size === 0) {
          this.backlinkIndex.delete(targetStem);
        }
      }
    }
  }

  // ========================================
  // Query methods
  // ========================================

  /** Get all indexed files. */
  public getAllFiles(): FileEntry[] {
    return Array.from(this.fileIndex.values());
  }

  /** Get a file entry by its relative path. */
  public getFileEntry(relativePath: string): FileEntry | undefined {
    return this.fileIndex.get(relativePath);
  }

  /** Get all files that link TO a given stem. */
  public getBacklinksFor(stem: string): FileEntry[] {
    const backlinks = this.backlinkIndex.get(stem.toLowerCase());
    if (!backlinks) {
      return [];
    }
    const results: FileEntry[] = [];
    for (const path of backlinks) {
      const entry = this.fileIndex.get(path);
      if (entry) {
        results.push(entry);
      }
    }
    return results;
  }

  /** Get files that mention a stem as plain text but NOT inside [[]]. */
  public getUnlinkedMentions(stem: string): Array<{ file: FileEntry; line: number; lineText: string }> {
    const results: Array<{ file: FileEntry; line: number; lineText: string }> = [];
    const lowerStem = stem.toLowerCase();
    const stemRegex = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');

    for (const entry of this.fileIndex.values()) {
      if (entry.stem.toLowerCase() === lowerStem) {
        continue; // Skip the file itself
      }

      const lines = entry.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!stemRegex.test(line)) {
          continue;
        }
        stemRegex.lastIndex = 0;

        // Check that the mention is not inside [[ ]]
        let match: RegExpExecArray | null;
        while ((match = stemRegex.exec(line)) !== null) {
          const before = line.slice(0, match.index);
          const after = line.slice(match.index + match[0].length);
          // Simple check: not preceded by [[ or followed by ]]
          if (!before.endsWith('[[') && !after.startsWith(']]')) {
            results.push({ file: entry, line: i, lineText: line });
            break; // One mention per line is enough
          }
        }
        stemRegex.lastIndex = 0;
      }
    }

    return results;
  }

  /** Resolve a wikilink target to a relativePath. */
  public resolveWikilink(target: string): string | undefined {
    return resolveWikilinkTarget(target, this.stemToPath);
  }

  /** Get all file stems for autocomplete. */
  public getAllStems(): string[] {
    return Array.from(this.fileIndex.values()).map(e => e.stem);
  }

  /** Get the stemToPath map (for external use). */
  public getStemToPathMap(): Map<string, string> {
    return this.stemToPath;
  }

  // ========================================
  // Helpers
  // ========================================

  private getRelativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const folderPath = folder.uri.fsPath;
    let filePath = uri.fsPath;
    if (filePath.startsWith(folderPath)) {
      filePath = filePath.slice(folderPath.length);
      // Normalize separators and remove leading separator
      filePath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    }
    return filePath;
  }

  private getFolder(relativePath: string): string {
    const parts = relativePath.split('/');
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }

  public dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
