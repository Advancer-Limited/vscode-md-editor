// WP-14: Excel viewer view path. Pure pieces (core/xlsx/view.ts, find.ts, notices.ts) through the core
// test bundle; the provider glue (src/office/xlsxEditorProvider.ts) bundled with esbuild against the
// `vscode` stub, like tests/office/hostShell.test.mjs. Spec §5.2, §7.2, §9.2, §10.3.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import ExcelJS from 'exceljs';
import { core, fixture } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { StyleTable } = core.xlsx.styles;
const { cellWindow, sheetMeta, toTsv, clampRange } = core.xlsx.view;
const { findInWorkbook } = core.xlsx.find;
const { detectSheetNotices } = core.xlsx.notices;

function model(name, bytes = fixture(name)) {
  const wb = Workbook.load(OfficePackage.open(name, bytes));
  return { wb, styles: StyleTable.load(wb.pkg, wb.stylesPart, wb.themePart) };
}
const meta = (m, sheet, id = 1) => sheetMeta(m.wb, sheet, m.styles, id, 7);
const win = (m, sheet, range, staleAll = false) => cellWindow(m.wb, sheet, m.styles, range, staleAll);

// ---------------------------------------------------------------------------------------------
// Pure view code

test('cell window DTOs for styles.xlsx match the expected JSON', async () => {
  const m = model('styles.xlsx');
  const sheet = await m.wb.sheet(1);
  const w = win(m, sheet, [0, 0, 1, 3]);
  const font = { fontFamily: 'Aptos Narrow', color: '#000000' };
  assert.deepStrictEqual(w, {
    cells: [
      { r: 0, c: 0, d: 'Fonts', s: 2, k: 's' },
      { r: 1, c: 0, d: 'Bold', s: 1, k: 's' },
      { r: 1, c: 1, d: 'Italic', s: 3, k: 's' },
      { r: 1, c: 2, d: 'Underline', s: 4, k: 's' },
      { r: 1, c: 3, d: 'Strike', s: 5, k: 's' },
    ],
    styles: {
      1: { bold: true, fontSizePt: 11, ...font },
      2: { bold: true, fontSizePt: 14, ...font },
      3: { italic: true, fontSizePt: 11, ...font },
      4: { underline: true, fontSizePt: 11, ...font },
      5: { strike: true, fontSizePt: 11, ...font },
    },
  });
});

test('raw numeric v is set for n and d cells only; date-formatted numbers are kind d', async () => {
  const m = model('date1904.xlsx');
  const sheet = await m.wb.sheet(1);
  const cells = win(m, sheet, [0, 0, 5, 0]).cells;
  const d = cells.find((c) => c.r === 1);
  assert.deepStrictEqual(d, { r: 1, c: 0, d: '2024-03-15', s: 2, k: 'd', v: 43904 });   // serial as stored (1904 system)
  const text = cells.find((c) => c.k === 's');
  assert.ok(text && !('v' in text));
  const f = model('features.xlsx');
  const fs = await f.wb.sheet(1);
  const n = win(f, fs, [1, 1, 1, 1]).cells[0];
  assert.deepStrictEqual([n.k, n.v, n.d], ['n', 10, '10']);
});

