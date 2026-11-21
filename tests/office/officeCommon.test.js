// Tests for the common Office webview chrome (media/officeCommon.js), run in node:vm against a
// minimal DOM shim (same approach as tests/findBar.test.js).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../../media/officeCommon.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../../media/officeCommon.css'), 'utf8');
// Values created inside the vm context have a foreign Object prototype; compare structurally.
const deq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.id = '';
    this._text = '';
    this.innerHTMLWrites = 0;
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(_v) { this.innerHTMLWrites++; }
  get innerHTML() { return ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) { this.children.push(c); } else { this.children.splice(i, 0, c); }
    return c;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(ev || {})); }
  click() { this.fire('click', {}); }
  focus() { this.ownerDoc.activeElement = this; this.fire('focus', {}); }
  find(pred, out = []) {
    if (pred(this)) { out.push(this); }
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}

function setup() {
  const posted = [];
  const win = { listeners: {} };
  const doc = {
    activeElement: null,
    body: new FakeEl('body'),
    createElement(tag) { const e = new FakeEl(tag); e.ownerDoc = doc; return e; },
    getElementById() { return null; },
  };
  doc.body.ownerDoc = doc;
  const bodyClasses = new Set();
  doc.body.classList = {
    add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c),
    contains: (c) => bodyClasses.has(c),
  };
  // Window listeners in DOM order: capture-phase ones first, then the bubble-phase ones (where VS Code's own keydown
  // listener sits in a real webview) only when nothing stopped propagation.
  win.capture = new Set();
  win.addEventListener = (t, f, o) => { (win.listeners[t] = win.listeners[t] || []).push(f); if (o === true || (o && o.capture)) { win.capture.add(f); } };
  win.dispatch = (t, ev) => {
    const e = ev && typeof ev === 'object' ? ev : {};
    const own = e.stopPropagation;
    e.stopPropagation = function () { e.stopped = true; if (own) { own.call(e); } };
    if (!e.preventDefault) { e.preventDefault = function () { e.prevented = true; }; }
    const all = (win.listeners[t] || []).slice();
    all.filter((f) => win.capture.has(f)).forEach((f) => f(e));
    if (!e.stopped) { all.filter((f) => !win.capture.has(f)).forEach((f) => f(e)); }
    return e;
  };
  const timers = [];
  const sandbox = {
    window: win, document: doc, console,
    setTimeout: (f) => { timers.push(f); return timers.length; },
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const OC = win.OfficeCommon;
  const events = { toggles: [], messages: [] };
  OC.init({
    vscode: { postMessage: (m) => posted.push(m) },
    onEditModeToggle: (v) => events.toggles.push(v),
    onMessage: (m) => events.messages.push(m),
  });
  const root = doc.body.children[0];
  const q = (pred) => root.find(pred);
  return { OC, win, doc, posted, events, root, q, timers, bodyClasses };
}

const initMsg = (over) => Object.assign({
  type: 'init', kind: 'docx', fileName: 'a.docx', version: 0,
  canEdit: true, readOnlyReason: null, editMode: false, notices: [],
}, over);

test('init posts ready and forwards unknown messages to onMessage', () => {
  const t = setup();
  deq(t.posted, [{ type: 'ready' }]);
  t.win.dispatch('message', { data: { type: 'docxStateChanged', version: 3 } });
  assert.strictEqual(t.events.messages[0].type, 'docxStateChanged');
});

test('toolbar arrow keys move focus and wrap', () => {
  const t = setup();
  const container = t.doc.createElement('div');
  const clicks = [];
  const tb = t.OC.toolbar(container, [
    { id: 'a', label: 'A', onClick: () => clicks.push('a') },
    { id: 'b', label: 'B', toggle: true, pressed: false },
    { id: 'c', label: 'C' },
  ]);
  assert.strictEqual(container.getAttribute('role'), 'toolbar');
  const [a, b, c] = tb.buttons;
  deq(tb.buttons.map((x) => x.getAttribute('tabindex')), ['0', '-1', '-1']);
  const key = (k) => container.fire('keydown', { key: k, preventDefault() {} });
  a.focus();
  key('ArrowRight'); assert.strictEqual(t.doc.activeElement, b);
  deq(tb.buttons.map((x) => x.getAttribute('tabindex')), ['-1', '0', '-1']);
  key('ArrowRight'); assert.strictEqual(t.doc.activeElement, c);
  key('ArrowRight'); assert.strictEqual(t.doc.activeElement, a, 'wraps forward');
  key('ArrowLeft'); assert.strictEqual(t.doc.activeElement, c, 'wraps backward');
  key('Home'); assert.strictEqual(t.doc.activeElement, a);
  key('End'); assert.strictEqual(t.doc.activeElement, c);
  // aria-pressed toggles
  assert.strictEqual(b.getAttribute('aria-pressed'), 'false');
  b.click();
  assert.strictEqual(b.getAttribute('aria-pressed'), 'true');
  a.click();
  deq(clicks, ['a']);
});

