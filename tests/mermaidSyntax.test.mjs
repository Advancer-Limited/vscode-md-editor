// Unit tests for the Mermaid syntax tokenizer (media/mermaidSyntax.js).
//
// The tokenizer output is assigned to innerHTML in the .mmd editor's highlight
// overlay, so the escaping tests here are security-critical, not cosmetic.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHighlightHtml, tokenizeLine, escapeHtml, extractErrorLine } =
  require('../media/mermaidSyntax.js');

/** Reverse escapeHtml. `&amp;` must be undone last, mirroring the escape order. */
function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Strip tags to recover the rendered text, as the DOM's textContent would. */
function renderedText(html) {
  return unescapeHtml(html.replace(/<[^>]*>/g, ''));
}

/**
 * Classes applied to a given substring, for asserting tokenization.
 * Token text is compared after unescaping, so callers pass the raw source
 * text (e.g. `-->`), not its escaped form (`--&gt;`).
 */
function classesFor(html, text) {
  const out = [];
  const re = /<span class="(tok-[a-z]+)">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (unescapeHtml(m[2]) === text) out.push(m[1]);
  }
  return out;
}

// ============================================================
// Round-trip invariant — the overlay must mirror the source exactly
// ============================================================

test('rendered text round-trips the source exactly (plus the layout newline)', () => {
  const sources = [
    'graph TD\nA[Start] --> B[End]',
    'flowchart LR\n  A --> B\n  B --> C',
    '',
    '\n\n\n',
    'sequenceDiagram\n  Alice->>John: Hello\n  John-->>Alice: Hi',
    'graph TD\n  A["quoted ] bracket"] --> B',
    '  \t indented\twith\ttabs',
  ];
  for (const src of sources) {
    assert.strictEqual(
      renderedText(buildHighlightHtml(src)),
      src + '\n',
      `round-trip failed for ${JSON.stringify(src)}`
    );
  }
});

test('trailing newline in source is preserved (scroll-height parity)', () => {
  assert.strictEqual(renderedText(buildHighlightHtml('graph TD\n')), 'graph TD\n\n');
});

// ============================================================
// Escaping / injection — security critical
// ============================================================

test('HTML metacharacters in the source are escaped, not emitted as markup', () => {
  const html = buildHighlightHtml('graph TD\n  A["<b>bold</b>"] --> B');
  assert.ok(!/<b>/.test(html), 'raw <b> tag leaked into the overlay HTML');
  assert.ok(html.includes('&lt;b&gt;'), 'expected escaped markup');
});

test('a script tag in a node label cannot break out of the overlay', () => {
  const attack = 'graph TD\n  A["</code><script>window.pwned=1</script>"] --> B';
  const html = buildHighlightHtml(attack);
  assert.ok(!/<script/i.test(html), 'unescaped <script> present in output');
  assert.ok(!/<\/code>/i.test(html), 'unescaped </code> could terminate the overlay element');
  assert.strictEqual(renderedText(html), attack + '\n');
});

test('an img/onerror payload is escaped', () => {
  const attack = 'graph TD\n  A --> B & <img src=x onerror=alert(1)>';
  const html = buildHighlightHtml(attack);
  assert.ok(!/<img/i.test(html), 'unescaped <img> present in output');
  assert.ok(html.includes('&lt;img'), 'expected escaped img tag');
});

test('ampersands are escaped once, not double-escaped', () => {
  // & must be replaced before < and >, or "&lt;" would become "&amp;lt;".
  assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  assert.strictEqual(escapeHtml('<a>'), '&lt;a&gt;');
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
  assert.strictEqual(renderedText(buildHighlightHtml('A & B')), 'A & B\n');
});

test('a quote character cannot escape a class attribute', () => {
  // Class names come from a fixed whitelist, never from user input — this
  // asserts the property rather than the implementation.
  const html = buildHighlightHtml('graph TD\n  A["\\" onload=x"] --> B');
  const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
  for (const cls of classAttrs) {
    assert.ok(
      /^(tok-[a-z]+|mmd-line)$/.test(cls),
      `unexpected class attribute value: ${JSON.stringify(cls)}`
    );
  }
});

// ============================================================
// Tokenization
// ============================================================

test('diagram-type keywords are tokenized', () => {
  assert.deepStrictEqual(classesFor(buildHighlightHtml('graph TD'), 'graph'), ['tok-diagram']);
  assert.deepStrictEqual(classesFor(buildHighlightHtml('flowchart LR'), 'flowchart'), ['tok-diagram']);
  assert.deepStrictEqual(
    classesFor(buildHighlightHtml('sequenceDiagram'), 'sequenceDiagram'),
    ['tok-diagram']
  );
  // stateDiagram-v2 must win over the shorter stateDiagram alternative.
  assert.deepStrictEqual(
    classesFor(buildHighlightHtml('stateDiagram-v2'), 'stateDiagram-v2'),
    ['tok-diagram']
  );
});

test('directions are tokenized', () => {
  for (const dir of ['TD', 'TB', 'BT', 'RL', 'LR']) {
    assert.deepStrictEqual(
      classesFor(buildHighlightHtml('graph ' + dir), dir),
      ['tok-direction'],
      `direction ${dir} not tokenized`
    );
  }
});

test('arrow forms are tokenized, longest-match-first', () => {
  const cases = ['-->', '---', '-.->', '==>', '--x', '--o', '~~~', '->>', '-->>', '<-->'];
  for (const arrow of cases) {
    const html = buildHighlightHtml('graph TD\n  A ' + arrow + ' B');
    assert.deepStrictEqual(
      classesFor(html, arrow),
      ['tok-arrow'],
      `arrow ${JSON.stringify(arrow)} was not tokenized as a single arrow token`
    );
  }
});

