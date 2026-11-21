// PWP-27: form classification and field rules (core) — spec §6.2, §6.3 setFields, §8.5. Which terminal
// fields are fillable and with which value rule (core/classify.ts, `classify(bytes, { forms: true })`),
// why the others are locked, and how core/state.ts applies the rules. Oracle: pdf.js (legacy build, Node),
// whose `getAnnotations()` widgets are what the webview's form inputs are built from (`getFieldObjects()`
// is empty for these fixtures in 6.5.438).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { core, fixture, allFixtures } from './_helpers.mjs';

const C = core.classify;
const S = core.state;
const SA = core.storageAdapter;
const V = core.verify;
const L1 = (s) => Buffer.from(s, 'latin1');
const require = createRequire(import.meta.url);
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const skipWriter = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13) ? false : 'pdf.js saveDocument() needs Node >= 22.13';

const ON = { forms: true };
const env = () => { let t = 0; return { now: () => new Date(Date.UTC(2026, 10, 21) + 1000 * t++).toISOString(), baseline: new Map() }; };
const ref = (k) => S.parseRefKey(k);
const setF = (...pairs) => ({ op: 'setFields', values: pairs.map(([k, value, loaded]) =>
  (loaded === undefined ? { ref: ref(k), value } : { ref: ref(k), value, loaded })) });
const plan = (ctx, ...pairs) => S.planEdit(S.emptyState(), setF(...pairs), ctx, env());
function accepts(ctx, ...pairs) {
  const p = plan(ctx, ...pairs);
  assert.ok(p.ok, p.ok ? '' : `refused: ${p.error.reason}: ${p.error.message}`);
  return p;
}
function refuses(ctx, reason, ...pairs) {
  const p = plan(ctx, ...pairs);
  assert.strictEqual(p.ok, false, `expected refusal ${reason}`);
  assert.strictEqual(p.error.reason, reason);
  assert.strictEqual(p.error.code, 'invalid');
  assert.ok(p.error.message.length > 0);
  return p.error.message;
}

// ------------------------------------------------------------------ pdf.js oracle

let pdfjsLib;
async function openPdfjs(bytes) {
  pdfjsLib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useWorkerFetch: false,
    enableXfa: false, standardFontDataUrl: PJ + '/standard_fonts/', cMapUrl: PJ + '/cmaps/' });
  return { task, doc: await task.promise };
}
/** pdf.js widgets: id -> facts the webview's inputs are built from, plus the calculation order. */
async function pdfjsWidgets(bytes) {
  const { task, doc } = await openPdfjs(bytes);
  try {
    const widgets = new Map();
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      for (const a of await p.getAnnotations()) {
        if (a.subtype !== 'Widget') continue;
        widgets.set(a.id, { page: i - 1, name: a.fieldName, fieldType: a.fieldType, value: a.fieldValue, readOnly: !!a.readOnly,
          required: !!a.required, multiLine: !!a.multiLine, comb: !!a.comb, maxLen: a.maxLen ?? 0, checkBox: !!a.checkBox,
          radioButton: !!a.radioButton, pushButton: !!a.pushButton, combo: !!a.combo, multiSelect: !!a.multiSelect,
          exportValue: a.exportValue ?? null, buttonValue: a.buttonValue ?? null, scripts: !!a.actions,
          options: a.options ? a.options.map((o) => o.exportValue) : null });
      }
    }
    return { widgets, calc: await doc.getCalculationOrderIds() };
  } finally { await task.destroy(); }
}
const idKey = (id) => { const m = /^(\d+)R(\d*)$/.exec(id); return `${m[1]} ${m[2] || 0}`; };
const pdfjsType = (w) => (w.fieldType === 'Sig' ? 'signature' : w.fieldType === 'Tx' ? 'text'
  : w.fieldType === 'Btn' ? (w.pushButton ? 'push-button' : w.radioButton ? 'radio' : 'checkbox')
  : w.fieldType === 'Ch' ? (w.combo ? 'combo' : 'list') : 'unknown');

// ------------------------------------------------------------------ per-field expectations

/**
 * Expected facts per field NAME (pdf.js `fieldName`; names are not in our facts, the oracle maps widget ids to names):
 * type, widgets, the lock reason or 'fillable', and the value-rule facts.
 */