test('toolbar arrow keys skip disabled buttons', () => {
  const t = setup();
  const container = t.doc.createElement('div');
  const tb = t.OC.toolbar(container, [
    { id: 'a', label: 'A' }, { id: 'b', label: 'B', disabled: true }, { id: 'c', label: 'C' },
  ]);
  tb.buttons[0].focus();
  container.fire('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.strictEqual(t.doc.activeElement, tb.buttons[2]);
});

test('Edit toggle hidden when canEdit is false and shows the reason', () => {
  const t = setup();
  const edit = () => t.q((e) => e.getAttribute('title') === 'Edit (Ctrl+E)')[0];
  t.OC.setInit(initMsg({ canEdit: false, readOnlyReason: 'protected' }));
  assert.strictEqual(edit().hidden, true);
  const reason = t.q((e) => e.className === 'office-reason')[0];
  assert.strictEqual(reason.hidden, false);
  assert.strictEqual(reason.textContent, t.OC.READ_ONLY_TEXT.protected);
  t.OC.setInit(initMsg({ canEdit: true }));
  assert.strictEqual(edit().hidden, false);
  assert.strictEqual(reason.hidden, true);
});

test('tracked-changes-on keeps the Edit toggle and asks the host (Edit anyway); protected does not', () => {
  const t = setup();
  const edit = () => t.q((e) => e.getAttribute('title') === 'Edit (Ctrl+E)')[0];
  t.OC.setInit(initMsg({ canEdit: false, readOnlyReason: 'tracked-changes-on' }));
  assert.strictEqual(edit().hidden, false);
  const before = t.posted.length;
  edit().click();
  assert.strictEqual(JSON.stringify(t.posted.slice(before)), JSON.stringify([{ type: 'setEditMode', editMode: true }]));
  t.OC.setInit(initMsg({ canEdit: false, readOnlyReason: 'protected' }));
  assert.strictEqual(edit().hidden, true);
  const n = t.posted.length;
  t.win.dispatch('keydown', { key: 'e', ctrlKey: true, preventDefault() {} });
  assert.strictEqual(t.posted.length, n, 'protected never asks');
});

test('READ_ONLY_TEXT covers every ReadOnlyReason', () => {
  const reasons = ['view-mode', 'non-writable-scheme', 'too-large', 'protected', 'strict-ooxml',
    'unsupported-xml-layout', 'utf16-part', 'tracked-changes-on'];
  for (const r of reasons) { assert.ok(t_text(r), r); }
  function t_text(r) { return setup().OC.READ_ONLY_TEXT[r]; }
});

test('notices render with textContent only (no HTML injection from a <b> payload)', () => {
  const t = setup();
  t.OC.showNotices([{ severity: 'warning', code: 'x', message: '<b>bold</b><img src=x onerror=1>' }]);
  const text = t.q((e) => e.className === 'office-notice-text')[0];
  assert.strictEqual(text.textContent, '<b>bold</b><img src=x onerror=1>');
  assert.strictEqual(t.q((e) => e.tagName === 'B' || e.tagName === 'IMG').length, 0);
  const all = t.q(() => true);
  assert.strictEqual(all.reduce((n, e) => n + e.innerHTMLWrites, 0), 0);
  t.win.dispatch('message', { data: { type: 'notices', notices: [] } });
  assert.strictEqual(t.q((e) => e.className === 'office-notice-text').length, 0);
});

test('error view exposes the allowed actions', () => {
  const t = setup();
  t.OC.setInit(initMsg({ kind: 'xlsx' }));
  t.win.dispatch('message', { data: { type: 'loadError', title: '<i>Damaged</i>', detail: 'zip: bad CRC',
    actions: ['openExternally', 'retry'] } });
  const btns = t.q((e) => e.tagName === 'BUTTON' && e.getAttribute('data-action'));
  deq(btns.map((b) => b.getAttribute('data-action')), ['openExternally', 'retry']);
  assert.strictEqual(btns[0].textContent, 'Open in Excel');
  btns[0].click(); btns[1].click();
  deq(t.posted.slice(-2), [{ type: 'openExternally' }, { type: 'retry' }]);
  assert.strictEqual(t.q((e) => e.className === 'office-error-title')[0].textContent, '<i>Damaged</i>');
  assert.strictEqual(t.q((e) => e.tagName === 'I').length, 0);
  assert.ok(t.bodyClasses.has('office-has-error'));
  // Only the allowed actions render.
  t.win.dispatch('message', { data: { type: 'loadError', title: 't', detail: '', actions: ['retry'] } });
  deq(t.q((e) => e.tagName === 'BUTTON' && e.getAttribute('data-action'))
    .map((b) => b.getAttribute('data-action')), ['retry']);
});

test('Ctrl+E posts setEditMode', () => {
  const t = setup();
  t.OC.setInit(initMsg({ canEdit: true, editMode: false }));
  let prevented = 0;
  t.win.dispatch('keydown', { key: 'e', ctrlKey: true, preventDefault() { prevented++; } });
  deq(t.posted.pop(), { type: 'setEditMode', editMode: true });
  assert.strictEqual(prevented, 1);
  // Host confirms; the next Ctrl+E (Cmd on macOS) turns it off.
  t.win.dispatch('message', { data: { type: 'editModeChanged', editMode: true } });
  deq(t.events.toggles.pop(), true);
  t.win.dispatch('keydown', { key: 'E', metaKey: true, preventDefault() {} });
  deq(t.posted.pop(), { type: 'setEditMode', editMode: false });
  // Other chords are ignored.
  const n = t.posted.length;
  t.win.dispatch('keydown', { key: 'e', ctrlKey: true, shiftKey: true, preventDefault() {} });
  assert.strictEqual(t.posted.length, n);
});

test('Ctrl+E when read-only posts nothing and shows the reason hint', () => {
  const t = setup();
  t.OC.setInit(initMsg({ canEdit: false, readOnlyReason: 'too-large' }));
  const n = t.posted.length;
  const e = t.win.dispatch('keydown', { key: 'e', ctrlKey: true });
  assert.ok(e.prevented && e.stopped, 'the hint answers it');
  assert.strictEqual(t.posted.length, n);
  assert.strictEqual(t.q((e) => e.className === 'office-hint')[0].textContent, t.OC.READ_ONLY_TEXT['too-large']);
});

test('Ctrl+E in the viewers-only build (no edit, no reason) shows no "Press Edit" hint and is left to VS Code', () => {
  const t = setup();
  t.OC.setInit(initMsg({ canEdit: false, readOnlyReason: null }));
  const n = t.posted.length;
  const e = t.win.dispatch('keydown', { key: 'e', ctrlKey: true });
  assert.ok(!e.prevented && !e.stopped, 'nothing to toggle: VS Code gets Ctrl+E (Quick Open)');
  assert.strictEqual(t.posted.length, n);
  const hintEl = t.q((e) => e.className === 'office-hint')[0];
  assert.strictEqual(hintEl.hidden, true);
  assert.strictEqual(hintEl.textContent, '');
});

test('Edit button click posts setEditMode; hint auto-clears and announces politely', () => {
  const t = setup();
  t.OC.setInit(initMsg());
  t.q((e) => e.getAttribute('title') === 'Edit (Ctrl+E)')[0].click();
  deq(t.posted.pop(), { type: 'setEditMode', editMode: true });
  t.OC.hint(t.OC.EDIT_HINT);
  const hintEl = t.q((e) => e.className === 'office-hint')[0];
  const live = t.q((e) => e.getAttribute('aria-live') === 'polite')[0];
  assert.strictEqual(hintEl.hidden, false);
  assert.strictEqual(live.textContent, 'Press Edit (Ctrl+E) to make changes');
  t.timers.forEach((f) => f());
  assert.strictEqual(hintEl.hidden, true);
  t.OC.announce('x'); t.OC.announce('x');
  assert.strictEqual(live.textContent, 'x ', 'repeat announcements still change the live region');
});

test('requestFailed surfaces the error message and is still forwarded', () => {
  const t = setup();
  t.win.dispatch('message', { data: { type: 'requestFailed', requestId: 4, error: { code: 'internal', message: 'Boom' } } });
  assert.strictEqual(t.q((e) => e.className === 'office-hint')[0].textContent, 'Boom');
  assert.strictEqual(t.events.messages.at(-1).requestId, 4);
});

test('no innerHTML and theme tokens only; reduced-motion and forced-colors blocks present', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(SRC));
  assert.match(CSS, /prefers-reduced-motion:\s*reduce/);
  assert.match(CSS, /forced-colors:\s*active/);
  assert.match(CSS, /--vscode-/);
  // No bare hex / rgb colours outside var() usage.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('pdf kind: PDF read-only sentences cover every PdfReadOnlyReason and Office text is unchanged', () => {
  const t = setup();
  const reasons = ['view-mode', 'non-writable-scheme', 'too-large', 'encrypted', 'unsupported-structure', 'engine-too-old'];
  for (const r of reasons) {
    t.OC.setInit(initMsg({ kind: 'pdf', canEdit: false, readOnlyReason: r }));
    const reason = t.q((e) => e.className === 'office-reason')[0];
    assert.strictEqual(reason.hidden, false, r);
    assert.strictEqual(reason.textContent, t.OC.PDF_READ_ONLY_TEXT[r], r);
    assert.ok(reason.textContent.length > 20 && !/Word|Excel/.test(reason.textContent), r);
  }
  // Same reason under an Office kind still uses the Office sentence.
  t.OC.setInit(initMsg({ kind: 'docx', canEdit: false, readOnlyReason: 'view-mode' }));
  assert.strictEqual(t.q((e) => e.className === 'office-reason')[0].textContent, t.OC.READ_ONLY_TEXT['view-mode']);
});

