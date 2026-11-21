// PWP-18: the save verifier (spec §6.5 PV1–PV6, §13.2 negative tests).
//
// Positive cases are real pdf.js `saveDocument()` outputs (the writer contract tests additionally run the verifier
// over every PWP-17 contract output). Negative cases take such an output apart with the strict reader, change ONE
// thing, and rebuild a well-formed revision around it (`rebuild`), so each case fails for the reason it names.
// Every negative case asserts the specific check id and reason code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { core, fixture } from './_helpers.mjs';

const S = core.state;
const SA = core.storageAdapter;
const V = core.verify;
const C = core.classify;
const R = core.reader;
const require = createRequire(import.meta.url);
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const skipWriter = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13) ? false : 'pdf.js saveDocument() needs Node >= 22.13';
if (skipWriter) console.warn(`verify: SKIPPED the cases built on pdf.js outputs (${skipWriter})`);

const L1 = (s) => Buffer.from(s, 'latin1');
const latin1 = (u8, a = 0, b = u8.length) => Buffer.from(u8.buffer, u8.byteOffset + a, b - a).toString('latin1');
const AUTHOR = 'Verifier Test';
const DATE0 = Date.UTC(2026, 10, 21, 10, 0, 0);

// ---------------------------------------------------------------- pdf.js writer (as media/pdfWriter.js does it)

