// PDF writer service (plan PWP-19, spec §6.4 steps 1-4). Loaded after pdfViewer.js; listens on the
// global `PdfViewerShell` for the host's `pdfWrite` and answers `pdfWriteResult`. Also loaded via `vm` by the tests.
//
// What it does for one request: take the loaded bytes of the VIEWED document (`getData()`), open them as a
// separate throwaway document, put exactly the host's storage entries into that document's `annotationStorage`,
// `saveDocument()`, then open the output as a second throwaway document to read back what was written
// (`observed`), and reply with the bytes and `observed`.
//
// Facts this file is built on (pdf.js 6.5.438; the first from the spike and the Node tests, the Worker rule from the
// pdf.js source, not yet run in a real browser Worker, see log.md PWP-19):
//  - `saveDocument()` does not need pdf.js's annotation editor layer. The annotation editors (and
//    `annotationEditorMode`) are display-side; the writer reads `annotationStorage` entries in the worker. The
//    viewer's `annotationEditorMode: DISABLE` therefore stays as it is, and no view mode is changed.
//  - Two live documents must NOT share one PDFWorker: destroying a document's transport destroys the worker's
//    message handler, which every document on that worker uses. A write that shared the viewer's worker would
//    break the displayed document. So each write runs on its OWN Worker (same file, own PDFWorker per document)
//    and terminates it afterwards; the viewed document, its worker, its `annotationStorage` and its view are
//    never touched (spec §6.4 "the viewed document's own annotationStorage is never used for saving").
//  - `observed.annotsPerPage` is what the host compares with the real `/Annots` length of each page, so it counts
//    with `getAnnotations({ intent: 'any' })` (every annotation, hidden ones and Popups included).
// Rules (plan §1): nothing document-derived reaches the DOM; no network (the worker file comes from the extension's media/).
(function (global) {
  'use strict';

  const EDITOR_PREFIX = 'pdfjs_internal_editor_';
  const MAX_ENTRIES = 200000;
  const MAX_KEY = 200;
  const WORKER_FILE = 'pdf.worker.min.mjs';
  const MB = 1024 * 1024;

  /** Host timeout is 10 s + 0.2 s per MB (spec §6.5 step 3); the writer gives up a little later than that. */
  function defaultTimeoutMs(bytes) { return 15000 + Math.ceil(0.25 * (bytes / MB) * 1000); }

  function plainBytes(data) {
    const tag = Object.prototype.toString.call(data);          // realm-independent
    if (tag === '[object Uint8Array]') { return data; }
    if (tag === '[object ArrayBuffer]') { return new Uint8Array(data); }
    if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
    throw new Error('The PDF engine returned the document in an unreadable form.');
  }

  /** The request's own shape; null when fine, else a reason. Content of the entries is the adapter's business. */
  function badRequest(msg) {
    const isId = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!isId(msg.requestId)) { return 'bad request id'; }
    if (!isId(msg.generation) || !isId(msg.version)) { return 'bad generation or version'; }
    if (!Array.isArray(msg.storage) || msg.storage.length > MAX_ENTRIES) { return 'bad storage list'; }
    for (const e of msg.storage) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !e[0] || e[0].length > MAX_KEY) { return 'bad storage entry'; }
      if (e[1] === null || typeof e[1] !== 'object' || Array.isArray(e[1])) { return 'bad storage entry value'; }
    }
    return null;
  }

  /** Field ids the request sets ("12R", "12R3"); editor keys (add / remove) are not fields. */
  function requestedFields(storage) {
    const out = new Map();
    for (const e of storage) {
      if (e[0].indexOf(EDITOR_PREFIX) === 0) { continue; }
      const m = /^(\d+)R(\d*)$/.exec(e[0]);
      if (m) { out.set(e[0], { num: Number(m[1]), gen: m[2] ? Number(m[2]) : 0 }); }
    }
    return out;
  }

  /** What one widget reads back as, in the shape of `PdfFieldValue`. */
  function widgetValue(a) {
    if (a.checkBox) { return a.fieldValue === a.exportValue; }
    if (a.radioButton) { return a.fieldValue === a.buttonValue; }
    if (a.fieldType === 'Ch' && Array.isArray(a.fieldValue) && !a.multiSelect) { return a.fieldValue.length ? String(a.fieldValue[0]) : ''; }
    if (Array.isArray(a.fieldValue)) { return a.fieldValue.map(String); }
    return typeof a.fieldValue === 'string' ? a.fieldValue : a.fieldValue === undefined || a.fieldValue === null ? '' : String(a.fieldValue);
  }

  /** Page count, annotation count per page and the read-back of each requested field, from an open document. */
  async function observe(doc, fieldIds) {
    const observed = { pageCount: doc.numPages, annotsPerPage: [], fields: [] };
    const seen = new Set();
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const annots = await page.getAnnotations({ intent: 'any' });
      observed.annotsPerPage.push(annots.length);
      if (fieldIds.size) {
        for (const a of annots) {
          const ref = fieldIds.get(a.id);
          if (ref && !seen.has(a.id)) { seen.add(a.id); observed.fields.push({ ref: { num: ref.num, gen: ref.gen }, value: widgetValue(a) }); }
        }
      }
      try { page.cleanup(); } catch (e) { /* the page is gone with the document */ }
    }
    return observed;
  }

  // ---------------------------------------------------------------- the isolated engine (browser)

  /**
   * A session owns one dedicated Worker. `open(bytes)` makes a document on it with its own PDFWorker (pdf.js
   * destroys the PDFWorker with its document, never the Worker); `dispose()` terminates the Worker.
   * `bytes` is handed to pdf.js, which transfers it: the caller's array is empty afterwards.
   */
  function browserEngine(shell, win, doc) {
    const lib = shell.lib;
    const PV = win.PdfViewer;
    const app = doc && doc.getElementById ? doc.getElementById('office-app') : null;
    const baseUrl = (app && app.getAttribute('data-pdfjs-base')) || '';
    const cacheBust = (app && app.getAttribute('data-cache-bust')) || '';
    return {
      async createSession() {
        const res = await win.fetch(baseUrl + WORKER_FILE + (cacheBust ? '?v=' + encodeURIComponent(cacheBust) : ''));
        if (!res.ok) { throw new Error('The PDF engine file could not be read (HTTP ' + res.status + ').'); }
        const text = await res.text();
        const blobUrl = win.URL.createObjectURL(new win.Blob([text], { type: 'text/javascript' }));
        const worker = new win.Worker(blobUrl, { type: 'module' });
        let disposed = false;
        return {
          async open(bytes) {
            if (disposed) { throw new Error('The writer session is closed.'); }
            const pdfWorker = new lib.PDFWorker({ port: worker });
            let task = null;
            try {
              task = lib.getDocument(Object.assign(PV.documentOptions(bytes, baseUrl), { worker: pdfWorker, verbosity: 0 }));
              const pdf = await task.promise;
              return {
                doc: pdf,
                async close() {
                  try { await task.destroy(); } finally { try { pdfWorker.destroy(); } catch (e) { /* already gone */ } }
                },
              };
            } catch (e) {
              try { if (task) { await task.destroy(); } } catch (e2) { /* ignore */ }
              try { pdfWorker.destroy(); } catch (e3) { /* ignore */ }
              throw e;
            }
          },
          dispose() {
            if (disposed) { return; }
            disposed = true;
            try { worker.terminate(); } catch (e) { /* ignore */ }
            try { win.URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
          },
        };
      },
    };
  }

  // ---------------------------------------------------------------- the service

  function create(shell, opts) {
    const o = opts || {};
    const win = o.window || global;
    const engine = o.engine || browserEngine(shell, win, o.document || win.document);
    const timeoutFor = o.timeoutMs || defaultTimeoutMs;
    let chain = Promise.resolve();
    const stats = { writes: 0, failures: 0, openDocuments: 0, sessions: 0 };

    function reply(m) { shell.post(m); }
    function fail(requestId, message) {
      stats.failures++;
      reply({ type: 'pdfWriteResult', requestId, ok: false, message: String(message).slice(0, 2000) });
    }

    async function run(msg) {
      const src = shell.pdfDocument;
      if (!src || shell.phase !== 'ready') { throw new Error('No document is loaded in the viewer.'); }
      if (msg.generation !== shell.generation) { throw new Error('The request is for an older version of the file (generation ' + msg.generation + ', viewer has ' + shell.generation + ').'); }
      const stale = () => {
        if (shell.pdfDocument !== src || msg.generation !== shell.generation) { throw new Error('The document changed while saving.'); }
      };
      const live = [];        // open documents, closed on every exit
      let session = null;
      let timer = null;
      let rejectTimeout = null;
      const timeout = new Promise((_, rej) => { rejectTimeout = rej; });
      timeout.catch(() => {});
      const work = (async () => {
        let data = plainBytes(await src.getData());            // a copy of the loaded bytes; the viewer's own stay put
        stale();
        timer = setTimeout(() => rejectTimeout(new Error('The PDF engine did not finish writing in time.')), timeoutFor(data.length));
        session = await engine.createSession(); stats.sessions++;
        // Step 1: a fresh document from the bytes (pdf.js transfers `data`; nothing else holds a copy after this).
        const w = await session.open(data); data = null; stats.openDocuments++; live.push(w);
        stale();
        // Step 2: exactly the host's entries, then the writer.
        for (const e of msg.storage) { w.doc.annotationStorage.setValue(e[0], e[1]); }
        const out = plainBytes(await w.doc.saveDocument());
        // Free the writing document and its copy of the file before the read-back opens another.
        live.pop(); stats.openDocuments--; await w.close();
        stale();
        // Step 3: a third, throwaway document from a copy of the output (the output itself is the reply).
        const r = await session.open(out.slice()); stats.openDocuments++; live.push(r);
        let observed;
        try { observed = await observe(r.doc, requestedFields(msg.storage)); } finally { live.pop(); stats.openDocuments--; await r.close(); }
        stale();
        return { out, observed };
      })();
      work.catch(() => {});
      let outcome;
      try {
        outcome = await Promise.race([work, timeout]);
      } finally {
        if (timer) { clearTimeout(timer); }
        for (const h of live.splice(0).reverse()) { stats.openDocuments--; try { await h.close(); } catch (e) { /* ignore */ } }
        if (session) { session.dispose(); }
      }
      return outcome;
    }

    async function handle(msg) {
      const rid = msg && typeof msg.requestId === 'number' ? msg.requestId : 0;
      const bad = badRequest(msg || {});
      if (bad) { fail(rid, 'The save request was not valid (' + bad + ').'); return; }
      try {
        const { out, observed } = await run(msg);
        stats.writes++;
        reply({ type: 'pdfWriteResult', requestId: msg.requestId, ok: true, bytes: out, observed });
      } catch (e) {
        fail(msg.requestId, (e && e.message) || String(e));
      }
    }

    /** Requests are answered one at a time, in order; a failure never blocks the next one. */
    function enqueue(msg) {
      const p = chain.then(() => handle(msg));
      chain = p.catch(() => {});
      return p;
    }

    const off = shell.on('message', (m) => { if (m && m.type === 'pdfWrite') { void enqueue(m); } });
    return { enqueue, stats: () => Object.assign({}, stats), dispose() { off(); } };
  }

  const api = { create, observe, requestedFields, widgetValue, badRequest, defaultTimeoutMs, EDITOR_PREFIX };
  global.PdfWriterApi = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (global.PdfViewerShell && global.document && typeof global.acquireVsCodeApi === 'function') {
    global.PdfWriter = create(global.PdfViewerShell, { window: global, document: global.document });
  }
})(typeof window !== 'undefined' ? window : globalThis);
