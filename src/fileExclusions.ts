import * as vscode from 'vscode';

/**
 * Folders the file indexes skip by default.
 *
 * `.claude/worktrees` is the one that isn't obvious: Claude Code creates a
 * throwaway git worktree per background agent there, each a full copy of the
 * repository. Indexing them made every real document appear once per worktree
 * in the sidebar (24 worktrees turned 35 markdown files into 502), and let a
 * wikilink resolve to a copy inside a worktree rather than the real file.
 */
export const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.claude/worktrees/**',
];

/** Settings whose `true` entries are folded into the exclude list. */
const INHERITED_EXCLUDE_SETTINGS = ['files.exclude', 'search.exclude'];

/**
 * Exclude globs for the markdown/mermaid file indexes: this extension's own
 * `vscodeMdEditor.exclude` setting, plus whatever the user already hides from
 * the Explorer and search. Inheriting those two means "hidden in VS Code" and
 * "absent from these file lists" stay in agreement without configuring the
 * same folder twice.
 *
 * Entries with a `when` clause (a conditional sibling-file check) are skipped
 * — only plain `true` values are honoured, since resolving `when` needs a
 * filesystem probe per candidate file.
 */
export function getExcludePatterns(): string[] {
  const own = vscode.workspace
    .getConfiguration('vscodeMdEditor')
    .get<string[]>('exclude') ?? DEFAULT_EXCLUDE_GLOBS;

  const patterns = new Set<string>(own);

  for (const setting of INHERITED_EXCLUDE_SETTINGS) {
    const section = vscode.workspace.getConfiguration().get<Record<string, unknown>>(setting);
    if (!section) {
      continue;
    }
    for (const [glob, value] of Object.entries(section)) {
      if (value === true) {
        patterns.add(glob);
      }
    }
  }

  return Array.from(patterns);
}

/** True if a configuration change affects any of the exclude sources above. */
export function affectsExcludeSettings(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration('vscodeMdEditor.exclude')
    || INHERITED_EXCLUDE_SETTINGS.some(setting => e.affectsConfiguration(setting));
}
