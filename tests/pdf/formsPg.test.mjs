// PWP-28: PG suites for form filling (spec §8.5, §13.2 PG0–PG6) and negative cases on tampered writer output.
//
// Every save goes through the REAL writer service (media/pdfWriter.js `create`, on a Node engine over pdf.js — the
// same code path as the webview, minus the browser Worker), is verified by `verifySaveSync` against the classification
// with forms on and the service's own `observed`, re-read by three independent readers (`assertPg6`: pdf.js, PDFium,
// @cantoo/pdf-lib) with the field values compared between pdf.js and pdf-lib, and then undone: the inverse deltas
// return the state to empty, which saves the loaded bytes (PG2). Accepted outputs go to tests/.out/pdf/forms/ for
// scripts/verify-pdf-open.mjs. Fixtures: forms.pdf (every fillable field type, separate widgets, indirect AcroForm)
// and synthetic files built here (merged field/widgets, multi-select lists with and without /I, an editable combo,
// a NoToggleToOff radio group, Unicode text, an inline AcroForm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { core, fixture } from './_helpers.mjs';
import { assertPg6, readPdfjs, readPdfLib } from './_readers.mjs';
import { skipWriter, warnIfSkipped } from './_node.mjs';

const require = createRequire(import.meta.url);
const Wr = require('../../media/pdfWriter.js');
const S = core.state, SA = core.storageAdapter, V = core.verify, C = core.classify;
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', '.out', 'pdf', 'forms');
warnIfSkipped('formsPg');
if (skipWriter) console.warn(`formsPg: SKIPPED (${skipWriter}; running ${process.versions.node})`);
const T = (name, fn) => test(name, { skip: skipWriter }, fn);
const L1 = (s) => Buffer.from(s, 'latin1');
const sha = (u8) => crypto.createHash('sha256').update(u8).digest('hex');
const latin1 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('latin1');

fs.rmSync(OUT_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------- the real writer service in Node

const pdfjsLib = skipWriter ? null : await import('pdfjs-dist/legacy/build/pdf.mjs');
const openOpts = (data) => ({
  data, verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
  cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
});
const nodeEngine = () => ({
  async createSession() {
    return {
      async open(bytes) {
        const task = pdfjsLib.getDocument(openOpts(new Uint8Array(bytes)));
        const doc = await task.promise;
        return { doc, async close() { await task.destroy(); } };
      },
      dispose() {},
    };
  },
});
let rid = 1;
/** One `pdfWrite` through media/pdfWriter.js, with the viewer shell's members faked: returns the `pdfWriteResult`. */
async function serviceWrite(base, storage) {
  const task = pdfjsLib.getDocument(openOpts(base.slice()));
  const viewed = await task.promise;
  const listeners = [];
  const posted = [];
  const shell = { pdfDocument: viewed, phase: 'ready', generation: 1, post: (m) => posted.push(m),
    on(type, cb) { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); } };
  const service = Wr.create(shell, { engine: nodeEngine() });
  try {
    const req = { type: 'pdfWrite', requestId: rid++, generation: 1, version: 1, storage: JSON.parse(JSON.stringify(storage)) };
    await service.enqueue(req);
    const res = posted.find((m) => m.requestId === req.requestId);
    assert.ok(res && res.ok, `writer failed: ${res?.message}`);
    return res;
  } finally { service.dispose(); await task.destroy(); }
}

// ---------------------------------------------------------------- edits through the real state API

const DATE0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const makeEnv = () => { let t = 0; return { now: () => new Date(DATE0 + 1000 * t++).toISOString(), baseline: new Map() }; };
const ref = (k) => S.parseRefKey(k);
/** setFields op from [key, value, loaded?] triples. */
const setF = (...vals) => ({ op: 'setFields', values: vals.map(([k, value, loaded]) =>
  (loaded === undefined ? { ref: ref(k), value } : { ref: ref(k), value, loaded })) });

