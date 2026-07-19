// Unit tests for the Mermaid authoring-assistance module
// (media/mermaidCompletions.js): diagram-type detection, the context-aware
// snippet palette, node-id scanning, and completion suggestions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TEMPLATES,
  detectDiagramType,
  getSnippets,
  collectNodeIds,
  getCompletions,
  applyPlaceholders,
  currentIndent,
} = require('../media/mermaidCompletions.js');

/** Completion labels at a caret placed at the end of `source`. */
function labelsAtEnd(source) {
  return getCompletions(source, source.length).items.map((i) => i.label);
}

// ============================================================
// Diagram type detection
// ============================================================

test('detects each supported diagram type', () => {
  assert.strictEqual(detectDiagramType('flowchart TD\nA --> B'), 'flowchart');
  assert.strictEqual(detectDiagramType('graph LR\nA --> B'), 'flowchart');
  assert.strictEqual(detectDiagramType('sequenceDiagram\nA->>B: hi'), 'sequence');
  assert.strictEqual(detectDiagramType('classDiagram\nclass Foo'), 'class');
  assert.strictEqual(detectDiagramType('stateDiagram-v2\n[*] --> A'), 'state');
  assert.strictEqual(detectDiagramType('stateDiagram\n[*] --> A'), 'state');
  assert.strictEqual(detectDiagramType('erDiagram\nA ||--o{ B : x'), 'er');
});

test('detection skips blank lines, comments and init directives', () => {
  assert.strictEqual(
    detectDiagramType("%%{init: {'theme':'dark'}}%%\n\n%% a note\nflowchart TD\nA --> B"),
    'flowchart'
  );
});

test('detection returns unknown for empty or unrecognized sources', () => {
  assert.strictEqual(detectDiagramType(''), 'unknown');
  assert.strictEqual(detectDiagramType('\n\n  \n'), 'unknown');
  assert.strictEqual(detectDiagramType('gantt\ntitle X'), 'unknown'); // no palette yet
  assert.strictEqual(detectDiagramType(undefined), 'unknown');
});

// ============================================================
// Snippet palette
// ============================================================

test('palette is context-aware by diagram type', () => {
  const flow = getSnippets('flowchart TD\n').map((s) => s.label);
  assert.ok(flow.includes('Diamond'), 'flowchart palette should offer node shapes');
  assert.ok(flow.includes('Subgraph'));
  assert.ok(!flow.includes('Participant'), 'flowchart palette should not offer sequence snippets');

  const seq = getSnippets('sequenceDiagram\n').map((s) => s.label);
  assert.ok(seq.includes('Participant'));
  assert.ok(seq.includes('Loop'));
  assert.ok(!seq.includes('Diamond'));
});

test('common snippets are always offered', () => {
  for (const src of ['flowchart TD\n', 'sequenceDiagram\n', 'classDiagram\n', '']) {
    const labels = getSnippets(src).map((s) => s.label);
    assert.ok(labels.includes('Comment'), `Comment missing for ${JSON.stringify(src)}`);
  }
});

test('every snippet and template has a non-empty body', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id && t.label && t.body.length > 0, `bad template ${t.id}`);
  }
  for (const src of ['flowchart TD', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram']) {
    for (const s of getSnippets(src)) {
      assert.ok(s.label && s.body.length > 0, `bad snippet ${s.label}`);
    }
  }
});

test('every template body starts with its own diagram type', () => {
  // A template that doesn't declare a diagram type would produce an
  // unparseable document when inserted into an empty file.
  const expectations = {
    flowchart: /^flowchart /, sequence: /^sequenceDiagram/, class: /^classDiagram/,
    state: /^stateDiagram-v2/, er: /^erDiagram/, gantt: /^gantt/, pie: /^pie /,
    mindmap: /^mindmap/,
  };
  for (const t of TEMPLATES) {
    const re = expectations[t.id];
    assert.ok(re, `no expectation registered for template ${t.id}`);
    assert.match(applyPlaceholders(t.body).text, re, `template ${t.id}`);
  }
});

// ============================================================
// Placeholders
// ============================================================

test('applyPlaceholders strips the marker and selects the placeholder text', () => {
  const r = applyPlaceholders('${A}[Label]');
  assert.strictEqual(r.text, 'A[Label]');
  assert.strictEqual(r.text.slice(r.selectStart, r.selectEnd), 'A');
});

test('applyPlaceholders handles a body with no placeholder', () => {
  const r = applyPlaceholders(' --> ');
  assert.strictEqual(r.text, ' --> ');
  assert.strictEqual(r.selectStart, r.text.length);
  assert.strictEqual(r.selectEnd, r.text.length);
});

test('applyPlaceholders handles multi-line bodies', () => {
  const r = applyPlaceholders('subgraph ${Name}\n    \nend\n');
  assert.strictEqual(r.text, 'subgraph Name\n    \nend\n');
  assert.strictEqual(r.text.slice(r.selectStart, r.selectEnd), 'Name');
});

// ============================================================
// Node id scanning
// ============================================================

test('collects flowchart node ids from shapes and links', () => {
  const ids = collectNodeIds('flowchart TD\n  A[Start] --> B{Choice}\n  B --> C\n  D((Round))');
  for (const id of ['A', 'B', 'C', 'D']) {
    assert.ok(ids.includes(id), `missing ${id} in ${JSON.stringify(ids)}`);
  }
});

