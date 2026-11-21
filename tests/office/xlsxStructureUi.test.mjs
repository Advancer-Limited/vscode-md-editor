// WP-41: structure UI host wiring (src/office/xlsxEditorProvider.ts) with the REAL core guards and
// structure ops: insert/delete rows and columns, add/rename/delete sheet end to end through
// xlsxEdit -> applyXlsxEdit -> VS Code undo stack -> xlsxEditResult, the Tier C confirm flow (Continue /
// dismiss / stale), `confirmStructuralEdits: false`, the always-asked delete-sheet modal, the flag-off
// refusal, new-sheet selection, undo/redo byte-identical, and save + reopen of structurally edited
// workbooks (written to tests/.out/xlsxStructureUi/ for scripts/verify-office-open.ps1). The shipped
// OFFICE_FLAGS stay false; the bundle carries a copy whose object is mutable. The real modal, undo
// stack and rendering need the Extension Development Host (Gate R4).
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { fixture, writeOut } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;
const OUT = 'xlsxStructureUi';
const CONFIRM_KEY = 'vscodeMdEditor.office.confirmStructuralEdits';

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-xlsxstructureui.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/xlsxEditorProvider.ts';",
        "export * from './src/office/officeEditorProviderBase.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-xlsxstructureui-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [
      { name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); } },
      {
        name: 'mutable-flags',
        setup(b) {
          b.onLoad({ filter: /featureFlags\.ts$/ }, (args) => {
            const s = fs.readFileSync(args.path, 'utf8');
            assert.ok(s.includes('Object.freeze('), 'featureFlags.ts freezes OFFICE_FLAGS');
            return { contents: s.replace('Object.freeze(', '('), loader: 'ts' };
          });
        },
      },
    ],
  });
  host = require(outfile);
  host.OfficeDocument.diskCheckDelayMs = 0;
});

let shipped;
beforeEach(() => {
  S.reset();
  shipped ??= { ...host.OFFICE_FLAGS };
  Object.assign(host.OFFICE_FLAGS, shipped);
  host.OfficeDocument.saveHooks = undefined;
  host.OfficeDocument.flushTimeoutMs = 1500;
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

/** Open an xlsx the way VS Code does. Edit mode on unless `editMode: false`. */
async function open(name, bytes, opts = {}) {
  const { editMode = true, uriName = name } = opts;
  const uri = vscode.Uri.file(`/ws/${uriName}`);
  S.writeFile(uri, bytes ?? fixture(name), 1000);
  const provider = new host.XlsxEditorProvider(ctx);
  const events = [];
  if (provider.onDidChangeCustomDocument) provider.onDidChangeCustomDocument((e) => events.push(e));
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  await panel.send({ type: 'ready' });
  if (editMode && doc.canEdit) await panel.send({ type: 'setEditMode', editMode: true });
  const h = { provider, doc, panel, events, uri, rid: 1000 };
  return h;
}

/** Send `xlsxEdit` and wait for its result. */
async function edit(h, op, baseVersion) {
  const id = ++h.rid;
  await h.panel.send({ type: 'xlsxEdit', requestId: id, baseVersion: baseVersion ?? h.doc.version, edit: op });
  return waitFor(() => h.panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === id), `xlsxEditResult ${id}`);
}
const setOp = (sheetId, cells) => ({ op: 'setCells', sheetId, cells: cells.map(([r, c, input]) => ({ r, c, input })) });

/** Request a cell window and return the cells keyed "r,c". */
async function cells(h, range, sheetId = 1) {
  const id = ++h.rid;
  await h.panel.send({ type: 'xlsxRequestCells', requestId: id, sheetId, range });
  const m = await waitFor(() => h.panel.sent.find((x) => x.type === 'xlsxCells' && x.requestId === id), `xlsxCells ${id}`);
  return new Map(m.cells.map((c) => [c.r + ',' + c.c, c]));
}
async function seed(h, sheetId, r, c) {
  const id = ++h.rid;
  await h.panel.send({ type: 'xlsxRequestCellInput', requestId: id, sheetId, r, c });
  return (await waitFor(() => h.panel.sent.find((x) => x.type === 'xlsxCellInput' && x.requestId === id), `xlsxCellInput ${id}`)).input;
}

const ENABLE = () => { host.OFFICE_FLAGS.xlsxEdit = true; host.OFFICE_FLAGS.xlsxStructure = true; };
const struct = (op, sheetId, at, count) => ({ op, sheetId, at, count });
const lastWorkbook = (h) => h.panel.last('xlsxWorkbook');
const names = (m) => m.sheets.map((s) => s.name);

// ---------------------------------------------------------------------------------------------

test('flag off (as shipped): the webview is told so and every structural op is refused as blocked', async () => {
  host.OFFICE_FLAGS.xlsxEdit = true;
  const h = await open('basic.xlsx');
  assert.match(h.panel.webview.html, /data-structure="off"/);
  assert.match(h.panel.webview.html, /xlsxStructureUi\.js/);
  for (const op of [struct('insertRows', 1, 0, 1), struct('deleteCols', 1, 0, 1), { op: 'addSheet' }, { op: 'renameSheet', sheetId: 1, name: 'X' }, { op: 'deleteSheet', sheetId: 2 }]) {
    const r = await edit(h, op);
    assert.strictEqual(r.ok, false, op.op);
    assert.strictEqual(r.error.code, 'blocked', op.op);
  }
  assert.strictEqual(h.events.length, 0);
  assert.strictEqual(h.doc.version, 0);
  assert.strictEqual(S.messages.filter((m) => m[0] === 'warning').length, 0, 'no modal');
});

test('flag on: the webview is told so', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  assert.match(h.panel.webview.html, /data-structure="on"/);
});

