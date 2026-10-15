/**
 * Wikilink target resolution. Pure functions, no VS Code dependency and no
 * imports, so the node:test suite can load this file directly.
 *
 * A `[[target]]` resolves, in order:
 *   1. From the source file's memory root: the nearest ancestor folder that
 *      contains a MEMORY.md (the Agent Memory Repo spec, where `[[path]]` is
 *      relative to the memory repo's root).
 *   2. From the workspace root, so `[[folder/note]]` works in any workspace.
 *   3. By filename stem (`[[note]]`), the original Obsidian-style lookup.
 *
 * A `.md`/`.markdown` extension on the target is optional. Matching is
 * case-insensitive throughout, as it always has been for stems.
 */

const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** All paths are workspace-relative and forward-slash separated. */
export interface LinkIndex {
  /** Lowercase path without its markdown extension -> relativePath. */
  pathKeyToPath: Map<string, string>;
  /** Lowercase filename stem -> every relativePath with that stem. */
  stemToPaths: Map<string, Set<string>>;
  /** Lowercase folder containing a MEMORY.md ('' = workspace root) -> folder as written. */
  memoryRoots: Map<string, string>;
}

export type ResolvedVia = 'memoryRoot' | 'workspace' | 'stem';

export interface ResolvedLink {
  path: string;
  via: ResolvedVia;
}

/** The parts of a parsed wikilink occurrence the rewrite planner needs. */
export interface LinkOccurrence {
  /** Target text, trimmed, without any `|display` part. */
  target: string;
  /** Offset of the first character of `target` in the source text. */
  targetOffset: number;
}

export interface LinkRewrite {
  start: number;
  end: number;
  newText: string;
}

export function createLinkIndex(): LinkIndex {
  return { pathKeyToPath: new Map(), stemToPaths: new Map(), memoryRoots: new Map() };
}

export function buildLinkIndex(paths: Iterable<string>): LinkIndex {
  const index = createLinkIndex();
  for (const p of paths) {
    addToLinkIndex(index, p);
  }
  return index;
}

export function addToLinkIndex(index: LinkIndex, relativePath: string): void {
  index.pathKeyToPath.set(pathKey(relativePath), relativePath);
  const stem = stemOf(relativePath).toLowerCase();
  let paths = index.stemToPaths.get(stem);
  if (!paths) {
    paths = new Set();
    index.stemToPaths.set(stem, paths);
  }
  paths.add(relativePath);
  if (isMemoryEntryPoint(relativePath)) {
    const dir = dirOf(relativePath);
    index.memoryRoots.set(dir.toLowerCase(), dir);
  }
}

export function removeFromLinkIndex(index: LinkIndex, relativePath: string): void {
  const key = pathKey(relativePath);
  // Only drop a mapping that still points at THIS file — `a.md` and
  // `a.markdown` (or two case variants) share a key.
  if (index.pathKeyToPath.get(key) === relativePath) {
    index.pathKeyToPath.delete(key);
  }
  const stem = stemOf(relativePath).toLowerCase();
  const paths = index.stemToPaths.get(stem);
  if (paths) {
    paths.delete(relativePath);
    if (paths.size === 0) {
      index.stemToPaths.delete(stem);
    }
  }
  if (isMemoryEntryPoint(relativePath)) {
    index.memoryRoots.delete(dirOf(relativePath).toLowerCase());
  }
}

/** True for a memory repo's entry point: a file named exactly MEMORY.md (any case). */
export function isMemoryEntryPoint(relativePath: string): boolean {
  return basenameOf(relativePath).toLowerCase() === 'memory.md';
}

/**
 * Tidy a link target into a forward-slash path, keeping its case and any
 * extension: trims, converts `\` to `/`, drops a leading `/` or `./` and
 * collapses repeated slashes. Returns undefined for an empty target or one
 * with a `..` segment — links are relative to a root and never climb out.
 */
export function normalizeLinkTarget(target: string): string | undefined {
  const parts = target.trim().replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.');
  if (parts.length === 0 || parts.includes('..')) {
    return undefined;
  }
  return parts.join('/');
}

