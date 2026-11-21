import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from './_helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('pdf core test bundle loads and exposes PDF_LIMITS', () => {
  assert.strictEqual(core.limits.PDF_LIMITS.maxFileBytes, 500 * 1024 * 1024);
  assert.strictEqual(core.limits.PDF_LIMITS.maxEditFileBytes, 100 * 1024 * 1024);
  for (const ns of ['sniff', 'reader', 'classify', 'state', 'geometry', 'storageAdapter', 'verify']) {
    assert.ok(core[ns], `${ns} namespace is present`);
  }
});

test('package.json pins pdf.js exactly and requires VS Code 1.95', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies['pdfjs-dist'], '6.5.438');
  assert.strictEqual(pkg.devDependencies['@cantoo/pdf-lib'], '2.11.1');
  assert.strictEqual(pkg.devDependencies['@hyzyla/pdfium'], '3.0.0');
  assert.strictEqual(pkg.engines.vscode, '^1.95.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '^1.95.0');
});

test('vendored pdf.js bundle and data files are in media/ and the sandbox is not', () => {
  const m = path.join(root, 'media');
  assert.ok(fs.statSync(path.join(m, 'pdfjs-bundle.js')).size > 500_000, 'bundle');
  assert.ok(fs.existsSync(path.join(m, 'pdfjs', 'pdf.worker.min.mjs')), 'worker');
  assert.ok(fs.existsSync(path.join(m, 'pdfjs', 'pdf_viewer.css')), 'viewer css');
  for (const d of ['cmaps', 'standard_fonts', 'iccs', 'wasm', 'images']) {
    assert.ok(fs.readdirSync(path.join(m, 'pdfjs', d)).length > 0, d);
  }
  for (const w of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm']) {
    assert.ok(fs.existsSync(path.join(m, 'pdfjs', 'wasm', w)), w);
  }
  const all = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else all.push(e.name);
    }
  })(path.join(m, 'pdfjs'));
  for (const f of all) {
    assert.ok(!/^pdf\.sandbox|^quickjs-eval|_nowasm_fallback\.js$|QUICKJS/.test(f), `excluded file shipped: ${f}`);
  }
});

test('the bundle is an IIFE global with the display API and viewer components, and no eval', () => {
  const code = fs.readFileSync(path.join(root, 'media', 'pdfjs-bundle.js'), 'utf8');
  assert.ok(code.includes('var PdfjsBundle='), 'IIFE global PdfjsBundle');
  for (const name of ['PDFViewer', 'PDFFindController', 'PDFLinkService', 'getDocument', 'GenericL10n']) {
    assert.ok(code.includes(name), `${name} present`);
  }
  assert.ok(!/\beval\(|new Function\(/.test(code), 'no eval / new Function');
});

test('the vendored pdf.js worker contains no eval / new Function (the CSP has no unsafe-eval)', () => {
  const code = fs.readFileSync(path.join(root, 'media', 'pdfjs', 'pdf.worker.min.mjs'), 'utf8');
  assert.ok(code.length > 500_000, 'worker file present');
  assert.ok(!/\beval\(|new Function\(/.test(code), 'no eval / new Function in the worker');
});
