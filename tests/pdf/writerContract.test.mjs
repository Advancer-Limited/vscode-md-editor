// PWP-17: storage adapter unit tests and writer contract tests (spec §6.4, §6.5, §13.2).
//
// Contract tests: edit state (built with the real state API) -> storageAdapter.toStorageEntries -> JSON round trip
// (the host -> webview channel) -> the pinned pdf.js writer in Node (`annotationStorage.setValue` + `saveDocument()`)
// -> assertions on the output:
//   PV1 prefix identity; PV2 exactly one appended revision, same cross-reference kind, trailer chained to the base;
//   PV3 entries point at their objects, free entries are exactly the removed annotations and their Popups;
//   PV4 every new and superseded object is on the allow-list of spec §6.5 (superseded objects compared by decoded value);
//   PV5 nothing inert-breaking is introduced; PV6-style counts; PG6 three independent readers (pdf.js, PDFium,
//   @cantoo/pdf-lib) see the annotations with the right subtype, rectangle, colour and comment and the field values.
// Outputs go to tests/.out/pdf/writerContract/<fixture>/<case>.pdf for scripts/verify-pdf-open.mjs.
// These are the tests that fail first when pdf.js is upgraded (spec §13.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { core, fixture } from './_helpers.mjs';
import { assertPg6 } from './_readers.mjs';

const S = core.state;
const SA = core.storageAdapter;
const V = core.verify;
const C = core.classify;
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', '.out', 'pdf', 'writerContract');
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
const skipWriter = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13) ? false : 'pdf.js saveDocument() needs Node >= 22.13';
if (skipWriter) console.warn(`writerContract: SKIPPED the pdf.js writer tests (${skipWriter}; running ${process.versions.node})`);

// ---------------------------------------------------------------- small helpers

const DATE0 = Date.UTC(2026, 10, 21, 10, 0, 0);
function makeEnv() {
  let t = 0;
  return { now: () => new Date(DATE0 + 1000 * t++).toISOString(), baseline: new Map() };
}
const refOf = (id) => SA.parsePdfjsId(id);
const keyOf = (id) => S.refKey(refOf(id));
const jsonRoundTrip = (v) => JSON.parse(JSON.stringify(v));

