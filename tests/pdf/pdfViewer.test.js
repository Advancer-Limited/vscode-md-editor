// PWP-08: the PDF viewer core (media/pdfViewer.js) in node:vm with a DOM shim and a stubbed
// `PdfjsBundle` (tests/pdf/_viewerHarness.cjs). The real pdf.js is exercised by pdfViewerReal.test.mjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setup, makePdf, SOURCES } = require('./_viewerHarness.cjs');

// Values created inside the vm context have a foreign Object prototype; compare structurally.
const deq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
const eq = assert.strictEqual;

// ---------- static rules ----------

test('the §9.4 sentences are the ones of PDF_VIEWER_TEXT in src/pdf/loadErrors.ts', () => {
  const ts = fs.readFileSync(path.join(__dirname, '../../src/pdf/loadErrors.ts'), 'utf8');
  const block = ts.slice(ts.indexOf('export const PDF_VIEWER_TEXT'));
  const table = {};
  for (const m of block.matchAll(/^\s+(\w+): (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),$/gm)) { table[m[1]] = m[2] !== undefined ? m[2] : m[3]; }
  const { api } = setup();
  deq(Object.keys(api.TEXT).sort(), Object.keys(table).sort());
  for (const k of Object.keys(table)) { eq(api.TEXT[k], table[k], k); }
});

test('no HTML string building, no style attributes, no injected <style>, nothing that runs document scripts', () => {
  const code = SOURCES.viewer.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', '.style.', '.style[', "'style'", '"style"',
    'cssText', 'eval(', 'new Function', 'PDFScriptingManager', 'enableScripting', 'hasJSActions(', 'location.href', 'window.open', '.open(']) {
    assert.ok(!code.includes(banned), `media/pdfViewer.js must not contain ${banned}`);
  }
  const css = fs.readFileSync(path.join(__dirname, '../../media/pdfViewer.css'), 'utf8');
  assert.ok(!/url\(|@import|expression\(/i.test(css));
});

// ---------- boot ----------

test('boot order: ready, then pdfRequestDocument after init, then the worker and getDocument with exactly the specified options', async () => {
  const t = setup();
  t.shell.start();
  deq(t.posted, [{ type: 'ready' }]);
  eq(t.log.fetches.length, 0);
  eq(t.log.viewers.length, 0, 'pdf.js is not touched before a document arrives');

  t.send(t.initMsg());
  deq(t.types(), ['ready', 'pdfRequestDocument']);

  const pdf = makePdf(3);
  t.log.plan.push({ pdf });
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes });
  await t.tick();

  deq(t.log.fetches, ['https://webview.test/media/pdfjs/pdf.worker.min.mjs?v=1234']);
  eq(t.log.workers.length, 2, 'the engine probe and the real worker');
  const worker = t.log.workers[1];
  deq(worker.options, { type: 'module' });
  assert.ok(/^blob:/.test(worker.url));
  eq(t.win.PdfjsBundle.pdfjsLib.GlobalWorkerOptions.workerPort, worker);

  eq(t.log.getDocument.length, 1);
  const o = t.log.getDocument[0];
  eq(o.data, bytes, 'the bytes are handed over as received (a plain Uint8Array)');
  const B = 'https://webview.test/media/pdfjs/';
  deq(Object.assign({}, o, { data: null }), {
    data: null, cMapUrl: B + 'cmaps/', cMapPacked: true, standardFontDataUrl: B + 'standard_fonts/', wasmUrl: B + 'wasm/',
    iccUrl: B + 'iccs/', enableXfa: false, useWorkerFetch: false, disableRange: true, disableStream: true, disableAutoFetch: true,
  });
  assert.ok(!('enableScripting' in o) && !('password' in o) && !('url' in o));

  eq(t.log.viewerOptions.length, 1);
  const vo = t.log.viewerOptions[0];
  deq(Object.keys(vo).sort(), ['abortSignal', 'annotationEditorMode', 'annotationMode', 'container', 'eventBus', 'findController',
    'imageResourcesPath', 'linkService', 'textLayerMode', 'viewer']);
  eq(vo.annotationMode, 3, 'ENABLE_STORAGE in View mode');
  eq(vo.annotationEditorMode, -1);
  eq(vo.textLayerMode, 1);
  eq(vo.imageResourcesPath, B + 'images/');
  eq(vo.container, t.container);
  eq(vo.container.tagName, 'DIV');
  eq(vo.viewer.className, 'pdfViewer');
  eq(vo.viewer.parentNode, vo.container);

  deq(t.log.setDocument.filter(Boolean), [pdf]);
  eq(t.log.linkService.docs.at(-1)[0], pdf);
  eq(t.log.linkService.docs.at(-1)[1], null);
  eq(t.shell.phase, 'ready');
  eq(t.shell.pdfDocument, pdf);
  eq(t.shell.diagnostics().workerIsOurs, true);

  deq(t.last('pdfFacts'), { type: 'pdfFacts', generation: 1, facts: {
    pageCount: 3, encrypted: false, hasText: true, hasJavaScript: false, hasXfa: false, attachmentCount: 0, signatures: [] } });
  eq(t.htmlWrites(), 0);
});

test('a document served by anything but our worker is reported (main-thread fallback detection)', async () => {
  const t = await setup().open({ pdf: makePdf(1), fakeWorker: true });
  eq(t.shell.diagnostics().workerIsOurs, false);
  assert.ok(t.log.warnings.some((w) => /dedicated worker/.test(w)));
});

test('a worker file that cannot be read gives the unexpected-error view (not "newer VS Code"), with Retry', async () => {
  const t = await setup({ fetch: () => ({ ok: false, status: 404, text: async () => '' }) }).open();
  eq(t.log.getDocument.length, 0);
  eq(t.shell.phase, 'failed');
  eq(t.errorView.find((e) => e.tagName === 'H2')[0].textContent, t.api.TEXT.damaged);
  assert.ok(/HTTP 404/.test(t.errorView.textContent));
  deq(t.errorView.find((e) => e.tagName === 'BUTTON').map((b) => b.getAttribute('data-action')), ['openExternally', 'retry']);
});

test('a worker that errors while loading fails the load (unexpected-error view) and is replaced on the next load', async () => {
  const t = await setup().open({ hang: true });
  eq(t.shell.phase, 'loading');
  const dead = t.log.workers[1];
  (dead.listeners.error || []).forEach((f) => f({ message: 'boom' }));
  await t.tick();
  eq(t.shell.phase, 'failed');
  eq(t.errorView.find((e) => e.tagName === 'H2')[0].textContent, t.api.TEXT.damaged);
  assert.ok(/boom/.test(t.errorView.textContent));
  // Retry: a new generation gets a new worker; the dead one is terminated.
  t.log.plan.push({ pdf: makePdf(2) });
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 2, version: 0, bytes: new Uint8Array([37, 80, 68, 70, 45]) });
  await t.tick(10);
  eq(t.shell.phase, 'ready');
  eq(t.log.workers.length, 3, 'a new worker was made');
  eq(dead.terminated, true);
  eq(t.log.fetches.length, 2);
  eq(t.shell.diagnostics().workerIsOurs, true);
});

