// Tests for the minimal-edit computation used to apply webview edits as a
// small ranged replace instead of a whole-document replace.
import { test } from 'node:test';
import assert from 'node:assert';

// Imported from TypeScript source directly — Node strips the types.
const { computeMinimalEdit } = await import('../src/utils.ts');

/** Apply the computed edit to oldText and return the result. */
function applyEdit(oldText, edit) {
  return oldText.slice(0, edit.start) + edit.text + oldText.slice(edit.end);
}

test('identical text produces an empty edit', () => {
  const edit = computeMinimalEdit('hello world', 'hello world');
  assert.strictEqual(edit.start, edit.end);
  assert.strictEqual(edit.text, '');
});

test('insertion in the middle', () => {
  const oldText = 'hello world';
  const newText = 'hello brave world';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
  assert.strictEqual(edit.text, 'brave ');
});

test('deletion in the middle', () => {
  const oldText = 'hello brave world';
  const newText = 'hello world';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
  assert.strictEqual(edit.text, '');
});

test('single character typed at end (common typing case)', () => {
  const oldText = 'abc';
  const newText = 'abcd';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
  assert.strictEqual(edit.start, 3);
  assert.strictEqual(edit.end, 3);
  assert.strictEqual(edit.text, 'd');
});

test('replacement of a word', () => {
  const oldText = 'the quick brown fox';
  const newText = 'the quick red fox';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
});

test('empty old text (initial content)', () => {
  const edit = computeMinimalEdit('', 'new content');
  assert.strictEqual(applyEdit('', edit), 'new content');
});

test('empty new text (delete everything)', () => {
  const edit = computeMinimalEdit('old content', '');
  assert.strictEqual(applyEdit('old content', edit), '');
});

test('repeated characters do not over-trim (prefix/suffix overlap)', () => {
  // Deleting one "a" from "aaaa": prefix matching consumes 3, the suffix loop
  // must stop at the prefix boundary rather than double-counting.
  const oldText = 'aaaa';
  const newText = 'aaa';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
});

test('duplicated line insertion round-trips', () => {
  const oldText = 'line1\nline2\nline3';
  const newText = 'line1\nline2\nline2\nline3';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
});

test('multi-line markdown edit round-trips', () => {
  const oldText = '# Title\n\nSome paragraph text.\n\n- item one\n- item two\n';
  const newText = '# Title\n\nSome edited paragraph text!\n\n- item one\n- item two\n';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
  // The edit should be confined to the changed paragraph.
  assert.ok(edit.start >= oldText.indexOf('Some'));
  assert.ok(edit.end <= oldText.indexOf('\n\n- item'));
});

test('completely different text', () => {
  const oldText = 'alpha';
  const newText = 'omega';
  const edit = computeMinimalEdit(oldText, newText);
  assert.strictEqual(applyEdit(oldText, edit), newText);
});
