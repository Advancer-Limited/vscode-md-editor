// WP-33: the docx provider's edit path (src/office/docxEditorProvider.ts + OfficeDocument.recordApplied)
// driven against the in-memory `vscode` stub, like xlsxEditWiring.test.mjs: docxRender (marked copy +
// block list) -> docxRequestBlockModel -> docxEdit -> applyDocxEdit -> VS Code undo stack ->
// docxEditResult, undo/redo/revert, save + re-open, backup/restore, stale and refused edits,
// protection/Track Changes read-only reasons and the "Edit anyway" modal. The edit flag stays false in
// featureFlags.ts; this file bundles the host with a mutable copy. What needs a real Extension
// Development Host (VS Code's undo stack and dirty dot, the real modal) is on the Gate R3 checklist.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import JSZip from 'jszip';
import { fixture } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-docxwiring.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/docxEditorProvider.ts';",
        "export * from './src/office/officeEditorProviderBase.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-docxwiring-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [
      { name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); } },
      {
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
  host.OfficeDocument.backupDelayMs = 0;
});

let shipped;
beforeEach(() => {
  S.reset();
  shipped ??= { ...host.OFFICE_FLAGS };
  Object.assign(host.OFFICE_FLAGS, shipped);
  host.OfficeDocument.saveHooks = undefined;
});
afterEach(() => { Object.assign(host.OFFICE_FLAGS, shipped); host.OfficeDocument.saveHooks = undefined; });

