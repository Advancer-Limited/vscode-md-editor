// Unit tests for the glTF viewer's pure math helpers (media/gltfViewerMath.js):
// camera framing and JSON parse-error line extraction. Loaded via
// createRequire so the UMD module works unmodified in both the webview and
// this Node test runner — mirrors tests/mermaidSyntax.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeFraming, extractJsonErrorLine } = require('../media/gltfViewerMath.js');

// ============================================================
// computeFraming
// ============================================================

test('unit cube: center at origin, sane dist/near/far, camera offset toward +z', () => {
  const framing = computeFraming([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 50);
  assert.strictEqual(framing.isEmpty, false);
  assert.deepStrictEqual(framing.center, [0, 0, 0]);
  assert.deepStrictEqual(framing.size, [1, 1, 1]);
  assert.strictEqual(framing.maxDim, 1);
  assert.ok(framing.dist > 0, 'dist should be positive');
  assert.ok(framing.near > 0, 'near should be positive');
  assert.ok(framing.far > framing.near, 'far must exceed near');
  // position = center + dist offsets on each axis (0.6, 0.4, 1.0)
  assert.ok(Math.abs(framing.position[0] - framing.dist * 0.6) < 1e-9);
  assert.ok(Math.abs(framing.position[1] - framing.dist * 0.4) < 1e-9);
  assert.ok(Math.abs(framing.position[2] - framing.dist) < 1e-9);
});

test('a wider FOV requires a shorter viewing distance for the same box', () => {
  const narrow = computeFraming([-1, -1, -1], [1, 1, 1], 20);
  const wide = computeFraming([-1, -1, -1], [1, 1, 1], 100);
  assert.ok(wide.dist < narrow.dist);
});

test('flat plane (zero-height box): still frames using the largest non-zero dimension', () => {
  const framing = computeFraming([0, 0, 0], [10, 0, 10], 50);
  assert.strictEqual(framing.isEmpty, false);
  assert.deepStrictEqual(framing.size, [10, 0, 10]);
  assert.strictEqual(framing.maxDim, 10);
  assert.ok(framing.dist > 0);
  assert.ok(Number.isFinite(framing.dist));
  assert.ok(framing.far > framing.near);
});

test('degenerate empty box (THREE.Box3 convention: min > max) is reported as empty', () => {
  const framing = computeFraming([Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity], 50);
  assert.strictEqual(framing.isEmpty, true);
  // Only the isEmpty flag is guaranteed on an empty result.
  assert.strictEqual(Object.keys(framing).length, 1);
});

test('single-point box (min === max, non-empty) does not NaN the camera', () => {
  const framing = computeFraming([2, 2, 2], [2, 2, 2], 50);
  assert.strictEqual(framing.isEmpty, false);
  assert.deepStrictEqual(framing.center, [2, 2, 2]);
  assert.deepStrictEqual(framing.size, [0, 0, 0]);
  for (const v of [framing.dist, framing.near, framing.far, ...framing.position]) {
    assert.ok(Number.isFinite(v), `expected a finite number, got ${v}`);
  }
  assert.ok(framing.dist > 0, 'a degenerate point must still get a positive viewing distance');
  assert.ok(framing.far > framing.near);
});

test('near/far sanity holds across a range of box sizes', () => {
  const cases = [
    [[-0.001, -0.001, -0.001], [0.001, 0.001, 0.001]],
    [[-1, -1, -1], [1, 1, 1]],
    [[-1000, -1000, -1000], [1000, 1000, 1000]],
  ];
  for (const [min, max] of cases) {
    const framing = computeFraming(min, max, 50);
    assert.ok(framing.near > 0, `near must be positive for box ${JSON.stringify([min, max])}`);
    assert.ok(framing.far > framing.near, `far must exceed near for box ${JSON.stringify([min, max])}`);
  }
});

// ============================================================
// extractJsonErrorLine
// ============================================================

test('newer V8 message shape: "(line L column C)"', () => {
  const err = new Error("Expected ',' or ']' after array element in JSON at position 42 (line 3 column 5)");
  const source = 'line1\nline2\nline3 with the error\nline4';
  assert.strictEqual(extractJsonErrorLine(err, source), 3);
});

test('older V8 message shape: "at position N" only, counted from newlines', () => {
  const source = 'aaa\nbbb\nccc,\nddd'; // position of the bad char lands on line 3
  const pos = source.indexOf('ccc,') + 3; // the trailing comma
  const err = new Error(`Unexpected token , in JSON at position ${pos}`);
  assert.strictEqual(extractJsonErrorLine(err, source), 3);
});

test('"at position 0" (error at the very start) resolves to line 1', () => {
  const err = new Error('Unexpected token o in JSON at position 0');
  assert.strictEqual(extractJsonErrorLine(err, 'oops\nmore text'), 1);
});

test('clamps an out-of-range line number into the document', () => {
  const err = new Error('boom in JSON at position 99999 (line 500 column 1)');
  assert.strictEqual(extractJsonErrorLine(err, 'a\nb\nc'), 3);
});

test('clamps an out-of-range position into the document', () => {
  const err = new Error('Unexpected end of JSON input at position 99999');
  assert.strictEqual(extractJsonErrorLine(err, 'a\nb\nc'), 3);
});

test('returns null when the message carries neither shape', () => {
  assert.strictEqual(extractJsonErrorLine(new Error('Unexpected end of JSON input'), 'a\nb'), null);
  assert.strictEqual(extractJsonErrorLine(null, 'a\nb'), null);
  assert.strictEqual(extractJsonErrorLine(undefined, 'a\nb'), null);
});

test('a single-line document never reports a line below 1 or above 1', () => {
  const err = new Error('Unexpected token in JSON at position 0 (line 1 column 1)');
  assert.strictEqual(extractJsonErrorLine(err, '{bad json}'), 1);
});
