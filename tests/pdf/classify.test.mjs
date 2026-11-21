// PWP-16: core/classify.ts — editability, read-only reason, pages and boxes, deletable annotations with
// their Popups, AcroForm and signature facts (spec §6.2, §9.1–§9.3). Oracle: pdf.js (legacy build, Node).
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const C = core.classify;
const S = core.state;
const G = core.geometry;
const L1 = (s) => Buffer.from(s, 'latin1');

// ------------------------------------------------------------------ expectations per fixture

const RO = (reason, detail) => ({ reason, detail });

/**
 * HYBRID-XREF FILES — the one place to update when the reader learns to open /XRefStm files (user decision
 * 2026-11-21: they become editable). Today the reader refuses them with `hybrid`. After the reader change,
 * replace both with editable expectations, e.g. for word.pdf
 *   { pages: 2, annots: [1, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 }
 * (pdf.js sees one Link on page 1); hybrid-xref.pdf: { pages: 2, annots: [0, 0], deletable: {}, ... }.
 * The pdf.js cross-check then runs on them automatically (EDITABLE is derived from EXPECT).
 */
const HYBRID_EXPECT = {
  // Hybrid-xref files are editable since the reader accepts /XRefStm sections (user decision 2026-11-21).
  'word.pdf': { pages: 2, annots: [1, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'hybrid-xref.pdf': { pages: 2, annots: [0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
};
/**
 * Expected classification of every committed fixture: a read-only reason (+ detail), or
 * { pages, annots: per-page /Annots length, deletable: "num gen" -> popup key | null, signed, sig: [fields, signed], acro, terminal }.
 */
const EXPECT = {
  'annotated.pdf': { pages: 2, annots: [10, 0],
    deletable: { '10 0': '11 0', '12 0': '13 0', '14 0': '15 0', '16 0': '17 0', '18 0': null }, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'attachments.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'base14.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'basic.pdf': { pages: 2, annots: [0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'chrome.pdf': { pages: 6, annots: [1, 0, 0, 0, 0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'cjk.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'forms-js.pdf': { pages: 1, annots: [3], deletable: {}, signed: false, sig: [0, 0], acro: true, terminal: 3 },
  'forms.pdf': { pages: 2, annots: [12, 1], deletable: {}, signed: false, sig: [1, 0], acro: true, terminal: 11 },
  'jpx-jbig2.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'js-openaction.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'large.pdf': { pages: 2000, deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'multi-revision.pdf': { pages: 2, annots: [0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'outline.pdf': { pages: 3, annots: [5, 0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'rotated.pdf': { pages: 4, annots: [0, 0, 0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'scanned.pdf': { pages: 3, annots: [0, 0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'signed.pdf': { pages: 1, annots: [1], deletable: {}, signed: true, sig: [1, 1], acro: true, terminal: 1 },
  'tagged.pdf': { pages: 1, annots: [0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'xref-stream.pdf': { pages: 3, annots: [0, 0, 0], deletable: {}, signed: false, sig: [0, 0], acro: false, terminal: 0 },
  'broken-xref.pdf': RO('unsupported-structure', 'reader:bad-xref'),
  ...HYBRID_EXPECT,
  'encrypted-user.pdf': RO('encrypted', 'reader:encrypted'),
  'encrypted-owner.pdf': RO('encrypted', 'reader:encrypted'),
  'truncated.pdf': RO('unsupported-structure', 'reader:no-startxref'),
  'empty.pdf': RO('unsupported-structure', 'reader:no-header'),
  'not-a-pdf.pdf': RO('unsupported-structure', 'reader:no-header'),
};
const EDITABLE = Object.keys(EXPECT).filter((n) => !('reason' in EXPECT[n]));

function checkEditable(name, r, exp) {
  assert.strictEqual(r.editable, true, `${name}: ${r.reason} ${r.detail}`);
  assert.strictEqual(r.pages.length, exp.pages);
  assert.strictEqual(r.context.pages.length, exp.pages);
  if (exp.annots) assert.deepStrictEqual(r.pages.map((p) => p.annots.length), exp.annots);
  const del = Object.fromEntries([...r.context.deletable].map(([k, v]) => [k, v.popup ?? null]));
  assert.deepStrictEqual(del, exp.deletable);
  const popups = Object.fromEntries(Object.entries(exp.deletable).filter(([, p]) => p).map(([k, p]) => [p, k]));
  assert.deepStrictEqual(Object.fromEntries(r.context.popups), popups);
  assert.deepStrictEqual(r.info.deletable.map(S.refKey), Object.keys(exp.deletable));
  assert.strictEqual(r.context.fields.size, 0, 'forms are off until PWP-27');
  assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'flag-off', lockedFields: [] });
  assert.strictEqual(r.info.signed, exp.signed);
  assert.deepStrictEqual([r.signatures.signatureFields, r.signatures.signedFields], exp.sig);
  assert.strictEqual(r.forms.acroForm, exp.acro);
  assert.strictEqual(r.forms.xfa, false);
  assert.strictEqual(r.forms.terminalFields, exp.terminal);
}

test('the expectation table covers every committed fixture', () => {
  assert.deepStrictEqual(Object.keys(EXPECT).sort(), allFixtures());
});

for (const [name, exp] of Object.entries(EXPECT)) {
  test(`${name}: ${'reason' in exp ? `${exp.reason} (${exp.detail})` : 'editable, expected counts'} — sync and async agree`, async () => {
    const bytes = fixture(name);
    const r = C.classifySync(bytes);
    const a = await C.classify(bytes);
    if ('reason' in exp) {
      assert.deepStrictEqual(r, { editable: false, reason: exp.reason, detail: exp.detail });
    } else {
      checkEditable(name, r, exp);
    }
    assert.deepStrictEqual(a, r);
  });
}

// ------------------------------------------------------------------ the hybrid decision (open with the user)

test('word.pdf (Word "Save as PDF", hybrid /XRefStm) classifies as HYBRID_EXPECT says', () => {
  // Current reader: refused with `hybrid` -> unsupported-structure. Classification itself has no hybrid rule,
  // so when the reader opens hybrids this follows HYBRID_EXPECT alone.
  const exp = HYBRID_EXPECT['word.pdf'];
  const r = C.classifySync(fixture('word.pdf'));
  if ('reason' in exp) assert.deepStrictEqual(r, { editable: false, ...exp });
  else checkEditable('word.pdf', r, exp);
});

test('READ_ERROR_REASON maps every reader error code; only `encrypted` is not unsupported-structure', () => {
  const codes = ['no-header', 'no-startxref', 'bad-xref', 'prev-cycle', 'hybrid', 'encrypted', 'objstm', 'too-large', 'malformed'];
  assert.deepStrictEqual(Object.keys(C.READ_ERROR_REASON).sort(), codes.sort());
  for (const c of codes) assert.strictEqual(C.READ_ERROR_REASON[c], c === 'encrypted' ? 'encrypted' : 'unsupported-structure');
  assert.ok(Object.isFrozen(C.READ_ERROR_REASON));
});

// ------------------------------------------------------------------ pdf.js oracle

let pdfjsLib;
async function pdfjsFacts(bytes, pageLimit = Infinity) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false });
  const doc = await task.promise;
  try {
    const pages = [];
    const n = doc.numPages;
    const idx = [...Array(n).keys()].filter((i) => i < pageLimit || i >= n - 3);
    for (const i of idx) {
      const p = await doc.getPage(i + 1);
      const annots = await p.getAnnotations();
      pages.push({ index: i, ref: `${p.ref.num} ${p.ref.gen}`, view: p.view, rotate: p.rotate,
        annots: annots.map((a) => ({ id: a.id, subtype: a.subtype, popupRef: a.popupRef ?? null })) });
    }
    return { numPages: n, pages };
  } finally { await task.destroy(); }
}
/** pdf.js annotation id "12R" / "12R3" -> "12 0" / "12 3". */
const idKey = (id) => { const m = /^(\d+)R(\d*)$/.exec(id); return m ? `${m[1]} ${m[2] || 0}` : null; };

function crossCheck(r, js) {
  assert.strictEqual(r.pages.length, js.numPages);
  for (const jp of js.pages) {
    const ours = r.pages[jp.index];
    assert.strictEqual(S.refKey(ours.ref), jp.ref, `page ${jp.index} ref`);
    const v = G.visibleBox(r.context.pages[jp.index]);
    assert.deepStrictEqual([v.x0, v.y0, v.x1, v.y1], jp.view, `page ${jp.index} view`);
    assert.strictEqual(G.normalizeRotation(r.context.pages[jp.index].rotate), jp.rotate, `page ${jp.index} rotate`);
    // Every annotation pdf.js reports is listed by us with the same subtype; every deletable one has pdf.js's popupRef.
    const byKey = new Map(ours.annots.filter((a) => a.ref).map((a) => [S.refKey(a.ref), a]));
    for (const a of jp.annots) {
      const k = idKey(a.id);
      if (k === null) { // pdf.js's own id for an inline annotation dictionary
        assert.ok(ours.annots.some((f) => f.ref === null && f.subtype === a.subtype), `page ${jp.index}: inline ${a.subtype}`);
        continue;
      }
      const f = byKey.get(k);
      assert.ok(f, `page ${jp.index}: pdf.js annotation ${a.id} not classified`);
      assert.strictEqual(f.subtype, a.subtype, `${a.id} subtype`);
      const d = r.context.deletable.get(k);
      if (d) {
        assert.strictEqual(d.page, jp.index);
        assert.strictEqual(d.popup ?? null, a.popupRef ? idKey(a.popupRef) : null, `${a.id} popupRef`);
      }
    }
    for (const k of [...r.context.deletable].filter(([, d]) => d.page === jp.index).map(([k]) => k)) {
      assert.ok(jp.annots.some((a) => idKey(a.id) === k), `deletable ${k} unknown to pdf.js`);
    }
  }
}

for (const name of EDITABLE) {
  test(`${name}: page refs, boxes, rotation and annotations agree with pdf.js`, async () => {
    const bytes = fixture(name);
    crossCheck(C.classifySync(bytes), await pdfjsFacts(bytes, 25));
  });
}

// ------------------------------------------------------------------ the context drives state.ts

test('annotated.pdf: the context accepts deletions of markup and Popups, refuses links, validates geometry', () => {
  const r = C.classifySync(fixture('annotated.pdf'));
  const st = S.emptyState();
  const env = { now: () => '2026-11-21T00:00:00.000Z' };
  const rm = (num) => ({ op: 'removeAnnotation', target: { ref: { num, gen: 0 } } });
  let p = S.planEdit(st, rm(10), r.context, env);
  assert.ok(p.ok); assert.deepStrictEqual(p.delta.map((d) => d.key), ['10 0']);
  p = S.planEdit(st, rm(11), r.context, env); // its Popup -> the parent
  assert.ok(p.ok); assert.deepStrictEqual(p.delta.map((d) => d.key), ['10 0']);
  for (const n of [19, 6, 999]) {
    p = S.planEdit(st, rm(n), r.context, env);
    assert.ok(!p.ok); assert.strictEqual(p.error.reason, 'not-deletable');
  }
  const quad = [100, 112, 140, 112, 100, 100, 140, 100];
  assert.ok(S.planEdit(st, { op: 'addAnnotation', spec: { kind: 'highlight', localId: 1, page: 1, quads: quad, color: 'yellow', comment: '' } }, r.context, env).ok);
  const far = S.planEdit(st, { op: 'addAnnotation', spec: { kind: 'highlight', localId: 1, page: 0, quads: quad.map((x) => x + 5000), color: 'yellow', comment: '' } }, r.context, env);
  assert.ok(!far.ok); assert.strictEqual(far.error.reason, 'outside-page');
  assert.strictEqual(S.planEdit(st, { op: 'addAnnotation', spec: { kind: 'highlight', localId: 1, page: 2, quads: quad, color: 'yellow', comment: '' } }, r.context, env).error.reason, 'unknown-page');
});

test('annotated.pdf: per-annotation facts say why each non-deletable entry is not deletable', () => {
  const r = C.classifySync(fixture('annotated.pdf'));
  assert.deepStrictEqual(r.pages[0].annots.map((a) => `${a.ref.num}:${a.subtype}:${a.deletable ? 'D' : a.why}`), [
    '10:Highlight:D', '11:Popup:subtype', '12:Underline:D', '13:Popup:subtype', '14:Text:D', '15:Popup:subtype',
    '16:Ink:D', '17:Popup:subtype', '18:FreeText:D', '19:Link:subtype']);
  assert.deepStrictEqual(r.pages[0].annots.filter((a) => a.subtype === 'Popup').map((a) => a.parent), ['10 0', '12 0', '14 0', '16 0']);
});

test('rotated.pdf: crop boxes and rotations reach the context', () => {
  const r = C.classifySync(fixture('rotated.pdf'));
  assert.deepStrictEqual(r.context.pages.map((p) => p.rotate), [0, 90, 180, 270]);
  assert.deepStrictEqual(r.context.pages[1].cropBox, { x0: 36, y0: 36, x1: 576, y1: 756 });
  assert.strictEqual(r.context.pages[0].cropBox, undefined);
});

test('structure facts: xref kind, revisions', () => {
  assert.deepStrictEqual(pick(C.classifySync(fixture('multi-revision.pdf')).structure), { xrefKind: 'table', revisions: 3 });
  assert.deepStrictEqual(pick(C.classifySync(fixture('xref-stream.pdf')).structure), { xrefKind: 'stream', revisions: 1 });
  function pick(s) { return { xrefKind: s.xrefKind, revisions: s.revisions }; }
});

// ------------------------------------------------------------------ limits (spec §9.3)

test('too-large: over the edit file-size limit, decided before parsing', () => {
  const bytes = fixture('basic.pdf');
  assert.deepStrictEqual(C.classifySync(bytes, { maxEditFileBytes: bytes.length - 1 }), { editable: false, reason: 'too-large', detail: 'file-over-limit' });
  assert.strictEqual(C.classifySync(bytes, { maxEditFileBytes: bytes.length }).editable, true);
  // A non-PDF over the size limit is still too-large (size is checked first).
  assert.strictEqual(C.classifySync(new Uint8Array(100), { maxEditFileBytes: 99 }).reason, 'too-large');
});

test('too-large: more pages than the edit limit (root /Count, before the walk)', () => {
  const bytes = fixture('large.pdf');
  assert.deepStrictEqual(C.classifySync(bytes, { maxEditPages: 1999 }), { editable: false, reason: 'too-large', detail: 'pages-over-limit' });
  assert.strictEqual(C.classifySync(bytes, { maxEditPages: 2000 }).editable, true);
  assert.strictEqual(core.limits.PDF_LIMITS.maxEditPages, 20_000);
  assert.strictEqual(core.limits.PDF_LIMITS.maxEditFileBytes, 100 * 1024 * 1024);
});

test('a strict-reader cap maps to unsupported-structure', () => {
  const r = C.classifySync(fixture('large.pdf'), { reader: { maxXrefEntries: 100 } });
  assert.deepStrictEqual(r, { editable: false, reason: 'unsupported-structure', detail: 'reader:too-large' });
});

test('large.pdf: async classification yields and two concurrent runs do not interfere', async () => {
  const big = fixture('large.pdf'); const small = fixture('annotated.pdf');
  const opts = { reader: { asyncParseThresholdBytes: 0, yieldIntervalMs: 0 } };
  let ticks = 0; let stop = false;
  const tick = () => { if (!stop) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  const t = performance.now();
  const [a, b] = await Promise.all([C.classify(big, opts), C.classify(small, opts)]);
  const ms = performance.now() - t;
  stop = true;
  assert.ok(ticks > 10, `the event loop ran (${ticks} ticks)`);
  checkEditable('large.pdf', a, EXPECT['large.pdf']);
  checkEditable('annotated.pdf', b, EXPECT['annotated.pdf']);
  assert.ok(ms < 5000, `classified 2000 pages in ${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------------ synthetic files

/**
 * A PDF with a classic table. objs: { "num" | "num gen": body }. Object 1 is the catalog unless given.
 * opts.trailer: extra trailer text.
 */
function build(objs, opts = {}) {
  const parts = [L1('%PDF-1.7\n')];
  let off = parts[0].length;
  const entries = [];
  for (const [id, body] of Object.entries(objs)) {
    const [n, g = '0'] = id.split(' ');
    const b = L1(`${n} ${g} obj\n${body}\nendobj\n`);
    entries.push({ n: Number(n), g: Number(g), off }); off += b.length; parts.push(b);
  }
  entries.sort((a, b) => a.n - b.n);
  let x = 'xref\n0 1\n0000000000 65535 f \n';
  for (const e of entries) x += `${e.n} 1\n${String(e.off).padStart(10, '0')} ${String(e.g).padStart(5, '0')} n \n`;
  x += `trailer\n<< /Size ${entries[entries.length - 1].n + 1} /Root 1 0 R ${opts.trailer ?? ''}>>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(L1(x));
  return new Uint8Array(Buffer.concat(parts));
}
const CAT = '<< /Type /Catalog /Pages 2 0 R >>';
const page = (extra = '', parent = 2) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 600 800] ${extra} >>`;
const onePage = (pageExtra, more = {}) => build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(pageExtra), ...more });
const ro = (bytes) => { const r = C.classifySync(bytes); assert.strictEqual(r.editable, false, 'expected read-only'); return `${r.reason}:${r.detail}`; };

test('synthetic baseline is editable and agrees with pdf.js', async () => {
  const b = onePage('');
  const r = C.classifySync(b);
  assert.strictEqual(r.editable, true);
  crossCheck(r, await pdfjsFacts(b));
});

test('catalog and page-tree refusals', () => {
  const P1 = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  assert.strictEqual(ro(build({ 1: '<< /Pages 2 0 R >>', 2: P1, 3: page() })), 'unsupported-structure:catalog');
  assert.strictEqual(ro(build({ 1: '<< /Type /Catalog /Pages << /Type /Pages /Kids [3 0 R] /Count 1 >> >>', 3: page() })), 'unsupported-structure:page-tree');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 2 >>', 3: page() })), 'unsupported-structure:page-count');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>', 3: page() })), 'unsupported-structure:page-tree-cycle');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [2 0 R] /Count 1 >>' })), 'unsupported-structure:page-tree-cycle');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [] /Count 0 >>' })), 'unsupported-structure:no-pages');
  assert.strictEqual(ro(build({ 1: CAT, 2: P1, 3: page('', 9), 9: '<< /Type /Pages /Kids [] /Count 0 >>' })), 'unsupported-structure:page-tree-parent');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Annots [] >>', 3: page() })), 'unsupported-structure:page-tree-annots');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Foo /Parent 2 0 R >>' })), 'unsupported-structure:page-tree');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3] /Count 1 >>', 3: page() })), 'unsupported-structure:page-tree');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' })), 'unsupported-structure:page-tree'); // dangling kid
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 99999 >>', 3: page() })), 'too-large:pages-over-limit');
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count -1 >>', 3: page() })), 'unsupported-structure:page-count');
  // An intermediate node's /Count must match its own leaves too.
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [4 0 R 3 0 R] /Count 2 >>', 3: page(),
    4: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 2 >>', 5: page('', 4) })), 'unsupported-structure:page-count');
});

test('a page tree deeper than MAX_TREE_DEPTH is refused; one just within is accepted', () => {
  const chain = (depth) => {
    const o = { 1: CAT };
    for (let i = 0; i < depth; i++) o[2 + i] = `<< /Type /Pages ${i ? `/Parent ${1 + i} 0 R ` : ''}/Kids [${3 + i} 0 R] /Count 1 >>`;
    o[2 + depth] = page('', 1 + depth);
    return build(o);
  };
  assert.strictEqual(C.classifySync(chain(C.MAX_TREE_DEPTH + 1)).editable, true);
  assert.strictEqual(ro(chain(C.MAX_TREE_DEPTH + 2)), 'unsupported-structure:page-tree-depth');
});

test('inherited and odd boxes/rotation are derived exactly as pdf.js does', async () => {
  const b2 = build({ 1: CAT,
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R 8 0 R] /Count 4 /MediaBox [0 0 500 700] /Rotate 90 /CropBox [10 10 490 690] >>',
    3: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 /Rotate -90 >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [600 800 0 0] /CropBox [0 0 0 0] /Rotate 45 >>',
    5: '<< /Type /Page /Parent 3 0 R >>',
    6: '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 0 100] /CropBox [1000 1000 2000 2000] /Rotate 450 >>',
    7: '<< /Type /Page /Parent 8 0 R /MediaBox 9 0 R /Rotate 10 0 R >>',
    8: '<< /Type /Pages /Parent 2 0 R /Kids [7 0 R] /Count 1 >>',
    9: '[0 0 11 0 R 300]', 10: '180', 11: '200',
  });
  const r = C.classifySync(b2);
  assert.strictEqual(r.editable, true);
  assert.deepStrictEqual(r.context.pages.map((p) => p.rotate), [270, 90, 0, 180]);
  assert.deepStrictEqual(r.context.pages[2].mediaBox, { x0: 0, y0: 0, x1: 600, y1: 800 });
  assert.deepStrictEqual(r.context.pages[1].mediaBox, { x0: 0, y0: 0, x1: 612, y1: 792 }, 'invalid media box -> US Letter');
  crossCheck(r, await pdfjsFacts(b2));
});

test('annotation edge cases: deletable or not, with the reason; deletable ones match pdf.js popupRef', async () => {
  const hl = (extra = '') => `<< /Type /Annot /Subtype /Highlight /Rect [10 10 50 20] /QuadPoints [10 20 50 20 10 10 50 10] ${extra} >>`;
  const pop = (parent) => `<< /Type /Annot /Subtype /Popup /Rect [60 60 160 120] ${parent ? `/Parent ${parent} 0 R` : ''} >>`;
  const objs = {
    1: CAT, 2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    3: page('/Annots [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 14 0 R 15 0 R 17 0 R 18 0 R 20 0 R 21 0 R 22 0 R 23 0 R 25 0 R 99 0 R << /Subtype /Text /Rect [0 0 1 1] >> 30 1 R 31 0 R 33 0 R 35 0 R]'),
    4: page('/Annots 5 0 R'), 5: '[16 0 R 34 0 R]',
    10: hl('/Popup 11 0 R'), 11: pop(10),                       // ok, with Popup
    12: hl(), 13: hl('/F 128'),                                 // ok; locked
    14: hl(),                                                   // listed twice -> shared
    15: hl('/Popup 16 0 R'), 16: pop(15),                       // Popup listed on page 2 -> bad-popup
    17: hl('/Popup 19 0 R'), 18: hl('/Popup 19 0 R'), 19: pop(17), // Popup shared by two -> bad-popup both
    20: hl('/Popup 26 0 R'), 26: pop(12),                       // Popup's /Parent is another annotation -> bad-popup
    21: hl('/IRT 12 0 R /RT /Group'),                           // group reply -> group-reply; 12 then has-replies
    22: hl('/P 4 0 R'),                                         // /P names page 2 -> other-page
    23: hl('/Popup 24 0 R'), 24: '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] >>', // /Popup not a Popup
    25: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] >>',    // subtype
    '30 1': `<< /Type /Annot /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 1 5 5]] /F 4 /Popup 32 0 R >>`, 32: pop(0).replace('/Parent 0 0 R', ''), // gen 1, Popup without /Parent
    31: '<< /Type /Annot /Subtype /FreeText /Rect [0 0 9 9] /DA (/Helv 10 Tf) /IRT 10 0 R >>', // a plain reply: deletable; 10 has-replies
    33: '<< /Type /Annot /Subtype /Squiggly /Rect [0 0 9 9] /QuadPoints [0 9 9 9 0 0 9 0] /F 64 >>', // read-only flag
    34: hl('/P 4 0 R'),                                         // on page 2 through an indirect /Annots: ok
    35: '<< /Type /Annot /Subtype /StrikeOut /Rect [0 0 9 9] /QuadPoints [0 9 9 9 0 0 9 0] >>',
  };
  const b = build(objs);
  const r = C.classifySync(b);
  assert.strictEqual(r.editable, true, r.detail);
  const facts = (p) => r.pages[p].annots.map((a) => `${a.ref ? `${a.ref.num}${a.ref.gen ? `.${a.ref.gen}` : ''}` : 'inline'}:${a.deletable ? 'D' : a.why}`);
  assert.deepStrictEqual(facts(0), [
    '10:has-replies', '11:subtype', '12:has-replies', '13:locked', '14:shared', '14:shared', '15:bad-popup', '17:bad-popup', '18:bad-popup',
    '20:bad-popup', '21:group-reply', '22:other-page', '23:bad-popup', '25:subtype', '99:dangling', 'inline:inline', '30.1:D', '31:D', '33:locked', '35:D']);
  assert.deepStrictEqual(facts(1), ['16:subtype', '34:D']);
  assert.deepStrictEqual(Object.fromEntries(r.context.deletable), { '30 1': { page: 0, popup: '32 0' }, '31 0': { page: 0 }, '35 0': { page: 0 }, '34 0': { page: 1 } });
  assert.deepStrictEqual(Object.fromEntries(r.context.popups), { '32 0': '30 1' });
  crossCheck(r, await pdfjsFacts(b));
  // The state module accepts the gen-1 key and maps its Popup to it.
  const p = S.planEdit(S.emptyState(), { op: 'removeAnnotation', target: { ref: { num: 32, gen: 0 } } }, r.context, { now: () => 'x' });
  assert.ok(p.ok); assert.deepStrictEqual(p.delta.map((d) => d.key), ['30 1']);
});

test('without the reply, a markup annotation with a Popup is deletable', () => {
  const r = C.classifySync(onePage('/Annots [10 0 R 11 0 R]', {
    10: '<< /Type /Annot /Subtype /Text /Rect [0 0 9 9] /Popup 11 0 R >>', 11: '<< /Type /Annot /Subtype /Popup /Rect [0 0 9 9] /Parent 10 0 R >>' }));
  assert.deepStrictEqual(Object.fromEntries(r.context.deletable), { '10 0': { page: 0, popup: '11 0' } });
});

test('/Annots refusals and tolerances', () => {
  assert.strictEqual(ro(onePage('/Annots 7')), 'unsupported-structure:annots');
  assert.strictEqual(ro(onePage('/Annots 9 0 R')), 'unsupported-structure:annots');            // dangling
  assert.strictEqual(ro(onePage('/Annots << >>')), 'unsupported-structure:annots');
  assert.strictEqual(C.classifySync(onePage('/Annots null')).editable, true);
  assert.strictEqual(C.classifySync(onePage('/Annots []')).editable, true);
});

test('AcroForm and signature facts; field-tree refusals', () => {
  const sigField = (v) => `<< /FT /Sig /T (s) /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R ${v} >>`;
  const withForm = (acro, more = {}, cat = '') => build({ 1: `<< /Type /Catalog /Pages 2 0 R /AcroForm ${acro} ${cat} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page('/Annots [20 0 R]'), ...more });
  let r = C.classifySync(withForm('<< /Fields [20 0 R] >>', { 20: sigField('/V 21 0 R'), 21: '<< /Type /Sig /Filter /Adobe.PPKLite >>' }));
  assert.deepStrictEqual([r.signatures.signatureFields, r.signatures.signedFields, r.info.signed], [1, 1, true]);
  r = C.classifySync(withForm('<< /Fields [20 0 R] >>', { 20: sigField('') }));
  assert.deepStrictEqual([r.signatures.signatureFields, r.signatures.signedFields, r.info.signed], [1, 0, false]);
  // Inherited /FT and /V through a parent field; widgets (kids without /T) are not fields.
  r = C.classifySync(withForm('<< /Fields [22 0 R] /XFA 25 0 R >>', {
    20: '<< /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /Parent 23 0 R >>',
    22: '<< /T (p) /FT /Sig /V 24 0 R /Kids [23 0 R] >>', 23: '<< /T (c) /Parent 22 0 R /Kids [20 0 R] >>',
    24: '<< /Type /Sig >>', 25: '[]' }));
  assert.deepStrictEqual([r.forms.terminalFields, r.signatures.signedFields, r.forms.xfa, r.info.signed], [1, 1, true, true]);
  assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'flag-off', lockedFields: [] }, 'XFA or not, forms are flag-off until PWP-27');
  // DocMDP certification and usage rights.
  r = C.classifySync(withForm('<< /Fields [] >>', { 20: '<< /Subtype /Link /Rect [0 0 1 1] >>',
    30: '<< /Type /Sig /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>] >>' }, '/Perms << /DocMDP 30 0 R >>'));
  assert.deepStrictEqual([r.signatures.docMdp, r.signatures.docMdpP, r.info.signed, r.editable], [true, 1, true, true]);
  r = C.classifySync(withForm('<< /Fields [] >>', { 20: '<< /Subtype /Link /Rect [0 0 1 1] >>', 30: '<< /Type /Sig >>' }, '/Perms << /UR3 30 0 R >>'));
  assert.deepStrictEqual([r.signatures.usageRights, r.signatures.docMdp, r.info.signed], [true, false, true]);
  // Refusals.
  const link = { 20: '<< /Subtype /Link /Rect [0 0 1 1] >>' };
  assert.strictEqual(ro(withForm('<< /Fields 5 >>', link)), 'unsupported-structure:acroform');
  assert.strictEqual(ro(withForm('[]', link)), 'unsupported-structure:acroform');
  assert.strictEqual(ro(withForm('<< /Fields [22 0 R] >>', { ...link, 22: '<< /T (a) /Kids [23 0 R] >>', 23: '<< /T (b) /Kids [22 0 R] >>' })), 'unsupported-structure:acroform');
  assert.strictEqual(ro(withForm('<< /Fields [22 0 R 22 0 R] >>', { ...link, 22: '<< /T (a) >>' })), 'unsupported-structure:acroform');
  assert.strictEqual(ro(withForm('<< /Fields [<< /T (a) >>] >>', link)), 'unsupported-structure:acroform');
  assert.strictEqual(ro(withForm('<< /Fields [] >>', link, '/Perms 7')), 'unsupported-structure:perms');
});

test('trailer /Encrypt in a synthetic file -> encrypted', () => {
  assert.strictEqual(ro(build({ 1: CAT, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(), 4: '<< /Filter /Standard >>' }, { trailer: '/Encrypt 4 0 R' })), 'encrypted:reader:encrypted');
});

test('never throws and never fails internally on garbage or seeded mutations of annotated.pdf', async () => {
  for (const g of [new Uint8Array(0), L1('%PDF-1.7\n'), L1('%PDF-1.7\nstartxref\n0\n%%EOF\n'), new Uint8Array(4096).fill(0x28)]) {
    const r = C.classifySync(g);
    assert.strictEqual(r.editable, false);
    assert.notStrictEqual(r.detail, 'internal');
    assert.deepStrictEqual(await C.classify(g), r);
  }
  const base = fixture('annotated.pdf');
  let s = 0x5eed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const tally = {};
  for (let i = 0; i < 400; i++) {
    const m = base.slice();
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
    const r = C.classifySync(m);
    const t = r.editable ? 'editable' : `${r.reason}:${r.detail}`;
    tally[t] = (tally[t] ?? 0) + 1;
    assert.notStrictEqual(r.detail, 'internal', `mutation ${i}`);
    if (r.editable) for (const [k, d] of r.context.deletable) assert.ok(d.page >= 0 && d.page < r.pages.length && /^\d+ \d+$/.test(k));
  }
  assert.ok(tally.editable > 0 && Object.keys(tally).length > 2, JSON.stringify(tally));
});

test('read-only results carry codes only (no document content)', () => {
  for (const name of Object.keys(EXPECT).filter((n) => 'reason' in EXPECT[n])) {
    const r = C.classifySync(fixture(name));
    assert.deepStrictEqual(Object.keys(r).sort(), ['detail', 'editable', 'reason']);
    assert.match(r.detail, /^[a-z:-]+$/);
  }
});