test('comments are tokenized and run to end of line', () => {
  const html = buildHighlightHtml('graph TD\n%% this --> is not an arrow\nA --> B');
  assert.deepStrictEqual(
    classesFor(html, '%% this --> is not an arrow'),
    ['tok-comment'],
    'comment did not consume the whole line'
  );
});

test('an indented comment is still a comment', () => {
  const html = buildHighlightHtml('graph TD\n    %% indented note');
  assert.deepStrictEqual(classesFor(html, '%% indented note'), ['tok-comment']);
});

test('arrows inside a quoted string are part of the string, not arrows', () => {
  const html = buildHighlightHtml('graph TD\n  A["a --> b"] --> B');
  assert.deepStrictEqual(classesFor(html, '"a --> b"'), ['tok-string']);
  // The real arrow outside the string is still tokenized.
  assert.ok(classesFor(html, '-->').includes('tok-arrow'));
});

test('edge labels are tokenized', () => {
  const html = buildHighlightHtml('graph TD\n  A -->|yes| B');
  assert.deepStrictEqual(classesFor(html, '|yes|'), ['tok-label']);
});

test('node-shape brackets are tokenized', () => {
  const html = buildHighlightHtml('graph TD\n  A[Box] --> B((Circle))');
  assert.ok(classesFor(html, '[').includes('tok-bracket'));
  assert.ok(classesFor(html, '((').includes('tok-bracket'));
});

test('structural keywords are tokenized', () => {
  const html = buildHighlightHtml('graph TD\n  subgraph one\n    A --> B\n  end');
  assert.deepStrictEqual(classesFor(html, 'subgraph'), ['tok-keyword']);
  assert.deepStrictEqual(classesFor(html, 'end'), ['tok-keyword']);
});

test('numbers are tokenized', () => {
  const html = buildHighlightHtml('pie\n  "A" : 42');
  assert.deepStrictEqual(classesFor(html, '42'), ['tok-number']);
});

test('%%{init}%% directives are tokenized, including across lines', () => {
  const single = buildHighlightHtml("%%{init: {'theme':'dark'}}%%\ngraph TD");
  assert.ok(/tok-directive/.test(single), 'single-line directive not tokenized');

  const multi = buildHighlightHtml("%%{init: {\n  'theme': 'dark'\n}}%%\ngraph TD");
  const directiveCount = (multi.match(/tok-directive/g) || []).length;
  assert.ok(directiveCount >= 2, 'multi-line directive should span multiple line spans');
  // The directive must close: `graph` after it is highlighted as a diagram keyword.
  assert.deepStrictEqual(classesFor(multi, 'graph'), ['tok-diagram']);
});

test('every line gets a numbered line span', () => {
  const html = buildHighlightHtml('graph TD\nA --> B\nB --> C');
  assert.ok(html.includes('data-line="1"'));
  assert.ok(html.includes('data-line="2"'));
  assert.ok(html.includes('data-line="3"'));
});

test('tokenizeLine never loops forever on odd input', () => {
  const state = { inDirective: false };
  // Just needs to terminate.
  for (const line of ['', '   ', '%%', '%%{', '}%%', '-', '"', '|', '[[', '((((']) {
    assert.doesNotThrow(() => tokenizeLine(line, state));
  }
});

test('very large documents fall back to plain escaped text but still round-trip', () => {
  const big = 'graph TD\n' + 'A --> B\n'.repeat(30000);
  assert.ok(big.length > 200000, 'fixture should exceed the size threshold');
  const html = buildHighlightHtml(big);
  assert.ok(!html.includes('tok-'), 'expected the unstyled fallback for a very large document');
  assert.strictEqual(renderedText(html), big + '\n');
});

// ============================================================
// Error line extraction
// ============================================================

test('extracts a line number from a jison hash with loc (1-based)', () => {
  const err = { message: 'boom', hash: { loc: { first_line: 3 } } };
  assert.strictEqual(extractErrorLine(err, 'a\nb\nc\nd'), 3);
});

test('extracts a line number from a jison hash line (0-based)', () => {
  const err = { message: 'boom', hash: { line: 2 } };
  assert.strictEqual(extractErrorLine(err, 'a\nb\nc\nd'), 3);
});

test('falls back to parsing the message text', () => {
  assert.strictEqual(
    extractErrorLine(new Error('Parse error on line 2:\n...'), 'a\nb\nc'),
    2
  );
  assert.strictEqual(
    extractErrorLine(new Error('Lexical error on line 3. Unrecognized text.'), 'a\nb\nc'),
    3
  );
});

test('returns null when no line information is available', () => {
  assert.strictEqual(
    extractErrorLine(new Error('No diagram type detected matching given configuration'), 'a\nb'),
    null
  );
  assert.strictEqual(extractErrorLine(null, 'a\nb'), null);
  assert.strictEqual(extractErrorLine(undefined, 'a\nb'), null);
});

test('clamps an out-of-range line into the document', () => {
  // Jison can report one past the last line at EOF.
  assert.strictEqual(extractErrorLine({ hash: { loc: { first_line: 99 } } }, 'a\nb\nc'), 3);
  assert.strictEqual(extractErrorLine({ hash: { loc: { first_line: 0 } } }, 'a\nb\nc'), 1);
});
