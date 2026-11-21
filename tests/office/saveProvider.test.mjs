// WP-19: the full CustomEditorProvider (save, save as, revert, backup/hot exit, undo/redo through
// VS Code's stack, Edit mode) driven against the in-memory `vscode` stub, like hostShell.test.mjs.
// Spec §6.1–6.5, §10.3, §13.2 (G0, G3, G5). The edit flags stay false in featureFlags.ts; this file
// bundles the host with a copy of featureFlags.ts whose object is not frozen, so each test can
// switch a flag on for itself. What needs a real Extension Development Host (VS Code's own undo
// stack and dirty dot, hot exit across a window kill, the real modal) is on the Gate R2 checklist.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import esbuild from 'esbuild';
import { core, fixture, entryTable } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-save.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/docxEditorProvider.ts';",
        "export * from './src/office/xlsxEditorProvider.ts';",
        "export * from './src/office/officeEditorProviderBase.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
        "export * as saveErrors from './src/office/saveErrors.ts';",
        "export * as hcore from './src/office/core/index.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-save-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-stub',
        setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); },
      },
      {
        // Test-only: the same flags module with a mutable object (the shipped one is frozen and false).
        name: 'mutable-flags',
        setup(b) {
          b.onLoad({ filter: /featureFlags\.ts$/ }, (args) => {
            const src = fs.readFileSync(args.path, 'utf8');
            assert.ok(src.includes('Object.freeze('), 'featureFlags.ts freezes OFFICE_FLAGS');
            return { contents: src.replace('Object.freeze(', '('), loader: 'ts' };
          });
        },
      },
    ],
  });
  host = require(outfile);
  host.OfficeDocument.diskCheckDelayMs = 0;
});

/** The shipped flag values, to prove they are all off and restore them after every test. */
let shipped;
beforeEach(() => {
  S.reset();
  shipped ??= { ...host.OFFICE_FLAGS };
  Object.assign(host.OFFICE_FLAGS, shipped);
  host.OfficeDocument.saveHooks = undefined;
  host.OfficeDocument.flushTimeoutMs = 1500;
  host.OfficeDocument.backupDelayMs = 0;
});
afterEach(() => { Object.assign(host.OFFICE_FLAGS, shipped); host.OfficeDocument.saveHooks = undefined; });

