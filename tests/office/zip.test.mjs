// WP-04: ZIP container reader/writer (spec §3.2, §10.2, §10.3, §12, §13.2 G1/G3).
//
// Fixture-driven tests run against tests/fixtures/office/* when present AND against archives built
// here (JSZip, fflate, ExcelJS and a hand-rolled writer that can produce every structural variant
// we care about), so they are meaningful before the WP-03 fixtures land.
import { test } from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import * as fflate from 'fflate';
import ExcelJS from 'exceljs';
import { core, fixture, allFixtures, assertBytesEqual, entryTable } from './_helpers.mjs';

const { readZip, writeZip, inflateEntry, rawDeflate, rawInflate, crc32, ZipError } = core.zip;
const L = core.limits.LIMITS;
const LIMITS = { maxFileBytes: L.maxFileBytes, maxTotalUncompressed: L.maxUncompressedTotalBytes, maxEntryUncompressed: L.maxEntryBytes };

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------------------------
// Little-endian helpers

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; };
const put32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Hand-rolled ZIP writer: full control over every field the reader looks at.

/**
 * entries: { name | nameBytes, data, method (0|8), utf8, descriptor: null|'sig'|'nosig',
 *            localExtra, centralExtra, comment, time, date, versionMadeBy, externalAttr, gapAfter,
 *            declaredSize (override CD+local uncompressed size), rawCompressed (override data) }
 * opts: { comment, cdOrder (array of indexes) }
 */
function buildZip(entries, opts = {}) {
  const locals = [];
  const recs = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = e.nameBytes ?? enc.encode(e.name);
    const data = e.data ?? new Uint8Array(0);
    const method = e.method ?? 8;
    const packed = e.rawCompressed ?? (method === 8 ? fflate.deflateSync(data, { level: 6 }) : data);
    const crc = e.crc ?? crc32(data);
    const usize = e.declaredSize ?? data.length;
    const flags = (e.flags ?? 0) | (e.utf8 ? 0x0800 : 0) | (e.descriptor ? 0x0008 : 0);
    const localExtra = e.localExtra ?? new Uint8Array(0);
    const centralExtra = e.centralExtra ?? new Uint8Array(0);
    const comment = enc.encode(e.comment ?? '');
    const time = e.time ?? 0x6000;
    const date = e.date ?? 0x5a74;
    const h = new Uint8Array(30 + nameBytes.length + localExtra.length);
    put32(h, 0, 0x04034b50); put16(h, 4, 20); put16(h, 6, flags); put16(h, 8, method);
    put16(h, 10, time); put16(h, 12, date);
    if (!e.descriptor) { put32(h, 14, crc); put32(h, 18, packed.length); put32(h, 22, usize); }
    put16(h, 26, nameBytes.length); put16(h, 28, localExtra.length);
    h.set(nameBytes, 30); h.set(localExtra, 30 + nameBytes.length);
    const parts = [h, packed];
    if (e.descriptor) {
      const d = new Uint8Array(e.descriptor === 'sig' ? 16 : 12);
      let o = 0;
      if (e.descriptor === 'sig') { put32(d, 0, 0x08074b50); o = 4; }
      put32(d, o, crc); put32(d, o + 4, packed.length); put32(d, o + 8, usize);
      parts.push(d);
    }
    if (e.gapAfter) parts.push(e.gapAfter);
    const local = concat(...parts);
    const r = new Uint8Array(46 + nameBytes.length + centralExtra.length + comment.length);
    put32(r, 0, 0x02014b50); put16(r, 4, e.versionMadeBy ?? 0x031e); put16(r, 6, 20); put16(r, 8, flags);
    put16(r, 10, method); put16(r, 12, time); put16(r, 14, date); put32(r, 16, crc);
    put32(r, 20, packed.length); put32(r, 24, usize); put16(r, 28, nameBytes.length);
    put16(r, 30, centralExtra.length); put16(r, 32, comment.length); put16(r, 34, 0); put16(r, 36, e.internalAttr ?? 0);
    put32(r, 38, e.externalAttr ?? 0); put32(r, 42, offset);
    r.set(nameBytes, 46); r.set(centralExtra, 46 + nameBytes.length); r.set(comment, 46 + nameBytes.length + centralExtra.length);
    locals.push(local);
    recs.push(r);
    offset += local.length;
  }
  const order = opts.cdOrder ?? recs.map((_, i) => i);
  const cd = concat(...order.map((i) => recs[i]));
  const comment = enc.encode(opts.comment ?? '');
  const eocd = new Uint8Array(22 + comment.length);
  put32(eocd, 0, 0x06054b50); put16(eocd, 8, entries.length); put16(eocd, 10, entries.length);
  put32(eocd, 12, cd.length); put32(eocd, 16, offset); put16(eocd, 20, comment.length); eocd.set(comment, 22);
  return concat(...locals, cd, eocd);
}

function extraField(id, payload) {
  const f = new Uint8Array(4 + payload.length);
  put16(f, 0, id); put16(f, 2, payload.length); f.set(payload, 4);
  return f;
}

/** Deterministic pseudo-random bytes (LCG). */
function pseudoRandom(n, seed = 12345) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}

function xmlish(tag, n) {
  let s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<' + tag + '>';
  for (let i = 0; i < n; i++) s += `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i % 17}</v></c></row>`;
  return enc.encode(s + '</' + tag + '>');
}

// ---------------------------------------------------------------------------------------------
// Corpus of in-test archives