const FIELDS = {
  'forms.pdf': {
    name: { type: 'text', widgets: 1, rule: 'fillable', maxLen: null, multiline: false, comb: false },
    notes: { type: 'text', widgets: 1, rule: 'fillable', maxLen: null, multiline: true, comb: false },
    code: { type: 'text', widgets: 1, rule: 'fillable', maxLen: 6, multiline: false, comb: false },
    comb: { type: 'text', widgets: 1, rule: 'fillable', maxLen: 8, multiline: false, comb: true },
    agree: { type: 'checkbox', widgets: 1, rule: 'fillable' },
    colour: { type: 'radio', widgets: 3, rule: 'fillable' },
    country: { type: 'combo', widgets: 1, rule: 'fillable', options: 3, editable: false },
    fruit: { type: 'list', widgets: 1, rule: 'fillable', options: 4, multiSelect: false },
    locked: { type: 'text', widgets: 1, rule: 'read-only' },
    Signature1: { type: 'signature', widgets: 1, rule: 'signature' },
    'page2.text': { type: 'text', widgets: 1, rule: 'fillable', maxLen: null, multiline: false, comb: false },
  },
  // Decision 2026-11-21 (orchestrator, conservative): fields with /AA, or in /CO, are not fillable.
  'forms-js.pdf': {
    qty: { type: 'text', widgets: 1, rule: 'scripts', scripts: true, calculated: false },
    price: { type: 'text', widgets: 1, rule: 'scripts', scripts: true, calculated: false },
    total: { type: 'text', widgets: 1, rule: 'scripts', scripts: true, calculated: true },
  },
};

for (const [name, expect] of Object.entries(FIELDS)) {
  test(`${name}: every field's type, widgets, lock reason and rule facts — and they agree with pdf.js`, async () => {
    const bytes = fixture(name);
    const r = C.classifySync(bytes, ON);
    assert.strictEqual(r.editable, true);
    const js = await pdfjsWidgets(bytes);
    // Name each fact through pdf.js (one name per field; every widget of a field has it).
    const byName = new Map();
    for (const f of r.forms.fields) {
      const names = new Set(f.widgets.map((w) => js.widgets.get(SA.pdfjsId(w.ref))?.name));
      assert.strictEqual(names.size, 1, `field ${S.refKey(f.ref)}: widgets known to pdf.js under one name`);
      byName.set([...names][0], f);
    }
    assert.deepStrictEqual([...byName.keys()].sort(), Object.keys(expect).sort());
    assert.strictEqual(r.forms.terminalFields, Object.keys(expect).length);
    for (const [fname, e] of Object.entries(expect)) {
      const f = byName.get(fname);
      const got = { type: f.type, widgets: f.widgets.length, rule: f.fillable ? 'fillable' : f.locked };
      for (const k of ['maxLen', 'multiline', 'comb', 'options', 'editable', 'multiSelect', 'scripts', 'calculated']) if (k in e) got[k] = f[k];
      assert.deepStrictEqual(got, e, fname);
    }
    // pdf.js cross-check per widget: type, flags, placement, scripts, calculation order.
    const calc = new Set((js.calc ?? []).map(idKey));
    let widgetCount = 0;
    for (const f of r.forms.fields) {
      for (const w of f.widgets) {
        widgetCount++;
        const pj = js.widgets.get(SA.pdfjsId(w.ref));
        assert.ok(pj, `${SA.pdfjsId(w.ref)} unknown to pdf.js`);
        assert.strictEqual(f.type, pdfjsType(pj), `${pj.name}: type`);
        assert.strictEqual(w.page, pj.page, `${pj.name}: page`);
        assert.strictEqual(f.readOnly, pj.readOnly, `${pj.name}: read-only`);
        assert.strictEqual(f.required, pj.required, `${pj.name}: required`);
        if (f.type === 'text') {
          assert.strictEqual(f.multiline, pj.multiLine, `${pj.name}: multiline`);
          assert.strictEqual(f.comb, pj.comb, `${pj.name}: comb`);
          assert.strictEqual(f.maxLen ?? 0, pj.maxLen, `${pj.name}: maxLen`);
        }
        if (f.type === 'list') assert.strictEqual(f.multiSelect, pj.multiSelect);
        if (pj.options) assert.strictEqual(f.options, pj.options.length, `${pj.name}: options`);
        assert.strictEqual(f.scripts, pj.scripts, `${pj.name}: scripts (pdf.js actions)`);
        assert.strictEqual(f.calculated, calc.has(S.refKey(f.ref)), `${pj.name}: /CO`);
      }
    }
    assert.strictEqual(widgetCount, js.widgets.size, 'every pdf.js widget belongs to a classified field');
    // Fillable / locked partition of the widgets, as the context and info carry it.
    const fillable = r.forms.fields.filter((f) => f.fillable);
    assert.strictEqual(r.forms.fillableFields, fillable.length);
    const fillableWidgets = fillable.flatMap((f) => f.widgets.map((w) => S.refKey(w.ref))).sort();
    const lockedWidgets = r.forms.fields.filter((f) => !f.fillable).flatMap((f) => f.widgets.map((w) => S.refKey(w.ref))).sort();
    if (fillable.length) {
      assert.deepStrictEqual(r.info.forms.editable, true);
      assert.deepStrictEqual([...r.context.fields.keys()].sort(), fillableWidgets);
      assert.deepStrictEqual(r.info.forms.lockedFields.map(S.refKey).sort(), lockedWidgets);
      for (const k of lockedWidgets) assert.ok(r.context.locked.has(k));
    } else {
      assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'none', lockedFields: [] });
      assert.strictEqual(r.context.fields.size, 0);
    }
    assert.strictEqual(r.forms.scriptedFields, r.forms.fields.filter((f) => f.scripts || f.calculated).length);
  });
}

