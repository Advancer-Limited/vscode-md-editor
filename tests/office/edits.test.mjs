// WP-18: edits, undo/redo (src/office/core/edits.ts) and the OPC writers (opc.ts additions).
// Spec §6.3 (node paths counting every child node, no text-node merging, attr changes, generation
// guard, before-text check), §13.2 G4/G5.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, assertBytesEqual, writeOut, entryTable } from './_helpers.mjs';
import { assertG3, assertG4, assertG5, assertReopenSame, prettyDocx, rng, spanOf } from './_roundtrip.mjs';

const { OfficePackage } = core.pkg;
const { EditBuilder, applyEdit, invertEdit, StaleEditError, tryApplyEdit, undoRedoFor, packPart } = core.edits;
const x = core.xml;
const opc = core.opc;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DOC = 'word/document.xml';
const enc = new TextEncoder();

/** Elements of a tree in document order. */
function elements(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type !== 'el') continue;
    out.push(n);
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return out;
}
const firstEl = (root, ns, local) => elements(root).find((e) => e.ns === ns && e.local === local);

const pkg_text = (b) => b.pkg.text(DOC);

let PRETTY;
async function pretty() {
  PRETTY ??= await prettyDocx();
  return PRETTY;
}

/** The two layouts the acceptance test names: pretty-printed and single-line document.xml. */
async function layouts() {
  return [
    { name: 'pretty.docx', bytes: await pretty() },
    { name: 'basic.docx', bytes: fixture('basic.docx') },
  ];
}

// ---------------------------------------------------------------------------------------------
// Acceptance tests (plan WP-18)

test('node replace/insert/remove and attr changes apply and invert to byte-identical parts (G5)', async () => {
  for (const { name, bytes } of await layouts()) {
    const origText = OfficePackage.open(name, bytes).text(DOC);
    const cases = {
      replace(b, doc) {
        const t = firstEl(doc.root, W, 't');
        const before = x.serialize(t);
        b.replaceNode(DOC, t, `<w:t xml:space="preserve">Edited &amp; "replaced"</w:t>`);
        return spanOf(origText, before);
      },
      insert(b, doc) {
        const body = firstEl(doc.root, W, 'body');
        const p = firstEl(body, W, 'p');
        const i = body.children.indexOf(p);
        const span = spanOf(origText, x.serialize(p));
        b.insertAt(DOC, body, i, '<w:p><w:r><w:t>New</w:t></w:r></w:p>');
        // An insertion's minimal diff can slide over equal text on either side: confine it to the next paragraph.
        assert.strictEqual(pkg_text(b), origText.slice(0, span.start) + '<w:p><w:r><w:t>New</w:t></w:r></w:p>' + origText.slice(span.start));
        return span;
      },
      removeElement(b, doc) {
        const p = firstEl(firstEl(doc.root, W, 'body'), W, 'p');
        const span = spanOf(origText, x.serialize(p));
        b.removeNode(DOC, p);
        return span;
      },
      removeWhitespaceText(b, doc) {
        // Pretty layout: remove a whitespace text node between two elements (adjacent text must not merge).
        const body = firstEl(doc.root, W, 'body');
        const k = body.children.findIndex((n) => n.type === 'text');
        if (k < 0) { b.setAttr(DOC, body, '', 'vsmd', '1'); return { start: 0, end: origText.length }; }
        b.removeNode(DOC, body.children[k]);
        return { start: 0, end: origText.length };
      },
      attrChange(b, doc) {
        const el = elements(doc.root).find((e) => e.attrs.some((a) => a.ns === W && a.local === 'val'));
        const st = spanOf(origText, x.serialize(el));
        b.setAttr(DOC, el, W, 'val', 'Changed<&>"');
        return st;
      },
      attrAddRemove(b, doc) {
        const p = firstEl(doc.root, W, 'p');
        const st = spanOf(origText, x.serialize(p));
        b.setAttr(DOC, p, '', 'vsmdNew', 'x');
        const withAttrs = p.attrs.find((a) => a.rawName !== 'vsmdNew' && !a.rawName.startsWith('xmlns'));
        if (withAttrs) b.setAttr(DOC, p, withAttrs.ns, withAttrs.local, null);
        return st;
      },
    };
    for (const [caseName, run] of Object.entries(cases)) {
      const pkg = OfficePackage.open(name, bytes);
      const doc = pkg.xml(DOC);
      const b = new EditBuilder(pkg, 'Test');
      const span = run(b, doc);
      const edit = b.finish();
      assert.ok(edit, `${name}/${caseName}: an edit was recorded`);
      const editedText = pkg.text(DOC);
      assert.notStrictEqual(editedText, origText, `${name}/${caseName}: the part changed`);
      assertG4(origText, editedText, span, `${name}/${caseName}`);
      // Every change is applied and undone through applyEdit (not only by the builder).
      const out = assertG5(pkg, edit, bytes, `${name}/${caseName}`);
      assertG3(bytes, out, [DOC], `${name}/${caseName}`);
      assert.strictEqual(pkg.text(DOC), editedText);
      // Applying the inverse leaves the part text-identical to the original.
      applyEdit(pkg, invertEdit(edit));
      assert.strictEqual(pkg.text(DOC), origText, `${name}/${caseName}: undo restores the text`);
      applyEdit(pkg, edit);
      writeOut('edits', `${caseName}-${name}`, pkg.serialize());
    }
  }
});

