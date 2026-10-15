// Tests for wikilink resolution and rename/move link rewriting, run against
// tests/fixtures/memory-workspace: two Agent Memory Repo folders (memory-john,
// memory-bob — a MEMORY.md at each root, `[[path]]` links relative to it)
// built from the spec README's examples, plus an Obsidian-style notes/ folder
// with plain `[[stem]]` links.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  buildLinkIndex,
  resolveWikilinkTarget,
  linkCandidatePaths,
  hasNonMarkdownExtension,
  normalizeLinkTarget,
  findMemoryRoot,
  preferredLinkText,
  computeLinkRewrites,
} = await import('../src/wikilink/linkResolution.ts');
const { parseWikilinks } = await import('../src/wikilink/wikilinkParser.ts');

const ROOT = fileURLToPath(new URL('./fixtures/memory-workspace/', import.meta.url));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(join(dir, d.name)) : [relative(ROOT, join(dir, d.name)).replace(/\\/g, '/')],
  );
}

const ALL_FILES = walk(ROOT);
const MD_FILES = ALL_FILES.filter(p => /\.(md|markdown)$/i.test(p));
// Line endings normalised: a Windows checkout with autocrlf has CRLF files.
const TEXT = Object.fromEntries(MD_FILES.map(p => [p, readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')]));
const INDEX = buildLinkIndex(MD_FILES);

const resolve = (target, from, index = INDEX) => resolveWikilinkTarget(target, from, index)?.path;

/** Apply rewrites to text (last first, so earlier offsets stay valid). */
function applyRewrites(text, rewrites) {
  return [...rewrites]
    .sort((a, b) => b.start - a.start)
    .reduce((t, r) => t.slice(0, r.start) + r.newText + t.slice(r.end), text);
}

/** Simulate a rename: returns { path: newText } for every file whose links change. */
function simulateMove(moves) {
  const moved = new Map();
  for (const [from, to] of Object.entries(moves)) {
    if (MD_FILES.includes(from)) {
      moved.set(from, to);
    } else {
      // A folder: expand to the files inside it.
      for (const p of MD_FILES.filter(f => f.startsWith(from + '/'))) {
        moved.set(p, to + p.slice(from.length));
      }
    }
  }
  const newIndex = buildLinkIndex(MD_FILES.map(p => moved.get(p) ?? p));
  const changed = {};
  for (const source of MD_FILES) {
    const rewrites = computeLinkRewrites(
      parseWikilinks(TEXT[source]), source, moved.get(source) ?? source, moved, INDEX, newIndex,
    );
    if (rewrites.length > 0) {
      changed[source] = applyRewrites(TEXT[source], rewrites);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Memory roots
// ---------------------------------------------------------------------------

test('a folder with MEMORY.md is a memory root; other folders are not in one', () => {
  assert.strictEqual(findMemoryRoot('memory-john/projects/payments.md', INDEX), 'memory-john');
  assert.strictEqual(findMemoryRoot('memory-bob/MEMORY.md', INDEX), 'memory-bob');
  assert.strictEqual(findMemoryRoot('notes/Ideas.md', INDEX), undefined);
  assert.strictEqual(findMemoryRoot('README.md', INDEX), undefined);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('[[path]] resolves from the memory root, not by stem', () => {
  // projects/payments.md and archive/payments.md share the stem "payments".
  assert.strictEqual(resolve('projects/payments', 'memory-john/MEMORY.md'), 'memory-john/projects/payments.md');
  assert.strictEqual(resolve('archive/payments', 'memory-john/projects/payments.md'), 'memory-john/archive/payments.md');
});

test('paths are relative to the memory root wherever the linking file sits', () => {
  assert.strictEqual(
    resolve('projects/website', 'memory-john/projects/payments.md'),
    'memory-john/projects/website.md',
  );
  assert.strictEqual(
    resolve('swarms/slow-checkout/README', 'memory-john/swarms/slow-checkout/findings.md'),
    'memory-john/swarms/slow-checkout/README.md',
  );
});

test('the same link resolves inside each memory repo separately', () => {
  assert.strictEqual(resolve('team_structure', 'memory-john/MEMORY.md'), 'memory-john/team_structure.md');
  assert.strictEqual(resolve('team_structure', 'memory-bob/MEMORY.md'), 'memory-bob/team_structure.md');
});

test('a .md extension on the target is optional', () => {
  assert.strictEqual(resolve('using_datadog_mcp.md', 'memory-john/MEMORY.md'), 'memory-john/using_datadog_mcp.md');
  assert.strictEqual(resolve('using_datadog_mcp', 'memory-john/MEMORY.md'), 'memory-john/using_datadog_mcp.md');
});

test('matching is case-insensitive and tolerates backslashes and a leading ./ or /', () => {
  assert.strictEqual(resolve('Projects/PAYMENTS', 'memory-john/MEMORY.md'), 'memory-john/projects/payments.md');
  assert.strictEqual(resolve('projects\\payments', 'memory-john/MEMORY.md'), 'memory-john/projects/payments.md');
  assert.strictEqual(resolve('./projects/payments', 'memory-john/MEMORY.md'), 'memory-john/projects/payments.md');
  assert.strictEqual(resolve('/projects/payments', 'memory-john/MEMORY.md'), 'memory-john/projects/payments.md');
});

test('workspace-root paths work outside memory repos', () => {
  assert.strictEqual(resolve('notes/Roadmap', 'notes/Ideas.md'), 'notes/Roadmap.md');
  assert.strictEqual(resolve('memory-john/projects/payments', 'notes/Ideas.md'), 'memory-john/projects/payments.md');
});

test('plain [[stem]] links still resolve (Obsidian style, no MEMORY.md)', () => {
  assert.strictEqual(resolve('Roadmap', 'notes/Ideas.md'), 'notes/Roadmap.md');
  assert.strictEqual(resolve('roadmap', undefined), 'notes/Roadmap.md');
});

test('a shared stem resolves the same way every time, preferring the linking file\'s memory root', () => {
  // "team_structure" exists in both memory repos.
  assert.strictEqual(resolve('team_structure', 'notes/Ideas.md'), 'memory-bob/team_structure.md'); // sorted first
  // From inside a memory repo the stem fallback prefers that repo.
  assert.strictEqual(resolve('payments', 'memory-john/team_structure.md'), 'memory-john/archive/payments.md');
});

test('a stem lookup is not attempted for a path that does not exist', () => {
  assert.strictEqual(resolve('nowhere/payments', 'memory-john/MEMORY.md'), undefined);
});

test('targets that climb out of the root never resolve', () => {
  assert.strictEqual(normalizeLinkTarget('../secrets'), undefined);
  assert.strictEqual(normalizeLinkTarget('projects/../../x'), undefined);
  assert.strictEqual(resolve('../memory-bob/team_structure', 'memory-john/MEMORY.md'), undefined);
  assert.strictEqual(normalizeLinkTarget('   '), undefined);
});

test('non-markdown targets are found on disk from the memory root', () => {
  assert.strictEqual(hasNonMarkdownExtension('metrics/autocomplete_keep_rate.sql'), true);
  assert.strictEqual(hasNonMarkdownExtension('projects/payments.md'), false);
  assert.strictEqual(hasNonMarkdownExtension('projects/payments'), false);
  assert.strictEqual(resolve('metrics/autocomplete_keep_rate.sql', 'memory-john/MEMORY.md'), undefined);

  const sql = linkCandidatePaths('metrics/autocomplete_keep_rate.sql', 'memory-john/MEMORY.md', INDEX);
  assert.strictEqual(sql[0], 'memory-john/metrics/autocomplete_keep_rate.sql');
  assert.ok(existsSync(join(ROOT, sql[0])));

  const bench = linkCandidatePaths(
    'swarms/slow-checkout/scripts/bench.sh', 'memory-john/swarms/slow-checkout/README.md', INDEX,
  );
  assert.ok(existsSync(join(ROOT, bench[0])));
});

test('links inside code blocks are ignored', () => {
  const targets = parseWikilinks(TEXT['memory-john/using_datadog_mcp.md']).map(l => l.target);
  assert.deepStrictEqual(targets, []);
});

test('every link in the fixture resolves except the one deliberately broken link', () => {
  const broken = [];
  for (const source of MD_FILES) {
    for (const { target } of parseWikilinks(TEXT[source])) {
      if (resolve(target, source)) {
        continue;
      }
      const onDisk = hasNonMarkdownExtension(target) &&
        linkCandidatePaths(target, source, INDEX).some(p => existsSync(join(ROOT, p)));
      if (!onDisk) {
        broken.push(`${source} -> [[${target}]]`);
      }
    }
  }
  assert.deepStrictEqual(broken, ['memory-john/projects/website.md -> [[projects/launch_checklist]]']);
});

// ---------------------------------------------------------------------------
// Link text for autocomplete
// ---------------------------------------------------------------------------

test('autocomplete writes spec-style paths inside a memory repo', () => {
  assert.strictEqual(
    preferredLinkText('memory-john/projects/payments.md', 'memory-john/MEMORY.md', INDEX),
    'projects/payments',
  );
  assert.strictEqual(
    preferredLinkText('memory-john/team_structure.md', 'memory-john/projects/website.md', INDEX),
    'team_structure',
  );
});

test('autocomplete writes a bare stem when it is unambiguous, else a workspace path', () => {
  assert.strictEqual(preferredLinkText('notes/Roadmap.md', 'notes/Ideas.md', INDEX), 'Roadmap');
  assert.strictEqual(
    preferredLinkText('memory-john/projects/payments.md', 'notes/Ideas.md', INDEX),
    'memory-john/projects/payments',
  );
});

// ---------------------------------------------------------------------------
// Parser offsets
// ---------------------------------------------------------------------------

test('targetOffset points at the trimmed target inside the brackets', () => {
  const text = 'x [[ Foo ]] y [[Bar|alias]] [[  a/b.md  |  c ]]';
  const picked = parseWikilinks(text).map(l => text.slice(l.targetOffset, l.targetOffset + l.target.length));
  assert.deepStrictEqual(picked, ['Foo', 'Bar', 'a/b.md']);
});

// ---------------------------------------------------------------------------
// Rename / move rewriting
// ---------------------------------------------------------------------------

test('renaming a file rewrites [[path]] links to it and keeps |display text', () => {
  const changed = simulateMove({ 'memory-john/projects/payments.md': 'memory-john/projects/billing.md' });
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[projects\/billing\]\]/);
  assert.strictEqual(
    changed['memory-john/team_structure.md'],
    '- Priya owns pricing for the billing launch; see [[projects/billing|the payments project]] [added: 2026-09-03]\n',
  );
  assert.strictEqual(changed['memory-john/archive/payments.md'], '- Superseded by [[projects/billing]] [added: 2026-08-01]\n');
  assert.deepStrictEqual(Object.keys(changed).sort(), [
    'memory-john/MEMORY.md',
    'memory-john/archive/payments.md',
    'memory-john/team_structure.md',
  ]);
});

test('moving a file to another folder rewrites path links (stem unchanged)', () => {
  const changed = simulateMove({ 'memory-john/projects/website.md': 'memory-john/archive/website.md' });
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[archive\/website\]\]/);
  assert.match(changed['memory-john/projects/payments.md'], /deadline with \[\[archive\/website\]\]/);
});

test('renaming a folder rewrites links to every file inside it, including links between them', () => {
  const changed = simulateMove({ 'memory-john/projects': 'memory-john/work' });
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[work\/payments\]\]\n- \[\[work\/website\]\]/);
  assert.match(changed['memory-john/projects/payments.md'], /deadline with \[\[work\/website\]\]/);
  // A link to a file outside the folder is left alone.
  assert.match(changed['memory-john/projects/payments.md'], /\[\[archive\/payments\]\]/);
  // The deliberately broken link stays as written.
  assert.ok(!changed['memory-john/projects/website.md']?.includes('work/launch_checklist'));
});

test('renaming the memory repo folder itself changes nothing — links are relative to it', () => {
  assert.deepStrictEqual(simulateMove({ 'memory-john': 'memory-johnny' }), {});
});

test('moving a file out of its memory repo rewrites links to a path that still reaches it', () => {
  const changed = simulateMove({ 'memory-john/team_structure.md': 'notes/team_structure.md' });
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[notes\/team_structure\]\]/);
  assert.match(changed['memory-john/projects/website.md'], /see \[\[notes\/team_structure\]\]/);
});

