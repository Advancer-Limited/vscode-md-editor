// Tests for the line-level diff used by the version-diff viewer. Also guards the
// common-prefix/suffix trimming optimization (which avoids a quadratic LCS table
// blowing up the extension host on large files).
import { test } from 'node:test';
import assert from 'node:assert';

// Imported from TypeScript source directly — Node strips the types.
const { computeLineDiff } = await import('../src/diff/diffAlgorithm.ts');

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