test('the option set is honoured: flag off (default) keeps forms off with the facts still collected', () => {
  for (const name of ['forms.pdf', 'forms-js.pdf']) {
    const off = C.classifySync(fixture(name));
    assert.deepStrictEqual(off.info.forms, { editable: false, reason: 'flag-off', lockedFields: [] });
    assert.strictEqual(off.context.fields.size, 0);
    assert.strictEqual(off.context.locked.size, 0);
    const on = C.classifySync(fixture(name), ON);
    assert.deepStrictEqual(off.forms, on.forms, 'facts do not depend on the flag');
  }
});

test('forms on: fixtures without fillable fields report reason none; async agrees with sync', async () => {
  for (const name of allFixtures()) {
    const r = C.classifySync(fixture(name), ON);
    if (!r.editable) continue;
    const a = await C.classify(fixture(name), ON);
    assert.deepStrictEqual([a.forms, a.info, [...a.context.fields.keys()], [...a.context.locked]], [r.forms, r.info, [...r.context.fields.keys()], [...r.context.locked]], name);
    if (name === 'forms.pdf') continue;
    assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'none', lockedFields: [] }, name);
    assert.strictEqual(r.context.fields.size, 0, name);
  }
});

// ------------------------------------------------------------------ value rules on forms.pdf

async function formsCtx() {
  const bytes = fixture('forms.pdf');
  const r = C.classifySync(bytes, ON);
  const js = await pdfjsWidgets(bytes);
  const w = {}; // field name -> widget keys
  for (const [id, pj] of js.widgets) (w[pj.name] ??= []).push(idKey(id));
  return { r, ctx: r.context, w, js };
}

test('forms.pdf text rules: MaxLen, comb, single line vs multiline', async () => {
  const { ctx, w } = await formsCtx();
  const [name, notes, code, comb, p2] = [w.name[0], w.notes[0], w.code[0], w.comb[0], w['page2.text'][0]];
  accepts(ctx, [name, 'Any length of text on one line: ' + 'x'.repeat(5000)]);
  assert.match(refuses(ctx, 'bad-value', [name, 'two\nlines']), /single line/);
  refuses(ctx, 'bad-value', [name, 'carriage\rreturn']);
  accepts(ctx, [notes, 'Line one\nLine two\r\nLine three']);
  accepts(ctx, [code, 'ABCDEF']);
  assert.match(refuses(ctx, 'bad-value', [code, 'ABCDEFG']), /at most 6 characters/);
  accepts(ctx, [code, '']);
  accepts(ctx, [comb, '87654321']);
  assert.match(refuses(ctx, 'bad-value', [comb, '123456789']), /at most 8/);
  refuses(ctx, 'bad-value', [comb, '1234\n']);
  // MaxLen counts UTF-16 code units, as the browser's maxLength does: 3 astral characters are 6 units.
  accepts(ctx, [code, '😀😀😀']);
  refuses(ctx, 'bad-value', [code, '😀😀😀😀']);
  accepts(ctx, [p2, 'Second page']);
  refuses(ctx, 'bad-value', [name, true]);
  refuses(ctx, 'bad-value', [name, ['a']]);
});

test('forms.pdf checkbox and radio rules: on-states, whole groups, at most one on', async () => {
  const { ctx, w, js, r } = await formsCtx();
  const agree = w.agree[0];
  accepts(ctx, [agree, true]);
  refuses(ctx, 'bad-value', [agree, 'Yes']);
  const [red, green, blue] = w.colour;
  // pdf.js on-states (export values) are distinct, one per widget — classification requires exactly that.
  assert.deepStrictEqual(w.colour.map((k) => js.widgets.get(SA.pdfjsId(ref(k))).buttonValue), ['red', 'green', 'blue']);
  const g = ctx.fields.get(red).group;
  assert.deepStrictEqual({ key: g.key, members: [...g.members], exactlyOne: g.exactlyOne },
    { key: S.refKey(r.forms.fields.find((f) => f.type === 'radio').ref), members: [red, green, blue], exactlyOne: false });
  const p = accepts(ctx, [red, false, true], [green, true, false], [blue, false, false]);
  assert.deepStrictEqual(p.delta.map((e) => [e.key, e.after]), [[red, false], [green, true]], 'blue unchanged: no entry');
  // Clearing a group is refused (PWP-28: pdf.js writes /V only when a button turns on, so it would keep naming the
  // old one); restating a group that was loaded all off changes nothing and is accepted.
  assert.match(refuses(ctx, 'bad-value', [red, false], [green, false], [blue, false]), /cannot be cleared/);
  assert.match(refuses(ctx, 'bad-value', [red, false, true], [green, false, false], [blue, false, false]), /cannot be cleared/);
  assert.deepStrictEqual(accepts(ctx, [red, false, false], [green, false, false], [blue, false, false]).delta, []);
  assert.match(refuses(ctx, 'bad-value', [green, true]), /as a whole/);
  assert.match(refuses(ctx, 'bad-value', [red, false], [green, true]), /as a whole/);
  assert.match(refuses(ctx, 'bad-value', [red, true], [green, true], [blue, false]), /Only one/);
  refuses(ctx, 'bad-value', [red, 'red'], [green, false], [blue, false]);
  // A radio group and other fields in one op.
  accepts(ctx, [red, false], [green, false], [blue, true], [agree, true], [w.name[0], 'x']);
});

