// WP-23: the xlsx provider's editing wiring (src/office/xlsxEditorProvider.ts + OfficeDocument.recordApplied)
// driven against the in-memory `vscode` stub, like saveProvider.test.mjs: xlsxEdit -> applyXlsxEdit ->
// VS Code undo stack -> xlsxEditResult, undo/redo and the model-cache invalidation, save + re-open,
// the dependant seed, the Tier C confirm flow, refusals and paste limits. The edit flags stay false in
// featureFlags.ts; this file bundles the host with a copy whose object is mutable (as saveProvider does)
// and with test-only copies of the WP-38/39 stubs so the confirm flow can be exercised. What needs a
// real Extension Development Host (VS Code's own undo stack and dirty dot, the real modal, the paste
// event) is on the Gate R2 checklist. Saved workbooks go to tests/.out/xlsxEditWiring/ for
// scripts/verify-office-open.ps1.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import JSZip from 'jszip';
import { core, fixture, writeOut } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;
const OUT = 'xlsxEditWiring';

let host;

/** Test-only WP-39 guard: deleting rows needs a confirmation (the shipped stub blocks everything). */
const TEST_GUARDS = `
export function checkStructuralOp(_wb, _pkg, op) {
  if (op.op === 'deleteRows') return Promise.resolve({ confirm: ['Chart "Sales" will not be adjusted.'] });
  if (op.op === 'insertRows') return Promise.resolve({});
  return Promise.resolve({ blocked: 'Not available yet' });
}`;
/** Test-only WP-38 structure op: marks the sheet root so the edit is visible and undoable. */
const TEST_STRUCTURE = `
export async function insertOrDelete(b, _wb, sheet, _axis, _at, _count) {
  b.setAttr(sheet.part, sheet.doc.root, '', 'vsmdStruct', String(Number(sheet.doc.root.attrs.find((a) => a.local === 'vsmdStruct')?.value ?? 0) + 1));
}`;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-xlsxwiring.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/xlsxEditorProvider.ts';",
        "export * from './src/office/officeEditorProviderBase.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
        "export * as saveErrors from './src/office/saveErrors.ts';",
        "export * as hcore from './src/office/core/index.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-xlsxwiring-entry.ts',
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
      {
        name: 'test-structure',
        setup(b) {
          b.onLoad({ filter: /core[\\/]xlsx[\\/]guards\.ts$/ }, () => ({ contents: TEST_GUARDS, loader: 'js' }));
          b.onLoad({ filter: /core[\\/]xlsx[\\/]structure\.ts$/ }, () => ({ contents: TEST_STRUCTURE, loader: 'js' }));
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

const ENABLE = () => { host.OFFICE_FLAGS.xlsxEdit = true; };

// ---------------------------------------------------------------------------------------------

test('flag off (as shipped): xlsxEdit is refused as read-only and nothing is recorded', async () => {
  const h = await open('basic.xlsx');
  assert.strictEqual(h.doc.canEdit, false);
  const r = await edit(h, setOp(1, [[1, 1, '7']]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'read-only');
  assert.strictEqual(h.doc.version, 0);
  assert.strictEqual(h.events.length, 0);
});

test('View mode refuses the edit with the hint and leaves the package alone', async () => {
  ENABLE();
  const h = await open('basic.xlsx', undefined, { editMode: false });
  const before = h.doc.pkg.serialize();
  const r = await edit(h, setOp(1, [[1, 1, '7']]));
  assert.deepStrictEqual(r, { type: 'xlsxEditResult', requestId: r.requestId, ok: false, error: { code: 'read-only', message: 'Press Edit (Ctrl+E) to make changes.' } });
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);
});

test('edit -> VS Code stack: one event "Edit Cell", result with version/range, stale flags and banner, undo/redo byte-identical', async () => {
  ENABLE();
  const original = fixture('formulas.xlsx');
  const h = await open('formulas.xlsx');
  const before = await cells(h, [0, 0, 5, 7]);
  assert.ok(!before.get('1,1').stale, 'untouched workbook: cached formula results are not stale');
  assert.ok(!h.panel.sent.some((m) => m.type === 'notices' && m.notices.some((n) => n.code === 'formula-results-stale')));

  const r = await edit(h, setOp(1, [[1, 6, '99']]));
  assert.deepStrictEqual(r, { type: 'xlsxEditResult', requestId: r.requestId, ok: true, version: 1, invalidate: 'cells', sheetId: 1, range: [1, 6, 1, 6] });
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].label, 'Edit Cell');
  assert.strictEqual(h.doc.version, 1);
  assert.strictEqual(h.doc.isDirty(), true);
  const edited = h.doc.pkg.serialize();

  const after = await cells(h, [0, 0, 5, 7]);
  assert.strictEqual(after.get('1,6').v, 99);
  assert.strictEqual(after.get('1,1').stale, true, 'once edited, every formula cell is flagged stale (spec 9.5)');
  const banner = h.panel.last('notices');
  assert.ok(banner.notices.some((n) => n.code === 'formula-results-stale'));
  assert.match(banner.notices.find((n) => n.code === 'formula-results-stale').message, /last calculation in Excel/);

  const n0 = h.panel.sent.length;
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original), 'undo is byte-identical to the original (G5)');
  assert.strictEqual(h.doc.version, 2);
  assert.strictEqual(h.doc.isDirty(), false);
  const types = h.panel.sent.slice(n0).map((m) => m.type);
  assert.ok(types.includes('xlsxStateChanged'), 'the grid is told to refetch');
  assert.deepStrictEqual(h.panel.last('xlsxStateChanged'), { type: 'xlsxStateChanged', version: 2, invalidate: 'workbook' });
  const undone = await cells(h, [0, 0, 5, 7]);
  assert.strictEqual(undone.get('1,6').v, 7, 'the refetched cells show the undone value (the model cache was invalidated)');

  await h.events[0].redo();
  assert.ok(same(h.doc.pkg.serialize(), edited));
  assert.strictEqual((await cells(h, [0, 0, 5, 7])).get('1,6').v, 99);
});

