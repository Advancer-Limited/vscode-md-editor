import * as vscode from 'vscode';
import { FileIndexService, FileEntry } from './fileIndexService.js';
import { getFileStem } from '../utils.js';

type BacklinkItem = BacklinkSection | BacklinkFileItem | BacklinkContextItem;

class BacklinkSection extends vscode.TreeItem {
  public readonly children: BacklinkFileItem[];

  constructor(
    public readonly sectionType: 'backlinks' | 'unlinkedMentions',
    children: BacklinkFileItem[],
  ) {
    super(
      sectionType === 'backlinks'
        ? `Backlinks (${children.length})`
        : `Unlinked Mentions (${children.length})`,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.children = children;
    this.contextValue = sectionType;
    this.iconPath = new vscode.ThemeIcon(
      sectionType === 'backlinks' ? 'references' : 'search',
    );
  }
}

class BacklinkFileItem extends vscode.TreeItem {
  public readonly contexts: BacklinkContextItem[];

  constructor(
    public readonly fileEntry: FileEntry,
    contexts: BacklinkContextItem[],
  ) {
    super(
      fileEntry.stem,
      contexts.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contexts = contexts;
    this.description = fileEntry.folder;
    this.resourceUri = fileEntry.uri;
    this.iconPath = new vscode.ThemeIcon('file');
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [fileEntry.uri],
    };
  }
}

class BacklinkContextItem extends vscode.TreeItem {
  constructor(
    lineText: string,
    lineNumber: number,
    uri: vscode.Uri,
  ) {
    super(lineText.trim(), vscode.TreeItemCollapsibleState.None);
    this.description = `Line ${lineNumber + 1}`;
    this.iconPath = new vscode.ThemeIcon('symbol-text');
    this.command = {
      command: 'vscode.open',
      title: 'Go to Line',
      arguments: [
        uri,
        { selection: new vscode.Range(lineNumber, 0, lineNumber, 0) },
      ],
    };
  }
}

export class BacklinkTreeProvider implements vscode.TreeDataProvider<BacklinkItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BacklinkItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentStem: string | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly fileIndexService: FileIndexService,
    private readonly getActiveFilePath: () => vscode.Uri | undefined,
  ) {
    // Refresh when the index updates
    this.disposables.push(
      fileIndexService.onDidUpdateIndex(() => {
        this.refresh();
      }),
    );
  }

  /** Refresh the tree view. Call when active editor changes. */
  public refresh(): void {
    const activeUri = this.getActiveFilePath();
    if (activeUri && activeUri.fsPath.endsWith('.md')) {
      this.currentStem = getFileStem(activeUri.fsPath);
    } else {
      this.currentStem = undefined;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BacklinkItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BacklinkItem): BacklinkItem[] {
    if (!this.currentStem) {
      return [];
    }

    // Root level: return sections
    if (!element) {
      return this.getSections();
    }

    // Section level: return file items
    if (element instanceof BacklinkSection) {
      return element.children;
    }

    // File level: return context items
    if (element instanceof BacklinkFileItem) {
      return element.contexts;
    }

    return [];
  }

  private getSections(): BacklinkSection[] {
    if (!this.currentStem) {
      return [];
    }

    // Backlinks section
    const backlinkFiles = this.fileIndexService.getBacklinksFor(this.currentStem);
    const backlinkItems = backlinkFiles.map(file => {
      const contextItems = this.getContextsForBacklink(file, this.currentStem!);
      return new BacklinkFileItem(file, contextItems);
    });

    // Unlinked mentions section
    const mentions = this.fileIndexService.getUnlinkedMentions(this.currentStem);
    const mentionsByFile = new Map<string, Array<{ line: number; lineText: string }>>();
    for (const m of mentions) {
      const key = m.file.relativePath;
      if (!mentionsByFile.has(key)) {
        mentionsByFile.set(key, []);
      }
      mentionsByFile.get(key)!.push({ line: m.line, lineText: m.lineText });
    }

    const mentionItems: BacklinkFileItem[] = [];
    for (const [, contexts] of mentionsByFile) {
      const file = mentions.find(m => {
        const entry = mentionsByFile.get(m.file.relativePath);
        return entry === contexts;
      })?.file;
      if (file) {
        const contextItems = contexts.map(
          c => new BacklinkContextItem(c.lineText, c.line, file.uri),
        );
        mentionItems.push(new BacklinkFileItem(file, contextItems));
      }
    }

    return [
      new BacklinkSection('backlinks', backlinkItems),
      new BacklinkSection('unlinkedMentions', mentionItems),
    ];
  }

  private getContextsForBacklink(file: FileEntry, targetStem: string): BacklinkContextItem[] {
    const contexts: BacklinkContextItem[] = [];
    const lines = file.content.split('\n');
    const lowerStem = targetStem.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes('[[' + lowerStem)) {
        contexts.push(new BacklinkContextItem(lines[i], i, file.uri));
      }
    }

    return contexts;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