let pdfjsLib;
async function openPdfjs(bytes) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
  });
  return { task, doc: await task.promise };
}
async function pdfjsWrite(base, storage) {
  const { task, doc } = await openPdfjs(base.slice());
  try {
    for (const [k, v] of storage) doc.annotationStorage.setValue(k, v);
    return new Uint8Array(await doc.saveDocument());
  } finally { await task.destroy(); }
}
/** Fillable widgets of page 1 (pdf.js view): id, kind. */
async function widgets(base) {
  const { task, doc } = await openPdfjs(base.slice());
  try {
    const an = await (await doc.getPage(1)).getAnnotations();
    return an.filter((a) => a.subtype === 'Widget' && !a.readOnly && a.fieldType !== 'Sig')
      .map((a) => ({ id: a.id, kind: a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Btn' ? 'button' : 'choice', checkBox: !!a.checkBox, multiLine: !!a.multiLine }));
  } finally { await task.destroy(); }
}

// ---------------------------------------------------------------- scenarios

const quadAt = (pg, k, w = 180) => {
  const b = pg.cropBox ?? pg.mediaBox;
  const top = b.y1 - 90 - 26 * k, left = b.x0 + 60;
  return [left, top, left + w, top, left, top - 14, left + w, top - 14];
};
const hl = (page, pages, k, comment = '', color = 'yellow') => ({ op: 'addAnnotation', spec: { kind: 'highlight', localId: 100 + k + 10 * page, page, quads: quadAt(pages[page], k), color, comment } });
const ink = (page, pages, comment = '') => {
  const b = pages[page].mediaBox;
  return { op: 'addAnnotation', spec: { kind: 'ink', localId: 900 + page, page, color: 'red', width: 2, comment, paths: [[b.x0 + 80, b.y0 + 300, b.x0 + 120, b.y0 + 340, b.x0 + 160, b.y0 + 300]] } };
};

/** Classify, apply ops through the real state API, run the real writer. */
async function scenario(fx, build, { forms = false } = {}) {
  const base = fixture(fx);
  const cls = C.classifySync(base, { forms });
  assert.ok(cls.editable, `${fx}: not editable (${cls.detail})`);
  const ctx = cls.context;
  const state = S.emptyState();
  let t = 0;
  const env = { now: () => new Date(DATE0 + 1000 * t++).toISOString(), baseline: new Map() };
  for (const op of build(cls)) {
    const plan = S.applyEdit(state, op, ctx, env);
    assert.ok(plan.ok, `${fx}: op refused ${JSON.stringify(plan.error)}`);
  }
  const entries = SA.toStorageEntries(state, { deletable: cls.context.deletable, pages: cls.context.pages, author: AUTHOR });
  const out = await pdfjsWrite(base, JSON.parse(JSON.stringify(entries)));
  return { fx, base, cls, state, out, baseFile: R.openPdfSync(base) };
}

function verify(sc, out = sc.out, over = {}, options = {}) {
  return V.verifySaveSync({
    base: sc.base, out, classification: sc.cls, state: over.state ?? sc.state, author: AUTHOR,
    observed: over.observed ?? V.expectedObserved(sc.cls, sc.state), ...(over.baseFile ? { baseFile: over.baseFile } : {}),
  }, options);
}
const show = (r) => V.formatFindings(r);
function passes(sc, out, over, options) {
  const r = verify(sc, out, over, options);
  assert.ok(r.ok, `expected to pass:\n${show(r)}`);
  return r;
}
function refused(sc, out, check, code, over, options) {
  const r = verify(sc, out, over, options);
  assert.ok(!r.ok, `expected ${check} ${code}, but the output passed`);
  assert.ok(r.findings.some((f) => f.check === check && f.code === code), `expected ${check} ${code}, got:\n${show(r)}`);
  for (const f of r.findings) assert.ok(V.VERIFY_CODES[f.check].includes(f.code), `code ${f.code} is not listed under ${f.check}`);
  return r;
}

// ---------------------------------------------------------------- taking a revision apart and rebuilding it

/** The appended revision of `out` as editable text: objects (num, gen, body) and raw trailer values. */
function split(sc, out = sc.out) {
  const f = R.openPdfSync(out);
  const rev = f.revisions.at(-1);
  const objects = [];
  for (const e of rev.entries()) {
    if (e.type !== 'offset' || e.num === rev.xrefStreamNum) continue;
    const o = f.resolve(e.num, e.gen);
    objects.push({ num: e.num, gen: e.gen, body: latin1(out, o.value.start, o.value.end) });
  }
  const free = [...rev.entries()].filter((e) => e.type === 'free' && e.num !== 0).map((e) => ({ num: e.num, gen: e.gen }));
  const trailer = new Map();
  for (const [k, v] of rev.trailer.entries) {
    if (['Type', 'W', 'Index', 'Length', 'Filter'].includes(k)) continue;
    trailer.set(k, latin1(out, v.start, v.end));
  }
  return { objects, free, trailer, kind: rev.kind, size: rev.size };
}

/** Base text of an object of the base (dictionary, or a stream with its data). */
function baseBody(sc, num) {
  const o = sc.baseFile.resolve(num);
  return latin1(sc.base, o.value.start, o.value.end);
}
const obj = (parts, num) => parts.objects.find((o) => o.num === num);
const setBody = (parts, num, fn) => { const o = obj(parts, num); assert.ok(o, `object ${num} not in the revision`); o.body = fn(o.body); return parts; };
const withKey = (body, k, v) => body.replace(/>>\s*$/, ` /${k} ${v}>>`);
const streamBody = (dict, data) => `${dict.replace(/\/Length \d+/, `/Length ${Buffer.byteLength(data, 'latin1')}`)} stream\n${data}\nendstream`;

/**
 * Write `base` + one revision like pdf.js does: "\n", the objects, then a classic table (or a cross-reference
 * stream), the trailer, `startxref N %%EOF`. Options: kind ('table' | 'stream' | 'hybrid'), trailer overrides
 * (null removes), extra entries, a tail suffix, bytes inserted before the section, and a forced startxref.
 */
function rebuild(base, parts, o = {}) {
  const chunks = [L1('\n')];
  let off = base.length + 1;
  const entries = [];
  for (const ob of parts.objects) {
    const b = L1(`${ob.num} ${ob.gen} obj\n${ob.body}\nendobj\n`);
    entries.push({ num: ob.num, type: 1, a: off, b: ob.gen });
    chunks.push(b); off += b.length;
  }
  for (const f of parts.free) entries.push({ num: f.num, type: 0, a: 0, b: f.gen });
  for (const e of o.extraEntries ?? []) entries.push(e);
  if (o.insert) { chunks.push(L1(o.insert)); off += o.insert.length; }
  const kind = o.kind ?? parts.kind;
  const maxNum = Math.max(...entries.map((e) => e.num), 0);
  const tr = new Map(parts.trailer);
  for (const [k, v] of Object.entries(o.trailer ?? {})) v === null ? tr.delete(k) : tr.set(k, v);
  const trailerText = (size) => {
    const t = new Map(tr);
    if (!(o.trailer && 'Size' in o.trailer)) t.set('Size', String(size));
    return [...t].map(([k, v]) => `/${k} ${v}`).join(' ');
  };
  const indexOf = (list) => {
    const idx = []; for (const e of list) { if (idx.length && idx.at(-2) + idx.at(-1) === e.num) idx[idx.length - 1]++; else idx.push(e.num, 1); }
    return idx;
  };
  const xrefStream = (num, list, extraDict) => {
    const sorted = [...list].sort((a, b) => a.num - b.num);
    const rows = Buffer.alloc(sorted.length * 7);
    sorted.forEach((e, i) => { rows[i * 7] = e.type; rows.writeUInt32BE(e.a, i * 7 + 1); rows.writeUInt16BE(e.b, i * 7 + 5); });
    return Buffer.concat([L1(`${num} 0 obj\n<< ${extraDict} /Type /XRef /Index [${indexOf(sorted).join(' ')}] /W [1 4 2] /Length ${rows.length}>> stream\n`), rows, L1('\nendstream\nendobj\n')]);
  };
  let startxref = off;
  if (kind === 'stream') {
    const num = Math.max(maxNum + 1, parts.size - 1);
    entries.push({ num, type: 1, a: off, b: 0 });
    chunks.push(xrefStream(num, entries, trailerText(Math.max(num + 1, parts.size))));
  } else {
    let xrefStmText = '';
    if (kind === 'hybrid') {
      const num = Math.max(maxNum + 1, parts.size);
      entries.push({ num, type: 1, a: off, b: 0 });
      const s = xrefStream(num, entries, `/Size ${num + 1}`);
      xrefStmText = ` /XRefStm ${off}`;
      chunks.push(s); off += s.length; startxref = off;
    }
    const sorted = [...entries].sort((a, b) => a.num - b.num);
    let x = 'xref\n';
    let i = 0;
    for (let k = 0; k < sorted.length;) {
      let n = 1; while (k + n < sorted.length && sorted[k + n].num === sorted[k].num + n) n++;
      x += `${sorted[k].num} ${n}\n`;
      for (let j = 0; j < n; j++, i++) {
        const e = sorted[k + j];
        x += `${String(e.a).padStart(10, '0')} ${String(e.b).padStart(5, '0')} ${e.type === 0 ? 'f' : 'n'}\r\n`;
      }
      k += n;
    }
    if (o.xrefText) x = o.xrefText(x);
    const size = Math.max(sorted.at(-1).num + 1, parts.size);
    chunks.push(L1(`${x}trailer\n<< ${trailerText(size)}${xrefStmText}>>\n`));
  }
  chunks.push(L1(`startxref\n${o.startxref ?? startxref}\n%%EOF\n${o.tail ?? ''}`));
  return new Uint8Array(Buffer.concat([Buffer.from(base), ...chunks]));
}

/** Highest object number + 1 of the appended section (a fresh new number). */
const fresh = (parts) => Math.max(parts.size, ...parts.objects.map((o) => o.num + 1));
/** Numbers of the new objects of the scenario by kind ("Highlight", "Popup", "Form", "Page"). */
function nums(sc, parts = split(sc)) {
  const out = {};
  for (const o of parts.objects) {
    const k = /\/Subtype\s*\/(\w+)/.exec(o.body)?.[1] ?? (/\/Type\s*\/Page\b/.test(o.body) ? 'Page' : 'Other');
    (out[k] ??= []).push(o.num);
  }
  return out;
}

// ---------------------------------------------------------------- scenarios (built once)

const SC = {};
if (!skipWriter) {
  SC.basic = await scenario('basic.pdf', (c) => [hl(0, c.context.pages, 0, 'A comment')]);
  SC.basicPlain = await scenario('basic.pdf', (c) => [hl(0, c.context.pages, 0)]);
  SC.stream = await scenario('xref-stream.pdf', (c) => [hl(0, c.context.pages, 0, 'On a stream file')]);
  SC.annotated = await scenario('annotated.pdf', (c) => [hl(0, c.context.pages, 8, 'mixed'), { op: 'removeAnnotation', target: { ref: S.parseRefKey([...c.context.deletable.keys()][0]) } }]);
  SC.multi = await scenario('multi-revision.pdf', (c) => [hl(0, c.context.pages, 0)]);
  SC.tagged = await scenario('tagged.pdf', (c) => [ink(0, c.context.pages, 'Ink on tagged')]);
  SC.signed = await scenario('signed.pdf', (c) => [hl(0, c.context.pages, 0, 'signed')]);
  SC.word = await scenario('word.pdf', (c) => [hl(0, c.context.pages, 0, 'On a Word file'), ink(0, c.context.pages)]);
  SC.hybrid = await scenario('hybrid-xref.pdf', (c) => [hl(0, c.context.pages, 0)]);
  const fw = await widgets(fixture('forms.pdf'));
  const text = fw.find((w) => w.kind === 'text'), box = fw.find((w) => w.checkBox);
  SC.forms = await scenario('forms.pdf', () => [{ op: 'setFields', values: [{ ref: SA.parsePdfjsId(text.id), value: 'Verified value' }, { ref: SA.parsePdfjsId(box.id), value: true }] }], { forms: true });
  SC.formsText = SA.parsePdfjsId(text.id);
  SC.formsBox = SA.parsePdfjsId(box.id);
  // A value the field's font (Helvetica, WinAnsi) cannot encode: pdf.js drops the widget /AP and adds /NeedAppearances
  // true to the (indirect) AcroForm (spec §8.5, PWP-28).
  SC.formsGlyph = await scenario('forms.pdf', () => [{ op: 'setFields', values: [{ ref: SA.parsePdfjsId(text.id), value: '日本語' }] }], { forms: true });
}
const W = { skip: skipWriter };

// ================================================================ positive

test('real pdf.js outputs pass: table, stream, removal, multi-revision, tagged, signed, fields, hybrid bases', W, () => {
  for (const k of ['basic', 'basicPlain', 'stream', 'annotated', 'multi', 'tagged', 'signed', 'forms', 'word', 'hybrid']) {
    const r = passes(SC[k], SC[k].out);
    assert.ok(r.stats.newObjects >= 0 && r.stats.appendedBytes === SC[k].out.length - SC[k].base.length, k);
  }
  // hybrid bases: pdf.js appends a plain classic table (spec §6.5 PV2)
  assert.equal(SC.word.baseFile.xrefKind, 'hybrid');
  assert.equal(R.openPdfSync(SC.word.out).revisions.at(-1).kind, 'table');
});

test('the async verifier agrees, with and without a pre-opened base', W, async () => {
  const sc = SC.annotated;
  const input = { base: sc.base, out: sc.out, classification: sc.cls, state: sc.state, author: AUTHOR, observed: V.expectedObserved(sc.cls, sc.state) };
  assert.ok((await V.verifySave(input)).ok);
  assert.ok((await V.verifySave({ ...input, baseFile: sc.baseFile })).ok);
  const bad = sc.out.slice(); bad[10] ^= 1;
  const r = await V.verifySave({ ...input, out: bad });
  assert.deepStrictEqual(r.findings, [{ check: 'PV1', code: 'prefix-differs' }]);
});

test('rebuild() reproduces an accepted revision (the negative cases change one thing from here)', W, () => {
  for (const k of ['basic', 'stream', 'annotated', 'forms', 'word', 'tagged', 'signed']) passes(SC[k], rebuild(SC[k].base, split(SC[k])));
});

test('policy tables: hybrid bases get a classic table; the AcroForm row stays refused (decided, PWP-28)', () => {
  assert.deepStrictEqual(V.allowedAppendedKinds('table'), ['table']);
  assert.deepStrictEqual(V.allowedAppendedKinds('stream'), ['stream']);
  assert.deepStrictEqual(V.allowedAppendedKinds('hybrid'), ['table']);
  assert.equal(V.ACROFORM_SUPERSEDE_RULE, null);
  assert.equal(V.SUPERSEDE_RULES.acroform, null);
  for (const k of ['catalog', 'struct', 'info', 'pages', 'annot', 'stream', 'other']) assert.equal(V.SUPERSEDE_RULES[k], null, k);
  assert.deepStrictEqual([...V.SUPERSEDE_RULES.page.keys], ['Annots']);
});

test('decoded-value comparison: string forms, numbers, key order and null keys', () => {
  const p = (s) => R.parseObject(L1(s), 0).value;
  assert.ok(V.equalValues(p('<< /A (abc) /B 1 >>'), p('<< /B 1.0 /A <616263> >>')));
  assert.ok(!V.equalValues(p('(caf\\351)'), p('<FEFF0063006100660065>')));
  assert.ok(V.equalValues(p('(caf\\351)'), p('<FEFF00630061006600E9>')));
  assert.ok(V.equalValues(p('<< /A 1 /N null >>'), p('<< /A 1 >>')));
  assert.ok(V.equalValues(p('[0.1234567890123 1]'), p('[0.1234567890 1]')));
  assert.ok(!V.equalValues(p('[0.1235 1]'), p('[0.1234 1]')));
  assert.ok(!V.equalValues(p('<< /A 1 0 R >>'), p('<< /A 1 1 R >>')));
  assert.ok(!V.equalValues(p('/A'), p('(A)')));
  assert.equal(V.decodeTextString(new Uint8Array([0x80, 0xA0, 0x41])), '•€A');
  assert.equal(V.decodeTextString(new Uint8Array([0xEF, 0xBB, 0xBF, 0xC3, 0xA9])), 'é');
});

// ================================================================ PV1

test('PV1: a changed byte of the prefix, or an output that is not longer, is refused', W, () => {
  const sc = SC.basic;
  for (const at of [0, 100, sc.base.length - 1]) {
    const bad = sc.out.slice(); bad[at] ^= 0x20;
    const r = refused(sc, bad, 'PV1', 'prefix-differs');
    assert.equal(r.findings.length, 1);
  }
  refused(sc, sc.base.slice(), 'PV1', 'not-longer');
  refused(sc, sc.base.slice(0, -10), 'PV1', 'not-longer');
});

// ================================================================ PV2

test('PV2: two appended revisions', W, () => {
  const sc = SC.basic;
  const twice = rebuild(sc.out, { ...split(sc), trailer: new Map([...split(sc).trailer, ['Prev', String(R.openPdfSync(sc.out).startxref)]]) });
  refused(sc, twice, 'PV2', 'revision-count');
  // a second revision whose /Prev skips the first appended one: the first is then unaccounted for
  refused(sc, rebuild(sc.out, split(sc)), 'PV2', 'stray-bytes');
});

test('PV2: trailer not chained: /Prev to an older revision, /Prev nonsense, startxref at the base section', W, () => {
  const sc = SC.multi;
  const older = String(sc.baseFile.revisions[0].startxref);
  refused(sc, rebuild(sc.base, split(sc), { trailer: { Prev: older } }), 'PV2', 'prev-mismatch');
  refused(SC.basic, rebuild(SC.basic.base, split(SC.basic), { trailer: { Prev: '7' } }), 'PV2', 'out-unreadable');
  refused(SC.basic, rebuild(SC.basic.base, split(SC.basic), { startxref: SC.basic.baseFile.startxref }), 'PV2', 'revision-count');
});

test('PV2: /Root, /Info, /ID, /Encrypt and extra trailer keys', W, () => {
  const sc = SC.basic;
  const p = () => split(sc);
  refused(sc, rebuild(sc.base, p(), { trailer: { Root: '3 0 R' } }), 'PV2', 'root-changed');
  refused(sc, rebuild(sc.base, p(), { trailer: { Root: null } }), 'PV2', 'root-changed');
  refused(sc, rebuild(sc.base, p(), { trailer: { Info: null } }), 'PV2', 'info-changed');
  refused(sc, rebuild(sc.base, p(), { trailer: { Info: '<< /Title (x) >>' } }), 'PV2', 'info-changed');
  refused(sc, rebuild(sc.base, p(), { trailer: { Encrypt: '3 0 R' } }), 'PV2', 'encrypt');
  refused(sc, rebuild(sc.base, p(), { trailer: { Foo: '1' } }), 'PV2', 'trailer-key');
  refused(sc, rebuild(sc.base, p(), { trailer: { ID: '[<00> <01>]' } }), 'PV2', 'id-malformed');
  const sg = SC.signed;
  refused(sg, rebuild(sg.base, split(sg), { trailer: { ID: '[<DEADBEEF> <01>]' } }), 'PV2', 'id-changed');
  refused(sg, rebuild(sg.base, split(sg), { trailer: { ID: null } }), 'PV2', 'id-malformed');
  // the second /ID element may differ
  passes(sg, rebuild(sg.base, split(sg), { trailer: { ID: split(sg).trailer.get('ID').replace(/\]\s*$/, '').replace(/(<[^>]*>|\((?:\\.|[^\\)])*\))\s*$/, '<0123>') + ']' } }));
});

test('PV2: cross-reference kind must match the base (table, stream; hybrid base -> table, never an appended hybrid)', W, () => {
  refused(SC.basic, rebuild(SC.basic.base, split(SC.basic), { kind: 'stream' }), 'PV2', 'xref-kind');
  refused(SC.stream, rebuild(SC.stream.base, split(SC.stream), { kind: 'table' }), 'PV2', 'xref-kind');
  refused(SC.word, rebuild(SC.word.base, split(SC.word), { kind: 'stream' }), 'PV2', 'xref-kind');
  const hy = rebuild(SC.word.base, split(SC.word), { kind: 'hybrid' });
  assert.equal(R.openPdfSync(hy).revisions.at(-1).kind, 'hybrid', 'the reader sees the appended hybrid section');
  refused(SC.word, hy, 'PV2', 'xref-kind');
  refused(SC.basic, rebuild(SC.basic.base, split(SC.basic), { kind: 'hybrid' }), 'PV2', 'xref-kind');
});

test('PV2: stray bytes, junk after %%EOF, an unlisted object, malformed xref, wrong /Size', W, () => {
  const sc = SC.basic;
  refused(sc, rebuild(sc.base, split(sc), { insert: '% a comment\n' }), 'PV2', 'stray-bytes');
  refused(sc, rebuild(sc.base, split(sc), { insert: '99 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n' }), 'PV2', 'stray-bytes');
  refused(sc, rebuild(sc.base, split(sc), { tail: 'junk' }), 'PV2', 'eof');
  refused(sc, rebuild(sc.base, split(sc), { tail: '1 0 obj\n' }), 'PV2', 'eof');
  refused(sc, rebuild(sc.base, split(sc), { xrefText: (x) => x.replace(/ n\r\n/, ' x\r\n') }), 'PV2', 'out-unreadable');
  refused(sc, rebuild(sc.base, split(sc), { trailer: { Size: '500' } }), 'PV2', 'size-mismatch');
  refused(sc, rebuild(sc.base, split(sc), { trailer: { Size: '3' } }), 'PV2', 'out-unreadable');
  // an appended object whose stream /Length lies
  const p = split(sc); const f = nums(sc, p).Form[0];
  setBody(p, f, (b) => b.replace(/\/Length (\d+)/, (_, n) => `/Length ${Number(n) + 3}`));
  refused(sc, rebuild(sc.base, p), 'PV2', 'out-unreadable');
});

// ================================================================ PV3

test('PV3: entries that point at the wrong place, into the base, or into an object stream', W, () => {
  const sc = SC.basic;
  refused(sc, rebuild(sc.base, split(sc), { xrefText: (x) => x.replace(/(\d{10}) 00000 n/, (_, o) => `${String(Number(o) + 1).padStart(10, '0')} 00000 n`) }), 'PV3', 'entry-target');
  const font = sc.baseFile.entry(4);
  assert.equal(font.type, 'offset');
  refused(sc, rebuild(sc.base, split(sc), { extraEntries: [{ num: 4, type: 1, a: font.offset, b: 0 }] }), 'PV3', 'entry-outside-append');
  refused(SC.stream, rebuild(SC.stream.base, split(SC.stream), { extraEntries: [{ num: 3, type: 2, a: 1, b: 0 }] }), 'PV3', 'objstm-entry');
  const p = split(sc); p.objects.push({ num: 0, gen: 0, body: '<< >>' });
  refused(sc, rebuild(sc.base, p), 'PV3', 'object-zero');
});

test('PV3: free entries are exactly the removed annotations and their Popups', W, () => {
  const sc = SC.annotated;
  const p = split(sc);
  assert.ok(p.free.length >= 1);
  refused(sc, rebuild(sc.base, { ...p, free: [] }), 'PV3', 'free-missing');
  refused(sc, rebuild(sc.base, { ...p, free: [...p.free, { num: 4, gen: 1 }] }), 'PV3', 'free-unexpected');
  refused(sc, rebuild(sc.base, { ...p, free: p.free.map((f) => ({ ...f, gen: 7 })) }), 'PV3', 'free-gen');
  refused(SC.basic, rebuild(SC.basic.base, { ...split(SC.basic), free: [{ num: 7, gen: 1 }] }), 'PV3', 'free-unexpected');
});

test('PV3: generations of new and superseded objects', W, () => {
  const sc = SC.basic;
  const p = split(sc);
  const page = nums(sc, p).Page[0];
  obj(p, page).gen = 1;
  refused(sc, rebuild(sc.base, p), 'PV3', 'superseded-gen');
  const q = split(sc);
  const pop = nums(sc, q).Popup[0];
  obj(q, pop).gen = 1;
  refused(sc, rebuild(sc.base, q), 'PV3', 'new-gen');
});

// ================================================================ PV4 — superseded objects

test('PV4: the catalog may not be superseded (with /OpenAction: also PV5)', W, () => {
  const sc = SC.basic;
  const root = sc.baseFile.trailer.entries.get('Root').num;
  const p = split(sc);
  p.objects.push({ num: root, gen: 0, body: withKey(baseBody(sc, root), 'OpenAction', '<< /S /JavaScript /JS (app.alert\\(1\\)) >>') });
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'catalog-superseded');
  assert.ok(r.findings.some((f) => f.check === 'PV5' && f.code === 'action-introduced' && f.obj === root));
  const q = split(sc); q.objects.push({ num: root, gen: 0, body: baseBody(sc, root) });
  refused(sc, rebuild(sc.base, q), 'PV4', 'catalog-superseded');
});