function classifyForms(base) {
  const cls = C.classifySync(base, { forms: true });
  assert.ok(cls.editable, `not editable: ${cls.detail}`);
  return cls;
}
const entriesOf = (cls, state) => SA.toStorageEntries(state, { deletable: cls.context.deletable, pages: cls.context.pages, author: 'Forms PG' });
const verifyOut = (base, cls, state, res) => V.verifySaveSync({ base, out: res.bytes, classification: cls, state, author: 'Forms PG', observed: res.observed });

/** Field name per widget key, through pdf.js (names are not in our facts). */
async function widgetNames(base) {
  const task = pdfjsLib.getDocument(openOpts(base.slice()));
  const doc = await task.promise;
  try {
    const out = {};
    for (let i = 1; i <= doc.numPages; i++) {
      for (const a of await (await doc.getPage(i)).getAnnotations()) {
        if (a.subtype === 'Widget') (out[a.fieldName] ??= []).push(S.refKey(SA.parsePdfjsId(a.id)));
      }
    }
    return out;
  } finally { await task.destroy(); }
}

/** pdf.js and pdf-lib must agree on every field's value (text, checkbox, radio, choice) after a save. */
async function readersAgreeOnFields(out) {
  const [js, lib] = [await readPdfjs(out), await readPdfLib(out)];
  for (const [name, lv] of Object.entries(lib.fields)) {
    if (!(name in js.fields) || lv === null) continue;
    const jv = js.fields[name];
    if (typeof lv === 'boolean') assert.equal(lv, jv !== 'Off' && jv !== null && jv !== undefined && jv !== '', `${name}: checkbox`);
    else if (Array.isArray(lv)) assert.deepStrictEqual(lv, [].concat(jv ?? []), `${name}: choice`);
    else if (lv === undefined) assert.ok(jv === 'Off' || jv === null || jv === undefined || jv === '', `${name}: nothing selected`);
    else assert.equal(lv, Array.isArray(jv) ? jv[0] : jv, `${name}: value`);
  }
  return { js, lib };
}

/**
 * Apply `ops` (each a setFields op, or a function of the classification returning one) to an empty state, save
 * through the service, verify, write the output, check PG6 and the field values, then undo every edit and check
 * that the empty state saves the loaded bytes (PG2) — also after the intermediate save. Returns the pieces.
 */