test('formula, stale, ro, link and note flags', async () => {
  const f = model('formulas.xlsx');
  const data = await f.wb.sheet(1);
  const cells = win(f, data, [0, 0, 5, 5]).cells;
  const at = (r, c) => cells.find((x) => x.r === r && x.c === c);
  assert.strictEqual(at(1, 2).f, true);
  assert.strictEqual(at(1, 2).stale, undefined);            // cached value present
  assert.strictEqual(at(1, 4).ro, true);                    // legacy array member
  assert.strictEqual(at(2, 4).ro, true);                    // array member without a formula of its own
  // no cached value: formula text with the stale marker
  const nc = await f.wb.sheet(4);
  const [first] = win(f, nc, [0, 0, 0, 0]).cells;
  assert.deepStrictEqual(first, { r: 0, c: 0, d: '=1+1', s: 0, k: 'z', f: true, stale: true });
  // staleAll flags every formula cell, leaves plain cells alone
  const all = win(f, data, [0, 0, 5, 5], true).cells;
  assert.ok(all.filter((x) => x.f).every((x) => x.stale === true));
  assert.ok(all.filter((x) => !x.f).every((x) => x.stale === undefined));

  const ft = model('features.xlsx');
  const fs = await ft.wb.sheet(1);
  const fc = win(ft, fs, [0, 0, 5, 12]).cells;
  assert.strictEqual(fc.find((x) => x.r === 1 && x.c === 0).note, 'A note on Apples.');
  assert.strictEqual(fc.find((x) => x.r === 1 && x.c === 10).link, 'https://example.com/');
  assert.strictEqual(fc.find((x) => x.r === 2 && x.c === 10).link, "#'PivotData'!A1");

  const tb = model('tables.xlsx');
  const ts = await tb.wb.sheet(1);
  const tc = win(tb, ts, [0, 0, 1, 4]).cells;
  assert.ok(tc.filter((x) => x.r === 0).every((x) => x.ro === true), 'table header cells are locked');
  assert.ok(tc.filter((x) => x.r === 1).every((x) => x.ro === undefined));
});

test('meta has merges, frozen panes, hidden rows/cols, sparse sizes, min 100x26', async () => {
  const m = model('styles.xlsx');
  const sheet = await m.wb.sheet(1);
  const mt = meta(m, sheet);
  assert.strictEqual(mt.version, 7);
  assert.deepStrictEqual([mt.rowCount, mt.colCount], [100, 26]);
  assert.deepStrictEqual(mt.merges, [[13, 0, 13, 2], [12, 4, 14, 4], [15, 0, 16, 1]]);
  assert.deepStrictEqual([mt.frozenRows, mt.frozenCols], [1, 1]);
  assert.deepStrictEqual(mt.hiddenCols, [11]);
  assert.deepStrictEqual(mt.hiddenRows, [20]);
  assert.deepStrictEqual(mt.colWidthsPx[0], [0, 102]);
  assert.ok(mt.rowHeightsPx.some(([r, px]) => r === 10 && px === 133));
  assert.ok(mt.colWidthsPx.every(([c]) => c !== 11), 'hidden columns are not width overrides');
  assert.ok(mt.defaultColWidthPx > 0 && mt.defaultRowHeightPx > 0);
  // a sheet bigger than the minimum grows the counts
  const big = model('large.xlsx');
  const bs = await big.wb.sheet(1);
  const d = bs.dimensions();
  const bm = meta(big, bs);
  assert.strictEqual(bm.rowCount, Math.max(100, d.rows));
  assert.strictEqual(bm.colCount, Math.max(26, d.cols));
});

test('window includes styled empty cells and clampRange trims to the meta size', async () => {
  const m = model('styles.xlsx');
  const sheet = await m.wb.sheet(1);
  const w = win(m, sheet, [0, 0, 24, 11]);
  assert.ok(w.cells.length > 0);
  assert.ok(w.cells.every((c) => c.s in w.styles));
  const mt = meta(m, sheet);
  assert.deepStrictEqual(clampRange(mt, [90, 20, 500, 500]), [90, 20, 99, 25]);
  assert.strictEqual(clampRange(mt, [100, 0, 120, 3]), null);
  assert.strictEqual(clampRange(mt, [0, 26, 3, 30]), null);
});

test('toTsv: display strings, tabs and newlines, Excel-style quoting', async () => {
  const m = model('styles.xlsx');
  const sheet = await m.wb.sheet(1);
  assert.strictEqual(toTsv(m.wb, sheet, m.styles, [0, 0, 1, 3]), 'Fonts\t\t\t\nBold\tItalic\tUnderline\tStrike');
  assert.strictEqual(toTsv(m.wb, sheet, m.styles, [500, 0, 600, 3]), '');
  // quoting through a generated workbook
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('S');
  ws.getCell('A1').value = 'a\tb';
  ws.getCell('B1').value = 'say "hi"';
  ws.getCell('A2').value = 'two\nlines';
  ws.getCell('B2').value = 12.5;
  const bytes = new Uint8Array(await wbk.xlsx.writeBuffer());
  const q = model('q.xlsx', bytes);
  const qs = await q.wb.sheet(1);
  assert.strictEqual(toTsv(q.wb, qs, q.styles, [0, 0, 1, 1]), '"a\tb"\t"say ""hi"""\n"two\nlines"\t12.5');
});

