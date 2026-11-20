// WP-10: Word viewer notices (src/office/core/docx/notices.ts), spec §7.1 / §12.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { detectDocxNotices } = core.docx.notices;
const enc = new TextEncoder();

const codes = (pkg) => detectDocxNotices(pkg).map((n) => n.code);
const open = (name) => OfficePackage.open(name, fixture(name));

/** basic.docx with `edit(pkg)` applied, re-opened from its serialised bytes. */
function synthetic(edit) {
  const p = open('basic.docx');
  edit(p);
  return OfficePackage.open('synthetic.docx', p.serialize());
}
const addRel = (p, type, target, external = false) => {
  const part = 'word/_rels/document.xml.rels';
  const id = 'rIdTest' + Math.floor(Math.random() * 1e6);
  const rel = `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
  p.setPart(part, enc.encode(p.text(part).replace('</Relationships>', rel + '</Relationships>')));
};
const addToBody = (p, xml) => {
  const t = p.text('word/document.xml');
  const i = t.lastIndexOf('<w:sectPr');
  assert.ok(i > 0, 'basic.docx body ends with sectPr');
  p.setPart('word/document.xml', enc.encode(t.slice(0, i) + xml + t.slice(i)));
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

test('notices list tracked changes, comments (count), macros, altChunk, charts, equations for the matching fixtures', () => {
  // Real Word fixtures.
  assert.deepStrictEqual(codes(open('tracked.docx')), ['tracked-changes']);
  const comments = detectDocxNotices(open('anchors.docx')).find((n) => n.code === 'comments');
  assert.ok(comments, 'anchors.docx has comments');
  assert.match(comments.message, /\b\d+ comments?\b/);
  const real = open('anchors.docx');
  const n = (real.text('word/comments.xml').match(/<w:comment[\s>]/g) || []).length;
  assert.ok(comments.message.includes(`${n} comment`), `count ${n} appears in "${comments.message}"`);

  // Synthetic variants of basic.docx.
  const macros = synthetic((p) => { p.setPart('word/vbaProject.bin', new Uint8Array([1, 2, 3])); });
  assert.deepStrictEqual(codes(macros), ['macros']);

  const alt = synthetic((p) => addToBody(p, '<w:p><w:altChunk r:id="rIdAlt"/></w:p>'));
  assert.deepStrictEqual(codes(alt), ['altchunks']);

  const chart = synthetic((p) => { p.setPart('word/charts/chart1.xml', enc.encode('<c:chartSpace xmlns:c="x"/>')); addRel(p, REL + 'chart', 'charts/chart1.xml'); });
  assert.deepStrictEqual(codes(chart), ['charts']);

  const eq = synthetic((p) => addToBody(p, '<w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath></w:p>'));
  assert.deepStrictEqual(codes(eq), ['equations']);

  const ole = synthetic((p) => { p.setPart('word/embeddings/oleObject1.bin', new Uint8Array([1])); });
  assert.deepStrictEqual(codes(ole), ['embedded-objects']);
});

test('external pictures get a notice; plain documents get none', () => {
  assert.deepStrictEqual(codes(open('external-image.docx')), ['external-images']);
  for (const f of ['basic.docx', 'rich.docx', 'fields.docx', 'multi-run.docx']) {
    assert.deepStrictEqual(codes(open(f)), [], f);
  }
});

test('w:insideH, w:delText and similar names do not count as tracked changes', () => {
  const p = synthetic((q) => addToBody(q, '<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single"/></w:tblBorders></w:tblPr></w:tbl>'));
  assert.deepStrictEqual(codes(p), []);
});

test('every openable fixture scans without throwing and returns well-formed notices', () => {
  const skip = new Set(['encrypted.docx', 'legacy-renamed.docx', 'truncated.docx']);
  for (const f of allFixtures('docx')) {
    if (skip.has(f)) continue;
    for (const n of detectDocxNotices(open(f))) {
      assert.ok(n.code && n.message && (n.severity === 'info' || n.severity === 'warning'), f);
    }
  }
});