test('onEdited refreshes the model in place: undo/redo mixed with new edits keep the grid and the package consistent', async () => {
  ENABLE();
  const original = fixture('basic.xlsx');
  const h = await open('basic.xlsx');
  await cells(h, [0, 0, 20, 4]);                      // load the sheet into the model
  const modelBefore = h.provider.models.get(h.doc.pkg);
  assert.ok(modelBefore);
  await edit(h, setOp(1, [[1, 1, '100']]));            // edit 1
  await edit(h, setOp(1, [[2, 1, '200'], [30, 3, 'far']]));   // edit 2 grows the used range
  await edit(h, setOp(1, [[1, 1, '101']]));            // edit 3 on the same cell
  assert.strictEqual(h.events.length, 3);
  await h.events[2].undo();
  await h.events[1].undo();
  assert.strictEqual(h.provider.models.get(h.doc.pkg), modelBefore, 'the model is refreshed, not replaced (session sheet ids stay: K14)');
  let c = await cells(h, [0, 0, 40, 4]);
  assert.strictEqual(c.get('1,1').v, 100);
  assert.strictEqual(c.get('2,1').v, 3.14159, 'edit 2 undone');
  assert.ok(!c.has('30,3'));
  // A new edit after undo works on the refreshed model and the sheet is indexed correctly.
  const r = await edit(h, setOp(1, [[2, 1, '5']]));
  assert.strictEqual(r.ok, true);
  c = await cells(h, [0, 0, 40, 4]);
  assert.strictEqual(c.get('2,1').v, 5);
  await h.events[3].undo();
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original), 'everything undone is the original');
  c = await cells(h, [0, 0, 40, 4]);
  assert.strictEqual(c.get('1,1').v, 42);
});

