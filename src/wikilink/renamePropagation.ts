import * as vscode from 'vscode';
import { FileIndexService } from './fileIndexService.js';
import { isMarkdownFile } from '../utils.js';
import { parseWikilinks } from './wikilinkParser.js';
import { buildLinkIndex, computeLinkRewrites } from './linkResolution.js';

/**
 * Handle file and folder rename/move events: update every [[wikilink]] the
 * move would break — `[[stem]]` links when a file is renamed, `[[path]]`
 * links (Agent Memory Repo style) when a file or folder moves, and a moved
 * file's own path links when it moves to a different memory root.
 * Returns a WorkspaceEdit that is applied atomically with the rename.
 */
export async function handleWillRenameFiles(
  event: vscode.FileWillRenameEvent,
  fileIndexService: FileIndexService,
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();

  // Old -> new relativePath for every indexed markdown file being moved,
  // with folder renames expanded to the files inside them.
  const moved = new Map<string, string>();
  for (const { oldUri, newUri } of event.files) {
    const oldPath = fileIndexService.getRelativePath(oldUri);
    const newPath = fileIndexService.getRelativePath(newUri);
    if (oldPath === undefined || newPath === undefined) {
      continue; // Moving into or out of the workspace — nothing to rewrite to.
    }
    if (isMarkdownFile(oldUri.fsPath)) {
      if (fileIndexService.getFileEntry(oldPath) && isMarkdownFile(newUri.fsPath)) {
        moved.set(oldPath, newPath);
      }
      continue;
    }
    for (const entry of fileIndexService.getFilesUnder(oldUri)) {
      moved.set(entry.relativePath, newPath + entry.relativePath.slice(oldPath.length));
    }
  }
  if (moved.size === 0) {
    return edit;
  }

  const oldIndex = fileIndexService.getLinkIndex();
  const newIndex = buildLinkIndex(
    fileIndexService.getAllFiles().map(e => moved.get(e.relativePath) ?? e.relativePath),
  );

  // Files that might hold an affected link: everything linking to a moved
  // file, plus the moved files themselves (their own path links can break).
  const sources = new Set<string>(moved.keys());
  for (const oldPath of moved.keys()) {
    const entry = fileIndexService.getFileEntry(oldPath);
    if (entry) {
      for (const backlink of fileIndexService.getBacklinksFor(entry)) {
        sources.add(backlink.relativePath);
      }
    }
  }

  for (const sourcePath of sources) {
    const entry = fileIndexService.getFileEntry(sourcePath);
    if (!entry) {
      continue;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(entry.uri);
      const text = doc.getText();
      const rewrites = computeLinkRewrites(
        parseWikilinks(text),
        sourcePath,
        moved.get(sourcePath) ?? sourcePath,
        moved,
        oldIndex,
        newIndex,
      );
      // Edits target the file's current (pre-rename) URI: VS Code applies
      // the returned edit before it performs the rename.
      for (const { start, end, newText } of rewrites) {
        edit.replace(
          entry.uri,
          new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
          newText,
        );
      }
    } catch (err) {
      console.warn(`[RenamePropagation] Failed to process ${entry.relativePath}:`, err);
    }
  }

  return edit;
}