test('a moved file\'s own root-relative links are rewritten when it changes repo', () => {
  const changed = simulateMove({ 'memory-john/archive/payments.md': 'memory-bob/payments.md' });
  // It linked [[projects/payments]] inside memory-john; from memory-bob that
  // needs the workspace path.
  assert.strictEqual(
    changed['memory-john/archive/payments.md'],
    '- Superseded by [[memory-john/projects/payments]] [added: 2026-08-01]\n',
  );
});

test('a pure move leaves [[stem]] links alone; a rename updates them, keeping spacing and display text', () => {
  assert.deepStrictEqual(simulateMove({ 'notes/Roadmap.md': 'notes/later/Roadmap.md' }), {});

  const changed = simulateMove({ 'notes/Roadmap.md': 'notes/Plan.md' });
  assert.strictEqual(changed['notes/Ideas.md'], '- Next up: [[Plan]]\n- Also see [[ Plan | the roadmap ]]\n');
});

test('an explicit .md in a link is kept when it is rewritten', () => {
  const changed = simulateMove({ 'memory-john/using_datadog_mcp.md': 'memory-john/datadog.md' });
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[datadog\.md\]\]/);
});

test('renaming one of two same-stem files does not touch links to the other', () => {
  // [[team_structure]] in memory-bob/MEMORY.md points at Bob's file.
  const changed = simulateMove({ 'memory-john/team_structure.md': 'memory-john/people.md' });
  assert.strictEqual(changed['memory-bob/MEMORY.md'], undefined);
  assert.match(changed['memory-john/MEMORY.md'], /- \[\[people\]\]/);
});