test('save after edits passes verification, clears dirty, and the file re-opens with the new values (outputs for Excel)', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  await edit(h, setOp(1, [[1, 3, 'edited note'], [1, 4, '=B2+1'], [2, 1, '2.5'], [3, 1, 'true']]));
  await edit(h, { op: 'clearCells', sheetId: 1, range: [4, 0, 4, 2] });
  await h.doc.save(token);
  assert.strictEqual(h.doc.isDirty(), false);
  assert.ok(!S.messages.some((m) => m[0] === 'error'), 'no save error was shown');
  const saved = S.read(h.uri);
  assert.ok(saved && saved.length > 0);

  const h2 = await open('reopened.xlsx', saved);
  const c = await cells(h2, [0, 0, 6, 5]);
  assert.strictEqual(c.get('1,3').d, 'edited note');
  assert.strictEqual(c.get('1,4').f, true);
  assert.strictEqual(c.get('1,4').stale, true, 'an edited formula has no cached value: not calculated');
  assert.strictEqual(c.get('1,4').d, '=B2+1');
  assert.strictEqual(c.get('2,1').v, 2.5);
  assert.strictEqual(c.get('3,1').k, 'b');
  assert.ok(!c.has('4,0') && !c.has('4,1') && !c.has('4,2'), 'cleared');
  assert.strictEqual(c.get('5,1')?.v !== undefined || c.has('5,1'), true, 'neighbouring row intact');
  assert.strictEqual(await seed(h2, 1, 1, 4), '=B2+1');

  writeOut(OUT, 'saved-after-edits.xlsx', saved, [
    { sheet: 'Values', ref: 'D2', value: 'edited note' },
    { sheet: 'Values', ref: 'E2', value: 43 },
    { sheet: 'Values', ref: 'B3', value: 2.5 },
    { sheet: 'Values', ref: 'B4', value: true },
  ]);
});

test('undo after a save, then save again: both files verify and match the stack state', async () => {
  ENABLE();
  const original = fixture('basic.xlsx');
  const h = await open('basic.xlsx');
  await edit(h, setOp(1, [[1, 1, '1000']]));
  await h.doc.save(token);
  await h.events[0].undo();
  assert.strictEqual(h.doc.isDirty(), true);
  await h.doc.save(token);
  const h2 = await open('again.xlsx', S.read(h.uri));
  assert.strictEqual((await cells(h2, [0, 0, 3, 3])).get('1,1').v, 42);
  writeOut(OUT, 'saved-after-undo.xlsx', S.read(h.uri), [{ sheet: 'Values', ref: 'B2', value: 42 }]);
  void original;
});

