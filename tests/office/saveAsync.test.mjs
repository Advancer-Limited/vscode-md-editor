// Gate R2 F5: the async save path gives the same results as the synchronous one.
//   - zip.rawDeflateAsync (a resumable copy of fflate's compressor, core/deflate.ts) is byte-identical
//     to rawDeflate (fflate deflateSync) on every fixture part, random data and tiny inputs;
//   - OfficePackage.serializeAsync is byte-identical to serialize() on every fixture after random
//     edits (attribute edits, undo back to the original, part replace / create / delete, force), and
//     captures the state synchronously;
//   - save.verifyBytesAsync / serializeAndVerifyAsync return exactly the failures of verifyBytes /
//     serializeAndVerify (corrupt hook, truncation, failing, throwing and non-list validators, the
//     xlsx validator with its async variant);
//   - xlsxValidator.async returns the messages of xlsxValidator on every xlsx fixture;
//   - the async functions yield to the event loop on large.xlsx.
import { test } from 'node:test';
import assert from 'node:assert';
import { deflateSync } from 'fflate';
import { core, fixture, allFixtures } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function openAll() {
  const out = [];
  for (const name of allFixtures()) {
    try { out.push({ name, pkg: OfficePackage.open(name, fixture(name)) }); } catch { /* fixtures that refuse to open */ }
  }
  return out;
}

function xmlParts(pkg) {
  return pkg.partNames().filter((p) => /\.(xml|rels)$/i.test(p) && pkg.partSize(p) && pkg.partSize(p).uncompressed < 3_000_000);
}

/** Elements of a tree, depth-first, at most `max`. */
function elements(root, max = 200) {
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < max) {
    const el = stack.pop();
    out.push(el);
    for (const c of el.children) if (c.type === 'el') stack.push(c);
  }
  return out;
}

/** Counts the event-loop turns taken while `fn` runs (setImmediate ticks). */
async function turnsDuring(fn) {
  let turns = 0;
  let running = true;
  const loop = () => { if (!running) return; turns++; setImmediate(loop); };
  setImmediate(loop);
  const r = await fn();
  running = false;
  return { r, turns };
}

test('rawDeflateAsync is byte-identical to rawDeflate (fflate deflateSync)', async () => {
  let n = 0;
  for (const { name, pkg } of openAll()) {
    for (const part of pkg.partNames()) {
      let bytes;
      try { bytes = pkg.bytes(part); } catch { continue; }
      for (const level of bytes.length > 1_000_000 ? [6] : [1, 6]) {
        const want = core.zip.rawDeflate(bytes, level);
        assert.ok(same(want, deflateSync(bytes, { level })));
        const got = await core.zip.rawDeflateAsync(bytes, level, 30);
        assert.ok(same(got, want), `${name} ${part} level ${level}`);
        n++;
      }
    }
  }
  assert.ok(n > 100, `${n} parts compared`);
  const r = rng(7);
  for (let k = 0; k < 40; k++) {
    const len = Math.floor(r() * 200_000);
    const b = new Uint8Array(len);
    const alphabet = 1 + Math.floor(r() * 255);
    for (let i = 0; i < len; i++) b[i] = r() < 0.4 && i > 0 ? b[Math.max(0, i - 1 - Math.floor(r() * 4000))] : Math.floor(r() * alphabet);
    assert.ok(same(await core.zip.rawDeflateAsync(b, 6, 1), deflateSync(b, { level: 6 })), `random ${k} (${len} bytes)`);
  }
  for (const len of [0, 1, 2, 3, 4, 258, 259, 32768, 32769, 70000]) {
    const b = new Uint8Array(len).fill(65);
    assert.ok(same(await core.zip.rawDeflateAsync(b, 6, 30), deflateSync(b, { level: 6 })), `run of ${len}`);
  }
  // Data from rawDeflateAsync inflates back.
  const big = fixture('large.xlsx');
  assert.ok(same(core.zip.rawInflate(await core.zip.rawDeflateAsync(big, 6, 30), big.length), big));
});