const ctx = {
  extensionUri: vscode.Uri.file('/ext'),
  extension: { packageJSON: { name: 'x', displayName: 'X', version: '0.0.0', description: '' } },
  subscriptions: [],
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

/** A fake panel. Like the real webviews in View mode, it answers flushPendingEdits at once unless `autoFlush` is off. */
function makePanel() {
  const sent = [];
  let onMsg = () => {};
  const panel = {
    sent,
    autoFlush: true,
    webview: {
      options: {}, html: '', cspSource: 'https://csp.example',
      asWebviewUri: (u) => ({ toString: () => 'https://webview' + u.path }),
      postMessage: async (m) => {
        sent.push(m);
        if (m.type === 'flushPendingEdits' && panel.autoFlush) setTimeout(() => onMsg({ type: 'flushed', flushId: m.flushId }), 0);
        return true;
      },
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
    send: (raw) => onMsg(raw),
    types: () => sent.map((m) => m.type),
    last: (type) => [...sent].reverse().find((m) => m.type === type),
  };
  return panel;
}

/** VS Code's own test (extHostCustomEditors): a provider is editable iff this property is truthy. */
const isEditable = (provider) => !!provider.onDidChangeCustomDocument;

/**
 * Open a document the way VS Code does: openCustomDocument, subscribe to the edit event (only when
 * editable), resolveCustomEditor, `ready`. Returns the VS Code-side undo stack model too.
 */
async function open(name, bytes, opts = {}) {
  const { Provider = host.DocxEditorProvider, backupId, editMode = true, scheme = 'file' } = opts;
  const uri = scheme === 'file' ? vscode.Uri.file(`/ws/${name}`) : new vscode.Uri(scheme, `/ws/${name}`, 'ref=HEAD');
  if (bytes) S.writeFile(uri, bytes, 1000);
  const provider = new Provider(ctx);
  const events = [];
  if (isEditable(provider)) provider.onDidChangeCustomDocument((e) => events.push(e));
  const doc = await provider.openCustomDocument(uri, { backupId, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  await panel.send({ type: 'ready' });
  if (editMode && doc.canEdit) await panel.send({ type: 'setEditMode', editMode: true });
  // WP-33: with the edit flag on the first docxRender is built asynchronously; let it land so it does
  // not interleave with what a test asserts about later traffic.
  for (let i = 0; i < 200 && provider.kind === 'docx' && doc.pkg && !doc.loadError && !panel.types().includes('docxRender'); i++) await tick(5);
  return { provider, doc, panel, uri, events };
}

function mainPart(doc) { return host.hcore.opc.mainPart(doc.pkg).name; }

/** One small edit: an attribute on the main part's root element (G4-local, every validator happy). */
function tag(doc, value = '1', label = 'Edit Paragraph') {
  return doc.edit(label, (b) => {
    const part = mainPart(doc);
    b.setAttr(part, doc.pkg.xml(part).root, '', 'vsmdTest', value);
  });
}

function rootTag(bytes, kind = 'docx') {
  const p = core.pkg.OfficePackage.open(kind === 'docx' ? 'x.docx' : 'x.xlsx', bytes);
  const t = p.text(core.opc.mainPart(p).name);
  const i = t.indexOf('<', t.startsWith('<?xml') ? t.indexOf('?>') : 0);
  return t.slice(i, t.indexOf('>', i) + 1);
}

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick(5);
  }
  assert.fail('timed out waiting for ' + what);
}
const isCancel = (e) => e instanceof vscode.CancellationError;

/** Names of the entries whose compressed bytes or central record differ between two ZIPs. */
function changedEntries(a, b) {
  const ta = entryTable(a);
  const tb = entryTable(b);
  const out = [];
  for (const [n, ea] of ta) {
    const eb = tb.get(n);
    if (!eb || !same(ea.compressedBytes, eb.compressedBytes) || ea.crc !== eb.crc || !same(ea.cdRecordBytes, eb.cdRecordBytes)) out.push(n);
  }
  for (const n of tb.keys()) if (!ta.has(n)) out.push(n);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Flags off: nothing changes for real users

test('flags off (as shipped): all false, providers register read-only, nothing can be edited', async () => {
  assert.deepStrictEqual(shipped, { xlsxEdit: false, docxEdit: false, xlsxStructure: false });
  host.DocxEditorProvider.register(ctx);
  host.XlsxEditorProvider.register(ctx);
  assert.deepStrictEqual(S.registered.map((r) => [r.viewType, isEditable(r.provider)]),
    [['vscodeMdEditor.docx', false], ['vscodeMdEditor.xlsx', false]]);
  // Registration options are unchanged from Phase 1.
  assert.deepStrictEqual(S.registered[0].options, host.DocxEditorProvider.registrationOptions);
  assert.deepStrictEqual(S.registered[1].options, host.XlsxEditorProvider.registrationOptions);

  S.config['vscodeMdEditor.office.startInEditMode'] = true;
  const { doc, panel, events } = await open('basic.docx', fixture('basic.docx'), { editMode: true });
  assert.strictEqual(doc.canEdit, false);
  assert.strictEqual(panel.sent[0].editMode, false, 'startInEditMode has no effect while the flag is off');
  await panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
  const r = tag(doc);
  assert.deepStrictEqual(r, { ok: false, error: { code: 'read-only', message: host.saveErrors.READ_ONLY_MESSAGE } });
  assert.strictEqual(doc.version, 0);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(doc.isDirty(), false);
  assert.ok(!panel.types().includes('flushPendingEdits'));
});

// ---------------------------------------------------------------------------------------------
// Edit mode (§6.4)

test('flag on: provider is editable; Edit mode is off by default and edits are refused in View mode', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  host.DocxEditorProvider.register(ctx);
  host.XlsxEditorProvider.register(ctx);
  assert.deepStrictEqual(S.registered.map((r) => isEditable(r.provider)), [true, false], 'per kind');
  const { doc, panel, events } = await open('basic.docx', fixture('basic.docx'), { editMode: false });
  assert.strictEqual(panel.sent[0].canEdit, true);
  assert.strictEqual(panel.sent[0].editMode, false);
  assert.deepStrictEqual(tag(doc), { ok: false, error: { code: 'read-only', message: 'Press Edit (Ctrl+E) to make changes.' } });
  await panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(panel.last('editModeChanged'), { type: 'editModeChanged', editMode: true });
  assert.strictEqual(doc.editMode, true);
  assert.strictEqual(tag(doc).ok, true);
  assert.strictEqual(events.length, 1);
  await panel.send({ type: 'setEditMode', editMode: false });
  assert.deepStrictEqual(panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
  assert.strictEqual(tag(doc, '2').ok, false);
  // A re-sent init (retry/reload) carries the document's mode.
  await panel.send({ type: 'setEditMode', editMode: true });
  await panel.send({ type: 'ready' });
  assert.strictEqual(panel.last('init').editMode, true);
});

test('startInEditMode opens editable files in Edit mode, never read-only ones', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  host.OFFICE_FLAGS.xlsxEdit = true;
  S.config['vscodeMdEditor.office.startInEditMode'] = true;
  const a = await open('basic.docx', fixture('basic.docx'), { editMode: false });
  assert.strictEqual(a.panel.sent[0].editMode, true);
  assert.strictEqual(a.doc.editMode, true);
  const x = await open('basic.xlsx', fixture('basic.xlsx'), { editMode: false, Provider: host.XlsxEditorProvider });
  assert.strictEqual(x.panel.sent[0].type, 'init');
  assert.strictEqual(x.panel.sent[0].editMode, true);
  const g = await open('basic.docx', fixture('basic.docx'), { editMode: false, scheme: 'git' });
  assert.strictEqual(g.panel.sent[0].canEdit, false);
  assert.strictEqual(g.panel.sent[0].editMode, false);
  S.config['vscodeMdEditor.office.startInEditMode'] = false;
  const b = await open('basic.docx', fixture('basic.docx'), { editMode: false });
  assert.strictEqual(b.panel.sent[0].editMode, false);
});

// ---------------------------------------------------------------------------------------------
// Edits, dirty tracking, undo/redo (§6.2, §6.3)

test('an edit fires one CustomDocumentEditEvent; undo/redo go through it, bump version, post state; undo to clean is G5', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, panel, events } = await open('basic.docx', bytes);
  assert.strictEqual(doc.isDirty(), false);
  const r = tag(doc);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.edit.label, 'Edit Paragraph');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].document, doc);
  assert.strictEqual(events[0].label, 'Edit Paragraph');
  assert.strictEqual(typeof events[0].undo, 'function');
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.isDirty(), true);
  const edited = doc.pkg.serialize();
  assert.match(rootTag(edited), /vsmdTest="1"/);

  // A no-op edit records nothing and fires nothing.
  const noop = tag(doc);
  assert.deepStrictEqual(noop, { ok: true, edit: null });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(doc.version, 1);

  const n0 = panel.sent.length;
  await events[0].undo();
  assert.strictEqual(doc.version, 2);
  assert.strictEqual(doc.isDirty(), false, 'undo back to the save point is clean');
  assert.ok(same(doc.pkg.serialize(), bytes), 'G5: undo is byte-identical to the original');
  assert.deepStrictEqual(panel.sent.slice(n0), [{ type: 'docxStateChanged', version: 2 }]);
  await events[0].redo();
  assert.strictEqual(doc.version, 3);
  assert.strictEqual(doc.isDirty(), true);
  assert.ok(same(doc.pkg.serialize(), edited), 'redo equals the edit');
  assert.deepStrictEqual(panel.last('docxStateChanged'), { type: 'docxStateChanged', version: 3 });
});

test('applyEdit: prepared edits apply atomically; a stale one is refused and changes nothing', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, events } = await open('basic.docx', fixture('basic.docx'));
  const part = mainPart(doc);
  const before = doc.pkg.serialize();
  const stale = { label: 'Edit Paragraph', changes: [
    { kind: 'attr', part, path: [], ns: '', local: 'vsmdA', before: null, after: 'x' },
    { kind: 'attr', part, path: [], ns: '', local: 'vsmdB', before: 'not-there', after: null },
  ] };
  const r = doc.applyEdit(stale);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assert.ok(same(doc.pkg.serialize(), before));
  assert.strictEqual(events.length, 0);
  const good = { label: 'Edit Cell', changes: [{ kind: 'attr', part, path: [], ns: '', local: 'vsmdA', before: null, after: 'x' }] };
  assert.strictEqual(doc.applyEdit(good).ok, true);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].label, 'Edit Cell');
  // A builder that refuses or throws leaves nothing behind.
  const refused = doc.edit('Edit Cell', (b) => {
    b.setAttr(part, doc.pkg.xml(part).root, '', 'vsmdC', '1');
    return { code: 'blocked', message: 'no' };
  });
  assert.deepStrictEqual(refused, { ok: false, error: { code: 'blocked', message: 'no' } });
  const thrown = doc.edit('Edit Cell', (b) => {
    b.setAttr(part, doc.pkg.xml(part).root, '', 'vsmdC', '1');
    throw new Error('boom');
  });
  assert.deepStrictEqual(thrown, { ok: false, error: { code: 'internal', message: 'boom' } });
  assert.doesNotMatch(doc.pkg.text(part), /vsmdC/);
  assert.strictEqual(events.length, 1);
});