test('empty cells inside a range hyperlink carry the link', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fixture('features.xlsx'));
  const part = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(part).async('string');
  assert.ok(xml.includes('ref="K2"'));
  zip.file(part, xml.replace('ref="K2"', 'ref="K2:M5"'));
  const m = model('features.xlsx', new Uint8Array(await zip.generateAsync({ type: 'uint8array' })));
  const s = await m.wb.sheet(1);
  assert.strictEqual(s.cell(4, 12), undefined, 'M5 is empty');
  const cells = win(m, s, [0, 0, 6, 14]).cells;
  assert.strictEqual(cells.find((x) => x.r === 4 && x.c === 12)?.link, 'https://example.com/');
  assert.strictEqual(cells.find((x) => x.r === 5 && x.c === 12)?.link, undefined, 'outside the range');
});

/** A workbook with only `cells` ({ A1: value }) on one sheet. */
async function sparseModel(cells) {
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('S');
  for (const [a1, v] of Object.entries(cells)) ws.getCell(a1).value = v;
  return model('sparse.xlsx', new Uint8Array(await wbk.xlsx.writeBuffer()));
}

test('S2 toTsv: trims the end to the last stored cell, keeps the start, refuses over the cell budget', async () => {
  const { TSV_MAX_CELLS, CopyTooLargeError } = core.xlsx.view;
  const m = await sparseModel({ B2: 'x', D3: 'y' });
  const s = await m.wb.sheet(1);
  // Selection far past the data: trimmed to D3, starting at A1 so a paste lines up.
  assert.strictEqual(toTsv(m.wb, s, m.styles, [0, 0, 999, 99]), '\t\t\t\n\tx\t\t\n\t\t\ty');
  // A1 + XFD3000: 3000 x 16384 cells, refused quickly instead of building ~50M fields.
  const big = await sparseModel({ A1: 1, XFD3000: 2 });
  const bs = await big.wb.sheet(1);
  const t0 = Date.now();
  assert.throws(() => toTsv(big.wb, bs, big.styles, [0, 0, 1_048_575, 16_383]),
    (e) => e instanceof CopyTooLargeError && e.cells === 3000 * 16384 && e.cells > TSV_MAX_CELLS);
  assert.ok(Date.now() - t0 < 500, 'refusal is cheap');
  // A selection that stays inside the budget still copies.
  assert.strictEqual(toTsv(big.wb, bs, big.styles, [0, 0, 0, 2]), '1');
});

test('find is capped at 1,000 matches and reports truncated', async () => {
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('Big');
  for (let r = 1; r <= 1200; r++) ws.getCell(r, 1).value = `Match ${r}`;
  ws.getCell(1, 2).value = { formula: 'UPPER("zzz")', result: 'ZZZ' };
  const bytes = new Uint8Array(await wbk.xlsx.writeBuffer());
  const m = model('big.xlsx', bytes);
  const res = await findInWorkbook(m.wb, 'match', false, null, m.styles);
  assert.strictEqual(res.matches.length, 1000);
  assert.strictEqual(res.truncated, true);
  assert.deepStrictEqual(res.matches[0], { sheetId: 1, r: 0, c: 0 });
  const cs = await findInWorkbook(m.wb, 'match', true, 1, m.styles);   // case-sensitive: no lowercase "match"
  assert.deepStrictEqual(cs, { matches: [], truncated: false });
  const few = await findInWorkbook(m.wb, 'Match 12', true, 1, m.styles);
  assert.strictEqual(few.truncated, false);
  assert.strictEqual(few.matches.length, 12);                           // Match 12, 120-129, 1200
});

