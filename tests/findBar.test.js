// Tests for the Find / Replace bar (media/findBar.js): the pure match logic,
// plus the raw-markdown (textarea) path of the controller driven through a
// minimal DOM shim.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { findMatches } = require('../media/findBar.js');

test('findMatches is case-insensitive by default and case-sensitive on request', () => {
  assert.deepStrictEqual(findMatches('Foo foo FOO', 'foo', false).length, 3);
  assert.deepStrictEqual(findMatches('Foo foo FOO', 'foo', true), [{ start: 4, end: 7 }]);
});

test('findMatches treats the query literally (regex metacharacters)', () => {
  assert.strictEqual(findMatches('a.b a+b axb', 'a.b', false).length, 1);
  assert.strictEqual(findMatches('(x) [y] $z', '(x)', false).length, 1);
});

test('findMatches returns non-overlapping matches and nothing for an empty query', () => {
  assert.strictEqual(findMatches('aaaa', 'aa', false).length, 2);
  assert.deepStrictEqual(findMatches('abc', '', false), []);
});

// ---- controller (textarea / raw mode) ----

function makeEl(extra = {}) {
  const listeners = {};
  const el = {
    value: '',
    hidden: false,
    style: {},
    textContent: '',
    classList: { toggle() {}, remove() {}, add() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setAttribute() {},
    focus() {},
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    setRangeText(t, s, e) { this.value = this.value.slice(0, s) + t + this.value.slice(e); },
    dispatchEvent() {},
    click() { (listeners.click || []).forEach((f) => f({})); },
    fire(type, ev) { (listeners[type] || []).forEach((f) => f(ev)); },
    ...extra,
  };
  return el;
}

function setup(initial) {
  const ids = ['find-bar', 'find-input', 'replace-input', 'find-replace-row', 'find-count',
    'find-case', 'find-toggle-replace', 'find-prev', 'find-next', 'find-close',
    'replace-one', 'replace-all', 'btn-find'];
  const els = Object.fromEntries(ids.map((i) => [i, makeEl()]));
  const textarea = makeEl({ value: initial, selectionStart: 0, selectionEnd: 0, scrollTop: 0,
    clientHeight: 400, clientWidth: 400 });
  const previewContent = makeEl();
  const editorContainer = makeEl();
  const docListeners = {};
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    createElement: () => makeEl({ appendChild() {}, remove() {} }),
    body: { appendChild() {} },
    execCommand(cmd, _u, text) {
      // Emulate insertText replacing the textarea selection.
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd);
      return true;
    },
  };
  class MO { observe() {} }
  const ctx = { document, MutationObserver: MO, setTimeout, clearTimeout, module: undefined,
    getComputedStyle: () => ({}), NodeFilter: {}, Event: class {}, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/findBar.js'), 'utf8'), ctx);
  ctx.initFindBar({ textarea, previewContent, editorContainer, isPreviewMode: () => false });
  const press = (key, mods = {}) => {
    let prevented = false;
    docListeners.keydown.forEach((f) => f({ key, preventDefault() { prevented = true; }, ...mods }));
    return prevented;
  };
  return { els, textarea, press };
}

test('Ctrl+F opens the bar and Ctrl+H also reveals the replace row', () => {
  const { els, press } = setup('hello world');
  assert.strictEqual(press('f', { ctrlKey: true }), true);
  assert.strictEqual(els['find-bar'].hidden, false);
  els['find-replace-row'].hidden = true;
  press('h', { ctrlKey: true });
  assert.strictEqual(els['find-replace-row'].hidden, false);
});

test('typing a query counts matches; Enter steps; Match Case narrows', () => {
  const { els, textarea, press } = setup('Foo foo FOO');
  press('f', { ctrlKey: true });
  els['find-input'].value = 'foo';
  els['find-input'].fire('input');
  assert.strictEqual(els['find-count'].textContent, '1 of 3');
  els['find-bar'].fire?.('keydown', {});
  els['find-next'].click();
  assert.strictEqual(textarea.selectionStart, 4);
  els['find-case'].click();
  assert.strictEqual(els['find-count'].textContent, '1 of 1');
});

test('Replace All rewrites every match once, even if the replacement contains the query', () => {
  const { els, textarea, press } = setup('a b a b');
  press('f', { ctrlKey: true });
  els['find-input'].value = 'a';
  els['find-input'].fire('input');
  els['replace-input'].value = 'aa';
  els['replace-all'].click();
  assert.strictEqual(textarea.value, 'aa b aa b');
});

test('Replace advances past the replacement', () => {
  const { els, textarea, press } = setup('x x x');
  press('f', { ctrlKey: true });
  els['find-input'].value = 'x';
  els['find-input'].fire('input');
  els['replace-input'].value = 'xx';
  els['replace-one'].click();
  assert.strictEqual(textarea.value, 'xx x x');
  assert.strictEqual(els['find-count'].textContent, '3 of 4');
});

test('Replace re-searches first when the textarea changed without an input event', () => {
  const { els, textarea, press } = setup('foo bar');
  press('f', { ctrlKey: true });
  els['find-input'].value = 'bar';
  els['find-input'].fire('input');
  textarea.value = 'xxxxxxxx bar'; // e.g. external update: no input event
  els['replace-input'].value = 'Z';
  els['replace-one'].click();
  assert.strictEqual(textarea.value, 'xxxxxxxx Z');
});