test('undo/redo after revert or external reload refuse with the §6.3 message and change nothing', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, panel, uri, events } = await open('basic.docx', fixture('basic.docx'));
  tag(doc);
  tag(doc, '2');
  assert.strictEqual(events.length, 2);
  await doc.revert(token);
  assert.strictEqual(doc.isDirty(), false);
  assert.strictEqual(doc.generation, 2);
  const after = doc.pkg.serialize();
  const v = doc.version;
  // VS Code keeps the edits up to its save point (here none were saved, so both stay on the stack).
  await events[1].undo();
  assert.ok(same(doc.pkg.serialize(), after));
  assert.strictEqual(doc.version, v);
  assert.deepStrictEqual(S.messages.at(-1), ['warning', "Can't undo: the file was reloaded from disk"]);
  await events[1].redo();
  assert.deepStrictEqual(S.messages.at(-1), ['warning', "Can't redo: the file was reloaded from disk"]);
  assert.strictEqual(doc.version, v);

  // External reload while clean (edit, save, external change): older undo entries refuse too.
  const e3 = tag(doc, '3');
  assert.strictEqual(e3.ok, true);
  await doc.save(token);
  S.writeFile(uri, fixture('rich.docx'), 50_000);
  S.watchers[0].fireChange();
  await waitFor(() => doc.generation === 3, 'reload');
  assert.ok(same(doc.pkg.originalBytes, fixture('rich.docx')));
  await events[2].undo();
  assert.ok(same(doc.pkg.serialize(), fixture('rich.docx')), 'the reloaded package is untouched');
  assert.deepStrictEqual(S.messages.at(-1), ['warning', "Can't undo: the file was reloaded from disk"]);
  assert.ok(panel.types().includes('docxStateChanged'));
});

test('dirty mirror: a save point on a discarded redo branch is never reached again', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, events } = await open('basic.docx', fixture('basic.docx'));
  tag(doc, 'a');
  await doc.save(token);
  assert.strictEqual(doc.isDirty(), false);
  await events[0].undo();
  assert.strictEqual(doc.isDirty(), true);
  tag(doc, 'b');           // discards the redo of 'a', where the save point was
  assert.strictEqual(doc.isDirty(), true);
  await events[1].undo();
  assert.strictEqual(doc.isDirty(), true, 'still dirty: errs towards dirty');
});

// ---------------------------------------------------------------------------------------------
// Save (§6.5)

test('save writes the verified bytes in place (spec §6.5 step 5, Gate R2 F8); only the edited entry differs (G3)', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  const expected = doc.serializeVerified();
  assert.strictEqual(expected.ok, true);
  await doc.save(token);
  const onDisk = S.read(uri);
  assert.ok(same(onDisk, expected.bytes));
  assert.deepStrictEqual(changedEntries(bytes, onDisk), [mainPart(doc)]);
  assert.match(rootTag(onDisk), /vsmdTest="1"/);
  // One writeFile on the target itself: no temporary file, no rename (the file keeps its identity).
  assert.deepStrictEqual(S.fsLog, [['write', uri.toString()]]);
  assert.deepStrictEqual(doc.diskStamp, { mtime: S.files.get(uri.toString()).mtime, size: onDisk.length });
  assert.strictEqual(doc.isDirty(), false);
  // Saving again with nothing new rewrites the same verified bytes (no conflict: the stamp moved with us).
  await doc.save(token);
  assert.ok(same(S.read(uri), expected.bytes));
  assert.ok(!S.messages.some((m) => m[0] === 'warning'), 'no conflict modal');
});

test('save refuses when verification fails: nothing written, §6.5 message, diagnostics without content', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  host.OfficeDocument.saveHooks = { corrupt: (b) => { b[Math.floor(b.length / 2)] ^= 0xff; return b; } };
  S.answer = (msg, items) => (msg === host.saveErrors.VERIFY_FAILED_MESSAGE ? items[0] : undefined);
  const diag = vscode.Uri.file('/ws/diag.txt');
  S.saveDialogResult = diag;
  await assert.rejects(doc.save(token), isCancel);
  assert.ok(same(S.read(uri), bytes), 'the file on disk is untouched');
  assert.deepStrictEqual(S.fsLog.filter((e) => e[1] !== diag.toString()), [], 'nothing but the diagnostics was written');
  assert.strictEqual(doc.isDirty(), true);
  await waitFor(() => S.read(diag), 'diagnostics file');
  const err = S.messages.find((m) => m[0] === 'error');
  assert.deepStrictEqual(err, ['error', 'Save failed an internal consistency check — your file on disk was not changed.', 'Save a copy of diagnostics']);
  const dialog = S.messages.find((m) => m[0] === 'saveDialog')[1];
  assert.strictEqual(dialog.defaultUri.path, '/ws/basic.docx.save-diagnostics.txt');
  const text = new TextDecoder().decode(S.read(diag));
  assert.match(text, /Failures:\n {2}\S/);
  assert.ok(text.includes(mainPart(doc)), 'names the changed part');
  // No document content: no text run, no XML, from the main part.
  const docText = doc.pkg.text(mainPart(doc));
  const words = [...docText.matchAll(/<w:t(?: [^>]*)?>([^<]{4,})<\/w:t>/g)].map((m) => m[1]);
  assert.ok(words.length > 0, 'fixture has text');
  for (const w of words) assert.ok(!text.includes(w), `diagnostics leak "${w}"`);
  assert.ok(!text.includes('<w:'), 'no XML');

  // Save As with the same failure writes nothing either.
  await assert.rejects(doc.saveAs(vscode.Uri.file('/ws/copy.docx'), token), isCancel);
  assert.strictEqual(S.read(vscode.Uri.file('/ws/copy.docx')), undefined);
  // Without the hook the same state saves.
  host.OfficeDocument.saveHooks = undefined;
  await doc.save(token);
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);
});

