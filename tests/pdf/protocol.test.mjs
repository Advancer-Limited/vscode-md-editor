// PWP-04: PDF protocol validators (src/pdf/protocol.ts). Spec §5.
// Node strips the types; the source imports `../office/protocol.js`, which only exists as .ts, so a
// resolve hook maps relative `.js` specifiers to `.ts` when the .js file is missing.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\/.*\.js$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const P = await import('../../src/pdf/protocol.ts');
const { parsePdfToHost, isPdfToHost, PDF_PROTOCOL_LIMITS: L } = P;

const ref = { num: 12, gen: 0 };
const quad = [0, 0, 10, 0, 10, 10, 0, 10];
const hl = (o = {}) => ({ kind: 'highlight', localId: 1, page: 0, quads: quad, color: 'yellow', comment: '', ...o });
const ink = (o = {}) => ({ kind: 'ink', localId: 2, page: 3, paths: [[0, 0, 1, 1]], color: 'red', width: 2, comment: 'c', ...o });
const edit = (e, o = {}) => ({ type: 'pdfEdit', requestId: 1, baseVersion: 0, edit: e, ...o });
const facts = (o = {}) => ({ pageCount: 3, encrypted: false, hasText: true, hasJavaScript: false, hasXfa: false,
  attachmentCount: 0, signatures: [{ signer: 'A', reason: 'r', time: '2026-01-01' }], ...o });
const observed = (o = {}) => ({ pageCount: 2, annotsPerPage: [0, 1], fields: [{ ref, value: 'x' }], ...o });
const wr = (o = {}) => ({ type: 'pdfWriteResult', requestId: 1, ok: true, bytes: new Uint8Array(4), observed: observed(), ...o });

const ok = [
  { type: 'ready' }, { type: 'setEditMode', editMode: false }, { type: 'flushed', flushId: 1 },
  { type: 'openLink', href: 'https://example.com' }, { type: 'openExternally' }, { type: 'retry' },
  { type: 'writeClipboard', text: 'x' }, { type: 'showAbout' },
  { type: 'pdfRequestDocument' },
  { type: 'pdfFacts', facts: facts() },
  { type: 'pdfFacts', facts: facts({ signatures: [], pageCount: 0 }) },
  { type: 'pdfSaveAttachment', requestId: 4, name: 'a.txt', bytes: new Uint8Array(3) },
  { type: 'pdfSaveAttachment', requestId: 4, name: '', bytes: Buffer.from('abc') },
  edit({ op: 'addAnnotation', spec: hl() }),
  edit({ op: 'addAnnotation', spec: hl({ quads: [...quad, ...quad], color: 'pink', comment: 'é' }) }),
  edit({ op: 'addAnnotation', spec: ink() }),
  edit({ op: 'addAnnotation', spec: ink({ width: 4, paths: [[-5.5, 7], [1, 2, 3, 4], [9, 9]] }) }),
  edit({ op: 'updateAnnotation', localId: 1, patch: { comment: 'n' } }),
  edit({ op: 'updateAnnotation', localId: 1, patch: { color: 'green' } }),
  edit({ op: 'updateAnnotation', localId: 1, patch: { comment: '', color: 'blue' } }),
  edit({ op: 'removeAnnotation', target: { localId: 3 } }),
  edit({ op: 'removeAnnotation', target: { ref } }),
  edit({ op: 'setFields', values: [{ ref, value: 'text' }, { ref, value: true }, { ref, value: ['a', 'b'] }, { ref, value: [] }, { ref, value: '' }] }),
  wr(),
  { type: 'pdfWriteResult', requestId: 1, ok: false, message: 'boom' },
];

for (const m of ok) {
  test(`accepts ${m.type}${m.edit ? '/' + m.edit.op : ''}${m.ok === false ? '/fail' : ''}`, () => {
    const out = parsePdfToHost(m);
    assert.ok(out, 'accepted');
    assert.deepStrictEqual(out, m);
    assert.ok(isPdfToHost(out));
  });
}

