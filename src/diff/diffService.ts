import { execFile } from 'child_process';
import * as vscode from 'vscode';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  date: string;
}

/**
 * Thin wrapper around git CLI for retrieving file history and content at specific commits.
 * Uses child_process directly — no dependency on VS Code's git extension.
 */
export class DiffService {
  /**
   * Find the git repository root for a given file URI.
   * Returns undefined if the file is not in a git repo.
   */
  public async getRepoRoot(fileUri: vscode.Uri): Promise<string | undefined> {
    const dir = vscode.Uri.joinPath(fileUri, '..').fsPath;
    try {
      return await this.git(dir, ['rev-parse', '--show-toplevel']);
    } catch {
      return undefined;
    }
  }

  /**
   * Get the commit history for a specific file.
   * Returns commits that touched the file, most recent first.
   */
  public async getFileHistory(
    repoRoot: string,
    relativePath: string,
    maxCount = 20,
  ): Promise<CommitInfo[]> {
    const separator = '---COMMIT---';
    const format = `%H%n%h%n%s%n%an%n%ai${separator}`;

    const output = await this.git(repoRoot, [
      'log',
      `--max-count=${maxCount}`,
      `--format=${format}`,
      '--follow',
      '--',
      relativePath,
    ]);

    const commits: CommitInfo[] = [];
    const blocks = output.split(separator).filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length >= 5) {
        commits.push({
          hash: lines[0],
          shortHash: lines[1],
          message: lines[2],
          authorName: lines[3],
          date: lines[4],
        });
      }
    }

    return commits;
  }

  /**
   * Get the content of a file at a specific commit.
   */
  public async getFileContentAtCommit(
    repoRoot: string,
    relativePath: string,
    commitHash: string,
  ): Promise<string> {
    // Normalize path separators for git
    const gitPath = relativePath.replace(/\\/g, '/');
    return await this.git(repoRoot, ['show', `${commitHash}:${gitPath}`]);
  }

  /**
   * Get the relative path of a file within its repo.
   */
  public getRelativePath(repoRoot: string, fileUri: vscode.Uri): string {
    // Normalize both paths to forward slashes and lowercase drive letter for comparison.
    // git rev-parse returns forward-slash paths; fsPath uses OS-native separators.
    const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    const normalizedFile = fileUri.fsPath.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    let rel = normalizedFile.slice(normalizedRoot.length);
    rel = rel.replace(/^\//, '');
    return rel;
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.trimEnd());
        }
      });
    });
  }
}