test('a worker error after the document is shown keeps it, and the next load uses a new worker', async () => {
  const t = await setup().open({ pdf: makePdf(2) });
  const first = t.log.workers[1];
  (first.listeners.error || []).forEach((f) => f({ message: 'late' }));
  eq(t.shell.phase, 'ready');
  t.log.plan.push({ pdf: makePdf(3) });
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array([37, 80, 68, 70, 45]) });
  await t.tick(10);
  eq(t.shell.pageCount, 3);
  eq(t.log.workers.length, 3);
  eq(first.terminated, true);
  // An error from the replaced worker no longer affects anything.
  (first.listeners.error || []).forEach((f) => f({ message: 'stale' }));
  eq(t.shell.phase, 'ready');
});

test('pdfFacts carries the generation it was collected for', async () => {
  const t = await setup().open({ pdf: makePdf(2) }, 7);
  await t.tick(10);
  eq(t.last('pdfFacts').generation, 7);
});

test('the page area is a named region that takes the focus', async () => {
  const t = await setup().open({ pdf: makePdf(1) });
  eq(t.container.getAttribute('role'), 'region');
  eq(t.container.getAttribute('aria-label'), 'PDF pages');
  eq(t.container.getAttribute('tabindex'), '0');
});

// ---------- engine check (spec §10.4) ----------

test('engineProblems names each missing feature', () => {
  const cases = [
    [{}, []],
    [{ withResolvers: false }, ['Promise.withResolvers']],
    [{ cssRound: false }, ['CSS round()']],
    [{ wasm: false }, ['WebAssembly']],
    [{ offscreen: false }, ['OffscreenCanvas']],
    [{ worker: false }, ['module Worker']],
    [{ bundle: false }, ['pdf.js bundle']],
    [{ withResolvers: false, cssRound: false }, ['Promise.withResolvers', 'CSS round()']],
  ];
  for (const [engine, want] of cases) {
    const t = setup({ engine });
    deq(t.api.engineProblems(t.win), want);
  }
  const t = setup();
  deq(t.api.engineProblems({}), ['Promise.withResolvers', 'CSS round()', 'WebAssembly', 'OffscreenCanvas', 'module Worker', 'pdf.js bundle']);
});

test('an engine that is too old shows the error view and never asks for or loads the bytes', async () => {
  for (const engine of [{ withResolvers: false }, { cssRound: false }, { bundle: false }]) {
    const t = setup({ engine });
    t.shell.start();
    deq(t.posted, [{ type: 'ready' }]);
    t.send(t.initMsg());
    t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: new Uint8Array(4) });
    await t.tick();
    deq(t.types(), ['ready'], 'no pdfRequestDocument');
    eq(t.log.getDocument.length, 0);
    eq(t.log.fetches.length, 0);
    assert.ok(t.errorView.visible);
    eq(t.errorView.find((e) => e.tagName === 'H2')[0].textContent, 'The PDF viewer needs a newer version of VS Code.');
    assert.ok(t.errorView.textContent.includes('Missing: '));
    const actions = t.errorView.find((e) => e.tagName === 'BUTTON');
    deq(actions.map((b) => b.textContent), ['Open externally']);
    actions[0].click();
    eq(t.posted.at(-1).type, 'openExternally');
    assert.ok(t.document.body.classList.contains('office-has-error'));
  }
});

// ---------- generations ----------

