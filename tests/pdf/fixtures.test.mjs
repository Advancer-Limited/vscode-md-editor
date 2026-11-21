// PWP-03 acceptance: every fixture named in spec 13.3 exists (or is listed PENDING and warns),
// none is over 5 MB, and the README describes each committed file.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED, PENDING } from './fixtureLists.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');
const MAX_BYTES = 5 * 1024 * 1024;
const present = (n) => fs.existsSync(path.join(dir, n));

test('every generated or producer fixture exists', () => {
  const missing = REQUIRED.filter((n) => !present(n));
  assert.deepStrictEqual(missing, [], `missing fixtures: ${missing.join(', ')}`);
});

test('PENDING (user-supplied) fixtures: warn when absent', (t) => {
  const absent = PENDING.filter((n) => !present(n));
  if (absent.length) {
    const msg = `PENDING user-supplied fixtures not yet present: ${absent.join(', ')}`;
    console.warn(`warning: ${msg}`);
    t.diagnostic(msg);
  }
  assert.ok(true);
});

test('no fixture is over 5 MB', () => {
  for (const f of fs.readdirSync(dir)) {
    assert.ok(fs.statSync(path.join(dir, f)).size <= MAX_BYTES, `${f} is over 5 MB`);
  }
});

test('huge.pdf is never committed', () => {
  assert.ok(!present('huge.pdf'));
});

test('README mentions every committed fixture, every PENDING one and the password', () => {
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pdf'))) assert.ok(readme.includes(`\`${f}\``), `README lacks ${f}`);
  for (const f of PENDING) assert.ok(readme.includes(`\`${f}\``), `README lacks PENDING ${f}`);
  assert.match(readme, /password[^\n]*`test`/i);
});
