/**
 * Shared wikilink parsing utilities.
 * Pure functions with no VS Code dependency.
 */

/** A single parsed wikilink occurrence within a file. */
export interface WikilinkOccurrence {
  /** Raw text inside [[...]] */
  raw: string;
  /** Target filename (without extension) */
  target: string;
  /** Optional display text after the pipe */
  displayText: string | undefined;
  /** Character offset of the opening [[ in the source text */
  offset: number;
  /** Total length including [[ and ]] */
  length: number;
  /** Line number (0-based) */
  line: number;
  /** Column (0-based) of the opening [[ */
  column: number;
}

/** Matches [[target]] and [[target|display text]] */
export const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;

/**
 * Compute fenced code block and inline code ranges in the text.
 * Returns an array of [start, end] ranges where wikilinks should be ignored.
 */
function computeCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced code blocks: ```...```
  const fencedRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  // Inline code: `...` (but not inside fenced blocks)
  const inlineRegex = /`[^`\n]+`/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Skip if inside a fenced block
    const insideFenced = ranges.some(([fs, fe]) => start >= fs && end <= fe);
    if (!insideFenced) {
      ranges.push([start, end]);
    }
  }

  return ranges;
}

/**
 * Check if an offset falls inside any code range.
 */
export function isInsideCodeBlock(text: string, offset: number): boolean {
  const ranges = computeCodeRanges(text);
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Extract all wikilinks from markdown text, skipping those inside code blocks.
 */
export function parseWikilinks(text: string): WikilinkOccurrence[] {
  const codeRanges = computeCodeRanges(text);
  const results: WikilinkOccurrence[] = [];

  // Precompute line starts for line/column calculation
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  const regex = new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const offset = match.index;

    // Skip if inside code
    const insideCode = codeRanges.some(([start, end]) => offset >= start && offset < end);
    if (insideCode) {
      continue;
    }

    // Binary search for line number
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const line = lo;
    const column = offset - lineStarts[line];

    const raw = match[1] + (match[2] !== undefined ? '|' + match[2] : '');
    const target = match[1].trim();
    const displayText = match[2]?.trim() || undefined;

    results.push({
      raw,
      target,
      displayText,
      offset,
      length: match[0].length,
      line,
      column,
    });
  }

  return results;
}

/**
 * Resolve a wikilink target to a workspace-relative path.
 * Case-insensitive lookup. Strips .md extension if the user typed it.
 */
export function resolveWikilinkTarget(
  target: string,
  stemToPath: Map<string, string>
): string | undefined {
  let normalized = target.trim().toLowerCase();
  // Strip .md extension if present
  if (normalized.endsWith('.md')) {
    normalized = normalized.slice(0, -3);
  }
  return stemToPath.get(normalized);
}

/**
 * Extract tags from text.
 * Looks for #tag patterns (not inside code blocks) and YAML frontmatter tags.
 */
export function parseTags(text: string): string[] {
  const tags = new Set<string>();
  const codeRanges = computeCodeRanges(text);

  // YAML frontmatter tags
  const frontmatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    // Simple tag extraction: look for "tags:" followed by list items or comma-separated values
    const tagsLineMatch = yaml.match(/^tags:\s*(.+)$/m);
    if (tagsLineMatch) {
      // Inline format: tags: tag1, tag2, tag3
      const inlineTags = tagsLineMatch[1].split(/[,\s]+/).filter(Boolean);
      for (const t of inlineTags) {
        const cleaned = t.replace(/^[\[#"\-]|[\]"]+$/g, '').trim();
        if (cleaned) {
          tags.add(cleaned);
        }
      }
    }
    // List format: - tag1 \n - tag2
    const listRegex = /^tags:\s*\r?\n((?:\s*-\s*.+\r?\n?)*)/m;
    const listMatch = yaml.match(listRegex);
    if (listMatch) {
      const items = listMatch[1].match(/-\s*(.+)/g);
      if (items) {
        for (const item of items) {
          const cleaned = item.replace(/^-\s*/, '').replace(/^["']|["']$/g, '').trim();
          if (cleaned) {
            tags.add(cleaned);
          }
        }
      }
    }
  }

  // Inline #tag patterns (not inside code, not in headings)
  const tagRegex = /(?:^|\s)#([a-zA-Z][\w-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const offset = match.index + match[0].indexOf('#');
    const insideCode = codeRanges.some(([start, end]) => offset >= start && offset < end);
    if (insideCode) {
      continue;
    }
    // Skip if this is a heading (# at start of line)
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const linePrefix = text.slice(lineStart, offset).trim();
    if (linePrefix === '' || linePrefix.match(/^#+$/)) {
      continue; // This is a heading marker, not a tag
    }
    tags.add(match[1]);
  }

  return Array.from(tags);
}
