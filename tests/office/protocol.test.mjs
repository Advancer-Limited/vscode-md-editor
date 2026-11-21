// WP-07: protocol validators (src/office/protocol.ts). Spec §5. Node strips the types, so the
// source file is imported directly (protocol.ts has only erasable syntax and no runtime imports).
import { test } from 'node:test';
import assert from 'node:assert';
import * as P from '../../src/office/protocol.ts';

const { parseCommonToHost, parseDocxToHost, parseXlsxToHost, isOfficeToHost } = P;

const item = { kind: 'text', text: 'hi', b: false, i: true, u: false, src: 3 };
const R = [0, 0, 5, 5];

const docxOk = [
  { type: 'ready' }, { type: 'setEditMode', editMode: true }, { type: 'flushed', flushId: 4 },
  { type: 'openLink', href: 'https://example.com' }, { type: 'openExternally' }, { type: 'retry' },
  { type: 'writeClipboard', text: 'x' }, { type: 'showAbout' },
  { type: 'docxRequestRender' },
  { type: 'docxRequestBlockModel', requestId: 1, blockId: 2 },
  { type: 'docxEdit', requestId: 1, baseVersion: 0, edit: { op: 'commitParagraph', blockId: 2, items: [item, { kind: 'atom', id: 4 }, { kind: 'anchor', id: 5 }] } },
  { type: 'docxEdit', requestId: 1, baseVersion: 0, edit: { op: 'commitParagraph', blockId: 2, items: [{ ...item, src: null }] } },
  { type: 'docxEdit', requestId: 2, baseVersion: 7, edit: { op: 'splitParagraph', blockId: 2, before: [item], after: [] } },
  { type: 'docxEdit', requestId: 3, baseVersion: 7, edit: { op: 'mergeWithPrevious', blockId: 2, items: [item] } },
  { type: 'docxEdit', requestId: 4, baseVersion: 7, edit: { op: 'insertParagraphAfter', blockId: null } },
  { type: 'docxEdit', requestId: 4, baseVersion: 7, edit: { op: 'insertParagraphAfter', blockId: 9 } },
  { type: 'docxEdit', requestId: 5, baseVersion: 7, edit: { op: 'removeParagraph', blockId: 2 } },
  { type: 'docxEdit', requestId: 6, baseVersion: 7, edit: { op: 'setStyle', blockIds: [1, 2], style: 'normal' } },
  { type: 'docxEdit', requestId: 6, baseVersion: 7, edit: { op: 'setStyle', blockIds: [1], style: { heading: 6 } } },
  { type: 'docxEdit', requestId: 7, baseVersion: 7, edit: { op: 'setList', blockIds: [1], list: 'bullet' } },
  { type: 'docxEdit', requestId: 8, baseVersion: 7, edit: { op: 'setListLevel', blockIds: [1], delta: -1 } },
];

const xlsxOk = [
  { type: 'ready' }, { type: 'showAbout' },
  { type: 'xlsxRequestSheetMeta', sheetId: 1 },
  { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 99, 99] },
  { type: 'xlsxRequestCellInput', requestId: 2, sheetId: 1, r: 3, c: 4 },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: '=A1' }, { r: 1, c: 1, input: '' }] } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'clearCells', sheetId: 1, range: R } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'insertRows', sheetId: 1, at: 2, count: 3 } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'deleteRows', sheetId: 1, at: 2, count: 3 } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'insertCols', sheetId: 1, at: 2, count: 3 } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'deleteCols', sheetId: 1, at: 2, count: 3 } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'addSheet' } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'addSheet', name: 'S', afterSheetId: 2 } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'renameSheet', sheetId: 1, name: 'New' } },
  { type: 'xlsxEdit', requestId: 3, baseVersion: 0, edit: { op: 'deleteSheet', sheetId: 1 } },
  { type: 'xlsxFind', requestId: 4, query: 'a', matchCase: false, sheetId: null },
  { type: 'xlsxFind', requestId: 4, query: 'a', matchCase: true, sheetId: 2 },
  { type: 'xlsxCopy', sheetId: 1, range: R, format: 'tsv' },
  { type: 'xlsxCopy', sheetId: 1, range: R, format: 'markdown' },
];

