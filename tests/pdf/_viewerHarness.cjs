// Harness for the PDF viewer webview tests: a minimal DOM shim, a stubbed `PdfjsBundle`, and a
// node:vm sandbox that loads the real media/officeCommon.js, media/pdfViewMath.js and
// media/pdfViewer.js (same approach as tests/office/officeCommon.test.js).
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA = path.join(__dirname, '..', '..', 'media');
const read = (name) => fs.readFileSync(path.join(MEDIA, name), 'utf8');
const SOURCES = { common: read('officeCommon.js'), math: read('pdfViewMath.js'), viewer: read('pdfViewer.js') };

class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDoc = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.id = '';
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
    this.scrollWidth = 0;
    this._text = '';
    this.htmlWrites = 0;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  set innerHTML(_v) { this.htmlWrites++; }
  get innerHTML() { return ''; }
  set outerHTML(_v) { this.htmlWrites++; }
  insertAdjacentHTML() { this.htmlWrites++; }
  _detach(c) { if (c.parentNode) { c.parentNode.children = c.parentNode.children.filter((x) => x !== c); } }
  appendChild(c) { this._detach(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    this._detach(c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) { this.children.push(c); } else { this.children.splice(i, 0, c); }
    return c;
  }
  replaceChild(next, old) {
    this._detach(next);
    const i = this.children.indexOf(old);
    next.parentNode = this;
    old.parentNode = null;
    this.children.splice(i, 1, next);
    return old;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(n) { for (let x = n; x; x = x.parentNode) { if (x === this) { return true; } } return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) { const e = Object.assign({ target: this }, ev); (this.listeners[t] || []).slice().forEach((f) => f(e)); return e; }
  click() { return this.fire('click', {}); }
  focus() { this.ownerDoc.activeElement = this; this.fire('focus', {}); }
  select() { this.selected = true; }
  find(pred, out = []) {
    if (pred(this)) { out.push(this); }
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
  /** True when the element and all of its ancestors are shown. */
  get visible() { for (let x = this; x; x = x.parentNode) { if (x.hidden) { return false; } } return true; }
}

/** The static body markup of PdfEditorProvider.bodyHtml(). */
function makeDocument(opts) {
  const doc = { activeElement: null, listeners: {}, readyState: 'complete' };
  doc.createElement = (tag) => new FakeEl(tag, doc);
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.getElementById = (id) => doc.body.find((e) => e.id === id)[0] || null;
  doc.addEventListener = (t, f) => { (doc.listeners[t] = doc.listeners[t] || []).push(f); };
  doc.fire = (t, ev) => { (doc.listeners[t] || []).slice().forEach((f) => f(ev)); return ev; };
  doc.hasFocus = () => true;
  const mk = (id, cls) => { const e = doc.createElement('div'); e.id = id; e.className = cls; return e; };
  const app = mk('office-app', 'office-app');
  app.setAttribute('data-pdfjs-base', opts.base || 'https://webview.test/media/pdfjs/');
  app.setAttribute('data-cache-bust', '1234');
  if (opts.defaultZoom) { app.setAttribute('data-default-zoom', opts.defaultZoom); }
  app.appendChild(mk('office-toolbar', 'office-toolbar'));
  app.appendChild(mk('office-banner', 'office-banner'));
  app.appendChild(mk('office-content', 'office-content pdf-backdrop'));
  doc.body.appendChild(app);
  const brand = mk('office-brand', '');
  brand.hidden = true;
  const btn = doc.createElement('button');
  btn.id = 'btn-about';
  brand.appendChild(btn);
  doc.body.appendChild(brand);
  return doc;
}

/** A pdf.js document stub. `over` replaces any method. */
function makePdf(numPages, over) {
  return Object.assign({
    numPages,
    getPageLabels: async () => null,
    getMetadata: async () => ({ info: {} }),
    getJSActions: async () => null,
    getFieldObjects: async () => null,
    getAttachments: async () => null,
    getSignatures: async () => null,
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: 'Hello' }] }),
      getJSActions: async () => null,
      getAnnotations: async () => [],
    }),
  }, over || {});
}

/**
 * Stub of the `PdfjsBundle` global. `plan` is a queue: each getDocument() takes the next entry
 * `{ pdf } | { fail: Error } | { pdf, password: 'secret' } | { hang: true }`.
 */