const ctx = {
  extensionUri: vscode.Uri.file('/ext'),
  extension: { packageJSON: { name: 'x', displayName: 'X', version: '0.0.0', description: '' } },
  subscriptions: [],
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function makePanel() {
  const sent = [];
  let onMsg = () => {};
  const panel = {
    sent,
    webview: {
      options: {}, html: '', cspSource: 'https://csp.example',
      asWebviewUri: (u) => ({ toString: () => 'https://webview' + u.path }),
      postMessage: async (m) => {
        sent.push(m);
        if (m.type === 'flushPendingEdits') setTimeout(() => onMsg({ type: 'flushed', flushId: m.flushId }), 0);
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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what) {
  for (let i = 0; i < 400; i++) {
    const v = cond();
    if (v) return v;
    await tick(5);
  }
  assert.fail('timed out waiting for ' + what);
}
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const ENABLE = () => { host.OFFICE_FLAGS.docxEdit = true; };

/** Open a docx the way VS Code does. Edit mode on unless `editMode: false`; waits for the first docxRender. */
async function open(name, bytes, opts = {}) {
  const { editMode = true, backupId } = opts;
  const uri = vscode.Uri.file(`/ws/${name}`);
  if (bytes !== null) S.writeFile(uri, bytes ?? fixture(name), 1000);
  const provider = new host.DocxEditorProvider(ctx);
  const events = [];
  if (provider.onDidChangeCustomDocument) provider.onDidChangeCustomDocument((e) => events.push(e));
  const doc = await provider.openCustomDocument(uri, { backupId, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  await panel.send({ type: 'ready' });
  if (editMode && doc.canEdit) await panel.send({ type: 'setEditMode', editMode: true });
  const h = { provider, doc, panel, events, uri, rid: 1000 };
  await waitFor(() => panel.last('docxRender') || doc.loadError, 'first docxRender');
  return h;
}

async function edit(h, op, baseVersion) {
  const id = ++h.rid;
  await h.panel.send({ type: 'docxEdit', requestId: id, baseVersion: baseVersion ?? h.doc.version, edit: op });
  return waitFor(() => h.panel.sent.find((m) => m.type === 'docxEditResult' && m.requestId === id), `docxEditResult ${id}`);
}

async function blockModel(h, blockId) {
  const id = ++h.rid;
  await h.panel.send({ type: 'docxRequestBlockModel', requestId: id, blockId });
  return waitFor(() => h.panel.sent.find((m) => (m.type === 'docxBlockModel' || m.type === 'requestFailed') && m.requestId === id), `block model ${id}`);
}

async function render(h) {
  const n = h.panel.sent.filter((m) => m.type === 'docxRender').length;
  await h.panel.send({ type: 'docxRequestRender' });
  await waitFor(() => h.panel.sent.filter((m) => m.type === 'docxRender').length > n, 'docxRender');
  return h.panel.last('docxRender');
}

const mainXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
const firstPlain = (blocks) => blocks.find((b) => b.kind === 'paragraph' && b.editable && b.style.kind === 'normal');
const textItems = (model, suffix) => model.segments.map((s) => (s.kind === 'text'
  ? { kind: 'text', text: s.text + suffix, b: s.b, i: s.i, u: s.u, src: s.id }
  : s.kind === 'atom' ? { kind: 'atom', id: s.id } : { kind: 'anchor', id: s.id }));

// ---------------------------------------------------------------------------------------------

test('flag off (as shipped): exactly the view-only viewer', async () => {
  const bytes = fixture('basic.docx');
  const h = await open('basic.docx', bytes);
  assert.strictEqual(h.provider.onDidChangeCustomDocument, undefined);
  assert.strictEqual(h.doc.canEdit, false);
  assert.deepStrictEqual(h.panel.types(), ['init', 'docxRender']);
  const r = h.panel.last('docxRender');
  assert.ok(same(r.bytes, bytes));
  assert.deepStrictEqual(r.blocks, []);
  assert.strictEqual(r.bytes.constructor, Uint8Array);
  assert.strictEqual(h.panel.sent[0].readOnlyReason, null);
  const m = await blockModel(h, 1);
  assert.deepStrictEqual(m, { type: 'requestFailed', requestId: m.requestId, error: { code: 'read-only', message: 'This document is open read-only.' } });
  const e = await edit(h, { op: 'removeParagraph', blockId: 1 });
  assert.deepStrictEqual(e, { type: 'docxEditResult', requestId: e.requestId, ok: false, error: { code: 'read-only', message: 'This document is open read-only.' } });
  assert.strictEqual(h.doc.version, 0);
  // Even protected files keep today's reason (null) while the flag is off.
  const p = await open('protected.docx');
  assert.strictEqual(p.panel.sent[0].readOnlyReason, null);
});

test('flag on: render is the marked copy of the current state plus the block list (plain Uint8Array)', async () => {
  ENABLE();
  const bytes = fixture('basic.docx');
  const h = await open('basic.docx', bytes);
  assert.notStrictEqual(h.provider.onDidChangeCustomDocument, undefined);
  const r = h.panel.last('docxRender');
  assert.strictEqual(r.version, 0);
  assert.strictEqual(r.bytes.constructor, Uint8Array);
  assert.strictEqual(r.bytes.byteOffset, 0);
  assert.strictEqual(r.bytes.byteLength, r.bytes.buffer.byteLength);
  assert.ok(r.blocks.length > 5);
  assert.ok(r.blocks.every((b) => typeof b.id === 'number' && 'editable' in b));
  assert.ok(!same(r.bytes, bytes), 'the copy carries the marker bookmarks');
  assert.match(await mainXml(r.bytes), /__vsmd_s_/);
  assert.ok(!(await mainXml(h.doc.pkg.serialize())).includes('__vsmd_'), 'the document itself is never marked');
  assert.strictEqual(h.panel.sent[0].canEdit, true);
});

test('block model: segments carry effective formatting; opaque and missing blocks are refused', async () => {
  ENABLE();
  const h = await open('basic.docx');
  const para = firstPlain(h.panel.last('docxRender').blocks);
  const m = await blockModel(h, para.id);
  assert.strictEqual(m.type, 'docxBlockModel');
  assert.strictEqual(m.blockId, para.id);
  assert.strictEqual(m.version, 0);
  assert.ok(m.segments.some((s) => s.kind === 'text'));
  for (const s of m.segments) if (s.kind === 'text') assert.deepStrictEqual(Object.keys(s).sort(), ['b', 'css', 'i', 'id', 'kind', 'text', 'u']);
  const gone = await blockModel(h, 999999);
  assert.strictEqual(gone.type, 'requestFailed');
  assert.strictEqual(gone.error.code, 'stale');
  const t = await open('tables.docx');
  const opaque = t.panel.last('docxRender').blocks.find((b) => b.kind === 'opaque');
  assert.ok(opaque);
  const o = await blockModel(t, opaque.id);
  assert.strictEqual(o.error.code, 'blocked');
});

test('edit -> VS Code stack: one event, result with full block list, undo/redo byte-identical, dirty tracking', async () => {
  ENABLE();
  const original = fixture('basic.docx');
  const h = await open('basic.docx');
  const blocks = h.panel.last('docxRender').blocks;
  const para = firstPlain(blocks);
  const model = await blockModel(h, para.id);
  const r = await edit(h, { op: 'commitParagraph', blockId: para.id, items: textItems(model, ' EDITED') });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 1);
  assert.deepStrictEqual(r.changedBlockIds, [para.id]);
  assert.strictEqual(r.blocks.length, blocks.length);
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].label, 'Edit Paragraph');
  assert.strictEqual(h.doc.version, 1);
  assert.strictEqual(h.doc.isDirty(), true);
  assert.match(await mainXml(h.doc.pkg.serialize()), /EDITED/);
  const edited = h.doc.pkg.serialize();

  const n0 = h.panel.sent.length;
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original), 'undo is byte-identical to the original');
  assert.strictEqual(h.doc.isDirty(), false);
  assert.deepStrictEqual(h.panel.last('docxStateChanged'), { type: 'docxStateChanged', version: 2 });
  assert.ok(h.panel.sent.slice(n0).some((m) => m.type === 'docxStateChanged'));
  // The model followed the undo: a render and a block model show the original text.
  const r2 = await render(h);
  assert.ok(!(await mainXml(r2.bytes)).includes('EDITED'));
  assert.ok(!(await blockModel(h, para.id)).segments.some((s) => s.kind === 'text' && s.text.includes('EDITED')));
  await h.events[0].redo();
  assert.ok(same(h.doc.pkg.serialize(), edited));
  assert.ok((await blockModel(h, para.id)).segments.some((s) => s.kind === 'text' && s.text.includes('EDITED')));
});

test('structure ops: insert, insert, remove; everything undone is the original; edits work after undo', async () => {
  ENABLE();
  const original = fixture('basic.docx');
  const h = await open('basic.docx');
  const first = h.panel.last('docxRender').blocks;
  const para = firstPlain(first);
  const ins = await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  assert.strictEqual(ins.ok, true);
  assert.strictEqual(ins.blocks.length, first.length + 1);
  assert.ok(ins.focus);
  const fresh = ins.blocks.find((b) => b.id === ins.focus.blockId);
  // setStyle / setList are WP-30 (stylesWrite.ts, still a stub on this branch): their wiring is the same
  // applyDocxEdit path, covered once WP-30 lands.
  const ins2 = await edit(h, { op: 'insertParagraphAfter', blockId: fresh.id });
  assert.strictEqual(ins2.ok, true);
  const rm = await edit(h, { op: 'removeParagraph', blockId: fresh.id });
  assert.strictEqual(rm.ok, true);
  assert.ok(!rm.blocks.some((b) => b.id === fresh.id));
  assert.strictEqual(h.events.length, 3);
  for (let i = 2; i >= 0; i--) await h.events[i].undo();
  assert.ok(same(h.doc.pkg.serialize(), original));
  const again = await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  assert.strictEqual(again.ok, true);
});

test('stale base version, bad ids and View mode are answered without touching the package', async () => {
  ENABLE();
  const h = await open('basic.docx');
  const para = firstPlain(h.panel.last('docxRender').blocks);
  const before = h.doc.pkg.serialize();
  const s = await edit(h, { op: 'insertParagraphAfter', blockId: para.id }, 7);
  assert.strictEqual(s.error.code, 'stale');
  const bad = await edit(h, { op: 'removeParagraph', blockId: 424242 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.code, 'stale');
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);
  await h.panel.send({ type: 'setEditMode', editMode: false });
  const v = await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  assert.deepStrictEqual(v.error, { code: 'read-only', message: 'Press Edit (Ctrl+E) to make changes.' });
  assert.strictEqual(h.events.length, 0);
});

test('edits run in arrival order: two queued edits both apply, results in order', async () => {
  ENABLE();
  const h = await open('basic.docx');
  const para = firstPlain(h.panel.last('docxRender').blocks);
  const a = ++h.rid;
  const b = ++h.rid;
  const v = h.doc.version;
  h.panel.send({ type: 'docxEdit', requestId: a, baseVersion: v, edit: { op: 'insertParagraphAfter', blockId: para.id } });
  h.panel.send({ type: 'docxEdit', requestId: b, baseVersion: v + 1, edit: { op: 'insertParagraphAfter', blockId: para.id } });
  await waitFor(() => h.panel.sent.filter((m) => m.type === 'docxEditResult').length === 2, 'two results');
  const res = h.panel.sent.filter((m) => m.type === 'docxEditResult');
  assert.deepStrictEqual(res.map((r) => [r.requestId, r.ok, r.version]), [[a, true, 1], [b, true, 2]]);
});

test('save after edits passes verification, clears dirty, and the file re-opens with the new text', async () => {
  ENABLE();
  const h = await open('basic.docx');
  const first = h.panel.last('docxRender').blocks;
  const para = firstPlain(first);
  const model = await blockModel(h, para.id);
  await edit(h, { op: 'commitParagraph', blockId: para.id, items: textItems(model, ' SAVED') });
  await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  await h.doc.save(token);
  assert.strictEqual(h.doc.isDirty(), false);
  assert.ok(!S.messages.some((m) => m[0] === 'error'), 'no save error was shown');
  const saved = S.read(h.uri);
  assert.match(await mainXml(saved), /SAVED/);
  const h2 = await open('reopened.docx', saved);
  const blocks2 = h2.panel.last('docxRender').blocks;
  assert.strictEqual(blocks2.length, first.length + 1);
  const m2 = await blockModel(h2, firstPlain(blocks2).id);
  assert.ok(m2.segments.some((s) => s.kind === 'text' && s.text.includes('SAVED')));
});

test('a corrupted serialisation is refused at save: nothing written, document stays dirty', async () => {
  ENABLE();
  const bytes = fixture('basic.docx');
  const h = await open('basic.docx', bytes);
  const para = firstPlain(h.panel.last('docxRender').blocks);
  await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  host.OfficeDocument.saveHooks = { corrupt: (b) => b.subarray(0, b.length - 10) };
  await assert.rejects(h.doc.save(token));
  assert.ok(same(S.read(h.uri), bytes), 'the file is untouched');
  assert.strictEqual(h.doc.isDirty(), true);
});

test('revert: back to the disk state, new package and model, docxStateChanged, edits work again', async () => {
  ENABLE();
  const bytes = fixture('basic.docx');
  const h = await open('basic.docx', bytes);
  const para = firstPlain(h.panel.last('docxRender').blocks);
  await edit(h, { op: 'insertParagraphAfter', blockId: para.id });
  const oldPkg = h.doc.pkg;
  const n0 = h.panel.sent.length;
  await h.doc.revert(token);
  await waitFor(() => h.panel.sent.slice(n0).some((m) => m.type === 'docxStateChanged'), 'docxStateChanged');
  assert.notStrictEqual(h.doc.pkg, oldPkg);
  assert.strictEqual(h.doc.isDirty(), false);
  assert.ok(same(h.doc.pkg.serialize(), bytes));
  const r = await render(h);
  const e = await edit(h, { op: 'insertParagraphAfter', blockId: firstPlain(r.blocks).id });
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.version, h.doc.version);
});