test('collects sequence participants and actors', () => {
  const ids = collectNodeIds('sequenceDiagram\n  participant Client\n  actor User\n  Client->>User: hi');
  assert.ok(ids.includes('Client'));
  assert.ok(ids.includes('User'));
});

test('collects class names and subgraph names', () => {
  assert.ok(collectNodeIds('classDiagram\n  class Animal {\n  }\n').includes('Animal'));
  assert.ok(collectNodeIds('flowchart TD\n  subgraph Platform\n    A --> B\n  end').includes('Platform'));
});

test('node ids exclude mermaid keywords', () => {
  const ids = collectNodeIds('flowchart TD\n  subgraph Group\n    A --> B\n  end\n  B --> C');
  for (const kw of ['subgraph', 'end', 'flowchart', 'TD']) {
    assert.ok(!ids.includes(kw), `keyword ${kw} should not be a node id`);
  }
});

test('node ids are unique and in first-appearance order', () => {
  const ids = collectNodeIds('flowchart TD\n  B --> A\n  A --> B\n  A --> C');
  assert.deepStrictEqual(ids, ['B', 'A', 'C']);
});

test('comment lines are not scanned for node ids', () => {
  const ids = collectNodeIds('flowchart TD\n  %% GHOST[Not real] --> ALSOGHOST\n  A --> B');
  assert.ok(!ids.includes('GHOST'));
  assert.ok(!ids.includes('ALSOGHOST'));
  assert.ok(ids.includes('A'));
});

test('node id scanning tolerates odd input without throwing', () => {
  for (const src of ['', '   ', '\n\n', 'flowchart TD', '-->', '[[[', undefined, null]) {
    assert.doesNotThrow(() => collectNodeIds(src));
  }
});

// ============================================================
// Completions
// ============================================================

test('offers diagram types on the first line', () => {
  const labels = labelsAtEnd('');
  assert.ok(labels.some((l) => l.startsWith('flowchart')));
  assert.ok(labels.includes('sequenceDiagram'));
});

test('filters diagram types by the typed prefix', () => {
  const { items, prefix } = getCompletions('seq', 3);
  assert.strictEqual(prefix, 'seq');
  assert.deepStrictEqual(items.map((i) => i.label), ['sequenceDiagram']);
});

test('offers directions right after graph/flowchart', () => {
  const labels = labelsAtEnd('flowchart ');
  assert.deepStrictEqual(labels.sort(), ['BT', 'LR', 'RL', 'TB', 'TD'].sort());
});

test('offers known node ids after an arrow — the key feature', () => {
  const src = 'flowchart TD\n  Alpha[A] --> Beta[B]\n  Beta --> ';
  const labels = labelsAtEnd(src);
  assert.ok(labels.includes('Alpha'), `expected Alpha in ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('Beta'));
  // Only nodes are relevant immediately after an arrow.
  assert.ok(!labels.includes('subgraph'));
});

test('filters node ids by prefix after an arrow', () => {
  const src = 'flowchart TD\n  Alpha[A] --> Beta[B]\n  Beta --> Al';
  const { items, prefix, replaceFrom } = getCompletions(src, src.length);
  assert.strictEqual(prefix, 'Al');
  assert.deepStrictEqual(items.map((i) => i.label), ['Alpha']);
  // The suggestion must replace the typed prefix, not append to it.
  assert.strictEqual(src.slice(replaceFrom), 'Al');
});

test('offers diagram-appropriate keywords mid-document', () => {
  const seqLabels = labelsAtEnd('sequenceDiagram\n  participant A\n  ');
  assert.ok(seqLabels.includes('participant'));
  assert.ok(seqLabels.includes('loop'));
  assert.ok(!seqLabels.includes('subgraph'), 'flowchart keyword leaked into sequence diagram');

  const flowLabels = labelsAtEnd('flowchart TD\n  A --> B\n  ');
  assert.ok(flowLabels.includes('subgraph'));
  assert.ok(!flowLabels.includes('participant'));
});

test('offers arrows after a node in a flowchart', () => {
  const labels = labelsAtEnd('flowchart TD\n  A[Start] ');
  assert.ok(labels.includes('-->'), `expected an arrow in ${JSON.stringify(labels)}`);
});

test('an exact match is not re-offered', () => {
  const src = 'flowchart TD\n  Alpha[A] --> Beta[B]\n  Beta --> Alpha';
  assert.ok(!labelsAtEnd(src).includes('Alpha'));
});

test('results are capped so the overlay cannot grow unbounded', () => {
  let src = 'flowchart TD\n';
  for (let i = 0; i < 100; i++) src += `  Node${i}[N${i}] --> Other${i}\n`;
  src += '  Node0 --> ';
  assert.ok(getCompletions(src, src.length).items.length <= 30);
});

test('getCompletions tolerates out-of-range carets', () => {
  assert.doesNotThrow(() => getCompletions('flowchart TD', -5));
  assert.doesNotThrow(() => getCompletions('flowchart TD', 9999));
  assert.doesNotThrow(() => getCompletions('', 0));
});

// ============================================================
// Indentation
// ============================================================

test('currentIndent returns the leading whitespace of the caret line', () => {
  const src = 'flowchart TD\n    A --> B';
  assert.strictEqual(currentIndent(src, src.length), '    ');
  assert.strictEqual(currentIndent('flowchart TD\n', 13), '');
  assert.strictEqual(currentIndent('\tX', 2), '\t');
});