test('serializeAsync equals serialize() on every fixture after random edits', async () => {
  const r = rng(42);
  let cases = 0;
  for (const { name } of openAll()) {
    for (let round = 0; round < 3; round++) {
      const pkg = OfficePackage.open(name, fixture(name));
      // Nothing touched: the original bytes themselves, both ways.
      if (round === 0) {
        assert.strictEqual(await pkg.serializeAsync(), pkg.originalBytes, name);
        assert.ok(same(await pkg.serializeAsync({ force: true }), pkg.serialize({ force: true })), `${name} force`);
        assert.strictEqual(pkg.serializesToOriginal(), true);
      }
      const parts = xmlParts(pkg);
      const edits = [];
      for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
        const part = parts[Math.floor(r() * parts.length)];
        let doc;
        try { doc = pkg.xml(part); } catch { continue; }
        const els = elements(doc.root);
        const el = els[Math.floor(r() * els.length)];
        const b = new core.edits.EditBuilder(pkg, 'x');
        b.setAttr(part, el, '', 'vsmdAsync', String(k));
        const e = b.finish();
        if (e) edits.push(e);
      }
      const what = r();
      if (what < 0.25) {
        // Undo everything: back to the original bytes (G5).
        for (const e of edits.reverse()) core.edits.tryApplyEdit(pkg, core.edits.invertEdit(e));
        assert.strictEqual(pkg.serializesToOriginal(), true, `${name} undone`);
      } else if (what < 0.5) {
        // Replace a part with its own bytes (kept raw after a byte comparison), and another with new ones.
        const p1 = parts[Math.floor(r() * parts.length)];
        pkg.setPart(p1, pkg.bytes(p1));
        pkg.setPart('customXml/vsmdAsync.xml', new TextEncoder().encode('<a/>'));
      } else if (what < 0.75) {
        const victim = pkg.partNames().find((p) => /docProps\/app\.xml$/i.test(p));
        if (victim) pkg.setPart(victim, null);
      }
      const sync = pkg.serialize();
      const asyncBytes = await pkg.serializeAsync();
      if (sync === pkg.originalBytes) assert.strictEqual(asyncBytes, pkg.originalBytes, `${name} round ${round}`);
      else assert.ok(same(asyncBytes, sync), `${name} round ${round}`);
      assert.strictEqual(pkg.serializesToOriginal(), sync === pkg.originalBytes, `${name} round ${round} serializesToOriginal`);
      assert.ok(same(await pkg.serializeAsync({ force: true }), pkg.serialize({ force: true })), `${name} round ${round} force`);
      cases++;
    }
  }
  assert.ok(cases > 20);
});

test('serializeAsync captures the state when called: later changes do not leak in', async () => {
  const pkg = OfficePackage.open('basic.xlsx', fixture('basic.xlsx'));
  const part = 'xl/workbook.xml';
  const b = new core.edits.EditBuilder(pkg, 'x');
  b.setAttr(part, pkg.xml(part).root, '', 'vsmdA', '1');
  b.finish();
  const want = pkg.serialize();
  const pending = pkg.serializeAsync();
  const b2 = new core.edits.EditBuilder(pkg, 'y');
  b2.setAttr(part, pkg.xml(part).root, '', 'vsmdA', '2');
  b2.finish();
  pkg.setPart('docProps/app.xml', null);
  assert.ok(same(await pending, want));
  // A temporary builder rolled back right after the call (the host's save-time preparation) is in the output.
  const b3 = new core.edits.EditBuilder(pkg, 'prep');
  b3.setAttr(part, pkg.xml(part).root, '', 'vsmdPrep', '1');
  const withPrep = pkg.serialize();
  const p2 = pkg.serializeAsync();
  b3.abort();
  assert.ok(same(await p2, withPrep));
  assert.ok(!same(pkg.serialize(), withPrep));
});

function corruptMiddle(b) { b[Math.floor(b.length / 2)] ^= 0xff; return b; }