async function fillCase(caseName, base, ops, { expectValues } = {}) {
  const cls = classifyForms(base);
  const state = S.emptyState();
  const env = makeEnv();
  const deltas = [];
  for (const op of ops) {
    const plan = S.applyEdit(state, typeof op === 'function' ? op(cls) : op, cls.context, env);
    assert.ok(plan.ok, `${caseName}: op refused: ${plan.ok ? '' : plan.error.message}`);
    deltas.push(plan.delta);
  }
  assert.ok(!S.isEmptyState(state), `${caseName}: the ops changed nothing`);
  const res = await serviceWrite(base, entriesOf(cls, state));
  const verdict = verifyOut(base, cls, state, res);
  assert.ok(verdict.ok, `${caseName}: verifier refused a real writer output\n${V.formatFindings(verdict)}`);
  // PV6 in the open: every requested field read back with its value
  for (const { ref: r, value } of S.canonicalFields(state)) {
    const got = res.observed.fields.find((f) => f.ref.num === r.num && f.ref.gen === r.gen);
    assert.ok(got, `${caseName}: ${S.refKey(r)} not read back`);
    assert.deepStrictEqual(got.value, value, `${caseName}: ${S.refKey(r)} read back`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${caseName}.pdf`), res.bytes);
  // PG1 is PV1; PG3 is PV2-PV4; PG5 is PV5 (all in the verdict). PG6: three readers, same pages, untouched text.
  const touched = new Set();
  for (const k of state.fields.keys()) {
    const f = cls.forms.fields.find((x) => x.widgets.some((w) => S.refKey(w.ref) === k));
    for (const w of f.widgets) if (w.page !== null) touched.add(w.page + 1);
  }
  await assertPg6(res.bytes, base, { touchedPages: [...touched] });
  const readers = await readersAgreeOnFields(res.bytes);
  if (expectValues) for (const [name, v] of Object.entries(expectValues)) assert.deepStrictEqual(readers.js.fields[name], v, `${caseName}: pdf.js ${name}`);
  // PG2: undo everything -> empty state -> the service writes the loaded bytes.
  for (const d of [...deltas].reverse()) assert.ok(S.applyDelta(state, S.invertDelta(d)), `${caseName}: undo applies`);
  assert.ok(S.isEmptyState(state), `${caseName}: undo returns to the empty state`);
  const entries = entriesOf(cls, state);
  assert.deepStrictEqual(entries, []);
  const back = await serviceWrite(base, entries);
  assert.equal(sha(back.bytes), sha(base), `${caseName}: edit -> undo does not save the original bytes`);
  return { cls, res, verdict, readers };
}

// ---------------------------------------------------------------- synthetic fixtures

function build(objs) {
  const parts = [L1('%PDF-1.7\n')];
  let off = parts[0].length;
  const entries = [];
  for (const [id, body] of Object.entries(objs)) {
    const b = L1(`${id} 0 obj\n${body}\nendobj\n`);
    entries.push({ n: Number(id), off }); off += b.length; parts.push(b);
  }
  entries.sort((a, b) => a.n - b.n);
  let x = 'xref\n0 1\n0000000000 65535 f \n';
  for (const e of entries) x += `${e.n} 1\n${String(e.off).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${entries[entries.length - 1].n + 1} /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(L1(x));
  return new Uint8Array(Buffer.concat(parts));
}
const RECT = (i) => `/Rect [100 ${700 - 40 * i} 300 ${720 - 40 * i}]`;
const W = (i) => `/Type /Annot /Subtype /Widget ${RECT(i)} /P 3 0 R /F 4`;
const DA = '/DA (/Helv 12 Tf 0 g)';
const ONOFF = (on) => `/AP << /N << /${on} 50 0 R /Off 51 0 R >> >>`;
/**
 * One page (object 3) with a Helvetica (WinAnsi) /DR font, `objs` as the field objects; `fields` and `annots` list
 * them. `indirect` puts the AcroForm in its own object (70), as most producers do; otherwise it is inline.
 */
function formDoc(objs, { fields = '10 0 R', annots, indirect = true } = {}) {
  const acro = `<< /Fields [${fields}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 60 0 R >> >> >>`;
  return build({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm ${indirect ? '70 0 R' : acro} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 52 0 R /Resources << /Font << /F1 60 0 R >> >> /Annots [${annots ?? fields}] >>`,
    50: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 20] /Length 23 >>\nstream\n0 0 1 rg 2 2 16 16 re f\nendstream',
    51: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 20] /Length 0 >>\nstream\n\nendstream',
    52: '<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 760 Td (Synthetic form) Tj ET\nendstream',
    60: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...(indirect ? { 70: acro } : {}),
    ...objs,
  });
}
const CH = { COMBO: 1 << 17, EDIT: 1 << 18, MULTI: 1 << 21 };
const RADIO = 1 << 15, NO_TOGGLE_OFF = 1 << 14;
const SYN = {
  mergedText: () => formDoc({ 10: `<< ${W(0)} /T (merged) /FT /Tx ${DA} /V (Before) >>` }),
  inlineText: () => formDoc({ 10: `<< ${W(0)} /T (inline) /FT /Tx ${DA} >>` }, { indirect: false }),
  multi: () => formDoc({ 10: `<< ${W(0)} /T (multi) /FT /Ch /Ff ${CH.MULTI} ${DA} /Opt [(a) (b) (c) (d)] /V [(b)] >>` }),
  multiI: () => formDoc({ 10: `<< ${W(0)} /T (multiI) /FT /Ch /Ff ${CH.MULTI} ${DA} /Opt [[(a) (Alpha)] [(b) (Beta)] (c) (d)] /V [(b)] /I [1] >>` }),
  listI: () => formDoc({ 10: `<< ${W(0)} /T (listI) /FT /Ch ${DA} /Opt [[(x) (Ex)] [(y) (Why)] (z)] /V (x) /I [0] >>` }),
  editCombo: () => formDoc({ 10: `<< ${W(0)} /T (editable) /FT /Ch /Ff ${CH.COMBO + CH.EDIT} ${DA} /Opt [(one) (two)] /V (one) /I [0] >>` }),
  radioNoOff: () => formDoc({
    10: `<< /T (pick) /FT /Btn /Ff ${RADIO + NO_TOGGLE_OFF} /V /a /Kids [11 0 R 12 0 R 13 0 R] >>`,
    11: `<< ${W(0)} /Parent 10 0 R ${ONOFF('a')} /AS /a >>`,
    12: `<< ${W(1)} /Parent 10 0 R ${ONOFF('b')} /AS /Off >>`,
    13: `<< ${W(2)} /Parent 10 0 R ${ONOFF('c')} /AS /Off >>`,
  }, { annots: '11 0 R 12 0 R 13 0 R' }),
  boxes: () => formDoc({
    10: `<< ${W(0)} /T (mergedBox) /FT /Btn /V /Yes /AS /Yes ${ONOFF('Yes')} >>`,
    11: '<< /T (sepBox) /FT /Btn /Kids [12 0 R] >>',
    12: `<< ${W(1)} /Parent 11 0 R ${ONOFF('On')} /AS /Off >>`,
  }, { fields: '10 0 R 11 0 R', annots: '10 0 R 12 0 R' }),
  twoTexts: () => formDoc({ 10: `<< ${W(0)} /T (first) /FT /Tx ${DA} >>`, 11: `<< ${W(1)} /T (second) /FT /Tx ${DA} >>` },
    { fields: '10 0 R 11 0 R' }),
};

// ---------------------------------------------------------------- forms.pdf: every fillable field type

const FORMS = skipWriter ? null : { base: fixture('forms.pdf'), w: await widgetNames(fixture('forms.pdf')) };
const fw = (name, i = 0) => FORMS.w[name][i];

T('forms.pdf: the fillable set is what the suites below cover (text x5, checkbox, radio x3, combo, list)', () => {
  const cls = classifyForms(FORMS.base);
  const names = ['name', 'notes', 'code', 'comb', 'page2.text', 'agree', 'colour', 'country', 'fruit'];
  assert.deepStrictEqual([...cls.context.fields.keys()].sort(), names.flatMap((n) => FORMS.w[n]).sort());
  for (const k of cls.context.fields.keys()) {
    const r = cls.context.fields.get(k);
    assert.ok(r.spec && typeof r.field === 'string', 'every rule carries what the verifier needs');
  }
});

const FORMS_CASES = {
  'text': () => [setF([fw('name'), 'Filled name'])],
  'text-latin1': () => [setF([fw('name'), 'Ünïcödé café – “quotes” € ß'])],
  'text-empty': () => [setF([fw('name'), ''])],
  'text-multiline': () => [setF([fw('notes'), 'Line one\nLine two\r\nLine three'])],
  'text-maxlen': () => [setF([fw('code'), 'XY9Z00'])],
  'text-comb': () => [setF([fw('comb'), '00001111'])],
  'text-page2': () => [setF([fw('page2.text'), 'Page two value'])],
  'checkbox-on': () => [setF([fw('agree'), true, false])],
  'radio-green': () => [setF([fw('colour', 0), false, true], [fw('colour', 1), true, false], [fw('colour', 2), false, false])],
  'radio-blue-then-green': () => [
    setF([fw('colour', 0), false, true], [fw('colour', 1), false, false], [fw('colour', 2), true, false]),
    setF([fw('colour', 0), false], [fw('colour', 1), true], [fw('colour', 2), false]),
  ],
  'combo': () => [(cls) => setF([fw('country'), cls.context.fields.get(fw('country')).spec.options.at(-1)])],
  'list': () => [setF([fw('fruit'), 'Cherry'])],
  'text-typed-twice': () => [setF([fw('name'), 'First']), setF([fw('name'), 'Second'])],
  'all-fields': () => [setF([fw('name'), 'All name'], [fw('notes'), 'One\nTwo'], [fw('code'), 'A1'], [fw('comb'), '12121212'],
    [fw('agree'), true], [fw('colour', 0), false, true], [fw('colour', 1), false, false], [fw('colour', 2), true, false],
    [fw('country'), 'Japan'], [fw('fruit'), 'Banana'], [fw('page2.text'), 'Second page'])],
};
for (const [name, ops] of Object.entries(skipWriter ? {} : FORMS_CASES)) {
  T(`PG forms.pdf / ${name}: writer -> verifier -> three readers -> undo to the original bytes`, async () => {
    await fillCase(`forms-${name}`, FORMS.base, ops());
  });
}

T('PG forms.pdf: values as pdf.js reads them back (radio export values through /Opt, choice arrays)', async () => {
  const { readers } = await fillCase('forms-readback', FORMS.base, FORMS_CASES['all-fields'](), {
    expectValues: { name: 'All name', notes: 'One\nTwo', code: 'A1', agree: 'Yes', colour: 'blue', country: ['Japan'], fruit: ['Banana'] },
  });
  assert.equal(readers.lib.fields.name, 'All name');
  assert.equal(readers.lib.fields.agree, true);
});

T('PG forms.pdf: a save, more edits, a second save, then undo to empty still saves the loaded bytes (PG2)', async () => {
  const base = FORMS.base;
  const cls = classifyForms(base);
  const state = S.emptyState();
  const env = makeEnv();
  const deltas = [];
  const step = (op) => { const p = S.applyEdit(state, op, cls.context, env); assert.ok(p.ok); deltas.push(p.delta); };
  step(setF([fw('name'), 'Saved once']));
  const first = await serviceWrite(base, entriesOf(cls, state));
  assert.ok(verifyOut(base, cls, state, first).ok);
  step(setF([fw('agree'), true, false]));
  step(setF([fw('name'), 'Saved twice']));
  const second = await serviceWrite(base, entriesOf(cls, state));
  const v2 = verifyOut(base, cls, state, second);
  assert.ok(v2.ok, V.formatFindings(v2));
  assert.equal(R(second.bytes).revisions.length, R(base).revisions.length + 1, 'one revision for the current state, not two');
  for (const d of deltas.reverse()) assert.ok(S.applyDelta(state, S.invertDelta(d)));
  assert.equal(sha((await serviceWrite(base, entriesOf(cls, state))).bytes), sha(base));
});
const R = (bytes) => core.reader.openPdfSync(bytes);

T('PG4 forms.pdf: the same state writes the same bytes, except the rewrite times (/M) of the widgets', async () => {
  const cls = classifyForms(FORMS.base);
  const outs = [];
  for (let i = 0; i < 2; i++) {
    const s = S.emptyState();
    assert.ok(S.applyEdit(s, FORMS_CASES['all-fields']()[0], cls.context, makeEnv()).ok);
    outs.push((await serviceWrite(FORMS.base, entriesOf(cls, s))).bytes);
    if (i === 0) await new Promise((r) => setTimeout(r, 1100));
  }
  const mask = (u8) => latin1(u8).replace(/\/M \(D:\d{14}[^)]*\)/g, '/M (D:*)');
  assert.equal(outs[0].length, outs[1].length);
  assert.equal(mask(outs[0]), mask(outs[1]));
});

T('PG0 forms.pdf: an empty state is never written by the writer — the loaded bytes come back', async () => {
  const res = await serviceWrite(FORMS.base, []);
  assert.equal(sha(res.bytes), sha(FORMS.base));
});

// ---------------------------------------------------------------- synthetic fixtures

T('PG synthetic merged text field (field and widget in one object)', async () => {
  const { res } = await fillCase('syn-merged-text', SYN.mergedText(), [setF(['10 0', 'After', 'Before'])], { expectValues: { merged: 'After' } });
  assert.match(latin1(res.bytes.subarray(SYN.mergedText().length)), /\/AP\s*<<\s*\/N \d+ 0 R\s*>>/);
});

T('PG synthetic Unicode text the font can encode (WinAnsi: accents, quotes, euro)', async () => {
  const value = 'Ärger über Öl – “quoted” 5 € · naïve';
  await fillCase('syn-unicode-text', SYN.mergedText(), [setF(['10 0', value, 'Before'])], { expectValues: { merged: value } });
});

T('PG synthetic multi-select list without /I: a selection, then none', async () => {
  await fillCase('syn-multi', SYN.multi(), [setF(['10 0', ['a', 'c', 'd'], ['b']])], { expectValues: { multi: ['a', 'c', 'd'] } });
  await fillCase('syn-multi-none', SYN.multi(), [setF(['10 0', [], ['b']])], { expectValues: { multi: [] } });
});

T('PG synthetic multi-select list WITH /I on the merged field: /I is rewritten in /Opt order and checked', async () => {
  const base = SYN.multiI();
  const { res } = await fillCase('syn-multi-indices', base, [setF(['10 0', ['a', 'c'], ['b']])], { expectValues: { multiI: ['a', 'c'] } });
  assert.match(latin1(res.bytes.subarray(base.length)), /\/I \[0 2\]/);
});

T('PG synthetic single list with /I and [export display] options', async () => {
  const base = SYN.listI();
  const { res } = await fillCase('syn-list-indices', base, [setF(['10 0', 'z', 'x'])], { expectValues: { listI: ['z'] } });
  assert.match(latin1(res.bytes.subarray(base.length)), /\/I \[2\]/);
});

T('PG synthetic editable combo: free text (not an option; /I becomes empty) and an option', async () => {
  const { res } = await fillCase('syn-combo-free', SYN.editCombo(), [setF(['10 0', 'Typed by hand', 'one'])], { expectValues: { editable: ['Typed by hand'] } });
  assert.match(latin1(res.bytes.subarray(SYN.editCombo().length)), /\/I \[\]/);
  await fillCase('syn-combo-option', SYN.editCombo(), [setF(['10 0', 'two', 'one'])], { expectValues: { editable: ['two'] } });
});

T('PG synthetic NoToggleToOff radio group: switch, and the group can be neither cleared nor doubled', async () => {
  const base = SYN.radioNoOff();
  await fillCase('syn-radio-notoggle', base, [setF(['11 0', false, true], ['12 0', false, false], ['13 0', true, false])], { expectValues: { pick: 'c' } });
  const cls = classifyForms(base);
  const p = S.planEdit(S.emptyState(), setF(['11 0', false, true], ['12 0', false, false], ['13 0', false, false]), cls.context, makeEnv());
  assert.equal(p.ok, false);
  assert.match(p.error.message, /must stay on/);
  assert.equal(S.planEdit(S.emptyState(), setF(['11 0', true], ['12 0', true], ['13 0', false]), cls.context, makeEnv()).ok, false);
});

T('PG synthetic checkboxes: a merged one turned off, a separate one turned on', async () => {
  await fillCase('syn-boxes', SYN.boxes(), [setF(['10 0', false, true], ['12 0', true, false])], { expectValues: { mergedBox: 'Off', sepBox: 'On' } });
});

T('PG synthetic: two text fields in one save get one fresh appearance each', async () => {
  await fillCase('syn-two-texts', SYN.twoTexts(), [setF(['10 0', 'One'], ['11 0', 'Two'])], { expectValues: { first: 'One', second: 'Two' } });
});

// ---------------------------------------------------------------- values the font cannot draw (open item 1)

T('refused: text the field font cannot encode — indirect AcroForm (pdf.js adds /NeedAppearances): specific message', async () => {
  for (const value of ['日本語', 'Ελληνικά', 'x😀']) {
    const base = FORMS.base;
    const cls = classifyForms(base);
    const s = S.emptyState();
    assert.ok(S.applyEdit(s, setF([fw('name'), value]), cls.context, makeEnv()).ok, 'the state accepts it: only the writer knows the font');
    const res = await serviceWrite(base, entriesOf(cls, s));
    const v = verifyOut(base, cls, s, res);
    assert.equal(v.ok, false);
    assert.ok(v.findings.some((f) => f.code === 'need-appearances'), V.formatFindings(v));
    assert.ok(v.findings.some((f) => f.code === 'appearance-missing' && f.obj === ref(fw('name')).num), V.formatFindings(v));
    assert.equal(V.verifyFailureMessage(v), V.FIELD_APPEARANCE_MESSAGE);
    assert.deepStrictEqual(res.observed.fields.map((f) => f.value), [value], 'the read-back alone would not have caught it');
  }
});

T('refused: text the font cannot encode — inline AcroForm (pdf.js silently drops the widget /AP): specific message', async () => {
  const base = SYN.inlineText();
  const cls = classifyForms(base);
  const s = S.emptyState();
  assert.ok(S.applyEdit(s, setF(['10 0', '中文']), cls.context, makeEnv()).ok);
  const res = await serviceWrite(base, entriesOf(cls, s));
  assert.ok(!/NeedAppearances/.test(latin1(res.bytes.subarray(base.length))), 'pdf.js cannot reach an inline AcroForm');
  const v = verifyOut(base, cls, s, res);
  assert.deepStrictEqual(v.findings, [{ check: 'PV4', code: 'appearance-missing', obj: 10 }]);
  assert.equal(V.verifyFailureMessage(v), V.FIELD_APPEARANCE_MESSAGE);
  // the same file takes an encodable value
  await fillCase('syn-inline-acroform', base, [setF(['10 0', 'Encodable'])], { expectValues: { inline: 'Encodable' } });
});

// ---------------------------------------------------------------- tampered writer output (negative)

/** Same-length byte substitution in the appended region (xref offsets stay valid). */
function patch(base, out, from, to) {
  assert.equal(from.length, to.length);
  const tail = latin1(out.subarray(base.length));
  const at = tail.indexOf(from);
  assert.ok(at >= 0, `"${from}" not in the appended revision`);
  const copy = out.slice();
  copy.set(L1(to), base.length + at);
  return copy;
}
async function written(base, ops, extraStorage = []) {
  const cls = classifyForms(base);
  const state = S.emptyState();
  for (const op of ops) assert.ok(S.applyEdit(state, op, cls.context, makeEnv()).ok);
  const res = await serviceWrite(base, [...entriesOf(cls, state), ...extraStorage]);
  // what a compromised writer would claim: exactly the request
  const observed = V.expectedObserved(cls, state);
  const check = (out) => V.verifySaveSync({ base, out, classification: cls, state, author: 'Forms PG', observed });
  return { cls, state, res, check };
}
const codes = (v) => v.findings.map((f) => `${f.check} ${f.code}`);

T('tampered: a field value changed after writing (text, choice /V, choice /I, checkbox /AS, radio /V)', async () => {
  const t = await written(FORMS.base, [setF([fw('name'), 'Honest value'])]);
  assert.ok(t.check(t.res.bytes).ok);
  assert.ok(codes(t.check(patch(FORMS.base, t.res.bytes, '(Honest value)', '(Hacked value)'))).includes('PV4 value-mismatch'));

  const mb = SYN.multiI();
  const m = await written(mb, [setF(['10 0', ['a', 'c'], ['b']])]);
  assert.ok(m.check(m.res.bytes).ok);
  assert.ok(codes(m.check(patch(mb, m.res.bytes, '/V [(a) (c)]', '/V [(a) (d)]'))).includes('PV4 value-mismatch'));
  assert.ok(codes(m.check(patch(mb, m.res.bytes, '/I [0 2]', '/I [0 3]'))).includes('PV4 value-mismatch'));
  assert.ok(codes(m.check(patch(mb, m.res.bytes, '/I [0 2]', '/I [2 0]'))).includes('PV4 value-mismatch'));

  const b = await written(FORMS.base, [setF([fw('agree'), true, false])]);
  assert.ok(b.check(b.res.bytes).ok);
  assert.ok(codes(b.check(patch(FORMS.base, b.res.bytes, '/AS /Yes', '/AS /Off'))).includes('PV4 value-mismatch'));
  assert.ok(codes(b.check(patch(FORMS.base, b.res.bytes, '/V /Yes', '/V /Off'))).includes('PV4 value-mismatch'));

  const r = await written(FORMS.base, [setF([fw('colour', 0), false, true], [fw('colour', 1), true, false], [fw('colour', 2), false, false])]);
  assert.ok(r.check(r.res.bytes).ok);
  assert.ok(codes(r.check(patch(FORMS.base, r.res.bytes, '/V /1', '/V /2'))).includes('PV4 value-mismatch'));
});

T('tampered: the writer rewrote a field the request does not set', async () => {
  const cls = classifyForms(FORMS.base);
  const extra = [[SA.pdfjsId(ref(fw('code'))), { value: 'EXTRA' }]];
  const t = await written(FORMS.base, [setF([fw('name'), 'Requested'])], extra);
  const v = t.check(t.res.bytes);
  assert.ok(codes(v).includes('PV4 field-unexpected'), V.formatFindings(v));
  // the extra field's field node and widget are both named
  const codeField = Number(cls.context.fields.get(fw('code')).field.split(' ')[0]);
  for (const n of [ref(fw('code')).num, codeField]) assert.ok(v.findings.some((f) => f.code === 'field-unexpected' && f.obj === n), `obj ${n}`);
  // a radio member turned on behind the request's back
  const r = await written(FORMS.base, [setF([fw('name'), 'Requested'])], [[SA.pdfjsId(ref(fw('colour', 2))), { value: true }]]);
  assert.ok(codes(r.check(r.res.bytes)).includes('PV4 field-unexpected'));
});

T('tampered: a widget /AP taken from another field (shared new appearance; another field\'s base appearance)', async () => {
  const base = SYN.twoTexts();
  const t = await written(base, [setF(['10 0', 'One'], ['11 0', 'Two'])]);
  assert.ok(t.check(t.res.bytes).ok);
  const tail = latin1(t.res.bytes.subarray(base.length));
  const apOf = (num) => new RegExp(`(?:^|\\n)${num} 0 obj[\\s\\S]*?/AP << /N (\\d+) 0 R>>`).exec(tail)[1];
  const [a, b] = [apOf(10), apOf(11)];
  assert.notEqual(a, b);
  // widget 11 shows widget 10's appearance: the form is shared and 11's own is orphaned
  const shared = t.check(patch(base, t.res.bytes, `/V (Two) /AP << /N ${b} 0 R>>`, `/V (Two) /AP << /N ${a} 0 R>>`));
  assert.ok(codes(shared).includes('PV4 ap-target'), V.formatFindings(shared));
  assert.ok(codes(shared).includes('PV4 orphan-object'), V.formatFindings(shared));
  // widget 10 points at a base appearance stream (a checkbox-style stream of the file)
  const pad = (n) => String(n).padStart(String(a).length, ' ');
  const borrowed = t.check(patch(base, t.res.bytes, `/V (One) /AP << /N ${a} 0 R>>`, `/V (One) /AP << /N ${pad(50)} 0 R>>`));
  assert.ok(codes(borrowed).includes('PV4 appearance-missing'), V.formatFindings(borrowed));
});

T('tampered: the AcroForm changed (pdf.js /NeedAppearances is named; any other change is the plain refusal)', async () => {
  const t = await written(FORMS.base, [setF([fw('name'), '日本'])]);
  const v = t.check(t.res.bytes);
  assert.ok(codes(v).includes('PV4 need-appearances'), V.formatFindings(v));
  const other = t.check(patch(FORMS.base, t.res.bytes, '/NeedAppearances true', '/NeedAppearances 1234'));
  assert.ok(codes(other).includes('PV4 acroform-superseded'), V.formatFindings(other));
  assert.ok(!codes(other).includes('PV4 need-appearances'));
  assert.equal(V.verifyFailureMessage(t.check(t.res.bytes)), V.FIELD_APPEARANCE_MESSAGE);
});
