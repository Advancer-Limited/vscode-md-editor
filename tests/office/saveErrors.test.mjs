// WP-19: save error mapping and save-path messages (spec §6.5, §10.3). saveErrors.ts has only type
// imports, so Node's type stripping loads it directly.
import { test } from 'node:test';
import assert from 'node:assert';
import * as SE from '../../src/office/saveErrors.ts';

/** Shaped like vscode.FileSystemError (code + "Code (FileSystemError)" name). */
function fsError(code, message = `${code} message`) {
  const e = new Error(message);
  e.code = code;
  e.name = `${code} (FileSystemError)`;
  return e;
}
function errno(code, message) {
  return Object.assign(new Error(message ?? `${code}: something, open 'C:\\x\\book.xlsx'`), { code });
}

const IN_USE_DOCX = "Couldn't save: the file is in use by another program (probably Word). Close it there and save again, or use Save As.";
const IN_USE_XLSX = "Couldn't save: the file is in use by another program (probably Excel). Close it there and save again, or use Save As.";

test('error mapping table (§10.3): locked / permission errors → "in use"; everything else → generic', () => {
  const rows = [
    // [what, error, expected kind]
    ['Node EBUSY', errno('EBUSY'), 'in-use'],
    ['Node EPERM', errno('EPERM'), 'in-use'],
    ['Node EACCES', errno('EACCES'), 'in-use'],
    ['FileSystemError.NoPermissions', fsError('NoPermissions'), 'in-use'],
    ['FileSystemError.Unavailable', fsError('Unavailable'), 'in-use'],
    ['FileSystemError name only', Object.assign(new Error('x'), { name: 'NoPermissions (FileSystemError)' }), 'in-use'],
    ['disk provider message with errno', fsError('Unknown', "EBUSY: resource busy or locked, open 'c:\\a.docx'"), 'in-use'],
    ['EPERM in a plain message', new Error("EPERM: operation not permitted, rename 'a' -> 'b'"), 'in-use'],
    ['ENOSPC', errno('ENOSPC', 'ENOSPC: no space left on device'), 'other'],
    ['FileNotFound', fsError('FileNotFound'), 'other'],
    ['FileExists', fsError('FileExists'), 'other'],
    ['FileSystemError.Unknown', fsError('Unknown', 'Unknown failure'), 'other'],
    ['EIO', errno('EIO', 'EIO: i/o error'), 'other'],
    ['string thrown', 'boom', 'other'],
    ['null thrown', null, 'other'],
    ['errno-like word inside another word', new Error('XEBUSYX'), 'other'],
  ];
  for (const [what, e, kind] of rows) assert.strictEqual(SE.classifyWriteError(e), kind, what);
});

test('write error messages per kind', () => {
  assert.strictEqual(SE.writeErrorMessage('docx', 'a.docx', errno('EBUSY')), IN_USE_DOCX);
  assert.strictEqual(SE.writeErrorMessage('xlsx', 'b.xlsx', fsError('NoPermissions')), IN_USE_XLSX);
  assert.strictEqual(SE.writeErrorMessage('xlsx', 'b.xlsx', errno('ENOSPC', 'ENOSPC: no space left on device')),
    "Couldn't save b.xlsx: ENOSPC: no space left on device");
  assert.strictEqual(SE.writeErrorMessage('docx', 'a.docx', new Error('   ')), "Couldn't save a.docx.");
  assert.strictEqual(SE.writeErrorMessage('docx', 'a.docx', { message: 'object message' }), "Couldn't save a.docx: object message");
});

test('verification failure UX strings (§6.5 step 4) and the diagnostics file carries no content', () => {
  assert.strictEqual(SE.VERIFY_FAILED_MESSAGE, 'Save failed an internal consistency check — your file on disk was not changed.');
  assert.strictEqual(SE.SAVE_DIAGNOSTICS_ACTION, 'Save a copy of diagnostics');
  assert.strictEqual(SE.diagnosticsFileName('Book 1.xlsx'), 'Book 1.xlsx.save-diagnostics.txt');
  const text = SE.diagnosticsText({
    kind: 'xlsx', fileName: 'Book.xlsx', version: 7,
    touched: ['xl/worksheets/sheet1.xml', 'xl/styles.xml'],
    failures: [{ part: 'xl/styles.xml', message: 'xl/styles.xml: cellXfs count 3 != 4 xf' }, { message: 'Output is not a readable ZIP' }],
    when: new Date(Date.UTC(2026, 10, 21, 12, 0, 0)), extensionVersion: '1.5.0',
  });
  assert.strictEqual(text, [
    'VS Code MD Editor: Office save verification failure',
    'When: 2026-11-21T12:00:00.000Z',
    'File: Book.xlsx (xlsx)',
    'Document version: 7',
    'Extension version: 1.5.0',
    '',
    'Changed parts:',
    '  xl/worksheets/sheet1.xml',
    '  xl/styles.xml',
    '',
    'Failures:',
    '  [xl/styles.xml] xl/styles.xml: cellXfs count 3 != 4 xf',
    '  Output is not a readable ZIP',
    '',
    'The file on disk was not changed. No document content is included in this report.',
    '',
  ].join('\n'));
  const empty = SE.diagnosticsText({ kind: 'docx', fileName: 'a.docx', version: 0, touched: [], failures: [], when: new Date(0) });
  assert.match(empty, /Changed parts:\n {2}\(none\)/);
  assert.ok(!empty.includes('Extension version'));
});

test('conflict check (§6.5 step 2): stamp comparison and modal text', () => {
  const a = { mtime: 1, size: 10 };
  assert.strictEqual(SE.stampChanged(a, { mtime: 1, size: 10 }), false);
  assert.strictEqual(SE.stampChanged(a, { mtime: 2, size: 10 }), true);
  assert.strictEqual(SE.stampChanged(a, { mtime: 1, size: 11 }), true);
  assert.strictEqual(SE.stampChanged(null, a), false, 'nothing recorded');
  assert.strictEqual(SE.stampChanged(a, null), false, 'file gone: the write recreates it');
  assert.strictEqual(SE.conflictMessage('x.docx'), 'x.docx has changed on disk since it was opened here.');
  assert.deepStrictEqual([SE.CONFLICT_OVERWRITE, SE.CONFLICT_REVERT], ['Overwrite', 'Revert to disk version']);
});

test('other save-path messages', () => {
  assert.strictEqual(SE.VIEW_MODE_MESSAGE, 'Press Edit (Ctrl+E) to make changes.');
  assert.strictEqual(SE.READ_ONLY_MESSAGE, 'This document is open read-only.');
  assert.strictEqual(SE.tempKeptMessage, undefined, 'the temp + rename write is gone (Gate R2 F8)');
  assert.match(SE.PARTIAL_WRITE_NOTE, /may be incomplete/);
  assert.match(SE.CHANGED_ON_DISK_MESSAGE, /changed on disk/);
  assert.strictEqual(SE.signedEditWarning('Excel'),
    'This file is digitally signed. Saving changes here will invalidate the signature; sign it again in Excel if you need it.');
});