function writeOut(fx, name, bytes) {
  const dir = path.join(OUT_DIR, fx.replace(/\.pdf$/, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.pdf`), bytes);
}

// ---------------------------------------------------------------- pdf.js (Node)

let pdfjsLib;
async function openPdfjs(bytes) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
  });
  return { task, doc: await task.promise };
}

/** pdf.js view of the requested pages (default: all): boxes and annotations. */
async function inventory(bytes, pageIndices) {
  const { task, doc } = await openPdfjs(bytes);
  try {
    const want = pageIndices ?? [...Array(doc.numPages).keys()];
    const pages = new Map();
    for (const i of want) {
      const p = await doc.getPage(i + 1);
      const an = await p.getAnnotations();
      pages.set(i, {
        view: Array.from(p.view), rotate: p.rotate,
        annots: an.map((a) => ({
          id: a.id, subtype: a.subtype, popupRef: a.popupRef ?? null, rect: a.rect ? Array.from(a.rect) : null,
          color: a.color ? Array.from(a.color) : null, contents: a.contentsObj?.str ?? '',
          fieldType: a.fieldType ?? null, fieldValue: a.fieldValue, readOnly: !!a.readOnly, checkBox: !!a.checkBox,
          radioButton: !!a.radioButton, combo: !!a.combo, multiSelect: !!a.multiSelect,
          exportValue: a.exportValue ?? null, buttonValue: a.buttonValue ?? null,
          options: a.options ? a.options.map((o) => o.exportValue) : null,
        })),
      });
      p.cleanup();
    }
    return { numPages: doc.numPages, pages };
  } finally { await task.destroy(); }
}

/** What the writer service does (spec §6.4 steps 1-2): a fresh document, setValue each entry, saveDocument(). */
async function pdfjsWrite(base, storage) {
  const { task, doc } = await openPdfjs(base.slice());
  try {
    for (const [k, v] of storage) doc.annotationStorage.setValue(k, v);
    return new Uint8Array(await doc.saveDocument());
  } finally { await task.destroy(); }
}

/** The classification the state, adapter and verifier work from: `classify(base, { forms: true })` (PWP-28). */
function classified(base) {
  const cls = C.classifySync(base, { forms: true });
  assert.ok(cls.editable, `classification refuses the base (${cls.detail})`);
  return cls;
}
const contextFrom = (base) => classified(base).context;

// ---------------------------------------------------------------- cases (ops built through the real state API)

const quadAt = (view, k, w = 180) => {
  const [x0, , , y1] = view;
  const top = y1 - 90 - 26 * k, left = x0 + 60;
  return [left, top, left + w, top, left, top - 14, left + w, top - 14];
};
const strokesAt = (view) => {
  const [x0, y0] = view;
  return [[x0 + 80, y0 + 300, x0 + 110, y0 + 340, x0 + 140, y0 + 300.5, x0 + 170, y0 + 340.25], [x0 + 80, y0 + 260, x0 + 200, y0 + 262]];
};
let nextLocal = 1;
const hl = (page, view, k, color = 'yellow', comment = '', nQuads = 1) => ({ op: 'addAnnotation', spec: {
  kind: 'highlight', localId: nextLocal++, page, color, comment,
  quads: Array.from({ length: nQuads }, (_, j) => quadAt(view, k + j, 180 - 40 * j)).flat() } });
const ink = (page, view, color = 'red', width = 2, comment = '') => ({ op: 'addAnnotation', spec: {
  kind: 'ink', localId: nextLocal++, page, color, width, comment, paths: strokesAt(view) } });
const COLOURS = ['yellow', 'green', 'blue', 'pink', 'red'];
const COMMENT = 'Contract comment: café ✓ 日本語 (and a \\ backslash)';

/** name -> (inv) => ops | null (null = not applicable to this fixture). */
const ANNOT_CASES = {
  highlight: (inv) => [hl(0, inv.pages.get(0).view, 0)],
  'highlight-comment': (inv) => [hl(0, inv.pages.get(0).view, 1, 'green', COMMENT, 2)],
  ink: (inv) => [ink(0, inv.pages.get(0).view, 'red', 2)],
  'ink-comment': (inv) => [ink(0, inv.pages.get(0).view, 'blue', 4, 'Ink comment')],
  colours: (inv) => [...COLOURS.map((c, i) => hl(0, inv.pages.get(0).view, 4 + i, c)),
    ...COLOURS.map((c, i) => ink(0, inv.pages.get(0).view.map((v, j) => (j === 0 ? v + 220 + 20 * i : v)), c, [1, 2, 4][i % 3]))],
  'last-page': (inv) => (inv.numPages > 1
    ? [hl(inv.numPages - 1, inv.pages.get(inv.numPages - 1).view, 0, 'pink', 'Last page'), ink(inv.numPages - 1, inv.pages.get(inv.numPages - 1).view, 'red', 1)]
    : null),
  'every-page': (inv) => (inv.numPages > 1 && inv.numPages <= 10
    ? [...inv.pages.keys()].flatMap((p) => [hl(p, inv.pages.get(p).view, 0, COLOURS[p % 5], `Page ${p + 1}`)])
    : null),
};

const deletables = (ctx) => [...ctx.deletable.keys()];
const rm = (key) => ({ op: 'removeAnnotation', target: { ref: S.parseRefKey(key) } });
const REMOVE_CASES = {
  'delete-first': (inv, ctx) => (ctx.deletable.size ? [rm(deletables(ctx)[0])] : null),
  'delete-each-kind': (inv, ctx) => (ctx.deletable.size > 1 ? deletables(ctx).slice(1).map(rm) : null),
  'delete-all': (inv, ctx) => (ctx.deletable.size ? deletables(ctx).map(rm) : null),
  'delete-via-popup': (inv, ctx) => {
    const [popup] = ctx.popups.keys();
    return popup ? [rm(popup)] : null;
  },
  mixed: (inv, ctx) => (ctx.deletable.size
    ? [hl(0, inv.pages.get(0).view, 8, 'blue', 'mixed'), ink(0, inv.pages.get(0).view), rm(deletables(ctx)[0])]
    : null),
};

/** Widgets of a kind that the classification found fillable, from the inventory. */
function widgets(inv, ctx, pred) {
  const out = [];
  for (const p of inv.pages.values()) for (const a of p.annots) if (a.subtype === 'Widget' && ctx.fields.has(keyOf(a.id)) && pred(a)) out.push(a);
  return out;
}
const setF = (...vals) => ({ op: 'setFields', values: vals.map(([id, value]) => ({ ref: refOf(id), value })) });
const FIELD_CASES = {
  'field-text': (inv, ctx) => { const t = widgets(inv, ctx, (a) => a.fieldType === 'Tx'); return t[0] ? [setF([t[0].id, 'Contract value äöü'])] : null; },
  'field-multiline': (inv, ctx) => { const t = widgets(inv, ctx, (a) => a.fieldType === 'Tx'); return t[1] ? [setF([t[1].id, 'Line one\nLine two\nLine three'])] : null; },
  'field-checkbox': (inv, ctx) => { const c = widgets(inv, ctx, (a) => a.checkBox); return c[0] ? [setF([c[0].id, true])] : null; },
  'field-radio': (inv, ctx) => {
    const r = widgets(inv, ctx, (a) => a.radioButton);
    return r.length > 1 ? [setF(...r.map((w, i) => [w.id, i === 1]))] : null;
  },
  'field-combo': (inv, ctx) => { const c = widgets(inv, ctx, (a) => a.fieldType === 'Ch' && a.combo); return c[0] ? [setF([c[0].id, c[0].options.at(-1)])] : null; },
  'field-list': (inv, ctx) => { const c = widgets(inv, ctx, (a) => a.fieldType === 'Ch' && !a.combo); return c[0] ? [setF([c[0].id, c[0].options[Math.min(2, c[0].options.length - 1)]])] : null; },
  'fields-and-highlight': (inv, ctx) => {
    const t = widgets(inv, ctx, (a) => a.fieldType === 'Tx');
    const c = widgets(inv, ctx, (a) => a.checkBox);
    return t[0] && c[0] ? [setF([t[0].id, 'With a highlight'], [c[0].id, true]), hl(0, inv.pages.get(0).view, 20, 'yellow', 'Next to a form')] : null;
  },
};

/** fixture -> case groups. Editable fixtures only (no encryption, no /XRefStm, intact cross-reference). */
const MATRIX = {
  'basic.pdf': [ANNOT_CASES],
  'xref-stream.pdf': [ANNOT_CASES],
  'multi-revision.pdf': [ANNOT_CASES],
  'outline.pdf': [ANNOT_CASES],
  'forms.pdf': [ANNOT_CASES, FIELD_CASES],
  'forms-js.pdf': [{ highlight: ANNOT_CASES.highlight }, FIELD_CASES],
  'annotated.pdf': [ANNOT_CASES, REMOVE_CASES],
  'rotated.pdf': [ANNOT_CASES],
  'attachments.pdf': [{ highlight: ANNOT_CASES.highlight, ink: ANNOT_CASES.ink }],
  'scanned.pdf': [{ highlight: ANNOT_CASES.highlight, 'last-page': ANNOT_CASES['last-page'] }],
  'cjk.pdf': [{ 'highlight-comment': ANNOT_CASES['highlight-comment'] }],
  'base14.pdf': [{ highlight: ANNOT_CASES.highlight }],
  'jpx-jbig2.pdf': [{ highlight: ANNOT_CASES.highlight }],
  'tagged.pdf': [ANNOT_CASES],
  'js-openaction.pdf': [{ highlight: ANNOT_CASES.highlight, 'ink-comment': ANNOT_CASES['ink-comment'] }],
  'word.pdf': [ANNOT_CASES],
  'chrome.pdf': [ANNOT_CASES],
  'signed.pdf': [{ highlight: ANNOT_CASES.highlight, 'ink-comment': ANNOT_CASES['ink-comment'], colours: ANNOT_CASES.colours }],
};

// ---------------------------------------------------------------- revision analysis (test-side PV1-PV5)

const latin1 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('latin1');
const INERT = ['JS', 'JavaScript', 'Launch', 'URI', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'OpenAction', 'AA', 'A', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'Filespec'];
const inertHits = (text) => INERT.filter((k) => new RegExp(`/${k}(?![A-Za-z0-9#])`).test(text));

function lastStartxref(s) {
  const m = [...s.slice(Math.max(0, s.length - 2048)).matchAll(/startxref\s+(\d+)\s+%%EOF/g)].pop();
  return m ? Number(m[1]) : null;
}
function trailerVal(t, k) {
  const m = new RegExp(`/${k}\\s*(\\[[^\\]]*\\]|\\d+ \\d+ R|\\d+|/\\w+)`).exec(t);
  return m ? m[1].replace(/\s+/g, ' ') : null;
}
const firstId = (t) => {
  const m = /\/ID\s*\[\s*(<[^>]*>|\((?:\\.|[^\\)])*\))/.exec(t);
  if (!m) return null;
  const x = m[1];
  if (x.startsWith('<')) return x.slice(1, -1).replace(/\s+/g, '').toLowerCase();
  return Buffer.from(x.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => (/^[0-7]/.test(e)
    ? String.fromCharCode(parseInt(e, 8)) : { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? e)), 'latin1').toString('hex');
};

/** Top-level entries of a dictionary's text ("<< /K v ... >>") as key -> raw value text (whitespace-normalised). */
function topLevel(dictText) {
  const s = dictText;
  let i = s.indexOf('<<') + 2;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const str = () => { let n = 0; for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '(') n++; else if (s[i] === ')' && --n === 0) { i++; return; } } };
  const composite = () => { // at '<<' or '['
    let depth = 0;
    while (i < s.length) {
      if (s[i] === '(') { str(); continue; }
      if (s.startsWith('<<', i) || s[i] === '[') { depth++; i += s[i] === '[' ? 1 : 2; continue; }
      if (s.startsWith('>>', i) || s[i] === ']') { depth--; i += s[i] === ']' ? 1 : 2; if (depth === 0) return; continue; }
      if (s[i] === '<') { i = s.indexOf('>', i) + 1; continue; }
      i++;
    }
  };
  const value = () => {
    ws();
    const start = i;
    if (s.startsWith('<<', i) || s[i] === '[') composite();
    else if (s[i] === '(') str();
    else if (s[i] === '<') i = s.indexOf('>', i) + 1;
    else {
      if (s[i] === '/') i++;
      while (i < s.length && !/[\s/<>[\]()]/.test(s[i])) i++;
      const ref = /\s+(\d+)\s+R(?![A-Za-z])/y;
      ref.lastIndex = i;
      if (/^\d+$/.test(s.slice(start, i)) && ref.exec(s)) i = ref.lastIndex;
    }
    return s.slice(start, i).replace(/\s+/g, ' ');
  };
  const out = new Map();
  for (;;) {
    ws();
    if (s[i] !== '/') break;
    const km = /\/([^\s/<>[\]()]+)/y;
    km.lastIndex = i;
    const k = km.exec(s)[1];
    i = km.lastIndex;
    out.set(k, value());
  }
  return out;
}

function baseFacts(buf) {
  const s = latin1(buf);
  const sx = lastStartxref(s);
  const isTable = s.startsWith('xref', sx);
  const trailer = isTable ? /trailer\s*(<<[\s\S]*?>>)\s*startxref/.exec(s.slice(sx))[1] : s.slice(sx, s.indexOf('stream', sx));
  return { startxref: sx, kind: isTable ? 'table' : 'stream', trailer, size: Number(trailerVal(trailer, 'Size')) };
}

function parseTail(s, baseLen) {
  const tail = s.slice(baseLen);
  const objects = [];
  let p = 0;
  const re = /\s*(\d+) (\d+) obj\b/y;
  for (;;) {
    re.lastIndex = p;
    const m = re.exec(tail);
    if (!m) break;
    const headerAt = re.lastIndex - `${m[1]} ${m[2]} obj`.length;
    const bodyStart = re.lastIndex;
    const eo = tail.indexOf('endobj', bodyStart);
    const sm = /stream\r?\n/g;
    sm.lastIndex = bodyStart;
    const st = sm.exec(tail);
    let end;
    if (st && st.index < eo) {
      const dict = tail.slice(bodyStart, st.index);
      const len = Number(/\/Length (\d+)/.exec(dict)?.[1]);
      const dataStart = sm.lastIndex;
      const es = tail.indexOf('endstream', dataStart + (Number.isFinite(len) ? len : 0));
      end = tail.indexOf('endobj', es) + 6;
      objects.push({ num: Number(m[1]), gen: Number(m[2]), offset: baseLen + headerAt, body: dict.trim(), stream: tail.slice(dataStart, dataStart + (Number.isFinite(len) ? len : es - dataStart)) });
    } else {
      end = eo + 6;
      objects.push({ num: Number(m[1]), gen: Number(m[2]), offset: baseLen + headerAt, body: tail.slice(bodyStart, eo).trim() });
    }
    p = end;
  }
  return { objects, rest: tail.slice(p).trim(), eofCount: (tail.match(/%%EOF/g) || []).length, xrefKeywordCount: (tail.match(/(^|\s)xref\s/g) || []).length };
}

function parseXrefTable(rest) {
  const m = /^xref\s+([\s\S]*?)trailer\s*(<<[\s\S]*>>)\s*startxref\s+(\d+)\s+%%EOF\s*$/.exec(rest);
  if (!m) return null;
  const entries = [];
  let cur = 0;
  for (const l of m[1].trim().split(/\r?\n/)) {
    const h = /^(\d+) (\d+)\s*$/.exec(l);
    if (h) { cur = Number(h[1]); continue; }
    const e = /^(\d{10}) (\d{5}) ([nf])\s*$/.exec(l);
    entries.push(e ? { num: cur++, offset: Number(e[1]), gen: Number(e[2]), type: e[3] } : { bad: l });
  }
  return { kind: 'table', entries, trailer: m[2], startxref: Number(m[3]) };
}

function parseXrefStream(obj, rest) {
  const d = obj.body;
  const W = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(d).slice(1).map(Number);
  const idx = (/\/Index\s*\[([^\]]*)\]/.exec(d)?.[1] ?? `0 ${/\/Size (\d+)/.exec(d)[1]}`).trim().split(/\s+/).map(Number);
  let data = Buffer.from(obj.stream, 'latin1');
  if (/\/Filter\s*\/FlateDecode/.test(d)) data = zlib.inflateSync(data);
  const entries = [];
  let p = 0;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + data[p++]; return v; };
  for (let i = 0; i < idx.length; i += 2) {
    for (let k = 0; k < idx[i + 1]; k++) {
      const t = W[0] ? rd(W[0]) : 1;
      const a = rd(W[1]), b = rd(W[2]);
      entries.push({ num: idx[i] + k, type: t === 0 ? 'f' : t === 1 ? 'n' : 'objstm', offset: a, gen: b });
    }
  }
  return { kind: 'stream', entries, trailer: d, startxref: Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(rest)?.[1]), selfNum: obj.num };
}

