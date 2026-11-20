import { test } from 'node:test';
import assert from 'node:assert';
import { core } from './_helpers.mjs';

test('office core test bundle loads and exposes LIMITS', () => {
  assert.ok(core.limits.LIMITS, 'core.limits.LIMITS is defined');
  assert.strictEqual(core.limits.LIMITS.maxFileBytes, 250 * 1024 * 1024);
  assert.ok(core.docx && core.xlsx, 'docx and xlsx namespaces are present');
});