test('forms.pdf choice rules: combo and list take one of their export values', async () => {
  const { ctx, w, js } = await formsCtx();
  const country = w.country[0], fruit = w.fruit[0];
  for (const o of js.widgets.get(SA.pdfjsId(ref(country))).options) accepts(ctx, [country, o]);
  for (const o of js.widgets.get(SA.pdfjsId(ref(fruit))).options) accepts(ctx, [fruit, o]);
  assert.match(refuses(ctx, 'bad-value', [country, 'France']), /not one of the field's options/);
  refuses(ctx, 'bad-value', [country, 'germany']);
  refuses(ctx, 'bad-value', [fruit, 'Banana ']);
  assert.match(refuses(ctx, 'bad-value', [fruit, ['Banana']]), /one value/);
  refuses(ctx, 'bad-value', [country, true]);
});

test('forms.pdf locked fields: state refuses read-only and signature widgets with the reason', async () => {
  const { ctx, w } = await formsCtx();
  assert.strictEqual(refuses(ctx, 'field-locked', [w.locked[0], 'changed']), S.FIELD_LOCK_MESSAGES['read-only']);
  assert.strictEqual(refuses(ctx, 'field-locked', [w.Signature1[0], 'x']), S.FIELD_LOCK_MESSAGES.signature);
  // The read-only field's node (not a widget) is locked too; an unknown object is just not fillable.
  const lockedField = [...ctx.locked].find(([k, why]) => why === 'read-only' && k !== w.locked[0]);
  assert.ok(lockedField, 'field node of the read-only field');
  refuses(ctx, 'field-locked', [lockedField[0], 'x']);
  refuses(ctx, 'not-fillable', ['999 0', 'x']);
  // A refused member refuses the whole op.
  refuses(ctx, 'field-locked', [w.name[0], 'ok'], [w.locked[0], 'no']);
});

test('forms-js.pdf: every field is locked for scripts and the state refuses them', async () => {
  const r = C.classifySync(fixture('forms-js.pdf'), ON);
  assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'none', lockedFields: [] });
  // Forms are off for the document (nothing fillable), so the context carries no rules and no locks.
  const k = S.refKey(r.forms.fields[0].widgets[0].ref);
  refuses(r.context, 'not-fillable', [k, '4']);
  // Had something else been fillable, the locks would name the reason:
  const ctx = { ...r.context, locked: new Map([[k, 'scripts']]) };
  assert.strictEqual(refuses(ctx, 'field-locked', [k, '4']), S.FIELD_LOCK_MESSAGES.scripts);
  assert.strictEqual(r.forms.scriptedFields, 3);
});

