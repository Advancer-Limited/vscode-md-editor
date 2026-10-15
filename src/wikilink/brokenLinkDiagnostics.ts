import * as vscode from 'vscode';
import { FileIndexService } from './fileIndexService.js';
import { findMemoryRoot, hasNonMarkdownExtension } from './linkResolution.js';

export const BROKEN_LINK_SOURCE = 'wikilinks';

type Scope = 'memoryRepos' | 'all' | 'off';

/**
 * Reports `[[links]]` that resolve to no file as warnings in the Problems
 * panel. Off outside memory repos by default: in an Obsidian-style vault a
 * link to a note that doesn't exist yet is normal, but the Agent Memory Repo
 * spec expects every link to resolve.
 */
export class BrokenLinkDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(BROKEN_LINK_SOURCE);
  private readonly disposables: vscode.Disposable[] = [this.collection];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly fileIndexService: FileIndexService) {
    this.disposables.push(
      fileIndexService.onDidUpdateIndex(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vscodeMdEditor.wikilinks.brokenLinkDiagnostics')) {
          this.schedule();
        }
      }),
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.update().catch(err => console.warn('[BrokenLinkDiagnostics] Update failed:', err));
    }, 500);
  }

  private async update(): Promise<void> {
    const generation = ++this.generation;
    const scope = vscode.workspace
      .getConfiguration('vscodeMdEditor.wikilinks')
      .get<Scope>('brokenLinkDiagnostics', 'memoryRepos');

    const results: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];
    if (scope !== 'off') {
      const linkIndex = this.fileIndexService.getLinkIndex();
      for (const entry of this.fileIndexService.getAllFiles()) {
        if (scope === 'memoryRepos' && findMemoryRoot(entry.relativePath, linkIndex) === undefined) {
          continue;
        }
        const diagnostics: vscode.Diagnostic[] = [];
        for (const link of entry.outgoingLinks) {
          if (this.fileIndexService.resolveWikilink(link.target, entry.relativePath)) {
            continue;
          }
          if (hasNonMarkdownExtension(link.target) &&
              await this.fileIndexService.resolveLinkUri(link.target, entry.uri)) {
            continue;
          }
          const start = new vscode.Position(link.line, link.column);
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(start, start.translate(0, link.length)),
            `No file found for [[${link.target}]]`,
            vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = BROKEN_LINK_SOURCE;
          diagnostics.push(diagnostic);
        }
        if (diagnostics.length > 0) {
          results.push([entry.uri, diagnostics]);
        }
      }
    }

    // A newer update started while this one awaited the disk — let it win.
    if (generation !== this.generation) {
      return;
    }
    this.collection.clear();
    this.collection.set(results);
  }

  public dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
