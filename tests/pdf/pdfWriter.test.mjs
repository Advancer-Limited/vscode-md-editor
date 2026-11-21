// PWP-19: the writer service media/pdfWriter.js (spec §6.4 steps 1-4).
// Real pdf.js (Node, fake worker) behind a Node engine for the sequencing/isolation tests; the shell is a minimal fake
// with the members the writer reads (pdfDocument, phase, generation, on, post). The browser-only part (own Worker per
// write) is covered with a recording engine here and by pdfWriterShell.test.js; a real browser Worker is not exercised by npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { core, fixture, allFixtures } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const W = require('../../media/pdfWriter.js');
const S = core.state, SA = core.storageAdapter, V = core.verify, C = core.classify;
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (u8) => crypto.createHash('sha256').update(u8).digest('hex');
const AUTHOR = 'Writer Tester';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
const skipWriter = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13) ? false : 'pdf.js saveDocument() needs Node >= 22.13';
if (skipWriter) console.warn(`pdfWriter: SKIPPED (${skipWriter}; running ${process.versions.node})`);
const T = (name, fn) => test(name, { skip: skipWriter }, fn);

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const openOpts = (data) => ({
  data, verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
  cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
});

/** A Node engine over real pdf.js, with hooks for the failure tests. */
function nodeEngine(hooks = {}) {
  const log = { sessions: [], opened: 0, closed: 0, order: [] };
  return {
    log,
    async createSession() {
      const s = { disposed: false, opened: 0 };
      log.sessions.push(s);
      return {
        async open(bytes) {
          log.order.push('open');
          if (hooks.beforeOpen) { await hooks.beforeOpen(s, bytes); }
          const task = pdfjsLib.getDocument(openOpts(new Uint8Array(bytes)));
          const doc = await task.promise;
          s.opened++; log.opened++;
          if (hooks.wrapDoc) { hooks.wrapDoc(doc, s.opened); }
          return { doc, async close() { log.closed++; log.order.push('close'); await task.destroy(); } };
        },
        dispose() { s.disposed = true; log.order.push('dispose'); },
      };
    },
  };
}

/** The shell members the writer uses. `post` records replies. */
async function makeShell(bytes, over = {}) {
  const task = pdfjsLib.getDocument(openOpts(bytes.slice()));
  const doc = await task.promise;
  const listeners = {};
  const posted = [];
  const shell = Object.assign({
    pdfDocument: doc, phase: 'ready', generation: 1, version: 0,
    on(type, cb) { (listeners[type] = listeners[type] || []).push(cb); return () => { listeners[type] = listeners[type].filter((f) => f !== cb); }; },
    post(m) { posted.push(m); },
  }, over);
  return { shell, doc, task, posted, send: (m) => (listeners.message || []).slice().forEach((f) => f(m)), close: () => task.destroy() };
}
const replyFor = async (t, rid) => { for (let i = 0; i < 4000 && !t.posted.some((m) => m.requestId === rid); i++) { await sleep(5); } return t.posted.find((m) => m.requestId === rid); };

// ---------------------------------------------------------------- state -> entries (the host side)

const DATE0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const quadAt = (pg, k) => {
  const b = pg.cropBox ?? pg.mediaBox;
  const top = b.y1 - 90 - 26 * k, left = b.x0 + 60;
  return [left, top, left + 180, top, left, top - 14, left + 180, top - 14];
};
const hl = (pages, page, k, comment = '', color = 'yellow') => ({ op: 'addAnnotation', spec: { kind: 'highlight', localId: 100 + k + 10 * page, page, quads: quadAt(pages[page], k), color, comment } });
const inkOp = (pages, page) => {
  const b = pages[page].mediaBox;
  return { op: 'addAnnotation', spec: { kind: 'ink', localId: 900 + page, page, color: 'red', width: 2, comment: 'ink ✓', paths: [[b.x0 + 80, b.y0 + 300, b.x0 + 120, b.y0 + 340, b.x0 + 160, b.y0 + 300]] } };
};
function build(base, ops, extraCtx) {
  const cls = C.classifySync(base);
  assert.ok(cls.editable, cls.detail);
  const ctx = extraCtx ? { ...cls.context, ...extraCtx } : cls.context;
  const state = S.emptyState();
  let t = 0;
  const env = { now: () => new Date(DATE0 + 1000 * t++).toISOString(), baseline: new Map() };
  for (const op of ops(cls)) { const p = S.applyEdit(state, op, ctx, env); assert.ok(p.ok, JSON.stringify(p.error)); }
  const storage = JSON.parse(JSON.stringify(SA.toStorageEntries(state, { deletable: cls.context.deletable, pages: cls.context.pages, author: AUTHOR })));
  return { cls, state, storage };
}
let rid = 1;
const request = (shell, storage, over = {}) => ({ type: 'pdfWrite', requestId: rid++, generation: shell.generation, version: 3, storage, ...over });
const verdict = (sc, res) => V.verifySaveSync({ base: sc.base, out: res.bytes, classification: sc.cls, state: sc.state, author: AUTHOR, observed: res.observed });

