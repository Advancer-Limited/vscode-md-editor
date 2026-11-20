// WP-06: load classification (src/office/core/sniff.ts and OfficePackage.open). Spec §10.2, §10.3.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const { sniff, OfficeLoadError, oleHasStream } = core.sniff;
const { OfficePackage } = core.pkg;

function failureOf(name, bytes) {
  try {
    OfficePackage.open(name, bytes);
  } catch (e) {
    assert.ok(e instanceof OfficeLoadError, `${name}: expected OfficeLoadError, got ${e}`);
    assert.ok(typeof e.detail === 'string' && e.detail.length > 0, `${name}: detail`);
    return e.failure;
  }
  return null;
}

test('classifies encrypted.docx/.xlsx, legacy-renamed.docx, ~$lock name, 0-byte file, truncated.docx, zip64.xlsx', () => {
  const cases = [
    ['encrypted.docx', fixture('encrypted.docx'), 'encrypted-ole', 'encrypted-ole'],
    ['encrypted.xlsx', fixture('encrypted.xlsx'), 'encrypted-ole', 'encrypted-ole'],
    ['legacy-renamed.docx', fixture('legacy-renamed.docx'), 'legacy-ole', 'legacy-ole'],
    // A lock file is recognised by name, whatever its content (even a valid package).
    ['~$basic.docx', fixture('basic.docx'), 'lock-file', 'lock-file'],
    ['C:\\docs\\~$report.xlsx', new Uint8Array(162), 'lock-file', 'lock-file'],
    ['empty.docx', new Uint8Array(0), 'empty', 'empty'],
    ['truncated.docx', fixture('truncated.docx'), null, 'damaged'],
    ['zip64.xlsx', fixture('zip64.xlsx'), null, 'unsupported-packaging'],
  ];
  for (const [name, bytes, sniffed, failure] of cases) {
    assert.strictEqual(sniff(name, bytes), sniffed, `sniff(${name})`);
    assert.strictEqual(failureOf(name, bytes), failure, `open(${name})`);
  }
  // The legacy file's detail says what it is; the lock-file rule only looks at the base name.
  try { OfficePackage.open('legacy-renamed.docx', fixture('legacy-renamed.docx')); } catch (e) { assert.match(e.detail, /WordDocument/); }
  assert.strictEqual(sniff('dir~$/basic.docx', fixture('basic.docx')), null);
});

test('sniff passes every real package through to the ZIP reader', () => {
  const negative = new Set(['encrypted.docx', 'encrypted.xlsx', 'legacy-renamed.docx']);
  for (const f of allFixtures()) {
    if (negative.has(f)) continue;
    assert.strictEqual(sniff(f, fixture(f)), null, f);
  }
});

test('OLE classification uses directory entries, not stray text', () => {
  const enc = fixture('encrypted.docx');
  assert.ok(oleHasStream(enc, 'EncryptedPackage') && oleHasStream(enc, 'EncryptionInfo'));
  const legacy = fixture('legacy-renamed.docx');
  assert.ok(oleHasStream(legacy, 'WordDocument'));
  assert.ok(!oleHasStream(legacy, 'EncryptedPackage'));

  // A legacy file whose body text contains "EncryptedPackage" in UTF-16LE is still legacy.
  const withText = legacy.slice();
  const text = Buffer.from('EncryptedPackage', 'utf16le');
  withText.set(text, 1024 + 3);       // not a directory slot
  withText.set(text, 2048);           // 128-aligned, but no matching length/type fields
  assert.strictEqual(sniff('x.docx', withText), 'legacy-ole');

  // An OLE header alone, with no recognisable streams, is classified as legacy (not a package).
  const bare = new Uint8Array(1024);
  bare.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  assert.strictEqual(sniff('x.xlsx', bare), 'legacy-ole');
});

test('files over the size limit are refused before reading', () => {
  const L = core.limits.LIMITS;
  // sniff looks only at the length for this check, so a length-only stand-in avoids a 250 MB buffer.
  const fake = { length: L.maxFileBytes + 1 };
  assert.strictEqual(sniff('big.xlsx', fake), 'too-large');
});

test('container refusals map onto load failures', () => {
  const notZip = new TextEncoder().encode('This is plain text, not an Office document at all.');
  assert.strictEqual(failureOf('x.docx', notZip), 'damaged');
  // Encrypted ZIP entry (flag bit 0) => a packaging feature we do not support.
  const bytes = fixture('basic.xlsx').slice();
  const zip = core.zip.readZip(fixture('basic.xlsx'), core.pkg.zipLimits());
  const e = zip.entries[0];
  bytes[e.extent[0] + 6] |= 1;
  bytes[e.cdRecord[0] + 8] |= 1;
  assert.strictEqual(failureOf('x.xlsx', bytes), 'unsupported-packaging');
  // A flipped data bit in a part open() reads => bad CRC => damaged.
  const ct = zip.entries.find((en) => en.name === '[Content_Types].xml');
  const flipped = fixture('basic.xlsx').slice();
  const h = ct.extent[0];
  const dataStart = h + 30 + (flipped[h + 26] | (flipped[h + 27] << 8)) + (flipped[h + 28] | (flipped[h + 29] << 8));
  flipped[dataStart + 5] ^= 0x01;
  assert.strictEqual(failureOf('x.xlsx', flipped), 'damaged');
});
