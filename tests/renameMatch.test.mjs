// Tests for findWikilinkStemRanges — the pure matcher used by rename
// propagation to locate the stem portion of [[wikilinks]] for in-place rewrite.
import { test } from 'node:test';
import assert from 'node:assert';

const { findWikilinkStemRanges } = await import('../src/wikilink/wikilinkParser.ts');

/** Apply the ranges to verify they select exactly the stem text. */
function selected(text, stem) {
  return findWikilinkStemRanges(text, stem).map((r) => text.slice(r.start, r.end));
}

test('matches a plain [[stem]]', () => {
  const text = 'see [[Foo]] here';
  const ranges = findWikilinkStemRanges(text, 'Foo');
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(text.slice(ranges[0].start, ranges[0].end), 'Foo');
});

test('matches [[stem|display]] but selects only the stem', () => {
  const text = 'see [[Foo|Display Text]] here';
  assert.deepStrictEqual(selected(text, 'Foo'), ['Foo']);
});

test('is case-insensitive but preserves the matched casing in the range', () => {
  const text = 'a [[foo]] and [[FOO]]';
  assert.deepStrictEqual(selected(text, 'Foo'), ['foo', 'FOO']);
});

test('tolerates whitespace inside the brackets', () => {
  const text = 'x [[ Foo ]] y [[  Foo  |  alias ]] z';
  assert.deepStrictEqual(selected(text, 'Foo'), ['Foo', 'Foo']);
});

test('does NOT match a different multi-word target', () => {
  const text = '[[Foo Bar]] and [[Foobar]]';
  assert.deepStrictEqual(selected(text, 'Foo'), []);
});

test('matches multiple occurrences', () => {
  const text = '[[Foo]] [[Foo|a]] [[ Foo ]]';
  assert.strictEqual(findWikilinkStemRanges(text, 'Foo').length, 3);
});

test('escapes regex-special characters in the stem', () => {
  const text = 'see [[C++ Notes]] and [[a.b]]';
  assert.deepStrictEqual(selected(text, 'a.b'), ['a.b']);
  // The "." must be literal — it should not match "axb".
  assert.deepStrictEqual(selected('[[axb]]', 'a.b'), []);
});

test('returns empty for an empty stem', () => {
  assert.deepStrictEqual(findWikilinkStemRanges('[[Foo]]', ''), []);
});
