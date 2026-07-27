import * as vscode from 'vscode';
import { parseWikilinks, resolveWikilinkTarget, parseTags, WikilinkOccurrence } from './wikilinkParser.js';
import { getFileStem, isMarkdownFile } from '../utils.js';
import { getExcludePatterns, affectsExcludeSettings } from '../fileExclusions.js';
import { matchesAnyGlob, buildFindFilesExclude } from '../globMatch.js';

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
  /** Full folder path (all segments before the filename); used for graph coloring, search matching, and (via the full-graph panel) folder filters */
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
  /** Per-document debounce timers, keyed by URI string. A single shared timer
   * would drop a pending update for file A when file B is edited within the
   * debounce window. */
  private updateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Exclude globs, re-read whenever the relevant settings change. */
  private excludePatterns: string[] = [];

  constructor() {
    this.disposables.push(this._onDidUpdateIndex);
  }

  /** Full workspace scan. Call once on activation. */
  public async initialize(): Promise<void> {
    this.excludePatterns = getExcludePatterns();

    // Register watchers BEFORE the (potentially slow) initial scan so files
    // created/saved/renamed while scanning are not missed. Re-indexing a file
    // is idempotent, so any overlap with the scan is harmless.
    this.registerWatchers();

    await this.scan();

    this._onDidUpdateIndex.fire();
  }

  /** Walk the workspace and index every markdown file that isn't excluded. */
  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.{md,markdown}',
      buildFindFilesExclude(this.excludePatterns),
    );

    // Process in batches to avoid overwhelming the file system
    const batchSize = 50;
    for (let i = 0; i < uris.length; i += batchSize) {
      const batch = uris.slice(i, i + batchSize);
      await Promise.all(batch.map(uri => this.indexFile(uri)));
    }
  }

  /**
   * Re-read the exclude settings and rebuild the index from scratch. A full
   * rebuild rather than an incremental pass because a relaxed pattern can add
   * files just as easily as a tightened one removes them.
   *
   * Public so the sidebar's Refresh button can force a rescan — file watchers
   * can legitimately miss things (a path under `files.watcherExclude`, a
   * network or remote filesystem, watcher-limit exhaustion on a very large
   * tree), and a rescan is the guaranteed way back to an accurate list.
   */
  public async refresh(): Promise<void> {
    this.excludePatterns = getExcludePatterns();
    this.fileIndex.clear();
    this.backlinkIndex.clear();
    this.stemToPath.clear();
    await this.scan();
    this._onDidUpdateIndex.fire();
  }

  private registerWatchers(): void {
    // Incremental update on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'markdown' || isMarkdownFile(doc.uri.fsPath)) {
          this.indexFile(doc.uri, doc.getText()).then(() => {
            this._onDidUpdateIndex.fire();
          });
        }
      })
    );

    // File creation
    this.disposables.push(
      vscode.workspace.onDidCreateFiles(e => {
        const mdFiles = e.files.filter(f => isMarkdownFile(f.fsPath));
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
          if (isMarkdownFile(uri.fsPath)) {
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
          if (isMarkdownFile(oldUri.fsPath) || isMarkdownFile(newUri.fsPath)) {
            this.removeFromIndex(oldUri);
            if (isMarkdownFile(newUri.fsPath)) {
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

    // Exclude settings changed — rebuild against the new patterns
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsExcludeSettings(e)) {
          this.refresh().catch(err => {
            console.warn('[FileIndex] Failed to rebuild after exclude change:', err);
          });
        }
      })
    );

    // Disk-level watcher. The onDidCreateFiles/onDidDeleteFiles events above
    // only fire for operations VS Code itself performs (the Explorer, or a
    // WorkspaceEdit) — a file written by a terminal command, a git checkout,
    // or any other program never reaches them, so a newly added document
    // stayed missing from the sidebar until the window was reloaded.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,markdown}');
    this.disposables.push(watcher);

    this.disposables.push(
      watcher.onDidCreate(uri => {
        const relativePath = this.getRelativePath(uri);
        // Already indexed means the user-gesture event above got there
        // first — firing again would re-render the sidebar for nothing.
        if (!relativePath || this.fileIndex.has(relativePath)) {
          return;
        }
        this.indexFile(uri).then(() => {
          // indexFile skips excluded paths, so only announce a real addition.
          if (this.fileIndex.has(relativePath)) {
            this._onDidUpdateIndex.fire();
          }
        }).catch(err => {
          console.warn(`[FileIndex] Failed to index new file ${relativePath}:`, err);
        });
      })
    );

    this.disposables.push(
      watcher.onDidDelete(uri => {
        const relativePath = this.getRelativePath(uri);
        if (!relativePath || !this.fileIndex.has(relativePath)) {
          return;
        }
        this.removeFromIndex(uri);
        this._onDidUpdateIndex.fire();
      })
    );

    // Debounced update on text change (for live backlink updates before save)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'markdown' || isMarkdownFile(e.document.uri.fsPath)) {
          if (e.contentChanges.length === 0) {
            return;
          }
          const key = e.document.uri.toString();
          const existing = this.updateTimers.get(key);
          if (existing) {
            clearTimeout(existing);
          }
          this.updateTimers.set(
            key,
            setTimeout(() => {
              this.updateTimers.delete(key);
              this.indexFile(e.document.uri, e.document.getText()).then(() => {
                this._onDidUpdateIndex.fire();
              });
            }, 500),
          );
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

    // The single choke point every path into the index funnels through —
    // the initial scan and all four watchers — so the exclude check lives
    // here rather than being repeated (and eventually missed) at each one.
    // findFiles already applies the excludes during the scan; watchers get
    // no exclude handling at all, which is what this actually guards.
    if (matchesAnyGlob(relativePath, this.excludePatterns)) {
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
      // Only drop the stem->path mapping if it still points at THIS file —
      // another file sharing the same stem may currently own the mapping.
      const stemKey = entry.stem.toLowerCase();
      if (this.stemToPath.get(stemKey) === relativePath) {
        this.stemToPath.delete(stemKey);
      }
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

  /**
   * Workspace-relative path (forward-slash separated), or undefined if the
   * URI isn't inside any open workspace folder.
   *
   * Slices by folder.uri.fsPath's character length rather than a manual
   * startsWith()/slice() with an equality check, or path.relative() — both
   * of those re-derive containment via their own string comparison, which
   * has to reimplement VS Code's platform-specific case sensitivity rules
   * (case-insensitive path matching on Windows AND macOS, case-sensitive on
   * Linux) to avoid rejecting a real match. getWorkspaceFolder() above has
   * ALREADY determined uri belongs under folder using those exact rules —
   * a case difference never changes string length, so slicing by length
   * trusts that determination instead of redundantly (and inconsistently)
   * re-checking it. The original bug was exactly a startsWith() mismatch —
   * on a document opened via a differently-cased path — silently returning
   * the full absolute path AS the "relative" path, indexed as a second,
   * bogus entry for an already-indexed file.
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
   * immediate parent — two files with the same name and immediate parent
   * (e.g. "serviceA/docs/00-overview.md" and "serviceB/docs/00-overview.md"
   * both have an immediate parent of "docs") are otherwise indistinguishable
   * in the flat sidebar list, which only shows label + folder.
   */
  private getFolder(relativePath: string): string {
    const parts = relativePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }

  public dispose(): void {
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