test('PV4: AcroForm supersession is refused (pdf.js /NeedAppearances for a value it cannot draw; plain copy)', W, () => {
  const g = refused(SC.formsGlyph, SC.formsGlyph.out, 'PV4', 'need-appearances');
  assert.ok(g.findings.some((f) => f.code === 'appearance-missing' && f.obj === SC.formsText.num), show(g));
  assert.equal(V.verifyFailureMessage(g), V.FIELD_APPEARANCE_MESSAGE);
  const sc = SC.forms;
  const cat = sc.baseFile.resolve(sc.baseFile.trailer.entries.get('Root').num).value;
  const af = cat.entries.get('AcroForm').num;
  const p = split(sc); p.objects.push({ num: af, gen: 0, body: baseBody(sc, af) });
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'acroform-superseded');
  assert.equal(V.verifyFailureMessage(r), V.SAVE_REFUSED_MESSAGE);
  // /NeedAppearances together with any other change is the plain refusal
  const q = split(sc); q.objects.push({ num: af, gen: 0, body: withKey(withKey(baseBody(sc, af), 'NeedAppearances', 'true'), 'DA', '(/Helv 0 Tf)') });
  refused(sc, rebuild(sc.base, q), 'PV4', 'acroform-superseded');
});

test('PV4: content streams, the structure tree, /Info, the page tree node are never superseded', W, () => {
  const sc = SC.basic;
  const page = sc.baseFile.resolve(sc.cls.pages[0].ref.num).value;
  const contents = page.entries.get('Contents');
  const cnum = contents.kind === 'array' ? contents.items[0].num : contents.num;
  const p = split(sc); p.objects.push({ num: cnum, gen: 0, body: baseBody(sc, cnum) });
  refused(sc, rebuild(sc.base, p), 'PV4', 'stream-superseded');
  const info = sc.baseFile.trailer.entries.get('Info').num;
  const q = split(sc); q.objects.push({ num: info, gen: 0, body: withKey(baseBody(sc, info), 'Subject', '(changed)') });
  refused(sc, rebuild(sc.base, q), 'PV4', 'info-superseded');
  const pagesNum = page.entries.get('Parent').num;
  const r = split(sc); r.objects.push({ num: pagesNum, gen: 0, body: baseBody(sc, pagesNum) });
  refused(sc, rebuild(sc.base, r), 'PV4', 'pages-superseded');
  const tg = SC.tagged;
  const cat = tg.baseFile.resolve(tg.baseFile.trailer.entries.get('Root').num).value;
  const st = cat.entries.get('StructTreeRoot').num;
  const s = split(tg); s.objects.push({ num: st, gen: 0, body: baseBody(tg, st) });
  refused(tg, rebuild(tg.base, s), 'PV4', 'struct-superseded');
});