test('node paths count every child node and multi-node inserts record one change per node', async () => {
  const bytes = await pretty();
  const pkg = OfficePackage.open('pretty.docx', bytes);
  const body = firstEl(pkg.xml(DOC).root, W, 'body');
  assert.ok(body.children.some((n) => n.type === 'text'), 'pretty layout has whitespace text nodes');
  const p = firstEl(body, W, 'p');
  const b = new EditBuilder(pkg, 'Insert');
  const at = body.children.indexOf(p) + 1;
  const nodes = b.insertAt(DOC, body, at, '\n    <w:p/><!--c-->');
  assert.strictEqual(nodes.length, 3);
  const edit = b.finish();
  assert.strictEqual(edit.changes.length, 3);
  const bodyPath = x.pathOf(body);
  edit.changes.forEach((c, k) => {
    assert.strictEqual(c.kind, 'node');
    assert.deepStrictEqual(c.path, [...bodyPath, at + k]);
    assert.strictEqual(c.before, '');
    assert.deepStrictEqual(x.nodeAt(pkg.xml(DOC), c.path), nodes[k]);
  });
  assertG5(pkg, edit, bytes);
  // A replace by several nodes = remove + inserts; still exact.
  const pkg2 = OfficePackage.open('pretty.docx', bytes);
  const t = firstEl(pkg2.xml(DOC).root, W, 't');
  const b2 = new EditBuilder(pkg2, 'Split');
  b2.replaceNode(DOC, t, '<w:t>a</w:t><w:tab/><w:t>b</w:t>');
  const e2 = b2.finish();
  assert.deepStrictEqual(e2.changes.map((c) => [c.before === '' ? 'ins' : c.after === '' ? 'rem' : 'rep']), [['rem'], ['ins'], ['ins'], ['ins']]);
  assertG5(pkg2, e2, bytes);
});

test('part create/delete inverts', () => {
  const bytes = fixture('basic.xlsx');
  const pkg = OfficePackage.open('basic.xlsx', bytes);
  const victim = pkg.partNames().find((n) => n.startsWith('docProps/'));
  const b = new EditBuilder(pkg, 'Parts');
  b.setPart('custom/new.bin', new Uint8Array([1, 2, 3, 0, 255]));
  b.setPart(victim, null);
  b.setPart('xl/workbook.xml', enc.encode(pkg.text('xl/workbook.xml').replace('<sheets>', '<sheets><!--x-->')));
  const edit = b.finish();
  assert.deepStrictEqual(edit.changes.map((c) => [c.kind, c.before === null, c.after === null]),
    [['part', true, false], ['part', false, true], ['part', false, false]]);
  // Stored raw-deflated: inflating gives back the data.
  assertBytesEqual(core.edits.unpackPart(edit.changes[0].after), new Uint8Array([1, 2, 3, 0, 255]));
  assert.ok(pkg.has('custom/new.bin') && !pkg.has(victim));
  const out = assertG5(pkg, edit, bytes);
  assertG3(bytes, out, ['custom/new.bin', victim, 'xl/workbook.xml']);
  applyEdit(pkg, invertEdit(edit));
  assert.ok(!pkg.has('custom/new.bin') && pkg.has(victim));
  assert.ok(!pkg.partNames().includes('custom/new.bin'));
});

