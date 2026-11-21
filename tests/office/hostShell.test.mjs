// WP-08: the Office host shell (OfficeDocument, OfficeEditorProviderBase, DocxEditorProvider) driven
// end to end against an in-memory `vscode` stub. The host files import 'vscode', so they are bundled
// here with esbuild and 'vscode' resolved to tests/office/_vscodeStub.cjs. Spec §4.1, §5, §6.1–6.2,
// §10.3, §12. What this cannot show (real webview, real file watcher, openExternal launching Word) is
// on the Gate R1 checklist.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { core, fixture, allFixtures } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/docxEditorProvider.ts';",
        "export * from './src/office/officeEditorProviderBase.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{
      name: 'vscode-stub',
      setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); },
    }, {
      // Test-only: the flags module with a mutable object, so these viewer tests run with every flag
      // off (1.6 ships with editing on; the flag-on paths are in docxEditWiring / xlsxEditWiring).
      name: 'mutable-flags',
      setup(b) {
        b.onLoad({ filter: /featureFlags\.ts$/ }, (args) => {
          const src = fs.readFileSync(args.path, 'utf8');
          assert.ok(src.includes('Object.freeze('), 'featureFlags.ts freezes OFFICE_FLAGS');
          return { contents: src.replace('Object.freeze(', '('), loader: 'ts' };
        });
      },
    }],
  });
  host = require(outfile);
  host.OfficeDocument.diskCheckDelayMs = 0;
});

/** The viewer tests below describe the flag-off (view-only) behaviour. */
const FLAGS_OFF = Object.freeze({ xlsxEdit: false, docxEdit: false, xlsxStructure: false });
beforeEach(() => { S.reset(); Object.assign(host.OFFICE_FLAGS, FLAGS_OFF); });

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

async function open(name, bytes, { scheme = 'file', dir = '/ws' } = {}) {
  const uri = scheme === 'file' ? vscode.Uri.file(`${dir}/${name}`) : new vscode.Uri(scheme, `${dir}/${name}`, 'ref=HEAD');
  if (bytes) S.writeFile(uri, bytes, 1000);
  const provider = new host.DocxEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
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

/** Replace (or add) parts of a package, keeping every other entry byte-identical. */
function patchZip(bytes, changes) {
  const zip = core.zip.readZip(bytes, core.pkg.zipLimits());
  const items = [];
  const left = new Map(Object.entries(changes));
  for (const e of zip.entries) {
    if (left.has(e.name)) { items.push({ replace: e, data: left.get(e.name) }); left.delete(e.name); }
    else items.push({ keep: e });
  }
  for (const [name, data] of left) items.push({ add: name, data });
  return core.zip.writeZip(zip, items);
}

const enc = (s) => new TextEncoder().encode(s);
function partText(bytes, name) {
  const p = core.pkg.OfficePackage.open('x.docx', bytes);
  return p.text(name);
}
/** Insert a DOCTYPE after the XML declaration of a part. */
function withDoctype(bytes, part, decl = '<!DOCTYPE x [<!ENTITY a "b">]>') {
  const t = partText(bytes, part);
  const i = t.startsWith('<?xml') ? t.indexOf('?>') + 2 : 0;
  return patchZip(bytes, { [part]: enc(t.slice(0, i) + decl + t.slice(i)) });
}

// ---------------------------------------------------------------------------------------------

test('registration: viewType, retainContextWhenHidden, find widget, one editor per document', () => {
  host.DocxEditorProvider.register(ctx);
  assert.strictEqual(S.registered.length, 1);
  const r = S.registered[0];
  assert.strictEqual(r.viewType, 'vscodeMdEditor.docx');
  assert.deepStrictEqual(r.options, {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
    supportsMultipleEditorsPerDocument: false,
  });
});

test('HTML: §12 CSP, nonce on every script, ?v= on every asset, media/ is the only resource root', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  const html = panel.webview.html;
  assert.deepStrictEqual(panel.webview.options.localResourceRoots.map((u) => u.path), ['/ext/media']);
  assert.strictEqual(panel.webview.options.enableScripts, true);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
  assert.ok(nonce.length >= 32);
  assert.strictEqual(csp, `default-src 'none'; style-src https://csp.example 'unsafe-inline'; script-src 'nonce-${nonce}'; `
    + `img-src https://csp.example blob: data:; font-src https://csp.example blob: data:;`);
  assert.ok(!/connect-src|frame-src/.test(csp));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts.map((a) => /src="https:\/\/webview\/ext\/media\/([^?"]+)\?v=\d+"/.exec(a)?.[1]),
    ['jszip.min.js', 'docx-preview.min.js', 'officeCommon.js', 'docxMap.js', 'docxIsland.js', 'docxEdit.js', 'docxEditor.js']);
  for (const a of scripts) assert.ok(a.includes(`nonce="${nonce}"`), a);
  const links = [...html.matchAll(/<link href="([^"]+)" rel="stylesheet">/g)].map((m) => m[1]);
  assert.strictEqual(links.length, 2);
  for (const l of links) assert.match(l, /^https:\/\/webview\/ext\/media\/[\w.-]+\.css\?v=\d+$/);
  // xlsx variant omits blob:/data: (helper shared with WP-14).
  assert.strictEqual(host.officeCsp('S', 'N', false),
    "default-src 'none'; style-src S 'unsafe-inline'; script-src 'nonce-N'; img-src S; font-src S;");
});