test('generations: stale and duplicate payloads are dropped; a newer one replaces the document and keeps the place', async () => {
  const first = makePdf(10), second = makePdf(10);
  const t = await setup().open({ pdf: first }, 5);
  eq(t.shell.generation, 5);

  t.send({ type: 'pdfDocument', generation: 4, version: 0, bytes: new Uint8Array(1) });
  t.send({ type: 'pdfDocument', generation: 5, version: 0, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.log.getDocument.length, 1, 'stale (4) and duplicate (5) are ignored');

  // The user is on page 7 at 150 %, rotated.
  t.viewer.currentScaleValue = '1.5';
  t.viewer.pagesRotation = 90;
  t.viewer.eventBus.dispatch('updateviewarea', { location: { pageNumber: 7, rotation: 90, left: 12, top: 640 } });

  // External change: init again, then the new generation.
  t.log.plan.push({ pdf: second });
  t.send(t.initMsg({ version: 1 }));
  eq(t.posted.filter((m) => m.type === 'pdfRequestDocument').length, 2, 'asked after every init');
  t.send({ type: 'pdfDocument', generation: 6, version: 1, bytes: new Uint8Array(2) });
  await t.tick();
  eq(t.log.getDocument.length, 2);
  eq(t.log.tasks[0].destroyed, 1, 'the old document is destroyed through its loading task');
  eq(t.log.setDocument.indexOf(null) < t.log.setDocument.lastIndexOf(second), true);
  eq(t.shell.pdfDocument, second);
  eq(t.shell.generation, 6);
  eq(t.shell.version, 1);
  eq(t.viewer.currentScaleValue, '1.5');
  eq(t.viewer.pagesRotation, 90);
  deq(t.log.scrolls.at(-1), { pageNumber: 7, destArray: [null, { name: 'XYZ' }, 12, 640, null] });
  eq(t.log.workers.length, 2, 'the worker is reused');
});

test('a load overtaken by a newer generation is destroyed and never shown', async () => {
  const late = makePdf(2), winner = makePdf(4);
  const t = setup();
  t.log.plan.push({ hang: true }, { pdf: winner });
  t.shell.start();
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.shell.phase, 'loading');
  t.send({ type: 'pdfDocument', generation: 2, version: 0, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.log.tasks[0].destroyed, 1);
  t.log.tasks[0].resolve(late);     // too late
  await t.tick();
  eq(t.shell.pdfDocument, winner);
  assert.ok(!t.log.setDocument.includes(late));
  eq(t.posted.filter((m) => m.type === 'pdfFacts').length, 1);
});

// ---------- zoom, page box, rotation ----------

test('zoom: default, steps, presets, Ctrl keys, Ctrl+wheel, clamping to 25–500 %', async () => {
  const t = await setup().open({ pdf: makePdf(5) });
  eq(t.viewer.currentScaleValue, 'auto', 'Automatic is the default');
  eq(t.zoomSelect.value, 'auto');
  deq(t.zoomSelect.children.map((o) => o.textContent),
    ['Automatic', 'Actual size', 'Fit page', 'Fit width', '25%', '33%', '50%', '67%', '75%', '100%', '125%', '150%', '200%', '300%', '400%', '500%', '']);

  t.button('Zoom in (Ctrl+=)').click();       // 1.1 (auto) -> next step above
  eq(t.viewer.currentScaleValue, '1.25');
  eq(t.zoomSelect.value, '1.25');
  assert.ok(t.live.textContent.startsWith('Zoom 125%'));
  t.button('Zoom out (Ctrl+-)').click();
  eq(t.viewer.currentScale, 1);

  t.zoomSelect.value = 'page-width';
  t.zoomSelect.fire('change');
  eq(t.viewer.currentScaleValue, 'page-width');
  t.zoomSelect.value = '3';
  t.zoomSelect.fire('change');
  eq(t.viewer.currentScale, 3);

  assert.ok(t.key('=', { ctrlKey: true }).prevented);
  eq(t.viewer.currentScale, 4);
  t.key('+', { metaKey: true });
  eq(t.viewer.currentScale, 5);
  eq(t.button('Zoom in (Ctrl+=)').disabled, true);
  t.key('-', { ctrlKey: true });
  eq(t.viewer.currentScale, 4);
  t.key('0', { ctrlKey: true });
  eq(t.viewer.currentScaleValue, 'auto');

  // Ctrl+wheel zooms around the pointer and never lets the webview itself zoom.
  let prevented = 0;
  const wheel = (deltaY, over) => t.main.fire('wheel', Object.assign({ deltaY, ctrlKey: true, clientX: 40, clientY: 60, preventDefault() { prevented++; } }, over));
  wheel(-100);
  eq(prevented, 1);
  deq(t.log.updateScale.at(-1).origin, [40, 60]);
  assert.ok(t.viewer.currentScale > 1.1 && t.viewer.currentScale < 1.5);
  eq(t.zoomSelect.value, 'custom');
  eq(t.zoomSelect.children.at(-1).hidden, false);
  eq(t.zoomSelect.children.at(-1).textContent, Math.round(t.viewer.currentScale * 100) + '%');
  wheel(100, { ctrlKey: false });
  eq(prevented, 1, 'a plain wheel scrolls');

  // pdf.js itself allows 10 %–2500 % (pinch): the viewer clamps.
  t.viewer.currentScaleValue = '9';
  eq(t.viewer.currentScale, 5);
  t.viewer.currentScaleValue = '0.1';
  eq(t.viewer.currentScale, 0.25);
  eq(t.button('Zoom out (Ctrl+-)').disabled, true);
});

test('fit modes follow the size of the page area; a numeric zoom does not', async () => {
  const t = await setup().open({ pdf: makePdf(5) });
  const seen = [];
  t.viewer.eventBus.on('scalechanging', (e) => seen.push(e.presetValue || e.scale));
  t.win.fire('resize', {});
  deq(seen, ['auto']);
  eq(t.viewer.updates, 1);
  t.viewer.currentScaleValue = '2';
  seen.length = 0;
  t.win.fire('resize', {});
  deq(seen, []);
});

test('the default zoom can be given by the host markup', async () => {
  const t = await setup({ defaultZoom: 'page-fit' }).open({ pdf: makePdf(2) });
  eq(t.viewer.currentScaleValue, 'page-fit');
  const bad = await setup({ defaultZoom: '<b>' }).open({ pdf: makePdf(2) });
  eq(bad.viewer.currentScaleValue, 'auto');
});

test('every page container is a region named "Page N of M" (numbers only, never page labels)', async () => {
  const t = await setup().open({ pdf: makePdf(3, { getPageLabels: async () => ['<b>x</b>', 'ii', 'iii'] }) });
  const attrs = [0, 1, 2].map((i) => t.viewer.getPageView(i).div.attrs);
  deq(attrs.map((a) => a.role), ['region', 'region', 'region']);
  deq(attrs.map((a) => a['aria-label']), ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
});

test('page box: number or label, bad input, previous/next, and labels are only ever text', async () => {
  const labels = ['i', 'ii', '<img src=x onerror=alert(1)>', '1', '2'];
  const t = await setup().open({ pdf: makePdf(5, { getPageLabels: async () => labels }) });
  eq(t.pageInput.value, 'i');
  eq(t.pageCount.textContent, '(1 of 5)');
  eq(t.viewer.labels, labels);
  eq(t.button('Previous page').disabled, true);

  const enter = (text) => { t.pageInput.value = text; return t.pageInput.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} }); };
  enter('4');
  eq(t.viewer.currentPageNumber, 4, 'a number is a physical page');
  eq(t.pageInput.value, '1', 'whose label is "1"');
  eq(t.pageCount.textContent, '(4 of 5)');
  enter('II');
  eq(t.viewer.currentPageNumber, 2, 'labels match case-insensitively');
  assert.ok(t.live.textContent.startsWith('Page ii (2 of 5)'));

  enter('99');
  eq(t.viewer.currentPageNumber, 2);
  eq(t.pageInput.value, 'ii', 'bad input is put back');
  assert.ok(t.byClass('office-hint').textContent.includes('There is no page \u201C99\u201D'));

  t.button('Next page').click();
  eq(t.viewer.currentPageNumber, 3);
  eq(t.pageInput.value, '<img src=x onerror=alert(1)>');
  eq(t.htmlWrites(), 0);
  t.button('Next page').click();
  t.button('Next page').click();
  eq(t.button('Next page').disabled, true);
  t.pageInput.value = '1';
  t.pageInput.fire('change');
  eq(t.viewer.currentPageNumber, 4, '"1" is the label of page 4');

  // Arrow keys in the box stay in the box (the toolbar roves on them); other keys pass.
  let stopped = 0;
  t.pageInput.fire('keydown', { key: 'ArrowLeft', stopPropagation() { stopped++; } });
  t.pageInput.fire('keydown', { key: 'e', ctrlKey: true, stopPropagation() { stopped++; } });
  eq(stopped, 1);
});

test('a document without labels shows "N of M"', async () => {
  const t = await setup().open({ pdf: makePdf(340) });
  t.shell.goToPage(12);
  eq(t.pageInput.value, '12');
  eq(t.pageCount.textContent, 'of 340');
  eq(t.shell.goToPage(9999), true);
  eq(t.viewer.currentPageNumber, 340, 'clamped');
});

test('rotate view: R / Shift+R and the buttons, all pages, announced, never posted to the host', async () => {
  const t = await setup().open({ pdf: makePdf(2) });
  const before = t.posted.length;
  t.button('Rotate view clockwise (R)').click();
  eq(t.viewer.pagesRotation, 90);
  t.key('r');
  eq(t.viewer.pagesRotation, 180);
  t.key('R', { shiftKey: true });
  t.key('R', { shiftKey: true });
  t.button('Rotate view counter-clockwise (Shift+R)').click();
  eq(t.viewer.pagesRotation, 270);
  assert.ok(t.live.textContent.startsWith('View rotated to 270 degrees'));
  eq(t.posted.length, before, 'rotation is a view state only');
});

// ---------- keyboard (spec §10.3) ----------

