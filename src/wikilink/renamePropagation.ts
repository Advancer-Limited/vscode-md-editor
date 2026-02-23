import * as vscode from 'vscode';
import { FileIndexService } from './fileIndexService.js';
import { getFileStem, escapeRegex } from '../utils.js';

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
    if (!oldUri.fsPath.endsWith('.md')) {
      continue;
    }

    const oldStem = getFileStem(oldUri.fsPath);
    const newStem = getFileStem(newUri.fsPath);

    if (oldStem.toLowerCase() === newStem.toLowerCase()) {
      continue; // Only moved, not renamed — no wikilink updates needed
    }

    // Find all files that link to the old stem
    const backlinks = fileIndexService.getBacklinksFor(oldStem);

    for (const entry of backlinks) {
      try {
        const doc = await vscode.workspace.openTextDocument(entry.uri);
        const text = doc.getText();

        // Match [[oldStem]] and [[oldStem|display text]]
        const regex = new RegExp(
          `\\[\\[${escapeRegex(oldStem)}(\\|[^\\]]*)?\\]\\]`,
          'gi',
        );

        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          // Replace just the stem part (after [[ and before | or ]])
          const stemStart = match.index + 2; // after [[
          const stemEnd = stemStart + oldStem.length;
          const start = doc.positionAt(stemStart);
          const end = doc.positionAt(stemEnd);
          edit.replace(entry.uri, new vscode.Range(start, end), newStem);
        }
      } catch (err) {
        console.warn(`[RenamePropagation] Failed to process ${entry.relativePath}:`, err);
        continue;
      }
    }
  }

  return edit;
}
