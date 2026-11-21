// Shared harness of the save-verifier suites (verify.test.mjs, verifyReview.test.mjs): real pdf.js writes of
// scenarios built through the state API, and `split` / `rebuild` to take an output's appended revision apart and
// write it again with ONE thing changed, so each negative case fails for the reason it names.
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { core, fixture } from './_helpers.mjs';
export { skipWriter } from './_node.mjs';

const S = core.state;
const SA = core.storageAdapter;
const V = core.verify;
const C = core.classify;
const R = core.reader;
const require = createRequire(import.meta.url);
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));

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
 * (null removes), extra entries, a tail suffix, bytes inserted before the section, a forced startxref, and for a
 * cross-reference stream its number (`xrefNum`) and whether it lists itself (`xrefUnlisted`).
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
    const num = o.xrefNum ?? Math.max(maxNum + 1, parts.size - 1);
    if (!o.xrefUnlisted) entries.push({ num, type: 1, a: off, b: 0 });
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

export { S, SA, V, C, R, core, fixture, L1, latin1, AUTHOR, DATE0, PJ, openPdfjs, pdfjsWrite, widgets, quadAt, hl, ink, scenario, verify, show,
  passes, refused, split, baseBody, obj, setBody, withKey, streamBody, rebuild, fresh, nums, zlib };