test('a kind validator failure blocks the save; a throwing validator does too', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  class Strict extends host.DocxEditorProvider {
    validators() { return [(pkg, touched) => touched.map((t) => `${t}: rejected by test validator`)]; }
  }
  class Broken extends host.DocxEditorProvider {
    validators() { throw new Error('no validators'); }
  }
  for (const Provider of [Strict, Broken]) {
    S.reset();
    const bytes = fixture('basic.docx');
    const { doc, uri } = await open('basic.docx', bytes, { Provider });
    // Clean: G0, nothing to validate, the original bytes would be written.
    assert.strictEqual(doc.serializeVerified().ok, Provider === Strict);
    tag(doc);
    const r = doc.serializeVerified();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.bytes, undefined, 'no bytes on failure');
    if (Provider === Strict) assert.deepStrictEqual(r.failures, [{ part: mainPart(doc), message: `${mainPart(doc)}: rejected by test validator` }]);
    await assert.rejects(doc.save(token), isCancel);
    assert.ok(same(S.read(uri), bytes));
    assert.deepStrictEqual(S.fsLog, []);
  }
});

test('locked file: the write error maps to the §10.3 message, the file and the dirty state are kept', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const cases = [
    ['write EBUSY', (op) => (op === 'write' ? Object.assign(new Error("EBUSY: resource busy or locked, open 'x'"), { code: 'EBUSY' }) : undefined)],
    ['write NoPermissions', (op) => (op === 'write' ? vscode.FileSystemError.NoPermissions('EPERM: operation not permitted') : undefined)],
    ['write Unavailable', (op) => (op === 'write' ? vscode.FileSystemError.Unavailable('locked') : undefined)],
  ];
  for (const [what, fail] of cases) {
    S.reset();
    const bytes = fixture('basic.docx');
    const { doc, uri } = await open('basic.docx', bytes);
    tag(doc);
    S.fail = fail;
    await assert.rejects(doc.save(token), (e) => {
      assert.strictEqual(e.message, "Couldn't save: the file is in use by another program (probably Word). Close it there and save again, or use Save As.", what);
      return true;
    });
    assert.ok(same(S.read(uri), bytes), what);
    assert.strictEqual(doc.isDirty(), true, what);
    S.fail = undefined;
    await doc.save(token);   // once the file is free, the same save works
    assert.match(rootTag(S.read(uri)), /vsmdTest="1"/, what);
  }
  // Excel naming, other errors.
  S.reset();
  host.OFFICE_FLAGS.xlsxEdit = true;
  const x = await open('basic.xlsx', fixture('basic.xlsx'), { Provider: host.XlsxEditorProvider });
  tag(x.doc);
  S.fail = (op) => (op === 'write' ? Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) : undefined);
  await assert.rejects(x.doc.save(token), {
    message: `Couldn't save basic.xlsx: ENOSPC: no space left on device ${host.saveErrors.PARTIAL_WRITE_NOTE}`,
  });
  S.fail = (op) => (op === 'write' ? Object.assign(new Error('EACCES'), { code: 'EACCES' }) : undefined);
  await assert.rejects(x.doc.save(token), /probably Excel/);
});

test('a write that fails part-way: dirty, says the file may be incomplete, and the next save asks nothing (Gate R2 F8)', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, uri } = await open('basic.docx', fixture('basic.docx'));
  tag(doc);
  const expected = doc.serializeVerified().bytes;
  // The stub's write fails after truncating the file, like an interrupted in-place write.
  S.fail = (op, u) => {
    if (op !== 'write' || u !== uri.toString()) return undefined;
    S.writeFile(uri, expected.subarray(0, 100), ++S.clock);
    return Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
  };
  let message = '';
  await assert.rejects(doc.save(token), (e) => { message = e.message; return true; });
  assert.strictEqual(message, `Couldn't save basic.docx: EIO: i/o error, write ${host.saveErrors.PARTIAL_WRITE_NOTE}`);
  assert.strictEqual(doc.isDirty(), true, 'the changes are still unsaved');
  assert.deepStrictEqual([...S.files.keys()].filter((k) => k !== uri.toString()), [], 'no temporary file anywhere');
  // Our own failed write is not "changed on disk": the retry saves without the conflict modal.
  S.fail = undefined;
  S.messages.length = 0;
  await doc.save(token);
  assert.ok(same(S.read(uri), expected));
  assert.ok(!S.messages.some((m) => m[0] === 'warning'), 'no conflict modal');
  assert.strictEqual(doc.isDirty(), false);
});

test('conflict on save: Cancel and Overwrite; Revert reverts (VS Code revert when active, else in place)', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const other = fixture('rich.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  S.writeFile(uri, other, 7777);   // changed behind our back (watcher event not delivered yet)
  let asked = null;
  S.answer = (msg, items, options) => { asked = { msg, items, options }; return undefined; };
  await assert.rejects(doc.save(token), isCancel);
  assert.deepStrictEqual(asked, {
    msg: 'basic.docx has changed on disk since it was opened here.',
    items: ['Overwrite', 'Revert to disk version'],
    options: { modal: true, detail: host.saveErrors.CONFLICT_DETAIL },
  });
  assert.ok(same(S.read(uri), other), 'Cancel leaves the disk version');
  assert.strictEqual(doc.isDirty(), true);

  S.answer = () => 'Overwrite';
  await doc.save(token);
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);
  assert.strictEqual(doc.isDirty(), false);

  // Revert, editor active: VS Code's revert command (which calls revertCustomDocument).
  tag(doc, '2');
  S.writeFile(uri, other, 8888);
  S.answer = () => 'Revert to disk version';
  S.activeTabInput = new vscode.TabInputCustom(uri, 'vscodeMdEditor.docx');
  await assert.rejects(doc.save(token), isCancel);
  await waitFor(() => S.commands.length === 1, 'revert command');
  assert.deepStrictEqual(S.commands, [['workbench.action.files.revert']]);
  assert.ok(same(S.read(uri), other));

  // Revert, editor not active: the document reverts itself.
  S.activeTabInput = new vscode.TabInputCustom(vscode.Uri.file('/ws/elsewhere.docx'), 'vscodeMdEditor.docx');
  const g = doc.generation;
  await assert.rejects(doc.save(token), isCancel);
  await waitFor(() => doc.generation === g + 1, 'in-place revert');
  assert.ok(same(doc.pkg.originalBytes, other));
  assert.strictEqual(S.commands.length, 1);
  await waitFor(() => S.messages.some((m) => m[0] === 'info' && m[1] === 'Reverted to the version on disk.'), 'info');
});