test('find covers display strings, formula text and all sheets', async () => {
  const m = model('formulas.xlsx');
  const byFormula = await findInWorkbook(m.wb, 'sum(', false, null);
  assert.ok(byFormula.matches.length >= 1);
  assert.ok(byFormula.matches.some((x) => x.sheetId === 4 && x.r === 3), 'finds =SUM(...) on NoCache (no cached value)');
  const one = await findInWorkbook(m.wb, 'sum(', false, 1);
  assert.ok(one.matches.every((x) => x.sheetId === 1));
  assert.deepStrictEqual(await findInWorkbook(m.wb, '', false, null), { matches: [], truncated: false });
  const shown = await findInWorkbook(model('features.xlsx').wb, 'apples', false, null);
  assert.deepStrictEqual(shown.matches.length, 1);
});

test('notices name charts, images, pivot, sparklines, CF and DV for features.xlsx', async () => {
  const m = model('features.xlsx');
  const features = detectSheetNotices(m.wb, await m.wb.sheet(1));
  const text = features.map((n) => n.message).join(' | ');
  for (const word of ['1 chart', '1 image', '3 sparklines', 'conditional formatting', 'data validation']) {
    assert.ok(text.includes(word), `${word} in: ${text}`);
  }
  assert.ok(features.every((n) => n.severity === 'info' && typeof n.code === 'string'));
  assert.deepStrictEqual(detectSheetNotices(m.wb, await m.wb.sheet(2)), []);
  const pivot = detectSheetNotices(m.wb, await m.wb.sheet(3));
  assert.ok(pivot.some((n) => n.message.includes('1 pivot table')));
  // sheetMeta carries them
  assert.deepStrictEqual(meta(m, await m.wb.sheet(1)).notices, features);
  // clean sheets have none
  const b = model('basic.xlsx');
  assert.deepStrictEqual(detectSheetNotices(b.wb, await b.wb.sheet(1)), []);
});

// ---------------------------------------------------------------------------------------------
// Provider glue

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-xlsx.cjs');
  await esbuild.build({
    stdin: {
      contents: "export * from './src/office/xlsxEditorProvider.ts';\nexport * from './src/office/officeDocument.ts';",
      resolveDir: root, sourcefile: 'office-host-xlsx-entry.ts', loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{
      name: 'vscode-stub',
      setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); },
    }],
  });
  host = require(outfile);
  host.OfficeDocument.diskCheckDelayMs = 0;
});

beforeEach(() => S.reset());