test('shared-formula dependant: the seed is the translated formula; committing it unchanged is a no-op; editing it works', async () => {
  ENABLE();
  const h = await open('formulas.xlsx');
  assert.strictEqual(await seed(h, 1, 1, 1), '=A2*2', 'master');
  assert.strictEqual(await seed(h, 1, 2, 1), '=A3*2', 'dependant: not the cached value');
  assert.strictEqual(await seed(h, 1, 3, 1), '=A4*2');
  const bytes = h.doc.pkg.serialize();
  const r = await edit(h, setOp(1, [[2, 1, '=A3*2']]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.events.length, 0, 'unchanged commit records nothing');
  assert.strictEqual(h.doc.version, 0);
  assert.ok(same(h.doc.pkg.serialize(), bytes));
  const r2 = await edit(h, setOp(1, [[2, 1, '=A3*3']]));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(await seed(h, 1, 2, 1), '=A3*3');
  assert.strictEqual(await seed(h, 1, 3, 1), '=A4*2', 'the rest of the group keeps its formulas');
  await h.events[0].undo();
  assert.strictEqual(await seed(h, 1, 2, 1), '=A3*2');
  assert.ok(same(h.doc.pkg.serialize(), bytes));
});

test('edited formula cells show "not calculated" (stale, formula text) and the file asks Excel to recalculate', async () => {
  ENABLE();
  const h = await open('formulas.xlsx');
  await edit(h, setOp(1, [[5, 5, '=SUM(A2:A4)']]));
  const c = await cells(h, [0, 0, 6, 7]);
  assert.strictEqual(c.get('5,5').stale, true);
  assert.strictEqual(c.get('5,5').f, true);
  assert.strictEqual(c.get('5,5').d, '=SUM(A2:A4)');
  const wbXml = h.doc.pkg.text('xl/workbook.xml');
  assert.match(wbXml, /fullCalcOnLoad="1"/);
});

test('Gate R2 F9: reopening a saved workbook (fullCalcOnLoad on) shows the stale banner and stale marks at once', async () => {
  ENABLE();
  const h = await open('formulas.xlsx');
  await edit(h, setOp(1, [[1, 6, '99']]));
  await h.provider.saveCustomDocument(h.doc, token);
  const saved = S.read(h.uri);
  assert.match(core.pkg.OfficePackage.open('x.xlsx', saved).text('xl/workbook.xml'), /fullCalcOnLoad="1"/);
  h.doc.dispose();
  // Reopen the saved file in a fresh session: nothing edited yet, but Excel has not recalculated.
  const r = await open('formulas.xlsx', saved, { editMode: false });
  const banner = await waitFor(() => r.panel.sent.find((m) => m.type === 'notices' && m.notices.some((n) => n.code === 'formula-results-stale')), 'stale banner');
  assert.ok(banner);
  const c = await cells(r, [0, 0, 5, 7]);
  assert.strictEqual(c.get('1,1').stale, true, 'formula cells are marked stale');
  assert.strictEqual(r.events.length, 0);
  // The untouched fixture (no fullCalcOnLoad) still shows neither.
  const plain = await open('formulas.xlsx', undefined, { editMode: false, uriName: 'plain.xlsx' });
  await cells(plain, [0, 0, 5, 7]);
  assert.ok(!plain.panel.sent.some((m) => m.type === 'notices' && m.notices.some((n) => n.code === 'formula-results-stale')));
  assert.ok(!(await cells(plain, [0, 0, 5, 7])).get('1,1').stale);
});

test('a rejected formula is answered with the position and changes nothing', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const before = h.doc.pkg.serialize();
  const r = await edit(h, setOp(1, [[1, 1, '=SUM(1,']]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'invalid');
  assert.match(r.error.message, /\(at (character \d+|the end of the formula)\)/);
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);
});

test('protected sheets, table headers and other read-only cells are refused and leave the package unchanged', async () => {
  ENABLE();
  const p = await open('protected-sheet.xlsx');
  await p.panel.send({ type: 'xlsxRequestSheetMeta', sheetId: 1 });   // loading the sheet reveals its protection
  await waitFor(() => p.panel.last('xlsxSheetMeta'), 'sheet meta');
  const wbMsg = p.panel.last('xlsxWorkbook');
  assert.strictEqual(wbMsg.sheets[0].readOnlyReason, 'protected');
  assert.strictEqual(wbMsg.sheets[0].canEdit, false);
  const pb = p.doc.pkg.serialize();
  const pr = await edit(p, setOp(1, [[2, 1, 'x']]));
  assert.strictEqual(pr.ok, false);
  assert.strictEqual(pr.error.code, 'read-only');
  assert.match(pr.error.message, /protected/);
  const cr = await edit(p, { op: 'clearCells', sheetId: 1, range: [0, 0, 5, 5] });
  assert.strictEqual(cr.ok, false);
  assert.ok(same(p.doc.pkg.serialize(), pb));

  const t = await open('tables.xlsx');
  const tb = t.doc.pkg.serialize();
  const hr = await edit(t, setOp(1, [[0, 0, 'Renamed header']]));
  assert.strictEqual(hr.ok, false);
  assert.strictEqual(hr.error.code, 'read-only');
  // A paste that touches a header cell is refused as a whole: the cells beside it are not written.
  const pr2 = await edit(t, setOp(1, [[1, 2, '1'], [0, 1, 'h']]));
  assert.strictEqual(pr2.ok, false);
  assert.ok(same(t.doc.pkg.serialize(), tb));
  assert.strictEqual(t.events.length, 0);
});