test('keyboard navigation in the page area', async () => {
  const t = await setup().open({ pdf: makePdf(9) });
  const c = t.container;
  c.clientHeight = 500; c.clientWidth = 800; c.scrollWidth = 800;

  assert.ok(t.key('End').prevented);
  eq(t.viewer.currentPageNumber, 9);
  t.key('Home');
  eq(t.viewer.currentPageNumber, 1);
  t.key('ArrowRight');
  eq(t.viewer.currentPageNumber, 2);
  t.key('ArrowLeft');
  eq(t.viewer.currentPageNumber, 1);

  // Nothing focused: the keys scroll the page area.
  t.key('ArrowDown'); eq(c.scrollTop, 40);
  t.key('ArrowUp'); eq(c.scrollTop, 0);
  t.key('PageDown'); eq(c.scrollTop, 450);
  t.key(' '); eq(c.scrollTop, 900);
  t.key(' ', { shiftKey: true }); eq(c.scrollTop, 450);
  t.key('PageUp'); eq(c.scrollTop, 0);

  // Focus inside the scroll container: the browser scrolls it; we keep out.
  const inside = t.document.createElement('span');
  c.appendChild(inside);
  eq(t.key('PageDown', { target: inside }).prevented, false);
  eq(c.scrollTop, 0);
  assert.ok(t.key('End', { target: inside }).prevented);

  // A page wider than the view: Left/Right scroll sideways instead of turning pages.
  c.scrollWidth = 2000;
  t.key('Home');
  eq(t.key('ArrowRight').prevented, false);
  eq(t.viewer.currentPageNumber, 1);
});

test('shortcuts stay out of text inputs, buttons, the toolbar and the sidebar', async () => {
  const t = await setup().open({ pdf: makePdf(9) });
  const input = t.document.createElement('input');
  t.container.appendChild(input);                 // e.g. a form field on a page
  for (const target of [input, t.pageInput, t.button('Next page'), t.byClass('pdf-sidebar')]) {
    eq(t.key('r', { target }).prevented, false);
    eq(t.key('End', { target }).prevented, false);
    eq(t.key(' ', { target }).prevented, false);
  }
  eq(t.viewer.pagesRotation, 0);
  eq(t.viewer.currentPageNumber, 1);
  eq(t.key('r', { altKey: true }).prevented, false);
  eq(t.key('x').prevented, false);

  // Ctrl+G goes to the page box from anywhere.
  assert.ok(t.key('g', { ctrlKey: true, target: input }).prevented);
  eq(t.document.activeElement, t.pageInput);
  eq(t.pageInput.selected, true);
});

test('before a document is shown the navigation keys do nothing', () => {
  const t = setup();
  t.shell.start();
  for (const k of ['Home', 'End', 'r', ' ', 'PageDown']) { eq(t.key(k).prevented, false); }
  t.key('=', { ctrlKey: true });
  eq(t.log.viewers.length, 0);
});

test('the toolbar is one roving tab stop that never rests on a hidden or disabled button', async () => {
  const t = setup();
  t.shell.start();
  eq(t.toolbar.getAttribute('role'), 'toolbar');
  eq(t.toolbar.getAttribute('aria-label'), 'PDF viewer');
  const stops = () => t.toolbar.find((e) => e.tagName === 'BUTTON' && e.getAttribute('tabindex') === '0');
  eq(stops().length, 1);
  eq(stops()[0].textContent, 'Open externally', 'everything else is hidden or disabled without a document');
  stops()[0].click();
  eq(t.posted.at(-1).type, 'openExternally');
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: new Uint8Array(1) });
  await t.tick();
  eq(stops().length, 1);
  eq(t.button('Toggle sidebar (F4)').hidden, true, 'no panel registered');
  t.document.getElementById('btn-about').click();
  eq(t.posted.at(-1).type, 'showAbout');
  eq(t.document.getElementById('btn-about').parentNode.id, 'office-toolbar');
});

// ---------- password (spec §9.1) ----------

test('password: prompt, wrong password, right password; the password never leaves the webview', async () => {
  const pdf = makePdf(2);
  const t = await setup().open({ pdf, password: 's3cret-\u00FC' });
  eq(t.shell.phase, 'password');
  assert.ok(t.password.visible);
  eq(t.container.hidden, true);
  const input = t.byClass('pdf-password-input');
  const error = t.byClass('pdf-password-error');
  eq(input.getAttribute('type'), 'password');
  eq(input.getAttribute('autocomplete'), 'off');
  eq(error.hidden, true);
  eq(t.document.activeElement, input);
  eq(t.byClass('pdf-password-label').textContent, 'This PDF is password-protected. Enter the password to open it.');
  const submit = t.password.find((e) => e.getAttribute('data-action') === 'submit')[0];

  submit.click();                                   // empty: nothing happens
  deq(t.log.passwordsTried, []);

  input.value = 'wrong';
  submit.click();
  await t.tick();
  deq(t.log.passwordsTried, ['wrong']);
  assert.ok(t.password.visible);
  eq(error.hidden, false);
  eq(error.textContent, 'Incorrect password');
  eq(error.getAttribute('role'), 'alert');
  eq(input.getAttribute('aria-invalid'), 'true');
  eq(input.value, '', 'the box is cleared');

  input.value = 's3cret-\u00FC';
  t.password.fire('keydown', { key: 'Enter', target: input, preventDefault() {}, stopPropagation() {} });
  await t.tick();
  eq(t.shell.phase, 'ready');
  eq(t.shell.pdfDocument, pdf);
  eq(t.password.hidden, true);
  eq(t.container.hidden, false);
  eq(input.value, '');
  eq(t.last('pdfFacts').facts.encrypted, true);

  const wire = JSON.stringify(t.posted) + JSON.stringify(t.log.states);
  assert.ok(!wire.includes('s3cret') && !wire.includes('wrong'), 'no message and no saved state carries a password');
  assert.ok(!('password' in t.log.getDocument[0]));
});

test('password: Cancel (button or Esc) gives the error view; Retry asks the host again', async () => {
  for (const how of ['button', 'escape']) {
    const t = await setup().open({ pdf: makePdf(2), password: 'x' });
    if (how === 'button') { t.password.find((e) => e.getAttribute('data-action') === 'cancel')[0].click(); }
    else { t.password.fire('keydown', { key: 'Escape', target: t.byClass('pdf-password-input'), preventDefault() {}, stopPropagation() {} }); }
    await t.tick();
    eq(t.shell.phase, 'failed');
    eq(t.shell.pdfDocument, null);
    eq(t.password.hidden, true);
    eq(t.errorView.find((e) => e.tagName === 'H2')[0].textContent,
      'This PDF is password-protected. Reopen it to enter the password, or open it externally.');
    eq(t.errorView.find((e) => e.tagName === 'DETAILS').length, 0);
    eq(t.log.tasks[0].destroyed, 1);
    eq(t.posted.filter((m) => m.type === 'pdfFacts').length, 0);
    t.errorView.find((e) => e.getAttribute('data-action') === 'retry')[0].click();
    eq(t.posted.at(-1).type, 'retry');
    // The host reloads: init, then a new generation, and the prompt is back.
    t.log.plan.push({ pdf: makePdf(2), password: 'x' });
    t.send(t.initMsg());
    t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array(1) });
    await t.tick();
    eq(t.shell.phase, 'password');
    assert.ok(!t.document.body.classList.contains('office-has-error'));
    eq(t.byClass('pdf-password-error').hidden, true, 'a fresh prompt does not say "incorrect"');
  }
});