test('View mode refuses a structural edit with the Edit hint', async () => {
  ENABLE();
  const h = await open('basic.xlsx', undefined, { editMode: false });
  const r = await edit(h, struct('insertRows', 1, 0, 1));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'read-only');
  assert.strictEqual(h.events.length, 0);
});

const LABELS = { insertRows: 'Insert Rows', deleteRows: 'Delete Rows', insertCols: 'Insert Columns', deleteCols: 'Delete Columns' };
for (const [label, op, check] of [
  ['insertRows', struct('insertRows', 1, 0, 2), (c) => c.get('3,1')?.v === 42],
  ['deleteRows', struct('deleteRows', 1, 0, 1), (c) => c.get('0,1')?.v === 42],
  ['insertCols', struct('insertCols', 1, 0, 1), (c) => c.get('1,2')?.v === 42],
  ['deleteCols', struct('deleteCols', 1, 0, 1), (c) => c.get('1,0')?.v === 42],
]) {
  test(`${label}: applied, one undo event, cells shift, undo/redo byte-identical`, async () => {
    ENABLE();
    const original = fixture('basic.xlsx');
    const h = await open('basic.xlsx');
    const r = await edit(h, op);
    assert.deepStrictEqual({ ok: r.ok, invalidate: r.invalidate, sheetId: r.sheetId, version: r.version }, { ok: true, invalidate: 'sheet', sheetId: 1, version: 1 });
    assert.strictEqual(h.events.length, 1);
    assert.strictEqual(h.events[0].label, LABELS[label]);
    assert.strictEqual(h.doc.isDirty(), true);
    assert.ok(check(await cells(h, [0, 0, 12, 6])), 'cells moved');
    const edited = h.doc.pkg.serialize();
    await h.events[0].undo();
    assert.ok(same(h.doc.pkg.serialize(), original), 'undo is byte-identical');
    assert.strictEqual(h.doc.isDirty(), false);
    assert.strictEqual((await cells(h, [0, 0, 12, 6])).get('1,1').v, 42);
    await h.events[0].redo();
    assert.ok(same(h.doc.pkg.serialize(), edited), 'redo is byte-identical');
    assert.ok(check(await cells(h, [0, 0, 12, 6])));
  });
}