test('Save As with no edits writes the original bytes verbatim (G0), also after undo to clean', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  host.OFFICE_FLAGS.xlsxEdit = true;
  for (const [name, Provider] of [['basic.docx', host.DocxEditorProvider], ['formulas.xlsx', host.XlsxEditorProvider]]) {
    S.reset();
    const bytes = fixture(name);
    const { doc, uri, events } = await open(name, bytes, { Provider });
    const dest = vscode.Uri.file(`/ws/out/copy-${name}`);
    await doc.saveAs(dest, token);
    assert.ok(same(S.read(dest), bytes), `${name}: verbatim`);
    assert.strictEqual(doc.serializeVerified().bytes, doc.pkg.originalBytes, 'the original bytes object itself');
    tag(doc);
    await events[0].undo();
    const dest2 = vscode.Uri.file(`/ws/out/copy2-${name}`);
    await doc.saveAs(dest2, token);
    assert.ok(same(S.read(dest2), bytes), `${name}: verbatim after undo to clean`);
    assert.ok(same(S.read(uri), bytes), 'source untouched');
    // Save As with an edit writes it to the destination only; the source keeps its bytes.
    await events[0].redo();
    const dest3 = vscode.Uri.file(`/ws/out/copy3-${name}`);
    await doc.saveAs(dest3, token);
    assert.match(rootTag(S.read(dest3), name.endsWith('.docx') ? 'docx' : 'xlsx'), /vsmdTest="1"/);
    assert.ok(same(S.read(uri), bytes));
    assert.strictEqual(doc.isDirty(), false, 'VS Code moves the save point after Save As');
  }
});

test('Save As over an existing file in another folder replaces it without a conflict check', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc } = await open('basic.docx', fixture('basic.docx'));
  const dest = vscode.Uri.file('/ws/other.docx');
  S.writeFile(dest, fixture('rich.docx'), 1);
  tag(doc);
  await doc.saveAs(dest, token);
  assert.match(rootTag(S.read(dest)), /vsmdTest="1"/);
  assert.ok(!S.messages.some((m) => m[0] === 'warning'));
});

// ---------------------------------------------------------------------------------------------
// Backup / hot exit, revert (§6.2)

test('backup → restore (hot exit): backup holds the verified serialisation; restoring opens it dirty', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  const dest = vscode.Uri.file('/backups/abc/basic.docx');
  const backup = await doc.backup(dest, token);
  // The id names the backup file and carries the disk base (Gate R2 F3).
  assert.ok(backup.id.startsWith(host.BACKUP_ID_PREFIX), backup.id);
  const parsed = host.parseBackupId(backup.id);
  assert.strictEqual(parsed.source.toString(), dest.toString());
  assert.deepStrictEqual(parsed.base, { mtime: 1000, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('base64') });
  const backed = S.read(dest);
  assert.ok(same(backed, doc.serializeVerified().bytes));
  assert.deepStrictEqual(changedEntries(bytes, backed), [mainPart(doc)]);
  assert.ok(same(S.read(uri), bytes), 'the file itself is untouched');
  // Cached per version: a second backup reuses the same serialisation.
  const first = doc.serializeVerified();
  assert.strictEqual(doc.serializeVerified(), first);
  await doc.backup(vscode.Uri.file('/backups/abc/again.docx'), token);
  assert.strictEqual(doc.serializeVerified(), first);
  tag(doc, '2');
  assert.notStrictEqual(doc.serializeVerified(), first, 'a new version serialises again');

  // Restore: VS Code reopens with the backup id.
  const restored = await open('basic.docx', undefined, { backupId: backup.id });
  assert.ok(restored.doc.pkg);
  assert.match(rootTag(restored.doc.pkg.originalBytes), /vsmdTest="1"/);
  assert.strictEqual(restored.doc.isDirty(), true, 'restored from a backup = dirty');
  assert.deepStrictEqual(restored.doc.diskStamp, { mtime: 1000, size: bytes.length }, 'stamp of the real file');
  // Saving the restored state writes the backup content to the file and makes it clean.
  await restored.doc.save(token);
  assert.ok(same(S.read(uri), backed));
  assert.strictEqual(restored.doc.isDirty(), false);
  // A restored document with no further edits saves the backup bytes verbatim.
  backup.delete();
  await tick();
  assert.strictEqual(S.read(dest), undefined, 'delete removes the backup');
  backup.delete();   // twice is harmless
});

test('backup refuses unverified bytes; an unreadable backup falls back to the file', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc } = await open('basic.docx', bytes);
  tag(doc);
  host.OfficeDocument.saveHooks = { corrupt: (b) => b.subarray(0, b.length - 10) };
  const dest = vscode.Uri.file('/backups/x/basic.docx');
  await assert.rejects(doc.backup(dest, token), /Couldn't back up unsaved changes/);
  await assert.rejects(doc.backup(dest, token), /Couldn't back up/);
  assert.strictEqual(S.read(dest), undefined);
  assert.strictEqual(S.messages.filter((m) => m[0] === 'error').length, 1, 'one message per version');

  const r = await open('basic.docx', bytes, { backupId: 'file:///backups/missing/basic.docx' });
  assert.ok(r.doc.pkg);
  assert.ok(same(r.doc.pkg.originalBytes, bytes));
  assert.strictEqual(r.doc.isDirty(), true, 'VS Code still restores it as dirty');
});

test('revert: re-reads the file, bumps version and generation, re-sends init + state, clean', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, panel, uri } = await open('basic.docx', bytes);
  tag(doc);
  S.writeFile(uri, fixture('rich.docx'), 2000);
  const n0 = panel.sent.length;
  await doc.revert(token);
  assert.strictEqual(doc.version, 2);
  assert.strictEqual(doc.generation, 2);
  assert.strictEqual(doc.isDirty(), false);
  assert.ok(same(doc.pkg.originalBytes, fixture('rich.docx')));
  assert.deepStrictEqual(panel.sent.slice(n0).map((m) => m.type), ['init', 'docxStateChanged']);
  assert.strictEqual(panel.sent[n0].editMode, true, 'Edit mode survives a revert');
  assert.deepStrictEqual(doc.diskStamp, { mtime: 2000, size: fixture('rich.docx').length });
});

// ---------------------------------------------------------------------------------------------
// External change (§6.1) with the real dirty state

test('external change while dirty: one notice, state kept; saving asks first and clears the notice', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, panel, uri } = await open('basic.docx', fixture('basic.docx'));
  tag(doc);
  const pkg = doc.pkg;
  S.writeFile(uri, fixture('rich.docx'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => panel.types().includes('notices'), 'notices');
  assert.deepStrictEqual(panel.last('notices').notices.map((n) => n.code), ['changed-on-disk']);
  assert.strictEqual(doc.pkg, pkg);
  assert.strictEqual(doc.version, 1);
  S.answer = () => 'Overwrite';
  await doc.save(token);
  assert.deepStrictEqual(panel.last('notices').notices, []);
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);
  // Our own write does not count as an external change.
  S.watchers[0].fireChange();
  await tick(30);
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.pkg, pkg);
});

