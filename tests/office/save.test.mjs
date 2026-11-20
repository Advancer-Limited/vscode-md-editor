// WP-18: serialise + verify before writing (src/office/core/save.ts). Spec §6.5 steps 3–4, §13.2
// G0/G3/G5, §13.3 ("Both": overrides and relationship targets resolve, no orphaned parts).
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures, assertBytesEqual, writeOut } from './_helpers.mjs';
import { assertG3, prettyDocx } from './_roundtrip.mjs';

const { OfficePackage } = core.pkg;
const { EditBuilder, applyEdit, invertEdit } = core.edits;
const { serializeAndVerify, packageValidator, verifyBytes } = core.save;
const opc = core.opc;
const x = core.xml;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOC = 'word/document.xml';
const enc = new TextEncoder();
const NEGATIVE = new Set(['encrypted.docx', 'encrypted.xlsx', 'legacy-renamed.docx', 'truncated.docx', 'zip64.xlsx']);
const openable = () => allFixtures().filter((f) => !NEGATIVE.has(f));

function firstEl(root, ns, local) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type !== 'el') continue;
    if (n.ns === ns && n.local === local) return n;
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return undefined;
}

/** basic.docx with the first w:t replaced. */
function editedDocx() {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const b = new EditBuilder(pkg, 'Edit Paragraph');
  b.replaceNode(DOC, firstEl(pkg.xml(DOC).root, W, 't'), '<w:t>Saved text</w:t>');
  return { bytes, pkg, edit: b.finish() };
}

const messages = (r) => r.failures.map((f) => f.message).join('\n');

// ---------------------------------------------------------------------------------------------
// Acceptance tests (plan WP-18)

test('serializeAndVerify: clean package → original bytes (G0)', () => {
  for (const f of openable()) {
    const bytes = fixture(f);
    const pkg = OfficePackage.open(f, bytes);
    const r = serializeAndVerify(pkg, []);
    assert.ok(r.ok, `${f}: ${r.ok ? '' : messages(r)}`);
    assert.strictEqual(r.bytes, bytes, `${f}: the original bytes object itself`);
  }
});

test('one touched part → only that entry differs (G3)', () => {
  const { bytes, pkg } = editedDocx();
  const r = serializeAndVerify(pkg, []);
  assert.ok(r.ok, r.ok ? '' : messages(r));
  assertG3(bytes, r.bytes, [DOC]);
  writeOut('save', 'one-part.docx', r.bytes);
  // The written bytes re-open with the edit present.
  assert.match(OfficePackage.open('x.docx', r.bytes).text(DOC), /Saved text/);
});

test('edit → undo → serializeAndVerify writes the original bytes (G5 through save)', () => {
  const { bytes, pkg, edit } = editedDocx();
  applyEdit(pkg, invertEdit(edit));
  const r = serializeAndVerify(pkg, []);
  assert.ok(r.ok, r.ok ? '' : messages(r));
  assertBytesEqual(r.bytes, bytes);
});

test('corrupt hook → ok:false and no bytes returned', () => {
  const { pkg } = editedDocx();
  const good = serializeAndVerify(pkg, []);
  assert.ok(good.ok);
  const cases = {
    flipDataByte(b) {   // inside the first entry's compressed data: inflate or CRC fails
      const nameLen = b[26] | (b[27] << 8);
      const extraLen = b[28] | (b[29] << 8);
      b[30 + nameLen + extraLen + 2] ^= 0xff;
      return b;
    },
    truncate: (b) => b.subarray(0, b.length - 30),
    empty: () => new Uint8Array(0),
    otherPackage: () => fixture('basic.docx'),      // valid ZIP, but not this package's content
    otherKind: () => fixture('basic.xlsx'),
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const r = serializeAndVerify(pkg, [], { corrupt });
    assert.strictEqual(r.ok, false, `${name}: must fail`);
    assert.ok(!('bytes' in r), `${name}: no bytes`);
    assert.ok(r.failures.length > 0 && r.failures.every((f) => typeof f.message === 'string' && f.message.length > 0), name);
  }
  // The hook gets a copy: a clean package's original bytes are never mutated.
  const clean = OfficePackage.open('basic.docx', fixture('basic.docx'));
  const before = clean.originalBytes.slice();
  serializeAndVerify(clean, [], { corrupt: (b) => { b.fill(0); return b; } });
  assertBytesEqual(clean.originalBytes, before);
});