/** Lowercase lookup key for a path or link target: no markdown extension. */
export function pathKey(pathOrTarget: string): string {
  return pathOrTarget.replace(MARKDOWN_EXT, '').toLowerCase();
}

/** Lookup key for a raw link target, or undefined if it can't name a file. */
export function linkKey(target: string): string | undefined {
  const normalized = normalizeLinkTarget(target);
  return normalized === undefined ? undefined : pathKey(normalized);
}

export function hasMarkdownExtension(p: string): boolean {
  return MARKDOWN_EXT.test(p);
}

export function stripMarkdownExtension(p: string): string {
  return p.replace(MARKDOWN_EXT, '');
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function stemOf(p: string): string {
  const name = basenameOf(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function joinRoot(root: string, rel: string): string {
  return root ? `${root}/${rel}` : rel;
}

/** True if `p` is inside the folder `rootLower` ('' contains everything). */
function isUnder(p: string, rootLower: string): boolean {
  return rootLower === '' || p.toLowerCase().startsWith(rootLower + '/');
}

/**
 * Lowercase key of the memory root `relativePath` belongs to — the nearest
 * ancestor folder holding a MEMORY.md — or undefined when it isn't in one.
 */
export function findMemoryRoot(relativePath: string, index: LinkIndex): string | undefined {
  if (index.memoryRoots.size === 0) {
    return undefined;
  }
  let dir = dirOf(relativePath).toLowerCase();
  for (;;) {
    if (index.memoryRoots.has(dir)) {
      return dir;
    }
    if (dir === '') {
      return undefined;
    }
    dir = dirOf(dir);
  }
}

/** Every memory root that contains `relativePath`, nearest first. */
export function memoryRootsContaining(relativePath: string, index: LinkIndex): string[] {
  const roots: string[] = [];
  let dir = dirOf(relativePath).toLowerCase();
  for (;;) {
    if (index.memoryRoots.has(dir)) {
      roots.push(dir);
    }
    if (dir === '') {
      return roots;
    }
    dir = dirOf(dir);
  }
}

/**
 * Resolve a link target written in `fromPath` (undefined when the source
 * isn't in the workspace) to an indexed markdown file.
 */
export function resolveWikilinkTarget(
  target: string,
  fromPath: string | undefined,
  index: LinkIndex,
): ResolvedLink | undefined {
  const key = linkKey(target);
  if (key === undefined) {
    return undefined;
  }

  const root = fromPath !== undefined ? findMemoryRoot(fromPath, index) : undefined;
  if (root !== undefined) {
    const p = index.pathKeyToPath.get(joinRoot(root, key));
    if (p !== undefined) {
      return { path: p, via: 'memoryRoot' };
    }
  }

  const p = index.pathKeyToPath.get(key);
  if (p !== undefined) {
    return { path: p, via: 'workspace' };
  }

  if (!key.includes('/')) {
    const candidates = index.stemToPaths.get(key);
    if (candidates && candidates.size > 0) {
      // Sorted so a stem shared by several files resolves the same way every
      // time, instead of to whichever file happened to be indexed last.
      const sorted = Array.from(candidates).sort();
      const inRoot = root !== undefined ? sorted.find(c => isUnder(c, root)) : undefined;
      return { path: inRoot ?? sorted[0], via: 'stem' };
    }
  }

  return undefined;
}

/**
 * Candidate workspace-relative paths for a target that isn't an indexed
 * markdown file (e.g. `[[metrics/query.sql]]`), most likely first, for the
 * caller to check on disk. Case is kept, since disk lookups may be
 * case-sensitive.
 */
export function linkCandidatePaths(
  target: string,
  fromPath: string | undefined,
  index: LinkIndex,
): string[] {
  const normalized = normalizeLinkTarget(target);
  if (normalized === undefined) {
    return [];
  }
  const candidates: string[] = [];
  const root = fromPath !== undefined ? findMemoryRoot(fromPath, index) : undefined;
  if (root !== undefined && root !== '') {
    candidates.push(joinRoot(index.memoryRoots.get(root) ?? root, normalized));
  }
  candidates.push(normalized);
  return candidates;
}

/** True if the target names a non-markdown file (has some other extension). */
export function hasNonMarkdownExtension(target: string): boolean {
  const normalized = normalizeLinkTarget(target);
  if (normalized === undefined) {
    return false;
  }
  const name = basenameOf(normalized);
  return name.lastIndexOf('.') > 0 && !hasMarkdownExtension(name);
}

/**
 * The link text to write for `targetPath` from `fromPath`: the path from the
 * shared memory root (spec style), else the bare stem when it's unambiguous,
 * else the workspace path. Always verified to resolve back to `targetPath`.
 */
export function preferredLinkText(
  targetPath: string,
  fromPath: string | undefined,
  index: LinkIndex,
): string {
  const resolvesBack = (text: string) =>
    resolveWikilinkTarget(text, fromPath, index)?.path === targetPath;

  const root = fromPath !== undefined ? findMemoryRoot(fromPath, index) : undefined;
  if (root !== undefined && isUnder(targetPath, root)) {
    const rel = stripMarkdownExtension(root ? targetPath.slice(root.length + 1) : targetPath);
    if (resolvesBack(rel)) {
      return rel;
    }
  }

  const stem = stemOf(targetPath);
  if ((index.stemToPaths.get(stem.toLowerCase())?.size ?? 0) === 1 && resolvesBack(stem)) {
    return stem;
  }

  return stripMarkdownExtension(targetPath);
}

/**
 * Plan the link edits a rename or move needs in one source file.
 *
 * `moved` maps old -> new relativePath for every file being moved (folder
 * renames already expanded). `oldIndex` is the index before the move and
 * `newIndex` the index after it. A link is only rewritten when, after the
 * move, its current text would no longer reach the file it reached before —
 * so a pure move leaves `[[stem]]` links alone while `[[old/path]]` links
 * are updated. The new text keeps the style it was written in (stem, path
 * from the memory root or path from the workspace root) and any `.md` the
 * author typed, and falls back to `preferredLinkText` if that wouldn't
 * resolve.
 */
export function computeLinkRewrites(
  occurrences: LinkOccurrence[],
  sourceOldPath: string,
  sourceNewPath: string,
  moved: Map<string, string>,
  oldIndex: LinkIndex,
  newIndex: LinkIndex,
): LinkRewrite[] {
  const rewrites: LinkRewrite[] = [];
  const sourceMoved = sourceOldPath !== sourceNewPath;

  for (const occ of occurrences) {
    const before = resolveWikilinkTarget(occ.target, sourceOldPath, oldIndex);
    if (!before) {
      continue;
    }
    const newTarget = moved.get(before.path) ?? (sourceMoved ? before.path : undefined);
    if (newTarget === undefined) {
      continue; // Neither end of this link moved.
    }
    if (resolveWikilinkTarget(occ.target, sourceNewPath, newIndex)?.path === newTarget) {
      continue; // Still reaches the same file as written.
    }

    const resolvesBack = (text: string) =>
      resolveWikilinkTarget(text, sourceNewPath, newIndex)?.path === newTarget;

    let text: string | undefined;
    if (before.via === 'stem') {
      text = stemOf(newTarget);
    } else if (before.via === 'memoryRoot') {
      const root = findMemoryRoot(sourceNewPath, newIndex);
      if (root !== undefined && isUnder(newTarget, root)) {
        text = stripMarkdownExtension(root ? newTarget.slice(root.length + 1) : newTarget);
      }
    } else {
      text = stripMarkdownExtension(newTarget);
    }
    if (text !== undefined && hasMarkdownExtension(occ.target)) {
      text += occ.target.match(MARKDOWN_EXT)![0];
    }
    if (text === undefined || !resolvesBack(text)) {
      text = preferredLinkText(newTarget, sourceNewPath, newIndex);
    }

    rewrites.push({ start: occ.targetOffset, end: occ.targetOffset + occ.target.length, newText: text });
  }

  return rewrites;
}