function makeBundle(log) {
  class EventBus {
    constructor() { this.l = {}; }
    on(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    dispatch(t, d) { (this.l[t] || []).slice().forEach((f) => f(d)); }
  }
  class PDFLinkService {
    constructor(o) { log.linkServiceOptions = o; log.linkService = this; this.docs = []; }
    setViewer(v) { this.viewer = v; }
    setDocument(d, base) { this.docs.push([d, base]); }
  }
  class PDFFindController { constructor(o) { log.findOptions = o; } }
  const PRESETS = { 'auto': 1.1, 'page-actual': 1, 'page-fit': 0.6, 'page-width': 1.3 };
  class PDFViewer {
    constructor(o) {
      log.viewerOptions.push(o);
      log.viewers.push(this);
      this.o = o; this.eventBus = o.eventBus; this.doc = null;
      this._scale = 1; this._value = null; this._page = 1; this._rot = 0; this.updates = 0;
    }
    setDocument(d) {
      log.setDocument.push(d);
      this.doc = d;
      if (d) { this._page = 1; this._rot = 0; this.eventBus.dispatch('pagesinit', { source: this }); }
    }
    get currentPageNumber() { return this._page; }
    set currentPageNumber(n) {
      if (!this.doc || n < 1 || n > this.doc.numPages) { return; }
      this._page = n;
      this.eventBus.dispatch('pagechanging', { source: this, pageNumber: n });
    }
    get currentScale() { return this._scale; }
    get currentScaleValue() { return this._value; }
    set currentScaleValue(v) {
      if (!this.doc) { return; }
      const preset = PRESETS[v];
      this._value = String(v);
      this._scale = preset !== undefined ? preset : Number(v);
      this.eventBus.dispatch('scalechanging', { source: this, scale: this._scale, presetValue: preset !== undefined ? String(v) : undefined });
    }
    get pagesRotation() { return this._rot; }
    set pagesRotation(r) { this._rot = r; this.eventBus.dispatch('rotationchanging', { source: this, pagesRotation: r }); }
    scrollPageIntoView(a) { log.scrolls.push(a); this._page = a.pageNumber; }
    setPageLabels(l) { this.labels = l; }
    updateScale(a) { log.updateScale.push(a); this.currentScaleValue = String(Math.round(this._scale * a.scaleFactor * 100) / 100); }
    update() { this.updates++; }
  }
  const lib = {
    AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
    AnnotationEditorType: { DISABLE: -1, NONE: 0 },
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    GlobalWorkerOptions: { workerPort: null },
    normalizeUnicode: (s) => s.normalize('NFKC'),
    getDocument(options) {
      log.getDocument.push(options);
      const step = log.plan.shift() || { pdf: makePdf(3) };
      let resolve, reject;
      const task = {
        step, destroyed: 0, onPassword: null,
        promise: new Promise((res, rej) => { resolve = res; reject = rej; }),
        _worker: { port: step.fakeWorker ? {} : lib.GlobalWorkerOptions.workerPort },
        destroy: async () => { task.destroyed++; reject(new Error('Loading aborted')); },
        resolve, reject,
      };
      task.promise.catch(() => {});
      log.tasks.push(task);
      const fail = (name, message) => { const e = new Error(message); e.name = name; reject(e); };
      Promise.resolve().then(() => {
        if (step.hang) { return; }
        if (step.fail) { reject(step.fail); return; }
        if (step.password === undefined) { resolve(step.pdf); return; }
        const update = (pw) => {
          log.passwordsTried.push(typeof pw === 'string' ? pw : '(error)');
          if (typeof pw !== 'string') { fail('PasswordException', 'Incorrect Password'); return; }
          if (pw === step.password) { resolve(step.pdf); return; }
          task.onPassword(update, 2);
        };
        if (!task.onPassword) { fail('PasswordException', 'No password given'); return; }
        task.onPassword(update, 1);
      });
      return task;
    },
  };
  return { pdfjsLib: lib, pdfjsViewer: { EventBus, PDFLinkService, PDFFindController, PDFViewer } };
}

/**
 * Builds the sandbox and the shell (not started). Options:
 *   engine: { withResolvers, cssRound, wasm, offscreen, worker, bundle } — false removes that feature
 *   state: what vscode.getState() returns; bundle(log, stub): returns the bundle to use instead of the stub;
 *   base; defaultZoom; fetch(url)
 */
function setup(opts = {}) {
  const engine = Object.assign({ withResolvers: true, cssRound: true, wasm: true, offscreen: true, worker: true, bundle: true }, opts.engine);
  const log = {
    plan: [], getDocument: [], tasks: [], viewerOptions: [], viewers: [], setDocument: [], scrolls: [], updateScale: [],
    passwordsTried: [], fetches: [], workers: [], blobs: [], states: [], warnings: [], errors: [],
  };
  const posted = [];
  const document = makeDocument(opts);
  const timers = [];
  const win = { listeners: {} };
  win.addEventListener = (t, f) => { (win.listeners[t] = win.listeners[t] || []).push(f); };
  win.fire = (t, ev) => { (win.listeners[t] || []).slice().forEach((f) => f(ev)); return ev; };
  win.setTimeout = (f) => { timers.push(f); return timers.length; };
  win.clearTimeout = () => {};
  win.console = { warn: (...a) => log.warnings.push(a.join(' ')), error: (...a) => log.errors.push(a.join(' ')), log() {} };
  win.Promise = engine.withResolvers ? { withResolvers() {} } : {};
  win.CSS = { supports: (p, v) => engine.cssRound && p === 'width' && /^round\(/.test(v) };
  if (engine.wasm) { win.WebAssembly = {}; }
  if (engine.offscreen) { win.OffscreenCanvas = function OffscreenCanvas() {}; }
  win.URL = { createObjectURL: (b) => { log.blobs.push(b); return 'blob:test/' + log.blobs.length; }, revokeObjectURL() {} };
  win.Blob = function Blob(parts, o) { this.parts = parts; this.type = o && o.type; };
  win.Worker = function Worker(url, o) {
    if (!engine.worker) { throw new Error('Worker is not available'); }
    this.url = url; this.options = o; this.listeners = {}; this.terminated = false;
    this.addEventListener = (t, f) => { (this.listeners[t] = this.listeners[t] || []).push(f); };
    this.terminate = () => { this.terminated = true; };
    log.workers.push(this);
  };
  win.fetch = async (url) => { log.fetches.push(url); return opts.fetch ? opts.fetch(url) : { ok: true, status: 200, text: async () => '/* worker */' }; };
  win.AbortController = function AbortController() { const s = { aborted: false }; this.signal = s; this.abort = () => { s.aborted = true; }; };
  let selection = null;
  win.getSelection = () => selection;
  if (engine.bundle) { win.PdfjsBundle = opts.bundle ? opts.bundle(log, makeBundle(log)) : makeBundle(log); }

  const vscode = {
    postMessage: (m) => posted.push(m),
    getState: () => opts.state,
    setState: (s) => log.states.push(JSON.parse(JSON.stringify(s))),
  };
  // `Error` is the host realm's so that a real pdf.js (pdfViewerReal.test.mjs) recognises it.
  const sandbox = { window: win, document, console: win.console, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, Error };
  vm.createContext(sandbox);
  vm.runInContext(SOURCES.common, sandbox, { filename: 'officeCommon.js' });
  vm.runInContext(SOURCES.math, sandbox, { filename: 'pdfViewMath.js' });
  vm.runInContext(SOURCES.viewer, sandbox, { filename: 'pdfViewer.js' });
  const api = win.PdfViewer;
  const VM = sandbox.PdfViewMath;
  const shell = api.create({ window: win, document, vscode, OfficeCommon: win.OfficeCommon, PdfViewMath: VM });

  /** Runs another media script in the same sandbox (after the shell exists as PdfViewerShell). */
  const runScript = (name) => { win.PdfViewerShell = shell; win.document = document; win.PdfViewMath = VM; return vm.runInContext(read(name), sandbox, { filename: name }); };
  const byClass = (cls) => document.body.find((e) => e.className.split(' ').indexOf(cls) >= 0)[0] || null;
  const t = {
    sandbox, runScript, api, shell, log, posted, document, win, timers, VM, byClass,
    /** Deliver a host message. */
    send: (msg) => win.fire('message', { data: msg }),
    /** Let pending promise chains settle. */
    tick: async (n = 5) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } },
    runTimers: () => { timers.splice(0).forEach((f) => f()); },
    types: () => posted.map((m) => m.type),
    last: (type) => posted.filter((m) => m.type === type).pop(),
    setSelection: (text, anchorNode) => { selection = text === null ? null : { toString: () => text, anchorNode }; },
    key(key, over) {
      const ev = Object.assign({ key, target: document.body, prevented: false, preventDefault() { ev.prevented = true; } }, over);
      win.fire('keydown', ev);
      return ev;
    },
    get main() { return byClass('pdf-main'); },
    get container() { return byClass('pdf-container'); },
    get toolbar() { return byClass('pdf-toolbar'); },
    button: (label) => document.body.find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === label)[0] || null,
    get pageInput() { return byClass('pdf-page-input'); },
    get pageCount() { return byClass('pdf-page-count'); },
    get zoomSelect() { return byClass('pdf-zoom-select'); },
    get password() { return byClass('pdf-password'); },
    get errorView() { return byClass('office-error'); },
    get live() { return document.body.find((e) => e.getAttribute('aria-live') === 'polite')[0]; },
    get viewer() { return log.viewers[log.viewers.length - 1]; },
    initMsg: (over) => Object.assign({
      type: 'init', kind: 'pdf', fileName: 'a.pdf', version: 0, canEdit: false, readOnlyReason: null, editMode: false, notices: [],
    }, over),
    /** start + init + pdfDocument(generation) with `step` as the next getDocument outcome. */
    async open(step, generation = 1) {
      if (step) { log.plan.push(step); }
      shell.start();
      t.send(t.initMsg());
      t.send({ type: 'pdfDocument', generation, version: 0, bytes: new Uint8Array([37, 80, 68, 70, 45]) });
      await t.tick();
      return t;
    },
    htmlWrites: () => document.body.find(() => true).reduce((n, e) => n + e.htmlWrites, 0),
  };
  return t;
}

module.exports = { setup, makePdf, makeBundle, FakeEl, SOURCES };