test('accepts every message shape in §5', () => {
  for (const m of docxOk) assert.deepStrictEqual(parseDocxToHost(m), m, JSON.stringify(m));
  for (const m of xlsxOk) assert.deepStrictEqual(parseXlsxToHost(m), m, JSON.stringify(m));
  for (const m of [...docxOk, ...xlsxOk].filter((x) => !/^(docx|xlsx)/.test(x.type))) {
    assert.deepStrictEqual(parseCommonToHost(m), m);
  }
  for (const m of [...docxOk, ...xlsxOk]) assert.ok(isOfficeToHost(m), m.type);
  assert.ok(!isOfficeToHost({ type: 'nope' }));
});

test('parsers drop unknown extra keys and never alias input arrays', () => {
  const m = { type: 'xlsxCopy', sheetId: 1, range: R, format: 'tsv', evil: 1 };
  const out = parseXlsxToHost(m);
  assert.ok(!('evil' in out));
  assert.notStrictEqual(out.range, m.range);
});

const big = (n) => Array.from({ length: n }, (_, i) => i);
const dEdit = (edit) => ({ type: 'docxEdit', requestId: 1, baseVersion: 0, edit });
const xEdit = (edit) => ({ type: 'xlsxEdit', requestId: 1, baseVersion: 0, edit });

const docxBad = [
  ['null', null], ['string', 'ready'], ['array', []], ['no type', {}], ['unknown type', { type: 'bogus' }],
  ['xlsx type on docx parser', { type: 'xlsxCopy', sheetId: 1, range: R, format: 'tsv' }],
  ['non-integer requestId', { type: 'docxRequestBlockModel', requestId: 1.5, blockId: 1 }],
  ['negative blockId', { type: 'docxRequestBlockModel', requestId: 1, blockId: -1 }],
  ['string blockId', { type: 'docxRequestBlockModel', requestId: 1, blockId: '1' }],
  ['NaN blockId', { type: 'docxRequestBlockModel', requestId: 1, blockId: NaN }],
  ['Infinity requestId', { type: 'docxRequestBlockModel', requestId: Infinity, blockId: 1 }],
  ['unsafe integer', { type: 'docxRequestBlockModel', requestId: 2 ** 60, blockId: 1 }],
  ['non-integer baseVersion', { ...dEdit({ op: 'removeParagraph', blockId: 1 }), baseVersion: 0.5 }],
  ['negative baseVersion', { ...dEdit({ op: 'removeParagraph', blockId: 1 }), baseVersion: -1 }],
  ['missing edit', { type: 'docxEdit', requestId: 1, baseVersion: 0 }],
  ['unknown op', dEdit({ op: 'explode', blockId: 1 })],
  ['setCells op on docx', dEdit({ op: 'setCells' })],
  ['commit non-integer blockId', dEdit({ op: 'commitParagraph', blockId: 1.2, items: [] })],
  ['commit items not array', dEdit({ op: 'commitParagraph', blockId: 1, items: 'x' })],
  ['commit item unknown kind', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ kind: 'img' }] })],
  ['commit item text missing b', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ kind: 'text', text: 'a', i: false, u: false, src: null }] })],
  ['commit item src undefined', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ kind: 'text', text: 'a', b: false, i: false, u: false }] })],
  ['commit item src negative', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ ...item, src: -2 }] })],
  ['commit item text number', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ ...item, text: 5 }] })],
  ['commit atom fractional id', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ kind: 'atom', id: 0.1 }] })],
  ['commit anchor missing id', dEdit({ op: 'commitParagraph', blockId: 1, items: [{ kind: 'anchor' }] })],
  ['commit item null', dEdit({ op: 'commitParagraph', blockId: 1, items: [null] })],
  ['commit oversized items', dEdit({ op: 'commitParagraph', blockId: 1, items: new Array(200001).fill({ kind: 'anchor', id: 1 }) })],
  ['split missing after', dEdit({ op: 'splitParagraph', blockId: 1, before: [] })],
  ['merge items missing', dEdit({ op: 'mergeWithPrevious', blockId: 1 })],
  ['insertAfter undefined blockId', dEdit({ op: 'insertParagraphAfter' })],
  ['insertAfter negative', dEdit({ op: 'insertParagraphAfter', blockId: -3 })],
  ['remove string id', dEdit({ op: 'removeParagraph', blockId: 'a' })],
  ['setStyle empty ids', dEdit({ op: 'setStyle', blockIds: [], style: 'normal' })],
  ['setStyle oversized ids', dEdit({ op: 'setStyle', blockIds: big(20001), style: 'normal' })],
  ['setStyle negative id', dEdit({ op: 'setStyle', blockIds: [1, -1], style: 'normal' })],
  ['setStyle heading 7', dEdit({ op: 'setStyle', blockIds: [1], style: { heading: 7 } })],
  ['setStyle heading 0', dEdit({ op: 'setStyle', blockIds: [1], style: { heading: 0 } })],
  ['setStyle heading fractional', dEdit({ op: 'setStyle', blockIds: [1], style: { heading: 1.5 } })],
  ['setStyle unknown string', dEdit({ op: 'setStyle', blockIds: [1], style: 'heading' })],
  ['setList unknown', dEdit({ op: 'setList', blockIds: [1], list: 'roman' })],
  ['setList ids not array', dEdit({ op: 'setList', blockIds: 1, list: 'none' })],
  ['setListLevel delta 2', dEdit({ op: 'setListLevel', blockIds: [1], delta: 2 })],
  ['setListLevel delta 0', dEdit({ op: 'setListLevel', blockIds: [1], delta: 0 })],
  ['setEditMode non-boolean', { type: 'setEditMode', editMode: 'yes' }],
  ['flushed missing id', { type: 'flushed' }],
  ['flushed negative', { type: 'flushed', flushId: -1 }],
  ['openLink non-string', { type: 'openLink', href: 5 }],
  ['openLink oversized', { type: 'openLink', href: 'h'.repeat(32768) }],
  ['writeClipboard missing', { type: 'writeClipboard' }],
];

