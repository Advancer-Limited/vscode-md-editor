// PWP-09: media/pdfSidebar.js in node:vm with the viewer harness (DOM shim, stubbed PdfjsBundle).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setup, makePdf } = require('./_viewerHarness.cjs');

const eq = assert.strictEqual;
const deq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
const SRC = fs.readFileSync(path.join(__dirname, '../../media/pdfSidebar.js'), 'utf8');

/** A pdf whose pages record every render in `pdf.renders`. */
function makeCanvasPdf(n, over) {
  const renders = [];
  return makePdf(n, Object.assign({
    renders,
    getPage: async (i) => ({
      rotate: 0,
      view: [0, 0, 612, 792],
      getViewport: ({ scale, rotation }) => ({ width: 612 * scale, height: 792 * scale, rotation }),
      render: () => {
        const r = { page: i, cancelled: false, promise: Promise.resolve() };
        r.cancel = () => { r.cancelled = true; };
        renders.push(r);
        return r;
      },
      cleanup() {},
    }),
  }, over));
}

async function boot(pdf, opts) {
  const t = setup(opts);
  t.log.observers = [];
  t.win.IntersectionObserver = function IO(cb, o) {
    this.cb = cb; this.o = o; this.targets = [];
    this.observe = (el) => this.targets.push(el);
    this.disconnect = () => { this.targets = []; };
    t.log.observers.push(this);
  };
  t.runScript('pdfSidebar.js');
  await t.open({ pdf });
  return t;
}
const intersect = (obs, items, on = true) => obs.cb(items.map((el) => ({ target: el, isIntersecting: on })));
const tabs = (t) => t.document.body.find((e) => e.tagName === 'BUTTON' && e.className === 'pdf-sidebar-tab' && !e.hidden).map((e) => e.textContent);
const find = (t, cls) => t.document.body.find((e) => e.className.split(' ').indexOf(cls) >= 0);
const textOf = (el) => el.textContent;

