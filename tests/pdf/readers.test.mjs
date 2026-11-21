// PWP-21: PG6 helpers (_readers.mjs) and scripts/verify-pdf-open.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAll, checkPg6, assertPg6, collectPdfs, findQpdf, READERS } from './_readers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, '..', 'fixtures', 'pdf', n);
const bytes = (n) => new Uint8Array(fs.readFileSync(fx(n)));
const script = path.join(here, '..', '..', 'scripts', 'verify-pdf-open.mjs');

test('openAll: every reader opens basic.pdf and agrees on 2 pages', async () => {
  const r = await openAll(bytes('basic.pdf'));
  for (const n of READERS) { assert.ok(r[n].ok, `${n}: ${r[n].error}`); assert.strictEqual(r[n].pages, 2); }
  assert.ok(r.pdfjs.text[0].length > 0);
  assert.ok(r.pdfium.renders[0].nonWhite > 0);
});

test('openAll: encrypted-user.pdf needs its password, owner-only encryption opens without one', async () => {
  assert.ok(!(await openAll(bytes('encrypted-user.pdf'))).pdfjs.ok);
  const ok = await openAll(bytes('encrypted-user.pdf'), { password: 'test' });
  for (const n of READERS) assert.ok(ok[n].ok, `${n}: ${ok[n].error}`);
  const owner = await openAll(bytes('encrypted-owner.pdf'));
  for (const n of READERS) assert.ok(owner[n].ok, `${n}: ${owner[n].error}`);
});

test('openAll never throws: error fixtures report per-reader failures', async () => {
  for (const f of ['truncated.pdf', 'not-a-pdf.pdf', 'empty.pdf']) {
    const r = await openAll(bytes(f));
    // pdf-lib is lenient about a truncated file, so only pdf.js and PDFium are required to refuse it.
    for (const n of ['pdfjs', 'pdfium']) assert.strictEqual(r[n].ok, false, `${f} ${n}`);
  }
});

test('checkPg6: identical file passes; existing annotations are seen by pdf.js and pdf-lib', async () => {
  const base = await openAll(bytes('annotated.pdf'));
  assert.deepStrictEqual(checkPg6(base, base), []);
  assert.deepStrictEqual(checkPg6(base, undefined, { annots: [{ page: 1, subtype: 'Highlight' }] }), []);
});

test('checkPg6: missing annotation, extra expected count, page count and text changes are reported', async () => {
  const basic = await openAll(bytes('basic.pdf'));
  const p = (e) => checkPg6(basic, basic, e);
  assert.ok(p({ annots: [{ page: 1, subtype: 'Highlight' }] }).some((x) => x.startsWith('pdfjs')));
  assert.ok(p({ annots: [{ page: 1, subtype: 'Highlight' }] }).some((x) => x.startsWith('pdflib')));
  const word = await openAll(bytes('chrome.pdf'));
  assert.ok(checkPg6(word, basic).some((x) => /page count \d -> \d/.test(x)));
  const tweaked = structuredClone(basic); tweaked.pdfjs.text[1] += ' x';
  assert.deepStrictEqual(checkPg6(tweaked, basic).filter((x) => /text/.test(x)), ['pdfjs: text of untouched page 2 changed']);
  assert.deepStrictEqual(checkPg6(tweaked, basic, { touchedPages: [2] }), []);
  const broken = await openAll(bytes('truncated.pdf'));
  assert.ok(checkPg6(broken, basic).length >= 2);
});

test('checkPg6: reader page-count disagreement is reported', () => {
  const mk = (pages) => ({ ok: true, pages, annots: [], text: [] });
  assert.ok(checkPg6({ pdfjs: mk(2), pdfium: mk(3), pdflib: mk(2) }).some((x) => /differs between readers/.test(x)));
});

test('assertPg6 resolves for a valid file and throws a PG6 error otherwise', async () => {
  await assertPg6(bytes('basic.pdf'), bytes('basic.pdf'));
  await assert.rejects(() => assertPg6(bytes('basic.pdf'), bytes('basic.pdf'), { annots: [{ page: 1, subtype: 'Ink' }] }), /PG6 failed/);
  await assert.rejects(() => assertPg6(bytes('truncated.pdf'), bytes('basic.pdf')), /PG6 failed/);
});

test('collectPdfs expands directories recursively, skips png/, ignores missing paths', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg6-'));
  try {
    fs.mkdirSync(path.join(d, 'sub')); fs.mkdirSync(path.join(d, 'png'));
    for (const f of ['a.pdf', 'sub/b.PDF', 'c.txt', 'png/x.pdf']) fs.writeFileSync(path.join(d, f), 'x');
    assert.deepStrictEqual(collectPdfs([d, path.join(d, 'missing')]).map((f) => path.relative(d, f)), ['a.pdf', path.join('sub', 'b.PDF')]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('findQpdf returns a command or null without throwing', () => {
  const q = findQpdf();
  assert.ok(q === null || typeof q === 'string');
});

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('script: exit 2 when nothing to check, 0 for --dry-run', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg6-'));
  try {
    const none = run(d, '--out', d);
    assert.strictEqual(none.status, 2);
    assert.strictEqual(JSON.parse(none.stdout).checked, 0);
    const dry = run(fx('basic.pdf'), '--dry-run');
    assert.strictEqual(dry.status, 0);
    const j = JSON.parse(dry.stdout);
    assert.strictEqual(j.dryRun, true); assert.strictEqual(j.checked, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('script: exit 0 with a JSON summary and a PNG for good files, 1 when a file fails', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg6-'));
  try {
    const good = run(fx('basic.pdf'), fx('encrypted-user.pdf'), '--out', d, '--no-qpdf', '--quiet');
    assert.strictEqual(good.status, 0, good.stderr);
    const j = JSON.parse(good.stdout);
    assert.strictEqual(j.passed, 2); assert.strictEqual(j.failed, 0);
    assert.ok(fs.existsSync(path.join(d, 'png', 'basic.png')));
    const bad = run(fx('basic.pdf'), fx('truncated.pdf'), '--out', d, '--no-png', '--no-qpdf', '--quiet');
    assert.strictEqual(bad.status, 1);
    const b = JSON.parse(bad.stdout);
    assert.strictEqual(b.failed, 1); assert.match(b.results.find((r) => !r.ok).file, /truncated/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
