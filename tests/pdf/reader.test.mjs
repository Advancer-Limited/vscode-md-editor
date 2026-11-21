// PWP-14: strict reader (src/pdf/core/reader.ts).
// Oracles: @cantoo/pdf-lib (objects, dictionary keys, trailer, pages) and pdf.js (page refs); hostile inputs built here.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { core, fixture, allFixtures } from './_helpers.mjs';
import { skipPdfjs } from './_node.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFDict, PDFRef } = require('@cantoo/pdf-lib');
const { openPdf, openPdfSync, PdfReadError, tokenise, parseObject } = core.reader;
const L1 = (s) => Buffer.from(s, 'latin1');


// ------------------------------------------------------------------ expectations per fixture

/** Expected outcome of openPdf for every committed fixture: revisions/xref kind, or the PdfReadError code. */
const EXPECT = {
  'annotated.pdf': { revs: 1, kind: 'table' }, 'attachments.pdf': { revs: 1, kind: 'table' }, 'base14.pdf': { revs: 1, kind: 'table' },
  'basic.pdf': { revs: 1, kind: 'table' }, 'chrome.pdf': { revs: 1, kind: 'table' }, 'cjk.pdf': { revs: 1, kind: 'table' },
  'forms-js.pdf': { revs: 1, kind: 'table' }, 'forms.pdf': { revs: 1, kind: 'table' }, 'jpx-jbig2.pdf': { revs: 1, kind: 'table' },
  'js-openaction.pdf': { revs: 1, kind: 'table' }, 'large.pdf': { revs: 1, kind: 'stream' }, 'multi-revision.pdf': { revs: 3, kind: 'table' },
  'outline.pdf': { revs: 1, kind: 'table' }, 'rotated.pdf': { revs: 1, kind: 'table' }, 'scanned.pdf': { revs: 1, kind: 'table' },
  'signed.pdf': { revs: 1, kind: 'table' }, 'tagged.pdf': { revs: 1, kind: 'table' }, 'xref-stream.pdf': { revs: 1, kind: 'stream' },
  'hybrid-xref.pdf': { revs: 1, kind: 'hybrid' }, 'word.pdf': { revs: 2, kind: 'hybrid' } /* Word writes /XRefStm */,
  'broken-xref.pdf': 'bad-xref',
  'encrypted-user.pdf': 'encrypted', 'encrypted-owner.pdf': 'encrypted', 'truncated.pdf': 'no-startxref',
  'empty.pdf': 'no-header', 'not-a-pdf.pdf': 'no-header',
};
const OK = Object.keys(EXPECT).filter((n) => typeof EXPECT[n] === 'object');

function code(fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof PdfReadError, `not a PdfReadError: ${e && e.stack}`); return e.code; }
  return 'ok';
}
async function codeAsync(fn) {
  try { await fn(); } catch (e) { assert.ok(e instanceof PdfReadError, `not a PdfReadError: ${e && e.stack}`); return e.code; }
  return 'ok';
}

test('the expectation table covers every committed fixture', () => {
  assert.deepStrictEqual(Object.keys(EXPECT).sort(), allFixtures());
});

for (const [name, exp] of Object.entries(EXPECT)) {
  if (typeof exp === 'string') {
    test(`${name} is refused with '${exp}' (sync and async)`, async () => {
      assert.strictEqual(code(() => openPdfSync(fixture(name))), exp);
      assert.strictEqual(await codeAsync(() => openPdf(fixture(name))), exp);
    });
  }
}

// ------------------------------------------------------------------ oracle comparison

const refKey = (r) => `${r.num ?? r.objectNumber} ${r.gen ?? r.generationNumber}`;
function keysOf(v) { const d = v.kind === 'stream' ? v.dict : v; return d.kind === 'dict' ? [...d.entries.keys()].sort() : null; }

/** Pages by walking /Root /Pages /Kids with the reader (bounded, cycle-checked: test-side helper). */
function pageRefs(pdf) {
  const root = pdf.deref(pdf.trailer.entries.get('Root'));
  const out = []; const seen = new Set();
  const walk = (ref, depth) => {
    assert.ok(depth < 64 && !seen.has(refKey(ref)), 'page tree cycle');
    seen.add(refKey(ref));
    const node = pdf.resolve(ref.num, ref.gen).value;
    const type = node.entries.get('Type').value;
    if (type === 'Page') { out.push(refKey(ref)); return; }
    assert.strictEqual(type, 'Pages');
    for (const k of node.entries.get('Kids').items) walk(k, depth + 1);
  };
  walk(root.entries.get('Pages'), 0);
  return out;
}

let pdfjsLib;
async function pdfjsPageRefs(bytes) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false });
  try {
    const doc = await task.promise; const refs = [];
    for (let i = 1; i <= doc.numPages; i++) refs.push(refKey((await doc.getPage(i)).ref));
    return refs;
  } finally { await task.destroy(); }
}