// ---------------------------------------------------------------------------
// Multi-root workspaces: every index path starts with its workspace folder's
// name, so two memory repos opened as separate roots no longer collide.
// ---------------------------------------------------------------------------

const MULTI_PATHS = [
  'memory-alice/MEMORY.md',
  'memory-alice/team.md',
  'memory-bob/MEMORY.md',
  'memory-bob/team.md',
  'docs-site/guide/intro.md',
  'docs-site/notes/todo.md',
  'other/guide/intro.md',
];
const MULTI = buildLinkIndex(MULTI_PATHS, ['memory-alice', 'memory-bob', 'docs-site', 'other']);

test('multi-root: each memory repo root resolves its own links', () => {
  assert.strictEqual(resolve('team', 'memory-alice/MEMORY.md', MULTI), 'memory-alice/team.md');
  assert.strictEqual(resolve('team', 'memory-bob/MEMORY.md', MULTI), 'memory-bob/team.md');
});

test('multi-root: a path link resolves inside the linking file\'s own workspace folder first', () => {
  assert.strictEqual(resolve('guide/intro', 'docs-site/notes/todo.md', MULTI), 'docs-site/guide/intro.md');
  assert.strictEqual(resolveWikilinkTarget('guide/intro', 'docs-site/notes/todo.md', MULTI).via, 'folderRoot');
  // Another folder is reachable by naming it.
  assert.strictEqual(resolve('other/guide/intro', 'docs-site/notes/todo.md', MULTI), 'other/guide/intro.md');
});

