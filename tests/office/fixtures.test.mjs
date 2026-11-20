import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', 'fixtures', 'office');
const MAX_BYTES = 5 * 1024 * 1024;

// Every file named in spec 13.4, except huge.xlsx (generated in test setup, never committed).
const REQUIRED = [
  'basic.docx', 'multi-run.docx', 'rich.docx', 'fields.docx', 'anchors.docx', 'tracked.docx', 'protected.docx',
  'localised-de.synthetic.docx', 'no-heading-styles.docx', 'no-numbering.docx', 'content-controls.docx', 'tables.docx',
  'large.docx', 'encrypted.docx', 'legacy-renamed.docx', 'truncated.docx', 'external-image.docx',
  'basic.xlsx', 'styles.xlsx', 'formulas.xlsx', 'tables.xlsx', 'features.xlsx', 'date1904.xlsx',
  'no-date-style.xlsx', 'no-date-style-nocount.xlsx', 'no-styles.xlsx', 'protected-sheet.xlsx', 'protected-structure.xlsx',
  'inline-strings.xlsx', 'no-shared-strings.xlsx', 'prefixed-namespaces.xlsx', 'large.xlsx', 'encrypted.xlsx',
  'data-descriptors.xlsx', 'zip64.xlsx', 'expected/styles.pdf',
];
// Producer files only the user can supply (see tests/fixtures/office/README.md for the recipes).
// A missing one prints a warning instead of failing.
const PENDING = ['libreoffice.docx', 'libreoffice.xlsx', 'googledocs.docx', 'googlesheets.xlsx', 'localised-de.docx'];

test('every fixture named in spec 13.4 exists', () => {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(DIR, f)));
  assert.deepStrictEqual(missing, [], `missing fixtures: ${missing.join(', ')}`);
});

test('user-supplied fixtures are present or reported as PENDING', (t) => {
  const absent = PENDING.filter((f) => !fs.existsSync(path.join(DIR, f)));
  for (const f of absent) console.warn(`PENDING fixture (supply per README recipe): ${f}`);
  t.diagnostic(`pending: ${absent.join(', ') || 'none'}`);
});

test('no committed fixture exceeds 5 MB', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(DIR)) {
    assert.ok(fs.statSync(f).size <= MAX_BYTES, `${path.relative(DIR, f)} is over 5 MB`);
  }
  assert.ok(!fs.existsSync(path.join(DIR, 'huge.xlsx')), 'huge.xlsx must not be committed');
});

test('makeHugeXlsx writes a zip into the given directory', async () => {
  const script = pathToFileURL(path.join(here, '..', '..', 'scripts', 'office-fixtures', 'make-synthetic.mjs')).href;
  const { makeHugeXlsx } = await import(script);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huge-'));
  try {
    const file = await makeHugeXlsx(tmp, { rows: 20, cols: 5 });
    const b = fs.readFileSync(file);
    assert.strictEqual(b.readUInt32LE(0), 0x04034b50, 'starts with a ZIP local header');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
