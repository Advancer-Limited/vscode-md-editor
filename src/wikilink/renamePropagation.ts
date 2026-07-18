import * as vscode from 'vscode';
import { FileIndexService } from './fileIndexService.js';
import { getFileStem, isMarkdownFile } from '../utils.js';
import { findWikilinkStemRanges } from './wikilinkParser.js';

/**
 * Handle file rename events: update all [[wikilink]] references
 * to the old filename across the workspace.
 * Returns a WorkspaceEdit that is applied atomically with the rename.
 */
export async function handleWillRenameFiles(
  event: vscode.FileWillRenameEvent,
  fileIndexService: FileIndexService,
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();

  for (const { oldUri, newUri } of event.files) {
    if (!isMarkdownFile(oldUri.fsPath)) {
      continue;
    }

    const oldStem = getFileStem(oldUri.fsPath);
    const newStem = getFileStem(newUri.fsPath);

    if (oldStem.toLowerCase() === newStem.toLowerCase()) {
      continue; // Only moved, not renamed — no wikilink updates needed
    }

    // If another file shares this stem and currently owns the [[oldStem]]
    // resolution, those links point at THAT file — renaming this one must not
    // rewrite them. Only proceed when the stem resolves to the renamed file.
    const resolvedPath = fileIndexService.resolveWikilink(oldStem);
    if (resolvedPath) {
      const resolvedEntry = fileIndexService.getFileEntry(resolvedPath);
      if (resolvedEntry && resolvedEntry.uri.toString() !== oldUri.toString()) {
        continue;
      }
    }

    // Find all files that link to the old stem
    const backlinks = fileIndexService.getBacklinksFor(oldStem);

    for (const entry of backlinks) {
      try {
        const doc = await vscode.workspace.openTextDocument(entry.uri);
        const text = doc.getText();

        // Replace just the stem portion of each [[oldStem]] / [[oldStem|...]]
        // occurrence (case-insensitive, whitespace-tolerant).
        for (const { start, end } of findWikilinkStemRanges(text, oldStem)) {
          edit.replace(
            entry.uri,
            new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
            newStem,
          );
        }
      } catch (err) {
        console.warn(`[RenamePropagation] Failed to process ${entry.relativePath}:`, err);
        continue;
      }
    }
  }

  return edit;
}