test('a blocked structural op (a note below the insertion) reports the reason and changes nothing', async () => {
  ENABLE();
  const h = await open('features.xlsx');
  const before = h.doc.pkg.serialize();
  const r = await edit(h, struct('insertRows', 1, 0, 1));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'blocked');
  assert.match(r.error.message, /note/);
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);
});

test('Tier C: the modal lists what will not follow; Continue applies it with confirmed:true', async () => {
  ENABLE();
  const h = await open('features.xlsx');
  let asked;
  S.answer = (m, items, options) => { asked = { m, items, options }; return 'Continue'; };
  const r = await edit(h, struct('deleteRows', 2, 1, 1));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(asked, 'modal shown');
  assert.strictEqual(asked.options.modal, true);
  assert.match(asked.options.detail, /pivot table "PivotTable1"/);
  assert.strictEqual(h.events.length, 1);
});

test('Tier C: dismissing the modal is "cancelled" and nothing changes', async () => {
  ENABLE();
  const h = await open('features.xlsx');
  const before = h.doc.pkg.serialize();
  S.answer = () => undefined;
  const r = await edit(h, struct('deleteRows', 2, 1, 1));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'cancelled');
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);
  assert.strictEqual(h.doc.version, 0);
});

test('Tier C: a document change while the modal is open answers "stale" and applies nothing', async () => {
  ENABLE();
  const h = await open('features.xlsx');
  S.answer = () => { h.doc.version++; return 'Continue'; };
  const r = await edit(h, struct('deleteRows', 2, 1, 1));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assert.strictEqual(h.events.length, 0);
});

test('confirmStructuralEdits:false skips the Tier C prompt but not the delete-sheet modal', async () => {
  ENABLE();
  S.config[CONFIRM_KEY] = false;
  const h = await open('features.xlsx');
  let asked = 0;
  S.answer = () => { asked++; return 'Continue'; };
  const r = await edit(h, struct('deleteRows', 2, 1, 1));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(asked, 0, 'no prompt for Tier C');
  S.answer = () => { asked++; return undefined; };
  // Review S5: "Pivot" hosts a pivot table, which deleteSheet refuses: refused up front, never asked.
  const p = await edit(h, { op: 'deleteSheet', sheetId: 3 });
  assert.strictEqual(asked, 0, 'no modal for a delete that would be refused');
  assert.strictEqual(p.error.code, 'blocked');
  assert.match(p.error.message, /pivot table/);
  const d = await edit(h, { op: 'deleteSheet', sheetId: 1 });
  assert.strictEqual(asked, 1, 'the delete-sheet modal is shown even when the setting is off');
  assert.strictEqual(d.error.code, 'cancelled');
});

test('addSheet: default name, a fresh xlsxWorkbook selects the new sheet, ids of existing sheets stay, undo identical', async () => {
  ENABLE();
  const original = fixture('basic.xlsx');
  const h = await open('basic.xlsx');
  const r = await edit(h, { op: 'addSheet', afterSheetId: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.invalidate, 'workbook');
  const wb = lastWorkbook(h);
  assert.deepStrictEqual(names(wb), ['Values', 'Sheet1', 'Second Sheet']);
  const added = wb.sheets.find((s) => s.name === 'Sheet1');
  assert.strictEqual(wb.activeSheetId, added.id, 'the new sheet is selected');
  assert.strictEqual(wb.sheets.find((s) => s.name === 'Second Sheet').id, 2, 'existing ids are stable');
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].label, 'Add Sheet');
  await h.panel.send({ type: 'xlsxRequestSheetMeta', sheetId: added.id });
  await waitFor(() => h.panel.last('xlsxSheetMeta'), 'sheet meta');
  const w = await edit(h, setOp(added.id, [[0, 0, 'hello']]));
  assert.strictEqual(w.ok, true);
  assert.strictEqual((await cells(h, [0, 0, 1, 1], added.id)).get('0,0').d, 'hello');
  await h.events[1].undo();
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original));
  assert.deepStrictEqual(names(lastWorkbook(h)), ['Values', 'Second Sheet']);
});