test('external change after undo back to clean reloads', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, uri, events } = await open('basic.docx', fixture('basic.docx'));
  tag(doc);
  await events[0].undo();
  assert.strictEqual(doc.isDirty(), false);
  S.writeFile(uri, fixture('rich.docx'), 5000);
  S.watchers[0].fireChange();
  await waitFor(() => doc.generation === 2, 'reload');
  assert.ok(same(doc.pkg.originalBytes, fixture('rich.docx')));
});

// ---------------------------------------------------------------------------------------------
// Flush handshake (§6.5 step 1)

test('save flushes first: a commit landing before `flushed` is saved; edits are refused while writing', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, panel, uri } = await open('basic.docx', fixture('basic.docx'));
  panel.autoFlush = false;
  tag(doc);
  const saving = doc.save(token);
  await tick();
  const f = panel.last('flushPendingEdits');
  assert.ok(f, 'flushPendingEdits posted');
  assert.strictEqual(typeof f.flushId, 'number');
  // The pending commit arrives, then the webview answers.
  assert.strictEqual(tag(doc, 'late').ok, true);
  await panel.send({ type: 'flushed', flushId: f.flushId + 100 });   // unknown id: ignored
  await panel.send({ type: 'flushed', flushId: f.flushId });
  // While the write is in flight an edit is refused (it would be marked saved without being on disk).
  let refused = null;
  S.fail = (op) => { if (op === 'write' && !refused) refused = tag(doc, 'during'); return undefined; };
  await saving;
  assert.deepStrictEqual(refused, { ok: false, error: { code: 'blocked', message: 'The document is being saved. Try again in a moment.' } });
  assert.match(rootTag(S.read(uri)), /vsmdTest="late"/);
  assert.strictEqual(doc.isDirty(), false);
  assert.strictEqual(tag(doc, 'after').ok, true, 'edits work again after the save');
});

test('review B1: an edit arriving while a save is writing waits for the save instead of being refused', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, uri } = await open('basic.docx', fixture('basic.docx'));
  tag(doc);
  assert.strictEqual(await doc.editRefusalAfterSave(), null, 'no save: resolves at once');
  let waiting = null;
  let settled = false;
  S.fail = (op) => {
    if (op === 'write' && !waiting) {
      waiting = doc.editRefusalAfterSave().then((r) => { settled = true; return r; });
    }
    return undefined;
  };
  await doc.save(token);
  assert.ok(waiting, 'asked while the save was writing');
  assert.strictEqual(await waiting, null, 'no refusal once the save is done');
  assert.ok(settled);
  assert.strictEqual(tag(doc, 'after').ok, true, 'the edit lands after the bytes written');
  assert.strictEqual(doc.isDirty(), true, 'and keeps the document dirty');
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/, 'the save wrote the state before the edit');

  // Disposal while waiting releases the waiter with the read-only refusal.
  let late = null;
  S.fail = (op) => { if (op === 'write' && !late) { late = doc.editRefusalAfterSave(); doc.dispose(); } return undefined; };
  await doc.save(token).catch(() => {});
  assert.strictEqual((await late).code, 'read-only');
});

test('flush times out when the webview never answers; backup flushes too; no flush before ready', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  host.OfficeDocument.flushTimeoutMs = 40;
  const { doc, panel, uri } = await open('basic.docx', fixture('basic.docx'));
  panel.autoFlush = false;
  tag(doc);
  const t0 = Date.now();
  await doc.save(token);
  assert.ok(Date.now() - t0 >= 35, 'waited for the timeout');
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);
  const n = panel.sent.filter((m) => m.type === 'flushPendingEdits').length;
  await doc.backup(vscode.Uri.file('/backups/b.docx'), token);
  assert.strictEqual(panel.sent.filter((m) => m.type === 'flushPendingEdits').length, n + 1);

  // A panel that has not sent `ready` is not asked (it cannot have anything pending).
  const provider = new host.DocxEditorProvider(ctx);
  const u2 = vscode.Uri.file('/ws/two.docx');
  S.writeFile(u2, fixture('basic.docx'), 1000);
  const d2 = await provider.openCustomDocument(u2, { backupId: undefined }, token);
  const p2 = makePanel();
  await provider.resolveCustomEditor(d2, p2, token);
  host.OfficeDocument.flushTimeoutMs = 20_000;   // waiting for it would be unmistakable even under load
  const t1 = Date.now();
  await d2.saveAs(vscode.Uri.file('/ws/two-copy.docx'), token);
  assert.ok(Date.now() - t1 < 10_000, 'did not wait for a flush');
  assert.ok(!p2.types().includes('flushPendingEdits'));
});

// ---------------------------------------------------------------------------------------------
// Save-time preparation hook (xlsx calc handling lives here from WP-23)

test('beforeFirstSerialize: in the written bytes only, never in the document or on the undo stack; not for G0', async () => {
  host.OFFICE_FLAGS.xlsxEdit = true;
  class Prep extends host.XlsxEditorProvider {
    beforeFirstSerialize(b) {
      const part = host.hcore.opc.mainPart(b.pkg).name;
      b.setAttr(part, b.pkg.xml(part).root, '', 'vsmdPrepared', '1');
    }
  }
  const bytes = fixture('basic.xlsx');
  const { doc, uri, events } = await open('basic.xlsx', bytes, { Provider: Prep });
  // Clean: original bytes, hook not applied.
  await doc.saveAs(vscode.Uri.file('/ws/clean.xlsx'), token);
  assert.ok(same(S.read(vscode.Uri.file('/ws/clean.xlsx')), bytes));
  tag(doc);
  const inMemory = doc.pkg.serialize();
  await doc.save(token);
  const written = rootTag(S.read(uri), 'xlsx');
  assert.match(written, /vsmdTest="1"/);
  assert.match(written, /vsmdPrepared="1"/);
  assert.ok(same(doc.pkg.serialize(), inMemory), 'rolled back after serialising');
  assert.doesNotMatch(rootTag(inMemory, 'xlsx'), /vsmdPrepared/);
  await events[0].undo();
  assert.ok(same(doc.pkg.serialize(), bytes), 'undo still reaches the original');
});

// ---------------------------------------------------------------------------------------------

test('envSaveHooks: only VSMD_OFFICE_CORRUPT_SAVE=1 enables the manual verification-failure hook', () => {
  assert.strictEqual(host.envSaveHooks(undefined), undefined);
  assert.strictEqual(host.envSaveHooks({}), undefined);
  assert.strictEqual(host.envSaveHooks({ VSMD_OFFICE_CORRUPT_SAVE: 'true' }), undefined);
  const h = host.envSaveHooks({ VSMD_OFFICE_CORRUPT_SAVE: '1' });
  const b = new Uint8Array([1, 2, 3]);
  assert.deepStrictEqual([...h.corrupt(b)], [1, 0xfd, 3]);
});

// ---------------------------------------------------------------------------------------------
// Gate R2 review fixes (host side)

