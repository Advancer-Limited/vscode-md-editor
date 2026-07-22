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
  // straight over it (see applyPlaceholders below). All example content is
  // deliberately generic ("Box 1", "Task 2", "Entity 1") rather than
  // domain-flavored — obviously placeholder text meant to be edited, not
  // content a user might mistake for something real and leave in place.
  //
  // Every template here has been verified to parse cleanly against the
  // vendored mermaid build (mermaid.parse(), not just eyeballed syntax) —
  // several needed quoted identifiers for multi-word names that mermaid's
  // grammar doesn't accept unquoted (sequence participants, ER entities,
  // state names). Ordered with the five daily-use types teams reach for most
  // (flowchart, sequence, class, ER, state) first, then other common types,
  // then more specialized ones.
  const TEMPLATES = [
    {
      id: 'flowchart',
      label: 'Flowchart',
      description: 'Boxes and arrows, top-down',
      body:
        'flowchart TD\n' +
        '    A[${Box 1}] --> B{Decision?}\n' +
        '    B -->|Yes| C[Box 2]\n' +
        '    B -->|No| D[Box 3]\n' +
        '    C --> E[Box 4]\n' +
        '    D --> E\n',
    },
    {
      id: 'sequence',
      label: 'Sequence diagram',
      description: 'Interactions between participants over time',
      body:
        'sequenceDiagram\n' +
        '    participant A1 as ${Actor 1}\n' +
        '    participant A2 as Actor 2\n' +
        '    A1->>A2: Message 1\n' +
        '    A2-->>A1: Message 2\n',
    },
    {
      id: 'class',
      label: 'Class diagram',
      description: 'Types, fields and relationships',
      body:
        'classDiagram\n' +
        '    class ${Class1} {\n' +
        '        +field1\n' +
        '        +method1()\n' +
        '    }\n' +
        '    class Class2\n' +
        '    Class1 <|-- Class2\n',
    },
    {
      id: 'er',
      label: 'Entity relationship',
      description: 'Entities, keys and cardinality',
      body:
        'erDiagram\n' +
        '    "${Entity 1}" ||--o{ "Entity 2" : relates\n' +
        '    "Entity 2" ||--|{ "Entity 3" : contains\n' +
        '    "Entity 2" {\n' +
        '        string field1\n' +
        '        string field2\n' +
        '    }\n',
    },
    {
      id: 'state',
      label: 'State diagram',
      description: 'States and the transitions between them',
      body:
        'stateDiagram-v2\n' +
        '    [*] --> s1\n' +
        '    state "${State 1}" as s1\n' +
        '    state "State 2" as s2\n' +
        '    s1 --> s2: event 1\n' +
        '    s2 --> s1: event 2\n' +
        '    s2 --> [*]: event 3\n',
    },
    {
      id: 'gantt',
      label: 'Gantt chart',
      description: 'Schedule with sections and tasks',
      body:
        'gantt\n' +
        '    title ${Project plan}\n' +
        '    dateFormat YYYY-MM-DD\n' +
        '    section Section 1\n' +
        '        Task 1      :a1, 2026-01-01, 7d\n' +
        '        Task 2      :after a1, 5d\n' +
        '    section Section 2\n' +
        '        Task 3      :2026-01-15, 14d\n',
    },
    {
      id: 'pie',
      label: 'Pie chart',
      description: 'Proportions of a whole',
      body:
        'pie title ${Distribution}\n' +
        '    "Item 1" : 45\n' +
        '    "Item 2" : 30\n' +
        '    "Item 3" : 25\n',
    },
    {
      id: 'mindmap',
      label: 'Mind map',
      description: 'Hierarchical idea tree',
      body:
        'mindmap\n' +
        '  root((${Central idea}))\n' +
        '    Branch 1\n' +
        '      Detail 1\n' +
        '    Branch 2\n' +
        '      Detail 2\n',
    },
    {
      id: 'journey',
      label: 'User journey',
      description: 'Steps and satisfaction across a process',
      body:
        'journey\n' +
        '    title ${My journey}\n' +
        '    section Section 1\n' +
        '      Step 1: 5: User\n' +
        '      Step 2: 3: User\n' +
        '    section Section 2\n' +
        '      Step 3: 5: User\n' +
        '      Step 4: 4: User\n',
    },
    {
      id: 'gitgraph',
      label: 'Git graph',
      description: 'Commits, branches and merges',
      body:
        'gitGraph\n' +
        '    commit\n' +
        '    branch feature-branch\n' +
        '    checkout feature-branch\n' +
        '    commit tag: "${v1.0}"\n' +
        '    commit\n' +
        '    checkout main\n' +
        '    merge feature-branch\n' +
        '    commit\n',
    },
    {
      id: 'kanban',
      label: 'Kanban board',
      description: 'Columns of tickets',
      body:
        'kanban\n' +
        '    Column 1\n' +
        '        [${Task 1}]\n' +
        '        [Task 2]\n' +
        '    Column 2\n' +
        '        [Task 3]\n' +
        '    Column 3\n' +
        '        [Task 4]\n',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      description: 'Chronological events',
      body:
        'timeline\n' +
        '    title ${My timeline}\n' +
        '    2023 : Event 1\n' +
        '    2024 : Event 2\n' +
        '    2025 : Event 3\n' +
        '    2026 : Event 4\n',
    },
    {
      id: 'quadrant',
      label: 'Quadrant chart',
      description: 'Plot items across two axes',
      body:
        'quadrantChart\n' +
        '    title ${Quadrant chart}\n' +
        '    x-axis Low --> High\n' +
        '    y-axis Low --> High\n' +
        '    quadrant-1 Quadrant 1\n' +
        '    quadrant-2 Quadrant 2\n' +
        '    quadrant-3 Quadrant 3\n' +
        '    quadrant-4 Quadrant 4\n' +
        '    Item 1: [0.3, 0.6]\n' +
        '    Item 2: [0.45, 0.23]\n',
    },
    {
      id: 'requirement',
      label: 'Requirement diagram',
      description: 'Requirements and satisfying elements',
      body:
        'requirementDiagram\n' +
        '    requirement requirement_1 {\n' +
        '    id: 1\n' +
        '    text: "${Requirement text.}"\n' +
        '    risk: medium\n' +
        '    verifymethod: test\n' +
        '    }\n' +
        '    element element_1 {\n' +
        '    type: simulation\n' +
        '    }\n' +
        '    element_1 - satisfies -> requirement_1\n',
    },
    {
      id: 'c4context',
      label: 'C4 context diagram',
      description: 'System context — actors and systems',
      body:
        'C4Context\n' +
        '    title ${System context diagram}\n' +
        '    Person(person1, "Person 1", "A user of the system.")\n' +
        '    System(system1, "System 1", "Does the main thing.")\n' +
        '    Rel(person1, system1, "Uses")\n',
    },
    {
      id: 'block',
      label: 'Block diagram',
      description: 'Simple connected blocks',
      body:
        'block-beta\n' +
        '    columns 3\n' +
        '    a["${Block 1}"] b["Block 2"] c["Block 3"]\n' +
        '    a --> b\n' +
        '    b --> c\n',
    },
    {
      id: 'sankey',
      label: 'Sankey diagram',
      description: 'Flow quantities between nodes',
      body:
        'sankey-beta\n' +
        '\n' +
        'Source 1,Target 1,45\n' +
        'Source 1,${Target 2},35\n' +
        'Source 2,Target 1,20\n',
    },
    {
      id: 'xychart',
      label: 'XY chart',
      description: 'Bar and line chart over categories',
      body:
        'xychart-beta\n' +
        '    title "${XY chart}"\n' +
        '    x-axis [Category 1, Category 2, Category 3, Category 4]\n' +
        '    y-axis "Value" 0 --> 100\n' +
        '    bar [50, 60, 75, 82]\n' +
        '    line [50, 60, 75, 82]\n',
    },
    {
      id: 'radar',
      label: 'Radar chart',
      description: 'Multi-axis comparison',
      body:
        'radar-beta\n' +
        '    title ${Radar chart}\n' +
        '    axis axis1, axis2, axis3, axis4, axis5\n' +
        '    curve curve1["Item 1"]{85, 90, 70, 60, 75}\n',
    },
    {
      id: 'packet',
      label: 'Packet diagram',
      description: 'Byte-level protocol layout',
      body:
        'packet-beta\n' +
        'title ${Packet diagram}\n' +
        '0-7: "Field 1"\n' +
        '8-15: "Field 2"\n' +
        '16-31: "Field 3"\n',
    },
    {
      id: 'architecture',
      label: 'Architecture diagram',
      description: 'Services, groups and connections',
      body:
        'architecture-beta\n' +
        '    group group1(cloud)[${Group 1}]\n' +
        '    service service1(database)[Service 1] in group1\n' +
        '    service service2(server)[Service 2] in group1\n' +
        '    service2:R -- L:service1\n',
    },
    {
      id: 'treemap',
      label: 'Treemap',
      description: 'Nested proportional rectangles',
      body:
        'treemap-beta\n' +
        '"${Category 1}"\n' +
        '    "Subcategory 1"\n' +
        '        "Item 1": 40\n' +
        '        "Item 2": 30\n' +
        '    "Subcategory 2"\n' +
        '        "Item 3": 20\n' +
        '        "Item 4": 10\n',
    },
  ];

  // ============================================================
  // Snippet palette — context-aware by diagram type
  //
  // `icon` is inner SVG markup (no <svg> wrapper) rendered by the webview
  // inside a shared viewBox="0 0 16 16" element that supplies
  // fill="none" stroke="currentColor" — child shapes inherit that, so only
  // filled glyphs (a composition diamond, a state's initial/final dot) need
  // to set their own fill. This keeps the palette buttons small icon
  // buttons rather than words, with the label+title as the hover tooltip,
  // so the toolbar fits on one line instead of wrapping.
  // ============================================================
  const FLOWCHART_SNIPPETS = [
    { label: 'Box', title: 'Rectangular node', icon: '<rect x="2" y="4" width="12" height="8"/>', body: '${A}[Label]' },
    { label: 'Rounded', title: 'Rounded node', icon: '<rect x="2" y="4" width="12" height="8" rx="3"/>', body: '${A}(Label)' },
    { label: 'Stadium', title: 'Stadium-shaped node', icon: '<rect x="2" y="5" width="12" height="6" rx="3"/>', body: '${A}([Label])' },
    { label: 'Circle', title: 'Circular node', icon: '<circle cx="8" cy="8" r="6"/>', body: '${A}((Label))' },
    { label: 'Diamond', title: 'Decision node', icon: '<path d="M8 2 L14 8 L8 14 L2 8 Z"/>', body: '${A}{Label}' },
    { label: 'Hexagon', title: 'Hexagonal node', icon: '<path d="M4.5 3 H11.5 L14 8 L11.5 13 H4.5 L2 8 Z"/>', body: '${A}{{Label}}' },
    { label: 'Database', title: 'Cylinder node', icon: '<path d="M2 5c0-1.1 2.7-2 6-2s6 .9 6 2v6c0 1.1-2.7 2-6 2s-6-.9-6-2V5z"/><path d="M2 5c0 1.1 2.7 2 6 2s6-.9 6-2"/>', body: '${A}[(Database)]' },
    { label: 'Arrow', title: 'Arrow link', icon: '<line x1="1.5" y1="8" x2="12" y2="8"/><path d="M9.5 5 L13 8 L9.5 11"/>', body: ' --> ' },
    { label: 'Open', title: 'Open link (no arrowhead)', icon: '<line x1="1.5" y1="8" x2="14.5" y2="8"/>', body: ' --- ' },
    { label: 'Dotted', title: 'Dotted link', icon: '<line x1="1.5" y1="8" x2="12" y2="8" stroke-dasharray="2.2 2.2"/><path d="M9.5 5 L13 8 L9.5 11"/>', body: ' -.-> ' },
    { label: 'Thick', title: 'Thick link', icon: '<line x1="1.5" y1="8" x2="11.5" y2="8" stroke-width="3"/><path d="M9 5 L13.5 8 L9 11"/>', body: ' ==> ' },
    { label: 'Labelled', title: 'Link with a label', icon: '<rect x="4" y="2" width="6" height="4" rx="1"/><line x1="1.5" y1="10" x2="12" y2="10"/><path d="M9.5 7 L13 10 L9.5 13"/>', body: ' -->|${label}| ' },
    { label: 'Subgraph', title: 'Grouped section', icon: '<rect x="2" y="3" width="12" height="10" rx="2" stroke-dasharray="2 2"/>', body: 'subgraph ${Name}\n    \nend\n' },
  ];

  const SEQUENCE_SNIPPETS = [
    { label: 'Participant', title: 'Declare a participant', icon: '<rect x="3" y="2" width="10" height="4" rx="1"/><line x1="8" y1="6" x2="8" y2="14" stroke-dasharray="1.6 1.6"/>', body: 'participant ${Name}\n' },
    { label: 'Actor', title: 'Declare an actor', icon: '<circle cx="8" cy="4" r="2"/><line x1="8" y1="6" x2="8" y2="11"/><line x1="4.5" y1="8.5" x2="11.5" y2="8.5"/><line x1="8" y1="11" x2="5" y2="14"/><line x1="8" y1="11" x2="11" y2="14"/>', body: 'actor ${Name}\n' },
    { label: 'Message', title: 'Solid arrow message', icon: '<line x1="1.5" y1="8" x2="12" y2="8"/><path d="M9.5 5 L13 8 L9.5 11"/>', body: '${A}->>B: Message\n' },
    { label: 'Reply', title: 'Dashed reply', icon: '<line x1="3.5" y1="8" x2="14.5" y2="8" stroke-dasharray="2.2 2.2"/><path d="M6.5 5 L3 8 L6.5 11"/>', body: '${B}-->>A: Reply\n' },
    { label: 'Activate', title: 'Activation block', icon: '<rect x="6.5" y="2" width="3" height="12"/>', body: 'activate ${A}\n\ndeactivate A\n' },
    { label: 'Note', title: 'Note over participants', icon: '<path d="M2 2 H10 L14 6 V14 H2 Z"/><path d="M10 2 V6 H14"/>', body: 'Note over ${A},B: Text\n' },
    { label: 'Loop', title: 'Loop block', icon: '<path d="M12.6 6.4A5 5 0 1 0 13 9"/><path d="M13 3.4 V6.6 H9.8"/>', body: 'loop ${Every minute}\n    \nend\n' },
    { label: 'Alt', title: 'Alternative paths', icon: '<path d="M2 8 H6 M6 8 L11 4 M6 8 L11 12 M11 4 H14 M11 12 H14"/>', body: 'alt ${Condition}\n    \nelse Otherwise\n    \nend\n' },
    { label: 'Opt', title: 'Optional block', icon: '<rect x="5" y="3" width="9" height="10" rx="2" stroke-dasharray="2 2"/><line x1="1" y1="8" x2="5" y2="8"/>', body: 'opt ${Condition}\n    \nend\n' },
    { label: 'Par', title: 'Parallel block', icon: '<line x1="1.5" y1="5" x2="12" y2="5"/><path d="M9.5 3 L13 5 L9.5 7"/><line x1="1.5" y1="11" x2="12" y2="11"/><path d="M9.5 9 L13 11 L9.5 13"/>', body: 'par ${Branch one}\n    \nand Branch two\n    \nend\n' },
  ];

  const CLASS_SNIPPETS = [
    { label: 'Class', title: 'Class with members', icon: '<rect x="2" y="2" width="12" height="12"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="9" x2="14" y2="9"/>', body: 'class ${Name} {\n    +String field\n    +method()\n}\n' },
    { label: 'Inherit', title: 'Inheritance', icon: '<line x1="8" y1="14" x2="8" y2="6.5"/><path d="M8 2 L11 7 H5 Z"/>', body: '${Base} <|-- Derived\n' },
    { label: 'Compose', title: 'Composition', icon: '<line x1="7" y1="8" x2="14" y2="8"/><path d="M2 8 L5 5.5 L8 8 L5 10.5 Z" fill="currentColor" stroke="none"/>', body: '${Whole} *-- Part\n' },
    { label: 'Aggregate', title: 'Aggregation', icon: '<line x1="7" y1="8" x2="14" y2="8"/><path d="M2 8 L5 5.5 L8 8 L5 10.5 Z"/>', body: '${Whole} o-- Part\n' },
    { label: 'Associate', title: 'Association', icon: '<line x1="1.5" y1="8" x2="12" y2="8"/><path d="M9.5 5 L13 8 L9.5 11"/>', body: '${A} --> B\n' },
  ];

  const STATE_SNIPPETS = [
    { label: 'Start', title: 'Initial state', icon: '<circle cx="3" cy="8" r="2" fill="currentColor" stroke="none"/><line x1="5.5" y1="8" x2="10" y2="8"/><path d="M8 5.5 L11 8 L8 10.5"/>', body: '[*] --> ${State}\n' },
    { label: 'End', title: 'Final state', icon: '<line x1="1.5" y1="8" x2="7.5" y2="8"/><path d="M5.5 5.5 L8.5 8 L5.5 10.5"/><circle cx="12" cy="8" r="2.6"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>', body: '${State} --> [*]\n' },
    { label: 'Transition', title: 'Labelled transition', icon: '<rect x="1.5" y="5.5" width="4.5" height="5" rx="1.2"/><rect x="10" y="5.5" width="4.5" height="5" rx="1.2"/><line x1="6" y1="8" x2="9.5" y2="8"/><path d="M8 6 L10 8 L8 10"/>', body: '${A} --> B: event\n' },
    { label: 'Composite', title: 'Nested state', icon: '<rect x="1.5" y="2" width="13" height="12" rx="1.5"/><rect x="4" y="5" width="8" height="6" rx="1" stroke-dasharray="1.6 1.6"/>', body: 'state ${Name} {\n    [*] --> Inner\n}\n' },
    { label: 'Choice', title: 'Choice pseudo-state', icon: '<path d="M8 2 L14 8 L8 14 L2 8 Z"/>', body: 'state ${choice} <<choice>>\n' },
  ];

  const ER_SNIPPETS = [
    { label: 'Relation', title: 'One-to-many relationship', icon: '<line x1="2" y1="8" x2="9" y2="8"/><path d="M9 8 L14 5 M9 8 L14 8 M9 8 L14 11"/>', body: '${A} ||--o{ B : label\n' },
    { label: 'Entity', title: 'Entity with attributes', icon: '<rect x="2" y="2" width="12" height="12"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="2" y1="10" x2="14" y2="10"/>', body: '${NAME} {\n    string field\n}\n' },
  ];

  const COMMON_SNIPPETS = [
    { label: 'Comment', title: 'Comment line', icon: '<path d="M2 3 H14 V10 H6 L3 13 V10 H2 Z"/>', body: '%% ${note}\n' },
    { label: 'Title', title: 'Accessible title', icon: '<path d="M3 3 H13 M8 3 V13"/>', body: 'accTitle: ${Title}\n' },
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
    'kanban', 'C4Context', 'block-beta', 'sankey-beta', 'xychart-beta',
    'radar-beta', 'packet-beta', 'architecture-beta', 'treemap-beta',
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