test('applyEdit is atomic: a failing third change leaves the package byte-identical', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const origText = pkg.text(DOC);
  const doc = pkg.xml(DOC);
  const t = firstEl(doc.root, W, 't');
  const p = firstEl(doc.root, W, 'p');
  const tPath = x.pathOf(t);
  const pPath = x.pathOf(p);
  const good1 = { kind: 'node', part: DOC, path: tPath, before: x.serialize(t), after: '<w:t>one</w:t>' };
  const good2 = { kind: 'attr', part: DOC, path: pPath, ns: '', local: 'vsmd', before: null, after: '2' };
  const failures = [
    { kind: 'node', part: DOC, path: [...pPath, 9999], before: '<w:r/>', after: '' },                 // no such node
    { kind: 'node', part: DOC, path: tPath, before: '<w:t>wrong</w:t>', after: '<w:t>x</w:t>' },       // stale before
    { kind: 'attr', part: DOC, path: pPath, ns: '', local: 'vsmd', before: 'nope', after: null },      // stale attr
    { kind: 'node', part: DOC, path: [...pPath, 0], before: '', after: '<a/><b/>' },                   // not one node
    { kind: 'node', part: DOC, path: [...pPath, 0], before: '', after: '<unclosed>' },                 // malformed
    { kind: 'part', part: 'word/document.xml', before: null, after: packPart(new Uint8Array([1])) },    // exists
    { kind: 'part', part: 'nothere.xml', before: packPart(new Uint8Array([1])), after: null },          // missing
    { kind: 'node', part: 'nothere.xml', path: [0], before: '', after: '<a/>' },                      // missing part
    { kind: 'node', part: DOC, path: [], before: x.serialize(doc.root), after: '<w:document/>' },      // root
  ];
  for (const bad of failures) {
    assert.throws(() => applyEdit(pkg, { label: 'Bad', changes: [good1, good2, bad] }), (e) => e instanceof StaleEditError || e instanceof Error);
    assert.strictEqual(pkg.text(DOC), origText, `rolled back after ${JSON.stringify(bad).slice(0, 80)}`);
    assertBytesEqual(pkg.serialize(), bytes, 'byte-identical after rollback');
  }
  const r = tryApplyEdit(pkg, { label: 'Bad', changes: [good1, good2, failures[1]] });
  assert.deepStrictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assertBytesEqual(pkg.serialize(), bytes);
});

test('stale before-text is refused', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const doc = pkg.xml(DOC);
  const b1 = new EditBuilder(pkg, 'Edit Paragraph');
  b1.replaceNode(DOC, firstEl(doc.root, W, 't'), '<w:t>first</w:t>');
  b1.setAttr(DOC, firstEl(doc.root, W, 'p'), '', 'vsmd', 'a');
  const e1 = b1.finish();
  const b2 = new EditBuilder(pkg, 'Edit Paragraph');
  b2.replaceNode(DOC, firstEl(doc.root, W, 't'), '<w:t>second</w:t>');
  const e2 = b2.finish();
  const state = pkg.serialize();
  // Undoing e1 while e2 is still applied: the node no longer serialises to e1's `after`.
  assert.throws(() => applyEdit(pkg, invertEdit(e1)), StaleEditError);
  assertBytesEqual(pkg.serialize(), state, 'refused undo changes nothing');
  // Redo of an edit that is already applied is refused too.
  assert.throws(() => applyEdit(pkg, e2), StaleEditError);
  assertBytesEqual(pkg.serialize(), state);
  // The right order works and returns to the original.
  applyEdit(pkg, invertEdit(e2));
  applyEdit(pkg, invertEdit(e1));
  assertBytesEqual(pkg.serialize(), bytes);
  // A stale part change is refused.
  const b3 = new EditBuilder(pkg, 'P');
  b3.setPart('custom/a.bin', new Uint8Array([1]));
  const e3 = b3.finish();
  pkg.setPart('custom/a.bin', new Uint8Array([2]));   // changed underneath
  assert.throws(() => applyEdit(pkg, invertEdit(e3)), StaleEditError);
  assert.ok(pkg.has('custom/a.bin'));
});

test('generation guard: undo/redo after a reload change nothing and say why', () => {
  const bytes = fixture('basic.docx');
  const target = { pkg: OfficePackage.open('basic.docx', bytes), generation: 1 };
  const b = new EditBuilder(target.pkg, 'Edit Paragraph');
  b.replaceNode(DOC, firstEl(target.pkg.xml(DOC).root, W, 't'), '<w:t>x</w:t>');
  const edit = b.finish();
  const { undo, redo } = undoRedoFor(target, edit);
  assert.deepStrictEqual(undo(), { ok: true });
  assertBytesEqual(target.pkg.serialize(), bytes);
  assert.deepStrictEqual(redo(), { ok: true });
  const edited = target.pkg.serialize();
  // Undo twice: the second is refused by the before-text check.
  assert.deepStrictEqual(undo(), { ok: true });
  const r0 = undo();
  assert.strictEqual(r0.ok, false);
  assert.strictEqual(r0.error.code, 'stale');
  assert.match(r0.error.message, /no longer matches/);
  redo();
  // Reload: a new package, new generation. Closures from before refuse and touch nothing.
  const reloaded = OfficePackage.open('basic.docx', edited);
  target.pkg = reloaded;
  target.generation = 2;
  const r = undo();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'stale');
  assert.strictEqual(r.error.message, core.edits.UNDO_RELOADED_MESSAGE);
  assert.strictEqual(redo().error.message, core.edits.REDO_RELOADED_MESSAGE);
  assert.deepStrictEqual(reloaded.touchedParts(), []);
  assert.strictEqual(reloaded.serialize(), edited);
});