test('ready on basic.docx: init (read-only, flags off) then docxRender with the original bytes', async () => {
  const bytes = fixture('basic.docx');
  const { doc, panel } = await open('basic.docx', bytes);
  await panel.send({ type: 'ready' });
  assert.deepStrictEqual(panel.types(), ['init', 'docxRender']);
  assert.deepStrictEqual(panel.sent[0], {
    type: 'init', kind: 'docx', fileName: 'basic.docx', version: 0,
    canEdit: false, readOnlyReason: null, editMode: false, notices: [],
  });
  const r = panel.sent[1];
  assert.strictEqual(r.version, 0);
  assert.deepStrictEqual(r.blocks, []);
  assert.ok(r.bytes instanceof Uint8Array);
  assert.deepStrictEqual(Buffer.from(r.bytes), Buffer.from(bytes));
  assert.strictEqual(doc.generation, 1);
  assert.deepStrictEqual(doc.diskStamp, { mtime: 1000, size: bytes.length });
  // docxRequestRender re-sends it.
  await panel.send({ type: 'docxRequestRender' });
  assert.deepStrictEqual(panel.types(), ['init', 'docxRender', 'docxRender']);
});

test('error fixtures open in the error view with Open in Word, never throw, never render', async () => {
  const cases = [
    ['encrypted.docx', fixture('encrypted.docx'), 'This file is password-protected. Open it in Word to view it.'],
    ['legacy-renamed.docx', fixture('legacy-renamed.docx'), 'This looks like an older .doc file saved with a .docx name.'],
    ['truncated.docx', fixture('truncated.docx'), "This file is damaged and can't be displayed."],
    ['empty.docx', new Uint8Array(0), 'This file is empty.'],
    ['~$basic.docx', fixture('basic.docx'), 'This is a temporary lock file created by Word, not a document.'],
    ['book.docx', fixture('basic.xlsx'), "This file uses a packaging feature this viewer doesn't support."],
  ];
  for (const [name, bytes, title] of cases) {
    S.reset();
    const { doc, panel } = await open(name, bytes);
    assert.strictEqual(doc.pkg, null, name);
    await panel.send({ type: 'ready' });
    assert.deepStrictEqual(panel.types(), ['loadError'], name);
    const m = panel.sent[0];
    assert.strictEqual(m.title, title, name);
    assert.ok(m.actions.includes('openExternally'), name);
    assert.strictEqual(typeof m.detail, 'string');
    await panel.send({ type: 'docxRequestRender' });
    assert.ok(!panel.types().includes('docxRender'), name);
  }
});