/** Make the file on disk differ: what Word/Excel would write while VS Code was closed. */
function otherVersion(bytes, kind = 'docx') {
  const p = core.pkg.OfficePackage.open(`x.${kind}`, bytes);
  const part = core.opc.mainPart(p).name;
  const t = p.text(part);
  const i = t.indexOf('<', t.startsWith('<?xml') ? t.indexOf('?>') : 0);
  const j = t.indexOf('>', i);
  p.setPart(part, new TextEncoder().encode(t.slice(0, j) + ' vsmdOther="1"' + t.slice(j)));
  return p.serialize();
}

test('F3: a backup restored after the file changed on disk asks before overwriting it, and says so at once', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  const backup = await doc.backup(vscode.Uri.file('/backups/f3/basic.docx'), token);
  doc.dispose();
  // While VS Code is closed, Word saves a different version.
  const other = otherVersion(bytes);
  S.writeFile(uri, other, 5000);
  const r = await open('basic.docx', undefined, { backupId: backup.id });
  assert.match(rootTag(r.doc.pkg.originalBytes), /vsmdTest="1"/, 'the backup content is restored');
  assert.strictEqual(r.doc.restoredConflict, true);
  assert.deepStrictEqual(r.panel.last('init').notices.map((n) => n.code), ['changed-on-disk'], 'the notice shows at once');
  // Save: the conflict modal, Cancel keeps Word's version.
  let asked = 0;
  S.answer = (msg) => { if (msg === 'basic.docx has changed on disk since it was opened here.') asked++; return undefined; };
  await assert.rejects(r.doc.save(token), isCancel);
  assert.strictEqual(asked, 1);
  assert.ok(same(S.read(uri), other), "the other program's version survives");
  assert.strictEqual(r.doc.isDirty(), true);
  // Overwrite writes ours, clears the notice and the flag; the next save asks nothing.
  S.answer = () => 'Overwrite';
  await r.doc.save(token);
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);
  assert.strictEqual(r.doc.restoredConflict, false);
  assert.deepStrictEqual(r.panel.last('notices').notices, []);
  S.answer = () => { asked++; return undefined; };
  tag(r.doc, '2');
  await r.doc.save(token);
  assert.strictEqual(asked, 1, 'no second modal');
});

test('F3: an unchanged file restores without a conflict; one only touched (same bytes) neither; a legacy id is conflicting', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const bytes = fixture('basic.docx');
  const { doc, uri } = await open('basic.docx', bytes);
  tag(doc);
  const backup = await doc.backup(vscode.Uri.file('/backups/f3b/basic.docx'), token);
  doc.dispose();

  const quiet = await open('basic.docx', undefined, { backupId: backup.id });
  assert.strictEqual(quiet.doc.restoredConflict, false);
  assert.deepStrictEqual(quiet.panel.last('init').notices, []);
  S.messages.length = 0;
  await quiet.doc.save(token);
  assert.ok(!S.messages.some((m) => m[0] === 'warning'), 'no conflict modal');
  assert.match(rootTag(S.read(uri)), /vsmdTest="1"/);

  // Touched: same bytes, new mtime (a sync client, `touch`): the hash says nothing changed.
  S.writeFile(uri, bytes, 9000);
  const touched = await open('basic.docx', undefined, { backupId: backup.id });
  assert.strictEqual(touched.doc.restoredConflict, false);
  assert.deepStrictEqual(touched.doc.base, { mtime: 9000, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('base64') });

  // A backup id from before Gate R2 (a bare URI) carries no base: treated as conflicting.
  S.writeFile(uri, bytes, 1000);
  const legacy = await open('basic.docx', undefined, { backupId: host.parseBackupId(backup.id).source.toString() });
  assert.strictEqual(legacy.doc.restoredConflict, true);
  assert.match(rootTag(legacy.doc.pkg.originalBytes), /vsmdTest="1"/);
  S.answer = () => undefined;
  await assert.rejects(legacy.doc.save(token), isCancel);
  assert.ok(same(S.read(uri), bytes));
  // Garbage ids and a missing backup fall back to the file.
  assert.deepStrictEqual(host.parseBackupId(host.BACKUP_ID_PREFIX + '{nope'), { source: null, base: null });
  assert.deepStrictEqual(host.parseBackupId(host.BACKUP_ID_PREFIX + JSON.stringify({ uri: 'file:///b', base: { mtime: 'x' } })).base, null);
});

test('F6: undo while the save is writing is refused; disk and memory agree; the dirty mirror errs towards dirty', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const { doc, uri, events } = await open('basic.docx', fixture('basic.docx'));
  tag(doc, '777');
  let undone = false;
  S.fail = (op) => { if (op === 'write' && !undone) { undone = true; events[0].undo(); } return undefined; };
  S.messages.length = 0;
  await doc.save(token);
  S.fail = undefined;
  assert.ok(undone);
  assert.deepStrictEqual(S.messages.filter((m) => m[0] === 'warning').map((m) => m[1]), [host.saveErrors.SAVE_BUSY_MESSAGE]);
  assert.match(rootTag(doc.pkg.serialize()), /vsmdTest="777"/, 'memory still has the edit');
  assert.match(rootTag(S.read(uri)), /vsmdTest="777"/, 'and so does the disk');
  assert.strictEqual(doc.isDirty(), true, 'VS Code moved its pointer: the mirror says dirty, never "clean but different"');
  assert.strictEqual(doc.version, 1, 'the refused undo changed nothing');
  // Redo is refused the same way while writing.
  let redone = false;
  S.fail = (op) => { if (op === 'write' && !redone) { redone = true; events[0].redo(); } return undefined; };
  await doc.save(token);
  S.fail = undefined;
  assert.ok(redone);
  assert.match(rootTag(S.read(uri)), /vsmdTest="777"/);
  // Outside a save, undo works again.
  await events[0].undo();
  assert.doesNotMatch(rootTag(doc.pkg.serialize()), /vsmdTest/);
});

