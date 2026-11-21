// PWP-10: the PDF find bar (media/pdfFind.js) in node:vm with the viewer harness and the stubbed
// pdf.js bus. The real PDFFindController is exercised by pdfFindReal.test.mjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setup, makePdf } = require('./_viewerHarness.cjs');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'pdfFind.js'), 'utf8');
const eq = assert.strictEqual;
const ENTER = { key: 'Enter', preventDefault() {} };

/** A shell with the find script loaded on top of it and a document open; `finds` records every find / findbarclose. */
async function boot(pdf) {
  const t = setup();
  const sandbox = { window: t.win, document: t.document, console: t.win.console };
  vm.createContext(sandbox);
  t.win.PdfViewerShell = t.shell;
  t.win.document = t.document;
  vm.runInContext(SRC, sandbox, { filename: 'pdfFind.js' });
  t.find = t.win.PdfFindBar;
  await t.open({ pdf: pdf || makePdf(3) });
  t.finds = [];
  t.bus = t.shell.eventBus;
  ['find', 'findbarclose'].forEach((n) => t.bus.on(n, (e) => t.finds.push(Object.assign({ n }, e))));
  const bar = () => t.find.bar;
  t.input = () => bar().find((e) => e.className === 'pdf-find-input')[0];
  t.btn = (label) => bar().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === label)[0];
  t.count = () => bar().find((e) => e.id === 'pdf-find-count')[0].textContent;
  t.type = (text) => { const i = t.input(); i.value = text; i.fire('input', {}); };
  t.state = (state, current, total) => t.bus.dispatch('updatefindcontrolstate', { state, matchesCount: { current, total } });
  t.ctrlF = () => t.key('f', { ctrlKey: true });
  return t;
}

test('Ctrl+F opens the bar, focuses and selects the input; the script builds no HTML', async () => {
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|'style'|eval\(/.test(code));
  const t = await boot();
  eq(t.find.isOpen, false);
  eq(t.ctrlF().prevented, true);
  eq(t.find.isOpen, true);
  eq(t.find.bar.hidden, false);
  eq(t.document.activeElement, t.input());
  eq(t.input().selected, true);
  eq(t.htmlWrites(), 0);
});

test('typing sends a new search with the options; Enter, Shift+Enter, F3 and the buttons step', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('hello');
  eq(t.finds.length, 1);
  const f = t.finds[0];
  eq(f.type, ''); eq(f.query, 'hello'); eq(f.caseSensitive, false); eq(f.entireWord, false); eq(f.highlightAll, true); eq(f.findPrevious, false);
  t.input().fire('keydown', ENTER);
  eq(t.finds[1].type, 'again'); eq(t.finds[1].findPrevious, false);
  t.input().fire('keydown', Object.assign({ shiftKey: true }, ENTER));
  eq(t.finds[2].findPrevious, true);
  t.input().fire('keydown', { key: 'F3', preventDefault() {} });
  eq(t.finds[3].findPrevious, false);
  t.btn('Previous match').click();
  eq(t.finds[4].findPrevious, true);
  t.btn('Next match').click();
  eq(t.finds[5].findPrevious, false);
});

test('F3 and Shift+F3 from the page area; F3 with the bar closed opens it', async () => {
  const t = await boot();
  t.key('F3');
  eq(t.find.isOpen, true);
  t.type('x');
  t.document.activeElement = t.container;
  const n = t.finds.length;
  t.key('F3');
  eq(t.finds[n].type, 'again'); eq(t.finds[n].findPrevious, false);
  t.key('F3', { shiftKey: true });
  eq(t.finds[n + 1].findPrevious, true);
});

test('match case, whole words and highlight all re-run the search and persist in the view state', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('abc');
  t.btn('Match case').click();
  eq(t.finds[1].type, ''); eq(t.finds[1].caseSensitive, true);
  eq(t.btn('Match case').getAttribute('aria-pressed'), 'true');
  t.btn('Whole words').click();
  eq(t.finds[2].entireWord, true);
  t.btn('Highlight all').click();
  eq(t.finds[3].type, 'highlightallchange'); eq(t.finds[3].highlightAll, false);
  const o = t.shell.getState('find');
  eq(o.matchCase, true); eq(o.wholeWord, true); eq(o.highlightAll, false);
});

test('the count reads "3 of 17", "more than N" until every page is scanned, and No matches sets aria-invalid', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('a');
  t.state(0, 3, 17);
  eq(t.count(), '3 of 17');
  t.shell.findController._pendingFindMatches = new Set([5, 6]);   // pdf.js still has pages to extract
  t.bus.dispatch('updatefindmatchescount', { matchesCount: { current: 3, total: 17 } });
  eq(t.count(), '3 of more than 17');
  t.shell.findController._pendingFindMatches = new Set();
  t.bus.dispatch('updatefindmatchescount', { matchesCount: { current: 3, total: 20 } });
  eq(t.count(), '3 of 20');
  t.type('zzz');
  t.state(1, 0, 0);
  eq(t.count(), 'No matches');
  eq(t.input().getAttribute('aria-invalid'), 'true');
  t.state(0, 1, 1);
  eq(t.input().getAttribute('aria-invalid'), 'false');
});