// Review S4 / K14: undo/redo used to drop the model, and a fresh model numbers sheets by position, so
// after an add/delete was undone or redone the webview's active session id named another sheet.
test('K14: session sheet ids stay stable across undo/redo of add and delete sheet', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  S.answer = () => 'Continue';
  const idOf = (wb, name) => wb.sheets.find((s) => s.name === name)?.id;
  const second = idOf(lastWorkbook(h), 'Second Sheet');
  const values = idOf(lastWorkbook(h), 'Values');
  assert.strictEqual((await edit(h, { op: 'addSheet', afterSheetId: values })).ok, true);
  assert.strictEqual((await edit(h, setOp(second, [[0, 0, 'on second']]))).ok, true);
  for (let k = 0; k < 2; k++) {
    await h.events[1].undo();
    await h.events[0].undo();
    let wb = lastWorkbook(h);
    assert.deepStrictEqual(names(wb), ['Values', 'Second Sheet']);
    assert.strictEqual(idOf(wb, 'Second Sheet'), second, 'Second Sheet keeps its id after undo');
    await h.events[0].redo();
    await h.events[1].redo();
    wb = lastWorkbook(h);
    assert.deepStrictEqual(names(wb), ['Values', 'Sheet1', 'Second Sheet']);
    assert.strictEqual(idOf(wb, 'Second Sheet'), second, 'Second Sheet keeps its id after redo');
    assert.strictEqual(idOf(wb, 'Values'), values);
    // The id still addresses the same sheet's cells.
    assert.strictEqual((await cells(h, [0, 0, 0, 0], second)).get('0,0').d, 'on second');
  }
  // Delete the first sheet, undo, redo: the others keep their ids.
  assert.strictEqual((await edit(h, { op: 'deleteSheet', sheetId: values })).ok, true);
  await h.events[2].undo();
  assert.strictEqual(idOf(lastWorkbook(h), 'Second Sheet'), second);
  await h.events[2].redo();
  assert.deepStrictEqual(names(lastWorkbook(h)), ['Sheet1', 'Second Sheet']);
  assert.strictEqual(idOf(lastWorkbook(h), 'Second Sheet'), second);
  assert.strictEqual((await cells(h, [0, 0, 0, 0], second)).get('0,0').d, 'on second');
});

test('renameSheet: valid names apply; invalid ones are refused with the §5.2 reason', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  for (const [name, re] of [
    ['', /./], ['x'.repeat(32), /./], ['a:b', /./], ["'quoted", /./], ['second SHEET', /already exists/], ['History', /History/],
  ]) {
    const r = await edit(h, { op: 'renameSheet', sheetId: 1, name });
    assert.strictEqual(r.ok, false, JSON.stringify(name));
    assert.strictEqual(r.error.code, 'invalid');
    assert.match(r.error.message, re);
  }
  assert.strictEqual(h.events.length, 0);
  const ok = await edit(h, { op: 'renameSheet', sheetId: 2, name: 'Renamed' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.invalidate, 'workbook');
  assert.deepStrictEqual(names(lastWorkbook(h)), ['Values', 'Renamed']);
  assert.strictEqual(h.events[0].label, 'Rename Sheet');
});

test('deleteSheet: the modal is always shown; Continue removes it and selects a neighbour; undo restores byte-identically', async () => {
  ENABLE();
  const original = fixture('basic.xlsx');
  const h = await open('basic.xlsx');
  let asked = 0;
  S.answer = () => { asked++; return 'Continue'; };
  const r = await edit(h, { op: 'deleteSheet', sheetId: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(asked, 1);
  let wb = lastWorkbook(h);
  assert.deepStrictEqual(names(wb), ['Values']);
  assert.strictEqual(wb.activeSheetId, 1, 'the sheet before the deleted one');
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original));
  assert.deepStrictEqual(names(lastWorkbook(h)), ['Values', 'Second Sheet']);
  // deleting the first of two selects the one after it
  const h2 = await open('basic2.xlsx', original);
  const d = await edit(h2, { op: 'deleteSheet', sheetId: 1 });
  assert.strictEqual(d.ok, true);
  wb = lastWorkbook(h2);
  assert.deepStrictEqual(names(wb), ['Second Sheet']);
  assert.strictEqual(wb.activeSheetId, wb.sheets[0].id);
});

