import * as vscode from 'vscode';

/**
 * Paths the file indexes key on, shared by FileIndexService,
 * MermaidFileIndexService and the active-file lookups that are compared
 * against their keys.
 *
 * In a single-folder workspace an index path is the path inside that folder,
 * as it always was. In a multi-root workspace it is prefixed with the
 * workspace folder's name (`memory-alice/MEMORY.md`): a path inside the
 * folder alone can't tell `memory-alice/MEMORY.md` from `memory-bob/MEMORY.md`
 * when each is its own workspace folder, so one silently overwrote the other.
 */
export interface WorkspacePath {
  folder: vscode.WorkspaceFolder;
  /** Unique across the workspace — the index key. */
  indexPath: string;
  /** Inside the workspace folder — what exclude globs are matched against. */
  folderRelativePath: string;
}

/**
 * Prefix for index paths in `folder` ('' in a single-folder workspace).
 * Folder names normally differ; when two don't, the later ones get their
 * position appended so their keys can't collide.
 */
export function workspaceFolderPrefix(folder: vscode.WorkspaceFolder): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return '';
  }
  // A .code-workspace file can give a folder any display name, slashes
  // included — but the prefix must stay a single path segment.
  const safe = (f: vscode.WorkspaceFolder) => f.name.replace(/[\\/]/g, '-');
  const safeName = safe(folder);
  const firstWithName = folders.find(f => safe(f) === safeName);
  const name = firstWithName && firstWithName.index !== folder.index
    ? `${safeName} (${folder.index + 1})`
    : safeName;
  return name + '/';
}

/**
 * Index path for a URI, or undefined if it isn't inside a workspace folder
 * (or is a workspace folder itself).
 *
 * Slices by folder.uri.fsPath's character length rather than a manual
 * startsWith()/slice() with an equality check, or path.relative() — both of
 * those re-derive containment via their own string comparison, which has to
 * reimplement VS Code's platform-specific case sensitivity rules
 * (case-insensitive path matching on Windows AND macOS, case-sensitive on
 * Linux) to avoid rejecting a real match. getWorkspaceFolder() has ALREADY
 * determined uri belongs under folder using those exact rules — a case
 * difference never changes string length, so slicing by length trusts that
 * determination instead of redundantly (and inconsistently) re-checking it.
 * The original bug was exactly a startsWith() mismatch — on a document
 * opened via a differently-cased path — silently returning the full
 * absolute path AS the "relative" path, indexed as a second, bogus entry for
 * an already-indexed file.
 */
export function getWorkspacePath(uri: vscode.Uri): WorkspacePath | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const relative = uri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]/, '');
  if (!relative) {
    return undefined;
  }
  const folderRelativePath = relative.replace(/\\/g, '/');
  return { folder, indexPath: workspaceFolderPrefix(folder) + folderRelativePath, folderRelativePath };
}

/** The workspace folder an index path belongs to, and the path inside it. */
export function splitIndexPath(indexPath: string): { folder: vscode.WorkspaceFolder; rest: string } | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) {
    return { folder: folders[0], rest: indexPath };
  }
  for (const folder of folders) {
    const prefix = workspaceFolderPrefix(folder);
    if (indexPath === prefix.slice(0, -1)) {
      return { folder, rest: '' };
    }
    if (indexPath.startsWith(prefix)) {
      return { folder, rest: indexPath.slice(prefix.length) };
    }
  }
  return undefined;
}

/** URI for an index path (which needn't exist yet), or undefined if it names no workspace folder. */
export function uriForIndexPath(indexPath: string): vscode.Uri | undefined {
  const split = splitIndexPath(indexPath);
  if (!split) {
    return undefined;
  }
  return split.rest ? vscode.Uri.joinPath(split.folder.uri, split.rest) : split.folder.uri;
}

/** The index-path prefixes of every workspace folder (empty in a single-folder workspace). */
export function allWorkspaceFolderPrefixes(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map(workspaceFolderPrefix)
    .filter(p => p !== '')
    .map(p => p.slice(0, -1));
}