test('dangling Override / relationship target fails packageValidator', () => {
  const run = (mutate) => {
    const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
    const b = new EditBuilder(pkg, 'X');
    mutate(b, pkg);
    b.finish();
    return serializeAndVerify(pkg, []);
  };
  const dangOverride = run((b) => opc.addOverride(b, '/xl/nothere.xml', 'application/xml'));
  assert.strictEqual(dangOverride.ok, false);
  assert.match(messages(dangOverride), /Override for \/xl\/nothere\.xml names a part that does not exist/);
  assert.strictEqual(dangOverride.failures[0].part, '[Content_Types].xml');

  const dangRel = run((b) => opc.addRelationship(b, 'xl/workbook.xml', 'http://example.com/r', 'nothere.xml'));
  assert.strictEqual(dangRel.ok, false);
  assert.match(messages(dangRel), /targets xl\/nothere\.xml, which does not exist/);

  const deleted = run((b, pkg) => {
    const rel = opc.readRelationships(pkg, 'xl/workbook.xml').find((r) => /styles$/.test(r.type));
    b.setPart(opc.partNameFromTarget('xl/workbook.xml', rel.target), null);   // relationship and override left behind
  });
  assert.strictEqual(deleted.ok, false);
  assert.match(messages(deleted), /styles\.xml/);

  const orphan = run((b) => b.setPart('xl/orphan.xml', enc.encode('<orphan/>')));
  assert.strictEqual(orphan.ok, false);
  assert.match(messages(orphan), /created part is not the target of any relationship/);

  const orphanRels = run((b) => b.setPart('xl/_rels/ghost.xml.rels', enc.encode(`<Relationships xmlns="${opc.NS_RELATIONSHIPS}"/>`)));
  assert.strictEqual(orphanRels.ok, false);
  assert.match(messages(orphanRels), /relationships of a part that does not exist/);

  const noCt = run((b) => {
    b.setPart('xl/custom/thing.zzz', new Uint8Array([1]));
    opc.addRelationship(b, 'xl/workbook.xml', 'http://example.com/r', 'custom/thing.zzz');
  });
  assert.strictEqual(noCt.ok, false);
  assert.match(messages(noCt), /created part has no content type/);

  const proper = run((b) => {
    b.setPart('xl/custom/thing.xml', enc.encode('<thing/>'));
    opc.addOverride(b, 'xl/custom/thing.xml', 'application/vnd.test+xml');
    opc.addRelationship(b, 'xl/workbook.xml', 'http://example.com/r', 'custom/thing.xml');
  });
  assert.ok(proper.ok, proper.ok ? '' : messages(proper));
  writeOut('save', 'added-part.xlsx', proper.bytes);
});

test('packageValidator: problems the file already had are not reported with the original in context', async () => {
  // docx-min names styles.xml, header1.xml, webSettings.xml… that are not in the package.
  const bytes = await prettyDocx();
  const pkg = OfficePackage.open('pretty.docx', bytes);
  const strict = packageValidator(pkg, []);
  assert.ok(strict.some((m) => /webSettings\.xml/.test(m)), 'reported without context');
  const b = new EditBuilder(pkg, 'Edit');
  b.replaceNode(DOC, firstEl(pkg.xml(DOC).root, W, 't'), '<w:t>edited</w:t>');
  b.finish();
  const r = serializeAndVerify(pkg, []);
  assert.ok(r.ok, r.ok ? '' : messages(r));
  // …but a new dangling target still fails.
  const b2 = new EditBuilder(pkg, 'Bad');
  opc.addRelationship(b2, DOC, 'http://example.com/r', 'missing.xml');
  b2.finish();
  const r2 = serializeAndVerify(pkg, []);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.failures.length, 1, messages(r2));
  assert.match(messages(r2), /missing\.xml/);
});

test('every openable fixture passes packageValidator strictly (no original to excuse anything)', () => {
  for (const f of openable()) {
    const pkg = OfficePackage.open(f, fixture(f));
    assert.deepStrictEqual(packageValidator(pkg, []), [], f);
  }
});

test('format validators run on the re-opened output; a throwing or failing validator blocks the bytes', () => {
  const { pkg } = editedDocx();
  const seen = [];
  const spy = (p, touched, ctx) => {
    seen.push({ reopened: p !== pkg, touched, hasOriginal: !!ctx.original() });
    return [];
  };
  assert.ok(serializeAndVerify(pkg, [spy]).ok);
  assert.deepStrictEqual(seen, [{ reopened: true, touched: [DOC], hasOriginal: true }]);

  const failing = () => [`${DOC}: rows out of order`, 'workbook-level problem'];
  const r = serializeAndVerify(pkg, [failing]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.failures, [
    { part: DOC, message: `${DOC}: rows out of order` },
    { message: 'workbook-level problem' },
  ]);
  const throwing = () => { throw new Error('boom'); };
  const r2 = serializeAndVerify(pkg, [throwing]);
  assert.strictEqual(r2.ok, false);
  assert.match(messages(r2), /threw: boom/);
  // packageValidator passed explicitly runs once, not twice.
  const r3 = serializeAndVerify(pkg, [packageValidator]);
  assert.ok(r3.ok);
});

test('a malformed XML part is caught by the re-parse before any validator', () => {
  const pkg = OfficePackage.open('basic.docx', fixture('basic.docx'));
  const b = new EditBuilder(pkg, 'Break');
  b.setPart('docProps/app.xml', enc.encode('<Properties><unclosed></Properties>'));
  b.finish();
  let called = false;
  const r = serializeAndVerify(pkg, [() => { called = true; return []; }]);
  assert.strictEqual(r.ok, false);
  assert.match(messages(r), /docProps\/app\.xml: not well-formed XML/);
  assert.strictEqual(r.failures[0].part, 'docProps/app.xml');
  assert.strictEqual(called, false);
});

test('verifyBytes compares every entry with the package: content and entry set', () => {
  const { pkg } = editedDocx();
  const good = serializeAndVerify(pkg, []);
  // Bytes from a different edit of the same file: valid ZIP, wrong content for the touched part.
  const other = OfficePackage.open('basic.docx', fixture('basic.docx'));
  const b = new EditBuilder(other, 'Other');
  b.replaceNode(DOC, firstEl(other.xml(DOC).root, W, 't'), '<w:t>Different</w:t>');
  b.finish();
  const wrong = other.serialize();
  assert.match(verifyBytes(pkg, wrong, []).map((f) => f.message).join('\n'), /entry content differs from the edited part/);
  assert.deepStrictEqual(verifyBytes(pkg, good.bytes, []), []);
  // A package whose set of parts differs from the output.
  const extra = OfficePackage.open('basic.docx', fixture('basic.docx'));
  const b2 = new EditBuilder(extra, 'Extra');
  b2.setPart('custom/x.bin', new Uint8Array([1]));
  b2.finish();
  assert.match(verifyBytes(extra, good.bytes, []).map((f) => f.message).join('\n'), /custom\/x\.bin: part is missing from the output/);
  void x;
});