test('PV4: a page may change only /Annots: /MediaBox, /Contents, /Resources, an added /AA are refused', W, () => {
  const sc = SC.basic;
  const page = nums(sc).Page[0];
  for (const [k, v] of [['MediaBox', '[0 0 100 100]'], ['Contents', '[]'], ['Rotate', '90'], ['Resources', '<< >>']]) {
    const p = split(sc);
    setBody(p, page, (b) => (new RegExp(`/${k}\\b`).test(b) ? b.replace(new RegExp(`/${k}\\s*(\\[[^\\]]*\\]|\\d+)`), `/${k} ${v}`) : withKey(b, k, v)));
    if (k === 'Resources') setBody(p, page, (b) => withKey(b.replace(/\/Resources\s*<<[\s\S]*?>>\s*\/XObject[\s\S]*?\/ExtGState <<>>>>/, ''), 'Resources', v));
    refused(sc, rebuild(sc.base, p), 'PV4', 'superseded-key');
  }
  const p = split(sc);
  setBody(p, page, (b) => withKey(b, 'AA', '<< /O << /S /JavaScript /JS (1) >> >>'));
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'superseded-key');
  assert.ok(r.findings.some((f) => f.check === 'PV5' && f.code === 'action-introduced'));
  const q = split(sc);
  setBody(q, page, (b) => `${b.replace(/>>\s*$/, '>>')}`);
  const body = obj(q, page).body;
  obj(q, page).body = `${body.replace(/\/Length \d+/, '')} stream\n\nendstream`.replace('>> stream', ' /Length 0>> stream');
  refused(sc, rebuild(sc.base, q), 'PV4', 'kind-changed');
});