test('backup -> restore (hot exit): the backup holds the verified edit; restoring opens dirty and editable', async () => {
  ENABLE();
  const bytes = fixture('basic.docx');
  const h = await open('basic.docx', bytes);
  const first = h.panel.last('docxRender').blocks;
  await edit(h, { op: 'insertParagraphAfter', blockId: firstPlain(first).id });
  const dest = vscode.Uri.file('/backups/abc/basic.docx');
  const backup = await h.doc.backup(dest, token);
  assert.ok(same(S.read(dest), h.doc.serializeVerified().bytes));
  const r = await open('basic.docx', null, { backupId: backup.id });
  assert.strictEqual(r.doc.isDirty(), true);
  assert.strictEqual(r.doc.canEdit, true);
  const blocks = r.panel.last('docxRender').blocks;
  assert.strictEqual(blocks.length, first.length + 1);
  const e = await edit(r, { op: 'insertParagraphAfter', blockId: firstPlain(blocks).id });
  assert.strictEqual(e.ok, true);
});

test('protected.docx: read-only (protected), original bytes, no block list, edits refused, no Edit anyway', async () => {
  ENABLE();
  const bytes = fixture('protected.docx');
  const h = await open('protected.docx', bytes);
  assert.strictEqual(h.panel.sent[0].canEdit, false);
  assert.strictEqual(h.panel.sent[0].readOnlyReason, 'protected');
  assert.strictEqual(h.panel.sent[0].editMode, false);
  const r = h.panel.last('docxRender');
  assert.ok(same(r.bytes, bytes));
  assert.deepStrictEqual(r.blocks, []);
  await h.panel.send({ type: 'setEditMode', editMode: true });
  assert.deepStrictEqual(h.panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
  assert.ok(!S.messages.some((m) => m[0] === 'warning'), 'no modal for protected');
  const e = await edit(h, { op: 'insertParagraphAfter', blockId: 1 });
  assert.strictEqual(e.error.code, 'read-only');
  assert.strictEqual(h.events.length, 0);
});

test('tracked.docx: read-only (tracked-changes-on); declining keeps it, accepting lifts it once per open; locked paragraphs stay locked', async () => {
  ENABLE();
  const h = await open('tracked.docx', undefined, { editMode: false });
  assert.strictEqual(h.panel.sent[0].readOnlyReason, 'tracked-changes-on');
  assert.deepStrictEqual(h.panel.last('docxRender').blocks, []);
  const e0 = await edit(h, { op: 'insertParagraphAfter', blockId: 1 });
  assert.strictEqual(e0.error.code, 'read-only');

  // Decline (modal dismissed).
  S.answer = () => undefined;
  await h.panel.send({ type: 'setEditMode', editMode: true });
  const asked = S.messages.filter((m) => m[0] === 'warning');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0][2].modal, true);
  assert.match(asked[0][2].detail, /not tracked/);
  assert.strictEqual(asked[0][3], 'Edit anyway (changes will not be tracked)');
  assert.deepStrictEqual(h.panel.last('editModeChanged'), { type: 'editModeChanged', editMode: false });
  assert.strictEqual(h.doc.canEdit, false);

  // Accept.
  S.answer = (_m, items) => items[0];
  const n0 = h.panel.sent.length;
  await h.panel.send({ type: 'setEditMode', editMode: true });
  assert.strictEqual(h.doc.canEdit, true);
  assert.deepStrictEqual(h.panel.last('editModeChanged'), { type: 'editModeChanged', editMode: true });
  const tail = h.panel.sent.slice(n0);
  assert.ok(tail.some((m) => m.type === 'init' && m.canEdit === true && m.readOnlyReason === null));
  assert.ok(tail.some((m) => m.type === 'docxStateChanged'));
  const r = await render(h);
  assert.ok(r.blocks.length > 0);
  const locked = r.blocks.find((b) => b.kind === 'paragraph' && b.lockReason === 'tracked-changes');
  if (locked) {
    const c = await edit(h, { op: 'commitParagraph', blockId: locked.id, items: [] });
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.error.code, 'blocked');
  }
  const warnings = S.messages.filter((m) => m[0] === 'warning').length;

  // Once per open: a later Edit press (after View) does not ask again.
  await h.panel.send({ type: 'setEditMode', editMode: false });
  await h.panel.send({ type: 'setEditMode', editMode: true });
  assert.strictEqual(S.messages.filter((m) => m[0] === 'warning').length, warnings);
  assert.strictEqual(h.doc.canEdit, true);
  const ok = r.blocks.find((b) => b.kind === 'paragraph' && b.editable);
  const e = await edit(h, { op: 'insertParagraphAfter', blockId: ok.id });
  assert.strictEqual(e.ok, true);
});

