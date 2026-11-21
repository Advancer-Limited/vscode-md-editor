// PWP-08 smoke test with the real pdf.js display API (legacy build, in Node): the viewer shell of
// media/pdfViewer.js loads the fixtures through its own getDocument options, password flow, error
// views and facts. The page view (PDFViewer, canvas, text-layer DOM) needs a browser and stays
// stubbed here; text is checked through pdf.js's text extraction instead.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\/.*\.js$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const { setup } = require('./_viewerHarness.cjs');
const { parsePdfToHost } = await import('../../src/pdf/protocol.ts');
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'pdf');
// In Node pdf.js reads its data files (cMaps, standard fonts, wasm) from disk: the same folder the webview serves.
const BASE = path.join(here, '..', '..', 'media', 'pdfjs').replace(/\\/g, '/') + '/';
const realLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const bytesOf = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shell with the real `pdfjsLib` (the worker port is a browser thing: Node runs pdf.js on the main thread). */
function real() {
  const lib = { ...realLib, GlobalWorkerOptions: {} };
  return setup({ base: BASE, bundle: (_log, stub) => ({ pdfjsLib: lib, pdfjsViewer: stub.pdfjsViewer }) });
}

async function open(name) {
  const t = real();
  t.shell.start();
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: bytesOf(name) });
  await settled(t);
  return t;
}

/** Wait until the shell is in `want` (default: has left 'loading') and, for a shown document, its facts were posted. */
async function settled(t, want, facts = 1) {
  for (let i = 0; i < 500; i++) {
    await sleep(10);
    const phase = t.shell.phase;
    if (want ? phase === want : phase !== 'loading') {
      if (phase !== 'ready' || t.posted.filter((m) => m.type === 'pdfFacts').length >= facts) { return; }
    }
  }
  throw new Error('timed out in phase ' + t.shell.phase);
}

const close = async (t) => { t.send({ type: 'loadError', title: 'x', detail: '', actions: [] }); await t.tick(20); };
const title = (t) => t.errorView.find((e) => e.tagName === 'H2')[0].textContent;

const NONE = { encrypted: false, hasText: true, hasJavaScript: false, hasXfa: false, attachmentCount: 0, signatures: [] };
const FACTS = {
  'basic.pdf': { pageCount: 2, ...NONE },
  'word.pdf': { pageCount: 2, ...NONE },
  'chrome.pdf': { pageCount: 6, ...NONE },
  'large.pdf': { pageCount: 2000, ...NONE },
  'broken-xref.pdf': { pageCount: 2, ...NONE },
  'forms.pdf': { pageCount: 2, ...NONE },
  'forms-js.pdf': { pageCount: 1, ...NONE, hasJavaScript: true },
  'js-openaction.pdf': { pageCount: 1, ...NONE, hasJavaScript: true },
  'scanned.pdf': { pageCount: 3, ...NONE, hasText: false },
  'attachments.pdf': { pageCount: 1, ...NONE, attachmentCount: 3 },
  'encrypted-owner.pdf': { pageCount: 2, ...NONE, encrypted: true },
  'signed.pdf': { pageCount: 1, ...NONE, signatures: [{ signer: 'Fixture Signer', reason: 'Fixture', time: 'D:20261121000000Z' }] },
};

for (const [name, want] of Object.entries(FACTS)) {
  test(`${name}: opens with the viewer's getDocument options and posts facts the host accepts`, async () => {
    const t = await open(name);
    try {
      assert.strictEqual(t.shell.phase, 'ready');
      assert.strictEqual(t.password.hidden, true, 'no password prompt');
      const msg = t.last('pdfFacts');
      assert.deepStrictEqual(plain(msg.facts), want);
      assert.deepStrictEqual(parsePdfToHost(plain(msg)), { type: 'pdfFacts', generation: 1, facts: want });
      assert.strictEqual(t.viewer.doc, t.shell.pdfDocument);
      assert.strictEqual(t.pageCount.textContent, 'of ' + want.pageCount);
      // No browser worker in Node, so pdf.js runs on the main thread: the fallback detection says so.
      assert.strictEqual(t.shell.diagnostics().workerIsOurs, false);
    } finally { await close(t); }
  });
}