test('PV4: page /Annots must be inline and exactly "old - removed + added"', W, () => {
  const sc = SC.annotated;
  const page = sc.cls.pages[0].ref.num;
  const freed = new Set(SA.expectedFreed(sc.state, { deletable: sc.cls.context.deletable }).map(S.refKey));
  const keepRef = sc.cls.pages[0].annots.find((a) => a.ref && !freed.has(S.refKey(a.ref)));
  // drop a base annotation the request does not remove
  const p = split(sc);
  const kept = keepRef.ref.num;
  setBody(p, page, (b) => b.replace(new RegExp(`\\b${kept} 0 R\\s*`), ''));
  refused(sc, rebuild(sc.base, p), 'PV4', 'annots-mismatch');
  // list a removed annotation again
  const removed = [...sc.state.removed][0].split(' ')[0];
  const q = split(sc);
  setBody(q, page, (b) => b.replace(/\/Annots\s*\[/, `/Annots [${removed} 0 R `));
  refused(sc, rebuild(sc.base, q), 'PV4', 'annots-mismatch');
  // an inline annotation with a URI action: PV4 and PV5
  const r = split(sc);
  setBody(r, page, (b) => b.replace(/\/Annots\s*\[/, '/Annots [<< /Subtype /Link /Rect [0 0 9 9] /A << /S /URI /URI (https://example.invalid) >> >> '));
  const res = refused(sc, rebuild(sc.base, r), 'PV4', 'annots-mismatch');
  assert.ok(res.findings.some((f) => f.check === 'PV5'));
  // /Annots written as a reference
  const b0 = SC.basic; const s = split(b0); const pg = nums(b0, s).Page[0];
  const arr = /\/Annots\s*(\[[^\]]*\])/.exec(obj(s, pg).body)[1];
  const an = fresh(s);
  s.objects.push({ num: an, gen: 0, body: arr });
  setBody(s, pg, (b) => b.replace(/\/Annots\s*\[[^\]]*\]/, `/Annots ${an} 0 R`));
  refused(b0, rebuild(b0.base, s), 'PV4', 'annots-indirect');
});

test('PV4: annotation on the wrong page; unlinked; page rewritten without need; page not rewritten', W, () => {
  const sc = SC.basic;
  assert.ok(sc.cls.pages.length >= 2);
  const p0 = nums(sc).Page[0];
  const p1 = sc.cls.pages[1].ref.num;
  const p = split(sc);
  const arr = /\/Annots\s*(\[[^\]]*\])/.exec(obj(p, p0).body)[1];
  setBody(p, p0, (b) => b.replace(/\/Annots\s*\[[^\]]*\]\s*/, ''));
  p.objects.push({ num: p1, gen: 0, body: baseBody(sc, p1).replace(/\/Annots\s*\[[^\]]*\]/, `/Annots ${arr}`) });
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'annot-wrong-page');
  assert.ok(r.findings.some((f) => f.code === 'page-unexpected' && f.page === 1));
  assert.ok(!r.findings.some((f) => f.code === 'page-missing'), 'page 1 was rewritten (its /Annots dropped)');
  // dropped from /Annots: unlinked
  const q = split(sc);
  setBody(q, p0, (b) => b.replace(/\/Annots\s*\[[^\]]*\]/, '/Annots []'));
  refused(sc, rebuild(sc.base, q), 'PV4', 'annot-unlinked');
  // an untouched page rewritten unchanged
  const s = split(sc); s.objects.push({ num: p1, gen: 0, body: baseBody(sc, p1) });
  refused(sc, rebuild(sc.base, s), 'PV4', 'page-unexpected');
  // the touched page not rewritten
  const t = split(sc); t.objects = t.objects.filter((o) => o.num !== p0);
  const res = refused(sc, rebuild(sc.base, t), 'PV4', 'page-missing');
  assert.ok(res.findings.some((f) => f.code === 'annot-unlinked'));
});

test('PV4: widget and field rows: unrequested field, /MK, other keys, /AP targets', W, () => {
  const sc = SC.forms;
  const w = SC.formsText;
  // the same output for a request that does not set the text field: its rewrite is unrequested
  const p = split(sc);
  const widgetNums = p.objects.filter((o) => /\/Subtype\s*\/Widget/.test(o.body)).map((o) => o.num);
  assert.ok(widgetNums.includes(SC.formsText.num));
  const noFieldState = S.cloneState(sc.state);
  noFieldState.fields.delete(S.refKey(SC.formsText));
  const r = verify(sc, sc.out, { state: noFieldState, observed: V.expectedObserved(sc.cls, noFieldState) });
  assert.ok(r.findings.some((f) => f.check === 'PV4' && f.code === 'field-unexpected' && f.obj === SC.formsText.num), show(r));
  const q = split(sc);
  setBody(q, w.num, (b) => b.replace(/\/BG\s*\[[^\]]*\]/, '/BG [1 0 0]'));
  refused(sc, rebuild(sc.base, q), 'PV4', 'mk-changed');
  const s = split(sc);
  setBody(s, w.num, (b) => b.replace(/\/Rect\s*\[[^\]]*\]/, '/Rect [0 0 500 500]'));
  refused(sc, rebuild(sc.base, s), 'PV4', 'superseded-key');
  const t = split(sc);
  setBody(t, w.num, (b) => withKey(b, 'A', '<< /S /Launch /F (calc.exe) >>'));
  const res = refused(sc, rebuild(sc.base, t), 'PV4', 'superseded-key');
  assert.ok(res.findings.some((f) => f.check === 'PV5' && f.code === 'action-introduced'));
  const u = split(sc);
  const ghost = fresh(u);
  u.objects.push({ num: ghost, gen: 0, body: '<< /Type /Annot /Subtype /Popup /Rect [0 0 1 1] >>' });
  setBody(u, w.num, (b) => b.replace(/\/AP\s*<<\s*\/N\s*\d+ 0 R\s*>>/, `/AP << /N ${ghost} 0 R >>`));
  refused(sc, rebuild(sc.base, u), 'PV4', 'ap-target');
});

