// Regression tests for the independent review of the PDF editing core (2026-11-21): the B1 verifier bypass, the
// should-fix items S1–S3 and the nits that change behaviour (N2–N7). Each case is the reviewer's proof of concept
// (p1–p6, p4s) turned into an assertion: before the fixes they passed the verifier, or misclassified, or took hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { warnIfSkipped } from './_node.mjs';
import {
  S, SA, V, C, R, L1, latin1, AUTHOR, DATE0, widgets, hl, ink, scenario, verify, show, passes, refused,
  split, baseBody, obj, setBody, withKey, streamBody, rebuild, fresh, nums, pdfjsWrite, openPdfjs, fixture, skipWriter,
} from './_verifyHarness.mjs';

const W = require_('../../media/pdfWriter.js');
function require_(p) { return createRequire(import.meta.url)(p); }
warnIfSkipped('verifyReview');
const WR = { skip: skipWriter };

// ---------------------------------------------------------------- hand-built bases

/** A one-revision classic-table PDF from object bodies (index = object number; null = a free entry). */
function handBase(objs) {
  let s = '%PDF-1.7\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) if (objs[i] !== null) { offs[i] = s.length; s += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const sx = s.length;
  const root = objs.findIndex((o) => o && /\/Type \/Catalog/.test(o));
  s += `xref\n0 ${objs.length}\n0000000000 65535 f\r\n`;
  for (let i = 1; i < objs.length; i++) s += objs[i] === null ? '0000000000 00001 f\r\n' : `${String(offs[i]).padStart(10, '0')} 00000 n\r\n`;
  s += `trailer\n<< /Size ${objs.length} /Root ${root} 0 R >>\nstartxref\n${sx}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, 'latin1'));
}
const HL_DICT = '<< /Type /Annot /Subtype /Highlight /Rect [100 700 200 715] /QuadPoints [100 715 200 715 100 700 200 700] /C [1 1 0] /F 4 >>';
/** The reviewer's p2 layout: the deletable highlight is object 1 (on page 1), page 2 is empty. */
const P2_BASE = () => handBase([null, HL_DICT,
  '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Annots [1 0 R] >>', '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] >>',
  '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>', '<< /Type /Catalog /Pages 4 0 R >>']);
/** The reviewer's p1 layout: the highlight is object 1, its page object 2. */
const P1_BASE = () => handBase([null, HL_DICT, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Annots [1 0 R] >>',
  '<< /Type /Pages /Kids [2 0 R] /Count 1 >>', '<< /Type /Catalog /Pages 3 0 R >>']);

const ENV = () => { let t = 0; return { now: () => new Date(DATE0 + 1000 * t++).toISOString(), baseline: new Map() }; };
function apply(cls, ops) {
  const state = S.emptyState(); const env = ENV();
  for (const op of ops) { const p = S.applyEdit(state, op, cls.context, env); assert.ok(p.ok, JSON.stringify(p.error)); }
  return state;
}
const entriesOf = (cls, state) => JSON.parse(JSON.stringify(SA.toStorageEntries(state, { deletable: cls.context.deletable, pages: cls.context.pages, author: AUTHOR })));
/** A scenario on bytes (like the harness's `scenario`, which takes a fixture name). */
async function scenarioOf(base, build) {
  const cls = C.classifySync(base);
  assert.ok(cls.editable, cls.detail);
  const state = apply(cls, build(cls));
  return { base, cls, state, out: await pdfjsWrite(base, entriesOf(cls, state)), baseFile: R.openPdfSync(base) };
}
/** pdf.js's own read-back of an output (media/pdfWriter.js `observe`), not the expectation. */
async function readBack(out, entries) {
  const { task, doc } = await openPdfjs(out);
  try { return await W.observe(doc, W.requestedFields(entries)); } finally { await task.destroy(); }
}
/** The appended objects of a writer output as text, without the strict reader (for outputs it refuses). */
function appendedObjects(base, out) {
  const t = latin1(out, base.length);
  return [...t.matchAll(/(\d+) (\d+) obj\n([\s\S]*?)\nendobj\n/g)].map((m) => ({ num: Number(m[1]), gen: Number(m[2]), body: m[3] }));
}
const why = (cls, num) => cls.pages.flatMap((p) => p.annots).find((a) => a.ref && a.ref.num === num)?.why;

// ================================================================ B1 (1): object 1, the xref renumbering quirk

test('B1/S1: classification never offers object 1 (an annotation, or a Popup) for deletion', () => {
  const c2 = C.classifySync(P2_BASE());
  assert.ok(c2.editable);
  assert.equal(c2.context.deletable.size, 0);
  assert.equal(why(c2, 1), 'object-one');
  assert.ok(!S.applyEdit(S.emptyState(), { op: 'removeAnnotation', target: { ref: { num: 1, gen: 0 } } }, c2.context, ENV()).ok);
  // a highlight whose Popup is object 1
  const pop = C.classifySync(handBase([null, '<< /Type /Annot /Subtype /Popup /Rect [0 0 9 9] /Parent 2 0 R >>',
    '<< /Type /Annot /Subtype /Highlight /Rect [100 700 200 715] /QuadPoints [100 715 200 715 100 700 200 700] /Popup 1 0 R >>',
    '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Annots [2 0 R 1 0 R] >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Catalog /Pages 4 0 R >>']));
  assert.equal(why(pop, 2), 'object-one');
});

test('B1 (p2): pdf.js\'s write that frees object 1 is refused (xref-ambiguous), honest or with a planted catalog', WR, async () => {
  const base = P2_BASE();
  // the classification as it was before the fix (object 1 deletable)
  const cls = C.classifySync(base);
  cls.context.deletable.set('1 0', { page: 0 });
  const state = apply(cls, [{ op: 'removeAnnotation', target: { ref: { num: 1, gen: 0 } } }, hl(1, cls.context.pages, 0)]);
  const out = await pdfjsWrite(base, entriesOf(cls, state));
  assert.match(latin1(out, base.length), /xref\n1 \d+\n0000000000 00001 f/, 'pdf.js writes the ambiguous subsection');
  assert.throws(() => R.openPdfSync(out), (e) => e.code === 'ambiguous-xref');
  const sc = { base, cls, state, out, baseFile: R.openPdfSync(base) };
  refused(sc, out, 'PV2', 'xref-ambiguous');
  // the reviewer's tampered output: a catalog with a JavaScript /OpenAction planted in the appearance stream
  const objs = appendedObjects(base, out);
  const form = objs.find((o) => /\/Subtype \/Form/.test(o.body));
  const evil = '0 0 0 rg 0 0 612 792 re f\n%endobj\n5 0 obj\n<< /Type /Catalog /Pages 4 0 R /OpenAction << /S /JavaScript /JS (app.alert\\("planted"\\)) >> >>\nendobj\n';
  form.body = streamBody(form.body.slice(0, form.body.indexOf(' stream')), evil);
  const bad = rebuild(base, { objects: objs, free: [{ num: 1, gen: 1 }], trailer: new Map([['Prev', String(sc.baseFile.startxref)], ['Root', '5 0 R']]), kind: 'table', size: 8 });
  refused(sc, bad, 'PV2', 'xref-ambiguous');
  // classification of either output refuses it too
  assert.equal(C.classifySync(out).detail, 'reader:ambiguous-xref');
});

test('S1 (p1, p5): honest saves around object 1 now pass with pdf.js\'s REAL read-back', WR, async () => {
  // p1 layout: the highlight that is object 1 is not deletable; adding one beside it saves
  const p1 = await scenarioOf(P1_BASE(), (c) => { assert.equal(why(c, 1), 'object-one'); return [hl(0, c.context.pages, 0)]; });
  const e1 = entriesOf(p1.cls, p1.state);
  passes(p1, p1.out, { observed: await readBack(p1.out, e1) });
  // the same layout with the highlight as object 4: deleting it is offered, saved and read back right
  const base = handBase([null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>', HL_DICT]);
  const sc = await scenarioOf(base, (c) => [{ op: 'removeAnnotation', target: { ref: { num: 4, gen: 0 } } }, hl(0, c.context.pages, 0)]);
  const observed = await readBack(sc.out, entriesOf(sc.cls, sc.state));
  assert.deepStrictEqual(observed.annotsPerPage, [1]);
  passes(sc, sc.out, { observed });
});

// ================================================================ B1 (2), (3): planted structure, comments

let SC;
async function scs() {
  if (SC) return SC;
  SC = {};
  SC.basic = await scenario('basic.pdf', (c) => [hl(0, c.context.pages, 0, 'A comment')]);
  SC.ink = await scenario('basic.pdf', (c) => [ink(0, c.context.pages, 'Ink')]);
  SC.annotated = await scenario('annotated.pdf', (c) => [hl(0, c.context.pages, 8, 'mixed'), { op: 'removeAnnotation', target: { ref: S.parseRefKey([...c.context.deletable.keys()][0]) } }]);
  SC.stream = await scenario('xref-stream.pdf', (c) => [hl(0, c.context.pages, 0)]);
  const fw = await widgets(fixture('forms.pdf'));
  const text = fw.find((w) => w.kind === 'text'), box = fw.find((w) => w.checkBox);
  SC.formsText = SA.parsePdfjsId(text.id); SC.formsBox = SA.parsePdfjsId(box.id);
  SC.forms = await scenario('forms.pdf', () => [{ op: 'setFields', values: [{ ref: SC.formsText, value: 'Verified value' }, { ref: SC.formsBox, value: false }] }], { forms: true });
  return SC;
}
const dictOf = (b) => b.slice(0, b.indexOf(' stream'));
const dataOf = (b) => /stream\r?\n([\s\S]*)\nendstream$/.exec(b)[1];
function withForm(sc, fn, which = 'Form') {
  const p = split(sc);
  const f = nums(sc, p)[which][0];
  setBody(p, f, (b) => fn(b));
  return rebuild(sc.base, p);
}

test('B1 (2): appearance streams may only draw — planted objects, inline images, XObjects, unbalanced state', WR, async () => {
  const { basic, forms } = await scs();
  const plant = (b) => streamBody(dictOf(b), `${dataOf(b)}\n%endobj\n9 0 obj\n<< /Type /Catalog /Pages 1 0 R /OpenAction << /S /JavaScript /JS (x) >> >>\nendobj\n`);
  const r = refused(basic, withForm(basic, plant), 'PV4', 'content-structure');
  assert.ok(r.findings.some((f) => f.check === 'PV2' && f.code === 'structure-token'), show(r));
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), `${dataOf(b)}\nBI /W 1 /H 1 /BPC 8 /CS /G ID \xff EI`)), 'PV4', 'content-structure');
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), `${dataOf(b)}\n/R0 Do`)), 'PV4', 'content-operator');
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), `${dataOf(b)}\n0 0 612 792 re f`)), 'PV4', 'content-operator');
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), dataOf(b).replace('/R0 gs', '/R9 gs'))), 'PV4', 'content-operator');
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), `${dataOf(b)}\n[1 2] 0 d`)), 'PV4', 'content-operator');
  // widgets: the /Tx block with its own operators, balanced
  const tf = Number(/\/AP\s*<<\s*\/N\s*(\d+) 0 R/.exec(obj(split(forms), SC.formsText.num).body)[1]);
  const wform = (fn) => { const p = split(forms); setBody(p, tf, fn); return rebuild(forms.base, p); };
  passes(forms, wform((b) => b));
  refused(forms, wform((b) => streamBody(dictOf(b), `${dataOf(b)} q`)), 'PV4', 'content-operator');
  refused(forms, wform((b) => streamBody(dictOf(b), dataOf(b).replace(/\/(\w+) (\d+) Tf/, '/Nope $2 Tf'))), 'PV4', 'content-operator');
  refused(forms, wform((b) => streamBody(dictOf(b), `${dataOf(b)}\n0 0 1 1 re f 5 0 obj`)), 'PV4', 'content-structure');
});

test('B1 (3): no comment in the appended region outside stream data and strings (p3 case c)', WR, async () => {
  const { basic } = await scs();
  const h = nums(basic).Highlight[0];
  const p = split(basic);
  setBody(p, h, (b) => b.replace('<< /Type', '<< % 2 0 obj << /Type /Catalog /Pages 1 0 R /OpenAction << /S /JavaScript /JS (x) >> >> endobj\n/Type'));
  const r = refused(basic, rebuild(basic.base, p), 'PV2', 'comment');
  assert.ok(r.findings.some((f) => f.code === 'structure-token'), show(r));
  // in a dictionary without any structure text
  refused(basic, rebuild(basic.base, setBody(split(basic), h, (b) => b.replace('/F 4', '/F 4 % note\n'))), 'PV2', 'comment');
  // in the trailer dictionary
  const root = basic.baseFile.trailer.entries.get('Root').num;
  refused(basic, rebuild(basic.base, split(basic), { trailer: { Root: `${root} 0 R % c\n` } }), 'PV2', 'comment');
  // a `%` inside a string is text, not a comment
  const pct = await scenario('basic.pdf', (c) => [hl(0, c.context.pages, 0, '100% sure (50%)')]);
  passes(pct, pct.out);
  // accepted residual: text the user typed that looks like an object boundary refuses the save
  const word = await scenario('basic.pdf', (c) => [hl(0, c.context.pages, 0, 'see 12 0 obj')]);
  refused(word, word.out, 'PV2', 'structure-token');
});

// ================================================================ S2: what a new annotation shows (p3)

test('S2 (p3): what a new annotation shows must be what was requested', WR, async () => {
  const { basic, annotated, ink: inkSc } = await scs();
  const N = nums(basic);
  const hlN = N.Highlight[0], popN = N.Popup[0];
  const at = (n, fn, sc = basic) => rebuild(sc.base, setBody(split(sc), n, fn));
  // a) an opaque black box with an inline image instead of the highlight
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b).replace(/ \/Resources <<.*$/, '>>'), '0 0 0 rg 60 737.89 180 14 re f\nq 180 0 0 14 60 737.89 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \xff EI Q\n')), 'PV4', 'content-operator');
  // a2) the appearance's /BBox moved off the /Rect
  refused(basic, withForm(basic, (b) => b.replace(/\/BBox \[[^\]]*\]/, '/BBox [0 0 1 1]')), 'PV4', 'bbox-mismatch');
  // the highlight painted black, or without the Multiply blend (text would be hidden)
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), dataOf(b).replace(/^[\d. ]+ rg/, '0 0 0 rg'))), 'PV4', 'annot-mismatch');
  refused(basic, withForm(basic, (b) => streamBody(dictOf(b), dataOf(b).replace('/R0 gs\n', ''))), 'PV4', 'annot-mismatch');
  // b) quads elsewhere; b2) hidden and transparent; b3) another author and date; f) rotated; border
  refused(basic, at(hlN, (b) => b.replace(/\/QuadPoints \[[^\]]*\]/, '/QuadPoints [300 100 500 100 300 50 500 50]')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace('/F 4', '/F 2')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace('/CA 1', '/CA 0')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace('/T (Verifier Test)', '/T (Somebody Else)')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace(/\/CreationDate \([^)]*\)/, '/CreationDate (D:19990101000000)')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace('/Rotate 0', '/Rotate 90')), 'PV4', 'annot-mismatch');
  refused(basic, at(hlN, (b) => b.replace('/Border [0 0 0]', '/Border [0 0 5]')), 'PV4', 'annot-mismatch');
  passes(basic, at(hlN, (b) => b.replace(' /Rotate 0', '')), {}, {});
  // d) the Popup opened over the whole page; g) huge
  refused(basic, at(popN, (b) => b.replace('/Open false', '/Open true')), 'PV4', 'annot-mismatch');
  refused(basic, at(popN, (b) => b.replace(/\/Rect \[[^\]]*\]/, '/Rect [0 0 612 792]')), 'PV4', 'annot-mismatch');
  refused(basic, at(popN, (b) => b.replace(/\/Rect \[[^\]]*\]/, '/Rect [-99999999 -99999999 99999999 99999999]')), 'PV4', 'annot-mismatch');
  // e) a new annotation in front of the old ones (drawing order)
  const ap = split(annotated);
  const pg = annotated.cls.pages[0].ref.num;
  setBody(ap, pg, (b) => b.replace(/\/Annots\s*\[([^\]]*?)\s*(\d+ 0 R)\s*\]/, (_, rest, last) => `/Annots [${last} ${rest}]`));
  refused(annotated, rebuild(annotated.base, ap), 'PV4', 'annots-mismatch');
  // ink: path, width and colour
  const inkN = nums(inkSc).Ink[0];
  refused(inkSc, at(inkN, (b) => b.replace(/\/InkList \[\[([\d.]+)/, (_, x) => `/InkList [[${Number(x) + 40}`), inkSc), 'PV4', 'annot-mismatch');
  refused(inkSc, at(inkN, (b) => b.replace(/\/BS << \/W [\d.]+>>/, '/BS << /W 20>>'), inkSc), 'PV4', 'annot-mismatch');
  refused(inkSc, withForm(inkSc, (b) => streamBody(dictOf(b), dataOf(b).replace(/^([\d.]+) w/, '30 w'))), 'PV4', 'annot-mismatch');
  refused(inkSc, withForm(inkSc, (b) => streamBody(dictOf(b), dataOf(b).replace(/[\d. ]+ RG/, '1 1 1 RG'))), 'PV4', 'annot-mismatch');
});

// ================================================================ nits with behaviour

test('N2 (p6): a button field\'s /V must be a name (or absent)', WR, async () => {
  const { forms } = await scs();
  const fieldKey = forms.cls.context.fields.get(S.refKey(SC.formsBox)).field;
  const fn = Number(fieldKey.split(' ')[0]);
  const p = split(forms);
  let body = obj(p, fn)?.body ?? baseBody(forms, fn);
  body = /\/V\s/.test(body) ? body.replace(/\/V\s*\/\w+/, '/V [(junk) << /K (anything) >> 1 0 R]') : withKey(body, 'V', '[(junk) << /K (anything) >> 1 0 R]');
  if (obj(p, fn)) obj(p, fn).body = body; else p.objects.push({ num: fn, gen: 0, body });
  refused(forms, rebuild(forms.base, p), 'PV4', 'value-mismatch');
});

test('N3: the cross-reference stream is a new number that lists itself', WR, async () => {
  const { stream } = await scs();
  passes(stream, rebuild(stream.base, split(stream)));
  refused(stream, rebuild(stream.base, split(stream), { xrefUnlisted: true }), 'PV2', 'xref-stream-number');
  refused(stream, rebuild(stream.base, split(stream), { xrefNum: 3 }), 'PV2', 'xref-stream-number');
});

test('N4: a rewritten widget\'s /AP is exactly << /N new-form >>; its form is [0 0 w h] of the widget', WR, async () => {
  const { forms } = await scs();
  const w = SC.formsText.num;
  const apRe = /\/AP\s*<<\s*\/N\s*(\d+) 0 R\s*>>/;
  const own = Number(apRe.exec(obj(split(forms), w).body)[1]);
  refused(forms, rebuild(forms.base, setBody(split(forms), w, (b) => b.replace(apRe, `/AP << /N ${own} 0 R /D ${own} 0 R >>`))), 'PV4', 'ap-target');
  refused(forms, rebuild(forms.base, setBody(split(forms), w, (b) => b.replace(apRe, `/AP << /N << /On ${own} 0 R >> >>`))), 'PV4', 'ap-target');
  refused(forms, rebuild(forms.base, setBody(split(forms), own, (b) => b.replace(/\/BBox \[[^\]]*\]/, '/BBox [0 0 612 792]'))), 'PV4', 'bbox-mismatch');
});

test('N5, N6: a Popup shared with any annotation, and /StructParent, make an annotation not deletable', () => {
  const page = (annots) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${annots}] >>`;
  const head = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'];
  const shared = C.classifySync(handBase([...head, page('4 0 R 5 0 R 6 0 R'),
    '<< /Type /Annot /Subtype /Highlight /Rect [0 0 9 9] /QuadPoints [0 9 9 9 0 0 9 0] /Popup 6 0 R >>',
    '<< /Type /Annot /Subtype /Square /Rect [0 0 9 9] /Popup 6 0 R >>',
    '<< /Type /Annot /Subtype /Popup /Rect [0 0 9 9] /Parent 4 0 R >>']));
  assert.equal(why(shared, 4), 'bad-popup');
  const tagged = C.classifySync(handBase([...head, page('4 0 R 5 0 R 6 0 R'),
    '<< /Type /Annot /Subtype /Highlight /Rect [0 0 9 9] /QuadPoints [0 9 9 9 0 0 9 0] /StructParent 0 >>',
    '<< /Type /Annot /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 1 5 5]] /Popup 6 0 R >>',
    '<< /Type /Annot /Subtype /Popup /Rect [0 0 9 9] /Parent 5 0 R /StructParent 1 >>']));
  assert.equal(why(tagged, 4), 'struct-parent');
  assert.equal(why(tagged, 5), 'struct-parent');
  assert.equal(tagged.context.deletable.size, 0);
});

// ================================================================ S3 (p4s, scaled down)

/** The reviewer's p4s file: every page's /MediaBox is one shared object padded with whitespace before its value. */
function padded(nPages, padBytes) {
  const parts = []; const offs = []; let len = 0;
  const push = (s) => { const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s; parts.push(b); len += b.length; };
  push('%PDF-1.7\n');
  const objAt = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  objAt(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = []; for (let i = 0; i < nPages; i++) kids.push(`${4 + i} 0 R`);
  objAt(2, `<< /Type /Pages /Count ${nPages} /Kids [${kids.join(' ')}] >>`);
  objAt(3, Buffer.concat([Buffer.alloc(padBytes, 0x20), Buffer.from('[0 0 612 792]')]));
  for (let i = 0; i < nPages; i++) objAt(4 + i, '<< /Type /Page /Parent 2 0 R /MediaBox 3 0 R >>');
  const n = 4 + nPages; const sx = len;
  push(`xref\n0 ${n}\n0000000000 65535 f\r\n` + offs.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n\r\n').join(''));
  push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${sx}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

test('S3 (p4s): a padded object shared by every page is read once; padding over the cap and the work budget end it', async () => {
  const b = padded(200, 1 << 20);
  // before: 200 pages x 1 MB lexed (seconds); now within a budget of 4 MB of reading
  const c = C.classifySync(b, { maxWorkBytes: 4 << 20 });
  assert.ok(c.editable, c.detail);
  assert.equal(c.pages.length, 200);
  // padding larger than the token cap (here lowered to 512 KB; 4 MB by default) is refused by the reader
  assert.equal(C.classifySync(b, { reader: { maxDictionaryBytes: 512 * 1024 } }).detail, 'reader:too-large');
  // the total budget: work, and time
  assert.deepStrictEqual(C.classifySync(b, { maxWorkBytes: 1000 }), { editable: false, reason: 'too-large', detail: 'work-budget' });
  assert.deepStrictEqual(C.classifySync(b, { maxMs: -1 }), { editable: false, reason: 'too-large', detail: 'work-budget' });
  assert.deepStrictEqual(await C.classify(b, { maxWorkBytes: 1000 }), { editable: false, reason: 'too-large', detail: 'work-budget' });
});

// ================================================================ codes that had no test (S5)

test('PV2 base-unreadable, chain-mismatch, startxref-outside-append, object-overlap', WR, async () => {
  const { basic } = await scs();
  const input = (o) => ({ base: basic.base, out: basic.out, classification: basic.cls, state: basic.state, author: AUTHOR, observed: V.expectedObserved(basic.cls, basic.state), ...o });
  const has = (r, code) => r.findings.some((f) => f.code === code);
  // a base the reader refuses (here: its %%EOF cut off; the output still starts with it)
  const cut = basic.base.slice(0, latin1(basic.base).lastIndexOf('%%EOF'));
  assert.ok(has(V.verifySaveSync(input({ base: cut })), 'base-unreadable'));
  // a base file object whose older sections are not those of the output (a caller bug)
  const multi = await scenario('multi-revision.pdf', (c) => [hl(0, c.context.pages, 0)]);
  const bf = multi.baseFile;
  assert.ok(bf.revisions.length >= 2);
  const revs = bf.revisions.map((r, i) => (i === 0 ? new Proxy(r, { get: (t, k) => (k === 'startxref' ? t.startxref + 1 : Reflect.get(t, k, t)) }) : r));
  const fakeBf = new Proxy(bf, { get: (t, k) => (k === 'revisions' ? revs : Reflect.get(t, k, t)) });
  refused(multi, multi.out, 'PV2', 'chain-mismatch', { baseFile: fakeBf });
  // the last startxref names a section inside the base (an orphan section chained to the base's)
  const sx = basic.baseFile.startxref;
  const root = basic.baseFile.trailer.entries.get('Root').num;
  const orphanAt = basic.base.length + 1;
  const base2 = new Uint8Array(Buffer.concat([Buffer.from(basic.base),
    L1(`\nxref\n0 1\n0000000000 65535 f\r\ntrailer\n<< /Size ${basic.baseFile.size} /Root ${root} 0 R /Prev ${sx} >>\nstartxref\n${sx}\n%%EOF\n`)]));
  const cls2 = C.classifySync(base2);
  assert.ok(cls2.editable);
  const out2 = new Uint8Array(Buffer.concat([Buffer.from(base2), L1(`startxref\n${orphanAt}\n%%EOF\n`)]));
  const r2 = V.verifySaveSync({ base: base2, out: out2, classification: cls2, state: basic.state, author: AUTHOR, observed: V.expectedObserved(cls2, basic.state) });
  assert.ok(has(r2, 'startxref-outside-append'), show(r2));
  // an object listed inside another one's string: the two overlap
  const p = split(basic);
  const n = fresh(p);
  p.objects.push({ num: n, gen: 0, body: `<< /Type /Annot /Subtype /Popup /Rect [0 0 1 1] /Parent 1 0 R /T (\n${n + 1} 0 obj\n<< >>\nendobj\n) >>` });
  const first = rebuild(basic.base, p);
  const inner = latin1(first).indexOf(`\n${n + 1} 0 obj`) + 1;
  const r = verify(basic, rebuild(basic.base, p, { extraEntries: [{ num: n + 1, type: 1, a: inner, b: 0 }] }));
  assert.ok(has(r, 'object-overlap'), show(r));
});

test('PV3 superseded-missing; PV4 annot-superseded, other-superseded', WR, async () => {
  // a base with an indirect /MediaBox (object 4) and a free number below /Size (5)
  const base = handBase([null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox 4 0 R >>', '[0 0 612 792]', null]);
  const sc = await scenarioOf(base, (c) => [hl(0, c.context.pages, 0)]);
  passes(sc, sc.out);
  const p = split(sc); p.objects.push({ num: 5, gen: 0, body: '<< /Type /Annot /Subtype /Popup /Rect [0 0 1 1] >>' });
  refused(sc, rebuild(base, p), 'PV3', 'superseded-missing');
  const q = split(sc); q.objects.push({ num: 4, gen: 0, body: '[0 0 612 792]' });
  refused(sc, rebuild(base, q), 'PV4', 'other-superseded');
  // an existing annotation the request does not remove, rewritten (even unchanged)
  const { annotated } = await scs();
  const freed = new Set(SA.expectedFreed(annotated.state, { deletable: annotated.cls.context.deletable }).map(S.refKey));
  const keep = annotated.cls.pages[0].annots.find((a) => a.ref && !freed.has(S.refKey(a.ref)) && a.subtype !== 'Widget');
  const s = split(annotated); s.objects.push({ num: keep.ref.num, gen: 0, body: baseBody(annotated, keep.ref.num) });
  refused(annotated, rebuild(annotated.base, s), 'PV4', 'annot-superseded');
});
