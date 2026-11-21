// Hybrid-reference bases are editable (user decision 2026-11-21, spec §3.3, §16.2).
// Evidence that pdf.js 6.5.438 `saveDocument()` writes a valid incremental update on a hybrid base (a classic table
// whose trailer has /XRefStm): prefix identity, exactly one appended revision, a plain classic table (no /XRefStm)
// whose /Prev is the base's startxref, and pdf.js, PDFium and @cantoo/pdf-lib re-open the result with the
// annotation present (PG6). The strict reader opens the result and resolves every object.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { core, fixture } from './_helpers.mjs';
import { assertPg6 } from './_readers.mjs';
import { skipWriter, warnIfSkipped } from './_node.mjs';

const require = createRequire(import.meta.url);
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { openPdfSync } = core.reader;
// saveDocument() needs Node >= 22.13 (the former `Node 20+` gate let these run, and fail, on Node 20-22.12).
const skip = skipWriter;
warnIfSkipped('hybridWrite');

let lib;
async function save(base, entries) {
  lib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = lib.getDocument({
    data: base.slice(), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
  });
  const doc = await task.promise;
  try {
    for (const [k, v] of entries) doc.annotationStorage.setValue(k, v);
    return await doc.saveDocument();
  } finally { await task.destroy(); }
}

/** An Ink editor entry (the shape the storage adapter sends; spike S3), optionally with a comment (Popup). */
function ink(pageIndex, comment) {
  const pts = [80, 300, 110, 340, 140, 300];
  const line = []; for (let i = 0; i < pts.length; i += 2) line.push(NaN, NaN, NaN, NaN, pts[i], pts[i + 1]);
  const e = { annotationType: 15, pageIndex, rect: [77, 297, 143, 343], rotation: 0, color: [255, 0, 0], opacity: 1, thickness: 3, paths: { lines: [line], points: [pts] }, date: '2026-11-21T01:02:03Z', user: 'Test' };
  if (comment) e.popup = { contents: comment, rect: [150, 240, 330, 340] };
  return e;
}

const isPrefix = (out, base) => out.length > base.length && Buffer.from(out.subarray(0, base.length)).equals(Buffer.from(base));

/** The structural half of PV1/PV2 on a hybrid base, through the strict reader. */
function checkAppended(out, base) {
  assert.ok(isPrefix(out, base), 'prefix identity');
  const tail = Buffer.from(out.subarray(base.length)).toString('latin1');
  assert.strictEqual((tail.match(/%%EOF/g) ?? []).length, 1, 'one %%EOF appended');
  assert.strictEqual((tail.match(/startxref/g) ?? []).length, 1, 'one startxref appended');
  const b = openPdfSync(base); const o = openPdfSync(out);
  assert.strictEqual(o.revisions.length, b.revisions.length + 1, 'exactly one revision appended');
  const nw = o.revisions.at(-1);
  assert.strictEqual(nw.kind, 'table', 'pdf.js appends a classic table after a hybrid base');
  assert.ok(nw.startxref >= base.length);
  assert.strictEqual(nw.prev, b.startxref);
  assert.ok(!nw.trailer.entries.has('XRefStm'), 'no /XRefStm in the appended trailer');
  assert.deepStrictEqual([...nw.trailer.entries.keys()].filter((k) => !['Size', 'Root', 'Info', 'ID', 'Prev'].includes(k)), []);
  for (const e of nw.entries()) {
    assert.notStrictEqual(e.type, 'objstm');
    if (e.type === 'offset') assert.ok(e.offset >= base.length, `object ${e.num} points into the appended region`);
  }
  assert.ok(nw.size >= b.size);
  // every object of the result resolves (the base's object-stream objects still come from the hybrid section)
  for (const n of o.objectNumbers()) assert.ok(o.resolve(n), `object ${n} resolves`);
  return o;
}

for (const name of ['word.pdf', 'hybrid-xref.pdf']) {
  test(`${name}: pdf.js appends one classic-table revision; pdf.js, PDFium and pdf-lib read the annotation`, { skip }, async () => {
    const base = fixture(name);
    assert.strictEqual(openPdfSync(base).xrefKind, 'hybrid');
    const out = await save(base, [['pdfjs_internal_editor_0', ink(0, 'hybrid comment')]]);
    checkAppended(out, base);
    await assertPg6(out, base, { annots: [{ page: 1, subtype: 'Ink', contents: 'hybrid comment' }, { page: 1, subtype: 'Popup' }], touchedPages: [1] });
  });

  test(`${name}: a page that lives in an object stream is superseded by a plain object; a second session stacks cleanly`, { skip }, async () => {
    const base = fixture(name);
    const b = openPdfSync(base);
    const out = await save(base, [['pdfjs_internal_editor_0', ink(1)]]); // last page (page 2)
    const o = checkAppended(out, base);
    // hybrid-xref.pdf's page 2 is object 6, only in the /XRefStm stream; it is now a plain object in the update
    if (name === 'hybrid-xref.pdf') {
      assert.strictEqual(b.entry(6).type, 'objstm');
      assert.strictEqual(o.entry(6).type, 'offset');
      assert.ok(o.entry(6).offset >= base.length);
    }
    await assertPg6(out, base, { annots: [{ page: 2, subtype: 'Ink' }], touchedPages: [2] });
    const out2 = await save(out, [['pdfjs_internal_editor_1', ink(0, 'second session')]]);
    checkAppended(out2, out);
    assert.strictEqual(openPdfSync(out2).revisions.length, b.revisions.length + 2);
    await assertPg6(out2, out, { annots: [{ page: 1, subtype: 'Ink', contents: 'second session' }], touchedPages: [1] });
  });
}