test('PV4 field rows (PWP-28): the written value must be the requested one, whatever the read-back says', W, () => {
  const sc = SC.forms;
  const textKey = S.refKey(SC.formsText), boxKey = S.refKey(SC.formsBox);
  const textField = sc.cls.context.fields.get(textKey).field.split(' ')[0] * 1;
  const boxField = sc.cls.context.fields.get(boxKey).field.split(' ')[0] * 1;
  assert.notEqual(textField, SC.formsText.num, 'forms.pdf fields have separate widgets');
  // the honest observed (what was requested) cannot rescue a tampered value
  refused(sc, rebuild(sc.base, setBody(split(sc), textField, (b) => b.replace(/\/V\s*(\((?:\\.|[^\\)])*\)|<[^>]*>)/, '/V (Tampered value)'))), 'PV4', 'value-mismatch');
  refused(sc, rebuild(sc.base, setBody(split(sc), textField, (b) => b.replace(/\/V\s*(\((?:\\.|[^\\)])*\)|<[^>]*>)/, '/V [(Verified value)]'))), 'PV4', 'value-mismatch');
  refused(sc, rebuild(sc.base, setBody(split(sc), boxField, (b) => b.replace(/\/V\s*\/\w+/, '/V /Off'))), 'PV4', 'value-mismatch');
  refused(sc, rebuild(sc.base, setBody(split(sc), SC.formsBox.num, (b) => b.replace(/\/AS\s*\/\w+/, '/AS /Off'))), 'PV4', 'value-mismatch');
  // the checkbox field not rewritten at all: /V stays Off while the widget shows Yes
  const q = split(sc); q.objects = q.objects.filter((o) => o.num !== boxField);
  refused(sc, rebuild(sc.base, q), 'PV4', 'value-mismatch');
  // a separate widget may not take the value itself, nor a non-string /M
  refused(sc, rebuild(sc.base, setBody(split(sc), SC.formsText.num, (b) => withKey(b, 'V', '(Verified value)'))), 'PV4', 'superseded-key');
  refused(sc, rebuild(sc.base, setBody(split(sc), SC.formsText.num, (b) => b.replace(/\/M\s*\([^)]*\)/, '/M 5'))), 'PV4', 'superseded-key');
  // the field node may change /V only
  refused(sc, rebuild(sc.base, setBody(split(sc), textField, (b) => b.replace(/\/Ff\s*0/, '/Ff 1'))), 'PV4', 'superseded-key');
});

test('PV4 field rows (PWP-28): appearances — fresh, own, and never borrowed from another field', W, () => {
  const sc = SC.forms;
  const w = SC.formsText.num;
  const apRe = /\/AP\s*<<\s*\/N\s*(\d+) 0 R\s*>>/;
  const ownForm = Number(apRe.exec(obj(split(sc), w).body)[1]);
  assert.ok(ownForm >= sc.baseFile.size, 'the text widget got a new appearance');
  // the widget's /AP dropped (what pdf.js does when it cannot draw the value; here the AcroForm is not touched)
  const p = split(sc); setBody(p, w, (b) => b.replace(apRe, '')); p.objects = p.objects.filter((o) => o.num !== ownForm);
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'appearance-missing');
  assert.equal(V.verifyFailureMessage(r), V.FIELD_APPEARANCE_MESSAGE);
  // pointing at the appearance stream of another field in the base (the 'code' field's widget)
  const codeWidget = sc.cls.forms.fields.find((f) => f.type === 'text' && f.maxLen === 6).widgets[0].ref.num;
  const otherAp = Number(apRe.exec(baseBody(sc, codeWidget))[1]);
  const q = split(sc); setBody(q, w, (b) => b.replace(apRe, `/AP << /N ${otherAp} 0 R >>`)); q.objects = q.objects.filter((o) => o.num !== ownForm);
  refused(sc, rebuild(sc.base, q), 'PV4', 'appearance-missing');
  // the new appearance also given to another (unrequested) widget: shared, and that widget is unexpected
  const s = split(sc);
  s.objects.push({ num: codeWidget, gen: 0, body: baseBody(sc, codeWidget).replace(apRe, `/AP << /N ${ownForm} 0 R >>`) });
  const res = refused(sc, rebuild(sc.base, s), 'PV4', 'ap-target');
  assert.ok(res.findings.some((f) => f.code === 'field-unexpected' && f.obj === codeWidget), show(res));
  // a checkbox may not change its appearance dictionary at all (pdf.js only switches /AS)
  // (its on-appearance swapped for a radio button's from the base)
  const radioWidget = sc.cls.forms.fields.find((f) => f.type === 'radio').widgets[0].ref.num;
  const radioOn = Number(/\/N\s*<<\s*\/\w+\s+(\d+) 0 R/.exec(baseBody(sc, radioWidget))[1]);
  const t = split(sc); setBody(t, SC.formsBox.num, (b) => b.replace(/(\/N\s*<<\s*\/Yes\s+)\d+/, `$1${radioOn}`));
  assert.ok(obj(t, SC.formsBox.num).body.includes(`/Yes ${radioOn} 0 R`));
  refused(sc, rebuild(sc.base, t), 'PV4', 'superseded-key');
});

test('PV4 field rows (PWP-28): extra fields rewritten; requests outside the fillable set', W, () => {
  const sc = SC.forms;
  // another field and its widget rewritten, unchanged or with a value
  const code = sc.cls.forms.fields.find((f) => f.type === 'text' && f.maxLen === 6);
  const p = split(sc); p.objects.push({ num: code.ref.num, gen: 0, body: baseBody(sc, code.ref.num) });
  refused(sc, rebuild(sc.base, p), 'PV4', 'field-unexpected');
  const q = split(sc); q.objects.push({ num: code.ref.num, gen: 0, body: baseBody(sc, code.ref.num).replace(/\/V\s*<[^>]*>/, '/V (XYZ)') });
  refused(sc, rebuild(sc.base, q), 'PV4', 'field-unexpected');
  // the radio group's field node, not part of the request
  const radio = sc.cls.forms.fields.find((f) => f.type === 'radio');
  const r = split(sc); r.objects.push({ num: radio.ref.num, gen: 0, body: baseBody(sc, radio.ref.num).replace(/\/V\s*\/\w+/, '/V /2') });
  refused(sc, rebuild(sc.base, r), 'PV4', 'field-unexpected');
  // a request that sets a locked field, or a forms-off classification: invalid, never saved
  const locked = sc.cls.forms.fields.find((f) => f.locked === 'read-only').widgets[0].ref;
  const bad = S.cloneState(sc.state); bad.fields.set(S.refKey(locked), 'changed');
  refused(sc, sc.out, 'PV6', 'request-invalid', { state: bad, observed: V.expectedObserved(sc.cls, sc.state) });
  const off = C.classifySync(sc.base);
  const r2 = V.verifySaveSync({ base: sc.base, out: sc.out, classification: off, state: sc.state, author: AUTHOR, observed: V.expectedObserved(sc.cls, sc.state) });
  assert.deepStrictEqual(r2.findings, [{ check: 'PV6', code: 'request-invalid' }]);
  // a value the field's rule refuses (over MaxLen) is invalid as well
  const long = S.cloneState(sc.state); long.fields.set(S.refKey(code.widgets[0].ref), 'ABCDEFG');
  refused(sc, sc.out, 'PV6', 'request-invalid', { state: long });
});

// ================================================================ PV4 — new objects