test('a damaged main part: load error or view-only, and edits are refused', async () => {
  ENABLE();
  const z = await JSZip.loadAsync(fixture('basic.docx'));
  z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>');
  const bytes = await z.generateAsync({ type: 'uint8array' });
  const h = await open('broken.docx', bytes);
  const e = await edit(h, { op: 'insertParagraphAfter', blockId: 1 });
  assert.strictEqual(e.ok, false);
});

// ---------------------------------------------------------------------------------------------
// Review fixes (2026-11-21)

async function withBody(bodyXml, from = 'basic.docx') {
  const zip = await JSZip.loadAsync(fixture(from));
  const t = await zip.file('word/document.xml').async('string');
  const a = t.indexOf('<w:body>');
  const b = t.lastIndexOf('<w:sectPr');
  zip.file('word/document.xml', t.slice(0, a + 8) + bodyXml + t.slice(b));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

test('review B1: an edit sent while a save is writing waits for the save and is applied (not refused)', async () => {
  ENABLE();
  const h = await open('basic.docx');
  const blocks = h.panel.last('docxRender').blocks;
  const para = firstPlain(blocks);
  const m = await blockModel(h, para.id);
  assert.strictEqual((await edit(h, { op: 'commitParagraph', blockId: para.id, items: textItems(m, ' one') })).ok, true);
  let during = null;
  S.fail = (op) => {
    if (op === 'write' && !during) during = edit(h, { op: 'insertParagraphAfter', blockId: para.id });
    return undefined;
  };
  await h.doc.save(token);
  const r = await during;
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(h.events.length, 2, 'both edits are on the undo stack');
  assert.strictEqual(h.doc.isDirty(), true, 'the late edit is not on disk yet');
  const paras = (xml) => (xml.match(/<w:p[ >/]/g) || []).length;
  const original = paras(await mainXml(fixture('basic.docx')));
  assert.strictEqual(paras(await mainXml(S.read(h.uri))), original, 'the save wrote the state before the insert');
  assert.match(await mainXml(S.read(h.uri)), / one</, 'with the commit that came before it');
  assert.strictEqual(paras(await mainXml(h.doc.pkg.serialize())), original + 1, 'the insert landed after the save');
  assert.strictEqual(r.blocks.length, blocks.length + 1);
});

test('review S4: a model-level view-only reason (too many blocks) reaches the webview before the render', async () => {
  ENABLE();
  const h = await open('big.docx', await withBody('<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(20001)));
  const inits = h.panel.sent.filter((m) => m.type === 'init');
  const last = inits[inits.length - 1];
  assert.strictEqual(last.canEdit, false);
  assert.strictEqual(last.readOnlyReason, 'too-large');
  assert.strictEqual(last.editMode, false);
  assert.ok(h.panel.sent.indexOf(last) < h.panel.sent.indexOf(h.panel.last('docxRender')), 'state first, then the render');
  const r = h.panel.last('docxRender');
  assert.deepStrictEqual(r.blocks, []);
  assert.ok(same(r.bytes, h.doc.pkg.originalBytes), 'rendered as the view-only viewer does');
  const bm = await blockModel(h, 1);
  assert.strictEqual(bm.error.code, 'read-only');
  assert.strictEqual((await edit(h, { op: 'insertParagraphAfter', blockId: 1 })).error.code, 'read-only');
});

test('review S1: a file with one pre-existing problem still saves after a split copies it', async () => {
  ENABLE();
  for (const [label, body] of [
    ['dangling pStyle', '<w:p><w:pPr><w:pStyle w:val="NoSuchStyle"/></w:pPr><w:r><w:t>Hello world</w:t></w:r></w:p>'],
    ['dangling numId', '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr></w:pPr><w:r><w:t>Hello world</w:t></w:r></w:p>'],
    ['out-of-order rPr', '<w:p><w:r><w:rPr><w:i/><w:b/></w:rPr><w:t>Hello world</w:t></w:r></w:p>'],
  ]) {
    S.reset();
    const h = await open('t.docx', await withBody(body));
    const b = h.panel.last('docxRender').blocks.find((x) => x.kind === 'paragraph');
    assert.ok(b.editable, label);
    const s0 = (await blockModel(h, b.id)).segments[0];
    const mk = (text) => ({ kind: 'text', text, b: s0.b, i: s0.i, u: s0.u, src: s0.id });
    const r = await edit(h, { op: 'splitParagraph', blockId: b.id, before: [mk('Hello ')], after: [mk('world')] });
    assert.strictEqual(r.ok, true, label);
    await h.doc.save(token);   // rejects (verification failure) when the copied problem is not forgiven
    assert.strictEqual(h.doc.isDirty(), false, label);
    assert.strictEqual((await mainXml(S.read(h.uri))).split('Hello').length, 2, `${label}: saved split`);
  }
});
