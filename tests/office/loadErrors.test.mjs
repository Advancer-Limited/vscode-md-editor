// WP-08: load-failure text for the error view (spec §10.3). loadErrors.ts has only type imports,
// so Node's type stripping loads it directly.
import { test } from 'node:test';
import assert from 'node:assert';
import * as LE from '../../src/office/loadErrors.ts';
import * as FF from '../../src/office/featureFlags.ts';

// The §10.3 sentences, with "Word/Excel" and ".doc/.xls … .docx/.xlsx" resolved per kind.
const EXPECTED = {
  'encrypted-ole': {
    docx: 'This file is password-protected. Open it in Word to view it.',
    xlsx: 'This file is password-protected. Open it in Excel to view it.',
  },
  'legacy-ole': {
    docx: 'This looks like an older .doc file saved with a .docx name.',
    xlsx: 'This looks like an older .xls file saved with a .xlsx name.',
  },
  'lock-file': {
    docx: 'This is a temporary lock file created by Word, not a document.',
    xlsx: 'This is a temporary lock file created by Excel, not a document.',
  },
  'damaged': {
    docx: "This file is damaged and can't be displayed.",
    xlsx: "This file is damaged and can't be displayed.",
  },
  'unsupported-packaging': {
    docx: "This file uses a packaging feature this viewer doesn't support.",
    xlsx: "This file uses a packaging feature this viewer doesn't support.",
  },
  'empty': { docx: 'This file is empty.', xlsx: 'This file is empty.' },
  'too-large': {
    docx: 'This file is too large to display here. Open it in Word to view it.',
    xlsx: 'This file is too large to display here. Open it in Excel to view it.',
  },
};

test('every LoadFailure has the §10.3 message', () => {
  assert.deepStrictEqual([...LE.LOAD_FAILURES].sort(), Object.keys(EXPECTED).sort(),
    'LOAD_FAILURES must list exactly the core LoadFailure codes');
  for (const failure of LE.LOAD_FAILURES) {
    for (const kind of ['docx', 'xlsx']) {
      const v = LE.describeLoadFailure(failure, kind, 'tech detail');
      assert.strictEqual(v.title, EXPECTED[failure][kind], `${failure}/${kind}`);
      assert.strictEqual(v.detail, 'tech detail', 'detail is passed through for the Details disclosure');
      assert.ok(v.actions.includes('openExternally'), `${failure}: every error view offers Open in Word/Excel`);
      for (const a of v.actions) assert.ok(a === 'openExternally' || a === 'retry');
    }
  }
});

test('retry is offered where the file may be mid-write, not for permanent conditions', () => {
  const retry = (f) => LE.describeLoadFailure(f, 'docx', '').actions.includes('retry');
  assert.ok(retry('damaged'));
  assert.ok(retry('empty'));
  for (const f of ['encrypted-ole', 'legacy-ole', 'lock-file', 'unsupported-packaging', 'too-large']) {
    assert.ok(!retry(f), f);
  }
});

test('actions arrays are fresh copies', () => {
  const a = LE.describeLoadFailure('damaged', 'docx', '');
  a.actions.length = 0;
  assert.ok(LE.describeLoadFailure('damaged', 'docx', '').actions.length > 0);
});

test('read failure and unexpected errors', () => {
  const r = LE.describeReadFailure('docx', 'EntryNotFound');
  assert.strictEqual(r.title, "This file couldn't be read.");
  assert.deepStrictEqual(r.actions, ['openExternally', 'retry']);
  const u = LE.describeUnexpectedError('xlsx', new TypeError('boom'));
  assert.strictEqual(u.title, "This file is damaged and can't be displayed.");
  assert.strictEqual(u.detail, 'TypeError: boom');
  assert.strictEqual(LE.describeUnexpectedError('docx', 'x').detail, 'x');
});

test('doctype detail names the part', () => {
  assert.match(LE.doctypeDetail('word/styles.xml'), /"word\/styles\.xml".*DOCTYPE/);
  assert.match(LE.unreadablePartDetail('word/a.xml', 'bad-crc'), /"word\/a\.xml".*bad-crc/);
});

test('OFFICE_FLAGS: 1.6 ships Excel cell and structure editing and Word editing on, frozen', () => {
  assert.deepStrictEqual({ ...FF.OFFICE_FLAGS }, { xlsxEdit: true, docxEdit: true, xlsxStructure: true });
  assert.ok(Object.isFrozen(FF.OFFICE_FLAGS));
  assert.strictEqual(FF.editFlagFor('docx'), true);
  assert.strictEqual(FF.editFlagFor('xlsx'), true);
});