test('deleting the last visible worksheet is blocked with the reason', async () => {
  ENABLE();
  const h = await open('tables.xlsx');
  S.answer = () => 'Continue';
  const r = await edit(h, { op: 'deleteSheet', sheetId: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'blocked');
  assert.match(r.error.message, /last visible/);
});

test('structural edits mixed with cell edits queue in order and keep one undo event each', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const ids = [++h.rid, ++h.rid, ++h.rid];
  const v = h.doc.version;
  await h.panel.send({ type: 'xlsxEdit', requestId: ids[0], baseVersion: v, edit: setOp(1, [[1, 1, '7']]) });
  await h.panel.send({ type: 'xlsxEdit', requestId: ids[1], baseVersion: v + 1, edit: struct('insertRows', 1, 0, 1) });
  await h.panel.send({ type: 'xlsxEdit', requestId: ids[2], baseVersion: v + 2, edit: { op: 'addSheet' } });
  for (const id of ids) await waitFor(() => h.panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === id && m.ok), `result ${id}`);
  assert.strictEqual(h.events.length, 3);
  assert.strictEqual((await cells(h, [0, 0, 5, 3])).get('2,1').v, 7, 'the typed value moved down with the inserted row');
});

test('save after structural edits passes verification, clears dirty and the file reopens correctly (outputs for Excel)', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  assert.strictEqual((await edit(h, struct('insertRows', 1, 0, 1))).ok, true);
  assert.strictEqual((await edit(h, struct('insertCols', 1, 0, 1))).ok, true);
  assert.strictEqual((await edit(h, { op: 'renameSheet', sheetId: 2, name: 'Renamed' })).ok, true);
  assert.strictEqual((await edit(h, { op: 'addSheet', afterSheetId: 2 })).ok, true);
  await h.doc.save(token);
  assert.strictEqual(h.doc.isDirty(), false);
  assert.ok(!S.messages.some((m) => m[0] === 'error'), 'no save error was shown');
  const saved = S.read(h.uri);
  const h2 = await open('reopened.xlsx', saved);
  assert.deepStrictEqual(names(lastWorkbook(h2)), ['Values', 'Renamed', 'Sheet1']);
  assert.strictEqual((await cells(h2, [0, 0, 8, 6])).get('2,2').v, 42, 'B2 moved to C3');
  writeOut(OUT, 'insert-rename-add.xlsx', saved, [{ sheet: 'Values', ref: 'C3', value: 42 }]);

  const h3 = await open('basic3.xlsx', fixture('basic.xlsx'));
  assert.strictEqual((await edit(h3, struct('deleteRows', 1, 0, 1))).ok, true);
  assert.strictEqual((await edit(h3, struct('deleteCols', 1, 0, 1))).ok, true);
  S.answer = () => 'Continue';
  assert.strictEqual((await edit(h3, { op: 'deleteSheet', sheetId: 2 })).ok, true);
  await h3.doc.save(token);
  const saved3 = S.read(h3.uri);
  const h4 = await open('reopened3.xlsx', saved3);
  assert.deepStrictEqual(names(lastWorkbook(h4)), ['Values']);
  // Row 1 and column A of Values are gone: old B2 (42) is now A1, old B3 (3.14159) is A2.
  writeOut(OUT, 'delete-rows-cols-sheet.xlsx', saved3, [{ sheet: 'Values', ref: 'A1', value: 42 }, { sheet: 'Values', ref: 'A2', value: 3.14159 }]);

  // undo after a save, then save again: still verifies
  await h3.events[2].undo();
  await h3.doc.save(token);
  const h5 = await open('reopened5.xlsx', S.read(h3.uri));
  assert.deepStrictEqual(names(lastWorkbook(h5)), ['Values', 'Second Sheet']);
  writeOut(OUT, 'delete-sheet-undone.xlsx', S.read(h3.uri), [{ sheet: 'Values', ref: 'A1', value: 42 }, { sheet: 'Values', ref: 'A2', value: 3.14159 }]);
});