test('PV4: unexpected new object types (ExtGState, font, JavaScript action, Link annotation, array, stream)', W, () => {
  const sc = SC.basic;
  const bodies = [
    '<< /Type /ExtGState /CA 0.5 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /S /JavaScript /JS (app.alert\\(1\\)) >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 0 9 9] /A << /S /URI /URI (https://example.invalid) >> >>',
    '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /FS << /Type /Filespec /F (x.exe) >> >>',
    '[1 2 3]',
    streamBody('<< /Type /EmbeddedFile /Length 0 >>', 'MZ'),
  ];
  for (const body of bodies) {
    const p = split(sc); p.objects.push({ num: fresh(p), gen: 0, body });
    refused(sc, rebuild(sc.base, p), 'PV4', 'new-kind');
  }
  const p = split(sc); const n = fresh(p); p.objects.push({ num: n, gen: 0, body: bodies[2] });
  const r = refused(sc, rebuild(sc.base, p), 'PV5', 'action-introduced');
  assert.ok(r.findings.some((f) => f.obj === n));
});

test('PV4: new annotation keys and value shapes', W, () => {
  const sc = SC.basic;
  const h = nums(sc).Highlight[0];
  const cases = [
    ['new-key', (b) => withKey(b, 'NM', '(x)')],
    ['new-key', (b) => withKey(b, 'P', `${sc.cls.pages[0].ref.num} 0 R`)],
    ['new-key', (b) => withKey(b, 'A', '<< /S /URI /URI (https://example.invalid) >>')],
    ['new-value', (b) => b.replace(/\/QuadPoints\s*\[/, '/QuadPoints [1 ')],
    ['new-value', (b) => b.replace(/\/C\s*\[[^\]]*\]/, '/C (red)')],
    ['new-value', (b) => b.replace(/\/CA\s*1/, '/CA (opaque)')],
    ['new-kind', (b) => b.replace(/\/Type\s*\/Annot/, '/Type /XObject')],
    ['ap-target', (b) => b.replace(/\/AP\s*<<\s*\/N\s*(\d+ 0 R)\s*>>/, '/AP << /N $1 /D $1 >>')],
    ['ap-target', (b) => b.replace(/\/AP\s*<<\s*\/N\s*\d+ 0 R\s*>>/, '/AP << /N 4 0 R >>')],
    ['popup-link', (b) => b.replace(/\/Popup\s*\d+ 0 R/, '/Popup 4 0 R')],
  ];
  for (const [code, fn] of cases) {
    const p = split(sc); setBody(p, h, fn);
    refused(sc, rebuild(sc.base, p), 'PV4', code);
  }
  const p = split(sc); setBody(p, h, (b) => withKey(b, 'AA', '<< /E << /S /Launch /F (x) >> >>'));
  refused(sc, rebuild(sc.base, p), 'PV5', 'action-introduced');
  // the Popup must point back at its parent
  const q = split(sc); setBody(q, nums(sc, q).Popup[0], (b) => b.replace(/\/Parent\s*\d+ 0 R/, `/Parent ${sc.cls.pages[0].ref.num} 0 R`));
  refused(sc, rebuild(sc.base, q), 'PV4', 'popup-link');
});

test('PV4: appearance streams: resources, fonts, orphans', W, () => {
  const sc = SC.basic;
  const f = nums(sc).Form[0];
  const swap = (from, to) => { const p = split(sc); setBody(p, f, (b) => b.replace(from, to)); return rebuild(sc.base, p); };
  refused(sc, swap('/BM /Multiply', '/BM /Normal'), 'PV4', 'new-value');
  refused(sc, swap('/Resources <<', '/Resources << /XObject << /X1 4 0 R >>'), 'PV4', 'new-value');
  refused(sc, swap('/Resources <<', '/Resources << /Font << /F1 7 0 R >>'), 'PV4', 'font-ref');
  refused(sc, swap('/BM /Multiply', '/BM /Multiply /SMask 4 0 R'), 'PV4', 'new-value');
  refused(sc, swap('/FormType 1', '/FormType 1 /Filter /FlateDecode /Matrix [1 0 0 1 0 0]'), 'PV4', 'new-key');
  const p = split(sc); const n = fresh(p);
  p.objects.push({ num: n, gen: 0, body: streamBody('<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 0 >>', '0 0 m') });
  refused(sc, rebuild(sc.base, p), 'PV4', 'orphan-object');
});

test('PV4: new annotations must match the request (rect, colour, comment) — unexpected, missing', W, () => {
  const sc = SC.basic;
  const h = nums(sc).Highlight[0];
  for (const fn of [(b) => b.replace(/\/Rect\s*\[\s*([\d.]+)/, (_, x) => `/Rect [${Number(x) + 50}`),
    (b) => b.replace(/\/C\s*\[[^\]]*\]/, '/C [1 0 0]'),
    (b) => b.replace(/\/Contents\s*\((?:\\.|[^\\)])*\)/, '/Contents (another text)')]) {
    const p = split(sc); setBody(p, h, fn);
    refused(sc, rebuild(sc.base, p), 'PV4', 'annot-unexpected');
  }
  // nothing added although the request adds a highlight: page rewritten with the old /Annots, no new objects
  const p = split(sc);
  const page = nums(sc, p).Page[0];
  p.objects = p.objects.filter((o) => o.num === page);
  setBody(p, page, (b) => b.replace(/\/Annots\s*\[[^\]]*\]/, '/Annots []'));
  refused(sc, rebuild(sc.base, p), 'PV4', 'annot-missing');
  // two highlights where one is requested
  const q = split(sc);
  const ann = obj(q, h); const n = fresh(q);
  q.objects.push({ num: n, gen: 0, body: ann.body.replace(/\/Popup\s*\d+ 0 R/, '') });
  setBody(q, nums(sc, q).Page[0], (b) => b.replace(/\/Annots\s*\[/, `/Annots [${n} 0 R `));
  refused(sc, rebuild(sc.base, q), 'PV4', 'annot-unexpected');
});

// ================================================================ PV6

test('PV6: observed page count, annotation counts and field values', W, () => {
  const sc = SC.basic;
  const ok = V.expectedObserved(sc.cls, sc.state);
  refused(sc, sc.out, 'PV6', 'page-count', { observed: { ...ok, pageCount: ok.pageCount + 1 } });
  refused(sc, sc.out, 'PV6', 'annot-count', { observed: { ...ok, annotsPerPage: ok.annotsPerPage.map((n, i) => (i === 0 ? n - 1 : n)) } });
  refused(sc, sc.out, 'PV6', 'annot-count', { observed: { ...ok, annotsPerPage: ok.annotsPerPage.slice(1) } });
  const fs = SC.forms;
  const fo = V.expectedObserved(fs.cls, fs.state);
  refused(fs, fs.out, 'PV6', 'field-value', { observed: { ...fo, fields: fo.fields.map((f) => (typeof f.value === 'string' ? { ...f, value: 'other' } : f)) } });
  refused(fs, fs.out, 'PV6', 'field-missing', { observed: { ...fo, fields: fo.fields.slice(1) } });
});

test('PV6: size blow-up, growth cap, a request that does not fit the classification', W, () => {
  const sc = SC.basicPlain;
  const p = split(sc); const f = nums(sc, p).Form[0];
  setBody(p, f, (b) => { const data = /stream\r?\n([\s\S]*)\nendstream$/.exec(b)[1]; return streamBody(b.slice(0, b.indexOf('stream')), data + '\n' + ' '.repeat(80_000)); });
  refused(sc, rebuild(sc.base, p), 'PV6', 'size-budget');
  passes(sc, sc.out, {}, { appendBudget: { fixed: sc.out.length - sc.base.length, perStateByte: 0 } });
  refused(sc, sc.out, 'PV6', 'size-budget', {}, { appendBudget: { fixed: sc.out.length - sc.base.length - 1, perStateByte: 0 } });
  refused(sc, sc.out, 'PV6', 'growth-over-cap', {}, { maxGrowthBytes: 100 });
  const bad = S.cloneState(sc.state); bad.removed.add('9999 0');
  refused(sc, sc.out, 'PV6', 'request-invalid', { state: bad });
});

