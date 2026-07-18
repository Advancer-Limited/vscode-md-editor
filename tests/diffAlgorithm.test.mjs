// Tests for the line-level diff used by the version-diff viewer. Also guards the
// common-prefix/suffix trimming optimization (which avoids a quadratic LCS table
// blowing up the extension host on large files).
import { test } from 'node:test';
import assert from 'node:assert';

// Imported from TypeScript source directly — Node strips the types.
const { computeLineDiff, segmentLines } = await import('../src/diff/diffAlgorithm.ts');

/** Reconstruct the "old" text from the hunks (unchanged + removed lines). */
function reconstructOld(hunks) {
  return hunks
    .filter((h) => h.type !== 'added')
    .map((h) => h.content)
    .join('\n');
}

/** Reconstruct the "new" text from the hunks (unchanged + added lines). */
function reconstructNew(hunks) {
  return hunks
    .filter((h) => h.type !== 'removed')
    .map((h) => h.content)
    .join('\n');
}

test('identical text produces a single unchanged hunk', () => {
  const text = 'a\nb\nc';
  const hunks = computeLineDiff(text, text);
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0].type, 'unchanged');
  assert.strictEqual(hunks[0].content, 'a\nb\nc');
});

test('pure addition', () => {
  const hunks = computeLineDiff('a\nc', 'a\nb\nc');
  assert.strictEqual(reconstructOld(hunks), 'a\nc');
  assert.strictEqual(reconstructNew(hunks), 'a\nb\nc');
  assert.ok(hunks.some((h) => h.type === 'added' && h.content === 'b'));
});

test('pure deletion', () => {
  const hunks = computeLineDiff('a\nb\nc', 'a\nc');
  assert.strictEqual(reconstructOld(hunks), 'a\nb\nc');
  assert.strictEqual(reconstructNew(hunks), 'a\nc');
  assert.ok(hunks.some((h) => h.type === 'removed' && h.content === 'b'));
});

test('a change in the middle of a large file only diffs the changed region', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const oldText = big.join('\n');
  const changed = big.slice();
  changed[2500] = 'CHANGED LINE';
  const newText = changed.join('\n');

  const hunks = computeLineDiff(oldText, newText);

  // Round-trips correctly...
  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);
  // ...and the change is isolated: exactly one removed + one added line.
  const removed = hunks.filter((h) => h.type === 'removed');
  const added = hunks.filter((h) => h.type === 'added');
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(removed[0].content, 'line 2500');
  assert.strictEqual(added[0].content, 'CHANGED LINE');
});

test('CRLF and LF are normalized so line endings alone are not a diff', () => {
  const hunks = computeLineDiff('a\r\nb\r\nc', 'a\nb\nc');
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0].type, 'unchanged');
});

test('completely different text', () => {
  const hunks = computeLineDiff('x\ny', 'p\nq');
  assert.strictEqual(reconstructOld(hunks), 'x\ny');
  assert.strictEqual(reconstructNew(hunks), 'p\nq');
});

test('empty old text (all added)', () => {
  const hunks = computeLineDiff('', 'a\nb');
  assert.strictEqual(reconstructNew(hunks), 'a\nb');
});

test('an interior-line change inside a fenced code block produces one complete removed hunk and one complete added hunk', () => {
  const oldText = 'prose before\n```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\nprose after';
  const newText = 'prose before\n```js\nconst a = 1;\nconst b = CHANGED;\nconst c = 3;\n```\nprose after';

  const hunks = computeLineDiff(oldText, newText);

  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);

  const removed = hunks.filter((h) => h.type === 'removed');
  const added = hunks.filter((h) => h.type === 'added');
  assert.strictEqual(removed.length, 1, 'expected exactly one removed hunk (the whole fence), not fragmented');
  assert.strictEqual(added.length, 1, 'expected exactly one added hunk (the whole fence), not fragmented');

  // The removed/added hunks must each contain the COMPLETE fence, including
  // both the opening and closing fence markers — not just the changed line.
  assert.strictEqual(removed[0].content, '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
  assert.strictEqual(added[0].content, '```js\nconst a = 1;\nconst b = CHANGED;\nconst c = 3;\n```');
});