test('unknown keys are dropped and the result is a rebuilt object', () => {
  const m = edit({ op: 'removeAnnotation', target: { localId: 3 }, junk: 1 }, { extra: 'x' });
  const out = parsePdfToHost(m);
  assert.deepStrictEqual(out, edit({ op: 'removeAnnotation', target: { localId: 3 } }));
  const f = parsePdfToHost({ type: 'pdfFacts', facts: { ...facts(), evil: 1 }, z: 1 });
  assert.deepStrictEqual(f, { type: 'pdfFacts', facts: facts() });
});

test('a returned array is a copy, not the caller\'s array', () => {
  const quads = quad.slice();
  const out = parsePdfToHost(edit({ op: 'addAnnotation', spec: hl({ quads }) }));
  assert.notStrictEqual(out.edit.spec.quads, quads);
});

const big = (n, v = 'a') => v.repeat(n);
const many = (n, f) => Array.from({ length: n }, f);
const zeros = (n) => new Array(n).fill(1);

const bad = {
  // envelope
  'null': null, 'undefined': undefined, 'string': 'pdfFacts', 'number': 5, 'array': [], 'no type': {}, 'type not string': { type: 5 },
  'unknown type': { type: 'pdfNope' }, 'host-only type': { type: 'pdfDocument' }, 'prototype key': { type: '__proto__' },
  // common messages still validated
  'openLink too long': { type: 'openLink', href: big(32768) },
  'setEditMode not bool': { type: 'setEditMode', editMode: 'yes' },
  'flushed negative': { type: 'flushed', flushId: -1 },
  // pdfFacts
  'facts missing': { type: 'pdfFacts' },
  'facts null': { type: 'pdfFacts', facts: null },
  'facts pageCount negative': { type: 'pdfFacts', facts: facts({ pageCount: -1 }) },
  'facts pageCount float': { type: 'pdfFacts', facts: facts({ pageCount: 1.5 }) },
  'facts pageCount huge': { type: 'pdfFacts', facts: facts({ pageCount: 100001 }) },
  'facts pageCount NaN': { type: 'pdfFacts', facts: facts({ pageCount: NaN }) },
  'facts encrypted string': { type: 'pdfFacts', facts: facts({ encrypted: 'no' }) },
  'facts hasText missing': { type: 'pdfFacts', facts: facts({ hasText: undefined }) },
  'facts hasXfa number': { type: 'pdfFacts', facts: facts({ hasXfa: 0 }) },
  'facts attachmentCount negative': { type: 'pdfFacts', facts: facts({ attachmentCount: -3 }) },
  'facts signatures not array': { type: 'pdfFacts', facts: facts({ signatures: {} }) },
  'facts too many signatures': { type: 'pdfFacts', facts: facts({ signatures: many(1001, () => ({ signer: 'a', reason: 'b', time: 'c' })) }) },
  'facts signer too long': { type: 'pdfFacts', facts: facts({ signatures: [{ signer: big(4097), reason: '', time: '' }] }) },
  'facts signature missing time': { type: 'pdfFacts', facts: facts({ signatures: [{ signer: 'a', reason: 'b' }] }) },
  'facts signature number reason': { type: 'pdfFacts', facts: facts({ signatures: [{ signer: 'a', reason: 1, time: '' }] }) },
  // pdfSaveAttachment
  'attachment no bytes': { type: 'pdfSaveAttachment', requestId: 1, name: 'a' },
  'attachment bytes array': { type: 'pdfSaveAttachment', requestId: 1, name: 'a', bytes: [1, 2] },
  'attachment bytes Buffer-JSON': { type: 'pdfSaveAttachment', requestId: 1, name: 'a', bytes: { type: 'Buffer', data: [1] } },
  'attachment bytes string': { type: 'pdfSaveAttachment', requestId: 1, name: 'a', bytes: 'abc' },
  'attachment Uint16Array': { type: 'pdfSaveAttachment', requestId: 1, name: 'a', bytes: new Uint16Array(2) },
  'attachment ArrayBuffer': { type: 'pdfSaveAttachment', requestId: 1, name: 'a', bytes: new ArrayBuffer(2) },
  'attachment name number': { type: 'pdfSaveAttachment', requestId: 1, name: 5, bytes: new Uint8Array(1) },
  'attachment name too long': { type: 'pdfSaveAttachment', requestId: 1, name: big(4097), bytes: new Uint8Array(1) },
  'attachment requestId missing': { type: 'pdfSaveAttachment', name: 'a', bytes: new Uint8Array(1) },
  'attachment requestId float': { type: 'pdfSaveAttachment', requestId: 0.5, name: 'a', bytes: new Uint8Array(1) },
  // pdfEdit envelope
  'edit no requestId': { type: 'pdfEdit', baseVersion: 0, edit: { op: 'removeAnnotation', target: { localId: 1 } } },
  'edit no baseVersion': { type: 'pdfEdit', requestId: 1, edit: { op: 'removeAnnotation', target: { localId: 1 } } },
  'edit negative baseVersion': edit({ op: 'removeAnnotation', target: { localId: 1 } }, { baseVersion: -1 }),
  'edit string requestId': edit({ op: 'removeAnnotation', target: { localId: 1 } }, { requestId: '1' }),
  'edit unsafe requestId': edit({ op: 'removeAnnotation', target: { localId: 1 } }, { requestId: 2 ** 60 }),
  'edit missing': { type: 'pdfEdit', requestId: 1, baseVersion: 0 },
  'edit unknown op': edit({ op: 'rotatePage', page: 0 }),
  'edit op not string': edit({ op: 7 }),
  // addAnnotation common
  'add no spec': edit({ op: 'addAnnotation' }),
  'add unknown kind': edit({ op: 'addAnnotation', spec: hl({ kind: 'stamp' }) }),
  'add bad color': edit({ op: 'addAnnotation', spec: hl({ color: 'orange' }) }),
  'add color missing': edit({ op: 'addAnnotation', spec: hl({ color: undefined }) }),
  'add comment number': edit({ op: 'addAnnotation', spec: hl({ comment: 1 }) }),
  'add comment too long': edit({ op: 'addAnnotation', spec: hl({ comment: big(L.MAX_COMMENT + 1) }) }),
  'add localId negative': edit({ op: 'addAnnotation', spec: hl({ localId: -1 }) }),
  'add localId string': edit({ op: 'addAnnotation', spec: hl({ localId: '1' }) }),
  'add page negative': edit({ op: 'addAnnotation', spec: hl({ page: -1 }) }),
  'add page at limit': edit({ op: 'addAnnotation', spec: hl({ page: 100000 }) }),
  'add page float': edit({ op: 'addAnnotation', spec: hl({ page: 0.5 }) }),
  'add page NaN': edit({ op: 'addAnnotation', spec: hl({ page: NaN }) }),
  // highlight geometry
  'hl quads empty': edit({ op: 'addAnnotation', spec: hl({ quads: [] }) }),
  'hl quads not array': edit({ op: 'addAnnotation', spec: hl({ quads: '0,0' }) }),
  'hl quads 7 numbers': edit({ op: 'addAnnotation', spec: hl({ quads: quad.slice(0, 7) }) }),
  'hl quads 9 numbers': edit({ op: 'addAnnotation', spec: hl({ quads: [...quad, 1] }) }),
  'hl quads too many': edit({ op: 'addAnnotation', spec: hl({ quads: zeros((L.MAX_QUADS + 1) * 8) }) }),
  'hl quad NaN': edit({ op: 'addAnnotation', spec: hl({ quads: [NaN, ...quad.slice(1)] }) }),
  'hl quad Infinity': edit({ op: 'addAnnotation', spec: hl({ quads: [Infinity, ...quad.slice(1)] }) }),
  'hl quad out of range': edit({ op: 'addAnnotation', spec: hl({ quads: [100001, ...quad.slice(1)] }) }),
  'hl quad out of range negative': edit({ op: 'addAnnotation', spec: hl({ quads: [-100001, ...quad.slice(1)] }) }),
  'hl quad string': edit({ op: 'addAnnotation', spec: hl({ quads: ['1', ...quad.slice(1)] }) }),
  'hl quad null': edit({ op: 'addAnnotation', spec: hl({ quads: [null, ...quad.slice(1)] }) }),
  // ink geometry
  'ink width 3': edit({ op: 'addAnnotation', spec: ink({ width: 3 }) }),
  'ink width string': edit({ op: 'addAnnotation', spec: ink({ width: '2' }) }),
  'ink width missing': edit({ op: 'addAnnotation', spec: ink({ width: undefined }) }),
  'ink paths empty': edit({ op: 'addAnnotation', spec: ink({ paths: [] }) }),
  'ink paths not array': edit({ op: 'addAnnotation', spec: ink({ paths: 'x' }) }),
  'ink too many strokes': edit({ op: 'addAnnotation', spec: ink({ paths: many(L.MAX_STROKES + 1, () => [0, 0]) }) }),
  'ink stroke empty': edit({ op: 'addAnnotation', spec: ink({ paths: [[]] }) }),
  'ink stroke odd length': edit({ op: 'addAnnotation', spec: ink({ paths: [[0, 0, 1]] }) }),
  'ink stroke not array': edit({ op: 'addAnnotation', spec: ink({ paths: [{}] }) }),
  'ink stroke too many points': edit({ op: 'addAnnotation', spec: ink({ paths: [zeros((L.MAX_POINTS_PER_STROKE + 1) * 2)] }) }),
  'ink coord NaN': edit({ op: 'addAnnotation', spec: ink({ paths: [[0, NaN]] }) }),
  'ink coord out of range': edit({ op: 'addAnnotation', spec: ink({ paths: [[0, 0], [1e6, 0]] }) }),
  'ink coord string': edit({ op: 'addAnnotation', spec: ink({ paths: [['0', 0]] }) }),
  // updateAnnotation
  'update no patch': edit({ op: 'updateAnnotation', localId: 1 }),
  'update empty patch': edit({ op: 'updateAnnotation', localId: 1, patch: {} }),
  'update patch only unknown key': edit({ op: 'updateAnnotation', localId: 1, patch: { quads: [] } }),
  'update patch array': edit({ op: 'updateAnnotation', localId: 1, patch: [] }),
  'update bad color': edit({ op: 'updateAnnotation', localId: 1, patch: { color: 'black' } }),
  'update comment too long': edit({ op: 'updateAnnotation', localId: 1, patch: { comment: big(L.MAX_COMMENT + 1) } }),
  'update comment number': edit({ op: 'updateAnnotation', localId: 1, patch: { comment: 3 } }),
  'update localId missing': edit({ op: 'updateAnnotation', patch: { comment: 'a' } }),
  'update localId negative': edit({ op: 'updateAnnotation', localId: -2, patch: { comment: 'a' } }),
  // removeAnnotation
  'remove no target': edit({ op: 'removeAnnotation' }),
  'remove empty target': edit({ op: 'removeAnnotation', target: {} }),
  'remove both targets': edit({ op: 'removeAnnotation', target: { localId: 1, ref } }),
  'remove localId negative': edit({ op: 'removeAnnotation', target: { localId: -1 } }),
  'remove localId string': edit({ op: 'removeAnnotation', target: { localId: 'a' } }),
  'remove ref num 0': edit({ op: 'removeAnnotation', target: { ref: { num: 0, gen: 0 } } }),
  'remove ref num negative': edit({ op: 'removeAnnotation', target: { ref: { num: -1, gen: 0 } } }),
  'remove ref gen too big': edit({ op: 'removeAnnotation', target: { ref: { num: 1, gen: 65536 } } }),
  'remove ref num too big': edit({ op: 'removeAnnotation', target: { ref: { num: 2 ** 31, gen: 0 } } }),
  'remove ref num float': edit({ op: 'removeAnnotation', target: { ref: { num: 1.5, gen: 0 } } }),
  'remove ref missing gen': edit({ op: 'removeAnnotation', target: { ref: { num: 1 } } }),
  'remove ref not object': edit({ op: 'removeAnnotation', target: { ref: 12 } }),
  // setFields
  'fields missing': edit({ op: 'setFields' }),
  'fields empty': edit({ op: 'setFields', values: [] }),
  'fields not array': edit({ op: 'setFields', values: {} }),
  'fields too many': edit({ op: 'setFields', values: many(L.MAX_FIELDS_PER_SET + 1, () => ({ ref, value: 'a' })) }),
  'fields entry not object': edit({ op: 'setFields', values: ['a'] }),
  'fields entry no ref': edit({ op: 'setFields', values: [{ value: 'a' }] }),
  'fields entry bad ref': edit({ op: 'setFields', values: [{ ref: { num: 0, gen: 0 }, value: 'a' }] }),
  'fields entry no value': edit({ op: 'setFields', values: [{ ref }] }),
  'fields value number': edit({ op: 'setFields', values: [{ ref, value: 5 }] }),
  'fields value null': edit({ op: 'setFields', values: [{ ref, value: null }] }),
  'fields value object': edit({ op: 'setFields', values: [{ ref, value: {} }] }),
  'fields text too long': edit({ op: 'setFields', values: [{ ref, value: big(L.MAX_TEXT_VALUE + 1) }] }),
  'fields array with number': edit({ op: 'setFields', values: [{ ref, value: ['a', 1] }] }),
  'fields array item too long': edit({ op: 'setFields', values: [{ ref, value: [big(L.MAX_TEXT_VALUE + 1)] }] }),
  'fields array too many items': edit({ op: 'setFields', values: [{ ref, value: many(L.MAX_CHOICE_VALUES + 1, () => 'a') }] }),
  // pdfWriteResult
  'write no requestId': wr({ requestId: undefined }),
  'write ok missing': wr({ ok: undefined }),
  'write ok string': wr({ ok: 'true' }),
  'write no bytes': wr({ bytes: undefined }),
  'write bytes array': wr({ bytes: [1, 2, 3] }),
  'write bytes Buffer-JSON': wr({ bytes: { type: 'Buffer', data: [] } }),
  'write no observed': wr({ observed: undefined }),
  'write observed null': wr({ observed: null }),
  'write observed pageCount negative': wr({ observed: observed({ pageCount: -1 }) }),
  'write observed pageCount huge': wr({ observed: observed({ pageCount: 100001 }) }),
  'write observed annots not array': wr({ observed: observed({ annotsPerPage: 3 }) }),
  'write observed annots negative': wr({ observed: observed({ annotsPerPage: [0, -1] }) }),
  'write observed annots float': wr({ observed: observed({ annotsPerPage: [0.5] }) }),
  'write observed annots too long': wr({ observed: observed({ annotsPerPage: zeros(L.MAX_PAGES + 1) }) }),
  'write observed fields not array': wr({ observed: observed({ fields: {} }) }),
  'write observed field bad ref': wr({ observed: observed({ fields: [{ ref: { num: -1, gen: 0 }, value: 'x' }] }) }),
  'write observed field bad value': wr({ observed: observed({ fields: [{ ref, value: 4 }] }) }),
  'write failure no message': { type: 'pdfWriteResult', requestId: 1, ok: false },
  'write failure message number': wr({ ok: false, message: 5 }),
  'write failure message too long': wr({ ok: false, message: big(L.MAX_MESSAGE + 1) }),
};

