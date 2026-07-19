// @ts-nocheck
// Mermaid syntax highlighting — tokenizer + HTML builder.
//
// Drives the highlight overlay in the .mmd editor: a <pre> layer rendered
// underneath a transparent <textarea>. The textarea stays the real editing
// surface (the whole document-sync design in mermaidEditor.js depends on it
// being a real textarea), so this module only ever *reads* the source text
// and produces display HTML.
//
// Exposed as a UMD-style module so it can be loaded both by the webview
// (as a global `MermaidSyntax`) and by the Node test runner (via `require`).
(function (global) {
  'use strict';

  /** Diagram-type keywords — the first meaningful token of a mermaid file. */
  const DIAGRAM_KEYWORDS =
    'graph|flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|' +
    'journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|' +
    'C4Context|C4Container|C4Component|C4Dynamic|block-beta|sankey-beta|xychart-beta|' +
    'architecture-beta';

  /** Structural keywords shared across diagram types. */
  const STRUCTURAL_KEYWORDS =
    'subgraph|end|participant|actor|class|state|note|loop|alt|else|opt|par|and|rect|' +
    'activate|deactivate|autonumber|title|section|click|style|classDef|linkStyle|' +
    'direction|accTitle|accDescr';

  // One master regex. Alternation order is load-bearing: JavaScript alternation
  // is first-match-wins, not longest-match, so broader patterns must come after
  // the narrower ones they could otherwise swallow.
  //
  //   1 string   — before arrows, so "a --> b" inside quotes stays one string
  //   2 arrow    — before brackets, so `--o` isn't split into `--` + `o`
  //   3 label    — |edge label|
  //   4 bracket  — two-char node shapes before single chars
  //   5 diagram  — diagram-type keywords
  //   6 keyword  — structural keywords
  //   7 direction
  //   8 number
  const MASTER_RE = new RegExp(
    '("(?:[^"\\\\\\n]|\\\\.)*"?|`[^`\\n]*`?)' +
    '|((?:<{1,2}|[xo])?(?:={2,}|-+\\.+-+|-{2,}|~{3,})(?:>{1,2}|[xo)])?|->>?|-[x)])' +
    '|(\\|[^|\\n]*\\|)' +
    '|(\\(\\(|\\)\\)|\\[\\[|\\]\\]|\\[\\(|\\)\\]|\\{\\{|\\}\\}|\\(\\[|\\]\\)|[\\[\\](){}])' +
    '|\\b(' + DIAGRAM_KEYWORDS + ')\\b' +
    '|\\b(' + STRUCTURAL_KEYWORDS + ')\\b' +
    '|\\b(TD|TB|BT|RL|LR)\\b' +
    '|\\b(\\d+(?:\\.\\d+)?)\\b',
    'g'
  );

  // Capture-group index -> CSS class. Fixed whitelist: no user input ever
  // reaches a class name (see escapeHtml note in buildHighlightHtml).
  const GROUP_CLASSES = [
    null,            // 0 — full match
    'tok-string',    // 1
    'tok-arrow',     // 2
    'tok-label',     // 3
    'tok-bracket',   // 4
    'tok-diagram',   // 5
    'tok-keyword',   // 6
    'tok-direction', // 7
    'tok-number',    // 8
  ];

  /**
   * Tokenize a single line into [start, end, cssClass] triples covering only
   * the classified spans (gaps between them are plain text).
   *
   * Per-line rather than whole-document because (a) `%%` comments are
   * line-scoped, (b) it makes the error-line marking in mermaidEditor.js a
   * simple per-line lookup, and (c) the only common multi-line construct is
   * the `%%{init}%%` directive, carried across lines by `state.inDirective`.
   *
   * @param {string} line
   * @param {{inDirective: boolean}} state mutated across lines by the caller
   * @returns {Array<[number, number, string]>}
   */
  function tokenizeLine(line, state) {
    const tokens = [];
    let i = 0;

    // Continuation of a multi-line %%{ ... }%% directive.
    if (state.inDirective) {
      const close = line.indexOf('}%%');
      if (close === -1) {
        if (line.length > 0) tokens.push([0, line.length, 'tok-directive']);
        return tokens;
      }
      tokens.push([0, close + 3, 'tok-directive']);
      state.inDirective = false;
      i = close + 3;
    }

    const rest = line.slice(i);
    const lead = rest.match(/^\s*/)[0].length;
    const afterIndent = i + lead;

    if (line.startsWith('%%{', afterIndent)) {
      const close = line.indexOf('}%%', afterIndent);
      if (close === -1) {
        tokens.push([afterIndent, line.length, 'tok-directive']);
        state.inDirective = true;
        return tokens;
      }
      tokens.push([afterIndent, close + 3, 'tok-directive']);
      i = close + 3;
    } else if (line.startsWith('%%', afterIndent)) {
      // A plain `%%` comment runs to end of line.
      tokens.push([afterIndent, line.length, 'tok-comment']);
      return tokens;
    }

    MASTER_RE.lastIndex = i;
    let m;
    while ((m = MASTER_RE.exec(line)) !== null) {
      // Zero-length match guard — without this a pathological pattern could
      // spin forever on the same index.
      if (m[0] === '') {
        MASTER_RE.lastIndex++;
        continue;
      }
      for (let g = 1; g < GROUP_CLASSES.length; g++) {
        if (m[g] !== undefined) {
          tokens.push([m.index, m.index + m[0].length, GROUP_CLASSES[g]]);
          break;
        }
      }
    }
    return tokens;
  }

  /**
   * Escape text for safe insertion as HTML *text content*.
   * `&` must be replaced first, or the `&` introduced by a later replacement
   * would itself be double-escaped.
   */
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Build the highlight overlay's HTML for a whole document.
   *
   * Security: every byte of user text reaches the output through exactly one
   * path — `escapeHtml(raw)` — so it can neither open a tag nor close one of
   * ours. All markup is emitted by this function with class names drawn from
   * the fixed GROUP_CLASSES whitelist above; no user input is ever
   * interpolated into a tag or attribute. (Escape-then-wrap; the reverse
   * order would either destroy our own spans or require re-identifying user
   * text inside mixed markup, which is the classic XSS footgun.)
   *
   * Each line is wrapped in an inline span carrying its 1-based line number so
   * the error-line marker can find it. The newline lives *inside* the span so
   * `textContent` round-trips the source exactly.
   *
   * @param {string} source
   * @returns {string}
   */
  function buildHighlightHtml(source) {
    // Very large documents: skip colouring rather than stall the UI thread.
    // Correctness (and an accurate textContent round-trip) is preserved.
    if (source.length > 200000) {
      return escapeHtml(source) + '\n';
    }

    const lines = source.split('\n');
    const state = { inDirective: false };
    let out = '';

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      const tokens = tokenizeLine(line, state);
      let lineHtml = '';
      let pos = 0;

      for (const [start, end, cls] of tokens) {
        if (start > pos) lineHtml += escapeHtml(line.slice(pos, start));
        lineHtml += '<span class="' + cls + '">' + escapeHtml(line.slice(start, end)) + '</span>';
        pos = end;
      }
      if (pos < line.length) lineHtml += escapeHtml(line.slice(pos));

      out += '<span class="mmd-line" data-line="' + (n + 1) + '">' + lineHtml + '\n</span>';
    }

    // Note each line span already carries its own trailing newline — including
    // the last one, which the source itself doesn't have. That extra newline is
    // deliberate: a <pre> collapses a trailing empty line that the textarea
    // still shows, so without it their scrollHeights drift apart and the
    // overlay misaligns at the bottom of the document. Do NOT add another here.
    return out;
  }

  /**
   * Pull a 1-based source line number out of a mermaid parse error.
   *
   * Mermaid's jison-generated parsers throw an Error carrying a `.hash`
   * ({ line, loc: { first_line, ... } }); its message forms are
   * "Parse error on line N:" / "Lexical error on line N." Newer
   * langium-based diagram types (and UnknownDiagramError) may carry no line
   * at all — callers must handle null.
   *
   * @param {unknown} err
   * @param {string} source used only to clamp the result into range
   * @returns {number|null} 1-based line number, or null if none available
   */
  function extractErrorLine(err, source) {
    let line;
    const hash = err && err.hash;
    if (hash) {
      if (hash.loc && typeof hash.loc.first_line === 'number') {
        line = hash.loc.first_line; // already 1-based
      } else if (typeof hash.line === 'number') {
        line = hash.line + 1; // jison's yylineno is 0-based
      }
    }
    if (line === undefined) {
      const message = String((err && err.message) || err || '');
      const m = /(?:Parse error|Lexical error) on line (\d+)/.exec(message) ||
        /\bline\s+(\d+)/i.exec(message);
      if (m) line = parseInt(m[1], 10);
    }
    if (line === undefined || !isFinite(line)) return null;
    // Jison can report one past the last line at EOF.
    const max = source.split('\n').length;
    return Math.min(Math.max(1, line), max);
  }

  const api = { tokenizeLine, buildHighlightHtml, escapeHtml, extractErrorLine };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.MermaidSyntax = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