test('finish() returns null for a no-op', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const doc = pkg.xml(DOC);
  assert.strictEqual(new EditBuilder(pkg, 'Nothing').finish(), null);
  const b = new EditBuilder(pkg, 'Same');
  const t = firstEl(doc.root, W, 't');
  b.replaceNode(DOC, t, x.serialize(t));                                  // identical text
  const el = elements(doc.root).find((e) => e.attrs.some((a) => a.local === 'val'));
  const a = el.attrs.find((q) => q.local === 'val');
  b.setAttr(DOC, el, a.ns, a.local, a.value);                              // same value
  b.setAttr(DOC, el, '', 'absent', null);                                  // removing an absent attribute
  b.setPart('docProps/app.xml', pkg.bytes('docProps/app.xml'));            // same bytes
  b.setPart('nothere.bin', null);                                         // deleting a missing part
  assert.strictEqual(b.finish(), null);
  assertBytesEqual(pkg.serialize(), bytes);
  assert.throws(() => b.setPart('x.bin', null), /already finished/);
});

test('abort() rolls back everything recorded', async () => {
  const bytes = await pretty();
  const pkg = OfficePackage.open('pretty.docx', bytes);
  const doc = pkg.xml(DOC);
  const b = new EditBuilder(pkg, 'Aborted');
  const body = firstEl(doc.root, W, 'body');
  b.insertAt(DOC, body, 0, '<w:p/>');
  b.removeNode(DOC, firstEl(body, W, 'p'));
  b.setAttr(DOC, firstEl(body, W, 'p'), '', 'q', '1');
  b.setPart('custom/z.bin', new Uint8Array([7]));
  b.abort();
  assert.ok(!pkg.has('custom/z.bin'));
  assertBytesEqual(pkg.serialize(), bytes);
});

test('EditBuilder new content is rootScoped by default; replays parse in the site scope', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const part = 'custom/scoped.xml';
  pkg.setPart(part, enc.encode('<a xmlns:p="urn:one"><b xmlns:p="urn:two"><p:old/></b></a>'));
  const bEl = pkg.xml(part).root.children[0];
  const b = new EditBuilder(pkg, 'Scoped');
  assert.throws(() => b.insertAt(part, bEl, 0, '<p:x/>'), x.XmlScopeError);
  assert.strictEqual(pkg.text(part), '<a xmlns:p="urn:one"><b xmlns:p="urn:two"><p:old/></b></a>', 'refused insert changes nothing');
  // Text taken from that site (here: its own child) re-inserts fine, and undo/redo replays it.
  b.insertAt(part, bEl, 1, '<p:old/>', { rootScoped: false });
  const edit = b.finish();
  applyEdit(pkg, invertEdit(edit));
  assert.strictEqual(pkg.text(part), '<a xmlns:p="urn:one"><b xmlns:p="urn:two"><p:old/></b></a>');
  applyEdit(pkg, edit);
  assert.strictEqual(pkg.text(part), '<a xmlns:p="urn:one"><b xmlns:p="urn:two"><p:old/><p:old/></b></a>');
});

test('builder refuses nodes from another tree, the root, and UTF-16-unsafe misuse without changing anything', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const other = x.parseXml('<w:t xmlns:w="' + W + '"/>');
  const b = new EditBuilder(pkg, 'X');
  assert.throws(() => b.removeNode(DOC, other.root), /does not belong/);
  assert.throws(() => b.removeNode(DOC, pkg.xml(DOC).root), /root/);
  assert.throws(() => b.replaceNode(DOC, pkg.xml(DOC).root, '<w:document/>'), /root/);
  assert.throws(() => b.insertAt(DOC, firstEl(pkg.xml(DOC).root, W, 'body'), 0, '<w:p>'), x.XmlError);
  assert.strictEqual(b.finish(), null);
  assertBytesEqual(pkg.serialize(), bytes);
});