for (const [name, m] of Object.entries(bad)) {
  test(`rejects ${name}`, () => {
    assert.strictEqual(parsePdfToHost(m), null);
  });
}

test('rejection table is large enough', () => {
  assert.ok(Object.keys(bad).length >= 40);
});

test('rejects without throwing on hostile input', () => {
  const cyc = { type: 'pdfEdit', requestId: 1, baseVersion: 0 };
  cyc.edit = cyc;
  const getter = { get type() { return 'pdfRequestDocument'; } };
  for (const m of [cyc, getter, Object.create(null), new Proxy({}, {}), Symbol.iterator, () => 1]) {
    assert.doesNotThrow(() => parsePdfToHost(m));
  }
});

test('boundary values are accepted', () => {
  const edge = [
    edit({ op: 'addAnnotation', spec: hl({ page: L.MAX_PAGES - 1, comment: big(L.MAX_COMMENT), quads: zeros(L.MAX_QUADS * 8).map(() => L.MAX_COORD) }) }),
    edit({ op: 'addAnnotation', spec: ink({ paths: many(L.MAX_STROKES, () => zeros(L.MAX_POINTS_PER_STROKE * 2).map(() => -L.MAX_COORD)) }) }),
    edit({ op: 'setFields', values: many(L.MAX_FIELDS_PER_SET, () => ({ ref: { num: L.MAX_OBJ_NUM, gen: L.MAX_GEN }, value: big(L.MAX_TEXT_VALUE) })) }),
    { type: 'pdfFacts', facts: facts({ pageCount: L.MAX_PAGES }) },
  ];
  for (const m of edge) assert.ok(parsePdfToHost(m));
});

