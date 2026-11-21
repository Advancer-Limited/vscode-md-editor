// PWP-05: the PDF host shell (PdfDocument, PdfEditorProvider on the Office provider base) driven end
// to end against the in-memory `vscode` stub. The host files import 'vscode', so they are bundled
// here with esbuild and 'vscode' resolved to tests/pdf/_vscodeStub.cjs. Spec §4.1, §5, §6.1, §7.5,
// §7.6, §9.3, §9.4, §12. What this cannot show (real webview, real watcher, the Save dialog) is a
// Gate P1 item.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;
const MB = 1024 * 1024;

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'pdf-host.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/pdf/pdfEditorProvider.ts';",
        "export * from './src/pdf/pdfDocument.ts';",
        "export * from './src/pdf/loadErrors.ts';",
        "export * from './src/pdf/featureFlags.ts';",
        "export { PDF_LIMITS } from './src/pdf/core/limits.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'pdf-host-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{
      name: 'vscode-stub',
      setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); },
    }],
  });
  host = require(outfile);
  host.PdfDocument.diskCheckDelayMs = 0;
});

beforeEach(() => { S.reset(); host.PdfDocument.flags = host.PDF_FLAGS; });
after(() => { host.PdfDocument.flags = host.PDF_FLAGS; });

const ctx = {
  extensionUri: vscode.Uri.file('/ext'),
  extension: { packageJSON: { name: 'x', displayName: 'X', version: '0.0.0', description: '' } },
  subscriptions: [],
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function makePanel() {
  const sent = [];
  let onMsg = () => {};
  let onDispose = () => {};
  return {
    sent,
    webview: {
      options: {}, html: '', cspSource: 'https://csp.example',
      asWebviewUri: (u) => ({ toString: () => 'https://webview' + u.path }),
      postMessage: async (m) => { sent.push(m); return true; },
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: (fn) => { onDispose = fn; return { dispose() {} }; },
    send: (raw) => onMsg(raw),
    close: () => onDispose(),
    types: () => sent.map((m) => m.type),
    last: (type) => [...sent].reverse().find((m) => m.type === type),
  };
}

const enc = (s) => new TextEncoder().encode(s);
const pdf = (tag = 'a') => enc(`%PDF-1.7\n% ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
/** A zero-filled PDF-looking buffer of `size` bytes (only the header matters to the host). */
function bigPdf(size) {
  const b = new Uint8Array(size);
  b.set(enc('%PDF-1.7\n'), 0);
  return b;
}

async function open(name, bytes, { scheme = 'file', dir = '/ws', backupId } = {}) {
  const uri = scheme === 'file' ? vscode.Uri.file(`${dir}/${name}`) : new vscode.Uri(scheme, `${dir}/${name}`, 'ref=HEAD');
  if (bytes) S.writeFile(uri, bytes, 1000);
  const provider = new host.PdfEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  return { provider, doc, panel, uri };
}

async function waitFor(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('timed out waiting for ' + what);
}
const tick = () => new Promise((r) => setTimeout(r, 30));

const FACTS = {
  pageCount: 3, encrypted: false, hasText: true, hasJavaScript: false, hasXfa: false,
  attachmentCount: 0, signatures: [],
};

// ---------------------------------------------------------------------------------------------
// Registration, HTML, CSP

test('registration options: viewType, retainContextWhenHidden (S8), no find widget, one editor per document', () => {
  host.PdfEditorProvider.register(ctx);
  assert.strictEqual(S.registered.length, 1);
  const r = S.registered[0];
  assert.strictEqual(r.viewType, 'vscodeMdEditor.pdf');
  assert.deepStrictEqual(r.options, {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
    supportsMultipleEditorsPerDocument: false,
  });
});

test('pdfCsp: exact §12 string, only the webview origin, no unsafe-eval/unsafe-inline', () => {
  const csp = host.pdfCsp('https://csp.example', 'NONCE');
  assert.strictEqual(csp,
    "default-src 'none'; script-src 'nonce-NONCE' 'wasm-unsafe-eval'; worker-src blob:; "
    + 'connect-src https://csp.example; style-src https://csp.example; img-src https://csp.example data:; '
    + "font-src https://csp.example; form-action 'none'; base-uri 'none';");
  assert.doesNotMatch(csp, /'unsafe-eval'|unsafe-inline|frame-src|object-src|\*/);
  // Every source that is not a keyword is the webview origin.
  const sources = csp.split(';').flatMap((d) => d.trim().split(/\s+/).slice(1)).filter(Boolean);
  for (const s of sources) {
    assert.ok(s === 'https://csp.example' || /^'[^']+'$/.test(s) || s === 'blob:' || s === 'data:', s);
  }
  assert.deepStrictEqual(csp.split(';').map((d) => d.trim().split(/\s+/)[0]).filter(Boolean),
    ['default-src', 'script-src', 'worker-src', 'connect-src', 'style-src', 'img-src', 'font-src', 'form-action', 'base-uri']);
});

test('HTML: CSP with a fresh nonce, nonce on every script, ?v= on every asset, media/ the only root', async () => {
  const { panel } = await open('a.pdf', pdf());
  const html = panel.webview.html;
  assert.deepStrictEqual(panel.webview.options.localResourceRoots.map((u) => u.path), ['/ext/media']);
  assert.strictEqual(panel.webview.options.enableScripts, true);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
  assert.ok(nonce.length >= 32);
  assert.strictEqual(csp, host.pdfCsp('https://csp.example', nonce));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts.map((a) => /src="https:\/\/webview\/ext\/media\/([^?"]+)\?v=\d+"/.exec(a)?.[1]),
    ['pdfjs-bundle.js', 'officeCommon.js', 'pdfViewMath.js', 'pdfViewer.js', 'pdfSidebar.js', 'pdfFind.js']);
  for (const a of scripts) assert.ok(a.includes(`nonce="${nonce}"`));
  const links = [...html.matchAll(/<link href="([^"]+)" rel="stylesheet">/g)].map((m) => m[1]);
  assert.deepStrictEqual(links.map((l) => /\/ext\/media\/([^?]+)\?v=\d+$/.exec(l)?.[1]),
    ['pdfjs/pdf_viewer.css', 'officeCommon.css', 'pdfViewer.css', 'pdfSidebar.css', 'pdfFind.css']);
  assert.match(html, /data-pdfjs-base="https:\/\/webview\/ext\/media\/pdfjs\/"/);
  assert.match(html, /data-cache-bust="\d+"/);
  assert.match(html, /<body data-office-kind="pdf">/);
  assert.match(html, /<title>PDF Viewer<\/title>/);
  // No inline style anywhere (the CSP has no 'unsafe-inline').
  assert.doesNotMatch(html, /\sstyle=|<style/);
});

// ---------------------------------------------------------------------------------------------
// Load, payload, read-only

test('ready: init (kind pdf, read-only, flag off); the bytes are sent only when requested', async () => {
  const bytes = pdf();
  const { doc, panel } = await open('a.pdf', bytes);
  await panel.send({ type: 'ready' });
  assert.deepStrictEqual(panel.sent, [{
    type: 'init', kind: 'pdf', fileName: 'a.pdf', version: 0,
    canEdit: false, readOnlyReason: null, editMode: false, notices: [],
  }]);
  await panel.send({ type: 'pdfRequestDocument' });
  const m = panel.last('pdfDocument');
  assert.deepStrictEqual(Object.keys(m).sort(), ['bytes', 'generation', 'type', 'version']);
  assert.strictEqual(m.generation, 1);
  assert.strictEqual(m.version, 0);
  assert.strictEqual(m.bytes.constructor, Uint8Array);
  assert.deepStrictEqual(Buffer.from(m.bytes), Buffer.from(bytes));
  assert.strictEqual(doc.generation, 1);
});

test('payload is a plain Uint8Array even when readFile returns a Buffer or a pooled view', async () => {
  const bytes = pdf('buffer');
  // A Buffer sharing a larger pool, like Node's small-buffer allocations.
  const pool = Buffer.alloc(bytes.length + 100);
  pool.set(bytes, 50);
  const view = pool.subarray(50, 50 + bytes.length);
  assert.ok(view instanceof Buffer && view.byteOffset === 50);
  const { panel } = await open('b.pdf', view);
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'pdfRequestDocument' });
  const m = panel.last('pdfDocument');
  assert.strictEqual(m.bytes.constructor, Uint8Array);
  assert.strictEqual(m.bytes.byteOffset, 0);
  assert.strictEqual(m.bytes.buffer.byteLength, bytes.length);
  assert.deepStrictEqual(Buffer.from(m.bytes), Buffer.from(bytes));
  assert.strictEqual(host.plainBytes(m.bytes), m.bytes, 'an already-plain array is not copied again');
});

test('load errors: empty, not a PDF, unreadable — error view, never thrown, never sent bytes', async () => {
  const cases = [
    ['empty.pdf', new Uint8Array(0), 'This file is empty.', ['openExternally', 'retry']],
    ['text.pdf', enc('just some text'), "This file isn't a PDF.", ['openExternally']],
    ['zip.pdf', Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0), "This file isn't a PDF.", ['openExternally']],
    ['missing.pdf', null, "This file couldn't be read.", ['openExternally', 'retry']],
  ];
  for (const [name, bytes, title, actions] of cases) {
    S.reset();
    const { doc, panel } = await open(name, bytes);
    assert.strictEqual(doc.base, null, name);
    await panel.send({ type: 'ready' });
    assert.deepStrictEqual(panel.types(), ['loadError'], name);
    assert.strictEqual(panel.sent[0].title, title, name);
    assert.deepStrictEqual(panel.sent[0].actions, actions, name);
    assert.strictEqual(typeof panel.sent[0].detail, 'string');
    // A request for the bytes repeats the error view instead.
    await panel.send({ type: 'pdfRequestDocument' });
    assert.deepStrictEqual(panel.types(), ['loadError', 'loadError'], name);
    assert.strictEqual(doc.canEdit, false);
  }
});

test('a file over 500 MB is refused from its stat, without being read', async () => {
  const uri = vscode.Uri.file('/ws/huge.pdf');
  const size = host.PDF_LIMITS.maxFileBytes + 1;
  S.files.set(uri.toString(), { data: { length: size }, mtime: 1000 });   // only stat can see this fake
  const provider = new host.PdfEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  assert.strictEqual(doc.base, null);
  assert.strictEqual(doc.loadError.title, 'This file is too large to open here (501 MB).');
  assert.deepStrictEqual(doc.loadError.actions, ['openExternally']);
  assert.deepStrictEqual(S.reads, [], 'the bytes were never read');
});

test('over 100 MB is view-only (too-large); over 150 MB also gets the large-file notice', async () => {
  host.PdfDocument.flags = { pdfEdit: true, pdfForms: false };
  const big = await open('big.pdf', bigPdf(150 * MB + 1));
  assert.strictEqual(big.doc.readOnlyReason, 'too-large');
  assert.strictEqual(big.doc.canEdit, false);
  await big.panel.send({ type: 'ready' });
  const init = big.panel.last('init');
  assert.strictEqual(init.readOnlyReason, 'too-large');
  assert.deepStrictEqual(init.notices.map((n) => n.code), ['large-file']);
  assert.match(init.notices[0].message, /151 MB/);
  big.doc.dispose();
  S.reset();
  const mid = await open('mid.pdf', bigPdf(100 * MB + 1));
  assert.strictEqual(mid.doc.readOnlyReason, 'too-large');
  assert.deepStrictEqual(mid.doc.notices, []);
  mid.doc.dispose();
});

test('git: side of a diff is read-only (non-writable-scheme) and not watched', async () => {
  const { doc, panel } = await open('a.pdf', pdf(), { scheme: 'git' });
  await panel.send({ type: 'ready' });
  assert.strictEqual(panel.sent[0].readOnlyReason, 'non-writable-scheme');
  assert.strictEqual(doc.canEdit, false);
  assert.strictEqual(S.watchers.length, 0);
  await panel.send({ type: 'pdfRequestDocument' });
  assert.strictEqual(panel.last('pdfDocument').bytes.length, pdf().length);
});

test('flag off: Edit is refused (no edit mode, canEdit false); flag on: allowed for a plain file', async () => {
  const off = await open('a.pdf', pdf());
  await off.panel.send({ type: 'ready' });
  await off.panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(off.panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
  assert.strictEqual(host.PDF_FLAGS.pdfEdit, false);
  assert.strictEqual(host.PDF_FLAGS.pdfForms, false);
  assert.ok(Object.isFrozen(host.PDF_FLAGS));

  host.PdfDocument.flags = { pdfEdit: true, pdfForms: false };
  const on = await open('b.pdf', pdf());
  await on.panel.send({ type: 'ready' });
  assert.strictEqual(on.panel.last('init').canEdit, true);
  await on.panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(on.panel.last('editModeChanged'), { type: 'editModeChanged', editMode: true });
});

test('read-only replies: pdfEdit -> read-only error; invalid -> one reply; stray pdfWriteResult dropped', async () => {
  const { panel } = await open('a.pdf', pdf());
  await panel.send({ type: 'ready' });
  const n0 = panel.sent.length;
  await panel.send({ type: 'pdfEdit', requestId: 7, baseVersion: 0,
    edit: { op: 'removeAnnotation', target: { ref: { num: 5, gen: 0 } } } });
  assert.deepStrictEqual(panel.sent.at(-1), {
    type: 'pdfEditResult', requestId: 7, ok: false, error: { code: 'read-only', message: 'This document is open read-only.' },
  });
  await panel.send({ type: 'pdfEdit', requestId: 8, baseVersion: 0, edit: { op: 'nope' } });
  assert.deepStrictEqual(panel.sent.at(-1), { type: 'requestFailed', requestId: 8, error: { code: 'invalid', message: 'The request was not understood.' } });
  await panel.send({ type: 'pdfWriteResult', requestId: 9, ok: false, message: 'x' });
  await panel.send({ type: 'whatever' });
  await panel.send(null);
  assert.strictEqual(panel.sent.length, n0 + 2);
  // A malformed write result (no observed facts) is invalid and answered as such.
  await panel.send({ type: 'pdfWriteResult', requestId: 10, ok: true, bytes: new Uint8Array(0), observed: {} });
  assert.strictEqual(panel.sent.at(-1).type, 'requestFailed');
});

// ---------------------------------------------------------------------------------------------
// Reload on change

test('changed on disk while clean: reload, version and generation bump, init re-sent, bytes on request', async () => {
  const { doc, panel, uri } = await open('a.pdf', pdf('one'));
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'pdfRequestDocument' });
  assert.strictEqual(S.watchers.length, 1);
  assert.strictEqual(S.watchers[0].pattern.pattern, 'a.pdf');
  assert.strictEqual(S.watchers[0].pattern.base.path, '/ws');
  // Unchanged stamp: ignored.
  S.watchers[0].fireChange();
  await tick();
  assert.deepStrictEqual(panel.types(), ['init', 'pdfDocument']);
  S.writeFile(uri, pdf('two'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().length === 3, 'init after reload');
  assert.deepStrictEqual(panel.types(), ['init', 'pdfDocument', 'init'], 'no unsolicited bytes');
  assert.strictEqual(panel.sent[2].version, 1);
  assert.strictEqual(doc.generation, 2);
  await panel.send({ type: 'pdfRequestDocument' });
  const m = panel.last('pdfDocument');
  assert.strictEqual(m.generation, 2);
  assert.strictEqual(m.version, 1);
  assert.deepStrictEqual(Buffer.from(m.bytes), Buffer.from(pdf('two')));
  // Becoming not-a-PDF on disk switches to the error view; recovering sends init again.
  S.writeFile(uri, enc('garbage'), 6000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().at(-1) === 'loadError', 'loadError');
  S.writeFile(uri, pdf('three'), 7000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().at(-1) === 'init', 'init after recovery');
  doc.dispose();
  assert.ok(S.watchers[0].disposed);
});

test('changed on disk while dirty (Phase 2 hook): warning notice, no reload', async () => {
  const { doc, panel, uri } = await open('a.pdf', pdf());
  await panel.send({ type: 'ready' });
  doc.isDirty = () => true;
  S.writeFile(uri, pdf('changed'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().includes('notices'), 'notices');
  assert.deepStrictEqual(panel.last('notices').notices.map((n) => n.code), ['changed-on-disk']);
  assert.strictEqual(doc.version, 0);
});

test('Retry reloads: an empty file that is then written opens normally', async () => {
  const { doc, panel, uri } = await open('later.pdf', new Uint8Array(0));
  await panel.send({ type: 'ready' });
  assert.deepStrictEqual(panel.types(), ['loadError']);
  S.writeFile(uri, pdf(), 2000);
  await panel.send({ type: 'retry' });
  assert.deepStrictEqual(panel.types(), ['loadError', 'init']);
  assert.strictEqual(panel.sent[1].version, 1);
  assert.strictEqual(doc.generation, 2);
});

test('the disk stamp is taken before the read: a write landing during the read still triggers a reload', async () => {
  const uri = vscode.Uri.file('/ws/a.pdf');
  S.writeFile(uri, pdf('one'), 1000);
  const realRead = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async (u) => {
    const data = await realRead(u);
    S.writeFile(uri, pdf('two!'), 2000);
    vscode.workspace.fs.readFile = realRead;
    return data;
  };
  try {
    const provider = new host.PdfEditorProvider(ctx);
    const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
    assert.deepStrictEqual(doc.diskStamp, { mtime: 1000, size: pdf('one').length });
    S.watchers[0].fireChange();
    await waitFor(() => doc.version === 1, 'reload after the racing write');
    assert.deepStrictEqual(Buffer.from(doc.base), Buffer.from(pdf('two!')));
  } finally {
    vscode.workspace.fs.readFile = realRead;
  }
});

test('a name with glob characters is watched through its directory and filtered by URI', async () => {
  const { doc, uri } = await open('Report [draft] {v2}.pdf', pdf());
  assert.strictEqual(S.watchers[0].pattern.pattern, '*');
  S.writeFile(uri, pdf('new'), 5000);
  S.watchers[0].fireChange(vscode.Uri.file('/ws/other.pdf'));
  await tick();
  assert.strictEqual(doc.version, 0);
  S.watchers[0].fireChange(vscode.Uri.file('/ws/Report [draft] {v2}.pdf'));
  await waitFor(() => doc.version === 1, 'reload of the bracketed name');
});

test('a backup id is read instead of the file; an unreadable backup falls back to the file', async () => {
  const backup = vscode.Uri.file('/backups/x.pdf');
  S.writeFile(backup, pdf('backup'), 1);
  const a = await open('a.pdf', pdf('file'), { backupId: backup.toString() });
  assert.deepStrictEqual(Buffer.from(a.doc.base), Buffer.from(pdf('backup')));
  S.reset();
  const b = await open('a.pdf', pdf('file'), { backupId: 'file:///backups/gone.pdf' });
  assert.deepStrictEqual(Buffer.from(b.doc.base), Buffer.from(pdf('file')));
});

// ---------------------------------------------------------------------------------------------
// Facts, links, open externally

test('pdfFacts -> notices (display only); a reload drops them until the webview reports again', async () => {
  const { doc, panel, uri } = await open('a.pdf', pdf());
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: {
    ...FACTS, encrypted: true, hasText: false, hasJavaScript: true, hasXfa: true, attachmentCount: 2,
    signatures: [{ signer: '<img src=x onerror=alert(1)>', reason: '', time: '' }],
  } });
  const n = panel.last('notices').notices;
  assert.deepStrictEqual(n.map((x) => x.code),
    ['pdf-encrypted', 'pdf-signed', 'pdf-xfa', 'pdf-javascript', 'pdf-no-text', 'pdf-attachments']);
  assert.ok(n.every((x) => !x.message.includes('<img')), 'no document-derived text in notices');
  assert.match(n[1].message, /1 digital signature\. Signatures are not verified here\./);
  assert.match(n[5].message, /2 attached files/);
  assert.strictEqual(doc.canEdit, false, 'facts never change a decision');
  // Invalid facts are dropped without a reply.
  const len = panel.sent.length;
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: { ...FACTS, pageCount: -1 } });
  assert.strictEqual(panel.sent.length, len);
  // Plain facts: nothing to say.
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: FACTS });
  assert.deepStrictEqual(panel.last('notices').notices, []);
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: { ...FACTS, hasJavaScript: true } });
  S.writeFile(uri, pdf('2'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().filter((t) => t === 'init').length === 2, 'reload');
  assert.deepStrictEqual(panel.last('init').notices, []);
});

test('defaultZoom setting is emitted as data-default-zoom (actual -> page-actual; junk -> auto)', async () => {
  const zoomOf = async (v) => {
    if (v === undefined) delete S.config['vscodeMdEditor.pdf.defaultZoom']; else S.config['vscodeMdEditor.pdf.defaultZoom'] = v;
    const { panel } = await open('z.pdf', pdf());
    return /data-default-zoom="([^"]*)"/.exec(panel.webview.html)[1];
  };
  assert.strictEqual(await zoomOf(undefined), 'auto');
  assert.strictEqual(await zoomOf('page-width'), 'page-width');
  assert.strictEqual(await zoomOf('page-fit'), 'page-fit');
  assert.strictEqual(await zoomOf('actual'), 'page-actual');
  assert.strictEqual(await zoomOf('"><script>'), 'auto');
  delete S.config['vscodeMdEditor.pdf.defaultZoom'];
});

test('more than 20,000 pages: view-only reason and a notice (webview fact applied by the host)', async () => {
  const { doc, panel } = await open('many.pdf', pdf());
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: { ...FACTS, pageCount: 20001 } });
  assert.strictEqual(doc.readOnlyReason, 'too-large');
  assert.ok(panel.last('notices').notices.some((n) => n.code === 'pdf-many-pages'));
  await panel.send({ type: 'pdfFacts', generation: doc.generation, facts: { ...FACTS, pageCount: 20000 } });
  assert.ok(!panel.last('notices').notices.some((n) => n.code === 'pdf-many-pages'));
});

test('pdfFacts for another generation is dropped; a reload resets the facts-derived reason and notices', async () => {
  const { doc, panel, uri } = await open('gen.pdf', pdf());
  await panel.send({ type: 'ready' });
  const g1 = doc.generation;
  // Facts without a generation are invalid (answered as such), facts for a future generation are dropped.
  await panel.send({ type: 'pdfFacts', facts: { ...FACTS, hasJavaScript: true } });
  assert.ok(!panel.sent.some((m) => m.type === 'notices' && m.notices.some((n) => n.code === 'pdf-javascript')));
  const len = panel.sent.length;
  await panel.send({ type: 'pdfFacts', generation: g1 + 1, facts: { ...FACTS, pageCount: 20001 } });
  assert.strictEqual(panel.sent.length, len);
  assert.strictEqual(doc.readOnlyReason, null);
  // The current generation's facts apply.
  await panel.send({ type: 'pdfFacts', generation: g1, facts: { ...FACTS, pageCount: 20001 } });
  assert.strictEqual(doc.readOnlyReason, 'too-large');
  assert.ok(panel.last('notices').notices.some((n) => n.code === 'pdf-many-pages'));
  // A reload is a new generation: the reason and the notices from the old facts are gone...
  S.writeFile(uri, pdf('2'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().filter((t) => t === 'init').length === 2, 'reload');
  assert.strictEqual(doc.generation, g1 + 1);
  assert.strictEqual(doc.readOnlyReason, null);
  assert.strictEqual(panel.last('init').readOnlyReason, null);
  assert.deepStrictEqual(panel.last('init').notices, []);
  // ...and late facts about the old generation cannot bring them back.
  const len2 = panel.sent.length;
  await panel.send({ type: 'pdfFacts', generation: g1, facts: { ...FACTS, pageCount: 20001, hasJavaScript: true } });
  assert.strictEqual(panel.sent.length, len2);
  assert.strictEqual(doc.readOnlyReason, null);
});

test('sameAttachmentTarget: case-insensitive for file: on Windows and macOS, exact elsewhere', () => {
  const a = vscode.Uri.file('/ws/Report.PDF');
  const b = vscode.Uri.file('/ws/report.pdf');
  assert.strictEqual(host.sameAttachmentTarget(a, b, 'win32'), true);
  assert.strictEqual(host.sameAttachmentTarget(a, b, 'darwin'), true);
  assert.strictEqual(host.sameAttachmentTarget(a, b, 'linux'), false);
  assert.strictEqual(host.sameAttachmentTarget(b, b, 'linux'), true);
  assert.strictEqual(host.sameAttachmentTarget(a, vscode.Uri.parse('untitled:/ws/Report.PDF'), 'darwin'), false);
});

test('openLink: the shared allow-list (http, https, mailto); javascript:/file: dropped with a notice', async () => {
  const { panel } = await open('a.pdf', pdf());
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'openLink', href: 'https://example.com/x' });
  await panel.send({ type: 'openLink', href: 'mailto:a@example.com' });
  for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'relative/path']) {
    await panel.send({ type: 'openLink', href });
  }
  assert.deepStrictEqual(S.opened, ['https://example.com/x', 'mailto:a@example.com']);
  assert.ok(panel.last('notices').notices.some((x) => x.code === 'link-blocked'));
});

test('openExternally names "a PDF reader" and refuses remote windows and non-file schemes', async () => {
  const { panel } = await open('a.pdf', pdf());
  await panel.send({ type: 'openExternally' });
  assert.deepStrictEqual(S.opened, ['file:///ws/a.pdf']);
  vscode.env.remoteName = 'ssh-remote';
  await panel.send({ type: 'openExternally' });
  assert.strictEqual(S.opened.length, 1);
  assert.match(S.messages.at(-1)[1], /Open in a PDF reader is not available in a remote window/);
  S.reset();
  const g = await open('a.pdf', pdf(), { scheme: 'git' });
  await g.panel.send({ type: 'openExternally' });
  assert.match(S.messages.at(-1)[1], /Open in a PDF reader is only available for files on this computer/);
});

// ---------------------------------------------------------------------------------------------
// Attachments

test('sanitizeAttachmentName: base name only, no reserved characters or device names', () => {
  const s = host.sanitizeAttachmentName;
  const cases = [
    ['report.xlsx', 'report.xlsx'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
    ['dir/sub\\mixed.txt', 'mixed.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['tab\there\u0000.txt', 'tab_here_.txt'],
    ['invoice\u202Etxt.exe', 'invoice_txt.exe'],
    ['trailing dots...', 'trailing dots'],
    ['  spaced  ', 'spaced'],
    ['.hidden', 'hidden'],
    ['..', 'attachment'],
    ['', 'attachment'],
    ['/', 'attachment'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1.log', '_COM1.log'],
    ['console.txt', 'console.txt'],
  ];
  for (const [input, want] of cases) assert.strictEqual(s(input), want, JSON.stringify(input));
  const long = s('x'.repeat(300) + '.pdf');
  assert.strictEqual(long.length, 200);
  assert.ok(long.endsWith('.pdf'));
});

test('pdfSaveAttachment: Save dialog in the document folder with the sanitised name; writes only there', async () => {
  const { panel } = await open('a.pdf', pdf());
  await panel.send({ type: 'ready' });
  const bytes = Uint8Array.of(1, 2, 3);
  // Cancelled dialog: nothing written, ok false.
  await panel.send({ type: 'pdfSaveAttachment', requestId: 1, name: '../secret/data.csv', bytes });
  await waitFor(() => panel.last('pdfSaveAttachmentResult'), 'cancel reply');
  assert.deepStrictEqual(panel.last('pdfSaveAttachmentResult'), { type: 'pdfSaveAttachmentResult', requestId: 1, ok: false });
  assert.strictEqual(S.saveDialogs[0].defaultUri.toString(), 'file:///ws/data.csv');
  assert.deepStrictEqual(S.writes, []);
  // Chosen target: written, ok true.
  S.saveDialogResult = vscode.Uri.file('/out/data.csv');
  await panel.send({ type: 'pdfSaveAttachment', requestId: 2, name: 'data.csv', bytes });
  await waitFor(() => panel.last('pdfSaveAttachmentResult').requestId === 2, 'save reply');
  assert.strictEqual(panel.last('pdfSaveAttachmentResult').ok, true);
  assert.deepStrictEqual(S.writes, ['file:///out/data.csv']);
  assert.deepStrictEqual([...S.files.get('file:///out/data.csv').data], [1, 2, 3]);
});

test('pdfSaveAttachment never overwrites the PDF itself, and reports write errors', async () => {
  const { panel } = await open('a.pdf', pdf());
  S.saveDialogResult = vscode.Uri.file('/ws/a.pdf');
  await panel.send({ type: 'pdfSaveAttachment', requestId: 3, name: 'a.pdf', bytes: Uint8Array.of(9) });
  await waitFor(() => panel.last('pdfSaveAttachmentResult'), 'refusal');
  assert.strictEqual(panel.last('pdfSaveAttachmentResult').ok, false);
  assert.deepStrictEqual(S.writes, []);
  assert.match(S.messages.at(-1)[1], /can't be saved over the PDF/);
  assert.deepStrictEqual(Buffer.from(S.files.get('file:///ws/a.pdf').data), Buffer.from(pdf()));
  S.saveDialogResult = vscode.Uri.file('/ro/x.bin');
  S.failWrites = true;
  await panel.send({ type: 'pdfSaveAttachment', requestId: 4, name: 'x.bin', bytes: Uint8Array.of(9) });
  await waitFor(() => panel.last('pdfSaveAttachmentResult').requestId === 4, 'error reply');
  assert.strictEqual(panel.last('pdfSaveAttachmentResult').ok, false);
  assert.match(S.messages.at(-1)[1], /Couldn't save the attachment/);
  // A malformed request (bytes not a Uint8Array) is answered as invalid, no dialog.
  const dialogs = S.saveDialogs.length;
  await panel.send({ type: 'pdfSaveAttachment', requestId: 5, name: 'x', bytes: [1, 2] });
  assert.strictEqual(panel.last('requestFailed').requestId, 5);
  assert.strictEqual(S.saveDialogs.length, dialogs);
});

test('git: document: the Save dialog has no folder (or the workspace folder), not a git: URI', async () => {
  const { panel } = await open('a.pdf', pdf(), { scheme: 'git' });
  await panel.send({ type: 'pdfSaveAttachment', requestId: 1, name: 'x.txt', bytes: Uint8Array.of(1) });
  await waitFor(() => panel.last('pdfSaveAttachmentResult'), 'reply');
  assert.strictEqual(S.saveDialogs[0].defaultUri, undefined);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/proj') }];
  await panel.send({ type: 'pdfSaveAttachment', requestId: 2, name: 'x.txt', bytes: Uint8Array.of(1) });
  await waitFor(() => panel.last('pdfSaveAttachmentResult').requestId === 2, 'reply 2');
  assert.strictEqual(S.saveDialogs[1].defaultUri.toString(), 'file:///proj/x.txt');
});

// ---------------------------------------------------------------------------------------------
// Load-error text

test('load-error table: every failure code has a title and Open externally; sizes round up', () => {
  assert.deepStrictEqual([...host.PDF_LOAD_FAILURES], ['empty', 'not-pdf', 'too-large']);
  for (const f of host.PDF_LOAD_FAILURES) {
    const v = host.describePdfLoadFailure(f, 600 * MB, 'd');
    assert.ok(v.title.length > 0 && v.actions.includes('openExternally'), f);
    assert.strictEqual(v.detail, 'd');
  }
  assert.strictEqual(host.describePdfLoadFailure('too-large', 500 * MB + 1, '').title, 'This file is too large to open here (501 MB).');
  assert.strictEqual(host.formatMegabytes(600 * MB), '600 MB');
  const u = host.describePdfUnexpectedError(new TypeError('boom'));
  assert.deepStrictEqual(u, { title: "This file is damaged and can't be displayed.", detail: 'TypeError: boom', actions: ['openExternally', 'retry'] });
  assert.strictEqual(host.PDF_VIEWER_TEXT.engineTooOld, 'The PDF viewer needs a newer version of VS Code.');
  assert.ok(Object.isFrozen(host.PDF_VIEWER_TEXT));
});

// ---------------------------------------------------------------------------------------------
// pdfLog (spec §5, §12; amendment 2026-11-21)

test('pdfLog: appended to one lazily created output channel, never a toast, disposed with the extension', async () => {
  const c = { ...ctx, subscriptions: [] };
  const uri = vscode.Uri.file('/ws/log.pdf');
  S.writeFile(uri, pdf(), 1000);
  const provider = new host.PdfEditorProvider(c);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  assert.strictEqual(S.channels.length, 0, 'nothing is created until a line arrives');
  panel.send({ type: 'pdfLog', level: 'warn', code: 'csp-violation', detail: 'img-src https://h.example/a.png?x=1' });
  panel.send({ type: 'pdfLog', level: 'warn', code: 'worker-fallback' });
  panel.send({ type: 'pdfLog', level: 'bogus', code: 'worker-fallback' });   // invalid: not logged
  await tick();
  assert.strictEqual(S.channels.length, 1);
  assert.strictEqual(S.channels[0].name, 'VS Code MD Editor');
  assert.deepStrictEqual(S.channels[0].lines, [
    '[PdfViewer] [warn] csp-violation (log.pdf): img-src https://h.example/a.png',
    '[PdfViewer] [warn] worker-fallback (log.pdf)',
  ]);
  assert.deepStrictEqual(S.messages, [], 'no toast');
  assert.ok(c.subscriptions.includes(S.channels[0]));
});

test('pdfLog: at most 50 lines per document load, a later reload would start afresh', async () => {
  const { panel } = await open('flood.pdf', pdf());
  for (let i = 0; i < 80; i++) panel.send({ type: 'pdfLog', level: 'error', code: 'page-render-failed', detail: 'page ' + i });
  await tick();
  const lines = S.channels[0].lines;
  assert.strictEqual(lines.length, host.PDF_LOG_LINE_LIMIT + 1, '50 lines plus one "dropped" note');
  assert.match(lines[lines.length - 1], /dropped/);
  assert.strictEqual(lines.filter((l) => l.includes('page 49')).length, 1);
  assert.strictEqual(lines.filter((l) => l.includes('page 50')).length, 0);
});