test('password: a reload of the same tab reuses the password silently; a changed password asks again', async () => {
  const t = await setup().open({ pdf: makePdf(2), password: 'pw1' });
  t.byClass('pdf-password-input').value = 'pw1';
  t.password.find((e) => e.getAttribute('data-action') === 'submit')[0].click();
  await t.tick();
  eq(t.shell.phase, 'ready');

  t.log.plan.push({ pdf: makePdf(2), password: 'pw1' });
  t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.shell.phase, 'ready', 'no prompt');
  deq(t.log.passwordsTried, ['pw1', 'pw1']);

  t.log.plan.push({ pdf: makePdf(2), password: 'pw2' });
  t.send({ type: 'pdfDocument', generation: 3, version: 2, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.shell.phase, 'password');
  eq(t.byClass('pdf-password-error').hidden, true, 'the user typed nothing wrong this time');
});

test('viewer shortcuts are off while the password box has the focus', async () => {
  const t = await setup().open({ pdf: makePdf(2), password: 'x' });
  let stopped = 0;
  t.password.fire('keydown', { key: 'r', target: t.byClass('pdf-password-input'), stopPropagation() { stopped++; } });
  eq(stopped, 1);
});

// ---------- links (spec §7.5) ----------

function clickLink(t, href, type = 'click') {
  const a = t.document.createElement('a');
  if (href !== undefined) { a.setAttribute('href', href); }
  const span = t.document.createElement('span');
  a.appendChild(span);
  t.container.appendChild(a);
  const ev = {
    target: span, prevented: false, stopped: false, stoppedNow: false,
    preventDefault() { ev.prevented = true; }, stopPropagation() { ev.stopped = true; }, stopImmediatePropagation() { ev.stoppedNow = true; },
  };
  t.main.fire(type, ev);
  return ev;
}

test('links: http/https/mailto go to the host; everything else is dropped; the webview never navigates', async () => {
  const t = await setup().open({ pdf: makePdf(2) });
  const before = () => t.posted.filter((m) => m.type === 'openLink').map((m) => m.href);

  for (const href of ['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com', ' HTTPS://EXAMPLE.COM/x ']) {
    const ev = clickLink(t, href);
    assert.ok(ev.prevented, href);
    // VS Code's host page opens any <a href> it sees a click on: the event must not get there.
    assert.ok(ev.stopped && ev.stoppedNow, 'propagation stopped: ' + href);
  }
  deq(before(), ['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com', 'HTTPS://EXAMPLE.COM/x']);
  const aux = clickLink(t, 'https://example.com/middle', 'auxclick');
  assert.ok(aux.prevented && aux.stopped && aux.stoppedNow, 'middle click too');
  eq(before().length, 5);

  const hint = t.byClass('office-hint');
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'file:///C:/Windows/notepad.exe', 'notepad.exe', '../other.pdf',
    'vscode://x/y', 'command:workbench.action.terminal.new', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/', 'tel:123',
    '//example.com/protocol-relative', 'blob:https://example.com/1']) {
    hint.textContent = '';
    const ev = clickLink(t, href);
    assert.ok(ev.prevented && ev.stopped, href);
    eq(hint.textContent, 'This link was not opened.', href);
  }
  eq(before().length, 5, 'nothing else was forwarded');

  // Internal destinations: pdf.js's own handler scrolls; we only make sure nothing navigates.
  hint.textContent = '';
  const internal = clickLink(t, '#%5B%7B%22num%22%3A5%7D%5D');
  assert.ok(internal.prevented);
  eq(internal.stopped || internal.stoppedNow, false, 'an internal link still reaches pdf.js');
  assert.ok(clickLink(t, '').prevented);
  eq(hint.textContent, '');
  eq(clickLink(t, undefined).prevented, false, 'an anchor without href goes nowhere');
  eq(before().length, 5);

  // A click that is not on a link is left alone.
  const ev = { target: t.container, prevented: false, preventDefault() { ev.prevented = true; } };
  t.main.fire('click', ev);
  eq(ev.prevented, false);
});

test('the link service is given no base URL and marks external links noopener', async () => {
  const t = await setup().open({ pdf: makePdf(1) });
  eq(t.log.linkServiceOptions.externalLinkRel, 'noopener noreferrer nofollow');
  assert.ok(t.log.linkService.docs.every(([, base]) => base === null));
});

// ---------- copy (spec §7.3) ----------

test('copy sends the page selection through writeClipboard as plain text', async () => {
  const t = await setup().open({ pdf: makePdf(2) });
  const span = t.document.createElement('span');
  t.container.appendChild(span);
  const copy = (over) => {
    const ev = Object.assign({ target: span, prevented: false, stopped: false, preventDefault() { ev.prevented = true; }, stopImmediatePropagation() { ev.stopped = true; } }, over);
    t.document.fire('copy', ev);
    return ev;
  };
  t.setSelection('ﬁrst line\u0000\nsecond', span);
  const ev = copy();
  assert.ok(ev.prevented && ev.stopped);
  deq(t.last('writeClipboard'), { type: 'writeClipboard', text: 'first line\nsecond' });

  const count = () => t.posted.filter((m) => m.type === 'writeClipboard').length;
  t.setSelection('', span);
  eq(copy().prevented, false, 'empty selection');
  t.setSelection('toolbar text', t.toolbar);
  eq(copy().prevented, false, 'a selection outside the page area is the browser\u2019s business');
  t.setSelection('abc', span);
  eq(copy({ target: t.pageInput }).prevented, false, 'copying in an input is native');
  t.setSelection(null);
  eq(copy().prevented, false);
  eq(count(), 1);
});

// ---------- errors (spec §9.4) ----------

test('a file pdf.js rejects shows "damaged" with the technical reason under Details, Open externally and Retry', async () => {
  const fail = new Error('Invalid PDF structure.');
  fail.name = 'InvalidPDFException';
  const t = await setup().open({ fail });
  eq(t.shell.phase, 'failed');
  eq(t.errorView.find((e) => e.tagName === 'H2')[0].textContent, "This file is damaged and can't be displayed.");
  eq(t.errorView.find((e) => e.tagName === 'PRE')[0].textContent, 'InvalidPDFException: Invalid PDF structure.');
  deq(t.errorView.find((e) => e.tagName === 'BUTTON').map((b) => b.textContent), ['Open externally', 'Retry']);
  eq(t.log.tasks[0].destroyed, 1);
  eq(t.log.setDocument.filter(Boolean).length, 0);
  eq(t.posted.filter((m) => m.type === 'pdfFacts').length, 0);
  eq(t.button('Next page').disabled, true);

  // Retry: the host reloads and the next generation opens.
  const pdf = makePdf(1);
  t.log.plan.push({ pdf });
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array(1) });
  await t.tick();
  eq(t.shell.pdfDocument, pdf);
  eq(t.errorView.hidden, true);
});

