// WP-10: Word viewer webview (media/docxEditor.js), run in node:vm against a DOM shim with a
// stubbed `docx.renderAsync` (same approach as officeCommon.test.js). Real rendering, zoom
// geometry and theming need the Extension Development Host (Gate R1 checklist).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '../../media', f), 'utf8');
const COMMON_SRC = read('officeCommon.js');
const VIEWER_SRC = read('docxEditor.js');
const deq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDoc = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.id = '';
    this._text = ''; this.style = {}; this.offsetWidth = 0; this.clientWidth = 0; this.scrollTop = 0;
    this.scrolledIntoView = 0;
  }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(_v) { this.ownerDoc.innerHTMLWrites++; }
  get innerHTML() { return ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) { this.children.push(c); } else { this.children.splice(i, 0, c); }
    return c;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); } }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) {
    const e = Object.assign({ target: this, preventDefault() { e.prevented = true; } }, ev);
    (this.listeners[t] || []).forEach((f) => f(e));
    return e;
  }
  click() { return this.fire('click', {}); }
  focus() { this.ownerDoc.activeElement = this; this.fire('focus', {}); }
  scrollIntoView() { this.scrolledIntoView++; }
  find(pred, out = []) { if (pred(this)) { out.push(this); } this.children.forEach((c) => c.find(pred, out)); return out; }
  querySelectorAll(sel) {
    const m = /^(\w+)\.([\w-]+)$/.exec(sel);
    assert.ok(m, 'shim supports tag.class selectors only: ' + sel);
    return this.find((e) => e !== this && e.tagName === m[1].toUpperCase() && e.className.split(/\s+/).includes(m[2]));
  }
}

function setup(opts = {}) {
  const posted = [];
  const win = { listeners: {} };
  const doc = {
    activeElement: null, innerHTMLWrites: 0,
    createElement(tag) { return new FakeEl(tag, doc); },
    getElementById(id) { return doc.body.find((e) => e.id === id)[0] || null; },
  };
  doc.body = new FakeEl('body', doc);
  const bodyClasses = new Set();
  doc.body.classList = { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), contains: (c) => bodyClasses.has(c) };
  const app = doc.createElement('div'); app.id = 'office-app';
  const toolbar = doc.createElement('div'); toolbar.id = 'office-toolbar';
  const banner = doc.createElement('div'); banner.id = 'office-banner';
  const content = doc.createElement('div'); content.id = 'office-content';
  const brandWrap = doc.createElement('div'); brandWrap.id = 'office-brand';
  const brandBtn = doc.createElement('button'); brandBtn.id = 'btn-about';
  brandWrap.appendChild(brandBtn);
  [toolbar, banner, content].forEach((e) => app.appendChild(e));
  doc.body.appendChild(app); doc.body.appendChild(brandWrap);

  win.addEventListener = (t, f) => { (win.listeners[t] = win.listeners[t] || []).push(f); };
  win.dispatch = (t, ev) => (win.listeners[t] || []).forEach((f) => f(ev));
  const sandbox = { window: win, document: doc, console, setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(sandbox);
  vm.runInContext(COMMON_SRC, sandbox);
  vm.runInContext(VIEWER_SRC, sandbox);

  const calls = [];
  const t = { win, doc, posted, content, toolbar, calls, brandBtn, bodyClasses };
  const docxLib = opts.noLib ? undefined : {
    renderAsync: (bytes, body, styles, options) => {
      calls.push({ bytes, body, styles, options });
      if (opts.render) { return opts.render(t, bytes, body, calls.length); }
      for (let i = 0; i < (opts.sections === undefined ? 3 : opts.sections); i++) {
        const s = doc.createElement('section'); s.className = 'docx'; s.offsetWidth = opts.pageWidth || 800;
        body.appendChild(s);
      }
      return Promise.resolve();
    },
  };
  t.viewer = win.DocxViewer.create({
    document: doc, window: win, OfficeCommon: win.OfficeCommon, docxLib,
    vscode: { postMessage: (m) => posted.push(m) },
  });
  t.viewer.start();
  t.send = (msg) => win.dispatch('message', { data: msg });
  t.btn = (label) => toolbar.find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === label)[0];
  t.host = () => content.children.find((c) => c.className === 'docx-host');
  t.render = (bytes) => t.send({ type: 'docxRender', version: 1, bytes: bytes || new Uint8Array(1), blocks: [] });
  return t;
}

const initMsg = (over) => Object.assign({
  type: 'init', kind: 'docx', fileName: 'a.docx', version: 0, canEdit: false, readOnlyReason: 'view-mode', editMode: false, notices: [],
}, over);

test('init posts ready only; the viewer does not request a render itself', () => {
  const t = setup();
  deq(t.posted, [{ type: 'ready' }]);
  t.send(initMsg());
  deq(t.posted, [{ type: 'ready' }]);
  assert.strictEqual(t.calls.length, 0);
});

