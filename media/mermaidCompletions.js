// @ts-nocheck
// Mermaid authoring assistance: diagram templates, a context-aware snippet
// palette, and completion suggestions for the .mmd source pane.
//
// Pure data + string logic, deliberately free of DOM access so it can be
// unit tested by the Node test runner (same rationale as mermaidSyntax.js).
// The webview (media/mermaidEditor.js) owns all DOM and insertion.
//
// Exposed as a UMD-style module: a global `MermaidCompletions` in the
// webview, `require`-able in tests.
(function (global) {
  'use strict';

  // ============================================================
  // Diagram templates — the "blank page" problem
  // ============================================================
  // `${...}` marks the text to select after insertion so the user can type
  // straight over it (see applyPlaceholders below).
  const TEMPLATES = [
    {
      id: 'flowchart',
      label: 'Flowchart',
      description: 'Boxes and arrows, top-down',
      body:
        'flowchart TD\n' +
        '    A[${Start}] --> B{Decision?}\n' +
        '    B -->|Yes| C[Do the thing]\n' +
        '    B -->|No| D[Skip it]\n' +
        '    C --> E[Done]\n' +
        '    D --> E\n',
    },
    {
      id: 'sequence',
      label: 'Sequence diagram',
      description: 'Interactions between participants over time',
      body:
        'sequenceDiagram\n' +
        '    participant ${Client}\n' +
        '    participant Server\n' +
        '    Client->>Server: Request\n' +
        '    Server-->>Client: Response\n',
    },
    {
      id: 'class',
      label: 'Class diagram',
      description: 'Types, fields and relationships',
      body:
        'classDiagram\n' +
        '    class ${Animal} {\n' +
        '        +String name\n' +
        '        +move()\n' +
        '    }\n' +
        '    Animal <|-- Dog\n',
    },
    {
      id: 'state',
      label: 'State diagram',
      description: 'States and the transitions between them',
      body:
        'stateDiagram-v2\n' +
        '    [*] --> ${Idle}\n' +
        '    Idle --> Running: start\n' +
        '    Running --> Idle: stop\n' +
        '    Running --> [*]: exit\n',
    },
    {
      id: 'er',
      label: 'Entity relationship',
      description: 'Entities, keys and cardinality',
      body:
        'erDiagram\n' +
        '    ${CUSTOMER} ||--o{ ORDER : places\n' +
        '    ORDER ||--|{ LINE_ITEM : contains\n' +
        '    CUSTOMER {\n' +
        '        string name\n' +
        '        string email\n' +
        '    }\n',
    },
    {
      id: 'gantt',
      label: 'Gantt chart',
      description: 'Schedule with sections and tasks',
      body:
        'gantt\n' +
        '    title ${Project plan}\n' +
        '    dateFormat YYYY-MM-DD\n' +
        '    section Design\n' +
        '        Research      :a1, 2026-01-01, 7d\n' +
        '        Wireframes    :after a1, 5d\n' +
        '    section Build\n' +
        '        Implementation:2026-01-15, 14d\n',
    },
    {
      id: 'pie',
      label: 'Pie chart',
      description: 'Proportions of a whole',
      body:
        'pie title ${Distribution}\n' +
        '    "First"  : 45\n' +
        '    "Second" : 30\n' +
        '    "Third"  : 25\n',
    },
    {
      id: 'mindmap',
      label: 'Mind map',
      description: 'Hierarchical idea tree',
      body:
        'mindmap\n' +
        '  root((${Central idea}))\n' +
        '    Branch one\n' +
        '      Detail\n' +
        '    Branch two\n',
    },
  ];

  // ============================================================
  // Snippet palette — context-aware by diagram type
  // ============================================================
  const FLOWCHART_SNIPPETS = [
    { label: 'Box', title: 'Rectangular node', body: '${A}[Label]' },
    { label: 'Rounded', title: 'Rounded node', body: '${A}(Label)' },
    { label: 'Stadium', title: 'Stadium-shaped node', body: '${A}([Label])' },
    { label: 'Circle', title: 'Circular node', body: '${A}((Label))' },
    { label: 'Diamond', title: 'Decision node', body: '${A}{Label}' },
    { label: 'Hexagon', title: 'Hexagonal node', body: '${A}{{Label}}' },
    { label: 'Database', title: 'Cylinder node', body: '${A}[(Database)]' },
    { label: 'Arrow', title: 'Arrow link', body: ' --> ' },
    { label: 'Open', title: 'Open link (no arrowhead)', body: ' --- ' },
    { label: 'Dotted', title: 'Dotted link', body: ' -.-> ' },
    { label: 'Thick', title: 'Thick link', body: ' ==> ' },
    { label: 'Labelled', title: 'Link with a label', body: ' -->|${label}| ' },
    { label: 'Subgraph', title: 'Grouped section', body: 'subgraph ${Name}\n    \nend\n' },
  ];

  const SEQUENCE_SNIPPETS = [
    { label: 'Participant', title: 'Declare a participant', body: 'participant ${Name}\n' },
    { label: 'Actor', title: 'Declare an actor', body: 'actor ${Name}\n' },
    { label: 'Message', title: 'Solid arrow message', body: '${A}->>B: Message\n' },
    { label: 'Reply', title: 'Dashed reply', body: '${B}-->>A: Reply\n' },
    { label: 'Activate', title: 'Activation block', body: 'activate ${A}\n\ndeactivate A\n' },
    { label: 'Note', title: 'Note over participants', body: 'Note over ${A},B: Text\n' },
    { label: 'Loop', title: 'Loop block', body: 'loop ${Every minute}\n    \nend\n' },
    { label: 'Alt', title: 'Alternative paths', body: 'alt ${Condition}\n    \nelse Otherwise\n    \nend\n' },
    { label: 'Opt', title: 'Optional block', body: 'opt ${Condition}\n    \nend\n' },
    { label: 'Par', title: 'Parallel block', body: 'par ${Branch one}\n    \nand Branch two\n    \nend\n' },
  ];

  const CLASS_SNIPPETS = [
    { label: 'Class', title: 'Class with members', body: 'class ${Name} {\n    +String field\n    +method()\n}\n' },
    { label: 'Inherit', title: 'Inheritance', body: '${Base} <|-- Derived\n' },
    { label: 'Compose', title: 'Composition', body: '${Whole} *-- Part\n' },
    { label: 'Aggregate', title: 'Aggregation', body: '${Whole} o-- Part\n' },
    { label: 'Associate', title: 'Association', body: '${A} --> B\n' },
  ];

  const STATE_SNIPPETS = [
    { label: 'Start', title: 'Initial state', body: '[*] --> ${State}\n' },
    { label: 'End', title: 'Final state', body: '${State} --> [*]\n' },
    { label: 'Transition', title: 'Labelled transition', body: '${A} --> B: event\n' },
    { label: 'Composite', title: 'Nested state', body: 'state ${Name} {\n    [*] --> Inner\n}\n' },
    { label: 'Choice', title: 'Choice pseudo-state', body: 'state ${choice} <<choice>>\n' },
  ];

  const ER_SNIPPETS = [
    { label: 'Relation', title: 'One-to-many relationship', body: '${A} ||--o{ B : label\n' },
    { label: 'Entity', title: 'Entity with attributes', body: '${NAME} {\n    string field\n}\n' },
  ];

  const COMMON_SNIPPETS = [
    { label: 'Comment', title: 'Comment line', body: '%% ${note}\n' },
    { label: 'Title', title: 'Accessible title', body: 'accTitle: ${Title}\n' },
  ];

  const SNIPPETS_BY_TYPE = {
    flowchart: FLOWCHART_SNIPPETS,
    sequence: SEQUENCE_SNIPPETS,
    class: CLASS_SNIPPETS,
    state: STATE_SNIPPETS,
    er: ER_SNIPPETS,
  };

  /** Keywords offered by autocomplete, per diagram type. */
  const KEYWORDS_BY_TYPE = {
    flowchart: ['subgraph', 'end', 'direction', 'click', 'style', 'classDef', 'linkStyle'],
    sequence: ['participant', 'actor', 'activate', 'deactivate', 'loop', 'alt', 'else',
      'opt', 'par', 'and', 'rect', 'note', 'autonumber', 'end'],
    class: ['class', 'click', 'style', 'classDef', 'direction', 'note'],
    state: ['state', 'direction', 'note', 'end'],
    er: [],
    unknown: [],
  };

  const DIAGRAM_TYPES = [
    'flowchart TD', 'flowchart LR', 'graph TD', 'graph LR', 'sequenceDiagram',
    'classDiagram', 'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie',
    'gitGraph', 'mindmap', 'timeline', 'quadrantChart', 'requirementDiagram',
  ];

  const DIRECTIONS = ['TD', 'TB', 'BT', 'LR', 'RL'];

  const ARROWS = ['-->', '---', '-.->', '==>', '--x', '--o', '-->|label|'];

  /**
   * Identify the diagram type from the source, so the palette and completions
   * can be relevant. Reads the first non-blank, non-comment, non-directive
   * line — mermaid requires the diagram type to come first.
   *
   * @returns {'flowchart'|'sequence'|'class'|'state'|'er'|'unknown'}
   */
  function detectDiagramType(source) {
    const lines = String(source || '').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('%%')) continue; // comment or %%{init}%% directive
      if (/^(flowchart|graph)\b/.test(line)) return 'flowchart';
      if (/^sequenceDiagram\b/.test(line)) return 'sequence';
      if (/^classDiagram\b/.test(line)) return 'class';
      if (/^stateDiagram(-v2)?\b/.test(line)) return 'state';
      if (/^erDiagram\b/.test(line)) return 'er';
      return 'unknown';
    }
    return 'unknown';
  }

  /** Snippet palette appropriate to the current diagram type. */
  function getSnippets(source) {
    const type = detectDiagramType(source);
    return (SNIPPETS_BY_TYPE[type] || []).concat(COMMON_SNIPPETS);
  }

  /**
   * Scan the source for declared node/participant identifiers.
   *
   * This is what makes completion genuinely useful: a typo'd node id in
   * mermaid doesn't error, it silently creates a new orphan node, which is
   * the single most common authoring mistake.
   *
   * @returns {string[]} unique ids, in first-appearance order
   */
  function collectNodeIds(source) {
    const text = String(source || '');
    const ids = [];
    const seen = new Set();
    const add = (id) => {
      if (!id || seen.has(id)) return;
      // Filter out mermaid's own keywords so `end`/`subgraph` aren't offered
      // as if they were nodes.
      if (RESERVED.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('%%')) continue;

      // sequence: `participant Foo` / `actor Foo` (optionally `as Alias`)
      const participant = /^(?:participant|actor)\s+([A-Za-z0-9_-]+)/.exec(line);
      if (participant) { add(participant[1]); continue; }

      // class: `class Foo {`
      const cls = /^class\s+([A-Za-z0-9_-]+)/.exec(line);
      if (cls) { add(cls[1]); continue; }

      // subgraph: `subgraph Foo` — a valid link target in flowcharts
      const sub = /^subgraph\s+([A-Za-z0-9_-]+)/.exec(line);
      if (sub) { add(sub[1]); continue; }

      // flowchart node declarations: an id immediately followed by a shape
      // bracket, e.g. A[Label], B(Label), C{Label}, D((Label)).
      const shapeRe = /(^|[\s>|-])([A-Za-z_][A-Za-z0-9_-]*)\s*[[({]/g;
      let m;
      while ((m = shapeRe.exec(line)) !== null) add(m[2]);

      // Bare ids either side of a link operator, e.g. `A --> B`.
      const linkRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:--+>?|-\.->|==+>|--[xo]|->>|-->>)\s*([A-Za-z_][A-Za-z0-9_-]*)?/g;
      while ((m = linkRe.exec(line)) !== null) {
        add(m[1]);
        if (m[2]) add(m[2]);
      }
    }
    return ids;
  }

  const RESERVED = new Set([
    'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
    'erDiagram', 'journey', 'gantt', 'pie', 'gitGraph', 'mindmap', 'timeline',
    'subgraph', 'end', 'participant', 'actor', 'class', 'state', 'note', 'loop',
    'alt', 'else', 'opt', 'par', 'and', 'rect', 'activate', 'deactivate',
    'autonumber', 'title', 'section', 'click', 'style', 'classDef', 'linkStyle',
    'direction', 'accTitle', 'accDescr',
    'TD', 'TB', 'BT', 'LR', 'RL',
  ]);

  /**
   * Work out what to offer at the caret.
   *
   * @param {string} source full document text
   * @param {number} caret  caret offset into `source`
   * @returns {{items: Array<{label:string,detail?:string,kind:string}>, prefix: string, replaceFrom: number}}
   */
  function getCompletions(source, caret) {
    const text = String(source || '');
    const pos = Math.max(0, Math.min(caret, text.length));
    const before = text.slice(0, pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineSoFar = before.slice(lineStart);

    // The word being typed (letters/digits/_/- only), which is what a
    // selection replaces.
    const wordMatch = /([A-Za-z0-9_-]*)$/.exec(lineSoFar);
    const prefix = wordMatch ? wordMatch[1] : '';
    const replaceFrom = pos - prefix.length;

    const type = detectDiagramType(text);
    const isFirstMeaningfulLine = !/(^|\n)\s*(?!%%)\S/.test(before.slice(0, lineStart));

    let candidates = [];

    // Direction is checked BEFORE the first-line case: `flowchart ` is still
    // the first meaningful line, but at that caret the useful suggestion is a
    // direction, not another diagram type.
    if (/(?:^|\s)(?:graph|flowchart)\s+[A-Za-z]*$/.test(lineSoFar)) {
      candidates = DIRECTIONS.map((d) => ({ label: d, kind: 'direction', detail: 'direction' }));
    } else if (isFirstMeaningfulLine) {
      // Nothing declared yet — offer diagram types.
      candidates = DIAGRAM_TYPES.map((d) => ({ label: d, kind: 'diagram', detail: 'diagram type' }));
    } else if (endsWithLinkOperator(lineSoFar)) {
      // Right after an arrow — the target node is what's wanted here.
      candidates = collectNodeIds(text).map((id) => ({ label: id, kind: 'node', detail: 'node' }));
    } else {
      // General position: node ids first (most useful), then keywords, then
      // arrows when the line already has a node on it.
      candidates = collectNodeIds(text).map((id) => ({ label: id, kind: 'node', detail: 'node' }));
      for (const kw of KEYWORDS_BY_TYPE[type] || []) {
        candidates.push({ label: kw, kind: 'keyword', detail: 'keyword' });
      }
      if (type === 'flowchart' && /[A-Za-z0-9_\])}]\s*$/.test(lineSoFar)) {
        for (const a of ARROWS) candidates.push({ label: a, kind: 'arrow', detail: 'link' });
      }
    }

    const lower = prefix.toLowerCase();
    const items = prefix
      ? candidates.filter((c) => c.label.toLowerCase().startsWith(lower) && c.label !== prefix)
      : candidates;

    return { items: items.slice(0, 30), prefix, replaceFrom };
  }

  /** True if the text ends with a mermaid link/arrow operator (+ optional space). */
  function endsWithLinkOperator(text) {
    return /(?:--+>?|-\.->|==+>|--[xo]|->>|-->>|\|)\s*$/.test(text);
  }

  /**
   * Split a snippet body into the text to insert and the range to select.
   * `${...}` marks the placeholder; the braces are removed.
   *
   * @returns {{text: string, selectStart: number, selectEnd: number}}
   */
  function applyPlaceholders(body) {
    const src = String(body || '');
    const match = /\$\{([^}]*)\}/.exec(src);
    if (!match) {
      return { text: src, selectStart: src.length, selectEnd: src.length };
    }
    const text = src.slice(0, match.index) + match[1] + src.slice(match.index + match[0].length);
    return {
      text,
      selectStart: match.index,
      selectEnd: match.index + match[1].length,
    };
  }

  /**
   * Indentation to reuse when inserting on a fresh line, so snippets land
   * aligned with the surrounding block.
   */
  function currentIndent(source, caret) {
    const text = String(source || '');
    const pos = Math.max(0, Math.min(caret, text.length));
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const line = text.slice(lineStart, pos);
    const m = /^[ \t]*/.exec(line);
    return m ? m[0] : '';
  }

  const api = {
    TEMPLATES,
    detectDiagramType,
    getSnippets,
    collectNodeIds,
    getCompletions,
    applyPlaceholders,
    currentIndent,
    endsWithLinkOperator,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.MermaidCompletions = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