test('localId 0 and uncommon ids are valid', () => {
  assert.ok(parsePdfToHost(edit({ op: 'removeAnnotation', target: { localId: 0 } })));
  assert.ok(parsePdfToHost(edit({ op: 'removeAnnotation', target: { localId: Number.MAX_SAFE_INTEGER } })));
});

test('pdfWriteResult size cap follows the loaded size + 64 MB', () => {
  const g = L.WRITE_GROWTH_BYTES;
  // A subarray view of a larger zeroed buffer would still cost memory; use a small loadedSize instead.
  const small = { loadedSize: 0 };
  assert.ok(parsePdfToHost(wr({ bytes: new Uint8Array(1024) }), small));
  assert.strictEqual(L.WRITE_GROWTH_BYTES, 64 * 1024 * 1024);
  const tooBig = new Uint8Array(g + 1);
  assert.strictEqual(parsePdfToHost(wr({ bytes: tooBig }), small), null);
  assert.ok(parsePdfToHost(wr({ bytes: new Uint8Array(g) }), small));
  assert.ok(parsePdfToHost(wr({ bytes: tooBig }), { loadedSize: 1 }));
  // Without a loaded size the cap is the 500 MB open limit + 64 MB, never unbounded.
  assert.ok(parsePdfToHost(wr({ bytes: tooBig })));
});

test('limits match spec §5', () => {
  assert.strictEqual(L.MAX_PAGES, 100000);
  assert.strictEqual(L.MAX_QUADS, 5000);
  assert.strictEqual(L.MAX_STROKES, 500);
  assert.strictEqual(L.MAX_POINTS_PER_STROKE, 4000);
  assert.strictEqual(L.MAX_COORD, 100000);
  assert.strictEqual(L.MAX_COMMENT, 32767);
  assert.strictEqual(L.MAX_FIELDS_PER_SET, 2000);
  assert.strictEqual(L.MAX_TEXT_VALUE, 100000);
  assert.strictEqual(L.MAX_ATTACHMENT_BYTES, 250 * 1024 * 1024);
});

test('isPdfToHost is true for every accepted type and false for host-bound types', () => {
  for (const m of ok) assert.strictEqual(isPdfToHost(m), true);
  for (const t of ['init', 'pdfDocument', 'pdfState', 'pdfEditInfo', 'pdfEditResult', 'pdfWrite', 'pdfSaveAttachmentResult', 'nope']) {
    assert.strictEqual(isPdfToHost({ type: t }), false);
  }
});