test('a file that cannot be read is an error view with Retry, not a thrown error', async () => {
  const { doc, panel } = await open('missing.docx', undefined);
  assert.strictEqual(doc.pkg, null);
  await panel.send({ type: 'ready' });
  assert.strictEqual(panel.sent[0].type, 'loadError');
  assert.strictEqual(panel.sent[0].title, "This file couldn't be read.");
  assert.deepStrictEqual(panel.sent[0].actions, ['openExternally', 'retry']);
});

test('the git: side of a diff is read-only (non-writable-scheme) and not watched', async () => {
  const { doc, panel } = await open('basic.docx', fixture('basic.docx'), { scheme: 'git' });
  assert.ok(doc.pkg);
  assert.strictEqual(doc.readOnlyReason, 'non-writable-scheme');
  assert.strictEqual(S.watchers.length, 0);
  await panel.send({ type: 'ready' });
  assert.strictEqual(panel.sent[0].canEdit, false);
  assert.strictEqual(panel.sent[0].readOnlyReason, 'non-writable-scheme');
  // Open in Word is only for local files.
  await panel.send({ type: 'openExternally' });
  assert.deepStrictEqual(S.opened, []);
  assert.strictEqual(S.messages.length, 1);
});

test('setEditMode is refused while the docx edit flag is off', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
});

test('openLink: http, https, mailto open; every other scheme is ignored with a notice (§12)', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  for (const href of ['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com', 'HTTPS://EXAMPLE.COM/x']) {
    await panel.send({ type: 'openLink', href });
  }
  assert.strictEqual(S.opened.length, 4);
  assert.match(S.opened[0], /^https:\/\/example\.com\/a\?b=1$/);
  assert.match(S.opened[2], /^mailto:someone@example\.com$/);
  assert.ok(!panel.types().includes('notices'));
  const blocked = ['javascript:alert(1)', ' javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'vscode://x/y',
    'command:workbench.action.terminal.new', 'data:text/html,<b>x</b>', '#bookmark', 'relative/path', '\\\\server\\share', ''];
  for (const href of blocked) {
    const before = panel.sent.length;
    await panel.send({ type: 'openLink', href });
    const n = panel.sent.slice(before);
    assert.strictEqual(n.length, 1, href);
    assert.strictEqual(n[0].type, 'notices', href);
    assert.ok(n[0].notices.some((x) => x.code === 'link-blocked'), href);
  }
  assert.strictEqual(S.opened.length, 4, 'nothing else was opened');
  // Over-long href fails validation and is dropped silently (no requestId to answer).
  const before = panel.sent.length;
  await panel.send({ type: 'openLink', href: 'https://x/' + 'a'.repeat(40000) });
  assert.strictEqual(panel.sent.length, before);
  assert.strictEqual(S.opened.length, 4);
});

test('openExternally, writeClipboard, showAbout', async () => {
  const { panel, uri } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'openExternally' });
  assert.deepStrictEqual(S.opened, [uri.toString()]);
  await panel.send({ type: 'writeClipboard', text: 'copied text' });
  assert.strictEqual(S.clipboard, 'copied text');
  await panel.send({ type: 'showAbout' });
  assert.ok(S.messages.some((m) => m[0] === 'info' && m[2]?.modal === true));
});

