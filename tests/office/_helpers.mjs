// Shared helpers for Office tests. Core code is reached only through the test bundle
// (built by `node esbuild.js --test-bundle`, which `npm test` runs first).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, '..', 'fixtures', 'office');
const OUT_DIR = path.join(here, '..', '.out');

export const core = require('../.build/office-core.cjs');

/** Read a fixture from tests/fixtures/office/ as a Uint8Array. */
export function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** List fixture file names, optionally filtered by kind ('docx' | 'xlsx'). */
export function allFixtures(kind) {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => (kind ? f.endsWith('.' + kind) : /\.(docx|xlsx)$/.test(f)))
    .sort();
}

/** Write bytes to tests/.out/<testName>/<caseName> (git-ignored) so scripts/verify-office-open.ps1 can open them. */
export function writeOut(testName, caseName, bytes) {
  const dir = path.join(OUT_DIR, testName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, caseName);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Byte-for-byte equality with a useful first-difference message. */
export function assertBytesEqual(a, b, msg = 'bytes differ') {
  if (a.length !== b.length) {
    assert.fail(`${msg}: length ${a.length} !== ${b.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`${msg}: first difference at offset ${i} (${a[i]} !== ${b[i]})`);
  }
}

/** Common prefix / suffix lengths of two byte arrays (for the G4 locality check). */
export function commonAffixes(a, b) {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/** name -> { crc, compressedBytes, cdRecordBytes } for G3. Needs the ZIP reader (WP-04). */
export function entryTable(_bytes) {
  throw new Error('not available: entryTable needs the core ZIP reader (WP-04)');
}