test('pdf kind: error view says "Open externally", names no Office app, stays textContent-only', () => {
  const t = setup();
  t.OC.setInit(initMsg({ kind: 'pdf', fileName: 'a.pdf' }));
  assert.strictEqual(t.OC.appName(), 'a PDF reader');
  t.win.dispatch('message', { data: { type: 'loadError', title: '<b>Bad</b>', detail: 'x', actions: ['openExternally', 'retry'] } });
  const btns = t.q((e) => e.tagName === 'BUTTON' && e.getAttribute('data-action'));
  assert.strictEqual(btns[0].textContent, 'Open externally');
  btns[0].click();
  deq(t.posted.slice(-1), [{ type: 'openExternally' }]);
  assert.strictEqual(t.q((e) => e.tagName === 'B').length, 0);
});

test('pdf kind: Ctrl+E without edit rights hints with the PDF sentence', () => {
  const t = setup();
  t.OC.setInit(initMsg({ kind: 'pdf', canEdit: false, readOnlyReason: 'encrypted' }));
  t.win.dispatch('keydown', { key: 'e', ctrlKey: true, preventDefault() {} });
  assert.strictEqual(t.q((e) => e.className === 'office-hint')[0].textContent, t.OC.PDF_READ_ONLY_TEXT.encrypted);
});

