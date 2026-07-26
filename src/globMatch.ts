/**
 * Minimal glob matching for workspace-relative file paths.
 *
 * `workspace.findFiles` applies exclude globs itself, but the file indexes are
 * also fed by watchers (create/rename/save/change), which get no exclude
 * handling at all — a file created inside an excluded folder would still be
 * indexed. So the same patterns have to be testable locally, against a path
 * we already computed.
 *
 * Supports the subset that exclude settings actually use: `**` (any number of
 * path segments), `*` (any run of non-separator characters), `?` (a single
 * non-separator character), and `{a,b}` alternation.
 */

/** Compiled patterns are reused — a full workspace scan tests every file. */
const regexCache = new Map<string, RegExp>();

/** Matches nothing, used when a pattern is malformed (see globToRegExp). */
const NEVER_MATCHES = /(?!)/;

const REGEX_SPECIAL = /[.+^$()[\]\\|]/;

function globToRegExpSource(pattern: string): string {
  let src = '';
  let braceDepth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          src += '(?:[^/]*/)*'; // '**/' — zero or more whole segments
        } else {
          src += '.*'; // trailing '**' — anything, separators included
        }
      } else {
        src += '[^/]*';
      }
    } else if (char === '?') {
      src += '[^/]';
    } else if (char === '{') {
      braceDepth++;
      src += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--;
      src += ')';
    } else if (char === ',' && braceDepth > 0) {
      src += '|';
    } else if (REGEX_SPECIAL.test(char)) {
      src += '\\' + char;
    } else {
      src += char;
    }
  }

  return src;
}

/**
 * Compile an exclude glob. A pattern matches the path it names AND everything
 * nested beneath it, so a folder pattern excludes that folder's whole subtree
 * the way VS Code's own `files.exclude` does — callers can write either
 * `**​/node_modules` or `**​/node_modules/**` and get the same result.
 *
 * A malformed pattern (e.g. an unbalanced brace from a hand-edited setting)
 * compiles to a never-matching regex rather than throwing: a bad entry in a
 * user's settings should quietly do nothing, not break indexing entirely.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }

  let regex: RegExp;
  try {
    regex = new RegExp('^(?:' + globToRegExpSource(pattern) + ')(?:/.*)?$');
  } catch {
    regex = NEVER_MATCHES;
  }

  regexCache.set(pattern, regex);
  return regex;
}

/** True if `relativePath` (forward-slash separated) matches any pattern. */
export function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some(pattern => globToRegExp(pattern).test(relativePath));
}

/**
 * Combine patterns into a single glob for `findFiles`'s exclude parameter.
 *
 * Patterns containing braces or commas are left out: brace groups can't be
 * safely nested inside the `{a,b}` list this builds, and a stray comma would
 * split one pattern into two. They're still enforced — every indexed path is
 * checked against the full pattern list by matchesAnyGlob — so leaving them
 * out here only means their folders get walked during the scan and filtered
 * afterwards, rather than being skipped outright.
 */
export function buildFindFilesExclude(patterns: string[]): string | undefined {
  const safe = patterns.filter(p => !/[{},]/.test(p));
  if (safe.length === 0) {
    return undefined;
  }
  return safe.length === 1 ? safe[0] : '{' + safe.join(',') + '}';
}