test('bytes that did not arrive as binary are reported, not thrown', async () => {
  const t = setup();
  t.shell.start();
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 1, version: 0, bytes: 'not bytes' });
  await t.tick();
  eq(t.shell.phase, 'failed');
  assert.ok(t.errorView.textContent.includes('did not arrive in a readable form'));
  const u = t.api.toBytes({ type: 'Buffer', data: [1, 2, 3] });
  deq(Array.from(u), [1, 2, 3]);
});

test('a host loadError closes the open document; malformed payloads are ignored', async () => {
  const t = await setup().open({ pdf: makePdf(3) });
  t.send({ type: 'loadError', title: "This file couldn't be read.", detail: 'ENOENT', actions: ['openExternally', 'retry'] });
  await t.tick();
  eq(t.shell.pdfDocument, null);
  eq(t.shell.phase, 'idle');
  eq(t.log.tasks[0].destroyed, 1);
  eq(t.log.setDocument.at(-1), null);
  assert.ok(t.errorView.visible);
  for (const bad of [{ type: 'pdfDocument' }, { type: 'pdfDocument', generation: 'x', bytes: new Uint8Array(1) }, { type: 'pdfDocument', generation: NaN }, null, 7, { type: 5 }]) {
    t.send(bad);
  }
  await t.tick();
  eq(t.log.getDocument.length, 1);
});

test('a page that fails to render says so; the note goes when the page renders', async () => {
  const t = await setup().open({ pdf: makePdf(3) });
  const seen = [];
  const off = t.shell.onPagesRendered((e) => seen.push([e.pageNumber, !!e.error, e.div === div]));
  const div = t.document.createElement('div');
  const pageView = { div };
  t.viewer.eventBus.dispatch('pagerendered', { source: pageView, pageNumber: 2, error: new Error('bad stream') });
  const notes = () => div.find((e) => e.className === 'pdf-page-error');
  eq(notes().length, 1);
  eq(notes()[0].textContent, "This page couldn't be displayed");
  t.viewer.eventBus.dispatch('pagerendered', { source: pageView, pageNumber: 2, error: new Error('again') });
  eq(notes().length, 1, 'not stacked');
  t.viewer.eventBus.dispatch('pagerendered', { source: pageView, pageNumber: 2, error: null });
  eq(notes().length, 0);
  deq(seen, [[2, true, true], [2, true, true], [2, false, true]]);
  off();
  t.viewer.eventBus.dispatch('pagerendered', { source: pageView, pageNumber: 2, error: null });
  eq(seen.length, 3);
  eq(t.shell.phase, 'ready', 'the rest of the document works');
});

test('CSP violations are recorded and logged', () => {
  const t = setup();
  t.shell.start();
  const seen = [];
  t.shell.on('cspviolation', (v) => seen.push(v));
  t.document.fire('securitypolicyviolation', { effectiveDirective: 'img-src', blockedURI: 'blob:x' });
  deq(t.shell.diagnostics().cspViolations, [{ directive: 'img-src', blocked: 'blob:x' }]);
  deq(seen, [{ directive: 'img-src', blocked: 'blob:x' }]);
  assert.ok(t.log.errors.some((e) => e.includes('CSP violation img-src blob:x')));
});

// ---------- state (spec §7.1) ----------

test('view state is saved through vscode.setState and restored on the next open', async () => {
  const t = await setup().open({ pdf: makePdf(20) });
  t.viewer.currentScaleValue = 'page-width';
  t.viewer.pagesRotation = 180;
  t.viewer.eventBus.dispatch('updateviewarea', { location: { pageNumber: 11, rotation: 180, left: 0, top: 792 } });
  eq(t.log.states.length, 0, 'debounced');
  t.runTimers();
  deq(t.log.states.at(-1), { v: 1, view: { page: 11, scale: 'page-width', rotation: 180, left: 0, top: 792 },
    sidebar: { open: false, tab: null }, modules: {} });

  const again = await setup({ state: t.log.states.at(-1) }).open({ pdf: makePdf(20) });
  eq(again.viewer.currentScaleValue, 'page-width');
  eq(again.viewer.pagesRotation, 180);
  deq(again.log.scrolls, [{ pageNumber: 11, destArray: [null, { name: 'XYZ' }, 0, 792, null] }]);

  // The file now has fewer pages; junk in the saved state is ignored.
  const short = await setup({ state: { v: 1, view: { page: 11, scale: '<x>', rotation: 45, left: 'a', top: 5 } } }).open({ pdf: makePdf(4) });
  eq(short.viewer.currentScaleValue, 'auto');
  eq(short.viewer.pagesRotation, 0);
  deq(short.log.scrolls, [{ pageNumber: 4 }]);
  const none = await setup({ state: { v: 2, view: { page: 3 } } }).open({ pdf: makePdf(4) });
  deq(none.log.scrolls, []);
});

// ---------- hooks for PWP-09/10/11/22+ ----------