test('Ctrl+E is handled in the capture phase and stopped; keys VS Code must get pass through', () => {
  const t = setup();
  t.OC.setInit(initMsg({ canEdit: true, editMode: false }));
  // Stands in for VS Code's own keydown listener in the webview (bubble phase on window).
  const forwarded = [];
  t.win.addEventListener('keydown', (e) => forwarded.push((e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key));
  const e = t.win.dispatch('keydown', { key: 'e', ctrlKey: true });
  assert.ok(e.prevented && e.stopped, 'Ctrl+E is not also Quick Open');
  deq(t.posted.pop(), { type: 'setEditMode', editMode: true });
  for (const k of ['s', 'z', 'y', 'w', 'p']) {
    const o = t.win.dispatch('keydown', { key: k, ctrlKey: true });
    assert.ok(!o.prevented && !o.stopped, `Ctrl+${k}`);
  }
  const shiftE = t.win.dispatch('keydown', { key: 'E', ctrlKey: true, shiftKey: true });
  assert.ok(!shiftE.prevented && !shiftE.stopped, 'Ctrl+Shift+E (Explorer) is not ours');
  deq(forwarded, ['Ctrl+s', 'Ctrl+z', 'Ctrl+y', 'Ctrl+w', 'Ctrl+p', 'Ctrl+Shift+E']);
});