test('opc writers: overrides and relationships record undoable changes', () => {
  const bytes = fixture('basic.xlsx');
  const pkg = OfficePackage.open('basic.xlsx', bytes);
  const ct = '[Content_Types].xml';
  const ctText = pkg.text(ct);
  const b = new EditBuilder(pkg, 'Add Part');
  b.setPart('xl/custom/thing.xml', enc.encode('<?xml version="1.0"?><thing/>'));
  opc.addOverride(b, '/xl/custom/thing.xml', 'application/vnd.test+xml');
  const rId = opc.addRelationship(b, 'xl/workbook.xml', 'http://example.com/rel/thing', 'custom/thing.xml');
  // A source part without relationships gets a new rels part.
  const relsNew = opc.relsPartFor('xl/custom/thing.xml');
  assert.ok(!pkg.has(relsNew));
  const rId2 = opc.addRelationship(b, 'xl/custom/thing.xml', 'http://example.com/rel/ext', 'https://example.com/', { external: true });
  const edit = b.finish();
  assert.match(rId, /^rId\d+$/);
  assert.strictEqual(rId2, 'rId1');
  const existing = opc.readRelationships(pkg, 'xl/workbook.xml').map((r) => r.id);
  assert.strictEqual(new Set(existing).size, existing.length, 'ids unique');
  assert.strictEqual(opc.contentTypeOf(pkg, 'xl/custom/thing.xml'), 'application/vnd.test+xml');
  assert.ok(opc.readRelationships(pkg, 'xl/workbook.xml').some((r) => r.id === rId && r.target === 'custom/thing.xml'));
  assert.deepStrictEqual(opc.readRelationships(pkg, 'xl/custom/thing.xml'), [{ id: 'rId1', type: 'http://example.com/rel/ext', target: 'https://example.com/', external: true }]);
  // G4 on [Content_Types].xml: only an insertion.
  const newCt = pkg.text(ct);
  assert.ok(newCt.length > ctText.length);
  const v = core.save.serializeAndVerify(pkg, []);
  assert.ok(v.ok, JSON.stringify(v.failures));
  const out = assertG5(pkg, edit, bytes);
  assertG3(bytes, out, [ct, 'xl/_rels/workbook.xml.rels', 'xl/custom/thing.xml', relsNew]);
  writeOut('edits', 'opc-writers.xlsx', out);
  // Remove them again in a second edit; undo of that restores them.
  const b2 = new EditBuilder(pkg, 'Remove Part');
  opc.removeRelationship(b2, 'xl/workbook.xml', rId);
  opc.removeOverride(b2, 'xl/custom/thing.xml');
  b2.setPart(relsNew, null);
  b2.setPart('xl/custom/thing.xml', null);
  const e2 = b2.finish();
  assert.throws(() => opc.removeRelationship(new EditBuilder(pkg, 'x'), 'xl/workbook.xml', rId), /no relationship/);
  assertBytesEqual(pkg.serialize(), bytes, 'removing what was added returns to the original bytes');
  applyEdit(pkg, invertEdit(e2));
  assertBytesEqual(pkg.serialize(), out);
  // addOverride on an existing part changes only its ContentType attribute; same type is a no-op.
  const b3 = new EditBuilder(pkg, 'CT');
  opc.addOverride(b3, 'xl/workbook.xml', opc.contentTypeOf(pkg, 'xl/workbook.xml'));
  assert.strictEqual(b3.finish(), null);
  assert.strictEqual(opc.sourcePartOfRels('_rels/.rels'), '');
  assert.strictEqual(opc.sourcePartOfRels('xl/worksheets/_rels/sheet1.xml.rels'), 'xl/worksheets/sheet1.xml');
  assert.strictEqual(opc.sourcePartOfRels('xl/workbook.xml'), undefined);
});

// ---------------------------------------------------------------------------------------------
// Exactness when undo re-creates elements from text (a whole-part change re-parses the part)

/** Replace `part` with slightly different bytes (one edit), then undo it: the tree is re-parsed from text. */
function reparseViaPartChange(pkg, part) {
  const b = new EditBuilder(pkg, 'Replace Part');
  b.setPart(part, enc.encode(pkg.text(part) + '\n'));
  const e = b.finish();
  applyEdit(pkg, invertEdit(e));
  return e;
}

test('attr undo on a re-created element is exact (start-tag fallback), root element included', async () => {
  const bytes = await pretty();
  const pkg = OfficePackage.open('pretty.docx', bytes);
  const doc = pkg.xml(DOC);
  const b = new EditBuilder(pkg, 'Attrs');
  // Multi-line root attributes: re-adding mc:Ignorable to a re-parsed root would otherwise append it
  // with a single space instead of its newline + indentation.
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  b.setAttr(DOC, doc.root, MC, 'Ignorable', null);
  const p = firstEl(doc.root, W, 'p');
  const first = p.attrs.find((a) => !a.rawName.startsWith('xmlns'));
  b.setAttr(DOC, p, first.ns, first.local, null);
  const edit = b.finish();
  const edited = pkg.serialize();
  reparseViaPartChange(pkg, DOC);
  assertBytesEqual(pkg.serialize(), edited);
  applyEdit(pkg, invertEdit(edit));
  assertBytesEqual(pkg.serialize(), bytes, 'undo after a re-parse is byte-identical');
  reparseViaPartChange(pkg, DOC);
  applyEdit(pkg, edit);
  assertBytesEqual(pkg.serialize(), edited, 'redo after a re-parse equals the edit');
});