let pdfLib;
async function loadPdfLib(bytes) {
  pdfLib ??= await import('@cantoo/pdf-lib');
  return pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
}

/** Decoded, order-independent value of a pdf-lib object (strings decoded, key order ignored). */
function canon(o) {
  const L = pdfLib;
  if (o === undefined || o === null) return null;
  if (o instanceof L.PDFRef) return `ref:${o.objectNumber} ${o.generationNumber}`;
  if (o instanceof L.PDFName) return `/${o.decodeText ? o.decodeText() : o.asString().slice(1)}`;
  if (o instanceof L.PDFNumber) return o.asNumber();
  if (o instanceof L.PDFString || o instanceof L.PDFHexString) return `str:${o.decodeText()}`;
  if (o instanceof L.PDFArray) return o.asArray().map(canon);
  if (o instanceof L.PDFStream) return { dict: canon(o.dict), stream: Buffer.from(o.getContents()).toString('base64') };
  if (o instanceof L.PDFDict) {
    const out = {};
    for (const [k, v] of [...o.entries()].sort((a, b) => (a[0].toString() < b[0].toString() ? -1 : 1))) out[k.toString()] = canon(v);
    return out;
  }
  return o.toString();
}
const dictOf = (o) => (o instanceof pdfLib.PDFStream ? o.dict : o instanceof pdfLib.PDFDict ? o : null);
const nameOf = (d, k) => d?.get(pdfLib.PDFName.of(k))?.toString().replace(/^\//, '') ?? null;
const keysOf = (d) => d.keys().map((k) => k.toString().replace(/^\//, ''));

function kindOf(o) {
  if (o === undefined || o === null) return 'missing';
  if (o instanceof pdfLib.PDFArray) return 'array';
  const d = dictOf(o);
  if (!d) return o.constructor.name;
  const type = nameOf(d, 'Type'), sub = nameOf(d, 'Subtype');
  if (o instanceof pdfLib.PDFStream) return type === 'XRef' ? 'xref-stream' : type === 'ObjStm' ? 'objstm' : sub === 'Form' ? 'form-xobject' : `stream:${sub || type || '?'}`;
  if (sub === 'Widget' || d.has(pdfLib.PDFName.of('FT')) || d.has(pdfLib.PDFName.of('Kids')) && d.has(pdfLib.PDFName.of('T'))) return 'field/widget';
  if (type === 'Annot' || sub) return `annot:${sub}`;
  if (type) return type.toLowerCase();
  if (d.has(pdfLib.PDFName.of('Fields'))) return 'acroform';
  return 'dict';
}

const NEW_KEYS = {
  'annot:Highlight': new Set(['Type', 'Subtype', 'CreationDate', 'Rect', 'F', 'Border', 'Rotate', 'QuadPoints', 'C', 'CA', 'T', 'AP', 'Contents', 'Popup']),
  'annot:Ink': new Set(['Type', 'Subtype', 'CreationDate', 'Rect', 'F', 'Border', 'Rotate', 'InkList', 'BS', 'C', 'CA', 'T', 'AP', 'Contents', 'Popup']),
  'annot:Popup': new Set(['Type', 'Subtype', 'Open', 'Rect', 'Parent']),
  'form-xobject': new Set(['Type', 'Subtype', 'FormType', 'BBox', 'Length', 'Resources']),
};
const SUPERSEDED_KEYS = { page: new Set(['Annots']), 'field/widget': new Set(['V', 'AS', 'AP', 'M', 'MK']) };

/**
 * Test-side PV1-PV5 over one writer output. Returns { problems, newKinds, freed }.
 * `expect`: { freed: number[] (object numbers), added: { Highlight, Ink, Popup } }.
 */
async function analyse(base, out, expect) {
  const problems = [];
  const P = (m) => problems.push(m);
  // PV1
  if (!(out.length > base.length)) P(`PV1: output is not longer than the base (${out.length} <= ${base.length})`);
  else for (let i = 0; i < base.length; i++) if (out[i] !== base[i]) { P(`PV1: prefix differs at byte ${i}`); break; }
  if (problems.length) return { problems };

  const B = baseFacts(base);
  const s = latin1(out);
  const T = parseTail(s, base.length);
  // PV2: one revision
  if (T.eofCount !== 1) P(`PV2: ${T.eofCount} %%EOF markers in the appended part`);
  let X = parseXrefTable(T.rest);
  if (!X) {
    const xo = T.objects.find((o) => /\/Type\s*\/XRef/.test(o.body));
    if (xo) X = parseXrefStream(xo, T.rest);
  }
  if (!X) { P(`PV2: no cross-reference section at the end (${JSON.stringify(T.rest.slice(0, 60))})`); return { problems }; }
  if (X.kind === 'table' && T.xrefKeywordCount !== 1) P(`PV2: ${T.xrefKeywordCount} xref tables appended`);
  if (X.kind === 'stream' && T.objects.filter((o) => /\/Type\s*\/XRef/.test(o.body)).length !== 1) P('PV2: more than one cross-reference stream appended');
  if (X.kind !== B.kind) P(`PV2: cross-reference kind ${X.kind}, base has ${B.kind}`);
  if (lastStartxref(s) !== X.startxref || X.startxref < base.length) P('PV2: last startxref does not point into the appended part');
  const tr = X.trailer;
  const nt = topLevel(tr), bt = topLevel(B.trailer);
  const squash = (v) => (v ?? '').replace(/\s+/g, '');
  if (Number(nt.get('Prev')) !== B.startxref) P(`PV2: /Prev ${nt.get('Prev')} != base startxref ${B.startxref}`);
  if (nt.get('Root') !== bt.get('Root')) P('PV2: /Root changed');
  // /Info: the same reference, or the same direct dictionary copied inline (cjk, jpx-jbig2, js-openaction fixtures)
  if (squash(nt.get('Info')) !== squash(bt.get('Info'))) P(`PV2: /Info changed (${bt.get('Info')} -> ${nt.get('Info')})`);
  if (!(Number(nt.get('Size')) >= B.size)) P('PV2: /Size shrank');
  const allowedTrailer = new Set(['Size', 'Root', 'Info', 'ID', 'Prev', ...(X.kind === 'stream' ? ['Type', 'W', 'Index', 'Length', 'Filter'] : [])]);
  for (const k of nt.keys()) if (!allowedTrailer.has(k)) P(`PV2: trailer key /${k}`);
  if (/\/ID/.test(B.trailer) && firstId(tr) !== firstId(B.trailer)) P('PV2: first /ID element changed');
  // PV3
  const objAt = new Map(T.objects.map((o) => [o.offset, o]));
  for (const e of X.entries) {
    if (e.bad) P(`PV3: malformed entry line ${JSON.stringify(e.bad)}`);
    else if (e.type === 'objstm') P(`PV3: object ${e.num} in an object stream`);
    else if (e.type === 'n') {
      const o = objAt.get(e.offset);
      if (!o || o.num !== e.num || o.gen !== e.gen) P(`PV3: entry ${e.num} does not point at its object`);
    }
  }
  for (const o of T.objects) if (!X.entries.some((e) => e.type === 'n' && e.num === o.num)) P(`PV3: appended object ${o.num} has no entry`);
  const freed = X.entries.filter((e) => e.type === 'f' && e.num !== 0).map((e) => e.num).sort((a, b) => a - b);
  if (JSON.stringify(freed) !== JSON.stringify([...expect.freed].sort((a, b) => a - b))) P(`PV3: freed ${JSON.stringify(freed)}, expected ${JSON.stringify(expect.freed)}`);

  // PV4 / PV5
  const baseLib = await loadPdfLib(base);
  const outLib = await loadPdfLib(out);
  const lookup = (doc, o) => doc.context.lookup(pdfLib.PDFRef.of(o.num, o.gen));
  const newKinds = {};
  const superseded = [];
  let sawNeedAppearances = false;
  for (const o of T.objects) {
    const obj = lookup(outLib, o);
    const kind = kindOf(obj);
    if (o.num >= B.size) {
      newKinds[kind] = (newKinds[kind] ?? 0) + 1;
      const hits = inertHits(o.body);
      if (hits.length) P(`PV5: new object ${o.num} contains ${hits.join(',')}`);
      if (kind === 'xref-stream') { if (B.kind !== 'stream') P('PV4: xref stream in a table file'); continue; }
      const allowed = NEW_KEYS[kind];
      if (!allowed) { P(`PV4: new object ${o.num} of kind ${kind}`); continue; }
      const d = dictOf(obj);
      for (const k of keysOf(d)) if (!allowed.has(k)) P(`PV4: new ${kind} ${o.num} has /${k}`);
      if (kind.startsWith('annot:') && d.has(pdfLib.PDFName.of('AP'))) {
        const ap = d.lookup(pdfLib.PDFName.of('AP'));
        if (keysOf(ap).join() !== 'N') P(`PV4: new ${kind} ${o.num} /AP has ${keysOf(ap).join()}`);
      }
      if (kind === 'annot:Ink' && d.has(pdfLib.PDFName.of('BS')) && keysOf(d.lookup(pdfLib.PDFName.of('BS'))).some((k) => k !== 'W')) P(`PV4: ink ${o.num} /BS has more than /W`);
      if (kind === 'form-xobject' && d.has(pdfLib.PDFName.of('Resources'))) {
        const raw = d.get(pdfLib.PDFName.of('Resources'));
        if (!(raw instanceof pdfLib.PDFDict)) { P(`PV4: form ${o.num} /Resources is not inline`); continue; }
        for (const rk of keysOf(raw)) {
          const rv = raw.get(pdfLib.PDFName.of(rk));
          if (rk === 'ExtGState') {
            if (!(rv instanceof pdfLib.PDFDict)) { P(`PV4: form ${o.num} ExtGState not inline`); continue; }
            for (const [, gs] of rv.entries()) {
              if (!(gs instanceof pdfLib.PDFDict)) P(`PV4: form ${o.num} ExtGState entry is a reference`);
              else if (nameOf(gs, 'BM') !== 'Multiply' || keysOf(gs).some((k) => !['BM', 'ca', 'CA', 'Type'].includes(k))) P(`PV4: form ${o.num} ExtGState ${JSON.stringify(canon(gs))}`);
            }
          } else if (rk === 'Font') {
            const fd = rv instanceof pdfLib.PDFDict ? rv : null;
            if (!fd) { P(`PV4: form ${o.num} Font not inline`); continue; }
            for (const [, f] of fd.entries()) if (!(f instanceof pdfLib.PDFRef) || f.objectNumber >= B.size) P(`PV4: form ${o.num} uses a font that is not in the base`);
          } else P(`PV4: form ${o.num} /Resources has /${rk}`);
        }
      }
    } else {
      const before = lookup(baseLib, o);
      const bk = kindOf(before);
      if (bk !== kind) { P(`PV4: superseded ${o.num} changed kind ${bk} -> ${kind}`); continue; }
      if (kind === 'acroform' && expect.needAppearances) {
        // Known pdf.js behaviour (PWP-17 finding): a text field with a format/keystroke script gets no appearance
        // stream; pdf.js sets /NeedAppearances true on the AcroForm instead. The only change allowed is that key.
        const da = canon(dictOf(before)), db = canon(dictOf(obj));
        const extra = { ...db };
        delete extra['/NeedAppearances'];
        if (JSON.stringify(extra) !== JSON.stringify(da) || db['/NeedAppearances'] !== 'true') P(`PV4: AcroForm ${o.num} changed beyond /NeedAppearances true`);
        sawNeedAppearances = true;
        superseded.push({ num: o.num, kind, changed: ['+NeedAppearances'] });
        continue;
      }
      const allowed = SUPERSEDED_KEYS[kind];
      if (!allowed) { P(`PV4: superseded object ${o.num} of kind ${kind}`); continue; }
      const da = canon(dictOf(before)), db = canon(dictOf(obj));
      if (before instanceof pdfLib.PDFStream) P(`PV4: superseded ${o.num} is a stream`);
      const changed = [];
      superseded.push({ num: o.num, kind, changed });
      for (const k of new Set([...Object.keys(da), ...Object.keys(db)])) {
        if (JSON.stringify(da[k]) === JSON.stringify(db[k])) continue;
        const name = k.slice(1);
        changed.push(`${!(k in da) ? '+' : !(k in db) ? '-' : '~'}${name}`);
        if (!allowed.has(name)) { P(`PV4: superseded ${kind} ${o.num} changed /${name}`); continue; }
        if (name === 'MK') {
          const a = { ...(da[k] ?? {}) }, b = { ...(db[k] ?? {}) };
          if (a['/R'] === 0) delete a['/R'];
          if (JSON.stringify(a) !== JSON.stringify(b)) P(`PV4: widget ${o.num} /MK changed beyond removing /R 0`);
        }
        const hits = inertHits(JSON.stringify(db[k] ?? null).replace(/"\/(\w+)"/g, ' /$1 '));
        if (hits.length) P(`PV5: superseded ${o.num} /${name} contains ${hits.join(',')}`);
      }
      if (kind === 'page') {
        const raw = dictOf(obj).get(pdfLib.PDFName.of('Annots'));
        if (raw && !(raw instanceof pdfLib.PDFArray)) P(`PV4: page ${o.num} /Annots is not written inline`);
      }
    }
  }
  if (expect.needAppearances && !sawNeedAppearances) P('PV4: expected the AcroForm /NeedAppearances supersede (pdf.js behaviour changed?)');
  for (const k of ['Highlight', 'Ink', 'Popup']) {
    const got = newKinds[`annot:${k}`] ?? 0;
    if (got !== (expect.added[k] ?? 0)) P(`PV4: ${got} new ${k} objects, expected ${expect.added[k] ?? 0}`);
  }
  return { problems, newKinds, superseded, freed, appended: out.length - base.length };
}

// ---------------------------------------------------------------- PDFium annotation reader

let pdfiumLib;
async function pdfiumAnnots(bytes, pageIndices) {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  pdfiumLib ??= await PDFiumLibrary.init();
  const doc = await pdfiumLib.loadDocument(new Uint8Array(bytes));
  try {
    const out = new Map();
    for (const pi of pageIndices) {
      const page = doc.getPage(pi);
      const m = page.module;
      const scratch = m.wasmExports.malloc(64);
      const key = m.wasmExports.malloc(16);
      m.HEAPU8.set([...Buffer.from('Contents\0', 'latin1')], key);
      const list = [];
      const n = m._FPDFPage_GetAnnotCount(page.pageIdx);
      for (let i = 0; i < n; i++) {
        const a = m._FPDFPage_GetAnnot(page.pageIdx, i);
        const r = { subtype: m._FPDFAnnot_GetSubtype(a), rect: null, color: null, contents: '' };
        if (m._FPDFAnnot_GetRect(a, scratch)) {
          const f = new Float32Array(m.HEAPU8.buffer, scratch, 4); // left, top, right, bottom
          r.rect = [Math.min(f[0], f[2]), Math.min(f[1], f[3]), Math.max(f[0], f[2]), Math.max(f[1], f[3])];
        }
        if (m._FPDFAnnot_GetColor(a, 0, scratch, scratch + 4, scratch + 8, scratch + 12)) {
          const u = new Uint32Array(m.HEAPU8.buffer, scratch, 3);
          r.color = [u[0], u[1], u[2]];
        }
        const len = m._FPDFAnnot_GetStringValue(a, key, 0, 0);
        if (len > 2) {
          const buf = m.wasmExports.malloc(len);
          m._FPDFAnnot_GetStringValue(a, key, buf, len);
          r.contents = new TextDecoder('utf-16le').decode(m.HEAPU8.slice(buf, buf + len - 2));
          m.wasmExports.free(buf);
        }
        m._FPDFPage_CloseAnnot(a);
        list.push(r);
      }
      m.wasmExports.free(scratch);
      m.wasmExports.free(key);
      out.set(pi, list);
    }
    return { pages: doc.getPageCount(), annots: out };
  } finally { doc.destroy(); }
}
const PDFIUM_SUBTYPE = { Highlight: 9, Ink: 15, Popup: 16 };

/** pdf-lib: per requested page the annotation dictionaries (subtype, rect, colour 0-255, contents). */
async function pdflibAnnots(bytes, pageIndices) {
  const doc = await loadPdfLib(bytes);
  const out = new Map();
  for (const pi of pageIndices) {
    const arr = doc.getPage(pi).node.lookupMaybe(pdfLib.PDFName.of('Annots'), pdfLib.PDFArray);
    const list = [];
    for (let i = 0; i < (arr?.size() ?? 0); i++) {
      const d = arr.lookupMaybe(i, pdfLib.PDFDict);
      const num = (k) => d?.lookupMaybe(pdfLib.PDFName.of(k), pdfLib.PDFArray)?.asArray().map((x) => x.asNumber()) ?? null;
      const c = d?.get(pdfLib.PDFName.of('Contents'));
      list.push({ subtype: nameOf(d, 'Subtype'), rect: num('Rect'), color: num('C')?.map((x) => Math.round(x * 255)) ?? null,
        contents: c && (c instanceof pdfLib.PDFString || c instanceof pdfLib.PDFHexString) ? c.decodeText() : '' });
    }
    out.set(pi, list);
  }
  return { pages: doc.getPageCount(), annots: out };
}

// ---------------------------------------------------------------- the contract check

const near = (a, b, tol) => a && b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

/** Expected appearance of each added annotation, from the entries the writer received. */
function expectedAdded(storage) {
  return storage.filter(([k, v]) => SA.isEditorKey(k) && !v.deleted).map(([, v]) => ({
    page: v.pageIndex, subtype: v.annotationType === 9 ? 'Highlight' : 'Ink', rect: v.rect, color: v.color, contents: v.popup?.contents ?? '',
  }));
}

function findAnnot(list, want, tol = 0.02) {
  return list.find((a) => a.subtype === want.subtype && near(a.rect, want.rect, tol));
}

async function contract(fx, name, ops, { inv: givenInv } = {}) {
  const base = fixture(fx);
  const inv = givenInv ?? await inventory(base);
  const cls = classified(base);
  const ctx = cls.context;
  const s = S.emptyState();
  const env = makeEnv();
  for (const op of typeof ops === 'function' ? ops(inv, ctx) : ops) {
    const plan = S.applyEdit(s, op, ctx, env);
    assert.ok(plan.ok, `${fx}/${name}: op refused: ${JSON.stringify(plan.error)}`);
  }
  const actx = { deletable: ctx.deletable, pages: ctx.pages, author: 'Contract Tester' };
  const entries = SA.toStorageEntries(s, actx);
  const storage = jsonRoundTrip(entries);
  assert.deepStrictEqual(storage, entries, 'entries survive JSON unchanged');
  const out = await pdfjsWrite(base, storage);
  writeOut(fx, name, out);

  const added = expectedAdded(storage);
  const freed = SA.expectedFreed(s, actx).map((r) => r.num);
  const addedCounts = { Highlight: added.filter((a) => a.subtype === 'Highlight').length, Ink: added.filter((a) => a.subtype === 'Ink').length, Popup: added.filter((a) => a.contents).length };
  const A = await analyse(base, out, { freed, added: addedCounts, needAppearances: false });
  assert.deepStrictEqual(A.problems, [], `${fx}/${name}: revision problems`);

  // Touched pages: edited annotations, and the pages of the fields.
  const delta = SA.expectedAnnotDelta(s, actx);
  const fieldEntries = storage.filter(([k]) => !SA.isEditorKey(k));
  const fieldPage = new Map();
  for (const [p, pg] of inv.pages) for (const a of pg.annots) fieldPage.set(a.id, p);
  const touched = [...new Set([...delta.keys(), ...added.map((a) => a.page), ...fieldEntries.map(([k]) => fieldPage.get(k))])].sort((a, b) => a - b);

  // pdf.js: exact counts, the added annotations, the field values.
  const after = await inventory(out, touched);
  assert.equal(after.numPages, inv.numPages);
  for (const p of touched) {
    assert.equal(after.pages.get(p).annots.length, inv.pages.get(p).annots.length + (delta.get(p) ?? 0), `${fx}/${name}: pdf.js annotation count on page ${p + 1}`);
  }
  for (const want of added) {
    const got = findAnnot(after.pages.get(want.page).annots, want);
    assert.ok(got, `${fx}/${name}: pdf.js does not see the ${want.subtype} on page ${want.page + 1}`);
    assert.ok(near(got.color, want.color, 1), `${fx}/${name}: pdf.js colour ${got.color} != ${want.color}`);
    assert.equal(got.contents, want.contents, `${fx}/${name}: pdf.js comment`);
  }
  for (const ref of S.canonicalRemoved(s)) {
    for (const pg of after.pages.values()) assert.ok(!pg.annots.some((a) => a.id === SA.pdfjsId(ref)), `${fx}/${name}: removed ${SA.pdfjsId(ref)} still listed`);
  }
  for (const [id, { value }] of fieldEntries) {
    const w = after.pages.get(fieldPage.get(id)).annots.find((a) => a.id === id);
    assert.ok(w, `${fx}/${name}: widget ${id} missing after save`);
    if (w.checkBox) assert.equal(w.fieldValue === w.exportValue, value, `${fx}/${name}: checkbox ${id}`);
    else if (w.radioButton) assert.equal(w.fieldValue === w.buttonValue, value, `${fx}/${name}: radio ${id}`);
    else if (w.fieldType === 'Ch') assert.deepStrictEqual([].concat(w.fieldValue), [].concat(value), `${fx}/${name}: choice ${id}`);
    else assert.equal(w.fieldValue, value, `${fx}/${name}: text ${id}`);
  }

  // PWP-18: the host verifier (spec §6.5 PV1-PV6) accepts every real pdf.js output, with `observed` as the writer
  // service reports it: pdf.js's count for each touched page (untouched pages: the classified count, which the PG6
  // check below proves unchanged) and the read-back of each requested field.
  const observed = {
    pageCount: after.numPages,
    annotsPerPage: cls.pages.map((pg, i) => (after.pages.has(i) ? after.pages.get(i).annots.length : pg.annots.length)),
    fields: fieldEntries.map(([id]) => {
      const w = after.pages.get(fieldPage.get(id)).annots.find((a) => a.id === id);
      const value = w.checkBox ? w.fieldValue === w.exportValue : w.radioButton ? w.fieldValue === w.buttonValue
        : w.fieldType === 'Ch' && Array.isArray(w.fieldValue) && !w.multiSelect ? w.fieldValue[0] : w.fieldValue;
      return { ref: refOf(id), value };
    }),
  };
  const verdict = V.verifySaveSync({ base, out, classification: cls, state: s, author: 'Contract Tester', observed });
  assert.ok(verdict.ok, `${fx}/${name}: verifier refused a real pdf.js output
${V.formatFindings(verdict)}`);

  // PDFium and pdf-lib: the same counts and annotations.
  const [fBase, fOut] = [await pdfiumAnnots(base, touched), await pdfiumAnnots(out, touched)];
  const [lBase, lOut] = [await pdflibAnnots(base, touched), await pdflibAnnots(out, touched)];
  assert.equal(fOut.pages, inv.numPages);
  assert.equal(lOut.pages, inv.numPages);
  for (const p of touched) {
    const d = delta.get(p) ?? 0;
    assert.equal(fOut.annots.get(p).length, fBase.annots.get(p).length + d, `${fx}/${name}: PDFium annotation count on page ${p + 1}`);
    assert.equal(lOut.annots.get(p).length, lBase.annots.get(p).length + d, `${fx}/${name}: pdf-lib /Annots length on page ${p + 1}`);
  }
  for (const want of added) {
    const f = findAnnot(fOut.annots.get(want.page), { ...want, subtype: PDFIUM_SUBTYPE[want.subtype] }, 0.05);
    assert.ok(f, `${fx}/${name}: PDFium does not see the ${want.subtype} on page ${want.page + 1}`);
    // FPDFAnnot_GetColor refuses annotations that have an appearance stream (ours always do), so PDFium's colour
    // is not read back here; pdf.js and pdf-lib check /C.
    assert.equal(f.color, null, 'PDFium now reports /C for annotations with /AP: add the colour check');
    assert.equal(f.contents, want.contents, `${fx}/${name}: PDFium comment`);
    const l = findAnnot(lOut.annots.get(want.page), want);
    assert.ok(l, `${fx}/${name}: pdf-lib does not see the ${want.subtype} on page ${want.page + 1}`);
    assert.ok(near(l.color, want.color, 1), `${fx}/${name}: pdf-lib colour ${l.color} != ${want.color}`);
    assert.equal(l.contents, want.contents, `${fx}/${name}: pdf-lib comment`);
  }

  // PG6 helper: all three readers open it, page counts agree, untouched pages keep their text.
  // checkPg6 asks for at least base + count of a subtype on a page, so pass the net count (a mixed case may add a
  // Highlight and remove one), and only for pages its pdf.js reader reads (the first 50). The exact counts are
  // asserted above for all three readers.
  const removedSub = new Map();
  for (const ref of S.canonicalRemoved(s)) {
    const p = ctx.deletable.get(S.refKey(ref)).page;
    const sub = inv.pages.get(p).annots.find((a) => a.id === SA.pdfjsId(ref)).subtype;
    removedSub.set(`${p}/${sub}`, (removedSub.get(`${p}/${sub}`) ?? 0) + 1);
  }
  const pg6 = new Map();
  for (const a of added) {
    const k = `${a.page}/${a.subtype}`;
    const e = pg6.get(k) ?? { page: a.page + 1, subtype: a.subtype, count: -(removedSub.get(k) ?? 0) };
    e.count++;
    if (a.contents && e.contents === undefined) e.contents = a.contents;
    pg6.set(k, e);
  }
  await assertPg6(out, base, { annots: [...pg6.values()].filter((e) => e.count > 0 && e.page <= 50) });
  return { base, out, s, entries, analysis: A };
}

// ---------------------------------------------------------------- adapter unit tests (pure)

const D = (k) => new Date(DATE0 + k * 1000).toISOString();
function unitCtx() {
  const view = [0, 0, 595, 842];
  const pages = [0, 1, 2].map(() => ({ mediaBox: { x0: view[0], y0: view[1], x1: view[2], y1: view[3] } }));
  return {
    pages,
    deletable: new Map([['10 0', { page: 0, popup: '11 0' }], ['20 0', { page: 1 }], ['21 3', { page: 2 }]]),
    popups: new Map([['11 0', '10 0']]),
    fields: new Map([['30 0', { kind: 'text' }], ['31 0', { kind: 'button' }], ['32 2', { kind: 'choice' }]]),
  };
}

test('pdfjsId / parsePdfjsId follow pdf.js Ref.toString', () => {
  assert.equal(SA.pdfjsId({ num: 12, gen: 0 }), '12R');
  assert.equal(SA.pdfjsId({ num: 12, gen: 3 }), '12R3');
  assert.deepStrictEqual(SA.parsePdfjsId('12R'), { num: 12, gen: 0 });
  assert.deepStrictEqual(SA.parsePdfjsId('12R3'), { num: 12, gen: 3 });
  assert.equal(SA.parsePdfjsId('pdfjs_internal_editor_0'), null);
  assert.equal(SA.parsePdfjsId('12 0 R'), null);
});

test('empty state -> no entries; add-then-undo -> no entries', () => {
  const ctx = unitCtx();
  assert.deepStrictEqual(SA.toStorageEntries(S.emptyState(), ctx), []);
  const s = S.emptyState();
  const env = { now: () => D(0) };
  const plan = S.applyEdit(s, { op: 'addAnnotation', spec: { kind: 'highlight', localId: 1, page: 0, quads: quadAt([0, 0, 595, 842], 0), color: 'yellow', comment: '' } }, ctx, env);
  assert.ok(S.applyDelta(s, S.invertDelta(plan.delta)));
  assert.deepStrictEqual(SA.toStorageEntries(s, ctx), []);
  assert.deepStrictEqual(SA.expectedFreed(s, ctx), []);
  assert.equal(SA.expectedAnnotDelta(s, ctx).size, 0);
});

test('entries: exact shapes, editor keys for removals (with popupRef), field keys by id, canonical order', () => {
  const ctx = unitCtx();
  const s = S.emptyState();
  let t = 0;
  const env = { now: () => D(t++), baseline: new Map() };
  const v = [0, 0, 595, 842];
  const ops = [
    { op: 'addAnnotation', spec: { kind: 'ink', localId: 7, page: 1, paths: [[100, 100, 110, 120, 130, 100]], color: 'blue', width: 4, comment: '' } },
    { op: 'addAnnotation', spec: { kind: 'highlight', localId: 3, page: 0, quads: quadAt(v, 0), color: 'green', comment: 'Note' } },
    { op: 'removeAnnotation', target: { ref: { num: 21, gen: 3 } } },
    { op: 'removeAnnotation', target: { ref: { num: 11, gen: 0 } } }, // the Popup -> its parent 10 0
    { op: 'removeAnnotation', target: { ref: { num: 20, gen: 0 } } },
    { op: 'setFields', values: [{ ref: { num: 32, gen: 2 }, value: ['b', 'a'] }, { ref: { num: 30, gen: 0 }, value: 'text' }, { ref: { num: 31, gen: 0 }, value: false }] },
  ];
  for (const op of ops) assert.ok(S.applyEdit(s, op, ctx, env).ok);
  const entries = SA.toStorageEntries(s, { ...ctx, author: 'Ann' });
  assert.deepStrictEqual(entries.map(([k]) => k), [
    'pdfjs_internal_editor_0', 'pdfjs_internal_editor_1', 'pdfjs_internal_editor_2', 'pdfjs_internal_editor_3', 'pdfjs_internal_editor_4',
    '30R', '31R', '32R2',
  ]);
  const q = quadAt(v, 0);
  assert.deepStrictEqual(entries[0][1], { id: '10R', deleted: true, pageIndex: 0, popupRef: '11R' });
  assert.deepStrictEqual(entries[1][1], {
    annotationType: 9, pageIndex: 0, rect: [q[0], q[5], q[2], q[1]], rotation: 0, color: [83, 255, 188], opacity: 1,
    quadPoints: q, outlines: [[q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]]], date: D(1), user: 'Ann',
    popup: { contents: 'Note', rect: [q[2] + 10, q[1] - 100, q[2] + 190, q[1]] },
  });
  assert.deepStrictEqual(entries[2][1], { id: '20R', deleted: true, pageIndex: 1, popupRef: '' });
  assert.deepStrictEqual(entries[3][1], {
    annotationType: 15, pageIndex: 1, rect: [98, 98, 132, 122], rotation: 0, color: [0, 90, 220], opacity: 1, thickness: 4,
    paths: { lines: [[100, 100, 100, 100, 100, 100, 100, 100, 110, 120, 110, 120, 110, 120, 130, 100, 130, 100]], points: [[100, 100, 110, 120, 130, 100]] },
    date: D(0), user: 'Ann',
  });
  assert.deepStrictEqual(entries[4][1], { id: '21R3', deleted: true, pageIndex: 2, popupRef: '' });
  assert.deepStrictEqual(entries.slice(5).map(([, e]) => e), [{ value: 'text' }, { value: false }, { value: ['b', 'a'] }]);
  // pure function of the state; JSON-safe; no author -> no /T
  assert.deepStrictEqual(SA.toStorageEntries(S.cloneState(s), { ...ctx, author: 'Ann' }), entries);
  assert.deepStrictEqual(jsonRoundTrip(entries), entries);
  assert.ok(!('user' in SA.toStorageEntries(s, ctx)[1][1]));
  // expectations for the verifier
  assert.deepStrictEqual(SA.expectedFreed(s, ctx), [{ num: 10, gen: 0 }, { num: 11, gen: 0 }, { num: 20, gen: 0 }, { num: 21, gen: 3 }]);
  // page 0: -2 (10 + Popup) +2 (highlight + Popup); page 1: -1 +1; page 2: -1 -> only page 2 remains
  assert.deepStrictEqual([...SA.expectedAnnotDelta(s, ctx)], [[2, -1]]);
  assert.equal(SA.serialisedSize(entries), Buffer.byteLength(JSON.stringify(entries)));
});

test('colours: every PdfColor maps for highlight and ink; unknown colours and broken states throw', () => {
  for (const c of COLOURS) {
    assert.equal(SA.HIGHLIGHT_RGB[c].length, 3);
    assert.equal(SA.INK_RGB[c].length, 3);
    assert.notDeepStrictEqual(SA.HIGHLIGHT_RGB[c], SA.INK_RGB[c]);
  }
  const rec = (spec, createdAt = D(0)) => ({ spec, createdAt, uniqueName: 'x' });
  const v = [0, 0, 595, 842];
  assert.throws(() => SA.highlightEntry(rec({ kind: 'highlight', localId: 1, page: 0, quads: quadAt(v, 0), color: 'purple', comment: '' }), unitCtx()), /unknown colour/);
  assert.throws(() => SA.highlightEntry(rec({ kind: 'highlight', localId: 1, page: 0, quads: quadAt(v, 0), color: 'red', comment: '' }, 'yesterday'), unitCtx()), /creation date/);
  assert.throws(() => SA.inkEntry(rec({ kind: 'ink', localId: 1, page: 0, paths: [], color: 'red', width: 1, comment: '' }), unitCtx()), /geometry/);
  const s = S.emptyState();
  s.removed.add('99 0');
  assert.throws(() => SA.toStorageEntries(s, unitCtx()), /not in the deletable set/);
  assert.throws(() => SA.expectedAnnotDelta(s, unitCtx()), /not in the deletable set/);
});

test('popupRect: right of the annotation, kept inside the visible page when the page is known', () => {
  const page = { mediaBox: { x0: 0, y0: 0, x1: 595, y1: 842 }, cropBox: { x0: 20, y0: 20, x1: 575, y1: 822 } };
  assert.deepStrictEqual(SA.popupRect({ x0: 100, y0: 500, x1: 200, y1: 520 }), [210, 420, 390, 520]);
  assert.deepStrictEqual(SA.popupRect({ x0: 400, y0: 30, x1: 560, y1: 50 }, page), [395, 20, 575, 120]);
  assert.deepStrictEqual(SA.popupRect({ x0: 100, y0: 830, x1: 200, y1: 840 }, page), [210, 722, 390, 822]);
});

test('strokeToLine: straight cubic segments, no NaN', () => {
  const l = SA.strokeToLine([1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(l, [1, 2, 1, 2, 1, 2, 1, 2, 3, 4, 3, 4, 3, 4, 5, 6, 5, 6]);
  assert.ok(l.every(Number.isFinite));
});

// ---------------------------------------------------------------- writer contract tests (pdf.js in Node)

fs.rmSync(OUT_DIR, { recursive: true, force: true });

/** Per output: appended bytes, new object kinds, superseded objects; written to summary.json for PWP-18's tables. */
const summary = [];
const recordSummary = (row) => {
  summary.push(row);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
};

if (!skipWriter) {
  // Cases are chosen per fixture from its pdf.js inventory, so only applicable ones are registered.
  for (const [fx, groups] of Object.entries(MATRIX)) {
    const inv = await inventory(fixture(fx));
    const ctx = contextFrom(fixture(fx));
    for (const group of groups) {
      for (const [name, build] of Object.entries(group)) {
        const ops = build(inv, ctx);
        if (!ops) continue;
        test(`contract ${fx} / ${name}`, async () => {
          const r = await contract(fx, name, ops, { inv });
          recordSummary({ fixture: fx, case: name, appended: r.analysis.appended, newKinds: r.analysis.newKinds, superseded: r.analysis.superseded, freed: r.analysis.freed });
        });
      }
    }
  }
}

test('forms-js.pdf: no field case applies — every field carries scripts, so the state refuses them (PWP-27 decision)', { skip: skipWriter }, async () => {
  const base = fixture('forms-js.pdf');
  const inv = await inventory(base);
  const ctx = contextFrom(base);
  assert.equal(ctx.fields.size, 0);
  for (const build of Object.values(FIELD_CASES)) assert.equal(build(inv, ctx), null);
  const text = [...inv.pages.get(0).annots].find((a) => a.fieldType === 'Tx');
  const plan = S.planEdit(S.emptyState(), setF([text.id, 'x']), ctx, makeEnv());
  assert.equal(plan.ok, false);
  assert.equal(plan.error.reason, 'not-fillable');
});

test('contract large.pdf (2,000 pages) / highlight on the last page', { skip: skipWriter }, async () => {
  const base = fixture('large.pdf');
  const inv = await inventory(base, [0, 1999]);
  await contract('large.pdf', 'last-page', () => [hl(1999, inv.pages.get(1999).view, 0, 'red', 'Page 2000')], { inv });
});

test('empty state: no entries, and pdf.js returns the loaded bytes unchanged (PG0/PG2)', { skip: skipWriter }, async () => {
  for (const fx of Object.keys(MATRIX)) {
    const base = fixture(fx);
    const entries = SA.toStorageEntries(S.emptyState(), { deletable: new Map() });
    assert.deepStrictEqual(entries, []);
    const out = await pdfjsWrite(base, entries);
    assert.ok(Buffer.from(out).equals(Buffer.from(base)), `${fx}: an empty save changed the bytes`);
  }
});

test('add + delete + undo sequences that return to empty write nothing (PG2 by construction)', { skip: skipWriter }, async () => {
  const fx = 'annotated.pdf';
  const base = fixture(fx);
  const inv = await inventory(base);
  const ctx = contextFrom(base);
  const s = S.emptyState();
  const env = makeEnv();
  const deltas = [];
  for (const op of [hl(0, inv.pages.get(0).view, 3, 'red', 'x'), rm(deletables(ctx)[0]), ink(1, inv.pages.get(1).view)]) {
    const plan = S.applyEdit(s, op, ctx, env);
    assert.ok(plan.ok);
    deltas.push(plan.delta);
  }
  assert.ok(SA.toStorageEntries(s, ctx).length === 3);
  for (const d of deltas.reverse()) assert.ok(S.applyDelta(s, S.invertDelta(d)));
  const entries = SA.toStorageEntries(s, ctx);
  assert.deepStrictEqual(entries, []);
  assert.ok(Buffer.from(await pdfjsWrite(base, entries)).equals(Buffer.from(base)));
});

test('a removal really shortens /Annots; the same removal keyed by the annotation id is silently ignored', { skip: skipWriter }, async () => {
  const fx = 'annotated.pdf';
  const base = fixture(fx);
  const inv = await inventory(base);
  const ctx = contextFrom(base);
  const first = deletables(ctx)[0];
  const s = S.emptyState();
  assert.ok(S.applyEdit(s, rm(first), ctx, makeEnv()).ok);
  const entries = SA.toStorageEntries(s, ctx);
  assert.equal(entries.length, 1);
  assert.ok(SA.isEditorKey(entries[0][0]));
  const page = ctx.deletable.get(first).page;
  const good = await pdfjsWrite(base, jsonRoundTrip(entries));
  const before = await pdflibAnnots(base, [page]);
  const after = await pdflibAnnots(good, [page]);
  assert.equal(after.annots.get(page).length, before.annots.get(page).length - (ctx.deletable.get(first).popup ? 2 : 1));
  // The trap the adapter avoids (spike S3): keyed by "10R" instead of an editor key, nothing happens and no error is raised.
  const wrong = await pdfjsWrite(base, [[entries[0][1].id, entries[0][1]]]);
  assert.ok(Buffer.from(wrong).equals(Buffer.from(base)), 'pdf.js changed its behaviour for id-keyed removals; revisit spec §6.4');
  // Without popupRef the parent goes but its Popup stays behind in /Annots (orphaned) — why the adapter always sends it.
  const noPopup = await pdfjsWrite(base, [[entries[0][0], { ...entries[0][1], popupRef: '' }]]);
  assert.equal((await pdflibAnnots(noPopup, [page])).annots.get(page).length, before.annots.get(page).length - 1);
});

test('NaN control points (pdf.js editor format) do not survive JSON; the adapter never emits them', { skip: skipWriter }, async () => {
  const withNaN = { annotationType: 15, paths: { lines: [[NaN, NaN, NaN, NaN, 1, 2, NaN, NaN, NaN, NaN, 3, 4]] } };
  assert.deepStrictEqual(jsonRoundTrip(withNaN).paths.lines[0].slice(0, 4), [null, null, null, null]);
  const base = fixture('basic.pdf');
  const inv = await inventory(base);
  const ctx = contextFrom(base);
  const s = S.emptyState();
  assert.ok(S.applyEdit(s, ink(0, inv.pages.get(0).view), ctx, makeEnv()).ok);
  const entries = SA.toStorageEntries(s, ctx);
  const flat = JSON.stringify(entries);
  assert.ok(!/null|NaN/.test(flat), 'entries contain NaN/null');
  // The written appearance stream draws straight segments to the stroke points.
  const out = await pdfjsWrite(base, jsonRoundTrip(entries));
  const tail = latin1(out).slice(base.length);
  const pts = entries[0][1].paths.points[0];
  assert.ok(tail.includes(`${pts[0]} ${pts[1]} m`), 'stroke starts with a moveto at its first point');
});

test('state-determined output (PG4): equal states write identical bytes on a file without /ID; with /ID only the trailer /ID differs', { skip: skipWriter }, async () => {
  for (const fx of ['basic.pdf', 'xref-stream.pdf', 'word.pdf']) {
    const base = fixture(fx);
    const inv = await inventory(base);
    const ctx = contextFrom(base);
    const ops = [hl(0, inv.pages.get(0).view, 0, 'yellow', 'same'), ink(0, inv.pages.get(0).view)];
    const outs = [];
    for (let run = 0; run < 2; run++) {
      const s = S.emptyState();
      const env = makeEnv();
      for (const op of ops) assert.ok(S.applyEdit(s, op, ctx, env).ok);
      outs.push(await pdfjsWrite(base, jsonRoundTrip(SA.toStorageEntries(s, ctx))));
      await new Promise((r) => setTimeout(r, 1100)); // let the clock move a second
    }
    const [a, b] = outs.map((o) => Buffer.from(o));
    if (!/\/ID/.test(latin1(a).slice(base.length))) {
      assert.ok(a.equals(b), `${fx}: two writes of the same state differ`);
    } else {
      const idAt = latin1(a).lastIndexOf('/ID');
      assert.ok(Math.abs(a.length - b.length) <= 4, `${fx}: lengths differ by more than the /ID escaping`);
      assert.ok(a.subarray(0, idAt).equals(b.subarray(0, idAt)), `${fx}: outputs differ before the trailer /ID`);
    }
  }
});