// ------------------------------------------------------------------ synthetic files

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
/** One page (object 3), AcroForm with `fields`, page /Annots `annots` (default: the same), extra objects. */
function formDoc(objs, { fields = '10 0 R', annots, acro = '', page2 = false } = {}) {
  return build({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fields}] ${acro} >> >>`,
    2: `<< /Type /Pages /Kids [3 0 R${page2 ? ' 4 0 R' : ''}] /Count ${page2 ? 2 : 1} >>`,
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${annots ?? fields}] >>`,
    ...(page2 ? { 4: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${page2}] >>` } : {}),
    50: '<< /Length 0 >>\nstream\n\nendstream',
    ...objs,
  });
}
const W = '/Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R';
const AP = (on) => `/AP << /N << /${on} 50 0 R /Off 50 0 R >> >>`;
const merged = (extra) => `<< ${W} /T (f) ${extra} >>`;
const classifyOn = (bytes) => { const r = C.classifySync(bytes, ON); assert.strictEqual(r.editable, true, `${r.reason} ${r.detail}`); return r; };
/** The single field's verdict: 'fillable' or its lock reason. */
const verdict = (bytes) => { const f = classifyOn(bytes).forms.fields[0]; return f.fillable ? 'fillable' : f.locked; };
const one = (extra, opts) => verdict(formDoc({ 10: merged(extra) }, opts));

test('synthetic text fields: fillable baseline and each text lock', () => {
  assert.strictEqual(one('/FT /Tx'), 'fillable');
  assert.strictEqual(one('/FT /Tx /Ff 1'), 'read-only');
  assert.strictEqual(one('/FT /Tx /Ff 3'), 'read-only');
  assert.strictEqual(one('/FT /Tx /Ff 2'), 'fillable', 'Required alone does not lock');
  assert.strictEqual(one(`/FT /Tx /Ff ${1 << 13}`), 'password');
  assert.strictEqual(one(`/FT /Tx /Ff ${1 << 20}`), 'file-select');
  assert.strictEqual(one(`/FT /Tx /Ff ${1 << 25}`), 'rich-text');
  assert.strictEqual(one('/FT /Tx /RV (<body/>)'), 'rich-text');
  assert.strictEqual(one('/FT /Tx /PMD << >>'), 'barcode');
  assert.strictEqual(one('/FT /Tx /MaxLen 5'), 'fillable');
  for (const ml of ['0', '-1', '2.5', '(5)']) assert.strictEqual(one(`/FT /Tx /MaxLen ${ml}`), 'bad-max-len', `MaxLen ${ml}`);
  assert.strictEqual(one(`/FT /Tx /Ff ${1 << 24}`), 'bad-max-len', 'Comb without MaxLen');
  assert.strictEqual(one(`/FT /Tx /Ff ${(1 << 24) + (1 << 12)} /MaxLen 4`), 'bad-flags', 'Comb and Multiline');
  for (const ff of ['-1', '1.5', '(1)', '4294967296']) assert.strictEqual(one(`/FT /Tx /Ff ${ff}`), 'bad-flags', `Ff ${ff}`);
  assert.strictEqual(one(''), 'unknown-type');
  assert.strictEqual(one('/FT /Xx'), 'unknown-type');
  // The read-only bit wins over later reasons; signature over everything.
  assert.strictEqual(one(`/FT /Tx /Ff ${1 + (1 << 13)}`), 'read-only');
  assert.strictEqual(one('/FT /Sig /Ff 1'), 'signature');
});

test('synthetic: Required is reported and an empty value is accepted', () => {
  const r = classifyOn(formDoc({ 10: merged('/FT /Tx /Ff 2 /V (x)') }));
  assert.strictEqual(r.forms.fields[0].required, true);
  accepts(r.context, ['10 0', '']);
});

test('synthetic scripts and calculation (decision 2026-11-21): /AA on field, ancestor or widget; widget /A; /CO', () => {
  assert.strictEqual(one('/FT /Tx /AA << /K 60 0 R >>'), 'scripts');
  assert.strictEqual(one('/FT /Tx /A << /S /JavaScript /JS (1) >>'), 'scripts');
  assert.strictEqual(one('/FT /Tx', { acro: '/CO [10 0 R]' }), 'calculated');
  // Separate widget under a field under a parent: /AA on the parent, then on the widget.
  const tree = (parentExtra, widgetExtra, acro = '') => verdict(formDoc({
    10: `<< /T (p) /Kids [11 0 R] ${parentExtra} >>`,
    11: '<< /T (c) /FT /Tx /Parent 10 0 R /Kids [12 0 R] >>',
    12: `<< ${W} /Parent 11 0 R ${widgetExtra} >>` }, { annots: '12 0 R', acro }));
  assert.strictEqual(tree('', ''), 'fillable');
  assert.strictEqual(tree('/AA << /C 60 0 R >>', ''), 'scripts');
  assert.strictEqual(tree('', '/AA << /Fo 60 0 R >>'), 'scripts');
  assert.strictEqual(tree('', '', '/CO [10 0 R]'), 'calculated', 'an ancestor in /CO');
  assert.strictEqual(tree('', '', '/CO [11 0 R]'), 'calculated');
  // A push button's /A is its purpose, not a script on a value: still locked as a push button.
  assert.strictEqual(one(`/FT /Btn /Ff ${1 << 16} /A << /S /JavaScript /JS (1) >>`), 'push-button');
});

test('synthetic AcroForm-level: NeedAppearances locks every field; XFA turns forms off', () => {
  assert.strictEqual(one('/FT /Tx', { acro: '/NeedAppearances true' }), 'need-appearances');
  assert.strictEqual(one('/FT /Tx', { acro: '/NeedAppearances false' }), 'fillable');
  const r = classifyOn(formDoc({ 10: merged('/FT /Tx') }, { acro: '/XFA [(x) 60 0 R]' }));
  assert.deepStrictEqual(r.info.forms, { editable: false, reason: 'xfa', lockedFields: [] });
  assert.strictEqual(r.forms.fields[0].locked, 'xfa');
  assert.strictEqual(r.context.fields.size, 0);
});

test('synthetic buttons: on-states, push buttons, multi-widget checkboxes, radio groups', () => {
  assert.strictEqual(one(`/FT /Btn ${AP('Yes')}`), 'fillable');
  assert.strictEqual(one('/FT /Btn'), 'no-on-state');
  assert.strictEqual(one('/FT /Btn /AP << /N << /Off 50 0 R >> >>'), 'no-on-state');
  assert.strictEqual(one('/FT /Btn /AP << /N 50 0 R >>'), 'no-on-state');
  assert.strictEqual(one('/FT /Btn /AP << /N << /A 50 0 R /B 50 0 R /Off 50 0 R >> >>'), 'ambiguous-on-state');
  assert.strictEqual(one(`/FT /Btn /Ff ${1 << 16}`), 'push-button');
  const group = (ff, ons, extra = '') => formDoc({
    10: `<< /T (g) /FT /Btn /Ff ${ff} /Kids [${ons.map((_, i) => `${11 + i} 0 R`).join(' ')}] ${extra} >>`,
    ...Object.fromEntries(ons.map((on, i) => [11 + i, `<< ${W} /Parent 10 0 R ${on ? AP(on) : ''} >>`])),
  }, { annots: ons.map((_, i) => `${11 + i} 0 R`).join(' ') });
  const RADIO = 1 << 15;
  assert.strictEqual(verdict(group(RADIO, ['a', 'b', 'c'])), 'fillable');
  assert.strictEqual(verdict(group(RADIO, ['a', 'a'])), 'ambiguous-on-state');
  assert.strictEqual(verdict(group(RADIO + (1 << 25), ['a', 'a'])), 'ambiguous-on-state', 'RadiosInUnison is not supported');
  assert.strictEqual(verdict(group(RADIO, ['a', null])), 'no-on-state');
  assert.strictEqual(verdict(group(0, ['a', 'b'])), 'multi-widget', 'a checkbox with two widgets');
  // NoToggleToOff: exactly one on.
  const r = classifyOn(group(RADIO + (1 << 14), ['a', 'b']));
  assert.strictEqual(r.context.fields.get('11 0').group.exactlyOne, true);
  accepts(r.context, ['11 0', true], ['12 0', false]);
  assert.match(refuses(r.context, 'bad-value', ['11 0', false], ['12 0', false]), /must stay on/);
});

test('synthetic choice fields: options, editable combo, multi-select order, locks', () => {
  const ch = (extra) => formDoc({ 10: merged(`/FT /Ch ${extra}`) });
  const COMBO = 1 << 17, EDIT = 1 << 18, MULTI = 1 << 21;
  // /Opt with [export display] pairs and text strings (UTF-16BE).
  const r = classifyOn(ch(`/Ff ${COMBO} /Opt [[(nz) (New Zealand)] (de) <FEFF00E9>]`));
  assert.deepStrictEqual([r.forms.fields[0].type, r.forms.fields[0].options], ['combo', 3]);
  accepts(r.context, ['10 0', 'nz']);
  accepts(r.context, ['10 0', 'é']);
  refuses(r.context, 'bad-value', ['10 0', 'New Zealand']); // display value, not the export value
  // Editable combo: free text, one line.
  const e = classifyOn(ch(`/Ff ${COMBO + EDIT} /Opt [(a)]`));
  assert.strictEqual(e.forms.fields[0].editable, true);
  accepts(e.context, ['10 0', 'anything typed']);
  refuses(e.context, 'bad-value', ['10 0', 'two\nlines']);
  assert.strictEqual(verdict(ch(`/Ff ${COMBO + EDIT}`)), 'fillable', 'an editable combo needs no options');
  // Multi-select list.
  const m = classifyOn(ch(`/Ff ${MULTI} /Opt [(a) (b) (c)]`));
  assert.deepStrictEqual([m.forms.fields[0].type, m.forms.fields[0].multiSelect], ['list', true]);
  accepts(m.context, ['10 0', ['a', 'c']]);
  accepts(m.context, ['10 0', []]);
  accepts(m.context, ['10 0', ['a', 'b', 'c']]);
  assert.match(refuses(m.context, 'bad-value', ['10 0', ['c', 'a']]), /out of order/);
  refuses(m.context, 'bad-value', ['10 0', ['a', 'a']]);
  refuses(m.context, 'bad-value', ['10 0', ['a', 'x']]);
  refuses(m.context, 'bad-value', ['10 0', 'a']);
  // Locks.
  assert.strictEqual(verdict(ch('')), 'no-options');
  assert.strictEqual(verdict(ch('/Opt [(a) (a)]')), 'duplicate-options');
  assert.strictEqual(verdict(ch('/Opt [(a) [(a) (A)]]')), 'duplicate-options');
  // /I (PWP-28): fillable on a merged field/widget that carries it (pdf.js rewrites it, the verifier checks it);
  // locked on a separate field node, an ancestor or a widget, where pdf.js leaves it stale.
  assert.strictEqual(verdict(ch('/Opt [(a) (b)] /I [0]')), 'fillable');
  assert.strictEqual(verdict(formDoc({ 10: `<< /T (l) /FT /Ch /Opt [(a) (b)] /I [0] /Kids [11 0 R] >>`, 11: `<< ${W} /Parent 10 0 R >>` },
    { annots: '11 0 R' })), 'indices', 'separate field node');
  assert.strictEqual(verdict(formDoc({ 10: `<< /T (l) /FT /Ch /Opt [(a) (b)] /Kids [11 0 R] >>`, 11: `<< ${W} /Parent 10 0 R /I [0] >>` },
    { annots: '11 0 R' })), 'indices', 'on the widget');
  assert.strictEqual(verdict(formDoc({ 10: `<< /T (p) /I [0] /Kids [11 0 R] >>`, 11: `<< ${W} /T (c) /FT /Ch /Opt [(a) (b)] /Parent 10 0 R >>` },
    { annots: '11 0 R' })), 'indices', 'on an ancestor');
  assert.strictEqual(verdict(ch('/Opt [(a) /b]')), 'structure');
  assert.strictEqual(verdict(ch('/Opt [(a) [(b)]]')), 'structure');
  assert.strictEqual(verdict(ch('/Opt 5')), 'structure');
  assert.strictEqual(verdict(ch(`/Ff ${COMBO + MULTI} /Opt [(a)]`)), 'bad-flags');
  // Inherited /Opt and /Ff from a parent, as pdf.js reads them up /Parent.
  const inh = classifyOn(formDoc({ 10: `<< /T (p) /FT /Ch /Ff ${MULTI} /Opt [(x) (y)] /Kids [11 0 R] >>`, 11: `<< ${W} /T (c) /Parent 10 0 R >>` },
    { annots: '11 0 R' }));
  assert.deepStrictEqual([inh.forms.fields[0].fillable, inh.forms.fields[0].options, inh.forms.fields[0].multiSelect], [true, 2, true]);
  accepts(inh.context, ['11 0', ['y']]);
});

test('synthetic structure: widgets, placement, parents, multi-widget text, orphans', () => {
  const textWith = (widgets, objs, opts) => verdict(formDoc({ 10: `<< /T (t) /FT /Tx /Kids [${widgets}] >>`, ...objs }, opts));
  const w = (extra = '', parent = 10) => `<< ${W} /Parent ${parent} 0 R ${extra} >>`;
  assert.strictEqual(textWith('11 0 R', { 11: w() }, { annots: '11 0 R' }), 'fillable');
  assert.strictEqual(textWith('11 0 R 12 0 R', { 11: w(), 12: w() }, { annots: '11 0 R 12 0 R' }), 'multi-widget');
  assert.strictEqual(textWith('11 0 R', { 11: w() }, { annots: '' }), 'widget-placement', 'on no page');
  assert.strictEqual(textWith('11 0 R', { 11: w() }, { annots: '11 0 R 11 0 R' }), 'widget-placement', 'listed twice');
  assert.strictEqual(textWith('11 0 R', { 11: w() }, { annots: '11 0 R', page2: '11 0 R' }), 'widget-placement', 'on two pages');
  assert.strictEqual(textWith('11 0 R', { 11: w('', 9) }, { annots: '11 0 R' }), 'structure', 'widget /Parent elsewhere');
  assert.strictEqual(textWith('11 0 R', { 11: `<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Parent 10 0 R >>` }, { annots: '11 0 R' }), 'structure');
  assert.strictEqual(textWith('11 0 R', { 11: w('/Ff 1') }, { annots: '11 0 R' }), 'structure', 'a widget carrying its own /Ff');
  assert.strictEqual(textWith('11 0 R', { 11: w('/V (x)') }, { annots: '11 0 R' }), 'structure');
  assert.strictEqual(textWith('', {}, { annots: '' }), 'structure', 'no widget at all');
  assert.strictEqual(verdict(formDoc({ 10: '<< /T (t) /FT /Tx >>' }, { annots: '' })), 'structure', 'not a widget, no kids');
  // A child field whose /Parent disagrees with the Kids walk.
  assert.strictEqual(verdict(formDoc({ 10: '<< /T (p) /Kids [11 0 R] >>', 11: `<< ${W} /T (c) /FT /Tx /Parent 12 0 R >>`, 12: '<< /T (o) >>' },
    { annots: '11 0 R' })), 'structure');
  // A widget shared by two fields: neither is fillable.
  const shared = classifyOn(formDoc({ 10: '<< /T (a) /FT /Tx /Kids [12 0 R] >>', 11: '<< /T (b) /FT /Tx /Kids [12 0 R] >>', 12: w() },
    { fields: '10 0 R 11 0 R', annots: '12 0 R' }));
  // The first claims it (placement: claimed twice); the second is not its /Parent (structure).
  assert.deepStrictEqual(shared.forms.fields.map((f) => f.locked), ['widget-placement', 'structure']);
  // A widget on a page that no field claims: locked as not-a-field and listed for the UI.
  const orphan = classifyOn(formDoc({ 10: merged('/FT /Tx'), 11: `<< ${W} /T (o) /FT /Tx >>` }, { annots: '10 0 R 11 0 R' }));
  assert.deepStrictEqual(orphan.info.forms.lockedFields.map(S.refKey), ['11 0']);
  assert.strictEqual(orphan.context.locked.get('11 0'), 'not-a-field');
  assert.strictEqual(refuses(orphan.context, 'field-locked', ['11 0', 'x']), S.FIELD_LOCK_MESSAGES['not-a-field']);
});

test('facts carry refs, flags and counts only — no names, values or option texts', () => {
  const r = classifyOn(formDoc({ 10: `<< ${W} /T (SecretName) /FT /Ch /V (SecretValue) /Opt [(SecretOption)] >>` }));
  const text = JSON.stringify([r.forms, r.info]);
  assert.ok(!/Secret/.test(text), text);
  for (const m of Object.values(S.FIELD_LOCK_MESSAGES)) assert.ok(m.length > 10 && /\.$/.test(m));
});

test('fieldRule is pure: specs are copied and frozen', () => {
  const opts = ['a', 'b'];
  const rule = S.fieldRule({ kind: 'choice', options: opts, editable: false, multiSelect: false });
  opts.push('c');
  assert.strictEqual(rule.check('c'), 'The value is not one of the field\'s options.');
  assert.ok(Object.isFrozen(rule));
  const members = ['1 0', '2 0'];
  const radio = S.fieldRule({ kind: 'radio', group: '9 0', members, noToggleToOff: false });
  members.push('3 0');
  assert.deepStrictEqual([...radio.group.members], ['1 0', '2 0']);
  assert.ok(Object.isFrozen(radio.group.members));
  assert.strictEqual(S.fieldRule({ kind: 'text', maxLen: null, multiline: true, comb: false }).check('a\nb'), null);
});

// ------------------------------------------------------------------ through the real writer and verifier

test('forms.pdf: a value for every fillable widget saves through pdf.js and passes the verifier', { skip: skipWriter }, async () => {
  const base = fixture('forms.pdf');
  const { r, ctx, w, js } = await formsCtx();
  const s = S.emptyState();
  const e = env();
  const values = [[w.name[0], 'Filled name'], [w.notes[0], 'One\nTwo'], [w.code[0], 'XY9'], [w.comb[0], '00001111'],
    [w.agree[0], true], [w.colour[0], false], [w.colour[1], false], [w.colour[2], true], [w.country[0], 'Japan'],
    [w.fruit[0], 'Cherry'], [w['page2.text'][0], 'Page two']];
  assert.deepStrictEqual(values.map(([k]) => k).sort(), [...ctx.fields.keys()].sort(), 'every fillable widget is set');
  const p = S.applyEdit(s, setF(...values), ctx, e);
  assert.ok(p.ok, p.ok ? '' : p.error.message);
  const entries = SA.toStorageEntries(s, { deletable: ctx.deletable, pages: ctx.pages });
  const { task, doc } = await openPdfjs(base.slice());
  let out;
  try {
    for (const [k, v] of JSON.parse(JSON.stringify(entries))) doc.annotationStorage.setValue(k, v);
    out = new Uint8Array(await doc.saveDocument());
  } finally { await task.destroy(); }
  const after = await pdfjsWidgets(out);
  const observed = { pageCount: 2, annotsPerPage: r.pages.map((pg) => pg.annots.length), fields: [] };
  for (const [k, value] of values) {
    const a = after.widgets.get(SA.pdfjsId(ref(k)));
    const got = a.checkBox ? a.value === a.exportValue : a.radioButton ? a.value === a.buttonValue
      : a.fieldType === 'Ch' ? [].concat(a.value)[0] : a.value;
    assert.deepStrictEqual(got, value, `${a.name} reads back`);
    observed.fields.push({ ref: ref(k), value: got });
  }
  // Fields left out of the op (radio members already at their value) are not in the state, hence not observed.
  observed.fields = observed.fields.filter((f) => s.fields.has(S.refKey(f.ref)));
  const v = V.verifySaveSync({ base, out, classification: r, state: s, observed });
  assert.ok(v.ok, V.formatFindings(v));
  assert.ok(js.widgets.size > 0);
});