test('removing the last child of a re-created element restores its original empty form', () => {
  const bytes = fixture('basic.docx');
  const pkg = OfficePackage.open('basic.docx', bytes);
  const doc = pkg.xml(DOC);
  const empty = elements(doc.root).find((e) => e.children.length === 0 && x.serialize(e).endsWith('/>') && e.parent);
  const b = new EditBuilder(pkg, 'Fill');
  b.insertAt(DOC, empty, 0, '<vsmd/>');
  const edit = b.finish();
  assert.ok(edit.changes[0].emptyParent.endsWith('/>'));
  const edited = pkg.serialize();
  reparseViaPartChange(pkg, DOC);   // the element now comes from `<x ...><vsmd/></x>` text
  applyEdit(pkg, invertEdit(edit));
  assertBytesEqual(pkg.serialize(), bytes, 'reads <x .../> again, not <x ...></x>');
  applyEdit(pkg, edit);
  assertBytesEqual(pkg.serialize(), edited);
});

test('after a re-parse merges adjacent text nodes, an older node undo is refused and changes nothing', async () => {
  const bytes = await pretty();
  const pkg = OfficePackage.open('pretty.docx', bytes);
  const body = firstEl(pkg.xml(DOC).root, W, 'body');
  const p = firstEl(body, W, 'p');
  const at = body.children.indexOf(p);
  assert.ok(body.children[at - 1].type === 'text' && body.children[at + 1].type === 'text');
  const b = new EditBuilder(pkg, 'Remove Paragraph');
  b.removeNode(DOC, p);                 // leaves two adjacent whitespace text nodes
  const edit = b.finish();
  // Without a re-parse the undo is exact (the removed object is re-inserted).
  assertG5(pkg, edit, bytes);
  reparseViaPartChange(pkg, DOC);       // the two whitespace nodes come back as one
  const state = pkg.serialize();
  assert.throws(() => applyEdit(pkg, invertEdit(edit)), (e) => e instanceof StaleEditError && /structure/.test(e.message));
  assertBytesEqual(pkg.serialize(), state, 'refused undo changed nothing (it would have re-inserted at a shifted index)');
  const r = undoRedoFor({ pkg, generation: 0 }, edit).undo();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.message, core.edits.UNDO_STALE_MESSAGE);
});

// ---------------------------------------------------------------------------------------------
// Property test: random edit / undo / redo sequences

const FRAGMENTS = [
  '<vsmd/>', '<vsmd a="1" b=\'2\'>t&amp;x</vsmd>', 'plain text', ' ', '\n  ', 'a &lt; b &amp; c',
  '<!--comment-->', '<![CDATA[<raw> & ]]>', '<?vsmd pi?>', '<vsmd><inner/>tail</vsmd>',
];
const MULTI = ['<vsmd/>\n  ', 'x<vsmd/>y', '<a/><b/><!--c-->'];
const VALUES = ['1', '', 'x"y', "a'b", '<&>', 'tab\tnl\n', 'üñí'];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

function nodesOf(root, limit = 4000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const n = stack.pop();
    out.push(n);
    if (n.type === 'el') for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  return out;
}

/** Parts random edits never change: open() needs them intact to re-open the package. */
function protectedParts(pkg) {
  return new Set(['[content_types].xml', '_rels/.rels', opc.mainPart(pkg).name.toLowerCase()]);
}

/**
 * Random node/attr changes go to "node parts", random whole-part changes to the others (binary parts,
 * the other XML parts, created parts). A whole-part change re-parses the part on undo, which merges
 * adjacent text nodes; node changes made before it on the same part may then be refused (see the
 * dedicated test below), which would break this test's undo-stack model.
 */
function isNodePart(name) {
  if (!/\.(xml|rels)$/i.test(name)) return false;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3 !== 0;
}

