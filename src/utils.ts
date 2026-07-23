import { randomBytes } from 'crypto';

/** Escape text for safe interpolation into HTML text content. */
export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Generate a random nonce for Content Security Policy in webviews.
 * Uses a cryptographically secure RNG, as the CSP spec requires — a
 * predictable nonce (e.g. Math.random) would weaken the policy.
 */
export function getNonce(): string {
  return randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
}

/**
 * Debounce a function call.
 */
export function debounce(fn: (...args: any[]) => any, delayMs: number): (...args: any[]) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = function (this: any, ...args: any[]) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn.apply(this, args);
    }, delayMs);
  };

  (debounced as any).cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}

/**
 * The Advancer mark, as inline SVG for a toolbar button.
 *
 * Inline rather than an <img> so it needs no `img-src` allowance and adds no
 * extra request; `currentColor` is deliberately avoided so the brand keeps its
 * colours in both light and dark themes.
 */
export function getBrandButtonHtml(): string {
  return /* html */ `<button id="btn-about" class="brand-button" title="About this extension" aria-label="About this extension">
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="advancerBrandGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#c084fc"/>
          <stop offset="55%" stop-color="#a855f7"/>
          <stop offset="100%" stop-color="#6b21a8"/>
        </linearGradient>
      </defs>
      <path fill="url(#advancerBrandGradient)" fill-rule="evenodd" clip-rule="evenodd"
            d="M12 2.5 L22 21 L2 21 Z M12 9.6 L16.1 17.2 L7.9 17.2 Z"/>
      <path fill="#581c87" d="M2 21 L6.6 12.5 L9.1 17.2 L7 21 Z"/>
    </svg>
  </button>`;
}

/**
 * Case-insensitively test whether a path (or URI fsPath) has a markdown
 * extension — `.md` or `.markdown`. The extension's customEditors selector
 * (package.json) claims both extensions, so anything gating markdown-only
 * behavior (wikilinks, the file index, graph, diff) must recognize both too.
 */
export function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

/**
 * Case-insensitively test whether a path (or URI fsPath) has a Mermaid
 * diagram extension — `.mmd` or `.mermaid`, matching the customEditors
 * selector for the diagram editor in package.json.
 */
export function isMermaidFile(filePath: string): boolean {
  return /\.(mmd|mermaid)$/i.test(filePath);
}

/**
 * Get the filename stem (without extension) from a path.
 */
export function getFileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx > 0 ? name.slice(0, dotIdx) : name;
}

/**
 * Compute the minimal single-range replacement that turns oldText into newText
 * by trimming the common prefix and suffix. Returns character offsets into
 * oldText: replace [start, end) with `text`.
 *
 * Used to apply webview edits as a small ranged edit instead of a whole-document
 * replace — preserving cursor/selection state in any parallel text editor and
 * keeping the undo stack granular.
 */
export function computeMinimalEdit(
  oldText: string,
  newText: string
): { start: number; end: number; text: string } {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  // The suffix must not overlap the already-matched prefix.
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  return { start, end: oldEnd, text: newText.slice(start, newEnd) };
}

/**
 * Strip Markdown syntax to produce plain text for LanguageTool.
 * Returns the stripped text and an offset map from stripped positions to original positions.
 */
export function stripMarkdownForChecking(markdown: string): { text: string; offsetMap: number[] } {
  // We'll walk through the markdown and build stripped text + offset map together.
  // The offset map stores: for each index in the stripped text, what is the
  // corresponding index in the original markdown.

  const stripped: string[] = [];
  const offsetMap: number[] = [];

  let i = 0;
  const len = markdown.length;

  // Skip YAML frontmatter (---...---)
  const frontmatterMatch = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (frontmatterMatch) {
    i = frontmatterMatch[0].length;
  }

  while (i < len) {
    // Fenced code blocks: ```...```
    if (markdown[i] === '`' && markdown.slice(i, i + 3) === '```') {
      const endIdx = markdown.indexOf('```', i + 3);
      if (endIdx !== -1) {
        i = endIdx + 3;
        continue;
      }
    }

    // Inline code: `...`
    if (markdown[i] === '`') {
      const endIdx = markdown.indexOf('`', i + 1);
      if (endIdx !== -1) {
        i = endIdx + 1;
        continue;
      }
    }

    // Images: ![alt](url)
    if (markdown[i] === '!' && markdown[i + 1] === '[') {
      const altEnd = markdown.indexOf(']', i + 2);
      if (altEnd !== -1 && markdown[altEnd + 1] === '(') {
        const urlEnd = markdown.indexOf(')', altEnd + 2);
        if (urlEnd !== -1) {
          // Keep the alt text
          for (let j = i + 2; j < altEnd; j++) {
            stripped.push(markdown[j]);
            offsetMap.push(j);
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Links: [text](url)
    if (markdown[i] === '[') {
      const textEnd = markdown.indexOf(']', i + 1);
      if (textEnd !== -1 && markdown[textEnd + 1] === '(') {
        const urlEnd = markdown.indexOf(')', textEnd + 2);
        if (urlEnd !== -1) {
          // Keep the link text
          for (let j = i + 1; j < textEnd; j++) {
            stripped.push(markdown[j]);
            offsetMap.push(j);
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Heading markers at start of line: # ## ### etc.
    if (markdown[i] === '#' && (i === 0 || markdown[i - 1] === '\n')) {
      let j = i;
      while (j < len && markdown[j] === '#') {
        j++;
      }
      if (j < len && markdown[j] === ' ') {
        i = j + 1; // skip past "### "
        continue;
      }
    }

    // Bold/italic markers: ** __ * _
    if ((markdown[i] === '*' || markdown[i] === '_')) {
      // Check for ** or __
      if (i + 1 < len && markdown[i + 1] === markdown[i]) {
        i += 2;
        continue;
      }
      // Single * or _ -- only skip if it looks like a markdown delimiter
      // (preceded/followed by non-space)
      const prev = i > 0 ? markdown[i - 1] : ' ';
      const next = i + 1 < len ? markdown[i + 1] : ' ';
      if (prev !== ' ' || next !== ' ') {
        i += 1;
        continue;
      }
    }

    // Blockquote markers at start of line: >
    if (markdown[i] === '>' && (i === 0 || markdown[i - 1] === '\n')) {
      i += 1;
      if (i < len && markdown[i] === ' ') {
        i += 1;
      }
      continue;
    }

    // Horizontal rules: ---, ***, ___
    if ((markdown[i] === '-' || markdown[i] === '*' || markdown[i] === '_') &&
        (i === 0 || markdown[i - 1] === '\n')) {
      let j = i;
      const ch = markdown[i];
      while (j < len && markdown[j] === ch) {
        j++;
      }
      if (j - i >= 3 && (j >= len || markdown[j] === '\n')) {
        i = j;
        continue;
      }
    }

    // Default: keep the character
    stripped.push(markdown[i]);
    offsetMap.push(i);
    i++;
  }

  return { text: stripped.join(''), offsetMap };
}