test('paste limits: 10,000 cells apply as one "Paste Cells" edit; 10,001 are refused by the host', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const grid = [];
  for (let r = 0; r < 100; r++) for (let c = 0; c < 100; c++) grid.push([20 + r, 10 + c, String(r * 100 + c)]);
  const ok = await edit(h, setOp(1, grid));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].label, 'Paste Cells');
  const bytes = h.doc.pkg.serialize();
  const too = [...grid, [200, 0, 'x']];
  const id = ++h.rid;
  await h.panel.send({ type: 'xlsxEdit', requestId: id, baseVersion: h.doc.version, edit: setOp(1, too) });
  const failed = await waitFor(() => h.panel.sent.find((m) => m.type === 'requestFailed' && m.requestId === id), 'requestFailed');
  assert.strictEqual(failed.error.code, 'invalid');
  assert.ok(same(h.doc.pkg.serialize(), bytes));
  assert.strictEqual(h.events.length, 1);
  await h.events[0].undo();
  assert.strictEqual(h.doc.isDirty(), false);
});

test('a stale baseVersion is answered "stale" and changes nothing; back-to-back edits run strictly in order', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const before = h.doc.pkg.serialize();
  const r = await edit(h, setOp(1, [[1, 1, '5']]), 99);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assert.ok(same(h.doc.pkg.serialize(), before));
  // Two edits posted without waiting: the second carries the version the first will produce.
  const a = ++h.rid, b = ++h.rid;
  h.panel.send({ type: 'xlsxEdit', requestId: a, baseVersion: 0, edit: setOp(1, [[1, 1, '11']]) });
  h.panel.send({ type: 'xlsxEdit', requestId: b, baseVersion: 1, edit: setOp(1, [[1, 1, '12']]) });
  await waitFor(() => h.panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === b), 'second result');
  const ra = h.panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === a);
  const rb = h.panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === b);
  assert.deepStrictEqual([ra.ok, rb.ok, ra.version, rb.version], [true, true, 1, 2]);
  assert.strictEqual(h.events.length, 2);
});

test('structural edits are rejected while xlsxStructure is off', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const before = h.doc.pkg.serialize();
  for (const op of [
    { op: 'insertRows', sheetId: 1, at: 2, count: 1 },
    { op: 'deleteCols', sheetId: 1, at: 0, count: 1 },
    { op: 'addSheet' },
    { op: 'renameSheet', sheetId: 1, name: 'X' },
    { op: 'deleteSheet', sheetId: 2 },
  ]) {
    const r = await edit(h, op);
    assert.strictEqual(r.ok, false, op.op);
    assert.strictEqual(r.error.code, 'blocked');
  }
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(S.messages.length, 0, 'no modal is shown for a rejected operation');
});

test('confirm flow: a Tier C list asks first (modal, lists what will not follow); Continue applies, otherwise nothing changes', async () => {
  ENABLE();
  host.OFFICE_FLAGS.xlsxStructure = true;
  const h = await open('basic.xlsx');
  const before = h.doc.pkg.serialize();
  S.answer = () => undefined;                                  // the user dismisses the modal
  const no = await edit(h, { op: 'deleteRows', sheetId: 1, at: 1, count: 1 });
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.error.code, 'cancelled');
  const modal = S.messages.find((m) => m[0] === 'warning');
  assert.ok(modal, 'a warning modal was shown');
  assert.strictEqual(modal[2].modal, true);
  assert.match(modal[2].detail, /Chart "Sales" will not be adjusted\./);
  assert.ok(same(h.doc.pkg.serialize(), before));
  assert.strictEqual(h.events.length, 0);

  S.messages.length = 0;
  S.answer = (_m, items) => items[0];                           // Continue
  const yes = await edit(h, { op: 'deleteRows', sheetId: 1, at: 1, count: 1 });
  assert.strictEqual(yes.ok, true);
  assert.strictEqual(yes.invalidate, 'sheet');
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].label, 'Delete Rows');
  assert.strictEqual(S.messages.filter((m) => m[0] === 'warning').length, 1, 'asked exactly once');
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), before));
  // The setting turns the prompt off for Tier C.
  S.messages.length = 0;
  S.config['vscodeMdEditor.office.confirmStructuralEdits'] = false;
  S.answer = () => { throw new Error('must not ask'); };
  const quiet = await edit(h, { op: 'deleteRows', sheetId: 1, at: 1, count: 1 });
  assert.strictEqual(quiet.ok, true);
  assert.strictEqual(S.messages.length, 0);
});