test('renderAsync is called with renderAltChunks:false, breakPages:true, renderChanges:false (whole options object)', async () => {
  const t = setup();
  const bytes = new Uint8Array([80, 75, 3, 4]);
  t.render(bytes);
  await t.viewer.whenIdle();
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(t.calls[0].bytes, bytes, 'original bytes are passed through untouched');
  assert.strictEqual(t.calls[0].body, t.host());
  deq(t.calls[0].options, {
    breakPages: true, inWrapper: true, ignoreLastRenderedPageBreak: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    renderChanges: false, renderComments: false, renderAltChunks: false,
    experimental: false, useBase64URL: false,
  });
});

test('toolbar shows the section count after a render', async () => {
  const count = (t) => t.toolbar.find((e) => e.className === 'docx-section-count')[0].textContent;
  const t = setup({ sections: 3 });
  t.render();
  await t.viewer.whenIdle();
  assert.strictEqual(count(t), '3 sections');
  const one = setup({ sections: 1 });
  one.render();
  await one.viewer.whenIdle();
  assert.strictEqual(count(one), '1 section');
});

test('clicking http link posts openLink and prevents navigation; javascript: and file: are dropped; #anchor scrolls', async () => {
  const links = {};
  const t = setup({
    render: (tt, bytes, body) => {
      const mkA = (href) => {
        const a = tt.doc.createElement('a');
        if (href !== null) { a.setAttribute('href', href); }
        const s = tt.doc.createElement('span');
        a.appendChild(s); body.appendChild(a);
        return s;
      };
      links.target = tt.doc.createElement('span');
      links.target.setAttribute('id', 'My Bookmark');
      body.appendChild(links.target);
      Object.assign(links, {
        http: mkA('http://example.com/a'), https: mkA('https://example.com/b'), mail: mkA('mailto:a@b.c'),
        js: mkA('javascript:alert(1)'), file: mkA('file:///c:/x'), data: mkA('data:text/html,hi'), rel: mkA('other.docx'),
        anchor: mkA('#My%20Bookmark'), missing: mkA('#nope'), none: mkA(null),
      });
      return Promise.resolve();
    },
  });
  t.render();
  await t.viewer.whenIdle();
  const click = (el) => t.content.fire('click', { target: el });
  const before = t.posted.length;

  let e = click(links.http);
  assert.ok(e.prevented, 'navigation prevented');
  deq(t.posted.slice(before), [{ type: 'openLink', href: 'http://example.com/a' }]);
  click(links.https); click(links.mail);
  deq(t.posted.slice(before + 1).map((m) => m.href), ['https://example.com/b', 'mailto:a@b.c']);

  const n = t.posted.length;
  for (const k of ['js', 'file', 'data', 'rel']) { e = click(links[k]); assert.ok(e.prevented, k + ' still prevented'); }
  assert.strictEqual(t.posted.length, n, 'dropped schemes post nothing');

  e = click(links.anchor);
  assert.ok(e.prevented);
  assert.strictEqual(links.target.scrolledIntoView, 1);
  assert.strictEqual(t.posted.length, n, 'anchors are handled in the webview');
  click(links.missing);
  assert.strictEqual(t.posted.length, n);

  assert.ok(!click(links.none).prevented, 'an element without href is not a link');
  assert.ok(!click(t.content).prevented, 'non-link clicks are untouched');
});

test('render rejection shows the error view', async () => {
  const t = setup({ render: () => Promise.reject(new Error('bad zip <b>x</b>')) });
  t.send(initMsg());
  t.render();
  await t.viewer.whenIdle();
  assert.ok(t.bodyClasses.has('office-has-error'));
  const chrome = t.doc.body.children[0];
  const title = chrome.find((e) => e.className === 'office-error-title')[0];
  assert.match(title.textContent, /can.t be displayed/);
  assert.strictEqual(chrome.find((e) => e.className === 'office-error-detail')[0].textContent, 'bad zip <b>x</b>');
  assert.strictEqual(chrome.find((e) => e.getAttribute('data-action') === 'openExternally').length, 1);
  assert.strictEqual(t.viewer.state().renderFailed, true);
  assert.strictEqual(t.host().children.length, 0);
  assert.strictEqual(t.doc.innerHTMLWrites, 0);
});

test('a missing docx-preview library is a render failure, not an exception', async () => {
  const t = setup({ noLib: true });
  t.render();
  await t.viewer.whenIdle();
  assert.strictEqual(t.viewer.state().renderFailed, true);
  assert.ok(t.bodyClasses.has('office-has-error'));
});

test('a later render replaces a queued older one and renders run one at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let active = 0, maxActive = 0;
  const t = setup({
    render: async (tt, bytes, body, n) => {
      active++; maxActive = Math.max(maxActive, active);
      if (n === 1) { await gate; }
      active--;
    },
  });
  t.render(new Uint8Array([1]));
  t.render(new Uint8Array([2]));
  t.render(new Uint8Array([3]));
  release();
  await t.viewer.whenIdle();
  assert.strictEqual(maxActive, 1);
  deq(t.calls.map((x) => x.bytes[0]), [1, 3]);   // the middle render was superseded
});