test('verifyBytesAsync and serializeAndVerifyAsync give exactly the sync failures', async () => {
  const strict = (pkg, touched) => touched.map((t) => `${t}: rejected by test validator`);
  const throws = () => { throw new Error('boom'); };
  const notList = () => 'nope';
  const withAsync = Object.assign((pkg, touched) => touched.map((t) => `${t}: sync says no`), {
    async: async (pkg, touched) => touched.map((t) => `${t}: sync says no`),
  });
  const xv = core.xlsx.validate.xlsxValidator;
  const cases = [
    ['basic.docx', [], undefined],
    ['basic.xlsx', [core.save.packageValidator], undefined],
    ['basic.xlsx', [xv], undefined],
    ['large.xlsx', [xv], undefined],
    ['large.xlsx', [xv], { corrupt: corruptMiddle }],
    ['basic.docx', [strict], undefined],
    ['basic.docx', [throws, strict], undefined],
    ['basic.docx', [notList], undefined],
    ['basic.xlsx', [withAsync, xv], undefined],
    ['basic.docx', [], { corrupt: corruptMiddle }],
    ['basic.docx', [], { corrupt: (b) => b.subarray(0, b.length - 10) }],
    ['basic.xlsx', [xv], { corrupt: (b) => { b[0] = 0; return b; } }],
  ];
  for (const [name, validators, hooks] of cases) {
    const p = OfficePackage.open(name, fixture(name));
    const part = name.endsWith('.xlsx') ? 'xl/worksheets/sheet1.xml' : core.opc.mainPart(p).name;
    const b = new core.edits.EditBuilder(p, 'x');
    b.setAttr(part, p.xml(part).root, '', 'vsmdTest', '1');
    b.finish();
    const label = `${name} ${validators.map((v) => v.name || 'anon').join(',')} ${hooks ? 'corrupt' : ''}`;
    const sync = core.save.serializeAndVerify(p, validators, hooks);
    const asyncR = await core.save.serializeAndVerifyAsync(p, validators, hooks);
    assert.strictEqual(asyncR.ok, sync.ok, label);
    if (sync.ok) assert.ok(same(asyncR.bytes, sync.bytes), label);
    else assert.deepStrictEqual(asyncR.failures, sync.failures, label);
    // verifyBytes on bytes that are not this package's serialisation (another edit's output).
    if (name === 'large.xlsx') continue;   // covered above; this would only repeat the slow part
    const other = OfficePackage.open(name, fixture(name));
    const ob = new core.edits.EditBuilder(other, 'o');
    ob.setAttr(part, other.xml(part).root, '', 'vsmdOther', '1');
    ob.finish();
    const foreign = other.serialize();
    assert.deepStrictEqual(await core.save.verifyBytesAsync(p, foreign, validators), core.save.verifyBytes(p, foreign, validators), `${label} foreign`);
  }
  // A package whose serialisation throws.
  const p = OfficePackage.open('basic.docx', fixture('basic.docx'));
  const orig = p.serialize;
  p.serialize = () => { throw new Error('nope'); };
  p.serializeAsync = () => Promise.reject(new Error('nope'));
  assert.deepStrictEqual(await core.save.serializeAndVerifyAsync(p, []), core.save.serializeAndVerify(p, []));
  p.serialize = orig;
});

test('xlsxValidator.async returns the messages of xlsxValidator on every xlsx fixture', async () => {
  const xv = core.xlsx.validate.xlsxValidator;
  assert.strictEqual(typeof xv.async, 'function');
  assert.strictEqual(xv.name, 'xlsxValidator');
  for (const name of allFixtures('xlsx')) {
    let a, b;
    try { a = OfficePackage.open(name, fixture(name)); b = OfficePackage.open(name, fixture(name)); } catch { continue; }
    const touched = a.partNames();
    const ctxA = { original: () => OfficePackage.open(name, fixture(name)) };
    let want, wantErr;
    try { want = xv(a, touched, ctxA); } catch (e) { wantErr = e; }
    if (wantErr) { await assert.rejects(xv.async(b, touched, ctxA), { message: wantErr.message }, name); continue; }
    assert.deepStrictEqual(await xv.async(b, touched, ctxA), want, name);
    const c = OfficePackage.open(name, fixture(name));
    const d = OfficePackage.open(name, fixture(name));
    assert.deepStrictEqual(await xv.async(d, touched), xv(c, touched), `${name} without context`);
  }
});

test('the async save functions yield to the event loop on large.xlsx', async () => {
  const p = OfficePackage.open('large.xlsx', fixture('large.xlsx'));
  const part = 'xl/worksheets/sheet1.xml';
  await p.xmlAsync(part);
  const b = new core.edits.EditBuilder(p, 'x');
  b.setAttr(part, p.xml(part).root, '', 'vsmdTest', '1');
  b.finish();
  const s = await turnsDuring(() => p.serializeAsync());
  assert.ok(s.turns > 1, `serializeAsync yielded ${s.turns} times`);
  const v = await turnsDuring(() => core.save.verifyBytesAsync(p, s.r, [core.xlsx.validate.xlsxValidator]));
  assert.deepStrictEqual(v.r, []);
  assert.ok(v.turns > 1, `verifyBytesAsync yielded ${v.turns} times`);
  const re = OfficePackage.open('v.xlsx', s.r);
  await re.xmlAsync(part);
  const x = await turnsDuring(() => core.xlsx.validate.xlsxValidator.async(re, [part], { original: () => undefined }));
  assert.deepStrictEqual(x.r, []);
  assert.ok(x.turns > 1, `xlsxValidator.async yielded ${x.turns} times`);
});