test('announcements: final count, wrap-around in both directions, no repeats, silent for a partial count while typing', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('a');
  t.state(3, 0, 0);                       // pending: nothing announced
  eq(t.live.textContent, '');
  t.state(0, 1, 4);
  eq(t.live.textContent, '1 of 4');
  t.input().fire('keydown', ENTER);
  t.state(2, 1, 4);
  eq(t.live.textContent, 'Reached the end of the document; continued from the top. 1 of 4');
  t.input().fire('keydown', Object.assign({ shiftKey: true }, ENTER));
  t.state(2, 4, 4);
  eq(t.live.textContent, 'Reached the top of the document; continued from the end. 4 of 4');
  t.shell.findController._pendingFindMatches = new Set([2]);
  t.type('b');
  t.state(0, 1, 2);
  assert.ok(!/more than/.test(t.live.textContent));
});

test('Escape closes, clears the highlights and returns focus to where it was', async () => {
  const t = await boot();
  t.document.activeElement = t.container;
  t.ctrlF();
  t.type('a');
  t.input().fire('keydown', { key: 'Escape', preventDefault() {} });
  eq(t.find.isOpen, false);
  eq(t.find.bar.hidden, true);
  eq(t.document.activeElement, t.container);
  eq(t.finds[t.finds.length - 1].n, 'findbarclose');

  t.ctrlF();                                    // from a bar button
  t.btn('Match case').focus();
  t.find.bar.fire('keydown', { key: 'Escape', target: t.btn('Match case'), preventDefault() {} });   // the shim does not bubble
  eq(t.find.isOpen, false);
  t.ctrlF();                                    // from the page area while the bar is open
  t.document.activeElement = t.container;
  t.key('Escape');
  eq(t.find.isOpen, false);
  eq(t.key('Escape').prevented, false, 'with the bar closed Escape is left to the viewer');
});

test('Ctrl+F in the input selects the query; a short selection seeds a new one', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('old');
  t.input().selected = false;
  t.input().fire('keydown', { key: 'f', ctrlKey: true, preventDefault() {} });
  eq(t.input().selected, true);
  t.find.close(false);
  t.setSelection('  new\n term ');
  t.ctrlF();
  eq(t.input().value, 'new term');
  eq(t.finds[t.finds.length - 1].query, 'new term');
});

test('document-derived text only ever reaches textContent (a hostile selection stays text)', async () => {
  const t = await boot();
  t.setSelection('<img src=x onerror=alert(1)>');
  t.ctrlF();
  eq(t.input().value, '<img src=x onerror=alert(1)>');
  eq(t.htmlWrites(), 0);
  eq(t.find.bar.find((e) => e.tagName === 'IMG').length, 0);
});

test('no text on the first pages (facts) neither disables find nor shows the note', async () => {
  const t = await boot(makePdf(2, { getPage: async () => ({
    getTextContent: async () => ({ items: [] }), getJSActions: async () => null, getAnnotations: async () => [],
  }) }));
  await t.tick(20);
  assert.ok(t.posted.some((m) => m.type === 'pdfFacts' && m.facts.hasText === false));
  t.ctrlF();
  const note = t.find.bar.find((e) => e.className === 'pdf-find-note')[0];
  eq(note.hidden, true);
  eq(t.input().disabled, false);
  eq(t.btn('Next match').disabled, false);
  eq(t.document.activeElement, t.input());
  t.type('later page text');
  eq(t.finds.filter((f) => f.n === 'find').length, 1, 'the search runs: later pages may have text');
});

test('the scanned-file note appears only once every page was extracted and none had text; controls stay enabled', async () => {
  const t = await boot(makePdf(3));
  const c = t.shell.findController;
  const note = () => t.find.bar.find((e) => e.className === 'pdf-find-note')[0];
  t.ctrlF();
  t.type('x');
  // Still extracting: no verdict.
  c._pageContents = ['', '  '];
  c._pendingFindMatches = new Set([2]);
  t.state(3, 0, 0);
  t.bus.dispatch('updatefindmatchescount', { matchesCount: { current: 0, total: 0 } });
  eq(note().hidden, true);
  // Every page scanned, but one has text: no note either.
  c._pageContents = ['', 'words', ''];
  c._pendingFindMatches = new Set();
  t.state(1, 0, 0);
  eq(note().hidden, true);
  eq(t.count(), 'No matches');
  // Every page scanned, none has text: the note, as a soft hint; nothing is disabled.
  c._pageContents = ['', ' \n', ''];
  t.type('y');
  t.state(1, 0, 0);
  eq(note().hidden, false);
  assert.ok(/may be scanned/.test(note().textContent));
  assert.ok(/may be scanned/.test(t.live.textContent));
  eq(t.input().disabled, false);
  eq(t.btn('Next match').disabled, false);
  // A new document clears the verdict (pdf.js resets its page text with the document).
  c._pageContents = [];
  t.log.plan.push({ pdf: makePdf(1) });
  t.send(t.initMsg());
  t.send({ type: 'pdfDocument', generation: 2, version: 0, bytes: new Uint8Array([37, 80, 68, 70, 45]) });
  await t.tick(10);
  eq(note().hidden, true);
});

test('a new document re-runs an open search; closing the document closes the bar', async () => {
  const t = await boot();
  t.ctrlF();
  t.type('a');
  const before = t.finds.filter((f) => f.n === 'find').length;
  t.send({ type: 'loadError', title: 'x', detail: '', actions: [] });
  await t.tick(10);
  eq(t.find.isOpen, false);
  assert.ok(before >= 1);
});
