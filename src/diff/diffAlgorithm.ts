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

  // Trim the common prefix and suffix before running the O(m*n) LCS. For the
  // typical case (a small change inside a large file) this collapses the DP to
  // just the changed region, avoiding a quadratic-size table that could OOM the
  // extension host on large documents.
  const entries: { type: DiffHunk['type']; value: string }[] = [];

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    entries.push({ type: 'unchanged', value: oldLines[prefix] });
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  entries.push(...computeMidDiff(oldMid, newMid));

  for (let s = suffix - 1; s >= 0; s--) {
    entries.push({ type: 'unchanged', value: oldLines[oldLines.length - 1 - s] });
  }

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

/** LCS diff of the two already-prefix/suffix-trimmed middle sections. */
function computeMidDiff(
  oldLines: string[],
  newLines: string[],
): { type: DiffHunk['type']; value: string }[] {
  const m = oldLines.length;
  const n = newLines.length;
  const entries: { type: DiffHunk['type']; value: string }[] = [];

  if (m === 0 && n === 0) {
    return entries;
  }

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
  return entries;
}