const ctx = {
  extensionUri: vscode.Uri.file('/ext'),
  extension: { packageJSON: { name: 'x', displayName: 'X', version: '0.0.0', description: '' } },
  subscriptions: [],
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function makePanel() {
  const sent = [];
  let onMsg = () => {};
  return {
    sent,
    webview: {
      options: {}, html: '', cspSource: 'https://csp.example',
      asWebviewUri: (u) => ({ toString: () => 'https://webview' + u.path }),
      postMessage: async (m) => { sent.push(m); return true; },
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
    send: (raw) => onMsg(raw),
    last: (type) => [...sent].reverse().find((m) => m.type === type),
    all: (type) => sent.filter((m) => m.type === type),
  };
}

async function open(name, bytes = fixture(name)) {
  const uri = vscode.Uri.file(`/ws/${name}`);
  S.writeFile(uri, bytes, 1000);
  const provider = new host.XlsxEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  return { provider, doc, panel };
}

async function waitFor(cond, what) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('timed out waiting for ' + what);
}

/** Send a message and wait for the reply of the given type (nth = how many of that type must exist). */
async function ask(panel, msg, type, nth = 1) {
  const before = panel.all(type).length;
  panel.send(msg);
  await waitFor(() => panel.all(type).length >= before + 1 && panel.all(type).length >= nth, type);
  return panel.last(type);
}

test('registration: xlsx viewType, own find (no find widget), one editor per document', () => {
  host.XlsxEditorProvider.register(ctx);
  assert.strictEqual(S.registered.length, 1);
  assert.strictEqual(S.registered[0].viewType, 'vscodeMdEditor.xlsx');
  assert.deepStrictEqual(S.registered[0].options, {
    webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
    supportsMultipleEditorsPerDocument: false,
  });
});

test('HTML: scripts in order with nonce, ?v=, CSP without blob/data, sheetAppearance from settings', async () => {
  const { panel } = await open('basic.xlsx');
  const html = panel.webview.html;
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  assert.ok(!csp.includes('blob:') && !csp.includes('data:'));
  const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
  const scripts = [...html.matchAll(/<script nonce="([^"]+)" src="https:\/\/webview\/ext\/media\/([^?"]+)\?v=\d+"/g)];
  assert.deepStrictEqual(scripts.map((m) => m[2]), ['officeCommon.js', 'xlsxGridMath.js', 'xlsxGrid.js', 'xlsxEditor.js', 'xlsxCellEditor.js']);
  assert.ok(scripts.every((m) => m[1] === nonce));
  assert.ok(html.includes('xlsxEditor.css?v=') && html.includes('officeCommon.css?v='));
  assert.ok(html.includes('data-office-kind="xlsx"'));
  assert.ok(html.includes('data-sheet-appearance="theme"'));

  S.config['vscodeMdEditor.office.sheetAppearance'] = 'light';
  const light = await open('basic.xlsx');
  assert.ok(light.panel.webview.html.includes('data-sheet-appearance="light"'));
  S.config['vscodeMdEditor.office.sheetAppearance'] = '<script>';
  const bad = await open('basic.xlsx');
  assert.ok(bad.panel.webview.html.includes('data-sheet-appearance="theme"'));
});

test('ready: init (canEdit false, flags off) then xlsxWorkbook with sheet infos and active sheet', async () => {
  const { panel } = await open('formulas.xlsx');
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('xlsxWorkbook'), 'xlsxWorkbook');
  assert.strictEqual(panel.sent[0].type, 'init');
  assert.strictEqual(panel.sent[0].kind, 'xlsx');
  assert.strictEqual(panel.sent[0].canEdit, false);
  const wbm = panel.last('xlsxWorkbook');
  assert.strictEqual(wbm.version, 0);
  assert.deepStrictEqual(wbm.sheets.map((s) => [s.id, s.name, s.kind, s.state, s.canEdit]),
    [[1, 'Data', 'worksheet', 'visible', false], [2, 'My Sheet', 'worksheet', 'visible', false],
      [3, "O'Brien", 'worksheet', 'visible', false], [4, 'NoCache', 'worksheet', 'visible', false]]);
  assert.strictEqual(wbm.activeSheetId, 1);
});

test('tab switch: meta then cells (requests answered with the version they were built for)', async () => {
  const { panel } = await open('styles.xlsx');
  panel.send({ type: 'ready' });
  const m = await ask(panel, { type: 'xlsxRequestSheetMeta', sheetId: 1 }, 'xlsxSheetMeta');
  assert.strictEqual(m.meta.sheetId, 1);
  assert.deepStrictEqual(m.meta.merges[0], [13, 0, 13, 2]);
  const c = await ask(panel, { type: 'xlsxRequestCells', requestId: 5, sheetId: 1, range: [0, 0, 1, 3] }, 'xlsxCells');
  assert.strictEqual(c.requestId, 5);
  assert.strictEqual(c.version, 0);
  assert.deepStrictEqual(c.range, [0, 0, 1, 3]);
  assert.strictEqual(c.cells.length, 5);
  assert.deepStrictEqual(Object.keys(c.styles).sort(), ['1', '2', '3', '4', '5']);
});

test('stale responses carry the version they were built for', async () => {
  const { doc, panel } = await open('styles.xlsx');
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('xlsxWorkbook'), 'xlsxWorkbook');
  panel.send({ type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 1, 1] });
  panel.send({ type: 'xlsxRequestSheetMeta', sheetId: 1 });
  await doc.reload();                       // version 0 -> 1 while the requests are in flight
  assert.strictEqual(doc.version, 1);
  await waitFor(() => panel.last('xlsxCells') && panel.last('xlsxSheetMeta'), 'replies');
  assert.strictEqual(panel.last('xlsxCells').version, 0);
  assert.strictEqual(panel.last('xlsxSheetMeta').meta.version, 0);
  // the reload told the webview, and a request made now is answered for version 1
  assert.ok(panel.sent.some((m) => m.type === 'xlsxStateChanged' && m.version === 1 && m.invalidate === 'workbook'));
  const again = await ask(panel, { type: 'xlsxRequestCells', requestId: 2, sheetId: 1, range: [0, 0, 0, 0] }, 'xlsxCells', 2);
  assert.strictEqual(again.version, 1);
});

