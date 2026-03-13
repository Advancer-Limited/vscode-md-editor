/**
 * Simple line-level diff using Longest Common Subsequence (LCS).
 * No external dependencies — just compares lines and groups consecutive changes.
 */

export interface DiffHunk {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
}

export function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
  // Normalize line endings — git returns \n, but files on Windows may use \r\n.
  // Without this, every line appears changed due to trailing \r mismatch.
  const oldLines = oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const newLines = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce per-line diff entries
  const entries: { type: DiffHunk['type']; value: string }[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      entries.push({ type: 'unchanged', value: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      entries.push({ type: 'added', value: newLines[j - 1] });
      j--;
    } else {
      entries.push({ type: 'removed', value: oldLines[i - 1] });
      i--;
    }
  }

  entries.reverse();

  // Group consecutive same-type entries into hunks
  const hunks: DiffHunk[] = [];
  for (const entry of entries) {
    const last = hunks[hunks.length - 1];
    if (last && last.type === entry.type) {
      last.content += '\n' + entry.value;
    } else {
      hunks.push({ type: entry.type, content: entry.value });
    }
  }

  return hunks;
}