test('invalid and not-yet-available requests get exactly one reply', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  const n0 = panel.sent.length;
  await panel.send({ type: 'docxRequestBlockModel', requestId: 7, blockId: -1 });
  assert.deepStrictEqual(panel.sent.slice(n0), [{ type: 'requestFailed', requestId: 7, error: { code: 'invalid', message: 'The request was not understood.' } }]);
  await panel.send({ type: 'docxRequestBlockModel', requestId: 8, blockId: 1 });
  assert.deepStrictEqual(panel.last('requestFailed'), { type: 'requestFailed', requestId: 8, error: { code: 'read-only', message: 'This document is open read-only.' } });
  await panel.send({ type: 'docxEdit', requestId: 9, baseVersion: 0, edit: { op: 'removeParagraph', blockId: 1 } });
  const er = panel.last('docxEditResult');
  assert.deepStrictEqual(er, { type: 'docxEditResult', requestId: 9, ok: false, error: { code: 'read-only', message: 'This document is open read-only.' } });
  const n1 = panel.sent.length;
  for (const raw of [null, 42, 'ready', { type: 'nope' }, { type: 'xlsxRequestCells', requestId: 'x' }, { type: '__proto__' }]) {
    await panel.send(raw);
  }
  assert.strictEqual(panel.sent.length, n1, 'messages without a usable requestId are dropped');
});

test('Retry reloads: an empty file that is then written opens normally', async () => {
  const { doc, panel, uri } = await open('later.docx', new Uint8Array(0));
  await panel.send({ type: 'ready' });
  assert.deepStrictEqual(panel.types(), ['loadError']);
  S.writeFile(uri, fixture('basic.docx'), 2000);
  await panel.send({ type: 'retry' });
  assert.deepStrictEqual(panel.types(), ['loadError', 'init', 'docxRender']);
  assert.strictEqual(panel.sent[1].version, 1);
  assert.strictEqual(panel.sent[2].version, 1);
  assert.strictEqual(doc.generation, 2);
});

test('changed on disk while clean: reloads, bumps version and generation, posts init + docxStateChanged', async () => {
  const { doc, panel, uri } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  assert.strictEqual(S.watchers.length, 1);
  assert.strictEqual(S.watchers[0].pattern.pattern, 'basic.docx');
  assert.strictEqual(S.watchers[0].pattern.base.path, '/ws');
  // A watcher event with an unchanged stamp is ignored.
  S.watchers[0].fireChange();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(panel.types(), ['init', 'docxRender']);
  S.writeFile(uri, fixture('rich.docx'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().includes('docxStateChanged'), 'docxStateChanged');
  assert.deepStrictEqual(panel.types(), ['init', 'docxRender', 'init', 'docxStateChanged']);
  assert.strictEqual(panel.sent[2].version, 1);
  assert.deepStrictEqual(panel.sent[3], { type: 'docxStateChanged', version: 1 });
  assert.strictEqual(doc.generation, 2);
  await panel.send({ type: 'docxRequestRender' });
  assert.deepStrictEqual(Buffer.from(panel.last('docxRender').bytes), Buffer.from(fixture('rich.docx')));
  // Becoming damaged on disk switches to the error view.
  S.writeFile(uri, fixture('truncated.docx'), 6000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().includes('loadError'), 'loadError');
  // ...and recovering sends init plus a first render.
  S.writeFile(uri, fixture('basic.docx'), 7000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().lastIndexOf('init') > panel.types().indexOf('loadError'), 'init after recovery');
  await waitFor(() => panel.types().at(-1) === 'docxRender', 'render after recovery');
  doc.dispose();
  assert.ok(S.watchers[0].disposed);
});

test('a file over the size limit is refused from its stat, without being read', async () => {
  const uri = vscode.Uri.file('/ws/huge.docx');
  // Only stat sees this "file": a fake whose length is over the limit.
  S.files.set(uri.toString(), { data: { length: core.limits.LIMITS.maxFileBytes + 1 }, mtime: 1000 });
  const provider = new host.DocxEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  assert.strictEqual(doc.pkg, null);
  assert.match(doc.loadError.title, /too large/);
  assert.deepStrictEqual(S.reads, [], 'the bytes were never read');
});

test('the disk stamp is taken before the read: a write landing during the read still triggers a reload', async () => {
  const uri = vscode.Uri.file('/ws/basic.docx');
  S.writeFile(uri, fixture('basic.docx'), 1000);
  const realRead = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async (u) => {
    const data = await realRead(u);
    S.writeFile(uri, fixture('rich.docx'), 2000);   // a writer finishes right after our read
    vscode.workspace.fs.readFile = realRead;
    return data;
  };
  try {
    const provider = new host.DocxEditorProvider(ctx);
    const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
    assert.deepStrictEqual(doc.diskStamp, { mtime: 1000, size: fixture('basic.docx').length });
    S.watchers[0].fireChange();
    await waitFor(() => doc.version === 1, 'reload after the racing write');
  } finally {
    vscode.workspace.fs.readFile = realRead;
  }
});

test('a name with glob characters is watched through its directory and filtered by URI', async () => {
  const { doc, panel, uri } = await open('Budget [2024].docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  assert.strictEqual(S.watchers.length, 1);
  assert.strictEqual(S.watchers[0].pattern.pattern, '*');
  // Another file in the directory changing does nothing.
  S.writeFile(uri, fixture('rich.docx'), 5000);
  S.watchers[0].fireChange(vscode.Uri.file('/ws/other.docx'));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(doc.version, 0);
  // The file itself changing reloads it.
  S.watchers[0].fireChange(vscode.Uri.file('/ws/Budget [2024].docx'));
  await waitFor(() => doc.version === 1, 'reload of the bracketed name');
});

test('the link-blocked warning is cleared when the next link opens', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'openLink', href: 'javascript:alert(1)' });
  assert.ok(panel.last('notices').notices.some((n) => n.code === 'link-blocked'));
  await panel.send({ type: 'openLink', href: 'https://example.com/' });
  assert.deepStrictEqual(panel.last('notices').notices, []);
  // A further allowed link posts nothing more (nothing to clear).
  const n = panel.sent.length;
  await panel.send({ type: 'openLink', href: 'https://example.com/b' });
  assert.strictEqual(panel.sent.length, n);
});