test('docxStateChanged requests a render; flushPendingEdits is acknowledged', () => {
  const t = setup();
  t.send({ type: 'docxStateChanged', version: 4 });
  t.send({ type: 'flushPendingEdits', flushId: 9 });
  deq(t.posted.slice(1), [{ type: 'docxRequestRender' }, { type: 'flushed', flushId: 9 }]);
});

test('zoom: Ctrl+= / Ctrl+- / Ctrl+wheel step within 50-200 and the buttons follow', async () => {
  const t = setup();
  t.render();
  await t.viewer.whenIdle();
  const key = (k) => t.win.dispatch('keydown', { key: k, ctrlKey: true, preventDefault() {} });
  assert.strictEqual(t.viewer.state().zoom, 100);
  key('='); assert.strictEqual(t.viewer.state().zoom, 110);
  assert.strictEqual(t.host().style.zoom, '1.1');
  key('+'); assert.strictEqual(t.viewer.state().zoom, 125);
  key('-'); key('-'); key('-'); assert.strictEqual(t.viewer.state().zoom, 90);
  for (let i = 0; i < 10; i++) { key('-'); }
  assert.strictEqual(t.viewer.state().zoom, 50);
  assert.strictEqual(t.btn('Zoom out (Ctrl+-)').disabled, true);
  assert.strictEqual(t.btn('Reset zoom to 100%').textContent, '50%');
  for (let i = 0; i < 12; i++) { key('='); }
  assert.strictEqual(t.viewer.state().zoom, 200);
  assert.strictEqual(t.btn('Zoom in (Ctrl+=)').disabled, true);
  const e = t.content.fire('wheel', { ctrlKey: true, deltaY: 120 });
  assert.ok(e.prevented, 'Ctrl+wheel does not scroll');
  assert.strictEqual(t.viewer.state().zoom, 175);
  assert.ok(!t.content.fire('wheel', { ctrlKey: false, deltaY: 120 }).prevented, 'plain wheel scrolls normally');
  t.btn('Reset zoom to 100%').click();
  assert.strictEqual(t.viewer.state().zoom, 100);
  t.win.dispatch('keydown', { key: '=', ctrlKey: false, preventDefault() {} });
  assert.strictEqual(t.viewer.state().zoom, 100, 'a key without Ctrl does nothing');
});

test('Fit width computes the zoom from the first page and follows resize; manual zoom turns it off', async () => {
  const t = setup({ pageWidth: 800 });
  t.render();
  await t.viewer.whenIdle();
  t.content.clientWidth = 1240;   // minus the 40px margin = 1200 -> 150%
  t.btn('Fit width').click();
  assert.strictEqual(t.viewer.state().zoom, 150);
  assert.strictEqual(t.viewer.state().fit, true);
  assert.strictEqual(t.btn('Fit width').getAttribute('aria-pressed'), 'true');
  t.content.clientWidth = 440;    // 400 -> 50%
  t.win.dispatch('resize', {});
  assert.strictEqual(t.viewer.state().zoom, 50);
  t.content.clientWidth = 5000;   // clamps at 200
  t.win.dispatch('resize', {});
  assert.strictEqual(t.viewer.state().zoom, 200);
  t.win.dispatch('keydown', { key: '-', ctrlKey: true, preventDefault() {} });
  assert.strictEqual(t.viewer.state().fit, false);
  assert.strictEqual(t.btn('Fit width').getAttribute('aria-pressed'), 'false');
});

test('toolbar: Open in Word and the brand button post their messages', () => {
  const t = setup();
  t.btn('Open in Word').click();
  t.brandBtn.click();
  deq(t.posted.slice(1), [{ type: 'openExternally' }, { type: 'showAbout' }]);
  assert.strictEqual(t.toolbar.getAttribute('role'), 'toolbar');
  assert.ok(t.toolbar.children.includes(t.brandBtn), 'brand button moved into the toolbar');
});

test('edit hint shows for typing in View mode only when editing is possible', () => {
  const t = setup();
  const hintEl = () => t.doc.body.children[0].find((e) => e.className === 'office-hint')[0];
  t.send(initMsg({ canEdit: false, readOnlyReason: 'protected' }));
  t.content.fire('keydown', { key: 'a' });
  assert.strictEqual(hintEl().hidden, true, 'no misleading hint when Edit is unavailable');
  t.send(initMsg({ canEdit: true, readOnlyReason: null }));
  t.content.fire('keydown', { key: ' ' });
  assert.strictEqual(hintEl().hidden, true, 'Space scrolls, no hint');
  t.content.fire('keydown', { key: 'a', ctrlKey: true });
  assert.strictEqual(hintEl().hidden, true);
  t.content.fire('keydown', { key: 'a' });
  assert.strictEqual(hintEl().textContent, 'Press Edit (Ctrl+E) to make changes');
  assert.strictEqual(hintEl().hidden, false);
});

test('no innerHTML use in the viewer script', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(VIEWER_SRC));
});

test('stylesheet has theme-token backdrop, high-contrast outline, forced-colors and reduced-motion blocks', () => {
  const css = read('docxEditor.css');
  assert.match(css, /\.docx-backdrop/);
  assert.match(css, /vscode-contrastBorder/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /prefers-reduced-motion/);
});