// ================================================================ diagnostics, hostile input

test('diagnostics: check ids, codes, object numbers and pages only', W, () => {
  const sc = SC.basic;
  const p = split(sc);
  setBody(p, nums(sc, p).Highlight[0], (b) => withKey(b, 'NM', '(SECRET-DOCUMENT-TEXT)'));
  const r = refused(sc, rebuild(sc.base, p), 'PV4', 'new-key');
  const text = V.formatFindings(r);
  assert.ok(!/SECRET/.test(text));
  for (const line of text.split('\n')) assert.match(line, /^(PV[1-6] [a-z-]+( obj \d+)?( page \d+)?|appended \d+ budget \d+ new \d+ superseded \d+ freed \d+)$/);
  assert.ok(JSON.stringify(r.findings).match(/^[\[\]{}",:a-zA-Z0-9-]*$/));
});

test('hostile outputs: 300 seeded mutations of the appended region never pass unless they are byte-identical', W, () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const sc of [SC.basic, SC.stream, SC.annotated]) {
    for (let i = 0; i < 100; i++) {
      const out = sc.out.slice();
      const at = sc.base.length + Math.floor(rnd() * (out.length - sc.base.length));
      const was = out[at];
      out[at] = Math.floor(rnd() * 256);
      const r = verify(sc, out);
      if (out[at] === was) { assert.ok(r.ok); continue; }
      // A change inside a stream body (appearance drawing) or a digit that leaves every check satisfied is possible;
      // anything structural must be refused. Never throws.
      assert.ok(Array.isArray(r.findings));
      if (r.ok) {
        const t = latin1(out, sc.base.length);
        const inStream = [...t.matchAll(/stream\r?\n/g)].some((m) => { const s = m.index + m[0].length; const e = t.indexOf('endstream', s); return at - sc.base.length >= s && at - sc.base.length < e; });
        const rel = at - sc.base.length;
        const inString = t.lastIndexOf('(', rel) > Math.max(t.lastIndexOf(')', rel - 1), t.lastIndexOf('/', rel));
        assert.ok(inStream || inString || /[0-9 \r\n]/.test(String.fromCharCode(was)), `mutation at ${at} (${was} -> ${out[at]}) passed`);
      }
    }
  }
});

// ================================================================ performance (§9.3: host verification <= 0.5 s)

/** An object-dense ~100 MB base (like the spike's big-objs-100.pdf) with one page, plus a hand-written revision. */
function denseBase(target = 90 * 1024 * 1024) {
  const pad = 'x'.repeat(200);
  const chunks = [L1('%PDF-1.7\n')]; let off = chunks[0].length;
  const offs = [0];
  const push = (s) => { const b = L1(s); chunks.push(b); off += b.length; };
  offs[1] = off; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offs[2] = off; push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offs[3] = off; push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n');
  let n = 4;
  while (off < target) { offs[n] = off; push(`${n} 0 obj\n<< /Type /Thing /N ${n} /S (${pad}) >>\nendobj\n`); n++; }
  const xref = off;
  const rows = new Array(n); rows[0] = '0000000000 65535 f \n';
  for (let i = 1; i < n; i++) rows[i] = `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  push(`xref\n0 ${n}\n${rows.join('')}trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { bytes: new Uint8Array(Buffer.concat(chunks)), size: n };
}

/** What pdf.js would append for one highlight: page 3 with /Annots, the annotation and its appearance. */
function handWrittenHighlight(base, size, entry) {
  const [x0, y0, x1, y1] = entry.rect;
  const c = entry.color.map((v) => (v / 255).toFixed(10).replace(/0+$/, '').replace(/\.$/, '')).join(' ');
  const data = `${c} rg\n/R0 gs\n${x0} ${y1} m\n${x1} ${y1} l\n${x1} ${y0} l\n${x0} ${y0} l\nh\nf*`;
  const parts = {
    objects: [
      { num: 3, gen: 0, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [${size} 0 R]>>` },
      { num: size, gen: 0, body: `<< /Type /Annot /Subtype /Highlight /CreationDate (D:20261121100000) /Rect [${entry.rect.join(' ')}] /F 4 /Border [0 0 0] /Rotate 0 /QuadPoints [${entry.quadPoints.join(' ')}] /C [${c}] /CA 1 /T (${AUTHOR}) /AP << /N ${size + 1} 0 R>>>>` },
      { num: size + 1, gen: 0, body: streamBody(`<< /FormType 1 /Subtype /Form /Type /XObject /BBox [${entry.rect.join(' ')}] /Length 0 /Resources << /ExtGState << /R0 << /BM /Multiply>>>>>>>>`, data) },
    ],
    free: [], trailer: new Map([['Prev', String(R.openPdfSync(base).startxref)], ['Root', '1 0 R']]), kind: 'table', size,
  };
  return rebuild(base, parts);
}

test('performance: ~100 MB object-dense base, verification within budget and the event loop stays responsive', async (t) => {
  const { bytes: base, size } = denseBase();
  const cls = C.classifySync(base);
  assert.ok(cls.editable, cls.detail);
  const state = S.emptyState();
  assert.ok(S.applyEdit(state, hl(0, cls.context.pages, 0), cls.context, { now: () => new Date(DATE0).toISOString() }).ok);
  const [[, entry]] = SA.toStorageEntries(state, { deletable: cls.context.deletable, pages: cls.context.pages, author: AUTHOR });
  const out = handWrittenHighlight(base, size, entry);
  const input = { base, out, classification: cls, state, author: AUTHOR, observed: V.expectedObserved(cls, state) };
  const sync = V.verifySaveSync(input);
  assert.ok(sync.ok, V.formatFindings(sync));

  const baseFile = await R.openPdf(base);
  let last = performance.now(); let maxGap = 0; let on = true;
  const tick = () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; if (on) setImmediate(tick); };
  setImmediate(tick);
  const t0 = performance.now();
  const withBase = await V.verifySave({ ...input, baseFile });
  const msWithBase = performance.now() - t0;
  const t1 = performance.now();
  const cold = await V.verifySave(input);
  const msCold = performance.now() - t1;
  on = false;
  await new Promise((r) => setImmediate(r));
  assert.ok(withBase.ok && cold.ok);
  t.diagnostic(`${(base.length / 1048576).toFixed(1)} MB, ${size} objects: verify with the classified base ${msWithBase.toFixed(0)} ms, cold (opens the base too) ${msCold.toFixed(0)} ms, max event-loop gap ${maxGap.toFixed(1)} ms`);
  assert.ok(msWithBase < 1500, `verify took ${msWithBase.toFixed(0)} ms`);
  assert.ok(maxGap < 100, `event loop blocked for ${maxGap.toFixed(1)} ms`);
  // a tampered prefix is found quickly too
  const bad = out.slice(); bad[base.length - 100] ^= 1;
  const tb = performance.now();
  assert.equal((await V.verifySave({ ...input, out: bad, baseFile })).findings[0].code, 'prefix-differs');
  t.diagnostic(`tampered prefix refused in ${(performance.now() - tb).toFixed(0)} ms`);
});
