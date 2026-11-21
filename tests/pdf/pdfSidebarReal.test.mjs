// PWP-09 with the real pdf.js display API (legacy build, in Node): the outline and attachment
// panels built from outline.pdf and attachments.pdf. Canvas rendering needs a browser and is stubbed
// in pdfSidebar.test.js.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { setup } = require('./_viewerHarness.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(here, '..', '..', 'media', 'pdfjs').split(path.sep).join('/') + '/';
const realLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (t, cls) => t.document.body.find((e) => e.className.split(' ').indexOf(cls) >= 0);

async function open(name) {
  const lib = { ...realLib, GlobalWorkerOptions: {} };
  const t = setup({ base: BASE, bundle: (_l, stub) => ({ pdfjsLib: lib, pdfjsViewer: stub.pdfjsViewer }) });
  t.runScript('pdfSidebar.js');
  t.shell.start();
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: new Uint8Array(fs.readFileSync(path.join(here, '..', 'fixtures', 'pdf', name))) });
  for (let i = 0; i < 500 && t.shell.phase !== 'ready'; i++) { await sleep(10); }
  assert.strictEqual(t.shell.phase, 'ready');
  await sleep(100);
  return t;
}

test('outline.pdf: the Outline tab exists and the tree shows the bookmark titles as text', async () => {
  const t = await open('outline.pdf');
  assert.ok(t.shell.showPanel('outline'));
  await sleep(50);
  const titles = find(t, 'pdf-outline-title').map((e) => e.textContent);
  assert.ok(titles.length >= 2, titles.join('|'));
  assert.ok(titles.every((s) => s.length > 0));
  assert.strictEqual(t.htmlWrites(), 0);
});

test('attachments.pdf: the Attachments tab lists the files; saving posts their real bytes', async () => {
  const t = await open('attachments.pdf');
  assert.ok(t.shell.showPanel('attachments'));
  await sleep(50);
  const names = find(t, 'pdf-attachment-name').map((e) => e.textContent);
  assert.ok(names.length >= 1, names.join('|'));
  find(t, 'pdf-attachment-save')[0].click();
  await sleep(100);
  const m = t.last('pdfSaveAttachment');
  assert.ok(m && m.bytes.length > 0 && m.name === names[0]);
});

test('basic.pdf has neither an outline nor attachments', async () => {
  const t = await open('basic.pdf');
  assert.strictEqual(t.shell.showPanel('outline'), false);
  assert.strictEqual(t.shell.showPanel('attachments'), false);
  assert.ok(t.shell.showPanel('thumbnails'));
});