test('Open in Word in a remote window explains instead of opening a remote path locally', async () => {
  const { panel } = await open('basic.docx', fixture('basic.docx'));
  vscode.env.remoteName = 'ssh-remote';
  await panel.send({ type: 'openExternally' });
  assert.deepStrictEqual(S.opened, []);
  assert.ok(S.messages.some((m) => m[0] === 'info' && /remote window/.test(m[1])));
});

test('changed on disk while dirty: warning notice, state left alone', async () => {
  const { doc, panel, uri } = await open('basic.docx', fixture('basic.docx'));
  await panel.send({ type: 'ready' });
  doc.isDirty = () => true;
  const pkg = doc.pkg;
  S.writeFile(uri, fixture('rich.docx'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().includes('notices'), 'notices');
  const n = panel.last('notices').notices;
  assert.deepStrictEqual(n.map((x) => [x.code, x.severity]), [['changed-on-disk', 'warning']]);
  assert.strictEqual(doc.pkg, pkg);
  assert.strictEqual(doc.version, 0);
  // A second change does not add a second notice.
  S.writeFile(uri, fixture('basic.docx'), 6000);
  S.watchers[0].fireChange();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(panel.sent.filter((m) => m.type === 'notices').length, 1);
});

test('a sibling ~$ lock file adds the "open in Word" warning (Word and Excel naming)', async () => {
  for (const lock of ['~$basic.docx', '~$asic.docx', '~$sic.docx']) {
    S.reset();
    S.writeFile(vscode.Uri.file('/ws/' + lock), new Uint8Array(162));
    const { panel } = await open('basic.docx', fixture('basic.docx'));
    await panel.send({ type: 'ready' });
    const notices = panel.sent[0].notices;
    assert.deepStrictEqual(notices, [{
      severity: 'warning', code: 'open-in-office',
      message: 'This file appears to be open in Word. Saving here may fail or conflict.',
    }], lock);
    assert.strictEqual(panel.sent[1].type, 'docxRender', 'still opens normally');
  }
  assert.deepStrictEqual(host.siblingLockNames('~$x.docx'), []);
});

// ---------------------------------------------------------------------------------------------
// Pre-render DOCTYPE guard (spec §12 addition after Gate R0)

test('DOCTYPE guard: refuses to render with damaged and names the part', async () => {
  const base = fixture('basic.docx');
  const parts = core.pkg.OfficePackage.open('basic.docx', base).partNames();
  const rels = parts.find((p) => p.toLowerCase() === 'word/_rels/document.xml.rels');
  const styles = parts.find((p) => p.toLowerCase() === 'word/styles.xml');
  assert.ok(rels && styles, 'fixture has document rels and styles');
  const utf16 = (s) => { const b = Buffer.from('\uFEFF' + s, 'utf16le'); return new Uint8Array(b); };
  const cases = [
    ['styles.xml, upper case', withDoctype(base, styles), styles],
    ['document rels, lower case', withDoctype(base, rels, '<!doctype Relationships>'), rels],
    ['mixed case', withDoctype(base, styles, '<!DocType x>'), styles],
    ['UTF-16 part', patchZip(base, { [styles]: utf16('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x><w:styles/>') }), styles],
    ['customXml part with application/xml default', patchZip(base, { 'customXml/item9.xml': enc('<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><r>&e;</r>') }), 'customXml/item9.xml'],
    ['wrong declared encoding (lenient decode)', patchZip(base, { [styles]: enc('<?xml version="1.0" encoding="ISO-8859-1"?><!DOCTYPE x><a/>') }), styles],
  ];
  for (const [what, bytes, part] of cases) {
    S.reset();
    const { doc, panel } = await open('basic.docx', bytes);
    assert.strictEqual(doc.pkg, null, what);
    await panel.send({ type: 'ready' });
    assert.deepStrictEqual(panel.types(), ['loadError'], what);
    assert.strictEqual(panel.sent[0].title, "This file is damaged and can't be displayed.", what);
    assert.ok(panel.sent[0].detail.includes(`"${part}"`), `${what}: ${panel.sent[0].detail}`);
    assert.match(panel.sent[0].detail, /DOCTYPE/, what);
  }
});

test('DOCTYPE guard: a non-XML part containing the text is not refused; no fixture is refused', async () => {
  const base = fixture('basic.docx');
  const withBin = patchZip(base, { 'word/media/blob.bin': enc('<!DOCTYPE x>') });
  const p = core.pkg.OfficePackage.open('basic.docx', withBin);
  assert.strictEqual(await host.findDoctypePart(p), null);
  for (const name of allFixtures('docx')) {
    let pkg;
    try { pkg = core.pkg.OfficePackage.open(name, fixture(name)); } catch { continue; }
    assert.strictEqual(await host.findDoctypePart(pkg), null, name);
  }
});

test('DOCTYPE guard helpers', () => {
  assert.ok(host.bytesContainDoctype(enc('<?xml version="1.0"?>\n<!doctype a><a/>')));
  assert.ok(!host.bytesContainDoctype(enc('<a>DOCTYPE &lt;!DOCTYPE</a>')));
  assert.ok(host.bytesContainDoctype(new Uint8Array(Buffer.from('<!DOCTYPE a>', 'utf16le'))));
});

test('allowedExternalLink', () => {
  assert.strictEqual(host.allowedExternalLink('https://a.example/').protocol, 'https:');
  assert.strictEqual(host.allowedExternalLink('MAILTO:x@y').protocol, 'mailto:');
  for (const bad of ['javascript:x', 'file:///x', 'ftp://x', '//x.example/', 'x', 'vbscript:x', 'blob:https://x/1']) {
    assert.strictEqual(host.allowedExternalLink(bad), null, bad);
  }
});
