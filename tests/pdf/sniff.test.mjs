// PWP-05: core/sniff.ts — the only checks the host runs on a PDF before the webview (spec §9.4, §9.3).
import { test } from 'node:test';
import assert from 'node:assert';
import { core } from './_helpers.mjs';

const { sniff, sizeFailure, sizeClass, headerOffset, headerVersion, hasEofMarker, sniffDetail, HEADER_WINDOW } = core.sniff;
const L = core.limits.PDF_LIMITS;
const MB = 1024 * 1024;
const enc = (s) => new TextEncoder().encode(s);
const MIN = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';

/** Bytes with `%PDF-` at `offset`, preceded by junk. */
function withHeaderAt(offset) {
  const out = new Uint8Array(offset + 64).fill(0x20);
  out.set(enc('%PDF-2.0\n%%EOF'), offset);
  return out;
}

test('sniff table: empty, not a PDF, accepted', () => {
  const cases = [
    ['empty', new Uint8Array(0), 'empty'],
    ['minimal pdf', enc(MIN), null],
    ['text file', enc('hello world, not a pdf at all'), 'not-pdf'],
    ['zip (docx renamed)', Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0), 'not-pdf'],
    ['lowercase header', enc('%pdf-1.4\n%%EOF'), 'not-pdf'],
    ['header cut short', enc('%PDF'), 'not-pdf'],
    ['one byte', Uint8Array.of(0x25), 'not-pdf'],
    ['BOM then header', Uint8Array.of(0xef, 0xbb, 0xbf, ...enc(MIN)), null],
    ['header at 0', withHeaderAt(0), null],
    ['header at 1023 (last allowed start)', withHeaderAt(HEADER_WINDOW - 1), null],
    ['header at 1024 (outside the window)', withHeaderAt(HEADER_WINDOW), 'not-pdf'],
    ['no %%EOF is not a failure (pdf.js may recover it)', enc('%PDF-1.4\n1 0 obj\n'), null],
  ];
  for (const [name, bytes, want] of cases) assert.strictEqual(sniff(bytes), want, name);
});

test('headerOffset, headerVersion, hasEofMarker', () => {
  assert.strictEqual(headerOffset(enc(MIN)), 0);
  assert.strictEqual(headerOffset(withHeaderAt(700)), 700);
  assert.strictEqual(headerOffset(enc('nothing')), -1);
  assert.strictEqual(headerVersion(enc(MIN)), '1.7');
  assert.strictEqual(headerVersion(withHeaderAt(5)), '2.0');
  assert.strictEqual(headerVersion(enc('%PDF-x.y')), null);
  assert.strictEqual(headerVersion(enc('%PDF-1')), null);
  assert.strictEqual(headerVersion(enc('text')), null);
  assert.strictEqual(hasEofMarker(enc(MIN)), true);
  assert.strictEqual(hasEofMarker(enc('%PDF-1.4\n')), false);
  // Trailing junk within the window is allowed; beyond it the marker does not count.
  const tail = (n) => { const b = new Uint8Array(n + 5); b.set(enc('%%EOF'), 0); return b; };
  assert.strictEqual(hasEofMarker(tail(1000)), true);
  assert.strictEqual(hasEofMarker(tail(1100)), false);
});

test('size bands: refuse > 500 MB from the size alone, view-only > 100 MB, large > 150 MB', () => {
  assert.strictEqual(sizeFailure(0), 'empty');
  assert.strictEqual(sizeFailure(1), null);
  assert.strictEqual(sizeFailure(L.maxFileBytes), null);
  assert.strictEqual(sizeFailure(L.maxFileBytes + 1), 'too-large');
  assert.strictEqual(L.maxFileBytes, 500 * MB);
  assert.deepStrictEqual(sizeClass(100 * MB), { large: false, viewOnly: false });
  assert.deepStrictEqual(sizeClass(100 * MB + 1), { large: false, viewOnly: true });
  assert.deepStrictEqual(sizeClass(150 * MB), { large: false, viewOnly: true });
  assert.deepStrictEqual(sizeClass(150 * MB + 1), { large: true, viewOnly: true });
});

test('sniffDetail is technical and never document content', () => {
  assert.strictEqual(sniffDetail('empty', 0), 'The file is 0 bytes long');
  assert.strictEqual(sniffDetail('not-pdf', 12), 'No %PDF- header in the first 1024 bytes');
  assert.strictEqual(sniffDetail('too-large', L.maxFileBytes + 1), `File is ${L.maxFileBytes + 1} bytes; the limit is ${L.maxFileBytes}`);
});
