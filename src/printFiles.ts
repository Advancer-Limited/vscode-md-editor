import * as vscode from 'vscode';

/** How long a generated print page is kept before being swept. */
const PRINT_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete previously generated print pages older than the TTL, matched by
 * `filePattern` (must have exactly one capture group: the millisecond
 * timestamp embedded in the filename). They can't be deleted immediately
 * after opening — the browser loads them asynchronously — so stale ones are
 * swept on the next print instead; without this they'd accumulate
 * indefinitely, each holding a full copy of a diagram or document.
 *
 * Shared between the Markdown and Mermaid editors, which both write their
 * print pages into the same `context.globalStorageUri` directory.
 */
export async function sweepOldPrintFiles(dir: vscode.Uri, filePattern: RegExp): Promise<void> {
  try {
    const cutoff = Date.now() - PRINT_FILE_TTL_MS;
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const match = filePattern.exec(name);
      if (!match || Number(match[1]) >= cutoff) continue;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
      } catch {
        // A file we can't delete shouldn't block printing.
      }
    }
  } catch {
    // Sweeping is best-effort housekeeping — never fail a print over it.
  }
}
