// Shared helpers for PDF tests. Core code is reached only through the test bundle
// (built by `node esbuild.js --test-bundle`, which `npm test` runs first).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, '..', 'fixtures', 'pdf');

export const core = require('../.build/pdf-core.cjs');

/** Read a fixture from tests/fixtures/pdf/ as a Uint8Array. */
export function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** List *.pdf fixture names (empty until PWP-03 lands). */
export function allFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.pdf')).sort();
}