test('an unterminated fence (opens but never closes before EOF) is handled without throwing or infinite-looping', () => {
  const oldText = 'prose\n```js\nconst a = 1;\nconst b = 2;';
  const newText = 'prose\n```js\nconst a = 1;\nconst b = CHANGED;';

  const hunks = computeLineDiff(oldText, newText);

  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);

  const segmented = segmentLines(oldText);
  // The unterminated fence collapses into a single trailing entry that runs
  // to the end of the document, mirroring markdown-it's own behavior.
  assert.strictEqual(segmented[segmented.length - 1], '```js\nconst a = 1;\nconst b = 2;');
});

test('~~~-style fences are collapsed atomically the same as backtick fences', () => {
  const oldText = 'prose\n~~~\nfoo\nbar\n~~~\nmore prose';
  const newText = 'prose\n~~~\nfoo\nBAZ\n~~~\nmore prose';

  const hunks = computeLineDiff(oldText, newText);

  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);

  const removed = hunks.filter((h) => h.type === 'removed');
  const added = hunks.filter((h) => h.type === 'added');
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(removed[0].content, '~~~\nfoo\nbar\n~~~');
  assert.strictEqual(added[0].content, '~~~\nfoo\nBAZ\n~~~');
});

test('a fence immediately adjacent to changed prose lines still diffs the prose line-by-line', () => {
  const oldText = 'old prose line\n```\ncode\n```\nold trailing line';
  const newText = 'new prose line\n```\ncode\n```\nnew trailing line';

  const hunks = computeLineDiff(oldText, newText);

  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);

  // The fence itself is unchanged and should appear as a single unchanged
  // hunk containing exactly the fence block (not merged with prose lines).
  const unchangedFence = hunks.find((h) => h.type === 'unchanged' && h.content === '```\ncode\n```');
  assert.ok(unchangedFence, 'expected the fence to be an isolated unchanged hunk');

  // Prose lines outside the fence are diffed individually, not swept into the fence.
  assert.ok(hunks.some((h) => h.type === 'removed' && h.content === 'old prose line'));
  assert.ok(hunks.some((h) => h.type === 'added' && h.content === 'new prose line'));
  assert.ok(hunks.some((h) => h.type === 'removed' && h.content === 'old trailing line'));
  assert.ok(hunks.some((h) => h.type === 'added' && h.content === 'new trailing line'));
});

test('fences using 4+ backticks (nesting literal triple-backticks) are matched correctly', () => {
  const oldText = 'prose\n````markdown\nHere is a fence:\n```\nnested\n```\nold line\n````\nafter';
  const newText = 'prose\n````markdown\nHere is a fence:\n```\nnested\n```\nnew line\n````\nafter';

  const segmentedOld = segmentLines(oldText);
  // The whole 4-backtick-delimited block (including the nested 3-backtick
  // fence inside it) must collapse into a single entry — the nested triple
  // backticks must NOT be treated as the closer.
  const fenceEntry = segmentedOld.find((e) => e.startsWith('````markdown'));
  assert.ok(fenceEntry, 'expected a single entry starting with the 4-backtick opener');
  assert.strictEqual(
    fenceEntry,
    '````markdown\nHere is a fence:\n```\nnested\n```\nold line\n````',
  );

  const hunks = computeLineDiff(oldText, newText);
  assert.strictEqual(reconstructOld(hunks), oldText);
  assert.strictEqual(reconstructNew(hunks), newText);

  const removed = hunks.filter((h) => h.type === 'removed');
  const added = hunks.filter((h) => h.type === 'added');
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(
    removed[0].content,
    '````markdown\nHere is a fence:\n```\nnested\n```\nold line\n````',
  );
  assert.strictEqual(
    added[0].content,
    '````markdown\nHere is a fence:\n```\nnested\n```\nnew line\n````',
  );
});