test('out-of-range and unknown requests fail with requestFailed (invalid)', async () => {
  const { panel } = await open('styles.xlsx');
  panel.send({ type: 'ready' });
  const f1 = await ask(panel, { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [200, 0, 210, 5] }, 'requestFailed');
  assert.deepStrictEqual([f1.requestId, f1.error.code], [1, 'invalid']);
  const f2 = await ask(panel, { type: 'xlsxRequestCells', requestId: 2, sheetId: 99, range: [0, 0, 1, 1] }, 'requestFailed', 2);
  assert.deepStrictEqual([f2.requestId, f2.error.code], [2, 'invalid']);
  const f3 = await ask(panel, { type: 'xlsxRequestCellInput', requestId: 3, sheetId: 1, r: 500, c: 0 }, 'requestFailed', 3);
  assert.deepStrictEqual([f3.requestId, f3.error.code], [3, 'invalid']);
  // malformed (over the 20,000-cell cap) is answered through replyInvalid
  const f4 = await ask(panel, { type: 'xlsxRequestCells', requestId: 4, sheetId: 1, range: [0, 0, 999, 99] }, 'requestFailed', 4);
  assert.deepStrictEqual([f4.requestId, f4.error.code], [4, 'invalid']);
  const f5 = await ask(panel, { type: 'xlsxFind', requestId: 5, query: 'x', matchCase: false, sheetId: 42 }, 'requestFailed', 5);
  assert.deepStrictEqual([f5.requestId, f5.error.code], [5, 'invalid']);
});

test('cell input seeds: formula text with =, ISO date, empty for no cell', async () => {
  const { panel } = await open('formulas.xlsx');
  panel.send({ type: 'ready' });
  const f = await ask(panel, { type: 'xlsxRequestCellInput', requestId: 1, sheetId: 4, r: 0, c: 0 }, 'xlsxCellInput');
  assert.deepStrictEqual([f.requestId, f.sheetId, f.r, f.c, f.input], [1, 4, 0, 0, '=1+1']);
  const e = await ask(panel, { type: 'xlsxRequestCellInput', requestId: 2, sheetId: 4, r: 50, c: 5 }, 'xlsxCellInput', 2);
  assert.strictEqual(e.input, '');
});

test('xlsxFind through the provider; xlsxEdit is refused while the flag is off', async () => {
  const { panel } = await open('features.xlsx');
  panel.send({ type: 'ready' });
  const r = await ask(panel, { type: 'xlsxFind', requestId: 9, query: 'pears', matchCase: false, sheetId: null }, 'xlsxFindResult');
  assert.deepStrictEqual(r, { type: 'xlsxFindResult', requestId: 9, matches: [{ sheetId: 1, r: 2, c: 0 }], truncated: false });
  const e = await ask(panel, {
    type: 'xlsxEdit', requestId: 10, baseVersion: 0, edit: { op: 'clearCells', sheetId: 1, range: [0, 0, 0, 0] },
  }, 'xlsxEditResult');
  assert.deepStrictEqual([e.requestId, e.ok, e.error.code], [10, false, 'read-only']);
});

test('xlsxCopy writes TSV to the clipboard; markdown is ignored', async () => {
  const { panel } = await open('styles.xlsx');
  panel.send({ type: 'ready' });
  panel.send({ type: 'xlsxCopy', sheetId: 1, range: [0, 0, 1, 3], format: 'markdown' });
  panel.send({ type: 'xlsxCopy', sheetId: 1, range: [0, 0, 1, 3], format: 'tsv' });
  await waitFor(() => S.clipboard !== undefined, 'clipboard');
  assert.strictEqual(S.clipboard, 'Fonts\t\t\t\nBold\tItalic\tUnderline\tStrike');
});