// ---------------------------------------------------------------- real writes verified by the host verifier

const EDITABLE = allFixtures().filter((f) => { try { return C.classifySync(fixture(f)).editable; } catch { return false; } });

T('every editable fixture: a highlight + comment written by the service passes verifySaveSync with the reported observed', async () => {
  assert.ok(EDITABLE.length >= 15, `editable fixtures: ${EDITABLE.length}`);
  for (const fx of EDITABLE) {
    const base = fixture(fx);
    const sc = { base, ...build(base, (cls) => [hl(cls.context.pages, 0, 0, 'Comment: café 日本語')]) };
    const t = await makeShell(base);
    const w = W.create(t.shell, { engine: nodeEngine() });
    try {
      const req = request(t.shell, sc.storage);
      t.send(req);
      const res = await replyFor(t, req.requestId);
      assert.equal(res.ok, true, `${fx}: ${res.message}`);
      const v = verdict(sc, res);
      assert.ok(v.ok, `${fx}\n${V.formatFindings(v)}`);
      assert.equal(res.observed.pageCount, sc.cls.pages.length);
      assert.deepStrictEqual(res.observed.annotsPerPage, V.expectedObserved(sc.cls, sc.state).annotsPerPage, `${fx}: annots per page`);
      assert.ok(res.bytes.length > base.length);
    } finally { w.dispose(); await t.close(); }
  }
});