test('registerPanel: tabs, availability per document, lazy mount, arrow keys, F4, persisted choice', async () => {
  const t = setup({ state: { v: 1, sidebar: { open: true, tab: 'outline' } } });
  const calls = [];
  const thumbs = t.shell.registerPanel({
    id: 'thumbnails', title: 'Thumbnails', order: 10,
    mount: (el, shell) => { calls.push('mount thumbs'); el.textContent = 'T'; assert.strictEqual(shell, t.shell); },
    onShow: () => calls.push('show thumbs'), onHide: () => calls.push('hide thumbs'),
    onDocument: (pdf) => calls.push('doc ' + (pdf ? pdf.numPages : 'none')),
  });
  t.shell.registerPanel({
    id: 'outline', title: 'Outline <b>', order: 20,
    isAvailable: async (pdf) => !!pdf && pdf.numPages > 1,
    mount: () => calls.push('mount outline'), onShow: () => calls.push('show outline'),
  });
  assert.throws(() => t.shell.registerPanel({ id: 'outline', title: 'x', mount() {} }), /already registered/);
  assert.throws(() => t.shell.registerPanel({ id: 'Bad Id', title: 'x', mount() {} }));

  await t.open({ pdf: makePdf(3) });
  const sidebar = t.byClass('pdf-sidebar');
  const tabs = t.byClass('pdf-sidebar-tabs');
  eq(tabs.getAttribute('role'), 'tablist');
  deq(tabs.children.map((b) => [b.textContent, b.getAttribute('role'), b.getAttribute('aria-selected'), b.getAttribute('tabindex'), b.hidden]),
    [['Thumbnails', 'tab', 'false', '-1', false], ['Outline <b>', 'tab', 'true', '0', false]]);
  eq(sidebar.hidden, false, 'restored open');
  assert.ok(calls.includes('mount outline') && calls.includes('show outline'), 'the saved tab wins once it is available');
  assert.ok(calls.includes('doc 3'));
  assert.ok(!calls.includes('mount thumbs'), 'mounted only when first shown');
  const panel = t.document.getElementById('pdf-panel-thumbnails');
  eq(panel.getAttribute('role'), 'tabpanel');
  eq(panel.getAttribute('aria-labelledby'), 'pdf-tab-thumbnails');
  eq(t.button('Toggle sidebar (F4)').hidden, false);
  eq(t.button('Toggle sidebar (F4)').getAttribute('aria-pressed'), 'true');

  tabs.fire('keydown', { key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
  assert.ok(calls.includes('mount thumbs') && calls.includes('show thumbs'));
  eq(t.document.activeElement, tabs.children[0]);
  eq(panel.hidden, false);
  eq(thumbs.isShown(), true);
  eq(thumbs.element, panel);
  tabs.fire('keydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
  assert.ok(calls.includes('hide thumbs'));
  eq(tabs.children[1].getAttribute('aria-selected'), 'true');

  assert.ok(t.key('F4').prevented);
  eq(sidebar.hidden, true);
  t.button('Toggle sidebar (F4)').click();
  eq(sidebar.hidden, false);
  t.runTimers();
  deq(t.log.states.at(-1).sidebar, { open: true, tab: 'outline' });

  // A one-page document has no outline: its tab goes and the first available panel shows.
  t.log.plan.push({ pdf: makePdf(1) });
  t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array(1) });
  await t.tick();
  eq(tabs.children[1].hidden, true);
  eq(tabs.children[0].getAttribute('aria-selected'), 'true');
  assert.ok(calls.includes('doc none') && calls.includes('doc 1'));
  eq(t.shell.showPanel('outline'), false);
  eq(t.htmlWrites(), 0);
});

test('registerTool: edit-only tools, one active at a time, letter keys in the page area, Esc', async () => {
  const t = setup();
  const calls = [];
  t.shell.registerTool({ id: 'select', label: 'Select', key: 'V', order: 1, activate: () => calls.push('+select'), deactivate: () => calls.push('-select') });
  t.shell.registerTool({ id: 'draw', label: 'Draw', key: 'd', order: 2, activate: () => calls.push('+draw'), deactivate: () => calls.push('-draw') });
  t.shell.registerTool({ id: 'highlight', label: 'Highlight', title: 'Highlight selection (H)', key: 'h', order: 3, run: () => calls.push('run highlight') });
  assert.throws(() => t.shell.registerTool({ id: 'draw', label: 'x', run() {} }), /already registered/);
  await t.open({ pdf: makePdf(2) });

  const toolEvents = [];
  t.shell.on('toolchange', (e) => toolEvents.push(e.tool));
  eq(t.button('Select').hidden, true, 'hidden in View mode');
  eq(t.key('v').prevented, false);
  eq(t.shell.setTool('select'), false);

  t.send(t.initMsg({ canEdit: true, editMode: true }));
  eq(t.shell.editMode, true);
  eq(t.button('Select').hidden, false);
  assert.ok(t.key('v').prevented);
  eq(t.shell.activeTool, 'select');
  eq(t.button('Select').getAttribute('aria-pressed'), 'true');
  t.button('Draw').click();
  deq(calls, ['+select', '-select', '+draw']);
  eq(t.button('Select').getAttribute('aria-pressed'), 'false');
  t.key('h');
  eq(calls.at(-1), 'run highlight');
  eq(t.shell.activeTool, 'draw', 'a one-shot tool does not change the active tool');
  eq(t.key('d', { target: t.pageInput }).prevented, false, 'not while typing');

  assert.ok(t.key('Escape').prevented);
  eq(t.shell.activeTool, null);
  t.key('d');
  t.send({ type: 'editModeChanged', editMode: false });
  eq(t.shell.activeTool, null, 'leaving Edit mode drops the tool');
  eq(t.button('Draw').hidden, true);
  deq(toolEvents, ['select', 'draw', null, 'draw', null]);
});

test('registerToolbarItems, registerKey, shell events, per-script state and the flush default', async () => {
  const t = setup();
  const clicks = [];
  const h = t.shell.registerToolbarItems([
    { id: 'find', label: 'Find', title: 'Find (Ctrl+F)', onClick: () => clicks.push('find') },
    { id: 'props', label: 'Properties', toggle: true, disabled: true, onClick: (p) => clicks.push('props ' + p) },
  ]);
  assert.throws(() => t.shell.registerToolbarItems([{ id: 'prev', label: 'x' }]), /already in use/);
  const offKey = t.shell.registerKey({ key: 'F', ctrl: true }, () => { clicks.push('ctrl+f'); });
  t.shell.registerKey({ key: 'j' }, () => false);
  const messages = [];
  t.shell.on('message', (m) => messages.push(m.type));
  const loaded = [];
  t.shell.on('documentloaded', (e) => loaded.push(e.generation));

  await t.open({ pdf: makePdf(2) }, 7);
  deq(loaded, [7]);
  deq(messages, ['init', 'pdfDocument']);
  t.button('Find (Ctrl+F)').click();
  eq(t.button('Properties').disabled, true);
  h.props.setDisabled(false);
  t.button('Properties').click();
  eq(t.button('Properties').getAttribute('aria-pressed'), 'true');
  h.props.setPressed(false);
  eq(t.button('Properties').getAttribute('aria-pressed'), 'false');
  h.find.setHidden(true);
  eq(h.find.button.hidden, true);
  assert.ok(t.key('f', { ctrlKey: true, target: t.pageInput }).prevented, 'Ctrl shortcuts work from inputs');
  eq(t.key('j').prevented, false, 'a handler returning false leaves the key alone');
  deq(clicks, ['find', 'props true', 'ctrl+f']);
  offKey();
  eq(t.key('f', { ctrlKey: true }).prevented, false);

  // Registering after start rebuilds the toolbar and keeps the state.
  t.shell.registerToolbarItems([{ id: 'late', label: 'Late', order: 1 }]);
  eq(t.button('Late').hidden, false);
  eq(t.button('Find (Ctrl+F)').hidden, true);
  eq(t.zoomSelect.value, 'auto');
  eq(t.document.body.find((e) => e.className.split(' ').includes('pdf-toolbar')).length, 1);

  t.shell.setState('find', { matchCase: true });
  deq(t.shell.getState('find'), { matchCase: true });
  t.runTimers();
  deq(t.log.states.at(-1).modules, { find: { matchCase: true } });
  const back = setup({ state: t.log.states.at(-1) });
  back.shell.start();
  deq(back.shell.getState('find'), { matchCase: true });
  eq(back.shell.getState('missing'), undefined);

  t.send({ type: 'flushPendingEdits', flushId: 3 });
  deq(t.posted.at(-1), { type: 'flushed', flushId: 3 });
  const flushed = [];
  t.shell.setFlushHandler((id) => flushed.push(id));
  t.send({ type: 'flushPendingEdits', flushId: 4 });
  deq(flushed, [4]);
  eq(t.posted.filter((m) => m.type === 'flushed').length, 1);
});

test('setAnnotationMode rebuilds the view on the same document, in place, without a reload', async () => {
  const pdf = makePdf(6, { getPageLabels: async () => ['a', 'b', 'c', 'd', 'e', 'f'] });
  const t = await setup().open({ pdf });
  const firstContainer = t.container;
  t.viewer.currentScaleValue = '2';
  t.viewer.eventBus.dispatch('updateviewarea', { location: { pageNumber: 4, rotation: 0, left: 5, top: 100 } });
  const changed = [];
  t.shell.on('viewerchanged', (e) => changed.push(e.annotationMode));

  t.shell.setAnnotationMode(2);
  eq(t.log.viewers.length, 2);
  eq(t.log.viewerOptions[0].abortSignal.aborted, true, 'the old view lets go of its listeners');
  eq(t.log.viewerOptions[1].annotationMode, 2);
  eq(t.log.viewerOptions[1].eventBus, t.log.viewerOptions[0].eventBus, 'same event bus: registered listeners keep working');
  assert.notStrictEqual(t.container, firstContainer);
  eq(firstContainer.parentNode, null);
  eq(t.shell.container, t.container);
  eq(t.shell.viewer, t.viewer);
  eq(t.log.viewers[0].doc, null);
  eq(t.viewer.doc, pdf);
  eq(t.viewer.currentScaleValue, '2');
  deq(t.viewer.labels, ['a', 'b', 'c', 'd', 'e', 'f']);
  deq(t.log.scrolls.at(-1), { pageNumber: 4, destArray: [null, { name: 'XYZ' }, 5, 100, null] });
  eq(t.log.getDocument.length, 1);
  eq(t.log.linkService.viewer, t.viewer);
  deq(changed, [2]);
  t.shell.setAnnotationMode(2);
  eq(t.log.viewers.length, 2, 'no-op for the current mode');
});

// ---------- facts ----------

test('collectFacts: every source, the caps, and probes that throw', async () => {
  const { api } = setup();
  const long = 'x'.repeat(5000);
  const facts = await api.collectFacts(makePdf(40, {
    getMetadata: async () => ({ info: { EncryptFilterName: 'Standard', IsXFAPresent: true } }),
    getAttachments: async () => new Map([['a', {}], ['b', {}]]),
    getSignatures: async () => [{ signerName: long, reason: null, signingTime: 'D:20261121000000Z' }, null],
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: '  ' }, { type: 'beginMarkedContent' }] }),
      getJSActions: async () => null,
      getAnnotations: async () => [{ actions: null }, { actions: {} }],
    }),
  }));
  deq(facts, { pageCount: 40, encrypted: true, hasText: false, hasJavaScript: true, hasXfa: true, attachmentCount: 2,
    signatures: [{ signer: 'x'.repeat(4096), reason: '', time: 'D:20261121000000Z' }] });

  const boom = async () => { throw new Error('boom'); };
  deq(await api.collectFacts({ numPages: 2, getMetadata: boom, getJSActions: boom, getFieldObjects: boom, getAttachments: boom, getPage: boom }),
    { pageCount: 2, encrypted: false, hasText: false, hasJavaScript: false, hasXfa: false, attachmentCount: 0, signatures: [] });

  eq((await api.collectFacts(makePdf(1, { getJSActions: async () => ({}) }))).hasJavaScript, true, 'non-null, even when empty');
  eq((await api.collectFacts(makePdf(1, { getFieldObjects: async () => ({ total: [{ actions: { Calculate: ['x'] } }] }) }))).hasJavaScript, true);
  eq((await api.collectFacts(makePdf(1, { getFieldObjects: async () => ({ name: [{ actions: null }, {}] }) }))).hasJavaScript, false);
  eq((await api.collectFacts(makePdf(1, { getAttachments: async () => ({ 'a.txt': {} }) }))).attachmentCount, 1);

  let pagesRead = 0;
  await api.collectFacts(makePdf(2000, { getPage: async () => { pagesRead++; return { getTextContent: async () => ({ items: [] }), getJSActions: async () => null, getAnnotations: async () => [] }; } }));
  eq(pagesRead, 5, 'only the first pages are looked at');
});