test('F5: backups skip the format validators, serialise once per state, reuse a save\'s verified bytes and post nothing visible', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  let validatorRuns = 0;
  class Counting extends host.DocxEditorProvider {
    validators() { return [() => { validatorRuns++; return []; }]; }
  }
  const { doc, panel } = await open('basic.docx', fixture('basic.docx'), { Provider: Counting });
  tag(doc);
  const pkg = doc.pkg;
  const realSerialize = pkg.serialize.bind(pkg);
  let serialized = 0;
  pkg.serialize = (...a) => { serialized++; return realSerialize(...a); };
  const realSerializeAsync = pkg.serializeAsync.bind(pkg);
  pkg.serializeAsync = (...a) => { serialized++; return realSerializeAsync(...a); };
  const n0 = panel.sent.length;
  const b1 = await doc.backup(vscode.Uri.file('/backups/f5/1.docx'), token);
  deepTypes(panel.sent.slice(n0), ['flushPendingEdits'], 'a backup posts only the flush request');
  assert.strictEqual(validatorRuns, 0, 'no format validators for a backup');
  assert.strictEqual(serialized, 1);
  // VS Code backs up again (new destination each time): the same state is not serialised again.
  const b2 = await doc.backup(vscode.Uri.file('/backups/f5/2.docx'), token);
  assert.strictEqual(serialized, 1);
  assert.ok(same(S.read(vscode.Uri.file('/backups/f5/2.docx')), S.read(vscode.Uri.file('/backups/f5/1.docx'))));
  // VS Code deletes the superseded backup: only that file goes.
  b1.delete();
  await tick();
  assert.strictEqual(S.read(vscode.Uri.file('/backups/f5/1.docx')), undefined);
  assert.ok(S.read(vscode.Uri.file('/backups/f5/2.docx')));
  void b2;
  // A save verifies fully (validators run); a backup of that state reuses its bytes.
  await doc.save(token);
  assert.strictEqual(validatorRuns, 1);
  const s1 = serialized;
  await doc.backup(vscode.Uri.file('/backups/f5/3.docx'), token);
  assert.strictEqual(serialized, s1, 'the save\'s verified bytes are reused');
  assert.strictEqual(validatorRuns, 1);
});

test('F5: a backup waits for a quiet period; an edit landing meanwhile is in the one serialisation it makes', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  host.OfficeDocument.backupDelayMs = 40;
  const { doc } = await open('basic.docx', fixture('basic.docx'));
  tag(doc, 'a');
  const pkg = doc.pkg;
  const realSerialize = pkg.serialize.bind(pkg);
  let serialized = 0;
  pkg.serialize = (...a) => { serialized++; return realSerialize(...a); };
  const realSerializeAsync = pkg.serializeAsync.bind(pkg);
  pkg.serializeAsync = (...a) => { serialized++; return realSerializeAsync(...a); };
  const dest = vscode.Uri.file('/backups/q/basic.docx');
  const pending = doc.backup(dest, token);
  await tick(15);
  tag(doc, 'b');   // typing continues: the quiet period restarts
  await tick(15);
  assert.strictEqual(serialized, 0, 'nothing serialised while edits keep coming');
  await pending;
  assert.strictEqual(serialized, 1);
  assert.match(rootTag(S.read(dest)), /vsmdTest="b"/);
  // A cancelled backup writes nothing.
  tag(doc, 'c');
  const cancelled = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const p2 = doc.backup(vscode.Uri.file('/backups/q/cancelled.docx'), cancelled);
  cancelled.isCancellationRequested = true;
  await assert.rejects(p2, isCancel);
  assert.strictEqual(S.read(vscode.Uri.file('/backups/q/cancelled.docx')), undefined);
});

test('F5: the staged save verification gives the same outcome as serializeAndVerify', async () => {
  const strict = (pkg, touched) => touched.map((t) => `${t}: rejected by test validator`);
  const cases = [
    ['basic.docx', [], undefined],
    ['basic.xlsx', [host.hcore.save.packageValidator], undefined],
    ['basic.docx', [strict], undefined],
    ['basic.docx', [], { corrupt: (b) => { b[Math.floor(b.length / 2)] ^= 0xff; return b; } }],
    ['basic.docx', [() => { throw new Error('boom'); }], undefined],
  ];
  for (const [name, validators, hooks] of cases) {
    const p = host.hcore.pkg.OfficePackage.open(name, fixture(name));
    const part = host.hcore.opc.mainPart(p).name;
    const b = new host.hcore.edits.EditBuilder(p, 'x');
    b.setAttr(part, p.xml(part).root, '', 'vsmdTest', '1');
    b.finish();
    const sync = host.hcore.save.serializeAndVerify(p, validators, hooks && { corrupt: (x) => hooks.corrupt(x) });
    const staged = await host.serializeAndVerifyStaged(p, validators, hooks && { corrupt: (x) => hooks.corrupt(x) });
    assert.strictEqual(staged.ok, sync.ok, name);
    if (sync.ok) assert.ok(same(staged.bytes, sync.bytes), name);
    else assert.deepStrictEqual(staged.failures, sync.failures, name);
  }
  // The backup check refuses a truncated or bit-flipped ZIP and accepts a good one.
  const good = fixture('basic.xlsx');
  assert.deepStrictEqual(await host.verifyBackupBytes(good, 'xlsx'), []);
  assert.ok((await host.verifyBackupBytes(good.subarray(0, good.length - 10), 'xlsx')).length > 0);
  assert.ok((await host.verifyBackupBytes(good, 'docx')).length > 0, 'wrong kind');
});

test('nit (a): entering Edit on a digitally signed file warns once that saving invalidates the signature', async () => {
  host.OFFICE_FLAGS.docxEdit = true;
  const p = core.pkg.OfficePackage.open('basic.docx', fixture('basic.docx'));
  p.setPart('_xmlsignatures/origin.sigs', new Uint8Array(0));
  const signed = p.serialize();
  const { doc, panel } = await open('basic.docx', signed, { editMode: false });
  assert.strictEqual(doc.signed, true);
  assert.strictEqual(doc.canEdit, true, 'still editable: the warning is the guard');
  const warnings = () => S.messages.filter((m) => m[0] === 'warning').map((m) => m[1]);
  assert.deepStrictEqual(warnings(), []);
  await panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(warnings(), [host.saveErrors.signedEditWarning('Word')]);
  await panel.send({ type: 'setEditMode', editMode: false });
  await panel.send({ type: 'setEditMode', editMode: true });
  assert.strictEqual(warnings().length, 1, 'once per document');
  // startInEditMode warns too; an unsigned file never does.
  S.messages.length = 0;
  S.config['vscodeMdEditor.office.startInEditMode'] = true;
  await open('signed2.docx', signed, { editMode: false });
  assert.deepStrictEqual(warnings(), [host.saveErrors.signedEditWarning('Word')]);
  S.messages.length = 0;
  const plain = await open('plain.docx', fixture('basic.docx'));
  assert.strictEqual(plain.doc.signed, false);
  assert.deepStrictEqual(warnings(), []);
  // A signature-origin relationship alone also counts.
  assert.strictEqual(host.isSignedPackage(core.pkg.OfficePackage.open('basic.docx', fixture('basic.docx'))), false);
});

function deepTypes(msgs, types, what) {
  assert.deepStrictEqual(msgs.map((m) => m.type), types, what);
}