T('mixed edits: ink, removals of existing annotations, field values (text, checkbox, radio, choice) round-trip through observed', async () => {
  const fb = fixture('forms.pdf');
  const wt = await makeShell(fb);
  const wb = (await (await wt.doc.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Widget' && !a.readOnly && a.fieldType !== 'Sig');
  await wt.close();
  const refOf = (i) => SA.parsePdfjsId(i);
  const tx = wb.filter((a) => a.fieldType === 'Tx'), cb = wb.filter((a) => a.checkBox), radios = wb.filter((a) => a.radioButton);
  const combo = wb.filter((a) => a.fieldType === 'Ch' && a.combo), list = wb.filter((a) => a.fieldType === 'Ch' && !a.combo);
  const kinds = new Map(wb.map((a) => [S.refKey(refOf(a.id)), { kind: a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Btn' ? 'button' : 'choice' }]));
  const values = [];
  if (tx[0]) values.push({ ref: refOf(tx[0].id), value: 'Writer value äöü' });
  if (tx[1]) values.push({ ref: refOf(tx[1].id), value: 'Line one\nLine two' });
  if (cb[0]) values.push({ ref: refOf(cb[0].id), value: true });
  radios.forEach((r, i) => values.push({ ref: refOf(r.id), value: i === 1 }));
  if (combo[0]) values.push({ ref: refOf(combo[0].id), value: combo[0].options.at(-1).exportValue });
  if (list[0]) values.push({ ref: refOf(list[0].id), value: list[0].options[Math.min(2, list[0].options.length - 1)].exportValue });
  assert.ok(values.length >= 4, 'forms.pdf has fields');
  const cases = [
    ['annotated.pdf', (cls) => [hl(cls.context.pages, 0, 3, 'x'), inkOp(cls.context.pages, 0), ...[...cls.context.deletable.keys()].map((k) => ({ op: 'removeAnnotation', target: { ref: S.parseRefKey(k) } }))], undefined],
    ['forms.pdf', () => [{ op: 'setFields', values }], { fields: kinds }],
  ];
  for (const [fx, ops, extra] of cases) {
    const base = fixture(fx);
    const sc = { base, ...build(base, ops, extra) };
    const t = await makeShell(base);
    const w = W.create(t.shell, { engine: nodeEngine() });
    try {
      const req = request(t.shell, sc.storage);
      t.send(req);
      const res = await replyFor(t, req.requestId);
      assert.equal(res.ok, true, `${fx}: ${res.message}`);
      const v = verdict(sc, res);
      assert.ok(v.ok, `${fx}\n${V.formatFindings(v)}`);
      if (fx === 'forms.pdf') assert.equal(res.observed.fields.length, values.length, 'every requested field is read back');
    } finally { w.dispose(); await t.close(); }
  }
});

T('an empty storage list writes nothing new (the loaded bytes come back)', async () => {
  const base = fixture('basic.pdf');
  const t = await makeShell(base);
  const w = W.create(t.shell, { engine: nodeEngine() });
  const req = request(t.shell, []);
  t.send(req);
  const res = await replyFor(t, req.requestId);
  assert.equal(res.ok, true);
  assert.equal(sha(res.bytes), sha(base));
  w.dispose(); await t.close();
});

// ---------------------------------------------------------------- the displayed document is never touched

T('the visible document is unchanged by a write: storage empty and unmodified, same bytes, still usable, not destroyed', async () => {
  const base = fixture('annotated.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0, 'c'), ...[...cls.context.deletable.keys()].slice(0, 1).map((k) => ({ op: 'removeAnnotation', target: { ref: S.parseRefKey(k) } }))]);
  const t = await makeShell(base);
  const doc = t.doc;
  const before = { size: doc.annotationStorage.size, modified: doc.annotationStorage.hasModified ?? false, fp: doc.fingerprints.join(), pages: doc.numPages, data: sha(await doc.getData()), annots: (await (await doc.getPage(1)).getAnnotations()).length };
  const engine = nodeEngine();
  const w = W.create(t.shell, { engine });
  const req = request(t.shell, sc.storage);
  t.send(req);
  const res = await replyFor(t, req.requestId);
  assert.equal(res.ok, true, res.message);
  assert.equal(t.shell.pdfDocument, doc);
  assert.equal(doc.annotationStorage.size, 0); assert.equal(before.size, 0);
  assert.equal(doc.annotationStorage.hasModified ?? false, before.modified);
  assert.equal(doc.fingerprints.join(), before.fp);
  assert.equal(sha(await doc.getData()), before.data);
  assert.equal((await (await doc.getPage(1)).getAnnotations()).length, before.annots, 'the viewed page still lists its own annotations');
  assert.equal(doc.numPages, before.pages);
  // a second write starts from the loaded bytes, not from the first write
  const req2 = request(t.shell, []);
  t.send(req2);
  const res2 = await replyFor(t, req2.requestId);
  assert.equal(sha(res2.bytes), sha(base));
  assert.equal(engine.log.opened, engine.log.closed);
  assert.ok(engine.log.sessions.every((s) => s.disposed));
  assert.equal(w.stats().openDocuments, 0);
  w.dispose(); await t.close();
});

T('each write uses its own engine session (own Worker): write document and read-back document, never the viewer\'s', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const t = await makeShell(base);
  const engine = nodeEngine();
  const w = W.create(t.shell, { engine });
  for (let i = 0; i < 3; i++) { const r = request(t.shell, sc.storage); t.send(r); assert.equal((await replyFor(t, r.requestId)).ok, true); }
  assert.equal(engine.log.sessions.length, 3);
  assert.equal(engine.log.opened, 6);
  w.dispose(); await t.close();
});

// ---------------------------------------------------------------- stale and failed writes

T('stale generation, no document, loading phase and malformed requests reply ok:false with a message and open nothing', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const t = await makeShell(base);
  const engine = nodeEngine();
  const w = W.create(t.shell, { engine });
  const bad = [
    request(t.shell, sc.storage, { generation: 0 }),
    request(t.shell, sc.storage, { generation: 2 }),
    request(t.shell, 'nope'),
    request(t.shell, [['k']]),
    request(t.shell, [[1, {}]]),
    request(t.shell, [['k', null]]),
    request(t.shell, [['k', []]]),
    request(t.shell, sc.storage, { generation: -1 }),
    request(t.shell, sc.storage, { version: 1.5 }),
  ];
  for (const r of bad) {
    t.send(r);
    const res = await replyFor(t, r.requestId);
    assert.equal(res.ok, false, JSON.stringify(r).slice(0, 80));
    assert.ok(typeof res.message === 'string' && res.message.length > 0);
  }
  t.shell.phase = 'loading';
  const r1 = request(t.shell, sc.storage); t.send(r1);
  assert.equal((await replyFor(t, r1.requestId)).ok, false);
  t.shell.phase = 'ready';
  const keep = t.shell.pdfDocument; t.shell.pdfDocument = null;
  const r2 = request(t.shell, sc.storage); t.send(r2);
  assert.match((await replyFor(t, r2.requestId)).message, /No document/);
  t.shell.pdfDocument = keep;
  assert.equal(engine.log.sessions.length, 0, 'nothing was opened for a refused request');
  const good = request(t.shell, sc.storage); t.send(good);
  assert.equal((await replyFor(t, good.requestId)).ok, true);
  w.dispose(); await t.close();
});

T('a request whose requestId is unusable still gets a reply', async () => {
  const t = await makeShell(fixture('basic.pdf'));
  const w = W.create(t.shell, { engine: nodeEngine() });
  t.send({ type: 'pdfWrite', requestId: 'x', generation: 1, version: 0, storage: [] });
  await sleep(50);
  assert.equal(t.posted.length, 1);
  assert.equal(t.posted[0].ok, false);
  w.dispose(); await t.close();
});

T('engine failures reply ok:false, close every document and dispose the session; the next request works', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const modes = {
    'open fails': { beforeOpen: async (s) => { if (s.opened === 0 && !s.failedOnce) { s.failedOnce = true; throw new Error('boom open'); } } },
    'save fails': { wrapDoc: (doc, n) => { if (n === 1) { doc.saveDocument = async () => { throw new Error('boom save'); }; } } },
    'read-back fails': { wrapDoc: (doc, n) => { if (n === 2) { doc.getPage = async () => { throw new Error('boom read'); }; } } },
  };
  for (const [name, hooks] of Object.entries(modes)) {
    const t = await makeShell(base);
    const engine = nodeEngine(hooks);
    const w = W.create(t.shell, { engine });
    const r = request(t.shell, sc.storage); t.send(r);
    const res = await replyFor(t, r.requestId);
    assert.equal(res.ok, false, name);
    assert.match(res.message, /boom/, name);
    assert.equal(w.stats().openDocuments, 0, name);
    assert.ok(engine.log.sessions.every((s) => s.disposed), name);
    assert.equal(engine.log.opened, engine.log.closed, name);
    w.dispose(); await t.close();
  }
  // the worker file cannot be read: the engine's createSession throws once, the next request works
  const t = await makeShell(base);
  const engine = nodeEngine();
  const orig = engine.createSession;
  engine.createSession = async () => { engine.createSession = orig; throw new Error('boom worker'); };
  const w = W.create(t.shell, { engine });
  const r = request(t.shell, sc.storage); t.send(r);
  const res = await replyFor(t, r.requestId);
  assert.equal(res.ok, false); assert.match(res.message, /boom worker/);
  const r2 = request(t.shell, sc.storage); t.send(r2);
  assert.equal((await replyFor(t, r2.requestId)).ok, true, 'the next request after a failure');
  w.dispose(); await t.close();
});

T('a hung engine times out with ok:false, documents closed and the session disposed', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const t = await makeShell(base);
  const engine = nodeEngine({ wrapDoc: (doc, n) => { if (n === 1) { doc.saveDocument = () => new Promise(() => {}); } } });
  const w = W.create(t.shell, { engine, timeoutMs: () => 150 });
  const r = request(t.shell, sc.storage); t.send(r);
  const res = await replyFor(t, r.requestId);
  assert.equal(res.ok, false);
  assert.match(res.message, /in time/);
  assert.equal(w.stats().openDocuments, 0);
  assert.ok(engine.log.sessions.every((s) => s.disposed));
  w.dispose(); await t.close();
});

T('a generation change while writing fails the write (stale) instead of replying with old bytes', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const t = await makeShell(base);
  const engine = nodeEngine({ wrapDoc: (doc, n) => { if (n === 1) { const orig = doc.saveDocument.bind(doc); doc.saveDocument = async () => { t.shell.generation = 2; return orig(); }; } } });
  const w = W.create(t.shell, { engine });
  const r = request(t.shell, sc.storage); t.send(r);
  const res = await replyFor(t, r.requestId);
  assert.equal(res.ok, false);
  assert.match(res.message, /changed|older/);
  assert.equal(w.stats().openDocuments, 0);
  w.dispose(); await t.close();
});

T('requests are answered one at a time, in order; a failed one does not block the next', async () => {
  const base = fixture('basic.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0)]);
  const t = await makeShell(base);
  const engine = nodeEngine({ beforeOpen: async (s) => { await sleep(s.opened === 0 ? 40 : 0); } });
  const w = W.create(t.shell, { engine });
  const a = request(t.shell, sc.storage), b = request(t.shell, sc.storage, { generation: 99 }), c = request(t.shell, sc.storage);
  t.send(a); t.send(b); t.send(c);
  await replyFor(t, c.requestId);
  assert.deepStrictEqual(t.posted.map((m) => m.requestId), [a.requestId, b.requestId, c.requestId]);
  assert.deepStrictEqual(t.posted.map((m) => m.ok), [true, false, true]);
  assert.equal(engine.log.order.join(','), 'open,close,open,close,dispose,open,close,open,close,dispose');
  w.dispose(); await t.close();
});

T('messages other than pdfWrite are ignored; dispose() stops listening', async () => {
  const t = await makeShell(fixture('basic.pdf'));
  const w = W.create(t.shell, { engine: nodeEngine() });
  t.send({ type: 'pdfState', state: {} });
  await sleep(20);
  assert.equal(t.posted.length, 0);
  w.dispose();
  t.send({ type: 'pdfWrite', requestId: 1, generation: 1, version: 0, storage: [] });
  await sleep(20);
  assert.equal(t.posted.length, 0);
  await t.close();
});

// ---------------------------------------------------------------- memory

T('memory: a large-file write keeps no extra copies and repeated writes do not accumulate', async (t0) => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const base = fixture('large.pdf');
  const sc = build(base, (cls) => [hl(cls.context.pages, 0, 0, 'c')]);
  const t = await makeShell(base);
  const engine = nodeEngine();
  const w = W.create(t.shell, { engine });
  const run = async () => { const r = request(t.shell, sc.storage); t.send(r); const res = await replyFor(t, r.requestId); assert.equal(res.ok, true, res.message); t.posted.length = 0; };
  await run(); gc(); await sleep(50); gc();
  const start = process.memoryUsage().arrayBuffers;
  for (let i = 0; i < 6; i++) await run();
  gc(); await sleep(50); gc();
  const grown = process.memoryUsage().arrayBuffers - start;
  t0.diagnostic(`large.pdf ${base.length} bytes; arrayBuffers grew ${grown} bytes over 6 writes`);
  assert.ok(grown < 2 * base.length, `retained ${grown} bytes after 6 writes of a ${base.length}-byte file`);
  assert.equal(w.stats().openDocuments, 0);
  assert.equal(engine.log.opened, engine.log.closed);
  w.dispose(); await t.close();
});

test('pure helpers: requested fields, widget read-back values, request shape', () => {
  const m = W.requestedFields([['12R', { value: 'a' }], ['7R3', { value: true }], ['pdfjs_internal_editor_1', { annotationType: 9 }], ['weird', { x: 1 }]]);
  assert.deepStrictEqual([...m.entries()], [['12R', { num: 12, gen: 0 }], ['7R3', { num: 7, gen: 3 }]]);
  assert.equal(W.widgetValue({ checkBox: true, fieldValue: 'Yes', exportValue: 'Yes' }), true);
  assert.equal(W.widgetValue({ checkBox: true, fieldValue: 'Off', exportValue: 'Yes' }), false);
  assert.equal(W.widgetValue({ radioButton: true, fieldValue: 'b', buttonValue: 'b' }), true);
  assert.equal(W.widgetValue({ fieldType: 'Ch', fieldValue: ['x'], multiSelect: false }), 'x');
  assert.deepStrictEqual(W.widgetValue({ fieldType: 'Ch', fieldValue: ['x', 'y'], multiSelect: true }), ['x', 'y']);
  assert.equal(W.widgetValue({ fieldType: 'Tx', fieldValue: 'hello' }), 'hello');
  assert.equal(W.widgetValue({ fieldType: 'Tx' }), '');
  assert.equal(W.badRequest({ requestId: 1, generation: 1, version: 1, storage: [] }), null);
});