test('cjk.pdf and base14.pdf: text comes out through the cMaps and fonts of media/pdfjs/', async () => {
  const t = await open('cjk.pdf');
  try {
    const page = await t.shell.pdfDocument.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => i.str).join('');
    assert.ok(/[぀-ヿ一-鿿]/.test(text), 'CJK characters were decoded: ' + text.slice(0, 40));
    assert.strictEqual(t.last('pdfFacts').facts.hasText, true);
  } finally { await close(t); }
  const b = await open('base14.pdf');
  try { assert.strictEqual(b.last('pdfFacts').facts.hasText, true); } finally { await close(b); }
});

test('encrypted-user.pdf: prompt, wrong password, right password, silent reopen', async () => {
  const t = await open('encrypted-user.pdf');
  try {
    assert.strictEqual(t.shell.phase, 'password');
    const input = t.byClass('pdf-password-input');
    const submit = t.password.find((e) => e.getAttribute('data-action') === 'submit')[0];
    const error = t.byClass('pdf-password-error');
    assert.strictEqual(error.hidden, true);

    input.value = 'wrong';
    submit.click();
    await sleep(20);
    await settled(t, 'password');
    assert.strictEqual(error.hidden, false);
    assert.strictEqual(error.textContent, 'Incorrect password');

    input.value = 'test';
    submit.click();
    await settled(t, 'ready');
    assert.strictEqual(t.shell.pdfDocument.numPages, 2);
    assert.deepStrictEqual(plain(t.last('pdfFacts').facts), { pageCount: 2, ...NONE, encrypted: true });
    const wire = JSON.stringify(t.posted) + JSON.stringify(t.log.states);
    assert.ok(!wire.includes('"test"') && !wire.includes('wrong'));

    // The file changes on disk: the same tab reopens it without asking again.
    t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: bytesOf('encrypted-user.pdf') });
    await settled(t, 'ready', 2);
    assert.strictEqual(t.shell.generation, 2);
    assert.strictEqual(t.password.hidden, true);
  } finally { await close(t); }
});

test('encrypted-user.pdf: Cancel gives the password error view', async () => {
  const t = await open('encrypted-user.pdf');
  try {
    assert.strictEqual(t.shell.phase, 'password');
    t.password.find((e) => e.getAttribute('data-action') === 'cancel')[0].click();
    await settled(t, 'failed');
    assert.strictEqual(title(t), 'This PDF is password-protected. Reopen it to enter the password, or open it externally.');
    assert.strictEqual(t.shell.pdfDocument, null);
    assert.strictEqual(t.posted.filter((m) => m.type === 'pdfFacts').length, 0);
  } finally { await close(t); }
});

for (const name of ['truncated.pdf', 'not-a-pdf.pdf']) {
  test(`${name}: pdf.js rejects it and the damaged view shows the reason`, async () => {
    const t = await open(name);
    try {
      assert.strictEqual(t.shell.phase, 'failed');
      assert.strictEqual(title(t), "This file is damaged and can't be displayed.");
      assert.ok(t.errorView.find((e) => e.tagName === 'PRE')[0].textContent.startsWith('InvalidPDFException: '));
      assert.deepStrictEqual(t.errorView.find((e) => e.tagName === 'BUTTON').map((b) => b.textContent), ['Open externally', 'Retry']);
    } finally { await close(t); }
  });
}

test('a reload replaces the document: the old one is destroyed, the new one is shown', async () => {
  const t = await open('basic.pdf');
  try {
    const first = t.shell.pdfDocument;
    t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: bytesOf('chrome.pdf') });
    await settled(t, 'ready', 2);
    assert.notStrictEqual(t.shell.pdfDocument, first);
    assert.strictEqual(t.shell.pdfDocument.numPages, 6);
    await assert.rejects(async () => first.getPage(1), undefined, 'the first document no longer answers');
  } finally { await close(t); }
});

test('outline.pdf: pdf.js gives a URL only for the https link; javascript: and Launch carry none', async () => {
  // The viewer's click interception works on the href pdf.js writes; this pins which links get one.
  const t = await open('outline.pdf');
  try {
    const page = await t.shell.pdfDocument.getPage(1);
    const links = (await page.getAnnotations()).filter((a) => a.subtype === 'Link');
    assert.deepStrictEqual(links.map((a) => a.url).filter(Boolean), ['https://example.com/']);
    assert.ok(links.some((a) => a.unsafeUrl === 'javascript:alert(1)' && !a.url));
    assert.ok(links.some((a) => a.unsafeUrl === 'notepad.exe' && !a.url));
    for (const a of links) { if (a.url) { assert.strictEqual(t.api.allowedScheme(a.url), 'https'); } }
  } finally { await close(t); }
});
