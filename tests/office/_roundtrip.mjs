// Shared round-trip assertions (spec §13.2 G0, G3, G4, G5) for every edit-producing WP.
//
//   assertG0(pkg)                               serialize() of an unedited package is originalBytes itself
//   assertG3(origBytes, newBytes, touched)      exactly the entries in `touched` differ (added/removed count)
//   assertG4(origText, newText, span)           text differs only inside span = { start, end } of origText
//   assertG5(pkg, edit, origBytes)              (pkg has `edit` applied) undo -> original bytes; redo -> same bytes
//   assertReopenSame(pkg)                       serialise -> re-open gives the same part names and part bytes
//   prettyDocx()                                a small docx whose document.xml is pretty-printed (fixture parts)
//
// All byte comparisons use the core ZIP reader through the test bundle.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { core, entryTable, assertBytesEqual } from './_helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = path.join(here, '..', 'fixtures', 'office', 'parts');

/** G0: nothing changed => serialize() returns the original bytes object itself. */
export function assertG0(pkg, msg = 'G0') {
  assert.strictEqual(pkg.serialize(), pkg.originalBytes, `${msg}: serialize() must return originalBytes itself`);
}

/**
 * G3: the set of entries whose compressed bytes, CRC or central-directory record differ (or that
 * were added/removed) is exactly `touched` (part names, case-insensitive).
 */
export function assertG3(origBytes, newBytes, touched, msg = 'G3') {
  const a = entryTable(origBytes);
  const b = entryTable(newBytes);
  const differs = new Set();
  for (const [name, ea] of a) {
    const eb = b.get(name);
    if (!eb) { differs.add(name.toLowerCase()); continue; }
    if (ea.crc !== eb.crc || !eq(ea.compressedBytes, eb.compressedBytes) || !eq(ea.cdRecordBytes, eb.cdRecordBytes)) differs.add(name.toLowerCase());
  }
  for (const name of b.keys()) if (!a.has(name)) differs.add(name.toLowerCase());
  assert.deepStrictEqual([...differs].sort(), touched.map((t) => t.replace(/^\//, '').toLowerCase()).sort(), `${msg}: differing entries`);
}

function eq(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * G4: `newText` equals `origText` outside origText[start, end) (the targeted element span): it is
 * origText[0, start) + anything + origText[end). Prefix and suffix are measured independently, so an
 * insertion or removal next to equal text (which a single diff could place either side) still passes.
 */
export function assertG4(origText, newText, span, msg = 'G4') {
  let prefix = 0;
  const max = Math.min(origText.length, newText.length);
  while (prefix < max && origText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max && origText[origText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  const tail = origText.length - span.end;
  assert.ok(prefix >= span.start, `${msg}: first difference at ${prefix}, before the span start ${span.start}`);
  assert.ok(suffix >= tail, `${msg}: last difference at ${origText.length - suffix}, after the span end ${span.end}`);
  assert.ok(newText.length >= span.start + tail, `${msg}: text outside the span was removed`);
}

/** Offsets of the first occurrence of `needle` in `text` as a G4 span (asserts it occurs). */
export function spanOf(text, needle, from = 0) {
  const start = text.indexOf(needle, from);
  assert.ok(start >= 0, `"${needle.slice(0, 60)}" not found`);
  return { start, end: start + needle.length };
}

/**
 * G5 for an edit already applied to `pkg`: undo serialises to `origBytes` byte for byte, redo to the
 * bytes the edit produced. Leaves `pkg` with the edit applied. Returns those bytes.
 */
export function assertG5(pkg, edit, origBytes, msg = 'G5') {
  const { applyEdit, invertEdit } = core.edits;
  const after = pkg.serialize();
  applyEdit(pkg, invertEdit(edit));
  assertBytesEqual(pkg.serialize(), origBytes, `${msg}: edit -> undo must serialise to the original bytes`);
  applyEdit(pkg, edit);
  assertBytesEqual(pkg.serialize(), after, `${msg}: edit -> undo -> redo must equal edit`);
  return after;
}

/** Serialise, re-open, and check the same parts with the same bytes come back. Returns the re-opened package. */
export function assertReopenSame(pkg, fileName = `reopen.${pkg.kind}`, msg = 'reopen') {
  const bytes = pkg.serialize();
  const re = core.pkg.OfficePackage.open(fileName, bytes);
  assert.strictEqual(re.kind, pkg.kind, `${msg}: kind`);
  assert.deepStrictEqual([...re.partNames()].sort(), [...pkg.partNames()].sort(), `${msg}: part names`);
  for (const part of pkg.partNames()) {
    assertBytesEqual(re.bytes(part), pkg.bytes(part), `${msg}: ${part}`);
  }
  return re;
}

function readPartsDir(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push([r, fs.readFileSync(path.join(d, e.name))]);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * A docx built from tests/fixtures/office/parts/docx-min with its word/document.xml replaced by the
 * pretty-printed docx-pretty one. Note docx-min's relationships deliberately name parts that are
 * absent (styles.xml, header1.xml…): a package that arrives with dangling targets.
 */
export async function prettyDocx() {
  const zip = new JSZip();
  for (const [name, data] of readPartsDir(path.join(PARTS_DIR, 'docx-min'))) zip.file(name, data);
  zip.file('word/document.xml', fs.readFileSync(path.join(PARTS_DIR, 'docx-pretty', 'word', 'document.xml')));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** Seeded PRNG (mulberry32): returns () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
