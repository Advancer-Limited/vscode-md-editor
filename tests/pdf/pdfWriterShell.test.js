// PWP-19: media/pdfWriter.js inside the viewer shell's DOM shim (stub bundle): message wiring, and the
// browser engine's own-Worker rule (never the viewer's worker; terminated after the write).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makePdf } = require('./_viewerHarness.cjs');

const settle = async (t, pred, n = 200) => { for (let i = 0; i < n && !pred(); i++) { await new Promise((r) => setTimeout(r, 5)); } };

function boot() {
  const stubLog = { pdfWorkers: [], storage: [], destroyed: [] };
  const t = setup({
    bundle: (log, stub) => {
      class PDFWorker { constructor(o) { this.port = o.port; stubLog.pdfWorkers.push(this); this.destroyed = false; } destroy() { this.destroyed = true; } }
      return { pdfjsLib: Object.assign({}, stub.pdfjsLib, { PDFWorker }), pdfjsViewer: stub.pdfjsViewer };
    },
  });
  return { t, stubLog };
}

test('a pdfWrite message through the real shell: own Worker, entries set on the write document only, result posted, everything closed', async () => {
  const { t, stubLog } = boot();
  const viewedStorage = [];
  const viewed = makePdf(2, { getData: async () => new Uint8Array([37, 80, 68, 70]), annotationStorage: { setValue: (...a) => viewedStorage.push(a) } });
  await t.open({ pdf: viewed });
  assert.equal(t.shell.phase, 'ready');
  const viewerWorker = t.log.workers.length;          // the viewer's own Worker
  t.runScript('pdfWriter.js');
  const writeStorage = [];
  const writeDoc = makePdf(2, { annotationStorage: { setValue: (k, v) => writeStorage.push([k, v]) }, saveDocument: async () => new Uint8Array([9, 8, 7]) });
  const readBack = makePdf(2, { getPage: async () => ({ getAnnotations: async (o) => { readBack.intents.push(o && o.intent); return [{ id: '5R', checkBox: true, fieldValue: 'Yes', exportValue: 'Yes' }, { id: '6R' }]; }, cleanup() {} }) });
  readBack.intents = [];
  t.log.plan.push({ pdf: writeDoc }, { pdf: readBack });
  const w = t.win.PdfWriterApi.create(t.shell, { window: t.win, document: t.document });
  const storage = [['pdfjs_internal_editor_0', { annotationType: 9 }], ['5R', { value: true }]];
  t.send({ type: 'pdfWrite', requestId: 7, generation: 1, version: 2, storage });
  await settle(t, () => t.posted.some((m) => m.type === 'pdfWriteResult'));
  const res = t.last('pdfWriteResult');
  assert.ok(res, 'a reply');
  assert.equal(res.ok, true, res.message);
  assert.equal(res.requestId, 7);
  assert.deepStrictEqual(Array.from(res.bytes), [9, 8, 7]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.observed)), { pageCount: 2, annotsPerPage: [2, 2], fields: [{ ref: { num: 5, gen: 0 }, value: true }] });
  assert.deepStrictEqual(readBack.intents, ['any', 'any'], 'counts use intent any');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(writeStorage)), storage, 'exactly the host entries, in order');
  assert.equal(viewedStorage.length, 0, 'the viewed document was never written to');
  // own Worker, own PDFWorker per document, none of them the viewer's
  assert.equal(t.log.workers.length, viewerWorker + 1);
  const own = t.log.workers[t.log.workers.length - 1];
  assert.equal(own.terminated, true);
  assert.equal(own.options.type, 'module');
  assert.equal(stubLog.pdfWorkers.length, 2);
  assert.ok(stubLog.pdfWorkers.every((p) => p.port === own && p.port !== t.log.workers[0] && p.destroyed));
  const writeCalls = t.log.getDocument.slice(-2);
  assert.ok(writeCalls.every((o, i) => o.worker === stubLog.pdfWorkers[i]));
  assert.ok(writeCalls.every((o) => o.disableRange && o.disableStream && o.enableXfa === false), 'same document options as the viewer');
  assert.equal(t.log.tasks[1].destroyed, 1);
  assert.equal(t.log.tasks[2].destroyed, 1);
  assert.equal(t.log.tasks[0].destroyed, 0, 'the viewed document\'s task was not destroyed');
  assert.equal(w.stats().openDocuments, 0);
});

test('stale generation through the shell replies ok:false and starts no Worker', async () => {
  const { t } = boot();
  await t.open({ pdf: makePdf(1, { getData: async () => new Uint8Array([1]) }) }, 3);
  t.runScript('pdfWriter.js');
  t.win.PdfWriterApi.create(t.shell, { window: t.win, document: t.document });
  const before = t.log.workers.length;
  t.send({ type: 'pdfWrite', requestId: 1, generation: 2, version: 0, storage: [] });
  await settle(t, () => t.posted.some((m) => m.type === 'pdfWriteResult'));
  const res = t.last('pdfWriteResult');
  assert.equal(res.ok, false);
  assert.equal(res.message, t.win.PdfWriterApi.WRITE_MESSAGES.stale);
  assert.equal(t.log.workers.length, before);
});

test('a worker file that cannot be read fails the write cleanly', async () => {
  const t = setup({ fetch: async (url) => (/pdf\.worker/.test(url) && t.log.fetches.length > 1 ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => '' }),
    bundle: (log, stub) => ({ pdfjsLib: Object.assign({}, stub.pdfjsLib, { PDFWorker: class { destroy() {} } }), pdfjsViewer: stub.pdfjsViewer }) });
  await t.open({ pdf: makePdf(1, { getData: async () => new Uint8Array([1]) }) });
  t.runScript('pdfWriter.js');
  t.win.PdfWriterApi.create(t.shell, { window: t.win, document: t.document });
  t.send({ type: 'pdfWrite', requestId: 4, generation: 1, version: 0, storage: [] });
  await settle(t, () => t.posted.some((m) => m.type === 'pdfWriteResult'));
  const res = t.last('pdfWriteResult');
  assert.equal(res.ok, false);
  assert.equal(res.message, t.win.PdfWriterApi.WRITE_MESSAGES.failed); // the HTTP status only in the console (N9)
});
