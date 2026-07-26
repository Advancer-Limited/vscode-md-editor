// Tests for the exclude-glob matcher behind the Markdown/Mermaid file indexes.
// The headline case is the one that shipped broken: nested repository copies
// (Claude Code's per-agent git worktrees under .claude/worktrees) were indexed
// alongside the real files, so every document appeared once per worktree.
import { test } from 'node:test';
import assert from 'node:assert';

// Imported from TypeScript source directly — Node strips the types.
const { matchesAnyGlob, buildFindFilesExclude } = await import('../src/globMatch.ts');

const DEFAULTS = ['**/node_modules/**', '**/.git/**', '**/.claude/worktrees/**'];

test('excludes markdown inside Claude Code agent worktrees', () => {
  assert.equal(
    matchesAnyGlob('.claude/worktrees/agent-a0038e408c12e3504/docs/00-overview.md', DEFAULTS),
    true,
  );
  assert.equal(
    matchesAnyGlob('.claude/worktrees/todo-sync/docs/01-architecture.md', DEFAULTS),
    true,
  );
});

test('keeps the real file the worktrees are copies of', () => {
  assert.equal(matchesAnyGlob('docs/00-overview.md', DEFAULTS), false);
  assert.equal(matchesAnyGlob('README.md', DEFAULTS), false);
});

test('does not exclude unrelated paths that merely mention .claude', () => {
  // .claude itself is not excluded — only the worktrees inside it, so a
  // hand-written note under .claude/ still shows up.
  assert.equal(matchesAnyGlob('.claude/notes.md', DEFAULTS), false);
  assert.equal(matchesAnyGlob('docs/claude-worktrees-guide.md', DEFAULTS), false);
});

test('excludes at any depth, not just the workspace root', () => {
  assert.equal(matchesAnyGlob('packages/api/node_modules/pkg/readme.md', DEFAULTS), true);
  assert.equal(matchesAnyGlob('a/b/c/.claude/worktrees/x/doc.md', DEFAULTS), true);
});

test('a folder pattern excludes its whole subtree, with or without a trailing /**', () => {
  // VS Code's own files.exclude entries are written without the trailing
  // glob (e.g. "**/.git"), so both spellings have to behave the same.
  assert.equal(matchesAnyGlob('.git/config.md', ['**/.git']), true);
  assert.equal(matchesAnyGlob('.git/config.md', ['**/.git/**']), true);
  assert.equal(matchesAnyGlob('.github/workflows/ci.md', ['**/.git']), false);
});

test('supports * and ? within a single segment', () => {
  assert.equal(matchesAnyGlob('docs/draft-notes.md', ['**/draft-*.md']), true);
  assert.equal(matchesAnyGlob('docs/notes.md', ['**/draft-*.md']), false);
  assert.equal(matchesAnyGlob('docs/a1.md', ['**/a?.md']), true);
  assert.equal(matchesAnyGlob('docs/a12.md', ['**/a?.md']), false);
  // '*' must not cross a separator
  assert.equal(matchesAnyGlob('docs/sub/notes.md', ['docs/*.md']), false);
});

test('supports {a,b} alternation', () => {
  assert.equal(matchesAnyGlob('out/gen.md', ['**/{out,dist}/**']), true);
  assert.equal(matchesAnyGlob('dist/gen.md', ['**/{out,dist}/**']), true);
  assert.equal(matchesAnyGlob('src/gen.md', ['**/{out,dist}/**']), false);
});

test('a malformed pattern is inert rather than fatal', () => {
  // An unbalanced brace from a hand-edited setting must not throw and take
  // the whole index down with it.
  assert.doesNotThrow(() => matchesAnyGlob('docs/a.md', ['**/{unclosed']));
  assert.equal(matchesAnyGlob('docs/a.md', ['**/{unclosed']), false);
});

test('empty pattern list matches nothing', () => {
  assert.equal(matchesAnyGlob('anything.md', []), false);
});

test('buildFindFilesExclude brace-joins patterns for findFiles', () => {
  assert.equal(buildFindFilesExclude([]), undefined);
  assert.equal(buildFindFilesExclude(['**/node_modules/**']), '**/node_modules/**');
  assert.equal(
    buildFindFilesExclude(['**/node_modules/**', '**/.git/**']),
    '{**/node_modules/**,**/.git/**}',
  );
});

test('buildFindFilesExclude drops patterns that would corrupt the brace list', () => {
  // Nested braces / stray commas can't be safely embedded — they stay out of
  // the findFiles pattern and are enforced by matchesAnyGlob instead.
  const combined = buildFindFilesExclude(['**/node_modules/**', '**/{out,dist}/**']);
  assert.equal(combined, '**/node_modules/**');
  assert.equal(matchesAnyGlob('dist/gen.md', ['**/{out,dist}/**']), true);
});