/** One random primitive on `b`. Returns false if it chose to do nothing. */
function randomStep(r, pkg, b, counter, keep) {
  const roll = r();
  if (roll < 0.08) {
    // Whole-part changes (never on the parts open() needs).
    const k = r();
    if (k < 0.4) { b.setPart(`custom/rnd${counter.n++}.bin`, new Uint8Array(Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 256)))); return true; }
    const free = pkg.partNames().filter((n) => !keep.has(n.toLowerCase()) && !isNodePart(n));
    if (free.length === 0) return false;
    const victim = pick(r, free);
    if (k < 0.7) { b.setPart(victim, null); return true; }
    const data = pkg.bytes(victim);
    b.setPart(victim, data.length > 0 && r() < 0.5 ? data.subarray(0, data.length - 1) : new Uint8Array([...data, 32]));
    return true;
  }
  // Node and attribute changes on any XML part except content types and the root rels.
  const xmlParts = pkg.partNames().filter((n) => isNodePart(n) && n.toLowerCase() !== '[content_types].xml' && n.toLowerCase() !== '_rels/.rels');
  if (xmlParts.length === 0) return false;
  const part = pick(r, xmlParts);
  let doc;
  try { doc = pkg.xml(part); } catch { return false; }   // a part a random setPart made malformed
  const nodes = nodesOf(doc.root);
  const node = pick(r, nodes);
  const els = nodes.filter((n) => n.type === 'el');
  try {
    if (roll < 0.3) {
      if (!node.parent) return false;
      b.replaceNode(part, node, r() < 0.8 ? pick(r, FRAGMENTS) : pick(r, MULTI));
    } else if (roll < 0.55) {
      const parent = pick(r, els);
      b.insertAt(part, parent, Math.floor(r() * (parent.children.length + 1)), r() < 0.8 ? pick(r, FRAGMENTS) : pick(r, MULTI));
    } else if (roll < 0.72) {
      if (!node.parent) return false;
      b.removeNode(part, node);
    } else {
      const el = pick(r, els);
      const editable = el.attrs.filter((a) => a.rawName !== 'xmlns' && !a.rawName.startsWith('xmlns:'));
      const q = r();
      if (q < 0.35 && editable.length) { const a = pick(r, editable); b.setAttr(part, el, a.ns, a.local, null); }
      else if (q < 0.7 && editable.length) { const a = pick(r, editable); b.setAttr(part, el, a.ns, a.local, pick(r, VALUES)); }
      else b.setAttr(part, el, '', `vsmd${Math.floor(r() * 3)}`, pick(r, VALUES));
    }
  } catch (e) {
    // Unprefixed names under a redeclared default namespace: refused, and nothing changed.
    if (e instanceof x.XmlScopeError) return false;
    throw e;
  }
  return true;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: got ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))}\n want ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
}
function summary(c) {
  return c.kind === 'part' ? `part ${c.part} ${c.before ? 'B' : '-'}${c.after ? 'A' : '-'}` : c.kind === 'attr' ? `attr ${c.part} [${c.path}] ${c.local} ${JSON.stringify(c.before)}->${JSON.stringify(c.after)}` : `node ${c.part} [${c.path}] ${JSON.stringify(c.before.slice(0, 40))}->${JSON.stringify(c.after.slice(0, 40))}`;
}

/**
 * Same entries byte for byte (compressed data, CRC, central record), original entries in the same
 * order, and only the order of parts created in this session differs. OfficePackage appends a
 * created part that is deleted and re-created (undo of its deletion) after the other created parts;
 * that is the one known intermediate-state difference (full undo is still byte-identical).
 */
function sameUpToCreatedOrder(a, b, original) {
  const ta = entryTable(a);
  const tb = entryTable(b);
  const orig = new Set(entryTable(original).keys());
  if (ta.size !== tb.size) return false;
  for (const [n, ea] of ta) {
    const eb = tb.get(n);
    if (!eb || ea.crc !== eb.crc || !sameBytes(ea.compressedBytes, eb.compressedBytes)) return false;
    if (orig.has(n) && !sameBytes(ea.cdRecordBytes, eb.cdRecordBytes)) return false;
  }
  const oa = [...ta.keys()].filter((n) => orig.has(n));
  const ob = [...tb.keys()].filter((n) => orig.has(n));
  return oa.join('\u0000') === ob.join('\u0000');
}

/** Every part's current bytes. */
function snapshot(pkg) {
  return new Map(pkg.partNames().map((n) => [n, pkg.bytes(n)]));
}
function assertModel(pkg, want, msg) {
  assert.deepStrictEqual(pkg.partNames().slice().sort(), [...want.keys()].sort(), `${msg}: part names`);
  const dec = new TextDecoder();
  for (const [n, b] of want) {
    if (!sameBytes(pkg.bytes(n), b)) assert.fail(`${msg}: ${n} differs ${firstDiff(dec.decode(pkg.bytes(n)), dec.decode(b))}`);
  }
}