const xlsxBad = [
  ['unknown type', { type: 'xlsxNope' }],
  ['docx type on xlsx parser', { type: 'docxRequestRender' }],
  ['sheetMeta fractional', { type: 'xlsxRequestSheetMeta', sheetId: 0.5 }],
  ['sheetMeta negative', { type: 'xlsxRequestSheetMeta', sheetId: -1 }],
  ['cells negative range', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [-1, 0, 5, 5] }],
  ['cells reversed rows', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [5, 0, 1, 5] }],
  ['cells reversed cols', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 5, 5, 1] }],
  ['cells short range', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 5] }],
  ['cells long range', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 5, 5, 5] }],
  ['cells non-array range', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: '0,0,5,5' }],
  ['cells fractional range', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 5.5, 5] }],
  ['cells row beyond grid', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 1048576, 0] }],
  ['cells col beyond grid', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 0, 16384] }],
  ['cells over 20,000 cells', { type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, 200, 100] }],
  ['cells missing requestId', { type: 'xlsxRequestCells', sheetId: 1, range: R }],
  ['cellInput negative r', { type: 'xlsxRequestCellInput', requestId: 1, sheetId: 1, r: -1, c: 0 }],
  ['cellInput col beyond grid', { type: 'xlsxRequestCellInput', requestId: 1, sheetId: 1, r: 0, c: 16384 }],
  ['edit unknown op', xEdit({ op: 'explode' })],
  ['edit docx op on xlsx', xEdit({ op: 'commitParagraph', blockId: 1, items: [] })],
  ['edit non-integer requestId', { ...xEdit({ op: 'deleteSheet', sheetId: 1 }), requestId: 1.1 }],
  ['edit negative baseVersion', { ...xEdit({ op: 'deleteSheet', sheetId: 1 }), baseVersion: -1 }],
  ['setCells empty', xEdit({ op: 'setCells', sheetId: 1, cells: [] })],
  ['setCells > 10,000 cells', xEdit({ op: 'setCells', sheetId: 1, cells: Array.from({ length: 10001 }, () => ({ r: 0, c: 0, input: 'a' })) })],
  ['setCells input > 32,767 chars', xEdit({ op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: 'x'.repeat(32768) }] })],
  ['setCells input number', xEdit({ op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0, input: 5 }] })],
  ['setCells negative r', xEdit({ op: 'setCells', sheetId: 1, cells: [{ r: -1, c: 0, input: '' }] })],
  ['setCells fractional c', xEdit({ op: 'setCells', sheetId: 1, cells: [{ r: 0, c: 0.5, input: '' }] })],
  ['setCells cells not array', xEdit({ op: 'setCells', sheetId: 1, cells: {} })],
  ['setCells null cell', xEdit({ op: 'setCells', sheetId: 1, cells: [null] })],
  ['clearCells reversed', xEdit({ op: 'clearCells', sheetId: 1, range: [3, 3, 1, 1] })],
  ['clearCells negative', xEdit({ op: 'clearCells', sheetId: 1, range: [0, -1, 1, 1] })],
  ['insertRows count 0', xEdit({ op: 'insertRows', sheetId: 1, at: 0, count: 0 })],
  ['insertRows negative at', xEdit({ op: 'insertRows', sheetId: 1, at: -1, count: 1 })],
  ['deleteRows count negative', xEdit({ op: 'deleteRows', sheetId: 1, at: 0, count: -2 })],
  ['deleteRows count huge', xEdit({ op: 'deleteRows', sheetId: 1, at: 0, count: 2 ** 40 })],
  ['insertCols count fractional', xEdit({ op: 'insertCols', sheetId: 1, at: 0, count: 1.5 })],
  ['deleteCols at beyond grid', xEdit({ op: 'deleteCols', sheetId: 1, at: 16384, count: 1 })],
  ['addSheet name number', xEdit({ op: 'addSheet', name: 5 })],
  ['addSheet afterSheetId negative', xEdit({ op: 'addSheet', afterSheetId: -1 })],
  ['renameSheet missing name', xEdit({ op: 'renameSheet', sheetId: 1 })],
  ['deleteSheet fractional', xEdit({ op: 'deleteSheet', sheetId: 0.1 })],
  ['find query non-string', { type: 'xlsxFind', requestId: 1, query: 1, matchCase: false, sheetId: null }],
  ['find query oversized', { type: 'xlsxFind', requestId: 1, query: 'q'.repeat(32768), matchCase: false, sheetId: null }],
  ['find matchCase non-boolean', { type: 'xlsxFind', requestId: 1, query: 'q', matchCase: 0, sheetId: null }],
  ['find sheetId undefined', { type: 'xlsxFind', requestId: 1, query: 'q', matchCase: false }],
  ['find sheetId negative', { type: 'xlsxFind', requestId: 1, query: 'q', matchCase: false, sheetId: -1 }],
  ['copy bad format', { type: 'xlsxCopy', sheetId: 1, range: R, format: 'csv' }],
  ['copy reversed range', { type: 'xlsxCopy', sheetId: 1, range: [2, 2, 1, 1], format: 'tsv' }],
];