async function excelWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'zip.test';
  wb.created = new Date(Date.UTC(2020, 0, 1));
  wb.modified = new Date(Date.UTC(2020, 0, 1));
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Text', 42, true, new Date(Date.UTC(2021, 5, 1)), 0.25]);
  ws.addRow(['More', 3.14159, false, { formula: 'B1*2', result: 84 }, 'x']);
  ws.getCell('E1').numFmt = '0.00%';
  wb.addWorksheet('Second').addRow([1, 2, 3]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** `basic.xlsx` from fixtures when present, else an ExcelJS-written workbook. */
async function basicXlsx() {
  if (allFixtures('xlsx').includes('basic.xlsx')) return { bytes: fixture('basic.xlsx'), source: 'fixture basic.xlsx' };
  return { bytes: await excelWorkbook(), source: 'ExcelJS stand-in for basic.xlsx' };
}

async function jszipArchive({ streamFiles = false, comment } = {}) {
  const z = new JSZip();
  const date = new Date(2020, 0, 2, 3, 4, 6);
  z.file('[Content_Types].xml', xmlish('Types', 3), { date });
  z.file('_rels/.rels', xmlish('Relationships', 2), { date });
  z.file('xl/workbook.xml', xmlish('workbook', 40), { date, comment: 'entry comment' });
  z.file('xl/worksheets/sheet1.xml', xmlish('worksheet', 2000), { date });
  z.file('xl/media/image1.png', pseudoRandom(5000), { date, compression: 'STORE' });
  z.file('docProps/empty.xml', new Uint8Array(0), { date });
  z.folder('xl/emptyFolder');
  return new Uint8Array(await z.generateAsync({
    type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles, comment,
  }));
}

function fflateArchive() {
  return fflate.zipSync({
    'word/document.xml': [xmlish('w:document', 500), { level: 9, comment: 'fflate comment', extra: { 0xcafe: new Uint8Array([1, 2, 3, 4]) } }],
    'word/media/image1.bin': [pseudoRandom(3000, 7), { level: 0 }],
    'word/styles.xml': [xmlish('w:styles', 50), { level: 1, mtime: new Date(2019, 4, 5, 6, 7, 8) }],
  });
}

function handmadeArchive() {
  return buildZip([
    { name: '[Content_Types].xml', data: xmlish('Types', 5), method: 8, localExtra: extraField(0x5455, new Uint8Array([1, 0, 0, 0, 0])), centralExtra: extraField(0x5455, new Uint8Array([1, 0, 0, 0, 0])) },
    { name: 'stored.bin', data: pseudoRandom(777, 3), method: 0, comment: 'stored entry' },
    { name: 'desc-sig.xml', data: xmlish('a', 300), method: 8, descriptor: 'sig' },
    { name: 'desc-nosig.xml', data: xmlish('b', 300), method: 8, descriptor: 'nosig' },
    { name: 'gap.xml', data: xmlish('c', 10), method: 8, gapAfter: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0]) },
    { nameBytes: new Uint8Array([0x63, 0x70, 0x34, 0x33, 0x37, 0x2d, 0x81, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: enc.encode('cp437 name'), method: 8 },
    { name: 'utf8-ü-名前.xml', utf8: true, data: enc.encode('<x/>'), method: 8, centralExtra: extraField(0x000a, new Uint8Array(32)) },
    { name: 'dir/', data: new Uint8Array(0), method: 0, externalAttr: 0x10 },
    { name: 'empty-deflated.xml', data: new Uint8Array(0), method: 8 },
  ], { comment: 'archive comment ✓' });
}

async function inTestCorpus() {
  return [
    { label: 'ExcelJS workbook', bytes: await excelWorkbook() },
    { label: 'JSZip deflate+store, archive comment', bytes: await jszipArchive({ comment: 'jszip archive comment' }) },
    { label: 'JSZip streamFiles (data descriptors)', bytes: await jszipArchive({ streamFiles: true }) },
    { label: 'fflate (extra fields, entry comment, levels 0/1/9)', bytes: fflateArchive() },
    { label: 'hand-made (descriptors, gap, extras, CP437/UTF-8 names, comments)', bytes: handmadeArchive() },
    { label: 'empty archive', bytes: buildZip([]) },
    { label: 'empty archive with comment', bytes: buildZip([], { comment: 'nothing here' }) },
  ];
}

/** Fixtures the reader must refuse, with the expected code. */
const EXPECTED_REFUSALS = new Map([
  ['zip64.xlsx', ['zip64']],
  ['truncated.docx', ['truncated']],
  ['encrypted.docx', ['not-zip']], // OLE compound file, detected by sniffing before the ZIP reader
  ['encrypted.xlsx', ['not-zip']],
  ['legacy-renamed.docx', ['not-zip']],
]);

function assertZipError(fn, code, msg) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ZipError, `${msg}: expected ZipError, got ${e && e.stack}`);
    assert.strictEqual(e.code, code, `${msg}: expected code ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  assert.fail(`${msg}: expected ZipError ${code}, nothing thrown`);
}

function keepAll(zip) {
  return writeZip(zip, zip.entries.map((e) => ({ keep: e })));
}

/** Patch a field in an entry's central record (and, when given, the same field in its local header). */
function patchEntry(bytes, entry, { cd, local }) {
  const out = bytes.slice();
  if (cd) cd(out, entry.cdRecord[0]);
  if (local) local(out, entry.extent[0]);
  return out;
}

function zeroOffset(rec) {
  const r = rec.slice();
  r.fill(0, 42, 46);
  return r;
}

async function referenceContents(bytes) {
  const z = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const map = new Map();
  for (const [name, f] of Object.entries(z.files)) map.set(name, f.dir ? null : await f.async('uint8array'));
  return map;
}

// ---------------------------------------------------------------------------------------------
// G1

test('G1: forced rewrite of every fixture is byte-identical', async () => {
  const cases = [];
  for (const name of allFixtures()) cases.push({ label: `fixture ${name}`, bytes: fixture(name), fixtureName: name });
  for (const c of await inTestCorpus()) cases.push(c);
  let rewritten = 0;
  for (const c of cases) {
    let zip;
    try {
      zip = readZip(c.bytes, LIMITS);
    } catch (e) {
      const allowed = c.fixtureName && EXPECTED_REFUSALS.get(c.fixtureName);
      if (allowed && e instanceof ZipError && allowed.includes(e.code)) continue;
      throw new Error(`${c.label}: unexpected refusal: ${e.code ?? ''} ${e.message}`);
    }
    if (c.fixtureName && EXPECTED_REFUSALS.has(c.fixtureName)) assert.fail(`${c.label}: should have been refused`);
    assertBytesEqual(keepAll(zip), c.bytes, `${c.label}: forced rewrite`);
    // Every entry must also inflate with a good CRC (proves the reader's view is complete).
    for (const e of zip.entries) {
      const data = inflateEntry(zip, e);
      assert.strictEqual(data.length, e.uncompressedSize, `${c.label}: ${e.name} size`);
    }
    rewritten++;
  }
  assert.ok(rewritten >= 7, `rewrote ${rewritten} archives`);
});

test('G1 holds for data-descriptor entries', async () => {
  const cases = [];
  if (allFixtures('xlsx').includes('data-descriptors.xlsx')) cases.push({ label: 'fixture data-descriptors.xlsx', bytes: fixture('data-descriptors.xlsx') });
  cases.push({ label: 'JSZip streamFiles', bytes: await jszipArchive({ streamFiles: true, comment: 'dd' }) });
  cases.push({
    label: 'hand-made descriptors with and without signature',
    bytes: buildZip([
      { name: 'a.xml', data: xmlish('a', 100), descriptor: 'sig' },
      { name: 'b.xml', data: xmlish('b', 100), descriptor: 'nosig' },
      { name: 'c.bin', data: pseudoRandom(100), method: 0, descriptor: 'sig' },
      { name: 'd.xml', data: xmlish('d', 3), descriptor: 'nosig' },
    ]),
  });
  for (const c of cases) {
    const zip = readZip(c.bytes, LIMITS);
    const withDescriptor = zip.entries.filter((e) => e.flags & 0x0008);
    assert.ok(withDescriptor.length > 0, `${c.label}: has bit-3 entries`);
    for (const e of withDescriptor) {
      // The extent covers the descriptor: it runs past the compressed data.
      const start = e.extent[0];
      const dataEnd = start + 30 + u16(c.bytes, start + 26) + u16(c.bytes, start + 28) + e.compressedSize;
      assert.ok(e.extent[1] >= dataEnd + 12, `${c.label}: ${e.name} extent includes the descriptor`);
    }
    assertBytesEqual(keepAll(zip), c.bytes, `${c.label}: forced rewrite`);
    const ref = await referenceContents(c.bytes);
    for (const e of zip.entries) {
      if (e.name.endsWith('/')) continue;
      assertBytesEqual(inflateEntry(zip, e), ref.get(e.name), `${c.label}: ${e.name} content`);
    }
  }
});

test('archive whose central directory order differs from file order is read and rewritten validly', async () => {
  const bytes = buildZip([
    { name: 'a.xml', data: enc.encode('<a/>') },
    { name: 'b.xml', data: enc.encode('<b/>') },
    { name: 'c.xml', data: enc.encode('<c/>') },
  ], { cdOrder: [2, 0, 1] });
  const zip = readZip(bytes, LIMITS);
  assert.deepStrictEqual(zip.entries.map((e) => e.name), ['c.xml', 'a.xml', 'b.xml']);
  const out = keepAll(zip);
  const ref = fflate.unzipSync(out);
  assert.deepStrictEqual(Object.keys(ref).sort(), ['a.xml', 'b.xml', 'c.xml']);
  assert.strictEqual(dec.decode(ref['a.xml']), '<a/>');
  // Re-reading and re-writing the output is byte-identical (its orders agree).
  assertBytesEqual(keepAll(readZip(out, LIMITS)), out, 'second rewrite');
});

// ---------------------------------------------------------------------------------------------
// Refusals

test('refuses zip64', async () => {
  if (allFixtures('xlsx').includes('zip64.xlsx')) assertZipError(() => readZip(fixture('zip64.xlsx'), LIMITS), 'zip64', 'fixture zip64.xlsx');
  const { bytes, source } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  const eocd = bytes.length - 22 - zip.comment.length;
  const cdEnd = u32(bytes, eocd + 16) + u32(bytes, eocd + 12);

  // (a) ZIP64 end-of-central-directory record + locator inserted before the EOCD.
  const rec = new Uint8Array(56);
  put32(rec, 0, 0x06064b50); put32(rec, 4, 44); put16(rec, 12, 45); put16(rec, 14, 45);
  put32(rec, 24, zip.entries.length); put32(rec, 32, zip.entries.length);
  put32(rec, 40, u32(bytes, eocd + 12)); put32(rec, 48, u32(bytes, eocd + 16));
  const loc = new Uint8Array(20);
  put32(loc, 0, 0x07064b50); put32(loc, 8, cdEnd); put32(loc, 16, 1);
  const withZip64 = concat(bytes.subarray(0, eocd), rec, loc, bytes.subarray(eocd));
  assertZipError(() => readZip(withZip64, LIMITS), 'zip64', `${source} + zip64 EOCD/locator`);

  // (b) ZIP64 EOCD record alone (no locator).
  assertZipError(() => readZip(concat(bytes.subarray(0, eocd), rec, bytes.subarray(eocd)), LIMITS), 'zip64', 'zip64 record only');

  // (c) saturated sizes in a central record.
  const sat = patchEntry(bytes, zip.entries[0], { cd: (b, o) => put32(b, o + 20, 0xffffffff) });
  assertZipError(() => readZip(sat, LIMITS), 'zip64', 'saturated compressed size');

  // (d) ZIP64 extended-information extra field.
  const z64extra = buildZip([{ name: 'a.xml', data: enc.encode('<a/>'), centralExtra: extraField(0x0001, new Uint8Array(8)) }]);
  assertZipError(() => readZip(z64extra, LIMITS), 'zip64', 'zip64 extra field');

  // (e) saturated entry count in the EOCD.
  const satCount = bytes.slice();
  put16(satCount, eocd + 8, 0xffff); put16(satCount, eocd + 10, 0xffff);
  assertZipError(() => readZip(satCount, LIMITS), 'zip64', 'saturated entry count');
});

test('refuses multi-disk archives', async () => {
  const { bytes } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  const eocd = bytes.length - 22 - zip.comment.length;
  const b1 = bytes.slice(); put16(b1, eocd + 4, 1);
  assertZipError(() => readZip(b1, LIMITS), 'multi-disk', 'disk number');
  const b2 = bytes.slice(); put16(b2, eocd + 8, u16(b2, eocd + 8) - 1);
  assertZipError(() => readZip(b2, LIMITS), 'multi-disk', 'entries on this disk != total');
  const b3 = patchEntry(bytes, zip.entries[0], { cd: (b, o) => put16(b, o + 34, 1) });
  assertZipError(() => readZip(b3, LIMITS), 'multi-disk', 'entry disk start');
});

test('refuses encrypted entry', async () => {
  const { bytes, source } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  for (const bit of [0x0001, 0x0040]) {
    const target = zip.entries[zip.entries.length - 1];
    const patched = patchEntry(bytes, target, {
      cd: (b, o) => put16(b, o + 8, u16(b, o + 8) | bit),
      local: (b, o) => put16(b, o + 6, u16(b, o + 6) | bit),
    });
    const err = assertZipError(() => readZip(patched, LIMITS), 'encrypted', `${source} flag ${bit}`);
    assert.strictEqual(err.entryName, target.name);
  }
  // Flag only in the local header (central directory says clear) is still refused.
  const localOnly = patchEntry(bytes, zip.entries[0], { local: (b, o) => put16(b, o + 6, u16(b, o + 6) | 1) });
  assertZipError(() => readZip(localOnly, LIMITS), 'encrypted', 'local-only encryption flag');
});

test('refuses method 9', async () => {
  const { bytes, source } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  const target = zip.entries[0];
  const patched = patchEntry(bytes, target, {
    cd: (b, o) => put16(b, o + 10, 9),
    local: (b, o) => put16(b, o + 8, 9),
  });
  const err = assertZipError(() => readZip(patched, LIMITS), 'unsupported-compression', `${source} method 9`);
  assert.strictEqual(err.entryName, target.name);
  for (const m of [1, 12, 14, 93, 99]) {
    assertZipError(() => readZip(patchEntry(bytes, target, { cd: (b, o) => put16(b, o + 10, m) }), LIMITS),
      'unsupported-compression', `method ${m}`);
  }
});

test('refuses duplicate names differing by case', async () => {
  const hand = buildZip([
    { name: 'xl/workbook.xml', data: enc.encode('<a/>') },
    { name: 'xl/Workbook.XML', data: enc.encode('<b/>') },
  ]);
  const err = assertZipError(() => readZip(hand, LIMITS), 'duplicate-name', 'case-only difference');
  assert.strictEqual(err.entryName, 'xl/Workbook.XML');
  const exact = buildZip([{ name: 'a.xml', data: enc.encode('1') }, { name: 'a.xml', data: enc.encode('2') }]);
  assertZipError(() => readZip(exact, LIMITS), 'duplicate-name', 'exact duplicate');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('[content_types].xml', '<Types/>');
  const jz = new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
  assertZipError(() => readZip(jz, LIMITS), 'duplicate-name', 'JSZip archive');
});

test('refuses overlapping extents', async () => {
  const { bytes, source } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  const byFile = [...zip.entries].sort((a, b) => a.extent[0] - b.extent[0]);

  // (a) two central records point at the same local header.
  const shared = patchEntry(bytes, byFile[1], { cd: (b, o) => put32(b, o + 42, byFile[0].extent[0]) });
  assertZipError(() => readZip(shared, LIMITS), 'overlap', `${source}: shared local header`);

  // (b) an entry's data runs into the next entry (sizes enlarged consistently in CD and local header).
  const i = byFile.findIndex((e, k) => e.method === 8 && k + 1 < byFile.length && !(e.flags & 8));
  assert.ok(i >= 0, 'found a deflated entry with a successor');
  const victim = byFile[i];
  const grow = victim.extent[1] - victim.extent[0];
  const runs = patchEntry(bytes, victim, {
    cd: (b, o) => put32(b, o + 20, victim.compressedSize + grow),
    local: (b, o) => put32(b, o + 18, victim.compressedSize + grow),
  });
  assertZipError(() => readZip(runs, LIMITS), 'overlap', `${source}: data runs into next entry`);

  // (c) the last entry's data runs into the central directory.
  const last = byFile[byFile.length - 1];
  const intoCd = patchEntry(bytes, last, {
    cd: (b, o) => put32(b, o + 20, last.compressedSize + 40),
    local: (b, o) => { if (!(last.flags & 8)) put32(b, o + 18, last.compressedSize + 40); },
  });
  if (last.method === 8) assertZipError(() => readZip(intoCd, LIMITS), 'overlap', `${source}: data runs into CD`);

  // (d) a local header offset pointing into the central directory.
  const eocd = bytes.length - 22 - zip.comment.length;
  const intoCd2 = patchEntry(bytes, last, { cd: (b, o) => put32(b, o + 42, u32(bytes, eocd + 16)) });
  assertZipError(() => readZip(intoCd2, LIMITS), 'overlap', `${source}: offset at CD`);
});

test("refuses '..' and absolute names", () => {
  const unsafe = ['../evil.xml', 'xl/../../evil.xml', 'xl/..', '..', '/abs.xml', '\\abs.xml', 'xl\\..\\..\\evil.xml',
    'C:/Windows/evil.xml', 'c:evil.xml', 'nul\0byte.xml'];
  for (const name of unsafe) {
    const bytes = buildZip([{ name: 'ok.xml', data: enc.encode('<ok/>') }, { name, data: enc.encode('<x/>') }]);
    const err = assertZipError(() => readZip(bytes, LIMITS), 'unsafe-name', JSON.stringify(name));
    assert.strictEqual(err.entryName, name);
  }
  // Dots inside a segment are not traversal.
  const fine = buildZip([{ name: 'a..b.xml', data: enc.encode('1') }, { name: 'x/.hidden/..x', data: enc.encode('2') }, { name: 'x/./y.xml', data: enc.encode('3') }]);
  assert.strictEqual(readZip(fine, LIMITS).entries.length, 3);
  // The writer refuses the same names on add.
  const zip = readZip(fine, LIMITS);
  for (const name of unsafe) {
    assertZipError(() => writeZip(zip, [{ add: name, data: enc.encode('x') }]), 'unsafe-name', `add ${JSON.stringify(name)}`);
  }
});

test('refuses declared size over limits', async () => {
  const { bytes } = await basicXlsx();
  assertZipError(() => readZip(bytes, { ...LIMITS, maxFileBytes: bytes.length - 1 }), 'too-large', 'file size');
  readZip(bytes, { ...LIMITS, maxFileBytes: bytes.length }); // boundary is inclusive
  const zip = readZip(bytes, LIMITS);
  const biggest = Math.max(...zip.entries.map((e) => e.uncompressedSize));
  const sum = zip.entries.reduce((n, e) => n + e.uncompressedSize, 0);
  assertZipError(() => readZip(bytes, { ...LIMITS, maxEntryUncompressed: biggest - 1 }), 'too-large', 'entry size');
  readZip(bytes, { ...LIMITS, maxEntryUncompressed: biggest });
  assertZipError(() => readZip(bytes, { ...LIMITS, maxTotalUncompressed: sum - 1 }), 'too-large', 'total size');
  readZip(bytes, { ...LIMITS, maxTotalUncompressed: sum });

  // The real §10.2 limits: one entry declared at 400 MB + 1, and a 1 GB + 1 total from four entries.
  const MB = 1024 * 1024;
  const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const oneBig = buildZip([{ name: 'big.xml', rawCompressed: garbage, declaredSize: 400 * MB + 1, crc: 0 }]);
  assertZipError(() => readZip(oneBig, LIMITS), 'too-large', 'single entry over 400 MB');
  const parts = [0, 1, 2, 3].map((i) => ({ name: `p${i}.xml`, rawCompressed: garbage, declaredSize: 256 * MB + (i === 0 ? 1 : 0), crc: 0 }));
  assertZipError(() => readZip(buildZip(parts), LIMITS), 'too-large', 'total over 1 GB');
});

test('refuses not a zip', () => {
  const cases = [
    ['empty', new Uint8Array(0)],
    ['short text', enc.encode('hello')],
    ['text', enc.encode('This is not a zip file at all, just some plain text that is long enough.')],
    ['OLE compound file', concat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), new Uint8Array(1024))],
    ['random', pseudoRandom(4096, 99)],
  ];
  for (const [label, bytes] of cases) assertZipError(() => readZip(bytes, LIMITS), 'not-zip', label);
  for (const name of ['encrypted.docx', 'encrypted.xlsx', 'legacy-renamed.docx']) {
    if (allFixtures().includes(name)) assertZipError(() => readZip(fixture(name), LIMITS), 'not-zip', `fixture ${name}`);
  }
});

test('refuses truncated', async () => {
  if (allFixtures('docx').includes('truncated.docx')) assertZipError(() => readZip(fixture('truncated.docx'), LIMITS), 'truncated', 'fixture truncated.docx');
  const { bytes, source } = await basicXlsx();
  for (const frac of [0.6, 0.9, 0.99]) {
    assertZipError(() => readZip(bytes.slice(0, Math.floor(bytes.length * frac)), LIMITS), 'truncated', `${source} first ${frac * 100}%`);
  }
  assertZipError(() => readZip(bytes.slice(0, bytes.length - 1), LIMITS), 'truncated', 'missing last byte');
  assertZipError(() => readZip(bytes.slice(0, 10), LIMITS), 'truncated', 'first 10 bytes');
});

test('refuses inconsistent local headers and stray bytes (bad-data)', async () => {
  const { bytes } = await basicXlsx();
  const zip = readZip(bytes, LIMITS);
  const e = zip.entries[0];
  // Local name differs from the central name.
  assertZipError(() => readZip(patchEntry(bytes, e, { local: (b, o) => { b[o + 30] ^= 0x20; } }), LIMITS), 'bad-data', 'name mismatch');
  // Local method differs.
  assertZipError(() => readZip(patchEntry(bytes, e, { local: (b, o) => put16(b, o + 8, e.method === 8 ? 0 : 8) }), LIMITS), 'bad-data', 'method mismatch');
  // Local signature broken.
  assertZipError(() => readZip(patchEntry(bytes, e, { local: (b, o) => { b[o] = 0; } }), LIMITS), 'bad-data', 'local signature');
  // Bytes before the first entry, and after the EOCD.
  assertZipError(() => readZip(concat(new Uint8Array([1, 2, 3]), bytes), LIMITS), 'bad-data', 'prefix');
  assertZipError(() => readZip(concat(bytes, new Uint8Array([0])), LIMITS), 'bad-data', 'suffix');
  // Stored entry whose sizes disagree.
  const stored = buildZip([{ name: 's.bin', data: pseudoRandom(10), method: 0, declaredSize: 11 }]);
  assertZipError(() => readZip(stored, LIMITS), 'bad-data', 'stored size mismatch');
  // Local sizes differ from central (no data descriptor).
  const notDesc = zip.entries.find((x) => !(x.flags & 8));
  if (notDesc) {
    assertZipError(() => readZip(patchEntry(bytes, notDesc, { local: (b, o) => put32(b, o + 14, u32(b, o + 14) ^ 1) }), LIMITS), 'bad-data', 'local CRC mismatch');
  }
});

// ---------------------------------------------------------------------------------------------
// Inflate

test('inflate detects a flipped data bit (bad-crc)', async () => {
  // Stored entry: a flipped bit always reaches the CRC check.
  const data = pseudoRandom(2000, 5);
  const bytes = buildZip([{ name: 'a.xml', data: xmlish('a', 50) }, { name: 'stored.bin', data, method: 0 }]);
  const zip = readZip(bytes, LIMITS);
  const stored = zip.entries[1];
  const flipped = bytes.slice();
  const dataStart = stored.extent[0] + 30 + u16(bytes, stored.extent[0] + 26);
  flipped[dataStart + 1000] ^= 0x10;
  const fz = readZip(flipped, LIMITS); // the reader does not inflate, so it cannot notice
  const err = assertZipError(() => inflateEntry(fz, fz.entries[1]), 'bad-crc', 'stored flipped bit');
  assert.strictEqual(err.entryName, 'stored.bin');
  assertBytesEqual(inflateEntry(fz, fz.entries[0]), xmlish('a', 50), 'other entry unaffected');

  // Deflated entries of a real workbook: a wrong CRC is bad-crc; corrupted data is bad-crc or bad-data.
  const { bytes: wb } = await basicXlsx();
  const wz = readZip(wb, LIMITS);
  const def = wz.entries.find((e) => e.method === 8 && e.compressedSize > 50);
  const crcBad = patchEntry(wb, def, {
    cd: (b, o) => put32(b, o + 16, (def.crc32 ^ 1) >>> 0),
    local: (b, o) => { if (!(def.flags & 8)) put32(b, o + 14, (def.crc32 ^ 1) >>> 0); },
  });
  const cz = readZip(crcBad, LIMITS);
  assertZipError(() => inflateEntry(cz, cz.entries.find((e) => e.name === def.name)), 'bad-crc', 'deflated wrong CRC');
  const defStart = def.extent[0] + 30 + u16(wb, def.extent[0] + 26) + u16(wb, def.extent[0] + 28);
  for (let k = 0; k < 8; k++) {
    const b = wb.slice();
    b[defStart + Math.floor(def.compressedSize * (0.3 + k * 0.08))] ^= 1 << (k % 8);
    const z = readZip(b, LIMITS);
    try {
      inflateEntry(z, z.entries.find((e) => e.name === def.name));
      assert.fail('corruption not detected');
    } catch (e) {
      assert.ok(e instanceof ZipError && (e.code === 'bad-crc' || e.code === 'bad-data'), `flip ${k}: ${e.code} ${e.message}`);
    }
  }
  // Either code is acceptable for corrupted deflate data; the stored case above pins bad-crc.
});

test('crc32, rawDeflate and rawInflate', () => {
  assert.strictEqual(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(new Uint8Array(0)), 0);
  const data = xmlish('roundtrip', 3000);
  for (const level of [1, 6]) {
    const packed = rawDeflate(data, level);
    assert.ok(packed.length < data.length / 4, `level ${level} compresses`);
    assertBytesEqual(rawInflate(packed), data, `level ${level} round trip`);
    assertBytesEqual(rawInflate(packed, data.length), data, `level ${level} bounded round trip`);
    assertBytesEqual(fflate.inflateSync(packed), data, `level ${level} independent inflate`);
    assertZipError(() => rawInflate(packed, data.length - 1), 'bad-data', 'expected size too small');
    assertZipError(() => rawInflate(packed, data.length + 1), 'bad-data', 'expected size too large');
    assertZipError(() => rawInflate(packed.subarray(0, packed.length >> 1), data.length), 'bad-data', 'truncated stream');
  }
  assertBytesEqual(rawInflate(rawDeflate(new Uint8Array(0), 6), 0), new Uint8Array(0), 'empty');
  assertZipError(() => rawInflate(new Uint8Array([0xff, 0xff, 0xff]), 10), 'bad-data', 'garbage');
});

// ---------------------------------------------------------------------------------------------
// Writer: replace / add / remove

async function replaceCases() {
  const { bytes, source } = await basicXlsx();
  const out = [{ label: source, bytes }];
  out.push({ label: 'JSZip streamFiles', bytes: await jszipArchive({ streamFiles: true, comment: 'c' }) });
  out.push({ label: 'hand-made', bytes: handmadeArchive() });
  return out;
}

test("replace: only the replaced entry's bytes differ; all other extents and CD records identical except offsets", async () => {
  for (const c of await replaceCases()) {
    const zip = readZip(c.bytes, LIMITS);
    const before = entryTable(c.bytes);
    // Replace one entry near the start (so every later offset moves) and check every other entry.
    for (const targetIndex of [0, Math.floor(zip.entries.length / 2)]) {
      const target = zip.entries[targetIndex];
      const newData = enc.encode(`<replaced index="${targetIndex}">${'x'.repeat(5000)}</replaced>`);
      const items = zip.entries.map((e) => (e === target ? { replace: e, data: newData } : { keep: e }));
      const out = writeZip(zip, items);
      const oz = readZip(out, LIMITS);
      assert.deepStrictEqual(oz.entries.map((e) => e.name), zip.entries.map((e) => e.name), `${c.label}: order preserved`);
      const after = entryTable(out);
      for (let i = 0; i < zip.entries.length; i++) {
        const a = zip.entries[i];
        const b = oz.entries[i];
        if (a === target) continue;
        // Whole extent (local header + data + descriptor + gap) identical.
        assertBytesEqual(out.subarray(b.extent[0], b.extent[1]), c.bytes.subarray(a.extent[0], a.extent[1]), `${c.label}: ${a.name} extent`);
        // Central record identical except the offset field.
        assertBytesEqual(zeroOffset(out.slice(b.cdRecord[0], b.cdRecord[1])), zeroOffset(c.bytes.slice(a.cdRecord[0], a.cdRecord[1])), `${c.label}: ${a.name} CD record`);
        // G3 table view agrees.
        const ta = before.get(a.name); const tb = after.get(a.name);
        assert.strictEqual(tb.crc, ta.crc);
        assertBytesEqual(tb.compressedBytes, ta.compressedBytes, `${c.label}: ${a.name} compressed bytes`);
        assertBytesEqual(tb.cdRecordBytes, ta.cdRecordBytes, `${c.label}: ${a.name} cdRecordBytes`);
        // Offset field patched to the new location.
        assert.strictEqual(u32(out, b.cdRecord[0] + 42), b.extent[0]);
      }
      const nt = oz.entries[targetIndex];
      assertBytesEqual(inflateEntry(oz, nt), newData, `${c.label}: replaced content`);
      assert.strictEqual(nt.method, 8);
      assert.strictEqual(nt.flags & 0x0008, 0, 'fresh local header has no data descriptor');
      assert.strictEqual(nt.flags & 0x0800, target.flags & 0x0800, 'UTF-8 flag as original');
      assert.strictEqual(nt.dosTime, target.dosTime, 'original DOS time');
      assert.strictEqual(nt.dosDate, target.dosDate, 'original DOS date');
      assert.strictEqual(nt.crc32, crc32(newData));
      // Deflate level 6.
      assertBytesEqual(after.get(target.name).compressedBytes, rawDeflate(newData, 6), 'deflate level 6');
      // Fresh local header carries sizes and CRC.
      assert.strictEqual(u32(out, nt.extent[0] + 14), nt.crc32);
      assert.strictEqual(u32(out, nt.extent[0] + 18), nt.compressedSize);
      assert.strictEqual(u32(out, nt.extent[0] + 22), nt.uncompressedSize);
      // Independent readers agree.
      const ref = await referenceContents(out);
      assertBytesEqual(ref.get(target.name), newData, `${c.label}: JSZip sees replaced content`);
      assertBytesEqual(oz.comment, zip.comment, 'comment preserved');
    }
  }
});

test('add appends after existing entries with the 1980-01-01 timestamp; omit removes; archive comment preserved', async () => {
  const sources = [
    { label: 'JSZip with comment', bytes: await jszipArchive({ comment: 'keep this comment' }) },
    { label: 'hand-made with comment', bytes: handmadeArchive() },
    (await basicXlsx()),
  ];
  for (const c of sources) {
    const label = c.label ?? c.source;
    const zip = readZip(c.bytes, LIMITS);
    const removed = zip.entries[1];
    const kept = zip.entries.filter((e) => e !== removed);
    const added = [
      { add: 'customXml/item1.xml', data: enc.encode('<item/>') },
      { add: 'customXml/ünïcode.xml', data: enc.encode('<u/>') },
    ];
    const out = writeZip(zip, [...kept.map((e) => ({ keep: e })), ...added]);
    const oz = readZip(out, LIMITS);
    const names = oz.entries.map((e) => e.name);
    assert.deepStrictEqual(names, [...kept.map((e) => e.name), 'customXml/item1.xml', 'customXml/ünïcode.xml'], `${label}: names`);
    assert.ok(!names.includes(removed.name), `${label}: omitted entry removed`);
    // Appended after every existing entry, in file order as well.
    const lastKeptEnd = Math.max(...oz.entries.slice(0, kept.length).map((e) => e.extent[1]));
    const a1 = oz.entries[kept.length]; const a2 = oz.entries[kept.length + 1];
    assert.strictEqual(a1.extent[0], lastKeptEnd);
    assert.ok(a2.extent[0] > a1.extent[0]);
    for (const a of [a1, a2]) {
      assert.strictEqual(a.dosDate, 0x0021, '1980-01-01');
      assert.strictEqual(a.dosTime, 0, '00:00:00');
      assert.strictEqual(a.method, 8);
      assert.strictEqual(a.flags & 0x0008, 0);
    }
    assert.strictEqual(a1.flags & 0x0800, 0, 'ASCII name: no UTF-8 flag');
    assert.strictEqual(a2.flags & 0x0800, 0x0800, 'non-ASCII name: UTF-8 flag');
    assertBytesEqual(inflateEntry(oz, a1), enc.encode('<item/>'));
    assertBytesEqual(inflateEntry(oz, a2), enc.encode('<u/>'));
    assertBytesEqual(oz.comment, zip.comment, `${label}: comment preserved`);
    if (zip.comment.length) assert.ok(zip.comment.length > 0);
    // Kept entries are byte-identical.
    for (let i = 0; i < kept.length; i++) {
      assertBytesEqual(out.subarray(oz.entries[i].extent[0], oz.entries[i].extent[1]), c.bytes.subarray(kept[i].extent[0], kept[i].extent[1]), `${label}: ${kept[i].name}`);
    }
    const ref = await referenceContents(out);
    assert.ok(!ref.has(removed.name));
    assertBytesEqual(ref.get('customXml/ünïcode.xml'), enc.encode('<u/>'));
  }
  // Comment check with a known value.
  const z = readZip(await jszipArchive({ comment: 'keep this comment' }), LIMITS);
  assert.strictEqual(dec.decode(z.comment), 'keep this comment');
  assert.strictEqual(dec.decode(readZip(writeZip(z, []), LIMITS).comment), 'keep this comment', 'comment survives removing everything');
});

test('writeZip refuses duplicate, repeated and foreign entries', async () => {
  const zip = readZip(handmadeArchive(), LIMITS);
  const other = readZip(handmadeArchive(), LIMITS);
  assertZipError(() => writeZip(zip, [{ keep: zip.entries[0] }, { add: zip.entries[0].name.toUpperCase(), data: new Uint8Array(1) }]), 'duplicate-name', 'add clashes by case');
  assertZipError(() => writeZip(zip, [{ keep: zip.entries[0] }, { keep: zip.entries[0] }]), 'duplicate-name', 'same entry twice');
  assertZipError(() => writeZip(zip, [{ keep: zip.entries[0] }, { replace: zip.entries[0], data: new Uint8Array(1) }]), 'duplicate-name', 'keep and replace');
  assert.throws(() => writeZip(zip, [{ keep: other.entries[0] }]), /does not belong/);
  assert.throws(() => inflateEntry(zip, other.entries[0]), /does not belong/);
});

test('output of writeZip is accepted by fflate.unzipSync and by JSZip', async () => {
  const corpus = await inTestCorpus();
  for (const name of allFixtures()) {
    try { corpus.push({ label: `fixture ${name}`, bytes: fixture(name), zip: readZip(fixture(name), LIMITS) }); } catch { /* refused fixtures */ }
  }
  for (const c of corpus) {
    const zip = c.zip ?? readZip(c.bytes, LIMITS);
    const files = zip.entries.filter((e) => !e.name.endsWith('/'));
    // Non-ASCII names without the UTF-8 flag are CP437 to us; fflate decodes them as Latin-1 and
    // JSZip as UTF-8, so those are compared by count only.
    // eslint-disable-next-line no-control-regex
    const comparable = (e) => (e.flags & 0x0800) !== 0 || /^[\x00-\x7f]*$/.test(e.name);
    const nameless = zip.entries.filter((e) => !comparable(e)).length;
    const expected = new Map(zip.entries.filter(comparable).map((e) => [e.name, e.name.endsWith('/') ? null : inflateEntry(zip, e)]));
    const variants = [{ label: 'keep all', items: zip.entries.map((e) => ({ keep: e })) }];
    if (files.length) {
      const t = files[files.length - 1];
      const data = enc.encode('<new>replaced</new>');
      variants.push({ label: 'replace', items: zip.entries.map((e) => (e === t ? { replace: e, data } : { keep: e })), expect: [[t.name, data]] });
      variants.push({ label: 'remove first', items: zip.entries.slice(1).map((e) => ({ keep: e })), removed: [zip.entries[0].name] });
    }
    variants.push({ label: 'add', items: [...zip.entries.map((e) => ({ keep: e })), { add: 'zz/added.xml', data: xmlish('added', 20) }], expect: [['zz/added.xml', xmlish('added', 20)]] });
    for (const v of variants) {
      const out = writeZip(zip, v.items);
      const exp = new Map(expected);
      for (const n of v.removed ?? []) exp.delete(n);
      for (const [n, d] of v.expect ?? []) exp.set(n, d);
      // fflate
      const ff = fflate.unzipSync(out);
      for (const [n, d] of exp) {
        assert.ok(n in ff, `${c.label} / ${v.label}: fflate sees ${n}`);
        if (d) assertBytesEqual(ff[n], d, `${c.label} / ${v.label}: fflate ${n}`);
      }
      const removedNameless = (v.removed ?? []).filter((n) => !expected.has(n)).length;
      assert.strictEqual(Object.keys(ff).length, exp.size + nameless - removedNameless, `${c.label} / ${v.label}: fflate entry count`);
      // JSZip (with CRC checking)
      const jz = await JSZip.loadAsync(out, { checkCRC32: true });
      for (const [n, d] of exp) {
        const f = jz.file(n) ?? jz.files[n];
        assert.ok(f, `${c.label} / ${v.label}: JSZip sees ${n}`);
        if (d) assertBytesEqual(await f.async('uint8array'), d, `${c.label} / ${v.label}: JSZip ${n}`);
      }
      // And our own reader accepts it again.
      readZip(out, LIMITS);
    }
  }
});

test('limits are checked from the central directory before any inflation', () => {
  const MB = 1024 * 1024;
  // A zip-bomb header: tiny, undecodable data claiming a huge size. If anything inflated it we
  // would see 'bad-data'; the declared size alone must produce 'too-large'.
  const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
  const bomb = buildZip([
    { name: 'ok.xml', data: enc.encode('<ok/>') },
    { name: 'bomb.xml', rawCompressed: garbage, declaredSize: 0xfffffffe, crc: 0x12345678 },
  ]);
  assert.ok(bomb.length < 300);
  const err = assertZipError(() => readZip(bomb, LIMITS), 'too-large', 'bomb header');
  assert.strictEqual(err.entryName, 'bomb.xml');
  // With the limit raised, readZip accepts it (proving it never inflated) and inflateEntry then fails.
  const zip = readZip(bomb, { ...LIMITS, maxEntryUncompressed: 0xfffffffe, maxTotalUncompressed: Number.MAX_SAFE_INTEGER });
  assertZipError(() => inflateEntry(zip, zip.entries.find((e) => e.name === 'bomb.xml')), 'bad-data', 'garbage data on inflate');

  // A real high-ratio entry: 16 MB of zeros (~16 KB compressed), refused by a 1 MB entry limit.
  const zeros = new Uint8Array(16 * MB);
  const real = buildZip([{ name: 'zeros.bin', data: zeros }]);
  assert.ok(real.length < 200 * 1024);
  assertZipError(() => readZip(real, { ...LIMITS, maxEntryUncompressed: MB }), 'too-large', 'real bomb, entry limit');
  assertZipError(() => readZip(real, { ...LIMITS, maxTotalUncompressed: MB }), 'too-large', 'real bomb, total limit');

  // A lying size: declares 1 KB, actually inflates to 16 MB. Inflation stops at the declared size.
  const lying = buildZip([{ name: 'liar.bin', rawCompressed: fflate.deflateSync(zeros), declaredSize: 1024, crc: crc32(zeros.subarray(0, 1024)) }]);
  const lz = readZip(lying, LIMITS);
  assertZipError(() => inflateEntry(lz, lz.entries[0]), 'bad-data', 'output exceeds declared size');
});

test('entries tile the archive: extents are contiguous from 0 to the central directory', async () => {
  const corpus = await inTestCorpus();
  for (const name of allFixtures()) { try { readZip(fixture(name), LIMITS); corpus.push({ label: name, bytes: fixture(name) }); } catch { /* refused */ } }
  for (const c of corpus) {
    const zip = readZip(c.bytes, LIMITS);
    const ext = zip.entries.map((e) => e.extent).sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [s, e] of ext) { assert.strictEqual(s, pos, `${c.label}: contiguous`); pos = e; }
    const cds = zip.entries.map((e) => e.cdRecord);
    if (cds.length) {
      assert.strictEqual(cds[0][0], pos, `${c.label}: CD follows last extent`);
      for (let i = 1; i < cds.length; i++) assert.strictEqual(cds[i][0], cds[i - 1][1], `${c.label}: CD records contiguous`);
    }
  }
});
