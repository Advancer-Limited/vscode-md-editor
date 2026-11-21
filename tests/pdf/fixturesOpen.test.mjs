// PWP-03 acceptance: every non-error fixture opens in pdf.js (legacy build, Node) with the documented page count;
// the error fixtures are rejected with the documented exception.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED } from './fixtureLists.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');
const skip = Number(process.versions.node.split('.')[0]) < 20 ? 'pdf.js legacy build needs a recent Node' : false;

/** name -> page count (opens without a password) */
const PAGES = {
  'basic.pdf': 2, 'xref-stream.pdf': 3, 'multi-revision.pdf': 2, 'outline.pdf': 3, 'forms.pdf': 2, 'forms-js.pdf': 1,
  'annotated.pdf': 2, 'rotated.pdf': 4, 'attachments.pdf': 1, 'encrypted-owner.pdf': 2, 'scanned.pdf': 3, 'cjk.pdf': 1,
  'base14.pdf': 1, 'jpx-jbig2.pdf': 1, 'tagged.pdf': 1, 'js-openaction.pdf': 1, 'broken-xref.pdf': 2 /* via recovery */,
  'hybrid-xref.pdf': 2, 'large.pdf': 2000, 'word.pdf': 2, 'chrome.pdf': 6, 'signed.pdf': 1,
};
/** name -> pdf.js exception name */
const ERRORS = { 'truncated.pdf': 'InvalidPDFException', 'not-a-pdf.pdf': 'InvalidPDFException', 'empty.pdf': 'InvalidPDFException' };

let lib;
async function open(name, extra = {}) {
  lib ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(path.join(dir, name)));
  const task = lib.getDocument({ data, verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false, ...extra });
  try { return { task, doc: await task.promise }; } catch (e) { await task.destroy(); throw e; }
}

test('the tables cover every required fixture exactly once', () => {
  const covered = [...Object.keys(PAGES), ...Object.keys(ERRORS), 'encrypted-user.pdf'].sort();
  assert.deepStrictEqual(covered, [...REQUIRED].sort());
});

for (const [name, pages] of Object.entries(PAGES)) {
  test(`${name} opens with ${pages} page(s)`, { skip }, async () => {
    const { task, doc } = await open(name);
    try { assert.strictEqual(doc.numPages, pages); } finally { await task.destroy(); }
  });
}

for (const [name, exc] of Object.entries(ERRORS)) {
  test(`${name} is rejected (${exc})`, { skip }, async () => {
    await assert.rejects(() => open(name), (e) => e.name === exc);
  });
}

test('encrypted-user.pdf needs the password "test"', { skip }, async () => {
  await assert.rejects(() => open('encrypted-user.pdf'), (e) => e.name === 'PasswordException' && e.code === 1);
  await assert.rejects(() => open('encrypted-user.pdf', { password: 'wrong' }), (e) => e.name === 'PasswordException' && e.code === 2);
  const { task, doc } = await open('encrypted-user.pdf', { password: 'test' });
  try { assert.strictEqual(doc.numPages, 2); } finally { await task.destroy(); }
});

test('signed.pdf exposes a signature field; forms.pdf exposes every field kind', { skip }, async () => {
  const s = await open('signed.pdf');
  try { assert.ok((await (await s.doc.getPage(1)).getAnnotations()).some((a) => a.fieldType === 'Sig')); } finally { await s.task.destroy(); }
  const f = await open('forms.pdf');
  try {
    const kinds = new Set();
    for (let i = 1; i <= f.doc.numPages; i++) for (const a of await (await f.doc.getPage(i)).getAnnotations()) {
      if (a.subtype === 'Widget') kinds.add(a.fieldType === 'Btn' ? (a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'push') : a.fieldType === 'Ch' ? (a.combo ? 'combo' : 'list') : a.fieldType);
    }
    for (const k of ['Tx', 'checkbox', 'radio', 'combo', 'list', 'Sig']) assert.ok(kinds.has(k), `forms.pdf lacks a ${k} field (has ${[...kinds]})`);
  } finally { await f.task.destroy(); }
});

test('outline.pdf has nested bookmarks; attachments.pdf has three attachments', { skip }, async () => {
  const o = await open('outline.pdf');
  try {
    const outline = await o.doc.getOutline();
    assert.strictEqual(outline.length, 3);
    assert.strictEqual(outline[0].items.length, 2);
  } finally { await o.task.destroy(); }
  const a = await open('attachments.pdf');
  try { assert.strictEqual((await a.doc.getAttachments())?.size, 3); } finally { await a.task.destroy(); }
});