/** applyEdit with the edit and its neighbours in the failure message. */
function applyTraced(pkg, e, label, done) {
  try {
    applyEdit(pkg, e);
  } catch (err) {
    assert.fail(`${label}: ${err.message}; edit ${JSON.stringify(e.changes.map(summary))}; below: ${JSON.stringify(done.slice(-2).map((d) => d.changes.map(summary)))}`);
  }
}

const PROPERTY_FIXTURES = ['basic.docx', 'basic.xlsx', 'formulas.xlsx', 'rich.docx', 'prefixed-namespaces.xlsx', 'pretty.docx'];

test('seeded random sequence of 200 synthetic edits with undo/redo interleaved ends byte-identical after full undo', async () => {
  for (const [fi, name] of PROPERTY_FIXTURES.entries()) {
    const bytes = name === 'pretty.docx' ? await pretty() : fixture(name);
    const pkg = OfficePackage.open(name, bytes);
    const r = rng(0x5eed + fi * 7919);
    const counter = { n: 0 };
    const keep = protectedParts(pkg);
    const done = [];        // applied edits (undo stack)
    const undone = [];      // redo stack
    const states = [bytes]; // states[k] = serialisation with done.length === k
    const models = [snapshot(pkg)]; // models[k] = every part's current bytes at depth k
    let edits = 0;
    let undos = 0;
    let redos = 0;
    let refusals = 0;
    for (let step = 0; step < 200; step++) {
      const roll = r();
      const label = `${name} step ${step}`;
      if (roll < 0.25 && done.length) {
        const e = done.pop();
        applyTraced(pkg, invertEdit(e), `${label} undo`, done);
        undone.push(e);
        undos++;
      } else if (roll < 0.4 && undone.length) {
        const e = undone.pop();
        applyTraced(pkg, e, `${label} redo`, done);
        done.push(e);
        redos++;
      } else if (roll < 0.45 && done.length) {
        // A corrupted edit (valid prefix + stale tail) must be refused atomically.
        const top = done[done.length - 1];
        const before = pkg.serialize();
        const stale = { kind: 'attr', part: opc.mainPart(pkg).name, path: [], ns: '', local: 'vsmdNever', before: 'impossible', after: null };
        const bad = { label: 'Bad', changes: [...invertEdit(top).changes, stale] };
        assert.throws(() => applyEdit(pkg, bad), StaleEditError, `${label}: a stale tail must be refused`);
        assertBytesEqual(pkg.serialize(), before, `${label}: refused edit changed nothing`);
        refusals++;
        continue;
      } else {
        const b = new EditBuilder(pkg, 'Random');
        const n = 1 + Math.floor(r() * 3);
        for (let k = 0; k < n; k++) randomStep(r, pkg, b, counter, keep);
        const e = b.finish();
        if (!e) continue;
        done.push(e);
        undone.length = 0;
        states.length = done.length;
        states.push(pkg.serialize());
        models.length = done.length;
        models.push(snapshot(pkg));
        edits++;
      }
      // G5 / redo identity at every step: the state is exactly the one recorded for this depth.
      const now = pkg.serialize();
      if (!sameBytes(now, states[done.length]) && !sameUpToCreatedOrder(now, states[done.length], bytes)) {
        const want = OfficePackage.open(name, states[done.length]);
        const diff = pkg.partNames().filter((n) => !want.has(n) || !sameBytes(want.bytes(n), pkg.bytes(n)));
        const detail = diff.map((n) => (want.has(n) ? `${n}: ${firstDiff(pkg.text(n), want.text(n))}` : `${n}: unexpected`)).join('\n');
        assert.fail(`${label}: state at depth ${done.length} differs in ${diff.join(', ')}\n${detail}\n`
          + `last edits: ${JSON.stringify(done.slice(-2).map((e) => e.changes.map(summary)))}`);
      }
      assertModel(pkg, models[done.length], `${label}: model at depth ${done.length}`);
      if (step % 25 === 0) assertReopenSame(pkg, name, `${label}`);
    }
    assertReopenSame(pkg, name, `${name} end`);
    while (done.length) {
      const top = done.pop();
      applyTraced(pkg, invertEdit(top), `${name} full undo at depth ${done.length + 1} ${JSON.stringify(top.changes.map(summary))}`, done);
      assertModel(pkg, models[done.length], `${name} full undo: model at depth ${done.length} after undoing ${JSON.stringify(top.changes.map(summary))}`);
    }
    assertBytesEqual(pkg.serialize(), bytes, `${name}: full undo is byte-identical to the original`);
    assert.ok(edits >= 40 && undos >= 15 && redos >= 5 && refusals >= 3, `${name}: exercised edits=${edits} undos=${undos} redos=${redos} refusals=${refusals}`);
  }
});