for (const name of OK) {
  test(`${name}: every object resolves and agrees with pdf-lib; trailer, pages, revisions`, { skip: skipPdfjs }, async () => {
    const bytes = fixture(name);
    const pdf = await openPdf(bytes);
    const sync = openPdfSync(bytes);
    assert.strictEqual(pdf.revisions.length, EXPECT[name].revs);
    assert.strictEqual(pdf.xrefKind, EXPECT[name].kind);
    assert.strictEqual(sync.objectCount, pdf.objectCount);

    const lib = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
    const theirs = new Map(lib.context.enumerateIndirectObjects().map(([r, o]) => [r.objectNumber, { gen: r.generationNumber, o }]));
    // object counts and numbers
    assert.strictEqual(pdf.objectCount, theirs.size, 'object count');
    assert.deepStrictEqual([...pdf.objectNumbers()], [...theirs.keys()].sort((a, b) => a - b));
    // each object: resolves with the same generation and the same dictionary keys
    for (const [num, { gen, o }] of theirs) {
      const ours = pdf.resolve(num, gen);
      assert.ok(ours, `object ${num} ${gen} resolves`);
      assert.strictEqual(pdf.objectText(num, gen).length > 0, true);
      const d = o instanceof PDFDict ? o : o.dict;
      if (d) assert.deepStrictEqual(keysOf(ours.value), d.keys().map((k) => k.decodeText()).sort(), `keys of object ${num}`);
      else assert.notStrictEqual(ours.value.kind, 'dict', `object ${num} kind`);
      if (ours.value.kind === 'stream') assert.strictEqual(ours.value.dataEnd - ours.value.dataStart, pdf.streamData(ours.value).length);
    }
    // trailer
    const ti = lib.context.trailerInfo;
    assert.strictEqual(refKey(pdf.trailer.entries.get('Root')), refKey(ti.Root));
    const info = pdf.trailer.entries.get('Info');
    if (ti.Info instanceof PDFRef) assert.strictEqual(refKey(info), refKey(ti.Info));
    else if (ti.Info) assert.deepStrictEqual(keysOf(info), ti.Info.keys().map((k) => k.decodeText()).sort());
    else assert.strictEqual(info, undefined);
    assert.strictEqual(pdf.trailer.entries.has('ID'), !!ti.ID);
    // page tree: reader walk == pdf-lib == pdf.js
    const ours = pageRefs(pdf);
    assert.deepStrictEqual(ours, lib.getPages().map((p) => refKey(p.ref)));
    assert.deepStrictEqual(ours, await pdfjsPageRefs(bytes));
    // revisions: the chain is the file's startxref values, newest last; each /Prev is the previous section
    const text = Buffer.from(bytes).toString('latin1');
    const sx = [...text.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(pdf.revisions.map((r) => r.startxref), sx);
    assert.strictEqual(pdf.startxref, sx[sx.length - 1]);
    pdf.revisions.forEach((r, i) => assert.strictEqual(r.prev, i === 0 ? null : pdf.revisions[i - 1].startxref));
    assert.strictEqual(pdf.size, pdf.revisions.at(-1).size);
  });
}

test('multi-revision.pdf: newest wins, older revisions keep their own entries', () => {
  const pdf = openPdfSync(fixture('multi-revision.pdf'));
  const [r0, r1, r2] = pdf.revisions;
  assert.ok(r0.entryCount > 1 && r1.entryCount === 1 && r2.entryCount === 1);
  const info = pdf.trailer.entries.get('Info');
  const offs = [r0, r1, r2].map((r) => r.entry(info.num).offset);
  assert.strictEqual(new Set(offs).size, 3);
  assert.strictEqual(pdf.entry(info.num).offset, offs[2]);
  assert.match(pdf.objectText(info.num), /revision 3/);
  assert.ok(r2.sectionEnd > r2.startxref && r2.sectionEnd <= fixture('multi-revision.pdf').length);
  assert.strictEqual([...r1.entries()].length, 1);
});

test('xref-stream.pdf: object-stream entries, decoded content stream', () => {
  const pdf = openPdfSync(fixture('xref-stream.pdf'));
  const kinds = [...pdf.objectNumbers()].map((n) => pdf.entry(n).type);
  assert.ok(kinds.includes('objstm') && kinds.includes('offset'));
  const inStm = [...pdf.objectNumbers()].find((n) => pdf.entry(n).type === 'objstm');
  const o = pdf.resolve(inStm);
  assert.strictEqual(o.location.kind, 'objstm');
  assert.strictEqual(pdf.resolve(inStm, 1), null, 'objects in object streams have generation 0');
  const page = pdf.deref(pdf.deref(pdf.deref(pdf.trailer.entries.get('Root')).entries.get('Pages')).entries.get('Kids').items[0]);
  const c = pdf.deref(page.entries.get('Contents'));
  const content = c.kind === 'array' ? pdf.deref(c.items[c.items.length - 1]) : c;
  assert.strictEqual(content.kind, 'stream');
  assert.ok(Buffer.from(pdf.decodeStream(content)).toString('latin1').includes(Buffer.from('xref-stream - page 1').toString('hex').toUpperCase()));
  assert.strictEqual(pdf.revisions[0].xrefStreamNum !== null, true);
});

test('resolve returns null for free, absent and wrong-generation numbers', () => {
  const pdf = openPdfSync(fixture('basic.pdf'));
  assert.strictEqual(pdf.resolve(0), null);
  assert.strictEqual(pdf.resolve(pdf.size + 5), null);
  assert.strictEqual(pdf.resolve(1, 7), null);
  assert.strictEqual(pdf.resolve(-1), null);
  assert.strictEqual(pdf.entry(0).type, 'free');
});

// ------------------------------------------------------------------ tokeniser and parser

test('tokenise: every token kind with spans', () => {
  const src = L1('<< /A#20b 12 -3.5 .5 (a\\(b\\)\\n\\101\\\r\nc) <48 65 6C6> [true null] 1 0 R >> % comment\nendobj');
  const toks = [...tokenise(new Uint8Array(src))];
  assert.deepStrictEqual(toks.map((t) => t.type), ['punct', 'name', 'number', 'number', 'number', 'string', 'string', 'punct', 'keyword', 'keyword', 'punct', 'number', 'number', 'keyword', 'punct', 'keyword']);
  assert.strictEqual(toks[1].value, 'A b');
  assert.deepStrictEqual([toks[2].value, toks[2].integer, toks[3].value, toks[4].value], [12, true, -3.5, 0.5]);
  assert.strictEqual(Buffer.from(toks[5].bytes).toString('latin1'), 'a(b)\nAc');
  assert.strictEqual(Buffer.from(toks[6].bytes).toString('latin1'), 'Hel`');
  assert.strictEqual(src.subarray(toks[5].start, toks[5].end).toString('latin1')[0], '(');
});

test('parseObject: references, nesting, nested parentheses, spans', () => {
  const src = new Uint8Array(L1('  << /K [1 0 R 2 (x(y)z) << /N /V >>] /S 3 >> trailing'));
  const { value, end } = parseObject(src, 0);
  assert.strictEqual(value.kind, 'dict');
  const k = value.entries.get('K');
  assert.deepStrictEqual(k.items.map((i) => i.kind), ['ref', 'number', 'string', 'dict']);
  assert.strictEqual(Buffer.from(k.items[2].bytes).toString(), 'x(y)z');
  assert.strictEqual(Buffer.from(src.subarray(value.start, end)).toString('latin1'), '<< /K [1 0 R 2 (x(y)z) << /N /V >>] /S 3 >>');
});

test('parser refuses malformed syntax with defined codes', () => {
  const c = (s, lim) => code(() => parseObject(new Uint8Array(L1(s)), 0, lim));
  assert.strictEqual(c('<< /A 1 /A 2 >>'), 'malformed');           // duplicate key
  assert.strictEqual(c('<< 1 2 >>'), 'malformed');                 // key not a name
  assert.strictEqual(c('[1 2'), 'malformed');                      // unterminated
  assert.strictEqual(c('(abc'), 'malformed');
  assert.strictEqual(c('<4G>'), 'malformed');
  assert.strictEqual(c('/A#4'), 'malformed');
  assert.strictEqual(c('{ }'), 'malformed');
  assert.strictEqual(c('>>'), 'malformed');
  assert.strictEqual(c('bogus'), 'malformed');
  assert.strictEqual(c('1.2.3'), 'malformed');
  assert.strictEqual(c('x'.repeat(300)), 'malformed');
  assert.strictEqual(c(`(${'a'.repeat(5000)})`, { maxDictionaryBytes: 1000 }), 'too-large');
});

test('nesting cap: 200 levels parse, 201 and 100,000 are refused without a stack overflow', () => {
  const nest = (n) => new Uint8Array(L1('['.repeat(n) + ']'.repeat(n)));
  assert.strictEqual(code(() => parseObject(nest(200))), 'ok');
  assert.strictEqual(code(() => parseObject(nest(201))), 'too-large');
  assert.strictEqual(code(() => parseObject(nest(100_000))), 'too-large');
  const dicts = new Uint8Array(L1('<< /A '.repeat(300) + '1' + ' >>'.repeat(300)));
  assert.strictEqual(code(() => parseObject(dicts)), 'too-large');
});

// ------------------------------------------------------------------ hostile files

/**
 * Write a PDF with a classic table. objs: { num: body (string|Buffer) }. opts.trailer: extra trailer text;
 * opts.size; opts.prev; opts.base (append an incremental section to these bytes); opts.startxref override.
 */
function build(objs, opts = {}) {
  const parts = [opts.base ? Buffer.from(opts.base) : L1('%PDF-1.7\n')];
  let off = parts[0].length; const offs = {};
  for (const [n, body] of Object.entries(objs)) {
    const b = Buffer.concat([L1(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : L1(body), L1('\nendobj\n')]);
    offs[n] = off; off += b.length; parts.push(b);
  }
  const nums = Object.keys(offs).map(Number).sort((a, b) => a - b);
  const size = opts.size ?? (Math.max(0, ...nums) + 1);
  let x = 'xref\n';
  if (!opts.base) x += '0 1\n0000000000 65535 f \n';
  for (const n of nums) x += `${n} 1\n${String(offs[n]).padStart(10, '0')} 00000 n \n`;
  if (opts.xrefBody !== undefined) x = opts.xrefBody;
  x += `trailer\n<< /Size ${size} /Root 1 0 R${opts.prev !== undefined ? ` /Prev ${opts.prev}` : ''} ${opts.trailer ?? ''}>>\nstartxref\n${opts.startxref ?? off}\n%%EOF\n`;
  parts.push(L1(x));
  return { bytes: new Uint8Array(Buffer.concat(parts)), xref: off };
}
const CAT = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [] /Count 0 >>' };
const sx = (u8) => Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(Buffer.from(u8).toString('latin1'))[1]);
const appendRev = (base, objs, extra = {}) => build(objs, { base, prev: sx(base), size: 10, ...extra }).bytes;
const stm = (dict, data) => Buffer.concat([L1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, L1('\nendstream')]);

/** An object stream holding `inner` (object number -> text), plus its xref-stream section. */
function objStmPdf(inner, { dictExtra = '', raw } = {}) {
  const nums = Object.keys(inner).map(Number);
  let head = ''; let bodies = ''; for (const n of nums) { head += `${n} ${bodies.length} `; bodies += inner[n] + ' '; }
  const data = raw ?? zlib.deflateSync(L1(head + bodies));
  const objs = { ...CAT, 3: stm(`/Type /ObjStm /N ${nums.length} /First ${head.length} /Filter /FlateDecode ${dictExtra}`, data) };
  const parts = [L1('%PDF-1.7\n')]; let off = parts[0].length; const offs = {};
  for (const [n, body] of Object.entries(objs)) { const b = Buffer.concat([L1(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : L1(body), L1('\nendobj\n')]); offs[n] = off; off += b.length; parts.push(b); }
  const size = Math.max(...nums, 4) + 1;
  const rows = [];
  for (let n = 0; n < size; n++) {
    if (n === 0) rows.push([0, 0, 255]);
    else if (offs[n] !== undefined) rows.push([1, offs[n], 0]);
    else if (n === size - 1 && !inner[n]) rows.push([1, off, 0]); // the xref stream itself
    else if (inner[n] !== undefined) rows.push([2, 3, nums.indexOf(n)]);
    else rows.push([0, 0, 0]);
  }
  const xs = Buffer.alloc(rows.length * 6);
  rows.forEach(([t, a, b], i) => { xs[i * 6] = t; xs.writeUInt32BE(a, i * 6 + 1); xs[i * 6 + 5] = b; });
  const xnum = size; // put the xref stream at number `size`, extend /Size by one
  rows.push([1, off, 0]);
  const xs2 = Buffer.concat([xs, Buffer.from([1, ...[24, 16, 8, 0].map((s) => (off >>> s) & 0xFF), 0])]);
  parts.push(L1(`${xnum} 0 obj\n`), stm(`/Type /XRef /Size ${size + 1} /W [1 4 1] /Root 1 0 R`, xs2), L1('\nendobj\n'));
  parts.push(L1(`startxref\n${off}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

test('hand-built object stream file reads (baseline for the object-stream cases)', () => {
  const pdf = openPdfSync(objStmPdf({ 4: '<< /A 1 >>', 5: '[1 2 3]' }));
  assert.strictEqual(pdf.resolve(4).value.entries.get('A').value, 1);
  assert.strictEqual(pdf.resolve(5).value.items.length, 3);
  assert.strictEqual(pdf.xrefKind, 'stream');
});

/** Catalog + pages + an xref stream with /W [1 4 1]; `predictor` adds PNG Up rows (/Predictor 12), `extra` trailing bytes. */
function xrefStreamPdf({ predictor = false, extra = 0 } = {}) {
  const parts = [L1('%PDF-1.7\n')]; let off = parts[0].length; const offs = {};
  for (const [n, body] of Object.entries(CAT)) { const b = L1(`${n} 0 obj\n${body}\nendobj\n`); offs[n] = off; off += b.length; parts.push(b); }
  const rows = [[0, 0, 255], [1, offs[1], 0], [1, offs[2], 0], [1, off, 0]].map(([t, a, g]) => { const r = Buffer.alloc(6); r[0] = t; r.writeUInt32BE(a, 1); r[5] = g; return r; });
  let raw;
  if (predictor) raw = Buffer.concat(rows.map((r, i) => Buffer.concat([Buffer.from([2]), Buffer.from(r.map((v, k) => (v - (i ? rows[i - 1][k] : 0)) & 0xFF))])));
  else raw = Buffer.concat(rows);
  raw = Buffer.concat([raw, Buffer.alloc(extra)]);
  const parms = predictor ? ' /DecodeParms << /Predictor 12 /Columns 6 >>' : '';
  parts.push(L1('3 0 obj\n'), stm(`/Type /XRef /Size 4 /W [1 4 1] /Root 1 0 R /Filter /FlateDecode${parms}`, zlib.deflateSync(raw)), L1('\nendobj\n'));
  parts.push(L1(`startxref\n${off}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

test('cross-reference streams: PNG predictor 12 decodes; a length that does not match /W and /Index is bad-xref', () => {
  for (const predictor of [false, true]) {
    const pdf = openPdfSync(xrefStreamPdf({ predictor }));
    assert.strictEqual(pdf.objectCount, 3);
    assert.strictEqual(pdf.resolve(2).value.entries.get('Type').value, 'Pages');
    assert.strictEqual(pdf.revisions[0].xrefStreamNum, 3);
  }
  assert.strictEqual(code(() => openPdfSync(xrefStreamPdf({ extra: 6 }))), 'bad-xref');
  assert.strictEqual(code(() => openPdfSync(xrefStreamPdf({ extra: 600 }))), 'bad-xref');
});

test('/Prev cycles are refused with prev-cycle', () => {
  const a = build(CAT);
  // a section whose /Prev is itself
  assert.strictEqual(code(() => openPdfSync(build(CAT, { prev: a.xref }).bytes)), 'prev-cycle');
  // rev2 -> rev1 -> rev2: rev1's /Prev is written 10 digits wide, then patched to rev2's offset (offsets stay valid)
  const r1 = build({ 3: '<< >>' }, { base: a.bytes, prev: String(a.xref).padStart(10, '0'), size: 10 });
  const r2 = build({ 4: '<< >>' }, { base: r1.bytes, prev: r1.xref, size: 10 });
  assert.strictEqual(openPdfSync(r2.bytes).revisions.length, 3);
  const cyc = Buffer.from(r2.bytes).toString('latin1').replace('/Prev ' + String(a.xref).padStart(10, '0'), '/Prev ' + String(r2.xref).padStart(10, '0'));
  assert.strictEqual(code(() => openPdfSync(new Uint8Array(L1(cyc)))), 'prev-cycle');
});

test('a /Prev chain longer than maxRevisions is refused with too-large', () => {
  let b = build(CAT).bytes;
  for (let i = 0; i < 5; i++) b = appendRev(b, { 3: `<< /I ${i} >>` });
  assert.strictEqual(openPdfSync(b).revisions.length, 6);
  assert.strictEqual(code(() => openPdfSync(b, { maxRevisions: 5 })), 'too-large');
  assert.strictEqual(code(() => openPdfSync(b, { maxRevisions: 6 })), 'ok');
});

test('a lying /Length is refused: short, long, past the end, negative, huge', () => {
  const data = L1('BT /F1 12 Tf (hello) Tj ET');
  const mk = (len) => build({ ...CAT, 3: Buffer.concat([L1(`<< /Length ${len} >>\nstream\n`), data, L1('\nendstream')]) }).bytes;
  assert.strictEqual(code(() => openPdfSync(mk(data.length)).resolve(3)), 'ok');
  for (const len of [data.length - 3, data.length + 4, 10_000_000, 1e15, -1]) {
    const pdf = openPdfSync(mk(len)); // lazy: the stream is not looked at until resolved
    assert.strictEqual(code(() => pdf.resolve(3)), 'malformed', `length ${len}`);
  }
});

test('an indirect /Length resolves; a /Length that refers to itself is a defined failure', () => {
  const data = L1('0123456789');
  const ok = build({ ...CAT, 3: Buffer.concat([L1('<< /Length 4 0 R >>\nstream\n'), data, L1('\nendstream')]), 4: '10' }).bytes;
  assert.strictEqual(openPdfSync(ok).streamData(openPdfSync(ok).resolve(3).value).length, 10);
  const self = build({ ...CAT, 3: Buffer.concat([L1('<< /Length 3 0 R >>\nstream\n'), data, L1('\nendstream')]) }).bytes;
  assert.strictEqual(code(() => openPdfSync(self).resolve(3)), 'malformed');
});

test('an inflating object stream over the cap is refused with too-large (default 64 MB cap and a small one)', () => {
  const zeros = (n) => zlib.deflateSync(Buffer.alloc(n, 0x20), { level: 9 });
  const big = objStmPdf({ 4: '<< >>' }, { raw: zeros(65 * 1024 * 1024) }); // ~65 KB on disk, 65 MB inflated
  assert.ok(big.length < 200_000);
  assert.strictEqual(code(() => openPdfSync(big).resolve(4)), 'too-large');
  const small = objStmPdf({ 4: '<< >>' }, { raw: zeros(2 * 1024 * 1024) });
  assert.strictEqual(code(() => openPdfSync(small, { maxObjectStreamBytes: 1024 * 1024 }).resolve(4)), 'too-large');
});

test('object streams are read as pdf.js reads them: bounded at the next offset, no repeated number, no decreasing offset (review N7)', () => {
  const inner = { 4: '<< >>', 5: '[1]' }; // header "4 0 5 6 ", bodies "<< >> [1] "
  assert.strictEqual(code(() => openPdfSync(objStmPdf(inner)).resolve(4)), 'ok');
  // a number listed twice: pdf.js takes the LAST pair naming it, whatever index the xref gives
  assert.strictEqual(code(() => openPdfSync(objStmPdf(inner, { raw: zlib.deflateSync(L1('4 0 4 6 << >> [1] ')) })).resolve(4)), 'objstm');
  // offsets that decrease: pdf.js refuses the stream
  assert.strictEqual(code(() => openPdfSync(objStmPdf(inner, { raw: zlib.deflateSync(L1('4 6 5 0 [1]   << >> ')) })).resolve(4)), 'objstm');
  // object 4 is "[1 2 " up to the next offset (5); read on to the end it would be [1 2 3]
  const spill = objStmPdf({ 4: '[1 2', 5: '3]' }, { raw: zlib.deflateSync(L1('4 0 5 5 [1 2 3] ')) });
  assert.strictEqual(code(() => openPdfSync(spill).resolve(4)), 'malformed');
});

test('a table subsection `1 N` whose first entry is free is refused (pdf.js renumbers it from 0; review B1)', () => {
  const head = '%PDF-1.7\n';
  const o1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', o2 = '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const at1 = head.length, at2 = at1 + o1.length, x = at2 + o2.length;
  const row = (o, g, t) => `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} ${t} \n`;
  const file = (xref) => new Uint8Array(L1(`${head}${o1}${o2}${xref}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`));
  // the same entries as one subsection "0 4" are fine
  assert.strictEqual(code(() => openPdfSync(file(`xref\n0 4\n${row(0, 65535, 'f')}${row(at1, 0, 'n')}${row(at2, 0, 'n')}${row(0, 1, 'f')}`))), 'ok');
  // a subsection "1 3" starting with a free entry (object 1 freed, as pdf.js's writer frees it): pdf.js reads every
  // entry of it under a number one lower
  const amb = file(`xref\n0 1\n${row(0, 65535, 'f')}1 3\n${row(0, 1, 'f')}${row(at2, 0, 'n')}${row(0, 1, 'f')}`);
  assert.strictEqual(code(() => openPdfSync(amb)), 'ambiguous-xref');
  // a subsection starting at 1 with an in-use first entry is unambiguous
  assert.strictEqual(code(() => openPdfSync(file(`xref\n0 1\n${row(0, 65535, 'f')}1 3\n${row(at1, 0, 'n')}${row(at2, 0, 'n')}${row(0, 1, 'f')}`))), 'ok');
});

test('/Size alone allocates nothing: the merged view is sized by the entries listed (review N1)', () => {
  const { bytes } = build(CAT, { size: 5_000_000 });
  const before = process.memoryUsage().arrayBuffers;
  const pdf = openPdfSync(bytes);
  assert.ok(process.memoryUsage().arrayBuffers - before < 4 * 1024 * 1024);
  assert.strictEqual(pdf.size, 5_000_000);
  assert.strictEqual(pdf.entry(4_999_999), undefined);
  assert.strictEqual(pdf.resolve(4_999_999), null);
});

test('padding before a value counts against the token cap; resolved objects are cached (review S3)', () => {
  const pad = ' '.repeat(64 * 1024);
  const { bytes } = build({ ...CAT, 3: `${pad}[0 0 612 792]` });
  assert.strictEqual(code(() => openPdfSync(bytes, { maxDictionaryBytes: 16 * 1024 }).resolve(3)), 'too-large');
  const pdf = openPdfSync(bytes);
  pdf.resolve(3);
  const w = pdf.workBytes;
  assert.ok(w >= pad.length);
  for (let i = 0; i < 1000; i++) pdf.resolve(3);
  assert.strictEqual(pdf.workBytes, w, 'a cached object is not parsed again');
  assert.strictEqual(pdf.resolve(3), pdf.resolve(3));
});

test('object-stream defects are refused with objstm', () => {
  // header pair names a different object
  const wrong = objStmPdf({ 4: '<< >>' }, { raw: zlib.deflateSync(L1('7 0 << >> ')) });
  assert.strictEqual(code(() => openPdfSync(wrong).resolve(4)), 'objstm');
  // a stream inside an object stream
  const inner = objStmPdf({ 4: '<< /Length 1 >> stream\nx\nendstream' });
  assert.strictEqual(code(() => openPdfSync(inner).resolve(4)), 'objstm');
  // corrupt Flate data
  const corrupt = objStmPdf({ 4: '<< >>' }, { raw: Buffer.from('not zlib at all') });
  assert.strictEqual(code(() => openPdfSync(corrupt).resolve(4)), 'objstm');
  // /Type is not /ObjStm
  const notStm = objStmPdf({ 4: '<< >>' });
  const s = Buffer.from(notStm).toString('latin1').replace('/Type /ObjStm', '/Type /ObjSt_');
  assert.strictEqual(code(() => openPdfSync(new Uint8Array(L1(s))).resolve(4)), 'objstm');
});

test('dictionary size cap', () => {
  const huge = build({ ...CAT, 3: `<< ${Array.from({ length: 400 }, (_, i) => `/K${i} ${i}`).join(' ')} >>` }).bytes;
  assert.strictEqual(code(() => openPdfSync(huge).resolve(3)), 'ok');
  assert.strictEqual(code(() => openPdfSync(huge, { maxDictionaryBytes: 1000 }).resolve(3)), 'too-large');
});

test('cross-reference entry caps: a lying subsection count and an oversized /Size fail fast', () => {
  const lie = build(CAT, { xrefBody: 'xref\n0 4000000000\n0000000000 65535 f \n' }).bytes;
  const t0 = performance.now();
  assert.strictEqual(code(() => openPdfSync(lie)), 'too-large');
  const mid = build(CAT, { xrefBody: 'xref\n0 400000\n0000000000 65535 f \n' }).bytes;
  assert.strictEqual(code(() => openPdfSync(mid)), 'bad-xref'); // runs past the end of the file
  assert.strictEqual(code(() => openPdfSync(build(CAT, { size: 6_000_000 }).bytes)), 'too-large');
  assert.strictEqual(code(() => openPdfSync(build(CAT).bytes, { maxXrefEntries: 2 })), 'too-large');
  assert.ok(performance.now() - t0 < 500);
});

test('cross-reference defects are refused with bad-xref', () => {
  const good = build(CAT);
  const s = Buffer.from(good.bytes).toString('latin1');
  const u = (t) => new Uint8Array(L1(t));
  assert.strictEqual(code(() => openPdfSync(good.bytes)), 'ok');
  assert.strictEqual(code(() => openPdfSync(u(s.replace(/startxref\n\d+/, 'startxref\n99999')))), 'bad-xref');      // past EOF
  assert.strictEqual(code(() => openPdfSync(u(s.replace(/startxref\n(\d+)/, (_, n) => `startxref\n${Number(n) - 1}`)))), 'bad-xref'); // off by one
  assert.strictEqual(code(() => openPdfSync(u(s.replace('2 0 obj', '9 0 obj')))), 'bad-xref');                    // header mismatch
  assert.strictEqual(code(() => openPdfSync(build(CAT, { size: 2 }).bytes)), 'bad-xref');                          // entry >= /Size
  assert.strictEqual(code(() => openPdfSync(u(s.replace('/Size 3', '/Size x')))), 'bad-xref');
  assert.strictEqual(code(() => openPdfSync(u(s.replace('trailer', 'trailor')))), 'bad-xref');
  assert.strictEqual(code(() => openPdfSync(u(s.replace(/ 00000 n \n2 1/, ' 00000 x \n2 1')))), 'bad-xref');
  const dup = build(CAT, { xrefBody: `xref\n0 1\n0000000000 65535 f \n1 1\n${String(s.indexOf('1 0 obj')).padStart(10, '0')} 00000 n \n1 1\n${String(s.indexOf('1 0 obj')).padStart(10, '0')} 00000 n \n` }).bytes;
  assert.strictEqual(code(() => openPdfSync(dup)), 'bad-xref');
  assert.strictEqual(code(() => openPdfSync(u(s.replace(/\/Root 1 0 R/, '/Root 1 0 R /Prev 999999')))), 'bad-xref');
});

test('startxref and header defects', () => {
  const s = Buffer.from(build(CAT).bytes).toString('latin1');
  const u = (t) => new Uint8Array(L1(t));
  assert.strictEqual(code(() => openPdfSync(u(s.replace('%%EOF', '%%EOX')))), 'no-startxref');
  assert.strictEqual(code(() => openPdfSync(u(s.replace(/startxref\n\d+/, 'startxref\nabc')))), 'no-startxref');
  assert.strictEqual(code(() => openPdfSync(u(s + ' '.repeat(2000)))), 'no-startxref');
  assert.strictEqual(code(() => openPdfSync(u(s.replace('%PDF-1.7', '%PDX-1.7')))), 'no-header');
});

test('/Encrypt in an older revision is refused; /XRefStm in an appended table that points at no xref stream is hybrid', () => {
  const enc = build(CAT, { trailer: '/Encrypt 2 0 R ' }).bytes;
  assert.strictEqual(code(() => openPdfSync(appendRev(enc, { 3: '<< >>' }))), 'encrypted');
  const hyb = appendRev(build(CAT).bytes, { 3: '<< >>' }, { trailer: '/XRefStm 9 ' }); // offset 9 is `1 0 obj` (the catalog)
  assert.strictEqual(code(() => openPdfSync(hyb)), 'hybrid');
});

// ------------------------------------------------------------------ hybrid-reference sections (ISO 32000-1 §7.5.8.4)

test('word.pdf: the newest (hybrid) section supplies object-stream entries the older table marks free', () => {
  const pdf = openPdfSync(fixture('word.pdf'));
  const [r0, r1] = pdf.revisions;
  assert.deepStrictEqual([r0.kind, r1.kind, pdf.xrefKind], ['table', 'hybrid', 'hybrid']);
  assert.strictEqual(r0.xrefStm, null);
  assert.strictEqual(r1.xrefStm, Number(pdf.trailer.entries.get('XRefStm').value));
  assert.strictEqual(pdf.resolve(r1.xrefStreamNum, 0).value.dict.entries.get('Type').value, 'XRef');
  // Word lists the compressed objects as free in its full table and as type-2 entries in the stream of the update.
  const compressed = [...pdf.objectNumbers()].filter((n) => pdf.entry(n).type === 'objstm');
  assert.ok(compressed.length > 40);
  for (const n of compressed) {
    assert.strictEqual(r0.entry(n).type, 'free');
    assert.strictEqual(r1.entry(n).type, 'objstm');
    assert.ok(pdf.resolve(n), `object ${n} resolves from its object stream`);
  }
  assert.ok(r1.sectionEnd > r1.startxref);
});

test('hybrid-xref.pdf: the object only the stream lists comes from the stream; table entries keep their offsets', () => {
  const pdf = openPdfSync(fixture('hybrid-xref.pdf'));
  const r = pdf.revisions[0];
  assert.strictEqual(r.kind, 'hybrid');
  assert.strictEqual(pdf.entry(6).type, 'objstm');
  assert.strictEqual(pdf.resolve(6).location.kind, 'objstm');
  assert.strictEqual(pdf.resolve(6).value.entries.get('Type').value, 'Page');
  assert.strictEqual(r.entryCount, 10); // nine table rows (0-5, 7-9) + one from the stream
  assert.strictEqual(r.xrefStreamNum, 9);
});

/**
 * A one-section hybrid file: catalog 1, pages 2, page 3, object stream 4 holding 5 (`<< /Marker 5 >>`), the /XRefStm
 * stream 6; the table lists 0-4 and 6. Options: rows (stream rows [num, type, f2, f3], default [[5, 2, 4, 0]]),
 * stmDict (extra keys of the stream), tableExtra (extra table rows: num -> 'f' | offset), xrefStm (trailer value
 * text), size (table /Size), stmSize, trailer (extra trailer text), dup1 (a second copy of object 1 at offs.dup1).
 */
function hybridBuild(o = {}) {
  const parts = [L1('%PDF-1.7\n')]; let off = parts[0].length; const offs = {};
  const add = (n, body) => { const b = Buffer.concat([L1(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : L1(body), L1('\nendobj\n')]); offs[n] = off; off += b.length; parts.push(b); };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>');
  const inner = L1('5 0 << /Marker 5 >> ');
  add(4, stm('/Type /ObjStm /N 1 /First 4', inner));
  if (o.dup1) { const d = L1('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Copy true >>\nendobj\n'); offs.dup1 = off; off += d.length; parts.push(d); }
  const rows = (typeof o.rows === 'function' ? o.rows(offs) : o.rows) ?? [[5, 2, 4, 0]];
  const data = Buffer.alloc(rows.length * 6);
  rows.forEach(([, t, a, g], i) => { data[i * 6] = t; data.writeUInt32BE(a, i * 6 + 1); data[i * 6 + 5] = g; });
  const index = rows.map(([n]) => `${n} 1`).join(' ');
  const stmAt = off;
  add(6, stm(`/Type /XRef /Size ${o.stmSize ?? 7} /W [1 4 1] /Index [${index}] ${o.stmDict ?? ''}`, data));
  const row = (v) => (v === 'f' ? '0000000000 00001 f \n' : `${String(v).padStart(10, '0')} 00000 n \n`);
  const table = { 0: '0000000000 65535 f \n' };
  for (const n of [1, 2, 3, 4, 6]) table[n] = row(offs[n]);
  for (const [n, v] of Object.entries(o.tableExtra ?? {})) table[n] = row(v);
  let x = 'xref\n';
  for (const n of Object.keys(table).map(Number).sort((a, b) => a - b)) x += `${n} 1\n${table[n]}`;
  const xref = off;
  x += `trailer\n<< /Size ${o.size ?? 7} /Root 1 0 R /XRefStm ${o.xrefStm ?? stmAt} ${o.trailer ?? ''}>>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(L1(x));
  return { bytes: new Uint8Array(Buffer.concat(parts)), offs, stmAt, xref };
}

test('hand-built hybrid file reads: stream-only object, agreeing duplicates, free in both', () => {
  const h = hybridBuild();
  const pdf = openPdfSync(h.bytes);
  assert.strictEqual(pdf.xrefKind, 'hybrid');
  assert.strictEqual(pdf.revisions[0].xrefStm, h.stmAt);
  assert.strictEqual(pdf.resolve(5).value.entries.get('Marker').value, 5);
  assert.strictEqual(pdf.objectCount, 6);
  // the stream repeats the table's entry for 1 (same offset and generation) and a free 0: accepted, table entry kept
  const dup = hybridBuild({ rows: (offs) => [[0, 0, 0, 255], [1, 1, offs[1], 0], [5, 2, 4, 0]] });
  assert.strictEqual(code(() => openPdfSync(dup.bytes)), 'ok');
  assert.strictEqual(openPdfSync(dup.bytes).entry(1).offset, dup.offs[1]);
  // a number only the stream lists as free is free in this section
  const free = openPdfSync(hybridBuild({ rows: [[5, 2, 4, 0], [7, 0, 0, 1]], size: 8, stmSize: 8 }).bytes);
  assert.strictEqual(free.entry(7).type, 'free');
  assert.strictEqual(free.revisions[0].entryCount, 8);
});

test('a plain table appended on top of a hybrid section supersedes its stream entries (pdf.js output shape)', () => {
  const h = hybridBuild();
  const pdf = openPdfSync(h.bytes);
  const upd = appendRev(h.bytes, { 5: '<< /Marker 55 >>' }, { size: 7 }); // a plain table section on top of the hybrid
  const p2 = openPdfSync(upd);
  assert.deepStrictEqual(p2.revisions.map((r) => r.kind), ['hybrid', 'table']);
  assert.strictEqual(p2.xrefKind, 'table');
  assert.strictEqual(p2.resolve(5).value.entries.get('Marker').value, 55);
  assert.strictEqual(pdf.resolve(5).value.entries.get('Marker').value, 5);
});

test('malformed or ambiguous hybrid sections are refused with hybrid', () => {
  const c = (o) => code(() => openPdfSync(hybridBuild(o).bytes));
  const h = hybridBuild();
  // the /XRefStm value
  assert.strictEqual(c({ xrefStm: '999999' }), 'hybrid');          // past the end of the file
  assert.strictEqual(c({ xrefStm: '-5' }), 'hybrid');
  assert.strictEqual(c({ xrefStm: '12.5' }), 'hybrid');
  assert.strictEqual(c({ xrefStm: '(754)' }), 'hybrid');
  assert.strictEqual(c({ xrefStm: '6 0 R' }), 'hybrid');
  assert.strictEqual(c({ xrefStm: String(h.offs[1]) }), 'hybrid');  // an object that is not an XRef stream
  assert.strictEqual(c({ xrefStm: String(h.offs[4]) }), 'hybrid');  // a stream that is not an XRef stream
  assert.strictEqual(c({ xrefStm: String(h.xref) }), 'hybrid');     // the table itself
  assert.strictEqual(c({ xrefStm: String(h.stmAt + 1) }), 'hybrid'); // inside the stream's header
  // the stream
  assert.strictEqual(c({ stmDict: '/Prev 9' }), 'hybrid');
  assert.strictEqual(c({ stmDict: '/XRefStm 9' }), 'hybrid');
  assert.strictEqual(c({ rows: [[5, 2, 4, 0], [9, 2, 4, 1]], stmSize: 10 }), 'hybrid'); // entry over the table's /Size
  assert.strictEqual(c({ rows: [[5, 1, 9999, 0]] }), 'hybrid');     // entry does not point at its header
  assert.strictEqual(c({ rows: [[5, 7, 0, 0]] }), 'hybrid');        // unknown entry type
  assert.strictEqual(c({ stmDict: '/Encrypt 1 0 R' }), 'encrypted');
  // conflicts between the table and the stream of one section
  assert.strictEqual(c({ dup1: true, rows: (offs) => [[1, 1, offs.dup1, 0], [5, 2, 4, 0]] }), 'hybrid'); // a different copy of 1
  assert.strictEqual(c({ rows: (offs) => [[1, 2, 4, 0], [5, 2, 4, 0]] }), 'hybrid');       // offset vs object stream
  assert.strictEqual(c({ rows: [[1, 0, 0, 0], [5, 2, 4, 0]] }), 'hybrid');                 // in use vs free
  assert.strictEqual(c({ tableExtra: { 5: 'f' } }), 'hybrid');                             // free in the table, in use in the stream
});

test('hybrid /XRefStm streams are each read once and never also a /Prev section', () => {
  // two sections naming the same /XRefStm stream
  const h = hybridBuild();
  const twice = appendRev(h.bytes, { 7: '<< >>' }, { size: 8, trailer: `/XRefStm ${h.stmAt} ` });
  assert.strictEqual(code(() => openPdfSync(twice)), 'hybrid');
  // an appended table whose /XRefStm is the base's own cross-reference stream section (also its /Prev)
  const xs = xrefStreamPdf();
  const self = appendRev(xs, { 5: '<< >>' }, { trailer: `/XRefStm ${sx(xs)} ` });
  assert.strictEqual(code(() => openPdfSync(self)), 'hybrid');
});

test('hybrid stream entries count toward maxXrefEntries', () => {
  const h = hybridBuild();
  assert.strictEqual(code(() => openPdfSync(h.bytes, { maxXrefEntries: 7 })), 'ok'); // 6 table rows + 1 stream row
  assert.strictEqual(code(() => openPdfSync(h.bytes, { maxXrefEntries: 6 })), 'too-large');
});

test('lazy: a garbage body behind a valid header opens; resolving that object fails, others still resolve', () => {
  const pdf = openPdfSync(build({ ...CAT, 3: '<< /A [ ( >> ' }).bytes);
  assert.strictEqual(pdf.objectCount, 3);
  assert.strictEqual(code(() => pdf.resolve(3)), 'malformed');
  assert.strictEqual(pdf.resolve(1).value.kind, 'dict');
});

test('unsupported filters and predictors are refused by decodeStream, not guessed', () => {
  const pdf = openPdfSync(build({ ...CAT, 3: stm('/Filter /LZWDecode', L1('abc')), 4: stm('/Filter /FlateDecode /DecodeParms << /Predictor 2 >>', zlib.deflateSync(L1('abc'))) }).bytes);
  assert.strictEqual(code(() => pdf.decodeStream(pdf.resolve(3).value)), 'malformed');
  assert.strictEqual(code(() => pdf.decodeStream(pdf.resolve(4).value)), 'malformed');
});

// ------------------------------------------------------------------ fuzzing: never anything but PdfReadError, never a hang

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

for (const name of ['basic.pdf', 'xref-stream.pdf', 'multi-revision.pdf', 'annotated.pdf', 'hybrid-xref.pdf', 'word.pdf']) {
  test(`${name}: 400 seeded mutations and every truncation point give a result or a PdfReadError`, () => {
    const base = fixture(name); const r = rng(name.length * 7919);
    const t0 = performance.now();
    const exercise = (b) => {
      try {
        const pdf = openPdfSync(b);
        for (const n of pdf.objectNumbers()) {
          try { const o = pdf.resolve(n); if (o && o.value.kind === 'stream') { try { pdf.decodeStream(o.value); } catch (e) { if (!(e instanceof PdfReadError)) throw e; } } } catch (e) { if (!(e instanceof PdfReadError)) throw e; }
        }
      } catch (e) { if (!(e instanceof PdfReadError)) throw e; }
    };
    for (let i = 0; i < 400; i++) {
      const b = base.slice();
      const k = 1 + Math.floor(r() * 4);
      for (let j = 0; j < k; j++) {
        const at = Math.floor(r() * b.length);
        b[at] = r() < 0.5 ? Math.floor(r() * 256) : '0123456789 <>[]()/R\n'.charCodeAt(Math.floor(r() * 20));
      }
      exercise(b);
    }
    for (let cut = 0; cut < base.length; cut += 23) exercise(base.subarray(0, cut));
    assert.ok(performance.now() - t0 < 20_000);
  });
}

// ------------------------------------------------------------------ performance: lazy access on ~100 MB files

/** An object-dense file like the spike's big-objs-100.pdf: ~357k small objects, classic table, ~100 MB. */
function objectDense(target = 100 * 1024 * 1024) {
  const pad = 'x'.repeat(200);
  const chunks = [L1('%PDF-1.7\n')]; let off = chunks[0].length;
  const offs = [0];
  const push = (s) => { const b = L1(s); chunks.push(b); off += b.length; };
  offs[1] = off; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offs[2] = off; push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offs[3] = off; push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n');
  let n = 4;
  while (off < target) { offs[n] = off; push(`${n} 0 obj\n<< /Type /Thing /N ${n} /Arr [${n} 0 ${n % 97} 1.5] /S (${pad}) >>\nendobj\n`); n++; }
  const xref = off;
  const rows = new Array(n); rows[0] = '0000000000 65535 f \n';
  for (let i = 1; i < n; i++) rows[i] = `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  push(`xref\n0 ${n}\n${rows.join('')}trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { bytes: new Uint8Array(Buffer.concat(chunks)), count: n - 1 };
}

/** A full GC (flag set at run time, so `npm test` needs no --expose-gc). */
function fullGc() { v8.setFlagsFromString('--expose-gc'); vm.runInNewContext('gc')(); }

/** Run `fn` while measuring the longest gap between event-loop turns. */
async function withLoopWatch(fn) {
  let last = performance.now(); let maxGap = 0; let on = true; const gaps = []; const t0 = performance.now();
  const tick = () => { const t = performance.now(); if (t - last > 25) gaps.push(`${(t - last).toFixed(1)}@${(t - t0).toFixed(0)}`); maxGap = Math.max(maxGap, t - last); last = t; if (on) setImmediate(tick); };
  setImmediate(tick);
  const tStart = performance.now();
  const result = await fn();
  const ms = performance.now() - tStart;
  on = false;
  await new Promise((r) => setImmediate(r));
  return { result, ms, maxGap, gaps };
}

test('object-dense ~100 MB file: lazy open within budget, event loop never blocked over 50 ms, random access', async (t) => {
  const { bytes, count } = objectDense();
  // Settle first: collect the generator's garbage and let earlier tests' pending work run, so the watch measures
  // the reader (whose own slices are ~30 ms) and not the test process.
  fullGc();
  await new Promise((r) => setTimeout(r, 200));
  const { result: pdf, ms, maxGap, gaps } = await withLoopWatch(() => openPdf(bytes));
  t.diagnostic('gaps over 25 ms: ' + gaps.join(' '));
  assert.strictEqual(pdf.objectCount, count);
  const t1 = performance.now();
  const r = rng(42);
  for (let i = 0; i < 2000; i++) { const n = 1 + Math.floor(r() * count); assert.strictEqual(pdf.resolve(n).value.entries.get('N')?.value ?? n, n); }
  const resolveMs = performance.now() - t1;
  const syncT = performance.now(); openPdfSync(bytes); const syncMs = performance.now() - syncT;
  t.diagnostic(`object-dense ${(bytes.length / 1048576).toFixed(1)} MB, ${count} objects: openPdf ${ms.toFixed(0)} ms (max loop gap ${maxGap.toFixed(1)} ms), openPdfSync ${syncMs.toFixed(0)} ms, 2000 random resolves ${resolveMs.toFixed(0)} ms`);
  assert.ok(maxGap < 50, `event loop blocked for ${maxGap.toFixed(1)} ms`);
  assert.ok(ms < 2000, `open took ${ms.toFixed(0)} ms (budget: Edit-on 2 s per 100 MB)`);
  assert.ok(resolveMs < 1000);
});

test('makeHugePdf (101 MB, one big stream): opens and the stream is skipped by /Length', async (t) => {
  const { makeHugePdf } = await import('../../scripts/pdf-fixtures/make-synthetic.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsmd-pwp14-'));
  try {
    const bytes = new Uint8Array(fs.readFileSync(makeHugePdf(dir)));
    const { result: pdf, ms, maxGap } = await withLoopWatch(async () => { const p = await openPdf(bytes); p.resolve(4); return p; });
    t.diagnostic(`huge.pdf ${(bytes.length / 1048576).toFixed(1)} MB: open + resolve(stream) ${ms.toFixed(1)} ms, max loop gap ${maxGap.toFixed(1)} ms`);
    const s = pdf.resolve(4).value;
    assert.strictEqual(s.kind, 'stream');
    assert.strictEqual(s.dataEnd - s.dataStart, 101 * 1048576);
    assert.ok(ms < 500 && maxGap < 50);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
