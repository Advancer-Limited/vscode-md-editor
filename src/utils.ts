/**
 * Generate a random nonce for Content Security Policy in webviews.
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
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
 * Get the filename stem (without extension) from a path.
 */
export function getFileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx > 0 ? name.slice(0, dotIdx) : name;
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