test('multi-root: a shared stem prefers the linking file\'s workspace folder', () => {
  assert.strictEqual(resolve('intro', 'docs-site/notes/todo.md', MULTI), 'docs-site/guide/intro.md');
  assert.strictEqual(resolve('intro', 'other/guide/intro.md', MULTI), 'other/guide/intro.md');
});

test('multi-root: autocomplete writes a path inside the folder, not the folder name', () => {
  assert.strictEqual(preferredLinkText('docs-site/guide/intro.md', 'docs-site/notes/todo.md', MULTI), 'guide/intro');
  assert.strictEqual(preferredLinkText('memory-bob/team.md', 'memory-bob/MEMORY.md', MULTI), 'team');
});

test('multi-root: moving a folder rewrites folder-relative links in the same style', () => {
  const moved = new Map([['docs-site/guide/intro.md', 'docs-site/start/intro.md']]);
  const after = buildLinkIndex(MULTI_PATHS.map(p => moved.get(p) ?? p), MULTI.folderRoots.values());
  const text = '- read [[guide/intro]] first';
  const rewrites = computeLinkRewrites(parseWikilinks(text), 'docs-site/notes/todo.md', 'docs-site/notes/todo.md', moved, MULTI, after);
  assert.strictEqual(applyRewrites(text, rewrites), '- read [[start/intro]] first');
});

test('multi-root: non-markdown candidates include the workspace folder', () => {
  assert.deepStrictEqual(
    linkCandidatePaths('assets/a.sql', 'docs-site/notes/todo.md', MULTI),
    ['docs-site/assets/a.sql', 'assets/a.sql'],
  );
  assert.deepStrictEqual(
    linkCandidatePaths('q.sql', 'memory-alice/MEMORY.md', MULTI),
    ['memory-alice/q.sql', 'q.sql'],
  );
});
