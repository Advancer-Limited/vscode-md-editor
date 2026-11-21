// PWP-10 with the real pdf.js: media/pdfFind.js drives the real PDFFindController (pdf_viewer.mjs) over the
// real fixtures, in Node. The page view stays stubbed (no DOM, canvas or text layer), so highlights and
// scrolling are not checked here; counts, options, progressive totals and the scanned hint are.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// pdf_viewer.mjs touches `window`/`document` while it loads and reads the display API from `globalThis.pdfjsLib`.
const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {} });
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.document = { createElement: el, addEventListener() {}, documentElement: el(), head: el(), body: el(), fonts: { add() {}, delete() {} }, getElementById: () => null, querySelector: () => null };
const realLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
globalThis.pdfjsLib = realLib;
const RV = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
delete globalThis.document;                       // the shell under test gets its own DOM shim
delete globalThis.window;

const require = createRequire(import.meta.url);
const { setup } = require('./_viewerHarness.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(here, '..', '..', 'media', 'pdfjs').replace(/\\/g, '/') + '/';
const SRC = fs.readFileSync(path.join(here, '..', '..', 'media', 'pdfFind.js'), 'utf8');
const bytesOf = (name) => new Uint8Array(fs.readFileSync(path.join(here, '..', 'fixtures', 'pdf', name)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(name) {
  const lib = { ...realLib, GlobalWorkerOptions: {} };
  const t = setup({
    base: BASE,
    bundle: (_log, stub) => {
      // A link service that looks like the real one to the find controller (page count, current page, viewer).
      class LinkService extends stub.pdfjsViewer.PDFLinkService {
        get pagesCount() { return this.docs.length ? this.docs[this.docs.length - 1][0].numPages : 0; }
        get page() { return this._p || 1; }
        set page(n) { this._p = n; }
        get pdfViewer() { return { getPageView: () => null, scrollMatchIntoView() {}, update() {}, currentPageNumber: 1 }; }
      }
      return { pdfjsLib: lib, pdfjsViewer: { ...stub.pdfjsViewer, EventBus: RV.EventBus, PDFFindController: RV.PDFFindController, PDFLinkService: LinkService } };
    },
  });
  t.win.PdfViewerShell = t.shell;
  t.win.document = t.document;
  vm.runInContext(SRC, vm.createContext({ window: t.win, document: t.document }), { filename: 'pdfFind.js' });
  t.find = t.win.PdfFindBar;
  t.shell.start();
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: bytesOf(name) });
  for (let i = 0; i < 500 && !t.posted.some((m) => m.type === 'pdfFacts'); i++) { await sleep(10); }
  assert.ok(t.posted.some((m) => m.type === 'pdfFacts'), 'document shown');
  // The real PDFViewer hands the document to the find controller; the stub viewer does not.
  t.shell.findController.setDocument(t.shell.pdfDocument);
  t.input = () => t.find.bar.find((e) => e.className === 'pdf-find-input')[0];
  t.count = () => t.find.bar.find((e) => e.id === 'pdf-find-count')[0].textContent;
  t.type = (text) => { const i = t.input(); i.value = text; i.fire('input', {}); };
  t.until = async (pred, ms = 8000) => { for (let i = 0; i < ms / 20 && !pred(); i++) { await sleep(20); } };
  return t;
}

test('basic.pdf: a count arrives, the options change it, and "no matches" is reported', async () => {
  const t = await open('basic.pdf');
  t.key('f', { ctrlKey: true });
  t.type('quick');
  await t.until(() => /^\d+ of \d+$/.test(t.count()));
  const m = /^(\d+) of (\d+)$/.exec(t.count());
  assert.ok(m, t.count());
  assert.strictEqual(m[1], '1');
  const total = Number(m[2]);
  assert.ok(total >= 2);

  t.type('QUICK');
  await t.until(() => /^\d+ of \d+$/.test(t.count()));
  assert.strictEqual(Number(/of (\d+)$/.exec(t.count())[1]), total, 'case-insensitive by default');
  t.find.bar.find((e) => e.getAttribute('aria-label') === 'Match case')[0].click();
  await t.until(() => t.count() === 'No matches');
  assert.strictEqual(t.count(), 'No matches');
  assert.strictEqual(t.input().getAttribute('aria-invalid'), 'true');

  t.type('qui');
  t.find.bar.find((e) => e.getAttribute('aria-label') === 'Match case')[0].click();   // off again
  t.find.bar.find((e) => e.getAttribute('aria-label') === 'Whole words')[0].click();
  await t.until(() => t.count() === 'No matches');
  assert.strictEqual(t.count(), 'No matches', '"qui" is not a whole word');
});

test('basic.pdf: next steps through the matches and wraps with an announcement', async () => {
  const t = await open('basic.pdf');
  t.key('f', { ctrlKey: true });
  t.type('quick');
  await t.until(() => /^1 of \d+$/.test(t.count()));
  const total = Number(/of (\d+)$/.exec(t.count())[1]);
  for (let i = 2; i <= total; i++) {
    t.input().fire('keydown', { key: 'Enter', preventDefault() {} });
    await t.until(() => t.count().startsWith(i + ' of '));
    assert.strictEqual(t.count(), i + ' of ' + total);
  }
  t.input().fire('keydown', { key: 'Enter', preventDefault() {} });
  await t.until(() => /^Reached the end/.test(t.live.textContent));
  assert.ok(/^Reached the end of the document; continued from the top\. 1 of /.test(t.live.textContent), t.live.textContent);
  t.input().fire('keydown', { key: 'Enter', shiftKey: true, preventDefault() {} });
  await t.until(() => /^Reached the top/.test(t.live.textContent));
  assert.ok(/^Reached the top of the document; continued from the end\. /.test(t.live.textContent), t.live.textContent);
});

test('cjk.pdf: a Japanese query is found', async () => {
  const t = await open('cjk.pdf');
  t.key('f', { ctrlKey: true });
  t.type('漢字');
  await t.until(() => /^\d+ of \d+$/.test(t.count()));
  assert.strictEqual(t.count(), '1 of 1');
});

test('large.pdf: the total is "more than N" while pages are still being scanned, then final', async () => {
  const t = await open('large.pdf');
  t.key('f', { ctrlKey: true });
  t.type('quick');
  const seen = [];
  const c = t.shell.findController;
  // pdf.js extracts on the main thread here without yielding: sample the count synchronously on each update.
  t.shell.eventBus.on('updatefindmatchescount', () => { const s = t.count(); if (seen[seen.length - 1] !== s) { seen.push(s); } });
  await t.until(() => c._pendingFindMatches.size === 0 && /^\d+ of \d+$/.test(t.count()), 100000);
  assert.ok(seen.some((s) => /^\d+ of more than \d+$/.test(s)), 'a partial count was shown: ' + seen.slice(0, 8).join(' / '));
  assert.ok(/^1 of \d+$/.test(t.count()), t.count());
  assert.ok(Number(/of (\d+)$/.exec(t.count())[1]) >= 2000);
});

test('scanned.pdf: the no-text-layer note replaces the search', async () => {
  const t = await open('scanned.pdf');
  await t.until(() => t.posted.some((m) => m.type === 'pdfFacts' && m.facts.hasText === false));
  t.key('f', { ctrlKey: true });
  const note = t.find.bar.find((e) => e.className === 'pdf-find-note')[0];
  assert.strictEqual(note.hidden, false);
  assert.ok(/no text layer/.test(note.textContent));
  assert.strictEqual(t.input().disabled, true);
});