test('static rules: no HTML building, no style writes, no eval in pdfSidebar.js / .css', () => {
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', '.style.', '.style[', "'style'", 'cssText', 'eval(', 'new Function', '.open(']) {
    assert.ok(!code.includes(banned), 'must not contain ' + banned);
  }
  const css = fs.readFileSync(path.join(__dirname, '../../media/pdfSidebar.css'), 'utf8');
  assert.ok(!/url\(|@import|expression\(/i.test(css));
});

test('helpers: sizes, PDF dates, page size, attachment listing', () => {
  const t = setup();
  t.runScript('pdfSidebar.js');
  const h = t.win.PdfSidebar || t.sandbox.PdfSidebar;
  eq(h.formatSize(12), '12 bytes'); eq(h.formatSize(2048), '2 KB'); eq(h.formatSize(1536 * 1024), '1.5 MB'); eq(h.formatSize(-1), '');
  eq(h.formatPdfDate("D:20240131120500+01'00'"), '2024-01-31 12:05 (+01:00)');
  eq(h.formatPdfDate('D:20240131120500Z'), '2024-01-31 12:05 (UTC)');
  eq(h.formatPdfDate('D:2024'), '2024-01-01');
  eq(h.formatPdfDate('yesterday'), 'yesterday');
  eq(h.formatPageSize({ view: [0, 0, 595.28, 841.89], rotate: 0 }), '210 × 297 mm (595 × 842 pt)');
  eq(h.formatPageSize({ view: [0, 0, 595.28, 841.89], rotate: 90 }), '297 × 210 mm (842 × 595 pt)');
  const m = new Map([['a.txt', { filename: 'a.txt', content: new Uint8Array(3) }], ['b', { rawFilename: 'b', content: null }]]);
  deq(h.listAttachments(m).map((a) => a.name), ['a.txt', 'b']);
  deq(h.listAttachments(null), []);
});

test('tabs: Outline and Attachments appear only when the document has them; Thumbnails always', async () => {
  const t = await boot(makePdf(3));
  deq(tabs(t), ['Thumbnails']);
  const t2 = await boot(makePdf(3, {
    getOutline: async () => [{ title: 'One', dest: [null, { name: 'Fit' }] }],
    getAttachments: async () => new Map([['x.txt', { filename: 'x.txt', content: new Uint8Array(5) }]]),
  }));
  deq(tabs(t2), ['Thumbnails', 'Outline', 'Attachments']);
});

test('thumbnails: lazy, windowed through thumbnailWindow, one render at a time', async () => {
  const pdf = makeCanvasPdf(500);
  const t = await boot(pdf);
  eq(find(t, 'pdf-thumb').length, 0, 'sidebar closed: nothing mounted');
  t.shell.setSidebarOpen(true);
  await t.tick();
  const items = find(t, 'pdf-thumb');
  eq(items.length, 500);
  eq(items[0].getAttribute('aria-label'), 'Page 1');
  const obs = t.log.observers[0];
  eq(obs.targets.length, 500);
  intersect(obs, items.slice(100, 104));
  await t.tick(30);
  const rendered = pdf.renders.map((r) => r.page);
  const near = rendered.filter((p) => p > 6);   // pages 1-6 were drawn before the observer reported anything
  assert.ok(near.length === 14 && near.every((p) => p >= 96 && p <= 109), 'visible range plus buffer only: ' + near.join());
  assert.ok(near[0] >= 101 && near[0] <= 104, 'nearest the visible range first');
  assert.ok(find(t, 'pdf-thumb-canvas').length <= 14, 'the early ones are released');

  // scrolling far away releases the old canvases and stays at or below the cap
  intersect(obs, items.slice(400, 404));
  intersect(obs, items.slice(100, 104), false);
  await t.tick(30);
  const alive = find(t, 'pdf-thumb-canvas').map((c) => c.parentNode.parentNode.getAttribute('aria-label'));
  assert.ok(alive.length <= t.VM.THUMB_CAP);
  assert.ok(!alive.includes('Page 101'), 'released: ' + alive.join());
  assert.ok(alive.includes('Page 401'));
});

test('thumbnails: a big visible range never keeps more than THUMB_CAP canvases', async () => {
  const pdf = makeCanvasPdf(600);
  const t = await boot(pdf);
  t.shell.setSidebarOpen(true);
  await t.tick();
  intersect(t.log.observers[0], find(t, 'pdf-thumb').slice(0, 450));
  await t.tick(1500);
  const n = find(t, 'pdf-thumb-canvas').length;
  assert.ok(n > 0 && n <= t.VM.THUMB_CAP, String(n));
});

test('thumbnails: click goes to the page; arrows rove focus; current page is marked and follows pagechanging', async () => {
  const t = await boot(makeCanvasPdf(5));
  t.shell.setSidebarOpen(true);
  await t.tick();
  const items = find(t, 'pdf-thumb');
  const list = items[0].parentNode;
  items[2].click();
  eq(t.viewer.currentPageNumber, 3);
  eq(items[2].getAttribute('aria-current'), 'page');
  eq(items[0].getAttribute('tabindex'), '-1');
  list.fire('keydown', { key: 'ArrowDown', target: items[2], preventDefault() {} });
  eq(t.document.activeElement, items[3]);
  eq(items[3].getAttribute('tabindex'), '0');
  list.fire('keydown', { key: 'End', target: items[3], preventDefault() {} });
  eq(t.document.activeElement, items[4]);
  list.fire('keydown', { key: 'Home', target: items[4], preventDefault() {} });
  eq(t.document.activeElement, items[0]);
  t.viewer.currentPageNumber = 5;
  eq(items[4].getAttribute('aria-current'), 'page');
  eq(items[0].getAttribute('aria-current'), 'false');
});

test('thumbnails: a failed render is tried once, not in a loop', async () => {
  let calls = 0;
  let armed = false;
  const pdf = makeCanvasPdf(3, { getPage: async () => { if (armed) { calls++; } throw new Error('boom'); } });
  const t = await boot(pdf);
  armed = true;   // the facts probe has used getPage already
  t.shell.setSidebarOpen(true);
  await t.tick();
  intersect(t.log.observers[0], find(t, 'pdf-thumb'));
  await t.tick(30);
  eq(calls, 3, 'each page tried once');
  eq(find(t, 'pdf-thumb-canvas').length, 0);
});

const OUTLINE = [
  { title: 'Intro <img src=x onerror=alert(1)>', dest: 'intro', items: [] },
  { title: 'Part', dest: [null, { name: 'Fit' }], bold: true, items: [
    { title: 'A', dest: 'a', items: [{ title: 'A1', dest: 'a1', items: [] }] },
    { title: 'B', url: 'https://example.com/', items: [] }] },
  { title: 'Mail', url: 'mailto:a@b.c', items: [] },
  { title: 'Bad', url: 'javascript:alert(1)', items: [] },
];

async function outlineSetup() {
  const t = await boot(makePdf(3, { getOutline: async () => OUTLINE }));
  const goto = [];
  t.log.linkService.goToDestination = (d) => goto.push(d);
  t.shell.showPanel('outline');
  await t.tick();
  return { t, goto, tree: find(t, 'pdf-outline')[0], rows: find(t, 'pdf-outline-item') };
}
const key = (tree, target, k) => tree.fire('keydown', { key: k, target, preventDefault() {}, stopPropagation() {} });

test('outline: role=tree, document strings stay text, levels and expanded state', async () => {
  const { t, tree, rows } = await outlineSetup();
  eq(tree.getAttribute('role'), 'tree');
  eq(t.htmlWrites(), 0);
  const title = find(t, 'pdf-outline-title')[0];
  eq(title.textContent, 'Intro <img src=x onerror=alert(1)>');
  eq(title.children.length, 0);
  eq(rows[0].getAttribute('role'), 'treeitem');
  eq(rows[1].getAttribute('aria-expanded'), 'false');
  eq(rows[0].getAttribute('aria-expanded'), null);
  eq(rows[2].getAttribute('aria-level'), '2');
  eq(rows[3].getAttribute('aria-level'), '3');
});

test('outline: arrow keys, expand/collapse, Home/End, Enter goes to the destination', async () => {
  const { t, goto, tree, rows } = await outlineSetup();
  const [intro, part, a, a1, , mail, bad] = rows;
  eq(intro.getAttribute('tabindex'), '0');
  key(tree, intro, 'ArrowDown');
  eq(t.document.activeElement, part);
  key(tree, part, 'ArrowDown');
  eq(t.document.activeElement, mail, 'collapsed children are skipped');
  key(tree, mail, 'ArrowUp');
  key(tree, part, 'ArrowRight');
  eq(part.getAttribute('aria-expanded'), 'true');
  eq(find(t, 'pdf-outline-group')[0].hidden, false);
  key(tree, part, 'ArrowRight');
  eq(t.document.activeElement, a, 'Right on an open node enters it');
  key(tree, a, 'ArrowRight'); key(tree, a, 'ArrowRight');
  eq(t.document.activeElement, a1);
  key(tree, a1, 'ArrowLeft');
  eq(t.document.activeElement, a, 'Left on a leaf goes to the parent');
  key(tree, a, 'ArrowLeft');
  eq(a.getAttribute('aria-expanded'), 'false');
  key(tree, a, 'End');
  eq(t.document.activeElement, bad);
  key(tree, bad, 'Home');
  eq(t.document.activeElement, intro);
  key(tree, intro, 'Enter');
  key(tree, intro, 'ArrowDown');
  key(tree, part, 'Enter');
  deq(goto, ['intro', [null, { name: 'Fit' }]]);
});

test('outline: one tab stop; URLs go through openLink only when allowed; collapsing moves focus to the parent', async () => {
  const { t, goto, tree, rows } = await outlineSetup();
  const [intro, part, , , b, mail, bad] = rows;
  key(tree, intro, 'ArrowDown'); key(tree, part, 'ArrowRight');
  eq(rows.filter((r) => r.getAttribute('tabindex') === '0').length, 1);
  key(tree, part, 'ArrowRight'); key(tree, rows[2], 'ArrowDown');
  eq(t.document.activeElement, b);
  key(tree, b, 'Enter');
  key(tree, b, 'ArrowDown');
  eq(t.document.activeElement, mail);
  key(tree, mail, 'Enter');
  key(tree, mail, 'ArrowDown');
  eq(t.document.activeElement, bad);
  key(tree, bad, 'Enter');
  deq(t.posted.filter((m) => m.type === 'openLink').map((m) => m.href), ['https://example.com/', 'mailto:a@b.c']);
  eq(goto.length, 0);
  key(tree, bad, 'Home');
  key(tree, intro, 'ArrowDown');
  key(tree, part, 'ArrowLeft');
  eq(part.getAttribute('aria-expanded'), 'false');
});

test('outline: a click on a row activates it; a click on the twisty only toggles', async () => {
  const { goto, rows } = await outlineSetup();
  const head = rows[1].children[0];
  head.fire('click', { target: head.children[0] });
  eq(rows[1].getAttribute('aria-expanded'), 'true');
  eq(goto.length, 0);
  head.fire('click', { target: head.children[1] });
  eq(goto.length, 1);
});

async function attSetup(map) {
  const t = await boot(makePdf(2, { getAttachments: async () => map }));
  t.shell.showPanel('attachments');
  await t.tick();
  return t;
}

test('attachments: name and size as text; Save as… posts pdfSaveAttachment and reports the result', async () => {
  const t = await attSetup(new Map([
    ['x', { filename: '../x<b>.txt', content: new Uint8Array([1, 2, 3]) }],
    ['big.bin', { filename: 'big.bin', content: new Uint8Array(2048) }]]));
  eq(t.htmlWrites(), 0);
  eq(find(t, 'pdf-attachment-name')[0].textContent, '../x<b>.txt');
  eq(find(t, 'pdf-attachment-size')[0].textContent, '3 bytes');
  eq(find(t, 'pdf-attachment-size')[1].textContent, '2 KB');
  const btn = find(t, 'pdf-attachment-save')[0];
  eq(btn.getAttribute('aria-label'), 'Save ../x<b>.txt as…');
  btn.click();
  await t.tick();
  const m = t.last('pdfSaveAttachment');
  eq(m.name, '../x<b>.txt');   // untrusted: the host reduces it to a base name
  deq(Array.from(m.bytes), [1, 2, 3]);
  eq(btn.disabled, true);
  t.send({ type: 'pdfSaveAttachmentResult', requestId: m.requestId, ok: true });
  eq(btn.disabled, false);
  assert.ok(t.live.textContent.includes('Attachment saved'));
  btn.click();
  await t.tick();
  const m2 = t.last('pdfSaveAttachment');
  assert.notStrictEqual(m2.requestId, m.requestId);
  t.send({ type: 'pdfSaveAttachmentResult', requestId: m2.requestId, ok: false });
  assert.ok(t.live.textContent.includes('not saved'));
  t.send({ type: 'pdfSaveAttachmentResult', requestId: 999, ok: true });   // unknown id: ignored
});

test('attachments: nothing is opened; oversize content is refused', async () => {
  const t = await attSetup(new Map([['h.html', { filename: 'h.html', content: { length: 251 * 1024 * 1024, subarray() {} } }]]));
  find(t, 'pdf-attachment-save')[0].click();
  await t.tick();
  eq(t.last('pdfSaveAttachment'), undefined);
  eq(t.last('openLink'), undefined);
});

test('attachments: pdf.js 6 style, no bytes in the list: content is fetched by id when saving', async () => {
  const asked = [];
  const t = await boot(makePdf(2, {
    getAttachments: async () => new Map([['id-1', { rawFilename: 'a.bin', filename: 'a.bin', description: 'D' }]]),
    getAttachmentContent: async (id) => { asked.push(id); return new Uint8Array([9, 8]); },
  }));
  t.shell.showPanel('attachments');
  await t.tick();
  eq(find(t, 'pdf-attachment-name')[0].textContent, 'a.bin');
  eq(find(t, 'pdf-attachment-size').length, 0, 'size unknown until the content is read');
  eq(asked.length, 0, 'nothing is read just to list');
  find(t, 'pdf-attachment-save')[0].click();
  await t.tick();
  deq(asked, ['id-1']);
  deq(Array.from(t.last('pdfSaveAttachment').bytes), [9, 8]);
});

test('properties: dialog shows the fields as text, traps Tab, Esc closes and returns focus', async () => {
  const t = await boot(makePdf(7, {
    getMetadata: async () => ({ info: { Title: '<b>T</b>', Author: 'Ann', CreationDate: 'D:20200102030405Z', PDFFormatVersion: '1.7' } }),
    getDownloadInfo: async () => ({ length: 5120 }),
    getMarkInfo: async () => ({ Marked: true }),
    getPage: async () => ({ view: [0, 0, 595.28, 841.89], rotate: 0 }),
  }));
  const btn = t.document.body.find((e) => e.tagName === 'BUTTON' && (e.getAttribute('title') === 'Document properties' || e.getAttribute('aria-label') === 'Document properties'))[0];
  assert.ok(btn, 'toolbar button');
  eq(btn.disabled, false);
  btn.focus();
  btn.click();
  await t.tick();
  const dlg = find(t, 'pdf-dialog')[0];
  assert.ok(dlg);
  eq(dlg.getAttribute('role'), 'dialog');
  eq(dlg.getAttribute('aria-modal'), 'true');
  const names = find(t, 'pdf-props-name').map(textOf);
  const values = find(t, 'pdf-props-value').map(textOf);
  const v = (n) => values[names.indexOf(n)];
  eq(v('Title'), '<b>T</b>');
  eq(v('Author'), 'Ann');
  eq(v('Created'), '2020-01-02 03:04 (UTC)');
  eq(v('Pages'), '7'); eq(v('Page size'), '210 × 297 mm (595 × 842 pt)'); eq(v('File size'), '5 KB');
  eq(v('Tagged'), 'Yes'); eq(v('PDF version'), '1.7'); eq(v('Subject'), '—');
  eq(t.htmlWrites(), 0);
  eq(t.document.activeElement.textContent, 'Close');
  dlg.fire('keydown', { key: 'Tab', target: dlg, preventDefault() {} });
  eq(t.document.activeElement.textContent, 'Close');
  dlg.fire('keydown', { key: 'Escape', target: dlg, preventDefault() {}, stopPropagation() {} });
  eq(find(t, 'pdf-dialog').length, 0);
  eq(t.document.activeElement, btn);
});

test('a reload swaps the document: panels clear and rebuild for the new one', async () => {
  const t = await boot(makeCanvasPdf(3));
  t.shell.setSidebarOpen(true);
  await t.tick();
  eq(find(t, 'pdf-thumb').length, 3);
  t.log.plan.push({ pdf: makeCanvasPdf(5) });
  t.send({ type: 'pdfDocument', generation: 2, version: 1, bytes: new Uint8Array([37, 80, 68, 70]) });
  await t.tick(20);
  eq(find(t, 'pdf-thumb').length, 5);
});