test('S2 xlsxCopy over the cell budget copies nothing and warns', async () => {
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('S');
  ws.getCell('A1').value = 1; ws.getCell('XFD3000').value = 2;
  const { panel } = await open('sparse.xlsx', new Uint8Array(await wbk.xlsx.writeBuffer()));
  panel.send({ type: 'ready' });
  panel.send({ type: 'xlsxCopy', sheetId: 1, range: [0, 0, 1_048_575, 16_383], format: 'tsv' });
  await waitFor(() => S.messages.length > 0, 'warning');
  assert.strictEqual(S.clipboard, undefined);
  assert.strictEqual(S.messages[0][0], 'warning');
  assert.match(S.messages[0][1], /Nothing was copied/);
});

test('S3 sheet meta is built once per (sheet, version), not per cell request', async () => {
  const { provider, doc, panel } = await open('styles.xlsx');
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('xlsxWorkbook'), 'xlsxWorkbook');
  const sheet = await provider.model(doc).wb.sheet(1);
  let walks = 0;
  const orig = sheet.rowIndices.bind(sheet);
  sheet.rowIndices = (...a) => { walks++; return orig(...a); };
  for (let i = 1; i <= 5; i++) {
    await ask(panel, { type: 'xlsxRequestCells', requestId: i, sheetId: 1, range: [0, 0, 1, 1] }, 'xlsxCells', i);
  }
  const m = await ask(panel, { type: 'xlsxRequestSheetMeta', sheetId: 1 }, 'xlsxSheetMeta');
  assert.strictEqual(walks, 1, 'one row walk for five cell requests and a meta request');
  assert.strictEqual(m.meta.version, 0);
});

test('a newer find cancels the one still running (each still gets one reply)', async () => {
  const { findInWorkbook } = core.xlsx.find;
  const m = model('styles.xlsx');
  let calls = 0;
  const res = await findInWorkbook(m.wb, 'a', false, null, m.styles, () => ++calls > 0);
  assert.deepStrictEqual(res, { matches: [], truncated: false, cancelled: true });
  // Through the provider: two finds back to back both get a reply; the second has the matches.
  const { panel } = await open('features.xlsx');
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('xlsxWorkbook'), 'xlsxWorkbook');
  panel.send({ type: 'xlsxFind', requestId: 1, query: 'pears', matchCase: false, sheetId: null });
  panel.send({ type: 'xlsxFind', requestId: 2, query: 'pears', matchCase: false, sheetId: null });
  await waitFor(() => panel.all('xlsxFindResult').length === 2, 'two replies');
  const r2 = panel.all('xlsxFindResult').find((x) => x.requestId === 2);
  assert.deepStrictEqual(r2.matches, [{ sheetId: 1, r: 2, c: 0 }]);
});

test('the sheet-unavailable warning is cleared once a sheet loads', async () => {
  const { panel } = await open('features.xlsx');
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('xlsxWorkbook'), 'xlsxWorkbook');
  await ask(panel, { type: 'xlsxRequestSheetMeta', sheetId: 99 }, 'notices');   // no such sheet
  assert.ok(panel.last('notices').notices.some((n) => n.code === 'sheet-unavailable'));
  await ask(panel, { type: 'xlsxRequestSheetMeta', sheetId: 1 }, 'xlsxSheetMeta');
  await waitFor(() => !panel.last('notices').notices.some((n) => n.code === 'sheet-unavailable'), 'cleared');
});

test('a malformed workbook part shows the error view instead of throwing', async () => {
  const bytes = fixture('basic.xlsx');
  const zip = core.zip.readZip(bytes, core.pkg.zipLimits());
  const items = zip.entries.map((e) => (e.name === 'xl/workbook.xml'
    ? { replace: e, data: new TextEncoder().encode('<notAWorkbook/>') } : { keep: e }));
  const broken = core.zip.writeZip(zip, items);
  const { panel } = await open('broken.xlsx', broken);
  panel.send({ type: 'ready' });
  await waitFor(() => panel.last('loadError'), 'loadError');
  assert.ok(!panel.last('xlsxWorkbook'));
});