test('a confirmed edit whose document changed while the modal was open is answered "stale"', async () => {
  ENABLE();
  host.OFFICE_FLAGS.xlsxStructure = true;
  const h = await open('basic.xlsx');
  S.answer = () => { h.doc.version++; return 'Continue'; };     // an undo/redo happened meanwhile
  const r = await edit(h, { op: 'deleteRows', sheetId: 1, at: 1, count: 1 }, h.doc.version);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assert.strictEqual(h.events.length, 0);
});

test('recordApplied: an applied edit is registered for undo; if editing stopped meanwhile it is rolled back', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  const m = h.provider.model(h.doc);
  const original = h.doc.pkg.serialize();
  const op = setOp(1, [[1, 1, '77']]);
  const res = await core.xlsx.ops.applyXlsxEdit(m.wb, h.doc.pkg, op, { confirmed: false, styles: m.styles });
  assert.strictEqual(res.ok, true);
  assert.ok(!same(h.doc.pkg.serialize(), original), 'applyXlsxEdit already applied it');
  const rec = h.doc.recordApplied(res.edit, h.doc.pkg);
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.doc.version, 1);
  await h.events[0].undo();
  assert.ok(same(h.doc.pkg.serialize(), original));

  // Edit turned off between building and recording: nothing stays in the package without an undo entry.
  const m2 = h.provider.model(h.doc);               // undo refreshed the model in place (K14)
  assert.strictEqual(m2, m);
  const res2 = await core.xlsx.ops.applyXlsxEdit(m2.wb, h.doc.pkg, setOp(1, [[1, 1, '88']]), { confirmed: false, styles: m2.styles });
  assert.strictEqual(res2.ok, true);
  h.doc.setEditMode(false);
  const rec2 = h.doc.recordApplied(res2.edit, h.doc.pkg);
  assert.strictEqual(rec2.ok, false);
  assert.strictEqual(rec2.error.code, 'read-only');
  assert.ok(same(h.doc.pkg.serialize(), original), 'rolled back');
  assert.strictEqual(h.events.length, 1);
  // A null edit (nothing changed) records nothing.
  h.doc.setEditMode(true);
  assert.deepStrictEqual(h.doc.recordApplied(null, h.doc.pkg), { ok: true, edit: null });
});

test('a rich-text cell: the seed request is preceded by a notice the editor shows as a hint', async () => {
  ENABLE();
  const zip = await JSZip.loadAsync(fixture('basic.xlsx'));
  const sst = await zip.file('xl/sharedStrings.xml').async('string');
  assert.ok(sst.includes('<si><t>Kind</t></si>'));
  zip.file('xl/sharedStrings.xml', sst.replace('<si><t>Kind</t></si>', '<si><r><t>Ki</t></r><r><rPr><b/></rPr><t>nd</t></r></si>'));
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const h = await open('rich.xlsx', bytes);
  const n0 = h.panel.sent.length;
  assert.strictEqual(await seed(h, 1, 0, 0), 'Kind');
  const after = h.panel.sent.slice(n0);
  const rich = after.find((m) => m.type === 'notices');
  assert.ok(rich.notices.some((n) => n.code === 'rich-text-cell'));
  assert.ok(after.indexOf(rich) < after.indexOf(after.find((m) => m.type === 'xlsxCellInput')), 'the notice comes first');
  // A plain cell sends none.
  const n1 = h.panel.sent.length;
  await seed(h, 1, 0, 1);
  assert.ok(!h.panel.sent.slice(n1).some((m) => m.type === 'notices'));
});

test('flush before save waits for edits already applied: the saved file holds the committed cell', async () => {
  ENABLE();
  const h = await open('basic.xlsx');
  await edit(h, setOp(1, [[1, 1, '314']]));
  await h.doc.save(token);
  assert.ok(h.panel.types().includes('flushPendingEdits'));
  const reopened = await open('flush.xlsx', S.read(h.uri));
  assert.strictEqual((await cells(reopened, [0, 0, 3, 3])).get('1,1').v, 314);
});