test('rejects non-integer ids, negative ranges, oversized arrays, unknown type/op (docx side)', () => {
  assert.ok(docxBad.length >= 20);
  for (const [name, m] of docxBad) assert.strictEqual(parseDocxToHost(m), null, name);
});

test('rejects non-integer ids, negative ranges, oversized arrays, unknown type/op (xlsx side)', () => {
  assert.ok(xlsxBad.length >= 20);
  for (const [name, m] of xlsxBad) assert.strictEqual(parseXlsxToHost(m), null, name);
});

test('parsers never throw on hostile input', () => {
  const hostile = [undefined, 0, NaN, true, () => 1, Symbol('x'), Object.create(null), { type: {} }, { type: 'docxEdit', edit: { op: {} } }];
  for (const h of hostile) {
    assert.strictEqual(parseCommonToHost(h), null);
    assert.strictEqual(parseDocxToHost(h), null);
    assert.strictEqual(parseXlsxToHost(h), null);
  }
});

test('PROTOCOL_LIMITS match the caps documented in spec §5.2', () => {
  const L = P.PROTOCOL_LIMITS;
  assert.strictEqual(L.MAX_CELLS, 10000);
  assert.strictEqual(L.MAX_CELL_CHARS, 32767);
  assert.strictEqual(L.MAX_ROWS, 1048576);
  assert.strictEqual(L.MAX_COLS, 16384);
  assert.strictEqual(L.MAX_BLOCK_IDS, 20000);
  assert.strictEqual(L.MAX_COMMIT_ITEMS, 200000);
  assert.strictEqual(L.MAX_ITEM_TEXT, 10000000);
  assert.strictEqual(L.MAX_HREF, 32767);
  assert.strictEqual(L.MAX_CLIPBOARD, 50000000);
  assert.strictEqual(L.MAX_QUERY, 32767);
  // 20,000-cell window boundary: exactly 20,000 accepted, 20,001 rejected.
  const w = (r1, c1) => ({ type: 'xlsxRequestCells', requestId: 1, sheetId: 1, range: [0, 0, r1, c1] });
  assert.ok(parseXlsxToHost(w(199, 99)));
  assert.strictEqual(parseXlsxToHost(w(200, 99)), null);
});