test('helpers: normaliseScaleValue and allowedScheme', () => {
  const { api, VM } = setup();
  deq(['auto', 'page-fit', '1.5', 2, '0.01', '99', 'x', '', null, '-1', 'NaN'].map((v) => api.normaliseScaleValue(v, VM)),
    ['auto', 'page-fit', '1.5', '2', '0.25', '5', null, null, null, null, null]);
  deq(['https://a', 'HTTP://a', 'mailto:a@b', 'javascript:1', 'file:///a', 'a.pdf', '#x', ' https://a'].map((h) => api.allowedScheme(h)),
    ['https', 'http', 'mailto', null, null, null, null, 'https']);
});

// ---------- pdfLog (spec §5, §12; amendment 2026-11-21) ----------

test('a CSP violation posts one pdfLog with directive and blocked URI minus its query; identical ones are not repeated', () => {
  const t = setup();
  t.shell.start();
  const v = { effectiveDirective: 'img-src', blockedURI: 'https://h.example/a.png?token=secret#f' };
  t.document.fire('securitypolicyviolation', v);
  t.document.fire('securitypolicyviolation', v);
  t.document.fire('securitypolicyviolation', { effectiveDirective: 'font-src', blockedURI: 'data' });
  const logs = t.posted.filter((m) => m.type === 'pdfLog');
  deq(logs, [
    { type: 'pdfLog', level: 'warn', code: 'csp-violation', detail: 'img-src https://h.example/a.png' },
    { type: 'pdfLog', level: 'warn', code: 'csp-violation', detail: 'font-src data' },
  ]);
  eq(t.shell.diagnostics().cspViolations.length, 3, 'the console/diagnostics behaviour is kept');
});

test('the main-thread worker fallback and a failed page each post a pdfLog (the page once)', async () => {
  const t = await setup().open({ pdf: makePdf(3), fakeWorker: true });
  deq(t.posted.filter((m) => m.type === 'pdfLog'), [{ type: 'pdfLog', level: 'warn', code: 'worker-fallback' }]);
  const div = t.document.createElement('div');
  for (let i = 0; i < 2; i++) { t.viewer.eventBus.dispatch('pagerendered', { source: { div }, pageNumber: 2, error: new Error('bad stream with text') }); }
  const pages = t.posted.filter((m) => m.type === 'pdfLog' && m.code === 'page-render-failed');
  deq(pages, [{ type: 'pdfLog', level: 'warn', code: 'page-render-failed', detail: 'page 2: Error' }]);
});
